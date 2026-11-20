import { connectExecutionHostChannel } from '@canopy/core-platform/execution-host/channel';
import {
  configureClaudeProcessHostWorker,
  serveClaudeProcessHost,
} from '@canopy/execution-engine/node/agent-host/process/claude-process-host-worker';
import { killChildProcessGroup } from '../lib/process-kill';

// The utility process entry (CAN-4116). The host body moved to the execution engine (CAN-6995); this entry binds Electron main's process-group kill and serves.
configureClaudeProcessHostWorker({ killChildProcessGroup });

export * from '@canopy/execution-engine/node/agent-host/process/claude-process-host-worker';

const channel = connectExecutionHostChannel();
if (channel) serveClaudeProcessHost(channel);
