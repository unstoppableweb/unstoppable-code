import { CoreCoworkRequestError } from '@canopy/app-state/core-cowork';
import {
  missingFileContent,
  projectLegacyFileContent,
} from '@canopy/desktop-shared/file-content-projection';
import type {
  FileContentRequest,
  FileContentResponse,
  FileIndexRequest,
  FileIndexResponse,
  FileTreeDirectoryRequest,
  FileTreeDirectoryResponse,
  FileTreeRoot,
  FileTreeRootsRequest,
  FileTreeRootsResponse,
} from '@canopy/desktop-shared/types';
import {
  WORKER_FILESYSTEM_FILE_READ_MAX_BYTES,
  WORKER_FILESYSTEM_SEARCH_MAX_LIMIT,
  WorkerFilesystemDirectoryListResultSchema,
  WorkerFilesystemFileReadResultSchema,
  WorkerFilesystemRootsListResultSchema,
  WorkerFilesystemSearchResultSchema,
} from '@canopy/protocol/canopy-core';
import type { CanopyCoreRelayApi } from '../../../../shared/canopy-core-relay';
import {
  parseWebCoreFilePath,
  webCoreFilePath,
  webCoreLocalId,
} from '../chat-authority';
import type { WorkspaceFileSource } from './workspace-file-source';

export interface ResultSchema<Result> {
  safeParse(
    value: unknown,
  ): { success: true; data: Result } | { success: false };
}

/**
 * The explorer and viewer reads of a cloud chat's sandbox over the web core
 * relay (CAN-6175 D2, D4). Results take the desktop shapes; failures keep
 * their protocol payload, so a sleeping sandbox reaches the UI as itself.
 * Nothing here wakes a sandbox.
 */
export function createWebCoreFileSource(
  relay: CanopyCoreRelayApi,
): WorkspaceFileSource {
  const request = <Result>(
    method: string,
    params: Record<string, unknown>,
    schema: ResultSchema<Result>,
  ): Promise<Result> => requestWebCore(relay, method, params, schema);

  async function roots(chatId: string): Promise<FileTreeRoot[]> {
    const listed = await request(
      'worker.filesystem.roots.list',
      { scope: { chatId } },
      WorkerFilesystemRootsListResultSchema,
    );
    return listed.roots.map((root) => ({
      repoId: root.fileRootId,
      repoName: root.name,
      rootKind: root.kind,
      absolutePath: webCoreFilePath({
        chatId,
        fileRootId: root.fileRootId,
        relativePath: '',
      }),
    }));
  }

  return {
    getFileTreeRoots: async (
      args: FileTreeRootsRequest,
    ): Promise<FileTreeRootsResponse> => ({
      roots: await roots(chatIdOf(args.worktreeId)),
    }),

    getFileTreeDirectory: async (
      args: FileTreeDirectoryRequest,
    ): Promise<FileTreeDirectoryResponse> => {
      const chatId = chatIdOf(args.worktreeId);
      const listed = await request(
        'worker.filesystem.directory.list',
        {
          scope: { chatId },
          fileRootId: args.repoId,
          relativePath: args.relativeDir,
        },
        WorkerFilesystemDirectoryListResultSchema,
      );
      return {
        entries: listed.entries.map((entry) => ({
          name: entry.name,
          relativePath: entry.relativePath,
          kind: entry.kind,
          isIgnored: entry.isIgnored,
          isIndexExcluded: entry.isIndexExcluded,
          isSymlink: entry.isSymlink,
          hasChildren: entry.hasChildren,
          absolutePath: webCoreFilePath({
            chatId,
            fileRootId: args.repoId,
            relativePath: entry.relativePath,
          }),
        })),
      };
    },

    // One name-search page per root holds the desktop's 25,000-file per-root
    // cap, so the index never follows a cursor.
    getFileIndex: async (
      args: FileIndexRequest,
    ): Promise<FileIndexResponse> => {
      const chatId = chatIdOf(args.worktreeId);
      const repos = await Promise.all(
        (await roots(chatId)).map(async (root) => {
          const page = await request(
            'worker.filesystem.search',
            {
              scope: { chatId },
              fileRootId: root.repoId,
              query: '',
              mode: 'name',
              purpose: args.purpose ?? 'mentions',
              limit: WORKER_FILESYSTEM_SEARCH_MAX_LIMIT,
            },
            WorkerFilesystemSearchResultSchema,
          );
          return {
            ...root,
            files: page.matches
              .filter((match) => match.kind === 'file')
              .map((match) => ({
                relativePath: match.path,
                filename: match.name,
                isIgnored: match.isIgnored,
                absolutePath: webCoreFilePath({
                  chatId,
                  fileRootId: root.repoId,
                  relativePath: match.path,
                }),
              })),
            truncated: page.truncated,
          };
        }),
      );
      return { repos };
    },

    readFileContent: async (
      args: FileContentRequest,
    ): Promise<FileContentResponse> => {
      const location = parseWebCoreFilePath(args.absolutePath);
      if (location === null) throw notCloud('file path');
      const method = 'worker.filesystem.file.read';
      const reply = await relay.invoke({
        kind: 'request',
        method,
        params: {
          scope: { chatId: location.chatId },
          fileRootId: location.fileRootId,
          relativePath: location.relativePath,
          maxBytes: WORKER_FILESYSTEM_FILE_READ_MAX_BYTES,
        },
        authority: 'web-core',
      });
      if (!reply.ok) {
        if (reply.error.code === 'worker.filesystem.file.notFound')
          return missingFileContent(
            location.relativePath.split('/').pop() ?? '',
          );
        throw new CoreCoworkRequestError(reply.error);
      }
      const result = parseResult(
        method,
        reply.value,
        WorkerFilesystemFileReadResultSchema,
      );
      return projectLegacyFileContent({
        result,
        modifiedAtMs: Date.parse(result.modifiedAt),
      });
    },
  };
}

/** One web core request whose reply is parsed with the operation's result schema. */
export async function requestWebCore<Result>(
  relay: CanopyCoreRelayApi,
  method: string,
  params: Record<string, unknown>,
  schema: ResultSchema<Result>,
): Promise<Result> {
  const reply = await relay.invoke({
    kind: 'request',
    method,
    params,
    authority: 'web-core',
  });
  if (!reply.ok) throw new CoreCoworkRequestError(reply.error);
  return parseResult(method, reply.value, schema);
}

function parseResult<Result>(
  method: string,
  value: unknown,
  schema: ResultSchema<Result>,
): Result {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CoreCoworkRequestError({
    kind: 'internal',
    message: `The web core returned an invalid ${method} result.`,
    retry: { kind: 'never' },
  });
}

export function chatIdOf(worktreeId: string): string {
  const chatId = webCoreLocalId(worktreeId);
  if (chatId === null) throw notCloud('scope');
  return chatId;
}

function notCloud(what: string): CoreCoworkRequestError {
  return new CoreCoworkRequestError({
    kind: 'invalid_argument',
    message: `Not a cloud chat ${what}.`,
    retry: { kind: 'never' },
  });
}
