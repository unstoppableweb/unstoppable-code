import { randomUUID } from 'node:crypto';
import {
  createCanopyDispatcher,
  createInProcessCanopyClient,
  type InProcessCanopyClient,
} from '@canopy/core-runtime';
import {
  createCorePipelineDefinitionHandlers,
  createPipelineDefinitionService,
  type PipelineDefinitionServiceOptions,
  type PipelineDefinitionSourcePort,
  type PipelineDefinitionWritePort,
} from '@canopy/core-runtime/node/pipeline';
import {
  createStoredPipelineDefinitionPort as createPortableStoredPipelineDefinitionPort,
  createStoredPipelineDefinitionWriter as createPortableStoredPipelineDefinitionWriter,
  type StoredPipelineDefinitionPortOptions,
} from '@canopy/core-runtime/node/pipeline/store';
import {
  PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS,
  PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  PIPELINE_GRANTS,
} from '@canopy/protocol/canopy-core';
import { pipelineDefinitionStore } from '@canopy/execution-engine/pipelines/store';
import { getDefaultShellTypeForCurrentProcess } from '@canopy/execution-engine/node/pipelines/default-shell';

export type { StoredPipelineDefinitionPortOptions };

/**
 * The bundled and user definitions of the local pipeline store. The port and
 * its writer live with the store in core-runtime (CAN-5092); this binds them
 * to this process's store.
 */
export function createStoredPipelineDefinitionPort(
  options: StoredPipelineDefinitionPortOptions = {},
): PipelineDefinitionSourcePort {
  return createPortableStoredPipelineDefinitionPort(
    pipelineDefinitionStore,
    options,
  );
}

/** Writes the user definitions of this process's local pipeline store. */
export function createStoredPipelineDefinitionWriter(
  options: StoredPipelineDefinitionPortOptions = {},
): PipelineDefinitionWritePort {
  return createPortableStoredPipelineDefinitionWriter(
    pipelineDefinitionStore,
    options,
  );
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
