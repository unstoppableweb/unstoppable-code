import type { TransientAgentRetryOptions } from '@canopy/execution-engine/types/agent-failures';
import {
  requireProviderForModel,
  getExecutionHarnessForModel,
  type AgentModelConfig,
  type PrInstructionMode,
  type ThinkingLevel,
} from '../types';
import {
  type ClaudeStructuredHelperQueryOptions,
  type CodexStructuredHelperRunner,
  formatBranchAsTitle,
  resolveHelperTranscriptProvider,
  runClaudeStructuredHelperQuery,
  runCodexStructuredHelperQuery,
  type StructuredHelperQueryResult,
} from './structured-helper-query';
import type { HelperAgentPluginRuntime } from './helper-agent-plugins';
import type { HelperUsage } from '@canopy/execution-engine/lib/helper-usage';
import type { HelperTranscriptObserver } from './helper-transcript';
import type { CodexConfig } from '@canopy/execution-engine/lib/codex-model-config';
import { isTransientAgentRetryExhaustedError } from '@canopy/execution-engine/agent-failures/transient-retry';
import {
  mergeHelperUsage,
  readHelperUsage,
} from '@canopy/execution-engine/lib/helper-usage';

interface CommitMessageResult {
  commitMessage: CommitMessage | null;
  usage: HelperUsage;
}

export type StructuredHelperRunner = <T>(
  options: Omit<ClaudeStructuredHelperQueryOptions<T>, 'provider'>,
) => Promise<StructuredHelperQueryResult<T>>;

export interface GenerateCommitMessageOptions {
  waitForQuotaRecovery?: TransientAgentRetryOptions<unknown>['waitForQuotaRecovery'];
  /**
   * Decides whether a failed attempt gets its second try. Defaults to always
   * retrying. A caller with other models to fall back to can decline, so a
   * usage limit moves on instead of hitting the same exhausted lane twice.
   */
  shouldRetryAfterError?: (error: unknown) => boolean;
  repoPath: string;
  branchName: string;
  diff: string;
  model: string;
  claudeEnvOverride?: Record<string, string>;
  /** AI Credits nested Codex provider config (routed Codex helper path). */
  codexConfigOverride?: CodexConfig;
  /** AI Credits gateway bearer-token env (routed Codex helper path). */
  thinkingLevel?: ThinkingLevel;
  modelConfig?: AgentModelConfig;
  workspaceId?: string;
  /** Resolved opt-in local memory preference (CAN-1969). */
  localMemoryEnabled: boolean;
  instructions: string;
  instructionMode: PrInstructionMode;
  transcriptObserver?: HelperTranscriptObserver;
  pluginRuntime?: HelperAgentPluginRuntime;
  codexRunner?: CodexStructuredHelperRunner;
  abortController?: AbortController;
  executionHarness?: 'claude' | 'codex';
}

interface CommitMessage {
  message: string;
}

export interface GeneratedCommitMessage {
  message: string;
  usage: HelperUsage;
  source: 'model' | 'fallback';
  /**
   * Last error caught across the generator's own attempts when it fell back.
   * `undefined` when the model simply returned nothing usable.
   */
  lastError?: unknown;
}

export const DEFAULT_COMMIT_MESSAGE_INSTRUCTIONS =
  'Write a concise conventional-commit style commit message. ' +
  'Subject line under 72 characters. ' +
  'Include a body only when the changes are complex enough to warrant explanation.';

function isCommitMessage(value: unknown): value is CommitMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const maybeMessage = value as { message?: unknown };
  return (
    typeof maybeMessage.message === 'string' &&
    maybeMessage.message.trim().length > 0
  );
}

const COMMIT_MESSAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
};

async function runCommitMessageQuery(
  options: GenerateCommitMessageOptions,
  systemPrompt: string,
  userMessage: string,
  runner: StructuredHelperRunner,
): Promise<CommitMessageResult> {
  const result = await runner({
    repoPath: options.repoPath,
    model: options.model,
    maxTurns: 2,
    systemPrompt,
    userMessage,
    schema: COMMIT_MESSAGE_SCHEMA,
    thinkingLevel: options.thinkingLevel,
    workspaceId: options.workspaceId,
    localMemoryEnabled: options.localMemoryEnabled,
    claudeEnvOverride: options.claudeEnvOverride,
    transcriptObserver: options.transcriptObserver,
    waitForQuotaRecovery: options.waitForQuotaRecovery,
    pluginRuntime: options.pluginRuntime,
    abortController: options.abortController,
    isResult: isCommitMessage,
  });
  return { commitMessage: result.value, usage: result.usage };
}

async function runCodexCommitMessageQuery(
  options: GenerateCommitMessageOptions,
  combinedPrompt: string,
): Promise<CommitMessageResult> {
  if (!options.codexRunner) {
    throw new Error('Codex helper runner is not configured');
  }
  const result = await runCodexStructuredHelperQuery({
    runner: options.codexRunner,
    repoPath: options.repoPath,
    model: options.model,
    systemPrompt: '',
    userMessage: '',
    combinedPrompt,
    schema: COMMIT_MESSAGE_SCHEMA,
    thinkingLevel: options.thinkingLevel,
    modelConfig: options.modelConfig,
    workspaceId: options.workspaceId,
    localMemoryEnabled: options.localMemoryEnabled,
    transcriptObserver: options.transcriptObserver,
    waitForQuotaRecovery: options.waitForQuotaRecovery,
    pluginRuntime: options.pluginRuntime,
    abortController: options.abortController,
    ...(options.codexConfigOverride
      ? { codexConfigOverride: options.codexConfigOverride }
      : {}),
    isResult: isCommitMessage,
  });
  return { commitMessage: result.value, usage: result.usage };
}

function buildFallbackCommitMessage(
  options: GenerateCommitMessageOptions,
): string {
  return formatBranchAsTitle(options.branchName);
}

export function resolveCommitMessageInstructions(
  options: Pick<
    GenerateCommitMessageOptions,
    'instructions' | 'instructionMode'
  >,
): string {
  if (options.instructionMode === 'replace') {
    return options.instructions;
  }

  if (options.instructionMode === 'append' && options.instructions) {
    return `${DEFAULT_COMMIT_MESSAGE_INSTRUCTIONS}\n\nAdditional instructions:\n${options.instructions}`;
  }

  return DEFAULT_COMMIT_MESSAGE_INSTRUCTIONS;
}

export async function generateCommitMessageWithUsage(
  options: GenerateCommitMessageOptions,
  runner: StructuredHelperRunner = (queryOptions) => {
    const provider = requireProviderForModel(queryOptions.model);
    if (
      provider === 'codex' ||
      provider === 'cursor' ||
      provider === 'copilot' ||
      provider === 'antigravity' ||
      provider === 'opencode'
    ) {
      throw new Error(
        `This model cannot run through the Claude helper: ${queryOptions.model}`,
      );
    }
    return runClaudeStructuredHelperQuery({
      ...queryOptions,
      provider,
    });
  },
): Promise<GeneratedCommitMessage> {
  const systemPrompt = [
    'You generate git commit messages from the supplied diff.',
    'Return structured output only.',
    resolveCommitMessageInstructions(options),
  ]
    .filter(Boolean)
    .join('\n\n');

  const userMessage = [
    `Branch: ${options.branchName}`,
    '',
    '## Diff',
    options.diff || '(no diff)',
  ].join('\n');

  const useCodex =
    (options.executionHarness ?? getExecutionHarnessForModel(options.model)) ===
    'codex';
  const codexPrompt = `${systemPrompt}\n\n${userMessage}\n\nRespond with ONLY a JSON object: {"message": "..."}`;
  let accumulatedUsage: HelperUsage = {};
  let lastError: unknown;
  await options.transcriptObserver?.seed({
    provider: resolveHelperTranscriptProvider(
      options.model,
      options.executionHarness,
    ),
    originalText: userMessage,
    submittedText: useCodex ? codexPrompt : userMessage,
    systemPrompt,
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = useCodex
        ? await runCodexCommitMessageQuery(options, codexPrompt)
        : await runCommitMessageQuery(
            options,
            systemPrompt,
            userMessage,
            runner,
          );
      accumulatedUsage = mergeHelperUsage(accumulatedUsage, result.usage);
      if (result.commitMessage) {
        return {
          message: result.commitMessage.message,
          usage: accumulatedUsage,
          source: 'model',
        };
      }
    } catch (error) {
      if (options.abortController?.signal.aborted) {
        throw error;
      }
      lastError = error;
      accumulatedUsage = mergeHelperUsage(
        accumulatedUsage,
        readHelperUsage(error) ?? {},
      );
      if (
        isTransientAgentRetryExhaustedError(error) ||
        options.shouldRetryAfterError?.(error) === false
      ) {
        break;
      }
      // Retry on next attempt
    }
  }

  return {
    message: buildFallbackCommitMessage(options),
    usage: accumulatedUsage,
    source: 'fallback',
    ...(lastError === undefined ? {} : { lastError }),
  };
}
