import {
  PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS,
  PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  PIPELINE_GRANTS,
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
  type PipelineDefinitionService,
  type PipelineDefinitionServiceOptions,
} from './definitions';
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

/**
 * The daemon's definitions host (CAN-5092 S1b): the bundled and user sources
 * the loader supplies, written as the daemon, and replay receipts under the
 * data root. Every call first checks that the rows make the daemon the
 * definitions' writer, and every receipt read or write that they also make
 * it pipeline_definition_replays' writer, so a mis-gated composition answers
 * unavailable and never loads the sources, reads the receipts or touches the
 * store. A store
 * over another data root than the daemon's is refused the same way. Without
 * an enablement writer, setEnabled answers sourceUnavailable.
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
  return {
    authorityId: options.authorityId,
    replays,
    load: (): Promise<PipelineDefinitionService> =>
      Promise.resolve().then(() => {
        assertOwner();
        service ??= options
          .sources({ writer: 'daemon', ownership })
          .then((sources) => {
            if (sources.dataRoot !== options.dataRoot) throw otherRoot();
            return createPipelineDefinitionService({
              ports: sources.ports,
              writer: sources.writer,
              ...(sources.normalizeOptions && {
                normalizeOptions: sources.normalizeOptions,
              }),
            });
          })
          .catch((error: unknown) => {
            service = undefined;
            throw error;
          });
        return service;
      }),
  };
}

/** What a peer needs for the definitions where a daemon serves them. */
export const CORE_PIPELINE_DEFINITION_CALLER_GRANTS = [
  PIPELINE_GRANTS.read,
  PIPELINE_GRANTS.write,
] as const;

const I = PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS;

/**
 * The definitions a daemon serves: the interface authority's operations,
 * without import, which no interface may call.
 */
export const DAEMON_PIPELINE_DEFINITION_DEFINITIONS = {
  queries: PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  instructions: {
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
