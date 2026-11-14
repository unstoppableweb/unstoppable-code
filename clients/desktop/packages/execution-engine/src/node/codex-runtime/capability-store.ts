import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { flushDirectory } from '@canopy/core-platform/directory-flush';
import type { CodexCapabilityLeaseFile } from './capability-types';
import type { SelectedCapabilityRoot } from './generated/v2/SelectedCapabilityRoot';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';

const ROOT_METADATA_FILE = '.capability-root.json';
const DEFAULT_GC_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_ATTEMPTS = 300;
// Publication can legitimately exceed the filesystem lock's retry budget.
// Queue callers in this process (including separate store instances) before
// competing for the cross-process lock, so our own publisher cannot time us out.
const localGcLockTails = new Map<string, Promise<void>>();

interface CapabilityRootMetadata {
  version: 1;
  contentId: string;
  files: Array<{ path: string; sha256: string; mode: number }>;
  publishedAt: string;
}

interface OperationPinFile {
  version: 1;
  pinId: string;
  rootContentIds: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

interface CapabilityLockOwner {
  version: 1;
  pid: number;
  nonce: string;
  createdAt: string;
}

class IncompleteCapabilityRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompleteCapabilityRootError';
  }
}

export interface CapabilityRootFile {
  content: string | Uint8Array;
  mode?: number;
}

export interface PublishCapabilityRootRequest {
  files: Record<string, string | Uint8Array | CapabilityRootFile>;
}

export interface PublishedCapabilityRoot {
  contentId: string;
  path: string;
}

export interface PublishedCapabilitySelection {
  roots: SelectedCapabilityRoot[];
  rootContentIds: string[];
}

export interface CapabilityOperationPin {
  pinId: string;
  rootContentIds: string[];
  expiresAt: string;
}

export interface CapabilityGcResult {
  removedContentIds: string[];
  retainedContentIds: string[];
}

/**
 * The lease/pin surface a Codex client actually depends on.
 *
 * `CodexCapabilityStore` is a class with private state, so consumers that
 * typed against it structurally could only be satisfied with an
 * `as unknown as` double assertion — which defeats the type checking exactly
 * where a test is asserting on this contract. Depending on this interface lets
 * callers inject a real store or a checked test double without casting.
 */
/**
 * A thread's lease, for a resume that asks for `snapshotId`. A lease from
 * before fingerprint v2 that names `legacySnapshotId`, this host's v1 id for
 * the same capabilities, moves to `snapshotId` first (CAN-6168). Any other
 * lease comes back as it is, so the caller refuses or rebuilds the thread.
 */
export async function readResumeLease(
  store: Pick<CodexCapabilityLeaseStore, 'readLease' | 'upgradeLeaseSnapshot'>,
  threadId: string,
  ids: { snapshotId: string; legacySnapshotId?: string },
): Promise<CodexCapabilityLeaseFile | null> {
  const lease = await store.readLease(threadId);
  if (
    !lease ||
    lease.snapshotId === ids.snapshotId ||
    lease.fingerprint !== undefined ||
    ids.legacySnapshotId === undefined ||
    lease.snapshotId !== ids.legacySnapshotId
  )
    return lease;
  await store.upgradeLeaseSnapshot(
    threadId,
    ids.legacySnapshotId,
    ids.snapshotId,
  );
  return store.readLease(threadId);
}

/**
 * The fingerprint a fork's lease records. A fork keeps its source's snapshot,
 * so it keeps the source's fingerprint too: a fork of a lease from before v2
 * still moves to v2 on resume. A fork with no source lease is v2.
 */
export function forkedLeaseFingerprint(
  sourceLease: CodexCapabilityLeaseFile | null,
): CodexCapabilityLeaseFile['fingerprint'] {
  return sourceLease ? sourceLease.fingerprint : 2;
}

export interface CodexCapabilityLeaseStore {
  readLease(threadId: string): Promise<CodexCapabilityLeaseFile | null>;
  writeLease(lease: CodexCapabilityLeaseFile): Promise<void>;
  upgradeLeaseSnapshot(
    threadId: string,
    from: string,
    to: string,
  ): Promise<boolean>;
  releaseLease(threadId: string): Promise<void>;
  acquireOperationPin(
    rootContentIds: string[],
    ttlMs?: number,
  ): Promise<CapabilityOperationPin>;
  refreshOperationPin(pinId: string, ttlMs?: number): Promise<void>;
  releaseOperationPin(pinId: string): Promise<void>;
  promotePinToLease(
    pinId: string,
    lease: CodexCapabilityLeaseFile,
  ): Promise<void>;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? Reflect.get(error, 'code')
    : undefined;
}

function isIncompleteCapabilityRootError(error: unknown): boolean {
  return (
    error instanceof IncompleteCapabilityRootError ||
    errorCode(error) === 'ENOENT'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isCodexCapabilityLeaseFile(
  value: unknown,
): value is CodexCapabilityLeaseFile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.threadId === 'string' &&
    typeof value.snapshotId === 'string' &&
    (value.fingerprint === undefined || value.fingerprint === 2) &&
    isStringArray(value.rootContentIds) &&
    (value.kind === 'persisted-chat' ||
      value.kind === 'persisted-helper' ||
      value.kind === 'ephemeral') &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.reasoningRouteFamily === undefined ||
      typeof value.reasoningRouteFamily === 'string') &&
    (value.expiresAt === undefined || typeof value.expiresAt === 'string')
  );
}

function isOperationPinFile(value: unknown): value is OperationPinFile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.pinId === 'string' &&
    isStringArray(value.rootContentIds) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.expiresAt === 'string'
  );
}

function parseCapabilityLeaseFile(raw: string): CodexCapabilityLeaseFile {
  const value: unknown = JSON.parse(raw);
  if (!isCodexCapabilityLeaseFile(value)) {
    throw new Error('Invalid Codex capability lease record');
  }
  return value;
}

function parseOperationPinFile(raw: string): OperationPinFile {
  const value: unknown = JSON.parse(raw);
  if (!isOperationPinFile(value)) {
    throw new Error('Invalid Codex capability operation pin record');
  }
  return value;
}

function validateRelativeFilePath(filePath: string): string {
  const normalized = filePath.split('\\').join('/');
  if (
    normalized.length === 0 ||
    normalized === ROOT_METADATA_FILE ||
    normalized.startsWith('/') ||
    normalized
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid capability root path: ${filePath}`);
  }
  return normalized;
}

function normalizeRootFile(value: string | Uint8Array | CapabilityRootFile): {
  content: Buffer;
  mode: number;
} {
  if (
    typeof value === 'object' &&
    value !== null &&
    !ArrayBuffer.isView(value) &&
    'content' in value
  ) {
    return {
      content:
        typeof value.content === 'string'
          ? Buffer.from(value.content)
          : Buffer.from(value.content),
      mode: normalizePublishedFileMode(value.mode ?? 0o600),
    };
  }
  return {
    content:
      typeof value === 'string' ? Buffer.from(value) : Buffer.from(value),
    mode: normalizePublishedFileMode(0o600),
  };
}

function normalizePublishedFileMode(mode: number): number {
  const normalized = mode & 0o555;
  return normalized === 0 ? 0o400 : normalized;
}

function updateRootDigest(
  digest: ReturnType<typeof createHash>,
  entry: { path: string; mode: number; content: Uint8Array },
): void {
  digest.update(
    `${entry.path.length}:${entry.path}:${entry.mode}:${entry.content.length}:`,
  );
  digest.update(entry.content);
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    await flushDirectory(directory);
  } catch {
    // Best effort, retained (CAN-5151): a failed flush never fails a
    // publication, pin or lease, and each file is synced before its rename.
    // Revisit when this store's owner qualifies its crash durability.
  }
}

async function atomicWriteJson(
  targetPath: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${randomUUID()}.tmp`,
  );
  const handle = await fs.open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporaryPath, targetPath);
    await syncDirectory(path.dirname(targetPath));
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function recordPath(directory: string, id: string): string {
  return path.join(directory, `${sha256(id)}.json`);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

export class CodexCapabilityStore implements CodexCapabilityLeaseStore {
  private readonly baseDirectory: string;
  private readonly rootsDirectory: string;
  private readonly leasesDirectory: string;
  private readonly pinsDirectory: string;
  private readonly gcLockDirectory: string;

  constructor(canopyDataDirectory: string) {
    this.baseDirectory = path.join(
      canopyDataDirectory,
      'codex-capabilities',
      'v1',
    );
    this.rootsDirectory = path.join(this.baseDirectory, 'roots');
    this.leasesDirectory = path.join(this.baseDirectory, 'leases');
    this.pinsDirectory = path.join(this.baseDirectory, 'pins');
    this.gcLockDirectory = path.join(this.baseDirectory, '.gc.lock');
  }

  async publishRoot(
    request: PublishCapabilityRootRequest,
  ): Promise<PublishedCapabilityRoot> {
    return this.withGcLock(() => this.publishRootWithGcLock(request));
  }

  private async publishRootWithGcLock(
    request: PublishCapabilityRootRequest,
  ): Promise<PublishedCapabilityRoot> {
    const entries = Object.entries(request.files)
      .map(([filePath, value]) => ({
        path: validateRelativeFilePath(filePath),
        ...normalizeRootFile(value),
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
    if (entries.length === 0) {
      throw new Error('A capability root must contain at least one file');
    }
    if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
      throw new Error('Capability root contains duplicate normalized paths');
    }
    const digest = createHash('sha256');
    for (const entry of entries) {
      updateRootDigest(digest, entry);
    }
    const contentId = digest.digest('hex');
    const targetPath = path.join(this.rootsDirectory, contentId);
    await fs.mkdir(this.rootsDirectory, { recursive: true, mode: 0o700 });

    let targetExists = true;
    try {
      await fs.lstat(targetPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw error;
      }
      targetExists = false;
    }

    let incompleteRootPath: string | undefined;
    if (targetExists) {
      try {
        await this.validateRoot(targetPath, contentId);
        const now = new Date();
        await fs.utimes(targetPath, now, now);
        return { contentId, path: targetPath };
      } catch (error) {
        if (!isIncompleteCapabilityRootError(error)) {
          throw error;
        }
        const quarantinePath = path.join(
          this.rootsDirectory,
          `.incomplete-${contentId}-${randomUUID()}`,
        );
        if (await this.quarantineIncompleteRoot(targetPath, quarantinePath)) {
          incompleteRootPath = quarantinePath;
        }
      }
    }

    const temporaryPath = path.join(
      this.rootsDirectory,
      `.publish-${contentId}-${randomUUID()}`,
    );
    await fs.mkdir(temporaryPath, { mode: 0o700 });
    try {
      const metadata: CapabilityRootMetadata = {
        version: 1,
        contentId,
        files: [],
        publishedAt: new Date().toISOString(),
      };
      for (const entry of entries) {
        const outputPath = path.join(temporaryPath, ...entry.path.split('/'));
        await fs.mkdir(path.dirname(outputPath), {
          recursive: true,
          mode: 0o700,
        });
        const handle = await fs.open(outputPath, 'wx', 0o600);
        try {
          await handle.writeFile(entry.content);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.chmod(outputPath, entry.mode);
        metadata.files.push({
          path: entry.path,
          sha256: sha256(entry.content),
          mode: entry.mode,
        });
      }
      await atomicWriteJson(
        path.join(temporaryPath, ROOT_METADATA_FILE),
        metadata,
      );
      await this.makePublishedRootReadOnly(temporaryPath);
      await this.validateRoot(temporaryPath, contentId);
      try {
        await fs.rename(temporaryPath, targetPath);
        await syncDirectory(this.rootsDirectory);
      } catch (error) {
        if (
          !(await this.validateRoot(targetPath, contentId).catch(() => false))
        ) {
          throw error;
        }
      }
      return { contentId, path: targetPath };
    } finally {
      await this.makeCapabilityTreeWritable(temporaryPath).catch(() => {});
      await fs
        .rm(temporaryPath, { recursive: true, force: true })
        .catch(() => {});
      if (incompleteRootPath) {
        await this.makeCapabilityTreeWritable(incompleteRootPath).catch(
          () => {},
        );
        await fs
          .rm(incompleteRootPath, { recursive: true, force: true })
          .catch(() => {});
      }
    }
  }

  protected async quarantineIncompleteRoot(
    targetPath: string,
    quarantinePath: string,
  ): Promise<boolean> {
    try {
      await fs.rename(targetPath, quarantinePath);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  async publishDirectory(directory: string): Promise<PublishedCapabilityRoot> {
    const rootPath = path.resolve(directory);
    const rootStats = await fs.lstat(rootPath);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error('Capability source root must be a real directory');
    }

    const retainedContentId = this.contentIdForRetainedRoot(rootPath);
    if (retainedContentId) {
      return this.withGcLock(async () => {
        await this.validateRoot(rootPath, retainedContentId);
        const now = new Date();
        await fs.utimes(rootPath, now, now);
        return { contentId: retainedContentId, path: rootPath };
      });
    }

    const files: PublishCapabilityRootRequest['files'] = {};
    const visit = async (currentDirectory: string): Promise<void> => {
      const entries = await fs.readdir(currentDirectory, {
        withFileTypes: true,
      });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const entryPath = path.join(currentDirectory, entry.name);
        const stats = await fs.lstat(entryPath);
        if (
          stats.isSymbolicLink() ||
          (!stats.isDirectory() && !stats.isFile())
        ) {
          throw new Error(
            `Capability source contains a link or special file: ${path.relative(rootPath, entryPath)}`,
          );
        }
        if (stats.isDirectory()) {
          await visit(entryPath);
          continue;
        }
        const relativePath = validateRelativeFilePath(
          path.relative(rootPath, entryPath).split(path.sep).join('/'),
        );
        const handle = await fs.open(entryPath, 'r');
        try {
          const openedStats = await handle.stat();
          if (
            !openedStats.isFile() ||
            openedStats.dev !== stats.dev ||
            openedStats.ino !== stats.ino
          ) {
            throw new Error(
              `Capability source changed while it was being published: ${relativePath}`,
            );
          }
          files[relativePath] = {
            content: await handle.readFile(),
            mode: openedStats.mode & 0o777,
          };
        } finally {
          await handle.close();
        }
      }
    };
    await visit(rootPath);
    return this.publishRoot({ files });
  }

  async publishSelectedRoots(
    roots: readonly SelectedCapabilityRoot[],
  ): Promise<PublishedCapabilitySelection> {
    const publishedRoots: SelectedCapabilityRoot[] = [];
    const rootContentIds: string[] = [];
    for (const root of roots) {
      if (
        root.location.type !== 'environment' ||
        root.location.environmentId !== 'local'
      ) {
        throw new Error(
          `Unsupported capability root environment: ${root.location.environmentId}`,
        );
      }
      const sourcePath = root.location.path.startsWith('file:')
        ? fileURLToPath(root.location.path)
        : path.resolve(root.location.path);
      const published = await this.publishDirectory(sourcePath);
      publishedRoots.push({
        id: published.contentId,
        location: {
          type: 'environment',
          environmentId: 'local',
          path: pathToFileURL(published.path).href,
        },
      });
      rootContentIds.push(published.contentId);
    }
    return {
      roots: publishedRoots,
      rootContentIds: Array.from(new Set(rootContentIds)),
    };
  }

  async writeLease(lease: CodexCapabilityLeaseFile): Promise<void> {
    if (lease.version !== 1 || !lease.threadId || !lease.snapshotId) {
      throw new Error('Invalid Codex capability lease');
    }
    const normalizedRoots = Array.from(new Set(lease.rootContentIds)).sort();
    await this.withGcLock(async () => {
      await this.validateReferencedRoots(normalizedRoots);
      await this.withRecordLock(
        this.leasesDirectory,
        lease.threadId,
        async () => {
          const existing = await this.readLease(lease.threadId);
          if (
            existing &&
            (existing.snapshotId !== lease.snapshotId ||
              existing.kind !== lease.kind ||
              JSON.stringify([...existing.rootContentIds].sort()) !==
                JSON.stringify(normalizedRoots))
          ) {
            throw new Error(
              'Cannot replace a Codex capability lease with a different snapshot',
            );
          }
          await atomicWriteJson(
            recordPath(this.leasesDirectory, lease.threadId),
            {
              ...lease,
              rootContentIds: normalizedRoots,
              createdAt: existing?.createdAt ?? lease.createdAt,
            } satisfies CodexCapabilityLeaseFile,
          );
        },
      );
    });
  }

  /**
   * Moves a thread's fingerprint v1 lease to the host-neutral snapshot id
   * (CAN-6168), only while its stored id is still `from`, the v1 id this
   * host computed for the same capabilities. False when the lease is gone
   * or names any other snapshot, so a lease never moves to another
   * session's capabilities.
   */
  async upgradeLeaseSnapshot(
    threadId: string,
    from: string,
    to: string,
  ): Promise<boolean> {
    if (!threadId || !from || !to) return false;
    return this.withRecordLock(this.leasesDirectory, threadId, async () => {
      const existing = await this.readLease(threadId);
      if (!existing || existing.snapshotId !== from) return false;
      // A v2 lease never moves: only a lease from before v2 does.
      if (existing.fingerprint !== undefined) return from === to;
      await atomicWriteJson(recordPath(this.leasesDirectory, threadId), {
        ...existing,
        snapshotId: to,
        fingerprint: 2,
        updatedAt: new Date().toISOString(),
      } satisfies CodexCapabilityLeaseFile);
      return true;
    });
  }

  async releaseLease(threadId: string): Promise<void> {
    await this.withRecordLock(this.leasesDirectory, threadId, async () => {
      await fs.rm(recordPath(this.leasesDirectory, threadId), { force: true });
    });
  }

  async readLease(threadId: string): Promise<CodexCapabilityLeaseFile | null> {
    try {
      return parseCapabilityLeaseFile(
        await fs.readFile(recordPath(this.leasesDirectory, threadId), 'utf8'),
      );
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async acquireOperationPin(
    rootContentIds: string[],
    ttlMs = 60_000,
  ): Promise<CapabilityOperationPin> {
    return this.withGcLock(async () => {
      const normalizedRoots = Array.from(new Set(rootContentIds)).sort();
      await this.validateReferencedRoots(normalizedRoots);
      const now = new Date();
      const pin: OperationPinFile = {
        version: 1,
        pinId: randomUUID(),
        rootContentIds: normalizedRoots,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      };
      await atomicWriteJson(recordPath(this.pinsDirectory, pin.pinId), pin);
      return pin;
    });
  }

  async refreshOperationPin(pinId: string, ttlMs = 60_000): Promise<void> {
    const pinPath = recordPath(this.pinsDirectory, pinId);
    const pin = parseOperationPinFile(await fs.readFile(pinPath, 'utf8'));
    const now = new Date();
    await atomicWriteJson(pinPath, {
      ...pin,
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    } satisfies OperationPinFile);
  }

  async releaseOperationPin(pinId: string): Promise<void> {
    await fs.rm(recordPath(this.pinsDirectory, pinId), { force: true });
  }

  async promotePinToLease(
    pinId: string,
    lease: CodexCapabilityLeaseFile,
  ): Promise<void> {
    const pin = parseOperationPinFile(
      await fs.readFile(recordPath(this.pinsDirectory, pinId), 'utf8'),
    );
    const expectedRoots = Array.from(new Set(lease.rootContentIds)).sort();
    if (JSON.stringify(pin.rootContentIds) !== JSON.stringify(expectedRoots)) {
      throw new Error(
        'Capability operation pin does not match the thread lease',
      );
    }
    await this.writeLease(lease);
    await this.releaseOperationPin(pinId);
  }

  async collectGarbage(
    options: { now?: Date; graceMs?: number } = {},
  ): Promise<CapabilityGcResult> {
    return this.withGcLock(async () => {
      const now = options.now ?? new Date();
      const referenced = await this.readReferencedRootIds(now);
      const removedContentIds: string[] = [];
      const retainedContentIds: string[] = [];
      const entries = await fs
        .readdir(this.rootsDirectory, { withFileTypes: true })
        .catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) {
          continue;
        }
        const rootPath = path.join(this.rootsDirectory, entry.name);
        const stats = await fs.lstat(rootPath);
        const graceMs = options.graceMs ?? DEFAULT_GC_GRACE_MS;
        if (
          referenced.has(entry.name) ||
          now.getTime() - stats.mtimeMs < graceMs
        ) {
          retainedContentIds.push(entry.name);
          continue;
        }
        await this.validateRoot(rootPath, entry.name);
        const freshReferences = await this.readReferencedRootIds(now);
        if (freshReferences.has(entry.name)) {
          retainedContentIds.push(entry.name);
          continue;
        }
        const quarantinePath = path.join(
          this.rootsDirectory,
          `.gc-${entry.name}-${randomUUID()}`,
        );
        await fs.rename(rootPath, quarantinePath);
        await this.makeCapabilityTreeWritable(quarantinePath);
        await fs.rm(quarantinePath, { recursive: true, force: true });
        removedContentIds.push(entry.name);
      }
      return { removedContentIds, retainedContentIds };
    });
  }

  private async validateRoot(
    rootPath: string,
    expectedContentId: string,
  ): Promise<boolean> {
    const rootStats = await fs.lstat(rootPath);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error('Capability root must be a real directory');
    }
    if (hostOperatingSystem() !== 'win32' && (rootStats.mode & 0o222) !== 0) {
      throw new Error('Capability root directories must be read-only');
    }
    const metadata = JSON.parse(
      await fs.readFile(path.join(rootPath, ROOT_METADATA_FILE), 'utf8'),
    ) as CapabilityRootMetadata;
    if (
      metadata.version !== 1 ||
      metadata.contentId !== expectedContentId ||
      !Array.isArray(metadata.files) ||
      metadata.files.length === 0
    ) {
      throw new Error('Capability root metadata does not match its content id');
    }
    const normalizedMetadata = metadata.files
      .map((file) => ({
        path: validateRelativeFilePath(file.path),
        sha256: file.sha256,
        mode: file.mode,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const expectedPaths = new Set(normalizedMetadata.map((file) => file.path));
    if (expectedPaths.size !== normalizedMetadata.length) {
      throw new Error('Capability root metadata contains duplicate paths');
    }
    const discoveredPaths = new Set<string>();
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        const entryPath = path.join(directory, entry.name);
        const relativePath = path
          .relative(rootPath, entryPath)
          .split(path.sep)
          .join('/');
        const stats = await fs.lstat(entryPath);
        if (
          stats.isSymbolicLink() ||
          (!stats.isDirectory() && !stats.isFile())
        ) {
          throw new Error(
            'Capability roots cannot contain links or special files',
          );
        }
        if (stats.isDirectory()) {
          if (hostOperatingSystem() !== 'win32' && (stats.mode & 0o222) !== 0) {
            throw new Error('Capability root directories must be read-only');
          }
          await visit(entryPath);
        } else if (relativePath !== ROOT_METADATA_FILE) {
          discoveredPaths.add(relativePath);
        }
      }
    };
    await visit(rootPath);
    if (
      Array.from(discoveredPaths).some(
        (filePath) => !expectedPaths.has(filePath),
      )
    ) {
      throw new Error('Capability root contains unexpected files');
    }
    const digest = createHash('sha256');
    let hasMissingExpectedFiles = false;
    for (const file of normalizedMetadata) {
      if (
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        file.mode !== normalizePublishedFileMode(file.mode)
      ) {
        throw new Error(`Invalid capability root metadata: ${file.path}`);
      }
      if (!discoveredPaths.has(file.path)) {
        hasMissingExpectedFiles = true;
        continue;
      }
      const filePath = path.join(rootPath, ...file.path.split('/'));
      const stats = await fs.lstat(filePath).catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') {
          return undefined;
        }
        throw error;
      });
      if (!stats) {
        hasMissingExpectedFiles = true;
        continue;
      }
      if (
        hostOperatingSystem() !== 'win32' &&
        (stats.mode & 0o777) !== file.mode
      ) {
        throw new Error(`Capability root file mode mismatch: ${file.path}`);
      }
      const contents = await fs.readFile(filePath).catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') {
          return undefined;
        }
        throw error;
      });
      if (!contents) {
        hasMissingExpectedFiles = true;
        continue;
      }
      if (sha256(contents) !== file.sha256) {
        throw new Error(`Capability root file digest mismatch: ${file.path}`);
      }
      updateRootDigest(digest, {
        path: file.path,
        mode: file.mode,
        content: contents,
      });
    }
    if (hasMissingExpectedFiles) {
      throw new IncompleteCapabilityRootError(
        'Capability root is missing expected files',
      );
    }
    if (digest.digest('hex') !== expectedContentId) {
      throw new Error('Capability root complete digest mismatch');
    }
    return true;
  }

  private async makePublishedRootReadOnly(rootPath: string): Promise<void> {
    const visit = async (directory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(entryPath);
          await fs.chmod(entryPath, 0o500);
        } else if (entry.name === ROOT_METADATA_FILE) {
          await fs.chmod(entryPath, 0o400);
        }
      }
    };
    await visit(rootPath);
    await fs.chmod(rootPath, 0o500);
  }

  private async makeCapabilityTreeWritable(rootPath: string): Promise<void> {
    const stats = await fs.lstat(rootPath);
    if (stats.isSymbolicLink()) {
      return;
    }
    if (!stats.isDirectory()) {
      await fs.chmod(rootPath, 0o600);
      return;
    }
    await fs.chmod(rootPath, 0o700);
    for (const entry of await fs.readdir(rootPath, { withFileTypes: true })) {
      await this.makeCapabilityTreeWritable(path.join(rootPath, entry.name));
    }
  }

  private async validateReferencedRoots(
    rootContentIds: readonly string[],
  ): Promise<void> {
    for (const contentId of rootContentIds) {
      if (!/^[a-f0-9]{64}$/.test(contentId)) {
        throw new Error(`Invalid capability root content id: ${contentId}`);
      }
      await this.validateRoot(
        path.join(this.rootsDirectory, contentId),
        contentId,
      );
    }
  }

  private contentIdForRetainedRoot(rootPath: string): string | null {
    if (path.dirname(rootPath) !== this.rootsDirectory) {
      return null;
    }
    const contentId = path.basename(rootPath);
    return /^[a-f0-9]{64}$/.test(contentId) ? contentId : null;
  }

  private async readReferencedRootIds(now: Date): Promise<Set<string>> {
    const referenced = new Set<string>();
    for (const directory of [this.leasesDirectory, this.pinsDirectory]) {
      const entries = await fs.readdir(directory).catch(() => []);
      for (const entry of entries) {
        if (!entry.endsWith('.json')) {
          continue;
        }
        let record: CodexCapabilityLeaseFile | OperationPinFile;
        try {
          const raw = await fs.readFile(path.join(directory, entry), 'utf8');
          record =
            directory === this.leasesDirectory
              ? parseCapabilityLeaseFile(raw)
              : parseOperationPinFile(raw);
        } catch {
          throw new Error(
            `Refusing capability GC because retained record is unreadable: ${entry}`,
          );
        }
        if (record.expiresAt && Date.parse(record.expiresAt) <= now.getTime()) {
          continue;
        }
        for (const contentId of record.rootContentIds) {
          referenced.add(contentId);
        }
      }
    }
    return referenced;
  }

  private async withGcLock<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.gcLockDirectory);
    const previous = localGcLockTails.get(key);
    let release = (): void => undefined;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    localGcLockTails.set(key, tail);
    await previous;
    try {
      return await this.withFilesystemGcLock(operation);
    } finally {
      release();
      if (localGcLockTails.get(key) === tail) {
        localGcLockTails.delete(key);
      }
    }
  }

  private async withFilesystemGcLock<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    await fs.mkdir(this.baseDirectory, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < LOCK_WAIT_ATTEMPTS; attempt += 1) {
      try {
        await fs.mkdir(this.gcLockDirectory, { mode: 0o700 });
        try {
          await this.writeLockOwner(this.gcLockDirectory);
          return await operation();
        } finally {
          await fs.rm(this.gcLockDirectory, { recursive: true, force: true });
        }
      } catch (error) {
        const code = errorCode(error);
        if (code !== 'EEXIST') {
          throw error;
        }
        if (await this.shouldReclaimLock(this.gcLockDirectory)) {
          await fs
            .rm(this.gcLockDirectory, { recursive: true, force: true })
            .catch(() => {});
        } else {
          await delay(100);
        }
      }
    }
    throw new Error('Timed out waiting for the Codex capability GC lock');
  }

  private async withRecordLock<T>(
    directory: string,
    recordId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const lockDirectory = path.join(directory, `.${sha256(recordId)}.lock`);
    for (let attempt = 0; attempt < LOCK_WAIT_ATTEMPTS; attempt += 1) {
      try {
        await fs.mkdir(lockDirectory, { mode: 0o700 });
        try {
          await this.writeLockOwner(lockDirectory);
          return await operation();
        } finally {
          await fs.rm(lockDirectory, { recursive: true, force: true });
        }
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') {
          throw error;
        }
        if (await this.shouldReclaimLock(lockDirectory)) {
          await fs
            .rm(lockDirectory, { recursive: true, force: true })
            .catch(() => {});
        } else {
          await delay(100);
        }
      }
    }
    throw new Error('Timed out waiting for a Codex capability record lock');
  }

  private async writeLockOwner(lockDirectory: string): Promise<void> {
    await atomicWriteJson(path.join(lockDirectory, 'owner.json'), {
      version: 1,
      pid: process.pid,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    } satisfies CapabilityLockOwner);
  }

  private async shouldReclaimLock(lockDirectory: string): Promise<boolean> {
    try {
      const owner = JSON.parse(
        await fs.readFile(path.join(lockDirectory, 'owner.json'), 'utf8'),
      ) as Partial<CapabilityLockOwner>;
      if (typeof owner.pid === 'number') {
        return !isProcessAlive(owner.pid);
      }
    } catch {
      // A process may have been interrupted between creating the lock
      // directory and durably writing its owner record.
    }
    const stats = await fs.stat(lockDirectory).catch(() => null);
    return stats !== null && Date.now() - stats.mtimeMs > LOCK_STALE_MS;
  }
}
