import {
  CanopyOperationError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import { flushDirectory } from '@canopy/core-platform/directory-flush';
import {
  createAnnotationOperations,
  createFileAnnotationEngine,
  type AnnotationFileRoot,
  type AnnotationOperations,
} from '@canopy/core-runtime/node/annotations';
import {
  assertStorageWriteAllowed,
  STORAGE_OWNERSHIP,
} from '@canopy/core-runtime/storage';
import type {
  AnnotationScope,
  CanonicalFileAnnotationDocument,
  CanopyInstructionHandler,
  CanopyQueryHandler,
} from '@canopy/protocol/canopy-core';
import { getFileBrowserRoots } from '../lib/file-browser-roots';
import { getDataDir, getFileAnnotationsStateFilePath } from '../lib/paths';
import { isWritableScope } from '../lib/read-only-scope';
import { validateId } from '../lib/validation';

/*
 * Registers `core.annotation.*` on the desktop dispatcher (CAN-4104). The
 * portable engine in `@canopy/core-runtime/node/annotations` reads and writes each
 * worktree's file-annotations state file; this adapter is its only owner in
 * Electron main and resolves the state file with main's canonical path helper.
 * IPC handlers, agent tools and the renderer relay reach it only through the
 * dispatcher, and its instruction handlers publish `file-annotations:updated`
 * for each committed write.
 */

type AnnotationQueryName =
  | 'core.annotation.document.get'
  | 'core.annotation.thread.get'
  | 'core.annotation.thread.list';

type AnnotationInstructionName =
  | 'core.annotation.document.save'
  | 'core.annotation.document.append'
  | 'core.annotation.document.dismiss'
  | 'core.annotation.thread.reply';

export interface CoreAnnotationAdapter {
  queries: {
    [Name in AnnotationQueryName]: CanopyQueryHandler<
      Name,
      CanopyHandlerContext
    >;
  };
  instructions: {
    [Name in AnnotationInstructionName]: CanopyInstructionHandler<
      Name,
      CanopyHandlerContext
    >;
  };
}

/**
 * The scope as host storage sees it. The contract already refuses unsafe IDs;
 * this repeats the check so the state path, file roots and read-only check
 * never derive from an unvalidated ID, whichever binding dispatched the call.
 */
function hostScope(scope: AnnotationScope): AnnotationScope {
  try {
    validateId(scope.projectId, 'projectId');
    validateId(scope.worktreeId, 'worktreeId');
  } catch (error) {
    throw new CanopyOperationError(
      {
        kind: 'invalid_argument',
        message: 'Invalid annotation scope.',
        retry: { kind: 'never' },
      },
      error,
    );
  }
  return scope;
}

// One catalog read serves a call's projection in and out of the dispatcher.
const ROOTS_TTL_MS = 2_000;
const rootsCache = new Map<
  string,
  { expiresAt: number; roots: Promise<readonly AnnotationFileRoot[]> }
>();

async function readRoots(
  scope: AnnotationScope,
): Promise<readonly AnnotationFileRoot[]> {
  try {
    const { roots } = await getFileBrowserRoots(
      scope.projectId,
      scope.worktreeId,
    );
    return roots.map((root) => ({
      id: root.repoId,
      absolutePath: root.absolutePath,
    }));
  } catch {
    // A scope without file roots keeps its documents through host handles.
    return [];
  }
}

/** The scope's file roots with their host paths, briefly cached. */
export async function readAnnotationFileRoots(
  requested: AnnotationScope,
): Promise<readonly AnnotationFileRoot[]> {
  const scope = hostScope(requested);
  const key = JSON.stringify([scope.projectId, scope.worktreeId]);
  const now = Date.now();
  const cached = rootsCache.get(key);
  if (cached && cached.expiresAt > now) return cached.roots;
  const roots = readRoots(scope);
  rootsCache.set(key, { expiresAt: now + ROOTS_TTL_MS, roots });
  rootsCache.forEach((entry, entryKey) => {
    if (entry.expiresAt <= now) rootsCache.delete(entryKey);
  });
  return roots;
}

let desktopAnnotationOperations: AnnotationOperations | undefined;

/** The app's annotation operations; the engine touches storage per call. */
export function getDesktopAnnotationOperations(): AnnotationOperations {
  desktopAnnotationOperations ??= createAnnotationOperations({
    engine: createFileAnnotationEngine({
      statePath: (requested) => {
        const scope = hostScope(requested);
        return getFileAnnotationsStateFilePath(
          scope.projectId,
          scope.worktreeId,
        );
      },
      dataRoot: getDataDir,
      flushDirectory,
      // Refused once the daemon owns the store; reads stay open (CAN-4735).
      admitWrite: () =>
        assertStorageWriteAllowed(
          'file_annotations',
          'electron_main',
          STORAGE_OWNERSHIP,
        ),
    }),
    roots: readAnnotationFileRoots,
    // Shared-container recipient scopes stay read-only for every binding,
    // including the renderer relay, which bypasses the IPC projection.
    isWritable: (scope) => isWritableScope(hostScope(scope).projectId),
  });
  return desktopAnnotationOperations;
}

/** Announces a committed write; must not throw. */
export type AnnotationUpdatePublisher = (
  scope: AnnotationScope,
  document: CanonicalFileAnnotationDocument,
) => Promise<void>;

export interface CoreAnnotationAdapterOptions {
  operations?: AnnotationOperations | (() => AnnotationOperations);
  publish: AnnotationUpdatePublisher;
}

export function createCoreAnnotationAdapter({
  operations = getDesktopAnnotationOperations,
  publish,
}: CoreAnnotationAdapterOptions): CoreAnnotationAdapter {
  const resolve = (): AnnotationOperations =>
    typeof operations === 'function' ? operations() : operations;
  // The one publication point for every binding: a write is announced only
  // after the engine committed it, and a refused or failed write never is.
  const committed = async <
    Result extends { document: CanonicalFileAnnotationDocument },
  >(
    scope: AnnotationScope,
    write: Promise<Result>,
  ): Promise<Result> => {
    const result = await write;
    try {
      await publish(scope, result.document);
    } catch {
      // The write is durable; a failed announcement cannot undo it.
    }
    return result;
  };
  return {
    queries: {
      'core.annotation.document.get': (params) => resolve().getDocument(params),
      'core.annotation.thread.get': (params) => resolve().getThread(params),
      'core.annotation.thread.list': (params) => resolve().listThreads(params),
    },
    instructions: {
      'core.annotation.document.save': (params) =>
        committed(params.scope, resolve().saveDocument(params)),
      'core.annotation.document.append': (params) =>
        committed(params.scope, resolve().appendAnnotations(params)),
      'core.annotation.document.dismiss': (params) =>
        committed(params.scope, resolve().dismissAnnotation(params)),
      'core.annotation.thread.reply': (params) =>
        committed(params.scope, resolve().replyToThread(params)),
    },
  };
}
