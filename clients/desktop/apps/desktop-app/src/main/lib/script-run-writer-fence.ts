import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import {
  forceStopScriptRunGroup,
  listScriptRunGroup,
  scriptRunGroupRemains,
  stopScriptRunChild,
  type ScriptRunChildReap,
  type ScriptRunChildStop,
  type ScriptRunGroupListing,
  type ScriptRunGroupStop,
  type ScriptRunWriter,
  type ScriptRunWriterFence,
  type ScriptRunWriterState,
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
  /**
   * Never kills (CAN-6485 brings the proven reap to Electron main): it only
   * notices a recorded process the daemon left that has since exited, so its
   * orphaned run then reads lost (CAN-6482).
   */
  async reapChild(child): Promise<ScriptRunChildReap> {
    try {
      const found = await getSupervision().inspectProcess({ pid: child.pid });
      // Another start identity holds the PID: the recorded process ended.
      if (
        found.state === 'running' &&
        child.startIdentity !== undefined &&
        found.startIdentity !== child.startIdentity
      )
        return child.processGroupId !== undefined &&
          scriptRunGroupRemains(child.processGroupId)
          ? 'unproven'
          : 'gone';
      // A leader that exited while its recorded group lives on stays orphaned.
      return found.state === 'absent' &&
        (child.processGroupId === undefined ||
          !scriptRunGroupRemains(child.processGroupId))
        ? 'gone'
        : 'unproven';
    } catch {
      return 'unproven';
    }
  },
  /** A user's Stop of an orphaned run (CAN-6482 part 2), proven as the daemon proves it. */
  stopChild(child, mode): Promise<ScriptRunChildStop> {
    return stopScriptRunChild({ child, mode, supervision: getSupervision() });
  },
  /** An orphaned run's group members (CAN-6601), read as the daemon reads them. */
  listGroup(child, runStartedAtMs, runId): Promise<ScriptRunGroupListing> {
    return listScriptRunGroup({
      child,
      runStartedAtMs,
      runId,
      supervision: getSupervision(),
    });
  },
  /** A user's confirmed group Force stop (CAN-6601), proven as the daemon proves it. */
  stopGroup(
    child,
    runStartedAtMs,
    runId,
    members,
  ): Promise<ScriptRunGroupStop> {
    return forceStopScriptRunGroup({
      child,
      runStartedAtMs,
      runId,
      members,
      supervision: getSupervision(),
    });
  },
};
