import { runHelperThroughWorker } from '../helper-runs/helper-runs';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import {
  type AgentModelConfig,
  type AgentProviderType,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import {
  buildHelperInjectedPrompts,
  type HelperTranscriptObserver,
} from '@canopy/desktop-shared/lib/helper-transcript';
import {
  readHelperUsage,
  type HelperUsage,
} from '@canopy/execution-engine/lib/helper-usage';
import { validateAutomationTrigger } from '@canopy/desktop-shared/lib/automations';
import { isRecord } from '../lib/type-guards';
import {
  finalizeObservedHelperTask,
  startObservedHelperTask,
} from '../lib/helper-observed-task';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import { readLocalMemoryEnabledPreference } from '../lib/preferences-store';
import {
  codexStructuredHelperRunner,
  runDesktopClaudeStructuredHelperQuery,
} from '../integration/structured-helper-dispatch';
import { spawnClaudeCodeProcessOffMain } from '../agents/claude-process-host-runner';
import {
  resolveHelperInvocation,
  type HelperInvocation,
} from '../ollama/helper-invocation';
import { markObservedHelperTaskAiCreditsRouted } from '../lib/helper-observed-task';

export interface GenerateCronExpressionInput {
  description: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  modelConfig?: AgentModelConfig;
}

export interface GenerateCronExpressionResult {
  expression: string;
}

interface CronGenerationProviderResult extends GenerateCronExpressionResult {
  usage: HelperUsage;
}

const CRON_GENERATION_SCHEMA: Record<string, JsonValue> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    expression: {
      type: 'string',
      description:
        'A valid five-field cron expression: minute hour day-of-month month day-of-week.',
    },
  },
  required: ['expression'],
};

const SYSTEM_PROMPT = [
  'You convert natural-language recurring schedule descriptions into five-field cron expressions.',
  'Return only JSON that matches the provided schema.',
  'The expression must use exactly five fields: minute, hour, day-of-month, month, day-of-week.',
  'Use numeric cron syntax only: *, */N, A, A-B, A-B/N, and comma-separated combinations.',
  'Do not use seconds, years, @daily aliases, named weekdays, named months, L, W, or # syntax.',
  "Assume the schedule is evaluated in the user's local timezone.",
  'If the description is ambiguous, choose the most conventional interpretation.',
].join('\n');

function userPrompt(description: string): string {
  return [
    'Create one valid five-field cron expression for this schedule.',
    '',
    'Trigger schedule description:',
    description,
  ].join('\n');
}

function isCronGenerationResult(
  value: unknown,
): value is GenerateCronExpressionResult {
  return isRecord(value) && typeof value.expression === 'string';
}

function validateGeneratedExpression(expression: string): string | null {
  return validateAutomationTrigger({
    kind: 'cron',
    expression: expression.trim(),
    timezone: 'local',
  });
}

function seedCronGenerationTranscript(
  taskKey: string,
  provider: AgentProviderType,
  originalText: string,
  submittedText: string,
): void {
  getExecutionObservabilityIngest().seedTranscript(taskKey, {
    provider,
    originalText,
    submittedText,
    planMode: false,
    injectedPrompts: buildHelperInjectedPrompts(provider, SYSTEM_PROMPT),
  });
}

function appendCronGenerationTranscriptEvent(
  taskKey: string,
  event: unknown,
): void {
  getExecutionObservabilityIngest().appendTranscriptRecord(taskKey, event);
}

function cronTranscriptObserver(taskKey: string): HelperTranscriptObserver {
  return {
    seed: (): void => undefined,
    appendEvent: (event: unknown): void =>
      appendCronGenerationTranscriptEvent(taskKey, event),
    markAttempt: (attempt: number): void =>
      getExecutionObservabilityIngest().updateObservedTask(taskKey, {
        attempt,
      }),
    markSessionId: (sdkSessionId: string): void =>
      getExecutionObservabilityIngest().updateObservedTask(taskKey, {
        sdkSessionId,
      }),
  };
}

export async function generateCronExpression(
  input: GenerateCronExpressionInput,
): Promise<GenerateCronExpressionResult> {
  const description = input.description.trim();
  if (!description) {
    throw new Error('Trigger schedule description is required.');
  }

  const taskKey = `helper:cron-generation:${randomUUID()}`;
  startObservedHelperTask({
    taskKey,
    eventType: 'cron_generation',
    label: 'Cron Generation',
    model: input.model,
    modelConfig: input.modelConfig,
  });

  let disposeInvocation: (() => void) | undefined;
  try {
    const invocation = await resolveHelperInvocation(input.model);
    disposeInvocation = invocation.dispose;
    markObservedHelperTaskAiCreditsRouted(
      taskKey,
      invocation.aiCreditsRouted,
      invocation.accountProxyRouted === true,
    );
    const result = await runHelperThroughWorker({
      kind: 'cron_generation',
      model: input.model,
      scope: {},
      origin: 'client',
      launch: async () =>
        invocation.harness === 'codex'
          ? await generateWithCodex(input, description, taskKey, invocation)
          : await generateWithClaude(input, description, taskKey, invocation),
      usageOf: (r) => r.usage,
    });

    const validationError = validateGeneratedExpression(result.expression);
    if (validationError) {
      throw new Error(
        `Generated cron expression is invalid: ${validationError}`,
      );
    }

    finalizeObservedHelperTask(taskKey, 'success', undefined, result.usage);
    return { expression: result.expression.trim() };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    finalizeObservedHelperTask(
      taskKey,
      'failure',
      detail,
      readHelperUsage(error),
    );
    throw error;
  } finally {
    disposeInvocation?.();
  }
}

async function generateWithClaude(
  input: GenerateCronExpressionInput,
  description: string,
  taskKey: string,
  invocation: HelperInvocation,
): Promise<CronGenerationProviderResult> {
  const prompt = userPrompt(description);
  seedCronGenerationTranscript(
    taskKey,
    invocation.providerType,
    description,
    prompt,
  );

  const queryResult = await runDesktopClaudeStructuredHelperQuery({
    spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
    repoPath: app.getPath('userData'),
    model: invocation.sdkModel ?? input.model,
    provider: invocation.providerType === 'ollama' ? 'ollama' : 'claude',
    maxTurns: 1,
    systemPrompt: SYSTEM_PROMPT,
    userMessage: prompt,
    thinkingLevel: input.thinkingLevel,
    localMemoryEnabled: await readLocalMemoryEnabledPreference(),
    schema: CRON_GENERATION_SCHEMA,
    isResult: isCronGenerationResult,
    transcriptObserver: cronTranscriptObserver(taskKey),
    claudeEnvOverride: invocation.envOverride,
    waitForQuotaRecovery: invocation.waitForQuotaRecovery,
  });
  if (!queryResult.value) {
    throw new Error('Cron generator did not return a cron expression.');
  }
  return { ...queryResult.value, usage: queryResult.usage };
}

async function generateWithCodex(
  input: GenerateCronExpressionInput,
  description: string,
  taskKey: string,
  invocation: HelperInvocation,
): Promise<CronGenerationProviderResult> {
  const prompt = userPrompt(description);
  seedCronGenerationTranscript(
    taskKey,
    invocation.providerType,
    description,
    prompt,
  );
  const outcome = await codexStructuredHelperRunner.run({
    repoPath: app.getPath('userData'),
    model: invocation.sdkModel ?? input.model,
    systemPrompt: SYSTEM_PROMPT,
    userMessage: prompt,
    combinedPrompt: prompt,
    schema: CRON_GENERATION_SCHEMA,
    thinkingLevel: input.thinkingLevel,
    modelConfig: input.modelConfig,
    localMemoryEnabled: await readLocalMemoryEnabledPreference(),
    transcriptObserver: cronTranscriptObserver(taskKey),
    isResult: isCronGenerationResult,
    codexConfigOverride: invocation.codexConfig,
    waitForQuotaRecovery: invocation.waitForQuotaRecovery,
  });
  if (!outcome.value) {
    throw new Error('Cron generator did not return a cron expression.');
  }
  return {
    ...outcome.value,
    usage: outcome.usage,
  };
}
