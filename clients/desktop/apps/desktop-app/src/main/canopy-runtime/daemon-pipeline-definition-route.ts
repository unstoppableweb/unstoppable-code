import type {
  CanopyClientInstructionOptions,
  CanopyClientQueryOptions,
} from '@canopy/core-client';
import { CanopyOperationError } from '@canopy/core-runtime';
import type {
  PipelineDefinitionDeleteParams,
  PipelineDefinitionDeleteResult,
  PipelineDefinitionDuplicateParams,
  PipelineDefinitionDuplicateResult,
  PipelineDefinitionGetParams,
  PipelineDefinitionGetResult,
  PipelineDefinitionListParams,
  PipelineDefinitionListResult,
  PipelineDefinitionQueryErrorCode,
  PipelineDefinitionSetEnabledParams,
  PipelineDefinitionSetEnabledResult,
  PipelineDefinitionUpsertParams,
  PipelineDefinitionUpsertResult,
  PipelineDefinitionValidateParams,
  PipelineDefinitionValidateResult,
} from '@canopy/protocol/canopy-core';
import type { ElectronDaemonClient } from './electron-daemon-host';

/*
 * `core.pipeline.definition.*` over a daemon session (CAN-5092 S1b).
 * Unselected: no production caller uses it, and it never opens, leases or
 * starts a daemon. A daemon that does not serve the definitions refuses each
 * call capability_unavailable before the wire; no call falls back to
 * Electron main's definitions. It carries no presentation, enablement
 * commit or agent place, which main's dispatch passes in process.
 */

type DefinitionClient = Pick<ElectronDaemonClient, 'query' | 'instruction'>;

export interface DaemonPipelineDefinitionRouteOptions {
  /** An established session's client, or null; read at each call. */
  readonly client: () => DefinitionClient | null;
}

export interface DaemonPipelineDefinitionRoute {
  list(
    params: PipelineDefinitionListParams,
    options?: CanopyClientQueryOptions,
  ): Promise<PipelineDefinitionListResult>;
  get(
    params: PipelineDefinitionGetParams,
    options?: CanopyClientQueryOptions,
  ): Promise<PipelineDefinitionGetResult>;
  validate(
    params: PipelineDefinitionValidateParams,
    options?: CanopyClientQueryOptions,
  ): Promise<PipelineDefinitionValidateResult>;
  upsert(
    params: PipelineDefinitionUpsertParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<PipelineDefinitionUpsertResult>;
  delete(
    params: PipelineDefinitionDeleteParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<PipelineDefinitionDeleteResult>;
  duplicate(
    params: PipelineDefinitionDuplicateParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<PipelineDefinitionDuplicateResult>;
  setEnabled(
    params: PipelineDefinitionSetEnabledParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<PipelineDefinitionSetEnabledResult>;
}

function connected(
  options: DaemonPipelineDefinitionRouteOptions,
): DefinitionClient {
  const client = options.client();
  if (client) return client;
  const code: PipelineDefinitionQueryErrorCode =
    'core.pipeline.targetUnavailable';
  throw new CanopyOperationError({
    kind: 'unavailable',
    code,
    message: 'No daemon session is open.',
    retry: { kind: 'never' },
  });
}

export function createDaemonPipelineDefinitionRoute(
  options: DaemonPipelineDefinitionRouteOptions,
): DaemonPipelineDefinitionRoute {
  return {
    list: (params, callOptions) =>
      Promise.resolve().then(() =>
        connected(options).query(
          'core.pipeline.definition.list',
          params,
          callOptions,
        ),
      ),
    get: (params, callOptions) =>
      Promise.resolve().then(() =>
        connected(options).query(
          'core.pipeline.definition.get',
          params,
          callOptions,
        ),
      ),
    validate: (params, callOptions) =>
      Promise.resolve().then(() =>
        connected(options).query(
          'core.pipeline.definition.validate',
          params,
          callOptions,
        ),
      ),
    upsert: (params, callOptions) =>
      Promise.resolve().then(() =>
        connected(options).instruction(
          'core.pipeline.definition.upsert',
          params,
          callOptions,
        ),
      ),
    delete: (params, callOptions) =>
      Promise.resolve().then(() =>
        connected(options).instruction(
          'core.pipeline.definition.delete',
          params,
          callOptions,
        ),
      ),
    duplicate: (params, callOptions) =>
      Promise.resolve().then(() =>
        connected(options).instruction(
          'core.pipeline.definition.duplicate',
          params,
          callOptions,
        ),
      ),
    setEnabled: (params, callOptions) =>
      Promise.resolve().then(() =>
        connected(options).instruction(
          'core.pipeline.definition.setEnabled',
          params,
          callOptions,
        ),
      ),
  };
}
