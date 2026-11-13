import type {
  IPCResult,
  PipelineData,
  PipelineInfo,
  PipelineLookupRequest,
  SharedPipelineDetail,
  SharedPipelineGetRequest,
} from '@canopy/execution-engine/types/pipeline';
import type { AutomationsApi, CanopyApi } from '../../types';

/**
 * What reading an automation's workflow for a share goes through. The
 * renderer passes its preload APIs; Electron main passes the owners those
 * APIs reach (CAN-6003), so both read the same way.
 */
export interface PipelineReadPort {
  pipelines: {
    list(): Promise<IPCResult<PipelineInfo[]>>;
    get(request: PipelineLookupRequest): Promise<IPCResult<PipelineData>>;
    getShared(
      request: SharedPipelineGetRequest,
    ): Promise<IPCResult<SharedPipelineDetail>>;
    discoverProject(cwd: string): Promise<IPCResult<PipelineInfo[]>>;
  };
  api: Pick<
    CanopyApi,
    'getWorktreePath' | 'loadProjects' | 'getWorkspaceSettingsData'
  > & {
    automations: Pick<AutomationsApi, 'resolveSharedPipelineInstallPin'>;
  };
}

/** A function's parameters after the port, for callers that bind one. */
export type AfterReadPort<T extends unknown[]> = T extends [
  PipelineReadPort,
  ...infer Rest,
]
  ? Rest
  : never;
