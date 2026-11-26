import type { JSX } from 'react';

// Its own module so every Button does not also ship the key caps and legend.
export interface KbdChipProps {
  /** The display string for the binding (`⌘P`, `Ctrl P`). */
  shortcut: string;
}

/**
 * A button's own shortcut, drawn inside it after the label as one filled
 * chip with no border. The fill and ink derive from the button's ink, so the
 * chip reads on a secondary, primary or destructive surface alike. Hidden
 * from assistive technology, so the button's name stays its label.
 */
export function KbdChip({ shortcut }: KbdChipProps): JSX.Element {
  return (
    <kbd
      aria-hidden="true"
      data-testid="kbd-chip"
      className="ml-0.5 inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center whitespace-nowrap rounded-full bg-current/10 px-1.25 font-sans text-2xs font-normal leading-none tabular-nums"
    >
      <span className="opacity-70">{shortcut}</span>
    </kbd>
  );
}
