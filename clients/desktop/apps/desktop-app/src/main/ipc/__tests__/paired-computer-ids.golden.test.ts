/**
 * Golden (CAN-8065): main serves only this computer's ids. Every
 * `registerIpcHandler` channel refuses, and every `onIpcMessage` listener
 * drops, a call whose arguments address a paired computer: an argument that
 * is exactly a paired computer's id, or an address field holding one in a
 * request or its address containers, in objects and lists alike. Local ids,
 * free text that merely contains a paired id and a workflow's own inputs
 * reach the handler untouched; a shared payload is read once, and one past
 * the scan's budget is refused. Each request shape the CAN-8065 audit found
 * escaping the earlier guards is refused with a paired id and served with a
 * local one. The reviewed exceptions, channels and opaque fields, are pinned.
 */
import {
  IPC_ADDRESS_CONTAINERS,
  qualifyId,
} from '@canopy/protocol/authority-qualified-id';
import {
  PAIRED_COMPUTER_ID_CHANNELS,
  PAIRED_COMPUTER_ID_OPAQUE_FIELDS,
} from '../../../shared/paired-computer-target';
import { onIpcMessage, registerIpcHandler } from '../register';

type Invoke = (event: unknown, ...args: unknown[]) => unknown;
type Listen = (event: unknown, ...args: unknown[]) => void;

const mockHandlers = new Map<string, Invoke>();
const mockListeners = new Map<string, Listen>();

jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Invoke): void => {
      mockHandlers.set(channel, handler);
    },
    removeHandler: (channel: string): void => {
      mockHandlers.delete(channel);
    },
    on: (channel: string, listener: Listen): void => {
      mockListeners.set(channel, listener);
    },
  },
}));
jest.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
jest.mock('../../lib/slow-action-tracker', () => ({
  trackSlowAction: <T>(result: T): T => result,
}));
jest.mock('../../lib/web-contents-send', () => ({
  runRendererDeliveryBarriers: (): void => undefined,
}));

const paired = (localId: string): string =>
  qualifyId(
    { kind: 'paired-computer', deviceId: 'mac-device-0123456789a' },
    localId,
  );

/** A stand-in event: the handlers under test read only its sender. */
const EVENT = { sender: { id: 1 } };

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return Promise.resolve(handler(EVENT, ...args));
}

/**
 * The request shapes that carried ids past both earlier guards (CAN-8065
 * audit), each built around one id: the bridge members that send it.
 */
const AUDIT_ESCAPES: ReadonlyArray<[string, (id: string) => unknown[]]> = [
  [
    'standaloneChat.list, cloudProjects.findLink: a whole argument',
    (id) => [id],
  ],
  [
    'organizationCapabilities.getLayer, telemetry: arguments',
    (id) => [id, 'wt-1'],
  ],
  [
    'readFileContent, readFileDocumentBytes: workspaceTarget',
    (id) => [
      {
        absolutePath: '/a',
        workspaceTarget: { projectId: id, worktreeId: 'wt-1' },
      },
    ],
  ],
  [
    'browser.automation, saveDownload: approvalChat',
    (id) => [
      {
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        approvalChat: { projectId: 'proj-1', worktreeId: 'wt-1', chatId: id },
      },
    ],
  ],
  [
    'terminal.spawn: managedCommand',
    (id) => [
      {
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        managedCommand: { chatId: id },
      },
    ],
  ],
  [
    'appAdvisor windows: archivedContainer',
    (id) => [{ archivedContainer: { chatId: id } }],
  ],
  [
    'appAdvisor.openTurnFile: origin',
    // The request's own shape; chatTabId is not an address field, and the
    // handler's validateId refuses a qualified one.
    (id) => [
      {
        path: 'a.ts',
        target: { projectId: 'proj-1', worktreeId: 'wt-1' },
        origin: { projectId: 'proj-1', worktreeId: id, chatTabId: 'tab-1' },
      },
    ],
  ],
  [
    'appAdvisor watchers: destination, watcher.target',
    (id) => [
      {
        destination: { projectId: 'proj-1' },
        watcher: { target: { chatId: id } },
      },
    ],
  ],
  [
    'ledger.searchEntries: params.rootChat',
    (id) => [
      { scope: { projectId: 'proj-1' }, params: { rootChat: { chatId: id } } },
    ],
  ],
  [
    'ledger.searchFeed: filters.rootChat',
    (id) => [
      { scope: { projectId: 'proj-1' }, filters: { rootChat: { chatId: id } } },
    ],
  ],
  [
    'feedback, Claude mods: context',
    (id) => [
      { context: { workspaceId: id, worktreeId: 'wt-1', chatId: 'chat-1' } },
    ],
  ],
  [
    'getDiffStatsBatch, loadWorktreeSummaries: worktrees',
    (id) => [
      {
        worktrees: [
          { projectId: 'proj-1', worktreeId: 'wt-1' },
          { projectId: id, worktreeId: 'wt-2' },
        ],
      },
    ],
  ],
  [
    'resumeUsageLimitedChats, enqueueResumeQueue: targets',
    (id) => [
      { targets: [{ projectId: 'proj-1', worktreeId: 'wt-1', chatId: id }] },
    ],
  ],
  [
    'automations: action, destination',
    (id) => [
      {
        action: { workspaceId: 'proj-1', target: { taskId: id } },
        destination: { workspaceId: 'proj-1' },
      },
    ],
  ],
  [
    'chat.forkOpenWorktreeTabs: selectedTab',
    (id) => [
      {
        selectedTab: {
          destinationTab: {
            adhocMigrationSource: { projectId: id, worktreeId: 'wt-1' },
          },
        },
      },
    ],
  ],
  [
    'sharedContainers.fork: destination',
    (id) => [{ destination: { workspaceId: id } }],
  ],
  [
    'orgProjects.sharedMultiRepo.create: request.sourceProjects',
    (id) => [{ request: { sourceProjects: [{ projectId: id }] } }],
  ],
  [
    'saveProjects: owner',
    (id) => [
      [{ id: 'proj-1', owner: { type: 'organization', projectId: id } }],
    ],
  ],
  [
    'saveEnvironmentConfig: workspaceAssignments',
    (id) => [{ workspaceAssignments: [{ workspaceId: id }] }],
  ],
  [
    'prepareFeedback: workspaceSelections',
    (id) => [{ workspaceSelections: [{ workspaceId: id }] }],
  ],
  [
    'getWorktreeEffective: an id list',
    (id) => [{ projectId: 'proj-1', worktreeIds: ['wt-1', id] }],
  ],
  ['a list argument', (id) => [['wt-1', id]]],
  [
    'cost watches: a request',
    (id) => [{ kind: 'entry', projectId: id, worktreeId: 'wt-1' }],
  ],
];

describe('main refuses paired computer ids (CAN-8065)', () => {
  it.each(AUDIT_ESCAPES)(
    'refuses %s with a paired id, serves a local one',
    async (_name, build) => {
      const handler = jest.fn<string, unknown[]>(() => 'served');
      registerIpcHandler('golden:escape', (_event, ...args) =>
        handler(...args),
      );
      await expect(
        invoke('golden:escape', ...build(paired('proj-2'))),
      ).rejects.toThrow();
      expect(handler).not.toHaveBeenCalled();
      const local = build('proj-2');
      await expect(invoke('golden:escape', ...local)).resolves.toBe('served');
      expect(handler).toHaveBeenCalledWith(...local);
    },
  );

  it('refuses a paired id anywhere in a request, or as an argument', async () => {
    const handler = jest.fn<string, unknown[]>(() => 'served');
    registerIpcHandler('golden:read', (_event, ...args) => handler(...args));
    const id = paired('proj-1');
    for (const args of [
      [id],
      ['proj-local', id],
      [{ projectId: id }],
      [{ context: { chatId: id } }],
      [{ workspaceTarget: { projectId: id, worktreeId: 'wt-1' } }],
      [{ worktrees: [{ projectId: 'proj-1', worktreeId: id }] }],
      [{ action: { target: { scope: { workEntryId: id } } } }],
    ]) {
      await expect(invoke('golden:read', ...args)).rejects.toThrow();
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('serves local ids and free text untouched', async () => {
    const received: unknown[][] = [];
    registerIpcHandler('golden:search', (_event, ...args: unknown[]) => {
      received.push(args);
      return 'served';
    });
    const request = {
      projectId: 'proj-1',
      worktrees: [{ projectId: 'proj-1', worktreeId: 'wt-1' }],
      query: `find ${paired('chat-1')} in the notes`,
    };
    const search = `${paired('chat-1')} is mentioned here`;
    await expect(invoke('golden:search', request)).resolves.toBe('served');
    await expect(invoke('golden:search', search, 'wt-1')).resolves.toBe(
      'served',
    );
    expect(received).toEqual([[request], [search, 'wt-1']]);
    expect(received[0]?.[0]).toBe(request);

    // A workflow's own inputs are its data, not where it runs.
    const launch = {
      scope: 'global',
      target: { scope: 'global' },
      inputs: { chatId: paired('chat-1'), notes: { projectId: paired('p') } },
    };
    await expect(invoke('golden:search', launch)).resolves.toBe('served');
  });

  it('reads a shared payload once, and refuses one past its budget', async () => {
    registerIpcHandler('golden:batch', () => 'served');
    // Fifty references to one child, six containers deep: 50^6 paths.
    let shared: Record<string, unknown> = { projectId: 'proj-1' };
    for (let level = 0; level < 6; level += 1)
      shared = { targets: Array.from({ length: 50 }, () => shared) };
    const startedAt = Date.now();
    await expect(invoke('golden:batch', shared)).resolves.toBe('served');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    const huge = { worktrees: new Array<number>(1_000_001).fill(0) };
    await expect(invoke('golden:batch', huge)).rejects.toThrow();
    // A sparse list is charged its whole length, so it cannot stall main.
    const sparseAt = Date.now();
    await expect(
      invoke('golden:batch', { worktrees: new Array<unknown>(1_000_000_000) }),
    ).rejects.toThrow();
    await expect(
      invoke('golden:batch', { worktreeIds: new Array<string>(1_000_000_000) }),
    ).rejects.toThrow();
    expect(Date.now() - sparseAt).toBeLessThan(1_000);
    // Many targets sharing one id list: the list is read once, not per target.
    const sharedList = new Array<string>(100_000).fill('wt-1');
    const sharing = {
      targets: Array.from({ length: 5_000 }, () => ({
        worktreeIds: sharedList,
      })),
    };
    const sharedAt = Date.now();
    await expect(invoke('golden:batch', sharing)).resolves.toBe('served');
    expect(Date.now() - sharedAt).toBeLessThan(1_000);
    sharedList[99_999] = paired('wt-2');
    await expect(invoke('golden:batch', sharing)).rejects.toThrow();

    // Many arguments sharing one structure: one budget for the whole call.
    const structure = {
      targets: Array.from({ length: 50_000 }, (_, index) => ({
        worktreeId: `wt-${String(index)}`,
      })),
    };
    const manyArgs = Array.from({ length: 2_000 }, () => structure);
    const manyAt = Date.now();
    await expect(invoke('golden:batch', ...manyArgs)).resolves.toBe('served');
    expect(Date.now() - manyAt).toBeLessThan(1_000);
    structure.targets[49_999] = { worktreeId: paired('wt-3') };
    await expect(invoke('golden:batch', ...manyArgs)).rejects.toThrow();
    const sharedArgument = new Array<string>(100_000).fill('wt-1');
    const listAt = Date.now();
    await expect(
      invoke(
        'golden:batch',
        ...Array.from({ length: 2_000 }, () => sharedArgument),
      ),
    ).resolves.toBe('served');
    expect(Date.now() - listAt).toBeLessThan(1_000);
  });

  it('drops a message that names a paired computer, and passes local ones', () => {
    const listener = jest.fn<void, unknown[]>();
    onIpcMessage('golden:activity', (_event, ...args: unknown[]): void => {
      listener(...args);
    });
    const listen = mockListeners.get('golden:activity');
    if (!listen) throw new Error('No listener');
    listen(EVENT, paired('proj-1'), 'wt-1');
    listen(EVENT, { projectId: 'proj-1', worktreeId: paired('wt-1') });
    expect(listener).not.toHaveBeenCalled();
    listen(EVENT, 'proj-1', 'wt-1');
    expect(listener).toHaveBeenCalledWith('proj-1', 'wt-1');
  });

  it('pins the reviewed exceptions, and leaves each opaque field unread', async () => {
    expect([...PAIRED_COMPUTER_ID_CHANNELS]).toEqual([]);
    expect([...PAIRED_COMPUTER_ID_OPAQUE_FIELDS.keys()]).toEqual([
      'inputs',
      'lastActiveContext',
      'state',
      'uiState',
      'agentSent',
      'agentSenderProvenance',
    ]);
    registerIpcHandler('golden:opaque', () => 'served');
    for (const [field, reason] of PAIRED_COMPUTER_ID_OPAQUE_FIELDS) {
      expect(reason.length).toBeGreaterThan(0);
      expect(IPC_ADDRESS_CONTAINERS.has(field)).toBe(false);
      const id = paired('chat-9');
      await expect(
        invoke('golden:opaque', {
          projectId: 'proj-1',
          [field]: { projectId: id, chatId: id },
        }),
      ).resolves.toBe('served');
    }
  });
});
