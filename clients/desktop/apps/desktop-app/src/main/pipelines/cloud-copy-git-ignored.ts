import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { getEnhancedEnv } from '@canopy/execution-engine/pipelines/config-paths';
import { getResolvedGitExecutableForSpawn } from '../lib/git-executable';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** Runs git in `cwd` and returns its stdout; rejects when git fails. */
export type RunGit = (cwd: string, args: readonly string[]) => Promise<string>;

/**
 * Git runs inside the skill or plugin being copied, and in every repository
 * nested in it, and those folders may come from anywhere. Their own config
 * must not run anything: `core.fsmonitor` names a command git runs when it
 * reads the index, so it is turned off on the command line, which wins over
 * any repository's config, along with the untracked cache and hooks. No
 * pager and no terminal prompt, so nothing can wait on input, and no
 * optional locks, so nothing in the folder is written. The user's global
 * config still applies, for its excludes file.
 */
const UNTRUSTED_REPOSITORY_ARGS = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  `core.hooksPath=${os.devNull}`,
] as const;

const runGit: RunGit = async (cwd, args) => {
  const { stdout } = await execFileAsync(
    await getResolvedGitExecutableForSpawn(),
    [...UNTRUSTED_REPOSITORY_ARGS, ...args],
    {
      cwd,
      env: {
        ...getEnhancedEnv({ includeCanopySecrets: false, environment: false }),
        LC_ALL: 'C',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'utf8',
    },
  );
  return stdout;
};

const succeeds = (pending: Promise<unknown>): Promise<boolean> =>
  pending.then(
    () => true,
    () => false,
  );

/** The paths git ignores under `dir`, from `dir`'s own repository. */
async function listIgnored(
  dir: string,
  run: RunGit,
): Promise<readonly string[] | null> {
  let listed: string;
  try {
    listed = await run(dir, [
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
    ]);
  } catch {
    return null;
  }
  return listed
    .split('\0')
    .map((entry) => entry.replace(/\/$/, ''))
    .filter((entry) => entry !== '')
    .map((entry) => path.resolve(dir, entry));
}

/** Whether `dir` holds a repository of its own: a `.git` folder or file. */
function holdsRepository(dir: string): boolean {
  try {
    fs.lstatSync(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Git's answer for a member's folder in a cloud copy (CAN-6176): whether a
 * path under it is ignored, or withheld because git couldn't answer for the
 * repository nested there; and whether git answered for the folder's own
 * repository. When it didn't, the copy reports the check unavailable.
 */
export interface GitIgnoredAnswer {
  isIgnored: (absolutePath: string) => boolean;
  checked: boolean;
}

/**
 * Whether the repository holding `root` ignores a path under it, for a cloud
 * copy of a skill or plugin (CAN-6176). `checked` is false when git can't
 * answer for `root` (no git, a timeout, or `root` isn't in a repository).
 * A root git ignores as a whole gives no file-by-file answer, so nothing
 * under it counts as ignored by that repository.
 *
 * Git answers for one repository at a time and never looks inside a checkout
 * nested in it, so each nested repository under `root` (an embedded checkout,
 * a submodule, or a worktree whose `.git` is a file) is asked from its own
 * root. That happens whatever the outer answer was, an ignored root
 * included. One whose answer can't be had (no git, a broken or missing
 * gitdir) counts as ignored whole: nothing in it is copied unchecked.
 */
export async function gitIgnoredPredicate(
  root: string,
  run: RunGit = runGit,
): Promise<GitIgnoredAnswer> {
  const base = path.resolve(root);
  // Paths are compared as the disk spells them, so another spelling of the
  // root (case on a case-insensitive disk, or a link to it) still reaches
  // the checks below rather than counting as outside it.
  const canonicalBase = canonicalPath(base);
  const inside = (candidate: string): boolean => {
    const relative = path.relative(canonicalBase, candidate);
    return (
      relative !== '' &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  // `ls-files --directory` fails inside a folder git ignores as a whole.
  const outer = (await succeeds(run(base, ['check-ignore', '-q', '--', base])))
    ? []
    : await listIgnored(base, run);
  const ignored = new Set<string>();
  // And by file identity: a case-insensitive disk opens `ZZ-private.md` as
  // the ignored `zz-private.md`, so the path text alone can miss it.
  const ignoredFiles = new Set<string>();
  const add = (absolute: string): void => {
    ignored.add(canonicalPath(absolute));
    const id = fileIdentity(absolute);
    if (id !== null) ignoredFiles.add(id);
  };
  for (const absolute of outer ?? []) add(absolute);
  const isIgnored = (absolutePath: string): boolean => {
    for (
      let current = canonicalPath(absolutePath);
      inside(current);
      current = path.dirname(current)
    ) {
      if (ignored.has(current)) return true;
      const id = ignoredFiles.size === 0 ? null : fileIdentity(current);
      if (id !== null && ignoredFiles.has(id)) return true;
    }
    return false;
  };
  // Every folder under `root` git hasn't already ruled out, nested
  // repositories asked as they're reached, so their ignores prune the walk.
  const pending: string[] = [base];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git') continue;
      const child = path.join(dir, entry.name);
      if (isIgnored(child)) continue;
      if (holdsRepository(child)) {
        const nested = await listIgnored(child, run);
        if (nested === null) {
          add(child);
          continue;
        }
        for (const absolute of nested) add(absolute);
      }
      pending.push(child);
    }
  }
  return { isIgnored, checked: outer !== null };
}

/**
 * A path as the disk spells it: its nearest existing ancestor resolved with
 * `realpath` (which gives a case-insensitive disk's own casing and follows
 * links), with the rest of the path after it.
 */
function canonicalPath(absolutePath: string): string {
  const resolved = path.resolve(absolutePath);
  const rest: string[] = [];
  for (let current = resolved; ; current = path.dirname(current)) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      rest.push(path.basename(current));
    }
  }
}

/** The file or folder a path names, by device and inode; null when absent. */
function fileIdentity(absolutePath: string): string | null {
  try {
    const stat = fs.lstatSync(absolutePath, { bigint: true });
    return `${String(stat.dev)}:${String(stat.ino)}`;
  } catch {
    return null;
  }
}
