import { ControlButton } from '../primitives/Button';
/**
 * Running-action chrome shared by the worktree top bar's git actions and any
 * other long-running button that should become its own cancel control: the
 * button keeps its label, its leading icon becomes a spinner, and a hover ✕
 * takes the spinner's slot. Extracted verbatim from `PrStatusBar` so the
 * "Empty trash" run on the Archived and deleted page reads exactly like
 * Commit and push / Merge.
 *
 * Callers wrap the button and the ✕ in a `group/gitaction relative
 * inline-flex` container; see `PullRequestActions` (`@canopy/ui-app`) for
 * the full hover-ownership notes.
 */
import type { JSX } from 'react';
import { CloseMediumIcon } from '../icons/AppIcons';
import type { SpinnerTone } from '../primitives/spinner-tone';
import { ThinkingSpinner } from '../primitives/ThinkingSpinner';
import { Tooltip } from '../primitives/Tooltip';
import type { CancelActionButtonTone } from '../primitives/control-button-shared';
export type { CancelActionButtonTone } from '../primitives/control-button-shared';

export interface RunningActionIconProps {
  /**
   * Cancellation is already in flight, so there is no second click to offer —
   * the slot keeps spinning instead of showing an ✕ that would do nothing.
   */
  cancellationRequested: boolean;
  /**
   * The button's own ink. The spinner renders it quiet, so it reads beneath
   * the label it sits beside.
   */
  spinnerTone: SpinnerTone;
}

/**
 * Leading slot of a RUNNING header action: the spinner, hidden while the
 * action group is hovered so `CancelActionButton` can take its place.
 *
 * The 12px box is fixed so the label does not jump when the glyph swaps (the
 * spinner is 10px, the ✕ 12px).
 */
export function RunningActionSpinnerSlot({
  cancellationRequested,
  spinnerTone,
}: RunningActionIconProps): JSX.Element {
  return (
    <span className="inline-flex h-3 w-4 shrink-0 items-center justify-center pr-1">
      <ThinkingSpinner
        tone={spinnerTone}
        quiet
        className={cancellationRequested ? '' : 'group-hover/gitaction:hidden'}
      />
    </span>
  );
}

export interface CancelActionButtonProps {
  onCancel: () => void;
  /** Full action name, e.g. `Cancel Merge`. */
  label: string;
  tone?: CancelActionButtonTone;
}

/**
 * The ✕ that takes over a running action's spinner slot on hover.
 *
 * It is a REAL button — its own hover state, its own tooltip, its own
 * accessible name — but it cannot be a CHILD of the action button: interactive
 * descendants inside a `<button>` are invalid markup, and the click would
 * bubble into the action anyway. So it is a sibling, absolutely positioned
 * over the leading icon slot, satisfying two constraints at once: centred on
 * the spinner it replaces (midpoint 18px from the pill's left edge — the
 * `compact` capsule's 12px padding + half the 12px slot) AND inset an equal
 * 2px from the pill's top, bottom and left. A circle can't do both (2px
 * insets centre a 24px circle at 14px), so the button is a 32×24 capsule:
 * `left-0.5` + half of 32 lands on 18. The group wrapper supplies the
 * positioning context.
 *
 * The cancel action preserves the 24px inset and the merged tone inside the 28px
 * action. The surrounding action supplies the pill and reveal behavior.
 *
 * The action button underneath stays a cancel target too, so clicking the
 * label does the same thing. Being a sibling (not a child) means a click on
 * the ✕ never bubbles into that button, so there is nothing to stop.
 */
export function CancelActionButton({
  onCancel,
  label,
  tone = 'accent',
}: CancelActionButtonProps): JSX.Element {
  return (
    // Own the positioning and the reveal HERE, on a plain span, rather than on
    // the button or through `Tooltip`'s className: Tooltip renders its own
    // `relative inline-flex` wrapper between this and the button, so an
    // `absolute` on the button would resolve against THAT wrapper (measured:
    // the ✕ landed outside the action button entirely), and putting
    // `absolute`/`hidden` on the wrapper would collide with the `relative` and
    // `inline-flex` it already carries.
    // `top-0.5`, not `top-1/2 -translate-y-1/2`: the pill is a known 28px
    // and this a known 24px, so a fixed inset is exact, while the centring
    // translate landed on a subpixel (measured 1.8 top / 2.3 bottom).
    <span className="absolute left-0.5 top-0.5 hidden group-hover/gitaction:block">
      <Tooltip label={label}>
        <ControlButton
          type="button"
          onClick={onCancel}
          aria-label={label}
          data-testid="pr-status-bar-cancel-git-action"
          // Hover ownership: the PILL carries the hover state (via the
          // group-hover on its own shell, so it stays lit while the pointer
          // is on this overlay); the ✕ stays chrome-less until pointed at
          // DIRECTLY, then gets its own background + darker glyph on top.
          //
          // The radius is the nested-corner rule, not a free choice: the pill
          // is a 28px capsule and this sits 2px inside it top, bottom and
          // left, so a 24px capsule's end arc (radius 12) shares the centre
          // of the pill's end cap (radius 14) and the two stay concentric.
          presentation="cancel-action"
          appearance={{ tone }}
        >
          <CloseMediumIcon />
        </ControlButton>
      </Tooltip>
    </span>
  );
}

export { RunningActionSpinnerSlot as RunningActionIcon };
