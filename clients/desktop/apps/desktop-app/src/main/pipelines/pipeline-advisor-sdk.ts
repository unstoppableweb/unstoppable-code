import { assertHelperWorkerContext } from '../helper-runs/helper-worker-context';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { BRAND } from '@canopy/brand/current';
import {
  buildClaudeThinkingOptions,
  type AgentModelConfig,
  type ResolveEnvironmentRequest,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import {
  type CodexConfig,
  codexServiceTierForModelConfig,
  mapThinkingToReasoningEffort,
} from '@canopy/execution-engine/lib/codex-model-config';
import type { CodexThreadHandle } from '@canopy/execution-engine/node/codex-runtime';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import type { HelperUsage } from '@canopy/execution-engine/lib/helper-usage';
import {
  AGENT_TRANSIENT_RETRY_CONTINUE_PROMPT,
  runWithTransientAgentRetry,
} from '@canopy/execution-engine/agent-failures';
import type { AccountProxyQuotaWait } from '../account-proxy/quota-wait';
import { parseStructuredJsonResult } from '@canopy/desktop-shared/lib/claude-structured-output';
import {
  claudeNativeMemoryOptions,
  codexNativeMemoryThreadConfig,
} from '@canopy/execution-engine/node/lib/native-memory';
import { readLocalMemoryEnabledPreference } from '../lib/preferences-store';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import {
  getBundledClaudeBinaryPath,
  getBundledRgBinaryPath,
  getEnhancedEnv,
} from './config-paths';
import { codexRuntimeForWorkerRun } from '../codex/runtime-service';
import { resolveCodexRuntimeEnvironmentProfile } from '../lib/user-environment-runtime';
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

export const PIPELINE_ADVISOR_SYSTEM_PROMPT = [
  `You are ${BRAND.displayName}'s Pipeline Advisor. Your job is to monitor one pipeline execution for health, inefficiencies, ETA estimates, and final improvement recommendations.`,
  'Work strictly from the provided pipeline execution data directory, state file, logs, and user-provided execution status.',
  'Do not modify files, request approvals, or ask the user questions.',
  'Prefer concrete evidence: job names, step names, statuses, timestamps, retries, repeated failures, long-running steps, queueing, skipped work, and error messages.',
  'For running pipelines, always provide a best-effort ETA when the state, logs, or artifacts contain any usable timestamps or job-progress evidence; use low confidence when uncertainty is high.',
  'Reserve eta.status unknown only when the execution state/logs are missing, corrupt, or contain no usable timing or progress evidence, and explain exactly what evidence is missing.',
  'For terminal pipelines, report eta.status complete.',
  'When nullable schema fields are not applicable, return null for those fields.',
  'Return only JSON matching the requested schema.',
].join(' ');

export interface PipelineAdvisorSdkTurnInput {
  waitForQuotaRecovery?: AccountProxyQuotaWait;
  abortController?: AbortController;
  provider: 'claude' | 'codex';
  /** The resolved provider; a local Ollama model runs on the Claude harness. */
  providerType?: 'claude' | 'ollama' | 'codex';
  model: string;
  modelConfig?: AgentModelConfig;
  envOverride?: Record<string, string>;
  codexConfig?: CodexConfig;
  /**
   * Trusted route facts of the resolved helper invocation, used to admit the
   * exact Codex speed. Omitted facts are derived from `model`.
   */
  codexSpeedRoute?: Pick<
    CodexSpeedRouteEvidence,
    'selectedModel' | 'modelSource' | 'providerType' | 'gateway'
  >;
  thinkingLevel: ThinkingLevel;
  executionDataDir: string;
  systemPrompt: string;
  userPrompt: string;
  schema: Record<string, JsonValue>;
  sdkSessionId?: string;
  observabilityTaskKey: string;
  workspaceId?: string;
}

export interface PipelineAdvisorSdkTurnResult {
  report: unknown;
  rawText: string;
  sdkSessionId: string;
  usage: HelperUsage;
}

class PipelineAdvisorTurnError extends Error {
  constructor(
    message: string,
    readonly sdkSessionId: string,
    readonly usage: HelperUsage,
  ) {
    super(message);
  }
}

class PipelineAdvisorCodexTurnError extends PipelineAdvisorTurnError {
  constructor(
    message: string,
    sdkSessionId: string,
    readonly retryableStructuredOutput: boolean,
    usage: HelperUsage,
  ) {
    super(message, sdkSessionId, usage);
    this.name = 'PipelineAdvisorCodexTurnError';
  }
}

export async function runPipelineAdvisorSdkTurn(
  input: PipelineAdvisorSdkTurnInput,
): Promise<PipelineAdvisorSdkTurnResult> {
  assertHelperWorkerContext('runPipelineAdvisorSdkTurn');
  let retainedSessionId = input.sdkSessionId;
  return runWithTransientAgentRetry({
    provider: input.provider,
    model: input.model,
    signal: input.abortController?.signal,
    waitForQuotaRecovery: input.waitForQuotaRecovery,
    // Preserve the advisor's existing non-quota failure policy.
    delaysMs: [],
    runAttempt: async (captureEvent, attempt) => {
      const attemptInput = {
        ...input,
        sdkSessionId: retainedSessionId,
        userPrompt:
          attempt > 1 && retainedSessionId
            ? AGENT_TRANSIENT_RETRY_CONTINUE_PROMPT
            : input.userPrompt,
      };
      try {
        return await (input.provider === 'claude'
          ? runClaudeAdvisorTurn(attemptInput, captureEvent)
          : runCodexAdvisorTurn(attemptInput, captureEvent));
      } catch (error) {
        if (error instanceof PipelineAdvisorTurnError && error.sdkSessionId) {
          retainedSessionId = error.sdkSessionId;
        }
        throw error;
      }
    },
  });
}

function resolveAgentEnvironment(
  workspaceId: string | undefined,
): ResolveEnvironmentRequest {
  return workspaceId ? { runtime: 'agent', workspaceId } : { runtime: 'agent' };
}

async function runClaudeAdvisorTurn(
  input: PipelineAdvisorSdkTurnInput,
  captureEvent: (event: unknown) => void,
): Promise<PipelineAdvisorSdkTurnResult> {
  const usage: HelperUsage = {};
  let sdkSessionId = input.sdkSessionId ?? '';
  let rawText = '';
  let structuredOutput: unknown;
  const environment = resolveAgentEnvironment(input.workspaceId);
  const thinkingOptions = buildClaudeThinkingOptions(input.thinkingLevel);
  const localMemoryEnabled = await readLocalMemoryEnabledPreference();
  const env = {
    ...getEnhancedEnv({ environment }),
    ...input.envOverride,
  };

  const observabilityService = getExecutionObservabilityIngest();
  const observedProvider =
    input.providerType === 'ollama' ? 'ollama' : 'claude';
  if (observedProvider === 'claude') {
    observabilityService.beginClaudeQuery(
      input.observabilityTaskKey,
      input.sdkSessionId
        ? { sessionId: input.sdkSessionId, fork: false }
        : undefined,
    );
  }
  try {
    const events = claudeQuery({
      prompt: input.userPrompt,
      options: {
        cwd: input.executionDataDir,
        model: input.model,
        pathToClaudeCodeExecutable: getBundledClaudeBinaryPath(),
        spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
        env,
        sandbox: {
          ripgrep: {
            command: getBundledRgBinaryPath(),
          },
        },
        settingSources: [],
        tools: ['Read', 'Glob', 'Grep', 'NotebookRead'],
        allowedTools: ['Read', 'Glob', 'Grep', 'NotebookRead'],
        persistSession: true,
        abortController: input.abortController,
        ...(input.sdkSessionId ? { resume: input.sdkSessionId } : {}),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: input.systemPrompt,
        },
        outputFormat: {
          type: 'json_schema',
          schema: input.schema,
        },
        ...thinkingOptions,
        // Merge with the thinking settings (Ultra sets `ultracode`) so the
        // spread cannot drop the native-memory suppression applied while local
        // memory is enabled (CAN-1969).
        ...claudeNativeMemoryOptions(
          localMemoryEnabled,
          thinkingOptions.settings,
        ),
      },
    });

    for await (const sdkEvent of events) {
      const event: unknown = sdkEvent;
      getExecutionObservabilityIngest().appendTranscriptRecord(
        input.observabilityTaskKey,
        event,
      );
      const eventRecord = toRecord(event);
      if (eventRecord && typeof eventRecord.type === 'string') {
        observabilityService.observeClaudeEvent(
          input.observabilityTaskKey,
          eventRecord,
          observedProvider,
        );
      }
      if (
        eventRecord?.type === 'system' &&
        typeof eventRecord.session_id === 'string' &&
        !sdkSessionId
      ) {
        sdkSessionId = eventRecord.session_id;
      }
      if (eventRecord?.type !== 'result') {
        continue;
      }
      captureClaudeUsage(usage, event);
      if (eventRecord.is_error === true) {
        captureEvent(event);
        const errors = Array.isArray(eventRecord.errors)
          ? eventRecord.errors.filter(
              (value): value is string => typeof value === 'string',
            )
          : [];
        throw new PipelineAdvisorTurnError(
          errors.join('\n') || 'Workflow Advisor Claude turn failed.',
          sdkSessionId,
          usage,
        );
      }
      structuredOutput = eventRecord.structured_output ?? structuredOutput;
      rawText =
        typeof eventRecord.result === 'string' ? eventRecord.result : rawText;
    }
  } catch (error) {
    if (error instanceof PipelineAdvisorTurnError) throw error;
    captureEvent(error);
    throw new PipelineAdvisorTurnError(
      error instanceof Error ? error.message : String(error),
      sdkSessionId,
      usage,
    );
  } finally {
    if (observedProvider === 'claude') {
      observabilityService.endClaudeQuery(input.observabilityTaskKey);
    }
  }

  const report = structuredOutput ?? parseStructuredJsonResult(rawText);
  if (!sdkSessionId) {
    throw new Error(
      'Workflow Advisor Claude turn did not return a session id.',
    );
  }
  if (report === null || report === undefined) {
    throw new Error('Workflow Advisor Claude turn did not return JSON.');
  }
  return { report, rawText, sdkSessionId, usage };
}

async function runCodexAdvisorTurn(
  input: PipelineAdvisorSdkTurnInput,
  captureEvent: (event: unknown) => void,
): Promise<PipelineAdvisorSdkTurnResult> {
  const workspaceEnvironment = resolveCodexRuntimeEnvironmentProfile({
    runtime: 'agent',
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  });
  // Admit the exact requested speed before starting or resuming the thread.
  // A rejection fails this advisor turn through the service's existing
  // failure path; no other speed is attempted.
  const route = input.codexSpeedRoute;
  const admission = await admitCodexSpeed(
    readCodexSpeedRecord(input.modelConfig) ?? DEFAULT_CODEX_SPEED,
    {
      selectedModel: route?.selectedModel ?? input.model,
      runtimeModel: input.model,
      ...(route?.modelSource !== undefined
        ? { modelSource: route.modelSource }
        : {}),
      harness: 'codex',
      providerType: route?.providerType ?? null,
      gateway: route?.gateway ?? null,
      codexConfig: input.codexConfig ?? null,
      // The only environment this helper applies to its Codex process.
      environment: workspaceEnvironment.environment,
      mockProvider: false,
    },
  );
  const commonParams = {
    model: input.model,
    cwd: input.executionDataDir,
    sandbox: 'read-only' as const,
    approvalPolicy: 'never' as const,
    developerInstructions: input.systemPrompt,
    config: {
      ...input.codexConfig,
      service_tier: codexServiceTierForModelConfig(input.modelConfig),
      // Merged last so no override spread can drop the native-memory
      // suppression applied while local memory is enabled (CAN-1969).
      ...codexNativeMemoryThreadConfig(
        await readLocalMemoryEnabledPreference(),
      ),
    },
  };
  const service = codexRuntimeForWorkerRun('pipelineAdvisorSdkTurn');
  const profile = {
    environment: workspaceEnvironment.environment,
    logicalWorkspaceEnvironmentId:
      workspaceEnvironment.logicalWorkspaceEnvironmentId,
    ...(workspaceEnvironment.secretVersionFingerprint
      ? {
          secretVersionFingerprint:
            workspaceEnvironment.secretVersionFingerprint,
        }
      : {}),
  };
  const capabilitySnapshotId = 'codex-capabilities-empty-v1';
  const thread = input.sdkSessionId
    ? await service.resumeThread({
        params: { threadId: input.sdkSessionId, ...commonParams },
        capabilitySnapshotId,
        capabilityLeaseKind: 'persisted-helper',
        profile,
      })
    : await service.startThread({
        params: {
          ...commonParams,
          selectedCapabilityRoots: [],
          experimentalRawEvents: false,
        },
        capabilitySnapshotId,
        capabilityLeaseKind: 'persisted-helper',
        profile,
      });

  try {
    let prompt = input.userPrompt;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await runCodexStreamedAttempt({
          ...input,
          prompt,
          thread,
          admission,
          captureEvent,
        });
        if (result.report !== null && result.report !== undefined) {
          return result;
        }
      } catch (error) {
        if (
          error instanceof PipelineAdvisorCodexTurnError &&
          error.retryableStructuredOutput &&
          attempt < 2
        ) {
          prompt = buildCodexStructuredOutputRetryPrompt(input, error.message);
          continue;
        }
        if (error instanceof PipelineAdvisorTurnError) throw error;
        captureEvent(error);
        throw new PipelineAdvisorTurnError(
          error instanceof Error ? error.message : String(error),
          thread.threadId,
          {},
        );
      }
      prompt = buildCodexStructuredOutputRetryPrompt(
        input,
        'Workflow Advisor Codex turn did not return JSON.',
      );
    }
    throw new Error('Workflow Advisor Codex turn did not return JSON.');
  } finally {
    await thread.unsubscribe().catch(() => {});
  }
}

async function runCodexStreamedAttempt(
  args: PipelineAdvisorSdkTurnInput & {
    prompt: string;
    thread: CodexThreadHandle;
    admission: CodexSpeedAdmission;
    captureEvent: (event: unknown) => void;
  },
): Promise<PipelineAdvisorSdkTurnResult> {
  const outcome = await args.thread.runTurn({
    input: [{ type: 'text', text: args.prompt, text_elements: [] }],
    outputSchema: args.schema,
    effort: mapThinkingToReasoningEffort(args.thinkingLevel, args.model),
    signal: args.abortController?.signal,
    onEvent: (event) =>
      getExecutionObservabilityIngest().appendTranscriptRecord(
        args.observabilityTaskKey,
        event,
      ),
  });
  if (outcome.status !== 'completed') {
    args.captureEvent({
      type: 'result',
      is_error: true,
      error: { message: outcome.error, codexErrorInfo: outcome.errorInfo },
    });
    reportCodexSpeedTurnFailure(args.admission, args.model, {
      codexErrorInfo: outcome.errorInfo,
      message: outcome.error,
    });
    const detail = outcome.error ?? `turn ${outcome.status}`;
    const message = `Workflow Advisor Codex turn failed: ${detail}`;
    throw new PipelineAdvisorCodexTurnError(
      message,
      args.thread.threadId,
      isRetryableCodexStructuredOutputMessage(detail),
      outcome.usage,
    );
  }
  const usage = {
    ...outcome.usage,
    messageCount: outcome.finalText ? 1 : 0,
    assistantMessageCount: outcome.finalText ? 1 : 0,
  };
  return {
    report: parseStructuredJsonResult(outcome.finalText),
    rawText: outcome.finalText,
    sdkSessionId: args.thread.threadId,
    usage,
  };
}

function buildCodexStructuredOutputRetryPrompt(
  input: PipelineAdvisorSdkTurnInput,
  failureMessage: string,
): string {
  return [
    input.systemPrompt,
    '',
    'Your previous response failed JSON Schema validation.',
    '',
    `Validation error: ${failureMessage}`,
    '',
    'Use the original task and context from this thread to try again.',
    'Respond with ONLY a JSON object matching this schema. Do not include markdown fences or explanatory text.',
    '',
    'JSON Schema:',
    JSON.stringify(input.schema, null, 2),
    '',
    input.userPrompt,
  ].join('\n');
}

function isRetryableCodexStructuredOutputMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('structured output') ||
    lower.includes('json schema') ||
    lower.includes('output schema') ||
    lower.includes('schema validation')
  );
}

function captureClaudeUsage(usage: HelperUsage, event: unknown): void {
  const record = toRecord(event);
  const usageRecord = toRecord(record?.usage);
  if (usageRecord) {
    usage.inputTokens = readNumberField(usageRecord, 'input_tokens');
    usage.outputTokens = readNumberField(usageRecord, 'output_tokens');
    usage.cacheReadInputTokens = readNumberField(
      usageRecord,
      'cache_read_input_tokens',
    );
    usage.cacheCreationInputTokens = readNumberField(
      usageRecord,
      'cache_creation_input_tokens',
    );
    usage.reasoningOutputTokens = readNumberField(
      usageRecord,
      'reasoning_output_tokens',
    );
  }
  const totalCostUsd = record
    ? readNumberField(record, 'total_cost_usd')
    : undefined;
  if (totalCostUsd !== undefined) {
    usage.totalCostUsd = totalCostUsd;
  }
  usage.messageCount = 1;
  usage.assistantMessageCount = 1;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNumberField(
  record: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = record[field];
  return typeof value === 'number' ? value : undefined;
}
