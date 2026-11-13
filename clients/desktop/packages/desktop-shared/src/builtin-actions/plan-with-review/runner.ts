import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { withClaudeSessionStartupTimeout } from '../_lib/agent-session-startup';
import {
  buildPipelinePromptRecord,
  buildPipelineSystemPromptRecord,
  createTranscriptCapture,
  type TranscriptCapture,
} from '../_lib/agent-transcript';
import { runWithActionEnvironment } from '../_lib/action-env';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';
import {
  setOutput,
  setOutputPathOrWriteFile,
  writeOutputFile,
} from '../_lib/output';
import {
  redactNormalizedPreservingFormat,
  buildQueryOptions,
  extractFinalResult,
  parseAgentSecretValuesEnv,
  parseMaxTurns,
  parsePermissionPreset,
  readPipelineLedgerTools,
  redactNormalizedText,
  resolvePrompt,
} from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';

function parseMaxRevisions(raw: string | undefined): number {
  if (!raw || raw.trim().length === 0) {
    return 2;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('max_revisions must be a non-negative integer');
  }
  return parsed;
}

async function runClaudeQuery(
  prompt: string,
  env: NodeJS.ProcessEnv,
  transcript: TranscriptCapture,
  schema?: Record<string, unknown>,
  systemPromptRecord?: Record<string, unknown> | null,
): Promise<{
  events: SDKMessage[];
  rawText: string;
  structured?: unknown;
}> {
  const requestedMaxTurns = parseMaxTurns(env.INPUT_MAX_TURNS);
  const permissionPreset = parsePermissionPreset(env.INPUT_PERMISSION_PRESET);
  const effectiveMaxTurns = schema
    ? Math.max(requestedMaxTurns, 2)
    : requestedMaxTurns;
  transcript.emitRecord(
    buildPipelinePromptRecord({
      provider: 'claude',
      originalText: prompt,
    }),
  );
  if (systemPromptRecord) {
    transcript.emitRecord(systemPromptRecord);
  }

  const queryResult = claudeQuery({
    prompt,
    options: buildQueryOptions({
      cwd: process.cwd(),
      maxTurns: effectiveMaxTurns,
      model: env.INPUT_MODEL,
      permissionPreset,
      systemPrompt: env.INPUT_SYSTEM_PROMPT,
      schema,
      ledgerTools: readPipelineLedgerTools(env),
    }),
  });

  const events: SDKMessage[] = [];
  for await (const event of withClaudeSessionStartupTimeout(
    queryResult,
    env,
    'plan-with-review',
  )) {
    transcript.emitRecord(event);
    events.push(event);
  }

  const result = extractFinalResult(events, schema !== undefined);
  return {
    events,
    rawText: result.rawText,
    structured: result.structured,
  };
}

function buildResearchPrompt(basePrompt: string): string {
  return [
    'Research the repository context needed to write a strong implementation plan.',
    'Focus on relevant modules, constraints, testing expectations, and likely change surface.',
    '',
    basePrompt,
  ].join('\n');
}

function buildPlanPrompt(
  basePrompt: string,
  researchText: string,
  critique: string | undefined,
  attempt: number,
): string {
  return [
    `Create implementation plan draft ${String(attempt)} for the following task.`,
    '',
    'Task:',
    basePrompt,
    '',
    'Research summary:',
    researchText,
    critique
      ? ['', 'Critique to address from the prior draft:', critique].join('\n')
      : '',
    '',
    'Return a concrete ordered plan with implementation steps, likely files, and verification notes.',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildValidationPrompt(planText: string): string {
  return [
    'Review the following implementation plan for completeness, ordering, repository fit, and verification quality.',
    'Return whether the plan passes and concise feedback.',
    '',
    planText,
  ].join('\n');
}

/**
 * `plan-with-review` invokes the Claude SDK directly in this subprocess,
 * which inherits `secretEnv` alongside every other env var — the agent CAN
 * read a pipeline secret, and if it echoes one back into the plan, the
 * research, or the validator's feedback, every one of these outputs writes
 * straight to disk, bypassing the parent process's stdout-level
 * `SecretValueRedactor` entirely. `text_response`/`feedback` use
 * `redactNormalizedText` on the ORIGINAL text, not the already-redacted raw
 * text (see its doc comment in agent-prompt/logic.ts for why).
 */
function writeReviewOutputs(
  env: NodeJS.ProcessEnv,
  acceptedPlan: string,
  researchText: string,
  lastFeedback: string,
  revisionCount: number,
  transcript: string,
): void {
  const secretValues = parseAgentSecretValuesEnv(
    getBrandEnv(env, 'AGENT_SECRET_VALUES'),
  );
  const redactedPlan = redactNormalizedPreservingFormat(
    acceptedPlan,
    secretValues,
  );
  writeOutputFile('plans_file', 'plan-with-review.md', `${redactedPlan}\n`);
  writeOutputFile(
    'research_file',
    'plan-research.md',
    `${redactNormalizedPreservingFormat(researchText, secretValues)}\n`,
  );
  // `transcript` is already structurally redacted record-by-record via
  // `createTranscriptCapture` — a further raw substring pass here would
  // risk corrupting valid JSON via a coincidental match against the
  // transcript's own structure (see `redactSerializedJsonLine`'s doc
  // comment in `lib/redaction.ts`).
  setOutputPathOrWriteFile(
    'transcript_file',
    getBrandEnv(env, 'LOG_FILE'),
    'plan-with-review-transcript.jsonl',
    transcript,
  );
  setOutput('revision_count', String(revisionCount));
  setOutput('text_response', redactNormalizedText(acceptedPlan, secretValues));
  setOutput('feedback', redactNormalizedText(lastFeedback, secretValues));
}

export async function runPlanWithReviewAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async (): Promise<void> => {
    let wroteOutputs = false;

    try {
      const basePrompt = await resolvePrompt({
        prompt: env.INPUT_PROMPT,
        promptFile: env.INPUT_PROMPT_FILE,
      });
      const maxRevisions = parseMaxRevisions(env.INPUT_MAX_REVISIONS);
      const secretValues = parseAgentSecretValuesEnv(
        getBrandEnv(env, 'AGENT_SECRET_VALUES'),
      );
      const transcript = createTranscriptCapture(secretValues);
      const systemPromptRecord = buildPipelineSystemPromptRecord(
        'claude',
        env.INPUT_SYSTEM_PROMPT,
      );

      const researchResult = await runClaudeQuery(
        buildResearchPrompt(basePrompt),
        env,
        transcript,
        undefined,
        systemPromptRecord,
      );

      let acceptedPlan = '';
      let lastFeedback = '';
      let revisionCount = 0;

      for (let attempt = 1; attempt <= maxRevisions + 1; attempt += 1) {
        const planResult = await runClaudeQuery(
          buildPlanPrompt(
            basePrompt,
            researchResult.rawText,
            lastFeedback || undefined,
            attempt,
          ),
          env,
          transcript,
        );

        const validationSchema = {
          type: 'object',
          properties: {
            passed: { type: 'boolean' },
            feedback: { type: 'string' },
          },
          required: ['passed', 'feedback'],
        };
        const validationResult = await runClaudeQuery(
          buildValidationPrompt(planResult.rawText),
          env,
          transcript,
          validationSchema,
        );

        const parsed = validationResult.structured as
          | { feedback?: string; passed?: boolean }
          | undefined;

        acceptedPlan = planResult.rawText;
        lastFeedback = String(parsed?.feedback ?? '');
        revisionCount = attempt - 1;

        if (parsed?.passed === true) {
          break;
        }

        if (attempt === maxRevisions + 1) {
          writeReviewOutputs(
            env,
            acceptedPlan,
            researchResult.rawText,
            lastFeedback,
            revisionCount,
            transcript.serialize(),
          );
          wroteOutputs = true;
          throw new Error(
            `plan-with-review exhausted max_revisions (${String(maxRevisions)})`,
          );
        }
      }

      writeReviewOutputs(
        env,
        acceptedPlan,
        researchResult.rawText,
        lastFeedback,
        revisionCount,
        transcript.serialize(),
      );
      wroteOutputs = true;
    } catch (error) {
      if (!wroteOutputs) {
        try {
          const secretValues = parseAgentSecretValuesEnv(
            getBrandEnv(env, 'AGENT_SECRET_VALUES'),
          );
          setOutput(
            'feedback',
            redactNormalizedText(String(error), secretValues),
          );
        } catch {
          // Ignore secondary output failures.
        }
      }
      throw error;
    }
  });
}
