// A credit-held prompt resent after funding (CAN-7488). Runs the real queue
// (drain, dispatch, Run now, credit hold) and the real chat-service send, whose
// accepted-prompt check completes a resend that carries no new attempt.
// Faked: the provider turn, chat-state storage, and auth/gateway preflights.
import type { ChatSendMessageRequest } from '@canopy/desktop-shared/types';
import type { ChatQueueService } from '../chat-queue-service';

interface ProviderTurn {
  userMessageId: string;
  providerEventSequenceNamespace: string | undefined;
  eventMutationIds: string[];
}

interface QueueDispatch {
  userMessageId: string;
  creditRetryAttemptId: string | undefined;
  outcome: 'resolved' | 'rejected';
}

const mockState: {
  service: ChatQueueService | undefined;
  mutations: Set<string>;
  providerTurns: ProviderTurn[];
  /** What the queue passed to the chat-service send. */
  dispatches: QueueDispatch[];
  /** Turn terminals reaching the queue, as `<status>:<turn id>`. */
  terminals: string[];
} = {
  service: undefined,
  mutations: new Set(),
  providerTurns: [],
  dispatches: [],
  terminals: [],
};

function mockPartially(
  path: string,
  overrides: Record<string, unknown>,
): object {
  return new Proxy(overrides, {
    get: (target, property): unknown =>
      typeof property === 'string' && property in target
        ? target[property]
        : jest.requireActual<Record<string | symbol, unknown>>(path)[property],
    has: (target, property): boolean =>
      property in target ||
      property in jest.requireActual<Record<string | symbol, unknown>>(path),
  });
}

jest.mock('../chat-queue-service', () =>
  mockPartially('../chat-queue-service', {
    getChatQueueService: (): ChatQueueService => {
      if (!mockState.service) throw new Error('queue not wired');
      return mockState.service;
    },
  }),
);

jest.mock('../chat-state-service', () => {
  const ingest = (input: { mutationId: string }): boolean => {
    if (mockState.mutations.has(input.mutationId)) return false;
    mockState.mutations.add(input.mutationId);
    return true;
  };
  const fake: Record<string, unknown> = {
    runWithScopeActivity: (_scope: unknown, run: () => Promise<unknown>) =>
      run(),
    commitTurnOverrideModelFor: () => Promise.resolve(),
    ensureChatForTrustedSend: () => Promise.resolve(),
    ingestProviderEvent: (input: { mutationId: string }) =>
      Promise.resolve(ingest(input)),
    ingestProviderEventWithResult: (input: { mutationId: string }) =>
      Promise.resolve({ outcome: ingest(input) ? 'applied' : 'not-applied' }),
    hasMutation: (_scope: unknown, mutationId: string) =>
      Promise.resolve(mockState.mutations.has(mutationId)),
    cancelRetainedTerminalAgentInput: () => Promise.resolve('not_found'),
    editRetainedTerminalAgentInput: () => Promise.resolve('not_found'),
  };
  return {
    getChatStateService: (): object =>
      new Proxy(fake, {
        get: (target, property): unknown => {
          if (typeof property === 'string' && property in target)
            return target[property];
          if (property === 'then') return undefined;
          return (): Promise<undefined> => Promise.resolve(undefined);
        },
      }),
  };
});

// The provider turn records what reaches it, accepts the turn, and ingests one
// provider event under the turn's event namespace.
jest.mock('../../lib/worktree-chat-turn', () =>
  mockPartially('../../lib/worktree-chat-turn', {
    dispatchWorktreeChatTurn: async (options: {
      userMessageId: string;
      projectId: string;
      worktreeId: string;
      chatId: string;
      providerEventSequenceNamespace?: string;
      onTurnAccepted?: () => void;
      onBeforeChatEvent?: (event: Record<string, unknown>) => Promise<unknown>;
    }): Promise<void> => {
      const turn: ProviderTurn = {
        userMessageId: options.userMessageId,
        providerEventSequenceNamespace: options.providerEventSequenceNamespace,
        eventMutationIds: [],
      };
      mockState.providerTurns.push(turn);
      options.onTurnAccepted?.();
      const before = new Set(mockState.mutations);
      await options.onBeforeChatEvent?.({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        data: { type: 'assistant', text: 'hello' },
        sequenceNamespace: options.providerEventSequenceNamespace ?? 'initial',
        sequence: 0,
        turnUserMessageId: options.userMessageId,
      });
      turn.eventMutationIds = [...mockState.mutations].filter(
        (id) => !before.has(id),
      );
    },
  }),
);

jest.mock('../../lib/auth-preflight', () =>
  mockPartially('../../lib/auth-preflight', {
    assertTurnAuthDependencies: (): Promise<void> => Promise.resolve(),
  }),
);
jest.mock('../../lib/model-gateway-turn', () =>
  mockPartially('../../lib/model-gateway-turn', {
    assertTurnModelGatewayRoute: (): Promise<void> => Promise.resolve(),
  }),
);
jest.mock('../../lib/retired-chat-scope-guard', () =>
  mockPartially('../../lib/retired-chat-scope-guard', {
    assertChatScopeAcceptsTurns: (): void => undefined,
  }),
);
jest.mock('../stopped-turn-resume-service', () =>
  mockPartially('../stopped-turn-resume-service', {
    getStoppedTurnResumeService: (): object => ({
      recordTurnContext: (): void => undefined,
    }),
  }),
);
jest.mock('../../lib/transient-error-retry-service', () =>
  mockPartially('../../lib/transient-error-retry-service', {
    cancelTransientRetryForChat: (): boolean => false,
  }),
);
jest.mock('../../agents/session-manager', () =>
  mockPartially('../../agents/session-manager', {
    chatHasNativeBackgroundWork: (): boolean => false,
    getSessionTurnSettings: (): undefined => undefined,
  }),
);

// eslint-disable-next-line import/first
import { dispatchHostQueuedWorktreeChatMessage } from '../chat-service';
// eslint-disable-next-line import/first
import { createQueueHarness, type QueueHarness } from './helpers/queue-harness';

jest.setTimeout(30_000);

const target = { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-1' };
const request = (userMessageId = 'm1'): ChatSendMessageRequest => ({
  ...target,
  userMessageId,
  text: `queued ${userMessageId}`,
  // Codex keeps the send off the Claude terminal-mode branch.
  providerType: 'codex',
});

function setUp(funding: { funded: boolean }): QueueHarness {
  mockState.mutations = new Set();
  mockState.providerTurns = [];
  mockState.dispatches = [];
  mockState.terminals = [];
  const harness = createQueueHarness({
    readCreditFunding: () => Promise.resolve(funding.funded),
    dispatch: async (req, origin, fromQueue, authorization, options) => {
      const record: QueueDispatch = {
        userMessageId: req.userMessageId,
        creditRetryAttemptId: options?.creditRetryAttemptId,
        outcome: 'resolved',
      };
      mockState.dispatches.push(record);
      try {
        await dispatchHostQueuedWorktreeChatMessage(
          req,
          origin === 'portal' ? 'portal' : 'desktop',
          fromQueue,
          authorization,
          options,
        );
      } catch (error) {
        record.outcome = 'rejected';
        throw error;
      }
    },
  });
  const realTerminal = harness.service.onTurnTerminal.bind(harness.service);
  harness.service.onTurnTerminal = (...args): void => {
    mockState.terminals.push(`${args[1]}:${String(args[2])}`);
    realTerminal(...args);
  };
  mockState.service = harness.service;
  return harness;
}

function queuedRowIds(harness: QueueHarness): string[] {
  return (
    harness.service
      .getWorktreeSnapshots('ws-1', 'wt-1')
      .find((event) => event.chatId === 'chat-1')
      ?.queue?.map((row) => row.id) ?? []
  );
}

/** The provider accepts m1, then its turn ends with no billing source. */
async function refuseFirstAttemptForCredits(
  harness: QueueHarness,
): Promise<void> {
  harness.service.hydratePersistedInput(request(), 'row-1', 'desktop', 1);
  harness.service.releaseInputOwnership(target);
  await harness.flush();
  expect(mockState.providerTurns.map((turn) => turn.userMessageId)).toEqual([
    'm1',
  ]);
  expect(mockState.mutations.has('chat-1:m1:accepted')).toBe(true);
  harness.service.onTurnTerminal(target, 'error', 'm1', 'insufficient_credits');
  await harness.flush();
  expect(queuedRowIds(harness)).toEqual(['row-1']);
}

/** The resend reached the provider as a new attempt with its own events. */
function expectNewAttempt(harness: QueueHarness): void {
  expect(
    mockState.dispatches.map((dispatch) => [
      dispatch.userMessageId,
      dispatch.outcome,
    ]),
  ).toEqual([
    ['m1', 'resolved'],
    ['m1', 'resolved'],
  ]);
  expect(mockState.dispatches[0]?.creditRetryAttemptId).toBeUndefined();
  expect(typeof mockState.dispatches[1]?.creditRetryAttemptId).toBe('string');
  const resend = mockState.providerTurns[1];
  expect(mockState.providerTurns).toHaveLength(2);
  expect(resend?.providerEventSequenceNamespace).toEqual(expect.any(String));
  expect(resend?.eventMutationIds).toEqual([
    `chat-1:m1:provider:${resend?.providerEventSequenceNamespace ?? ''}:0`,
  ]);
  expect(mockState.terminals).toEqual(['error:m1']);
  expect(queuedRowIds(harness)).toEqual([]);
}

describe('credit-held prompt resent after funding (CAN-7488)', () => {
  it('the automatic resend reaches the provider as a new attempt', async () => {
    const funding = { funded: false };
    const harness = setUp(funding);
    await refuseFirstAttemptForCredits(harness);
    // Still unfunded: the hold keeps the prompt queued.
    await harness.flush();
    expect(mockState.dispatches).toHaveLength(1);

    funding.funded = true;
    await harness.flush();
    expectNewAttempt(harness);
  });

  it('Run now on the funded hold sends the same new attempt', async () => {
    const funding = { funded: false };
    const harness = setUp(funding);
    await refuseFirstAttemptForCredits(harness);
    funding.funded = true;
    // No flush first: Run now reaches the hold before a drain releases it.
    await expect(harness.service.force(target, 'row-1')).resolves.toBe(
      'applied',
    );
    await harness.flush();
    expectNewAttempt(harness);
  });

  it("restoring a credit-refused chat's rows through hydratePersistedInput sends the refused prompt once", async () => {
    // Enters at the queue's restore entry point with the saved refusal and accepted prompt supplied directly, so the chat-state save and load path is not covered here.
    const funding = { funded: false };
    const harness = setUp(funding);
    // m1 was accepted, then refused; the restart restores the refused row and
    // a replayed copy of the same prompt, then a prompt never sent.
    mockState.mutations.add('chat-1:m1:user-prompt');
    mockState.mutations.add('chat-1:m1:accepted');
    harness.service.holdDrainsForStartup();
    for (const [rowId, userMessageId] of [
      ['row-1', 'm1'],
      ['row-1-replay', 'm1'],
      ['row-2', 'm2'],
    ] as const)
      harness.service.hydratePersistedInput(
        request(userMessageId),
        rowId,
        'desktop',
        1,
        undefined,
        undefined,
        { creditRefused: true },
      );
    harness.service.releaseInputOwnership(target);
    harness.service.releaseStartupDrainHold();
    await harness.flush();
    expect(mockState.dispatches).toHaveLength(0);

    funding.funded = true;
    await harness.flush();
    expect(mockState.providerTurns.map((turn) => turn.userMessageId)).toEqual([
      'm1',
    ]);
    expect(mockState.providerTurns[0]?.providerEventSequenceNamespace).toEqual(
      expect.any(String),
    );
    harness.service.onTurnTerminal(target, 'complete', 'm1');
    await harness.flush();
    // The replayed copy is taken as already sent; m2 then sends normally.
    expect(mockState.providerTurns.map((turn) => turn.userMessageId)).toEqual([
      'm1',
      'm2',
    ]);
    expect(queuedRowIds(harness)).toEqual([]);
  });
});
