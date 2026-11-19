import { isAbsolute, resolve, sep } from 'node:path';

/** One tool call as the probe recorded it. */
export interface AntigravityQualificationToolCall {
  title: string;
  kind?: string | null;
  inputKeys?: readonly string[];
  status?: string | null;
  offeredOptionKinds?: readonly string[];
  decision?: { decision: 'allow' | 'deny'; reason?: string };
  /** From a `failed` update: its text content, `rawOutput` and error. */
  failureDetail?: string;
}

/**
 * What one live Antigravity session reported to
 * `scripts/antigravity/qualify-runtime.mjs`, and the checklist statements that
 * evidence supports (VIEW-03, CHAT-03, CHAT-06). The statements are derived
 * here, not written by hand, so the checklist cannot claim more than the
 * probe observed.
 */
/** Which copy of the CLI the probe launched. */
export type AntigravityExecutableSource = 'managed' | 'override' | 'path';

export interface AntigravityQualificationEvidence {
  runtimeVersion: string;
  /**
   * The managed copy Canopy installed, `ANTIGRAVITY_EXECUTABLE`, or a PATH
   * `agy`/`antigravity`. Absent from evidence written before it was recorded.
   */
  executableSource?: AntigravityExecutableSource;
  capturedAt: string;
  sessionCapabilities: Record<string, unknown>;
  /** Titles of tool calls that completed; only these count as evidence. */
  toolCallTitles: string[];
  /** `accepted` is null when the session was not attempted with one. */
  additionalDirectories: { advertised: boolean; accepted: boolean | null };
  /** Calls the probe denied, or that failed or never completed. */
  deniedOrFailedToolCalls: {
    title: string;
    reason: string;
    failureDetail?: string;
  }[];
  /**
   * Every call in arrival order. Absent from evidence written before kinds
   * were recorded; the titles above are classified alone then.
   */
  toolCalls?: AntigravityQualificationToolCall[];
}

export type NativeToolClass = 'read' | 'write' | 'execute' | 'mcp' | 'unknown';

export interface NativeToolObservation {
  /** At least one call of this kind was sent. */
  observed: boolean;
  /** At least one call of this kind completed and was not denied. */
  completed: boolean;
}

export interface AntigravityQualificationSummary {
  /** The launched copy, or null when the evidence predates the field. */
  executableSource: AntigravityExecutableSource | null;
  /** True only when the exact legacy titles all completed. */
  nativeTitlesMatch: boolean;
  /** Titles no rule identifies as read, write, execute or MCP. */
  unknownTitles: string[];
  additionalDirectoriesSupported: boolean;
  nativeTools: {
    read: NativeToolObservation;
    write: NativeToolObservation;
    /** `commandInputKey`: the input key that held the command, if any. */
    execute: NativeToolObservation & { commandInputKey: string | null };
  };
  /**
   * How read, write and execute calls were titled: the exact legacy names,
   * human-readable text ("File README.md"), both, or none were identified.
   */
  observedTitleFormat: {
    format: 'legacy' | 'human-readable' | 'mixed' | 'none';
    sample: string | null;
  };
  /** VIEW-03, CHAT-03 and CHAT-06, in that order. */
  statements: string[];
}

/** The native tools whose titles `antigravityToolDisplay` translates. */
const NATIVE_TITLES = ['read_file', 'write_file', 'run_command'] as const;

const LEGACY_CLASS: Record<string, NativeToolClass> = {
  read_file: 'read',
  write_file: 'write',
  run_command: 'execute',
};

/** A routed MCP tool: `mcp_<server>_<tool>`, both parts non-empty. */
const MCP_TITLE = /^mcp_[A-Za-z0-9_-]+_[A-Za-z0-9_.-]+$/;

/** The path aliases `antigravityNativeOperation` accepts. */
const PATH_KEYS = ['Path', 'TargetFile', 'AbsolutePath'];

/** `CommandLine` first: the key `antigravityNativeOperation` accepts. */
const COMMAND_KEYS = ['CommandLine', 'Command', 'command', 'Cmd', 'cmd'];

/** The input key that holds an execute call's command, if any. */
export function commandInputKey(
  inputKeys: readonly string[] = [],
): string | null {
  return COMMAND_KEYS.find((key) => inputKeys.includes(key)) ?? null;
}

/**
 * Which native tool a call is. Antigravity 1.5.1 titles its calls with
 * human-readable text ("File README.md"), so the ACP `kind` and the raw input
 * keys identify the tool; the exact legacy titles still map.
 */
export function classifyNativeToolCall(call: {
  title: string;
  kind?: string | null;
  inputKeys?: readonly string[];
}): NativeToolClass {
  const legacy = LEGACY_CLASS[call.title];
  if (legacy) return legacy;
  if (MCP_TITLE.test(call.title)) return 'mcp';
  const keys = call.inputKeys ?? [];
  const hasPath = PATH_KEYS.some((key) => keys.includes(key));
  if (call.kind === 'read' && hasPath) return 'read';
  if (call.kind === 'edit' && hasPath) return 'write';
  if (call.kind === 'execute' && commandInputKey(keys)) return 'execute';
  return 'unknown';
}

const FAILURE_DETAIL_LIMIT = 2048;

/** Never throws: a circular or BigInt value becomes a bounded placeholder. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return String(JSON.stringify(value));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[unserializable: ${message.replace(/\s+/g, ' ').slice(0, 200)}]`;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The probe's evidence with its per-machine scratch directory replaced by
 * `<scratch>` in every string (so its additional directory reads
 * `<scratch>/additional`), under either macOS spelling of the tmpdir path.
 * A sibling whose name merely starts with the scratch name is left alone.
 */
export function redactQualificationPaths<T>(value: T, scratch: string): T {
  const bare = scratch.replace(/^\/private(?=\/)/, '');
  const spellings = [...new Set([`/private${bare}`, bare])];
  const pattern = new RegExp(
    `(?:${spellings.map(escapeRegExp).join('|')})(?![A-Za-z0-9._-])`,
    'g',
  );
  const redact = (item: unknown): unknown => {
    if (typeof item === 'string') return item.replace(pattern, '<scratch>');
    if (Array.isArray(item)) return item.map(redact);
    if (isRecord(item))
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [key, redact(entry)]),
      );
    return item;
  };
  return redact(value) as T;
}

/**
 * Why a tool call failed, from its `tool_call_update`: the text of its
 * content blocks, its `rawOutput` and any `error` field, bounded to 2 KB.
 */
export function toolCallFailureDetail(
  update: Record<string, unknown>,
): string | undefined {
  const parts: string[] = [];
  if (Array.isArray(update.content))
    for (const block of update.content) {
      const inner = isRecord(block) ? block.content : undefined;
      if (isRecord(inner) && typeof inner.text === 'string')
        parts.push(inner.text);
    }
  if (update.rawOutput !== undefined && update.rawOutput !== null)
    parts.push(`rawOutput: ${textOf(update.rawOutput)}`);
  if (update.error !== undefined && update.error !== null)
    parts.push(`error: ${textOf(update.error)}`);
  const detail = parts.join('\n');
  if (detail === '') return undefined;
  return detail.length <= FAILURE_DETAIL_LIMIT
    ? detail
    : `${detail.slice(0, FAILURE_DETAIL_LIMIT - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The calls to classify: recorded ones, or the titles of older evidence. */
function recordedCalls(
  evidence: AntigravityQualificationEvidence,
): AntigravityQualificationToolCall[] {
  if (evidence.toolCalls) return evidence.toolCalls;
  return [
    ...evidence.toolCallTitles.map((title) => ({
      title,
      status: 'completed',
    })),
    ...evidence.deniedOrFailedToolCalls.map((call) => ({
      title: call.title,
      status: call.reason.startsWith('denied') ? null : 'failed',
      decision: call.reason.startsWith('denied')
        ? { decision: 'deny' as const }
        : undefined,
    })),
  ];
}

const STATEMENT_DETAIL_LIMIT = 200;

function notCountedReason(call: {
  reason: string;
  failureDetail?: string;
}): string {
  if (!call.failureDetail) return call.reason;
  const detail = call.failureDetail.replace(/\s+/g, ' ').trim();
  return `${call.reason}: ${
    detail.length <= STATEMENT_DETAIL_LIMIT
      ? detail
      : `${detail.slice(0, STATEMENT_DETAIL_LIMIT - 1)}…`
  }`;
}

const EXECUTABLE_SOURCE_PHRASE: Record<AntigravityExecutableSource, string> = {
  managed: 'managed copy',
  override: 'ANTIGRAVITY_EXECUTABLE copy',
  path: 'PATH copy',
};

const TITLE_FORMAT_PHRASE = {
  legacy: 'titles are the legacy read_file/write_file/run_command names',
  'human-readable':
    'titles are human-readable, kind+input keys identify the tool',
  mixed:
    'titles mix the legacy names with human-readable ones identified by kind+input keys',
  none: 'no call was identified as read, write or execute',
} as const;

export function summarizeQualificationEvidence(
  evidence: AntigravityQualificationEvidence,
): AntigravityQualificationSummary {
  const completed = evidence.toolCallTitles;
  const notCounted = evidence.deniedOrFailedToolCalls;
  const calls = recordedCalls(evidence);
  const missing = NATIVE_TITLES.filter((title) => !completed.includes(title));
  const nativeTitlesMatch = missing.length === 0;

  const classified = calls.map((call) => ({
    call,
    kind: classifyNativeToolCall(call),
    counted: call.status === 'completed' && call.decision?.decision !== 'deny',
  }));
  const unknownTitles = [
    ...new Set(
      classified
        .filter((entry) => entry.kind === 'unknown')
        .map((entry) => entry.call.title),
    ),
  ];
  const observe = (kind: NativeToolClass): NativeToolObservation => ({
    observed: classified.some((entry) => entry.kind === kind),
    completed: classified.some((entry) => entry.kind === kind && entry.counted),
  });
  const completedCount = (kind: NativeToolClass): number =>
    classified.filter((entry) => entry.kind === kind && entry.counted).length;
  const executeCall = classified.find((entry) => entry.kind === 'execute');
  const nativeTools = {
    read: observe('read'),
    write: observe('write'),
    execute: {
      ...observe('execute'),
      commandInputKey: executeCall
        ? commandInputKey(executeCall.call.inputKeys)
        : null,
    },
  };

  const nativeCalls = classified.filter((entry) =>
    ['read', 'write', 'execute'].includes(entry.kind),
  );
  const legacyCount = nativeCalls.filter(
    (entry) => entry.call.title in LEGACY_CLASS,
  ).length;
  const observedTitleFormat: AntigravityQualificationSummary['observedTitleFormat'] =
    {
      format:
        nativeCalls.length === 0
          ? 'none'
          : legacyCount === nativeCalls.length
            ? 'legacy'
            : legacyCount === 0
              ? 'human-readable'
              : 'mixed',
      sample: nativeCalls[0]?.call.title ?? null,
    };

  const { advertised, accepted } = evidence.additionalDirectories;
  const additionalDirectoriesSupported = advertised && accepted === true;

  const executableSource = evidence.executableSource ?? null;
  const runtime = `Antigravity ${evidence.runtimeVersion}${
    executableSource ? ` (${EXECUTABLE_SOURCE_PHRASE[executableSource]})` : ''
  }`;
  const source = `(live evidence ${evidence.capturedAt})`;
  const count = calls.length;
  const callsText = `${count} tool call${count === 1 ? '' : 's'}`;
  const uncounted =
    notCounted.length === 0
      ? ''
      : `; denied or failed, not counted: ${notCounted
          .map((call) => `${call.title} (${notCountedReason(call)})`)
          .join(', ')}`;
  const statements = [
    `VIEW-03: ${runtime} read calls completed: ${completedCount('read')}; write: ${completedCount('write')}; execute: ${completedCount('execute')}; ${TITLE_FORMAT_PHRASE[observedTitleFormat.format]}${uncounted} ${source}.`,
    count === 0
      ? `CHAT-03: ${runtime} sent no tool calls ${source}.`
      : unknownTitles.length === 0
        ? `CHAT-03: ${runtime} sent ${callsText}, every one identified as read, write, execute or mcp_<server>_<tool>${uncounted} ${source}.`
        : `CHAT-03: ${runtime} sent ${callsText} with unrecognized titles: ${unknownTitles.join(', ')}${uncounted} ${source}.`,
    !advertised
      ? `CHAT-06: ${runtime} did not advertise additionalDirectories, so the field is omitted ${source}.`
      : additionalDirectoriesSupported
        ? `CHAT-06: ${runtime} advertised additionalDirectories and accepted a session with one ${source}.`
        : `CHAT-06: ${runtime} advertised additionalDirectories but refused a session with one ${source}.`,
  ];
  return {
    executableSource,
    nativeTitlesMatch,
    unknownTitles,
    additionalDirectoriesSupported,
    nativeTools,
    observedTitleFormat,
    statements,
  };
}

/**
 * The probe's exit code for the turn's ACP stop reason. Only `end_turn` is
 * complete evidence: a cancelled turn (including the probe's own deadline), a
 * refusal or a token limit may end before the read, write or `pwd`, and its
 * titles would understate the runtime.
 */
export function qualificationProbeExitCode(
  stopReason: string | undefined,
): 0 | 1 {
  return stopReason === 'end_turn' ? 0 : 1;
}

/**
 * The roots the probe's permission policy allows: its scratch workspace and
 * every additional directory it passed to `session/new`, each also without
 * macOS's `/private` prefix, since tmpdir paths may be reported either way.
 */
export function qualificationWorkspaceRoots(
  workspace: string,
  additionalDirectories: readonly string[] = [],
): string[] {
  return [workspace, ...additionalDirectories].flatMap((root) => {
    const bare = root.replace(/^\/private(?=\/)/, '');
    return bare === root ? [root] : [root, bare];
  });
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/**
 * The probe's permission policy: reads and writes inside its temporary
 * workspace or additional directory and the literal `pwd`, nothing else. The shared ACP client answers
 * an allow with the runtime's `allow_once` option only (never a persistent
 * `allow_always`), so an allow without that option is recorded as a denial
 * naming the kinds the runtime offered.
 */
export function qualificationPermissionDecision(input: {
  /** From `antigravityNativeOperation`; undefined when unrecognized. */
  operation: { tool: string; input: Record<string, unknown> } | undefined;
  optionKinds: readonly string[];
  workspaceRoots: readonly string[];
}): { decision: 'allow' | 'deny'; reason?: string } {
  const { operation } = input;
  if (!operation)
    return {
      decision: 'deny',
      reason: 'not a recognized read_file, write_file or run_command request',
    };
  if (operation.tool === 'Bash') {
    const command = operation.input.command;
    if (typeof command !== 'string' || command.trim() !== 'pwd')
      return { decision: 'deny', reason: 'command is not pwd' };
  } else {
    const path = operation.input.file_path;
    if (
      typeof path !== 'string' ||
      !input.workspaceRoots.some((root) =>
        inside(root, isAbsolute(path) ? resolve(path) : resolve(root, path)),
      )
    )
      return {
        decision: 'deny',
        reason: 'path is outside the temporary workspace',
      };
  }
  if (!input.optionKinds.includes('allow_once'))
    return {
      decision: 'deny',
      reason: `the runtime offered no allow_once option (offered: ${
        input.optionKinds.join(', ') || 'none'
      })`,
    };
  return { decision: 'allow' };
}
