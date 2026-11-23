import { createHash } from 'node:crypto';
import {
  PipelineDefinitionDeleteResultSchema,
  PipelineDefinitionSetEnabledResultSchema,
  type CanopyInstructionHandler,
  type CanopyQueryHandler,
  type PipelineDefinition,
  type PipelineDefinitionDeleteResult,
  type PipelineDefinitionDuplicateResult,
  type PipelineDefinitionImportResult,
  type PipelineDefinitionSetEnabledResult,
  PIPELINE_GRANTS,
  type PipelineDefinitionUpsertResult,
  type PipelineDefinitionGetResult,
  type PipelineDefinitionListResult,
  type PipelineDefinitionValidateResult,
} from '@canopy/protocol/canopy-core';
import {
  CanopyOperationError,
  canopyPermissionDeniedError,
} from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import {
  pipelineDefinitionError,
  PipelineDefinitionResumableWrite,
  type PipelineDefinitionCreateReplay,
  type PipelineDefinitionPendingEnablement,
  type PipelineDefinitionService,
} from './definitions';

export interface CorePipelineDefinitionHandlers {
  queries: {
    'core.pipeline.definition.list': CanopyQueryHandler<
      'core.pipeline.definition.list',
      CanopyHandlerContext
    >;
    'core.pipeline.definition.get': CanopyQueryHandler<
      'core.pipeline.definition.get',
      CanopyHandlerContext
    >;
    'core.pipeline.definition.validate': CanopyQueryHandler<
      'core.pipeline.definition.validate',
      CanopyHandlerContext
    >;
  };
  instructions: {
    'core.pipeline.definition.upsert': CanopyInstructionHandler<
      'core.pipeline.definition.upsert',
      CanopyHandlerContext
    >;
    'core.pipeline.definition.delete': CanopyInstructionHandler<
      'core.pipeline.definition.delete',
      CanopyHandlerContext
    >;
    'core.pipeline.definition.duplicate': CanopyInstructionHandler<
      'core.pipeline.definition.duplicate',
      CanopyHandlerContext
    >;
    'core.pipeline.definition.setEnabled': CanopyInstructionHandler<
      'core.pipeline.definition.setEnabled',
      CanopyHandlerContext
    >;
    'core.pipeline.definition.import': CanopyInstructionHandler<
      'core.pipeline.definition.import',
      CanopyHandlerContext
    >;
  };
}

export interface CorePipelineDefinitionHost {
  /** The service for this host, created on the first call. */
  load(): Promise<PipelineDefinitionService>;
  /** The authority this host serves; other `scope.authorityId`s are refused. */
  readonly authorityId: string;
  /** Keeps write receipts across restarts; without it they last the process. */
  readonly replays?: PipelineDefinitionReplayStore;
}

function assertServingAuthority(
  host: CorePipelineDefinitionHost,
  authorityId: string | undefined,
): void {
  if (authorityId !== undefined && authorityId !== host.authorityId)
    throw pipelineDefinitionError(
      'core.pipeline.targetUnavailable',
      'This host does not serve the selected authority.',
    );
}

/** Committed writes a caller can replay with the same idempotency key. */
const REPLAY_LIMIT = 256;
/** Aged-out keys still refused; older ones are forgotten. */
const EXPIRED_LIMIT = 4_096;

/**
 * What a host keeps of a committed write so its key replays after a
 * restart. A definition is kept by id and revision, not by its document.
 */
export type PipelineDefinitionReplayReceipt =
  | {
      readonly kind: 'definition';
      readonly definitionId: string;
      readonly revision: number;
      /**
       * The enabled state the write answered with; absent for a write that
       * set none and failed before answering.
       */
      readonly enabled?: boolean;
      /** The definition a duplicate copied or an import installed. */
      readonly sourceDefinitionId?: string;
      /** The remote content hash an import installed. */
      readonly remoteVersion?: string;
    }
  | ({ readonly kind: 'enablement' } & PipelineDefinitionPendingEnablement)
  | { readonly kind: 'result'; readonly result: Record<string, unknown> };

export type PipelineDefinitionWriteOperation =
  | 'core.pipeline.definition.upsert'
  | 'core.pipeline.definition.delete'
  | 'core.pipeline.definition.duplicate'
  | 'core.pipeline.definition.setEnabled'
  | 'core.pipeline.definition.import';

export interface PipelineDefinitionReplayEntry {
  readonly operation: PipelineDefinitionWriteOperation;
  /** A digest of the caller and idempotency key. */
  readonly key: string;
  /** A digest of the request payload. */
  readonly fingerprint: string;
  readonly receipt: PipelineDefinitionReplayReceipt;
}

export interface PipelineDefinitionReplayLedger {
  /** Oldest first within each operation. */
  readonly entries: readonly PipelineDefinitionReplayEntry[];
  /** Keys whose receipts aged out, oldest first. */
  readonly expired: readonly {
    readonly operation: PipelineDefinitionWriteOperation;
    readonly key: string;
  }[];
}

/** Where a host keeps the replay ledger across restarts. */
export interface PipelineDefinitionReplayStore {
  load(): Promise<PipelineDefinitionReplayLedger>;
  save(ledger: PipelineDefinitionReplayLedger): Promise<void>;
}

interface Replay<T> {
  readonly fingerprint: string;
  /** The committed result in this process. */
  readonly result?: Promise<T>;
  /** The step a retry finishes. */
  readonly resume?: () => Promise<T>;
  /** What survives a restart; absent until the write commits. */
  readonly receipt?: PipelineDefinitionReplayReceipt;
  /** Whether the host has stored this entry's receipt. */
  readonly stored?: boolean;
}

interface ReplayHandling<T> {
  readonly receiptOf: (result: T) => PipelineDefinitionReplayReceipt;
  /** Answers a receipt an earlier process stored. */
  readonly restore: (
    receipt: PipelineDefinitionReplayReceipt,
    signal: AbortSignal,
  ) => Promise<T>;
  /** The step a retry finishes when the write committed before failing. */
  readonly resumeOf?: (error: unknown) =>
    | {
        resume: () => Promise<T>;
        receipt: PipelineDefinitionReplayReceipt;
      }
    | undefined;
}

type ReplayCache<T> = (
  context: CanopyHandlerContext,
  params: object,
  run: () => Promise<T>,
) => Promise<T>;

interface ReplaySection {
  readonly operation: PipelineDefinitionWriteOperation;
  restore(ledger: PipelineDefinitionReplayLedger): void;
  snapshot(): Pick<PipelineDefinitionReplayLedger, 'entries' | 'expired'>;
  supersedeEnablement(definitionId: string): void;
}

function upsertResumeOf(error: unknown):
  | {
      resume: () => Promise<PipelineDefinitionUpsertResult>;
      receipt: PipelineDefinitionReplayReceipt;
    }
  | undefined {
  const cause =
    error instanceof CanopyOperationError ? error.runtimeCause : undefined;
  if (!(cause instanceof PipelineDefinitionResumableWrite)) return undefined;
  const { definitionId, revision, enabled } = cause.pending;
  const receipt: PipelineDefinitionReplayReceipt =
    enabled === undefined
      ? { kind: 'definition', definitionId, revision }
      : { kind: 'enablement', definitionId, revision, enabled };
  return {
    resume: async (): Promise<PipelineDefinitionUpsertResult> => ({
      definition: await cause.resume(),
    }),
    // Only a request that set the enabled state leaves one to record, and
    // not once a newer enabled state has been recorded since its attempt,
    // even before this failure reached the ledger.
    receipt:
      receipt.kind === 'enablement' && cause.superseded()
        ? supersededReceipt(receipt)
        : receipt,
  };
}

function replayExpired(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    message:
      'This idempotency key is too old to replay; read the workflow and send a new request.',
    retry: { kind: 'never' },
  });
}

function receiptUnavailable(cause: unknown): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'unavailable',
      message: 'The workflow request could not be recorded; retry it.',
      retry: { kind: 'same_idempotency_key' },
    },
    cause,
  );
}

function receiptMismatch(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    message:
      'This request already changed the workflow, which has changed again since; read it and send a new request.',
    retry: { kind: 'never' },
  });
}

// A write is retried with its idempotency key, never as a fresh request.
function writeError(error: unknown): unknown {
  if (
    error instanceof CanopyOperationError &&
    error.payload.retry?.kind === 'same_request'
  )
    return new CanopyOperationError(
      {
        ...error.payload,
        retry: { kind: 'same_idempotency_key' },
      },
      error.runtimeCause,
    );
  return error;
}

/**
 * Keyed replay for the definition writes: the same key and payload return
 * the first committed result, a different payload is a conflict, a failed
 * write frees its key for a retry, and a write that committed before
 * failing keeps its key so a retry finishes it. A key whose receipt has
 * aged out is refused rather than written again. With a store, receipts
 * survive a restart once stored.
 */
function createReplayLedger(store: PipelineDefinitionReplayStore | undefined): {
  cache<T>(
    operation: PipelineDefinitionWriteOperation,
    handling: ReplayHandling<T>,
  ): ReplayCache<T>;
  /**
   * A later enabled state for this definition supersedes any write still
   * waiting to record its own: replaying that write is refused, never
   * resumed over the newer state.
   */
  supersedeEnablement(definitionId: string): void;
} {
  const sections: ReplaySection[] = [];
  let loaded: Promise<void> | undefined;
  let saving: Promise<void> = Promise.resolve();

  const load = (): Promise<void> => {
    loaded ??= (async (): Promise<void> => {
      if (!store) return;
      const ledger = await store.load();
      for (const section of sections) section.restore(ledger);
    })().catch((error: unknown) => {
      loaded = undefined;
      throw receiptUnavailable(error);
    });
    return loaded;
  };

  // Saves run one at a time, each writing the ledger as it then stands.
  const save = (): Promise<void> => {
    if (!store) return Promise.resolve();
    const write = (): Promise<void> =>
      store.save({
        entries: sections.flatMap((section) => section.snapshot().entries),
        expired: sections.flatMap((section) => section.snapshot().expired),
      });
    const next = saving.then(write, write);
    saving = next.catch((): void => undefined);
    return next;
  };

  return {
    supersedeEnablement(definitionId: string): void {
      for (const section of sections) section.supersedeEnablement(definitionId);
    },
    cache<T>(
      operation: PipelineDefinitionWriteOperation,
      handling: ReplayHandling<T>,
    ): ReplayCache<T> {
      const replays = new Map<string, Replay<T>>();
      const expired = new Set<string>();
      sections.push({
        operation,
        restore: (ledger): void => {
          for (const entry of ledger.expired)
            if (entry.operation === operation) expired.add(entry.key);
          for (const entry of ledger.entries)
            if (entry.operation === operation)
              replays.set(entry.key, {
                fingerprint: entry.fingerprint,
                receipt: entry.receipt,
                stored: true,
              });
        },
        snapshot: () => ({
          entries: Array.from(replays).flatMap(([key, replay]) =>
            replay.receipt
              ? [
                  {
                    operation,
                    key,
                    fingerprint: replay.fingerprint,
                    receipt: replay.receipt,
                  },
                ]
              : [],
          ),
          expired: Array.from(expired, (key) => ({ operation, key })),
        }),
        supersedeEnablement: (definitionId): void => {
          for (const [key, replay] of Array.from(replays)) {
            const receipt = replay.receipt;
            if (
              receipt?.kind === 'enablement' &&
              receipt.definitionId === definitionId
            )
              replays.set(key, {
                fingerprint: replay.fingerprint,
                receipt: supersededReceipt(receipt),
              });
          }
        },
      });

      const settle = (key: string, replay: Replay<T>): void => {
        replays.delete(key);
        replays.set(key, replay);
        while (replays.size > REPLAY_LIMIT) {
          const oldest = replays.keys().next().value;
          if (oldest === undefined) break;
          replays.delete(oldest);
          expired.add(oldest);
        }
        while (expired.size > EXPIRED_LIMIT) {
          const oldest = expired.values().next().value;
          if (oldest === undefined) break;
          expired.delete(oldest);
        }
      };

      // A committed write is answered even when its receipt could not be
      // stored: failing it would make a caller that sends a new key per
      // attempt write again. The receipt replays in this process and is
      // stored with the next save that succeeds.
      const acknowledge = async (
        key: string,
        replay: Replay<T>,
        value: T,
      ): Promise<T> => {
        if (replay.stored || !store) return value;
        const saved = await save().then(
          () => true,
          () => false,
        );
        if (saved && replays.get(key) === replay)
          replays.set(key, { ...replay, stored: true });
        return value;
      };

      return async (context, params, run): Promise<T> => {
        await load();
        const key = createHash('sha256')
          .update(
            [
              context.caller.principalId,
              context.caller.clientInstanceId,
              context.metadata.idempotencyKey ?? '',
            ].join('\0'),
          )
          .digest('hex');
        if (expired.has(key)) throw replayExpired();
        const payload = Object.entries(params).filter(
          ([name]) => name !== '_meta',
        );
        const fingerprint = createHash('sha256')
          .update(JSON.stringify(payload))
          .digest('hex');
        const previous = replays.get(key);
        if (previous && previous.fingerprint !== fingerprint)
          throw new CanopyOperationError({
            kind: 'conflict',
            message:
              'This idempotency key was already used for a different request.',
            retry: { kind: 'never' },
          });
        if (previous?.result)
          return acknowledge(key, previous, await previous.result);
        const stored = previous?.receipt;
        const result = previous?.resume
          ? previous.resume()
          : stored
            ? handling.restore(stored, context.signal)
            : run();
        // A receipt already stored stays in every snapshot while this runs.
        const pending: Replay<T> = previous?.receipt
          ? {
              fingerprint,
              result,
              receipt: previous.receipt,
              stored: previous.stored,
            }
          : { fingerprint, result };
        settle(key, pending);
        let value: T;
        try {
          value = await result;
        } catch (error) {
          if (replays.get(key) === pending) {
            const resumable = handling.resumeOf?.(error);
            if (resumable) {
              settle(key, { fingerprint, ...resumable });
              // The original failure is the answer; a retry stores it again.
              await save().catch((): void => undefined);
            } else if (previous) {
              settle(key, previous);
              if (previous.receipt) await save().catch((): void => undefined);
            } else replays.delete(key);
          }
          throw writeError(error);
        }
        const committed: Replay<T> = {
          fingerprint,
          result,
          receipt: handling.receiptOf(value),
        };
        if (replays.get(key) === pending) settle(key, committed);
        return acknowledge(key, committed, value);
      };
    },
  };
}

/**
 * An enablement receipt a newer enabled state has superseded: a restore then
 * finds the other enabled state and refuses.
 */
function supersededReceipt(
  receipt: Extract<PipelineDefinitionReplayReceipt, { kind: 'enablement' }>,
): PipelineDefinitionReplayReceipt {
  return {
    kind: 'definition',
    definitionId: receipt.definitionId,
    revision: receipt.revision,
    enabled: receipt.enabled,
  };
}

/**
 * The id a keyed create or copy commits under (CAN-7497), so a resend whose
 * receipt was lost finds its own definition. It digests the receipt's whole
 * scope, the operation, principal, client instance and key, never the key
 * alone: another caller's same key derives another id.
 */
function createReplay(
  operation: PipelineDefinitionWriteOperation,
  context: CanopyHandlerContext,
): PipelineDefinitionCreateReplay {
  const hex = createHash('sha256')
    .update(
      [
        'pipeline-definition-create',
        operation,
        context.caller.principalId,
        context.caller.clientInstanceId,
        context.metadata.idempotencyKey ?? '',
      ].join('\0'),
    )
    .digest('hex');
  // A UUID-shaped id (RFC 9562 version 8), as the store's other ids are.
  const variant = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return {
    createId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  };
}

/** A definition a receipt names, unless a later write has moved it on. */
async function restoreDefinition(
  host: CorePipelineDefinitionHost,
  receipt: PipelineDefinitionReplayReceipt,
  signal: AbortSignal,
): Promise<PipelineDefinition> {
  if (receipt.kind === 'result') throw receiptMismatch();
  const service = await host.load();
  if (receipt.kind === 'enablement') await service.resumeEnablement(receipt);
  const definition = await service.get(receipt.definitionId, {}, signal);
  // A later write or enablement change leaves a different state than the
  // one this key answered with.
  if (
    definition.revision !== receipt.revision ||
    (receipt.enabled !== undefined && definition.enabled !== receipt.enabled)
  )
    throw receiptMismatch();
  return definition;
}

function definitionReceipt(
  definition: PipelineDefinition,
  sourceDefinitionId?: string,
  remoteVersion?: string,
): PipelineDefinitionReplayReceipt {
  return {
    kind: 'definition',
    definitionId: definition.definitionId,
    revision: definition.revision,
    enabled: definition.enabled,
    ...(sourceDefinitionId === undefined ? {} : { sourceDefinitionId }),
    ...(remoteVersion === undefined ? {} : { remoteVersion }),
  };
}

/** `core.pipeline.definition.*` handlers. */
export function createCorePipelineDefinitionHandlers(
  host: CorePipelineDefinitionHost,
): CorePipelineDefinitionHandlers {
  const ledger = createReplayLedger(host.replays);
  const replayUpsert = ledger.cache<PipelineDefinitionUpsertResult>(
    'core.pipeline.definition.upsert',
    {
      receiptOf: ({ definition }) => definitionReceipt(definition),
      restore: async (receipt, signal) => ({
        definition: await restoreDefinition(host, receipt, signal),
      }),
      resumeOf: upsertResumeOf,
    },
  );
  const replayDelete = ledger.cache<PipelineDefinitionDeleteResult>(
    'core.pipeline.definition.delete',
    {
      receiptOf: (result) => ({ kind: 'result', result: { ...result } }),
      restore: (receipt) => {
        const result =
          receipt.kind === 'result'
            ? PipelineDefinitionDeleteResultSchema.safeParse(receipt.result)
            : undefined;
        if (!result?.success) return Promise.reject(receiptMismatch());
        return Promise.resolve(result.data);
      },
    },
  );
  const replayDuplicate = ledger.cache<PipelineDefinitionDuplicateResult>(
    'core.pipeline.definition.duplicate',
    {
      receiptOf: ({ definition, sourceDefinitionId }) =>
        definitionReceipt(definition, sourceDefinitionId),
      restore: async (receipt, signal) => {
        if (receipt.kind !== 'definition' || !receipt.sourceDefinitionId)
          throw receiptMismatch();
        return {
          definition: await restoreDefinition(host, receipt, signal),
          sourceDefinitionId: receipt.sourceDefinitionId,
        };
      },
    },
  );
  const replayImport = ledger.cache<PipelineDefinitionImportResult>(
    'core.pipeline.definition.import',
    {
      receiptOf: ({ definition, remoteDefinitionId, remoteVersion }) =>
        definitionReceipt(definition, remoteDefinitionId, remoteVersion),
      restore: async (receipt, signal) => {
        if (
          receipt.kind !== 'definition' ||
          !receipt.sourceDefinitionId ||
          receipt.remoteVersion === undefined
        )
          throw receiptMismatch();
        return {
          definition: await restoreDefinition(host, receipt, signal),
          remoteDefinitionId: receipt.sourceDefinitionId,
          remoteVersion: receipt.remoteVersion,
        };
      },
    },
  );
  const replaySetEnabled = ledger.cache<PipelineDefinitionSetEnabledResult>(
    'core.pipeline.definition.setEnabled',
    {
      receiptOf: (result) => ({ kind: 'result', result: { ...result } }),
      restore: (receipt) => {
        const result =
          receipt.kind === 'result'
            ? PipelineDefinitionSetEnabledResultSchema.safeParse(receipt.result)
            : undefined;
        if (!result?.success) return Promise.reject(receiptMismatch());
        return Promise.resolve(result.data);
      },
    },
  );
  return {
    queries: {
      'core.pipeline.definition.list': async (
        params,
        { signal },
      ): Promise<PipelineDefinitionListResult> => {
        assertServingAuthority(host, params.scope?.authorityId);
        return (await host.load()).list(params, signal);
      },
      'core.pipeline.definition.get': async (
        params,
        { caller, signal },
      ): Promise<PipelineDefinitionGetResult> => {
        assertServingAuthority(host, params.scope?.authorityId);
        // Naming an owner bypasses the navigation context, so only a caller
        // granted owner reads may claim one.
        if (
          params.owner !== undefined &&
          !caller.grants.includes(PIPELINE_GRANTS.ownerRead)
        )
          throw canopyPermissionDeniedError(
            'Reading a workflow for a run owner needs the owner read grant.',
          );
        return {
          definition: await (
            await host.load()
          ).get(params.definitionId, params.scope ?? {}, signal, params.owner),
        };
      },
      'core.pipeline.definition.validate': async (
        params,
      ): Promise<PipelineDefinitionValidateResult> => {
        assertServingAuthority(host, params.scope.authorityId);
        return (await host.load()).validate(params.document, params.targetId);
      },
    },
    instructions: {
      'core.pipeline.definition.upsert': (
        params,
        context,
      ): Promise<PipelineDefinitionUpsertResult> =>
        replayUpsert(context, params, async () => {
          assertServingAuthority(host, params.scope.authorityId);
          return {
            definition: await (
              await host.load()
            ).upsert(
              params,
              context.signal,
              params.definitionId === null
                ? createReplay('core.pipeline.definition.upsert', context)
                : undefined,
            ),
          };
        }),
      'core.pipeline.definition.delete': (
        params,
        context,
      ): Promise<PipelineDefinitionDeleteResult> =>
        replayDelete(context, params, async () => {
          return (await host.load()).delete(params, context.signal);
        }),
      'core.pipeline.definition.duplicate': (
        params,
        context,
      ): Promise<PipelineDefinitionDuplicateResult> =>
        replayDuplicate(context, params, async () => {
          assertServingAuthority(host, params.scope.authorityId);
          return (await host.load()).duplicate(
            params,
            context.signal,
            createReplay('core.pipeline.definition.duplicate', context),
          );
        }),
      'core.pipeline.definition.import': (
        params,
        context,
      ): Promise<PipelineDefinitionImportResult> =>
        replayImport(context, params, async () => {
          assertServingAuthority(host, params.targetScope.authorityId);
          return (await host.load()).import(params, context.signal);
        }),
      'core.pipeline.definition.setEnabled': (
        params,
        context,
      ): Promise<PipelineDefinitionSetEnabledResult> =>
        replaySetEnabled(context, params, async () => {
          const result = await (await host.load()).setEnabled(params);
          // Stored with this write's own receipt.
          ledger.supersedeEnablement(params.definitionId);
          return result;
        }),
    },
  };
}
