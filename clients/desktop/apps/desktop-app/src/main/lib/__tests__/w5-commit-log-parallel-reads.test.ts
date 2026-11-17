import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  W5CommitLogHost,
  W5CommitLogHostError,
} from '@canopy/core-runtime/node/w5/commit-log-host';
import type { W5CommitRequest } from '@canopy/core-runtime/node/w5/commit-log/commit-log';
import type {
  W5CaptureRequest,
  W5CaptureResult,
} from '@canopy/core-runtime/node/w5/commit-log/capture-contract';
import { fingerprintW5File } from '@canopy/core-runtime/node/w5/commit-log/fingerprint';

// CAN-5589: the W5 commit log host sent one call at a time, so every read
// waited behind the commit in front of it. A commit fsyncs its files and can
// take seconds under load; with ~30 chats reading, 256 reads queued behind
// one and the next was refused as busy. Writes still go one at a time; reads
// now run beside them on the same worker. Its captures are what
// core.workspaceRecords.capture sends to the host. These drive the host over a real
// worker thread and real files, holding a commit after its log row is
// committed and before its files are written.

const WORKER = join(__dirname, 'fixtures', 'w5-gated-commit-log-worker.ts');
const OPERATION = 'w5.worktree_list.write';

const list = (ids: readonly string[]): string =>
  JSON.stringify({ version: 1, worktrees: ids.map((id) => ({ id })) });

const decode = (result: W5CaptureResult): string | null => {
  const [image] = result.files;
  return image?.state === 'present'
    ? Buffer.from(image.base64, 'base64').toString('utf8')
    : null;
};

const capture = (workspaceId: string): W5CaptureRequest => ({
  files: [{ kind: 'worktrees', workspaceId }],
  discoverWorkspaces: false,
});

describe('W5 commit log reads run beside writes (CAN-5589)', () => {
  let dir: string;
  let root: string;
  let gate: string;
  let host: W5CommitLogHost;

  const path = (workspaceId: string): string =>
    join(root, workspaceId, 'worktrees.json');

  function write(
    workspaceId: string,
    from: string | null,
    to: string,
  ): W5CommitRequest {
    return {
      operation: OPERATION,
      advance: [{ kind: 'worktrees', workspaceId }],
      files: [
        {
          path: path(workspaceId),
          contents: to,
          previousFingerprint: from === null ? null : fingerprintW5File(from),
        },
      ],
      outcome: null,
    };
  }

  function startHost(
    options: Partial<ConstructorParameters<typeof W5CommitLogHost>[0]> = {},
  ): W5CommitLogHost {
    return new W5CommitLogHost({
      root,
      dbPath: join(dir, 'w5', 'commit-log.sqlite'),
      workerEntry: WORKER,
      ...options,
    });
  }

  /** Holds the next commit's file writes until `release`. */
  async function holdNextCommit(request: W5CommitRequest): Promise<{
    readonly done: Promise<unknown>;
    release(): void;
  }> {
    writeFileSync(gate, '');
    const done = host.commit(request);
    while (!existsSync(`${gate}.reached`))
      await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      done,
      release: (): void => {
        rmSync(gate, { force: true });
        rmSync(`${gate}.reached`, { force: true });
      },
    };
  }

  const settled = async (promise: Promise<unknown>): Promise<boolean> => {
    let done = false;
    void promise.then(
      () => (done = true),
      () => (done = true),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    return done;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'w5-parallel-reads-'));
    root = join(dir, 'w5-root');
    // The fixture worker holds its file writes while this exists.
    gate = join(dir, 'w5', 'write-gate');
    mkdirSync(join(root, 'alpha'), { recursive: true });
    mkdirSync(join(root, 'beta'), { recursive: true });
    host = startHost();
    await host.commit(write('alpha', null, list(['armadillo'])));
    await host.commit(write('beta', null, list(['bonobo'])));
  });

  afterEach(async () => {
    rmSync(gate, { force: true });
    await host.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves reads of other files while a commit is held, and the held files only once written', async () => {
    const held = await holdNextCommit(
      write('alpha', list(['armadillo']), list(['armadillo', 'axolotl'])),
    );
    // Other files: captured and read while the commit waits on its files.
    const others = await Promise.all([
      ...Array.from({ length: 50 }, () => host.capture(capture('beta'))),
    ]);
    expect(others.map(decode)).toEqual(
      Array.from({ length: 50 }, () => list(['bonobo'])),
    );
    await expect(
      host.revision({ kind: 'worktrees', workspaceId: 'beta' }),
    ).resolves.toBe(1);
    // The held files and the revision the commit advances wait for it.
    const heldCapture = host.capture(capture('alpha'));
    const heldRevision = host.revision({
      kind: 'worktrees',
      workspaceId: 'alpha',
    });
    expect(await settled(heldCapture)).toBe(false);
    expect(await settled(heldRevision)).toBe(false);

    held.release();
    await expect(held.done).resolves.toMatchObject({ status: 'applied' });
    const after = await heldCapture;
    // Never the old image beside the new commit's evidence.
    expect(decode(after)).toBe(list(['armadillo', 'axolotl']));
    expect(after.log.files.map((row) => row.state)).toEqual(['applied']);
    await expect(heldRevision).resolves.toBe(2);
    expect(host.workersStarted).toBe(1);
  }, 30_000);

  it('serves 600 reads from 30 readers while one commit is held, none refused as busy', async () => {
    const held = await holdNextCommit(
      write('alpha', list(['armadillo']), list(['armadillo', 'axolotl'])),
    );
    const reader = async (): Promise<number> => {
      let served = 0;
      for (let read = 0; read < 20; read += 1) {
        const result = await host.capture(capture('beta'));
        if (decode(result) === list(['bonobo'])) served += 1;
      }
      return served;
    };
    const served = await Promise.all(Array.from({ length: 30 }, reader));
    expect(served.reduce((sum, count) => sum + count, 0)).toBe(600);
    // All while the commit was still held.
    expect(await settled(held.done)).toBe(false);
    held.release();
    await expect(held.done).resolves.toMatchObject({ status: 'applied' });
  }, 60_000);

  it('a read sees a commit once its write has answered', async () => {
    await expect(
      host.commit(
        write('alpha', list(['armadillo']), list(['armadillo', 'axolotl'])),
      ),
    ).resolves.toMatchObject({ status: 'applied' });
    expect(decode(await host.capture(capture('alpha')))).toBe(
      list(['armadillo', 'axolotl']),
    );
    await expect(
      host.revision({ kind: 'worktrees', workspaceId: 'alpha' }),
    ).resolves.toBe(2);
  }, 30_000);

  it('bounds the reads in flight and queued, refusing more as busy', async () => {
    await host.shutdown();
    host = startHost({ readConcurrency: 2, maxQueuedReads: 3 });
    await host.capture(capture('beta'));
    const held = await holdNextCommit(
      write('alpha', list(['armadillo']), list(['armadillo', 'axolotl'])),
    );
    // Two in flight wait out the commit; three wait their turn.
    const waiting = Array.from({ length: 5 }, () =>
      host.capture(capture('alpha')),
    );
    const refused = host.capture(capture('beta'));
    await expect(refused).rejects.toMatchObject({
      reason: 'unavailable',
      unavailableCause: 'queue-full',
    });
    held.release();
    for (const result of await Promise.all(waiting))
      expect(decode(result)).toBe(list(['armadillo', 'axolotl']));
  }, 30_000);

  it('refuses a read that waits out its bound as overloaded, keeping the worker', async () => {
    await host.shutdown();
    host = startHost({ queuedReadTimeoutMs: 200 });
    // Starts the worker: a write has no queued-wait bound.
    await host.snapshot();
    const held = await holdNextCommit(
      write('alpha', list(['armadillo']), list(['armadillo', 'axolotl'])),
    );
    const capturing = host.capture(capture('alpha'));
    const revising = host.revision({ kind: 'worktrees', workspaceId: 'alpha' });
    for (const waiting of [capturing, revising]) {
      const error: unknown = await waiting.catch((caught: unknown) => caught);
      // As a queued wait that expired: the record port's overload (CAN-5577).
      expect(error).toBeInstanceOf(W5CommitLogHostError);
      expect(error).toMatchObject({
        reason: 'unavailable',
        unavailableCause: 'queued-wait',
      });
    }
    held.release();
    await expect(held.done).resolves.toMatchObject({ status: 'applied' });
    expect(decode(await host.capture(capture('alpha')))).toBe(
      list(['armadillo', 'axolotl']),
    );
    expect(host.workersStarted).toBe(1);
  }, 30_000);
});
