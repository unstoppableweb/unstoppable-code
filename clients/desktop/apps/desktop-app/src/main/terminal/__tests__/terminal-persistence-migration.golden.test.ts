import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type * as Storage from '@canopy/core-runtime/storage';
import type { SaveWorktreeTerminalStateRequest } from '@canopy/desktop-shared/types';
import type * as Paths from '../../lib/paths';
import { isRecord } from '../../lib/type-guards';
import {
  isWorkerFile,
  isPresentationFile,
  type TerminalRecords,
} from '../persistence-codec';
import { TerminalPersistenceStore } from '../persistence';
import { fixture, session } from './fixtures/terminal-persistence';

let mockRoot: string;
let mockFailure: string | undefined;
let mockReadFailure: string | undefined;
let mockAsideFailure = false;
let mockPruneFailure = false;
let mockRefuse: string | undefined;
let mockEvents: string[] = [];
jest.mock('../../lib/paths', () => ({
  getWorktreeTerminalStateFilePath: (p: string, w: string): string =>
    join(mockRoot, p, w, 'terminal-state.json'),
  getWorktreeTerminalPresentationFilePath: (p: string, w: string): string =>
    join(mockRoot, p, w, 'terminal-presentation.json'),
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
              ? {
                  ...row,
                  transitionOwner: 'offline',
                }
              : row,
          )
        : actual.STORAGE_OWNERSHIP;
    },
  };
});
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
      if (String(to).includes('.damaged-')) {
        if (mockAsideFailure)
          throw Object.assign(new Error('aside blocked'), { code: 'EIO' });
      } else if (String(from).endsWith('.tmp')) {
        mockEvents.push(`attempt:${basename(String(to))}`);
        if (String(to) === mockFailure)
          throw Object.assign(new Error('install blocked'), { code: 'EIO' });
      }
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

const workerPath = (w = 'w'): string =>
  join(mockRoot, 'p', w, 'terminal-state.json');
const presentationPath = (w = 'w'): string =>
  join(mockRoot, 'p', w, 'terminal-presentation.json');
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
function readWorker(): TerminalRecords['worker'] {
  const value = read();
  if (!isWorkerFile(value)) throw new Error('Expected worker v2');
  return value;
}
function readPresentation(): TerminalRecords['presentation'] {
  const value = read(presentationPath());
  if (!isPresentationFile(value)) throw new Error('Expected presentation v1');
  return value;
}
function load(
  store: TerminalPersistenceStore,
): ReturnType<TerminalPersistenceStore['loadWorktreeState']> {
  return store.loadWorktreeState('p', 'w');
}
function save(
  store: TerminalPersistenceStore,
  patch: Partial<SaveWorktreeTerminalStateRequest> = {},
): void {
  store.saveWorktreeState({
    ...load(store),
    projectId: 'p',
    worktreeId: 'w',
    ...patch,
  });
}
function open(): TerminalPersistenceStore {
  const store = new TerminalPersistenceStore();
  load(store);
  return store;
}
function installs(): string[] {
  return mockEvents
    .filter((event) => event.startsWith('installed:'))
    .map((event) => event.slice(10));
}
function pair(): TerminalPersistenceStore {
  seed();
  const store = open();
  store.flushAllSync();
  mockEvents = [];
  return store;
}
function expectedLineage(bytes: string): string {
  return `legacy/${createHash('sha256')
    .update(JSON.stringify(['p', 'w', Buffer.from(bytes).toString('base64')]))
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

it('R1: a fresh presentation-install failure retries the complete migration in order', () => {
  const bytes = seed();
  const store = open();
  mockFailure = presentationPath();
  store.flushAllSync();
  expect(fs.readFileSync(workerPath(), 'utf8')).toBe(bytes);
  expect(fs.existsSync(presentationPath())).toBe(false);
  mockFailure = undefined;
  mockEvents = [];
  store.flushAllSync();
  expect(installs()).toEqual([
    'terminal-presentation.json',
    'terminal-state.json',
  ]);
  expect(read()).toEqual(expectedWorker(expectedLineage(bytes)));
});

it('R2: fresh worker-install failure retains exact v1 and reuses its installed layout', () => {
  const bytes = seed();
  const store = open();
  mockFailure = workerPath();
  store.flushAllSync();
  expect(fs.readFileSync(workerPath(), 'utf8')).toBe(bytes);
  expect(read(presentationPath())).toEqual(
    expectedPresentation(expectedLineage(bytes)),
  );
  mockFailure = undefined;
  mockEvents = [];
  store.flushAllSync();
  expect(installs()).toEqual(['terminal-state.json']);
});

it('R11: quit synchronously installs pending v1 conversion and cancels its debounce', () => {
  seed();
  const store = open();
  save(store, { drawerCollapsed: true });
  jest.advanceTimersByTime(99);
  expect(installs()).toEqual([]);
  store.flushAllSync();
  expect(installs()).toEqual([
    'terminal-presentation.json',
    'terminal-state.json',
  ]);
  jest.advanceTimersByTime(100);
  expect(installs()).toHaveLength(2);
  expect(load(open()).drawerCollapsed).toBe(true);
});

it('load-live merge marks both records pending without scheduling an ordinary write', () => {
  const live = session('moved');
  const store = open();
  store.registerLiveSession(live);
  store.flushAllSync();
  // The same live DTO changes scope before the new scope has been cached.
  live.worktreeId = 'new';
  const state = store.loadWorktreeState('p', 'new');
  const group = state.groups[0];
  expect(state.liveTerminalIds).toEqual(['moved']);
  expect(fs.existsSync(workerPath('new'))).toBe(false);
  store.appendTerminalOutput(
    'p',
    'new',
    'moved',
    Buffer.from('load merge output'),
  );
  store.flushAllSync();
  const restored = new TerminalPersistenceStore().loadWorktreeState('p', 'new');
  expect(restored.groups).toEqual([group]);
  expect(restored.terminals[0].scrollbackLines).toEqual(['load merge output']);
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
  }
});

it('normalization preserves finite unusual sizes and optional session fields but filters foreign scope entries', () => {
  const f = fixture();
  f.groups[0].splitSizes = [-1, 2];
  f.terminals[0].session.title = 'title';
  f.terminals.push({
    ...f.terminals[1],
    session: session('foreign', 'foreign-scope'),
  });
  seed(f);
  const store = open();
  store.flushAllSync();
  expect(load(open()).groups[0].splitSizes).toEqual([-1, 2]);
  expect(load(open()).terminals).toHaveLength(2);
  expect(load(open()).terminals[0].session.title).toBe('title');
});

it.each(['legacy', 'split'])(
  '%s normalizes complete presentation geometry only once, matching the v1 overflow rule',
  (source) => {
    const bytes = JSON.stringify(fixture());
    const lineage = expectedLineage(bytes);
    seed(source === 'legacy' ? bytes : expectedWorker(lineage));
    const presentation = expectedPresentation(lineage);
    presentation.groups[0].splitSizes = [Number.MAX_VALUE, Number.MAX_VALUE];
    seed(presentation, presentationPath());
    expect(load(open()).groups[0].splitSizes).toEqual([0, 0]);
  },
);

it('layout-only recovery keeps ungrouped history and terminal names; missing bindings append in worker order', () => {
  seed(fixture(true));
  const store = open();
  store.flushAllSync();
  const p = readPresentation();
  p.groups = [p.groups[1]];
  p.drawerCollapsed = true;
  seed(p, presentationPath());
  const restarted = open();
  expect(load(restarted).groups.map((g) => g.terminalIds)).toEqual([
    ['a'],
    ['a', 'a', 'b'],
  ]);
  expect(load(restarted).terminals.map((t) => t.session.id)).toEqual([
    'a',
    'a',
    'b',
    'u',
  ]);
  expect(load(restarted).terminalCustomNames).toEqual({ a: 'API', b: 'Build' });
  mockEvents = [];
  restarted.flushAllSync();
  expect(installs()).toEqual(['terminal-presentation.json']);
});

beforeEach(() => {
  mockRoot = fs.mkdtempSync(join(tmpdir(), 'terminal-pair-'));
  mockFailure = undefined;
  mockReadFailure = undefined;
  mockAsideFailure = false;
  mockPruneFailure = false;
  mockRefuse = undefined;
  mockEvents = [];
  jest.useFakeTimers();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  fs.rmSync(mockRoot, { recursive: true, force: true });
});

it('R1/R2: presentation failure leaves exact v1; worker failure reuses unchanged presentation', () => {
  const bytes = seed();
  const store = open();
  mockFailure = presentationPath();
  store.flushAllSync();
  expect(fs.readFileSync(workerPath(), 'utf8')).toBe(bytes);
  expect(fs.existsSync(presentationPath())).toBe(false);
  mockFailure = workerPath();
  store.flushAllSync();
  expect(read(presentationPath())).toEqual(
    expectedPresentation(expectedLineage(bytes)),
  );
  expect(fs.readFileSync(workerPath(), 'utf8')).toBe(bytes);
  mockFailure = undefined;
  mockEvents = [];
  store.flushAllSync();
  expect(installs()).toEqual(['terminal-state.json']);
  expect(read()).toEqual(expectedWorker(expectedLineage(bytes)));
  const { version, ...expected } = fixture();
  expect(version).toBe(1);
  expect(load(open())).toEqual({ ...expected, liveTerminalIds: [] });
});

it('R3: pending migration commits the latest names and layout before worker', () => {
  seed();
  const store = open();
  mockFailure = workerPath();
  store.flushAllSync();
  save(store, {
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
  store.flushAllSync();
  expect(installs()).toEqual([
    'terminal-presentation.json',
    'terminal-state.json',
  ]);
  expect(load(open())).toMatchObject({
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

it('R4: registration and output during pending migration survive retry', () => {
  seed();
  const store = open();
  mockFailure = workerPath();
  store.flushAllSync();
  store.registerLiveSession(session('c'));
  store.appendTerminalOutput('p', 'w', 'c', Buffer.from('new output'));
  const group = load(store).groups.find((g) => g.terminalIds.includes('c'));
  mockFailure = undefined;
  store.flushAllSync();
  expect(load(open()).groups).toContainEqual(group);
  expect(
    load(open()).terminals.find((t) => t.session.id === 'c')?.scrollbackLines,
  ).toEqual(['new output']);
});

it('R5/R5b: repeated forget suppresses a live lifetime; exit clears suppression without resurrecting history', () => {
  seed();
  const store = open();
  store.registerLiveSession(session('a'));
  mockFailure = workerPath();
  store.flushAllSync();
  store.forget('a');
  store.forget('a');
  store.registerLiveSession(session('a'));
  store.appendTerminalOutput('p', 'w', 'a', Buffer.from('lost'));
  expect(load(store).terminals.map((t) => t.session.id)).toEqual(['b']);
  expect(load(store).liveTerminalIds).toEqual([]);
  mockFailure = undefined;
  store.flushAllSync();
  expect(load(open()).terminals.map((t) => t.session.id)).toEqual(['b']);
  store.markTerminalExited('p', 'w', 'a', 0, null);
  expect(load(store).terminals.map((t) => t.session.id)).toEqual(['b']);
  store.registerLiveSession(session('a'));
  expect(load(store).liveTerminalIds).toEqual(['a']);
});

it('R6: matching partial presentation is adopted', () => {
  const bytes = seed();
  const p = expectedPresentation(expectedLineage(bytes));
  p.drawerCollapsed = true;
  p.groups[0].paneOrder.reverse();
  p.groups[0].focusedTerminalId = 'a';
  p.groups[0].splitSizes = [0.6, 0.4];
  p.groupCustomNames.g = 'Existing layout';
  const pbytes = seed(p, presentationPath());
  const store = open();
  mockFailure = workerPath();
  store.flushAllSync();
  expect(fs.readFileSync(presentationPath(), 'utf8')).toBe(pbytes);
  mockFailure = undefined;
  store.flushAllSync();
  expect(load(open())).toMatchObject({
    drawerCollapsed: true,
    groups: [{ terminalIds: ['b', 'a'], splitSizes: [0.6, 0.4] }],
    groupCustomNames: { g: 'Existing layout' },
  });
});

it('R7: duplicate public IDs, pane occurrences and ungrouped payloads survive; output is first-match and forget removes all matches', () => {
  seed(fixture(true));
  const store = open();
  const { version, ...expected } = fixture(true);
  expect(version).toBe(1);
  expect(load(store)).toEqual({ ...expected, liveTerminalIds: [] });
  store.flushAllSync();
  const restarted = open();
  expect(load(restarted)).toEqual({ ...expected, liveTerminalIds: [] });
  expect(readWorker().bindings).toHaveLength(2);
  expect(readWorker().bindings[0].members.map((m) => m.key)).toEqual([
    'legacy-pane/0',
    'legacy-pane/1',
    'legacy-pane/2',
  ]);
  restarted.appendTerminalOutput('p', 'w', 'a', Buffer.from('!'));
  restarted.flushAllSync();
  expect(load(open()).terminals.map((t) => t.scrollbackLines)).toEqual([
    ['first-a!'],
    ['second-a'],
    ['B0'],
    ['ungrouped'],
  ]);
  restarted.forget('a');
  restarted.flushAllSync();
  expect(load(open()).terminals.map((t) => t.session.id)).toEqual(['b', 'u']);
  expect(load(open()).groups).toEqual([
    { id: 'g', terminalIds: ['b'], focusedTerminalId: 'b', splitSizes: [1] },
  ]);
});

it('forget preserves a surviving equal-ID binding and publishes removal of an unnamed inactive occurrence', () => {
  const f = fixture();
  f.groups = [
    { id: 'g', terminalIds: ['a'], focusedTerminalId: 'a', splitSizes: [1] },
    { id: 'g', terminalIds: ['b'], focusedTerminalId: 'b', splitSizes: [1] },
  ];
  f.groupOrdinals = {};
  f.groupCustomNames = {};
  seed(f);
  const store = open();
  store.flushAllSync();
  mockEvents = [];
  store.forget('a');
  store.flushAllSync();
  expect(installs()).toEqual([
    'terminal-state.json',
    'terminal-presentation.json',
  ]);
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

it('R8: ordinary worker failure cannot publish dependent presentation', () => {
  const store = pair();
  const bytes = fs.readFileSync(presentationPath(), 'utf8');
  save(store, { drawerCollapsed: true, terminalCustomNames: { a: 'New' } });
  mockFailure = workerPath();
  store.flushAllSync();
  expect(fs.readFileSync(presentationPath(), 'utf8')).toBe(bytes);
  mockFailure = undefined;
  mockEvents = [];
  store.flushAllSync();
  expect(installs()).toEqual([
    'terminal-state.json',
    'terminal-presentation.json',
  ]);
});

it('R9/R10: committed forget survives stale layout; presentation retry does not rewrite worker', () => {
  const store = pair();
  store.forget('a');
  mockFailure = presentationPath();
  store.flushAllSync();
  expect(load(open()).terminals.map((t) => t.session.id)).toEqual(['b']);
  expect(load(open()).groups[0].terminalIds).toEqual(['b']);
  mockFailure = undefined;
  mockEvents = [];
  store.flushAllSync();
  expect(installs()).toEqual(['terminal-presentation.json']);
});

it('R11: 100ms coalescing and synchronous quit cancel the timer', () => {
  const store = pair();
  store.appendTerminalOutput('p', 'w', 'a', Buffer.from('1'));
  store.appendTerminalOutput('p', 'w', 'a', Buffer.from('2'));
  jest.advanceTimersByTime(99);
  expect(installs()).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(installs()).toEqual(['terminal-state.json']);
  store.appendTerminalOutput('p', 'w', 'a', Buffer.from('3'));
  store.flushAllSync();
  const count = installs().length;
  jest.advanceTimersByTime(100);
  expect(installs()).toHaveLength(count);
  expect(load(open()).terminals[0].scrollbackLines).toEqual(['A0123']);
});

it('R12: worktree cleanup discards pending conversion and late output/exit', () => {
  seed();
  const store = open();
  store.registerLiveSession(session('a'));
  store.forgetWorktree('p', 'w');
  fs.rmSync(join(mockRoot, 'p/w'), { recursive: true });
  store.appendTerminalOutput('p', 'w', 'a', Buffer.from('late'));
  store.markTerminalExited('p', 'w', 'a', 0, null);
  jest.advanceTimersByTime(100);
  store.flushAllSync();
  expect(fs.existsSync(join(mockRoot, 'p/w'))).toBe(false);
});

it('worktree cleanup drops historical decoders before a later explicit new lifetime', () => {
  seed();
  const store = open();
  store.appendTerminalOutput('p', 'w', 'a', Buffer.from([0xe2]));
  store.forgetWorktree('p', 'w');
  fs.rmSync(join(mockRoot, 'p/w'), { recursive: true });
  store.registerLiveSession(session('a'));
  store.appendTerminalOutput('p', 'w', 'a', Buffer.from('X'));
  store.flushAllSync();
  expect(load(open()).terminals[0].scrollbackLines).toEqual(['X']);
});

it.each([false, true])(
  'R13: partial migration rejects rewritten v1 lineage (identity change=%s)',
  (identity) => {
    seed();
    const store = open();
    mockFailure = workerPath();
    store.flushAllSync();
    const changed = fixture();
    changed.drawerCollapsed = true;
    changed.groups[0].focusedTerminalId = 'a';
    if (identity) {
      changed.groups[0].id = 'replacement';
      changed.groups[0].terminalIds.reverse();
    }
    const bytes = seed(changed);
    mockFailure = undefined;
    const restarted = open();
    expect(load(restarted).drawerCollapsed).toBe(true);
    expect(load(restarted).groups[0]).toEqual(changed.groups[0]);
    restarted.flushAllSync();
    expect(read().lineage).toBe(expectedLineage(bytes));
    expect(read(presentationPath()).lineage).toBe(expectedLineage(bytes));
  },
);

it('R14: omission is scoped even when cached worktrees share an accepted terminal ID', () => {
  seed();
  const other = fixture();
  other.terminals.forEach((t) => {
    t.session.worktreeId = 'other';
  });
  seed(other, workerPath('other'));
  const store = open();
  store.loadWorktreeState('p', 'other');
  save(store, { groups: [] });
  store.flushAllSync();
  expect(
    new TerminalPersistenceStore().loadWorktreeState('p', 'other').terminals,
  ).toHaveLength(2);
  store.forget('a');
  store.flushAllSync();
  expect(
    new TerminalPersistenceStore()
      .loadWorktreeState('p', 'other')
      .terminals.map((t) => t.session.id),
  ).toEqual(['b']);
});

it.each(['omission', 'cleanup', 'exit'])(
  'R14: %s in one worktree preserves another worktree shared-ID UTF8 stream',
  (action) => {
    seed();
    const other = fixture();
    other.terminals.forEach((t) => {
      t.session.worktreeId = 'other';
    });
    seed(other, workerPath('other'));
    const store = open();
    store.registerLiveSession(session('a', 'other'));
    const bytes = Buffer.from('€');
    store.appendTerminalOutput('p', 'other', 'a', bytes.subarray(0, 1));
    if (action === 'omission') save(store, { groups: [] });
    else if (action === 'cleanup') store.forgetWorktree('p', 'w');
    else store.markTerminalExited('p', 'w', 'a', 0, null);
    store.appendTerminalOutput('p', 'other', 'a', bytes.subarray(1));
    store.flushAllSync();
    expect(
      new TerminalPersistenceStore().loadWorktreeState('p', 'other')
        .terminals[0].scrollbackLines,
    ).toEqual(['A0€']);
  },
);

it('R14: shared-ID UTF8 streams decode independently and global forget resets both', () => {
  seed();
  const other = fixture();
  other.terminals.forEach((t) => {
    t.session.worktreeId = 'other';
  });
  seed(other, workerPath('other'));
  const store = open();
  store.loadWorktreeState('p', 'other');
  const euro = Buffer.from('€');
  const smile = Buffer.from('😀');
  store.appendTerminalOutput('p', 'w', 'a', euro.subarray(0, 1));
  store.appendTerminalOutput('p', 'other', 'a', smile.subarray(0, 2));
  store.appendTerminalOutput('p', 'w', 'a', euro.subarray(1));
  store.appendTerminalOutput('p', 'other', 'a', smile.subarray(2));
  store.flushAllSync();
  expect(load(open()).terminals[0].scrollbackLines).toEqual(['A0€']);
  expect(
    new TerminalPersistenceStore().loadWorktreeState('p', 'other').terminals[0]
      .scrollbackLines,
  ).toEqual(['A0😀']);

  for (const worktreeId of ['w', 'other'])
    store.appendTerminalOutput('p', worktreeId, 'a', euro.subarray(0, 1));
  store.forget('a');
  for (const worktreeId of ['w', 'other']) {
    store.registerLiveSession(session('a', worktreeId));
    store.appendTerminalOutput('p', worktreeId, 'a', Buffer.from('new'));
  }
  store.flushAllSync();
  for (const worktreeId of ['w', 'other']) {
    const entry = new TerminalPersistenceStore()
      .loadWorktreeState('p', worktreeId)
      .terminals.find((t) => t.session.id === 'a');
    expect(entry?.scrollbackLines).toEqual(['new']);
  }
});

it.each(['¢', '€', '😀'])(
  'R14: exit finalizes only its own incomplete %s stream and resets it for reuse',
  (character) => {
    seed();
    const other = fixture();
    other.terminals.forEach((t) => {
      t.session.projectId = 'other-project';
    });
    seed(other, join(mockRoot, 'other-project', 'w', 'terminal-state.json'));
    const store = open();
    store.loadWorktreeState('other-project', 'w');
    const bytes = Buffer.from(character);
    store.appendTerminalOutput('p', 'w', 'a', bytes.subarray(0, -1));
    store.appendTerminalOutput('other-project', 'w', 'a', bytes.subarray(0, 1));
    store.markTerminalExited('p', 'w', 'a', 7, 'SIGTERM');
    store.markTerminalExited('p', 'w', 'a', 7, 'SIGTERM');
    store.appendTerminalOutput('other-project', 'w', 'a', bytes.subarray(1));
    store.flushAllSync();
    expect(load(open()).terminals[0]).toMatchObject({
      scrollbackLines: ['A0�'],
      exitCode: 7,
      signal: 'SIGTERM',
    });
    expect(
      new TerminalPersistenceStore().loadWorktreeState('other-project', 'w')
        .terminals[0].scrollbackLines,
    ).toEqual([`A0${character}`]);
    store.registerLiveSession(session('a'));
    store.appendTerminalOutput('p', 'w', 'a', Buffer.from('new'));
    store.flushAllSync();
    expect(load(open()).terminals[0]).toMatchObject({
      scrollbackLines: ['A0�new'],
      exitCode: null,
      signal: null,
    });
  },
);

it('R14: repeated omission/rebind discards forgotten bytes without disturbing a shared-ID stream', () => {
  seed();
  const other = fixture();
  other.terminals.forEach((t) => {
    t.session.worktreeId = 'other';
  });
  seed(other, workerPath('other'));
  const store = open();
  store.loadWorktreeState('p', 'other');
  store.registerLiveSession(session('a'));
  const bytes = Buffer.from('€');
  for (let round = 1; round <= 2; round++) {
    store.appendTerminalOutput('p', 'w', 'a', bytes.subarray(0, 1));
    store.appendTerminalOutput('p', 'other', 'a', bytes.subarray(0, 2));
    save(store, { groups: [] });
    store.registerLiveSession(session('a'));
    store.appendTerminalOutput('p', 'w', 'a', Buffer.from('ignored'));
    expect(load(store).terminals).toEqual([]);
    save(store, { groups: fixture().groups });
    store.appendTerminalOutput('p', 'w', 'a', Buffer.from('new'));
    store.appendTerminalOutput('p', 'other', 'a', bytes.subarray(2));
    store.flushAllSync();
    expect(load(open()).terminals[0].scrollbackLines).toEqual(['new']);
    expect(
      new TerminalPersistenceStore().loadWorktreeState('p', 'other')
        .terminals[0].scrollbackLines,
    ).toEqual([`A0${'€'.repeat(round)}`]);
  }
});

it('R15: unique-ID reorder, focus, sizes and group name write presentation only', () => {
  const f = fixture();
  f.groups.push({
    id: 'h',
    terminalIds: ['a'],
    focusedTerminalId: 'a',
    splitSizes: [1],
  });
  seed(f);
  const store = open();
  store.flushAllSync();
  mockEvents = [];
  save(store, {
    groups: [...load(store).groups].reverse().map((g) =>
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
  });
  store.flushAllSync();
  expect(installs()).toEqual(['terminal-presentation.json']);
  expect(read().terminalCustomNames).toEqual({ a: 'API', b: 'Build' });
  expect(load(open()).groups.map((g) => g.id)).toEqual(['h', 'g']);
});

it('R16: unresolved membership/name persists transiently without manufacturing a session, normalizes away on restart (v1 oracle)', () => {
  const store = open();
  store.saveWorktreeState({
    ...fixture(),
    projectId: 'p',
    worktreeId: 'w',
    terminalCustomNames: { a: 'Unknown' },
  });
  expect(load(store).groups).toEqual(fixture().groups);
  expect(load(store).terminals).toEqual([]);
  expect(load(store).terminalCustomNames).toEqual({ a: 'Unknown' });
  store.flushAllSync();
  expect(load(open())).toMatchObject({
    groups: [],
    terminals: [],
    terminalCustomNames: {},
  });
});

it.each(['worker', 'presentation'])(
  'newer %s freezes the whole pair through save/output/forget/quit',
  (target) => {
    const bytes = seed();
    const p = seed(
      expectedPresentation(expectedLineage(bytes)),
      presentationPath(),
    );
    seed(
      target === 'worker' ? { version: 3 } : { version: 2 },
      target === 'worker' ? workerPath() : presentationPath(),
    );
    const before = [
      fs.readFileSync(workerPath(), 'utf8'),
      fs.readFileSync(presentationPath(), 'utf8'),
    ];
    const store = open();
    store.registerLiveSession(session('c'));
    save(store, { drawerCollapsed: true });
    store.forget('c');
    store.appendTerminalOutput('p', 'w', 'c', Buffer.from('x'));
    store.flushAllSync();
    expect([
      fs.readFileSync(workerPath(), 'utf8'),
      fs.readFileSync(presentationPath(), 'utf8'),
    ]).toEqual(before);
    expect(installs()).toEqual([]);
    expect(p).toBeTruthy();
  },
);

it('read EACCES freezes before damage preservation, and damaged worker with newer presentation is not renamed', () => {
  seed('{');
  seed({ version: 2 }, presentationPath());
  open().flushAllSync();
  expect(fs.readFileSync(workerPath(), 'utf8')).toBe('{');
  seed(fixture());
  mockReadFailure = presentationPath();
  const store = open();
  store.forget('a');
  store.flushAllSync();
  expect(
    fs.readdirSync(dirname(workerPath())).filter((n) => n.includes('damaged')),
  ).toEqual([]);
  expect(read().version).toBe(1);
});

it.each(['{', JSON.stringify({ version: 1, terminals: [{}] })])(
  'damaged required targets are preserved before replacement: %s',
  (bytes) => {
    seed(bytes);
    const store = open();
    store.registerLiveSession(session('c'));
    store.flushAllSync();
    const aside = fs
      .readdirSync(dirname(workerPath()))
      .find((n) => n.startsWith('terminal-state.json.damaged-'));
    expect(aside).toBeDefined();
    expect(
      fs.readFileSync(join(dirname(workerPath()), aside ?? ''), 'utf8'),
    ).toBe(bytes);
    expect(read().version).toBe(2);
  },
);

it('failed aside blocks replacement for the session and pruning failure retains evidence', () => {
  seed('{');
  mockAsideFailure = true;
  const store = open();
  store.registerLiveSession(session('c'));
  store.flushAllSync();
  mockAsideFailure = false;
  store.flushAllSync();
  expect(fs.readFileSync(workerPath(), 'utf8')).toBe('{');
  for (let i = 0; i < 6; i++) seed('old', `${workerPath()}.damaged-${i}`);
  mockPruneFailure = true;
  const restarted = open();
  restarted.registerLiveSession(session('c'));
  restarted.flushAllSync();
  expect(
    fs
      .readdirSync(dirname(workerPath()))
      .some(
        (n) =>
          n.includes('damaged') &&
          fs.readFileSync(join(dirname(workerPath()), n), 'utf8') === '{',
      ),
  ).toBe(true);
});

it.each(['terminal-state.json', 'terminal-presentation.json'])(
  'recovering %s twice within a clock tick preserves both damaged copies',
  (filename) => {
    const target = join(dirname(workerPath()), filename);
    const previousEvidence = `${target}.damaged-${Date.now()}`;
    seed('earlier damaged bytes', previousEvidence);
    seed('{', target);
    open().flushAllSync();
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

it('empty v1 and final forget retain the v2 fence; absent read/quit materializes nothing', () => {
  open().flushAllSync();
  expect(fs.existsSync(workerPath())).toBe(false);
  seed({ version: 1 });
  open().flushAllSync();
  expect(read()).toMatchObject({ version: 2, terminals: [], bindings: [] });
  const store = pair();
  store.forget('a');
  store.forget('b');
  store.flushAllSync();
  const bytes = fs.readFileSync(workerPath(), 'utf8');
  const restarted = open();
  restarted.forget('missing');
  restarted.flushAllSync();
  expect(fs.readFileSync(workerPath(), 'utf8')).toBe(bytes);
});

it.each(['terminal_state', 'terminal_presentation'])(
  'owner refusal for %s preflights both rows before mkdir, rename or pruning',
  (namespace) => {
    seed('{');
    const store = open();
    store.registerLiveSession(session('a'));
    mockRefuse = namespace;
    store.flushAllSync();
    expect(fs.readdirSync(dirname(workerPath()))).toEqual([
      'terminal-state.json',
    ]);
    expect(fs.readFileSync(workerPath(), 'utf8')).toBe('{');
    fs.rmSync(join(mockRoot, 'p'), { recursive: true });
    const fresh = new TerminalPersistenceStore();
    fresh.registerLiveSession(session('z'));
    fresh.flushAllSync();
    expect(fs.existsSync(join(mockRoot, 'p'))).toBe(false);
  },
);

it.each(['absent', 'damaged', 'mismatched'])(
  'Fdup worker truth survives %s presentation without grouping ungrouped history',
  (mode) => {
    seed(fixture(true));
    open().flushAllSync();
    if (mode === 'absent') fs.unlinkSync(presentationPath());
    if (mode === 'damaged') seed('{', presentationPath());
    if (mode === 'mismatched') {
      const p = readPresentation();
      p.lineage = 'other';
      seed(p, presentationPath());
    }
    const state = load(open());
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

it('internal worker key collisions damage the record; presentation repeats/stale keys reconcile deterministically', () => {
  pair();
  const p = readPresentation();
  p.groups[0].paneOrder = ['legacy-pane/1', 'legacy-pane/1', 'stale'];
  p.groups.push(p.groups[0]);
  seed(p, presentationPath());
  expect(load(open()).groups[0]).toMatchObject({
    terminalIds: ['b', 'a'],
    splitSizes: [0.5, 0.5],
  });
  const w = readWorker();
  w.bindings.push(w.bindings[0]);
  seed(w);
  const store = open();
  expect(load(store).terminals).toEqual([]);
  store.flushAllSync();
  expect(read().terminals).toEqual([]);
});

it('all-cached omission forgets ungrouped history; explicit rebind clears live suppression', () => {
  seed(fixture(true));
  const store = open();
  store.registerLiveSession(session('a'));
  save(store, { groups: [] });
  expect(load(store).terminals).toEqual([]);
  save(store, { groups: fixture().groups });
  expect(load(store).terminals.map((t) => t.session.id)).toEqual(['a']);
  expect(load(store).liveTerminalIds).toEqual(['a']);
});

it('UTF8 streaming, decoder finalization, 5000 lines and shutdown signal precedence survive restart', () => {
  const store = pair();
  store.registerLiveSession(session('a'));
  const bytes = Buffer.from('€');
  store.appendTerminalOutput('p', 'w', 'a', bytes.subarray(0, 1));
  store.appendTerminalOutput('p', 'w', 'a', bytes.subarray(1));
  expect(load(store).terminals[0].scrollbackLines).toEqual(['A0€']);
  store.appendTerminalOutput(
    'p',
    'w',
    'a',
    Buffer.from('\n'.repeat(5001) + 'last'),
  );
  store.appendTerminalOutput('p', 'w', 'a', Buffer.from([0xe2]));
  store.markAllLiveTerminalsExited('app-quit');
  store.markTerminalExited('p', 'w', 'a', 9, 'SIGKILL');
  store.flushAllSync();
  const entry = load(open()).terminals[0];
  expect(entry.scrollbackLines).toHaveLength(5000);
  expect(entry.scrollbackLines.at(-1)).toBe('last�');
  expect(entry.signal).toBe('app-quit');
  expect(entry.exitCode).toBeNull();
});

it('eligible default/shell/script registration and background focus preserve current behavior', () => {
  const store = open();
  store.registerLiveSession({ ...session('ignored'), kind: 'claude-code' });
  expect(load(store).terminals).toEqual([]);
  store.registerLiveSession({ ...session('script'), kind: 'script' });
  expect(load(store).activeGroupId).toBeNull();
  store.registerLiveSession({ ...session('shell'), kind: 'shell' });
  const active = load(store).activeGroupId;
  store.registerLiveSession({ ...session('background'), kind: 'script' });
  expect(load(store).activeGroupId).toBe(active);
  store.registerLiveSession({
    ...session('focus'),
    kind: 'script',
    focusOnSpawn: true,
  });
  expect(
    load(store).groups.find((g) => g.id === load(store).activeGroupId)
      ?.terminalIds,
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
              { filter: /^\.\.\/lib\/(paths|main-process-logging)$/ },
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
  function crash(point: string, forget = false): void {
    const result = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(preload).href, runner],
      {
        env: {
          ...process.env,
          TERMINAL_TEST_ROOT: mockRoot,
          TERMINAL_CRASH_POINT: point,
          TERMINAL_FORGET: forget ? '1' : '0',
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
  }
  it.each([
    'temp-write',
    'before-presentation',
    'after-presentation',
    'before-worker',
    'after-worker',
  ])('migration crashes at %s, then restarts from targets only', (point) => {
    const bytes = seed();
    crash(point);
    expect(read().version).toBe(point === 'after-worker' ? 2 : 1);
    if (point !== 'after-worker')
      expect(fs.readFileSync(workerPath(), 'utf8')).toBe(bytes);
    const store = open();
    store.flushAllSync();
    expect(read()).toEqual(expectedWorker(expectedLineage(bytes)));
    expect(load(open()).terminals).toEqual(fixture().terminals);
  });
  it('pending migration forget may be lost before the worker boundary; old-v1 rewrite invalidates lineage', () => {
    seed();
    crash('before-worker', true);
    expect(load(open()).terminals.map((t) => t.session.id)).toEqual(['a', 'b']);
    const changed = fixture();
    changed.drawerCollapsed = true;
    changed.groups[0].terminalIds.reverse();
    seed(changed);
    const store = open();
    expect(load(store).drawerCollapsed).toBe(true);
    expect(load(store).groups[0].terminalIds).toEqual(['b', 'a']);
    store.flushAllSync();
  });
  it.each(['before-worker', 'after-worker', 'after-presentation'])(
    'ordinary forget crash at %s respects the installed worker truth',
    (point) => {
      pair();
      crash(point, true);
      const state = load(open());
      expect(state.terminals.map((t) => t.session.id)).toEqual(
        point === 'before-worker' ? ['a', 'b'] : ['b'],
      );
    },
  );
});
