import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { configureClaudeProcessRegistry } from '@canopy/execution-engine/node/agent-host/process/claude-process-registry';
import { getClaudeProcessPidsFilePath } from '../lib/paths';

// The registry moved to the execution engine (CAN-6995); Electron main keeps its PID file here.
configureClaudeProcessRegistry({
  store: {
    read: () => readFile(getClaudeProcessPidsFilePath(), 'utf8'),
    write: async (text) => {
      const filePath = getClaudeProcessPidsFilePath();
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, text, 'utf8');
    },
  },
});

export * from '@canopy/execution-engine/node/agent-host/process/claude-process-registry';
