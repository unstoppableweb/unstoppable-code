import {
  IPC_CHANNELS,
  type MemorySyncConflict,
  type MemorySyncControlResult,
  type MemorySyncHistoryResult,
  type MemorySyncPreviewResult,
  type MemorySyncSettingsPatch,
  type MemorySyncState,
} from '@canopy/desktop-shared/types';
import {
  isMemoryDocumentPath,
  isMemoryUlid,
} from '@canopy/protocol/memory-sync';
import {
  LOCAL_MEMORY_CHAT_SCOPE_SENTINELS,
  isLocalMemoryWorkspaceId,
} from '@canopy/desktop-shared/lib/local-memory-scope';
import { validateId } from '../lib/validation';
import {
  applyMemorySyncMerge,
  deleteMemorySyncFromCloud,
  getMemorySyncState,
  listMemorySyncHistory,
  previewMemorySyncMerge,
  readMemorySyncConflict,
  setMemorySyncProjectMemory,
  settleMemorySyncConflict,
  restoreMemorySyncRevision,
  startMemorySyncBroadcasts,
  updateMemorySyncSettings,
} from '../memory/sync/controls';
import { registerIpcHandler } from './register';

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid memory sync request.');
  }
  return Object.fromEntries(Object.entries(value));
}

function mode(value: unknown): 'sync' | 'device_only' {
  if (value === 'sync' || value === 'device_only') return value;
  throw new Error('Invalid memory sync request.');
}

/** Only the fields a person can change, each checked. */
function settingsPatch(value: unknown): MemorySyncSettingsPatch {
  const request = record(value);
  const patch: MemorySyncSettingsPatch = {};
  if (request.enabled !== undefined) {
    if (typeof request.enabled !== 'boolean') {
      throw new Error('Invalid memory sync request.');
    }
    patch.enabled = request.enabled;
  }
  if (request.userScope !== undefined)
    patch.userScope = mode(request.userScope);
  if (request.defaultProjectScope !== undefined) {
    patch.defaultProjectScope = mode(request.defaultProjectScope);
  }
  if (request.serverConsolidation !== undefined) {
    if (
      request.serverConsolidation !== 'allowed' &&
      request.serverConsolidation !== 'disallowed'
    ) {
      throw new Error('Invalid memory sync request.');
    }
    patch.serverConsolidation = request.serverConsolidation;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error('Invalid memory sync request.');
  }
  return patch;
}

function documentPath(value: unknown): string {
  const path = record(value).path;
  if (typeof path !== 'string' || !isMemoryDocumentPath(path)) {
    throw new Error('Invalid memory sync request.');
  }
  return path;
}

function previewId(value: unknown): string {
  const id = record(value).previewId;
  if (!isMemoryUlid(id)) throw new Error('Invalid memory sync request.');
  return id;
}

/**
 * The workspace whose bound cloud project a control acts on, when one is
 * named; undefined means the memories saved for every project. Main
 * resolves it to a project scope through the workspace's own binding, so an
 * ID no workspace of the account is bound by maps to no scope.
 */
function optionalWorkspaceId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const id = record(value).workspaceId;
  if (id === undefined) return undefined;
  if (
    typeof id !== 'string' ||
    LOCAL_MEMORY_CHAT_SCOPE_SENTINELS.has(id) ||
    !isLocalMemoryWorkspaceId(id)
  ) {
    throw new Error('Invalid memory sync request.');
  }
  validateId(id, 'workspaceId');
  return id;
}

function workspaceId(value: unknown): string {
  const id = optionalWorkspaceId(value);
  if (id === undefined) throw new Error('Invalid memory sync request.');
  return id;
}

function revisionNumber(value: unknown, key: string): number {
  const revision = record(value)[key];
  if (
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw new Error('Invalid memory sync request.');
  }
  return revision;
}

export function registerMemorySyncHandlers(): void {
  startMemorySyncBroadcasts();
  registerIpcHandler<[], MemorySyncState>(IPC_CHANNELS.memorySyncGetState, () =>
    getMemorySyncState(),
  );
  registerIpcHandler<[unknown], MemorySyncControlResult>(
    IPC_CHANNELS.memorySyncUpdateSettings,
    (_event, value) => updateMemorySyncSettings(settingsPatch(value)),
  );
  registerIpcHandler<[unknown], MemorySyncPreviewResult>(
    IPC_CHANNELS.memorySyncPreviewMerge,
    (_event, value) => previewMemorySyncMerge(optionalWorkspaceId(value)),
  );
  registerIpcHandler<[unknown], MemorySyncControlResult>(
    IPC_CHANNELS.memorySyncApplyMerge,
    (_event, value) =>
      applyMemorySyncMerge(previewId(value), optionalWorkspaceId(value)),
  );
  registerIpcHandler<[unknown], MemorySyncConflict | null>(
    IPC_CHANNELS.memorySyncReadConflict,
    (_event, value) => readMemorySyncConflict(documentPath(value)),
  );
  registerIpcHandler<[unknown], MemorySyncControlResult>(
    IPC_CHANNELS.memorySyncResolveConflict,
    (_event, value) => {
      const action = record(value).action;
      if (action !== 'restore' && action !== 'dismiss') {
        throw new Error('Invalid memory sync request.');
      }
      return settleMemorySyncConflict(documentPath(value), action);
    },
  );
  registerIpcHandler<[unknown], MemorySyncHistoryResult>(
    IPC_CHANNELS.memorySyncListHistory,
    (_event, value) => {
      const before = record(value).before;
      return listMemorySyncHistory(
        before === null ? null : revisionNumber(value, 'before'),
      );
    },
  );
  registerIpcHandler<[unknown], MemorySyncControlResult>(
    IPC_CHANNELS.memorySyncRestore,
    (_event, value) =>
      restoreMemorySyncRevision(revisionNumber(value, 'revision')),
  );
  registerIpcHandler<[unknown], MemorySyncControlResult>(
    IPC_CHANNELS.memorySyncDeleteFromCloud,
    (_event, value) => {
      if (record(value).confirmed !== true) {
        throw new Error('Invalid memory sync request.');
      }
      return deleteMemorySyncFromCloud();
    },
  );
  registerIpcHandler<[unknown], MemorySyncControlResult>(
    IPC_CHANNELS.memorySyncSetProjectMemory,
    (_event, value) => {
      const keepOnThisComputer = record(value).keepOnThisComputer;
      if (typeof keepOnThisComputer !== 'boolean') {
        throw new Error('Invalid memory sync request.');
      }
      return setMemorySyncProjectMemory(workspaceId(value), keepOnThisComputer);
    },
  );
}
