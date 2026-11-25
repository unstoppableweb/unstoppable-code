import { createHash, randomUUID } from 'node:crypto';
import {
  PIPELINE_DEFINITION_IMPORT_GRANTS,
  PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS,
  PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  PIPELINE_GRANTS,
  type CanopyWorkspaceScope,
  type WorkerPipelineHostRequest,
  type WorkerPipelineOwnerResult,
} from '@canopy/protocol/canopy-core';
import {
  defineRuntimeModule,
  type RuntimeModule,
} from '../../kernel/runtime-profile-graph';
import { CanopyOperationError } from '../../runtime/errors';
import {
  assertStorageWriteAllowed,
  evaluateStorageWrite,
  STORAGE_OWNERSHIP,
  type StorageOwnershipRow,
} from '../../storage';
import {
  createCorePipelineDefinitionHandlers,
  type CorePipelineDefinitionHost,
  type PipelineDefinitionReplayStore,
} from './core-pipeline-definitions';
import {
  createPipelineDefinitionService,
  PipelineDefinitionSourceError,
  type PipelineDefinitionOwnerEffectsPort,
  type PipelineDefinitionOwnerWrite,
  type PipelineDefinitionService,
  type PipelineDefinitionServiceOptions,
  type PipelineDefinitionWritePort,
} from './definitions';
import { PipelineHostUnavailableError } from './execution/host-requests';
import type { PipelineOwnerChannel } from './execution/owner-channel';
import type { PipelineLocalMetadataStore } from './store/local-metadata';
import {
  createDurableReplayFileWriter,
  createPipelineDefinitionReplayStore,
  pipelineDefinitionReplaysPath,
  type PipelineDefinitionReplayFileWriter,
} from './replay-store';

/** Whether these rows let the daemon write the pipeline definitions. */
export function isDaemonPipelineDefinitionOwner(
  ownership: readonly StorageOwnershipRow[] = STORAGE_OWNERSHIP,
): boolean {
  return evaluateStorageWrite('pipeline_definitions', 'daemon', ownership)
    .allowed;
}

/** The principal and rows the store's writes claim and are decided by. */
export interface DaemonPipelineDefinitionWriter {
  readonly writer: 'daemon';
  readonly ownership: readonly StorageOwnershipRow[];
}

/** The definition sources a daemon serves, over the local store. */
export interface DaemonPipelineDefinitionSources {
  readonly ports: PipelineDefinitionServiceOptions['ports'];
  readonly writer: NonNullable<PipelineDefinitionServiceOptions['writer']>;
  readonly normalizeOptions?: PipelineDefinitionServiceOptions['normalizeOptions'];
  /** The canonical data root the store reads and writes. */
  readonly dataRoot: string;
}

/**
 * Loads the sources on the first call. The daemon carries no store, so
 * only a trusted composition supplies this (CAN-5092): it passes the
 * writer to the store, whose writes then claim it.
 */
export type DaemonPipelineDefinitionSourcesLoader = (
  writer: DaemonPipelineDefinitionWriter,
) => Promise<DaemonPipelineDefinitionSources>;

export interface DaemonPipelineDefinitionHostOptions {
  readonly dataRoot: string;
  readonly authorityId: string;
  /** Trusted composition only; defaults to the compiled ownership rows. */
  readonly ownership?: readonly StorageOwnershipRow[];
  readonly sources: DaemonPipelineDefinitionSourcesLoader;
  /** The host's platform directory flush, for the replay receipts' write. */
  readonly flushDirectory: (directoryPath: string) => Promise<unknown>;
  /** The replay receipts' atomic durable write; the portable one by default. */
  readonly writeReplays?: PipelineDefinitionReplayFileWriter;
  /**
   * The pipeline local metadata file under the data root, whose entry a
   * deleted user definition takes with it (CAN-7057). Trusted
   * composition only: the entry codec comes with it.
   */
  readonly localMetadata?: PipelineLocalMetadataStore<object>;
  /**
   * The owner channel (CAN-7522): with it, the owner checks each edit,
   * delete and copy before it commits and applies its effects, and
   * reconciles whenever it attaches.
   */
  readonly owner?: PipelineOwnerChannel;
}

/** The reserved scope the definitions' owner requests ride (CAN-7522). */
export const PIPELINE_DEFINITIONS_OWNER_SCOPE = 'core:pipeline-definitions';
/** How long the owner has to check a write before it is refused. */
export const PIPELINE_DEFINITION_PRECHECK_DEADLINE_MS = 10_000;
/** How long the owner has to apply a write's effects. */
export const PIPELINE_DEFINITION_EFFECTS_DEADLINE_MS = 30_000;

/**
 * No request was raised: no owner is subscribed, none serves the request, or
 * the scope is full. Nothing was written, so this is a definite refusal
 * (a not-applied mark, CAN-7522) that the same key may send again.
 */
function ownerNotAsked(cause: unknown): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'unavailable',
      code: 'core.pipeline.ownerUnavailable',
      message:
        'The app is not answering for workflow changes, so nothing was changed.',
      retry: { kind: 'same_idempotency_key' },
    },
    cause,
  );
}

/** A request the owner received but didn't answer in time: the write may be half done. */
function ownerUnavailable(cause: unknown): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'unavailable',
      code: 'core.pipeline.sourceUnavailable',
      message: 'The app did not answer for this workflow change.',
      retry: { kind: 'same_idempotency_key' },
    },
    cause,
  );
}

type DefinitionOwnerRequest = Extract<
  WorkerPipelineHostRequest['request'],
  { action: 'owner.definition.precheck' | 'owner.definition.effects' }
>;

/**
 * The owner's side of the daemon's definition writes (CAN-7522), raised over
 * the owner channel in the definitions' scope. A write's requests take ids
 * from its replay key, so a replayed request is the same request. An owner
 * that doesn't answer by the deadline, or doesn't serve these requests,
 * refuses the write as unavailable, to be sent again with the same key.
 */
export function createDaemonDefinitionOwnerEffects(
  channel: Pick<PipelineOwnerChannel, 'broker'>,
  deadlines: { readonly precheckMs?: number; readonly effectsMs?: number } = {},
): PipelineDefinitionOwnerEffectsPort {
  const precheckMs =
    deadlines.precheckMs ?? PIPELINE_DEFINITION_PRECHECK_DEADLINE_MS;
  const effectsMs =
    deadlines.effectsMs ?? PIPELINE_DEFINITION_EFFECTS_DEADLINE_MS;
  const raise = async (
    request: DefinitionOwnerRequest,
    requestId: string,
    deadlineMs: number,
    signal: AbortSignal,
  ): Promise<WorkerPipelineOwnerResult> => {
    let settlement: Awaited<
      ReturnType<PipelineOwnerChannel['broker']['raiseOwner']>
    >;
    try {
      settlement = await channel.broker.raiseOwner(
        {
          requestId,
          executionId: PIPELINE_DEFINITIONS_OWNER_SCOPE,
          jobId: '_run',
          stepId: '_run',
          childExecutionId: null,
          attempt: 0,
          iteration: 0,
          owner: null,
          deadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
          request,
        },
        AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]),
      );
    } catch (error) {
      // The broker refuses this way only before it raises anything.
      if (error instanceof PipelineHostUnavailableError)
        throw ownerNotAsked(error);
      throw ownerUnavailable(error);
    }
    if (settlement.result.status !== 'owner')
      throw ownerUnavailable(settlement.result);
    return settlement.result.value;
  };
  const idOf = (write: PipelineDefinitionOwnerWrite, phase: string): string =>
    createHash('sha256')
      .update(
        [
          'pipeline-definition-owner',
          write.op,
          write.definitionId ?? '',
          write.replayKey ?? randomUUID(),
          phase,
        ].join('\0'),
      )
      .digest('hex');
  return {
    async precheck(
      write: PipelineDefinitionOwnerWrite,
      scope: CanopyWorkspaceScope,
      signal: AbortSignal,
    ): Promise<void> {
      const value = await raise(
        {
          action: 'owner.definition.precheck',
          op: write.op,
          definitionId: write.op === 'duplicate' ? null : write.definitionId,
          ...(write.origin && { origin: write.origin }),
          scope: {
            ...(scope.workspaceId !== undefined && {
              workspaceId: scope.workspaceId,
            }),
            ...(scope.worktreeId !== undefined && {
              worktreeId: scope.worktreeId,
            }),
          },
        },
        idOf(write, 'precheck'),
        precheckMs,
        signal,
      );
      if (value.kind !== 'definition.precheck') throw ownerUnavailable(value);
      if (!value.answer.allowed)
        throw new PipelineDefinitionSourceError(
          value.answer.code === 'contextMismatch'
            ? 'core.pipeline.contextMismatch'
            : 'core.pipeline.definitionNotFound',
          value.answer.message,
        );
    },
    async effects(write, phase, signal): Promise<void> {
      await raise(
        {
          action: 'owner.definition.effects',
          op: write.op,
          phase,
          definitionId: write.definitionId,
          ...(write.op === 'duplicate' && write.origin
            ? { origin: write.origin }
            : {}),
        },
        idOf(write, phase),
        effectsMs,
        signal,
      );
    },
    async reconcile(signal): Promise<void> {
      await raise(
        {
          action: 'owner.definition.effects',
          op: 'reconcile',
          phase: 'reconcile',
          definitionId: null,
        },
        `pipeline-definition-reconcile-${randomUUID()}`,
        effectsMs,
        signal,
      );
    },
  };
}

function notOwned(cause: unknown): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'unavailable',
      code: 'core.pipeline.sourceUnavailable',
      message: 'This daemon does not own workflow definitions.',
      retry: { kind: 'never' },
    },
    cause,
  );
}

function otherRoot(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'unavailable',
    code: 'core.pipeline.sourceUnavailable',
    message:
      "The workflow store serves another data directory than the daemon's.",
    retry: { kind: 'never' },
  });
}

export interface DaemonDefinitionSidecarOptions {
  readonly localMetadata: PipelineLocalMetadataStore<object>;
  /** Trusted composition only; defaults to the compiled ownership rows. */
  readonly ownership?: readonly StorageOwnershipRow[];
}

/**
 * The daemon's definitions writer with the sidecar effects Electron main's
 * writer applies (CAN-7057): a deleted user definition takes its local
 * metadata entry with it. The metadata file has its own row, so a delete
 * runs only where both pipeline_definitions and pipeline_local_metadata name
 * the daemon, and is refused before anything is written where they don't.
 */
export function createDaemonDefinitionSidecarWriter(
  writer: PipelineDefinitionWritePort,
  options: DaemonDefinitionSidecarOptions,
): PipelineDefinitionWritePort {
  const ownership = options.ownership ?? STORAGE_OWNERSHIP;
  const assertSidecarOwner = (): void => {
    try {
      assertStorageWriteAllowed('pipeline_definitions', 'daemon', ownership);
      assertStorageWriteAllowed('pipeline_local_metadata', 'daemon', ownership);
    } catch (error) {
      throw notOwned(error);
    }
  };
  return {
    upsert: (write, context) => writer.upsert(write, context),
    copy: (copy, context) => writer.copy(copy, context),
    revision: (definitionId) => writer.revision(definitionId),
    delete: async (definitionId, expectedRevision, context) => {
      assertSidecarOwner();
      const revision = await writer.delete(
        definitionId,
        expectedRevision,
        context,
      );
      options.localMetadata.deleteUserPipeline(definitionId);
      return revision;
    },
  };
}

/**
 * The daemon's definitions host (CAN-5092 S1b): the bundled and user sources
 * the loader supplies, written as the daemon, and replay receipts under the
 * data root. Every call first checks that the rows make the daemon the
 * definitions' writer, and every receipt read or write that they also make
 * it pipeline_definition_replays' writer, so a mis-gated composition answers
 * unavailable and never loads the sources, reads the receipts or touches the
 * store. A store
 * over another data root than the daemon's is refused the same way, as is a
 * composition with a project source unless the rows also make the daemon
 * pipeline_project_share_links' writer; that refusal comes after the loader
 * and before any service exists. Without an enablement writer, setEnabled
 * answers sourceUnavailable.
 */
export function createDaemonPipelineDefinitionHost(
  options: DaemonPipelineDefinitionHostOptions,
): CorePipelineDefinitionHost {
  const ownership = options.ownership ?? STORAGE_OWNERSHIP;
  const assertOwner = (): void => {
    try {
      assertStorageWriteAllowed('pipeline_definitions', 'daemon', ownership);
    } catch (error) {
      throw notOwned(error);
    }
  };
  // The receipts file has its own row, so the daemon reads or writes it only
  // where both rows name it the writer.
  const assertReplayOwner = (): void => {
    assertOwner();
    try {
      assertStorageWriteAllowed(
        'pipeline_definition_replays',
        'daemon',
        ownership,
      );
    } catch (error) {
      throw notOwned(error);
    }
  };
  let service: Promise<PipelineDefinitionService> | undefined;
  const ownerEffects =
    options.owner && createDaemonDefinitionOwnerEffects(options.owner);
  const receipts = createPipelineDefinitionReplayStore({
    filePath: () => pipelineDefinitionReplaysPath(options.dataRoot),
    write:
      options.writeReplays ??
      createDurableReplayFileWriter(options.flushDirectory),
  });
  const replays: PipelineDefinitionReplayStore = {
    load: () =>
      Promise.resolve()
        .then(assertReplayOwner)
        .then(() => receipts.load()),
    save: (ledger) =>
      Promise.resolve()
        .then(assertReplayOwner)
        .then(() => receipts.save(ledger)),
  };
  const host: CorePipelineDefinitionHost = {
    authorityId: options.authorityId,
    replays,
    load: (): Promise<PipelineDefinitionService> =>
      Promise.resolve().then(() => {
        assertOwner();
        service ??= options
          .sources({ writer: 'daemon', ownership })
          .then((sources) => {
            if (sources.dataRoot !== options.dataRoot) throw otherRoot();
            // Project discovery rewrites the share-link catalog, its own row
            // (CAN-7058), so a project source needs that row too.
            if (sources.ports.some((port) => port.sources.includes('project')))
              try {
                assertStorageWriteAllowed(
                  'pipeline_project_share_links',
                  'daemon',
                  ownership,
                );
              } catch (error) {
                throw notOwned(error);
              }
            return createPipelineDefinitionService({
              ports: sources.ports,
              writer: options.localMetadata
                ? createDaemonDefinitionSidecarWriter(sources.writer, {
                    localMetadata: options.localMetadata,
                    ownership,
                  })
                : sources.writer,
              ...(sources.normalizeOptions && {
                normalizeOptions: sources.normalizeOptions,
              }),
              ...(ownerEffects && { ownerEffects }),
            });
          })
          .catch((error: unknown) => {
            service = undefined;
            throw error;
          });
        return service;
      }),
  };
  // Whenever an owner attaches, it reconciles what a write left half done,
  // in this run or a crashed one (CAN-7522).
  const reconcileOnAttach = (): void => {
    host
      .load()
      .then((loaded) =>
        loaded.reconcileOwnerEffects(new AbortController().signal),
      )
      .catch(() => undefined);
  };
  options.owner?.onOwnerChange((subscribed) => {
    if (subscribed) reconcileOnAttach();
  });
  // A subscription that replaces another never changes ownerSubscribed();
  // the pass runs once the replacement is current.
  options.owner?.onOwnerEpochEnd((replaced) => {
    if (replaced) reconcileOnAttach();
  });
  return host;
}

/** What a peer needs for the definitions where a daemon serves them. */
export const CORE_PIPELINE_DEFINITION_CALLER_GRANTS = [
  PIPELINE_GRANTS.read,
  PIPELINE_GRANTS.write,
] as const;

/**
 * What only the daemon's proven owner holds for the definitions (CAN-7523).
 * Owner proof alone grants the import: a deliberate, approved exception to the
 * rule that owner proof does not establish trust, until E1 (CAN-4729)
 * designates trusted connections and this grant moves to that designation. Sent
 * only over Electron main's owner connection; Portal and remote installs go
 * through main.
 */
export const CORE_PIPELINE_DEFINITION_OWNER_GRANTS =
  PIPELINE_DEFINITION_IMPORT_GRANTS;

const I = PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS;

/**
 * The definitions a daemon serves: the interface authority's operations,
 * and the import, which only its owner may call.
 */
export const DAEMON_PIPELINE_DEFINITION_DEFINITIONS = {
  queries: PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  instructions: {
    'core.pipeline.definition.import': I['core.pipeline.definition.import'],
    'core.pipeline.definition.upsert': I['core.pipeline.definition.upsert'],
    'core.pipeline.definition.delete': I['core.pipeline.definition.delete'],
    'core.pipeline.definition.duplicate':
      I['core.pipeline.definition.duplicate'],
    'core.pipeline.definition.setEnabled':
      I['core.pipeline.definition.setEnabled'],
  },
};

export const CORE_PIPELINE_DEFINITION_OPERATIONS: readonly string[] = [
  ...Object.keys(DAEMON_PIPELINE_DEFINITION_DEFINITIONS.queries),
  ...Object.keys(DAEMON_PIPELINE_DEFINITION_DEFINITIONS.instructions),
];

/** `core.pipeline.definition.*` over `host` as a graph module (CAN-5092). */
export function createCorePipelineDefinitionModule(
  host: CorePipelineDefinitionHost,
): RuntimeModule {
  const handlers = createCorePipelineDefinitionHandlers(host);
  const served = handlers.instructions;
  return defineRuntimeModule({
    name: 'core.pipeline.definition',
    plane: 'core',
    definitions: { ...DAEMON_PIPELINE_DEFINITION_DEFINITIONS, streams: {} },
    handlers: {
      queries: handlers.queries,
      instructions: {
        'core.pipeline.definition.import':
          served['core.pipeline.definition.import'],
        'core.pipeline.definition.upsert':
          served['core.pipeline.definition.upsert'],
        'core.pipeline.definition.delete':
          served['core.pipeline.definition.delete'],
        'core.pipeline.definition.duplicate':
          served['core.pipeline.definition.duplicate'],
        'core.pipeline.definition.setEnabled':
          served['core.pipeline.definition.setEnabled'],
      },
      streams: {},
    },
  });
}
