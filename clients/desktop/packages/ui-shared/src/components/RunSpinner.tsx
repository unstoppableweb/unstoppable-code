'use client';

import type { JSX } from 'react';
import { CometSpinner } from './CometSpinner';

interface RunSpinnerProps {
  className?: string;
}

/** The shared "running" spinner: the comet ring at 10px, named "Running". */
export function RunSpinner({ className = '' }: RunSpinnerProps): JSX.Element {
  return <CometSpinner className={className} sizePx={10} ariaLabel="Running" />;
}
