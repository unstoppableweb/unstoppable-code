import type { JSX } from 'react';
import {
  SPINNER_TONE_CLASS_NAMES,
  type SpinnerTone,
} from '../primitives/spinner-tone';
import {
  RefreshIcon as AppCatalogRefreshIcon,
  type IconSize,
} from '../icons/AppIcons';

interface RefreshSpinnerProps {
  spinning?: boolean;
  size?: IconSize;
  /** Ink. `inherit` (the default) takes the surrounding text color. */
  tone?: SpinnerTone;
  className?: string;
}

export function RefreshSpinner({
  spinning = false,
  size = 'sm',
  tone = 'inherit',
  className = '',
}: RefreshSpinnerProps): JSX.Element {
  return (
    <AppCatalogRefreshIcon
      aria-hidden="true"
      size={size}
      className={`${spinning ? 'animate-spin' : ''} ${SPINNER_TONE_CLASS_NAMES[tone]} ${className}`}
    />
  );
}
