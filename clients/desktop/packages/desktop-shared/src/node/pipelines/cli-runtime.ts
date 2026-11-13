import type { OpenCodePromptHost } from './opencode-prompt-runner';
import type { CopilotPromptHost } from './copilot-prompt-runner';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import {
  getCursorRuntimeRootDir,
  getEnhancedEnv,
  getProjectActionsDir,
  getProjectActionsDirCandidates,
  getProjectPipelinesDir,
  getProjectPipelinesDirCandidates,
} from '@canopy/execution-engine/pipelines/config-paths';
import { getWorktreeCliRecord } from '../lib/worktree-cli-reads';
import { getPipelineExecutionPluginRuntimeDir } from '@canopy/execution-engine/node/lib/paths';
import type {
  CodexPromptRunnerRequest,
  CodexPromptRunnerResult,
  CopilotPromptRunnerResult,
  OpenCodePromptRunnerResult,
  CursorPromptRunnerRequest,
  CursorPromptRunnerResult,
  ExecutionRuntime,
  PipelineHostActions,
  ResolvePipelineTargetRequest,
  ResolvePipelineTargetResult,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import { extractEmbeddedResources } from './embedded-resources';
import { cursorRuntimeInstalled } from '../cursor/runtime-status';
import { resolveCursorLaunch } from '../cursor/runtime-launch';
import { fingerprintCursorRuntime } from '../cursor/runtime-fingerprint';
import {
  CURSOR_RUNTIME_VERSION,
  getCursorRuntimeArtifact,
  getCursorRuntimeTargetForHost,
} from '../cursor/runtime-metadata';
import {
  codexTranscriptEventsHaveAgentActivity,
  createCodexCapabilitySnapshotId,
  createCodexRuntimeService,
  CodexCapabilityStore,
  CodexHttpMcpProxyService,
  type CodexMcpLauncherCommand,
  type CodexStdioMcpLaunchRoute,
  type CodexRunTurnRequest,
  type CodexRuntimeService,
  type CodexThreadHandle,
  createHeadlessMcpElicitationPolicy,
  isForeignThreadTokenUsageEvent,
  projectCodexRuntimeEvent,
} from '@canopy/execution-engine/node/codex-runtime';
import { resolvePlugins } from '@canopy/execution-engine/node/plugins/plugin-resolver';
import { resolveCodexMockAppServerOverride } from '@canopy/execution-engine/node/e2e-mock-env';
import {
  CODEX_STRUCTURED_OUTPUT_RETRY_ATTEMPTS,
  appendCodexSchemaInstruction,
  buildCodexPrompt,
  buildCodexStructuredOutputRetryPrompt,
  buildCodexSystemPrompt,
  isRetryableCodexStructuredOutputError,
  parseStructuredResponseText,
} from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';
import { mapThinkingToReasoningEffort } from '@canopy/execution-engine/lib/codex-model-config';
import {
  SETUP_WITHDRAWN,
  createSetupWithdrawal,
  stepTimedOutMessage,
} from '@canopy/execution-engine/node/pipelines/step-timeout';
import { buildPipelineGlobalInstructionsBlock } from '@canopy/execution-engine/lib/global-instructions';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';
import { classifyAgentFailure } from '@canopy/execution-engine/agent-failures';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import { isJsonValue } from '@canopy/execution-engine/node/codex-runtime/rollout-seed';
import { isRecord } from '@canopy/execution-engine/node/lib/type-guards';
import { buildCodexPipelineThreadConfig } from '@canopy/execution-engine/node/pipelines/codex-preferences';
import {
  codexNativeMemoryThreadConfig,
  localMemoryEnabledFromEnv,
} from '@canopy/execution-engine/node/lib/native-memory';
import {
  DEFAULT_OLLAMA_SERVER_PORT,
  DEFAULT_OLLAMA_HARNESS,
  getExecutionHarnessForModel,
  getModelSource,
  isOllamaResponsesVersionCompatible,
  isOllamaServerVersionCompatible,
  MINIMUM_OLLAMA_SERVER_VERSION,
  MINIMUM_OLLAMA_RESPONSES_VERSION,
  isOllamaModel,
  stripOllamaModelPrefix,
  type ModelHarnessInvocation,
} from '../../types';
import { isGatewayOnlyModel } from '@canopy/execution-engine/lib/gateway-model-availability';
import { buildCodexCompatibleOllamaConfig } from '../ollama';
import { spawnProviderProcessDirect } from '../provider-process/spawn';

export interface CliRuntimeArgs {
  /** Execution-only host injection; construction acquires no resources. */
  pipelineHostActions?: PipelineHostActions;
  /** Trusted host owns the live Copilot rollout, verified installation and selected account.
   * Standalone CLI has no rollout authority and fails closed when this is absent. */
  copilotHost?: CopilotPromptHost;
  opencodeHost?: OpenCodePromptHost;
  cwd: string;
  pipelinePath?: string;
  executionsDir?: string;
  bundledActionsDir?: string;
  /**
   * Real organization model-policy gate, injected by a host that can read the
   * encrypted cloud account (Electron main). Absent in a standalone CLI
   * process — see {@link CLI_ORG_MODEL_POLICY_NOT_ENFORCEABLE_REASON}.
   */
  isModelBlockedByOrgPolicy?: (modelId: string) => Promise<boolean>;
  /**
   * Real "is any org model policy active" signal, injected by the same host
   * that can supply {@link CliRuntimeArgs.isModelBlockedByOrgPolicy}. Absent in
   * a standalone CLI process for the identical reason — see
   * {@link CLI_ORG_MODEL_POLICY_NOT_ENFORCEABLE_REASON}.
   */
  isOrgModelPolicyActive?: () => Promise<boolean>;
}

interface CliRuntimeDependencies {
  /** @internal Test seam for exercising pinned runtimes on unsupported CI hosts. */
  cursorHost?: {
    platform: string;
    arch: string;
  };
  /**
   * @internal Test seam: the pinned full-tree digest a staged fixture runtime
   * must match, standing in for the manifest's `filesSha256` the way the
   * desktop's E2E fixture archive carries its own digests. The tree is still
   * hashed and compared; production never supplies this.
   */
  cursorRuntimeDigest?: string;
}

/**
 * Why a standalone CLI process cannot evaluate the org model policy.
 *
 * The policy lives in the enforced-settings block of the cloud account file,
 * which is encrypted with Electron's `safeStorage` (see
 * `apps/desktop-app/src/main/lib/canopy-cloud-account-store.ts`). Decrypting it
 * requires the OS-keychain-backed `electron.safeStorage` key, and
 * `apps/desktop-cli` must never import Electron — `npm run
 * check:electron-boundary` fails the build if it does, because the packaged SEA
 * CLI has no Electron runtime. There is no plaintext projection of the policy
 * on disk for a non-Electron process to read.
 */
export const CLI_ORG_MODEL_POLICY_NOT_ENFORCEABLE_REASON =
  'The organization model policy is stored in the Electron safeStorage-encrypted cloud account and cannot be read without Electron.';

/**
 * Deliberate, visible non-enforcement for standalone CLI runs. The
 * `ExecutionRuntime.isModelBlockedByOrgPolicy` member is required precisely so
 * this exemption has to be written down here rather than created by omission.
 */
function cliOrgModelPolicyFallback(): Promise<boolean> {
  return Promise.resolve(false);
}

/**
 * Same deliberate, visible non-enforcement for the "is a policy active" signal.
 * A standalone CLI process cannot read the policy at all, so it cannot know one
 * is active either; reporting `false` keeps the CLI on the exact behavior it
 * has today (no default-model pinning) rather than pinning a model nobody
 * asked for. `ExecutionRuntime.isOrgModelPolicyActive` is required so this
 * exemption has to be written down here rather than created by omission.
 */
function cliOrgModelPolicyActiveFallback(): Promise<boolean> {
  return Promise.resolve(false);
}

export class CodexMcpLauncherUnavailableError extends Error {
  constructor() {
    super('The Codex MCP launcher is not configured.');
    this.name = 'CodexMcpLauncherUnavailableError';
  }
}

let cliCodexRuntimeService: CodexRuntimeService | null = null;
let cliCodexMcpLauncher: CodexMcpLauncherCommand | null = null;
let cliHttpMcpProxyService: CodexHttpMcpProxyService | null = null;
let cliCodexShutdownPromise: Promise<void> | null = null;
const cliCodexCapabilityStore = new CodexCapabilityStore(getCanopyDataDir());
let cliCodexCapabilityGcPromise: Promise<void> | null = null;

export const CLI_CODEX_TURN_START_TIMEOUT_MS = 10 * 60_000;

export function getCliCodexTurnTimeoutOptions(): Pick<
  CodexRunTurnRequest,
  'startupTimeoutMs'
> {
  return { startupTimeoutMs: CLI_CODEX_TURN_START_TIMEOUT_MS };
}

export function createCliStdioMcpServerConfig(
  route: CodexStdioMcpLaunchRoute,
): Pick<CodexStdioMcpLaunchRoute, 'command' | 'args'> {
  return {
    command: route.command,
    args: route.args,
  };
}

/** Set once by the CLI before any command runs (CAN-4117). */
export function configureCliCodexRuntime(options: {
  mcpLauncher: CodexMcpLauncherCommand;
}): void {
  if (cliCodexRuntimeService) return;
  cliCodexMcpLauncher = {
    command: options.mcpLauncher.command,
    args: [...options.mcpLauncher.args],
  };
}

function getCliCodexRuntimeService(): CodexRuntimeService {
  const mcpLauncher = cliCodexMcpLauncher;
  if (!mcpLauncher) throw new CodexMcpLauncherUnavailableError();
  cliCodexCapabilityGcPromise ??= cliCodexCapabilityStore
    .collectGarbage()
    .then(() => undefined)
    .catch(() => undefined);
  cliCodexRuntimeService ??= createCodexRuntimeService({
    capabilityStore: cliCodexCapabilityStore,
    mcpLauncher,
  });
  return cliCodexRuntimeService;
}

function getCliHttpMcpProxyService(): CodexHttpMcpProxyService {
  cliHttpMcpProxyService ??= new CodexHttpMcpProxyService();
  return cliHttpMcpProxyService;
}

export function shutdownCliCodexRuntimeService(): Promise<void> {
  if (!cliCodexShutdownPromise) {
    const service = cliCodexRuntimeService;
    const httpMcpProxy = cliHttpMcpProxyService;
    cliCodexRuntimeService = null;
    cliHttpMcpProxyService = null;
    cliCodexShutdownPromise = Promise.all([
      service?.shutdown() ?? Promise.resolve(),
      httpMcpProxy?.shutdown() ?? Promise.resolve(),
      cliCodexCapabilityGcPromise ?? Promise.resolve(),
    ]).then(() => undefined);
  }
  return cliCodexShutdownPromise;
}

function readStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readStringArrayField(
  record: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) &&
    value.every((entry: unknown) => typeof entry === 'string')
    ? value
    : undefined;
}

function readStringRecordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const value = record[key];
  if (!isRecord(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      return undefined;
    }
    result[name] = entry;
  }
  return result;
}

export function cliHttpMcpAuthorityId(
  upstreamUrl: string,
  headers: Record<string, string> | undefined,
): string {
  const normalizedHeaders = Object.entries(headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256')
    .update(JSON.stringify({ upstreamUrl, headers: normalizedHeaders }))
    .digest('hex');
}

export function createCliCodexCapabilitySnapshotId(
  options: Parameters<typeof createCodexCapabilitySnapshotId>[0],
): string {
  return createCodexCapabilitySnapshotId(options);
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function resolveCliOllamaPort(): Promise<number> {
  const configuredHost = process.env.OLLAMA_HOST?.trim();
  if (configuredHost) {
    try {
      const url = new URL(
        configuredHost.includes('://')
          ? configuredHost
          : `http://${configuredHost}`,
      );
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        throw new Error('non-loopback host');
      }
      const port = url.port ? Number(url.port) : 11434;
      if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
    } catch {
      throw new Error(
        'OLLAMA_HOST must identify a loopback Ollama endpoint with a valid port.',
      );
    }
  }
  try {
    const raw = await fs.promises.readFile(
      path.join(getCanopyDataDir(), 'preferences.json'),
      'utf8',
    );
    const parsed: unknown = JSON.parse(raw);
    const configuredPort = isRecordValue(parsed)
      ? parsed.ollamaServerPort
      : undefined;
    if (
      typeof configuredPort === 'number' &&
      Number.isInteger(configuredPort) &&
      configuredPort > 0 &&
      configuredPort <= 65_535
    ) {
      return configuredPort;
    }
  } catch {
    // A missing/unreadable desktop preference uses the shared default.
  }
  return DEFAULT_OLLAMA_SERVER_PORT;
}

/**
 * Whether a parsed `preferences.json` connects Cursor.
 *
 * The desktop writes `{ version: 1, preferences: { ... } }`
 * (`writePreferencesDataFile`) and treats any other shape, including an
 * unversioned flat object, as unsupported and recovers it rather than reading
 * `cursorEnabled` from it. This reads the same envelope and nothing else, so a
 * flat, malformed, differently versioned or non-`true` value is disconnected.
 */
export function cursorEnabledInPreferencesFile(parsed: unknown): boolean {
  return (
    isRecordValue(parsed) &&
    parsed.version === 1 &&
    isRecordValue(parsed.preferences) &&
    parsed.preferences.cursorEnabled === true
  );
}

/**
 * Mirrors the desktop's `cursorConnectionStatus()` (`Boolean((await
 * readPreferencesFile()).cursorEnabled)`, `apps/desktop-app/src/main/cursor/
 * runtime-status.ts`): a user who explicitly disconnected Cursor in Settings
 * must not have headless Cursor pipeline steps execute through the CLI just
 * because the runtime files are still on disk. Fails closed (disabled) on a
 * missing, unreadable or malformed file and on anything but the envelope
 * `cursorEnabledInPreferencesFile` accepts.
 */
async function readCliCursorEnabledPreference(): Promise<boolean> {
  try {
    const raw = await fs.promises.readFile(
      path.join(getCanopyDataDir(), 'preferences.json'),
      'utf8',
    );
    return cursorEnabledInPreferencesFile(JSON.parse(raw));
  } catch {
    return false;
  }
}

async function probeCliOllama(port: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(
      `http://127.0.0.1:${String(port)}/api/version`,
      { signal: controller.signal },
    );
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    const body: unknown = await response.json();
    if (!isRecordValue(body) || typeof body.version !== 'string') {
      throw new Error('version response was malformed');
    }
    return body.version;
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : '';
    throw new Error(
      `Cannot connect to the configured Ollama server on 127.0.0.1:${String(port)}. Start Ollama or update OLLAMA_HOST${detail}.`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveCliOllamaInvocation(
  model: string,
  harness: 'claude' | 'codex',
): Promise<ModelHarnessInvocation> {
  const port = await resolveCliOllamaPort();
  const version = await probeCliOllama(port);
  const runtimeModel = stripOllamaModelPrefix(model).trim();
  if (!runtimeModel) throw new Error('Invalid Ollama model ID.');
  if (harness === 'codex') {
    if (!isOllamaResponsesVersionCompatible(version)) {
      throw new Error(
        `Ollama ${version} does not support the Responses API required by the Codex harness. Upgrade Ollama to ${MINIMUM_OLLAMA_RESPONSES_VERSION} or newer.`,
      );
    }
    return {
      source: 'ollama',
      harness,
      runtimeModel,
      aiCreditsRouted: false,
      codexConfig: buildCodexCompatibleOllamaConfig(port, runtimeModel),
    };
  }
  if (!isOllamaServerVersionCompatible(version)) {
    throw new Error(
      `Ollama ${version} does not support the Messages API required by the Claude harness. Upgrade Ollama to ${MINIMUM_OLLAMA_SERVER_VERSION} or newer.`,
    );
  }
  return {
    source: 'ollama',
    harness,
    runtimeModel,
    aiCreditsRouted: false,
    envOverride: {
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${String(port)}`,
    },
  };
}

async function runCliCodexPrompt(
  request: CodexPromptRunnerRequest,
): Promise<CodexPromptRunnerResult> {
  const transcript: string[] = [];
  const transcriptEvents: unknown[] = [];
  const pushTranscriptLine = (line: string): void => {
    transcript.push(line);
    try {
      request.onTranscriptLine?.(line);
    } catch {
      // Live forwarding is best-effort; the resolved transcript stays
      // authoritative, and a listener failure must not fail the turn.
    }
  };
  let handle: CodexThreadHandle | undefined;
  const failureProvider =
    request.harnessInvocation?.source === 'ollama' ? 'ollama' : 'codex';
  const service = getCliCodexRuntimeService();
  const mcpOwnerId = `pipeline:${request.executionId}:${request.jobId}${request.childId ? `:${request.childId}` : ''}:${request.stepId}:${request.attempt}`;
  try {
    const pluginRuntimeRoot = getPipelineExecutionPluginRuntimeDir(
      '',
      request.executionId,
      request.jobId,
      request.stepId,
      request.childId,
    );
    const resolved = request.pluginSelections
      ? resolvePlugins(
          request.pluginSelections,
          request.projectId ?? 'pipeline',
          request.worktreeId ?? request.executionId,
          request.stepId,
          {
            purpose: 'codex-session',
            runtimeDirs: {
              rootDir: pluginRuntimeRoot,
              claudePluginDir: path.join(
                pluginRuntimeRoot,
                'claude-sdk-plugin',
              ),
            },
          },
        )
      : undefined;
    for (const warning of resolved?.warnings ?? []) {
      pushTranscriptLine(JSON.stringify({ type: 'warning', message: warning }));
    }
    const roots = (
      await cliCodexCapabilityStore.publishSelectedRoots(
        resolved?.selectedCapabilityRoots ?? [],
      )
    ).roots;
    const mcpServers: Record<string, JsonValue> = {};
    const httpMcpAuthorityIds: string[] = [];
    for (const [name, rawServer] of Object.entries(
      resolved?.mcpServers ?? {},
    )) {
      if (!isRecord(rawServer)) {
        continue;
      }
      const serverType = readStringField(rawServer, 'type');
      const command = readStringField(rawServer, 'command');
      if (serverType === 'stdio' && command) {
        const args = readStringArrayField(rawServer, 'args');
        const cwd = readStringField(rawServer, 'cwd');
        const env = readStringRecordField(rawServer, 'env');
        const route = await service.registerStdioMcpRoute({
          ownerId: mcpOwnerId,
          routeKey: name,
          command,
          ...(args ? { args } : {}),
          ...(cwd ? { cwd } : {}),
          ...(env ? { env } : {}),
        });
        const serverConfig = createCliStdioMcpServerConfig(route);
        if (isJsonValue(serverConfig)) {
          mcpServers[name] = serverConfig;
        }
        continue;
      }
      const upstreamUrl = readStringField(rawServer, 'url');
      if (serverType === 'http' && upstreamUrl) {
        const { headers: _headers, url: _url, ...serverConfig } = rawServer;
        void _headers;
        void _url;
        const headers = readStringRecordField(rawServer, 'headers');
        httpMcpAuthorityIds.push(
          `${name}:${cliHttpMcpAuthorityId(upstreamUrl, headers)}`,
        );
        const lease = await getCliHttpMcpProxyService().registerRoute({
          ownerId: mcpOwnerId,
          upstreamUrl,
          ...(headers ? { headers } : {}),
        });
        const proxyConfig = { ...serverConfig, url: lease.url };
        if (isJsonValue(proxyConfig)) {
          mcpServers[name] = proxyConfig;
        }
      }
    }
    const snapshotId = createCliCodexCapabilitySnapshotId({
      roots,
      mcpServers,
      mcpAuthorityIds: httpMcpAuthorityIds,
    });
    const mock = resolveCodexMockAppServerOverride();
    const sandbox =
      request.permissionPreset === 'dangerous_all'
        ? ('danger-full-access' as const)
        : request.permissionPreset === 'none'
          ? ('workspace-write' as const)
          : ('read-only' as const);
    // Global Instructions (Instructions settings), pipelines section: resolved from
    // the step environment when the launcher provides the serialized config.
    const globalInstructionsBlock = request.resumeSessionId
      ? ''
      : buildPipelineGlobalInstructionsBlock(
          getBrandEnv(
            request.environment,
            'PREF_GLOBAL_INSTRUCTIONS_PIPELINES',
          ),
          { harness: failureProvider, model: request.model ?? '' },
        );
    const developerInstructions = buildCodexSystemPrompt(
      globalInstructionsBlock || undefined,
      request.permissionPreset,
    );
    const baseThreadConfig = buildCodexPipelineThreadConfig(
      request.environment,
      {
        ...(request.harnessInvocation?.codexConfig ?? {}),
        ...(Object.keys(mcpServers).length > 0
          ? { mcp_servers: mcpServers }
          : {}),
      },
    );
    // Merged last so the pipeline base config cannot drop the native-memory
    // suppression applied while local memory is enabled (CAN-1969). The
    // headless CLI has no preferences store: desktop-launched executions
    // carry the opt-in preference through the branded
    // `PREF_LOCAL_MEMORY_ENABLED` execution environment variable, and
    // CLI-native executions treat local memory as OFF (the opt-in global
    // default), leaving Codex-native memories on their canonical defaults.
    const nativeMemoryConfig = codexNativeMemoryThreadConfig(
      localMemoryEnabledFromEnv(request.environment),
    );
    const threadConfig = { ...baseThreadConfig, ...nativeMemoryConfig };
    const common = {
      cwd: request.cwd,
      approvalPolicy: 'never' as const,
      sandbox,
      serviceTier: request.fastMode ? 'priority' : 'default',
      ...(request.model
        ? {
            model: request.harnessInvocation?.runtimeModel ?? request.model,
          }
        : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
      config: threadConfig,
    };
    const profile = {
      environment: {
        ...request.environment,
        ...(request.harnessInvocation?.envOverride ?? {}),
        ...(mock?.env ?? {}),
      },
      configArgs: mock?.configArgs ?? [],
      logicalWorkspaceEnvironmentId: `pipeline:${request.projectId ?? 'default'}`,
      ...(mock ? { mockProviderId: 'canopy-e2e' } : {}),
    };
    handle = request.resumeSessionId
      ? await service.resumeThread({
          params: { threadId: request.resumeSessionId, ...common },
          capabilitySnapshotId: snapshotId,
          capabilityLeaseKind: 'persisted-helper',
          profile,
        })
      : await service.startThread({
          params: {
            ...common,
            selectedCapabilityRoots: roots,
            experimentalRawEvents: false,
          },
          capabilitySnapshotId: snapshotId,
          capabilityLeaseKind: 'persisted-helper',
          profile,
        });
    pushTranscriptLine(
      JSON.stringify({ type: 'thread.started', thread_id: handle.threadId }),
    );
    const rootThreadId = handle.threadId;
    const maxAttempts = request.schema
      ? CODEX_STRUCTURED_OUTPUT_RETRY_ATTEMPTS + 1
      : 1;
    let prompt = appendCodexSchemaInstruction(
      buildCodexPrompt(request.prompt, request.systemPrompt),
      request.schema,
    );
    let lastError: Error | undefined;
    // ONE deadline for the whole step — see the identical comment in the
    // Electron runner (`apps/desktop-app/src/main/pipelines/execution-runtime.ts`)
    // and the Cursor runner.
    const deadline = Date.now() + request.totalTimeoutMs;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const remainingTimeoutMs = deadline - Date.now();
      if (remainingTimeoutMs <= 0) {
        // Report the timeout, not the previous attempt's schema-validation
        // error. Preferring `lastError` explained a step that genuinely
        // exhausted its wall clock as a content problem, and gave the same
        // declared `timeout_minutes` two different user-facing explanations on
        // Codex and Cursor. The last error is
        // still visible in the step's own attempt logs, so nothing is lost by
        // reporting the reason the step actually ended.
        throw new Error(stepTimedOutMessage(request.totalTimeoutMs));
      }
      const outcome = await handle.runTurn({
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        ...getCliCodexTurnTimeoutOptions(),
        totalTimeoutMs: remainingTimeoutMs,
        ...(request.schema ? { outputSchema: request.schema } : {}),
        ...(request.thinkingLevel && request.model
          ? {
              effort: mapThinkingToReasoningEffort(
                request.thinkingLevel,
                request.model,
              ),
            }
          : {}),
        signal: request.signal,
        mcpElicitationPolicy: createHeadlessMcpElicitationPolicy({
          allowedServers: Object.keys(mcpServers),
          allowExternalMutation: request.permissionPreset === 'dangerous_all',
        }),
        onEvent: (event) => {
          // Subagent threads registered against this handle also report token
          // usage here; only the root thread's usage belongs in the canonical
          // transcript that drives audit counters and the context meter.
          if (isForeignThreadTokenUsageEvent(event, rootThreadId)) {
            return;
          }
          const projected = projectCodexRuntimeEvent(event);
          transcriptEvents.push(projected);
          pushTranscriptLine(JSON.stringify(projected));
        },
      });
      try {
        if (outcome.status !== 'completed') {
          throw new Error(outcome.error ?? `Codex turn ${outcome.status}`);
        }
        const structured = request.schema
          ? parseStructuredResponseText(outcome.finalText)
          : undefined;
        return {
          status: 'success',
          sessionId: handle.threadId,
          rawText: outcome.finalText,
          ...(structured !== undefined ? { structured } : {}),
          transcript: `${transcript.join('\n')}\n`,
          ...(outcome.proposedPlanText
            ? { proposedPlan: outcome.proposedPlanText }
            : {}),
          usage: outcome.usage,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (
          request.schema &&
          attempt < maxAttempts &&
          isRetryableCodexStructuredOutputError(lastError)
        ) {
          prompt = buildCodexStructuredOutputRetryPrompt(
            request.schema,
            lastError.message,
          );
          continue;
        }
        throw lastError;
      }
    }
    throw lastError ?? new Error('Codex workflow turn failed');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const classification = classifyAgentFailure({
      provider: failureProvider,
      accountScope: failureProvider === 'ollama' ? 'local' : 'native',
      model: request.model,
      events: transcriptEvents,
      error,
    });
    return {
      status: request.signal?.aborted ? 'cancelled' : 'failure',
      transcript: `${transcript.join('\n')}\n`,
      failure: {
        version: 1,
        provider: failureProvider,
        agent_harness: 'codex',
        ...(handle ? { session_id: handle.threadId } : {}),
        had_agent_activity:
          codexTranscriptEventsHaveAgentActivity(transcriptEvents),
        ...(classification ? { classification } : {}),
        message,
      },
    };
  } finally {
    await handle?.unsubscribe().catch(() => {});
    await service.revokeStdioMcpRoutes(mcpOwnerId);
    cliHttpMcpProxyService?.revokeOwner(mcpOwnerId);
  }
}

const CLI_CURSOR_CONNECT_MESSAGE =
  'Connect Cursor in the desktop app first; the CLI reuses that installation.';

const CLI_CURSOR_VERIFY_MESSAGE =
  'Cursor runtime verification failed. Reconnect Cursor in the desktop app to restore it; the CLI reuses that installation.';

// The CLI never downloads the Cursor runtime. It reuses the desktop's
// installation and verifies the whole tree against the pinned digest before
// running anything from it, as the desktop does before every launch.
async function runCliCursorPrompt(
  request: CursorPromptRunnerRequest,
  cursorHost?: CliRuntimeDependencies['cursorHost'],
  cursorRuntimeDigest?: string,
): Promise<CursorPromptRunnerResult> {
  // Same contract as the desktop runner: the budget starts at the TRUE entry,
  // so the install probe and preference read below are charged to the step.
  const budgetStartedAt = request.budgetStartedAt ?? Date.now();
  // Same enforcement as the desktop runner: the install probe and the
  // preference read are filesystem work with no deadline of their own, so a
  // cancelled or expired caller must stop waiting for them rather than
  // discovering afterwards that it should have.
  const withdrawal = createSetupWithdrawal(
    request.signal ?? new AbortController().signal,
    budgetStartedAt + request.totalTimeoutMs - Date.now(),
  );
  const withdrawnResult = (): CursorPromptRunnerResult =>
    withdrawal.reason === 'cancelled'
      ? {
          status: 'cancelled',
          transcript: '',
          failure: {
            version: 1,
            provider: 'cursor',
            agent_harness: 'cursor',
            had_agent_activity: false,
            message: 'Cursor workflow turn was cancelled.',
          },
        }
      : {
          status: 'failure',
          transcript: '',
          failure: {
            version: 1,
            provider: 'cursor',
            agent_harness: 'cursor',
            had_agent_activity: false,
            message: stepTimedOutMessage(request.totalTimeoutMs),
          },
        };
  // One owner for the withdrawal's timer and listeners: every exit below —
  // including a rejected install probe, preference read or dynamic import, and
  // the `resolveCursorLaunch` catch, which all previously returned or threw
  // past the release — goes through this `finally`.
  try {
    return await runCliCursorPromptInner();
  } finally {
    withdrawal.release();
  }

  async function runCliCursorPromptInner(): Promise<CursorPromptRunnerResult> {
    if (withdrawal.withdrawn) return withdrawnResult();
    const target = getCursorRuntimeTargetForHost(
      cursorHost?.platform,
      cursorHost?.arch,
    );
    const state = await withdrawal.race(cursorRuntimeInstalled(cursorHost));
    if (state === SETUP_WITHDRAWN) return withdrawnResult();
    const cursorEnabled = await withdrawal.race(
      readCliCursorEnabledPreference(),
    );
    if (cursorEnabled === SETUP_WITHDRAWN) return withdrawnResult();
    if (!target || !state.supported || !state.installed || !cursorEnabled) {
      return {
        status: 'failure',
        transcript: '',
        failure: {
          version: 1,
          provider: 'cursor',
          agent_harness: 'cursor',
          had_agent_activity: false,
          message: !target
            ? 'Cursor is not available on this device.'
            : CLI_CURSOR_CONNECT_MESSAGE,
        },
      };
    }
    // Verified before anything in the tree runs: the vendor runtime, and the
    // approval hook's Node runtime, which lives in the same tree.
    const expectedDigest =
      cursorRuntimeDigest ??
      getCursorRuntimeArtifact(cursorHost?.platform, cursorHost?.arch)
        ?.filesSha256;
    const digest = await withdrawal.race(
      fingerprintCursorRuntime(
        path.join(getCursorRuntimeRootDir(), CURSOR_RUNTIME_VERSION),
        target.executables,
        withdrawal.signal,
      ).catch(() => undefined),
    );
    if (digest === SETUP_WITHDRAWN) return withdrawnResult();
    if (!expectedDigest || digest !== expectedDigest)
      return {
        status: 'failure',
        transcript: '',
        failure: {
          version: 1,
          provider: 'cursor',
          agent_harness: 'cursor',
          had_agent_activity: false,
          message: CLI_CURSOR_VERIFY_MESSAGE,
        },
      };
    // Keep the ESM-only ACP SDK chain out of consumers that only construct the
    // CLI runtime. Jest and the packaged CommonJS entry points load this module
    // eagerly, while Cursor execution is the only path that needs the driver.
    const { runCursorPromptWithDriver } =
      await import('./cursor-prompt-runner');
    // Same contract as the desktop runner: resolution failing after the presence
    // gate must still produce a structured Cursor failure rather than an
    // exception the generic step catch stringifies unredacted.
    let launch;
    try {
      launch = resolveCursorLaunch(
        getCursorRuntimeRootDir(),
        CURSOR_RUNTIME_VERSION,
        target,
      );
    } catch (error) {
      return {
        status: 'failure',
        transcript: '',
        failure: {
          version: 1,
          provider: 'cursor',
          agent_harness: 'cursor',
          had_agent_activity: false,
          message: `${CLI_CURSOR_CONNECT_MESSAGE} ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
    return runCursorPromptWithDriver(
      { ...request, budgetStartedAt },
      {
        launch,
        target,
        spawner: spawnProviderProcessDirect,
        baseEnvironment: getEnhancedEnv({
          includeCanopySecrets: false,
          environment: false,
        }),
        reinstallGuidance:
          'Reconnect Cursor in the desktop app to reinstall it; the CLI reuses that installation.',
      },
    );
  }
}

function findActionsRoot(startPath: string | undefined): string | null {
  if (!startPath) {
    return null;
  }

  let current = path.resolve(startPath);
  if (fs.existsSync(current) && fs.statSync(current).isFile()) {
    current = path.dirname(current);
  }

  while (true) {
    const packageJson = path.join(current, 'package.json');
    const workspaceActionsDir = path.join(
      current,
      'packages',
      'desktop-shared',
      'resources',
      'actions',
    );
    if (fs.existsSync(packageJson) && fs.existsSync(workspaceActionsDir)) {
      return workspaceActionsDir;
    }

    const packageActionsDir = path.join(current, 'resources', 'actions');
    if (fs.existsSync(packageJson) && fs.existsSync(packageActionsDir)) {
      return packageActionsDir;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function createCliExecutionRuntime(
  args: CliRuntimeArgs,
  dependencies: CliRuntimeDependencies = {},
): ExecutionRuntime {
  const embeddedRoot = extractEmbeddedResources();

  const bundledActionsDir =
    args.bundledActionsDir ??
    (embeddedRoot ? path.join(embeddedRoot, 'actions') : null) ??
    findActionsRoot(args.pipelinePath) ??
    findActionsRoot(args.cwd) ??
    path.resolve(
      process.cwd(),
      'packages',
      'desktop-shared',
      'resources',
      'actions',
    );

  const defaultExecutionsDir = path.join(
    getCanopyDataDir(),
    'pipeline-executions',
  );
  const executionsDir = args.executionsDir ?? defaultExecutionsDir;
  const tempRootDir = path.join(executionsDir, '.tmp');

  return {
    pipelineHostActions: args.pipelineHostActions,
    bundledActionsDir,
    executionsDir,
    getProjectActionsDir,
    getProjectActionsDirCandidates,
    getProjectPipelinesDir,
    getProjectPipelinesDirCandidates,
    tempRootDir,
    // Enforce the org model policy when the host can supply it; otherwise fall
    // back to the explicitly documented CLI exemption above.
    isModelBlockedByOrgPolicy:
      args.isModelBlockedByOrgPolicy ?? cliOrgModelPolicyFallback,
    isOrgModelPolicyActive:
      args.isOrgModelPolicyActive ?? cliOrgModelPolicyActiveFallback,
    codexPromptRunner: { runCodexPrompt: runCliCodexPrompt },
    cursorPromptRunner: {
      runCursorPrompt: (request) =>
        runCliCursorPrompt(
          request,
          dependencies.cursorHost,
          dependencies.cursorRuntimeDigest,
        ),
    },
    copilotPromptRunner: {
      runCopilotPrompt: async (request): Promise<CopilotPromptRunnerResult> => {
        if (!args.copilotHost)
          return {
            status: 'failure',
            transcript: '',
            failure: {
              version: 1,
              provider: 'copilot',
              agent_harness: 'copilot',
              had_agent_activity: false,
              message:
                'Copilot requires a connected desktop execution host with the rollout enabled.',
            },
          };
        const { runCopilotPipelinePrompt } =
          await import('./copilot-prompt-runner');
        return runCopilotPipelinePrompt(request, args.copilotHost);
      },
    },
    opencodePromptRunner: {
      runOpenCodePrompt: async (
        request,
      ): Promise<OpenCodePromptRunnerResult> => {
        if (!args.opencodeHost)
          return {
            status: 'failure',
            transcript: '',
            failure: {
              version: 1,
              provider: 'opencode',
              agent_harness: 'opencode',
              had_agent_activity: false,
              message: 'OpenCode requires a connected desktop execution host.',
            },
          };
        const { runOpenCodePipelinePrompt } =
          await import('./opencode-prompt-runner');
        return runOpenCodePipelinePrompt(request, args.opencodeHost);
      },
    },
    resolvePipelineTarget,
    resolveModelHarnessInvocation(
      model,
      options,
    ): Promise<ModelHarnessInvocation> {
      const runtimeModel = model ?? '';
      const source = model ? getModelSource(model) : 'claude-managed';
      if (model && (source === 'ai-gateway' || isGatewayOnlyModel(model))) {
        throw new Error(
          `Model "${model}" requires AI Credits routing, which is unsupported by the CLI runtime.`,
        );
      }
      const harness =
        options?.harness ??
        (model
          ? (getExecutionHarnessForModel(model) ??
            (isOllamaModel(model) ? DEFAULT_OLLAMA_HARNESS : undefined))
          : 'claude');
      if (source === 'opencode-managed' || harness === 'opencode') {
        return Promise.resolve({
          source: 'opencode-managed',
          harness: 'opencode',
          runtimeModel,
          aiCreditsRouted: false,
        });
      }
      if (source === 'copilot-managed' || harness === 'copilot') {
        return Promise.resolve({
          source: 'copilot-managed',
          harness: 'copilot',
          runtimeModel,
          aiCreditsRouted: false,
        });
      }
      if (source === 'cursor-managed' || harness === 'cursor') {
        return Promise.resolve({
          source: 'cursor-managed',
          harness: 'cursor',
          runtimeModel,
          aiCreditsRouted: false,
        });
      }
      if (model && isOllamaModel(model) && harness) {
        return resolveCliOllamaInvocation(model, harness);
      }
      if (!source || !harness) {
        throw new Error(`Unknown model "${model ?? ''}".`);
      }
      return Promise.resolve({
        source,
        harness,
        runtimeModel,
        aiCreditsRouted: false,
      });
    },
  };
}

async function resolvePipelineTarget(
  request: ResolvePipelineTargetRequest,
): Promise<ResolvePipelineTargetResult> {
  if (request.requested.scope !== 'worktree') {
    throw new Error(
      `CLI runtime can only resolve worktree targets, received "${request.requested.scope}"`,
    );
  }

  const target = request.requested;
  const workspaceId = target.workspace_id;
  const worktreeId = target.worktree.id;
  const record = await getWorktreeCliRecord(workspaceId, worktreeId);
  return {
    cwd: record.path,
    scope: 'worktree',
    target: {
      scope: 'worktree',
      workspace_id: workspaceId,
      worktree_id: record.id,
      path: record.path,
      created: false,
    },
    projectId: workspaceId,
    worktreeId: record.id,
    repoPath: record.path,
  };
}
