import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { writeFileAtomicallySync } from '@canopy/execution-engine/node/lib/atomic-file';
import {
  damagedCopyPath,
  pruneDamagedCopiesSync,
} from '@canopy/execution-engine/node/lib/damaged-copies';
import {
  DEFAULT_TERMINAL_DRAWER_COLLAPSED,
  TERMINAL_CUSTOM_NAME_MAX_LENGTH,
  TERMINAL_PERSISTED_SCROLLBACK_MAX_LINES,
  type LoadWorktreeTerminalStateResponse,
  type PersistedTerminalEntry,
  type PersistedWorktreeTerminalStateFile,
  type SaveWorktreeTerminalStateRequest,
  type TerminalGroup,
  type TerminalSession,
  type WorktreeTerminalLayoutState,
} from '@canopy/desktop-shared/types';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getWorktreeTerminalStateFilePath } from '../lib/paths';
import { isRecord } from '../lib/type-guards';

interface CachedWorktreeTerminalState {
  projectId: string;
  worktreeId: string;
  filePath: string;
  state: PersistedWorktreeTerminalStateFile;
  /** False while the file on disk must be left as it is this session. */
  writable: boolean;
}

type TerminalStateFileRead =
  | { kind: 'absent' }
  | { kind: 'readable'; value: Record<string, unknown> }
  | { kind: 'damaged' }
  | { kind: 'newer' }
  | { kind: 'unreadable'; code: string | undefined };

const WORKTREE_WRITE_DEBOUNCE_MS = 100;

function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') {
    return undefined;
  }
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function readTerminalStateFile(filePath: string): TerminalStateFileRead {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = errorCode(error);
    return code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'unreadable', code };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'damaged' };
  }
  if (!isRecord(parsed) || typeof parsed.version !== 'number') {
    return { kind: 'damaged' };
  }
  if (parsed.version > 1) {
    return { kind: 'newer' };
  }
  return parsed.version === 1 && hasVersion1Shape(parsed)
    ? { kind: 'readable', value: parsed }
    : { kind: 'damaged' };
}

/** Absent lists read as empty; present ones must hold only valid entries. */
function hasVersion1Shape(value: Record<string, unknown>): boolean {
  const { terminals, groups } = value;
  return (
    (terminals === undefined ||
      (Array.isArray(terminals) &&
        terminals.every(isPersistedTerminalEntry))) &&
    (groups === undefined ||
      (Array.isArray(groups) && groups.every(isTerminalGroup)))
  );
}

/**
 * Keeps a damaged file's bytes beside it, with at most the newest five such
 * copies; false when it could not be moved.
 */
function setAsideDamagedStateFile(filePath: string): boolean {
  const asidePath = damagedCopyPath(filePath);
  try {
    renameSync(filePath, asidePath);
  } catch (error) {
    logMainProcessWarn('Failed to set aside damaged terminal state', {
      code: errorCode(error),
    });
    return false;
  }
  pruneDamagedCopiesSync(filePath);
  logMainProcessWarn('Set aside damaged terminal state', { asidePath });
  return true;
}

function isShutdownExitSignal(signal: string | null): boolean {
  return signal === 'app-quit' || signal === 'fatal-exit';
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

function createEmptyState(): PersistedWorktreeTerminalStateFile {
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

function isFiniteNumber(value: unknown): value is number {
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

function isPersistedTerminalEntry(
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

function normalizeCustomNameMap(
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
      normalized[key] = sanitized;
    }
  }
  return normalized;
}

function normalizeSplitSizes(count: number, existing?: number[]): number[] {
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
  if (lines.length <= TERMINAL_PERSISTED_SCROLLBACK_MAX_LINES) {
    return lines;
  }
  return lines.slice(lines.length - TERMINAL_PERSISTED_SCROLLBACK_MAX_LINES);
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

function normalizePersistedState(
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
      groupOrdinals[group.id] = Math.round(rawOrdinal);
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

function createTerminalEntry(session: TerminalSession): PersistedTerminalEntry {
  return {
    session,
    scrollbackLines: [],
    exitCode: null,
    signal: null,
  };
}

function appendScrollbackLines(existing: string[], chunk: string): string[] {
  const nextLines = existing.length > 0 ? [...existing] : [''];
  const parts = chunk.split('\n');
  nextLines[nextLines.length - 1] =
    `${nextLines[nextLines.length - 1] ?? ''}${parts[0] ?? ''}`;
  for (let index = 1; index < parts.length; index += 1) {
    nextLines.push(parts[index] ?? '');
  }

  if (nextLines.length <= TERMINAL_PERSISTED_SCROLLBACK_MAX_LINES) {
    return nextLines;
  }

  return nextLines.slice(
    nextLines.length - TERMINAL_PERSISTED_SCROLLBACK_MAX_LINES,
  );
}

function serializeResponse(
  state: PersistedWorktreeTerminalStateFile,
  liveTerminalIds: string[],
): LoadWorktreeTerminalStateResponse {
  return {
    drawerCollapsed: state.drawerCollapsed,
    groups: state.groups.map((group) => ({
      id: group.id,
      terminalIds: [...group.terminalIds],
      focusedTerminalId: group.focusedTerminalId,
      splitSizes: [...group.splitSizes],
    })),
    activeGroupId: state.activeGroupId,
    nextGroupOrdinal: state.nextGroupOrdinal,
    groupOrdinals: { ...state.groupOrdinals },
    terminalCustomNames: { ...state.terminalCustomNames },
    groupCustomNames: { ...state.groupCustomNames },
    terminals: state.terminals.map((entry) => ({
      session: entry.session,
      scrollbackLines: [...entry.scrollbackLines],
      exitCode: entry.exitCode,
      signal: entry.signal,
    })),
    liveTerminalIds,
  };
}

function hasGroupForTerminal(
  groups: TerminalGroup[],
  terminalId: string,
): boolean {
  return groups.some((group) => group.terminalIds.includes(terminalId));
}

function buildSyntheticGroup(
  state: PersistedWorktreeTerminalStateFile,
  terminalId: string,
): TerminalGroup {
  const groupId = randomUUID();
  const ordinal = state.nextGroupOrdinal;
  state.nextGroupOrdinal = ordinal + 1;
  state.groupOrdinals[groupId] = ordinal;
  return {
    id: groupId,
    terminalIds: [terminalId],
    focusedTerminalId: terminalId,
    splitSizes: [1],
  };
}

function isEmptyState(state: PersistedWorktreeTerminalStateFile): boolean {
  return (
    state.drawerCollapsed === DEFAULT_TERMINAL_DRAWER_COLLAPSED &&
    state.groups.length === 0 &&
    state.terminals.length === 0
  );
}

function isDrawerOwnedTerminal(session: TerminalSession): boolean {
  return (
    session.kind === undefined ||
    session.kind === 'shell' ||
    session.kind === 'script'
  );
}

function shouldActivateSyntheticGroup(session: TerminalSession): boolean {
  return session.kind !== 'script' || session.focusOnSpawn === true;
}

export class TerminalPersistenceStore {
  private readonly cache = new Map<string, CachedWorktreeTerminalState>();

  private readonly pendingWrites = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  private readonly liveSessions = new Map<string, TerminalSession>();

  private readonly suppressedLiveTerminals = new Map<string, Set<string>>();

  private readonly utf8Decoders = new Map<string, StringDecoder>();

  private ensureLoaded(
    projectId: string,
    worktreeId: string,
  ): CachedWorktreeTerminalState {
    const key = worktreeKey(projectId, worktreeId);
    const existing = this.cache.get(key);
    if (existing) {
      return existing;
    }

    const filePath = getWorktreeTerminalStateFilePath(projectId, worktreeId);
    const file = readTerminalStateFile(filePath);
    let writable = true;
    if (file.kind === 'damaged') {
      writable = setAsideDamagedStateFile(filePath);
    } else if (file.kind === 'newer' || file.kind === 'unreadable') {
      writable = false;
      logMainProcessWarn('Leaving terminal state unchanged this session', {
        reason: file.kind,
        ...(file.kind === 'unreadable' ? { code: file.code } : {}),
      });
    }

    const cached: CachedWorktreeTerminalState = {
      projectId,
      worktreeId,
      filePath,
      state:
        file.kind === 'readable'
          ? normalizePersistedState(file.value, projectId, worktreeId)
          : createEmptyState(),
      writable,
    };
    this.cache.set(key, cached);
    return cached;
  }

  private clearPendingWrite(key: string): void {
    const existing = this.pendingWrites.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.pendingWrites.delete(key);
    }
  }

  private getSuppressedLiveTerminals(key: string): Set<string> {
    const existing = this.suppressedLiveTerminals.get(key);
    if (existing) {
      return existing;
    }

    const created = new Set<string>();
    this.suppressedLiveTerminals.set(key, created);
    return created;
  }

  private scheduleWrite(projectId: string, worktreeId: string): void {
    const key = worktreeKey(projectId, worktreeId);
    this.clearPendingWrite(key);
    this.pendingWrites.set(
      key,
      setTimeout((): void => {
        this.pendingWrites.delete(key);
        this.flushWorktreeSync(projectId, worktreeId);
      }, WORKTREE_WRITE_DEBOUNCE_MS),
    );
  }

  /**
   * A failed write is logged and leaves the cached state in place, so the
   * next scheduled write or the quit flush writes it again.
   */
  private flushWorktreeSync(projectId: string, worktreeId: string): void {
    const key = worktreeKey(projectId, worktreeId);
    const cached = this.cache.get(key);
    if (!cached) {
      return;
    }

    this.clearPendingWrite(key);
    if (!cached.writable) {
      return;
    }

    try {
      if (isEmptyState(cached.state)) {
        rmSync(cached.filePath, { force: true });
        return;
      }

      mkdirSync(dirname(cached.filePath), { recursive: true });
      writeFileAtomicallySync(
        cached.filePath,
        JSON.stringify(cached.state, null, 2),
        { encoding: 'utf8' },
      );
    } catch (error) {
      logMainProcessWarn('Failed to write terminal state', {
        projectId,
        worktreeId,
        code: errorCode(error),
      });
    }
  }

  private upsertTerminalEntry(
    state: PersistedWorktreeTerminalStateFile,
    session: TerminalSession,
  ): PersistedTerminalEntry {
    const existing = state.terminals.find(
      (entry) => entry.session.id === session.id,
    );
    if (existing) {
      existing.session = session;
      return existing;
    }

    const created = createTerminalEntry(session);
    state.terminals.push(created);
    return created;
  }

  private mergeLiveSessions(
    cached: CachedWorktreeTerminalState,
  ): LoadWorktreeTerminalStateResponse {
    const liveTerminalIds: string[] = [];
    const suppressed = this.getSuppressedLiveTerminals(
      worktreeKey(cached.projectId, cached.worktreeId),
    );

    for (const session of Array.from(this.liveSessions.values())) {
      if (
        session.projectId !== cached.projectId ||
        session.worktreeId !== cached.worktreeId ||
        !isDrawerOwnedTerminal(session) ||
        suppressed.has(session.id)
      ) {
        continue;
      }

      liveTerminalIds.push(session.id);
      this.upsertTerminalEntry(cached.state, session);
      if (!hasGroupForTerminal(cached.state.groups, session.id)) {
        const group = buildSyntheticGroup(cached.state, session.id);
        cached.state.groups.push(group);
        if (
          cached.state.activeGroupId === null &&
          shouldActivateSyntheticGroup(session)
        ) {
          cached.state.activeGroupId = group.id;
        }
      }
    }

    return serializeResponse(cached.state, liveTerminalIds);
  }

  private getUtf8Decoder(terminalId: string): StringDecoder {
    const existing = this.utf8Decoders.get(terminalId);
    if (existing) {
      return existing;
    }

    const created = new StringDecoder('utf8');
    this.utf8Decoders.set(terminalId, created);
    return created;
  }

  public registerLiveSession(session: TerminalSession): void {
    if (!isDrawerOwnedTerminal(session)) {
      return;
    }
    this.liveSessions.set(session.id, session);
    const cached = this.ensureLoaded(session.projectId, session.worktreeId);
    const suppressed = this.getSuppressedLiveTerminals(
      worktreeKey(session.projectId, session.worktreeId),
    );
    if (suppressed.has(session.id)) {
      return;
    }
    const entry = this.upsertTerminalEntry(cached.state, session);
    entry.exitCode = null;
    entry.signal = null;
    if (!hasGroupForTerminal(cached.state.groups, session.id)) {
      const group = buildSyntheticGroup(cached.state, session.id);
      cached.state.groups.push(group);
      if (shouldActivateSyntheticGroup(session)) {
        cached.state.activeGroupId = group.id;
      }
    }
    this.scheduleWrite(session.projectId, session.worktreeId);
  }

  public appendTerminalOutput(
    projectId: string,
    worktreeId: string,
    terminalId: string,
    chunk: Buffer,
  ): void {
    if (
      !this.liveSessions.has(terminalId) &&
      !this.cache.has(worktreeKey(projectId, worktreeId))
    ) {
      return;
    }
    const cached = this.ensureLoaded(projectId, worktreeId);
    const entry = cached.state.terminals.find(
      (terminal) => terminal.session.id === terminalId,
    );
    if (!entry) {
      return;
    }

    const decodedChunk = this.getUtf8Decoder(terminalId).write(chunk);
    if (decodedChunk.length === 0) {
      return;
    }

    entry.scrollbackLines = appendScrollbackLines(
      entry.scrollbackLines,
      decodedChunk,
    );
    this.scheduleWrite(projectId, worktreeId);
  }

  public markTerminalExited(
    projectId: string,
    worktreeId: string,
    terminalId: string,
    exitCode: number | null,
    signal: string | null,
  ): void {
    const wasLive = this.liveSessions.delete(terminalId);
    const key = worktreeKey(projectId, worktreeId);
    const trailingChunk = this.utf8Decoders.get(terminalId)?.end() ?? '';
    this.utf8Decoders.delete(terminalId);
    if (!wasLive && !this.cache.has(key)) {
      return;
    }
    this.getSuppressedLiveTerminals(key).delete(terminalId);
    const cached = this.ensureLoaded(projectId, worktreeId);
    const entry = cached.state.terminals.find(
      (terminal) => terminal.session.id === terminalId,
    );
    if (!entry) {
      return;
    }

    if (trailingChunk.length > 0) {
      entry.scrollbackLines = appendScrollbackLines(
        entry.scrollbackLines,
        trailingChunk,
      );
    }
    if (!isShutdownExitSignal(entry.signal)) {
      entry.exitCode = exitCode;
      entry.signal = signal;
    }
    this.scheduleWrite(projectId, worktreeId);
  }

  public markAllLiveTerminalsExited(signal: string): void {
    for (const session of Array.from(this.liveSessions.values())) {
      this.markTerminalExited(
        session.projectId,
        session.worktreeId,
        session.id,
        null,
        signal,
      );
    }
    this.flushAllSync();
  }

  public loadWorktreeState(
    projectId: string,
    worktreeId: string,
  ): LoadWorktreeTerminalStateResponse {
    const cached = this.ensureLoaded(projectId, worktreeId);
    return this.mergeLiveSessions(cached);
  }

  public saveWorktreeState(request: SaveWorktreeTerminalStateRequest): void {
    const cached = this.ensureLoaded(request.projectId, request.worktreeId);
    const key = worktreeKey(request.projectId, request.worktreeId);
    const suppressed = this.getSuppressedLiveTerminals(key);
    const referencedTerminalIds = new Set<string>();
    for (const group of request.groups) {
      for (const terminalId of group.terminalIds) {
        referencedTerminalIds.add(terminalId);
      }
    }

    const nextGroups: TerminalGroup[] = [];
    for (const group of request.groups) {
      const terminalIds = group.terminalIds.filter((id) =>
        referencedTerminalIds.has(id),
      );
      if (terminalIds.length === 0) {
        continue;
      }

      const focusedTerminalId = terminalIds.includes(group.focusedTerminalId)
        ? group.focusedTerminalId
        : terminalIds[0];
      nextGroups.push({
        id: group.id,
        terminalIds,
        focusedTerminalId,
        splitSizes: normalizeSplitSizes(terminalIds.length, group.splitSizes),
      });
    }

    const previouslyPersistedTerminalIds = new Set(
      cached.state.terminals.map((entry) => entry.session.id),
    );
    cached.state.drawerCollapsed = request.drawerCollapsed;
    cached.state.groups = nextGroups;
    cached.state.groupOrdinals = {};
    for (const group of nextGroups) {
      const rawOrdinal = request.groupOrdinals[group.id];
      if (isFiniteNumber(rawOrdinal) && rawOrdinal >= 1) {
        cached.state.groupOrdinals[group.id] = Math.round(rawOrdinal);
      }
    }

    cached.state.terminals = cached.state.terminals.filter((entry) =>
      referencedTerminalIds.has(entry.session.id),
    );
    const existingTerminalIds = new Set(
      cached.state.terminals.map((entry) => entry.session.id),
    );
    for (const terminalId of Array.from(referencedTerminalIds)) {
      if (existingTerminalIds.has(terminalId)) {
        continue;
      }
      const liveSession = this.liveSessions.get(terminalId);
      if (liveSession) {
        cached.state.terminals.push(createTerminalEntry(liveSession));
      }
    }

    for (const terminalId of Array.from(referencedTerminalIds)) {
      suppressed.delete(terminalId);
    }
    for (const terminalId of Array.from(previouslyPersistedTerminalIds)) {
      if (referencedTerminalIds.has(terminalId)) {
        continue;
      }
      if (this.liveSessions.has(terminalId)) {
        suppressed.add(terminalId);
      } else {
        suppressed.delete(terminalId);
      }
    }

    const groupIdSet = new Set(nextGroups.map((group) => group.id));
    cached.state.terminalCustomNames = normalizeCustomNameMap(
      request.terminalCustomNames,
      referencedTerminalIds,
    );
    cached.state.groupCustomNames = normalizeCustomNameMap(
      request.groupCustomNames,
      groupIdSet,
    );

    cached.state.activeGroupId =
      request.activeGroupId !== null && groupIdSet.has(request.activeGroupId)
        ? request.activeGroupId
        : (nextGroups[0]?.id ?? null);
    cached.state.nextGroupOrdinal =
      isFiniteNumber(request.nextGroupOrdinal) && request.nextGroupOrdinal >= 1
        ? Math.round(request.nextGroupOrdinal)
        : 1;
    for (const ordinal of Object.values(cached.state.groupOrdinals)) {
      if (ordinal >= cached.state.nextGroupOrdinal) {
        cached.state.nextGroupOrdinal = ordinal + 1;
      }
    }

    this.scheduleWrite(request.projectId, request.worktreeId);
  }

  public getPersistedTerminalEntry(
    terminalId: string,
  ): PersistedTerminalEntry | null {
    for (const cached of Array.from(this.cache.values())) {
      const entry = cached.state.terminals.find(
        (terminal) => terminal.session.id === terminalId,
      );
      if (!entry) {
        continue;
      }

      return {
        session: entry.session,
        scrollbackLines: [...entry.scrollbackLines],
        exitCode: entry.exitCode,
        signal: entry.signal,
      };
    }

    return null;
  }

  /**
   * Drops everything held for a worktree whose data directory is about to be
   * removed, so no pending or later write recreates its terminal state.
   */
  public forgetWorktree(projectId: string, worktreeId: string): void {
    const key = worktreeKey(projectId, worktreeId);
    this.clearPendingWrite(key);
    this.cache.delete(key);
    this.suppressedLiveTerminals.delete(key);
    for (const session of Array.from(this.liveSessions.values())) {
      if (
        session.projectId === projectId &&
        session.worktreeId === worktreeId
      ) {
        this.liveSessions.delete(session.id);
        this.utf8Decoders.delete(session.id);
      }
    }
  }

  public flushAllSync(): void {
    for (const key of Array.from(this.pendingWrites.keys())) {
      this.clearPendingWrite(key);
    }

    for (const cached of Array.from(this.cache.values())) {
      this.flushWorktreeSync(cached.projectId, cached.worktreeId);
    }
  }
}

export const terminalPersistenceStore = new TerminalPersistenceStore();
