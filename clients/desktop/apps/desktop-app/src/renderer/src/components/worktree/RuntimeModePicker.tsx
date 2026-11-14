import { useId, type JSX } from 'react';
import { TerminalBorderedIcon, TerminalIcon } from '@canopy/ui-shared/icons';
import { SegmentedControl } from '@canopy/ui-shared';
import { RichHoverTooltip } from '@/components/shared/RichHoverTooltip';

/**
 * Runtime selection for a command that can either stream its output into the
 * activity panel (`background`) or run inside a workspace terminal so it can
 * accept input (`interactive`). Purely a presentation of the persisted
 * `interactive` boolean — `background` is the default (`interactive` unset).
 */
export type CommandRuntimeMode = 'background' | 'interactive';

export interface RuntimeModePickerProps {
  mode: CommandRuntimeMode;
  onChange: (next: CommandRuntimeMode) => void;
  /**
   * Shown below the picker while `interactive` is selected, explaining what the
   * terminal-backed run means for this surface.
   */
  interactiveDescription: string;
  /**
   * Locks the picker to the supplied mode. Used where the runner cannot honor
   * the other mode, so the control must not imply a choice.
   */
  disabled?: boolean;
  /**
   * Reason the picker is locked. Rendered as a hover/focus tooltip over the
   * whole control, plus a screen-reader-only description — disabled buttons
   * are not focusable, so the tooltip alone would be unreachable by assistive
   * tech.
   */
  disabledReason?: string;
  /** Distinguishes the script and hook pickers for tests. */
  testId: string;
  ariaLabel: string;
  /**
   * Show the "Runtime" label beside the picker. A settings row that already
   * names the setting hides it.
   */
  showLabel?: boolean;
}

const OPTIONS: ReadonlyArray<{
  value: CommandRuntimeMode;
  label: string;
  Icon: typeof TerminalIcon;
}> = [
  { value: 'background', label: 'Background', Icon: TerminalIcon },
  { value: 'interactive', label: 'Interactive', Icon: TerminalBorderedIcon },
];

export function RuntimeModePicker({
  mode,
  onChange,
  interactiveDescription,
  disabled = false,
  disabledReason,
  testId,
  ariaLabel,
  showLabel = true,
}: RuntimeModePickerProps): JSX.Element {
  const descriptionId = useId();
  const lockedReason = disabled ? disabledReason : undefined;
  // A settings row shows the description itself, beside its label.
  const showInteractiveDescription =
    showLabel && !disabled && mode === 'interactive';

  const group = (
    <SegmentedControl<CommandRuntimeMode>
      label={ariaLabel}
      semantics="radio"
      shape="capsule"
      width="content"
      value={mode}
      disabled={disabled}
      describedBy={
        lockedReason || showInteractiveDescription ? descriptionId : undefined
      }
      dataTestId={testId}
      options={OPTIONS.map(({ value, label, Icon }) => ({
        value,
        label,
        dataTestId: `${testId}-${value}`,
        leading: <Icon size="sm" aria-hidden="true" />,
      }))}
      onChange={(next) => {
        if (next !== mode) onChange(next);
      }}
    />
  );

  return (
    <div className={showLabel ? 'flex flex-col gap-1.5 pt-1' : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        {showLabel && (
          <span className="text-2xs font-medium fg-secondary">Runtime</span>
        )}
        {lockedReason ? (
          <RichHoverTooltip
            surfaceClassName="w-max max-w-56"
            surfacePadding="relaxed"
            dataTestId={`${testId}-tooltip`}
            content={
              <span className="block text-2xs leading-snug fg-primary">
                {lockedReason}
              </span>
            }
          >
            {group}
          </RichHoverTooltip>
        ) : (
          group
        )}
      </div>
      {lockedReason ? (
        // Disabled buttons emit no focus events, so the hover tooltip alone
        // never reaches keyboard/screen-reader users.
        <span id={descriptionId} className="sr-only">
          {lockedReason}
        </span>
      ) : (
        showInteractiveDescription && (
          <p id={descriptionId} className="text-2xs fg-secondary">
            {interactiveDescription}
          </p>
        )
      )}
    </div>
  );
}
