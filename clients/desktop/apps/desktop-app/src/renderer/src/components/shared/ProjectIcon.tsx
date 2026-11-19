import { useEffect, useState, type JSX } from 'react';
import {
  ProjectAvatarBadge,
  type WorkspaceKind,
} from '@canopy/ui-shared/components';
import {
  clearCachedProjectAvatar,
  getCachedProjectAvatarUrl,
  isProjectAvatarLoaded,
  markProjectAvatarLoaded,
  resolveProjectAvatarUrl,
} from './project-icon-avatar';
import { useRemoteImagesAllowed } from '@/lib/remote-image';

export interface ProjectIconProps {
  readonly kind: WorkspaceKind;
  readonly color?: string;
  readonly temporary?: boolean;
  readonly repoPath?: string;
  readonly size?: 'sm' | 'md';
  /** Appended to the badge's fixed test id; see `WorkspaceSectionHeader.testIdSuffix`. */
  readonly testIdSuffix?: string;
}

/**
 * Canonical desktop project icon for surfaces that are not snapshot-driven.
 * It resolves a single-repo project's GitHub owner avatar over IPC and hands
 * it to the shared {@link ProjectAvatarBadge}, the same rendering the shared
 * sidebar rail and the web portal draw from the snapshot's `avatarUrl`, so
 * multi-repo, cowork, offline, and loading states share one fallback.
 */
export function DesktopProjectIdentity({
  kind,
  color,
  temporary,
  repoPath,
  size = 'md',
  testIdSuffix,
}: ProjectIconProps): JSX.Element {
  // A local-only build loads no GitHub avatars; the badge keeps its fallback.
  const remoteImages = useRemoteImagesAllowed();
  const initialAvatarUrl =
    remoteImages && kind === 'single-repo' && repoPath
      ? getCachedProjectAvatarUrl(repoPath)
      : null;
  const [avatarUrl, setAvatarUrl] = useState<string | null>(initialAvatarUrl);

  useEffect(() => {
    let active = true;

    if (!remoteImages || kind !== 'single-repo' || !repoPath) {
      setAvatarUrl(null);
      return (): void => {
        active = false;
      };
    }

    setAvatarUrl(getCachedProjectAvatarUrl(repoPath));

    void resolveProjectAvatarUrl(repoPath).then((url) => {
      if (active) {
        setAvatarUrl(url);
      }
    });

    return (): void => {
      active = false;
    };
  }, [kind, remoteImages, repoPath]);

  return (
    <ProjectAvatarBadge
      testIdSuffix={testIdSuffix}
      kind={kind}
      color={color}
      temporary={temporary}
      size={size}
      avatarUrl={avatarUrl}
      // Another icon for the same repository may already have painted it.
      avatarLoaded={avatarUrl !== null && isProjectAvatarLoaded(avatarUrl)}
      onAvatarLoad={markProjectAvatarLoaded}
      onAvatarError={(failedUrl): void => {
        if (repoPath) {
          clearCachedProjectAvatar(repoPath, failedUrl);
        }
        setAvatarUrl(null);
      }}
    />
  );
}

export { DesktopProjectIdentity as ProjectIcon };
