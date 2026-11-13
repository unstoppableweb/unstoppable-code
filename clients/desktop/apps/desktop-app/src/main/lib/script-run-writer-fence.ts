import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import type {
  ScriptRunWriter,
  ScriptRunWriterFence,
  ScriptRunWriterState,
} from '@canopy/core-runtime/node/script/execution';
import type { PlatformSupervisionServices } from '@canopy/core-runtime';
import { selectWindowsProcessPath } from '../canopy-runtime/electron-daemon-host';

let supervision: PlatformSupervisionServices | undefined;

function getSupervision(): PlatformSupervisionServices {
  if (supervision) return supervision;
  const os = hostPlatformOperatingSystem();
  const windowsProcessPath =
    os === 'win32' ? selectWindowsProcessPath({}) : undefined;
  supervision = hostPlatformServices(createPlatformEndpointServices(os), {
    ...(windowsProcessPath && { windowsProcessPath }),
  }).supervision;
  return supervision;
}

/** Electron main's run-log writer fence, over the host's process inspector (as `pipelines/pipeline-owner-fence.ts`). */
export const desktopScriptRunWriterFence: ScriptRunWriterFence = {
  async self(): Promise<ScriptRunWriter | null> {
    const found = await getSupervision().inspectProcess({ pid: process.pid });
    return found.state === 'running'
      ? { pid: process.pid, startIdentity: found.startIdentity }
      : null;
  },
  async inspect(writer: ScriptRunWriter): Promise<ScriptRunWriterState> {
    try {
      const found = await getSupervision().inspectProcess({ pid: writer.pid });
      if (found.state === 'running')
        return found.startIdentity === writer.startIdentity
          ? 'running'
          : 'gone';
      return found.state === 'absent' ? 'gone' : 'unverifiable';
    } catch {
      return 'unverifiable';
    }
  },
};
