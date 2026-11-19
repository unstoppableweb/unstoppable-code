import { Heading } from './Heading';
import { Children, type JSX, type ReactNode } from 'react';
import { Button } from './Button';
import { Stack } from './Stack';

export interface SettingsDangerConfirmBlockProps {
  /** Section heading rendered inside the bordered card. */
  title: string;
  /** Optional supporting copy below the heading. */
  description?: ReactNode;
  /** Optional supplementary message rendered below `description` (e.g. an
   * "active sessions" warning). */
  warning?: ReactNode;
  /** Warning paragraphs; this block owns their spacing. Empty items are omitted. */
  warnings?: readonly ReactNode[];
  /** True when the destructive action should be disabled before confirmation
   * (e.g. active sessions, missing source repo path). */
  triggerDisabled?: boolean;
  triggerLabel: string;
  /** Confirm phase: action is in flight (`isWorking` true) or awaiting a
   * second click. */
  confirming: boolean;
  onConfirmStart: () => void;
  onConfirmCancel: () => void;
  /** Click handler for the confirm button. The button shows
   * `confirmInProgressLabel` while `isWorking` is true. */
  onConfirm: () => void;
  isWorking: boolean;
  confirmLabel: string;
  confirmInProgressLabel: string;
  /** When `'destructive'` (default) the trigger uses destructive styling.
   * `'warning'` mirrors the amber "Convert to ..." sections. */
  variant?: 'destructive' | 'warning';
  /**
   * `card` frames the action on its own. `row` is one settings row: the
   * label and explanation leading, a quiet text action trailing (danger ink
   * for `destructive`), and the confirm step in place of the action.
   */
  surface?: 'card' | 'row';
}

/**
 * Single confirm/cancel pattern used for "Delete project/workspace" and
 * "Convert to single/multi-repo" sections in both modals. Renders the trigger
 * button until clicked, then swaps to a "Confirm / Cancel" pair.
 */
export function SettingsDangerConfirmBlock({
  title,
  description,
  warning,
  warnings,
  triggerDisabled,
  triggerLabel,
  confirming,
  onConfirmStart,
  onConfirmCancel,
  onConfirm,
  isWorking,
  confirmLabel,
  confirmInProgressLabel,
  variant = 'destructive',
  surface = 'card',
}: SettingsDangerConfirmBlockProps): JSX.Element {
  const warningItems = Children.toArray(warnings);
  if (surface === 'row') {
    return (
      <div className="flex min-h-10 items-center justify-between gap-6">
        <Stack gap="tight" className="min-w-0 flex-1">
          <div className="flex flex-col gap-0.5">
            <div className="text-s font-medium fg-primary">{title}</div>
            {description && (
              <div className="text-xs text-pretty fg-secondary">
                {description}
              </div>
            )}
            {warning}
          </div>
          {warningItems.length > 0 && <Stack gap="tight">{warningItems}</Stack>}
        </Stack>
        <div className="flex shrink-0 items-center gap-2">
          {!confirming ? (
            <Button
              onClick={onConfirmStart}
              disabled={triggerDisabled || isWorking}
              variant={
                variant === 'destructive' ? 'ghost-destructive' : 'ghost'
              }
              size="compact"
            >
              {triggerLabel}
            </Button>
          ) : (
            <>
              <Button
                onClick={onConfirmCancel}
                disabled={isWorking}
                variant="ghost"
                size="compact"
              >
                Cancel
              </Button>
              <Button
                onClick={onConfirm}
                disabled={isWorking}
                variant={variant === 'destructive' ? 'destructive' : 'primary'}
                size="compact"
              >
                {isWorking ? confirmInProgressLabel : confirmLabel}
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }
  const cardBorderClass =
    variant === 'destructive'
      ? 'border-line-destructive/30'
      : 'border-line-attention/30';

  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border ${cardBorderClass} p-3`}
    >
      <div>
        <Stack gap="tight">
          <Heading
            level={3}
            variant="title"
            tone={variant === 'destructive' ? 'destructive' : undefined}
          >
            {title}
          </Heading>
          {description && <p className="text-xs fg-secondary">{description}</p>}
          {warningItems.length > 0 && <Stack gap="tight">{warningItems}</Stack>}
        </Stack>
        {warning}
      </div>
      {!confirming ? (
        <Button
          onClick={onConfirmStart}
          disabled={triggerDisabled || isWorking}
          variant={variant === 'destructive' ? 'destructive' : 'secondary'}
          size="sm"
          className="self-start"
        >
          {triggerLabel}
        </Button>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            onClick={onConfirm}
            disabled={isWorking}
            variant={variant === 'destructive' ? 'destructive' : 'primary'}
            size="sm"
          >
            {isWorking ? confirmInProgressLabel : confirmLabel}
          </Button>
          <Button
            onClick={onConfirmCancel}
            disabled={isWorking}
            variant="ghost"
            size="sm"
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
