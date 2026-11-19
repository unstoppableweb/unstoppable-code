import { execFile } from 'node:child_process';
import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import type { WorktreeDiscardSourceState } from '@canopy/protocol/remote-control/shell';
import { getResolvedGitExecutableForSpawn } from './git-executable';
import { archiveGitEnv } from './git-tree-snapshot';
import { isErrnoException } from './type-guards';

/**
 * CAN-5334 source classification, the discard's own (a worker concern: it
 * only probes the filesystem and Git, read-only). A source is gone only when
 * Git itself works and the path is absent or not a repository; every other
 * outcome is `unverified`, which keeps the ordinary retry refusal.
 */

const GIT_PROBE_TIMEOUT_MS = 10_000;
const STATUS_PROBE_TIMEOUT_MS = 5_000;

interface GitRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runGitProbe(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
): Promise<GitRun> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      executable,
      args,
      {
        cwd,
        env,
        timeout,
        maxBuffer: 1024 * 1024,
        // Ignored outside Windows.
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ code: 0, stdout, stderr });
          return;
        }
        // A spawn failure (ENOENT, ENOTDIR, a timeout kill) is no exit status.
        const code: unknown = 'code' in error ? error.code : undefined;
        if (typeof code === 'number' && !error.killed)
          resolvePromise({ code, stdout, stderr });
        else
          reject(
            error instanceof Error ? error : new Error('Git probe failed'),
          );
      },
    );
  });
}

/** Whether Git can be resolved and runs at all; otherwise nothing is gone. */
export async function isGitUsable(): Promise<boolean> {
  try {
    const executable = await getResolvedGitExecutableForSpawn(process.env);
    const run = await runGitProbe(
      executable,
      ['--version'],
      process.cwd(),
      archiveGitEnv(),
      GIT_PROBE_TIMEOUT_MS,
    );
    return run.code === 0 && /^git version /.test(run.stdout);
  } catch {
    return false;
  }
}

const NOT_A_REPOSITORY = /^fatal: not a git repository/m;
// `safe.directory` refusals also exit 128; they prove nothing about the source.
const DUBIOUS_OWNERSHIP = /dubious ownership|safe\.directory/;

/**
 * Directories that hold removable or network volumes. An absent source whose
 * deepest existing ancestor is one of them may sit on a disconnected volume
 * (CAN-5334 Q2 B), so it is unverified, not gone. A heuristic: network and
 * FUSE mounts elsewhere still look gone.
 */
function isMountParent(path: string): boolean {
  const resolved = resolve(path);
  const root = parse(resolved).root;
  if (resolved === root) return true;
  const parts = resolved.slice(root.length).split(sep).filter(Boolean);
  if (hostPlatformOperatingSystem() === 'win32') return false;
  if (parts.length === 1)
    return ['Volumes', 'media', 'mnt', 'net', 'Network'].includes(parts[0]);
  if (parts.length === 2) return parts[0] === 'media' || parts[0] === 'run';
  return parts.length === 3 && parts[0] === 'run' && parts[1] === 'media';
}

/**
 * A mount point left behind with nothing mounted on it (an empty `/mnt/data`
 * on its parent's device) is a missing mount root too.
 */
async function isUnmountedMountPoint(path: string): Promise<boolean> {
  const parent = dirname(path);
  // Top-level directories such as `/home` often share the root's device.
  if (parent === parse(parent).root || !isMountParent(parent)) return false;
  try {
    const [own, above] = await Promise.all([lstat(path), lstat(parent)]);
    return own.dev === above.dev;
  } catch {
    return true;
  }
}

/** What the first `lstat` of a source path leads to. */
export type SourcePathStep =
  /** Git decides: `available`, `gone-not-a-repository` or `unverified`. */
  | 'probe-git'
  /** Present, and no repository nor a directory Git could run in. */
  | 'not-a-repository'
  /** Absent: gone unless it may sit on a missing mount (Q2 B). */
  | 'check-absent'
  | 'unverified';

type SourcePathEntry = Pick<
  Stats,
  | 'isDirectory'
  | 'isSymbolicLink'
  | 'isFile'
  | 'isFIFO'
  | 'isSocket'
  | 'isCharacterDevice'
  | 'isBlockDevice'
>;

/** ENOTDIR: an ancestor is not a directory, so the path cannot exist. */
const ABSENT_ERRNO_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

/**
 * The one table for the first step (review r3 finding 1). A link (a junction
 * lstats as one) goes to Git, whose probe follows it: a dangling link or one
 * to a non-directory fails to spawn, so it is unverified. Every errno other
 * than an absent one (EACCES, EPERM, ELOOP, EIO) proves nothing.
 */
export function sourcePathStep(
  entry:
    | { readonly stats: SourcePathEntry }
    | { readonly errorCode: string | undefined },
): SourcePathStep {
  if ('errorCode' in entry)
    return entry.errorCode !== undefined &&
      ABSENT_ERRNO_CODES.has(entry.errorCode)
      ? 'check-absent'
      : 'unverified';
  const { stats } = entry;
  if (stats.isDirectory() || stats.isSymbolicLink()) return 'probe-git';
  if (
    stats.isFile() ||
    stats.isFIFO() ||
    stats.isSocket() ||
    stats.isCharacterDevice() ||
    stats.isBlockDevice()
  )
    return 'not-a-repository';
  return 'unverified';
}

async function deepestExistingAncestor(path: string): Promise<string | null> {
  for (let current = dirname(resolve(path)); ; current = dirname(current)) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (
        !isErrnoException(error) ||
        error.code === undefined ||
        !ABSENT_ERRNO_CODES.has(error.code)
      )
        return null;
    }
    if (dirname(current) === current) return null;
  }
}

export interface ClassifiedSource {
  state: WorktreeDiscardSourceState;
  /** The real Git common directory of an available source. */
  gitCommonDir?: string;
}

/**
 * Classifies one configured source path. Call only after
 * {@link isGitUsable} returned true.
 */
export async function classifyWorktreeSource(
  sourcePath: string,
): Promise<ClassifiedSource> {
  if (!isAbsolute(sourcePath)) return { state: 'unverified' };
  const step = sourcePathStep(
    await lstat(sourcePath).then(
      (stats) => ({ stats }),
      (error: unknown) => ({
        errorCode: isErrnoException(error) ? error.code : undefined,
      }),
    ),
  );
  if (step === 'unverified') return { state: 'unverified' };
  if (step === 'not-a-repository') return { state: 'gone-not-a-repository' };
  if (step === 'check-absent') {
    const ancestor = await deepestExistingAncestor(sourcePath);
    return ancestor !== null &&
      !isMountParent(ancestor) &&
      !(await isUnmountedMountPoint(ancestor))
      ? { state: 'gone-absent' }
      : { state: 'unverified' };
  }
  let executable: string;
  try {
    executable = await getResolvedGitExecutableForSpawn(process.env);
  } catch {
    return { state: 'unverified' };
  }
  const probe = async (ceiling: boolean): Promise<GitRun | null> =>
    runGitProbe(
      executable,
      ['rev-parse', '--git-common-dir'],
      sourcePath,
      {
        ...archiveGitEnv(),
        ...(ceiling ? { GIT_CEILING_DIRECTORIES: dirname(sourcePath) } : {}),
      },
      GIT_PROBE_TIMEOUT_MS,
    ).catch(() => null);
  const own = await probe(true);
  if (own === null) return { state: 'unverified' };
  if (own.code === 0) {
    const reported = own.stdout.trim();
    try {
      return {
        state: 'available',
        gitCommonDir: await realpath(resolve(sourcePath, reported)),
      };
    } catch {
      return { state: 'unverified' };
    }
  }
  if (
    own.code !== 128 ||
    !NOT_A_REPOSITORY.test(own.stderr) ||
    DUBIOUS_OWNERSHIP.test(own.stderr)
  )
    return { state: 'unverified' };
  // A source configured inside an enclosing repository resolves through it;
  // that may be how it was configured, so it is not proven gone.
  const enclosing = await probe(false);
  if (
    enclosing === null ||
    enclosing.code !== 128 ||
    !NOT_A_REPOSITORY.test(enclosing.stderr) ||
    DUBIOUS_OWNERSHIP.test(enclosing.stderr)
  )
    return { state: 'unverified' };
  return { state: 'gone-not-a-repository' };
}

/**
 * Best effort, read-only and time-bounded: whether an available source's
 * checkout holds changes a discard would delete.
 */
export async function readUncommittedChanges(
  checkoutPath: string,
): Promise<boolean | 'unknown'> {
  try {
    const executable = await getResolvedGitExecutableForSpawn(process.env);
    const run = await runGitProbe(
      executable,
      // No optional locks: a status refresh would otherwise rewrite the index.
      [
        '--no-optional-locks',
        'status',
        '--porcelain',
        '--untracked-files=normal',
      ],
      checkoutPath,
      { ...archiveGitEnv(), GIT_CEILING_DIRECTORIES: dirname(checkoutPath) },
      STATUS_PROBE_TIMEOUT_MS,
    );
    return run.code === 0 ? run.stdout.trim().length > 0 : 'unknown';
  } catch {
    return 'unknown';
  }
}
