'use client';

import type { JSX, ReactNode } from 'react';
import { SettingsSelect } from '../primitives/SettingsSelect';

export interface AppearanceOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly preview?: ReactNode;
  readonly testId?: string;
}

/**
 * Compact appearance dropdown; the host supplies theme previews and
 * persistence. It is the shared Settings dropdown with an accessible name.
 */
export function AppearanceSelect<Value extends string>({
  label,
  value,
  options,
  onChange,
  testId,
  disabled = false,
  busy = false,
}: {
  readonly label: string;
  readonly value: Value;
  readonly options: readonly AppearanceOption<Value>[];
  readonly onChange: (value: Value) => void;
  readonly testId: string;
  readonly disabled?: boolean;
  readonly busy?: boolean;
}): JSX.Element {
  return (
    <SettingsSelect
      aria-label={label}
      value={value}
      options={options}
      onValueChange={onChange}
      data-testid={testId}
      disabled={disabled}
      busy={busy}
    />
  );
}
