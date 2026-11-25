import { runHelperThroughWorker } from '../helper-runs/helper-runs';
import {
  isDataModelDiffGenerationResult,
  isLogicDiffDiagram,
  isParsedPlanGraph,
  type AgentModelConfig,
  type ChatModel,
  type DataModelDiffGenerationResult,
  type LogicDiffDiagram,
  type ParsedPlanGraph,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { runCodexStructuredHelperQuery } from '@canopy/desktop-shared/lib/structured-helper-query';
import {
  LOGIC_DIFF_DIAGRAM_JSON_SCHEMA,
  PARSED_PLAN_GRAPH_JSON_SCHEMA,
  DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA,
  buildDataModelDiffSystemPrompt,
  buildLogicDiffSystemPrompt,
  buildPlanDiagramUserPrompt,
  buildSequenceDiagramSystemPrompt,
} from '@canopy/desktop-shared/lib/plan-diagram-prompts';
import type { HelperTranscriptObserver } from '@canopy/desktop-shared/lib/helper-transcript';
import type { HelperUsage } from '../agents/utils';
import { resolveHelperInvocation } from '../ollama/helper-invocation';
import { readLocalMemoryEnabledPreference } from './preferences-store';
import {
  codexStructuredHelperRunner,
  runDesktopClaudeStructuredHelperQuery,
} from '../integration/structured-helper-dispatch';
import { spawnClaudeCodeProcessOffMain } from '../agents/claude-process-host-runner';

interface PlanDiagramGeneratorBaseOptions {
  /**
   * True when the user clicked Generate/Refresh (the scheduler's `immediate`
   * path, reached from the `trackedPlansGenerateDiagrams` IPC handler), false
   * for the debounced content-change trigger. Gates whether an absent native
   * login may spend AI Credits (ECW-9091 review round 8).
   */
  userInitiated?: boolean;
  planText: string;
  repoPath: string;
  projectId: string;
  model: ChatModel;
  modelConfig?: AgentModelConfig;
  thinkingLevel: ThinkingLevel;
  transcriptObserver?: HelperTranscriptObserver;
}

export type GenerateSequenceDiagramOptions = PlanDiagramGeneratorBaseOptions;

export interface GenerateSequenceDiagramResult {
  value: ParsedPlanGraph | null;
  usage: HelperUsage;
}

/**
 * AI Credits routing options shared by every plan diagram helper call
 * (ECW-9091 review round 7).
 *
 * Plan diagrams run from two kinds of trigger. The core plan diagram scheduler
 * debounces content changes and fires with no user action at that moment — that
 * must never route through AI Credits merely because the user has no native
 * login, or a credits-only user's daily allowance can be consumed by background
 * work. But a person's `core.plan.diagram.generate` request — a user clicking
 * Generate — runs at once, and denying that would silently produce nothing.
 * `options.userInitiated` carries the distinction, from the caller's principal. Explicit routing modes and gateway-only models still route.
 *
 * `workspaceId` is equally load-bearing: the user-supplied-credential guard has
 * to resolve the same Canopy Environments assignment these helpers spawn with
 * (every call below already passes `workspaceId: options.projectId`), because a
 * workspace assignment REPLACES the global one rather than merging.
 */
function buildHelperRoutingOptions(options: PlanDiagramGeneratorBaseOptions): {
  allowNoNativeAuthFallback: boolean;
  workspaceId: string;
} {
  return {
    allowNoNativeAuthFallback: options.userInitiated === true,
    workspaceId: options.projectId,
  };
}

async function seedTranscript(
  options: PlanDiagramGeneratorBaseOptions,
  systemPrompt: string,
  userMessage: string,
  submittedText: string,
  provider: 'claude' | 'codex' | 'ollama',
): Promise<void> {
  await options.transcriptObserver?.seed({
    provider,
    originalText: userMessage,
    submittedText,
    systemPrompt,
  });
}

export async function generateSequenceDiagram(
  options: GenerateSequenceDiagramOptions,
): Promise<GenerateSequenceDiagramResult> {
  const systemPrompt = buildSequenceDiagramSystemPrompt();
  const userMessage = buildPlanDiagramUserPrompt(options.planText);
  const invocation = await resolveHelperInvocation(
    options.model,
    undefined,
    buildHelperRoutingOptions(options),
  );
  try {
    return await runHelperThroughWorker({
      kind: 'worktree_plan_diagram',
      model: options.model,
      scope: { workspaceId: options.projectId },
      origin: options.userInitiated === true ? 'client' : 'system',
      launch: async () => {
        if (invocation.harness === 'codex') {
          const combinedPrompt = `${systemPrompt}\n\n${userMessage}`;
          await seedTranscript(
            options,
            systemPrompt,
            userMessage,
            combinedPrompt,
            invocation.providerType,
          );
          const result = await runCodexStructuredHelperQuery<ParsedPlanGraph>({
            waitForQuotaRecovery: invocation.waitForQuotaRecovery,
            runner: codexStructuredHelperRunner,
            repoPath: options.repoPath,
            model: invocation.sdkModel ?? options.model,
            systemPrompt,
            userMessage,
            combinedPrompt,
            schema: PARSED_PLAN_GRAPH_JSON_SCHEMA,
            thinkingLevel: options.thinkingLevel,
            modelConfig: options.modelConfig,
            workspaceId: options.projectId,
            localMemoryEnabled: await readLocalMemoryEnabledPreference(),
            transcriptObserver: options.transcriptObserver,
            isResult: isParsedPlanGraph,
            ...(invocation.codexConfig
              ? { codexConfigOverride: invocation.codexConfig }
              : {}),
          });
          return { value: result.value, usage: result.usage };
        }

        await seedTranscript(
          options,
          systemPrompt,
          userMessage,
          userMessage,
          invocation.providerType,
        );
        const result =
          await runDesktopClaudeStructuredHelperQuery<ParsedPlanGraph>({
            spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
            repoPath: options.repoPath,
            model: invocation.sdkModel ?? options.model,
            provider:
              invocation.providerType === 'ollama' ? 'ollama' : 'claude',
            maxTurns: 50,
            systemPrompt,
            userMessage,
            schema: PARSED_PLAN_GRAPH_JSON_SCHEMA,
            thinkingLevel: options.thinkingLevel,
            workspaceId: options.projectId,
            localMemoryEnabled: await readLocalMemoryEnabledPreference(),
            transcriptObserver: options.transcriptObserver,
            isResult: isParsedPlanGraph,
            claudeEnvOverride: invocation.envOverride,
            waitForQuotaRecovery: invocation.waitForQuotaRecovery,
          });
        return { value: result.value, usage: result.usage };
      },
      usageOf: (r) => r.usage,
    });
  } finally {
    invocation.dispose?.();
  }
}

export type GenerateLogicDiffDiagramOptions = PlanDiagramGeneratorBaseOptions;

export interface GenerateLogicDiffDiagramResult {
  value: LogicDiffDiagram | null;
  usage: HelperUsage;
}

export async function generateLogicDiffDiagram(
  options: GenerateLogicDiffDiagramOptions,
): Promise<GenerateLogicDiffDiagramResult> {
  const systemPrompt = buildLogicDiffSystemPrompt();
  const userMessage = buildPlanDiagramUserPrompt(options.planText);
  const invocation = await resolveHelperInvocation(
    options.model,
    undefined,
    buildHelperRoutingOptions(options),
  );
  try {
    return await runHelperThroughWorker({
      kind: 'worktree_plan_diagram',
      model: options.model,
      scope: { workspaceId: options.projectId },
      origin: options.userInitiated === true ? 'client' : 'system',
      launch: async () => {
        if (invocation.harness === 'codex') {
          const combinedPrompt = `${systemPrompt}\n\n${userMessage}`;
          await seedTranscript(
            options,
            systemPrompt,
            userMessage,
            combinedPrompt,
            invocation.providerType,
          );
          const result = await runCodexStructuredHelperQuery<LogicDiffDiagram>({
            waitForQuotaRecovery: invocation.waitForQuotaRecovery,
            runner: codexStructuredHelperRunner,
            repoPath: options.repoPath,
            model: invocation.sdkModel ?? options.model,
            systemPrompt,
            userMessage,
            combinedPrompt,
            schema: LOGIC_DIFF_DIAGRAM_JSON_SCHEMA,
            thinkingLevel: options.thinkingLevel,
            modelConfig: options.modelConfig,
            workspaceId: options.projectId,
            localMemoryEnabled: await readLocalMemoryEnabledPreference(),
            transcriptObserver: options.transcriptObserver,
            isResult: isLogicDiffDiagram,
            ...(invocation.codexConfig
              ? { codexConfigOverride: invocation.codexConfig }
              : {}),
          });
          return { value: result.value, usage: result.usage };
        }

        await seedTranscript(
          options,
          systemPrompt,
          userMessage,
          userMessage,
          invocation.providerType,
        );
        const result =
          await runDesktopClaudeStructuredHelperQuery<LogicDiffDiagram>({
            spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
            repoPath: options.repoPath,
            model: invocation.sdkModel ?? options.model,
            provider:
              invocation.providerType === 'ollama' ? 'ollama' : 'claude',
            maxTurns: 50,
            systemPrompt,
            userMessage,
            schema: LOGIC_DIFF_DIAGRAM_JSON_SCHEMA,
            thinkingLevel: options.thinkingLevel,
            workspaceId: options.projectId,
            localMemoryEnabled: await readLocalMemoryEnabledPreference(),
            transcriptObserver: options.transcriptObserver,
            isResult: isLogicDiffDiagram,
            claudeEnvOverride: invocation.envOverride,
            waitForQuotaRecovery: invocation.waitForQuotaRecovery,
          });
        return { value: result.value, usage: result.usage };
      },
      usageOf: (r) => r.usage,
    });
  } finally {
    invocation.dispose?.();
  }
}

export type GenerateDataModelDiffDiagramOptions =
  PlanDiagramGeneratorBaseOptions;

export interface GenerateDataModelDiffDiagramResult {
  value: DataModelDiffGenerationResult | null;
  usage: HelperUsage;
}

export async function generateDataModelDiffDiagram(
  options: GenerateDataModelDiffDiagramOptions,
): Promise<GenerateDataModelDiffDiagramResult> {
  const systemPrompt = buildDataModelDiffSystemPrompt();
  const userMessage = buildPlanDiagramUserPrompt(options.planText);
  const invocation = await resolveHelperInvocation(
    options.model,
    undefined,
    buildHelperRoutingOptions(options),
  );
  try {
    return await runHelperThroughWorker({
      kind: 'worktree_plan_diagram',
      model: options.model,
      scope: { workspaceId: options.projectId },
      origin: options.userInitiated === true ? 'client' : 'system',
      launch: async () => {
        if (invocation.harness === 'codex') {
          const combinedPrompt = `${systemPrompt}\n\n${userMessage}`;
          await seedTranscript(
            options,
            systemPrompt,
            userMessage,
            combinedPrompt,
            invocation.providerType,
          );
          const result =
            await runCodexStructuredHelperQuery<DataModelDiffGenerationResult>({
              waitForQuotaRecovery: invocation.waitForQuotaRecovery,
              runner: codexStructuredHelperRunner,
              repoPath: options.repoPath,
              model: invocation.sdkModel ?? options.model,
              systemPrompt,
              userMessage,
              combinedPrompt,
              schema: DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA,
              thinkingLevel: options.thinkingLevel,
              modelConfig: options.modelConfig,
              workspaceId: options.projectId,
              localMemoryEnabled: await readLocalMemoryEnabledPreference(),
              transcriptObserver: options.transcriptObserver,
              isResult: isDataModelDiffGenerationResult,
              ...(invocation.codexConfig
                ? { codexConfigOverride: invocation.codexConfig }
                : {}),
            });
          return { value: result.value, usage: result.usage };
        }

        await seedTranscript(
          options,
          systemPrompt,
          userMessage,
          userMessage,
          invocation.providerType,
        );
        const result =
          await runDesktopClaudeStructuredHelperQuery<DataModelDiffGenerationResult>(
            {
              spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
              repoPath: options.repoPath,
              model: invocation.sdkModel ?? options.model,
              provider:
                invocation.providerType === 'ollama' ? 'ollama' : 'claude',
              maxTurns: 50,
              systemPrompt,
              userMessage,
              schema: DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA,
              thinkingLevel: options.thinkingLevel,
              workspaceId: options.projectId,
              localMemoryEnabled: await readLocalMemoryEnabledPreference(),
              transcriptObserver: options.transcriptObserver,
              isResult: isDataModelDiffGenerationResult,
              claudeEnvOverride: invocation.envOverride,
              waitForQuotaRecovery: invocation.waitForQuotaRecovery,
            },
          );
        return { value: result.value, usage: result.usage };
      },
      usageOf: (r) => r.usage,
    });
  } finally {
    invocation.dispose?.();
  }
}
