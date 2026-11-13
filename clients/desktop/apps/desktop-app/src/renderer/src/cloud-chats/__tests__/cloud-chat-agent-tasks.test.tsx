/** @jest-environment jsdom */
import './jsdom-globals';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createChatStore } from '@canopy/app-state';
import {
  bindCloudChatThread,
  type CloudChatThread,
  type CoreCoworkInvoker,
  type CoreCoworkStream,
} from '@canopy/app-state/core-cowork';
import { agentTaskBackgroundTasks } from '@canopy/agent-transcript/agent-tasks';
import type {
  PortalChatAgentBlockData,
  PortalChatPart,
} from '@canopy/protocol/portal';
import { BackgroundTray, ChatPartView } from '@canopy/ui-app';
import { cloudChatCanopyClient } from '../cloud-chat-client';
import { projectCloudChatMessages } from '../cloud-chat-threads';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TARGET = {
  key: 'web-core:chat-1',
  workspaceId: 'workspace-1',
  worktreeId: 'chat-1',
  chatId: 'chat-1',
};

/** A Core task row as the web core serves it in `tasks`. */
function taskRow(
  fields: Partial<Record<string, unknown>> & { taskId: string },
): Record<string, unknown> {
  return {
    stateVersion: '1',
    kind: 'subagent',
    harness: 'CLAUDE_CODE',
    status: 'running',
    stopReason: null,
    native: {},
    parentTaskId: null,
    spawnTurnId: 'turn-1',
    spawnToolCallId: null,
    title: null,
    description: null,
    prompt: null,
    subagentType: null,
    thinkingEffort: null,
    costUsd: null,
    summary: null,
    outputTail: null,
    model: null,
    usage: null,
    error: null,
    createdAtMs: 1_000,
    startedAtMs: 1_000,
    updatedAtMs: 1_000,
    completedAtMs: null,
    approvalPending: false,
    background: false,
    ...fields,
  };
}

const SUBAGENT_RUNNING = taskRow({
  taskId: 'task-sub',
  spawnToolCallId: 'toolu_spawn',
  description: 'Survey the repo',
  background: true,
});
const SUBAGENT_DONE = {
  ...SUBAGENT_RUNNING,
  stateVersion: '2',
  status: 'completed',
  summary: 'Found three config files.',
  completedAtMs: 4_000,
  updatedAtMs: 4_000,
};
const SHELL_RUNNING = taskRow({
  taskId: 'task-shell',
  kind: 'background_shell',
  description: 'Watch the build',
  native: { toolName: 'Bash' },
  background: true,
  updatedAtMs: 3_000,
});

/** The parent turn's reply: the spawn call and its result in one row. */
const PARENT_ROW = {
  id: 'm-parent',
  role: 'assistant',
  timestamp: 2_000,
  blocks: [
    { type: 'text', text: 'Asking a subagent.' },
    {
      type: 'tool_use',
      toolUseId: 'toolu_spawn',
      toolName: 'Task',
      input: JSON.stringify({
        description: 'Survey the repo',
        prompt: 'List the config files.',
        subagent_type: 'Explore',
        run_in_background: true,
      }),
    },
    {
      type: 'tool_result',
      toolUseId: 'toolu_spawn',
      toolName: 'Task',
      output: 'Started in the background.',
      isError: false,
    },
  ],
};
/** The subagent's own row, as the web core nests it under its spawn call. */
const CHILD_ROW = {
  id: 'm-child',
  role: 'assistant',
  timestamp: 2_500,
  parentToolUseId: 'toolu_spawn',
  blocks: [{ type: 'text', text: 'I see three config files.' }],
};

type StreamRead = { done: true } | { done: false; value: unknown };

function pushStream(): CoreCoworkStream & { push(frame: unknown): void } {
  const reads: StreamRead[] = [];
  let waiting: ((read: StreamRead) => void) | null = null;
  return {
    push(frame: unknown): void {
      const read: StreamRead = { done: false, value: frame };
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(read);
      } else reads.push(read);
    },
    next(): Promise<StreamRead> {
      const read = reads.shift();
      if (read) return Promise.resolve(read);
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    close: () => Promise.resolve(),
  };
}

const flush = async (): Promise<void> => {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
};

function bind(tasks: readonly Record<string, unknown>[]): {
  readonly thread: CloudChatThread;
  readonly events: ReturnType<typeof pushStream>;
  readonly store: ReturnType<typeof createChatStore>;
} {
  const events = pushStream();
  const invoker: CoreCoworkInvoker = {
    request: (method) => {
      if (method === 'core.chat.snapshot.get')
        return Promise.resolve({
          ok: true,
          value: {
            workspaceId: TARGET.workspaceId,
            worktreeId: TARGET.worktreeId,
            revision: 4,
            eventsCursor: { daemonEpoch: 'e1', sequence: 4 },
            tabs: { activeTabId: TARGET.chatId, items: [] },
            archives: [],
            runtimeByChatId: {
              [TARGET.chatId]: { status: 'idle', queuedMessageIds: [] },
            },
            queue: [],
            tasks,
          },
        });
      if (method === 'core.chat.transcript.page')
        return Promise.resolve({
          ok: true,
          value: {
            messages: [PARENT_ROW, CHILD_ROW],
            totalMessages: 2,
            transcriptRevision: 1,
          },
        });
      return Promise.reject(new Error(`unexpected ${method}`));
    },
    openStream: (method) =>
      Promise.resolve(method === 'core.chat.events' ? events : pushStream()),
  };
  const store = createChatStore(cloudChatCanopyClient);
  const thread = bindCloudChatThread({
    invoker,
    target: TARGET,
    chatStore: store,
    project: projectCloudChatMessages,
  });
  return { thread, events, store };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function agentCard(
  store: ReturnType<typeof createChatStore>,
): { part: PortalChatPart; data: PortalChatAgentBlockData } | undefined {
  const messages = store.getState().threads[TARGET.key]?.messages ?? [];
  for (const message of messages)
    for (const part of message.parts ?? [])
      if (part.kind === 'agent' && isRecord(part.data))
        return { part, data: part.data };
  return undefined;
}

describe('Desktop cloud chat agent tasks (CAN-5976)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let thread: CloudChatThread | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    thread?.close();
    thread = null;
  });

  it('a snapshot with a task-scoped subagent message and a background task completion shows both', async () => {
    const bound = bind([SUBAGENT_DONE, SHELL_RUNNING]);
    thread = bound.thread;
    await flush();

    const card = agentCard(bound.store);
    expect(card?.data).toMatchObject({
      toolUseId: 'toolu_spawn',
      taskId: 'task-sub',
      taskStatus: 'completed',
      description: 'Survey the repo',
      runInBackground: true,
      // A background agent's result is its task's summary, not the launch line.
      result: 'Found three config files.',
    });
    expect(card?.data.isRunning).toBeUndefined();
    // The subagent's own row sits in its card, never in the root transcript.
    expect(
      bound.store
        .getState()
        .threads[TARGET.key]?.messages.map((each) => each.messageId),
    ).toEqual(['m-parent']);

    const background = agentTaskBackgroundTasks(thread.getAgentTasks());
    expect(background).toEqual([
      expect.objectContaining({
        id: 'task-sub',
        kind: 'agent',
        status: 'completed',
        summary: 'Found three config files.',
      }),
      expect.objectContaining({
        id: 'task-shell',
        kind: 'bash',
        status: 'running',
        title: 'Watch the build',
      }),
    ]);

    if (card === undefined) throw new Error('no agent card');
    act(() =>
      root.render(
        <>
          <ChatPartView part={card.part} messageId="m-parent" />
          <BackgroundTray chatId={TARGET.key} tasks={background} />
        </>,
      ),
    );
    expect(container.textContent).toContain('Survey the repo');
    const toggle = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Survey the repo'),
    );
    if (toggle) act(() => toggle.click());
    expect(container.textContent).toContain('I see three config files.');
    const showResult = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Show result',
    );
    if (showResult) act(() => showResult.click());
    expect(container.textContent).toContain('Found three config files.');
    expect(
      container.querySelector('[data-testid="background-tray-kind-bash"]'),
    ).not.toBeNull();
  });

  it('agent_tasks.replaced settles the card and the background work live', async () => {
    const bound = bind([SUBAGENT_RUNNING]);
    thread = bound.thread;
    await flush();
    expect(agentCard(bound.store)?.data.isRunning).toBe(true);
    expect(
      agentTaskBackgroundTasks(thread.getAgentTasks()).map(
        (each) => `${each.id}:${each.status}`,
      ),
    ).toEqual(['task-sub:running']);

    bound.events.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 5 },
      item: {
        schemaVersion: 1,
        eventId: 'ev-5',
        occurredAt: '2026-11-09T12:00:00.000Z',
        projectId: TARGET.workspaceId,
        worktreeId: TARGET.worktreeId,
        baseRevision: 4,
        revision: 5,
        changes: [
          {
            type: 'agent_tasks.replaced',
            chatId: TARGET.chatId,
            tasks: [SUBAGENT_DONE, SHELL_RUNNING],
          },
        ],
      },
    });
    await flush();

    expect(agentCard(bound.store)?.data).toMatchObject({
      taskStatus: 'completed',
    });
    expect(agentCard(bound.store)?.data.isRunning).toBeUndefined();
    expect(
      agentTaskBackgroundTasks(thread.getAgentTasks()).map(
        (each) => `${each.id}:${each.status}`,
      ),
    ).toEqual(['task-sub:completed', 'task-shell:running']);
  });
});
