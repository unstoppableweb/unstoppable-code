import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** An actual stopped removal, not an injected refusal or rendered mock. */
export function seedWorktreeRecoveryFixture({
  userDataDir,
  workspaceId = 'demo-ts-pnpm-vite',
  worktreeId = 'demo-main',
  unreadable = false,
}) {
  const rows = JSON.parse(
    readFileSync(
      path.join(userDataDir, 'workspaces', workspaceId, 'worktrees.json'),
      'utf8',
    ),
  ).worktrees;
  const row = rows.find((item) => item.id === worktreeId);
  if (!row) throw new Error('Recovery fixture requires a listed worktree');
  const directory = path.join(userDataDir, 'w5', 'destructive-lifecycles');
  mkdirSync(directory, { recursive: true });
  const file = path.join(
    directory,
    `${createHash('sha256')
      .update(JSON.stringify([workspaceId, worktreeId]))
      .digest('hex')}.json`,
  );
  writeFileSync(
    file,
    unreadable
      ? '{unreadable'
      : JSON.stringify({
          version: 1,
          operationId: '00000000-0000-4000-8000-000000000003',
          operation: 'worktree-archive',
          workspaceId,
          worktreeId,
          createdAt: row.createdAt,
          state: 'recovery-required',
          directoryIdentity: null,
          steps: [
            { phase: 'live-state-teardown', state: 'done' },
            { phase: 'retained-payload-capture', state: 'done' },
            {
              phase: 'git-capture',
              state: 'failed',
              error: 'Private persisted step detail must never render',
            },
          ],
          ownedPaths: [],
        }),
  );
  return { file, row };
}
