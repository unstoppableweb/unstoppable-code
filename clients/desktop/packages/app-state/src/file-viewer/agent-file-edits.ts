import type { ChatMessageEvent } from '@canopy/app-core';
import { turnFilePath } from '@canopy/protocol/file-path';
import type {
  RemoteControlChatMessage,
  RemoteControlChatPart,
} from '@canopy/protocol/remote-control/shell';

/**
 * The project/worktree scope an agent edit belongs to. Hosts project chat
 * events with canonical ids, local ids, or both; a file session matches when
 * its request ids appear in both lists. An empty list never matches.
 */
export interface AgentFileEditScope {
  readonly projectIds: readonly string[];
  readonly worktreeIds: readonly string[];
  readonly fileRootLocalId?: string;
  readonly repoId?: string;
}

/** One successfully completed agent tool call and the paths it wrote. */
export interface AgentFileEdit {
  readonly scope: AgentFileEditScope;
  readonly paths: readonly string[];
}

/** A path from a tool input, normalized for comparison. */
export interface NormalizedEditPath {
  /** Forward-slash path with `.`/`..` segments resolved lexically. */
  readonly path: string;
  readonly absolute: boolean;
  /** Windows drive paths compare case-insensitively. */
  readonly caseInsensitive: boolean;
}

const FILE_PATH_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);
const NOTEBOOK_TOOLS = new Set(['NotebookEdit']);
const PATCH_TOOLS = new Set(['apply_patch', 'functions.apply_patch']);
const FILE_CHANGE_TOOL = 'file_change';
/** Nested agent blocks carry their own tool parts; bound the walk. */
const MAX_PART_DEPTH = 4;
const DEFAULT_MAX_TRACKED_CALLS = 512;

/** Whether a tool name is one this module can resolve paths for. */
export function isAgentFileEditTool(toolName: string): boolean {
  return (
    FILE_PATH_TOOLS.has(toolName) ||
    NOTEBOOK_TOOLS.has(toolName) ||
    PATCH_TOOLS.has(toolName) ||
    toolName === FILE_CHANGE_TOOL
  );
}

/**
 * Normalize a tool-input path lexically: backslashes become `/`, repeated
 * separators collapse, and `.`/`..` segments resolve. Returns `null` for an
 * empty path or a relative path that climbs above its start, which cannot be
 * matched safely.
 */
export function normalizeEditPath(raw: string): NormalizedEditPath | null {
  const slashed = turnFilePath(raw);
  if (!slashed || slashed.split('/').includes('..')) return null;
  const drive = /^[A-Za-z]:\//.exec(slashed)?.[0] ?? null;
  const absolute = drive !== null || slashed.startsWith('/');
  return {
    path: drive ? drive.toUpperCase() + slashed.slice(drive.length) : slashed,
    absolute,
    caseInsensitive: drive !== null || slashed.startsWith('//'),
  };
}

/**
 * Whether `target` names the file at `relativePath`: the paths are equal, or
 * `target` ends with it at a segment boundary. Callers resolve ambiguity when
 * several sessions match.
 */
export function editPathMatchesRelativePath(
  target: NormalizedEditPath,
  relativePath: string,
): boolean {
  const relative = normalizeEditPath(relativePath);
  if (!relative || relative.absolute) return false;
  const left = target.caseInsensitive ? target.path.toLowerCase() : target.path;
  const right = target.caseInsensitive
    ? relative.path.toLowerCase()
    : relative.path;
  return left === right || (target.absolute && left.endsWith(`/${right}`));
}

// --- Tool input parsing ------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(
  input: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(input);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/** Index just past a JSON string literal starting at `start`, or -1. */
function skipJsonString(input: string, start: number): number {
  let index = start + 1;
  while (index < input.length) {
    const char = input[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '"') return index + 1;
    index += 1;
  }
  return -1;
}

function skipWhitespace(input: string, start: number): number {
  let index = start;
  while (index < input.length && /\s/.test(input[index] ?? '')) index += 1;
  return index;
}

/** Index just past one JSON value starting at `start`, or -1 when truncated. */
function skipJsonValue(input: string, start: number): number {
  const first = input[start];
  if (first === '"') return skipJsonString(input, start);
  if (first === '{' || first === '[') {
    let depth = 0;
    let index = start;
    while (index < input.length) {
      const char = input[index];
      if (char === '"') {
        index = skipJsonString(input, index);
        if (index < 0) return -1;
        continue;
      }
      if (char === '{' || char === '[') depth += 1;
      if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
    return -1;
  }
  let index = start;
  while (index < input.length && !/[,}\]\s]/.test(input[index] ?? '')) {
    index += 1;
  }
  return index < input.length ? index : -1;
}

function decodeJsonString(literal: string): string | null {
  const parsed = parseJson(literal);
  return parsed.ok && typeof parsed.value === 'string' ? parsed.value : null;
}

/**
 * Read one top-level string field from a JSON object that may be truncated.
 * Only a complete, correctly decoded string at depth one counts, so a
 * `file_path` inside document content can never be mistaken for the target.
 */
function readTopLevelStringField(input: string, field: string): string | null {
  let found: string | null = null;
  let seen = false;
  let index = skipWhitespace(input, 0);
  if (input[index] !== '{') return null;
  index += 1;
  for (;;) {
    index = skipWhitespace(input, index);
    if (input[index] === '}' || index === input.length) return found;
    if (input[index] !== '"') return null;
    const keyEnd = skipJsonString(input, index);
    if (keyEnd < 0) return null;
    const key = decodeJsonString(input.slice(index, keyEnd));
    if (key === null) return null;
    if (key === field) {
      if (seen) return null;
      seen = true;
    }
    index = skipWhitespace(input, keyEnd);
    if (input[index] !== ':') return null;
    index = skipWhitespace(input, index + 1);
    const valueEnd = skipJsonValue(input, index);
    if (valueEnd < 0) return key === field ? null : found;
    if (!parseJson(input.slice(index, valueEnd)).ok) return null;
    if (key === field) {
      found =
        input[index] === '"'
          ? decodeJsonString(input.slice(index, valueEnd))
          : null;
    }
    index = skipWhitespace(input, valueEnd);
    if (input[index] === '}') {
      return skipWhitespace(input, index + 1) === input.length ? found : null;
    }
    if (input[index] !== ',') return null;
    index += 1;
  }
}

const PATCH_PATH_LINE =
  /^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/;
const FILE_CHANGE_LINE = /^(?:add|update|delete): (.+)$/;

function patchText(input: string): { text: string; complete: boolean } | null {
  const parsed = parseJson(input);
  if (parsed.ok) {
    if (typeof parsed.value === 'string') {
      return { text: parsed.value, complete: true };
    }
    if (isRecord(parsed.value)) {
      const value = parsed.value.input ?? parsed.value.patch;
      return typeof value === 'string' ? { text: value, complete: true } : null;
    }
    return null;
  }
  // A truncated JSON wrapper cannot be decoded safely.
  if (input.trimStart().startsWith('{')) return null;
  return { text: input, complete: input.includes('*** End Patch') };
}

function linePaths(text: string, pattern: RegExp, complete: boolean): string[] {
  const lines = text.split('\n');
  // A cut-off final line may hold only part of a path.
  if (!complete && !text.endsWith('\n')) lines.pop();
  const paths: string[] = [];
  for (const line of lines) {
    const match = pattern.exec(line.replace(/\r$/, ''));
    const path = match?.[1]?.trim();
    if (path) paths.push(path);
  }
  return paths;
}

/**
 * Paths a supported edit tool writes, from its projected `input` string. Old
 * and new paths of a patch move are both included so a viewer on the old
 * path is checked too. Malformed or ambiguous inputs yield no paths.
 */
export function extractAgentEditPaths(
  toolName: string,
  input: unknown,
): readonly string[] {
  if (isRecord(input)) {
    if (FILE_PATH_TOOLS.has(toolName) || NOTEBOOK_TOOLS.has(toolName)) {
      const value =
        input[NOTEBOOK_TOOLS.has(toolName) ? 'notebook_path' : 'file_path'];
      return typeof value === 'string' ? [value] : [];
    }
    input = input.input ?? input.patch;
  }
  if (typeof input !== 'string') return [];
  if (FILE_PATH_TOOLS.has(toolName)) {
    const path = readTopLevelStringField(input, 'file_path');
    return path ? [path] : [];
  }
  if (NOTEBOOK_TOOLS.has(toolName)) {
    const path = readTopLevelStringField(input, 'notebook_path');
    return path ? [path] : [];
  }
  if (PATCH_TOOLS.has(toolName)) {
    const patch = patchText(input);
    return patch ? linePaths(patch.text, PATCH_PATH_LINE, patch.complete) : [];
  }
  if (toolName === FILE_CHANGE_TOOL) {
    return linePaths(input, FILE_CHANGE_LINE, true);
  }
  return [];
}

// --- Completion tracking -----------------------------------------------------

interface TrackedCall {
  input: unknown;
  paths: readonly string[] | null;
  completeInput: boolean;
  readonly reportedPaths: Set<string>;
  succeeded: boolean;
  handled: boolean;
}

export interface AgentFileEditTrackerOptions {
  /** Upper bound on remembered tool calls; the oldest are evicted first. */
  readonly maxTrackedCalls?: number;
  /**
   * Completions in messages last updated before this epoch-ms time are
   * history, not fresh writes, and are recorded without being reported.
   */
  readonly notBeforeMs?: number;
}

export interface AgentFileEditTracker {
  /** Record one chat event; returns edits that completed successfully in it. */
  ingest(event: ChatMessageEvent): readonly AgentFileEdit[];
  clear(): void;
}

function readString(data: unknown, field: string): string | undefined {
  if (!isRecord(data)) return undefined;
  const value = data[field];
  return typeof value === 'string' ? value : undefined;
}

function eventScope(event: ChatMessageEvent): AgentFileEditScope | null {
  const projectIds = [event.projectId, event.workspaceLocalId].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  const worktreeIds = [event.worktreeId, event.worktreeLocalId].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  if (projectIds.length === 0 || worktreeIds.length === 0) return null;
  return {
    projectIds: Array.from(new Set(projectIds)),
    worktreeIds: Array.from(new Set(worktreeIds)),
  };
}

/** Tool parts of a message, including those nested in agent blocks. */
function collectToolParts(
  parts: readonly RemoteControlChatPart[] | undefined,
  depth: number,
  out: RemoteControlChatPart[],
): RemoteControlChatPart[] {
  if (!parts || depth > MAX_PART_DEPTH) return out;
  for (const part of parts) {
    if (part.kind === 'tool_use' || part.kind === 'tool_result') {
      out.push(part);
      continue;
    }
    if (part.kind === 'agent' && isRecord(part.data)) {
      const subBlocks = part.data.subBlocks;
      if (Array.isArray(subBlocks)) {
        const nested = subBlocks.filter(
          (block): block is RemoteControlChatPart =>
            isRecord(block) && typeof block.kind === 'string',
        );
        collectToolParts(nested, depth + 1, out);
      }
    }
  }
  return out;
}

function messageTimestamp(message: RemoteControlChatMessage): number {
  return Math.max(message.createdAtMs, message.updatedAtMs ?? 0);
}

/**
 * Pair `Edit`/`MultiEdit`/`Write`/`NotebookEdit`/patch tool uses with their
 * explicitly successful results across incremental `chat.message` events.
 * State is keyed by scope, chat, and tool-use id, and bounded. Each
 * affected path is reported at most once per call, even when patch input
 * continues arriving after its successful result.
 */
export function createAgentFileEditTracker(
  options: AgentFileEditTrackerOptions = {},
): AgentFileEditTracker {
  const maxTrackedCalls = options.maxTrackedCalls ?? DEFAULT_MAX_TRACKED_CALLS;
  const notBeforeMs = options.notBeforeMs ?? Number.NEGATIVE_INFINITY;
  const calls = new Map<string, TrackedCall>();

  const callFor = (key: string): TrackedCall => {
    let call = calls.get(key);
    if (!call) {
      call = {
        input: undefined,
        paths: null,
        completeInput: false,
        reportedPaths: new Set(),
        succeeded: false,
        handled: false,
      };
      calls.set(key, call);
      while (calls.size > maxTrackedCalls) {
        const oldest = calls.keys().next().value;
        if (oldest === undefined) break;
        calls.delete(oldest);
      }
    }
    return call;
  };

  return {
    ingest(event): readonly AgentFileEdit[] {
      const message = event.message;
      if (!message.parts || message.parts.length === 0) return [];
      const scope = eventScope(event);
      if (!scope) return [];
      const scopeKey = `${scope.projectIds.join('|')}\u0000${scope.worktreeIds.join('|')}\u0000${event.chatId}`;
      const failedMessage =
        message.status === 'failed' || message.status === 'cancelled';
      const historical = messageTimestamp(message) < notBeforeMs;
      const ready: TrackedCall[] = [];

      for (const part of collectToolParts(message.parts, 0, [])) {
        const toolUseId = readString(part.data, 'toolUseId');
        if (!toolUseId) continue;
        const key = `${scopeKey}\u0000${toolUseId}`;
        if (part.kind === 'tool_use') {
          const toolName = readString(part.data, 'toolName') ?? '';
          if (!isAgentFileEditTool(toolName)) continue;
          const input = isRecord(part.data) ? part.data.input : undefined;
          const call = callFor(key);
          if (call.handled) continue;
          const result = isRecord(part.data) ? part.data.result : undefined;
          if (failedMessage || (isRecord(result) && result.isError === true)) {
            call.handled = true;
            continue;
          }
          if (historical && isRecord(result)) {
            call.handled = true;
            continue;
          }
          if (isRecord(result) && result.isError === false)
            call.succeeded = true;
          if (call.input !== input) {
            call.input = input;
            call.paths = extractAgentEditPaths(toolName, input);
            const patchInput = isRecord(input)
              ? (input.input ?? input.patch)
              : input;
            const patch =
              typeof patchInput === 'string' ? patchText(patchInput) : null;
            call.completeInput =
              !PATCH_TOOLS.has(toolName) ||
              patch?.text.includes('*** End Patch') === true;
          }
          if (call.succeeded) ready.push(call);
          continue;
        }
        const isError = isRecord(part.data) ? part.data.isError : undefined;
        // Only an explicit success counts; an error status wins over data.
        if (isError === true || failedMessage) {
          callFor(key).handled = true;
          continue;
        }
        if (isError !== false) continue;
        const call = callFor(key);
        if (call.handled) continue;
        if (historical) {
          call.handled = true;
          continue;
        }
        call.succeeded = true;
        if (call.paths !== null) ready.push(call);
      }

      const edits: AgentFileEdit[] = [];
      for (const call of ready) {
        if (call.handled || !call.paths?.length) continue;
        call.handled = call.completeInput;
        const paths = call.paths.filter(
          (path) => !call.reportedPaths.has(path),
        );
        for (const path of paths) call.reportedPaths.add(path);
        if (paths.length > 0) edits.push({ scope, paths });
      }
      return edits;
    },
    clear(): void {
      calls.clear();
    },
  };
}
