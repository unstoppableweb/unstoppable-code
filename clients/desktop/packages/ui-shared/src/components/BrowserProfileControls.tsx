import type { CSSProperties, JSX } from 'react';
import { ToggleSwitch } from '../primitives/ToggleSwitch';
import { SettingsRowsRow } from './settings/SettingsRows';

export interface BrowserProfileBadgeProps {
  name: string;
  color?: string;
  unavailable?: boolean;
  /**
   * Applied to the wrapper. Placement and truncation width only: the label
   * ink, dot geometry, and gap stay owned here so every surface that shows a
   * profile renders the same mark.
   */
  className?: string;
  /**
   * Drops the native `title`. Only for a caller that already wraps the badge
   * in a richer tooltip carrying the same name — the browser bar's picker
   * trigger — where the two would otherwise stack on one hover.
   */
  titleSuppressed?: boolean;
}

/**
 * Profile identity mark: a color dot plus the profile name.
 *
 * The dot is the one place a user-chosen color reaches the interface. It is a
 * fixed 8px disc that never carries text, so an arbitrary hue cannot create a
 * contrast failure the way tinted copy or a tinted surface would. When no
 * color is set the dot falls back to the accent role rather than to a literal.
 */
export function BrowserProfileBadge({
  name,
  color,
  unavailable = false,
  className = '',
  titleSuppressed = false,
}: BrowserProfileBadgeProps): JSX.Element {
  const dotStyle: CSSProperties | undefined = color
    ? { backgroundColor: color }
    : undefined;
  // The label truncates wherever it is placed, so the full text has to stay
  // reachable on hover. It titles what is actually shown: an unavailable
  // profile reads "Unavailable profile" deliberately, and the tooltip must
  // not be the one place its real name resurfaces.
  const label = unavailable ? 'Unavailable profile' : name;
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}
      title={titleSuppressed ? undefined : label}
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full bg-accent"
        style={dotStyle}
      />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

export interface BrowserProfilePermissionsProps {
  task: boolean;
  allowEnable: boolean;
  allowClear: boolean;
  disabled?: boolean;
  onEnableChange: (value: boolean) => void;
  onClearChange: (value: boolean) => void;
}

export function BrowserProfilePermissions({
  task,
  allowEnable,
  allowClear,
  disabled,
  onEnableChange,
  onClearChange,
}: BrowserProfilePermissionsProps): JSX.Element {
  // Two rows of the host's settings group: each permission is its own row.
  return (
    <>
      <Permission
        label="Allow agent to enable this profile"
        value={task || allowEnable}
        disabled={disabled || task}
        description={
          task
            ? 'Always enabled for Task profiles.'
            : 'Agents may open new tabs with this profile. Existing tabs remain usable when this is off.'
        }
        onChange={onEnableChange}
      />
      <Permission
        label="Allow agents to clear this profile"
        value={allowClear}
        disabled={disabled}
        description="Agents may clear browser cache or site data and reset this profile. This is independent of opening tabs."
        onChange={onClearChange}
      />
    </>
  );
}

interface PermissionProps {
  label: string;
  description: string;
  value: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}

function Permission({
  label,
  description,
  value,
  disabled,
  onChange,
}: PermissionProps): JSX.Element {
  return (
    <SettingsRowsRow
      label={label}
      description={description}
      control={
        <ToggleSwitch
          checked={value}
          disabled={disabled}
          label={label}
          onChange={onChange}
        />
      }
    />
  );
}
