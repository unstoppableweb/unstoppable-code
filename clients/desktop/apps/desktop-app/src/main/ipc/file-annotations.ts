import { normalize } from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { CanopyOperationError } from '@canopy/core-runtime';
import { normalizeFileAnnotationDocument } from '@canopy/core-runtime/node/annotations';
import {
  IPC_CHANNELS,
  type FileAnnotationDocument,
  type FileAnnotationsAppendRequest,
  type FileAnnotationsDismissRequest,
  type FileAnnotationsGetRequest,
  type FileAnnotationsSaveAnswer,
  type FileAnnotationsSaveRequest,
} from '@canopy/desktop-shared/types';
import { ANNOTATION_ERROR_CODES } from '@canopy/protocol/canopy-core';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import {
  annotationCaller,
  createHostAnnotationProjection,
  portableAnnotations,
  portableCommentThreads,
  toHostFileAnnotationDocument,
} from '../canopy-runtime/annotation-legacy-projection';
import { withFileAnnotationsUpdateWindows } from '../canopy-runtime/annotation-update-publisher';
import { validateId } from '../lib/validation';
import { assertWritableScope } from '../lib/read-only-scope';
import type { DesktopIpcCallerResolver } from './file-tree';
import { registerIpcHandler } from './register';

/*
 * `file-annotations:*` compatibility handlers: host-path projections of the
 * `core.annotation.*` operations on the desktop dispatcher. Each handler keeps
 * its existing input checks and errors and calls with only the grant its
 * operation needs. The core.annotation adapter publishes each committed write
 * to the windows these handlers serve.
 */

type AnnotationDispatcher = Pick<
  DesktopCanopyDispatcher,
  'query' | 'instruction'
>;
type CanopyCaller = ReturnType<DesktopIpcCallerResolver>;

function validateScope(request: { projectId: string; worktreeId: string }): {
  projectId: string;
  worktreeId: string;
} {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  return { projectId: request.projectId, worktreeId: request.worktreeId };
}

/** The renderer's base revision; a malformed one is refused, not ignored. */
function expectedRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    return value;
  throw new Error('Invalid expectedRevision');
}

/** A write that was installed but whose folder flush failed after. */
function isOutcomeUnknown(error: unknown): boolean {
  return (
    error instanceof CanopyOperationError &&
    error.payload.code === ANNOTATION_ERROR_CODES.OUTCOME_UNKNOWN
  );
}

function threadIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export async function getFileAnnotationsForIpc(
  dispatcher: AnnotationDispatcher,
  caller: CanopyCaller,
  request: FileAnnotationsGetRequest,
): Promise<FileAnnotationDocument> {
  const scope = validateScope(request);
  const projection = await createHostAnnotationProjection(scope);
  const { document } = await dispatcher.query(
    'core.annotation.document.get',
    { scope, file: projection.fileRef(normalize(request.filePath)) },
    { caller: annotationCaller(caller, 'read') },
  );
  return toHostFileAnnotationDocument(document, projection);
}

export async function saveFileAnnotationsForIpc(
  dispatcher: AnnotationDispatcher,
  caller: CanopyCaller,
  request: FileAnnotationsSaveRequest,
): Promise<FileAnnotationsSaveAnswer> {
  const scope = validateScope(request);
  assertWritableScope(scope.projectId);
  const revision = expectedRevision(request.expectedRevision);
  const incoming = normalizeFileAnnotationDocument(request.document);
  if (!incoming) {
    throw new Error('Invalid file annotation document.');
  }
  const projection = await createHostAnnotationProjection(scope);
  const saving = dispatcher.instruction(
    'core.annotation.document.save',
    {
      scope,
      document: {
        file: projection.fileRef(incoming.filePath),
        annotations: portableAnnotations(incoming.annotations, projection),
        commentThreads: portableCommentThreads(
          incoming.commentThreads,
          projection,
        ),
      },
      baseCommentThreadIds: threadIds(request.baseCommentThreadIds),
      ...(revision !== undefined ? { expectedRevision: revision } : {}),
    },
    { caller: annotationCaller(caller, 'write') },
  );
  try {
    const { document } = await saving;
    return toHostFileAnnotationDocument(document, projection);
  } catch (error) {
    if (!isOutcomeUnknown(error)) throw error;
    // Answered as data, which neither preload's error cache nor Remote
    // Control can drop: the save is installed but its flush failed.
    const stored = await dispatcher
      .query(
        'core.annotation.document.get',
        { scope, file: projection.fileRef(incoming.filePath) },
        { caller: annotationCaller(caller, 'read') },
      )
      .catch(() => undefined);
    // Unreadable too: answer what was sent at the revision it was based on, so
    // the hook retires the edit and its next save's revision check is refused
    // and re-reads, instead of replaying the edit over a newer write.
    return {
      ...(stored
        ? toHostFileAnnotationDocument(stored.document, projection)
        : { ...request.document, revision: revision ?? 0 }),
      outcome: 'unknown',
    };
  }
}

export async function appendFileAnnotationsForIpc(
  dispatcher: AnnotationDispatcher,
  caller: CanopyCaller,
  request: FileAnnotationsAppendRequest,
): Promise<FileAnnotationDocument> {
  const scope = validateScope(request);
  assertWritableScope(scope.projectId);
  const filePath: unknown = request.filePath;
  if (typeof filePath !== 'string') {
    throw new Error('Invalid file annotation append request.');
  }
  const projection = await createHostAnnotationProjection(scope);
  const appending = dispatcher.instruction(
    'core.annotation.document.append',
    {
      scope,
      file: projection.fileRef(normalize(filePath)),
      annotations: portableAnnotations(request.annotations, projection),
      commentThreads: portableCommentThreads(
        request.commentThreads,
        projection,
      ),
    },
    { caller: annotationCaller(caller, 'write') },
  );
  try {
    const { document } = await appending;
    return toHostFileAnnotationDocument(document, projection);
  } catch (error) {
    if (!isOutcomeUnknown(error)) throw error;
    // Installed but not flushed: answer the stored document, so the caller
    // reports it applied and has no reason to retry it with fresh ids.
    // shortcut: if this re-read fails too it rejects as before, and a retry
    // can duplicate; see CAN-7920.
    const stored = await dispatcher
      .query(
        'core.annotation.document.get',
        { scope, file: projection.fileRef(normalize(filePath)) },
        { caller: annotationCaller(caller, 'read') },
      )
      .catch(() => {
        throw error;
      });
    return toHostFileAnnotationDocument(stored.document, projection);
  }
}

export async function dismissFileAnnotationForIpc(
  dispatcher: AnnotationDispatcher,
  caller: CanopyCaller,
  request: FileAnnotationsDismissRequest,
): Promise<FileAnnotationDocument> {
  const scope = validateScope(request);
  assertWritableScope(scope.projectId);
  validateId(request.annotationId, 'annotationId');
  const projection = await createHostAnnotationProjection(scope);
  const { document } = await dispatcher.instruction(
    'core.annotation.document.dismiss',
    {
      scope,
      file: projection.fileRef(normalize(request.filePath)),
      annotationId: request.annotationId,
    },
    { caller: annotationCaller(caller, 'write') },
  );
  return toHostFileAnnotationDocument(document, projection);
}

export function registerFileAnnotationsHandlers(
  getWindows: () => Array<BrowserWindow | null>,
  dispatcher: AnnotationDispatcher,
  resolveCaller: DesktopIpcCallerResolver,
): void {
  registerIpcHandler<[FileAnnotationsGetRequest], FileAnnotationDocument>(
    IPC_CHANNELS.fileAnnotationsGet,
    (event: IpcMainInvokeEvent, request) =>
      getFileAnnotationsForIpc(dispatcher, resolveCaller(event), request),
  );

  registerIpcHandler<[FileAnnotationsSaveRequest], FileAnnotationsSaveAnswer>(
    IPC_CHANNELS.fileAnnotationsSave,
    (event: IpcMainInvokeEvent, request) =>
      withFileAnnotationsUpdateWindows(getWindows, () =>
        saveFileAnnotationsForIpc(dispatcher, resolveCaller(event), request),
      ),
  );

  registerIpcHandler<[FileAnnotationsAppendRequest], FileAnnotationDocument>(
    IPC_CHANNELS.fileAnnotationsAppend,
    (event: IpcMainInvokeEvent, request) =>
      withFileAnnotationsUpdateWindows(getWindows, () =>
        appendFileAnnotationsForIpc(dispatcher, resolveCaller(event), request),
      ),
  );

  registerIpcHandler<[FileAnnotationsDismissRequest], FileAnnotationDocument>(
    IPC_CHANNELS.fileAnnotationsDismiss,
    (event: IpcMainInvokeEvent, request) =>
      withFileAnnotationsUpdateWindows(getWindows, () =>
        dismissFileAnnotationForIpc(dispatcher, resolveCaller(event), request),
      ),
  );
}
