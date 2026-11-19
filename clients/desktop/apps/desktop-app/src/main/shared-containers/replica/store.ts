import { getDesktopNodeRuntime } from '../../lib/node-runtime';
import { cleanTrustedNodeEnvironment } from '../../lib/trusted-node-environment';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, type BigIntStats, type Dirent } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { isSharedContainerRevisionPackage } from '@canopy/protocol/shared-containers';
import type {
  SharedContainerAccess,
  SharedContainerAccessBlockReason,
} from '@canopy/desktop-shared/types';
import type {
  SharedContainerCachedArtifact,
  SharedContainerReplicaIndex,
  SharedContainerReplicaState,
} from './types';

const EMPTY_INDEX: SharedContainerReplicaIndex = {
  version: 1,
  containers: {},
  artifacts: {},
  promotionCommits: {},
};

type ReplicaRootIdentity = {
  dev: string;
  ino: string;
  birthtime?: string;
};

type ReplicaRootMarker =
  | { version: 1; state: 'absent' }
  | ({ version: 1; state: 'active' } & ReplicaRootIdentity)
  | ({
      version: 1;
      state: 'purging' | 'purged';
      quarantine: string;
    } & ReplicaRootIdentity);

function normalizeBirthtime(value: unknown): { birthtime?: string } {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value)
    ? { birthtime: value }
    : {};
}

function normalizeRootMarker(value: unknown): ReplicaRootMarker | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (record.state === 'absent') return { version: 1, state: 'absent' };
  if (
    (record.state === 'active' ||
      record.state === 'purging' ||
      record.state === 'purged') &&
    typeof record.dev === 'string' &&
    /^(?:0|[1-9]\d*)$/.test(record.dev) &&
    typeof record.ino === 'string' &&
    /^(?:0|[1-9]\d*)$/.test(record.ino)
  ) {
    if (record.state === 'active') {
      return {
        version: 1,
        state: 'active',
        dev: record.dev,
        ino: record.ino,
        ...normalizeBirthtime(record.birthtime),
      };
    }
    if (
      typeof record.quarantine !== 'string' ||
      !record.quarantine ||
      record.quarantine === '.' ||
      record.quarantine === '..' ||
      /[\\/\0]/.test(record.quarantine)
    ) {
      return null;
    }
    return {
      version: 1,
      state: record.state,
      dev: record.dev,
      ino: record.ino,
      ...normalizeBirthtime(record.birthtime),
      quarantine: record.quarantine,
    };
  }
  return null;
}

const BOUND_REPLICA_CLEANUP_SCRIPT = String.raw`
const { chmod, lstat, readdir, rm } = require('node:fs/promises');
const { join } = require('node:path');

async function makeWritable(path) {
  const info = await lstat(path);
  if (!info.isDirectory()) {
    if (!info.isSymbolicLink()) await chmod(path, 0o600);
    return;
  }
  await chmod(path, 0o700);
  for (const entry of await readdir(path)) {
    await makeWritable(join(path, entry));
  }
}

async function main() {
  const identity = await lstat('.', { bigint: true });
  process.stdout.write(JSON.stringify({
    type: 'identity',
    dev: String(identity.dev),
    ino: String(identity.ino),
    ...(identity.birthtimeNs > 0n ? { birthtime: String(identity.birthtimeNs) } : {}),
  }) + '\n');

  let command = '';
  for await (const chunk of process.stdin) {
    command += chunk;
    if (command.includes('\n')) break;
  }
  if (command.trim() !== 'clean') return;

  await chmod('.', 0o700);
  for (const entry of await readdir('.')) {
    await makeWritable(entry);
    await rm(entry, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
  process.stdout.write(JSON.stringify({ type: 'done' }) + '\n');
}

main().catch((error) => {
  process.stderr.write(String(error?.stack || error));
  process.exitCode = 1;
});
`;

const QUARANTINE_BINDING_MISMATCH =
  'ERR_SHARED_CONTAINER_QUARANTINE_BINDING_MISMATCH';
const REPLICA_CLEANUP_WORKER_TIMEOUT_MS = 30_000;

function rootIdentityFor(
  info: Pick<BigIntStats, 'dev' | 'ino'> &
    Partial<Pick<BigIntStats, 'birthtimeNs'>>,
): ReplicaRootIdentity {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    ...(info.birthtimeNs !== undefined && info.birthtimeNs > BigInt(0)
      ? { birthtime: String(info.birthtimeNs) }
      : {}),
  };
}

function rootIdentitiesMatch(
  expected: ReplicaRootIdentity,
  actual: ReplicaRootIdentity,
): boolean {
  return (
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    (!expected.birthtime ||
      !actual.birthtime ||
      expected.birthtime === actual.birthtime)
  );
}

type ReplicaRootIdentityVerdict =
  | 'same'
  | 'remounted'
  | 'unconfirmed'
  | 'changed';

class ReplicaRootIdentityMismatchError extends Error {
  constructor(readonly verdict: 'unconfirmed' | 'changed') {
    super('Shared-container replica root identity changed');
    this.name = 'ReplicaRootIdentityMismatchError';
  }
}

// Persisted identities can survive a remount; live purge bindings cannot.
function comparePersistedRootIdentity(
  expected: ReplicaRootIdentity,
  actual: ReplicaRootIdentity,
): ReplicaRootIdentityVerdict {
  if (expected.ino !== actual.ino) return 'changed';
  if (expected.birthtime && actual.birthtime) {
    if (expected.birthtime !== actual.birthtime) return 'changed';
    return expected.dev === actual.dev ? 'same' : 'remounted';
  }
  return expected.dev === actual.dev ? 'same' : 'unconfirmed';
}

function emptyIndex(): SharedContainerReplicaIndex {
  return {
    ...EMPTY_INDEX,
    containers: {},
    artifacts: {},
    promotionCommits: {},
  };
}

export async function makeReplicaTreeWritable(root: string): Promise<void> {
  let info;
  try {
    info = await lstat(root);
  } catch {
    return;
  }
  if (!info.isDirectory()) {
    if (info.isSymbolicLink()) return;
    await chmod(root, 0o600);
    return;
  }
  await chmod(root, 0o700);
  for (const entry of await readdir(root)) {
    await makeReplicaTreeWritable(join(root, entry));
  }
}

export async function makeReplicaTreeReadOnly(root: string): Promise<void> {
  const info = await lstat(root);
  if (!info.isDirectory()) {
    if (info.isSymbolicLink()) return;
    await chmod(root, (info.mode & 0o111) !== 0 ? 0o500 : 0o400);
    return;
  }
  for (const entry of await readdir(root)) {
    await makeReplicaTreeReadOnly(join(root, entry));
  }
  await chmod(root, 0o500);
}

const ACCESS_BLOCK_REASONS = new Set([
  'unsupported-remote-host',
  'github-not-connected',
  'repository-access-missing',
  'commit-unavailable',
  'lfs-unsupported',
  'symlink-unsupported',
  'git-credentials-missing',
]);

function normalizeState(value: unknown): SharedContainerReplicaState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // `organizationId` is absent for a personal container shared directly.
  // `access` postdates the index format (still version 1): a legacy entry has
  // none and resolves to organization access (`resolveSharedContainerAccess`),
  // which is what it always was.
  const organizationIdValid =
    record.organizationId === undefined ||
    (typeof record.organizationId === 'string' &&
      record.organizationId.length > 0);
  const baseValid =
    typeof record.containerId === 'string' &&
    organizationIdValid &&
    (record.containerType === 'CODE_WORKTREE' ||
      record.containerType === 'COWORK_WORK_ENTRY') &&
    typeof record.updatedAt === 'string';
  if (!baseValid) return null;
  const organizationId =
    typeof record.organizationId === 'string'
      ? record.organizationId
      : undefined;
  const access: SharedContainerAccess | undefined =
    record.access === 'direct' || record.access === 'organization'
      ? record.access
      : undefined;
  const base = {
    containerId: record.containerId as string,
    ...(organizationId !== undefined ? { organizationId } : {}),
    // Unknown values are dropped rather than failing the entry; consumers
    // resolve an absent value through `resolveSharedContainerAccess`.
    ...(access !== undefined ? { access } : {}),
    containerType: record.containerType as
      | 'CODE_WORKTREE'
      | 'COWORK_WORK_ENTRY',
    updatedAt: record.updatedAt as string,
  };
  if (record.status === 'nothing-published') {
    return { ...base, status: 'nothing-published' };
  }
  if (record.status === 'available' || record.status === 'pinned') {
    if (
      typeof record.revisionId === 'string' &&
      typeof record.revision === 'number' &&
      Number.isInteger(record.revision) &&
      record.revision >= 0 &&
      typeof record.revisionCreatedAt === 'string'
    ) {
      return {
        ...base,
        status: record.status,
        revisionId: record.revisionId,
        revision: record.revision,
        revisionCreatedAt: record.revisionCreatedAt,
        ...(isSharedContainerRevisionPackage(record.package)
          ? { package: record.package }
          : {}),
        withheldFileCount:
          typeof record.withheldFileCount === 'number' &&
          Number.isSafeInteger(record.withheldFileCount) &&
          record.withheldFileCount >= 0
            ? record.withheldFileCount
            : 0,
        withheldFileReasons:
          Array.isArray(record.withheldFileReasons) &&
          record.withheldFileReasons.every(
            (reason) =>
              reason === 'credential-shaped' ||
              reason === 'undisclosed-repo' ||
              reason === 'oversized' ||
              reason === 'symlink-escaping',
          )
            ? record.withheldFileReasons
            : [],
      };
    }
    return null;
  }
  if (record.status === 'blocked') {
    if (
      typeof record.reason === 'string' &&
      ACCESS_BLOCK_REASONS.has(record.reason) &&
      typeof record.message === 'string'
    ) {
      return {
        ...base,
        status: 'blocked',
        reason: record.reason as SharedContainerAccessBlockReason,
        message: record.message,
        ...(typeof record.repository === 'string' &&
        record.repository.trim().length > 0
          ? { repository: record.repository }
          : {}),
      };
    }
    return null;
  }
  return null;
}

function normalizeCachedArtifact(
  value: unknown,
): SharedContainerCachedArtifact | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.artifactId === 'string' &&
    typeof record.revisionId === 'string' &&
    typeof record.path === 'string' &&
    (record.representation === 'BLOB' ||
      record.representation === 'OPERATION_MANIFEST') &&
    typeof record.hash === 'string' &&
    typeof record.objectSizeBytes === 'string' &&
    /^(?:0|[1-9]\d*)$/.test(record.objectSizeBytes)
  ) {
    return {
      artifactId: record.artifactId,
      revisionId: record.revisionId,
      path: record.path,
      representation: record.representation,
      hash: record.hash,
      objectSizeBytes: record.objectSizeBytes,
    };
  }
  return null;
}

function normalizeCachedArtifactMap(
  value: unknown,
): Record<string, SharedContainerCachedArtifact> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([artifactId, entry]) => {
      const artifact = normalizeCachedArtifact(entry);
      return artifact && artifact.artifactId === artifactId
        ? [[artifactId, artifact]]
        : [];
    }),
  );
}

function normalizeIndex(value: unknown): SharedContainerReplicaIndex | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !record.containers ||
    typeof record.containers !== 'object' ||
    Array.isArray(record.containers)
  ) {
    return null;
  }
  const containers = Object.fromEntries(
    Object.entries(record.containers).flatMap(([containerId, entry]) => {
      const state = normalizeState(entry);
      return state && state.containerId === containerId
        ? [[containerId, state]]
        : [];
    }),
  ) as Record<string, SharedContainerReplicaState>;
  const artifacts =
    record.artifacts &&
    typeof record.artifacts === 'object' &&
    !Array.isArray(record.artifacts)
      ? (Object.fromEntries(
          Object.entries(record.artifacts)
            .filter(([containerId]) => containers[containerId])
            .map(([containerId, entries]) => [
              containerId,
              normalizeCachedArtifactMap(entries),
            ]),
        ) as Record<string, Record<string, SharedContainerCachedArtifact>>)
      : {};
  const promotionCommits =
    record.promotionCommits &&
    typeof record.promotionCommits === 'object' &&
    !Array.isArray(record.promotionCommits)
      ? Object.fromEntries(
          Object.entries(record.promotionCommits).filter(
            ([containerId, promotionId]) =>
              Boolean(containers[containerId]) &&
              typeof promotionId === 'string' &&
              promotionId.length > 0,
          ),
        )
      : {};
  return { version: 1, containers, artifacts, promotionCommits };
}

export class SharedContainerReplicaStore {
  private writeTail: Promise<void> = Promise.resolve();
  private cleanupWorkerTimeoutMs = REPLICA_CLEANUP_WORKER_TIMEOUT_MS;
  private rootIdentity: ReplicaRootIdentity | null = null;
  private rootMarkerState:
    | 'legacy'
    | 'active'
    | 'purging'
    | 'purged'
    | 'absent' = 'legacy';
  private rootQuarantine: string | null = null;
  private rootMarkerLoadPromise: Promise<void> | null = null;

  constructor(readonly rootDir: string) {}

  get indexPath(): string {
    return join(this.rootDir, 'index.json');
  }

  private get rootMarkerPath(): string {
    return join(
      dirname(this.rootDir),
      `.${basename(this.rootDir)}.identity.json`,
    );
  }

  containerDir(containerId: string): string {
    if (!containerId || /[\\/\0]/.test(containerId) || containerId === '..') {
      throw new Error('Invalid shared-container id');
    }
    const candidate = resolve(this.rootDir, containerId);
    const root = `${resolve(this.rootDir)}${sep}`;
    if (!candidate.startsWith(root)) {
      throw new Error('Shared-container path escaped its root');
    }
    return candidate;
  }

  async resolveRevisionRootForRead(
    containerId: string,
    revisionId: string,
  ): Promise<string> {
    if (!revisionId || /[\\/\0]/.test(revisionId) || revisionId === '..') {
      throw new Error('Invalid shared-container revision id');
    }
    const containerDir = this.containerDir(containerId);
    const revisionsDir = join(containerDir, 'revisions');
    const revisionDir = resolve(revisionsDir, revisionId);
    if (!revisionDir.startsWith(`${resolve(revisionsDir)}${sep}`)) {
      throw new Error('Shared-container revision path escaped its root');
    }
    for (const [label, path] of [
      ['root', this.rootDir],
      ['container', containerDir],
      ['revisions', revisionsDir],
      ['revision', revisionDir],
    ] as const) {
      const info = await this.lstatIfPresent(path);
      if (!info)
        throw new Error(`Shared-container replica ${label} is missing`);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(
          `Shared-container replica ${label} is not a real directory or is a symbolic link`,
        );
      }
    }
    return revisionDir;
  }

  /** Resolve a descendant of an already-verified revision root. */
  resolvePathBelowForRead(root: string, ...segments: string[]): string {
    const candidate = resolve(root, ...segments);
    const resolvedRoot = resolve(root);
    if (
      candidate !== resolvedRoot &&
      !candidate.startsWith(`${resolvedRoot}${sep}`)
    ) {
      throw new Error('Shared-container content path escaped its root');
    }
    return candidate;
  }

  private async assertRealParentsForRead(
    root: string,
    target: string,
  ): Promise<void> {
    const pathFromRoot = relative(root, target);
    if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
      throw new Error('Shared-container content path escaped its root');
    }
    let current = resolve(root);
    const segments = pathFromRoot.split(sep).filter(Boolean);
    for (const segment of segments.slice(0, -1)) {
      current = resolve(current, segment);
      const info = await lstat(current, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error('Shared-container content parent is a symbolic link');
      }
    }
  }

  async assertRealDirectoryForRead(
    root: string,
    target: string,
  ): Promise<void> {
    await this.assertRealParentsForRead(root, target);
    const info = await lstat(target, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('Shared-container content directory is a symbolic link');
    }
  }

  async readDirectoryForRead(root: string, target: string): Promise<Dirent[]> {
    await this.assertRealDirectoryForRead(root, target);
    return readdir(target, { withFileTypes: true });
  }

  /**
   * Read a symlinked entry's target text, without ever following the link.
   *
   * Git stores a symlink's blob as its target path, and that is exactly what
   * the publisher ships for a mode-120000 overlay entry — so the target string
   * *is* the file's content as far as a diff is concerned. Reading it with
   * `readlink` gives the recipient the right answer while keeping the guard
   * that matters: `readBoundedFileForRead` still refuses to open a symlink,
   * because following one could read an arbitrary local file and render it as
   * shared content (CAN-2551).
   *
   * Materialization has already rejected any target that is not
   * `in-repository`, so a link that survived into the replica is one the
   * publisher legitimately shared.
   */
  async readLinkTargetForRead(root: string, target: string): Promise<Buffer> {
    const info = await this.lstatEntryForRead(root, target);
    if (!info.isSymbolicLink()) {
      throw new Error('Shared-container content is not a symbolic link');
    }
    return Buffer.from(await readlink(target, { encoding: 'utf8' }), 'utf8');
  }

  /**
   * `lstat` an entry for metadata, allowing a symlinked leaf.
   *
   * Every parent segment must still be a real directory, which is the guard
   * that actually prevents escaping the replica root. Rejecting a symlinked
   * *leaf* only matters when the caller is about to read through it, and no
   * caller relies on an `lstat` precheck for that: {@link
   * readBoundedFileForRead} opens with `O_NOFOLLOW` and refuses on `ELOOP`,
   * which is a race-free kernel check rather than a TOCTOU-prone precheck.
   * Listings report a link as its own entry and never follow it, so they use
   * this (CAN-2551). A shared repository containing symlinks is ordinary, and
   * refusing to stat one used to fail the entire changed-file listing.
   */
  async lstatEntryForRead(root: string, target: string): Promise<BigIntStats> {
    await this.assertRealParentsForRead(root, target);
    return lstat(target, { bigint: true });
  }

  async readBoundedFileForRead(
    root: string,
    target: string,
    maximumBytes: number,
  ): Promise<Buffer> {
    await this.assertRealParentsForRead(root, target);
    let handle;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new Error('Shared-container content is a symbolic link');
      }
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maximumBytes) {
        throw new Error(
          'Shared-container content is not a bounded regular file',
        );
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async prepareContainerForSync(containerId: string): Promise<void> {
    const containerDir = this.containerDir(containerId);
    const rootInfo = await this.validateReplicaRootForMutation();
    if (!rootInfo) {
      await mkdir(this.rootDir).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error('Shared-container replica root identity changed');
        }
        throw error;
      });
      const createdRootInfo = await this.lstatIfPresent(this.rootDir);
      if (!createdRootInfo?.isDirectory() || createdRootInfo.isSymbolicLink()) {
        throw new Error('Shared-container replica root could not be created');
      }
      await this.activateRootIdentity(rootIdentityFor(createdRootInfo));
    }

    const containerInfo = await this.rejectAndUnlinkDirectoryLink(
      containerDir,
      'container',
    );
    if (!containerInfo) return;
    if (!containerInfo.isDirectory()) {
      throw new Error('Shared-container replica container is not a directory');
    }
    for (const [name, path] of [
      ['revision', join(containerDir, 'revisions')],
      ['staging', join(containerDir, 'staging')],
    ] as const) {
      const info = await this.rejectAndUnlinkDirectoryLink(path, name);
      if (info && !info.isDirectory()) {
        throw new Error(
          `Shared-container replica ${name} path is not a directory`,
        );
      }
    }
  }

  private async validateReplicaRootForMutation(): Promise<BigIntStats | null> {
    await this.ensureRootMarkerLoaded();
    if (
      this.rootMarkerState === 'purging' ||
      this.rootMarkerState === 'purged'
    ) {
      throw new Error('Shared-container replica root cleanup is incomplete');
    }
    const rootInfo = await this.rejectAndUnlinkDirectoryLink(
      this.rootDir,
      'root',
    );
    if (rootInfo && !rootInfo.isDirectory()) {
      throw new Error('Shared-container replica root is not a directory');
    }
    if (!rootInfo) {
      if (this.rootMarkerState === 'active') {
        throw new Error(
          'Shared-container replica root is unexpectedly missing',
        );
      }
      return null;
    }
    if (this.rootMarkerState === 'absent') {
      throw new ReplicaRootIdentityMismatchError('changed');
    }
    const currentIdentity = rootIdentityFor(rootInfo);
    const savedIdentity = this.rootIdentity;
    const verdict = savedIdentity
      ? comparePersistedRootIdentity(savedIdentity, currentIdentity)
      : 'same';
    if (verdict === 'unconfirmed' || verdict === 'changed') {
      throw new ReplicaRootIdentityMismatchError(verdict);
    }
    if (
      !savedIdentity ||
      verdict === 'remounted' ||
      (!savedIdentity.birthtime && currentIdentity.birthtime)
    ) {
      await this.activateRootIdentity({ ...savedIdentity, ...currentIdentity });
      if (verdict === 'remounted') {
        logMainProcessWarn('Shared-container replica root remounted', {
          previousDevice: savedIdentity?.dev,
          currentDevice: currentIdentity.dev,
        });
      }
    }
    return rootInfo;
  }

  private async ensureRootMarkerLoaded(): Promise<void> {
    this.rootMarkerLoadPromise ??= this.loadRootMarker();
    await this.rootMarkerLoadPromise;
  }

  private async loadRootMarker(): Promise<void> {
    let markerFile: Awaited<ReturnType<typeof open>> | null = null;
    try {
      markerFile = await open(
        this.rootMarkerPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const marker = normalizeRootMarker(
        JSON.parse(await markerFile.readFile({ encoding: 'utf8' })) as unknown,
      );
      if (!marker) {
        throw new Error('Shared-container replica root marker is invalid');
      }
      this.rootMarkerState = marker.state;
      this.rootIdentity =
        marker.state === 'absent'
          ? null
          : {
              dev: marker.dev,
              ino: marker.ino,
              ...normalizeBirthtime(marker.birthtime),
            };
      this.rootQuarantine =
        marker.state === 'purging' || marker.state === 'purged'
          ? marker.quarantine
          : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally {
      await markerFile?.close().catch(() => undefined);
    }
  }

  private async activateRootIdentity(
    identity: ReplicaRootIdentity,
  ): Promise<void> {
    await this.writeRootMarker({ version: 1, state: 'active', ...identity });
    this.rootMarkerState = 'active';
    this.rootIdentity = identity;
    this.rootQuarantine = null;
  }

  private async writeRootMarker(marker: ReplicaRootMarker): Promise<void> {
    const temporary = join(
      dirname(this.rootMarkerPath),
      `.${basename(this.rootMarkerPath)}.${randomUUID()}.tmp`,
    );
    let temporaryFile: Awaited<ReturnType<typeof open>> | null = null;
    try {
      temporaryFile = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await temporaryFile.writeFile(`${JSON.stringify(marker, null, 2)}\n`, {
        encoding: 'utf8',
      });
      await temporaryFile.close();
      temporaryFile = null;
      await rename(temporary, this.rootMarkerPath);
    } finally {
      await temporaryFile?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async validateContainerForMutation(
    containerId: string,
  ): Promise<BigIntStats | null> {
    const rootInfo = await this.validateReplicaRootForMutation();
    if (!rootInfo) return null;
    return this.rejectAndUnlinkDirectoryLink(
      this.containerDir(containerId),
      'container',
    );
  }

  private async rejectAndUnlinkDirectoryLink(
    path: string,
    label: string,
  ): Promise<BigIntStats | null> {
    const info = await this.lstatIfPresent(path);
    if (!info?.isSymbolicLink()) return info;
    // unlink() removes the link or Windows junction itself without traversing
    // into its target. Never make a linked tree writable before removal.
    await unlink(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    throw new Error(
      `Shared-container replica ${label} path is a symbolic link or junction`,
    );
  }

  private async lstatIfPresent(path: string): Promise<BigIntStats | null> {
    try {
      return await lstat(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async readIndex(): Promise<SharedContainerReplicaIndex> {
    try {
      return (
        normalizeIndex(JSON.parse(await readFile(this.indexPath, 'utf8'))) ??
        emptyIndex()
      );
    } catch {
      return emptyIndex();
    }
  }

  async readIndexForAuthoritativeCleanup(): Promise<SharedContainerReplicaIndex> {
    await this.validateReplicaRootForMutation();
    let rawIndex: string;
    try {
      rawIndex = await readFile(this.indexPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      let entries;
      try {
        entries = await readdir(this.rootDir);
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') {
          return emptyIndex();
        }
        throw readError;
      }
      if (entries.length === 0) return emptyIndex();
      throw new Error('Shared-container replica index is missing');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawIndex);
    } catch {
      throw new Error('Shared-container replica index is corrupt');
    }
    const index = normalizeIndex(parsed);
    if (!index) {
      throw new Error('Shared-container replica index is invalid');
    }
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'index.json') continue;
      if (!entry.isDirectory() || !index.containers[entry.name]) {
        throw new Error(
          `Shared-container replica index does not account for ${entry.name}`,
        );
      }
    }
    return index;
  }

  async get(containerId: string): Promise<SharedContainerReplicaState | null> {
    return (await this.readIndex()).containers[containerId] ?? null;
  }

  async set(state: SharedContainerReplicaState): Promise<void> {
    await this.enqueueWrite(async () => {
      const index = await this.readIndex();
      index.containers[state.containerId] = state;
      if (state.status !== 'available' && state.status !== 'pinned') {
        delete index.promotionCommits[state.containerId];
      }
      await this.writeIndex(index);
    });
  }

  async commitRevision(
    state: SharedContainerReplicaState,
    artifacts: SharedContainerCachedArtifact[],
    promotionId: string,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const index = await this.readIndex();
      index.containers[state.containerId] = state;
      index.artifacts[state.containerId] = Object.fromEntries(
        artifacts.map((artifact) => [artifact.artifactId, artifact]),
      );
      index.promotionCommits[state.containerId] = promotionId;
      await this.writeIndex(index);
    });
  }

  async isPromotionCommitted(
    containerId: string,
    promotionId: string,
  ): Promise<boolean> {
    let rawIndex: string;
    try {
      rawIndex = await readFile(this.indexPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawIndex);
    } catch {
      throw new Error('Shared-container replica index is corrupt');
    }
    const index = normalizeIndex(parsed);
    if (!index) {
      throw new Error('Shared-container replica index is invalid');
    }
    return index.promotionCommits[containerId] === promotionId;
  }

  async getCachedArtifacts(
    containerId: string,
  ): Promise<Record<string, SharedContainerCachedArtifact>> {
    return (await this.readIndex()).artifacts[containerId] ?? {};
  }

  async delete(containerId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const index = await this.readIndex();
      if (
        !Object.prototype.hasOwnProperty.call(index.containers, containerId) &&
        !Object.prototype.hasOwnProperty.call(index.artifacts, containerId) &&
        !Object.prototype.hasOwnProperty.call(
          index.promotionCommits,
          containerId,
        )
      ) {
        return;
      }
      delete index.containers[containerId];
      delete index.artifacts[containerId];
      delete index.promotionCommits[containerId];
      await this.writeIndex(index);
    });
  }

  async purgeBytes(containerId: string): Promise<void> {
    const target = this.containerDir(containerId);
    await this.validateContainerForMutation(containerId);
    await makeReplicaTreeWritable(target);
    await rm(target, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }

  async pruneRevisions(
    containerId: string,
    retainedRevisionId: string,
  ): Promise<void> {
    const containerDir = this.containerDir(containerId);
    const containerInfo = await this.validateContainerForMutation(containerId);
    if (!containerInfo) return;
    if (!containerInfo.isDirectory()) {
      throw new Error('Shared-container replica container is not a directory');
    }
    const revisionsDir = join(containerDir, 'revisions');
    const revisionsInfo = await this.rejectAndUnlinkDirectoryLink(
      revisionsDir,
      'revision',
    );
    if (!revisionsInfo) return;
    if (!revisionsInfo.isDirectory()) {
      throw new Error(
        'Shared-container replica revision path is not a directory',
      );
    }
    let entries;
    try {
      entries = await readdir(revisionsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.name !== retainedRevisionId)
        .map(async (entry) => {
          const target = join(revisionsDir, entry.name);
          await makeReplicaTreeWritable(target);
          await rm(target, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100,
          });
        }),
    );
  }

  async purgeAllBytes(): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.ensureRootMarkerLoaded();
      if (
        (this.rootMarkerState === 'purging' ||
          this.rootMarkerState === 'purged') &&
        this.rootIdentity &&
        this.rootQuarantine
      ) {
        // Rebind only at operation entry. Every subsequent check uses this
        // captured identity, even if the path is replaced again.
        const identity = await this.refreshInterruptedPurgeIdentity(
          this.rootMarkerState,
          this.rootIdentity,
          this.rootQuarantine,
        );
        await this.resumeRootPurge(
          this.rootMarkerState,
          identity ?? this.rootIdentity,
          this.rootQuarantine,
          this.rootMarkerState === 'purged' && identity !== null,
        );
        return;
      }
      let rootInfo: BigIntStats | null;
      let discardMismatch = false;
      try {
        rootInfo = await this.validateReplicaRootForMutation();
      } catch (error) {
        if (!(error instanceof ReplicaRootIdentityMismatchError)) throw error;
        discardMismatch = true;
        rootInfo = await this.rejectAndUnlinkDirectoryLink(
          this.rootDir,
          'root',
        );
        if (!rootInfo && this.rootMarkerState === 'active') {
          throw new Error(
            'Shared-container replica root is unexpectedly missing',
          );
        }
        if (rootInfo && !rootInfo.isDirectory()) {
          throw new Error('Shared-container replica root is not a directory');
        }
        logMainProcessWarn(
          'Shared-container purge-all discarding cache directory',
          {
            verdict: error.verdict,
          },
        );
      }
      if (!rootInfo) {
        await this.writeRootMarker({ version: 1, state: 'absent' });
        this.rootMarkerState = 'absent';
        this.rootIdentity = null;
        this.rootQuarantine = null;
        return;
      }
      const currentIdentity = rootIdentityFor(rootInfo);
      const expectedIdentity = discardMismatch
        ? currentIdentity
        : { ...this.rootIdentity, ...currentIdentity };
      const quarantine = `.${basename(this.rootDir)}.purge-${randomUUID()}`;
      const quarantinePath = join(dirname(this.rootDir), quarantine);
      await this.writeRootMarker({
        version: 1,
        state: 'purging',
        quarantine,
        ...expectedIdentity,
      });
      this.rootMarkerState = 'purging';
      this.rootIdentity = expectedIdentity;
      this.rootQuarantine = quarantine;
      await rename(this.rootDir, quarantinePath);
      try {
        await this.resumeRootPurge('purging', expectedIdentity, quarantine);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code ===
            QUARANTINE_BINDING_MISMATCH &&
          !(await this.lstatIfPresent(this.rootDir))
        ) {
          await rename(quarantinePath, this.rootDir).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  private async refreshInterruptedPurgeIdentity(
    phase: 'purging' | 'purged',
    savedIdentity: ReplicaRootIdentity,
    quarantine: string,
  ): Promise<ReplicaRootIdentity | null> {
    const quarantinePath = join(dirname(this.rootDir), quarantine);
    let info = await this.rejectAndUnlinkDirectoryLink(
      quarantinePath,
      'quarantine',
    );
    if (!info && phase === 'purging') {
      info = await this.rejectAndUnlinkDirectoryLink(this.rootDir, 'root');
    }
    // A completed quarantine must never select a new root for deletion.
    if (!info) return null;
    if (!info.isDirectory()) {
      throw new Error('Shared-container replica purge path is not a directory');
    }
    const currentIdentity = rootIdentityFor(info);
    const verdict = comparePersistedRootIdentity(
      savedIdentity,
      currentIdentity,
    );
    // Keep a known birthtime when stat loses that capability, unless an
    // explicit identity change establishes that this is a different directory.
    const identity =
      verdict === 'changed'
        ? currentIdentity
        : { ...savedIdentity, ...currentIdentity };
    if (
      savedIdentity.dev !== identity.dev ||
      savedIdentity.ino !== identity.ino ||
      savedIdentity.birthtime !== identity.birthtime
    ) {
      await this.writeRootMarker({
        version: 1,
        state: phase,
        quarantine,
        ...identity,
      });
      this.rootIdentity = identity;
      if (verdict === 'remounted') {
        logMainProcessWarn('Shared-container purge journal remounted', {
          previousDevice: savedIdentity.dev,
          currentDevice: identity.dev,
        });
      } else if (verdict === 'unconfirmed' || verdict === 'changed') {
        logMainProcessWarn(
          'Shared-container purge journal discarding cache directory',
          { verdict },
        );
      }
    }
    return identity;
  }

  private async resumeRootPurge(
    phase: 'purging' | 'purged',
    expectedIdentity: ReplicaRootIdentity,
    quarantine: string,
    cleanupPurgedQuarantine = false,
  ): Promise<void> {
    const quarantinePath = join(dirname(this.rootDir), quarantine);
    if (phase === 'purging') {
      try {
        await this.emptyBoundQuarantine(quarantinePath, expectedIdentity);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const rootInfo = await this.lstatIfPresent(this.rootDir);
        if (
          !rootInfo?.isDirectory() ||
          !rootIdentitiesMatch(expectedIdentity, rootIdentityFor(rootInfo))
        ) {
          throw new Error('Shared-container replica root identity changed');
        }
        await rename(this.rootDir, quarantinePath);
        await this.emptyBoundQuarantine(quarantinePath, expectedIdentity);
      }
      if (await this.lstatIfPresent(this.rootDir)) {
        throw new Error('Shared-container replica root identity changed');
      }
      await this.writeRootMarker({
        version: 1,
        state: 'purged',
        quarantine,
        ...expectedIdentity,
      });
      this.rootMarkerState = 'purged';
    } else if (cleanupPurgedQuarantine) {
      // An entry-time adoption may contain new bytes. Bind the worker even
      // if the path has disappeared since capture; disappearance must fail.
      await this.emptyBoundQuarantine(quarantinePath, expectedIdentity);
    }

    const quarantineInfo = await this.lstatIfPresent(quarantinePath);
    if (quarantineInfo) {
      if (
        !quarantineInfo.isDirectory() ||
        !rootIdentitiesMatch(expectedIdentity, rootIdentityFor(quarantineInfo))
      ) {
        throw new Error('Shared-container replica root identity changed');
      }
      await rmdir(quarantinePath);
    }
    if (await this.lstatIfPresent(this.rootDir)) {
      throw new Error('Shared-container replica root identity changed');
    }
    await this.writeRootMarker({ version: 1, state: 'absent' });
    this.rootMarkerState = 'absent';
    this.rootIdentity = null;
    this.rootQuarantine = null;
  }

  private async emptyBoundQuarantine(
    quarantinePath: string,
    expectedIdentity: ReplicaRootIdentity,
  ): Promise<void> {
    const child = spawn(
      (await getDesktopNodeRuntime()).nodeProcess.command,
      [
        '--disable-sigusr1',
        '--input-type=commonjs',
        '--eval',
        BOUND_REPLICA_CLEANUP_SCRIPT,
      ],
      {
        cwd: quarantinePath,
        env: cleanTrustedNodeEnvironment(process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const lines = createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    const exitPromise = once(child, 'exit') as Promise<[number | null]>;
    // Stream errors are independent of ChildProcess 'error'. Keep the listener
    // through teardown so a late EOF cannot escape after the operation settles.
    const inputFailure = new Promise<never>((_, reject) => {
      child.stdin.on('error', (error) => {
        logMainProcessWarn('Shared-container cleanup input pipe failed', error);
        reject(error);
        child.kill();
      });
    });
    void inputFailure.catch(() => undefined);
    void exitPromise.catch(() => undefined);

    let timeout: NodeJS.Timeout | null = null;
    let timeoutError: Error | null = null;
    const lifecycleDeadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timeoutError = new Error(
          'Shared-container replica cleanup process timed out',
        );
        child.kill();
        child.unref();
        reject(timeoutError);
      }, this.cleanupWorkerTimeoutMs);
      timeout.unref();
    });
    const beforeDeadline = <T>(operation: Promise<T>): Promise<T> =>
      Promise.race([operation, lifecycleDeadline, inputFailure]);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    try {
      await beforeDeadline(once(child, 'spawn'));
      const identityLine = await beforeDeadline(iterator.next());
      if (identityLine.done) {
        throw new Error(
          stderr || 'Shared-container replica cleanup process exited early',
        );
      }
      const identity: unknown = JSON.parse(identityLine.value);
      if (
        !identity ||
        typeof identity !== 'object' ||
        !('type' in identity) ||
        identity.type !== 'identity' ||
        !('dev' in identity) ||
        typeof identity.dev !== 'string' ||
        !('ino' in identity) ||
        typeof identity.ino !== 'string' ||
        !rootIdentitiesMatch(expectedIdentity, {
          dev: identity.dev,
          ino: identity.ino,
          ...normalizeBirthtime(
            'birthtime' in identity ? identity.birthtime : undefined,
          ),
        })
      ) {
        throw Object.assign(
          new Error('Shared-container replica root identity changed'),
          { code: QUARANTINE_BINDING_MISMATCH },
        );
      }
      const pathInfo = await this.lstatIfPresent(quarantinePath);
      const pathIdentityChanged =
        !pathInfo?.isDirectory() ||
        !rootIdentitiesMatch(expectedIdentity, rootIdentityFor(pathInfo));

      child.stdin.end('clean\n');
      const doneLine = await beforeDeadline(iterator.next());
      const done = doneLine.done
        ? null
        : (JSON.parse(doneLine.value) as unknown);
      if (
        !done ||
        typeof done !== 'object' ||
        Array.isArray(done) ||
        (done as Record<string, unknown>).type !== 'done'
      ) {
        throw new Error(
          stderr || 'Shared-container replica cleanup process exited early',
        );
      }
      const [exitCode] = await beforeDeadline(exitPromise);
      if (exitCode !== 0) {
        throw new Error(
          stderr ||
            `Shared-container replica cleanup process exited with ${exitCode}`,
        );
      }
      const finalInfo = await this.lstatIfPresent(quarantinePath);
      if (
        pathIdentityChanged ||
        !finalInfo?.isDirectory() ||
        !rootIdentitiesMatch(expectedIdentity, rootIdentityFor(finalInfo))
      ) {
        throw new Error('Shared-container replica root identity changed');
      }
    } catch (error) {
      if (!child.stdin.destroyed && !child.stdin.writableEnded)
        child.stdin.end('abort\n');
      if (error === timeoutError) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      } else {
        try {
          // The input failure has already rejected; wait for actual process
          // termination (or the deadline) before releasing the purge fence.
          await Promise.race([exitPromise, lifecycleDeadline]);
        } catch (exitError) {
          child.kill();
          child.unref();
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          if (exitError === timeoutError) throw exitError;
        }
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      lines.close();
    }
  }

  private async writeIndex(index: SharedContainerReplicaIndex): Promise<void> {
    const rootInfo = await this.validateReplicaRootForMutation();
    if (!rootInfo) {
      await mkdir(dirname(this.indexPath), { recursive: true });
      const createdRootInfo = await this.validateReplicaRootForMutation();
      if (!createdRootInfo) {
        throw new Error('Shared-container replica root could not be created');
      }
    }
    const temporary = join(
      dirname(this.indexPath),
      `.index.json.${randomUUID()}.tmp`,
    );
    let temporaryFile: Awaited<ReturnType<typeof open>> | null = null;
    try {
      temporaryFile = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await temporaryFile.writeFile(`${JSON.stringify(index, null, 2)}\n`, {
        encoding: 'utf8',
      });
      await temporaryFile.close();
      temporaryFile = null;
      await rename(temporary, this.indexPath);
    } finally {
      await temporaryFile?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const next = this.writeTail.then(operation, operation);
    this.writeTail = next.catch(() => undefined);
    await next;
  }
}
