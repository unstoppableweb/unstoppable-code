import { connectExecutionHostChannel } from '@canopy/core-platform/execution-host/channel';
import { serveCodeGraphFingerprintHost } from '@canopy/code-graph/host/fingerprint-host';

const channel = connectExecutionHostChannel();
if (!channel) throw new Error('Launched without an execution host channel.');
serveCodeGraphFingerprintHost(channel, {
  // The launcher passes the Git it selected in the host's environment.
  gitExecutable: process.env.CANOPY_GIT_EXECUTABLE?.trim() || 'git',
});
