import { canonicalizeAgentModelConfig } from '@canopy/execution-engine/lib/codex-speed';
import { normalizeCodexMaxConcurrentSubagents } from '@canopy/execution-engine/lib/codex-multi-agent';
import type { AgentSessionOptions } from '../../agents/types';
import {
  TURN_LAUNCH_MEMBERS,
  resolveTurnLaunch,
  toPortableTurnLaunch,
  type PortableTurnSessionOptions,
  type TurnLaunchContext,
  type TurnLaunchHostPort,
} from '../turn-launch';

const scope = {
  workspaceId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
};
const rules: NonNullable<AgentSessionOptions['sessionApprovalRules']> = [
  {
    id: 'rule',
    behavior: 'allow',
    target: { kind: 'command', pattern: 'git status' },
    createdAt: '2026-11-24T00:00:00.000Z',
    origin: 'settings',
  },
];
const pluginSelections: NonNullable<AgentSessionOptions['pluginSelections']> = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
};
const routing = { active: true, scope: 'session', activatedAt: 1 } as const;

const port: TurnLaunchHostPort = {
  rootPath: (id) => (id === 'root' ? '/work/project' : null),
  admittedApprovalRules: (id) => (id === 'admission' ? rules : null),
  aiCreditsRouting: (id) => (id === 'route' ? routing : null),
};

const context: TurnLaunchContext = {
  cwdRootId: 'root',
  surface: 'worktree',
  approval: { admissionId: 'admission', policyRevision: 4 },
  prompt: { messageId: 'message', blocks: [{ type: 'text', text: 'Fix it' }] },
};

const base = {
  cwd: '/work/project',
  projectId: scope.workspaceId,
  worktreeId: scope.worktreeId,
  chatId: scope.chatId,
  providerType: 'claude',
  model: 'model-a',
  approvalMode: 'ask',
  sessionApprovalRules: rules,
} satisfies AgentSessionOptions;

/** Every option the launch, a reference or the params carry, set to a non-default value. */
const everyCarriedMember: AgentSessionOptions = {
  ...base,
  managedDelegationSurface: 'worktree-chat',
  managedDelegationMode: 'proactive',
  managedDelegationMaxConcurrent: 3,
  managedDelegationMaxDepth: 2,
  managedDelegationLifetimeLimit: 20,
  selectedRepoId: 'repo',
  executionContext: 'org:00000000-0000-4000-8000-000000000000',
  planMode: true,
  codexProposalMode: 'required',
  thinkingLevel: 'low',
  selectedModel: 'model-b',
  sdkSessionId: 'session',
  codexReconstructionSeedId: 'seed',
  claudeForkSession: true,
  claudeForkResumeAt: 'uuid',
  claudeForkStartsFresh: false,
  claudeForkToolResults: [{ toolUseId: 'tool', content: 'answer' }],
  applyGlobalPluginDefaults: false,
  deferredToolsAllowed: false,
  systemPromptAppend: 'append',
  globalInstructionsBlock: 'block',
  globalInstructionsSnapshot: 'snapshot',
  executionHarness: 'codex',
  codexAppServerIdleTimeoutMinutes: 15,
  codexMultiAgentEnabled: false,
  codexMaxConcurrentSubagents: 4,
  modelConfig: {
    thinkingLevel: 'low',
    speed: 'ultrafast',
    fastMode: false,
    contextWindow: 'maximum',
  },
  codexFastModeEnabled: true,
  rtkEnabled: false,
  codeGraphToolsAdvertised: false,
  aiCreditsRouting: routing,
  subscriptionBillingOverride: false,
  accountProxyRouting: 'off',
  requiredAccountProxyConnectionId: 'connection',
};

/** The options as each surface's caller builds them, host members included. */
const surfaces: Record<
  string,
  [AgentSessionOptions, Partial<TurnLaunchContext>]
> = {
  worktree: [
    {
      ...base,
      selectedRepoId: 'repo',
      managedDelegationSurface: 'worktree-chat',
      managedDelegationMode: 'explicit-only',
      thinkingLevel: 'high',
      modelConfig: { thinkingLevel: 'high', speed: 'fast', fastMode: true },
      executionHarness: 'claude',
      applyGlobalPluginDefaults: true,
      codeGraphToolsAdvertised: true,
      pluginSelections,
      toolProfileHash: 'hash',
    },
    {},
  ],
  cowork: [
    {
      ...base,
      managedDelegationSurface: 'cowork-chat',
      thinkingLevel: 'medium',
      modelConfig: { thinkingLevel: 'medium' },
      executionHarness: 'codex',
      codexAppServerIdleTimeoutMinutes: 10,
      codexMaxConcurrentSubagents: null,
      applyGlobalPluginDefaults: true,
    },
    { surface: 'cowork' },
  ],
  app_advisor: [
    {
      ...base,
      approvalMode: 'auto',
      managedDelegationSurface: 'app-advisor-chat',
      thinkingLevel: 'high',
      modelConfig: { thinkingLevel: 'high' },
      claudeForkSession: true,
      claudeForkResumeAt: 'uuid',
      assistantMode: 'app-advisor',
    },
    { surface: 'app_advisor' },
  ],
  pipeline_editor: [
    {
      ...base,
      planMode: false,
      thinkingLevel: 'high',
      modelConfig: { thinkingLevel: 'high' },
      deferredToolsAllowed: true,
      systemPromptAppend: 'editor',
      executionHarness: 'claude',
      codexAppServerIdleTimeoutMinutes: 10,
      codexMultiAgentEnabled: false,
      rtkEnabled: true,
      assistantMode: 'pipeline-editor',
      toolProfileHash: 'hash',
    },
    { surface: 'pipeline_editor' },
  ],
  standalone_with_routing: [
    { ...base, aiCreditsRouting: routing, subscriptionBillingOverride: true },
    { surface: 'standalone', aiCreditsRouteId: 'route' },
  ],
};

const hostMembers = Object.entries(TURN_LAUNCH_MEMBERS)
  .filter(([, kind]) => kind === 'host')
  .map(([member]) => member);

/**
 * What a session served from the launch must see: the options without host
 * members, with the model selection in the form every session reads. The
 * session reads thinking from either field and speed through
 * readCodexSpeedRecord, so the launch writes both thinking fields and the
 * canonical speed, and drops the legacy alias once the config has a speed.
 */
function portableView(
  options: AgentSessionOptions,
): PortableTurnSessionOptions {
  const view: PortableTurnSessionOptions = { ...options };
  for (const member of hostMembers) Reflect.deleteProperty(view, member);
  delete view.codexFastModeEnabled;
  const modelConfig = {
    ...options.modelConfig,
    ...(options.thinkingLevel !== undefined
      ? { thinkingLevel: options.thinkingLevel }
      : {}),
  };
  if (Object.keys(modelConfig).length > 0)
    view.modelConfig = canonicalizeAgentModelConfig(modelConfig);
  else delete view.modelConfig;
  if (options.codexMaxConcurrentSubagents !== undefined)
    view.codexMaxConcurrentSubagents = normalizeCodexMaxConcurrentSubagents(
      options.codexMaxConcurrentSubagents,
    );
  return view;
}

function roundTrip(
  options: AgentSessionOptions,
  overrides: Partial<TurnLaunchContext> = {},
): PortableTurnSessionOptions {
  const built = toPortableTurnLaunch(options, { ...context, ...overrides });
  if (!built.ok) throw new Error(built.reason);
  const resolved = resolveTurnLaunch(
    built.launch,
    { scope, providerId: 'claude', model: 'model-a' },
    port,
  );
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.options;
}

it('every surface resolves the session options it built, without host members (CAN-6995)', () => {
  for (const [surface, [options, overrides]] of Object.entries(surfaces))
    expect([surface, roundTrip(options, overrides)]).toEqual([
      surface,
      portableView(options),
    ]);
});

it('the launch carries every member it classifies to carry (CAN-6995)', () => {
  const carried = Object.entries(TURN_LAUNCH_MEMBERS)
    .filter(([, kind]) => kind !== 'host')
    .map(([member]) => member)
    .sort();
  expect(Object.keys(everyCarriedMember).sort()).toEqual(carried);
  expect(roundTrip(everyCarriedMember, { aiCreditsRouteId: 'route' })).toEqual(
    portableView(everyCarriedMember),
  );
});

it('an unset option stays unset, so the session default applies (CAN-6995)', () => {
  const resolved = roundTrip(base);
  expect(resolved).toEqual(base);
  for (const member of [
    'rtkEnabled',
    'deferredToolsAllowed',
    'codeGraphToolsAdvertised',
    'codexMultiAgentEnabled',
    'codexMaxConcurrentSubagents',
    'planMode',
  ])
    expect(member in resolved).toBe(false);
  expect(
    roundTrip({ ...base, codexMaxConcurrentSubagents: null })
      .codexMaxConcurrentSubagents,
  ).toBeNull();
});

/** The options a stored chat may hold, with a harness outside the type. */
function withStoredHarness(harness: string): AgentSessionOptions {
  const options: AgentSessionOptions = { ...base };
  Reflect.set(options, 'executionHarness', harness);
  return options;
}

it('options that cannot cross exactly build no launch (CAN-6995)', () => {
  const cases: AgentSessionOptions[] = [
    { ...base, approvalMode: undefined },
    withStoredHarness('ollama'),
    { ...base, thinkingLevel: 'high', modelConfig: { thinkingLevel: 'low' } },
    { ...base, codexFastModeEnabled: true },
    { ...base, aiCreditsRouting: routing },
    { ...base, managedDelegationMaxDepth: 2 },
    {
      ...base,
      managedDelegationSurface: 'worktree-chat',
      managedDelegationMaxDepth: 0,
    },
  ];
  const reasons = cases.map((options) => {
    const built = toPortableTurnLaunch(options, context);
    return built.ok ? 'built' : built.reason;
  });
  expect(reasons).toEqual([
    'the send has no admitted approval mode',
    'the execution harness is not a worker harness',
    'the model config and session disagree on thinking level',
    'the speed is set only by the legacy fast-mode alias',
    'AI Credits routing has no route id',
    'delegation limits are set without a delegation surface',
    'the launch is outside its schema at delegation.maxDepth',
  ]);
});

it('an unattended automation turn builds no launch, so it stays in-process (CAN-6995)', () => {
  expect(
    toPortableTurnLaunch({ ...base, accountResolution: 'unattended' }, context),
  ).toEqual({
    ok: false,
    reason: "an automation turn's account resolution does not cross yet",
  });
});

it("an automation turn's allowed shared-connection writes build no launch (CAN-6995)", () => {
  expect(
    toPortableTurnLaunch(
      { ...base, sharedConnectionWrites: { connection: ['write'] } },
      context,
    ),
  ).toEqual({
    ok: false,
    reason: "an automation turn's account resolution does not cross yet",
  });
});

it('a run whose provider id is not a session provider serves nothing (CAN-6995)', () => {
  const built = toPortableTurnLaunch(base, context);
  if (!built.ok) throw new Error(built.reason);
  expect(
    resolveTurnLaunch(
      built.launch,
      { scope, providerId: 'not-a-provider', model: null },
      port,
    ),
  ).toEqual({ ok: false, reason: 'the provider is not a known provider' });
});

it('a launch whose references the host cannot resolve serves nothing (CAN-6995)', () => {
  const built = toPortableTurnLaunch(base, context);
  if (!built.ok) throw new Error(built.reason);
  const params = { scope, providerId: 'claude', model: null };
  const unknown = (patch: Partial<TurnLaunchHostPort>): string => {
    const resolved = resolveTurnLaunch(built.launch, params, {
      ...port,
      ...patch,
    });
    return resolved.ok ? 'resolved' : resolved.reason;
  };
  expect([
    unknown({ rootPath: () => null }),
    unknown({ admittedApprovalRules: () => null }),
  ]).toEqual([
    'the worker root is unknown',
    'the approval admission is unknown',
  ]);
  const routed = toPortableTurnLaunch(
    { ...base, aiCreditsRouting: routing },
    { ...context, aiCreditsRouteId: 'other' },
  );
  if (!routed.ok) throw new Error(routed.reason);
  expect(resolveTurnLaunch(routed.launch, params, port)).toEqual({
    ok: false,
    reason: 'the AI Credits route is unknown',
  });
});
