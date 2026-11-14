import type { TransientAgentRetryOptions } from '@canopy/execution-engine/types/agent-failures';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  requireProviderForModel,
  getExecutionHarnessForModel,
  type AgentModelConfig,
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
import {
  PR_CONTENT_RESPONSE_FORMAT_INSTRUCTIONS,
  PR_CONTENT_SCHEMA,
  PR_CONTENT_SYSTEM_PREAMBLE,
  isPrContent,
  resolvePrContentInstructions,
  type PrContent,
} from '@canopy/protocol/pull-requests';

// The content policy is shared with the cloud server (REG-3025).
export {
  DEFAULT_PR_CONTENT_INSTRUCTIONS,
  resolvePrContentInstructions,
  type PrContent,
} from '@canopy/protocol/pull-requests';

interface PrQueryResult {
  content: PrContent | null;
  usage: HelperUsage;
}

export type StructuredHelperRunner = <T>(
  options: Omit<ClaudeStructuredHelperQueryOptions<T>, 'provider'>,
) => Promise<StructuredHelperQueryResult<T>>;

export interface GeneratePrContentOptions {
  waitForQuotaRecovery?: TransientAgentRetryOptions<unknown>['waitForQuotaRecovery'];
  repoPath: string;
  branchName: string;
  baseBranch: string;
  diff: string;
  commitLog: string;
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
  instructionMode: string;
  prTemplate?: string;
  transcriptObserver?: HelperTranscriptObserver;
  pluginRuntime?: HelperAgentPluginRuntime;
  codexRunner?: CodexStructuredHelperRunner;
  abortController?: AbortController;
  executionHarness?: 'claude' | 'codex';
}

export interface GeneratedPrContent {
  content: PrContent;
  usage: HelperUsage;
  source: 'model' | 'fallback';
}

async function loadPrTemplate(repoPath: string): Promise<string | null> {
  try {
    return await readFile(
      join(repoPath, '.github', 'PULL_REQUEST_TEMPLATE.md'),
      'utf-8',
    );
  } catch {
    return null;
  }
}

async function runGenerationQuery(
  options: GeneratePrContentOptions,
  systemPrompt: string,
  userMessage: string,
  runner: StructuredHelperRunner,
): Promise<PrQueryResult> {
  const result = await runner({
    repoPath: options.repoPath,
    model: options.model,
    maxTurns: 10,
    systemPrompt,
    userMessage,
    schema: PR_CONTENT_SCHEMA,
    thinkingLevel: options.thinkingLevel,
    workspaceId: options.workspaceId,
    localMemoryEnabled: options.localMemoryEnabled,
    claudeEnvOverride: options.claudeEnvOverride,
    transcriptObserver: options.transcriptObserver,
    waitForQuotaRecovery: options.waitForQuotaRecovery,
    pluginRuntime: options.pluginRuntime,
    abortController: options.abortController,
    isResult: isPrContent,
  });
  return { content: result.value, usage: result.usage };
}

async function runCodexGenerationQuery(
  options: GeneratePrContentOptions,
  combinedPrompt: string,
): Promise<PrQueryResult> {
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
    schema: PR_CONTENT_SCHEMA,
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
    isResult: isPrContent,
  });
  return { content: result.value, usage: result.usage };
}

function buildFallbackPr(options: GeneratePrContentOptions): PrContent {
  const title = formatBranchAsTitle(options.branchName);
  const body = options.commitLog ? `## Changes\n\n${options.commitLog}` : '';
  return { title, body };
}

export async function generatePrContentWithUsage(
  options: GeneratePrContentOptions,
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
): Promise<GeneratedPrContent> {
  const template =
    options.prTemplate ?? (await loadPrTemplate(options.repoPath));

  const systemPrompt = [
    PR_CONTENT_SYSTEM_PREAMBLE,
    PR_CONTENT_RESPONSE_FORMAT_INSTRUCTIONS,
    resolvePrContentInstructions(options),
    template
      ? `\nHere is the project's PR template to follow:\n\n${template}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const userMessage = [
    `Branch: ${options.branchName} -> ${options.baseBranch}`,
    '',
    '## Commit Log',
    options.commitLog || '(no commits)',
    '',
    '## Diff',
    options.diff || '(no diff)',
  ].join('\n');

  const useCodex =
    (options.executionHarness ?? getExecutionHarnessForModel(options.model)) ===
    'codex';
  const codexPrompt = `${systemPrompt}\n\n${userMessage}\n\nRespond with ONLY the JSON object {"title":"...","body":"..."}, with no code fence or explanation.`;
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
    const result = useCodex
      ? await runCodexGenerationQuery(options, codexPrompt)
      : await runGenerationQuery(options, systemPrompt, userMessage, runner);
    if (result.content) {
      return {
        content: result.content,
        usage: result.usage,
        source: 'model',
      };
    }
  }

  return {
    content: buildFallbackPr(options),
    usage: {},
    source: 'fallback',
  };
}
