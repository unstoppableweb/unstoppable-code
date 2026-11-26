import {
  WORKER_AGENT_HARNESSES,
  WORKER_AGENT_TURN_LAUNCH_FORMAT,
  WorkerAgentTurnLaunchSchema,
  type WorkerAgentHarness,
  type WorkerAgentTurnLaunch,
} from '@canopy/protocol/canopy-core';
import {
  canonicalizeAgentModelConfig,
  readCodexSpeedRecord,
} from '@canopy/execution-engine/lib/codex-speed';
import { normalizeCodexMaxConcurrentSubagents } from '@canopy/execution-engine/lib/codex-multi-agent';
import type {
  AgentModelConfig,
  AiCreditsRoutingState,
  ApprovalRule,
} from '@canopy/desktop-shared/types';
import type { AgentSessionOptions } from '../agents/types';

/**
 * How each session option reaches a worker that serves a portable launch
 * (CAN-6995 S1b):
 * - `launch`: carried in the launch, unset as null.
 * - `reference`: carried as an id the serving host resolves (root, admitted
 *   approval, billing route).
 * - `scope`, `params`: carried in the run params, not the launch.
 * - `host`: composed by the serving host for the surface, never carried.
 *
 * The table names every option, so a new one fails the typecheck until it is
 * classified, and the launch golden checks the classification holds.
 */
export type TurnLaunchMemberClass =
  | 'launch'
  | 'reference'
  | 'scope'
  | 'params'
  | 'host';

export const TURN_LAUNCH_MEMBERS = {
  cwd: 'reference',
  managedDelegationSurface: 'launch',
  managedDelegationMode: 'launch',
  managedDelegationMaxConcurrent: 'launch',
  managedDelegationMaxDepth: 'launch',
  managedDelegationLifetimeLimit: 'launch',
  selectedRepoId: 'launch',
  projectId: 'scope',
  worktreeId: 'scope',
  chatId: 'scope',
  executionContext: 'launch',
  planMode: 'launch',
  approvalMode: 'launch',
  sessionApprovalRules: 'reference',
  codexProposalMode: 'launch',
  thinkingLevel: 'launch',
  model: 'params',
  selectedModel: 'launch',
  sdkSessionId: 'launch',
  codexReconstructionSeedId: 'launch',
  claudeForkSession: 'launch',
  claudeForkResumeAt: 'launch',
  claudeForkStartsFresh: 'launch',
  claudeForkToolResults: 'launch',
  // Capability overlays cross as `materializationId` once CAN-4123 lands.
  pluginSelections: 'host',
  packageOverlay: 'host',
  inheritedCapabilityOverlay: 'host',
  // An automation's unattended account facts; a turn with either is not
  // launched yet (see toPortableTurnLaunch).
  accountResolution: 'host',
  sharedConnectionWrites: 'host',
  applyGlobalPluginDefaults: 'launch',
  deferredToolsAllowed: 'launch',
  systemPromptAppend: 'launch',
  globalInstructionsBlock: 'launch',
  globalInstructionsSnapshot: 'launch',
  providerType: 'params',
  executionHarness: 'launch',
  codexAppServerIdleTimeoutMinutes: 'launch',
  codexMultiAgentEnabled: 'launch',
  codexMaxConcurrentSubagents: 'launch',
  modelConfig: 'launch',
  // Read only when modelConfig has no speed; carried as the launch's speed.
  codexFastModeEnabled: 'launch',
  rtkEnabled: 'launch',
  assistantMode: 'host',
  toolProfileHash: 'host',
  codeGraphToolsAdvertised: 'launch',
  interfaceTools: 'host',
  appAdvisorRuntime: 'host',
  pipelineEditorRuntime: 'host',
  aiCreditsRouting: 'reference',
  subscriptionBillingOverride: 'launch',
  accountProxyRouting: 'launch',
  requiredAccountProxyConnectionId: 'launch',
} as const satisfies Record<keyof AgentSessionOptions, TurnLaunchMemberClass>;

export type TurnLaunchHostMember = {
  [K in keyof typeof TURN_LAUNCH_MEMBERS]: (typeof TURN_LAUNCH_MEMBERS)[K] extends 'host'
    ? K
    : never;
}[keyof typeof TURN_LAUNCH_MEMBERS];

/** What the session options alone do not say, supplied by the caller. */
export interface TurnLaunchContext {
  /** The worker root the serving host resolves to `cwd`. */
  cwdRootId: string;
  surface: WorkerAgentTurnLaunch['surface'];
  /** The core's admitted approval decision for this send (ADR 22a rule 1). */
  approval: { admissionId: string; policyRevision: number };
  /** The route id for `aiCreditsRouting`; required when that is set. */
  aiCreditsRouteId?: string;
  prompt: WorkerAgentTurnLaunch['prompt'];
}

export type TurnLaunchBuild =
  | { ok: true; launch: WorkerAgentTurnLaunch }
  | { ok: false; reason: string };

const nullable = <T>(value: T | undefined): T | null => value ?? null;

function isHarness(value: unknown): value is WorkerAgentHarness {
  return WORKER_AGENT_HARNESSES.some((harness): boolean => harness === value);
}

type TurnLaunchProvider = NonNullable<AgentSessionOptions['providerType']>;

/** Every session provider, so a new one fails the typecheck until listed. */
const TURN_LAUNCH_PROVIDERS: Readonly<Record<TurnLaunchProvider, true>> = {
  claude: true,
  codex: true,
  ollama: true,
  cursor: true,
  opencode: true,
  copilot: true,
  antigravity: true,
};

function isProvider(value: string): value is TurnLaunchProvider {
  return Object.keys(TURN_LAUNCH_PROVIDERS).includes(value);
}

function refuse(reason: string): TurnLaunchBuild {
  return { ok: false, reason };
}

/**
 * The portable launch for one turn's session options, or why the options
 * cannot cross exactly; the caller then omits the launch and the in-process
 * worker serves the staged run as before. Host members are not carried.
 */
export function toPortableTurnLaunch(
  options: AgentSessionOptions,
  context: TurnLaunchContext,
): TurnLaunchBuild {
  if (options.approvalMode === undefined)
    return refuse('the send has no admitted approval mode');
  if (
    options.accountResolution !== undefined ||
    options.sharedConnectionWrites !== undefined
  )
    return refuse("an automation turn's account resolution does not cross yet");
  const harness = options.executionHarness;
  if (harness !== undefined && !isHarness(harness))
    return refuse('the execution harness is not a worker harness');
  const modelConfig = options.modelConfig;
  if (
    modelConfig?.thinkingLevel !== undefined &&
    modelConfig.thinkingLevel !== options.thinkingLevel
  )
    return refuse('the model config and session disagree on thinking level');
  const configuredSpeed = readCodexSpeedRecord(modelConfig);
  if (
    typeof options.codexFastModeEnabled === 'boolean' &&
    configuredSpeed === undefined
  )
    return refuse('the speed is set only by the legacy fast-mode alias');
  if (
    options.aiCreditsRouting !== undefined &&
    context.aiCreditsRouteId === undefined
  )
    return refuse('AI Credits routing has no route id');
  const delegationSet =
    options.managedDelegationMode !== undefined ||
    options.managedDelegationMaxConcurrent !== undefined ||
    options.managedDelegationMaxDepth !== undefined ||
    options.managedDelegationLifetimeLimit !== undefined;
  if (delegationSet && options.managedDelegationSurface === undefined)
    return refuse('delegation limits are set without a delegation surface');
  const fork = [
    options.claudeForkSession,
    options.claudeForkResumeAt,
    options.claudeForkStartsFresh,
    options.claudeForkToolResults,
  ].some((value) => value !== undefined);
  const codex = [
    options.codexAppServerIdleTimeoutMinutes,
    options.codexMultiAgentEnabled,
    options.codexMaxConcurrentSubagents,
  ].some((value) => value !== undefined);
  const subagentLimit = options.codexMaxConcurrentSubagents;

  const candidate: WorkerAgentTurnLaunch = {
    format: WORKER_AGENT_TURN_LAUNCH_FORMAT,
    cwdRootId: context.cwdRootId,
    repoId: nullable(options.selectedRepoId),
    surface: context.surface,
    executionHarness: nullable(harness),
    model: {
      selectedModelId: nullable(options.selectedModel),
      thinkingLevel: nullable(options.thinkingLevel),
      speed: nullable(configuredSpeed),
      contextWindow: nullable(modelConfig?.contextWindow),
    },
    mode: {
      planMode: nullable(options.planMode),
      codexProposalMode: nullable(options.codexProposalMode),
    },
    approval: {
      mode: options.approvalMode,
      policyRevision: context.approval.policyRevision,
      admissionId: context.approval.admissionId,
    },
    session: {
      providerSessionId: nullable(options.sdkSessionId),
      reconstructionSeedId: nullable(options.codexReconstructionSeedId),
      fork: fork
        ? {
            forkSession: nullable(options.claudeForkSession),
            resumeAt: nullable(options.claudeForkResumeAt),
            startsFresh: nullable(options.claudeForkStartsFresh),
            toolResults: options.claudeForkToolResults
              ? options.claudeForkToolResults.map((result) => ({
                  toolUseId: result.toolUseId,
                  content: result.content,
                }))
              : null,
          }
        : null,
    },
    instructions: {
      systemPromptAppend: nullable(options.systemPromptAppend),
      globalInstructionsBlock: nullable(options.globalInstructionsBlock),
      globalInstructionsSnapshot: nullable(options.globalInstructionsSnapshot),
    },
    capabilities: {
      applyGlobalPluginDefaults: nullable(options.applyGlobalPluginDefaults),
      deferredToolsAllowed: nullable(options.deferredToolsAllowed),
      codeGraphToolsAdvertised: nullable(options.codeGraphToolsAdvertised),
      rtkEnabled: nullable(options.rtkEnabled),
    },
    delegation:
      options.managedDelegationSurface === undefined
        ? null
        : {
            surface: options.managedDelegationSurface,
            mode: nullable(options.managedDelegationMode),
            maxConcurrent: nullable(options.managedDelegationMaxConcurrent),
            maxDepth: nullable(options.managedDelegationMaxDepth),
            lifetimeLimit: nullable(options.managedDelegationLifetimeLimit),
          },
    codex: codex
      ? {
          appServerIdleTimeoutMinutes: nullable(
            options.codexAppServerIdleTimeoutMinutes,
          ),
          multiAgentEnabled: nullable(options.codexMultiAgentEnabled),
          maxConcurrentSubagents:
            subagentLimit === undefined
              ? null
              : (normalizeCodexMaxConcurrentSubagents(subagentLimit) ?? 'none'),
        }
      : null,
    executionContext: nullable(options.executionContext),
    billing: {
      routes:
        context.aiCreditsRouteId === undefined
          ? []
          : [{ kind: 'ai_credits', routeId: context.aiCreditsRouteId }],
      subscriptionOverride: nullable(options.subscriptionBillingOverride),
      accountProxy: nullable(options.accountProxyRouting),
      requiredAccountProxyConnectionId: nullable(
        options.requiredAccountProxyConnectionId,
      ),
    },
    prompt: context.prompt,
  };
  const parsed = WorkerAgentTurnLaunchSchema.safeParse(candidate);
  return parsed.success
    ? { ok: true, launch: parsed.data }
    : refuse(
        `the launch is outside its schema at ${parsed.error.issues[0]?.path.join('.') ?? 'its root'}`,
      );
}

/** How the serving host resolves a launch's references. */
export interface TurnLaunchHostPort {
  /** The directory of a worker root; null when the root is unknown. */
  rootPath(cwdRootId: string): string | null;
  /** The session rules the core admitted under this id; null when unknown. */
  admittedApprovalRules(admissionId: string): ApprovalRule[] | null;
  /** The AI Credits routing state of a route; null when unknown. */
  aiCreditsRouting(routeId: string): AiCreditsRoutingState | null;
}

export interface TurnLaunchRunParams {
  scope: { workspaceId: string; worktreeId: string; chatId: string };
  providerId: string;
  model: string | null;
}

export type PortableTurnSessionOptions = Omit<
  AgentSessionOptions,
  TurnLaunchHostMember
>;

export type TurnLaunchResolution =
  | { ok: true; options: PortableTurnSessionOptions }
  | { ok: false; reason: string };

function set<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | null,
): void {
  if (value !== null) target[key] = value;
}

/**
 * The session options a launch carries, through the serving host's port.
 * Host members are left to the serving host.
 */
export function resolveTurnLaunch(
  launch: WorkerAgentTurnLaunch,
  params: TurnLaunchRunParams,
  port: TurnLaunchHostPort,
): TurnLaunchResolution {
  const cwd = port.rootPath(launch.cwdRootId);
  if (cwd === null) return { ok: false, reason: 'the worker root is unknown' };
  const rules = port.admittedApprovalRules(launch.approval.admissionId);
  if (rules === null)
    return { ok: false, reason: 'the approval admission is unknown' };
  const providerType = params.providerId;
  if (!isProvider(providerType))
    return { ok: false, reason: 'the provider is not a known provider' };
  const options: PortableTurnSessionOptions = {
    cwd,
    projectId: params.scope.workspaceId,
    worktreeId: params.scope.worktreeId,
    chatId: params.scope.chatId,
    providerType,
    approvalMode: launch.approval.mode,
    sessionApprovalRules: rules,
  };
  set(options, 'model', params.model);
  for (const route of launch.billing.routes) {
    if (route.kind !== 'ai_credits')
      return { ok: false, reason: `the ${route.kind} route is not served yet` };
    const routing = port.aiCreditsRouting(route.routeId);
    if (routing === null)
      return { ok: false, reason: 'the AI Credits route is unknown' };
    options.aiCreditsRouting = routing;
  }
  set(options, 'selectedRepoId', launch.repoId);
  set(options, 'executionHarness', launch.executionHarness);
  set(options, 'selectedModel', launch.model.selectedModelId);
  set(options, 'thinkingLevel', launch.model.thinkingLevel);
  const modelConfig: AgentModelConfig = {};
  set(modelConfig, 'thinkingLevel', launch.model.thinkingLevel);
  set(modelConfig, 'speed', launch.model.speed);
  set(modelConfig, 'contextWindow', launch.model.contextWindow);
  if (Object.keys(modelConfig).length > 0)
    options.modelConfig = canonicalizeAgentModelConfig(modelConfig);
  set(options, 'planMode', launch.mode.planMode);
  set(options, 'codexProposalMode', launch.mode.codexProposalMode);
  set(options, 'sdkSessionId', launch.session.providerSessionId);
  set(
    options,
    'codexReconstructionSeedId',
    launch.session.reconstructionSeedId,
  );
  const fork = launch.session.fork;
  if (fork) {
    set(options, 'claudeForkSession', fork.forkSession);
    set(options, 'claudeForkResumeAt', fork.resumeAt);
    set(options, 'claudeForkStartsFresh', fork.startsFresh);
    set(options, 'claudeForkToolResults', fork.toolResults);
  }
  set(options, 'systemPromptAppend', launch.instructions.systemPromptAppend);
  set(
    options,
    'globalInstructionsBlock',
    launch.instructions.globalInstructionsBlock,
  );
  set(
    options,
    'globalInstructionsSnapshot',
    launch.instructions.globalInstructionsSnapshot,
  );
  const capabilities = launch.capabilities;
  set(
    options,
    'applyGlobalPluginDefaults',
    capabilities.applyGlobalPluginDefaults,
  );
  set(options, 'deferredToolsAllowed', capabilities.deferredToolsAllowed);
  set(
    options,
    'codeGraphToolsAdvertised',
    capabilities.codeGraphToolsAdvertised,
  );
  set(options, 'rtkEnabled', capabilities.rtkEnabled);
  const delegation = launch.delegation;
  if (delegation) {
    options.managedDelegationSurface = delegation.surface;
    set(options, 'managedDelegationMode', delegation.mode);
    set(options, 'managedDelegationMaxConcurrent', delegation.maxConcurrent);
    set(options, 'managedDelegationMaxDepth', delegation.maxDepth);
    set(options, 'managedDelegationLifetimeLimit', delegation.lifetimeLimit);
  }
  const codex = launch.codex;
  if (codex) {
    set(
      options,
      'codexAppServerIdleTimeoutMinutes',
      codex.appServerIdleTimeoutMinutes,
    );
    set(options, 'codexMultiAgentEnabled', codex.multiAgentEnabled);
    if (codex.maxConcurrentSubagents !== null)
      options.codexMaxConcurrentSubagents =
        codex.maxConcurrentSubagents === 'none'
          ? null
          : codex.maxConcurrentSubagents;
  }
  set(options, 'executionContext', launch.executionContext);
  set(
    options,
    'subscriptionBillingOverride',
    launch.billing.subscriptionOverride,
  );
  set(options, 'accountProxyRouting', launch.billing.accountProxy);
  set(
    options,
    'requiredAccountProxyConnectionId',
    launch.billing.requiredAccountProxyConnectionId,
  );
  return { ok: true, options };
}
