import {
  isDefaultPlanFilePath,
  parseToolInput,
} from '@canopy/agent-transcript/lib/plan-tool-input';

export { isPlanFileWrite } from '@canopy/agent-transcript/lib/plan-tool-input';

/**
 * Plan body out of an `ExitPlanMode` tool input (CAN-3019).
 *
 * Canopy deliberately answers `ExitPlanMode` with `behavior: 'deny'` so the plan
 * routes into Canopy's own review UI instead of the provider's. Every renderer
 * therefore has to recognize the call and draw the plan itself, or the denial
 * surfaces as a failed/rejected tool call and the user is told they rejected a
 * plan they never saw. Desktop's `ChatBlockRenderer` and both web transcript
 * renderers hold the input as a JSON string, so one extractor serves all three.
 *
 * Never throws: a malformed or non-plan input returns `null` and the caller
 * falls back to its ordinary tool rendering.
 *
 * Note the returned body may already carry a `[truncated N chars]` marker: the
 * portal wire caps every tool input at 4,000 characters before a renderer sees
 * it. Render what arrived; the marker is the honest signal.
 */
const REMOTE_CONTROL_TRUNCATION_SUFFIX = /\n\n\[truncated \d+ chars\]$/;
const TRUNCATED_PLAN_PREFIX = /^\s*\{\s*"plan"\s*:\s*"/;

function decodeTruncatedJsonStringPrefix(value: string): string | null {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') {
      // A closed plan string means some later field was truncated. Do not
      // reinterpret unrelated malformed JSON as a plan.
      return null;
    }
    if (char !== '\\') {
      if (char !== undefined && char < ' ') return null;
      decoded += char;
      continue;
    }

    const escaped = value[index + 1];
    if (escaped === undefined) break;
    index += 1;
    if (escaped === 'u') {
      const hex = value.slice(index + 1, index + 5);
      if (hex.length < 4) break;
      if (!/^[0-9a-f]{4}$/i.test(hex)) return null;
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
      continue;
    }
    const escapedCharacters: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    const decodedEscape = escapedCharacters[escaped];
    if (decodedEscape === undefined) return null;
    decoded += decodedEscape;
  }
  return decoded;
}

function extractWireTruncatedPlan(input: string): string | null {
  const suffix = REMOTE_CONTROL_TRUNCATION_SUFFIX.exec(input)?.[0];
  if (!suffix) return null;
  const serializedPrefix = input.slice(0, -suffix.length);
  const planPrefix = TRUNCATED_PLAN_PREFIX.exec(serializedPrefix)?.[0];
  if (!planPrefix) return null;
  const plan = decodeTruncatedJsonStringPrefix(
    serializedPrefix.slice(planPrefix.length),
  );
  if (!plan?.trim()) return null;
  return `${plan}${suffix}`;
}

export function extractExitPlanModePlan(input: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    // Live portal events historically truncate the serialized input object,
    // not the plan field, leaving a long plan as incomplete JSON followed by
    // the standard wire marker. Recover only that narrow, recognizable shape.
    return extractWireTruncatedPlan(input);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record: Record<string, unknown> = { ...parsed };
  const plan = record['plan'];
  if (typeof plan !== 'string' || plan.trim().length === 0) return null;
  return plan;
}

/**
 * One tool call of a turn, normalized by its host for
 * {@link resolvePlanTurn} (CAN-5354). Hosts list calls in the order the agent
 * made them and list each call once.
 */
export interface PlanTurnToolCall {
  readonly toolName: string;
  /** The call's input: a JSON string, or the parsed object. */
  readonly input: unknown;
  /** The call's result; absent while it runs or when none arrived. */
  readonly outcome?: 'success' | 'error';
}

/**
 * Whether a turn proposes a plan, and whether its Markdown can be copied.
 * `incomplete` is a recognized plan whose Markdown is missing or truncated:
 * its Copy stays visible but unavailable, never falling back to the reply.
 */
export type PlanTurnResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'complete'; readonly markdown: string }
  | { readonly kind: 'incomplete'; readonly reason: 'missing' | 'truncated' };

const NO_PLAN: PlanTurnResolution = { kind: 'none' };
const MISSING_PLAN: PlanTurnResolution = {
  kind: 'incomplete',
  reason: 'missing',
};
const TRUNCATED_PLAN: PlanTurnResolution = {
  kind: 'incomplete',
  reason: 'truncated',
};
const WIRE_TRUNCATION_MARKER = /\[truncated \d+ chars\]$/;

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** The Markdown of a plan field, or why it cannot be copied. */
function planMarkdown(value: string | undefined): PlanTurnResolution {
  if (value === undefined || value.trim() === '') return MISSING_PLAN;
  if (WIRE_TRUNCATION_MARKER.test(value)) return TRUNCATED_PLAN;
  return { kind: 'complete', markdown: value };
}

interface PlanFileWrite {
  readonly path?: string;
  readonly resolution: PlanTurnResolution;
}

function readPlanFileWrite(call: PlanTurnToolCall): PlanFileWrite | null {
  if (call.toolName !== 'Write' || call.outcome !== 'success') return null;
  const parsed = parseToolInput(call.input);
  // Until the host recovers this input, it may supersede a previous draft.
  // Keep its position so an older Write cannot silently become Copy's source.
  if (parsed.kind !== 'record') {
    return {
      resolution: parsed.kind === 'truncated' ? TRUNCATED_PLAN : MISSING_PLAN,
    };
  }
  const path = readString(parsed.record, 'file_path');
  if (path === undefined) return null;
  return {
    path,
    resolution: planMarkdown(readString(parsed.record, 'content')),
  };
}

function resolveExitPlanMode(
  call: PlanTurnToolCall,
  writes: readonly PlanFileWrite[],
): PlanTurnResolution {
  const parsed = parseToolInput(call.input);
  const record = parsed.kind === 'record' ? parsed.record : {};
  const attached =
    parsed.kind === 'truncated'
      ? TRUNCATED_PLAN
      : planMarkdown(readString(record, 'plan'));
  if (attached.kind === 'complete') return attached;
  // Claude Code reads the plan from its plan file, so the call often arrives
  // as `{}` after a Write of that file. Only this proposal's writes count.
  const planFilePath = readString(record, 'planFilePath');
  for (let index = writes.length - 1; index >= 0; index -= 1) {
    const write = writes[index];
    if (write === undefined) continue;
    if (write.path === undefined) return write.resolution;
    if (
      planFilePath !== undefined
        ? write.path !== planFilePath
        : !isDefaultPlanFilePath(write.path)
    )
      continue;
    return write.resolution;
  }
  return attached;
}

/**
 * The plan a turn proposes, for its Copy plan action (CAN-5354). The latest
 * proposal wins: its `ExitPlanMode` plan, else the successful plan-file Write
 * since the previous proposal (the one `planFilePath` names, when it does).
 * Without an `ExitPlanMode`, a successful Write to Claude Code's default plans
 * directory is the proposal. Markdown is returned exactly as written; a
 * Portal-truncated or absent body is `incomplete`, never an older plan.
 */
export function resolvePlanTurn(
  calls: readonly PlanTurnToolCall[],
): PlanTurnResolution {
  let resolution = NO_PLAN;
  let proposed = false;
  let writes: PlanFileWrite[] = [];
  for (const call of calls) {
    if (call.toolName === 'ExitPlanMode') {
      resolution = resolveExitPlanMode(call, writes);
      proposed = true;
      writes = [];
      continue;
    }
    const write = readPlanFileWrite(call);
    if (write === null) continue;
    writes.push(write);
    if (
      !proposed &&
      (write.path === undefined
        ? resolution.kind !== 'none'
        : isDefaultPlanFilePath(write.path))
    ) {
      resolution = write.resolution;
    }
  }
  return resolution;
}
