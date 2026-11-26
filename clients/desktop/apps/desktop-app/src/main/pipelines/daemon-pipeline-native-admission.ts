import { createHash, randomUUID } from 'node:crypto';
import {
  WorkerPipelineNativeRouteEvidenceSchema,
  resolveNativePipelineModel,
  pipelineModelCatalogIdentity,
  type WorkerPipelineExecutionStartParams,
  type WorkerPipelineNativeRouteEvidence,
} from '@canopy/protocol/canopy-core';
import type { DaemonPipelineModelSelection } from '@canopy/execution-engine/node/pipelines/daemon-eligibility';
import { buildModelRegistrySnapshot } from '@canopy/execution-engine/node/pipelines/executor/model-registry-snapshot';
import { isOllamaModel } from '@canopy/execution-engine/model-catalog';
import { isForbiddenCodexSpawnEnvironmentKey } from '@canopy/execution-engine/node/codex-runtime/profile';
import {
  getCachedClaudeAuthStatusObserved,
  getCachedCodexAuthStatusObserved,
} from '../auth/provider-auth-state';
import { settleModelPolicyMarkerWrites } from '../lib/model-policy-state';
import { settleModelGatewayMarkerWrites } from '../lib/model-gateway-state';
import {
  inspectPipelineNativeRouting,
  resolveRoutingOverrideAttribution,
  type AiCreditsAttribution,
} from '../agents/ai-credits-routing';
import { BRAND } from '@canopy/brand/current';
import { resolveEnforcementOwner } from '../agents/work-owner';

export type NativePipelineRouteBlocker =
  | 'policy'
  | 'gateway'
  | 'account-proxy'
  | 'ai-credits'
  | 'ai-credits-on-quota'
  | 'environment-route'
  | 'native-auth-unknown'
  | 'dynamic-selection'
  | 'unsupported-route'
  | 'ollama'
  | 'network-proxy'
  | 'unknown';

export interface NativePipelineRouteInspection {
  readonly evidence?: WorkerPipelineNativeRouteEvidence;
  readonly blockers: readonly NativePipelineRouteBlocker[];
}

/** A redirect or a transport proxy is not a self-contained vendor route. */
function hasEnvironmentRoute(
  environment: Readonly<Record<string, string>>,
): boolean {
  const proxyKeys = new Set([
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'AZURE_OPENAI_ENDPOINT',
  ]);
  // Credential values stay in the existing secret handoff; config roots are
  // independently projected by the start manifest. No other provider setting
  // may bypass those facts, including settings added by a future vendor SDK.
  const classifiedKeys = new Set([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'CLAUDE_CONFIG_DIR',
  ]);
  return Object.entries(environment).some(([key, value]) => {
    if (!value.trim()) return false;
    const name = key.toUpperCase();
    return (
      proxyKeys.has(name) ||
      (['CLAUDE_CODE_', 'ANTHROPIC_', 'CODEX_', 'OPENAI_'].some((prefix) =>
        name.startsWith(prefix),
      ) &&
        !classifiedKeys.has(name) &&
        !isForbiddenCodexSpawnEnvironmentKey(name))
    );
  });
}

/**
 * Produces evidence only from the resolver's effective decision for every
 * static selection, never from a provider label or a successful inference.
 * The launch keeps these observations host-local; selection still requires
 * daemon revalidation and the product/native-auth qualification gates.
 */
export async function inspectNativePipelineLaunch(input: {
  readonly params: WorkerPipelineExecutionStartParams;
  readonly selections: readonly DaemonPipelineModelSelection[];
  readonly environment: Readonly<Record<string, string>>;
  readonly modelCatalog?: Readonly<Record<string, string | undefined>>;
  /**
   * The daemon holds the Cloud account (CAN-6997): organization policy and
   * AI Credits chosen for every attempt become evidence the daemon re-checks,
   * instead of blockers. Off until account authority is active.
   */
  readonly managedAccount?: boolean;
  readonly expectedAccountIdentity?: string;
}): Promise<NativePipelineRouteInspection> {
  const { params, selections, environment } = input;
  const managed = input.managedAccount === true;
  const policyScope = resolveEnforcementOwner({ kind: 'personal' })
    ? 'owner'
    : 'union';
  const catalog = input.modelCatalog ?? buildModelRegistrySnapshot();
  const blockers = new Set<NativePipelineRouteBlocker>();
  const routes: WorkerPipelineNativeRouteEvidence['routes'] = [];
  let governed = params.owner !== 'personal';
  if (governed && !managed) blockers.add('policy');
  if (hasEnvironmentRoute(environment)) blockers.add('environment-route');
  if (
    Object.entries(environment).some(
      ([key, value]) => /^(?:https?|all)_proxy$/i.test(key) && value.trim(),
    )
  )
    blockers.add('network-proxy');
  if (selections.length === 0 || selections.length > 256)
    blockers.add('dynamic-selection');
  for (const selection of selections) {
    // Other bundled model actions can make helper/side-model calls. They do
    // not inherit evidence for only their declared primary model.
    // Historical sessions can reload Mods and configuration outside this
    // launch's manifest. In-run resume provenance is not implemented yet.
    if (
      selection.action !== 'agent-prompt' ||
      selection.step.with?.session_id !== undefined
    ) {
      blockers.add('dynamic-selection');
      continue;
    }
    // The setup producer separately proves and leases any Agent alias. Route
    // evidence alone never admits an alias or its resources.
    const resolved =
      selection.model === null
        ? undefined
        : resolveNativePipelineModel(selection.model, catalog);
    if (isOllamaModel(selection.model)) {
      blockers.add('ollama');
      continue;
    }
    if (!resolved || resolved.harness !== selection.harness) {
      blockers.add('unsupported-route');
      continue;
    }
    const decision = await inspectPipelineNativeRouting(
      resolved.requestModel,
      selection.harness,
      {
        environmentRuntime: 'pipeline',
        ...(params.workspaceId !== null && { workspaceId: params.workspaceId }),
        ...(params.worktreeId !== null && { worktreeId: params.worktreeId }),
        executionContext: params.owner,
      },
      managed,
      true,
    );
    if (decision.kind === 'app-dependent') {
      blockers.add(decision.reason);
      continue;
    }
    if (decision.governed) governed = true;
    if (decision.kind === 'ai-credits') {
      if (selection.model === null) {
        blockers.add('dynamic-selection');
        continue;
      }
      // The account credential is daemon-held; the child gets a broker route.
      routes.push({
        ...resolved,
        runtimeModel: decision.runtimeModel,
        source: 'ai-gateway',
        effectiveRoute: 'ai-credits',
        authentication: 'vendor-profile',
      });
      continue;
    }
    const credential =
      selection.harness === 'claude'
        ? environment.ANTHROPIC_API_KEY || environment.ANTHROPIC_AUTH_TOKEN
        : environment.OPENAI_API_KEY;
    if (!credential) {
      const status =
        selection.harness === 'claude'
          ? await getCachedClaudeAuthStatusObserved('pipeline-native-admission')
          : await getCachedCodexAuthStatusObserved('pipeline-native-admission');
      if (
        status.probeFailed ||
        !status.authenticated ||
        (status.accountKind !== 'subscription' &&
          status.accountKind !== 'api_key')
      ) {
        blockers.add('native-auth-unknown');
        continue;
      }
    }
    if (selection.model === null) {
      blockers.add('dynamic-selection');
      continue;
    }
    routes.push({
      ...resolved,
      effectiveRoute: 'native',
      authentication: credential ? 'explicit-environment' : 'vendor-profile',
    });
  }
  await Promise.all([
    settleModelPolicyMarkerWrites(),
    settleModelGatewayMarkerWrites(),
  ]);
  if (
    (resolveEnforcementOwner({ kind: 'personal' }) ? 'owner' : 'union') !==
    policyScope
  )
    blockers.add('policy');
  if (blockers.size > 0) return { blockers: [...blockers] };
  const hasCredits = routes.some(
    (route) => route.effectiveRoute === 'ai-credits',
  );
  const attribution: AiCreditsAttribution | undefined =
    managed && hasCredits
      ? await resolveRoutingOverrideAttribution({
          environmentRuntime: 'pipeline',
          ...(params.workspaceId !== null && {
            workspaceId: params.workspaceId,
          }),
          ...(params.worktreeId !== null && { worktreeId: params.worktreeId }),
          executionContext: params.owner,
        }).catch(() => ({}))
      : undefined;
  const evidence = WorkerPipelineNativeRouteEvidenceSchema.safeParse({
    version: 1,
    catalogFingerprint: createHash('sha256')
      .update(pipelineModelCatalogIdentity(catalog))
      .digest('hex'),
    identity: {
      executionId: params.executionId,
      owner: params.owner,
      runScope: params.runScope,
      workspaceId: params.workspaceId,
      worktreeId: params.worktreeId,
    },
    // This names an observation, not a promise that configuration is forever
    // current. The daemon must supply the epoch validator before using it.
    configurationEpoch: createHash('sha256')
      .update(
        JSON.stringify({
          observation: randomUUID(),
          routes,
        }),
      )
      .digest('hex'),
    policy: governed ? 'required' : 'account-independent-personal',
    // Custody provisioning proves the target understands managed evidence.
    // Keep the original strict v1 shape for native launches on older daemons.
    ...(managed && {
      policyScope,
      expectedAccountIdentity: input.expectedAccountIdentity,
    }),
    ...(attribution && {
      aiCreditsAttribution: {
        ...(attribution.workspaceName && {
          workspaceName: attribution.workspaceName,
        }),
        ...(attribution.worktreeName && {
          worktreeName: attribution.worktreeName,
        }),
        ...(attribution.organizationProjectId && {
          organizationProjectId: attribution.organizationProjectId,
        }),
        providerName: `${BRAND.displayName} AI Credits`,
      },
    }),
    gateway: 'absent',
    accountProxy: 'absent',
    aiCredits: routes.some((route) => route.effectiveRoute === 'ai-credits')
      ? 'required'
      : 'absent',
    futureSelections: 'closed',
    routes,
  });
  return evidence.success
    ? { evidence: evidence.data, blockers: [] }
    : { blockers: ['unknown'] };
}
