import type { JSX } from 'react';
import { LoadingSpinner } from './LoadingSpinner';

export interface CenteredLoadingSpinnerProps {
  /** Size or placement only; the spinner centers in whatever box it gets. */
  readonly className?: string;
  /** Vertical inset for an inline loading region. */
  readonly spacing?: 'section';
}

/**
 * One spinner centered on both axes of the region it fills, for a page or
 * panel whose content shape is not predictable. Use a settings skeleton when
 * it is. The spinner stays a spinner whatever `LoadingIndicatorStyle` the
 * host chose: that setting swaps inline loading copy, and this region has no
 * copy to swap. The spinner's own look still follows the host's spinner
 * style. "Loading" is announced to assistive technology only.
 */
export function CenteredLoadingSpinner({
  className = '',
  spacing,
}: CenteredLoadingSpinnerProps): JSX.Element {
  return (
    <div
      role="status"
      data-testid="centered-loading-spinner"
      className={`flex min-h-full flex-1 items-center justify-center ${spacing === 'section' ? 'py-12' : ''} ${className}`}
    >
      <span className="sr-only">Loading</span>
      <LoadingSpinner tone="secondary" sizePx={14} decorative />
    </div>
  );
}
