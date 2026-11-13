import {
  languageForPath,
  type ScopedFileQueries,
} from '@canopy/ipc-canopy-client';
import {
  WORKER_FILESYSTEM_FILE_READ_MAX_BYTES,
  WorkerFilesystemFileReadResultSchema,
  WorkerFilesystemLinkResolveResultSchema,
  WorkerFilesystemRootsListResultSchema,
} from '@canopy/protocol/canopy-core';
import type { CanopyCoreRelayApi } from '../../../../shared/canopy-core-relay';
import { webCoreFilePath } from '../chat-authority';
import { chatIdOf, requestWebCore } from './web-core-file-source';

/**
 * The shared viewer's file queries for a cloud chat (CAN-6175 D2): the same
 * `file.read`, `file.resolveLink` and `file.roots` shapes the IPC client
 * answers, read from the chat's sandbox over the web core relay.
 */
export function createWebCoreFileQueries(
  relay: CanopyCoreRelayApi,
): ScopedFileQueries {
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
      const read = await requestWebCore(
        relay,
        'worker.filesystem.file.read',
        {
          scope: { chatId: chatIdOf(args.worktreeId) },
          fileRootId,
          relativePath: args.relativePath,
          maxBytes: WORKER_FILESYSTEM_FILE_READ_MAX_BYTES,
        },
        WorkerFilesystemFileReadResultSchema,
      );
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

    // Transcript mode only: the web core serves no markdown-relative links.
    'file.resolveLink': async (args) => {
      const resolved = await requestWebCore(
        relay,
        'worker.filesystem.link.resolve',
        {
          scope: { chatId: chatIdOf(args.worktreeId) },
          mode: 'transcript',
          href: args.href,
        },
        WorkerFilesystemLinkResolveResultSchema,
      );
      return resolved.kind === 'file'
        ? {
            fileRootLocalId: resolved.fileRootId,
            relativePath: resolved.relativePath,
          }
        : null;
    },
  };
}
