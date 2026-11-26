// CAN-6983, re-expressed for CAN-7051. Every invariant of the split terminal
// record keeps its name. Main no longer writes `terminal-state.json`: the
// daemon's record authority (here in process, over the real repository and
// the real atomic installs) writes `record.json`, main writes only the
// presentation and, once a worktree is imported, the forward fence at its
// legacy path. Where the contract changed, the test says what replaced it:
// "worker install" is now the record's install, "worker file" is the record
// (read through `record.json`), and main's legacy file is only ever read
// (import, the read-only fallback) or fenced.
import * as fs from 'node:fs';
import type * as fsPromises from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type * as Storage from '@canopy/core-runtime/storage';
import {
  isTerminalRecordEnvelope,
  TerminalRecordAuthority,
  TerminalRecordRepository,
  type TerminalRecordEnvelope,
} from '@canopy/core-runtime/node/terminal/record';
import type {
  LoadWorktreeTerminalStateResponse,
  SaveWorktreeTerminalStateRequest,
} from '@canopy/desktop-shared/types';
import type * as Paths from '../../lib/paths';
import { isRecord } from '../../lib/type-guards';
import { isPresentationFile, type TerminalRecords } from '../persistence-codec';
import { TerminalPersistenceStore } from '../persistence';
import type { TerminalRecordClientPort } from '../record-client';
import { TerminalRecordOutbox } from '../record-outbox';
import { fixture, session } from './fixtures/terminal-persistence';

let mockRoot: string;
let mockFailure: string | undefined;
let mockFailures: string[] = [];
let mockReadFailure: string | undefined;
let mockAsideFailure = false;
let mockPruneFailure = false;
let mockRefuse: string | undefined;
let mockEvents: string[] = [];
const mockLegacy = (root: string, p: string, w: string, file: string): string =>
  join(root, 'workspaces', p, 'worktree-data', w, file);
jest.mock('../../lib/paths', () => ({
  getWorktreeTerminalStateFilePath: (p: string, w: string): string =>
    mockLegacy(mockRoot, p, w, 'terminal-state.json'),
  getWorktreeTerminalPresentationFilePath: (p: string, w: string): string =>
    mockLegacy(mockRoot, p, w, 'terminal-presentation.json'),
  getWorktreeTerminalLegacyLayout: (): 'workspaces' => 'workspaces',
  getTerminalOutboxDataRoot: (): string => mockRoot,
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('@canopy/core-runtime/storage', () => {
  const actual = jest.requireActual<typeof Storage>(
    '@canopy/core-runtime/storage',
  );
  return {
    ...actual,
    get STORAGE_OWNERSHIP(): readonly Storage.StorageOwnershipRow[] {
      return mockRefuse
        ? actual.STORAGE_OWNERSHIP.map((row) =>
            row.id === mockRefuse
              ? { ...row, transitionOwner: 'offline' }
              : row,
          )
        : actual.STORAGE_OWNERSHIP;
    },
  };
});
const mockInstall = (from: string, to: string): void => {
  if (to.includes('.damaged-')) {
    if (mockAsideFailure)
      throw Object.assign(new Error('aside blocked'), { code: 'EIO' });
  } else if (from.endsWith('.tmp')) {
    mockEvents.push(`attempt:${basename(to)}`);
    if (to === mockFailure || mockFailures.includes(to))
      throw Object.assign(new Error('install blocked'), { code: 'EIO' });
  }
};
jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof fs>('node:fs');
  return {
    ...actual,
    readFileSync: (
      ...args: Parameters<typeof fs.readFileSync>
    ): string | Buffer => {
      if (String(args[0]) === mockReadFailure)
        throw Object.assign(new Error('injected read'), { code: 'EACCES' });
      return Reflect.apply(actual.readFileSync, actual, args);
    },
    renameSync: (from: fs.PathLike, to: fs.PathLike): void => {
      mockInstall(String(from), String(to));
      actual.renameSync(from, to);
      if (String(from).endsWith('.tmp'))
        mockEvents.push(`installed:${basename(String(to))}`);
    },
    unlinkSync: (path: fs.PathLike): void => {
      if (mockPruneFailure && String(path).includes('.damaged-'))
        throw Object.assign(new Error('prune blocked'), { code: 'EIO' });
      actual.unlinkSync(path);
    },
  };
});
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof fsPromises>('node:fs/promises');
  return {
    ...actual,
    readFile: async (
      ...args: Parameters<typeof fsPromises.readFile>
    ): Promise<string | Buffer> => {
      if (typeof args[0] === 'string' && args[0] === mockReadFailure)
        throw Object.assign(new Error('injected read'), { code: 'EACCES' });
      return Reflect.apply(actual.readFile, actual, args);
    },
    rename: async (from: fs.PathLike, to: fs.PathLike): Promise<void> => {
      mockInstall(String(from), String(to));
      await actual.rename(from, to);
      if (String(from).endsWith('.tmp'))
        mockEvents.push(`installed:${basename(String(to))}`);
    },
  };
});

/** The files whose installs these invariants order. */
const ORDERED = new Set([
  'record.json',
  'terminal-presentation.json',
  'terminal-state.json',
]);

let up = true;
let authority: TerminalRecordAuthority;
let applies = 0;
function newAuthority(): TerminalRecordAuthority {
  return new TerminalRecordAuthority({
    repository: new TerminalRecordRepository({
      dataRoot: mockRoot,
      flushDirectorySync: () => undefined,
    }),
    installDebounceMs: 1,
  });
}
// Each test's stores reach only that test's daemon: a store left with
// timers never writes into the next test's data root.
let epoch = 0;
const stores: TerminalPersistenceStore[] = [];
function recordsFor(owner: number): TerminalRecordClientPort {
  const reach = <T>(run: () => T): Promise<T> =>
    up && owner === epoch
      ? Promise.resolve().then(run)
      : Promise.reject(new Error('down'));
  return {
    available: () => Promise.resolve(up && owner === epoch),
    open: (client) => reach(() => authority.open(client)),
    historyRead: (params) => reach(() => authority.historyRead(params)),
    apply: (params) =>
      reach(() => {
        applies += 1;
        return authority.apply(params);
      }),
    retire: (params) =>
      reach(() => {
        authority.retire(params);
      }),
    shutdown: (signal) =>
      reach(() => {
        authority.shutdown(signal);
      }),
  };
}

const workerPath = (w = 'w', p = 'p'): string =>
  mockLegacy(mockRoot, p, w, 'terminal-state.json');
const presentationPath = (w = 'w', p = 'p'): string =>
  mockLegacy(mockRoot, p, w, 'terminal-presentation.json');
const recordPath = (w = 'w', p = 'p'): string =>
  join(mockRoot, 'terminal-records', p, w, 'record.json');
function seed(value: unknown = fixture(), path = workerPath()): string {
  const bytes = typeof value === 'string' ? value : JSON.stringify(value);
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, bytes);
  return bytes;
}
function read(path = workerPath()): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!isRecord(value)) throw new Error(`Expected record at ${path}`);
  return value;
}
/** The record the authority installed: the worker plane's truth. */
function readRecord(w = 'w', p = 'p'): TerminalRecordEnvelope {
  const value = read(recordPath(w, p));
  if (!isTerminalRecordEnvelope(value)) throw new Error('Expected a record');
  return value;
}
function readWorker(w = 'w'): TerminalRecords['worker'] {
  const { lineage, record } = readRecord(w);
  return { version: 2, lineage, ...record };
}
function readPresentation(): TerminalRecords['presentation'] {
  const value = read(presentationPath());
  if (!isPresentationFile(value)) throw new Error('Expected presentation v1');
  return value;
}
function newStore(): TerminalPersistenceStore {
  const root = mockRoot;
  const store = new TerminalPersistenceStore({
    records: recordsFor(epoch),
    outbox: new TerminalRecordOutbox(() => root),
  });
  stores.push(store);
  return store;
}
function load(
  store: TerminalPersistenceStore,
  w = 'w',
  p = 'p',
): Promise<LoadWorktreeTerminalStateResponse> {
  return store.loadWorktreeState(p, w);
}
/** What a load served, less the token naming its view, which it must carry. */
function served(
  response: LoadWorktreeTerminalStateResponse,
): Omit<LoadWorktreeTerminalStateResponse, 'viewToken'> {
  const { viewToken, ...layout } = response;
  expect(typeof viewToken).toBe('string');
  return layout;
}
/** A save from the drawer, as the renderer sends it after a load. */
async function save(
  store: TerminalPersistenceStore,
  patch: Partial<SaveWorktreeTerminalStateRequest> = {},
  w = 'w',
): Promise<void> {
  store.saveWorktreeState({
    ...(await load(store, w)),
    projectId: 'p',
    worktreeId: w,
    ...patch,
  });
}
/** Every queued write applied or durable, and the layout that waited on it. */
async function settle(store: TerminalPersistenceStore): Promise<void> {
  await store.drainAll();
  store.flushAllSync();
  authority.flushSync();
}
/**
 * Applies the outbox custody to the authority in order. Only the current
 * lifetime replays, so this checks what a quit sealed into custody.
 */
async function applyCustody(): Promise<void> {
  for (const scope of (await new TerminalRecordOutbox(() => mockRoot).read())
    .outbox.scopes)
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
/** A restarted main run against the same daemon. */
async function open(w = 'w'): Promise<TerminalPersistenceStore> {
  const store = newStore();
  store.start();
  await load(store, w);
  return store;
}
function installs(): string[] {
  return mockEvents
    .filter((event) => event.startsWith('installed:'))
    .map((event) => event.slice(10))
    .filter((name) => ORDERED.has(name));
}
async function pair(): Promise<TerminalPersistenceStore> {
  seed();
  const store = await open();
  await settle(store);
  mockEvents = [];
  return store;
}
function expectedLineage(bytes: string, worktreeId = 'w'): string {
  return `legacy/${createHash('sha256')
    .update(
      JSON.stringify(['p', worktreeId, Buffer.from(bytes).toString('base64')]),
    )
    .digest('hex')}`;
}
function expectedPresentation(
  lineage: string,
): TerminalRecords['presentation'] {
  return {
    version: 1,
    lineage,
    drawerCollapsed: false,
    groups: [
      {
        bindingKey: 'legacy-group/0',
        paneOrder: ['legacy-pane/0', 'legacy-pane/1'],
        focusedTerminalId: 'b',
        splitSizes: [0.25, 0.75],
      },
    ],
    activeGroupId: 'g',
    groupOrdinals: { g: 7 },
    nextGroupOrdinal: 8,
    groupCustomNames: { g: 'Development' },
  };
}
function expectedWorker(lineage: string): TerminalRecords['worker'] {
  return {
    version: 2,
    lineage,
    bindings: [
      {
        key: 'legacy-group/0',
        groupId: 'g',
        members: [
          { key: 'legacy-pane/0', terminalId: 'a' },
          { key: 'legacy-pane/1', terminalId: 'b' },
        ],
      },
    ],
    terminals: fixture().terminals,
    terminalCustomNames: { a: 'API', b: 'Build' },
  };
}
const FENCE = { version: 3, movedTo: 'terminal-record-authority' };
const AVAILABLE = { status: 'available' };

beforeEach(() => {
  mockRoot = fs.mkdtempSync(join(tmpdir(), 'terminal-pair-'));
  mockFailure = undefined;
  mockFailures = [];
  mockReadFailure = undefined;
  mockAsideFailure = false;
  mockPruneFailure = false;
  mockRefuse = undefined;
  mockEvents = [];
  up = true;
  applies = 0;
  authority = newAuthority();
});
afterEach(() => {
  epoch += 1;
  // Quit ends every store's timers before the data root goes.
  for (const store of stores.splice(0))
    store.markAllLiveTerminalsExited('app-quit');
  authority.dispose();
  fs.rmSync(mockRoot, { recursive: true, force: true });
});

it('R1: a fresh presentation-install failure retries the complete migration in order', async () => {
  const bytes = seed();
  const store = newStore();
  mockFailure = presentationPath();
  await load(store);
  // The record is imported; main's v1 file stays exact until its layout is.
  expect(fs.readFileSync(workerPath(), 'utf8')).toBe(bytes);
  expect(fs.existsSync(presentationPath())).toBe(false);
  expect(readWorker()).toEqual(expectedWorker(expectedLineage(bytes)));
  mockFailure = undefined;
  mockEvents = [];
  await load(store);
  expect(installs()).toEqual([
    'terminal-presentation.json',
    'terminal-state.json',
  ]);
  expect(readPresentation()).toEqual(
    expectedPresentation(expectedLineage(bytes)),
  );
  expect(read()).toMatchObject({ ...FENCE, lineage: expectedLineage(bytes) });
});

it.each([false, true])(
  'R2 write-first v1 migration retains geometry before fencing (install failure: %s)',
  async (installFailure) => {
    const bytes = seed();
    const store = newStore();
    if (installFailure) mockFailure = presentationPath();
    store.registerLiveSession(session('writer'));
    store.appendTerminalOutput('p', 'w', 'writer', Buffer.from('first write'));
    await settle(store);
    if (installFailure) {
      expect(fs.readFileSync(workerPath(), 'utf8')).toBe(bytes);
      mockFailure = undefined;
      await settle(store);
    }
    // A second write also retries the fence if presentation installation failed.
    store.appendTerminalOutput('p', 'w', 'writer', Buffer.from(' again'));
    await settle(store);
    expect(readPresentation()).toEqual(
      expectedPresentation(expectedLineage(bytes)),
    );
    expect(read()).toMatchObject(FENCE);
    const loaded = await load(await open());
    const expected = fixture();
    expect(loaded.groups.find((group) => group.id === 'g')).toEqual(
      expected.groups[0],
    );
    expect(loaded.groupCustomNames).toEqual(expected.groupCustomNames);
    expect(loaded.activeGroupId).toBe(expected.activeGroupId);
  },
);

it('R2: fresh worker-install failure retains exact v1 and reuses its installed layout', async () => {
  const bytes = seed();
  const store = newStore();
  mockFailure = recordPath();
  // The load still serves v1, read only: nothing refuses it.
  const served = await load(store);
  expect(served.terminals).toEqual(fixture().terminals);
  expect(fs.readFileSync(workerPath(), 'utf8')).toBe(bytes);
  expect(fs.existsSync(recordPath())).toBe(false);
  expect(readPresentation()).toEqual(
    expectedPresentation(expectedLineage(bytes)),
  );
  mockFailure = undefined;
  mockEvents = [];
  await load(store);
  expect(installs()).toEqual(['record.json', 'terminal-state.json']);
});

it('R11: quit synchronously installs a pending presentation change and cancels its debounce', async () => {
  seed();
  const store = await open();
  await settle(store);
  mockEvents = [];
  await save(store, { drawerCollapsed: true });
  expect(installs()).toEqual([]);
  store.markAllLiveTerminalsExited('app-quit');
  expect(installs()).toEqual(['terminal-presentation.json']);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(installs()).toEqual(['terminal-presentation.json']);
  expect(applies).toBe(0);
  expect((await load(await open())).drawerCollapsed).toBe(true);
});

it('R9 partial collapse survives an offline restart without replacing saved geometry or authority membership', async () => {
  seed({ ...fixture(), drawerCollapsed: true });
  const original = await open();
  await settle(original);
  const presentation = readPresentation();
  const bindings = structuredClone(readRecord().record.bindings);
  const fence = fs.readFileSync(workerPath(), 'utf8');
  up = false;
  const offline = newStore();
  const partial = await load(offline);
  expect(partial.history?.status).toBe('unavailable');
  // The toggle must differ from what is saved, or the test proves nothing.
  expect(partial.drawerCollapsed).toBe(presentation.drawerCollapsed);
  offline.saveWorktreeState({
    ...partial,
    projectId: 'p',
    worktreeId: 'w',
    drawerCollapsed: !partial.drawerCollapsed,
  });
  await offline.drainAll();
  offline.markAllLiveTerminalsExited('app-quit');
  expect(readPresentation()).toEqual({
    ...presentation,
    drawerCollapsed: !partial.drawerCollapsed,
  });
  expect(fs.readFileSync(workerPath(), 'utf8')).toBe(fence);
  up = true;
  const restarted = await load(newStore());
  expect(restarted.drawerCollapsed).toBe(!partial.drawerCollapsed);
  expect(readRecord().record.bindings).toEqual(bindings);
  expect(readPresentation().groups).toEqual(presentation.groups);
});

it('load-live merge marks both records pending without scheduling an ordinary write', async () => {
  const live = session('moved');
  const store = await open();
  store.registerLiveSession(live);
  await settle(store);
  // The same live DTO changes scope before the new scope has been cached.
  live.worktreeId = 'new';
  const state = await load(store, 'new');
  const group = state.groups[0];
  expect(state.liveTerminalIds).toEqual(['moved']);
  expect(fs.existsSync(workerPath('new'))).toBe(false);
  store.appendTerminalOutput(
    'p',
    'new',
    'moved',
    Buffer.from('load merge output'),
  );
  await settle(store);
  const restored = await load(newStore(), 'new');
  expect(restored.groups).toEqual([group]);
  expect(restored.terminals[0].scrollbackLines).toEqual(['load merge output']);
  // Content is durable now: downgrade must not create a second record.
  expect(read(workerPath('new'))).toMatchObject(FENCE);
});

it('canonical helpers keep both records together in ordinary and permanently app-managed worktree data', () => {
  const paths = jest.requireActual<typeof Paths>('../../lib/paths');
  for (const scope of ['ordinary-workspace', 'app-advisor']) {
    const expectedRoot =
      scope === 'app-advisor' ? 'app-workspaces' : 'workspaces';
    expect(paths.getWorktreeDataDir(scope, 'w')).toBe(
      join(paths.getDataDir(), expectedRoot, scope, 'worktree-data', 'w'),
    );
    expect(paths.getWorktreeTerminalStateFilePath(scope, 'w')).toBe(
      join(paths.getWorktreeDataDir(scope, 'w'), 'terminal-state.json'),
    );
    expect(paths.getWorktreeTerminalPresentationFilePath(scope, 'w')).toBe(
      join(paths.getWorktreeDataDir(scope, 'w'), 'terminal-presentation.json'),
    );
    // The authority reads the legacy file under the layout main names.
    expect(paths.getWorktreeTerminalLegacyLayout(scope)).toBe(expectedRoot);
  }
});

it('normalization preserves finite unusual sizes and optional session fields but filters foreign scope entries', async () => {
  const f = fixture();
  f.groups[0].splitSizes = [-1, 2];
  f.terminals[0].session.title = 'title';
  f.terminals.push({
    ...f.terminals[1],
    session: session('foreign', 'foreign-scope'),
  });
  seed(f);
  await settle(await open());
  expect((await load(await open())).groups[0].splitSizes).toEqual([-1, 2]);
  expect((await load(await open())).terminals).toHaveLength(2);
  expect((await load(await open())).terminals[0].session.title).toBe('title');
});

it.each(['legacy', 'split'])(
  '%s normalizes complete presentation geometry only once, matching the v1 overflow rule',
  async (source) => {
    const bytes = JSON.stringify(fixture());
    const lineage = expectedLineage(bytes);
    seed(source === 'legacy' ? bytes : expectedWorker(lineage));
    const presentation = expectedPresentation(lineage);
    presentation.groups[0].splitSizes = [Number.MAX_VALUE, Number.MAX_VALUE];
    seed(presentation, presentationPath());
    expect((await load(await open())).groups[0].splitSizes).toEqual([0, 0]);
  },
);

it('layout-only recovery keeps ungrouped history and terminal names; missing bindings append in worker order', async () => {
  seed(fixture(true));
  await settle(await open());
  const p = readPresentation();
  p.groups = [p.groups[1]];
  p.drawerCollapsed = true;
  seed(p, presentationPath());
  const record = fs.readFileSync(recordPath(), 'utf8');
  mockEvents = [];
  const restarted = await open();
  expect((await load(restarted)).groups.map((g) => g.terminalIds)).toEqual([
    ['a'],
    ['a', 'a', 'b'],
  ]);
  expect((await load(restarted)).terminals.map((t) => t.session.id)).toEqual([
    'a',
    'a',
    'b',
    'u',
  ]);
  expect((await load(restarted)).terminalCustomNames).toEqual({
    a: 'API',
    b: 'Build',
  });
  // Recovery is layout only: the record is never rewritten by a read, and
  // the repaired layout is written with the next save.
  restarted.flushAllSync();
  expect(installs()).toEqual([]);
  expect(fs.readFileSync(recordPath(), 'utf8')).toBe(record);
});

it('R1/R2: presentation failure leaves exact v1; worker failure reuses unchanged presentation', async () => {
  const bytes = seed();
  const store = newStore();
  mockFailure = presentationPath();
  await load(store);
  expect(fs.readFileSync(workerPath(), 'utf8')).toBe(bytes);
  expect(fs.existsSync(presentationPath())).toBe(false);
  // The fence is the legacy file's only write; while it fails, v1 is exact.
  mockFailure = workerPath();
  await load(store);
  expect(readPresentation()).toEqual(
    expectedPresentation(expectedLineage(bytes)),
  );
  expect(fs.readFileSync(workerPath(), 'utf8')).toBe(bytes);
  mockFailure = undefined;
  mockEvents = [];
  await load(store);
  expect(installs()).toEqual(['terminal-state.json']);
  expect(readWorker()).toEqual(expectedWorker(expectedLineage(bytes)));
  const { version, ...expected } = fixture();
  expect(version).toBe(1);
  expect(served(await load(await open()))).toEqual({
    ...expected,
    liveTerminalIds: [],
    history: AVAILABLE,
  });
});

it('R3: pending migration commits the latest names and layout before worker', async () => {
  seed();
  const store = newStore();
  mockFailure = presentationPath();
  await load(store);
  await save(store, {
    drawerCollapsed: true,
    groups: [
      {
        id: 'g',
        terminalIds: ['b', 'a'],
        focusedTerminalId: 'a',
        splitSizes: [0.6, 0.4],
      },
    ],
    terminalCustomNames: { a: 'Changed terminal' },
    groupCustomNames: { g: 'Changed group' },
  });
  mockFailure = undefined;
  mockEvents = [];
  await settle(store);
  await load(store);
  // The names reach the record before the layout that shows them, and the
  // fence lands last.
  expect(installs()).toEqual([
    'record.json',
    'terminal-presentation.json',
    'terminal-state.json',
  ]);
  expect(await load(await open())).toMatchObject({
    drawerCollapsed: true,
    groups: [
      {
        terminalIds: ['b', 'a'],
        focusedTerminalId: 'a',
        splitSizes: [0.6, 0.4],
      },
    ],
    terminalCustomNames: { a: 'Changed terminal' },
    groupCustomNames: { g: 'Changed group' },
  });
});

it('R4: registration and output during pending migration survive retry', async () => {
  seed();
  const store = newStore();
  mockFailure = presentationPath();
  await load(store);
  store.registerLiveSession(session('c'));
  store.appendTerminalOutput('p', 'w', 'c', Buffer.from('new output'));
  const group = (await load(store)).groups.find((g) =>
    g.terminalIds.includes('c'),
  );
  mockFailure = undefined;
  await settle(store);
  expect((await load(await open())).groups).toContainEqual(group);
  expect(
    (await load(await open())).terminals.find((t) => t.session.id === 'c')
      ?.scrollbackLines,
  ).toEqual(['new output']);
});

it('R5/R5b: repeated forget suppresses a live lifetime; exit clears suppression without resurrecting history', async () => {
  seed();
  const store = await open();
  store.registerLiveSession(session('a'));
  mockFailure = recordPath();
  await expect(settle(store)).rejects.toThrow(
    'Terminal record flush failed for 1 scopes.',
  );
  store.forget('a');
  store.forget('a');
  store.registerLiveSession(session('a'));
  store.appendTerminalOutput('p', 'w', 'a', Buffer.from('lost'));
  expect((await load(store)).terminals.map((t) => t.session.id)).toEqual(['b']);
  expect((await load(store)).liveTerminalIds).toEqual([]);
  mockFailure = undefined;
  await settle(store);
  expect((await load(await open())).terminals.map((t) => t.session.id)).toEqual(
    ['b'],
  );
  store.markTerminalExited('p', 'w', 'a', 0, null);
  expect((await load(store)).terminals.map((t) => t.session.id)).toEqual(['b']);
  store.registerLiveSession(session('a'));
  expect((await load(store)).liveTerminalIds).toEqual(['a']);
});

it('R6: matching partial presentation is adopted', async () => {
  const bytes = seed();
  const p = expectedPresentation(expectedLineage(bytes));
  p.drawerCollapsed = true;
  p.groups[0].paneOrder.reverse();
  p.groups[0].focusedTerminalId = 'a';
  p.groups[0].splitSizes = [0.6, 0.4];
  p.groupCustomNames.g = 'Existing layout';
  const pbytes = seed(p, presentationPath());
  const store = newStore();
  mockFailure = workerPath();
  await load(store);
  expect(fs.readFileSync(presentationPath(), 'utf8')).toBe(pbytes);
  mockFailure = undefined;
  await load(store);
  expect(read()).toMatchObject(FENCE);
  expect(await load(await open())).toMatchObject({
    drawerCollapsed: true,
    groups: [{ terminalIds: ['b', 'a'], splitSizes: [0.6, 0.4] }],
    groupCustomNames: { g: 'Existing layout' },
  });
});

it('R7: duplicate public IDs, pane occurrences and ungrouped payloads survive; output is first-match and forget removes all matches', async () => {
  seed(fixture(true));
  const store = newStore();
  const { version, ...expected } = fixture(true);
  expect(version).toBe(1);
  const layout = { ...expected, liveTerminalIds: [], history: AVAILABLE };
  expect(served(await load(store))).toEqual(layout);
  await settle(store);
  const restarted = await open();
  expect(served(await load(restarted))).toEqual(layout);
  expect(readWorker().bindings).toHaveLength(2);
  expect(readWorker().bindings[0].members.map((m) => m.key)).toEqual([
    'legacy-pane/0',
    'legacy-pane/1',
    'legacy-pane/2',
  ]);
  restarted.appendTerminalOutput('p', 'w', 'a', Buffer.from('!'));
  await settle(restarted);
  expect(
    (await load(await open())).terminals.map((t) => t.scrollbackLines),
  ).toEqual([['first-a!'], ['second-a'], ['B0'], ['ungrouped']]);
  restarted.forget('a');
  await settle(restarted);
  expect((await load(await open())).terminals.map((t) => t.session.id)).toEqual(
    ['b', 'u'],
  );
  expect((await load(await open())).groups).toEqual([
    { id: 'g', terminalIds: ['b'], focusedTerminalId: 'b', splitSizes: [1] },
  ]);
});

it('forget preserves a surviving equal-ID binding and publishes removal of an unnamed inactive occurrence', async () => {
  const f = fixture();
  f.groups = [
    { id: 'g', terminalIds: ['a'], focusedTerminalId: 'a', splitSizes: [1] },
    { id: 'g', terminalIds: ['b'], focusedTerminalId: 'b', splitSizes: [1] },
  ];
  f.groupOrdinals = {};
  f.groupCustomNames = {};
  seed(f);
  const store = await open();
  await settle(store);
  mockEvents = [];
  store.forget('a');
  await settle(store);
  expect(installs()).toEqual(['record.json', 'terminal-presentation.json']);
  expect(readWorker().bindings).toEqual([
    {
      key: 'legacy-group/1',
      groupId: 'g',
      members: [{ key: 'legacy-pane/0', terminalId: 'b' }],
    },
  ]);
  expect(readPresentation().groups).toEqual([
    {
      bindingKey: 'legacy-group/1',
      paneOrder: ['legacy-pane/0'],
      focusedTerminalId: 'b',
      splitSizes: [1],
    },
  ]);
});

it('R8: ordinary worker failure cannot publish dependent presentation', async () => {
  const store = await pair();
  const bytes = fs.readFileSync(presentationPath(), 'utf8');
  const outbox = join(mockRoot, 'terminal-record-outbox.json');
  await save(store, {
    drawerCollapsed: true,
    terminalCustomNames: { a: 'New' },
  });
  // Neither applied nor durable in main's outbox: the layout waits.
  mockFailures = [recordPath(), outbox];
  await expect(settle(store)).rejects.toThrow(
    'Terminal record flush failed for 1 scopes.',
  );
  expect(fs.readFileSync(presentationPath(), 'utf8')).toBe(bytes);
  // Durable in the outbox (q-28 (1)): the layout may land.
  mockFailures = [recordPath()];
  await expect(settle(store)).rejects.toThrow(
    'Terminal record flush failed for 1 scopes.',
  );
  expect(fs.existsSync(outbox)).toBe(true);
  expect(fs.readFileSync(presentationPath(), 'utf8')).not.toBe(bytes);
  mockFailures = [];
  mockEvents = [];
  await settle(store);
  expect(installs()).toEqual(['record.json']);
  expect(readWorker().terminalCustomNames).toEqual({ a: 'New' });
  expect(fs.existsSync(outbox)).toBe(false);
});

it('R9/R10: committed forget survives stale layout; presentation retry does not rewrite worker', async () => {
  const store = await pair();
  store.forget('a');
  mockFailure = presentationPath();
  await settle(store);
  expect((await load(await open())).terminals.map((t) => t.session.id)).toEqual(
    ['b'],
  );
  expect((await load(await open())).groups[0].terminalIds).toEqual(['b']);
  mockFailure = undefined;
  mockEvents = [];
  await settle(store);
  expect(installs()).toEqual(['terminal-presentation.json']);
});

it('R11: 100ms coalescing and synchronous quit cancel the timer', async () => {
  const store = await pair();
  store.appendTerminalOutput('p', 'w', 'a', Buffer.from('1'));
  store.appendTerminalOutput('p', 'w', 'a', Buffer.from('2'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(applies).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 120));
  // The debounce timer sent both chunks as one batch, with no drain.
  expect(applies).toBe(1);
  await settle(store);
  expect(applies).toBe(1);
  store.appendTerminalOutput('p', 'w', 'a', Buffer.from('3'));
  store.markAllLiveTerminalsExited('app-quit');
  await new Promise((resolve) => setTimeout(resolve, 150));
  // Quit sealed the pending write into the outbox; no timer sent it.
  expect(applies).toBe(1);
  await applyCustody();
  expect((await load(await open())).terminals[0].scrollbackLines).toEqual([
    'A0123',
  ]);
});

it('R12: worktree cleanup discards pending conversion and late output/exit', async () => {
  seed();
  const store = await open();
  store.registerLiveSession(session('a'));
  store.forgetWorktree('p', 'w');
  fs.rmSync(join(mockRoot, 'workspaces', 'p', 'worktree-data', 'w'), {
    recursive: true,
  });
  store.appendTerminalOutput('p', 'w', 'a', Buffer.from('late'));
  store.markTerminalExited('p', 'w', 'a', 0, null);
  await settle(store);
  expect(
    fs.existsSync(join(mockRoot, 'workspaces', 'p', 'worktree-data', 'w')),
  ).toBe(false);
  // The retired record never comes back with the late writes.
  expect(fs.existsSync(recordPath())).toBe(false);
  expect((await load(newStore())).terminals).toEqual([]);
});

it('worktree cleanup drops historical decoders before a later explicit new lifetime', async () => {
  seed();
  const store = await open();
  store.appendTerminalOutput('p', 'w', 'a', Buffer.from([0xe2]));
  store.forgetWorktree('p', 'w');
  fs.rmSync(join(mockRoot, 'workspaces', 'p', 'worktree-data', 'w'), {
    recursive: true,
  });
  await settle(store);
  store.registerLiveSession(session('a'));
  store.appendTerminalOutput('p', 'w', 'a', Buffer.from('X'));
  await settle(store);
  expect((await load(await open())).terminals[0].scrollbackLines).toEqual([
    'X',
  ]);
});

it.each([false, true])(
  'R13: partial migration rejects rewritten v1 lineage (identity change=%s)',
  async (identity) => {
    seed();
    // Imported, but its layout never landed: the legacy file is unfenced.
    mockFailure = presentationPath();
    await load(newStore());
    const changed = fixture();
    changed.drawerCollapsed = true;
    changed.groups[0].focusedTerminalId = 'a';
    changed.groups[0].splitSizes = [0.9, 0.1];
    if (identity) {
      changed.groups[0].id = 'replacement';
      changed.groups[0].terminalIds.reverse();
    }
    // An older build rewrote v1 meanwhile. The record keeps what it
    // imported (CAN-7051: the import already happened); the rewritten
    // file's layout has another lineage and is never adopted, and the fence
    // then stops further rewrites.
    const bytes = seed(changed);
    mockFailure = undefined;
    const restarted = await open();
    const state = await load(restarted);
    expect(state.groups.map((g) => [g.id, g.terminalIds])).toEqual([
      ['g', ['a', 'b']],
    ]);
    expect(state.groups[0].splitSizes).not.toEqual([0.9, 0.1]);
    expect(state.terminals).toEqual(fixture().terminals);
    await settle(restarted);
    await load(restarted);
    expect(readRecord().lineage).toBe(
      expectedLineage(JSON.stringify(fixture())),
    );
    expect(readRecord().lineage).not.toBe(expectedLineage(bytes));
    expect(read()).toMatchObject({ ...FENCE, lineage: readRecord().lineage });
  },
);

/** Two cached worktrees whose drawers both hold terminals `a` and `b`. */
function seedOther(scope: 'worktree' | 'project' = 'worktree'): void {
  seed();
  const other = fixture();
  other.terminals.forEach((t) => {
    if (scope === 'worktree') t.session.worktreeId = 'other';
    else t.session.projectId = 'other-project';
  });
  seed(
    other,
    scope === 'worktree'
      ? workerPath('other')
      : workerPath('w', 'other-project'),
  );
}

it('R14: save forget is scoped even when cached worktrees share an accepted terminal ID', async () => {
  seedOther();
  const store = await open();
  await load(store, 'other');
  await save(store, { groups: [], forgetTerminalIds: ['a', 'b'] });
  await settle(store);
  expect((await load(newStore(), 'other')).terminals).toHaveLength(2);
  store.forget('a');
  await settle(store);
  expect(
    (await load(newStore(), 'other')).terminals.map((t) => t.session.id),
  ).toEqual(['b']);
});

it.each(['save forget', 'cleanup', 'exit'])(
  'R14: %s in one worktree preserves another worktree shared-ID UTF8 stream',
  async (action) => {
    seedOther();
    const store = await open();
    store.registerLiveSession(session('a', 'other'));
    const bytes = Buffer.from('€');
    store.appendTerminalOutput('p', 'other', 'a', bytes.subarray(0, 1));
    if (action === 'save forget')
      await save(store, { groups: [], forgetTerminalIds: ['a'] });
    else if (action === 'cleanup') store.forgetWorktree('p', 'w');
    else store.markTerminalExited('p', 'w', 'a', 0, null);
    store.appendTerminalOutput('p', 'other', 'a', bytes.subarray(1));
    await settle(store);
    expect(
      (await load(newStore(), 'other')).terminals[0].scrollbackLines,
    ).toEqual(['A0€']);
  },
);

it('R14: shared-ID UTF8 streams decode independently and global forget resets both', async () => {
  seedOther();
  const store = await open();
  await load(store, 'other');
  const euro = Buffer.from('€');
  const smile = Buffer.from('😀');
  store.appendTerminalOutput('p', 'w', 'a', euro.subarray(0, 1));
  store.appendTerminalOutput('p', 'other', 'a', smile.subarray(0, 2));
  store.appendTerminalOutput('p', 'w', 'a', euro.subarray(1));
  store.appendTerminalOutput('p', 'other', 'a', smile.subarray(2));
  await settle(store);
  expect((await load(await open())).terminals[0].scrollbackLines).toEqual([
    'A0€',
  ]);
  expect(
    (await load(newStore(), 'other')).terminals[0].scrollbackLines,
  ).toEqual(['A0😀']);

  for (const worktreeId of ['w', 'other'])
    store.appendTerminalOutput('p', worktreeId, 'a', euro.subarray(0, 1));
  store.forget('a');
  for (const worktreeId of ['w', 'other']) {
    store.registerLiveSession(session('a', worktreeId));
    store.appendTerminalOutput('p', worktreeId, 'a', Buffer.from('new'));
  }
  await settle(store);
  for (const worktreeId of ['w', 'other']) {
    const entry = (await load(newStore(), worktreeId)).terminals.find(
      (t) => t.session.id === 'a',
    );
    expect(entry?.scrollbackLines).toEqual(['new']);
  }
});

it.each(['¢', '€', '😀'])(
  'R14: exit finalizes only its own incomplete %s stream and resets it for reuse',
  async (character) => {
    seedOther('project');
    const store = await open();
    await load(store, 'w', 'other-project');
    const bytes = Buffer.from(character);
    store.appendTerminalOutput('p', 'w', 'a', bytes.subarray(0, -1));
    store.appendTerminalOutput('other-project', 'w', 'a', bytes.subarray(0, 1));
    store.markTerminalExited('p', 'w', 'a', 7, 'SIGTERM');
    store.markTerminalExited('p', 'w', 'a', 7, 'SIGTERM');
    store.appendTerminalOutput('other-project', 'w', 'a', bytes.subarray(1));
    await settle(store);
    expect((await load(await open())).terminals[0]).toMatchObject({
      scrollbackLines: ['A0�'],
      exitCode: 7,
      signal: 'SIGTERM',
    });
    expect(
      (await load(newStore(), 'w', 'other-project')).terminals[0]
        .scrollbackLines,
    ).toEqual([`A0${character}`]);
    store.registerLiveSession(session('a'));
    store.appendTerminalOutput('p', 'w', 'a', Buffer.from('new'));
    await settle(store);
    expect((await load(await open())).terminals[0]).toMatchObject({
      scrollbackLines: ['A0�new'],
      exitCode: null,
      signal: null,
    });
  },
);

it('R14: repeated save forget/rebind discards forgotten bytes without disturbing a shared-ID stream', async () => {
  seedOther();
  const store = await open();
  await load(store, 'other');
  store.registerLiveSession(session('a'));
  const bytes = Buffer.from('€');
  for (let round = 1; round <= 2; round++) {
    store.appendTerminalOutput('p', 'w', 'a', bytes.subarray(0, 1));
    store.appendTerminalOutput('p', 'other', 'a', bytes.subarray(0, 2));
    await save(store, { groups: [], forgetTerminalIds: ['a', 'b'] });
    store.registerLiveSession(session('a'));
    store.appendTerminalOutput('p', 'w', 'a', Buffer.from('ignored'));
    expect((await load(store)).terminals).toEqual([]);
    await save(store, { groups: fixture().groups });
    store.appendTerminalOutput('p', 'w', 'a', Buffer.from('new'));
    store.appendTerminalOutput('p', 'other', 'a', bytes.subarray(2));
    await settle(store);
    expect((await load(await open())).terminals[0].scrollbackLines).toEqual([
      'new',
    ]);
    expect(
      (await load(newStore(), 'other')).terminals[0].scrollbackLines,
    ).toEqual([`A0${'€'.repeat(round)}`]);
  }
});

it('R15: unique-ID reorder, focus, sizes and group name write presentation only', async () => {
  const f = fixture();
  f.groups.push({
    id: 'h',
    terminalIds: ['a'],
    focusedTerminalId: 'a',
    splitSizes: [1],
  });
  seed(f);
  const store = await open();
  await settle(store);
  const record = readRecord();
  mockEvents = [];
  const groups = (await load(store)).groups;
  await save(store, {
    groups: [...groups].reverse().map((g) =>
      g.id === 'g'
        ? {
            ...g,
            terminalIds: ['b', 'a'],
            focusedTerminalId: 'a',
            splitSizes: [0.8, 0.2],
          }
        : g,
    ),
    groupCustomNames: { g: 'Layout name' },
    terminalCustomNames: { b: 'Build', a: 'API' },
  });
  await settle(store);
  expect(installs()).toEqual(['terminal-presentation.json']);
  expect(readRecord()).toEqual(record);
  expect(readWorker().terminalCustomNames).toEqual({ a: 'API', b: 'Build' });
  expect((await load(await open())).groups.map((g) => g.id)).toEqual([
    'h',
    'g',
  ]);
});

it('R16: unresolved membership/name persists transiently without manufacturing a session, normalizes away on restart (v1 oracle)', async () => {
  const store = await open();
  store.saveWorktreeState({
    ...fixture(),
    projectId: 'p',
    worktreeId: 'w',
    terminalCustomNames: { a: 'Unknown' },
  });
  // CAN-7051: membership lives in the record, which binds only terminals it
  // holds, so the unresolved groups normalize away at once instead of at
  // restart. No session is ever manufactured for them.
  expect((await load(store)).groups).toEqual([]);
  expect((await load(store)).terminals).toEqual([]);
  expect((await load(store)).terminalCustomNames).toEqual({});
  await settle(store);
  expect(await load(await open())).toMatchObject({
    groups: [],
    terminals: [],
    terminalCustomNames: {},
  });
  expect(readRecord().record.terminals).toEqual([]);
});

it.each(['worker', 'presentation'])(
  'newer %s freezes the whole pair through save/output/forget/quit',
  async (target) => {
    const bytes = seed();
    seed(expectedPresentation(expectedLineage(bytes)), presentationPath());
    seed(
      target === 'worker' ? { version: 3 } : { version: 2 },
      target === 'worker' ? workerPath() : presentationPath(),
    );
    const before = [
      fs.readFileSync(workerPath(), 'utf8'),
      fs.readFileSync(presentationPath(), 'utf8'),
    ];
    const store = await open();
    store.registerLiveSession(session('c'));
    await save(store, { drawerCollapsed: true });
    store.forget('c');
    store.appendTerminalOutput('p', 'w', 'c', Buffer.from('x'));
    await settle(store);
    store.markAllLiveTerminalsExited('app-quit');
    // A newer build's files are never written; terminals keep working and
    // the record (imported empty from a newer legacy file) holds this run.
    expect([
      fs.readFileSync(workerPath(), 'utf8'),
      fs.readFileSync(presentationPath(), 'utf8'),
    ]).toEqual(before);
    expect(installs().filter((name) => name !== 'record.json')).toEqual([]);
  },
);

it.each([true, false])(
  'the forward fence freezes an older reader (legacy existed: %s)',
  async (existed) => {
    // CAN-7051: once imported, main's legacy file is a version 3 fence. The
    // CAN-6983 reader treats any version above 2 as newer and freezes the
    // pair for the session, so a downgraded build never writes over it.
    const store = existed ? await pair() : await open();
    if (!existed) {
      store.registerLiveSession(session('fresh'));
      await settle(store);
    }
    expect(read()).toMatchObject(FENCE);
    expect(read().version).toBeGreaterThan(2);
    // The fenced file is never read as state again.
    up = false;
    const down = await load(newStore());
    expect(down.history).toEqual({
      status: 'unavailable',
      reason: 'background_service',
    });
    expect(down.terminals).toEqual([]);
    up = true;
    if (existed)
      expect((await load(store)).terminals).toEqual(fixture().terminals);
    else
      expect(
        (await load(newStore())).terminals.map((entry) => entry.session.id),
      ).toEqual(['fresh']);
  },
);

it('read EACCES freezes before damage preservation, and damaged worker with newer presentation is not renamed', async () => {
  seed('{');
  seed({ version: 2 }, presentationPath());
  await settle(await open());
  // Main never renames its damaged legacy file: the authority keeps a copy.
  expect(fs.readFileSync(workerPath(), 'utf8')).toBe('{');
  expect(
    fs
      .readdirSync(dirname(recordPath()))
      .some((n) => n.startsWith('legacy-terminal-state.json.damaged-')),
  ).toBe(true);
  // A second worktree: its presentation cannot be read, so it is frozen.
  const x = fixture();
  x.terminals = x.terminals.map((entry) => ({
    ...entry,
    session: { ...entry.session, worktreeId: 'x' },
  }));
  const bytes = seed(x, workerPath('x'));
  const originalPresentation = seed(
    expectedPresentation(expectedLineage(bytes, 'x')),
    presentationPath('x'),
  );
  mockReadFailure = presentationPath('x');
  const store = await open('x');
  expect(
    (await load(store, 'x')).terminals.map((entry) => entry.session.id),
  ).toContain('a');
  store.forget('a');
  await settle(store);
  expect(
    (await load(store, 'x')).terminals.map((entry) => entry.session.id),
  ).not.toContain('a');
  expect(
    fs
      .readdirSync(dirname(presentationPath('x')))
      .filter((n) => n.includes('damaged')),
  ).toEqual([]);
  mockReadFailure = undefined;
  expect(fs.readFileSync(presentationPath('x'), 'utf8')).toBe(
    originalPresentation,
  );
});

it.each(['{', JSON.stringify({ version: 1, terminals: [{}] })])(
  'damaged required targets are preserved before replacement: %s',
  async (bytes) => {
    seed(bytes);
    const store = await open();
    store.registerLiveSession(session('c'));
    await settle(store);
    // The damaged legacy bytes are kept beside the record, and the legacy
    // file itself is fenced over only after the copy exists.
    const directory = dirname(recordPath());
    const aside = fs
      .readdirSync(directory)
      .find((n) => n.startsWith('legacy-terminal-state.json.damaged-'));
    expect(aside).toBeDefined();
    const kept: unknown = JSON.parse(
      fs.readFileSync(join(directory, aside ?? ''), 'utf8'),
    );
    expect(
      isRecord(kept) && typeof kept.bytes === 'string'
        ? Buffer.from(kept.bytes, 'base64').toString('utf8')
        : null,
    ).toBe(bytes);
    expect(readRecord().record.terminals.map((t) => t.session.id)).toEqual([
      'c',
    ]);
  },
);

it('failed aside blocks replacement for the session and pruning failure retains evidence', async () => {
  seed('{', presentationPath());
  mockAsideFailure = true;
  const store = await open();
  await save(store, { drawerCollapsed: true });
  await settle(store);
  mockAsideFailure = false;
  await save(store, { drawerCollapsed: true });
  await settle(store);
  expect(fs.readFileSync(presentationPath(), 'utf8')).toBe('{');
  for (let i = 0; i < 6; i++) seed('old', `${presentationPath()}.damaged-${i}`);
  mockPruneFailure = true;
  const restarted = await open();
  await save(restarted, { drawerCollapsed: true });
  await settle(restarted);
  expect(
    fs
      .readdirSync(dirname(presentationPath()))
      .some(
        (n) =>
          n.includes('damaged') &&
          fs.readFileSync(join(dirname(presentationPath()), n), 'utf8') === '{',
      ),
  ).toBe(true);
});

it.each(['record.json', 'terminal-presentation.json'])(
  'recovering %s twice within a clock tick preserves both damaged copies',
  async (filename) => {
    const target =
      filename === 'record.json' ? recordPath() : presentationPath();
    const previousEvidence = `${target}.damaged-${Date.now()}`;
    seed('earlier damaged bytes', previousEvidence);
    seed('{', target);
    const store = await open();
    await save(store, { drawerCollapsed: true });
    await settle(store);
    expect(fs.readFileSync(previousEvidence, 'utf8')).toBe(
      'earlier damaged bytes',
    );
    const copies = fs
      .readdirSync(dirname(target))
      .filter((name) => name.startsWith(`${filename}.damaged-`));
    expect(copies).toHaveLength(2);
    expect(
      copies.map((name) =>
        fs.readFileSync(join(dirname(target), name), 'utf8'),
      ),
    ).toContain('{');
  },
);

it('empty v1 and final forget retain the v2 fence; absent read/quit materializes nothing', async () => {
  await settle(await open('none'));
  expect(fs.existsSync(workerPath('none'))).toBe(false);
  seed({ version: 1 }, workerPath('empty'));
  await settle(await open('empty'));
  // An empty v1 file is imported, then fenced; the record holds nothing.
  expect(read(workerPath('empty'))).toMatchObject(FENCE);
  expect(readRecord('empty').record).toEqual({
    bindings: [],
    terminals: [],
    terminalCustomNames: {},
  });
  const store = await pair();
  store.forget('a');
  store.forget('b');
  await settle(store);
  const bytes = fs.readFileSync(workerPath(), 'utf8');
  const restarted = await open();
  restarted.forget('missing');
  await settle(restarted);
  restarted.markAllLiveTerminalsExited('app-quit');
  expect(fs.readFileSync(workerPath(), 'utf8')).toBe(bytes);
  expect(readRecord().record.terminals).toEqual([]);
});

it.each(['terminal_record', 'terminal_presentation'])(
  'owner refusal for %s preflights before mkdir, rename or pruning',
  async (namespace) => {
    mockRefuse = namespace;
    const store = newStore();
    store.start();
    await load(store);
    store.registerLiveSession(session('a'));
    await save(store, { drawerCollapsed: true });
    if (namespace === 'terminal_record')
      await expect(settle(store)).rejects.toThrow(
        'Terminal record flush failed for 1 scopes.',
      );
    else await settle(store);
    // A refused writer creates nothing; a refused record defers its batch
    // to main's outbox instead, and the layout waits for a known lineage.
    expect(fs.existsSync(join(mockRoot, 'workspaces'))).toBe(false);
    expect(fs.existsSync(join(mockRoot, 'terminal-records'))).toBe(
      namespace !== 'terminal_record',
    );
    mockRefuse = undefined;
    await settle(store);
    expect((await load(newStore())).terminals.map((t) => t.session.id)).toEqual(
      ['a'],
    );
  },
);

it.each(['absent', 'damaged', 'mismatched'])(
  'Fdup worker truth survives %s presentation without grouping ungrouped history',
  async (mode) => {
    seed(fixture(true));
    await settle(await open());
    if (mode === 'absent') fs.unlinkSync(presentationPath());
    if (mode === 'damaged') seed('{', presentationPath());
    if (mode === 'mismatched') {
      const p = readPresentation();
      p.lineage = 'other';
      seed(p, presentationPath());
    }
    const state = await load(await open());
    expect(state.terminals.map((t) => t.scrollbackLines)).toEqual([
      ['first-a'],
      ['second-a'],
      ['B0'],
      ['ungrouped'],
    ]);
    expect(state.groups.map((g) => g.terminalIds)).toEqual([
      ['a', 'a', 'b'],
      ['a'],
    ]);
  },
);

it('internal worker key collisions damage the record; presentation repeats/stale keys reconcile deterministically', async () => {
  await pair();
  const p = readPresentation();
  p.groups[0].paneOrder = ['legacy-pane/1', 'legacy-pane/1', 'stale'];
  p.groups.push(p.groups[0]);
  seed(p, presentationPath());
  expect((await load(await open())).groups[0]).toMatchObject({
    terminalIds: ['b', 'a'],
    splitSizes: [0.5, 0.5],
  });
  // A record whose bindings collide is damaged: set aside, never parsed
  // again, and the scope starts from its fence, empty.
  const envelope = readRecord();
  envelope.record.bindings.push(envelope.record.bindings[0]);
  seed(envelope, recordPath());
  authority = newAuthority();
  const store = await open();
  expect((await load(store)).terminals).toEqual([]);
  await settle(store);
  expect(
    fs
      .readdirSync(dirname(recordPath()))
      .some((n) => n.startsWith('record.json.damaged-')),
  ).toBe(true);
  expect(readRecord().record.terminals).toEqual([]);
});

it('a layout save keeps the ungrouped history it omits', async () => {
  seed(fixture(true));
  const store = await open();
  await save(store, { drawerCollapsed: true });
  await settle(store);
  expect(
    (await load(await open())).terminals.find((t) => t.session.id === 'u')
      ?.scrollbackLines,
  ).toEqual(['ungrouped']);
});

it('a stale snapshot that omits a grouped live terminal keeps its history and name', async () => {
  seed();
  const store = await open();
  store.registerLiveSession(session('a'));
  await save(store, {
    groups: [
      { id: 'g', terminalIds: ['b'], focusedTerminalId: 'b', splitSizes: [1] },
    ],
    terminalCustomNames: {},
  });
  expect((await load(store)).liveTerminalIds).toEqual(['a']);
  await settle(store);
  const restarted = await load(await open());
  expect(
    restarted.terminals.find((t) => t.session.id === 'a')?.scrollbackLines,
  ).toEqual(['A0']);
  // The omitted terminal keeps its name; the listed one takes the request's clear.
  expect(restarted.terminalCustomNames).toEqual({ a: 'API' });
});

it('terminal:save-worktree-state forgets only its forgetTerminalIds history; explicit rebind clears live suppression', async () => {
  seed(fixture(true));
  const store = await open();
  store.registerLiveSession(session('a'));
  await save(store, { groups: [], forgetTerminalIds: ['a', 'u'] });
  expect((await load(store)).terminals.map((t) => t.session.id)).toEqual(['b']);
  expect((await load(store)).liveTerminalIds).toEqual([]);
  await save(store, { groups: fixture().groups });
  expect((await load(store)).terminals.map((t) => t.session.id)).toEqual([
    'b',
    'a',
  ]);
  expect((await load(store)).liveTerminalIds).toEqual(['a']);
});

it('a terminal still listed in groups ignores its forgetTerminalIds entry', async () => {
  seed();
  const store = await open();
  store.registerLiveSession(session('a'));
  await save(store, { forgetTerminalIds: ['a'] });
  expect((await load(store)).liveTerminalIds).toEqual(['a']);
  await settle(store);
  const restarted = await load(await open());
  expect(
    restarted.terminals.find((t) => t.session.id === 'a')?.scrollbackLines,
  ).toEqual(['A0']);
  expect(restarted.terminalCustomNames.a).toBe('API');
});

it('UTF8 streaming, decoder finalization, 5000 lines and shutdown signal precedence survive the quit seal', async () => {
  const store = await pair();
  store.registerLiveSession(session('a'));
  const bytes = Buffer.from('€');
  store.appendTerminalOutput('p', 'w', 'a', bytes.subarray(0, 1));
  store.appendTerminalOutput('p', 'w', 'a', bytes.subarray(1));
  expect((await load(store)).terminals[0].scrollbackLines).toEqual(['A0€']);
  store.appendTerminalOutput(
    'p',
    'w',
    'a',
    Buffer.from('\n'.repeat(5001) + 'last'),
  );
  store.appendTerminalOutput('p', 'w', 'a', Buffer.from([0xe2]));
  store.markAllLiveTerminalsExited('app-quit');
  store.markTerminalExited('p', 'w', 'a', 9, 'SIGKILL');
  await applyCustody();
  const entry = (await load(await open())).terminals[0];
  expect(entry.scrollbackLines).toHaveLength(5000);
  expect(entry.scrollbackLines.at(-1)).toBe('last�');
  expect(entry.signal).toBe('app-quit');
  expect(entry.exitCode).toBeNull();
});

it('eligible default/shell/script registration and background focus preserve current behavior', async () => {
  const store = await open();
  store.registerLiveSession({ ...session('ignored'), kind: 'claude-code' });
  expect((await load(store)).terminals).toEqual([]);
  store.registerLiveSession({ ...session('script'), kind: 'script' });
  expect((await load(store)).activeGroupId).toBeNull();
  store.registerLiveSession({ ...session('shell'), kind: 'shell' });
  const active = (await load(store)).activeGroupId;
  store.registerLiveSession({ ...session('background'), kind: 'script' });
  expect((await load(store)).activeGroupId).toBe(active);
  store.registerLiveSession({
    ...session('focus'),
    kind: 'script',
    focusOnSpawn: true,
  });
  const state = await load(store);
  expect(
    state.groups.find((g) => g.id === state.activeGroupId)?.terminalIds,
  ).toEqual(['focus']);
});

describe('real process termination around the real atomic writer', () => {
  let runner: string;
  let preload: string;
  beforeEach(async () => {
    runner = join(mockRoot, 'runner.cjs');
    preload = join(mockRoot, 'preload.mjs');
    await build({
      entryPoints: [
        resolve(__dirname, 'fixtures/terminal-persistence-crash.ts'),
      ],
      outfile: preload,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      logLevel: 'silent',
    });
    await build({
      entryPoints: [
        resolve(__dirname, 'fixtures/terminal-persistence-child.ts'),
      ],
      outfile: runner,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      logLevel: 'silent',
      plugins: [
        {
          name: 'desktop-host-leaves',
          setup(builder): void {
            builder.onResolve(
              {
                filter:
                  /^(\.\.\/lib\/(paths|main-process-logging|workspace-persistence|cowork-work-entries-file)|\.\/(record-client|main-process-logging))$/,
              },
              () => ({
                path: resolve(
                  __dirname,
                  'fixtures/terminal-persistence-host.ts',
                ),
              }),
            );
          },
        },
      ],
    });
  });
  function crash(point: string, forget = false, pendingImport = false): void {
    const result = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(preload).href, runner],
      {
        env: {
          ...process.env,
          TERMINAL_TEST_ROOT: mockRoot,
          TERMINAL_CRASH_POINT: point,
          TERMINAL_FORGET: forget ? '1' : '0',
          TERMINAL_PENDING_IMPORT: pendingImport ? '1' : '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    expect({
      status: result.status,
      error: result.error?.message,
      stderr: result.stderr,
    }).toEqual({ status: 73, error: undefined, stderr: '' });
    // A forgetting child crashed only after it reached the forget.
    const reached = join(mockRoot, 'forget-reached');
    expect(fs.existsSync(reached)).toBe(forget);
    if (pendingImport)
      expect(fs.readFileSync(reached, 'utf8')).toBe('pending-unfenced-v1');
    fs.rmSync(reached, { force: true });
    // The child ran its own authority: this daemon starts again from disk.
    authority = newAuthority();
  }
  it('RF6 quit during held v1 import seals custody and recovers geometry, history and exit exactly once', async () => {
    const bytes = seed();
    const result = spawnSync(process.execPath, [runner], {
      env: {
        ...process.env,
        TERMINAL_TEST_ROOT: mockRoot,
        TERMINAL_PENDING_IMPORT: '1',
        TERMINAL_QUIT_PENDING: '1',
      },
      encoding: 'utf8',
      timeout: 15000,
    });
    expect({
      status: result.status,
      error: result.error?.message,
      stderr: result.stderr,
    }).toEqual({ status: 0, error: undefined, stderr: '' });
    expect(fs.readFileSync(join(mockRoot, 'quit-reached'), 'utf8')).toBe(
      'pending-unfenced-v1',
    );
    expect(fs.readFileSync(workerPath(), 'utf8')).toBe(bytes);
    const custody = (await new TerminalRecordOutbox(() => mockRoot).read())
      .outbox;
    expect(
      custody.scopes
        .flatMap((scope) => scope.entries)
        .some(
          (entry) =>
            entry.sealed?.reason === 'app-quit' &&
            entry.ops.some(
              (op) =>
                op.op === 'exit' &&
                op.terminalId === 'a' &&
                op.signal === 'app-quit',
            ),
        ),
    ).toBe(true);
    authority = newAuthority();
    await applyCustody();
    const next = await open();
    await settle(next);
    for (const current of [next, await open()]) {
      const restored = await load(current);
      expect(restored.groups).toEqual(fixture().groups);
      expect(restored.groupCustomNames).toEqual(fixture().groupCustomNames);
      expect(restored.drawerCollapsed).toBe(fixture().drawerCollapsed);
      expect(restored.liveTerminalIds).toEqual([]);
      expect(
        restored.terminals.find((entry) => entry.session.id === 'a'),
      ).toMatchObject({
        scrollbackLines: ['A0-quit-once'],
        signal: 'app-quit',
        exitCode: null,
      });
      expect(
        restored.terminals.find((entry) => entry.session.id === 'b')
          ?.scrollbackLines,
      ).toEqual(['B0']);
    }
  });
  it.each([
    'temp-write',
    'before-record',
    'after-record',
    'before-presentation',
    'after-presentation',
    'before-worker',
    'after-worker',
  ])(
    'migration crashes at %s, then restarts from targets only',
    async (point) => {
      const bytes = seed();
      crash(point);
      // Main's v1 file is exact until its fence is installed, the last step.
      expect(read().version).toBe(point === 'after-worker' ? 3 : 1);
      if (point !== 'after-worker')
        expect(fs.readFileSync(workerPath(), 'utf8')).toBe(bytes);
      const store = await open();
      await settle(store);
      expect(readWorker()).toEqual(expectedWorker(expectedLineage(bytes)));
      expect(read()).toMatchObject({
        ...FENCE,
        lineage: expectedLineage(bytes),
      });
      expect((await load(await open())).terminals).toEqual(fixture().terminals);
      expect(readPresentation()).toEqual(
        expectedPresentation(expectedLineage(bytes)),
      );
    },
  );
  it('pending migration forget may be lost before the worker boundary; old-v1 rewrite invalidates lineage', async () => {
    seed();
    crash('before-record', true, true);
    expect(
      (await load(await open())).terminals.map((t) => t.session.id),
    ).toEqual(['a', 'b']);
    // Imported now; a later rewrite of the fenced file by an older build is
    // never read again.
    const changed = fixture();
    changed.drawerCollapsed = true;
    changed.groups[0].terminalIds.reverse();
    seed(changed);
    const store = await open();
    expect((await load(store)).drawerCollapsed).toBe(false);
    expect((await load(store)).groups[0].terminalIds).toEqual(['a', 'b']);
    await settle(store);
  });
  it('pending migration forget installed before the crash survives it', async () => {
    seed();
    crash('after-record', true, true);
    expect(
      (await load(await open())).terminals.map((t) => t.session.id),
    ).toEqual(['b']);
  });
  it.each(['before-record', 'after-record', 'after-presentation'])(
    'ordinary forget crash at %s respects the installed worker truth',
    async (point) => {
      await pair();
      crash(point, true);
      const state = await load(await open());
      expect(state.terminals.map((t) => t.session.id)).toEqual(
        point === 'before-record' ? ['a', 'b'] : ['b'],
      );
    },
  );
});
it('RF7 duplicate legacy IDs keep first-occurrence restore metadata with its output', async () => {
  const legacy = fixture(true);
  legacy.terminals[0].signal = 'app-quit';
  legacy.terminals[1].signal = 'SIGTERM';
  legacy.terminals[1].session.cwd = '/wrong-occurrence';
  seed(legacy);
  const s = newStore();
  await s.loadWorktreeState('p', 'w');
  const release = await s.prefetchPersistedEntry('a');
  try {
    expect(s.getPersistedTerminalEntry('a')).toMatchObject({
      scrollbackLines: ['first-a'],
      signal: 'app-quit',
      session: { cwd: '/workspace' },
    });
  } finally {
    release();
  }
});
