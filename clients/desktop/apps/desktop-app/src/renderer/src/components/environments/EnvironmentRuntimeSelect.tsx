import { type JSX } from 'react';
import { SettingsSelect, useInFormField } from '@canopy/ui-shared/components';
import type { EnvironmentDefinitionView } from '@canopy/desktop-shared/types';

export interface EnvironmentRuntimeSelectOption {
  /**
   * Stable id stored in the underlying assignment. Use `null` for the
   * "global default" sentinel (workspace surfaces) so the parent can omit
   * the runtime key from the saved assignment.
   */
  id: string | null;
  label: string;
}

interface EnvironmentRuntimeSelectProps {
  /** All environments the user can pick from. Already in display order. */
  environments: ReadonlyArray<EnvironmentDefinitionView>;
  /** Optional `null`-valued option appended at the top — e.g. "Global default". */
  fallbackOption?: EnvironmentRuntimeSelectOption;
  /** Currently selected id. `null` selects the fallback (when provided). */
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
  testId?: string;
  ariaLabel?: string;
  /**
   * Both open Canopy's menu on the 28px dropdown. `field` fills its column.
   * `settings` takes a Settings row's 208px control width. Deliberate
   * deviation from DESIGN.md's 144px row dropdown (project settings,
   * Environment page): environment names are long and the design review
   * lab sets these menus at 208px.
   */
  variant?: 'field' | 'settings';
}

const FALLBACK_VALUE = '__fallback__';

/**
 * Generic environment selector used by both the global runtime defaults
 * widget in Settings → Environments and the workspace Environment tab. The
 * `fallbackOption` keeps the workspace surface from inventing a sentinel
 * id — `null` cleanly maps to "remove this key from the assignment."
 */
export function EnvironmentRuntimeSelect({
  environments,
  fallbackOption,
  value,
  onChange,
  disabled,
  testId,
  ariaLabel,
  variant = 'field',
}: EnvironmentRuntimeSelectProps): JSX.Element {
  const inDialog = useInFormField();
  const selected =
    value === null && fallbackOption ? FALLBACK_VALUE : (value ?? '');

  const choose = (next: string): void => {
    if (next === FALLBACK_VALUE) {
      onChange(null);
      return;
    }
    onChange(next.length > 0 ? next : null);
  };

  return (
    // `settings`: a Settings row column, or the full width of a dialog's form
    // field. `field`: the full width of its column.
    <span
      className={`inline-flex ${
        variant === 'settings' && !inDialog ? 'w-52 shrink-0' : 'w-full'
      }`}
    >
      <SettingsSelect
        width="fill"
        value={selected}
        onValueChange={choose}
        disabled={disabled === true}
        aria-label={ariaLabel}
        data-testid={testId}
        options={[
          ...(fallbackOption
            ? [{ value: FALLBACK_VALUE, label: fallbackOption.label }]
            : []),
          ...environments.map((environment) => ({
            value: environment.id,
            label: `${environment.name}${environment.isDefault ? ' (default)' : ''}`,
          })),
        ]}
      />
    </span>
  );
}
