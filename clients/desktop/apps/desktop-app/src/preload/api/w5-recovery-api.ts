import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  W5RecoveryStatusSchema,
  type W5RecoveryApi,
  type W5RecoveryStatus,
} from '@canopy/protocol/remote-control/shell';

export function createW5RecoveryApi(ipc: {
  invoke(channel: string): Promise<unknown>;
}): W5RecoveryApi {
  const read = async (channel: string): Promise<W5RecoveryStatus> =>
    W5RecoveryStatusSchema.parse(await ipc.invoke(channel));
  return {
    getStatus: () => read(IPC_CHANNELS.w5RecoveryStatus),
    prepare: () => read(IPC_CHANNELS.w5RecoveryPrepare),
  };
}
