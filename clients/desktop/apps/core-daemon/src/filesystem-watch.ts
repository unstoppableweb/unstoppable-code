import { watch } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  allocateAttachmentsRootId,
  createFilesystemWatchRegistry,
  createWorkerFilesystemWatchHandler,
  filesystemWatchError,
  readFilesystemScope,
  type FilesystemNativeWatch,
  type FilesystemScopeResolver,
  type FilesystemWatchDiagnostic,
  type FilesystemWatchResolutionPort,
  type FilesystemWatchTarget,
  type FilesystemWatchUnavailablePolicy,
  type WorkerFilesystemWatchHandler,
  type WorkerFilesystemWatchHandlerOptions,
} from '@canopy/core-runtime/node';
import { parseGitDirectoryFile } from '@canopy/core-runtime/node/git';

export interface DaemonFilesystemWatchOptions {
  readonly watch?: FilesystemNativeWatch;
  readonly lstat?: (path: string) => Promise<unknown>;
  readonly unavailable?: FilesystemWatchUnavailablePolicy;
  readonly onDiagnostic?: (diagnostic: FilesystemWatchDiagnostic) => void;
  readonly onAttached?: WorkerFilesystemWatchHandlerOptions['onAttached'];
}

const UNAVAILABLE: FilesystemWatchUnavailablePolicy = {
  matches: (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ['ENOSPC', 'EMFILE', 'ENFILE', 'EACCES', 'EPERM'].includes(
      String(error.code),
    ),
  // No native UI in the daemon; CAN-5892 records the missing session warning.
  report: (error): void => {
    process.stderr.write(
      `${JSON.stringify({ level: 'warn', message: 'Filesystem watch unavailable', error: String(error) })}\n`,
    );
  },
};

async function headPath(checkout: string): Promise<string> {
  const dotGit = join(checkout, '.git');
  const metadata = await lstat(dotGit);
  const gitDir = metadata.isDirectory()
    ? dotGit
    : metadata.isFile()
      ? parseGitDirectoryFile(await readFile(dotGit, 'utf8'), checkout)
      : null;
  if (!gitDir) throw filesystemWatchError('invalidState');
  const head = join(gitDir, 'HEAD');
  await readFile(head, 'utf8');
  return head;
}

/** Trusted catalogs and directory entries, never caller-supplied host paths. */
export function createDaemonFilesystemWatchPort(
  resolveScope: FilesystemScopeResolver,
): FilesystemWatchResolutionPort {
  return {
    resolveWatchTarget: async (request): Promise<FilesystemWatchTarget> => {
      const catalog = await readFilesystemScope(
        request.scope,
        await resolveScope(request.scope, 'roots'),
      );
      const visible = catalog.byId.get(request.fileRootId);
      const hiddenAttachments =
        !catalog.attachmentSource.visible &&
        request.fileRootId ===
          allocateAttachmentsRootId(new Set(catalog.byId.keys()))
          ? catalog.attachmentSource.absolutePath
          : undefined;
      const rootPath = visible?.absolutePath ?? hiddenAttachments;
      if (request.subject === 'gitHead') {
        const workspace = catalog.roots.find(
          (root) => root.kind === 'workspace-root',
        );
        let checkout =
          visible?.gitAware || visible?.kind === 'workspace-root'
            ? visible.absolutePath
            : undefined;
        // Preserve the branch observer's unlisted repos/ checkouts, including
        // names colliding with the attachments root, without joining an input id.
        if (!checkout && workspace) {
          const repos = join(workspace.absolutePath, 'repos');
          const entries = await readdir(repos, { withFileTypes: true }).catch(
            () => [],
          );
          const entry = entries.find(
            (entry) => entry.name === request.fileRootId && entry.isDirectory(),
          );
          if (entry) checkout = join(repos, entry.name);
        }
        if (checkout) {
          try {
            return { kind: 'gitHead', headPath: await headPath(checkout) };
          } catch (error) {
            throw filesystemWatchError(
              rootPath === undefined ? 'notFound' : 'invalidState',
              undefined,
              error,
            );
          }
        }
        throw filesystemWatchError(
          rootPath === undefined ? 'notFound' : 'invalidState',
        );
      }
      if (rootPath === undefined) throw filesystemWatchError('notFound');
      return {
        kind: 'tree',
        rootPath,
        rootMayBeAbsent:
          hiddenAttachments !== undefined || visible?.kind === 'attachments',
        scopePaths: [
          ...catalog.roots.map((root) => ({
            path: root.absolutePath,
            mayBeAbsent: root.kind === 'attachments',
          })),
          { path: catalog.attachmentSource.absolutePath, mayBeAbsent: true },
        ],
      };
    },
  };
}

/** One shared native backend for every watch served by this worker. */
export function createDaemonFilesystemWatch(
  resolveScope: FilesystemScopeResolver,
  options: DaemonFilesystemWatchOptions = {},
): WorkerFilesystemWatchHandler {
  const registry = createFilesystemWatchRegistry({
    watch:
      options.watch ??
      ((path, options, listener): ReturnType<FilesystemNativeWatch> =>
        watch(path, options, listener)),
    lstat: options.lstat ?? lstat,
    unavailable: options.unavailable ?? UNAVAILABLE,
    ...(options.onDiagnostic && { onDiagnostic: options.onDiagnostic }),
  });
  return createWorkerFilesystemWatchHandler({
    registry,
    port: createDaemonFilesystemWatchPort(resolveScope),
    ...(options.onAttached && { onAttached: options.onAttached }),
  });
}
