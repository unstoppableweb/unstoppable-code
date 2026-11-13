import { dirname, join } from 'node:path';
import {
  createPlatformEndpointServices,
  hostPlatformServices,
  WINDOWS_PROCESS_FILE,
} from '@canopy/core-platform';
import { connectExecutionHostChannel } from '@canopy/core-platform/execution-host/channel';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { servePipelineHost } from './server';

// The daemon's pipeline host (CAN-5086): desktop-shared's executor in its own
// owned process tree, so a step that crashes Node ends only this host.

const channel = connectExecutionHostChannel();
if (!channel) throw new Error('Launched without an execution host channel.');
const os = hostOperatingSystem();
if (os !== 'darwin' && os !== 'linux' && os !== 'win32')
  throw new Error('Daemon pipelines run on macOS, Linux and Windows only.');
// Windows proves an owner's start identity with the process helper staged
// beside the daemon executable this host runs as (CAN-5091). Without it the
// owner fence keeps its PID-liveness fallback.
const { supervision } = hostPlatformServices(
  createPlatformEndpointServices(os),
  os === 'win32'
    ? {
        windowsProcessPath: join(
          dirname(process.execPath),
          WINDOWS_PROCESS_FILE,
        ),
      }
    : {},
);
servePipelineHost({
  channel,
  inspectProcess: async (pid) => {
    const found = await supervision.inspectProcess({ pid });
    return found.state === 'running'
      ? { state: 'running', startIdentity: found.startIdentity }
      : { state: found.state };
  },
});
