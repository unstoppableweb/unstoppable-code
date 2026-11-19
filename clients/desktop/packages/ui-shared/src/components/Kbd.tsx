import type { JSX } from 'react';
import {
  SHORTCUT_MODIFIER_GLYPHS,
  shortcutGlyphSitsLow,
  splitShortcutKeys,
} from '../lib/shortcut-keys';

/**
 * One key cap: 18px tall, filled with the muted surface and no border, so it
 * reads as a key without adding an outline to the line it sits in. Its
 * corner is {@link KBD_CORNER_CLASS_NAME}.
 */
const KBD_CAP_CLASS_NAME =
  'inline-flex h-4.5 min-w-4.5 items-center justify-center whitespace-nowrap bg-muted px-1.25 font-sans text-2xs font-normal leading-none tabular-nums fg-tertiary';

/**
 * The rounded control a cap sits at the end of. There the cap nests: its
 * corner is the control's corner less the cap's inset, and the control keeps
 * the same inset from its end as from its top and bottom.
 *
 * - `field`: a 28px field (`SearchField` `sm`), 5px in.
 * - `field-md`: a 32px field (`SearchField` `md`), 7px in.
 * - `tooltip`: a tooltip, 4px in.
 * - `option-row`: a 36px option row, 9px in.
 *
 * The control owns this: `SearchField`'s `shortcut` and `Tooltip`'s
 * `shortcut` draw their own caps. A capsule button draws a `KbdChip`, which
 * is a capsule in a capsule and already concentric.
 */
export type KbdNest = 'field' | 'field-md' | 'tooltip' | 'option-row';

/** A cap on its own line is a capsule; a nested cap takes its host's corner. */
const KBD_CORNER_CLASS_NAME: Readonly<Record<KbdNest | 'none', string>> = {
  none: 'rounded-full',
  field: 'rounded-kbd-field',
  'field-md': 'rounded-kbd-field-md',
  tooltip: 'rounded-kbd-tooltip',
  'option-row': 'rounded-kbd-option-row',
};

function capGlyphClassName(key: string): string | undefined {
  // ⌘ ⇧ ⌥ ⌃ draw small beside a letter at the same size; one step up
  // balances them optically. Descending glyphs lift to centre their ink.
  if (SHORTCUT_MODIFIER_GLYPHS.has(key)) return 'text-xs leading-none';
  if (shortcutGlyphSitsLow(key)) return '-translate-y-px';
  return undefined;
}

export interface KbdProps {
  /**
   * The keys, in press order (`['⌘', 'K']`, see `shortcutKeys(id)`), or a
   * display string such as `⌘⇧K` or `Ctrl Shift K` (see `formatShortcut`).
   */
  shortcut: string | readonly string[];
  /**
   * The rounded control the caps sit at the end of; see {@link KbdNest}.
   * Leave it out for caps on their own line (a settings row, a footer).
   */
  nest?: KbdNest;
  /** Placement only; the caps own their size, fill and type. */
  className?: string;
  /** Hide the caps from assistive technology when the control names them. */
  'aria-hidden'?: boolean;
  'data-testid'?: string;
}

/**
 * Keyboard hint drawn as one filled cap per key. Use it in picker footers
 * and settings; a tooltip and a search field draw their own through their
 * `shortcut` prop, a button carries its shortcut as a `KbdChip`, and a menu
 * row as plain trailing text.
 */
export function Kbd({
  shortcut,
  nest,
  className = '',
  'aria-hidden': ariaHidden,
  'data-testid': testId = 'kbd',
}: KbdProps): JSX.Element {
  const keys =
    typeof shortcut === 'string' ? splitShortcutKeys(shortcut) : shortcut;
  return (
    <span
      aria-hidden={ariaHidden}
      className={`inline-flex shrink-0 items-center gap-0.75 align-middle ${className}`}
      data-testid={testId}
    >
      {keys.map((key, index) => (
        <kbd
          key={`${key}-${index}`}
          className={`${KBD_CAP_CLASS_NAME} ${KBD_CORNER_CLASS_NAME[nest ?? 'none']}`}
        >
          <span className={capGlyphClassName(key)}>{key}</span>
        </kbd>
      ))}
    </span>
  );
}
