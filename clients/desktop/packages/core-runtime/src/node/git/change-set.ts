import type {
  WorkerGitDiffFile,
  WorkerGitDiffFileStatus,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';

/** A full commit or tree id: SHA-1 or SHA-256, lowercase. */
export const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The comparisons the change-set engine reads. `worktree` compares the
 * checkout with its index against `HEAD` or an object; `objects` compares two
 * committed states. Bases are already resolved: the engine never selects one.
 */
export type GitChangeSetRange =
  | { readonly kind: 'worktree'; readonly base: string }
  | { readonly kind: 'objects'; readonly base: string; readonly head: string };

/**
 * The fixed reads the engine runs. Each names one Git command; nothing else
 * is expressible. Output is `-z`, so paths arrive raw.
 */
export type GitChangeSetRead =
  /** `diff <range> --name-status -z --find-renames --find-copies` */
  | { readonly kind: 'diff-name-status'; readonly range: GitChangeSetRange }
  /** `diff <range> --numstat -z --find-renames --find-copies` */
  | { readonly kind: 'diff-numstat'; readonly range: GitChangeSetRange }
  /** `ls-files --others --exclude-standard -z` */
  | { readonly kind: 'untracked-files' }
  /** `ls-files --unmerged -z` */
  | { readonly kind: 'unmerged-files' }
  /** `rev-parse --verify --quiet <object>^{object}`: exits 1 when absent. */
  | { readonly kind: 'object-exists'; readonly object: string };

/** A revision the engine passes to Git: `HEAD` or a full object id. */
export function isGitChangeSetRevision(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value === 'HEAD' || GIT_OBJECT_ID_PATTERN.test(value))
  );
}

/** A range's revision arguments for `git diff`. */
export function gitChangeSetRangeArgs(range: GitChangeSetRange): string[] {
  return range.kind === 'worktree'
    ? [range.base]
    : [`${range.base}..${range.head}`];
}

/** The argv of a {@link GitChangeSetRead}, after the Git executable. */
export function gitChangeSetReadArgs(read: GitChangeSetRead): string[] {
  switch (read.kind) {
    case 'diff-name-status':
      return [
        'diff',
        ...gitChangeSetRangeArgs(read.range),
        '--name-status',
        '-z',
        '--find-renames',
        '--find-copies',
      ];
    case 'diff-numstat':
      return [
        'diff',
        ...gitChangeSetRangeArgs(read.range),
        '--numstat',
        '-z',
        '--find-renames',
        '--find-copies',
      ];
    case 'untracked-files':
      return ['ls-files', '--others', '--exclude-standard', '-z'];
    case 'unmerged-files':
      return ['ls-files', '--unmerged', '-z'];
    case 'object-exists':
      return ['rev-parse', '--verify', '--quiet', `${read.object}^{object}`];
  }
}

/** One untracked file's estimated added lines, and whether it is binary. */
export interface GitUntrackedEstimate {
  readonly insertions: number;
  readonly binary: boolean;
  /** A confined estimate skipped the file: its parent resolves outside the root. */
  readonly confined?: true;
}

/** At most this many untracked files are listed, in Git's listing order. */
export const GIT_CHANGE_SET_MAX_UNTRACKED_FILES = 200;

/** Host reads for one repository. Paths are repository-relative. */
export interface GitChangeSetReader {
  /** Untrimmed stdout of a read that exited 0; any other outcome rejects. */
  read(this: void, read: GitChangeSetRead): Promise<string>;
  /**
   * Added-line estimates for untracked files, in order: regular files of at
   * most 512,000 bytes, binary when a NUL is in the first 8,000 bytes, 0 for
   * anything unreadable, and at most 100,000 lines in total, counted in order.
   */
  estimateUntracked(
    this: void,
    paths: readonly string[],
  ): Promise<readonly GitUntrackedEstimate[]>;
}

export type GitReadOutcome =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly error: unknown };

/**
 * Every read of one comparison, settled: what the canonical result and a
 * host's compatibility projection are both built from.
 */
export interface GitChangeSetSample {
  readonly range: GitChangeSetRange;
  readonly nameStatus: GitReadOutcome;
  readonly numstat: GitReadOutcome;
  /** `worktree` ranges only. */
  readonly untracked: GitReadOutcome | null;
  /** `worktree` ranges only. */
  readonly unmerged: GitReadOutcome | null;
  /** For the first {@link GIT_CHANGE_SET_MAX_UNTRACKED_FILES} untracked paths. */
  readonly untrackedEstimates: readonly GitUntrackedEstimate[];
}

function settle(promise: Promise<string>): Promise<GitReadOutcome> {
  return promise.then(
    (stdout): GitReadOutcome => ({ ok: true, stdout }),
    (error: unknown): GitReadOutcome => ({ ok: false, error }),
  );
}

/** `\0`-separated fields; the trailing terminator leaves no empty field. */
function fields(stdout: string): string[] {
  const parts = stdout.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export function parseGitPathListZ(stdout: string): string[] {
  return fields(stdout);
}

export interface GitNameStatusRecord {
  /** Git's status, such as `M` or `R087`. */
  readonly code: string;
  readonly path: string;
  /** Renames and copies only. */
  readonly previousPath?: string;
}

export function parseGitNameStatusZ(stdout: string): GitNameStatusRecord[] {
  const parts = fields(stdout);
  const records: GitNameStatusRecord[] = [];
  for (let index = 0; index < parts.length; ) {
    const code = parts[index] ?? '';
    const paired = code.startsWith('R') || code.startsWith('C');
    const first = parts[index + 1];
    const second = paired ? parts[index + 2] : undefined;
    index += paired ? 3 : 2;
    if (first === undefined || (paired && second === undefined)) break;
    records.push(
      second === undefined
        ? { code, path: first }
        : { code, path: second, previousPath: first },
    );
  }
  return records;
}

export interface GitNumstatRecord {
  /** Git's text: digits, or `-` for binary content. */
  readonly added: string;
  readonly deleted: string;
  readonly path: string;
  /** Renames and copies only. */
  readonly previousPath?: string;
}

export function parseGitNumstatZ(stdout: string): GitNumstatRecord[] {
  const parts = fields(stdout);
  const records: GitNumstatRecord[] = [];
  for (let index = 0; index < parts.length; ) {
    const [added = '', deleted = '', ...rest] = (parts[index] ?? '').split(
      '\t',
    );
    const inlinePath = rest.join('\t');
    if (inlinePath !== '') {
      records.push({ added, deleted, path: inlinePath });
      index += 1;
      continue;
    }
    // A rename or copy: an empty path field, then source and destination.
    const previousPath = parts[index + 1];
    const path = parts[index + 2];
    index += 3;
    if (previousPath === undefined || path === undefined) break;
    records.push({ added, deleted, path, previousPath });
  }
  return records;
}

export interface GitUnmergedRecord {
  /** `<mode> <object> <stage>`. */
  readonly entry: string;
  readonly path: string;
}

export function parseGitUnmergedZ(stdout: string): GitUnmergedRecord[] {
  return fields(stdout).flatMap((field) => {
    const tab = field.indexOf('\t');
    return tab === -1
      ? []
      : [{ entry: field.slice(0, tab), path: field.slice(tab + 1) }];
  });
}

/** Reads every part of one comparison, failures included. */
export async function sampleGitChangeSet(
  reader: GitChangeSetReader,
  range: GitChangeSetRange,
): Promise<GitChangeSetSample> {
  const worktree = range.kind === 'worktree';
  const [nameStatus, numstat, untracked, unmerged] = await Promise.all([
    settle(reader.read({ kind: 'diff-name-status', range })),
    settle(reader.read({ kind: 'diff-numstat', range })),
    worktree ? settle(reader.read({ kind: 'untracked-files' })) : null,
    worktree ? settle(reader.read({ kind: 'unmerged-files' })) : null,
  ]);
  const listed =
    untracked?.ok === true
      ? parseGitPathListZ(untracked.stdout).slice(
          0,
          GIT_CHANGE_SET_MAX_UNTRACKED_FILES,
        )
      : [];
  return {
    range,
    nameStatus,
    numstat,
    untracked,
    unmerged,
    untrackedEstimates:
      listed.length === 0 ? [] : await reader.estimateUntracked(listed),
  };
}

export function gitChangeSetStatus(code: string): WorkerGitDiffFileStatus {
  switch (code[0]) {
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
    case 'T':
      return 'type_changed';
    case 'U':
      return 'unmerged';
    default:
      return 'unknown';
  }
}

const byPath = (left: WorkerGitDiffFile, right: WorkerGitDiffFile): number =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

function count(text: string): number {
  return text === '-' ? 0 : Number.parseInt(text, 10) || 0;
}

/** The canonical files of a sample whose reads all succeeded. */
function changedFiles(
  sample: GitChangeSetSample,
  nameStatus: string,
  numstat: string,
): { files: WorkerGitDiffFile[]; truncated: boolean } {
  const files = new Map<string, WorkerGitDiffFile>();
  for (const record of parseGitNameStatusZ(nameStatus))
    files.set(record.path, {
      path: record.path,
      previousPath: record.previousPath ?? null,
      status: gitChangeSetStatus(record.code),
      additions: 0,
      deletions: 0,
      patch: null,
    });
  for (const record of parseGitNumstatZ(numstat)) {
    const existing = files.get(record.path);
    if (!existing) continue;
    const binary = record.added === '-' && record.deleted === '-';
    files.set(record.path, {
      ...existing,
      additions: count(record.added),
      deletions: count(record.deleted),
      ...(binary ? { binary: true } : {}),
    });
  }
  if (sample.unmerged?.ok === true)
    for (const { path } of parseGitUnmergedZ(sample.unmerged.stdout)) {
      const existing = files.get(path);
      files.set(
        path,
        existing
          ? { ...existing, status: 'unmerged' }
          : {
              path,
              previousPath: null,
              status: 'unmerged',
              additions: 0,
              deletions: 0,
              patch: null,
            },
      );
    }
  let truncated = false;
  if (sample.untracked?.ok === true) {
    const untracked = parseGitPathListZ(sample.untracked.stdout);
    truncated = untracked.length > GIT_CHANGE_SET_MAX_UNTRACKED_FILES;
    untracked
      .slice(0, GIT_CHANGE_SET_MAX_UNTRACKED_FILES)
      .forEach((path, index) => {
        if (files.has(path)) return;
        const estimate = sample.untrackedEstimates[index];
        files.set(path, {
          path,
          previousPath: null,
          status: 'untracked',
          additions: estimate?.insertions ?? 0,
          deletions: 0,
          patch: null,
          ...(estimate?.binary === true ? { binary: true } : {}),
        });
      });
  }
  return { files: Array.from(files.values()).sort(byPath), truncated };
}

function endpoints(range: GitChangeSetRange): string[] {
  return range.kind === 'worktree' ? [range.base] : [range.base, range.head];
}

/**
 * `rev-parse --verify --quiet` exits 1, and only 1, for an absent object. A
 * desktop read rejects with that `code`, a read host's with that `exitCode`.
 */
async function exists(
  reader: GitChangeSetReader,
  object: string,
): Promise<boolean> {
  try {
    await reader.read({ kind: 'object-exists', object });
    return true;
  } catch (error) {
    if (
      Reflect.get(Object(error), 'code') === 1 ||
      Reflect.get(Object(error), 'exitCode') === 1
    )
      return false;
    throw error;
  }
}

function internal(cause: unknown): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'internal',
      message: 'Git could not compare the repository.',
      retry: { kind: 'never' },
    },
    cause,
  );
}

/** Why a comparison's diff failed: a missing endpoint, or Git itself. */
async function diffFailure(
  reader: GitChangeSetReader,
  range: GitChangeSetRange,
  cause: unknown,
): Promise<CanopyOperationError> {
  for (const object of endpoints(range)) {
    let present: boolean;
    try {
      present = await exists(reader, object);
    } catch {
      return internal(cause);
    }
    if (present) continue;
    return object === 'HEAD'
      ? new CanopyOperationError(
          {
            kind: 'failed_precondition',
            code: 'worker.git.diff.invalidState',
            message: 'The repository has no commit yet.',
            retry: { kind: 'after_refresh', resource: 'repository' },
          },
          cause,
        )
      : new CanopyOperationError(
          {
            kind: 'not_found',
            code: 'worker.git.diff.notFound',
            message: 'The object is not in the repository.',
            retry: { kind: 'never' },
          },
          cause,
        );
  }
  return internal(cause);
}

/**
 * The canonical changed files of a sample: raw paths, Git's statuses in the
 * spec's vocabulary, rename and copy counts and binary flags, and `truncated`
 * past the untracked cap. A failed read fails the call with a typed error.
 */
export async function toWorkerGitChangedFiles(
  reader: GitChangeSetReader,
  sample: GitChangeSetSample,
): Promise<{ files: WorkerGitDiffFile[]; truncated: boolean }> {
  const { nameStatus, numstat } = sample;
  if (!nameStatus.ok)
    throw await diffFailure(reader, sample.range, nameStatus.error);
  if (!numstat.ok) throw await diffFailure(reader, sample.range, numstat.error);
  for (const listing of [sample.untracked, sample.unmerged])
    if (listing && !listing.ok) throw internal(listing.error);
  return changedFiles(sample, nameStatus.stdout, numstat.stdout);
}
