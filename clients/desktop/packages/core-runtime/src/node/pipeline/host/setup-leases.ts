import { isDeepStrictEqual } from 'node:util';
import {
  WorkerPipelineOwnerRequestSchema,
  WorkerPipelineOwnerResultSchema,
  WorkerPipelinePluginSelectionsSchema,
  type CanopyJsonValue,
  type WorkerPipelineOwnerRequest,
  type WorkerPipelineOwnerResult,
} from '@canopy/protocol/canopy-core';
import type {
  PipelineOwnerRunAuthority,
  PipelineOwnerRunIdentity,
} from './supervisor';

function expandedResources(value: CanopyJsonValue): boolean {
  const parsed = WorkerPipelinePluginSelectionsSchema.safeParse(value);
  return (
    parsed.success &&
    parsed.data.collectionIds.length === 0 &&
    (parsed.data.unresolvedCapabilities?.length ?? 0) === 0
  );
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function boundedList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= 256;
}

type SetupRequest = Extract<
  WorkerPipelineOwnerRequest,
  {
    action:
      | 'owner.claude.modAdmission'
      | 'owner.model.agentAlias'
      | 'owner.codex.pluginRefs';
  }
>;
type SetupResult = Extract<
  WorkerPipelineOwnerResult,
  { kind: 'claude.modAdmission' | 'model.agentAlias' | 'codex.pluginRefs' }
>;

/** A trusted producer's exact setup answer, never a worker-provided approval. */
export interface PipelineOwnerSetupLease {
  readonly identity: PipelineOwnerRunIdentity;
  readonly jobId: string;
  readonly stepId: string;
  readonly request: SetupRequest;
  readonly result: SetupResult;
  /** Versions cover configuration, identity/instructions and selected content. */
  readonly facts: readonly {
    readonly id: string;
    readonly version: string;
  }[];
}

export type PipelineOwnerSetupLeasePreparation =
  | {
      readonly kind: 'app-dependent';
      readonly reason:
        | 'invalid-lease'
        | 'scope-mismatch'
        | 'conflicting-lease'
        | 'stale-lease';
    }
  | {
      readonly kind: 'setup-leases';
      readonly authority: PipelineOwnerRunAuthority;
    };

function validPair(
  request: SetupRequest,
  result: WorkerPipelineOwnerResult,
): result is SetupResult {
  switch (request.action) {
    case 'owner.claude.modAdmission':
      return (
        result.kind === 'claude.modAdmission' &&
        result.context?.authority !== 'unreadable'
      );
    case 'owner.model.agentAlias':
      return (
        result.kind === 'model.agentAlias' &&
        result.alias !== null &&
        (result.alias.pluginSelections === undefined ||
          expandedResources(result.alias.pluginSelections))
      );
    case 'owner.codex.pluginRefs': {
      if (result.kind !== 'codex.pluginRefs') return false;
      return expandedResources(result.selections);
    }
  }
}

/**
 * Start leases survive a client disconnect, not content/policy changes.
 * The producer must have applied installed-item and skill-context policy.
 * This port never answers model policy or makes a run survival-eligible.
 */
export async function preparePipelineOwnerSetupLeases(
  identity: PipelineOwnerRunIdentity,
  snapshots: readonly PipelineOwnerSetupLease[],
  ports: {
    readonly isFactCurrent: (
      identity: PipelineOwnerRunIdentity,
      fact: PipelineOwnerSetupLease['facts'][number],
    ) => Promise<boolean>;
  },
): Promise<PipelineOwnerSetupLeasePreparation> {
  if (!boundedList(snapshots))
    return { kind: 'app-dependent', reason: 'invalid-lease' };
  const leases: PipelineOwnerSetupLease[] = [];
  const admittedIdentity = Object.freeze({ ...identity });
  for (const snapshot of snapshots) {
    if (typeof snapshot !== 'object' || snapshot === null)
      return { kind: 'app-dependent', reason: 'invalid-lease' };
    if (!isDeepStrictEqual(snapshot.identity, admittedIdentity))
      return { kind: 'app-dependent', reason: 'scope-mismatch' };
    const request = WorkerPipelineOwnerRequestSchema.safeParse(
      snapshot.request,
    );
    const result = WorkerPipelineOwnerResultSchema.safeParse(snapshot.result);
    if (
      !request.success ||
      !result.success ||
      (request.data.action !== 'owner.claude.modAdmission' &&
        request.data.action !== 'owner.model.agentAlias' &&
        request.data.action !== 'owner.codex.pluginRefs') ||
      !validPair(request.data, result.data) ||
      !boundedId(snapshot.jobId) ||
      !boundedId(snapshot.stepId) ||
      !boundedList(snapshot.facts) ||
      snapshot.facts.some(
        (fact) =>
          typeof fact !== 'object' ||
          fact === null ||
          !boundedId(fact.id) ||
          !boundedId(fact.version),
      )
    )
      return { kind: 'app-dependent', reason: 'invalid-lease' };
    const lease = {
      identity: admittedIdentity,
      jobId: snapshot.jobId,
      stepId: snapshot.stepId,
      request: request.data,
      result: result.data,
      facts: snapshot.facts.map((fact) => Object.freeze({ ...fact })),
    };
    const duplicate = leases.find(
      (known) =>
        known.jobId === lease.jobId &&
        known.stepId === lease.stepId &&
        isDeepStrictEqual(known.request, lease.request),
    );
    if (
      duplicate &&
      (!isDeepStrictEqual(duplicate.result, lease.result) ||
        !isDeepStrictEqual(duplicate.facts, lease.facts))
    )
      return { kind: 'app-dependent', reason: 'conflicting-lease' };
    if (!duplicate) leases.push(lease);
  }
  const current = async (lease: PipelineOwnerSetupLease): Promise<boolean> => {
    try {
      for (const fact of lease.facts)
        if (!(await ports.isFactCurrent(admittedIdentity, fact))) return false;
      return true;
    } catch {
      return false;
    }
  };
  for (const lease of leases)
    if (!(await current(lease)))
      return { kind: 'app-dependent', reason: 'stale-lease' };
  let closed = false;
  return {
    kind: 'setup-leases',
    authority: {
      answer: async (request, signal) => {
        if (
          closed ||
          signal.aborted ||
          request.executionId !== admittedIdentity.executionId ||
          request.owner !== admittedIdentity.owner ||
          request.childExecutionId !== null
        )
          return undefined;
        const lease = leases.find(
          (candidate) =>
            candidate.jobId === request.jobId &&
            candidate.stepId === request.stepId &&
            isDeepStrictEqual(candidate.request, request.request),
        );
        if (!lease || !(await current(lease)) || closed || signal.aborted)
          return undefined;
        // Parse again: consumers must not mutate the leased snapshot.
        return {
          result: {
            status: 'owner',
            value: WorkerPipelineOwnerResultSchema.parse(lease.result),
          },
        };
      },
      dispose: () => {
        closed = true;
        leases.length = 0;
      },
    },
  };
}
