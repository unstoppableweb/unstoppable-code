import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ArchiveContainerSummary,
  LedgerEntriesSearchParams,
} from '@canopy/protocol/canopy-core';
import type {
  AppAdvisorActionResponse,
  AppAdvisorWatcherSummary,
} from '@canopy/desktop-shared/types';
import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';
import type * as LedgerIpcModule from '../../ipc/ledger';
import type * as SourceResolverModule from '../../ledger/source-resolver';
import type * as RecordsHostModule from '../advisor-records-actions-host';
import type {
  AddEntryParams,
  AdvisorRecordsActionHost,
  PersonConfirmation,
} from '../advisor-records-actions';

jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockRequestRendererTool = jest.fn();
jest.mock('../../ipc/app-advisor', (): object => ({
  ...jest.requireActual<typeof AppAdvisorIpcModule>('../../ipc/app-advisor'),
  requestAppAdvisorRendererTool: (...args: unknown[]): unknown =>
    mockRequestRendererTool(...args),
  routeRendererToolRequest: (): null => null,
}));

let mockHost: AdvisorRecordsActionHost;
const mockHostOptions: Array<{ callKey: string }> = [];
jest.mock('../advisor-records-actions-host', () => ({
  mainAdvisorRecordsActionHost: (options: {
    callKey: string;
  }): AdvisorRecordsActionHost => {
    mockHostOptions.push(options);
    return { ...mockHost, callKey: options.callKey };
  },
}));

import { AdvisorActionRuns } from '@canopy/core-runtime/node/agent/advisor';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import { appAdvisorActionDisposition } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import {
  routeAppAdvisorAction,
  type AppAdvisorActionCall,
} from '../action-router';
import { dispatchActionSchema } from '../definitions';
import { createAppAdvisorToolRuntime } from '../runtime';

const ADVISOR_CHAT = 'advisor-chat';
const SCOPE = { projectId: 'project-1', worktreeId: 'wt-1' };

let root: string;
let operations: OperationService;
let runs: AdvisorActionRuns;

interface Recorded {
  searches: Array<{ scope: unknown; params: LedgerEntriesSearchParams }>;
  adds: Array<{ scope: unknown; requestKey: string; params: AddEntryParams }>;
  ownDeletes: string[];
  deletes: Array<{ id: string; notifySubscriber: boolean }>;
  questions: string[];
  locks: Array<{ archiveId: string; locked: boolean }>;
  restores: string[];
}
let recorded: Recorded;
let answer: PersonConfirmation;
let restored: boolean;
let ownDelete: Awaited<
  ReturnType<AdvisorRecordsActionHost['deleteOwnWatcher']>
>;

function watcher(id: string, chatId: string): AppAdvisorWatcherSummary {
  return {
    id,
    trigger: 'project_task_chat_completion',
    status: 'active',
    label: `Watcher ${id}`,
    target: {
      kind: 'worktree_chat',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'target',
    },
    destination: {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId,
    },
    createdAt: '2026-11-09T00:00:00.000Z',
  };
}

function archived(archiveId: string, locked: boolean): ArchiveContainerSummary {
  return {
    archiveId,
    kind: 'worktree',
    workspaceId: 'ws',
    workspaceName: 'Website',
    revision: null,
    name: `Archive ${archiveId}`,
    branchName: null,
    archivedAt: '2026-11-02T00:00:00.000Z',
    expiresAt: '2026-12-02T00:00:00.000Z',
    locked,
    lockedAt: locked ? '2026-11-03T00:00:00.000Z' : null,
    chatCount: 1,
    archivedChatCount: 0,
    executionCount: 0,
    partiallyRestored: false,
  };
}

function recordingHost(): AdvisorRecordsActionHost {
  return {
    chatId: ADVISOR_CHAT,
    callKey: 'unset',
    searchFeed: (scope, params) => {
      recorded.searches.push({ scope, params });
      return Promise.resolve({
        status: 'ok',
        value: {
          entries: [],
          nextCursor: null,
          hasMore: false,
          watermark: '0',
          actors: [],
        },
      });
    },
    addFeedEntry: (scope, requestKey, params) => {
      recorded.adds.push({ scope, requestKey, params });
      return Promise.resolve({
        status: 'ok',
        value: {
          entry: {
            entryId: `entry-${recorded.adds.length}`,
            revision: 1,
            type: params.type,
            title: params.title,
            status: params.status ?? 'INFO',
          },
        },
      } as never);
    },
    listWatchers: () =>
      Promise.resolve([watcher('own', ADVISOR_CHAT), watcher('theirs', 'x')]),
    deleteOwnWatcher: (id) => {
      recorded.ownDeletes.push(id);
      return Promise.resolve(ownDelete);
    },
    deleteWatcher: (id, notifySubscriber) => {
      recorded.deletes.push({ id, notifySubscriber });
      return Promise.resolve(true);
    },
    confirm: (question) => {
      recorded.questions.push(question);
      return Promise.resolve(answer);
    },
    listArchive: (workspaceId) =>
      Promise.resolve({
        workspaceId,
        containers: restored
          ? [archived('locked', true)]
          : [archived('locked', true), archived('open', false)],
      }),
    readArchivedChat: (workspaceId, archiveId, chatId, limit) =>
      Promise.resolve({
        workspaceId,
        archiveId,
        chatId,
        title: 'Chat',
        totalMessages: 30,
        messages: Array.from({ length: limit }, (_, index) => ({
          id: `m${index}`,
          role: 'user' as const,
          timestamp: index,
          text: `message ${index}`,
          truncated: false,
        })),
      }),
    setArchiveLocked: (_workspaceId, archiveId, locked) => {
      recorded.locks.push({ archiveId, locked });
      return Promise.resolve(archived(archiveId, locked));
    },
    restoreArchive: (_workspaceId, archiveId) => {
      recorded.restores.push(archiveId);
      restored = true;
      return Promise.resolve({
        kind: 'worktree',
        restoredWorktreeId: 'wt-restored',
        branchName: 'feature/x',
        warnings: [],
      });
    },
  };
}

function setup(): {
  route(
    input: unknown,
    call?: Partial<AppAdvisorActionCall>,
  ): Promise<AppAdvisorActionResponse>;
} {
  const runtime = createAppAdvisorToolRuntime(
    {
      getMainWindow: jest.fn(() => null),
      getAppAdvisorWindow: jest.fn(() => null),
      openAppAdvisorWindow: jest.fn(),
      ensureAppAdvisorWindow: jest.fn(),
    },
    {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: ADVISOR_CHAT,
    },
  );
  return {
    route: async (input, call) => {
      const routed = await routeAppAdvisorAction(
        dispatchActionSchema.parse({ action: input }).action,
        runtime,
        { toolUseId: 'toolu_1', ...call },
        { runs: () => runs },
      );
      return JSON.parse(routed.text) as AppAdvisorActionResponse;
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-6007-records-'));
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  runs = new AdvisorActionRuns({ operations });
  recorded = {
    searches: [],
    adds: [],
    ownDeletes: [],
    deletes: [],
    questions: [],
    locks: [],
    restores: [],
  };
  answer = 'confirmed';
  restored = false;
  ownDelete = { ok: true };
  mockHost = recordingHost();
  mockHostOptions.length = 0;
  mockRequestRendererTool.mockClear();
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor Feed, watcher and archive actions in main (CAN-6007)', () => {
  it('runs as core records actions; the GitHub confirmations are presentation', () => {
    for (const type of [
      'ledger.search',
      'watcher.list',
      'watcher.get',
      'archived.list',
      'archived.read_chat',
    ])
      expect(appAdvisorActionDisposition(type)).toEqual({
        kind: 'core',
        access: 'read',
        executor: 'records',
      });
    for (const [type, grant] of [
      ['ledger.add_entry', 'core.ledger.write'],
      ['watcher.delete', 'core.initiatedWork.write'],
      ['archived.restore', 'core.archive.write'],
      ['archived.set_locked', 'core.archive.write'],
    ] as const)
      expect(appAdvisorActionDisposition(type)).toEqual({
        kind: 'core',
        access: 'write',
        executor: 'records',
        grants: [grant],
        revision: 'none',
      });
    for (const type of [
      'github.split_pr',
      'github.resolve_base_branch_alignment',
    ])
      expect(appAdvisorActionDisposition(type)).toEqual({
        kind: 'presentation',
      });
  });

  it('refuses a Feed action that names no work, instead of using a selection', async () => {
    const h = setup();
    for (const [index, input] of [
      { type: 'ledger.search', query: 'deploy' },
      { type: 'ledger.add_entry', entryType: 'TASK', title: 'T', content: 'C' },
      {
        type: 'ledger.add_entry',
        projectId: 'project-1',
        entryType: 'TASK',
        title: 'T',
        content: 'C',
      },
    ].entries())
      await expect(
        h.route(input, { toolUseId: `no-scope-${index}` }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_payload' },
      });
    expect(recorded.searches).toEqual([]);
    expect(recorded.adds).toEqual([]);
  });

  it('searches and adds in the named work, as the window shapes them, and a retried add records once', async () => {
    const h = setup();
    await expect(
      h.route({
        type: 'ledger.search',
        ...SCOPE,
        query: ' deploy\u0007 ',
        types: ['TASK'],
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { ...SCOPE, hasMore: false, entries: [] },
    });
    expect(recorded.searches).toEqual([
      {
        scope: SCOPE,
        params: {
          query: 'deploy',
          types: ['TASK'],
          sort: 'created_desc',
          limit: 20,
        },
      },
    ]);
    const add = {
      type: 'ledger.add_entry',
      ...SCOPE,
      entryType: 'DECISION',
      title: 'Ship it',
      content: 'Approved.',
    };
    const first = await h.route(add, { toolUseId: 'toolu_add' });
    const second = await h.route(add, { toolUseId: 'toolu_add' });
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      ok: true,
      result: { ...SCOPE, entryId: 'entry-1', type: 'DECISION' },
    });
    expect(recorded.adds.map(({ requestKey }) => requestKey)).toEqual([
      'advisor:advisor-chat:toolu_add',
    ]);
    expect(
      recorded.adds.map(({ scope, params }) => ({ scope, params })),
    ).toEqual([
      {
        scope: SCOPE,
        params: {
          type: 'DECISION',
          title: 'Ship it',
          content: 'Approved.',
          owner: 'self',
        },
      },
    ]);
  });

  it('reads every watcher; deletes its own through core, and anyone else’s only on a person’s answer', async () => {
    const h = setup();
    await expect(h.route({ type: 'watcher.list' })).resolves.toMatchObject({
      ok: true,
      result: { watchers: [{ id: 'own' }, { id: 'theirs' }] },
    });
    await expect(
      h.route({ type: 'watcher.get', id: 'theirs' }),
    ).resolves.toMatchObject({
      ok: true,
      result: { watcher: { id: 'theirs' } },
    });
    await expect(
      h.route({ type: 'watcher.delete', id: 'own' }, { toolUseId: 't1' }),
    ).resolves.toMatchObject({ ok: true, result: { id: 'own' } });
    expect(recorded.ownDeletes).toEqual(['own']);
    expect(recorded.questions).toEqual([]);

    for (const refused of ['no_person', 'declined'] as const) {
      answer = refused;
      await expect(
        h.route(
          { type: 'watcher.delete', id: 'theirs' },
          { toolUseId: `t-${refused}` },
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'authorization_conflict' },
      });
    }
    expect(recorded.deletes).toEqual([]);

    answer = 'confirmed';
    await expect(
      h.route(
        { type: 'watcher.delete', id: 'theirs', notifySubscriber: true },
        { toolUseId: 't-confirmed' },
      ),
    ).resolves.toMatchObject({ ok: true, result: { id: 'theirs' } });
    expect(recorded.deletes).toEqual([
      { id: 'theirs', notifySubscriber: true },
    ]);
    expect(recorded.questions).toHaveLength(3);
    expect(recorded.questions[0]).toContain('Watcher theirs');
  });

  it('reports its own watcher kept when core did not delete it', async () => {
    const h = setup();
    ownDelete = { ok: false, reason: 'busy', message: 'Firing.' };
    await expect(
      h.route({ type: 'watcher.delete', id: 'own' }, { toolUseId: 'b1' }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution_failed', message: 'Firing.', retryable: true },
    });
    expect(recorded.questions).toEqual([]);
  });

  it('tells the subscriber only through a person-confirmed watcher service delete', async () => {
    const h = setup();
    answer = 'no_person';
    await expect(
      h.route(
        { type: 'watcher.delete', id: 'own', notifySubscriber: true },
        { toolUseId: 'n1' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'authorization_conflict' },
    });
    expect(recorded.deletes).toEqual([]);
    expect(recorded.ownDeletes).toEqual([]);
    answer = 'confirmed';
    await expect(
      h.route(
        { type: 'watcher.delete', id: 'own', notifySubscriber: true },
        { toolUseId: 'n2' },
      ),
    ).resolves.toMatchObject({ ok: true, result: { id: 'own' } });
    expect(recorded.deletes).toEqual([{ id: 'own', notifySubscriber: true }]);
    expect(recorded.questions).toHaveLength(2);
    // Without the flag, the advisor's own watcher goes through core and
    // nobody is asked or notified.
    await expect(
      h.route({ type: 'watcher.delete', id: 'own' }, { toolUseId: 'n3' }),
    ).resolves.toMatchObject({ ok: true });
    expect(recorded.ownDeletes).toEqual(['own']);
    expect(recorded.deletes).toHaveLength(1);
    expect(recorded.questions).toHaveLength(2);
  });

  it('asks a person before deleting a watcher a person set up for this chat', async () => {
    const h = setup();
    // Core's agent delete doesn't find a watcher no agent of this chat made.
    ownDelete = { ok: false, reason: 'not_found', message: 'Gone.' };
    answer = 'no_person';
    await expect(
      h.route({ type: 'watcher.delete', id: 'own' }, { toolUseId: 'p1' }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'authorization_conflict' },
    });
    expect(recorded.deletes).toEqual([]);
    answer = 'confirmed';
    await expect(
      h.route({ type: 'watcher.delete', id: 'own' }, { toolUseId: 'p2' }),
    ).resolves.toMatchObject({ ok: true, result: { id: 'own' } });
    expect(recorded.deletes).toEqual([{ id: 'own', notifySubscriber: false }]);
    expect(recorded.questions).toHaveLength(2);
  });

  it('unlocks an archive only on a person’s answer; locking asks no one', async () => {
    const h = setup();
    answer = 'no_person';
    await expect(
      h.route(
        {
          type: 'archived.set_locked',
          workspaceId: 'project-1',
          containerId: 'locked',
          locked: false,
        },
        { toolUseId: 'u1' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'authorization_conflict' },
    });
    expect(recorded.locks).toEqual([]);
    answer = 'confirmed';
    await expect(
      h.route(
        {
          type: 'archived.set_locked',
          workspaceId: 'project-1',
          containerId: 'locked',
          locked: false,
        },
        { toolUseId: 'u2' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { containerId: 'locked', locked: false, lockedAt: null },
    });
    await expect(
      h.route(
        {
          type: 'archived.set_locked',
          workspaceId: 'project-1',
          containerId: 'open',
          locked: true,
        },
        { toolUseId: 'l1' },
      ),
    ).resolves.toMatchObject({ ok: true, result: { locked: true } });
    expect(recorded.questions).toHaveLength(2);
    expect(recorded.locks).toEqual([
      { archiveId: 'locked', locked: false },
      { archiveId: 'open', locked: true },
    ]);
  });

  it('writes nothing to unlock an archive already unlocked, so a lock set meanwhile stays', async () => {
    const h = setup();
    await expect(
      h.route(
        {
          type: 'archived.set_locked',
          workspaceId: 'project-1',
          containerId: 'open',
          locked: false,
        },
        { toolUseId: 'u-open' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { containerId: 'open', locked: false, lockedAt: null },
    });
    expect(recorded.locks).toEqual([]);
    expect(recorded.questions).toEqual([]);
  });

  it('lists, reads and restores in the window’s shapes; a restore returns its ids and navigates nowhere', async () => {
    const h = setup();
    await expect(
      h.route({ type: 'archived.list', workspaceId: 'project-1' }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        workspaceId: 'project-1',
        containers: [
          { id: 'locked', locked: true },
          { id: 'open', locked: false },
        ],
      },
    });
    await expect(
      h.route({
        type: 'archived.read_chat',
        workspaceId: 'project-1',
        containerId: 'open',
        chatId: 'chat-1',
        limit: 80,
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { limit: 80, totalMessages: 30, returnedMessages: 80 },
    });
    const restore = {
      type: 'archived.restore',
      workspaceId: 'project-1',
      containerId: 'open',
    };
    const first = await h.route(restore, { toolUseId: 'r1' });
    const second = await h.route(restore, { toolUseId: 'r1' });
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      ok: true,
      result: {
        containerId: 'open',
        restoredWorktreeId: 'wt-restored',
        restoredEntryId: null,
        branchName: 'feature/x',
        pending: false,
      },
    });
    expect(recorded.restores).toEqual(['open']);
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
  });

  it('opens a split PR or answers a base-branch alignment only through the main window’s lease', async () => {
    const h = setup();
    for (const [index, input] of [
      { type: 'github.split_pr', ...SCOPE },
      {
        type: 'github.resolve_base_branch_alignment',
        ...SCOPE,
        confirmationId: 'c1',
        choice: 'cancel',
      },
    ].entries())
      await expect(
        h.route(input, { toolUseId: `lease-${index}` }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'surface_unavailable' },
      });
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
  });
});

describe("the records host's person confirmation (CAN-6007)", () => {
  const { mainAdvisorRecordsActionHost } = jest.requireActual<
    typeof RecordsHostModule
  >('../advisor-records-actions-host');
  const confirmWith = (
    answers: () => Promise<
      Array<{ selectedOptions: string[]; answeredBy?: 'person' | 'agent' }>
    >,
  ): Promise<PersonConfirmation> =>
    mainAdvisorRecordsActionHost({
      destination: {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: ADVISOR_CHAT,
      },
      callKey: 'k',
      requestUserAnswers: answers,
    }).confirm('Delete?', { confirm: 'Delete', decline: 'Keep' });

  it('confirms only a person’s answer', async () => {
    await expect(
      confirmWith(() =>
        Promise.resolve([
          { selectedOptions: ['Delete'], answeredBy: 'person' },
        ]),
      ),
    ).resolves.toBe('confirmed');
    await expect(
      confirmWith(() =>
        Promise.resolve([{ selectedOptions: ['Delete'], answeredBy: 'agent' }]),
      ),
    ).resolves.toBe('no_person');
    await expect(
      confirmWith(() => Promise.resolve([{ selectedOptions: ['Delete'] }])),
    ).resolves.toBe('no_person');
    await expect(
      confirmWith(() =>
        Promise.resolve([{ selectedOptions: ['Keep'], answeredBy: 'person' }]),
      ),
    ).resolves.toBe('declined');
    await expect(
      confirmWith(() => Promise.reject(new Error('No one is available.'))),
    ).resolves.toBe('no_person');
  });
});

describe('Feed entries the advisor adds are its own (CAN-6007)', () => {
  it('records the advisor chat, never the person, with only the call’s grant', async () => {
    const { addLedgerEntryAsChat, searchLedgerEntriesAsChat } =
      jest.requireActual<typeof LedgerIpcModule>('../../ipc/ledger');
    const registrations: unknown[] = [];
    const revoked: string[] = [];
    const host: LedgerIpcModule.LedgerIpcHost = {
      isEnabled: (): boolean => true,
      databaseMayExist: (): Promise<boolean> => Promise.resolve(true),
      registry: () => ({
        register: (registration): string => {
          registrations.push(registration);
          return `binding-${registrations.length}`;
        },
        revoke: (bindingId): boolean => {
          revoked.push(bindingId);
          return true;
        },
      }),
      container: (scope) =>
        'projectId' in scope
          ? {
              kind: 'code_worktree',
              workspaceId: scope.projectId,
              worktreeId: scope.worktreeId,
            }
          : null,
      containerCreatedAt: (): Promise<string> =>
        Promise.resolve('2026-11-01T00:00:00.000Z'),
      archivedContainerCreatedAt: (): Promise<null> => Promise.resolve(null),
      resolveSource: () => Promise.reject(new Error('unused')),
      globalScope: (): Promise<null> => Promise.resolve(null),
      accountId: (): Promise<null> => Promise.resolve(null),
    };
    type Options = { caller: unknown; metadata?: unknown };
    const calls: Array<{ name: string } & Options> = [];
    const dispatcher = {
      instruction: (
        name: string,
        _params: unknown,
        options: Options,
      ): Promise<never> => {
        calls.push({ name, ...options });
        return Promise.resolve({ entry: { entryId: 'e1' } } as never);
      },
      query: (
        name: string,
        _params: unknown,
        options: Options,
      ): Promise<never> => {
        calls.push({ name, ...options });
        return Promise.resolve({
          entries: [],
          nextCursor: null,
          hasMore: false,
          watermark: '0',
          actors: [],
        } as never);
      },
    };
    const chat = {
      chatId: ADVISOR_CHAT,
      displayName: 'Orchestrator',
      authorDetails: {
        harness: null,
        model: null,
        thinkingEffort: null,
        mode: null,
        pipelineExecutionId: null,
        settingsRevision: null,
        unavailableReason: 'not_recorded' as const,
      },
    };
    await expect(
      addLedgerEntryAsChat(
        dispatcher as never,
        chat,
        SCOPE,
        'advisor:key-1',
        { type: 'DECISION', title: 'T', content: 'C', owner: 'self' },
        host,
      ),
    ).resolves.toMatchObject({ status: 'ok' });
    await expect(
      searchLedgerEntriesAsChat(
        dispatcher as never,
        chat,
        SCOPE,
        { sort: 'created_desc', limit: 20 },
        host,
      ),
    ).resolves.toMatchObject({ status: 'ok' });
    for (const registration of registrations)
      expect(registration).toMatchObject({
        container: {
          kind: 'code_worktree',
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
        },
        actor: {
          kind: 'chat',
          originKey: ADVISOR_CHAT,
          displayName: 'Orchestrator',
        },
        role: 'interactive_chat',
      });
    expect(calls).toMatchObject([
      {
        name: 'core.ledger.entry.add',
        caller: { principalId: 'binding-1', grants: ['core.ledger.write'] },
        metadata: { idempotencyKey: 'advisor:key-1' },
      },
      {
        name: 'core.ledger.entries.search',
        caller: { principalId: 'binding-2', grants: ['core.ledger.read'] },
      },
    ]);
    expect(calls[1]).not.toHaveProperty('metadata');
    expect(revoked).toEqual(['binding-1', 'binding-2']);
  });
});

describe("an advisor's Feed entry in other work opens its chat (CAN-6007)", () => {
  it('resolves a chat the entry scope lacks to the App Advisor work entry holding it', async () => {
    const { resolveLedgerViewSource } = jest.requireActual<
      typeof SourceResolverModule
    >('../../ledger/source-resolver');
    const origin = {
      kind: 'chat' as const,
      ledgerId: '00000000-0000-4000-8000-000000000001',
      chatId: ADVISOR_CHAT,
    };
    const advisorScope = {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-1',
    };
    const host: SourceResolverModule.LedgerSourceHost = {
      chatPresence: (scope) =>
        Promise.resolve(
          scope.projectId === APP_ADVISOR_PROJECT_ID ? 'live' : 'missing',
        ),
      keptExecution: () => Promise.resolve(null),
      summarySnapshot: () => Promise.resolve(null),
      advisorChatScope: (chatId) =>
        Promise.resolve(chatId === ADVISOR_CHAT ? advisorScope : null),
    };
    await expect(resolveLedgerViewSource(SCOPE, origin, host)).resolves.toEqual(
      {
        availability: 'available',
        target: {
          kind: 'chat',
          ...advisorScope,
          chatId: ADVISOR_CHAT,
          archived: false,
        },
      },
    );
    await expect(
      resolveLedgerViewSource(SCOPE, { ...origin, chatId: 'gone' }, host),
    ).resolves.toEqual({ availability: 'deleted', target: null });
    // Another App Advisor work entry's Feed resolves the same way.
    await expect(
      resolveLedgerViewSource(
        { projectId: APP_ADVISOR_PROJECT_ID, worktreeId: 'entry-2' },
        origin,
        {
          ...host,
          chatPresence: (scope) =>
            Promise.resolve(
              scope.worktreeId === 'entry-1' ? 'live' : 'missing',
            ),
        },
      ),
    ).resolves.toMatchObject({
      availability: 'available',
      target: { worktreeId: 'entry-1', chatId: ADVISOR_CHAT },
    });
  });
});
