// Registers the Activity panel handlers for the CAN-4103 goldens. The golden
// file mocks IPC registration; this module is the only part of the harness
// that follows the handlers' registration signature.
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { registerActivityPanelHandlers } from '../../ipc/activity-panel';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import type { DaemonGitRoute } from '../../canopy-runtime/daemon-git-route';

// The grants every desktop IPC caller carries (desktop-ipc-caller.ts); a
// bridge sender resolves to its remote device with the same grants.
const desktopCaller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [
    'worker.filesystem.read',
    'core.workspace.read',
    'core.chat.read',
    'core.chat.write',
    'core.worktree.read',
  ],
};
const remoteCaller: CanopyCallerDescriptor = {
  ...desktopCaller,
  principalId: 'remote-device:device-01',
};

export function registerActivityGoldenHandlers(
  daemonGitRoute?: DaemonGitRoute,
): {
  shutdown(this: void): Promise<void>;
} {
  const runtime = createDesktopRuntime();
  registerActivityPanelHandlers(() => null, {
    dispatcher: runtime,
    resolveCaller: (event): CanopyCallerDescriptor =>
      Reflect.get(event, 'remoteDeviceId') === undefined
        ? desktopCaller
        : remoteCaller,
    ...(daemonGitRoute && {
      daemonGitRoute: (): DaemonGitRoute => daemonGitRoute,
    }),
  });
  return { shutdown: () => runtime.shutdown() };
}
