// CAN-4174 capture golden: what a converted workflow's send step asks for
// when an automation runs it, pinned on unchanged code. The real
// `send-agent-message` host step sends; only task resolution, the chat tabs
// read and the shared project/bot port it dispatches to are replaced. A
// scheduled run sends with a background hint and a Run now with a foreground
// one, to an App Advisor task or a project chat alike, and neither hands the
// port any App Advisor window surfaces. The shared port acts on a foreground
// hint only by bringing an existing project chat forward, so a converted App
// Advisor send never opens or focuses the App Advisor window, Run now
// included, while a project chat's Run now is brought forward.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PipelineHostActionCaller,
  PipelineHostActionControls,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import type { ResolvedSendAgentMessageInputs } from '@canopy/execution-engine/pipelines/host-send-agent-message';
import type * as ChatTabsReader from '../../lib/chat-tabs-reader';
import type * as TaskResolution from '../host-task-resolution';

const mockDispatches: { action: unknown; options: Record<string, unknown> }[] =
  [];

jest.mock('../host-task-resolution', () => ({
  ...jest.requireActual<typeof TaskResolution>('../host-task-resolution'),
  resolveTask: (target: {
    kind: string;
    botId?: string;
    projectId?: string;
    taskId: string;
  }): Promise<unknown> =>
    Promise.resolve({
      target:
        target.kind === 'bot'
          ? { kind: 'bot', botId: target.botId, taskId: target.taskId }
          : {
              kind: 'project',
              projectId: target.projectId,
              taskId: target.taskId,
              workspaceType: 'cowork',
            },
    }),
}));
jest.mock('../../lib/chat-tabs-reader', () => ({
  ...jest.requireActual<typeof ChatTabsReader>('../../lib/chat-tabs-reader'),
  readChatTabsFile: (): Promise<unknown> =>
    Promise.resolve({ tabs: [{ id: 'chat-existing', kind: 'chat' }] }),
}));
jest.setTimeout(30_000);

let artifactsDir: string;

type Target = 'advisor' | 'project-chat';

function inputs(target: Target): ResolvedSendAgentMessageInputs {
  return target === 'advisor'
    ? {
        target: { kind: 'bot', botId: 'app_advisor', taskId: 'task-1' },
        text: 'Summarize my day',
        mode: 'queue',
        settings: {},
        replaceEmptyChat: true,
      }
    : {
        target: {
          kind: 'project',
          projectId: 'cowork-project',
          taskId: 'entry-1',
          chatId: 'chat-existing',
        },
        text: 'Summarize my day',
        mode: 'queue',
        settings: {},
      };
}

function caller(background: boolean): PipelineHostActionCaller {
  return {
    executionId: `execution-${background ? 'scheduled' : 'manual'}`,
    jobId: 'main',
    stepId: 'send',
    attempt: 0,
    iteration: 0,
    idempotencyKey: `send-${background ? 'scheduled' : 'manual'}`,
    executionContext: 'personal',
    initiationSource: 'automation',
    initiator: {
      kind: 'automation',
      automationId: 'advisor-automation',
      automationName: 'Morning summary',
      ...(background ? { background: true } : {}),
    },
  };
}

function controls(): PipelineHostActionControls {
  return {
    deadlineAt: Date.now() + 60_000,
    artifactsDir,
    registerTimeoutFinalizer: (): void => undefined,
  };
}

async function send(target: Target, background: boolean): Promise<unknown> {
  const { runSendAgentMessageHostAction } =
    await import('../host-send-agent-message');
  return runSendAgentMessageHostAction(
    inputs(target),
    caller(background),
    {
      assertTargetOwner: (): Promise<void> => Promise.resolve(),
      dispatch: (action, _caller, options = {}) => {
        mockDispatches.push({ action, options: { ...options } });
        const input = (
          address: Record<string, string>,
        ): {
          address: Record<string, string>;
          acceptedAt: string;
          watcherReceipts: string[];
          disposition: string;
          messageId: string;
        } => ({
          address,
          acceptedAt: new Date().toISOString(),
          watcherReceipts: [],
          disposition: 'started',
          messageId: 'message-accepted',
        });
        if (target === 'project-chat') {
          const address = {
            projectId: 'cowork-project',
            taskId: 'entry-1',
            chatId: 'chat-existing',
          };
          return Promise.resolve({ ok: true, result: input(address) });
        }
        const address = {
          botId: 'app_advisor',
          taskId: 'task-1',
          chatId: 'chat-new',
        };
        return Promise.resolve({
          ok: true,
          result: {
            address,
            taskCreated: false,
            chatCreated: true,
            input: input(address),
          },
        });
      },
    },
    new AbortController().signal,
    controls(),
  );
}

beforeEach(async () => {
  jest.resetModules();
  mockDispatches.length = 0;
  artifactsDir = await mkdtemp(join(tmpdir(), 'advisor-workflow-send-'));
});

afterEach(async () => {
  await rm(artifactsDir, { recursive: true, force: true });
});

describe('a converted workflow send (CAN-4174 capture)', () => {
  it.each([
    ['a scheduled run sends in the background', true, 'background'],
    // The case a mapping from this hint to the window would break: a Run now
    // carries a foreground hint, yet no App Advisor window opens today.
    ['a Run now sends in the foreground', false, 'foreground'],
  ] as const)(
    'to an App Advisor task: %s, with no App Advisor window surfaces',
    async (_name, background, presentation) => {
      const result = await send('advisor', background);
      expect(result).toMatchObject({
        status: 'success',
        outputs: { bot_id: 'app_advisor', chat_id: 'chat-new', state: 'sent' },
      });
      expect(mockDispatches).toHaveLength(1);
      expect(mockDispatches[0]?.options).toMatchObject({
        automationDispatch: {
          automationName: 'Morning summary',
          presentation,
        },
      });
      expect(mockDispatches[0]?.options['surfaces']).toBeUndefined();
    },
  );

  it.each([
    ['a scheduled run sends in the background', true, 'background'],
    ['a Run now sends in the foreground', false, 'foreground'],
  ] as const)(
    'to an existing project chat: %s',
    async (_name, background, presentation) => {
      const result = await send('project-chat', background);
      expect(result).toMatchObject({
        status: 'success',
        outputs: { project_id: 'cowork-project', chat_id: 'chat-existing' },
      });
      expect(mockDispatches).toHaveLength(1);
      expect(mockDispatches[0]).toMatchObject({
        action: {
          type: 'projects.send_message',
          projectId: 'cowork-project',
          taskId: 'entry-1',
          chatId: 'chat-existing',
        },
        options: { automationDispatch: { presentation } },
      });
      expect(mockDispatches[0]?.options['surfaces']).toBeUndefined();
    },
  );
});
