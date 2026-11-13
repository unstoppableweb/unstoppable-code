import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import { configurePipelineOwnerFence } from '@canopy/execution-engine/node/pipelines/executor';
import { selectWindowsProcessPath } from '../canopy-runtime/electron-daemon-host';

/**
 * Fence pipeline orphan detection with process start identity (CAN-4140)
 * through the host's process inspector, the one the daemon claims use.
 */
export async function configureDesktopPipelineOwnerFence(): Promise<void> {
  const os = hostPlatformOperatingSystem();
  const windowsProcessPath =
    os === 'win32' ? selectWindowsProcessPath({}) : undefined;
  const { supervision } = hostPlatformServices(
    createPlatformEndpointServices(os),
    { ...(windowsProcessPath && { windowsProcessPath }) },
  );
  await configurePipelineOwnerFence(async (pid) => {
    const found = await supervision.inspectProcess({ pid });
    return found.state === 'running'
      ? { state: 'running', startIdentity: found.startIdentity }
      : { state: found.state };
  });
}
