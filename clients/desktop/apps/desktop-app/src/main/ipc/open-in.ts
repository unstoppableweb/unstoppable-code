import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { hasUnsafeDesktopArgument } from '../lib/linux-desktop-exec';
import { spawn } from 'node:child_process';
import {
  getEnhancedEnv,
  getLoginShellPath,
} from '@canopy/execution-engine/pipelines/config-paths';
import {
  APP_LAUNCH_NO_LONGER_AVAILABLE_MESSAGE,
  IPC_CHANNELS,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import type {
  OpenInAppRequest,
  GetWorktreePathRequest,
  ListWorktreeRepoEntriesRequest,
  WorktreeRepoEntryData,
} from '@canopy/desktop-shared/types';
import {
  detectInstalledApps,
  getDetectedAppLaunchSpec,
  refreshDetectedApps,
} from '../lib/app-detection';
import { getWorkspaceWorktreeRepoDir } from '../lib/paths';
import { assertWritableScope } from '../lib/read-only-scope';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { validateId } from '../lib/validation';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import { registerIpcHandler } from './register';

function launchVisibleApp(
  command: string,
  args: string[],
  cwd?: string,
  shell?: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const os = hostOperatingSystem();
    if (
      os === 'linux' &&
      (shell === true || [command, ...args].some(hasUnsafeDesktopArgument))
    ) {
      reject(new Error(APP_LAUNCH_NO_LONGER_AVAILABLE_MESSAGE));
      return;
    }
    // Independent GUI ownership: never register this child with terminal, script,
    // or provider cleanup. Detached POSIX groups survive parent quit; ignored
    // stdio and unref prevent a launched app from keeping Electron alive. Existing
    // worktree cleanup protects the current process's descendants by identity.
    const child = spawn(command, args, {
      ...(cwd ? { cwd } : {}),
      ...(os === 'linux'
        ? {
            env: {
              ...getEnhancedEnv({
                includeCanopySecrets: false,
                environment: false,
              }),
              // External applications use the same user PATH as discovery.
              PATH: getLoginShellPath(),
            },
          }
        : {}),
      detached: os === 'win32' || os === 'linux',
      shell: shell === true,
      stdio: 'ignore',
      windowsHide: false,
    });

    function settleOnce(): boolean {
      if (settled) {
        return false;
      }
      settled = true;
      return true;
    }

    child.once('spawn', () => {
      if (!settleOnce()) {
        return;
      }
      child.unref();
      resolve();
    });
    child.once('error', (error) => {
      if (!settleOnce()) {
        return;
      }
      reject(error);
    });
  });
}

/*
 * The window's calls as owners, so App Advisor's actions in Electron main
 * make the same ones (CAN-6003).
 */

export function getWorktreePathForCaller(
  request: GetWorktreePathRequest,
): ReturnType<typeof resolveWorktreeCwd> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  if (request.repoId && request.repoId !== WORKSPACE_ROOT_REPO_ID) {
    validateId(request.repoId, 'repoId');
    return getWorkspaceWorktreeRepoDir(
      request.projectId,
      request.worktreeId,
      request.repoId,
    );
  }
  return resolveWorktreeCwd(request.projectId, request.worktreeId);
}

export function registerOpenInHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.worktreeDetectApps, async () => {
    return detectInstalledApps();
  });

  registerIpcHandler(IPC_CHANNELS.worktreeRefreshDetectedApps, async () => {
    return refreshDetectedApps();
  });

  registerIpcHandler(
    IPC_CHANNELS.worktreeOpenIn,
    async (_event, request: OpenInAppRequest) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      assertWritableScope(request.projectId);

      const cwd = resolveWorktreeCwd(request.projectId, request.worktreeId);

      // The renderer relies on the exact wording of this message to drive its
      // "refresh the Applications settings" recovery flow when an app has been
      // uninstalled since detection ran. The shared constant lives in
      // `@canopy/desktop-shared/types`.
      const installedApps = await detectInstalledApps();
      if (!installedApps.some((app) => app.id === request.appId)) {
        throw new Error(APP_LAUNCH_NO_LONGER_AVAILABLE_MESSAGE);
      }

      const launchSpec = await getDetectedAppLaunchSpec(request.appId, cwd);
      if (!launchSpec) {
        throw new Error(APP_LAUNCH_NO_LONGER_AVAILABLE_MESSAGE);
      }

      await launchVisibleApp(
        launchSpec.command,
        launchSpec.args,
        launchSpec.cwd,
        launchSpec.shell,
      );
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeGetPath,
    (_event, request: GetWorktreePathRequest) =>
      getWorktreePathForCaller(request),
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeListRepoEntries,
    async (
      _event,
      request: ListWorktreeRepoEntriesRequest,
    ): Promise<WorktreeRepoEntryData[]> => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      const worktreePath = resolveWorktreeCwd(
        request.projectId,
        request.worktreeId,
      );
      return listWorkspaceWorktreeRepoEntries(request.projectId, worktreePath);
    },
  );
}
