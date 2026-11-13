/** @jest-environment jsdom */
/**
 * CAN-6175: a question a web core chat raised is settled by the web core,
 * through `core.chat.question.respond`, from the chat store's own answer and
 * dismiss actions (the composer's question card calls them). The local core
 * never sees it, and a local chat's question still goes to the local core.
 */
import { CoreChatQuestionRespondParamsSchema } from '@canopy/protocol/canopy-core';
import type { McpQuestionAnswer } from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { createEmptyTab } from '../tab-utils';

const PROJECT = 'web-core:ws-1';
const WORKTREE = 'web-core:task-1';
const CHAT = 'web-core:chat-1';

const QUESTIONS = [
  { id: 'q-a', question: 'Which plan?', options: ['Small', 'Large'] },
  { id: 'q-b', question: 'Name it', options: [], allowOther: true },
];

const ANSWERS: McpQuestionAnswer[] = [
  { questionId: 'q-a', question: 'Which plan?', selectedOptions: ['Small'] },
  {
    questionId: 'q-b',
    question: 'Name it',
    selectedOptions: [],
    freeformText: 'Mine',
  },
];

/** The local core's question IPC, which a cloud question must never reach. */
const local = {
  answerMcpQuestion: jest.fn(() => Promise.resolve({ accepted: true })),
  dismissMcpQuestion: jest.fn(() => Promise.resolve()),
};

/** Local preload stubs: the question IPC above, everything else inert. */
function localApi(): unknown {
  const call = (): Promise<undefined> => Promise.resolve(undefined);
  const handler: ProxyHandler<typeof call> = {
    get: (_target, property) => {
      if (property === 'then') return undefined;
      if (property === 'answerMcpQuestion') return local.answerMcpQuestion;
      if (property === 'dismissMcpQuestion') return local.dismissMcpQuestion;
      if (typeof property === 'string' && property.startsWith('on'))
        return () => (): void => undefined;
      return new Proxy(call, handler);
    },
    apply: call,
  };
  return new Proxy(call, handler);
}

/** What the web core is asked through the relay, and how it answers. */
const relay = {
  requests: [] as { method: string; params: Record<string, unknown> }[],
  refusal: null as Record<string, unknown> | null,
};

const canopyCore = {
  invoke: (request: {
    kind: string;
    method: string;
    params: Record<string, unknown>;
  }): Promise<unknown> => {
    relay.requests.push({ method: request.method, params: request.params });
    if (relay.refusal !== null)
      return Promise.resolve({ ok: false, error: relay.refusal });
    return Promise.resolve({
      ok: true,
      value: {
        chatId: 'chat-1',
        workspaceId: 'ws-1',
        worktreeId: 'task-1',
        title: 'Plan',
        state: 'running',
      },
    });
  },
};

function seed(projectId: string, worktreeId: string, chatId: string): void {
  useChatStore.setState({
    worktreeChats: {
      [`${projectId}/${worktreeId}`]: {
        tabs: [{ ...createEmptyTab(), id: chatId }],
        activeTabId: chatId,
      },
    },
    pendingQuestions: {
      'request-1': {
        requestId: 'request-1',
        projectId,
        worktreeId,
        chatId,
        questions: QUESTIONS,
        toolUseId: 'call-1',
      },
    },
  } as never);
}

beforeAll(() => {
  Object.assign(window, { api: localApi(), canopyCore });
});

beforeEach(() => {
  relay.requests = [];
  relay.refusal = null;
  local.answerMcpQuestion.mockClear();
  local.dismissMcpQuestion.mockClear();
});

describe('questions in a web core chat (CAN-6175)', () => {
  it("answers a cloud chat's question through the web core, keyed by question id", async () => {
    seed(PROJECT, WORKTREE, CHAT);
    await useChatStore
      .getState()
      .answerMcpQuestionAndWait('request-1', ANSWERS);

    expect(relay.requests).toEqual([
      {
        method: 'core.chat.question.respond',
        params: {
          chatId: 'chat-1',
          questionId: 'request-1',
          answers: {
            'q-a': { selectedOptions: ['Small'] },
            'q-b': { selectedOptions: [], freeformText: 'Mine' },
          },
        },
      },
    ]);
    expect(
      CoreChatQuestionRespondParamsSchema.safeParse(relay.requests[0]?.params)
        .success,
    ).toBe(true);
    expect(local.answerMcpQuestion).not.toHaveBeenCalled();
  });

  it("dismisses a cloud chat's question through the web core", async () => {
    seed(PROJECT, WORKTREE, CHAT);
    await useChatStore.getState().dismissMcpQuestionAndWait('request-1');

    expect(relay.requests).toEqual([
      {
        method: 'core.chat.question.respond',
        params: { chatId: 'chat-1', questionId: 'request-1', dismissed: true },
      },
    ]);
    expect(
      CoreChatQuestionRespondParamsSchema.safeParse(relay.requests[0]?.params)
        .success,
    ).toBe(true);
    expect(local.dismissMcpQuestion).not.toHaveBeenCalled();
  });

  it('keeps a refused answer open to answer again, asking the web core once', async () => {
    seed(PROJECT, WORKTREE, CHAT);
    relay.refusal = {
      kind: 'unavailable',
      message: 'The reply was lost.',
      retry: { kind: 'same_request' },
    };
    await expect(
      useChatStore.getState().answerMcpQuestionAndWait('request-1', ANSWERS),
    ).rejects.toThrow();

    // No resend of the same answer (CAN-6273): the person answers again.
    expect(relay.requests).toHaveLength(1);
    expect(useChatStore.getState().pendingQuestions['request-1']).toMatchObject(
      { requestId: 'request-1' },
    );
    expect(
      useChatStore.getState().pendingQuestions['request-1']?.answeredAt,
    ).toBeUndefined();
    expect(local.answerMcpQuestion).not.toHaveBeenCalled();
  });

  it("still answers a local chat's question through the local core", async () => {
    seed('project-1', 'wt-1', 'chat-1');
    await useChatStore
      .getState()
      .answerMcpQuestionAndWait('request-1', ANSWERS);

    expect(local.answerMcpQuestion).toHaveBeenCalledWith({
      requestId: 'request-1',
      answers: ANSWERS,
    });
    expect(relay.requests).toEqual([]);
  });
});
