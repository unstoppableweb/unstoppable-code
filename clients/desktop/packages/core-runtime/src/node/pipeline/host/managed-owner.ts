import {
  type WorkerPipelineHostRequest,
  type WorkerPipelineNativeRouteEvidence,
  type WorkerPipelineOwnerResult,
  type WorkerPipelineOwnerValues,
} from '@canopy/protocol/canopy-core';
import {
  AI_CREDITS_WORK_OWNER_HEADER,
  AI_CREDITS_ATTRIBUTION_WORKSPACE_HEADER,
  AI_CREDITS_ATTRIBUTION_WORKTREE_HEADER,
  AI_CREDITS_ORG_PROJECT_HEADER,
  type WorkOwner,
} from '@canopy/protocol/llm-gateway';
import {
  MODEL_LIBRARY_PROTOCOL_HEADER,
  MODEL_LIBRARY_PROTOCOL_VERSION,
} from '@canopy/protocol/models';
import { readCloudAccountAccess } from '../../cloud-account/access';
import type { DaemonModelBroker } from '../../model-broker/daemon-broker';
import {
  LOOPBACK_BROKER_SECRET_ENV,
  LOOPBACK_BROKER_SECRET_HEADER,
} from '../../model-broker/broker-routes';
import type { PipelineOwnerSettlement } from '../execution/host-requests';
import { samePipelineOwnerRunIdentity } from './native-owner';
import {
  assessManagedPipelineSurvival,
  type ManagedPipelineSurvivalDecision,
  type ManagedPipelineSurvivalPorts,
} from './managed-survival';
import type {
  PipelineOwnerRunAuthority,
  PipelineOwnerRunIdentity,
} from './supervisor';

/**
 * Model answers for governed-native and AI Credits runs (CAN-6997, A5-C).
 *
 * An AI Credits step gets a daemon broker route from its first invocation,
 * while the app is still connected, so quitting the app never strands a
 * child on an app-hosted loopback URL. The child receives a route-scoped
 * environment secret, never an upstream key; custody is re-read per request.
 * Governed native steps re-check the daemon-held organization policy before
 * every invocation: an unknown or blocking answer is a refusal, which pauses
 * a surviving run instead of executing it.
 */

export interface ManagedPipelineOwnerPorts extends ManagedPipelineSurvivalPorts {
  readonly broker: DaemonModelBroker;
}

/** Codex's AI Credits provider id, as the app configures it. */
const AI_CREDITS_CODEX_PROVIDER_ID = 'canopy_ai_credits';

/** Claude's side-model settings a guest route pins (ai-credits-routing.ts). */
const CLAUDE_SIDE_MODEL_ENV_NAMES = [
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const;

type Route = WorkerPipelineNativeRouteEvidence['routes'][number];
type OwnerValues = Omit<WorkerPipelineOwnerValues, 'requestId'>;

/** Provider configuration: route capability in the environment, never argv. */
export function managedAiCreditsChildValues(input: {
  readonly harness: 'claude' | 'codex';
  readonly runtimeModel: string;
  readonly baseUrl: string;
  readonly authToken: string;
  readonly routeSecret: string;
  readonly guest: boolean;
  readonly providerName?: string;
}): OwnerValues {
  if (input.harness === 'claude') {
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: input.baseUrl,
      ANTHROPIC_AUTH_TOKEN: input.authToken,
      ANTHROPIC_API_KEY: '',
      // The gateway refuses inline tool definitions (CAN-4647).
      CLAUDE_CODE_INLINE_TOOLS: 'false',
      ANTHROPIC_CUSTOM_HEADERS: `${LOOPBACK_BROKER_SECRET_HEADER}: ${input.routeSecret}`,
    };
    if (input.guest) {
      for (const name of CLAUDE_SIDE_MODEL_ENV_NAMES)
        env[name] = input.runtimeModel;
      env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1';
    }
    if (!input.runtimeModel.startsWith('anthropic/'))
      env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
    return { env };
  }
  return {
    env: { [LOOPBACK_BROKER_SECRET_ENV]: input.routeSecret },
    codexConfig: {
      model_provider: AI_CREDITS_CODEX_PROVIDER_ID,
      model: input.runtimeModel,
      model_providers: {
        [AI_CREDITS_CODEX_PROVIDER_ID]: {
          name: input.providerName ?? 'AI Credits',
          base_url: input.baseUrl,
          wire_api: 'responses',
          requires_openai_auth: false,
          env_key: LOOPBACK_BROKER_SECRET_ENV,
        },
      },
    },
  };
}

function settled(
  value: WorkerPipelineOwnerResult,
  values?: OwnerValues,
  requestId?: string,
): PipelineOwnerSettlement {
  return values && requestId
    ? { result: { status: 'owner', value }, values: { ...values, requestId } }
    : { result: { status: 'owner', value } };
}

function refused(message: string): PipelineOwnerSettlement {
  return {
    result: { status: 'failure', failureReason: null, message, outputs: {} },
  };
}

/**
 * No new paid route without current consent (CAN-7730). The supervisor
 * never delivers it: a connected app routes the step under its own setting,
 * otherwise the run checkpoints for AI Credits.
 */
const AI_CREDITS_CONSENT_DECLINED: PipelineOwnerSettlement = {
  ...refused(
    'AI Credits are off, or could not be confirmed, for this workflow.',
  ),
  checkpoint: 'ai-credits',
};

export function managedAiCreditsAttributionHeaders(
  owner: string,
  attribution?: WorkerPipelineNativeRouteEvidence['aiCreditsAttribution'],
): Readonly<Record<string, string>> {
  return {
    [MODEL_LIBRARY_PROTOCOL_HEADER]: String(MODEL_LIBRARY_PROTOCOL_VERSION),
    // `personal` and `org:<uuid>` are the serialized work owner already.
    [AI_CREDITS_WORK_OWNER_HEADER]: owner,
    ...(attribution?.workspaceName && {
      [AI_CREDITS_ATTRIBUTION_WORKSPACE_HEADER]: encodeURIComponent(
        attribution.workspaceName,
      ),
    }),
    ...(attribution?.worktreeName && {
      [AI_CREDITS_ATTRIBUTION_WORKTREE_HEADER]: encodeURIComponent(
        attribution.worktreeName,
      ),
    }),
    ...(attribution?.organizationProjectId && {
      [AI_CREDITS_ORG_PROJECT_HEADER]: attribution.organizationProjectId,
    }),
  };
}

export type ManagedPipelineOwnerPreparation =
  | {
      readonly kind: 'managed-model-answers';
      readonly authority: PipelineOwnerRunAuthority & {
        readonly answersFirst: (request: WorkerPipelineHostRequest) => boolean;
      };
      readonly decision: Extract<
        ManagedPipelineSurvivalDecision,
        { kind: 'admissible' }
      >;
    }
  | {
      readonly kind: 'app-dependent';
      readonly decision: ManagedPipelineSurvivalDecision;
    };

/** Whether this launch's evidence needs the account services at all. */
export function isManagedPipelineEvidence(
  evidence: WorkerPipelineNativeRouteEvidence,
): boolean {
  return evidence.policy === 'required' || evidence.aiCredits === 'required';
}

export async function prepareManagedPipelineOwnerRun(
  identity: PipelineOwnerRunIdentity,
  evidence: WorkerPipelineNativeRouteEvidence,
  ports: ManagedPipelineOwnerPorts,
  options: {
    readonly isConfigurationCurrent: (epoch: string) => boolean;
    /**
     * Whether the AI Credits consent admitted with the run still holds, read
     * before each new AI Credits route. Survival freezes that consent, so
     * opting out ends no other step; it opens no paid route after it.
     */
    readonly isAiCreditsConsentCurrent: () => Promise<boolean>;
    readonly signal?: AbortSignal;
  },
): Promise<ManagedPipelineOwnerPreparation> {
  // Admission judges the evidence's owner; it must be the run being bound.
  if (!samePipelineOwnerRunIdentity(identity, evidence.identity))
    return {
      kind: 'app-dependent',
      decision: { kind: 'pauses', blockers: ['unknown'] },
    };
  const decision = await assessManagedPipelineSurvival(
    evidence,
    ports,
    options.signal,
  );
  if (decision.kind !== 'admissible')
    return { kind: 'app-dependent', decision };
  const initial = await readCloudAccountAccess(ports.authority);
  if (
    initial.kind !== 'ok' ||
    !initial.hasCredential ||
    initial.sessionExpired ||
    initial.routeIdentity !== evidence.expectedAccountIdentity ||
    initial.credentialGeneration !== decision.credentialGeneration
  )
    return {
      kind: 'app-dependent',
      decision: { kind: 'pauses', blockers: ['policy'] },
    };
  const accountIdentity = initial.routeIdentity;
  const admittedAccountId = decision.accountId;
  const admitted = Object.freeze({ ...identity });
  const policyScope = evidence.policyScope ?? ports.policyScope;
  const owner: WorkOwner =
    admitted.owner === 'personal'
      ? { kind: 'personal' }
      : {
          kind: 'organization',
          organizationId: admitted.owner.slice('org:'.length),
        };
  const routes: readonly Route[] = Object.freeze(
    evidence.routes.map((route) => Object.freeze({ ...route })),
  );
  const sessionPrefix = `pipeline:${admitted.executionId}:`;
  /** routeSessionId → broker route id. */
  const sessions = new Map<string, string>();
  let closed = false;
  let retired = false;
  let checkpoint:
    | Parameters<NonNullable<PipelineOwnerRunAuthority['bindCheckpoint']>>[0]
    | undefined;
  let checkpointing: Promise<void> | undefined;

  function releaseSession(routeSessionId: string): void {
    const routeId = sessions.get(routeSessionId);
    sessions.delete(routeSessionId);
    if (routeId !== undefined)
      ports.broker.release({
        executionId: admitted.executionId,
        owner: admitted.owner,
        routeId,
      });
  }

  const routeFor = (
    harness: string,
    model: string | undefined,
  ): Route | undefined =>
    routes.find(
      (route) => route.harness === harness && route.requestModel === model,
    );
  const claims = (request: WorkerPipelineHostRequest): boolean => {
    if (
      request.executionId !== admitted.executionId ||
      request.owner !== admitted.owner ||
      request.childExecutionId !== null
    )
      return false;
    switch (request.request.action) {
      case 'owner.model.invocation':
      case 'owner.model.routing': {
        const action = request.request;
        const harness =
          action.action === 'owner.model.invocation'
            ? action.harness
            : action.provider;
        // Native steps retain app launch configuration while it is present;
        // the connected app remains current policy authority. Unknown
        // selections must withdraw survival before app resolution. An app
        // answer that switches to an app-hosted route ends survival in the
        // supervisor (forwardAppOwnerAnswer).
        return routeFor(harness, action.model)?.effectiveRoute !== 'native';
      }
      case 'owner.model.policy':
      case 'owner.model.policyRefusal':
        // Same-key provisioning preserves the daemon's independently refreshed
        // snapshot. Its stale allow must never bypass a connected app denial.
        // After detach the supervisor uses answer(), not answersFirst().
        return false;
      case 'owner.model.release':
        return sessions.has(request.request.routeSessionId);
      default:
        return false;
    }
  };

  async function policyAllows(modelId: string): Promise<boolean> {
    const governedModelId = ports.governedModelId
      ? ports.governedModelId(modelId)
      : modelId;
    if (governedModelId === undefined) return false;
    const read = await readCloudAccountAccess(ports.authority);
    if (
      read.kind !== 'ok' ||
      !read.hasCredential ||
      read.sessionExpired ||
      read.routeIdentity !== accountIdentity ||
      read.mayRequireGateway(owner)
    )
      return false;
    const answer = read.modelPolicy({
      owner,
      scope: policyScope,
      governedModelId,
    });
    return answer.kind === 'allowed';
  }

  /** The admitted runtime model plus this run's other AI Credits models. */
  function authorizedRequestModels(
    route: Route,
    governedModelId: string,
  ): Readonly<Record<string, string>> {
    const models: Record<string, string> = {};
    for (const candidate of routes) {
      if (
        candidate.harness !== route.harness ||
        candidate.effectiveRoute !== 'ai-credits'
      )
        continue;
      const governed = ports.governedModelId
        ? ports.governedModelId(candidate.requestModel)
        : candidate.requestModel;
      if (governed !== undefined) models[candidate.runtimeModel] = governed;
    }
    models[route.runtimeModel] = governedModelId;
    return models;
  }

  async function openRoute(
    route: Route,
    routeSessionId: string,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly baseUrl: string;
        readonly authToken: string;
        readonly routeSecret: string;
        guest: boolean;
      }
    | 'unconsented'
    | null
  > {
    const governedModelId = ports.governedModelId
      ? ports.governedModelId(route.requestModel)
      : route.requestModel;
    if (governedModelId === undefined) return null;
    const available = await ports.availability.load(owner, signal);
    if (available.kind !== 'spendable' || retired || closed || signal.aborted)
      return null;
    const read = await readCloudAccountAccess(ports.authority);
    if (
      retired ||
      closed ||
      signal.aborted ||
      read.kind !== 'ok' ||
      !read.hasCredential ||
      read.sessionExpired ||
      read.mayRequireGateway(owner) ||
      read.modelPolicy({
        owner,
        scope: policyScope,
        governedModelId,
      }).kind !== 'allowed'
    )
      return null;
    // Same account as admitted; a same-account key replacement keeps working.
    if (
      read.accountId !== admittedAccountId ||
      read.routeIdentity !== accountIdentity ||
      available.credentialGeneration !== read.credentialGeneration
    )
      return null;
    // Opted out, or unreadable: no new paid route. Routes already open finish.
    const consented = await options
      .isAiCreditsConsentCurrent()
      .catch(() => false);
    if (retired || closed || signal.aborted) return null;
    if (!consented) return 'unconsented';
    const opened = await ports.broker.openAiCreditsRoute({
      executionId: admitted.executionId,
      owner: admitted.owner,
      harness: route.harness,
      governedModelId,
      requestModels: authorizedRequestModels(route, governedModelId),
      policyScope,
      accountId: admittedAccountId,
      credentialGeneration: read.credentialGeneration,
      checkpointBeforeRevoke: (blocker): Promise<void> =>
        (checkpointing ??=
          checkpoint?.({
            code: blocker,
            explanation:
              'The account or its policy is no longer available for this AI Credits step.',
          }) ?? Promise.resolve()),
      workOwnerHeader: managedAiCreditsAttributionHeaders(
        admitted.owner,
        evidence.aiCreditsAttribution,
      ),
    });
    if (opened.kind !== 'opened') return null;
    if (closed || retired || signal.aborted) {
      ports.broker.release({
        executionId: admitted.executionId,
        owner: admitted.owner,
        routeId: opened.routeId,
      });
      return null;
    }
    const previous = sessions.get(routeSessionId);
    if (previous !== undefined)
      ports.broker.release({
        executionId: admitted.executionId,
        owner: admitted.owner,
        routeId: previous,
      });
    sessions.set(routeSessionId, opened.routeId);
    return { ...opened.child, guest: read.guest };
  }

  const answer = async (
    request: WorkerPipelineHostRequest,
    signal: AbortSignal,
  ): Promise<PipelineOwnerSettlement | undefined> => {
    const action = request.request;
    if (
      closed ||
      signal.aborted ||
      request.executionId !== admitted.executionId ||
      request.owner !== admitted.owner ||
      request.childExecutionId !== null
    )
      return undefined;
    if (retired && action.action !== 'owner.model.release') return undefined;
    switch (action.action) {
      case 'owner.model.invocation':
      case 'owner.model.routing': {
        if (!options.isConfigurationCurrent(evidence.configurationEpoch))
          return undefined;
        if (action.requiredAccountProxyConnectionId !== undefined)
          return refused('This model selection still needs the app.');
        const harness =
          action.action === 'owner.model.invocation'
            ? action.harness
            : action.provider;
        const route = routeFor(harness, action.model);
        if (!route) return undefined;
        const routeSessionId = action.routeSessionId;
        if (
          routeSessionId !== undefined &&
          !routeSessionId.startsWith(sessionPrefix)
        )
          return refused('This model selection still needs the app.');
        if (!(await policyAllows(route.requestModel))) return undefined;
        if (route.effectiveRoute === 'native') {
          if (action.action === 'owner.model.routing')
            return settled({ kind: 'model.routing', override: null });
          return settled({
            kind: 'model.invocation',
            source: route.source,
            harness,
            runtimeModel: route.runtimeModel,
            aiCreditsRouted: false,
            modelGatewayRouted: false,
            accountProxyRouted: false,
          });
        }
        if (route.effectiveRoute !== 'ai-credits') return undefined;
        if (routeSessionId === undefined || sessions.size >= 1024)
          return undefined;
        const child = await openRoute(route, routeSessionId, signal);
        if (child === 'unconsented') return AI_CREDITS_CONSENT_DECLINED;
        if (!child) return undefined;
        if (signal.aborted) {
          const routeId = sessions.get(routeSessionId);
          sessions.delete(routeSessionId);
          if (routeId)
            ports.broker.release({
              executionId: admitted.executionId,
              owner: admitted.owner,
              routeId,
            });
          return undefined;
        }
        const values = managedAiCreditsChildValues({
          harness: route.harness,
          runtimeModel: route.runtimeModel,
          baseUrl: child.baseUrl,
          authToken: child.authToken,
          routeSecret: child.routeSecret,
          guest: child.guest,
          providerName: evidence.aiCreditsAttribution?.providerName,
        });
        if (action.action === 'owner.model.routing')
          return settled(
            {
              kind: 'model.routing',
              override: {
                provider: route.harness,
                model: route.runtimeModel,
                modelGatewayRouted: false,
                accountProxyRouted: false,
              },
            },
            values,
            request.requestId,
          );
        return settled(
          {
            kind: 'model.invocation',
            source: route.source,
            harness,
            runtimeModel: route.runtimeModel,
            aiCreditsRouted: true,
            modelGatewayRouted: false,
            accountProxyRouted: false,
          },
          values,
          request.requestId,
        );
      }
      case 'owner.model.release': {
        if (!action.routeSessionId.startsWith(sessionPrefix))
          return refused('This model selection still needs the app.');
        releaseSession(action.routeSessionId);
        return settled({ kind: 'model.release' });
      }
      case 'owner.model.policy': {
        const read = await readCloudAccountAccess(ports.authority);
        if (
          read.kind !== 'ok' ||
          !read.hasCredential ||
          read.sessionExpired ||
          read.routeIdentity !== accountIdentity
        )
          return undefined;
        const active = read.modelPolicyActive(owner, policyScope);
        if (active === null) return undefined;
        if (action.check === 'active')
          return settled({
            kind: 'model.policy',
            answer: evidence.policy === 'required' || active,
          });
        if (
          action.modelId === undefined ||
          !routes.some((route) => route.requestModel === action.modelId)
        )
          return undefined;
        const governedModelId = ports.governedModelId
          ? ports.governedModelId(action.modelId)
          : action.modelId;
        if (governedModelId === undefined) return undefined;
        const evaluated = read.modelPolicy({
          owner,
          scope: policyScope,
          governedModelId,
        });
        if (evaluated.kind === 'unknown') return undefined;
        return {
          ...settled({
            kind: 'model.policy',
            answer: evaluated.kind === 'blocked',
          }),
          ...(evaluated.kind === 'blocked' && {
            checkpoint: 'policy' as const,
          }),
        };
      }
      case 'owner.model.policyRefusal':
        return settled({ kind: 'model.policyRefusal' });
      default:
        return undefined;
    }
  };

  return {
    kind: 'managed-model-answers',
    decision,
    authority: {
      answer,
      bindCheckpoint: (handler): void => {
        checkpoint = handler;
      },
      answersFirst: (request): boolean =>
        !closed &&
        (!retired || request.request.action === 'owner.model.release') &&
        claims(request),
      retire: (): void => {
        retired = true;
      },
      discardAnswer: (request): void => {
        const action = request.request;
        if (
          (action.action === 'owner.model.invocation' ||
            action.action === 'owner.model.routing') &&
          action.routeSessionId !== undefined
        )
          releaseSession(action.routeSessionId);
      },
      dispose: (): void => {
        closed = true;
        sessions.clear();
        // Settlement, cancellation or revocation: this run's routes only.
        ports.broker.releaseExecution(admitted.executionId);
      },
    },
  };
}
