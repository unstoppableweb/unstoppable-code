import { assertHelperWorkerContext } from '../helper-runs/helper-worker-context';
import { runHelperThroughWorker } from '../helper-runs/helper-runs';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  buildClaudeThinkingOptions,
  getExecutionHarnessForModel,
  type AgentModelConfig,
  type AgentProviderType,
  type ThinkingLevel,
  type WorktreeRepoSummary,
  type WorktreeSummaryData,
} from '@canopy/desktop-shared/types';
import {
  emptyHelperAgentPluginRuntime,
  withoutHelperAgentMcpServers,
  type HelperAgentPluginRuntime,
} from '@canopy/desktop-shared/lib/helper-agent-plugins';
import {
  formatClaudeStreamError,
  StructuredHelperQueryError,
} from '@canopy/desktop-shared/lib/structured-helper-query';
import { claudeNativeMemoryOptions } from '@canopy/execution-engine/node/lib/native-memory';
import { READ_ONLY_TOOLS } from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import {
  GENERATED_WORKTREE_LABEL_INSTRUCTIONS,
  type GeneratedWorktreeLabelCandidate,
  type GeneratedWorktreeLabelClarity,
} from '@canopy/protocol/worktree-display-labels';
import {
  AGENT_TRANSIENT_RETRY_CONTINUE_PROMPT,
  isTransientAgentRetryExhaustedError,
  readClaudeRetrySessionId,
  runWithTransientAgentRetry,
} from '@canopy/execution-engine/agent-failures';
import {
  getBundledClaudeBinaryPath,
  getBundledRgBinaryPath,
  getEnhancedEnv,
} from '../pipelines/config-paths';
import type { HelperUsage } from '../agents/utils';
import { spawnClaudeCodeProcessOffMain } from '../agents/claude-process-host-runner';
import {
  mergeHelperUsage,
  readHelperUsage,
} from '@canopy/execution-engine/lib/helper-usage';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import { isRecord } from './type-guards';
import { isWorktreeSummaryData } from './worktree-summary-persistence';
import { resolveHelperInvocation } from '../ollama/helper-invocation';
import { resolveInvocationWorkOwner } from '../agents/work-owner';
import { resolveClaudeModAdmissionLaunch } from '../agents/claude-mod-admission-launch';
import { mergeClaudeModAdmissionSettings } from '@canopy/execution-engine/node/plugins/claude-mod-admission';
import { markObservedHelperTaskAiCreditsRouted } from './helper-observed-task';
import {
  codexStructuredHelperRunner,
  runStructuredHelper,
  structuredHelperReadOnlyPermission,
} from '../integration/structured-helper-dispatch';
import {
  readLocalMemoryEnabledPreference,
  readPreferencesFile,
} from './preferences-store';

export interface WorktreeSummaryResult {
  summary: WorktreeSummaryData | null;
  /**
   * The display label the model proposed, unvalidated. Null when none was
   * requested or the response carried none.
   */
  displayLabel: GeneratedWorktreeLabelCandidate | null;
  usage: HelperUsage;
}

interface InternalQueryResult {
  generated: GeneratedWorktreeSummary | null;
  usage: HelperUsage;
}

export interface WorktreeSummaryGeneratorOptions {
  projectId?: string;
  cwd: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  isFullRefresh: boolean;
  previousSummary: WorktreeSummaryData | null;
  chatExcerpts: string;
  /**
   * Concrete-change evidence alongside the chat excerpts. For git worktrees
   * (`changeInputKind` 'git-diff', the default) this is the branch/working
   * tree diff; for Cowork workspaces ('folder-activity') it is a
   * recently-modified-files listing of the non-git workspace folder.
   */
  gitDiff: string;
  changeInputKind?: 'git-diff' | 'folder-activity';
  currentTurnCount: number;
  isMultiRepo: boolean;
  repoDiffs?: Array<{
    name: string;
    diff: string;
  }>;
  observabilityTaskKey?: string;
  modelConfig?: AgentModelConfig;
  pluginRuntime?: HelperAgentPluginRuntime;
  /**
   * The worktree's branch and linked pull request, as Markdown lines. They
   * help name the work; omitted when nothing is known.
   */
  worktreeContext?: string;
  /**
   * Present when the worktree may take a generated display label: it has none,
   * or `provisionalLabel` is the generated one later turns may replace.
   */
  displayLabelRequest?: { provisionalLabel?: string };
  /**
   * True when the user explicitly asked for this summary (the Refresh button in
   * `SummarySection`), false for a scheduler-driven run.
   *
   * Decides whether an absent native login may spend AI Credits. A background
   * summary must never quietly consume a credits-only user's daily allowance,
   * but an explicit Refresh is exactly the user asking for the work — denying
   * that would spawn natively with no login and silently produce nothing
   * (ECW-9091 review round 7). Defaults to unattended, the safe direction.
   *
   * Note this is deliberately NOT `isFullRefresh`: an automatic incremental run
   * gets promoted to a full refresh on turn-count thresholds, so that flag says
   * how much to summarize, not who asked.
   */
  userInitiated?: boolean;
}

interface GeneratedWorktreeSummary {
  title: string;
  description: string;
  highlights: string[];
  repos?: WorktreeRepoSummary[];
  displayLabel?: string;
  displayLabelClarity?: GeneratedWorktreeLabelClarity;
}

const DISPLAY_LABEL_CLARITIES: readonly GeneratedWorktreeLabelClarity[] = [
  'clear',
  'provisional',
  'unclear',
];

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    highlights: {
      type: 'array',
      items: { type: 'string' },
    },
    repos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['name', 'description'],
      },
    },
  },
  required: ['title', 'description', 'highlights'],
};

const SUMMARY_WITH_DISPLAY_LABEL_SCHEMA = {
  ...SUMMARY_SCHEMA,
  properties: {
    ...SUMMARY_SCHEMA.properties,
    displayLabel: { type: 'string' },
    displayLabelClarity: { type: 'string', enum: DISPLAY_LABEL_CLARITIES },
  },
  required: [...SUMMARY_SCHEMA.required, 'displayLabel', 'displayLabelClarity'],
};

function summarySchemaFor(
  options: WorktreeSummaryGeneratorOptions,
): Record<string, unknown> {
  return options.displayLabelRequest
    ? SUMMARY_WITH_DISPLAY_LABEL_SCHEMA
    : SUMMARY_SCHEMA;
}

export { isWorktreeSummaryData } from './worktree-summary-persistence';

/**
 * AI Credits routing options shared by both provider branches (ECW-9091).
 *
 * Both must agree, and both must be workspace-scoped:
 * - `allowNoNativeAuthFallback` — a scheduler-driven summary must not spend a
 *   credits-only user's daily allowance, but an explicit Refresh must still
 *   work. Round 6 fixed only the Codex branch, which the default Claude model
 *   never takes; keeping this in one place is what stops that recurring.
 * - `workspaceId` — the user-supplied-credential guard has to read the same
 *   environment the spawn below uses (`runtime: 'agent'` + `options.projectId`).
 *   A workspace assignment REPLACES the global one, so omitting it would let a
 *   per-workspace `ANTHROPIC_API_KEY` be suppressed and billed around.
 */
function buildSummaryRoutingOptions(
  options: WorktreeSummaryGeneratorOptions,
  workOwner: WorkOwner | null,
): {
  allowNoNativeAuthFallback: boolean;
  workspaceId?: string;
  workOwner: WorkOwner | null;
} {
  return {
    allowNoNativeAuthFallback: options.userInitiated === true,
    ...(options.projectId !== undefined
      ? { workspaceId: options.projectId }
      : {}),
    workOwner,
  };
}

export async function generateWorktreeSummary(
  options: WorktreeSummaryGeneratorOptions,
): Promise<WorktreeSummaryResult> {
  const workOwner =
    (await resolveInvocationWorkOwner({
      ...(options.projectId ? { projectId: options.projectId } : {}),
    })) ?? null;
  const systemPrompt = buildSystemPrompt(options);
  const userMessage = buildUserMessage(options);
  const useCodex = getExecutionHarnessForModel(options.model) === 'codex';
  let accumulatedUsage: HelperUsage = {};

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await runHelperThroughWorker({
        kind: 'worktree_summary',
        model: options.model,
        scope: { workspaceId: options.projectId },
        origin: options.userInitiated === true ? 'client' : 'system',
        workOwner: workOwner,
        launch: async () =>
          useCodex
            ? await runCodexSummaryQuery(
                options,
                systemPrompt,
                userMessage,
                workOwner,
              )
            : await runClaudeSummaryQuery(
                options,
                systemPrompt,
                userMessage,
                workOwner,
              ),
        usageOf: (r) => r.usage,
      });
      accumulatedUsage = mergeHelperUsage(accumulatedUsage, result.usage);
      if (!result.generated) {
        continue;
      }

      const summary = hydrateGeneratedSummary(result.generated, options);
      if (isWorktreeSummaryData(summary)) {
        return {
          summary,
          displayLabel: readDisplayLabelCandidate(result.generated, options),
          usage: accumulatedUsage,
        };
      }
    } catch (error) {
      accumulatedUsage = mergeHelperUsage(
        accumulatedUsage,
        readHelperUsage(error) ?? {},
      );
      if (isTransientAgentRetryExhaustedError(error)) {
        break;
      }
      // Retry once before giving up.
    }
  }

  return { summary: null, displayLabel: null, usage: accumulatedUsage };
}

function readDisplayLabelCandidate(
  generated: GeneratedWorktreeSummary,
  options: WorktreeSummaryGeneratorOptions,
): GeneratedWorktreeLabelCandidate | null {
  if (!options.displayLabelRequest || !generated.displayLabelClarity) {
    return null;
  }
  return {
    label: generated.displayLabel ?? '',
    clarity: generated.displayLabelClarity,
  };
}

function seedWorktreeSummaryTranscript(
  taskKey: string | undefined,
  provider: AgentProviderType,
  userMessage: string,
  submittedText: string,
  systemPrompt: string,
): void {
  if (!taskKey) {
    return;
  }

  getExecutionObservabilityIngest().seedTranscript(taskKey, {
    provider,
    originalText: userMessage,
    submittedText,
    planMode: false,
    injectedPrompts: [
      {
        kind: 'system_prompt_append',
        provider,
        applicationCondition: 'helper_task_system_prompt',
        text: systemPrompt,
      },
    ],
  });
}

function appendWorktreeSummaryTranscriptEvent(
  taskKey: string | undefined,
  event: unknown,
): void {
  if (!taskKey) {
    return;
  }

  getExecutionObservabilityIngest().appendTranscriptRecord(taskKey, event);
}

function updateWorktreeSummaryRetryMetadata(
  taskKey: string | undefined,
  patch: { attempt?: number; sdkSessionId?: string },
): void {
  if (!taskKey) {
    return;
  }
  getExecutionObservabilityIngest().updateObservedTask(taskKey, patch);
}

function buildSystemPrompt(options: WorktreeSummaryGeneratorOptions): string {
  const refreshMode = options.isFullRefresh ? 'full' : 'incremental';
  const isFolderActivity = options.changeInputKind === 'folder-activity';
  const scope = isFolderActivity
    ? 'project folder'
    : options.isMultiRepo
      ? 'multi-repo project'
      : 'worktree';
  const repoInstruction = options.isMultiRepo
    ? 'When repos are provided, include a concise `repos` array summarizing each repository.'
    : 'Do not invent repository summaries when only one repo is present.';

  return [
    `You generate concise persistent ${scope} summaries.`,
    `This is a ${refreshMode} refresh.`,
    isFolderActivity
      ? 'Focus on the current state of the project folder, active work, and the most important recent changes.'
      : 'Focus on the current user-visible state of the branch, active implementation work, and the most important recent changes.',
    isFolderActivity
      ? 'Use the chat excerpts to capture intent and the folder activity listing to capture concrete file changes.'
      : 'Use the chat excerpts to capture intent and the git diff to capture concrete code changes.',
    'Return JSON only.',
    'The title should be short and specific.',
    'The description should be 1-3 sentences.',
    'The highlights array should contain 2-5 concrete bullets as plain strings.',
    repoInstruction,
    ...(options.displayLabelRequest
      ? [GENERATED_WORKTREE_LABEL_INSTRUCTIONS]
      : []),
    // This summary is a plaintext search abstract that may be synced to the
    // Canopy server (CAN-402), so it must never leak sensitive data.
    'Never include secrets, credentials, API keys, access tokens, passwords, private keys, connection strings, or personal data such as email addresses or IP addresses. Describe that a credential or secret exists without reproducing its value.',
  ].join('\n\n');
}

function buildUserMessage(options: WorktreeSummaryGeneratorOptions): string {
  const parts: string[] = [
    `Current user turn count: ${options.currentTurnCount}`,
    '',
  ];
  if (options.worktreeContext?.trim()) {
    parts.push('## Worktree', options.worktreeContext.trim(), '');
  }
  const provisionalLabel = options.displayLabelRequest?.provisionalLabel;
  if (provisionalLabel) {
    parts.push(
      '## Current display label',
      `"${provisionalLabel}" was generated before the purpose was settled. Keep it or replace it.`,
      '',
    );
  }
  parts.push(
    '## Chat excerpts',
    options.chatExcerpts.trim() || '(no chat excerpts available)',
    '',
    options.changeInputKind === 'folder-activity'
      ? '## Folder activity'
      : '## Git diff',
    options.gitDiff.trim() ||
      (options.changeInputKind === 'folder-activity'
        ? '(no recent folder activity available)'
        : '(no git diff available)'),
  );

  if (!options.isFullRefresh && options.previousSummary) {
    parts.push(
      '',
      '## Previous summary',
      JSON.stringify(
        {
          title: options.previousSummary.title,
          description: options.previousSummary.description,
          highlights: options.previousSummary.highlights,
          repos: options.previousSummary.repos,
          generatedAt: options.previousSummary.generatedAt,
          turnCountAtGeneration: options.previousSummary.turnCountAtGeneration,
        },
        null,
        2,
      ),
    );
  }

  if (
    options.isMultiRepo &&
    options.repoDiffs &&
    options.repoDiffs.length > 0
  ) {
    parts.push('', '## Repository diffs');
    for (const repoDiff of options.repoDiffs) {
      parts.push(
        `### ${repoDiff.name}`,
        repoDiff.diff.trim() || '(no diff available)',
        '',
      );
    }
  }

  return parts.join('\n');
}

async function runClaudeSummaryQuery(
  options: WorktreeSummaryGeneratorOptions,
  systemPrompt: string,
  userMessage: string,
  workOwner: WorkOwner | null,
): Promise<InternalQueryResult> {
  assertHelperWorkerContext('runClaudeSummaryQuery');
  // Same routing options as the Codex branch below, and load-bearing here in
  // particular: `generateWorktreeSummary` dispatches on the model's provider and
  // the default `worktreeSummaryModel` is a Claude one, so this is the path a
  // stock configuration actually takes (ECW-9091 review round 6).
  const invocation = await resolveHelperInvocation(
    options.model,
    undefined,
    buildSummaryRoutingOptions(options, workOwner),
  );
  try {
    if (options.observabilityTaskKey) {
      markObservedHelperTaskAiCreditsRouted(
        options.observabilityTaskKey,
        invocation.aiCreditsRouted,
        invocation.accountProxyRouted === true,
      );
    }
    const pluginRuntime =
      options.pluginRuntime ?? emptyHelperAgentPluginRuntime();
    const summaryPluginRuntime = withoutHelperAgentMcpServers(pluginRuntime);
    seedWorktreeSummaryTranscript(
      options.observabilityTaskKey,
      invocation.providerType,
      userMessage,
      userMessage,
      systemPrompt,
    );
    const preferences = await readPreferencesFile().catch(() => null);
    if (
      preferences?.canopyBackgroundProcessesMode === 'terminal' &&
      invocation.harness === 'claude' &&
      pluginRuntime.claudePlugins.length === 0
    ) {
      const workerResult = await runStructuredHelper({
        kind: 'worktree_summary',
        label: 'Worktree Summary',
        repoPath: options.cwd,
        model: invocation.sdkModel ?? options.model,
        provider: invocation.providerType === 'ollama' ? 'ollama' : 'claude',
        executionHarness: invocation.harness,
        maxTurns: 10,
        systemPrompt,
        userMessage,
        schema: summarySchemaFor(options),
        thinkingLevel: options.thinkingLevel,
        workspaceId: options.projectId,
        localMemoryEnabled: preferences?.localMemoryEnabled === true,
        claudeEnvOverride: invocation.envOverride,
        waitForQuotaRecovery: invocation.waitForQuotaRecovery,
        pluginRuntime: summaryPluginRuntime,
        isResult: isGeneratedWorktreeSummary,
        transcriptObserver: {
          seed: (): void => undefined,
          appendEvent: (event): void =>
            appendWorktreeSummaryTranscriptEvent(
              options.observabilityTaskKey,
              event,
            ),
          markAttempt: (attempt): void =>
            updateWorktreeSummaryRetryMetadata(options.observabilityTaskKey, {
              attempt,
            }),
          markSessionId: (sdkSessionId): void =>
            updateWorktreeSummaryRetryMetadata(options.observabilityTaskKey, {
              sdkSessionId,
            }),
        },
        permission: structuredHelperReadOnlyPermission(),
        settingSources: ['user', 'project', 'local'],
      });
      return {
        generated: workerResult.value
          ? sanitizeGeneratedSummary(workerResult.value)
          : null,
        usage: workerResult.usage,
      };
    }
    const effectiveModel = invocation.sdkModel ?? options.model;
    let resumeSessionId: string | undefined;
    updateWorktreeSummaryRetryMetadata(options.observabilityTaskKey, {
      attempt: 1,
    });
    return runWithTransientAgentRetry({
      waitForQuotaRecovery: invocation.waitForQuotaRecovery,
      provider: invocation.providerType,
      model: effectiveModel,
      runAttempt: async (captureEvent) => {
        const thinkingOptions = buildClaudeThinkingOptions(
          options.thinkingLevel,
        );
        const summaryPlugins = summaryPluginRuntime.claudePlugins.map(
          (plugin) => ({
            ...plugin,
            skipMcpDiscovery: true,
          }),
        );
        const claudeModAdmission = await resolveClaudeModAdmissionLaunch({
          cwd: options.cwd,
          settingSources: ['user', 'project', 'local'],
          plugins: summaryPlugins,
          environment: {
            runtime: 'agent',
            ...(options.projectId ? { workspaceId: options.projectId } : {}),
          },
          ...(invocation.envOverride?.CLAUDE_CONFIG_DIR !== undefined
            ? { claudeConfigDir: invocation.envOverride.CLAUDE_CONFIG_DIR }
            : {}),
        });
        const queryPlugins = (
          claudeModAdmission ? claudeModAdmission.plugins : summaryPlugins
        ).map((plugin) => ({
          type: plugin.type,
          path: plugin.path,
          skipMcpDiscovery: true,
        }));
        const nativeMemoryOptions = claudeNativeMemoryOptions(
          preferences?.localMemoryEnabled === true,
          thinkingOptions.settings,
        );
        const admissionSettings = claudeModAdmission?.settings
          ? mergeClaudeModAdmissionSettings(
              nativeMemoryOptions.settings ?? {},
              claudeModAdmission.settings,
            )
          : undefined;
        const queryResult = claudeQuery({
          prompt: resumeSessionId
            ? AGENT_TRANSIENT_RETRY_CONTINUE_PROMPT
            : userMessage,
          options: {
            cwd: options.cwd,
            model: effectiveModel,
            pathToClaudeCodeExecutable: getBundledClaudeBinaryPath(),
            spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
            env: {
              ...getEnhancedEnv({
                environment: {
                  runtime: 'agent',
                  ...(options.projectId
                    ? { workspaceId: options.projectId }
                    : {}),
                },
              }),
              ...(invocation.envOverride ?? {}),
            },
            sandbox: {
              ripgrep: {
                command: getBundledRgBinaryPath(),
              },
            },
            // Read-only by construction, as on the terminal-worker path; plan
            // mode would still offer plan-exit and agent tools.
            tools: [...READ_ONLY_TOOLS],
            allowedTools: [...READ_ONLY_TOOLS],
            settingSources: ['user', 'project', 'local'],
            strictMcpConfig: true,
            systemPrompt,
            ...(queryPlugins.length > 0 ? { plugins: queryPlugins } : {}),
            ...thinkingOptions,
            // Merge with the thinking settings (Ultra sets `ultracode`) so the
            // spread cannot drop the native-memory suppression applied while
            // local memory is enabled (CAN-1969).
            ...nativeMemoryOptions,
            ...(admissionSettings ? { settings: admissionSettings } : {}),
            outputFormat: {
              type: 'json_schema',
              schema: summarySchemaFor(options),
            },
            ...(resumeSessionId ? { resume: resumeSessionId } : {}),
          },
        });

        const usage: HelperUsage = {};
        let pendingErrorMessage: string | undefined;
        for await (const event of queryResult) {
          captureEvent(event);
          appendWorktreeSummaryTranscriptEvent(
            options.observabilityTaskKey,
            event,
          );
          const eventSessionId = readClaudeRetrySessionId(event);
          if (eventSessionId) {
            resumeSessionId = eventSessionId;
            updateWorktreeSummaryRetryMetadata(options.observabilityTaskKey, {
              sdkSessionId: eventSessionId,
            });
          }
          if (!isRecord(event) || event.type !== 'result') {
            const streamError = formatClaudeStreamError(event);
            if (streamError) {
              pendingErrorMessage ??= streamError;
            }
            continue;
          }

          if (isRecord(event.usage)) {
            usage.inputTokens =
              typeof event.usage.input_tokens === 'number'
                ? event.usage.input_tokens
                : undefined;
            usage.outputTokens =
              typeof event.usage.output_tokens === 'number'
                ? event.usage.output_tokens
                : undefined;
            usage.cacheReadInputTokens =
              typeof event.usage.cache_read_input_tokens === 'number'
                ? event.usage.cache_read_input_tokens
                : undefined;
            usage.cacheCreationInputTokens =
              typeof event.usage.cache_creation_input_tokens === 'number'
                ? event.usage.cache_creation_input_tokens
                : undefined;
          }
          if (typeof event.total_cost_usd === 'number') {
            usage.totalCostUsd = event.total_cost_usd;
          }
          usage.messageCount = 1;
          usage.assistantMessageCount = 1;
          const streamError = formatClaudeStreamError(event);
          if (streamError) {
            throw new StructuredHelperQueryError(streamError, usage);
          }
          if (pendingErrorMessage) {
            throw new StructuredHelperQueryError(pendingErrorMessage, usage);
          }

          const structuredOutput = getRecordValue(event, 'structured_output');
          if (isGeneratedWorktreeSummary(structuredOutput)) {
            return {
              generated: sanitizeGeneratedSummary(structuredOutput),
              usage,
            };
          }

          const rawResultValue = getRecordValue(event, 'result');
          const rawResult =
            typeof rawResultValue === 'string' ? rawResultValue : '';
          const parsed = tryParseJson(rawResult);
          if (isGeneratedWorktreeSummary(parsed)) {
            return { generated: sanitizeGeneratedSummary(parsed), usage };
          }
        }

        if (pendingErrorMessage) {
          throw new StructuredHelperQueryError(pendingErrorMessage, usage);
        }
        return { generated: null, usage };
      },
      onRetry: (notice) =>
        updateWorktreeSummaryRetryMetadata(options.observabilityTaskKey, {
          attempt: notice.nextAttempt,
        }),
    });
  } finally {
    invocation.dispose?.();
  }
}

async function runCodexSummaryQuery(
  options: WorktreeSummaryGeneratorOptions,
  systemPrompt: string,
  userMessage: string,
  workOwner: WorkOwner | null,
): Promise<InternalQueryResult> {
  const pluginRuntime =
    options.pluginRuntime ?? emptyHelperAgentPluginRuntime();
  const summaryPluginRuntime = withoutHelperAgentMcpServers(pluginRuntime);
  const invocation = await resolveHelperInvocation(
    options.model,
    undefined,
    buildSummaryRoutingOptions(options, workOwner),
  );
  try {
    if (options.observabilityTaskKey) {
      markObservedHelperTaskAiCreditsRouted(
        options.observabilityTaskKey,
        invocation.aiCreditsRouted,
        invocation.accountProxyRouted === true,
      );
    }
    const submittedText = [
      systemPrompt,
      '',
      userMessage,
      '',
      'Respond with ONLY a JSON object matching this shape:',
      options.displayLabelRequest
        ? '{"title":"...","description":"...","highlights":["..."],"repos":[{"name":"...","description":"..."}],"displayLabel":"...","displayLabelClarity":"clear|provisional|unclear"}'
        : '{"title":"...","description":"...","highlights":["..."],"repos":[{"name":"...","description":"..."}]}',
    ].join('\n');
    seedWorktreeSummaryTranscript(
      options.observabilityTaskKey,
      invocation.providerType,
      userMessage,
      submittedText,
      systemPrompt,
    );
    const result = await codexStructuredHelperRunner.run({
      repoPath: options.cwd,
      model: invocation.sdkModel ?? options.model,
      systemPrompt,
      userMessage,
      combinedPrompt: submittedText,
      schema: summarySchemaFor(options),
      thinkingLevel: options.thinkingLevel,
      modelConfig: options.modelConfig,
      workspaceId: options.projectId,
      localMemoryEnabled: await readLocalMemoryEnabledPreference(),
      pluginRuntime: summaryPluginRuntime,
      codexConfigOverride: invocation.codexConfig,
      waitForQuotaRecovery: invocation.waitForQuotaRecovery,
      transcriptObserver: options.observabilityTaskKey
        ? {
            seed: (): void => undefined,
            appendEvent: (event): void =>
              appendWorktreeSummaryTranscriptEvent(
                options.observabilityTaskKey,
                event,
              ),
            markAttempt: (attempt): void =>
              updateWorktreeSummaryRetryMetadata(options.observabilityTaskKey, {
                attempt,
              }),
            markSessionId: (sdkSessionId): void =>
              updateWorktreeSummaryRetryMetadata(options.observabilityTaskKey, {
                sdkSessionId,
              }),
          }
        : undefined,
      isResult: isGeneratedWorktreeSummary,
    });
    return {
      generated: result.value ? sanitizeGeneratedSummary(result.value) : null,
      usage: result.usage,
    };
  } finally {
    invocation.dispose?.();
  }
}

function hydrateGeneratedSummary(
  summary: GeneratedWorktreeSummary,
  options: WorktreeSummaryGeneratorOptions,
): WorktreeSummaryData {
  const now = new Date().toISOString();
  const lastFullRefreshAt = options.isFullRefresh
    ? now
    : (options.previousSummary?.lastFullRefreshAt ?? now);
  const lastFullRefreshTurnCount = options.isFullRefresh
    ? options.currentTurnCount
    : (options.previousSummary?.lastFullRefreshTurnCount ??
      options.currentTurnCount);

  const nextSummary: WorktreeSummaryData = {
    title: summary.title,
    description: summary.description,
    highlights: summary.highlights,
    generatedAt: now,
    turnCountAtGeneration: options.currentTurnCount,
    lastFullRefreshAt,
    lastFullRefreshTurnCount,
  };

  if (summary.repos && summary.repos.length > 0) {
    nextSummary.repos = summary.repos;
  }

  return nextSummary;
}

function sanitizeGeneratedSummary(
  summary: GeneratedWorktreeSummary,
): GeneratedWorktreeSummary {
  const sanitized: GeneratedWorktreeSummary = {
    title: summary.title.trim(),
    description: summary.description.trim(),
    highlights: summary.highlights
      .map((highlight) => highlight.trim())
      .filter((highlight) => highlight.length > 0),
  };
  if (summary.displayLabelClarity) {
    sanitized.displayLabelClarity = summary.displayLabelClarity;
    sanitized.displayLabel = summary.displayLabel?.trim() ?? '';
  }

  if (summary.repos) {
    const repos = summary.repos
      .map((repo) => ({
        name: repo.name.trim(),
        description: repo.description.trim(),
      }))
      .filter((repo) => repo.name.length > 0 && repo.description.length > 0);
    if (repos.length > 0) {
      sanitized.repos = repos;
    }
  }

  return sanitized;
}

function isGeneratedWorktreeSummary(
  value: unknown,
): value is GeneratedWorktreeSummary {
  if (!isRecord(value)) {
    return false;
  }

  const title = value.title;
  const description = value.description;
  const highlights = value.highlights;
  const repos = value.repos;

  return (
    typeof title === 'string' &&
    title.trim().length > 0 &&
    typeof description === 'string' &&
    description.trim().length > 0 &&
    Array.isArray(highlights) &&
    highlights.every(
      (entry) => typeof entry === 'string' && entry.trim().length > 0,
    ) &&
    (repos === undefined ||
      (Array.isArray(repos) && repos.every(isGeneratedRepoSummary))) &&
    (value.displayLabel === undefined ||
      typeof value.displayLabel === 'string') &&
    (value.displayLabelClarity === undefined ||
      isDisplayLabelClarity(value.displayLabelClarity))
  );
}

function isDisplayLabelClarity(
  value: unknown,
): value is GeneratedWorktreeLabelClarity {
  return DISPLAY_LABEL_CLARITIES.some((clarity) => clarity === value);
}

function isGeneratedRepoSummary(value: unknown): value is WorktreeRepoSummary {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    typeof value.description === 'string' &&
    value.description.trim().length > 0
  );
}

function tryParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const jsonText = fencedMatch?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function getRecordValue(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}
