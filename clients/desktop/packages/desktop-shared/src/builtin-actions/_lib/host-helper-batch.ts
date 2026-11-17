import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  HOST_HELPER_PREPARE_ENV,
  HOST_HELPER_RESULTS_ENV,
  parseHostHelperBatchResults,
  parseHostHelperPreparedTargets,
  type HostHelperPreparedTarget,
  type HostHelperBatchRequest,
  type HostHelperBatchResult,
} from '@canopy/execution-engine/builtin-actions/_lib/host-helper-model';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';

/**
 * How a commit or pull request helper runs (CAN-6702 stage 1b):
 * - `inline`: the action calls the model itself, as before.
 * - `prepare`: the action writes one model request per repository and makes
 *   no commit, push, pull request or model call.
 * - `apply`: the action uses the host's results and refuses any repository
 *   whose request no longer matches.
 */
export type HostHelperBatchMode =
  | { kind: 'inline' }
  | {
      kind: 'prepare';
      requests: HostHelperBatchRequest[];
      /** Repositories that need no model turn but will push; see `recordPreparedTarget`. */
      targets: HostHelperPreparedTarget[];
      file: string;
    }
  | {
      kind: 'apply';
      results: ReadonlyMap<string, HostHelperBatchResult>;
      /** Prepared target digest by repository digest; see `requirePreparedTarget`. */
      targets: ReadonlyMap<string, string>;
    };

/** Only the host sets these; it strips them from every pipeline layer. */
export function readHostHelperBatchMode(
  env: NodeJS.ProcessEnv,
): HostHelperBatchMode {
  const prepareFile = getBrandEnv(env, HOST_HELPER_PREPARE_ENV);
  const resultsFile = getBrandEnv(env, HOST_HELPER_RESULTS_ENV);
  if (prepareFile && resultsFile)
    throw new Error('A helper step cannot prepare and apply at once.');
  if (prepareFile)
    return { kind: 'prepare', requests: [], targets: [], file: prepareFile };
  if (resultsFile) {
    const text = readFileSync(resultsFile, 'utf8');
    return {
      kind: 'apply',
      results: parseHostHelperBatchResults(text),
      targets: new Map(
        parseHostHelperPreparedTargets(text).map((target) => [
          target.repo,
          target.digest,
        ]),
      ),
    };
  }
  return { kind: 'inline' };
}

/**
 * Identifies one repository's request. Apply rebuilds the request from the
 * repository's current state, so any change to the branch, diff, commit log,
 * template or instructions changes the digest.
 */
export function hostHelperRequestDigest(
  repoPath: string,
  request: Omit<HostHelperBatchRequest, 'digest'>,
  identity: string,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        repoPath,
        request.systemPrompt,
        request.userMessage,
        request.schema,
        identity,
      ]),
    )
    .digest('hex');
}

const execFileAsync = promisify(execFile);

async function git(
  repoPath: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
    ...(env ? { env } : {}),
  });
  return stdout;
}

/** Runs git with `input` on stdin. */
function gitWithInput(
  repoPath: string,
  args: string[],
  input: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd: repoPath, encoding: 'utf8' },
      (error, stdout) => {
        if (error) reject(new Error(error.message));
        else resolve(stdout);
      },
    );
    child.stdin?.end(input);
  });
}

/** The commit HEAD points at. */
export async function headCommit(repoPath: string): Promise<string> {
  return (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
}

/**
 * Where a host-run helper's change lands: HEAD, the checked-out branch ('' when
 * detached) and every effective push URL of `origin`, after `insteadOf`
 * rewriting. Only ever hashed or compared; never logged, since a URL can hold
 * a credential.
 */
export interface RepoTarget {
  head: string;
  branch: string;
  pushUrls: string[];
}

export async function repoTarget(repoPath: string): Promise<RepoTarget> {
  const head = await headCommit(repoPath);
  const branch = (
    await git(repoPath, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(
      () => '',
    )
  ).trim();
  const pushUrls = (
    await git(repoPath, [
      'remote',
      'get-url',
      '--push',
      '--all',
      'origin',
    ]).catch(() => '')
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return { head, branch, pushUrls };
}

export function sameTarget(a: RepoTarget, b: RepoTarget): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function preparedTargetKey(repoPath: string): string {
  return sha256(JSON.stringify(['repo', repoPath]));
}

function preparedTargetDigest(repoPath: string, target: RepoTarget): string {
  return sha256(
    JSON.stringify([
      'target',
      repoPath,
      target.head,
      target.branch,
      target.pushUrls,
    ]),
  );
}

/**
 * Records where a repository that needs no model turn would push, so that
 * apply pushes it only while HEAD, the branch and the push URL are still
 * what prepare saw. A repository that prepared a model request instead is
 * covered by that request's digest, and records nothing here: if something
 * else commits its changes before apply, apply finds no prepared target for
 * the now-clean worktree and refuses to push it (CAN-6702).
 */
export function recordPreparedTarget(
  mode: Extract<HostHelperBatchMode, { kind: 'prepare' }>,
  repoPath: string,
  target: RepoTarget,
): void {
  const repo = preparedTargetKey(repoPath);
  mode.targets = mode.targets.filter((entry) => entry.repo !== repo);
  mode.targets.push({ repo, digest: preparedTargetDigest(repoPath, target) });
}

/** Refuses a push unless prepare saw exactly this target for the repository. */
export function requirePreparedTarget(
  mode: Extract<HostHelperBatchMode, { kind: 'apply' }>,
  repoPath: string,
  target: RepoTarget,
): void {
  const prepared = mode.targets.get(preparedTargetKey(repoPath));
  if (prepared === undefined)
    throw new Error(
      'No prepared push matches this repository: it changed after the helper prepared its requests, or could not be read then. Nothing was pushed for it. Run the step again.',
    );
  if (prepared !== preparedTargetDigest(repoPath, target))
    throw new Error(
      'The branch, its commit or its push destination changed after the push was prepared, so nothing was pushed. Run the step again.',
    );
}

/** Refuses a target a host-run helper cannot push to unambiguously. */
export function assertPushableTarget(target: RepoTarget): void {
  if (!target.branch)
    throw new Error(
      'HEAD is detached, so a host-run helper cannot tell which branch to update. Check out a branch, then run the step again.',
    );
  if (target.pushUrls.length !== 1)
    throw new Error(
      target.pushUrls.length === 0
        ? 'The repository has no origin to push to.'
        : 'origin has more than one push URL, so a host-run helper cannot prove where it would push. Leave one push URL, then run the step again.',
    );
}

function nulFields(text: string): string[] {
  return text.split('\0').filter((field) => field.length > 0);
}

function identityText(
  target: RepoTarget,
  entries: ReadonlyMap<string, string>,
): string {
  return JSON.stringify([
    target.head,
    target.branch,
    target.pushUrls,
    [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);
}

const UNSUPPORTED = 'unsupported';

async function trackFileMode(repoPath: string): Promise<boolean> {
  const value = (
    await git(repoPath, ['config', '--bool', 'core.fileMode']).catch(() => '')
  ).trim();
  return value !== 'false';
}

/**
 * What `git add -A` would stage, path by path: the mode and blob id of the
 * current content (computed without writing objects; symlinks as their link
 * text, through git so the object format matches), or `deleted`, plus the
 * repository's target. A submodule or other non-file entry is marked
 * unsupported, and such a repository is refused before anything is staged.
 */
export async function workingTreeIdentity(
  repoPath: string,
): Promise<{ identity: string; target: RepoTarget }> {
  const target = await repoTarget(repoPath);
  const fileMode = await trackFileMode(repoPath);
  const paths = new Set([
    ...nulFields(
      await git(repoPath, [
        'diff',
        'HEAD',
        '--name-only',
        '-z',
        '--no-renames',
      ]),
    ),
    ...nulFields(
      await git(repoPath, ['ls-files', '--others', '--exclude-standard', '-z']),
    ),
  ]);
  const entries = new Map<string, string>();
  for (const file of paths) {
    const absolute = join(repoPath, file);
    const stats = await lstat(absolute).catch(() => null);
    if (!stats) {
      entries.set(file, 'deleted');
    } else if (stats.isSymbolicLink()) {
      const link = await readlink(absolute);
      const id = (
        await gitWithInput(
          repoPath,
          ['hash-object', '-t', 'blob', '--no-filters', '--stdin'],
          link,
        )
      ).trim();
      entries.set(file, `120000 ${id}`);
    } else if (stats.isFile()) {
      const mode = !fileMode
        ? 'file'
        : (stats.mode & 0o111) !== 0
          ? '100755'
          : '100644';
      const id = (await git(repoPath, ['hash-object', '--', file])).trim();
      entries.set(file, `${mode} ${id}`);
    } else {
      entries.set(file, UNSUPPORTED);
    }
  }
  return { identity: identityText(target, entries), target };
}

export function identityHasUnsupportedEntry(identity: string): boolean {
  return identity.includes(`"${UNSUPPORTED}"`);
}

/** The same identity, read from an index after staging. */
async function stagedIdentity(
  repoPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const target = await repoTarget(repoPath);
  const fileMode = await trackFileMode(repoPath);
  const fields = nulFields(
    await git(
      repoPath,
      [
        'diff',
        '--cached',
        '--raw',
        '--no-abbrev',
        '-z',
        '--no-renames',
        'HEAD',
      ],
      env,
    ),
  );
  const entries = new Map<string, string>();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    // ":<old mode> <new mode> <old id> <new id> <status>", then the path.
    const [, newMode, , newId, status] = (fields[index] ?? '').split(' ');
    const file = fields[index + 1] ?? '';
    if (status === 'D') {
      entries.set(file, 'deleted');
    } else if (newMode === '120000') {
      entries.set(file, `120000 ${newId ?? ''}`);
    } else if (newMode === '100644' || newMode === '100755') {
      entries.set(file, `${fileMode ? newMode : 'file'} ${newId ?? ''}`);
    } else {
      entries.set(file, UNSUPPORTED);
    }
  }
  return identityText(target, entries);
}

async function gitPath(repoPath: string, name: string): Promise<string> {
  return (
    await git(repoPath, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      name,
    ])
  ).trim();
}

/**
 * Refuses, before anything is staged, a repository whose index or operation
 * state an isolated index copy cannot carry faithfully into the commit.
 */
export async function assertCommittableState(repoPath: string): Promise<void> {
  const refuse = (what: string): never => {
    throw new Error(
      `${what}, so a host-run helper cannot commit it safely. Nothing was staged or committed. Resolve it, then run the step again.`,
    );
  };
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if (
      await lstat(await gitPath(repoPath, name))
        .then(() => true)
        .catch(() => false)
    )
      refuse('A merge, cherry-pick or revert is in progress');
  }
  if ((await git(repoPath, ['ls-files', '-u', '-z'])).length > 0)
    refuse('The index has unresolved conflicts');
  const config = async (key: string): Promise<string> =>
    (await git(repoPath, ['config', '--bool', key]).catch(() => '')).trim();
  if ((await config('core.sparseCheckout')) === 'true')
    refuse('The repository uses a sparse checkout');
  if ((await config('core.splitIndex')) === 'true')
    refuse('The repository uses a split index');
  const flagged = nulFields(await git(repoPath, ['ls-files', '-v', '-z'])).some(
    (line) => line.startsWith('S ') || /^[a-z] /.test(line),
  );
  if (flagged)
    refuse('Some files are marked skip-worktree or assume-unchanged');
  const statusFields = nulFields(
    await git(repoPath, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=no',
    ]),
  );
  if (statusFields.some((field) => field.startsWith(' A ')))
    refuse('Some files are marked intent-to-add');
}

/**
 * Whether this git can run repository hooks outside `git commit`: `git hook
 * run` arrived in git 2.36. Decided from the version rather than by probing
 * with a made-up hook name, which newer gits reject as unknown.
 */
async function canRunHooks(repoPath: string): Promise<boolean> {
  const version = /(\d+)\.(\d+)/.exec(
    await git(repoPath, ['--version']).catch(() => ''),
  );
  if (!version) return false;
  const major = Number(version[1]);
  const minor = Number(version[2]);
  return major > 2 || (major === 2 && minor >= 36);
}

function hookError(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'stderr' in error &&
    typeof error.stderr === 'string' &&
    error.stderr.trim()
  )
    return error.stderr.trim();
  return error instanceof Error ? error.message : String(error);
}

/** A commit made on the branch whose index could not be updated. */
export class CommittedIndexNotUpdatedError extends Error {
  constructor(readonly commitHash: string) {
    super(
      'The commit was created, but the helper did not update your index. Nothing was pushed; reconcile the local commit and staging before continuing.',
    );
    this.name = 'CommittedIndexNotUpdatedError';
  }
}

/** The pre-commit hook refused; nothing was committed. */
export class PreCommitRefusedError extends Error {
  constructor(readonly hookOutput: string) {
    super(`The pre-commit hook failed. Nothing was committed.\n${hookOutput}`);
    this.name = 'PreCommitRefusedError';
  }
}

/**
 * Commits exactly the checked content on the checked branch (CAN-6702).
 *
 * Everything is staged into a private copy of the index; the helper never
 * replaces the user's index. The staged entries must equal
 * `identity`. The repository's pre-commit, prepare-commit-msg and commit-msg
 * hooks run on that copy, as `git commit` would run them; a pre-commit hook
 * can still change what is committed. The branch moves only by a
 * compare-and-swap from `target.head`, so a branch that moved is never
 * overwritten. After the commit, success requires the unchanged real index
 * to already contain the committed entries. Otherwise the index is preserved
 * and `CommittedIndexNotUpdatedError` reports the retained local commit for
 * manual reconciliation. The index lock does not lock refs; avoiding index
 * replacement removes the destructive ref/index publication race.
 */
export async function commitCheckedContent(input: {
  repoPath: string;
  identity: string;
  target: RepoTarget;
  message: string;
}): Promise<string> {
  const { repoPath, identity, target } = input;
  if (!(await canRunHooks(repoPath)))
    throw new Error(
      'This git cannot run repository hooks on their own (git 2.36 or later is needed), so a host-run helper cannot commit. Nothing was committed.',
    );
  const indexPath = await gitPath(repoPath, 'index');
  const original = await readFile(indexPath).catch(() => null);
  const work = await mkdtemp(join(tmpdir(), 'canopy-host-commit-'));
  try {
    const privateIndex = join(work, 'index');
    const originalIndex = join(work, 'original-index');
    if (original) await writeFile(privateIndex, original);
    if (original) await writeFile(originalIndex, original);
    const env = { ...process.env, GIT_INDEX_FILE: privateIndex };
    await git(repoPath, ['add', '-A'], env);
    if ((await stagedIdentity(repoPath, env)) !== identity)
      throw new Error(
        'The repository changed while it was being committed. Nothing was committed or pushed for it, and your index was not touched. Run the step again.',
      );
    try {
      await git(
        repoPath,
        ['hook', 'run', '--ignore-missing', 'pre-commit'],
        env,
      );
    } catch (error) {
      throw new PreCommitRefusedError(hookError(error));
    }
    const messageFile = join(work, 'COMMIT_EDITMSG');
    await writeFile(messageFile, `${input.message.trim()}\n`, 'utf8');
    await git(
      repoPath,
      [
        'hook',
        'run',
        '--ignore-missing',
        'prepare-commit-msg',
        '--',
        messageFile,
        'message',
      ],
      env,
    );
    await git(
      repoPath,
      ['hook', 'run', '--ignore-missing', 'commit-msg', '--', messageFile],
      env,
    );
    const message = (await readFile(messageFile, 'utf8')).trim();
    if (!message) throw new Error('Commit message must not be empty');
    // Hooks can change HEAD or origin independently of their private index.
    // Recheck the destination before constructing or publishing the commit.
    if (!sameTarget(await repoTarget(repoPath), target))
      throw new Error(
        'The branch or its push destination changed while commit hooks ran. Nothing was committed or pushed. Run the step again.',
      );
    const tree = (await git(repoPath, ['write-tree'], env)).trim();
    const commit = (
      await git(repoPath, [
        'commit-tree',
        tree,
        '-p',
        target.head,
        '-F',
        messageFile,
      ])
    ).trim();
    // Compare-and-swap: fails if the branch no longer points at target.head.
    await git(repoPath, [
      'update-ref',
      '-m',
      `commit: ${message.split('\n')[0] ?? ''}`,
      `refs/heads/${target.branch}`,
      commit,
      target.head,
    ]).catch(() => {
      throw new Error(
        'The branch moved while it was being committed, so it was not updated. Nothing was pushed. Run the step again.',
      );
    });
    await assertIndexMatchesCommit({
      repoPath,
      indexPath,
      original,
      privateIndex,
      originalIndex,
      branch: target.branch,
      commit,
    }).catch(() => {
      throw new CommittedIndexNotUpdatedError(commit);
    });
    // As after `git commit`; its outcome does not change the commit.
    await git(repoPath, [
      'hook',
      'run',
      '--ignore-missing',
      'post-commit',
    ]).catch(() => undefined);
    return commit;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function assertIndexMatchesCommit(input: {
  repoPath: string;
  indexPath: string;
  original: Buffer | null;
  privateIndex: string;
  originalIndex: string;
  branch: string;
  commit: string;
}): Promise<void> {
  const lock = `${input.indexPath}.lock`;
  // Git's own lock: fails if another git process is writing the index.
  const handle = await open(lock, 'wx', 0o644);
  try {
    const current = await readFile(input.indexPath).catch(() => null);
    const unchanged =
      current === null || input.original === null
        ? current === input.original
        : current.equals(input.original);
    const symbolic = (
      await git(input.repoPath, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')
    ).trim();
    const head = await headCommit(input.repoPath);
    if (
      !unchanged ||
      symbolic !== `refs/heads/${input.branch}` ||
      head !== input.commit
    )
      throw new Error('The index or HEAD changed.');
    // Compare immutable private copies by their entries, not index metadata.
    // Never publish either copy: index.lock cannot coordinate ref writers.
    const originalEntries = input.original
      ? await git(input.repoPath, ['ls-files', '--stage', '-z'], {
          ...process.env,
          GIT_INDEX_FILE: input.originalIndex,
        })
      : '';
    const committedEntries = await git(
      input.repoPath,
      ['ls-files', '--stage', '-z'],
      { ...process.env, GIT_INDEX_FILE: input.privateIndex },
    );
    if (originalEntries !== committedEntries)
      throw new Error('The existing index needs manual reconciliation.');
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lock, { force: true });
  }
}

/**
 * Pushes exactly `commit` to the checked branch on origin, after checking
 * that the branch still points at it and origin still has the one checked
 * push URL. origin is still resolved from the repository's configuration
 * when git pushes, so a configuration change in the moment between that
 * check and the push is not covered.
 */
export async function pushCheckedCommit(input: {
  repoPath: string;
  target: RepoTarget;
  commit: string;
}): Promise<void> {
  const { repoPath, target, commit } = input;
  const branchTip = (
    await git(repoPath, ['rev-parse', `refs/heads/${target.branch}`])
  ).trim();
  const now = await repoTarget(repoPath);
  if (
    branchTip !== commit ||
    JSON.stringify(now.pushUrls) !== JSON.stringify(target.pushUrls)
  )
    throw new Error(
      'The branch or its push destination changed after the commit was made, so it was not pushed. Run the step again.',
    );
  await git(repoPath, [
    'push',
    '--porcelain',
    'origin',
    `${commit}:refs/heads/${target.branch}`,
  ]);
  // As `git push -u` would, when the branch has no upstream yet.
  const upstream = (
    await git(repoPath, ['config', `branch.${target.branch}.remote`]).catch(
      () => '',
    )
  ).trim();
  if (!upstream)
    await git(repoPath, [
      'branch',
      `--set-upstream-to=origin/${target.branch}`,
      target.branch,
    ]).catch(() => undefined);
}

/** The commit origin's branch points at, or '' when it has none. */
export async function remoteBranchTip(
  repoPath: string,
  branch: string,
): Promise<string> {
  const line = await git(repoPath, [
    'ls-remote',
    'origin',
    `refs/heads/${branch}`,
  ]);
  return line.split('\t')[0]?.trim() ?? '';
}

/** Writes the prepared requests; the host reads them after the action exits. */
export function writeHostHelperBatchRequests(
  mode: Extract<HostHelperBatchMode, { kind: 'prepare' }>,
): void {
  writeFileSync(
    mode.file,
    `${JSON.stringify({ version: 1, requests: mode.requests, targets: mode.targets })}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
}

/** The host result for a request rebuilt at apply time, or a refusal. */
export function requireHostHelperBatchResult(
  mode: Extract<HostHelperBatchMode, { kind: 'apply' }>,
  digest: string,
): HostHelperBatchResult {
  const result = mode.results.get(digest);
  if (!result)
    throw new Error(
      'No prepared model request matches this repository: it changed after the request was prepared, or could not be read then. Nothing was committed, pushed or created for it. Run the step again.',
    );
  return result;
}
