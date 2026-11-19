import { dirname, join } from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { connectExecutionHostChannel } from '@canopy/core-platform/execution-host/channel';
import { installCodeGraphResourcesDirResolver } from '@canopy/code-graph/resources';
import { serveCodeGraphBuildHost } from '@canopy/code-graph/host/build-host';

const channel = connectExecutionHostChannel();
if (!channel) throw new Error('Launched without an execution host channel.');
// The launcher passes the staged runtime it resolved; the single executable
// stages it beside itself.
installCodeGraphResourcesDirResolver(
  () =>
    process.env.CANOPY_CODE_GRAPH_RESOURCES_DIR?.trim() ||
    join(dirname(process.execPath), 'resources', 'code-graph'),
);
serveCodeGraphBuildHost(channel, {
  openFilesBlockReplacement: hostOperatingSystem() === 'win32',
  flushRequiresWriteHandle: hostOperatingSystem() === 'win32',
  // The launcher passes the Git it selected in the host's environment.
  gitExecutable: process.env.CANOPY_GIT_EXECUTABLE?.trim() || 'git',
});
