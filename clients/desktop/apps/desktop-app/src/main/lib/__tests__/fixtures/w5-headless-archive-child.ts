import { join } from 'node:path';
import { registerW5Host } from '@canopy/execution-engine/node/w5-host-cohort';
import {
  withW5ProcessFileLocks,
  W5ProcessFileLockTimeoutError,
} from '@canopy/core-platform/w5-process-file-lock';
import { archiveSingleRepoWorktree } from '@canopy/desktop-shared/node/lib/worktree-service';
const [root = ''] = process.argv.slice(2);
process.env.CANOPY_DATA_DIR = root;
void (async (): Promise<void> => {
  await registerW5Host({ dataRoot: root, hostKind: 'cli' });
  try {
    await withW5ProcessFileLocks(
      [join(root, 'workspaces/alpha/worktrees.json')],
      { dataRoot: root, timeoutMs: 0 },
      () => Promise.resolve(undefined),
    );
    throw new Error('Expected positive cross-process contention');
  } catch (error) {
    if (!(error instanceof W5ProcessFileLockTimeoutError)) throw error;
    process.stdout.write('contended\n');
  }
  await archiveSingleRepoWorktree({
    workspaceId: 'alpha',
    worktreeId: 'archive',
  });
  process.stdout.write('archived\n');
})().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
