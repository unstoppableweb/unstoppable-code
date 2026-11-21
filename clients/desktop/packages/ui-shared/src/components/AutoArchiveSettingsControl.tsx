import { Stack } from './Stack';
import {
  useId,
  useState,
  type ComponentProps,
  type JSX,
  type ReactNode,
} from 'react';
import { TextInput } from './Field';
import { SettingsRowsRow, SettingsRowsSubRow } from './settings/SettingsRows';
import { ToggleSwitch } from './ToggleSwitch';

export interface AutoArchiveSettingsControlProps {
  readonly enabled: boolean;
  readonly days: number;
  readonly maxDays: number;
  readonly fallbackDays: number;
  readonly description: string;
  readonly toggleTestId: string;
  readonly daysTestId: string;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onDaysChange: (days: number) => void;
  readonly daysLabel?: string;
  /**
   * @deprecated The control now uses the Settings row text sizes; kept so
   * existing callers compile.
   */
  readonly textSize?: 's' | 'sm';
  readonly children?: ReactNode;
}

/**
 * Callback-driven Auto Delete settings shared by desktop and portal hosts:
 * a Settings row with the on/off switch, and, while it is on, the inactivity
 * period as a dependent sub-row followed by the host's own options.
 */
export function AutoArchiveSettingsControl({
  enabled,
  days,
  maxDays,
  fallbackDays,
  description,
  toggleTestId,
  daysTestId,
  onEnabledChange,
  onDaysChange,
  daysLabel = 'days of inactivity',
  children,
}: AutoArchiveSettingsControlProps): JSX.Element {
  const switchId = useId();
  const daysId = useId();
  return (
    <div className="pt-4">
      <SettingsRowsRow
        label="Auto delete"
        htmlFor={switchId}
        description={description}
        control={
          <ToggleSwitch
            id={switchId}
            checked={enabled}
            label="Auto delete"
            onChange={onEnabledChange}
            dataTestId={toggleTestId}
          />
        }
      >
        {enabled ? (
          <Stack gap="item">
            <SettingsRowsSubRow
              label="After"
              htmlFor={daysId}
              control={
                <>
                  <div className="w-20">
                    <DaysInput
                      id={daysId}
                      value={days}
                      maxDays={maxDays}
                      fallbackDays={fallbackDays}
                      onDaysChange={onDaysChange}
                      data-testid={daysTestId}
                    />
                  </div>
                  <span className="text-s fg-secondary">{daysLabel}</span>
                </>
              }
            />
            {children}
          </Stack>
        ) : null}
      </SettingsRowsRow>
    </div>
  );
}

type DaysInputProps = Omit<
  ComponentProps<typeof TextInput>,
  'type' | 'value' | 'onChange' | 'onBlur' | 'min' | 'max' | 'density'
> & {
  readonly value: number;
  readonly maxDays: number;
  readonly fallbackDays: number;
  readonly onDaysChange: (days: number) => void;
};

/**
 * A whole number of days from 1 to `maxDays`. The text stays as typed while
 * the field has focus, so it can be cleared and retyped, but the host always
 * holds the clamped value (`fallbackDays` when the text is not a number), so
 * a save that never leaves the field still saves a valid value. Leaving the
 * field shows the value the host holds.
 */
export function DaysInput({
  value,
  maxDays,
  fallbackDays,
  onDaysChange,
  ...props
}: DaysInputProps): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <TextInput
      {...props}
      density="settings"
      type="number"
      value={draft ?? value}
      onChange={(event) => {
        setDraft(event.target.value);
        onDaysChange(
          Math.max(
            1,
            Math.min(
              maxDays,
              Number.parseInt(event.target.value, 10) || fallbackDays,
            ),
          ),
        );
      }}
      onBlur={() => setDraft(null)}
      min={1}
      max={maxDays}
    />
  );
}
