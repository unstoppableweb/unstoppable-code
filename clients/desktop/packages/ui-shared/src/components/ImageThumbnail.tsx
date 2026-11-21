import type { ComponentPropsWithRef, JSX } from 'react';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';

// Photos and screenshots carry the inset hairline outline the avatar photo
// uses; an inset ring or shadow would paint under the image.
const PHOTO_EDGE_CLASS =
  'outline-solid outline-[length:var(--border-hairline)] -outline-offset-[length:var(--border-hairline)] outline-line-base';

const VARIANT_CLASS = {
  'attachment-preview': `max-h-50 max-w-full rounded object-contain ${PHOTO_EDGE_CLASS}`,
  'tool-image': `max-h-80 max-w-full rounded-md object-contain ${PHOTO_EDGE_CLASS}`,
  'generated-image': `max-h-[70vh] max-w-full self-start rounded-lg object-contain ${PHOTO_EDGE_CLASS}`,
  'menu-icon': 'h-4 w-4 rounded object-contain',
  'terminal-icon': 'h-6 w-6 rounded object-contain',
  'terminal-option': 'h-7 w-7 shrink-0 rounded object-contain',
  'sidebar-icon': 'rounded-sm object-cover shrink-0',
  'browser-snapshot': `h-12 w-16 shrink-0 rounded object-cover ${PHOTO_EDGE_CLASS}`,
} as const;

type ImageThumbnailProps = Omit<ComponentPropsWithRef<'img'>, 'className'> & {
  readonly variant: keyof typeof VARIANT_CLASS;
  readonly alt: string;
  readonly replay?: 'block';
};

/** Raster thumbnails and app icons keep their sizing and clipping by role. */
export function ImageThumbnail({
  variant,
  hidden,
  replay,
  ...props
}: ImageThumbnailProps): JSX.Element {
  return (
    <img
      {...props}
      className={`${VARIANT_CLASS[variant]}${hidden ? ' hidden' : ''}${replay === 'block' ? ` ${REPLAY_BLOCK_CLASS}` : ''}`}
    />
  );
}
