import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type { W5RecoveryStatus } from '@canopy/protocol/remote-control/shell';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { getDesktopW5RecoveryController } from '../canopy-runtime/desktop-w5-recovery';
import { registerIpcHandler } from './register';

export function registerW5RecoveryHandlers(
  resolveCaller: (event: IpcMainInvokeEvent) => CanopyCallerDescriptor,
  hasUnsavedChanges: () => boolean,
): void {
  registerIpcHandler<[], W5RecoveryStatus>(
    IPC_CHANNELS.w5RecoveryStatus,
    (event) => {
      resolveCaller(event);
      return getDesktopW5RecoveryController().status();
    },
  );
  registerIpcHandler<[], W5RecoveryStatus>(
    IPC_CHANNELS.w5RecoveryPrepare,
    (event) => {
      const caller = resolveCaller(event);
      if (caller.principalId !== 'local-desktop-user')
        throw new Error('Recovery must start on this computer.');
      if (hasUnsavedChanges())
        return {
          ...getDesktopW5RecoveryController().peek(),
          state: 'refused',
          reason: 'unsaved-changes',
          canRecover: false,
        };
      return getDesktopW5RecoveryController().prepare();
    },
  );
}
