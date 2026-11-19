import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep, win32 } from 'node:path';
import type {
  HostPortalEditorFileMentionOption,
  RepoFileIndex,
} from '@canopy/desktop-shared/types';
import { getDesktopCanopyRuntime } from '../canopy-runtime/desktop-runtime-access';
import { PortalServiceError } from '../services/portal-service-error';
import { createPortalCaller } from './portal-caller';

export interface PortalFileReferenceScope {
  sessionId: string;
  projectId: string;
  worktreeId: string;
  canRead?: () => boolean;
}

function cannotSelect(): PortalServiceError {
  return new PortalServiceError(
    'invalid_target',
    'This selector is not in the authorized file catalog. Select the file again.',
  );
}

export async function selectPortalFileReference(input: {
  scope: PortalFileReferenceScope;
  repo: RepoFileIndex;
  relativePath: string;
  kind: 'file' | 'directory';
}): Promise<HostPortalEditorFileMentionOption> {
  const { scope, repo, relativePath, kind } = input;
  if (
    Buffer.byteLength(relativePath, 'utf8') >= 4096 ||
    Array.from(relativePath).some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127 ||
        character === '\\' ||
        character === ':',
    ) ||
    isAbsolute(relativePath) ||
    win32.isAbsolute(relativePath) ||
    (relativePath === ''
      ? kind !== 'directory'
      : relativePath
          .split('/')
          .some((part) => !part || part === '.' || part === '..'))
  ) {
    throw new PortalServiceError(
      'invalid_payload',
      'The selector path must be canonical and root-relative.',
    );
  }
  try {
    if (!scope.sessionId || scope.canRead?.() !== true) throw cannotSelect();
    const rootStats = await lstat(repo.absolutePath, { bigint: true });
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink())
      throw cannotSelect();
    const rootReal = await realpath(repo.absolutePath);
    const segments = relativePath ? relativePath.split('/') : [];
    const identities = new Map<string, string>([
      [repo.absolutePath, `${rootStats.dev}:${rootStats.ino}`],
    ]);
    for (let index = 0; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join('/');
      const child = segments.slice(0, index + 1).join('/');
      const expectedKind = index === segments.length - 1 ? kind : 'directory';
      if (scope.canRead?.() !== true) throw cannotSelect();
      const listing = await getDesktopCanopyRuntime().query(
        'worker.filesystem.directory.list',
        {
          scope: {
            workspaceId: scope.projectId,
            worktreeId: scope.worktreeId,
          },
          fileRootId: repo.repoId,
          relativePath: parent,
        },
        { caller: createPortalCaller(scope, ['worker.filesystem.read']) },
      );
      const matches = listing.entries.filter(
        (entry) =>
          entry.relativePath === child &&
          entry.kind === expectedKind &&
          !entry.isSymlink &&
          !entry.isIgnored &&
          !entry.isIndexExcluded,
      );
      if (matches.length !== 1) throw cannotSelect();
      const path = join(repo.absolutePath, child);
      const stats = await lstat(path, { bigint: true });
      if (
        stats.isSymbolicLink() ||
        (expectedKind === 'directory' ? !stats.isDirectory() : !stats.isFile())
      )
        throw cannotSelect();
      identities.set(path, `${stats.dev}:${stats.ino}`);
    }
    const absolutePath = join(repo.absolutePath, relativePath);
    const selectedReal = await realpath(absolutePath);
    const fromRoot = relative(rootReal, selectedReal);
    if (
      fromRoot === '..' ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    )
      throw cannotSelect();
    for (const [path, identity] of Array.from(identities)) {
      const stats = await lstat(path, { bigint: true });
      if (stats.isSymbolicLink() || `${stats.dev}:${stats.ino}` !== identity)
        throw cannotSelect();
    }
    return {
      repoId: repo.repoId,
      repoName: repo.repoName,
      relativePath,
      filename: relativePath ? basename(absolutePath) : repo.repoName,
      absolutePath,
      kind,
      ...(repo.rootKind === 'attachments' ? { isAttachment: true } : {}),
    };
  } catch (error) {
    if (error instanceof PortalServiceError) throw error;
    throw cannotSelect();
  }
}
