'use client';

import type { JSX } from 'react';
import { Button, type ButtonSize } from './Button';
import { useItemStateMarks } from './ItemStateMark';

interface PluginConfigurationButtonProps {
  onConfigure: () => void;
  disabled?: boolean;
  /** `control` matches the 28px detail action bar beside Share. */
  size?: ButtonSize;
}

export function PluginConfigurationButton({
  onConfigure,
  disabled = false,
  size,
}: PluginConfigurationButtonProps): JSX.Element {
  // New Customize (the `customize-discovery` Labs experiment) names it Edit.
  const newCustomize = useItemStateMarks();
  return (
    <Button
      variant="secondary"
      size={size}
      data-testid="plugin-advanced-configuration"
      onClick={onConfigure}
      disabled={disabled}
    >
      {newCustomize ? 'Edit' : 'Advanced configuration'}
    </Button>
  );
}
