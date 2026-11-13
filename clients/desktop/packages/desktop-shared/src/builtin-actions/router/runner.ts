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
    throw new Error('router requires a non-empty text or text_file');
  }
  return resolved;
}

function parseRoutes(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    throw new Error('router requires routes');
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((value) => typeof value === 'string')
    ) {
      return parsed;
    }
  } catch {
    const values = raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (values.length > 0) {
      return values;
    }
  }
  throw new Error('routes must be a JSON string array or comma-separated list');
}

export async function runRouterAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async (): Promise<void> => {
    const secretValues = parseAgentSecretValuesEnv(
      getBrandEnv(env, 'AGENT_SECRET_VALUES'),
    );
    const text = await resolveText(env.INPUT_TEXT, env.INPUT_TEXT_FILE);
    const routes = parseRoutes(env.INPUT_ROUTES);
    const requestedMaxTurns = parseMaxTurns(env.INPUT_MAX_TURNS);
    const permissionPreset = parsePermissionPreset(env.INPUT_PERMISSION_PRESET);
    const schema = {
      type: 'object',
      properties: {
        route: {
          type: 'string',
          enum: routes,
        },
        confidence: {
          type: 'number',
        },
        reasoning: {
          type: 'string',
        },
      },
      required: ['route', 'confidence', 'reasoning'],
    };
    const prompt = [
      `Route the following input into exactly one of these labels: ${routes.join(', ')}`,
      env.INPUT_CRITERIA?.trim()
        ? `Routing criteria: ${env.INPUT_CRITERIA.trim()}`
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
      'router',
    )) {
      transcript.emitRecord(event);
      events.push(event);
    }

    const result = extractFinalResult(events, true);
    const parsed = result.structured as {
      confidence?: number;
      reasoning?: string;
      route?: string;
    };

    // router invokes the Claude SDK directly in this subprocess, which
    // inherits `secretEnv` alongside every other env var — the agent CAN
    // read a pipeline secret, and if it echoes one back into its
    // reasoning, these outputs write straight to disk, bypassing the
    // parent process's stdout-level `SecretValueRedactor` entirely.
    // `result.structured` isn't enforced against the `enum: routes`/number
    // schema constraints below the SDK's own best-effort parsing (a
    // fallback path can pull it from the model's raw text or an
    // unvalidated tool call), so `route` is redacted the same as
    // `reasoning` rather than trusted to only ever be one of `routes`, and
    // `confidence` is coerced through `Number(...)` (matching
    // quality-gate's `score`) so a smuggled string can't pass through
    // verbatim.
    // `redactNormalizedText`, not plain `redactValues`, for both fields: a
    // secret whose internal whitespace the agent reformatted while echoing
    // it only exact-matches after normalizing reconstitutes it (see its doc
    // comment in agent-prompt/logic.ts).
    setOutput(
      'route',
      redactNormalizedText(String(parsed.route ?? ''), secretValues),
    );
    // Three things have to hold: the output stays a finite number (a downstream
    // `if:` expression reading `NaN` is worse than reading `0`), a non-numeric
    // model value never reaches the output verbatim, and a configured value the
    // model answers AS a number is not written either — coercion alone keeps
    // `Number(123456)` intact. `redactedFiniteNumber` masks the textual form
    // first and falls back to the documented finite `0`.
    setOutput(
      'confidence',
      String(redactedFiniteNumber(parsed.confidence, secretValues)),
    );
    setOutput(
      'reasoning',
      redactNormalizedText(String(parsed.reasoning ?? ''), secretValues),
    );
    // `transcript.serialize()` is already structurally redacted
    // record-by-record via `createTranscriptCapture` — a further raw
    // substring pass here would risk corrupting valid JSON via a
    // coincidental match against the transcript's own structure (see
    // `redactSerializedJsonLine`'s doc comment in `lib/redaction.ts`).
    setOutputPathOrWriteFile(
      'transcript_file',
      getBrandEnv(env, 'LOG_FILE'),
      'router-transcript.jsonl',
      transcript.serialize(),
    );
  });
}
