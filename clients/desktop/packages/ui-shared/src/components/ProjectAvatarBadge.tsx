'use client';

import { useCallback, useState, type JSX } from 'react';
import {
  WORKSPACE_GLYPH_RADIUS_CLASS,
  WorkspaceKindBadge,
  type WorkspaceKind,
} from './WorkspaceKindBadge';

export interface ProjectAvatarBadgeProps {
  /** Which workspace kind glyph the fallback badge renders. */
  kind: WorkspaceKind;
  /** See {@link WorkspaceKindBadge}. */
  temporary?: boolean;
  /** Hex color used for the fallback badge background. */
  color?: string;
  /** See {@link WorkspaceKindBadge}. */
  size?: 'sm' | 'md';
  /**
   * GitHub owner avatar for a GitHub-backed single-repo project. Ignored for
   * every other kind: multi-repo and cowork projects keep their kind badge.
   */
  avatarUrl?: string | null;
  /**
   * The host already saw this avatar paint (for example in another copy of
   * the same icon), so it shows immediately instead of waiting for `load`.
   */
  avatarLoaded?: boolean;
  /** Called once the avatar has painted. */
  onAvatarLoad?: (avatarUrl: string) => void;
  /** Called when the avatar fails; the kind badge is shown again. */
  onAvatarError?: (avatarUrl: string) => void;
  /** Appended to the badge's and avatar's fixed test ids. */
  testIdSuffix?: string;
}

/**
 * The project identity glyph: the workspace-kind badge, with a GitHub-backed
 * project's owner avatar laid over it. The badge stays in place, and visible,
 * until the avatar has painted, so a slow or failed image never leaves an
 * empty slot; it is hidden (not removed) once the avatar loads, keeping the
 * footprint identical either way.
 */
export function ProjectAvatarBadge({
  kind,
  temporary,
  color,
  size,
  avatarUrl,
  avatarLoaded = false,
  onAvatarLoad,
  onAvatarError,
  testIdSuffix = '',
}: ProjectAvatarBadgeProps): JSX.Element {
  const url = kind === 'single-repo' && avatarUrl ? avatarUrl : null;
  // Keyed by URL, so a new avatar starts over without a reset effect.
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showAvatar = url !== null && failedUrl !== url;
  const loaded = showAvatar && (avatarLoaded || loadedUrl === url);

  // An image already in the browser's cache can be complete before React
  // attaches `onLoad`; reading it at mount keeps a re-mounted copy (a pinned
  // header, a scrolled-back row) from flashing the badge for a frame.
  const adoptCompletedImage = useCallback(
    (image: HTMLImageElement | null): void => {
      if (url !== null && image?.complete && image.naturalWidth > 0) {
        setLoadedUrl(url);
      }
    },
    [url],
  );

  const badge = (
    <WorkspaceKindBadge
      testIdSuffix={testIdSuffix}
      kind={kind}
      temporary={temporary}
      color={color}
      size={size}
      className={loaded ? 'invisible' : undefined}
    />
  );
  if (!showAvatar) return badge;

  return (
    <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center self-center">
      {badge}
      <img
        key={url}
        ref={adoptCompletedImage}
        src={url}
        alt=""
        aria-hidden="true"
        draggable={false}
        decoding="async"
        referrerPolicy="no-referrer"
        data-testid={`workspace-owner-avatar${testIdSuffix}`}
        // Never forced `visible`: that would show through a hidden ancestor
        // (the app behind Settings is `visibility: hidden`).
        // The shared avatar's hairline edge, so a pale logo keeps its shape.
        className={`absolute inset-0 h-4 w-4 ${WORKSPACE_GLYPH_RADIUS_CLASS} object-cover outline-solid outline-[length:var(--border-hairline)] -outline-offset-[length:var(--border-hairline)] outline-line-base ${
          loaded ? '' : 'invisible'
        }`}
        onLoad={(): void => {
          setLoadedUrl(url);
          onAvatarLoad?.(url);
        }}
        onError={(): void => {
          setFailedUrl(url);
          onAvatarError?.(url);
        }}
      />
    </span>
  );
}
