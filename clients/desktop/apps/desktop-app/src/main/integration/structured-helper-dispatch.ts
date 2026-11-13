import { assertHelperWorkerContext } from '../helper-runs/helper-worker-context';
import { BRAND } from '@canopy/brand/current';
import {
  getExecutionHarnessForModel,
  type ModelHarness,
} from '@canopy/desktop-shared/types';
import type { SettingSource } from '@anthropic-ai/claude-agent-sdk';
import type { AgentAuditLinkTarget } from '@canopy/desktop-shared/types';
import type {
  ClaudeStructuredHelperQueryOptions,
  CodexStructuredHelperRunner,
  CodexStructuredHelperQueryOptions,
  StructuredHelperQueryResult,
} from '@canopy/desktop-shared/lib/structured-helper-query';
import {
  runClaudeStructuredHelperQuery,
  StructuredHelperQueryError,
} from '@canopy/desktop-shared/lib/structured-helper-query';
import { parseStructuredJsonResult } from '@canopy/desktop-shared/lib/claude-structured-output';
import {
  makeCodexStrictJsonSchema,
  normalizeCodexStructuredOutput,
} from '@canopy/desktop-shared/lib/codex-structured-output';
import {
  emptyHelperAgentPluginRuntime,
  type HelperAgentPluginRuntime,
} from '@canopy/desktop-shared/lib/helper-agent-plugins';
import type { HelperUsage } from '@canopy/execution-engine/lib/helper-usage';
import { readPreferencesFile } from '../lib/preferences-store';
import {
  getClaudeWorkerSessionService,
  type ClaudeWorkerRunResult,
} from './claude-worker-session-service';
import type { ClaudeTerminalPermission } from './claude-terminal-settings';
import { READ_ONLY_TOOLS } from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';
import { getEffectiveClaudeWorkerModePreferences } from '../lib/claude-tui-workers';
import { codexRuntimeForWorkerRun } from '../codex/runtime-service';
import { isJsonValue } from '@canopy/execution-engine/node/codex-runtime';
import { resolveCodexMockAppServerOverride } from '@canopy/execution-engine/node/e2e-mock-env';
import { createHash } from 'node:crypto';
import {
  codexServiceTierForModelConfig,
  mapThinkingToReasoningEffort,
  type CodexConfig,
  type CodexConfigValue,
} from '@canopy/execution-engine/lib/codex-model-config';
import { prepareCodexReportOnlyThread } from './codex-report-only';
import { codexNativeMemoryThreadConfig } from '@canopy/execution-engine/node/lib/native-memory';
import { resolveCodexRuntimeEnvironmentProfile } from '../lib/user-environment-runtime';
import type { ThreadStartParams } from '@canopy/execution-engine/node/codex-runtime/generated/v2/ThreadStartParams';
import {
  runWithTransientAgentRetry,
  AGENT_TRANSIENT_RETRY_CONTINUE_PROMPT,
} from '@canopy/execution-engine/agent-failures';
import type {
  CodexSpawnProfileRequest,
  CodexThreadHandle,
} from '@canopy/execution-engine/node/codex-runtime';
import { spawnClaudeCodeProcessOffMain } from '../agents/claude-process-host-runner';
import {
  DEFAULT_CODEX_SPEED,
  readCodexSpeedRecord,
} from '@canopy/execution-engine/lib/codex-speed';
import {
  admitCodexSpeed,
  reportCodexSpeedTurnFailure,
  type CodexSpeedAdmission,
  type CodexSpeedRouteEvidence,
} from '../codex/speed-policy';

export interface StructuredHelperDispatchOptions<
  T,
> extends ClaudeStructuredHelperQueryOptions<T> {
  kind: string;
  label: string;
  timeoutMs?: number;
  permission?: ClaudeTerminalPermission;
  settingSources?: SettingSource[];
  linkTarget?: AgentAuditLinkTarget;
  projectId?: string;
  worktreeId?: string;
  chatId?: string;
  executionHarness?: ModelHarness;
  /** Local terminal-worker validation only; generation still uses schema. */
  resultValidationSchema?: Record<string, unknown>;
  onResultRejected?: (payload: unknown) => void;
}

function reportToolAllowName(): string {
  return `mcp__${BRAND.tools.namespace}__ReportStructuredResult`;
}

interface CodexStructuredHelperRetryState {
  handle?: CodexThreadHandle;
}

function codexConfigRecordValue(
  value: CodexConfigValue | undefined,
): CodexConfig | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : null;
}

/**
 * Trusted route facts of a structured Codex helper run, taken from the same
 * resolution the attempt applies: the model sent to Codex, the caller's
 * thread-level provider config (AI Credits / Ollama routing arrives here),
 * the Canopy Environments overlay, and the E2E mock provider.
 */
function structuredHelperCodexSpeedEvidence<T>(
  options: Omit<CodexStructuredHelperQueryOptions<T>, 'runner'>,
): CodexSpeedRouteEvidence {
  const workspaceEnvironment = resolveCodexRuntimeEnvironmentProfile({
    runtime: 'agent',
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
  });
  return {
    selectedModel: options.model,
    runtimeModel: options.model,
    harness: 'codex',
    codexConfig: options.codexConfigOverride ?? null,
    environment: workspaceEnvironment.environment,
    mockProvider: resolveCodexMockAppServerOverride() !== undefined,
  };
}

async function runCodexStructuredHelperAttempt<T>(
  options: Omit<CodexStructuredHelperQueryOptions<T>, 'runner'>,
  captureEvent: (event: unknown) => void,
  retryState: CodexStructuredHelperRetryState,
  admission: CodexSpeedAdmission,
): Promise<StructuredHelperQueryResult<T>> {
  if (!isJsonValue(options.schema)) {
    throw new StructuredHelperQueryError(
      'Codex structured helper schema is not JSON-serializable',
      {},
    );
  }
  const outputSchema = makeCodexStrictJsonSchema(options.schema);
  if (!isJsonValue(outputSchema)) {
    throw new StructuredHelperQueryError(
      'Codex strict structured helper schema is not JSON-serializable',
      {},
    );
  }
  const pluginRuntime =
    options.pluginRuntime ?? emptyHelperAgentPluginRuntime();
  const reportOnly = options.permissionMode === 'report-only';
  const configuredMcpServers =
    codexConfigRecordValue(options.codexConfigOverride?.mcp_servers) ?? {};
  const mcpServers = reportOnly
    ? {}
    : {
        ...pluginRuntime.codexMcpServers,
        ...configuredMcpServers,
      };
  const roots = reportOnly ? [] : (pluginRuntime.codexCapabilityRoots ?? []);
  const snapshotId = createHash('sha256')
    .update(
      JSON.stringify({
        roots: roots.map((root) => root.id),
        mcpServers,
        dynamicTools: [],
      }),
    )
    .digest('hex');
  const mock = resolveCodexMockAppServerOverride();
  const workspaceEnvironment = resolveCodexRuntimeEnvironmentProfile({
    runtime: 'agent',
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
  });
  const runtimeProfile = {
    environment: {
      ...workspaceEnvironment.environment,
      ...(mock?.env ?? {}),
    },
    configArgs: mock?.configArgs ?? [],
    logicalWorkspaceEnvironmentId:
      workspaceEnvironment.logicalWorkspaceEnvironmentId,
    ...(workspaceEnvironment.secretVersionFingerprint
      ? {
          secretVersionFingerprint:
            workspaceEnvironment.secretVersionFingerprint,
        }
      : {}),
    ...(mock ? { mockProviderId: 'canopy-e2e' as const } : {}),
  } satisfies CodexSpawnProfileRequest;
  const runtime = codexRuntimeForWorkerRun('codexStructuredHelper');
  const events: unknown[] = [];
  let eventsFlushed = false;
  const flushEvents = async (): Promise<void> => {
    if (eventsFlushed) return;
    eventsFlushed = true;
    for (const event of events) {
      captureEvent(event);
      await options.transcriptObserver?.appendEvent(event);
    }
  };
  const config: NonNullable<ThreadStartParams['config']> = {
    service_tier: codexServiceTierForModelConfig(options.modelConfig),
    ...(options.codexConfigOverride ?? {}),
    // Re-emit the validated merge result even when it is empty so malformed
    // caller overrides cannot survive the spread above and clobber the reset.
    mcp_servers: mcpServers,
    // Merged last so no override spread can drop the native-memory
    // suppression applied while local memory is enabled (CAN-1969).
    ...codexNativeMemoryThreadConfig(options.localMemoryEnabled),
  };
  const reportOnlyParams = reportOnly
    ? await prepareCodexReportOnlyThread(
        options.repoPath,
        config,
        runtimeProfile,
      )
    : undefined;
  try {
    const continuing = retryState.handle !== undefined;
    const handle =
      retryState.handle ??
      (await runtime.startThread({
        params: {
          cwd: options.repoPath,
          model: options.model,
          approvalPolicy: 'never',
          ...(reportOnlyParams ? {} : { sandbox: 'read-only' as const }),
          developerInstructions: options.systemPrompt,
          selectedCapabilityRoots: roots,
          config,
          ...reportOnlyParams,
          experimentalRawEvents: false,
          ephemeral: true,
        },
        capabilitySnapshotId: snapshotId,
        capabilityLeaseKind: 'ephemeral',
        capabilityLeaseExpiresAt: new Date(
          Date.now() + 60 * 60_000,
        ).toISOString(),
        profile: runtimeProfile,
      }));
    retryState.handle = handle;
    await options.transcriptObserver?.markSessionId?.(handle.threadId);
    const outcome = await handle.runTurn({
      input: [
        {
          type: 'text',
          text: continuing
            ? AGENT_TRANSIENT_RETRY_CONTINUE_PROMPT
            : options.combinedPrompt,
          text_elements: [],
        },
      ],
      ...(options.thinkingLevel
        ? {
            effort: mapThinkingToReasoningEffort(
              options.thinkingLevel,
              options.model,
            ),
          }
        : {}),
      outputSchema,
      signal: options.abortController?.signal,
      onEvent: (event) => {
        events.push(event);
      },
    });
    await flushEvents();
    const usage = {
      ...outcome.usage,
      messageCount: 1,
      assistantMessageCount: outcome.finalText ? 1 : 0,
    };
    if (outcome.status !== 'completed') {
      reportCodexSpeedTurnFailure(admission, options.model, {
        codexErrorInfo: outcome.errorInfo,
        message: outcome.error,
      });
      throw new StructuredHelperQueryError(
        outcome.error ?? `Codex helper ${outcome.status}`,
        usage,
      );
    }
    const parsed = parseStructuredJsonResult(outcome.finalText);
    const normalized = normalizeCodexStructuredOutput(parsed, options.schema);
    const value: T | null = options.isResult(normalized) ? normalized : null;
    return {
      value,
      usage,
    };
  } catch (error) {
    await flushEvents();
    throw error;
  }
}

export const codexStructuredHelperRunner: CodexStructuredHelperRunner = {
  async run<T>(
    options: Omit<CodexStructuredHelperQueryOptions<T>, 'runner'>,
  ): Promise<StructuredHelperQueryResult<T>> {
    assertHelperWorkerContext('codexStructuredHelperRunner.run');
    // Admit the exact requested speed before any effect: no attempt marker,
    // config read, thread, or turn happens for a speed this route cannot run.
    // A rejection surfaces through the caller's existing helper failure path;
    // nothing here substitutes another speed.
    const admission = await admitCodexSpeed(
      readCodexSpeedRecord(options.modelConfig) ?? DEFAULT_CODEX_SPEED,
      structuredHelperCodexSpeedEvidence(options),
    );
    const retryState: CodexStructuredHelperRetryState = {};
    await options.transcriptObserver?.markAttempt?.(1);
    try {
      return await runWithTransientAgentRetry({
        waitForQuotaRecovery: options.waitForQuotaRecovery,
        provider: 'codex',
        model: options.model,
        signal: options.abortController?.signal,
        runAttempt: (captureEvent) =>
          runCodexStructuredHelperAttempt(
            options,
            captureEvent,
            retryState,
            admission,
          ),
        onRetry: async (notice) => {
          await options.onTransientRetry?.(notice);
          await options.transcriptObserver?.markAttempt?.(notice.nextAttempt);
        },
      });
    } finally {
      await retryState.handle?.delete().catch(() => undefined);
    }
  },
};

/**
 * Report-only posture: no built-in tools at all (the agent reasons over the
 * prompt and reports). The Canopy hook governs selected MCP tools while
 * `tools: []` keeps built-in mutation unavailable.
 */
export function structuredHelperReportOnlyPermission(): ClaudeTerminalPermission {
  return {
    tools: [],
    allowedTools: [reportToolAllowName()],
  };
}

/**
 * Read-only posture: the read-only built-ins (Read/Glob/Grep/NotebookRead) plus
 * the report tool, mirroring the `agent-prompt` SDK `read_only` preset. Mutation
 * is impossible by construction (no Edit/Write/Bash). The Canopy hook governs
 * any selected MCP tools without granting the worker dangerous permission skip.
 */
export function structuredHelperReadOnlyPermission(): ClaudeTerminalPermission {
  return {
    tools: [...READ_ONLY_TOOLS],
    allowedTools: [...READ_ONLY_TOOLS, reportToolAllowName()],
  };
}

function hasLocalClaudeRuntime(runtime: HelperAgentPluginRuntime): boolean {
  return runtime.claudePlugins.length > 0;
}

function usageFromWorker<T>(result: ClaudeWorkerRunResult<T>): HelperUsage {
  return result.usage;
}

function workerFailureMessage<T>(result: ClaudeWorkerRunResult<T>): string {
  switch (result.status) {
    case 'cancelled':
      return 'Claude worker was cancelled.';
    case 'interrupted':
      return 'Claude worker exited before completion.';
    case 'failure': {
      const detail = result.finalText.trim();
      return detail.length > 0 ? detail : 'Claude worker failed.';
    }
    default:
      return `Claude worker ended with status ${result.status}.`;
  }
}

async function appendWorkerTranscriptJsonl(
  transcriptJsonl: string,
  appendEvent: (event: unknown) => void | Promise<void>,
  captureEvent: (event: unknown) => void,
): Promise<void> {
  const lines = transcriptJsonl.split('\n').filter(Boolean);
  for (const line of lines) {
    const event = JSON.parse(line) as unknown;
    captureEvent(event);
    await appendEvent(event);
  }
}

export async function runStructuredHelper<T>(
  options: StructuredHelperDispatchOptions<T>,
): Promise<StructuredHelperQueryResult<T>> {
  assertHelperWorkerContext('runStructuredHelper');
  const preferences = await readPreferencesFile().catch(() => null);
  const effectivePreferences = preferences
    ? getEffectiveClaudeWorkerModePreferences(preferences)
    : null;
  const pluginRuntime =
    options.pluginRuntime ?? emptyHelperAgentPluginRuntime();
  const shouldUseWorker =
    effectivePreferences?.canopyBackgroundProcessesMode === 'terminal' &&
    (options.executionHarness ?? getExecutionHarnessForModel(options.model)) ===
      'claude' &&
    !hasLocalClaudeRuntime(pluginRuntime);

  if (!shouldUseWorker) {
    return runClaudeStructuredHelperQuery({
      ...options,
      spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
      tools: options.permission?.tools,
      allowedTools: options.permission?.allowedTools,
      disallowedTools: options.permission?.disallowedTools,
      settingSources: options.settingSources,
    });
  }

  const abortSignal = options.abortController?.signal;
  let resumeSessionId: string | undefined;
  await options.transcriptObserver?.markAttempt?.(1);
  return runWithTransientAgentRetry({
    waitForQuotaRecovery: options.waitForQuotaRecovery,
    provider: 'claude',
    model: options.model,
    signal: abortSignal,
    runAttempt: async (captureEvent) => {
      const workerService = getClaudeWorkerSessionService();
      let workerId: string | undefined;
      const cancelWorker = (): void => {
        if (workerId) {
          void workerService.cancel(workerId);
        }
      };
      const captureWorkerId = (id: string): void => {
        workerId = id;
        if (abortSignal?.aborted) {
          // Avoid settling the worker re-entrantly from its lifecycle callback
          // while the worker service is still finishing that transition.
          queueMicrotask(cancelWorker);
        }
      };
      abortSignal?.addEventListener('abort', cancelWorker, { once: true });

      let result: ClaudeWorkerRunResult<T>;
      try {
        result = await workerService.runWorker<T>({
          kind: options.kind,
          label: options.label,
          cwd: options.repoPath,
          systemPrompt: options.systemPrompt,
          prompt: resumeSessionId
            ? AGENT_TRANSIENT_RETRY_CONTINUE_PROMPT
            : options.userMessage,
          schema: options.schema,
          resultValidationSchema: options.resultValidationSchema,
          onResultRejected: options.onResultRejected,
          isResult: options.isResult,
          model: options.model,
          thinkingLevel: options.thinkingLevel,
          permission:
            options.permission ?? structuredHelperReadOnlyPermission(),
          // Terminal workers cannot answer prompts. Auto permits safe
          // workspace writes while failing closed for credentialed MCP tools
          // that the built-in helper preset cannot constrain.
          approvalMode: 'auto',
          settingSources: options.settingSources ?? [
            'user',
            'project',
            'local',
          ],
          maxTurns: options.maxTurns,
          mcpServers: pluginRuntime.claudeMcpServers,
          claudeEnvOverride: options.claudeEnvOverride,
          projectId: options.projectId ?? options.workspaceId,
          worktreeId: options.worktreeId,
          chatId: options.chatId,
          linkTarget: options.linkTarget,
          timeoutMs: options.timeoutMs,
          ...(resumeSessionId ? { resumeSessionId } : {}),
          onCreated: captureWorkerId,
          onStarted: captureWorkerId,
          onQueued: captureWorkerId,
        });
      } finally {
        abortSignal?.removeEventListener('abort', cancelWorker);
      }

      await options.transcriptObserver?.markChatMode?.('terminal');
      if (result.transcriptJsonl.trim().length > 0) {
        await appendWorkerTranscriptJsonl(
          result.transcriptJsonl,
          options.transcriptObserver?.appendEvent ?? ((): void => undefined),
          captureEvent,
        );
      }
      if (result.sessionStarted) {
        resumeSessionId = result.sessionId;
        await options.transcriptObserver?.markSessionId?.(result.sessionId);
      }

      if (
        options.onResultRejected &&
        result.status === 'failure' &&
        result.invalidOutput &&
        result.error === undefined
      ) {
        return { value: null, usage: usageFromWorker(result) };
      }
      if (result.status !== 'success') {
        throw new StructuredHelperQueryError(
          workerFailureMessage(result),
          usageFromWorker(result),
        );
      }

      return {
        value: options.isResult(result.result) ? result.result : null,
        usage: usageFromWorker(result),
      };
    },
    onRetry: async (notice) => {
      await options.onTransientRetry?.(notice);
      await options.transcriptObserver?.markAttempt?.(notice.nextAttempt);
    },
  });
}

export function createStructuredHelperRunner(args: {
  kind: string;
  label: string;
  provider: 'claude' | 'ollama';
  projectId?: string;
  worktreeId?: string;
  chatId?: string;
  linkTarget?: AgentAuditLinkTarget;
  permission?: ClaudeTerminalPermission;
  settingSources?: SettingSource[];
  executionHarness?: ModelHarness;
}) {
  return <T>(
    options: Omit<ClaudeStructuredHelperQueryOptions<T>, 'provider'>,
  ): Promise<StructuredHelperQueryResult<T>> =>
    runStructuredHelper({
      ...options,
      provider: args.provider,
      kind: args.kind,
      label: args.label,
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      chatId: args.chatId,
      linkTarget: args.linkTarget,
      permission: args.permission,
      settingSources: args.settingSources,
      executionHarness: args.executionHarness,
    });
}

export function runDesktopClaudeStructuredHelperQuery<T>(
  options: ClaudeStructuredHelperQueryOptions<T>,
): Promise<StructuredHelperQueryResult<T>> {
  assertHelperWorkerContext('runDesktopClaudeStructuredHelperQuery');
  return runClaudeStructuredHelperQuery(options);
}
