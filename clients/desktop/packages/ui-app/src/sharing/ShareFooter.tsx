import type { JSX, ReactNode } from 'react';
import { Surface, Button, LoadingButton } from '@canopy/ui-shared/components';

/** A second footer action between Cancel and the primary. */
export interface ShareFooterSecondaryAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly testId: string;
}

/**
 * A destructive action on the share itself (Stop sharing). It takes the
 * footer's left side, and `leading` moves to the right before the primary.
 */
export interface ShareFooterDestructiveAction extends ShareFooterSecondaryAction {
  /** The action's own work is running: the footer is locked. */
  readonly busy?: boolean;
}

interface ShareFooterProps {
  onCancel: () => void;
  showCancel?: boolean;
  cancelLabel?: string;
  cancelDisabled?: boolean;
  cancelTestId?: string;
  showPrimary: boolean;
  onSubmit: () => void;
  submitLabel: string;
  submitDisabled?: boolean;
  /** The primary's work is running: spinner inside the button, label swap. */
  loading?: boolean;
  /** Primary label while `loading`, e.g. `Sharing…`. */
  loadingLabel?: string;
  /** A generic second action, rendered before the primary. */
  secondaryAction?: ShareFooterSecondaryAction;
  /**
   * The footer's left side: the package stage while sharing, otherwise the
   * Copy link button when the resource has a link.
   */
  leading?: ReactNode;
  /** Rendered first on the left; pushes `leading` to the right group. */
  destructiveAction?: ShareFooterDestructiveAction;
  testIdPrefix: string;
  submitTestId?: string;
}

export function ShareFooter({
  onCancel,
  showCancel = true,
  cancelLabel = 'Cancel',
  cancelDisabled = false,
  cancelTestId,
  showPrimary,
  onSubmit,
  submitLabel,
  submitDisabled = false,
  loading = false,
  loadingLabel,
  secondaryAction: secondary,
  leading,
  destructiveAction: destructive,
  testIdPrefix,
  submitTestId,
}: ShareFooterProps): JSX.Element {
  const destructiveBusy = destructive?.busy === true;
  return (
    <Surface variant="section" boundary="top">
      <div
        className="flex items-center gap-2 px-6 py-3"
        data-testid={`${testIdPrefix}-footer`}
      >
        <div className="flex min-w-0 flex-1 items-center">
          {destructive ? (
            // The shared Button has no destructive outline variant; the
            // ghost destructive one keeps the destructive ink without
            // competing with the primary (CAN-5904).
            <Button
              type="button"
              variant="ghost-destructive"
              size="compact"
              data-testid={destructive.testId}
              onClick={destructive.onClick}
              disabled={destructive.disabled === true || loading}
              aria-busy={destructiveBusy}
            >
              {destructive.label}
            </Button>
          ) : (
            leading
          )}
        </div>
        {destructive && leading}
        {showCancel && (
          <Button
            type="button"
            variant="secondary"
            size="compact"
            data-testid={cancelTestId}
            onClick={onCancel}
            disabled={cancelDisabled || loading || destructiveBusy}
          >
            {cancelLabel}
          </Button>
        )}
        {secondary && (
          <Button
            type="button"
            variant="secondary"
            size="compact"
            data-testid={secondary.testId}
            onClick={secondary.onClick}
            disabled={secondary.disabled === true || loading}
          >
            {secondary.label}
          </Button>
        )}
        {showPrimary && (
          <LoadingButton
            variant="primary"
            size="compact"
            data-testid={submitTestId ?? `${testIdPrefix}-submit`}
            onClick={onSubmit}
            disabled={submitDisabled}
            loading={loading}
            {...(loadingLabel !== undefined ? { loadingLabel } : {})}
            spinnerTestId={`${testIdPrefix}-submit-spinner`}
          >
            {submitLabel}
          </LoadingButton>
        )}
      </div>
    </Surface>
  );
}
