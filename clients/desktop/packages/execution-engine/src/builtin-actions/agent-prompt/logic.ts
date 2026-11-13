import { readFile } from 'node:fs/promises';
import type {
  McpHttpServerConfig,
  Options,
  SdkPluginConfig,
  SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import {
  buildClaudeThinkingOptions,
  normalizeAgentModelConfig,
  type AgentModelConfig,
} from '@canopy/execution-engine/execution-types';
import {
  clampThinkingLevelForModel,
  requireProviderForModel,
  resolveModelAlias,
  OLLAMA_MODELS,
  initOllamaModels,
  stripOllamaModelPrefix,
  type OllamaModelEntry,
} from '@canopy/execution-engine/model-catalog';
import type { ThinkingLevel } from '@canopy/execution-engine/types/thinking';
import { buildRtkClaudeHooks } from '@canopy/execution-engine/node/rtk/claude-hooks';
import {
  mapThinkingToReasoningEffort,
  type CodexThreadOptions,
} from '@canopy/execution-engine/lib/codex-model-config';
import { getBundledRtkBinaryPath } from '@canopy/execution-engine/pipelines/config-paths';
import {
  claudeNativeMemoryOptions,
  localMemoryEnabledFromEnv,
} from '@canopy/execution-engine/node/lib/native-memory';
import { brandEnvName, getBrandEnv } from '@canopy/execution-engine/brand/env';
import { withoutAgentSecretValues } from '@canopy/execution-engine/lib/agent-secret-values-env';
import {
  describeJsonParseFailure,
  normalizeSingleLine,
  redactStructuredValue,
  redactValues,
  redactValuesUnfiltered,
  withJsonEscapedVariants,
} from '@canopy/execution-engine/lib/redaction';
import {
  buildCodexPlanModeDeveloperInstructions,
  extractProposedPlan,
} from '@canopy/execution-engine/codex-plan-mode';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import {
  filterToClaudeModLaunchPlugins,
  mergeClaudeModAdmissionSettings,
  readClaudeModAdmissionEnvelope,
  type ClaudeModAdmissionLaunch,
} from '@canopy/execution-engine/node/plugins/claude-mod-admission';
import { hydrateModelRegistryFromEnv } from '@canopy/execution-engine/builtin-actions/_lib/model-registry';
import { parseThinkingLevelInput } from '@canopy/execution-engine/builtin-actions/_lib/thinking';

// Shared with streamed Cursor masking, which cannot load this module.
export {
  normalizeSingleLine,
  redactNormalizedPreservingFormat,
} from '@canopy/execution-engine/lib/redaction';

function hydrateOllamaModelsFromEnv(): void {
  if (OLLAMA_MODELS.length > 0) {
    return;
  }
  const raw = getBrandEnv(process.env, 'OLLAMA_MODELS');
  if (!raw) {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((value) => typeof value === 'string')
    ) {
      return;
    }
    const entries: OllamaModelEntry[] = parsed.map((id) => ({
      id,
      rawModelId: stripOllamaModelPrefix(id),
      label: stripOllamaModelPrefix(id),
    }));
    initOllamaModels(entries);
  } catch {
    // Malformed env var — leave registry empty
  }
}

hydrateModelRegistryFromEnv();
hydrateOllamaModelsFromEnv();

/** Claude SDK assistant error types that are non-recoverable. */
const FATAL_SDK_ERRORS: ReadonlySet<string> = new Set([
  'invalid_request',
  'authentication_failed',
  'billing_error',
]);

/**
 * Check whether an SDK event represents a fatal error that should
 * immediately abort the session rather than continuing to loop.
 * Returns the error type string if fatal, undefined otherwise.
 */
export function isFatalSdkEvent(event: unknown): string | undefined {
  const assistantEvent = readRecord(event);
  if (assistantEvent?.type !== 'assistant') return undefined;
  const error = assistantEvent.error;
  if (typeof error === 'string' && FATAL_SDK_ERRORS.has(error)) {
    return error;
  }
  return undefined;
}

export interface ResolvedPromptInput {
  prompt?: string;
  promptFile?: string;
}

export interface ExtractedResult {
  rawText: string;
  structured?: unknown;
}

export interface QueryOptionInput {
  cwd: string;
  maxTurns: number;
  model?: string;
  provider?: 'claude' | 'ollama';
  permissionPreset: PermissionPreset;
  persistSession?: boolean;
  resumeSessionId?: string;
  settingSources?: SettingSource[];
  systemPrompt?: string;
  schema?: Record<string, unknown>;
  thinkingLevel?: ThinkingLevel;
  plugins?: SdkPluginConfig[];
  /**
   * The step's Agent Ledger tools. Absent leaves the options exactly as they
   * were; ignored under `plan`, where Claude runs no tools.
   */
  ledgerTools?: PipelineLedgerTools;
}

export type PermissionPreset = 'none' | 'read_only' | 'dangerous_all' | 'plan';

export const READ_ONLY_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
] as const;
const DEFAULT_SETTING_SOURCES: SettingSource[] = ['user', 'project', 'local'];
const PLAN_PROMPT_REQUIREMENT =
  'Make reasonable assumptions grounded in this project to resolve ambiguity. If a blocker prevents an implementation-ready plan, use request_user_input to resolve it. You must always end your turn by providing a proposed plan.';

function isSettingSource(value: string): value is SettingSource {
  return value === 'user' || value === 'project' || value === 'local';
}

export async function resolvePrompt(
  input: ResolvedPromptInput,
): Promise<string> {
  const prompt =
    input.promptFile && input.promptFile.trim().length > 0
      ? await readFile(input.promptFile, 'utf8')
      : (input.prompt ?? '');
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error('agent-prompt requires a non-empty prompt or prompt_file');
  }
  return prompt;
}

export function parseMaxTurns(raw: string | undefined): number {
  if (!raw || raw.trim().length === 0) {
    return 100;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('max_turns must be a positive integer');
  }

  return parsed;
}

export function parseStructuredSchema(
  raw: string | undefined,
): Record<string, JsonValue> | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'structured_output_schema must be valid JSON: failed to parse the provided value',
    );
  }
  if (!isJsonObject(parsed)) {
    throw new Error('structured_output_schema must be a JSON object');
  }

  return parsed;
}

export const CODEX_STRUCTURED_OUTPUT_RETRY_ATTEMPTS = 2;

export function appendCodexSchemaInstruction(
  prompt: string,
  schema: Record<string, unknown> | undefined,
): string {
  return schema
    ? `${prompt}\n\nYou MUST respond with ONLY a JSON object matching this schema:\n${JSON.stringify(schema, null, 2)}`
    : prompt;
}

export function buildCodexStructuredOutputRetryPrompt(
  schema: Record<string, unknown>,
  failureMessage: string,
): string {
  return [
    'Your previous response failed JSON Schema validation.',
    '',
    `Validation error: ${failureMessage}`,
    '',
    'Use the original task and context from this thread to try again.',
    'Respond with ONLY a JSON object that satisfies this JSON Schema. Do not include markdown fences or explanatory text.',
    '',
    'JSON Schema:',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}

/**
 * Parses a structured response, failing with an input-INDEPENDENT diagnostic.
 *
 * V8's `JSON.parse` message embeds a shortened excerpt of the text it choked
 * on, and that fragment reached `agent-failure.json`, the step's `error`
 * output, and the structured-output RETRY prompt sent back to the vendor. A
 * configured value straddling the excerpt's cut is no longer an exact match,
 * so no later masking pass can recognise it. Shared by both host runners (the
 * desktop Electron runtime and the CLI runtime) so neither can drift back to a
 * raw parse. See `describeJsonParseFailure`.
 *
 * A `SyntaxError` specifically, because `isRetryableCodexStructuredOutputError`
 * classifies retryability partly on `error instanceof SyntaxError` — a plain
 * `Error` here would silently stop retrying malformed structured output.
 */
export function parseStructuredResponseText(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (error) {
    throw new SyntaxError(
      `Response was not valid JSON (${describeJsonParseFailure(error)}).`,
    );
  }
}

export function isRetryableCodexStructuredOutputError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    error instanceof SyntaxError ||
    message.includes('structured output') ||
    message.includes('json schema') ||
    message.includes('output schema') ||
    message.includes('schema validation')
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isJsonObject(value);
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
}

export function parsePermissionPreset(
  raw: string | undefined,
): PermissionPreset {
  if (!raw || raw.trim().length === 0) {
    return 'none';
  }

  const trimmed = raw.trim();
  switch (trimmed) {
    case 'none':
    case 'read_only':
    case 'dangerous_all':
    case 'plan':
      return trimmed;
    default:
      throw new Error(
        'permission_preset must be one of: none, read_only, dangerous_all, plan',
      );
  }
}

export function applyPlanPromptRequirement(
  prompt: string,
  permissionPreset: PermissionPreset,
): string {
  if (permissionPreset !== 'plan') {
    return prompt;
  }

  return `${prompt}\n\n${PLAN_PROMPT_REQUIREMENT}`;
}

export function validateStructuredOutputInputs(
  permissionPreset: PermissionPreset,
  schema: Record<string, unknown> | undefined,
): void {
  if (permissionPreset === 'plan' && schema !== undefined) {
    throw new Error(
      'structured_output_schema cannot be combined with permission_preset: plan',
    );
  }
}

export function parseThinkingEffort(
  raw: string | undefined,
): ThinkingLevel | undefined {
  return parseThinkingLevelInput(raw, { field: 'thinking_effort' });
}

export function parseSettingSources(
  raw: string | undefined,
): SettingSource[] | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }

  const trimmed = raw.trim();
  let values: string[];

  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(
        'setting_sources must be a JSON array of strings or a comma-separated list',
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error('setting_sources JSON value must be an array');
    }
    values = parsed.map((entry) => {
      if (typeof entry !== 'string') {
        throw new Error('setting_sources entries must be strings');
      }
      return entry.trim();
    });
  } else {
    values = trimmed
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  const normalized: SettingSource[] = [];
  for (const value of values) {
    if (!isSettingSource(value)) {
      throw new Error(
        'setting_sources entries must be one of: user, project, local',
      );
    }
    if (!normalized.includes(value)) {
      normalized.push(value);
    }
  }

  return normalized;
}

export function parseClaudeSdkPluginsEnv(
  raw: string | undefined,
): SdkPluginConfig[] | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(
      `${brandEnvName('CLAUDE_SDK_PLUGINS')} is not valid JSON and will be ignored: ${String(error)}\n`,
    );
    return undefined;
  }

  if (!Array.isArray(parsed)) {
    process.stderr.write(
      `${brandEnvName('CLAUDE_SDK_PLUGINS')} must be a JSON array and will be ignored.\n`,
    );
    return undefined;
  }

  const plugins: SdkPluginConfig[] = [];
  for (const entry of parsed) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      plugins.push({ type: 'local', path: entry.trim() });
    }
  }

  return plugins.length > 0 ? plugins : undefined;
}

/**
 * The Agent Ledger tools a desktop step hands its agent's Claude queries: the
 * host's MCP route for this attempt, the tool names to allow and the Ledger
 * block for the system prompt. Only the five pipeline agent actions read it;
 * `router`, `condenser` and `quality-gate` never do.
 */
export interface PipelineLedgerTools {
  readonly mcpServers: Record<string, McpHttpServerConfig>;
  readonly allowedTools: readonly string[];
  readonly instructions: string;
}

function readRecordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function parseLedgerMcpServer(value: unknown): McpHttpServerConfig | undefined {
  const server = readRecordValue(value);
  const headers = readRecordValue(server?.headers);
  if (
    server?.type !== 'http' ||
    typeof server.url !== 'string' ||
    headers === undefined ||
    !Object.values(headers).every((header) => typeof header === 'string')
  ) {
    return undefined;
  }
  const stringHeaders: Record<string, string> = {};
  for (const [name, header] of Object.entries(headers)) {
    if (typeof header === 'string') stringHeaders[name] = header;
  }
  return {
    type: 'http',
    url: server.url,
    headers: stringHeaders,
    ...(typeof server.timeout === 'number' ? { timeout: server.timeout } : {}),
    ...(server.alwaysLoad === true ? { alwaysLoad: true } : {}),
  };
}

/**
 * Parses `PIPELINE_LEDGER_TOOLS`. Absent means no Ledger tools. A malformed
 * value also means none (the step runs as it would without the Ledger), and
 * the warning never repeats the value, which carries the route's token.
 */
export function parsePipelineLedgerToolsEnv(
  raw: string | undefined,
): PipelineLedgerTools | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const warn = (): undefined => {
    process.stderr.write(
      `${brandEnvName('PIPELINE_LEDGER_TOOLS')} is malformed; the Feed tools are not available to this step.\n`,
    );
    return undefined;
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return warn();
  }
  const record = readRecordValue(parsed);
  const servers = readRecordValue(record?.mcpServers);
  if (
    record === undefined ||
    servers === undefined ||
    !Array.isArray(record.allowedTools) ||
    typeof record.instructions !== 'string'
  ) {
    return warn();
  }
  const mcpServers: Record<string, McpHttpServerConfig> = {};
  for (const [name, value] of Object.entries(servers)) {
    const server = parseLedgerMcpServer(value);
    if (server === undefined) return warn();
    mcpServers[name] = server;
  }
  const allowedTools: string[] = [];
  for (const tool of record.allowedTools) {
    if (typeof tool !== 'string' || tool.length === 0) return warn();
    allowedTools.push(tool);
  }
  if (Object.keys(mcpServers).length === 0) return warn();
  return { mcpServers, allowedTools, instructions: record.instructions };
}

/** The step's Ledger tools, from the environment the executor supplied. */
export function readPipelineLedgerTools(
  env: NodeJS.ProcessEnv,
): PipelineLedgerTools | undefined {
  return parsePipelineLedgerToolsEnv(getBrandEnv(env, 'PIPELINE_LEDGER_TOOLS'));
}

/**
 * Parses the JSON-array-of-strings env var the executor injects with the
 * exact pipeline `secrets:`-block/AI-Credits values in scope for this step
 * (mirrors `getSecretValues(runStepOptions.secretEnv)` on the host side, the
 * same value set the Codex/Cursor host-runner interceptors and the Claude
 * in-process worker path redact with). This subprocess has no other way to
 * distinguish a "secret" env var's value from an ordinary one once
 * `secretEnv` is merged into `process.env` alongside `env`, so the value list
 * travels through its own channel rather than being inferred from env keys.
 *
 * A missing/empty channel is the legitimate default for any non-model-aware
 * caller and returns `[]` (no protection needed because there is nothing to
 * redact against). A *present but unparseable* channel is different: it means
 * the executor tried to hand over the secret list and something is wrong, so
 * silently continuing with `[]` would run the whole step with redaction
 * quietly disabled. That case throws instead of returning an empty list, so
 * the step fails loudly rather than persisting an agent's output unprotected.
 * Neither the raw env value nor the underlying `JSON.parse` error message is
 * ever logged or included in the thrown error — both can contain excerpts of
 * the actual secret values (the raw value always does; newer JS engines can
 * include an input excerpt in a `SyntaxError` message).
 */
export function parseAgentSecretValuesEnv(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${brandEnvName('AGENT_SECRET_VALUES')} was set but could not be parsed as JSON; refusing to run without secret redaction.`,
    );
  }

  if (
    !Array.isArray(parsed) ||
    !parsed.every((value) => typeof value === 'string')
  ) {
    throw new Error(
      `${brandEnvName('AGENT_SECRET_VALUES')} was set but was not a JSON array of strings; refusing to run without secret redaction.`,
    );
  }

  return parsed;
}

export function parseBooleanInput(
  raw: string | undefined,
  fieldName: string,
  defaultValue: boolean,
): boolean {
  if (!raw || raw.trim().length === 0) {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }

  throw new Error(`${fieldName} must be "true", "false", "1", or "0" when set`);
}

export function parseModelConfigEnv(
  raw: string | undefined,
): AgentModelConfig | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const normalized = normalizeAgentModelConfig(parsed);
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      'fastMode' in parsed &&
      normalized?.fastMode === undefined
    ) {
      process.stderr.write(
        `Warning: ${brandEnvName('MODEL_CONFIG')}.fastMode must be a boolean when set; falling back.\n`,
      );
    }
    return normalized;
  } catch {
    process.stderr.write(
      `Warning: ${brandEnvName('MODEL_CONFIG')} must be valid JSON; falling back.\n`,
    );
    return undefined;
  }
}

export function resolveFastModeInput(env: NodeJS.ProcessEnv): boolean {
  if (env.INPUT_FAST_MODE && env.INPUT_FAST_MODE.trim().length > 0) {
    return parseBooleanInput(env.INPUT_FAST_MODE, 'fast_mode', false);
  }
  const modelConfig = parseModelConfigEnv(getBrandEnv(env, 'MODEL_CONFIG'));
  // Pipelines cannot run Ultra fast. Without an explicit step boolean, an
  // Ultra fast run config is rejected rather than silently running Regular.
  if (modelConfig?.speed === 'ultrafast') {
    throw new Error(
      'Workflows do not support Ultra fast. Set fast_mode on this step, or run the workflow with Regular or Fast.',
    );
  }
  if (typeof modelConfig?.fastMode === 'boolean') {
    return modelConfig.fastMode;
  }
  return parseBooleanInput(
    getBrandEnv(env, 'FAST_MODE_ENABLED'),
    brandEnvName('FAST_MODE_ENABLED'),
    false,
  );
}

export function parseSessionId(raw: string | undefined): string {
  if (!raw || raw.trim().length === 0) {
    throw new Error('session_id is required');
  }

  return raw.trim();
}

/**
 * Redacts a whitespace-normalized view of agent-authored text against a
 * secret list expanded with each value's own normalized form, in a single
 * `redactValuesUnfiltered` pass over the already-normalized text.
 *
 * A single normalize-then-redact pass alone misses a multi-line secret (a
 * PEM key) echoed verbatim: normalizing collapses the secret's own internal
 * newlines before the exact-match pass runs, so the still-complete,
 * collapsed secret leaks. Redacting the raw text first and normalizing
 * after ("sandwiching" a second redact pass around the normalize) closes
 * that hole but reopens a different one when two configured values share a
 * whitespace-differing prefix/suffix: the first pass's `***` for the longer
 * value can consume characters the shorter value's own occurrence needed,
 * leaking the shorter value's whitespace-reformatted remainder. Expanding
 * the value list with each value's OWN normalized form and matching once
 * against the already-normalized text closes both hazards in the one pass
 * `redactValues` already uses everywhere else (longest-match-first, no
 * value processed twice), so overlapping values can't interact across
 * passes.
 *
 * Eligibility (the `>= 6` character minimum) is decided ONCE from each
 * value's ORIGINAL form via `redactValuesUnfiltered` rather than
 * `redactValues`: an eligible value's normalized form can itself be shorter
 * than 6 characters (`'ab cd'`, 10 raw chars, normalizes to the
 * 5-character `'ab cd'`), and re-applying the minimum-length filter to that
 * transformed variant would silently drop protection for a value that
 * already qualified — the filter guards against colliding with ordinary
 * short text, not against masking a value's own normalized form once it has
 * already cleared the bar in its original form. An empty normalized form
 * (a whitespace-only value) is dropped rather than passed through, since
 * matching `''` would redact indiscriminately.
 */
export function redactNormalizedText(
  text: string,
  secretValues: readonly string[],
): string {
  const eligible = withJsonEscapedVariants(
    Array.from(new Set(secretValues.filter((value) => value.length >= 6))),
  );
  if (eligible.length === 0) {
    return normalizeSingleLine(text);
  }
  const expandedValues = Array.from(
    new Set([
      ...eligible,
      ...eligible
        .map((value) => normalizeSingleLine(value))
        .filter((value) => value.length > 0),
    ]),
  ).sort((left, right) => right.length - left.length);
  return redactValuesUnfiltered(normalizeSingleLine(text), expandedValues);
}

/**
 * `redactNormalizedText`, but returns the ORIGINAL `text` unchanged when no
 * secret actually matched — `redactNormalizedText` itself unconditionally
 * returns the whitespace-normalized form even with nothing redacted, which
 * is correct for a field whose whole point is normalized projection (like
 * `text_response`), but wrong for a single leaf embedded in an otherwise-
 * untouched structure (`redactNormalizedStructuredValue` below), where
 * reformatting content that never contained a secret would be a silent,
 * unwanted content change.
 *
 * Match detection mirrors `redactNormalizedText`'s own eligibility and
 * normalized-form expansion, checked directly against the normalized text,
 * rather than sniffing the REDACTED OUTPUT for the literal `***` placeholder
 * — that would false-positive whenever the original text already contained
 * `***` on its own (a markdown thematic break or bold-italic delimiter,
 * routine in agent-authored summaries), unconditionally whitespace-
 * collapsing a leaf that never matched any configured secret.
 */
function redactNormalizedTextIfMatched(
  text: string,
  secretValues: readonly string[],
): string {
  const eligible = withJsonEscapedVariants(
    Array.from(new Set(secretValues.filter((value) => value.length >= 6))),
  );
  if (eligible.length === 0) return text;
  const expandedValues = [
    ...eligible,
    ...eligible
      .map((value) => normalizeSingleLine(value))
      .filter((value) => value.length > 0),
  ];
  const normalized = normalizeSingleLine(text);
  const matched = expandedValues.some((value) => normalized.includes(value));
  return matched ? redactNormalizedText(text, secretValues) : text;
}

/**
 * A model-supplied numeric output that stays finite AND cannot echo a
 * configured value.
 *
 * `Number(...)` coercion alone protects only NON-numeric text: a configured
 * value that already is a number (or a numeric string) survives it exactly,
 * so `router`'s `confidence` and `quality-gate`'s `score` wrote a configured
 * `123456` verbatim to their step outputs, and quality-gate's threshold error
 * repeated it.
 *
 * TWO textual forms can therefore carry a configured value, and both are
 * matched:
 *
 * - what the model SUPPLIED, for a value that coercion would destroy on its
 *   way to the output (`"0.9 SECRET"` coerces to `NaN`, so only the supplied
 *   text ever held the value); and
 * - what this function EMITS, for a value that coercion CONSTRUCTS. `[123456]`,
 *   `"1.23456e5"` and `"0x1e240"` contain no configured value as written, yet
 *   each coerces to the number whose canonical text IS the configured
 *   `123456`. The output file is what leaks, so the emitted representation has
 *   to clear the same bar as the supplied one.
 *
 * Both checks use the same eligibility and normalized/escaped expansion every
 * other masked field uses, and a match falls back to the documented finite `0`
 * rather than emitting `***` into a field a downstream `if:` expression
 * compares numerically. `0` can never itself be a configured value: one
 * character cannot clear the length-6 floor.
 *
 * Coercion of a non-matching value is unchanged, so the documented table in
 * `docs/pipelines.md` still holds exactly: `0.9`/`"0.9"`/`" 0.9 "` stay `0.9`,
 * `true` stays `1`, and `"high"`/`""`/missing stay `0`.
 */
export function redactedFiniteNumber(
  value: unknown,
  secretValues: readonly string[],
): number {
  const supplied = value ?? 0;
  // Only a primitive has a textual form of its own. A non-primitive is covered
  // by the emitted-text check below, which is what its coercion produces.
  const suppliedText =
    typeof supplied === 'string' ||
    typeof supplied === 'number' ||
    typeof supplied === 'boolean' ||
    typeof supplied === 'bigint'
      ? String(supplied)
      : undefined;
  const coerced = Number(supplied);
  const finite = Number.isFinite(coerced) ? coerced : 0;
  for (const text of [suppliedText, String(finite)]) {
    if (text === undefined) continue;
    if (redactNormalizedTextIfMatched(text, secretValues) !== text) return 0;
  }
  return finite;
}

/**
 * `redactStructuredValue` with whitespace-reformatted-secret protection on
 * each STRING leaf (`redactNormalizedTextIfMatched`'s guarantee) instead of
 * `redactValues`'s verbatim-only one — for a caller whose structured value
 * ultimately becomes a human-facing projection field (like `condenser`'s
 * `structured-summary` strategy) rather than a raw/fidelity-preserving
 * artifact.
 *
 * This is NOT the same as calling `redactNormalizedText` on the whole
 * serialized value: that would risk the JSON-corruption class
 * `redactSerializedJsonLine` exists to avoid (operating on already-
 * serialized text), and would unconditionally whitespace-collapse the
 * ENTIRE text — including leaves that never contained a secret at all,
 * which is exactly the regression class `git-commit-push`'s reverted
 * `precommitFailureError` fix hit. Walking the DECODED structure and only
 * substituting a leaf's normalized+redacted form when a match was actually
 * found there avoids both. Numbers and object keys stay on
 * `redactStructuredValue`'s existing verbatim-only matching — reformatting
 * a number or a short key name by an agent is not a realistic case this
 * needs to cover.
 */
export function redactNormalizedStructuredValue(
  value: unknown,
  secretValues: readonly string[],
): unknown {
  if (value === undefined) return undefined;
  const values = Array.from(
    new Set(secretValues.filter((candidate) => candidate.length >= 6)),
  );
  if (values.length === 0) return value;
  return redactNormalizedStructuredNode(value, values);
}

function redactNormalizedStructuredNode(
  node: unknown,
  values: readonly string[],
): unknown {
  if (typeof node === 'string') {
    return redactNormalizedTextIfMatched(node, values);
  }
  if (typeof node === 'number') {
    const text = String(node);
    const masked = redactValues(text, values);
    return masked === text ? node : masked;
  }
  if (Array.isArray(node)) {
    return node.map((item) => redactNormalizedStructuredNode(item, values));
  }
  if (node !== null && typeof node === 'object') {
    const original = Object.entries(node);
    // Reserve every key this pass does NOT mask BEFORE allocating any name.
    // Accumulating `usedKeys` as the loop went meant a masked key could take a
    // name a LATER ordinary key already held, pushing that ordinary key to a
    // suffixed name — renaming a key masking had no part in. `{"***":1,
    // "SECRET":2,"***__1":3}` produced `***__1__1` for the untouched third
    // key. `redactSerializedJsonLine` has always reserved the whole record
    // first; a parsed object is equally whole, so it gets the same guarantee.
    const reserved = new Set<string>(
      original
        .map(([key]) => key)
        .filter((key) => redactValues(key, values) === key),
    );
    const nextSuffix = new Map<string, number>();
    const entries: [string, unknown][] = [];
    for (const [key, entryValue] of original) {
      const candidateKey = redactValues(key, values);
      let redactedKey = candidateKey;
      if (candidateKey !== key) {
        // Resume from where this base name's search last stopped: a reserved
        // name is never released, so a rejected candidate cannot become free.
        let suffix = nextSuffix.get(candidateKey) ?? 1;
        while (reserved.has(redactedKey)) {
          redactedKey = `${candidateKey}__${suffix}`;
          suffix += 1;
        }
        nextSuffix.set(candidateKey, suffix);
        reserved.add(redactedKey);
      }
      entries.push([
        redactedKey,
        redactNormalizedStructuredNode(entryValue, values),
      ]);
    }
    return Object.fromEntries(entries);
  }
  return node;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readContentBlocks(event: Record<string, unknown>): unknown[] {
  const message = readRecord(event.message);
  const content = message?.content ?? event.content;
  return Array.isArray(content) ? content : [];
}

export function extractClaudeProposedPlanFromJsonl(
  jsonl: string,
): string | undefined {
  let proposedPlan: string | undefined;
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const event = readRecord(parsed);
    if (!event || event.type !== 'assistant') {
      continue;
    }

    for (const block of readContentBlocks(event)) {
      const record = readRecord(block);
      if (record?.type !== 'tool_use' || record.name !== 'ExitPlanMode') {
        continue;
      }
      const input = readRecord(record.input);
      if (typeof input?.plan === 'string' && input.plan.trim().length > 0) {
        proposedPlan = input.plan;
      }
    }
  }

  return proposedPlan;
}

function isRtkEnabledFromEnv(): boolean {
  return getBrandEnv(process.env, 'PREF_RTK_ENABLED') !== 'false';
}

function resolveClaudeModAdmissionLaunch(
  input: QueryOptionInput,
): ClaudeModAdmissionLaunch | undefined {
  return readClaudeModAdmissionEnvelope(
    getBrandEnv(process.env, 'CLAUDE_MOD_ADMISSION'),
    {
      cwd: input.cwd,
      settingSources: input.settingSources ?? DEFAULT_SETTING_SOURCES,
    },
  );
}

export function buildQueryOptions(input: QueryOptionInput): Options {
  const claudeModAdmission = resolveClaudeModAdmissionLaunch(input);
  const ledgerTools =
    input.permissionPreset === 'plan' ? undefined : input.ledgerTools;
  // The Ledger tools are the host's own bookkeeping route: the presets that
  // otherwise leave a tool unapproved allow them explicitly.
  const ledgerAllowedTools = ledgerTools?.allowedTools ?? [];
  const permissionOptions =
    input.permissionPreset === 'read_only'
      ? {
          tools: [...READ_ONLY_TOOLS],
          allowedTools: [...READ_ONLY_TOOLS, ...ledgerAllowedTools],
        }
      : input.permissionPreset === 'dangerous_all'
        ? {
            tools: {
              type: 'preset' as const,
              preset: 'claude_code' as const,
            },
            permissionMode: 'bypassPermissions' as const,
            allowDangerouslySkipPermissions: true,
          }
        : input.permissionPreset === 'plan'
          ? {
              permissionMode: 'plan' as const,
            }
          : {
              tools: [],
              ...(ledgerAllowedTools.length > 0
                ? { allowedTools: [...ledgerAllowedTools] }
                : {}),
            };
  const systemPrompt =
    [input.systemPrompt, ledgerTools?.instructions]
      .filter((part): part is string => Boolean(part))
      .join('\n\n') || undefined;
  const rtkHooks =
    (input.provider ?? 'claude') === 'claude' && isRtkEnabledFromEnv()
      ? buildRtkClaudeHooks({
          rtkBinaryPath: getBundledRtkBinaryPath(),
          env: withoutAgentSecretValues(process.env),
        })
      : undefined;
  const thinkingOptions = input.thinkingLevel
    ? buildClaudeThinkingOptions(
        clampThinkingLevelForModel(input.thinkingLevel, input.model),
      )
    : undefined;
  const nativeMemoryOptions = claudeNativeMemoryOptions(
    localMemoryEnabledFromEnv(),
    thinkingOptions?.settings,
  );
  const mergedAdmissionSettings = claudeModAdmission?.settings
    ? mergeClaudeModAdmissionSettings(
        nativeMemoryOptions.settings ?? {},
        claudeModAdmission.settings,
      )
    : undefined;

  return {
    cwd: input.cwd,
    // The Claude CLI and the tools it runs inherit everything this action
    // has except the aggregate of configured values, which is for this
    // action's own masking only (`withoutAgentSecretValues`).
    env: withoutAgentSecretValues(process.env),
    maxTurns: input.maxTurns,
    persistSession: input.persistSession ?? false,
    sandbox: {
      ripgrep: {
        command:
          getBrandEnv(process.env, 'RG_BINARY_PATH') ??
          process.env.RG_EXECUTABLE ??
          'rg',
      },
    },
    pathToClaudeCodeExecutable:
      getBrandEnv(process.env, 'CLAUDE_BINARY_PATH') ??
      process.env.CLAUDE_CODE_EXECUTABLE ??
      'claude',
    settingSources: input.settingSources ?? DEFAULT_SETTING_SOURCES,
    ...permissionOptions,
    ...(input.model ? { model: input.model } : {}),
    ...(thinkingOptions ?? {}),
    // Merge with the thinking settings (Ultra sets `ultracode`) so the
    // spread cannot drop the native-memory suppression applied while local
    // memory is enabled (CAN-1969). Builtin actions run as plain Node
    // subprocesses; the desktop step runner projects the opt-in preference
    // into the branded `PREF_LOCAL_MEMORY_ENABLED` env var, and CLI-launched
    // steps without it treat local memory as OFF (provider defaults).
    ...nativeMemoryOptions,
    ...(mergedAdmissionSettings ? { settings: mergedAdmissionSettings } : {}),
    ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
    ...(systemPrompt
      ? {
          systemPrompt: {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: systemPrompt,
          },
        }
      : {}),
    ...(input.schema
      ? {
          outputFormat: {
            type: 'json_schema' as const,
            schema: input.schema,
          },
        }
      : {}),
    ...(rtkHooks ? { hooks: rtkHooks } : {}),
    // The envelope only filters the step's own plugins; it never adds any.
    ...(input.plugins
      ? {
          plugins: claudeModAdmission
            ? filterToClaudeModLaunchPlugins(input.plugins, claudeModAdmission)
            : input.plugins,
        }
      : {}),
    ...(ledgerTools ? { mcpServers: { ...ledgerTools.mcpServers } } : {}),
  };
}

function parseJsonResult(rawText: string): unknown {
  const candidate =
    rawText.match(/```(?:json)?\s*\n?([\s\S]*?)```/)?.[1]?.trim() ??
    rawText.trim();
  if (!candidate) {
    return undefined;
  }

  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }
}

function extractStructuredToolInput(events: unknown[]): unknown {
  for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
    const event = readRecord(events[eventIndex]);
    if (event?.type !== 'assistant') {
      continue;
    }

    const message = readRecord(event.message);
    const contentCandidate = message?.content;
    if (!isUnknownArray(contentCandidate)) {
      continue;
    }

    const content = contentCandidate;
    for (let index = content.length - 1; index >= 0; index -= 1) {
      const block = content[index];
      if (!block || typeof block !== 'object') {
        continue;
      }

      const maybeToolUse = block as {
        input?: unknown;
        name?: unknown;
        type?: unknown;
      };
      if (
        maybeToolUse.type === 'tool_use' &&
        maybeToolUse.name === 'StructuredOutput'
      ) {
        return maybeToolUse.input;
      }
    }
  }

  return undefined;
}

function isErrorResult(result: Record<string, unknown>): boolean {
  return result.is_error === true;
}

function isSuccessResult(result: Record<string, unknown>): boolean {
  return result.is_error === false;
}

function formatResultError(result: Record<string, unknown>): string {
  const messages = Array.isArray(result.errors)
    ? result.errors
        .filter((error): error is string => typeof error === 'string')
        .join('; ')
        .trim()
    : '';
  const subtype = typeof result.subtype === 'string' ? result.subtype : 'error';
  return messages.length > 0
    ? `Claude query failed (${subtype}): ${messages}`
    : `Claude query failed (${subtype})`;
}

export function extractFinalResult(
  events: unknown[],
  expectStructured: boolean,
): ExtractedResult {
  let result: Record<string, unknown> | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = readRecord(events[index]);
    if (event?.type === 'result') {
      result = event;
      break;
    }
  }

  if (!result) {
    throw new Error('Claude SDK stream ended without a terminal result event');
  }

  if (isErrorResult(result)) {
    throw new Error(formatResultError(result));
  }

  if (!isSuccessResult(result)) {
    throw new Error('Claude query failed with an unknown result state');
  }

  const rawText = readString(result, 'result');
  const structured =
    result.structured_output ??
    extractStructuredToolInput(events) ??
    parseJsonResult(rawText);

  if (expectStructured && structured === undefined) {
    throw new Error('Claude query did not return structured output');
  }

  return { rawText, structured };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function extractClaudeProposedPlan(
  events: unknown[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const assistantEvent: unknown = events[index];
    if (
      !isObjectRecord(assistantEvent) ||
      assistantEvent.type !== 'assistant'
    ) {
      continue;
    }

    const message = assistantEvent.message;
    if (!isObjectRecord(message)) {
      continue;
    }

    const content = message.content;
    if (!isUnknownArray(content)) {
      continue;
    }

    for (let index = content.length - 1; index >= 0; index -= 1) {
      const block = content[index];
      if (!isObjectRecord(block)) {
        continue;
      }

      const toolName = typeof block.name === 'string' ? block.name : undefined;
      if (block.type !== 'tool_use' || toolName !== 'ExitPlanMode') {
        continue;
      }

      const input = isObjectRecord(block.input) ? block.input : undefined;
      const plan = typeof input?.plan === 'string' ? input.plan.trim() : '';
      if (plan.length > 0) {
        return plan;
      }
    }
  }

  return undefined;
}

interface SyntheticClaudeTerminalResult {
  type: 'result';
  subtype: 'success';
  is_error: false;
  result: string;
  session_id: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    reasoning_output_tokens: number;
  };
  total_cost_usd?: number;
}

interface ClaudeTerminalChatMessage {
  type: 'assistant' | 'user';
  message: Record<string, unknown>;
  session_id: string;
}

/**
 * Redacts each event with `redactStructuredValue` BEFORE `JSON.stringify` —
 * see `createTranscriptCapture`'s doc comment (`_lib/agent-transcript.ts`)
 * for why a multi-line secret echoed verbatim needs this instead of a
 * string-based redaction pass over the already-serialized text.
 */
export function serializeTranscript(
  events: unknown[],
  secretValues: readonly string[] = [],
): string {
  if (events.length === 0) {
    return '';
  }

  return `${events
    .map((event) =>
      JSON.stringify(
        secretValues.length === 0
          ? event
          : redactStructuredValue(event, secretValues),
      ),
    )
    .join('\n')}\n`;
}

function readString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : '';
}

function normalizeClaudeTerminalEventToSdkMessage(
  event: unknown,
): Record<string, unknown> | ClaudeTerminalChatMessage | undefined {
  const record = readRecord(event);
  if (!record) {
    return undefined;
  }

  if (record.type === 'system') {
    return {
      type: 'system',
      subtype: readString(record, 'subtype'),
      session_id:
        readString(record, 'session_id') || readString(record, 'sessionId'),
      cwd: readString(record, 'cwd'),
      tools: Array.isArray(record.tools) ? (record.tools as string[]) : [],
      mcp_servers: Array.isArray(record.mcp_servers)
        ? (record.mcp_servers as { name: string; status: string }[])
        : [],
      model: readString(record, 'model'),
      permissionMode: readString(record, 'permissionMode'),
      apiKeySource: readString(record, 'apiKeySource'),
    };
  }

  if (record.type === 'assistant' || record.type === 'user') {
    const message = readRecord(record.message);
    if (!message) {
      return undefined;
    }
    return {
      type: record.type,
      message,
      session_id:
        readString(record, 'session_id') || readString(record, 'sessionId'),
    };
  }

  return undefined;
}

export function normalizeClaudeTerminalTranscriptToSdkJsonl(
  events: unknown[],
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    reasoningOutputTokens?: number;
    totalCostUsd?: number;
  },
  finalText: string,
): string {
  const normalized: unknown[] = [];
  for (const event of events) {
    const normalizedEvent = normalizeClaudeTerminalEventToSdkMessage(event);
    if (normalizedEvent !== undefined) {
      normalized.push(normalizedEvent);
    }
  }

  const resultEvent: SyntheticClaudeTerminalResult = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: finalText,
    session_id: '',
    usage: {
      input_tokens: usage.inputTokens ?? 0,
      output_tokens: usage.outputTokens ?? 0,
      cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
      cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
      reasoning_output_tokens: usage.reasoningOutputTokens ?? 0,
    },
    ...(typeof usage.totalCostUsd === 'number'
      ? { total_cost_usd: usage.totalCostUsd }
      : {}),
  };
  normalized.push(resultEvent);

  return serializeTranscript(normalized);
}

function readStringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  if (typeof candidate !== 'string') {
    return undefined;
  }

  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toRecord(value: object): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    record[key] = entryValue;
  }
  return record;
}

export function extractClaudeSessionId(events: unknown[]): string {
  for (const event of events) {
    const record = readRecord(event);
    if (record?.type !== 'system') {
      continue;
    }

    const sessionId = readString(record, 'session_id');
    if (sessionId.trim().length > 0) {
      return sessionId;
    }
  }

  throw new Error('Claude SDK stream ended without a session ID');
}

export interface CodexThreadOptionInput {
  cwd: string;
  model: string;
  permissionPreset: PermissionPreset;
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
}
export function getModelProviderInput(
  model: string | undefined,
): 'claude' | 'codex' | 'ollama' {
  if (!model) {
    return 'claude';
  }
  const provider = requireProviderForModel(resolveModelAlias(model));
  if (provider === 'cursor')
    throw new Error('Cursor is not available in this action.');
  if (provider === 'opencode')
    throw new Error('OpenCode is not available in this action.');
  if (provider === 'copilot')
    throw new Error('Copilot is not available in this action.');
  return provider;
}

export function buildCodexThreadOptions(
  input: CodexThreadOptionInput,
): CodexThreadOptions {
  const sandboxMode =
    input.permissionPreset === 'dangerous_all'
      ? 'danger-full-access'
      : input.permissionPreset === 'plan'
        ? 'read-only'
        : input.permissionPreset === 'read_only'
          ? 'read-only'
          : 'workspace-write';

  return {
    model: input.model,
    workingDirectory: input.cwd,
    sandboxMode,
    approvalPolicy: 'never',
    // Directory-scoped runs (cowork roots, the App Advisor home) are not git
    // repositories; without this Codex exec aborts with "Not inside a trusted
    // directory". Safety comes from sandboxMode, matching the one-shot
    // helper flows which also always skip the interactive repo-trust check.
    skipGitRepoCheck: true,
    ...(input.thinkingLevel
      ? {
          modelReasoningEffort: mapThinkingToReasoningEffort(
            input.thinkingLevel,
            input.model,
          ),
        }
      : {}),
  };
}

export function buildCodexSystemPrompt(
  systemPrompt: string | undefined,
  permissionPreset: PermissionPreset,
): string | undefined {
  if (permissionPreset !== 'plan') {
    return systemPrompt;
  }

  const planModeInstructions =
    buildCodexPlanModeDeveloperInstructions('required');
  return systemPrompt
    ? `${planModeInstructions}\n\n${systemPrompt}`
    : planModeInstructions;
}

export function buildCodexPrompt(
  prompt: string,
  systemPrompt?: string,
): string {
  if (systemPrompt) {
    return `${systemPrompt}\n\n${prompt}`;
  }
  return prompt;
}
export function extractCodexSessionId(
  events: Record<string, unknown>[],
  fallback?: string,
): string {
  for (const event of events) {
    if (event.type !== 'thread.started') {
      continue;
    }

    const threadId = readStringField(event, 'thread_id');
    if (threadId) {
      return threadId;
    }
  }

  if (fallback && fallback.trim().length > 0) {
    return fallback.trim();
  }

  throw new Error('Codex stream ended without a session ID');
}

export function extractCodexFinalResult(
  events: Record<string, unknown>[],
  expectStructured: boolean,
): ExtractedResult {
  let sawTerminalTurn = false;
  let sawStreamError = false;
  let streamErrorMessage: string | undefined;
  for (const event of events) {
    if (event.type === 'turn.completed') {
      sawTerminalTurn = true;
      continue;
    }

    if (event.type === 'turn.failed') {
      const errorRecord =
        typeof event.error === 'object' &&
        event.error !== null &&
        !Array.isArray(event.error)
          ? toRecord(event.error)
          : undefined;
      const message = errorRecord
        ? readStringField(errorRecord, 'message')
        : undefined;
      throw new Error(
        message ? `Codex query failed: ${message}` : 'Codex query failed',
      );
    }

    if (event.type === 'error') {
      sawStreamError = true;
      const message = readStringField(event, 'message');
      if (!streamErrorMessage) {
        streamErrorMessage = message;
      }
    }
  }

  if (!sawTerminalTurn) {
    throw new Error(
      sawStreamError
        ? streamErrorMessage
          ? `Codex query failed: ${streamErrorMessage}`
          : 'Codex query failed'
        : 'Codex query ended without a terminal turn event',
    );
  }

  // Find the last completed agent_message item
  let rawText = '';
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'item.completed') {
      const item = event.item as Record<string, unknown> | undefined;
      if (item && item.type === 'agent_message') {
        rawText = typeof item.text === 'string' ? item.text : '';
        break;
      }
    }
  }

  if (rawText.trim().length === 0) {
    throw new Error('Codex query did not return a final response');
  }

  const structured = parseJsonResult(rawText);
  if (expectStructured && structured === undefined) {
    throw new Error('Codex query did not return structured output');
  }

  return { rawText, structured };
}

export function extractCodexProposedPlan(
  events: Record<string, unknown>[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event.type !== 'item.completed') {
      continue;
    }

    const item =
      isObjectRecord(event.item) && !Array.isArray(event.item)
        ? event.item
        : undefined;
    if (!item) {
      continue;
    }

    if (item.type === 'agent_message') {
      const plan = extractProposedPlan(
        typeof item.text === 'string' ? item.text : undefined,
      );
      if (plan) {
        return plan;
      }
    }

    if (item.type === 'plan') {
      const plan = typeof item.text === 'string' ? item.text.trim() : '';
      if (plan.length > 0) {
        return plan;
      }
    }
  }

  return undefined;
}
