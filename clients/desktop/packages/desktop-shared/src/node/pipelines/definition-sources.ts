import { randomUUID } from 'node:crypto';
import {
  createCanopyDispatcher,
  createInProcessCanopyClient,
  type InProcessCanopyClient,
} from '@canopy/core-runtime';
import {
  createCorePipelineDefinitionHandlers,
  createPipelineDefinitionService,
  PipelineDefinitionSourceError,
  type PipelineDefinitionServiceOptions,
  type PipelineDefinitionSourceDocument,
  type PipelineDefinitionSourceEntry,
  type PipelineDefinitionSourcePort,
  type PipelineDefinitionWritePort,
} from '@canopy/core-runtime/node/pipeline';
import {
  PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS,
  PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  PIPELINE_GRANTS,
} from '@canopy/protocol/canopy-core';
import type {
  PipelineIndexEntry,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import {
  removeStoredPipeline,
  writeStoredPipeline,
  type StoredPipelineWriteResult,
  listStoredPipelines,
  readStoredPipelineDocument,
  readStoredPipelineRevision,
  saveStoredPipeline,
} from '@canopy/execution-engine/pipelines/store';
import { getDefaultShellTypeForCurrentProcess } from '@canopy/execution-engine/node/pipelines/default-shell';

export interface StoredPipelineDefinitionPortOptions {
  /** A user definition's saved local owner; `null` when it has none. */
  owner?(definitionId: string): string | null;
}

function isoTimestamp(value: string | undefined): string | null {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function storedEntry(
  entry: PipelineIndexEntry,
  source: 'user' | 'bundled',
  options: StoredPipelineDefinitionPortOptions,
  owner: () => string | null = (): string | null =>
    source === 'user' ? (options.owner?.(entry.id) ?? null) : null,
): PipelineDefinitionSourceEntry {
  return {
    source,
    definitionId: entry.id,
    name: entry.name,
    description: entry.description ?? '',
    icon: entry.icon ?? '',
    readonly: source === 'bundled',
    revision: entry.revision ?? 0,
    owner: owner(),
    createdAt: isoTimestamp(entry.createdAt),
    updatedAt: isoTimestamp(entry.updatedAt),
    ...(entry.triggerTypes ? { triggerTypes: entry.triggerTypes } : {}),
    ...(entry.scopes ? { executionScopes: entry.scopes } : {}),
  };
}

function storedSource(info: PipelineInfo): 'user' | 'bundled' | null {
  return info.source === 'user' || info.source === 'bundled'
    ? info.source
    : null;
}

/**
 * The bundled and user definitions of the local pipeline store. The store
 * stays their reader and writer; core resolves and validates through this.
 */
export function createStoredPipelineDefinitionPort(
  options: StoredPipelineDefinitionPortOptions = {},
): PipelineDefinitionSourcePort {
  return {
    sources: ['bundled', 'user'],
    list: (context): Promise<readonly PipelineDefinitionSourceEntry[]> => {
      const listed = listStoredPipelines();
      if (!listed.success || !listed.data)
        return Promise.reject(
          new PipelineDefinitionSourceError(
            'core.pipeline.sourceUnavailable',
            listed.error || 'Failed to list pipelines',
          ),
        );
      return Promise.resolve(
        listed.data.flatMap((info) => {
          const source = storedSource(info);
          return source && context.sources.includes(source)
            ? [storedEntry(info, source, options)]
            : [];
        }),
      );
    },
    read: (
      source,
      definitionId,
    ): Promise<PipelineDefinitionSourceDocument | null> => {
      if (source !== 'user' && source !== 'bundled')
        return Promise.resolve(null);
      const read = readStoredPipelineDocument(definitionId, source);
      if (read.kind === 'missing') return Promise.resolve(null);
      if (read.kind === 'unreadable')
        return Promise.reject(
          new PipelineDefinitionSourceError(
            'core.pipeline.definitionUnreadable',
            read.message,
          ),
        );
      return Promise.resolve({
        ...storedEntry(read.entry, read.source, options),
        format: 'yaml',
        text: read.rawContent,
      });
    },
  };
}

/**
 * The stored revision of a user definition, refusing a bundled or unknown
 * id and a stale expected revision with the store's messages.
 */
function storedRevision(
  definitionId: string,
  expectedRevision: number | null,
  verb: 'update' | 'delete',
): number {
  const stored = readStoredPipelineRevision(definitionId);
  if (stored === null)
    throw new PipelineDefinitionSourceError(
      'core.pipeline.definitionNotFound',
      `Workflow not found: ${definitionId}`,
    );
  if (stored.source === 'bundled')
    throw new PipelineDefinitionSourceError(
      'core.pipeline.definitionReadOnly',
      `Cannot ${verb} bundled workflow: ${definitionId}`,
    );
  if (expectedRevision !== null && expectedRevision !== stored.revision)
    throw new PipelineDefinitionSourceError(
      'core.pipeline.revisionConflict',
      `Workflow changed since it was loaded: ${definitionId}`,
    );
  return stored.revision;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function storeFailure(error: string | undefined, fallback: string): Error {
  return new PipelineDefinitionSourceError(
    'core.pipeline.sourceUnavailable',
    error || fallback,
  );
}

function refusalError(
  result: Extract<StoredPipelineWriteResult<unknown>, { ok: false }>,
): Error {
  const code =
    result.reason === 'revision_conflict'
      ? 'core.pipeline.revisionConflict'
      : result.reason === 'not_found'
        ? 'core.pipeline.definitionNotFound'
        : result.reason === 'read_only'
          ? 'core.pipeline.definitionReadOnly'
          : 'core.pipeline.sourceUnavailable';
  return new PipelineDefinitionSourceError(code, result.message);
}

/**
 * Writes the user definitions of the local pipeline store, which stays their
 * writer. Each expected revision is checked under the cross-process writer
 * lock against the fresh index before the write.
 */
export function createStoredPipelineDefinitionWriter(
  options: StoredPipelineDefinitionPortOptions = {},
): PipelineDefinitionWritePort {
  return {
    upsert: (write): Promise<PipelineDefinitionSourceDocument> => {
      try {
        // Read the owner before saving, so a failure here writes nothing.
        // A new definition has none until its caller records it.
        let owner: string | null = null;
        if (write.definitionId !== null) {
          storedRevision(write.definitionId, write.expectedRevision, 'update');
          owner = options.owner?.(write.definitionId) ?? null;
        }
        const saved = writeStoredPipeline(
          {
            ...(write.definitionId === null ? {} : { id: write.definitionId }),
            name: write.name,
            description: write.description,
            icon: write.icon,
            content: write.pipeline,
            rawContent: write.text,
          },
          write.definitionId === null
            ? {}
            : {
                expectedRevision: write.expectedRevision,
                requireExisting: true,
              },
        );
        if (!saved.ok) throw refusalError(saved);
        // The save committed: answer from its entry and the bytes written,
        // so nothing after it can fail the request.
        return Promise.resolve({
          ...storedEntry(saved.value, 'user', options, () => owner),
          format: 'yaml',
          text: write.text,
        });
      } catch (error) {
        return Promise.reject(asError(error));
      }
    },
    copy: (copy): Promise<PipelineDefinitionSourceDocument> => {
      try {
        // A stored copy keeps the curated catalog entry its source came from.
        const curatedOrigin =
          copy.origin.source === 'user' || copy.origin.source === 'bundled'
            ? listStoredPipelines().data?.find(
                (info) => info.id === copy.origin.definitionId,
              )?.curatedOrigin
            : undefined;
        const saved = saveStoredPipeline(
          {
            name: copy.name,
            description: copy.description,
            icon: copy.icon,
            content: copy.pipeline,
            rawContent: copy.text,
            ...(curatedOrigin ? { curatedOrigin } : {}),
          },
          { id: copy.definitionId },
        );
        if (!saved.success || !saved.data)
          throw storeFailure(saved.error, 'Failed to copy the workflow');
        return Promise.resolve({
          ...storedEntry(saved.data, 'user', options, () => null),
          format: 'yaml',
          text: copy.text,
        });
      } catch (error) {
        return Promise.reject(asError(error));
      }
    },
    revision: (definitionId): Promise<number | null> => {
      try {
        const stored = readStoredPipelineRevision(definitionId);
        return Promise.resolve(
          stored?.source === 'user' ? stored.revision : null,
        );
      } catch (error) {
        return Promise.reject(asError(error));
      }
    },
    delete: (definitionId, expectedRevision): Promise<number> => {
      try {
        storedRevision(definitionId, expectedRevision, 'delete');
        const deleted = removeStoredPipeline(definitionId, {
          expectedRevision,
        });
        if (!deleted.ok) throw refusalError(deleted);
        return Promise.resolve(deleted.value.revision);
      } catch (error) {
        return Promise.reject(asError(error));
      }
    },
  };
}

/** The local host's normalization inputs, such as its default shell. */
export function localPipelineNormalizeOptions(): ReturnType<
  NonNullable<PipelineDefinitionServiceOptions['normalizeOptions']>
> {
  return { defaultShell: getDefaultShellTypeForCurrentProcess() };
}

export type LocalPipelineDefinitionClient = InProcessCanopyClient<
  typeof PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  typeof PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS
>;

/**
 * Core pipeline definitions over the local store, in process, for a host
 * without the desktop dispatcher, such as the CLI. It serves the bundled and
 * user sources and writes the user one; project, curated and shared
 * definitions need the desktop, as do saved owners and enablement.
 */
export function createLocalPipelineDefinitionClient(input: {
  interfaceKind: 'cli' | 'test';
  /** The local data root's authority, which the desktop serves too. */
  authorityId?: string;
}): LocalPipelineDefinitionClient {
  const authorityId = input.authorityId ?? 'local-desktop';
  const service = createPipelineDefinitionService({
    ports: [createStoredPipelineDefinitionPort()],
    writer: createStoredPipelineDefinitionWriter(),
    normalizeOptions: localPipelineNormalizeOptions,
  });
  const handlers = createCorePipelineDefinitionHandlers({
    authorityId,
    load: () => Promise.resolve(service),
  });
  const dispatcher = createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: PIPELINE_DEFINITION_QUERY_DEFINITIONS,
      instructions: PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: {
      queries: handlers.queries,
      instructions: handlers.instructions,
      streams: {},
    },
  });
  return createInProcessCanopyClient(dispatcher, {
    principalId: 'local-user',
    clientInstanceId: randomUUID(),
    authorityId,
    interfaceKind: input.interfaceKind,
    grants: [PIPELINE_GRANTS.read, PIPELINE_GRANTS.write],
  });
}
