/**
 * Golden (CAN-8065): a paired computer's project, task and chat ids never
 * leave this computer's preload toward main. Every member of every global
 * the preload exposes is called with paired ids in every address field and
 * position; none may reach Electron's IPC. The same members called with
 * local ids still send them, unchanged, and free text that merely contains a
 * paired id passes. The Toolkit's `window.electron` IPC is walked with the
 * rest. Leaks are judged by this test's own reading of the sent arguments,
 * not by the guard. The only modules that may import Electron's IPC directly
 * are the router and the two preloads of other windows.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  IPC_ADDRESS_CONTAINERS,
  qualifyId,
} from '@canopy/protocol/authority-qualified-id';
import {
  PAIRED_COMPUTER_ID_CHANNELS,
  PAIRED_COMPUTER_ID_OPAQUE_FIELDS,
} from '../../shared/paired-computer-target';
import { createLocalIpcRenderer, createRemoteIpcRenderer } from '../ipc-router';

interface Sent {
  kind: 'invoke' | 'send' | 'sendSync';
  channel: string;
  args: unknown[];
}

const sent: Sent[] = [];
const exposed = new Map<string, unknown>();

/** Electron's IPC, and the Toolkit's view of it, recording every call. */
function mockIpc(): Record<string, (...args: unknown[]) => unknown> {
  return {
    invoke: (channel: unknown, ...args: unknown[]): Promise<unknown> => {
      sent.push({ kind: 'invoke', channel: String(channel), args });
      return Promise.resolve(undefined);
    },
    send: (channel: unknown, ...args: unknown[]): void => {
      sent.push({ kind: 'send', channel: String(channel), args });
    },
    sendSync: (channel: unknown, ...args: unknown[]): unknown => {
      sent.push({ kind: 'sendSync', channel: String(channel), args });
      return undefined;
    },
    postMessage: (channel: unknown, message: unknown): void => {
      sent.push({ kind: 'send', channel: String(channel), args: [message] });
    },
    on: (): (() => void) => () => undefined,
    once: (): (() => void) => () => undefined,
    removeListener: (): void => undefined,
    removeAllListeners: (): void => undefined,
  };
}

jest.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown): void => {
      exposed.set(key, value);
    },
  },
  ipcRenderer: mockIpc(),
  webUtils: { getPathForFile: (): string => '' },
  webFrame: { setZoomFactor: (): void => undefined },
}));
jest.mock('@electron-toolkit/preload', () => ({
  electronAPI: { ipcRenderer: mockIpc(), process: { platform: 'linux' } },
}));

const DEVICE = 'mac-device-0123456789a';
const paired = (localId: string): string =>
  qualifyId({ kind: 'paired-computer', deviceId: DEVICE }, localId);

/** A request with `id` in every address field, at the depths the bridge uses. */
function request(id: string): Record<string, unknown> {
  const address = {
    projectId: id,
    workspaceId: id,
    worktreeId: id,
    workEntryId: id,
    taskId: id,
    chatId: id,
    tabId: id,
  };
  return {
    ...address,
    scope: { ...address },
    target: { ...address },
    context: { ...address },
    workspaceTarget: { ...address },
    origin: { ...address },
    destination: { ...address },
    approvalChat: { ...address },
    worktrees: [{ ...address }],
    targets: [{ ...address }],
    projectIds: [id],
    worktreeIds: [id],
    chatIds: [id],
  };
}

/** Address fields and their list forms, read independently of the guard. */
const ID_FIELDS = new Set(
  [
    'projectId',
    'workspaceId',
    'worktreeId',
    'workEntryId',
    'taskId',
    'chatId',
    'tabId',
    'scopeId',
  ].flatMap((field) => [field, `${field}s`]),
);

/**
 * Whether sent arguments carry `id` where it addresses something: as a whole
 * argument or a list argument's entry, or under an address field or its list
 * form at an argument's top level or in its address containers.
 */
function leaks(args: unknown[], id: string): boolean {
  const holdsId = (value: unknown): boolean =>
    value === id || (Array.isArray(value) && value.includes(id));
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 8 || typeof value !== 'object' || value === null) return false;
    if (Array.isArray(value))
      return value.some((item) => visit(item, depth + 1));
    for (const [key, item] of Object.entries(value)) {
      if (PAIRED_COMPUTER_ID_OPAQUE_FIELDS.has(key)) continue;
      if (ID_FIELDS.has(key) && holdsId(item)) return true;
      if (IPC_ADDRESS_CONTAINERS.has(key) && visit(item, depth + 1))
        return true;
    }
    return false;
  };
  return args.some((arg) => holdsId(arg) || visit(arg, 0));
}

/** Every function reachable from the exposed globals, by its path. */
function members(): Array<[string, (...args: unknown[]) => unknown]> {
  const found: Array<[string, (...args: unknown[]) => unknown]> = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown, at: string, depth: number): void => {
    if (depth > 5 || value === null || seen.has(value)) return;
    if (typeof value === 'function') {
      found.push([
        at,
        (...args: unknown[]): unknown => {
          const result: unknown = Reflect.apply(value, undefined, args);
          return result;
        },
      ]);
      return;
    }
    if (typeof value !== 'object') return;
    seen.add(value);
    for (const [key, item] of Object.entries(value))
      walk(item, `${at}.${key}`, depth + 1);
  };
  for (const [key, value] of exposed) walk(value, key, 0);
  return found;
}

/** Calls a member, waiting briefly for its IPC; its own errors are fine. */
async function call(
  member: (...args: unknown[]) => unknown,
  args: unknown[],
): Promise<Sent[]> {
  const before = sent.length;
  try {
    await Promise.race([
      Promise.resolve(member(...args)).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 20)),
    ]);
  } catch {
    // A member may refuse arguments of the wrong shape before any IPC.
  }
  return sent.slice(before);
}

function carries(calls: Sent[], id: string): boolean {
  const holds = (value: unknown, depth: number): boolean => {
    if (value === id) return true;
    if (depth > 8 || typeof value !== 'object' || value === null) return false;
    return Object.values(value).some((item) => holds(item, depth + 1));
  };
  return calls.some((entry) => holds(entry.args, 0));
}

const loadErrors: unknown[] = [];

beforeAll(() => {
  Object.defineProperty(process, 'contextIsolated', {
    configurable: true,
    value: true,
  });
  // The preload logs, rather than throws, a failure to expose its globals.
  const logged = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]): void => {
      if (args.some((arg) => arg instanceof Error)) loadErrors.push(args);
    });
  jest.isolateModules(() => {
    jest.requireActual('../index');
  });
  logged.mockRestore();
});

describe('paired computer ids stay off local IPC (CAN-8065)', () => {
  it('lets no bridge member send a paired id to main', async () => {
    expect(loadErrors).toEqual([]);
    expect([...exposed.keys()]).toEqual(
      expect.arrayContaining(['api', 'electron']),
    );
    const all = members();
    expect(all.map(([at]) => at)).toEqual(
      expect.arrayContaining([
        'electron.ipcRenderer.invoke',
        'electron.ipcRenderer.send',
        'electron.ipcRenderer.sendSync',
        'api.getWorktreeEffective',
      ]),
    );
    const local = 'proj-local';
    const pairedId = paired('proj-remote');
    const forwarding: string[] = [];
    const leaked: string[] = [];
    for (const [at, member] of all) {
      for (const args of [
        [local, local, local, local],
        [request(local), local, local],
      ]) {
        if (carries(await call(member, args), local)) {
          forwarding.push(at);
          break;
        }
      }
      for (const args of [
        [pairedId, pairedId, pairedId, pairedId],
        [request(pairedId), pairedId, pairedId],
      ]) {
        const calls = await call(member, args);
        for (const entry of calls) {
          if (
            !PAIRED_COMPUTER_ID_CHANNELS.has(entry.channel) &&
            leaks(entry.args, pairedId)
          )
            leaked.push(`${at} -> ${entry.channel}`);
        }
      }
    }
    // The whole bridge was walked, and many members do send local ids.
    expect(all.length).toBeGreaterThan(1_000);
    expect(forwarding.length).toBeGreaterThan(400);
    expect(leaked).toEqual([]);
    process.stdout.write(
      `bridge members ${String(all.length)}, sending local ids ${String(forwarding.length)}\n`,
    );
  });

  it('refuses id lists and window.electron calls that name a paired computer', async () => {
    const member = (at: string): ((...args: unknown[]) => unknown) => {
      const found = members().find(([path]) => path === at);
      if (!found) throw new Error(`No bridge member ${at}`);
      return found[1];
    };
    const pairedId = paired('wt-remote');
    for (const [at, args] of [
      [
        'api.getWorktreeEffective',
        [{ projectId: 'proj-1', worktreeIds: ['wt-1', pairedId] }],
      ],
      [
        'electron.ipcRenderer.invoke',
        ['worktree:get-path', { worktreeId: pairedId }],
      ],
      [
        'electron.ipcRenderer.send',
        ['telemetry-sync:record-activity', pairedId, 'wt-1'],
      ],
      [
        'electron.ipcRenderer.postMessage',
        ['cost:watch-scope', { kind: 'entry', projectId: pairedId }],
      ],
    ] as const) {
      expect(await call(member(at), [...args])).toEqual([]);
    }
    const local = await call(member('api.getWorktreeEffective'), [
      { projectId: 'proj-1', worktreeIds: ['wt-1', 'wt-2'] },
    ]);
    expect(local.map((entry) => entry.args)).toEqual([
      [{ projectId: 'proj-1', worktreeIds: ['wt-1', 'wt-2'] }],
    ]);
    expect(
      await call(member('electron.ipcRenderer.postMessage'), [
        'cost:watch-scope',
        { kind: 'entry', projectId: 'proj-1' },
      ]),
    ).toEqual([
      {
        kind: 'send',
        channel: 'cost:watch-scope',
        args: [{ kind: 'entry', projectId: 'proj-1' }],
      },
    ]);
  });

  it('passes local ids and free text through untouched', async () => {
    const received: Sent[] = [];
    const ipc = createLocalIpcRenderer({
      invoke: (channel, ...args) => {
        received.push({ kind: 'invoke', channel, args });
        return Promise.resolve('ok');
      },
      send: (channel, ...args) => {
        received.push({ kind: 'send', channel, args });
      },
      sendSync: (channel, ...args) => {
        received.push({ kind: 'sendSync', channel, args });
        return 'ok';
      },
      on: () => undefined,
      once: () => undefined,
      removeListener: () => undefined,
      removeAllListeners: () => undefined,
    });
    const pairedId = paired('chat-1');
    const localRequest = {
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      query: `find ${pairedId} in the notes`,
    };
    const search = `${pairedId} is mentioned here`;
    await expect(ipc.invoke('chat:load-tabs', localRequest)).resolves.toBe(
      'ok',
    );
    await expect(ipc.invoke('search:files', search)).resolves.toBe('ok');
    ipc.send('telemetry-sync:record-activity', 'proj-1', 'wt-1');
    expect(ipc.sendSync('model-registry:get', localRequest)).toBe('ok');
    expect(received).toEqual([
      { kind: 'invoke', channel: 'chat:load-tabs', args: [localRequest] },
      { kind: 'invoke', channel: 'search:files', args: [search] },
      {
        kind: 'send',
        channel: 'telemetry-sync:record-activity',
        args: ['proj-1', 'wt-1'],
      },
      { kind: 'sendSync', channel: 'model-registry:get', args: [localRequest] },
    ]);
    expect(received[0]?.args[0]).toBe(localRequest);

    // The same calls naming a paired computer never reach main.
    received.length = 0;
    await expect(
      ipc.invoke('chat:load-tabs', { ...localRequest, chatId: pairedId }),
    ).rejects.toMatchObject({ code: 'capability_unavailable' });
    await expect(ipc.invoke('search:files', pairedId)).rejects.toMatchObject({
      code: 'capability_unavailable',
    });
    ipc.send('telemetry-sync:record-activity', pairedId, 'wt-1');
    expect(() => {
      ipc.sendSync('model-registry:get', {
        worktrees: [{ worktreeId: pairedId }],
      });
    }).toThrow('not available for paired computer scopes');
    expect(received).toEqual([]);
  });

  it('refuses paired ids in a remote window too, and routes local ones as before', async () => {
    const received: Sent[] = [];
    const ipc = createRemoteIpcRenderer({
      invoke: (channel, ...args) => {
        received.push({ kind: 'invoke', channel, args });
        return Promise.resolve('ok');
      },
      send: (channel, ...args) => {
        received.push({ kind: 'send', channel, args });
      },
      sendSync: (channel, ...args) => {
        received.push({ kind: 'sendSync', channel, args });
        return 'ok';
      },
      on: () => undefined,
      once: () => undefined,
      removeListener: () => undefined,
      removeAllListeners: () => undefined,
    });
    const pairedId = paired('chat-1');
    await expect(
      ipc.invoke('chat:load-tabs', { projectId: 'proj-1', chatId: pairedId }),
    ).rejects.toMatchObject({ code: 'capability_unavailable' });
    ipc.send('telemetry-sync:record-activity', pairedId, 'wt-1');
    expect(() => {
      ipc.sendSync('model-registry:get', pairedId);
    }).toThrow('not available for paired computer scopes');
    expect(received).toEqual([]);
    const local = { projectId: 'proj-1', chatId: 'chat-1' };
    await expect(ipc.invoke('chat:load-tabs', local)).resolves.toBe('ok');
    expect(received).toEqual([
      {
        kind: 'invoke',
        channel: 'remote-control:invoke',
        args: ['chat:load-tabs', [local]],
      },
    ]);
  });

  it('imports Electron IPC only in the router and the other windows', () => {
    const allowed = new Map([
      ['ipc-router.ts', 'the one router every preload API uses'],
      ['remote-bridge.ts', "the host's bridge window, with its own ids"],
      ['browser-view.ts', 'web pages in the in-app browser'],
    ]);
    const root = path.resolve(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(file);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const source = readFileSync(file, 'utf8');
        const importsIpc =
          /import\s*\{[^}]*\bipcRenderer\b[^}]*\}\s*from\s*'electron'/.test(
            source,
          );
        if (importsIpc && !allowed.has(path.relative(root, file)))
          offenders.push(path.relative(root, file));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
