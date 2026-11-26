import type { JSX, ReactNode } from 'react';

/**
 * Hover and keyboard-focus scrim inside the image edit button. It stays up
 * while the button is disabled so touch and keyboard users see the busy mark.
 */
export function MediaEditOverlay({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      style={{ borderRadius: 'inherit' }}
      className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-disabled:opacity-100"
    >
      {children}
    </span>
  );
}
