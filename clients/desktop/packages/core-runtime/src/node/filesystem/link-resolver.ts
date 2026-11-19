import { lstat, realpath, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import {
  basename,
  isAbsolute,
  join,
  parse,
  posix,
  relative,
  sep,
  win32,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  WORKER_FILESYSTEM_LINK_MAX_PATH_LENGTH,
  type WorkerFilesystemLinkResolveMode,
  type WorkerFilesystemLinkResolveResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import { hasGitPathSegment } from './directory-reader';
import type { FilesystemRoot } from './root-catalog';
import { isSafeFilesystemRelativePath } from './relative-path';

// Ported from the desktop `file-reference:resolve` (markdown) and Portal
// `resolveRemoteControlFileLink` (transcript) resolvers (CAN-5038); the
// `worker.filesystem.link.resolve` spec states the same rules.

export type FilesystemLinkFailure =
  | 'notFound'
  | 'ambiguous'
  | 'outsideRoots'
  | 'symlinkEscape'
  | 'unsupported';

const FAILURES: Readonly<
  Record<
    FilesystemLinkFailure,
    { kind: CanopyOperationError['payload']['kind']; message: string }
  >
> = {
  notFound: {
    kind: 'not_found',
    message: 'The link target does not exist.',
  },
  ambiguous: {
    kind: 'failed_precondition',
    message: 'The link matches a file in more than one root.',
  },
  outsideRoots: {
    kind: 'not_found',
    message: 'The link target is outside the workspace roots.',
  },
  symlinkEscape: {
    kind: 'not_found',
    message: 'The link target is a symlink that leaves its root.',
  },
  unsupported: {
    kind: 'invalid_argument',
    message: 'The link is not a workspace file link.',
  },
};

/** A typed `worker.filesystem.link.*` failure. */
export function filesystemLinkError(
  reason: FilesystemLinkFailure,
): CanopyOperationError {
  const failure = FAILURES[reason];
  return new CanopyOperationError({
    kind: failure.kind,
    code: `worker.filesystem.link.${reason}`,
    message: failure.message,
    retry: { kind: 'never' },
  });
}

/** Test seam for the filesystem calls the resolution depends on. */
export interface FilesystemLinkIo {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<Stats>;
  lstat(path: string): Promise<Stats>;
}

const NODE_IO: FilesystemLinkIo = {
  realpath: (path) => realpath(path),
  stat: (path) => stat(path),
  lstat: (path) => lstat(path),
};

export type FilesystemLinkRoot = Pick<
  FilesystemRoot,
  'id' | 'name' | 'absolutePath'
>;

/**
 * The file a markdown link is relative to. `root` is the portable form; a
 * trusted in-process host passes `host` for a base it cannot express as a
 * root-relative file (outside every root, a directory spelling).
 */
export type FilesystemLinkBase =
  | { kind: 'root'; fileRootId: string; relativePath: string }
  | { kind: 'host'; absolutePath: string };

export interface FilesystemLinkResolveInput {
  /** Every root of the scope, in catalog order. */
  readonly roots: readonly FilesystemLinkRoot[];
  readonly mode: WorkerFilesystemLinkResolveMode;
  readonly href: string;
  readonly base?: FilesystemLinkBase;
  readonly io?: FilesystemLinkIo;
}

export interface FilesystemLinkResolved {
  /** The canonical result, without a catalog revision. */
  readonly result: WorkerFilesystemLinkResolveResult;
  /** The matched root's trusted path, for in-process projections only. */
  readonly rootAbsolutePath: string;
}

/** The legacy containment test: equal, or under `root` plus a separator. */
function isPathInsideRoot(pathValue: string, rootPath: string): boolean {
  return pathValue === rootPath || pathValue.startsWith(`${rootPath}${sep}`);
}

function toPortableRelative(rootReal: string, targetReal: string): string {
  return relative(rootReal, targetReal).split(sep).join('/');
}

function createFileUrlFromAbsolutePath(pathValue: string): URL {
  return pathToFileURL(pathValue, {
    windows:
      /^[a-zA-Z]:[\\/]/.test(pathValue) ||
      pathValue.startsWith('\\\\') ||
      pathValue.startsWith('//'),
  });
}

/** A `file:` URL's path, keeping a drive letter or a UNC host. */
export function fileUrlToAbsolutePath(url: URL): string {
  const pathname = decodeURIComponent(url.pathname);
  if (/^\/[a-zA-Z]:($|\/)/.test(pathname)) {
    return pathname.slice(1);
  }
  return url.host ? `//${url.host}${pathname}` : pathname;
}

/**
 * The host path a markdown link names: the root-name/id first-segment
 * shortcut, else URL resolution against the base file. `null` is a link that
 * names no local file (empty, a fragment, protocol-relative, another scheme,
 * malformed percent-encoding).
 */
export function markdownLinkCandidatePath(
  baseAbsolutePath: string,
  href: string,
  roots: readonly Pick<FilesystemLinkRoot, 'id' | 'name' | 'absolutePath'>[],
): string | null {
  if (href.length === 0 || href.startsWith('#') || href.startsWith('//')) {
    return null;
  }
  try {
    const normalizedHref = href.replace(/\\/g, '/');
    const [firstSegment, ...remainingSegments] = normalizedHref.split('/');
    if (
      firstSegment &&
      remainingSegments.length > 0 &&
      !firstSegment.includes(':') &&
      !normalizedHref.startsWith('/')
    ) {
      const matchingRoot = roots.find(
        (root) => root.name === firstSegment || root.id === firstSegment,
      );
      if (matchingRoot) {
        const lastIndex = remainingSegments.length - 1;
        const targetSegments = remainingSegments.map((segment, index) =>
          decodeURIComponent(
            index === lastIndex ? segment.replace(/[?#].*$/, '') : segment,
          ),
        );
        return join(matchingRoot.absolutePath, ...targetSegments);
      }
    }
    const resolvedUrl = new URL(
      href,
      createFileUrlFromAbsolutePath(baseAbsolutePath),
    );
    if (resolvedUrl.protocol !== 'file:') return null;
    return fileUrlToAbsolutePath(resolvedUrl);
  } catch {
    return null;
  }
}

export type TranscriptLinkTarget =
  | { ok: true; absolute: boolean; path: string }
  | { ok: false; reason: 'unsupported' | 'outsideRoots' };

/** A root-relative path with `/` separators, or why it is not one. */
function normalizeTranscriptRelativePath(
  value: string,
):
  | { ok: true; path: string }
  | { ok: false; reason: 'unsupported' | 'outsideRoots' } {
  if (win32.isAbsolute(value) || /^[a-zA-Z]:/.test(value))
    return { ok: false, reason: 'unsupported' };
  // Only Windows treats a backslash as a separator. On POSIX it is a
  // filename character, including when percent-decoded from a transcript.
  const normalizedInput = sep === '\\' ? value.replace(/\\/g, '/') : value;
  if (posix.isAbsolute(normalizedInput))
    return { ok: false, reason: 'unsupported' };
  if (normalizedInput.split('/').some((segment) => segment === '..'))
    return { ok: false, reason: 'outsideRoots' };
  const normalized = posix.normalize(normalizedInput);
  return {
    ok: true,
    path:
      normalized === '.' ? '' : normalized.split('/').filter(Boolean).join('/'),
  };
}

/**
 * Decodes agent transcript link text: a local `file:` URL, absolute host
 * text, or a relative path, without its query or fragment and
 * percent-decoded. Relative paths come back normalized.
 */
export function decodeTranscriptLink(href: string): TranscriptLinkTarget {
  const unsupported: TranscriptLinkTarget = {
    ok: false,
    reason: 'unsupported',
  };
  const trimmed = href.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 4096 ||
    trimmed.split('').some((character) => character.charCodeAt(0) < 32)
  ) {
    return unsupported;
  }

  let decoded: string;
  if (/^file:/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (
        url.protocol !== 'file:' ||
        (url.hostname && url.hostname !== 'localhost')
      ) {
        return unsupported;
      }
      decoded = fileURLToPath(url);
    } catch {
      return unsupported;
    }
  } else {
    const encodedPath = trimmed.split('#', 1)[0]?.split('?', 1)[0] ?? '';
    if (
      /^[a-z][a-z\d+.-]*:/i.test(encodedPath) &&
      !/^[a-z]:[\\/]/i.test(encodedPath)
    ) {
      return unsupported;
    }
    if (/^[\\/]{2}/.test(encodedPath)) return unsupported;
    try {
      // Relative transcript text historically accepts Windows separators on
      // every host. Normalize those before decoding so %5C still names a
      // literal POSIX backslash. Absolute host paths retain their spelling.
      const linkPath =
        posix.isAbsolute(encodedPath) || win32.isAbsolute(encodedPath)
          ? encodedPath
          : encodedPath.replace(/\\/g, '/');
      decoded = decodeURIComponent(linkPath);
    } catch {
      return unsupported;
    }
  }

  if (decoded.length === 0 || decoded.includes('\0')) return unsupported;
  const absolute = posix.isAbsolute(decoded) || win32.isAbsolute(decoded);
  if (absolute) return { ok: true, absolute, path: decoded };
  const normalized = normalizeTranscriptRelativePath(decoded);
  if (!normalized.ok) return normalized;
  if (!normalized.path) return unsupported;
  return { ok: true, absolute, path: normalized.path };
}

/** A root path with any trailing separators removed, keeping a bare root. */
function trimTrailingSeparators(pathValue: string): string {
  const trimmed = pathValue.replace(/[\\/]+$/, '');
  return trimmed === '' ? pathValue : trimmed;
}

/** The host path of a root-relative base file. */
function rootedBasePath(
  roots: readonly FilesystemLinkRoot[],
  base: { fileRootId: string; relativePath: string },
): string {
  const root = roots.find((entry) => entry.id === base.fileRootId);
  if (!root) throw filesystemLinkError('notFound');
  if (
    !isSafeFilesystemRelativePath(
      base.relativePath,
      WORKER_FILESYSTEM_LINK_MAX_PATH_LENGTH,
    )
  )
    throw filesystemLinkError('unsupported');
  // Concatenated, not joined: `join` would collapse a UNC root's `//`.
  return `${trimTrailingSeparators(root.absolutePath)}/${base.relativePath}`;
}

async function resolvedRoots(
  roots: readonly FilesystemLinkRoot[],
  io: FilesystemLinkIo,
): Promise<Array<{ root: FilesystemLinkRoot; real: string } | null>> {
  return Promise.all(
    roots.map(async (root) => {
      try {
        return { root, real: await io.realpath(root.absolutePath) };
      } catch {
        // A missing optional root contains nothing.
        return null;
      }
    }),
  );
}

/**
 * A spelling to compare lexically: on Windows a URL-derived candidate uses
 * `/` while roots use `\`, and case does not distinguish paths.
 */
function comparableSpelling(pathValue: string): string {
  return sep === '\\'
    ? trimTrailingSeparators(pathValue.replace(/\//g, '\\')).toLowerCase()
    : pathValue;
}

type ResolvedRoots = ReadonlyArray<{
  root: FilesystemLinkRoot;
  real: string;
} | null>;

/**
 * Which roots a path's spelling (not its target) lies inside: a root that
 * resolves (its catalog path or its real path), else only roots that cannot
 * be resolved, else none. It only classifies a failure; containment itself is
 * decided by real paths.
 */
function spelledInside(
  candidate: string,
  realRoots: ResolvedRoots,
  allRoots: readonly FilesystemLinkRoot[],
): 'resolvedRoot' | 'unresolvedRoot' | null {
  const spelled = comparableSpelling(candidate);
  const inside = (rootPath: string): boolean =>
    isPathInsideRoot(spelled, comparableSpelling(rootPath));
  let unresolved = false;
  for (let index = 0; index < allRoots.length; index += 1) {
    const root = allRoots[index];
    if (root === undefined) continue;
    const entry = realRoots[index] ?? null;
    if (entry === null) {
      unresolved ||= inside(root.absolutePath);
      continue;
    }
    if (inside(root.absolutePath) || inside(entry.real)) return 'resolvedRoot';
  }
  return unresolved ? 'unresolvedRoot' : null;
}

interface ExistingPart {
  /** The real path of the candidate, else of its deepest resolvable ancestor. */
  readonly real: string;
  readonly exists: boolean;
  /**
   * The entry below that ancestor is a symlink that does not resolve. Where
   * it points is never followed: its target may lie outside every root.
   */
  readonly brokenSymlink: boolean;
}

/**
 * The real path of a candidate's deepest existing part: the candidate itself,
 * else its deepest ancestor whose `realpath` succeeds. `null` when nothing
 * resolves or the candidate is not absolute on this host.
 */
async function deepestExistingRealpath(
  candidate: string,
  io: FilesystemLinkIo,
): Promise<ExistingPart | null> {
  const tryRealpath = async (pathValue: string): Promise<string | null> => {
    try {
      return await io.realpath(pathValue);
    } catch {
      return null;
    }
  };
  const real = await tryRealpath(candidate);
  if (real !== null) return { real, exists: true, brokenSymlink: false };
  if (!isAbsolute(candidate)) return null;
  // Ancestors end before each separator past the filesystem root. Resolving
  // a path resolves each of its ancestors, so existence only shrinks with
  // depth and a binary search finds the deepest one: a link with thousands
  // of missing segments costs a few dozen calls, not one per segment.
  const { root } = parse(candidate);
  const ancestors = [root];
  const separator = sep === '\\' ? /[\\/]/ : /\//;
  for (let index = root.length; index < candidate.length; index += 1)
    if (separator.test(candidate.charAt(index)))
      ancestors.push(candidate.slice(0, index));
  let deepest: { real: string; index: number } | null = null;
  let low = 0;
  let high = ancestors.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const resolved = await tryRealpath(ancestors[middle] ?? '');
    if (resolved === null) {
      high = middle - 1;
    } else {
      deepest = { real: resolved, index: middle };
      low = middle + 1;
    }
  }
  if (deepest === null) return null;
  const below = ancestors[deepest.index + 1] ?? candidate;
  let brokenSymlink = false;
  try {
    brokenSymlink = (await io.lstat(below)).isSymbolicLink();
  } catch {
    // Missing or unreadable: an ordinary missing target.
  }
  return { real: deepest.real, exists: false, brokenSymlink };
}

/**
 * Why a candidate no root owns fails. Classified only by its spelling, so the
 * failure never depends on whether a host path outside the roots exists.
 */
function unownedFailure(
  candidate: string,
  realRoots: ResolvedRoots,
  allRoots: readonly FilesystemLinkRoot[],
): FilesystemLinkFailure {
  switch (spelledInside(candidate, realRoots, allRoots)) {
    case 'resolvedRoot':
      return 'symlinkEscape';
    // Nothing under a root that cannot be resolved exists.
    case 'unresolvedRoot':
      return 'notFound';
    case null:
      return 'outsideRoots';
  }
}

async function resolveMarkdownLink(
  input: FilesystemLinkResolveInput,
  io: FilesystemLinkIo,
): Promise<FilesystemLinkResolved> {
  const { roots, base, href } = input;
  if (!base) throw filesystemLinkError('unsupported');
  const baseAbsolutePath =
    base.kind === 'host' ? base.absolutePath : rootedBasePath(roots, base);
  const candidate = markdownLinkCandidatePath(baseAbsolutePath, href, roots);
  if (candidate === null) throw filesystemLinkError('unsupported');
  // `.git` is never a link target, by its spelling or its resolved path.
  if (hasGitPathSegment(candidate)) throw filesystemLinkError('outsideRoots');
  const realRoots = await resolvedRoots(roots, io);
  // A missing target is classified by where its deepest existing ancestor
  // really lives, so present and missing targets past a symlink that leaves
  // the roots fail alike. Nothing past that point is inspected until a root
  // owns it, so a `.git` outside the roots is never observable either.
  const existing = await deepestExistingRealpath(candidate, io);
  // The first root in catalog order that contains the target answers it.
  const owner =
    existing === null
      ? undefined
      : realRoots.find(
          (entry) =>
            entry !== null &&
            !hasGitPathSegment(entry.real) &&
            isPathInsideRoot(existing.real, entry.real),
        );
  if (!owner || existing === null)
    throw filesystemLinkError(unownedFailure(candidate, realRoots, roots));
  if (hasGitPathSegment(existing.real))
    throw filesystemLinkError('outsideRoots');
  if (!existing.exists)
    throw filesystemLinkError(
      existing.brokenSymlink ? 'symlinkEscape' : 'notFound',
    );
  const targetReal = existing.real;
  let targetStat: Stats;
  try {
    targetStat = await io.stat(targetReal);
  } catch {
    throw filesystemLinkError('notFound');
  }
  const kind = targetStat.isDirectory()
    ? 'directory'
    : targetStat.isFile()
      ? 'file'
      : null;
  if (kind === null) throw filesystemLinkError('unsupported');
  return {
    result: {
      fileRootId: owner.root.id,
      relativePath: toPortableRelative(owner.real, targetReal),
      name: basename(targetReal),
      kind,
    },
    rootAbsolutePath: owner.root.absolutePath,
  };
}

async function resolveTranscriptLink(
  input: FilesystemLinkResolveInput,
  io: FilesystemLinkIo,
): Promise<FilesystemLinkResolved> {
  if (input.base) throw filesystemLinkError('unsupported');
  const link = decodeTranscriptLink(input.href);
  if (!link.ok) throw filesystemLinkError(link.reason);
  const matches: FilesystemLinkResolved[] = [];
  let escaped = false;
  let notFile = false;
  let checked = false;
  const realRoots = await resolvedRoots(input.roots, io);
  const insideAnyRoot = (pathValue: string): boolean =>
    realRoots.some(
      (entry) => entry !== null && isPathInsideRoot(pathValue, entry.real),
    );
  for (const entry of realRoots) {
    if (entry === null) continue;
    checked = true;
    const { root, real: rootReal } = entry;
    const candidate = link.absolute
      ? link.path
      : join(root.absolutePath, ...link.path.split('/'));
    const existing = await deepestExistingRealpath(candidate, io);
    if (existing === null) {
      escaped = true;
      continue;
    }
    if (!existing.exists) {
      // A missing candidate is not a match. It escaped when it passes through
      // a symlink that does not resolve, or its deepest existing ancestor
      // lives outside the root it must stay in: the root it was joined to, or
      // any root for an absolute link.
      if (
        existing.brokenSymlink ||
        (link.absolute
          ? !insideAnyRoot(existing.real)
          : !isPathInsideRoot(existing.real, rootReal))
      )
        escaped = true;
      continue;
    }
    const targetReal = existing.real;
    if (!isPathInsideRoot(targetReal, rootReal)) {
      escaped = true;
      continue;
    }
    try {
      if (!(await io.stat(targetReal)).isFile()) {
        notFile = true;
        continue;
      }
    } catch {
      continue;
    }
    const relativePath = toPortableRelative(rootReal, targetReal);
    if (!relativePath || relativePath.startsWith('../')) continue;
    matches.push({
      result: {
        fileRootId: root.id,
        relativePath,
        name: basename(targetReal),
        kind: 'file',
      },
      rootAbsolutePath: root.absolutePath,
    });
  }
  const [match, ...others] = matches;
  if (match && others.length === 0) return match;
  if (match) throw filesystemLinkError('ambiguous');
  if (notFile) throw filesystemLinkError('unsupported');
  // As in markdown mode, present and missing targets fail alike.
  if (link.absolute && (escaped || !checked))
    throw filesystemLinkError(
      unownedFailure(link.path, realRoots, input.roots),
    );
  throw filesystemLinkError(escaped ? 'symlinkEscape' : 'notFound');
}

/**
 * Resolves one link as `worker.filesystem.link.resolve` specifies, over the
 * scope's roots in catalog order. Failures are typed
 * `worker.filesystem.link.*` errors; host paths stay in this process.
 */
export async function resolveFilesystemLink(
  input: FilesystemLinkResolveInput,
): Promise<FilesystemLinkResolved> {
  const io = input.io ?? NODE_IO;
  return input.mode === 'markdown'
    ? resolveMarkdownLink(input, io)
    : resolveTranscriptLink(input, io);
}
