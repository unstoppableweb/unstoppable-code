import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';

/**
 * Ink for the spinners. `inherit` takes the surrounding text color, which
 * is right inside a labelled control; the rest name the role the spinner
 * stands for. `active` and `unread` are operational run states and follow
 * {@link OPERATIONAL_STATUS_COLORS}.
 */
export type SpinnerTone =
  | 'inherit'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'accent'
  | 'emphasis'
  | 'warning'
  | 'destructive'
  | 'active'
  | 'unread';

export const SPINNER_TONE_CLASS_NAMES: Record<SpinnerTone, string> = {
  inherit: '',
  primary: 'fg-primary',
  secondary: 'fg-secondary',
  tertiary: 'fg-tertiary',
  accent: 'fg-accent',
  emphasis: 'fg-emphasis',
  warning: 'fg-warning',
  destructive: 'fg-destructive',
  active: OPERATIONAL_STATUS_COLORS.active.foreground,
  unread: OPERATIONAL_STATUS_COLORS.unread.foreground,
};

/**
 * A quiet spinner reads beneath the label it sits beside, such as the busy
 * spinner inside an action button: the button's own ink, at reduced weight.
 */
export const SPINNER_QUIET_CLASS_NAME = 'opacity-60';

export function spinnerClassName(tone: SpinnerTone, quiet: boolean): string {
  const ink = SPINNER_TONE_CLASS_NAMES[tone];
  return quiet ? `${ink} ${SPINNER_QUIET_CLASS_NAME}` : ink;
}

/**
 * The ring's ink for a tone. Activity reads in the primary ink rather than
 * the brand accent; every other tone keeps its meaning, and `inherit` and
 * `emphasis` still follow the control they sit in.
 */
export function cometTone(tone: SpinnerTone): SpinnerTone {
  return tone === 'accent' ? 'primary' : tone;
}
