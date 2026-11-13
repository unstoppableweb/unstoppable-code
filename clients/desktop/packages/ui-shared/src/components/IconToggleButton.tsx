import type { JSX, ReactNode } from 'react';
import { Tooltip } from './Tooltip';

export interface IconToggleButtonProps {
  readonly pressed: boolean;
  /** Accessible name: the setting the button turns on and off. */
  readonly label: string;
  readonly tooltip: string;
  readonly icon: ReactNode;
  /** Shows the label beside the icon instead of the icon alone. */
  readonly showLabel?: boolean;
  /** Ink while off: secondary by default, or the accent with no surface. */
  readonly offTone?: 'secondary' | 'accent';
  /** Selected treatment for controls with a special active tier. */
  readonly activeTone?: 'accent' | 'special';
  readonly dataSpeed?: 'standard' | 'fast' | 'ultrafast';
  readonly disabled?: boolean;
  readonly onClick: () => void;
  /**
   * `panel-corner` pulls the button 4px up and right, so it sits 8px from the
   * top and right edges of a panel padded 12px.
   */
  readonly placement?: 'panel-corner';
  readonly testId?: string;
}

/**
 * A toggle for a panel or menu header: its icon, optionally with its label.
 * Off, no surface (one on hover); on, the accent on the subtle accent
 * surface. Fast mode in the effort panel and Auto in the model picker share it;
 * Auto keeps the accent ink while off.
 */
export function IconToggleButton({
  pressed,
  label,
  tooltip,
  icon,
  showLabel = false,
  offTone = 'secondary',
  activeTone = 'accent',
  dataSpeed,
  disabled = false,
  onClick,
  placement,
  testId,
}: IconToggleButtonProps): JSX.Element {
  return (
    <Tooltip label={tooltip} delay="long">
      <button
        type="button"
        aria-pressed={pressed}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        data-testid={testId}
        data-speed={dataSpeed}
        className={`focus-ring ${placement === 'panel-corner' ? '-my-1 -mr-1 ' : ''}flex h-7 ${showLabel ? 'gap-1 px-2 text-xs' : 'w-7 justify-center'} shrink-0 items-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          pressed
            ? activeTone === 'special'
              ? 'bg-special-subtle fg-special'
              : 'bg-accent-subtle fg-accent-strong'
            : offTone === 'accent'
              ? 'fg-accent enabled:hover:bg-subtle'
              : 'fg-secondary enabled:hover:bg-subtle enabled:hover:fg-primary'
        }`}
      >
        {icon}
        {showLabel ? <span aria-hidden="true">{label}</span> : null}
      </button>
    </Tooltip>
  );
}
