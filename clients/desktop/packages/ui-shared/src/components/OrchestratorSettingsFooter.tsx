import type { JSX, ReactNode } from 'react';
import { Button } from './Button';
import { Surface } from './Surface';

export function OrchestratorSettingsFooter({
  disabled,
  error,
  label,
  onSave,
  testId,
}: {
  disabled: boolean;
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
        <Button
          variant="primary"
          size="compact"
          disabled={disabled}
          onClick={onSave}
          data-testid={testId}
        >
          {label}
        </Button>
      </div>
    </Surface>
  );
}
