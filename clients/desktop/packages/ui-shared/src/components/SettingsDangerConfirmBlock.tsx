import { Heading } from '../primitives/Heading';
import { Children, useRef, type JSX, type ReactNode } from 'react';
import { Button } from '../primitives/Button';
import { ConfirmDialog } from '../primitives/ConfirmDialog';
import { Stack } from '../primitives/Stack';

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
  /** The confirm dialog is open: the action is in flight (`isWorking` true)
   * or awaiting the answer. */
  confirming: boolean;
  onConfirmStart: () => void;
  onConfirmCancel: () => void;
  /** The dialog's action. It shows `confirmInProgressLabel` and the dialog
   * stays open while `isWorking` is true. */
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
   * for `destructive`).
   */
  surface?: 'card' | 'row';
}

/**
 * Single confirm pattern used for "Delete project/workspace" and
 * "Convert to single/multi-repo" sections in both modals. The trigger opens a
 * `ConfirmDialog`; focus returns to the trigger when it closes.
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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialog = confirming ? (
    <ConfirmDialog
      title={`${title}?`}
      message={description}
      confirmLabel={confirmLabel}
      busyLabel={confirmInProgressLabel}
      busy={isWorking}
      destructive={variant === 'destructive'}
      onConfirm={onConfirm}
      onCancel={onConfirmCancel}
      restoreFocusRef={triggerRef}
    >
      {warningItems.length > 0 ? (
        <Stack gap="tight">{warningItems}</Stack>
      ) : null}
    </ConfirmDialog>
  ) : null;
  if (surface === 'row') {
    return (
      <div className="flex min-h-10 items-center justify-between gap-x-6 gap-y-2 max-sm:flex-wrap">
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
          <Button
            ref={triggerRef}
            onClick={onConfirmStart}
            disabled={triggerDisabled || isWorking}
            variant={variant === 'destructive' ? 'ghost-destructive' : 'ghost'}
            size="compact"
          >
            {triggerLabel}
          </Button>
        </div>
        {dialog}
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
      <Button
        ref={triggerRef}
        onClick={onConfirmStart}
        disabled={triggerDisabled || isWorking}
        variant={variant === 'destructive' ? 'destructive' : 'secondary'}
        size="sm"
        className="self-start"
      >
        {triggerLabel}
      </Button>
      {dialog}
    </div>
  );
}
