import type { JSX } from 'react';
import {
  Surface,
  type SurfacePadding,
  type SurfaceProps,
} from '../primitives/Surface';

const PADDING = {
  none: 'none',
  compact: 'section-compact',
  medium: 'dialog-footer-medium',
  default: 'dialog-footer',
  roomy: 'default',
  top: 'section-top',
} as const satisfies Record<string, SurfacePadding>;

type DialogActionFooterProps = Omit<
  SurfaceProps,
  | 'as'
  | 'variant'
  | 'boundary'
  | 'size'
  | 'extent'
  | 'padding'
  | 'gap'
  | 'direction'
  | 'selected'
  | 'interactive'
  | 'className'
> & {
  padding?: keyof typeof PADDING;
  gap?: 'tight' | 'item';
  separated?: boolean;
  center?: boolean;
  wrap?: boolean;
};

/** An action row attached to the bottom of a dialog or panel. */
export function DialogActionFooter({
  padding = 'default',
  gap = 'tight',
  separated = true,
  center = false,
  wrap = false,
  ...props
}: DialogActionFooterProps): JSX.Element {
  return (
    <Surface
      {...props}
      variant="section"
      boundary={separated ? 'top' : 'none'}
      padding={PADDING[padding]}
      direction="row"
      gap={gap === 'item' ? 'item' : 'inline'}
      className={
        wrap
          ? center
            ? 'justify-end items-center flex-wrap'
            : 'justify-end flex-wrap'
          : center
            ? 'justify-end items-center'
            : 'justify-end'
      }
    />
  );
}
