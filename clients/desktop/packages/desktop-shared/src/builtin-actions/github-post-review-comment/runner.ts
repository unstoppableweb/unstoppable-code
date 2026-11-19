import { execFile } from 'node:child_process';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  setOutput,
  writeOutputFile,
  writePrivateOutputFile,
} from '../_lib/output';
import { runWithActionEnvironment } from '../_lib/action-env';
import {
  appendOmittedInlineCommentsToBody,
  hasDiffLineEntries,
  normalizeReviewContent,
  parseDiffLineIndex,
  splitInvalidLineCommentsForRetry,
  type ReviewInlineComment as InlineComment,
  type ReviewThreadReply as ThreadReply,
} from '@canopy/pipeline-interop/github-review-payload';
import type {
  GitHubPendingReview,
  GitHubPendingReviewComment,
  PendingReviewClassification,
  PendingReviewEscrowData,
  PendingReviewEscrowEntry,
  PendingReviewFilesystem,
  PendingReviewPrReference as PrReference,
} from '../../types/pending-review';

const execFileAsync = promisify(execFile);
const MAX_BUFFER_BYTES = 1024 * 1024 * 16;
const AI_REVIEW_MARKER = '[//]: # (ud-ai-review)';

interface PostResult {
  generatedAt: string;
  status: 'posted' | 'skipped';
  pr: PrReference;
  reviewId: string;
  reviewUrl: string;
  inlineCommentCount: number;
  fileLevelCommentCount: number;
  fileLevelFailedCount: number;
  omittedInlineCommentCount: number;
  threadReplyCount: number;
  threadResolveCount: number;
  errorMessage: string;
}

const DEFAULT_PENDING_REVIEW_FILESYSTEM: PendingReviewFilesystem = {
  writeUtf8File: (filePath, content) => {
    writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
    chmodSync(filePath, 0o600);
  },
  renameFile: (oldPath, newPath) => {
    renameSync(oldPath, newPath);
  },
};

class PendingReviewLifecycleError extends Error {
  constructor(
    readonly failureMode: string,
    message: string,
  ) {
    super(message);
    this.name = 'PendingReviewLifecycleError';
  }
}

class PendingReviewEscrow {
  private filePath = '';
  private readonly data: PendingReviewEscrowData;

  constructor(
    pr: PrReference,
    private readonly filesystem: PendingReviewFilesystem,
  ) {
    const now = new Date().toISOString();
    this.data = {
      version: 1,
      durable: true,
      pr,
      createdAt: now,
      updatedAt: now,
      entries: [],
    };
  }

  get path(): string {
    return this.filePath;
  }

  get entries(): PendingReviewEscrowEntry[] {
    return this.data.entries;
  }

  persist(): string {
    this.data.updatedAt = new Date().toISOString();
    const content = `${JSON.stringify(this.data, null, 2)}\n`;
    if (!this.filePath) {
      this.filePath = writePrivateOutputFile(
        'pending_review_escrow_file',
        'github-pending-review-escrow.json',
        content,
      );
      return this.filePath;
    }

    const temporaryPath = `${this.filePath}.tmp`;
    this.filesystem.writeUtf8File(temporaryPath, content);
    this.filesystem.renameFile(temporaryPath, this.filePath);
    return this.filePath;
  }

  writeUtf8File(filePath: string, content: string): void {
    this.filesystem.writeUtf8File(filePath, content);
  }
}

interface FileLevelPostResult {
  postedCount: number;
  failedCount: number;
  errorMessage: string;
}

interface CreatedPendingReview {
  databaseId: string;
  nodeId: string;
}

interface PendingReviewRestorationResult {
  failures: PendingReviewEscrowEntry[];
  journalErrors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

function arrayFrom(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseBooleanInput(
  raw: string | undefined,
  inputName: string,
  defaultValue: boolean,
): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new Error(`${inputName} must be "true" or "false" when set.`);
}

function parsePrIdentifier(raw: string): PrReference {
  const input = raw.trim();
  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/,
    /^([^/]+)\/([^/]+)\/pull\/(\d+)$/,
    /^([^/]+)\/([^/]+)\/(\d+)$/,
    /^([^/]+)\/([^/#]+)#(\d+)$/,
    /^([^/]+)\/([^\s]+)\s+(\d+)$/,
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) {
      return {
        owner: match[1],
        repo: match[2],
        prId: Number.parseInt(match[3], 10),
      };
    }
  }

  throw new Error(
    `Invalid PR identifier "${input}". Expected a GitHub PR URL or owner/repo#123.`,
  );
}

function resolvePrReference(env: NodeJS.ProcessEnv): PrReference {
  const identifier = env.INPUT_PR_IDENTIFIER?.trim();
  if (identifier) {
    return parsePrIdentifier(identifier);
  }

  const owner = env.INPUT_OWNER?.trim() ?? '';
  const repo = env.INPUT_REPO?.trim() ?? '';
  const prId = Number.parseInt(env.INPUT_PR_ID?.trim() ?? '', 10);
  if (!owner || !repo || !Number.isFinite(prId) || prId <= 0) {
    throw new Error(
      'github-post-review-comment requires pr_identifier or owner, repo, and pr_id inputs.',
    );
  }

  return { owner, repo, prId };
}

function parseJson(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid review JSON from ${source}: ${message}`);
  }
}

function readReviewInput(env: NodeJS.ProcessEnv): unknown {
  const filePath = env.INPUT_REVIEW_JSON_FILE?.trim();
  const inlineJson = env.INPUT_REVIEW_JSON?.trim();
  if (filePath) {
    return parseJson(readFileSync(filePath, 'utf8'), filePath);
  }
  if (inlineJson) {
    return parseJson(inlineJson, 'review_json input');
  }
  throw new Error(
    'github-post-review-comment requires review_json or review_json_file.',
  );
}

async function runGh(args: string[]): Promise<string> {
  const result = await execFileAsync('gh', ['api', ...args], {
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: process.platform === 'win32',
  });
  return result.stdout.trim();
}

async function fetchPullRequestDiff(pr: PrReference): Promise<string> {
  return runGh([
    `repos/${pr.owner}/${pr.repo}/pulls/${String(pr.prId)}`,
    '-H',
    'Accept: application/vnd.github.v3.diff',
  ]);
}

async function fetchPullRequestHeadSha(pr: PrReference): Promise<string> {
  const sha = await runGh([
    `repos/${pr.owner}/${pr.repo}/pulls/${String(pr.prId)}`,
    '--jq',
    '.head.sha',
  ]);
  if (!sha) {
    throw new Error('GitHub PR API did not return a head SHA.');
  }
  return sha;
}

function readErrorText(error: unknown): string {
  if (!isRecord(error)) {
    return error instanceof Error ? error.message : String(error);
  }

  const stderr = typeof error.stderr === 'string' ? error.stderr : '';
  const stdout = typeof error.stdout === 'string' ? error.stdout : '';
  const message =
    error instanceof Error
      ? error.message
      : typeof error.message === 'string'
        ? error.message
        : JSON.stringify(error);
  return [stderr, stdout, message].filter(Boolean).join('\n').trim();
}

function toSingleLineOutput(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function isInlineCommentValidationError(error: unknown): boolean {
  const text = readErrorText(error);
  return /HTTP 422|Unprocessable Entity|Validation Failed/i.test(text);
}

function parsePaginatedRecords(raw: string, source: string): unknown[] {
  const parsed = parseJson(raw || '[]', source);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected an array response from ${source}.`);
  }

  const pages: unknown[] = parsed;
  const records: unknown[] = [];
  for (const page of pages) {
    if (Array.isArray(page)) {
      const pageRecords: unknown[] = page;
      records.push(...pageRecords);
    } else {
      records.push(page);
    }
  }
  return records;
}

function normalizePendingReview(value: unknown): GitHubPendingReview | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readNumber(value, 'id');
  const state = readString(value, 'state');
  const user = isRecord(value.user) ? value.user : {};
  const login = readString(user, 'login');
  if (id === null || state !== 'PENDING') {
    return null;
  }

  return {
    ...value,
    id,
    state: 'PENDING',
    body: readString(value, 'body'),
    commit_id: readString(value, 'commit_id'),
    user: { ...user, login },
  };
}

function normalizePendingReviewComment(
  value: unknown,
): GitHubPendingReviewComment | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readNumber(value, 'id');
  const path = readString(value, 'path');
  const body = readString(value, 'body');
  if (id === null || !path || !body) {
    return null;
  }
  return { ...value, id, path, body };
}

async function listPendingReviews(
  pr: PrReference,
): Promise<GitHubPendingReview[]> {
  const raw = await runGh([
    `repos/${pr.owner}/${pr.repo}/pulls/${String(pr.prId)}/reviews?per_page=100`,
    '--paginate',
    '--slurp',
  ]);
  return parsePaginatedRecords(raw, 'GitHub pull request reviews response')
    .map(normalizePendingReview)
    .filter((review): review is GitHubPendingReview => review !== null);
}

async function listPendingReviewComments(
  pr: PrReference,
  reviewId: number,
): Promise<GitHubPendingReviewComment[]> {
  const raw = await runGh([
    `repos/${pr.owner}/${pr.repo}/pulls/${String(pr.prId)}/reviews/${String(reviewId)}/comments?per_page=100`,
    '--paginate',
    '--slurp',
  ]);
  const records = parsePaginatedRecords(
    raw,
    `GitHub pending review ${String(reviewId)} comments response`,
  );
  const comments = records.map(normalizePendingReviewComment);
  if (comments.some((comment) => comment === null)) {
    throw new Error(
      `Pending review ${String(reviewId)} contains a draft comment that could not be captured safely; the review was left unchanged.`,
    );
  }
  const normalizedComments = comments.filter(
    (comment): comment is GitHubPendingReviewComment => comment !== null,
  );
  if (
    normalizedComments.some(
      (comment) => readNumber(comment, 'in_reply_to_id') !== null,
    )
  ) {
    throw new Error(
      `Pending review ${String(reviewId)} contains a draft reply that cannot be restored without losing its thread association; the review was left unchanged.`,
    );
  }
  return normalizedComments;
}

function isFileLevelPendingReviewComment(
  comment: GitHubPendingReviewComment,
): boolean {
  return readString(comment, 'subject_type') === 'file';
}

function buildRestoreComment(
  comment: GitHubPendingReviewComment,
): Record<string, unknown> {
  const restored: Record<string, unknown> = {
    path: comment.path,
    body: comment.body,
  };
  const line =
    readNumber(comment, 'line') ?? readNumber(comment, 'original_line');
  const startLine =
    readNumber(comment, 'start_line') ??
    readNumber(comment, 'original_start_line');
  const position =
    readNumber(comment, 'position') ?? readNumber(comment, 'original_position');
  if (line !== null) {
    restored.line = line;
  } else if (position !== null) {
    restored.position = position;
  } else {
    throw new Error(
      `Pending review comment ${String(comment.id)} has no restorable line, position, or file-level subject; the review was left unchanged.`,
    );
  }
  if (startLine !== null && startLine !== line) {
    restored.start_line = startLine;
  }
  if (comment.side === 'LEFT' || comment.side === 'RIGHT') {
    restored.side = comment.side;
  }
  if (comment.start_side === 'LEFT' || comment.start_side === 'RIGHT') {
    restored.start_side = comment.start_side;
  }
  return restored;
}

function buildPendingReviewRestorePayload(
  review: GitHubPendingReview,
  comments: GitHubPendingReviewComment[],
): Record<string, unknown> {
  return {
    body: review.body,
    ...(review.commit_id ? { commit_id: review.commit_id } : {}),
    comments: comments
      .filter((comment) => !isFileLevelPendingReviewComment(comment))
      .map(buildRestoreComment),
  };
}

function isAutomatedPendingReview(review: GitHubPendingReview): boolean {
  return review.body.includes(AI_REVIEW_MARKER);
}

function pendingReviewCommentIdentity(
  comment: Record<string, unknown>,
): string {
  const line =
    readNumber(comment, 'line') ?? readNumber(comment, 'original_line');
  const position =
    line === null
      ? (readNumber(comment, 'position') ??
        readNumber(comment, 'original_position'))
      : null;
  const startLine =
    readNumber(comment, 'start_line') ??
    readNumber(comment, 'original_start_line');
  const explicitSide = readString(comment, 'side');
  const side =
    explicitSide === 'LEFT' || explicitSide === 'RIGHT'
      ? explicitSide
      : line !== null
        ? 'RIGHT'
        : '';
  const explicitStartSide = readString(comment, 'start_side');
  const startSide =
    startLine === null
      ? ''
      : explicitStartSide === 'LEFT' || explicitStartSide === 'RIGHT'
        ? explicitStartSide
        : side;
  const explicitSubjectType = readString(comment, 'subject_type');
  const subjectType = explicitSubjectType || (line !== null ? 'line' : '');

  return JSON.stringify({
    path: readString(comment, 'path'),
    body: readString(comment, 'body'),
    line,
    position,
    startLine,
    side,
    startSide,
    subjectType,
  });
}

function matchesAttemptedReview(
  review: GitHubPendingReview,
  comments: GitHubPendingReviewComment[],
  attemptedPayload: unknown,
): boolean {
  if (!isRecord(attemptedPayload)) {
    return false;
  }

  const attemptedBody = readString(attemptedPayload, 'body');
  if (review.body.trim() && review.body !== attemptedBody) {
    return false;
  }
  const attemptedCommitId = readString(attemptedPayload, 'commit_id');
  if (!attemptedCommitId || review.commit_id !== attemptedCommitId) {
    return false;
  }

  const attemptedComments = arrayFrom(attemptedPayload.comments).filter(
    isRecord,
  );
  if (comments.length === 0 || comments.length !== attemptedComments.length) {
    return false;
  }

  const unmatchedAttemptedComments = attemptedComments.map(
    pendingReviewCommentIdentity,
  );
  return comments.every((comment) => {
    const matchIndex = unmatchedAttemptedComments.indexOf(
      pendingReviewCommentIdentity(comment),
    );
    if (matchIndex === -1) {
      return false;
    }
    unmatchedAttemptedComments.splice(matchIndex, 1);
    return true;
  });
}

async function capturePendingReview(
  pr: PrReference,
  review: GitHubPendingReview,
  classification: PendingReviewClassification,
  escrow: PendingReviewEscrow,
  capturedComments?: GitHubPendingReviewComment[],
): Promise<PendingReviewEscrowEntry> {
  const comments =
    capturedComments ?? (await listPendingReviewComments(pr, review.id));
  const entry: PendingReviewEscrowEntry = {
    originalReviewId: review.id,
    classification,
    status: 'captured',
    capturedAt: new Date().toISOString(),
    review,
    comments,
    restorePayload: buildPendingReviewRestorePayload(review, comments),
  };
  escrow.entries.push(entry);
  escrow.persist();
  if (classification === 'pre_existing_human') {
    const payloadFile = pendingReviewRestorePayloadPath(
      escrow,
      entry.originalReviewId,
    );
    escrow.writeUtf8File(
      payloadFile,
      `${JSON.stringify(entry.restorePayload, null, 2)}\n`,
    );
  }
  return entry;
}

function pendingReviewRestorePayloadPath(
  escrow: PendingReviewEscrow,
  originalReviewId: number,
): string {
  return join(
    dirname(escrow.path),
    `github-pending-review-${String(originalReviewId)}-restore.json`,
  );
}

async function deleteEscrowedPendingReview(
  pr: PrReference,
  entry: PendingReviewEscrowEntry,
  escrow: PendingReviewEscrow,
  restoreAfterPosting: boolean,
): Promise<void> {
  try {
    await runGh([
      `repos/${pr.owner}/${pr.repo}/pulls/${String(pr.prId)}/reviews/${String(entry.originalReviewId)}`,
      '--method',
      'DELETE',
    ]);
  } catch (error) {
    entry.status = 'delete_failed';
    entry.deletionError = readErrorText(error);
    escrow.persist();
    const prefix =
      entry.classification === 'new_automated_partial'
        ? `GitHub left partial pending review ${String(entry.originalReviewId)} after rejecting the automated review, and it could not be deleted`
        : `Existing pending GitHub review ${String(entry.originalReviewId)} was escrowed but could not be deleted`;
    throw new PendingReviewLifecycleError(
      'pending_review_cleanup_failed',
      `${prefix}: ${entry.deletionError}. The durable escrow remains at ${escrow.path}.`,
    );
  }

  entry.status = restoreAfterPosting
    ? 'deleted_pending_restore'
    : 'deleted_not_restored';
  entry.deletedAt = new Date().toISOString();
  try {
    escrow.persist();
  } catch (error) {
    throw new PendingReviewLifecycleError(
      'pending_review_cleanup_failed',
      `Pending GitHub review ${String(entry.originalReviewId)} was deleted, but its post-delete escrow transition could not be persisted: ${readErrorText(error)}. The prior durable escrow remains at ${escrow.path}.`,
    );
  }
}

function setFailureOutputs(
  failureMode: string,
  message: string,
  reviewId: string,
  restorationStatus: string,
): void {
  setOutput('status', 'failed');
  setOutput('failure_mode', failureMode);
  setOutput('review_id', reviewId);
  setOutput('review_comment_id', reviewId);
  setOutput('pending_review_restoration_status', restorationStatus);
  setOutput('error_message', toSingleLineOutput(message));
}

function resolveReviewEvent(raw: string | undefined): string {
  const value = raw?.trim().toUpperCase();
  return value === 'APPROVE' || value === 'REQUEST_CHANGES' ? value : 'COMMENT';
}

function shouldResolveThread(reply: ThreadReply): boolean {
  return reply.resolve === true || reply.action === 'resolve';
}

async function postThreadReplies(
  pr: PrReference,
  replies: ThreadReply[],
): Promise<{ replyCount: number; resolveCount: number }> {
  let replyCount = 0;
  let resolveCount = 0;

  for (const reply of replies) {
    const commentId = reply.comment_id ?? reply.commentId;
    const threadId = reply.thread_id ?? reply.threadId;

    if (commentId !== undefined) {
      await runGh([
        `repos/${pr.owner}/${pr.repo}/pulls/${String(pr.prId)}/comments/${String(commentId)}/replies`,
        '--method',
        'POST',
        '-f',
        `body=${reply.body}`,
      ]);
      replyCount += 1;
    }

    if (threadId && shouldResolveThread(reply)) {
      await runGh([
        'graphql',
        '-f',
        'query=mutation($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } } }',
        '-f',
        `threadId=${threadId}`,
      ]);
      resolveCount += 1;
    }
  }

  return { replyCount, resolveCount };
}

async function postReviewPayload(
  pr: PrReference,
  payloadFile: string,
): Promise<string> {
  return runGh([
    `repos/${pr.owner}/${pr.repo}/pulls/${String(pr.prId)}/reviews`,
    '--method',
    'POST',
    '--input',
    payloadFile,
    '--jq',
    '.id',
  ]);
}

async function restorePendingReviewPayload(
  pr: PrReference,
  payloadFile: string,
): Promise<CreatedPendingReview> {
  const output = await runGh([
    `repos/${pr.owner}/${pr.repo}/pulls/${String(pr.prId)}/reviews`,
    '--method',
    'POST',
    '--input',
    payloadFile,
    '--jq',
    '[.id, .node_id] | @tsv',
  ]);
  const [databaseId = '', nodeId = ''] = output.trim().split('\t');
  if (!databaseId || !nodeId) {
    throw new Error(
      'GitHub review API did not return both database and node identifiers for the restored pending review.',
    );
  }
  return { databaseId, nodeId };
}

async function postReviewPayloadWithPendingCleanup(
  pr: PrReference,
  payloadFile: string,
  failOnExistingPendingReview: boolean,
  escrow: PendingReviewEscrow,
  warnings: string[],
): Promise<string> {
  const attemptedPayload = parseJson(
    readFileSync(payloadFile, 'utf8'),
    payloadFile,
  );
  if (!isRecord(attemptedPayload)) {
    throw new Error(`Review payload in ${payloadFile} must be an object.`);
  }
  if (!readString(attemptedPayload, 'commit_id')) {
    attemptedPayload.commit_id = await fetchPullRequestHeadSha(pr);
    writeFileSync(
      payloadFile,
      `${JSON.stringify(attemptedPayload, null, 2)}\n`,
      'utf8',
    );
  }
  try {
    return await postReviewPayload(pr, payloadFile);
  } catch (error) {
    if (!isInlineCommentValidationError(error)) {
      throw error;
    }

    let pendingReviews: GitHubPendingReview[];
    try {
      pendingReviews = await listPendingReviews(pr);
    } catch (inspectionError) {
      throw new PendingReviewLifecycleError(
        'pending_review_inspection_failed',
        `GitHub rejected the automated review with HTTP 422, but pending reviews could not be inspected safely: ${readErrorText(inspectionError)}. No pending review was deleted.`,
      );
    }
    for (const pendingReview of pendingReviews) {
      let comments: GitHubPendingReviewComment[];
      try {
        comments = await listPendingReviewComments(pr, pendingReview.id);
      } catch (captureError) {
        throw new PendingReviewLifecycleError(
          'pending_review_escrow_failed',
          `Pending GitHub review ${String(pendingReview.id)} was detected after an HTTP 422 but could not be captured in durable persistence, so it was left unchanged: ${readErrorText(captureError)}`,
        );
      }

      const matchesAttempt = matchesAttemptedReview(
        pendingReview,
        comments,
        attemptedPayload,
      );
      const automated =
        isAutomatedPendingReview(pendingReview) || matchesAttempt;
      if (failOnExistingPendingReview && !automated) {
        const author = pendingReview.user.login || 'the authenticated user';
        throw new PendingReviewLifecycleError(
          'existing_pending_review',
          `Existing pending GitHub review ${String(pendingReview.id)} by ${author} was left unchanged because fail_on_existing_pending_review is enabled.`,
        );
      }

      let entry: PendingReviewEscrowEntry;
      try {
        entry = await capturePendingReview(
          pr,
          pendingReview,
          matchesAttempt
            ? 'new_automated_partial'
            : automated
              ? 'pre_existing_automated'
              : 'pre_existing_human',
          escrow,
          comments,
        );
      } catch (captureError) {
        throw new PendingReviewLifecycleError(
          'pending_review_escrow_failed',
          `Pending GitHub review ${String(pendingReview.id)} was detected after an HTTP 422 but could not be captured in durable persistence, so it was left unchanged: ${readErrorText(captureError)}`,
        );
      }
      await deleteEscrowedPendingReview(pr, entry, escrow, !automated);
      if (matchesAttempt) {
        warnings.push(
          `GitHub returned HTTP 422 and left a partial pending review; removed partial pending review ${String(pendingReview.id)} after GitHub returned HTTP 422. Its durable escrow remains at ${escrow.path}`,
        );
      } else if (automated) {
        warnings.push(
          `GitHub returned HTTP 422 while a stale automated pending review existed; removed stale automated pending review ${String(pendingReview.id)}. Its durable escrow remains at ${escrow.path}`,
        );
      } else {
        warnings.push(
          `A concurrent human pending review ${String(pendingReview.id)} was escrowed and will be restored after automated review posting. Its durable escrow is at ${escrow.path}`,
        );
      }
    }

    throw error;
  }
}

async function restoreEscrowedHumanReviews(
  pr: PrReference,
  escrow: PendingReviewEscrow,
): Promise<PendingReviewRestorationResult> {
  const failures: PendingReviewEscrowEntry[] = [];
  const journalErrors: string[] = [];
  for (const entry of escrow.entries) {
    if (
      entry.classification !== 'pre_existing_human' ||
      entry.status !== 'deleted_pending_restore'
    ) {
      continue;
    }

    entry.status = 'restoring';
    try {
      escrow.persist();
    } catch (error) {
      journalErrors.push(
        `Could not persist the restoring state for pending review ${String(entry.originalReviewId)}: ${readErrorText(error)}`,
      );
    }
    const payloadFile = pendingReviewRestorePayloadPath(
      escrow,
      entry.originalReviewId,
    );

    try {
      const restoredReview = await restorePendingReviewPayload(pr, payloadFile);
      entry.restoredReviewId = restoredReview.databaseId;
      const fileLevelComments: InlineComment[] = entry.comments
        .filter(isFileLevelPendingReviewComment)
        .map((comment) => ({
          path: comment.path,
          body: comment.body,
          subject_type: 'file',
        }));
      const fileLevelResult = await restoreFileLevelCommentsToPendingReview(
        fileLevelComments,
        restoredReview.nodeId,
      );
      if (fileLevelResult.failedCount > 0) {
        throw new Error(
          `Failed to restore ${String(fileLevelResult.failedCount)} file-level draft comment(s): ${fileLevelResult.errorMessage}`,
        );
      }
      entry.status = 'restored';
      entry.restoredAt = new Date().toISOString();
    } catch (error) {
      entry.status = 'restore_failed';
      entry.restorationError = readErrorText(error);
      failures.push(entry);
    }
    try {
      escrow.persist();
    } catch (error) {
      journalErrors.push(
        `Could not persist the final restoration state for pending review ${String(entry.originalReviewId)}: ${readErrorText(error)}`,
      );
    }
  }
  return { failures, journalErrors };
}

async function restoreFileLevelCommentsToPendingReview(
  comments: InlineComment[],
  pullRequestReviewId: string,
): Promise<FileLevelPostResult> {
  const mutation =
    'mutation($pullRequestReviewId: ID!, $path: String!, $body: String!) { addPullRequestReviewThread(input: {pullRequestReviewId: $pullRequestReviewId, path: $path, body: $body, subjectType: FILE}) { thread { id } } }';
  let postedCount = 0;
  let failedCount = 0;
  let firstError = '';

  for (const comment of comments) {
    try {
      await runGh([
        'graphql',
        '-f',
        `query=${mutation}`,
        '-f',
        `pullRequestReviewId=${pullRequestReviewId}`,
        '-f',
        `path=${comment.path}`,
        '-f',
        `body=${comment.body}`,
      ]);
      postedCount += 1;
    } catch (error) {
      failedCount += 1;
      if (!firstError) {
        firstError = readErrorText(error);
      }
    }
  }

  return {
    postedCount,
    failedCount,
    errorMessage: firstError,
  };
}

async function postFileLevelComments(
  pr: PrReference,
  comments: InlineComment[],
  commitId: string | undefined,
): Promise<FileLevelPostResult> {
  if (comments.length === 0) {
    return { postedCount: 0, failedCount: 0, errorMessage: '' };
  }

  const combinedPayloadFile = writeOutputFile(
    'file_level_comments_file',
    'github-file-level-comments.json',
    `${JSON.stringify(comments, null, 2)}\n`,
  );
  const outputDir = dirname(combinedPayloadFile);
  let postedCount = 0;
  let failedCount = 0;
  let firstError = '';

  for (let index = 0; index < comments.length; index += 1) {
    const comment = comments[index];
    const payload: Record<string, unknown> = {
      body: comment.body,
      path: comment.path,
      subject_type: 'file',
    };
    if (commitId) {
      payload.commit_id = commitId;
    }

    const payloadFile = join(
      outputDir,
      `github-file-level-comment-${String(index + 1)}.json`,
    );
    writeFileSync(payloadFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    try {
      await runGh([
        `repos/${pr.owner}/${pr.repo}/pulls/${String(pr.prId)}/comments`,
        '--method',
        'POST',
        '--input',
        payloadFile,
        '--jq',
        '.id',
      ]);
      postedCount += 1;
    } catch (error) {
      failedCount += 1;
      if (!firstError) {
        firstError = readErrorText(error);
      }
    }
  }

  return {
    postedCount,
    failedCount,
    errorMessage: firstError,
  };
}

export async function runGithubPostReviewCommentAction(
  env: NodeJS.ProcessEnv = process.env,
  pendingReviewFilesystem: PendingReviewFilesystem = DEFAULT_PENDING_REVIEW_FILESYSTEM,
): Promise<void> {
  await runWithActionEnvironment(env, async () => {
    const pr = resolvePrReference(env);
    const review = normalizeReviewContent(readReviewInput(env));
    const event = resolveReviewEvent(env.INPUT_EVENT);
    const failOnExistingPendingReview = parseBooleanInput(
      env.INPUT_FAIL_ON_EXISTING_PENDING_REVIEW,
      'fail_on_existing_pending_review',
      false,
    );
    let reviewComments = review.comments;
    let localFileLevelComments: InlineComment[] = [];
    const diffFile = env.INPUT_DIFF_FILE?.trim();
    if (diffFile) {
      try {
        const diffLineIndex = parseDiffLineIndex(
          readFileSync(diffFile, 'utf8'),
        );
        if (hasDiffLineEntries(diffLineIndex)) {
          const { reviewComments: validReviewComments, fileLevelComments } =
            splitInvalidLineCommentsForRetry(review.comments, diffLineIndex);
          reviewComments = validReviewComments;
          localFileLevelComments = fileLevelComments;
        }
      } catch {
        // Local diff prefiltering is best-effort. GitHub's rejection path below
        // still validates against the live PR diff if inline coordinates fail.
      }
    }

    const payload: Record<string, unknown> = {
      body: review.body,
      event,
      comments: reviewComments,
    };
    if (review.commit_id) {
      payload.commit_id = review.commit_id;
    }

    const payloadFile = writeOutputFile(
      'payload_file',
      'github-review-payload.json',
      `${JSON.stringify(payload, null, 2)}\n`,
    );
    if (localFileLevelComments.length > 0) {
      writeOutputFile(
        'adjusted_payload_file',
        'github-review-payload-valid-inline-comments.json',
        `${JSON.stringify(payload, null, 2)}\n`,
      );
    }

    const escrow = new PendingReviewEscrow(pr, pendingReviewFilesystem);
    const pendingReviewWarnings: string[] = [];
    let reviewId = '';
    let result: PostResult | null = null;
    let primaryError: unknown = null;

    try {
      let existingPendingReviews: GitHubPendingReview[];
      try {
        existingPendingReviews = await listPendingReviews(pr);
      } catch (inspectionError) {
        throw new PendingReviewLifecycleError(
          'pending_review_inspection_failed',
          `Pending GitHub reviews could not be inspected before posting. No review was posted or deleted: ${readErrorText(inspectionError)}`,
        );
      }
      const blockingPendingReview = failOnExistingPendingReview
        ? existingPendingReviews.find(
            (pendingReview) => !isAutomatedPendingReview(pendingReview),
          )
        : undefined;
      if (blockingPendingReview) {
        const author =
          blockingPendingReview.user.login || 'the authenticated user';
        throw new PendingReviewLifecycleError(
          'existing_pending_review',
          `Existing pending GitHub review ${String(blockingPendingReview.id)} by ${author} was left unchanged because fail_on_existing_pending_review is enabled.`,
        );
      }

      for (const pendingReview of existingPendingReviews) {
        const automated = isAutomatedPendingReview(pendingReview);
        let entry: PendingReviewEscrowEntry;
        try {
          entry = await capturePendingReview(
            pr,
            pendingReview,
            automated ? 'pre_existing_automated' : 'pre_existing_human',
            escrow,
          );
        } catch (captureError) {
          throw new PendingReviewLifecycleError(
            'pending_review_escrow_failed',
            `Existing pending GitHub review ${String(pendingReview.id)} could not be captured in durable persistence, so it was left unchanged: ${readErrorText(captureError)}`,
          );
        }
        await deleteEscrowedPendingReview(pr, entry, escrow, !automated);
        pendingReviewWarnings.push(
          automated
            ? `Removed stale automated pending review ${String(pendingReview.id)}; its durable escrow remains at ${escrow.path}`
            : `Temporarily removed pending review ${String(pendingReview.id)} so the automated review could be submitted; it will be restored from durable escrow ${escrow.path}`,
        );
      }

      let postedInlineCommentCount = reviewComments.length;
      let postedFileLevelCommentCount = 0;
      let failedFileLevelCommentCount = 0;
      let omittedInlineCommentCount = 0;
      let errorMessage = '';

      try {
        reviewId = await postReviewPayloadWithPendingCleanup(
          pr,
          payloadFile,
          failOnExistingPendingReview,
          escrow,
          pendingReviewWarnings,
        );
      } catch (error) {
        if (
          error instanceof PendingReviewLifecycleError ||
          reviewComments.length === 0 ||
          !isInlineCommentValidationError(error)
        ) {
          throw error;
        }

        try {
          const diff = await fetchPullRequestDiff(pr);
          const { reviewComments: retryReviewComments, fileLevelComments } =
            splitInvalidLineCommentsForRetry(
              reviewComments,
              parseDiffLineIndex(diff),
            );

          if (retryReviewComments.length > 0 || fileLevelComments.length > 0) {
            let nextErrorMessage = `GitHub rejected inline review comment coordinates; retried with ${String(retryReviewComments.length)} valid inline comment(s)`;
            const adjustedPayload = {
              ...payload,
              comments: retryReviewComments,
            };
            const adjustedPayloadFile = writeOutputFile(
              'adjusted_payload_file',
              'github-review-payload-valid-inline-comments.json',
              `${JSON.stringify(adjustedPayload, null, 2)}\n`,
            );
            reviewId = await postReviewPayloadWithPendingCleanup(
              pr,
              adjustedPayloadFile,
              failOnExistingPendingReview,
              escrow,
              pendingReviewWarnings,
            );
            postedInlineCommentCount = retryReviewComments.length;

            if (fileLevelComments.length > 0) {
              try {
                const fileLevelResult = await postFileLevelComments(
                  pr,
                  fileLevelComments,
                  review.commit_id,
                );
                postedFileLevelCommentCount = fileLevelResult.postedCount;
                failedFileLevelCommentCount = fileLevelResult.failedCount;
                nextErrorMessage += ` and posted ${String(fileLevelResult.postedCount)} invalid comment(s) as file-level comments`;

                if (fileLevelResult.failedCount > 0) {
                  nextErrorMessage += `; ${String(fileLevelResult.failedCount)} file-level comment(s) failed to post`;
                  if (fileLevelResult.errorMessage) {
                    nextErrorMessage += `: ${fileLevelResult.errorMessage}`;
                  }
                }
              } catch (fileLevelError) {
                postedFileLevelCommentCount = 0;
                failedFileLevelCommentCount = fileLevelComments.length;
                nextErrorMessage += ` but failed to post ${String(fileLevelComments.length)} invalid comment(s) as file-level comments: ${readErrorText(fileLevelError)}`;
              }
            }
            errorMessage = `${nextErrorMessage}.`;
          }
        } catch (retryError) {
          if (retryError instanceof PendingReviewLifecycleError) {
            throw retryError;
          }
          reviewId = '';
        }

        if (!reviewId) {
          const fallbackPayload = {
            ...payload,
            body: appendOmittedInlineCommentsToBody(
              review.body,
              reviewComments,
            ),
            comments: [],
          };
          const fallbackPayloadFile = writeOutputFile(
            'fallback_payload_file',
            'github-review-payload-no-inline-comments.json',
            `${JSON.stringify(fallbackPayload, null, 2)}\n`,
          );

          reviewId = await postReviewPayloadWithPendingCleanup(
            pr,
            fallbackPayloadFile,
            failOnExistingPendingReview,
            escrow,
            pendingReviewWarnings,
          );
          postedInlineCommentCount = 0;
          postedFileLevelCommentCount = 0;
          failedFileLevelCommentCount = 0;
          omittedInlineCommentCount = reviewComments.length;
          errorMessage =
            'GitHub rejected inline review comment coordinates; posted the review body without inline comments.';
        }
      }

      if (!reviewId) {
        throw new Error('GitHub review API did not return a review id.');
      }

      if (localFileLevelComments.length > 0) {
        const fileLevelResult = await postFileLevelComments(
          pr,
          localFileLevelComments,
          review.commit_id,
        );
        postedFileLevelCommentCount += fileLevelResult.postedCount;
        failedFileLevelCommentCount += fileLevelResult.failedCount;
        const localMessage = `Filtered ${String(localFileLevelComments.length)} inline comment(s) against the local diff before posting and posted ${String(fileLevelResult.postedCount)} as file-level comments`;
        errorMessage = errorMessage
          ? `${errorMessage} ${localMessage}.`
          : `${localMessage}.`;
        if (fileLevelResult.failedCount > 0) {
          errorMessage += ` ${String(fileLevelResult.failedCount)} file-level comment(s) failed to post`;
          if (fileLevelResult.errorMessage) {
            errorMessage += `: ${fileLevelResult.errorMessage}`;
          }
          errorMessage += '.';
        }
      }

      const threadResult = await postThreadReplies(pr, review.replies);
      const reviewUrl = `https://github.com/${pr.owner}/${pr.repo}/pull/${String(pr.prId)}#pullrequestreview-${reviewId}`;
      result = {
        generatedAt: new Date().toISOString(),
        status: 'posted',
        pr,
        reviewId,
        reviewUrl,
        inlineCommentCount: postedInlineCommentCount,
        fileLevelCommentCount: postedFileLevelCommentCount,
        fileLevelFailedCount: failedFileLevelCommentCount,
        omittedInlineCommentCount,
        threadReplyCount: threadResult.replyCount,
        threadResolveCount: threadResult.resolveCount,
        errorMessage,
      };
    } catch (error) {
      primaryError = error;
    }

    let restorationFailures: PendingReviewEscrowEntry[] = [];
    let restorationJournalErrors: string[] = [];
    try {
      const restoration = await restoreEscrowedHumanReviews(pr, escrow);
      restorationFailures = restoration.failures;
      restorationJournalErrors = restoration.journalErrors;
    } catch (error) {
      const message = `Pending review restoration could not complete from durable escrow ${escrow.path || '(not created)'}: ${readErrorText(error)}`;
      setFailureOutputs(
        'pending_review_restore_failed',
        message,
        reviewId,
        'restore_failed',
      );
      throw new Error(message);
    }

    if (restorationFailures.length > 0) {
      const failedIds = restorationFailures
        .map((entry) => String(entry.originalReviewId))
        .join(', ');
      const message = reviewId
        ? `Automated GitHub review ${reviewId} was posted, but pending review ${failedIds} could not be restored. The durable escrow remains at ${escrow.path}. ${restorationFailures
            .map((entry) => entry.restorationError)
            .filter(Boolean)
            .join(' ')}`
        : `The automated GitHub review was not posted, and pending review ${failedIds} could not be restored. The durable escrow remains at ${escrow.path}. ${restorationFailures
            .map((entry) => entry.restorationError)
            .filter(Boolean)
            .join(' ')}`;
      const messageWithJournalErrors = [message, ...restorationJournalErrors]
        .filter(Boolean)
        .join(' ');
      setFailureOutputs(
        'pending_review_restore_failed',
        messageWithJournalErrors,
        reviewId,
        'restore_failed',
      );
      throw new Error(messageWithJournalErrors);
    }

    const restoredEntries = escrow.entries.filter(
      (entry) => entry.status === 'restored',
    );
    const restorationStatus =
      restoredEntries.length > 0
        ? 'restored'
        : escrow.entries.length > 0
          ? 'not_required'
          : 'none';

    if (primaryError) {
      const lifecycleError =
        primaryError instanceof PendingReviewLifecycleError
          ? primaryError
          : null;
      const failureMode =
        lifecycleError?.failureMode ??
        (restoredEntries.length > 0
          ? 'review_post_failed_pending_restored'
          : 'review_post_failed');
      let message = readErrorText(primaryError);
      if (restoredEntries.length > 0) {
        message += ` Pending review ${restoredEntries.map((entry) => String(entry.originalReviewId)).join(', ')} was restored from durable escrow ${escrow.path}.`;
      }
      if (restorationJournalErrors.length > 0) {
        message += ` ${restorationJournalErrors.join(' ')}`;
      }
      setFailureOutputs(failureMode, message, reviewId, restorationStatus);
      throw new Error(message);
    }

    if (restorationJournalErrors.length > 0) {
      const message = `Pending review restoration completed, but its durable escrow journal could not be fully updated at ${escrow.path}. ${restorationJournalErrors.join(' ')}`;
      setFailureOutputs(
        'pending_review_restore_journal_failed',
        message,
        reviewId,
        restorationStatus,
      );
      throw new Error(message);
    }

    if (!result) {
      const message = 'GitHub review posting completed without a result.';
      setFailureOutputs(
        'review_post_failed',
        message,
        reviewId,
        restorationStatus,
      );
      throw new Error(message);
    }

    if (restoredEntries.length > 0) {
      pendingReviewWarnings.push(
        `Restored pending review ${restoredEntries.map((entry) => String(entry.originalReviewId)).join(', ')} as new pending review ${restoredEntries.map((entry) => entry.restoredReviewId).join(', ')}; durable escrow remains at ${escrow.path}`,
      );
    }
    if (pendingReviewWarnings.length > 0) {
      result.errorMessage = [result.errorMessage, ...pendingReviewWarnings]
        .filter(Boolean)
        .join(' ');
    }

    writeOutputFile(
      'result_json_file',
      'github-post-review-comment.json',
      `${JSON.stringify(result, null, 2)}\n`,
    );

    setOutput('status', result.status);
    setOutput('review_id', result.reviewId);
    setOutput('review_comment_id', result.reviewId);
    setOutput('review_url', result.reviewUrl);
    setOutput('inline_comment_count', String(result.inlineCommentCount));
    setOutput('file_level_comment_count', String(result.fileLevelCommentCount));
    setOutput('file_level_failed_count', String(result.fileLevelFailedCount));
    setOutput(
      'omitted_inline_comment_count',
      String(result.omittedInlineCommentCount),
    );
    setOutput('thread_reply_count', String(result.threadReplyCount));
    setOutput('thread_resolve_count', String(result.threadResolveCount));
    setOutput('failure_mode', '');
    setOutput('pending_review_restoration_status', restorationStatus);
    setOutput('error_message', toSingleLineOutput(result.errorMessage));
  });
}
