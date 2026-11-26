import { createHash, randomUUID } from 'node:crypto';
import { setOwn } from './identity';
import type {
  WorkerTerminalRecordBinding,
  WorkerTerminalRecordOp,
} from '@canopy/protocol/canopy-core';
import {
  TERMINAL_CUSTOM_NAME_MAX_LENGTH,
  type PersistedTerminalEntry,
  type TerminalSession,
} from '@canopy/protocol/terminal';
import {
  appendScrollbackLines,
  isDrawerOwnedTerminal,
  isShutdownExitSignal,
  retainScrollbackLines,
  type TerminalBinding,
} from './codec';

/** The worker plane's record payload the ops change (CAN-7051). */
export interface TerminalRecordPayloadState {
  bindings: TerminalBinding[];
  terminals: PersistedTerminalEntry[];
  terminalCustomNames: Record<string, string>;
  /** Retained suffixes must not join an older record's unfinished line. */
  truncatedHistoryIds?: string[];
}

export function markHistoryTruncated(
  record: TerminalRecordPayloadState,
  terminalId: string,
): void {
  record.truncatedHistoryIds ??= [];
  if (!record.truncatedHistoryIds.includes(terminalId))
    record.truncatedHistoryIds.push(terminalId);
}

export function discontinuousOutput(lines: string[], text: string): string {
  return lines.length > 0 && lines[lines.length - 1] !== ''
    ? `\n${text}`
    : text;
}

export interface TerminalRecordOpHooks {
  /** Overlays track dropped history by default; installed records never merge. */
  readonly trackHistoryTruncation?: boolean;
  /** A terminal's output changed. */
  readonly historyChanged?: (terminalId: string) => void;
  /** A terminal left the record. */
  readonly forgotten?: (terminalId: string) => void;
  /**
   * A live terminal the record may re-add when a layout references it after
   * a forget, as main re-added a referenced live session.
   */
  readonly liveSession?: (terminalId: string) => TerminalSession | null;
}

export function recordEntry(
  record: TerminalRecordPayloadState,
  terminalId: string,
): PersistedTerminalEntry | undefined {
  return record.terminals.find((entry) => entry.session.id === terminalId);
}

function sanitizeName(name: string): string | null {
  const trimmed = name.trim().slice(0, TERMINAL_CUSTOM_NAME_MAX_LENGTH);
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Registers a live session as main did: its last exit no longer applies,
 * and it joins a group of its own until a layout places it.
 */
export function upsertRecordSession(
  record: TerminalRecordPayloadState,
  session: TerminalSession,
): PersistedTerminalEntry {
  let entry = recordEntry(record, session.id);
  if (entry) entry.session = structuredClone(session);
  else {
    entry = {
      session: structuredClone(session),
      scrollbackLines: [],
      exitCode: null,
      signal: null,
    };
    record.terminals.push(entry);
  }
  entry.exitCode = null;
  entry.signal = null;
  if (
    !record.bindings.some((binding) =>
      binding.members.some((member) => member.terminalId === session.id),
    )
  )
    record.bindings.push(liveBinding(record, session.id));
  return entry;
}

/**
 * A live terminal's own group. Its keys derive from the terminal id, so the
 * authority, main's overlay and a load's synthetic group agree on them; a
 * key already taken falls back to random ones.
 */
export function liveBinding(
  record: Pick<TerminalRecordPayloadState, 'bindings'>,
  terminalId: string,
): TerminalBinding {
  // Hash only oversized IDs so every generated key fits layout.save's limit.
  const id =
    terminalId.length + 'live-pane/'.length <= 512
      ? terminalId
      : `sha256/${createHash('sha256').update(terminalId).digest('hex')}`;
  const key = `live/${id}`;
  if (
    record.bindings.some(
      (binding) => binding.key === key || binding.groupId === key,
    )
  )
    return {
      key: randomUUID(),
      groupId: randomUUID(),
      members: [{ key: randomUUID(), terminalId }],
    };
  return {
    key,
    groupId: key,
    members: [{ key: `live-pane/${id}`, terminalId }],
  };
}

export function forgetRecordTerminal(
  record: TerminalRecordPayloadState,
  terminalId: string,
): void {
  record.terminals = record.terminals.filter(
    (entry) => entry.session.id !== terminalId,
  );
  record.bindings = record.bindings.flatMap((binding) => {
    const members = binding.members.filter(
      (member) => member.terminalId !== terminalId,
    );
    return members.length ? [{ ...binding, members }] : [];
  });
  delete record.terminalCustomNames[terminalId];
  if (record.truncatedHistoryIds)
    record.truncatedHistoryIds = record.truncatedHistoryIds.filter(
      (id) => id !== terminalId,
    );
}

export function sessionMatchesScope(
  session: TerminalSession,
  scope: { projectId: string; worktreeId: string },
): boolean {
  return (
    session.projectId === scope.projectId &&
    session.worktreeId === scope.worktreeId
  );
}

/** Validates operations before admission can mutate the supplied batch scope. */
export function validateTerminalRecordOp(
  op: WorkerTerminalRecordOp,
  scope: { projectId: string; worktreeId: string },
): void {
  if (op.op === 'session.upsert' && !sessionMatchesScope(op.session, scope))
    throw new Error('The terminal session belongs to another record scope.');
  if (op.op === 'layout.save') validateTerminalRecordLayout(op);
}

function validateTerminalRecordLayout(
  op: Extract<WorkerTerminalRecordOp, { op: 'layout.save' }>,
): void {
  if (
    new Set(op.bindings.map((binding) => binding.key)).size !==
      op.bindings.length ||
    op.bindings.some(
      (binding) =>
        new Set(binding.members.map((member) => member.key)).size !==
        binding.members.length,
    )
  )
    throw new Error(
      'The terminal layout contains duplicate binding or member keys.',
    );
}

/**
 * A drawer save, rebased onto the record: only terminals the client was
 * served and no longer references are forgotten; terminals it never saw
 * keep their membership and names.
 */
function saveLayout(
  record: TerminalRecordPayloadState,
  op: Extract<WorkerTerminalRecordOp, { op: 'layout.save' }>,
  hooks: TerminalRecordOpHooks,
): void {
  validateTerminalRecordLayout(op);
  const referenced = new Set(op.referencedIds);
  const served = new Set(op.servedIds);
  for (const terminalId of served)
    if (!referenced.has(terminalId)) {
      forgetRecordTerminal(record, terminalId);
      hooks.forgotten?.(terminalId);
    }
  for (const terminalId of referenced) {
    if (recordEntry(record, terminalId)) continue;
    const live = hooks.liveSession?.(terminalId) ?? null;
    if (live && isDrawerOwnedTerminal(live))
      record.terminals.push({
        session: structuredClone(live),
        scrollbackLines: [],
        exitCode: null,
        signal: null,
      });
  }
  const unseen = (terminalId: string): boolean =>
    !served.has(terminalId) && !referenced.has(terminalId);
  const bindings: WorkerTerminalRecordBinding[] = op.bindings.map((binding) =>
    structuredClone(binding),
  );
  for (const previous of record.bindings) {
    const kept = previous.members.filter((member) => unseen(member.terminalId));
    if (!kept.length) continue;
    const same = bindings.find((binding) => binding.key === previous.key);
    if (same) {
      const occupied = new Set(
        [...same.members, ...kept].map((member): string => member.key),
      );
      for (const member of kept) {
        const incoming = same.members.find(
          (existing): boolean => existing.key === member.key,
        );
        if (incoming?.terminalId === member.terminalId) continue;
        if (incoming) {
          // The unseen occurrence owns its key. Derive the incoming key from
          // its full identity so a stale retry does not accumulate new panes.
          const base = `merge/${createHash('sha256')
            .update(
              JSON.stringify([same.key, incoming.key, incoming.terminalId]),
            )
            .digest('hex')}`;
          let key = base;
          let suffix = 1;
          while (occupied.has(key)) key = `${base}/${suffix++}`;
          occupied.add(key);
          incoming.key = key;
        }
        same.members.push(structuredClone(member));
      }
    } else bindings.push({ ...previous, members: kept });
  }
  record.bindings = bindings;
  const names: Record<string, string> = {};
  for (const [terminalId, name] of Object.entries(record.terminalCustomNames))
    if (unseen(terminalId)) setOwn(names, terminalId, name);
  for (const [terminalId, name] of Object.entries(op.terminalCustomNames)) {
    const sanitized = referenced.has(terminalId) ? sanitizeName(name) : null;
    if (sanitized !== null) setOwn(names, terminalId, sanitized);
  }
  record.terminalCustomNames = names;
}

/**
 * A record held while its legacy state could not be imported, laid over
 * that state once it is (CAN-7051): the authority's import and main's view
 * of a pending record compose the same way. A terminal in both keeps its
 * legacy output with what it reported meanwhile appended, as a restored
 * terminal's output would have been; its session and exit are the newer.
 */
export function mergePendingRecord(
  legacy: TerminalRecordPayloadState,
  pending: TerminalRecordPayloadState,
): TerminalRecordPayloadState {
  const merged: TerminalRecordPayloadState = {
    bindings: structuredClone(legacy.bindings),
    terminals: structuredClone(legacy.terminals),
    terminalCustomNames: {
      ...legacy.terminalCustomNames,
      ...pending.terminalCustomNames,
    },
  };
  for (const entry of pending.terminals) {
    const existing = recordEntry(merged, entry.session.id);
    if (!existing) {
      merged.terminals.push(structuredClone(entry));
      continue;
    }
    existing.session = structuredClone(entry.session);
    if (entry.scrollbackLines.length > 0)
      existing.scrollbackLines = appendScrollbackLines(
        existing.scrollbackLines,
        pending.truncatedHistoryIds?.includes(entry.session.id)
          ? discontinuousOutput(
              existing.scrollbackLines,
              entry.scrollbackLines.join('\n'),
            )
          : entry.scrollbackLines.join('\n'),
      );
    existing.exitCode = entry.exitCode;
    existing.signal = entry.signal;
  }
  const bound = (terminalId: string): boolean =>
    merged.bindings.some((binding) =>
      binding.members.some((member) => member.terminalId === terminalId),
    );
  for (const binding of pending.bindings) {
    const members = binding.members.filter(
      (member) => !bound(member.terminalId),
    );
    if (members.length === 0) continue;
    const taken = merged.bindings.some(
      (candidate) =>
        candidate.key === binding.key || candidate.groupId === binding.groupId,
    );
    if (!taken) merged.bindings.push(structuredClone({ ...binding, members }));
    else
      for (const member of members)
        merged.bindings.push(liveBinding(merged, member.terminalId));
  }
  return merged;
}

/** Applies one op; the same code serves the authority and main's overlay. */
export function applyTerminalRecordOp(
  record: TerminalRecordPayloadState,
  op: WorkerTerminalRecordOp,
  hooks: TerminalRecordOpHooks = {},
): void {
  switch (op.op) {
    case 'session.upsert':
      if (isDrawerOwnedTerminal(op.session))
        upsertRecordSession(record, op.session);
      return;
    case 'output.append': {
      const entry = recordEntry(record, op.terminalId);
      if (!entry || op.text.length === 0) return;
      entry.scrollbackLines = appendScrollbackLines(
        entry.scrollbackLines,
        op.text,
        hooks.trackHistoryTruncation === false
          ? undefined
          : (): void => markHistoryTruncated(record, op.terminalId),
      );
      hooks.historyChanged?.(op.terminalId);
      return;
    }
    case 'output.replace': {
      const entry = recordEntry(record, op.terminalId);
      if (!entry) return;
      entry.scrollbackLines = retainScrollbackLines(
        op.lines,
        hooks.trackHistoryTruncation === false
          ? undefined
          : (): void => markHistoryTruncated(record, op.terminalId),
      );
      hooks.historyChanged?.(op.terminalId);
      return;
    }
    case 'exit': {
      const entry = recordEntry(record, op.terminalId);
      if (!entry || isShutdownExitSignal(entry.signal)) return;
      entry.exitCode = op.exitCode;
      entry.signal = op.signal;
      return;
    }
    case 'forget':
      forgetRecordTerminal(record, op.terminalId);
      hooks.forgotten?.(op.terminalId);
      return;
    case 'rename': {
      const name = op.name === null ? null : sanitizeName(op.name);
      if (name === null) delete record.terminalCustomNames[op.terminalId];
      else setOwn(record.terminalCustomNames, op.terminalId, name);
      return;
    }
    case 'layout.save':
      saveLayout(record, op, hooks);
      return;
  }
}
