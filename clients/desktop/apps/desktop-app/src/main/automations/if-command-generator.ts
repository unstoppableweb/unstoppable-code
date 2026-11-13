import { runHelperThroughWorker } from '../helper-runs/helper-runs';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import {
  type AgentProviderType,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import { brandEnvName } from '@canopy/execution-engine/brand/env';
import {
  buildHelperInjectedPrompts,
  type HelperTranscriptObserver,
} from '@canopy/desktop-shared/lib/helper-transcript';
import {
  readHelperUsage,
  type HelperUsage,
} from '@canopy/execution-engine/lib/helper-usage';
import { isRecord } from '../lib/type-guards';
import {
  finalizeObservedHelperTask,
  startObservedHelperTask,
} from '../lib/helper-observed-task';
import { getExecutionObservabilityIngest } from '../observability/ingest';
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

export interface GenerateIfCommandInput {
  description: string;
  currentCommand?: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

export interface GenerateIfCommandResult {
  command: string;
}

interface IfCommandProviderResult extends GenerateIfCommandResult {
  usage: HelperUsage;
}

const IF_COMMAND_SCHEMA: Record<string, JsonValue> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: {
      type: 'string',
      description:
        'A shell script. Exit 0 to run the action; non-zero to skip it. Anything written to stdout is injected into the action prompt.',
    },
  },
  required: ['command'],
};

function shellEnvironmentPrompt(): string {
  if (process.platform === 'win32') {
    return [
      'The command runs on Windows using the same shell Automations use: PowerShell 7 (pwsh.exe) when available, Windows PowerShell otherwise, and cmd.exe as a final fallback.',
      'Prefer a readable multi-line PowerShell script on Windows unless the user explicitly asks for cmd/batch syntax.',
      'Use brief PowerShell comments with # to help label non-trivial steps. Place comments on their own lines above the relevant step.',
      'Avoid POSIX-only syntax such as test, grep, sed, awk, &&/|| shell chains, command substitution, and single-quoted bash strings unless the user explicitly requests a bash-compatible command.',
    ].join(' ');
  }

  return [
    'The command runs on macOS/Linux in a POSIX-style login shell (bash -lic on macOS) with the user PATH.',
    'Prefer a readable multi-line POSIX-compatible shell script unless the user explicitly asks for a one-liner or a platform-specific command.',
    'Use brief shell comments with # to help label non-trivial steps. Place comments on their own lines above the relevant step.',
  ].join(' ');
}

function systemPrompt(): string {
  const idempotencyKeyName = brandEnvName('IDEMPOTENCY_KEY');
  const idempotencyScopeName = brandEnvName('IDEMPOTENCY_SCOPE');
  return [
    'You convert natural-language descriptions into a shell script used as a pre-action gate for a scheduled automation.',
    'Return only JSON that matches the provided schema.',
    shellEnvironmentPrompt(),
    'Common CLI tools such as git, gh, curl, jq, and rg may be available, but do not assume the current working directory is a git checkout unless the command changes directories explicitly.',
    'Exit-code contract: exit 0 means RUN the action; any non-zero exit means SKIP the action this run.',
    'Whatever the command writes to stdout is captured and injected into the action prompt, so echo only the value the prompt should receive, except for the idempotency control lines below.',
    `Idempotency contract: when the command identifies a stable source/entity that should not be processed more than once, write ${idempotencyKeyName}=<stable-id> on its own stdout line. Use this for concrete entities such as PR URLs, issue ids, deployment ids, feed item ids, webhook/event ids, or similar durable records. The key line is stripped from the prompt-injected output.`,
    `Idempotency scope: write ${idempotencyScopeName}=global on its own stdout line only when the same source/entity should be deduped across all automations. Write ${idempotencyScopeName}=self or omit the scope for the default behavior, which dedupes only this automation. Scope values are case-insensitive. Invalid or empty scope values are ignored.`,
    'Prefer human-readable multi-line script output. Keep formatting simple and avoid dense chained expressions when separate lines make the logic clearer.',
    'Keep the script side-effect-free and fast. Do not require interactive input.',
    'If the description is ambiguous, choose the most conventional interpretation.',
  ].join('\n');
}

function userPrompt(description: string, currentCommand?: string): string {
  const currentValue = currentCommand?.trim();
  const prompt = [
    'Create one shell script for this gate.',
    '',
    'Current If Command value:',
    currentValue && currentValue.length > 0 ? currentValue : '(empty)',
    '',
    'This is the current value in the command field. The user may want to iterate on it or start over depending on their request.',
    '',
    'Gate description:',
    description,
  ];
  return prompt.join('\n');
}

function isIfCommandResult(value: unknown): value is GenerateIfCommandResult {
  return isRecord(value) && typeof value.command === 'string';
}

function seedTranscript(
  taskKey: string,
  provider: AgentProviderType,
  originalText: string,
  submittedText: string,
  prompt: string,
): void {
  getExecutionObservabilityIngest().seedTranscript(taskKey, {
    provider,
    originalText,
    submittedText,
    planMode: false,
    injectedPrompts: buildHelperInjectedPrompts(provider, prompt),
  });
}

function appendTranscriptEvent(taskKey: string, event: unknown): void {
  getExecutionObservabilityIngest().appendTranscriptRecord(taskKey, event);
}

function ifCommandTranscriptObserver(
  taskKey: string,
): HelperTranscriptObserver {
  return {
    seed: (): void => undefined,
    appendEvent: (event: unknown): void =>
      appendTranscriptEvent(taskKey, event),
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

export async function generateAutomationIfCommand(
  input: GenerateIfCommandInput,
): Promise<GenerateIfCommandResult> {
  const description = input.description.trim();
  if (!description) {
    throw new Error('If Command description is required.');
  }

  const taskKey = `helper:automation-if-command:${randomUUID()}`;
  startObservedHelperTask({
    taskKey,
    eventType: 'automation_if_command_generation',
    label: 'If Command Generation',
    model: input.model,
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
      kind: 'automation_if_command_generation',
      model: input.model,
      scope: {},
      origin: 'client',
      launch: async () =>
        invocation.harness === 'codex'
          ? await generateWithCodex(input, description, taskKey, invocation)
          : await generateWithClaude(input, description, taskKey, invocation),
      usageOf: (r) => r.usage,
    });

    const command = result.command.trim();
    if (!command) {
      throw new Error('If Command generator returned an empty command.');
    }

    finalizeObservedHelperTask(taskKey, 'success', undefined, result.usage);
    return { command };
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
  input: GenerateIfCommandInput,
  description: string,
  taskKey: string,
  invocation: HelperInvocation,
): Promise<IfCommandProviderResult> {
  const shellPrompt = systemPrompt();
  const prompt = userPrompt(description, input.currentCommand);
  seedTranscript(
    taskKey,
    invocation.providerType,
    description,
    prompt,
    shellPrompt,
  );

  const queryResult = await runDesktopClaudeStructuredHelperQuery({
    spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
    repoPath: app.getPath('userData'),
    model: invocation.sdkModel ?? input.model,
    provider: invocation.providerType === 'ollama' ? 'ollama' : 'claude',
    maxTurns: 1,
    systemPrompt: shellPrompt,
    userMessage: prompt,
    thinkingLevel: input.thinkingLevel,
    localMemoryEnabled: await readLocalMemoryEnabledPreference(),
    schema: IF_COMMAND_SCHEMA,
    isResult: isIfCommandResult,
    transcriptObserver: ifCommandTranscriptObserver(taskKey),
    claudeEnvOverride: invocation.envOverride,
    waitForQuotaRecovery: invocation.waitForQuotaRecovery,
  });
  if (!queryResult.value) {
    throw new Error('If Command generator did not return a command.');
  }
  return { ...queryResult.value, usage: queryResult.usage };
}

async function generateWithCodex(
  input: GenerateIfCommandInput,
  description: string,
  taskKey: string,
  invocation: HelperInvocation,
): Promise<IfCommandProviderResult> {
  const shellPrompt = systemPrompt();
  const prompt = userPrompt(description, input.currentCommand);
  seedTranscript(
    taskKey,
    invocation.providerType,
    description,
    prompt,
    shellPrompt,
  );
  const outcome = await codexStructuredHelperRunner.run({
    repoPath: app.getPath('userData'),
    model: invocation.sdkModel ?? input.model,
    systemPrompt: shellPrompt,
    userMessage: prompt,
    combinedPrompt: prompt,
    schema: IF_COMMAND_SCHEMA,
    thinkingLevel: input.thinkingLevel,
    localMemoryEnabled: await readLocalMemoryEnabledPreference(),
    transcriptObserver: ifCommandTranscriptObserver(taskKey),
    isResult: isIfCommandResult,
    codexConfigOverride: invocation.codexConfig,
    waitForQuotaRecovery: invocation.waitForQuotaRecovery,
  });
  if (!outcome.value) {
    throw new Error('If Command generator did not return a command.');
  }
  return {
    ...outcome.value,
    usage: outcome.usage,
  };
}
