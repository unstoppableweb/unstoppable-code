import {
  WORKER_AGENT_RUN_INSTRUCTION_DEFINITIONS,
  WORKER_AGENT_RUN_STREAM_DEFINITIONS,
  WORKER_AGENT_TURN_LAUNCH_LIMITS,
  WORKER_AGENT_TURN_PAYLOAD_MAX_BYTES,
  WorkerAgentTurnEventsParamsSchema,
  WorkerAgentTurnLaunchSchema,
  WorkerAgentSubagentRunParamsSchema,
  WorkerAgentSubagentRunResultSchema,
  WorkerAgentTurnEventSchema,
  WorkerAgentTurnRunParamsSchema,
  WorkerAgentTurnRunResultSchema,
} from '../agent-turns';

const turnParams = {
  turnRunId: 'run',
  scope: { workspaceId: 'ws', worktreeId: 'wt', chatId: 'chat' },
  turnId: 'message',
  eventNamespace: 'initial',
  providerId: 'claude',
  model: null,
  materializationId: null,
};
const subagentParams = {
  subagentRunId: 'sub',
  delegationId: 'delegation',
  runGeneration: 1,
  harnessId: 'local-delegation-claude-v1',
  scope: { workspaceId: 'ws', worktreeId: 'wt', chatId: 'chat' },
};
const base = { turnRunId: 'run', sequence: 0 };

it('every envelope kind round-trips; unknown kinds and oversize payloads are refused', () => {
  const fixtures = [
    { ...base, kind: 'accepted' },
    {
      ...base,
      kind: 'transcript',
      format: 'canopy.chat-event.v1',
      terminal: false,
      payload: { type: 'assistant', message: { content: [] } },
    },
    { ...base, kind: 'wait_opened', waitId: 'w', waitKind: 'approval' },
    { ...base, kind: 'wait_resolved', waitId: 'w', resolution: 'answered' },
    { ...base, kind: 'terminal', outcome: 'completed' },
  ];
  for (const fixture of fixtures)
    expect(WorkerAgentTurnEventSchema.parse(fixture)).toEqual(fixture);
  expect(
    WorkerAgentTurnEventSchema.safeParse({ ...base, kind: 'progress' }).success,
  ).toBe(false);
  const transcript = {
    ...base,
    kind: 'transcript',
    format: 'canopy.chat-event.v1',
    terminal: false,
  };
  // `"` + text + `"` serializes to exactly one byte over the bound.
  const oversize = 'x'.repeat(WORKER_AGENT_TURN_PAYLOAD_MAX_BYTES - 1);
  expect(
    WorkerAgentTurnEventSchema.safeParse({ ...transcript, payload: oversize })
      .success,
  ).toBe(false);
  expect(
    WorkerAgentTurnEventSchema.safeParse({
      ...transcript,
      payload: oversize.slice(1),
    }).success,
  ).toBe(true);
  expect(
    WorkerAgentTurnEventSchema.safeParse({
      ...transcript,
      payload: { run: () => undefined },
    }).success,
  ).toBe(false);
});

it('turn and subagent params are strict', () => {
  expect(WorkerAgentTurnRunParamsSchema.safeParse(turnParams).success).toBe(
    true,
  );
  expect(
    WorkerAgentTurnRunParamsSchema.safeParse({ ...turnParams, prompt: 'x' })
      .success,
  ).toBe(false);
  const withoutMaterialization: Record<string, unknown> = { ...turnParams };
  delete withoutMaterialization.materializationId;
  expect(
    WorkerAgentTurnRunParamsSchema.safeParse(withoutMaterialization).success,
  ).toBe(false);
  expect(
    WorkerAgentSubagentRunParamsSchema.safeParse(subagentParams).success,
  ).toBe(true);
  expect(
    WorkerAgentSubagentRunParamsSchema.safeParse({
      ...subagentParams,
      repoPath: '/tmp/x',
    }).success,
  ).toBe(false);
});

it('results discriminate on status', () => {
  const error = {
    code: 'worker.agent.turnFailed',
    message: 'The chat turn ended with an error.',
  };
  const turn = { turnRunId: 'run', eventCount: 2 };
  expect(
    WorkerAgentTurnRunResultSchema.safeParse({ ...turn, status: 'failed' })
      .success,
  ).toBe(false);
  expect(
    WorkerAgentTurnRunResultSchema.safeParse({
      ...turn,
      status: 'failed',
      error,
    }).success,
  ).toBe(true);
  expect(
    WorkerAgentTurnRunResultSchema.safeParse({
      ...turn,
      status: 'cancelled',
      error,
    }).success,
  ).toBe(false);
  expect(
    WorkerAgentSubagentRunResultSchema.safeParse({
      subagentRunId: 'sub',
      status: 'failed',
    }).success,
  ).toBe(false);
  expect(
    WorkerAgentSubagentRunResultSchema.safeParse({
      subagentRunId: 'sub',
      status: 'cancelled',
      error: {
        code: 'worker.agent.subagentFailed',
        message: 'The subagent run ended with an error.',
      },
    }).success,
  ).toBe(false);
});

const launch = {
  format: 'canopy.agent-turn-launch.v1',
  cwdRootId: 'root',
  repoId: null,
  surface: 'worktree',
  executionHarness: 'claude',
  model: {
    selectedModelId: null,
    thinkingLevel: 'high',
    speed: null,
    contextWindow: null,
  },
  mode: { planMode: false, codexProposalMode: null },
  approval: { mode: 'ask', policyRevision: 3, admissionId: 'admission' },
  session: { providerSessionId: null, reconstructionSeedId: null, fork: null },
  instructions: {
    systemPromptAppend: null,
    globalInstructionsBlock: null,
    globalInstructionsSnapshot: null,
  },
  capabilities: {
    applyGlobalPluginDefaults: true,
    deferredToolsAllowed: true,
    codeGraphToolsAdvertised: false,
    rtkEnabled: false,
  },
  delegation: {
    surface: 'worktree-chat',
    mode: 'explicit-only',
    maxConcurrent: 3,
    maxDepth: 2,
    lifetimeLimit: null,
  },
  codex: null,
  executionContext: null,
  billing: {
    routes: [{ kind: 'ai_credits', routeId: 'route' }],
    subscriptionOverride: false,
    accountProxy: null,
    requiredAccountProxyConnectionId: null,
  },
  prompt: {
    messageId: 'message',
    blocks: [
      { type: 'text', text: 'Fix the bug' },
      {
        type: 'attachment',
        attachmentId: 'attachment',
        name: 'log.txt',
        mimeType: 'text/plain',
      },
    ],
  },
};

it('a portable launch is optional, closed and carries no host paths, keys, route URLs or approval rules (CAN-6995)', () => {
  expect(WorkerAgentTurnRunParamsSchema.parse(turnParams)).toEqual(turnParams);
  const portable = { ...turnParams, launch };
  expect(
    WORKER_AGENT_RUN_INSTRUCTION_DEFINITIONS[
      'worker.agent.turn.run'
    ].params.parse(portable),
  ).toEqual(portable);
  for (const leak of [
    { cwd: '/Users/someone/project' },
    { env: { ANTHROPIC_API_KEY: 'k' } },
    {
      billing: {
        ...launch.billing,
        routes: [{ kind: 'ai_credits', routeId: 'r', url: 'https://x' }],
      },
    },
    { approval: { ...launch.approval, sessionRules: [] } },
    {
      prompt: {
        messageId: 'm',
        blocks: [
          {
            type: 'attachment',
            attachmentId: 'a',
            name: 'n',
            mimeType: 't',
            path: '/tmp/a',
          },
        ],
      },
    },
  ])
    expect(
      WorkerAgentTurnLaunchSchema.safeParse({ ...launch, ...leak }).success,
    ).toBe(false);
  expect(
    WorkerAgentTurnLaunchSchema.safeParse({
      ...launch,
      prompt: { messageId: 'm', blocks: [] },
    }).success,
  ).toBe(false);
  expect(
    WorkerAgentTurnLaunchSchema.safeParse({
      ...launch,
      billing: {
        ...launch.billing,
        routes: Array.from(
          { length: WORKER_AGENT_TURN_LAUNCH_LIMITS.routes + 1 },
          (_, index) => ({ kind: 'account_proxy', routeId: `r${index}` }),
        ),
      },
    }).success,
  ).toBe(false);
  expect(
    WorkerAgentTurnLaunchSchema.safeParse({
      ...launch,
      executionContext: 'org:not-a-uuid',
    }).success,
  ).toBe(false);
});

it('a portable launch carries an unset session option as null, never as false (CAN-6995)', () => {
  const unset = {
    ...launch,
    executionHarness: null,
    mode: { planMode: null, codexProposalMode: null },
    session: {
      providerSessionId: null,
      reconstructionSeedId: null,
      fork: {
        forkSession: null,
        resumeAt: null,
        startsFresh: null,
        toolResults: null,
      },
    },
    capabilities: {
      applyGlobalPluginDefaults: null,
      deferredToolsAllowed: null,
      codeGraphToolsAdvertised: null,
      rtkEnabled: null,
    },
    delegation: { ...launch.delegation, mode: null },
    codex: {
      appServerIdleTimeoutMinutes: null,
      multiAgentEnabled: null,
      maxConcurrentSubagents: null,
    },
    billing: { ...launch.billing, subscriptionOverride: null },
  };
  expect(WorkerAgentTurnLaunchSchema.parse(unset)).toEqual(unset);
  const limit = (maxConcurrentSubagents: unknown): boolean =>
    WorkerAgentTurnLaunchSchema.safeParse({
      ...unset,
      codex: { ...unset.codex, maxConcurrentSubagents },
    }).success;
  expect([limit('none'), limit(4), limit(0), limit('all')]).toEqual([
    true,
    true,
    false,
    false,
  ]);
  expect(
    WorkerAgentTurnLaunchSchema.safeParse({
      ...launch,
      approval: { ...launch.approval, mode: null },
    }).success,
  ).toBe(false);
});

it('turn events resume after a worker-epoch cursor and stream the turn envelopes (CAN-6995)', () => {
  const definition =
    WORKER_AGENT_RUN_STREAM_DEFINITIONS['worker.agent.turn.events'];
  expect(definition.kind).toBe('stream');
  expect(definition.requiredGrants).toEqual(['worker.agent.execute']);
  expect(
    WorkerAgentTurnEventsParamsSchema.parse({
      turnRunId: 'run',
      cursor: { daemonEpoch: 'epoch', sequence: 4 },
    }),
  ).toEqual({
    turnRunId: 'run',
    cursor: { daemonEpoch: 'epoch', sequence: 4 },
  });
  expect(
    WorkerAgentTurnEventsParamsSchema.safeParse({
      turnRunId: 'run',
      afterSequence: 4,
    }).success,
  ).toBe(false);
  expect(definition.item.parse({ ...base, kind: 'accepted' })).toEqual({
    ...base,
    kind: 'accepted',
  });
});
