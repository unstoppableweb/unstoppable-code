import { createHash, randomUUID } from 'node:crypto';
import { normalize } from 'node:path';
import {
  ANNOTATION_DOCUMENT_RESOURCE,
  ANNOTATION_ERROR_CODES,
  type AnnotationScope,
  type StoredAnnotationCommentThread,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import { isStorageOutcomeUnknownError } from '../../storage/outcome-unknown';
import {
  emptyFileAnnotationDocument,
  normalizeFileAnnotationDocument,
  parseFileAnnotationsState,
  readFileAnnotationsState,
  serializeFileAnnotationsState,
  validAnnotationCommentThreads,
  validFileAnnotations,
  type FileAnnotationsStateV1,
  type StoredFileAnnotationDocument,
} from './document';
import {
  keepDamagedAnnotationStateCopy,
  type AnnotationFolderFlush,
  readAnnotationStateBytes,
  readAnnotationStateText,
  withAnnotationStateLock,
  writeAnnotationStateText,
} from './state-file';

/*
 * The file-annotations engine: reads, merges and writes one worktree's v1
 * state file in host-path space. Every write runs under the state file's lock
 * and advances the written document's revision; a supplied expected revision
 * is a compare-and-swap precondition checked under that lock.
 */

export interface FileAnnotationEngineOptions {
  /** The scope's state file, resolved by the host's canonical path helper. */
  statePath(this: void, scope: AnnotationScope): string;
  /** The data root holding that file; a write makes its folders durable up to it. */
  dataRoot(this: void): string;
  /**
   * The host's folder flush (default: POSIX `fsync`). A Windows host must pass
   * one; the desktop passes core-platform's `flushDirectory`.
   */
  flushDirectory?: AnnotationFolderFlush;
  /**
   * Admits a write before the state file is read for it, copied or replaced;
   * throws to refuse. The desktop host checks storage ownership here (CAN-4735).
   */
  admitWrite?(this: void, scope: AnnotationScope): void;
  now?(this: void): Date;
  randomId?(this: void): string;
}

export interface StoredFileAnnotationThreadEntry {
  filePath: string;
  revision: number;
  thread: StoredAnnotationCommentThread;
}

export interface FileAnnotationSaveInput {
  scope: AnnotationScope;
  document: unknown;
  baseCommentThreadIds: readonly string[];
  expectedRevision?: number;
}

export interface FileAnnotationAppendInput {
  scope: AnnotationScope;
  filePath: unknown;
  annotations: unknown;
  commentThreads: unknown;
  expectedRevision?: number;
}

export interface FileAnnotationDismissInput {
  scope: AnnotationScope;
  filePath: string;
  annotationId: string;
  expectedRevision?: number;
}

export interface FileAnnotationReplyInput {
  scope: AnnotationScope;
  threadId: string;
  body: string;
  resolve: boolean;
  expectedRevision?: number;
}

export interface FileAnnotationEngine {
  readDocument(
    scope: AnnotationScope,
    filePath: string,
  ): Promise<StoredFileAnnotationDocument>;
  saveDocument(
    input: FileAnnotationSaveInput,
  ): Promise<StoredFileAnnotationDocument>;
  appendAnnotations(
    input: FileAnnotationAppendInput,
  ): Promise<StoredFileAnnotationDocument>;
  dismissAnnotation(
    input: FileAnnotationDismissInput,
  ): Promise<StoredFileAnnotationDocument>;
  replyToThread(
    input: FileAnnotationReplyInput,
  ): Promise<{ document: StoredFileAnnotationDocument; resolved: boolean }>;
  /** A thread the agent may read: a plain comment, or one with feedback. */
  readThread(
    scope: AnnotationScope,
    threadId: string,
  ): Promise<StoredFileAnnotationThreadEntry>;
  /** Every open thread the agent may read, in state order. */
  listOpenThreads(
    scope: AnnotationScope,
  ): Promise<StoredFileAnnotationThreadEntry[]>;
}

export const FILE_COMMENT_THREAD_NOT_FOUND = 'File comment thread not found.';

export function fileAnnotationNotFoundError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    code: ANNOTATION_ERROR_CODES.NOT_FOUND,
    message: FILE_COMMENT_THREAD_NOT_FOUND,
    details: { reason: 'NOT_FOUND' },
    retry: { kind: 'never' },
  });
}

function revisionConflictError(currentRevision: number): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'conflict',
    code: ANNOTATION_ERROR_CODES.REVISION_CONFLICT,
    message: 'The file annotations changed. Refresh them and try again.',
    details: { reason: 'REVISION_CONFLICT', currentRevision },
    retry: { kind: 'after_refresh', resource: ANNOTATION_DOCUMENT_RESOURCE },
  });
}

function damagedStateError(cause: unknown): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'failed_precondition',
      code: ANNOTATION_ERROR_CODES.DAMAGED_STATE,
      message:
        "This worktree's file comments could not be read, so they were left unchanged.",
      details: { reason: 'DAMAGED_STATE' },
      retry: { kind: 'never' },
    },
    cause,
  );
}

/** The write was installed but not made durable: not acknowledged (CAN-4735). */
function outcomeUnknownError(cause: unknown): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'internal',
      code: ANNOTATION_ERROR_CODES.OUTCOME_UNKNOWN,
      message:
        "This worktree's file comments may not have been saved. Reload them before trying again.",
      details: { reason: 'OUTCOME_UNKNOWN', effects: 'unknown' },
      retry: { kind: 'never' },
    },
    cause,
  );
}

function assertExpectedRevision(
  stored: StoredFileAnnotationDocument | undefined,
  expectedRevision: number | undefined,
): void {
  const current = stored?.revision ?? 0;
  if (expectedRevision !== undefined && expectedRevision !== current) {
    throw revisionConflictError(current);
  }
}

function findDocument(
  state: FileAnnotationsStateV1,
  filePath: string,
): StoredFileAnnotationDocument | undefined {
  const target = normalize(filePath);
  return state.files.find((entry) => entry.filePath === target);
}

function replaceDocument(
  state: FileAnnotationsStateV1,
  document: StoredFileAnnotationDocument,
): FileAnnotationsStateV1 {
  const existingIndex = state.files.findIndex(
    (entry) => entry.filePath === document.filePath,
  );
  if (existingIndex < 0) {
    return { ...state, files: [...state.files, document] };
  }
  const files = [...state.files];
  files[existingIndex] = document;
  return { ...state, files };
}

/**
 * Applies a renderer save over the stored threads. Agent comments the save
 * does not carry are kept (and keep a resolution they caused), and threads
 * that were not in the caller's base are concurrent additions it never saw.
 */
function mergeThreads(
  stored: readonly StoredAnnotationCommentThread[],
  incoming: readonly StoredAnnotationCommentThread[],
  baseCommentThreadIds: readonly string[],
): StoredAnnotationCommentThread[] {
  const storedById = new Map(stored.map((thread) => [thread.id, thread]));
  const incomingIds = new Set(incoming.map((thread) => thread.id));
  const baseIds = new Set(baseCommentThreadIds);
  const mergedIncoming = incoming.map((thread) => {
    const existing = storedById.get(thread.id);
    if (!existing) return thread;
    const incomingCommentIds = new Set(
      thread.comments.map((comment) => comment.id),
    );
    const preservedAgentComments = existing.comments.filter(
      (comment) =>
        comment.author === 'agent' && !incomingCommentIds.has(comment.id),
    );
    return {
      ...thread,
      status:
        existing.status === 'resolved' &&
        thread.status === 'open' &&
        preservedAgentComments.length > 0
          ? existing.status
          : thread.status,
      comments: [...thread.comments, ...preservedAgentComments],
    };
  });
  const concurrentThreads = stored.filter(
    (thread) => !incomingIds.has(thread.id) && !baseIds.has(thread.id),
  );
  return [...mergedIncoming, ...concurrentThreads];
}

function hasSubmittedUserComment(
  thread: StoredAnnotationCommentThread,
): boolean {
  return thread.comments.some(
    (comment) => comment.author === 'user' && comment.staged !== true,
  );
}

function canExposeToAgent(thread: StoredAnnotationCommentThread): boolean {
  return (
    thread.anchor.annotationId === undefined || hasSubmittedUserComment(thread)
  );
}

export function createFileAnnotationEngine(
  options: FileAnnotationEngineOptions,
): FileAnnotationEngine {
  const now = options.now ?? ((): Date => new Date());
  const randomId = options.randomId ?? ((): string => randomUUID());

  const readState = async (
    scope: AnnotationScope,
  ): Promise<FileAnnotationsStateV1> =>
    parseFileAnnotationsState(
      await readAnnotationStateText(options.statePath(scope)),
    );

  /** The digest of the bytes last copied aside, per state file. */
  const copiedBytes = new Map<string, string>();

  /**
   * Keeps one copy of bytes a write can't carry forward. A refused write
   * repeats until the file is repaired; one copy of the same bytes is enough.
   */
  const keepCopyOnce = async (
    statePath: string,
    bytes: Uint8Array,
  ): Promise<boolean> => {
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (copiedBytes.get(statePath) === digest) return true;
    if (
      !(await keepDamagedAnnotationStateCopy(
        statePath,
        bytes,
        options.dataRoot(),
        options.flushDirectory,
      ))
    )
      return false;
    copiedBytes.set(statePath, digest);
    return true;
  };

  /**
   * The state a write builds on. A state file that can't be read, isn't JSON
   * or was written by a newer version refuses the write, so the write never
   * replaces what it could not read; its bytes are kept in a copy once.
   *
   * A v1 file may still hold entries this version can't read. The write
   * goes ahead without them, as it always has, but only once a copy of the
   * file holds them.
   */
  const readForWrite = async (
    statePath: string,
  ): Promise<FileAnnotationsStateV1> => {
    let bytes: Buffer | null;
    try {
      bytes = await readAnnotationStateBytes(statePath);
    } catch (cause) {
      throw damagedStateError(cause);
    }
    if (bytes === null) {
      copiedBytes.delete(statePath);
      return { version: 1, files: [] };
    }
    const read = readFileAnnotationsState(bytes.toString('utf8'));
    if (read.kind === 'ok' && read.unreadableEntries === 0) {
      copiedBytes.delete(statePath);
      return read.state;
    }
    const copied = await keepCopyOnce(statePath, bytes);
    if (read.kind === 'damaged')
      throw damagedStateError(new Error('Unsupported file annotations state.'));
    if (!copied)
      throw damagedStateError(
        new Error('Unreadable file annotation entries could not be copied.'),
      );
    return read.state;
  };

  /** Runs one read-modify-write under the state file's lock. */
  const mutate = async <Result>(
    scope: AnnotationScope,
    change: (state: FileAnnotationsStateV1) => {
      document: StoredFileAnnotationDocument;
      result: Result;
    },
  ): Promise<Result> => {
    options.admitWrite?.(scope);
    const statePath = options.statePath(scope);
    return withAnnotationStateLock(statePath, async () => {
      const state = await readForWrite(statePath);
      const { document, result } = change(state);
      try {
        await writeAnnotationStateText(
          statePath,
          serializeFileAnnotationsState(replaceDocument(state, document)),
          options.dataRoot(),
          options.flushDirectory,
        );
      } catch (error) {
        throw isStorageOutcomeUnknownError(error)
          ? outcomeUnknownError(error)
          : error;
      }
      return result;
    });
  };

  return {
    async readDocument(scope, filePath): Promise<StoredFileAnnotationDocument> {
      const state = await readState(scope);
      return (
        findDocument(state, filePath) ?? emptyFileAnnotationDocument(filePath)
      );
    },

    saveDocument(input): Promise<StoredFileAnnotationDocument> {
      return mutate(input.scope, (state) => {
        const incoming = normalizeFileAnnotationDocument(input.document);
        if (!incoming) {
          throw new Error('Invalid file annotation document.');
        }
        const stored = findDocument(state, incoming.filePath);
        // A save without an expected revision (only pre-CAN-4104 remote
        // controllers send one) merges as before and can still undo another
        // caller's change. Revisit at the next REMOTE_PROTOCOL_VERSION bump or
        // a minimum-controller-version gate.
        assertExpectedRevision(stored, input.expectedRevision);
        const annotationById = new Map(
          (stored?.annotations ?? []).map((annotation) => [
            annotation.id,
            annotation,
          ]),
        );
        for (const annotation of incoming.annotations) {
          annotationById.set(annotation.id, annotation);
        }
        const document: StoredFileAnnotationDocument = {
          filePath: incoming.filePath,
          revision: (stored?.revision ?? 0) + 1,
          annotations: Array.from(annotationById.values()),
          commentThreads: mergeThreads(
            stored?.commentThreads ?? [],
            incoming.commentThreads,
            input.baseCommentThreadIds,
          ),
        };
        return { document, result: document };
      });
    },

    appendAnnotations(input): Promise<StoredFileAnnotationDocument> {
      return mutate(input.scope, (state) => {
        if (typeof input.filePath !== 'string') {
          throw new Error('Invalid file annotation append request.');
        }
        const filePath = normalize(input.filePath);
        const stored =
          findDocument(state, filePath) ??
          emptyFileAnnotationDocument(filePath);
        assertExpectedRevision(stored, input.expectedRevision);
        const annotationIds = new Set(
          stored.annotations.map((annotation) => annotation.id),
        );
        const threadIds = new Set(
          stored.commentThreads.map((thread) => thread.id),
        );
        const document: StoredFileAnnotationDocument = {
          ...stored,
          revision: stored.revision + 1,
          annotations: [
            ...stored.annotations,
            ...validFileAnnotations(input.annotations).filter(
              (annotation) => !annotationIds.has(annotation.id),
            ),
          ],
          commentThreads: [
            ...stored.commentThreads,
            ...validAnnotationCommentThreads(input.commentThreads).filter(
              (thread) => !threadIds.has(thread.id),
            ),
          ],
        };
        return { document, result: document };
      });
    },

    dismissAnnotation(input): Promise<StoredFileAnnotationDocument> {
      return mutate(input.scope, (state) => {
        const stored =
          findDocument(state, input.filePath) ??
          emptyFileAnnotationDocument(input.filePath);
        assertExpectedRevision(stored, input.expectedRevision);
        const document: StoredFileAnnotationDocument = {
          ...stored,
          revision: stored.revision + 1,
          annotations: stored.annotations.filter(
            (annotation) => annotation.id !== input.annotationId,
          ),
          // Clearing an agent highlight must not discard its discussion.
          // Detach any existing thread from the removed annotation so it
          // becomes a regular line-anchored file comment.
          commentThreads: stored.commentThreads.map((thread) =>
            thread.anchor.annotationId === input.annotationId
              ? {
                  ...thread,
                  anchor: { ...thread.anchor, annotationId: undefined },
                }
              : thread,
          ),
        };
        return { document, result: document };
      });
    },

    replyToThread(
      input,
    ): Promise<{ document: StoredFileAnnotationDocument; resolved: boolean }> {
      return mutate(input.scope, (state) => {
        const stored = state.files.find((entry) =>
          entry.commentThreads.some(
            (thread) =>
              thread.id === input.threadId && hasSubmittedUserComment(thread),
          ),
        );
        if (!stored) throw fileAnnotationNotFoundError();
        assertExpectedRevision(stored, input.expectedRevision);
        const reply = {
          id: randomId(),
          author: 'agent' as const,
          body: input.body,
          createdAt: now().toISOString(),
          staged: false,
        };
        const document: StoredFileAnnotationDocument = {
          ...stored,
          revision: stored.revision + 1,
          commentThreads: stored.commentThreads.map((thread) =>
            thread.id === input.threadId
              ? {
                  ...thread,
                  status: input.resolve ? 'resolved' : thread.status,
                  comments: [...thread.comments, reply],
                }
              : thread,
          ),
        };
        return { document, result: { document, resolved: input.resolve } };
      });
    },

    async readThread(
      scope,
      threadId,
    ): Promise<StoredFileAnnotationThreadEntry> {
      const state = await readState(scope);
      for (const document of state.files) {
        const thread = document.commentThreads.find(
          (entry) => entry.id === threadId && canExposeToAgent(entry),
        );
        if (thread) {
          return {
            filePath: document.filePath,
            revision: document.revision,
            thread,
          };
        }
      }
      throw fileAnnotationNotFoundError();
    },

    async listOpenThreads(scope): Promise<StoredFileAnnotationThreadEntry[]> {
      const state = await readState(scope);
      return state.files.flatMap((document) =>
        document.commentThreads
          .filter(
            (thread) => thread.status === 'open' && canExposeToAgent(thread),
          )
          .map((thread) => ({
            filePath: document.filePath,
            revision: document.revision,
            thread,
          })),
      );
    },
  };
}
