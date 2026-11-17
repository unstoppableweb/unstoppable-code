import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { writeFileAtomicallySync } from '@canopy/execution-engine/node/lib/atomic-file';
import {
  damagedCopyPath,
  pruneDamagedCopiesSync,
} from '@canopy/execution-engine/node/lib/damaged-copies';
import {
  TERMINAL_PERSISTED_SCROLLBACK_MAX_LINES,
  type LoadWorktreeTerminalStateResponse,
  type PersistedTerminalEntry,
  type PersistedWorktreeTerminalStateFile,
  type SaveWorktreeTerminalStateRequest,
  type TerminalGroup,
  type TerminalSession,
} from '@canopy/desktop-shared/types';
import {
  assertAdmittedWriter,
  STORAGE_OWNERSHIP,
} from '@canopy/core-runtime/storage';
import {
  composeRecords,
  createEmptyState,
  hasVersion1Shape,
  isFiniteNumber,
  isPresentationFile,
  isWorkerFile,
  normalizeCustomNameMap,
  normalizePersistedState,
  normalizeSplitSizes,
  recordsForState,
  type TerminalRecords,
} from './persistence-codec';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  getWorktreeTerminalStateFilePath,
  getWorktreeTerminalPresentationFilePath,
} from '../lib/paths';
import { isRecord } from '../lib/type-guards';

interface CachedWorktreeTerminalState {
  projectId: string;
  worktreeId: string;
  filePath: string;
  presentationPath: string;
  state: PersistedWorktreeTerminalStateFile;
  records: TerminalRecords;
  workerDirty: boolean;
  presentationDirty: boolean;
  migrationPending: boolean;
  workerInstalled: string | undefined;
  presentationInstalled: string | undefined;
  damaged: string[];
  /** False while the file on disk must be left as it is this session. */
  writable: boolean;
}

type TerminalStateFileRead =
  | { kind: 'absent' }
  | { kind: 'readable'; value: Record<string, unknown>; bytes: Buffer }
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

function readTerminalStateFile(
  filePath: string,
  presentation = false,
): TerminalStateFileRead {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    const code = errorCode(error);
    return code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'unreadable', code };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { kind: 'damaged' };
  }
  if (!isRecord(parsed) || typeof parsed.version !== 'number') {
    return { kind: 'damaged' };
  }
  if (parsed.version > (presentation ? 1 : 2)) {
    return { kind: 'newer' };
  }
  return (
    presentation
      ? isPresentationFile(parsed)
      : isWorkerFile(parsed) ||
        (parsed.version === 1 && hasVersion1Shape(parsed))
  )
    ? { kind: 'readable', value: parsed, bytes }
    : { kind: 'damaged' };
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

  private readonly utf8Decoders = new Map<string, Map<string, StringDecoder>>();

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
    const presentationPath = getWorktreeTerminalPresentationFilePath(
      projectId,
      worktreeId,
    );
    const file = readTerminalStateFile(filePath);
    const presentation = readTerminalStateFile(presentationPath, true);
    const writable = ![file.kind, presentation.kind].some(
      (kind) => kind === 'newer' || kind === 'unreadable',
    );
    if (!writable) {
      logMainProcessWarn('Leaving terminal state unchanged this session', {
        reason: file.kind,
        ...(file.kind === 'unreadable' ? { code: file.code } : {}),
      });
    }

    const worker =
      file.kind === 'readable' && isWorkerFile(file.value)
        ? file.value
        : undefined;
    const legacy = file.kind === 'readable' && file.value.version === 1;
    const lineage =
      worker?.lineage ??
      (legacy && file.kind === 'readable'
        ? `legacy/${createHash('sha256')
            .update(
              JSON.stringify([
                projectId,
                worktreeId,
                file.bytes.toString('base64'),
              ]),
            )
            .digest('hex')}`
        : randomUUID());
    let state =
      legacy && file.kind === 'readable'
        ? normalizePersistedState(file.value, projectId, worktreeId)
        : createEmptyState();
    const acceptedPresentation =
      presentation.kind === 'readable' &&
      isPresentationFile(presentation.value) &&
      presentation.value.lineage === lineage
        ? presentation.value
        : undefined;
    let records = worker
      ? {
          worker,
          presentation:
            acceptedPresentation ??
            recordsForState(state, lineage).presentation,
        }
      : recordsForState(state, lineage, undefined, legacy);
    if (worker || acceptedPresentation) {
      state = composeRecords(
        records.worker,
        acceptedPresentation,
        projectId,
        worktreeId,
      );
      records = recordsForState(state, lineage, {
        worker: records.worker,
        presentation: acceptedPresentation ?? records.presentation,
      });
    }
    const materialized =
      file.kind !== 'absent' || presentation.kind !== 'absent';
    const cached: CachedWorktreeTerminalState = {
      projectId,
      worktreeId,
      filePath,
      presentationPath,
      state,
      records,
      migrationPending: legacy,
      workerDirty: materialized && !worker,
      presentationDirty:
        materialized &&
        JSON.stringify(records.presentation) !==
          JSON.stringify(acceptedPresentation),
      workerInstalled: worker
        ? JSON.stringify(records.worker, null, 2)
        : undefined,
      presentationInstalled: acceptedPresentation
        ? JSON.stringify(acceptedPresentation, null, 2)
        : undefined,
      damaged: [
        ...(file.kind === 'damaged' ? [filePath] : []),
        ...(presentation.kind === 'damaged' ? [presentationPath] : []),
      ],
      writable,
    };
    this.cache.set(key, cached);
    return cached;
  }

  private refreshRecords(cached: CachedWorktreeTerminalState): void {
    const next = recordsForState(
      cached.state,
      cached.records.worker.lineage,
      cached.records,
    );
    if (
      JSON.stringify([
        next.worker.bindings,
        next.worker.terminalCustomNames,
      ]) !==
      JSON.stringify([
        cached.records.worker.bindings,
        cached.records.worker.terminalCustomNames,
      ])
    )
      cached.workerDirty = true;
    if (
      JSON.stringify(next.presentation) !==
      JSON.stringify(cached.records.presentation)
    )
      cached.presentationDirty = true;
    cached.records = next;
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
      this.refreshRecords(cached);
      if (
        !cached.workerDirty &&
        !cached.presentationDirty &&
        !cached.migrationPending
      )
        return;
      // Preflight the pair before mkdir, evidence preservation or either install.
      assertAdmittedWriter(
        'terminal_state',
        'electron_main',
        'main/terminal/persistence',
        STORAGE_OWNERSHIP,
      );
      assertAdmittedWriter(
        'terminal_presentation',
        'electron_main',
        'main/terminal/persistence',
        STORAGE_OWNERSHIP,
      );
      for (const path of [...cached.damaged]) {
        if (!setAsideDamagedStateFile(path)) {
          cached.writable = false;
          return;
        }
        cached.damaged.splice(cached.damaged.indexOf(path), 1);
      }
      mkdirSync(dirname(cached.filePath), { recursive: true });
      const installWorker = (): void => {
        const bytes = JSON.stringify(cached.records.worker, null, 2);
        if (cached.workerInstalled !== bytes) {
          writeFileAtomicallySync(
            getWorktreeTerminalStateFilePath(projectId, worktreeId),
            bytes,
            {
              encoding: 'utf8',
              admittedWriter: {
                namespace: 'terminal_state',
                writer: 'electron_main',
                module: 'main/terminal/persistence',
              },
            },
          );
          cached.workerInstalled = bytes;
        }
        cached.workerDirty = false;
      };
      const installPresentation = (): void => {
        const bytes = JSON.stringify(cached.records.presentation, null, 2);
        if (cached.presentationInstalled !== bytes) {
          writeFileAtomicallySync(
            getWorktreeTerminalPresentationFilePath(projectId, worktreeId),
            bytes,
            {
              encoding: 'utf8',
              admittedWriter: {
                namespace: 'terminal_presentation',
                writer: 'electron_main',
                module: 'main/terminal/persistence',
              },
            },
          );
          cached.presentationInstalled = bytes;
        }
        cached.presentationDirty = false;
      };
      if (cached.migrationPending) {
        installPresentation();
        installWorker();
        cached.migrationPending = false;
      } else {
        // A first presentation-only mutation still materializes the v2 fence.
        if (cached.workerDirty || cached.workerInstalled === undefined)
          installWorker();
        if (
          cached.presentationDirty ||
          cached.presentationInstalled === undefined
        )
          installPresentation();
      }
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
      cached.workerDirty = true;
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

    this.refreshRecords(cached);
    return serializeResponse(cached.state, liveTerminalIds);
  }

  private getUtf8Decoder(key: string, terminalId: string): StringDecoder {
    let decoders = this.utf8Decoders.get(key);
    if (!decoders) {
      decoders = new Map();
      this.utf8Decoders.set(key, decoders);
    }
    const existing = decoders.get(terminalId);
    if (existing) {
      return existing;
    }

    const created = new StringDecoder('utf8');
    decoders.set(terminalId, created);
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
    cached.workerDirty = true;
    entry.exitCode = null;
    entry.signal = null;
    if (!hasGroupForTerminal(cached.state.groups, session.id)) {
      const group = buildSyntheticGroup(cached.state, session.id);
      cached.state.groups.push(group);
      if (shouldActivateSyntheticGroup(session)) {
        cached.state.activeGroupId = group.id;
      }
    }
    this.refreshRecords(cached);
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

    const decodedChunk = this.getUtf8Decoder(
      worktreeKey(projectId, worktreeId),
      terminalId,
    ).write(chunk);
    if (decodedChunk.length === 0) {
      return;
    }

    entry.scrollbackLines = appendScrollbackLines(
      entry.scrollbackLines,
      decodedChunk,
    );
    cached.workerDirty = true;
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
    const decoders = this.utf8Decoders.get(key);
    const trailingChunk = decoders?.get(terminalId)?.end() ?? '';
    decoders?.delete(terminalId);
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
    cached.workerDirty = true;
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

    // Legacy omission inference stays scoped to the request, including ungrouped history.
    for (const terminalId of new Set(
      cached.state.terminals.map((entry) => entry.session.id),
    )) {
      if (!referencedTerminalIds.has(terminalId))
        this.forgetCached(cached, terminalId);
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

    cached.state.drawerCollapsed = request.drawerCollapsed;
    cached.state.groups = nextGroups;
    cached.state.groupOrdinals = {};
    for (const group of nextGroups) {
      const rawOrdinal = request.groupOrdinals[group.id];
      if (isFiniteNumber(rawOrdinal) && rawOrdinal >= 1) {
        cached.state.groupOrdinals[group.id] = Math.round(rawOrdinal);
      }
    }

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
        cached.workerDirty = true;
      }
    }

    for (const terminalId of Array.from(referencedTerminalIds)) {
      suppressed.delete(terminalId);
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

    this.refreshRecords(cached);
    this.scheduleWrite(request.projectId, request.worktreeId);
  }

  private forgetCached(
    cached: CachedWorktreeTerminalState,
    terminalId: string,
  ): void {
    const state = cached.state;
    const presentationAffected = state.groups.some((group) =>
      group.terminalIds.includes(terminalId),
    );
    const present =
      state.terminals.some((entry) => entry.session.id === terminalId) ||
      presentationAffected ||
      Object.prototype.hasOwnProperty.call(
        state.terminalCustomNames,
        terminalId,
      );
    if (!present) return;
    state.terminals = state.terminals.filter(
      (entry) => entry.session.id !== terminalId,
    );
    // Preserve surviving occurrence identities even when equal-ID groups disappear.
    cached.records.worker.bindings = cached.records.worker.bindings.flatMap(
      (binding) => {
        const members = binding.members.filter(
          (member) => member.terminalId !== terminalId,
        );
        return members.length ? [{ ...binding, members }] : [];
      },
    );
    const bindingKeys = new Set(
      cached.records.worker.bindings.map((binding) => binding.key),
    );
    cached.records.presentation.groups =
      cached.records.presentation.groups.filter((group) =>
        bindingKeys.has(group.bindingKey),
      );
    delete state.terminalCustomNames[terminalId];
    state.groups = state.groups.flatMap((group) => {
      const terminalIds = group.terminalIds.filter((id) => id !== terminalId);
      if (!terminalIds.length) return [];
      if (terminalIds.length === group.terminalIds.length) return [group];
      return [
        {
          ...group,
          terminalIds,
          focusedTerminalId: terminalIds.includes(group.focusedTerminalId)
            ? group.focusedTerminalId
            : terminalIds[0],
          splitSizes: normalizeSplitSizes(terminalIds.length),
        },
      ];
    });
    const groupIds = new Set(state.groups.map((group) => group.id));
    state.groupOrdinals = Object.fromEntries(
      Object.entries(state.groupOrdinals).filter(([id]) => groupIds.has(id)),
    );
    state.groupCustomNames = Object.fromEntries(
      Object.entries(state.groupCustomNames).filter(([id]) => groupIds.has(id)),
    );
    if (state.activeGroupId !== null && !groupIds.has(state.activeGroupId))
      state.activeGroupId = state.groups[0]?.id ?? null;
    this.utf8Decoders
      .get(worktreeKey(cached.projectId, cached.worktreeId))
      ?.delete(terminalId);
    const live = this.liveSessions.get(terminalId);
    if (
      live &&
      live.projectId === cached.projectId &&
      live.worktreeId === cached.worktreeId &&
      isDrawerOwnedTerminal(live)
    ) {
      this.getSuppressedLiveTerminals(
        worktreeKey(cached.projectId, cached.worktreeId),
      ).add(terminalId);
    }
    cached.workerDirty = true;
    if (presentationAffected) cached.presentationDirty = true;
    this.refreshRecords(cached);
    this.scheduleWrite(cached.projectId, cached.worktreeId);
  }

  /** Explicit deletion; never scans unloaded worktrees and never kills a shell. */
  public forget(terminalId: string): void {
    for (const cached of this.cache.values())
      this.forgetCached(cached, terminalId);
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
    this.utf8Decoders.delete(key);
    this.cache.delete(key);
    this.suppressedLiveTerminals.delete(key);
    for (const session of Array.from(this.liveSessions.values())) {
      if (
        session.projectId === projectId &&
        session.worktreeId === worktreeId
      ) {
        this.liveSessions.delete(session.id);
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
