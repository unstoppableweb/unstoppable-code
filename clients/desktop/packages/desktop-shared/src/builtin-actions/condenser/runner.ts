import { readFile } from 'node:fs/promises';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { withClaudeSessionStartupTimeout } from '../_lib/agent-session-startup';
import { runWithActionEnvironment } from '../_lib/action-env';
import { setOutput, writeOutputFile } from '../_lib/output';
import {
  redactStructuredValue,
  redactValues,
} from '@canopy/execution-engine/lib/redaction';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';
import {
  redactNormalizedPreservingFormat,
  buildQueryOptions,
  extractFinalResult,
  parseAgentSecretValuesEnv,
  parseMaxTurns,
  parsePermissionPreset,
  parseStructuredSchema,
  redactNormalizedStructuredValue,
  redactNormalizedText,
} from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';

type CondenseStrategy =
  | 'key-outputs'
  | 'recent-events'
  | 'llm-summary'
  | 'structured-summary';

async function resolveText(
  text: string | undefined,
  textFile: string | undefined,
): Promise<string> {
  const resolved =
    textFile && textFile.trim().length > 0
      ? await readFile(textFile, 'utf8')
      : (text ?? '');
  const trimmed = resolved.trim();
  if (!trimmed) {
    throw new Error('condenser requires a non-empty text or text_file');
  }
  return resolved;
}

function parseStrategy(raw: string | undefined): CondenseStrategy {
  const trimmed = raw?.trim() ?? '';
  switch (trimmed || 'key-outputs') {
    case 'key-outputs':
    case 'recent-events':
    case 'llm-summary':
    case 'structured-summary':
      return (trimmed || 'key-outputs') as CondenseStrategy;
    default:
      throw new Error(
        'strategy must be one of: key-outputs, recent-events, llm-summary, structured-summary',
      );
  }
}

function parseMaxChars(raw: string | undefined): number {
  if (!raw || raw.trim().length === 0) {
    return 4000;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('max_chars must be a positive integer');
  }
  return parsed;
}

function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n...`;
}

// Deliberately does NOT clip here — the caller must redact the FULL
// filtered result before truncating (see the call site's doc comment for
// why: clipping before that final redaction pass can cut a reconstituted
// or reformatted secret in half, leaving an unmatchable fragment).
function filterKeyOutputLines(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /[:=]/.test(line));
  return lines.length > 0 ? lines.join('\n') : text;
}

// Same reasoning as `filterKeyOutputLines`: no clip here.
function filterRecentEventLines(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-20).join('\n');
}

async function summarizeWithClaude(
  text: string,
  env: NodeJS.ProcessEnv,
  structured: boolean,
  secretValues: readonly string[],
): Promise<{
  summary: string;
  normalizedSummary: string;
  transcript: SDKMessage[];
}> {
  const schema = structured
    ? parseStructuredSchema(
        env.INPUT_STRUCTURED_OUTPUT_SCHEMA ??
          '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}',
      )
    : undefined;
  const requestedMaxTurns = parseMaxTurns(env.INPUT_MAX_TURNS);
  const permissionPreset = parsePermissionPreset(env.INPUT_PERMISSION_PRESET);
  const effectiveMaxTurns = schema
    ? Math.max(requestedMaxTurns, 2)
    : requestedMaxTurns;

  const prompt = structured
    ? [
        'Summarize the following context into a structured compact form.',
        '',
        text,
      ].join('\n')
    : [
        'Summarize the following context into a concise compact summary.',
        '',
        text,
      ].join('\n');

  const queryResult = claudeQuery({
    prompt,
    options: buildQueryOptions({
      cwd: process.cwd(),
      maxTurns: effectiveMaxTurns,
      model: env.INPUT_MODEL,
      permissionPreset,
      systemPrompt: env.INPUT_SYSTEM_PROMPT,
      schema,
    }),
  });

  const events: SDKMessage[] = [];
  for await (const event of withClaudeSessionStartupTimeout(
    queryResult,
    env,
    'condenser',
  )) {
    // Redacted BEFORE `JSON.stringify`, not after — see
    // `createTranscriptCapture`'s doc comment (`_lib/agent-transcript.ts`)
    // for why a multi-line secret echoed verbatim needs this instead of a
    // string-based redaction pass over the already-serialized text.
    const redactedEvent =
      secretValues.length === 0
        ? event
        : redactStructuredValue(event, secretValues);
    process.stdout.write(`${JSON.stringify(redactedEvent)}\n`);
    events.push(event);
  }

  const result = extractFinalResult(events, schema !== undefined);
  if (result.structured !== undefined) {
    return {
      // Redacted structurally (walks actual object leaves) BEFORE
      // `JSON.stringify`, not as a text pass afterward: a multi-line secret
      // in a structured leaf would otherwise only reach any later
      // string-based redaction pass as its JSON-escaped, unmatchable form
      // (the same hazard `createTranscriptCapture` closes the same way —
      // see its doc comment in `_lib/agent-transcript.ts`). `summary`
      // (verbatim-only, no whitespace normalization — the raw/fidelity-
      // preserving variant for `summary_file`) and `normalizedSummary`
      // (also protects a whitespace-reformatted secret, since it's the
      // variant behind the intentionally-normalized `summary` OUTPUT, not
      // the file) are each computed independently from `result.structured`
      // — never derived from the other's already-redacted result, and
      // never re-redacted by a later raw pass over this already-serialized
      // JSON, which risks corrupting it (see `redactSerializedJsonLine`'s
      // doc comment for why).
      summary: JSON.stringify(
        // Was verbatim-only while its `normalizedSummary` sibling on the very
        // same record was whitespace-insensitive, so a reflowed value reached
        // `summary_file` intact . The normalized
        // walker substitutes only leaves that actually matched, so an
        // innocent leaf is never reformatted.
        redactNormalizedStructuredValue(result.structured, secretValues),
      ),
      normalizedSummary: JSON.stringify(
        redactNormalizedStructuredValue(result.structured, secretValues),
      ),
      transcript: events,
    };
  }
  return {
    summary: result.rawText,
    normalizedSummary: result.rawText,
    transcript: events,
  };
}

export async function runCondenserAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async (): Promise<void> => {
    const text = await resolveText(env.INPUT_TEXT, env.INPUT_TEXT_FILE);
    const strategy = parseStrategy(env.INPUT_STRATEGY);
    const maxChars = parseMaxChars(env.INPUT_MAX_CHARS);
    const secretValues = parseAgentSecretValuesEnv(
      getBrandEnv(env, 'AGENT_SECRET_VALUES'),
    );

    // The `llm-summary`/`structured-summary` strategies invoke the Claude
    // SDK directly in this subprocess, which inherits `secretEnv` alongside
    // every other env var — the agent CAN read a pipeline secret, and if it
    // echoes one back into its summary, these outputs write straight to
    // disk (`setOutput`/`writeOutputFile`), bypassing the parent process's
    // stdout-level `SecretValueRedactor` entirely.
    let summary: string;
    let normalizedSummary: string;
    const isStructured = strategy === 'structured-summary';
    if (strategy === 'key-outputs' || strategy === 'recent-events') {
      // Three sequential hazards, each needing its own guard, all before
      // any truncation to `max_chars`:
      //
      // 1. Redact the WHOLE source text BEFORE line-filtering:
      //  `filterKeyOutputLines`/`filterRecentEventLines` drop lines
      //  (respectively, any without a `:`/`=`, and all but the last 20),
      //  which can split a multi-line configured secret across a
      //  dropped line and leave its surviving fragments no longer
      //  forming one contiguous exact match for a later redaction pass
      //  to find.
      // 2. That pre-filter pass alone is not sufficient: both filters also
      //  `.trim()` each line AFTER filtering, which can RECONSTITUTE an
      //  exact match that did not exist before trimming (a secret whose
      //  real input had different leading/trailing whitespace around an
      //  internal newline never matched the pre-filter raw pass, but the
      //  trimmed, reassembled text can equal it exactly) — leaking it
      //  verbatim unless something redacts the FILTERED result too.
      // 3. That second pass must ALSO run before `clip()` truncates to
      //  `max_chars` — the same clip-before-redact ordering hazard
      //  `llm-summary` below already guards against. `max_chars` is a
      //  user-settable pipeline input, so hitting the boundary mid-secret
      //  is ordinary use, not a contrived edge case.
      //
      // This strategy's own INPUT can legitimately be JSON (`key-outputs`'s
      // `:`/`=` filter keeps most lines of pretty-printed JSON too), so a
      // coincidental `***` splice across a delimiter is not impossible —
      // but that risk already existed at the pre-filter pass above; the
      // second/third passes added here operate on the SAME already-
      // filtered plain text and introduce no new corruption class beyond
      // it (unlike the DECODED-then-reserialized structured-summary case
      // below, which specifically avoids ever touching serialized JSON).
      const redactedText = redactValues(text, secretValues);
      const filtered =
        strategy === 'key-outputs'
          ? filterKeyOutputLines(redactedText)
          : filterRecentEventLines(redactedText);
      const redactedFiltered = redactNormalizedPreservingFormat(
        filtered,
        secretValues,
      );
      const redactedNormalizedFiltered = redactNormalizedText(
        filtered,
        secretValues,
      );
      summary = clip(redactedFiltered, maxChars);
      // `clip` appends a literal `\n...` when it truncates — strip that (a
      // bare `\r` too, in case a future change to `redactNormalizedText`
      // ever stops guaranteeing single-line input here), since
      // `setOutput` requires a single-line value.
      normalizedSummary = clip(redactedNormalizedFiltered, maxChars).replace(
        /[\r\n]+/g,
        ' ',
      );
    } else {
      const result = await summarizeWithClaude(
        clip(text, Math.max(maxChars * 2, maxChars)),
        env,
        isStructured,
        secretValues,
      );
      // For `structured-summary`, `result.summary`/`result.normalizedSummary`
      // are ALREADY fully redacted at the correct (decoded, pre-
      // serialization) boundary. For `llm-summary`, redact the FULL,
      // unclipped agent response here, before `clip` truncates it: clipping
      // first (the previous order) can cut a configured secret in half,
      // leaving a surviving prefix short enough that the exact-match
      // redaction pass below no longer recognizes it.
      const redactedFull = isStructured
        ? result.summary
        : redactNormalizedPreservingFormat(result.summary, secretValues);
      const redactedNormalizedFull = isStructured
        ? result.normalizedSummary
        : redactNormalizedText(result.normalizedSummary, secretValues);
      summary = clip(redactedFull, maxChars);
      // `clip` appends a literal `\n...` when it truncates — strip that (a
      // bare `\r` too) rather than running a blanket `normalizeSingleLine`
      // pass here: for `structured-summary`, `redactedNormalizedFull` is
      // already fully protected leaf-by-leaf by
      // `redactNormalizedStructuredValue`, so a further whole-string
      // whitespace collapse serves no redaction purpose and would silently
      // alter legitimate multi-space runs inside an unrelated JSON string
      // leaf that never matched anything. `setOutput` requires a
      // single-line value; `redactNormalizedText`/`JSON.stringify` already
      // keep `redactedNormalizedFull` itself free of real newlines, so
      // `clip`'s own marker is the only one this needs to catch.
      normalizedSummary = clip(redactedNormalizedFull, maxChars).replace(
        /[\r\n]+/g,
        ' ',
      );
    }

    // Every strategy above now produces an ALREADY fully redacted `summary`/
    // `normalizedSummary` — for `structured-summary` at the correct
    // (decoded, pre-serialization) boundary, for every other strategy by
    // redacting before any clipping/line-filtering that could split a
    // multi-line secret apart. No further raw pass runs here: for the
    // structured case specifically, a raw substring pass over already-
    // serialized JSON can coincidentally match the JSON's own escape
    // sequences or structural delimiters and corrupt it, even though the
    // secret was never present in the original text (see
    // `redactSerializedJsonLine`'s doc comment).
    writeOutputFile('summary_file', 'summary.txt', `${summary}\n`);
    setOutput('summary', normalizedSummary);
  });
}
