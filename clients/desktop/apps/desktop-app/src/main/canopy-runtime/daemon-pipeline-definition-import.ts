import type { CanopyClientInstructionOptions } from '@canopy/core-client';
import { CanopyOperationError } from '@canopy/core-runtime';
import type {
  PipelineDefinitionImportParams,
  PipelineDefinitionImportResult,
  PipelineDefinitionQueryErrorCode,
} from '@canopy/protocol/canopy-core';
import { isDaemonOwnerUnavailable } from './electron-daemon-owner';

/*
 * `core.pipeline.definition.import` over Electron main's daemon owner
 * connection (CAN-7523). Owner proof alone grants the import: a deliberate,
 * approved exception to the rule that owner proof does not establish trust,
 * until E1 (CAN-4729) designates trusted connections and this grant moves to
 * that designation. Sent only over Electron main's owner connection; Portal and
 * remote installs go through main.
 *
 * Unselected: no production caller uses it until the definitions move to the
 * daemon. A refusal is never applied in Electron main instead.
 */

/**
 * The one call the import makes on the owner session: what
 * `ElectronDaemonOwnerClient` carries and the leased peer client cannot.
 */
export interface DaemonPipelineOwnerImportClient {
  instruction(
    name: 'core.pipeline.definition.import',
    params: PipelineDefinitionImportParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<PipelineDefinitionImportResult>;
}

export interface DaemonPipelineDefinitionImportOptions {
  /** The owner session's client; read at each call. */
  readonly ownerClient: () => Promise<DaemonPipelineOwnerImportClient>;
}

export interface DaemonPipelineDefinitionImport {
  import(
    params: PipelineDefinitionImportParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<PipelineDefinitionImportResult>;
}

function ownerUnavailable(notOwner: boolean): CanopyOperationError {
  const code: PipelineDefinitionQueryErrorCode =
    'core.pipeline.targetUnavailable';
  return new CanopyOperationError({
    kind: 'unavailable',
    code,
    message: notOwner
      ? "This app is not the background service's owner."
      : 'No background service owner session is open.',
    // Nothing was sent: the same key is safe once a session opens, and
    // retrying cannot make this app the owner.
    retry: notOwner ? { kind: 'never' } : { kind: 'same_idempotency_key' },
  });
}

export function createDaemonPipelineDefinitionImport(
  options: DaemonPipelineDefinitionImportOptions,
): DaemonPipelineDefinitionImport {
  return {
    import: async (params, callOptions = {}) => {
      let client: DaemonPipelineOwnerImportClient;
      try {
        client = await options.ownerClient();
      } catch (error) {
        throw ownerUnavailable(isDaemonOwnerUnavailable(error));
      }
      return client.instruction(
        'core.pipeline.definition.import',
        params,
        callOptions,
      );
    },
  };
}
