import { readFile } from 'node:fs/promises';
import {
  buildRouterModelRequest,
  HOST_HELPER_MODEL_RESULT_ENV,
  parseHostHelperModelResult,
  parseRouterRoutes,
} from '@canopy/execution-engine/builtin-actions/_lib/host-helper-model';
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

export async function runRouterAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async (): Promise<void> => {
    const secretValues = parseAgentSecretValuesEnv(
      getBrandEnv(env, 'AGENT_SECRET_VALUES'),
    );
    const text = await resolveText(env.INPUT_TEXT, env.INPUT_TEXT_FILE);
    const routes = parseRouterRoutes(env.INPUT_ROUTES);
    // Parsed on every model, so invalid inputs fail the same way.
    const requestedMaxTurns = parseMaxTurns(env.INPUT_MAX_TURNS);
    const permissionPreset = parsePermissionPreset(env.INPUT_PERMISSION_PRESET);
    const hostResultFile = getBrandEnv(env, HOST_HELPER_MODEL_RESULT_ENV);
    if (hostResultFile) {
      // The host already ran this step's model turn on its own harness and
      // wrote the redacted transcript to the step log (CAN-6702).
      const hostResult = parseHostHelperModelResult(
        await readFile(hostResultFile, 'utf8'),
      );
      const structured = hostResult.structured;
      // As on the Claude path, a missing structured result fails the step.
      if (
        typeof structured !== 'object' ||
        structured === null ||
        Array.isArray(structured)
      )
        throw new Error('router did not receive structured output.');
      writeRouterOutputs(hostResult.structured, secretValues, env, '');
      return;
    }
    const { prompt, schema } = buildRouterModelRequest({
      text,
      routes,
      criteria: env.INPUT_CRITERIA,
    });

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
    writeRouterOutputs(
      result.structured,
      secretValues,
      env,
      transcript.serialize(),
    );
  });
}

/** The structured field as text, as the earlier `String(value ?? '')` read it. */
function fieldText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return String(value);
  return JSON.stringify(value);
}

function writeRouterOutputs(
  structured: unknown,
  secretValues: readonly string[],
  env: NodeJS.ProcessEnv,
  transcriptText: string,
): void {
  const parsed: Record<string, unknown> =
    typeof structured === 'object' &&
    structured !== null &&
    !Array.isArray(structured)
      ? Object.fromEntries(Object.entries(structured))
      : {};

  // The model's reply, from a Claude turn in this subprocess (which
  // inherits `secretEnv`) or from the host turn, can echo a pipeline
  // secret, and if it echoes one back into its
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
    redactNormalizedText(fieldText(parsed.route), secretValues),
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
    redactNormalizedText(fieldText(parsed.reasoning), secretValues),
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
    transcriptText,
  );
}
