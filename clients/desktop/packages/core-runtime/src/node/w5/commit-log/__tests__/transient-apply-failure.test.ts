import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { W5_LAUNCH_HEAL_OPERATIONS } from '../apply-evidence';
import { recoverW5CommitLog, type W5DurabilityPort } from '../apply';
import { W5CommitLog, type W5CommitRequest } from '../commit-log';
import { fingerprintW5File } from '../fingerprint';
import { createNodeW5Durability } from '../node-durability';
import { W5CommitLogRequestHandler } from '../worker-requests';

// CAN-5680: on 10 Nov a worktree list write hit ENOSPC on its final rename
// while the disk was full. The commit was marked recovery-required, nothing
// ever retried it, and every later write to that list was refused until
// someone ran offline maintenance, including hook pause and resume. The list
// write (w5.worktree_list.write) is the one core.worktree.create,
// core.worktree.delete and core.worktree.hooks.setPaused commit. These drive
// what runW5CommitLogWorker runs, its launch recovery and the request handler
// its listen loop serves, over a real database and files.

const OPERATION = 'w5.worktree_list.write';

interface Harness {
  readonly root: string;
  readonly list: string;
  readonly log: W5CommitLog;
  readonly durability: W5DurabilityPort;
  /** The next durable write fails as a full disk does, before touching the file. */
  failNextWrite(): void;
  handler(): W5CommitLogRequestHandler;
  close(): void;
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'w5-transient-'));
  const list = join(root, 'canopy-everyting', 'worktrees.json');
  const log = W5CommitLog.open(join(root, 'commit-log.sqlite'));
  const real = createNodeW5Durability(process.platform);
  let fail = false;
  const durability: W5DurabilityPort = {
    syncDirectory: real.syncDirectory,
    writeFileDurably: async (path, contents) => {
      if (fail) {
        fail = false;
        throw Object.assign(
          new Error(
            `ENOSPC: no space left on device, rename '${path}.tmp' -> '${path}'`,
          ),
          { code: 'ENOSPC' },
        );
      }
      await real.writeFileDurably(path, contents);
    },
  };
  return {
    root,
    list,
    log,
    durability,
    failNextWrite: () => {
      fail = true;
    },
    handler: () =>
      new W5CommitLogRequestHandler(
        log,
        { dbPath: join(root, 'commit-log.sqlite'), root },
        { applied: [], recoveryRequired: [], interruptedReservations: 0 },
        durability,
        process.platform,
      ),
    close: () => {
      log.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const listContents = (ids: readonly string[]): string =>
  JSON.stringify({ version: 1, worktrees: ids.map((id) => ({ id })) });

function listWrite(
  h: Harness,
  from: string | null,
  to: string,
  extra: Partial<W5CommitRequest> = {},
): W5CommitRequest {
  return {
    operation: OPERATION,
    advance: [],
    files: [
      {
        path: h.list,
        contents: to,
        previousFingerprint: from === null ? null : fingerprintW5File(from),
      },
    ],
    outcome: null,
    ...extra,
  };
}

let requestId = 0;
const commit = (h: Harness, request: W5CommitRequest): Promise<unknown> =>
  h.handler().run({ id: (requestId += 1), method: 'commit', args: [request] });

describe('A transient disk failure does not wedge the worktree list (CAN-5680)', () => {
  let h: Harness;
  const a = listContents(['armadillo']);
  const b = listContents(['armadillo', 'bonobo']);
  const c = listContents(['armadillo', 'bonobo', 'catfish']);

  beforeEach(async () => {
    h = harness();
    await commit(h, listWrite(h, null, a));
  });

  afterEach(() => h.close());

  it('a list write that hits ENOSPC before writing stays pending, and the next write applies it first', async () => {
    h.failNextWrite();
    expect(await commit(h, listWrite(h, a, b))).toMatchObject({
      status: 'recovery-required',
    });
    expect(readFileSync(h.list, 'utf8')).toBe(a);
    expect(h.log.listRecoveryRequiredCommitIds()).toEqual([]);

    // Space is back: the next write finishes the earlier one, then its own.
    expect(await commit(h, listWrite(h, b, c))).toMatchObject({
      status: 'applied',
    });
    expect(readFileSync(h.list, 'utf8')).toBe(c);
    expect(h.log.listPendingCommits()).toEqual([]);
  });

  it('launch recovery applies a list write an earlier ENOSPC left awaiting recovery', async () => {
    const wedged = h.log.commit(listWrite(h, a, b));
    if (wedged.status !== 'committed') throw new Error('Not committed');
    h.log.markCommitRecoveryRequired(wedged.commitId, {
      conflicts: [],
      written: [],
      error: `ENOSPC: no space left on device, rename '${h.list}.tmp' -> '${h.list}'`,
    });

    const report = await recoverW5CommitLog(h.log, {
      root: h.root,
      durability: h.durability,
      healCleanConflictOperations: new Set(W5_LAUNCH_HEAL_OPERATIONS),
    });

    expect(report).toMatchObject({
      applied: [wedged.commitId],
      recoveryRequired: [],
    });
    expect(readFileSync(h.list, 'utf8')).toBe(b);
    expect(await commit(h, listWrite(h, b, c))).toMatchObject({
      status: 'applied',
    });
  });

  it('launch recovery drops such a write when the list changed meanwhile, keeping the file', async () => {
    const wedged = h.log.commit(listWrite(h, a, b));
    if (wedged.status !== 'committed') throw new Error('Not committed');
    h.log.markCommitRecoveryRequired(wedged.commitId, {
      conflicts: [],
      written: [],
      error: `ENOSPC: no space left on device, rename '${h.list}.tmp' -> '${h.list}'`,
    });
    const elsewhere = listContents(['armadillo', 'okapi']);
    writeFileSync(h.list, elsewhere);

    const report = await recoverW5CommitLog(h.log, {
      root: h.root,
      durability: h.durability,
      healCleanConflictOperations: new Set(W5_LAUNCH_HEAL_OPERATIONS),
    });

    expect(report.recoveryRequired).toEqual([]);
    expect(report.abandoned).toEqual([
      { commitId: wedged.commitId, operation: OPERATION },
    ]);
    expect(readFileSync(h.list, 'utf8')).toBe(elsewhere);
    expect(await commit(h, listWrite(h, elsewhere, c))).toMatchObject({
      status: 'applied',
    });
  });

  it('a keyed write that hits ENOSPC still waits for recovery', async () => {
    h.failNextWrite();
    const keyed = listWrite(h, a, b, {
      receipt: {
        caller: 'test',
        operation: OPERATION,
        idempotencyKey: 'key-1',
        fingerprint: 'f'.repeat(64),
      },
    });
    expect(await commit(h, keyed)).toMatchObject({
      status: 'recovery-required',
    });
    expect(h.log.listRecoveryRequiredCommitIds()).toHaveLength(1);
    expect(readFileSync(h.list, 'utf8')).toBe(a);
  });
});
