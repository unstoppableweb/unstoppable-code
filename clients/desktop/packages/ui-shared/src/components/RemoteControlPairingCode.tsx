import type { JSX } from 'react';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';

/** `123456` → `123 456`, so the two halves are easy to compare aloud. */
export function formatPairingCode(code: string): string {
  const digits = code.replace(/\s+/g, '');
  if (digits.length !== 6) return digits;
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/**
 * How prominent the code is: `hero` is the centered code a pairing dialog
 * asks the reader to compare, `inline` sits in the flow of a sentence above it.
 */
export type RemoteControlPairingCodeSize = 'hero' | 'inline';

const SIZE_CLASS_NAMES: Record<RemoteControlPairingCodeSize, string> = {
  hero: 'text-center font-mono text-3xl font-medium tabular-nums fg-primary',
  inline: 'font-mono text-xl font-semibold fg-primary',
};

export interface RemoteControlPairingCodeProps {
  /** The six-digit code both devices show. */
  readonly code: string;
  readonly size: RemoteControlPairingCodeSize;
  readonly 'data-testid'?: string;
}

/**
 * The six-digit Remote Control pairing code (SAS) both devices show, read
 * digit by digit to assistive technology and kept out of session replay.
 */
export function RemoteControlPairingCode({
  code,
  size,
  'data-testid': dataTestId,
}: RemoteControlPairingCodeProps): JSX.Element {
  return (
    // A paragraph can't take an `aria-label`, so the spoken form is its own
    // text. The test id stays on the visible digits, so it holds them once.
    <p className={`${REPLAY_BLOCK_CLASS} ${SIZE_CLASS_NAMES[size]}`}>
      <span aria-hidden="true" data-testid={dataTestId}>
        {formatPairingCode(code)}
      </span>
      <span className="sr-only">{`Pairing code ${code.split('').join(' ')}`}</span>
    </p>
  );
}
