import type { AccountProxyQuotaWait } from '../../account-proxy/quota-wait';
import { classifyAgentFailure } from '@canopy/execution-engine/agent-failures';
import { BRAND } from '@canopy/brand/current';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DelegationParent } from '@canopy/desktop-shared/node/delegation/parent';
import {
  createCodexDelegateTools,
  childDelegationGuidance,
} from './child-tools';
import {
  childLedgerGuidance,
  retainChildLedgerTools,
  type ChildLedgerTools,
} from './ledger-tools';
import {
  delegateAppToolGuidance,
  type DelegateCanopyTools,
} from './canopy-tools';
import {
  codexServiceTierForModelConfig,
  type CodexConfig,
} from '@canopy/execution-engine/lib/codex-model-config';
import { applyCodexMultiAgentConfig } from '@canopy/execution-engine/lib/codex-multi-agent';
import type { CodexSelectedCapabilityRoot } from '@canopy/desktop-shared/types';
import {
  DELEGATION_STREAM_PREVIEW_LIMITS,
  DelegationTranscriptRecorder,
} from './transcript-recorder';
import { delegationCommandEnvironment } from '@canopy/desktop-shared/node/delegation/command-environment';
import {
  LocalDelegationRunner,
  DelegationRunnerError,
  type LocalDelegationContext,
  type LocalDelegationOutcome,
} from '@canopy/desktop-shared/node/delegation/local-runner';
import type {
  ResolvedAgentRouteSnapshot,
  RunnerAvailability,
} from '@canopy/desktop-shared/node/delegation';
import type {
  DelegationTranscriptChange,
  DelegationTranscriptPort,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import {
  CODEX_PROJECT_DOC_THREAD_CONFIG,
  loadCodexThreadSeedItemsWithLoadCount,
  type CodexRuntimeService,
  type CodexSpawnProfileRequest,
  type CodexThreadHandle,
} from '@canopy/execution-engine/node/codex-runtime';
import type {
  AgentDelegationError,
  AgentDelegationUsage,
} from '@canopy/protocol/delegation';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/execution-engine/lib/canopy-injected-tools';
import type { ThreadStartParams } from '@canopy/execution-engine/node/codex-runtime/generated/v2/ThreadStartParams';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import type { UserInput } from '@canopy/execution-engine/node/codex-runtime/generated/v2/UserInput';
import { codexRuntimeForWorkerRun } from '../../codex/runtime-service';
import { CodexDelegationProgress } from './codex-progress';
import { ChildAppendQueue } from './child-append-queue';
import { DelegationChildNormalizer } from './child-row-normalizers';
import {
  createDefaultCommandOutputSpools,
  type DelegationCommandSpools,
} from './command-output-spools';
import { delegationBlockId } from '@canopy/agent-transcript';
import type { DelegationNativePolicy } from './native-policy';
import {
  buildCodexDelegationPermissionProfiles,
  CODEX_DELEGATION_READ_ONLY_PROFILE,
  CODEX_DELEGATION_WRITE_PROFILE,
  type CodexDelegationSandboxProfileName,
} from './codex-sandbox-profile';
import { recordDelegationModelRejection } from './model-rejections';
import type { CodexErrorInfo } from '@canopy/execution-engine/node/codex-runtime/generated/v2/CodexErrorInfo';
import { redactSecrets } from '@canopy/execution-engine/lib/redaction';
import type {
  DelegationCapabilityReloadController,
  DelegationCapabilityReloadHost,
} from './capability-reload';

// Settings-configured hooks stay as the user's Codex config defines them, as
// in a parent chat; these are tool and runtime features a child must not use.
const DISABLED_FEATURES = [
  'shell_snapshot',
  'multi_agent',
  'multi_agent_v2',
  'apps',
  'code_mode',
  'code_mode_host',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'image_generation',
  'view_image',
  'skill_search',
  'sleep_tool',
  'goals',
  'in_app_browser',
  'in_app_local_automation',
  'remote_plugin',
  'tool_suggest',
  'plugins',
  'workspace_dependencies',
];

/**
 * Hidden continuation after the root chat started planning during a turn
 * under the write profile. The run goes on under the read-only profile.
 */
export const CODEX_DELEGATION_PLANNING_CONTINUATION =
  '<system_instruction>The parent chat started planning, so the rest of this task is read-only: shell commands and file edits can no longer write. Continue the interrupted request without writing, and report any changes that are still needed.</system_instruction>';

/**
 * Hidden continuation after the parent's rules stopped allowing writes
 * within a grant (a deny rule or protected path inside it, or a grant that
 * now fails the path checks) during a turn under the write profile. The run
 * goes on under the read-only profile; native file edits still ask the
 * parent, whose rules refuse the denied paths.
 */
export const CODEX_DELEGATION_GRANTS_REVOKED_CONTINUATION =
  "<system_instruction>The parent chat's rules no longer allow writes within your granted paths, so the rest of this task is read-only: shell commands can no longer write, and each file edit needs the parent's approval. Continue the interrupted request, and report any changes that are still needed.</system_instruction>";

/** Hidden continuation when planning ended before the new thread opened. */
const CODEX_DELEGATION_RESUME_CONTINUATION =
  '<system_instruction>Continue the interrupted request.</system_instruction>';

/**
 * How often a write-profile turn rechecks the root's plan state between
 * provider events. Events and approval requests also recheck it.
 */
const CODEX_DELEGATION_PLAN_CHECK_MS = 250;

/**
 * The least time between two evaluations of a write-profile turn's grants
 * against the parent's policy, which read the filesystem. A changed policy
 * context key (the mode, or project or global rules) or a native approval
 * request rechecks at once; this spacing bounds how late a change the key
 * does not reflect (a session rule, a repository manifest rule, a replaced
 * grant path) is found.
 */
const CODEX_DELEGATION_GRANT_CHECK_MS = 1_000;

export interface CodexDelegationPreparation {
  readonly waitForQuotaRecovery?: AccountProxyQuotaWait;
  readonly model: string;
  readonly config?: NonNullable<ThreadStartParams['config']>;
  readonly profile: CodexSpawnProfileRequest;
  readonly tools: DelegationNativePolicy;
  readonly selectedCapabilityRoots?: readonly CodexSelectedCapabilityRoot[];
  readonly selectedMcpServers?: CodexConfig;
  /** App-owned tools for this run, exposed as dynamic tools. */
  readonly appTools?: DelegateCanopyTools;
  /**
   * Selected servers the provider reaches directly (no host proxy or
   * broker gate). Their tool calls are approved by the runner instead.
   */
  readonly providerGatedMcpServers?: readonly string[];
  /** Enables Load Deferred Tools to change capabilities inside this run. */
  readonly capabilityReload?: {
    readonly controller: DelegationCapabilityReloadController;
    readonly host: DelegationCapabilityReloadHost<CodexDelegationPreparation>;
  };
  /**
   * The native shell's environment beyond the validated Git executable: the
   * host's captured login-shell PATH (the same PATH a Claude child's Bash
   * receives), read access to the toolchains on it (inside the home
   * directory, only PATH directories and their runtime directories), and a
   * private writable directory for TMPDIR.
   */
  readonly commandEnvironment?: {
    readonly commandPath: string;
    readonly toolchainReadRoots: readonly string[];
    readonly temporaryDirectory: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function retryingCodexError(error: unknown): boolean {
  const details = record(error);
  return (
    details?.willRetry === true || record(details?.params)?.willRetry === true
  );
}

export function buildCodexDelegationThreadParams(options: {
  readonly cwd: string;
  readonly model: string;
  readonly config: NonNullable<ThreadStartParams['config']>;
  readonly instructions: string;
  readonly ambientMcp: Record<string, unknown>;
  readonly selectedCapabilityRoots?: readonly CodexSelectedCapabilityRoot[];
  readonly selectedMcpServers?: CodexConfig;
  readonly fastMode?: boolean;
  /**
   * Validated write grants. They define the `delegated_write` profile and
   * never appear in `delegated_read_only`.
   */
  readonly writePaths?: readonly string[];
  /**
   * The profile the thread runs under. The bundled runtime selects a profile
   * per thread only, so the runner opens a thread for each turn.
   */
  readonly permissionProfile?: CodexDelegationSandboxProfileName;
  readonly readRoots?: readonly string[];
  readonly gitRoots?: readonly string[];
  readonly gitPrivateRoots?: readonly string[];
  readonly runtimeRoots?: readonly string[];
  readonly commandDirectories?: readonly string[];
  readonly commandPath?: string;
  readonly toolchainReadRoots?: readonly string[];
  readonly temporaryDirectory?: string;
}): ThreadStartParams {
  const config = applyCodexMultiAgentConfig(options.config, { enabled: false });
  // Dotted overrides otherwise retain their insertion order and can outrank
  // the nested locked feature table when the runtime flattens this config.
  for (const name of [
    ...DISABLED_FEATURES,
    'request_permissions_tool',
    'shell_tool',
    'unified_exec',
    'skip_host_skill_discovery',
  ])
    delete config[`features.${name}`];
  const configuredProvider = config.model_provider;
  const profiles = buildCodexDelegationPermissionProfiles(options);
  const permissionProfile =
    options.permissionProfile === CODEX_DELEGATION_WRITE_PROFILE &&
    profiles[CODEX_DELEGATION_WRITE_PROFILE]
      ? CODEX_DELEGATION_WRITE_PROFILE
      : CODEX_DELEGATION_READ_ONLY_PROFILE;
  return {
    cwd: options.cwd,
    model: options.model,
    serviceTier: codexServiceTierForModelConfig(options),
    // Thread params outrank repository config, so delegated tool results stay
    // on the host-captured native or routed provider.
    modelProvider:
      typeof configuredProvider === 'string' && configuredProvider.length > 0
        ? configuredProvider
        : 'openai',
    allowProviderModelFallback: false,
    // Granular/on-request skips the host for commands inside the sandbox.
    // Keep this gate enabled even in Full so mode changes take effect live.
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    permissions: permissionProfile,
    ephemeral: false,
    selectedCapabilityRoots: [...(options.selectedCapabilityRoots ?? [])],
    experimentalRawEvents: false,
    baseInstructions: options.instructions,
    developerInstructions: '',
    dynamicTools: [],
    config: {
      ...config,
      ...CODEX_PROJECT_DOC_THREAD_CONFIG,
      // The bundled prompt builder still preloads host skills when discovery is
      // skipped. Its minimum valid budget omits that ambient catalog while
      // selectedCapabilityRoots remain available to native skills.list/read.
      skills: { max_context_tokens: 1 },
      shell_environment_policy: {
        inherit: 'core',
        experimental_use_profile: false,
        set: delegationCommandEnvironment(options.commandDirectories ?? [], {
          systemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
          ...(options.commandPath ? { commandPath: options.commandPath } : {}),
          ...(options.temporaryDirectory
            ? { temporaryDirectory: options.temporaryDirectory }
            : {}),
        }),
      },
      permissions: profiles,
      // Native ChatGPT routing rebuilds config from retained session layers,
      // without the typed thread/start `permissions` override. Keep that
      // rebuild on the same confined profile rather than an ambient default.
      default_permissions: permissionProfile,
      mcp_servers: Object.fromEntries([
        ...Object.keys(options.ambientMcp).map(
          (name) => [name, { enabled: false }] as const,
        ),
        ...Object.entries(options.selectedMcpServers ?? {}),
      ]),
      features: {
        ...Object.fromEntries(DISABLED_FEATURES.map((name) => [name, false])),
        plugins: Boolean(options.selectedCapabilityRoots?.length),
        skill_search: Boolean(options.selectedCapabilityRoots?.length),
        request_permissions_tool: true,
        shell_tool: true,
        unified_exec: true,
        skip_host_skill_discovery: true,
      },
      web_search: 'disabled',
      'features.memories': false,
    },
  };
}

/** Adds one turn's usage to the run's running total. */
function addUsage(
  total: AgentDelegationUsage,
  usage: AgentDelegationUsage | undefined,
): AgentDelegationUsage {
  if (!usage) return total;
  const sum = (
    left: number | undefined,
    right: number | undefined,
  ): number | undefined =>
    left === undefined && right === undefined
      ? undefined
      : (left ?? 0) + (right ?? 0);
  const next: Record<string, number> = {};
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'cacheCreationInputTokens',
    'costUsd',
  ] as const) {
    const value = sum(total[key], usage[key]);
    if (value !== undefined) next[key] = value;
  }
  return next;
}

/** The call's server when the runner, not a host transport, gates it. */
function providerGatedServer(
  serverName: string,
  gated: ReadonlySet<string>,
): string | undefined {
  return gated.has(serverName) ? serverName : undefined;
}

/** Bounds the provider's own words in a delegated turn failure. */
const PROVIDER_ERROR_MAX_CHARACTERS = 500;

/** A provider refusing the model for this account or plan. */
const MODEL_REJECTION_PATTERNS = [
  /\bmodel\b.*\bnot supported\b/i,
  /\bunsupported model\b/i,
  /\bmodel_not_found\b/i,
  /\bmodel\b.*\bdoes not exist\b/i,
];

const AUTH_FAILURE_PATTERN =
  /\b(?:unauthori[sz]ed|not (?:logged|signed) in|authentication (?:failed|required)|invalid (?:api key|token|credentials?)|(?:access token|token|session) (?:has )?expired|(?:log|sign) ?in required|please (?:log|sign) in)\b/i;

/**
 * The provider's own message from a Codex turn error. The runtime reports
 * an HTTP error body as JSON text, sometimes after a status prefix.
 */
function providerErrorText(raw: string): { text: string; status?: number } {
  const trimmed = raw.trim();
  const prefixStatus = /\bstatus:?\s*(\d{3})\b/i.exec(trimmed)?.[1];
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(start));
      const body = record(parsed);
      const message = [
        record(body?.error)?.message,
        body?.error,
        body?.detail,
        body?.message,
      ].find(
        (value): value is string =>
          typeof value === 'string' && value.trim().length > 0,
      );
      const status =
        typeof body?.status === 'number'
          ? body.status
          : prefixStatus
            ? Number(prefixStatus)
            : undefined;
      if (message)
        return {
          text: message.trim(),
          ...(status !== undefined ? { status } : {}),
        };
    } catch {
      // Not a JSON body: report the text as written.
    }
  }
  return {
    text: trimmed,
    ...(prefixStatus ? { status: Number(prefixStatus) } : {}),
  };
}

/** Redacted, single-line and bounded, for the result and Inspect. */
function safeProviderMessage(text: string): string {
  const safe = redactSecrets(text)
    // Opaque credentials the named patterns do not recognize.
    .replace(/[A-Za-z0-9_\-+/=]{40,}/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  return safe.length > PROVIDER_ERROR_MAX_CHARACTERS
    ? `${safe.slice(0, PROVIDER_ERROR_MAX_CHARACTERS - 1)}…`
    : safe;
}

/** Maps a failed native turn to the delegation error the parent sees. */
function codexTurnFailure(options: {
  readonly error?: string;
  readonly errorInfo?: CodexErrorInfo;
  readonly partialOutput: boolean;
}): { readonly error: AgentDelegationError; readonly modelRejected: boolean } {
  const provider = options.error ? providerErrorText(options.error) : undefined;
  const message = provider ? safeProviderMessage(provider.text) : '';
  const partial = options.partialOutput
    ? ' Retained partial output is available.'
    : '';
  const modelRejected =
    options.errorInfo === 'modelNotFound' ||
    (Boolean(provider) &&
      MODEL_REJECTION_PATTERNS.some((pattern) =>
        pattern.test(provider?.text ?? ''),
      ));
  if (modelRejected)
    return {
      modelRejected,
      error: {
        code: 'route_unavailable',
        message: `The provider does not offer this model to the signed-in account: ${message}${partial}`,
        retryable: false,
      },
    };
  if (
    options.errorInfo === 'unauthorized' ||
    provider?.status === 401 ||
    AUTH_FAILURE_PATTERN.test(provider?.text ?? '')
  )
    return {
      modelRejected,
      error: {
        code: 'auth_required',
        message: `Sign in to the provider again${message ? `: ${message}` : '.'}${partial}`,
        retryable: false,
      },
    };
  return {
    modelRejected,
    error: {
      code: 'runtime_error',
      message: `The delegated native turn failed${message ? `: ${message}` : '.'}${partial}`,
      retryable: false,
    },
  };
}

/** Uses the application's shared service and canonical native HOME exclusively. */
export function createCodexDelegationRunner(options: {
  available: (route: ResolvedAgentRouteSnapshot) => Promise<RunnerAvailability>;
  prepare: (
    context: LocalDelegationContext,
  ) => Promise<CodexDelegationPreparation>;
  reportError: (error: unknown) => void;
  delegation?: (
    context: LocalDelegationContext,
  ) => DelegationParent | undefined;
  /**
   * The Agent Ledger tools for this run, when the Ledger is exposed to it.
   * They join the child's host-owned dynamic tools.
   */
  ledger?: (
    context: LocalDelegationContext,
  ) => Promise<ChildLedgerTools | undefined>;
  runtime?: () => CodexRuntimeService;
  loadResumeItems?: (
    runtime: CodexRuntimeService,
    threadId: string,
  ) => Promise<JsonValue[]>;
  transcriptPort?: DelegationTranscriptPort;
  /** Command-output spools for a stream-backed run; one owner per run. */
  spools?: () => DelegationCommandSpools;
}): LocalDelegationRunner {
  return new LocalDelegationRunner(
    'codex',
    'codex-app-server',
    options.available,
    async (context): Promise<LocalDelegationOutcome> => {
      let prepared = await options.prepare(context);
      const delegation = options.delegation?.(context);
      if (delegation)
        context.retain(() => {
          delegation.detach();
          return Promise.resolve();
        });
      const ledger = await retainChildLedgerTools(
        context,
        delegation,
        options.ledger,
      );
      const assertRestricted = (
        candidate: CodexDelegationPreparation,
      ): void => {
        if (
          candidate.profile.environmentPolicy !== 'restricted' ||
          candidate.profile.includeCanopySecrets
        )
          throw new Error(
            'Delegated Codex requires its restricted spawn profile',
          );
      };
      assertRestricted(prepared);
      const effort = context.request.route.effectiveThinkingLevel;
      if (effort === 'ultra')
        throw new DelegationRunnerError({
          code: 'capability_unavailable',
          message:
            'Ultra orchestration is unavailable in a managed delegated runner.',
          retryable: false,
        });
      const runtime = (
        options.runtime ??
        ((): CodexRuntimeService =>
          codexRuntimeForWorkerRun('codexDelegationRunner'))
      )();
      const currentConfig = await runtime
        .admin()
        .request('config/read', { cwd: context.request.cwd }, prepared.profile);
      const ambient = record(record(currentConfig)?.config);
      const ambientMcp = record(ambient?.mcp_servers);
      if (context.signal.aborted)
        throw new Error('Delegation cancelled before native launch');
      // The literal write grants each native policy admits to the sandbox. A
      // capability reload can bring a new policy; each is prepared once it
      // admits its grants.
      const sandboxWrites = new Map<
        DelegationNativePolicy,
        readonly string[]
      >();
      const sandboxWriteRoots = async (
        candidate: CodexDelegationPreparation,
      ): Promise<readonly string[]> => {
        const known = sandboxWrites.get(candidate.tools);
        if (known) return known;
        const roots = await candidate.tools.prepareCodexSandboxWrites();
        // Empty when a grant was denied: prepare again for a later thread.
        if (roots.length) sandboxWrites.set(candidate.tools, roots);
        return roots;
      };
      // The write profile only while the root chat is not planning and the
      // parent's rules still allow every grant. The bundled runtime selects
      // a profile per thread: `turn/start` `permissions` reloads the
      // configuration stack without the thread's profiles and fails, and
      // `thread/resume` keeps a loaded thread's profile. Each turn therefore
      // follows a thread opened for it (at launch, after a capability reload,
      // and when the root starts planning or the parent's rules deny a grant
      // during a write-profile turn, which the runner then stops).
      const sandboxProfile = (
        candidate: CodexDelegationPreparation,
        writePaths: readonly string[],
      ): CodexDelegationSandboxProfileName =>
        writePaths.length && candidate.tools.writable()
          ? CODEX_DELEGATION_WRITE_PROFILE
          : CODEX_DELEGATION_READ_ONLY_PROFILE;
      const threadParams = (
        candidate: CodexDelegationPreparation,
        writePaths: readonly string[] = [],
        permissionProfile: CodexDelegationSandboxProfileName = CODEX_DELEGATION_READ_ONLY_PROFILE,
      ): ThreadStartParams =>
        buildCodexDelegationThreadParams({
          cwd: candidate.tools.cwd,
          model: candidate.model,
          fastMode: context.request.task.fastMode,
          config: candidate.config ?? {},
          writePaths,
          permissionProfile,
          instructions: `${candidate.tools.instructions('codex')}${childDelegationGuidance(delegation)}${delegateAppToolGuidance(candidate.appTools, 'codex')}\nNative shell commands run with your login-shell PATH, a private writable TMPDIR and no network. Use exec_command with login:false to preserve the delegated command environment. Global/system Git configuration is disabled. Git metadata remains read-only even when source edits have explicit grants.${candidate.tools.gitAccess.commandDirectories[0] ? ` The native Git executable is ${path.join(candidate.tools.gitAccess.commandDirectories[0], process.platform === 'win32' ? 'git.exe' : 'git')}; use that absolute path if a login shell overrides PATH.` : ''}${childLedgerGuidance(ledger)}`,
          ambientMcp: ambientMcp ?? {},
          selectedCapabilityRoots: candidate.selectedCapabilityRoots,
          selectedMcpServers: candidate.selectedMcpServers,
          readRoots: candidate.tools.readRoots,
          gitRoots: candidate.tools.gitAccess.metadataRoots,
          gitPrivateRoots: candidate.tools.gitAccess.privateMetadataRoots,
          runtimeRoots: candidate.tools.gitAccess.runtimeRoots,
          commandDirectories: candidate.tools.gitAccess.commandDirectories,
          ...(candidate.commandEnvironment
            ? {
                commandPath: candidate.commandEnvironment.commandPath,
                toolchainReadRoots:
                  candidate.commandEnvironment.toolchainReadRoots,
                temporaryDirectory:
                  candidate.commandEnvironment.temporaryDirectory,
              }
            : {}),
        });
      const delegateTools = (
        candidate: CodexDelegationPreparation,
        threadId: string,
      ): ReturnType<typeof createCodexDelegateTools> =>
        createCodexDelegateTools({
          ...(delegation ? { delegation } : {}),
          ...(candidate.appTools ? { appTools: candidate.appTools } : {}),
          ...(ledger
            ? {
                ledger,
                // Ledger calls pass the parent's policy, as app tools do.
                authorizeLedger: (
                  tool,
                  readOnly,
                  callId,
                  signal,
                ): Promise<boolean> =>
                  candidate.tools.authorizeAppTool(
                    BRAND.tools.namespace,
                    tool,
                    readOnly,
                    callId,
                    signal,
                  ),
              }
            : {}),
          threadId,
        });
      const ownership = (
        candidate: CodexDelegationPreparation,
      ): {
        capabilitySnapshotId: string;
        capabilityLeaseKind: 'ephemeral';
        profile: CodexSpawnProfileRequest;
      } => ({
        capabilitySnapshotId: context.request.route.capabilitySnapshotHash,
        capabilityLeaseKind: 'ephemeral' as const,
        profile: candidate.profile,
      });
      const seedItems = async (threadId: string): Promise<JsonValue[]> => {
        if (options.loadResumeItems)
          return options.loadResumeItems(runtime, threadId);
        const { codexHome } = await runtime.getCanonicalState();
        const loaded = await loadCodexThreadSeedItemsWithLoadCount({
          codexHome,
          threadId,
        });
        if (loaded.loadedItemCount === 0)
          throw new Error(
            'Cannot continue the delegated task on a new thread without retained Codex history',
          );
        return loaded.items;
      };
      // Whether the live thread runs under the write profile, and otherwise
      // why it does not: the root is planning, or the parent's rules no
      // longer allow a grant.
      let threadWrites = false;
      let threadReadOnly: 'planning' | 'grants' | undefined;
      const openThread = async (
        candidate: CodexDelegationPreparation,
        resumeSessionId: string | undefined,
      ): Promise<CodexThreadHandle> => {
        const grants = await sandboxWriteRoots(candidate);
        // Preparation is cached per policy, but the parent's rules can deny
        // a grant later: such a thread defines no write profile at all.
        const revoked =
          grants.length > 0 &&
          (await candidate.tools.codexSandboxWritesRevoked());
        const writePaths = revoked ? [] : grants;
        const permissionProfile = sandboxProfile(candidate, writePaths);
        const params = threadParams(candidate, writePaths, permissionProfile);
        const advertisedTools = delegateTools(candidate, '');
        if (advertisedTools) params.dynamicTools = advertisedTools.specs;
        // Resume does not carry dynamic tools or capability roots, so any run
        // that advertises them is re-materialized from retained history. So
        // is any run with write grants, or after a write-profile thread:
        // resuming a still-loaded thread keeps the profile of the run before,
        // whatever the root's plan state or the parent's rules now.
        const refreshDelegationTools =
          advertisedTools !== undefined ||
          grants.length > 0 ||
          threadWrites ||
          Boolean(candidate.selectedCapabilityRoots?.length) ||
          Boolean(Object.keys(candidate.selectedMcpServers ?? {}).length);
        threadWrites = permissionProfile === CODEX_DELEGATION_WRITE_PROFILE;
        threadReadOnly = threadWrites
          ? undefined
          : !candidate.tools.writable()
            ? 'planning'
            : revoked
              ? 'grants'
              : undefined;
        if (!resumeSessionId)
          return runtime.startThread({ ...ownership(candidate), params });
        if (refreshDelegationTools)
          return runtime.materializeThread({
            ...ownership(candidate),
            params,
            items: await seedItems(resumeSessionId),
          });
        return runtime.resumeThread({
          ...ownership(candidate),
          params: {
            threadId: resumeSessionId,
            cwd: params.cwd,
            model: params.model,
            serviceTier: params.serviceTier,
            modelProvider: params.modelProvider,
            approvalPolicy: params.approvalPolicy,
            approvalsReviewer: params.approvalsReviewer,
            permissions: params.permissions,
            baseInstructions: params.baseInstructions,
            developerInstructions: params.developerInstructions,
            config: params.config,
          },
        });
      };
      let handle = await openThread(prepared, context.request.resumeSessionId);
      // One closer follows the live thread across capability reloads.
      context.retain(() => handle.unsubscribe());
      context.setInterrupt(() => handle.interrupt());
      context.setSteer((request) =>
        handle.submitSteeringInput(request.message, request.attemptId),
      );
      // Native saved rules are user approvals. Let Codex load and apply them
      // on start/resume; unmatched requests still use the parent callback.
      await context.emit({ type: 'started', nativeSessionId: handle.threadId });
      if (context.signal.aborted)
        throw new Error('Delegation cancelled after native thread allocation');
      const progress = new CodexDelegationProgress();
      const appendChildChanges = context.appendChildChanges;
      const transcript = new DelegationTranscriptRecorder(
        appendChildChanges ? DELEGATION_STREAM_PREVIEW_LIMITS : undefined,
      );
      const spools = appendChildChanges
        ? (options.spools ?? createDefaultCommandOutputSpools)()
        : undefined;
      const reportWithoutMasking = (error: unknown): void => {
        try {
          options.reportError(error);
        } catch {
          // Diagnostics must never replace the primary runner/storage error.
        }
      };
      const childNormalizer = appendChildChanges
        ? new DelegationChildNormalizer(
            delegationBlockId(
              context.request.delegationId,
              context.request.runGeneration,
            ),
            {
              ...(spools ? { spools } : {}),
              onStorageFailure: (error: unknown): void => {
                context.failTranscript?.(error);
              },
              onDiagnostic: ({ kind, segment, count }): void => {
                reportWithoutMasking(
                  new Error(
                    `Codex delegation observed ${count} event${count === 1 ? '' : 's'} for closed segment ${segment} (${kind})`,
                  ),
                );
              },
            },
          )
        : undefined;
      const childAppends = appendChildChanges
        ? new ChildAppendQueue(appendChildChanges, (changes) =>
            childNormalizer?.acknowledge(changes),
          )
        : undefined;
      // Provider events queue their rows and continue; settling waits until
      // every queued row is durable.
      const queueNormalizedChanges = async (
        changes: readonly DelegationTranscriptChange[],
      ): Promise<void> => childAppends?.enqueue(changes);
      const appendNormalizedChanges = async (
        changes: readonly DelegationTranscriptChange[],
      ): Promise<void> => childAppends?.flush(changes);
      let events: Promise<void> = Promise.resolve();
      const settleChildTurn = async (
        threadId: string,
        turnId: string | undefined,
        kind: 'completed' | 'interrupted' | 'failed',
      ): Promise<void> => {
        if (!childNormalizer) return;
        let laneError: unknown;
        let laneFailed = false;
        try {
          await events;
        } catch (error) {
          laneError = error;
          laneFailed = true;
        }
        try {
          await appendNormalizedChanges(
            await childNormalizer.settleTurn({
              threadId,
              ...(turnId === undefined ? {} : { turnId }),
              kind,
            }),
          );
        } catch (error) {
          reportWithoutMasking(error);
          if (!laneFailed) throw error;
        }
        if (laneFailed) throw laneError;
      };
      const loadToolName =
        CANOPY_INJECTED_TOOL_REGISTRY.load_deferred_tools.codexToolName;
      const reload = prepared.capabilityReload;
      let transcriptLimitExceeded = false;
      let transcriptInterrupt: Promise<void> | undefined;
      // Written from the event callback while a turn runs. One interrupt
      // stops the provider turn (not the delegated run) for a delivered
      // capability reload, or to continue read-only because the root
      // started to plan or the parent's rules denied a grant.
      const turnStop: {
        interrupt?: Promise<void>;
        readOnly?: 'planning' | 'grants';
      } = {};
      let lastTranscript = 0;
      let lastProgress = 0;
      // Usage of turns already ended by a capability reload. A reload opens a
      // new native thread, whose cumulative counters start again from zero.
      let settledUsage: AgentDelegationUsage = {};
      let outcomeUsage: AgentDelegationUsage = {};
      let finalProgress = '';
      let input: readonly string[] = [context.request.task.prompt];
      let outcome: Awaited<ReturnType<CodexThreadHandle['runTurn']>>;
      try {
        for (;;) {
          const segment = handle;
          const segmentPrepared = prepared;
          const hostTools = delegateTools(segmentPrepared, segment.threadId);
          const selectedMcpNames = new Set(
            Object.keys(segmentPrepared.selectedMcpServers ?? {}),
          );
          const gatedMcpNames = new Set(
            segmentPrepared.providerGatedMcpServers ?? [],
          );
          const segmentWrites = threadWrites;
          segmentPrepared.tools.setCodexTurnWrites(segmentWrites);
          // Known-safe commands and commands a native `.rules` file approves
          // run inside the sandbox without a parent approval, so declining
          // approvals cannot stop a write-profile turn from writing once the
          // root plans or the parent's rules deny writes inside a grant. The
          // profile cannot change on a loaded thread: stop the provider turn
          // (not the delegated run), and the loop below continues on a thread
          // opened under the read-only profile. `interrupt()` before the
          // runtime knows the native turn id would restart the shared
          // app-server, so it waits for `turn/started`.
          let turnIdKnown = false;
          let currentTurnId: string | undefined;
          let turnSettled = false;
          const stoppable = (): boolean =>
            segmentWrites &&
            turnIdKnown &&
            !turnSettled &&
            !turnStop.interrupt &&
            !transcriptLimitExceeded &&
            !context.signal.aborted;
          const stopReadOnly = (reason: 'planning' | 'grants'): void => {
            if (!stoppable()) return;
            turnStop.readOnly = reason;
            turnStop.interrupt = segment.interrupt().catch((error: unknown) => {
              options.reportError(error);
            });
          };
          // The grants are evaluated against the parent's policy one at a
          // time: at once when the policy context key changed or a native
          // approval is requested, otherwise at most every
          // CODEX_DELEGATION_GRANT_CHECK_MS. A failed evaluation fails closed.
          let grantCheck: Promise<void> | undefined;
          let grantCheckedAt = 0;
          let grantPolicyKey: string | undefined;
          const checkGrants = (force: boolean): void => {
            if (grantCheck || !stoppable()) return;
            const policyKey = segmentPrepared.tools.policyContextKey();
            const now = Date.now();
            if (
              !force &&
              grantCheckedAt > 0 &&
              policyKey === grantPolicyKey &&
              now - grantCheckedAt < CODEX_DELEGATION_GRANT_CHECK_MS
            )
              return;
            grantCheckedAt = now;
            grantPolicyKey = policyKey;
            grantCheck = segmentPrepared.tools
              .codexSandboxWritesRevoked()
              .catch((error: unknown): boolean => {
                options.reportError(error);
                return true;
              })
              .then((revoked) => {
                grantCheck = undefined;
                if (revoked) stopReadOnly('grants');
              })
              .catch((error: unknown) => {
                options.reportError(error);
              });
          };
          // A rule save that may revoke a grant stops the turn at once: the
          // grants' evaluation waits for the save, and the next thread opens
          // under its outcome.
          const checkWriteAuthority = (force = false): void => {
            if (!stoppable()) return;
            if (!segmentPrepared.tools.writable()) stopReadOnly('planning');
            else if (segmentPrepared.tools.codexSandboxWritesNarrowing())
              stopReadOnly('grants');
            else checkGrants(force);
          };
          const turn = segment.runTurn({
            input: input.map(
              (text): UserInput => ({
                type: 'text',
                text,
                text_elements: [],
              }),
            ),
            ...(effort ? { effort: effort === 'off' ? 'none' : effort } : {}),
            serviceTier: threadParams(segmentPrepared).serviceTier,
            signal: context.signal,
            startupTimeoutMs: 30_000,
            ...(hostTools ? { hostToolPolicy: hostTools.policy } : {}),
            ...(selectedMcpNames.size
              ? {
                  // Native Codex asks before calling an MCP tool. Servers the
                  // host proxy or stdio broker gates are admitted here and
                  // approved once at that transport. Provider-handled servers
                  // bypass the host transport, so their calls are approved
                  // here under the parent policy, as a parent chat's are.
                  mcpElicitationPolicy: {
                    allowExternalMutation: true,
                    evaluate: (
                      call: {
                        serverName: string;
                        toolName: string;
                        approvalKind: string;
                      },
                      requestSignal?: AbortSignal,
                    ):
                      | { approved: boolean; externalMutation: boolean }
                      | Promise<{
                          approved: boolean;
                          externalMutation: boolean;
                        }> => {
                      const admitted =
                        call.approvalKind === 'mcp_tool_call' &&
                        selectedMcpNames.has(call.serverName) &&
                        call.toolName.length > 0;
                      const gated = providerGatedServer(
                        call.serverName,
                        gatedMcpNames,
                      );
                      if (!admitted || gated === undefined)
                        return { approved: admitted, externalMutation: true };
                      return segmentPrepared.tools
                        .authorizeMcp(
                          gated,
                          call.toolName,
                          undefined,
                          randomUUID(),
                          requestSignal ?? context.signal,
                        )
                        .then((approved) => ({
                          approved,
                          externalMutation: true,
                        }));
                    },
                  },
                }
              : {}),
            nativeApprovalPolicy: (method, request, requestSignal) => {
              checkWriteAuthority(true);
              return segmentPrepared.tools.approveCodex(
                method,
                request,
                requestSignal,
              );
            },
            onEvent: (event) => {
              if (
                event.method === 'turn/started' &&
                event.params.threadId === segment.threadId
              ) {
                const eventTurn = record(event.params.turn);
                const eventTurnId = eventTurn?.id;
                if (typeof eventTurnId === 'string' && eventTurnId)
                  currentTurnId = eventTurnId;
              } else if (
                currentTurnId === undefined &&
                event.params.threadId === segment.threadId &&
                (event.method === 'turn/completed' ||
                  (event.method === 'error' &&
                    event.params.willRetry === false))
              ) {
                const eventTurn = record(event.params.turn);
                const eventTurnId =
                  (typeof eventTurn?.id === 'string' && eventTurn.id) ||
                  (typeof event.params.turnId === 'string' &&
                    event.params.turnId) ||
                  undefined;
                if (eventTurnId) currentTurnId = eventTurnId;
              }
              if (
                !turnIdKnown &&
                event.method === 'turn/started' &&
                event.params.threadId === segment.threadId &&
                typeof record(event.params.turn)?.id === 'string'
              ) {
                turnIdKnown = true;
                // The runtime records the turn id after this callback.
                queueMicrotask(() => checkWriteAuthority());
              } else checkWriteAuthority();
              segmentPrepared.tools.observeCodex(event.method, event.params);
              progress.receive(event);
              transcript.codex(event);
              if (childNormalizer) {
                events = events.then(async () =>
                  queueNormalizedChanges(await childNormalizer.codex(event)),
                );
                void events.catch(options.reportError);
              }
              if (
                transcript.limitExceeded &&
                !childNormalizer &&
                !transcriptLimitExceeded
              ) {
                transcriptLimitExceeded = true;
                transcriptInterrupt = segment.interrupt().catch((error) => {
                  options.reportError(error);
                });
              }
              const item = record(event.params.item);
              // The Load result has reached the model: stop this provider
              // turn (not the delegated run) so the capabilities can change.
              // A turn already stopping to continue read-only still records
              // the delivery, since the model has seen the result.
              if (
                reload &&
                !reload.controller.delivered &&
                !transcriptLimitExceeded &&
                event.method === 'item/completed' &&
                item?.type === 'dynamicToolCall' &&
                item.namespace == null &&
                item.tool === loadToolName &&
                reload.controller.pending &&
                reload.controller.markDelivered()
              )
                turnStop.interrupt ??= segment
                  .interrupt()
                  .catch((error: unknown) => {
                    options.reportError(error);
                  });
              if (
                Date.now() - lastTranscript >= 200 ||
                event.method === 'item/completed'
              ) {
                const items = transcript.take();
                const truncated = transcript.truncated;
                if (items?.length)
                  events = events.then(() =>
                    context.emit({ type: 'transcript', items, truncated }),
                  );
                lastTranscript = Date.now();
                void events.catch(options.reportError);
              }
              if (
                progress.usage &&
                event.method === 'thread/tokenUsage/updated'
              ) {
                const usage = addUsage(settledUsage, progress.usage);
                events = events.then(() =>
                  context.emit({ type: 'usage', usage }),
                );
                void events.catch(options.reportError);
              }
              if (Date.now() - lastProgress >= 200) {
                const captured = progress.text;
                if (captured) {
                  const truncated = progress.truncated;
                  lastProgress = Date.now();
                  events = events.then(() =>
                    context.emit({
                      type: 'progress',
                      text: captured,
                      truncated,
                    }),
                  );
                  void events.catch(options.reportError);
                }
              }
              return childNormalizer ? events : undefined;
            },
          });
          // Provider events can pause for a while (a silent command, or the
          // model thinking), so the plan state and the grants are also
          // rechecked on a timer.
          const writeCheck = segmentWrites
            ? setInterval((): void => {
                try {
                  checkWriteAuthority();
                } catch (error) {
                  options.reportError(error);
                }
              }, CODEX_DELEGATION_PLAN_CHECK_MS)
            : undefined;
          writeCheck?.unref?.();
          let turnOutcome:
            | Awaited<ReturnType<CodexThreadHandle['runTurn']>>
            | undefined;
          let turnError: unknown;
          let turnFailed = false;
          try {
            turnOutcome = await turn;
          } catch (error) {
            turnFailed = true;
            turnError = error;
          } finally {
            turnSettled = true;
            clearInterval(writeCheck);
          }
          if (
            childNormalizer &&
            !(turnFailed && retryingCodexError(turnError))
          ) {
            await settleChildTurn(
              segment.threadId,
              turnOutcome?.turnId ?? currentTurnId,
              turnOutcome?.status ?? 'failed',
            );
          }
          if (turnFailed) throw turnError;
          if (!turnOutcome)
            throw new Error('Codex runTurn returned no outcome');
          outcome = turnOutcome;
          const stopping = turnStop.interrupt;
          const stoppedReadOnly = turnStop.readOnly;
          turnStop.interrupt = undefined;
          turnStop.readOnly = undefined;
          if (stopping) await stopping;
          outcomeUsage = addUsage(outcomeUsage, {
            inputTokens: outcome.usage.inputTokens,
            outputTokens: outcome.usage.outputTokens,
            cachedInputTokens: outcome.usage.cacheReadInputTokens,
            cacheCreationInputTokens: outcome.usage.cacheCreationInputTokens,
            costUsd: outcome.usage.totalCostUsd,
          });
          let quotaRecovered = false;
          if (
            outcome.status === 'failed' &&
            segmentPrepared.waitForQuotaRecovery &&
            !context.signal.aborted &&
            !transcriptLimitExceeded
          ) {
            const failure = classifyAgentFailure({
              provider: 'codex',
              accountScope: 'native',
              events: [
                {
                  type: 'codex',
                  event: {
                    type: 'turn.failed',
                    error: {
                      message: outcome.error,
                      codexErrorInfo: outcome.errorInfo,
                    },
                  },
                },
              ],
              error: outcome.error,
            });
            if (failure?.kind === 'provider_usage_limit') {
              await segmentPrepared.waitForQuotaRecovery(
                failure,
                context.signal,
              );
              context.signal.throwIfAborted();
              if (!segmentWrites) {
                input = [CODEX_DELEGATION_RESUME_CONTINUATION];
                continue;
              }
              // A loaded write-profile thread retains its native approvals.
              // Rebuild from history under the grants and plan state allowed
              // now before a resumed turn can execute any command.
              quotaRecovered = true;
            }
          }
          const reloading = reload?.controller.delivered === true;
          // A turn that finished before the read-only stop took effect has
          // its result; only an interrupted one continues read-only.
          const continuingReadOnly =
            stoppedReadOnly !== undefined && outcome.status === 'interrupted';
          if (
            !(quotaRecovered || reloading || continuingReadOnly) ||
            transcriptLimitExceeded ||
            context.signal.aborted ||
            (outcome.status === 'failed' && !quotaRecovered)
          ) {
            reload?.controller.discardUndelivered();
            break;
          }
          // Same run generation: the broker run stays running, so the
          // interrupted turn publishes no result and fires no watcher.
          let continuation: string[] = quotaRecovered
            ? [CODEX_DELEGATION_RESUME_CONTINUATION]
            : [];
          if (reload && reloading) {
            const performed = await reload.controller.perform(
              reload.host,
              context.signal,
            );
            assertRestricted(performed.prepared);
            prepared = performed.prepared;
            continuation = [performed.continuation];
          } else {
            // A Load whose result the stopped turn never delivered: the
            // child can call it again on the new thread.
            reload?.controller.discardUndelivered();
          }
          settledUsage = addUsage(settledUsage, progress.usage);
          progress.usage = undefined;
          // `thread/resume` cannot change selected capability roots, dynamic
          // tools or the permission profile, so the history continues on a
          // rebuilt thread, as a parent chat's capability transition does.
          // It opens under the profile the root's plan state and the
          // parent's rules allow now.
          const next = await openThread(prepared, segment.threadId);
          handle = next;
          await segment.unsubscribe().catch((error: unknown) => {
            options.reportError(error);
          });
          await context.emit({
            type: 'started',
            nativeSessionId: next.threadId,
          });
          if (context.signal.aborted) break;
          const madeReadOnly =
            segmentWrites && !threadWrites ? threadReadOnly : undefined;
          input =
            madeReadOnly === 'planning'
              ? [...continuation, CODEX_DELEGATION_PLANNING_CONTINUATION]
              : madeReadOnly === 'grants'
                ? [
                    ...continuation,
                    CODEX_DELEGATION_GRANTS_REVOKED_CONTINUATION,
                  ]
                : continuation.length
                  ? continuation
                  : [CODEX_DELEGATION_RESUME_CONTINUATION];
        }
      } catch (error) {
        if (context.signal.aborted) reload?.controller.cancel();
        throw error;
      } finally {
        if (context.signal.aborted) reload?.controller.cancel();
        try {
          await events;
        } finally {
          try {
            await appendNormalizedChanges(
              childNormalizer ? await childNormalizer.finish() : [],
            );
          } finally {
            try {
              await childNormalizer?.close();
            } catch (error) {
              reportWithoutMasking(error);
            }
          }
        }
        await transcriptInterrupt;
        const items = transcript.take();
        if (items?.length)
          await context.emit({
            type: 'transcript',
            items,
            truncated: transcript.truncated,
          });
        finalProgress = progress.text;
        if (finalProgress)
          await context.emit({
            type: 'progress',
            text: finalProgress,
            truncated: progress.truncated,
          });
      }
      if (transcriptLimitExceeded)
        throw new DelegationRunnerError({
          code: 'runtime_error',
          message:
            'Delegated transcript exceeded the safe retention budget. The native turn was stopped.',
          retryable: false,
        });
      let failure: AgentDelegationError | undefined;
      if (outcome.status === 'failed') {
        const described = codexTurnFailure({
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.errorInfo ? { errorInfo: outcome.errorInfo } : {}),
          partialOutput: Boolean(
            outcome.finalText.trim() || finalProgress.trim(),
          ),
        });
        failure = described.error;
        if (described.modelRejected)
          recordDelegationModelRejection({
            ...(context.request.route.authAccountKey !== undefined
              ? { accountKey: context.request.route.authAccountKey }
              : {}),
            modelId: context.request.route.runtimeModelId,
          });
        // Reason only: the provider's words stay in the delegation result.
        options.reportError(
          new Error(`Delegated Codex turn failed (${failure.code})`),
        );
      }
      return {
        status:
          outcome.status === 'completed'
            ? 'completed'
            : outcome.status === 'interrupted'
              ? 'cancelled'
              : 'failed',
        finalText: outcome.finalText,
        usage: outcomeUsage,
        ...(failure ? { error: failure } : {}),
      };
    },
    options.reportError,
    { transcriptPort: options.transcriptPort },
  );
}
