import {
  workEntryProjectDeletedError,
  workEntryRegistryRevision,
  WorkEntryRegistryRevisionConflictError,
  WorkEntryRowIncarnationConflictError,
  type WorkEntryRegistryFile,
  type WorkEntryRegistryRow,
} from './registry';

/*
 * The Work Entry registry repository (CAN-4476): one per-workspace queue, the
 * deletion fence and the atomic install every registry writer goes through.
 * It touches no filesystem itself; the host binds paths and file I/O as ports.
 */

export interface WorkEntryRegistryWriteOptions {
  groupMutation?: boolean;
  requireAuthoritativeRead?: boolean;
  sidebarItemGroupId?: string;
  newItemId?: string;
  assertCanCommit?: () => void;
  afterWrite?: () => Promise<void>;
}

export interface WorkEntryRegistryReconciliation<Row> {
  rows: Row[];
  beforeWrite?: () => Promise<void>;
  afterWrite?: () => Promise<void>;
  rollback?: () => Promise<void>;
}

export type WorkEntryRegistryReconciler<Row> = (
  workspaceId: string,
  entries: Row[],
  options?: WorkEntryRegistryWriteOptions,
) => Promise<WorkEntryRegistryReconciliation<Row>>;

export interface WorkEntryRegistryIo {
  /** The file's text, or null only when it does not exist. */
  readText(path: string): Promise<string | null>;
  /** False only when the file does not exist. */
  exists(path: string): Promise<boolean>;
  mkdirParent(path: string): Promise<void>;
  /** A fresh sibling temporary path for one install of `path`. */
  tempPath(path: string): string;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  rename(
    source: string,
    target: string,
    options: { beforeRetry: () => void },
  ): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface WorkEntryRegistryCodec<Row extends WorkEntryRegistryRow> {
  parse(text: string): WorkEntryRegistryFile<Row>;
  serialize(file: WorkEntryRegistryFile<Row>): string;
}

export interface WorkEntryRepositoryPorts<Row extends WorkEntryRegistryRow> {
  registryPath(workspaceId: string): string;
  io: WorkEntryRegistryIo;
  codec: WorkEntryRegistryCodec<Row>;
  /** Read at each write, so a reconciler installed later applies. */
  reconciler?(): WorkEntryRegistryReconciler<Row> | undefined;
  publishGroups?(workspaceId: string): void;
  onListChanged?(workspaceId: string): void;
  /** Runs before every install; throws to refuse the writer. */
  assertWriter(): void;
}

export interface WorkEntryRegistryTransaction<
  Row extends WorkEntryRegistryRow,
> {
  read(): Promise<WorkEntryRegistryFile<Row>>;
  write(
    file: WorkEntryRegistryFile<Row>,
    options?: WorkEntryRegistryWriteOptions,
  ): Promise<void>;
  assertAdmitted(): void;
  /** Signals the list once the queue settles: a registry change committed. */
  invalidateOnSettle(): void;
}

export interface WorkEntryRegistryRead<Row extends WorkEntryRegistryRow> {
  file: WorkEntryRegistryFile<Row>;
  revision: string;
}

export interface WorkEntryRevisionGuard {
  /** Refuse with a revision conflict unless the registry still matches. */
  expectedRevision?: string;
}

export interface WorkEntryRepository<Row extends WorkEntryRegistryRow> {
  readStrict(workspaceId: string): Promise<WorkEntryRegistryFile<Row>>;
  readIfPresent(
    workspaceId: string,
  ): Promise<WorkEntryRegistryFile<Row> | null>;
  exists(workspaceId: string): Promise<boolean>;
  rowState(
    workspaceId: string,
    entryId: string,
  ): Promise<'present' | 'absent' | 'missing-registry'>;
  readWithRevision(workspaceId: string): Promise<WorkEntryRegistryRead<Row>>;
  transact<T>(
    workspaceId: string,
    fn: (tx: WorkEntryRegistryTransaction<Row>) => Promise<T>,
    options?: WorkEntryRevisionGuard,
  ): Promise<T>;
  reorder(
    workspaceId: string,
    entryIds: readonly string[],
    options?: WorkEntryRevisionGuard,
  ): Promise<void>;
  /** Appends rows whose ids are new; true when any was appended. */
  appendRows(workspaceId: string, rows: readonly Row[]): Promise<boolean>;
  /**
   * Rewrites the registry whether or not the row exists. With
   * `expectedCreatedAt`, a row of another incarnation is kept and the call
   * rejects with a row incarnation conflict without writing.
   */
  removeRow(
    workspaceId: string,
    entryId: string,
    options?: { expectedCreatedAt?: string },
  ): Promise<void>;
  removeIfUnstarted(
    workspaceId: string,
    entryId: string,
    createdAt: string,
    options: { isEmpty: () => Promise<boolean>; onRemoved?: () => void },
  ): Promise<boolean>;
  /**
   * Installs bundle bytes unchanged once they parse; no reconciler or signal.
   * `beforeInstall` runs in the same queue slot, after the bytes parse and
   * before they are written; it throws to refuse the install.
   */
  installRaw(
    workspaceId: string,
    bytes: Uint8Array,
    options?: { beforeInstall?: () => Promise<void> },
  ): Promise<void>;
  /** Tombstones the workspace now; returns its queued writes' settlement, if any. */
  retire(workspaceId: string): Promise<unknown> | undefined;
  activate(workspaceId: string): void;
  isRetired(workspaceId: string): boolean;
}

export function createWorkEntryRepository<Row extends WorkEntryRegistryRow>(
  ports: WorkEntryRepositoryPorts<Row>,
): WorkEntryRepository<Row> {
  const { io, codec } = ports;
  const queues = new Map<string, Promise<unknown>>();
  const retired = new Set<string>();
  // Membership failure cannot hide a registry change that already committed.
  const failedWriteInvalidations = new Set<string>();

  const assertAdmitted = (workspaceId: string): void => {
    if (retired.has(workspaceId))
      throw workEntryProjectDeletedError(workspaceId);
  };

  async function readIfPresent(
    workspaceId: string,
  ): Promise<WorkEntryRegistryFile<Row> | null> {
    const text = await io.readText(ports.registryPath(workspaceId));
    return text === null ? null : codec.parse(text);
  }

  async function readStrict(
    workspaceId: string,
  ): Promise<WorkEntryRegistryFile<Row>> {
    return (await readIfPresent(workspaceId)) ?? { version: 1, entries: [] };
  }

  async function readWithRevision(
    workspaceId: string,
  ): Promise<WorkEntryRegistryRead<Row>> {
    const file = await readStrict(workspaceId);
    return { file, revision: workEntryRegistryRevision(file.entries) };
  }

  async function install(
    workspaceId: string,
    serialize: () => string | Uint8Array,
    reconciliation: WorkEntryRegistryReconciliation<Row> | undefined,
    assertCanCommit: (() => void) | undefined,
  ): Promise<void> {
    const path = ports.registryPath(workspaceId);
    const tempPath = io.tempPath(path);
    let installed = false;
    let prepared = false;
    try {
      await reconciliation?.beforeWrite?.();
      prepared = true;
      assertAdmitted(workspaceId);
      await io.mkdirParent(path);
      await io.writeFile(tempPath, serialize());
      const assertCanInstall = (): void => {
        assertAdmitted(workspaceId);
        assertCanCommit?.();
      };
      assertCanInstall();
      await io.rename(tempPath, path, { beforeRetry: assertCanInstall });
      installed = true;
      assertAdmitted(workspaceId);
    } catch (error) {
      if (prepared && reconciliation?.rollback) {
        try {
          await reconciliation.rollback();
        } catch (rollbackError) {
          throw Object.assign(
            new Error('Registry write and group rollback failed'),
            { errors: [error, rollbackError] },
          );
        }
      }
      throw error;
    } finally {
      if (!installed) await io.unlink(tempPath).catch(() => undefined);
    }
  }

  async function write(
    workspaceId: string,
    data: WorkEntryRegistryFile<Row>,
    options?: WorkEntryRegistryWriteOptions,
  ): Promise<void> {
    assertAdmitted(workspaceId);
    ports.assertWriter();
    const reconciler = ports.reconciler?.();
    if (options?.sidebarItemGroupId && !reconciler)
      throw new Error('Sidebar item group service is not initialized');
    const reconciliation = reconciler
      ? await reconciler(workspaceId, data.entries, options)
      : undefined;
    const file = reconciliation
      ? { ...data, entries: reconciliation.rows }
      : data;
    await install(
      workspaceId,
      () => codec.serialize(file),
      reconciliation,
      options?.assertCanCommit,
    );
    try {
      await reconciliation?.afterWrite?.();
      assertAdmitted(workspaceId);
      ports.publishGroups?.(workspaceId);
    } catch (error) {
      failedWriteInvalidations.add(workspaceId);
      throw error;
    }
  }

  function notifyListChanged(workspaceId: string): void {
    try {
      ports.onListChanged?.(workspaceId);
    } catch {
      // The list signal mirrors a durable write; it can never fail one.
    }
  }

  function transact<T>(
    workspaceId: string,
    fn: (tx: WorkEntryRegistryTransaction<Row>) => Promise<T>,
    options?: WorkEntryRevisionGuard,
  ): Promise<T> {
    if (retired.has(workspaceId))
      return Promise.reject(workEntryProjectDeletedError(workspaceId));
    const run = async (): Promise<T> => {
      let primed: WorkEntryRegistryFile<Row> | undefined;
      const expected = options?.expectedRevision;
      if (expected !== undefined) {
        // A project deleted while this waited reports deletion, not a conflict.
        assertAdmitted(workspaceId);
        const current = await readWithRevision(workspaceId);
        if (current.revision !== expected)
          throw new WorkEntryRegistryRevisionConflictError(
            expected,
            current.revision,
          );
        primed = current.file;
      }
      return fn({
        read: async () => {
          const file = primed ?? (await readStrict(workspaceId));
          primed = undefined;
          return file;
        },
        write: (file, writeOptions) => write(workspaceId, file, writeOptions),
        assertAdmitted: () => assertAdmitted(workspaceId),
        invalidateOnSettle: () => {
          failedWriteInvalidations.add(workspaceId);
        },
      });
    };
    const previous = queues.get(workspaceId) ?? Promise.resolve();
    const next = previous.then(run, run).finally(() => {
      if (
        failedWriteInvalidations.delete(workspaceId) &&
        !retired.has(workspaceId)
      ) {
        notifyListChanged(workspaceId);
      }
    });
    const settled = next
      .catch(() => undefined)
      .finally(() => {
        if (queues.get(workspaceId) === settled) queues.delete(workspaceId);
      });
    queues.set(workspaceId, settled);
    return next;
  }

  return {
    readStrict,
    readIfPresent,
    exists: (workspaceId) => io.exists(ports.registryPath(workspaceId)),
    async rowState(workspaceId, entryId) {
      const registry = await readIfPresent(workspaceId);
      if (!registry) return 'missing-registry';
      return registry.entries.some((entry) => entry.id === entryId)
        ? 'present'
        : 'absent';
    },
    readWithRevision,
    transact,
    reorder: (workspaceId, entryIds, options) =>
      transact(
        workspaceId,
        async (tx) => {
          const file = await tx.read();
          const entriesById = new Map(
            file.entries.map((entry) => [entry.id, entry]),
          );
          if (
            entryIds.length !== file.entries.length ||
            new Set(entryIds).size !== entryIds.length ||
            entryIds.some((entryId) => !entriesById.has(entryId))
          ) {
            throw new Error('Work entry reorder does not match entries');
          }
          await tx.write({
            version: 1,
            entries: entryIds.flatMap(
              (entryId) => entriesById.get(entryId) ?? [],
            ),
          });
        },
        options,
      ),
    appendRows: (workspaceId, rows) =>
      transact(workspaceId, async (tx) => {
        const file = await tx.read();
        const known = new Set(file.entries.map((entry) => entry.id));
        const additions = rows.filter((row) => {
          if (known.has(row.id)) return false;
          known.add(row.id);
          return true;
        });
        if (additions.length === 0) return false;
        await tx.write({
          version: 1,
          entries: [...file.entries, ...additions],
        });
        return true;
      }),
    removeRow: (workspaceId, entryId, options) =>
      transact(workspaceId, async (tx) => {
        const file = await tx.read();
        const expectedCreatedAt = options?.expectedCreatedAt;
        if (expectedCreatedAt !== undefined) {
          // A project deleted while this waited reports deletion, not a conflict.
          tx.assertAdmitted();
          const other = file.entries.find(
            (entry) =>
              entry.id === entryId && entry.createdAt !== expectedCreatedAt,
          );
          if (other)
            throw new WorkEntryRowIncarnationConflictError(
              entryId,
              expectedCreatedAt,
              other.createdAt,
            );
        }
        await tx.write({
          version: 1,
          entries: file.entries.filter((entry) => entry.id !== entryId),
        });
      }),
    removeIfUnstarted: (workspaceId, entryId, createdAt, options) =>
      transact(workspaceId, async (tx) => {
        const file = await tx.read();
        const row = file.entries.find((entry) => entry.id === entryId);
        if (!row || row.createdAt !== createdAt) return false;
        if (!(await options.isEmpty())) return false;
        await tx.write({
          ...file,
          entries: file.entries.filter((entry) => entry !== row),
        });
        options.onRemoved?.();
        return true;
      }),
    installRaw: (workspaceId, bytes, options) =>
      transact(workspaceId, async () => {
        // Decoded as readFile(path, 'utf8') does; the bytes install as given.
        codec.parse(
          new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes),
        );
        assertAdmitted(workspaceId);
        ports.assertWriter();
        await options?.beforeInstall?.();
        await install(workspaceId, () => bytes, undefined, undefined);
      }),
    retire(workspaceId) {
      retired.add(workspaceId);
      return queues.get(workspaceId);
    },
    activate: (workspaceId) => {
      retired.delete(workspaceId);
    },
    isRetired: (workspaceId) => retired.has(workspaceId),
  };
}
