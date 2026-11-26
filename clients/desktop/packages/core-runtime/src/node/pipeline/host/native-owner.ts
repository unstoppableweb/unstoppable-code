import {
  WorkerPipelineNativeRouteEvidenceSchema,
  type WorkerPipelineNativeRouteEvidence,
  type WorkerPipelineHostRequest,
  type WorkerPipelineOwnerResult,
} from '@canopy/protocol/canopy-core';
import type { PipelineOwnerSettlement } from '../execution/host-requests';
import type {
  PipelineOwnerRunAuthority,
  PipelineOwnerRunIdentity,
} from './supervisor';

export type PipelineNativeRouteEvidence = WorkerPipelineNativeRouteEvidence;
export type PipelineNativeAnswerBlocker =
  | 'invalid-evidence'
  | 'configuration-stale'
  | 'scope-mismatch'
  | 'policy-dependent'
  | 'gateway-dependent'
  | 'proxy-dependent'
  | 'credits-dependent'
  | 'dynamic-selection'
  | 'route-dependent';

/** Readiness for model answers only, not whole-run survival eligibility. */
export type PipelineNativeOwnerPreparation =
  | {
      readonly kind: 'app-dependent';
      readonly blockers: readonly PipelineNativeAnswerBlocker[];
    }
  | {
      readonly kind: 'native-model-answers';
      readonly authority: PipelineOwnerRunAuthority;
      readonly assessment: Readonly<{
        version: 1;
        identity: PipelineOwnerRunIdentity;
        configurationEpoch: string;
        routes: readonly Readonly<
          PipelineNativeRouteEvidence['routes'][number]
        >[];
      }>;
    };

export function samePipelineOwnerRunIdentity(
  left: PipelineOwnerRunIdentity,
  right: PipelineOwnerRunIdentity,
): boolean {
  return (
    left.executionId === right.executionId &&
    left.owner === right.owner &&
    left.runScope === right.runScope &&
    left.workspaceId === right.workspaceId &&
    left.worktreeId === right.worktreeId
  );
}

function settled(value: WorkerPipelineOwnerResult): PipelineOwnerSettlement {
  return { result: { status: 'owner', value } };
}

function refused(): PipelineOwnerSettlement {
  return {
    result: {
      status: 'failure',
      failureReason: null,
      message: 'This model selection still needs the app.',
      outputs: {},
    },
  };
}

/**
 * Answers only exact, positively admitted native selections. Credential access
 * and refresh remain the vendor runtime's job; this never creates a proxy or a
 * paid fallback. Launch environment values remain on the host-local boundary.
 */
export function prepareNativePipelineOwnerRun(
  identity: PipelineOwnerRunIdentity,
  evidence: unknown,
  ports: {
    readonly isConfigurationCurrent: (epoch: string) => boolean;
    readonly recordPolicyRefusal: (context: {
      identity: PipelineOwnerRunIdentity;
      modelId: string;
    }) => void;
  },
): PipelineNativeOwnerPreparation {
  const parsed = WorkerPipelineNativeRouteEvidenceSchema.safeParse(evidence);
  if (!parsed.success)
    return { kind: 'app-dependent', blockers: ['invalid-evidence'] };
  const proof = parsed.data;
  const configurationCurrent = (): boolean => {
    try {
      return ports.isConfigurationCurrent(proof.configurationEpoch) === true;
    } catch {
      return false;
    }
  };
  const blockers: PipelineNativeAnswerBlocker[] = [];
  if (!configurationCurrent()) blockers.push('configuration-stale');
  if (!samePipelineOwnerRunIdentity(identity, proof.identity))
    blockers.push('scope-mismatch');
  if (
    identity.owner !== 'personal' ||
    proof.policy !== 'account-independent-personal'
  )
    blockers.push('policy-dependent');
  if (proof.gateway !== 'absent') blockers.push('gateway-dependent');
  if (proof.accountProxy !== 'absent') blockers.push('proxy-dependent');
  if (proof.aiCredits !== 'absent') blockers.push('credits-dependent');
  if (proof.futureSelections !== 'closed') blockers.push('dynamic-selection');
  if (
    proof.routes.some(
      (value) =>
        value.effectiveRoute !== 'native' ||
        value.requestModel !== value.runtimeModel ||
        value.source !==
          (value.harness === 'claude' ? 'claude-managed' : 'codex-managed') ||
        value.authentication === 'unknown',
    )
  )
    blockers.push('route-dependent');
  const selections = new Map<
    string,
    Map<string | null, (typeof proof.routes)[number]>
  >();
  for (const value of proof.routes) {
    const known =
      selections.get(value.harness) ??
      new Map<string | null, (typeof proof.routes)[number]>();
    // A selection with two possible answers is not closed, even if both
    // possibilities name native providers.
    const previous = known.get(value.selection);
    if (
      previous !== undefined &&
      (previous.runtimeModel !== value.runtimeModel ||
        previous.source !== value.source ||
        previous.authentication !== value.authentication) &&
      !blockers.includes('dynamic-selection')
    )
      blockers.push('dynamic-selection');
    known.set(value.selection, value);
    const canonical = known.get(value.requestModel);
    if (
      canonical !== undefined &&
      (canonical.runtimeModel !== value.runtimeModel ||
        canonical.source !== value.source ||
        canonical.authentication !== value.authentication)
    )
      blockers.push('dynamic-selection');
    known.set(value.requestModel, value);
    selections.set(value.harness, known);
  }
  if (blockers.length) return { kind: 'app-dependent', blockers };

  const admittedIdentity = Object.freeze({ ...identity });
  const routes = Object.freeze(
    proof.routes.map((value) => Object.freeze(value)),
  );
  const assessment = Object.freeze({
    version: proof.version,
    identity: admittedIdentity,
    configurationEpoch: proof.configurationEpoch,
    routes,
  });
  const sessionPrefix = `pipeline:${admittedIdentity.executionId}:`;
  const sessions = new Set<string>();
  let closed = false;
  const authority: PipelineOwnerRunAuthority = {
    answer: (
      request: WorkerPipelineHostRequest,
      signal: AbortSignal,
    ): Promise<PipelineOwnerSettlement | undefined> => {
      const answer = (): PipelineOwnerSettlement | undefined => {
        const action = request.request;
        switch (action.action) {
          case 'owner.model.invocation':
          case 'owner.model.routing':
          case 'owner.model.release':
          case 'owner.model.policy':
          case 'owner.model.policyRefusal':
            break;
          default:
            return undefined;
        }
        if (
          closed ||
          signal.aborted ||
          request.executionId !== admittedIdentity.executionId ||
          request.owner !== admittedIdentity.owner ||
          request.childExecutionId !== null
        )
          return refused();
        // Cleanup and refusal diagnostics need no current routing permission.
        if (
          action.action !== 'owner.model.release' &&
          action.action !== 'owner.model.policyRefusal' &&
          !configurationCurrent()
        )
          return refused();
        switch (action.action) {
          case 'owner.model.invocation':
          case 'owner.model.routing': {
            if (
              action.requiredAccountProxyConnectionId !== undefined ||
              (action.routeSessionId !== undefined &&
                !action.routeSessionId.startsWith(sessionPrefix))
            )
              return refused();
            const harness =
              action.action === 'owner.model.invocation'
                ? action.harness
                : action.provider;
            const selected = routes.find(
              (value) =>
                value.harness === harness &&
                value.requestModel === action.model,
            );
            if (!selected) return refused();
            if (
              action.routeSessionId !== undefined &&
              !sessions.has(action.routeSessionId) &&
              sessions.size >= 1024
            )
              return refused();
            if (action.routeSessionId !== undefined)
              sessions.add(action.routeSessionId);
            if (action.action === 'owner.model.routing')
              return settled({ kind: 'model.routing', override: null });
            return settled({
              kind: 'model.invocation',
              source: selected.source,
              harness,
              runtimeModel: selected.runtimeModel,
              aiCreditsRouted: false,
              modelGatewayRouted: false,
              accountProxyRouted: false,
            });
          }
          case 'owner.model.release':
            // Native routes own no broker resources. A foreign release is
            // refused rather than touching another run's registry.
            if (!action.routeSessionId.startsWith(sessionPrefix))
              return refused();
            sessions.delete(action.routeSessionId);
            return settled({ kind: 'model.release' });
          case 'owner.model.policy':
            if (
              action.check === 'blocked' &&
              !routes.some((value) => value.requestModel === action.modelId)
            )
              return refused();
            return settled({
              kind: 'model.policy',
              answer: false,
            });
          case 'owner.model.policyRefusal':
            try {
              ports.recordPolicyRefusal({
                identity: admittedIdentity,
                modelId: action.modelId,
              });
            } catch {
              // Diagnostics never grant permission or replace a refusal.
            }
            return settled({ kind: 'model.policyRefusal' });
        }
      };
      return Promise.resolve(answer());
    },
    dispose: (): void => {
      closed = true;
      sessions.clear();
    },
  };
  return { kind: 'native-model-answers', authority, assessment };
}
