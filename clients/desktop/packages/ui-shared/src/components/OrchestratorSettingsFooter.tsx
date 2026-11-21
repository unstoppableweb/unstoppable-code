import type { JSX, ReactNode } from 'react';
import { LoadingButton } from './LoadingButton';
import { Surface } from './Surface';

export function OrchestratorSettingsFooter({
  disabled,
  busy = false,
  error,
  label,
  onSave,
  testId,
}: {
  disabled: boolean;
  /** The save is running: the spinner sits inside the button at its width. */
  busy?: boolean;
  error?: ReactNode;
  label: string;
  onSave: () => void;
  testId: string;
}): JSX.Element {
  return (
    <Surface
      variant="section"
      boundary="top"
      padding="dialog-footer"
      gap="item"
    >
      {error}
      <div className="flex items-center justify-end">
        <LoadingButton
          variant="primary"
          size="compact"
          loading={busy}
          loadingLabel="Saving…"
          disabled={disabled && !busy}
          onClick={onSave}
          data-testid={testId}
        >
          {label}
        </LoadingButton>
      </div>
    </Surface>
  );
}
