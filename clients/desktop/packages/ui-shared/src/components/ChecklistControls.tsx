import type { JSX } from 'react';
import { CloseIcon, ForwardIcon, RetryIcon } from '../icons/AppIcons';
import { Button } from '../primitives/Button';
import { Tooltip } from '../primitives/Tooltip';

interface ChecklistDismissProps {
  label: string;
  testId: string;
  onDismiss: () => void;
}

/** Dismisses a suggestion independently of its row's primary action. */
export function ChecklistDismiss({
  label,
  testId,
  onDismiss,
}: ChecklistDismissProps): JSX.Element {
  return (
    <Tooltip label={label} className="z-10">
      <Button
        iconOnly
        variant="ghost"
        size="sm"
        onClick={onDismiss}
        data-checklist-dismiss="true"
        data-testid={testId}
        aria-label={label}
      >
        <CloseIcon size={16} aria-hidden="true" />
      </Button>
    </Tooltip>
  );
}

/** Shared hover surface and containing block for the stretched primary CTA. */
export const CHECKLIST_ROW_CLASS_NAME =
  'group/checklist relative transition-colors hover:bg-secondary';

interface ChecklistActionProps {
  label: string;
  /**
   * Tooltip text when it should differ from the accessible name. With
   * `fillRow`, the stretched overlay owns the hit test across the whole row, so
   * this tooltip is what a hover anywhere in the row opens — which makes it the
   * only reachable place to reveal row content the layout had to truncate. The
   * accessible name stays `label` either way; a screen reader announcing the
   * row's text instead of the action it performs would be a regression.
   */
  tooltipLabel?: string;
  testId: string;
  onClick: () => void;
  disabled?: boolean;
  retry?: boolean;
  variant?: 'prominent' | 'compact';
  /** Expand the primary button hit area to its positioned row. */
  fillRow?: boolean;
}

export function ChecklistAction({
  label,
  tooltipLabel,
  testId,
  onClick,
  disabled,
  retry,
  variant = 'prominent',
  fillRow = false,
}: ChecklistActionProps): JSX.Element {
  const compact = variant === 'compact';
  const iconSize = 16;
  return (
    <Tooltip
      label={tooltipLabel ?? label}
      className={fillRow ? 'static!' : 'z-10'}
    >
      <Button
        iconOnly
        variant="ghost"
        size={compact ? 'sm' : 'md'}
        data-testid={testId}
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        fillRow={fillRow}
      >
        {retry ? (
          <RetryIcon size={iconSize} aria-hidden="true" />
        ) : (
          <ForwardIcon size={iconSize} aria-hidden="true" />
        )}
      </Button>
    </Tooltip>
  );
}
