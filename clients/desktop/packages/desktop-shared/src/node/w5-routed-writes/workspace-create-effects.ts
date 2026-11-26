import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { BRAND } from '@canopy/brand/current';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  parseGitBranchName,
  parseRemoteDefaultBranch,
} from '@canopy/core-runtime/node/git';
import { normalizeRepositoryCloneUrl } from '@canopy/protocol/remote-control/shell';
import { getGitExecutableCommand } from '../../lib/git-executable';
import type { CanopyJsonFile } from '../../types';
import {
  getCanopyJsonPath,
  getProjectConfigFileCandidates,
  parseCanopyJson,
} from '../lib/canopy-json';
import { isMissingFileError } from '../lib/fs-utils';
import { linkAgentsMdToClaudeMd } from '../lib/workspace-source-repo';

const execute = promisify(execFile);

async function workspaceGitOutput(
  args: string[],
  cwd?: string,
): Promise<string> {
  const { stdout } = await execute(getGitExecutableCommand(process.env), args, {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: hostOperatingSystem() === 'win32',
  });
  return stdout;
}

async function workspaceGit(args: string[], cwd?: string): Promise<string> {
  return (await workspaceGitOutput(args, cwd)).trim();
}

function gitExitCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? Reflect.get(error, 'code')
    : undefined;
}

export async function workspaceRemote(
  repoPath: string,
): Promise<string | null> {
  // An absent origin is normal; a broken repository is not absence.
  const names = await workspaceGit(['remote'], repoPath);
  return names.split(/\r?\n/).includes('origin')
    ? workspaceGit(['remote', 'get-url', 'origin'], repoPath)
    : null;
}

export async function isWorkspaceGitRepository(
  folder: string,
): Promise<boolean> {
  try {
    await workspaceGit(['rev-parse', '--git-dir'], folder);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'code') === 128
    )
      return false;
    throw error;
  }
}

export async function workspacePathExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

/** Source files are not W5 records. Absence is proved without swallowing I/O errors. */
export async function readWorkspaceSource(
  folder: string,
): Promise<CanopyJsonFile | null> {
  for (const candidate of getProjectConfigFileCandidates(folder)) {
    let stat;
    try {
      stat = await lstat(candidate);
    } catch (error) {
      if (isMissingFileError(error)) continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('The project source config is not a regular file.');
    return parseCanopyJson(await readFile(candidate, 'utf8'), candidate);
  }
  return null;
}

/** Never truncate a config created between discovery and creation. */
export async function ensureWorkspaceSource(
  folder: string,
  signal: AbortSignal,
): Promise<CanopyJsonFile> {
  const existing = await readWorkspaceSource(folder);
  if (existing) return existing;
  signal.throwIfAborted();
  try {
    await writeFile(getCanopyJsonPath(folder), '{"version":1}\n', {
      flag: 'wx',
    });
    return { version: 1 };
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      Reflect.get(error, 'code') !== 'EEXIST'
    )
      throw error;
    const winner = await readWorkspaceSource(folder);
    if (!winner)
      throw new Error('The project source config changed during import.');
    return winner;
  }
}

export async function availableWorkspacePath(
  base: string,
  preferred: string,
  available: (candidate: string) => Promise<boolean> = () =>
    Promise.resolve(true),
): Promise<string> {
  for (let suffix = 1; suffix <= 10000; suffix += 1) {
    const candidate = join(
      base,
      suffix === 1 ? preferred : `${preferred}-${suffix}`,
    );
    if (!(await workspacePathExists(candidate)) && (await available(candidate)))
      return candidate;
  }
  throw new Error('No available project directory.');
}

export async function acquireWorkspacePath(
  folder: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await mkdir(dirname(folder), { recursive: true });
  signal.throwIfAborted();
  await mkdir(folder);
}

/**
 * CAN-7209: Git couldn't read the branch a fresh clone's HEAD names. Thrown
 * into provisioning's existing failure path; the clone is left as evidence.
 */
export class ClonedHeadUnreadableError extends Error {
  readonly code = 'invalid-remote-default-branch';

  constructor(folder: string) {
    super(
      `Couldn't use the repository cloned to ${folder}. Git can't read the branch it checked out.`,
    );
    this.name = 'ClonedHeadUnreadableError';
  }
}

export async function cloneWorkspaceSource(
  url: string,
  folder: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await workspaceGit(['clone', '--', normalizeRepositoryCloneUrl(url), folder]);
  // No abort check here: a finished clone is always checked before it is kept.
  await neutralizeClonedHead(folder);
}

/**
 * CAN-7209: checks the branch a clone checked out with the shared validator.
 * Clone drops or fails on names Git's ref format refuses, so a refused name
 * here is one Git accepts (a leading '-', or HEAD) and the clone still
 * succeeds. An option-like name is taken off HEAD so HEAD reads never return it.
 */
async function neutralizeClonedHead(folder: string): Promise<void> {
  let head: string;
  try {
    head = (
      await workspaceGitOutput(['symbolic-ref', '--quiet', 'HEAD'], folder)
    ).replace(/\r?\n$/, '');
  } catch (error) {
    // 1: a detached HEAD. 128: Git can't read HEAD's target, as every later
    // command that reads it would also find.
    if (gitExitCode(error) === 1) return;
    if (gitExitCode(error) === 128) throw new ClonedHeadUnreadableError(folder);
    throw error;
  }
  const prefix = 'refs/heads/';
  if (!head.startsWith(prefix)) return;
  const branch = head.slice(prefix.length);
  if (parseRemoteDefaultBranch(branch, 'clone-head') || !branch.startsWith('-'))
    return;
  if (await clonedHeadHasCommit(folder)) {
    // Detached at the same commit; the tree and the local branch are kept.
    await workspaceGit(
      [
        'update-ref',
        '--no-deref',
        '-m',
        'clone: detach from an option-like branch name',
        'HEAD',
        'HEAD',
      ],
      folder,
    );
    return;
  }
  // An unborn HEAD can't detach; it takes the branch `git init` would use.
  await workspaceGit(
    [
      'symbolic-ref',
      '-m',
      'clone: replace an option-like branch name',
      'HEAD',
      `refs/heads/${await initialBranchName(folder)}`,
    ],
    folder,
  );
}

async function clonedHeadHasCommit(folder: string): Promise<boolean> {
  try {
    await workspaceGit(['rev-parse', '--verify', '--quiet', 'HEAD'], folder);
    return true;
  } catch (error) {
    if (gitExitCode(error) === 1) return false;
    throw error;
  }
}

async function initialBranchName(folder: string): Promise<string> {
  // What `git init` reads on every Git version; older Git has no
  // `git var GIT_DEFAULT_BRANCH`. 'master' is Git's built-in default.
  const configured = await workspaceGit(
    ['config', '--get', 'init.defaultBranch'],
    folder,
  ).catch(() => '');
  return parseGitBranchName(configured) ?? 'master';
}

export async function initializeWorkspaceSource(
  folder: string,
  name: string,
  multi: boolean,
  instructions: string,
  signal: AbortSignal,
  profile?: 'cli',
): Promise<void> {
  signal.throwIfAborted();
  await workspaceGit(['init'], folder);
  if (multi) {
    signal.throwIfAborted();
    await writeFile(join(folder, '.gitignore'), 'repos/\n', { flag: 'wx' });
    signal.throwIfAborted();
    await writeFile(
      getCanopyJsonPath(folder),
      JSON.stringify({ version: 1, repos: [] }, null, 2) + '\n',
      { flag: 'wx' },
    );
    signal.throwIfAborted();
    await writeFile(join(folder, 'CLAUDE.md'), instructions, { flag: 'wx' });
    signal.throwIfAborted();
    await linkAgentsMdToClaudeMd(folder);
  } else if (profile === 'cli') {
    await ensureWorkspaceSource(folder, signal);
  } else {
    signal.throwIfAborted();
    await writeFile(join(folder, 'README.md'), `# ${name}\n`, { flag: 'wx' });
    signal.throwIfAborted();
    await writeFile(
      join(folder, '.gitignore'),
      `# ${BRAND.displayName} multi-repo child repositories\nrepos/\n`,
      { flag: 'wx' },
    );
    signal.throwIfAborted();
    await ensureWorkspaceSource(folder, signal);
  }
  signal.throwIfAborted();
  await workspaceGit(
    [
      'add',
      ...(multi
        ? ['-A']
        : profile === 'cli'
          ? [basename(getCanopyJsonPath(folder))]
          : ['README.md', '.gitignore', basename(getCanopyJsonPath(folder))]),
    ],
    folder,
  );
  signal.throwIfAborted();
  await workspaceGit(
    [
      '-c',
      `user.name=${BRAND.displayName}`,
      '-c',
      `user.email=${BRAND.internalName}@local.invalid`,
      'commit',
      '-m',
      multi
        ? 'Initialize project source repo'
        : profile === 'cli'
          ? `Initialize ${BRAND.displayName} workspace`
          : 'Initial commit',
    ],
    folder,
  );
}
