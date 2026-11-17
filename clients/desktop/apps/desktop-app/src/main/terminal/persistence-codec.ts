import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TERMINAL_DRAWER_COLLAPSED,
  TERMINAL_CUSTOM_NAME_MAX_LENGTH,
  TERMINAL_PERSISTED_SCROLLBACK_MAX_LINES,
  type PersistedTerminalEntry,
  type PersistedWorktreeTerminalStateFile,
  type TerminalGroup,
  type TerminalSession,
  type WorktreeTerminalLayoutState,
} from '@canopy/desktop-shared/types';
import { isRecord } from '../lib/type-guards';

interface TerminalMember {
  key: string;
  terminalId: string;
}
interface TerminalBinding {
  key: string;
  groupId: string;
  members: TerminalMember[];
}
interface TerminalWorkerFile {
  version: 2;
  lineage: string;
  bindings: TerminalBinding[];
  terminals: PersistedTerminalEntry[];
  terminalCustomNames: Record<string, string>;
}
interface TerminalPresentationGroup {
  bindingKey: string;
  paneOrder: string[];
  focusedTerminalId: string;
  splitSizes: number[];
}
interface TerminalPresentationFile {
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
      normalized[key] = sanitized;
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
