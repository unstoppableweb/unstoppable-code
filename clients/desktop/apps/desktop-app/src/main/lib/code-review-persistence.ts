import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  emptyCodeReviewFile,
  isLogicDiffDiagram,
  isDataModelDiffDiagram,
  isReviewAnnotationSet,
  isReviewCommentThread,
  normalizeCodeReviewFile,
  type CodeReviewArtifact,
  type CodeReviewFile,
  type CodeReviewSaveCommentsRequest,
  type DataModelDiffDiagram,
  type LogicDiffDiagram,
  type ReviewAnnotationSet,
  type ReviewComment,
  type ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import {
  withReviewStateLock,
  writeReviewStateText,
} from '@canopy/core-runtime/node/review';
import { getCodeReviewStateFilePath } from './paths';
import { isPathInside } from './path-safety';
import { resolveWorktreeCwd } from './resolve-worktree';
import { runCodeReviewTask } from './code-review-deletion-fence';
import { logMainProcessWarn } from './main-process-logging';

export type AnyCodeReviewArtifact =
  | CodeReviewArtifact<ReviewAnnotationSet>
  | CodeReviewArtifact<LogicDiffDiagram>
  | CodeReviewArtifact<DataModelDiffDiagram>;

/**
 * Serializes read-modify-write operations on one code-review state file, so
 * concurrent writes (scheduler and IPC) cannot silently drop data. The lock
 * and the atomic file replacement are the core-runtime review state file's
 * (CAN-4167), the one writer of this store.
 */
const withFileLock = withReviewStateLock;

interface StoredReview {
  readonly file: CodeReviewFile;
  /**
   * Stored threads the reader rejects (CAN-6667). They aren't shown, and
   * writes carry them on disk as they were instead of erasing them.
   */
  readonly unreadable: readonly unknown[];
}

/** Each scope's unreadable thread count as of its last read or write. */
const skippedThreadCounts = new Map<string, number>();
const scopeKey = (projectId: string, worktreeId: string): string =>
  `${projectId}\u0000${worktreeId}`;

async function readStoredState(
  projectId: string,
  worktreeId: string,
): Promise<StoredReview> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(getCodeReviewStateFilePath(projectId, worktreeId), 'utf8'),
    );
  } catch {
    skippedThreadCounts.delete(scopeKey(projectId, worktreeId));
    return { file: emptyCodeReviewFile(), unreadable: [] };
  }
  const file = normalizeCodeReviewFile(parsed);
  const unreadable =
    typeof parsed === 'object' &&
    parsed !== null &&
    'version' in parsed &&
    parsed.version === 1 &&
    'commentThreads' in parsed &&
    Array.isArray(parsed.commentThreads)
      ? parsed.commentThreads.filter(
          (thread: unknown) => !isReviewCommentThread(thread),
        )
      : [];
  recordSkipped(projectId, worktreeId, unreadable.length);
  if (unreadable.length > 0)
    logMainProcessWarn(
      `[code-review] skipped ${unreadable.length} unreadable comment thread${unreadable.length === 1 ? '' : 's'}`,
      { projectId, worktreeId, skipped: unreadable.length },
    );
  return { file, unreadable };
}

function recordSkipped(
  projectId: string,
  worktreeId: string,
  skipped: number,
): void {
  if (skipped > 0)
    skippedThreadCounts.set(scopeKey(projectId, worktreeId), skipped);
  else skippedThreadCounts.delete(scopeKey(projectId, worktreeId));
}

async function readFileState(
  projectId: string,
  worktreeId: string,
): Promise<CodeReviewFile> {
  return (await readStoredState(projectId, worktreeId)).file;
}

/**
 * The `skippedCommentThreads` field for a review read or update in this
 * scope: absent when every stored thread was readable.
 */
export function skippedCommentThreadsField(
  projectId: string,
  worktreeId: string,
): { skippedCommentThreads?: number } {
  const skipped = skippedThreadCounts.get(scopeKey(projectId, worktreeId));
  return skipped === undefined ? {} : { skippedCommentThreads: skipped };
}

async function writeFileState(
  projectId: string,
  worktreeId: string,
  file: CodeReviewFile,
  unreadable: readonly unknown[],
): Promise<void> {
  // A thread saved under the same id replaces the unreadable one.
  const kept = unreadable.filter(
    (thread) =>
      !(
        typeof thread === 'object' &&
        thread !== null &&
        'id' in thread &&
        file.commentThreads.some((saved) => saved.id === thread.id)
      ),
  );
  await writeReviewStateText(
    getCodeReviewStateFilePath(projectId, worktreeId),
    JSON.stringify(
      { ...file, commentThreads: [...file.commentThreads, ...kept] },
      null,
      2,
    ),
  );
  recordSkipped(projectId, worktreeId, kept.length);
}

function runCodeReviewMutation<T>(
  projectId: string,
  worktreeId: string,
  run: () => Promise<T>,
): Promise<T> {
  return runCodeReviewTask({ projectId, worktreeId }, run, () =>
    Promise.reject(
      new Error('Code review state is being removed for this worktree.'),
    ),
  );
}

export async function readCodeReviewState(
  projectId: string,
  worktreeId: string,
): Promise<CodeReviewFile> {
  return readFileState(projectId, worktreeId);
}

export async function setCodeReviewArmed(
  projectId: string,
  worktreeId: string,
): Promise<CodeReviewFile> {
  const filePath = getCodeReviewStateFilePath(projectId, worktreeId);
  return runCodeReviewMutation(projectId, worktreeId, () =>
    withFileLock(filePath, async () => {
      const { file, unreadable } = await readStoredState(projectId, worktreeId);
      const next: CodeReviewFile = {
        ...file,
        armed: true,
        armedAt: file.armedAt ?? new Date().toISOString(),
      };
      await writeFileState(projectId, worktreeId, next, unreadable);
      return next;
    }),
  );
}

/**
 * Merge incoming (renderer) threads with stored ones so concurrently-posted
 * agent replies and agent-driven resolution are never dropped by a stale
 * renderer save.
 */
function mergeReviewThreads(
  stored: ReviewCommentThread[],
  incoming: ReviewCommentThread[],
  baseIds?: string[],
  baseThreads?: ReviewCommentThread[],
): ReviewCommentThread[] {
  const storedById = new Map(stored.map((thread) => [thread.id, thread]));
  const baseById = new Map(
    (baseThreads ?? []).map((thread) => [thread.id, thread]),
  );
  const merged = incoming.map((incomingThread) => {
    const existing = storedById.get(incomingThread.id);
    if (!existing) {
      return incomingThread;
    }
    const base = baseById.get(incomingThread.id);
    if (base) {
      const baseComments = new Map(
        base.comments.map((comment) => [comment.id, comment]),
      );
      const incomingComments = new Map(
        incomingThread.comments.map((comment) => [comment.id, comment]),
      );
      const comments = existing.comments
        .filter(
          (comment) =>
            !baseComments.has(comment.id) || incomingComments.has(comment.id),
        )
        .map((comment) => {
          const next = incomingComments.get(comment.id);
          const previous = baseComments.get(comment.id);
          return next && previous && !isDeepStrictEqual(next, previous)
            ? next
            : comment;
        });
      const mergedCommentIds = new Set(comments.map((comment) => comment.id));
      for (const comment of incomingThread.comments) {
        if (!mergedCommentIds.has(comment.id)) comments.push(comment);
      }
      return {
        ...existing,
        status:
          incomingThread.status !== base.status
            ? incomingThread.status
            : existing.status,
        anchor: !isDeepStrictEqual(incomingThread.anchor, base.anchor)
          ? incomingThread.anchor
          : existing.anchor,
        anchorState:
          incomingThread.anchorState !== base.anchorState
            ? incomingThread.anchorState
            : existing.anchorState,
        comments,
      };
    }
    const incomingIds = new Set(
      incomingThread.comments.map((comment) => comment.id),
    );
    const preservedAgentComments = existing.comments.filter(
      (comment) => comment.author === 'agent' && !incomingIds.has(comment.id),
    );
    return {
      ...incomingThread,
      // Preserve a stored `resolved` over an incoming `open` ONLY when the
      // incoming save is stale about agent activity (it is missing agent
      // comments the store has) — that is the case the guard exists for: a
      // renderer that hasn't yet seen an agent's resolve+reply must not
      // silently un-resolve it. When the renderer HAS all the agent comments
      // and still sends `open`, that is a deliberate user reopen and must be
      // honored (otherwise a resolved comment can never be reopened).
      status:
        existing.status === 'resolved' &&
        incomingThread.status === 'open' &&
        preservedAgentComments.length > 0
          ? existing.status
          : incomingThread.status,
      comments: [...incomingThread.comments, ...preservedAgentComments],
    };
  });
  const incomingIds = new Set(incoming.map((thread) => thread.id));
  const base = new Set(baseIds ?? stored.map((thread) => thread.id));
  return [
    ...merged,
    ...stored.filter(
      (thread) =>
        !incomingIds.has(thread.id) &&
        (!base.has(thread.id) ||
          thread.comments.some((comment) => comment.author === 'agent')),
    ),
  ];
}

export async function saveCodeReviewComments(
  request: CodeReviewSaveCommentsRequest,
): Promise<CodeReviewFile | null> {
  // A thread the reader would drop is refused rather than written and lost
  // on the next read (CAN-6667).
  if (!request.commentThreads.every(isReviewCommentThread))
    throw new Error('This comment thread could not be saved.');
  const filePath = getCodeReviewStateFilePath(
    request.projectId,
    request.worktreeId,
  );
  return runCodeReviewMutation(request.projectId, request.worktreeId, () =>
    withFileLock(filePath, async () => {
      const { file, unreadable } = await readStoredState(
        request.projectId,
        request.worktreeId,
      );
      const next: CodeReviewFile = {
        ...file,
        commentThreads: mergeReviewThreads(
          file.commentThreads,
          request.commentThreads,
          request.baseCommentThreadIds,
          request.baseCommentThreads,
        ),
      };
      await writeFileState(
        request.projectId,
        request.worktreeId,
        next,
        unreadable,
      );
      return next;
    }),
  );
}

export interface AppendReviewCommentReplyRequest {
  projectId: string;
  worktreeId: string;
  threadId: string;
  body: string;
  resolve?: boolean;
}

export interface AppendReviewCommentReplyResult {
  ok: boolean;
  review?: CodeReviewFile;
  error?: string;
}

export async function appendReviewCommentReply(
  request: AppendReviewCommentReplyRequest,
): Promise<AppendReviewCommentReplyResult> {
  const filePath = getCodeReviewStateFilePath(
    request.projectId,
    request.worktreeId,
  );
  return runCodeReviewMutation(request.projectId, request.worktreeId, () =>
    withFileLock(filePath, async () => {
      const { file, unreadable } = await readStoredState(
        request.projectId,
        request.worktreeId,
      );
      const thread = file.commentThreads.find(
        (entry) => entry.id === request.threadId,
      );
      if (!thread) {
        return { ok: false, error: 'Comment thread not found.' };
      }
      const reply: ReviewComment = {
        id: randomUUID(),
        author: 'agent',
        body: request.body,
        createdAt: new Date().toISOString(),
        staged: false,
      };
      const nextThread: ReviewCommentThread = {
        ...thread,
        comments: [...thread.comments, reply],
        ...(request.resolve === true ? { status: 'resolved' as const } : {}),
      };
      const next: CodeReviewFile = {
        ...file,
        commentThreads: file.commentThreads.map((entry) =>
          entry.id === request.threadId ? nextThread : entry,
        ),
      };
      await writeFileState(
        request.projectId,
        request.worktreeId,
        next,
        unreadable,
      );
      return { ok: true, review: next };
    }),
  );
}

export type ReadReviewCommentThreadResult =
  | { ok: false; error: string }
  | { ok: true; mode: 'single'; thread: ReviewCommentThread }
  | { ok: true; mode: 'all'; threads: ReviewCommentThread[] };

export async function readReviewCommentThread(request: {
  projectId: string;
  worktreeId: string;
  threadId?: string;
}): Promise<ReadReviewCommentThreadResult> {
  const file = await readFileState(request.projectId, request.worktreeId);
  if (request.threadId !== undefined) {
    const thread = file.commentThreads.find(
      (entry) => entry.id === request.threadId,
    );
    if (!thread) {
      return { ok: false, error: 'Comment thread not found.' };
    }
    return { ok: true, mode: 'single', thread };
  }
  return {
    ok: true,
    mode: 'all',
    threads: file.commentThreads.filter((entry) => entry.status === 'open'),
  };
}

function isAnnotationsArtifact(
  artifact: AnyCodeReviewArtifact,
): artifact is CodeReviewArtifact<ReviewAnnotationSet> {
  return artifact.data === null || isReviewAnnotationSet(artifact.data);
}

function isLogicDiffArtifact(
  artifact: AnyCodeReviewArtifact,
): artifact is CodeReviewArtifact<LogicDiffDiagram> {
  return artifact.data === null || isLogicDiffDiagram(artifact.data);
}

function isDataModelArtifact(
  artifact: AnyCodeReviewArtifact,
): artifact is CodeReviewArtifact<DataModelDiffDiagram> {
  return artifact.data === null || isDataModelDiffDiagram(artifact.data);
}

export async function setCodeReviewArtifact(
  projectId: string,
  worktreeId: string,
  key: 'annotations' | 'logicDiff' | 'dataModelDiff',
  artifact: AnyCodeReviewArtifact,
): Promise<CodeReviewFile | null> {
  const filePath = getCodeReviewStateFilePath(projectId, worktreeId);
  return runCodeReviewMutation(projectId, worktreeId, () =>
    withFileLock(filePath, async () => {
      const { file, unreadable } = await readStoredState(projectId, worktreeId);
      const next: CodeReviewFile = { ...file, diagrams: { ...file.diagrams } };
      if (key === 'annotations' && isAnnotationsArtifact(artifact)) {
        next.annotations = artifact;
      } else if (key === 'logicDiff' && isLogicDiffArtifact(artifact)) {
        next.diagrams.logicDiff = artifact;
      } else if (key === 'dataModelDiff' && isDataModelArtifact(artifact)) {
        next.diagrams.dataModelDiff = artifact;
      } else {
        return file;
      }
      await writeFileState(projectId, worktreeId, next, unreadable);
      return next;
    }),
  );
}

export async function removeCodeReviewDiagramArtifact(
  projectId: string,
  worktreeId: string,
  key: 'dataModelDiff',
  expectedFingerprint: string,
): Promise<CodeReviewFile | null> {
  const filePath = getCodeReviewStateFilePath(projectId, worktreeId);
  return runCodeReviewMutation(projectId, worktreeId, () =>
    withFileLock(filePath, async () => {
      const { file, unreadable } = await readStoredState(projectId, worktreeId);
      const existing = file.diagrams[key];
      if (!existing) {
        return file;
      }
      if (
        existing.derivedFromFingerprint !== expectedFingerprint &&
        existing.status !== 'generating'
      ) {
        return file;
      }
      const nextDiagrams = { ...file.diagrams };
      delete nextDiagrams[key];
      const next: CodeReviewFile = { ...file, diagrams: nextDiagrams };
      await writeFileState(projectId, worktreeId, next, unreadable);
      return next;
    }),
  );
}

export async function reevaluateReviewAnchors(
  projectId: string,
  worktreeId: string,
): Promise<CodeReviewFile | null> {
  const filePath = getCodeReviewStateFilePath(projectId, worktreeId);
  return runCodeReviewMutation(projectId, worktreeId, () =>
    withFileLock(filePath, async () => {
      const { file, unreadable } = await readStoredState(projectId, worktreeId);
      if (file.commentThreads.length === 0) {
        return file;
      }
      const contentCache = new Map<string, string | null>();
      const readWorkingTreeFile = async (
        repoId: string | undefined,
        relativePath: string,
      ): Promise<string | null> => {
        const cacheKey = `${repoId ?? ''}:${relativePath}`;
        const cached = contentCache.get(cacheKey);
        if (cached !== undefined) {
          return cached;
        }
        let content: string | null = null;
        try {
          // Code comments on single-repo reviews store the sentinel repoId
          // `'default'` (mirroring the review's `listReviewRepos`), but the
          // worktree checkout lives at the workspace root, not under
          // `repos/default/`. Passing `'default'` straight through would resolve
          // to a non-existent child-repo dir, the read would fail, and the
          // thread would be wrongly flipped to `outdated` on every re-eval (e.g.
          // after each diagram/annotation regeneration). Normalize it to the
          // worktree root.
          const resolveRepoId = repoId === 'default' ? undefined : repoId;
          const repoRoot = resolveWorktreeCwd(
            projectId,
            worktreeId,
            resolveRepoId,
          );
          const target = resolve(repoRoot, relativePath);
          // Reject absolute or escaping paths — a thread whose anchor points
          // outside the repo is treated as unreadable, i.e. outdated.
          if (isAbsolute(relativePath) || !isPathInside(repoRoot, target)) {
            content = null;
          } else {
            const info = await lstat(target);
            if (!info.isFile()) {
              content = null;
            } else {
              const [repoRealPath, targetRealPath] = await Promise.all([
                realpath(repoRoot),
                realpath(target),
              ]);
              content = isPathInside(repoRealPath, targetRealPath)
                ? await readFile(target, 'utf8')
                : null;
            }
          }
        } catch {
          content = null;
        }
        contentCache.set(cacheKey, content);
        return content;
      };
      const nextThreads: ReviewCommentThread[] = [];
      for (const thread of file.commentThreads) {
        const { anchor } = thread;
        if (
          anchor.source !== 'code' ||
          anchor.unanchored === true ||
          anchor.filePath === undefined
        ) {
          // Diagram-anchored and unanchored threads have no source passage to
          // match against, so they never go outdated (plan-explore behavior).
          nextThreads.push(
            thread.anchorState === 'matched'
              ? thread
              : { ...thread, anchorState: 'matched' },
          );
          continue;
        }
        if (anchor.side === 'old') {
          // Old-side anchors point at the comparison/base content, not the
          // working-tree file. Without the old blob here, checking the current
          // file would create false outdated states.
          nextThreads.push(
            thread.anchorState === 'matched'
              ? thread
              : { ...thread, anchorState: 'matched' },
          );
          continue;
        }
        const content = await readWorkingTreeFile(
          anchor.repoId,
          anchor.filePath,
        );
        const matched = content !== null && content.includes(anchor.quote);
        const nextState = matched ? 'matched' : 'outdated';
        nextThreads.push(
          thread.anchorState === nextState
            ? thread
            : { ...thread, anchorState: nextState },
        );
      }
      const next: CodeReviewFile = { ...file, commentThreads: nextThreads };
      await writeFileState(projectId, worktreeId, next, unreadable);
      return next;
    }),
  );
}
