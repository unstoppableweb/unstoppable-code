import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { BRAND } from '@canopy/brand/current';
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
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { getDefaultShellTypeForCurrentProcess } from '@canopy/execution-engine/node/pipelines/default-shell';
import {
  findLocalInstallReceipt,
  RESOURCE_INSTALL_RECEIPTS_FILE_NAME,
} from '../resource-install-receipts-read';

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

const ORGANIZATION_COPY_REFUSAL = `This workflow came from an organization. Change it in the ${BRAND.displayName} app.`;

/**
 * Refuses to change, delete or copy a definition installed from an
 * organization's share (CAN-7526). The desktop re-checks the share and the
 * workspace's policy before such a write; this host can do neither, so it
 * fails closed, also when the receipts can't be read.
 */
function refuseOrganizationCopies(
  writer: PipelineDefinitionWritePort,
): PipelineDefinitionWritePort {
  const assertNotOrganizationCopy = async (
    definitionId: string,
  ): Promise<void> => {
    let installed: Awaited<ReturnType<typeof findLocalInstallReceipt>>;
    try {
      installed = await findLocalInstallReceipt(
        join(getCanopyDataDir(), RESOURCE_INSTALL_RECEIPTS_FILE_NAME),
        'pipelines',
        definitionId,
      );
    } catch (error) {
      throw new PipelineDefinitionSourceError(
        'core.pipeline.contextMismatch',
        ORGANIZATION_COPY_REFUSAL,
        error,
      );
    }
    if (installed?.receipt.ownerContext.kind === 'organization')
      throw new PipelineDefinitionSourceError(
        'core.pipeline.contextMismatch',
        ORGANIZATION_COPY_REFUSAL,
      );
  };
  return {
    upsert: async (write, context) => {
      if (write.definitionId !== null)
        await assertNotOrganizationCopy(write.definitionId);
      return writer.upsert(write, context);
    },
    copy: async (copy, context) => {
      if (copy.origin.source === 'user')
        await assertNotOrganizationCopy(copy.origin.definitionId);
      return writer.copy(copy, context);
    },
    revision: (definitionId) => writer.revision(definitionId),
    delete: async (definitionId, expectedRevision, context) => {
      await assertNotOrganizationCopy(definitionId);
      return writer.delete(definitionId, expectedRevision, context);
    },
  };
}

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
    writer: refuseOrganizationCopies(createStoredPipelineDefinitionWriter()),
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
