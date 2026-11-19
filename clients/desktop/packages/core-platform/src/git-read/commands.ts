import path from 'node:path';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import {
  GIT_CONVENTIONAL_DEFAULT_BRANCHES,
  GIT_OBJECT_ID_PATTERN,
  gitChangeSetReadArgs,
  isGitChangeSetRevision,
  type GitChangeSetRange,
  type GitChangeSetRead,
  type GitConventionalDefaultBranch,
  type GitRepositoryRead,
} from '@canopy/core-runtime/node/git';
import { LIBUV_REQUIRED_KEYS, windowsExecutable } from '../supervision/shared';

/** Always caller-supplied; the runner never reads ambient `process.env`. */
export type GitReadEnvironment = Readonly<Record<string, string>>;

/**
 * The fixed command set. Nothing else can be expressed: the only arguments a
 * request supplies are a conventional branch and the change-set reads'
 * revisions, each `HEAD` or a full object id.
 */
export type GitReadCommand =
  | { readonly kind: 'git-head-commit'; readonly executable: string }
  | { readonly kind: 'git-version'; readonly executable: string }
  /** macOS only: `init --bare` into a fresh directory under `temporaryRoot`. */
  | {
      readonly kind: 'git-bare-init-smoke';
      readonly executable: string;
      readonly temporaryRoot: string;
    }
  | {
      readonly kind: 'git-check-ignore';
      readonly executable: string;
      readonly input: Uint8Array;
      /** The `git version` text parsed when `executable` was validated. */
      readonly version?: string;
      /** `executableIdentity` of the file `version` was parsed from. */
      readonly identity?: string;
    }
  /**
   * `ls-files --others --ignored --exclude-standard --directory -z`: one
   * listing of a working tree's ignored untracked paths, run in the request's
   * `cwd`. Versioned as `git-check-ignore`, for the same discharge.
   */
  | {
      readonly kind: 'git-ls-files-ignored';
      readonly executable: string;
      readonly version?: string;
      readonly identity?: string;
    }
  | { readonly kind: 'xcode-select-print-path' }
  /** macOS: `$SHELL || /bin/zsh` from the supplied environment. */
  | { readonly kind: 'macos-login-shell-path' }
  /** Linux: one already-selected candidate shell. */
  | { readonly kind: 'linux-login-shell-path'; readonly shell: string }
  | { readonly kind: 'getent-passwd'; readonly uid: number }
  /** Windows: `where.exe`, resolved through the supplied PATH only. */
  | { readonly kind: 'where-git' }
  | { readonly kind: 'where-winget' }
  /** Repository reads for the `worker.git.*` queries. */
  | { readonly kind: 'git-branch-refs'; readonly executable: string }
  | { readonly kind: 'git-common-dir'; readonly executable: string }
  | { readonly kind: 'git-worktree-list'; readonly executable: string }
  | { readonly kind: 'git-origin-url'; readonly executable: string }
  | { readonly kind: 'git-remote-names'; readonly executable: string }
  | { readonly kind: 'git-dir'; readonly executable: string }
  /** Contacts `origin`: non-interactive, under the request deadline. */
  | { readonly kind: 'git-remote-head'; readonly executable: string }
  | { readonly kind: 'git-origin-head'; readonly executable: string }
  | {
      readonly kind: 'git-origin-branch';
      readonly executable: string;
      readonly branch: GitConventionalDefaultBranch;
    }
  | { readonly kind: 'git-inside-work-tree'; readonly executable: string }
  /** Change-set reads for `worker.git.diff.get` (CAN-4103). */
  | {
      readonly kind: 'git-diff-name-status';
      readonly executable: string;
      readonly range: GitChangeSetRange;
    }
  | {
      readonly kind: 'git-diff-numstat';
      readonly executable: string;
      readonly range: GitChangeSetRange;
    }
  | { readonly kind: 'git-untracked-files'; readonly executable: string }
  | { readonly kind: 'git-unmerged-files'; readonly executable: string }
  | {
      readonly kind: 'git-object-exists';
      readonly executable: string;
      readonly object: string;
    };

export type GitReadCommandKind = GitReadCommand['kind'];

/** Every repository read, including POSIX-only kinds outside the manifest. */
type RepositoryCommandKind = RepositoryManifestKind | 'git-head-commit';

/** The exact E1 repository command manifest Windows runs (CAN-5943). */
type RepositoryManifestKind =
  | 'git-branch-refs'
  | 'git-common-dir'
  | 'git-worktree-list'
  | 'git-origin-url'
  | 'git-remote-names'
  | 'git-dir'
  | 'git-remote-head'
  | 'git-origin-head'
  | 'git-origin-branch'
  | 'git-inside-work-tree'
  | 'git-diff-name-status'
  | 'git-diff-numstat'
  | 'git-untracked-files'
  | 'git-unmerged-files'
  | 'git-object-exists';

/** A selected Git and the `git version` text its validation parsed. */
export interface SelectedGit {
  readonly executable: string;
  readonly version: string | undefined;
  /**
   * `executableIdentity` of the file `version` was parsed from. Without it,
   * or once the started file no longer has it, the version authorizes no
   * fsmonitor discharge.
   */
  readonly identity?: string;
}

/** The `stat` fields that identify one executable file. */
export interface ExecutableStats {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

/** Changes when the file at a path is replaced or rewritten. */
export function executableIdentity(found: ExecutableStats): string {
  return [found.dev, found.ino, found.size, found.mtimeMs, found.ctimeMs].join(
    ':',
  );
}

/** How one command runs. `maxBuffer` limits each stream separately (C7). */
export interface GitReadPlan {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: GitReadEnvironment;
  readonly maxBuffer: number;
  /** Per-probe cap; `undefined` leaves only the request deadline. */
  readonly timeoutMs: number | undefined;
  readonly killMode: 'graceful' | 'force';
  readonly input: Uint8Array | undefined;
}

export type GitReadErrorCode =
  | 'invalid_request'
  | 'unsupported_command'
  | 'command_not_found'
  | 'timeout'
  | 'deadline_exceeded'
  | 'output_limit'
  | 'exit_status'
  | 'cleanup_unconfirmed';

const MESSAGES: Readonly<Record<GitReadErrorCode, string>> = {
  invalid_request: 'Git read request is invalid.',
  unsupported_command: 'Git read command is unavailable on this host.',
  command_not_found: 'Git read command was not found on the supplied PATH.',
  timeout: 'Git read command timed out.',
  deadline_exceeded: 'Git read request deadline exceeded.',
  output_limit: 'Git read command output exceeded its limit.',
  exit_status: 'Git read command failed.',
  cleanup_unconfirmed: 'Git read command cleanup did not complete.',
};

/** Fixed messages only: no paths, arguments, environment, or output. */
export class GitReadError extends Error {
  override readonly name = 'GitReadError';
  readonly code: GitReadErrorCode;
  readonly stream: 'stdout' | 'stderr' | undefined;
  readonly exitCode: number | null | undefined;
  readonly signal: string | null | undefined;
  /** Behind `cleanup_unconfirmed`: the kill failure, else the first failure or abort reason. */
  readonly failure: unknown;

  constructor(
    code: GitReadErrorCode,
    detail: {
      readonly stream?: 'stdout' | 'stderr';
      readonly exitCode?: number | null;
      readonly signal?: string | null;
      readonly failure?: unknown;
    } = {},
  ) {
    super(MESSAGES[code]);
    this.code = code;
    this.failure = detail.failure;
    this.stream = detail.stream;
    this.exitCode = detail.exitCode;
    this.signal = detail.signal;
  }
}

// Desktop's values (git-executable.ts, config-paths.ts, git.ts).
const VALIDATION_TIMEOUT_MS = 5_000;
// desktop-shared git.ts REMOTE_DEFAULT_BRANCH_TIMEOUT_MS and MAX_BUFFER_BYTES;
// worktree-health.ts GIT_HEALTH_TIMEOUT_MS.
const DEFAULT_BRANCH_TIMEOUT_MS = 30_000;
const REPOSITORY_MAX_BUFFER = 8 * 1024 * 1024;
// Desktop's gitChangeSetReads (git.ts), so a large comparison fails alike.
const CHANGE_SET_MAX_BUFFER = 32 * 1024 * 1024;
const HEALTH_TIMEOUT_MS = 5_000;
const LOGIN_SHELL_TIMEOUT_MS = 10_000;
const GETENT_TIMEOUT_MS = 1_000;
const NODE_DEFAULT_MAX_BUFFER = 1024 * 1024;
// Desktop's IGNORED_LISTING_MAX_BUFFER_BYTES (git.ts).
const IGNORED_LISTING_MAX_BUFFER = 64 * 1024 * 1024;
const LINUX_PATH_MARKER = '__CANOPY_LOGIN_PATH__';

/** Pinned against desktop-shared's `sanitizeEnvVars` by a golden test (C3). */
const BLOCKED_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'PYTHONSTARTUP',
  'PYTHONPATH',
]);
const LINUX_STARTUP_KEYS = new Set([
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'BASHOPTS',
  'GCONV_PATH',
  'GLIBC_TUNABLES',
]);

/** Desktop's `getLinuxProbeEnv`, applied to the supplied environment. */
export function linuxProbeEnvironment(
  environment: GitReadEnvironment,
): GitReadEnvironment {
  const kept = Object.entries(environment).filter(([key]) => {
    const name = key.toUpperCase();
    return (
      !name.startsWith('LD_') &&
      !name.startsWith('DYLD_') &&
      !name.startsWith('BASH_FUNC_') &&
      !LINUX_STARTUP_KEYS.has(name) &&
      !BLOCKED_ENV_KEYS.has(name)
    );
  });
  return Object.freeze(Object.fromEntries(kept));
}

/** The bare-init smoke's environment: no `GIT_*`, no system or global config. */
export function bareInitEnvironment(
  environment: GitReadEnvironment,
): GitReadEnvironment {
  return Object.freeze({
    ...Object.fromEntries(
      Object.entries(environment).filter(([key]) => !key.startsWith('GIT_')),
    ),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  });
}

/** Repository reads added after the manifest await their own Windows qualification. */
const POSIX: readonly PlatformOperatingSystem[] = ['darwin', 'linux'];

const REPOSITORY_HOSTS: readonly PlatformOperatingSystem[] = [
  'darwin',
  'linux',
  'win32',
];

/** Potential process creation, not just whether argv names a remote. */
export const REPOSITORY_CLOSURE: Readonly<
  Record<
    RepositoryManifestKind,
    {
      readonly workingTree: boolean;
      readonly helpers:
        | 'none'
        | 'transport'
        | 'filters-or-lazy-fetch'
        | 'lazy-fetch';
    }
  >
> = Object.freeze({
  'git-branch-refs': { workingTree: false, helpers: 'none' },
  'git-common-dir': { workingTree: false, helpers: 'none' },
  'git-worktree-list': { workingTree: false, helpers: 'none' },
  'git-origin-url': { workingTree: false, helpers: 'none' },
  'git-remote-names': { workingTree: false, helpers: 'none' },
  'git-dir': { workingTree: false, helpers: 'none' },
  'git-remote-head': { workingTree: false, helpers: 'transport' },
  'git-origin-head': { workingTree: false, helpers: 'none' },
  'git-origin-branch': { workingTree: false, helpers: 'none' },
  'git-inside-work-tree': { workingTree: false, helpers: 'none' },
  'git-diff-name-status': {
    workingTree: true,
    helpers: 'filters-or-lazy-fetch',
  },
  'git-diff-numstat': { workingTree: true, helpers: 'filters-or-lazy-fetch' },
  'git-untracked-files': { workingTree: true, helpers: 'none' },
  'git-unmerged-files': { workingTree: true, helpers: 'none' },
  'git-object-exists': { workingTree: false, helpers: 'lazy-fetch' },
});

/** One of the manifest's kinds, which Windows runs in a native job. */
export function isRepositoryCommand(
  kind: GitReadCommandKind,
): kind is RepositoryManifestKind {
  return Object.prototype.hasOwnProperty.call(REPOSITORY_CLOSURE, kind);
}

const AVAILABLE: Readonly<
  Record<GitReadCommandKind, readonly PlatformOperatingSystem[]>
> = {
  'git-head-commit': POSIX,
  'git-version': ['darwin', 'linux', 'win32'],
  'git-bare-init-smoke': ['darwin'],
  'git-check-ignore': ['darwin', 'linux', 'win32'],
  'git-ls-files-ignored': ['darwin', 'linux', 'win32'],
  'xcode-select-print-path': ['darwin'],
  'macos-login-shell-path': ['darwin'],
  'linux-login-shell-path': ['linux'],
  'getent-passwd': ['linux'],
  'where-git': ['win32'],
  'where-winget': ['win32'],
  'git-branch-refs': REPOSITORY_HOSTS,
  'git-common-dir': REPOSITORY_HOSTS,
  'git-worktree-list': REPOSITORY_HOSTS,
  'git-origin-url': REPOSITORY_HOSTS,
  'git-remote-names': REPOSITORY_HOSTS,
  'git-dir': REPOSITORY_HOSTS,
  'git-remote-head': REPOSITORY_HOSTS,
  'git-origin-head': REPOSITORY_HOSTS,
  'git-origin-branch': REPOSITORY_HOSTS,
  'git-inside-work-tree': REPOSITORY_HOSTS,
  'git-diff-name-status': REPOSITORY_HOSTS,
  'git-diff-numstat': REPOSITORY_HOSTS,
  'git-untracked-files': REPOSITORY_HOSTS,
  'git-unmerged-files': REPOSITORY_HOSTS,
  'git-object-exists': REPOSITORY_HOSTS,
};

/**
 * Repository reads add Git's own non-interactive switches to the supplied
 * environment, so `origin` contact never waits on a terminal or credential
 * prompt (D8).
 */
export function nonInteractiveEnvironment(
  environment: GitReadEnvironment,
): GitReadEnvironment {
  return Object.freeze({
    ...environment,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  });
}

/**
 * Before each change-set read's subcommand. An empty `core.fsmonitor` turns a
 * hook or the builtin monitor off on every Git (before 2.36, `false` names a
 * hook), so no fsmonitor process runs for, or outlives, the read.
 * `--no-optional-locks` does not stop `diff`'s index stat refresh.
 */
export const GIT_CHANGE_SET_COMMAND_PREFIX: readonly string[] = Object.freeze([
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=',
]);

/**
 * A change-set read's environment: a partial clone's missing objects fail the
 * read instead of being fetched from its promisor remote (Git 2.44 and later;
 * earlier Git ignores the variable and fetches, as in process).
 */
function changeSetEnvironment(
  environment: GitReadEnvironment,
): GitReadEnvironment {
  return Object.freeze({
    ...nonInteractiveEnvironment(environment),
    GIT_NO_LAZY_FETCH: '1',
  });
}

/**
 * The command a repository read runs with `executable`. Validates the read
 * and its host first, so a refused read never waits for a selection.
 */
export function gitRepositoryCommandFor(
  os: PlatformOperatingSystem,
  read: unknown,
): (executable: string) => GitReadCommand {
  const field = (key: string): unknown => Reflect.get(Object(read), key);
  const kind = field('kind');
  const command =
    typeof kind === 'string' ? REPOSITORY_COMMANDS.get(kind) : undefined;
  if (command === undefined) throw invalid();
  const available = (): void => {
    if (!AVAILABLE[command].includes(os))
      throw new GitReadError('unsupported_command');
  };
  // Arguments are validated, and copied, before the host check.
  switch (command) {
    case 'git-origin-branch': {
      const branch = conventionalBranch(field('branch'));
      available();
      return (file) => ({ kind: command, executable: file, branch });
    }
    case 'git-diff-name-status':
    case 'git-diff-numstat': {
      const range = changeSetRange(field('range'));
      available();
      return (file) => ({ kind: command, executable: file, range });
    }
    case 'git-object-exists': {
      const object = revision(field('object'));
      available();
      return (file) => ({ kind: command, executable: file, object });
    }
    default:
      available();
      return (file) => ({ kind: command, executable: file });
  }
}

/**
 * Win32 `check-ignore` and `ls-files` turn fsmonitor off, so no fsmonitor
 * daemon outlives the request. Command-scope config is read last, and a boolean
 * `core.fsmonitor` settles the mode before Git for Windows consults
 * `core.useBuiltinFSMonitor` or `feature.manyFiles`. Source-audited for the
 * `AUDITED_GIT_FOR_WINDOWS` releases only; see
 * docs/bundled-runtime-maintenance.md.
 */
export const WINDOWS_FSMONITOR_DISCHARGE: readonly string[] = Object.freeze([
  '-c',
  'core.fsmonitor=false',
]);

/** Git for Windows 2.<min> through 2.<max>: the discharge's audited minors. */
export const AUDITED_GIT_FOR_WINDOWS = Object.freeze({ min: 36, max: 56 });

/**
 * `parseGitVersion` text naming an audited Git for Windows release. Any other
 * build (microsoft/git, a release candidate, a snapshot) is unaudited.
 */
export function fsmonitorDischargeAudited(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  const minor = /^git version 2\.(\d+)\.\d+\.windows\.\d+$/.exec(version)?.[1];
  return (
    minor !== undefined &&
    Number(minor) >= AUDITED_GIT_FOR_WINDOWS.min &&
    Number(minor) <= AUDITED_GIT_FOR_WINDOWS.max
  );
}

/** The commands that read the working tree, and so may start fsmonitor. */
export function readsWorkingTree(kind: GitReadCommandKind): boolean {
  return (
    kind === 'git-check-ignore' ||
    kind === 'git-ls-files-ignored' ||
    (isRepositoryCommand(kind) && REPOSITORY_CLOSURE[kind].workingTree)
  );
}

/** The plan's arguments start with the audited fsmonitor discharge. */
export function dischargesFsmonitor(args: readonly string[]): boolean {
  return WINDOWS_FSMONITOR_DISCHARGE.every((arg, index) => args[index] === arg);
}

/**
 * The audit covers Git for Windows, whose image Win32 selection accepts only
 * as `git.exe`, at an audited version. Any other image or version keeps
 * desktop's argv and stays unsafe.
 */
function dischargeApplies(
  executable: string,
  version: string | undefined,
): boolean {
  const name = path.win32.basename(executable).toLowerCase();
  return (
    (name === 'git.exe' || name === 'git') && fsmonitorDischargeAudited(version)
  );
}

const hasNul = (value: string): boolean => value.includes('\0');
const invalid = (): GitReadError => new GitReadError('invalid_request');

function executable(value: unknown): string {
  if (typeof value !== 'string' || value === '' || hasNul(value))
    throw invalid();
  return value;
}

function scratchDirectory(
  os: PlatformOperatingSystem,
  scratch: string | undefined,
): string {
  if (scratch === undefined || !isHostAbsolute(os, scratch)) throw invalid();
  return scratch;
}

function inputBytes(input: unknown): Uint8Array {
  if (!(input instanceof Uint8Array)) throw invalid();
  return input;
}

function linuxShell(shell: unknown): string {
  if (
    typeof shell !== 'string' ||
    !path.posix.isAbsolute(shell) ||
    /[\0\r\n]/.test(shell)
  )
    throw invalid();
  return shell;
}

function conventionalBranch(branch: unknown): GitConventionalDefaultBranch {
  const found = GIT_CONVENTIONAL_DEFAULT_BRANCHES.find(
    (candidate) => candidate === branch,
  );
  if (found === undefined) throw invalid();
  return found;
}

/**
 * `HEAD` or a full object id: never a branch, an expression, an option or a
 * path. With no `--`, Git refuses one that also names a root file.
 */
function revision(value: unknown): string {
  if (!isGitChangeSetRevision(value)) throw invalid();
  return value;
}

/** A fresh, frozen copy, so a caller's getters cannot change it later. */
function changeSetRange(value: unknown): GitChangeSetRange {
  const field = (key: string): unknown => Reflect.get(Object(value), key);
  const kind = field('kind');
  if (kind === 'worktree')
    return Object.freeze({ kind, base: revision(field('base')) });
  if (kind === 'objects') {
    const base = field('base');
    if (typeof base !== 'string' || !GIT_OBJECT_ID_PATTERN.test(base))
      throw invalid();
    return Object.freeze({ kind, base, head: revision(field('head')) });
  }
  throw invalid();
}

const REPOSITORY_COMMANDS: ReadonlyMap<string, RepositoryCommandKind> = new Map<
  GitRepositoryRead['kind'],
  RepositoryCommandKind
>([
  ['head-commit', 'git-head-commit'],
  ['branch-refs', 'git-branch-refs'],
  ['common-dir', 'git-common-dir'],
  ['worktree-list', 'git-worktree-list'],
  ['origin-url', 'git-origin-url'],
  ['remote-names', 'git-remote-names'],
  ['git-dir', 'git-dir'],
  ['remote-head', 'git-remote-head'],
  ['origin-head', 'git-origin-head'],
  ['origin-branch', 'git-origin-branch'],
  ['inside-work-tree', 'git-inside-work-tree'],
  ['diff-name-status', 'git-diff-name-status'],
  ['diff-numstat', 'git-diff-numstat'],
  ['untracked-files', 'git-untracked-files'],
  ['unmerged-files', 'git-unmerged-files'],
  ['object-exists', 'git-object-exists'],
]);

function accountUid(uid: unknown): string {
  if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 0)
    throw invalid();
  return String(uid);
}

/** Absolute for the host; Windows requires a drive or UNC path. */
export function isHostAbsolute(
  os: PlatformOperatingSystem,
  value: string,
): boolean {
  if (hasNul(value)) return false;
  return os === 'win32'
    ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}(?![?.][\\/])[^\\/])/.test(value)
    : path.posix.isAbsolute(value);
}

/**
 * The value a Windows child sees. Keys are case-insensitive, and Node keeps
 * the first variant in sort order.
 */
export function windowsEnvironmentValue(
  environment: GitReadEnvironment,
  name: string,
): string | undefined {
  const upper = name.toUpperCase();
  const [key] = Object.keys(environment)
    .filter((candidate) => candidate.toUpperCase() === upper)
    .sort();
  return key === undefined ? undefined : environment[key];
}

/** The PATH the child receives. */
export function searchPath(
  os: PlatformOperatingSystem,
  environment: GitReadEnvironment,
): string | undefined {
  return os === 'win32'
    ? windowsEnvironmentValue(environment, 'PATH')
    : environment.PATH;
}

/** A command name with no directory part, which only a PATH search resolves. */
export function isBareCommand(
  os: PlatformOperatingSystem,
  file: string,
): boolean {
  if (file === '' || file === '.' || file === '..' || hasNul(file))
    return false;
  return os === 'win32' ? !/[\\/:]/.test(file) : !file.includes('/');
}

/**
 * libuv v1.51 `src/win/process.c` `search_path`: an entry starting with a
 * quote runs to the matching quote (or the end), then to the next `;`, so it
 * may contain `;`. Zero-length slices are skipped; one leading quote and one
 * trailing `"` or `'` are then removed.
 */
function windowsPathEntries(value: string): string[] {
  const entries: string[] = [];
  let end = 0;
  while (end < value.length) {
    if (end !== 0 || value.startsWith(';')) end += 1;
    const start = end;
    const quote = value.charAt(start);
    let from = start;
    if (quote === '"' || quote === "'") {
      const close = value.indexOf(quote, start + 1);
      from = close === -1 ? value.length : close;
    }
    const separator = value.indexOf(';', from);
    end = separator === -1 ? value.length : separator;
    if (end === start) continue;
    let entry = value.slice(start, end);
    if (/^["']/.test(entry)) entry = entry.slice(1);
    if (/["']$/.test(entry)) entry = entry.slice(0, -1);
    entries.push(entry);
  }
  return entries;
}

/**
 * The absolute directories of `value`. Empty and relative entries, which
 * libuv and execvp resolve against the cwd, are skipped. Windows entries are
 * split and unquoted as libuv does.
 */
export function searchDirectories(
  os: PlatformOperatingSystem,
  value: string | undefined,
): string[] {
  if (!value) return [];
  const entries = os === 'win32' ? windowsPathEntries(value) : value.split(':');
  return entries.filter((entry) => isHostAbsolute(os, entry));
}

/**
 * Spawn would resolve a relative command through the cwd, and without a PATH
 * through the host's PATH (Windows) or a built-in default (POSIX). The runner
 * resolves a bare name through the supplied PATH instead; anything else
 * relative is refused.
 */
function requireResolvable(
  os: PlatformOperatingSystem,
  plan: GitReadPlan,
): GitReadPlan {
  if (isHostAbsolute(os, plan.file)) return plan;
  if (
    !isBareCommand(os, plan.file) ||
    searchDirectories(os, searchPath(os, plan.env)).length === 0
  )
    throw invalid();
  return plan;
}

function usableSystemRoot(value: string): boolean {
  try {
    windowsExecutable(value, 'taskkill.exe');
    return true;
  } catch {
    return false;
  }
}

/**
 * The block a Windows child receives. Node keeps only the first case variant
 * of a key in sort order, so the others are dropped here. libuv copies each
 * required key the block lacks from the host, so each is added empty. PATH
 * must name an absolute directory and SystemRoot must be a drive path:
 * without them the child, or taskkill, cannot run.
 */
export function windowsChildEnvironment(
  environment: GitReadEnvironment,
): GitReadEnvironment {
  const kept = new Map<string, readonly [string, string]>();
  const entries = Object.entries(environment).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [key, value] of entries)
    if (!kept.has(key.toUpperCase())) kept.set(key.toUpperCase(), [key, value]);
  for (const key of LIBUV_REQUIRED_KEYS)
    if (!kept.has(key)) kept.set(key, [key, '']);
  const value = (key: string): string => kept.get(key)?.[1] ?? '';
  if (
    searchDirectories('win32', value('PATH')).length === 0 ||
    !usableSystemRoot(value('SYSTEMROOT'))
  )
    throw invalid();
  return Object.freeze(Object.fromEntries(kept.values()));
}

/** Rejects anything spawn would reject, before any process starts. */
export function validateEnvironment(environment: unknown): GitReadEnvironment {
  if (typeof environment !== 'object' || environment === null) throw invalid();
  const entries = Object.entries(environment);
  for (const [key, value] of entries)
    if (typeof value !== 'string' || key === '' || hasNul(key) || hasNul(value))
      throw invalid();
  return Object.freeze(Object.fromEntries(entries));
}

/**
 * Maps a command to desktop's file, arguments, environment, limits and kill
 * signal. `scratch` is the bare-init directory the runner created.
 */
export function planGitReadCommand(
  os: PlatformOperatingSystem,
  command: GitReadCommand,
  environment: GitReadEnvironment,
  scratch?: string,
): GitReadPlan {
  if (!AVAILABLE[command.kind]?.includes(os))
    throw new GitReadError('unsupported_command');
  const linux = os === 'linux';
  const plan = (
    file: string,
    args: readonly string[],
    { env = environment, ...fields }: Partial<GitReadPlan> = {},
  ): GitReadPlan =>
    requireResolvable(
      os,
      Object.freeze({
        file,
        args: Object.freeze([...args]),
        env: os === 'win32' ? windowsChildEnvironment(env) : env,
        maxBuffer: NODE_DEFAULT_MAX_BUFFER,
        timeoutMs: VALIDATION_TIMEOUT_MS,
        killMode: 'graceful',
        input: undefined,
        ...fields,
      }),
    );
  // Desktop's argv and limits; `undefined` leaves only the request deadline.
  const repository = (
    { executable: file }: { readonly executable: unknown },
    args: readonly string[],
    {
      timeoutMs,
      maxBuffer = REPOSITORY_MAX_BUFFER,
      killMode = 'graceful',
      env = nonInteractiveEnvironment(environment),
    }: Partial<
      Pick<GitReadPlan, 'timeoutMs' | 'maxBuffer' | 'killMode' | 'env'>
    > = {},
  ): GitReadPlan =>
    plan(executable(file), args, {
      env,
      maxBuffer,
      timeoutMs,
      killMode,
    });
  // The engine's argv after the prefix; diffs run no external diff driver,
  // and no read fetches.
  const changeSet = (
    command: { readonly executable: unknown },
    read: GitChangeSetRead,
  ): GitReadPlan =>
    repository(
      command,
      [
        ...GIT_CHANGE_SET_COMMAND_PREFIX,
        ...gitChangeSetReadArgs(read),
        ...(read.kind === 'diff-name-status' || read.kind === 'diff-numstat'
          ? ['--no-ext-diff']
          : []),
      ],
      {
        maxBuffer: CHANGE_SET_MAX_BUFFER,
        env: changeSetEnvironment(environment),
      },
    );
  switch (command.kind) {
    case 'git-version':
      // Linux validation runs with the probe environment and SIGKILL.
      return plan(
        executable(command.executable),
        ['--version'],
        linux
          ? { env: linuxProbeEnvironment(environment), killMode: 'force' }
          : {},
      );
    case 'git-bare-init-smoke':
      return plan(
        executable(command.executable),
        [
          '-c',
          'init.templateDir=',
          'init',
          '--bare',
          scratchDirectory(os, scratch),
        ],
        { env: bareInitEnvironment(environment), maxBuffer: 8192 },
      );
    case 'git-check-ignore':
      return plan(
        executable(command.executable),
        [
          ...(os === 'win32' &&
          dischargeApplies(command.executable, command.version)
            ? WINDOWS_FSMONITOR_DISCHARGE
            : []),
          'check-ignore',
          '-z',
          '--stdin',
        ],
        {
          maxBuffer: 8 * 1024 * 1024,
          timeoutMs: undefined,
          input: inputBytes(command.input),
        },
      );
    case 'git-ls-files-ignored':
      return plan(
        executable(command.executable),
        [
          ...(os === 'win32' &&
          dischargeApplies(command.executable, command.version)
            ? WINDOWS_FSMONITOR_DISCHARGE
            : []),
          'ls-files',
          '--others',
          '--ignored',
          '--exclude-standard',
          '--directory',
          '-z',
        ],
        { maxBuffer: IGNORED_LISTING_MAX_BUFFER, timeoutMs: undefined },
      );
    case 'xcode-select-print-path':
      return plan('/usr/bin/xcode-select', ['--print-path'], {
        maxBuffer: 4096,
      });
    case 'macos-login-shell-path':
      return plan(
        environment.SHELL || '/bin/zsh',
        ['-lic', 'exec /usr/bin/printf \'%s\\n\' "$PATH"'],
        { timeoutMs: LOGIN_SHELL_TIMEOUT_MS, killMode: 'force' },
      );
    case 'linux-login-shell-path':
      return plan(
        linuxShell(command.shell),
        ['-lic', `exec /usr/bin/printf '${LINUX_PATH_MARKER}%s\\n' "$PATH"`],
        {
          env: linuxProbeEnvironment(environment),
          maxBuffer: 64 * 1024,
          timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
          killMode: 'force',
        },
      );
    case 'getent-passwd':
      return plan('/usr/bin/getent', ['passwd', accountUid(command.uid)], {
        env: linuxProbeEnvironment(environment),
        maxBuffer: 16 * 1024,
        timeoutMs: GETENT_TIMEOUT_MS,
        killMode: 'force',
      });
    case 'where-git':
      return plan('where.exe', ['git']);
    case 'where-winget':
      return plan('where.exe', ['winget']);
    case 'git-branch-refs':
      return repository(command, [
        'for-each-ref',
        '--format=%(refname)%09%(refname:short)%(HEAD)',
        'refs/heads/',
        'refs/remotes/origin/',
      ]);
    case 'git-head-commit':
      return repository(
        command,
        ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
        {
          timeoutMs: 2000,
          maxBuffer: 4096,
        },
      );
    case 'git-common-dir':
      return repository(command, ['rev-parse', '--git-common-dir']);
    case 'git-worktree-list':
      return repository(command, ['worktree', 'list', '--porcelain']);
    case 'git-origin-url':
      return repository(command, ['remote', 'get-url', 'origin']);
    case 'git-remote-names':
      return repository(command, ['remote']);
    case 'git-dir':
      return repository(command, ['rev-parse', '--git-dir']);
    // SIGKILL for the group: a graceful stop ends Git, and the forced
    // escalation then skips the group, so an ssh or credential helper that
    // ignores SIGTERM would outlive the request.
    case 'git-remote-head':
      return repository(command, ['ls-remote', '--symref', 'origin', 'HEAD'], {
        timeoutMs: DEFAULT_BRANCH_TIMEOUT_MS,
        killMode: 'force',
      });
    case 'git-origin-head':
      return repository(command, ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
        timeoutMs: DEFAULT_BRANCH_TIMEOUT_MS,
        killMode: 'force',
      });
    case 'git-origin-branch':
      return repository(
        command,
        [
          'rev-parse',
          '--verify',
          `refs/remotes/origin/${conventionalBranch(command.branch)}`,
        ],
        { timeoutMs: DEFAULT_BRANCH_TIMEOUT_MS },
      );
    case 'git-inside-work-tree':
      return repository(command, ['rev-parse', '--is-inside-work-tree'], {
        timeoutMs: HEALTH_TIMEOUT_MS,
        maxBuffer: NODE_DEFAULT_MAX_BUFFER,
      });
    default:
      return changeSet(command, changeSetReadOf(command));
  }
}

type ChangeSetCommand = Extract<
  GitReadCommand,
  {
    kind:
      | 'git-diff-name-status'
      | 'git-diff-numstat'
      | 'git-untracked-files'
      | 'git-unmerged-files'
      | 'git-object-exists';
  }
>;

/** The engine read a change-set command runs, its arguments revalidated. */
function changeSetReadOf(command: ChangeSetCommand): GitChangeSetRead {
  switch (command.kind) {
    case 'git-diff-name-status':
      return {
        kind: 'diff-name-status',
        range: changeSetRange(command.range),
      };
    case 'git-diff-numstat':
      return { kind: 'diff-numstat', range: changeSetRange(command.range) };
    case 'git-untracked-files':
      return { kind: 'untracked-files' };
    case 'git-unmerged-files':
      return { kind: 'unmerged-files' };
    case 'git-object-exists':
      return { kind: 'object-exists', object: revision(command.object) };
  }
}
