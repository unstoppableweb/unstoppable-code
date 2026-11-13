import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join } from 'node:path';
import { StorageOutcomeUnknownError } from '@canopy/core-runtime/storage';
import {
  browserTaskScopeTuple,
  isBrowserTaskScope,
  isProfileId,
  isProfileRecord,
  isBrowserProfileSelection,
  type BrowserNamedProfileInput,
  type BrowserProfilePatch,
  type BrowserProfileSelection,
  type BrowserProfileRecord,
  type BrowserProfilePage,
  type BrowserTaskScope,
  type BrowserTaskSlot,
} from '@canopy/protocol/browser-profiles';
import {
  BrowserProfileError,
  validateProfilePatch,
} from '../../browser-profile-error';
import {
  createDirectoryDurably,
  syncDirectory,
  writeFileAtomically,
} from '@canopy/execution-engine/node/lib/atomic-file';
import {
  errorCode,
  isProfileJsonTemporary,
  readProfileJson,
  withProfileWriter,
} from './storage';

const RESULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PARTITION = /^persist:canopy-browser-[a-zA-Z0-9_%.-]+$/;
const HASH = /^[a-f0-9]{64}$/;
type Checkpoint = 'journal' | 'task' | 'catalog' | 'outcome';
export interface BrowserProfileRepositoryOptions {
  now?: () => number;
  checkpoint?: (stage: Checkpoint) => void | Promise<void>;
}
export interface BrowserProfileMaintenanceBinding {
  profileId: string;
  storageGeneration: number;
  metadataRevision: number;
  /** Set only by a main-owned scoped dispatch; omitted for trusted user commands. */
  actor?: { kind: 'agent'; scope: BrowserTaskScope; incarnationId: string };
}
interface StoredProfile {
  record: BrowserProfileRecord;
  partition: string;
  nativePath?: string;
}
export interface BrowserProfileCleanupJob {
  jobId: string;
  profileId: string;
  storageGeneration: number;
  partition: string;
  nativePath?: string;
  createdAt: number;
  status: 'pending' | 'complete';
  lastError?: string;
}
export interface BrowserProfileRetirement {
  operationId: string;
  scope: BrowserTaskScope;
  ownerCreatedAt: string;
  incarnationId: string;
  initiatorPid: number;
  state: 'prepared' | 'committed' | 'aborted';
  legacyPartition?: string;
  receipt?: {
    kind: 'owner_removed' | 'git_quarantine';
    ownerOperationId: string;
  };
}
interface Catalog {
  schemaVersion: 1;
  revision: number;
  profiles: Record<string, StoredProfile>;
  taskKeys: string[];
  retirements: Record<string, BrowserProfileRetirement>;
  jobs: Record<string, BrowserProfileCleanupJob>;
}
interface Outcome {
  schemaVersion: 1;
  digest: string;
  completedAt: number;
  result: unknown;
}
interface Transaction {
  schemaVersion: 1;
  expectedRevision: number;
  catalog: Catalog;
  task?: { key: string; slot: BrowserTaskSlot };
  operationId: string;
  outcome: Outcome;
}

function activeProfile(catalog: Catalog, profileId: string): StoredProfile {
  const stored = Object.prototype.hasOwnProperty.call(
    catalog.profiles,
    profileId,
  )
    ? catalog.profiles[profileId]
    : undefined;
  if (!stored || stored.record.lifecycle !== 'active')
    throw new BrowserProfileError(
      'profile_unavailable',
      'The selected browser profile is unavailable.',
    );
  return stored;
}

function invalidMetadata(): never {
  throw new BrowserProfileError(
    'recovery_required',
    'Browser profile metadata is unsupported or damaged. Original files were preserved.',
  );
}
function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function scopeKey(scope: BrowserTaskScope): string {
  return createHash('sha256')
    .update(browserTaskScopeTuple(scope))
    .digest('hex');
}
function emptyCatalog(): Catalog {
  return {
    schemaVersion: 1,
    revision: 0,
    profiles: {},
    taskKeys: [],
    retirements: {},
    jobs: {},
  };
}

function validateSlot(value: unknown): BrowserTaskSlot {
  if (
    !isProfileRecord(value) ||
    value.schemaVersion !== 1 ||
    !isBrowserTaskScope(value.scope) ||
    typeof value.ownerCreatedAt !== 'string' ||
    !value.ownerCreatedAt ||
    !isProfileId(value.incarnationId) ||
    !revision(value.metadataRevision) ||
    !revision(value.nextStorageGeneration) ||
    Number(value.nextStorageGeneration) < 1 ||
    !isBrowserProfileSelection(value.defaultSelection) ||
    typeof value.agentClearAllowed !== 'boolean' ||
    !['active', 'retirement_pending', 'retired'].includes(
      String(value.lifecycle),
    ) ||
    (value.legacyOwnershipResolved !== undefined &&
      typeof value.legacyOwnershipResolved !== 'boolean') ||
    (value.taskProfileId !== undefined && !isProfileId(value.taskProfileId)) ||
    (value.retirementOperationId !== undefined &&
      !isProfileId(value.retirementOperationId))
  )
    invalidMetadata();
  const lifecycle = value.lifecycle;
  if (
    lifecycle !== 'active' &&
    lifecycle !== 'retirement_pending' &&
    lifecycle !== 'retired'
  )
    invalidMetadata();
  return {
    schemaVersion: 1,
    scope: value.scope,
    ownerCreatedAt: value.ownerCreatedAt,
    incarnationId: value.incarnationId,
    metadataRevision: value.metadataRevision,
    defaultSelection: value.defaultSelection,
    ...(value.taskProfileId !== undefined
      ? { taskProfileId: value.taskProfileId }
      : {}),
    nextStorageGeneration: value.nextStorageGeneration,
    ...(value.legacyOwnershipResolved !== undefined
      ? { legacyOwnershipResolved: value.legacyOwnershipResolved }
      : {}),
    agentClearAllowed: value.agentClearAllowed,
    lifecycle,
    ...(value.retirementOperationId !== undefined
      ? { retirementOperationId: value.retirementOperationId }
      : {}),
  };
}

function assertCatalog(value: unknown): asserts value is Catalog {
  if (
    !isProfileRecord(value) ||
    value.schemaVersion !== 1 ||
    !revision(value.revision) ||
    !isProfileRecord(value.profiles) ||
    !isProfileRecord(value.retirements) ||
    !isProfileRecord(value.jobs) ||
    !Array.isArray(value.taskKeys) ||
    !value.taskKeys.every((key) => typeof key === 'string' && HASH.test(key)) ||
    new Set(value.taskKeys).size !== value.taskKeys.length
  )
    invalidMetadata();
  const claimedPartitions = new Set<string>();
  for (const [id, stored] of Object.entries(value.profiles)) {
    if (
      !isProfileId(id) ||
      !isProfileRecord(stored) ||
      typeof stored.partition !== 'string' ||
      !PARTITION.test(stored.partition) ||
      !isProfileRecord(stored.record)
    )
      invalidMetadata();
    if (claimedPartitions.has(stored.partition)) invalidMetadata();
    claimedPartitions.add(stored.partition);
    const r = stored.record;
    if (
      r.schemaVersion !== 1 ||
      r.profileId !== id ||
      !['task', 'named'].includes(String(r.kind)) ||
      !isProfileRecord(r.owner) ||
      typeof r.displayName !== 'string' ||
      r.displayName.length > 100 ||
      !revision(r.metadataRevision) ||
      !revision(r.storageGeneration) ||
      Number(r.storageGeneration) < 1 ||
      !revision(r.createdAt) ||
      !revision(r.updatedAt) ||
      !['active', 'retired', 'cleanup_pending', 'deleted'].includes(
        String(r.lifecycle),
      ) ||
      !isProfileRecord(r.agentPermissions) ||
      typeof r.agentPermissions.allowEnable !== 'boolean' ||
      typeof r.agentPermissions.allowClear !== 'boolean'
    )
      invalidMetadata();
    if (
      r.kind === 'task' &&
      (r.owner.kind !== 'task' ||
        !isBrowserTaskScope(r.owner.taskScope) ||
        !isProfileId(r.owner.taskIncarnationId) ||
        r.agentPermissions.allowEnable !== true)
    )
      invalidMetadata();
    if (
      r.kind === 'named' &&
      (r.owner.kind !== 'user' || !isProfileId(r.owner.localPrincipalId))
    )
      invalidMetadata();
  }
  for (const [id, entry] of Object.entries(value.retirements)) {
    if (
      !isProfileId(id) ||
      !isProfileRecord(entry) ||
      entry.operationId !== id ||
      !isBrowserTaskScope(entry.scope) ||
      typeof entry.ownerCreatedAt !== 'string' ||
      !isProfileId(entry.incarnationId) ||
      !Number.isSafeInteger(entry.initiatorPid) ||
      Number(entry.initiatorPid) < 1 ||
      (entry.legacyPartition !== undefined &&
        (typeof entry.legacyPartition !== 'string' ||
          !PARTITION.test(entry.legacyPartition))) ||
      !['prepared', 'committed', 'aborted'].includes(String(entry.state))
    )
      invalidMetadata();
  }
  for (const [id, job] of Object.entries(value.jobs)) {
    if (
      !isProfileId(id) ||
      !isProfileRecord(job) ||
      job.jobId !== id ||
      !isProfileId(job.profileId) ||
      !revision(job.storageGeneration) ||
      Number(job.storageGeneration) < 1 ||
      (job.nativePath !== undefined && typeof job.nativePath !== 'string') ||
      typeof job.partition !== 'string' ||
      !PARTITION.test(job.partition) ||
      !revision(job.createdAt) ||
      !['pending', 'complete'].includes(String(job.status))
    )
      invalidMetadata();
  }
}

function validateCatalog(value: unknown): Catalog {
  assertCatalog(value);
  return value;
}

/** Async, process-crash recoverable metadata. All methods serialize desktop/CLI writers. */
export class BrowserProfileRepository {
  constructor(
    readonly root: string,
    private readonly options: BrowserProfileRepositoryOptions = {},
  ) {}
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private async checkpoint(stage: Checkpoint): Promise<void> {
    await this.options.checkpoint?.(stage);
  }
  /**
   * Resolves once the file and every folder entry leading to it are durable.
   * A flush failing after the install rejects with StorageOutcomeUnknownError;
   * the journal stays, so recovery republishes the same decision.
   */
  private async publish(path: string, value: unknown): Promise<void> {
    const folder = dirname(path);
    // Created here first: createDirectoryDurably would use the default mode.
    await mkdir(folder, { recursive: true, mode: 0o700 });
    // The root is always `<data>/browser-profiles` (its storage-ownership row).
    await createDirectoryDurably(folder, { dataRoot: dirname(this.root) });
    await writeFileAtomically(path, `${JSON.stringify(value)}\n`, {
      durable: true,
      mode: 0o600,
      encoding: 'utf8',
    });
  }
  /** Only after the receipt: a journal that reappears replays as a no-op. */
  private async removeJournal(): Promise<void> {
    await rm(join(this.root, 'transaction.json'));
    try {
      await syncDirectory(this.root);
    } catch (error) {
      // The decision is durable; the removal is not until a later root flush.
      throw new StorageOutcomeUnknownError('directory_flush', error);
    }
  }
  private async catalog(): Promise<Catalog> {
    const value = await readProfileJson(join(this.root, 'catalog.json'));
    if (value !== undefined) return validateCatalog(value);
    await this.assertUnusedNamespace();
    return emptyCatalog();
  }
  private async assertUnusedNamespace(initial?: {
    operationId: string;
    taskKey?: string;
  }): Promise<void> {
    // An unrenamed temporary of the journal's own slot is an interrupted write,
    // not a published decision. Receipts follow the catalog, so none can be.
    for (const [directory, allowed, interruptible] of [
      ['operations', initial?.operationId, false],
      ['task-slots', initial?.taskKey, true],
    ] as const) {
      let names: string[];
      try {
        names = await readdir(join(this.root, directory));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        invalidMetadata();
      }
      const own = allowed === undefined ? undefined : `${allowed}.json`;
      if (
        names.some(
          (name) =>
            !own ||
            (name !== own &&
              !(interruptible && isProfileJsonTemporary(name, own))),
        )
      )
        invalidMetadata();
    }
  }
  private async validateRecoveryTasks(
    catalog: Catalog,
    task: Transaction['task'],
  ): Promise<void> {
    if (task && !catalog.taskKeys.includes(task.key)) invalidMetadata();
    const slots = new Map<string, BrowserTaskSlot>();
    for (const key of catalog.taskKeys) {
      const slot =
        task?.key === key
          ? task.slot
          : validateSlot(await readProfileJson(this.taskPath(key)));
      if (scopeKey(slot.scope) !== key) invalidMetadata();
      slots.set(key, slot);
      if (slot.taskProfileId) {
        const record = catalog.profiles[slot.taskProfileId]?.record;
        if (
          !record ||
          record.kind !== 'task' ||
          record.owner.kind !== 'task' ||
          scopeKey(record.owner.taskScope) !== key ||
          record.owner.taskIncarnationId !== slot.incarnationId ||
          record.storageGeneration >= slot.nextStorageGeneration ||
          record.agentPermissions.allowClear !== slot.agentClearAllowed ||
          (slot.lifecycle === 'retired'
            ? record.lifecycle !== 'cleanup_pending' &&
              record.lifecycle !== 'retired'
            : record.lifecycle !== 'active')
        )
          invalidMetadata();
      }
    }
    for (const { record } of Object.values(catalog.profiles)) {
      if (record.lifecycle !== 'active' || record.owner.kind !== 'task')
        continue;
      const slot = slots.get(scopeKey(record.owner.taskScope));
      if (
        !slot ||
        slot.taskProfileId !== record.profileId ||
        slot.lifecycle === 'retired'
      )
        invalidMetadata();
    }
  }
  private taskPath(key: string): string {
    if (!HASH.test(key)) invalidMetadata();
    return join(this.root, 'task-slots', `${key}.json`);
  }
  private operationPath(id: string): string {
    if (!isProfileId(id) || id.length > 200)
      throw new BrowserProfileError(
        'invalid_request',
        'Invalid profile operation ID.',
      );
    return join(this.root, 'operations', `${id}.json`);
  }
  private async readTask(
    scope: BrowserTaskScope,
    catalog: Catalog,
  ): Promise<BrowserTaskSlot | null> {
    const value = await readProfileJson(this.taskPath(scopeKey(scope)));
    if (value === undefined) {
      // A missing indexed sidecar is corruption, not a new original owner.
      if (catalog.taskKeys.includes(scopeKey(scope))) invalidMetadata();
      return null;
    }
    const slot = validateSlot(value);
    if (browserTaskScopeTuple(slot.scope) !== browserTaskScopeTuple(scope))
      invalidMetadata();
    return slot.legacyOwnershipResolved !== undefined
      ? slot
      : this.resolveLegacyOwnership(slot, catalog);
  }
  private resolveLegacyOwnership(
    slot: BrowserTaskSlot,
    catalog: Catalog,
  ): BrowserTaskSlot {
    // Old-format metadata-only slots predate the explicit marker. A committed
    // retirement for this scope proves that a later empty slot is a replacement,
    // never an original legacy owner. Aborted preparations do not consume it.
    slot.legacyOwnershipResolved ??=
      !!slot.taskProfileId ||
      slot.nextStorageGeneration > 1 ||
      slot.lifecycle === 'retired' ||
      Object.values(catalog.retirements).some(
        (entry) =>
          entry.state === 'committed' &&
          browserTaskScopeTuple(entry.scope) ===
            browserTaskScopeTuple(slot.scope),
      );
    return slot;
  }
  private async recover(): Promise<void> {
    const value = await readProfileJson(join(this.root, 'transaction.json'));
    if (value === undefined) return;
    if (
      !isProfileRecord(value) ||
      value.schemaVersion !== 1 ||
      !revision(value.expectedRevision) ||
      !isProfileId(value.operationId) ||
      value.operationId.length > 200 ||
      !isProfileRecord(value.outcome) ||
      value.outcome.schemaVersion !== 1 ||
      typeof value.outcome.digest !== 'string' ||
      !HASH.test(value.outcome.digest) ||
      !revision(value.outcome.completedAt) ||
      !('result' in value.outcome)
    )
      invalidMetadata();
    const outcomePath = this.operationPath(value.operationId);
    const catalog = validateCatalog(value.catalog);
    if (catalog.revision !== value.expectedRevision + 1) invalidMetadata();
    let task: Transaction['task'];
    if (value.task !== undefined) {
      if (!isProfileRecord(value.task) || typeof value.task.key !== 'string')
        invalidMetadata();
      const slot = validateSlot(value.task.slot);
      if (scopeKey(slot.scope) !== value.task.key) invalidMetadata();
      task = { key: value.task.key, slot };
    }
    const installed = await readProfileJson(join(this.root, 'catalog.json'));
    if (installed === undefined) {
      if (value.expectedRevision !== 0) invalidMetadata();
      // Initial recovery can itself have stopped after installing its sidecars.
      await this.assertUnusedNamespace({
        operationId: value.operationId,
        taskKey: task?.key,
      });
    } else {
      const current = validateCatalog(installed);
      if (
        current.revision !== value.expectedRevision &&
        (current.revision !== catalog.revision ||
          !isDeepStrictEqual(current, catalog))
      )
        invalidMetadata();
    }
    await this.validateRecoveryTasks(catalog, task);
    const outcome = await readProfileJson(outcomePath);
    if (outcome !== undefined && !isDeepStrictEqual(outcome, value.outcome))
      invalidMetadata();
    // The journal may be unflushed (a failed flush, a killed writer) or from an
    // earlier non-syncing writer; it must be durable before its decision is.
    await this.publish(join(this.root, 'transaction.json'), value);
    if (task) {
      await this.publish(this.taskPath(task.key), task.slot);
      await this.checkpoint('task');
    }
    await this.publish(join(this.root, 'catalog.json'), catalog);
    await this.checkpoint('catalog');
    await this.publish(outcomePath, value.outcome);
    await this.checkpoint('outcome');
    await this.removeJournal();
  }
  private async read<T>(
    action: (catalog: Catalog) => T | Promise<T>,
  ): Promise<T> {
    return withProfileWriter(this.root, async () => {
      await this.recover();
      return action(await this.catalog());
    });
  }
  private async mutate<T>(
    id: string,
    payload: unknown,
    scope: BrowserTaskScope | undefined,
    change: (
      catalog: Catalog,
      task: { slot: BrowserTaskSlot | null },
    ) => T | Promise<T>,
  ): Promise<T> {
    this.operationPath(id);
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized) > 65_536)
      throw new BrowserProfileError(
        'invalid_request',
        'Profile command exceeds 64 KiB.',
      );
    const digest = createHash('sha256').update(serialized).digest('hex');
    return withProfileWriter(this.root, async () => {
      await this.recover();
      const catalog = await this.catalog();
      const previous = await readProfileJson(this.operationPath(id));
      if (previous !== undefined) {
        if (
          !isProfileRecord(previous) ||
          previous.schemaVersion !== 1 ||
          typeof previous.digest !== 'string' ||
          !revision(previous.completedAt)
        )
          invalidMetadata();
        if (previous.digest !== digest)
          throw new BrowserProfileError(
            'operation_conflict',
            'The profile operation ID was already used with different input.',
          );
        if (this.now() - previous.completedAt > RESULT_RETENTION_MS) {
          if ('result' in previous)
            await this.publish(this.operationPath(id), {
              schemaVersion: 1,
              digest: previous.digest,
              completedAt: previous.completedAt,
            });
          throw new BrowserProfileError(
            'operation_expired',
            'This profile operation has expired. Refresh state before issuing a new request.',
          );
        }
        return structuredClone(previous.result) as T;
      }
      const expectedRevision = catalog.revision;
      const task = { slot: scope ? await this.readTask(scope, catalog) : null };
      const result = await change(catalog, task);
      catalog.revision += 1;
      if (scope && task.slot && !catalog.taskKeys.includes(scopeKey(scope)))
        catalog.taskKeys.push(scopeKey(scope));
      const transaction: Transaction = {
        schemaVersion: 1,
        expectedRevision,
        catalog,
        ...(scope && task.slot
          ? { task: { key: scopeKey(scope), slot: task.slot } }
          : {}),
        operationId: id,
        outcome: {
          schemaVersion: 1,
          digest,
          completedAt: this.now(),
          result: result ?? null,
        },
      };
      await this.publish(join(this.root, 'transaction.json'), transaction);
      await this.checkpoint('journal');
      if (transaction.task) {
        await this.publish(
          this.taskPath(transaction.task.key),
          transaction.task.slot,
        );
        await this.checkpoint('task');
      }
      await this.publish(join(this.root, 'catalog.json'), catalog);
      await this.checkpoint('catalog');
      await this.publish(this.operationPath(id), transaction.outcome);
      await this.checkpoint('outcome');
      await this.removeJournal();
      return structuredClone(result);
    });
  }

  /** Keep the permission check and the small binding commit serialized with user edits. */
  async withActiveBinding<T>(
    binding: {
      profileId: string;
      storageGeneration: number;
      scope: BrowserTaskScope;
      incarnationId: string;
      agentEnable?: boolean;
      agentClear?: boolean;
    },
    commit: () => Promise<T>,
  ): Promise<T> {
    return this.read(async (catalog) => {
      const record = activeProfile(catalog, binding.profileId).record;
      const slot = await this.readTask(binding.scope, catalog);
      if (
        !slot ||
        slot.lifecycle !== 'active' ||
        slot.incarnationId !== binding.incarnationId
      )
        throw new BrowserProfileError(
          'scope_retired',
          'The browser task is no longer active.',
        );
      if (record.storageGeneration !== binding.storageGeneration)
        throw new BrowserProfileError(
          'profile_unavailable',
          'The profile storage generation changed.',
        );
      if (
        record.owner.kind === 'task' &&
        (record.owner.taskIncarnationId !== slot.incarnationId ||
          browserTaskScopeTuple(record.owner.taskScope) !==
            browserTaskScopeTuple(binding.scope))
      )
        throw new BrowserProfileError(
          'scope_unresolved',
          'This profile belongs to another task.',
        );
      if (binding.agentEnable && !record.agentPermissions.allowEnable)
        throw new BrowserProfileError(
          'agent_enable_denied',
          'This profile does not allow agents to open new tabs.',
        );
      if (binding.agentClear && !record.agentPermissions.allowClear)
        throw new BrowserProfileError(
          'agent_clear_denied',
          'This profile does not allow agents to clear its data.',
        );
      return commit();
    });
  }

  private async validateMaintenanceBinding(
    catalog: Catalog,
    request: BrowserProfileMaintenanceBinding,
  ): Promise<StoredProfile> {
    if (
      !isProfileId(request.profileId) ||
      !revision(request.storageGeneration) ||
      request.storageGeneration < 1 ||
      !revision(request.metadataRevision) ||
      (request.actor &&
        (request.actor.kind !== 'agent' ||
          !isBrowserTaskScope(request.actor.scope) ||
          !isProfileId(request.actor.incarnationId)))
    )
      throw new BrowserProfileError(
        'invalid_request',
        'Invalid profile maintenance request.',
      );
    const stored = activeProfile(catalog, request.profileId);
    const record = stored.record;
    if (record.storageGeneration !== request.storageGeneration)
      throw new BrowserProfileError(
        'profile_unavailable',
        'The profile storage generation changed.',
      );
    if (record.metadataRevision !== request.metadataRevision)
      throw new BrowserProfileError(
        'stale_revision',
        'Profile settings changed. Request a new preview.',
      );
    let task: BrowserTaskSlot | null = null;
    if (record.owner.kind === 'task') {
      task = await this.readTask(record.owner.taskScope, catalog);
      if (
        !task ||
        task.lifecycle !== 'active' ||
        task.incarnationId !== record.owner.taskIncarnationId
      )
        throw new BrowserProfileError(
          'scope_retired',
          'The browser task is unavailable.',
        );
    }
    if (request.actor) {
      const actorTask = await this.readTask(request.actor.scope, catalog);
      if (
        !actorTask ||
        actorTask.lifecycle !== 'active' ||
        actorTask.incarnationId !== request.actor.incarnationId
      )
        throw new BrowserProfileError(
          'scope_retired',
          'The originating browser task is unavailable.',
        );
      if (
        record.owner.kind === 'task' &&
        (record.owner.taskIncarnationId !== request.actor.incarnationId ||
          browserTaskScopeTuple(record.owner.taskScope) !==
            browserTaskScopeTuple(request.actor.scope))
      )
        throw new BrowserProfileError(
          'scope_unresolved',
          'This profile belongs to another task.',
        );
      if (!(task ? task.agentClearAllowed : record.agentPermissions.allowClear))
        throw new BrowserProfileError(
          'agent_clear_denied',
          'This profile does not allow agents to clear its data.',
        );
    }
    return stored;
  }

  /** Native clear starts inside this short writer boundary; await its completion outside it. */
  async withActiveProfile<T>(
    request: BrowserProfileMaintenanceBinding,
    commit: () => Promise<T>,
  ): Promise<T> {
    return this.read(async (catalog) => {
      await this.validateMaintenanceBinding(catalog, request);
      return commit();
    });
  }

  /** User measurement publication; permissions may change without invalidating a storage generation. */
  async withActiveGeneration<T>(
    profileId: string,
    generation: number,
    commit: () => Promise<T>,
  ): Promise<T> {
    return this.read(async (catalog) => {
      const stored = activeProfile(catalog, profileId);
      await this.validateMaintenanceBinding(catalog, {
        profileId,
        storageGeneration: generation,
        metadataRevision: stored.record.metadataRevision,
      });
      return commit();
    });
  }

  async resetProfile(
    operationId: string,
    request: BrowserProfileMaintenanceBinding,
    options: {
      beforeCommit?: () => Promise<void>;
      authorizedRecovery?: true;
    } = {},
  ): Promise<{ profile: BrowserProfileRecord; cleanupJobId: string }> {
    const original = await this.get(request.profileId);
    const scope =
      original.owner.kind === 'task' ? original.owner.taskScope : undefined;
    const payload = [
      'resetProfile',
      request.profileId,
      request.storageGeneration,
      request.metadataRevision,
      request.actor
        ? [
            browserTaskScopeTuple(request.actor.scope),
            request.actor.incarnationId,
          ]
        : null,
    ];
    return this.mutate(operationId, payload, scope, async (catalog, task) => {
      const current = activeProfile(catalog, request.profileId);
      const stored = await this.validateMaintenanceBinding(
        catalog,
        options.authorizedRecovery
          ? {
              ...request,
              metadataRevision: current.record.metadataRevision,
              actor: undefined,
            }
          : request,
      );
      await options.beforeCommit?.();
      const previousGeneration = stored.record.storageGeneration;
      const generation = Math.max(
        previousGeneration + 1,
        task.slot?.nextStorageGeneration ?? 1,
      );
      if (!Number.isSafeInteger(generation + 1))
        throw new BrowserProfileError(
          'storage_unavailable',
          'The profile generation limit was reached.',
        );
      const cleanupJobId = randomUUID();
      catalog.jobs[cleanupJobId] = {
        jobId: cleanupJobId,
        profileId: request.profileId,
        storageGeneration: previousGeneration,
        partition: stored.partition,
        ...(stored.nativePath ? { nativePath: stored.nativePath } : {}),
        createdAt: this.now(),
        status: 'pending',
      };
      stored.partition = `persist:canopy-browser-profile-${request.profileId}-g${generation}`;
      delete stored.nativePath;
      stored.record.storageGeneration = generation;
      stored.record.metadataRevision++;
      stored.record.updatedAt = this.now();
      if (task.slot) {
        task.slot.nextStorageGeneration = generation + 1;
        task.slot.metadataRevision++;
        stored.record.agentPermissions = {
          allowEnable: true,
          allowClear: task.slot.agentClearAllowed,
        };
      }
      return { profile: stored.record, cleanupJobId };
    });
  }

  async listPage(
    offset = 0,
    scope?: BrowserTaskScope,
  ): Promise<BrowserProfilePage> {
    if (!revision(offset))
      throw new BrowserProfileError('invalid_request', 'Invalid profile page.');
    return this.read((catalog) => {
      const records = Object.values(catalog.profiles)
        .map((value) => value.record)
        .filter(
          (record) =>
            record.lifecycle === 'active' &&
            (!scope ||
              record.owner.kind === 'user' ||
              (record.owner.kind === 'task' &&
                browserTaskScopeTuple(record.owner.taskScope) ===
                  browserTaskScopeTuple(scope))),
        );
      return structuredClone({
        profiles: records.slice(offset, offset + 100),
        ...(offset + 100 < records.length ? { nextOffset: offset + 100 } : {}),
      });
    });
  }

  async list(offset = 0, limit = 100): Promise<BrowserProfileRecord[]> {
    if (
      !revision(offset) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new BrowserProfileError('invalid_request', 'Invalid profile page.');
    return this.read((catalog) => {
      const records = Object.values(catalog.profiles)
        .map((entry) => entry.record)
        .filter((record) => record.lifecycle === 'active')
        .slice(offset, offset + limit);
      return structuredClone(records);
    });
  }
  async getTask(scope: BrowserTaskScope): Promise<BrowserTaskSlot | null> {
    return this.read((catalog) => this.readTask(scope, catalog));
  }
  async listTaskSlots(): Promise<BrowserTaskSlot[]> {
    return this.read(async (catalog) => {
      const slots: BrowserTaskSlot[] = [];
      for (const key of catalog.taskKeys) {
        const slot = validateSlot(await readProfileJson(this.taskPath(key)));
        if (scopeKey(slot.scope) !== key) invalidMetadata();
        slots.push(this.resolveLegacyOwnership(slot, catalog));
      }
      return slots;
    });
  }
  async recordNativePath(
    profileId: string,
    generation: number,
    nativePath: string,
  ): Promise<void> {
    await this.mutate(
      randomUUID(),
      ['nativePath', profileId, generation, nativePath],
      undefined,
      (catalog) => {
        const stored = activeProfile(catalog, profileId);
        if (
          !stored ||
          stored.record.storageGeneration !== generation ||
          stored.record.lifecycle !== 'active'
        )
          throw new BrowserProfileError(
            'profile_unavailable',
            'Browser storage generation is no longer active.',
          );
        if (stored.nativePath && stored.nativePath !== nativePath)
          throw new BrowserProfileError(
            'recovery_required',
            'Browser native storage moved unexpectedly.',
          );
        stored.nativePath = nativePath;
        return null;
      },
    );
  }
  /** Internal recovery evidence; never resolves a retired identity for browser use. */
  async retirementStatus(
    profileId: string,
    generation: number,
  ): Promise<{ retired: boolean; cleanupPending: boolean }> {
    if (!isProfileId(profileId) || !revision(generation) || generation < 1)
      throw new BrowserProfileError(
        'invalid_request',
        'Invalid retired profile generation.',
      );
    return this.read((catalog) => {
      const stored = catalog.profiles[profileId];
      if (!stored || generation > stored.record.storageGeneration)
        throw new BrowserProfileError(
          'profile_unavailable',
          'The profile generation is unavailable.',
        );
      return {
        retired: stored.record.lifecycle !== 'active',
        cleanupPending: Object.values(catalog.jobs).some(
          (job) => job.profileId === profileId && job.status !== 'complete',
        ),
      };
    });
  }
  async get(profileId: string): Promise<BrowserProfileRecord> {
    return this.read((catalog) => {
      const stored = activeProfile(catalog, profileId);
      if (!stored || stored.record.lifecycle !== 'active')
        throw new BrowserProfileError(
          'profile_unavailable',
          'The selected browser profile is unavailable.',
        );
      return structuredClone(stored.record);
    });
  }
  async getNativePartition(
    profileId: string,
    generation: number,
  ): Promise<string> {
    return this.read((catalog) => {
      const stored = activeProfile(catalog, profileId);
      if (
        !stored ||
        stored.record.lifecycle !== 'active' ||
        stored.record.storageGeneration !== generation
      )
        throw new BrowserProfileError(
          'profile_unavailable',
          'The selected browser profile generation is unavailable.',
        );
      return stored.partition;
    });
  }
  private newSlot(
    scope: BrowserTaskScope,
    ownerCreatedAt: string,
    legacyOwnershipResolved = false,
  ): BrowserTaskSlot {
    return {
      schemaVersion: 1,
      scope,
      ownerCreatedAt,
      incarnationId: randomUUID(),
      metadataRevision: 0,
      defaultSelection: { kind: 'task' },
      nextStorageGeneration: 1,
      legacyOwnershipResolved,
      agentClearAllowed: false,
      lifecycle: 'active',
    };
  }
  async ensureTask(
    scope: BrowserTaskScope,
    ownerCreatedAt: string,
    operationId: string,
    legacyPartition?: string,
  ): Promise<BrowserProfileRecord> {
    browserTaskScopeTuple(scope);
    if (
      !ownerCreatedAt ||
      ownerCreatedAt.length > 100 ||
      (legacyPartition !== undefined && !PARTITION.test(legacyPartition))
    )
      throw new BrowserProfileError(
        'invalid_request',
        'Invalid browser profile owner or legacy partition.',
      );
    return this.mutate(
      operationId,
      ['ensureTask', scope, ownerCreatedAt, legacyPartition],
      scope,
      (catalog, task) => {
        if (
          task.slot &&
          task.slot.ownerCreatedAt !== ownerCreatedAt &&
          task.slot.lifecycle !== 'retired'
        )
          throw new BrowserProfileError(
            'recovery_required',
            'The task identity changed before its browser profile was retired.',
          );
        if (
          !task.slot ||
          (task.slot.lifecycle === 'retired' &&
            task.slot.ownerCreatedAt !== ownerCreatedAt)
        )
          task.slot = this.newSlot(scope, ownerCreatedAt, task.slot !== null);
        if (task.slot.lifecycle !== 'active')
          throw new BrowserProfileError(
            'scope_retired',
            'The browser task is being retired or has been retired.',
          );
        if (task.slot.taskProfileId) {
          const stored = catalog.profiles[task.slot.taskProfileId];
          if (!stored || stored.record.lifecycle !== 'active')
            invalidMetadata();
          return stored.record;
        }
        const profileId = randomUUID();
        const generation = task.slot.nextStorageGeneration++;
        const partition =
          (!task.slot.legacyOwnershipResolved ? legacyPartition : undefined) ??
          `persist:canopy-browser-profile-${profileId}-g${generation}`;
        if (
          Object.values(catalog.profiles).some(
            (stored) => stored.partition === partition,
          )
        )
          throw new BrowserProfileError(
            'recovery_required',
            'The legacy browser partition is already owned by another profile.',
          );
        const record: BrowserProfileRecord = {
          schemaVersion: 1,
          profileId,
          kind: 'task',
          owner: {
            kind: 'task',
            taskScope: scope,
            taskIncarnationId: task.slot.incarnationId,
          },
          displayName: 'Task',
          metadataRevision: 1,
          agentPermissions: {
            allowEnable: true,
            allowClear: task.slot.agentClearAllowed,
          },
          lifecycle: 'active',
          storageGeneration: generation,
          createdAt: this.now(),
          updatedAt: this.now(),
        };
        catalog.profiles[profileId] = { record, partition };
        task.slot.taskProfileId = profileId;
        task.slot.legacyOwnershipResolved = true;
        task.slot.metadataRevision += 1;
        return record;
      },
    );
  }

  async ensureSlot(
    scope: BrowserTaskScope,
    ownerCreatedAt: string,
    operationId: string,
  ): Promise<BrowserTaskSlot> {
    browserTaskScopeTuple(scope);
    if (
      typeof ownerCreatedAt !== 'string' ||
      !ownerCreatedAt ||
      ownerCreatedAt.length > 100
    )
      throw new BrowserProfileError(
        'invalid_request',
        'Invalid browser task owner.',
      );
    return this.mutate(
      operationId,
      ['ensureSlot', scope, ownerCreatedAt],
      scope,
      (_catalog, task) => {
        if (
          task.slot &&
          task.slot.ownerCreatedAt !== ownerCreatedAt &&
          task.slot.lifecycle !== 'retired'
        )
          throw new BrowserProfileError(
            'recovery_required',
            'The previous browser task incarnation requires retirement.',
          );
        if (
          !task.slot ||
          (task.slot.lifecycle === 'retired' &&
            task.slot.ownerCreatedAt !== ownerCreatedAt)
        )
          task.slot = this.newSlot(scope, ownerCreatedAt, task.slot !== null);
        if (task.slot.lifecycle !== 'active')
          throw new BrowserProfileError(
            'scope_retired',
            'The browser task is unavailable.',
          );
        return task.slot;
      },
    );
  }

  async createNamed(
    operationId: string,
    input: BrowserNamedProfileInput,
  ): Promise<BrowserProfileRecord> {
    validateProfilePatch(input);
    if (typeof input.displayName !== 'string' || !input.displayName.trim())
      throw new BrowserProfileError('invalid_request', 'Enter a profile name.');
    return this.mutate(
      operationId,
      ['createNamed', input],
      undefined,
      (catalog) => {
        const profileId = randomUUID();
        const record: BrowserProfileRecord = {
          schemaVersion: 1,
          profileId,
          kind: 'named',
          owner: { kind: 'user', localPrincipalId: 'local-user' },
          displayName: input.displayName.trim(),
          ...(input.color !== undefined ? { color: input.color } : {}),
          metadataRevision: 1,
          storageGeneration: 1,
          lifecycle: 'active',
          agentPermissions: {
            allowEnable: input.allowEnable ?? false,
            allowClear: input.allowClear ?? false,
          },
          createdAt: this.now(),
          updatedAt: this.now(),
        };
        catalog.profiles[profileId] = {
          record,
          partition: `persist:canopy-browser-profile-${profileId}-g1`,
        };
        return record;
      },
    );
  }

  async updateProfile(
    operationId: string,
    profileId: string,
    expectedMetadataRevision: number,
    patch: BrowserProfilePatch,
  ): Promise<BrowserProfileRecord> {
    validateProfilePatch(patch);
    if (!revision(expectedMetadataRevision))
      throw new BrowserProfileError(
        'invalid_request',
        'A current profile revision is required.',
      );
    const original = await this.get(profileId);
    const scope =
      original.owner.kind === 'task' ? original.owner.taskScope : undefined;
    return this.mutate(
      operationId,
      ['updateProfile', profileId, expectedMetadataRevision, patch],
      scope,
      (catalog, task) => {
        const record = activeProfile(catalog, profileId).record;
        if (record.metadataRevision !== expectedMetadataRevision)
          throw new BrowserProfileError(
            'stale_revision',
            'Profile settings changed. Refresh before saving.',
          );
        if (record.owner.kind === 'task') {
          if (
            patch.allowEnable === false ||
            patch.displayName !== undefined ||
            patch.color !== undefined
          )
            throw new BrowserProfileError(
              'invalid_request',
              'Task profiles always allow agent enablement; only their clear permission can be changed.',
            );
          if (
            !task.slot ||
            task.slot.lifecycle !== 'active' ||
            task.slot.incarnationId !== record.owner.taskIncarnationId
          )
            throw new BrowserProfileError(
              'scope_retired',
              'The browser task is unavailable.',
            );
          if (patch.allowClear !== undefined)
            task.slot.agentClearAllowed = patch.allowClear;
          task.slot.metadataRevision += 1;
          record.agentPermissions = {
            allowEnable: true,
            allowClear: task.slot.agentClearAllowed,
          };
        } else {
          if (patch.displayName !== undefined)
            record.displayName = patch.displayName.trim();
          if (patch.color !== undefined) record.color = patch.color;
          if (patch.allowEnable !== undefined)
            record.agentPermissions.allowEnable = patch.allowEnable;
          if (patch.allowClear !== undefined)
            record.agentPermissions.allowClear = patch.allowClear;
        }
        record.metadataRevision += 1;
        record.updatedAt = this.now();
        return record;
      },
    );
  }

  async setDefault(
    operationId: string,
    scope: BrowserTaskScope,
    incarnationId: string,
    expectedMetadataRevision: number,
    selection: BrowserProfileSelection,
  ): Promise<BrowserTaskSlot> {
    if (
      !isBrowserProfileSelection(selection) ||
      !revision(expectedMetadataRevision) ||
      !isProfileId(incarnationId)
    )
      throw new BrowserProfileError(
        'invalid_request',
        'Invalid browser default request.',
      );
    return this.mutate(
      operationId,
      ['setDefault', scope, incarnationId, expectedMetadataRevision, selection],
      scope,
      (catalog, task) => {
        if (
          !task.slot ||
          task.slot.lifecycle !== 'active' ||
          task.slot.incarnationId !== incarnationId
        )
          throw new BrowserProfileError(
            'scope_retired',
            'The browser task incarnation changed.',
          );
        if (task.slot.metadataRevision !== expectedMetadataRevision)
          throw new BrowserProfileError(
            'stale_revision',
            'The task default changed. Refresh before saving.',
          );
        if (
          selection.kind === 'named' &&
          activeProfile(catalog, selection.profileId).record.kind !== 'named'
        )
          throw new BrowserProfileError(
            'invalid_request',
            'Choose a named profile or this Task profile.',
          );
        task.slot.defaultSelection = selection;
        task.slot.metadataRevision += 1;
        return task.slot;
      },
    );
  }

  async deleteNamed(
    operationId: string,
    profileId: string,
    expectedMetadataRevision: number,
  ): Promise<void> {
    if (!revision(expectedMetadataRevision))
      throw new BrowserProfileError(
        'invalid_request',
        'A current profile revision is required.',
      );
    await this.mutate(
      operationId,
      ['deleteNamed', profileId, expectedMetadataRevision],
      undefined,
      (catalog) => {
        const stored = activeProfile(catalog, profileId);
        if (stored.record.kind !== 'named')
          throw new BrowserProfileError(
            'invalid_request',
            'Task profiles retire with their owning task.',
          );
        if (stored.record.metadataRevision !== expectedMetadataRevision)
          throw new BrowserProfileError(
            'stale_revision',
            'Profile settings changed. Request a new deletion preview.',
          );
        stored.record.lifecycle = 'deleted';
        stored.record.metadataRevision += 1;
        stored.record.updatedAt = this.now();
        const jobId = randomUUID();
        catalog.jobs[jobId] = {
          jobId,
          profileId,
          storageGeneration: stored.record.storageGeneration,
          partition: stored.partition,
          ...(stored.nativePath ? { nativePath: stored.nativePath } : {}),
          createdAt: this.now(),
          status: 'pending',
        };
        return null;
      },
    );
  }

  async prepareRetirement(
    scope: BrowserTaskScope,
    ownerCreatedAt: string,
    operationId: string,
    legacyPartition?: string,
  ): Promise<BrowserProfileRetirement> {
    if (
      !isProfileId(operationId) ||
      operationId.length > 128 ||
      typeof ownerCreatedAt !== 'string' ||
      !ownerCreatedAt ||
      ownerCreatedAt.length > 100
    ) {
      throw new BrowserProfileError(
        'invalid_request',
        'Invalid browser retirement identity.',
      );
    }
    if (legacyPartition !== undefined && !PARTITION.test(legacyPartition))
      throw new BrowserProfileError(
        'invalid_request',
        'Invalid legacy browser partition.',
      );
    return this.mutate(
      operationId,
      ['prepareRetirement', scope, ownerCreatedAt, legacyPartition],
      scope,
      (catalog, task) => {
        task.slot ??= this.newSlot(scope, ownerCreatedAt);
        if (
          task.slot.ownerCreatedAt !== ownerCreatedAt ||
          task.slot.lifecycle !== 'active'
        )
          throw new BrowserProfileError(
            'scope_retired',
            'Browser retirement does not match the active task incarnation.',
          );
        task.slot.lifecycle = 'retirement_pending';
        task.slot.retirementOperationId = operationId;
        task.slot.metadataRevision += 1;
        const retirement: BrowserProfileRetirement = {
          operationId,
          scope,
          ownerCreatedAt,
          incarnationId: task.slot.incarnationId,
          initiatorPid: process.pid,
          state: 'prepared',
          ...(!task.slot.legacyOwnershipResolved && legacyPartition
            ? { legacyPartition }
            : {}),
        };
        catalog.retirements[operationId] = retirement;
        return retirement;
      },
    );
  }
  async getRetirements(): Promise<BrowserProfileRetirement[]> {
    return this.read((catalog) =>
      Object.values(catalog.retirements).filter(
        (entry) => entry.state === 'prepared',
      ),
    );
  }
  async abortRetirement(id: string): Promise<void> {
    const entry = await this.read((catalog) => catalog.retirements[id]);
    if (!entry)
      throw new BrowserProfileError(
        'invalid_request',
        'Unknown browser retirement.',
      );
    await this.mutate(
      `${id}-abort`,
      ['abortRetirement', id],
      entry.scope,
      (catalog, task) => {
        const current = catalog.retirements[id];
        if (current.state === 'committed')
          throw new BrowserProfileError(
            'scope_retired',
            'Committed browser retirement cannot be undone.',
          );
        if (task.slot?.incarnationId !== current.incarnationId)
          invalidMetadata();
        current.state = 'aborted';
        task.slot.lifecycle = 'active';
        delete task.slot.retirementOperationId;
        task.slot.metadataRevision += 1;
        return null;
      },
    );
  }
  async commitRetirement(
    id: string,
    receipt: NonNullable<BrowserProfileRetirement['receipt']>,
  ): Promise<void> {
    const entry = await this.read((catalog) => catalog.retirements[id]);
    if (
      !entry ||
      !isProfileId(receipt.ownerOperationId) ||
      !['owner_removed', 'git_quarantine'].includes(receipt.kind)
    )
      throw new BrowserProfileError(
        'invalid_request',
        'Browser retirement requires an owner commit receipt.',
      );
    await this.mutate(
      `${id}-commit`,
      ['commitRetirement', id, receipt],
      entry.scope,
      (catalog, task) => {
        const current = catalog.retirements[id];
        if (
          current.state === 'aborted' ||
          task.slot?.incarnationId !== current.incarnationId
        )
          throw new BrowserProfileError(
            'scope_retired',
            'Browser retirement no longer matches this task.',
          );
        current.state = 'committed';
        current.receipt = receipt;
        task.slot.lifecycle = 'retired';
        task.slot.legacyOwnershipResolved = true;
        task.slot.metadataRevision += 1;
        if (task.slot.taskProfileId) {
          const stored = catalog.profiles[task.slot.taskProfileId];
          if (!stored) invalidMetadata();
          stored.record.lifecycle = 'cleanup_pending';
          stored.record.metadataRevision += 1;
          const jobId = randomUUID();
          catalog.jobs[jobId] = {
            jobId,
            profileId: stored.record.profileId,
            storageGeneration: stored.record.storageGeneration,
            partition: stored.partition,
            ...(stored.nativePath ? { nativePath: stored.nativePath } : {}),
            createdAt: this.now(),
            status: 'pending',
          };
        } else if (current.legacyPartition) {
          const jobId = randomUUID();
          catalog.jobs[jobId] = {
            jobId,
            profileId: `legacy-${scopeKey(current.scope)}`,
            storageGeneration: 1,
            partition: current.legacyPartition,
            createdAt: this.now(),
            status: 'pending',
          };
        }
        return null;
      },
    );
  }
  async getCleanupJobs(): Promise<BrowserProfileCleanupJob[]> {
    return this.read((catalog) =>
      Object.values(catalog.jobs).filter((job) => job.status === 'pending'),
    );
  }
  async assertCleanupSafe(job: BrowserProfileCleanupJob): Promise<void> {
    await this.read((catalog) => {
      const current = catalog.jobs[job.jobId];
      if (
        !current ||
        current.status !== 'pending' ||
        current.profileId !== job.profileId ||
        current.storageGeneration !== job.storageGeneration ||
        current.partition !== job.partition
      )
        invalidMetadata();
      if (
        Object.values(catalog.profiles).some(
          (stored) =>
            stored.record.lifecycle === 'active' &&
            stored.partition === job.partition,
        )
      )
        throw new BrowserProfileError(
          'recovery_required',
          'Browser cleanup targets storage owned by an active profile.',
        );
    });
  }
  async completeCleanup(jobId: string): Promise<void> {
    await this.mutate(
      `${jobId}-complete`,
      ['completeCleanup', jobId],
      undefined,
      (catalog) => {
        const job = catalog.jobs[jobId];
        if (!job)
          throw new BrowserProfileError(
            'invalid_request',
            'Unknown browser cleanup job.',
          );
        job.status = 'complete';
        const record = catalog.profiles[job.profileId]?.record;
        if (
          record?.storageGeneration === job.storageGeneration &&
          record.lifecycle === 'cleanup_pending'
        )
          record.lifecycle = 'retired';
        return null;
      },
    );
  }
}
