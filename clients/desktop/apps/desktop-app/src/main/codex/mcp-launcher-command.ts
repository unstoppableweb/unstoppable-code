import { join, resolve } from 'node:path';
import { app } from 'electron';
import { BRAND } from '@canopy/brand/current';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import type { CodexMcpLauncherCommand } from '@canopy/execution-engine/node/codex-runtime';
import { daemonName } from '@canopy/protocol/brand';
import { getBundledBinDir } from '@canopy/execution-engine/pipelines/config-paths';

/**
 * The daemon executable, run in its hidden launcher mode (CAN-4117). Same
 * path rule as the daemon host (canopy-runtime/electron-daemon-host.ts).
 */
export function resolveDesktopCodexMcpLauncher(): CodexMcpLauncherCommand {
  const name = `${daemonName(BRAND)}${hostPlatformOperatingSystem() === 'win32' ? '.exe' : ''}`;
  return {
    command: app.isPackaged
      ? join(getBundledBinDir(), name)
      : resolve('dist/core-daemon', name),
    args: [],
  };
}
