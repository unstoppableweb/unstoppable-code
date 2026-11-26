// CAN-7051: Electron main's side of the worktree terminal record against a
// real in-process record authority: import and fence on load, in-process
// output through apply batches, the outbox while the daemon is down, its
// quit seal, at-most-once resends, retirement and the restore prefetch.
import * as fs from 'node:fs';
import { z } from 'zod';
import { isRecord } from '../../lib/type-guards';
import fsPromises from 'node:fs/promises';
// The module itself, so a spy reaches the daemon repository's reads.
import fsModule from 'node:fs';
import * as atomicFile from '@canopy/execution-engine/node/lib/atomic-file';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  type TerminalPersistenceStoreOptions,
} from '../persistence';
import { cleanupSharedContainerRecipientViewState } from '../../shared-containers/recipient-view-state';
import { beginDirectoryDeletion } from '../../lib/directory-effect-admission';
import { removePersistedWorktreeDataDirectory } from '@canopy/desktop-shared/node/lib/worktree-data-cleanup';
import {
  retainRetiredOutboxIdentities,
  TerminalRecordOutbox,
  type TerminalRecordOutboxFile,
} from '../record-outbox';
import type { TerminalRecordClientPort } from '../record-client';
import type { readWorkspaceWorktreesDetailed } from '../../lib/workspace-persistence';
import { fixture, session } from './fixtures/terminal-persistence';
import { createTerminalStore } from '@canopy/app-state/terminal';
import type {
  QueryMap,
  TerminalClient,
  TerminalQueryName,
} from '@canopy/app-core';
import type { LoadWorktreeTerminalStateResponse } from '@canopy/protocol/terminal';
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
  getTerminalOutboxDataRoot: (): string => mockRoot,
  getWorkspaceWorkEntriesFilePath: (): string =>
    join(mockRoot, 'work-entries.json'),
  getWorktreeDataRootDir: (): string => mockRoot,
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

it.each([false, true])(
  'R9 empty first reads, flush and quit create no metadata directory (authority up: %s)',
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

it.each(['online', 'outbox-unwritable', 'offline-restart'] as const)(
  'R1 recipient cleanup retires the viewer record before removing its data (%s)',
  async (mode) => {
    const writable = mode !== 'outbox-unwritable';
    const projectId = SHARED_CONTAINER_VIEWER_PROJECT_ID;
    const worktreeId = 'container';
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
    expect(
      (await first.loadWorktreeState(projectId, worktreeId)).terminals,
    ).toHaveLength(1);
    const order: string[] = [];
    const retire = jest
      .spyOn(terminalPersistenceStore, 'retireTerminalRecord')
      .mockImplementation(async (params) => {
        order.push('retire');
        return first.retireTerminalRecord(params);
      });
    const remove = jest
      .mocked(removePersistedWorktreeDataDirectory)
      .mockImplementation(() => {
        order.push('remove');
        return Promise.resolve();
      });
    const write = writable
      ? undefined
      : jest
          .spyOn(outbox, 'write')
          .mockRejectedValue(new Error('outbox disk unavailable'));
    if (mode === 'offline-restart') up = false;
    try {
      // Never refused, even when the retirement cannot be made durable.
      await expect(
        cleanupSharedContainerRecipientViewState(worktreeId),
      ).resolves.toBeUndefined();
      expect(retire).toHaveBeenCalledWith({ projectId, worktreeId });
      expect(order).toEqual(['retire', 'remove']);
      write?.mockRestore();
      if (mode === 'offline-restart') {
        // Quit before the daemon applies it: the outbox carries the retirement.
        first.markAllLiveTerminalsExited('app-quit');
        await first.drainAll();
        expect(
          fs.existsSync(
            join(
              terminalRecordDir(mockRoot, projectId, worktreeId),
              'record.json',
            ),
          ),
        ).toBe(true);
        up = true;
        await newStore({ records, outbox: newOutbox() }).drainAll();
      } else await first.drainAll();
      expect(
        fs.existsSync(
          join(
            terminalRecordDir(mockRoot, projectId, worktreeId),
            'record.json',
          ),
        ),
      ).toBe(false);
      // The next account viewing the same container sees none of its history.
      const next = store();
      expect(
        (await next.loadWorktreeState(projectId, worktreeId)).terminals,
      ).toEqual([]);
    } finally {
      write?.mockRestore();
      retire.mockRestore();
      remove.mockReset().mockResolvedValue(undefined);
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

it.each(['old', null])(
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
    expect(loaded.terminals.map((t) => t.session.id)).toEqual([]);
    s.registerLiveSession(session('queued'));
    const release = await s.prefetchPersistedEntry('queued');
    expect(s.getPersistedTerminalEntry('queued')?.scrollbackLines).toEqual([]);
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
          client: earlierClient('older'),
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
    // As workspace deletion journals its captured intent before activating it.
    const captured = await s.prepareTerminalRecordRetirement({
      projectId: 'p',
    });
    await atomicFile.writeFileAtomically(journal, JSON.stringify(captured), {
      durable: true,
    });
    expect(await s.retirePreparedTerminalRecord(captured)).toBe(false);
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
    client: earlierClient('replacement'),
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

it('R11 an older hydration cannot overwrite a successful retry', async () => {
  const s = store();
  const available = await s.loadWorktreeState('p', 'w');
  let finishOld: (response: LoadWorktreeTerminalStateResponse) => void = () =>
    undefined;
  const old = new Promise<LoadWorktreeTerminalStateResponse>((resolve) => {
    finishOld = resolve;
  });
  let first = true;
  const controller = createTerminalStore(() =>
    terminalClientFor(s, undefined, () => {
      if (!first)
        return Promise.resolve({ ...available, viewToken: 'newer-view' });
      first = false;
      return old;
    }),
  );
  try {
    const pending = controller.store.getState().hydrateWorktree('p', 'w');
    await controller.store.getState().hydrateWorktree('p', 'w');
    finishOld({
      ...available,
      viewToken: 'old-view',
      history: { status: 'unavailable', reason: 'background_service' },
    });
    await pending;
    expect(controller.store.getState().worktrees['p/w']).toMatchObject({
      historyUnavailable: false,
      viewToken: 'newer-view',
    });
  } finally {
    controller.reset();
  }
});

function terminalClientFor(
  persistence: TerminalPersistenceStore,
  probe?: () => Promise<LoadWorktreeTerminalStateResponse>,
  load?: () => Promise<LoadWorktreeTerminalStateResponse>,
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
      if (!args.historyStatusOnly && load) return load();
      return persistence.loadWorktreeState(
        args.projectId,
        args.worktreeId,
        args.historyStatusOnly,
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

it.each(['unmount', 'reset', 'purge'] as const)(
  'a history probe completing after %s cannot publish stale status',
  async (cleanup) => {
    const s = store();
    let answer: (response: LoadWorktreeTerminalStateResponse) => void = () => {
      throw new Error('Probe not started');
    };
    const pending = new Promise<LoadWorktreeTerminalStateResponse>(
      (resolve) => {
        answer = resolve;
      },
    );
    const controller = createTerminalStore(() =>
      terminalClientFor(s, () => pending),
    );
    await controller.store.getState().hydrateWorktree('p', 'w');
    const release = controller.observeHistory('p', 'w');
    if (cleanup === 'unmount') release();
    else if (cleanup === 'reset') controller.reset();
    else controller.purgeWorktrees(['w']);
    answer({
      ...(await s.loadWorktreeState('p', 'w', true)),
      historyHeld: true,
    });
    await pending;
    await Promise.resolve();
    const bucket = controller.store.getState().worktrees['p/w'];
    expect(bucket?.historyHeld).not.toBe(true);
    if (cleanup !== 'unmount') expect(bucket).toBeUndefined();
    release();
    controller.reset();
  },
);

it('a peer without status acknowledgement is probed at most once', async () => {
  const s = store();
  const ordinary = await s.loadWorktreeState('p', 'w');
  expect(ordinary.historyRefreshSupported).toBeUndefined();
  // Older hosts ignore historyStatusOnly and return an ordinary load.
  const client = terminalClientFor(s, () => Promise.resolve(ordinary));
  const controller = createTerminalStore(() => client);
  await controller.store.getState().hydrateWorktree('p', 'w');
  const query = jest.spyOn(client, 'query');
  jest.useFakeTimers();
  try {
    const release = controller.observeHistory('p', 'w');
    await jest.advanceTimersByTimeAsync(6_000);
    expect(query).toHaveBeenCalledTimes(1);
    expect(
      controller.store.getState().worktrees['p/w'].historyRefreshSupported,
    ).toBe(false);
    const secondRelease = controller.observeHistory('p', 'w');
    expect(query).toHaveBeenCalledTimes(1);
    secondRelease();
    release();
  } finally {
    query.mockRestore();
    controller.reset();
    jest.useRealTimers();
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

async function prepareReplayScope(s: TerminalPersistenceStore): Promise<void> {
  const client = await s.recordClientFor('p', 'w');
  if (!client.lifetimeId) throw new Error('Missing fixture lifetime');
  // This scenario starts with metadata already present; a read no longer creates it.
  fs.mkdirSync(join(legacyPath(), '..'), { recursive: true });
}

/**
 * Applies the outbox custody to the authority in order. Only the current
 * lifetime replays, so this checks what a quit sealed into custody.
 */
async function applyCustody(): Promise<void> {
  for (const scope of (await newOutbox().read()).outbox.scopes)
    for (const entry of scope.entries)
      authority.apply({
        client: entry.client ?? scope.client,
        producer: { id: 'electron_main', runId: entry.runId },
        seq: entry.seq,
        ...(entry.generation !== undefined && { generation: entry.generation }),
        ...(entry.sealed && { sealed: entry.sealed }),
        ops: entry.ops,
      });
}

/** One terminal's queued output, in custody order. */
function custodyText(
  entries: readonly { ops: readonly WorkerTerminalRecordOp[] }[],
  terminalId: string,
): string {
  return entries
    .flatMap((entry) => entry.ops)
    .map((op) =>
      op.op === 'output.append' && op.terminalId === terminalId ? op.text : '',
    )
    .join('');
}

it("R2 an earlier run's null-incarnation batches stay durable in custody without blocking", async () => {
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
  const outbox = newOutbox();
  const next = newStore({ records, outbox });
  await next.loadWorktreeState('p', 'w');
  // Held custody is inert: this run's writes still go online, not to the outbox.
  const write = outbox.write.bind(outbox);
  const images: string[] = [];
  const writes = jest.spyOn(outbox, 'write').mockImplementation((...args) => {
    images.push(JSON.stringify(args[0]));
    return write(...args);
  });
  try {
    next.registerLiveSession(session('allowed'));
    await next.drainAll();
    expect(images.join('\n')).not.toContain('allowed');
  } finally {
    writes.mockRestore();
  }
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

it('R2 immediate quit without a prepared directory stays synchronous and keeps history in custody', async () => {
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
    expect((await boot.loadWorktreeState('p', 'w')).terminals).toEqual([]);
    await applyCustody();
    const loaded = await store().loadWorktreeState('p', 'w');
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
      expect(
        custodyText(
          recovered.outbox.scopes.flatMap((scope) => scope.entries),
          'quit-race',
        ),
      ).toBe('before-final');
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
        await applyCustody();
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
  // Reconnecting drains it before the load.
  up = true;
  await s.drainAll();
  const loaded = await s.loadWorktreeState('p', 'w');
  expect(loaded.history).toEqual({ status: 'available' });
  expect(loaded.terminals.find((t) => t.session.id === 'd')).toMatchObject({
    scrollbackLines: ['queued'],
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
  await applyCustody();
  const loaded = await store().loadWorktreeState('p', 'w');
  expect(loaded.terminals).toHaveLength(700);
  expect(loaded.terminals.every((t) => t.signal === 'app-quit')).toBe(true);
});

it('an outbox entry the authority rejects never holds later writes behind it', async () => {
  // One op of a queued batch is one the authority can never accept.
  const rejects = (
    params: Parameters<TerminalRecordClientPort['apply']>[0],
  ): boolean =>
    params.ops.some(
      (op) => op.op === 'session.upsert' && op.session.id === 't300',
    );
  const s = newStore({
    records: {
      ...records,
      apply: (params) =>
        rejects(params)
          ? Promise.reject(
              Object.assign(new Error('invalid'), {
                payload: { kind: 'invalid_argument', retry: { kind: 'never' } },
              }),
            )
          : records.apply(params),
    },
    outbox: newOutbox(),
  });
  await s.loadWorktreeState('p', 'w');
  up = false;
  const ids = terminalIds(600);
  for (const id of ids) s.registerLiveSession(session(id));
  await settle();
  expect(readOutbox().scopes.flatMap((scope) => scope.entries)).not.toEqual([]);
  up = true;
  applyCalls = 0;
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
    [...ids.filter((id) => id !== 't300'), 'later'].sort(),
  );
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

it.each(['reconnect', 'quit custody'] as const)(
  'a lost online reply keeps its full admission identity for %s',
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
    if (recovery === 'quit custody') {
      s.markAllLiveTerminalsExited('app-quit');
      const sent = WorkerTerminalRecordApplyParamsSchema.parse(
        JSON.parse(attempts[0]),
      );
      const [queued] = (await newOutbox().read()).outbox.scopes;
      const [entry] = queued.entries;
      // The held retry is the exact lost request, under its own client.
      expect(entry).toMatchObject({
        runId: sent.producer.runId,
        seq: sent.seq,
        ops: sent.ops,
        attempted: true,
      });
      expect(entry.client ?? queued.client).toEqual(sent.client);
      return;
    }
    up = true;
    await s.drainAll();
    expect(attempts.length).toBeGreaterThan(1);
    expect(attempts[1]).toBe(attempts[0]);
    const loaded = await s.loadWorktreeState('p', 'w');
    expect(
      loaded.terminals.find((entry) => entry.session.id === 'rehydrated')
        ?.scrollbackLines,
    ).toEqual(['once']);
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
    if (mode === 'pending') await applyCustody();
    else await s.drainAll();
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
    // Quit keeps the custody; check what it holds.
    await applyCustody();
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
  await applyCustody();
  const loaded = await store().loadWorktreeState('p', 'w');
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
])(
  "runs' own outboxes merge into the shared custody in run order, including %s",
  async (cleanup) => {
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
          {
            client: earlierClient('newer'),
            entries: [{ seq: 1, runId: 'newer', ops: [upsert('new')] }],
          },
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
            client: earlierClient('older'),
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
    // The newer run's retirement, in run order, drops only the older run's
    // write; the newer one stays held, never sent.
    const custody = async (): Promise<string[]> =>
      (await newOutbox().read()).outbox.scopes
        .flatMap((scope) => scope.entries)
        .flatMap((entry) => entry.ops)
        .flatMap((op) => (op.op === 'session.upsert' ? [op.session.id] : []));
    const next = newStore({
      records,
      outbox: new PartialDiscard(() => mockRoot),
    });
    await next.drainAll();
    expect(await custody()).toEqual(['new']);
    if (cleanup !== 'normal') {
      expect(next.isOutboxWarningShown()).toBe(true);
      const merged = await newOutbox().read();
      expect(merged.outbox.merged).toContain(
        'terminal-record-outbox.run-ffffffff.json',
      );
      expect(
        fs.existsSync(
          join(mockRoot, 'terminal-record-outbox.run-ffffffff.json'),
        ),
      ).toBe(!cleanup.includes('directory flush'));
      failing = false;
      if (cleanup.startsWith('restart')) {
        next.markAllLiveTerminalsExited('app-quit');
        await store().drainAll();
      } else {
        await next.drainAll();
        expect(next.isOutboxWarningShown()).toBe(false);
      }
      expect(await custody()).toEqual(['new']);
    }
    for (const name of [
      'terminal-record-outbox.run-00000000.json',
      'terminal-record-outbox.run-ffffffff.json',
    ])
      expect(fs.existsSync(join(mockRoot, name))).toBe(false);
    expect(await recordedIds()).toEqual([]);
  },
);

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
  // The launch after replays the retirement once; the newer write stays in custody.
  up = true;
  const next = store();
  next.start();
  await next.drainAll();
  expect(await recordedIds()).toEqual([]);
  expect(fs.existsSync(runFile)).toBe(false);
  await applyCustody();
  expect(await recordedIds()).toEqual(['new']);
});

it('writes from a second outage after a drain are durable in the quit seal', async () => {
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
  await applyCustody();
  const loaded = await store().loadWorktreeState('p', 'w');
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
  // An earlier run queued one the schema rejects, ahead of this run's write.
  fs.writeFileSync(
    join(mockRoot, 'terminal-record-outbox.json'),
    JSON.stringify({
      version: 1,
      producer: 'electron_main',
      scopes: [],
      retirements: [{ projectId: 'p', worktreeId: 'w', incarnation: '' }],
    }),
  );
  const s = store();
  s.start();
  s.registerLiveSession(session('kept'));
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
  await next.drainAll();
  await applyCustody();
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
    // Neither run's earlier writes replay here; this run's stay apart in custody.
    expect(loaded.terminals).toEqual([]);
    expect(authority.open(clientOf('inc-2')).terminals).toEqual([]);
    const custody = (await newOutbox().read()).outbox.scopes;
    expect(
      custody.find((scope) =>
        scope.entries.some((entry) =>
          entry.ops.some(
            (op) => op.op === 'session.upsert' && op.session.id === 'new',
          ),
        ),
      )?.client.incarnation,
    ).toBeNull();
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

it('RF5 denied retired loads cannot revive writes or recreate metadata directories', async () => {
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
