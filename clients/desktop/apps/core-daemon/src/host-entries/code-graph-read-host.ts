import { dirname, join } from 'node:path';
import { connectExecutionHostChannel } from '@canopy/core-platform/execution-host/channel';
import { installCodeGraphResourcesDirResolver } from '@canopy/code-graph/resources';
import { serveCodeGraphReads } from '@canopy/code-graph/host/read-host';

const channel = connectExecutionHostChannel();
if (!channel) throw new Error('Launched without an execution host channel.');
// The launcher passes the staged runtime it resolved; the single executable
// stages it beside itself.
installCodeGraphResourcesDirResolver(
  () =>
    process.env.CANOPY_CODE_GRAPH_RESOURCES_DIR?.trim() ||
    join(dirname(process.execPath), 'resources', 'code-graph'),
);
serveCodeGraphReads(channel);
