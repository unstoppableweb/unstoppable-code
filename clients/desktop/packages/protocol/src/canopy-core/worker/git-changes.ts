import { z } from 'zod';

import { CanopyWorkspaceScopeSchema } from '../common';
import { defineCanopyQuery, defineCanopyQueryRegistry } from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../errors';

const id = z.string().min(1).max(512);

export const WorkerGitStatusGetParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  repoId: id,
});

export type WorkerGitStatusGetParams = z.output<
  typeof WorkerGitStatusGetParamsSchema
>;

export const WORKER_GIT_FILE_STATUSES = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'untracked',
  'conflicted',
] as const;

export const WorkerGitStatusGetResultSchema = z
  .object({
    repoId: id,
    branch: z.string(),
    headSha: z.string(),
    upstream: z.string().nullable(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    files: z.array(
      z
        .object({
          path: z.string(),
          status: z.enum(WORKER_GIT_FILE_STATUSES),
          staged: z.boolean(),
        })
        .catchall(CanopyJsonValueSchema),
    ),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerGitStatusGetResult = z.output<
  typeof WorkerGitStatusGetResultSchema
>;

export const WorkerGitStatusGetErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'worker.git.status.invalidState',
      'worker.git.status.revisionConflict',
      'worker.git.status.notFound',
    ])
    .optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

/**
 * The minor schema revision `worker.git.diff.get` serves (protocol rule 5,
 * CAN-6093): revision 2 adds the sample's identity and range and the
 * per-file bounds the cloud Changed files panel shows. A client asks for it
 * with `revision` only when the runtime advertises it.
 */
export const WORKER_GIT_DIFF_SCHEMA_REVISION = 2;

/**
 * Revision 3, served by the desktop's in-process worker and the daemon, never
 * the web core (CAN-4729): the comparison's settled Git reads in `reads`, so
 * the desktop can rebuild its legacy changed-files lists from a daemon answer.
 */
export const WORKER_GIT_DIFF_READS_REVISION = 3;

export const WorkerGitDiffGetParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  repoId: id,
  /** Omitted: the base the host recorded for the repository, if it records one. */
  base: z.string().optional(),
  head: z.string(),
  paths: z.array(z.string()).optional(),
  contextLines: z.number().int().min(0).max(100).optional(),
  /**
   * Revision 2 output, sent only when the runtime advertises it; revision 3
   * only to a desktop or daemon worker.
   */
  revision: z
    .union([
      z.literal(WORKER_GIT_DIFF_SCHEMA_REVISION),
      z.literal(WORKER_GIT_DIFF_READS_REVISION),
    ])
    .optional(),
});

export type WorkerGitDiffGetParams = z.output<
  typeof WorkerGitDiffGetParamsSchema
>;

/**
 * The statuses servers emit, one per changed path, from Git's status letter:
 * `A`, `M`, `D`, `R`, `C`, `T` and `U`; `unknown` for any other letter. A
 * superset of the Cloud statuses the web core relays. The result schema keeps
 * `status` a string (CAN-4158's contract); this list is the spec's.
 */
export const WORKER_GIT_DIFF_FILE_STATUSES = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'type_changed',
  'untracked',
  'unmerged',
  'unknown',
] as const;

export type WorkerGitDiffFileStatus =
  (typeof WORKER_GIT_DIFF_FILE_STATUSES)[number];

/** At most this many characters of patch per file. */
export const WORKER_GIT_DIFF_MAX_PATCH_LENGTH = 8_000_000;

export const WorkerGitDiffFileSchema = z
  .object({
    /** Repository-relative, `/`-separated and unquoted. */
    path: z.string(),
    /** The rename or copy source; `null` for every other status. */
    previousPath: z.string().nullable(),
    /** One of {@link WORKER_GIT_DIFF_FILE_STATUSES}. */
    status: z.string(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    patch: z.string().max(WORKER_GIT_DIFF_MAX_PATCH_LENGTH).nullable(),
    /** Git reports no line counts for binary content; both counts are 0. */
    binary: z.boolean().optional(),
    /** The change is in the index, for servers that distinguish it. */
    staged: z.boolean().optional(),
    /** Revision 2: the server has no line counts, so both counts read 0. */
    counted: z.literal(false).optional(),
    /** Revision 2: this file's patch text was cut. */
    patchTruncated: z.literal(true).optional(),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerGitDiffFile = z.output<typeof WorkerGitDiffFileSchema>;

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** At most this many untracked files are estimated, in Git's listing order. */
export const WORKER_GIT_DIFF_MAX_UNTRACKED_ESTIMATES = 200;

/** Revision 3: one Git read of the comparison, settled. */
export const WorkerGitDiffReadSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    /** Its `-z` output split on NUL, without the trailing terminator's empty field. */
    fields: z.array(z.string()),
    /**
     * The output was longer than any list the legacy listing still shows, so
     * `fields` is empty, as that listing shows it.
     */
    overCap: z.literal(true).optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    /** Git's exit code; null when it did not exit with one. */
    exitCode: z.number().int().nullable(),
  }),
]);

export type WorkerGitDiffRead = z.output<typeof WorkerGitDiffReadSchema>;

/** Revision 3: every read of the comparison, failures included. */
export const WorkerGitDiffReadsSchema = z.strictObject({
  nameStatus: WorkerGitDiffReadSchema,
  numstat: WorkerGitDiffReadSchema,
  /** Null for a comparison of two objects. */
  untracked: WorkerGitDiffReadSchema.nullable(),
  /** Null for a comparison of two objects. */
  unmerged: WorkerGitDiffReadSchema.nullable(),
  /** For the first untracked files, in order. */
  untrackedEstimates: z
    .array(
      z.strictObject({
        insertions: z.number().int().nonnegative(),
        binary: z.boolean(),
        /** The confined read skipped this file: its parent resolves outside the checkout. */
        confined: z.literal(true).optional(),
      }),
    )
    .max(WORKER_GIT_DIFF_MAX_UNTRACKED_ESTIMATES),
});

export type WorkerGitDiffReads = z.output<typeof WorkerGitDiffReadsSchema>;

export const WorkerGitDiffGetResultSchema = z
  .object({
    files: z.array(WorkerGitDiffFileSchema),
    /** Files, patches or patch text were left out. */
    truncated: z.boolean(),
    /** Revision 2: the repository's id as the server's own Git reads name it. */
    repoId: id.optional(),
    /** Revision 2: the commit `HEAD` was when the comparison was sampled. */
    headSha: objectId.optional(),
    /** Revision 2: the branch the range resolved against; null from `HEAD`. */
    base: z.string().nullable().optional(),
    /** Revision 2: the merge base a branch range compares from, when known. */
    mergeBaseSha: objectId.nullable().optional(),
    /** Revision 2: the listing hit the server's bound, so files are missing. */
    filesTruncated: z.boolean().optional(),
    /**
     * Revision 3: the reads themselves, failed ones included. `files` is then
     * empty and `truncated` false: the caller builds its lists from these.
     */
    reads: WorkerGitDiffReadsSchema.optional(),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerGitDiffGetResult = z.output<
  typeof WorkerGitDiffGetResultSchema
>;

export const WORKER_GIT_DIFF_ERROR_CODES = [
  'worker.git.diff.invalidState',
  'worker.git.diff.revisionConflict',
  'worker.git.diff.notFound',
  'worker.git.diff.invalidScope',
  'worker.git.diff.scopeUnsupported',
  'worker.git.diff.invalidRange',
  /**
   * Revision 3: a read needed an object a partial clone lacks, and this worker
   * does not fetch it.
   */
  'worker.git.diff.objectMissing',
] as const;

export const WorkerGitDiffGetErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(WORKER_GIT_DIFF_ERROR_CODES).optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

// Its own partition: the web core serves it through
// `WORKER_GIT_CHANGE_QUERY_DEFINITIONS` (CAN-4158), and the desktop and
// daemon registries join Git queries one family at a time (CAN-4103).
export const WORKER_GIT_DIFF_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'worker',
  {
    'worker.git.diff.get': defineCanopyQuery({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'target-selectable',
      params: WorkerGitDiffGetParamsSchema,
      result: WorkerGitDiffGetResultSchema,
      error: WorkerGitDiffGetErrorSchema,
      idempotency: 'inherent',
      requiredGrants: ['worker.git.read'],
    }),
  },
);

// `worker.git.status.get` is served by the web core only (CAN-4158). It stays
// out of WORKER_QUERY_DEFINITIONS, as the transport definitions do, because
// the daemon dispatcher requires a handler for every definition it is given
// and has none for it.
export const WORKER_GIT_STATUS_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'worker',
  {
    'worker.git.status.get': defineCanopyQuery({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'target-selectable',
      params: WorkerGitStatusGetParamsSchema,
      result: WorkerGitStatusGetResultSchema,
      error: WorkerGitStatusGetErrorSchema,
      idempotency: 'inherent',
      requiredGrants: ['worker.git.read'],
    }),
  },
);

/** The change queries the web core serves (CAN-4158). */
export const WORKER_GIT_CHANGE_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'worker',
  {
    ...WORKER_GIT_STATUS_QUERY_DEFINITIONS,
    ...WORKER_GIT_DIFF_QUERY_DEFINITIONS,
  },
);
