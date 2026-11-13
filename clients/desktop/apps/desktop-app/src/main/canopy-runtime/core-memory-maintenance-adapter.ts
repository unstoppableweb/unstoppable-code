import { createHash } from 'node:crypto';
import { CanopyOperationError } from '@canopy/core-runtime';
import { KeyedOutcomes } from '@canopy/core-runtime/node/operations';
import type { MemoryTarget } from '@canopy/protocol/canopy-core';
import { isLocalMemoryWorkspaceId } from '@canopy/desktop-shared/lib/local-memory-scope';
import type {
  LocalMemoryConsolidationStatus,
  LocalMemoryImportResult,
  LocalMemoryRebuildResponse,
  LocalMemoryScopeRequest,
  LocalMemorySnapshotRestoreResponse,
  LocalMemorySnapshotSummary,
} from '@canopy/desktop-shared/types';
import type { LocalMemoryImportSource } from '../memory/local/import/import-job';
import type { MemoryReplacementFile } from '../memory/local/rebuild';
import type { DesktopDomainAdapter } from './desktop-runtime';

/** The owners Settings' memory section calls; tests inject them. */
export interface CoreMemoryMaintenanceHost {
  /** Whether the project is one this desktop lists. */
  workspaceExists(workspaceId: string): Promise<boolean>;
  /**
   * The files a restore or rebuild replaces; takes no lock, so it is also
   * read under the scope's write lock.
   */
  replaceableFiles(
    scope: LocalMemoryScopeRequest,
  ): Promise<MemoryReplacementFile[]>;
  listSnapshots(
    scope: LocalMemoryScopeRequest,
  ): Promise<LocalMemorySnapshotSummary[]>;
  consolidateNow(
    scope: LocalMemoryScopeRequest,
  ): Promise<LocalMemoryConsolidationStatus>;
  /**
   * `unchanged` runs under the scope's write lock before anything changes;
   * when it answers false nothing changes and the answer is `stale`.
   */
  rebuild(
    scope: LocalMemoryScopeRequest,
    unchanged: () => Promise<boolean>,
  ): Promise<LocalMemoryRebuildResponse | 'stale'>;
  restoreSnapshot(
    scope: LocalMemoryScopeRequest,
    snapshotId: string,
    unchanged: () => Promise<boolean>,
  ): Promise<LocalMemorySnapshotRestoreResponse | 'stale'>;
  importSources(workspaceId?: string): Promise<LocalMemoryImportSource[]>;
  /** Reads only `sourcePaths`, the files the caller confirmed. */
  importExternal(
    workspaceId: string | undefined,
    sourcePaths: readonly string[],
  ): Promise<LocalMemoryImportResult>;
}

const desktopMaintenanceHost: CoreMemoryMaintenanceHost = {
  workspaceExists: async (workspaceId) =>
    (
      await (await import('../lib/sidebar-items')).readAllSidebarItems()
    ).items.some((item) => item.id === workspaceId),
  replaceableFiles: async (scope) => {
    const [{ listMemoryReplacementFiles }, { localMemoryScopeDir }] =
      await Promise.all([
        import('../memory/local/rebuild'),
        import('../memory/local/scope-resolver'),
      ]);
    return listMemoryReplacementFiles(localMemoryScopeDir(scope));
  },
  listSnapshots: async (scope) =>
    (
      await import('../memory/local/memory-store')
    ).localMemoryStore.listSnapshots(scope),
  consolidateNow: async (scope) =>
    (await import('../ipc/local-memory')).consolidateLocalMemoryNow(scope),
  rebuild: async (scope, unchanged) => {
    const [{ rebuildLocalMemory }, { LocalMemoryPreconditionError }] =
      await Promise.all([
        import('../ipc/local-memory'),
        import('../memory/local/edit-coordination'),
      ]);
    try {
      return await rebuildLocalMemory(scope, async () => {
        if (!(await unchanged())) throw new LocalMemoryPreconditionError();
      });
    } catch (error) {
      if (error instanceof LocalMemoryPreconditionError) return 'stale';
      throw error;
    }
  },
  restoreSnapshot: async (scope, snapshotId, unchanged) => {
    const [{ localMemoryStore }, { LocalMemoryPreconditionError }] =
      await Promise.all([
        import('../memory/local/memory-store'),
        import('../memory/local/edit-coordination'),
      ]);
    try {
      return await localMemoryStore.restoreSnapshot(
        scope,
        snapshotId,
        async () => {
          if (!(await unchanged())) throw new LocalMemoryPreconditionError();
        },
      );
    } catch (error) {
      if (error instanceof LocalMemoryPreconditionError) return 'stale';
      throw error;
    }
  },
  importSources: async (workspaceId) =>
    (
      await import('../memory/local/import/import-job')
    ).listManualLocalMemoryImportSources(workspaceId),
  importExternal: async (workspaceId, sourcePaths) =>
    (
      await import('../memory/local/import/import-job')
    ).enqueueManualLocalMemoryImportBatch(workspaceId, new Set(sourcePaths)),
};

function tag(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 32);
}

/**
 * The scope's memory as a rebuild or restore would replace it: every file
 * either changes and when each last changed. Usage counts are not files, so a
 * read never changes it.
 */
async function memoryRevision(
  host: CoreMemoryMaintenanceHost,
  scope: LocalMemoryScopeRequest,
): Promise<string> {
  return tag(
    (await host.replaceableFiles(scope))
      .map((file) => [file.fileKey, file.modifiedAt, file.sizeBytes])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  );
}

/**
 * The importer's failures without host paths, which its messages carry: a
 * listed file by its label, anything else as one step, each with only its
 * system error code.
 */
function portableImportErrors(
  errors: readonly string[],
  sources: readonly LocalMemoryImportSource[],
): string[] {
  const portable = errors.map((error) => {
    const source = sources.find((entry) =>
      error.startsWith(`${entry.sourcePath}:`),
    );
    const code = /\b(E[A-Z]{2,})\b/.exec(error)?.[1];
    const reason = code === undefined ? '' : ` (${code})`;
    return source
      ? `${source.label} could not be imported${reason}.`
      : `A step of the import could not finish${reason}.`;
  });
  return [...new Set(portable)];
}

function sourcesDigest(sources: readonly LocalMemoryImportSource[]): string {
  return tag(sources.map((source) => source.sourcePath).sort());
}

function workspaceNotFound(workspaceId: string): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    message: `Project ${workspaceId} was not found.`,
    code: 'core.memory.workspace.notFound',
    retry: { kind: 'never' },
  });
}

async function knownWorkspace(
  host: CoreMemoryMaintenanceHost,
  workspaceId: string,
): Promise<string> {
  if (
    !isLocalMemoryWorkspaceId(workspaceId) ||
    !(await host.workspaceExists(workspaceId))
  )
    throw workspaceNotFound(workspaceId);
  return workspaceId;
}

async function scopeOf(
  host: CoreMemoryMaintenanceHost,
  target: MemoryTarget,
): Promise<LocalMemoryScopeRequest> {
  return target.scope === 'user'
    ? { scope: 'user' }
    : {
        scope: 'workspace',
        workspaceId: await knownWorkspace(host, target.workspaceId),
      };
}

const revisionConflict = (): CanopyOperationError =>
  new CanopyOperationError({
    kind: 'conflict',
    message:
      'This memory changed since it was read. List its snapshots again before replacing it.',
    code: 'core.memory.revisionConflict',
    retry: { kind: 'after_refresh', resource: 'core.memory.snapshot.list' },
  });

/** Whether the scope still holds the memory the caller read, checked under its lock. */
function unchangedSince(
  host: CoreMemoryMaintenanceHost,
  scope: LocalMemoryScopeRequest,
  expected: string,
): () => Promise<boolean> {
  return async () => (await memoryRevision(host, scope)) === expected;
}

type ConsolidationJson = Pick<
  LocalMemoryConsolidationStatus,
  | 'pendingNotes'
  | 'running'
  | 'lastRunAt'
  | 'lastResult'
  | 'lastReason'
  | 'lastConsolidatedAt'
>;

function consolidationJson(
  status: LocalMemoryConsolidationStatus,
): ConsolidationJson {
  return {
    pendingNotes: status.pendingNotes,
    running: status.running,
    lastRunAt: status.lastRunAt,
    lastResult: status.lastResult,
    lastReason: status.lastReason,
    lastConsolidatedAt: status.lastConsolidatedAt,
  };
}

const reused = (): CanopyOperationError =>
  new CanopyOperationError({
    kind: 'conflict',
    message: 'This idempotency key was used with other parameters.',
    retry: { kind: 'never' },
  });

/**
 * Consolidation, rebuild, snapshots and external import on the desktop
 * dispatcher (CAN-6005), over the owners Settings' memory section calls. A
 * rebuild or restore names the memory it replaces (`expectedRevision`), and
 * an import the exact files it reads (`expectedSourcesDigest`).
 */
export function createCoreMemoryMaintenanceAdapter(
  host: CoreMemoryMaintenanceHost = desktopMaintenanceHost,
): DesktopDomainAdapter {
  const runs = new KeyedOutcomes<ConsolidationJson>({
    reusedError: reused,
  });
  const rebuilds = new KeyedOutcomes<{
    status: 'completed' | 'stopped' | 'failed' | 'skipped';
    reason: string | null;
    snapshotId: string | null;
    restoredInboxNotes: number;
    restoredImports: number;
    runs: number;
    consolidation: ConsolidationJson;
  }>({ reusedError: reused });
  const restores = new KeyedOutcomes<{
    status: 'restored' | 'skipped';
    reason: string | null;
    previousSnapshotId: string | null;
  }>({ reusedError: reused });
  const imports = new KeyedOutcomes<LocalMemoryImportResult>({
    reusedError: reused,
  });
  return {
    queries: {
      'core.memory.snapshot.list': async (params) => {
        const scope = await scopeOf(host, params.target);
        const [revision, snapshots] = await Promise.all([
          memoryRevision(host, scope),
          host.listSnapshots(scope),
        ]);
        return {
          revision,
          snapshots: snapshots.map((snapshot) => ({
            snapshotId: snapshot.id,
            createdAt: snapshot.createdAt,
            reason: snapshot.reason,
            topicCount: snapshot.topicCount,
          })),
        };
      },
      'core.memory.import.sources.list': async (params) => {
        const workspaceId =
          params.workspaceId === undefined
            ? undefined
            : await knownWorkspace(host, params.workspaceId);
        const sources = await host.importSources(workspaceId);
        return {
          digest: sourcesDigest(sources),
          sources: sources.map(({ tool, label }) => ({ tool, label })),
        };
      },
    },
    instructions: {
      'core.memory.consolidation.run': (params, context) =>
        runs.run(context, params, async () =>
          consolidationJson(
            await host.consolidateNow(await scopeOf(host, params.target)),
          ),
        ),
      'core.memory.consolidation.rebuild': (params, context) =>
        rebuilds.run(context, params, async () => {
          const scope = await scopeOf(host, params.target);
          const rebuilt = await host.rebuild(
            scope,
            unchangedSince(host, scope, params.expectedRevision),
          );
          if (rebuilt === 'stale') throw revisionConflict();
          const { rebuild, status } = rebuilt;
          return {
            status: rebuild.status,
            reason: rebuild.reason ?? null,
            snapshotId: rebuild.snapshotId,
            restoredInboxNotes: rebuild.restoredInboxNotes,
            restoredImports: rebuild.restoredImports,
            runs: rebuild.runs,
            consolidation: consolidationJson(status),
          };
        }),
      'core.memory.snapshot.restore': (params, context) =>
        restores.run(context, params, async () => {
          const scope = await scopeOf(host, params.target);
          const restored = await host.restoreSnapshot(
            scope,
            params.snapshotId,
            unchangedSince(host, scope, params.expectedRevision),
          );
          if (restored === 'stale') throw revisionConflict();
          return {
            status: restored.status,
            reason: restored.reason ?? null,
            previousSnapshotId: restored.previousSnapshotId,
          };
        }),
      'core.memory.import.external': (params, context) =>
        imports.run(context, params, async () => {
          const workspaceId =
            params.workspaceId === undefined
              ? undefined
              : await knownWorkspace(host, params.workspaceId);
          const sources = await host.importSources(workspaceId);
          if (sourcesDigest(sources) !== params.expectedSourcesDigest)
            throw new CanopyOperationError({
              kind: 'conflict',
              message:
                'The memory files to import changed since they were listed. List them again first.',
              code: 'core.memory.import.sourcesChanged',
              retry: {
                kind: 'after_refresh',
                resource: 'core.memory.import.sources.list',
              },
            });
          // The queued job reads only these files, so one that appears while
          // it waits is never imported without a confirmation.
          const result = await host.importExternal(
            workspaceId,
            sources.map((source) => source.sourcePath),
          );
          return {
            disabled: result.disabled,
            staged: result.staged,
            skipped: result.skipped,
            deferred: result.deferred,
            errors: portableImportErrors(result.errors, sources),
          };
        }),
    },
  };
}
