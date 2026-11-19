// CAN-4070 rule: captured on the unchanged `worktree:import-attachments`,
// `workspace-items:import-attachments` and `workspace-items:list-attachments`
// IPC handlers and the Portal `list_attachments` command before CAN-4105
// routed them through `core.workspace.item.*`. Real data root, real source
// files and the real workspace registry; only handler registration, the
// native dialog and publication scheduling are mocked.
// The parallel same-name race of the worktree channel is scheduling-dependent
// and deliberately not pinned (see attachment-import-ipc-changes.test.ts).
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  APP_ADVISOR_PROJECT_ID,
  IPC_CHANNELS,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
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
      'mkdir',
      'open',
      'readFile',
      'readdir',
      'realpath',
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

const mockShowOpenDialog = jest.fn<
  Promise<{ canceled: boolean; filePaths: string[] }>,
  unknown[]
>(() => Promise.resolve({ canceled: true, filePaths: [] }));
jest.mock('electron', () => ({
  dialog: {
    showOpenDialog: (
      ...args: unknown[]
    ): Promise<{ canceled: boolean; filePaths: string[] }> =>
      mockShowOpenDialog(...args),
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
jest.mock('../shared-containers/publish/scheduler', () => ({
  getSharedContainerPublishScheduler: (): {
    scheduleWorkspace: () => Promise<void>;
  } => ({ scheduleWorkspace: (): Promise<void> => Promise.resolve() }),
}));

import { registerWorktreeAttachmentHandlers } from '../ipc/worktree-attachments';
import { registerWorkspaceItemHandlers } from '../ipc/workspace-items';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import { setDesktopCanopyRuntime } from '../canopy-runtime/desktop-runtime-access';
import { listAttachmentsInDir } from '../lib/agent-attachments';
import {
  copyAttachmentFileToDir,
  listAttachments as listCoworkAttachments,
} from '../lib/standalone-workspace-files';

jest.setTimeout(30_000);

let dir: string;
let dataDir: string;
let sourceDir: string;
let originalDataDir: string | undefined;

let runtime: DesktopCanopyDispatcher | null = null;
const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.workspace.read', 'core.worktree.read'],
};

function registerHandlers(): void {
  runtime = createDesktopRuntime();
  setDesktopCanopyRuntime(runtime);
  const access = {
    dispatcher: runtime,
    resolveCaller: (): CanopyCallerDescriptor => caller,
  };
  registerWorktreeAttachmentHandlers(access);
  registerWorkspaceItemHandlers(access);
}

async function closeHandlers(): Promise<void> {
  setDesktopCanopyRuntime(null);
  await runtime?.shutdown();
}

const WORKSPACE_TYPES: ReadonlyArray<[string, WorkspaceType]> = [
  ['code-ws', 'single-repo'],
  ['multi-ws', 'multi-repo'],
  ['cowork-ws', 'cowork'],
];

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'attachment-ipc-golden-')));
  dataDir = join(dir, 'data');
  sourceDir = join(dir, 'source');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  registerHandlers();
});

afterAll(async () => {
  await closeHandlers();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  registerWorkspaceTypes(new Map(WORKSPACE_TYPES));
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(sourceDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  mockShowOpenDialog.mockReset();
  mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
});

function scrub(value: string): string {
  return value.split(dir).join('<root>');
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Host paths scrubbed and creation times checked, then replaced. */
function describeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(describeValue);
  if (typeof value === 'string') return scrub(value);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === 'createdAt' && typeof child === 'string' && ISO.test(child)
        ? '<createdAt>'
        : describeValue(child),
    ]),
  );
}

function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { thrown: String(error) };
  const code: unknown = 'code' in error ? error.code : undefined;
  return {
    name: error.name,
    message: scrub(error.message),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

type Run = (
  request: unknown,
  event?: Partial<IpcMainInvokeEvent>,
) => Promise<Record<string, unknown>>;

async function ipc(
  channel: string,
  request: unknown,
  event: Partial<IpcMainInvokeEvent> = {},
): Promise<Record<string, unknown>> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  try {
    return { result: describeValue(await handler(event, request)) };
  } catch (error) {
    return { error: describeError(error) };
  }
}

const importWorktree: Run = (request, event) =>
  ipc(IPC_CHANNELS.worktreeImportAttachments, request, event);
const importItems: Run = (request, event) =>
  ipc(IPC_CHANNELS.workspaceAttachmentsImport, request, event);
const listItems = (request: unknown): Promise<Record<string, unknown>> =>
  ipc(IPC_CHANNELS.workspaceAttachmentsList, request);
const CHANNELS: ReadonlyArray<[string, Run]> = [
  ['worktree', importWorktree],
  ['workspace-items', importItems],
];

/** Every file under an attachments folder of the data root, with content. */
function attachmentFiles(): Record<string, string> {
  const files: Record<string, string> = {};
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
      if (entry.isDirectory()) walk(path);
      else if (name.includes('attachments'))
        files[name.join('/')] = readFileSync(path, 'utf8');
    }
  };
  walk(dataDir);
  return files;
}

function source(name: string, content = `body of ${name}`): string {
  const path = join(sourceDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text));
}

/** A Cowork-style store seeded through the real import, plus a dot file. */
async function seedSharedStore(projectId: string): Promise<void> {
  const handler = mockHandlers.get(IPC_CHANNELS.workspaceAttachmentsImport);
  if (!handler) throw new Error('import was not registered');
  const response: unknown = await handler(
    {},
    { projectId, worktreeId: 'wt-1', filePaths: [source('one.txt', '1')] },
  );
  const attachments: unknown =
    typeof response === 'object' && response !== null
      ? Reflect.get(response, 'attachments')
      : undefined;
  const first: unknown = Array.isArray(attachments) ? attachments[0] : null;
  const path: unknown =
    typeof first === 'object' && first !== null
      ? Reflect.get(first, 'absolutePath')
      : undefined;
  if (typeof path !== 'string') throw new Error('seed import failed');
  writeFileSync(join(dirname(path), '.dot'), '..');
}

function filenames(listed: Record<string, unknown>): unknown {
  const { result } = listed;
  if (!Array.isArray(result)) return listed;
  return result
    .map((item: unknown): unknown =>
      typeof item === 'object' && item !== null
        ? Reflect.get(item, 'filename')
        : null,
    )
    .map(String)
    .sort();
}

const DESTINATIONS: ReadonlyArray<[string, string, string]> = [
  ['single-repo', 'code-ws', 'wt-1'],
  ['multi-repo', 'multi-ws', 'wt-1'],
  ['cowork', 'cowork-ws', 'wt-1'],
  ['standalone chat sentinel', STANDALONE_CHAT_PROJECT_ID, 'wt-1'],
  ['App Advisor', APP_ADVISOR_PROJECT_ID, 'entry-1'],
  ['app-managed plan explore', PLAN_EXPLORE_CHAT_PROJECT_ID, 'wt-1'],
  ['home draft', 'code-ws', 'home-draft'],
  ['unregistered workspace', 'ghost-ws', 'wt-1'],
];

describe('CAN-4105 attachment import IPC golden: destinations', () => {
  it.each(DESTINATIONS)(
    'imports a file and a clipboard item into a %s scope through both channels',
    async (_layout, projectId, worktreeId) => {
      const file = source('notes.txt');
      const clipboardItems = [{ filename: 'paste.png', data: bytes('png') }];
      const worktree = await importWorktree({
        projectId,
        worktreeId,
        filePaths: [file],
        clipboardItems,
      });
      const items = await importItems({
        projectId,
        worktreeId,
        filePaths: [file],
        clipboardItems,
      });
      expect({ worktree, items, files: attachmentFiles() }).toMatchSnapshot();
    },
  );
});

describe('CAN-4105 attachment import IPC golden: inputs', () => {
  it.each(CHANNELS)(
    'keeps file results before clipboard results on the %s channel',
    async (_channel, run) => {
      const result = await run({
        projectId: 'code-ws',
        worktreeId: 'wt-1',
        filePaths: [source('a.txt'), source('nested/b.md')],
        clipboardItems: [
          { filename: 'c.png', data: bytes('c') },
          { filename: 'd.txt', data: Buffer.from('d') },
        ],
      });
      expect({ result, files: attachmentFiles() }).toMatchSnapshot();
    },
  );

  it.each(CHANNELS)(
    'returns no attachments when the %s chooser is cancelled',
    async (_channel, run) => {
      const empty = await run({
        projectId: 'code-ws',
        worktreeId: 'wt-1',
        filePaths: [],
      });
      const emptyClipboard = await run({
        projectId: 'code-ws',
        worktreeId: 'wt-1',
        filePaths: [],
        clipboardItems: [],
      });
      expect({
        empty,
        emptyClipboard,
        dialogs: mockShowOpenDialog.mock.calls,
        files: attachmentFiles(),
      }).toMatchSnapshot();
    },
  );

  it.each(CHANNELS)(
    'imports the files picked in the %s chooser',
    async (_channel, run) => {
      const picked = [source('picked-1.txt'), source('picked-2.txt')];
      mockShowOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: picked,
      });
      const result = await run({
        projectId: 'multi-ws',
        worktreeId: 'wt-2',
        filePaths: [],
      });
      expect({
        result,
        dialogs: describeValue(mockShowOpenDialog.mock.calls),
        files: attachmentFiles(),
      }).toMatchSnapshot();
    },
  );

  it('skips the chooser when only clipboard items are sent', async () => {
    const result = await importWorktree({
      projectId: 'code-ws',
      worktreeId: 'wt-1',
      filePaths: [],
      clipboardItems: [{ filename: 'only.png', data: bytes('only') }],
    });
    expect({ result, dialogs: mockShowOpenDialog.mock.calls }).toEqual({
      result: {
        result: {
          attachments: [
            {
              filename: 'only.png',
              absolutePath:
                '<root>/data/workspaces/code-ws/attachments/wt-1/only.png',
              sizeBytes: 4,
            },
          ],
        },
      },
      dialogs: [],
    });
  });
});

describe('CAN-4105 attachment import IPC golden: names and sizes', () => {
  it.each(CHANNELS)(
    'keeps names, collisions and sizes on the %s channel',
    async (_channel, run) => {
      const existing = join(dataDir, 'workspaces/code-ws/attachments/wt-1');
      mkdirSync(existing, { recursive: true });
      writeFileSync(join(existing, 'taken.txt'), 'already here');
      writeFileSync(join(existing, 'taken-2.txt'), 'already here too');
      const result = await run({
        projectId: 'code-ws',
        worktreeId: 'wt-1',
        filePaths: [
          source('taken.txt', 'new'),
          source('My File (1).PNG'),
          source('résumé final.pdf'),
          source('README'),
          source('.env', 'SECRET=1'),
          source('empty.bin', ''),
          source(`${'é'.repeat(120)}.txt`),
          source('archive.tar.gz'),
        ],
        clipboardItems: [
          { filename: '', data: bytes('nameless') },
          { filename: '.png', data: bytes('dot') },
          { filename: 'empty.png', data: new Uint8Array() },
          { filename: `${'ü'.repeat(140)}.png`, data: bytes('long') },
        ],
      });
      expect({ result, files: attachmentFiles() }).toMatchSnapshot();
    },
  );

  it('numbers sequential duplicates on the workspace-items channel', async () => {
    const result = await importItems({
      projectId: 'code-ws',
      worktreeId: 'wt-1',
      filePaths: [source('first/x.txt', 'one'), source('second/x.txt', 'two')],
      clipboardItems: [
        { filename: 'x.txt', data: bytes('three') },
        { filename: 'x.txt', data: bytes('four') },
        // Cut to 255 UTF-8 bytes, and again around the collision suffix.
        { filename: `${'a'.repeat(300)}.png`, data: bytes('long one') },
        { filename: `${'a'.repeat(300)}.png`, data: bytes('long two') },
      ],
    });
    expect({ result, files: attachmentFiles() }).toMatchSnapshot();
  });

  it('numbers sequential Cowork duplicates on the workspace-items channel', async () => {
    const result = await importItems({
      projectId: 'cowork-ws',
      worktreeId: 'wt-1',
      filePaths: [source('first/x.txt', 'one'), source('second/x.txt', 'two')],
    });
    expect({ result, files: attachmentFiles() }).toMatchSnapshot();
  });
});

describe('CAN-4105 attachment import IPC golden: failures', () => {
  const unreadable =
    process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it;

  it.each(CHANNELS)(
    'rejects a missing source on the %s channel',
    async (_channel, run) => {
      const result = await run({
        projectId: 'code-ws',
        worktreeId: 'wt-1',
        filePaths: [join(sourceDir, 'missing.txt')],
      });
      expect({ result, files: attachmentFiles() }).toMatchSnapshot();
    },
  );

  it.each(CHANNELS)(
    'rejects a directory source on the %s channel',
    async (_channel, run) => {
      mkdirSync(join(sourceDir, 'folder'));
      const result = await run({
        projectId: 'code-ws',
        worktreeId: 'wt-1',
        filePaths: [join(sourceDir, 'folder')],
      });
      // The copy error differs by platform (ENOTSUP on macOS), so compare it
      // with the unchanged copy helper's own failure for the same paths.
      const reference = await copyAttachmentFileToDir(
        join(dataDir, 'workspaces/code-ws/attachments/wt-1'),
        join(sourceDir, 'folder'),
      ).then(
        () => ({ error: { thrown: 'copied' } }),
        (error: unknown) => ({ error: describeError(error) }),
      );
      expect(result).toEqual(reference);
      expect(attachmentFiles()).toEqual({});
    },
  );

  unreadable.each(CHANNELS)(
    'rejects an unreadable source on the %s channel',
    async (_channel, run) => {
      const file = source('locked.txt');
      chmodSync(file, 0o000);
      try {
        const result = await run({
          projectId: 'code-ws',
          worktreeId: 'wt-1',
          filePaths: [file],
        });
        expect({ result, files: attachmentFiles() }).toMatchSnapshot();
      } finally {
        chmodSync(file, 0o600);
      }
    },
  );

  it.each(CHANNELS)(
    'rejects an extension too long to fit on the %s channel',
    async (_channel, run) => {
      const result = await run({
        projectId: 'code-ws',
        worktreeId: 'wt-1',
        filePaths: [],
        clipboardItems: [
          { filename: `a.${'x'.repeat(260)}`, data: bytes('x') },
        ],
      });
      expect({ result, files: attachmentFiles() }).toMatchSnapshot();
    },
  );

  it.each(CHANNELS)(
    'removes a clipboard file whose write fails on the %s channel',
    async (_channel, run) => {
      const result = await run({
        projectId: 'code-ws',
        worktreeId: 'wt-1',
        filePaths: [],
        clipboardItems: [{ filename: 'broken.png', data: null }],
      });
      expect({ result, files: attachmentFiles() }).toMatchSnapshot();
    },
  );

  it('keeps earlier copies and skips later sources after a workspace-items failure', async () => {
    const result = await importItems({
      projectId: 'code-ws',
      worktreeId: 'wt-1',
      filePaths: [
        source('ok.txt'),
        join(sourceDir, 'missing.txt'),
        source('later.txt'),
      ],
      clipboardItems: [{ filename: 'after.png', data: bytes('after') }],
    });
    expect({ result, files: attachmentFiles() }).toMatchSnapshot();
  });

  it('keeps earlier copies when the last worktree source fails', async () => {
    const result = await importWorktree({
      projectId: 'code-ws',
      worktreeId: 'wt-1',
      filePaths: [source('ok.txt'), join(sourceDir, 'missing.txt')],
    });
    // The parallel base handler may reject before its sibling copy finishes.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect({ result, files: attachmentFiles() }).toMatchSnapshot();
  });

  it('refuses the read-only viewer on the workspace-items channel before the chooser', async () => {
    const result = await importItems({
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'wt-1',
      filePaths: [],
    });
    expect({
      result,
      dialogs: mockShowOpenDialog.mock.calls,
      files: attachmentFiles(),
    }).toMatchSnapshot();
  });

  it.each(CHANNELS)(
    'pins invalid requests on the %s channel',
    async (_channel, run) => {
      const file = source('never.txt');
      const results = {
        missingPayload: await run(undefined),
        badProject: await run({
          projectId: 'Bad_Id',
          worktreeId: 'wt-1',
          filePaths: [file],
        }),
        emptyWorktree: await run({
          projectId: 'code-ws',
          worktreeId: '',
          filePaths: [file],
        }),
        numericProject: await run({
          projectId: 42,
          worktreeId: 'wt-1',
          filePaths: [file],
        }),
        missingFilePaths: await run({
          projectId: 'code-ws',
          worktreeId: 'wt-1',
        }),
        nonStringPath: await run({
          projectId: 'code-ws',
          worktreeId: 'wt-1',
          filePaths: [7],
        }),
      };
      expect({
        results,
        dialogs: mockShowOpenDialog.mock.calls,
        files: attachmentFiles(),
      }).toMatchSnapshot();
    },
  );
});

describe('CAN-4105 attachment list golden', () => {
  it('lists a worktree store like the shared directory reader', async () => {
    const store = join(dataDir, 'workspaces/code-ws/attachments/wt-1');
    mkdirSync(join(store, 'portal-0001'), { recursive: true });
    writeFileSync(join(store, 'a.txt'), 'a');
    writeFileSync(join(store, '.hidden'), 'hidden');
    writeFileSync(join(store, 'portal-0001', 'inner.txt'), 'inner');
    writeFileSync(join(store, 'b.png'), 'bb');
    const listed = await listItems({
      projectId: 'code-ws',
      worktreeId: 'wt-1',
    });
    expect(listed).toEqual({
      result: describeValue(await listAttachmentsInDir(store)),
    });
    expect(filenames(listed)).toEqual(['a.txt', 'b.png']);
  });

  it.each([
    ['cowork', 'cowork-ws'],
    ['App Advisor', APP_ADVISOR_PROJECT_ID],
  ])('lists a %s store with dot files, newest first', async (_name, id) => {
    await seedSharedStore(id);
    const listed = await listItems({ projectId: id, worktreeId: 'wt-9' });
    const expected = (await listCoworkAttachments(id))
      .map((meta) => ({
        filename: meta.filename,
        absolutePath: meta.absolutePath,
        sizeBytes: meta.sizeBytes ?? 0,
        createdAt: meta.createdAt,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    expect(listed).toEqual({ result: describeValue(expected) });
    expect(filenames(listed)).toEqual(['.dot', 'one.txt']);
    expect(listed).toMatchSnapshot();
  });

  it('lists what both import channels wrote into one code worktree', async () => {
    await importWorktree({
      projectId: 'multi-ws',
      worktreeId: 'wt-1',
      filePaths: [source('composer.txt')],
    });
    await importItems({
      projectId: 'multi-ws',
      worktreeId: 'wt-1',
      filePaths: [source('activity.txt')],
    });
    const listed = await listItems({
      projectId: 'multi-ws',
      worktreeId: 'wt-1',
    });
    expect(filenames(listed)).toEqual(['activity.txt', 'composer.txt']);
  });

  it('pins empty, missing and invalid list requests', async () => {
    mkdirSync(join(dataDir, 'workspaces/code-ws/attachments/empty'), {
      recursive: true,
    });
    expect({
      empty: await listItems({ projectId: 'code-ws', worktreeId: 'empty' }),
      missing: await listItems({ projectId: 'code-ws', worktreeId: 'none' }),
      coworkMissing: await listItems({
        projectId: 'cowork-ws',
        worktreeId: 'wt-1',
      }),
      badProject: await listItems({ projectId: 'Bad_Id', worktreeId: 'wt-1' }),
      badWorktree: await listItems({ projectId: 'code-ws', worktreeId: 42 }),
      missingPayload: await listItems(undefined),
    }).toMatchSnapshot();
  });
});
