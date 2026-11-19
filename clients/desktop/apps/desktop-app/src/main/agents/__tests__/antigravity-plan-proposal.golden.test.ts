import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { deriveChatWorkflowCapabilities } from '@canopy/app-core';
import type { PlanExitRequestEvent } from '@canopy/desktop-shared/types';
import { getPendingPlanExitSource } from '../../../renderer/src/stores/chat/plan-utils';
import type { AgentInterfacePort } from '../agent-interface-port';
import { AntigravityProvider } from '../antigravity-session';
import type { AgentSession } from '../types';

// A Google turn runs against a fake ACP runtime: each prompt replays the
// session updates the test scripts, then ends the turn. Everything around the
// native runtime (routes, approvals, snapshots) is stubbed to its no-op shape.

// Unknown, so a test can also send what a malformed runtime would.
const mockScript: { updates: unknown[] } = { updates: [] };
const mockPrompts: string[] = [];
const mockAppliedModes: string[] = [];
const mockCommitted: PlanExitRequestEvent[] = [];
const mockAttention: unknown[] = [];
/** What the workspace-directories lookup returns for the next session. */
const mockDirectories: { paths: string[]; advertised: boolean } = {
  paths: [],
  advertised: false,
};
const mockNewSessions: Record<string, unknown>[] = [];
const mockResumedSessions: Record<string, unknown>[] = [];
/** Runs inside the review commit, before it settles. */
let mockDuringCommit: (() => void) | undefined;

jest.mock('../../services/chat-state-plan-exit', () => ({
  commitPendingPlanExit: (event: PlanExitRequestEvent): Promise<void> => {
    mockCommitted.push(event);
    mockDuringCommit?.();
    return Promise.resolve();
  },
}));
jest.mock('../../services/attention-tracker', () => ({
  getAttentionTracker: (): { mark: (entry: unknown) => void } => ({
    mark: (entry: unknown): void => void mockAttention.push(entry),
  }),
}));
jest.mock('../../antigravity/runtime', () => ({
  antigravityProfileDirectory: (): string => '/profile',
  openAntigravityRuntime: (params: {
    onUpdate: (notification: {
      sessionId: string;
      update: unknown;
    }) => Promise<void>;
  }): Promise<unknown> =>
    Promise.resolve({
      client: {
        getInitialization: () => ({
          agentCapabilities: {
            mcpCapabilities: { http: true },
            ...(mockDirectories.advertised
              ? { sessionCapabilities: { additionalDirectories: {} } }
              : {}),
          },
        }),
        newSession: (request: Record<string, unknown>) => {
          mockNewSessions.push(request);
          return Promise.resolve({
            sessionId: 'native-session',
            configOptions: [],
          });
        },
        resumeSession: (request: Record<string, unknown>) => {
          mockResumedSessions.push(request);
          return Promise.resolve({ configOptions: [] });
        },
        prompt: async (request: {
          prompt: { type: string; text: string }[];
        }) => {
          mockPrompts.push(request.prompt.map((block) => block.text).join(''));
          for (const update of mockScript.updates)
            await params.onUpdate({ sessionId: 'native-session', update });
          return { stopReason: 'end_turn' };
        },
        supportsAdditionalDirectories: (): boolean =>
          mockDirectories.advertised,
        close: (): void => undefined,
      },
      close: (): Promise<void> => Promise.resolve(),
    }),
}));
jest.mock('../../antigravity/workspace-directories', () => ({
  antigravityAdditionalDirectories: (): Promise<string[]> =>
    Promise.resolve(mockDirectories.paths),
}));
jest.mock('@canopy/desktop-shared/node/antigravity/session-config', () => ({
  AntigravitySessionConfigError: class extends Error {},
  applyAntigravitySessionConfig: (
    _client: unknown,
    _sessionId: string,
    request: { model: string; mode: string },
  ): Promise<unknown> => {
    mockAppliedModes.push(request.mode);
    return Promise.resolve({
      model: request.model,
      mode: request.mode,
      supportedThinkingLevels: [],
    });
  },
}));
jest.mock('@canopy/desktop-shared/node/antigravity/prompt', () => ({
  readAntigravityAttachments: (): Promise<unknown[]> => Promise.resolve([]),
  readAntigravityHistoricalAttachments: (): Promise<undefined> =>
    Promise.resolve(undefined),
  antigravityHistoryNotice: (): undefined => undefined,
  antigravityPromptContent: ({
    message,
  }: {
    message: string;
  }): { type: string; text: string }[] => [{ type: 'text', text: message }],
  antigravityUnrestoredCounts: (): object => ({}),
  assertAntigravityAttachmentCapabilities: (): void => undefined,
}));
jest.mock('@canopy/execution-engine/lib/antigravity-models', () => ({
  antigravityModelsFromConfig: (): { rawModelId: string }[] => [
    { rawModelId: 'gemini-test' },
  ],
  getRawAntigravityModelId: (): string => 'gemini-test',
  isAntigravityModel: (): boolean => true,
}));
jest.mock('@canopy/execution-engine/model-catalog', () => ({
  getAntigravityModelEntries: (): unknown[] => [],
}));
jest.mock('@canopy/desktop-shared/node/antigravity/runtime', () => ({
  assertAntigravityMcpServersRouted: (): void => undefined,
}));
jest.mock('../../antigravity/extensions', () => ({
  openAntigravityExtensions: (): Promise<unknown> =>
    Promise.resolve({
      servers: [],
      snapshot: {},
      instructions: '',
      notices: [],
      expandPrompt: (text: string): string => text,
      close: (): Promise<void> => Promise.resolve(),
    }),
}));
jest.mock('../../antigravity/app-tools', () => ({
  antigravityAppToolServerNames: (): { main: string; ui: string } => ({
    main: 'main',
    ui: 'ui',
  }),
  openAntigravityAppTools: (): Promise<unknown> =>
    Promise.resolve({
      servers: [],
      grants: {},
      instructions: '',
      close: (): void => undefined,
    }),
}));
jest.mock('../../antigravity/capability-snapshot', () => ({
  captureAntigravityCapabilitySnapshot: (): Promise<object> =>
    Promise.resolve({}),
  saveAntigravityCapabilitySnapshot: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../../antigravity/feature-flag', () => ({
  assertAntigravityHarnessEnabled: (): void => undefined,
}));
jest.mock('../../antigravity/connection', () => ({
  isAntigravityConnectionEnabled: (): Promise<boolean> => Promise.resolve(true),
}));
jest.mock('../../antigravity/tool-approval', () => ({
  authorizeAntigravityTool: (): Promise<string> => Promise.resolve('deny'),
}));
jest.mock('../../antigravity/models', () => ({
  markAntigravityCatalogStale: (): void => undefined,
}));
jest.mock('../../canopy-tools/ledger-tools-runtime', () => ({
  mayExposeLedgerTools: (): boolean => false,
  openLedgerChatTools: (): Promise<null> => Promise.resolve(null),
}));
jest.mock('../../lib/workspace-registry', () => ({
  isCoworkWorkspace: (): boolean => false,
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessInfo: (): void => undefined,
  logMainProcessWarn: (): void => undefined,
}));
jest.mock('../../lib/agent-attachments', () => ({
  resolveAgentAttachmentsDirCandidates: (): string[] => [],
}));
jest.mock('../../agent-runs/agent-worker-context', () => ({
  assertAgentWorkerContext: (): { kind: string; runId: string } => ({
    kind: 'test',
    runId: 'run',
  }),
}));
jest.mock('../../approvals/approval-service', () => ({
  createApprovalSession: (): object => ({
    invalidatePending: (): void => undefined,
    dispose: (): void => undefined,
    setMode: (): void => undefined,
    reevaluatePendingApprovals: (): Promise<void> => Promise.resolve(),
  }),
}));
jest.mock('../delegation/gate', () => ({
  managedDelegationEnabled: (): boolean => false,
}));
jest.mock('../session-manager', () => ({
  buildSessionKey: (...parts: string[]): string => parts.join(':'),
  drainChatSessionEvents: (): Promise<void> => Promise.resolve(),
  registerSession: (): void => undefined,
}));
jest.mock('../provider-turn-lifecycle', () => ({
  getTurnLifecycleProducer: (): object => ({
    turnStarted: (): void => undefined,
    turnEnded: (): void => undefined,
    sessionState: (): void => undefined,
  }),
  releaseTurnLifecycleProducer: (): void => undefined,
}));
jest.mock('../session-event-router', () => ({
  observeRoutedTurnBinding: (): void => undefined,
}));
jest.mock('../owned-turn-state', () => ({
  createOwnedTurnState: (): object => ({
    recordSessionEvent: (): void => undefined,
    ownsKeyResources: (): boolean => true,
    markTurnActive: (): void => undefined,
    markTurnIdle: (): void => undefined,
    markTurnAwaitingUser: (): void => undefined,
  }),
}));
jest.mock('../transcript-fork-context', () => ({
  TranscriptForkContext: class {
    context(): Promise<{ prompt: undefined; attachmentPaths: string[] }> {
      return Promise.resolve({ prompt: undefined, attachmentPaths: [] });
    }
    delivered(): Promise<void> {
      return Promise.resolve();
    }
  },
  readTranscriptRecoveryPrompt: (): Promise<undefined> =>
    Promise.resolve(undefined),
}));

const PLAN_TEXT_REPLY = 'I would rename the helper, then update its callers.';

function planUpdate(entries: string[]): SessionUpdate {
  return {
    sessionUpdate: 'plan',
    entries: entries.map((content) => ({
      content,
      priority: 'medium',
      status: 'pending',
    })),
  };
}

function reply(text: string): SessionUpdate {
  return {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The blocks the session's transcript patches carried, optionally by role. */
function patchBlocks(
  records: readonly Record<string, unknown>[],
  role?: string,
): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const record of records) {
    if (record.type !== 'canopy_assistant_patch') continue;
    if (role !== undefined && record.role !== role) continue;
    const patches: unknown = record.patches;
    if (!Array.isArray(patches)) continue;
    for (const patch of patches)
      if (isRecord(patch) && isRecord(patch.block)) blocks.push(patch.block);
  }
  return blocks;
}

describe('Antigravity plan proposals', () => {
  let presented: PlanExitRequestEvent[];
  let events: Record<string, unknown>[];
  let session: AgentSession;
  let turnEnded: (() => void) | undefined;
  /** Called for each transcript patch the session delivers. */
  let onPatch: ((record: Record<string, unknown>) => void) | undefined;

  function open(planMode: boolean, sdkSessionId?: string): void {
    const port: AgentInterfacePort = {
      publishPromptSuggestion: (): void => undefined,
      publishIngestionLag: (): void => undefined,
      publishDelegationLive: (): void => undefined,
      presentPlanExit: (event): void => void presented.push(event),
      legacyWindow: () => null,
    };
    session = new AntigravityProvider().createSession(
      {
        cwd: '/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        model: 'antigravity:gemini-test',
        planMode,
        ...(sdkSessionId ? { sdkSessionId } : {}),
      },
      (event) => {
        if (typeof event !== 'object' || event === null) return;
        const record: Record<string, unknown> = Object.fromEntries(
          Object.entries(event),
        );
        events.push(record);
        if (record.type === 'canopy_assistant_patch') onPatch?.(record);
        if (record.type === 'result' || record.type === 'error') turnEnded?.();
      },
      port,
    );
  }

  async function turn(
    text: string,
    updates: unknown[],
    userMessageId = 'user-1',
  ): Promise<void> {
    mockScript.updates = updates;
    const ended = new Promise<void>((resolve) => {
      turnEnded = resolve;
    });
    session.sendMessage(text, { userMessageId });
    await ended;
    // The session goes idle once the terminal event is delivered.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  beforeEach(() => {
    presented = [];
    events = [];
    mockPrompts.length = 0;
    mockAppliedModes.length = 0;
    mockCommitted.length = 0;
    mockAttention.length = 0;
    mockNewSessions.length = 0;
    mockResumedSessions.length = 0;
    mockDirectories.paths = [];
    mockDirectories.advertised = false;
    onPatch = undefined;
    mockDuringCommit = undefined;
  });

  afterEach(async () => {
    await session.destroy();
  });

  it('proposes the ACP plan entries as a markdown list for review', async () => {
    open(true);
    await turn('Plan the rename', [
      planUpdate(['Rename the helper']),
      planUpdate(['Rename the helper', 'Update its callers']),
      reply(PLAN_TEXT_REPLY),
    ]);

    expect(mockAppliedModes).toEqual(['plan']);
    expect(mockCommitted).toHaveLength(1);
    const [event] = mockCommitted;
    expect(event).toMatchObject({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      source: 'antigravity',
      reviewMode: 'proposal',
      turnUserMessageId: 'user-1',
      toolInput: {
        plan: '- Rename the helper\n- Update its callers',
        source: 'antigravity',
        reviewMode: 'proposal',
      },
    });
    expect(typeof event.requestId).toBe('string');
    expect(presented).toEqual([event]);
    expect(mockAttention).toEqual([
      {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        state: 'needs_input',
        reason: 'plan_review',
        sourceId: 'plan-review',
      },
    ]);
    // The plan is shown in the transcript as a TodoWrite-style list.
    const todos = patchBlocks(events).filter(
      (block) => block.type === 'tool_use' && block.toolName === 'TodoWrite',
    );
    const latest = todos[todos.length - 1]?.input;
    expect(typeof latest).toBe('string');
    expect(JSON.parse(String(latest))).toEqual({
      todos: [
        {
          content: 'Rename the helper',
          activeForm: 'Rename the helper',
          status: 'pending',
        },
        {
          content: 'Update its callers',
          activeForm: 'Update its callers',
          status: 'pending',
        },
      ],
    });
  });

  it('offers implementation and a workflow run for the proposal it commits', async () => {
    open(true);
    await turn('Plan the rename', [planUpdate(['Rename the helper'])]);

    expect(mockCommitted).toHaveLength(1);
    const [event] = mockCommitted;
    // The composer's approval bar reads the live event's source; a restored
    // tab reads the source its tool input recorded.
    const capabilities = {
      automations: true,
      worktreeBranching: true,
      pipelines: 'execute',
      chatWorkflows: {
        planMode: true,
        planReview: true,
        deferredCapabilities: true,
        independentFork: true,
      },
    } as const;
    for (const resolvedProvider of [
      event.source,
      getPendingPlanExitSource(event.toolInput),
    ]) {
      expect(resolvedProvider).toBe('antigravity');
      expect(
        deriveChatWorkflowCapabilities({
          resolvedProvider,
          interfaceMode: 'canopy',
          target: 'worktree',
          capabilities,
        }),
      ).toMatchObject({
        planMode: true,
        planReview: true,
        planImplementation: true,
        planPipeline: true,
      });
    }
    // A cloud chat has no Google runtime to implement the plan.
    expect(
      deriveChatWorkflowCapabilities({
        resolvedProvider: 'antigravity',
        interfaceMode: 'canopy',
        target: 'cloud',
        capabilities,
      }).planImplementation,
    ).toBe(false);
  });

  it('proposes the final agent text when no plan entries arrived', async () => {
    open(true);
    await turn('Plan the rename', [reply(PLAN_TEXT_REPLY)]);

    expect(mockCommitted).toHaveLength(1);
    expect(mockCommitted[0].toolInput.plan).toBe(PLAN_TEXT_REPLY);
    expect(presented).toEqual(mockCommitted);
  });

  it('proposes only the text after the last tool call', async () => {
    open(true);
    await turn('Plan the rename', [
      reply('Let me look at the helper.'),
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'read-1',
        title: 'Read',
        kind: 'read',
        status: 'completed',
        rawInput: { Path: '/repo/helper.ts' },
      },
      reply('I would rename the helper, '),
      reply('then update its callers.'),
    ]);

    expect(mockCommitted).toHaveLength(1);
    expect(mockCommitted[0].toolInput.plan).toBe(
      'I would rename the helper, then update its callers.',
    );
  });

  it('ends a plan-mode turn as a reply when the final text is a bare question', async () => {
    open(true);
    await turn('Plan the rename', [
      reply('Which file do you mean: a.ts or b.ts?'),
    ]);

    expect(mockCommitted).toEqual([]);
    expect(presented).toEqual([]);
    expect(mockAttention).toEqual([]);
  });

  it('treats trailing whitespace after the question mark as a question', async () => {
    open(true);
    await turn('Plan the rename', [reply('Which one?\n\n')]);

    expect(mockCommitted).toEqual([]);
    expect(presented).toEqual([]);
  });

  it('proposes a reply that contains a code fence even when it ends with a question', async () => {
    open(true);
    const text = 'Which one?```\n';
    await turn('Plan the rename', [reply(text)]);

    expect(mockCommitted).toHaveLength(1);
    expect(mockCommitted[0].toolInput.plan).toBe(text.trim());
  });

  it('proposes a prose plan that ends with a confirmation question', async () => {
    open(true);
    const text =
      'First I rename the helper.\n\nThen I update its callers.\n\nShall I proceed?';
    await turn('Plan the rename', [reply(text)]);

    expect(mockCommitted).toHaveLength(1);
    expect(mockCommitted[0].toolInput.plan).toBe(text);
  });

  it('proposes a bulleted reply even when it ends with a question', async () => {
    open(true);
    const text = '- rename a.ts\n- update imports\nOK?';
    await turn('Plan the rename', [reply(text)]);

    expect(mockCommitted).toHaveLength(1);
    expect(mockCommitted[0].toolInput.plan).toBe(text);
  });

  it('treats a two-line question as a bare question', async () => {
    open(true);
    await turn('Plan the rename', [
      reply('I see two candidates.\nWhich one do you mean?'),
    ]);

    expect(mockCommitted).toEqual([]);
    expect(presented).toEqual([]);
  });

  it('proposes when the final text does not end in a question', async () => {
    open(true);
    const text = 'Which file? I will rename a.ts to b.ts.';
    await turn('Plan the rename', [reply(text)]);

    expect(mockCommitted).toHaveLength(1);
    expect(mockCommitted[0].toolInput.plan).toBe(text);
  });

  it('proposes plan entries even when the last text is a question', async () => {
    open(true);
    await turn('Plan the rename', [
      planUpdate(['Rename the helper']),
      reply('Shall I proceed?'),
    ]);

    expect(mockCommitted).toHaveLength(1);
    expect(mockCommitted[0].toolInput.plan).toBe('- Rename the helper');
  });

  it('keeps a reply as the proposal when an empty plan follows it', async () => {
    open(true);
    await turn('Plan the rename', [
      reply(PLAN_TEXT_REPLY),
      { sessionUpdate: 'plan', entries: [] },
    ]);

    expect(mockCommitted).toHaveLength(1);
    expect(mockCommitted[0].toolInput.plan).toBe(PLAN_TEXT_REPLY);
  });

  // The fake runtime cannot stop a turn between its end and the review
  // commit: buffered text is delivered while the prompt runs, so nothing is
  // left to deliver there. These cover the two sides of that window.
  it('commits no review when the turn is stopped while its reply streams', async () => {
    open(true);
    onPatch = (): void => {
      onPatch = undefined;
      void session.cancel();
    };
    await turn('Plan the rename', [reply(PLAN_TEXT_REPLY)]);

    expect(events.some((record) => record.subtype === 'cancelled')).toBe(true);
    expect(mockCommitted).toEqual([]);
    expect(presented).toEqual([]);
    expect(mockAttention).toEqual([]);
  });

  it('presents a committed review even when the turn stops during the commit', async () => {
    open(true);
    mockDuringCommit = (): void => {
      mockDuringCommit = undefined;
      void session.cancel();
    };
    await turn('Plan the rename', [reply(PLAN_TEXT_REPLY)]);

    expect(mockCommitted).toHaveLength(1);
    expect(presented).toEqual(mockCommitted);
    expect(mockAttention).toHaveLength(1);
  });

  it('skips a plan entry whose content is not text', async () => {
    open(true);
    await turn('Plan the rename', [
      {
        sessionUpdate: 'plan',
        entries: [
          { content: 42, priority: 'medium', status: 'pending' },
          {
            content: 'Rename the helper',
            priority: 'medium',
            status: 'pending',
          },
        ],
      },
    ]);

    expect(mockCommitted).toHaveLength(1);
    expect(mockCommitted[0].toolInput.plan).toBe('- Rename the helper');
    const todos = patchBlocks(events).filter(
      (block) => block.type === 'tool_use' && block.toolName === 'TodoWrite',
    );
    expect(JSON.parse(String(todos[todos.length - 1]?.input))).toEqual({
      todos: [
        {
          content: 'Rename the helper',
          activeForm: 'Rename the helper',
          status: 'pending',
        },
      ],
    });
  });

  it('proposes nothing when a plan-mode turn has no plan and no text', async () => {
    open(true);
    await turn('Plan the rename', []);

    expect(mockCommitted).toEqual([]);
    expect(presented).toEqual([]);
    expect(mockAttention).toEqual([]);
  });

  it('proposes nothing outside plan mode', async () => {
    open(false);
    await turn('Rename the helper', [
      planUpdate(['Rename the helper']),
      reply('Done.'),
    ]);

    expect(mockAppliedModes).toEqual(['default']);
    expect(mockCommitted).toEqual([]);
    expect(presented).toEqual([]);
  });

  it('announces a mode change the runtime reports, but not the applied mode', async () => {
    open(true);
    await turn('Plan the rename', [
      { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
      { sessionUpdate: 'current_mode_update', currentModeId: 'default' },
    ]);

    expect(patchBlocks(events, 'system').map((block) => block.text)).toEqual([
      'Switched to default mode.',
    ]);
  });

  it('runs the queued message after approval outside plan mode without replaying the plan', async () => {
    open(true);
    await turn('Plan the rename', [
      planUpdate(['Rename the helper', 'Update its callers']),
    ]);
    expect(mockCommitted).toHaveLength(1);

    // Approval commits planMode false; the next dispatch applies it before
    // the queued message is sent.
    await session.setPlanMode(false);
    await turn(
      'Also add a changelog entry',
      [reply('Renamed and added the entry.')],
      'user-2',
    );

    expect(mockAppliedModes).toEqual(['plan', 'default']);
    expect(mockPrompts).toEqual([
      'Plan the rename',
      'Also add a changelog entry',
    ]);
    expect(mockCommitted).toHaveLength(1);
    expect(presented).toHaveLength(1);
  });

  it('opens the native session with the worktree repositories as additional directories', async () => {
    mockDirectories.paths = ['/workspace/repos/b', '/workspace/repos/c'];
    mockDirectories.advertised = true;
    open(false);
    await turn('Compare the repositories', [reply('Compared.')]);

    expect(mockNewSessions).toHaveLength(1);
    expect(mockNewSessions[0]?.cwd).toBe('/repo');
    expect(mockNewSessions[0]?.additionalDirectories).toEqual([
      '/workspace/repos/b',
      '/workspace/repos/c',
    ]);
  });

  it('omits additional directories when the runtime does not advertise them', async () => {
    mockDirectories.paths = ['/workspace/repos/b', '/workspace/repos/c'];
    open(false);
    await turn('Compare the repositories', [reply('Compared.')]);

    expect(mockNewSessions).toHaveLength(1);
    expect(mockNewSessions[0]).not.toHaveProperty('additionalDirectories');
  });

  it('forwards additionalDirectories on resume when the capability is advertised', async () => {
    mockDirectories.paths = ['/workspace/repos/b', '/workspace/repos/c'];
    mockDirectories.advertised = true;
    open(false, 'native-session');
    await turn('Compare the repositories', [reply('Compared.')]);

    expect(mockNewSessions).toEqual([]);
    expect(mockResumedSessions).toHaveLength(1);
    expect(mockResumedSessions[0]?.sessionId).toBe('native-session');
    expect(mockResumedSessions[0]?.additionalDirectories).toEqual([
      '/workspace/repos/b',
      '/workspace/repos/c',
    ]);
  });

  it('omits additionalDirectories on resume when the capability is absent', async () => {
    mockDirectories.paths = ['/workspace/repos/b', '/workspace/repos/c'];
    open(false, 'native-session');
    await turn('Compare the repositories', [reply('Compared.')]);

    expect(mockResumedSessions).toHaveLength(1);
    expect(mockResumedSessions[0]).not.toHaveProperty('additionalDirectories');
  });
});
