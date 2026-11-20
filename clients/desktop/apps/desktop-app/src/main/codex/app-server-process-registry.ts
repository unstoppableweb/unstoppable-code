import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { configureCodexAppServerProcessRegistry } from '@canopy/execution-engine/node/agent-host/process/codex-app-server-process-registry';
import { getCodexAppServerPidsFilePath } from '../lib/paths';
import { killChildProcessGroup } from '../lib/process-kill';

// The registry moved to the execution engine (CAN-6995); Electron main keeps its PID file and process-group kill here.
configureCodexAppServerProcessRegistry({
  store: {
    read: () => readFile(getCodexAppServerPidsFilePath(), 'utf8'),
    write: async (text) => {
      const filePath = getCodexAppServerPidsFilePath();
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, text, 'utf8');
    },
  },
  killChildProcessGroup,
});

export * from '@canopy/execution-engine/node/agent-host/process/codex-app-server-process-registry';
