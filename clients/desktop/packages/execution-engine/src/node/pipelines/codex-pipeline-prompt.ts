import { stepTimedOutMessage } from '@canopy/execution-engine/node/pipelines/step-timeout';
import {
  classifyAgentFailure,
  classifyRetryableCodexTransportFailure,
} from '@canopy/execution-engine/agent-failures';
import {
  classifyCodexTransportError,
  codexTurnOutcomeError,
} from '@canopy/execution-engine/node/codex-runtime/transport-errors';
import {
  codexTranscriptEventsHaveAgentActivity,
  createCodexCapabilitySnapshotIds,
  createHeadlessMcpElicitationPolicy,
  isForeignThreadTokenUsageEvent,
  projectCodexRuntimeEvent,
  type CodexRuntimeEvent,
  type CodexRuntimeService,
} from '@canopy/execution-engine/node/codex-runtime';
import type { CodexHostToolPolicy } from '@canopy/execution-engine/node/codex-runtime/thread-handle';
import type { DynamicToolSpec } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolSpec';
import { resolveCodexMockAppServerOverride } from '@canopy/execution-engine/node/e2e-mock-env';
import {
  appendCodexSchemaInstruction,
  buildCodexPrompt,
  buildCodexStructuredOutputRetryPrompt,
  buildCodexSystemPrompt,
  CODEX_STRUCTURED_OUTPUT_RETRY_ATTEMPTS,
  isRetryableCodexStructuredOutputError,
  parseStructuredResponseText,
} from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';
import {
  mapThinkingToReasoningEffort,
  type CodexConfig,
} from '@canopy/execution-engine/lib/codex-model-config';
import { buildPipelineGlobalInstructionsBlock } from '@canopy/execution-engine/lib/global-instructions';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';
import { buildCodexPipelineThreadConfig } from '@canopy/execution-engine/node/pipelines/codex-preferences';
import {
  codexNativeMemoryThreadConfig,
  localMemoryEnabledFromEnv,
} from '@canopy/execution-engine/node/lib/native-memory';
import type { CodexSelectedCapabilityRoot } from '@canopy/execution-engine/execution-types';
import type {
  CodexPromptRunnerRequest,
  CodexPromptRunnerResult,
  PipelineAiCreditsRoutingOverride,
} from '@canopy/execution-engine/node/pipelines/executor/types';

/*
 * The Codex workflow step runner (CAN-5095 D19), shared by Electron main's
 * in-process runtime and the daemon's pipeline host. Each composition
 * supplies what Electron main used to call directly as ports.
 */

/** A Codex step's Ledger tools (`PipelineLedgerCodexTools` in Electron main). */
export interface CodexPipelineLedgerTools {
  readonly instructions: string;
  readonly specs: DynamicToolSpec[];
  policy(threadId: string): CodexHostToolPolicy;
  dispose(): void;
}

/** What `resolvePlugins` returns that the runner reads. */
export interface CodexPipelinePluginResolution {
  readonly warnings: readonly string[];
  readonly selectedCapabilityRoots: CodexSelectedCapabilityRoot[];
  readonly codexMcpServers: CodexConfig;
}

/** The run's Codex app-server environment (`resolveCodexRuntimeEnvironmentProfile`). */
export interface CodexPipelineEnvironmentProfile {
  readonly environment: Readonly<Record<string, string>>;
  readonly logicalWorkspaceEnvironmentId: string;
  readonly secretVersionFingerprint?: string;
}

/** Where a composition's Codex workflow steps get what Electron main used to supply directly. */
export interface CodexPipelinePromptPorts {
  /** The composition's own Codex runtime; read once per step. */
  runtime(): CodexRuntimeService;
  /** Absent where plugin selections and package overlays cannot resolve. */
  readonly resolvePlugins?: (
    request: CodexPromptRunnerRequest,
    routeSessionId: string,
    runtime: CodexRuntimeService,
  ) => Promise<CodexPipelinePluginResolution>;
  /** MCP HTTP proxy authority ids for the resolved servers. */
  mcpCapabilityAuthorityIds(servers: CodexConfig): string[];
  /**
   * The ids fingerprint v1 named the same servers by, where they differ
   * (CAN-6168); absent when they don't.
   */
  legacyMcpCapabilityAuthorityIds?(servers: CodexConfig): string[];
  /** Routing for a step that carries no harness invocation. */
  resolveRouting(
    model: string,
    routeSessionId: string,
    request: CodexPromptRunnerRequest,
  ): Promise<PipelineAiCreditsRoutingOverride | null>;
  environmentProfile(
    request: CodexPromptRunnerRequest,
  ): Promise<CodexPipelineEnvironmentProfile>;
  openLedgerTools(
    attemptKey: string | undefined,
    cwd: string,
  ): Promise<CodexPipelineLedgerTools | undefined>;
  /** After the step: the MCP proxy and broker routes of its route session. */
  releaseSession(routeSessionId: string): Promise<void>;
}

function requirePlugins(
  ports: CodexPipelinePromptPorts,
): NonNullable<CodexPipelinePromptPorts['resolvePlugins']> {
  const resolve = ports.resolvePlugins;
  if (!resolve) throw new Error('Workflow plugins are not available here.');
  return resolve;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCodexRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function readCodexString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function readCodexFiniteNumber(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function projectCodexSubagentUsageBreakdown(
  value: Record<string, unknown>,
): Record<string, number> {
  const projected: Record<string, number> = {};
  const fields: Array<[string, string]> = [
    ['inputTokens', 'input_tokens'],
    ['cachedInputTokens', 'cached_input_tokens'],
    ['cacheWriteInputTokens', 'cache_write_input_tokens'],
    ['outputTokens', 'output_tokens'],
    ['reasoningOutputTokens', 'reasoning_output_tokens'],
  ];
  for (const [sourceKey, targetKey] of fields) {
    const count = readCodexFiniteNumber(value, sourceKey);
    if (count !== undefined) projected[targetKey] = count;
  }
  return projected;
}

function projectCodexPipelineThreadStartedEvent(
  event: CodexRuntimeEvent,
): Record<string, unknown> {
  const thread = readCodexRecord(event.params.thread);
  if (!thread) return projectCodexRuntimeEvent(event);

  const source = readCodexRecord(thread.source);
  const subAgent =
    readCodexRecord(source?.subAgent) ?? readCodexRecord(source?.subagent);
  const threadSpawn =
    readCodexRecord(subAgent?.thread_spawn) ??
    readCodexRecord(subAgent?.threadSpawn);
  const threadId = readCodexString(thread, 'id');
  const agentNickname =
    readCodexString(thread, 'agentNickname') ??
    readCodexString(thread, 'agent_nickname') ??
    readCodexString(threadSpawn, 'agent_nickname') ??
    readCodexString(threadSpawn, 'agentNickname');
  const agentRole =
    readCodexString(thread, 'agentRole') ??
    readCodexString(thread, 'agent_role') ??
    readCodexString(threadSpawn, 'agent_role') ??
    readCodexString(threadSpawn, 'agentRole');
  const parentThreadId =
    readCodexString(thread, 'parentThreadId') ??
    readCodexString(thread, 'parent_thread_id') ??
    readCodexString(subAgent, 'parentThreadId') ??
    readCodexString(subAgent, 'parent_thread_id') ??
    readCodexString(threadSpawn, 'parentThreadId') ??
    readCodexString(threadSpawn, 'parent_thread_id');
  const model = readCodexString(thread, 'model');
  const reasoningEffort =
    readCodexString(thread, 'reasoningEffort') ??
    readCodexString(thread, 'reasoning_effort');

  return {
    ...event.params,
    type: 'thread.started',
    ...(typeof thread.source !== 'undefined' ? { source: thread.source } : {}),
    ...(threadId ? { thread_id: threadId } : {}),
    ...(agentNickname ? { agent_nickname: agentNickname } : {}),
    ...(agentRole ? { agent_role: agentRole } : {}),
    ...(parentThreadId ? { parent_thread_id: parentThreadId } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
}

function projectCodexPipelineRuntimeEvent(
  event: CodexRuntimeEvent,
  rootThreadId: string,
): Record<string, unknown> | null {
  if (isForeignThreadTokenUsageEvent(event, rootThreadId)) {
    const threadId = readCodexString(event.params, 'threadId');
    const turnId = readCodexString(event.params, 'turnId');
    const tokenUsage = readCodexRecord(event.params.tokenUsage);
    const total = readCodexRecord(tokenUsage?.total);
    const last = readCodexRecord(tokenUsage?.last);
    if (!threadId || !turnId || !total || !last) return null;
    return {
      type: 'thread.subagent_token_usage.updated',
      thread_id: threadId,
      turn_id: turnId,
      total: projectCodexSubagentUsageBreakdown(total),
      last: projectCodexSubagentUsageBreakdown(last),
    };
  }
  if (event.method === 'thread/started') {
    return projectCodexPipelineThreadStartedEvent(event);
  }
  return projectCodexRuntimeEvent(event);
}

export const PIPELINE_AGENT_SESSION_START_TIMEOUT_MS = 10 * 60_000;

function codexSandboxForPermission(
  permission: CodexPromptRunnerRequest['permissionPreset'],
): 'read-only' | 'workspace-write' | 'danger-full-access' {
  if (permission === 'dangerous_all') return 'danger-full-access';
  if (permission === 'none') return 'workspace-write';
  return 'read-only';
}

export async function runCodexPipelinePromptWith(
  request: CodexPromptRunnerRequest,
  ports: CodexPipelinePromptPorts,
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
  const routeSessionId = `pipeline:${request.executionId}:${request.jobId}${request.childId ? `:${request.childId}` : ''}:${request.stepId}:${request.attempt}`;
  let handle:
    | Awaited<ReturnType<CodexRuntimeService['startThread']>>
    | undefined;
  let aiCreditsRouted = false;
  let modelGatewayRouted = false;
  let ledgerCodex: CodexPipelineLedgerTools | undefined;
  const failureProvider =
    request.harnessInvocation?.source === 'ollama' ? 'ollama' : 'codex';
  const failureAccountScope =
    failureProvider === 'ollama'
      ? 'local'
      : request.harnessInvocation?.aiCreditsRouted
        ? 'ai_credits'
        : 'native';
  const service = ports.runtime();
  try {
    const resolved =
      request.pluginSelections || request.packageOverlay
        ? await requirePlugins(ports)(request, routeSessionId, service)
        : undefined;
    for (const warning of resolved?.warnings ?? []) {
      pushTranscriptLine(JSON.stringify({ type: 'warning', message: warning }));
    }
    const roots = resolved?.selectedCapabilityRoots ?? [];
    const mcpServers = resolved?.codexMcpServers ?? {};
    const mcpAuthorityIds = ports.mcpCapabilityAuthorityIds(mcpServers);
    const { snapshotId, legacySnapshotId } = createCodexCapabilitySnapshotIds({
      roots,
      mcpServers,
      mcpAuthorityIds,
      ...(ports.legacyMcpCapabilityAuthorityIds && {
        legacyMcpAuthorityIds:
          ports.legacyMcpCapabilityAuthorityIds(mcpServers),
      }),
    });
    const mockOverride = resolveCodexMockAppServerOverride();
    const aiCredits = request.harnessInvocation
      ? request.harnessInvocation.aiCreditsRouted
        ? {
            model: request.harnessInvocation.runtimeModel,
            env: request.harnessInvocation.envOverride ?? {},
            codexConfig: request.harnessInvocation.codexConfig,
            modelGatewayRouted:
              request.harnessInvocation.modelGatewayRouted === true,
            accountProxyRouted: false,
          }
        : null
      : request.model
        ? await ports.resolveRouting(request.model, routeSessionId, request)
        : null;
    // The account proxy brings its own provider route but bills a proxy
    // account, so a proxy-routed step is not an AI Credits step.
    aiCreditsRouted =
      request.harnessInvocation?.aiCreditsRouted ??
      (aiCredits !== null && !aiCredits.accountProxyRouted);
    modelGatewayRouted =
      request.harnessInvocation?.modelGatewayRouted ??
      aiCredits?.modelGatewayRouted === true;
    const workspaceEnvironment = await ports.environmentProfile(request);
    const profile = {
      environment: {
        ...workspaceEnvironment.environment,
        ...request.environment,
        ...(request.harnessInvocation?.envOverride ?? {}),
        ...(mockOverride?.env ?? {}),
      },
      configArgs: mockOverride?.configArgs ?? [],
      logicalWorkspaceEnvironmentId:
        workspaceEnvironment.logicalWorkspaceEnvironmentId,
      ...(workspaceEnvironment.secretVersionFingerprint
        ? {
            secretVersionFingerprint:
              workspaceEnvironment.secretVersionFingerprint,
          }
        : {}),
      ...(mockOverride ? { mockProviderId: 'canopy-e2e' } : {}),
    };
    // Global Instructions (Instructions settings), pipelines section: resolved from
    // the step environment and carried as developer instructions so the block
    // reaches the thread as a system-prompt addition.
    const globalInstructionsBlock = request.resumeSessionId
      ? ''
      : buildPipelineGlobalInstructionsBlock(
          getBrandEnv(
            request.environment,
            'PREF_GLOBAL_INSTRUCTIONS_PIPELINES',
          ),
          { harness: failureProvider, model: request.model ?? '' },
        );
    // The step's Ledger tools. Dynamic tools are fixed when a thread starts:
    // a new thread gets them with the Ledger block, and a resumed thread
    // keeps whatever it started with, which this attempt's binding serves.
    // The capability snapshot leaves them out, so a resume matches its
    // thread's lease whether or not the thread started with them. Their
    // calls pass an approval session that ends with the step.
    ledgerCodex = await ports.openLedgerTools(
      request.ledgerAttemptKey,
      request.cwd,
    );
    const developerInstructions =
      [
        buildCodexSystemPrompt(
          globalInstructionsBlock || undefined,
          request.permissionPreset,
        ),
        ledgerCodex !== undefined && !request.resumeSessionId
          ? ledgerCodex.instructions
          : undefined,
      ]
        .filter((part): part is string => Boolean(part))
        .join('\n\n') || undefined;
    const threadConfig = buildCodexPipelineThreadConfig(request.environment, {
      ...(request.harnessInvocation?.codexConfig ?? {}),
      ...(aiCredits?.codexConfig ?? {}),
      ...(Object.keys(mcpServers).length > 0
        ? { mcp_servers: mcpServers }
        : {}),
      // Merged last so no override spread can drop the native-memory
      // suppression applied while local memory is enabled (CAN-1969). The
      // preference reaches pipeline steps through the branded
      // `PREF_LOCAL_MEMORY_ENABLED` execution environment variable.
      ...codexNativeMemoryThreadConfig(
        localMemoryEnabledFromEnv(request.environment),
      ),
    });
    const commonParams = {
      cwd: request.cwd,
      approvalPolicy: 'never' as const,
      sandbox: codexSandboxForPermission(request.permissionPreset),
      serviceTier: request.fastMode ? 'priority' : 'default',
      ...(request.model
        ? {
            model:
              aiCredits?.model ??
              request.harnessInvocation?.runtimeModel ??
              request.model,
          }
        : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
      config: threadConfig,
    };
    handle = request.resumeSessionId
      ? await service.resumeThread({
          params: {
            threadId: request.resumeSessionId,
            ...commonParams,
          },
          capabilitySnapshotId: snapshotId,
          legacyCapabilitySnapshotId: legacySnapshotId,
          capabilityLeaseKind: 'persisted-helper',
          profile,
        })
      : await service.startThread({
          params: {
            ...commonParams,
            selectedCapabilityRoots: roots,
            experimentalRawEvents: false,
            ...(ledgerCodex ? { dynamicTools: ledgerCodex.specs } : {}),
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
    // ONE deadline for the whole step. Handing every structured-output
    // retry the full `totalTimeoutMs` again let a step declaring
    // `timeout_minutes: N` spend ~3N minutes in turns before failing. The
    // Cursor runner enforces the same single deadline, so the declared
    // timeout means the same thing on both providers.
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
        ...(request.schema ? { outputSchema: request.schema } : {}),
        ...(request.thinkingLevel && request.model
          ? {
              effort: mapThinkingToReasoningEffort(
                request.thinkingLevel,
                request.model,
                aiCreditsRouted,
              ),
            }
          : {}),
        signal: request.signal,
        startupTimeoutMs: PIPELINE_AGENT_SESSION_START_TIMEOUT_MS,
        totalTimeoutMs: remainingTimeoutMs,
        mcpElicitationPolicy: createHeadlessMcpElicitationPolicy({
          allowedServers: Object.keys(mcpServers),
          allowExternalMutation: request.permissionPreset === 'dangerous_all',
        }),
        ...(ledgerCodex
          ? { hostToolPolicy: ledgerCodex.policy(handle.threadId) }
          : {}),
        onEvent: (event) => {
          const projected = projectCodexPipelineRuntimeEvent(
            event,
            rootThreadId,
          );
          if (!projected) return;
          transcriptEvents.push(projected);
          pushTranscriptLine(JSON.stringify(projected));
        },
      });
      if (outcome.status === 'interrupted') {
        if (request.signal?.aborted) {
          return {
            status: 'cancelled',
            transcript: `${transcript.join('\n')}\n`,
            aiCreditsRouted,
            modelGatewayRouted,
            failure: {
              version: 1,
              provider: failureProvider,
              agent_harness: 'codex',
              session_id: handle.threadId,
              had_agent_activity:
                codexTranscriptEventsHaveAgentActivity(transcriptEvents),
              message: 'Codex workflow turn was cancelled.',
            },
          };
        }
        throw codexTurnOutcomeError(
          outcome,
          'Codex workflow turn was interrupted before completion',
        );
      }
      try {
        if (outcome.status !== 'completed') {
          throw codexTurnOutcomeError(outcome, 'Codex workflow turn failed');
        }
        // The shared safe parser, not `JSON.parse`: V8's message quotes the
        // text it choked on, and that excerpt reached the retry prompt and the
        // reported failure. `SyntaxError` is preserved so
        // `isRetryableCodexStructuredOutputError` still retries malformed
        // structured output.
        const structured = request.schema
          ? parseStructuredResponseText(outcome.finalText)
          : undefined;
        return {
          status: 'success',
          sessionId: handle.threadId,
          rawText: outcome.finalText,
          ...(structured !== undefined ? { structured } : {}),
          transcript: `${transcript.join('\n')}\n`,
          proposedPlan: outcome.proposedPlanText,
          usage: outcome.usage,
          aiCreditsRouted,
          modelGatewayRouted,
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
    const accountScope = aiCreditsRouted ? 'ai_credits' : failureAccountScope;
    const classification =
      classifyAgentFailure({
        provider: failureProvider,
        accountScope,
        model: request.model,
        events: transcriptEvents,
        error,
      }) ??
      // The local app-server transport failed (unanswered thread setup, a
      // shared restart for another turn, a thread still closing). Pause as a
      // temporary outage so the run resumes; never for an unanswered
      // `turn/start`, which may already be running.
      classifyRetryableCodexTransportFailure(
        classifyCodexTransportError(error),
        { provider: failureProvider, accountScope, model: request.model },
        message,
      );
    return {
      status: request.signal?.aborted ? 'cancelled' : 'failure',
      transcript: `${transcript.join('\n')}\n`,
      aiCreditsRouted,
      modelGatewayRouted,
      failure: {
        version: 1,
        provider: failureProvider,
        agent_harness: 'codex',
        // A resume that failed during setup has no handle yet, but the step
        // still belongs to that session. Activity reports only this attempt;
        // the step runner carries over activity from a checkpoint it continued.
        ...(handle
          ? { session_id: handle.threadId }
          : request.resumeSessionId
            ? { session_id: request.resumeSessionId }
            : {}),
        had_agent_activity:
          codexTranscriptEventsHaveAgentActivity(transcriptEvents),
        ...(classification ? { classification } : {}),
        message,
      },
    };
  } finally {
    ledgerCodex?.dispose();
    await handle?.unsubscribe().catch(() => {});
    await ports.releaseSession(routeSessionId).catch(() => {});
    await service.revokeStdioMcpRoutes(routeSessionId);
  }
}
