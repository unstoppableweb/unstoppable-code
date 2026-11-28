import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CanopyCallerDescriptor,
  TurnOrigin,
} from '@canopy/protocol/canopy-core';
import type {
  ChatCommand,
  ChatCommandRequest,
  ChatCommandResult,
  ChatStateChangedEvent,
} from '@canopy/desktop-shared/types';
import {
  createChatStateServiceFixture,
  type ChatStateServiceFixture,
} from '../../__tests__/helpers/chat-state-service-fixture';
import {
  flushTurnState,
  observeTurn,
  turnEnded,
  turnStarted,
} from '../../__tests__/helpers/turn-lifecycle-events';
import {
  createChatCommandDispatchOptions,
  dispatchTrustedChatCommand,
} from '../../canopy-runtime/core-chat-command-adapter';
import { createCoreOperationAdapter } from '../../canopy-runtime/core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import {
  AUTO_ARCHIVE_MAX_ATTEMPTS,
  AUTO_ARCHIVE_MAX_CONFLICTS,
  ChatAutoArchiver,
  onCommittedArchiveUnblocks,
  type ChatAutoArchiveHost,
} from '../chat-auto-archive';
import { setChatStateCommandPort } from '../../ipc/chat-state';
import { resetChatStateServiceForTests } from '../chat-state-service';
import type { ChatTurnStateCommit } from '../chat-turn-state-handoff';

// Derived search owns a packaged worker; this golden runs the canonical store
// from source, as the archive-effects golden does.
const mockSearch = { worktreeChatArchived: jest.fn() };
jest.mock('../../chat-search/service', () => ({
  getChatSearchService: (): typeof mockSearch => mockSearch,
}));

const SCOPE = { projectId: 'project-1', worktreeId: 'worktree-1' };
const CHAT = { ...SCOPE, chatId: 'chat-1' };
const CALLER: CanopyCallerDescriptor = {
  principalId: 'desktop-main-auto-archive',
  clientInstanceId: 'desktop-main-chat',
  authorityId: 'local',
  interfaceKind: 'desktop',
  grants: ['core.chat.write'],
};

let fixture: ChatStateServiceFixture;
let runtime: DesktopCanopyDispatcher;
let archiver: ChatAutoArchiver;
let ledgerDir: string;
let instructions: string[];
let warnings: string[];
let locked: boolean;
let closeBlocked: boolean;
let inFlight: boolean;
let awaitingWatcher: boolean;
let watcherChecks: number;
let refuseArchive: boolean;
let conflictsLeft: number;
let sequence = 0;

function host(
  overrides: Partial<ChatAutoArchiveHost> = {},
): ChatAutoArchiveHost {
  const service = fixture.service;
  return {
    onTurnStateCommitted: (listener) => service.onTurnStateCommitted(listener),
    onUnblocked: (listener) =>
      onCommittedArchiveUnblocks(
        (changed) => service.subscribe(changed),
        listener,
      ),
    readSnapshot: (scope) => service.getCommittedWatcherSnapshot(scope),
    closeBlocked: () => closeBlocked,
    locked: () => locked,
    dispatchInFlight: () => inFlight,
    awaitsWatcher: () => {
      watcherChecks += 1;
      return Promise.resolve(awaitingWatcher);
    },
    dispatch: (request): Promise<ChatCommandResult> => {
      if (conflictsLeft > 0 && request.command.type === 'chat.archive_tab') {
        conflictsLeft -= 1;
        return Promise.resolve({
          schemaVersion: 1,
          commandId: request.commandId,
          revision: 0,
          outcome: 'conflict',
          reason: 'another commit landed',
        } as ChatCommandResult);
      }
      if (refuseArchive && request.command.type === 'chat.archive_tab')
        return Promise.resolve({
          schemaVersion: 1,
          commandId: request.commandId,
          revision: 0,
          outcome: 'rejected',
          reason: 'store refused',
        } as ChatCommandResult);
      return dispatchTrustedChatCommand(
        request,
        createChatCommandDispatchOptions(service, runtime, CALLER),
      );
    },
    warn: (message) => {
      warnings.push(message);
    },
    ...overrides,
  };
}

async function command(
  commandId: string,
  body: ChatCommand,
): Promise<ChatCommandResult> {
  const request: ChatCommandRequest = {
    schemaVersion: 1,
    commandId,
    ...SCOPE,
    command: body,
  };
  return fixture.service.command(request);
}

async function mark(chatId = 'chat-1'): Promise<void> {
  const result = await command(`mark-${chatId}-${(sequence += 1)}`, {
    type: 'chat.patch_tab_settings',
    tabId: chatId,
    patch: { autoArchive: true },
  });
  expect(result.outcome).toBe('applied');
}

interface TurnFields {
  chat: { projectId: string; worktreeId: string; chatId: string };
  turnId: string;
  userMessageIds: string[];
  atMs: number;
  origin?: TurnOrigin;
}

/** Sends a prompt and starts the canonical turn bound to it. */
async function begin(
  turnId: string,
  options: { chatId?: string; origin?: TurnOrigin } = {},
): Promise<TurnFields> {
  const chat = { ...SCOPE, chatId: options.chatId ?? 'chat-1' };
  const userMessageId = `${turnId}-user`;
  const sent = await command(`send-${turnId}`, {
    type: 'chat.send_message',
    chatId: chat.chatId,
    userMessageId,
    text: 'Go',
  });
  expect(sent.outcome).toBe('applied');
  const fields: TurnFields = {
    chat,
    turnId,
    userMessageIds: [userMessageId],
    atMs: 1_786_104_000_000 + sequence,
    ...(options.origin ? { origin: options.origin } : {}),
  };
  await observeTurn(
    fixture.service,
    turnStarted(chat, { ...fields, sequence: (sequence += 1) }),
  );
  return fields;
}

/** The provider's output and root terminal for a turn that completes. */
async function reply(fields: TurnFields): Promise<void> {
  const [userMessageId] = fields.userMessageIds;
  for (const data of [
    {
      type: 'assistant',
      canopy_turn_user_message_id: userMessageId,
      message: {
        id: `${fields.turnId}-reply`,
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
      },
    },
    {
      type: 'result',
      is_error: false,
      result: 'Done',
      canopy_turn_user_message_id: userMessageId,
    },
  ])
    await fixture.service.ingestProviderEvent({
      ...fields.chat,
      turnUserMessageId: userMessageId,
      mutationId: `${fields.turnId}-${data.type}`,
      data,
    });
}

/** Ends a begun turn; a completed one first reduces its output and terminal. */
async function finish(
  fields: TurnFields,
  outcome: 'completed' | 'cancelled' | 'failed',
): Promise<void> {
  if (outcome === 'completed') await reply(fields);
  await observeTurn(
    fixture.service,
    turnEnded(fields.chat, { ...fields, sequence: (sequence += 1), outcome }),
  );
  await archiver.settled();
}

async function turn(
  turnId: string,
  outcome: 'completed' | 'cancelled' | 'failed',
  options: { chatId?: string; origin?: TurnOrigin } = {},
): Promise<void> {
  await finish(await begin(turnId, options), outcome);
}

async function owner(): Promise<string | undefined> {
  const snapshot = await fixture.service.getState(SCOPE);
  return snapshot.tabsFile.tabs.find((tab) => tab.id === 'chat-1')
    ?.autoArchiveTurnId;
}

async function state(): Promise<{
  live: Array<{ id: string; autoArchive?: boolean }>;
  archived: Array<{ chatId: string; unread?: boolean }>;
}> {
  const snapshot = await fixture.service.getState(SCOPE);
  return {
    live: snapshot.tabsFile.tabs.map((tab) => ({
      id: tab.id,
      ...(tab.autoArchive ? { autoArchive: tab.autoArchive } : {}),
    })),
    archived: snapshot.archives.map((entry) => ({
      chatId: entry.chatId,
      ...(entry.unread ? { unread: entry.unread } : {}),
    })),
  };
}

beforeEach(async () => {
  ledgerDir = mkdtempSync(join(tmpdir(), 'auto-archive-ledger-'));
  fixture = createChatStateServiceFixture();
  resetChatStateServiceForTests(fixture.service);
  setChatStateCommandPort(fixture.service);
  runtime = createDesktopRuntime({
    operationAdapter: createCoreOperationAdapter({
      ledgerPath: () => join(ledgerDir, 'ledger.sqlite'),
    }),
    chatCommandPort: fixture.service,
    shutdownTimeoutMs: 25,
  });
  const instruction = runtime.instruction.bind(runtime);
  instructions = [];
  jest
    .spyOn(runtime, 'instruction')
    .mockImplementation((name, params, options) => {
      instructions.push(name);
      return instruction(name, params, options);
    });
  warnings = [];
  locked = false;
  closeBlocked = false;
  inFlight = false;
  awaitingWatcher = false;
  watcherChecks = 0;
  refuseArchive = false;
  conflictsLeft = 0;
  await fixture.createChat(SCOPE);
  archiver = new ChatAutoArchiver(host());
  archiver.start();
});

afterEach(async () => {
  archiver.stop();
  setChatStateCommandPort(null);
  await runtime.shutdown();
  await fixture.dispose();
  rmSync(ledgerDir, { recursive: true, force: true });
});

describe('main archives auto-archive chats at a completed turn (CAN-6014)', () => {
  it('archives a marked chat once its turn completes, through core.chat.archive, unread, with no window and restorable', async () => {
    await mark();
    await turn('turn-1', 'completed');
    expect(await state()).toEqual({
      live: [],
      archived: [{ chatId: 'chat-1', unread: true }],
    });
    expect(instructions).toContain('core.chat.archive');
    const snapshot = await fixture.service.getState(SCOPE);
    const entry = snapshot.archives[0];
    if (!entry) throw new Error('no archive entry');
    await expect(
      command('restore', {
        type: 'chat.restore_archive',
        archiveEntryId: entry.chatId,
      }),
    ).resolves.toMatchObject({ outcome: 'applied' });
    expect((await state()).live.map((tab) => tab.id)).toEqual(['chat-1']);
  });

  it('with a window attached, the chat is archived exactly once and the renderer has no archive path of its own', async () => {
    const archives: string[] = [];
    // The window's stream of committed changes, as the renderer receives it.
    const unsubscribe = fixture.service.subscribe(
      (event: ChatStateChangedEvent) => {
        for (const change of event.changes)
          if (change.type === 'archive.upserted') archives.push(change.type);
      },
    );
    await mark();
    await turn('turn-1', 'completed');
    unsubscribe();
    expect(archives).toEqual(['archive.upserted']);
    expect((await state()).archived).toHaveLength(1);
    expect(
      instructions.filter((name) => name === 'core.chat.archive'),
    ).toHaveLength(1);
    // Only the user's archive actions remain in the renderer: none keeps the
    // session or reads the marker, so a window cannot archive alongside main.
    const renderer = join(__dirname, '../../../renderer/src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== '__tests__') walk(path);
        } else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    walk(renderer);
    const offending = files.filter((path) => {
      const source = readFileSync(path, 'utf8');
      return (
        source.includes('keepSession') ||
        source.includes('autoArchiveChatTab') ||
        source.includes('scheduleCanonicalAutoArchives')
      );
    });
    expect(offending).toEqual([]);
  });

  it('archives only the chat whose own marker is set', async () => {
    await command('create-2', {
      type: 'chat.create_tab',
      tabId: 'chat-2',
      title: 'Second',
      providerType: 'claude',
      model: 'claude-opus-4-6',
    });
    await mark('chat-1');
    await turn('turn-2', 'completed', { chatId: 'chat-2' });
    expect(await state()).toEqual({
      live: [{ id: 'chat-1', autoArchive: true }, { id: 'chat-2' }],
      archived: [],
    });
  });

  it.each([['cancelled' as const], ['failed' as const]])(
    'a %s turn never archives and clears the marker',
    async (outcome) => {
      await mark();
      await turn('turn-1', outcome);
      expect(await state()).toEqual({ live: [{ id: 'chat-1' }], archived: [] });
      expect(instructions).not.toContain('core.chat.archive');
    },
  );

  it("a resumed turn after a restart drops the interrupted turn's marker and never archives", async () => {
    await begin('turn-1');
    await mark();
    await turn('turn-1-resumed', 'completed', { origin: 'restart' });
    expect(await state()).toEqual({ live: [{ id: 'chat-1' }], archived: [] });
    expect(instructions).not.toContain('core.chat.archive');
  });

  it("a newer turn drops an older turn's marker without archiving", async () => {
    locked = true;
    const first = await begin('turn-1');
    await mark();
    await finish(first, 'completed');
    expect(await owner()).toBe('turn-1');
    locked = false;
    await turn('turn-2', 'completed');
    expect(await state()).toEqual({ live: [{ id: 'chat-1' }], archived: [] });
    expect(instructions).not.toContain('core.chat.archive');
  });

  it('a marker with no owning turn never archives on its own; the next turn that starts adopts it', async () => {
    // A hook chat's creation, or a marker stored before owners existed,
    // writes the marker without a turn.
    await turn('turn-1', 'completed');
    await fixture.repository.transact(
      SCOPE,
      [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat-1',
          patch: { autoArchive: true },
        },
      ],
      { source: 'migration' },
    );
    // A dismissed question re-checks the chat.
    await fixture.service.upsertPendingQuestion(SCOPE, {
      requestId: 'q-unowned',
      chatId: 'chat-1',
      delivery: 'async',
      questions: [],
    });
    await command('dismiss-unowned', {
      type: 'chat.dismiss_question',
      chatId: 'chat-1',
      questionId: 'q-unowned',
    });
    await archiver.settled();
    expect((await state()).archived).toEqual([]);
    expect(await owner()).toBeUndefined();
    const second = await begin('turn-2');
    expect(await owner()).toBe('turn-2');
    await finish(second, 'completed');
    expect(await state()).toEqual({
      live: [],
      archived: [{ chatId: 'chat-1', unread: true }],
    });
  });

  it('only main records the owning turn: a settings patch that names one is refused', async () => {
    const refused = await fixture.service.command({
      schemaVersion: 1,
      commandId: 'forge-owner',
      ...SCOPE,
      command: {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { autoArchive: true, autoArchiveTurnId: 'turn-9' } as never,
      },
    });
    expect(refused.outcome).toBe('rejected');
    expect(await state()).toEqual({ live: [{ id: 'chat-1' }], archived: [] });
  });

  it('never archives while the chat is locked, a send is in flight, or it has an open question, a pending plan exit, queued input or close-blocking work', async () => {
    // Each gate opens while its turn runs, as it does in use: a new prompt
    // retires a pending plan exit, and only a proposal outlives the turn's
    // root terminal. Each turn sets its own marker, as the next one drops it.
    const gated = async (
      turnId: string,
      open: () => Promise<unknown>,
      close: () => Promise<unknown>,
    ): Promise<void> => {
      const fields = await begin(turnId);
      await mark();
      await open();
      await finish(fields, 'completed');
      expect(await state()).toEqual({
        live: [{ id: 'chat-1', autoArchive: true }],
        archived: [],
      });
      await close();
    };
    const flag = (
      set: (value: boolean) => void,
    ): { open: () => Promise<void>; close: () => Promise<void> } => ({
      open: (): Promise<void> => Promise.resolve(set(true)),
      close: (): Promise<void> => Promise.resolve(set(false)),
    });
    for (const [turnId, gate] of [
      ['t-locked', flag((value) => (locked = value))],
      ['t-blocked', flag((value) => (closeBlocked = value))],
      ['t-sending', flag((value) => (inFlight = value))],
    ] as const)
      await gated(turnId, gate.open, gate.close);
    await gated(
      't-question',
      () =>
        fixture.service.upsertPendingQuestion(SCOPE, {
          requestId: 'q1',
          chatId: 'chat-1',
          delivery: 'async',
          questions: [],
        }),
      () =>
        fixture.repository.transact(
          SCOPE,
          [
            {
              type: 'pending_question.removed',
              chatId: 'chat-1',
              requestId: 'q1',
            },
          ],
          { source: 'migration' },
        ),
    );
    const planExit =
      (pendingPlanExit: { plan: string; reviewMode: string } | null) =>
      (): Promise<unknown> =>
        fixture.repository.transact(
          SCOPE,
          [
            {
              type: 'tab.metadata_patched',
              tabId: 'chat-1',
              patch: { pendingPlanExit },
            },
          ],
          { source: 'migration' },
        );
    await gated(
      't-plan',
      planExit({ plan: 'p', reviewMode: 'proposal' }),
      planExit(null),
    );
    await gated(
      't-queued',
      async () => {
        const runtime = (await fixture.service.getState(SCOPE)).runtimeByChatId[
          'chat-1'
        ];
        if (!runtime) throw new Error('no runtime');
        return fixture.repository.transact(
          SCOPE,
          [
            {
              type: 'runtime.patched',
              chatId: 'chat-1',
              runtime: { ...runtime, queuedMessageIds: ['m-queued'] },
            },
          ],
          { source: 'migration' },
        );
      },
      () => Promise.resolve(),
    );
    expect(instructions).not.toContain('core.chat.archive');
  }, 30_000);

  it("never archives a chat an active watcher notifies; the notification's turn drops the marker, so the chat stays open", async () => {
    // An unmarked chat never lists watchers.
    await turn('t-unmarked', 'completed');
    expect(watcherChecks).toBe(0);
    awaitingWatcher = true;
    await mark();
    await turn('t-ack', 'completed');
    expect(watcherChecks).toBe(1);
    expect(await state()).toEqual({
      live: [{ id: 'chat-1', autoArchive: true }],
      archived: [],
    });
    // The watcher fires: its message starts a newer turn in the open chat.
    awaitingWatcher = false;
    await turn('t-result', 'completed');
    expect(await state()).toEqual({ live: [{ id: 'chat-1' }], archived: [] });
    expect(instructions).not.toContain('core.chat.archive');
  });

  it(`a refused archive keeps the marker, warns, retries at the next committed idle and stops after ${String(AUTO_ARCHIVE_MAX_ATTEMPTS)} tries`, async () => {
    archiver.stop();
    const listeners: Array<(commit: ChatTurnStateCommit) => void> = [];
    const dispatched: string[] = [];
    const inner = host();
    archiver = new ChatAutoArchiver({
      ...inner,
      onTurnStateCommitted: (listener) => {
        listeners.push(listener);
        return (): void => undefined;
      },
      dispatch: (request): Promise<ChatCommandResult> => {
        dispatched.push(request.command.type);
        return inner.dispatch(request);
      },
    });
    archiver.start();
    await mark();
    refuseArchive = true;
    // The real turn the idle reports; this archiver only hears the test's idles.
    await turn('turn-1', 'completed');
    const idle: ChatTurnStateCommit = {
      scope: CHAT,
      generation: 1,
      effects: [{ type: 'chat.idle' }],
      state: {
        phase: 'idle',
        decisionPending: false,
        catchingUp: false,
        endedTurnIds: ['turn-1'],
        background: { native: [], managed: { live: 0, queued: 0 } },
        lastEnded: {
          id: 'turn-1',
          origin: 'user',
          startedAtMs: 1,
          endedAtMs: 2,
          outcome: 'completed',
          pauses: [],
        },
      },
    };
    for (let i = 0; i < AUTO_ARCHIVE_MAX_ATTEMPTS + 2; i += 1) {
      for (const listener of listeners) listener(idle);
      await archiver.settled();
    }
    expect(dispatched).toEqual(
      Array.from(
        { length: AUTO_ARCHIVE_MAX_ATTEMPTS },
        () => 'chat.archive_tab',
      ),
    );
    expect(warnings).toHaveLength(AUTO_ARCHIVE_MAX_ATTEMPTS);
    expect(warnings.at(-1)).toMatch(/gave up/);
    expect(await state()).toEqual({
      live: [{ id: 'chat-1', autoArchive: true }],
      archived: [],
    });
  });

  it('a stale check of an earlier completed turn never archives after a later turn was cancelled', async () => {
    archiver.stop();
    const listeners: Array<(commit: ChatTurnStateCommit) => void> = [];
    const dispatched: string[] = [];
    const inner = host();
    archiver = new ChatAutoArchiver({
      ...inner,
      onTurnStateCommitted: (listener) => {
        listeners.push(listener);
        return (): void => undefined;
      },
      // turn-1's root terminal reduction would otherwise recheck the chat,
      // and archive it rightly if that read lands after turn-1 ends; only the
      // stale idle below may reach this archiver.
      onUnblocked: () => (): void => undefined,
      dispatch: (request): Promise<ChatCommandResult> => {
        dispatched.push(request.command.type);
        return inner.dispatch(request);
      },
    });
    archiver.start();
    await mark();
    // The real chat's last turn was cancelled after turn-1 completed.
    await turn('turn-1', 'completed');
    expect((await state()).archived).toEqual([]);
    await turn('turn-2', 'cancelled');
    await mark();
    const staleIdle: ChatTurnStateCommit = {
      scope: CHAT,
      generation: 1,
      effects: [{ type: 'chat.idle' }],
      state: {
        phase: 'idle',
        decisionPending: false,
        catchingUp: false,
        endedTurnIds: ['turn-1'],
        background: { native: [], managed: { live: 0, queued: 0 } },
        lastEnded: {
          id: 'turn-1',
          origin: 'user',
          startedAtMs: 1,
          endedAtMs: 2,
          outcome: 'completed',
          pauses: [],
        },
      },
    };
    for (const listener of listeners) listener(staleIdle);
    await archiver.settled();
    expect(dispatched).toEqual([]);
    expect((await state()).archived).toEqual([]);
  });

  it("archiving the active marked chat leaves its successor's unread state alone", async () => {
    await command('create-2', {
      type: 'chat.create_tab',
      tabId: 'chat-2',
      title: 'Second',
      providerType: 'claude',
      model: 'claude-opus-4-6',
    });
    await command('unread-2', { type: 'chat.mark_unread', chatId: 'chat-2' });
    await command('activate-1', { type: 'chat.activate_tab', tabId: 'chat-1' });
    await mark();
    await turn('turn-1', 'completed');
    const snapshot = await fixture.service.getState(SCOPE);
    expect(snapshot.archives.map((entry) => entry.chatId)).toEqual(['chat-1']);
    const successor = snapshot.tabsFile.tabs.find((tab) => tab.id === 'chat-2');
    expect(successor?.unread).toBe(true);
    expect(successor?.attentionDismissedAt).toBeUndefined();
  });

  it('an archive refused because another commit landed is retried at once, since a completed chat has no later idle', async () => {
    await mark();
    conflictsLeft = 1;
    await turn('turn-1', 'completed');
    expect(await state()).toEqual({
      live: [],
      archived: [{ chatId: 'chat-1', unread: true }],
    });
    expect(
      instructions.filter((name) => name === 'core.chat.archive'),
    ).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it(`conflicts from other commits in the scope never spend the ${String(AUTO_ARCHIVE_MAX_ATTEMPTS)}-try budget`, async () => {
    conflictsLeft = AUTO_ARCHIVE_MAX_CONFLICTS - 1;
    const first = await begin('turn-1');
    await mark();
    await finish(first, 'completed');
    expect(await state()).toEqual({
      live: [],
      archived: [{ chatId: 'chat-1', unread: true }],
    });
    expect(warnings).toEqual([]);
  });

  it('a marker set while idle is never adopted by the turn that just ended', async () => {
    const first = await begin('turn-1');
    await reply(first);
    // turn-1's end is still pending when the user turns auto-archive on.
    fixture.service.observeTurnLifecycle(
      turnEnded(first.chat, { ...first, sequence: (sequence += 1) }),
    );
    await mark();
    await flushTurnState(fixture.service);
    await archiver.settled();
    expect(await state()).toEqual({
      live: [{ id: 'chat-1', autoArchive: true }],
      archived: [],
    });
    expect(await owner()).toBeUndefined();
    expect(instructions).not.toContain('core.chat.archive');
    await turn('turn-2', 'completed');
    expect(await state()).toEqual({
      live: [],
      archived: [{ chatId: 'chat-1', unread: true }],
    });
  });

  it("a turn that starts before main's archiver runs never inherits a failed turn's marker", async () => {
    // The commit that fails turn-1 clears the marker, so the archiver's
    // timing doesn't matter.
    archiver.stop();
    const first = await begin('turn-1');
    await mark();
    await finish(first, 'failed');
    expect(await state()).toEqual({ live: [{ id: 'chat-1' }], archived: [] });
    const second = await begin('turn-2');
    archiver.start();
    await finish(second, 'completed');
    expect(await state()).toEqual({ live: [{ id: 'chat-1' }], archived: [] });
    expect(instructions).not.toContain('core.chat.archive');
  });

  it.each([['cancelled' as const], ['failed' as const]])(
    'a marker set in the same commit as a %s ending is cleared with it',
    async (outcome) => {
      const first = await begin('turn-1');
      // The ending is still pending when turn-1's SetAutoArchive event
      // commits, so that transaction carries both.
      fixture.service.observeTurnLifecycle(
        turnEnded(first.chat, { ...first, sequence: (sequence += 1), outcome }),
      );
      await fixture.service.ingestProviderEvent({
        ...first.chat,
        turnUserMessageId: 'turn-1-user',
        mutationId: 'set-auto-archive-at-end',
        data: {
          type: 'canopy_set_auto_archive_requested',
          enabled: true,
          canopy_turn_user_message_id: 'turn-1-user',
        },
      });
      await flushTurnState(fixture.service);
      await archiver.settled();
      expect(await state()).toEqual({ live: [{ id: 'chat-1' }], archived: [] });
      await turn('turn-2', 'completed');
      expect(await state()).toEqual({ live: [{ id: 'chat-1' }], archived: [] });
      expect(instructions).not.toContain('core.chat.archive');
    },
  );

  it("a newer turn's marker set in the commit that fails an older turn survives and archives with it", async () => {
    const first = await begin('turn-1');
    await command('send-turn-2', {
      type: 'chat.send_message',
      chatId: 'chat-1',
      userMessageId: 'turn-2-user',
      text: 'Next',
    });
    const second: TurnFields = {
      chat: first.chat,
      turnId: 'turn-2',
      userMessageIds: ['turn-2-user'],
      atMs: first.atMs + 10,
    };
    // One stalled handoff: turn-1's failed end, turn-2's start and turn-2's
    // SetAutoArchive commit together.
    fixture.service.observeTurnLifecycle(
      turnEnded(first.chat, {
        ...first,
        sequence: (sequence += 1),
        outcome: 'failed',
      }),
    );
    fixture.service.observeTurnLifecycle(
      turnStarted(second.chat, { ...second, sequence: (sequence += 1) }),
    );
    await fixture.service.ingestProviderEvent({
      ...first.chat,
      turnUserMessageId: 'turn-2-user',
      mutationId: 'turn-2-sets-auto-archive',
      data: {
        type: 'canopy_set_auto_archive_requested',
        enabled: true,
        canopy_turn_user_message_id: 'turn-2-user',
      },
    });
    await flushTurnState(fixture.service);
    expect(await owner()).toBe('turn-2');
    await finish(second, 'completed');
    expect(await state()).toEqual({
      live: [],
      archived: [{ chatId: 'chat-1', unread: true }],
    });
  });

  it("a newer turn that starts and ends in one commit drops the older turn's marker", async () => {
    locked = true;
    const first = await begin('turn-1');
    await mark();
    await finish(first, 'completed');
    locked = false;
    expect(await owner()).toBe('turn-1');
    await command('send-turn-2', {
      type: 'chat.send_message',
      chatId: 'chat-1',
      userMessageId: 'turn-2-user',
      text: 'Next',
    });
    const second: TurnFields = {
      chat: first.chat,
      turnId: 'turn-2',
      userMessageIds: ['turn-2-user'],
      atMs: first.atMs + 10,
    };
    fixture.service.observeTurnLifecycle(
      turnStarted(second.chat, { ...second, sequence: (sequence += 1) }),
    );
    fixture.service.observeTurnLifecycle(
      turnEnded(second.chat, { ...second, sequence: (sequence += 1) }),
    );
    await reply(second);
    await flushTurnState(fixture.service);
    await archiver.settled();
    expect(await state()).toEqual({ live: [{ id: 'chat-1' }], archived: [] });
    expect(instructions).not.toContain('core.chat.archive');
  });

  it("a newer turn's repeated SetAutoArchive takes the marker, so the older turn's failure leaves it", async () => {
    const first = await begin('turn-1');
    const setBy = (userMessageId: string): Promise<unknown> =>
      fixture.service.ingestProviderEvent({
        ...first.chat,
        turnUserMessageId: userMessageId,
        mutationId: `set-auto-archive-${userMessageId}`,
        data: {
          type: 'canopy_set_auto_archive_requested',
          enabled: true,
          canopy_turn_user_message_id: userMessageId,
        },
      });
    await setBy('turn-1-user');
    expect(await owner()).toBe('turn-1');
    await command('send-turn-2', {
      type: 'chat.send_message',
      chatId: 'chat-1',
      userMessageId: 'turn-2-user',
      text: 'Next',
    });
    const second: TurnFields = {
      chat: first.chat,
      turnId: 'turn-2',
      userMessageIds: ['turn-2-user'],
      atMs: first.atMs + 10,
    };
    fixture.service.observeTurnLifecycle(
      turnEnded(first.chat, {
        ...first,
        sequence: (sequence += 1),
        outcome: 'failed',
      }),
    );
    fixture.service.observeTurnLifecycle(
      turnStarted(second.chat, { ...second, sequence: (sequence += 1) }),
    );
    await setBy('turn-2-user');
    await flushTurnState(fixture.service);
    expect(await owner()).toBe('turn-2');
    await finish(second, 'completed');
    expect(await state()).toEqual({
      live: [],
      archived: [{ chatId: 'chat-1', unread: true }],
    });
  });

  it("a fresh start that restores an archived chat drops its archived turn's marker", async () => {
    const first = await begin('turn-1');
    await mark();
    await finish(first, 'completed');
    expect((await state()).archived).toEqual([
      { chatId: 'chat-1', unread: true },
    ]);
    // A fresh canonical start stays staged until output restores the chat,
    // so the restore and the start commit together.
    const wake: TurnFields = {
      chat: first.chat,
      turnId: 'turn-wake',
      userMessageIds: [],
      atMs: first.atMs + 10,
    };
    await observeTurn(
      fixture.service,
      turnStarted(wake.chat, { ...wake, sequence: (sequence += 1) }),
    );
    await fixture.service.ingestProviderEvent({
      ...wake.chat,
      mutationId: 'wake-output',
      data: {
        type: 'assistant',
        message: {
          id: 'wake-reply',
          role: 'assistant',
          content: [{ type: 'text', text: 'Woke up' }],
        },
      },
    });
    await archiver.settled();
    expect(await state()).toEqual({ live: [{ id: 'chat-1' }], archived: [] });
    await observeTurn(
      fixture.service,
      turnEnded(wake.chat, { ...wake, sequence: (sequence += 1) }),
    );
    await archiver.settled();
    expect(await state()).toEqual({ live: [{ id: 'chat-1' }], archived: [] });
  });

  it('in a commit that batches several turns, the first turn adopts an idle marker and settles it', async () => {
    const chat = { ...SCOPE, chatId: 'chat-1' };
    type Outcome = 'completed' | 'cancelled' | 'failed';
    const batch = async (ends: Array<[string, Outcome]>): Promise<void> => {
      const turns: Array<[TurnFields, Outcome]> = [];
      for (const [turnId, outcome] of ends) {
        const userMessageId = `${turnId}-user`;
        await command(`send-${turnId}`, {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId,
          text: 'Go',
        });
        turns.push([
          {
            chat,
            turnId,
            userMessageIds: [userMessageId],
            atMs: 1_786_104_000_000 + sequence,
          },
          outcome,
        ]);
      }
      for (const [fields, outcome] of turns) {
        fixture.service.observeTurnLifecycle(
          turnStarted(chat, { ...fields, sequence: (sequence += 1) }),
        );
        fixture.service.observeTurnLifecycle(
          turnEnded(chat, { ...fields, sequence: (sequence += 1), outcome }),
        );
      }
      // The first event's transaction commits every pending ending at once.
      for (const [fields, outcome] of turns)
        if (outcome === 'completed') await reply(fields);
      await flushTurnState(fixture.service);
      await archiver.settled();
    };
    // turn-1 adopts the marker and is cancelled, so the commit clears it; a
    // later turn completing doesn't bring it back.
    await mark();
    await batch([
      ['turn-1', 'cancelled'],
      ['turn-2', 'completed'],
    ]);
    expect(await state()).toEqual({ live: [{ id: 'chat-1' }], archived: [] });
    await turn('turn-3', 'completed');
    expect(await state()).toEqual({ live: [{ id: 'chat-1' }], archived: [] });
    // turn-4 adopts the marker and completes in the batch, so it archives.
    await mark();
    await batch([['turn-4', 'completed']]);
    expect(await state()).toEqual({
      live: [],
      archived: [{ chatId: 'chat-1', unread: true }],
    });
  });

  it('an empty completion fails its turn, so it never archives and clears the marker', async () => {
    const chat = { ...SCOPE, chatId: 'chat-1' };
    await mark();
    const sent = await command('send-empty', {
      type: 'chat.send_message',
      chatId: 'chat-1',
      userMessageId: 'user-empty',
      text: 'Answer this',
    });
    expect(sent.outcome).toBe('applied');
    const fields = {
      turnId: 'turn-empty',
      userMessageIds: ['user-empty'],
      atMs: 1_786_104_000_000,
    };
    await observeTurn(
      fixture.service,
      turnStarted(chat, { ...fields, sequence: (sequence += 1) }),
    );
    await fixture.service.ingestProviderEvent({
      ...chat,
      turnUserMessageId: 'user-empty',
      mutationId: 'empty-result',
      data: {
        type: 'result',
        is_error: false,
        result: '',
        canopy_turn_user_message_id: 'user-empty',
      },
    });
    await observeTurn(
      fixture.service,
      turnEnded(chat, { ...fields, sequence: (sequence += 1) }),
    );
    await archiver.settled();
    expect(await state()).toEqual({ live: [{ id: 'chat-1' }], archived: [] });
    expect(instructions).not.toContain('core.chat.archive');
    const snapshot = await fixture.service.getState(SCOPE);
    expect(snapshot.runtimeByChatId['chat-1']?.error?.code).toBe(
      'empty_completion',
    );
  });

  it('waits for the root terminal, so an empty completion that ends before it is classified never archives', async () => {
    await mark();
    const fields = await begin('turn-empty');
    await observeTurn(
      fixture.service,
      turnEnded(fields.chat, { ...fields, sequence: (sequence += 1) }),
    );
    await archiver.settled();
    expect(await state()).toEqual({
      live: [{ id: 'chat-1', autoArchive: true }],
      archived: [],
    });
    await fixture.service.ingestProviderEvent({
      ...fields.chat,
      turnUserMessageId: 'turn-empty-user',
      mutationId: 'late-empty-result',
      data: {
        type: 'result',
        is_error: false,
        result: '',
        canopy_turn_user_message_id: 'turn-empty-user',
      },
    });
    await archiver.settled();
    expect(await state()).toEqual({ live: [{ id: 'chat-1' }], archived: [] });
    expect(instructions).not.toContain('core.chat.archive');
  });

  it('dismissing the async question that held a completed turn archives the chat', async () => {
    await mark();
    await fixture.service.upsertPendingQuestion(SCOPE, {
      requestId: 'q1',
      chatId: 'chat-1',
      delivery: 'async',
      questions: [],
    });
    await turn('turn-1', 'completed');
    expect(await state()).toEqual({
      live: [{ id: 'chat-1', autoArchive: true }],
      archived: [],
    });
    const dismissed = await command('dismiss-q1', {
      type: 'chat.dismiss_question',
      chatId: 'chat-1',
      questionId: 'q1',
    });
    expect(dismissed.outcome).toBe('applied');
    await archiver.settled();
    expect(await state()).toEqual({
      live: [],
      archived: [{ chatId: 'chat-1', unread: true }],
    });
  });
});
