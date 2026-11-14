import { STANDALONE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import { currentAgentWorkerContext } from '../../agent-runs/agent-worker-context';
import type { AgentSession } from '../../agents/types';
import type { inlineTurnRunsModule } from '../../__tests__/helpers/inline-agent-runs';
import { cancelChatTurnPreparations } from '../chat-turn-preparation';
import { deferredToolsReloadCoordinator } from '../../deferred-tools/reload-coordinator';
import { dispatchWorktreeChatTurn } from '../worktree-chat-turn';
import { registerWorkspaceTypes } from '../workspace-registry';

type ProviderHandler = (data: unknown) => void | Promise<void>;
interface FakeProvider {
  handler: ProviderHandler | undefined;
  frames: unknown[];
  contexts: Array<ReturnType<typeof currentAgentWorkerContext>>;
  sent: number;
  sentTexts: string[];
  onAcquire: (() => void) | undefined;
  onRemoved: (() => void) | undefined;
  disposed: boolean;
}
const provider: FakeProvider = {
  handler: undefined,
  frames: [],
  contexts: [],
  sent: 0,
  sentTexts: [],
  onAcquire: undefined,
  onRemoved: undefined,
  disposed: false,
};
/** The canonical tab's dispatch metadata says a provider-switch seed is owed. */
let seedOwed = false;
const consumeProviderSwitchSeed = jest.fn(
  (): Promise<void> => Promise.resolve(),
);

jest.mock('../../agent-runs/turn-runs', () =>
  jest
    .requireActual<{
      inlineTurnRunsModule: typeof inlineTurnRunsModule;
    }>('../../__tests__/helpers/inline-agent-runs')
    .inlineTurnRunsModule(),
);
jest.mock('../../agents/session-event-router', () => ({
  ...jest.requireActual<object>('../../agents/session-event-router'),
  getLiveRoutedSession: (): undefined => undefined,
  getOrCreateRoutedSession: (
    _options: unknown,
    handler: ProviderHandler,
    _getWindow: unknown,
    lifecycle?: { onRemoved?: () => void },
  ): Promise<Partial<AgentSession>> => {
    provider.handler = handler;
    provider.onRemoved = lifecycle?.onRemoved;
    provider.contexts.push(currentAgentWorkerContext());
    provider.onAcquire?.();
    const methods: Partial<AgentSession> = {
      isDisposed: () => provider.disposed,
      sendMessage: (text: string) => {
        provider.sent += 1;
        provider.sentTexts.push(text);
        provider.contexts.push(currentAgentWorkerContext());
        // Providers report output as it arrives, before the send returns.
        for (const frame of provider.frames) void provider.handler?.(frame);
      },
    };
    // Every other session member is a live setter the turn awaits.
    const session = new Proxy(methods, {
      get: (target, key): unknown =>
        key === 'then'
          ? undefined
          : ((key in target ? Reflect.get(target, key) : undefined) ??
            ((): Promise<void> => Promise.resolve())),
    });
    return Promise.resolve(session);
  },
}));
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): object => ({
    holdRuntimeHost: (): (() => void) => () => undefined,
    runWithScopeActivity: <T>(_scope: unknown, run: () => T): T => run(),
    consumeProviderSwitchSeed,
  }),
}));
jest.mock('../chat-tabs-reader', () => ({
  ...jest.requireActual<object>('../chat-tabs-reader'),
  readPersistedChatDispatchMetadata: (): Promise<object> =>
    Promise.resolve(seedOwed ? { providerSwitchSeedPending: true } : {}),
  readChatTranscript: (): Promise<object[]> =>
    Promise.resolve([
      {
        id: 'earlier-question',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Earlier question on Codex' }],
      },
      {
        id: 'earlier-answer',
        role: 'assistant',
        timestamp: 2,
        blocks: [{ type: 'text', text: 'Earlier answer from Codex' }],
      },
    ]),
}));
jest.mock('../../services/chat-dispatch-authorization', () => ({
  ...jest.requireActual<object>('../../services/chat-dispatch-authorization'),
  consumeDispatchAuthorization: (): void => undefined,
}));
jest.mock('../../agents/agent-model-runtime', () => ({
  resolveAgentModelRuntime: (options: {
    systemPromptAppend?: string;
  }): Promise<object> =>
    Promise.resolve({
      selectedModel: 'claude-sonnet-4-6',
      runtimeModel: 'claude-sonnet-4-6',
      providerType: 'claude',
      executionHarness: 'claude',
      systemPromptAppend: options.systemPromptAppend,
    }),
}));
jest.mock('../../resource-monitor', () => ({
  getResourceMonitorService: (): object => ({
    reserveChatTurnStart: (): Promise<{ release: () => void }> =>
      Promise.resolve({ release: () => undefined }),
  }),
}));

const turnRuns = jest.requireMock<ReturnType<typeof inlineTurnRunsModule>>(
  '../../agent-runs/turn-runs',
);

const scope = { projectId: 'ws', worktreeId: 'wt', chatId: 'chat' };
function dispatch(
  onBeforeChatEvent: (event: { data: unknown }) => Promise<void> = () =>
    Promise.resolve(),
): Promise<void> {
  return dispatchWorktreeChatTurn({
    ...scope,
    userMessageId: 'message',
    text: 'hello',
    planMode: false,
    model: 'claude-sonnet-4-6',
    providerType: 'claude',
    initiationSource: 'user',
    getWindow: () => null,
    onBeforeChatEvent,
  });
}
async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !check(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
}

beforeEach(() => {
  turnRuns.runs.length = 0;
  provider.handler = undefined;
  provider.frames = [];
  provider.contexts = [];
  provider.sent = 0;
  provider.sentTexts = [];
  seedOwed = false;
  consumeProviderSwitchSeed.mockClear();
  provider.onAcquire = undefined;
  provider.onRemoved = undefined;
  provider.disposed = false;
});

it('an owed provider-switch seed rides the turn even when a session id was recorded first (CAN-6519)', async () => {
  seedOwed = true;
  // The new provider recorded its session id before an earlier send of this
  // turn failed, so the retry resumes it while the seed is still owed.
  await dispatchWorktreeChatTurn({
    ...scope,
    userMessageId: 'message',
    text: 'hello',
    planMode: false,
    model: 'claude-sonnet-4-6',
    providerType: 'claude',
    sdkSessionId: 'recorded-session',
    initiationSource: 'user',
    getWindow: () => null,
    onBeforeChatEvent: () => Promise.resolve(),
  });
  await waitFor(() => provider.sent === 1);

  expect(provider.sentTexts[0]).toContain('Earlier answer from Codex');
  expect(consumeProviderSwitchSeed).toHaveBeenCalledWith(
    { projectId: 'ws', worktreeId: 'wt' },
    'chat',
  );
});

it('a dispatched turn records exactly one core.chat.turn.run', async () => {
  await dispatch();
  expect(turnRuns.runs).toHaveLength(1);
  expect(turnRuns.runs[0]?.request).toMatchObject({
    scope: { workspaceId: 'ws', worktreeId: 'wt', chatId: 'chat' },
    turnId: 'message',
    eventNamespace: 'initial',
  });
});

it("session acquisition and the send run in the turn's worker context", async () => {
  await dispatch();
  const runId = 'test-1';
  expect(provider.sent).toBe(1);
  expect(provider.contexts).toEqual([
    { kind: 'turn', runId },
    { kind: 'turn', runId },
  ]);
});

it("every provider event reaches the turn's commit hook through the core sink, in order", async () => {
  provider.frames = [0, 1, 2].map((index) => ({
    type: 'assistant',
    marker: index,
    message: { content: [{ type: 'text', text: `part ${index}` }] },
  }));
  const committed: unknown[] = [];
  await dispatch(({ data }) => {
    committed.push(data);
    return Promise.resolve();
  });
  await waitFor(() => committed.length >= 3);
  expect(
    committed.flatMap((data) =>
      typeof data === 'object' && data !== null && 'marker' in data
        ? [data.marker]
        : [],
    ),
  ).toEqual([0, 1, 2]);
  expect(
    turnRuns.runs[0]?.events.filter((event) => event.kind === 'transcript'),
  ).toEqual([0, 1, 2].map((sequence) => ({ kind: 'transcript', sequence })));
});

it('the root terminal settles the run with the audit outcome', async () => {
  for (const [frame, outcome] of [
    [
      { type: 'result', subtype: 'error_during_execution', is_error: true },
      'failed',
    ],
    [
      { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
      'completed',
    ],
  ] as const) {
    turnRuns.runs.length = 0;
    provider.frames = [frame];
    await dispatch();
    await waitFor(() => turnRuns.runs[0]?.settledWith != null);
    expect(turnRuns.runs[0]).toMatchObject({
      accepted: true,
      abandoned: false,
      settledWith: outcome,
    });
  }
});

it('a cancelled preparation abandons the run unaccepted', async () => {
  provider.onAcquire = (): void => {
    void cancelChatTurnPreparations(scope);
  };
  await dispatch();
  expect(provider.sent).toBe(0);
  expect(turnRuns.runs[0]).toMatchObject({
    accepted: false,
    abandoned: true,
    settledWith: 'cancelled',
  });
});

it('an aborted run refuses the send', async () => {
  provider.onAcquire = (): void => turnRuns.runs[0]?.abort();
  await expect(dispatch()).rejects.toMatchObject({ name: 'AbortError' });
  expect(provider.sent).toBe(0);
  expect(turnRuns.runs[0]).toMatchObject({
    accepted: false,
    abandoned: true,
    settledWith: 'failed',
  });
});

it('a session removed before the send takes the disposed-at-send path', async () => {
  provider.onAcquire = (): void => {
    provider.disposed = true;
    queueMicrotask(() => provider.onRemoved?.());
  };
  await dispatch();
  expect(provider.sent).toBe(1);
  expect(turnRuns.runs[0]).toMatchObject({
    accepted: true,
    abandoned: false,
    settledWith: 'cancelled',
  });
});

it('a removed Cowork session settles its accepted run', async () => {
  registerWorkspaceTypes(new Map([['wt', 'cowork']]));
  await dispatchWorktreeChatTurn({
    projectId: STANDALONE_CHAT_PROJECT_ID,
    worktreeId: 'wt',
    chatId: 'chat',
    userMessageId: 'message',
    text: 'hello',
    planMode: false,
    model: 'claude-sonnet-4-6',
    providerType: 'claude',
    initiationSource: 'user',
    getWindow: () => null,
    onBeforeChatEvent: () => Promise.resolve(),
  });
  expect(turnRuns.runs[0]).toMatchObject({ accepted: true, settledWith: null });
  provider.onRemoved?.();
  await waitFor(() => turnRuns.runs[0]?.settledWith != null);
  expect(turnRuns.runs[0]?.settledWith).toBe('cancelled');
});

it('a removed Cowork session during a tool reload settles its run completed', async () => {
  registerWorkspaceTypes(new Map([['wt', 'cowork']]));
  await dispatchWorktreeChatTurn({
    projectId: STANDALONE_CHAT_PROJECT_ID,
    worktreeId: 'wt',
    chatId: 'chat',
    userMessageId: 'message',
    text: 'hello',
    planMode: false,
    model: 'claude-sonnet-4-6',
    providerType: 'claude',
    initiationSource: 'user',
    getWindow: () => null,
    onBeforeChatEvent: () => Promise.resolve(),
  });
  const reload = jest
    .spyOn(deferredToolsReloadCoordinator, 'hasActiveReload')
    .mockReturnValue(true);
  try {
    provider.onRemoved?.();
    await waitFor(() => turnRuns.runs[0]?.settledWith != null);
    expect(turnRuns.runs[0]?.settledWith).toBe('completed');
  } finally {
    reload.mockRestore();
  }
});

it('a session removed during a reload before the send takes the disposed-at-send path', async () => {
  const reload = jest
    .spyOn(deferredToolsReloadCoordinator, 'hasActiveReload')
    .mockReturnValue(true);
  provider.onAcquire = (): void => {
    provider.disposed = true;
    queueMicrotask(() => provider.onRemoved?.());
  };
  try {
    await dispatch();
  } finally {
    reload.mockRestore();
  }
  expect(provider.sent).toBe(1);
  expect(turnRuns.runs[0]).toMatchObject({
    accepted: true,
    settledWith: 'cancelled',
  });
});
