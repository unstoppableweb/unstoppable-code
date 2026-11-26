import { spawn } from 'node:child_process';
import { withGitRequestContextEnv } from '@canopy/desktop-shared/node/git-request-context';
import {
  copyFile,
  access,
  lstat,
  stat,
  unlink,
  utimes,
} from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { devNull, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  ArchivedGitAttributePolicy,
  ChangedFileInfo,
} from '@canopy/desktop-shared/types';
import { parseDiffOutput } from './git-diff-parser';
import { isErrnoException } from './type-guards';
import {
  GIT_CAPTURE_CONFLICTS,
  GIT_CAPTURE_DIRTY_SUBMODULE,
  GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE,
  GIT_CAPTURE_INTENT_TO_ADD,
  GIT_CAPTURE_NESTED_REPOSITORY,
  GIT_CAPTURE_TRANSFORMING_ATTRIBUTE,
  worktreeSnapshotRefusal,
} from './worktree-snapshot-refusal';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 1024 * 1024 * 8;
const ARCHIVE_DIFF_TIMEOUT_MS = 60_000;
export const ARCHIVE_DIFF_MAX_RECORDS = 50_000;
export const ARCHIVED_GIT_DIFF_CANCELLED_MESSAGE =
  'Archived Git diff was cancelled.';
const INDEX_FLAG_PATH_CHECK_CONCURRENCY = 32;
const GIT_OBJECT_ID_RE = /^[0-9a-f]{40,64}$/;
const BYTE_PRESERVING_GIT_CONFIG = [
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.eol=lf',
];
/** `--attr-source` / `GIT_ATTR_SOURCE` first shipped in Git 2.41.0. */
const ATTRIBUTE_SOURCE_MIN_GIT_VERSION: readonly [number, number, number] = [
  2, 41, 0,
];
const TRANSFORMING_ATTRIBUTES = [
  'filter',
  'text',
  'eol',
  'working-tree-encoding',
  'ident',
  'crlf',
];

/**
 * How Git interprets attributes for one repository's archive snapshot. With
 * `attributeSource`, Git reads `.gitattributes` from that tree (the empty
 * tree) instead of the checkout, so every capture, verification and restore
 * command moves bytes unchanged. Omitted keeps Git's normal attribute lookup.
 */
export interface GitSnapshotAttributeOptions {
  attributeSource?: string;
}

/** `legacy`: refuse any transforming attribute (archives without a policy). */
export type WorktreeSnapshotAttributeMode =
  | 'negotiate'
  | 'legacy'
  | ArchivedGitAttributePolicy;

export interface WorktreeSnapshotSupport {
  /** Persist on the archived repository state when present. */
  attributePolicy?: ArchivedGitAttributePolicy;
  /** Pass to every capture and restore call for this repository. */
  attributes: GitSnapshotAttributeOptions;
}

export interface GitTreeSnapshotRuntime {
  resolveExecutable(): Promise<string>;
  environment(): NodeJS.ProcessEnv;
  signal?: AbortSignal;
  detached?: boolean;
  childStarted?(pid: number): void;
  childExited?(
    pid: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void;
  terminateChild?(pid: number): Promise<void>;
}

let gitTreeSnapshotRuntime: GitTreeSnapshotRuntime = {
  resolveExecutable: (): Promise<string> =>
    Promise.resolve(process.env.CANOPY_GIT_EXECUTABLE?.trim() || 'git'),
  environment: (): NodeJS.ProcessEnv => process.env,
};

export function setGitTreeSnapshotRuntime(
  runtime?: GitTreeSnapshotRuntime,
): void {
  gitTreeSnapshotRuntime = runtime ?? {
    resolveExecutable: (): Promise<string> =>
      Promise.resolve(process.env.CANOPY_GIT_EXECUTABLE?.trim() || 'git'),
    environment: (): NodeJS.ProcessEnv => process.env,
  };
}

export function archiveGitEnv(
  env: NodeJS.ProcessEnv = gitTreeSnapshotRuntime.environment(),
): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = {
    ...env,
    LC_ALL: 'C',
    GIT_NO_REPLACE_OBJECTS: '1',
  };
  // A desktop launched from a Git hook/editor may inherit another checkout's
  // discovery, private-index or attribute-source settings. Only our explicit
  // overrides may select archive input; ambient Git configuration remains
  // otherwise intact. `GIT_CONFIG` redirects `git config` alone, so a filter
  // scan would read other settings than the commands it guards;
  // `GIT_CONFIG_GLOBAL`/`_SYSTEM`/`_NOSYSTEM` apply to every command and stay.
  for (const name of Object.keys(isolated)) {
    if (
      /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|ATTR_SOURCE)$/i.test(
        name,
      )
    ) {
      delete isolated[name];
    }
  }
  return isolated;
}

function snapshotGitEnv(
  attributes: GitSnapshotAttributeOptions = {},
  env: NodeJS.ProcessEnv = archiveGitEnv(),
): NodeJS.ProcessEnv {
  // Optional locks off: a status read under the override must not write the
  // checkout's index stat cache, which its own attributes would not accept.
  return attributes.attributeSource
    ? {
        ...env,
        GIT_ATTR_SOURCE: attributes.attributeSource,
        GIT_OPTIONAL_LOCKS: '0',
      }
    : env;
}

/** `[major, minor, patch]` from `git --version`, including vendor suffixes. */
export function parseGitVersionNumbers(
  banner: string,
): [number, number, number] | null {
  const match = /\bgit version (\d+)\.(\d+)(?:\.(\d+))?/i.exec(banner);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? '0')];
}

export function gitVersionSupportsAttributeSource(banner: string): boolean {
  const version = parseGitVersionNumbers(banner);
  if (!version) return false;
  for (let index = 0; index < version.length; index++) {
    const required = ATTRIBUTE_SOURCE_MIN_GIT_VERSION[index] ?? 0;
    if (version[index] !== required) return version[index] > required;
  }
  return true;
}

function getBytePreservingGitConfig(): string[] {
  if (process.platform === 'win32') return BYTE_PRESERVING_GIT_CONFIG;
  return [...BYTE_PRESERVING_GIT_CONFIG, '-c', 'core.fileMode=true'];
}

function buildGitEnv(
  indexPath: string,
  repoPath: string,
  gitDir: string,
  attributes: GitSnapshotAttributeOptions = {},
): NodeJS.ProcessEnv {
  return {
    ...snapshotGitEnv(attributes),
    GIT_INDEX_FILE: indexPath,
    GIT_WORK_TREE: repoPath,
    GIT_DIR: gitDir,
  };
}

interface GitCommandArgs {
  repoPath: string;
  gitArgs: string[];
  env: NodeJS.ProcessEnv;
  input?: string | Buffer;
}

async function runGitCommandText(
  args: GitCommandArgs & { trim?: boolean },
): Promise<string> {
  const value = (await runGitCommand(args)).toString('utf8');
  return args.trim === false ? value : value.trim();
}

/** Stdout as Git wrote it, for paths that need not be valid UTF-8. */
async function runGitCommand(args: GitCommandArgs): Promise<Buffer> {
  const runtime = gitTreeSnapshotRuntime;
  if (runtime.signal?.aborted) {
    throw new Error(ARCHIVED_GIT_DIFF_CANCELLED_MESSAGE);
  }
  const executable = await runtime.resolveExecutable();
  return new Promise<Buffer>((resolvePromise, reject) => {
    const child = spawn(executable, args.gitArgs, {
      cwd: args.repoPath,
      // Whichever runtime is installed, launches carry the active Git
      // request context for diagnostic attribution (CAN-4397).
      env: withGitRequestContextEnv(args.env),
      detached: runtime.detached ?? false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let spawned = false;
    let terminationError: Error | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runtime.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolvePromise(stdout);
    };
    const stop = (error: Error): void => {
      terminationError ??= error;
      if (child.pid && runtime.terminateChild) {
        void runtime.terminateChild(child.pid).catch(() => {
          child.kill('SIGKILL');
        });
      } else {
        child.kill('SIGKILL');
      }
    };
    const abort = (): void =>
      stop(new Error(ARCHIVED_GIT_DIFF_CANCELLED_MESSAGE));
    const timer = setTimeout(
      () => stop(new Error('Git command timed out.')),
      GIT_TIMEOUT_MS,
    );
    timer.unref?.();
    runtime.signal?.addEventListener('abort', abort, { once: true });
    child.once('spawn', () => {
      spawned = true;
      if (child.pid) runtime.childStarted?.(child.pid);
      if (runtime.signal?.aborted) abort();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length + stderr.length > GIT_MAX_BUFFER) {
        stop(new Error('Git command output exceeded its limit.'));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stdout.length + stderr.length > GIT_MAX_BUFFER) {
        stop(new Error('Git command output exceeded its limit.'));
      }
    });
    child.once('error', (error) => {
      if (!spawned) finish(terminationError ?? error);
      else stop(error);
    });
    child.once('close', (code, signal) => {
      if (child.pid) runtime.childExited?.(child.pid, code, signal);
      if (terminationError) {
        finish(terminationError);
      } else if (code !== 0) {
        finish(
          new Error(
            stderr.toString('utf8').trim() ||
              `Git command exited with code ${String(code)}.`,
          ),
        );
      } else {
        finish();
      }
    });
    child.stdin.on('error', (error) => {
      if (!isErrnoException(error) || error.code !== 'EPIPE') stop(error);
    });
    child.stdin.end(args.input);
  });
}

async function runGitWithEnv(
  repoPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return runGitCommandText({ repoPath, gitArgs: args, env });
}

async function runGitWithEnvAndInput(
  repoPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input: string,
): Promise<void> {
  await runGitCommandText({ repoPath, gitArgs: args, env, input });
}

async function clearWorktreeOnlyIndexFlags(
  repoPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const entries = await runGitWithEnv(repoPath, ['ls-files', '-v', '-z'], env);
  const parsedEntries = entries
    .split('\0')
    .filter(Boolean)
    .map((entry) => ({ status: entry[0], path: entry.slice(2) }));
  const assumeUnchangedPaths = parsedEntries
    .filter(({ status }) => status === status.toLowerCase())
    .map(({ path }) => path);
  const skipWorktreeCandidates = parsedEntries
    .filter(({ status }) => status === 'S' || status === 's')
    .map(({ path }) => path);
  const skipWorktreePaths: string[] = [];
  const absentSkipWorktreePaths: string[] = [];
  for (
    let offset = 0;
    offset < skipWorktreeCandidates.length;
    offset += INDEX_FLAG_PATH_CHECK_CONCURRENCY
  ) {
    const candidates = skipWorktreeCandidates.slice(
      offset,
      offset + INDEX_FLAG_PATH_CHECK_CONCURRENCY,
    );
    const checked = await Promise.all(
      candidates.map(async (path) => {
        try {
          await lstat(join(repoPath, path));
          return { path, exists: true };
        } catch (error) {
          if (
            isErrnoException(error) &&
            (error.code === 'ENOENT' || error.code === 'ENOTDIR')
          ) {
            return { path, exists: false };
          }
          throw error;
        }
      }),
    );
    for (const { path, exists } of checked) {
      (exists ? skipWorktreePaths : absentSkipWorktreePaths).push(path);
    }
  }
  for (const [flag, paths] of [
    ['--no-assume-unchanged', assumeUnchangedPaths],
    ['--no-skip-worktree', skipWorktreePaths],
  ] as const) {
    if (paths.length === 0) continue;
    await runGitWithEnvAndInput(
      repoPath,
      ['update-index', flag, '-z', '--stdin'],
      env,
      `${paths.join('\0')}\0`,
    );
  }
  return absentSkipWorktreePaths;
}

async function runGit(
  repoPath: string,
  args: string[],
  attributes: GitSnapshotAttributeOptions = {},
): Promise<string> {
  return runGitWithEnv(repoPath, args, snapshotGitEnv(attributes));
}

async function runGitRawText(
  repoPath: string,
  args: string[],
  attributes: GitSnapshotAttributeOptions = {},
): Promise<string> {
  return runGitCommandText({
    repoPath,
    gitArgs: args,
    env: snapshotGitEnv(attributes),
    trim: false,
  });
}

/**
 * Command-line configuration and environment every Git read of a check adds,
 * so the check reads the same trees and attributes as the command it guards
 * (`scopedCheckoutGit`).
 */
export interface GitCommandScope {
  config: readonly string[];
  env: Readonly<Record<string, string>>;
}

const UNSCOPED: GitCommandScope = { config: [], env: {} };

/** NUL-terminated path records, byte for byte, for `check-attr -z --stdin`. */
async function runGitPathBytes(
  repoPath: string,
  args: string[],
  scope: GitCommandScope = UNSCOPED,
): Promise<Buffer> {
  return runGitCommand({
    repoPath,
    gitArgs: [...scope.config, ...args],
    env: { ...snapshotGitEnv(), ...scope.env },
  });
}

class TransformingAttributeFound extends Error {
  public constructor(
    public readonly relativePath: string,
    public readonly attribute: string,
  ) {
    super('Transforming Git attribute found.');
  }
}

function describeTransformingAttribute(attribute: string): string {
  return attribute === 'filter'
    ? 'transforming Git filter'
    : `transforming Git attribute "${attribute}"`;
}

/** Filter drivers whose names `check-attr` prints as special values. */
const AMBIGUOUS_FILTER_DRIVERS: ReadonlySet<string> = new Set([
  'unset',
  'unspecified',
]);

const FILTER_COMMAND_KEYS: ReadonlySet<string> = new Set([
  'clean',
  'smudge',
  'process',
]);

/**
 * Empties every command of those drivers and makes them optional, for a
 * checkout whose configuration (`includeIf onbranch:`) no preflight can read:
 * a required driver with no command fails the checkout before restore can
 * refuse and roll back.
 */
export const AMBIGUOUS_FILTER_DRIVER_OVERRIDES: readonly string[] = [
  ...AMBIGUOUS_FILTER_DRIVERS,
].flatMap((driver) => [
  ...[...FILTER_COMMAND_KEYS].flatMap((key) => [
    '-c',
    `filter.${driver}.${key}=`,
  ]),
  '-c',
  `filter.${driver}.required=false`,
]);

/** The spellings Git reads as boolean false. */
const GIT_CONFIG_FALSE_VALUES: ReadonlySet<string> = new Set([
  '',
  'false',
  'no',
  'off',
  '0',
]);

/**
 * Configured filter drivers named `unset` or `unspecified`. Git runs no empty
 * command, so a driver whose only settings are empty commands and a false
 * `required` is inert; a true `required` still counts, since it fails the
 * command.
 */
async function configuredAmbiguousFilterDrivers(
  repoPath: string,
  scope: GitCommandScope,
): Promise<ReadonlySet<string>> {
  const listing = await runGitCommandText({
    repoPath,
    gitArgs: [...scope.config, 'config', '-z', '--list'],
    env: { ...archiveGitEnv(), ...scope.env },
    trim: false,
  });
  // Later entries override earlier ones, command-line configuration last.
  const settings = new Map<string, string | null>();
  for (const entry of listing.split('\0')) {
    const newline = entry.indexOf('\n');
    const name = newline === -1 ? entry : entry.slice(0, newline);
    if (!name.startsWith('filter.')) continue;
    settings.set(name, newline === -1 ? null : entry.slice(newline + 1));
  }
  const drivers = new Set<string>();
  for (const [name, value] of settings) {
    // Section and key names print lowercased; the driver name keeps its case.
    const keyStart = name.lastIndexOf('.');
    const driver = name.slice('filter.'.length, keyStart);
    if (!AMBIGUOUS_FILTER_DRIVERS.has(driver)) continue;
    const key = name.slice(keyStart + 1);
    if (FILTER_COMMAND_KEYS.has(key) && value === '') continue;
    if (
      key === 'required' &&
      value !== null &&
      GIT_CONFIG_FALSE_VALUES.has(value.toLowerCase())
    )
      continue;
    drivers.add(driver);
  }
  return drivers;
}

/**
 * `unset` is also what `filter=unset` prints, and Git runs a driver of that
 * name. With such a driver configured `check-attr` runs with `--all`, which
 * omits unspecified attributes, so a printed `unspecified` is that literal
 * value.
 */
function isTransformingAttributeValue(
  attribute: string,
  value: string,
  ambiguousFilterDrivers: ReadonlySet<string>,
): boolean {
  if (!TRANSFORMING_ATTRIBUTES.includes(attribute)) return false;
  if (value !== 'unset' && value !== 'unspecified') return true;
  return attribute === 'filter' && ambiguousFilterDrivers.has(value);
}

/** The first path carrying a transforming attribute, read without filters. */
async function findTransformingAttribute(
  repoPath: string,
  snapshotPaths: Buffer,
  attributes: GitSnapshotAttributeOptions,
  scope: GitCommandScope = UNSCOPED,
): Promise<TransformingAttributeFound | undefined> {
  if (snapshotPaths.length === 0) return undefined;
  const ambiguousFilterDrivers = await configuredAmbiguousFilterDrivers(
    repoPath,
    scope,
  );
  // Named attributes bound the output to six records per path; `--all` prints
  // every set attribute, which `linguist-*`-style rules can make many times
  // larger, so it runs only when a printed value could name a driver.
  const selection =
    ambiguousFilterDrivers.size > 0 ? ['--all'] : TRANSFORMING_ATTRIBUTES;
  // Validate triplets as they arrive instead of buffering a response that can
  // be many times larger than the path list.
  let field = 0;
  let relativePath = '';
  let attribute = '';
  try {
    await streamGitNulTokens({
      repoPath,
      gitArgs: [...scope.config, 'check-attr', '-z', '--stdin', ...selection],
      input: snapshotPaths,
      operation: 'attribute check',
      timeoutMs: GIT_TIMEOUT_MS,
      env: { ...snapshotGitEnv(attributes), ...scope.env },
      onToken(token) {
        if (field === 0) relativePath = token;
        else if (field === 1) attribute = token;
        else if (
          isTransformingAttributeValue(attribute, token, ambiguousFilterDrivers)
        ) {
          throw new TransformingAttributeFound(relativePath, attribute);
        }
        field = (field + 1) % 3;
      },
      validateComplete() {
        if (field !== 0) {
          throw new Error(
            'Archived Git attribute check returned an incomplete record.',
          );
        }
      },
    });
  } catch (error) {
    if (error instanceof TransformingAttributeFound) return error;
    throw error;
  }
  return undefined;
}

export async function resolveEmptyTreeId(repoPath: string): Promise<string> {
  // The repository's own object format decides the empty tree's id. Git
  // resolves that tree without it being stored.
  const tree = await runGitCommandText({
    repoPath,
    gitArgs: ['hash-object', '-t', 'tree', '--stdin'],
    env: archiveGitEnv(),
    input: '',
  });
  if (!GIT_OBJECT_ID_RE.test(tree)) {
    throw new Error('Git returned an invalid empty tree id.');
  }
  return tree;
}

/**
 * Settles how Git must read attributes before any command that can run a
 * clean or smudge filter. `negotiate` ignores in-tree attributes only when
 * the checkout has a transforming one; a policy requires the override.
 * Transforming attributes from outside the tree always refuse.
 */
async function resolveSnapshotAttributeSupport(
  repoPath: string,
  snapshotPaths: Buffer,
  mode: WorktreeSnapshotAttributeMode,
): Promise<WorktreeSnapshotSupport> {
  let inTree: TransformingAttributeFound | undefined;
  if (mode === 'legacy' || mode === 'negotiate') {
    inTree = await findTransformingAttribute(repoPath, snapshotPaths, {});
    if (!inTree) return { attributes: {} };
    if (mode === 'legacy') {
      throw worktreeSnapshotRefusal(
        GIT_CAPTURE_TRANSFORMING_ATTRIBUTE,
        `Cannot archive a worktree with a ${describeTransformingAttribute(inTree.attribute)}: ${inTree.relativePath}`,
      );
    }
  }
  const banner = await runGit(repoPath, ['--version']);
  if (!gitVersionSupportsAttributeSource(banner)) {
    const version = parseGitVersionNumbers(banner)?.join('.') ?? 'unknown';
    const minimum = ATTRIBUTE_SOURCE_MIN_GIT_VERSION.slice(0, 2).join('.');
    throw worktreeSnapshotRefusal(
      GIT_CAPTURE_TRANSFORMING_ATTRIBUTE,
      inTree
        ? `Cannot archive a worktree with a ${describeTransformingAttribute(inTree.attribute)} on Git ${version}; Git ${minimum} or later is required: ${inTree.relativePath}`
        : `Cannot verify an archive that ignores in-tree Git attributes on Git ${version}; Git ${minimum} or later is required.`,
    );
  }
  // Accepted gap, owner decision (CAN-6776 q-4): lossless capture skips
  // in-tree clean filters, git-crypt and LFS included, so snapshots hold
  // working-tree bytes, decrypted git-crypt files too, under
  // refs/app/archived-containers. That plaintext is already in the user's
  // checkout, and Canopy never pushes those refs or uploads recovery bundles;
  // a user's mirror push or clone includes them, as
  // docs/archived-worktree-git-state.md records. Revisit if Canopy publishes
  // either.
  const attributes = { attributeSource: await resolveEmptyTreeId(repoPath) };
  // Restore writes every archived-HEAD path, staged deletions included, and
  // refuses the same external attributes.
  const headPaths = (await hasHeadCommit(repoPath))
    ? await listTreePaths(repoPath, ['HEAD'])
    : Buffer.alloc(0);
  const external = await findTransformingAttribute(
    repoPath,
    Buffer.concat([snapshotPaths, headPaths]),
    attributes,
  );
  if (external) {
    throw worktreeSnapshotRefusal(
      GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE,
      `Cannot archive a worktree with a ${describeTransformingAttribute(external.attribute)} set outside the repository: ${external.relativePath}`,
    );
  }
  return { attributePolicy: 'ignore-in-tree-attributes', attributes };
}

function splitNulRecords(listing: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (
    let end = listing.indexOf(0);
    end !== -1;
    end = listing.indexOf(0, start)
  ) {
    if (end > start) records.push(listing.subarray(start, end));
    start = end + 1;
  }
  if (start < listing.length) records.push(listing.subarray(start));
  return records;
}

/**
 * `repoPath/relativePath/...segments` for a filesystem call. A path Git
 * listed in bytes that are not UTF-8 stays bytes, so the lookup reaches the
 * entry Git meant instead of a decoded name that does not exist.
 */
function workingTreeFsPath(
  repoPath: string,
  relativePath: Buffer,
  ...segments: string[]
): string | Buffer {
  const decoded = relativePath.toString('utf8');
  if (Buffer.from(decoded, 'utf8').equals(relativePath)) {
    return join(repoPath, decoded, ...segments);
  }
  return Buffer.concat([
    Buffer.from(repoPath),
    ...[relativePath, ...segments].map((segment) =>
      Buffer.concat([Buffer.from(sep), Buffer.from(segment)]),
    ),
  ]);
}

async function gitMetadataExists(filePath: string | Buffer): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (
      isErrnoException(error) &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return false;
    }
    throw error;
  }
}

async function assertNoNestedGitRepositoriesInTrackedPaths(
  repoPath: string,
  trackedPaths: Buffer,
): Promise<void> {
  // Keyed by the exact bytes (latin1 maps each byte to one code unit).
  const ancestors = new Map<string, Buffer>();
  for (const relativePath of splitNulRecords(trackedPaths)) {
    for (
      let slash = relativePath.lastIndexOf(0x2f);
      slash > 0;
      slash = relativePath.lastIndexOf(0x2f, slash - 1)
    ) {
      const parent = relativePath.subarray(0, slash);
      const key = parent.toString('latin1');
      if (ancestors.has(key)) break;
      ancestors.set(key, parent);
    }
  }

  for (const relativePath of ancestors.values()) {
    const hasGitMetadata = await gitMetadataExists(
      workingTreeFsPath(repoPath, relativePath, '.git'),
    );
    if (hasGitMetadata) {
      throw worktreeSnapshotRefusal(
        GIT_CAPTURE_NESTED_REPOSITORY,
        `Cannot archive an embedded Git repository containing outer-repository files: ${relativePath.toString('utf8')}`,
      );
    }
  }
}

/** Early exit from a status stream once one change is seen. */
class SubmoduleChangeFound extends Error {
  public constructor() {
    super('Submodule change found.');
  }
}

/**
 * A streamed path that decoded to U+FFFD: its bytes may not be UTF-8, and a
 * child process cannot start in a directory named by such bytes.
 */
function isUndecodablePath(relativePath: string): boolean {
  return relativePath.includes('\uFFFD');
}

/**
 * For a status without an attribute source: Git ran its own
 * `status --porcelain=2` in each initialized submodule and reports its
 * changes (`m`) or untracked files (`u`) in the `S` field.
 */
function reportsDirtySubmodule(porcelainV2: string): boolean {
  return porcelainV2.split('\0').some((line) => {
    if (!line.startsWith('1 ') && !line.startsWith('2 ')) return false;
    const submodule = line.split(' ', 4)[2];
    return (
      submodule?.startsWith('S') === true &&
      (submodule[2] !== '.' || submodule[3] !== '.')
    );
  });
}

/**
 * A submodule's untracked files are content the archive must keep, whatever
 * `status.showUntrackedFiles` its own or the user's config sets. Command-line
 * config outranks both and reaches Git's recursion into nested submodules.
 */
const SHOW_SUBMODULE_UNTRACKED_FILES = [
  '-c',
  'status.showUntrackedFiles=normal',
];

/**
 * A submodule's own config must not run a command during archive, and its
 * status must not write its index.
 */
const UNTRUSTED_SUBMODULE_STATUS_CONFIG = [
  ...SHOW_SUBMODULE_UNTRACKED_FILES,
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  `core.hooksPath=${devNull}`,
];

/**
 * Whether any component of `relativePath` under `root` is a symbolic link.
 * Git does not follow one into a submodule, so its status must not either. A
 * missing component is not a link.
 */
async function hasSymlinkComponent(
  root: string,
  relativePath: string,
): Promise<boolean> {
  let current = root;
  for (const component of relativePath.split('/')) {
    current = join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (error) {
      if (
        isErrnoException(error) &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        return false;
      }
      throw error;
    }
  }
  return false;
}

/**
 * The same check under an attribute source, which Git's own recursion into
 * submodules would inherit, skipping their filters. Each initialized
 * submodule is read on its own with no attribute source. Streamed: the index
 * listing grows with the repository, not with its submodules.
 */
async function hasDirtySubmodule(repoPath: string): Promise<boolean> {
  const submodulePaths: string[] = [];
  await streamGitNulTokens({
    repoPath,
    gitArgs: ['ls-files', '--stage', '-z'],
    operation: 'submodule check',
    timeoutMs: GIT_TIMEOUT_MS,
    env: archiveGitEnv(),
    onToken(entry) {
      if (!entry.startsWith('160000 ')) return;
      const relativePath = entry.slice(entry.indexOf('\t') + 1);
      if (isUndecodablePath(relativePath)) {
        throw worktreeSnapshotRefusal(
          GIT_CAPTURE_DIRTY_SUBMODULE,
          'Cannot archive a worktree with a submodule whose path is not UTF-8.',
        );
      }
      submodulePaths.push(relativePath);
    },
  });
  for (const relativePath of submodulePaths) {
    if (await hasSymlinkComponent(repoPath, relativePath)) {
      throw worktreeSnapshotRefusal(
        GIT_CAPTURE_DIRTY_SUBMODULE,
        'Cannot archive a worktree with a submodule reached through a symbolic link.',
      );
    }
    const submodulePath = join(repoPath, relativePath);
    if (!(await gitMetadataExists(join(submodulePath, '.git')))) continue;
    try {
      // The outer status counts a submodule's untracked files as dirty even
      // under `--untracked-files=no`.
      await streamGitNulTokens({
        repoPath: submodulePath,
        gitArgs: [
          ...UNTRUSTED_SUBMODULE_STATUS_CONFIG,
          'status',
          '--porcelain=v2',
          '-z',
          '--untracked-files=normal',
        ],
        operation: 'submodule check',
        timeoutMs: GIT_TIMEOUT_MS,
        env: { ...archiveGitEnv(), GIT_OPTIONAL_LOCKS: '0' },
        onToken(record) {
          if (/^[12u?] /.test(record)) throw new SubmoduleChangeFound();
        },
      });
    } catch (error) {
      if (error instanceof SubmoduleChangeFound) return true;
      throw error;
    }
  }
  return false;
}

async function hasHeadCommit(repoPath: string): Promise<boolean> {
  try {
    await runGit(repoPath, ['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

export async function captureHeadCommitSha(
  repoPath: string,
): Promise<string | undefined> {
  try {
    const sha = await runGit(repoPath, ['rev-parse', '--verify', 'HEAD']);
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** Captures the live index without changing either the index or checkout. */
export async function captureIndexTreeSha(
  repoPath: string,
  attributes: GitSnapshotAttributeOptions = {},
): Promise<string> {
  return runGit(repoPath, ['write-tree'], attributes);
}

/**
 * Rejects index/worktree states that cannot be reconstructed exactly by the
 * archive's three-commit snapshot chain, with a typed refusal
 * (`worktree-snapshot-refusal.ts`) that sends the archive to files-only
 * recovery, and settles the attribute policy every later capture or restore
 * command for this repository must use.
 */
export async function assertWorktreeSnapshotSupported(
  repoPath: string,
  mode: WorktreeSnapshotAttributeMode = 'legacy',
): Promise<WorktreeSnapshotSupport> {
  const [unmerged, untracked, trackedPaths, snapshotPaths] = await Promise.all([
    runGit(repoPath, ['ls-files', '--unmerged', '-z']),
    runGitPathBytes(repoPath, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]),
    runGitPathBytes(repoPath, ['ls-files', '--cached', '-z']),
    runGitPathBytes(repoPath, [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
    ]),
  ]);
  const conflicts = (): Error =>
    worktreeSnapshotRefusal(
      GIT_CAPTURE_CONFLICTS,
      'Cannot archive a worktree with unresolved conflicts.',
    );
  if (unmerged.length > 0) throw conflicts();
  // CAN-6776: `git status` runs a stat-dirty file's clean filter, and a
  // failing required one would end the check with a raw error instead of
  // this refusal. `ls-files` and `check-attr` run no filter.
  const support = await resolveSnapshotAttributeSupport(
    repoPath,
    snapshotPaths,
    mode,
  );
  // Under an attribute source, submodule content is checked separately below:
  // Git's status inside one would inherit it and skip the submodule's filters.
  const ignoreSubmodules =
    support.attributes.attributeSource === undefined
      ? '--ignore-submodules=none'
      : '--ignore-submodules=dirty';
  const [porcelainV1, porcelainV2] = await Promise.all([
    runGitRawText(
      repoPath,
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=no',
        ignoreSubmodules,
      ],
      support.attributes,
    ),
    runGitRawText(
      repoPath,
      [
        // `reportsDirtySubmodule` reads Git's recursion from this status.
        ...SHOW_SUBMODULE_UNTRACKED_FILES,
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=no',
        ignoreSubmodules,
      ],
      support.attributes,
    ),
  ]);

  if (porcelainV2.split('\0').some((line) => line.startsWith('u '))) {
    throw conflicts();
  }

  const hasIntentToAddV1 = porcelainV1
    .split('\0')
    .some((line) => line.startsWith(' A '));
  const hasIntentToAddV2 = porcelainV2
    .split('\0')
    .some((line) => /^(?:1|2) \.A /.test(line));
  if (hasIntentToAddV1 || hasIntentToAddV2) {
    throw worktreeSnapshotRefusal(
      GIT_CAPTURE_INTENT_TO_ADD,
      'Cannot archive files marked intent-to-add. Stage or unstage them first.',
    );
  }

  if (
    support.attributes.attributeSource === undefined
      ? reportsDirtySubmodule(porcelainV2)
      : await hasDirtySubmodule(repoPath)
  ) {
    throw worktreeSnapshotRefusal(
      GIT_CAPTURE_DIRTY_SUBMODULE,
      'Cannot archive a worktree with dirty nested submodules.',
    );
  }

  for (const relativePath of splitNulRecords(untracked)) {
    const isDirectory = await lstat(workingTreeFsPath(repoPath, relativePath))
      .then((info) => info.isDirectory())
      .catch(() => false);
    if (!isDirectory) continue;
    const hasGitMetadata = await gitMetadataExists(
      workingTreeFsPath(repoPath, relativePath, '.git'),
    );
    if (hasGitMetadata) {
      throw worktreeSnapshotRefusal(
        GIT_CAPTURE_NESTED_REPOSITORY,
        `Cannot archive an untracked nested Git repository: ${relativePath.toString('utf8')}`,
      );
    }
  }

  await assertNoNestedGitRepositoriesInTrackedPaths(repoPath, trackedPaths);
  return support;
}

export async function createSnapshotCommit(args: {
  repoPath: string;
  treeSha: string;
  parentCommit: string;
  message: string;
}): Promise<string> {
  const fixedIdentityEnv: NodeJS.ProcessEnv = {
    ...archiveGitEnv(),
    GIT_AUTHOR_NAME: 'Archived Worktree Snapshot',
    GIT_AUTHOR_EMAIL: 'snapshot@invalid.local',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'Archived Worktree Snapshot',
    GIT_COMMITTER_EMAIL: 'snapshot@invalid.local',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  };
  return runGitWithEnv(
    args.repoPath,
    [
      '-c',
      'commit.gpgSign=false',
      'commit-tree',
      args.treeSha,
      '-p',
      args.parentCommit,
      '-m',
      args.message,
    ],
    fixedIdentityEnv,
  );
}

export async function assertGitObject(
  repoPath: string,
  oid: string,
  expectedType: 'blob' | 'tree' | 'commit' | 'tag',
): Promise<void> {
  if (!GIT_OBJECT_ID_RE.test(oid)) {
    throw new Error(`Invalid Git object id: ${oid}`);
  }
  const actualType = await runGit(repoPath, ['cat-file', '-t', oid]).catch(
    () => '',
  );
  if (actualType !== expectedType) {
    throw new Error(
      `Archived Git object ${oid} is missing or is not a ${expectedType}.`,
    );
  }
}

/**
 * Under an attribute source, rewrites every tracked file of a fresh restore
 * destination from HEAD. Its stat-clean entries otherwise keep whatever bytes
 * the destination's own checkout wrote, which a later `reset --hard` or
 * `read-tree -u` would not replace.
 */
async function rewriteCheckoutForAttributes(
  repoPath: string,
  attributes: GitSnapshotAttributeOptions,
): Promise<void> {
  if (attributes.attributeSource === undefined) return;
  await runGit(
    repoPath,
    [...getBytePreservingGitConfig(), 'read-tree', '--empty'],
    attributes,
  );
  await runGit(
    repoPath,
    [...getBytePreservingGitConfig(), 'reset', '--hard', 'HEAD'],
    attributes,
  );
}

/**
 * Installs `treeish` as the index with no stat data, so Git's next status
 * rehashes every file under the checkout's own attributes. Entries kept from
 * a checkout under the attribute source would otherwise vouch for bytes
 * those attributes would clean differently, hiding an unstaged edit.
 */
async function installIndexWithoutStatData(
  repoPath: string,
  treeish: string,
  attributes: GitSnapshotAttributeOptions,
): Promise<void> {
  await runGit(
    repoPath,
    [...getBytePreservingGitConfig(), 'read-tree', '--empty'],
    attributes,
  );
  await runGit(
    repoPath,
    [...getBytePreservingGitConfig(), 'read-tree', treeish],
    attributes,
  );
}

/** The tree `treeish` names, or `undefined` when it does not resolve. */
export async function resolveTreeId(
  repoPath: string,
  treeish: string,
  scope: GitCommandScope = UNSCOPED,
): Promise<string | undefined> {
  try {
    return await runGitWithEnv(
      repoPath,
      [
        ...scope.config,
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${treeish}^{tree}`,
      ],
      { ...snapshotGitEnv(), ...scope.env },
    );
  } catch (error) {
    // `--quiet` leaves stderr empty only for a name that does not resolve.
    if (
      error instanceof Error &&
      error.message === 'Git command exited with code 1.'
    )
      return undefined;
    throw error;
  }
}

/** Whether the full ref name `ref` exists, without revision-name lookup. */
export async function refExists(
  repoPath: string,
  ref: string,
  scope: GitCommandScope = UNSCOPED,
): Promise<boolean> {
  try {
    await runGitWithEnv(
      repoPath,
      [...scope.config, 'show-ref', '--verify', '--quiet', '--', ref],
      { ...snapshotGitEnv(), ...scope.env },
    );
    return true;
  } catch (error) {
    // `--quiet` exits 1, with nothing on stderr, for a missing or invalid ref.
    if (
      error instanceof Error &&
      error.message === 'Git command exited with code 1.'
    )
      return false;
    throw error;
  }
}

/**
 * Every path in any of `treeishes`, once each, as `check-attr --stdin` input.
 * Latin-1 maps each byte to one character, so names that are not UTF-8 keep
 * their exact bytes.
 */
async function listTreePaths(
  repoPath: string,
  treeishes: readonly string[],
  scope: GitCommandScope = UNSCOPED,
): Promise<Buffer> {
  const paths = new Set<string>();
  for (const treeish of new Set(treeishes)) {
    const listed = await runGitPathBytes(
      repoPath,
      [
        'ls-tree',
        '-r',
        '-z',
        '--name-only',
        '--full-tree',
        '--end-of-options',
        treeish,
      ],
      scope,
    );
    for (const path of listed.toString('latin1').split('\0'))
      if (path) paths.add(path);
  }
  return Buffer.from(
    Array.from(paths, (path) => `${path}\0`).join(''),
    'latin1',
  );
}

/**
 * Refuses when a transforming attribute from outside the tree, which an
 * attribute source does not override, applies to a path a checkout of any of
 * `treeishes` writes. `scope` is the state that checkout runs under.
 */
export async function assertNoExternalTransformingAttributeInTrees(
  repoPath: string,
  treeishes: readonly string[],
  attributeSource: string,
  scope: GitCommandScope = UNSCOPED,
): Promise<void> {
  const external = await findTransformingAttribute(
    repoPath,
    await listTreePaths(repoPath, treeishes, scope),
    { attributeSource },
    scope,
  );
  if (external) {
    throw worktreeSnapshotRefusal(
      GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE,
      `Cannot restore an archive with a ${describeTransformingAttribute(external.attribute)} now set outside the repository: ${external.relativePath}`,
    );
  }
}

/**
 * Before a restore creates its destination: the attribute source a snapshot
 * captured under `ignore-in-tree-attributes` needs. Refuses, so the archive
 * stays intact, when the selected Git cannot ignore in-tree attributes or a
 * transforming attribute from outside the tree now applies to a path restore
 * writes from the archived HEAD, index or working snapshot. The destination's
 * start point is checked under the configuration its checkout runs with
 * (`runWithGitAttributeSources`), and the destination's own attributes before
 * the snapshots are written (`restoreIndexAndWorkingTreeSnapshot`), which
 * leaves an index without stat data, so the first status afterwards rehashes
 * every file.
 */
export async function resolveRestoreAttributeSource(
  referenceRepoPath: string,
  snapshot: {
    headCommit: string;
    indexSnapshotCommit: string;
    worktreeSnapshotCommit: string;
  },
): Promise<string> {
  const commits = [
    snapshot.headCommit,
    snapshot.indexSnapshotCommit,
    snapshot.worktreeSnapshotCommit,
  ];
  for (const commit of commits)
    await assertGitObject(referenceRepoPath, commit, 'commit');
  const banner = await runGit(referenceRepoPath, ['--version']);
  if (!gitVersionSupportsAttributeSource(banner)) {
    const version = parseGitVersionNumbers(banner)?.join('.') ?? 'unknown';
    throw worktreeSnapshotRefusal(
      GIT_CAPTURE_TRANSFORMING_ATTRIBUTE,
      `Cannot restore an archive that ignores in-tree Git attributes on Git ${version}; Git ${ATTRIBUTE_SOURCE_MIN_GIT_VERSION.slice(0, 2).join('.')} or later is required.`,
    );
  }
  const attributeSource = await resolveEmptyTreeId(referenceRepoPath);
  await assertNoExternalTransformingAttributeInTrees(
    referenceRepoPath,
    commits,
    attributeSource,
  );
  return attributeSource;
}

export async function restoreIndexAndWorkingTreeSnapshot(args: {
  repoPath: string;
  headCommit: string;
  indexSnapshotCommit: string;
  worktreeSnapshotCommit: string;
  /**
   * Keep a current HEAD that descends from the archived HEAD and replay only
   * the archived staged/unstaged deltas onto it. Used when restore safely
   * reuses a preserved local branch that has advanced since archive time;
   * never under an attribute source, which refuses such a HEAD.
   */
  preserveDescendantHead?: boolean;
  /** The archived repository's attribute policy, as settled at capture. */
  attributes?: GitSnapshotAttributeOptions;
}): Promise<void> {
  const attributes = args.attributes ?? {};
  await Promise.all([
    assertGitObject(args.repoPath, args.headCommit, 'commit'),
    assertGitObject(args.repoPath, args.indexSnapshotCommit, 'commit'),
    assertGitObject(args.repoPath, args.worktreeSnapshotCommit, 'commit'),
  ]);
  if (attributes.attributeSource !== undefined) {
    // The destination's own configuration (`includeIf`, for one) can add
    // attributes its reference repository lacks. Its checkout ignored them
    // (`scopedWorktreeAddLaunch`), so no filter has run; the caller rolls the
    // destination back.
    await assertNoExternalTransformingAttributeInTrees(
      args.repoPath,
      [
        'HEAD',
        args.headCommit,
        args.indexSnapshotCommit,
        args.worktreeSnapshotCommit,
      ],
      attributes.attributeSource,
    );
  }
  if (args.preserveDescendantHead) {
    const currentHead = await runGit(args.repoPath, ['rev-parse', 'HEAD']);
    const mergeBase = await runGit(args.repoPath, [
      'merge-base',
      args.headCommit,
      currentHead,
    ]);
    if (mergeBase !== args.headCommit) {
      throw new Error(
        `Local branch no longer contains archived commit ${args.headCommit.slice(0, 8)}.`,
      );
    }
    if (currentHead !== args.headCommit) {
      // Restore reuses a policy archive's branch only at the archived commit
      // (`resolveRestoreBranch`); one that moved since must not reach the
      // cherry-picks below, which read the in-tree attributes.
      if (attributes.attributeSource !== undefined)
        throw worktreeSnapshotRefusal(
          GIT_CAPTURE_TRANSFORMING_ATTRIBUTE,
          `Cannot restore an archive that ignores in-tree Git attributes onto a branch that moved past archived commit ${args.headCommit.slice(0, 8)}.`,
        );
      let restoredIndexTree = `${currentHead}^{tree}`;
      if (args.indexSnapshotCommit !== args.headCommit) {
        await runGit(args.repoPath, [
          ...getBytePreservingGitConfig(),
          'cherry-pick',
          '--no-commit',
          args.indexSnapshotCommit,
        ]);
        restoredIndexTree = await runGit(args.repoPath, ['write-tree']);
      }
      if (args.worktreeSnapshotCommit !== args.indexSnapshotCommit) {
        await runGit(args.repoPath, [
          ...getBytePreservingGitConfig(),
          'cherry-pick',
          '--no-commit',
          args.worktreeSnapshotCommit,
        ]);
        await runGit(args.repoPath, [
          ...getBytePreservingGitConfig(),
          'read-tree',
          '--reset',
          restoredIndexTree,
        ]);
      }
      return;
    }
  }

  await rewriteCheckoutForAttributes(args.repoPath, attributes);
  await runGit(
    args.repoPath,
    [...getBytePreservingGitConfig(), 'reset', '--hard', args.headCommit],
    attributes,
  );
  await runGit(
    args.repoPath,
    [
      ...getBytePreservingGitConfig(),
      'read-tree',
      '--reset',
      '-u',
      args.worktreeSnapshotCommit,
    ],
    attributes,
  );
  if (attributes.attributeSource !== undefined) {
    await installIndexWithoutStatData(
      args.repoPath,
      args.indexSnapshotCommit,
      attributes,
    );
    return;
  }
  await runGit(
    args.repoPath,
    [
      ...getBytePreservingGitConfig(),
      'read-tree',
      '--reset',
      args.indexSnapshotCommit,
    ],
    attributes,
  );
}

async function getGitDir(repoPath: string): Promise<string> {
  const gitDir = await runGit(repoPath, ['rev-parse', '--git-dir']);
  return isAbsolute(gitDir) ? gitDir : join(repoPath, gitDir);
}

async function getGitPath(repoPath: string, gitPath: string): Promise<string> {
  const resolvedPath = await runGit(repoPath, [
    'rev-parse',
    '--git-path',
    gitPath,
  ]);
  return isAbsolute(resolvedPath) ? resolvedPath : join(repoPath, resolvedPath);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function cleanupTempIndex(indexPath: string): Promise<void> {
  await Promise.all([
    unlink(indexPath).catch(() => undefined),
    unlink(`${indexPath}.lock`).catch(() => undefined),
  ]);
}

export async function captureWorkingTreeSha(
  repoPath: string,
  attributes: GitSnapshotAttributeOptions = {},
): Promise<string> {
  const indexPath = join(tmpdir(), `canopy-idx-${randomUUID()}`);
  const gitDir = await getGitDir(repoPath);
  const env = buildGitEnv(indexPath, repoPath, gitDir, attributes);
  const repoIndexPath = await getGitPath(repoPath, 'index');

  try {
    let absentSkipWorktreePaths: string[] = [];
    if (await pathExists(repoIndexPath)) {
      // Git rehashes entries no older than the index file's own mtime. A copy
      // gets a new mtime, so keep the source's: same-size edits made in the
      // same timestamp tick as its last write would otherwise look clean. Read
      // it before copying, so a concurrent rewrite only makes it older.
      const sourceIndex = await stat(repoIndexPath);
      await copyFile(repoIndexPath, indexPath);
      await utimes(indexPath, sourceIndex.atime, sourceIndex.mtime);
      const unmergedEntries = await runGitWithEnv(
        repoPath,
        ['ls-files', '--unmerged'],
        env,
      );
      if (unmergedEntries.length > 0) {
        // A conflicted index cannot be written as a tree. Seed from HEAD and
        // let add --all collapse the working copy back to stage-zero entries.
        await runGitWithEnv(
          repoPath,
          [...getBytePreservingGitConfig(), 'read-tree', 'HEAD'],
          env,
        );
      } else {
        // Clear only flags that can hide on-disk edits. Rebuilding via
        // write-tree/read-tree would discard the copied index's stat cache and
        // force every snapshot caller to rehash the entire worktree.
        absentSkipWorktreePaths = await clearWorktreeOnlyIndexFlags(
          repoPath,
          env,
        );
        const autocrlf = await runGitWithEnv(
          repoPath,
          ['config', '--default', 'false', '--get', 'core.autocrlf'],
          env,
        );
        if (
          autocrlf === 'true' ||
          autocrlf === 'input' ||
          attributes.attributeSource !== undefined
        ) {
          // A copied stat-clean index may still point at a blob normalized
          // under the checkout's own attributes or autocrlf. Re-read its tree
          // with byte-preserving config so the subsequent add must hash the
          // actual working-tree bytes.
          const indexTree = await runGitWithEnv(repoPath, ['write-tree'], env);
          await unlink(indexPath);
          await runGitWithEnv(
            repoPath,
            [...getBytePreservingGitConfig(), 'read-tree', indexTree],
            env,
          );
        }
      }
    } else if (await hasHeadCommit(repoPath)) {
      await runGitWithEnv(
        repoPath,
        [...getBytePreservingGitConfig(), 'read-tree', 'HEAD'],
        env,
      );
    } else {
      await runGitWithEnv(
        repoPath,
        [...getBytePreservingGitConfig(), 'read-tree', '--empty'],
        env,
      );
    }

    await runGitWithEnvAndInput(
      repoPath,
      [
        ...getBytePreservingGitConfig(),
        'add',
        '--all',
        '--sparse',
        '--pathspec-from-file=-',
        '--pathspec-file-nul',
      ],
      env,
      `${[
        '.',
        ...absentSkipWorktreePaths.map((path) => `:(exclude,literal)${path}`),
      ].join('\0')}\0`,
    );
    const treeSha = await runGitWithEnv(repoPath, ['write-tree'], env);
    return treeSha;
  } finally {
    await cleanupTempIndex(indexPath);
  }
}

export async function diffTreeObjects(
  repoPath: string,
  startTree: string,
  endTree: string,
): Promise<ChangedFileInfo[]> {
  const startTreeRef = `${startTree}^{tree}`;
  const endTreeRef = `${endTree}^{tree}`;

  const [statusOutput, numstatOutput] = await Promise.all([
    runGitWithEnv(
      repoPath,
      [
        'diff',
        '--name-status',
        '--find-renames',
        '--find-copies',
        startTreeRef,
        endTreeRef,
      ],
      { ...process.env },
    ),
    runGitWithEnv(
      repoPath,
      [
        'diff',
        '--numstat',
        '--find-renames',
        '--find-copies',
        startTreeRef,
        endTreeRef,
      ],
      { ...process.env },
    ),
  ]);

  return Array.from(parseDiffOutput(statusOutput, numstatOutput).values());
}

export interface StreamingTreeDiffResult {
  files: ChangedFileInfo[];
  totalCount: number;
  truncated: boolean;
}

function parseNumstatCount(value: string): number {
  return value === '-' ? 0 : Number.parseInt(value, 10) || 0;
}

function mapDiffStatus(statusCode: string): ChangedFileInfo['status'] {
  switch (statusCode[0]) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'U':
      return 'unmerged';
    case 'T':
      return 'type-changed';
    default:
      return 'unknown';
  }
}

export async function streamGitNulTokens(args: {
  repoPath: string;
  gitArgs: string[];
  timeoutMs: number;
  onToken: (token: string) => void;
  validateComplete?: () => void;
  signal?: AbortSignal;
  input?: string | Buffer;
  operation?: 'diff' | 'attribute check' | 'submodule check';
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const runtime = gitTreeSnapshotRuntime;
  const signals = [args.signal, runtime.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (signals.some((signal) => signal.aborted)) {
    throw new Error(ARCHIVED_GIT_DIFF_CANCELLED_MESSAGE);
  }
  const executable = await runtime.resolveExecutable();
  const operation = `Archived Git ${args.operation ?? 'diff'}`;
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, args.gitArgs, {
      cwd: args.repoPath,
      env: withGitRequestContextEnv(args.env ?? archiveGitEnv()),
      detached: runtime.detached ?? false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });
    let settled = false;
    let spawned = false;
    let terminationError: Error | undefined;
    let stdinError: Error | undefined;
    let carry = '';
    let stderr = '';
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const signal of signals) {
        signal.removeEventListener('abort', onAbort);
      }
      if (error) reject(error);
      else resolvePromise();
    };
    const terminateAfterClose = (error: Error): void => {
      terminationError ??= error;
      if (child.pid && runtime.terminateChild) {
        void runtime.terminateChild(child.pid).catch(() => {
          child.kill('SIGKILL');
        });
      } else {
        child.kill('SIGKILL');
      }
    };
    const onAbort = (): void => {
      terminateAfterClose(new Error(ARCHIVED_GIT_DIFF_CANCELLED_MESSAGE));
    };
    const timer = setTimeout(
      () => {
        terminateAfterClose(new Error(`${operation} timed out.`));
      },
      Math.max(1, args.timeoutMs),
    );
    timer.unref?.();
    for (const signal of signals) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (signals.some((signal) => signal.aborted)) onAbort();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled || terminationError) return;
      try {
        const tokens = `${carry}${chunk}`.split('\0');
        carry = tokens.pop() ?? '';
        for (const token of tokens) args.onToken(token);
      } catch (error) {
        terminateAfterClose(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 64 * 1024) {
        stderr += chunk.slice(0, 64 * 1024 - stderr.length);
      }
    });
    child.once('spawn', () => {
      spawned = true;
      if (child.pid) runtime.childStarted?.(child.pid);
    });
    child.on('error', (error) => {
      if (!spawned) {
        finish(terminationError ?? error);
      } else {
        terminationError ??= error;
      }
    });
    child.on('close', (code, signal) => {
      if (child.pid) runtime.childExited?.(child.pid, code, signal);
      if (settled) return;
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (code !== 0) {
        finish(
          new Error(
            `${operation} failed (${signal ?? String(code)}): ${stderr.trim()}`,
          ),
        );
        return;
      }
      if (carry.length > 0) {
        finish(new Error(`${operation} returned an incomplete record.`));
        return;
      }
      try {
        args.validateComplete?.();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (stdinError) {
        finish(stdinError);
        return;
      }
      finish();
    });
    // A child can close stdin after emitting malformed output. Defer EPIPE
    // until close so output and completion validation retain precedence. Other
    // stdin failures still terminate the child, but none escape unhandled.
    child.stdin.on('error', (error) => {
      stdinError ??= error;
      if (!isErrnoException(error) || error.code !== 'EPIPE') {
        terminateAfterClose(error);
      }
    });
    child.stdin.end(args.input);
  });
}

/**
 * Streams the immutable tree comparison. Only `maxRecords` rows are retained;
 * the real total continues to be counted without buffering the tail.
 */
export async function streamArchiveTreeDiff(
  repoPath: string,
  startTree: string,
  endTree: string,
  maxRecords = ARCHIVE_DIFF_MAX_RECORDS,
  signal?: AbortSignal,
): Promise<StreamingTreeDiffResult> {
  if (signal?.aborted) {
    throw new Error(ARCHIVED_GIT_DIFF_CANCELLED_MESSAGE);
  }
  const deadline = Date.now() + ARCHIVE_DIFF_TIMEOUT_MS;
  const baseArgs = [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames',
    '--find-copies',
    '-z',
    `${startTree}^{tree}`,
    `${endTree}^{tree}`,
  ];
  const files: ChangedFileInfo[] = [];
  let totalCount = 0;
  let statusCode: string | null = null;
  let previousPath: string | null = null;

  await streamGitNulTokens({
    repoPath,
    gitArgs: [...baseArgs.slice(0, 1), '--name-status', ...baseArgs.slice(1)],
    timeoutMs: deadline - Date.now(),
    ...(signal ? { signal } : {}),
    onToken(token) {
      if (statusCode === null) {
        if (!token) return;
        statusCode = token;
        return;
      }
      if (
        (statusCode.startsWith('R') || statusCode.startsWith('C')) &&
        previousPath === null
      ) {
        previousPath = token;
        return;
      }
      totalCount += 1;
      if (files.length < maxRecords) {
        files.push({
          path: token,
          status: mapDiffStatus(statusCode),
          insertions: 0,
          deletions: 0,
          ...(previousPath !== null ? { previousPath } : {}),
        });
      }
      statusCode = null;
      previousPath = null;
    },
  });
  if (statusCode !== null || previousPath !== null) {
    throw new Error('Archived Git name-status output was incomplete.');
  }
  if (signal?.aborted) {
    throw new Error(ARCHIVED_GIT_DIFF_CANCELLED_MESSAGE);
  }

  let numstatCount = 0;
  let pendingCounts: [number, number] | null = null;
  let pendingOldPath: string | null = null;
  const applyNumstat = (
    path: string,
    oldPath: string | undefined,
    counts: [number, number],
  ): void => {
    if (numstatCount < files.length) {
      const record = files[numstatCount];
      if (record.path !== path || record.previousPath !== oldPath) {
        throw new Error(
          'Archived Git diff streams returned different ordering.',
        );
      }
      record.insertions = counts[0];
      record.deletions = counts[1];
    }
    numstatCount += 1;
  };

  await streamGitNulTokens({
    repoPath,
    gitArgs: [...baseArgs.slice(0, 1), '--numstat', ...baseArgs.slice(1)],
    timeoutMs: deadline - Date.now(),
    ...(signal ? { signal } : {}),
    onToken(token) {
      if (pendingCounts !== null) {
        if (pendingOldPath === null) {
          pendingOldPath = token;
          return;
        }
        applyNumstat(token, pendingOldPath, pendingCounts);
        pendingCounts = null;
        pendingOldPath = null;
        return;
      }
      if (!token) return;
      const firstTab = token.indexOf('\t');
      const secondTab = token.indexOf('\t', firstTab + 1);
      if (firstTab < 0 || secondTab < 0) {
        throw new Error('Archived Git numstat output was malformed.');
      }
      const counts: [number, number] = [
        parseNumstatCount(token.slice(0, firstTab)),
        parseNumstatCount(token.slice(firstTab + 1, secondTab)),
      ];
      const path = token.slice(secondTab + 1);
      if (path.length === 0) {
        pendingCounts = counts;
        return;
      }
      applyNumstat(path, undefined, counts);
    },
  });
  if (pendingCounts !== null || pendingOldPath !== null) {
    throw new Error('Archived Git numstat output was incomplete.');
  }
  if (numstatCount !== totalCount) {
    throw new Error(
      'Archived Git diff streams returned different record counts.',
    );
  }

  return {
    files,
    totalCount,
    truncated: totalCount > files.length,
  };
}
