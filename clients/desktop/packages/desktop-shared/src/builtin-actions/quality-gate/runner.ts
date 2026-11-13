import { readFile } from 'node:fs/promises';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  buildPipelinePromptRecord,
  buildPipelineSystemPromptRecord,
  createTranscriptCapture,
} from '../_lib/agent-transcript';
import { withClaudeSessionStartupTimeout } from '../_lib/agent-session-startup';
import { runWithActionEnvironment } from '../_lib/action-env';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';
import { setOutput, setOutputPathOrWriteFile } from '../_lib/output';
import {
  buildQueryOptions,
  extractFinalResult,
  parseAgentSecretValuesEnv,
  parseMaxTurns,
  parsePermissionPreset,
  redactNormalizedText,
  redactedFiniteNumber,
} from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';

async function resolveText(
  text: string | undefined,
  textFile: string | undefined,
): Promise<string> {
  const resolved =
    textFile && textFile.trim().length > 0
      ? await readFile(textFile, 'utf8')
      : (text ?? '');
  if (!resolved.trim()) {
    throw new Error('quality-gate requires a non-empty text or text_file');
  }
  return resolved;
}

function parseThreshold(raw: string | undefined): number {
  if (!raw || raw.trim().length === 0) {
    return 80;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error('threshold must be a number between 0 and 100');
  }
  return parsed;
}

export async function runQualityGateAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async (): Promise<void> => {
    const secretValues = parseAgentSecretValuesEnv(
      getBrandEnv(env, 'AGENT_SECRET_VALUES'),
    );
    const text = await resolveText(env.INPUT_TEXT, env.INPUT_TEXT_FILE);
    const threshold = parseThreshold(env.INPUT_THRESHOLD);
    const requestedMaxTurns = parseMaxTurns(env.INPUT_MAX_TURNS);
    const permissionPreset = parsePermissionPreset(env.INPUT_PERMISSION_PRESET);
    const schema = {
      type: 'object',
      properties: {
        score: {
          type: 'number',
        },
        feedback: {
          type: 'string',
        },
      },
      required: ['score', 'feedback'],
    };

    const prompt = [
      'Evaluate the following artifact against the provided criteria and return a score from 0 to 100.',
      env.INPUT_CRITERIA?.trim()
        ? `Criteria: ${env.INPUT_CRITERIA.trim()}`
        : '',
      '',
      text,
    ]
      .filter(Boolean)
      .join('\n');
    const queryResult = claudeQuery({
      prompt,
      options: buildQueryOptions({
        cwd: process.cwd(),
        maxTurns: Math.max(requestedMaxTurns, 2),
        model: env.INPUT_MODEL,
        permissionPreset,
        systemPrompt: env.INPUT_SYSTEM_PROMPT,
        schema,
      }),
    });
    const transcript = createTranscriptCapture(secretValues);
    transcript.emitRecord(
      buildPipelinePromptRecord({
        provider: 'claude',
        originalText: prompt,
      }),
    );
    const systemPromptRecord = buildPipelineSystemPromptRecord(
      'claude',
      env.INPUT_SYSTEM_PROMPT,
    );
    if (systemPromptRecord) {
      transcript.emitRecord(systemPromptRecord);
    }

    const events: SDKMessage[] = [];
    for await (const event of withClaudeSessionStartupTimeout(
      queryResult,
      env,
      'quality-gate',
    )) {
      transcript.emitRecord(event);
      events.push(event);
    }

    const result = extractFinalResult(events, true);
    const parsed = result.structured as {
      feedback?: string;
      score?: number;
    };
    // Finite or `0`, the same rule `router` applies to `confidence` and the
    // one the pipeline docs state for both: a non-numeric model answer used to
    // write the literal string `NaN`, which every downstream `if:` comparison
    // then read as false in a way no author could see. A configured value the
    // model answers AS a number is masked before coercion and falls back to the
    // same `0`, so neither this output nor the threshold error below can repeat
    // it; `passed` and that error are both derived from this one sanitized
    // score.
    const score = redactedFiniteNumber(parsed.score, secretValues);
    const passed = score >= threshold;

    // quality-gate invokes the Claude SDK directly in this subprocess,
    // which inherits `secretEnv` alongside every other env var — the agent
    // CAN read a pipeline secret, and if it echoes one back into its
    // feedback, these outputs write straight to disk, bypassing the parent
    // process's stdout-level `SecretValueRedactor` entirely.
    setOutput('score', String(score));
    setOutput('passed', passed ? 'true' : 'false');
    // `redactNormalizedText`, not plain `redactValues`: a secret whose
    // internal whitespace the agent reformatted while echoing it into
    // `feedback` only exact-matches after normalizing reconstitutes it (see
    // its doc comment in agent-prompt/logic.ts).
    setOutput(
      'feedback',
      redactNormalizedText(String(parsed.feedback ?? ''), secretValues),
    );
    // `transcript.serialize()` is already structurally redacted
    // record-by-record via `createTranscriptCapture` — a further raw
    // substring pass here would risk corrupting valid JSON via a
    // coincidental match against the transcript's own structure (see
    // `redactSerializedJsonLine`'s doc comment in `lib/redaction.ts`).
    setOutputPathOrWriteFile(
      'transcript_file',
      getBrandEnv(env, 'LOG_FILE'),
      'quality-gate-transcript.jsonl',
      transcript.serialize(),
    );

    if (!passed) {
      throw new Error(
        `quality-gate score ${String(score)} did not meet threshold ${String(threshold)}`,
      );
    }
  });
}
