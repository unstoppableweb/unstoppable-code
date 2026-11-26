/**
 * Model requests for bundled helper actions whose single model turn can run
 * through a host prompt runner (CAN-6702). The executor builds the request
 * from the step's inputs, runs it on the step's own harness, and hands the
 * redacted result to the action, which applies its usual output mapping and
 * redaction. The action builds the same request when it calls Claude itself,
 * so both paths share one prompt and schema.
 */

/** Brand-managed env name for the host-written model result file. */
export const HOST_HELPER_MODEL_RESULT_ENV = 'HELPER_MODEL_RESULT_FILE';

/**
 * Helper actions whose model turn can run through a host prompt runner. Every
 * member must make no model call of its own when the result file is present:
 * the executor skips its Claude route and refusal for these steps.
 */
export const HOST_HELPER_MODEL_ACTIONS: ReadonlySet<string> = new Set([
  'builtin/router',
  'builtin/condenser',
]);

/**
 * Helper actions that make one model call per discovered repository and have
 * git or GitHub side effects, keyed to the input that names their model
 * (CAN-6702 stage 1b). On a host-run harness they run in three phases: the
 * action prepares one request per repository with no side effects, the
 * executor runs each request on the host runner, and the action applies the
 * results, refusing any repository whose request no longer matches.
 */
export const HOST_HELPER_BATCH_ACTIONS: ReadonlyMap<string, string> = new Map([
  ['builtin/git-commit-push', 'commit_model'],
  ['builtin/github-create-pr', 'pr_model'],
]);

/** Brand-managed env name for the file a preparing action writes requests to. */
export const HOST_HELPER_PREPARE_ENV = 'HELPER_MODEL_PREPARE_FILE';

/** Brand-managed env name for the host-written batch results file. */
export const HOST_HELPER_RESULTS_ENV = 'HELPER_MODEL_RESULTS_FILE';

/** At most this many host turns run for one step. */
export const HOST_HELPER_BATCH_MAX_REQUESTS = 32;

export interface HostHelperBatchRequest {
  /** sha256 hex of the repository and the request, computed by the action. */
  digest: string;
  systemPrompt: string;
  userMessage: string;
  schema: Record<string, unknown>;
}

export interface HostHelperBatchResult {
  digest: string;
  rawText: string;
  structured?: unknown;
}

/**
 * Where a repository that prepared no model request would push: a clean
 * worktree with unpushed commits, or a branch that already has a pull
 * request. Prepare records the repository and its target (HEAD, branch and
 * push URL) as digests; the host copies them into the results, and apply
 * pushes only while the digest still matches, so a push never goes
 * somewhere prepare did not see (CAN-6702).
 */
export interface HostHelperPreparedTarget {
  /** sha256 hex of the repository path. */
  repo: string;
  /** sha256 hex of the repository and its target. */
  digest: string;
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Requests a preparing action wrote. Malformed or oversized input throws. */
export function parseHostHelperBatchRequests(
  text: string,
): HostHelperBatchRequest[] {
  const parsed: unknown = JSON.parse(text);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.requests)
  )
    throw new Error('The helper model requests are malformed.');
  if (parsed.requests.length > HOST_HELPER_BATCH_MAX_REQUESTS)
    throw new Error(
      `This step needs more than ${String(HOST_HELPER_BATCH_MAX_REQUESTS)} model turns.`,
    );
  const seen = new Set<string>();
  const entries: unknown[] = parsed.requests;
  return entries.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.digest !== 'string' ||
      !DIGEST_PATTERN.test(entry.digest) ||
      seen.has(entry.digest) ||
      typeof entry.systemPrompt !== 'string' ||
      typeof entry.userMessage !== 'string' ||
      !isRecord(entry.schema)
    )
      throw new Error('The helper model requests are malformed.');
    seen.add(entry.digest);
    return {
      digest: entry.digest,
      systemPrompt: entry.systemPrompt,
      userMessage: entry.userMessage,
      schema: entry.schema,
    };
  });
}

/**
 * Prepared targets in a requests or results file; a file without any has
 * none. Malformed or oversized input throws.
 */
export function parseHostHelperPreparedTargets(
  text: string,
): HostHelperPreparedTarget[] {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || parsed.version !== 1)
    throw new Error('The helper model requests are malformed.');
  if (!('targets' in parsed)) return [];
  if (
    !Array.isArray(parsed.targets) ||
    parsed.targets.length > HOST_HELPER_BATCH_MAX_REQUESTS
  )
    throw new Error('The helper model requests are malformed.');
  const seen = new Set<string>();
  const entries: unknown[] = parsed.targets;
  return entries.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.repo !== 'string' ||
      !DIGEST_PATTERN.test(entry.repo) ||
      seen.has(entry.repo) ||
      typeof entry.digest !== 'string' ||
      !DIGEST_PATTERN.test(entry.digest)
    )
      throw new Error('The helper model requests are malformed.');
    seen.add(entry.repo);
    return { repo: entry.repo, digest: entry.digest };
  });
}

/** Results the host wrote, keyed by request digest. */
export function parseHostHelperBatchResults(
  text: string,
): ReadonlyMap<string, HostHelperBatchResult> {
  const parsed: unknown = JSON.parse(text);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.results)
  )
    throw new Error('The host model results for this helper are malformed.');
  const results = new Map<string, HostHelperBatchResult>();
  const entries: unknown[] = parsed.results;
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      typeof entry.digest !== 'string' ||
      !DIGEST_PATTERN.test(entry.digest) ||
      results.has(entry.digest) ||
      typeof entry.rawText !== 'string'
    )
      throw new Error('The host model results for this helper are malformed.');
    results.set(entry.digest, {
      digest: entry.digest,
      rawText: entry.rawText,
      ...('structured' in entry ? { structured: entry.structured } : {}),
    });
  }
  return results;
}

export interface HostHelperModelRequest {
  prompt: string;
  schema?: Record<string, unknown>;
}

export interface HostHelperModelResult {
  version: 1;
  rawText: string;
  structured?: unknown;
}

// One copy of the router's routes rule, which the workflow designer reads too.
export { parseRouterRoutes } from '@canopy/pipeline-interop/router-step';

export function buildRouterModelRequest(input: {
  text: string;
  routes: readonly string[];
  criteria?: string;
}): HostHelperModelRequest {
  return {
    prompt: [
      `Route the following input into exactly one of these labels: ${input.routes.join(', ')}`,
      input.criteria?.trim()
        ? `Routing criteria: ${input.criteria.trim()}`
        : '',
      '',
      input.text,
    ]
      .filter(Boolean)
      .join('\n'),
    schema: {
      type: 'object',
      properties: {
        route: { type: 'string', enum: [...input.routes] },
        confidence: { type: 'number' },
        reasoning: { type: 'string' },
      },
      required: ['route', 'confidence', 'reasoning'],
    },
  };
}

export type CondenseStrategy =
  | 'key-outputs'
  | 'recent-events'
  | 'llm-summary'
  | 'structured-summary';

export function parseCondenseStrategy(
  raw: string | undefined,
): CondenseStrategy {
  switch (raw?.trim() || 'key-outputs') {
    case 'key-outputs':
      return 'key-outputs';
    case 'recent-events':
      return 'recent-events';
    case 'llm-summary':
      return 'llm-summary';
    case 'structured-summary':
      return 'structured-summary';
    default:
      throw new Error(
        'strategy must be one of: key-outputs, recent-events, llm-summary, structured-summary',
      );
  }
}

export function parseCondenseMaxChars(raw: string | undefined): number {
  if (!raw || raw.trim().length === 0) {
    return 4000;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('max_chars must be a positive integer');
  }
  return parsed;
}

export function clipCondenserText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n...`;
}

/** Only the summarizing strategies call a model. */
export function condenserUsesModel(strategy: CondenseStrategy): boolean {
  return strategy === 'llm-summary' || strategy === 'structured-summary';
}

export const DEFAULT_CONDENSER_SCHEMA_TEXT =
  '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}';

/**
 * `text` is the full source; the request clips it to the same bound the
 * action has always used for its model call.
 */
export function buildCondenserModelRequest(input: {
  text: string;
  maxChars: number;
  structured: boolean;
  schema?: Record<string, unknown>;
}): HostHelperModelRequest {
  const text = clipCondenserText(
    input.text,
    Math.max(input.maxChars * 2, input.maxChars),
  );
  return {
    prompt: [
      input.structured
        ? 'Summarize the following context into a structured compact form.'
        : 'Summarize the following context into a concise compact summary.',
      '',
      text,
    ].join('\n'),
    ...(input.schema ? { schema: input.schema } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseHostHelperModelResult(
  text: string,
): HostHelperModelResult {
  const parsed: unknown = JSON.parse(text);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.rawText !== 'string'
  )
    throw new Error('The host model result for this helper is malformed.');
  return {
    version: 1,
    rawText: parsed.rawText,
    ...('structured' in parsed ? { structured: parsed.structured } : {}),
  };
}
