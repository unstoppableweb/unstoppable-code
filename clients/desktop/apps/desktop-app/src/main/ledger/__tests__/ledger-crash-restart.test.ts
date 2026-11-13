import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  LEDGER_COMMAND_OPERATIONS,
  type LedgerStorageCounts,
} from '@canopy/desktop-shared/node/ledger';
import {
  addInput,
  setUpLedger,
  updateInput,
  type LedgerTestContext,
} from '@canopy/desktop-shared/node/ledger/__tests__/ledger-test-harness';
import type { LedgerAddEntryParams } from '@canopy/protocol/canopy-core';
import { z } from 'zod';
import type * as TsxWorkerThreads from './fixtures/tsx-worker-threads';

jest.mock('node:worker_threads', () =>
  jest
    .requireActual<typeof TsxWorkerThreads>('./fixtures/tsx-worker-threads')
    .createTsxWorkerThreads({ observeSqliteCalls: true }),
);

jest.mock('../../lib/paths', () => ({
  getLedgerDatabasePath: (): string =>
    '/nonexistent/canopy-ledger-crash-restart-test/ledger.sqlite',
}));

import type { LedgerStorageClient } from '../ledger-store-client';
import { createWorkerLedgerStoreClient } from '../storage-client';
import { LedgerStorageHost } from '../storage-host';
import { TSX_EXEC_ARGV, startedWorkers } from './fixtures/tsx-worker-threads';

jest.setTimeout(60_000);

const WORKER_ENTRY = join(__dirname, '..', 'storage-worker.ts');
const OPEN_PROBE = join(__dirname, 'fixtures', 'ledger-open-probe.ts');
const CRASH_WRITER = join(__dirname, 'fixtures', 'ledger-crash-writer.ts');
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..');
const REQUEST_TIMEOUT_MS = 30_000;
const WORKER_EXIT_WAIT_MS = 30_000;
const SLOW_TITLE = 'Overrun the request timeout';
const TASK: LedgerAddEntryParams = {
  type: 'TASK',
  title: 'Acknowledged before the crash',
  content: 'Must survive the restart.',
};
const COMMANDS = ['addEntry', 'updateEntry'] as const;
const WRITER_COMMANDS = [...COMMANDS, ...COMMANDS, ...COMMANDS];

const WriterLineSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ack'),
    method: z.enum(COMMANDS),
    args: z.array(z.unknown()),
    receipt: z.looseObject({ entry: z.looseObject({ entryId: z.string() }) }),
  }),
  z.object({
    type: z.literal('state'),
    authorityId: z.string(),
    ledgerId: z.string(),
    counts: z.record(z.string(), z.number()),
    outbox: z.array(z.unknown()),
  }),
  z.object({ type: z.enum(['paused', 'unpaused']) }),
]);

let tempDir: string;
const hosts: LedgerStorageHost[] = [];
const children: ChildProcess[] = [];
const contexts: LedgerTestContext[] = [];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ledger-crash-restart-'));
  startedWorkers.length = 0;
});

afterEach(async () => {
  jest.useRealTimers();
  // Stops a fixture a failed test left paused; it exits within 60 s anyway.
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(hosts.splice(0).map((host) => host.shutdown()));
  for (const context of contexts.splice(0)) context.dispose();
  rmSync(tempDir, { recursive: true, force: true });
});

function createHost(
  dbPath: string,
  requestTimeoutMs?: number,
  workerExitWaitMs?: number,
): { host: LedgerStorageHost; client: LedgerStorageClient } {
  const host = new LedgerStorageHost({
    dbPath,
    workerEntry: WORKER_ENTRY,
    requestTimeoutMs,
    workerExitWaitMs,
  });
  hosts.push(host);
  return { host, client: createWorkerLedgerStoreClient(host) };
}

/** Runs `use` on a database no connection holds, locked as the store does. */
function withRaw<Result>(
  dbPath: string,
  use: (raw: DatabaseSync) => Result,
): Result {
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('PRAGMA locking_mode = EXCLUSIVE');
    return use(raw);
  } finally {
    raw.close();
  }
}

/** Counts after `adds` more adds: one row more of each but scopes and actors. */
function withAdds(
  { scopes, actors, ...perAdd }: LedgerStorageCounts,
  adds: number,
): Record<string, number> {
  const grown = Object.entries(perAdd).map(([kind, rows]): [string, number] => [
    kind,
    rows + adds,
  ]);
  return { scopes, actors, ...Object.fromEntries(grown) };
}

interface ChildRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Runs a fixture through tsx, killing it with SIGKILL once it pauses. */
function runFixture(
  script: string,
  args: readonly string[],
): Promise<ChildRun> {
  return new Promise<ChildRun>((resolveRun, reject) => {
    const child = spawn(process.execPath, [...TSX_EXEC_ARGV, script, ...args], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string): void => {
      stdout += chunk;
      if (stdout.includes('{"type":"paused"}')) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk: string): void => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) =>
      resolveRun({ stdout, stderr, code, signal }),
    );
  });
}

/** The lines a crash writer printed before the parent killed it. */
function killedWriterLines(run: ChildRun): z.infer<typeof WriterLineSchema>[] {
  // Windows may report the forced termination as an exit code.
  if (process.platform !== 'win32') {
    expect(run).toMatchObject({ code: null, signal: 'SIGKILL' });
  }
  expect(run.code).not.toBe(0);
  const lines = run.stdout.trim().split('\n');
  return lines.map((line) => WriterLineSchema.parse(JSON.parse(line)));
}

async function probeOpen(dbPath: string): Promise<unknown> {
  const run = await runFixture(OPEN_PROBE, [dbPath]);
  expect(run).toMatchObject({ code: 0 });
  return JSON.parse(run.stdout);
}

describe('Ledger crash and restart', () => {
  it('restarts a worker that timed out while writing its entry row, with the command applied whole or not at all', async () => {
    const context = setUpLedger();
    contexts.push(context);
    context.repository.close();
    const dbPath = context.databasePath;
    const { client } = createHost(
      dbPath,
      REQUEST_TIMEOUT_MS,
      WORKER_EXIT_WAIT_MS,
    );
    const addAcknowledged = addInput(context, context.user, TASK, 'add');
    const added = await client.addEntry(addAcknowledged);
    const updateAcknowledged = updateInput(
      context,
      context.user,
      {
        entryId: added.entry.entryId,
        expectedRevision: 1,
        status: 'IN_PROGRESS',
      },
      'update',
    );
    const updated = await client.updateEntry(updateAcknowledged);
    const before = await client.getStorageCounts();
    const slowAdd = addInput(
      context,
      context.user,
      { ...TASK, title: SLOW_TITLE },
      'timed-out-add',
    );

    const oldWorker = startedWorkers[0];
    if (!oldWorker) throw new Error('No storage worker started');
    const paused = oldWorker.pauseNextEntryInsert();
    // Only the deliberately blocked request runs on the fake clock.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const rejected = expect(client.addEntry(slowAdd)).rejects.toMatchObject({
        reason: 'STORAGE_UNAVAILABLE',
        message: 'Ledger storage did not answer',
      });
      await Promise.race([
        paused,
        rejected.then(() => {
          throw new Error(
            'Storage request rejected before its entry INSERT barrier',
          );
        }),
      ]);
      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
      await rejected;
      // The INSERT returned, but the transaction has not reached COMMIT.
      expect(oldWorker.termination).toEqual({ active: true, sqliteCall: 1 });
    } finally {
      jest.useRealTimers();
    }

    const after = await client.getStorageCounts();
    // The host started the fresh worker only after the original exit event.
    await oldWorker.exited;
    expect(oldWorker.workersStartedAtExit).toBe(1);
    expect(startedWorkers).toHaveLength(2);
    // The fresh worker holds the lock the terminated one released.
    await expect(probeOpen(dbPath)).resolves.toEqual({
      opened: false,
      reason: 'WRITER_UNAVAILABLE',
    });

    const slowKeys = await client.listReceiptKeys({
      ledgerId: context.ledgerId,
      operation: LEDGER_COMMAND_OPERATIONS.addEntry,
      idempotencyKeys: ['timed-out-add'],
    });
    expect(slowKeys).toEqual([]);
    expect(after).toEqual(before);
    // The paused transaction rolled back whole; the same command can retry.
    const replay = await client.addEntry(slowAdd);
    expect(replay.entry.title).toBe(SLOW_TITLE);
    const afterRetry = withAdds(before, 1);
    await expect(client.getStorageCounts()).resolves.toEqual(afterRetry);
    await expect(client.addEntry(slowAdd)).resolves.toEqual(replay);
    await expect(client.getStorageCounts()).resolves.toEqual(afterRetry);
    await expect(client.addEntry(addAcknowledged)).resolves.toEqual(added);
    await expect(client.updateEntry(updateAcknowledged)).resolves.toEqual(
      updated,
    );
    await expect(
      client.getEntry({
        ledgerId: context.ledgerId,
        entryId: added.entry.entryId,
      }),
    ).resolves.toMatchObject({ entry: updated.entry });
  });

  it('recovers every acknowledged write of a process killed with SIGKILL', async () => {
    const dbPath = join(tempDir, 'ledger', 'ledger.sqlite');

    const run = await runFixture(CRASH_WRITER, [
      'write',
      dbPath,
      String(WRITER_COMMANDS.length),
    ]);

    const lines = killedWriterLines(run);
    const acks = lines.flatMap((line) => (line.type === 'ack' ? [line] : []));
    const state = lines.find((line) => line.type === 'state');
    if (state?.type !== 'state') throw new Error(`No state: ${run.stderr}`);
    expect(acks.map((ack) => ack.method)).toEqual(WRITER_COMMANDS);
    expect(lines.at(-1)).toEqual({ type: 'paused' });
    // The killed writer left its WAL; exclusive locking never made a -shm.
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    const { host, client } = createHost(dbPath);
    const { ledgerId } = state;
    await expect(client.getAuthorityId()).resolves.toBe(state.authorityId);
    // The add killed just before its COMMIT left nothing behind.
    await expect(client.getStorageCounts()).resolves.toEqual(state.counts);
    await expect(
      client.listReceiptKeys({
        ledgerId,
        operation: LEDGER_COMMAND_OPERATIONS.addEntry,
        idempotencyKeys: ['add-0', 'unacknowledged-add'],
      }),
    ).resolves.toEqual(['add-0']);
    await expect(
      client.readOutbox({ ledgerId, afterSequence: '0', limit: 100 }),
    ).resolves.toEqual(state.outbox);
    for (const ack of acks) {
      await expect(host.call(ack.method, ack.args)).resolves.toEqual(
        ack.receipt,
      );
    }
    // Each entry's update came last, so its receipt holds the current entry.
    for (const { method, receipt } of acks) {
      if (method !== 'updateEntry') continue;
      await expect(
        client.getEntry({ ledgerId, entryId: receipt.entry.entryId }),
      ).resolves.toMatchObject({ entry: receipt.entry });
    }

    await host.shutdown();
    // A clean close checkpoints the recovered WAL into the database.
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
  });

  it.each([
    { point: 'inside', when: 'inside its transaction', version: '4' },
    { point: 'committed', when: 'just after it commits', version: '5' },
  ])(
    'leaves a version 4 database at version $version with its data when killed $when of the 4→5 migration',
    async ({ point, version }) => {
      const context = setUpLedger();
      contexts.push(context);
      const dbPath = context.databasePath;
      const input = addInput(context, context.chat, TASK, 'before-migration');
      const receipt = context.repository.addEntry(input);
      const counts = context.repository.getStorageCounts();
      context.repository.close();
      // A version 4 database has neither global bindings nor entry parents.
      withRaw(dbPath, (raw) =>
        raw.exec(`DROP TABLE ledger_global_bindings;
          DROP INDEX ledger_entries_by_parent;
          DROP TABLE ledger_entry_roots;
          ALTER TABLE ledger_entry_versions DROP COLUMN parent_entry_id;
          ALTER TABLE ledger_entries DROP COLUMN parent_entry_id;
          UPDATE ledger_meta SET value = '4' WHERE key = 'schema_version';`),
      );

      const run = await runFixture(CRASH_WRITER, ['migrate', dbPath, point]);

      expect(killedWriterLines(run)).toEqual([{ type: 'paused' }]);
      expect(
        withRaw(dbPath, (raw) =>
          raw
            .prepare(
              `SELECT (SELECT value FROM ledger_meta WHERE key = 'schema_version') AS version,
                (SELECT count(*) FROM sqlite_master WHERE name = 'ledger_global_bindings') AS tables`,
            )
            .get(),
        ),
      ).toEqual({ version, tables: version === '5' ? 1 : 0 });
      const reopened = context.reopen();
      // Reopening finishes the remaining migrations.
      expect(reopened.schema).toEqual({ version: 6, readOnly: false });
      expect(reopened.getStorageCounts()).toEqual(counts);
      expect(reopened.addEntry(input)).toEqual(receipt);
    },
  );
});
