import { createHash, randomUUID } from 'node:crypto';
import {
  WORKER_TERMINAL_RECORD_HISTORY_MAX_BYTES,
  WORKER_TERMINAL_RECORD_TEXT_MAX_CHARS,
  WorkerTerminalRecordEntrySchema,
  WorkerTerminalRecordOpenResultSchema,
} from '@canopy/protocol/canopy-core';
import {
  DEFAULT_TERMINAL_DRAWER_COLLAPSED,
  TERMINAL_CUSTOM_NAME_MAX_LENGTH,
  TERMINAL_PERSISTED_SCROLLBACK_MAX_LINES,
  type PersistedTerminalEntry,
  type PersistedWorktreeTerminalStateFile,
  type TerminalGroup,
  type TerminalSession,
  type WorktreeTerminalLayoutState,
} from '@canopy/protocol/terminal';

/**
 * The worktree terminal record's codec (CAN-6983, moved for CAN-7051): the
 * worker plane's v2 record and main's v1 presentation, composed by lineage.
 * Portable: both main and the daemon's record authority use it.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Type aliases, not interfaces: the record's wire projections are JSON.
export type TerminalMember = {
  key: string;
  terminalId: string;
};
export type TerminalBinding = {
  key: string;
  groupId: string;
  members: TerminalMember[];
};
export interface TerminalWorkerFile {
  version: 2;
  lineage: string;
  bindings: TerminalBinding[];
  terminals: PersistedTerminalEntry[];
  terminalCustomNames: Record<string, string>;
}
export interface TerminalPresentationGroup {
  bindingKey: string;
  paneOrder: string[];
  focusedTerminalId: string;
  splitSizes: number[];
}
export interface TerminalPresentationFile {
  version: 1;
  lineage: string;
  drawerCollapsed: boolean;
  groups: TerminalPresentationGroup[];
  activeGroupId: string | null;
  groupOrdinals: Record<string, number>;
  nextGroupOrdinal: number;
  groupCustomNames: Record<string, string>;
}
export interface TerminalRecords {
  worker: TerminalWorkerFile;
  presentation: TerminalPresentationFile;
}

function uniqueKeys(values: { key: string }[]): boolean {
  return new Set(values.map((value) => value.key)).size === values.length;
}
function isMember(value: unknown): value is TerminalMember {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.terminalId === 'string'
  );
}
function isBinding(value: unknown): value is TerminalBinding {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.groupId === 'string' &&
    Array.isArray(value.members) &&
    value.members.every(isMember) &&
    uniqueKeys(value.members)
  );
}
export function isWorkerFile(value: unknown): value is TerminalWorkerFile {
  return (
    isRecord(value) &&
    value.version === 2 &&
    typeof value.lineage === 'string' &&
    Array.isArray(value.bindings) &&
    value.bindings.every(isBinding) &&
    uniqueKeys(value.bindings) &&
    Array.isArray(value.terminals) &&
    value.terminals.every(isPersistedTerminalEntry) &&
    isRecord(value.terminalCustomNames)
  );
}
function isPresentationGroup(
  value: unknown,
): value is TerminalPresentationGroup {
  return (
    isRecord(value) &&
    typeof value.bindingKey === 'string' &&
    isStringArray(value.paneOrder) &&
    typeof value.focusedTerminalId === 'string' &&
    Array.isArray(value.splitSizes) &&
    value.splitSizes.every(isFiniteNumber)
  );
}
export function isPresentationFile(
  value: unknown,
): value is TerminalPresentationFile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.lineage === 'string' &&
    typeof value.drawerCollapsed === 'boolean' &&
    Array.isArray(value.groups) &&
    value.groups.every(isPresentationGroup) &&
    (value.activeGroupId === null || typeof value.activeGroupId === 'string') &&
    isRecord(value.groupOrdinals) &&
    isFiniteNumber(value.nextGroupOrdinal) &&
    isRecord(value.groupCustomNames)
  );
}

/** First references win; the worker's stable arrays supply omitted occurrences. */
function orderedByKeys<T extends { key: string }>(
  values: T[],
  keys: string[],
): T[] {
  const remaining = new Map(values.map((value) => [value.key, value]));
  const ordered: T[] = [];
  for (const key of keys) {
    const value = remaining.get(key);
    if (value) {
      ordered.push(value);
      remaining.delete(key);
    }
  }
  return [...ordered, ...remaining.values()];
}

export function composeRecords(
  worker: TerminalWorkerFile,
  presentation: TerminalPresentationFile | undefined,
  projectId: string,
  worktreeId: string,
): PersistedWorktreeTerminalStateFile {
  const p = presentation?.lineage === worker.lineage ? presentation : undefined;
  const terminals = worker.terminals
    .map((entry) => normalizeTerminalEntry(entry, projectId, worktreeId))
    .filter((entry): entry is PersistedTerminalEntry => entry !== null);
  const ids = new Set(terminals.map((entry) => entry.session.id));
  const bindings = orderedByKeys(
    worker.bindings,
    p?.groups.map((group) => group.bindingKey) ?? [],
  );
  const groups: TerminalGroup[] = [];
  for (const binding of bindings) {
    const layout = p?.groups.find((group) => group.bindingKey === binding.key);
    const members = orderedByKeys(
      binding.members.filter((member) => ids.has(member.terminalId)),
      layout?.paneOrder ?? [],
    );
    if (!members.length) continue;
    const complete =
      layout &&
      layout.paneOrder.length === members.length &&
      new Set(layout.paneOrder).size === members.length &&
      layout.paneOrder.every((key) =>
        members.some((member) => member.key === key),
      );
    const terminalIds = members.map((member) => member.terminalId);
    groups.push({
      id: binding.groupId,
      terminalIds,
      focusedTerminalId:
        layout && terminalIds.includes(layout.focusedTerminalId)
          ? layout.focusedTerminalId
          : terminalIds[0],
      splitSizes: complete ? layout.splitSizes : [],
    });
  }
  return normalizePersistedState(
    {
      version: 1,
      ...defaultLayoutState(),
      ...p,
      groups,
      terminals,
      terminalCustomNames: worker.terminalCustomNames,
      ...(!p
        ? {
            groupOrdinals: Object.fromEntries(
              groups.map((group, index) => [group.id, index + 1]),
            ),
            nextGroupOrdinal: groups.length + 1,
          }
        : {}),
    },
    projectId,
    worktreeId,
  );
}

/** Legacy DTOs have no keys: match nth public-ID occurrences in the composed order. */
export function recordsForState(
  state: PersistedWorktreeTerminalStateFile,
  lineage: string,
  previous?: TerminalRecords,
  legacy = false,
): TerminalRecords {
  const oldBindings = previous
    ? orderedByKeys(
        previous.worker.bindings,
        previous.presentation.groups.map((group) => group.bindingKey),
      )
    : [];
  const availableBindings = [...oldBindings];
  const requestedBindings: TerminalBinding[] = [];
  const groups: TerminalPresentationGroup[] = [];
  for (const [groupIndex, group] of state.groups.entries()) {
    const index = availableBindings.findIndex(
      (binding) => binding.groupId === group.id,
    );
    const old = index < 0 ? undefined : availableBindings.splice(index, 1)[0];
    const key =
      old?.key ?? (legacy ? `legacy-group/${groupIndex}` : randomUUID());
    const oldLayout = previous?.presentation.groups.find(
      (layout) => layout.bindingKey === key,
    );
    const availableMembers = old
      ? orderedByKeys(old.members, oldLayout?.paneOrder ?? [])
      : [];
    const requestedMembers = group.terminalIds.map(
      (terminalId, paneIndex): TerminalMember => {
        const memberIndex = availableMembers.findIndex(
          (member) => member.terminalId === terminalId,
        );
        return memberIndex < 0
          ? {
              key: legacy ? `legacy-pane/${paneIndex}` : randomUUID(),
              terminalId,
            }
          : availableMembers.splice(memberIndex, 1)[0];
      },
    );
    const members = orderedByKeys(
      requestedMembers,
      old?.members.map((member) => member.key) ?? [],
    );
    requestedBindings.push({ key, groupId: group.id, members });
    groups.push({
      bindingKey: key,
      paneOrder: requestedMembers.map((member) => member.key),
      focusedTerminalId: group.focusedTerminalId,
      splitSizes: group.splitSizes,
    });
  }
  return {
    worker: {
      version: 2,
      lineage,
      bindings: orderedByKeys(
        requestedBindings,
        previous?.worker.bindings.map((binding) => binding.key) ?? [],
      ),
      terminals: state.terminals,
      terminalCustomNames: state.terminalCustomNames,
    },
    presentation: {
      version: 1,
      lineage,
      drawerCollapsed: state.drawerCollapsed,
      groups,
      activeGroupId: state.activeGroupId,
      groupOrdinals: state.groupOrdinals,
      nextGroupOrdinal: state.nextGroupOrdinal,
      groupCustomNames: state.groupCustomNames,
    },
  };
}
/** Absent lists read as empty; present ones must hold only valid entries. */
export function hasVersion1Shape(value: Record<string, unknown>): boolean {
  const { terminals, groups } = value;
  return (
    (terminals === undefined ||
      (Array.isArray(terminals) &&
        terminals.every(isPersistedTerminalEntry))) &&
    (groups === undefined ||
      (Array.isArray(groups) && groups.every(isTerminalGroup)))
  );
}

function defaultLayoutState(): WorktreeTerminalLayoutState {
  return {
    drawerCollapsed: DEFAULT_TERMINAL_DRAWER_COLLAPSED,
    groups: [],
    activeGroupId: null,
    nextGroupOrdinal: 1,
    groupOrdinals: {},
    terminalCustomNames: {},
    groupCustomNames: {},
  };
}

export function createEmptyState(): PersistedWorktreeTerminalStateFile {
  return {
    version: 1,
    ...defaultLayoutState(),
    terminals: [],
  };
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isTerminalGroup(value: unknown): value is TerminalGroup {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isStringArray(value.terminalIds) &&
    typeof value.focusedTerminalId === 'string' &&
    Array.isArray(value.splitSizes) &&
    value.splitSizes.every((entry) => isFiniteNumber(entry))
  );
}

function isTerminalSession(value: unknown): value is TerminalSession {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.shell === 'string' &&
    typeof value.shellBasename === 'string' &&
    typeof value.cwd === 'string' &&
    isFiniteNumber(value.createdAt)
  );
}

export function isPersistedTerminalEntry(
  value: unknown,
): value is PersistedTerminalEntry {
  return (
    isRecord(value) &&
    isTerminalSession(value.session) &&
    isStringArray(value.scrollbackLines) &&
    (value.exitCode === null || isFiniteNumber(value.exitCode)) &&
    (value.signal === null || typeof value.signal === 'string')
  );
}

function sanitizeCustomName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().slice(0, TERMINAL_CUSTOM_NAME_MAX_LENGTH);
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeCustomNameMap(
  value: unknown,
  allowedIds: Set<string>,
): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (!allowedIds.has(key)) {
      continue;
    }
    const sanitized = sanitizeCustomName(rawValue);
    if (sanitized !== null) {
      Object.defineProperty(normalized, key, {
        value: sanitized,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return normalized;
}

export function normalizeSplitSizes(
  count: number,
  existing?: number[],
): number[] {
  if (count <= 0) {
    return [];
  }

  if (existing && existing.length === count) {
    const total = existing.reduce((sum, value) => sum + value, 0);
    if (total > 0) {
      return existing.map((value) => value / total);
    }
  }

  const even = 1 / count;
  const sizes: number[] = [];
  for (let index = 0; index < count; index += 1) {
    sizes.push(even);
  }
  return sizes;
}

function normalizeScrollbackLines(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const lines = value.filter(
    (entry): entry is string => typeof entry === 'string',
  );
  // Import preserves the legacy reader's line-only normalization. Byte caps
  // apply to new output, never retroactively to persisted scrollback.
  return lines.slice(-TERMINAL_PERSISTED_SCROLLBACK_MAX_LINES);
}

function normalizeTerminalEntry(
  value: unknown,
  projectId: string,
  worktreeId: string,
): PersistedTerminalEntry | null {
  if (!isPersistedTerminalEntry(value)) {
    return null;
  }

  if (
    value.session.projectId !== projectId ||
    value.session.worktreeId !== worktreeId
  ) {
    return null;
  }

  return {
    session: value.session,
    scrollbackLines: normalizeScrollbackLines(value.scrollbackLines),
    exitCode: value.exitCode,
    signal: value.signal,
  };
}

export function normalizePersistedState(
  value: unknown,
  projectId: string,
  worktreeId: string,
): PersistedWorktreeTerminalStateFile {
  if (!isRecord(value) || value.version !== 1) {
    return createEmptyState();
  }

  const terminals = Array.isArray(value.terminals)
    ? value.terminals
        .map((entry) => normalizeTerminalEntry(entry, projectId, worktreeId))
        .filter((entry): entry is PersistedTerminalEntry => entry !== null)
    : [];
  const terminalIdSet = new Set(terminals.map((entry) => entry.session.id));

  const groupsSource = Array.isArray(value.groups) ? value.groups : [];
  const groups: TerminalGroup[] = [];
  for (const rawGroup of groupsSource) {
    if (!isTerminalGroup(rawGroup)) {
      continue;
    }

    const terminalIds = rawGroup.terminalIds.filter((id) =>
      terminalIdSet.has(id),
    );
    if (terminalIds.length === 0) {
      continue;
    }

    const focusedTerminalId = terminalIds.includes(rawGroup.focusedTerminalId)
      ? rawGroup.focusedTerminalId
      : terminalIds[0];
    groups.push({
      id: rawGroup.id,
      terminalIds,
      focusedTerminalId,
      splitSizes: normalizeSplitSizes(terminalIds.length, rawGroup.splitSizes),
    });
  }

  const groupIdSet = new Set(groups.map((group) => group.id));
  const groupOrdinalsSource = isRecord(value.groupOrdinals)
    ? value.groupOrdinals
    : {};
  const groupOrdinals: Record<string, number> = {};
  for (const group of groups) {
    const rawOrdinal = groupOrdinalsSource[group.id];
    if (isFiniteNumber(rawOrdinal) && rawOrdinal >= 1) {
      Object.defineProperty(groupOrdinals, group.id, {
        value: Math.round(rawOrdinal),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }

  let nextGroupOrdinal =
    isFiniteNumber(value.nextGroupOrdinal) && value.nextGroupOrdinal >= 1
      ? Math.round(value.nextGroupOrdinal)
      : 1;
  for (const ordinal of Object.values(groupOrdinals)) {
    if (ordinal >= nextGroupOrdinal) {
      nextGroupOrdinal = ordinal + 1;
    }
  }

  const activeGroupId =
    typeof value.activeGroupId === 'string' &&
    groupIdSet.has(value.activeGroupId)
      ? value.activeGroupId
      : (groups[0]?.id ?? null);

  return {
    version: 1,
    drawerCollapsed:
      typeof value.drawerCollapsed === 'boolean'
        ? value.drawerCollapsed
        : DEFAULT_TERMINAL_DRAWER_COLLAPSED,
    groups,
    activeGroupId,
    nextGroupOrdinal,
    groupOrdinals,
    terminalCustomNames: normalizeCustomNameMap(
      value.terminalCustomNames,
      terminalIdSet,
    ),
    groupCustomNames: normalizeCustomNameMap(
      value.groupCustomNames,
      groupIdSet,
    ),
    terminals,
  };
}

interface MeasuredScrollbackLine {
  readonly text: string;
  readonly bytes: number;
}

/** A UTF-8 suffix, never starting inside a code point. */
function utf8Tail(
  text: string,
  maxBytes: number,
  byteLength = Buffer.byteLength(text),
): MeasuredScrollbackLine {
  if (byteLength <= maxBytes) return { text, bytes: byteLength };
  const bytes = Buffer.from(text);
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return {
    text: bytes.subarray(start).toString('utf8'),
    bytes: bytes.length - start,
  };
}

// Weak keys release accounting with their history. The immutable line entries
// also detect caller edits to the mutable array while the next append copies it.
const scrollbackBytes = new WeakMap<
  readonly string[],
  { lines: MeasuredScrollbackLine[]; total: number }
>();

/**
 * One retention rule for host reports, producer compaction and replay:
 * newest 5,000 lines, 1 MiB per line and 4 MiB total (including newlines).
 * The byte ceiling also keeps replacement lines within the wire char limit.
 * `onHeadMoved` runs when the retained lines no longer start where `lines`
 * did (the first line was evicted or clipped): only then can the result not
 * continue an earlier unfinished line. A clipped later line keeps the join.
 */
export function retainScrollbackLines(
  lines: readonly string[],
  onHeadMoved?: () => void,
): string[] {
  const retained: string[] = [];
  const lineBytes: MeasuredScrollbackLine[] = [];
  let total = 0;
  let remaining = WORKER_TERMINAL_RECORD_HISTORY_MAX_BYTES;
  const floor = Math.max(
    0,
    lines.length - TERMINAL_PERSISTED_SCROLLBACK_MAX_LINES,
  );
  for (let index = lines.length - 1; index >= floor; index -= 1) {
    if (retained.length > 0) remaining -= 1;
    if (remaining < 0) break;
    const line = utf8Tail(
      lines[index],
      Math.min(remaining, WORKER_TERMINAL_RECORD_TEXT_MAX_CHARS),
    );
    total += line.bytes + (retained.length > 0 ? 1 : 0);
    retained.push(line.text);
    lineBytes.push(line);
    remaining -= line.bytes;
    if (remaining === 0) break;
  }
  retained.reverse();
  if (retained.length !== lines.length || retained[0] !== lines[0])
    onHeadMoved?.();
  scrollbackBytes.set(retained, { lines: lineBytes.reverse(), total });
  return retained;
}

/**
 * Appends output with the shared line and UTF-8 byte retention limits;
 * `onHeadMoved` as for {@link retainScrollbackLines}.
 */
export function appendScrollbackLines(
  existing: string[],
  chunk: string,
  onHeadMoved?: () => void,
): string[] {
  const cached = scrollbackBytes.get(existing);
  let cacheMatches = cached?.lines.length === existing.length;
  const nextLines = existing.map((line, index) => {
    if (cached?.lines[index]?.text !== line) cacheMatches = false;
    return line;
  });
  if (nextLines.length === 0) nextLines.push('');
  const parts = chunk.split('\n');
  nextLines[nextLines.length - 1] =
    `${nextLines[nextLines.length - 1] ?? ''}${parts[0] ?? ''}`;
  for (let index = 1; index < parts.length; index += 1) {
    nextLines.push(parts[index] ?? '');
  }

  if (!cached || !cacheMatches)
    return retainScrollbackLines(nextLines, onHeadMoved);
  const head = nextLines[0];

  const lineBytes = [...cached.lines];
  let total = cached.total;
  const last = Math.max(0, existing.length - 1);
  const previous = existing[last] ?? '';
  const fragment = parts[0] ?? '';
  const low = fragment.charCodeAt(0);
  // Two separately encoded surrogate halves become one UTF-8 code point.
  // Inspect the old suffix only for a low surrogate, avoiding rope flattening
  // on ordinary small appends to a large unfinished line.
  const high =
    low >= 0xdc00 && low <= 0xdfff
      ? previous.charCodeAt(previous.length - 1)
      : 0;
  const joinedPair =
    high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
  const previousBytes = lineBytes[last]?.bytes ?? 0;
  const changed = utf8Tail(
    nextLines[last],
    WORKER_TERMINAL_RECORD_TEXT_MAX_CHARS,
    previousBytes + Buffer.byteLength(fragment) - (joinedPair ? 2 : 0),
  );
  nextLines[last] = changed.text;
  lineBytes[last] = changed;
  total += changed.bytes - previousBytes;
  for (let index = last + 1; index < nextLines.length; index += 1) {
    const added = utf8Tail(
      nextLines[index],
      WORKER_TERMINAL_RECORD_TEXT_MAX_CHARS,
    );
    nextLines[index] = added.text;
    lineBytes[index] = added;
    total += 1 + added.bytes;
  }

  const floor = Math.max(
    0,
    nextLines.length - TERMINAL_PERSISTED_SCROLLBACK_MAX_LINES,
  );
  let start = 0;
  while (start < floor || total > WORKER_TERMINAL_RECORD_HISTORY_MAX_BYTES) {
    total -= lineBytes[start].bytes + 1;
    start += 1;
  }
  // The boundary line may contribute a suffix. UTF-8 rounding can leave room
  // for an earlier tiny line, just as the full retention pass does.
  let remaining = WORKER_TERMINAL_RECORD_HISTORY_MAX_BYTES - total;
  if (remaining > 0) {
    for (let index = start - 1; index >= floor; index -= 1) {
      remaining -= 1;
      if (remaining < 0) break;
      const boundary = utf8Tail(
        nextLines[index],
        Math.min(remaining, WORKER_TERMINAL_RECORD_TEXT_MAX_CHARS),
        lineBytes[index].bytes,
      );
      nextLines[index] = boundary.text;
      lineBytes[index] = boundary;
      total += 1 + boundary.bytes;
      start = index;
      remaining -= boundary.bytes;
      if (remaining === 0) break;
    }
  }
  const retained = start === 0 ? nextLines : nextLines.slice(start);
  if (start > 0 || nextLines[0] !== head) onHeadMoved?.();
  scrollbackBytes.set(retained, {
    lines: start === 0 ? lineBytes : lineBytes.slice(start),
    total,
  });
  return retained;
}

/** Drawer terminals: shells and scripts. Their sessions and output persist. */
export function isDrawerOwnedTerminal(session: {
  readonly kind?: TerminalSession['kind'];
}): boolean {
  return (
    session.kind === undefined ||
    session.kind === 'shell' ||
    session.kind === 'script'
  );
}

/** Shutdown stamps are never overwritten by the exit that follows them. */
export function isShutdownExitSignal(signal: string | null): boolean {
  return signal === 'app-quit' || signal === 'fatal-exit';
}

/** The forward fence main installs at its legacy path once imported (CAN-7051). */
export interface TerminalStateFence {
  version: 3;
  movedTo: 'terminal-record-authority';
  lineage: string;
  sourceSha256: string | null;
}

export function isTerminalStateFence(
  value: unknown,
): value is TerminalStateFence {
  return (
    isRecord(value) &&
    value.version === 3 &&
    value.movedTo === 'terminal-record-authority' &&
    typeof value.lineage === 'string'
  );
}

/** A v1 file's lineage: deterministic, so an interrupted import repeats it. */
export function legacyLineage(
  projectId: string,
  worktreeId: string,
  bytes: Uint8Array,
): string {
  return `legacy/${createHash('sha256')
    .update(
      JSON.stringify([
        projectId,
        worktreeId,
        Buffer.from(bytes).toString('base64'),
      ]),
    )
    .digest('hex')}`;
}

export type LegacyTerminalStateRead =
  | { kind: 'absent' }
  | {
      kind: 'v1' | 'v2';
      records: TerminalRecords;
      bytes: Buffer;
      sha256: string;
    }
  | { kind: 'fenced'; fence: TerminalStateFence }
  | { kind: 'damaged'; bytes: Buffer }
  | { kind: 'newer' };

/** Legacy readers accepted arbitrary exit scalars and lineages. Keep their
 * history readable without installing a v3 image its own reader rejects. */
function compatibleLegacyRecords(
  records: TerminalRecords,
  projectId: string,
  worktreeId: string,
  bytes: Buffer,
): TerminalRecords {
  const parsedLineage =
    WorkerTerminalRecordOpenResultSchema.shape.lineage.safeParse(
      records.worker.lineage,
    );
  const lineage = parsedLineage.success
    ? parsedLineage.data
    : legacyLineage(projectId, worktreeId, bytes);
  return {
    worker: {
      ...records.worker,
      lineage,
      terminals: records.worker.terminals.map((entry) => {
        const code = WorkerTerminalRecordEntrySchema.shape.exitCode.safeParse(
          entry.exitCode,
        );
        const signal = WorkerTerminalRecordEntrySchema.shape.signal.safeParse(
          entry.signal,
        );
        return {
          ...entry,
          exitCode: code.success ? code.data : null,
          signal: signal.success ? signal.data : null,
        };
      }),
    },
    presentation: { ...records.presentation, lineage },
  };
}

/**
 * Reads main's legacy worker state (`terminal-state.json`) without changing
 * it: v2 as written, v1 converted under its deterministic lineage exactly as
 * main converted it, and the forward fence once the record moved.
 */
export function readLegacyTerminalState(
  bytes: Buffer | null,
  projectId: string,
  worktreeId: string,
): LegacyTerminalStateRead {
  if (bytes === null) return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { kind: 'damaged', bytes };
  }
  if (!isRecord(parsed) || typeof parsed.version !== 'number')
    return { kind: 'damaged', bytes };
  if (isTerminalStateFence(parsed)) return { kind: 'fenced', fence: parsed };
  if (parsed.version > 2) return { kind: 'newer' };
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (isWorkerFile(parsed)) {
    const state = composeRecords(parsed, undefined, projectId, worktreeId);
    const terminals = parsed.terminals.filter(
      (entry) =>
        entry.session.projectId === projectId &&
        entry.session.worktreeId === worktreeId,
    );
    const ids = new Set(terminals.map((entry) => entry.session.id));
    return {
      kind: 'v2',
      records: compatibleLegacyRecords(
        {
          worker: {
            ...parsed,
            terminals,
            bindings: parsed.bindings.flatMap((binding) => {
              const members = binding.members.filter((member) =>
                ids.has(member.terminalId),
              );
              return members.length ? [{ ...binding, members }] : [];
            }),
            terminalCustomNames: Object.fromEntries(
              Object.entries(parsed.terminalCustomNames).filter(([id]) =>
                ids.has(id),
              ),
            ),
          },
          presentation: recordsForState(state, parsed.lineage).presentation,
        },
        projectId,
        worktreeId,
        bytes,
      ),
      bytes,
      sha256,
    };
  }
  if (parsed.version === 1 && hasVersion1Shape(parsed)) {
    const state = normalizePersistedState(parsed, projectId, worktreeId);
    return {
      kind: 'v1',
      records: compatibleLegacyRecords(
        recordsForState(
          state,
          legacyLineage(projectId, worktreeId, bytes),
          undefined,
          true,
        ),
        projectId,
        worktreeId,
        bytes,
      ),
      bytes,
      sha256,
    };
  }
  return { kind: 'damaged', bytes };
}
