import { forwardRef, useId, type JSX, type ReactNode } from 'react';

export type ToggleSwitchSize = 'md' | 'sm';

export interface ToggleSwitchProps {
  readonly id?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  /**
   * Set while the value has not been read yet. `aria-checked` stays boolean
   * because WAI-ARIA does not allow `mixed` on `switch`.
   */
  readonly busy?: boolean;
  /**
   * Shown and focusable, so a tooltip can say why, but not operable: the
   * switch keeps `aria-disabled` and the tab order, and a press does nothing.
   * Use `disabled` when there is no reason to show.
   */
  readonly unavailable?: boolean;
  /** Accessible name. Required: the track renders no text of its own. */
  readonly label: string;
  /** Id of an element that describes the switch, such as a note beside it. */
  readonly describedBy?: string;
  /** Set by a `Tooltip` around the switch; adds to `describedBy`. */
  readonly 'aria-describedby'?: string;
  readonly onChange: (next: boolean) => void;
  readonly dataTestId?: string;
  /**
   * `md` (32x18) is every switch in Settings and the default elsewhere. `sm`
   * (28x16) is the Home composer's Pipeline toggle size.
   */
  readonly size?: ToggleSwitchSize;
}

/**
 * `lg` (36x20) is the switch of a settings row inside a composer panel (the
 * effort panel's fast mode); only `CompactToggleIndicator` draws it.
 */
type SwitchTrackSize = ToggleSwitchSize | 'lg';

// One switch drawing at three sizes: a 2px inset knob on a rounded track. The
// knob stretches toward the middle while the enclosing `group` is hovered,
// so the switch reads as pressable without a color change.
const TRACK_SIZE_CLASS_NAMES: Record<SwitchTrackSize, string> = {
  lg: 'h-5 w-9',
  md: 'h-4.5 w-8',
  sm: 'h-4 w-7',
};

const KNOB_SIZE_CLASS_NAMES: Record<SwitchTrackSize, string> = {
  lg: 'h-4 w-4 group-hover:w-4.5',
  md: 'h-3.5 w-3.5 group-hover:w-4',
  sm: 'h-3 w-3 group-hover:w-3.5',
};

const KNOB_ON_CLASS_NAMES: Record<SwitchTrackSize, string> = {
  lg: 'translate-x-4 group-hover:translate-x-3.5',
  md: 'translate-x-3.5 group-hover:translate-x-3',
  sm: 'translate-x-3 group-hover:translate-x-2.5',
};

const KNOB_STYLE = {
  transition: 'width 100ms ease-out, translate 100ms ease-out',
};

function SwitchTrack({
  checked,
  size,
}: {
  readonly checked: boolean;
  readonly size: SwitchTrackSize;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex ${TRACK_SIZE_CLASS_NAMES[size]} shrink-0 items-center rounded-full ${
        checked ? 'bg-accent' : 'bg-fg-quaternary group-hover:bg-fg-tertiary'
      }`}
    >
      <span
        style={KNOB_STYLE}
        className={`absolute left-0.5 top-0.5 block ${KNOB_SIZE_CLASS_NAMES[size]} rounded-full bg-fg-emphasis ${
          checked ? KNOB_ON_CLASS_NAMES[size] : 'translate-x-0'
        }`}
      />
    </span>
  );
}

/**
 * The app's on/off switch. Pure display: it renders the track and knob and
 * reports the requested next value, so the caller owns the async work and the
 * `disabled` window around it.
 *
 * `role="switch"` + `aria-checked` rather than a styled checkbox, matching the
 * pattern the account, team, and digest surfaces already ship. The drawing is
 * the Home composer's Pipeline toggle (`CompactToggleIndicator`), so every
 * switch in the app is the same control.
 */
export const ToggleSwitch = forwardRef<HTMLButtonElement, ToggleSwitchProps>(
  function ToggleSwitch(
    {
      id,
      checked,
      disabled,
      busy,
      unavailable,
      label,
      describedBy,
      'aria-describedby': tooltipDescribedBy,
      onChange,
      dataTestId,
      size = 'md',
    },
    ref,
  ): JSX.Element {
    return (
      <button
        ref={ref}
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-busy={busy || undefined}
        aria-disabled={unavailable || undefined}
        aria-label={label}
        aria-describedby={
          [describedBy, tooltipDescribedBy].filter(Boolean).join(' ') ||
          undefined
        }
        disabled={disabled}
        data-testid={dataTestId}
        // Inert by having no handler, not by a guard inside one.
        onClick={unavailable ? undefined : () => onChange(!checked)}
        // `pointer-events-none` while disabled also stops the hover stretch;
        // an unavailable switch keeps its pointer events for its tooltip, so
        // it leaves out `group` instead. The track's color changes at once,
        // like every hover and selection color; only the knob moves. On a
        // coarse pointer the 32×18 track reaches a 44×42 hit area.
        className={`${unavailable ? 'cursor-not-allowed opacity-60' : 'group'} focus-ring relative inline-flex shrink-0 rounded-full before:absolute before:inset-0 before:content-[''] pointer-coarse:before:-inset-x-1.5 pointer-coarse:before:-inset-y-3 disabled:pointer-events-none disabled:opacity-60`}
      >
        <SwitchTrack checked={checked} size={size} />
      </button>
    );
  },
);

ToggleSwitch.displayName = 'ToggleSwitch';

/**
 * Visual toggle for an existing switch or menu checkbox. The parent owns
 * interaction (and the `group` class that drives the hover stretch). `sm`
 * sits inline in a toolbar pill (New task's Pipeline); `lg` is a settings row
 * inside a composer panel.
 */
export function CompactToggleIndicator({
  checked,
  size = 'sm',
}: {
  readonly checked: boolean;
  readonly size?: 'sm' | 'lg';
}): JSX.Element {
  return <SwitchTrack checked={checked} size={size} />;
}

export type ToggleSwitchFieldProps = Omit<ToggleSwitchProps, 'label'> & {
  /** Accessible name; defaults to `caption` when that is plain text. */
  readonly label?: string;
  /** The visible text beside the switch; clicking it flips the switch. */
  readonly caption: ReactNode;
};

/**
 * A switch with a small caption beside it, inline (a card footer, a
 * toolbar). The caption is the switch's `<label>`, so clicking the text flips
 * it. In a Settings row use `SettingsRowsRow` instead.
 */
export function ToggleSwitchField({
  caption,
  label,
  id,
  ...props
}: ToggleSwitchFieldProps): JSX.Element {
  const generatedId = useId();
  const switchId = id ?? generatedId;
  const name = label ?? (typeof caption === 'string' ? caption : '');
  return (
    <span className="inline-flex items-center gap-2">
      <ToggleSwitch {...props} id={switchId} label={name} />
      <label htmlFor={switchId} className="text-xs fg-secondary">
        {caption}
      </label>
    </span>
  );
}
