// CAN-4070 rule: captured on the unchanged `workspace-items:*` note and prompt
// IPC handlers before CAN-4152 routed them through `core.workspace.item.*`.
// Real data root, real stores and the real workspace registry; only handler
// registration, the native dialog and publication scheduling are mocked.
// Deliberate changes are pinned in
// workspace-items-ipc-changes.test.ts, not here.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  APP_ADVISOR_PROJECT_ID,
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type WorkspaceType,
} from '@canopy/desktop-shared/types';

// Jest runs tests in a separate realm, so built-in fs errors fail the
// production `instanceof Error` checks. Rethrow them as same-realm errors with
// the same fields, which is what Electron main sees.
jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<Record<string, unknown>>('node:fs/promises');
  const sameRealm = (error: unknown): unknown =>
    typeof error === 'object' && error !== null && !(error instanceof Error)
      ? Object.assign(new Error(String(Reflect.get(error, 'message'))), error)
      : error;
  const wrapped = Object.fromEntries(
    [
      'copyFile',
      'lstat',
      'mkdir',
      'open',
      'readFile',
      'readdir',
      'realpath',
      'rename',
      'rm',
      'stat',
      'writeFile',
    ].map((name) => {
      const original = actual[name];
      if (typeof original !== 'function') throw new Error(name);
      return [
        name,
        async (...args: unknown[]): Promise<unknown> => {
          try {
            return await Reflect.apply(original, actual, args);
          } catch (error) {
            throw sameRealm(error);
          }
        },
      ];
    }),
  );
  return { ...actual, ...wrapped };
});

jest.mock('electron', () => ({
  dialog: {
    showOpenDialog: (): Promise<{ canceled: boolean; filePaths: string[] }> =>
      Promise.resolve({ canceled: true, filePaths: [] }),
  },
  BrowserWindow: { fromWebContents: (): null => null },
}));

const mockHandlers = new Map<
  string,
  (event: unknown, request: unknown) => Promise<unknown>
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, request: unknown) => Promise<unknown>,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));
const mockPublished: string[] = [];
jest.mock('../shared-containers/publish/scheduler', () => ({
  getSharedContainerPublishScheduler: (): {
    scheduleWorkspace: (projectId: string) => Promise<void>;
  } => ({
    scheduleWorkspace: (projectId: string): Promise<void> => {
      mockPublished.push(projectId);
      return Promise.resolve();
    },
  }),
}));

import { registerWorkspaceItemHandlers } from '../ipc/workspace-items';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import { setDesktopCanopyRuntime } from '../canopy-runtime/desktop-runtime-access';
import {
  coworkMigrationMapTestExports,
  writeCoworkMigrationMap,
} from '../lib/cowork-migration-map';
import { writeSharedContainerFileScope } from '../shared-containers/file-scope-store';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { getAppAdvisorHomeDir, getWorkspaceHomeDir } from '../lib/paths';

jest.setTimeout(30_000);

let dir: string;
let dataDir: string;
let originalDataDir: string | undefined;

let runtime: DesktopCanopyDispatcher | null = null;
const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.workspace.read'],
};

function registerHandlers(): void {
  runtime = createDesktopRuntime();
  setDesktopCanopyRuntime(runtime);
  registerWorkspaceItemHandlers({
    dispatcher: runtime,
    resolveCaller: (): CanopyCallerDescriptor => caller,
  });
}

async function closeHandlers(): Promise<void> {
  setDesktopCanopyRuntime(null);
  await runtime?.shutdown();
}

const WORKSPACE_TYPES: ReadonlyArray<[string, WorkspaceType]> = [
  ['code-ws', 'single-repo'],
  ['multi-ws', 'multi-repo'],
  ['cowork-ws', 'cowork'],
  ['legacy-chat', 'cowork'],
];

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-items-golden-')));
  dataDir = join(dir, 'data');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  registerHandlers();
});

afterAll(async () => {
  await closeHandlers();
  coworkMigrationMapTestExports.resetCache();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  registerWorkspaceTypes(new Map(WORKSPACE_TYPES));
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  coworkMigrationMapTestExports.resetCache();
  // The legacy chat-project id `legacy-chat` migrated to `cowork-ws`.
  await writeCoworkMigrationMap({ 'legacy-chat': 'cowork-ws' });
  mockPublished.length = 0;
});

function scrub(value: string): string {
  return value.split(dir).join('<root>');
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/**
 * Seeded index times use January 2020 and seeded file modification times
 * February 2020, so both stay in snapshots. File creation times cannot be
 * seeded portably (macOS moves them back with the modification time, Linux
 * does not), so every other time is replaced.
 */
const SEEDED_INDEX_TIME = '2020-01-';
const SEEDED_FILE_TIME = '2020-02-';

function isSeededTime(key: string, value: string): boolean {
  return (
    value.startsWith(SEEDED_INDEX_TIME) ||
    (key === 'updatedAt' && value.startsWith(SEEDED_FILE_TIME))
  );
}

/** Host paths scrubbed and live times checked, then replaced. */
function describeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(describeValue);
  if (typeof value === 'string') return scrub(value);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      (key === 'createdAt' || key === 'updatedAt') &&
      typeof child === 'string' &&
      ISO.test(child) &&
      !isSeededTime(key, child)
        ? '<time>'
        : describeValue(child),
    ]),
  );
}

function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { thrown: String(error) };
  const code: unknown = 'code' in error ? error.code : undefined;
  return {
    name: error.name,
    // Cowork reads open and stat the file in parallel, so a missing file
    // reports whichever call fails first.
    message: scrub(error.message).replace(
      /^ENOENT: no such file or directory, (?:open|stat) /,
      'ENOENT: no such file or directory, <open or stat> ',
    ),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

/** Callers as Electron main sees them; the unchanged handlers ignore them. */
const CALLERS: ReadonlyArray<[string, Partial<IpcMainInvokeEvent>]> = [
  ['local renderer', {}],
  [
    'remote device through the desktop bridge',
    { sender: { id: 7 } } as Partial<IpcMainInvokeEvent>,
  ],
  ['untracked sender', { sender: { id: 99 } } as Partial<IpcMainInvokeEvent>],
];

async function call(
  channel: string,
  request: unknown,
  event: Partial<IpcMainInvokeEvent> = {},
): Promise<unknown> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  return handler(event, request);
}

async function ipc(
  channel: string,
  request: unknown,
  event: Partial<IpcMainInvokeEvent> = {},
): Promise<Record<string, unknown>> {
  try {
    return { result: describeValue(await call(channel, request, event)) };
  } catch (error) {
    return { error: describeError(error) };
  }
}

type Kind = 'note' | 'prompt';
interface KindChannels {
  list: string;
  read: string;
  save: string;
  delete: string;
  idKey: 'noteId' | 'promptId';
  folder: 'notes' | 'prompts';
}
const CHANNELS: Record<Kind, KindChannels> = {
  note: {
    list: IPC_CHANNELS.workspaceNotesList,
    read: IPC_CHANNELS.workspaceNotesRead,
    save: IPC_CHANNELS.workspaceNotesSave,
    delete: IPC_CHANNELS.workspaceNotesDelete,
    idKey: 'noteId',
    folder: 'notes',
  },
  prompt: {
    list: IPC_CHANNELS.workspacePromptsList,
    read: IPC_CHANNELS.workspacePromptsRead,
    save: IPC_CHANNELS.workspacePromptsSave,
    delete: IPC_CHANNELS.workspacePromptsDelete,
    idKey: 'promptId',
    folder: 'prompts',
  },
};
const KINDS: Kind[] = ['note', 'prompt'];

function ops(kind: Kind): {
  list: (
    projectId: unknown,
    extra?: object,
  ) => Promise<Record<string, unknown>>;
  read: (
    projectId: unknown,
    id: unknown,
    extra?: object,
  ) => Promise<Record<string, unknown>>;
  save: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
  remove: (projectId: unknown, id: unknown) => Promise<Record<string, unknown>>;
  idKey: KindChannels['idKey'];
} {
  const channels = CHANNELS[kind];
  return {
    list: (projectId, extra = {}) =>
      ipc(channels.list, { projectId, ...extra }),
    read: (projectId, id, extra = {}) =>
      ipc(channels.read, { projectId, [channels.idKey]: id, ...extra }),
    save: (request) => ipc(channels.save, request),
    remove: (projectId, id) =>
      ipc(channels.delete, { projectId, [channels.idKey]: id }),
    idKey: channels.idKey,
  };
}

/** The store folder a layout uses for a kind. */
function storeDir(projectId: string, kind: Kind): string {
  const folder = CHANNELS[kind].folder;
  if (projectId === APP_ADVISOR_PROJECT_ID) {
    return getCoworkManagedSubdir(getAppAdvisorHomeDir(), folder);
  }
  if (projectId === 'legacy-chat') {
    return getCoworkManagedSubdir(getWorkspaceHomeDir('cowork-ws'), folder);
  }
  if (projectId === 'cowork-ws' || projectId === STANDALONE_CHAT_PROJECT_ID) {
    return getCoworkManagedSubdir(getWorkspaceHomeDir(projectId), folder);
  }
  return join(dataDir, 'workspaces', projectId, folder);
}

/**
 * Every notes, prompts and shared-container selection file under the data
 * root, with live times in JSON files replaced.
 */
function storeFiles(): Record<string, unknown> {
  const files: Record<string, unknown> = {};
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      const name = relative(dataDir, path).split(sep);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const inStore = name.includes('notes') || name.includes('prompts');
      if (!inStore && entry.name !== 'share-file-scope.json') continue;
      let content: unknown;
      try {
        content = readFileSync(path, 'utf8');
      } catch (error) {
        content = describeError(error);
      }
      if (typeof content === 'string' && entry.name.endsWith('.json')) {
        try {
          content = describeValue(JSON.parse(content));
        } catch {
          // Keep malformed JSON as text.
        }
      }
      files[name.join('/')] = content;
    }
  };
  walk(dataDir);
  return files;
}

async function flush(): Promise<void> {
  // Cowork saves schedule publication through a dynamic import.
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function published(): Promise<string[]> {
  await flush();
  return [...mockPublished];
}

function writeWorktrees(
  workspaceId: string,
  rows: ReadonlyArray<[string, string]>,
): void {
  const workspaceDir = join(dataDir, 'workspaces', workspaceId);
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(workspaceDir, 'worktrees.json'),
    JSON.stringify({
      version: 1,
      worktrees: rows.map(([id, branchName]) => ({
        id,
        branchName,
        createdAt: '2020-01-01T00:00:00.000Z',
      })),
    }),
  );
}

/** A file with a fixed 2020 modification time. */
function seed(path: string, content: string, day = 1): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  const time = new Date(`2020-02-${String(day).padStart(2, '0')}T00:00:00Z`);
  utimesSync(path, time, time);
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

/**
 * A code list sorted by id, for snapshots whose saves can share a
 * millisecond: equal `updatedAt` values keep the directory order.
 */
function byId(listed: Record<string, unknown>): Record<string, unknown> {
  const result: unknown = listed.result;
  if (!Array.isArray(result)) return listed;
  const items: unknown[] = Array.from(result);
  return {
    result: items.sort((a, b) =>
      String(field(a, 'id')).localeCompare(String(field(b, 'id'))),
    ),
  };
}

const LAYOUTS: ReadonlyArray<[string, string]> = [
  ['single-repo', 'code-ws'],
  ['multi-repo', 'multi-ws'],
  ['cowork', 'cowork-ws'],
  ['App Advisor', APP_ADVISOR_PROJECT_ID],
  ['standalone chat sentinel', STANDALONE_CHAT_PROJECT_ID],
  ['legacy chat-project alias', 'legacy-chat'],
  ['unregistered workspace', 'ghost-ws'],
];

const ROUND_TRIPS = LAYOUTS.flatMap(([layout, projectId]) =>
  KINDS.map((kind): [string, string, string, Kind] => [
    kind,
    layout,
    projectId,
    kind,
  ]),
);

describe('CAN-4152 workspace items IPC golden: layouts', () => {
  it.each(ROUND_TRIPS)(
    'creates, edits, renames and deletes a %s in a %s workspace',
    async (_name, _layout, projectId, kind) => {
      const { list, read, save, remove, idKey } = ops(kind);
      writeWorktrees(projectId, [['wt-1', 'feature/one']]);
      const created = await save({
        projectId,
        title: 'Release checklist',
        content: '# Release checklist\n- ship it\n',
        originWorktreeId: 'wt-1',
      });
      const listedAfterCreate = await list(projectId);
      const readAfterCreate = await read(projectId, 'release-checklist');
      const filesAfterCreate = storeFiles();
      const edited = await save({
        projectId,
        [idKey]: 'release-checklist',
        title: 'Release checklist',
        content: '# Release checklist\n- ship it\n- tag it\n',
      });
      const renamed = await save({
        projectId,
        [idKey]: 'release-checklist',
        title: 'Ship list',
        content: '# Shipping\n- done\n',
      });
      const listedAfterRename = await list(projectId);
      const readOld = await read(projectId, 'release-checklist');
      const readNew = await read(projectId, 'ship-list');
      const filesAfterRename = storeFiles();
      const deleted = await remove(projectId, 'ship-list');
      const listedAfterDelete = await list(projectId);
      // A code delete of a missing item no longer publishes (deliberate,
      // pinned in workspace-items-ipc-changes.test.ts), so publication is
      // captured before it.
      const publishedBeforeDeleteAgain = await published();
      const deletedAgain = await remove(projectId, 'ship-list');
      expect({
        created,
        listedAfterCreate,
        readAfterCreate,
        filesAfterCreate,
        edited,
        renamed,
        listedAfterRename,
        readOld,
        readNew,
        filesAfterRename,
        deleted,
        listedAfterDelete,
        deletedAgain,
        filesAfterDelete: storeFiles(),
        published: publishedBeforeDeleteAgain,
      }).toMatchSnapshot();
    },
  );

  it.each(KINDS)(
    'lists an empty or missing %s store as empty in every layout',
    async (kind) => {
      const { list } = ops(kind);
      mkdirSync(storeDir('code-ws', kind), { recursive: true });
      const results: Record<string, unknown> = {};
      for (const [layout, projectId] of LAYOUTS) {
        results[layout] = await list(projectId);
      }
      expect(results).toMatchSnapshot();
      expect(storeFiles()).toEqual({});
    },
  );

  it.each(KINDS)(
    'keeps createdAt and advances updatedAt across a code %s edit',
    async (kind) => {
      const channels = CHANNELS[kind];
      const created = await call(channels.save, {
        projectId: 'code-ws',
        title: 'Timed',
        content: 'one',
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const edited = await call(channels.save, {
        projectId: 'code-ws',
        [channels.idKey]: 'timed',
        title: 'Timed',
        content: 'two',
      });
      const createdAt = field(created, 'createdAt');
      const updatedAt = field(edited, 'updatedAt');
      expect(typeof createdAt === 'string' && ISO.test(createdAt)).toBe(true);
      expect(field(edited, 'createdAt')).toBe(createdAt);
      expect(field(created, 'updatedAt')).toBe(createdAt);
      expect(
        typeof updatedAt === 'string' && updatedAt > String(createdAt),
      ).toBe(true);
    },
  );
});

describe('CAN-4152 workspace items IPC golden: code index repair', () => {
  function seedCodeStore(kind: Kind): string {
    const store = storeDir('code-ws', kind);
    const body = (title: string): string =>
      kind === 'note'
        ? `# ${title}\nbody of ${title}\n`
        : `---\ntitle: ${JSON.stringify(title)}\ntags: [user-tag]\n---\nbody of ${title}\n`;
    seed(join(store, 'kept.md'), body('Kept heading'), 1);
    seed(join(store, 'bad-times.md'), body('Bad times heading'), 2);
    seed(join(store, 'orphan-origin.md'), body('Orphan heading'), 3);
    seed(join(store, 'no-snapshot.md'), body('No snapshot heading'), 4);
    seed(join(store, 'broken.md'), body('Broken heading'), 5);
    seed(join(store, 'hand-dropped.md'), body('Dropped heading'), 6);
    seed(join(store, 'plain-file.md'), 'no heading here\n', 7);
    seed(join(store, '.hidden.md'), body('Hidden heading'), 8);
    seed(join(store, '.md'), body('Nameless heading'), 9);
    seed(join(store, 'notes.txt'), 'not markdown', 10);
    seed(join(store, 'folder', 'inner.md'), body('Inner heading'), 11);
    writeFileSync(
      join(store, 'index.json'),
      JSON.stringify({
        version: 1,
        items: {
          kept: {
            id: 'kept',
            filename: 'kept.md',
            title: 'Kept title',
            createdAt: '2020-01-01T00:00:00.000Z',
            updatedAt: '2020-01-03T00:00:00.000Z',
            originWorktreeId: 'wt-1',
            originBranchName: 'old-branch',
          },
          gone: {
            id: 'gone',
            filename: 'gone.md',
            title: 'Gone title',
            createdAt: '2020-01-01T00:00:00.000Z',
            updatedAt: '2020-01-09T00:00:00.000Z',
          },
          'bad-times': {
            id: 'bad-times',
            filename: 'bad-times.md',
            title: 'Bad times title',
            createdAt: 'not-a-date',
            updatedAt: 'yesterday',
          },
          'orphan-origin': {
            id: 'orphan-origin',
            filename: 'orphan-origin.md',
            title: 'Orphan title',
            createdAt: '2020-01-01T00:00:00.000Z',
            updatedAt: '2020-01-02T00:00:00.000Z',
            originWorktreeId: 'wt-deleted',
            originBranchName: 'feature/old',
          },
          'no-snapshot': {
            id: 'no-snapshot',
            filename: 'no-snapshot.md',
            title: 'No snapshot title',
            createdAt: '2020-01-01T00:00:00.000Z',
            updatedAt: '2020-01-04T00:00:00.000Z',
            originWorktreeId: 'wt-deleted',
          },
          broken: { id: 'broken', title: 'Missing fields' },
        },
      }),
    );
    writeWorktrees('code-ws', [['wt-1', 'feature/renamed']]);
    return store;
  }

  it.each(KINDS)(
    'adopts, drops and refreshes %s index entries on list',
    async (kind) => {
      const { list, read } = ops(kind);
      seedCodeStore(kind);
      const filesBefore = storeFiles();
      const listed = await list('code-ws');
      const filesAfterList = storeFiles();
      const listedAgain = await list('code-ws');
      expect(listedAgain).toEqual(listed);
      expect(storeFiles()).toEqual(filesAfterList);
      expect({
        filesBefore,
        listed,
        filesAfterList,
        readIndexed: await read('code-ws', 'kept'),
        readBadTimes: await read('code-ws', 'bad-times'),
        readAdopted: await read('code-ws', 'hand-dropped'),
        readPlain: await read('code-ws', 'plain-file'),
        readHidden: await read('code-ws', '.hidden'),
        readNested: await read('code-ws', 'folder'),
      }).toMatchSnapshot();
    },
  );

  it.each(KINDS)(
    'reads an unindexed %s before any list without touching the index',
    async (kind) => {
      const { read } = ops(kind);
      const store = storeDir('code-ws', kind);
      seed(
        join(store, 'fresh-drop.md'),
        kind === 'note'
          ? '# Fresh heading\nbody\n'
          : '---\ntitle: Fresh\n---\nbody\n',
      );
      expect({
        read: await read('code-ws', 'fresh-drop'),
        files: storeFiles(),
      }).toMatchSnapshot();
    },
  );

  it.each(KINDS)(
    'lists %s files when the index cannot be read or written',
    async (kind) => {
      const { list } = ops(kind);
      const store = storeDir('code-ws', kind);
      seed(join(store, 'first.md'), '# First\n', 1);
      seed(join(store, 'second.md'), '# Second\n', 2);
      mkdirSync(join(store, 'index.json'));
      expect(await list('code-ws')).toMatchSnapshot();
    },
  );

  it.each(KINDS)(
    'keeps code %s order newest first by the indexed updatedAt',
    async (kind) => {
      const { list } = ops(kind);
      const store = storeDir('code-ws', kind);
      const entries = [
        ['b-middle', '2020-03-02T00:00:00.000Z'],
        ['a-oldest', '2020-03-01T00:00:00.000Z'],
        ['c-newest', '2020-03-03T00:00:00.000Z'],
        // Equal times keep the directory order, which ext4 does not sort, so
        // ties are not pinned.
        ['d-between', '2020-03-02T12:00:00.000Z'],
      ];
      for (const [id] of entries) seed(join(store, `${id}.md`), `# ${id}\n`);
      writeFileSync(
        join(store, 'index.json'),
        JSON.stringify({
          version: 1,
          items: Object.fromEntries(
            entries.map(([id, updatedAt]) => [
              id,
              {
                id,
                filename: `${id}.md`,
                title: id,
                createdAt: '2020-01-01T00:00:00.000Z',
                updatedAt,
              },
            ]),
          ),
        }),
      );
      const listed = await list('code-ws');
      expect(
        (Array.isArray(listed.result) ? listed.result : []).map(
          (item: unknown) => field(item, 'id'),
        ),
      ).toMatchSnapshot();
    },
  );

  const unreadable =
    process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it;

  unreadable.each(KINDS)(
    'skips an unreadable unindexed code %s and keeps an indexed one',
    async (kind) => {
      const { list } = ops(kind);
      const store = storeDir('code-ws', kind);
      seed(join(store, 'readable.md'), '# Readable\n', 1);
      seed(join(store, 'locked-indexed.md'), '# Locked indexed\n', 2);
      seed(join(store, 'locked-unindexed.md'), '# Locked unindexed\n', 3);
      writeFileSync(
        join(store, 'index.json'),
        JSON.stringify({
          version: 1,
          items: {
            'locked-indexed': {
              id: 'locked-indexed',
              filename: 'locked-indexed.md',
              title: 'Locked indexed title',
              createdAt: '2020-01-01T00:00:00.000Z',
              updatedAt: '2020-01-02T00:00:00.000Z',
            },
          },
        }),
      );
      chmodSync(join(store, 'locked-indexed.md'), 0o000);
      chmodSync(join(store, 'locked-unindexed.md'), 0o000);
      try {
        expect({
          listed: await list('code-ws'),
          index:
            storeFiles()[
              relative(dataDir, join(store, 'index.json')).split(sep).join('/')
            ],
        }).toMatchSnapshot();
      } finally {
        chmodSync(join(store, 'locked-indexed.md'), 0o600);
        chmodSync(join(store, 'locked-unindexed.md'), 0o600);
      }
    },
  );
});

describe('CAN-4152 workspace items IPC golden: Cowork stores', () => {
  it.each(KINDS)(
    'lists Cowork %s files by name ignoring case, with titles from content',
    async (kind) => {
      const { list, read } = ops(kind);
      const store = storeDir('cowork-ws', kind);
      seed(join(store, 'b-second.md'), '# B heading\n', 1);
      seed(
        join(store, 'A-first.md'),
        '---\ntitle: A title\n---\n# A heading\n',
        2,
      );
      seed(join(store, 'c.md'), 'no heading\n', 3);
      seed(
        join(store, 'd-bad-yaml.md'),
        '---\ntitle: [unclosed\n---\nbody\n',
        4,
      );
      seed(join(store, '.dot.md'), '# Dot heading\n', 5);
      seed(join(store, '.md'), '# Nameless\n', 6);
      seed(join(store, 'skip.txt'), 'not markdown', 7);
      seed(join(store, 'sub', 'inner.md'), '# Inner\n', 8);
      expect({
        listed: await list('cowork-ws'),
        readFirst: await read('cowork-ws', 'A-first'),
        readBadYaml: await read('cowork-ws', 'd-bad-yaml'),
        files: storeFiles(),
      }).toMatchSnapshot();
    },
  );

  const unreadable =
    process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it;

  unreadable.each(KINDS)(
    'rejects the whole Cowork %s list when one file is unreadable',
    async (kind) => {
      const { list } = ops(kind);
      const store = storeDir('cowork-ws', kind);
      seed(join(store, 'readable.md'), '# Readable\n', 1);
      seed(join(store, 'locked.md'), '# Locked\n', 2);
      chmodSync(join(store, 'locked.md'), 0o000);
      try {
        expect(await list('cowork-ws')).toMatchSnapshot();
      } finally {
        chmodSync(join(store, 'locked.md'), 0o600);
      }
    },
  );
});

describe('CAN-4152 workspace items IPC golden: origins', () => {
  it.each(KINDS)(
    'captures, keeps and resolves code %s origins',
    async (kind) => {
      const { list, read, save, idKey } = ops(kind);
      writeWorktrees('code-ws', [
        ['wt-1', 'feature/one'],
        ['wt-2', 'feature/two'],
      ]);
      const live = await save({
        projectId: 'code-ws',
        title: 'Live origin',
        content: 'a',
        originWorktreeId: 'wt-1',
      });
      const missing = await save({
        projectId: 'code-ws',
        title: 'Missing origin',
        content: 'b',
        originWorktreeId: 'wt-missing',
      });
      const none = await save({
        projectId: 'code-ws',
        title: 'No origin',
        content: 'c',
      });
      const laterOrigin = await save({
        projectId: 'code-ws',
        [idKey]: 'no-origin',
        title: 'No origin',
        content: 'c2',
        originWorktreeId: 'wt-2',
      });
      const keptOrigin = await save({
        projectId: 'code-ws',
        [idKey]: 'live-origin',
        title: 'Live origin renamed',
        content: 'a2',
        originWorktreeId: 'wt-2',
      });
      writeWorktrees('code-ws', [
        ['wt-1', 'feature/one-renamed'],
        ['wt-2', 'feature/two'],
      ]);
      const listedAfterBranchRename = byId(await list('code-ws'));
      const filesAfterBranchRename = storeFiles();
      writeWorktrees('code-ws', [['wt-2', 'feature/two']]);
      const listedAfterWorktreeRemoval = byId(await list('code-ws'));
      const readAfterWorktreeRemoval = await read(
        'code-ws',
        'live-origin-renamed',
      );
      expect({
        live,
        missing,
        none,
        laterOrigin,
        keptOrigin,
        listedAfterBranchRename,
        filesAfterBranchRename,
        listedAfterWorktreeRemoval,
        readAfterWorktreeRemoval,
      }).toMatchSnapshot();
    },
  );
});

describe('CAN-4152 workspace items IPC golden: titles and names', () => {
  const TITLE_LAYOUTS: ReadonlyArray<[string, string, Kind]> = [
    ['code note', 'code-ws', 'note'],
    ['code prompt', 'code-ws', 'prompt'],
    ['Cowork note', 'cowork-ws', 'note'],
    ['Cowork prompt', 'cowork-ws', 'prompt'],
  ];

  it.each(TITLE_LAYOUTS)(
    'keeps blank, padded, accented, colliding and long titles for a %s',
    async (_name, projectId, kind) => {
      const { save, list, idKey } = ops(kind);
      const results = {
        empty: await save({ projectId, title: '', content: 'empty title' }),
        emptyAgain: await save({ projectId, title: '', content: 'again' }),
        blank: await save({ projectId, title: '   ', content: 'blank' }),
        padded: await save({ projectId, title: '  Padded  ', content: 'p' }),
        accented: await save({
          projectId,
          title: 'Résumé — Final!',
          content: 'r',
        }),
        same: await save({ projectId, title: 'Same', content: 's1' }),
        sameAgain: await save({ projectId, title: 'Same', content: 's2' }),
        other: await save({ projectId, title: 'Other', content: 'o' }),
        renamedOntoOther: await save({
          projectId,
          [idKey]: 'same',
          title: 'Other',
          content: 's3',
        }),
        emptyEdit: await save({
          projectId,
          [idKey]: 'padded',
          title: '',
          content: 'p2',
        }),
        long: await save({ projectId, title: 'a'.repeat(300), content: 'l' }),
      };
      expect({
        results,
        listed: byId(await list(projectId)),
        files: storeFiles(),
      }).toMatchSnapshot();
    },
  );

  it.each([
    ['code', 'code-ws'],
    ['Cowork', 'cowork-ws'],
  ])(
    'rewrites %s prompt frontmatter on save, dropping other keys',
    async (_name, projectId) => {
      const { read, save } = ops('prompt');
      seed(
        join(storeDir(projectId, 'prompt'), 'tagged.md'),
        '---\ntitle: Tagged\ntags: [keep, me]\nmodel: fast\n---\nBody one\n',
      );
      const before = await read(projectId, 'tagged');
      const saved = await save({
        projectId,
        promptId: 'tagged',
        title: 'Tagged',
        content: 'Body two\n',
      });
      expect({
        before,
        saved,
        after: await read(projectId, 'tagged'),
        files: storeFiles(),
      }).toMatchSnapshot();
    },
  );

  it.each(KINDS)(
    'edits and renames an unindexed code %s in place',
    async (kind) => {
      const { save, list, idKey } = ops(kind);
      seed(join(storeDir('code-ws', kind), 'hand.md'), '# Hand\nfirst\n');
      const sameName = await save({
        projectId: 'code-ws',
        [idKey]: 'hand',
        title: 'Hand',
        content: '# Hand\nsecond\n',
      });
      const filesAfterSameName = storeFiles();
      const renamed = await save({
        projectId: 'code-ws',
        [idKey]: 'hand',
        title: 'Hand renamed',
        content: '# Hand\nthird\n',
      });
      expect({
        sameName,
        filesAfterSameName,
        renamed,
        listed: await list('code-ws'),
        files: storeFiles(),
      }).toMatchSnapshot();
    },
  );
});

/** Long strings abbreviated so snapshots stay readable. */
function abbreviate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(abbreviate);
  if (typeof value === 'string') {
    if (value.length <= 200) return value;
    return `<${value.length} chars: ${value.slice(0, 40)}…${value.slice(-16)}>`;
  }
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      abbreviate(key) as string,
      abbreviate(child),
    ]),
  );
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

describe('CAN-4152 workspace items IPC golden: limits', () => {
  const LIMIT_LAYOUTS: ReadonlyArray<[string, string, Kind]> = [
    ['code note', 'code-ws', 'note'],
    ['code prompt', 'code-ws', 'prompt'],
    ['Cowork note', 'cowork-ws', 'note'],
    ['Cowork prompt', 'cowork-ws', 'prompt'],
  ];

  it.each(LIMIT_LAYOUTS)(
    'saves a title over 512 characters and content over 2,000,000 for a %s',
    async (_name, projectId, kind) => {
      const { save, read, list } = ops(kind);
      // Accented letters normalize away, so the stored name is `item`.
      const saved = await save({
        projectId,
        title: 'é'.repeat(600),
        content: 'x'.repeat(2_000_001),
      });
      expect(
        abbreviate({
          saved,
          read: await read(projectId, 'item'),
          listed: await list(projectId),
          files: storeFiles(),
        }),
      ).toMatchSnapshot();
    },
  );

  it.each(LIMIT_LAYOUTS)(
    'creates a long name but pins a rename onto it for a %s',
    async (_name, projectId, kind) => {
      const { save, list, idKey } = ops(kind);
      // A 240-byte stem fits a file name, but not the code store's
      // temporary rename name.
      const created = await save({
        projectId,
        title: 'b'.repeat(240),
        content: 'created',
      });
      await save({ projectId, title: 'Short', content: 'short' });
      const renamed = await save({
        projectId,
        [idKey]: 'short',
        title: 'c'.repeat(240),
        content: 'renamed',
      });
      const withoutUuids = (value: unknown): unknown =>
        abbreviate(JSON.parse(JSON.stringify(value).replace(UUID, '<uuid>')));
      expect(
        withoutUuids({
          created,
          renamed,
          listed: byId(await list(projectId)),
          files: storeFiles(),
        }),
      ).toMatchSnapshot();
    },
  );

  it.each(KINDS)(
    'returns indexed code %s titles of any length',
    async (kind) => {
      const { list } = ops(kind);
      const store = storeDir('code-ws', kind);
      const ids = Array.from({ length: 8 }, (_, index) => `long-${index}`);
      ids.forEach((id, index) => seed(join(store, `${id}.md`), id, index + 1));
      writeFileSync(
        join(store, 'index.json'),
        JSON.stringify({
          version: 1,
          items: Object.fromEntries(
            ids.map((id, index) => [
              id,
              {
                id,
                filename: `${id}.md`,
                title: `${index}`.repeat(100_000),
                createdAt: '2020-01-01T00:00:00.000Z',
                updatedAt: `2020-01-0${index + 1}T00:00:00.000Z`,
              },
            ]),
          ),
        }),
      );
      expect(abbreviate({ listed: await list('code-ws') })).toMatchSnapshot();
    },
  );

  it.each(KINDS)(
    'records an unindexed code %s edit as new, with its origin',
    async (kind) => {
      const { save, idKey } = ops(kind);
      writeWorktrees('code-ws', [['wt-1', 'feature/one']]);
      seed(join(storeDir('code-ws', kind), 'dropped.md'), '# Dropped\n');
      const saved = await call(CHANNELS[kind].save, {
        projectId: 'code-ws',
        [idKey]: 'dropped',
        title: 'Dropped',
        content: '# Dropped\nedited\n',
        originWorktreeId: 'wt-1',
      });
      // The unindexed file's creation time is not kept.
      expect(field(saved, 'createdAt')).toBe(field(saved, 'updatedAt'));
      expect({
        saved: describeValue(saved),
        again: await save({
          projectId: 'code-ws',
          [idKey]: 'dropped',
          title: 'Dropped',
          content: '# Dropped\nagain\n',
          originWorktreeId: 'wt-1',
        }),
        files: storeFiles(),
      }).toMatchSnapshot();
    },
  );
});

describe('CAN-4152 workspace items IPC golden: shared-container selections', () => {
  async function seedSelections(
    projectId: string,
    noteIds: string[],
    promptIds: string[],
  ): Promise<void> {
    for (const worktreeId of ['wt-1', 'wt-2']) {
      await writeSharedContainerFileScope(projectId, worktreeId, {
        includedPaths: [],
        includedNoteIds: noteIds,
        excludedNoteIds: noteIds,
        includedPromptIds: promptIds,
        excludedPromptIds: promptIds,
      });
    }
  }

  it.each([
    ['code', 'code-ws'],
    ['Cowork', 'cowork-ws'],
    ['App Advisor', APP_ADVISOR_PROJECT_ID],
  ])(
    'rewrites %s selections on rename and pins delete side effects',
    async (_name, projectId) => {
      const note = ops('note');
      const prompt = ops('prompt');
      await note.save({ projectId, title: 'Shared note', content: 'n1' });
      await prompt.save({ projectId, title: 'Shared prompt', content: 'p1' });
      await seedSelections(
        projectId,
        ['shared-note', 'ghost-note', 'other'],
        ['shared-prompt', 'ghost-prompt', 'other'],
      );
      mockPublished.length = 0;
      const sameName = {
        note: await note.save({
          projectId,
          noteId: 'shared-note',
          title: 'Shared note',
          content: 'n2',
        }),
        prompt: await prompt.save({
          projectId,
          promptId: 'shared-prompt',
          title: 'Shared prompt',
          content: 'p2',
        }),
      };
      const afterSameName = {
        files: storeFiles(),
        published: await published(),
      };
      mockPublished.length = 0;
      const renamed = {
        note: await note.save({
          projectId,
          noteId: 'shared-note',
          title: 'Renamed note',
          content: 'n3',
        }),
        prompt: await prompt.save({
          projectId,
          promptId: 'shared-prompt',
          title: 'Renamed prompt',
          content: 'p3',
        }),
      };
      const afterRename = {
        files: storeFiles(),
        published: await published(),
      };
      mockPublished.length = 0;
      const missingId = {
        note: await note.save({
          projectId,
          noteId: 'ghost-note',
          title: 'Fresh note',
          content: 'fresh',
        }),
        prompt: await prompt.save({
          projectId,
          promptId: 'ghost-prompt',
          title: 'Fresh prompt',
          content: 'fresh',
        }),
      };
      const afterMissingId = {
        files: storeFiles(),
        published: await published(),
      };
      mockPublished.length = 0;
      const deletedExisting = {
        note: await note.remove(projectId, 'renamed-note'),
        prompt: await prompt.remove(projectId, 'renamed-prompt'),
      };
      // A code delete of a missing item no longer touches selections or
      // publishes (deliberate, pinned in workspace-items-ipc-changes.test.ts),
      // so the stores are captured before those deletes.
      const afterDelete = { files: storeFiles(), published: await published() };
      const deleted = {
        ...deletedExisting,
        missingNote: await note.remove(projectId, 'other'),
        missingPrompt: await prompt.remove(projectId, 'other'),
      };
      expect({
        sameName,
        afterSameName,
        renamed,
        afterRename,
        missingId,
        afterMissingId,
        deleted,
        afterDelete,
      }).toMatchSnapshot();
    },
  );
});

describe('CAN-4152 workspace items IPC golden: viewer and invalid requests', () => {
  it.each(KINDS)(
    'refuses %s writes and worktree-less reads in the read-only viewer',
    async (kind) => {
      const { list, read, save, remove, idKey } = ops(kind);
      const projectId = SHARED_CONTAINER_VIEWER_PROJECT_ID;
      expect({
        list: await list(projectId),
        listBadWorktree: await list(projectId, { worktreeId: 'Bad_Id' }),
        read: await read(projectId, 'some-item'),
        readBadId: await read(projectId, 'Bad_Id', { worktreeId: 'wt-1' }),
        save: await save({ projectId, title: 'Nope', content: 'x' }),
        saveWithId: await save({
          projectId,
          [idKey]: 'some-item',
          title: 'Nope',
          content: 'x',
        }),
        remove: await remove(projectId, 'some-item'),
        files: storeFiles(),
        published: await published(),
      }).toMatchSnapshot();
    },
  );

  it.each(KINDS)(
    'refuses %s reads of a viewer worktree with no replica',
    async (kind) => {
      const { list, read } = ops(kind);
      const projectId = SHARED_CONTAINER_VIEWER_PROJECT_ID;
      expect({
        list: await list(projectId, { worktreeId: 'wt-1' }),
        read: await read(projectId, 'some-item', { worktreeId: 'wt-1' }),
        files: storeFiles(),
      }).toMatchSnapshot();
    },
  );

  it.each(KINDS)('pins invalid %s requests', async (kind) => {
    const { list, read, save, remove, idKey } = ops(kind);
    const channels = CHANNELS[kind];
    const results = {
      listMissingPayload: await ipc(channels.list, undefined),
      listBadProject: await list('Bad_Id'),
      listNumericProject: await list(42),
      readMissingPayload: await ipc(channels.read, undefined),
      readBadProject: await read('Bad_Id', 'item'),
      readMissingItem: await read('code-ws', 'missing-item'),
      readCoworkMissingItem: await read('cowork-ws', 'missing-item'),
      readTraversal: await read('code-ws', '../escape'),
      readDotted: await read('code-ws', 'a.b'),
      readEmpty: await read('code-ws', ''),
      readNumeric: await read('code-ws', 7),
      saveMissingPayload: await ipc(channels.save, undefined),
      saveBadProject: await save({
        projectId: 'Bad_Id',
        title: 'x',
        content: 'x',
      }),
      saveBadItem: await save({
        projectId: 'code-ws',
        [idKey]: 'Bad_Id',
        title: 'x',
        content: 'x',
      }),
      saveBadOrigin: await save({
        projectId: 'code-ws',
        title: 'x',
        content: 'x',
        originWorktreeId: 'Bad_Id',
      }),
      saveCoworkBadOrigin: await save({
        projectId: 'cowork-ws',
        title: 'x',
        content: 'x',
        originWorktreeId: '../up',
      }),
      saveMissingTitle: await save({ projectId: 'code-ws', content: 'x' }),
      saveCoworkMissingTitle: await save({
        projectId: 'cowork-ws',
        content: 'x',
      }),
      saveMissingContent: await save({
        projectId: 'code-ws',
        title: 'No body',
      }),
      saveCoworkMissingContent: await save({
        projectId: 'cowork-ws',
        title: 'No body',
      }),
      deleteMissingPayload: await ipc(channels.delete, undefined),
      deleteBadProject: await remove('Bad_Id', 'item'),
      deleteBadItem: await remove('code-ws', 'Bad_Id'),
      deleteCoworkBadItem: await remove('cowork-ws', '../escape'),
    };
    expect({
      results,
      files: storeFiles(),
      published: await published(),
    }).toMatchSnapshot();
  });

  it.each(KINDS)(
    'answers every %s caller alike on the unchanged handlers',
    async (kind) => {
      const channels = CHANNELS[kind];
      const outcomes = [];
      for (const [index, [caller, event]] of CALLERS.entries()) {
        outcomes.push({
          caller,
          saved: await ipc(
            channels.save,
            { projectId: 'code-ws', title: `By caller ${index}`, content: 'x' },
            event,
          ),
          listed: await ipc(channels.list, { projectId: 'code-ws' }, event),
        });
      }
      const final = await ipc(channels.list, { projectId: 'code-ws' });
      expect(field(final, 'result')).toHaveLength(CALLERS.length);
      expect(outcomes.map((outcome) => field(outcome.saved, 'error'))).toEqual(
        CALLERS.map(() => undefined),
      );
    },
  );
});
