import { assertHelperWorkerContext } from '../helper-runs/helper-worker-context';
import { runHelperThroughWorker } from '../helper-runs/helper-runs';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  AGENT_TRANSIENT_RETRY_CONTINUE_PROMPT,
  readClaudeRetrySessionId,
  runWithTransientAgentRetry,
} from '@canopy/execution-engine/agent-failures';
import {
  codexServiceTierForModelConfig,
  mapThinkingToReasoningEffort,
} from '@canopy/execution-engine/lib/codex-model-config';
import {
  DEFAULT_CODEX_SPEED,
  readCodexSpeedRecord,
} from '@canopy/execution-engine/lib/codex-speed';
import { buildHelperInjectedPrompts } from '@canopy/desktop-shared/lib/helper-transcript';
import { readHelperUsage } from '@canopy/execution-engine/lib/helper-usage';
import {
  formatClaudeStreamError,
  StructuredHelperQueryError,
} from '@canopy/desktop-shared/lib/structured-helper-query';
import type { CodexThreadHandle } from '@canopy/execution-engine/node/codex-runtime';
import type { ThreadStartParams } from '@canopy/execution-engine/node/codex-runtime/generated/v2/ThreadStartParams';
import { resolveCodexMockAppServerOverride } from '@canopy/execution-engine/node/e2e-mock-env';
import {
  claudeNativeMemoryOptions,
  codexNativeMemoryThreadConfig,
} from '@canopy/execution-engine/node/lib/native-memory';
import {
  type AgentModelConfig,
  type AgentProviderType,
  buildClaudeThinkingOptions,
  clampThinkingLevelForModel,
  DEFAULT_HANDOFF_SUMMARY_MODEL,
  getExecutionHarnessForModel,
  getModelSource,
  type ResolveEnvironmentRequest,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { SHORT_CHAT_TITLE_SYSTEM_PROMPT } from '@canopy/protocol/generated-names';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { mkdir } from 'node:fs/promises';
import type { AccountProxyQuotaWait } from '../account-proxy/quota-wait';
import { codexRuntimeForWorkerRun } from '../codex/runtime-service';
import {
  admitCodexSpeed,
  reportCodexSpeedTurnFailure,
} from '../codex/speed-policy';
import { getClaudeWorkerSessionService } from '../integration/claude-worker-session-service';
import { resolveClaudeModAdmissionLaunch } from './claude-mod-admission-launch';
import { mergeClaudeModAdmissionSettings } from '@canopy/execution-engine/node/plugins/claude-mod-admission';
import { getEffectiveClaudeWorkerModePreferences } from '../lib/claude-tui-workers';
import { markObservedHelperTaskAiCreditsRouted } from '../lib/helper-observed-task';
import { checkModelGatewayRoute } from '../lib/model-gateway-state';
import { isModelBlockedByStoredPolicy } from '../lib/model-policy-state';
import {
  readLocalMemoryEnabledPreference,
  readPreferencesFile,
} from '../lib/preferences-store';
import { resolveCodexRuntimeEnvironmentProfile } from '../lib/user-environment-runtime';
import type { DesktopExecutionObservabilityIngest } from '../observability/ingest';
import type { HelperInvocation } from '../ollama/helper-invocation';
import {
  resolveHelperInvocation,
  resolveHelperWorkOwner,
} from '../ollama/helper-invocation';
import {
  getBundledClaudeBinaryPath,
  getBundledRgBinaryPath,
  getEnhancedEnv,
} from '../pipelines/config-paths';
import { spawnClaudeCodeProcessOffMain } from './claude-process-host-runner';

export interface HelperUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  totalCostUsd?: number;
  messageCount?: number;
  assistantMessageCount?: number;
}

export interface SummaryResult {
  text: string;
  usage: HelperUsage;
  /**
   * Present when provider generation failed and `text` is the preserved,
   * truncated user-message fallback rather than model output. `retryable`
   * marks a thrown provider error (offline, credentials, abort) rather than a
   * deterministic outcome such as a policy refusal or empty output.
   */
  fallback?: { reason: string; retryable?: boolean };
}

const HANDOFF_SUMMARY_SYSTEM_PROMPT =
  'You are summarizing a chat conversation that will be handed off to a new session. Create a concise summary that gives the receiving assistant full context to continue. Include: key decisions made, current state of work, pending tasks, relevant file paths, and important code changes. Frame this as a briefing for picking up exactly where the last session left off.';

export const HANDOFF_SUMMARY_MODEL = DEFAULT_HANDOFF_SUMMARY_MODEL;

function resolveAgentEnvironment(
  workspaceId: string | undefined,
): ResolveEnvironmentRequest {
  return workspaceId ? { runtime: 'agent', workspaceId } : { runtime: 'agent' };
}

async function shouldUseBackgroundTextWorker(
  model: string,
  harness = getExecutionHarnessForModel(model),
): Promise<boolean> {
  const preferences = await readPreferencesFile().catch(() => null);
  const effectivePreferences = preferences
    ? getEffectiveClaudeWorkerModePreferences(preferences)
    : null;
  return (
    effectivePreferences?.canopyBackgroundProcessesMode === 'terminal' &&
    harness === 'claude'
  );
}

async function runBackgroundTextWorker(options: {
  waitForQuotaRecovery?: AccountProxyQuotaWait;
  kind: string;
  label: string;
  cwd: string;
  model: string;
  prompt: string;
  systemPrompt: string;
  thinkingLevel?: ThinkingLevel;
  workspaceId?: string;
  claudeEnvOverride?: Record<string, string>;
  maxTurns: number;
  provider: AgentProviderType;
  observabilityTaskKey?: string;
}): Promise<SummaryResult> {
  assertHelperWorkerContext('runBackgroundTextWorker');
  let resumeSessionId: string | undefined;
  await updateHelperRetryMetadata(options.observabilityTaskKey, { attempt: 1 });
  return runWithTransientAgentRetry({
    waitForQuotaRecovery: options.waitForQuotaRecovery,
    provider: options.provider,
    model: options.model,
    runAttempt: async (captureEvent) => {
      const queryId =
        options.provider === 'claude'
          ? options.observabilityTaskKey
          : undefined;
      const observabilityService = queryId
        ? await loadObservabilityIngest()
        : undefined;
      if (queryId && observabilityService) {
        observabilityService.beginClaudeQuery(
          queryId,
          resumeSessionId
            ? { sessionId: resumeSessionId, fork: false }
            : undefined,
        );
      }

      try {
        const result = await getClaudeWorkerSessionService().runWorker<string>({
          kind: options.kind,
          label: options.label,
          cwd: options.cwd,
          systemPrompt: options.systemPrompt,
          prompt: resumeSessionId
            ? AGENT_TRANSIENT_RETRY_CONTINUE_PROMPT
            : options.prompt,
          model: options.model,
          thinkingLevel: options.thinkingLevel,
          permission: {
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            tools: [],
            allowedTools: [],
          },
          // Summary workers are unattended and their permission preset exposes
          // no tools, so they must not enter an unanswerable Ask-mode prompt.
          approvalMode: 'full-access',
          settingSources: [],
          maxTurns: options.maxTurns,
          claudeEnvOverride: options.claudeEnvOverride,
          projectId: options.workspaceId,
          ...(resumeSessionId ? { resumeSessionId } : {}),
        });
        for (const line of (result.transcriptJsonl ?? '')
          .split('\n')
          .filter(Boolean)) {
          const event: unknown = JSON.parse(line);
          captureEvent(event);
          if (options.provider === 'claude' || options.provider === 'ollama') {
            await appendProviderHelperTranscriptEvent(
              options.observabilityTaskKey,
              event,
              options.provider,
            );
          } else {
            await appendHelperTranscriptEvent(
              options.observabilityTaskKey,
              event,
            );
          }
        }
        if (result.sessionStarted) {
          resumeSessionId = result.sessionId;
          await updateHelperRetryMetadata(options.observabilityTaskKey, {
            sdkSessionId: result.sessionId,
          });
        }
        if (result.status !== 'success') {
          throw new StructuredHelperQueryError(
            result.finalText.trim() ||
              `Background text worker ended with status ${result.status}.`,
            result.usage,
          );
        }
        return {
          text: result.finalText,
          usage: result.usage,
        };
      } finally {
        if (queryId && observabilityService) {
          observabilityService.endClaudeQuery(queryId);
        }
      }
    },
    onRetry: (notice) =>
      updateHelperRetryMetadata(options.observabilityTaskKey, {
        attempt: notice.nextAttempt,
      }),
  });
}

/**
 * Merge an optional Claude-mock env override onto the base enhanced env for the
 * archive/handoff summary helpers. These helpers do not flow through
 * `resolveClaudeCompatibleInvocation`, so without this merge they would still
 * hit the real Anthropic endpoint under an E2E build. Pure (no gate, no
 * `process.env` read) so it is unit-testable directly — jest bakes
 * `__CANOPY_E2E__ === false`, so the gated call site that supplies `override`
 * can never run under jest.
 */
export function buildSummaryHelperEnv(
  baseEnv: Record<string, string | undefined>,
  override: Record<string, string> | undefined,
): Record<string, string | undefined> {
  if (!override) {
    return baseEnv;
  }
  return { ...baseEnv, ...override };
}

async function loadObservabilityIngest(): Promise<DesktopExecutionObservabilityIngest> {
  const { getExecutionObservabilityIngest } =
    await import('../observability/ingest');
  return getExecutionObservabilityIngest();
}

/**
 * Chat/archive/handoff summaries all ship raw conversation text to an
 * explicitly configured helper model, so an organization model policy applies
 * here exactly as it does to an interactive chat turn. These are
 * non-interactive background helpers, so a blocked model is refused rather than
 * silently swapped for an allowed one.
 */
const SUMMARY_MODEL_POLICY_REFUSAL =
  'Summary generation was skipped: this model is blocked by your organization policy.';
const SUMMARY_EMPTY_OUTPUT_FALLBACK =
  'Summary generation returned no usable text.';

// Word-internal punctuation stays (`node-gyp`, `v2.0`, `CI/CD`, `don't`), as
// do trailing `+` and `#` (`C++`, `C#`). Other punctuation becomes a word
// break, so `my_func` reads as `my func`.
const TITLE_DISALLOWED_CHARACTERS = new RegExp(
  "[^\\p{L}\\p{M}\\p{N}\\s.+#/'’-]",
  'gu',
);
const TITLE_LEADING_PUNCTUATION = new RegExp("(^|\\s)[.+#/'’-]+", 'gu');
const TITLE_TRAILING_PUNCTUATION = new RegExp("[./'’-]+(?=\\s|$)", 'gu');
const TITLE_LETTER_OR_NUMBER = new RegExp('[\\p{L}\\p{N}]', 'u');

/** Bound code points, retaining whole words whenever a boundary is available. */
function conciseChatTitle(raw: string): string {
  const normalized = raw
    .replace(TITLE_DISALLOWED_CHARACTERS, ' ')
    .replace(TITLE_LEADING_PUNCTUATION, '$1')
    .replace(TITLE_TRAILING_PUNCTUATION, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!TITLE_LETTER_OR_NUMBER.test(normalized)) return '';
  const characters = Array.from(normalized);
  if (characters.length <= 40) return normalized;
  const prefix = characters.slice(0, 40).join('');
  const boundary = prefix.lastIndexOf(' ');
  return (
    characters[40] === ' ' || boundary < 1 ? prefix : prefix.slice(0, boundary)
  ).trim();
}

function chatTitleFallback(firstPrompt: string): string {
  return conciseChatTitle(firstPrompt) || 'Attachment conversation';
}

function sanitizeSummary(
  raw: string,
  fallback: string,
  purpose?: 'chat-title',
): Pick<SummaryResult, 'text' | 'fallback'> {
  if (purpose === 'chat-title') {
    const text = conciseChatTitle(raw);
    return text
      ? { text }
      : {
          text: chatTitleFallback(fallback),
          fallback: { reason: SUMMARY_EMPTY_OUTPUT_FALLBACK },
        };
  }
  const sanitized = raw
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (sanitized) {
    return { text: sanitized.slice(0, 100) };
  }
  return {
    text: fallback.slice(0, 100),
    fallback: { reason: SUMMARY_EMPTY_OUTPUT_FALLBACK },
  };
}

/**
 * Record the refusal on the caller-started Audit Trail entry so it reads as a
 * refusal instead of a zero-token success. `finalizeObservedTask` is
 * idempotent, so a later finalize from the caller is a no-op.
 */
async function recordSummaryPolicyRefusal(
  taskKey: string | undefined,
): Promise<void> {
  if (!taskKey) {
    return;
  }

  const observabilityService = await loadObservabilityIngest();
  observabilityService.finalizeObservedTask(
    taskKey,
    'failure',
    SUMMARY_MODEL_POLICY_REFUSAL,
  );
}

async function seedHelperTranscript(
  taskKey: string | undefined,
  options: {
    provider: AgentProviderType;
    originalText: string;
    submittedText: string;
    systemPrompt: string;
  },
): Promise<void> {
  if (!taskKey) {
    return;
  }

  const observabilityService = await loadObservabilityIngest();
  observabilityService.seedTranscript(taskKey, {
    provider: options.provider,
    originalText: options.originalText,
    submittedText: options.submittedText,
    planMode: false,
    injectedPrompts: buildHelperInjectedPrompts(
      options.provider,
      options.systemPrompt,
    ),
  });
}

async function appendHelperTranscriptEvent(
  taskKey: string | undefined,
  event: unknown,
): Promise<void> {
  if (!taskKey) {
    return;
  }

  const observabilityService = await loadObservabilityIngest();
  observabilityService.appendTranscriptRecord(taskKey, event);
}

const CLAUDE_OBSERVABLE_EVENT_TYPES = new Set([
  'assistant',
  'user',
  'system',
  'result',
  'conversation_reset',
]);

function isClaudeObservableEvent(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    CLAUDE_OBSERVABLE_EVENT_TYPES.has(value.type)
  );
}

async function appendProviderHelperTranscriptEvent(
  taskKey: string | undefined,
  event: unknown,
  provider: AgentProviderType,
): Promise<void> {
  await appendHelperTranscriptEvent(taskKey, event);
  if (
    !taskKey ||
    !isClaudeObservableEvent(event) ||
    (provider !== 'claude' && provider !== 'ollama')
  ) {
    return;
  }

  const observabilityService = await loadObservabilityIngest();
  observabilityService.observeClaudeEvent(taskKey, event, provider);
}

async function updateHelperRetryMetadata(
  taskKey: string | undefined,
  patch: { attempt?: number; sdkSessionId?: string },
): Promise<void> {
  if (!taskKey) {
    return;
  }
  const observabilityService = await loadObservabilityIngest();
  observabilityService.updateObservedTask(taskKey, patch);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

async function collectClaudeTextAndUsage(
  queryResult: AsyncIterable<unknown>,
  provider: AgentProviderType,
  observabilityTaskKey?: string,
  captureEvent?: (event: unknown) => void,
  rememberSessionId?: (sessionId: string) => void,
): Promise<{ text: string; usage: HelperUsage }> {
  let text = '';
  let resultText = '';
  const usage: HelperUsage = {};
  let assistantMessages = 0;
  let pendingErrorMessage: string | undefined;

  for await (const event of queryResult) {
    captureEvent?.(event);
    await appendProviderHelperTranscriptEvent(
      observabilityTaskKey,
      event,
      provider,
    );
    const sessionId = readClaudeRetrySessionId(event);
    if (sessionId) {
      rememberSessionId?.(sessionId);
      await updateHelperRetryMetadata(observabilityTaskKey, {
        sdkSessionId: sessionId,
      });
    }
    if (!isRecord(event)) {
      const streamError = formatClaudeStreamError(event);
      if (streamError) {
        pendingErrorMessage ??= streamError;
      }
      continue;
    }

    if (event.type === 'assistant') {
      assistantMessages += 1;
      if (isRecord(event.message)) {
        const content = event.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              isRecord(block) &&
              block.type === 'text' &&
              typeof block.text === 'string'
            ) {
              text += block.text;
            }
          }
        }
      }
    }
    if (event.type === 'result') {
      if (typeof event.result === 'string') {
        resultText = event.result;
      }
      if (isRecord(event.usage)) {
        usage.inputTokens = readNumber(event.usage, 'input_tokens');
        usage.outputTokens = readNumber(event.usage, 'output_tokens');
        usage.cacheReadInputTokens = readNumber(
          event.usage,
          'cache_read_input_tokens',
        );
        usage.cacheCreationInputTokens = readNumber(
          event.usage,
          'cache_creation_input_tokens',
        );
      }
      if (typeof event.total_cost_usd === 'number') {
        usage.totalCostUsd = event.total_cost_usd;
      }
    }
    const streamError = formatClaudeStreamError(event);
    if (streamError) {
      if (event.type !== 'result') {
        pendingErrorMessage ??= streamError;
        continue;
      }
      const effectiveAssistantMessages = Math.max(assistantMessages, 1);
      usage.messageCount = effectiveAssistantMessages;
      usage.assistantMessageCount = effectiveAssistantMessages;
      throw new StructuredHelperQueryError(streamError, usage);
    }
    if (event.type === 'result' && pendingErrorMessage) {
      const effectiveAssistantMessages = Math.max(assistantMessages, 1);
      usage.messageCount = effectiveAssistantMessages;
      usage.assistantMessageCount = effectiveAssistantMessages;
      throw new StructuredHelperQueryError(pendingErrorMessage, usage);
    }
  }

  const effectiveAssistantMessages = Math.max(
    assistantMessages,
    resultText ? 1 : 0,
  );
  usage.messageCount = effectiveAssistantMessages;
  usage.assistantMessageCount = effectiveAssistantMessages;

  if (pendingErrorMessage) {
    throw new StructuredHelperQueryError(pendingErrorMessage, usage);
  }
  return { text: text || resultText, usage };
}

async function runObservedClaudeQuery(
  queryId: string | undefined,
  provider: AgentProviderType,
  resumeSessionId: string | undefined,
  createQuery: () => AsyncIterable<unknown>,
  captureEvent?: (event: unknown) => void,
  rememberSessionId?: (sessionId: string) => void,
): Promise<{ text: string; usage: HelperUsage }> {
  assertHelperWorkerContext('runObservedClaudeQuery');
  const observabilityService =
    queryId && provider === 'claude'
      ? await loadObservabilityIngest()
      : undefined;
  if (queryId && provider === 'claude' && observabilityService) {
    observabilityService.beginClaudeQuery(
      queryId,
      resumeSessionId ? { sessionId: resumeSessionId, fork: false } : undefined,
    );
  }

  try {
    return await collectClaudeTextAndUsage(
      createQuery(),
      provider,
      queryId,
      captureEvent,
      rememberSessionId,
    );
  } finally {
    if (queryId && provider === 'claude' && observabilityService) {
      observabilityService.endClaudeQuery(queryId);
    }
  }
}

async function generateChatSummaryWithClaude(
  userMessage: string,
  model: string,
  cwd: string,
  thinkingLevel: ThinkingLevel,
  workspaceId?: string,
  workOwner?: WorkOwner | null,
  observabilityTaskKey?: string,
  purpose?: 'chat-title',
): Promise<SummaryResult> {
  // Scope the user-supplied-credential guard to the SAME environment this
  // helper spawns with (`resolveAgentEnvironment(workspaceId)` below). A
  // workspace Environments assignment replaces the global one, so resolving
  // without the workspace can miss a per-workspace provider key that is live at
  // spawn — and routing would then blank it and bill credits (ECW-9091).
  const invocation = await resolveHelperInvocation(model, undefined, {
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(workOwner !== undefined ? { workOwner } : {}),
  });
  try {
    if (observabilityTaskKey) {
      markObservedHelperTaskAiCreditsRouted(
        observabilityTaskKey,
        invocation.aiCreditsRouted,
        invocation.accountProxyRouted === true,
      );
    }
    const submittedPrompt = `<user_message_to_summarize>${userMessage}</user_message_to_summarize>`;
    const environment = resolveAgentEnvironment(workspaceId);
    await seedHelperTranscript(observabilityTaskKey, {
      provider: invocation.providerType,
      originalText: userMessage,
      submittedText: submittedPrompt,
      systemPrompt: SHORT_CHAT_TITLE_SYSTEM_PROMPT,
    });
    if (await shouldUseBackgroundTextWorker(model)) {
      const result = await runBackgroundTextWorker({
        kind: 'chat_summary',
        label: 'Chat Summary',
        cwd,
        model: invocation.sdkModel ?? model,
        prompt: submittedPrompt,
        systemPrompt: SHORT_CHAT_TITLE_SYSTEM_PROMPT,
        thinkingLevel,
        workspaceId,
        claudeEnvOverride: invocation.envOverride,
        waitForQuotaRecovery: invocation.waitForQuotaRecovery,
        maxTurns: 2,
        provider: invocation.providerType,
        observabilityTaskKey,
      });
      return {
        ...sanitizeSummary(result.text, userMessage, purpose),
        usage: result.usage,
      };
    }
    const thinkingOptions = buildClaudeThinkingOptions(thinkingLevel);
    const effectiveModel = invocation.sdkModel ?? model;
    const localMemoryEnabled = await readLocalMemoryEnabledPreference();
    let resumeSessionId: string | undefined;
    await updateHelperRetryMetadata(observabilityTaskKey, { attempt: 1 });
    const result = await runWithTransientAgentRetry({
      waitForQuotaRecovery: invocation.waitForQuotaRecovery,
      provider: invocation.providerType,
      model: effectiveModel,
      runAttempt: (captureEvent) =>
        runObservedClaudeQuery(
          observabilityTaskKey,
          invocation.providerType,
          resumeSessionId,
          () =>
            claudeQuery({
              prompt: resumeSessionId
                ? AGENT_TRANSIENT_RETRY_CONTINUE_PROMPT
                : submittedPrompt,
              options: {
                model: effectiveModel,
                maxTurns: 2,
                cwd,
                pathToClaudeCodeExecutable: getBundledClaudeBinaryPath(),
                spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
                env: {
                  ...getEnhancedEnv({ environment }),
                  ...(invocation.envOverride ?? {}),
                },
                sandbox: {
                  ripgrep: {
                    command: getBundledRgBinaryPath(),
                  },
                },
                settingSources: [],
                tools: [],
                allowedTools: [],
                mcpServers: {},
                extraArgs: {
                  'strict-mcp-config': null,
                  ...(thinkingOptions.extraArgs ?? {}),
                },
                systemPrompt: SHORT_CHAT_TITLE_SYSTEM_PROMPT,
                thinking: thinkingOptions.thinking,
                ...(thinkingOptions.effort
                  ? { effort: thinkingOptions.effort }
                  : {}),
                // Merge with the thinking settings (Ultra sets `ultracode`) so the
                // spread cannot drop the native-memory suppression applied while
                // local memory is enabled (CAN-1969).
                ...claudeNativeMemoryOptions(
                  localMemoryEnabled,
                  thinkingOptions.settings,
                ),
                ...(resumeSessionId ? { resume: resumeSessionId } : {}),
              },
            }),
          captureEvent,
          (sessionId) => {
            resumeSessionId = sessionId;
          },
        ),
      onRetry: (notice) =>
        updateHelperRetryMetadata(observabilityTaskKey, {
          attempt: notice.nextAttempt,
        }),
    });

    return {
      ...sanitizeSummary(result.text, userMessage, purpose),
      usage: result.usage,
    };
  } finally {
    invocation.dispose?.();
  }
}

async function generateChatSummaryWithCodex(
  userMessage: string,
  model: string,
  cwd: string,
  thinkingLevel: ThinkingLevel,
  workspaceId?: string,
  workOwner?: WorkOwner | null,
  observabilityTaskKey?: string,
  modelConfig?: AgentModelConfig,
  purpose?: 'chat-title',
): Promise<SummaryResult> {
  const invocation = await resolveHelperInvocation(model, undefined, {
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(workOwner !== undefined ? { workOwner } : {}),
  });
  try {
    const result = await runCodexHelperText(invocation, {
      model,
      cwd,
      thinkingLevel,
      workspaceId,
      observabilityTaskKey,
      modelConfig,
      originalText: userMessage,
      submittedPrompt: `<user_message_to_summarize>${userMessage}</user_message_to_summarize>`,
      systemPrompt: SHORT_CHAT_TITLE_SYSTEM_PROMPT,
    });
    return {
      ...sanitizeSummary(result.text, userMessage, purpose),
      usage: result.usage,
    };
  } finally {
    invocation.dispose?.();
  }
}

async function runCodexHelperText(
  invocation: HelperInvocation,
  options: {
    model: string;
    cwd: string;
    thinkingLevel: ThinkingLevel;
    reasoningContext?: { model: string; aiCreditsRouted: boolean };
    permissionMode?: 'report-only';
    workspaceId?: string;
    observabilityTaskKey?: string;
    modelConfig?: AgentModelConfig;
    originalText: string;
    submittedPrompt: string;
    systemPrompt: string;
  },
): Promise<SummaryResult> {
  assertHelperWorkerContext('runCodexHelperText');
  const {
    model,
    cwd,
    thinkingLevel,
    workspaceId,
    observabilityTaskKey,
    modelConfig,
    originalText,
    submittedPrompt,
    systemPrompt,
  } = options;
  let handle: CodexThreadHandle | undefined;
  try {
    if (observabilityTaskKey) {
      markObservedHelperTaskAiCreditsRouted(
        observabilityTaskKey,
        invocation.aiCreditsRouted,
        invocation.accountProxyRouted === true,
      );
    }
    const workspaceEnvironment = resolveCodexRuntimeEnvironmentProfile({
      runtime: 'agent',
      ...(workspaceId ? { workspaceId } : {}),
    });
    const mock = resolveCodexMockAppServerOverride();
    const effectiveModel = invocation.sdkModel ?? model;
    // Admit the exact requested speed from the resolved invocation before any
    // transcript, thread, or turn. A rejection reaches `generateChatSummary`'s
    // existing fallback; no other speed is attempted.
    const admission = await admitCodexSpeed(
      readCodexSpeedRecord(modelConfig) ?? DEFAULT_CODEX_SPEED,
      {
        selectedModel: model,
        runtimeModel: effectiveModel,
        modelSource: invocation.source,
        harness: invocation.harness,
        providerType: invocation.providerType,
        gateway: invocation.aiCreditsRouted ? 'ai-credits' : null,
        codexConfig: invocation.codexConfig ?? null,
        environment: {
          ...workspaceEnvironment.environment,
          ...(invocation.envOverride ?? {}),
        },
        mockProvider: mock !== undefined,
      },
    );
    await seedHelperTranscript(observabilityTaskKey, {
      provider: invocation.providerType,
      originalText,
      submittedText: submittedPrompt,
      systemPrompt: systemPrompt,
    });
    const params = {
      cwd,
      model: effectiveModel,
      approvalPolicy: 'never' as const,
      developerInstructions: systemPrompt,
      selectedCapabilityRoots: [],
      experimentalRawEvents: false,
      ephemeral: true,
      config: {
        service_tier: codexServiceTierForModelConfig(modelConfig),
        ...(invocation.codexConfig ?? {}),
        // Merged last so no override spread can drop the native-memory
        // suppression applied while local memory is enabled (CAN-1969).
        ...codexNativeMemoryThreadConfig(
          await readLocalMemoryEnabledPreference(),
        ),
      } satisfies NonNullable<ThreadStartParams['config']>,
    };
    const profile = {
      environment: {
        ...workspaceEnvironment.environment,
        ...(invocation.envOverride ?? {}),
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
      ...(mock ? { mockProviderId: 'canopy-e2e' } : {}),
    };
    const reportOnlyParams =
      options.permissionMode === 'report-only'
        ? await (
            await import('../integration/codex-report-only')
          ).prepareCodexReportOnlyThread(cwd, params.config, profile)
        : undefined;
    await updateHelperRetryMetadata(observabilityTaskKey, { attempt: 1 });
    return await runWithTransientAgentRetry({
      waitForQuotaRecovery: invocation.waitForQuotaRecovery,
      provider: 'codex',
      model: effectiveModel,
      runAttempt: async (captureEvent) => {
        const continuing = handle !== undefined;
        handle ??= await codexRuntimeForWorkerRun(
          'runCodexHelperText',
        ).startThread({
          params: {
            ...params,
            ...(reportOnlyParams ?? { sandbox: 'read-only' as const }),
          },
          capabilitySnapshotId: 'codex-capabilities-empty-v1',
          capabilityLeaseKind: 'ephemeral',
          capabilityLeaseExpiresAt: new Date(
            Date.now() + 60 * 60_000,
          ).toISOString(),
          profile,
        });
        await updateHelperRetryMetadata(observabilityTaskKey, {
          sdkSessionId: handle.threadId,
        });
        const outcome = await handle.runTurn({
          input: [
            {
              type: 'text',
              text: continuing
                ? AGENT_TRANSIENT_RETRY_CONTINUE_PROMPT
                : submittedPrompt,
              text_elements: [],
            },
          ],
          effort: mapThinkingToReasoningEffort(
            thinkingLevel,
            options.reasoningContext?.model ?? effectiveModel,
            options.reasoningContext?.aiCreditsRouted ?? false,
          ),
          onEvent: (event) => {
            captureEvent(event);
            void appendHelperTranscriptEvent(observabilityTaskKey, event);
          },
        });
        if (outcome.status !== 'completed') {
          reportCodexSpeedTurnFailure(admission, effectiveModel, {
            codexErrorInfo: outcome.errorInfo,
            message: outcome.error,
          });
          throw new StructuredHelperQueryError(
            outcome.error ?? `Codex summary ${outcome.status}`,
            outcome.usage,
          );
        }
        return {
          text: outcome.finalText,
          usage: {
            ...outcome.usage,
            messageCount: outcome.finalText ? 1 : 0,
            assistantMessageCount: outcome.finalText ? 1 : 0,
          },
        };
      },
      onRetry: (notice) =>
        updateHelperRetryMetadata(observabilityTaskKey, {
          attempt: notice.nextAttempt,
        }),
    });
  } finally {
    await handle?.delete().catch(() => undefined);
  }
}

export async function generateChatSummary(
  userMessage: string,
  options?: {
    model?: string;
    thinkingLevel?: ThinkingLevel;
    cwd?: string;
    workspaceId?: string;
    /** Owner inherited from the chat that queued this summary. */
    workOwner?: WorkOwner | null;
    observabilityTaskKey?: string;
    modelConfig?: AgentModelConfig;
    /** Initial chat naming only; Ledger and other summaries keep their defaults. */
    purpose?: 'chat-title';
  },
): Promise<SummaryResult> {
  if (options?.purpose === 'chat-title' && !userMessage.trim()) {
    return {
      text: chatTitleFallback(userMessage),
      usage: {},
      fallback: { reason: SUMMARY_EMPTY_OUTPUT_FALLBACK },
    };
  }
  const effectiveModel = options?.model ?? 'haiku';
  const effectiveThinking = options?.thinkingLevel ?? 'off';
  const effectiveCwd = options?.cwd ?? process.cwd();
  const hasBoundWorkOwner =
    options !== undefined &&
    Object.prototype.hasOwnProperty.call(options, 'workOwner');
  const workOwner = hasBoundWorkOwner
    ? (options?.workOwner ?? null)
    : undefined;

  // Refuse before any provider work so no conversation text reaches a blocked
  // model. The truncated user message is the same graceful fallback this helper
  // already returns when generation fails.
  const policyOwner = await resolveHelperWorkOwner({
    ...(options?.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(hasBoundWorkOwner ? { workOwner } : {}),
  });
  if (await isModelBlockedByStoredPolicy(effectiveModel, policyOwner)) {
    return {
      text:
        options?.purpose === 'chat-title'
          ? chatTitleFallback(userMessage)
          : userMessage.slice(0, 100),
      usage: {},
      fallback: { reason: SUMMARY_MODEL_POLICY_REFUSAL },
    };
  }

  try {
    await mkdir(effectiveCwd, { recursive: true });
    if (getExecutionHarnessForModel(effectiveModel) === 'codex') {
      return await runHelperThroughWorker({
        kind: 'chat_summary',
        model: effectiveModel,
        scope: { workspaceId: options?.workspaceId },
        origin: 'system',
        workOwner: policyOwner,
        launch: async () =>
          generateChatSummaryWithCodex(
            userMessage,
            effectiveModel,
            effectiveCwd,
            effectiveThinking,
            options?.workspaceId,
            workOwner,
            options?.observabilityTaskKey,
            options?.modelConfig,
            options?.purpose,
          ),
        usageOf: (r) => r.usage,
      });
    }
    return await runHelperThroughWorker({
      kind: 'chat_summary',
      model: effectiveModel,
      scope: { workspaceId: options?.workspaceId },
      origin: 'system',
      workOwner: policyOwner,
      launch: async () =>
        generateChatSummaryWithClaude(
          userMessage,
          effectiveModel,
          effectiveCwd,
          effectiveThinking,
          options?.workspaceId,
          workOwner,
          options?.observabilityTaskKey,
          options?.purpose,
        ),
      usageOf: (r) => r.usage,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[generateChatSummary] failed:', err);
    const reason = err instanceof Error ? err.message : String(err);
    return {
      text:
        options?.purpose === 'chat-title'
          ? chatTitleFallback(userMessage)
          : userMessage.slice(0, 100),
      usage: readHelperUsage(err) ?? {},
      // Every thrown error is retryable, including permanent ones; the
      // scheduler's bounded attempt count is what caps repeated spend.
      fallback: { reason, retryable: true },
    };
  }
}

export async function generateArchiveSummary(
  conversationText: string,
  options?: {
    cwd?: string;
    workspaceId?: string;
    observabilityTaskKey?: string;
  },
): Promise<SummaryResult> {
  if (!conversationText.trim()) {
    return { text: 'No conversation to summarize.', usage: {} };
  }

  const effectiveCwd = options?.cwd ?? process.cwd();
  const prompt = `Summarize the following conversation. The summary should be a well-structured Markdown document including:
- A title that captures the main topic
- Key topics discussed
- Important decisions or conclusions reached
- Any code snippets, commands, or configurations that were important

Return ONLY the Markdown content, no wrapping code fences.

---

${conversationText}`;
  const systemPrompt =
    'You are summarizing a chat conversation for archival purposes. Create a detailed, well-structured Markdown summary. Be thorough but concise. Include all important technical details, decisions, and outcomes.';
  const archiveModel = 'haiku';

  // Refuse before any provider work so no conversation text reaches a blocked
  // model. The archive still gets written, with an explicit refusal in place of
  // the generated summary.
  const policyOwner = await resolveHelperWorkOwner({
    ...(options?.workspaceId ? { workspaceId: options.workspaceId } : {}),
  });
  if (await isModelBlockedByStoredPolicy(archiveModel, policyOwner)) {
    await recordSummaryPolicyRefusal(options?.observabilityTaskKey);
    return { text: SUMMARY_MODEL_POLICY_REFUSAL, usage: {} };
  }

  let disposeInvocation: (() => void) | undefined;
  return await runHelperThroughWorker({
    kind: 'chat_archive_summary',
    model: archiveModel,
    scope: { workspaceId: options?.workspaceId },
    origin: 'system',
    workOwner: policyOwner,
    launch: async () => {
      try {
        const invocation = await resolveHelperInvocation(
          archiveModel,
          undefined,
          {
            ...(options?.workspaceId !== undefined
              ? { workspaceId: options.workspaceId }
              : {}),
          },
        );
        disposeInvocation = invocation.dispose;
        if (options?.observabilityTaskKey) {
          markObservedHelperTaskAiCreditsRouted(
            options.observabilityTaskKey,
            invocation.aiCreditsRouted,
            invocation.accountProxyRouted === true,
          );
        }
        await seedHelperTranscript(options?.observabilityTaskKey, {
          provider: 'claude',
          originalText: conversationText,
          submittedText: prompt,
          systemPrompt,
        });
        if (await shouldUseBackgroundTextWorker(archiveModel)) {
          const result = await runBackgroundTextWorker({
            kind: 'archive_summary',
            label: 'Archive Summary',
            cwd: effectiveCwd,
            model: invocation.sdkModel ?? archiveModel,
            prompt,
            systemPrompt,
            workspaceId: options?.workspaceId,
            claudeEnvOverride: invocation.envOverride,
            waitForQuotaRecovery: invocation.waitForQuotaRecovery,
            maxTurns: 1,
            provider: invocation.providerType,
            observabilityTaskKey: options?.observabilityTaskKey,
          });
          return {
            text: result.text || 'No summary available.',
            usage: result.usage,
          };
        }
        const effectiveModel = invocation.sdkModel ?? archiveModel;
        const localMemoryEnabled = await readLocalMemoryEnabledPreference();
        let resumeSessionId: string | undefined;
        await updateHelperRetryMetadata(options?.observabilityTaskKey, {
          attempt: 1,
        });
        const result = await runWithTransientAgentRetry({
          waitForQuotaRecovery: invocation.waitForQuotaRecovery,
          provider: invocation.providerType,
          model: effectiveModel,
          runAttempt: async (captureEvent) => {
            const claudeModAdmission = await resolveClaudeModAdmissionLaunch({
              cwd: effectiveCwd,
              environment: resolveAgentEnvironment(options?.workspaceId),
              ...(invocation.envOverride?.CLAUDE_CONFIG_DIR !== undefined
                ? { claudeConfigDir: invocation.envOverride.CLAUDE_CONFIG_DIR }
                : {}),
            });
            const nativeMemoryOptions =
              claudeNativeMemoryOptions(localMemoryEnabled);
            const admissionSettings = claudeModAdmission?.settings
              ? mergeClaudeModAdmissionSettings(
                  nativeMemoryOptions.settings ?? {},
                  claudeModAdmission.settings,
                )
              : undefined;
            return runObservedClaudeQuery(
              options?.observabilityTaskKey,
              invocation.providerType,
              resumeSessionId,
              () =>
                claudeQuery({
                  prompt: resumeSessionId
                    ? AGENT_TRANSIENT_RETRY_CONTINUE_PROMPT
                    : prompt,
                  options: {
                    model: effectiveModel,
                    maxTurns: 1,
                    cwd: effectiveCwd,
                    pathToClaudeCodeExecutable: getBundledClaudeBinaryPath(),
                    spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
                    env: buildSummaryHelperEnv(
                      getEnhancedEnv({
                        environment: resolveAgentEnvironment(
                          options?.workspaceId,
                        ),
                      }),
                      invocation.envOverride,
                    ),
                    sandbox: {
                      ripgrep: {
                        command: getBundledRgBinaryPath(),
                      },
                    },
                    systemPrompt,
                    // Native-memory suppression while local memory is enabled
                    // (CAN-1969).
                    ...nativeMemoryOptions,
                    ...(admissionSettings
                      ? { settings: admissionSettings }
                      : {}),
                    ...(claudeModAdmission &&
                    claudeModAdmission.plugins.length > 0
                      ? { plugins: [...claudeModAdmission.plugins] }
                      : {}),
                    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
                  },
                }),
              captureEvent,
              (sessionId) => {
                resumeSessionId = sessionId;
              },
            );
          },
          onRetry: (notice) =>
            updateHelperRetryMetadata(options?.observabilityTaskKey, {
              attempt: notice.nextAttempt,
            }),
        });

        return {
          text: result.text || 'No summary available.',
          usage: result.usage,
        };
      } catch (error) {
        return {
          text: 'Summary generation failed.',
          usage: readHelperUsage(error) ?? {},
        };
      } finally {
        disposeInvocation?.();
      }
    },
    usageOf: (r) => r.usage,
  });
}

export async function generateHandoffSummary(
  conversationText: string,
  options?: {
    model?: string;
    thinkingLevel?: ThinkingLevel;
    modelConfig?: AgentModelConfig;
    cwd?: string;
    workspaceId?: string;
    /** Owner inherited from the source chat; explicit absence is immutable. */
    workOwner?: WorkOwner | null;
    observabilityTaskKey?: string;
  },
): Promise<SummaryResult> {
  if (!conversationText.trim()) {
    throw new Error('No conversation to summarize.');
  }

  const selectedModel = options?.model ?? DEFAULT_HANDOFF_SUMMARY_MODEL;
  const selectedHarness = getExecutionHarnessForModel(selectedModel);
  if (
    !getModelSource(selectedModel) ||
    (selectedHarness !== 'claude' && selectedHarness !== 'codex')
  ) {
    throw new Error(
      `Choose a supported conversation handoff model in Settings. "${selectedModel}" is unavailable for handoffs.`,
    );
  }
  const selectedThinking = options?.thinkingLevel ?? 'off';
  const effectiveCwd = options?.cwd ?? process.cwd();
  const prompt = `Create a handoff summary for the following conversation.

Return ONLY the summary text, with no wrapping code fences.

---

${conversationText}`;
  // No non-AI handoff summary exists, and this helper already signals failure by
  // throwing (its callers surface the message), so refuse the same way.
  const policyOwner = await resolveHelperWorkOwner({
    ...(options?.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(options && Object.prototype.hasOwnProperty.call(options, 'workOwner')
      ? { workOwner: options.workOwner }
      : {}),
  });
  if (await isModelBlockedByStoredPolicy(selectedModel, policyOwner)) {
    await recordSummaryPolicyRefusal(options?.observabilityTaskKey);
    throw new Error(SUMMARY_MODEL_POLICY_REFUSAL);
  }
  const selectedLocal = getModelSource(selectedModel) === 'ollama';
  if (selectedLocal) {
    const admission = await checkModelGatewayRoute(selectedModel, policyOwner);
    if (!admission.ok)
      throw new Error(
        `${admission.message} Choose an allowed conversation handoff model in Settings.`,
      );
  }
  const invocation = await resolveHelperInvocation(selectedModel, undefined, {
    ...(options?.workspaceId !== undefined
      ? { workspaceId: options.workspaceId }
      : {}),
    workOwner: policyOwner,
    ...(selectedLocal ? { preserveModelSelection: true } : {}),
  });
  try {
    return await runHelperThroughWorker({
      kind: 'chat_handoff_summary',
      model: selectedModel,
      scope: { workspaceId: options?.workspaceId },
      origin: 'client',
      workOwner: policyOwner,
      launch: async () => {
        if (selectedLocal && invocation.source !== 'ollama') {
          throw new Error(
            'The local conversation handoff model is unavailable. Choose an installed local model in Settings.',
          );
        }
        if (options?.observabilityTaskKey) {
          const observabilityService = await loadObservabilityIngest();
          observabilityService.updateObservedTask(
            options.observabilityTaskKey,
            {
              model:
                invocation.resolvedModel ??
                invocation.sdkModel ??
                selectedModel,
              provider: invocation.providerType,
              modelSource: invocation.source,
              executionHarness: invocation.harness,
              serviceTier:
                invocation.harness === 'codex'
                  ? codexServiceTierForModelConfig(options.modelConfig)
                  : undefined,
            },
          );
        }
        const resolvedModel = invocation.resolvedModel ?? selectedModel;
        const thinkingLevel = clampThinkingLevelForModel(
          selectedThinking,
          resolvedModel,
          invocation.providerType,
          invocation.aiCreditsRouted,
        );
        if (invocation.harness === 'codex') {
          const result = await runCodexHelperText(invocation, {
            model: selectedModel,
            cwd: effectiveCwd,
            thinkingLevel,
            permissionMode: 'report-only',
            reasoningContext: {
              model: resolvedModel,
              aiCreditsRouted: invocation.aiCreditsRouted,
            },
            workspaceId: options?.workspaceId,
            observabilityTaskKey: options?.observabilityTaskKey,
            modelConfig: options?.modelConfig,
            originalText: conversationText,
            submittedPrompt: prompt,
            systemPrompt: HANDOFF_SUMMARY_SYSTEM_PROMPT,
          });
          const text = result.text.trim();
          if (!text)
            throw new StructuredHelperQueryError(
              'Summary generation returned no content.',
              result.usage,
            );
          return { text, usage: result.usage };
        }
        if (options?.observabilityTaskKey) {
          markObservedHelperTaskAiCreditsRouted(
            options.observabilityTaskKey,
            invocation.aiCreditsRouted,
            invocation.accountProxyRouted === true,
          );
        }
        await seedHelperTranscript(options?.observabilityTaskKey, {
          provider: invocation.providerType,
          originalText: conversationText,
          submittedText: prompt,
          systemPrompt: HANDOFF_SUMMARY_SYSTEM_PROMPT,
        });
        if (
          await shouldUseBackgroundTextWorker(selectedModel, invocation.harness)
        ) {
          const result = await runBackgroundTextWorker({
            kind: 'handoff_summary',
            label: 'Handoff Summary',
            cwd: effectiveCwd,
            model: invocation.sdkModel ?? selectedModel,
            prompt,
            systemPrompt: HANDOFF_SUMMARY_SYSTEM_PROMPT,
            workspaceId: options?.workspaceId,
            claudeEnvOverride: invocation.envOverride,
            waitForQuotaRecovery: invocation.waitForQuotaRecovery,
            thinkingLevel,
            maxTurns: 1,
            provider: invocation.providerType,
            observabilityTaskKey: options?.observabilityTaskKey,
          });
          const summary = result.text.trim();
          if (!summary) {
            throw new StructuredHelperQueryError(
              'Summary generation returned no content.',
              result.usage,
            );
          }
          return { text: summary, usage: result.usage };
        }
        const effectiveModel = invocation.sdkModel ?? selectedModel;
        const thinkingOptions = buildClaudeThinkingOptions(thinkingLevel);
        const localMemoryEnabled = await readLocalMemoryEnabledPreference();
        let resumeSessionId: string | undefined;
        await updateHelperRetryMetadata(options?.observabilityTaskKey, {
          attempt: 1,
        });
        const result = await runWithTransientAgentRetry({
          waitForQuotaRecovery: invocation.waitForQuotaRecovery,
          provider: invocation.providerType,
          model: effectiveModel,
          runAttempt: (captureEvent) =>
            runObservedClaudeQuery(
              options?.observabilityTaskKey,
              invocation.providerType,
              resumeSessionId,
              () =>
                claudeQuery({
                  prompt: resumeSessionId
                    ? AGENT_TRANSIENT_RETRY_CONTINUE_PROMPT
                    : prompt,
                  options: {
                    model: effectiveModel,
                    maxTurns: 1,
                    cwd: effectiveCwd,
                    pathToClaudeCodeExecutable: getBundledClaudeBinaryPath(),
                    spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
                    env: buildSummaryHelperEnv(
                      getEnhancedEnv({
                        environment: resolveAgentEnvironment(
                          options?.workspaceId,
                        ),
                      }),
                      invocation.envOverride,
                    ),
                    sandbox: {
                      ripgrep: {
                        command: getBundledRgBinaryPath(),
                      },
                    },
                    settingSources: [],
                    tools: [],
                    allowedTools: [],
                    mcpServers: {},
                    extraArgs: {
                      'strict-mcp-config': null,
                      ...(thinkingOptions.extraArgs ?? {}),
                    },
                    thinking: thinkingOptions.thinking,
                    ...(thinkingOptions.effort
                      ? { effort: thinkingOptions.effort }
                      : {}),
                    systemPrompt: HANDOFF_SUMMARY_SYSTEM_PROMPT,
                    // Native-memory suppression while local memory is enabled
                    // (CAN-1969).
                    ...claudeNativeMemoryOptions(
                      localMemoryEnabled,
                      thinkingOptions.settings,
                    ),
                    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
                  },
                }),
              captureEvent,
              (sessionId) => {
                resumeSessionId = sessionId;
              },
            ),
          onRetry: (notice) =>
            updateHelperRetryMetadata(options?.observabilityTaskKey, {
              attempt: notice.nextAttempt,
            }),
        });
        const summary = result.text.trim();
        if (!summary) {
          throw new StructuredHelperQueryError(
            'Summary generation returned no content.',
            result.usage,
          );
        }

        return { text: summary, usage: result.usage };
      },
      usageOf: (r) => r.usage,
    });
  } finally {
    invocation.dispose?.();
  }
}
