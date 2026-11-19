import { connectExecutionHostChannel } from '@canopy/core-platform/execution-host/channel';
import { serveProviderProcessHost } from '@canopy/execution-engine/node/agent-host/process/provider-process-host/host';

const channel = connectExecutionHostChannel();
if (channel) serveProviderProcessHost(channel);
