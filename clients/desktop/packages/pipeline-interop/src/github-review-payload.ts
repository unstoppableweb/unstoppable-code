// ---------------------------------------------------------------------------
// Pure GitHub review payload helpers, shared by the `gh` review poster
// (`builtin/github-post-review-comment`), the executor's
// `github-publish-review` host request builder and the web review publisher.
// Browser-safe: no Node, filesystem or network access.
// ---------------------------------------------------------------------------

/** One inline (or file-level) review comment, in GitHub's REST shape. */
export interface ReviewInlineComment {
  path: string;
  body: string;
  line?: number;
  start_line?: number;
  side?: 'LEFT' | 'RIGHT';
  start_side?: 'LEFT' | 'RIGHT';
  subject_type?: 'line' | 'file';
}

/** A reply to an existing review thread, optionally resolving it. */
export interface ReviewThreadReply {
  comment_id?: number;
  commentId?: number;
  thread_id?: string;
  threadId?: string;
  body: string;
  resolve?: boolean;
  action?: string;
}

export interface ReviewContent {
  body: string;
  comments: ReviewInlineComment[];
  replies: ReviewThreadReply[];
  commit_id?: string;
}

export interface DiffLineIndex {
  left: Map<string, Set<number>>;
  right: Map<string, Set<number>>;
}

export interface SplitReviewComments {
  reviewComments: ReviewInlineComment[];
  fileLevelComments: ReviewInlineComment[];
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

export function normalizeInlineComment(
  value: unknown,
): ReviewInlineComment | null {
  if (!isRecord(value)) {
    return null;
  }

  const path = readString(value, 'path') || readString(value, 'filePath');
  const body = readString(value, 'body');
  let line = readNumber(value, 'line') ?? readNumber(value, 'lineEnd');
  let startLine =
    readNumber(value, 'start_line') ?? readNumber(value, 'startLine');
  const subjectType = readString(value, 'subject_type');
  if (!path || !body) {
    return null;
  }

  if (line !== null && startLine !== null && startLine > line) {
    [startLine, line] = [line, startLine];
  }

  const comment: ReviewInlineComment = {
    path,
    body,
  };

  if (line !== null && line > 0) {
    comment.line = line;
  }
  if (startLine !== null && startLine > 0 && startLine !== line) {
    comment.start_line = startLine;
  }
  if (value.side === 'LEFT' || value.side === 'RIGHT') {
    comment.side = value.side;
  }
  if (value.start_side === 'LEFT' || value.start_side === 'RIGHT') {
    comment.start_side = value.start_side;
  }
  if (subjectType === 'file') {
    comment.subject_type = 'file';
  }

  if (comment.subject_type !== 'file' && comment.line === undefined) {
    return null;
  }

  return comment;
}

export function normalizeReply(value: unknown): ReviewThreadReply | null {
  if (!isRecord(value)) {
    return null;
  }

  const body = readString(value, 'body');
  if (!body) {
    return null;
  }

  const commentId =
    readNumber(value, 'comment_id') ?? readNumber(value, 'commentId');
  const threadId =
    readString(value, 'thread_id') || readString(value, 'threadId');
  const action = readString(value, 'action');

  return {
    body,
    ...(commentId !== null ? { comment_id: commentId } : {}),
    ...(threadId ? { thread_id: threadId } : {}),
    ...(typeof value.resolve === 'boolean' ? { resolve: value.resolve } : {}),
    ...(action ? { action } : {}),
  };
}

function arrayFrom(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function normalizeReviewContent(raw: unknown): ReviewContent {
  if (!isRecord(raw)) {
    throw new Error('Review JSON must be an object.');
  }

  const body =
    readString(raw, 'body') ||
    readString(raw, 'reviewBody') ||
    readString(raw, 'summary');
  if (!body.trim()) {
    throw new Error('Review JSON must include a non-empty body.');
  }

  const comments = arrayFrom(raw.comments ?? raw.inline_comments)
    .map(normalizeInlineComment)
    .filter((comment): comment is ReviewInlineComment => comment !== null);
  const replies = arrayFrom(raw.replies ?? raw.thread_replies ?? raw.threads)
    .map(normalizeReply)
    .filter((reply): reply is ReviewThreadReply => reply !== null);

  return {
    body,
    comments,
    replies,
    commit_id: readString(raw, 'commit_id') || readString(raw, 'commitId'),
  };
}

/**
 * The omitted-comments section. `additionalCount` names comments left out of
 * the JSON block to keep the body within a size bound ("And N more.").
 */
export function buildOmittedInlineCommentsSection(
  comments: ReviewInlineComment[],
  additionalCount = 0,
): string {
  return [
    '<details>',
    `<summary>Inline comments omitted from GitHub review (${String(comments.length + additionalCount)})</summary>`,
    '',
    'GitHub rejected these inline comment coordinates. The original inline comment payload is preserved below as JSON.',
    '',
    '```json',
    JSON.stringify(comments, null, 2),
    '```',
    '',
    ...(additionalCount > 0
      ? [`And ${String(additionalCount)} more.`, '']
      : []),
    '</details>',
    '',
  ].join('\n');
}

const AI_REVIEW_DATA_TRAILER =
  /(\n?<!-- AI_REVIEW_DATA:\s*\{[\s\S]*?\}\s*-->\s*)$/;

/** Insert `section` before the `AI_REVIEW_DATA` trailer, so it stays last. */
function insertBeforeReviewDataTrailer(body: string, section: string): string {
  const trailerMatch = body.match(AI_REVIEW_DATA_TRAILER);
  if (!trailerMatch) {
    return `${body.trimEnd()}\n\n${section}`;
  }

  return `${body.slice(0, trailerMatch.index).trimEnd()}\n\n${section}${trailerMatch[1].trimStart()}`;
}

export function appendOmittedInlineCommentsToBody(
  body: string,
  comments: ReviewInlineComment[],
): string {
  return insertBeforeReviewDataTrailer(
    body,
    buildOmittedInlineCommentsSection(comments),
  );
}

/**
 * {@link appendOmittedInlineCommentsToBody}, keeping the result within
 * `maxChars`: the omitted section drops comments from the end and counts them
 * instead ("And N more."). The review text itself is never truncated, so a
 * body already over the bound is returned unchanged.
 */
export function appendOmittedInlineCommentsWithinBound(
  body: string,
  comments: ReviewInlineComment[],
  maxChars: number,
): string {
  if (comments.length === 0) {
    return body;
  }
  for (let listed = comments.length; listed >= 0; listed -= 1) {
    const candidate = insertBeforeReviewDataTrailer(
      body,
      buildOmittedInlineCommentsSection(
        comments.slice(0, listed),
        comments.length - listed,
      ),
    );
    if (candidate.length <= maxChars) {
      return candidate;
    }
  }
  return body;
}

/**
 * Insert a line before the `AI_REVIEW_DATA` trailer (at the end when the body
 * has none), so the marker stays last.
 */
export function insertReviewFooterLine(body: string, line: string): string {
  return insertBeforeReviewDataTrailer(body, `${line}\n`);
}

function addLine(
  index: Map<string, Set<number>>,
  path: string,
  line: number,
): void {
  if (!path || line <= 0) {
    return;
  }

  const existing = index.get(path);
  if (existing) {
    existing.add(line);
    return;
  }

  index.set(path, new Set([line]));
}

export function parseDiffLineIndex(diff: string): DiffLineIndex {
  const left = new Map<string, Set<number>>();
  const right = new Map<string, Set<number>>();
  let leftPath = '';
  let rightPath = '';
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('--- ')) {
      const rawPath = line.slice(4).trim();
      leftPath = rawPath === '/dev/null' ? '' : rawPath.replace(/^a\//, '');
      inHunk = false;
      continue;
    }

    if (line.startsWith('+++ ')) {
      const rawPath = line.slice(4).trim();
      rightPath = rawPath === '/dev/null' ? '' : rawPath.replace(/^b\//, '');
      inHunk = false;
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = Number.parseInt(hunkMatch[1], 10);
      newLine = Number.parseInt(hunkMatch[2], 10);
      inHunk = true;
      continue;
    }

    if (!inHunk) {
      continue;
    }

    if (line.startsWith(' ')) {
      addLine(left, leftPath, oldLine);
      addLine(right, rightPath, newLine);
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (line.startsWith('+')) {
      addLine(right, rightPath, newLine);
      newLine += 1;
      continue;
    }

    if (line.startsWith('-')) {
      addLine(left, leftPath, oldLine);
      oldLine += 1;
    }
  }

  return { left, right };
}

export function hasDiffLineEntries(diffLineIndex: DiffLineIndex): boolean {
  return diffLineIndex.left.size > 0 || diffLineIndex.right.size > 0;
}

export function commentLineRange(comment: ReviewInlineComment): number[] {
  if (comment.line === undefined) {
    return [];
  }

  if (comment.start_line === undefined || comment.start_line === comment.line) {
    return [comment.line];
  }

  const start = Math.min(comment.start_line, comment.line);
  const end = Math.max(comment.start_line, comment.line);
  const lines: number[] = [];
  for (let line = start; line <= end; line += 1) {
    lines.push(line);
  }
  return lines;
}

export function hasValidCommentLines(
  comment: ReviewInlineComment,
  diffLineIndex: DiffLineIndex,
): boolean {
  if (comment.subject_type === 'file') {
    return true;
  }

  const lines = commentLineRange(comment);
  if (lines.length === 0) {
    return false;
  }

  const side = comment.side === 'LEFT' ? 'left' : 'right';
  const validLines = diffLineIndex[side].get(comment.path);
  if (!validLines) {
    return false;
  }

  return lines.every((line) => validLines.has(line));
}

export function formatOriginalLineSuffix(comment: ReviewInlineComment): string {
  if (comment.line === undefined) {
    return '';
  }

  if (
    comment.start_line !== undefined &&
    comment.start_line > 0 &&
    comment.start_line !== comment.line
  ) {
    return ` (Lines: ${String(comment.start_line)} to ${String(comment.line)})`;
  }

  return ` (Lines: ${String(comment.line)})`;
}

export function toFileLevelComment(
  comment: ReviewInlineComment,
): ReviewInlineComment {
  const lineSuffix = formatOriginalLineSuffix(comment);
  return {
    path: comment.path,
    body: lineSuffix ? `${comment.body}${lineSuffix}` : comment.body,
    subject_type: 'file',
  };
}

export function splitInvalidLineCommentsForRetry(
  comments: ReviewInlineComment[],
  diffLineIndex: DiffLineIndex,
): SplitReviewComments {
  const reviewComments: ReviewInlineComment[] = [];
  const fileLevelComments: ReviewInlineComment[] = [];

  for (const comment of comments) {
    if (comment.subject_type === 'file') {
      fileLevelComments.push(toFileLevelComment(comment));
      continue;
    }

    if (hasValidCommentLines(comment, diffLineIndex)) {
      reviewComments.push(comment);
      continue;
    }

    fileLevelComments.push(toFileLevelComment(comment));
  }

  return {
    reviewComments,
    fileLevelComments,
  };
}

/** The review a host sends to the publisher, before or after fitting. */
export interface ReviewPublishPayloadContent {
  body: string;
  comments: ReviewInlineComment[];
  replies: ReviewThreadReply[];
}

export interface FittedReviewPayload extends ReviewPublishPayloadContent {
  /** Inline comments moved into the body's omitted section. */
  omittedCount: number;
}

function utf8JsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Fit a review into `maxBytes` of UTF-8 JSON by moving inline comments (last
 * first) into the body's omitted section, keeping the body within
 * `maxBodyChars` (the omitted section is truncated with a count, never the
 * review text). At most `maxComments` stay inline; the rest are omitted the
 * same way. Returns `null` when the body and replies alone are too large.
 */
export function fitReviewPayload(
  content: ReviewPublishPayloadContent,
  maxBytes: number,
  maxBodyChars: number,
  maxComments: number = Number.POSITIVE_INFINITY,
): FittedReviewPayload | null {
  if (content.body.length > maxBodyChars) {
    return null;
  }
  if (
    utf8JsonByteLength({
      body: content.body,
      comments: [],
      replies: content.replies,
    }) > maxBytes
  ) {
    return null;
  }
  for (
    let kept = Math.min(content.comments.length, Math.max(0, maxComments));
    kept >= 0;
    kept -= 1
  ) {
    const comments = content.comments.slice(0, kept);
    const omitted = content.comments.slice(kept);
    const body = appendOmittedInlineCommentsWithinBound(
      content.body,
      omitted,
      maxBodyChars,
    );
    const candidate = { body, comments, replies: content.replies };
    if (utf8JsonByteLength(candidate) <= maxBytes) {
      return { ...candidate, omittedCount: omitted.length };
    }
  }
  return null;
}
