'use client';

import {
  useState,
  type ComponentType,
  type ImgHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import type { IconSize } from '../icons/icon-size';
import { displayInitials } from '../lib/display-avatar';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';

/** The avatar steps: 16, 20, 24, 32 and 40px, and 72px for a profile. */
export type DisplayAvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

export const DISPLAY_AVATAR_SIZE_PX: Readonly<
  Record<DisplayAvatarSize, number>
> = {
  xs: 16,
  sm: 20,
  md: 24,
  lg: 32,
  xl: 40,
  '2xl': 72,
};

/** The icon step a `glyph` takes at each avatar size. */
export const DISPLAY_AVATAR_GLYPH_SIZE: Readonly<
  Record<DisplayAvatarSize, IconSize>
> = {
  xs: 'xs',
  sm: 'xs',
  md: 'sm',
  lg: 'md',
  xl: 'xl',
  '2xl': '2xl',
};

/** The props an injected image component receives (a `next/image` subset). */
export interface DisplayAvatarImageProps {
  readonly src: string;
  readonly alt: string;
  readonly width?: number;
  readonly height?: number;
  readonly className?: string;
  readonly unoptimized?: boolean;
  readonly referrerPolicy?: ImgHTMLAttributes<HTMLImageElement>['referrerPolicy'];
  readonly onError?: () => void;
  readonly 'data-testid'?: string;
}

export type DisplayAvatarImageComponent =
  ComponentType<DisplayAvatarImageProps>;

export interface DisplayAvatarProps {
  /** Whose avatar it is; the initials come from it. */
  readonly name: string;
  readonly image?: string | null;
  readonly size?: DisplayAvatarSize;
  /**
   * The avatar's accessible name. Empty (the default) when the name already
   * shows beside it, so the avatar stays decorative.
   */
  readonly alt?: string;
  /** Placement only (margins, shrink); the avatar owns its look. */
  readonly className?: string;
  readonly testId?: string;
  /**
   * Who the avatar depicts: a person is a circle, a group (a team, an
   * organization, a project) a rounded square. A person's photo or initials
   * are personal identity, so session replay records a same-size box; a
   * group's are recorded unless `replayBlocked` says otherwise.
   */
  readonly subject?: 'person' | 'group';
  /**
   * Blocks the photo or initials from session replay. Defaults to true for a
   * person; a host that treats a group as private (an organization's logo)
   * sets it.
   */
  readonly replayBlocked?: boolean;
  /**
   * An actor's glyph (an agent, a pipeline, You) drawn in the avatar's shell
   * in place of the initials, sized by {@link DISPLAY_AVATAR_GLYPH_SIZE}. A
   * photo still wins when there is one. Glyphs are recorded by session
   * replay.
   */
  readonly glyph?: ReactNode;
  /**
   * The host's image component (`next/image` on web); a plain `<img>`
   * otherwise. The URL may come from any provider host, so it is rendered
   * unoptimized.
   */
  readonly imageComponent?: DisplayAvatarImageComponent;
  /**
   * Called when the photo fails to load, after the avatar has fallen back to
   * the initials; for a host that remembers failed URLs.
   */
  readonly onImageError?: (image: string) => void;
  /**
   * `data-*` attributes for the avatar's element, such as a kind marker. A
   * host image component receives only the test id.
   */
  readonly [dataAttribute: `data-${string}`]: string | undefined;
}

const SIZE_CLASS_NAMES: Readonly<Record<DisplayAvatarSize, string>> = {
  xs: 'h-4 w-4 text-3xs',
  sm: 'h-5 w-5 text-3xs',
  md: 'h-6 w-6 text-2xs',
  lg: 'h-8 w-8 text-xs',
  xl: 'h-10 w-10 text-xs',
  '2xl': 'h-18 w-18 text-m',
};

function shapeClassName(
  subject: 'person' | 'group',
  size: DisplayAvatarSize,
): string {
  if (subject === 'person') return 'rounded-full';
  return size === 'xs' || size === 'sm' ? 'rounded' : 'rounded-md';
}

/** Two initials, or one in the 16px avatar where two overflow the circle. */
function avatarInitials(name: string, size: DisplayAvatarSize): string {
  const initials = displayInitials(name);
  return size === 'xs' ? initials.slice(0, 1) : initials;
}

/** Renders the host's image component (a capitalized name for JSX). */
function HostImage({
  Image,
  ...props
}: DisplayAvatarImageProps & {
  readonly Image: DisplayAvatarImageComponent;
}): JSX.Element {
  return <Image {...props} />;
}

/**
 * The one avatar: a person's photo or initials in a circle, a group's in a
 * rounded square, or an actor's glyph in the same shell. Initials are grey
 * (`bg-muted`, `fg-secondary`); a photo has a hairline edge. A photo that
 * fails to load falls back to the initials.
 */
export function DisplayAvatar({
  name,
  image,
  size = 'md',
  alt = '',
  className = '',
  testId,
  subject = 'person',
  replayBlocked = subject === 'person',
  glyph,
  imageComponent,
  onImageError,
  ...data
}: DisplayAvatarProps): JSX.Element {
  // The URL that failed, so a later, different URL is tried again.
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const shape = shapeClassName(subject, size);
  const box = `${SIZE_CLASS_NAMES[size]} ${shape} inline-flex shrink-0 select-none items-center justify-center overflow-hidden`;
  const replay = replayBlocked ? `${REPLAY_BLOCK_CLASS} ` : '';

  if (image && failedImage !== image) {
    const px = DISPLAY_AVATAR_SIZE_PX[size];
    // The hairline is an inset outline: an inset ring (a box shadow) would
    // paint under the picture.
    const imageClassName = `${replay}${SIZE_CLASS_NAMES[size]} ${shape} shrink-0 object-cover outline-solid outline-[length:var(--border-hairline)] -outline-offset-[length:var(--border-hairline)] outline-line-base ${className}`;
    const handleError = (): void => {
      setFailedImage(image);
      onImageError?.(image);
    };
    return imageComponent === undefined ? (
      <img
        {...data}
        data-testid={testId}
        src={image}
        alt={alt}
        width={px}
        height={px}
        referrerPolicy="no-referrer"
        className={imageClassName}
        onError={handleError}
      />
    ) : (
      <HostImage
        Image={imageComponent}
        data-testid={testId}
        src={image}
        alt={alt}
        width={px}
        height={px}
        unoptimized
        referrerPolicy="no-referrer"
        className={imageClassName}
        onError={handleError}
      />
    );
  }

  const label =
    alt === '' ? { 'aria-hidden': true } : { role: 'img', 'aria-label': alt };
  if (glyph !== undefined) {
    return (
      <span
        {...data}
        {...label}
        data-testid={testId}
        className={`${box} bg-muted fg-secondary ${className}`}
      >
        {glyph}
      </span>
    );
  }
  return (
    <span
      {...data}
      {...label}
      data-testid={testId}
      className={`${replay}${box} bg-muted font-medium fg-secondary ${className}`}
    >
      {avatarInitials(name, size)}
    </span>
  );
}
