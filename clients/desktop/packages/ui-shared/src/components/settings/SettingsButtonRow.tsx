import { ControlButton } from '../../primitives/Button';
import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react';
import { CheckIcon, ChevronRightIcon } from '../../icons/AppIcons';
import { Tooltip } from '../../primitives/Tooltip';

/**
 * A Settings row that is itself the target: it opens the item it names (an
 * environment) or picks it (a browser profile). It keeps the settings row's
 * geometry (a 40px content line inside the group's 12px row inset, so 64px)
 * and its label and subtitle inks. The row element takes the group's inset
 * and divider; the button inside it fills the whole row and its press
 * highlight bleeds 8px into the group's side padding, so the text stays on
 * the rows' shared edge and the dividers keep their length.
 *
 * `trailing` says what a press does: `open` draws the chevron, `select` the
 * checkmark on the chosen row (persistent selection is the checkmark alone,
 * with no selected fill). Anything else rides before it, such as counts or a
 * badge.
 */
export interface SettingsButtonRowProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'className' | 'children' | 'title'
> {
  /**
   * The row's full text in the shared tooltip, for a label that truncates.
   * Never a native `title`.
   */
  readonly tooltip?: string;
  readonly label: ReactNode;
  readonly description?: ReactNode;
  /** Quiet details at the trailing edge, before the chevron or check. */
  readonly meta?: ReactNode;
  readonly trailing: 'open' | 'select';
  /** For `select`: this row is the chosen one. */
  readonly selected?: boolean;
}

export function SettingsButtonRow({
  label,
  description,
  meta,
  trailing,
  selected = false,
  tooltip,
  ...props
}: SettingsButtonRowProps): JSX.Element {
  const button = (
    <ControlButton
      {...props}
      type="button"
      aria-pressed={trailing === 'select' ? selected : undefined}
      data-settings-control="row"
      presentation="settings-select-row"
    >
      <span className="min-w-0 flex-1 flex flex-col gap-0.5">
        <span className="block min-w-0 text-s font-medium fg-primary">
          {label}
        </span>
        {description ? (
          <span className="block text-xs text-pretty fg-secondary">
            {description}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-3">
        {meta}
        {trailing === 'open' ? (
          <ChevronRightIcon size={14} aria-hidden className="fg-tertiary" />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-3.5 w-3.5 items-center justify-center fg-primary"
          >
            {selected ? <CheckIcon size={14} /> : null}
          </span>
        )}
      </span>
    </ControlButton>
  );
  return (
    <div className="flex">
      {tooltip ? (
        <Tooltip label={tooltip} className="w-full">
          {button}
        </Tooltip>
      ) : (
        button
      )}
    </div>
  );
}
