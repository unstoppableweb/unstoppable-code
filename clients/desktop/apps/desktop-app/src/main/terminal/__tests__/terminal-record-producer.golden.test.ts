// CAN-7051: Electron main's side of the worktree terminal record against a
// real in-process record authority: import and fence on load, in-process
// output through apply batches, the outbox while the daemon is down, its
// sealed drain on the next launch, at-most-once resends, retirement and the
// restore prefetch (terminal:load-worktree-state's persistence projection).
import * as fs from 'node:fs';
import { z } from 'zod';
import { isRecord } from '../../lib/type-guards';
import fsPromises from 'node:fs/promises';
import { createHash } from 'node:crypto';
// The module itself, so a spy reaches the daemon repository's reads.
import fsModule from 'node:fs';
import * as atomicFile from '@canopy/execution-engine/node/lib/atomic-file';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  TerminalRecordAuthority,
  TerminalRecordRepository,
  terminalRecordDir,
} from '@canopy/core-runtime/node/terminal/record';
import {
  WORKER_TERMINAL_RECORD_MAX_OPS,
  WorkerTerminalRecordApplyParamsSchema,
  WorkerTerminalRecordOpSchema,
  WorkerTerminalRecordRetireParamsSchema,
  type WorkerTerminalRecordApplyResult,
  type WorkerTerminalRecordClient,
  type WorkerTerminalRecordHistoryReadResult,
  type WorkerTerminalRecordRetireParams,
  type WorkerTerminalRecordOp,
} from '@canopy/protocol/canopy-core';
import {
  TerminalPersistenceStore,
  terminalWorktreeExists,
  terminalPersistenceStore,
  enqueueTerminalRecordOp,
  recipientTerminalRetirementPath,
  type TerminalPersistenceStoreOptions,
} from '../persistence';
import { cleanupSharedContainerRecipientViewState } from '../../shared-containers/recipient-view-state';
import { beginDirectoryDeletion } from '../../lib/directory-effect-admission';
import { removePersistedWorktreeDataDirectory } from '@canopy/desktop-shared/node/lib/worktree-data-cleanup';
import { removeTreeWithoutAsar } from '../../lib/remove-tree-without-asar';
import {
  retainRetiredOutboxIdentities,
  TerminalRecordOutbox,
  type TerminalRecordOutboxFile,
} from '../record-outbox';
import { getWorktreeTerminalReplayWitnessFilePath } from '../../lib/paths';
import type { TerminalRecordClientPort } from '../record-client';
import type { readWorkspaceWorktreesDetailed } from '../../lib/workspace-persistence';
import { fixture, session } from './fixtures/terminal-persistence';
import {
  createTerminalStore,
  type WorktreeTerminalBucket,
} from '@canopy/app-state/terminal';
import type {
  CommandMap,
  QueryMap,
  TerminalClient,
  TerminalCommandName,
  TerminalQueryName,
} from '@canopy/app-core';
import type {
  LoadWorktreeTerminalStateRequest,
  LoadWorktreeTerminalStateResponse,
} from '@canopy/protocol/terminal';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  applyTerminalRecordOp,
  type TerminalRecordPayloadState,
} from '@canopy/core-runtime/node/terminal/record/ops';

let mockRoot: string;
jest.mock('../../lib/paths', () => ({
  getWorktreeTerminalStateFilePath: (p: string, w: string): string =>
    join(mockRoot, 'workspaces', p, 'worktree-data', w, 'terminal-state.json'),
  getWorktreeTerminalPresentationFilePath: (p: string, w: string): string =>
    join(
      mockRoot,
      'workspaces',
      p,
      'worktree-data',
      w,
      'terminal-presentation.json',
    ),
  getWorktreeTerminalLegacyLayout: (): 'workspaces' => 'workspaces',
  getWorktreeTerminalReplayWitnessFilePath: (
    p: string,
    w: string,
    id: string,
  ): string =>
    join(
      mockRoot,
      'workspaces',
      p,
      'worktree-data',
      w,
      `terminal-replay-witness.${createHash('sha256').update(id).digest('hex')}.json`,
    ),
  getTerminalOutboxDataRoot: (): string => mockRoot,
  getWorkspaceWorkEntriesFilePath: (): string =>
    join(mockRoot, 'work-entries.json'),
  getWorktreeDataRootDir: (): string => mockRoot,
  getSharedContainerRunRootDir: (): string => join(mockRoot, 'run'),
}));
jest.mock('../../lib/workspace-persistence', () => ({
  readWorkspaceWorktreesDetailed: (): ReturnType<
    typeof readWorkspaceWorktreesDetailed
  > => Promise.resolve({ worktrees: [], authority: 'absent' }),
}));
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): { deleteScope: () => Promise<void> } => ({
    deleteScope: jest.fn(() => Promise.resolve()),
  }),
}));
jest.mock('../../lib/remove-tree-without-asar', () => ({
  removeTreeWithoutAsar: jest.fn(() => Promise.resolve()),
}));
jest.mock('@canopy/desktop-shared/node/lib/worktree-data-cleanup', () => ({
  removePersistedWorktreeDataDirectory: jest.fn(() => Promise.resolve()),
  WORKTREE_DATA_REMOVE_MAX_RETRIES: 20,
  WORKTREE_DATA_REMOVE_RETRY_DELAY_MS: 100,
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

let up = true;

let authority: TerminalRecordAuthority;
function newAuthority(): TerminalRecordAuthority {
  return new TerminalRecordAuthority({
    repository: new TerminalRecordRepository({
      dataRoot: mockRoot,
      flushDirectorySync: () => undefined,
    }),
    installDebounceMs: 1,
  });
}
let epoch = 0;
let intervals: jest.SpiedFunction<typeof setInterval>;
let records: TerminalRecordClientPort;
// Lost replies are injected per test; the daemon still applied the batch.
let loseApplyReplies = 0;
let applyCalls = 0;
function recordsFor(owner: number): TerminalRecordClientPort {
  const reach = <T>(run: () => T): Promise<T> =>
    Promise.resolve().then(() => {
      if (!up || owner !== epoch) throw new Error('down');
      return run();
    });
  return {
    available: () => Promise.resolve(up && owner === epoch),
    peekAvailable: () => up && owner === epoch,
    open: (client) => reach(() => authority.open(client)),
    historyRead: (params) => reach(() => authority.historyRead(params)),
    apply: (params) =>
      reach(() => {
        // As the dispatcher validates params before the handler runs.
        if (!WorkerTerminalRecordApplyParamsSchema.safeParse(params).success)
          throw Object.assign(new Error('invalid'), {
            payload: { kind: 'invalid_argument', retry: { kind: 'never' } },
          });
        applyCalls += 1;
        const result = authority.apply(params);
        if (loseApplyReplies > 0) {
          loseApplyReplies -= 1;
          throw new Error('lost reply');
        }
        return result;
      }),
    retire: (params) =>
      reach(() => {
        if (!WorkerTerminalRecordRetireParamsSchema.safeParse(params).success)
          throw Object.assign(new Error('invalid'), {
            payload: { kind: 'invalid_argument', retry: { kind: 'never' } },
          });
        return authority.retire(params);
      }),
    shutdown: (signal) =>
      reach(() => {
        authority.shutdown(signal);
      }),
  };
}
function newOutbox(): TerminalRecordOutbox {
  const root = mockRoot;
  return new TerminalRecordOutbox(() => root);
}

it.each([false, true])(
  'R9 partial collapse merges only the readable scalar (fresh offline: %s)',
  async (fresh) => {
    fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
    fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
    const first = store();
    const full = await first.loadWorktreeState('p', 'w');
    const path = join(legacyPath(), '..', 'terminal-presentation.json');
    const before: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!isRecord(before)) throw new Error('Expected presentation');
    up = false;
    const s = fresh ? store() : first;
    s.registerLiveSession(session('a'));
    const partial = await s.loadWorktreeState('p', 'w');
    expect(partial.history?.status).toBe('unavailable');
    s.saveWorktreeState({
      ...partial,
      projectId: 'p',
      worktreeId: 'w',
      drawerCollapsed: true,
    });
    await s.drainAll();
    s.markAllLiveTerminalsExited('app-quit');
    expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toEqual(
      expect.objectContaining({ drawerCollapsed: true }),
    );
    const after: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
    expect(after).toEqual({ ...before, drawerCollapsed: true });
    up = true;
    const restarted = await store().loadWorktreeState('p', 'w');
    expect(restarted.drawerCollapsed).toBe(true);
    expect(restarted.groups).toEqual(full.groups);
  },
);

it('R9 a partial rename with an unchanged fallback scalar preserves saved collapse', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(
    legacyPath(),
    JSON.stringify({ ...fixture(), drawerCollapsed: true }),
  );
  await store().loadWorktreeState('p', 'w');
  const path = join(legacyPath(), '..', 'terminal-presentation.json');
  up = false;
  const s = store();
  s.registerLiveSession(session('a'));
  const partial = await s.loadWorktreeState('p', 'w');
  s.saveWorktreeState({
    ...partial,
    projectId: 'p',
    worktreeId: 'w',
    terminalCustomNames: { a: 'Renamed' },
  });
  await s.drainAll();
  s.markAllLiveTerminalsExited('app-quit');
  expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toEqual(
    expect.objectContaining({ drawerCollapsed: true }),
  );
});

it.each([undefined, 'evicted-view'])(
  'R9 repeated partial collapse toggles keep their scalar baseline (token: %s)',
  async (viewToken) => {
    fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
    fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
    const s = store();
    await s.loadWorktreeState('p', 'w');
    const path = join(legacyPath(), '..', 'terminal-presentation.json');
    const before: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!isRecord(before)) throw new Error('Expected presentation');
    up = false;
    s.registerLiveSession(session('a'));
    const partial = await s.loadWorktreeState('p', 'w');
    for (const drawerCollapsed of [true, false, true, false]) {
      s.saveWorktreeState({
        ...partial,
        projectId: 'p',
        worktreeId: 'w',
        viewToken,
        drawerCollapsed,
      });
      await s.drainAll();
      s.flushAllSync();
      expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toEqual({
        ...before,
        drawerCollapsed,
      });
    }
    s.markAllLiveTerminalsExited('app-quit');
    const final: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
    expect(final).toEqual(expect.objectContaining({ drawerCollapsed: false }));
  },
);

it.each([false, true])(
  'R9 scrub cannot replace quit custody (unmerged: %s)',
  async (unmerged) => {
    up = false;
    const outbox = newOutbox();
    if (unmerged)
      jest.spyOn(outbox, 'read').mockRejectedValue(new Error('unreadable'));
    const s = newStore({ records, outbox });
    s.registerLiveSession(session('keep'));
    s.appendTerminalOutput('p', 'w', 'keep', Buffer.from('before'));
    await s.drainAll();
    // Unmerged startup queues in this run's own file, never the shared one.
    const artifacts = fs
      .readdirSync(mockRoot)
      .filter((name) => name.startsWith('terminal-record-outbox'));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0] === 'terminal-record-outbox.json').toBe(!unmerged);
    await newOutbox().write(
      {
        version: 1,
        producer: 'electron_main',
        publicationId: 'undiscovered-source',
        retirements: [],
        scopes: [
          {
            client: {
              projectId: 'unrelated',
              worktreeId: 'w',
              legacyLayout: 'workspaces',
              incarnation: null,
            },
            entries: [
              {
                runId: 'unread',
                seq: 1,
                ops: [
                  {
                    op: 'session.upsert',
                    session: { ...session('unread'), projectId: 'unrelated' },
                  },
                ],
              },
            ],
          },
          {
            client: {
              projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
              worktreeId: 'old',
              legacyLayout: 'workspaces',
              incarnation: null,
              lifetimeId: 'undiscovered-recipient',
            },
            entries: [
              {
                runId: 'recipient',
                seq: 1,
                ops: [
                  {
                    op: 'output.append',
                    terminalId: 'private',
                    text: 'PRIVATE-RECIPIENT',
                  },
                ],
              },
            ],
          },
        ],
      },
      'unread',
    );
    let reached: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actual = atomicFile.writeFileAtomically;
    let held = false;
    const write = jest
      .spyOn(atomicFile, 'writeFileAtomically')
      .mockImplementation(async (...args) => {
        if (!held && String(args[0]).endsWith('run-unread.json')) {
          held = true;
          reached();
          await gate;
          // Already-issued install: an async beforeInstall guard cannot retract it.
          fs.writeFileSync(args[0], args[1]);
          return;
        }
        return actual(...args);
      });
    const scrub = outbox.scrubRecipient({
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'old',
    });
    try {
      await started;
      s.appendTerminalOutput('p', 'w', 'keep', Buffer.from('-final'));
      s.markAllLiveTerminalsExited('fatal-exit');
      release();
      await scrub;
      const recovered = (await newOutbox().read()).outbox;
      expect(JSON.stringify(recovered)).not.toContain('PRIVATE-RECIPIENT');
      expect(
        recovered.scopes.some(
          (scope) =>
            scope.client.projectId === 'unrelated' &&
            JSON.stringify(scope.entries).includes('unread'),
        ),
      ).toBe(true);
      expect(
        recovered.scopes
          .flatMap((scope) => scope.entries)
          .flatMap((entry) => entry.ops),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ op: 'exit', signal: 'fatal-exit' }),
          expect.objectContaining({
            op: 'output.append',
            text: 'before-final',
          }),
        ]),
      );
    } finally {
      release();
      write.mockRestore();
    }
  },
);

it.each([false, true])(
  'R9 scrub cannot replace quit custody while paused on the seal target (unmerged: %s)',
  async (unmerged) => {
    up = false;
    const outbox = newOutbox();
    if (unmerged)
      jest.spyOn(outbox, 'read').mockRejectedValue(new Error('unreadable'));
    const s = newStore({ records, outbox });
    s.registerLiveSession(session('keep'));
    s.appendTerminalOutput('p', 'w', 'keep', Buffer.from('before'));
    await s.drainAll();
    // The seal's primary is the only artifact: no publication is active.
    const artifacts = fs
      .readdirSync(mockRoot)
      .filter((name) => name.startsWith('terminal-record-outbox'));
    expect(artifacts).toHaveLength(1);
    const target = join(mockRoot, artifacts[0] ?? '');
    expect(basename(target) === 'terminal-record-outbox.json').toBe(!unmerged);
    let reached: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actual = atomicFile.writeFileAtomically;
    let held = false;
    const write = jest
      .spyOn(atomicFile, 'writeFileAtomically')
      .mockImplementation(async (...args) => {
        if (!held && String(args[0]) === target) {
          held = true;
          reached();
          await gate;
          // Already-issued install of the scrub's pre-quit read.
          fs.writeFileSync(args[0], args[1]);
          return;
        }
        return actual(...args);
      });
    const scrub = outbox.scrubRecipient({
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'old',
    });
    try {
      await started;
      s.appendTerminalOutput('p', 'w', 'keep', Buffer.from('-final'));
      s.markAllLiveTerminalsExited('fatal-exit');
      release();
      await scrub;
      // The scrub's install replaced the sealed primary.
      expect(fs.readFileSync(target, 'utf8')).not.toContain('fatal-exit');
      write.mockRestore();
      up = true;
      const loaded = await store().loadWorktreeState('p', 'w');
      expect(
        loaded.terminals.map((entry) => [
          entry.session.id,
          entry.scrollbackLines,
          entry.signal,
        ]),
      ).toEqual([['keep', ['before-final'], 'fatal-exit']]);
    } finally {
      release();
      write.mockRestore();
    }
  },
);

it.each([false, true])(
  'R9 empty first reads, flush and quit create no witness directory (authority up: %s)',
  async (available) => {
    up = available;
    const s = store();
    await s.loadWorktreeState('p', 'never-written');
    await s.drainAll();
    s.markAllLiveTerminalsExited('app-quit');
    expect(
      fs.existsSync(
        join(mockRoot, 'workspaces', 'p', 'worktree-data', 'never-written'),
      ),
    ).toBe(false);
  },
);

it.each(['remove', 'discard', 'damaged-read'] as const)(
  'R9 quit custody survives an already-issued %s and rejects queued mutation',
  async (operation) => {
    const outbox = newOutbox();
    const path = join(mockRoot, 'terminal-record-outbox.json');
    const image: TerminalRecordOutboxFile = {
      version: 1,
      producer: 'electron_main',
      retirements: [],
      scopes: [
        {
          client: {
            projectId: 'p',
            worktreeId: 'w',
            legacyLayout: 'workspaces',
            incarnation: 'known',
          },
          entries: [
            {
              runId: 'seal',
              seq: 1,
              ops: [{ op: 'session.upsert', session: session('sealed') }],
            },
          ],
        },
      ],
    };
    await outbox.write(image);
    if (operation === 'damaged-read') fs.writeFileSync(path, '{damaged');
    let reached: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rm = fsPromises.rm;
    const rename = fsPromises.rename;
    const removing = jest
      .spyOn(fsPromises, 'rm')
      .mockImplementation(async (...args) => {
        if (String(args[0]) === path) {
          reached();
          await gate;
        }
        return rm(...args);
      });
    const renaming = jest
      .spyOn(fsPromises, 'rename')
      .mockImplementation(async (...args) => {
        if (String(args[0]) === path) {
          reached();
          await gate;
        }
        return rename(...args);
      });
    const active =
      operation === 'damaged-read'
        ? outbox.read()
        : operation === 'discard'
          ? outbox.discard([path])
          : outbox.remove();
    try {
      await started;
      const queued = outbox.remove().catch((error: unknown) => error);
      outbox.seal(image, null);
      release();
      await active;
      expect(await queued).toBeInstanceOf(Error);
      expect((await newOutbox().read()).outbox.scopes).toEqual(image.scopes);
    } finally {
      release();
      removing.mockRestore();
      renaming.mockRestore();
    }
  },
);

it('R9 recipient policy filters the seal before scrub discovers old lifetimes', async () => {
  const outbox = newOutbox();
  const scope = (id: string): TerminalRecordOutboxFile['scopes'][number] => ({
    client: {
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'recipient',
      legacyLayout: 'workspaces',
      incarnation: null,
      lifetimeId: id,
    },
    entries: [
      {
        runId: id,
        seq: 1,
        ops: [{ op: 'output.append', terminalId: id, text: id }],
      },
    ],
  });
  const image: TerminalRecordOutboxFile = {
    version: 1,
    producer: 'electron_main',
    retirements: [],
    scopes: [scope('unlisted-old'), scope('successor')],
  };
  await outbox.write(image);
  const enumerate = fsPromises.readdir;
  let reached: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = jest
    .spyOn(fsPromises, 'readdir')
    .mockImplementation((...args) => {
      reached();
      return gate.then(() => Reflect.apply(enumerate, fsPromises, args));
    });
  const scrub = outbox.scrubRecipient(
    { projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID, worktreeId: 'recipient' },
    (id) => id === 'successor',
  );
  try {
    await started;
    outbox.seal(image, null);
    release();
    await scrub;
    reading.mockRestore();
    expect((await newOutbox().read()).outbox.scopes).toEqual([
      {
        ...scope('successor'),
        entries: scope('successor').entries.map((entry) => ({
          ...entry,
          discoveryFenceIds: [],
        })),
      },
    ]);
  } finally {
    release();
    reading.mockRestore();
  }
});
const stores: TerminalPersistenceStore[] = [];
function newStore(
  options: TerminalPersistenceStoreOptions,
): TerminalPersistenceStore {
  const s = new TerminalPersistenceStore(options);
  stores.push(s);
  return s;
}
const store = (): TerminalPersistenceStore =>
  newStore({
    records,
    outbox: newOutbox(),
  });

it.each([false, true])(
  'R1 recipient cleanup retains only a retry fence unless retirement is durable: %s',
  async (durable) => {
    const retire = jest
      .spyOn(terminalPersistenceStore, 'retireRecipientTerminalRecord')
      .mockResolvedValue(durable);
    const remove = jest.mocked(removePersistedWorktreeDataDirectory);
    const removeRun = jest.mocked(removeTreeWithoutAsar);
    remove.mockClear();
    removeRun.mockClear();
    try {
      await expect(
        cleanupSharedContainerRecipientViewState('container'),
      ).resolves.toBeUndefined();
      expect(retire).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(durable ? 1 : 0);
      expect(removeRun).toHaveBeenCalledTimes(durable ? 0 : 1);
    } finally {
      retire.mockRestore();
    }
  },
);

it('R1 recipient cleanup with an unwritable outbox retires the viewer record before a crash can lose it', async () => {
  const projectId = SHARED_CONTAINER_VIEWER_PROJECT_ID;
  const worktreeId = 'container';
  const recordFile = join(
    terminalRecordDir(mockRoot, projectId, worktreeId),
    'record.json',
  );
  const outbox = newOutbox();
  const first = newStore({ records, outbox });
  first.registerLiveSession({ ...session('private'), projectId, worktreeId });
  first.appendTerminalOutput(
    projectId,
    worktreeId,
    'private',
    Buffer.from('prior account output'),
  );
  await first.drainAll();
  authority.flushSync();
  expect(fs.existsSync(recordFile)).toBe(true);
  const retire = jest
    .spyOn(terminalPersistenceStore, 'retireTerminalRecord')
    .mockImplementation((params) => first.retireTerminalRecord(params));
  // The process dies as the data goes: nothing later in this run runs.
  const remove = jest
    .mocked(removePersistedWorktreeDataDirectory)
    .mockImplementation(() => {
      epoch += 1;
      return Promise.resolve();
    });
  const write = jest
    .spyOn(outbox, 'write')
    .mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
  try {
    await expect(
      cleanupSharedContainerRecipientViewState(worktreeId),
    ).resolves.toBeUndefined();
  } finally {
    write.mockRestore();
    retire.mockRestore();
    remove.mockReset().mockResolvedValue(undefined);
  }
  records = recordsFor(epoch);
  const next = store();
  next.start();
  await next.drainAll();
  authority.flushSync();
  expect(fs.existsSync(recordFile)).toBe(false);
  expect(
    (await store().loadWorktreeState(projectId, worktreeId)).terminals,
  ).toEqual([]);
});

it.each([false, true])(
  'R1 a deleted scope serves neither daemon nor legacy history, including prefetch (lookup error: %s)',
  async (lookupError) => {
    fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
    fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
    let exists = true;
    const open = jest.fn((client: WorkerTerminalRecordClient) =>
      records.open(client),
    );
    const historyRead = jest.fn(
      (params: Parameters<TerminalRecordClientPort['historyRead']>[0]) =>
        records.historyRead(params),
    );
    const s = newStore({
      records: { ...records, open, historyRead },
      outbox: newOutbox(),
      scopeExists: (): Promise<boolean> =>
        !exists && lookupError
          ? Promise.reject(new Error('registry unavailable'))
          : Promise.resolve(exists),
    });
    expect((await s.loadWorktreeState('p', 'w')).terminals).toHaveLength(2);
    exists = false;
    // Even readable legacy bytes cannot bypass read admission.
    fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
    open.mockClear();
    historyRead.mockClear();
    const loaded = await s.loadWorktreeState('p', 'w');
    expect(loaded.terminals).toEqual([]);
    expect(loaded.history?.status).toBe('unavailable');
    await s.prefetchPersistedEntry('a');
    expect(s.getPersistedTerminalEntry('a')).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(historyRead).not.toHaveBeenCalled();
  },
);

it.each(['old', null, 'current'])(
  'R1 offline replay verifies queued incarnation %s for drawer and prefetch',
  async (incarnation) => {
    const outbox = newOutbox();
    await outbox.write({
      version: 1,
      producer: 'electron_main',
      retirements: [],
      scopes: [
        {
          client: {
            projectId: 'p',
            worktreeId: 'w',
            legacyLayout: 'workspaces',
            incarnation,
          },
          entries: [
            {
              runId: 'older',
              seq: 1,
              ops: [
                { op: 'session.upsert', session: session('queued') },
                {
                  op: 'output.append',
                  terminalId: 'queued',
                  text: 'earlier output',
                },
              ],
            },
          ],
        },
      ],
    });
    up = false;
    const s = newStore({
      records,
      outbox,
      incarnation: (): Promise<string> => Promise.resolve('current'),
    });
    const loaded = await s.loadWorktreeState('p', 'w');
    expect(loaded.terminals.map((t) => t.session.id)).toEqual(
      incarnation === 'current' ? ['queued'] : [],
    );
    s.registerLiveSession(session('queued'));
    const release = await s.prefetchPersistedEntry('queued');
    expect(s.getPersistedTerminalEntry('queued')?.scrollbackLines).toEqual(
      incarnation === 'current' ? ['earlier output'] : [],
    );
    release();
  },
);

it('R1 overlapping drawer loads cannot install membership before an outbox write is durable', async () => {
  const outbox = newOutbox();
  const s = newStore({ records, outbox });
  const initial = await s.loadWorktreeState('p', 'w');
  let rejectWrite: (error: Error) => void = () => {
    throw new Error('write not started');
  };
  let started: () => void = () => undefined;
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((_resolve, reject) => {
    rejectWrite = reject;
  });
  const write = jest.spyOn(outbox, 'write').mockImplementation(() => {
    started();
    return held;
  });
  up = false;
  s.registerLiveSession(session('new'));
  s.saveWorktreeState({
    ...initial,
    projectId: 'p',
    worktreeId: 'w',
    drawerCollapsed: true,
    groups: [
      {
        id: 'new-group',
        terminalIds: ['new'],
        focusedTerminalId: 'new',
        splitSizes: [1],
      },
    ],
  });
  const draining = s.drainAll();
  const presentation = join(
    mockRoot,
    'workspaces',
    'p',
    'worktree-data',
    'w',
    'terminal-presentation.json',
  );
  try {
    await writing;
    await s.loadWorktreeState('p', 'w');
    expect(fs.existsSync(presentation)).toBe(false);
    rejectWrite(new Error('disk full'));
    await draining;
    expect(fs.existsSync(presentation)).toBe(false);
  } finally {
    rejectWrite(new Error('cleanup'));
    await draining;
    write.mockRestore();
  }
  await s.drainAll();
  expect(JSON.parse(fs.readFileSync(presentation, 'utf8'))).toMatchObject({
    drawerCollapsed: true,
  });
});

it('R11 a recovered older run cannot replay after newer online writes', async () => {
  const path = join(mockRoot, 'terminal-record-outbox.run-older.json');
  fs.mkdirSync(path); // EISDIR is an unresolved read, not absent or damaged JSON.
  const s = store();
  s.registerLiveSession(session('new'));
  s.appendTerminalOutput('p', 'w', 'new', Buffer.from('new output'));
  await s.drainAll();
  expect(applyCalls).toBe(0);
  expect(
    fs
      .readdirSync(mockRoot)
      .some(
        (name) =>
          name.startsWith('terminal-record-outbox.run-') &&
          name !== 'terminal-record-outbox.run-older.json',
      ),
  ).toBe(true);
  fs.rmSync(path, { recursive: true });
  const outbox = newOutbox();
  await outbox.write(
    {
      version: 1,
      producer: 'electron_main',
      runStartedAt: 1,
      retirements: [],
      scopes: [
        {
          client: seedReplayWitness('older'),
          entries: [
            {
              runId: 'older',
              seq: 1,
              ops: [{ op: 'forget', terminalId: 'new' }],
            },
          ],
        },
      ],
    },
    'older',
  );
  await s.drainAll();
  expect(
    (await s.loadWorktreeState('p', 'w')).terminals.find(
      (entry) => entry.session.id === 'new',
    )?.scrollbackLines,
  ).toEqual(['new output']);
  expect(
    fs
      .readdirSync(mockRoot)
      .filter((name) => name.startsWith('terminal-record-outbox.run-')),
  ).toEqual([]);
});

it('staging retirement keeps live output writable until canonical deletion commits', async () => {
  const s = store();
  s.registerLiveSession(session('staged'));
  await s.drainAll();
  const intent = await s.prepareTerminalRecordRetirement({ projectId: 'p' });
  s.appendTerminalOutput('p', 'w', 'staged', Buffer.from('still live'));
  await s.drainAll();
  expect(
    (await s.loadWorktreeState('p', 'w')).terminals.find(
      (entry) => entry.session.id === 'staged',
    )?.scrollbackLines,
  ).toEqual(['still live']);
  expect(await s.retirePreparedTerminalRecord(intent)).toBe(true);
  await s.drainAll();
  expect(
    fs.existsSync(join(terminalRecordDir(mockRoot, 'p', 'w'), 'record.json')),
  ).toBe(false);
});

it('deleting a project retires its loaded and unloaded worktrees, but a retry never fences a later one (CAN-7704)', async () => {
  const seed = (worktreeId: string, text: string): void => {
    const seeder = newAuthority();
    seeder.apply({
      client: {
        projectId: 'p',
        worktreeId,
        legacyLayout: 'workspaces',
        incarnation: null,
      },
      producer: { id: 'seed', runId: worktreeId },
      seq: 1,
      ops: [
        { op: 'session.upsert', session: session('t', worktreeId) },
        { op: 'output.append', terminalId: 't', text },
      ],
    });
    seeder.flushSync();
    seeder.dispose();
  };
  // CAN-7953: a cutoff taken in the record's own millisecond keeps it.
  const nextMillisecond = (): void => {
    const now = Date.now();
    while (Date.now() <= now) {
      // Spin to the next millisecond.
    }
  };
  const history = (worktreeId: string, terminalId = 't'): string =>
    newAuthority().historyRead({
      client: {
        projectId: 'p',
        worktreeId,
        legacyLayout: 'workspaces',
        incarnation: null,
      },
      terminalId,
    }).text;
  const tombstone = (worktreeId: string): boolean =>
    fs.existsSync(
      join(terminalRecordDir(mockRoot, 'p', worktreeId), 'tombstone.json'),
    );
  seed('w-unloaded', 'unloaded history');
  const s = store();
  s.registerLiveSession(session('loaded'));
  s.appendTerminalOutput('p', 'w', 'loaded', Buffer.from('loaded history'));
  await s.drainAll();
  expect(history('w', 'loaded')).toBe('loaded history');
  expect(history('w-unloaded')).toBe('unloaded history');
  nextMillisecond();
  const intent = await s.prepareTerminalRecordRetirement({ projectId: 'p' });
  // Only the loaded worktree is named; the unloaded one needs discovery.
  expect(intent.worktreeIds).toEqual(['w']);
  // The deletion journal and the outbox keep the selector.
  expect(
    WorkerTerminalRecordRetireParamsSchema.parse(
      JSON.parse(JSON.stringify(intent)),
    ),
  ).toEqual(intent);
  // Discovery is bounded by the cutoff alone, and never by one worktree.
  for (const invalid of [
    { projectId: 'p', projectWide: true, lifetimeIds: ['x'] },
    { projectId: 'p', projectWide: true, worktreeId: 'w', requestedAt: 1 },
  ])
    expect(
      WorkerTerminalRecordRetireParamsSchema.safeParse(invalid).success,
    ).toBe(false);
  up = false;
  expect(await s.retirePreparedTerminalRecord(intent)).toBe(true);
  expect((await newOutbox().read()).outbox.retirements).toEqual([intent]);
  up = true;
  await s.drainAll();
  expect((await newOutbox().read()).outbox.retirements).toEqual([]);
  expect(history('w', 'loaded')).toBe('');
  expect(history('w-unloaded')).toBe('');
  for (const worktreeId of ['w', 'w-unloaded'])
    expect(tombstone(worktreeId)).toBe(true);
  nextMillisecond();
  seed('w-later', 'later history');
  expect(await s.replayTerminalRecordRetirement(intent)).toBe(true);
  await s.drainAll();
  expect((await newOutbox().read()).outbox.retirements).toEqual([]);
  expect(history('w-later')).toBe('later history');
  expect(tombstone('w-later')).toBe(false);
});

it('R11 a journaled retirement survives an outbox failure and replays its original identity', async () => {
  const s = store();
  s.registerLiveSession(session('deleted'));
  await s.drainAll();
  up = false;
  const journal = join(mockRoot, 'deletion-journal.json');
  const writing = jest
    .spyOn(TerminalRecordOutbox.prototype, 'write')
    .mockRejectedValue(new Error('outbox full'));
  try {
    expect(
      await s.retireTerminalRecord(
        { projectId: 'p' },
        async (intent): Promise<void> => {
          await atomicFile.writeFileAtomically(
            journal,
            JSON.stringify(intent),
            { durable: true },
          );
        },
      ),
    ).toBe(false);
    expect(fs.existsSync(journal)).toBe(true);
    const intent = WorkerTerminalRecordRetireParamsSchema.parse(
      JSON.parse(fs.readFileSync(journal, 'utf8')),
    );
    expect(intent.lifetimeIds).toHaveLength(1);
    writing.mockRestore();
    const next = store();
    expect(await next.replayTerminalRecordRetirement(intent)).toBe(true);
    up = true;
    await next.drainAll();
    expect(
      fs.existsSync(join(terminalRecordDir(mockRoot, 'p', 'w'), 'record.json')),
    ).toBe(false);
  } finally {
    writing.mockRestore();
  }
});

it.each(['empty-project', 'missing-project', 'successor'] as const)(
  'R1 a final zero-retirement acknowledgement releases %s',
  async (kind) => {
    const outbox = newOutbox();
    const retire = jest.fn(
      (params: Parameters<TerminalRecordClientPort['retire']>[0]) =>
        records.retire(params),
    );
    const s = newStore({
      outbox,
      records: { ...records, retire },
    });
    if (kind === 'successor')
      authority.apply({
        client: {
          projectId: 'p',
          worktreeId: 'w',
          legacyLayout: 'workspaces',
          incarnation: 'new',
        },
        producer: { id: 'test', runId: 'new' },
        seq: 1,
        ops: [{ op: 'session.upsert', session: session('new') }],
      });
    // The schema rejects a selector-less retirement; captured intents always
    // carry requestedAt. The successor is fenced by incarnation, checked first.
    await s.retirePreparedTerminalRecord({
      projectId: 'p',
      requestedAt: Date.now(),
      ...(kind === 'empty-project' && { worktreeIds: [] }),
      ...(kind === 'successor' && { worktreeId: 'w', incarnation: 'old' }),
    });
    await s.drainAll();
    expect(await retire.mock.results[0].value).toEqual({ retired: 0 });
    expect((await outbox.read()).outbox.retirements).toEqual([]);
    expect((await s.loadWorktreeState('p', 'w')).history).toEqual({
      status: 'available',
    });
    s.registerLiveSession(session('next'));
    await s.drainAll();
    expect(
      (await s.loadWorktreeState('p', 'w')).terminals.map((t) => t.session.id),
    ).toContain('next');
  },
);

it('R11 merging retired earlier runs keeps their pre-admission identities', async () => {
  const outbox = newOutbox();
  const client = {
    projectId: 'p',
    worktreeId: 'w',
    legacyLayout: 'workspaces' as const,
    incarnation: null,
    lifetimeId: 'scope',
  };
  await outbox.write(
    {
      version: 1,
      producer: 'electron_main',
      runStartedAt: 1,
      retirements: [],
      scopes: [
        {
          client,
          entries: [
            {
              runId: 'old',
              seq: 1,
              client: { ...client, lifetimeId: 'attempted' },
              attempted: true,
              ops: [{ op: 'forget', terminalId: 'old' }],
            },
          ],
        },
      ],
    },
    'older',
  );
  const retirement: WorkerTerminalRecordRetireParams = {
    projectId: 'p',
    lifetimeIds: [],
  };
  for (const scope of (await outbox.read()).outbox.scopes)
    retainRetiredOutboxIdentities(retirement, scope);
  await outbox.write(
    {
      version: 1,
      producer: 'electron_main',
      runStartedAt: 2,
      scopes: [],
      retirements: [retirement],
    },
    'retiring',
  );
  const merged = (await outbox.read()).outbox;
  expect(merged.scopes.flatMap((scope) => scope.entries)).toEqual([]);
  expect(merged.retirements).toEqual([
    { projectId: 'p', lifetimeIds: ['scope', 'attempted'], worktreeIds: ['w'] },
  ]);
});

it('R2 an empty retirement intent is never enlarged by later queued identities', async () => {
  const outbox = newOutbox();
  const retirement = await store().prepareTerminalRecordRetirement({
    projectId: 'p',
  });
  expect(retirement.lifetimeIds).toEqual([]);
  const later = {
    client: seedReplayWitness('replacement'),
    entries: [
      {
        runId: 'replacement',
        seq: 1,
        ops: [{ op: 'session.upsert' as const, session: session('later') }],
      },
    ],
  };
  await outbox.write(
    {
      version: 1,
      producer: 'electron_main',
      runStartedAt: 1,
      scopes: [later],
      retirements: [],
    },
    'queued',
  );
  await outbox.write(
    {
      version: 1,
      producer: 'electron_main',
      runStartedAt: 2,
      scopes: [],
      retirements: [retirement],
    },
    'retiring',
  );
  const merged = (await outbox.read()).outbox;
  expect(merged.scopes).toEqual([later]);
  expect(merged.retirements).toEqual([retirement]);
  expect(merged.retirements[0].lifetimeIds).toEqual([]);
  expect(merged.retirements[0].worktreeIds).toEqual([]);
});

it('R1 completed zero-retirement requests do not hold unrelated retirements', async () => {
  const outbox = newOutbox();
  const s = newStore({
    outbox,
    records: {
      ...records,
      retire: (params): ReturnType<TerminalRecordClientPort['retire']> =>
        params.worktreeId === 'w'
          ? Promise.resolve({ retired: 0 })
          : records.retire(params),
    },
  });
  await s.retireTerminalRecord({ projectId: 'p', worktreeId: 'w' });
  await s.retireTerminalRecord({ projectId: 'p', worktreeId: 'other' });
  await s.drainAll();
  expect(
    (await outbox.read()).outbox.retirements.map((entry) => entry.worktreeId),
  ).toEqual([]);
});

it('R8 a recipient bind held by its legacy import holds only its own scope', async () => {
  const viewer = SHARED_CONTAINER_VIEWER_PROJECT_ID;
  const stuckLegacy = join(
    mockRoot,
    'workspaces',
    viewer,
    'worktree-data',
    'stuck',
    'terminal-state.json',
  );
  fs.mkdirSync(join(stuckLegacy, '..'), { recursive: true });
  fs.writeFileSync(stuckLegacy, JSON.stringify(fixture()));
  // The daemon's reads of it fail, so its import stays pending.
  const original = fsModule.readFileSync;
  const unreadable = jest
    .spyOn(fsModule, 'readFileSync')
    .mockImplementation((path, options) => {
      if (path === stuckLegacy)
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return original(path, options);
    });
  const outbox = newOutbox();
  const s = newStore({ records, outbox });
  const otherRecord = join(
    terminalRecordDir(mockRoot, 'p', 'other'),
    'record.json',
  );
  const queued = async (): Promise<(string | undefined)[][]> =>
    (await outbox.read()).outbox.retirements.map((entry) => [
      entry.projectId,
      entry.worktreeId,
    ]);
  try {
    s.registerLiveSession({ ...session('x'), worktreeId: 'other' });
    s.appendTerminalOutput('p', 'other', 'x', Buffer.from('unrelated'));
    await s.drainAll();
    authority.flushSync();
    expect(fs.existsSync(otherRecord)).toBe(true);
    await s.retireRecipientTerminalRecord('stuck');
    // Same scope as the held bind: it keeps its place behind it.
    await s.retireTerminalRecord({ projectId: viewer });
    await s.retireTerminalRecord({ projectId: 'p', worktreeId: 'other' });
    await s.drainAll();
    authority.flushSync();
    expect(fs.existsSync(otherRecord)).toBe(false);
    expect(await queued()).toEqual([
      [viewer, 'stuck'],
      [viewer, undefined],
    ]);
  } finally {
    unreadable.mockRestore();
  }
  await s.drainAll();
  expect(await queued()).toEqual([]);
});

function terminalClientFor(
  persistence: TerminalPersistenceStore,
  probe?: () => Promise<LoadWorktreeTerminalStateResponse>,
  load?: (
    request: LoadWorktreeTerminalStateRequest,
  ) => Promise<LoadWorktreeTerminalStateResponse>,
): TerminalClient {
  const queries: {
    [K in TerminalQueryName]: (
      args: QueryMap[K]['args'],
    ) => Promise<QueryMap[K]['result']>;
  } = {
    'terminal.list': (): Promise<QueryMap['terminal.list']['result']> =>
      Promise.resolve([]),
    'terminal.worktreeState.get': (
      args,
    ): Promise<LoadWorktreeTerminalStateResponse> => {
      if (args.historyStatusOnly && probe) return probe();
      if (!args.historyStatusOnly && load) return load(args);
      return persistence.loadWorktreeState(
        args.projectId,
        args.worktreeId,
        args.historyStatusOnly,
        args.historyConfirmationOnly,
        args.retainedViewToken,
      );
    },
  };
  return {
    query<K extends TerminalQueryName>(
      name: K,
      args: QueryMap[K]['args'],
    ): Promise<QueryMap[K]['result']> {
      return queries[name](args);
    },
    command: (): Promise<never> =>
      Promise.reject(new Error('Unexpected terminal command')),
    subscribe: (): (() => void) => (): void => undefined,
  };
}

function durableTerminalClientFor(
  persistence: TerminalPersistenceStore,
  load?: (
    request: LoadWorktreeTerminalStateRequest,
  ) => Promise<LoadWorktreeTerminalStateResponse>,
): TerminalClient {
  const unexpected = (): Promise<never> =>
    Promise.reject(new Error('Unexpected terminal command'));
  const commands: {
    [K in TerminalCommandName]: (
      args: CommandMap[K]['args'],
    ) => Promise<CommandMap[K]['result']>;
  } = {
    'terminal.spawn': unexpected,
    'terminal.attach': unexpected,
    'terminal.write': unexpected,
    'terminal.resize': unexpected,
    'terminal.kill': unexpected,
    'terminal.restore': unexpected,
    'terminal.worktreeState.save': (request) => {
      persistence.saveWorktreeState(request);
      return Promise.resolve();
    },
  };
  return {
    ...terminalClientFor(persistence, undefined, load),
    command<K extends TerminalCommandName>(
      name: K,
      args: CommandMap[K]['args'],
    ): Promise<CommandMap[K]['result']> {
      return commands[name](args);
    },
  };
}

it.each([false, true])(
  'closing an exited cached terminal during an outage stays closed after restart (Try again: %s)',
  async (retry) => {
    const s = store();
    await s.loadWorktreeState('p', 'w');
    s.registerLiveSession(session('shown'));
    s.markTerminalExited('p', 'w', 'shown', 0, null);
    await s.drainAll();
    const load = jest.fn(
      (
        request: LoadWorktreeTerminalStateRequest,
      ): Promise<LoadWorktreeTerminalStateResponse> =>
        s.loadWorktreeState(
          request.projectId,
          request.worktreeId,
          request.historyStatusOnly,
          request.historyConfirmationOnly,
          request.retainedViewToken,
        ),
    );
    const controller = createTerminalStore(() =>
      durableTerminalClientFor(s, load),
    );
    try {
      await controller.ensureHydrated('p', 'w');
      const fullToken = controller.store.getState().worktrees['p/w'].viewToken;
      expect(fullToken).toBeDefined();
      up = false;
      jest.useFakeTimers();
      controller.observeHistory('p', 'w');
      await jest.advanceTimersByTimeAsync(0);
      expect(load).toHaveBeenCalledTimes(2);
      await load.mock.results[1].value;
      await Promise.resolve();
      if (retry) await controller.store.getState().hydrateWorktree('p', 'w');
      const cached = controller.store.getState().worktrees['p/w'];
      expect(cached.historyUnavailable).toBe(true);
      expect(cached.sessions.shown.live).toBe(false);
      // An exited pane's Close removes it without issuing terminal.kill.
      controller.store.getState().removeTerminal('p', 'w', 'shown');
      await s.drainAll();
      controller.reset();
      jest.useRealTimers();
      up = true;
      await s.drainAll();
      const reloaded = await store().loadWorktreeState('p', 'w');
      expect(reloaded.terminals.map(({ session }) => session.id)).not.toContain(
        'shown',
      );
      if (!retry) expect(cached.viewToken).toBe(fullToken);
      expect(reloaded.terminals).toEqual([]);
    } finally {
      controller.reset();
      jest.useRealTimers();
    }
  },
);

it.each([false, true])(
  'Close stays durable after 65 partial history retries (initial partial view: %s)',
  async (initialPartial) => {
    const s = store();
    await s.loadWorktreeState('p', 'w');
    up = !initialPartial;
    s.registerLiveSession(session('shown'));
    s.appendTerminalOutput('p', 'w', 'shown', Buffer.from('saved output'));
    s.markTerminalExited('p', 'w', 'shown', 0, null);
    await s.drainAll();
    const load = jest.fn(
      (
        request: LoadWorktreeTerminalStateRequest,
      ): Promise<LoadWorktreeTerminalStateResponse> =>
        s.loadWorktreeState(
          request.projectId,
          request.worktreeId,
          request.historyStatusOnly,
          request.historyConfirmationOnly,
          request.retainedViewToken,
        ),
    );
    const controller = createTerminalStore(() =>
      durableTerminalClientFor(s, load),
    );
    try {
      await controller.ensureHydrated('p', 'w');
      const first = controller.store.getState().worktrees['p/w'];
      expect(first.historyUnavailable).toBe(initialPartial);
      expect(first.sessions.shown.live).toBe(false);
      expect(first.viewToken).toBeDefined();
      controller.store.getState().setTerminalName('p', 'w', 'shown', 'Cached');
      up = false;
      // Main retains at most 64 served views and evicts partial ones first.
      for (let attempt = 0; attempt < 65; attempt += 1) {
        await controller.store.getState().hydrateWorktree('p', 'w');
        const result = load.mock.results[attempt + 1];
        if (result.type !== 'return') throw new Error('Load did not return');
        const response = await result.value;
        expect(response.history?.status).toBe('unavailable');
        if (initialPartial)
          expect(response.terminals.map(({ session }) => session.id)).toEqual([
            'shown',
          ]);
      }
      const retried = controller.store.getState().worktrees['p/w'];
      expect(retried.sessions.shown.live).toBe(false);
      expect(controller.store.getState().terminalCustomNames.shown).toBe(
        'Cached',
      );
      controller.store.getState().setTerminalName('p', 'w', 'shown', null);
      up = true;
      await s.drainAll();
      const beforeClose = await store().loadWorktreeState('p', 'w');
      expect(
        beforeClose.terminals.map(({ session, scrollbackLines }) => ({
          id: session.id,
          scrollbackLines,
        })),
      ).toEqual([{ id: 'shown', scrollbackLines: ['saved output'] }]);
      expect(beforeClose.terminalCustomNames.shown).toBeUndefined();
      // Close an exited pane without terminal.kill or another drawer load.
      controller.store.getState().removeTerminal('p', 'w', 'shown');
      await s.drainAll();
      controller.reset();
      authority.dispose();
      authority = newAuthority();
      const reloaded = await store().loadWorktreeState('p', 'w');
      expect(reloaded.terminals).toEqual([]);
      expect(retried.viewToken).not.toBe(first.viewToken);
      expect(reloaded.terminalCustomNames.shown).toBeUndefined();
    } finally {
      controller.reset();
    }
  },
);

it.each([false, true])(
  'Close stays durable when 65 partial retries omit a cached terminal (held partial view: %s)',
  async (initialPartial) => {
    const s = store();
    await s.loadWorktreeState('p', 'w');
    s.registerLiveSession(session('shown'));
    s.registerLiveSession(session('omitted'));
    s.appendTerminalOutput('p', 'w', 'shown', Buffer.from('saved output'));
    await s.drainAll();
    up = !initialPartial;
    const load = jest.spyOn(s, 'loadWorktreeState');
    const controller = createTerminalStore(() => durableTerminalClientFor(s));
    try {
      await controller.ensureHydrated('p', 'w');
      const first = controller.store.getState().worktrees['p/w'];
      expect(first.historyUnavailable).toBe(initialPartial);
      expect(first.viewTokenPartial).toBe(initialPartial);
      expect(first.viewToken).toBeDefined();
      expect(first.sessions.shown.live).toBe(true);
      expect(first.sessions.omitted.live).toBe(true);
      controller.store.getState().setTerminalName('p', 'w', 'shown', 'Cached');
      // The partial view saw both live panes. After this exit is saved, an
      // offline retry sees only the still-live pane.
      up = true;
      s.markTerminalExited('p', 'w', 'omitted', 0, null);
      controller.store.getState().applyExit({
        projectId: 'p',
        worktreeId: 'w',
        terminalId: 'omitted',
        exitCode: 0,
        signal: null,
      });
      await s.drainAll();
      s.registerLiveSession(session('unseen'));
      s.markTerminalExited('p', 'w', 'unseen', 0, null);
      await s.drainAll();
      const other = await s.loadWorktreeState('p', 'w');
      s.saveWorktreeState({
        ...other,
        projectId: 'p',
        worktreeId: 'w',
        terminalCustomNames: { omitted: 'Another pane name' },
      });
      await s.drainAll();
      load.mockClear();
      up = false;
      for (let attempt = 0; attempt < 65; attempt += 1) {
        await controller.store.getState().hydrateWorktree('p', 'w');
        const result = load.mock.results[attempt];
        if (result.type !== 'return') throw new Error('Load did not return');
        const response = await result.value;
        expect(response.history?.status).toBe('unavailable');
        expect(response.terminals.map(({ session }) => session.id)).toEqual([
          'shown',
        ]);
        expect(
          controller.store.getState().worktrees['p/w'].sessions.omitted,
        ).toBeDefined();
      }
      // An independent drawer's load must not evict the actively retried view.
      await s.loadWorktreeState('p', 'w');
      expect(controller.store.getState().terminalCustomNames.shown).toBe(
        'Cached',
      );
      controller.store.getState().setTerminalName('p', 'w', 'shown', null);
      up = true;
      s.markTerminalExited('p', 'w', 'shown', 0, null);
      controller.store.getState().applyExit({
        projectId: 'p',
        worktreeId: 'w',
        terminalId: 'shown',
        exitCode: 0,
        signal: null,
      });
      await s.drainAll();
      // No new load or save renews the held token before this exited pane's Close.
      controller.store.getState().removeTerminal('p', 'w', 'shown');
      await s.drainAll();
      controller.reset();
      authority.dispose();
      authority = newAuthority();
      const reloaded = await store().loadWorktreeState('p', 'w');
      expect(
        reloaded.terminals.map(({ session }) => session.id).sort(),
      ).toEqual(['omitted', 'unseen']);
      // Retaining a view must not borrow another pane's name or deletion rights.
      expect(reloaded.terminalCustomNames.omitted).toBe('Another pane name');
      expect(reloaded.terminalCustomNames.shown).toBeUndefined();
    } finally {
      controller.reset();
      load.mockRestore();
    }
  },
);

it('full recovery omitting a retained terminal restores durable drawer layout edits', async () => {
  const s = store();
  const initial = await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('shown'));
  await s.drainAll();
  up = false;
  const load = jest.fn(
    (
      request: LoadWorktreeTerminalStateRequest,
    ): Promise<LoadWorktreeTerminalStateResponse> =>
      s.loadWorktreeState(
        request.projectId,
        request.worktreeId,
        request.historyStatusOnly,
        request.historyConfirmationOnly,
        request.retainedViewToken,
      ),
  );
  const controller = createTerminalStore(() =>
    durableTerminalClientFor(s, load),
  );
  try {
    await controller.ensureHydrated('p', 'w');
    const partial = controller.store.getState().worktrees['p/w'];
    expect(partial.historyUnavailable).toBe(true);
    expect(partial.viewTokenPartial).toBe(true);
    expect(partial.viewToken).toBeDefined();
    // A renderer lifecycle publication need not exist in main's record yet.
    controller.store.getState().addGroupWithTerminal(session('retained'));
    up = true;
    await s.drainAll();
    await controller.store.getState().hydrateWorktree('p', 'w');
    const result = load.mock.results[1];
    if (result.type !== 'return') throw new Error('Recovery did not return');
    const response = await result.value;
    expect(response.history?.status).toBe('available');
    expect(response.terminals.map(({ session }) => session.id)).toEqual([
      'shown',
    ]);
    const recovered = controller.store.getState().worktrees['p/w'];
    expect(recovered.historyUnavailable).toBe(false);
    expect(recovered.sessions.retained.live).toBe(true);
    const collapsed = !initial.drawerCollapsed;
    jest.useFakeTimers();
    controller.store.getState().setDrawerCollapsed('p', 'w', collapsed);
    await jest.advanceTimersByTimeAsync(100);
    await s.drainAll();
    controller.reset();
    jest.useRealTimers();
    authority.dispose();
    authority = newAuthority();
    const reloaded = await store().loadWorktreeState('p', 'w');
    expect(reloaded.drawerCollapsed).toBe(collapsed);
  } finally {
    controller.reset();
    jest.useRealTimers();
  }
});

it('readable outage confirmation cannot evict a partial view needed for durable Close', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  up = false;
  s.registerLiveSession(session('shown'));
  s.appendTerminalOutput('p', 'w', 'shown', Buffer.from('saved output'));
  const controller = createTerminalStore(() => durableTerminalClientFor(s));
  try {
    await controller.ensureHydrated('p', 'w');
    const partial = controller.store.getState().worktrees['p/w'];
    expect(partial.viewTokenPartial).toBe(true);
    expect(partial.viewToken).toBeDefined();
    up = true;
    await s.drainAll();
    for (const id of ['shown', 'extra']) {
      if (id === 'extra') {
        s.registerLiveSession(session(id));
        s.appendTerminalOutput('p', 'w', id, Buffer.from('extra output'));
      }
      s.markTerminalExited('p', 'w', id, 0, null);
    }
    await s.drainAll();
    up = false;
    fs.writeFileSync(
      legacyPath(),
      JSON.stringify({
        ...fixture(),
        groups: [],
        activeGroupId: null,
        terminals: ['shown', 'extra'].map((id) => ({
          session: session(id),
          scrollbackLines: [id === 'shown' ? 'saved output' : 'extra output'],
          exitCode: 0,
          signal: null,
        })),
        terminalCustomNames: {},
        groupCustomNames: {},
      }),
    );
    // One initial full view, the drawer's partial view, and 62 full views.
    for (let view = 0; view < 62; view += 1)
      await s.loadWorktreeState('p', 'w');
    // Exercise confirmation directly: the observer retries an unavailable
    // drawer only after reachability returns, when it would adopt a full view.
    const confirmation = await s.loadWorktreeState('p', 'w', false, true);
    // Slice 3 RF5: legacy alone leaves authority history unavailable.
    expect(confirmation.history?.status).toBe('unavailable');
    controller.store.getState().applyExit({
      projectId: 'p',
      worktreeId: 'w',
      terminalId: 'shown',
      exitCode: 0,
      signal: null,
    });
    controller.store.getState().removeTerminal('p', 'w', 'shown');
    await s.drainAll();
    controller.reset();
    up = true;
    await s.drainAll();
    fs.unlinkSync(legacyPath());
    authority.dispose();
    authority = newAuthority();
    const reloaded = await store().loadWorktreeState('p', 'w');
    expect(reloaded.terminals.map(({ session }) => session.id)).toEqual([
      'extra',
    ]);
    expect(reloaded.terminals[0].scrollbackLines).toEqual(['extra output']);
    expect(confirmation.viewToken).toBeUndefined();
  } finally {
    controller.reset();
  }
});

it('Close stays durable because outage confirmation preserves a recovered full view', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  up = false;
  s.registerLiveSession(session('shown'));
  s.appendTerminalOutput('p', 'w', 'shown', Buffer.from('saved output'));
  const load = jest.fn(
    (
      request: LoadWorktreeTerminalStateRequest,
    ): Promise<LoadWorktreeTerminalStateResponse> =>
      s.loadWorktreeState(
        request.projectId,
        request.worktreeId,
        request.historyStatusOnly,
        request.historyConfirmationOnly,
        request.retainedViewToken,
      ),
  );
  const client = durableTerminalClientFor(s, load);
  const query = jest.spyOn(client, 'query');
  const controller = createTerminalStore(() => client);
  try {
    await controller.ensureHydrated('p', 'w');
    const first = controller.store.getState().worktrees['p/w'];
    expect(first.viewTokenPartial).toBe(true);
    expect(first.sessions.shown.live).toBe(true);
    up = true;
    await s.drainAll();
    s.markTerminalExited('p', 'w', 'shown', 0, null);
    await s.drainAll();
    const legacy = {
      ...fixture(),
      groups: [],
      activeGroupId: null,
      terminals: [
        {
          session: session('shown'),
          scrollbackLines: ['saved output'],
          exitCode: 0,
          signal: null,
        },
      ],
      terminalCustomNames: {},
      groupCustomNames: {},
    };
    fs.writeFileSync(legacyPath(), JSON.stringify(legacy));
    // Slice 3 RF5: only authority recovery can grant the recovered full view.
    await controller.store.getState().hydrateWorktree('p', 'w');
    controller.store.getState().applyExit({
      projectId: 'p',
      worktreeId: 'w',
      terminalId: 'shown',
      exitCode: 0,
      signal: null,
    });
    const retained = controller.store.getState().worktrees['p/w'];
    expect(retained.historyUnavailable).toBe(false);
    expect(retained.viewTokenPartial).toBe(false);
    expect(retained.viewToken).not.toBe(first.viewToken);
    expect(retained.sessions.shown.live).toBe(false);
    s.registerLiveSession(session('extra'));
    s.appendTerminalOutput('p', 'w', 'extra', Buffer.from('extra output'));
    s.markTerminalExited('p', 'w', 'extra', 0, null);
    await s.drainAll();
    up = false;
    fs.writeFileSync(
      legacyPath(),
      JSON.stringify({
        ...legacy,
        terminals: ['shown', 'extra'].map((id) => ({
          session: session(id),
          scrollbackLines: [id + ' output'],
          exitCode: 0,
          signal: null,
        })),
      }),
    );
    // Initial full, initial partial, covering retry: exactly 64 views.
    for (let view = 0; view < 61; view += 1)
      await s.loadWorktreeState('p', 'w');
    // Explicit hydration may adopt a full token; confirmation must preserve it.
    const beforeConfirmation = controller.store.getState();
    jest.useFakeTimers();
    controller.observeHistory('p', 'w');
    await jest.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(3);
    const result = load.mock.results[2];
    if (result.type !== 'return')
      throw new Error('Confirmation did not return');
    await result.value;
    await Promise.resolve();
    const afterConfirmation = controller.store.getState();
    const confirmed = afterConfirmation.worktrees['p/w'];
    expect(afterConfirmation.terminalCustomNames).toEqual(
      beforeConfirmation.terminalCustomNames,
    );
    expect(afterConfirmation.groupCustomNames).toEqual(
      beforeConfirmation.groupCustomNames,
    );
    controller.store.getState().removeTerminal('p', 'w', 'shown');
    await s.drainAll();
    controller.reset();
    jest.useRealTimers();
    up = true;
    await s.drainAll();
    fs.unlinkSync(legacyPath());
    authority.dispose();
    authority = newAuthority();
    const reloaded = await store().loadWorktreeState('p', 'w');
    expect(reloaded.terminals.map(({ session }) => session.id)).toEqual([
      'extra',
    ]);
    expect(reloaded.terminals[0].scrollbackLines).toEqual(['extra output']);
    // Slice 3 RF5: outage confirmation changes only the unavailable notice.
    expect(confirmed).toEqual({ ...retained, historyUnavailable: true });
    expect(confirmed.viewToken).toBe(
      beforeConfirmation.worktrees['p/w'].viewToken,
    );
    expect(confirmed.viewTokenPartial).toBe(
      beforeConfirmation.worktrees['p/w'].viewTokenPartial,
    );
    expect(confirmed.sessions.extra).toBeUndefined();
    expect(query).toHaveBeenLastCalledWith('terminal.worktreeState.get', {
      projectId: 'p',
      worktreeId: 'w',
      historyConfirmationOnly: true,
    });
  } finally {
    controller.reset();
    query.mockRestore();
    jest.useRealTimers();
  }
});

it("Observational outage confirmation preserves another view's unseen name through a later layout save", async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('shown'));
  s.markTerminalExited('p', 'w', 'shown', 0, null);
  await s.drainAll();
  const load = jest.fn(
    (
      request: LoadWorktreeTerminalStateRequest,
    ): Promise<LoadWorktreeTerminalStateResponse> =>
      s.loadWorktreeState(
        request.projectId,
        request.worktreeId,
        request.historyStatusOnly,
        request.historyConfirmationOnly,
        request.retainedViewToken,
      ),
  );
  const client = durableTerminalClientFor(s, load);
  const query = jest.spyOn(client, 'query');
  const controller = createTerminalStore(() => client);
  try {
    await controller.ensureHydrated('p', 'w');
    const paneA = controller.store.getState().worktrees['p/w'];
    expect(
      controller.store.getState().terminalCustomNames.shown,
    ).toBeUndefined();
    const viewB = await s.loadWorktreeState('p', 'w');
    s.saveWorktreeState({
      ...viewB,
      projectId: 'p',
      worktreeId: 'w',
      terminalCustomNames: { shown: 'Other pane name' },
    });
    await s.drainAll();
    fs.writeFileSync(
      legacyPath(),
      JSON.stringify({
        ...fixture(),
        groups: viewB.groups,
        terminals: viewB.terminals,
        terminalCustomNames: { shown: 'Other pane name' },
      }),
    );
    up = false;
    jest.useFakeTimers();
    controller.observeHistory('p', 'w');
    await jest.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    const result = load.mock.results[1];
    if (result.type !== 'return')
      throw new Error('Confirmation did not return');
    await result.value;
    await Promise.resolve();
    const confirmed = controller.store.getState().worktrees['p/w'];
    // Slice 3 RF5: readable fallback cannot clear the authority outage notice.
    expect(confirmed.historyUnavailable).toBe(true);
    expect(
      controller.store.getState().terminalCustomNames.shown,
    ).toBeUndefined();
    controller.store
      .getState()
      .setDrawerCollapsed('p', 'w', !paneA.drawerCollapsed);
    // Presentation-only saves use the 100 ms debounce, not the record outbox.
    await jest.advanceTimersByTimeAsync(100);
    await s.drainAll();
    controller.reset();
    jest.useRealTimers();
    up = true;
    await s.drainAll();
    fs.unlinkSync(legacyPath());
    authority.dispose();
    authority = newAuthority();
    const reloaded = await store().loadWorktreeState('p', 'w');
    expect(reloaded.terminalCustomNames.shown).toBe('Other pane name');
    expect(reloaded.drawerCollapsed).toBe(!paneA.drawerCollapsed);
    expect(confirmed.viewToken).toBe(paneA.viewToken);
    expect(confirmed.viewTokenPartial).toBe(paneA.viewTokenPartial);
    expect(query).toHaveBeenLastCalledWith('terminal.worktreeState.get', {
      projectId: 'p',
      worktreeId: 'w',
      historyConfirmationOnly: true,
    });
  } finally {
    controller.reset();
    query.mockRestore();
    jest.useRealTimers();
  }
});

it('outage confirmation serving an extra terminal cannot authorize its deletion', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('cached'));
  s.markTerminalExited('p', 'w', 'cached', 0, null);
  await s.drainAll();
  const load = jest.fn(
    (
      request: LoadWorktreeTerminalStateRequest,
    ): Promise<LoadWorktreeTerminalStateResponse> =>
      s.loadWorktreeState(
        request.projectId,
        request.worktreeId,
        request.historyStatusOnly,
        request.historyConfirmationOnly,
        request.retainedViewToken,
      ),
  );
  const controller = createTerminalStore(() =>
    durableTerminalClientFor(s, load),
  );
  try {
    await controller.ensureHydrated('p', 'w');
    const before = controller.store.getState().worktrees['p/w'];
    expect(Object.keys(before.sessions)).toEqual(['cached']);
    // Another drawer creates this terminal after our view was loaded.
    s.registerLiveSession(session('extra'));
    s.appendTerminalOutput('p', 'w', 'extra', Buffer.from('extra'));
    s.markTerminalExited('p', 'w', 'extra', 0, null);
    await s.drainAll();
    const full = await s.loadWorktreeState('p', 'w');
    fs.writeFileSync(
      legacyPath(),
      JSON.stringify({
        ...fixture(),
        terminals: full.terminals,
      }),
    );
    up = false;
    jest.useFakeTimers();
    controller.observeHistory('p', 'w');
    await jest.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    const result = load.mock.results[1];
    if (result.type !== 'return')
      throw new Error('Confirmation did not return');
    const confirmation = await result.value;
    // Slice 3 RF5: legacy alone leaves authority history unavailable.
    expect(confirmation.history?.status).toBe('unavailable');
    expect(confirmation.terminals).toEqual([]);
    expect(confirmation.viewToken).toBeUndefined();
    await Promise.resolve();
    const after = controller.store.getState().worktrees['p/w'];
    expect(after.viewToken).toBe(before.viewToken);
    expect(after.sessions).toEqual(before.sessions);
    controller.store.getState().removeTerminal('p', 'w', 'cached');
    await s.drainAll();
    controller.reset();
    jest.useRealTimers();
    up = true;
    await s.drainAll();
    fs.unlinkSync(legacyPath());
    authority.dispose();
    authority = newAuthority();
    const reloaded = await store().loadWorktreeState('p', 'w');
    // Close stays durable: only the confirmation-served terminal survives.
    expect(reloaded.terminals.map(({ session }) => session.id)).toEqual([
      'extra',
    ]);
    expect(
      reloaded.terminals.find(({ session }) => session.id === 'extra')
        ?.scrollbackLines,
    ).toEqual(['extra']);
  } finally {
    controller.reset();
    jest.useRealTimers();
  }
});

it.each([false, true])(
  "partial history refresh omitting a live terminal's saved binding preserves exactly one membership (Try again: %s)",
  async (retry) => {
    const s = store();
    const initial = await s.loadWorktreeState('p', 'w');
    s.registerLiveSession(session('running'));
    s.saveWorktreeState({
      ...initial,
      projectId: 'p',
      worktreeId: 'w',
      groups: [
        {
          id: 'saved-live',
          terminalIds: ['running'],
          focusedTerminalId: 'running',
          splitSizes: [1],
        },
      ],
      activeGroupId: 'saved-live',
      groupOrdinals: { 'saved-live': 3 },
      nextGroupOrdinal: 4,
    });
    await s.drainAll();
    const load = jest.fn(
      (
        request: LoadWorktreeTerminalStateRequest,
      ): Promise<LoadWorktreeTerminalStateResponse> =>
        s.loadWorktreeState(
          request.projectId,
          request.worktreeId,
          request.historyStatusOnly,
          request.historyConfirmationOnly,
          request.retainedViewToken,
        ),
    );
    const controller = createTerminalStore(() =>
      durableTerminalClientFor(s, load),
    );
    try {
      await controller.ensureHydrated('p', 'w');
      const fullToken = controller.store.getState().worktrees['p/w'].viewToken;
      up = false;
      jest.useFakeTimers();
      controller.observeHistory('p', 'w');
      await jest.advanceTimersByTimeAsync(0);
      const result = load.mock.results[1];
      if (result.type !== 'return') throw new Error('Load did not return');
      const confirmation = await result.value;
      expect(confirmation.terminals).toEqual([]);
      const partial = await s.loadWorktreeState('p', 'w');
      expect(partial.history?.status).toBe('unavailable');
      // An outage load serves the bindings main last read (slice 3a), never
      // a synthesized `live/` group beside the saved one.
      expect(partial.groups).toEqual([
        expect.objectContaining({
          id: 'saved-live',
          terminalIds: ['running'],
        }),
      ]);
      if (retry) await controller.store.getState().hydrateWorktree('p', 'w');
      const bucket = controller.store.getState().worktrees['p/w'];
      expect(
        bucket.groups
          .filter((group) => group.terminalIds.includes('running'))
          .map((group) => group.id),
      ).toEqual(['saved-live']);
      if (!retry) expect(bucket.viewToken).toBe(fullToken);
      controller.store
        .getState()
        .setDrawerCollapsed('p', 'w', !bucket.drawerCollapsed);
      await s.drainAll();
      controller.reset();
      jest.useRealTimers();
      up = true;
      await s.drainAll();
      const reloaded = await store().loadWorktreeState('p', 'w');
      expect(
        reloaded.groups
          .filter((group) => group.terminalIds.includes('running'))
          .map((group) => group.id),
      ).toEqual(['saved-live']);
    } finally {
      controller.reset();
      jest.useRealTimers();
    }
  },
);

it("an outage retry keeps a split in its saved group when the split's save never reached main", async () => {
  const s = store();
  const initial = await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('running'));
  s.saveWorktreeState({
    ...initial,
    projectId: 'p',
    worktreeId: 'w',
    groups: [
      {
        id: 'saved-live',
        terminalIds: ['running'],
        focusedTerminalId: 'running',
        splitSizes: [1],
      },
    ],
    activeGroupId: 'saved-live',
    groupOrdinals: { 'saved-live': 3 },
    nextGroupOrdinal: 4,
  });
  await s.drainAll();
  const durable = durableTerminalClientFor(s);
  let saveLost = false;
  const client: TerminalClient = {
    ...durable,
    command: (name, args) =>
      saveLost && name === 'terminal.worktreeState.save'
        ? Promise.reject(new Error('transport lost'))
        : durable.command(name, args),
  };
  const controller = createTerminalStore(() => client);
  try {
    await controller.ensureHydrated('p', 'w');
    up = false;
    jest.useFakeTimers();
    controller.observeHistory('p', 'w');
    await jest.advanceTimersByTimeAsync(0);
    s.registerLiveSession(session('second'));
    saveLost = true;
    controller.store
      .getState()
      .splitGroup('p', 'w', 'saved-live', session('second'));
    saveLost = false;
    // Without the split's binding, main's outage load gives the new shell
    // its own `live/` group; the drawer must not regroup it there.
    const partial = await s.loadWorktreeState('p', 'w');
    expect(partial.history?.status).toBe('unavailable');
    expect(
      partial.groups.some(
        (group) =>
          group.id !== 'saved-live' && group.terminalIds.includes('second'),
      ),
    ).toBe(true);
    await controller.store.getState().hydrateWorktree('p', 'w');
    const bucket = controller.store.getState().worktrees['p/w'];
    expect(
      bucket.groups.map(({ id, terminalIds }) => ({ id, terminalIds })),
    ).toEqual([{ id: 'saved-live', terminalIds: ['running', 'second'] }]);
  } finally {
    controller.reset();
    jest.useRealTimers();
  }
});

it('retry after an initial partial load materializes a newly readable missing bound session', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('bound'));
  s.markTerminalExited('p', 'w', 'bound', 0, null);
  await s.drainAll();
  up = false;
  const controller = createTerminalStore(() => durableTerminalClientFor(s));
  try {
    await controller.ensureHydrated('p', 'w');
    expect(
      controller.store.getState().worktrees['p/w'].sessions.bound,
    ).toBeUndefined();
    up = true;
    await controller.store.getState().hydrateWorktree('p', 'w');
    expect(
      controller.store.getState().worktrees['p/w'].sessions.bound,
    ).toBeDefined();
    controller.store.getState().removeTerminal('p', 'w', 'bound');
    await s.drainAll();
    expect((await store().loadWorktreeState('p', 'w')).terminals).toEqual([]);
  } finally {
    controller.reset();
  }
});

it('a mixed partial retry materializes a new session without dropping an omitted cached session', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('cached'));
  s.markTerminalExited('p', 'w', 'cached', 0, null);
  await s.drainAll();
  const load = jest.fn(
    (
      request: LoadWorktreeTerminalStateRequest,
    ): Promise<LoadWorktreeTerminalStateResponse> =>
      s.loadWorktreeState(
        request.projectId,
        request.worktreeId,
        request.historyStatusOnly,
        request.historyConfirmationOnly,
        request.retainedViewToken,
      ),
  );
  const controller = createTerminalStore(() =>
    durableTerminalClientFor(s, load),
  );
  try {
    await controller.ensureHydrated('p', 'w');
    const fullToken = controller.store.getState().worktrees['p/w'].viewToken;
    controller.store.getState().setTerminalName('p', 'w', 'cached', 'Cached');
    s.registerLiveSession(session('unseen'));
    s.markTerminalExited('p', 'w', 'unseen', 0, null);
    await s.drainAll();
    const other = await s.loadWorktreeState('p', 'w');
    s.saveWorktreeState({
      ...other,
      projectId: 'p',
      worktreeId: 'w',
      terminalCustomNames: {
        ...other.terminalCustomNames,
        unseen: 'Other drawer',
      },
    });
    await s.drainAll();
    up = false;
    s.registerLiveSession(session('newly-bound'));
    await controller.store.getState().hydrateWorktree('p', 'w');
    const result = load.mock.results[1];
    if (result.type !== 'return') throw new Error('Load did not return');
    const partial = await result.value;
    expect(partial.terminals.map(({ session }) => session.id)).toEqual([
      'newly-bound',
    ]);
    const bucket = controller.store.getState().worktrees['p/w'];
    expect(bucket.sessions.cached.live).toBe(false);
    expect(bucket.sessions['newly-bound'].live).toBe(true);
    expect(bucket.viewToken).toBe(partial.viewToken);
    expect(bucket.viewToken).not.toBe(fullToken);
    expect(bucket.groups.flatMap((group) => group.terminalIds).sort()).toEqual([
      'cached',
      'newly-bound',
    ]);
    controller.store
      .getState()
      .setTerminalName('p', 'w', 'newly-bound', 'Recovered');
    controller.store.getState().setTerminalName('p', 'w', 'cached', null);
    controller.store.getState().setTerminalName('p', 'w', 'newly-bound', null);
    await s.drainAll();
    up = true;
    await s.drainAll();
    authority.dispose();
    authority = newAuthority();
    const named = await store().loadWorktreeState('p', 'w');
    expect(named.terminalCustomNames).toEqual({ unseen: 'Other drawer' });
    expect(named.terminals.map(({ session }) => session.id).sort()).toEqual([
      'cached',
      'newly-bound',
      'unseen',
    ]);
    for (const id of ['cached', 'newly-bound']) {
      s.markTerminalExited('p', 'w', id, 0, null);
      controller.store.getState().applyExit({
        projectId: 'p',
        worktreeId: 'w',
        terminalId: id,
        exitCode: 0,
        signal: null,
      });
      controller.store.getState().removeTerminal('p', 'w', id);
      await s.drainAll();
    }
    controller.reset();
    authority.dispose();
    authority = newAuthority();
    const reloaded = await store().loadWorktreeState('p', 'w');
    expect(reloaded.terminals.map(({ session }) => session.id)).toEqual([
      'unseen',
    ]);
    expect(reloaded.terminalCustomNames).toEqual({ unseen: 'Other drawer' });
  } finally {
    controller.reset();
  }
});

it('readable legacy outage confirmation changes notices without replacing the cached layout view', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('cached'));
  s.appendTerminalOutput('p', 'w', 'cached', Buffer.from('cached output'));
  s.markTerminalExited('p', 'w', 'cached', 0, null);
  await s.drainAll();
  const load = jest.fn(
    (
      request: LoadWorktreeTerminalStateRequest,
    ): Promise<LoadWorktreeTerminalStateResponse> =>
      s.loadWorktreeState(
        request.projectId,
        request.worktreeId,
        request.historyStatusOnly,
        request.historyConfirmationOnly,
        request.retainedViewToken,
      ),
  );
  const controller = createTerminalStore(() =>
    durableTerminalClientFor(s, load),
  );
  try {
    await controller.ensureHydrated('p', 'w');
    controller.store
      .getState()
      .setTerminalName('p', 'w', 'cached', 'Cached name');
    await s.drainAll();
    const before = controller.store.getState();
    // A readable legacy file is different from the already displayed record.
    fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
    up = false;
    const partial = await s.loadWorktreeState('p', 'w');
    // Slice 3 RF5: readable legacy bytes remain visible during an authority outage.
    expect(partial.history?.status).toBe('unavailable');
    expect(partial.terminals.map(({ session }) => session.id)).toEqual([
      'a',
      'b',
    ]);
    jest.useFakeTimers();
    controller.observeHistory('p', 'w');
    await jest.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    await load.mock.results[1].value;
    await Promise.resolve();
    const after = controller.store.getState();
    // Slice 3 RF5: confirmation changes the notice, not the cached view.
    expect(after.worktrees['p/w'].historyUnavailable).toBe(true);
    expect(after.worktrees['p/w']).toEqual({
      ...before.worktrees['p/w'],
      historyUnavailable: true,
    });
    expect(after.terminalCustomNames).toEqual(before.terminalCustomNames);
    expect(after.groupCustomNames).toEqual(before.groupCustomNames);
  } finally {
    controller.reset();
    jest.useRealTimers();
  }
});

it('available recovery retaining a concurrently exited terminal preserves its durable close authority', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('shown'));
  await s.drainAll();
  let complete: () => void = () => {
    throw new Error('Load not started');
  };
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let signalIssued: () => void = () => {
    throw new Error('Barrier not initialized');
  };
  const issued = new Promise<void>((resolve) => {
    signalIssued = resolve;
  });
  const load = jest.fn(
    (
      request: LoadWorktreeTerminalStateRequest,
    ): Promise<LoadWorktreeTerminalStateResponse> =>
      s.loadWorktreeState(
        request.projectId,
        request.worktreeId,
        request.historyStatusOnly,
        request.historyConfirmationOnly,
        request.retainedViewToken,
      ),
  );
  const controller = createTerminalStore(() =>
    durableTerminalClientFor(s, load),
  );
  try {
    await controller.ensureHydrated('p', 'w');
    load.mockImplementationOnce(async (request) => {
      const response = await s.loadWorktreeState(
        request.projectId,
        request.worktreeId,
        request.historyStatusOnly,
        request.historyConfirmationOnly,
        request.retainedViewToken,
      );
      signalIssued();
      await pending;
      return response;
    });
    const hydration = controller.store.getState().hydrateWorktree('p', 'w');
    await issued;
    // The successor already exists in main; these saves still use its predecessor.
    controller.store
      .getState()
      .setTerminalName('p', 'w', 'shown', 'Local rename');
    s.registerLiveSession(session('concurrent'));
    controller.store.getState().addGroupWithTerminal(session('concurrent'));
    controller.store
      .getState()
      .setTerminalName('p', 'w', 'concurrent', 'Local addition');
    s.markTerminalExited('p', 'w', 'concurrent', 0, null);
    controller.store.getState().applyExit({
      projectId: 'p',
      worktreeId: 'w',
      terminalId: 'concurrent',
      exitCode: 0,
      signal: null,
    });
    await s.drainAll();
    complete();
    await hydration;
    expect(
      controller.store.getState().worktrees['p/w'].sessions.concurrent.live,
    ).toBe(false);
    expect(controller.store.getState().terminalCustomNames).toMatchObject({
      shown: 'Local rename',
      concurrent: 'Local addition',
    });
    // The successor's load never served 'concurrent'; only the predecessor's
    // save did, and that evidence lets the successor's omission ungroup it.
    const bucket = controller.store.getState().worktrees['p/w'];
    s.saveWorktreeState({
      projectId: 'p',
      worktreeId: 'w',
      drawerCollapsed: bucket.drawerCollapsed,
      groups: bucket.groups.filter(
        (group) => !group.terminalIds.includes('concurrent'),
      ),
      activeGroupId: null,
      nextGroupOrdinal: bucket.nextGroupOrdinal,
      groupOrdinals: bucket.groupOrdinals,
      terminalCustomNames: {},
      groupCustomNames: {},
      clearedTerminalNames: [],
      viewToken: bucket.viewToken,
    });
    await s.drainAll();
    authority.dispose();
    authority = newAuthority();
    const ungrouped = await store().loadWorktreeState('p', 'w');
    expect(ungrouped.terminals.map(({ session }) => session.id).sort()).toEqual(
      ['concurrent', 'shown'],
    );
    expect(ungrouped.groups.flatMap((group) => group.terminalIds)).toEqual([
      'shown',
    ]);
    for (const id of ['shown', 'concurrent'])
      controller.store.getState().setTerminalName('p', 'w', id, null);
    await s.drainAll();
    authority.dispose();
    authority = newAuthority();
    const cleared = await store().loadWorktreeState('p', 'w');
    expect(cleared.terminalCustomNames).toEqual({});
    expect(cleared.terminals.map(({ session }) => session.id).sort()).toEqual([
      'concurrent',
      'shown',
    ]);
    s.markTerminalExited('p', 'w', 'shown', 0, null);
    controller.store.getState().applyExit({
      projectId: 'p',
      worktreeId: 'w',
      terminalId: 'shown',
      exitCode: 0,
      signal: null,
    });
    for (const id of ['shown', 'concurrent'])
      controller.store.getState().removeTerminal('p', 'w', id);
    await s.drainAll();
    controller.reset();
    authority.dispose();
    authority = newAuthority();
    expect((await store().loadWorktreeState('p', 'w')).terminals).toEqual([]);
  } finally {
    controller.reset();
  }
});

it('a partial retry serves new names with cumulative Close and name authority', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('shown'));
  s.markTerminalExited('p', 'w', 'shown', 0, null);
  await s.drainAll();
  const controller = createTerminalStore(() => durableTerminalClientFor(s));
  try {
    await controller.ensureHydrated('p', 'w');
    const token = controller.store.getState().worktrees['p/w'].viewToken;
    // Another pane saves a name this drawer's full view never knew.
    const other = await s.loadWorktreeState('p', 'w');
    s.saveWorktreeState({
      ...other,
      projectId: 'p',
      worktreeId: 'w',
      terminalCustomNames: { shown: 'New name' },
    });
    await s.drainAll();
    fs.writeFileSync(
      legacyPath(),
      JSON.stringify({
        ...fixture(),
        groups: [],
        terminals: [
          {
            session: session('shown'),
            scrollbackLines: [],
            exitCode: 0,
            signal: null,
          },
        ],
        terminalCustomNames: { shown: 'New name' },
        groupCustomNames: {},
      }),
    );
    up = false;
    await controller.store.getState().hydrateWorktree('p', 'w');
    expect(controller.store.getState().terminalCustomNames.shown).toBe(
      'New name',
    );
    expect(controller.store.getState().worktrees['p/w'].viewToken).not.toBe(
      token,
    );
    // The newly served name must be clearable without a teaching save.
    controller.store.getState().setTerminalName('p', 'w', 'shown', null);
    const collapsed =
      !controller.store.getState().worktrees['p/w'].drawerCollapsed;
    controller.store.getState().setDrawerCollapsed('p', 'w', collapsed);
    await s.drainAll();
    up = true;
    await s.drainAll();
    authority.dispose();
    authority = newAuthority();
    const reloaded = await store().loadWorktreeState('p', 'w');
    expect(reloaded.terminalCustomNames.shown).toBeUndefined();
    expect(reloaded.terminals.map(({ session }) => session.id)).toContain(
      'shown',
    );
    expect(reloaded.drawerCollapsed).toBe(collapsed);
    expect(controller.store.getState().worktrees['p/w'].viewToken).not.toBe(
      token,
    );
  } finally {
    controller.reset();
  }
});

it('a partial retry carries cached name omission authority through reload', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(
    legacyPath(),
    JSON.stringify({ ...fixture(), terminalCustomNames: { a: 'Cached name' } }),
  );
  const s = store();
  await s.loadWorktreeState('p', 'w');
  await s.drainAll();
  // Reintroduce readable legacy history only as the offline fallback.
  fs.writeFileSync(
    legacyPath(),
    JSON.stringify({ ...fixture(), terminalCustomNames: { a: 'Cached name' } }),
  );
  up = false;
  const controller = createTerminalStore(() => durableTerminalClientFor(s));
  try {
    await controller.ensureHydrated('p', 'w');
    expect(controller.store.getState().terminalCustomNames.a).toBe(
      'Cached name',
    );
    // Omit the name while still serving every displayed terminal.
    fs.writeFileSync(
      legacyPath(),
      JSON.stringify({ ...fixture(), terminalCustomNames: {} }),
    );
    await controller.store.getState().hydrateWorktree('p', 'w');
    expect(controller.store.getState().terminalCustomNames.a).toBe(
      'Cached name',
    );
    controller.store.getState().setTerminalName('p', 'w', 'a', null);
    await s.drainAll();
    controller.reset();
    up = true;
    await s.drainAll();
    authority.dispose();
    authority = newAuthority();
    const reloaded = await store().loadWorktreeState('p', 'w');
    expect(reloaded.terminals.map(({ session }) => session.id)).toContain('a');
    if (reloaded.terminalCustomNames.a !== undefined)
      throw new Error('Cached name returned after clearing with retry token');
    expect(reloaded.terminalCustomNames.a).toBeUndefined();
  } finally {
    controller.reset();
  }
});

it('discarding a successor never widens its predecessor with unseen terminals or names', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('shown'));
  s.markTerminalExited('p', 'w', 'shown', 0, null);
  await s.drainAll();
  const predecessor = await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('unseen'));
  s.markTerminalExited('p', 'w', 'unseen', 0, null);
  const other = await s.loadWorktreeState('p', 'w');
  s.saveWorktreeState({
    ...other,
    projectId: 'p',
    worktreeId: 'w',
    terminalCustomNames: { shown: 'Unseen name', unseen: 'Other drawer' },
  });
  await s.drainAll();
  const discarded = await s.loadWorktreeState(
    'p',
    'w',
    false,
    false,
    predecessor.viewToken,
  );
  expect(discarded.terminals.map(({ session }) => session.id).sort()).toEqual([
    'shown',
    'unseen',
  ]);
  expect(discarded.terminalCustomNames.shown).toBe('Unseen name');
  // A cancelled/stale renderer reply never becomes its saving view.
  s.saveWorktreeState({
    ...predecessor,
    projectId: 'p',
    worktreeId: 'w',
    terminalCustomNames: {},
  });
  await s.drainAll();
  authority.dispose();
  authority = newAuthority();
  const reloaded = await store().loadWorktreeState('p', 'w');
  expect(reloaded.terminals.map(({ session }) => session.id).sort()).toEqual([
    'shown',
    'unseen',
  ]);
  // Omission ungroups (CAN-6616), so only an unwidened view keeps 'unseen' grouped.
  expect(reloaded.groups.flatMap((group) => group.terminalIds)).toContain(
    'unseen',
  );
  expect(reloaded.terminalCustomNames).toEqual({
    shown: 'Unseen name',
    unseen: 'Other drawer',
  });
});

it("an empty unavailable successor of a full view saves the drawer's collapse toggle", async () => {
  let exists = true;
  const s = newStore({
    records,
    outbox: newOutbox(),
    scopeExists: () => Promise.resolve(exists),
  });
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('shown'));
  s.markTerminalExited('p', 'w', 'shown', 0, null);
  await s.drainAll();
  const predecessor = await s.loadWorktreeState('p', 'w');
  exists = false;
  const empty = await s.loadWorktreeState(
    'p',
    'w',
    false,
    false,
    predecessor.viewToken,
  );
  expect(empty.terminals).toEqual([]);
  expect(empty.history?.status).toBe('unavailable');
  exists = true;
  s.saveWorktreeState({
    ...empty,
    projectId: 'p',
    worktreeId: 'w',
    drawerCollapsed: !predecessor.drawerCollapsed,
  });
  await s.drainAll();
  authority.dispose();
  authority = newAuthority();
  const reloaded = await store().loadWorktreeState('p', 'w');
  // The inherited view omits what its predecessor showed: ungrouped, with
  // its history (CAN-6616).
  expect(reloaded.terminals.map(({ session }) => session.id)).toEqual([
    'shown',
  ]);
  expect(reloaded.groups).toEqual([]);
  expect(reloaded.drawerCollapsed).toBe(!predecessor.drawerCollapsed);
});

it.each([true, false])(
  "a drawer's save keeps another drawer's unseen group layout (partial retry: %s)",
  async (retry) => {
    const s = store();
    await s.loadWorktreeState('p', 'w');
    const controller = createTerminalStore(() => durableTerminalClientFor(s));
    try {
      await controller.ensureHydrated('p', 'w');
      s.registerLiveSession(session('mine'));
      controller.store.getState().addGroupWithTerminal(session('mine'));
      await settle();
      await s.drainAll();
      // Another drawer adds a split, named group this drawer never loads.
      const other = await s.loadWorktreeState('p', 'w');
      s.registerLiveSession(session('x'));
      s.registerLiveSession(session('y'));
      const unseen = {
        id: 'unseen',
        terminalIds: ['y', 'x'],
        focusedTerminalId: 'x',
        splitSizes: [0.3, 0.7],
      };
      s.saveWorktreeState({
        ...other,
        projectId: 'p',
        worktreeId: 'w',
        groups: [...other.groups, unseen],
        groupCustomNames: { ...other.groupCustomNames, unseen: 'Other drawer' },
      });
      s.markTerminalExited('p', 'w', 'x', 0, null);
      s.markTerminalExited('p', 'w', 'y', 0, null);
      await s.drainAll();
      expect(
        (await store().loadWorktreeState('p', 'w')).groups.find(
          ({ id }) => id === 'unseen',
        ),
      ).toEqual(unseen);
      if (retry) {
        const token = controller.store.getState().worktrees['p/w'].viewToken;
        up = false;
        await controller.store.getState().hydrateWorktree('p', 'w');
        const bucket = controller.store.getState().worktrees['p/w'];
        expect(bucket.viewToken).not.toBe(token);
        // The retry saves as a partial view, whatever its predecessor was.
        expect(bucket.viewTokenPartial).toBe(true);
      }
      expect(
        controller.store
          .getState()
          .worktrees['p/w'].groups.flatMap(({ terminalIds }) => terminalIds),
      ).toEqual(['mine']);
      controller.store.getState().setTerminalName('p', 'w', 'mine', 'Renamed');
      await settle();
      await s.drainAll();
      up = true;
      await s.drainAll();
      controller.reset();
      authority.dispose();
      authority = newAuthority();
      const reloaded = await store().loadWorktreeState('p', 'w');
      expect(reloaded.groups.find(({ id }) => id === 'unseen')).toEqual(unseen);
      expect(reloaded.groupCustomNames.unseen).toBe('Other drawer');
      expect(reloaded.terminalCustomNames.mine).toBe('Renamed');
    } finally {
      controller.reset();
    }
  },
);

function recordedGroupIds(): string[] {
  return authority
    .open({
      projectId: 'p',
      worktreeId: 'w',
      legacyLayout: 'workspaces',
      incarnation: null,
    })
    .bindings.map(({ groupId }) => groupId);
}

const sharedSplit = (
  terminalIds: string[],
): LoadWorktreeTerminalStateResponse['groups'][number] => ({
  id: 'shared',
  terminalIds,
  focusedTerminalId: terminalIds[0],
  splitSizes: terminalIds.length === 2 ? [0.4, 0.6] : [1],
});

/** `a` in group `shared`; another drawer then splits it with `b`, which exits. */
async function sharedGroupSplitElsewhere(
  s: TerminalPersistenceStore,
  beforeSplit?: () => Promise<void>,
): Promise<void> {
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('a'));
  const first = await s.loadWorktreeState('p', 'w');
  s.saveWorktreeState({
    ...first,
    projectId: 'p',
    worktreeId: 'w',
    groups: [sharedSplit(['a'])],
    activeGroupId: 'shared',
  });
  await s.drainAll();
  await beforeSplit?.();
  const other = await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('b'));
  s.saveWorktreeState({
    ...other,
    projectId: 'p',
    worktreeId: 'w',
    groups: [sharedSplit(['a', 'b'])],
    activeGroupId: 'shared',
    groupCustomNames: { shared: 'Shared' },
  });
  s.markTerminalExited('p', 'w', 'b', 0, null);
  await s.drainAll();
}

it("a full view's partial retry renames without rebinding the group's unseen split", async () => {
  const s = store();
  const controller = createTerminalStore(() => durableTerminalClientFor(s));
  try {
    await sharedGroupSplitElsewhere(s, () =>
      controller.ensureHydrated('p', 'w'),
    );
    const full = controller.store.getState().worktrees['p/w'];
    expect(full.viewTokenPartial).toBe(false);
    up = false;
    await controller.store.getState().hydrateWorktree('p', 'w');
    const retried = controller.store.getState().worktrees['p/w'];
    expect(retried.historyUnavailable).toBe(true);
    controller.store.getState().setTerminalName('p', 'w', 'a', 'Renamed');
    await settle();
    await s.drainAll();
    up = true;
    await s.drainAll();
    controller.reset();
    const groupIds = recordedGroupIds();
    expect(new Set(groupIds).size).toBe(groupIds.length);
    authority.dispose();
    authority = newAuthority();
    const reloaded = await store().loadWorktreeState('p', 'w');
    expect(reloaded.groups).toEqual([sharedSplit(['a', 'b'])]);
    expect(reloaded.groupCustomNames.shared).toBe('Shared');
    expect(reloaded.terminalCustomNames.a).toBe('Renamed');
    // A partial retry never inherits whole-layout authority from a full view.
    // Asserted last so a regression first trips the saved-layout checks above.
    expect(retried.viewTokenPartial).toBe(true);
  } finally {
    controller.reset();
  }
});

it.each([false, true])(
  "a full view's save during an outage reuses the record's binding keys (outage: %s)",
  async (outage) => {
    const s = store();
    let stale: LoadWorktreeTerminalStateResponse | undefined;
    await sharedGroupSplitElsewhere(s, async () => {
      stale = await s.loadWorktreeState('p', 'w');
    });
    if (!stale) throw new Error('Expected the stale full view');
    expect(stale.history?.status).toBe('available');
    if (outage) {
      up = false;
      // Another drawer's outage load replaces the shadow it can read.
      const retry = await s.loadWorktreeState('p', 'w');
      expect(retry.history?.status).toBe('unavailable');
    }
    s.saveWorktreeState({
      ...stale,
      projectId: 'p',
      worktreeId: 'w',
      terminalCustomNames: { a: 'Renamed' },
    });
    await s.drainAll();
    up = true;
    await s.drainAll();
    const groupIds = recordedGroupIds();
    expect(new Set(groupIds).size).toBe(groupIds.length);
    authority.dispose();
    authority = newAuthority();
    const reloaded = await store().loadWorktreeState('p', 'w');
    expect(
      reloaded.groups.map(({ id, terminalIds }) => ({ id, terminalIds })),
    ).toEqual([{ id: 'shared', terminalIds: ['a', 'b'] }]);
    expect(reloaded.terminalCustomNames.a).toBe('Renamed');
  },
);

it("an outage load that reads another lineage's legacy file keeps the record's layout", async () => {
  const s = store();
  await sharedGroupSplitElsewhere(s);
  const path = join(legacyPath(), '..', 'terminal-presentation.json');
  const installed: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  up = false;
  const outage = await s.loadWorktreeState('p', 'w');
  expect(outage.history?.status).toBe('unavailable');
  await s.drainAll();
  s.flushAllSync();
  expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toEqual(installed);
  up = true;
  fs.unlinkSync(legacyPath());
  authority.dispose();
  authority = newAuthority();
  const reloaded = await store().loadWorktreeState('p', 'w');
  expect(reloaded.groups).toEqual([sharedSplit(['a', 'b'])]);
  expect(reloaded.groupCustomNames.shared).toBe('Shared');
});

it.each([false, true])(
  "forgetting a terminal during an outage keeps an unseen group's layout (legacy file: %s)",
  async (legacy) => {
    const s = store();
    await s.loadWorktreeState('p', 'w');
    for (const id of ['a', 'x', 'y']) s.registerLiveSession(session(id));
    const first = await s.loadWorktreeState('p', 'w');
    const unseen = {
      id: 'unseen',
      terminalIds: ['x', 'y'],
      focusedTerminalId: 'y',
      splitSizes: [0.3, 0.7],
    };
    s.saveWorktreeState({
      ...first,
      projectId: 'p',
      worktreeId: 'w',
      groups: [
        {
          id: 'mine',
          terminalIds: ['a'],
          focusedTerminalId: 'a',
          splitSizes: [1],
        },
        unseen,
      ],
      groupCustomNames: { unseen: 'Unseen' },
      activeGroupId: 'mine',
    });
    s.markTerminalExited('p', 'w', 'x', 0, null);
    s.markTerminalExited('p', 'w', 'y', 0, null);
    await s.drainAll();
    if (legacy) fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
    up = false;
    // Exited and unreadable, the unseen group is not served during the outage.
    const outage = await s.loadWorktreeState('p', 'w');
    expect(outage.history?.status).toBe('unavailable');
    expect(outage.groups.some(({ id }) => id === 'unseen')).toBe(false);
    s.forget('a');
    await s.drainAll();
    up = true;
    await s.drainAll();
    if (legacy) fs.unlinkSync(legacyPath());
    const groupIds = recordedGroupIds();
    expect(new Set(groupIds).size).toBe(groupIds.length);
    authority.dispose();
    authority = newAuthority();
    const reloaded = await store().loadWorktreeState('p', 'w');
    expect(reloaded.groups).toEqual([unseen]);
    expect(reloaded.groupCustomNames.unseen).toBe('Unseen');
  },
);

it('partial successors remember membership edits saved on the predecessor after issuance', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  const s = store();
  await s.loadWorktreeState('p', 'w');
  await s.drainAll();
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  up = false;
  let release = (): void => {
    throw new Error('not initialized');
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalIssued = (): void => {
    throw new Error('not initialized');
  };
  const issued = new Promise<void>((resolve) => {
    signalIssued = resolve;
  });
  const load = jest.fn((request: LoadWorktreeTerminalStateRequest) =>
    s.loadWorktreeState(
      request.projectId,
      request.worktreeId,
      request.historyStatusOnly,
      request.historyConfirmationOnly,
      request.retainedViewToken,
    ),
  );
  const controller = createTerminalStore(() =>
    durableTerminalClientFor(s, load),
  );
  try {
    await controller.ensureHydrated('p', 'w');
    load.mockImplementationOnce(async (request) => {
      let response = await s.loadWorktreeState(
        request.projectId,
        request.worktreeId,
        false,
        false,
        request.retainedViewToken,
      );
      for (let i = 0; i < 2; i += 1)
        response = await s.loadWorktreeState(
          request.projectId,
          request.worktreeId,
          false,
          false,
          response.viewToken,
        );
      signalIssued();
      await gate;
      return response;
    });
    const hydration = controller.store.getState().hydrateWorktree('p', 'w');
    await issued;
    controller.store.getState().addGroupWithTerminal(session('a'));
    await s.drainAll();
    up = true;
    await s.drainAll();
    const other = await s.loadWorktreeState('p', 'w');
    s.saveWorktreeState({
      ...other,
      projectId: 'p',
      worktreeId: 'w',
      groups: [
        {
          id: 'external',
          terminalIds: ['a', 'b'],
          focusedTerminalId: 'a',
          splitSizes: [0.5, 0.5],
        },
      ],
      activeGroupId: 'external',
    });
    await s.drainAll();
    up = false;
    release();
    await hydration;
    controller.store.getState().setTerminalName('p', 'w', 'a', 'Local name');
    await s.drainAll();
    controller.reset();
    up = true;
    await s.drainAll();
    fs.unlinkSync(legacyPath());
    authority.dispose();
    authority = newAuthority();
    const reloaded = await store().loadWorktreeState('p', 'w');
    expect(reloaded.terminalCustomNames.a).toBe('Local name');
    expect(
      reloaded.groups.map(({ id, terminalIds }) => ({ id, terminalIds })),
    ).toEqual([{ id: 'external', terminalIds: ['a', 'b'] }]);
  } finally {
    release();
    controller.reset();
  }
});

it.each([false, true])(
  'partial-only successors retain membership baselines without gaining presentation authority (new siblings: %s)',
  async (newSiblings) => {
    fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
    fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
    const s = store();
    const full = await s.loadWorktreeState('p', 'w');
    await s.drainAll();
    fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
    up = false;
    const controller = createTerminalStore(() => durableTerminalClientFor(s));
    try {
      await controller.ensureHydrated('p', 'w');
      expect(
        controller.store.getState().worktrees['p/w'].viewTokenPartial,
      ).toBe(true);
      fs.unlinkSync(legacyPath());
      up = true;
      if (newSiblings) {
        s.registerLiveSession(session('c'));
        s.markTerminalExited('p', 'w', 'c', 0, null);
      }
      const other = await s.loadWorktreeState('p', 'w');
      const otherIds = newSiblings ? ['a', 'b', 'c'] : ['a', 'b'];
      s.saveWorktreeState({
        ...other,
        projectId: 'p',
        worktreeId: 'w',
        groups: [
          {
            id: 'other-group',
            terminalIds: otherIds,
            focusedTerminalId: 'a',
            splitSizes: otherIds.map(() => 1 / otherIds.length),
          },
        ],
        activeGroupId: 'other-group',
        drawerCollapsed: !full.drawerCollapsed,
      });
      await s.drainAll();
      up = false;
      if (newSiblings) {
        const fallback = fixture();
        fallback.groups = [
          {
            id: 'g',
            terminalIds: ['b', 'c'],
            focusedTerminalId: 'b',
            splitSizes: [0.5, 0.5],
          },
        ];
        fallback.terminals = ['b', 'c'].map((id) => ({
          session: session(id),
          scrollbackLines: [id],
          exitCode: 0,
          signal: null,
        }));
        fs.writeFileSync(legacyPath(), JSON.stringify(fallback));
      }
      await controller.store.getState().hydrateWorktree('p', 'w');
      expect(
        controller.store
          .getState()
          .worktrees[
            'p/w'
          ].groups.map(({ id, terminalIds }) => ({ id, terminalIds })),
      ).toEqual([
        { id: 'g', terminalIds: newSiblings ? ['b', 'c', 'a'] : ['a', 'b'] },
      ]);
      controller.store.getState().setTerminalName('p', 'w', 'a', 'Local name');
      controller.store
        .getState()
        .setDrawerCollapsed('p', 'w', full.drawerCollapsed);
      await s.drainAll();
      up = true;
      await s.drainAll();
      if (newSiblings) fs.unlinkSync(legacyPath());
      authority.dispose();
      authority = newAuthority();
      const reloaded = await store().loadWorktreeState('p', 'w');
      expect(
        reloaded.groups.map(({ id, terminalIds }) => ({ id, terminalIds })),
      ).toEqual([{ id: 'other-group', terminalIds: otherIds }]);
      expect(reloaded.drawerCollapsed).toBe(!full.drawerCollapsed);
      expect(reloaded.terminalCustomNames).toEqual({
        a: 'Local name',
        b: 'Build',
      });
    } finally {
      controller.reset();
    }
  },
);

it('full recovery of known live sessions restores durable name and layout edits', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('shown'));
  const full = await s.loadWorktreeState('p', 'w');
  s.saveWorktreeState({
    ...full,
    projectId: 'p',
    worktreeId: 'w',
    drawerCollapsed: false,
    terminalCustomNames: { shown: 'Saved name' },
  });
  await s.drainAll();
  up = false;
  const controller = createTerminalStore(() => durableTerminalClientFor(s));
  try {
    await controller.ensureHydrated('p', 'w');
    expect(
      controller.store.getState().worktrees['p/w'].sessions.shown,
    ).toBeDefined();
    expect(
      controller.store.getState().terminalCustomNames.shown,
    ).toBeUndefined();
    up = true;
    await controller.store.getState().hydrateWorktree('p', 'w');
    expect(controller.store.getState().terminalCustomNames.shown).toBe(
      'Saved name',
    );
    controller.store.getState().setTerminalName('p', 'w', 'shown', null);
    controller.store.getState().setDrawerCollapsed('p', 'w', true);
    await s.drainAll();
    const reloaded = await store().loadWorktreeState('p', 'w');
    expect({
      name: reloaded.terminalCustomNames.shown,
      collapsed: reloaded.drawerCollapsed,
    }).toEqual({ name: undefined, collapsed: true });
  } finally {
    controller.reset();
  }
});

it('repeated covering refreshes keep durable close authority after old views expire', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('shown'));
  s.markTerminalExited('p', 'w', 'shown', 0, null);
  await s.drainAll();
  const controller = createTerminalStore(() => durableTerminalClientFor(s));
  try {
    await controller.ensureHydrated('p', 'w');
    // Main bounds served views to 64, so the original token is now expired.
    for (let i = 0; i < 65; i += 1)
      await controller.store.getState().hydrateWorktree('p', 'w');
    controller.store.getState().removeTerminal('p', 'w', 'shown');
    await s.drainAll();
    expect(
      (await store().loadWorktreeState('p', 'w')).terminals.map(
        ({ session }) => session.id,
      ),
    ).not.toContain('shown');
  } finally {
    controller.reset();
  }
});

it('an open drawer observes unsaved history and refreshes displayed history on recovery', async () => {
  const outbox = newOutbox();
  const s = newStore({ records, outbox });
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('shown'));
  s.appendTerminalOutput('p', 'w', 'shown', Buffer.from('before\n'));
  s.markTerminalExited('p', 'w', 'shown', 0, null);
  await s.drainAll();
  const controller = createTerminalStore(() => terminalClientFor(s));
  const bucket = (): ReturnType<
    typeof controller.store.getState
  >['worktrees'][string] => controller.store.getState().worktrees['p/w'];
  const waitFor = (condition: () => boolean): Promise<void> =>
    new Promise((resolve, reject) => {
      if (condition()) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        release();
        reject(new Error('Terminal status did not refresh'));
      }, 3_000);
      const release = controller.store.subscribe(() => {
        if (!condition()) return;
        clearTimeout(timeout);
        release();
        resolve();
      });
    });
  await controller.store.getState().hydrateWorktree('p', 'w');
  expect(bucket().sessions.shown.scrollbackLines).toEqual(['before', '']);
  up = false;
  await controller.store.getState().hydrateWorktree('p', 'w');
  expect(bucket().historyUnavailable).toBe(true);
  const failWrite = jest
    .spyOn(outbox, 'write')
    .mockRejectedValue(new Error('disk full'));
  s.registerLiveSession(session('still-running'));
  s.appendTerminalOutput('p', 'w', 'still-running', Buffer.from('kept\n'));
  await s.drainAll();
  expect(bucket().historyHeld).toBe(false);
  const release = controller.observeHistory('p', 'w');
  const releaseSecondPane = controller.observeHistory('p', 'w');
  try {
    await waitFor(() => bucket().historyHeld === true);
    expect(bucket().sessions.shown.scrollbackLines).toEqual(['before', '']);
    expect(bucket().historyUnavailable).toBe(true);
    releaseSecondPane(); // The first pane still owns its refresh.
    releaseSecondPane(); // Releasing a lease twice cannot stop the other pane.
    failWrite.mockRestore();
    up = true;
    await s.drainAll();
    await records.apply({
      client: {
        projectId: 'p',
        worktreeId: 'w',
        legacyLayout: 'workspaces',
        incarnation: null,
      },
      producer: { id: 'electron_main', runId: 'recovery-output' },
      seq: 1,
      ops: [{ op: 'output.append', terminalId: 'shown', text: 'after\n' }],
    });
    await waitFor(
      () =>
        bucket().historyHeld === false && bucket().historyUnavailable === false,
    );
    expect(bucket().sessions.shown.scrollbackLines).toEqual([
      'before',
      'after',
      '',
    ]);
    expect(bucket().historyRevision).toBe(1);
    expect(bucket().sessions['still-running'].live).toBe(true);
    expect(bucket().sessions['still-running'].scrollbackLines).toEqual([
      'kept',
      '',
    ]);
  } finally {
    release();
    releaseSecondPane();
    controller.reset();
    failWrite.mockRestore();
  }
});

it('post-hydration outages publish unavailable history, retain output and recover live', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('shown'));
  s.appendTerminalOutput('p', 'w', 'shown', Buffer.from('cached\n'));
  s.markTerminalExited('p', 'w', 'shown', 0, null);
  await s.drainAll();
  const load = jest.fn(
    (
      request: LoadWorktreeTerminalStateRequest,
    ): Promise<LoadWorktreeTerminalStateResponse> =>
      s.loadWorktreeState(
        request.projectId,
        request.worktreeId,
        request.historyStatusOnly,
        request.historyConfirmationOnly,
        request.retainedViewToken,
      ),
  );
  const controller = createTerminalStore(() =>
    terminalClientFor(s, undefined, load),
  );
  const bucket = (): WorktreeTerminalBucket =>
    controller.store.getState().worktrees['p/w'];
  await controller.ensureHydrated('p', 'w');
  expect(bucket().historyUnavailable).toBe(false);
  const cached = bucket().sessions.shown;
  up = false;
  jest.useFakeTimers();
  const release = controller.observeHistory('p', 'w');
  try {
    await jest.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    await load.mock.results[1].value;
    await Promise.resolve();
    // This is the shared panel's unavailable-notice / Try again condition.
    expect(bucket().historyUnavailable && !bucket().sessions.shown.live).toBe(
      true,
    );
    expect(bucket().sessions.shown).toEqual(cached);
    await controller.ensureHydrated('p', 'w');
    await jest.advanceTimersByTimeAsync(6_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(bucket().historyUnavailable).toBe(true);
    // Try again bypasses the automatic outage confirmation limit.
    await controller.store.getState().hydrateWorktree('p', 'w');
    expect(load).toHaveBeenCalledTimes(3);
    expect(bucket().historyUnavailable).toBe(true);
    expect(bucket().sessions.shown).toEqual(cached);
    up = true;
    await jest.advanceTimersByTimeAsync(2_000);
    expect(load).toHaveBeenCalledTimes(4);
    await load.mock.results[3].value;
    await Promise.resolve();
    expect(bucket().historyUnavailable).toBe(false);
    expect(bucket().historyRevision).toBe(1);
    expect(bucket().sessions.shown.scrollbackLines).toEqual(['cached', '']);
  } finally {
    release();
    controller.reset();
    jest.useRealTimers();
  }
});

it('post-hydration outage confirmation checks readable legacy history only once per outage', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  // Keep main's readable fallback while the daemon cannot import the source.
  const original = fsModule.readFileSync;
  const read = jest
    .spyOn(fsModule, 'readFileSync')
    .mockImplementation((path, options) => {
      if (path === legacyPath())
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return original(path, options);
    });
  const s = store();
  let complete: () => void = () => {
    throw new Error('Confirmation not started');
  };
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let holdResponse = false;
  const load = jest.fn(async (request: LoadWorktreeTerminalStateRequest) => {
    const response = await s.loadWorktreeState(
      request.projectId,
      request.worktreeId,
      request.historyStatusOnly,
      request.historyConfirmationOnly,
      request.retainedViewToken,
    );
    if (holdResponse) await gate;
    return response;
  });
  let historyHeld = false;
  const probe = async (): Promise<LoadWorktreeTerminalStateResponse> => ({
    ...(await s.loadWorktreeState('p', 'w', true)),
    historyHeld,
  });
  const controller = createTerminalStore(() =>
    terminalClientFor(s, probe, load),
  );
  let sawUnavailable = false;
  const unsubscribe = controller.store.subscribe((state) => {
    if (state.worktrees['p/w']?.historyUnavailable) sawUnavailable = true;
  });
  try {
    await controller.ensureHydrated('p', 'w');
    expect(
      controller.store.getState().worktrees['p/w'].historyUnavailable,
    ).toBe(false);
    const cachedToken = controller.store.getState().worktrees['p/w'].viewToken;
    up = false;
    historyHeld = true;
    holdResponse = true;
    jest.useFakeTimers();
    const release = controller.observeHistory('p', 'w');
    await jest.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    expect(
      controller.store.getState().worktrees['p/w'].historyUnavailable,
    ).toBe(false);
    expect(sawUnavailable).toBe(false);
    expect(controller.store.getState().worktrees['p/w'].historyHeld).toBe(true);
    expect(
      controller.store.getState().worktrees['p/w'].sessions.a.scrollbackLines,
    ).toEqual(['A0']);
    historyHeld = false;
    complete();
    const confirmationResult = load.mock.results[1];
    if (confirmationResult.type !== 'return') {
      throw new Error('Confirmation did not return a response');
    }
    const confirmation = await confirmationResult.value;
    await Promise.resolve();
    const bucket = controller.store.getState().worktrees['p/w'];
    // Slice 3 RF5: readable legacy history cannot clear an authority outage.
    expect(bucket.historyUnavailable).toBe(true);
    expect(bucket.historyHeld).toBe(false);
    expect(bucket.sessions.a.scrollbackLines).toEqual(['A0']);
    expect(bucket.viewToken).toBe(cachedToken);
    expect(confirmation.viewToken).toBeUndefined();
    expect(confirmation.terminals).toEqual([]);
    expect(load).toHaveBeenLastCalledWith({
      projectId: 'p',
      worktreeId: 'w',
      historyConfirmationOnly: true,
    });
    await jest.advanceTimersByTimeAsync(6_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(
      controller.store.getState().worktrees['p/w'].historyUnavailable,
    ).toBe(true); // Slice 3 RF5: no offline retry can restore authority availability.
    release();
    controller.observeHistory('p', 'w');
    await jest.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    expect(
      controller.store.getState().worktrees['p/w'].historyUnavailable,
    ).toBe(true); // Slice 3 RF5: revealing a fallback pane retains the outage notice.
    up = true;
    await jest.advanceTimersByTimeAsync(2_000);
    // Slice 3 RF5: authority recovery now reloads the unavailable history.
    expect(load).toHaveBeenCalledTimes(3);
    await load.mock.results[2].value;
    await Promise.resolve();
    expect(
      controller.store.getState().worktrees['p/w'].historyUnavailable,
    ).toBe(false);
    const lastLoadRequest = load.mock.calls.at(-1)?.[0];
    expect(load.mock.calls.at(-1)).toStrictEqual([
      {
        projectId: 'p',
        worktreeId: 'w',
        retainedViewToken: lastLoadRequest?.retainedViewToken,
      },
    ]);
    expect(typeof lastLoadRequest?.retainedViewToken).toBe('string');
    const recoveredToken =
      controller.store.getState().worktrees['p/w'].viewToken;
    up = false;
    await jest.advanceTimersByTimeAsync(2_000);
    expect(load).toHaveBeenCalledTimes(4);
    const secondConfirmationResult = load.mock.results[3];
    if (secondConfirmationResult.type !== 'return') {
      throw new Error('Second confirmation did not return a response');
    }
    const secondConfirmation = await secondConfirmationResult.value;
    await Promise.resolve();
    expect(
      controller.store.getState().worktrees['p/w'].historyUnavailable,
    ).toBe(true); // Slice 3 RF5: the next authority outage is unavailable too.
    expect(controller.store.getState().worktrees['p/w'].viewToken).toBe(
      recoveredToken,
    );
    expect(secondConfirmation.viewToken).toBeUndefined();
    expect(secondConfirmation.terminals).toEqual([]);
    expect(load).toHaveBeenLastCalledWith({
      projectId: 'p',
      worktreeId: 'w',
      historyConfirmationOnly: true,
    });
    await jest.advanceTimersByTimeAsync(6_000);
    expect(load).toHaveBeenCalledTimes(4);
    expect(sawUnavailable).toBe(true); // Slice 3 RF5: fallback publishes the notice.
  } finally {
    unsubscribe();
    controller.reset();
    jest.useRealTimers();
    read.mockRestore();
  }
});

it.each([false, true])(
  'an offline renderer retry keeps cached output for a live terminal present in a partial load (new live sibling: %s)',
  async (newLiveSibling) => {
    const s = store();
    await s.loadWorktreeState('p', 'w');
    s.registerLiveSession(session('shown'));
    s.appendTerminalOutput('p', 'w', 'shown', Buffer.from('cached\n'));
    await s.drainAll();
    const load = jest.fn(
      (
        request: LoadWorktreeTerminalStateRequest,
      ): Promise<LoadWorktreeTerminalStateResponse> =>
        s.loadWorktreeState(
          request.projectId,
          request.worktreeId,
          request.historyStatusOnly,
          request.historyConfirmationOnly,
          request.retainedViewToken,
        ),
    );
    const controller = createTerminalStore(() =>
      durableTerminalClientFor(s, load),
    );
    const bucket = (): WorktreeTerminalBucket =>
      controller.store.getState().worktrees['p/w'];
    await controller.ensureHydrated('p', 'w');
    expect(bucket().sessions.shown.scrollbackLines).toEqual(['cached', '']);
    const cachedGroups = bucket().groups;
    const cachedToken = bucket().viewToken;
    up = false;
    jest.useFakeTimers();
    controller.observeHistory('p', 'w');
    try {
      await jest.advanceTimersByTimeAsync(0);
      expect(load).toHaveBeenCalledTimes(2);
      const result = load.mock.results[1];
      if (result.type !== 'return')
        throw new Error('Confirmation did not return');
      const confirmation = await result.value;
      expect(confirmation.terminals).toEqual([]);
      if (newLiveSibling) s.registerLiveSession(session('new-live'));
      await controller.store.getState().hydrateWorktree('p', 'w');
      expect(bucket().historyUnavailable).toBe(true);
      expect(bucket().sessions.shown.live).toBe(true);
      expect(bucket().sessions.shown.scrollbackLines).toEqual(['cached', '']);
      expect(load).toHaveBeenCalledTimes(3);
      expect(load).toHaveBeenLastCalledWith({
        projectId: 'p',
        worktreeId: 'w',
        retainedViewToken: cachedToken,
      });
      const retry = load.mock.results[2];
      if (retry.type !== 'return') throw new Error('Retry did not return');
      const partial = await retry.value;
      expect(partial.history?.status).toBe('unavailable');
      const shown = partial.terminals.find(
        ({ session }) => session.id === 'shown',
      );
      expect(shown).toBeDefined();
      expect(shown?.scrollbackLines).toEqual([]);
      if (newLiveSibling) {
        // Prove the partial reply was merged, not discarded to preserve output.
        expect(bucket().sessions['new-live'].live).toBe(true);
        expect(bucket().sessions['new-live'].scrollbackLines).toEqual([]);
        expect(bucket().groups.flatMap((group) => group.terminalIds)).toEqual(
          expect.arrayContaining(['shown', 'new-live']),
        );
        expect(bucket().viewToken).toBe(partial.viewToken);
      } else {
        expect(bucket().groups).toEqual(cachedGroups);
        expect(bucket().viewToken).toBe(partial.viewToken);
      }
      controller.store
        .getState()
        .setTerminalName('p', 'w', 'shown', 'Temporary');
      controller.store.getState().setTerminalName('p', 'w', 'shown', null);
      controller.reset();
      jest.useRealTimers();
      up = true;
      await s.drainAll();
      authority.dispose();
      authority = newAuthority();
      const reloaded = await store().loadWorktreeState('p', 'w');
      expect(reloaded.terminalCustomNames.shown).toBeUndefined();
      expect(
        reloaded.terminals.find(({ session }) => session.id === 'shown')
          ?.scrollbackLines,
      ).toEqual(['cached', '']);
    } finally {
      controller.reset();
      jest.useRealTimers();
    }
  },
);

it.each(['available', 'unavailable'] as const)(
  'post-hydration confirmation retains %s fallback availability across an interrupted visibility lease',
  async (status) => {
    const s = store();
    await s.loadWorktreeState('p', 'w');
    s.registerLiveSession(session('shown'));
    s.markTerminalExited('p', 'w', 'shown', 0, null);
    await s.drainAll();
    let complete: () => void = () => {
      throw new Error('Confirmation not started');
    };
    const gate = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let holdResponse = false;
    const load = jest.fn(async (request: LoadWorktreeTerminalStateRequest) => {
      // Hold the real persistence response to the observer's actual request mode.
      const response = await s.loadWorktreeState(
        request.projectId,
        request.worktreeId,
        request.historyStatusOnly,
        request.historyConfirmationOnly,
        request.retainedViewToken,
      );
      if (holdResponse) await gate;
      return response;
    });
    const controller = createTerminalStore(() =>
      durableTerminalClientFor(s, load),
    );
    const bucket = (): WorktreeTerminalBucket =>
      controller.store.getState().worktrees['p/w'];
    await controller.ensureHydrated('p', 'w');
    // Evict setup's view, leaving the drawer oldest at the 64-view cap.
    for (let view = 0; view < 63; view += 1)
      await s.loadWorktreeState('p', 'w');
    const token = bucket().viewToken;
    // Cached reachability can lag a readable authority; confirmation decides.
    const peek = jest.spyOn(records, 'peekAvailable').mockReturnValue(false);
    up = status === 'available';
    holdResponse = true;
    jest.useFakeTimers();
    const release = controller.observeHistory('p', 'w');
    try {
      await jest.advanceTimersByTimeAsync(0);
      expect(load).toHaveBeenCalledTimes(2);
      expect(bucket().historyUnavailable).toBe(false);
      release();
      // The main-side response settles after the visible pane has gone away.
      complete();
      const confirmationResult = load.mock.results[1];
      if (confirmationResult.type !== 'return')
        throw new Error('Confirmation did not return');
      const confirmationResponse = await confirmationResult.value;
      await jest.advanceTimersByTimeAsync(0);
      expect(bucket().historyUnavailable).toBe(false);
      const revealed = controller.observeHistory('p', 'w');
      await jest.advanceTimersByTimeAsync(0);
      expect(bucket().historyUnavailable).toBe(status !== 'available');
      await jest.advanceTimersByTimeAsync(6_000);
      expect(load).toHaveBeenCalledTimes(2);
      revealed();
      const retainedToken = bucket().viewToken;
      controller.store.getState().removeTerminal('p', 'w', 'shown');
      await s.drainAll();
      controller.reset();
      jest.useRealTimers();
      up = true;
      await s.drainAll();
      authority.dispose();
      authority = newAuthority();
      // A serving request would evict the retained token and lose this Close.
      expect((await store().loadWorktreeState('p', 'w')).terminals).toEqual([]);
      expect(retainedToken).toBe(token);
      expect(confirmationResponse.viewToken).toBeUndefined();
      expect(load).toHaveBeenLastCalledWith({
        projectId: 'p',
        worktreeId: 'w',
        historyConfirmationOnly: true,
      });
    } finally {
      release();
      controller.reset();
      jest.useRealTimers();
      peek.mockRestore();
    }
  },
);

it('a second outage after an available confirmation shows the history-unavailable notice again', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('shown'));
  s.appendTerminalOutput('p', 'w', 'shown', Buffer.from('cached\n'));
  s.markTerminalExited('p', 'w', 'shown', 0, null);
  await s.drainAll();
  const load = jest.fn(
    (
      request: LoadWorktreeTerminalStateRequest,
    ): Promise<LoadWorktreeTerminalStateResponse> =>
      s.loadWorktreeState(
        request.projectId,
        request.worktreeId,
        request.historyStatusOnly,
        request.historyConfirmationOnly,
        request.retainedViewToken,
      ),
  );
  const settled = async (call: number): Promise<void> => {
    const result = load.mock.results[call];
    if (result.type !== 'return')
      throw new Error(`Load ${call} did not return`);
    await result.value;
    await jest.advanceTimersByTimeAsync(0);
  };
  const controller = createTerminalStore(() =>
    durableTerminalClientFor(s, load),
  );
  const bucket = (): WorktreeTerminalBucket =>
    controller.store.getState().worktrees['p/w'];
  await controller.ensureHydrated('p', 'w');
  const cached = bucket().sessions.shown;
  // Probes keep reporting the outage, so none can end it before the next drop.
  const peek = jest.spyOn(records, 'peekAvailable').mockReturnValue(false);
  jest.useFakeTimers();
  const release = controller.observeHistory('p', 'w');
  try {
    await jest.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    await settled(1);
    expect(bucket().historyUnavailable).toBe(false);
    up = false;
    // A disputed confirmation is rechecked after a bounded delay, not per probe.
    await jest.advanceTimersByTimeAsync(6_000);
    expect(load).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(6_000);
    expect(load).toHaveBeenCalledTimes(3);
    expect(load).toHaveBeenLastCalledWith({
      projectId: 'p',
      worktreeId: 'w',
      historyConfirmationOnly: true,
    });
    await settled(2);
    // This is the shared panel's unavailable-notice / Try again condition.
    expect(bucket().historyUnavailable && !bucket().sessions.shown.live).toBe(
      true,
    );
    expect(bucket().sessions.shown).toEqual(cached);
    // A confirmed outage is not confirmed again automatically.
    await jest.advanceTimersByTimeAsync(120_000);
    expect(load).toHaveBeenCalledTimes(3);
    await controller.store.getState().hydrateWorktree('p', 'w');
    expect(load).toHaveBeenCalledTimes(4);
    expect(bucket().historyUnavailable).toBe(true);
    expect(bucket().sessions.shown).toEqual(cached);
  } finally {
    release();
    controller.reset();
    jest.useRealTimers();
    peek.mockRestore();
  }
});

it.each([
  [false, 'pending'],
  [true, 'pending'],
  [true, 'empty'],
  [true, 'malformed'],
] as const)(
  'history confirmation leaves a saved recipient-retirement fence and queued outbox unchanged (authority reachable: %s, witness: %s)',
  async (reachable, witnessKind) => {
    const projectId = SHARED_CONTAINER_VIEWER_PROJECT_ID;
    const worktreeId = 'container';
    const outbox = newOutbox();
    const s = newStore({ records, outbox });
    await s.loadWorktreeState(projectId, worktreeId);
    up = false;
    s.registerLiveSession({ ...session('queued'), projectId, worktreeId });
    s.appendTerminalOutput(
      projectId,
      worktreeId,
      'queued',
      Buffer.from('held'),
    );
    await s.drainAll();
    const retirement = await s.prepareTerminalRecordRetirement({
      projectId,
      worktreeId,
    });
    const path = recipientTerminalRetirementPath(projectId, worktreeId);
    fs.mkdirSync(join(path, '..'), { recursive: true });
    const witness =
      witnessKind === 'empty'
        ? ''
        : witnessKind === 'malformed'
          ? '{'
          : JSON.stringify({ version: 1, recipientRetirements: [retirement] });
    fs.writeFileSync(path, witness);
    const before = await outbox.read();
    const write = jest.spyOn(outbox, 'write');
    const retire = jest.spyOn(records, 'retire');
    up = reachable;
    try {
      const confirmation = await s.loadWorktreeState(
        projectId,
        worktreeId,
        false,
        true,
      );
      expect(await outbox.read()).toEqual(before);
      expect(fs.readFileSync(path, 'utf8')).toBe(witness);
      expect(confirmation.history?.status).toBe('unavailable');
      expect(confirmation.viewToken).toBeUndefined();
      expect(write).not.toHaveBeenCalled();
      expect(retire).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      retire.mockRestore();
    }
  },
);

it.each([false, true])(
  'history confirmation fails closed when no recipient-retirement journal can be read (read denied: %s)',
  async (denied) => {
    const projectId = SHARED_CONTAINER_VIEWER_PROJECT_ID;
    const worktreeId = 'container';
    const outbox = newOutbox();
    const s = newStore({ records, outbox });
    await s.loadWorktreeState(projectId, worktreeId);
    up = false;
    s.registerLiveSession({ ...session('queued'), projectId, worktreeId });
    s.appendTerminalOutput(
      projectId,
      worktreeId,
      'queued',
      Buffer.from('held'),
    );
    await s.drainAll();
    const path = recipientTerminalRetirementPath(projectId, worktreeId);
    expect(fs.existsSync(path)).toBe(false);
    const before = await outbox.read();
    const write = jest.spyOn(outbox, 'write');
    const originalRead = fsPromises.readFile;
    let deniedReads = 0;
    const read = jest
      .spyOn(fsPromises, 'readFile')
      .mockImplementation((...args) => {
        if (!denied || args[0] !== path)
          return Reflect.apply(originalRead, fsPromises, args);
        deniedReads += 1;
        return Promise.reject(
          Object.assign(new Error('denied'), { code: 'EACCES' }),
        );
      });
    up = true;
    try {
      const confirmation = await s.loadWorktreeState(
        projectId,
        worktreeId,
        false,
        true,
      );
      // Without the denied read, the same journal-free scope confirms.
      expect(confirmation.history?.status).toBe(
        denied ? 'unavailable' : 'available',
      );
      expect(deniedReads > 0).toBe(denied);
      expect(confirmation.viewToken).toBeUndefined();
      expect(await outbox.read()).toEqual(before);
      expect(write).not.toHaveBeenCalled();
      expect(fs.existsSync(path)).toBe(false);
    } finally {
      write.mockRestore();
      read.mockRestore();
    }
  },
);

it.each(['record', 'offline', 'pending legacy'] as const)(
  'history confirmation respects settled recipient admission and legacy denial (%s)',
  async (source) => {
    const projectId = SHARED_CONTAINER_VIEWER_PROJECT_ID;
    const worktreeId = 'container';
    const first = store();
    await first.loadWorktreeState(projectId, worktreeId);
    first.registerLiveSession({ ...session('old'), projectId, worktreeId });
    await first.drainAll();
    expect(await first.retireRecipientTerminalRecord(worktreeId)).toBe(true);

    const outbox = newOutbox();
    const next = newStore({ records, outbox });
    await next.loadWorktreeState(projectId, worktreeId);
    await next.recordClientFor(projectId, worktreeId);
    next.registerLiveSession({
      ...session('successor'),
      projectId,
      worktreeId,
    });
    next.appendTerminalOutput(
      projectId,
      worktreeId,
      'successor',
      Buffer.from('new account'),
    );
    await next.drainAll();
    expect(
      (await next.loadWorktreeState(projectId, worktreeId)).history?.status,
    ).toBe('available');

    const markerPath = recipientTerminalRetirementPath(projectId, worktreeId);
    const marker = fs.readFileSync(markerPath, 'utf8');
    const path = join(markerPath, '..', 'terminal-state.json');
    const legacy = fixture();
    for (const entry of legacy.terminals)
      entry.session = { ...entry.session, projectId, worktreeId };
    fs.writeFileSync(path, JSON.stringify(legacy));
    const before = await outbox.read();
    const originalOpen = records.open.bind(records);
    const open = jest
      .spyOn(records, 'open')
      .mockImplementation(async (client) => {
        const opened = await originalOpen(client);
        return source === 'pending legacy'
          ? {
              ...opened,
              import: { ...opened.import, from: 'none', pending: true },
            }
          : opened;
      });
    const write = jest.spyOn(outbox, 'write');
    const retire = jest.spyOn(records, 'retire');
    const apply = jest.spyOn(records, 'apply');
    up = source !== 'offline';
    try {
      const confirmation = await next.loadWorktreeState(
        projectId,
        worktreeId,
        false,
        true,
      );
      expect(confirmation.history?.status).toBe(
        source === 'record' ? 'available' : 'unavailable',
      );
      expect(confirmation.viewToken).toBeUndefined();
      expect(confirmation.terminals).toEqual([]);
      expect(await outbox.read()).toEqual(before);
      expect(fs.readFileSync(markerPath, 'utf8')).toBe(marker);
      expect(fs.readFileSync(path, 'utf8')).toBe(JSON.stringify(legacy));
      expect(write).not.toHaveBeenCalled();
      expect(retire).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();

      const full = await next.loadWorktreeState(projectId, worktreeId);
      expect(full.history).toEqual(confirmation.history);
      expect(full.terminals.map(({ session }) => session.id)).toEqual([
        'successor',
      ]);
      expect(full.terminals[0].scrollbackLines).toEqual(
        source === 'offline' ? [] : ['new account'],
      );
    } finally {
      open.mockRestore();
      write.mockRestore();
      retire.mockRestore();
      apply.mockRestore();
      up = true;
    }
  },
);

it('history status probes carry no output and never open a drawer view', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('output-free'));
  s.appendTerminalOutput(
    'p',
    'w',
    'output-free',
    Buffer.from('private history'),
  );
  await s.drainAll();
  const open = jest.spyOn(records, 'open');
  const history = jest.spyOn(records, 'historyRead');
  const availabilityCall = jest.spyOn(records, 'available');
  try {
    for (const available of [true, false]) {
      up = available;
      const probe = await s.loadWorktreeState('p', 'w', true);
      expect(probe.history?.status).toBe(
        available ? 'available' : 'unavailable',
      );
      expect(probe.historyRefreshSupported).toBe(true);
      expect(probe.terminals).toEqual([]);
      expect(probe.groups).toEqual([]);
      expect(probe.viewToken).toBeUndefined();
      expect(JSON.stringify(probe)).not.toContain('private history');
    }
    expect(open).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    // available() acquires a daemon lease and can prepare the data root.
    expect(availabilityCall).not.toHaveBeenCalled();
  } finally {
    open.mockRestore();
    history.mockRestore();
    availabilityCall.mockRestore();
  }
});

it('visible panes share one status loop and hiding the last pane stops it', async () => {
  const s = store();
  const client = terminalClientFor(s);
  const controller = createTerminalStore(() => client);
  await controller.store.getState().hydrateWorktree('p', 'w');
  const query = jest.spyOn(client, 'query');
  jest.useFakeTimers();
  try {
    const first = controller.observeHistory('p', 'w');
    const second = controller.observeHistory('p', 'w');
    await jest.advanceTimersByTimeAsync(2_000);
    expect(query).toHaveBeenCalledTimes(2);
    first();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(query).toHaveBeenCalledTimes(3);
    second();
    await jest.advanceTimersByTimeAsync(6_000);
    expect(query).toHaveBeenCalledTimes(3);
    const revealed = controller.observeHistory('p', 'w');
    await jest.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(4);
    revealed();
    expect(query.mock.calls).toEqual(
      Array.from({ length: 4 }, () => [
        'terminal.worktreeState.get',
        { projectId: 'p', worktreeId: 'w', historyStatusOnly: true },
      ]),
    );
  } finally {
    controller.reset();
    query.mockRestore();
    jest.useRealTimers();
  }
});

it.each(['unmount', 'reset', 'purge'] as const)(
  'history recovery completing after %s cannot publish stale history',
  async (cleanup) => {
    const s = store();
    const available = await s.loadWorktreeState('p', 'w');
    let complete: (
      response: LoadWorktreeTerminalStateResponse,
    ) => void = () => {
      throw new Error('Recovery not started');
    };
    const recovery = new Promise<LoadWorktreeTerminalStateResponse>(
      (resolve) => {
        complete = resolve;
      },
    );
    let noteStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      noteStarted = resolve;
    });
    let recovering = false;
    const client = terminalClientFor(s, undefined, () => {
      if (!recovering) return s.loadWorktreeState('p', 'w');
      noteStarted();
      return recovery;
    });
    const controller = createTerminalStore(() => client);
    up = false;
    await controller.store.getState().hydrateWorktree('p', 'w');
    expect(
      controller.store.getState().worktrees['p/w'].historyUnavailable,
    ).toBe(true);
    up = true;
    recovering = true;
    const release = controller.observeHistory('p', 'w');
    try {
      await started;
      if (cleanup === 'unmount') release();
      else if (cleanup === 'reset') controller.reset();
      else controller.purgeWorktrees(['w']);
      complete(available);
      await recovery;
      await Promise.resolve();
      const bucket = controller.store.getState().worktrees['p/w'];
      if (cleanup === 'unmount') expect(bucket.historyUnavailable).toBe(true);
      else expect(bucket).toBeUndefined();
    } finally {
      release();
      controller.reset();
    }
  },
);

const legacyPath = (): string =>
  join(
    mockRoot,
    'workspaces',
    'p',
    'worktree-data',
    'w',
    'terminal-state.json',
  );
const settle = (ms = 250): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function earlierClient(lifetimeId: string): WorkerTerminalRecordClient {
  return {
    projectId: 'p',
    worktreeId: 'w',
    legacyLayout: 'workspaces',
    incarnation: null,
    lifetimeId,
  };
}

function seedReplayWitness(lifetimeId: string): WorkerTerminalRecordClient {
  const path = getWorktreeTerminalReplayWitnessFilePath('p', 'w', lifetimeId);
  fs.mkdirSync(join(path, '..'), { recursive: true });
  fs.writeFileSync(path, JSON.stringify({ lifetimeId }));
  return {
    projectId: 'p',
    worktreeId: 'w',
    legacyLayout: 'workspaces',
    incarnation: null,
    lifetimeId,
  };
}

async function prepareReplayScope(s: TerminalPersistenceStore): Promise<void> {
  const client = await s.recordClientFor('p', 'w');
  if (!client.lifetimeId) throw new Error('Missing fixture lifetime');
  // This scenario starts with metadata already present; a read no longer creates it.
  fs.mkdirSync(
    join(
      getWorktreeTerminalReplayWitnessFilePath('p', 'w', client.lifetimeId),
      '..',
    ),
    { recursive: true },
  );
}

it('R2 unwitnessed legacy null-incarnation batches remain quarantined and durable', async () => {
  await newOutbox().write({
    version: 1,
    producer: 'electron_main',
    retirements: [],
    scopes: [
      {
        client: {
          projectId: 'p',
          worktreeId: 'w',
          legacyLayout: 'workspaces',
          incarnation: null,
        },
        entries: [
          {
            seq: 1,
            runId: 'unqualified',
            ops: [{ op: 'session.upsert', session: session('unqualified') }],
          },
        ],
      },
    ],
  });
  const next = store();
  next.registerLiveSession(session('allowed'));
  await next.drainAll();
  expect(
    (await next.loadWorktreeState('p', 'w')).terminals.map(
      (entry) => entry.session.id,
    ),
  ).toEqual(['allowed']);
  expect(
    (await newOutbox().read()).outbox.scopes
      .flatMap((scope) => scope.entries)
      .some((entry) => entry.runId === 'unqualified'),
  ).toBe(true);
});

it("R2 an earlier run's file in custody never routes a healthy authority's writes through a failing outbox", async () => {
  fs.writeFileSync(
    join(mockRoot, 'terminal-record-outbox.run-older.json'),
    JSON.stringify({
      version: 1,
      producer: 'electron_main',
      runStartedAt: 1_000,
      retirements: [],
      scopes: [
        {
          client: earlierClient('earlier-lifetime'),
          entries: [
            {
              seq: 1,
              runId: 'older',
              ops: [{ op: 'session.upsert', session: session('older') }],
            },
          ],
        },
      ],
    }),
  );
  const outbox = newOutbox();
  const write = jest
    .spyOn(outbox, 'write')
    .mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
  const s = newStore({ records, outbox });
  try {
    s.start();
    await s.loadWorktreeState('p', 'w');
    s.registerLiveSession(session('new'));
    s.appendTerminalOutput('p', 'w', 'new', Buffer.from('applied'));
    await s.drainAll();
    expect(applyCalls).toBeGreaterThan(0);
  } finally {
    write.mockRestore();
  }
  const loaded = await store().loadWorktreeState('p', 'w');
  expect(loaded.terminals.map((entry) => entry.session.id)).toEqual(['new']);
  expect(loaded.terminals[0]?.scrollbackLines).toEqual(['applied']);
});

it.each(['write', 'read'] as const)(
  'R2 witness %s failure quarantines custody without blocking terminals',
  async (failure) => {
    up = false;
    const s = store();
    await s.recordClientFor('p', 'w');
    const originalWrite = atomicFile.writeFileAtomicallySync;
    const write = jest
      .spyOn(atomicFile, 'writeFileAtomicallySync')
      .mockImplementation((path, data, options) => {
        if (
          failure === 'write' &&
          String(path).includes('terminal-replay-witness.')
        )
          throw new Error('witness write denied');
        originalWrite(path, data, options);
      });
    try {
      expect(() => s.registerLiveSession(session('held'))).not.toThrow();
      s.appendTerminalOutput('p', 'w', 'held', Buffer.from('held output'));
      await s.drainAll();
      s.markAllLiveTerminalsExited('app-quit');
    } finally {
      write.mockRestore();
    }
    const originalRead = fsPromises.readFile;
    const read = jest
      .spyOn(fsPromises, 'readFile')
      .mockImplementation((...args) =>
        failure === 'read' &&
        typeof args[0] === 'string' &&
        args[0].includes('terminal-replay-witness.')
          ? Promise.reject(new Error('witness read denied'))
          : Reflect.apply(originalRead, fsPromises, args),
      );
    try {
      up = true;
      const next = store();
      next.registerLiveSession(session('allowed'));
      await next.drainAll();
      expect(
        (await next.loadWorktreeState('p', 'w')).terminals.map(
          (entry) => entry.session.id,
        ),
      ).toEqual(['allowed']);
      const queued = (await newOutbox().read()).outbox.scopes.flatMap(
        (scope) => scope.entries,
      );
      expect(
        queued.some((entry) =>
          entry.ops.some(
            (op) => op.op === 'output.append' && op.text === 'held output',
          ),
        ),
      ).toBe(true);
    } finally {
      read.mockRestore();
    }
  },
);

it.each(['directory', 'install', 'late-directory'] as const)(
  'R3 queued exited history recovers after transient witness %s failure without another batch',
  async (failure) => {
    up = false;
    const directoryPath = join(
      mockRoot,
      'workspaces',
      'p',
      'worktree-data',
      'w',
    );
    const originalMkdir = fsPromises.mkdir;
    const originalWrite = atomicFile.writeFileAtomicallySync;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fail = true;
    let preparation: ReturnType<typeof fsPromises.mkdir> | undefined;
    const mkdir = jest
      .spyOn(fsPromises, 'mkdir')
      .mockImplementation((...args) => {
        if (String(args[0]) !== directoryPath)
          return Reflect.apply(originalMkdir, fsPromises, args);
        if (!fail) {
          preparation = Reflect.apply(originalMkdir, fsPromises, args);
          return preparation;
        }
        if (failure === 'directory')
          return Promise.reject(
            Object.assign(new Error('temporary mkdir failure'), {
              code: 'EIO',
            }),
          );
        if (failure === 'late-directory') {
          preparation = held.then(() =>
            Reflect.apply(originalMkdir, fsPromises, args),
          );
          return preparation;
        }
        return Reflect.apply(originalMkdir, fsPromises, args);
      });
    const write = jest
      .spyOn(atomicFile, 'writeFileAtomicallySync')
      .mockImplementation((path, data, options) => {
        if (
          failure === 'install' &&
          fail &&
          String(path).includes('terminal-replay-witness.')
        )
          throw Object.assign(new Error('temporary witness failure'), {
            code: 'EIO',
          });
        originalWrite(path, data, options);
      });
    const s = store();
    try {
      const client = await s.recordClientFor('p', 'w');
      if (!client.lifetimeId) throw new Error('Missing lifetime');
      const path = getWorktreeTerminalReplayWitnessFilePath(
        'p',
        'w',
        client.lifetimeId,
      );
      s.registerLiveSession(session('held'));
      s.appendTerminalOutput('p', 'w', 'held', Buffer.from('retained tail'));
      s.markTerminalExited('p', 'w', 'held', 0, null);
      await s.drainAll();
      expect(fs.existsSync(path)).toBe(false);
      expect((await newOutbox().read()).outbox.scopes).not.toEqual([]);
      fail = false;
      release();
      await preparation;
      await s.drainAll();
      // A drain starts preparation without delaying its caller. Observe the
      // actual filesystem completion before the next event retries the install.
      await preparation;
      await s.drainAll();
      expect(fs.existsSync(path)).toBe(true);
      s.markAllLiveTerminalsExited('app-quit');
      up = true;
      const loaded = await store().loadWorktreeState('p', 'w');
      expect(loaded.terminals.map((entry) => entry.session.id)).toEqual([
        'held',
      ]);
      expect(loaded.terminals[0].scrollbackLines).toEqual(['retained tail']);
      expect(loaded.terminals[0].exitCode).toBe(0);
    } finally {
      release();
      await preparation;
      mkdir.mockRestore();
      write.mockRestore();
    }
  },
);

it('R9 late witness directory completion installs exited custody without another drain', async () => {
  up = false;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mkdir = fsPromises.mkdir;
  const directory = jest
    .spyOn(fsPromises, 'mkdir')
    .mockImplementation(async (...args) => {
      if (String(args[0]) === join(legacyPath(), '..')) await gate;
      return Reflect.apply(mkdir, fsPromises, args);
    });
  let witnessed: () => void = () => undefined;
  const installed = new Promise<void>((resolve) => {
    witnessed = resolve;
  });
  const write = atomicFile.writeFileAtomicallySync;
  const writing = jest
    .spyOn(atomicFile, 'writeFileAtomicallySync')
    .mockImplementation((...args) => {
      write(...args);
      if (String(args[0]).includes('terminal-replay-witness.')) witnessed();
    });
  const s = store();
  try {
    s.registerLiveSession(session('exited'));
    s.appendTerminalOutput('p', 'w', 'exited', Buffer.from('retained'));
    s.markTerminalExited('p', 'w', 'exited', 0, null);
    await s.drainAll();
    release();
    await installed;
    const client = await s.recordClientFor('p', 'w');
    if (!client.lifetimeId) throw new Error('Missing fixture lifetime');
    expect(
      fs.existsSync(
        getWorktreeTerminalReplayWitnessFilePath('p', 'w', client.lifetimeId),
      ),
    ).toBe(true);
  } finally {
    release();
    directory.mockRestore();
    writing.mockRestore();
  }
});

it('R3 a witness read resolving after quit never sends from the sealed store', async () => {
  const client = seedReplayWitness('earlier');
  await newOutbox().write({
    version: 1,
    producer: 'electron_main',
    retirements: [],
    scopes: [
      {
        client,
        entries: [
          {
            runId: 'earlier',
            seq: 1,
            ops: [{ op: 'session.upsert', session: session('held') }],
          },
        ],
      },
    ],
  });
  const witness = getWorktreeTerminalReplayWitnessFilePath('p', 'w', 'earlier');
  const originalRead = fsPromises.readFile;
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observe = (): void => undefined;
  const reading = new Promise<void>((resolve) => {
    observe = resolve;
  });
  const read = jest
    .spyOn(fsPromises, 'readFile')
    .mockImplementation((...args) => {
      if (args[0] !== witness)
        return Reflect.apply(originalRead, fsPromises, args);
      observe();
      return held.then(() => Reflect.apply(originalRead, fsPromises, args));
    });
  const apply = jest.fn(
    (params: Parameters<TerminalRecordClientPort['apply']>[0]) =>
      records.apply(params),
  );
  const s = newStore({ records: { ...records, apply }, outbox: newOutbox() });
  const draining = s.drainAll();
  try {
    await reading;
    s.markAllLiveTerminalsExited('app-quit');
    release();
    await draining;
    expect(apply).not.toHaveBeenCalled();
    expect((await newOutbox().read()).outbox.scopes).toHaveLength(1);
  } finally {
    release();
    await draining;
    read.mockRestore();
  }
});

it('R2 immediate quit without a prepared directory stays synchronous and quarantines history', async () => {
  up = false;
  const mkdir = jest.spyOn(fsModule, 'mkdirSync').mockImplementation(() => {
    throw new Error('quit must not create directories');
  });
  const s = store();
  try {
    s.registerLiveSession(session('immediate'));
    s.appendTerminalOutput('p', 'w', 'immediate', Buffer.from('kept durable'));
    expect(() => s.markAllLiveTerminalsExited('app-quit')).not.toThrow();
    expect(mkdir).not.toHaveBeenCalled();
  } finally {
    mkdir.mockRestore();
  }
  const sealed = await newOutbox().read();
  expect(
    sealed.outbox.scopes
      .flatMap((scope) => scope.entries)
      .some((entry) => entry.sealed !== undefined),
  ).toBe(true);
  up = true;
  const next = store();
  await next.drainAll();
  expect((await next.loadWorktreeState('p', 'w')).terminals).toEqual([]);
  expect(
    (await newOutbox().read()).outbox.scopes.flatMap((scope) => scope.entries),
  ).not.toEqual([]);
});

it.each(['absent', 'predecessor'] as const)(
  'R3 a surviving predecessor witness cannot qualify successor history (successor evidence: %s)',
  async (evidence) => {
    up = false;
    const s = store();
    s.registerLiveSession(session('old'));
    s.appendTerminalOutput('p', 'w', 'old', Buffer.from('retired output'));
    await s.drainAll();
    const oldClient = await s.recordClientFor('p', 'w');
    if (!oldClient.lifetimeId) throw new Error('Missing old lifetime');
    const oldPath = getWorktreeTerminalReplayWitnessFilePath(
      'p',
      'w',
      oldClient.lifetimeId,
    );
    expect(fs.existsSync(oldPath)).toBe(true);
    await s.retireTerminalRecord({ projectId: 'p', worktreeId: 'w' });

    // Retirement drops batches, not this shared directory's old evidence.
    expect(fs.existsSync(oldPath)).toBe(true);
    const originalWrite = atomicFile.writeFileAtomicallySync;
    const write = jest
      .spyOn(atomicFile, 'writeFileAtomicallySync')
      .mockImplementation((path, data, options) => {
        if (String(path).includes('terminal-replay-witness.'))
          throw new Error('successor witness unavailable');
        originalWrite(path, data, options);
      });
    try {
      s.registerLiveSession(session('new'));
      s.appendTerminalOutput('p', 'w', 'new', Buffer.from('held output'));
      s.markAllLiveTerminalsExited('app-quit');
    } finally {
      write.mockRestore();
    }
    const queued = (await newOutbox().read()).outbox.scopes;
    expect(
      queued.flatMap((scope) => scope.entries).flatMap((entry) => entry.ops),
    ).not.toContainEqual({ op: 'session.upsert', session: session('old') });
    const successor = queued.find((scope) =>
      scope.entries.some((entry) =>
        entry.ops.some(
          (op) => op.op === 'session.upsert' && op.session.id === 'new',
        ),
      ),
    );
    if (!successor?.client.lifetimeId)
      throw new Error('Missing successor custody');
    expect(successor.client.lifetimeId).not.toBe(oldClient.lifetimeId);
    const newPath = getWorktreeTerminalReplayWitnessFilePath(
      'p',
      'w',
      successor.client.lifetimeId,
    );
    expect(newPath).not.toBe(oldPath);
    expect(fs.existsSync(newPath)).toBe(false);
    if (evidence === 'predecessor') fs.copyFileSync(oldPath, newPath);

    up = true;
    const next = store();
    expect((await next.loadWorktreeState('p', 'w')).terminals).toEqual([]);
    const held = (await newOutbox().read()).outbox.scopes;
    expect(held.map((scope) => scope.client.lifetimeId)).toEqual([
      successor.client.lifetimeId,
    ]);
    expect(
      held.flatMap((scope) => scope.entries).flatMap((entry) => entry.ops),
    ).toContainEqual({
      op: 'output.append',
      terminalId: 'new',
      text: 'held output',
    });
  },
);

it.each([undefined, 'w'])(
  'R2 retirement replay keeps offline replacement history (worktree: %s)',
  async (worktreeId) => {
    up = false;
    const old = newStore({
      records,
      outbox: newOutbox(),
      incarnation: () => Promise.resolve('old'),
    });
    old.registerLiveSession(session('old'));
    await old.drainAll();
    const intent = await old.prepareTerminalRecordRetirement({
      projectId: 'p',
      worktreeId,
    });
    await old.retirePreparedTerminalRecord(intent);
    old.markAllLiveTerminalsExited('app-quit');
    const captured = JSON.stringify(intent);

    const replacement = newStore({
      records,
      outbox: newOutbox(),
      incarnation: () => Promise.resolve('new'),
    });
    replacement.registerLiveSession(session('replacement'));
    replacement.appendTerminalOutput(
      'p',
      'w',
      'replacement',
      Buffer.from('keep me'),
    );
    await replacement.drainAll();
    replacement.markAllLiveTerminalsExited('app-quit');
    const boot = newStore({
      records,
      outbox: newOutbox(),
      incarnation: () => Promise.resolve('new'),
    });
    expect(await boot.replayTerminalRecordRetirement(intent)).toBe(true);
    expect(JSON.stringify(intent)).toBe(captured);
    const disk = await newOutbox().read();
    expect(
      disk.outbox.scopes
        .flatMap((scope) => scope.entries)
        .some((entry) =>
          entry.ops.some(
            (op) =>
              op.op === 'session.upsert' && op.session.id === 'replacement',
          ),
        ),
    ).toBe(true);
    up = true;
    const loaded = await boot.loadWorktreeState('p', 'w');
    expect(
      loaded.terminals.map((entry) => [
        entry.session.id,
        entry.scrollbackLines,
      ]),
    ).toEqual([['replacement', ['keep me']]]);
  },
);

it.each([false, true])(
  'R2 quit recovery survives a stale async publication (unmerged: %s)',
  async (unmerged) => {
    up = false;
    const outbox = newOutbox();
    if (unmerged)
      jest.spyOn(outbox, 'read').mockRejectedValue(new Error('unreadable'));
    let started: () => void = () => undefined;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let publish: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      publish = resolve;
    });
    let landed: Promise<void> = Promise.resolve();
    const actualWrite = atomicFile.writeFileAtomically;
    let intercepted = false;
    const write = jest
      .spyOn(atomicFile, 'writeFileAtomically')
      .mockImplementation((...args) => {
        if (intercepted || !String(args[0]).includes('terminal-record-outbox'))
          return actualWrite(...args);
        intercepted = true;
        landed = held.then(() => {
          fs.writeFileSync(args[0], args[1]);
        });
        started();
        return landed;
      });
    const s = newStore({ records, outbox });
    try {
      s.registerLiveSession(session('quit-race'));
      s.appendTerminalOutput('p', 'w', 'quit-race', Buffer.from('before'));
      // Start the debounced flush without awaiting the held disk install.
      const draining = s.drainAll();
      await writing;
      s.appendTerminalOutput('p', 'w', 'quit-race', Buffer.from('-final'));
      s.markAllLiveTerminalsExited('fatal-exit');
      publish();
      await landed;
      // Read immediately after the stale publication; no async repair is awaited.
      const recovered = await newOutbox().read();
      expect(
        recovered.outbox.scopes
          .flatMap((scope) => scope.entries)
          .some((entry) =>
            entry.ops.some(
              (op) => op.op === 'exit' && op.signal === 'fatal-exit',
            ),
          ),
      ).toBe(true);
      await draining;
      up = true;
      const loaded = await store().loadWorktreeState('p', 'w');
      expect(
        loaded.terminals.map((entry) => [
          entry.session.id,
          entry.scrollbackLines,
          entry.signal,
        ]),
      ).toEqual([['quit-race', ['before-final'], 'fatal-exit']]);
    } finally {
      publish();
      write.mockRestore();
    }
  },
);

it.each(['matching', 'missing', 'mismatched', 'damaged'] as const)(
  'R2 split quit image supersedes only its proven stale publication (metadata: %s)',
  async (metadata) => {
    up = false;
    const outbox = newOutbox();
    jest.spyOn(outbox, 'read').mockRejectedValue(new Error('unreadable'));
    const s = newStore({ records, outbox });
    for (const id of terminalIds(700)) s.registerLiveSession(session(id));
    const ids = terminalIds(700);
    s.appendTerminalOutput('p', 'w', ids.at(-1) ?? '', Buffer.from('tail'));
    await s.drainAll();

    let started: () => void = () => undefined;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let publish: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      publish = resolve;
    });
    const publicationSchema = z.looseObject({
      publicationId: z.string().optional(),
      scopes: z.array(
        z.looseObject({
          entries: z.array(
            z.looseObject({ runId: z.string(), seq: z.number() }),
          ),
        }),
      ),
      seal: z
        .looseObject({
          source: z
            .looseObject({ file: z.string(), publicationId: z.string() })
            .optional(),
        })
        .optional(),
    });
    let stale: z.infer<typeof publicationSchema> | undefined;
    let stalePath = '';
    let landed = Promise.resolve();
    const actualWrite = atomicFile.writeFileAtomically;
    let intercepted = false;
    const write = jest
      .spyOn(atomicFile, 'writeFileAtomically')
      .mockImplementation((...args) => {
        if (intercepted || !String(args[0]).includes('terminal-record-outbox'))
          return actualWrite(...args);
        intercepted = true;
        const parsed: unknown = JSON.parse(String(args[1]));
        // Match the runtime envelope without manufacturing a publication identity.
        if (!isRecord(parsed) || !Array.isArray(parsed.scopes))
          throw new Error('Expected publication');
        stale = publicationSchema.parse(parsed);
        stalePath = String(args[0]);
        landed = held.then(() => fs.writeFileSync(stalePath, args[1]));
        started();
        return landed;
      });
    const syncWrite = jest.spyOn(atomicFile, 'writeFileAtomicallySync');
    try {
      s.appendTerminalOutput('p', 'w', ids[0], Buffer.from('before'));
      const draining = s.drainAll();
      await writing;
      s.appendTerminalOutput('p', 'w', ids[0], Buffer.from('-final'));
      s.markAllLiveTerminalsExited('app-quit');
      const sealName = fs
        .readdirSync(mockRoot)
        .find((name) => name.endsWith('-seal.json'));
      if (!sealName || !stale)
        throw new Error('Expected held publication and quit image');
      const sealPath = join(mockRoot, sealName);
      const sealCall = syncWrite.mock.calls.find(([path]) =>
        String(path).endsWith('-seal.json'),
      );
      const seal = sealCall
        ? publicationSchema.parse(JSON.parse(String(sealCall[1])))
        : undefined;
      if (!seal) throw new Error('Expected quit custody image');
      const finalEntries = seal.scopes.flatMap((scope) => scope.entries);
      const obsolete = stale.scopes
        .flatMap((scope) => scope.entries)
        .filter(
          (entry) =>
            !finalEntries.some(
              (final) => final.runId === entry.runId && final.seq === entry.seq,
            ),
        );
      expect(obsolete.length).toBeGreaterThan(0);
      expect(seal.seal?.source?.publicationId).toBe(stale.publicationId);
      if (metadata === 'missing') delete seal.seal;
      else if (metadata === 'mismatched' && seal.seal?.source)
        seal.seal.source.publicationId = 'another-publication';
      fs.writeFileSync(
        sealPath,
        JSON.stringify(
          metadata === 'damaged' ? { ...seal, scopes: null } : seal,
        ),
      );
      publish();
      await landed;
      const recovered = await newOutbox().read();
      expect(recovered.runFiles).toEqual(
        expect.arrayContaining([stalePath, sealPath]),
      );
      const entries = recovered.outbox.scopes.flatMap((scope) => scope.entries);
      if (metadata === 'matching') {
        expect(entries).toEqual(finalEntries);
        await draining;
        up = true;
        const loaded = await store().loadWorktreeState('p', 'w');
        expect(
          loaded.terminals.find((entry) => entry.session.id === ids.at(-1))
            ?.scrollbackLines,
        ).toEqual(['tail']);
        expect(
          loaded.terminals.find((entry) => entry.session.id === ids[0]),
        ).toMatchObject({
          scrollbackLines: ['before-final'],
          signal: 'app-quit',
        });
      } else {
        for (const entry of obsolete) expect(entries).toContainEqual(entry);
        await draining;
      }
    } finally {
      publish();
      write.mockRestore();
      syncWrite.mockRestore();
    }
  },
);

it.each(['in-app', 'external'] as const)(
  'R2 null-incarnation quit history cannot cross %s deletion and reuse',
  async (deletion) => {
    up = false;
    const old = newStore({
      records,
      outbox: newOutbox(),
      incarnation: () => new Promise(() => undefined),
      incarnationLookupBoundMs: 10,
    });
    await prepareReplayScope(old);
    old.registerLiveSession(session('private-old'));
    old.appendTerminalOutput(
      'p',
      'w',
      'private-old',
      Buffer.from('old secret'),
    );
    old.markAllLiveTerminalsExited('app-quit');
    const cleaner = store();
    if (deletion === 'in-app') {
      const intent = await cleaner.prepareTerminalRecordRetirement({
        projectId: 'p',
        worktreeId: 'w',
      });
      expect(intent.lifetimeIds?.length).toBeGreaterThan(0);
      await cleaner.retirePreparedTerminalRecord(intent);
    }
    // CLI hard deletion removes precisely this app-managed directory.
    fs.rmSync(join(legacyPath(), '..'), { recursive: true, force: true });
    fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
    up = true;
    const replacement = newStore({
      records,
      outbox: newOutbox(),
      incarnation: () => Promise.resolve('replacement'),
    });
    replacement.registerLiveSession(session('public-new'));
    replacement.appendTerminalOutput(
      'p',
      'w',
      'public-new',
      Buffer.from('new output'),
    );
    await replacement.drainAll();
    const loaded = await replacement.loadWorktreeState('p', 'w');
    expect(
      loaded.terminals.map((entry) => [
        entry.session.id,
        entry.scrollbackLines,
      ]),
    ).toEqual([['public-new', ['new output']]]);
    const remaining = (await newOutbox().read()).outbox.scopes.flatMap(
      (scope) => scope.entries,
    );
    expect(
      remaining.some((entry) =>
        entry.ops.some(
          (op) => op.op === 'session.upsert' && op.session.id === 'private-old',
        ),
      ),
    ).toBe(deletion === 'external');
  },
);

it('R2 snapshot watermarks suppress duplicate drawer and restore output without acknowledging custody', async () => {
  authority.dispose();
  let fail = false;
  authority = new TerminalRecordAuthority({
    repository: new TerminalRecordRepository({
      dataRoot: mockRoot,
      flushDirectorySync: (): void => {
        if (fail) throw new Error('directory flush failed');
      },
    }),
    installDebounceMs: 1,
  });
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  const s = store();
  await s.loadWorktreeState('p', 'w');
  fail = true;
  s.appendTerminalOutput('p', 'w', 'a', Buffer.from('-once'));
  await s.drainAll();
  const loaded = await s.loadWorktreeState('p', 'w');
  expect(
    loaded.terminals.find((entry) => entry.session.id === 'a')?.scrollbackLines,
  ).toEqual(['A0-once']);
  const release = await s.prefetchPersistedEntry('a');
  expect(s.getPersistedTerminalEntry('a')?.scrollbackLines).toEqual([
    'A0-once',
  ]);
  release();
  const queued = (await newOutbox().read()).outbox.scopes.flatMap(
    (scope) => scope.entries,
  );
  expect(
    queued.some((entry) =>
      entry.ops.some((op) => op.op === 'output.append' && op.text === '-once'),
    ),
  ).toBe(true);
  fail = false;
  await s.drainAll();
  expect(
    (await store().loadWorktreeState('p', 'w')).terminals.find(
      (entry) => entry.session.id === 'a',
    )?.scrollbackLines,
  ).toEqual(['A0-once']);
});

beforeEach(() => {
  intervals = jest.spyOn(global, 'setInterval');
  records = recordsFor(epoch);
  loseApplyReplies = 0;
  applyCalls = 0;
  mockRoot = fs.mkdtempSync(join(tmpdir(), 'rstore-'));
  up = true;
  authority = newAuthority();
});
afterEach(async () => {
  epoch += 1;
  try {
    for (const s of stores.splice(0)) {
      s.markAllLiveTerminalsExited('app-quit');
      await s.drainAll();
    }
  } finally {
    authority.dispose();
    // Sealed offline outboxes retain their retry interval even after a drain.
    for (const result of intervals.mock.results) {
      if (result.type === 'return') clearInterval(result.value);
    }
    intervals.mockRestore();
    fs.rmSync(mockRoot, { recursive: true, force: true });
  }
});

it('both offline writes and quit seals durably install their outbox', async () => {
  const asyncWrite = jest.spyOn(atomicFile, 'writeFileAtomically');
  const syncWrite = jest.spyOn(atomicFile, 'writeFileAtomicallySync');
  try {
    const outbox = newOutbox();
    const queued = {
      version: 1 as const,
      producer: 'electron_main' as const,
      scopes: [],
      retirements: [],
    };
    await outbox.write(queued);
    outbox.seal(queued, 'quit');
    // Bytes: the outbox is never encoded as one string.
    expect(asyncWrite).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ durable: true }),
    );
    expect(syncWrite).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ durable: true }),
    );
  } finally {
    asyncWrite.mockRestore();
    syncWrite.mockRestore();
  }
});

it('durably fences the imported legacy state before completing its load', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  const write = jest.spyOn(atomicFile, 'writeFileAtomically');
  try {
    await store().loadWorktreeState('p', 'w');
    expect(write).toHaveBeenCalledWith(
      legacyPath(),
      expect.any(String),
      expect.objectContaining({ durable: true }),
    );
  } finally {
    write.mockRestore();
  }
});

it('imports v1 history on load, fences the legacy file, and keeps the layout', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  const loaded = await store().loadWorktreeState('p', 'w');
  expect(loaded.history).toEqual({ status: 'available' });
  expect(
    loaded.terminals.map((t) => [t.session.id, t.scrollbackLines]),
  ).toEqual(fixture().terminals.map((t) => [t.session.id, t.scrollbackLines]));
  expect(loaded.groups).toEqual(fixture().groups);
  expect(loaded.terminalCustomNames).toEqual({ a: 'API', b: 'Build' });
  expect(JSON.parse(fs.readFileSync(legacyPath(), 'utf8'))).toMatchObject({
    version: 3,
    movedTo: 'terminal-record-authority',
  });
  // A second store (restart) reads the record, not the fenced file.
  const again = await store().loadWorktreeState('p', 'w');
  expect(again.groups).toEqual(fixture().groups);
  expect(again.terminals.map((t) => t.scrollbackLines)).toEqual(
    fixture().terminals.map((t) => t.scrollbackLines),
  );
});

it('a legacy read the daemon could not make leaves the source unfenced until it is imported', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  const legacyBytes = JSON.stringify(fixture());
  fs.writeFileSync(legacyPath(), legacyBytes);
  // The daemon's reads of it fail, as an EACCES does; main's own still work.
  const original = fsModule.readFileSync;
  const spy = jest
    .spyOn(fsModule, 'readFileSync')
    .mockImplementation((path, options) => {
      if (path === legacyPath())
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return original(path, options);
    });
  try {
    // A daemon terminal starts and exits meanwhile.
    const client = {
      projectId: 'p',
      worktreeId: 'w',
      legacyLayout: 'workspaces' as const,
      incarnation: null,
    };
    const registration = authority.attribute({
      terminalId: 'dz',
      client,
      session: session('dz'),
      persist: true,
    });
    authority.output(registration, Buffer.from('daemon meanwhile'));
    authority.exited(registration, 0, null);
    const first = await store().loadWorktreeState('p', 'w');
    // Main's own legacy state underneath, the daemon terminal on top, and
    // nothing fenced.
    expect(first.terminals.map((t) => t.session.id)).toEqual(['a', 'b', 'dz']);
    expect(
      first.terminals.find((t) => t.session.id === 'dz')?.scrollbackLines,
    ).toEqual(['daemon meanwhile']);
    expect(first.groups.map((g) => g.terminalIds)).toEqual(
      expect.arrayContaining([['dz']]),
    );
  } finally {
    spy.mockRestore();
  }
  expect(fs.readFileSync(legacyPath(), 'utf8')).toBe(legacyBytes);
  const loaded = await store().loadWorktreeState('p', 'w');
  expect(loaded.history).toEqual({ status: 'available' });
  expect(loaded.terminals.map((t) => t.session.id)).toEqual(['a', 'b', 'dz']);
  // The imported layout, and the daemon terminal in a group of its own.
  expect(loaded.groups).toEqual([
    ...fixture().groups,
    expect.objectContaining({ terminalIds: ['dz'] }),
  ]);
  expect(loaded.terminals.map((t) => t.scrollbackLines).slice(0, 2)).toEqual(
    fixture().terminals.map((t) => t.scrollbackLines),
  );
  expect(
    fs.existsSync(
      join(terminalRecordDir(mockRoot, 'p', 'w'), 'import-source.json'),
    ),
  ).toBe(true);
  expect(JSON.parse(fs.readFileSync(legacyPath(), 'utf8'))).toMatchObject({
    version: 3,
    movedTo: 'terminal-record-authority',
  });
});

it.each([false, true, 'disconnect'] as const)(
  'R1 attach and restore keep readable legacy history while import waits (recovers before prefetch: %s)',
  async (recovers) => {
    fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
    fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
    const original = fsModule.readFileSync;
    const spy = jest
      .spyOn(fsModule, 'readFileSync')
      .mockImplementation((path, options) => {
        if (path === legacyPath())
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return original(path, options);
      });
    let failOpen = false;
    const open = jest.fn((client: WorkerTerminalRecordClient) =>
      failOpen ? Promise.reject(new Error('down')) : records.open(client),
    );
    const s = newStore({
      records: {
        ...records,
        open,
      },
      outbox: newOutbox(),
    });
    try {
      const loaded = await s.loadWorktreeState('p', 'w');
      expect(loaded.terminals[0].scrollbackLines).toEqual(['A0']);
      expect(await s.prepareDaemonRestore('a')).toBe(false);
      // A successful page must survive a later import-confirmation disconnect.
      // Falling back to legacy alone would lose these daemon-owned bytes.
      if (recovers === 'disconnect') {
        const registration = authority.attribute({
          terminalId: 'a',
          client: await s.recordClientFor('p', 'w'),
          session: session('a'),
          persist: true,
        });
        authority.output(registration, Buffer.from('\ndaemon tail'));
      }
      if (recovers === true) spy.mockRestore();
      failOpen = recovers === 'disconnect';
      open.mockClear();
      const release = await s.prefetchPersistedEntry('a');
      if (recovers === 'disconnect') expect(open).toHaveBeenCalled();
      const expected =
        recovers === 'disconnect' ? ['A0', 'daemon tail'] : ['A0'];
      expect(s.getPersistedTerminalEntry('a')?.scrollbackLines).toEqual(
        expected,
      );
      release();
      expect(s.getPersistedTerminalEntry('a')).toBeNull();
    } finally {
      spy.mockRestore();
    }
    failOpen = false;
    await s.loadWorktreeState('p', 'w');
    expect(await s.prepareDaemonRestore('a')).toBe(true);
    const release = await s.prefetchPersistedEntry('a');
    expect(s.getPersistedTerminalEntry('a')?.scrollbackLines).toEqual(
      recovers === 'disconnect' ? ['A0', 'daemon tail'] : ['A0'],
    );
    release();
  },
);

it('unconfirmed import durability never prefixes already imported history or fences legacy state', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  const legacyBytes = JSON.stringify(fixture());
  fs.writeFileSync(legacyPath(), legacyBytes);
  const client: WorkerTerminalRecordClient = {
    projectId: 'p',
    worktreeId: 'w',
    legacyLayout: 'workspaces',
    incarnation: null,
  };
  expect(authority.open(client).import.pending).not.toBe(true);
  authority.dispose();
  let failConfirmation = true;
  authority = new TerminalRecordAuthority({
    repository: new TerminalRecordRepository({
      dataRoot: mockRoot,
      flushDirectorySync: (): void => {
        if (failConfirmation) throw new Error('directory flush failed');
      },
    }),
    installDebounceMs: 1,
  });
  expect(authority.open(client).import.pending).toBe(true);
  const s = store();
  const loaded = await s.loadWorktreeState('p', 'w');
  expect(loaded.terminals[0].scrollbackLines).toEqual(['A0']);
  expect(await s.prepareDaemonRestore('a')).toBe(false);
  const release = await s.prefetchPersistedEntry('a');
  expect(s.getPersistedTerminalEntry('a')?.scrollbackLines).toEqual(['A0']);
  release();
  expect(fs.readFileSync(legacyPath(), 'utf8')).toBe(legacyBytes);
  failConfirmation = false;
  expect(
    (await s.loadWorktreeState('p', 'w')).terminals[0].scrollbackLines,
  ).toEqual(['A0']);
  expect(JSON.parse(fs.readFileSync(legacyPath(), 'utf8'))).toMatchObject({
    version: 3,
    movedTo: 'terminal-record-authority',
  });
});

it('a forget acknowledged after a pending import lands fences legacy state, so an offline load never shows it again', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  const legacyBytes = JSON.stringify(fixture());
  fs.writeFileSync(legacyPath(), legacyBytes);
  authority.dispose();
  let failConfirmation = true;
  authority = new TerminalRecordAuthority({
    repository: new TerminalRecordRepository({
      dataRoot: mockRoot,
      flushDirectorySync: (): void => {
        if (failConfirmation) throw new Error('directory flush failed');
      },
    }),
    installDebounceMs: 1,
  });
  const s = store();
  const pending = await s.loadWorktreeState('p', 'w');
  expect(pending.terminals.map((t) => t.session.id)).toEqual(['a', 'b']);
  expect(fs.readFileSync(legacyPath(), 'utf8')).toBe(legacyBytes);
  failConfirmation = false;
  s.forget('a');
  await settle();
  expect(
    authority
      .open({
        projectId: 'p',
        worktreeId: 'w',
        legacyLayout: 'workspaces',
        incarnation: null,
      })
      .terminals.map((t) => t.session.id),
  ).toEqual(['b']);
  expect(JSON.parse(fs.readFileSync(legacyPath(), 'utf8'))).toMatchObject({
    version: 3,
    movedTo: 'terminal-record-authority',
  });
  up = false;
  for (const offline of [
    await s.loadWorktreeState('p', 'w'),
    await store().loadWorktreeState('p', 'w'),
  ]) {
    expect(offline.terminals.map((t) => t.session.id)).not.toContain('a');
    expect(offline.groups.flatMap((g) => g.terminalIds)).not.toContain('a');
  }
});

it('a layout saved while the legacy import waits is kept once it lands', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  const original = fsModule.readFileSync;
  const spy = jest
    .spyOn(fsModule, 'readFileSync')
    .mockImplementation((path, options) => {
      if (path === legacyPath())
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return original(path, options);
    });
  const s = store();
  try {
    const pending = await s.loadWorktreeState('p', 'w');
    expect(pending.groups).toEqual(fixture().groups);
    s.saveWorktreeState({
      ...pending,
      projectId: 'p',
      worktreeId: 'w',
      drawerCollapsed: true,
      groups: pending.groups.map((g) => ({ ...g, splitSizes: [0.5, 0.5] })),
    });
    await settle();
  } finally {
    spy.mockRestore();
  }
  const loaded = await s.loadWorktreeState('p', 'w');
  expect(loaded.drawerCollapsed).toBe(true);
  expect(loaded.groups.map((g) => g.splitSizes)).toEqual([[0.5, 0.5]]);
  expect(JSON.parse(fs.readFileSync(legacyPath(), 'utf8'))).toMatchObject({
    version: 3,
  });
  const fresh = await store().loadWorktreeState('p', 'w');
  expect(fresh.drawerCollapsed).toBe(true);
  expect(fresh.groups.map((g) => g.splitSizes)).toEqual([[0.5, 0.5]]);
});

it('legacy state an older build wrote after the import is kept beside the fence', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  await store().loadWorktreeState('p', 'w');
  // An older build, frozen by the fence, still wrote its own state.
  const older = JSON.stringify({ ...fixture(), drawerCollapsed: true });
  fs.writeFileSync(legacyPath(), older);
  const loaded = await store().loadWorktreeState('p', 'w');
  expect(loaded.groups).toEqual(fixture().groups);
  expect(JSON.parse(fs.readFileSync(legacyPath(), 'utf8'))).toMatchObject({
    version: 3,
    movedTo: 'terminal-record-authority',
  });
  const directory = join(legacyPath(), '..');
  const aside = fs
    .readdirSync(directory)
    .filter((name) => name.startsWith('terminal-state.json.damaged-'));
  expect(aside).toHaveLength(1);
  expect(fs.readFileSync(join(directory, aside[0]), 'utf8')).toBe(older);
});

it('R9 a fence revoked after setting legacy state aside keeps the set-aside copy', async () => {
  const directory = join(legacyPath(), '..');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  await store().loadWorktreeState('p', 'w');
  const older = JSON.stringify({ ...fixture(), drawerCollapsed: true });
  fs.writeFileSync(legacyPath(), older);
  const rename = fsPromises.rename;
  let revoked = false;
  const renameSpy = jest
    .spyOn(fsPromises, 'rename')
    .mockImplementation(async (...args) => {
      await Reflect.apply(rename, fsPromises, args);
      if (String(args[0]) === legacyPath() && !revoked) {
        revoked = true;
        // A deletion that later refuses revokes the fence between rename and install.
        beginDirectoryDeletion(directory).settle('abandoned');
      }
    });
  try {
    await store().loadWorktreeState('p', 'w');
  } finally {
    renameSpy.mockRestore();
  }
  expect(revoked).toBe(true);
  expect(fs.existsSync(legacyPath())).toBe(false);
  const aside = fs
    .readdirSync(directory)
    .filter((name) => name.startsWith('terminal-state.json.damaged-'));
  expect(aside).toHaveLength(1);
  expect(fs.readFileSync(join(directory, aside[0]), 'utf8')).toBe(older);
  // Abandonment never blocks: the next load fences.
  await store().loadWorktreeState('p', 'w');
  expect(JSON.parse(fs.readFileSync(legacyPath(), 'utf8'))).toMatchObject({
    version: 3,
    movedTo: 'terminal-record-authority',
  });
});

it.each(['created', 'replaced', 'lost to a successor'] as const)(
  'R9 a fence revoked after its install lands undoes only a file it %s',
  async (install) => {
    const directory = join(legacyPath(), '..');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
    const older = JSON.stringify({ ...fixture(), drawerCollapsed: true });
    if (install !== 'replaced') {
      await store().loadWorktreeState('p', 'w');
      // An older build's state goes aside first, so the fence is a new file.
      fs.writeFileSync(legacyPath(), older);
    }
    const write = atomicFile.writeFileAtomically;
    let deletion: ReturnType<typeof beginDirectoryDeletion> | undefined;
    const writing = jest
      .spyOn(atomicFile, 'writeFileAtomically')
      .mockImplementation(async (...args) => {
        await write(...args);
        if (String(args[0]) === legacyPath() && !deletion) {
          deletion = beginDirectoryDeletion(directory);
          // A peer's file the deletion found in place.
          fs.writeFileSync(join(directory, 'unrelated'), 'keep');
          if (install === 'lost to a successor') {
            // Linux hands the freed inode number straight to the successor.
            fs.unlinkSync(legacyPath());
            fs.writeFileSync(legacyPath(), 'successor');
          }
        }
      });
    try {
      await store().loadWorktreeState('p', 'w');
    } finally {
      writing.mockRestore();
      deletion?.settle('cleanup-debt');
    }
    expect(deletion).toBeDefined();
    expect(fs.readFileSync(join(directory, 'unrelated'), 'utf8')).toBe('keep');
    if (install === 'lost to a successor')
      expect(fs.readFileSync(legacyPath(), 'utf8')).toBe('successor');
    else if (install === 'created') {
      expect(fs.existsSync(legacyPath())).toBe(false);
      const aside = fs
        .readdirSync(directory)
        .filter((name) => name.startsWith('terminal-state.json.damaged-'));
      expect(
        aside.map((name) => fs.readFileSync(join(directory, name), 'utf8')),
      ).toEqual([older]);
    } else {
      // Unlinking a replacement would keep neither the imported bytes nor the fence.
      expect(JSON.parse(fs.readFileSync(legacyPath(), 'utf8'))).toMatchObject({
        version: 3,
        movedTo: 'terminal-record-authority',
      });
    }
  },
);

it('R9 a retired drawer load whose existence check outlives a deletion does not revive the scope', async () => {
  const directory = join(legacyPath(), '..');
  let answer: (exists: boolean) => void = () => undefined;
  let asked: () => void = () => undefined;
  const checking = new Promise<void>((resolve) => {
    asked = resolve;
  });
  let held = false;
  const s = newStore({
    records,
    outbox: newOutbox(),
    scopeExists: () => {
      if (!held) return Promise.resolve(true);
      held = false;
      asked();
      return new Promise<boolean>((resolve) => {
        answer = resolve;
      });
    },
  });
  s.registerLiveSession(session('old'));
  await s.drainAll();
  // An earlier cleanup of this worktree id retired its scope.
  await s.retireTerminalRecord({ projectId: 'p', worktreeId: 'w' });
  await s.drainAll();
  held = true;
  const loading = s.loadWorktreeState('p', 'w');
  await checking;
  // The deletion begins and commits while the stale check is pending; no
  // scope is allocated, so no read revision advances.
  const deletion = beginDirectoryDeletion(directory);
  fs.rmSync(directory, { recursive: true, force: true });
  deletion.settle('removed');
  answer(true);
  const view = await loading;
  expect(view.terminals).toEqual([]);
  // The drawer's delayed layout save.
  s.saveWorktreeState({
    ...view,
    projectId: 'p',
    worktreeId: 'w',
    drawerCollapsed: !view.drawerCollapsed,
    terminalCustomNames: { old: 'Late' },
  });
  await s.drainAll();
  s.markAllLiveTerminalsExited('app-quit');
  expect(fs.existsSync(directory)).toBe(false);
  expect(
    fs.existsSync(join(terminalRecordDir(mockRoot, 'p', 'w'), 'record.json')),
  ).toBe(false);
  expect(
    (await newOutbox().read()).outbox.scopes.filter(
      (scope) =>
        scope.client.projectId === 'p' &&
        scope.client.worktreeId === 'w' &&
        scope.entries.length > 0,
    ),
  ).toEqual([]);
});

it.each(['after', 'during'] as const)(
  'R9 a late load or save of a lifetime the retirement missed never recreates removed metadata: quit %s the load',
  async (quit) => {
    const directory = join(legacyPath(), '..');
    let exists = true;
    let checking: () => void = () => undefined;
    const s = newStore({
      records,
      outbox: newOutbox(),
      scopeExists: () => {
        checking();
        return Promise.resolve(exists);
      },
    });
    // Workspace deletion captures its intent before this lifetime starts.
    const intent = await s.prepareTerminalRecordRetirement({ projectId: 'p' });
    s.registerLiveSession(session('late'));
    const view = await s.loadWorktreeState('p', 'w');
    await s.drainAll();
    const deletion = beginDirectoryDeletion(directory);
    // The drawer's layout save lands while the removal runs.
    s.saveWorktreeState({
      ...view,
      projectId: 'p',
      worktreeId: 'w',
      drawerCollapsed: !view.drawerCollapsed,
    });
    await s.drainAll();
    await s.retirePreparedTerminalRecord(intent);
    fs.rmSync(directory, { recursive: true, force: true });
    exists = false;
    deletion.settle('removed');
    // Quit installs the pending layout while the late load awaits existence.
    if (quit === 'during')
      checking = (): void => {
        checking = (): void => undefined;
        s.markAllLiveTerminalsExited('app-quit');
      };
    const late = await s.loadWorktreeState('p', 'w');
    expect(late.terminals).toEqual([]);
    expect(fs.existsSync(directory)).toBe(false);
    s.saveWorktreeState({
      ...late,
      projectId: 'p',
      worktreeId: 'w',
      drawerCollapsed: !late.drawerCollapsed,
    });
    await s.drainAll();
    s.markAllLiveTerminalsExited('app-quit');
    expect(fs.existsSync(directory)).toBe(false);
  },
);

it.each([
  ['online', false, false],
  ['online', true, false],
  ['online', 'mixed', false],
  ['outbox', false, false],
  ['outbox', true, false],
  ['outbox', 'mixed', false],
  ['online', false, true],
  ['online', true, true],
  ['outbox', false, true],
  ['outbox', true, true],
] as const)(
  'a load keeps a terminal acknowledged through %s (history captured before writes: %s, recreated: %s)',
  async (route, captureFirst, recreate): Promise<void> => {
    let historyReads = 0;
    let historyCaptured = 0;
    let reading: () => void = () => undefined;
    const historyStarted = new Promise<void>((resolve) => {
      reading = resolve;
    });
    let resume: () => void = () => undefined;
    const historyResumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const s = newStore({
      records: {
        ...records,
        historyRead: async (
          params,
        ): Promise<WorkerTerminalRecordHistoryReadResult> => {
          historyReads += 1;
          const page =
            captureFirst === true ||
            (captureFirst === 'mixed' && historyReads === 1)
              ? await records.historyRead(params)
              : null;
          historyCaptured += 1;
          if (historyCaptured === 2) reading();
          await historyResumed;
          return page ?? records.historyRead(params);
        },
      },
      outbox: newOutbox(),
    });
    s.registerLiveSession(session('a'));
    s.appendTerminalOutput('p', 'w', 'a', Buffer.from('first'));
    await s.drainAll();
    const loading = Promise.all([
      s.loadWorktreeState('p', 'w'),
      s.loadWorktreeState('p', 'w'),
    ]);
    try {
      await historyStarted;
      if (route === 'outbox') up = false;
      if (recreate) {
        s.markTerminalExited('p', 'w', 'a', 0, null);
        s.forget('a');
        s.registerLiveSession(session('a'));
      }
      s.appendTerminalOutput(
        'p',
        'w',
        'a',
        Buffer.from(recreate ? 'recreated' : '\ncontinued'),
      );
      s.markTerminalExited('p', 'w', 'a', 0, null);
      s.registerLiveSession(session('b'));
      s.appendTerminalOutput('p', 'w', 'b', Buffer.from('second\nfinished'));
      s.markTerminalExited('p', 'w', 'b', 7, null);
      await s.drainAll();
      if (route === 'outbox') {
        up = true;
        await s.drainAll();
      }
      // The batch has left both the in-flight send and the durable outbox.
      expect((await newOutbox().read())?.outbox.scopes ?? []).toEqual([]);
      const recorded = authority.open({
        projectId: 'p',
        worktreeId: 'w',
        legacyLayout: 'workspaces',
        incarnation: null,
      });
      expect(recorded.terminals.map((entry) => entry.session.id)).toEqual([
        'a',
        'b',
      ]);
    } finally {
      up = true;
      resume();
    }
    for (const loaded of await loading) {
      expect(loaded.history).toEqual({ status: 'available' });
      expect(
        loaded.terminals.map((entry) => ({
          id: entry.session.id,
          lines: entry.scrollbackLines,
          exitCode: entry.exitCode,
        })),
      ).toEqual([
        {
          id: 'a',
          lines: recreate ? ['recreated'] : ['first', 'continued'],
          exitCode: 0,
        },
        { id: 'b', lines: ['second', 'finished'], exitCode: 7 },
      ]);
    }
  },
);

it('in-process output reaches the record; forget is rebased on what was served', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('x'));
  s.appendTerminalOutput('p', 'w', 'x', Buffer.from('hello\nworld'));
  s.markTerminalExited('p', 'w', 'x', 0, null);
  await settle();
  const restarted = store();
  const loaded = await restarted.loadWorktreeState('p', 'w');
  const x = loaded.terminals.find((t) => t.session.id === 'x');
  expect(x).toMatchObject({ scrollbackLines: ['hello', 'world'], exitCode: 0 });
  // A terminal created by someone else after this load is kept by a save
  // that never saw it.
  authority.apply({
    client: {
      projectId: 'p',
      worktreeId: 'w',
      legacyLayout: 'workspaces',
      incarnation: null,
    },
    producer: { id: 'other', runId: 'r' },
    seq: 1,
    ops: [{ op: 'session.upsert', session: session('late') }],
  });
  restarted.saveWorktreeState({
    ...loaded,
    projectId: 'p',
    worktreeId: 'w',
    groups: [],
    forgetTerminalIds: ['x'],
  });
  await settle();
  const after = await store().loadWorktreeState('p', 'w');
  expect(after.terminals.map((t) => t.session.id)).toEqual(['late']);
});

it('a terminal created after the last load is forgotten when its group closes', async () => {
  const s = store();
  const loaded = await s.loadWorktreeState('p', 'w');
  const save = (terminalIds: string[][], forgetTerminalIds?: string[]): void =>
    s.saveWorktreeState({
      ...loaded,
      projectId: 'p',
      worktreeId: 'w',
      groups: terminalIds.map((ids, index) => ({
        id: `g${index}`,
        terminalIds: ids,
        focusedTerminalId: ids[0],
        splitSizes: ids.map(() => 1 / ids.length),
      })),
      ...(forgetTerminalIds && { forgetTerminalIds }),
    });
  // An in-process shell closed before any save showed it.
  s.registerLiveSession(session('quick'));
  s.appendTerminalOutput('p', 'w', 'quick', Buffer.from('gone'));
  // An in-process shell a save showed, then closed.
  s.registerLiveSession(session('shown'));
  // A daemon terminal: the record keeps it through its host.
  const client = {
    projectId: 'p',
    worktreeId: 'w',
    legacyLayout: 'workspaces' as const,
    incarnation: null,
  };
  const registration = authority.attribute({
    terminalId: 'dn',
    client,
    session: session('dn'),
    persist: true,
  });
  s.recordedTerminals.registerLiveSession(session('dn'));
  // Another client's terminal the drawer was shown through a save only.
  authority.apply({
    client,
    producer: { id: 'other', runId: 'r' },
    seq: 1,
    ops: [{ op: 'session.upsert', session: session('elsewhere') }],
  });
  save([['shown'], ['dn'], ['elsewhere']]);
  await settle();
  save([], ['quick', 'shown', 'dn', 'elsewhere']);
  // Closing a group ends its shells after the save that dropped them.
  s.markTerminalExited('p', 'w', 'quick', null, 'user-close');
  s.markTerminalExited('p', 'w', 'shown', null, 'user-close');
  authority.exited(registration, null, 'user-close');
  s.recordedTerminals.markTerminalExited('p', 'w', 'dn', null, 'user-close');
  await settle();
  // A window reload, then an app restart.
  for (const reloaded of [
    await s.loadWorktreeState('p', 'w'),
    await store().loadWorktreeState('p', 'w'),
  ]) {
    expect(reloaded.terminals).toEqual([]);
    expect(reloaded.groups).toEqual([]);
  }
});

it('defers to the outbox while the daemon is down, serves unavailable history, then drains', async () => {
  up = false;
  const s = store();
  const first = await s.loadWorktreeState('p', 'w');
  expect(first.history).toEqual({
    status: 'unavailable',
    reason: 'background_service',
  });
  s.registerLiveSession(session('d'));
  s.appendTerminalOutput('p', 'w', 'd', Buffer.from('queued'));
  await settle();
  expect(fs.existsSync(join(mockRoot, 'terminal-record-outbox.json'))).toBe(
    true,
  );
  const overlay = await s.loadWorktreeState('p', 'w');
  expect(
    overlay.terminals.find((t) => t.session.id === 'd')?.scrollbackLines,
  ).toEqual(['queued']);
  // Quit seals it; the next run drains before its load.
  s.markAllLiveTerminalsExited('app-quit');
  up = true;
  const next = store();
  next.start();
  const loaded = await next.loadWorktreeState('p', 'w');
  expect(loaded.history).toEqual({ status: 'available' });
  expect(loaded.terminals.find((t) => t.session.id === 'd')).toMatchObject({
    scrollbackLines: ['queued'],
    signal: 'app-quit',
  });
  expect(fs.existsSync(join(mockRoot, 'terminal-record-outbox.json'))).toBe(
    false,
  );
});

it('a reachable authority with a failed install degrades the load and defers terminal reports durably', async () => {
  const saving = jest
    .spyOn(TerminalRecordRepository.prototype, 'save')
    .mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
  const s = store();
  try {
    const loaded = await s.loadWorktreeState('p', 'w');
    expect(loaded.history).toEqual({
      status: 'unavailable',
      reason: 'background_service',
    });
    s.registerLiveSession(session('deferred'));
    s.appendTerminalOutput('p', 'w', 'deferred', Buffer.from('queued'));
    await settle();
    expect(fs.existsSync(join(mockRoot, 'terminal-record-outbox.json'))).toBe(
      true,
    );
  } finally {
    saving.mockRestore();
    authority.flushSync();
  }
  await s.drainAll();
  const loaded = await store().loadWorktreeState('p', 'w');
  expect(loaded.history).toEqual({ status: 'available' });
  expect(
    loaded.terminals.find((t) => t.session.id === 'deferred'),
  ).toMatchObject({
    scrollbackLines: ['queued'],
  });
  expect(fs.existsSync(join(mockRoot, 'terminal-record-outbox.json'))).toBe(
    false,
  );
});

interface OutboxFileShape {
  scopes: {
    entries: { seq: number; runId: string; ops: unknown[]; sealed?: unknown }[];
  }[];
}
function isOutboxFile(value: unknown): value is OutboxFileShape {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray(Reflect.get(value, 'scopes'))
  );
}
// The shared file and any run's own file (a quit before the merge).
const readOutbox = (): OutboxFileShape => ({
  scopes: fs
    .readdirSync(mockRoot)
    .filter((name) => name.startsWith('terminal-record-outbox'))
    .flatMap((name) => {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(join(mockRoot, name), 'utf8'),
      );
      if (!isOutboxFile(parsed)) throw new Error(`Unexpected ${name}`);
      return parsed.scopes;
    }),
});
const terminalIds = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `t${index}`);

it('more ops than one apply carries queue while down and drain on reconnect', async () => {
  up = false;
  const s = store();
  await s.loadWorktreeState('p', 'w');
  const ids = terminalIds(400);
  // 800 ops that never coalesce: an upsert and an exit each.
  for (const id of ids) s.registerLiveSession(session(id));
  await settle();
  for (const id of ids) s.markTerminalExited('p', 'w', id, 0, null);
  await settle();
  const entries = readOutbox().scopes.flatMap((scope) => scope.entries);
  expect(entries.reduce((sum, entry) => sum + entry.ops.length, 0)).toBe(800);
  for (const entry of entries)
    expect(entry.ops.length).toBeLessThanOrEqual(
      WORKER_TERMINAL_RECORD_MAX_OPS,
    );
  const seqs = entries.map((entry) => entry.seq);
  expect(new Set(seqs).size).toBe(seqs.length);
  expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  up = true;
  await s.drainAll();
  expect(fs.existsSync(join(mockRoot, 'terminal-record-outbox.json'))).toBe(
    false,
  );
  const loaded = await store().loadWorktreeState('p', 'w');
  expect(loaded.terminals.map((t) => t.session.id).sort()).toEqual(
    [...ids].sort(),
  );
  expect(loaded.terminals.every((t) => t.exitCode === 0)).toBe(true);
});

it('a quit seals more ops than one apply carries as several entries, sealed last', async () => {
  up = false;
  const s = store();
  await prepareReplayScope(s);
  const ids = terminalIds(700);
  for (const id of ids) s.registerLiveSession(session(id));
  // Nothing flushed yet: the quit takes every pending op at once.
  s.markAllLiveTerminalsExited('app-quit');
  const entries = readOutbox().scopes.flatMap((scope) => scope.entries);
  expect(entries.length).toBeGreaterThan(1);
  for (const entry of entries)
    expect(entry.ops.length).toBeLessThanOrEqual(
      WORKER_TERMINAL_RECORD_MAX_OPS,
    );
  expect(entries.map((entry) => entry.sealed !== undefined)).toEqual(
    entries.map((_, index) => index === entries.length - 1),
  );
  up = true;
  const next = store();
  next.start();
  const loaded = await next.loadWorktreeState('p', 'w');
  expect(loaded.terminals).toHaveLength(700);
  expect(loaded.terminals.every((t) => t.signal === 'app-quit')).toBe(true);
});

it('an outbox entry the authority rejects never holds later writes behind it', async () => {
  // An earlier run left an entry past the cap, holding one op the schema
  // rejects (a name longer than any the record keeps).
  const ids = terminalIds(600);
  const ops: unknown[] = ids.map((id) => ({
    op: 'session.upsert',
    session: session(id),
  }));
  ops.splice(300, 0, { op: 'rename', terminalId: 't0', name: 'n'.repeat(65) });
  fs.writeFileSync(
    join(mockRoot, 'terminal-record-outbox.json'),
    JSON.stringify({
      version: 1,
      producer: 'electron_main',
      scopes: [
        {
          client: seedReplayWitness('rejected-entry'),
          entries: [{ seq: 1, runId: 'earlier', ops }],
        },
      ],
      retirements: [],
    }),
  );
  const s = store();
  s.start();
  await s.drainAll();
  // Split, the bad op isolated and dropped, in a bounded number of calls.
  expect(applyCalls).toBeLessThan(40);
  expect(fs.existsSync(join(mockRoot, 'terminal-record-outbox.json'))).toBe(
    false,
  );
  // This run's writes are applied online again.
  s.registerLiveSession(session('later'));
  await settle();
  expect(fs.existsSync(join(mockRoot, 'terminal-record-outbox.json'))).toBe(
    false,
  );
  const loaded = await store().loadWorktreeState('p', 'w');
  expect(loaded.terminals.map((t) => t.session.id).sort()).toEqual(
    [...ids, 'later'].sort(),
  );
  expect(loaded.terminalCustomNames).toEqual({});
});

it('a drain repeated after an unknown outcome applies once', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  // The daemon applies but the reply is lost.
  loseApplyReplies = 1;
  s.registerLiveSession(session('u'));
  s.appendTerminalOutput('p', 'w', 'u', Buffer.from('once'));
  await settle(400);
  await s.drainAll();
  const loaded = await store().loadWorktreeState('p', 'w');
  expect(
    loaded.terminals.find((t) => t.session.id === 'u')?.scrollbackLines,
  ).toEqual(['once']);
});

it.each(['reconnect', 'outbox rehydration'] as const)(
  'a lost online reply retries its full admission identity after %s',
  async (recovery) => {
    const attempts: string[] = [];
    let loseReply = true;
    const client: TerminalRecordClientPort = {
      ...records,
      apply: async (params): Promise<WorkerTerminalRecordApplyResult> => {
        attempts.push(JSON.stringify(params));
        const result = await records.apply(params);
        if (loseReply) {
          loseReply = false;
          up = false;
          throw new Error('lost reply');
        }
        return result;
      },
    };
    const options = {
      records: client,
      outbox: newOutbox(),
      incarnation: (): Promise<string> => Promise.resolve('known-incarnation'),
    };
    const s = newStore(options);
    await s.loadWorktreeState('p', 'w');
    s.registerLiveSession(session('rehydrated'));
    s.appendTerminalOutput('p', 'w', 'rehydrated', Buffer.from('once'));
    await s.drainAll();
    expect(attempts).toHaveLength(1);
    expect(JSON.parse(attempts[0])).toMatchObject({
      client: { generation: 1, incarnation: 'known-incarnation' },
    });
    if (recovery === 'outbox rehydration')
      s.markAllLiveTerminalsExited('app-quit');
    const next =
      recovery === 'outbox rehydration'
        ? newStore({ ...options, outbox: newOutbox() })
        : s;
    up = true;
    await next.drainAll();
    expect(attempts.length).toBeGreaterThan(1);
    expect(attempts[1]).toBe(attempts[0]);
    const loaded = await next.loadWorktreeState('p', 'w');
    expect(
      loaded.terminals.find((entry) => entry.session.id === 'rehydrated')
        ?.scrollbackLines,
    ).toEqual(['once']);
  },
);

it.each(['plain', 'run/slash', 'run%percent', 'run%2Fencoded'])(
  'a lost reply rebases queued history against the escaped watermark for %s',
  async (runId) => {
    const outbox = newOutbox();
    const client: WorkerTerminalRecordClient = {
      projectId: 'p',
      worktreeId: 'w',
      legacyLayout: 'workspaces',
      incarnation: 'current',
    };
    await outbox.write({
      version: 1,
      producer: 'electron_main',
      scopes: [
        {
          client,
          entries: [
            {
              seq: 1,
              runId,
              ops: [
                { op: 'session.upsert', session: session('escaped') },
                { op: 'output.append', terminalId: 'escaped', text: 'once' },
              ],
            },
          ],
        },
      ],
      retirements: [],
    });
    const s = newStore({
      records: {
        ...records,
        apply: async (params): Promise<WorkerTerminalRecordApplyResult> => {
          await records.apply(params);
          throw new Error('lost reply');
        },
      },
      outbox,
      incarnation: () => Promise.resolve('current'),
    });
    await s.drainAll();
    expect((await outbox.read())?.outbox.scopes[0].entries).toHaveLength(1);
    expect(
      (await s.loadWorktreeState('p', 'w')).terminals[0].scrollbackLines,
    ).toEqual(['once']);
    const release = await s.prefetchPersistedEntry('escaped');
    expect(s.getPersistedTerminalEntry('escaped')?.scrollbackLines).toEqual([
      'once',
    ]);
    release();
    expect((await outbox.read())?.outbox.scopes[0].entries).toHaveLength(1);
  },
);

it('retirement while down is kept and applied before anything else', async () => {
  const s = store();
  s.registerLiveSession(session('r'));
  await settle();
  up = false;
  void s.retireTerminalRecord({ projectId: 'p', worktreeId: 'w' });
  up = true;
  await s.drainAll();
  const loaded = await store().loadWorktreeState('p', 'w');
  expect(loaded.terminals).toEqual([]);
});

it('a restore prefetches history for the engine and releases it', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('h'));
  s.appendTerminalOutput('p', 'w', 'h', Buffer.from('a\nb'));
  s.markTerminalExited('p', 'w', 'h', null, null);
  await settle();
  const fresh = store();
  await fresh.loadWorktreeState('p', 'w');
  expect(fresh.getPersistedTerminalEntry('h')).toBeNull();
  const release = await fresh.prefetchPersistedEntry('h');
  expect(fresh.getPersistedTerminalEntry('h')?.scrollbackLines).toEqual([
    'a',
    'b',
  ]);
  release();
  expect(fresh.getPersistedTerminalEntry('h')).toBeNull();
});

it('an in-process restore overlays pending output without waiting for a flush', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('pending-restore'));
  s.appendTerminalOutput('p', 'w', 'pending-restore', Buffer.from('durable\n'));
  await s.drainAll();
  s.appendTerminalOutput(
    'p',
    'w',
    'pending-restore',
    Buffer.from('pending tail'),
  );
  s.markTerminalExited('p', 'w', 'pending-restore', 3, null);
  const release = await s.prefetchPersistedEntry('pending-restore');
  expect(s.getPersistedTerminalEntry('pending-restore')).toMatchObject({
    scrollbackLines: ['durable', 'pending tail'],
    exitCode: 3,
  });
  release();
  s.forget('pending-restore');
  expect(s.getTerminalMetadata('pending-restore')).toBeNull();
  const releaseForgotten = await s.prefetchPersistedEntry('pending-restore');
  expect(s.getPersistedTerminalEntry('pending-restore')).toBeNull();
  releaseForgotten();
  await s.drainAll();
});

it.each(['pending', 'outbox'] as const)(
  'bounds newline-free producer history across %s batches without discarding older lines',
  async (mode) => {
    const s = store();
    await s.loadWorktreeState('p', 'w');
    s.registerLiveSession(session('bounded-producer'));
    s.appendTerminalOutput(
      'p',
      'w',
      'bounded-producer',
      Buffer.from('older line\n'),
    );
    await s.drainAll();
    up = false;
    for (let index = 0; index < 32; index += 1) {
      s.appendTerminalOutput(
        'p',
        'w',
        'bounded-producer',
        Buffer.alloc(256 * 1024, 'x'),
      );
      if (mode === 'outbox' && index % 8 === 7) {
        // Force splitting independently of this terminal's output.
        if (index === 7)
          for (const id of terminalIds(520)) s.registerLiveSession(session(id));
        await s.drainAll();
      }
    }
    if (mode === 'pending') {
      // A quit serializes pending ops without first folding them into an outbox.
      s.markAllLiveTerminalsExited('app-quit');
    }
    const entries = readOutbox().scopes.flatMap((scope) => scope.entries);
    const ops = entries.flatMap(
      (entry) =>
        WorkerTerminalRecordApplyParamsSchema.parse({
          client: {
            projectId: 'p',
            worktreeId: 'w',
            legacyLayout: 'workspaces',
            incarnation: null,
          },
          producer: { id: 'electron_main', runId: entry.runId },
          seq: entry.seq,
          ops: entry.ops,
        }).ops,
    );
    const bytes = ops.reduce((sum, op) => {
      if (!('terminalId' in op) || op.terminalId !== 'bounded-producer')
        return sum;
      return (
        sum +
        (op.op === 'output.append'
          ? Buffer.byteLength(op.text)
          : op.op === 'output.replace'
            ? Buffer.byteLength(op.lines.join('\n'))
            : 0)
      );
    }, 0);
    expect(bytes).toBeLessThanOrEqual(1024 * 1024);
    up = true;
    await s.drainAll();
    const loaded = await store().loadWorktreeState('p', 'w');
    expect(
      loaded.terminals.find((t) => t.session.id === 'bounded-producer')
        ?.scrollbackLines,
    ).toEqual(['older line', 'x'.repeat(1024 * 1024)]);
  },
);

it('bounds total UTF-8 producer bytes across split outbox entries', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  up = false;
  s.registerLiveSession(session('byte-tail'));
  const text = `${'🙂'.repeat(131072)}\n`;
  for (let index = 0; index < 16; index += 1) {
    s.appendTerminalOutput('p', 'w', 'byte-tail', Buffer.from(text));
    if (index === 0)
      for (const id of terminalIds(520)) s.registerLiveSession(session(id));
    if (index % 4 === 3) await s.drainAll();
  }
  const ops = readOutbox()
    .scopes.flatMap((scope) => scope.entries)
    .flatMap(
      (entry) =>
        WorkerTerminalRecordApplyParamsSchema.parse({
          client: {
            projectId: 'p',
            worktreeId: 'w',
            legacyLayout: 'workspaces',
            incarnation: null,
          },
          producer: { id: 'electron_main', runId: entry.runId },
          seq: entry.seq,
          ops: entry.ops,
        }).ops,
    );
  const bytes = ops.reduce(
    (sum, op) =>
      sum +
      ('terminalId' in op && op.terminalId === 'byte-tail'
        ? op.op === 'output.append'
          ? Buffer.byteLength(op.text)
          : op.op === 'output.replace'
            ? Buffer.byteLength(op.lines.join('\n'))
            : 0
        : 0),
    0,
  );
  expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  up = true;
  await s.drainAll();
  const loaded = await store().loadWorktreeState('p', 'w');
  const lines = loaded.terminals.find(
    (t) => t.session.id === 'byte-tail',
  )?.scrollbackLines;
  expect(lines).toBeDefined();
  expect(Buffer.byteLength(lines?.join('\n') ?? '')).toBeLessThanOrEqual(
    4 * 1024 * 1024,
  );
  expect(lines?.join('\n')).not.toContain('�');
  expect(lines?.at(-2)).toBe('🙂'.repeat(131072));
});

it('an escape-heavy backlog past the longest string still publishes and seals', async () => {
  // V8's string limit and the apply bound, scaled down together: the same
  // codec path runs at a few MB instead of past 512 MiB.
  const maxStringLength = 256 * 1024;
  const applyBatchMaxBytes = 64 * 1024;
  const scaledOutbox = (): TerminalRecordOutbox =>
    new TerminalRecordOutbox(() => mockRoot, { maxStringLength });
  up = false;
  const s = newStore({
    records,
    outbox: scaledOutbox(),
    applyBatchMaxBytes,
  });
  // Every byte an escape, which JSON writes as six chars.
  const chunk = `${'\x1b'.repeat(4 * 1024 - 1)}\n`;
  const ids = Array.from({ length: 24 }, (_, index) => `escape-${index}`);
  for (const id of ids) {
    s.registerLiveSession(session(id));
    for (let part = 0; part < 4; part += 1)
      s.appendTerminalOutput('p', 'w', id, Buffer.from(chunk));
  }
  await s.drainAll();
  expect(s.isOutboxWarningShown()).toBe(false);
  // The quit seal adds every exit to the same backlog.
  s.markAllLiveTerminalsExited('app-quit');
  const path = join(mockRoot, 'terminal-record-outbox.json');
  expect(fs.statSync(path).size).toBeGreaterThan(4 * maxStringLength);
  const { outbox } = await scaledOutbox().read();
  const entries = outbox.scopes.flatMap((scope) => scope.entries);
  const output = new Map<string, number>();
  const exits = new Set<string>();
  for (const entry of entries) {
    // A batch of several ops stays within one apply's bound.
    if (entry.ops.length > 1)
      expect(Buffer.byteLength(JSON.stringify(entry.ops))).toBeLessThanOrEqual(
        applyBatchMaxBytes,
      );
    for (const op of entry.ops) {
      if (op.op === 'output.append')
        output.set(
          op.terminalId,
          (output.get(op.terminalId) ?? 0) + op.text.length,
        );
      if (op.op === 'exit') exits.add(op.terminalId);
    }
  }
  for (const id of ids) {
    expect(output.get(id)).toBe(4 * chunk.length);
    expect(exits.has(id)).toBe(true);
  }
});

it.each([
  ['layout', 'pending and split outbox'],
  ['rename', 'pending and split outbox'],
  ['upsert', 'pending and split outbox'],
  ['layout', 'pending-only'],
  ['rename', 'pending-only'],
  ['upsert', 'pending-only'],
  ['layout', 'lost-reply'],
  ['rename', 'lost-reply'],
  ['upsert', 'lost-reply'],
] as const)(
  'bounds retained output across %s changes in %s batches',
  async (change, mode) => {
    let loseReply = false;
    const attempts: string[] = [];
    const client: TerminalRecordClientPort = {
      ...records,
      apply: async (params): Promise<WorkerTerminalRecordApplyResult> => {
        attempts.push(JSON.stringify(params));
        const result = await records.apply(params);
        if (loseReply) {
          loseReply = false;
          up = false;
          throw new Error('lost reply');
        }
        return result;
      },
    };
    const s = newStore({
      records: client,
      outbox: newOutbox(),
    });
    await s.loadWorktreeState('p', 'w');
    s.registerLiveSession(session('barriers'));
    s.appendTerminalOutput('p', 'w', 'barriers', Buffer.from('durable\n'));
    await s.drainAll();
    const view = await s.loadWorktreeState('p', 'w');
    attempts.length = 0;
    if (mode === 'lost-reply') {
      loseReply = true;
      s.appendTerminalOutput('p', 'w', 'barriers', Buffer.from('once\n'));
      await s.drainAll();
      expect(attempts).toHaveLength(1);
      expect(up).toBe(false);
    }
    const attemptedEntry =
      mode === 'lost-reply' ? readOutbox().scopes[0]?.entries[0] : undefined;
    const attemptedBytes = attemptedEntry && JSON.stringify(attemptedEntry);
    const attemptedRequest = attempts[0];
    if (mode === 'lost-reply') expect(attemptedEntry).toBeDefined();
    up = false;
    for (let index = 0; index < 16; index += 1) {
      s.appendTerminalOutput(
        'p',
        'w',
        'barriers',
        Buffer.from(`${String(index).padStart(2, '0')}${'x'.repeat(524286)}\n`),
      );
      if (change === 'layout')
        s.saveWorktreeState({ ...view, projectId: 'p', worktreeId: 'w' });
      else if (change === 'rename')
        s.saveWorktreeState({
          ...view,
          projectId: 'p',
          worktreeId: 'w',
          terminalCustomNames: { barriers: `Name ${index}` },
        });
      else s.registerLiveSession(session('barriers'));
      if (index === 7 && mode !== 'pending-only') {
        // Force entry splitting, then continue the same history after it.
        for (const id of terminalIds(520)) s.registerLiveSession(session(id));
        await s.drainAll();
      }
    }
    s.markAllLiveTerminalsExited('app-quit');
    const entries = readOutbox().scopes.flatMap((scope) => scope.entries);
    if (attemptedEntry) {
      // Unknown outcomes keep exact bytes outside the compactable suffix.
      expect(JSON.stringify(entries[0])).toBe(attemptedBytes);
      entries.shift();
    }
    expect(attempts).toHaveLength(mode === 'lost-reply' ? 1 : 0);
    const ops = entries
      .flatMap((entry) => entry.ops)
      .map((op) => WorkerTerminalRecordOpSchema.parse(op));
    const bytes = ops.reduce<number>(
      (sum, op) =>
        sum +
        ('terminalId' in op && op.terminalId === 'barriers'
          ? op.op === 'output.append'
            ? Buffer.byteLength(op.text)
            : op.op === 'output.replace'
              ? Buffer.byteLength(op.lines.join('\n'))
              : 0
          : 0),
      0,
    );
    expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    up = true;
    await s.drainAll();
    expect(attempts).toHaveLength(mode === 'lost-reply' ? 1 : 0);
    // Quit transfers replay to the next launch; observe its retries too.
    const next = newStore({ records: client, outbox: newOutbox() });
    await next.drainAll();
    if (mode === 'lost-reply') {
      expect(attempts.length).toBeGreaterThan(1);
      expect(attempts[1]).toBe(attemptedRequest);
    }
    const loaded = await store().loadWorktreeState('p', 'w');
    const lines = loaded.terminals.find(
      (t) => t.session.id === 'barriers',
    )?.scrollbackLines;
    expect(lines?.at(-2)).toBe(`15${'x'.repeat(524286)}`);
    // Eight 512 KiB lines plus their newlines exceed 4 MiB by eight bytes.
    expect(lines).toEqual([
      'x'.repeat(524280),
      ...Array.from(
        { length: 7 },
        (_, index) =>
          `${String(index + 9).padStart(2, '0')}${'x'.repeat(524286)}`,
      ),
      '',
    ]);
    expect(Buffer.byteLength(lines?.join('\n') ?? '')).toBeLessThanOrEqual(
      4 * 1024 * 1024,
    );
    if (change === 'rename')
      expect(loaded.terminalCustomNames.barriers).toBe('Name 15');
    expect(
      loaded.terminals.find((t) => t.session.id === 'barriers'),
    ).toMatchObject({
      exitCode: null,
      signal: 'app-quit',
    });
    expect(loaded.groups.flatMap((group) => group.terminalIds)).toContain(
      'barriers',
    );
  },
);

it.each(['token', 'tokenless', 'evicted-token', 'evicted-tokenless'] as const)(
  'R8 partial-drawer renames preserve saved split membership (%s)',
  async (client) => {
    fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
    fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
    const full = await store().loadWorktreeState('p', 'w');
    // A later run that has not read the record serves fallback singletons.
    const s = store();
    s.registerLiveSession(session('a'));
    await s.drainAll();
    up = false;
    const partial = await s.loadWorktreeState('p', 'w');
    expect(partial.groups.flatMap((group) => group.terminalIds)).toEqual(['a']);
    expect(partial.groups[0].id).not.toBe(full.groups[0].id);
    if (client.startsWith('evicted')) {
      up = true;
      for (let load = 0; load < 64; load += 1)
        await s.loadWorktreeState('p', 'w');
    }
    const request = {
      ...partial,
      projectId: 'p',
      worktreeId: 'w',
      viewToken: client.endsWith('tokenless') ? undefined : partial.viewToken,
      terminalCustomNames: { a: 'Renamed' },
    };
    s.saveWorktreeState(request);
    up = true;
    await s.drainAll();
    const after = await store().loadWorktreeState('p', 'w');
    expect(
      after.groups.map(({ id, terminalIds }) => ({ id, terminalIds })),
    ).toEqual(full.groups.map(({ id, terminalIds }) => ({ id, terminalIds })));
    expect(after.terminalCustomNames).toEqual({ a: 'Renamed', b: 'Build' });
    if (client === 'token') {
      s.saveWorktreeState({ ...request, terminalCustomNames: {} });
      await s.drainAll();
      expect(
        (await store().loadWorktreeState('p', 'w')).terminalCustomNames,
      ).toEqual({ b: 'Build' });
    }
    // Explicit membership changes from the same partial drawer still apply.
    s.saveWorktreeState({
      ...request,
      groups: [{ ...partial.groups[0], id: 'user-group' }],
    });
    await s.drainAll();
    expect((await store().loadWorktreeState('p', 'w')).groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'user-group', terminalIds: ['a'] }),
        expect.objectContaining({ id: full.groups[0].id, terminalIds: ['b'] }),
      ]),
    );
    if (client === 'token') {
      // A known drawer can intentionally move back into a default-shaped group.
      s.saveWorktreeState(request);
      await s.drainAll();
      expect((await store().loadWorktreeState('p', 'w')).groups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: partial.groups[0].id,
            terminalIds: ['a'],
          }),
          expect.objectContaining({
            id: full.groups[0].id,
            terminalIds: ['b'],
          }),
        ]),
      );
    }
  },
);

it('R8 partial regroup preserves untouched fallback membership', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  const full = await store().loadWorktreeState('p', 'w');
  // A later run that has not read the record serves fallback singletons.
  const s = store();
  s.registerLiveSession(session('a'));
  s.registerLiveSession(session('b'));
  await s.drainAll();
  up = false;
  const partial = await s.loadWorktreeState('p', 'w');
  s.saveWorktreeState({
    ...partial,
    projectId: 'p',
    worktreeId: 'w',
    groups: partial.groups.map((group) =>
      group.terminalIds.includes('a') ? { ...group, id: 'user-group' } : group,
    ),
    terminalCustomNames: { a: 'Renamed' },
  });
  up = true;
  await s.drainAll();
  const after = await store().loadWorktreeState('p', 'w');
  expect(after.groups).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'user-group', terminalIds: ['a'] }),
      expect.objectContaining({ id: full.groups[0].id, terminalIds: ['b'] }),
    ]),
  );
  expect(after.terminalCustomNames).toEqual({ a: 'Renamed', b: 'Build' });
});

it('a save after a partial load never forgets what that load could not show', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  const s = store();
  const full = await s.loadWorktreeState('p', 'w');
  expect(full.terminals.map((t) => t.session.id)).toEqual(['a', 'b']);
  // Another window loads while the daemon is down, then saves its view.
  up = false;
  const partial = await s.loadWorktreeState('p', 'w');
  expect(partial.history).toEqual({
    status: 'unavailable',
    reason: 'background_service',
  });
  expect(partial.terminals).toEqual([]);
  s.saveWorktreeState({ ...partial, projectId: 'p', worktreeId: 'w' });
  await settle();
  up = true;
  await s.drainAll();
  const after = await store().loadWorktreeState('p', 'w');
  expect(after.terminals.map((t) => t.session.id)).toEqual(['a', 'b']);
  // A close forgets through its forgetTerminalIds.
  const again = await s.loadWorktreeState('p', 'w');
  s.saveWorktreeState({
    ...again,
    projectId: 'p',
    worktreeId: 'w',
    groups: again.groups.map((g) => ({
      ...g,
      terminalIds: ['b'],
      focusedTerminalId: 'b',
      splitSizes: [1],
    })),
    forgetTerminalIds: ['a'],
  });
  await s.drainAll();
  expect(
    (await store().loadWorktreeState('p', 'w')).terminals.map(
      (t) => t.session.id,
    ),
  ).toEqual(['b']);
});

type SaveRequest = Parameters<TerminalPersistenceStore['saveWorktreeState']>[0];
const recordedIds = async (): Promise<string[]> =>
  (await store().loadWorktreeState('p', 'w')).terminals.map(
    (t) => t.session.id,
  );
const keepOnly = (
  view: Awaited<ReturnType<TerminalPersistenceStore['loadWorktreeState']>>,
  terminalId: string,
): SaveRequest => ({
  ...view,
  projectId: 'p',
  worktreeId: 'w',
  groups: view.groups.map((g) => ({
    ...g,
    terminalIds: [terminalId],
    focusedTerminalId: terminalId,
    splitSizes: [1],
  })),
});
const withoutToken = (request: SaveRequest): SaveRequest => {
  const copy = { ...request };
  delete copy.viewToken;
  return copy;
};

it('a layout save that drops a terminal keeps its history, ungrouped; its forgetTerminalIds removes it', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  const s = store();
  const loaded = await s.loadWorktreeState('p', 'w');
  s.saveWorktreeState(keepOnly(loaded, 'b'));
  await settle();
  // An older client's close: the drawer no longer shows it (CAN-6616).
  for (const kept of [
    await s.loadWorktreeState('p', 'w'),
    await store().loadWorktreeState('p', 'w'),
  ]) {
    expect(
      kept.terminals.map((t) => [t.session.id, t.scrollbackLines]),
    ).toEqual(
      fixture().terminals.map((t) => [t.session.id, t.scrollbackLines]),
    );
    expect(kept.groups.flatMap((g) => g.terminalIds)).toEqual(['b']);
    expect(kept.terminalCustomNames).toMatchObject({ a: 'API' });
  }
  s.saveWorktreeState({ ...keepOnly(loaded, 'b'), forgetTerminalIds: ['a'] });
  await settle();
  const forgotten = await store().loadWorktreeState('p', 'w');
  expect(forgotten.terminals.map((t) => t.session.id)).toEqual(['b']);
  expect(forgotten.terminalCustomNames).not.toHaveProperty('a');
});

it.each(['token', 'tokenless'] as const)(
  'a partial view save that drops an unnamed terminal ungroups it too (%s)',
  async (client) => {
    fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
    fs.writeFileSync(
      legacyPath(),
      JSON.stringify({ ...fixture(), terminalCustomNames: { b: 'Build' } }),
    );
    const s = store();
    await s.loadWorktreeState('p', 'w');
    // A partial view shows only live terminals.
    s.registerLiveSession(session('a'));
    s.registerLiveSession(session('b'));
    await s.drainAll();
    up = false;
    const partial = await s.loadWorktreeState('p', 'w');
    expect(partial.history).toMatchObject({ status: 'unavailable' });
    const save = keepOnly(partial, 'b');
    // An older client's close, from a drawer the authority could not serve.
    s.saveWorktreeState(client === 'token' ? save : withoutToken(save));
    s.saveWorktreeState(client === 'token' ? save : withoutToken(save));
    up = true;
    await settle();
    const kept = await store().loadWorktreeState('p', 'w');
    expect(kept.terminals.map((t) => t.session.id)).toEqual(['a', 'b']);
    expect(kept.groups.flatMap((g) => g.terminalIds)).toEqual(['b']);
    expect(kept.terminalCustomNames).toEqual({ b: 'Build' });
  },
);

it("one window's full load never lets another window's partial view forget what it was not shown", async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  const s = store();
  await s.loadWorktreeState('p', 'w');
  // Window A loads while the daemon is down; window B then reads the record.
  up = false;
  const partialA = await s.loadWorktreeState('p', 'w');
  expect(partialA.terminals).toEqual([]);
  up = true;
  const fullB = await s.loadWorktreeState('p', 'w');
  expect(fullB.terminals.map((t) => t.session.id)).toEqual(['a', 'b']);
  expect(partialA.viewToken).not.toBe(fullB.viewToken);
  // A saves the view it loaded earlier: it forgets or ungroups nothing it
  // never showed.
  s.saveWorktreeState({ ...partialA, projectId: 'p', worktreeId: 'w' });
  await s.drainAll();
  expect(await recordedIds()).toEqual(['a', 'b']);
  expect(
    (await store().loadWorktreeState('p', 'w')).groups.map(
      (g) => g.terminalIds,
    ),
  ).toEqual([['a', 'b']]);
  // B's close forgets what it names.
  s.saveWorktreeState({ ...keepOnly(fullB, 'b'), forgetTerminalIds: ['a'] });
  await s.drainAll();
  expect(await recordedIds()).toEqual(['b']);
});

it('a save forgets only its forgetTerminalIds, whatever view token it carries', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('c'));
  up = false;
  const partial = await s.loadWorktreeState('p', 'w');
  expect(partial.terminals.map((t) => t.session.id)).toEqual(['c']);
  up = true;
  const full = await s.loadWorktreeState('p', 'w');
  // Omission forgets nothing: an unknown token, no token, or the full view.
  s.saveWorktreeState({ ...keepOnly(full, 'b'), viewToken: 'unknown-view' });
  s.saveWorktreeState(withoutToken(keepOnly(full, 'b')));
  s.saveWorktreeState(keepOnly(full, 'b'));
  await s.drainAll();
  expect(await recordedIds()).toEqual(['a', 'b', 'c']);
  // A close forgets what it names, from any view.
  s.saveWorktreeState({
    ...withoutToken(keepOnly(full, 'b')),
    forgetTerminalIds: ['c'],
  });
  await s.drainAll();
  expect(await recordedIds()).toEqual(['a', 'b']);
  s.saveWorktreeState({
    ...keepOnly(full, 'b'),
    viewToken: 'unknown-view',
    forgetTerminalIds: ['a'],
  });
  await s.drainAll();
  expect(await recordedIds()).toEqual(['b']);
  // Registered since and never shown: kept until a close names it.
  s.registerLiveSession(session('d'));
  s.saveWorktreeState(keepOnly(full, 'b'));
  await s.drainAll();
  expect(await recordedIds()).toEqual(['b', 'd']);
  s.saveWorktreeState({ ...keepOnly(full, 'b'), forgetTerminalIds: ['d'] });
  await s.drainAll();
  expect(await recordedIds()).toEqual(['b']);
});

it('a terminal registered after a load is never forgotten by a drawer that was not shown it', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  const s = store();
  // Window A loads, then a script starts that A has not received yet.
  const stale = await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('script'));
  s.appendTerminalOutput('p', 'w', 'script', Buffer.from('built'));
  s.saveWorktreeState({ ...stale, projectId: 'p', worktreeId: 'w' });
  await s.drainAll();
  // It stays shown and recorded: the stale save never hid the live script.
  const shown = await s.loadWorktreeState('p', 'w');
  expect(shown.liveTerminalIds).toEqual(['script']);
  expect(await recordedIds()).toEqual(['a', 'b', 'script']);
  // Window B's load serves it; A's stale view still cannot forget it.
  s.saveWorktreeState({ ...stale, projectId: 'p', worktreeId: 'w' });
  s.markTerminalExited('p', 'w', 'script', 0, null);
  await s.drainAll();
  expect(await recordedIds()).toEqual(['a', 'b', 'script']);
  // B closes it: the close forgets it.
  s.saveWorktreeState({
    ...shown,
    projectId: 'p',
    worktreeId: 'w',
    groups: shown.groups.filter((g) => !g.terminalIds.includes('script')),
    forgetTerminalIds: ['script'],
  });
  await s.drainAll();
  expect(await recordedIds()).toEqual(['a', 'b']);
});

it('a save never clears a name its view was not shown; one it was shown or set, it may (R6-F2)', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  const s = store();
  const full = await s.loadWorktreeState('p', 'w');
  expect(full.terminalCustomNames).toEqual({ a: 'API', b: 'Build' });
  // A partial load serves a live session with no record metadata; the
  // other session is omitted. Neither case proves the names were cleared.
  s.registerLiveSession(session('a'));
  await s.drainAll();
  up = false;
  const partial = await s.loadWorktreeState('p', 'w');
  expect(partial.terminals.map((t) => t.session.id)).toEqual(['a']);
  expect(partial.terminalCustomNames).toEqual({});
  const unnamed: SaveRequest = {
    ...full,
    projectId: 'p',
    worktreeId: 'w',
    terminalCustomNames: {},
    viewToken: partial.viewToken,
  };
  s.saveWorktreeState(unnamed);
  await settle();
  up = true;
  await s.drainAll();
  expect(
    (await store().loadWorktreeState('p', 'w')).terminalCustomNames,
  ).toEqual({ a: 'API', b: 'Build' });
  // Older clients do not echo a view token, even for this partial load.
  s.saveWorktreeState({ ...unnamed, viewToken: undefined });
  await s.drainAll();
  expect(
    (await store().loadWorktreeState('p', 'w')).terminalCustomNames,
  ).toEqual({ a: 'API', b: 'Build' });
  // The same view renames one, then clears the name it set.
  s.saveWorktreeState({ ...unnamed, terminalCustomNames: { a: 'Server' } });
  await s.drainAll();
  expect(
    (await store().loadWorktreeState('p', 'w')).terminalCustomNames,
  ).toEqual({ a: 'Server', b: 'Build' });
  s.saveWorktreeState(unnamed);
  await s.drainAll();
  expect(
    (await store().loadWorktreeState('p', 'w')).terminalCustomNames,
  ).toEqual({ b: 'Build' });
  // A view that was shown a name clears it.
  const shown = await s.loadWorktreeState('p', 'w');
  s.saveWorktreeState({
    ...shown,
    projectId: 'p',
    worktreeId: 'w',
    terminalCustomNames: {},
  });
  await s.drainAll();
  expect(
    (await store().loadWorktreeState('p', 'w')).terminalCustomNames,
  ).toEqual({});
});

it('only drawer terminals reach the outbox while the daemon is down, or its seal at quit (R6-F1)', async () => {
  up = false;
  const s = store();
  const agent = { ...session('agent'), kind: 'claude-code' as const };
  const worker = { ...session('worker'), kind: 'claude-worker' as const };
  for (const nonDrawer of [agent, worker]) {
    // The engine reports every terminal; only drawer kinds register.
    s.registerLiveSession(nonDrawer);
    s.appendTerminalOutput('p', 'w', nonDrawer.id, Buffer.from('agent out'));
  }
  s.registerLiveSession(session('shell'));
  // Output immediately after registration, before any record load or flush.
  s.appendTerminalOutput('p', 'w', 'shell', Buffer.from('shell out'));
  s.registerLiveSession({ ...session('script'), kind: 'script' });
  s.appendTerminalOutput('p', 'w', 'script', Buffer.from('script out'));
  s.markTerminalExited('p', 'w', 'agent', 0, null);
  await settle();
  const mentions = (id: string): boolean =>
    readOutbox().scopes.some((scope) =>
      scope.entries.some((entry) =>
        entry.ops.some((op) => JSON.stringify(op).includes(`"${id}"`)),
      ),
    );
  expect(mentions('shell')).toBe(true);
  expect(mentions('script')).toBe(true);
  expect(mentions('agent')).toBe(false);
  expect(mentions('worker')).toBe(false);
  // Quit seals what is queued and stamps every live terminal's exit.
  s.appendTerminalOutput('p', 'w', 'worker', Buffer.from('late'));
  s.markTerminalExited('p', 'w', 'worker', null, 'app-quit');
  s.markAllLiveTerminalsExited('app-quit');
  expect(mentions('shell')).toBe(true);
  expect(mentions('agent')).toBe(false);
  expect(mentions('worker')).toBe(false);
  up = true;
  const next = store();
  next.start();
  const loaded = await next.loadWorktreeState('p', 'w');
  expect(
    loaded.terminals.map((t) => [t.session.id, t.scrollbackLines]),
  ).toEqual([
    ['shell', ['shell out']],
    ['script', ['script out']],
  ]);
});

it('history retries never evict the view of a drawer that loaded once', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  const s = store();
  const loaded = await s.loadWorktreeState('p', 'w');
  // Another drawer retries its load through a long outage.
  up = false;
  for (let attempt = 0; attempt < 80; attempt += 1)
    await s.loadWorktreeState('p', 'w');
  up = true;
  // Its whole view still saves its layout.
  s.saveWorktreeState({
    ...loaded,
    projectId: 'p',
    worktreeId: 'w',
    groups: loaded.groups.map((g) => ({ ...g, splitSizes: [0.4, 0.6] })),
  });
  await settle();
  expect(
    (await store().loadWorktreeState('p', 'w')).groups.map((g) => g.splitSizes),
  ).toEqual([[0.4, 0.6]]);
});

it.each([
  'normal',
  'restart after partial deletion',
  'retry after partial deletion',
  'restart after directory flush failure',
  'retry after directory flush failure',
])("runs' own outboxes replay in run order, including %s", async (cleanup) => {
  const client = seedReplayWitness('newer');
  const oldClient = seedReplayWitness('older');
  const upsert = (
    id: string,
  ): { op: 'session.upsert'; session: ReturnType<typeof session> } => ({
    op: 'session.upsert',
    session: session(id),
  });
  // The newer run's file sorts first: it retired the worktree, then a new
  // lifetime queued 'new'. The older run queued 'old' before that cleanup.
  fs.writeFileSync(
    join(mockRoot, 'terminal-record-outbox.run-00000000.json'),
    JSON.stringify({
      version: 1,
      producer: 'electron_main',
      runStartedAt: 2_000,
      scopes: [
        { client, entries: [{ seq: 1, runId: 'newer', ops: [upsert('new')] }] },
      ],
      retirements: [
        {
          projectId: 'p',
          worktreeId: 'w',
          requestedAt: 2_500,
          lifetimeIds: ['older'],
        },
      ],
    }),
  );
  fs.writeFileSync(
    join(mockRoot, 'terminal-record-outbox.run-ffffffff.json'),
    JSON.stringify({
      version: 1,
      producer: 'electron_main',
      runStartedAt: 1_000,
      scopes: [
        {
          client: oldClient,
          entries: [{ seq: 1, runId: 'older', ops: [upsert('old')] }],
        },
      ],
      retirements: [],
    }),
  );
  let failing = cleanup !== 'normal';
  class PartialDiscard extends TerminalRecordOutbox {
    public override async discard(paths: readonly string[]): Promise<void> {
      if (!failing) return super.discard(paths);
      if (cleanup.includes('directory flush')) {
        const flush = jest
          .spyOn(atomicFile, 'syncDirectory')
          .mockRejectedValue(new Error('directory flush failed'));
        try {
          await super.discard(paths);
        } finally {
          flush.mockRestore();
        }
        return;
      }
      await super.discard(paths.slice(-1));
      throw new Error('second source deletion failed');
    }
  }
  const next = newStore({
    records,
    outbox: new PartialDiscard(() => mockRoot),
  });
  await next.drainAll();
  expect(await recordedIds()).toEqual(['new']);
  if (cleanup !== 'normal') {
    expect(next.isOutboxWarningShown()).toBe(true);
    const merged = await newOutbox().read();
    expect(merged.outbox.merged).toContain(
      'terminal-record-outbox.run-ffffffff.json',
    );
    expect(
      fs.existsSync(join(mockRoot, 'terminal-record-outbox.run-ffffffff.json')),
    ).toBe(!cleanup.includes('directory flush'));
    failing = false;
    if (cleanup.startsWith('restart')) {
      next.markAllLiveTerminalsExited('app-quit');
      await store().drainAll();
    } else await next.drainAll();
    expect(await recordedIds()).toEqual(['new']);
  }
  expect(fs.existsSync(join(mockRoot, 'terminal-record-outbox.json'))).toBe(
    false,
  );
  expect(
    fs.existsSync(join(mockRoot, 'terminal-record-outbox.run-ffffffff.json')),
  ).toBe(false);
});

it("a run's own outbox the shared file already holds is never merged again", async () => {
  // An earlier run quit before it merged the shared file: it retired the
  // worktree into its own file.
  const runFile = join(mockRoot, 'terminal-record-outbox.run-older.json');
  fs.writeFileSync(
    runFile,
    JSON.stringify({
      version: 1,
      producer: 'electron_main',
      runStartedAt: 1_000,
      scopes: [],
      retirements: [{ projectId: 'p', worktreeId: 'w', requestedAt: 1_500 }],
    }),
  );
  // The next run merges it, queues a new lifetime's write while the daemon
  // is down, and ends before it could discard the merged file.
  class Undiscarded extends TerminalRecordOutbox {
    public override discard(): Promise<void> {
      return Promise.reject(new Error('crashed before the discard'));
    }
  }
  up = false;
  const s = newStore({
    records,
    outbox: new Undiscarded(() => mockRoot),
  });
  s.start();
  await s.drainAll();
  s.registerLiveSession(session('new'));
  await settle();
  s.markAllLiveTerminalsExited('app-quit');
  expect(fs.existsSync(runFile)).toBe(true);
  // The launch after replays the retirement once, before the newer write.
  up = true;
  const next = store();
  next.start();
  await next.drainAll();
  expect(await recordedIds()).toEqual(['new']);
  expect(fs.existsSync(runFile)).toBe(false);
});

it('writes from a second outage after a drain are durable, and drain on the next launch', async () => {
  const outbox = newOutbox();
  const write = outbox.write.bind(outbox);
  let firstWritten = (): void => undefined;
  let secondWritten = (): void => undefined;
  const firstPublication = new Promise<void>((resolve) => {
    firstWritten = resolve;
  });
  const secondPublication = new Promise<void>((resolve) => {
    secondWritten = resolve;
  });
  jest.spyOn(outbox, 'write').mockImplementation(async (...args) => {
    await write(...args);
    for (const scope of args[0].scopes)
      for (const entry of scope.entries)
        for (const op of entry.ops) {
          if (op.op !== 'output.append') continue;
          if (op.text.includes('first outage')) firstWritten();
          if (op.text.includes('second outage')) secondWritten();
        }
  });
  const s = newStore({ records, outbox });
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('o'));
  up = false;
  s.appendTerminalOutput('p', 'w', 'o', Buffer.from('first outage\n'));
  await firstPublication;
  up = true;
  // The drain applies the worktree's last entry and drops its outbox.
  await s.drainAll();
  expect(fs.existsSync(join(mockRoot, 'terminal-record-outbox.json'))).toBe(
    false,
  );
  up = false;
  s.appendTerminalOutput('p', 'w', 'o', Buffer.from('second outage'));
  await secondPublication;
  expect(readOutbox().scopes.flatMap((scope) => scope.entries)).not.toEqual([]);
  s.markAllLiveTerminalsExited('app-quit');
  up = true;
  const next = store();
  next.start();
  const loaded = await next.loadWorktreeState('p', 'w');
  expect(loaded.terminals.find((t) => t.session.id === 'o')).toMatchObject({
    scrollbackLines: ['first outage', 'second outage'],
    signal: 'app-quit',
  });
});

it('a deferred retirement never retires the newer record of a reused worktree id', async () => {
  let incarnation = 'inc-1';
  const s = newStore({
    records,
    outbox: newOutbox(),
    incarnation: (): Promise<string> => Promise.resolve(incarnation),
  });
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('old'));
  await settle();
  // Cleanup while the daemon is down: the retirement waits.
  up = false;
  void s.retireTerminalRecord({ projectId: 'p', worktreeId: 'w' });
  await settle();
  // The id is reused, and a daemon terminal of the new worktree starts
  // before the retirement reaches the authority.
  incarnation = 'inc-2';
  up = true;
  const registration = authority.attribute({
    terminalId: 'new',
    client: {
      projectId: 'p',
      worktreeId: 'w',
      legacyLayout: 'workspaces',
      incarnation: 'inc-2',
    },
    session: session('new'),
    persist: true,
  });
  authority.output(registration, Buffer.from('newer'));
  await s.drainAll();
  const loaded = await newStore({
    records,
    outbox: newOutbox(),
    incarnation: (): Promise<string> => Promise.resolve('inc-2'),
  }).loadWorktreeState('p', 'w');
  expect(
    loaded.terminals.map((t) => [t.session.id, t.scrollbackLines]),
  ).toEqual([['new', ['newer']]]);
});

it('a daemon terminal waits for a queued retirement of its worktree before it attributes', async () => {
  const s = store();
  s.registerLiveSession(session('old'));
  await settle();
  up = false;
  void s.retireTerminalRecord({ projectId: 'p', worktreeId: 'w' });
  await settle();
  up = true;
  // No incarnation is known: only the order keeps the new terminal.
  const client = await s.recordClientFor('p', 'w');
  authority.attribute({
    terminalId: 'new',
    client,
    session: session('new'),
    persist: true,
  });
  await s.drainAll();
  const loaded = await store().loadWorktreeState('p', 'w');
  expect(loaded.terminals.map((t) => t.session.id)).toEqual(['new']);
});

it('a retirement the authority rejects never holds the worktree behind it', async () => {
  // An earlier run queued one the schema rejects, ahead of a write.
  fs.writeFileSync(
    join(mockRoot, 'terminal-record-outbox.json'),
    JSON.stringify({
      version: 1,
      producer: 'electron_main',
      scopes: [
        {
          client: seedReplayWitness('rejected-retirement'),
          entries: [
            {
              seq: 1,
              runId: 'earlier',
              ops: [{ op: 'session.upsert', session: session('kept') }],
            },
          ],
        },
      ],
      retirements: [{ projectId: 'p', worktreeId: 'w', incarnation: '' }],
    }),
  );
  const s = store();
  s.start();
  await s.drainAll();
  expect(fs.existsSync(join(mockRoot, 'terminal-record-outbox.json'))).toBe(
    false,
  );
  // Applied to the record itself, not only shown from the outbox.
  const opened = authority.open({
    projectId: 'p',
    worktreeId: 'w',
    legacyLayout: 'workspaces',
    incarnation: null,
  });
  expect(opened.terminals.map((t) => t.session.id)).toEqual(['kept']);
});

it('a reused worktree id that writes right after its retirement keeps its own record', async () => {
  let incarnation = 'inc-1';
  const make = (): TerminalPersistenceStore =>
    newStore({
      records,
      outbox: newOutbox(),
      incarnation: (): Promise<string> => Promise.resolve(incarnation),
    });
  const s = make();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('old'));
  await settle();
  up = false;
  s.appendTerminalOutput('p', 'w', 'old', Buffer.from('queued'));
  await settle();
  // Cleanup, then the id is reused at once, and the app quits.
  void s.retireTerminalRecord({ projectId: 'p', worktreeId: 'w' });
  incarnation = 'inc-2';
  s.registerLiveSession(session('new'));
  s.markAllLiveTerminalsExited('app-quit');
  up = true;
  const next = make();
  next.start();
  const loaded = await next.loadWorktreeState('p', 'w');
  expect(loaded.terminals.map((t) => t.session.id)).toEqual(['new']);
});

describe('a retired lifetime never writes into the next one', () => {
  const recordPath = (): string =>
    join(terminalRecordDir(mockRoot, 'p', 'w'), 'record.json');
  const clientOf = (
    incarnation: string | null,
  ): WorkerTerminalRecordClient => ({
    projectId: 'p',
    worktreeId: 'w',
    legacyLayout: 'workspaces' as const,
    incarnation,
  });
  const withIncarnation = (
    incarnation: (projectId: string, worktreeId: string) => Promise<string>,
    port: TerminalRecordClientPort = records,
  ): TerminalPersistenceStore =>
    newStore({
      records: port,
      outbox: newOutbox(),
      incarnation,
    });

  it('a flush detached while the availability check waits sends nothing (R4-F2)', async () => {
    let hold: ((up: boolean) => void) | undefined;
    let held: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      held = resolve;
    });
    const sent: string[] = [];
    const port: TerminalRecordClientPort = {
      ...records,
      available: () => {
        if (hold || sent.includes('held')) return records.available();
        sent.push('held');
        held();
        return new Promise((resolve) => {
          hold = resolve;
        });
      },
      apply: (params) => {
        sent.push('apply');
        return records.apply(params);
      },
      retire: (params) => {
        sent.push('retire');
        return records.retire(params);
      },
    };
    const s = newStore({
      records: port,
      outbox: newOutbox(),
    });
    s.registerLiveSession(session('old'));
    s.appendTerminalOutput('p', 'w', 'old', Buffer.from('late'));
    await waiting;
    void s.retireTerminalRecord({ projectId: 'p', worktreeId: 'w' });
    await s.drainAll();
    expect(sent).toEqual(['held', 'retire']);
    hold?.(true);
    await settle();
    expect(sent).toEqual(['held', 'retire']);
    expect(fs.existsSync(recordPath())).toBe(false);
  });

  it('a dropped answer is never adopted: the newer record keeps only its own writes', async () => {
    const s = withIncarnation(() => Promise.resolve('inc-1'));
    await s.loadWorktreeState('p', 'w');
    s.registerLiveSession(session('a'));
    await settle();
    // The CLI removes and recreates the worktree meanwhile.
    authority.retire({ projectId: 'p', worktreeId: 'w' });
    authority.apply({
      client: clientOf('inc-2'),
      producer: { id: 'cli', runId: 'c1' },
      seq: 1,
      ops: [{ op: 'session.upsert', session: session('new') }],
    });
    s.appendTerminalOutput('p', 'w', 'a', Buffer.from('first'));
    await settle();
    // Its next batch still carries generation 1, so it never lands in the
    // newer record.
    s.registerLiveSession(session('b'));
    await settle();
    const opened = authority.open(clientOf('inc-2'));
    expect(opened.generation).toBe(2);
    expect(opened.terminals.map((t) => t.session.id)).toEqual(['new']);
  });

  it('an incarnation looked up for a retired lifetime never seeds the next one', async () => {
    const lookups: ((incarnation: string) => void)[] = [];
    const s = withIncarnation(
      () =>
        new Promise<string>((resolve) => {
          lookups.push(resolve);
        }),
    );
    s.registerLiveSession(session('old'));
    await settle();
    expect(lookups).toHaveLength(1);
    void s.retireTerminalRecord({ projectId: 'p', worktreeId: 'w' });
    await settle();
    // The old lifetime's lookup settles after its retirement.
    lookups[0]('inc-1');
    await settle();
    s.registerLiveSession(session('new'));
    await settle(150);
    for (const resolve of lookups.slice(1)) resolve('inc-2');
    await settle();
    await s.drainAll();
    const value: unknown = JSON.parse(fs.readFileSync(recordPath(), 'utf8'));
    expect(value).toMatchObject({ incarnation: 'inc-2' });
    expect(
      authority.open(clientOf('inc-2')).terminals.map((t) => t.session.id),
    ).toEqual(['new']);
  });

  it("an earlier run's queued writes of another incarnation are dropped, not sent", async () => {
    authority.apply({
      client: clientOf('inc-2'),
      producer: { id: 'electron_main', runId: 'now' },
      seq: 1,
      ops: [{ op: 'session.upsert', session: session('new') }],
    });
    fs.writeFileSync(
      join(mockRoot, 'terminal-record-outbox.json'),
      JSON.stringify({
        version: 1,
        producer: 'electron_main',
        scopes: [
          {
            client: clientOf('inc-1'),
            entries: [
              {
                seq: 1,
                runId: 'earlier',
                ops: [{ op: 'session.upsert', session: session('stale') }],
              },
            ],
          },
        ],
        retirements: [],
      }),
    );
    const s = withIncarnation(() => Promise.resolve('inc-2'));
    s.start();
    await s.drainAll();
    await settle();
    expect(fs.existsSync(join(mockRoot, 'terminal-record-outbox.json'))).toBe(
      false,
    );
    const opened = authority.open(clientOf('inc-2'));
    expect(opened.generation).toBe(1);
    expect(opened.terminals.map((t) => t.session.id)).toEqual(['new']);
  });

  it('a late save of a retired worktree creates no record; a load starts the next lifetime', async () => {
    const s = store();
    const loaded = await s.loadWorktreeState('p', 'w');
    s.registerLiveSession(session('a'));
    await settle();
    void s.retireTerminalRecord({ projectId: 'p', worktreeId: 'w' });
    await s.drainAll();
    const calls = applyCalls;
    s.saveWorktreeState({ ...loaded, projectId: 'p', worktreeId: 'w' });
    await settle();
    await s.drainAll();
    expect(applyCalls).toBe(calls);
    expect(fs.existsSync(recordPath())).toBe(false);
    const reloaded = await s.loadWorktreeState('p', 'w');
    s.registerLiveSession(session('next-lifetime'));
    s.saveWorktreeState({ ...reloaded, projectId: 'p', worktreeId: 'w' });
    await settle();
    await s.drainAll();
    expect(applyCalls).toBeGreaterThan(calls);
    expect(
      (await s.loadWorktreeState('p', 'w')).terminals.map(
        (entry) => entry.session.id,
      ),
    ).toEqual(['next-lifetime']);
  });

  it('a load detached by a retirement while it waits opens nothing', async () => {
    const first = store();
    await first.loadWorktreeState('p', 'w');
    first.registerLiveSession(session('a'));
    await settle();
    await first.drainAll();
    let release: () => void = () => undefined;
    let held = false;
    const s = withIncarnation(() => Promise.resolve('inc-1'), {
      ...records,
      available: () => {
        if (held) return records.available();
        held = true;
        return new Promise((resolve) => {
          release = (): void => resolve(true);
        });
      },
    });
    const loading = s.loadWorktreeState('p', 'w');
    await settle(20);
    void s.retireTerminalRecord({ projectId: 'p', worktreeId: 'w' });
    await s.drainAll();
    expect(fs.existsSync(recordPath())).toBe(false);
    release();
    await loading;
    await settle();
    expect(fs.existsSync(recordPath())).toBe(false);
  });

  it('a load behind a queued retirement waits for it and keeps its own writes', async () => {
    const s = store();
    await s.loadWorktreeState('p', 'w');
    s.registerLiveSession(session('old'));
    await settle();
    await s.drainAll();
    up = false;
    void s.retireTerminalRecord({ projectId: 'p', worktreeId: 'w' });
    await settle(50);
    up = true;
    const loaded = await s.loadWorktreeState('p', 'w');
    expect(loaded.terminals.map((t) => t.session.id)).toEqual([]);
    s.registerLiveSession(session('new'));
    await settle();
    await s.drainAll();
    expect(
      authority.open(clientOf(null)).terminals.map((t) => t.session.id),
    ).toEqual(['new']);
  });

  /** A port whose `kind` call reaches the authority only once delivered. */
  const inTransit = (
    kind: 'apply' | 'open',
    delivered: string[],
  ): {
    port: TerminalRecordClientPort;
    sending: Promise<void>;
    deliver: () => void;
  } => {
    let reached: () => void = () => undefined;
    const sending = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let deliver: () => void = () => undefined;
    const hold = <T>(send: () => Promise<T>): Promise<T> => {
      reached();
      return new Promise<T>((resolve, reject) => {
        deliver = (): void => {
          delivered.push(kind);
          send().then(resolve, reject);
        };
      });
    };
    const port: TerminalRecordClientPort = {
      ...records,
      ...(kind === 'apply'
        ? { apply: (params) => hold(() => records.apply(params)) }
        : { open: (client) => hold(() => records.open(client)) }),
      retire: (params) => {
        delivered.push('retire');
        return records.retire(params);
      },
    };
    return { port, sending, deliver: () => deliver() };
  };

  it("a retirement waits for the retired lifetime's apply still in flight", async () => {
    // The lifetime's record exists; this run never opened it, so its first
    // batch carries no generation.
    authority.apply({
      client: clientOf(null),
      producer: { id: 'cli', runId: 'c0' },
      seq: 1,
      ops: [{ op: 'session.upsert', session: session('old') }],
    });
    const delivered: string[] = [];
    const { port, sending, deliver } = inTransit('apply', delivered);
    const s = newStore({
      records: port,
      outbox: newOutbox(),
    });
    s.registerLiveSession(session('late'));
    await sending;
    void s.retireTerminalRecord({ projectId: 'p', worktreeId: 'w' });
    const draining = s.drainAll();
    await settle(50);
    deliver();
    await draining;
    await settle();
    expect(delivered).toEqual(['apply', 'retire']);
    expect(fs.existsSync(recordPath())).toBe(false);
  });

  it("a retirement waits for the retired lifetime's open still in flight", async () => {
    authority.apply({
      client: clientOf(null),
      producer: { id: 'cli', runId: 'c0' },
      seq: 1,
      ops: [{ op: 'session.upsert', session: session('old') }],
    });
    // An open names no lifetime: only a cutoff strictly after startedAt retires it.
    const { startedAt } = z
      .object({ startedAt: z.number() })
      .parse(JSON.parse(fs.readFileSync(recordPath(), 'utf8')));
    while (Date.now() <= startedAt) await settle(1);
    const delivered: string[] = [];
    const { port, sending, deliver } = inTransit('open', delivered);
    const s = newStore({
      records: port,
      outbox: newOutbox(),
    });
    const loading = s.loadWorktreeState('p', 'w');
    await sending;
    void s.retireTerminalRecord({ projectId: 'p', worktreeId: 'w' });
    const draining = s.drainAll();
    await settle(50);
    deliver();
    await draining;
    await loading;
    await settle();
    expect(delivered).toEqual(['open', 'retire']);
    expect(fs.existsSync(recordPath())).toBe(false);
  });

  it('a send that never settles holds a retirement and other worktrees only until its wait is bounded', async () => {
    authority.apply({
      client: clientOf(null),
      producer: { id: 'cli', runId: 'c0' },
      seq: 1,
      ops: [{ op: 'session.upsert', session: session('old') }],
    });
    const delivered: string[] = [];
    let reached: () => void = () => undefined;
    const sending = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const port: TerminalRecordClientPort = {
      ...records,
      apply: (params) => {
        if (params.client.worktreeId !== 'w') return records.apply(params);
        reached();
        return new Promise(() => undefined);
      },
      retire: (params) => {
        delivered.push('retire');
        return records.retire(params);
      },
    };
    const s = newStore({
      records: port,
      outbox: newOutbox(),
      retirementBarrierBoundMs: 100,
    });
    s.registerLiveSession(session('late'));
    await sending;
    void s.retireTerminalRecord({ projectId: 'p', worktreeId: 'w' });
    // Another worktree's writes queue behind the retirement meanwhile.
    up = false;
    s.registerLiveSession(session('other', 'w2'));
    await settle();
    up = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      s.drainAll().then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 3_000);
      }),
    ]);
    clearTimeout(timer);
    expect(drained).toBe(true);
    expect(delivered).toEqual(['retire']);
    expect(fs.existsSync(recordPath())).toBe(false);
    expect(
      authority
        .open({ ...clientOf(null), worktreeId: 'w2' })
        .terminals.map((t) => t.session.id),
    ).toEqual(['other']);
  });

  const writeEarlierOutbox = (incarnation: string, terminalId: string): void =>
    fs.writeFileSync(
      join(mockRoot, 'terminal-record-outbox.json'),
      JSON.stringify({
        version: 1,
        producer: 'electron_main',
        scopes: [
          {
            client: clientOf(incarnation),
            entries: [
              {
                seq: 1,
                runId: 'earlier',
                ops: [{ op: 'session.upsert', session: session(terminalId) }],
              },
            ],
          },
        ],
        retirements: [],
      }),
    );

  it("an earlier run's writes of a known incarnation never go out under this run's unknown one", async () => {
    // The worktree id was reused: the record is the newer worktree's.
    authority.apply({
      client: clientOf('inc-2'),
      producer: { id: 'cli', runId: 'c1' },
      seq: 1,
      ops: [{ op: 'session.upsert', session: session('cur') }],
    });
    writeEarlierOutbox('inc-1', 'stale');
    // This run's first lookup fails, and it queues before the earlier
    // outbox is merged.
    let lookups = 0;
    const s = withIncarnation(() => {
      lookups += 1;
      return lookups === 1
        ? Promise.reject(new Error('busy'))
        : Promise.resolve('inc-2');
    });
    up = false;
    s.registerLiveSession(session('new'));
    await settle();
    up = true;
    await s.drainAll();
    await settle();
    expect(
      authority.open(clientOf('inc-2')).terminals.map((t) => t.session.id),
    ).toEqual(['cur', 'new']);
  });

  it.each(['initial', 'retry'] as const)(
    'an unresolved %s incarnation lookup cannot wedge later drains',
    async (phase) => {
      authority.apply({
        client: clientOf('inc-2'),
        producer: { id: 'cli', runId: 'successor' },
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session('cur') },
          { op: 'output.append', terminalId: 'cur', text: 'successor history' },
        ],
      });
      writeEarlierOutbox('inc-1', 'earlier');
      let stuck = phase === 'initial';
      const s = newStore({
        records,
        outbox: newOutbox(),
        incarnation: () =>
          stuck ? new Promise<string>(() => undefined) : Promise.resolve(null),
        incarnationLookupBoundMs: 10,
      });
      if (phase === 'retry') {
        expect((await s.recordClientFor('p', 'w')).incarnation).toBeNull();
        stuck = true;
      }
      s.registerLiveSession(session('new'));
      await s.drainAll();
      expect(
        authority.open(clientOf(null)).terminals.map((t) => t.session.id),
      ).toEqual(['cur', 'new']);
      expect(JSON.stringify((await newOutbox().read()).outbox)).toContain(
        'earlier',
      );
      s.appendTerminalOutput('p', 'w', 'new', Buffer.from('still recording'));
      await s.drainAll();
      const loaded = await s.loadWorktreeState('p', 'w');
      expect(
        loaded.terminals.find((t) => t.session.id === 'new')?.scrollbackLines,
      ).toEqual(['still recording']);
      s.markAllLiveTerminalsExited('app-quit');
      const restarted = newStore({
        records,
        outbox: newOutbox(),
        incarnation: () => Promise.reject(new Error('still inconclusive')),
      });
      await restarted.drainAll();
      expect(
        authority.historyRead({ client: clientOf('inc-2'), terminalId: 'cur' })
          .text,
      ).toBe('successor history');
      expect(JSON.stringify((await newOutbox().read()).outbox)).toContain(
        'earlier',
      );
    },
  );

  it('a timed-out incarnation lookup neither blocks attribution nor adopts its late answer', async () => {
    let finish: (incarnation: string) => void = () => undefined;
    const lookup = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const s = newStore({
      records,
      outbox: newOutbox(),
      incarnation: () => lookup,
      incarnationLookupBoundMs: 10,
    });
    const client = await s.recordClientFor('p', 'w');
    expect(client.incarnation).toBeNull();
    finish('late-incarnation');
    await lookup;
    expect(await s.recordClientFor('p', 'w')).toEqual(client);
  });

  it("a quit before this run looked its incarnation up keeps its writes apart from an earlier worktree's", async () => {
    writeEarlierOutbox('inc-1', 'stale');
    up = false;
    // The worktree id was reused; this run's lookup never settles before
    // the quit.
    let quit = false;
    const sentAfterQuit: string[] = [];
    const s = withIncarnation(() => new Promise<string>(() => undefined), {
      ...records,
      apply: (params) => {
        if (quit) sentAfterQuit.push(params.producer.runId);
        return records.apply(params);
      },
    });
    s.start();
    await settle(50);
    await prepareReplayScope(s);
    s.registerLiveSession(session('new'));
    s.markAllLiveTerminalsExited('app-quit');
    quit = true;
    up = true;
    const next = withIncarnation(() => Promise.resolve('inc-2'));
    next.start();
    const loaded = await next.loadWorktreeState('p', 'w');
    // The first run's lookup must settle without replaying its sealed outbox.
    await s.drainAll();
    // The outbox seal closes only outbox mutation; the store closes sends.
    expect(sentAfterQuit).toEqual([]);
    expect(loaded.terminals.map((t) => [t.session.id, t.signal])).toEqual([
      ['new', 'app-quit'],
    ]);
    expect(
      authority.open(clientOf('inc-2')).terminals.map((t) => t.session.id),
    ).toEqual(['new']);
  });

  it('history pages read the generation the open served', async () => {
    const s = store();
    await s.loadWorktreeState('p', 'w');
    s.registerLiveSession(session('h'));
    s.appendTerminalOutput('p', 'w', 'h', Buffer.from('paged'));
    await settle();
    const generations: (number | undefined)[] = [];
    const port: TerminalRecordClientPort = {
      ...records,
      historyRead: (params) => {
        generations.push(params.client.generation);
        return records.historyRead(params);
      },
    };
    const loaded = await newStore({
      records: port,
      outbox: newOutbox(),
    }).loadWorktreeState('p', 'w');
    expect(
      loaded.terminals.find((t) => t.session.id === 'h')?.scrollbackLines,
    ).toEqual(['paged']);
    expect(generations).toEqual([1]);
  });
});

it('reconnect keeps a compacted tail schema-valid across an oversized continuation', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  up = false;
  s.registerLiveSession(session('long'));
  s.appendTerminalOutput('p', 'w', 'long', Buffer.from('line\n'.repeat(5001)));
  for (let i = 0; i < 17; i += 1)
    s.appendTerminalOutput('p', 'w', 'long', Buffer.alloc(65536, 'x'));
  await settle();
  up = true;
  await s.drainAll();
  const loaded = await store().loadWorktreeState('p', 'w');
  const lines = loaded.terminals.find(
    (t) => t.session.id === 'long',
  )?.scrollbackLines;
  expect(lines).toHaveLength(5000);
  expect(lines?.[0]).toBe('line');
  expect(lines?.at(-1)).toBe('x'.repeat(1024 * 1024));
});

it('wire chunking preserves a code point at the per-line retention boundary', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('unicode'));
  const text = `${'x'.repeat(1024 * 1024 - 1)}🙂tail`;
  s.appendTerminalOutput('p', 'w', 'unicode', Buffer.from(text));
  await s.drainAll();
  const loaded = await store().loadWorktreeState('p', 'w');
  const lines = loaded.terminals.find(
    (t) => t.session.id === 'unicode',
  )?.scrollbackLines;
  expect(lines).toEqual([`${'x'.repeat(1024 * 1024 - 8)}🙂tail`]);
});

it('a daemon restore drains the previous shell output and exit before host attribution', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('switch'));
  s.appendTerminalOutput('p', 'w', 'switch', Buffer.from('last output'));
  s.markTerminalExited('p', 'w', 'switch', 9, null);
  expect(await s.prepareDaemonRestore('switch')).toBe(true);
  const client = await s.recordClientFor('p', 'w');
  expect(authority.historyRead({ client, terminalId: 'switch' }).text).toBe(
    'last output',
  );
  authority.attribute({
    terminalId: 'switch',
    client,
    session: session('switch'),
    persist: true,
  });
  await s.drainAll();
  expect(
    authority.open(client).terminals.find((t) => t.session.id === 'switch'),
  ).toMatchObject({ signal: null, exitCode: null });
});

it('an undrained restore stays in process with its queued history', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('offline'));
  s.appendTerminalOutput('p', 'w', 'offline', Buffer.from('queued tail'));
  s.markTerminalExited('p', 'w', 'offline', null, null);
  up = false;
  expect(await s.prepareDaemonRestore('offline')).toBe(false);
  const release = await s.prefetchPersistedEntry('offline');
  expect(s.getPersistedTerminalEntry('offline')?.scrollbackLines).toEqual([
    'queued tail',
  ]);
  release();
  up = true;
  await s.drainAll();
});

it('a host switch times out behind an unacknowledged exit without losing its history', async () => {
  let resume: () => void = () => undefined;
  let started: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const applying = new Promise<void>((resolve) => {
    started = resolve;
  });
  const s = newStore({
    records: {
      ...records,
      apply: async (params): ReturnType<TerminalRecordClientPort['apply']> => {
        started();
        await held;
        return records.apply(params);
      },
    },
    outbox: newOutbox(),
  });
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('held-exit'));
  s.appendTerminalOutput('p', 'w', 'held-exit', Buffer.from('final tail'));
  s.markTerminalExited('p', 'w', 'held-exit', 4, null);
  const switching = s.prepareDaemonRestore('held-exit');
  await applying;
  expect(await switching).toBe(false);
  const release = await s.prefetchPersistedEntry('held-exit');
  expect(s.getPersistedTerminalEntry('held-exit')?.scrollbackLines).toEqual([
    'final tail',
  ]);
  release();
  s.registerLiveSession(session('held-exit'));
  resume();
  await s.drainAll();
  const loaded = await store().loadWorktreeState('p', 'w');
  expect(
    loaded.terminals.find((t) => t.session.id === 'held-exit'),
  ).toMatchObject({ exitCode: null, signal: null });
});

it.each(['explicit forget', 'save forget'] as const)(
  '%s invalidates metadata and a history prefetch already in flight',
  async (method) => {
    let holdReads = false;
    let resume: () => void = () => undefined;
    let started: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const s = newStore({
      records: {
        ...records,
        historyRead: async (
          params,
        ): Promise<WorkerTerminalRecordHistoryReadResult> => {
          const page = await records.historyRead(params);
          if (holdReads) {
            started();
            await held;
          }
          return page;
        },
      },
      outbox: newOutbox(),
    });
    await s.loadWorktreeState('p', 'w');
    s.registerLiveSession({
      ...session('forgotten'),
      initialCommand: 'echo should-not-rerun',
    });
    s.appendTerminalOutput('p', 'w', 'forgotten', Buffer.from('history'));
    s.markTerminalExited('p', 'w', 'forgotten', null, null);
    await s.drainAll();
    const view = await s.loadWorktreeState('p', 'w');
    const forget = (): void => {
      if (method === 'explicit forget') s.forget('forgotten');
      else
        s.saveWorktreeState({
          ...view,
          projectId: 'p',
          worktreeId: 'w',
          groups: [],
          activeGroupId: null,
          forgetTerminalIds: ['forgotten'],
        });
    };
    holdReads = true;
    const prefetch = s.prefetchPersistedEntry('forgotten');
    await reading;
    forget();
    expect(s.getTerminalMetadata('forgotten')).toBeNull();
    resume();
    const release = await prefetch;
    expect(s.getPersistedTerminalEntry('forgotten')).toBeNull();
    release();
    s.registerLiveSession(session('forgotten'));
    s.appendTerminalOutput('p', 'w', 'forgotten', Buffer.from('new history'));
    s.markTerminalExited('p', 'w', 'forgotten', null, null);
    await s.drainAll();
    await s.loadWorktreeState('p', 'w');
    const releaseSeed = await s.prefetchPersistedEntry('forgotten');
    expect(s.getPersistedTerminalEntry('forgotten')?.scrollbackLines).toEqual([
      'new history',
    ]);
    forget();
    expect(s.getPersistedTerminalEntry('forgotten')).toBeNull();
    expect(s.getTerminalMetadata('forgotten')).toBeNull();
    releaseSeed();
    await s.drainAll();
  },
);

it('an empty legacy path is fenced once the daemon record is durable, including after restart', async () => {
  const s = store();
  expect(fs.existsSync(legacyPath())).toBe(false);
  await s.loadWorktreeState('p', 'w');
  expect(fs.existsSync(legacyPath())).toBe(false);
  s.registerLiveSession(session('new-record'));
  await s.drainAll();
  // The receipt, not the next load/restart, installs the fence.
  expect(JSON.parse(fs.readFileSync(legacyPath(), 'utf8'))).toMatchObject({
    version: 3,
    movedTo: 'terminal-record-authority',
  });
  const loaded = await store().loadWorktreeState('p', 'w');
  expect(loaded.terminals.map((t) => t.session.id)).toContain('new-record');
  expect(JSON.parse(fs.readFileSync(legacyPath(), 'utf8'))).toMatchObject({
    version: 3,
  });
});

it('a forgotten live terminal regains restore eligibility only when a layout references it again', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('live-forgotten'));
  s.appendTerminalOutput('p', 'w', 'live-forgotten', Buffer.from('discarded'));
  const view = await s.loadWorktreeState('p', 'w');
  const release = await s.prefetchPersistedEntry('live-forgotten');
  s.saveWorktreeState({
    ...view,
    projectId: 'p',
    worktreeId: 'w',
    groups: [],
    activeGroupId: null,
    forgetTerminalIds: ['live-forgotten'],
  });
  expect(s.getPersistedTerminalEntry('live-forgotten')).toBeNull();
  expect(s.getTerminalMetadata('live-forgotten')).toBeNull();
  s.registerLiveSession(session('live-forgotten'));
  expect(s.getTerminalMetadata('live-forgotten')).toBeNull();
  s.saveWorktreeState({ ...view, projectId: 'p', worktreeId: 'w' });
  expect(s.getTerminalMetadata('live-forgotten')?.session.id).toBe(
    'live-forgotten',
  );
  s.markTerminalExited('p', 'w', 'live-forgotten', 0, null);
  release();
  const releaseRestored = await s.prefetchPersistedEntry('live-forgotten');
  expect(s.getPersistedTerminalEntry('live-forgotten')).toMatchObject({
    session: { id: 'live-forgotten' },
    scrollbackLines: [],
    exitCode: 0,
  });
  releaseRestored();
  await s.drainAll();
});

it('a complete authority load drops the restore entry an outage fallback indexed for a forgotten terminal', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  // A presentation it cannot write leaves the legacy file unfenced.
  fs.writeFileSync(
    join(legacyPath(), '..', 'terminal-presentation.json'),
    JSON.stringify({ version: 99 }),
  );
  const s = store();
  const imported = await s.loadWorktreeState('p', 'w');
  expect(imported.terminals.map((t) => t.session.id)).toEqual(['a', 'b']);
  s.saveWorktreeState({ ...keepOnly(imported, 'b'), forgetTerminalIds: ['a'] });
  await s.drainAll();
  up = false;
  const fallback = await s.loadWorktreeState('p', 'w');
  expect(fallback.history?.status).toBe('unavailable');
  expect(fallback.terminals.map((t) => t.session.id)).toContain('a');
  up = true;
  const healthy = await s.loadWorktreeState('p', 'w');
  expect(healthy.history).toEqual({ status: 'available' });
  expect(healthy.terminals.map((t) => t.session.id)).toEqual(['b']);
  expect(s.getTerminalMetadata('a')).toBeNull();
  const release = await s.prefetchPersistedEntry('a');
  expect(s.getPersistedTerminalEntry('a')).toBeNull();
  release();
  expect(s.getTerminalMetadata('b')?.session.id).toBe('b');
});

it.each([['a', 'b'], ['a']])(
  'a rename from a drawer that could not read the record keeps the saved group (live: %s)',
  async (...live: string[]) => {
    fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
    fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
    const s = store();
    for (const id of live) s.registerLiveSession(session(id));
    const online = await s.loadWorktreeState('p', 'w');
    expect(online.groups.map((g) => g.terminalIds)).toEqual([['a', 'b']]);
    await s.drainAll();
    up = false;
    const partial = await s.loadWorktreeState('p', 'w');
    expect(partial.history?.status).toBe('unavailable');
    expect(partial.groups.map((g) => g.terminalIds)).toEqual([live]);
    s.saveWorktreeState({
      ...partial,
      projectId: 'p',
      worktreeId: 'w',
      terminalCustomNames: { ...partial.terminalCustomNames, a: 'Renamed' },
    });
    up = true;
    await s.drainAll();
    const after = await store().loadWorktreeState('p', 'w');
    expect(after.groups.map((g) => g.terminalIds)).toEqual([['a', 'b']]);
    expect(after.terminalCustomNames).toEqual({ a: 'Renamed', b: 'Build' });
  },
);

it('an outbox receipt alone does not fence an empty legacy path', async () => {
  const s = store();
  await s.loadWorktreeState('p', 'w');
  up = false;
  s.registerLiveSession(session('deferred-fence'));
  await s.drainAll();
  expect(fs.existsSync(legacyPath())).toBe(false);
  up = true;
  await s.drainAll();
  expect(JSON.parse(fs.readFileSync(legacyPath(), 'utf8'))).toMatchObject({
    version: 3,
    movedTo: 'terminal-record-authority',
  });
});

it('R3 startup discovery defers attribution instead of admitting a predecessor', async () => {
  const outbox = newOutbox();
  let finish = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const read = jest.spyOn(outbox, 'read').mockImplementation(async () => {
    await held;
    return {
      outbox: {
        version: 1,
        producer: 'electron_main',
        scopes: [],
        retirements: [],
      },
      runFiles: [],
    };
  });
  const s = newStore({ records, outbox });
  jest.useFakeTimers();
  try {
    const admission = expect(s.recordClientFor('p', 'w')).rejects.toMatchObject(
      { name: 'TerminalRecordAdmissionDeferred' },
    );
    await jest.advanceTimersByTimeAsync(2_001);
    await admission;
  } finally {
    finish();
    read.mockRestore();
    jest.useRealTimers();
  }
  expect(await s.recordClientFor('p', 'w')).toMatchObject({
    projectId: 'p',
    worktreeId: 'w',
  });
});

it('R3 rejected restore query still reads authorized legacy history', async () => {
  const historyRead = jest.fn(
    (params: Parameters<TerminalRecordClientPort['historyRead']>[0]) =>
      records.historyRead(params),
  );
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  const s = newStore({
    records: { ...records, historyRead },
    outbox: newOutbox(),
  });
  await s.loadWorktreeState('p', 'w');
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  historyRead.mockRejectedValue(
    new Error('session changed after availability probe'),
  );
  const release = await s.prefetchPersistedEntry('a');
  expect(s.getPersistedTerminalEntry('a')?.scrollbackLines).toEqual(['A0']);
  release();
});

it.each([false, true])(
  'R3 inconclusive admission keeps running terminals in a fresh drawer (rejection: %s)',
  async (reject) => {
    const s = newStore({
      records,
      outbox: newOutbox(),
      scopeExists: () =>
        reject
          ? Promise.reject(new Error('lookup timeout'))
          : Promise.resolve(null),
    });
    s.registerLiveSession(session('running'));
    const view = await s.loadWorktreeState('p', 'w');
    expect(view.liveTerminalIds).toEqual(['running']);
    expect(view.terminals.map((entry) => entry.session.id)).toEqual([
      'running',
    ]);
    expect(view.history?.status).toBe('unavailable');
    const release = await s.prefetchPersistedEntry('running');
    expect(s.getPersistedTerminalEntry('running')?.session.id).toBe('running');
    release();
  },
);

it('R3 failed startup discovery defers attribution without changing local placement', async () => {
  const outbox = newOutbox();
  const read = jest
    .spyOn(outbox, 'read')
    .mockRejectedValue(new Error('unreadable predecessor custody'));
  const s = newStore({ records, outbox });
  try {
    await expect(s.recordClientFor('p', 'w')).rejects.toMatchObject({
      name: 'TerminalRecordAdmissionDeferred',
    });
    expect(() =>
      s.registerLiveSession(session('local-fallback')),
    ).not.toThrow();
    expect(s.getTerminalMetadata('local-fallback')?.session.id).toBe(
      'local-fallback',
    );
  } finally {
    read.mockRestore();
  }
});

it('R3 an idle run keeps retrying an unreadable outbox on its drain timer', async () => {
  const outbox = newOutbox();
  const read = outbox.read.bind(outbox);
  let unreadable = true;
  const reads = jest.spyOn(outbox, 'read').mockImplementation((...args) => {
    if (unreadable)
      return Promise.reject(
        Object.assign(new Error('denied'), { code: 'EACCES' }),
      );
    return read(...args);
  });
  const clears = jest.spyOn(global, 'clearInterval');
  const s = newStore({ records, outbox });
  try {
    s.start();
    await settle(50);
    const index = intervals.mock.calls.findIndex(([, ms]) => ms === 30_000);
    expect(index).toBeGreaterThanOrEqual(0);
    const [tick] = intervals.mock.calls[index];
    const timer: unknown = intervals.mock.results[index]?.value;
    if (typeof tick !== 'function') throw new Error('Missing drain tick');
    // Its first tick finds the outbox still unreadable: it keeps the timer.
    const before = reads.mock.calls.length;
    tick();
    await settle(50);
    expect(reads.mock.calls.length).toBeGreaterThan(before);
    expect(clears).not.toHaveBeenCalledWith(timer);
    // A later tick reads it, with no load, write or reconnect.
    unreadable = false;
    const failed = reads.mock.calls.length;
    tick();
    await settle(50);
    expect(reads.mock.calls.length).toBeGreaterThan(failed);
    expect((await s.loadWorktreeState('p', 'w')).history?.status).toBe(
      'available',
    );
  } finally {
    reads.mockRestore();
    clears.mockRestore();
  }
});

it('R3 a retirement past the placement bound defers attribution until it actually settles', async () => {
  let finish = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const s = newStore({
    records: {
      ...records,
      retire: async (params) => {
        await held;
        return records.retire(params);
      },
    },
    outbox: newOutbox(),
  });
  await s.recordClientFor('p', 'w');
  up = false;
  await s.retireTerminalRecord({ projectId: 'p', worktreeId: 'w' });
  up = true;
  jest.useFakeTimers();
  try {
    const admission = expect(s.recordClientFor('p', 'w')).rejects.toMatchObject(
      { name: 'TerminalRecordAdmissionDeferred' },
    );
    await jest.advanceTimersByTimeAsync(2_001);
    await admission;
  } finally {
    finish();
    jest.useRealTimers();
  }
  await s.drainAll();
  expect(await s.recordClientFor('p', 'w')).toMatchObject({
    projectId: 'p',
    worktreeId: 'w',
  });
});

it('R3 a load completing after retirement never publishes predecessor history', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  let finish = (): void => undefined;
  let announce = (): void => undefined;
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const s = newStore({
    records: {
      ...records,
      historyRead: async (params) => {
        const result = await records.historyRead(params);
        // Hold the last page: retiring before an unread page would only test
        // query failure, not publication of an already captured predecessor.
        if (params.terminalId === 'b') {
          announce();
          await held;
        }
        return result;
      },
    },
    outbox: newOutbox(),
  });
  const view = s.loadWorktreeState('p', 'w');
  await entered;
  up = false;
  await s.retireTerminalRecord({ projectId: 'p', worktreeId: 'w' });
  finish();
  expect((await view).terminals).toEqual([]);
});

it('R3 repeated fixed-membership edits have bounded serialized custody', async () => {
  up = false;
  const s = store();
  s.registerLiveSession(session('edit'));
  const view = await s.loadWorktreeState('p', 'w');
  for (let i = 0; i < 1_000; i += 1) {
    s.saveWorktreeState({
      ...view,
      projectId: 'p',
      worktreeId: 'w',
      terminalCustomNames: { edit: `name-${i}` },
    });
    if (i % 100 === 0) await s.drainAll();
  }
  await s.drainAll();
  const queued = await newOutbox().read('probe');
  expect(JSON.stringify(queued.outbox).length).toBeLessThan(5_000);
  up = true;
  await s.drainAll();
  expect((await s.loadWorktreeState('p', 'w')).terminalCustomNames.edit).toBe(
    'name-999',
  );
});

it('R3 the unattempted reducer is equivalent to sequential ops on unknown bases and live rebinds', () => {
  const layout: WorkerTerminalRecordOp = {
    op: 'layout.save',
    servedIds: ['gone'],
    referencedIds: ['a', 'b'],
    bindings: [
      {
        key: 'g',
        groupId: 'g',
        members: [
          { key: 'a-pane', terminalId: 'a' },
          { key: 'b-pane', terminalId: 'b' },
        ],
      },
    ],
    terminalCustomNames: { a: 'first' },
  };
  const latest = { ...layout, terminalCustomNames: { b: 'last' } };
  const scenarios: WorkerTerminalRecordOp[][] = [
    [
      layout,
      { op: 'output.append', terminalId: 'a', text: '-tail' },
      { op: 'rename', terminalId: 'unseen', name: 'kept' },
      latest,
    ],
    [
      layout,
      { op: 'output.replace', terminalId: 'gone', lines: ['not resurrected'] },
      latest,
    ],
    [{ op: 'forget', terminalId: 'a' }, layout, latest],
    [
      layout,
      { op: 'forget', terminalId: 'a' },
      { op: 'session.upsert', session: session('a') },
      latest,
    ],
    [
      layout,
      { op: 'exit', terminalId: 'a', exitCode: 1, signal: null },
      latest,
      { op: 'session.upsert', session: session('a') },
    ],
    [
      { op: 'rename', terminalId: 'a', name: 'old' },
      { op: 'output.append', terminalId: 'a', text: '-tail' },
      { op: 'rename', terminalId: 'a', name: null },
    ],
    [
      layout,
      {
        ...latest,
        bindings: [
          {
            key: 'changed',
            groupId: 'changed',
            members: [{ key: 'new-pane', terminalId: 'b' }],
          },
        ],
      },
      latest,
    ],
  ];
  for (const withLive of [false, true])
    for (const ops of scenarios) {
      const initial: TerminalRecordPayloadState = {
        bindings: [
          {
            key: 'g',
            groupId: 'old-group',
            members: [
              { key: 'a-pane', terminalId: 'unseen' },
              { key: 'kept-pane', terminalId: 'other' },
            ],
          },
        ],
        terminals: ['a', 'b', 'gone', 'unseen', 'other'].map((id) => ({
          session: session(id),
          scrollbackLines: [`history-${id}`],
          exitCode: 0,
          signal: null,
        })),
        terminalCustomNames: {
          a: 'base-a',
          gone: 'base-gone',
          unseen: 'base-unseen',
        },
      };
      const expected = structuredClone(initial);
      const actual = structuredClone(initial);
      const reduced: WorkerTerminalRecordOp[] = [];
      const hooks = {
        liveSession: (id: string): ReturnType<typeof session> | null =>
          withLive ? session(id) : null,
      };
      for (const op of ops) {
        applyTerminalRecordOp(expected, op, hooks);
        enqueueTerminalRecordOp(reduced, op);
      }
      for (const op of reduced) applyTerminalRecordOp(actual, op, hooks);
      expect(actual).toEqual(expected);
    }
});

it.each(['normal', 'lost-retirement-reply', 'lost-binding-reply'] as const)(
  'R8 recipient retirement survives clock rollback and successor writes before drain (%s)',
  async (reply) => {
    const projectId = SHARED_CONTAINER_VIEWER_PROJECT_ID;
    const worktreeId = 'container';
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    try {
      await records.apply({
        client: {
          projectId,
          worktreeId,
          legacyLayout: 'workspaces',
          incarnation: null,
        },
        producer: { id: 'electron_main', runId: 'prior-account' },
        seq: 1,
        ops: [
          {
            op: 'session.upsert',
            session: { ...session('private'), projectId, worktreeId },
          },
          {
            op: 'output.append',
            terminalId: 'private',
            text: 'prior account output',
          },
        ],
      });
      clock.mockReturnValue(1);
      up = false;
      // A new process owns no local predecessor scope or queued output.
      let lose = reply === 'lost-retirement-reply';
      let loseBinding = reply === 'lost-binding-reply';
      const s = newStore({
        records: {
          ...records,
          apply: async (params) => {
            const result = await records.apply(params);
            if (loseBinding && params.ops.length === 0) {
              loseBinding = false;
              throw new Error('binding reply lost');
            }
            return result;
          },
          retire: async (params) => {
            const result = await records.retire(params);
            if (lose) {
              lose = false;
              throw new Error('reply lost');
            }
            return result;
          },
        },
        outbox: newOutbox(),
      });
      await s.retireRecipientTerminalRecord(worktreeId);
      // User operations stay unblocked. Their authority sends must follow the
      // cleanup binding, even when queued before its background drain runs.
      s.registerLiveSession({ ...session('successor'), projectId, worktreeId });
      s.appendTerminalOutput(
        projectId,
        worktreeId,
        'successor',
        Buffer.from('new account output'),
      );
      up = true;
      await s.drainAll();
      await s.drainAll();
      const view = await s.loadWorktreeState(projectId, worktreeId);
      expect(view.terminals.map((entry) => entry.session.id)).toEqual([
        'successor',
      ]);
      expect(view.terminals[0].scrollbackLines).toEqual(['new account output']);
      // The retained journal retries on restart without binding to a successor.
      s.markAllLiveTerminalsExited('app-quit');
      const next = store();
      const afterRestart = await next.loadWorktreeState(projectId, worktreeId);
      expect(afterRestart.terminals.map((entry) => entry.session.id)).toEqual([
        'successor',
      ]);
      expect(afterRestart.terminals[0].scrollbackLines).toEqual([
        'new account output',
      ]);
    } finally {
      clock.mockRestore();
    }
  },
);

it('R8 recipient binding holds concurrent successor sends until cleanup is fenced', async () => {
  const projectId = SHARED_CONTAINER_VIEWER_PROJECT_ID;
  const worktreeId = 'container';
  await records.apply({
    client: {
      projectId,
      worktreeId,
      legacyLayout: 'workspaces',
      incarnation: null,
    },
    producer: { id: 'electron_main', runId: 'prior-account' },
    seq: 1,
    ops: [
      {
        op: 'session.upsert',
        session: { ...session('private'), projectId, worktreeId },
      },
    ],
  });
  let bindingStarted = (): void => undefined;
  let releaseBinding = (): void => undefined;
  let writeObserved = (): void => undefined;
  const binding = new Promise<void>((resolve) => {
    bindingStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseBinding = resolve;
  });
  const successorWrite = new Promise<void>((resolve) => {
    writeObserved = resolve;
  });
  let bindingReleased = false;
  let sentBeforeBinding = false;
  const outbox = newOutbox();
  const write = outbox.write.bind(outbox);
  jest.spyOn(outbox, 'write').mockImplementation(async (...args) => {
    await write(...args);
    if (
      args[0].scopes.some(({ entries }) =>
        entries.some(({ ops }) =>
          ops.some(
            (op) => op.op === 'output.append' && op.terminalId === 'successor',
          ),
        ),
      )
    )
      writeObserved();
  });
  const s = newStore({
    outbox,
    records: {
      ...records,
      apply: async (params) => {
        if (params.ops.length === 0) {
          bindingStarted();
          await released;
        }
        const result = await records.apply(params);
        if (
          params.ops.some(
            (op) => op.op === 'output.append' && op.terminalId === 'successor',
          )
        ) {
          sentBeforeBinding ||= !bindingReleased;
          writeObserved();
        }
        return result;
      },
    },
  });
  try {
    await s.retireRecipientTerminalRecord(worktreeId);
    await binding;
    s.registerLiveSession({ ...session('successor'), projectId, worktreeId });
    s.appendTerminalOutput(
      projectId,
      worktreeId,
      'successor',
      Buffer.from('new account output'),
    );
    // Observe the scheduled flush: correct admission queues custody while the
    // bind is held; the red control instead sends it to the predecessor record.
    await successorWrite;
  } finally {
    bindingReleased = true;
    releaseBinding();
  }
  await s.drainAll();
  expect(sentBeforeBinding).toBe(false);
  const view = await s.loadWorktreeState(projectId, worktreeId);
  expect(
    view.terminals.map((entry) => [entry.session.id, entry.scrollbackLines]),
  ).toEqual([['successor', ['new account output']]]);
});

it('R3 recipient outbox failure scrubs plaintext and fences recreated account views across restart', async () => {
  const projectId = SHARED_CONTAINER_VIEWER_PROJECT_ID;
  const worktreeId = 'container';
  const directory = join(
    mockRoot,
    'workspaces',
    projectId,
    'worktree-data',
    worktreeId,
  );
  const path = join(directory, 'terminal-state.json');
  const legacy = fixture();
  for (const entry of legacy.terminals)
    entry.session = { ...entry.session, projectId, worktreeId };
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path, JSON.stringify(legacy));
  const outbox = newOutbox();
  const first = newStore({ records, outbox });
  expect(
    (await first.loadWorktreeState(projectId, worktreeId)).terminals,
  ).toHaveLength(2);
  up = false;
  fs.writeFileSync(path, JSON.stringify(legacy));
  fs.writeFileSync(
    join(directory, 'other-history.txt'),
    'private account data',
  );
  const write = jest
    .spyOn(outbox, 'write')
    .mockRejectedValue(new Error('outbox disk unavailable'));
  const retire = jest
    .spyOn(terminalPersistenceStore, 'retireRecipientTerminalRecord')
    .mockImplementation((id) => first.retireRecipientTerminalRecord(id));
  const remove = jest
    .mocked(removeTreeWithoutAsar)
    .mockImplementation((target, options) => fsPromises.rm(target, options));
  try {
    await cleanupSharedContainerRecipientViewState(worktreeId);
    const markerPath = recipientTerminalRetirementPath(projectId, worktreeId);
    expect(fs.readdirSync(directory)).toEqual([basename(markerPath)]);
    const marker = fs.readFileSync(markerPath, 'utf8');
    expect(marker).not.toContain('A0');
    expect(marker).not.toContain('B0');
    expect(JSON.parse(marker)).toMatchObject({
      version: 1,
      recipientRetirements: [
        expect.objectContaining({ projectId, worktreeId }),
      ],
    });
    // Recreating the runnable copy cannot authorize either source of old history.
    fs.mkdirSync(join(mockRoot, 'run'), { recursive: true });
    expect(
      (await first.loadWorktreeState(projectId, worktreeId)).terminals,
    ).toEqual([]);
    await first.prefetchPersistedEntry('a');
    expect(first.getPersistedTerminalEntry('a')).toBeNull();
    const next = newStore({ records, outbox: newOutbox() });
    expect(
      (await next.loadWorktreeState(projectId, worktreeId)).terminals,
    ).toEqual([]);
    up = true;
    await next.drainAll();
    await next.recordClientFor(projectId, worktreeId);
    next.registerLiveSession({
      ...session('successor'),
      projectId,
      worktreeId,
    });
    next.appendTerminalOutput(
      projectId,
      worktreeId,
      'successor',
      Buffer.from('new account'),
    );
    await next.drainAll();
    const view = await next.loadWorktreeState(projectId, worktreeId);
    expect(view.terminals.map((entry) => entry.session.id)).toEqual([
      'successor',
    ]);
    expect(view.terminals[0].scrollbackLines).toEqual(['new account']);
  } finally {
    write.mockRestore();
    retire.mockRestore();
    remove.mockReset().mockResolvedValue(undefined);
  }
});

it('R3 an unreadable recipient journal is neither replaced nor swept and fences history after restart', async () => {
  const projectId = SHARED_CONTAINER_VIEWER_PROJECT_ID;
  const worktreeId = 'container';
  const directory = join(
    mockRoot,
    'workspaces',
    projectId,
    'worktree-data',
    worktreeId,
  );
  const markerPath = recipientTerminalRetirementPath(projectId, worktreeId);
  const outbox = newOutbox();
  const first = newStore({ records, outbox });
  first.registerLiveSession({ ...session('private'), projectId, worktreeId });
  first.appendTerminalOutput(
    projectId,
    worktreeId,
    'private',
    Buffer.from('prior account output'),
  );
  await first.drainAll();
  authority.flushSync();
  up = false;
  const write = jest
    .spyOn(outbox, 'write')
    .mockRejectedValue(new Error('outbox disk unavailable'));
  const retire = jest
    .spyOn(terminalPersistenceStore, 'retireRecipientTerminalRecord')
    .mockImplementation((id) => first.retireRecipientTerminalRecord(id));
  const remove = jest
    .mocked(removeTreeWithoutAsar)
    .mockImplementation((target, options) => fsPromises.rm(target, options));
  const read = fsPromises.readFile;
  let reading: jest.SpiedFunction<typeof fsPromises.readFile> | undefined;
  let journal = '';
  try {
    // The first purge leaves only its journal: the one durable fence.
    await cleanupSharedContainerRecipientViewState(worktreeId);
    journal = fs.readFileSync(markerPath, 'utf8');
    fs.writeFileSync(
      join(directory, 'other-history.txt'),
      'private account data',
    );
    reading = jest
      .spyOn(fsPromises, 'readFile')
      .mockImplementation(async (...args) => {
        if (typeof args[0] === 'string' && args[0] === markerPath)
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return Reflect.apply(read, fsPromises, args);
      });
    await cleanupSharedContainerRecipientViewState(worktreeId);
  } finally {
    reading?.mockRestore();
    write.mockRestore();
    retire.mockRestore();
    remove.mockReset().mockResolvedValue(undefined);
  }
  // Plaintext is still scrubbed; the journal it could not read is kept as is.
  expect(fs.readdirSync(directory)).toEqual([basename(markerPath)]);
  expect(fs.readFileSync(markerPath, 'utf8')).toBe(journal);
  // The process dies before an in-memory retry: only the journal remains.
  epoch += 1;
  records = recordsFor(epoch);
  up = true;
  const next = store();
  const view = await next.loadWorktreeState(projectId, worktreeId);
  expect(view.terminals.map((entry) => entry.session.id)).not.toContain(
    'private',
  );
  expect(JSON.stringify(view)).not.toContain('prior account output');
});

it.each(['online', 'offline'] as const)(
  'R3 a quit while the recipient journal install is pending seals none of the retiring scrollback (%s)',
  async (authorityState) => {
    const projectId = SHARED_CONTAINER_VIEWER_PROJECT_ID;
    const worktreeId = 'container';
    const markerPath = recipientTerminalRetirementPath(projectId, worktreeId);
    const s = newStore({ records, outbox: newOutbox() });
    s.registerLiveSession({ ...session('private'), projectId, worktreeId });
    up = authorityState === 'online';
    s.appendTerminalOutput(
      projectId,
      worktreeId,
      'private',
      Buffer.from('earlier scrollback'),
    );
    await s.drainAll();
    // Offline, the lifetime's earlier output is already queued on disk.
    expect(
      fs.existsSync(join(mockRoot, 'terminal-record-outbox.json')) &&
        fs
          .readFileSync(join(mockRoot, 'terminal-record-outbox.json'), 'utf8')
          .includes('earlier scrollback'),
    ).toBe(authorityState === 'offline');
    let reached = (): void => undefined;
    let release = (): void => undefined;
    const pending = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mkdir = fsPromises.mkdir;
    const holding = jest
      .spyOn(fsPromises, 'mkdir')
      .mockImplementation(async (...args) => {
        if (args[0] === dirname(markerPath)) {
          reached();
          await released;
        }
        return Reflect.apply(mkdir, fsPromises, args);
      });
    let retired: Promise<boolean> | undefined;
    try {
      s.appendTerminalOutput(
        projectId,
        worktreeId,
        'private',
        Buffer.from('retiring scrollback'),
      );
      retired = s.retireRecipientTerminalRecord(worktreeId);
      await pending;
      // Quit never waits: it seals the retiring lifetime's queued batch now.
      s.markAllLiveTerminalsExited('app-quit');
    } finally {
      holding.mockRestore();
      release();
    }
    await retired;
    const artifacts = fs
      .readdirSync(mockRoot)
      .filter((name) => name.startsWith('terminal-record-outbox'));
    expect(artifacts).not.toEqual([]);
    for (const name of artifacts) {
      const bytes = fs.readFileSync(join(mockRoot, name), 'utf8');
      expect(bytes).not.toContain('retiring scrollback');
      expect(bytes).not.toContain('earlier scrollback');
    }
  },
);

it('RF5 denied retired loads cannot revive writes or recreate witness directories', async () => {
  const s = newStore({
    records,
    outbox: newOutbox(),
    scopeExists: () => Promise.resolve(false),
  });
  s.registerLiveSession(session('old'));
  await s.drainAll();
  await s.retireTerminalRecord({ projectId: 'p', worktreeId: 'w' });
  await s.drainAll();
  const directory = join(legacyPath(), '..');
  fs.rmSync(directory, { recursive: true, force: true });
  const loaded = await s.loadWorktreeState('p', 'w');
  expect(loaded.terminals).toEqual([]);
  s.saveWorktreeState({ ...fixture(), projectId: 'p', worktreeId: 'w' });
  await s.drainAll();
  expect(fs.existsSync(directory)).toBe(false);
  expect(
    authority.open({
      projectId: 'p',
      worktreeId: 'w',
      legacyLayout: 'workspaces',
      incarnation: null,
    }).terminals,
  ).toEqual([]);
});

it('RF5 authorized legacy fallback stays unavailable until authority recovery', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  up = false;
  const s = store();
  const loaded = await s.loadWorktreeState('p', 'w');
  expect(loaded.terminals).toHaveLength(2);
  expect(loaded.history?.status).toBe('unavailable');
  up = true;
  expect((await s.loadWorktreeState('p', 'w')).history?.status).toBe(
    'available',
  );
});

it('RF5 unreadable Cowork registry is inconclusive rather than absent', async () => {
  fs.writeFileSync(join(mockRoot, 'work-entries.json'), '{bad registry');
  expect(await terminalWorktreeExists('p', 'w')).toBeNull();
  const s = newStore({
    records,
    outbox: newOutbox(),
    scopeExists: terminalWorktreeExists,
  });
  s.registerLiveSession(session('running'));
  expect((await s.loadWorktreeState('p', 'w')).liveTerminalIds).toEqual([
    'running',
  ]);
});

it.each(['presentation', 'legacy'] as const)(
  'RF5 retired metadata classification (%s read) cannot publish into a successor',
  async (boundary) => {
    fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
    fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = fsPromises.readFile;
    let held = false;
    const target =
      boundary === 'legacy'
        ? legacyPath()
        : join(legacyPath(), '..', 'terminal-presentation.json');
    const reading = jest
      .spyOn(fsPromises, 'readFile')
      .mockImplementation(async (...args) => {
        if (typeof args[0] === 'string' && args[0] === target && !held) {
          held = true;
          started();
          await gate;
        }
        return Reflect.apply(read, fsPromises, args);
      });
    const s = store();
    const loading = s.loadWorktreeState('p', 'w');
    try {
      await reached;
      const retiring = s.retireTerminalRecord({
        projectId: 'p',
        worktreeId: 'w',
      });
      release();
      await retiring;
      fs.rmSync(join(legacyPath(), '..'), { recursive: true, force: true });
      await loading;
      expect(fs.existsSync(join(legacyPath(), '..'))).toBe(false);
    } finally {
      release();
      await loading;
      reading.mockRestore();
    }
  },
);

it.each(['mkdir', 'install'])(
  'RF5 retirement waits for legacy fence %s and cannot publish into a successor',
  async (boundary) => {
    fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
    fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mkdir = fsPromises.mkdir;
    const write = atomicFile.writeFileAtomically;
    let held = false;
    let directoryCreates = 0;
    const mkdirSpy = jest
      .spyOn(fsPromises, 'mkdir')
      .mockImplementation(async (...args) => {
        if (String(args[0]) === join(legacyPath(), '..')) directoryCreates += 1;
        if (
          boundary === 'mkdir' &&
          String(args[0]) === join(legacyPath(), '..') &&
          directoryCreates > 0 &&
          !held
        ) {
          held = true;
          started();
          await gate;
        }
        return mkdir(...args);
      });
    const writeSpy = jest
      .spyOn(atomicFile, 'writeFileAtomically')
      .mockImplementation(async (path, data, options) => {
        if (boundary === 'install' && path === legacyPath() && !held) {
          held = true;
          started();
          await gate;
        }
        return write(path, data, options);
      });
    const s = store();
    const loading = s.loadWorktreeState('p', 'w');
    const publication = jest.spyOn(TerminalRecordOutbox.prototype, 'write');
    try {
      await reached;
      publication.mockResolvedValue(undefined);
      let retired = false;
      const retiring = s
        .retireTerminalRecord({ projectId: 'p', worktreeId: 'w' })
        .then(() => {
          retired = true;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(retired).toBe(false);
      release();
      await retiring;
      fs.rmSync(join(legacyPath(), '..'), { recursive: true, force: true });
      await loading;
      expect(fs.existsSync(join(legacyPath(), '..'))).toBe(false);
    } finally {
      release();
      await loading;
      mkdirSpy.mockRestore();
      writeSpy.mockRestore();
      publication.mockRestore();
    }
  },
);

it('RF5 recipient purge scrubs damaged and temporary outbox copies without dropping other scopes or successors', async () => {
  const projectId = SHARED_CONTAINER_VIEWER_PROJECT_ID;
  const client = {
    projectId,
    worktreeId: 'recipient',
    legacyLayout: 'workspaces' as const,
    incarnation: null,
    lifetimeId: 'retired',
  };
  const payload: TerminalRecordOutboxFile = {
    version: 1,
    producer: 'electron_main',
    retirements: [],
    scopes: [
      {
        client,
        entries: [
          {
            seq: 1,
            runId: 'old',
            ops: [
              {
                op: 'output.append',
                terminalId: 'a',
                text: 'private scrollback',
              },
            ],
          },
        ],
      },
      {
        client: { ...client, projectId: 'other' },
        entries: [
          {
            seq: 1,
            runId: 'other',
            ops: [
              {
                op: 'output.append',
                terminalId: 'b',
                text: 'keep other output',
              },
            ],
          },
        ],
      },
      {
        client: { ...client, lifetimeId: 'successor' },
        entries: [
          {
            seq: 1,
            runId: 'new',
            ops: [
              {
                op: 'output.append',
                terminalId: 'c',
                text: 'keep successor output',
              },
            ],
          },
        ],
      },
    ],
  };
  const outbox = newOutbox();
  const damaged = 'terminal-record-outbox.json.damaged-123';
  const temporary = '.terminal-record-outbox.run-old.json.123.uuid.tmp';
  // A crash while scrubbing a leftover temp leaves an atomic temp of that temp.
  const scrubTemporary = `.${temporary}.456.uuid.tmp`;
  fs.writeFileSync(join(mockRoot, damaged), '{bad JSON private scrollback');
  fs.writeFileSync(join(mockRoot, temporary), JSON.stringify(payload));
  fs.writeFileSync(join(mockRoot, scrubTemporary), JSON.stringify(payload));
  const writing = outbox.write(payload);
  const purging = outbox.scrubRecipient(
    { projectId, worktreeId: 'recipient', lifetimeIds: ['retired'] },
    (id) => id === 'successor',
  );
  await writing;
  await purging;
  expect(fs.existsSync(join(mockRoot, damaged))).toBe(false);
  for (const name of fs.readdirSync(mockRoot)) {
    const bytes = fs.readFileSync(join(mockRoot, name), 'utf8');
    expect(bytes).not.toContain('private scrollback');
    expect(bytes).toContain('keep other output');
    expect(bytes).toContain('keep successor output');
  }
  // Even a stale caller's later async publication or synchronous quit seal is filtered.
  await outbox.write(payload, 'stale');
  outbox.seal(payload, 'quit');
  for (const name of fs.readdirSync(mockRoot))
    expect(fs.readFileSync(join(mockRoot, name), 'utf8')).not.toContain(
      'private scrollback',
    );
});

it.each([false, true])(
  'RF7 delayed discovery cannot resurrect retirement (restart=%s)',
  async (restart) => {
    const outbox = newOutbox();
    await outbox.write({
      version: 1,
      producer: 'electron_main',
      retirements: [],
      scopes: [
        {
          client: {
            projectId: 'p',
            worktreeId: 'w',
            legacyLayout: 'workspaces',
            incarnation: 'same',
            lifetimeId: 'unseen-old',
          },
          entries: [
            {
              runId: 'unseen',
              seq: 1,
              ops: [
                { op: 'session.upsert', session: session('deleted') },
                {
                  op: 'output.append',
                  terminalId: 'deleted',
                  text: 'must stay quarantined',
                },
              ],
            },
          ],
        },
      ],
    });
    const read = jest
      .spyOn(outbox, 'read')
      .mockRejectedValue(new Error('temporarily unreadable'));
    const s = newStore({
      records,
      outbox,
      incarnation: () => Promise.resolve('same'),
    });
    await s.retireTerminalRecord({
      projectId: 'p',
      worktreeId: 'w',
      incarnation: 'same',
    });
    read.mockRestore();
    const next = restart
      ? newStore({
          records,
          outbox: newOutbox(),
          incarnation: () => Promise.resolve('same'),
        })
      : s;
    await next.drainAll();
    const view = await next.loadWorktreeState('p', 'w');
    expect(view.terminals.map((entry) => entry.session.id)).not.toContain(
      'deleted',
    );
    const quarantined = await newOutbox().read();
    expect(
      quarantined.outbox.scopes
        .flatMap((scope) => scope.entries)
        .filter((entry) => entry.quarantined)
        .flatMap((entry) => entry.ops),
    ).toContainEqual({
      op: 'output.append',
      terminalId: 'deleted',
      text: 'must stay quarantined',
    });
    // A later deletion that captures the quarantined lifetime removes its output.
    await next.retireTerminalRecord({
      projectId: 'p',
      worktreeId: 'w',
      incarnation: 'same',
    });
    await next.drainAll();
    const retained = await newOutbox().read();
    expect(
      retained.outbox.scopes
        .flatMap((scope) => scope.entries)
        .flatMap((entry) => entry.ops),
    ).not.toContainEqual({
      op: 'output.append',
      terminalId: 'deleted',
      text: 'must stay quarantined',
    });
  },
);
it('RF7 PTY output during drawer history loading does not prevent opening persisted history', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  let emitted = false;
  const s = newStore({
    records: {
      ...records,
      historyRead: async (params) => {
        const result = await records.historyRead(params);
        if (!emitted) {
          emitted = true;
          s.appendTerminalOutput(
            'p',
            'w',
            'running',
            Buffer.from('concurrent'),
          );
        }
        return result;
      },
    },
    outbox: newOutbox(),
  });
  s.registerLiveSession(session('running'));
  await s.drainAll();
  const view = await s.loadWorktreeState('p', 'w');
  expect(view.terminals.map((entry) => entry.session.id)).toContain('a');
  const release = await s.prefetchPersistedEntry('a');
  try {
    expect(s.getPersistedTerminalEntry('a')?.scrollbackLines).toEqual(['A0']);
  } finally {
    release();
  }
});

it.each(['activate-after-discovery', 'replay-after-restart'] as const)(
  'RF7 prepared discovery barrier activates without changing its frozen intent: %s',
  async (mode) => {
    up = false;
    const outbox = newOutbox();
    await outbox.write({
      version: 1,
      producer: 'electron_main',
      retirements: [],
      scopes: [
        {
          client: {
            projectId: 'p',
            worktreeId: 'w',
            legacyLayout: 'workspaces',
            incarnation: 'same',
            lifetimeId: 'unseen-old',
          },
          entries: [
            {
              runId: 'unseen',
              seq: 1,
              ops: [
                { op: 'session.upsert', session: session('deleted') },
                {
                  op: 'output.append',
                  terminalId: 'deleted',
                  text: 'held predecessor',
                },
              ],
            },
          ],
        },
      ],
    });
    const read = jest
      .spyOn(outbox, 'read')
      .mockRejectedValue(new Error('temporarily unreadable'));
    const first = newStore({
      records,
      outbox,
      incarnation: () => Promise.resolve('same'),
    });
    const intent = await first.prepareTerminalRecordRetirement({
      projectId: 'p',
      worktreeId: 'w',
      incarnation: 'same',
    });
    const frozen = JSON.stringify(intent);
    read.mockRestore();
    let next = first;
    if (mode === 'replay-after-restart') {
      first.markAllLiveTerminalsExited('app-quit');
      next = newStore({
        records,
        outbox: newOutbox(),
        incarnation: () => Promise.resolve('same'),
      });
      // Journal decoders can reorder DTO keys; the local barrier key is canonical.
      await next.replayTerminalRecordRetirement(
        WorkerTerminalRecordRetireParamsSchema.parse(intent),
      );
    } else {
      await next.drainAll();
      const before = await next.loadWorktreeState('p', 'w');
      expect(before.terminals.map((entry) => entry.session.id)).toContain(
        'deleted',
      );
      await next.retirePreparedTerminalRecord(intent);
    }
    expect(JSON.stringify(intent)).toBe(frozen);
    await next.prefetchPersistedEntry('deleted');
    expect(next.getPersistedTerminalEntry('deleted')).toBeNull();
    up = true;
    await next.drainAll();
    // A replacement remains usable; quarantine never holds new output behind it.
    next.registerLiveSession(session('successor'));
    next.appendTerminalOutput('p', 'w', 'successor', Buffer.from('new output'));
    await next.drainAll();
    const restored = newStore({
      records,
      outbox: newOutbox(),
      incarnation: () => Promise.resolve('same'),
    });
    const after = await restored.loadWorktreeState('p', 'w');
    expect(after.terminals.map((entry) => entry.session.id)).not.toContain(
      'deleted',
    );
    expect(
      after.terminals.find((entry) => entry.session.id === 'successor')
        ?.scrollbackLines,
    ).toEqual(['new output']);
    const held = await newOutbox().read();
    expect(
      held.outbox.scopes
        .flatMap((scope) => scope.entries)
        .filter((entry) => entry.quarantined)
        .flatMap((entry) => entry.ops),
    ).toContainEqual({
      op: 'output.append',
      terminalId: 'deleted',
      text: 'held predecessor',
    });
  },
);

it('R8 idle startup retries failed discovery until queued history drains', async () => {
  const outbox = newOutbox();
  await outbox.write({
    version: 1,
    producer: 'electron_main',
    scopes: [
      {
        client: {
          projectId: 'p',
          worktreeId: 'w',
          legacyLayout: 'workspaces',
          incarnation: 'same',
          lifetimeId: 'previous',
        },
        entries: [
          {
            runId: 'idle-predecessor',
            seq: 1,
            ops: [
              { op: 'session.upsert', session: session('idle') },
              { op: 'output.append', terminalId: 'idle', text: 'held history' },
            ],
          },
        ],
      },
    ],
    retirements: [],
  });
  const earlier = await outbox.read();
  const read = jest
    .spyOn(outbox, 'read')
    .mockRejectedValue(new Error('EACCES'));
  const s = newStore({
    records,
    outbox,
    incarnation: () => Promise.resolve('same'),
  });
  jest.useFakeTimers();
  try {
    s.start();
    await s.drainAll();
    const drain = jest.spyOn(s, 'drainAll');
    read.mockResolvedValue(earlier);
    await jest.advanceTimersByTimeAsync(30_001);
    expect(drain).toHaveBeenCalled();
    for (const result of drain.mock.results)
      if (result.type === 'return') await result.value;
    const loaded = await s.loadWorktreeState('p', 'w');
    expect(
      loaded.terminals.find((entry) => entry.session.id === 'idle')
        ?.scrollbackLines,
    ).toEqual(['held history']);
  } finally {
    read.mockRestore();
    jest.useRealTimers();
  }
});

it.each([false, true])(
  'R8 boot abandonment survives failed discovery (retained journal: %s)',
  async (retained) => {
    const prepared = await prepareUndiscoveredRetirement();
    prepared.store.markAllLiveTerminalsExited('app-quit');
    const outbox = newOutbox();
    const read = jest
      .spyOn(outbox, 'read')
      .mockRejectedValue(new Error('EACCES'));
    const s = newStore({
      records: { ...records, apply: prepared.apply },
      outbox,
      incarnation: () => Promise.resolve('same'),
    });
    await s.reconcilePreparedTerminalRecordRetirements(
      retained ? [prepared.intent] : [],
    );
    read.mockRestore();
    await s.drainAll();
    const calls = prepared.apply.mock.calls.filter(
      ([params]) => params.producer.runId === 'unseen',
    );
    expect(calls).toHaveLength(retained ? 0 : 1);
    const loaded = await s.loadWorktreeState('p', 'w');
    expect(
      loaded.terminals.find((entry) => entry.session.id === 'deleted')
        ?.scrollbackLines,
    ).toEqual(['pending history']);
  },
);

it('R8 deferred boot proof never abandons a preparation created after the scan', async () => {
  const prepared = await prepareUndiscoveredRetirement();
  prepared.store.markAllLiveTerminalsExited('app-quit');
  const outbox = newOutbox();
  const read = jest
    .spyOn(outbox, 'read')
    .mockRejectedValue(new Error('EACCES'));
  const s = newStore({
    records: { ...records, apply: prepared.apply },
    outbox,
    incarnation: () => Promise.resolve('same'),
  });
  await s.reconcilePreparedTerminalRecordRetirements([]);
  const newer = await s.prepareTerminalRecordRetirement({
    projectId: 'new',
    worktreeId: 'scope',
  });
  expect((await newOutbox().read()).outbox.discoveryFences).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ projectId: 'new', worktreeId: 'scope' }),
    ]),
  );
  read.mockRestore();
  await s.drainAll();
  const held = (await outbox.read()).outbox;
  expect(held.discoveryFences).toBeDefined();
  expect(
    held.discoveryFences?.filter(
      (fence) => !fence.cancelled && !fence.activated,
    ),
  ).toEqual([
    expect.objectContaining({ projectId: 'new', worktreeId: 'scope' }),
  ]);
  expect(
    prepared.apply.mock.calls.filter(
      ([params]) => params.producer.runId === 'unseen',
    ),
  ).toHaveLength(1);
  s.cancelPreparedTerminalRecordRetirement(newer);
});

async function prepareUndiscoveredRetirement(): Promise<{
  store: TerminalPersistenceStore;
  outbox: TerminalRecordOutbox;
  intent: WorkerTerminalRecordRetireParams;
  apply: jest.MockedFunction<TerminalRecordClientPort['apply']>;
}> {
  const outbox = newOutbox();
  await outbox.write({
    version: 1,
    producer: 'electron_main',
    scopes: [
      {
        client: {
          projectId: 'p',
          worktreeId: 'w',
          legacyLayout: 'workspaces',
          incarnation: 'same',
          lifetimeId: 'unseen-old',
        },
        entries: [
          {
            runId: 'unseen',
            seq: 1,
            ops: [
              { op: 'session.upsert', session: session('deleted') },
              {
                op: 'output.append',
                terminalId: 'deleted',
                text: 'pending history',
              },
            ],
          },
        ],
      },
    ],
    retirements: [],
  });
  const read = jest
    .spyOn(outbox, 'read')
    .mockRejectedValue(new Error('unreadable'));
  const apply = jest.fn(
    (...args: Parameters<TerminalRecordClientPort['apply']>) =>
      records.apply(...args),
  );
  const s = newStore({
    records: { ...records, apply },
    outbox,
    incarnation: () => Promise.resolve('same'),
  });
  try {
    const intent = await s.prepareTerminalRecordRetirement({
      projectId: 'p',
      worktreeId: 'w',
      incarnation: 'same',
    });
    return { store: s, outbox, intent, apply };
  } finally {
    read.mockRestore();
  }
}

it.each([
  'activate',
  'cancel',
  'restart-abandoned',
  'restart-uncertain',
] as const)(
  'RF7 pending-source send cannot cross activation and abandonment releases it: %s',
  async (resolution) => {
    const prepared = await prepareUndiscoveredRetirement();
    const { intent, apply } = prepared;
    const frozen = JSON.stringify(intent);
    let s = prepared.store;
    if (resolution.startsWith('restart')) {
      s.markAllLiveTerminalsExited('app-quit');
      s = newStore({
        records: { ...records, apply },
        outbox: newOutbox(),
        incarnation: () => Promise.resolve('same'),
      });
    }
    await s.drainAll();
    const before = await s.loadWorktreeState('p', 'w');
    expect(
      before.terminals.find((entry) => entry.session.id === 'deleted')
        ?.scrollbackLines,
    ).toEqual(['pending history']);
    expect(
      apply.mock.calls.filter(([params]) => params.producer.runId === 'unseen'),
    ).toHaveLength(0);
    // Local lifetimes keep working while an earlier intent is undecidable.
    s.registerLiveSession(session('successor'));
    s.appendTerminalOutput('p', 'w', 'successor', Buffer.from('new output'));
    await s.drainAll();
    expect(
      apply.mock.calls.some(([params]) => params.producer.runId !== 'unseen'),
    ).toBe(true);
    const local = await s.loadWorktreeState('p', 'w');
    expect(
      local.terminals.find((entry) => entry.session.id === 'successor')
        ?.scrollbackLines,
    ).toEqual(['new output']);
    if (resolution === 'activate') await s.retirePreparedTerminalRecord(intent);
    else if (resolution === 'cancel')
      s.cancelPreparedTerminalRecordRetirement(intent);
    else
      await s.reconcilePreparedTerminalRecordRetirements(
        resolution === 'restart-abandoned' ? [] : [intent],
      );
    await s.drainAll();
    expect(JSON.stringify(intent)).toBe(frozen);
    const held = (await newOutbox().read()).outbox;
    const entries = held.scopes.flatMap((scope) => scope.entries);
    if (resolution === 'activate') {
      expect(
        apply.mock.calls.filter(
          ([params]) => params.producer.runId === 'unseen',
        ),
      ).toHaveLength(0);
      expect(
        entries.find((entry) => entry.runId === 'unseen')?.quarantined,
      ).toBe(true);
      expect(
        (await s.loadWorktreeState('p', 'w')).terminals.map(
          (entry) => entry.session.id,
        ),
      ).not.toContain('deleted');
      expect(held.discoveryFences ?? []).toHaveLength(0);
    } else if (resolution === 'restart-uncertain') {
      expect(
        entries.find((entry) => entry.runId === 'unseen')?.discoveryFenceIds,
      ).toHaveLength(1);
      expect(
        apply.mock.calls.filter(
          ([params]) => params.producer.runId === 'unseen',
        ),
      ).toHaveLength(0);
    } else {
      expect(
        apply.mock.calls.filter(
          ([params]) => params.producer.runId === 'unseen',
        ),
      ).toHaveLength(1);
      expect(entries.filter((entry) => entry.runId === 'unseen')).toHaveLength(
        0,
      );
      expect(held.discoveryFences ?? []).toHaveLength(0);
    }
  },
);

it('RF7 activation racing discovery uses the latest fence, not the read snapshot', async () => {
  const {
    store: s,
    outbox,
    intent,
    apply,
  } = await prepareUndiscoveredRetirement();
  const read = outbox.read.bind(outbox);
  let discovered = (): void => {};
  let finish = (): void => {};
  const entered = new Promise<void>((resolve) => {
    discovered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  jest.spyOn(outbox, 'read').mockImplementation(async (...args) => {
    const result = await read(...args);
    discovered();
    await held;
    return result;
  });
  const drain = s.drainAll();
  await entered;
  const retirement = s.retirePreparedTerminalRecord(intent);
  finish();
  await retirement;
  await drain;
  expect(
    apply.mock.calls.filter(([params]) => params.producer.runId === 'unseen'),
  ).toHaveLength(0);
  expect(
    (await s.loadWorktreeState('p', 'w')).terminals.map(
      (entry) => entry.session.id,
    ),
  ).not.toContain('deleted');
});

it('RF7 a predecessor source stamped later by a clock that moved back stays behind the barrier', async () => {
  // The earlier run started while the wall clock read an hour ahead.
  fs.writeFileSync(
    join(mockRoot, 'terminal-record-outbox.run-ahead.json'),
    JSON.stringify({
      version: 1,
      producer: 'electron_main',
      runStartedAt: Date.now() + 3_600_000,
      retirements: [],
      scopes: [
        {
          client: {
            projectId: 'p',
            worktreeId: 'w',
            legacyLayout: 'workspaces',
            incarnation: 'same',
            lifetimeId: 'ahead-old',
          },
          entries: [
            {
              runId: 'ahead',
              seq: 1,
              ops: [
                { op: 'session.upsert', session: session('deleted') },
                {
                  op: 'output.append',
                  terminalId: 'deleted',
                  text: 'must stay quarantined',
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  const outbox = newOutbox();
  const read = jest
    .spyOn(outbox, 'read')
    .mockRejectedValue(new Error('temporarily unreadable'));
  const apply = jest.fn(
    (...args: Parameters<TerminalRecordClientPort['apply']>) =>
      records.apply(...args),
  );
  const s = newStore({
    records: { ...records, apply },
    outbox,
    incarnation: () => Promise.resolve('same'),
  });
  await s.retireTerminalRecord({
    projectId: 'p',
    worktreeId: 'w',
    incarnation: 'same',
  });
  read.mockRestore();
  await s.drainAll();
  expect(
    apply.mock.calls.filter(([params]) => params.producer.runId === 'ahead'),
  ).toHaveLength(0);
  expect(
    (await s.loadWorktreeState('p', 'w')).terminals.map(
      (entry) => entry.session.id,
    ),
  ).not.toContain('deleted');
  expect(
    (await newOutbox().read()).outbox.scopes
      .flatMap((scope) => scope.entries)
      .find((entry) => entry.runId === 'ahead')?.quarantined,
  ).toBe(true);
});

it('RF7 a pending barrier never routes independent writes through a failing outbox', async () => {
  const { store: s, outbox, apply } = await prepareUndiscoveredRetirement();
  await s.drainAll();
  const write = jest
    .spyOn(outbox, 'write')
    .mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
  try {
    s.registerLiveSession(session('independent'));
    s.appendTerminalOutput('p', 'w', 'independent', Buffer.from('applied'));
    await s.drainAll();
  } finally {
    write.mockRestore();
  }
  expect(
    apply.mock.calls.filter(([params]) => params.producer.runId === 'unseen'),
  ).toHaveLength(0);
  const client = await s.recordClientFor('p', 'w');
  expect(
    authority.historyRead({ client, terminalId: 'independent' }).text,
  ).toBe('applied');
});

it.each([
  ['explicit forget', 'cancel'],
  ['save forget', 'cancel'],
  ['explicit forget', 'restart-abandoned'],
  ['save forget', 'restart-abandoned'],
] as const)(
  'RF7 a terminal forgotten behind a pending barrier stays forgotten once it is released (%s, %s)',
  async (method, release) => {
    const prepared = await prepareUndiscoveredRetirement();
    const { intent, apply } = prepared;
    let s = prepared.store;
    await s.drainAll();
    const view = await s.loadWorktreeState('p', 'w');
    expect(view.terminals.map((entry) => entry.session.id)).toContain(
      'deleted',
    );
    if (method === 'explicit forget') s.forget('deleted');
    else
      s.saveWorktreeState({
        ...view,
        projectId: 'p',
        worktreeId: 'w',
        groups: [],
        activeGroupId: null,
        forgetTerminalIds: ['deleted'],
      });
    await s.drainAll();
    if (release === 'cancel') s.cancelPreparedTerminalRecordRetirement(intent);
    else {
      s.markAllLiveTerminalsExited('app-quit');
      s = newStore({
        records: { ...records, apply },
        outbox: newOutbox(),
        incarnation: () => Promise.resolve('same'),
      });
      await s.reconcilePreparedTerminalRecordRetirements([]);
    }
    await s.drainAll();
    const reloaded = newStore({
      records,
      outbox: newOutbox(),
      incarnation: () => Promise.resolve('same'),
    });
    expect(
      (await reloaded.loadWorktreeState('p', 'w')).terminals.map(
        (entry) => entry.session.id,
      ),
    ).not.toContain('deleted');
  },
);

it('R2 unwitnessed predecessor custody never keeps a daemon restore or the legacy fence in process', async () => {
  await newOutbox().write({
    version: 1,
    producer: 'electron_main',
    retirements: [],
    scopes: [
      {
        client: earlierClient('unwitnessed'),
        entries: [
          {
            seq: 1,
            runId: 'unwitnessed',
            ops: [{ op: 'session.upsert', session: session('unwitnessed') }],
          },
        ],
      },
    ],
  });
  const s = store();
  await s.loadWorktreeState('p', 'w');
  s.registerLiveSession(session('switch'));
  s.appendTerminalOutput('p', 'w', 'switch', Buffer.from('last output'));
  s.markTerminalExited('p', 'w', 'switch', 9, null);
  expect(await s.prepareDaemonRestore('switch')).toBe(true);
  await s.drainAll();
  expect(JSON.parse(fs.readFileSync(legacyPath(), 'utf8'))).toMatchObject({
    version: 3,
    movedTo: 'terminal-record-authority',
  });
  expect(
    (await newOutbox().read()).outbox.scopes
      .flatMap((scope) => scope.entries)
      .some((entry) => entry.runId === 'unwitnessed'),
  ).toBe(true);
});

it('RF7 a retained recipient intent replayed before discovery keeps the successor history queued after it', async () => {
  const projectId = SHARED_CONTAINER_VIEWER_PROJECT_ID;
  const worktreeId = 'container';
  const s = store();
  await s.loadWorktreeState(projectId, worktreeId);
  await s.retireRecipientTerminalRecord(worktreeId);
  await s.drainAll();
  up = false;
  s.registerLiveSession({ ...session('successor'), projectId, worktreeId });
  s.appendTerminalOutput(
    projectId,
    worktreeId,
    'successor',
    Buffer.from('new account output'),
  );
  await s.drainAll();
  s.markAllLiveTerminalsExited('app-quit');
  up = true;
  // The next launch replays the journaled intent before it can read the outbox.
  const outbox = newOutbox();
  const read = jest
    .spyOn(outbox, 'read')
    .mockRejectedValue(new Error('unreadable'));
  const next = newStore({ records, outbox });
  await next.loadWorktreeState(projectId, worktreeId);
  read.mockRestore();
  await next.drainAll();
  await next.drainAll();
  expect(
    (await next.loadWorktreeState(projectId, worktreeId)).terminals.find(
      (entry) => entry.session.id === 'successor',
    )?.scrollbackLines,
  ).toEqual(['new account output']);
});

it('RF7 a forget behind a pending barrier reaches a healthy authority while the outbox fails', async () => {
  const { store: s, outbox, intent } = await prepareUndiscoveredRetirement();
  await s.drainAll();
  s.registerLiveSession(session('deleted'));
  s.appendTerminalOutput('p', 'w', 'deleted', Buffer.from('current output'));
  s.markTerminalExited('p', 'w', 'deleted', 0, null);
  await s.drainAll();
  const client = await s.recordClientFor('p', 'w');
  expect(authority.historyRead({ client, terminalId: 'deleted' }).text).toBe(
    'current output',
  );
  const write = jest
    .spyOn(outbox, 'write')
    .mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
  try {
    s.forget('deleted');
    await s.drainAll();
    expect(authority.historyRead({ client, terminalId: 'deleted' }).text).toBe(
      '',
    );
  } finally {
    write.mockRestore();
  }
  s.cancelPreparedTerminalRecordRetirement(intent);
  await s.drainAll();
  await s.drainAll();
  expect(
    (await store().loadWorktreeState('p', 'w')).terminals.map(
      (entry) => entry.session.id,
    ),
  ).not.toContain('deleted');
});

it('RF7 a daemon restore never proceeds over pending-barrier ops of the same terminal', async () => {
  const { store: s } = await prepareUndiscoveredRetirement();
  await s.drainAll();
  expect(
    (await s.loadWorktreeState('p', 'w')).terminals.map(
      (entry) => entry.session.id,
    ),
  ).toContain('deleted');
  s.registerLiveSession(session('other'));
  s.markTerminalExited('p', 'w', 'other', 0, null);
  await s.drainAll();
  expect(await s.prepareDaemonRestore('other')).toBe(true);
  expect(await s.prepareDaemonRestore('deleted')).toBe(false);
});

it('a full refresh drops stale name evidence before another drawer renames', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  const s = store();
  const drawerA = await s.loadWorktreeState('p', 'w');
  const drawerB = await s.loadWorktreeState('p', 'w');
  // Review 27: A's own name save before its refresh is not name knowledge after it.
  s.saveWorktreeState({
    ...drawerA,
    projectId: 'p',
    worktreeId: 'w',
    terminalCustomNames: { a: 'Original', b: 'Build' },
  });
  await s.drainAll();
  s.saveWorktreeState({
    ...drawerB,
    projectId: 'p',
    worktreeId: 'w',
    terminalCustomNames: { b: 'Build' },
  });
  await s.drainAll();
  const refreshedA = await s.loadWorktreeState(
    'p',
    'w',
    false,
    false,
    drawerA.viewToken,
  );
  expect(refreshedA.history?.status).toBe('available');
  expect(refreshedA.terminalCustomNames.a).toBeUndefined();
  s.saveWorktreeState({
    ...drawerB,
    projectId: 'p',
    worktreeId: 'w',
    terminalCustomNames: { a: 'Renamed', b: 'Build' },
  });
  await s.drainAll();
  jest.useFakeTimers();
  try {
    s.saveWorktreeState({
      ...refreshedA,
      projectId: 'p',
      worktreeId: 'w',
      drawerCollapsed: !refreshedA.drawerCollapsed,
    });
    // Presentation-only saves use the 100 ms debounce, not the record outbox.
    await jest.advanceTimersByTimeAsync(100);
    await s.drainAll();
  } finally {
    jest.useRealTimers();
  }
  authority.dispose();
  authority = newAuthority();
  const reloaded = await store().loadWorktreeState('p', 'w');
  expect(reloaded.terminalCustomNames).toEqual({
    a: 'Renamed',
    b: 'Build',
  });
  expect(reloaded.drawerCollapsed).toBe(!refreshedA.drawerCollapsed);
});

it("a rename the store held back during a refresh survives that drawer's layout save", async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  const s = store();
  let release = (): void => {
    throw new Error('not initialized');
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const load = jest.fn((request: LoadWorktreeTerminalStateRequest) =>
    s.loadWorktreeState(
      request.projectId,
      request.worktreeId,
      request.historyStatusOnly,
      request.historyConfirmationOnly,
      request.retainedViewToken,
    ),
  );
  const controller = createTerminalStore(() =>
    durableTerminalClientFor(s, load),
  );
  try {
    await controller.ensureHydrated('p', 'w');
    expect(controller.store.getState().terminalCustomNames.a).toBe('API');
    load.mockImplementationOnce(async (request) => {
      await gate;
      return s.loadWorktreeState(
        request.projectId,
        request.worktreeId,
        false,
        false,
        request.retainedViewToken,
      );
    });
    const refreshing = controller.store.getState().hydrateWorktree('p', 'w');
    controller.store.getState().setTerminalName('p', 'w', 'a', null);
    await s.drainAll();
    const drawerB = await s.loadWorktreeState('p', 'w');
    s.saveWorktreeState({
      ...drawerB,
      projectId: 'p',
      worktreeId: 'w',
      terminalCustomNames: { a: 'Renamed', b: 'Build' },
    });
    await s.drainAll();
    release();
    await refreshing;
    // The full reply served 'Renamed'; the pending clear keeps it hidden here.
    expect(controller.store.getState().terminalCustomNames.a).toBeUndefined();
    const collapsed =
      !controller.store.getState().worktrees['p/w'].drawerCollapsed;
    jest.useFakeTimers();
    controller.store.getState().setDrawerCollapsed('p', 'w', collapsed);
    // Presentation-only saves use the 100 ms debounce, not the record outbox.
    await jest.advanceTimersByTimeAsync(100);
    await s.drainAll();
    controller.reset();
    jest.useRealTimers();
    authority.dispose();
    authority = newAuthority();
    const reloaded = await store().loadWorktreeState('p', 'w');
    expect(reloaded.terminalCustomNames).toEqual({
      a: 'Renamed',
      b: 'Build',
    });
    expect(reloaded.drawerCollapsed).toBe(collapsed);
  } finally {
    controller.reset();
    jest.useRealTimers();
  }
});

it('partial successor retries preserve another drawer full-save Close token', async () => {
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
  fs.writeFileSync(legacyPath(), JSON.stringify(fixture()));
  const s = store();
  const drawerB = await s.loadWorktreeState('p', 'w');
  let drawerA = await s.loadWorktreeState('p', 'w');
  up = false;
  for (let attempt = 0; attempt < 65; attempt += 1) {
    drawerA = await s.loadWorktreeState(
      'p',
      'w',
      false,
      false,
      drawerA.viewToken,
    );
    expect(drawerA.history?.status).toBe('unavailable');
  }
  up = true;
  // B's token still names what B was shown: its omission ungroups 'a',
  // keeping its history (CAN-6616); an evicted token would leave it grouped.
  s.saveWorktreeState(keepOnly(drawerB, 'b'));
  await s.drainAll();
  authority.dispose();
  authority = newAuthority();
  const ungrouped = await store().loadWorktreeState('p', 'w');
  expect(ungrouped.terminals.map(({ session }) => session.id)).toEqual([
    'a',
    'b',
  ]);
  expect(ungrouped.groups.flatMap((g) => g.terminalIds)).toEqual(['b']);
  // B's Close names what it forgets.
  s.saveWorktreeState({ ...keepOnly(drawerB, 'b'), forgetTerminalIds: ['a'] });
  await s.drainAll();
  authority.dispose();
  authority = newAuthority();
  const reloaded = await store().loadWorktreeState('p', 'w');
  expect(reloaded.terminals.map(({ session }) => session.id)).toEqual(['b']);
});

describe('pending output coalescing writes what it always wrote (CAN-7859)', () => {
  type Step = WorkerTerminalRecordOp | { flush: number };
  const append = (
    terminalId: string,
    text: string,
  ): WorkerTerminalRecordOp => ({
    op: 'output.append',
    terminalId,
    text,
  });
  const numbered = (prefix: string, from: number, count: number): string =>
    Array.from(
      { length: count },
      (_, i) => `${prefix}-${String(from + i)}\n`,
    ).join('');
  const burst = (terminalId: string, lines: number, perChunk: number): Step[] =>
    Array.from({ length: Math.ceil(lines / perChunk) }, (_, i) =>
      append(
        terminalId,
        numbered(
          terminalId,
          i * perChunk,
          Math.min(perChunk, lines - i * perChunk),
        ),
      ),
    );
  const KIB = 1024;
  const MIB = 1024 * KIB;
  const corpus: Record<string, Step[]> = {
    'a burst of small appends': burst('a', 2_000, 1),
    'two terminals interleaved, with rename, exit and upsert between': [
      ...burst('a', 50, 3).flatMap((step, i) => [
        step,
        append('b', `b${String(i)} `),
      ]),
      { op: 'rename', terminalId: 'a', name: 'renamed' },
      append('a', 'after rename\n'),
      { op: 'exit', terminalId: 'b', exitCode: 0, signal: null },
      { op: 'session.upsert', session: session('a') },
      append('a', 'after upsert\n'),
      append('b', ''),
    ],
    'a forgetting layout save and a forget are barriers': [
      ...burst('a', 20, 4),
      {
        op: 'layout.save',
        servedIds: ['a', 'b'],
        referencedIds: ['b'],
        bindings: [],
        terminalCustomNames: {},
      },
      ...burst('a', 20, 4),
      {
        op: 'layout.save',
        servedIds: ['a', 'b'],
        referencedIds: ['a', 'b'],
        bindings: [],
        terminalCustomNames: {},
      },
      ...burst('a', 8, 2),
      { op: 'forget', terminalId: 'a' },
      ...burst('a', 8, 2),
    ],
    'appends after a direct replace': [
      ...burst('a', 10, 5),
      { op: 'output.replace', terminalId: 'a', lines: ['kept', 'lines', ''] },
      ...burst('a', 30, 3),
    ],
    'crossing 5,000 lines turns into a replace': [
      ...burst('a', 6_200, 100),
      append('b', 'other\n'),
      ...burst('a', 300, 7),
    ],
    'crossing 4 MiB turns into a replace': Array.from({ length: 70 }, (_, i) =>
      append('a', `${String(i).padStart(4, '0')}${'x'.repeat(64 * KIB)}\n`),
    ),
    'a line over 1 MiB is clipped': [
      ...Array.from({ length: 5 }, (_, i) =>
        append('a', String(i).repeat(300 * KIB)),
      ),
      append('a', ' end\nnext'),
      append('a', ' line\n'),
    ],
    'a surrogate pair split across appends and across the wire chunk edge': [
      append('a', 'smile \ud83d'),
      append('a', '\ude00 done\n'),
      // The pair's halves land at chars MIB - 1 and MIB of the merged text.
      append('b', `${'e'.repeat(MIB - 2)}\n`),
      append('b', '\ud83d\ude00follow\n'),
      append('b', 'after\n'),
    ],
    'flushes between appends': [
      ...burst('a', 12, 3),
      append('b', 'b1\n'),
      { flush: 1 },
      ...burst('a', 12, 3),
      { flush: 2 },
      append('a', 'unfinished'),
      append('a', ' still'),
      { flush: 10 },
      append('a', ' done\n'),
      { op: 'exit', terminalId: 'a', exitCode: 1, signal: null },
      append('a', 'late\n'),
    ],
    'an unfinished line growing chunk by chunk': Array.from(
      { length: 400 },
      (_, i) => append('a', i % 97 === 96 ? '\n' : `${String(i)},`),
    ),
  };
  const digest = (value: unknown): string =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const summary = (ops: WorkerTerminalRecordOp[]): string[] =>
    ops.map((op) =>
      op.op === 'output.append'
        ? `append ${op.terminalId} ${String(op.text.length)}`
        : op.op === 'output.replace'
          ? `replace ${op.terminalId} ${String(op.lines.length)}`
          : `${op.op} ${'terminalId' in op ? op.terminalId : ''}`.trim(),
    );
  // Generated from the coalescing before CAN-7859 made it linear: a digest
  // of the whole pending list after every step, and the final list's shape.
  const pinned: Record<string, { steps: string; final: string[] }> = {
    'a burst of small appends': {
      steps: 'a4477c1899b547c4e57f570e02a22f587855c7a81aac002a4564902878a8f155',
      final: ['append a 12890'],
    },
    'two terminals interleaved, with rename, exit and upsert between': {
      steps: 'e03acb186143f64eac227c700d9bed73abf6fd7bb15370d23907ec23502c0c80',
      final: [
        'rename a',
        'exit b',
        'session.upsert',
        'append a 266',
        'append b 58',
      ],
    },
    'a forgetting layout save and a forget are barriers': {
      steps: 'bff960b3564e917a22279f5281f9ecf8eaf0841c3aee974b9f9ae444df6fc7a7',
      final: ['layout.save', 'layout.save', 'forget a', 'append a 32'],
    },
    'appends after a direct replace': {
      steps: '0f7fe1e8dc474ea38666f3f18da1c026951f0eb02febf00e51c6afafe15b7850',
      final: ['replace a 33'],
    },
    'crossing 5,000 lines turns into a replace': {
      steps: 'd6a1978cf22608144c0eca97b8e0930e7d3407d502b4b081a0677e9639ef1746',
      final: ['append b 6', 'replace a 5000'],
    },
    'crossing 4 MiB turns into a replace': {
      steps: '062b2ef21111aa0da35b850092370ab82304c9f216523def5ac946bb973f24c0',
      final: ['replace a 65'],
    },
    'a line over 1 MiB is clipped': {
      steps: '10cf004d12d2620c649fdf09762fc51dafa0b5e24bff5bf5f6d09cf9aeaf4b04',
      final: ['append a 1048576', 'append a 11'],
    },
    'a surrogate pair split across appends and across the wire chunk edge': {
      steps: '54b78f2be17160e38b6ac49e09372649072851abaca19df07f35e1e8dadb8e42',
      final: ['append a 14', 'append b 1048575', 'append b 15'],
    },
    'flushes between appends': {
      steps: 'e23d07f40130f1c23aeadf76239c06fe4b1152763be9dcb643b1db80265f628b',
      final: ['exit a', 'append a 11'],
    },
    'an unfinished line growing chunk by chunk': {
      steps: '9aa3fa59b60d8eeaf3017ee6dc232fe6a6c2b58b43375ab0512d56d2cb772687',
      final: ['append a 1479'],
    },
  };

  it.each(Object.keys(corpus))('%s', (name) => {
    const ops: WorkerTerminalRecordOp[] = [];
    const stepDigests: string[] = [];
    for (const step of corpus[name]) {
      if ('flush' in step) ops.splice(0, step.flush);
      else enqueueTerminalRecordOp(ops, step);
      stepDigests.push(digest(ops));
    }
    for (const op of ops) WorkerTerminalRecordOpSchema.parse(op);
    expect({ steps: digest(stepDigests), final: summary(ops) }).toEqual(
      pinned[name],
    );
  });
});
