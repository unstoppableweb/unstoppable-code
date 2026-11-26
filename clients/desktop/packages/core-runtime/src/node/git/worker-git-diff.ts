import {
  WORKER_GIT_DIFF_READS_REVISION,
  type CanopyQueryHandler,
  type WorkerGitDiffGetParams,
  type WorkerGitDiffGetResult,
  type WorkerGitDiffRead,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import {
  GIT_OBJECT_ID_PATTERN,
  parseGitPathListZ,
  sampleGitChangeSet,
  toWorkerGitChangedFiles,
  type GitChangeSetRange,
  type GitChangeSetReader,
  type GitChangeSetSample,
  type GitReadOutcome,
} from './change-set';
import { withGitPatches, type GitPatchReader } from './change-set-patch';
import { WorkerGitScopeError } from './worker-git-branch-list';
import {
  assertWorkerGitServedSelection,
  type WorkerGitServedSelection,
} from './worker-git-selection';

/**
 * Host port for `worker.git.diff.get`. The host maps the scope and `repoId`
 * to one repository from trusted records and supplies its reads; paths never
 * leave the host.
 */
export interface WorkerGitDiffHost<
  Repository,
> extends WorkerGitServedSelection {
  /**
   * Throws {@link WorkerGitScopeError} for a scope it refuses; `null` when the
   * worktree or repository cannot be located.
   */
  resolveRepository(
    params: WorkerGitDiffGetParams,
    context: CanopyHandlerContext,
  ): Promise<Repository | null>;
  reads(
    repository: Repository,
    context: CanopyHandlerContext,
  ): GitChangeSetReader;
  /** Patch reads; a host without them refuses `paths`. */
  patchReads?(
    repository: Repository,
    context: CanopyHandlerContext,
  ): GitPatchReader;
  /**
   * Sees every read of the comparison before the canonical result or error,
   * for the host's own compatibility projection. It never changes either.
   */
  observe?(repository: Repository, sample: GitChangeSetSample): void;
}

export interface WorkerGitDiffHandlers {
  'worker.git.diff.get': CanopyQueryHandler<
    'worker.git.diff.get',
    CanopyHandlerContext
  >;
}

function refusal(
  kind: 'invalid_argument' | 'capability_unavailable' | 'not_found',
  message: string,
  code?: 'worker.git.diff.invalidRange' | 'worker.git.diff.notFound',
): CanopyOperationError {
  return new CanopyOperationError({
    kind,
    ...(code === undefined ? {} : { code }),
    message,
    retry: { kind: 'never' },
  });
}

function scopeError(error: WorkerGitScopeError): CanopyOperationError {
  const message = error.message.slice(0, 4_096);
  return new CanopyOperationError(
    error.reason === 'invalid'
      ? {
          kind: 'invalid_argument',
          code: 'worker.git.diff.invalidScope',
          message,
          retry: { kind: 'never' },
        }
      : {
          kind: 'failed_precondition',
          code: 'worker.git.diff.scopeUnsupported',
          message,
          retry: { kind: 'never' },
        },
    error.hostCause,
  );
}

const tooLarge = (): CanopyOperationError =>
  new CanopyOperationError({
    kind: 'resource_exhausted',
    message: 'The comparison is too large for one result.',
    retry: { kind: 'after_refresh', resource: 'repository' },
  });

const isObjectId = (value: string): boolean =>
  GIT_OBJECT_ID_PATTERN.test(value);

const MiB = 1024 * 1024;
// The 8 MiB default frame, less headroom for the response envelope.
const WORKER_GIT_DIFF_RESULT_BYTES = 8 * MiB - 64 * 1024;

/**
 * Revision 3's raw bound per read. The legacy listing blanks a list whose
 * newline text is over 8 MiB; name-status, untracked and unmerged `-z` output
 * is never longer than that text, but numstat names a rename by both full
 * paths where the text prints one `pre{a => b}suf` name, at most twice over.
 */
const WORKER_GIT_DIFF_READ_BYTES = 8 * MiB;
const WORKER_GIT_DIFF_NUMSTAT_READ_BYTES = 16 * MiB;

/**
 * Revision 3's whole-answer cap, sent in message parts over 8 MiB frames:
 * every read at its bound is 40 MiB of output, and its JSON adds about two
 * bytes a field. Names JSON escapes heavily, like control characters, can
 * still exceed it.
 */
export const WORKER_GIT_DIFF_READS_RESULT_BYTES = 48 * MiB;

function exitCodeOf(error: unknown): number | null {
  // A read host's rejection carries `exitCode`, the desktop's runGit `code`.
  for (const key of ['exitCode', 'code']) {
    const value: unknown = Reflect.get(Object(error), key);
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return null;
}

function wireRead(outcome: GitReadOutcome, bound: number): WorkerGitDiffRead {
  if (!outcome.ok) return { ok: false, exitCode: exitCodeOf(outcome.error) };
  return Buffer.byteLength(outcome.stdout) > bound
    ? { ok: true, fields: [], overCap: true }
    : { ok: true, fields: parseGitPathListZ(outcome.stdout) };
}

/** Revision 3's answer: the sample's reads, failures included. */
function readsResult(sample: GitChangeSetSample): WorkerGitDiffGetResult {
  const outcomes = [
    sample.nameStatus,
    sample.numstat,
    sample.untracked,
    sample.unmerged,
  ];
  if (
    outcomes.some(
      (outcome) =>
        outcome?.ok === false &&
        Reflect.get(Object(outcome.error), 'lazyFetchBlocked') === true,
    )
  )
    throw new CanopyOperationError({
      kind: 'failed_precondition',
      code: 'worker.git.diff.objectMissing',
      message: 'A read needs an object this repository does not have.',
      retry: { kind: 'never' },
    });
  return {
    files: [],
    truncated: false,
    reads: {
      nameStatus: wireRead(sample.nameStatus, WORKER_GIT_DIFF_READ_BYTES),
      numstat: wireRead(sample.numstat, WORKER_GIT_DIFF_NUMSTAT_READ_BYTES),
      untracked: sample.untracked
        ? wireRead(sample.untracked, WORKER_GIT_DIFF_READ_BYTES)
        : null,
      unmerged: sample.unmerged
        ? wireRead(sample.unmerged, WORKER_GIT_DIFF_READ_BYTES)
        : null,
      untrackedEstimates: sample.untrackedEstimates.map((estimate) => ({
        insertions: estimate.insertions,
        binary: estimate.binary,
        ...(estimate.confined === true && { confined: true }),
      })),
    },
  };
}

/**
 * The range a `base`..`head` pair names, or the refusal for one outside the
 * vocabulary or one this host does not serve. A branch base is valid but
 * unserved: the desktop is given resolved merge bases.
 */
export function workerGitDiffRange(
  base: string | undefined,
  head: string,
): GitChangeSetRange {
  // The web core's recorded base; this host records none.
  if (base === undefined)
    throw refusal(
      'capability_unavailable',
      'This host compares from a base the caller names.',
    );
  const headIsObject = isObjectId(head);
  if (head !== 'WORKTREE' && head !== 'HEAD' && !headIsObject)
    throw refusal(
      'invalid_argument',
      'Compare against WORKTREE, HEAD or an object id.',
      'worker.git.diff.invalidRange',
    );
  if (isObjectId(base))
    return head === 'WORKTREE'
      ? { kind: 'worktree', base }
      : { kind: 'objects', base, head };
  if (base === 'HEAD') {
    if (head === 'WORKTREE') return { kind: 'worktree', base: 'HEAD' };
    throw refusal(
      'invalid_argument',
      'HEAD is a base only against WORKTREE.',
      'worker.git.diff.invalidRange',
    );
  }
  if (base === '' || base === 'WORKTREE' || headIsObject)
    throw refusal(
      'invalid_argument',
      'Compare HEAD..WORKTREE, <branch>..HEAD, <branch>..WORKTREE or object ids.',
      'worker.git.diff.invalidRange',
    );
  throw refusal(
    'capability_unavailable',
    'This host compares from HEAD or an object id, not a branch.',
  );
}

export function createWorkerGitDiffHandlers<Repository>(
  host: WorkerGitDiffHost<Repository>,
): WorkerGitDiffHandlers {
  return {
    'worker.git.diff.get': async (
      params,
      context,
    ): Promise<WorkerGitDiffGetResult> => {
      // The web core's revision 2 (CAN-6093) is not served here; revision 3 is.
      const reads = params.revision === WORKER_GIT_DIFF_READS_REVISION;
      if (params.revision !== undefined && !reads)
        throw new CanopyOperationError({
          kind: 'capability_unavailable',
          message: 'This worker does not serve this revision.',
          details: { unsupported: ['revision'], reason: 'unserved' },
          retry: {
            kind: 'after_refresh',
            resource: 'core.runtime.manifest.get',
          },
        });
      assertWorkerGitServedSelection(params.scope, host);
      if (
        params.scope.repoId !== undefined &&
        params.scope.repoId !== params.repoId
      )
        throw new CanopyOperationError({
          kind: 'invalid_argument',
          code: 'worker.git.diff.invalidScope',
          message: 'The scope names another repository.',
          retry: { kind: 'never' },
        });
      const range = workerGitDiffRange(params.base, params.head);
      if (params.contextLines !== undefined)
        throw refusal(
          'capability_unavailable',
          'contextLines is not supported.',
        );
      const { paths } = params;
      if (reads && paths !== undefined)
        throw refusal(
          'capability_unavailable',
          'Revision 3 answers no patches.',
        );
      if (paths !== undefined && host.patchReads === undefined)
        throw refusal('capability_unavailable', 'This host serves no patches.');
      let repository: Repository | null;
      try {
        repository = await host.resolveRepository(params, context);
      } catch (error) {
        if (error instanceof WorkerGitScopeError) throw scopeError(error);
        throw error;
      }
      if (repository === null)
        throw refusal(
          'not_found',
          'Repository not found.',
          'worker.git.diff.notFound',
        );
      const reader = host.reads(repository, context);
      const sample = await sampleGitChangeSet(reader, range);
      host.observe?.(repository, sample);
      if (reads) {
        const answer = readsResult(sample);
        // Measured before the transport buffers or splits it.
        if (
          Buffer.byteLength(JSON.stringify(answer)) >
          WORKER_GIT_DIFF_READS_RESULT_BYTES
        )
          throw tooLarge();
        return answer;
      }
      const listed = await toWorkerGitChangedFiles(reader, sample);
      const result =
        paths === undefined || host.patchReads === undefined
          ? listed
          : await withGitPatches(
              host.patchReads(repository, context),
              range,
              listed,
              paths,
              WORKER_GIT_DIFF_RESULT_BYTES,
            );
      if (
        Buffer.byteLength(JSON.stringify(result)) > WORKER_GIT_DIFF_RESULT_BYTES
      )
        throw tooLarge();
      return result;
    },
  };
}
