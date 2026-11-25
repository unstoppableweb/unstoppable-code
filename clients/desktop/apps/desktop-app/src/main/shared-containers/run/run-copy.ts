import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  getSharedContainerRunRepoDir,
  getSharedContainerRunRootDir,
  getSharedContainersRootDir,
} from '../../lib/paths';
import { SharedContainerReplicaStore } from '../replica/store';
import {
  MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
  isAnySharedContainerRevisionLayout,
} from '@canopy/protocol/shared-containers';
import { validateMaterializedRelativePath } from '../materialize/path-safety';

interface RunManifest {
  version: 1;
  state: 'pending' | 'committed';
  revisionId: string;
  repositories: Record<string, string[]>;
}

export interface SharedContainerRunCopyState {
  state: 'missing' | 'pending' | 'committed';
  revisionId?: string;
}

const activeRefreshes = new Set<string>();

function manifestPath(containerId: string): string {
  return join(
    getSharedContainerRunRootDir(containerId),
    '.canopy-run-manifest.json',
  );
}

function assertBelow(root: string, path: string): void {
  const candidate = resolve(path);
  const resolvedRoot = resolve(root);
  if (
    candidate !== resolvedRoot &&
    !candidate.startsWith(`${resolvedRoot}${sep}`)
  ) {
    throw new Error('Shared-container run path escaped its root');
  }
}

async function readManifest(containerId: string): Promise<RunManifest | null> {
  try {
    const value: unknown = JSON.parse(
      await readFile(manifestPath(containerId), 'utf8'),
    );
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    const record = value as Record<string, unknown>;
    if (
      record.version !== 1 ||
      (record.state !== 'pending' && record.state !== 'committed') ||
      typeof record.revisionId !== 'string' ||
      !record.repositories ||
      typeof record.repositories !== 'object' ||
      Array.isArray(record.repositories)
    ) {
      return null;
    }
    const repositories: Record<string, string[]> = {};
    for (const [repoId, paths] of Object.entries(record.repositories)) {
      if (!/^[A-Za-z0-9_-]+$/.test(repoId) || !Array.isArray(paths))
        return null;
      if (!paths.every((path) => typeof path === 'string' && path.length > 0))
        return null;
      try {
        repositories[repoId] = (paths as string[]).map((path) =>
          validateMaterializedRelativePath(path.normalize('NFC')),
        );
      } catch {
        return null;
      }
    }
    return {
      version: 1,
      state: record.state,
      revisionId: record.revisionId,
      repositories,
    };
  } catch {
    return null;
  }
}

async function writeManifest(
  containerId: string,
  manifest: RunManifest,
): Promise<void> {
  const path = manifestPath(containerId);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

async function prepareRunRoot(containerId: string): Promise<string> {
  const root = getSharedContainerRunRootDir(containerId);
  const existing = await lstat(root).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
    throw new Error('Shared-container run root must be a real directory');
  }
  await mkdir(root, { recursive: true });
  return root;
}

async function enumerateSource(root: string): Promise<string[]> {
  const paths: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.toLowerCase() === '.git') continue;
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute)
        .split(sep)
        .join('/')
        .normalize('NFC');
      paths.push(path);
      if (entry.isDirectory()) await visit(absolute);
    }
  }
  await visit(root);
  return paths.sort((left, right) => left.localeCompare(right));
}

async function removeDeclared(
  root: string,
  paths: readonly string[],
): Promise<void> {
  for (const path of [...paths].sort(
    (a, b) => b.split('/').length - a.split('/').length,
  )) {
    const target = join(root, ...path.split('/'));
    assertBelow(root, target);
    const segments = relative(root, target).split(sep).filter(Boolean);
    let current = root;
    let removed = false;
    for (let index = 0; index < segments.length; index += 1) {
      current = join(current, segments[index]);
      const info = await lstat(current).catch((error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw error;
      });
      if (!info) break;
      if (info.isSymbolicLink()) {
        await unlink(current);
        removed = true;
        break;
      }
      if (index < segments.length - 1 && !info.isDirectory()) break;
      if (index === segments.length - 1) {
        await rm(current, { recursive: true, force: true });
        removed = true;
      }
    }
    if (!removed) continue;
    let parent = dirname(target);
    while (parent !== root) {
      try {
        await rmdir(parent);
      } catch {
        break;
      }
      parent = dirname(parent);
    }
  }
}

async function ensureRealDestinationParents(
  root: string,
  parent: string,
): Promise<void> {
  assertBelow(root, parent);
  const segments = relative(root, parent).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const info = await lstat(current).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw error;
    });
    if (info?.isSymbolicLink()) {
      await unlink(current);
      await mkdir(current);
    } else if (info && !info.isDirectory()) {
      await rm(current, { recursive: true, force: true });
      await mkdir(current);
    } else if (!info) {
      await mkdir(current);
    }
  }
}

async function copyEntry(
  sourceRoot: string,
  destinationRoot: string,
  path: string,
): Promise<void> {
  const source = join(sourceRoot, ...path.split('/'));
  const destination = join(destinationRoot, ...path.split('/'));
  assertBelow(destinationRoot, destination);
  const info = await lstat(source);
  await ensureRealDestinationParents(destinationRoot, dirname(destination));
  if (info.isSymbolicLink()) {
    const target = await readlink(source);
    // Recreate only links that stay within the repository copy. The replica
    // materializer already enforces this for ordinary artifacts; checking it
    // again here makes the writable derivation safe even if its source or
    // manifest was tampered with locally.
    assertBelow(destinationRoot, resolve(dirname(destination), target));
    await rm(destination, { recursive: true, force: true });
    await symlink(target, destination);
  } else if (info.isDirectory()) {
    const destinationInfo = await lstat(destination).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (destinationInfo && !destinationInfo.isDirectory()) {
      await rm(destination, { recursive: true, force: true });
    }
    await mkdir(destination, { recursive: true });
    await chmod(destination, 0o700);
  } else if (info.isFile()) {
    await rm(destination, { recursive: true, force: true });
    await copyFile(source, destination);
    await chmod(destination, (info.mode & 0o111) === 0 ? 0o600 : 0o700);
  } else {
    throw new Error(
      'Shared-container run source contains an unsupported entry',
    );
  }
}

export async function refreshSharedContainerRunCopy(
  containerId: string,
  store = new SharedContainerReplicaStore(getSharedContainersRootDir()),
  expectedRevisionId?: string,
): Promise<string> {
  if (activeRefreshes.has(containerId)) {
    throw new Error('Shared-container run copy refresh is already in progress');
  }
  activeRefreshes.add(containerId);
  try {
    const state = await store.get(containerId);
    if (state?.status !== 'available' && state?.status !== 'pinned') {
      throw new Error('Shared-container revision is not available');
    }
    if (
      expectedRevisionId !== undefined &&
      state.revisionId !== expectedRevisionId
    ) {
      throw new Error(
        'Shared-container revision changed before materialization',
      );
    }
    const revisionRoot = await store.resolveRevisionRootForRead(
      containerId,
      state.revisionId,
    );
    const layoutValue: unknown = JSON.parse(
      (
        await store.readBoundedFileForRead(
          revisionRoot,
          store.resolvePathBelowForRead(
            revisionRoot,
            'artifacts',
            'container.json',
          ),
          MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
        )
      ).toString('utf8'),
    );
    if (!isAnySharedContainerRevisionLayout(layoutValue)) {
      throw new Error('Shared-container layout is invalid');
    }
    const layout = layoutValue;
    const runRoot = await prepareRunRoot(containerId);
    const previous = await readManifest(containerId);
    const fullRebuild = !previous || previous.state === 'pending';
    const incrementalManifest = fullRebuild ? null : previous;
    const repositories: Record<string, string[]> = {};
    const caseRenameRepos = new Set<string>();
    for (const repository of layout.repositories) {
      if (!/^[A-Za-z0-9_-]+$/.test(repository.repoId)) {
        throw new Error('Shared-container repository id is invalid');
      }
      const sourceRoot = join(revisionRoot, 'repos', repository.repoId);
      const paths = await enumerateSource(sourceRoot);
      const oldPaths =
        incrementalManifest?.repositories[repository.repoId] ?? [];
      const oldCase = new Map(
        oldPaths.map((path) => [path.normalize('NFC').toLowerCase(), path]),
      );
      const caseRename = paths.some((path) => {
        const old = oldCase.get(path.normalize('NFC').toLowerCase());
        return old !== undefined && old !== path;
      });
      if (caseRename) caseRenameRepos.add(repository.repoId);
      repositories[repository.repoId] = paths;
    }
    const pending: RunManifest = {
      version: 1,
      state: 'pending',
      revisionId: state.revisionId,
      repositories,
    };
    await writeManifest(containerId, pending);
    if (fullRebuild) {
      for (const entry of await readdir(runRoot)) {
        if (entry === '.canopy-run-manifest.json') continue;
        await rm(join(runRoot, entry), { recursive: true, force: true });
      }
    }
    for (const repoId of Array.from(caseRenameRepos)) {
      await rm(getSharedContainerRunRepoDir(containerId, repoId), {
        recursive: true,
        force: true,
      });
    }
    for (const [repoId, paths] of Object.entries(repositories)) {
      const destinationRoot = getSharedContainerRunRepoDir(containerId, repoId);
      await ensureRealDestinationParents(runRoot, destinationRoot);
      await chmod(destinationRoot, 0o700);
      const oldPaths = incrementalManifest?.repositories[repoId] ?? [];
      await removeDeclared(
        destinationRoot,
        oldPaths.filter((path) => !paths.includes(path)),
      );
      const sourceRoot = join(revisionRoot, 'repos', repoId);
      for (const path of paths)
        await copyEntry(sourceRoot, destinationRoot, path);
    }
    for (const repoId of Object.keys(incrementalManifest?.repositories ?? {})) {
      if (!(repoId in repositories)) {
        await removeDeclared(
          getSharedContainerRunRepoDir(containerId, repoId),
          incrementalManifest?.repositories[repoId] ?? [],
        );
      }
    }
    await writeManifest(containerId, { ...pending, state: 'committed' });
    return runRoot;
  } finally {
    activeRefreshes.delete(containerId);
  }
}

export async function getSharedContainerRunCopyState(
  containerId: string,
): Promise<SharedContainerRunCopyState> {
  const manifest = await readManifest(containerId);
  if (!manifest) return { state: 'missing' };
  return { state: manifest.state, revisionId: manifest.revisionId };
}

/**
 * Lazily creates a run copy without treating every Run/terminal gesture as a
 * refresh. Once committed, publisher-declared paths change only through the
 * explicit update action; this preserves recipient edits until they agree to
 * the documented publisher-wins refresh.
 */
export async function ensureSharedContainerRunCopy(
  containerId: string,
  store = new SharedContainerReplicaStore(getSharedContainersRootDir()),
  expectedRevisionId?: string,
): Promise<string> {
  const state = await getSharedContainerRunCopyState(containerId);
  if (state.state === 'committed') {
    if (
      expectedRevisionId !== undefined &&
      state.revisionId !== expectedRevisionId
    ) {
      throw new Error('Shared-container revision changed before execution');
    }
    return getSharedContainerRunRootDir(containerId);
  }
  return refreshSharedContainerRunCopy(containerId, store, expectedRevisionId);
}

export async function measureSharedContainerRunCopyBytes(
  containerId: string,
  signal?: AbortSignal,
): Promise<bigint> {
  const root = getSharedContainerRunRootDir(containerId);
  async function measure(path: string): Promise<bigint> {
    // A cancelled caller stops the walk before its next entry.
    signal?.throwIfAborted();
    let info;
    try {
      info = await lstat(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return BigInt(0);
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) return info.size;
    let total = info.size;
    for (const entry of await readdir(path))
      total += await measure(join(path, entry));
    return total;
  }
  return measure(root);
}
