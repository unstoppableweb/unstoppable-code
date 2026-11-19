import { z } from 'zod';

import { CanopyStreamCursorSchema } from '../../definitions';
import { isSafePortableRelativePath } from '../../../safe-relative-path';

/*
 * Code review state (CAN-4167). The review record mirrors the desktop store's
 * v1 file: arming, comment threads, and the generated annotations and diagram
 * artifacts. Stored records keep fields this version does not know
 * (`looseObject`), as the store always has; operation params and results are
 * otherwise closed.
 *
 * No host path crosses this contract. Anchors and annotations name a file
 * relative to one of the worktree's repositories.
 */

const id = z.string().min(1).max(512);

/**
 * Scope IDs name the host's storage directories, so they are slugs, as in
 * `core.plan`: no separator, dot or percent-encoding reaches a path.
 */
const scopeId = id.regex(/^[a-z0-9][a-z0-9-]*$/);

export const ReviewScopeSchema = z.strictObject({
  projectId: scopeId,
  worktreeId: scopeId,
});
export type ReviewScope = z.output<typeof ReviewScopeSchema>;

/**
 * A POSIX path inside one of the worktree's repositories. Backslashes, drive
 * prefixes and `.` or `..` segments are refused, so no spelling of the path
 * can leave the repository on any host.
 */
export const ReviewRelativePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isSafePortableRelativePath, 'Expected a repository-relative path.');

const side = z.enum(['old', 'new']);

export const REVIEW_DIFF_SOURCES = [
  'uncommitted',
  'committed',
  'combined',
  'turn',
] as const;

/** The comparison a diff-view comment was written against. */
export const ReviewDiffIdentitySchema = z.looseObject({
  source: z.enum(REVIEW_DIFF_SOURCES),
  snapshotId: z.string().min(1),
  previousPath: ReviewRelativePathSchema.optional(),
  startTree: z.string().optional(),
  endTree: z.string().optional(),
});

export const ReviewCommentAnchorSchema = z
  .looseObject({
    source: z.enum(['code', 'diagram']),
    /** Absent on legacy anchors, which mean the file view. */
    view: z.enum(['file', 'diff']).optional(),
    diff: ReviewDiffIdentitySchema.optional(),
    diagramFingerprint: z.string().optional(),
    /** The exact source lines (code) or the node title (diagram). */
    quote: z.string(),
    repoId: z.string().optional(),
    filePath: ReviewRelativePathSchema.optional(),
    side: side.optional(),
    lineStart: z.number().optional(),
    lineEnd: z.number().optional(),
    diagramKind: z.enum(['logicDiff', 'dataModelDiff']).optional(),
    nodeId: z.string().optional(),
    annotationId: z.string().optional(),
    /** A file-level or general note. */
    unanchored: z.boolean().optional(),
  })
  .refine(
    (anchor) => anchor.view !== 'diff' || anchor.diff !== undefined,
    'A diff-view anchor names its comparison.',
  );

export const ReviewCommentSchema = z.looseObject({
  id: z.string(),
  author: z.enum(['user', 'agent']),
  body: z.string(),
  createdAt: z.string(),
  /** A draft the person has not submitted to a chat yet. */
  staged: z.boolean().optional(),
});

export const REVIEW_THREAD_STATUSES = ['open', 'resolved'] as const;

export const ReviewCommentThreadSchema = z.looseObject({
  id: z.string(),
  status: z.enum(REVIEW_THREAD_STATUSES),
  createdAt: z.string(),
  anchor: ReviewCommentAnchorSchema,
  anchorState: z.enum(['matched', 'outdated']),
  comments: z.array(ReviewCommentSchema),
});
export type ReviewCommentThread = z.output<typeof ReviewCommentThreadSchema>;

export const ReviewAnnotationSchema = z.looseObject({
  id: z.string(),
  repoId: z.string(),
  filePath: ReviewRelativePathSchema,
  side,
  lineStart: z.number(),
  lineEnd: z.number(),
  kind: z.enum(['explanation', 'caution', 'context']),
  title: z.string(),
  body: z.string(),
});

export const ReviewAnnotationSetSchema = z.looseObject({
  schemaVersion: z.literal(1),
  annotations: z.array(ReviewAnnotationSchema),
});

/**
 * A generated diagram. Its payload is the plan diagram format, which
 * `core.plan.diagram.generate` defines.
 */
export const ReviewDiagramSchema = z.looseObject({
  schemaVersion: z.literal(1),
});

export const REVIEW_ARTIFACT_STATUSES = [
  'pending',
  'generating',
  'ready',
  'stale',
  'error',
] as const;

const artifactEnvelope = {
  /** The branch diff fingerprint the artifact was generated from. */
  derivedFromFingerprint: z.string(),
  status: z.enum(REVIEW_ARTIFACT_STATUSES),
  generatedAt: z.string().optional(),
  error: z.string().optional(),
};

export const ReviewAnnotationsArtifactSchema = z.looseObject({
  /** Null until the first generation completes. */
  data: ReviewAnnotationSetSchema.nullable(),
  ...artifactEnvelope,
  /** Generated annotations the reader could not use, so `data` leaves them out. */
  skippedAnnotations: z.number().int().min(1).optional(),
});

export const ReviewDiagramArtifactSchema = z.looseObject({
  /** Null until the first generation completes. */
  data: ReviewDiagramSchema.nullable(),
  ...artifactEnvelope,
});

export const CodeReviewRecordSchema = z.looseObject({
  version: z.literal(1),
  /** Armed reviews regenerate as the worktree changes. */
  armed: z.boolean(),
  armedAt: z.string().optional(),
  commentThreads: z.array(ReviewCommentThreadSchema),
  annotations: ReviewAnnotationsArtifactSchema.optional(),
  diagrams: z.looseObject({
    logicDiff: ReviewDiagramArtifactSchema.optional(),
    /** Present only when the branch changes persistent data models. */
    dataModelDiff: ReviewDiagramArtifactSchema.optional(),
  }),
});
export type CodeReviewRecord = z.output<typeof CodeReviewRecordSchema>;

/** Stored comment threads the reader could not use, so `review` leaves them out. */
const skippedCommentThreads = z.number().int().min(1).optional();

/**
 * Why a stored review cannot be written safely (CAN-6848): it could not be
 * read, is not JSON, is not version 1, or holds a field this version would
 * drop or change on its next write, unknown extensions included.
 */
export const REVIEW_STATE_FAILURES = [
  'read_failed',
  'invalid_json',
  'unsupported_version',
  'lossy_state',
] as const;
export type ReviewStateFailure = (typeof REVIEW_STATE_FAILURES)[number];
export const ReviewStateFailureSchema = z.enum(REVIEW_STATE_FAILURES);

// --- Reads -------------------------------------------------------------------

export const ReviewGetParamsSchema = z.strictObject({
  scope: ReviewScopeSchema,
});
export const ReviewGetResultSchema = z.strictObject({
  /** A worktree with no stored review answers the empty, unarmed review. */
  review: CodeReviewRecordSchema,
  /** The worktree's current branch diff fingerprint. */
  fingerprint: z.string().min(1),
  skippedCommentThreads,
  /**
   * Present when the stored review cannot be written safely; `review` is what
   * could be read, and every write refuses with `core.review.damagedState`.
   */
  stateFailure: ReviewStateFailureSchema.optional(),
});

// --- Generation ----------------------------------------------------------------

export const ReviewArmParamsSchema = z.strictObject({
  scope: ReviewScopeSchema,
});
export const ReviewCreateParamsSchema = z.strictObject({
  scope: ReviewScopeSchema,
});

export const REVIEW_GENERATION_STATUSES = [
  'fresh',
  'empty',
  'generated',
  'error',
  'queued',
  'stopped',
] as const;

export const ReviewGenerationResultSchema = z.strictObject({
  status: z.enum(REVIEW_GENERATION_STATUSES),
  /** The failed artifacts' messages, with `error`. */
  error: z.string().optional(),
});

// --- Comment threads ----------------------------------------------------------

export const ReviewCommentUpsertParamsSchema = z.strictObject({
  scope: ReviewScopeSchema,
  /** The caller's threads; each must be a whole, readable thread. */
  commentThreads: z.array(ReviewCommentThreadSchema),
  /** The thread IDs the caller last read; a stored thread outside them is kept. */
  baseCommentThreadIds: z.array(z.string()).optional(),
  /** The threads the caller last read, for a field-level three-way merge. */
  baseCommentThreads: z.array(ReviewCommentThreadSchema).optional(),
});

export const ReviewCommentReplyParamsSchema = z.strictObject({
  scope: ReviewScopeSchema,
  threadId: id,
  body: z.string(),
  /** With true, the thread is also resolved. */
  resolve: z.boolean().optional(),
});

export const ReviewCommentResolveParamsSchema = z.strictObject({
  scope: ReviewScopeSchema,
  threadId: id,
  /** True resolves the thread; false reopens it. */
  resolved: z.boolean(),
});

export const ReviewWriteResultSchema = z.strictObject({
  review: CodeReviewRecordSchema,
});

// --- Events ------------------------------------------------------------------

export const ReviewEventsParamsSchema = z.strictObject({
  scope: ReviewScopeSchema,
  /** Resume after this cursor; omitted or null starts from now. */
  cursor: CanopyStreamCursorSchema.nullable().optional(),
});

/** One committed change, published after the write is durable. */
export const ReviewEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('review.updated'),
    scope: ReviewScopeSchema,
    fingerprint: z.string().min(1),
    review: CodeReviewRecordSchema,
    skippedCommentThreads,
  }),
]);
export type ReviewEvent = z.output<typeof ReviewEventSchema>;
