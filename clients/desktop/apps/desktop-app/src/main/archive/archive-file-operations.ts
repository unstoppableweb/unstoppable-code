import { constants, createReadStream, type Stats } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { WINDOWS_ARCHIVE_QUARANTINE_RETRY_DELAYS_MS } from '../lib/archive-quarantine';
import { isErrnoException } from '../lib/type-guards';
import { archiveRemovalError } from './archive-removal-error';
import type { ArchivePayloadCopyEntry } from './archive-io-protocol';

function assertContained(root: string, path: string, label: string): void {
  if (!isAbsolute(root) || !isAbsolute(path)) {
    throw new Error(`${label} must be absolute.`);
  }
  const candidate = relative(resolve(root), resolve(path));
  if (
    isAbsolute(candidate) ||
    candidate === '..' ||
    candidate.startsWith(`..${sep}`)
  ) {
    throw new Error(`${label} is outside its approved root.`);
  }
}

async function canonicalApprovedRoot(
  root: string,
  label: string,
): Promise<string> {
  const info = await lstat(root);
  if (info.isSymbolicLink()) {
    throw new Error(`${label}'s approved root cannot be a symbolic link.`);
  }
  if (!info.isDirectory()) {
    throw new Error(`${label}'s approved root must be a directory.`);
  }
  return realpath(root);
}

async function assertApprovedRootUnchanged(
  root: string,
  expectedCanonicalRoot: string,
  label: string,
): Promise<void> {
  const canonicalRoot = await canonicalApprovedRoot(root, label);
  if (canonicalRoot !== expectedCanonicalRoot) {
    throw new Error(`${label}'s approved root changed during the operation.`);
  }
}

async function deepestExistingPath(path: string): Promise<string> {
  let candidate = resolve(path);
  for (;;) {
    try {
      await realpath(candidate);
      return candidate;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function assertCanonicalContained(
  root: string,
  path: string,
  label: string,
  options: { rootMustExist: boolean; pathMustExist: boolean },
): Promise<{ root: string; path: string }> {
  assertContained(root, path, label);
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const existingRoot = await deepestExistingPath(resolvedRoot);
  if (options.rootMustExist && existingRoot !== resolvedRoot) {
    throw Object.assign(new Error(`${label} root does not exist.`), {
      code: 'ENOENT',
    });
  }
  if (existingRoot === resolvedRoot) {
    const rootInfo = await lstat(resolvedRoot);
    if (rootInfo.isSymbolicLink()) {
      throw new Error(`${label} root cannot be a symbolic link.`);
    }
  }
  const canonicalRoot = resolve(
    await realpath(existingRoot),
    relative(existingRoot, resolvedRoot),
  );

  let current = resolvedRoot;
  const suffix = relative(resolvedRoot, resolvedPath);
  for (const component of suffix ? suffix.split(sep) : []) {
    current = resolve(current, component);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') break;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`${label} cannot traverse a symbolic link.`);
    }
  }

  const existingPath = await deepestExistingPath(resolvedPath);
  if (options.pathMustExist && existingPath !== resolvedPath) {
    throw Object.assign(new Error(`${label} does not exist.`), {
      code: 'ENOENT',
    });
  }
  const canonicalPath = resolve(
    await realpath(existingPath),
    relative(existingPath, resolvedPath),
  );
  assertContained(canonicalRoot, canonicalPath, label);
  return { root: canonicalRoot, path: canonicalPath };
}

async function pathBytes(path: string): Promise<number> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) return info.size;
    let total = 0;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      total += await pathBytes(resolve(path, entry.name));
    }
    return total;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return 0;
    throw error;
  }
}

export async function measureDirectoryBytes(
  directory: string,
): Promise<number> {
  try {
    return await pathBytes(directory);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return 0;
    throw error;
  }
}

export async function copyArchivePayload(args: {
  sourceRoots: readonly string[];
  destinationRoot: string;
  entries: readonly ArchivePayloadCopyEntry[];
  signal: AbortSignal;
  onProgress?: (progress: { files: number; bytes: number }) => void;
}): Promise<{ files: number; directories: number; bytes: number }> {
  const approvedSources = await Promise.all(
    args.sourceRoots.map(async (root) => ({
      lexical: resolve(root),
      canonical: (
        await assertCanonicalContained(root, root, 'Archive payload source', {
          rootMustExist: false,
          pathMustExist: false,
        })
      ).root,
    })),
  );
  const canonicalDestinationRoot = (
    await assertCanonicalContained(
      args.destinationRoot,
      args.destinationRoot,
      'Archive payload destination',
      { rootMustExist: false, pathMustExist: false },
    )
  ).root;
  const assertDestination = async (
    path: string,
    options: { rootMustExist: boolean; pathMustExist: boolean },
  ): Promise<void> => {
    const validated = await assertCanonicalContained(
      args.destinationRoot,
      path,
      'Archive payload destination',
      options,
    );
    if (validated.root !== canonicalDestinationRoot) {
      throw new Error('Archive payload destination root changed during copy.');
    }
  };
  let files = 0;
  let directories = 0;
  let bytes = 0;
  for (const entry of args.entries) {
    if (args.signal.aborted) throw new Error('Archive I/O request cancelled.');
    const approvedSource = approvedSources.find((source) => {
      try {
        assertContained(source.lexical, entry.source, 'Archive payload source');
        return true;
      } catch {
        return false;
      }
    });
    if (!approvedSource) {
      throw new Error('Archive payload source is outside its approved roots.');
    }
    try {
      const sourcePath = await assertCanonicalContained(
        approvedSource.lexical,
        entry.source,
        'Archive payload source',
        { rootMustExist: false, pathMustExist: true },
      );
      assertContained(
        approvedSource.canonical,
        sourcePath.path,
        'Archive payload source',
      );
    } catch (error) {
      if (
        entry.missingSource === 'ignore' &&
        isErrnoException(error) &&
        error.code === 'ENOENT'
      ) {
        continue;
      }
      throw error;
    }
    await assertDestination(entry.destination, {
      rootMustExist: false,
      pathMustExist: false,
    });
    let info;
    try {
      info = await lstat(entry.source);
    } catch (error) {
      if (
        entry.missingSource === 'ignore' &&
        isErrnoException(error) &&
        error.code === 'ENOENT'
      ) {
        continue;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error('Archive payload roots cannot be symbolic links.');
    }
    if (entry.kind === 'directory' && !info.isDirectory()) {
      throw new Error('Archive payload directory source is not a directory.');
    }
    if (entry.kind === 'file' && !info.isFile()) {
      throw new Error('Archive payload file source is not a file.');
    }
    await mkdir(dirname(entry.destination), { recursive: true });
    await assertDestination(entry.destination, {
      rootMustExist: true,
      pathMustExist: false,
    });
    let copiedBytes = 0;
    if (entry.kind === 'directory' && entry.contentsOnly === true) {
      const excluded = new Set(entry.excludeNames ?? []);
      let destinationCreated = false;
      for (const child of await readdir(entry.source, {
        withFileTypes: true,
      })) {
        if (excluded.has(child.name)) continue;
        if (!destinationCreated) {
          await mkdir(entry.destination, { recursive: true });
          await assertDestination(entry.destination, {
            rootMustExist: true,
            pathMustExist: true,
          });
          destinationCreated = true;
        }
        await assertDestination(resolve(entry.destination, child.name), {
          rootMustExist: true,
          pathMustExist: false,
        });
        await cp(
          resolve(entry.source, child.name),
          resolve(entry.destination, child.name),
          {
            recursive: true,
            force: true,
            verbatimSymlinks: true,
          },
        );
      }
      if (destinationCreated) copiedBytes = await pathBytes(entry.destination);
    } else {
      await assertDestination(entry.destination, {
        rootMustExist: true,
        pathMustExist: false,
      });
      await cp(entry.source, entry.destination, {
        recursive: entry.kind === 'directory',
        force: true,
        verbatimSymlinks: true,
      });
      copiedBytes = await pathBytes(entry.destination);
    }
    bytes += copiedBytes;
    if (entry.kind === 'directory') directories += 1;
    else files += 1;
    args.onProgress?.({ files, bytes });
  }
  return { files, directories, bytes };
}

/** The codes Node's own `rm` retries, with its linear backoff. */
const ARCHIVE_TREE_RETRY_CODES = new Set([
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'ENOTEMPTY',
  'EPERM',
]);
const ARCHIVE_TREE_RETRY_DELAY_MS = 200;

function isArchiveTreeRetryable(error: unknown): boolean {
  return (
    isErrnoException(error) &&
    error.code !== undefined &&
    ARCHIVE_TREE_RETRY_CODES.has(error.code)
  );
}

/**
 * Removes an already-authorized tree, repairing only owned directory modes.
 * The caller checks `assertUnchanged` before the first pass; each retry checks
 * it again, since `rm`'s own retries would re-walk the path unchecked.
 *
 * Residual: Node has no descriptor-relative removal (no `unlinkat`/`openat`),
 * so each pass walks `path` by name. A same-user actor that replaces `path`
 * between the last check and a pass, or during one, gets that replacement
 * removed. Revisit if Node gains descriptor-relative removal.
 */
export async function removeArchiveTree(
  path: string,
  permissionRoot: string,
  assertUnchanged: () => Promise<void>,
  options: { maxRetries: number; diagnosticRoot?: string },
): Promise<void> {
  const diagnosticRoot = options.diagnosticRoot ?? permissionRoot;
  const repaired = new Set<string>();
  let retries = 0;
  for (;;) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      if (isArchiveTreeRetryable(error) && retries < options.maxRetries) {
        // Each failed re-read spends a retry, so the budget and backoff stay
        // those of Node's own `rm` retries.
        for (;;) {
          retries += 1;
          await new Promise((resolveDelay) =>
            setTimeout(resolveDelay, retries * ARCHIVE_TREE_RETRY_DELAY_MS),
          );
          try {
            // Gone already is done, as `rm` with `force` treats it.
            if (!(await lstatIfPresent(path))) return;
            await assertUnchanged();
            break;
          } catch (rereadError) {
            const goneSince =
              isErrnoException(rereadError) &&
              rereadError.code === 'ENOENT' &&
              (await lstatIfPresent(path).then(
                (info) => info === null,
                () => false,
              ));
            if (goneSince) return;
            // Windows reports EPERM, or EACCES, to `lstat` too while a delete
            // is pending. Only a definite answer (a mismatch or another error)
            // stops.
            const pendingDelete =
              isArchiveTreeRetryable(rereadError) ||
              (hostOperatingSystem() === 'win32' &&
                isErrnoException(rereadError) &&
                rereadError.code === 'EACCES');
            if (!pendingDelete || retries >= options.maxRetries) {
              throw archiveRemovalError(rereadError, diagnosticRoot);
            }
          }
        }
        continue;
      }
      const owner = process.getuid?.();
      if (
        owner === undefined ||
        !isErrnoException(error) ||
        error.code !== 'EACCES' ||
        (error.syscall !== 'unlink' && error.syscall !== 'rmdir') ||
        typeof error.path !== 'string'
      ) {
        throw archiveRemovalError(error, diagnosticRoot);
      }
      await assertUnchanged();
      assertContained(path, error.path, 'Archive permission recovery target');
      const directory = dirname(error.path);
      const canonical = await assertCanonicalContained(
        permissionRoot,
        directory,
        'Archive permission recovery directory',
        { rootMustExist: true, pathMustExist: true },
      );
      const info = await lstat(canonical.path);
      if (
        !info.isDirectory() ||
        info.uid !== owner ||
        (info.mode & 0o700) === 0o700 ||
        repaired.has(canonical.path)
      ) {
        throw error;
      }
      // A sealed directory needs owner write permission to unlink its entries.
      // Use a no-follow descriptor so a replacement symlink cannot be chmodded.
      const handle = await open(
        canonical.path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const opened = await handle.stat();
        await assertUnchanged();
        await assertCanonicalContained(
          permissionRoot,
          directory,
          'Archive permission recovery directory',
          { rootMustExist: true, pathMustExist: true },
        );
        const current = await lstat(canonical.path);
        if (
          !opened.isDirectory() ||
          opened.dev !== info.dev ||
          opened.ino !== info.ino ||
          opened.birthtimeMs !== info.birthtimeMs ||
          current.dev !== opened.dev ||
          current.ino !== opened.ino ||
          current.birthtimeMs !== opened.birthtimeMs ||
          opened.uid !== owner ||
          current.uid !== owner
        ) {
          throw error;
        }
        await assertUnchanged();
        await handle.chmod((current.mode & 0o7777) | 0o700);
        repaired.add(canonical.path);
      } finally {
        await handle.close();
      }
      await assertUnchanged();
      // A repaired pass starts with the full retry budget.
      retries = 0;
    }
  }
}

interface ArchiveStatIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
}

function hasIdentity(info: Stats, identity: ArchiveStatIdentity): boolean {
  return (
    !info.isSymbolicLink() &&
    info.dev === identity.dev &&
    info.ino === identity.ino &&
    info.birthtimeMs === identity.birthtimeMs
  );
}

async function lstatIfPresent(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * CAN-5334: removes the directory with `expected` identity by first renaming
 * it to `asidePath`, a sibling only this removal uses, and removing it there.
 * Whatever reoccupies `path` during the walk is never reached. A crash after
 * the rename leaves the directory at `asidePath`, which a retry finishes.
 * The aside is identity-checked right before each removal pass; a swap of
 * the aside itself after that check is `removeArchiveTree`'s residual.
 */
async function removeBoundArchiveDirectory(args: {
  path: string;
  allowedRoot: string;
  expected: ArchiveStatIdentity;
  asidePath: string;
  signal?: AbortSignal;
}): Promise<void> {
  const label = 'Archive removal path';
  const windows = hostOperatingSystem() === 'win32';
  const aborted = (): void => {
    if (args.signal?.aborted) throw new Error('Archive I/O request cancelled.');
  };
  const parentPath = dirname(resolve(args.path));
  if (
    dirname(resolve(args.asidePath)) !== parentPath ||
    basename(args.asidePath) === basename(args.path)
  ) {
    throw new Error('Archive removal aside must be a sibling of its target.');
  }
  if (
    !(await lstatIfPresent(args.path)) &&
    !(await lstatIfPresent(args.asidePath))
  )
    return;
  const canonicalRoot = await canonicalApprovedRoot(args.allowedRoot, label);
  // Rejects a symlink anywhere between the root and the parent.
  const parent = await assertCanonicalContained(
    args.allowedRoot,
    parentPath,
    label,
    { rootMustExist: true, pathMustExist: true },
  );
  if (parent.root !== canonicalRoot) {
    throw new Error(`${label}'s approved root changed during the operation.`);
  }
  const target = join(parent.path, basename(args.path));
  const aside = join(parent.path, basename(args.asidePath));
  const assertRoot = async (): Promise<void> => {
    aborted();
    await assertApprovedRootUnchanged(args.allowedRoot, canonicalRoot, label);
  };

  let asideInfo = await lstatIfPresent(aside);
  if (asideInfo && !hasIdentity(asideInfo, args.expected)) {
    throw new Error(
      'Archive removal aside is occupied by another directory; it was preserved.',
    );
  }
  if (!asideInfo) {
    const targetInfo = await lstatIfPresent(target);
    if (!targetInfo) return;
    if (targetInfo.isSymbolicLink()) {
      throw new Error('Archive removal path cannot be a symbolic link.');
    }
    if (!hasIdentity(targetInfo, args.expected)) {
      throw new Error('Archive removal path changed identity.');
    }
    for (let attempt = 0; ; attempt++) {
      await assertRoot();
      if (await lstatIfPresent(aside)) {
        throw new Error(
          'Archive removal aside appeared before the move; it was preserved.',
        );
      }
      const current = await lstatIfPresent(target);
      if (!current || !hasIdentity(current, args.expected)) {
        throw new Error('Archive removal path changed identity.');
      }
      try {
        await rename(target, aside);
        break;
      } catch (error) {
        // The quarantine move's budget: the same checkout, the same handles.
        const delay = windows
          ? WINDOWS_ARCHIVE_QUARANTINE_RETRY_DELAYS_MS[attempt]
          : undefined;
        if (
          delay === undefined ||
          !isErrnoException(error) ||
          (error.code !== 'EBUSY' &&
            error.code !== 'EPERM' &&
            error.code !== 'EACCES')
        ) {
          // Never an in-place fallback: that walk is the race this closes.
          if (isErrnoException(error) && error.code === 'EPERM')
            throw archiveRemovalError(error, canonicalRoot);
          const code =
            isErrnoException(error) && error.code ? ` (${error.code})` : '';
          throw new Error(
            `The directory could not be moved aside for removal${code}, so nothing was removed. Close anything using it and retry.`,
          );
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      }
    }
    asideInfo = await lstat(aside);
    if (!hasIdentity(asideInfo, args.expected)) {
      // The rename took a directory swapped in after the last check: return it.
      if (!(await lstatIfPresent(target))) {
        await rename(aside, target).catch(() => undefined);
      }
      throw new Error('Archive removal path changed identity.');
    }
  }
  const assertAsideUnchanged = async (): Promise<void> => {
    await assertRoot();
    const current = await lstat(aside);
    if (!hasIdentity(current, args.expected)) {
      throw new Error('Archive removal aside changed identity.');
    }
    aborted();
  };
  await assertAsideUnchanged();
  if (asideInfo.isDirectory()) {
    await removeWindowsReparsePoints(aside);
    await assertAsideUnchanged();
  }
  await removeArchiveTree(aside, aside, assertAsideUnchanged, {
    maxRetries: windows ? 50 : 2,
  });
}

export async function removeArchiveDirectory(args: {
  path: string;
  allowedRoot: string;
  /** With `asidePath`: remove only this directory, by moving it aside first. */
  expectedIdentity?: ArchiveStatIdentity;
  asidePath?: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (args.signal?.aborted) throw new Error('Archive I/O request cancelled.');
  assertContained(args.allowedRoot, args.path, 'Archive removal path');
  if (resolve(args.path) === resolve(args.allowedRoot)) {
    throw new Error('Archive removal cannot target its approved root.');
  }
  if ((args.expectedIdentity === undefined) !== (args.asidePath === undefined))
    throw new Error(
      'Archive removal needs both an expected identity and an aside path.',
    );
  if (args.expectedIdentity && args.asidePath) {
    assertContained(args.allowedRoot, args.asidePath, 'Archive removal aside');
    await removeBoundArchiveDirectory({
      path: args.path,
      allowedRoot: args.allowedRoot,
      expected: args.expectedIdentity,
      asidePath: args.asidePath,
      signal: args.signal,
    });
    return;
  }
  let targetInfo;
  try {
    targetInfo = await lstat(args.path);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return;
    throw error;
  }
  if (targetInfo.isSymbolicLink()) {
    throw new Error('Archive removal path cannot be a symbolic link.');
  }
  const canonicalRoot = await canonicalApprovedRoot(
    args.allowedRoot,
    'Archive removal path',
  );
  const canonicalPath = await realpath(args.path);
  assertContained(canonicalRoot, canonicalPath, 'Archive removal path');
  if (canonicalPath === canonicalRoot) {
    throw new Error('Archive removal cannot target its approved root.');
  }
  const assertUnchanged = async (): Promise<void> => {
    if (args.signal?.aborted) throw new Error('Archive I/O request cancelled.');
    await assertApprovedRootUnchanged(
      args.allowedRoot,
      canonicalRoot,
      'Archive removal path',
    );
    const current = await lstat(canonicalPath);
    if (
      current.isSymbolicLink() ||
      current.dev !== targetInfo.dev ||
      current.ino !== targetInfo.ino ||
      current.birthtimeMs !== targetInfo.birthtimeMs
    ) {
      throw new Error('Archive removal path changed identity.');
    }
    if (args.signal?.aborted) throw new Error('Archive I/O request cancelled.');
  };
  // Re-checked before each pass over the tree. An unbound removal still walks
  // the path in place; a discard binds its identity and moves it aside instead.
  await assertUnchanged();
  if (targetInfo.isDirectory()) {
    await removeWindowsReparsePoints(canonicalPath);
    await assertUnchanged();
  }
  await removeArchiveTree(canonicalPath, canonicalPath, assertUnchanged, {
    maxRetries: process.platform === 'win32' ? 50 : 2,
    // Name unbound targets (including reset entries) without widening recovery.
    diagnosticRoot: dirname(canonicalPath),
  });
}

export async function resetArchiveDirectory(args: {
  path: string;
  allowedRoot: string;
  preserveNames: readonly string[];
  signal?: AbortSignal;
}): Promise<number> {
  assertContained(args.allowedRoot, args.path, 'Archive reset path');
  if (resolve(args.path) === resolve(args.allowedRoot)) {
    throw new Error('Archive reset cannot target its approved root.');
  }
  let targetInfo;
  try {
    targetInfo = await lstat(args.path);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return 0;
    throw error;
  }
  if (targetInfo.isSymbolicLink()) {
    throw new Error('Archive reset path cannot be a symbolic link.');
  }
  if (!targetInfo.isDirectory()) {
    throw new Error('Archive reset path must be a directory.');
  }
  const canonicalRoot = await canonicalApprovedRoot(
    args.allowedRoot,
    'Archive reset path',
  );
  const canonicalPath = await realpath(args.path);
  assertContained(canonicalRoot, canonicalPath, 'Archive reset path');
  if (canonicalPath === canonicalRoot) {
    throw new Error('Archive reset cannot target its approved root.');
  }
  await assertApprovedRootUnchanged(
    args.allowedRoot,
    canonicalRoot,
    'Archive reset path',
  );
  const preserved = new Set(args.preserveNames);
  let entries;
  try {
    entries = await readdir(canonicalPath, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return 0;
    throw error;
  }
  let removedEntries = 0;
  for (const entry of entries) {
    if (preserved.has(entry.name)) continue;
    await assertApprovedRootUnchanged(
      args.allowedRoot,
      canonicalRoot,
      'Archive reset path',
    );
    await removeArchiveDirectory({
      path: resolve(canonicalPath, entry.name),
      allowedRoot: canonicalRoot,
      signal: args.signal,
    });
    removedEntries += 1;
  }
  return removedEntries;
}

async function removeWindowsReparsePoints(directory: string): Promise<void> {
  if (process.platform !== 'win32') return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    let info;
    try {
      info = await lstat(entryPath);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink()) {
      await rm(entryPath, { recursive: true, force: true });
    } else if (info.isDirectory()) {
      await removeWindowsReparsePoints(entryPath);
    }
  }
}

export async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function streamFileBytes(path: string): Promise<number> {
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const value: unknown = chunk;
    if (!Buffer.isBuffer(value)) {
      throw new Error('Archive file stream produced a non-buffer chunk.');
    }
    bytes += value.byteLength;
  }
  return bytes;
}
