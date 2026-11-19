import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** An actual stopped removal, not an injected refusal or rendered mock. */
export function seedWorktreeRecoveryFixture({
  userDataDir,
  workspaceId = 'demo-ts-pnpm-vite',
  worktreeId = 'demo-main',
  operationId = '00000000-0000-4000-8000-000000000003',
  unreadable = false,
  identityChange,
  identityScope = 'all',
  unverifiableCheckout = false,
  interruptedDiscard = false,
  aside = false,
  stagedCapture = false,
  retained = false,
}) {
  const rows = JSON.parse(
    readFileSync(
      path.join(userDataDir, 'workspaces', workspaceId, 'worktrees.json'),
      'utf8',
    ),
  ).worktrees;
  const row = rows.find((item) => item.id === worktreeId);
  if (!row) throw new Error('Recovery fixture requires a listed worktree');
  const project = path.join(userDataDir, 'workspaces', workspaceId);
  const checkout = path.join(project, 'worktrees', worktreeId);
  const marker = randomUUID();
  const recordedIdentity = (directory, scope, withMarker = false) => {
    const stat = lstatSync(directory);
    const fields = [
      String(stat.dev),
      String(stat.ino),
      String(stat.birthtimeMs),
    ];
    if (identityScope === 'all' || identityScope === scope) {
      if (identityChange === 'device')
        fields[0] = String(BigInt(fields[0]) + 1n);
      if (identityChange === 'inode')
        fields[1] = String(BigInt(fields[1]) + 1n);
      if (identityChange === 'birthtime')
        fields[2] = String(stat.birthtimeMs + 1);
    }
    if (withMarker) fields.push(marker);
    return fields.join(':');
  };
  if (identityChange)
    writeFileSync(path.join(project, '.w5-incarnation'), marker);
  const directoryIdentity = identityChange
    ? recordedIdentity(project, 'project', true)
    : null;
  const ownedPaths = identityChange
    ? [
        {
          path: checkout,
          identity: `${unverifiableCheckout ? 'unverifiable:' : ''}${recordedIdentity(checkout, 'owned')}`,
        },
      ]
    : [];
  const container = path.join(project, 'archived-containers', worktreeId);
  if (stagedCapture || retained) {
    const recovery = {
      kind: 'files-only',
      source: 'partial',
      digest: retained ? 'f'.repeat(64) : createHash('sha256').digest('hex'),
      payloadId: randomUUID(),
      ...(retained ? { gitCleanupPending: true } : {}),
    };
    mkdirSync(path.join(container, 'recovery-files', recovery.payloadId), {
      recursive: true,
    });
    const [dev, ino, birthtimeMs] = recordedIdentity(checkout, 'staged')
      .split(':')
      .map(Number);
    writeFileSync(
      path.join(container, 'recovery.staged.json'),
      JSON.stringify({
        version: 1,
        createdAt: row.createdAt,
        phase: 'captured',
        recovery,
        identity: { dev, ino, birthtimeMs },
        repositories: [],
      }),
    );
    if (retained) {
      const archivedAt = new Date().toISOString();
      writeFileSync(
        path.join(container, 'container.json'),
        JSON.stringify({
          version: 3,
          kind: 'worktree',
          id: worktreeId,
          projectId: workspaceId,
          name: row.branchName,
          createdAt: row.createdAt,
          archivedAt,
          expiresAt: new Date(Date.now() + 86400_000).toISOString(),
          retentionDays: 1,
          chatCount: 0,
          archivedChatCount: 0,
          executionCount: 0,
          workspaceType: 'single-repo',
          originalWorktree: row,
          recovery,
        }),
      );
      const rowsFile = path.join(project, 'worktrees.json');
      const state = JSON.parse(readFileSync(rowsFile, 'utf8'));
      state.worktrees = state.worktrees.filter(
        (item) => item.id !== worktreeId,
      );
      writeFileSync(rowsFile, JSON.stringify(state));
      return {
        file: path.join(container, 'recovery.staged.json'),
        row,
        checkout,
        operationId,
        container,
      };
    }
  }
  if (aside)
    renameSync(
      checkout,
      path.join(
        path.dirname(checkout),
        `.${worktreeId}.discard-aside-live-checkout`,
      ),
    );
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
          operationId,
          operation: interruptedDiscard
            ? 'worktree-delete'
            : 'worktree-archive',
          workspaceId,
          worktreeId,
          createdAt: row.createdAt,
          state: 'recovery-required',
          directoryIdentity,
          steps: interruptedDiscard
            ? [{ phase: 'discard:target:live-checkout', state: 'pending' }]
            : [
                { phase: 'live-state-teardown', state: 'done' },
                { phase: 'retained-payload-capture', state: 'done' },
                {
                  phase: 'git-capture',
                  state: 'failed',
                  error: 'Private persisted step detail must never render',
                },
              ],
          ownedPaths,
        }),
  );
  return { file, row, checkout, operationId };
}
