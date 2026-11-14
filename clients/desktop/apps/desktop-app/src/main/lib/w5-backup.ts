import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  lstat,
  open,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  STORAGE_OWNERSHIP,
  validateNamespaceBackupRecord,
  type NamespaceBackupRecord,
} from '@canopy/core-runtime/storage';
import type {
  W5BackupPosition,
  W5Resource,
} from '@canopy/desktop-shared/node/w5-commit-log';
import { syncDirectory } from '@canopy/execution-engine/node/lib/atomic-file';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import {
  w5RootEvidenceScope,
  type W5RootEvidenceScope,
} from '@canopy/core-runtime/node/w5/service-history';
import { createReadOnlyW5BackupContext } from '@canopy/core-runtime/node/w5/readonly-backup-position';
import type { W5CommitLogHost } from '../w5-commit-log/commit-log-host';
import { getDataDir, getWorkspacesRootDir } from './paths';
import { isErrnoException, isRecord } from './type-guards';
import { validateId } from './validation';
import { PROJECT_W5_STORAGE, withStorageAdmission } from './w5-storage';

const NAMESPACES = [
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
] as const;
type Namespace = (typeof NAMESPACES)[number];

export type W5BackupRefusal =
  | 'incomplete-backup'
  | 'corrupt-backup'
  | 'source-changed'
  | 'source-unreadable'
  | 'missing-source'
  | 'newer-writes'
  | 'schema-downgrade'
  | 'exclusive-required';

export class W5BackupRefusedError extends Error {
  constructor(
    readonly reason: W5BackupRefusal,
    readonly resource: string,
  ) {
    super(`W5 recovery refused (${reason}): ${resource}`);
    this.name = 'W5BackupRefusedError';
  }
}

/** The decision is durable: never undo it with the older snapshot. */
export class W5BackupRecoveryError extends Error {
  constructor(readonly commitId: number) {
    super(
      `W5 restore commit ${commitId} requires recovery; retain current files and the commit-log evidence.`,
    );
    this.name = 'W5BackupRecoveryError';
  }
}

export interface W5BackupReadContext {
  readonly host: Pick<W5CommitLogHost, 'snapshot'>;
  /** Trusted host projection, not a client-supplied path. */
  readonly dataRoot: string;
  /** Pins a freshly created, empty capture directory for read-only snapshots. */
  readonly captureCreated?: (directory: string) => Promise<void>;
}

export interface W5BackupContext extends W5BackupReadContext {
  readonly host: W5CommitLogHost;
}

type Position = W5BackupPosition;
interface BackupFile {
  readonly path: string;
  readonly namespace: Namespace;
  readonly byteLength: number;
  readonly sha256: string | null;
  readonly schemaVersion: number | 'none';
  readonly revisions: Readonly<Record<string, number>>;
}
export interface W5BackupRecord {
  readonly version: 1;
  readonly position: Position;
  readonly files: readonly BackupFile[];
  readonly namespaces: readonly NamespaceBackupRecord[];
}
interface Image {
  readonly file: BackupFile;
  readonly bytes: Buffer | null;
}

/** Opaque admission; production issuance is scoped to the held Phase 1 claim. */
export interface W5ExclusiveMaintenance {
  readonly kind: 'w5-exclusive-maintenance';
}
const exclusiveRoots = new WeakMap<W5ExclusiveMaintenance, string>();

/** Deliberately unavailable in production; does not claim host exclusion. */
export function __createW5ExclusiveMaintenanceForTests(
  dataRoot: string,
): W5ExclusiveMaintenance {
  if (process.env.NODE_ENV !== 'test')
    throw new W5BackupRefusedError('exclusive-required', 'test-only issuer');
  const capability: W5ExclusiveMaintenance = Object.freeze({
    kind: 'w5-exclusive-maintenance',
  });
  exclusiveRoots.set(capability, resolve(dataRoot));
  return capability;
}

/**
 * Recovery copies require a canonical root. Retain its identity so protected
 * bootstrap can refuse replacement or alias retargeting before admission.
 */
export async function desktopW5BackupRootScope(): Promise<W5RootEvidenceScope> {
  const dataDir = getDataDir();
  if (resolve(getWorkspacesRootDir()) !== join(resolve(dataDir), 'workspaces'))
    throw new W5BackupRefusedError('source-unreadable', 'W5 root projection');
  try {
    return await w5RootEvidenceScope(dataDir);
  } catch {
    throw new W5BackupRefusedError('source-unreadable', 'data root');
  }
}

export async function desktopW5BackupContext(): Promise<W5BackupReadContext> {
  const { canonicalDataRoot } = await desktopW5BackupRootScope();
  return createReadOnlyW5BackupContext(canonicalDataRoot);
}

function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function resourceKey(resource: W5Resource): string {
  switch (resource.kind) {
    case 'workspaces':
      return 'workspaces';
    case 'workspace':
      return `workspace:${resource.workspaceId}`;
    case 'worktrees':
      return `worktrees:${resource.workspaceId}`;
    case 'worktree':
      return `worktree:${resource.workspaceId}/${resource.worktreeId}`;
  }
}
function backupId(value: unknown, resource: string): asserts value is string {
  try {
    validateId(value, resource);
  } catch {
    throw new W5BackupRefusedError('corrupt-backup', resource);
  }
}

function resourceFromKey(key: string): W5Resource {
  if (key === 'workspaces') return { kind: 'workspaces' };
  const [kind, identity] = key.split(':');
  const [workspaceId, worktreeId] = (identity ?? '').split('/');
  backupId(workspaceId, key);
  if (kind === 'workspace') return { kind, workspaceId };
  if (kind === 'worktrees') return { kind, workspaceId };
  if (kind === 'worktree') {
    backupId(worktreeId, key);
    return { kind, workspaceId, worktreeId };
  }
  throw new W5BackupRefusedError('corrupt-backup', key);
}
function namespaceFor(path: string): Namespace {
  if (path === 'index.json' || path === 'index.json.bak')
    return 'workspace_index';
  const [id, name, extra] = path.split('/');
  backupId(id, path);
  if (extra === undefined && name === 'workspace.json')
    return 'workspace_manifest';
  if (extra === undefined && name === 'worktrees.json') return 'worktree_list';
  throw new W5BackupRefusedError('corrupt-backup', path);
}

/** Refuse symlinks, directories and non-files; ENOENT is explicit absence. */
export async function readW5FileBytes(
  root: string,
  path: string,
): Promise<Buffer | null> {
  let current = root;
  for (const part of ['', ...path.split('/')]) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (
        stat.isSymbolicLink() ||
        (current === join(root, path) ? !stat.isFile() : !stat.isDirectory())
      )
        throw new W5BackupRefusedError('source-unreadable', path);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return null;
      throw new W5BackupRefusedError('source-unreadable', path);
    }
  }
  try {
    return await readFile(current);
  } catch {
    throw new W5BackupRefusedError('source-unreadable', path);
  }
}
export function validateW5Document(
  bytes: Buffer,
  path: string,
): Record<string, unknown> {
  // Host.commit stores UTF-8 strings; refuse lossy decoding before capture.
  const raw = bytes.toString('utf8');
  if (!Buffer.from(raw).equals(bytes))
    throw new W5BackupRefusedError('source-unreadable', path);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new W5BackupRefusedError('source-unreadable', path);
  }
  if (!isRecord(value))
    throw new W5BackupRefusedError('source-unreadable', path);
  if (value.version !== 1)
    throw new W5BackupRefusedError('schema-downgrade', path);
  const namespace = namespaceFor(path);
  if (namespace !== 'workspace_manifest') {
    const rows =
      namespace === 'workspace_index' ? value.workspaces : value.worktrees;
    if (!Array.isArray(rows))
      throw new W5BackupRefusedError('source-unreadable', path);
    const ids = new Set<string>();
    for (const row of rows) {
      if (!isRecord(row))
        throw new W5BackupRefusedError('source-unreadable', path);
      try {
        validateId(row.id, 'row id');
      } catch {
        throw new W5BackupRefusedError('source-unreadable', path);
      }
      if (ids.has(row.id))
        throw new W5BackupRefusedError('source-unreadable', path);
      ids.add(row.id);
      if (
        namespace === 'workspace_index' &&
        (typeof row.name !== 'string' ||
          typeof row.color !== 'string' ||
          (row.type !== 'single-repo' &&
            row.type !== 'multi-repo' &&
            row.type !== 'cowork'))
      )
        throw new W5BackupRefusedError('source-unreadable', path);
      if (
        namespace === 'worktree_list' &&
        (typeof row.branchName !== 'string' ||
          typeof row.createdAt !== 'string')
      )
        throw new W5BackupRefusedError('source-unreadable', path);
    }
  }
  return value;
}
function fileRevisions(
  path: string,
  position: Position,
  parsed: Record<string, unknown> | null,
): Record<string, number> {
  const result: Record<string, number> = {};
  const namespace = namespaceFor(path);
  const workspaceId = path.split('/')[0];
  if (namespace === 'workspace_index') {
    result.workspaces = position.revisions.workspaces ?? 0;
    for (const [key, revision] of Object.entries(position.revisions))
      if (key.startsWith('workspace:')) result[key] = revision;
    const rows = parsed?.workspaces;
    if (Array.isArray(rows))
      for (const row of rows)
        if (isRecord(row) && typeof row.id === 'string')
          result[`workspace:${row.id}`] =
            position.revisions[`workspace:${row.id}`] ?? 0;
  } else if (namespace === 'workspace_manifest') {
    result[`workspace:${workspaceId}`] =
      position.revisions[`workspace:${workspaceId}`] ?? 0;
  } else {
    result[`worktrees:${workspaceId}`] =
      position.revisions[`worktrees:${workspaceId}`] ?? 0;
    for (const [key, revision] of Object.entries(position.revisions))
      if (key.startsWith(`worktree:${workspaceId}/`)) result[key] = revision;
    const rows = parsed?.worktrees;
    if (Array.isArray(rows))
      for (const row of rows)
        if (isRecord(row) && typeof row.id === 'string')
          result[`worktree:${workspaceId}/${row.id}`] =
            position.revisions[`worktree:${workspaceId}/${row.id}`] ?? 0;
  }
  return result;
}

async function scan(root: string, position: Position): Promise<Image[]> {
  const index = await readW5FileBytes(root, 'index.json');
  if (index === null)
    throw new W5BackupRefusedError('missing-source', 'index.json');
  const parsed = validateW5Document(index, 'index.json');
  const ids = new Set<string>();
  if (Array.isArray(parsed.workspaces))
    for (const row of parsed.workspaces)
      if (isRecord(row) && typeof row.id === 'string') ids.add(row.id);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    throw new W5BackupRefusedError('source-unreadable', 'workspaces');
  }
  for (const entry of entries) {
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      try {
        validateId(entry.name, 'workspace directory');
      } catch {
        throw new W5BackupRefusedError('source-unreadable', entry.name);
      }
      ids.add(entry.name);
    }
  }
  const paths = [
    'index.json',
    'index.json.bak',
    ...Array.from(ids)
      .sort()
      .flatMap((id) => [`${id}/workspace.json`, `${id}/worktrees.json`]),
  ];
  const images: Image[] = [];
  for (const path of paths) {
    const bytes =
      path === 'index.json' ? index : await readW5FileBytes(root, path);
    // Preserve optional absence (Cowork lists, orphan metadata, index backup).
    // An indexed workspace must have its canonical manifest.
    if (
      bytes === null &&
      path.endsWith('/workspace.json') &&
      Array.isArray(parsed.workspaces) &&
      parsed.workspaces.some(
        (row) => isRecord(row) && row.id === path.split('/')[0],
      )
    )
      throw new W5BackupRefusedError('missing-source', path);
    if (
      bytes === null &&
      path.endsWith('/worktrees.json') &&
      Array.isArray(parsed.workspaces) &&
      parsed.workspaces.some(
        (row) =>
          isRecord(row) &&
          row.id === path.split('/')[0] &&
          (row.type === 'single-repo' || row.type === 'multi-repo'),
      )
    )
      throw new W5BackupRefusedError('missing-source', path);
    const value = bytes === null ? null : validateW5Document(bytes, path);
    images.push({
      bytes,
      file: {
        path,
        namespace: namespaceFor(path),
        byteLength: bytes?.length ?? 0,
        sha256: bytes === null ? null : digest(bytes),
        schemaVersion: bytes === null ? 'none' : 1,
        revisions: fileRevisions(path, position, value),
      },
    });
  }
  return images;
}

/** The trusted data root may not redirect recovery copies into a checkout. */
async function recoveryDirectory(
  dataRoot: string,
  relative: string,
  create: boolean,
): Promise<string> {
  let directory = resolve(dataRoot);
  for (const part of ['', ...relative.split('/')]) {
    directory = join(directory, part);
    try {
      if (create && part !== '')
        await mkdir(directory).catch((error: unknown): void => {
          if (!isErrnoException(error) || error.code !== 'EEXIST') throw error;
        });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new W5BackupRefusedError('source-unreadable', relative);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT')
        throw new W5BackupRefusedError('incomplete-backup', relative);
      throw error;
    }
  }
  return directory;
}

async function durableWrite(
  path: string,
  bytes: Buffer | string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function syncToDataRoot(
  directory: string,
  dataRoot: string,
): Promise<void> {
  const root = resolve(dataRoot);
  let current = resolve(directory);
  for (;;) {
    await syncDirectory(current);
    if (current === root) return;
    const parent = dirname(current);
    if (parent === current)
      throw new W5BackupRefusedError('source-unreadable', directory);
    current = parent;
  }
}

function namespaceDigest(
  files: readonly BackupFile[],
  position: Position,
  namespace: Namespace,
): string {
  return digest(
    JSON.stringify({
      position,
      files: files.filter((file) => file.namespace === namespace),
    }),
  );
}
function validationContext(
  backupPath: string,
): Parameters<typeof validateNamespaceBackupRecord>[1] {
  return {
    rows: STORAGE_OWNERSHIP,
    isOutsideCheckouts: (path) =>
      path === backupPath && /^w5\/backups\/[a-z0-9-]+$/.test(path),
  };
}

async function trialRestore(
  directory: string,
  images: readonly Image[],
): Promise<void> {
  const temporary = await mkdtemp(join(directory, '.restore-test-'));
  try {
    for (const { file, bytes } of images) {
      if (bytes === null) continue;
      await durableWrite(join(temporary, file.path), bytes);
      const restored = await readFile(join(temporary, file.path));
      if (
        !restored.equals(bytes) ||
        !isDeepStrictEqual(
          validateW5Document(restored, file.path),
          validateW5Document(bytes, file.path),
        )
      )
        throw new W5BackupRefusedError('corrupt-backup', file.path);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Files first, C3 records last; a partial directory never passes verification. */
export async function captureW5Backup(
  context: W5BackupReadContext,
): Promise<string> {
  const root = join(resolve(context.dataRoot), 'workspaces');
  const parent = await recoveryDirectory(context.dataRoot, 'w5/backups', true);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const position = await context.host.snapshot();
    const images = await scan(root, position);
    const backupPath = `w5/backups/${randomUUID()}`;
    const directory = join(context.dataRoot, backupPath);
    await mkdir(directory);
    await context.captureCreated?.(directory);
    const createdAt = new Date().toISOString();
    for (const { file } of images)
      await mkdir(dirname(join(directory, 'files', file.path)), {
        recursive: true,
      });
    for (const { file, bytes } of images)
      if (bytes !== null)
        await durableWrite(join(directory, 'files', file.path), bytes);
    const copied = await checkImages(
      directory,
      images.map((image) => image.file),
    );
    await trialRestore(directory, copied);
    const after = await context.host.snapshot();
    const reread = await scan(root, after);
    if (
      !isDeepStrictEqual(position, after) ||
      !isDeepStrictEqual(
        images.map((image) => image.file),
        reread.map((image) => image.file),
      )
    )
      continue;
    const files = images.map((image) => image.file);
    const record: W5BackupRecord = {
      version: 1,
      position,
      files,
      namespaces: NAMESPACES.map((namespaceId) => ({
        namespaceId,
        backupPath,
        sourceRevision: String(position.commitId),
        schemaVersion: 1,
        createdAt,
        verifiedBy: {
          algorithm: 'sha256',
          digest: namespaceDigest(files, position, namespaceId),
        },
        rollbackMigration:
          'restoreW5Backup (metadata only; ownership unchanged)',
        restoreTestedAt: new Date().toISOString(),
      })),
    };
    for (const namespace of record.namespaces) {
      const valid = validateNamespaceBackupRecord(
        namespace,
        validationContext(backupPath),
      );
      if (!valid.ok)
        throw new W5BackupRefusedError(
          'corrupt-backup',
          valid.errors.join('; '),
        );
    }
    // Flush the copied directory tree before publishing the verified record.
    const folders = new Set(
      files.map((file) => dirname(join(directory, 'files', file.path))),
    );
    for (const folder of Array.from(folders)) await syncDirectory(folder);
    await syncDirectory(join(directory, 'files'));
    await durableWrite(
      join(directory, 'record.pending'),
      JSON.stringify(record, null, 2),
    );
    await rename(
      join(directory, 'record.pending'),
      join(directory, 'record.json'),
    );
    await syncDirectory(directory);
    await syncToDataRoot(parent, context.dataRoot);
    return backupPath;
  }
  throw new W5BackupRefusedError(
    'source-changed',
    'capture exhausted 3 attempts',
  );
}

async function checkImages(
  directory: string,
  files: readonly BackupFile[],
): Promise<Image[]> {
  const images: Image[] = [];
  for (const file of files) {
    const bytes = await readW5FileBytes(join(directory, 'files'), file.path);
    if (
      (bytes?.length ?? 0) !== file.byteLength ||
      (bytes === null ? null : digest(bytes)) !== file.sha256
    )
      throw new W5BackupRefusedError('corrupt-backup', file.path);
    if (bytes !== null) validateW5Document(bytes, file.path);
    images.push({ file, bytes });
  }
  return images;
}
function isRevisionMap(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (revision) =>
        typeof revision === 'number' &&
        Number.isSafeInteger(revision) &&
        revision >= 0,
    )
  );
}
function isBackupFile(value: unknown): value is BackupFile {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    NAMESPACES.some((namespace) => namespace === value.namespace) &&
    typeof value.byteLength === 'number' &&
    Number.isSafeInteger(value.byteLength) &&
    value.byteLength >= 0 &&
    (value.sha256 === null ||
      (typeof value.sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(value.sha256))) &&
    (value.schemaVersion === 1 || value.schemaVersion === 'none') &&
    isRevisionMap(value.revisions)
  );
}

/** Revalidates C3 and all bytes on every use; never trusts an in-memory flag. */
export async function verifyW5Backup(
  context: W5BackupReadContext,
  backupPath: string,
): Promise<W5BackupRecord> {
  if (!/^w5\/backups\/[a-z0-9-]+$/.test(backupPath))
    throw new W5BackupRefusedError('corrupt-backup', backupPath);
  const directory = await recoveryDirectory(
    context.dataRoot,
    backupPath,
    false,
  );
  const bytes = await readW5FileBytes(directory, 'record.json');
  if (bytes === null)
    throw new W5BackupRefusedError('incomplete-backup', backupPath);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new W5BackupRefusedError('corrupt-backup', 'record.json');
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isRecord(value.position) ||
    typeof value.position.commitId !== 'number' ||
    !Number.isSafeInteger(value.position.commitId) ||
    value.position.commitId < 0 ||
    typeof value.position.schemaVersion !== 'number' ||
    !Number.isSafeInteger(value.position.schemaVersion) ||
    value.position.schemaVersion < 1 ||
    !isRevisionMap(value.position.revisions) ||
    !Array.isArray(value.files) ||
    !value.files.every(isBackupFile) ||
    !Array.isArray(value.namespaces) ||
    value.namespaces.length !== 3
  )
    throw new W5BackupRefusedError('corrupt-backup', 'record.json');
  const position: Position = {
    commitId: value.position.commitId,
    schemaVersion: value.position.schemaVersion,
    revisions: value.position.revisions,
  };
  for (const key of Object.keys(position.revisions)) {
    if (resourceKey(resourceFromKey(key)) !== key)
      throw new W5BackupRefusedError('corrupt-backup', key);
  }
  const files: BackupFile[] = value.files;
  const paths = new Set<string>();
  for (const file of files) {
    if (
      paths.has(file.path) ||
      namespaceFor(file.path) !== file.namespace ||
      (file.sha256 === null
        ? file.byteLength !== 0 || file.schemaVersion !== 'none'
        : file.schemaVersion !== 1)
    )
      throw new W5BackupRefusedError('corrupt-backup', file.path);
    paths.add(file.path);
  }
  if (!paths.has('index.json') || !paths.has('index.json.bak'))
    throw new W5BackupRefusedError('incomplete-backup', 'workspace_index');
  const namespaces: NamespaceBackupRecord[] = [];
  for (const [index, namespaceId] of Array.from(NAMESPACES.entries())) {
    const valid = validateNamespaceBackupRecord(
      value.namespaces[index],
      validationContext(backupPath),
    );
    if (
      !valid.ok ||
      valid.record.namespaceId !== namespaceId ||
      valid.record.backupPath !== backupPath ||
      valid.record.sourceRevision !== String(position.commitId) ||
      valid.record.verifiedBy.algorithm !== 'sha256' ||
      valid.record.verifiedBy.digest !==
        namespaceDigest(files, position, namespaceId)
    )
      throw new W5BackupRefusedError('corrupt-backup', namespaceId);
    namespaces.push(valid.record);
  }
  const images = await checkImages(directory, files);
  // Re-discover the copy to prove completeness, including recorded absences.
  const discovered = await scan(join(directory, 'files'), position);
  if (
    !isDeepStrictEqual(
      discovered.map((image) => image.file),
      files,
    )
  )
    throw new W5BackupRefusedError('incomplete-backup', 'file inventory');
  await trialRestore(directory, images);
  return { version: 1, position, files, namespaces };
}

function refuseNewer(current: Position, record: W5BackupRecord): void {
  if (current.schemaVersion !== record.position.schemaVersion)
    throw new W5BackupRefusedError('schema-downgrade', 'commit-log');
  for (const [key, revision] of Object.entries(current.revisions)) {
    if (revision > (record.position.revisions[key] ?? 0))
      throw new W5BackupRefusedError('newer-writes', key);
  }
  // Refuse a different/reset log, even if individual counters happen to match.
  if (
    current.commitId !== record.position.commitId ||
    !isDeepStrictEqual(current.revisions, record.position.revisions)
  )
    throw new W5BackupRefusedError(
      'newer-writes',
      'commit-log position mismatch',
    );
}

/** Rollout gate: verified at/after X and still the exact live snapshot. */
export async function requireVerifiedW5Backup(
  context: W5BackupReadContext,
  backupPath: string,
  minimumCommitId: number,
): Promise<W5BackupRecord> {
  const record = await verifyW5Backup(context, backupPath);
  if (
    !Number.isSafeInteger(minimumCommitId) ||
    minimumCommitId < 0 ||
    record.position.commitId < minimumCommitId
  )
    throw new W5BackupRefusedError(
      'incomplete-backup',
      'rollout revision floor',
    );
  const current = await context.host.snapshot();
  refuseNewer(current, record);
  const live = await scan(join(context.dataRoot, 'workspaces'), current);
  if (
    !isDeepStrictEqual(
      live.map((image) => image.file),
      record.files,
    )
  )
    throw new W5BackupRefusedError('source-changed', 'rollout live inventory');
  if (!isDeepStrictEqual(current, await context.host.snapshot()))
    throw new W5BackupRefusedError('source-changed', 'rollout commit-log');
  return record;
}

export interface W5RestoreRequest {
  readonly source: 'offline_maintenance';
  readonly backupPath: string;
  readonly exclusive: W5ExclusiveMaintenance;
  /** Explicit operator reason; only readable but invalid JSON can be overridden. */
  readonly unreadableOverride?: string;
}

/** One durable multi-file decision. Recovery completes application on restart. */
export async function restoreW5Backup(
  context: W5BackupContext,
  request: W5RestoreRequest,
): Promise<number> {
  async function requireExclusive(): Promise<void> {
    if (request.source === 'offline_maintenance') {
      if (exclusiveRoots.get(request.exclusive) === resolve(context.dataRoot))
        return;
      // Local import breaks the cycle with the sole production issuer.
      const { isW5MaintenanceHeld, isW5MaintenanceHostHeld } =
        await import('./w5-maintenance');
      if (
        (await isW5MaintenanceHeld(request.exclusive, context.dataRoot)) &&
        (await isW5MaintenanceHostHeld(context.host, context.dataRoot))
      )
        return;
    }
    throw new W5BackupRefusedError('exclusive-required', 'offline maintenance');
  }
  await requireExclusive();
  const record = await verifyW5Backup(context, request.backupPath);
  const restore = async (): Promise<number> => {
    await requireExclusive();
    const current = await context.host.snapshot();
    refuseNewer(current, record);
    const images = await checkImages(
      join(context.dataRoot, request.backupPath),
      record.files,
    );
    const root = join(context.dataRoot, 'workspaces');
    const files = [];
    const overrides: Array<{
      path: string;
      evidencePath: string;
      sha256: string;
      reason: string;
    }> = [];
    const resources = new Map<string, W5Resource>();
    for (const { file, bytes } of images) {
      const live = await readW5FileBytes(root, file.path);
      if (file.sha256 === null && live !== null)
        throw new W5BackupRefusedError('newer-writes', file.path);
      if (live !== null) {
        if (!Buffer.from(live.toString('utf8')).equals(live))
          throw new W5BackupRefusedError('source-unreadable', file.path);
        try {
          validateW5Document(live, file.path);
        } catch (error) {
          if (
            !(error instanceof W5BackupRefusedError) ||
            error.reason === 'schema-downgrade' ||
            !request.unreadableOverride?.trim()
          )
            throw error;
          const evidencePath = `w5/restore-evidence/${randomUUID()}/${file.path}`;
          await recoveryDirectory(
            context.dataRoot,
            dirname(evidencePath),
            true,
          );
          await durableWrite(join(context.dataRoot, evidencePath), live);
          await syncToDataRoot(
            dirname(join(context.dataRoot, evidencePath)),
            context.dataRoot,
          );
          overrides.push({
            path: file.path,
            evidencePath,
            sha256: digest(live),
            reason: request.unreadableOverride,
          });
        }
      }
      files.push({
        path: join(root, file.path),
        contents: bytes === null ? null : bytes.toString('utf8'),
        previousFingerprint: live === null ? null : digest(live),
      });
      for (const key of Object.keys(file.revisions))
        resources.set(key, resourceFromKey(key));
    }
    const backedPaths = new Set(record.files.map((file) => file.path));
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        validateId(entry.name, 'workspace directory');
        for (const name of ['workspace.json', 'worktrees.json']) {
          const path = `${entry.name}/${name}`;
          if (
            !backedPaths.has(path) &&
            (await readW5FileBytes(root, path)) !== null
          )
            throw new W5BackupRefusedError('newer-writes', path);
        }
      }
    }
    const advance = Array.from(resources.values());
    let outcome;
    try {
      await requireExclusive();
      outcome = await context.host.commit({
        operation: 'w5.backup.restore',
        expectedRevisions: advance.map((resource) => ({
          resource,
          revision: current.revisions[resourceKey(resource)] ?? 0,
        })),
        advance,
        files,
        outcome: {
          backupPath: request.backupPath,
          sourceCommitId: record.position.commitId,
          overrides,
        },
      });
    } catch (error) {
      if (
        error instanceof W5CommitRefusedError &&
        error.reason === 'revision-conflict'
      )
        throw new W5BackupRefusedError(
          'newer-writes',
          typeof error.details.resource === 'string'
            ? error.details.resource
            : 'commit-log',
        );
      throw error;
    }
    if (outcome.status !== 'applied')
      throw new W5BackupRecoveryError(outcome.commitId);
    return outcome.commitId;
  };
  if (exclusiveRoots.get(request.exclusive) === resolve(context.dataRoot))
    return withStorageAdmission(PROJECT_W5_STORAGE, restore);
  const { withW5MaintenanceRestoreStorage } = await import('./w5-maintenance');
  return withW5MaintenanceRestoreStorage(
    request.exclusive,
    context.dataRoot,
    restore,
  );
}
