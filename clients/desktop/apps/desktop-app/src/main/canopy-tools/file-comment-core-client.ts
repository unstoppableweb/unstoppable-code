import { CanopyOperationError } from '@canopy/core-runtime';
import {
  ANNOTATION_ERROR_CODES,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type {
  FileAnnotationDocument,
  ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { activeAgentCoreOperations } from './active-agent-core-operations';
import {
  annotationCaller,
  createHostAnnotationProjection,
  hostFilePath,
  toHostFileAnnotationDocument,
} from '../canopy-runtime/annotation-legacy-projection';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { READ_ONLY_SCOPE_ERROR } from '../lib/read-only-scope';
import { toStoredThread } from '@canopy/core-runtime/node/annotations';

/*
 * The agent comment tools' (GetFileComments / RespondToFileComment) client of
 * `core.annotation.*`. It keeps the tools' result shapes and host paths and
 * calls the desktop dispatcher as a trusted in-process host caller.
 */

type AnnotationDispatcher = Pick<
  DesktopCanopyDispatcher,
  'query' | 'instruction'
>;

const FILE_COMMENT_THREAD_NOT_FOUND = 'File comment thread not found.';

const FILE_COMMENT_TOOLS_CALLER: CanopyCallerDescriptor = {
  principalId: 'desktop-file-comment-tools',
  clientInstanceId: 'desktop-main',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [],
};

export interface RespondToFileCommentResult {
  ok: boolean;
  resolved: boolean;
  document?: FileAnnotationDocument;
  error?: string;
}

export type ReadFileCommentThreadsResult =
  | { ok: false; error: string }
  | {
      ok: true;
      mode: 'single';
      filePath: string;
      thread: ReviewCommentThread;
    }
  | {
      ok: true;
      mode: 'all';
      threads: Array<{ filePath: string; thread: ReviewCommentThread }>;
    };

function isNotFound(error: unknown): boolean {
  return (
    error instanceof CanopyOperationError && error.payload.kind === 'not_found'
  );
}

function isReadOnlyScope(error: unknown): boolean {
  return (
    error instanceof CanopyOperationError &&
    error.payload.code === ANNOTATION_ERROR_CODES.READ_ONLY_SCOPE
  );
}

// The reply was installed but its folder flush failed; a blind retry would
// post it twice.
const REPLY_OUTCOME_UNKNOWN =
  'The reply may already be saved. Reload the thread before trying again.';

function isOutcomeUnknown(error: unknown): boolean {
  return (
    error instanceof CanopyOperationError &&
    error.payload.code === ANNOTATION_ERROR_CODES.OUTCOME_UNKNOWN
  );
}

/** Thread ids the operations accept; any other id names no thread. */
function isOperationThreadId(threadId: string): boolean {
  return threadId.length > 0 && threadId.length <= 512;
}

export async function readFileCommentThreads(
  request: { projectId: string; worktreeId: string; threadId?: string },
  dispatcher: AnnotationDispatcher = activeAgentCoreOperations('annotation'),
): Promise<ReadFileCommentThreadsResult> {
  const scope = {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
  };
  const caller = annotationCaller(FILE_COMMENT_TOOLS_CALLER, 'read');
  const projection = await createHostAnnotationProjection(scope);
  if (request.threadId !== undefined) {
    if (!isOperationThreadId(request.threadId))
      return { ok: false, error: FILE_COMMENT_THREAD_NOT_FOUND };
    try {
      const entry = await dispatcher.query(
        'core.annotation.thread.get',
        { scope, threadId: request.threadId },
        { caller },
      );
      return {
        ok: true,
        mode: 'single',
        filePath: hostFilePath(entry.file, projection),
        thread: toStoredThread(entry.thread, projection),
      };
    } catch (error) {
      if (isNotFound(error))
        return { ok: false, error: FILE_COMMENT_THREAD_NOT_FOUND };
      throw error;
    }
  }
  const { threads } = await dispatcher.query(
    'core.annotation.thread.list',
    { scope },
    { caller },
  );
  return {
    ok: true,
    mode: 'all',
    threads: threads.map((entry) => ({
      filePath: hostFilePath(entry.file, projection),
      thread: toStoredThread(entry.thread, projection),
    })),
  };
}

/** Posts an agent reply under the state file's lock, optionally resolving. */
export async function respondToFileComment(
  request: {
    projectId: string;
    worktreeId: string;
    threadId: string;
    body: string;
    resolve: boolean;
  },
  dispatcher: AnnotationDispatcher = activeAgentCoreOperations('annotation'),
): Promise<RespondToFileCommentResult> {
  const notFound: RespondToFileCommentResult = {
    ok: false,
    resolved: false,
    error: FILE_COMMENT_THREAD_NOT_FOUND,
  };
  if (!isOperationThreadId(request.threadId)) return notFound;
  const scope = {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
  };
  try {
    const projection = await createHostAnnotationProjection(scope);
    const result = await dispatcher.instruction(
      'core.annotation.thread.reply',
      {
        scope,
        threadId: request.threadId,
        body: request.body,
        resolve: request.resolve,
      },
      { caller: annotationCaller(FILE_COMMENT_TOOLS_CALLER, 'write') },
    );
    return {
      ok: true,
      resolved: result.resolved,
      document: toHostFileAnnotationDocument(result.document, projection),
    };
  } catch (error) {
    if (isNotFound(error)) return notFound;
    if (isReadOnlyScope(error))
      return { ok: false, resolved: false, error: READ_ONLY_SCOPE_ERROR };
    if (isOutcomeUnknown(error))
      return { ok: false, resolved: false, error: REPLY_OUTCOME_UNKNOWN };
    throw error;
  }
}
