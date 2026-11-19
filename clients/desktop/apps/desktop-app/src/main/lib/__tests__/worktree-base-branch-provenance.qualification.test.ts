import type { CanopyHandlerContext } from '@canopy/core-runtime';
import type {
  McpQuestion,
  McpQuestionAnswer,
  SidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import type { ExternalAgentSender } from '@canopy/protocol/portal';

jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp' },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));
jest.mock('../../observability', () => ({
  getObservabilityService: (): unknown => ({
    observeSteeringInput: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  }),
}));

import {
  createChatStateServiceFixture,
  type ChatStateServiceFixture,
} from '../../__tests__/helpers/chat-state-service-fixture';
import {
  getDesktopChatWaits,
  resetDesktopChatWaitsForTest,
} from '../../chat-waits/desktop-chat-waits';
import {
  answerChatQuestionFromRenderer,
  respondToChatQuestion,
  respondToLiveChatQuestion,
  trackSettledChatQuestions,
} from '../../chat-questions/respond';
import { createPendingRequest } from '../../mcp/pending-requests';
import { setChatStateCommandPort } from '../../ipc/chat-state';
import { createCoreChatQuestionAdapter } from '../../canopy-runtime/core-chat-question-adapter';
import { setWorktreeBaseBranchForAgent } from '../../canopy-tools/set-base-branch-runtime';
import {
  WORKTREE_BASE_BRANCH_TEXTS,
  type WorktreeBaseBranchPorts,
} from '../worktree-base-branch';

/*
 * CAN-6024 coordinator condition 2: a PR base update follows only a person's
 * answer. Each case answers the base-branch question through a real path into
 * the chat state service and the waiting tool, then checks the PR update.
 */

const SCOPE = { projectId: 'workspace-1', worktreeId: 'worktree-1' };
const ITEM = {
  id: SCOPE.projectId,
  type: 'single-repo',
  name: 'Project',
  repoPath: '/repo',
  worktrees: [{ id: SCOPE.worktreeId, branchName: 'feature' }],
} as unknown as SidebarItem;
const OPEN_PR = {
  repos: [
    {
      repoId: SCOPE.projectId,
      repoName: 'repo',
      status: { prNumber: 42, state: 'open', baseRefName: 'main' },
    },
  ],
  lastCheckedAt: '2026-11-08T00:00:00.000Z',
} as unknown as WorktreePrStatus;
const SENDER: ExternalAgentSender = {
  kind: 'external_agent',
  connectionId: '123e4567-e89b-42d3-a456-426614174000',
  clientName: 'Web MCP Agent',
  verified: true,
  userId: '123e4567-e89b-42d3-a456-426614174001',
};

let fixture: ChatStateServiceFixture;
let sequence = 0;

function caller(
  overrides: Partial<CanopyHandlerContext['caller']>,
): CanopyHandlerContext {
  return {
    requestId: 'question',
    caller: {
      principalId: 'local-desktop-user',
      clientInstanceId: 'test',
      authorityId: 'local',
      interfaceKind: 'desktop',
      grants: ['core.chat.write'],
      ...overrides,
    },
    metadata: {},
    signal: new AbortController().signal,
  };
}

function coreRespond(
  context: CanopyHandlerContext,
): (requestId: string) => Promise<void> {
  return async (requestId) => {
    const target = fixture.service;
    const handler = createCoreChatQuestionAdapter({
      scopesForChat: (chatId) => Promise.resolve([{ ...SCOPE, chatId }]),
      getState: (scope) => target.getState(scope),
      liveScope: () => ({ ...SCOPE, chatId: 'chat-1' }),
      respond: (request) => respondToChatQuestion({ ...request, port: target }),
    })['core.chat.question.respond'];
    await handler(
      {
        chatId: 'chat-1',
        questionId: requestId,
        answers: {
          '0': {
            selectedOptions: [WORKTREE_BASE_BRANCH_TEXTS.updatePullRequest],
          },
        },
      },
      context,
    );
  };
}

/** AskUserQuestion over the real pending question, answered by `answer`. */
function askAnsweredBy(
  answer: (requestId: string, questions: McpQuestion[]) => Promise<void>,
): (questions: McpQuestion[]) => Promise<McpQuestionAnswer[]> {
  return async (questions) => {
    sequence += 1;
    const requestId = `q-${sequence}`;
    const answers = createPendingRequest(requestId, 'session', {
      scope: { ...SCOPE, chatId: 'chat-1' },
    });
    answers.catch(() => undefined);
    await fixture.service.upsertPendingQuestion(SCOPE, {
      requestId,
      chatId: 'chat-1',
      questions,
    });
    await answer(requestId, questions);
    return answers;
  };
}

function ports(): {
  ports: WorktreeBaseBranchPorts;
  writes: unknown[];
  prUpdates: unknown[];
} {
  const writes: unknown[] = [];
  const prUpdates: unknown[] = [];
  return {
    writes,
    prUpdates,
    ports: {
      readItems: () => Promise.resolve([ITEM]),
      listBranches: () =>
        Promise.resolve({
          branches: [
            {
              name: 'develop',
              hasLocalRef: true,
              hasRemoteRef: true,
            } as unknown as Awaited<
              ReturnType<WorktreeBaseBranchPorts['listBranches']>
            >['branches'][number],
          ],
          defaultBranch: 'main',
        }),
      readPrStatus: () => Promise.resolve(OPEN_PR),
      gitOperationActive: () => false,
      writeTrackedBaseBranch: (request) => {
        writes.push(request);
        return Promise.resolve({
          id: request.worktreeId,
          trackedBaseBranch: request.baseBranch,
        } as WorktreeData);
      },
      updatePullRequestBase: (request) => {
        prUpdates.push(request);
        return Promise.resolve();
      },
    },
  };
}

async function changeWith(
  requestUserAnswers: (
    questions: McpQuestion[],
  ) => Promise<McpQuestionAnswer[]>,
): Promise<{
  response: Awaited<ReturnType<typeof setWorktreeBaseBranchForAgent>>;
  writes: unknown[];
  prUpdates: unknown[];
}> {
  const recorded = ports();
  const response = await setWorktreeBaseBranchForAgent({
    target: SCOPE,
    chatId: 'agent-chat',
    baseBranch: 'develop',
    requestUserAnswers,
    toolUseId: `toolu_${sequence}`,
    ports: recorded.ports,
  });
  return { response, ...recorded };
}

beforeEach(async () => {
  resetDesktopChatWaitsForTest({ noClientMode: 'wait' });
  trackSettledChatQuestions();
  fixture = createChatStateServiceFixture();
  setChatStateCommandPort(fixture.service);
  await fixture.createChat(SCOPE);
});
afterEach(async () => {
  setChatStateCommandPort(null);
  await fixture.dispose();
});

describe('a PR base update follows only a person (CAN-6024)', () => {
  it.each([
    [
      "the window's question card",
      (requestId: string, questions: McpQuestion[]): Promise<void> =>
        answerChatQuestionFromRenderer(requestId, [
          {
            question: questions[0]?.question ?? '',
            selectedOptions: [WORKTREE_BASE_BRANCH_TEXTS.updatePullRequest],
          },
        ]).then(() => undefined),
    ],
    [
      "the main window's renderer relay",
      coreRespond(
        caller({
          principalId: 'local-desktop-renderer:main',
          clientInstanceId: 'renderer-relay:1',
        }),
      ),
    ],
  ])('%s answers as a person and the PR is updated', async (_label, answer) => {
    const { response, writes, prUpdates } = await changeWith(
      askAnsweredBy(answer),
    );

    expect(response).toMatchObject({
      ok: true,
      result: { pullRequestUpdated: true },
    });
    expect(writes).toHaveLength(1);
    expect(prUpdates).toHaveLength(1);
  });

  it.each([
    [
      'an agent action caller (agent-action:<chatId>)',
      coreRespond(
        caller({
          clientInstanceId: 'agent-action:chat-9',
          interfaceKind: 'mcp',
        }),
      ),
    ],
    [
      'App Advisor',
      coreRespond(
        caller({
          principalId: 'desktop-app-advisor',
          clientInstanceId: 'app-advisor-chat:advisor',
          interfaceKind: 'mcp',
        }),
      ),
    ],
    [
      'an agent tool principal',
      coreRespond(
        caller({
          principalId: 'desktop-agent-chat-settings',
          clientInstanceId: 'agent-chat-settings:chat-9',
          interfaceKind: 'mcp',
        }),
      ),
    ],
    [
      'a desktop principal that is not an interactive window',
      coreRespond(caller({})),
    ],
    [
      'the CLI',
      coreRespond(caller({ principalId: 'local-cli', interfaceKind: 'cli' })),
    ],
    [
      'a host-internal answer (automation, hook or pipeline code in main)',
      (requestId: string, questions: McpQuestion[]): Promise<void> =>
        fixture.service
          .answerPendingQuestion(requestId, [
            {
              question: questions[0]?.question ?? '',
              selectedOptions: [WORKTREE_BASE_BRANCH_TEXTS.updatePullRequest],
            },
          ])
          .then(() => undefined),
    ],
    [
      'a renderer-shaped answer that skips the question card',
      (requestId: string, questions: McpQuestion[]): Promise<void> =>
        respondToLiveChatQuestion(requestId, {
          kind: 'answer',
          answers: [
            {
              question: questions[0]?.question ?? '',
              selectedOptions: [WORKTREE_BASE_BRANCH_TEXTS.updatePullRequest],
              answeredBy: 'person',
            },
          ],
        }).then(() => undefined),
    ],
  ])(
    '%s answers as an agent and the change is refused before any write',
    async (_label, answer) => {
      const { response, writes, prUpdates } = await changeWith(
        askAnsweredBy(answer),
      );

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'surface_unavailable',
          message: WORKTREE_BASE_BRANCH_TEXTS.needsConfirmation,
        },
      });
      expect(writes).toEqual([]);
      expect(prUpdates).toEqual([]);
    },
  );

  it('a message an automation, hook, pipeline or projects.send_message delivers never settles the question', async () => {
    const { response, writes, prUpdates } = await changeWith(
      askAnsweredBy(async (requestId) => {
        for (const [index, extra] of [
          { agentSent: SENDER },
          { initiationSource: 'hook' },
          { watcherFired: true },
          {},
        ].entries())
          await fixture.service
            .command({
              schemaVersion: 1,
              commandId: `send-${requestId}-${index}`,
              ...SCOPE,
              command: {
                type: 'chat.send_message',
                chatId: 'chat-1',
                userMessageId: `message-${requestId}-${index}`,
                text: WORKTREE_BASE_BRANCH_TEXTS.updatePullRequest,
                ...extra,
              } as never,
            })
            .catch(() => undefined);
        // The question is still waiting: no delivered message answered it.
        expect(getDesktopChatWaits().isOpen(requestId)).toBe(true);
        await respondToLiveChatQuestion(requestId, { kind: 'dismiss' });
      }),
    );

    expect(response).toMatchObject({
      ok: false,
      error: { message: WORKTREE_BASE_BRANCH_TEXTS.cancelled },
    });
    expect(writes).toEqual([]);
    expect(prUpdates).toEqual([]);
  });
});
