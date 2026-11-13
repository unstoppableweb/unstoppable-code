import {
  IPC_CHANNELS,
  type LocalMemoryConsolidationStatus,
  type LocalMemoryDocument,
  type LocalMemoryFileSummary,
  type LocalMemoryRebuildResponse,
  type LocalMemoryScopeRequest,
  type LocalMemorySnapshotRestoreResponse,
  type LocalMemorySnapshotSummary,
} from '@canopy/desktop-shared/types';
import { LOCAL_MEMORY_CHAT_SCOPE_SENTINELS } from '@canopy/desktop-shared/lib/local-memory-scope';
import { validateId } from '../lib/validation';
import {
  broadcastLocalMemoryChanged,
  unwatchLocalMemoryScope,
  watchLocalMemoryScope,
} from '../memory/local/change-events';
import { localMemoryStore } from '../memory/local/memory-store';
import { registerIpcHandler } from './register';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Invalid memory request.');
  return value;
}

function scopeRequest(value: unknown): LocalMemoryScopeRequest {
  const request = record(value);
  if (request.scope === 'user') return { scope: 'user' };
  if (
    request.scope !== 'workspace' ||
    typeof request.workspaceId !== 'string' ||
    LOCAL_MEMORY_CHAT_SCOPE_SENTINELS.has(request.workspaceId)
  )
    throw new Error('Choose a memory workspace.');
  validateId(request.workspaceId, 'workspaceId');
  return { scope: 'workspace', workspaceId: request.workspaceId };
}

function field(request: Record<string, unknown>, key: string): string {
  if (typeof request[key] !== 'string')
    throw new Error('Invalid memory request.');
  return request[key];
}

/**
 * A consolidation the person asked for. The trigger enforces the single-run
 * guard and records the outcome; the answer is the fresh status with the run
 * that just finished layered on top, so a failed state write can never answer
 * with the pre-run outcome. Settings and App Advisor (CAN-6005) both use it.
 */
export async function consolidateLocalMemoryNow(
  scope: LocalMemoryScopeRequest,
): Promise<LocalMemoryConsolidationStatus> {
  const run = await localMemoryStore.consolidateNow(scope);
  const status = await localMemoryStore.consolidationStatus(scope);
  if (!run.recorded) return status;
  const succeeded = run.outcome.result === 'success';
  return {
    ...status,
    lastRunAt: run.finishedAt,
    lastResult: run.outcome.result,
    lastReason: run.outcome.reason ?? null,
    ...(succeeded ? { lastConsolidatedAt: run.finishedAt } : {}),
  };
}

/** Rebuilds a scope's memory from its notes, with the status after. */
export async function rebuildLocalMemory(
  scope: LocalMemoryScopeRequest,
  precondition?: () => Promise<void>,
): Promise<LocalMemoryRebuildResponse> {
  const rebuild = await localMemoryStore.rebuild(scope, precondition);
  const status = await localMemoryStore.consolidationStatus(scope);
  return { rebuild, status };
}

export function registerLocalMemoryHandlers(): void {
  registerIpcHandler<[unknown], LocalMemoryFileSummary[]>(
    IPC_CHANNELS.localMemoryList,
    async (_event, value) =>
      localMemoryStore.listDocuments(scopeRequest(value)),
  );
  registerIpcHandler<[unknown], LocalMemoryDocument>(
    IPC_CHANNELS.localMemoryRead,
    async (_event, value) =>
      localMemoryStore.readDocument(
        scopeRequest(value),
        field(record(value), 'fileKey'),
      ),
  );
  for (const [channel, update] of [
    [IPC_CHANNELS.localMemoryUpdateItem, true],
    [IPC_CHANNELS.localMemoryDeleteItem, false],
  ] as const) {
    registerIpcHandler<[unknown], LocalMemoryDocument>(
      channel,
      async (_event, value) => {
        const scope = scopeRequest(value);
        const request = record(value);
        const result = await localMemoryStore.mutateItem(scope, {
          fileKey: field(request, 'fileKey'),
          itemId: field(request, 'itemId'),
          revision: field(request, 'revision'),
          ...(update ? { text: field(request, 'text') } : {}),
        });
        broadcastLocalMemoryChanged(scope);
        return result;
      },
    );
  }
  registerIpcHandler<[unknown], LocalMemoryDocument>(
    IPC_CHANNELS.localMemoryUpdateFile,
    async (_event, value) => {
      const scope = scopeRequest(value);
      const request = record(value);
      const result = await localMemoryStore.writeDocument(scope, {
        fileKey: field(request, 'fileKey'),
        revision: field(request, 'revision'),
        body: field(request, 'body'),
        ...(request.title === undefined
          ? {}
          : { title: field(request, 'title') }),
      });
      broadcastLocalMemoryChanged(scope);
      return result;
    },
  );
  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.localMemoryDeleteFile,
    async (_event, value) => {
      const scope = scopeRequest(value);
      const request = record(value);
      await localMemoryStore.deleteDocument(scope, {
        fileKey: field(request, 'fileKey'),
        revision: field(request, 'revision'),
      });
      broadcastLocalMemoryChanged(scope);
    },
  );
  registerIpcHandler<[unknown], LocalMemoryConsolidationStatus>(
    IPC_CHANNELS.localMemoryConsolidationStatus,
    async (_event, value) =>
      localMemoryStore.consolidationStatus(scopeRequest(value)),
  );
  registerIpcHandler<[unknown], LocalMemoryConsolidationStatus>(
    IPC_CHANNELS.localMemoryConsolidate,
    async (_event, value) => consolidateLocalMemoryNow(scopeRequest(value)),
  );
  registerIpcHandler<[unknown], LocalMemoryRebuildResponse>(
    IPC_CHANNELS.localMemoryRebuild,
    async (_event, value) => rebuildLocalMemory(scopeRequest(value)),
  );
  registerIpcHandler<[unknown], LocalMemorySnapshotSummary[]>(
    IPC_CHANNELS.localMemoryListSnapshots,
    async (_event, value) =>
      localMemoryStore.listSnapshots(scopeRequest(value)),
  );
  registerIpcHandler<[unknown], LocalMemorySnapshotRestoreResponse>(
    IPC_CHANNELS.localMemoryRestoreSnapshot,
    async (_event, value) =>
      localMemoryStore.restoreSnapshot(
        scopeRequest(value),
        field(record(value), 'snapshotId'),
      ),
  );
  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.localMemoryWatch,
    (event, value): void => {
      const scope = scopeRequest(value);
      watchLocalMemoryScope(
        scope,
        localMemoryStore.resolve(scope).dir,
        event.sender,
      );
    },
  );
  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.localMemoryUnwatch,
    (event, value): void => {
      unwatchLocalMemoryScope(scopeRequest(value), event.sender.id);
    },
  );
}
