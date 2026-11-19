/**
 * Context-scoped, non-billable projection of the route a Codex turn would use,
 * for speed selectors (Home, chat composers, default settings).
 *
 * The renderer names only a portable context (workspace/worktree/chat ids or
 * "defaults") and, optionally, the model it is evaluating. Everything that
 * decides the route is resolved here, in main, with the SAME resolvers the
 * interactive Codex session uses before `turn/start`:
 *
 * - the Canopy Environments overlay for the workspace
 *   (`resolveCodexRuntimeEnvironmentProfile({ runtime: 'agent', workspaceId })`),
 * - the deterministic E2E mock provider (`resolveCodexMockAppServerOverride`),
 * - the model's catalog source and execution harness,
 * - the account proxy, which takes the turn first unless AI Credits were
 *   chosen (`previewAccountProxySessionRoute`),
 * - AI Credits / organization gateway routing
 *   (`getModelGatewayRequirementForOwner`, `resolveGatewayModelEntry`,
 *   `resolveAiCreditsRoutingDecision` with the canonical tab's persisted
 *   routing state and billing override),
 *
 * then classified by the same `buildCodexSpeedRouteFacts` admission uses. No
 * host path, account identity, or credential value is returned: only the
 * portable {@link CodexSpeedRouteFacts}. A failed lookup is `unknown`, never
 * a guess. This is a hint for selectors; `admitCodexSpeed` in the session
 * remains the authoritative check before any request.
 */
import type { CodexSpeedRouteFacts } from '@canopy/execution-engine/lib/codex-speed-availability';
import type { ReadCodexSpeedRouteRequest } from '@canopy/execution-engine/types/codex-speed-capabilities';
import { resolveGatewayModelEntry } from '@canopy/execution-engine/lib/gateway-model-availability';
import { resolveCodexMockAppServerOverride } from '@canopy/execution-engine/node/e2e-mock-env';
import {
  getExecutionHarnessForModel,
  getModelSource,
  type AiCreditsScopeRequest,
  type AiCreditsRoutingState,
  type ModelHarness,
} from '@canopy/desktop-shared/types';
import {
  isAiCreditsChosenOverAccountProxy,
  resolveAiCreditsRoutingDecision,
  routingAttemptOf,
} from '../agents/ai-credits-routing';
import { ACCOUNT_PROXY_CODEX_PROVIDER_ID } from '../account-proxy/codex-provider';
import { previewAccountProxySessionRoute } from '../account-proxy/routing';
import { resolveAiCreditsScopeOwner } from '../agents/work-owner';
import { isProviderNativelyAuthenticatedForRouting } from '../auth/provider-auth-state';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { getModelGatewayRequirementForOwner } from '../lib/model-gateway-state';
import { resolveCodexRuntimeEnvironmentProfile } from '../lib/user-environment-runtime';
import {
  buildCodexSpeedRouteFacts,
  codexSpeedGatewayForOrigin,
  type CodexSpeedRouteEvidence,
} from './speed-policy';

/**
 * Portable identity of the surface asking. IDs must already be validated by
 * the IPC boundary (`validateId`).
 *
 * - `chat`: an existing worktree, cowork, or standalone chat. The canonical
 *   tab supplies its model, captured harness, Auto mode, and routing state.
 * - `home`: the Home composer, optionally targeting a workspace whose
 *   Environments assignment applies.
 * - `defaults`: Codex default settings (no workspace; global assignment).
 */
export type {
  CodexSpeedRouteContext,
  ReadCodexSpeedRouteRequest,
} from '@canopy/execution-engine/types/codex-speed-capabilities';

/** Host-resolved inputs of one prediction (never renderer-supplied). */
export interface CodexSpeedRouteInputs {
  /** Workspace whose Environments assignment applies; absent = global. */
  workspaceId?: string;
  model: string | null;
  modelSelection: 'explicit' | 'auto';
  /** Harness captured on the chat, when it differs from the model default. */
  executionHarness?: ModelHarness;
  /** Canonical tab routing state (AI Credits "just this time"/persistent). */
  aiCreditsRouting?: AiCreditsRoutingState;
  /** Canonical per-chat native-billing override. */
  subscriptionBillingOverride?: boolean;
  /** Host-resolved owner scope for gateway enforcement. */
  ownerScope?: AiCreditsScopeRequest;
}

/**
 * Predict whether the turn would route through a gateway. Mirrors the
 * session's AI Credits decision conservatively: an ambiguous case is
 * `unknown`, never native.
 */
async function predictGateway(
  model: string,
  inputs: CodexSpeedRouteInputs,
): Promise<'ai-credits' | 'org-gateway' | 'unknown' | null> {
  const owner = await resolveAiCreditsScopeOwner(inputs.ownerScope);
  const requirement = await getModelGatewayRequirementForOwner(
    owner,
    'predictCodexSpeedRouteFacts',
  );
  if (requirement.kind === 'blocked') return 'unknown';
  if (requirement.kind === 'enforced') return 'org-gateway';
  const entry = resolveGatewayModelEntry(model);
  if (entry?.gatewayOnly === true) {
    return codexSpeedGatewayForOrigin(entry.origin);
  }
  // An `off`-mode sign-out (`no-billing-source`) is refused at spawn, never
  // routed, so it is reported like the native path (CAN-7062).
  const attempt = routingAttemptOf(
    await resolveAiCreditsRoutingDecision(
      inputs.aiCreditsRouting,
      'codex',
      () =>
        isProviderNativelyAuthenticatedForRouting(
          'codex',
          'ai-credits-routing',
        ),
      inputs.subscriptionBillingOverride,
    ),
  );
  if (!attempt) return null;
  // Routing may still fall back to the native sign-in (no gateway entry, a
  // user-supplied credential, or no spendable credits); the session decides.
  return entry ? codexSpeedGatewayForOrigin(entry.origin) : 'unknown';
}

/**
 * Whether the account proxy would take the turn, as the session decides it:
 * first, unless AI Credits were chosen for the chat or for every session.
 */
async function predictAccountProxy(
  model: string,
  inputs: CodexSpeedRouteInputs,
): Promise<boolean> {
  if (
    isAiCreditsChosenOverAccountProxy(
      inputs.aiCreditsRouting,
      inputs.subscriptionBillingOverride,
    )
  ) {
    return false;
  }
  return previewAccountProxySessionRoute({
    harness: 'codex',
    model,
    resolveWorkOwner: () => resolveAiCreditsScopeOwner(inputs.ownerScope),
  });
}

/** Predict the route facts for host-resolved inputs. Never rejects. */
export async function predictCodexSpeedRouteFacts(
  inputs: CodexSpeedRouteInputs,
): Promise<CodexSpeedRouteFacts> {
  const model = inputs.model;
  if (!model) {
    return buildCodexSpeedRouteFacts({
      modelSelection: inputs.modelSelection,
      selectedModel: null,
      harness: inputs.executionHarness ?? null,
      unresolvedRoute: true,
    });
  }
  const harness =
    inputs.executionHarness ?? getExecutionHarnessForModel(model) ?? null;
  const modelSource = getModelSource(model) ?? null;
  const base: CodexSpeedRouteEvidence = {
    modelSelection: inputs.modelSelection,
    selectedModel: model,
    runtimeModel: model,
    modelSource,
    harness,
    providerType:
      modelSource === 'ollama'
        ? 'ollama'
        : harness === 'codex'
          ? 'codex'
          : harness === 'cursor'
            ? 'cursor'
            : 'claude',
  };
  if (harness !== 'codex' || modelSource === 'ollama') {
    return buildCodexSpeedRouteFacts(base);
  }
  try {
    const accountProxy = await predictAccountProxy(model, inputs);
    const gateway = accountProxy ? null : await predictGateway(model, inputs);
    if (gateway === 'unknown') {
      return buildCodexSpeedRouteFacts({ ...base, unresolvedRoute: true });
    }
    const environment = resolveCodexRuntimeEnvironmentProfile({
      runtime: 'agent',
      ...(inputs.workspaceId !== undefined
        ? { workspaceId: inputs.workspaceId }
        : {}),
    }).environment;
    return buildCodexSpeedRouteFacts({
      ...base,
      gateway,
      environment,
      ...(accountProxy
        ? { codexConfig: { model_provider: ACCOUNT_PROXY_CODEX_PROVIDER_ID } }
        : {}),
      mockProvider: Boolean(resolveCodexMockAppServerOverride()),
    });
  } catch {
    return buildCodexSpeedRouteFacts({ ...base, unresolvedRoute: true });
  }
}

/**
 * Read the predicted route for a portable surface context. Chat contexts use
 * the canonical tab (model, captured harness, Auto mode, routing state); a
 * missing or unreadable tab leaves its route unknown because its routing
 * state could not be resolved. The workspace for Environments is the chat's `projectId`,
 * exactly as the session resolves it.
 */
export async function readCodexSpeedRouteFacts(
  request: ReadCodexSpeedRouteRequest,
): Promise<CodexSpeedRouteFacts> {
  const { context } = request;
  if (context.kind !== 'chat') {
    return predictCodexSpeedRouteFacts({
      ownerScope:
        context.kind === 'home' && context.projectId !== undefined
          ? { kind: 'work', projectId: context.projectId }
          : { kind: 'navigation' },
      ...(context.kind === 'home' && context.projectId !== undefined
        ? { workspaceId: context.projectId }
        : {}),
      model: request.model ?? null,
      modelSelection: request.modelSelection ?? 'explicit',
      ...(context.kind === 'home' && context.executionHarness !== undefined
        ? { executionHarness: context.executionHarness }
        : {}),
      ...(context.kind === 'home' && context.billingFramework === 'subscription'
        ? { subscriptionBillingOverride: true }
        : {}),
      ...(context.kind === 'home' && context.billingFramework === 'ai-credits'
        ? {
            aiCreditsRouting: {
              active: true,
              scope: 'persistent',
              activatedAt: Date.now(),
            },
          }
        : {}),
    });
  }
  const tab = await readChatTabsFile(context.projectId, context.worktreeId)
    .then((file) =>
      file.tabs.find((candidate) => candidate.id === context.chatId),
    )
    .catch(() => undefined);
  if (!tab) {
    const model = request.model ?? null;
    return buildCodexSpeedRouteFacts({
      modelSelection: request.modelSelection ?? 'explicit',
      selectedModel: model,
      harness: model ? getExecutionHarnessForModel(model) : null,
      unresolvedRoute: true,
    });
  }
  const model =
    request.model === undefined ? (tab.model ?? null) : request.model;
  // A candidate model that differs from the tab's resets the captured harness.
  const executionHarness =
    tab?.executionHarness !== undefined &&
    (request.model === undefined || request.model === tab.model)
      ? tab.executionHarness
      : undefined;
  return predictCodexSpeedRouteFacts({
    ownerScope: {
      kind: 'work',
      projectId: context.projectId,
      worktreeId: context.worktreeId,
      chatId: context.chatId,
    },
    workspaceId: context.projectId,
    model,
    modelSelection:
      request.modelSelection ??
      (tab?.modelSelectionMode === 'auto' ? 'auto' : 'explicit'),
    ...(executionHarness !== undefined ? { executionHarness } : {}),
    ...(tab?.aiCreditsRouting !== undefined
      ? { aiCreditsRouting: tab.aiCreditsRouting }
      : {}),
    ...(tab?.subscriptionBillingOverride !== undefined
      ? { subscriptionBillingOverride: tab.subscriptionBillingOverride }
      : {}),
  });
}
