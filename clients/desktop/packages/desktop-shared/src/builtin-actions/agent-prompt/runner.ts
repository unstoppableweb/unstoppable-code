import type { SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { parseAgentTranscriptLines } from '@canopy/agent-transcript';
import { redactStructuredValue } from '@canopy/execution-engine/lib/redaction';
import {
  getExecutionHarnessForModel,
  normalizeThinkingForProvider,
  stripOllamaModelPrefix,
  type AgentProviderType,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import {
  setOutput,
  setOutputPathOrWriteFile,
  writeOutputFile,
} from '../_lib/output';
import { runWithActionEnvironment } from '../_lib/action-env';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';
import {
  classifyAgentFailure,
  type AgentActionFailureMetadata,
} from '@canopy/execution-engine/agent-failures';
import { transcriptHasAgentActivity } from '@canopy/execution-engine/lib/usage-limit-resume-prompt';
import {
  appendUserOverallPreferencesBlock,
  buildPipelineGlobalInstructionsBlock,
} from '@canopy/execution-engine/lib/global-instructions';
import {
  buildPipelinePromptRecord,
  buildPipelineSystemPromptRecord,
  createTranscriptCapture,
  type TranscriptCapture,
} from '../_lib/agent-transcript';
import {
  AgentSessionStartupTimeoutError,
  withClaudeSessionStartupTimeout,
} from '../_lib/agent-session-startup';
import {
  applyPlanPromptRequirement,
  buildQueryOptions,
  extractClaudeProposedPlan,
  extractClaudeSessionId,
  extractFinalResult,
  getModelProviderInput,
  isFatalSdkEvent,
  parseAgentSecretValuesEnv,
  parseBooleanInput,
  parseClaudeSdkPluginsEnv,
  parseMaxTurns,
  parsePermissionPreset,
  parseSessionId,
  parseSettingSources,
  parseStructuredSchema,
  parseThinkingEffort,
  readPipelineLedgerTools,
  redactNormalizedPreservingFormat,
  redactNormalizedStructuredValue,
  redactNormalizedText,
  resolvePrompt,
  validateStructuredOutputInputs,
} from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';

type AgentActionMode = 'start' | 'resume';

interface CompletedAgentRun {
  rawText: string;
  structured?: unknown;
  proposedPlan?: string;
  sessionId: string;
  transcript: string;
}

class AgentRunFailure extends Error {
  constructor(
    readonly provider: AgentProviderType,
    readonly events: readonly unknown[],
    readonly transcript: string,
    readonly sessionId: string | undefined,
    readonly originalError: unknown,
  ) {
    super(formatErrorDetail(originalError));
    this.name = 'AgentRunFailure';
  }
}

function getActionLabel(mode: AgentActionMode): string {
  return mode === 'resume' ? 'agent-resume' : 'agent-prompt';
}

function createSilentTranscriptCapture(
  secretValues: readonly string[],
): TranscriptCapture {
  const lines: string[] = [];
  return {
    // See `createTranscriptCapture`'s doc comment (`_lib/agent-transcript.ts`)
    // for why this redacts BEFORE `JSON.stringify` rather than redacting the
    // already-serialized text afterward.
    emitRecord(record: unknown): void {
      const redactedRecord =
        secretValues.length === 0
          ? record
          : redactStructuredValue(record, secretValues);
      lines.push(JSON.stringify(redactedRecord));
    },
    serialize(): string {
      return lines.length > 0 ? `${lines.join('\n')}\n` : '';
    },
  };
}

function buildTranscriptCapture(
  streamEvents: boolean,
  secretValues: readonly string[],
): TranscriptCapture {
  return streamEvents
    ? createTranscriptCapture(secretValues)
    : createSilentTranscriptCapture(secretValues);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function runClaudePath(
  env: NodeJS.ProcessEnv,
  prompt: string,
  schema: Record<string, unknown> | undefined,
  effectiveMaxTurns: number,
  persistSession: boolean,
  actionMode: AgentActionMode,
  provider: 'claude' | 'ollama',
  streamEvents = true,
  thinkingLevel?: ThinkingLevel,
  settingSources?: SettingSource[],
): Promise<CompletedAgentRun> {
  const permissionPreset = parsePermissionPreset(env.INPUT_PERMISSION_PRESET);
  const resumeSessionId =
    actionMode === 'resume' ? parseSessionId(env.INPUT_SESSION_ID) : undefined;
  // Global Instructions (Instructions settings), pipelines section: resolved per
  // agent context and appended after the step's own system prompt.
  const effectiveSystemPrompt = resumeSessionId
    ? env.INPUT_SYSTEM_PROMPT
    : appendUserOverallPreferencesBlock(
        env.INPUT_SYSTEM_PROMPT,
        buildPipelineGlobalInstructionsBlock(
          getBrandEnv(env, 'PREF_GLOBAL_INSTRUCTIONS_PIPELINES'),
          { harness: provider, model: env.INPUT_MODEL ?? '' },
        ),
      );
  const secretValues = parseAgentSecretValuesEnv(
    getBrandEnv(env, 'AGENT_SECRET_VALUES'),
  );
  const transcript = buildTranscriptCapture(streamEvents, secretValues);
  transcript.emitRecord(
    buildPipelinePromptRecord({
      provider,
      originalText: prompt,
    }),
  );
  const systemPromptRecord = buildPipelineSystemPromptRecord(
    provider,
    effectiveSystemPrompt,
  );
  if (systemPromptRecord) {
    transcript.emitRecord(systemPromptRecord);
  }

  const events: unknown[] = [];
  const shutdownController = new AbortController();
  const stopForShutdown = (): void => shutdownController.abort();
  process.once('SIGTERM', stopForShutdown);
  try {
    const queryResult = claudeQuery({
      prompt,
      options: {
        abortController: shutdownController,
        ...buildQueryOptions({
          cwd: process.cwd(),
          maxTurns: effectiveMaxTurns,
          model:
            provider === 'ollama'
              ? stripOllamaModelPrefix(env.INPUT_MODEL ?? '')
              : // AI Credits routing: prefer the exact gateway model ID injected by the
                // main-process bridge. The `ANTHROPIC_*` proxy env flows in via
                // process.env automatically, so only the model id must change here.
                (getBrandEnv(env, 'AI_CREDITS_MODEL') ?? env.INPUT_MODEL),
          provider,
          permissionPreset,
          persistSession,
          resumeSessionId,
          settingSources,
          systemPrompt: effectiveSystemPrompt,
          schema,
          thinkingLevel,
          plugins: parseClaudeSdkPluginsEnv(
            getBrandEnv(env, 'CLAUDE_SDK_PLUGINS'),
          ),
          // Ollama routes have no tool support for the Ledger (LD07).
          ledgerTools:
            provider === 'claude' ? readPipelineLedgerTools(env) : undefined,
        }),
      },
    });

    for await (const sdkEvent of withClaudeSessionStartupTimeout(
      queryResult,
      env,
      getActionLabel(actionMode),
      actionMode,
    )) {
      const event: unknown = sdkEvent;
      transcript.emitRecord(event);
      events.push(event);

      const fatalError = isFatalSdkEvent(event);
      if (fatalError) {
        throw new Error(
          `Claude SDK fatal error: ${fatalError}. Model: ${env.INPUT_MODEL ?? '(default)'}`,
        );
      }

      // The Claude SDK result event is terminal for pipeline purposes. In
      // practice the underlying CLI can stay alive while background shell tasks
      // linger, so do not wait for the async iterator to close after this point.
      if (readRecord(event)?.type === 'result') {
        break;
      }
    }

    if (events.length === 0) {
      if (resumeSessionId) {
        throw new Error(`Failed to resume session "${resumeSessionId}"`);
      }
      throw new Error('Claude SDK stream ended without emitting any events');
    }

    const result = extractFinalResult(events, schema !== undefined);
    const sessionId = extractClaudeSessionId(events);

    return {
      rawText: result.rawText,
      structured: result.structured,
      proposedPlan: extractClaudeProposedPlan(events),
      sessionId,
      transcript: transcript.serialize(),
    };
  } catch (error) {
    let sessionId = resumeSessionId;
    if (!sessionId) {
      try {
        sessionId = extractClaudeSessionId(events);
      } catch {
        // A provider rejection can occur before the system/session event.
      }
    }
    throw new AgentRunFailure(
      provider,
      events,
      transcript.serialize(),
      sessionId,
      error,
    );
  } finally {
    process.removeListener('SIGTERM', stopForShutdown);
  }
}

function normalizeRequestedThinkingLevel(
  thinkingLevel: ThinkingLevel | undefined,
  provider: AgentProviderType,
  actionMode: AgentActionMode,
): ThinkingLevel | undefined {
  if (!thinkingLevel) {
    return undefined;
  }

  const normalized = normalizeThinkingForProvider(thinkingLevel, provider);
  if (normalized !== thinkingLevel) {
    const providerLabel =
      provider === 'codex'
        ? 'Codex'
        : provider === 'ollama'
          ? 'Ollama'
          : 'Claude';
    process.stderr.write(
      `${getActionLabel(actionMode)}: thinking_effort "${thinkingLevel}" is not supported for ${providerLabel}; using "${normalized}" instead\n`,
    );
  }

  return normalized;
}

/**
 * `result.transcript` reaches disk through stdout (`emitTranscript`/the
 * streaming `TranscriptCapture`), which the parent pipeline executor already
 * redacts as it pipes this subprocess's stdout into the step's log file — see
 * `SecretValueRedactor` in `executor/spawned-process.ts`. `rawText`/
 * `structured`/`proposedPlan` below are written directly to files by this
 * process instead, bypassing that parent-side redaction entirely, so they are
 * redacted here with the same value-based algorithm
 * (`getSecretValues(runStepOptions.secretEnv)` on the host side, threaded to
 * this subprocess via `AGENT_SECRET_VALUES`/`parseAgentSecretValuesEnv`).
 */
function writeAgentOutputs(
  env: NodeJS.ProcessEnv,
  result: CompletedAgentRun,
): void {
  const secretValues = parseAgentSecretValuesEnv(
    getBrandEnv(env, 'AGENT_SECRET_VALUES'),
  );
  // File copies keep their formatting but must not get weaker matching than
  // the inline field they copy: `redactNormalizedPreservingFormat` masks a
  // reflowed value while leaving every unmatched character (newlines,
  // indentation) exactly as written. `redactStructuredValue` had the same
  // verbatim-only gap for `json_response`, so the structured walker now
  // matches whitespace-insensitively too, substituting only leaves that
  // actually matched.
  const rawText = redactNormalizedPreservingFormat(
    result.rawText,
    secretValues,
  );
  const structured = redactNormalizedStructuredValue(
    result.structured,
    secretValues,
  );
  const proposedPlan =
    result.proposedPlan === undefined
      ? undefined
      : redactNormalizedPreservingFormat(result.proposedPlan, secretValues);

  setOutput('session_id', result.sessionId);
  setOutputPathOrWriteFile(
    'transcript_file',
    getBrandEnv(env, 'LOG_FILE'),
    'transcript.jsonl',
    // When LOG_FILE is set (always in production), this only registers the
    // path — the file's content already reached disk redacted, through the
    // parent's stdout-level SecretValueRedactor (see the doc comment above).
    // The fallback branch writes this transcript directly instead. Written
    // as-is, NOT re-redacted here: `result.transcript` is
    // `transcript.serialize()` from `buildTranscriptCapture`, which already
    // redacts each record structurally (leaf-by-leaf, before
    // `JSON.stringify`) — see `createTranscriptCapture`'s doc comment in
    // `_lib/agent-transcript.ts`. A second raw substring pass over this
    // already-serialized, already-clean JSON text is not just redundant: a
    // configured secret value can coincidentally match part of the JSON's
    // OWN escape sequences or structural delimiters (e.g. a secret
    // containing `n` immediately followed by escaped text, or containing
    // `","key":` literally), and replacing that coincidental match with
    // `***` corrupts otherwise-valid JSON without the secret ever having
    // been present in the original text.
    result.transcript,
  );

  writeOutputFile('text_response_file', 'text-response.txt', rawText);
  // A multi-line secret (e.g. a PEM key) echoed verbatim only exact-matches
  // before normalizing collapses its internal newlines, while a secret
  // whose internal whitespace the agent reformatted (e.g. a newline where
  // the secret has a plain space) only exact-matches after normalizing
  // reconstitutes it. `redactNormalizedText` closes both in one pass instead
  // of two sequential redact passes, which can leak when two configured
  // values share a whitespace-differing prefix/suffix (see its doc comment).
  setOutput(
    'text_response',
    redactNormalizedText(result.rawText, secretValues),
  );

  if (structured !== undefined) {
    setOutput('json_response', JSON.stringify(structured));
    writeOutputFile(
      'json_response_file',
      'json-response.json',
      `${JSON.stringify(structured, null, 2)}\n`,
    );
  }

  if (proposedPlan) {
    writeOutputFile(
      'proposed_plan_file',
      'proposed-plan.md',
      `${proposedPlan}\n`,
    );
  }
}

function emitTranscript(transcript: string): void {
  if (transcript.length > 0) {
    process.stdout.write(transcript);
  }
}

function formatErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureAccountScope(
  env: NodeJS.ProcessEnv,
  provider: AgentProviderType,
): 'native' | 'ai_credits' | 'local' {
  if (provider === 'ollama') return 'local';
  return getBrandEnv(env, 'AI_CREDITS_MODEL') ? 'ai_credits' : 'native';
}

function findClassifiedAgentRunFailure(
  env: NodeJS.ProcessEnv,
  failures: readonly unknown[],
): AgentRunFailure | undefined {
  return failures.find((failure): failure is AgentRunFailure => {
    if (!(failure instanceof AgentRunFailure)) return false;
    return Boolean(
      classifyAgentFailure({
        provider: failure.provider,
        model: env.INPUT_MODEL,
        accountScope: failureAccountScope(env, failure.provider),
        events: failure.events,
        error: failure.originalError,
      }),
    );
  });
}

function persistAgentRunFailure(
  env: NodeJS.ProcessEnv,
  failure: AgentRunFailure,
): void {
  const secretValues = parseAgentSecretValuesEnv(
    getBrandEnv(env, 'AGENT_SECRET_VALUES'),
  );
  // Parse/classify from the original transcript (redaction must not affect
  // activity detection or failure classification). `failure.transcript` is
  // itself `transcript.serialize()` from `buildTranscriptCapture`, already
  // redacted structurally record-by-record before serialization — written
  // as-is, NOT re-redacted here, for the same reason as the success path's
  // `transcript_file` above: a second raw substring pass over
  // already-serialized JSON can corrupt its escape sequences or structural
  // delimiters on a coincidental match, even though the secret was never
  // present in the original text.
  const transcriptFile = writeOutputFile(
    'agent_failure_transcript_file',
    'agent-failure-transcript.jsonl',
    failure.transcript,
  );
  const parsed = parseAgentTranscriptLines(
    failure.transcript.split(/\r?\n/),
    failure.provider,
  );
  const hadAgentActivity = transcriptHasAgentActivity(parsed.messages);
  const classification = classifyAgentFailure({
    provider: failure.provider,
    model: env.INPUT_MODEL,
    accountScope: failureAccountScope(env, failure.provider),
    events: failure.events,
    error: failure.originalError,
  });
  const invariantFailure = hadAgentActivity && !failure.sessionId;
  // Whitespace-insensitive, like every sibling action's provider/error text
  // (git-commit-push, github-create-pr, parallel-agents, plan-with-review).
  // Plain `redactValues` left a configured value in this durable file intact
  // whenever the provider's error text reflowed its internal whitespace: the
  // whole value reached agent-failure.json.
  // Formatting preserved: this lands in agent-failure.json, where a provider's
  // multi-line stack trace or lint report was being flattened to one line for
  // every pipeline whether a secret matched or not.
  const message = redactNormalizedPreservingFormat(
    invariantFailure
      ? 'Agent recovery invariant failed: provider activity was captured without a resumable session ID'
      : failure.message,
    secretValues,
  );
  // `classification.diagnostic_message` is derived from the same
  // agent-authored error text as `message` above and reaches this same
  // durable file; classifyAgentFailure only applies shape-based
  // redactSecrets(), which by design cannot catch an arbitrary
  // pipeline-configured secret value, so it needs the same value-based
  // redaction applied here.
  const redactedClassification =
    !invariantFailure && classification
      ? {
          ...classification,
          diagnostic_message: redactNormalizedPreservingFormat(
            classification.diagnostic_message,
            secretValues,
          ),
        }
      : undefined;
  const metadata: AgentActionFailureMetadata = {
    version: 1,
    provider: failure.provider,
    agent_harness:
      (getBrandEnv(env, 'PIPELINE_AGENT_HARNESS') === 'codex'
        ? 'codex'
        : getBrandEnv(env, 'PIPELINE_AGENT_HARNESS') === 'claude'
          ? 'claude'
          : env.INPUT_MODEL
            ? getExecutionHarnessForModel(env.INPUT_MODEL)
            : undefined) ?? 'claude',
    ...(failure.sessionId ? { session_id: failure.sessionId } : {}),
    had_agent_activity: hadAgentActivity,
    transcript_file: transcriptFile,
    ...(redactedClassification
      ? { classification: redactedClassification }
      : {}),
    message,
  };
  writeOutputFile(
    'agent_failure_metadata_file',
    'agent-failure.json',
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  if (invariantFailure) {
    throw new Error(message);
  }
  throw failure;
}

async function runAgentAction(
  actionMode: AgentActionMode,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const schema = parseStructuredSchema(env.INPUT_STRUCTURED_OUTPUT_SCHEMA);
  const requestedMaxTurns = parseMaxTurns(env.INPUT_MAX_TURNS);
  const requestedThinkingLevel = parseThinkingEffort(env.INPUT_THINKING_EFFORT);
  const requestedSettingSources = parseSettingSources(
    env.INPUT_SETTING_SOURCES,
  );
  const persistSession =
    actionMode === 'resume'
      ? true
      : getBrandEnv(env, 'PIPELINE_AGENT_RECOVERY') === 'true' ||
        parseBooleanInput(env.INPUT_PERSIST_SESSION, 'persist_session', false);
  const prompt = await resolvePrompt({
    prompt: env.INPUT_PROMPT,
    promptFile: env.INPUT_PROMPT_FILE,
  });
  const permissionPreset = parsePermissionPreset(env.INPUT_PERMISSION_PRESET);
  validateStructuredOutputInputs(permissionPreset, schema);
  const promptWithPlanRequirement = applyPlanPromptRequirement(
    prompt,
    permissionPreset,
  );
  const actionLabel = getActionLabel(actionMode);

  const effectiveMaxTurns = schema
    ? Math.max(requestedMaxTurns, 2)
    : requestedMaxTurns;
  if (schema && requestedMaxTurns < 2) {
    process.stderr.write(
      `${actionLabel}: max_turns raised to ${effectiveMaxTurns} (minimum for structured output)\n`,
    );
  }

  if (actionMode === 'resume' && !env.INPUT_MODEL) {
    const claudeThinkingLevel = normalizeRequestedThinkingLevel(
      requestedThinkingLevel,
      'claude',
      actionMode,
    );

    try {
      const result = await runClaudePath(
        env,
        promptWithPlanRequirement,
        schema,
        effectiveMaxTurns,
        persistSession,
        actionMode,
        'claude',
        false,
        claudeThinkingLevel,
        requestedSettingSources,
      );
      emitTranscript(result.transcript);
      writeAgentOutputs(env, result);
      return;
    } catch (claudeError) {
      if (
        claudeError instanceof AgentSessionStartupTimeoutError ||
        (claudeError instanceof AgentRunFailure &&
          claudeError.originalError instanceof AgentSessionStartupTimeoutError)
      ) {
        throw claudeError;
      }
      const classifiedFailure = findClassifiedAgentRunFailure(env, [
        claudeError,
      ]);
      if (classifiedFailure) throw classifiedFailure;
      throw claudeError;
    }
  }

  const provider = getModelProviderInput(env.INPUT_MODEL);
  const configuredHarness = getBrandEnv(env, 'PIPELINE_AGENT_HARNESS');
  const executionHarness =
    configuredHarness === 'claude' || configuredHarness === 'codex'
      ? configuredHarness
      : env.INPUT_MODEL
        ? (getExecutionHarnessForModel(env.INPUT_MODEL) ?? 'claude')
        : 'claude';
  if (executionHarness === 'codex') {
    throw new Error(
      'Codex builtin agent actions require a host CodexPromptRunner; subprocess SDK execution has been removed.',
    );
  }

  const thinkingLevel = normalizeRequestedThinkingLevel(
    requestedThinkingLevel,
    executionHarness,
    actionMode,
  );
  const result = await runClaudePath(
    env,
    promptWithPlanRequirement,
    schema,
    effectiveMaxTurns,
    persistSession,
    actionMode,
    provider === 'ollama' ? 'ollama' : 'claude',
    true,
    thinkingLevel,
    requestedSettingSources,
  );
  writeAgentOutputs(env, result);
}

export async function runAgentPromptAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async () => {
    try {
      await runAgentAction('start', env);
    } catch (error) {
      if (error instanceof AgentRunFailure) {
        persistAgentRunFailure(env, error);
      }
      throw error;
    }
  });
}

export async function runAgentResumeAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async () => {
    try {
      await runAgentAction('resume', env);
    } catch (error) {
      if (error instanceof AgentRunFailure) {
        persistAgentRunFailure(env, error);
      }
      throw error;
    }
  });
}
