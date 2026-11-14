import { FileSaveConflictError } from '@canopy/app-core';
import { CoreCoworkRequestError } from '@canopy/app-state/core-cowork';
import {
  languageForPath,
  type ScopedFileOperations,
} from '@canopy/ipc-canopy-client';
import {
  WORKER_FILESYSTEM_FILE_READ_MAX_BYTES,
  WorkerFilesystemFileReadResultSchema,
  WorkerFilesystemFileWriteResultSchema,
  WorkerFilesystemLinkResolveResultSchema,
  WorkerFilesystemRootsListResultSchema,
} from '@canopy/protocol/canopy-core';
import type { CanopyCoreRelayApi } from '../../../../shared/canopy-core-relay';
import { webCoreFilePath } from '../chat-authority';
import { chatIdOf, requestWebCore } from './web-core-file-source';
import {
  cloudDeliverableName,
  deliverableLinkPath,
  isSandboxSleeping,
  ambiguousDeliverable,
  readSavedDeliverable,
  savedDeliverable,
} from './saved-deliverables';

/** Whether `error` is the web core saying the sandbox is asleep. */
function sandboxSleeping(error: unknown): boolean {
  return (
    error instanceof CoreCoworkRequestError &&
    isSandboxSleeping(error.payload.details)
  );
}

/**
 * The shared viewer's file operations for a cloud chat (CAN-6175 D2): the
 * same `file.read`, `file.resolveLink`, `file.roots` and `file.save` shapes
 * the IPC client answers, against the chat's sandbox over the web core relay.
 */
export function createWebCoreFileOperations(
  relay: CanopyCoreRelayApi,
  newIdempotencyKey: () => string = () => crypto.randomUUID(),
): ScopedFileOperations {
  return {
    'file.roots': async (args) => {
      const chatId = chatIdOf(args.worktreeId);
      const listed = await requestWebCore(
        relay,
        'worker.filesystem.roots.list',
        { scope: { chatId } },
        WorkerFilesystemRootsListResultSchema,
      );
      return listed.roots.map((root) => ({
        workspaceLocalId: args.projectId,
        worktreeLocalId: args.worktreeId,
        fileRootLocalId: root.fileRootId,
        label: root.name,
        rootKind: root.kind,
        absolutePath: webCoreFilePath({
          chatId,
          fileRootId: root.fileRootId,
          relativePath: '',
        }),
      }));
    },

    'file.read': async (args) => {
      const fileRootId = args.fileRootLocalId ?? args.repoId;
      if (fileRootId === undefined)
        throw new Error('A cloud file read names its file root.');
      const chatId = chatIdOf(args.worktreeId);
      const read = await requestWebCore(
        relay,
        'worker.filesystem.file.read',
        {
          scope: { chatId },
          fileRootId,
          relativePath: args.relativePath,
          maxBytes: WORKER_FILESYSTEM_FILE_READ_MAX_BYTES,
        },
        WorkerFilesystemFileReadResultSchema,
      ).catch(async (error: unknown) => {
        // A sleeping sandbox's deliverable reads from its saved copy.
        const saved = sandboxSleeping(error)
          ? await readSavedDeliverable(
              relay,
              { chatId, fileRootId, relativePath: args.relativePath },
              { projectId: args.projectId, worktreeId: args.worktreeId },
            )
          : null;
        if (saved === null) throw error;
        return saved;
      });
      if (read.contentKind === 'image' || read.contentKind === 'unsupported')
        throw new Error('Binary files cannot be read.');
      return {
        workspaceLocalId: args.projectId,
        worktreeLocalId: args.worktreeId,
        fileRootLocalId: read.fileRootId,
        path: args.relativePath,
        content: read.content,
        language: languageForPath(args.relativePath),
        size: read.sizeBytes,
        version: read.version,
        truncated: read.truncated,
        modifiedAt: read.modifiedAt,
      };
    },

    // A replacement needs the version the viewer read; without one the save
    // is a conflict, so the viewer re-reads rather than overwrite blind.
    'file.save': async (args) => {
      const fileRootId = args.fileRootLocalId ?? args.repoId;
      if (fileRootId === undefined)
        throw new Error('A cloud file save names its file root.');
      if (args.expectedVersion === undefined) throw new FileSaveConflictError();
      let written;
      try {
        written = await requestWebCore(
          relay,
          'worker.filesystem.file.write',
          {
            scope: { chatId: chatIdOf(args.worktreeId) },
            fileRootId,
            relativePath: args.relativePath,
            content: args.content,
            createOnly: false,
            expectedVersion: args.expectedVersion,
            _meta: { idempotencyKey: newIdempotencyKey() },
          },
          WorkerFilesystemFileWriteResultSchema,
        );
      } catch (error) {
        if (
          error instanceof CoreCoworkRequestError &&
          error.payload.code === 'worker.filesystem.file.revisionConflict'
        )
          throw new FileSaveConflictError(error.payload.message);
        throw error;
      }
      return {
        workspaceLocalId: args.projectId,
        worktreeLocalId: args.worktreeId,
        fileRootLocalId: fileRootId,
        path: args.relativePath,
        content: args.content,
        language: languageForPath(args.relativePath),
        size: written.sizeBytes,
        version: written.version,
        truncated: false,
        modifiedAt: written.modifiedAt,
      };
    },

    // Transcript mode only: the web core serves no markdown-relative links.
    'file.resolveLink': async (args) => {
      const chatId = chatIdOf(args.worktreeId);
      let resolved;
      try {
        resolved = await requestWebCore(
          relay,
          'worker.filesystem.link.resolve',
          { scope: { chatId }, mode: 'transcript', href: args.href },
          WorkerFilesystemLinkResolveResultSchema,
        );
      } catch (error) {
        if (!sandboxSleeping(error)) throw error;
        // While the sandbox sleeps, a link to one of the chat's saved
        // deliverables resolves under the workspace's root, so its saved
        // copy can open. Anything else stays the sandbox's refusal.
        const relativePath = deliverableLinkPath(args.href);
        const name =
          relativePath === null ? null : cloudDeliverableName(relativePath);
        if (relativePath === null || name === null) throw error;
        const saved = await savedDeliverable(relay, chatId, name, {
          projectId: args.projectId,
          worktreeId: args.worktreeId,
        });
        // Never one of several chats' copies: say which name is shared.
        if (saved === 'ambiguous') throw ambiguousDeliverable(name, 'open');
        if (saved === null) throw error;
        const listed = await requestWebCore(
          relay,
          'worker.filesystem.roots.list',
          { scope: { chatId } },
          WorkerFilesystemRootsListResultSchema,
        );
        // A root with no mount path is the workspace, untranslated.
        const workspace = listed.roots.find(
          (root) => (root.mountPath ?? '') === '',
        );
        if (workspace === undefined) throw error;
        return { fileRootLocalId: workspace.fileRootId, relativePath };
      }
      return resolved.kind === 'file'
        ? {
            fileRootLocalId: resolved.fileRootId,
            relativePath: resolved.relativePath,
          }
        : null;
    },
  };
}
