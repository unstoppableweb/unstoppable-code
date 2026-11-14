import { resolvePipelineAgentAliasRoute } from '@canopy/pipeline-interop';
import { installedItemKey } from '@canopy/protocol/installed-items';
// CAN-5095: Electron main settles pipeline owner requests for a daemon run it
// follows, with its in-process functions and the run's own stored scope.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkerPipelineHostRequestSchema,
  type WorkerPipelineHostRequest,
  type WorkerPipelineOwnerResult,
} from '@canopy/protocol/canopy-core';
import { McpCredentialBroker } from '@canopy/core-runtime/node/mcp-auth';
import { pluginMcpServerContentHash } from '@canopy/execution-engine/node/plugins/plugin-mcp-content-hash';
import type { PipelineOwnerSettlement } from '@canopy/core-runtime/node/pipeline';
import {
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
} from '@canopy/desktop-shared/types';
import type { ExecutionState } from '@canopy/execution-engine/node/pipelines/executor/types';
import {
  PipelineOwnerRunContext,
  type PipelineOwnerRun,
} from '../pipeline-owner-requests';
import { createElectronExecutionRuntime } from '../execution-runtime';
import { resolveClaudeModConfigDirectory } from '../../agents/claude-mod-admission-launch';
import type { McpOAuthSubject } from '../../mcp/oauth-credentials';
import {
  resolvePluginMcpOAuthRoute,
  type PluginMcpOAuthRoute,
} from '../../plugins/plugin-resolver';

const ROUTE_CANARY = 'http://127.0.0.1:9/codex-gateway/route-canary';
const KEY_CANARY = 'sk-account-proxy-client-key-canary';
const ROUTE = 'pipeline:execution-1:job:step:1:1:0';

const mockRouting = jest.fn<Promise<unknown>, unknown[]>(() =>
  Promise.resolve(null),
);
const mockUnregisterRoutes = jest.fn();
const mockOwnerFor = jest.fn<Promise<unknown>, unknown[]>(() =>
  Promise.resolve({ kind: 'personal' }),
);
const mockPolicyActive = jest.fn<boolean, unknown[]>(() => false);
const mockCreateApprovalSession = jest.fn(() => ({
  check: jest.fn(),
  dispose: jest.fn(),
}));
const mockLedgerDispose = jest.fn();
const mockModAdmission = jest.fn<Promise<unknown>, unknown[]>(() =>
  Promise.resolve(undefined),
);

jest.mock('electron', () => ({
  ...jest.requireActual<object>('electron'),
}));
jest.mock('../../agents/ai-credits-routing', () => ({
  resolveAiCreditsRoutingOverride: (...args: unknown[]): unknown =>
    Reflect.apply(mockRouting, undefined, args),
}));
jest.mock('../../agents/codex-gateway-proxy-service', () => ({
  getCodexGatewayProxyService: (): unknown => ({
    unregisterRoutesForSession: mockUnregisterRoutes,
  }),
}));
jest.mock('../../agents/work-owner', () => ({
  resolveBackgroundWorkOwner: (...args: unknown[]): unknown =>
    Reflect.apply(mockOwnerFor, undefined, args),
}));
jest.mock('../../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (): boolean => false,
  isOrgModelPolicyActiveForStoredAccount: (...args: unknown[]): unknown =>
    Reflect.apply(mockPolicyActive, undefined, args),
}));
jest.mock('../../approvals/approval-service', () => ({
  createApprovalSession: (...args: unknown[]): unknown =>
    Reflect.apply(mockCreateApprovalSession, undefined, args),
}));
jest.mock('../../canopy-tools/ledger-tools-runtime', () => ({
  DESKTOP_LEDGER_TOOLS_HOST: {
    containerCreatedAt: (): Promise<string> =>
      Promise.resolve('2026-11-06T00:00:00.000Z'),
  },
  openLedgerPipelineAgentTools: (): Promise<unknown> =>
    Promise.resolve({
      systemPrompt: (): string => 'LEDGER',
      dispose: mockLedgerDispose,
      scope: { container: { kind: 'task' }, containerCreatedAt: 't' },
    }),
}));
jest.mock('../../ledger/pipeline-agent-owners', () => ({
  ...jest.requireActual<object>('../../ledger/pipeline-agent-owners'),
  getLedgerPipelineAgentOwners: (): unknown => ({
    noteRunning: jest.fn(),
    notePaused: jest.fn(),
  }),
  retireLedgerPipelineExecution: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../../ledger/session-end-sweep-ports', () => ({
  ...jest.requireActual<object>('../../ledger/session-end-sweep-ports'),
  notifyLedgerSessionEnded: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../../agents/claude-mod-admission-launch', () => ({
  ...jest.requireActual<object>('../../agents/claude-mod-admission-launch'),
  resolveClaudeModAdmissionContext: (...args: unknown[]): Promise<unknown> =>
    mockModAdmission(...args),
}));
// CAN-5832: Agent model aliases resolve from the Agent store.
const mockAgents = new Map<string, unknown>();
const mockDestinationDefault = jest.fn<Promise<string>, unknown[]>(() =>
  Promise.resolve('sonnet'),
);
jest.mock('../../agents/agent-model-store', () => ({
  getAgentModel: (id: string): Promise<unknown> =>
    Promise.resolve(mockAgents.get(id) ?? null),
}));
jest.mock('../../agents/agent-default-model', () => ({
  resolveAgentDestinationDefaultModel: (...args: unknown[]): Promise<string> =>
    mockDestinationDefault(...args),
}));
// CAN-5831: the local Ollama server's route on either harness; no key.
jest.mock('../../ollama/claude-compatible', () => ({
  resolveClaudeCompatibleInvocation: (): Promise<unknown> =>
    Promise.resolve({
      providerType: 'ollama',
      sdkModel: 'qwen3-coder',
      envOverride: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
        ANTHROPIC_AUTH_TOKEN: 'ollama',
      },
    }),
}));
jest.mock('../../ollama/codex-compatible', () => ({
  resolveCodexCompatibleOllamaInvocation: (): Promise<unknown> =>
    Promise.resolve({
      source: 'ollama',
      harness: 'codex',
      runtimeModel: 'qwen3-coder',
      aiCreditsRouted: false,
      codexConfig: {
        model_provider: 'canopy_ollama',
        model: 'qwen3-coder',
        model_providers: {
          canopy_ollama: { base_url: 'http://127.0.0.1:11434/v1' },
        },
      },
    }),
}));
// CAN-6327: a run's plan writes become tracked plans of its worktree.
const mockCreateTrackedPlan = jest.fn<Promise<{ id: string }>, unknown[]>(() =>
  Promise.resolve({ id: 'tracked-plan-1' }),
);
const mockUpdateTrackedPlan = jest.fn<Promise<unknown>, unknown[]>(() =>
  Promise.resolve(null),
);
jest.mock('../../lib/plan-persistence', () => ({
  createTrackedPlan: (...args: unknown[]): Promise<unknown> =>
    mockCreateTrackedPlan(...args),
  updateTrackedPlan: (...args: unknown[]): Promise<unknown> =>
    mockUpdateTrackedPlan(...args),
}));
// CAN-6168: the installed plugins this app reads, and the reads around them.
const mockMarketplaces: { current: unknown[] } = { current: [] };
jest.mock('../../plugins/plugin-service', () => ({
  ...jest.requireActual<object>('../../plugins/plugin-service'),
  loadMarketplaces: (): Promise<unknown> =>
    Promise.resolve({
      success: true,
      data: { marketplaces: mockMarketplaces.current },
    }),
}));
const mockPreferences: { current: Record<string, unknown> } = { current: {} };
jest.mock('../../lib/preferences-store', () => ({
  ...jest.requireActual<object>('../../lib/preferences-store'),
  readPreferencesFile: (): Promise<unknown> =>
    Promise.resolve(mockPreferences.current),
}));
jest.mock('../../mcp/oauth-token-store', () => ({
  ...jest.requireActual<object>('../../mcp/oauth-token-store'),
  migratePluginMcpOAuthToken: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../../mcp/oauth-probe', () => ({
  probeMcpHttpOAuthRequirement: (): Promise<unknown> =>
    Promise.resolve({ requiresOAuth: false, requirement: 'none' }),
}));

jest.mock('../../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: (): unknown => ({
    registerCanopyWorktreeSessionRoute: (): Promise<void> => Promise.resolve(),
    unregisterCanopyWorktreeSessionRoute: jest.fn(),
    unregisterRoutesForSession: jest.fn(),
    getCanopyWorktreeMcpUrl: (key: string): string =>
      `http://127.0.0.1:9/mcp/${key}`,
    getCodexCapabilityAuthorityIds: (): string[] => [],
  }),
}));

const CLAUDE = 'sonnet';
const CODEX = 'gpt-6.1-sol';
const OLLAMA = 'ollama-qwen3-coder';
let worktree: string;

function state(): ExecutionState {
  return {
    version: 9,
    id: 'execution-1',
    pipeline_id: 'pipeline',
    pipeline_snapshot: { name: 'P', scope: ['worktree'], jobs: {} },
    status: 'running',
    jobs: {},
    job_definitions: {},
    job_groups: {},
    started_at: '2026-11-06T00:00:00.000Z',
    cwd: worktree,
    env: {},
    inputs: {},
    project_id: 'workspace-1',
    worktree_id: 'worktree-1',
    execution_context: 'personal',
    initiation_source: 'user',
    pending_pauses: [],
    status_reasons: [],
  };
}

function run(): PipelineOwnerRun {
  return {
    executionId: 'execution-1',
    scope: () => ({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      executionContext: 'personal',
      folder: worktree,
    }),
    secretValues: [],
  };
}

function ownerRequest(
  request: WorkerPipelineHostRequest['request'],
  overrides: Partial<WorkerPipelineHostRequest> = {},
): WorkerPipelineHostRequest {
  return {
    requestId: `owner-${Math.random()}`,
    executionId: 'execution-1',
    jobId: 'job',
    stepId: 'step',
    childExecutionId: null,
    attempt: 0,
    iteration: 0,
    owner: null,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    request,
    ...overrides,
  };
}

function ownerValue(
  settlement: PipelineOwnerSettlement,
): WorkerPipelineOwnerResult | undefined {
  return settlement.result.status === 'owner'
    ? settlement.result.value
    : undefined;
}

const signal = new AbortController().signal;

beforeAll(() => {
  initClaudeModels([{ id: CLAUDE, label: 'Sonnet' }]);
  initCodexModels([{ id: CODEX, label: 'Codex default' }]);
  initOllamaModels([
    {
      id: OLLAMA,
      rawModelId: 'qwen3-coder',
      label: 'qwen3-coder',
      show: { capabilities: ['completion', 'tools'] },
    },
  ]);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRouting.mockImplementation(() => Promise.resolve(null));
  mockPolicyActive.mockImplementation(() => false);
  worktree = realpathSync(
    mkdtempSync(join(tmpdir(), 'canopy-owner-settlement-')),
  );
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

describe('PipelineOwnerRunContext', () => {
  it('an account-proxy step receives a broker route reference, never the client key', async () => {
    const env = {
      ANTHROPIC_BASE_URL: ROUTE_CANARY,
      ANTHROPIC_AUTH_TOKEN: 'canopy-loopback-broker',
    };
    mockRouting.mockImplementation(() =>
      Promise.resolve({
        provider: 'claude',
        model: 'm',
        accountProxyRouted: true,
        accountProxyConnectionId: 'conn-1',
        env,
      }),
    );
    const context = new PipelineOwnerRunContext(run());
    const settlement = await context.apply(
      ownerRequest({
        action: 'owner.model.invocation',
        harness: 'claude',
        model: CLAUDE,
        routeSessionId: ROUTE,
      }),
      signal,
    );
    expect(ownerValue(settlement)).toMatchObject({
      kind: 'model.invocation',
      accountProxyRouted: true,
      accountProxyConnectionId: 'conn-1',
    });
    expect(JSON.stringify(settlement.result)).not.toContain('route-canary');
    expect(settlement.values?.env).toEqual(env);
    expect(JSON.stringify(settlement)).not.toContain(KEY_CANARY);
  });

  it("answers the organization policy from the run's owner, not the request's", async () => {
    const context = new PipelineOwnerRunContext(run());
    const settlement = await context.apply(
      ownerRequest(
        { action: 'owner.model.policy', check: 'active' },
        { owner: 'org:00000000-0000-4000-8000-000000000001' },
      ),
      signal,
    );
    expect(ownerValue(settlement)).toEqual({
      kind: 'model.policy',
      answer: false,
    });
    expect(mockOwnerFor).toHaveBeenCalledWith(
      { projectId: 'workspace-1', worktreeId: 'worktree-1' },
      'personal',
    );

    mockPolicyActive.mockImplementation(() => {
      throw new Error('unreadable policy');
    });
    const failed = await context.apply(
      ownerRequest({ action: 'owner.model.policy', check: 'active' }),
      signal,
    );
    expect(failed.result.status).toBe('failure');
    expect(ownerValue(failed)).toBeUndefined();
  });

  it("a Ledger subprocess route keeps the step's approval session", async () => {
    const context = new PipelineOwnerRunContext(run());
    const opened = await context.apply(
      ownerRequest({
        action: 'owner.ledger.open',
        physicalJobId: 'job',
        logicalJobId: 'job',
        jobName: 'Job',
        stepId: 'step',
        stepName: 'Step',
        attempt: 1,
        iteration: 0,
        harness: 'claude',
        permissionPreset: 'read_only',
      }),
      signal,
    );
    const value = ownerValue(opened);
    const attemptKey =
      value?.kind === 'ledger.open' ? value.attempt?.attemptKey : undefined;
    expect(attemptKey).toEqual(expect.any(String));
    if (attemptKey === undefined) return;

    const tools = await context.apply(
      ownerRequest({
        action: 'owner.ledger.subprocessTools',
        attemptKey,
        cwd: worktree,
      }),
      signal,
    );
    expect(mockCreateApprovalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: `pipeline-ledger-claude-${attemptKey}`,
        workspaceRoot: worktree,
        mode: 'auto',
      }),
    );
    expect(
      Object.keys(tools.values?.ledgerSubprocessTools?.mcpServers ?? {}),
    ).toHaveLength(1);

    const outside = join(tmpdir(), `canopy-owner-outside-${Date.now()}`);
    mkdirSync(outside);
    try {
      const refused = await context.apply(
        ownerRequest({
          action: 'owner.ledger.subprocessTools',
          attemptKey,
          cwd: outside,
        }),
        signal,
      );
      expect(refused.result).toMatchObject({
        status: 'failure',
        message: 'This step folder is outside the workflow run.',
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('settles only its own run, and releases only the routes it issued', async () => {
    const context = new PipelineOwnerRunContext(run());
    const foreign = await context.apply(
      ownerRequest(
        { action: 'owner.model.release', routeSessionId: ROUTE },
        { executionId: 'execution-other' },
      ),
      signal,
    );
    expect(foreign.result).toMatchObject({
      status: 'failure',
      message: 'This app did not start this workflow run.',
    });

    await context.apply(
      ownerRequest({
        action: 'owner.model.release',
        routeSessionId: 'unknown',
      }),
      signal,
    );
    expect(mockUnregisterRoutes).not.toHaveBeenCalled();

    await context.apply(
      ownerRequest({
        action: 'owner.model.routing',
        provider: 'claude',
        model: CLAUDE,
        routeSessionId: ROUTE,
      }),
      signal,
    );
    await context.apply(
      ownerRequest({
        action: 'owner.ledger.open',
        physicalJobId: 'job',
        logicalJobId: 'job',
        jobName: 'Job',
        stepId: 'step',
        stepName: 'Step',
        attempt: 1,
        iteration: 0,
        harness: 'claude',
        permissionPreset: 'read_only',
      }),
      signal,
    );
    await context.close(state());
    expect(mockUnregisterRoutes).toHaveBeenCalledTimes(1);
    expect(mockUnregisterRoutes).toHaveBeenCalledWith(ROUTE);
    expect(mockLedgerDispose).toHaveBeenCalledTimes(1);

    const late = await context.apply(
      ownerRequest({ action: 'owner.model.policy', check: 'active' }),
      signal,
    );
    expect(late.result).toMatchObject({
      status: 'failure',
      message: 'This workflow run has ended.',
    });
  });

  it("an Agent alias resolves as in process, with the run's own workspace", async () => {
    mockAgents.set('agent_model_reviewer', {
      id: 'agent_model_reviewer',
      name: 'Reviewer',
      baseModel: CODEX,
      instructions: 'Review carefully.',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    });
    mockAgents.set('agent_model_inherit', {
      id: 'agent_model_inherit',
      name: 'Inherit',
      baseModel: 'default',
      instructions: '',
    });
    const runtime = createElectronExecutionRuntime();
    const context = new PipelineOwnerRunContext(run());
    for (const agentId of [
      'agent_model_reviewer',
      'agent_model_inherit',
      resolvePipelineAgentAliasRoute({
        agent_id: 'agent_model_reviewer',
        base: CLAUDE,
      }),
    ]) {
      const inProcess = await runtime.resolvePipelineAgentModelAlias?.(
        agentId,
        { projectId: 'workspace-1' },
      );
      if (agentId.includes('@'))
        expect(inProcess).toMatchObject({
          agentId: 'agent_model_reviewer',
          base: CLAUDE,
          instructions: 'Review carefully.',
        });
      // The request names another workspace; the run's own decides.
      const settlement = await context.apply(
        ownerRequest(
          { action: 'owner.model.agentAlias', agentId },
          { owner: 'org:another' },
        ),
        signal,
      );
      const value = ownerValue(settlement);
      expect(value).toEqual({ kind: 'model.agentAlias', alias: inProcess });
      expect(settlement.values).toBeUndefined();
    }
    expect(mockDestinationDefault).toHaveBeenCalledWith('workspace-1');
    expect(
      ownerValue(
        await context.apply(
          ownerRequest({
            action: 'owner.model.agentAlias',
            agentId: 'agent_model_missing',
          }),
          signal,
        ),
      ),
    ).toEqual({ kind: 'model.agentAlias', alias: null });
  });

  it('the in-process runtime and the owner settlement resolve the same invocation', async () => {
    const runtime = createElectronExecutionRuntime();
    const cases: Array<{
      model: string;
      routed: unknown;
      harness?: 'claude' | 'codex';
    }> = [
      { model: CLAUDE, routed: null },
      { model: OLLAMA, routed: null, harness: 'claude' },
      { model: OLLAMA, routed: null, harness: 'codex' },
      {
        model: CLAUDE,
        routed: {
          provider: 'claude',
          model: CLAUDE,
          accountProxyRouted: true,
          accountProxyConnectionId: 'conn-1',
          env: { ANTHROPIC_BASE_URL: ROUTE_CANARY },
        },
      },
      {
        model: CODEX,
        routed: {
          provider: 'codex',
          model: CODEX,
          accountProxyRouted: true,
          accountProxyConnectionId: 'conn-2',
          env: {},
          codexConfig: {
            model_providers: { canopy: { base_url: ROUTE_CANARY } },
          },
        },
      },
    ];
    for (const { model, routed, harness: assigned } of cases) {
      mockRouting.mockImplementation(() => Promise.resolve(routed));
      const harness = assigned ?? (model === CODEX ? 'codex' : 'claude');
      const options = {
        harness,
        routeSessionId: ROUTE,
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        executionContext: 'personal',
        signal,
      };
      const inProcess = await runtime.resolveModelHarnessInvocation?.(
        model,
        options,
      );
      const settlement = await new PipelineOwnerRunContext(run()).apply(
        ownerRequest({
          action: 'owner.model.invocation',
          harness,
          model,
          routeSessionId: ROUTE,
        }),
        signal,
      );
      const value = ownerValue(settlement);
      if (value?.kind !== 'model.invocation') throw new Error('No invocation');
      expect({
        ...value,
        ...(settlement.values?.env
          ? { envOverride: settlement.values.env }
          : {}),
        ...(settlement.values?.codexConfig
          ? { codexConfig: settlement.values.codexConfig }
          : {}),
      }).toEqual({
        kind: 'model.invocation',
        ...inProcess,
        modelGatewayRouted: inProcess?.modelGatewayRouted === true,
        accountProxyRouted: inProcess?.accountProxyRouted === true,
      });
    }
  });

  it('close waits for a request in flight and releases what it created', async () => {
    let resolveRouting: (value: unknown) => void = () => undefined;
    mockRouting.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRouting = resolve;
        }),
    );
    const context = new PipelineOwnerRunContext(run());
    const routing = context.apply(
      ownerRequest({
        action: 'owner.model.routing',
        provider: 'claude',
        model: CLAUDE,
        routeSessionId: ROUTE,
      }),
      signal,
    );
    const closing = context.close(state());
    resolveRouting({
      provider: 'claude',
      model: CLAUDE,
      env: { ANTHROPIC_BASE_URL: ROUTE_CANARY },
    });
    const [settlement] = await Promise.all([routing, closing]);
    expect(settlement.result).toMatchObject({
      status: 'failure',
      message: 'This workflow run has ended.',
    });
    expect(settlement.values).toBeUndefined();
    expect(mockUnregisterRoutes).toHaveBeenCalledTimes(1);
    expect(mockUnregisterRoutes).toHaveBeenCalledWith(ROUTE);
  });

  it("answers a step's Claude Mod policy for a folder in the run, and refuses one outside it", async () => {
    const context = new PipelineOwnerRunContext(run());
    const policy = {
      enabled: true,
      authority: 'ok',
      admissions: [],
      modsDisabled: true,
      ambientPlugins: [{ pluginId: 'demo@market', installPath: worktree }],
      sessionModIds: [],
    };
    mockModAdmission.mockResolvedValue(policy);
    const inside = await context.apply(
      ownerRequest({
        action: 'owner.claude.modAdmission',
        cwd: worktree,
        settingSources: ['user', 'project'],
      }),
      signal,
    );
    expect(ownerValue(inside)).toEqual({
      kind: 'claude.modAdmission',
      context: policy,
    });
    expect(mockModAdmission).toHaveBeenCalledWith({
      cwd: worktree,
      settingSources: ['user', 'project'],
    });

    // The user's own Claude config folder, which an in-process step reads too.
    const ownConfig = await context.apply(
      ownerRequest({
        action: 'owner.claude.modAdmission',
        cwd: worktree,
        settingSources: ['user'],
        claudeConfigDir: resolveClaudeModConfigDirectory({
          cwd: worktree,
          environment: false,
        }),
      }),
      signal,
    );
    expect(ownerValue(ownConfig)).toMatchObject({
      kind: 'claude.modAdmission',
    });

    // A config folder in the run that does not exist yet.
    const fresh = await context.apply(
      ownerRequest({
        action: 'owner.claude.modAdmission',
        cwd: worktree,
        settingSources: ['user'],
        claudeConfigDir: join(worktree, 'not-yet', 'claude'),
      }),
      signal,
    );
    expect(ownerValue(fresh)).toMatchObject({
      kind: 'claude.modAdmission',
    });

    mockModAdmission.mockClear();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-mods-')));
    try {
      for (const request of [
        { cwd: elsewhere },
        { cwd: worktree, claudeConfigDir: elsewhere },
      ]) {
        const refused = await context.apply(
          ownerRequest({
            action: 'owner.claude.modAdmission',
            settingSources: ['user'],
            ...request,
          }),
          signal,
        );
        expect(refused.result).toMatchObject({
          status: 'failure',
          message: 'This step folder is outside the workflow run.',
        });
      }
      // A link inside the run that resolves elsewhere is refused too.
      const link = join(worktree, 'claude-config');
      symlinkSync(elsewhere, link);
      // So is a folder not created yet under such a link.
      for (const claudeConfigDir of [link, join(link, 'not-yet')]) {
        const linked = await context.apply(
          ownerRequest({
            action: 'owner.claude.modAdmission',
            cwd: worktree,
            settingSources: ['user'],
            claudeConfigDir,
          }),
          signal,
        );
        expect(linked.result).toMatchObject({
          status: 'failure',
          message: 'This step folder is outside the workflow run.',
        });
      }
      expect(mockModAdmission).not.toHaveBeenCalled();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }

    // An answer beyond its bounds is refused, never sent.
    mockModAdmission.mockResolvedValue({
      ...policy,
      ambientPlugins: Array.from({ length: 1025 }, (_, index) => ({
        pluginId: `mod-${index}@market`,
        installPath: worktree,
      })),
    });
    const oversized = await context.apply(
      ownerRequest({
        action: 'owner.claude.modAdmission',
        cwd: worktree,
        settingSources: ['user'],
      }),
      signal,
    );
    expect(oversized.result.status).toBe('failure');
  });

  it('a route session of another run is refused and never released', async () => {
    const context = new PipelineOwnerRunContext(run());
    for (const action of [
      'owner.model.routing',
      'owner.model.invocation',
    ] as const) {
      const refused = await context.apply(
        ownerRequest(
          action === 'owner.model.routing'
            ? {
                action,
                provider: 'claude',
                model: CLAUDE,
                routeSessionId: 'pipeline:execution-other:job:step:1:1:0',
              }
            : {
                action,
                harness: 'claude',
                model: CLAUDE,
                routeSessionId: 'another-run-route',
              },
        ),
        signal,
      );
      expect(refused.result).toMatchObject({
        status: 'failure',
        message: 'This route session belongs to another workflow run.',
      });
    }
    expect(mockRouting).not.toHaveBeenCalled();
    await context.apply(
      ownerRequest({
        action: 'owner.model.release',
        routeSessionId: 'another-run-route',
      }),
      signal,
    );
    await context.close(state());
    expect(mockUnregisterRoutes).not.toHaveBeenCalled();
  });

  it('a request that names no route session routes under one the run releases', async () => {
    mockRouting.mockImplementation(() =>
      Promise.resolve({
        provider: 'claude',
        model: CLAUDE,
        env: { ANTHROPIC_BASE_URL: ROUTE_CANARY },
      }),
    );
    const context = new PipelineOwnerRunContext(run());
    const settlement = await context.apply(
      ownerRequest({
        action: 'owner.model.routing',
        provider: 'claude',
        model: CLAUDE,
      }),
      signal,
    );
    expect(settlement.result.status).toBe('owner');
    const session = mockRouting.mock.calls[0]?.[3];
    expect(typeof session).toBe('string');
    expect(String(session).startsWith('pipeline:execution-1:owner:')).toBe(
      true,
    );
    await context.close(state());
    expect(mockUnregisterRoutes).toHaveBeenCalledTimes(1);
    expect(mockUnregisterRoutes).toHaveBeenCalledWith(session);
  });

  it("keeps a run's plan writes as tracked plans of its own worktree, and only its own (CAN-6327)", async () => {
    const context = new PipelineOwnerRunContext(run());
    const created = await context.apply(
      ownerRequest({ action: 'owner.plan.create', content: '# Plan\n' }),
      signal,
    );
    expect(ownerValue(created)).toEqual({
      kind: 'plan.create',
      planId: 'tracked-plan-1',
    });
    expect(mockCreateTrackedPlan).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      source: 'pipeline',
      content: '# Plan\n',
      reviewStatus: 'approved',
      linkedExecutionId: 'execution-1',
    });
    const updated = await context.apply(
      ownerRequest({
        action: 'owner.plan.update',
        planId: 'tracked-plan-1',
        content: '# Plan\n\nRefined.\n',
        approve: true,
      }),
      signal,
    );
    expect(ownerValue(updated)).toEqual({ kind: 'plan.update' });
    expect(mockUpdateTrackedPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        planId: 'tracked-plan-1',
        content: '# Plan\n\nRefined.\n',
        reviewStatus: 'approved',
        linkedExecutionId: 'execution-1',
      }),
    );
    // A plan the run neither started from nor kept is never written.
    const foreign = await context.apply(
      ownerRequest({
        action: 'owner.plan.update',
        planId: 'tracked-plan-of-another-run',
        content: 'overwritten',
        approve: true,
      }),
      signal,
    );
    expect(foreign.result).toMatchObject({
      status: 'failure',
      message: 'This plan belongs to another workflow run.',
    });
    expect(mockUpdateTrackedPlan).toHaveBeenCalledTimes(1);
    // A start-time create that lands after the run kept its plan keeps nothing.
    const late = await context.apply(
      ownerRequest({
        action: 'owner.plan.create',
        content: '# Plan\n',
        initial: true,
      }),
      signal,
    );
    expect(ownerValue(late)).toEqual({
      kind: 'plan.create',
      planId: 'tracked-plan-1',
    });
    expect(mockCreateTrackedPlan).toHaveBeenCalledTimes(1);
    await context.close(state());
  });
});

describe('owner Codex plugin refs (CAN-6168)', () => {
  afterEach(() => {
    mockPreferences.current = {};
  });

  it("answers a daemon Codex step's selections with this app's own policy: disabled items out", async () => {
    mockPreferences.current = {
      disabledInstalledItems: [
        installedItemKey({
          kind: 'plugin',
          marketplaceId: 'market',
          pluginName: 'off',
        }),
      ],
    };
    const context = new PipelineOwnerRunContext(run());
    const answer = ownerValue(
      await context.apply(
        ownerRequest({
          action: 'owner.codex.pluginRefs',
          selections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [
              { marketplaceId: 'market', pluginName: 'notes' },
              { marketplaceId: 'market', pluginName: 'off' },
            ],
          },
        }),
        signal,
      ),
    );
    expect(answer).toEqual({
      kind: 'codex.pluginRefs',
      selections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'market', pluginName: 'notes' }],
        mcpServerRefs: [],
      },
      warnings: [],
    });
  });
});

describe('owner MCP credentials (CAN-6168)', () => {
  const TOKEN = 'mcp-oauth-access-token-canary';
  const UPSTREAM = 'https://mcp.example.test/docs';
  const SERVER = {
    type: 'http',
    url: UPSTREAM,
    oauth: { clientId: 'client-1', scopes: ['read'] },
  };

  function broker(resolve: () => Promise<string | null>): {
    broker: McpCredentialBroker<McpOAuthSubject>;
    resolve: jest.Mock<
      Promise<string | null>,
      [McpOAuthSubject, AbortSignal | undefined]
    >;
    invalidate: jest.Mock<Promise<void>, [McpOAuthSubject, string, string]>;
  } {
    const owner = {
      scopeOf: (): string => 'scope',
      resolve: jest.fn<
        Promise<string | null>,
        [McpOAuthSubject, AbortSignal | undefined]
      >(resolve),
      invalidate: jest.fn<Promise<void>, [McpOAuthSubject, string, string]>(
        () => Promise.resolve(),
      ),
    };
    return {
      broker: new McpCredentialBroker<McpOAuthSubject>({ owner }),
      resolve: owner.resolve,
      invalidate: owner.invalidate,
    };
  }

  function bindRequest(
    overrides: { serverName?: string; contentHash?: string } = {},
  ): WorkerPipelineHostRequest {
    return ownerRequest({
      action: 'owner.mcp.bind',
      marketplaceId: 'market',
      pluginName: 'notes',
      serverName: overrides.serverName ?? 'docs',
      contentHash: overrides.contentHash ?? pluginMcpServerContentHash(SERVER),
    });
  }

  beforeEach(() => {
    const market = join(worktree, 'market');
    mkdirSync(join(market, 'notes'), { recursive: true });
    writeFileSync(
      join(market, 'notes', '.mcp.json'),
      JSON.stringify({ mcpServers: { docs: SERVER } }),
    );
    mockMarketplaces.current = [
      {
        id: 'market',
        name: 'market',
        installLocation: market,
        plugins: [{ name: 'notes', sourcePath: 'notes' }],
      },
    ];
  });

  it("binds a plugin server from this app's own read and presents one header per authorization, host-locally", async () => {
    const {
      broker: credentials,
      resolve,
      invalidate,
    } = broker(() => Promise.resolve(TOKEN));
    const context = new PipelineOwnerRunContext(run(), {
      broker: (): McpCredentialBroker<McpOAuthSubject> => credentials,
      generation: (): number => 1,
      resolve: resolvePluginMcpOAuthRoute,
    });
    const bound = ownerValue(await context.apply(bindRequest(), signal));
    if (bound?.kind !== 'mcp.bind' || bound.routeRef === null)
      throw new Error('No route.');
    expect(bound.routeRef).toMatch(/^mcpr1_/);
    expect(resolve).not.toHaveBeenCalled();

    const request = ownerRequest({
      action: 'owner.mcp.authorize',
      routeRef: bound.routeRef,
    });
    const settlement = await context.apply(request, signal);
    const granted = ownerValue(settlement);
    if (granted?.kind !== 'mcp.authorize' || granted.grantId === null)
      throw new Error('No grant.');
    expect(granted.grantId).toMatch(/^mcpg1_/);
    // The header returns host-locally, never in the result.
    expect(settlement.values).toEqual({
      requestId: request.requestId,
      mcpAuthorization: { authorization: `Bearer ${TOKEN}` },
    });
    expect(JSON.stringify(settlement.result)).not.toContain(TOKEN);
    // The credential is the one this app read for the plugin's server.
    expect(resolve.mock.calls[0]?.[0]).toMatchObject({
      kind: 'declared',
      definition: { url: UPSTREAM },
    });

    const rejected = ownerRequest({
      action: 'owner.mcp.rejected',
      grantId: granted.grantId,
    });
    expect(ownerValue(await context.apply(rejected, signal))).toEqual({
      kind: 'mcp.rejected',
    });
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'declared' }),
      TOKEN,
      UPSTREAM,
    );
    // A grant invalidates its token once.
    await context.apply({ ...rejected, requestId: 'again' }, signal);
    expect(invalidate).toHaveBeenCalledTimes(1);

    await context.close(null);
    expect(credentials.size).toBe(0);
    expect(
      (await context.apply({ ...request, requestId: 'late' }, signal)).result,
    ).toMatchObject({ status: 'failure' });
  });

  it('refuses a bind whose declaration differs or that names an unknown server, and never reads OAuth fields from the request', async () => {
    const { broker: credentials } = broker(() => Promise.resolve(TOKEN));
    const context = new PipelineOwnerRunContext(run(), {
      broker: (): McpCredentialBroker<McpOAuthSubject> => credentials,
      generation: (): number => 1,
      resolve: resolvePluginMcpOAuthRoute,
    });
    const changed = pluginMcpServerContentHash({
      ...SERVER,
      url: 'https://elsewhere.example.test/',
    });
    for (const request of [
      bindRequest({ contentHash: changed }),
      bindRequest({ serverName: 'other' }),
    ])
      expect(ownerValue(await context.apply(request, signal))).toEqual({
        kind: 'mcp.bind',
        routeRef: null,
      });
    expect(credentials.size).toBe(0);
    // OAuth fields the worker adds are refused by the request schema itself.
    const smuggled: unknown = JSON.parse(
      JSON.stringify({
        ...bindRequest(),
        request: {
          ...bindRequest().request,
          url: 'https://evil.example.test/',
          oauth: { clientId: 'evil' },
        },
      }),
    );
    expect(WorkerPipelineHostRequestSchema.safeParse(smuggled).success).toBe(
      false,
    );
    // A route this run never bound presents nothing. It isn't one of the
    // run's live routes, so the daemon may bind its server once more, which
    // gives it at most a route it could bind anyway (CAN-6168 part 4).
    const foreign = await context.apply(
      ownerRequest({
        action: 'owner.mcp.authorize',
        routeRef: 'mcpr1_AAAAAAAAAAAAAAAAAAAAAA',
      }),
      signal,
    );
    expect(ownerValue(foreign)).toEqual({
      kind: 'mcp.authorize',
      grantId: null,
      refused: 'stale_route',
    });
    expect(foreign.values).toBeUndefined();
  });

  it('fails closed when the credential owner cannot decide', async () => {
    const { broker: credentials } = broker(() =>
      Promise.reject(new Error('refresh failed')),
    );
    const context = new PipelineOwnerRunContext(run(), {
      broker: (): McpCredentialBroker<McpOAuthSubject> => credentials,
      generation: (): number => 1,
      resolve: resolvePluginMcpOAuthRoute,
    });
    const bound = ownerValue(await context.apply(bindRequest(), signal));
    if (bound?.kind !== 'mcp.bind' || bound.routeRef === null)
      throw new Error('No route.');
    const settlement = await context.apply(
      ownerRequest({ action: 'owner.mcp.authorize', routeRef: bound.routeRef }),
      signal,
    );
    expect(settlement.result).toMatchObject({ status: 'failure' });
    expect(settlement.values).toBeUndefined();
  });

  it('a route ends with the owner subscription that bound it', async () => {
    const { broker: credentials, resolve } = broker(() =>
      Promise.resolve(TOKEN),
    );
    let generation = 1;
    const context = new PipelineOwnerRunContext(run(), {
      broker: (): McpCredentialBroker<McpOAuthSubject> => credentials,
      generation: (): number => generation,
      resolve: resolvePluginMcpOAuthRoute,
    });
    const bound = ownerValue(await context.apply(bindRequest(), signal));
    if (bound?.kind !== 'mcp.bind' || bound.routeRef === null)
      throw new Error('No route.');
    expect(credentials.size).toBe(1);
    // The owner session reconnected: a new subscription. The route is stale,
    // so the daemon may bind it again, once, under this subscription.
    generation = 2;
    const settlement = await context.apply(
      ownerRequest({ action: 'owner.mcp.authorize', routeRef: bound.routeRef }),
      signal,
    );
    expect(ownerValue(settlement)).toEqual({
      kind: 'mcp.authorize',
      grantId: null,
      refused: 'stale_route',
    });
    expect(settlement.values).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    expect(credentials.size).toBe(0);
    const rebound = ownerValue(await context.apply(bindRequest(), signal));
    if (rebound?.kind !== 'mcp.bind' || rebound.routeRef === null)
      throw new Error('No route.');
    const granted = await context.apply(
      ownerRequest({
        action: 'owner.mcp.authorize',
        routeRef: rebound.routeRef,
      }),
      signal,
    );
    expect(ownerValue(granted)).toMatchObject({ kind: 'mcp.authorize' });
    expect(granted.values?.mcpAuthorization?.authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it('says no_credential, never stale_route, when the broker holds no usable credential', async () => {
    const { broker: credentials } = broker(() => Promise.resolve(null));
    const context = new PipelineOwnerRunContext(run(), {
      broker: (): McpCredentialBroker<McpOAuthSubject> => credentials,
      generation: (): number => 1,
      resolve: resolvePluginMcpOAuthRoute,
    });
    const bound = ownerValue(await context.apply(bindRequest(), signal));
    if (bound?.kind !== 'mcp.bind' || bound.routeRef === null)
      throw new Error('No route.');
    const settlement = await context.apply(
      ownerRequest({ action: 'owner.mcp.authorize', routeRef: bound.routeRef }),
      signal,
    );
    expect(ownerValue(settlement)).toEqual({
      kind: 'mcp.authorize',
      grantId: null,
      refused: 'no_credential',
    });
    expect(settlement.values).toBeUndefined();
  });

  it('holds at most its route cap however many binds arrive at once', async () => {
    const { broker: credentials } = broker(() => Promise.resolve(TOKEN));
    const context = new PipelineOwnerRunContext(run(), {
      broker: (): McpCredentialBroker<McpOAuthSubject> => credentials,
      generation: (): number => 1,
      resolve: (): Promise<PluginMcpOAuthRoute | null> =>
        new Promise((resolve) =>
          setTimeout(() =>
            resolve({
              subject: { kind: 'device', serverId: 'server', configId: 'c' },
              upstreamUrl: UPSTREAM,
            }),
          ),
        ),
    });
    const answers = await Promise.all(
      Array.from({ length: 70 }, () => context.apply(bindRequest(), signal)),
    );
    const bound = answers.filter((answer) => {
      const value = ownerValue(answer);
      return value?.kind === 'mcp.bind' && value.routeRef !== null;
    });
    expect(bound).toHaveLength(64);
    expect(credentials.size).toBe(64);
  });

  it('presents nothing when the owner subscription ends while the broker resolves', async () => {
    let release: (token: string) => void = () => undefined;
    const { broker: credentials } = broker(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    let generation = 1;
    const context = new PipelineOwnerRunContext(run(), {
      broker: (): McpCredentialBroker<McpOAuthSubject> => credentials,
      generation: (): number => generation,
      resolve: resolvePluginMcpOAuthRoute,
    });
    const bound = ownerValue(await context.apply(bindRequest(), signal));
    if (bound?.kind !== 'mcp.bind' || bound.routeRef === null)
      throw new Error('No route.');
    const pending = context.apply(
      ownerRequest({ action: 'owner.mcp.authorize', routeRef: bound.routeRef }),
      signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    generation = 2;
    release(TOKEN);
    const settlement = await pending;
    expect(ownerValue(settlement)).toEqual({
      kind: 'mcp.authorize',
      grantId: null,
      refused: 'stale_route',
    });
    expect(settlement.values).toBeUndefined();
    expect(credentials.size).toBe(0);
  });
});
