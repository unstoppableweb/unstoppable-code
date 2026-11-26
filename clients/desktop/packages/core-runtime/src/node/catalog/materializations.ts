import { randomUUID } from 'node:crypto';
import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  catalogMaterializationSecretBindings,
  WorkerCatalogMaterializationReleaseResultSchema,
  WorkerCatalogMaterializationSchema,
  type CanopyErrorPayload,
  type CatalogMaterializationItemDescriptor,
  type OperationFailure,
  type OperationOrigin,
  type OperationOwner,
  type WorkerCatalogMaterialization,
} from '@canopy/protocol/canopy-core';

import {
  executionSecretFingerprints,
  type ExecutionSecretStager,
} from '../execution-secrets';
import type { LocalWorkerExecution } from '../operations/local-worker';
import type { OperationServicePort } from '../operations/service';
import { catalogMaterializationIdentity } from './revision';

/*
 * Catalog materialization (CAN-4123): the core resolves a chat's selection
 * strictly and the local worker materializes it under a content-addressed id
 * it never rewrites. Nothing here reads or writes a selection store.
 */
export const CORE_CATALOG_MATERIALIZATION_KIND = 'core.catalog.materialization';
export const WORKER_CATALOG_MATERIALIZE = 'worker.catalog.materialize';
export const WORKER_CATALOG_RELEASE = 'worker.catalog.materialization.release';

const CORE_CATALOG_MATERIALIZATION_RELEASE_KIND =
  'core.catalog.materialization.release';

const NOT_REPORTED: CanopyErrorPayload = {
  kind: 'internal',
  message: 'The worker did not report this materialization.',
  retry: { kind: 'never' },
};
const NOT_DISPATCHED: CanopyErrorPayload = {
  kind: 'internal',
  message: 'This materialization could not be dispatched.',
  retry: { kind: 'never' },
};

export interface CatalogMaterializationResolution {
  selection: { revision: number; selectedItemIds: string[] };
  items: CatalogMaterializationItemDescriptor[];
  /** Selected entries of kinds this version does not materialize (CAN-4125). */
  deferred: { entryId: string; entryKind: 'mcp_server' }[];
  /** Selected entries left out before materialization. */
  unavailable: {
    entryId: string;
    reason: 'disabled' | 'missing' | 'incompatible';
  }[];
  /** Resolution warnings (Canopy-authored text), as warning diagnostics. */
  warnings: string[];
}

export interface CatalogMaterializationResolver {
  /** Strict (D9): throws CatalogSelectionNotFoundError or CatalogSelectionUnavailableError. */
  resolve(scope: {
    workspaceId: string;
    worktreeId: string;
    chatId: string;
  }): Promise<CatalogMaterializationResolution>;
}

export interface CatalogMaterializationOutcome {
  materializationId: string;
  fingerprint: string;
  targetId: typeof CANOPY_IN_PROCESS_WORKER_TARGET_ID;
  operationId: string;
  state: 'ready' | 'failed';
  selection: { revision: number; selectedItemIds: string[] };
  effectiveItems: WorkerCatalogMaterialization['effectiveItems'];
  deferred: CatalogMaterializationResolution['deferred'];
  unavailable: CatalogMaterializationResolution['unavailable'];
  diagnostics: {
    entryId: string | null;
    code: string;
    severity: 'warning' | 'error';
    message: string;
  }[];
  error: CanopyErrorPayload | null;
}

function isPlaneQualifiedCode(
  code: string,
): code is `core.${string}.${string}` | `worker.${string}.${string}` {
  return /^(core|worker)\.[^.]+\..+$/.test(code);
}

function toErrorPayload(failure: OperationFailure): CanopyErrorPayload {
  const { code, ...rest } = failure;
  return code !== undefined && isPlaneQualifiedCode(code)
    ? { ...rest, code }
    : rest;
}

const byEntryId = (
  a: CatalogMaterializationItemDescriptor,
  b: CatalogMaterializationItemDescriptor,
): number => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0);

const RESOLUTION_WARNING = 'core.catalog.resolutionWarning';

function warningDiagnostics(
  resolution: CatalogMaterializationResolution,
): CatalogMaterializationOutcome['diagnostics'] {
  return resolution.warnings.map((message) => ({
    entryId: null,
    code: RESOLUTION_WARNING,
    severity: 'warning',
    message,
  }));
}

/** A materialized outcome described by the current resolution of its selection. */
function withResolution(
  outcome: CatalogMaterializationOutcome,
  resolution: CatalogMaterializationResolution,
): CatalogMaterializationOutcome {
  return {
    ...outcome,
    selection: resolution.selection,
    deferred: resolution.deferred,
    unavailable: resolution.unavailable,
    diagnostics: [
      ...outcome.diagnostics.filter(
        (diagnostic) => diagnostic.code !== RESOLUTION_WARNING,
      ),
      ...warningDiagnostics(resolution),
    ],
  };
}

export class CoreCatalogMaterializations {
  /** Attempts that hold a staged grant, by id; a release does not detach these. */
  private readonly granted = new Map<string, Promise<unknown>>();
  /** Attempts in flight by id; concurrent calls for one id share a dispatch. */
  private readonly inFlight = new Map<
    string,
    Promise<CatalogMaterializationOutcome>
  >();

  constructor(
    private readonly options: {
      operations: OperationServicePort;
      localWorker: LocalWorkerExecution;
      resolver: CatalogMaterializationResolver;
      /** Stages the MCP secret grant each dispatched attempt redeems (CAN-4125). */
      secrets: ExecutionSecretStager;
    },
  ) {
    options.operations.registerDomain({
      domain: CORE_CATALOG_MATERIALIZATION_KIND,
      kinds: [
        CORE_CATALOG_MATERIALIZATION_KIND,
        CORE_CATALOG_MATERIALIZATION_RELEASE_KIND,
      ],
      restartClass: 'lost',
      cancel: () => Promise.resolve('requested'),
    });
  }

  /**
   * Materializes a chat's selection on the in-process worker. The worker owns
   * every materialization: each call that joins no attempt in flight
   * dispatches, and the worker answers an id it holds unchanged.
   */
  async materialize(request: {
    scope: { workspaceId: string; worktreeId: string; chatId: string };
    origin: OperationOrigin;
    owner: OperationOwner;
  }): Promise<CatalogMaterializationOutcome> {
    const resolution = await this.options.resolver.resolve(request.scope);
    const { workspaceId, worktreeId, chatId } = request.scope;
    const scope = { workspaceId, worktreeId, chatId };
    const { fingerprint, materializationId } = catalogMaterializationIdentity(
      resolution.items,
      scope,
    );
    const joined = this.inFlight.get(materializationId);
    if (joined) return withResolution(await joined, resolution);
    const attempt = this.attempt({
      ...request,
      scope,
      resolution,
      fingerprint,
      materializationId,
    });
    this.inFlight.set(materializationId, attempt);
    try {
      return await attempt;
    } finally {
      if (this.inFlight.get(materializationId) === attempt)
        this.inFlight.delete(materializationId);
    }
  }

  /** Releases a materialization on the worker once no session uses it. */
  async release(request: {
    materializationId: string;
    origin: OperationOrigin;
    owner: OperationOwner;
  }): Promise<{ released: boolean }> {
    const { operations, localWorker } = this.options;
    const { materializationId } = request;
    // A call after this release dispatches again instead of joining an
    // attempt whose reply may arrive after the bundle is gone.
    this.inFlight.delete(materializationId);
    const { operation: parent } = await operations.admit({
      kind: CORE_CATALOG_MATERIALIZATION_RELEASE_KIND,
      status: 'running',
      origin: request.origin,
      owner: request.owner,
    });
    try {
      const dispatched = await localWorker.dispatch({
        parentOperationId: parent.operationId,
        operation: WORKER_CATALOG_RELEASE,
        params: { materializationId },
        idempotencyKey: `release:${materializationId}:${randomUUID()}`,
      });
      const parsed = WorkerCatalogMaterializationReleaseResultSchema.safeParse(
        dispatched.result,
      );
      if (dispatched.operation.status === 'completed' && parsed.success) {
        await operations.finishOrRecord(parent.operationId, {
          status: 'completed',
          outcome: parsed.data,
        });
        return parsed.data;
      }
      await operations.finishOrRecord(parent.operationId, {
        status: 'failed',
        error: dispatched.operation.error
          ? toErrorPayload(dispatched.operation.error)
          : NOT_REPORTED,
      });
      return { released: false };
    } catch (error) {
      await operations.finishOrRecord(parent.operationId, {
        status: 'failed',
        error: NOT_DISPATCHED,
      });
      throw error;
    }
  }

  private async attempt(request: {
    scope: { workspaceId: string; worktreeId: string; chatId: string };
    origin: OperationOrigin;
    owner: OperationOwner;
    resolution: CatalogMaterializationResolution;
    fingerprint: string;
    materializationId: string;
  }): Promise<CatalogMaterializationOutcome> {
    const { resolution, materializationId } = request;
    const bindings = catalogMaterializationSecretBindings(resolution.items);
    if (bindings.length === 0) return this.dispatchAttempt(request, bindings);
    // One grant per materialization id at a time: an attempt a release
    // detached keeps its grant until it settles, so a later attempt waits.
    const previous = this.granted.get(materializationId);
    const run = (async (): Promise<CatalogMaterializationOutcome> => {
      await previous?.catch(() => undefined);
      // Staged before admission so a refusal admits nothing; revoked once the
      // attempt ends, whether or not the worker redeemed it.
      const grant = this.options.secrets.stage(
        { operation: WORKER_CATALOG_MATERIALIZE, key: materializationId },
        bindings,
      );
      try {
        return await this.dispatchAttempt(request, bindings);
      } finally {
        grant.revoke();
      }
    })();
    this.granted.set(materializationId, run);
    try {
      return await run;
    } finally {
      if (this.granted.get(materializationId) === run)
        this.granted.delete(materializationId);
    }
  }

  private async dispatchAttempt(
    request: {
      scope: { workspaceId: string; worktreeId: string; chatId: string };
      origin: OperationOrigin;
      owner: OperationOwner;
      resolution: CatalogMaterializationResolution;
      fingerprint: string;
      materializationId: string;
    },
    bindings: ReturnType<typeof catalogMaterializationSecretBindings>,
  ): Promise<CatalogMaterializationOutcome> {
    const { operations, localWorker } = this.options;
    const { scope, resolution, fingerprint, materializationId } = request;
    const { operation: parent } = await operations.admit({
      kind: CORE_CATALOG_MATERIALIZATION_KIND,
      status: 'running',
      origin: request.origin,
      owner: request.owner,
      scope,
    });
    const warnings = warningDiagnostics(resolution);
    const base: Omit<
      CatalogMaterializationOutcome,
      'state' | 'effectiveItems' | 'diagnostics' | 'error'
    > = {
      materializationId,
      fingerprint,
      targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
      operationId: parent.operationId,
      selection: resolution.selection,
      deferred: resolution.deferred,
      unavailable: resolution.unavailable,
    };
    try {
      const dispatched = await localWorker.dispatch({
        parentOperationId: parent.operationId,
        operation: WORKER_CATALOG_MATERIALIZE,
        params: {
          materializationId,
          scope,
          itemDescriptors: [...resolution.items].sort(byEntryId),
          expectedFingerprint: fingerprint,
          ...(bindings.length > 0
            ? { secretGrantIds: [materializationId] }
            : {}),
          _meta: { idempotencyKey: materializationId },
        },
        idempotencyKey: materializationId,
        ...(bindings.length > 0
          ? { secrets: executionSecretFingerprints(bindings) }
          : {}),
      });
      const parsed = WorkerCatalogMaterializationSchema.safeParse(
        dispatched.result,
      );
      if (
        dispatched.operation.status === 'completed' &&
        parsed.success &&
        parsed.data.state === 'ready'
      ) {
        const diagnostics = [...parsed.data.diagnostics, ...warnings];
        await operations.finishOrRecord(parent.operationId, {
          status: 'completed',
          outcome: {
            materializationId,
            fingerprint,
            state: 'ready',
            diagnosticsCount: diagnostics.length,
          },
        });
        return {
          ...base,
          state: 'ready',
          effectiveItems: parsed.data.effectiveItems,
          diagnostics,
          error: null,
        };
      }
      const error = dispatched.operation.error
        ? toErrorPayload(dispatched.operation.error)
        : NOT_REPORTED;
      await operations.finishOrRecord(parent.operationId, {
        status: 'failed',
        error,
      });
      return {
        ...base,
        state: 'failed',
        effectiveItems: [],
        diagnostics: warnings,
        error,
      };
    } catch (error) {
      await operations.finishOrRecord(parent.operationId, {
        status: 'failed',
        error: NOT_DISPATCHED,
      });
      throw error;
    }
  }
}
