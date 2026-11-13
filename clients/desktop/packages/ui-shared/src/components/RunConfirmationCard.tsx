import type { JSX, ReactNode } from 'react';
import { Button } from './Button';
import { Inline } from './Stack';
import { Surface } from './Surface';

export interface RunConfirmationCardProps {
  /** Prompt copy — typically "Run <label>?". Caller supplies the sentence so
   * the displayed label can vary per section. */
  prompt: ReactNode;
  /** Section-specific details — script command preview, hook action list,
   * etc. Pre-formatted by the caller, as `inset` wells. */
  details: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional override for the confirm button label. */
  confirmLabel?: string;
  /** Optional override for the cancel button label. */
  cancelLabel?: string;
}

/**
 * Inline confirmation rendered in place of a row when a manual run is
 * awaiting confirmation: a pending-input form, so a neutral `group` box
 * (docs/design/surfaces.md), with Cancel then Run at its end. Pure display.
 */
export function RunConfirmationCard({
  prompt,
  details,
  onConfirm,
  onCancel,
  confirmLabel = 'Run',
  cancelLabel = 'Cancel',
}: RunConfirmationCardProps): JSX.Element {
  return (
    <Surface variant="group" padding="tight" gap="inline">
      <p className="text-xs fg-primary">{prompt}</p>
      {details === undefined || details === null ? null : <div>{details}</div>}
      <Inline gap="inline" justify="end">
        <Button size="compact" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant="primary" size="compact" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </Inline>
    </Surface>
  );
}
