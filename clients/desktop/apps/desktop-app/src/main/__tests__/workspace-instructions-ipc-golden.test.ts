// CAN-4070 rule: captured on the unchanged `workspace:*-claude-md` IPC handlers
// and Portal `claude_md` commands before CAN-4106 routed them through
// `core.workspace.instructions.*`. Real data root and source repository; only
// handler registration, telemetry and unrelated side channels are mocked.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  PortalCommandEnvelope,
  PortalEventEnvelope,
} from '@canopy/protocol/portal';

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
      'access',
      'copyFile',
      'link',
      'lstat',
      'mkdir',
      'open',
      'readFile',
      'readdir',
      'readlink',
      'realpath',
      'rename',
      'rm',
      'stat',
      'symlink',
      'unlink',
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
jest.mock('../ipc/worktree-discovery', () => ({
  triggerDiscovery: jest.fn(),
}));
jest.mock('../memory/local/import/import-job', () => ({
  enqueueWorkspaceLocalMemoryImportBatch: jest.fn(() => Promise.resolve()),
}));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../lib/desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));
jest.mock('../portal/portal-session-manager', () => ({
  getCanopyPortalState: (): { sessionId: string } => ({
    sessionId: 'golden-session',
  }),
}));

import { registerWorkspaceHandlers } from '../ipc/workspaces';
import {
  handlePortalWorkspaceClaudeMdGet,
  handlePortalWorkspaceClaudeMdSave,
} from '../portal/adapters/workspace-adapter';
import type { PortalAdapterContext } from '../portal/adapters/types';
import { recordWorkspaceCrudTelemetry } from '../lib/desktop-telemetry';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import { setDesktopCanopyRuntime } from '../canopy-runtime/desktop-runtime-access';

jest.setTimeout(30_000);

const DESKTOP_GRANTS: CanopyCallerDescriptor['grants'] = [
  'worker.filesystem.read',
  'core.workspace.read',
  'core.chat.read',
  'core.chat.write',
  'core.worktree.read',
];

function desktopCaller(principalId: string): CanopyCallerDescriptor {
  return {
    principalId,
    clientInstanceId: 'electron-web-contents:1',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: [...DESKTOP_GRANTS],
  };
}

let dir: string;
let dataDir: string;
let repo: string;
let originalDataDir: string | undefined;
let runtime: DesktopCanopyDispatcher;
let caller: CanopyCallerDescriptor;
const mockedTelemetry = jest.mocked(recordWorkspaceCrudTelemetry);

function writeWorkspace(id: string, config: Record<string, unknown>): void {
  mkdirSync(join(dataDir, 'workspaces', id), { recursive: true });
  writeFileSync(
    join(dataDir, 'workspaces', id, 'workspace.json'),
    JSON.stringify({ version: 1, repos: [], ...config }),
  );
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'instructions-ipc-golden-')));
  dataDir = join(dir, 'data');
  repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  writeWorkspace('local-ws', { type: 'multi-repo' });
  writeWorkspace('source-ws', { type: 'multi-repo', sourceRepoPath: repo });
  writeWorkspace('broken-ws', { type: 'multi-repo' });
  mkdirSync(join(dataDir, 'workspaces', 'broken-ws', 'CLAUDE.md'));
  runtime = createDesktopRuntime();
  setDesktopCanopyRuntime(runtime);
  registerWorkspaceHandlers(() => null, {
    dispatcher: runtime,
    resolveCaller: (): CanopyCallerDescriptor => caller,
  });
});

afterAll(async () => {
  setDesktopCanopyRuntime(null);
  await runtime.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  caller = desktopCaller('local-desktop-user');
  mockedTelemetry.mockClear();
  rmSync(join(repo, 'AGENTS.md'), { force: true, recursive: true });
  rmSync(join(repo, 'CLAUDE.md'), { force: true, recursive: true });
  rmSync(join(dataDir, 'workspaces', 'local-ws', 'CLAUDE.md'), {
    force: true,
  });
});

function scrub(value: string): string {
  return value.split(dir).join('<root>');
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

async function ipc(
  channel: string,
  request: unknown,
): Promise<Record<string, unknown>> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  try {
    const event: Partial<IpcMainInvokeEvent> = {};
    return { result: await handler(event, request) };
  } catch (error) {
    return { error: describeError(error) };
  }
}

const load = (request: unknown): Promise<Record<string, unknown>> =>
  ipc(IPC_CHANNELS.workspaceLoadClaudeMd, request);
const save = (request: unknown): Promise<Record<string, unknown>> =>
  ipc(IPC_CHANNELS.workspaceSaveClaudeMd, request);

function portalContext(events: PortalEventEnvelope[]): PortalAdapterContext {
  return {
    sessionId: 'golden-session',
    getWindow: () => null,
    enqueueEvent: (event) => events.push(event),
    complete: (command, result): void => {
      events.push({
        type: 'portal.command.completed',
        commandId: command.id,
        payload: { result },
      } as PortalEventEnvelope);
    },
    fail: (command, code, message, retryable): void => {
      events.push({
        type: 'portal.command.failed',
        commandId: command.id,
        payload: { error: { code, message: scrub(message), retryable } },
      } as PortalEventEnvelope);
    },
  };
}

async function portal(
  type: 'portal.workspace.claude_md.get' | 'portal.workspace.claude_md.save',
  payload: unknown,
): Promise<PortalEventEnvelope[]> {
  const events: PortalEventEnvelope[] = [];
  const command = {
    id: 'cmd-golden',
    sequence: 1,
    type,
    payload,
    createdAt: '2026-10-23T00:00:00.000Z',
    expiresAt: null,
  };
  if (type === 'portal.workspace.claude_md.get')
    await handlePortalWorkspaceClaudeMdGet(
      command as PortalCommandEnvelope<{ workspaceId: string }>,
      portalContext(events),
    );
  else
    await handlePortalWorkspaceClaudeMdSave(
      command as PortalCommandEnvelope<{
        workspaceId: string;
        content: string;
      }>,
      portalContext(events),
    );
  return events;
}

const INVALID_IDS: unknown[] = ['Bad_Id', '', 'has space', 42, null, undefined];
const INVALID_ID_MESSAGE =
  'Invalid workspaceId: must be lowercase alphanumeric with hyphens';

describe('CAN-4106 workspace instructions IPC golden', () => {
  it('loads and saves a local workspace copy with claude_md telemetry', async () => {
    const localPath = join(dataDir, 'workspaces', 'local-ws', 'CLAUDE.md');
    const missing = await load({ workspaceId: 'local-ws' });
    const saved = await save({ workspaceId: 'local-ws', content: '# Local' });
    const loaded = await load({ workspaceId: 'local-ws' });
    expect({ missing, saved, loaded }).toEqual({
      missing: { result: '' },
      saved: { result: undefined },
      loaded: { result: '# Local' },
    });
    expect(readFileSync(localPath, 'utf8')).toBe('# Local');
    expect(mockedTelemetry.mock.calls).toEqual([
      [{ action: 'update', workspaceId: 'local-ws', source: 'claude_md' }],
    ]);
  });

  it('keeps remote-device reach with the same telemetry source', async () => {
    caller = desktopCaller('remote-device:controller-1');
    expect(
      await save({ workspaceId: 'local-ws', content: '# Remote' }),
    ).toEqual({ result: undefined });
    expect(await load({ workspaceId: 'local-ws' })).toEqual({
      result: '# Remote',
    });
    expect(mockedTelemetry.mock.calls).toEqual([
      [{ action: 'update', workspaceId: 'local-ws', source: 'claude_md' }],
    ]);
  });

  it.each(INVALID_IDS)(
    'rejects workspaceId %p with the legacy message',
    async (workspaceId) => {
      const loaded = await load({ workspaceId });
      const saved = await save({ workspaceId, content: '# Never' });
      expect(loaded).toEqual({
        error: {
          name: 'IdentifierValidationError',
          message: INVALID_ID_MESSAGE,
        },
      });
      expect(saved).toEqual(loaded);
      expect(mockedTelemetry).not.toHaveBeenCalled();
    },
  );

  it('pins a missing request payload', async () => {
    expect({
      load: await load(undefined),
      save: await save(undefined),
    }).toMatchSnapshot();
  });

  it('propagates a non-ENOENT read error instead of returning empty content', async () => {
    expect({
      load: await load({ workspaceId: 'broken-ws' }),
      save: await save({ workspaceId: 'broken-ws', content: '# Never' }),
    }).toMatchSnapshot();
    expect(mockedTelemetry).not.toHaveBeenCalled();
  });

  it('reads and writes an unknown workspace through the default local path', async () => {
    const result = {
      load: await load({ workspaceId: 'ghost-ws' }),
      save: await save({ workspaceId: 'ghost-ws', content: '# Ghost' }),
      reload: await load({ workspaceId: 'ghost-ws' }),
    };
    rmSync(join(dataDir, 'workspaces', 'ghost-ws'), {
      recursive: true,
      force: true,
    });
    expect(result).toMatchSnapshot();
  });

  it.each([
    ['none', (): void => undefined],
    ['agents-only', (): void => writeFileSync(join(repo, 'AGENTS.md'), '# A')],
    ['claude-only', (): void => writeFileSync(join(repo, 'CLAUDE.md'), '# C')],
    [
      'equal-mirror',
      (): void => {
        writeFileSync(join(repo, 'AGENTS.md'), '# Same');
        writeFileSync(join(repo, 'CLAUDE.md'), '# Same');
      },
    ],
    [
      'agents-link',
      (): void => {
        writeFileSync(join(repo, 'CLAUDE.md'), '# C');
        symlinkSync('CLAUDE.md', join(repo, 'AGENTS.md'));
      },
    ],
    [
      'agents-escape',
      (): void => symlinkSync('../outside.md', join(repo, 'AGENTS.md')),
    ],
    [
      'claude-escape',
      (): void => symlinkSync('../outside.md', join(repo, 'CLAUDE.md')),
    ],
    ['claude-directory', (): void => mkdirSync(join(repo, 'CLAUDE.md'))],
  ])('routes a source-backed %s layout', async (_layout, arrange) => {
    writeFileSync(join(dir, 'outside.md'), '# Outside');
    arrange();
    const loaded = await load({ workspaceId: 'source-ws' });
    const saved = await save({ workspaceId: 'source-ws', content: '# New' });
    const files = Object.fromEntries(
      ['AGENTS.md', 'CLAUDE.md', '../outside.md'].map((name) => {
        try {
          return [name, readFileSync(join(repo, name), 'utf8')];
        } catch (error) {
          const code: unknown =
            typeof error === 'object' && error !== null
              ? Reflect.get(error, 'code')
              : undefined;
          return [name, `unreadable: ${String(code)}`];
        }
      }),
    );
    expect({
      loaded,
      saved,
      files,
      telemetry: mockedTelemetry.mock.calls,
    }).toMatchSnapshot();
  });
});

describe('CAN-4106 workspace instructions Portal golden', () => {
  it('gets and saves with portal telemetry', async () => {
    const events = [
      ...(await portal('portal.workspace.claude_md.get', {
        workspaceId: 'local-ws',
      })),
      ...(await portal('portal.workspace.claude_md.save', {
        workspaceId: 'local-ws',
        content: '# From Portal',
      })),
      ...(await portal('portal.workspace.claude_md.get', {
        workspaceId: 'local-ws',
      })),
    ];
    expect(events).toEqual([
      {
        type: 'portal.command.completed',
        commandId: 'cmd-golden',
        payload: { result: { content: '' } },
      },
      {
        type: 'portal.command.completed',
        commandId: 'cmd-golden',
        payload: { result: { success: true } },
      },
      {
        type: 'portal.command.completed',
        commandId: 'cmd-golden',
        payload: { result: { content: '# From Portal' } },
      },
    ]);
    expect(mockedTelemetry.mock.calls).toEqual([
      [{ action: 'update', workspaceId: 'local-ws', source: 'portal' }],
    ]);
  });

  it.each([
    ['malformed id', { workspaceId: 'Bad Id!' }],
    ['missing id', {}],
    ['non-object', 'nope'],
    ['source-backed escape', { workspaceId: 'source-ws' }],
    ['unreadable copy', { workspaceId: 'broken-ws' }],
  ])('pins a failed get for %s', async (_name, payload) => {
    symlinkSync('../outside.md', join(repo, 'AGENTS.md'));
    expect(
      await portal('portal.workspace.claude_md.get', payload),
    ).toMatchSnapshot();
  });

  it.each([
    ['malformed id', { workspaceId: 'Bad Id!', content: 'x' }],
    ['missing content', { workspaceId: 'local-ws' }],
    ['source-backed escape', { workspaceId: 'source-ws', content: 'x' }],
    ['unreadable copy', { workspaceId: 'broken-ws', content: 'x' }],
  ])('pins a failed save for %s', async (_name, payload) => {
    symlinkSync('../outside.md', join(repo, 'AGENTS.md'));
    expect(
      await portal('portal.workspace.claude_md.save', payload),
    ).toMatchSnapshot();
    expect(mockedTelemetry).not.toHaveBeenCalled();
  });
});
