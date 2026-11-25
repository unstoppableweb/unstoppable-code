import { useId, useState, type JSX } from 'react';
import {
  AI_CREDITS_ROUTING_MODES,
  type AiCreditsRoutingMode,
  type CanopyApi,
} from '@canopy/desktop-shared/types';
import {
  FieldError,
  SettingsSelect,
  type SettingsSelectOption,
} from '@canopy/ui-shared/components';
import { invalidateAiCreditsUsageCache } from '@/hooks/useAiCreditsUsage';
import { ClaudeConnectorRoutingSettingNote } from './ClaudeConnectorRoutingSettingNote';
import { SettingsRow } from './SettingsLayout';

const WAIT_OPTION: SettingsSelectOption = { value: 'off', label: 'Wait' };
const ON_QUOTA_OPTION: SettingsSelectOption = {
  value: 'on-quota',
  label: 'Use credits automatically',
};
/** Shown only while the stored value is already `on`; no UI writes it. */
const ALWAYS_OPTION: SettingsSelectOption = {
  value: 'on',
  label: 'Always use credits',
};

function isRoutingMode(value: string): value is AiCreditsRoutingMode {
  return AI_CREDITS_ROUTING_MODES.some((mode) => mode === value);
}

/**
 * "When a usage limit is reached" (CAN-6860): the device preference the
 * usage-limit notice's "Always" used to write. It reads and writes the same
 * `aiCreditsRoutingMode` preference through the existing preferences calls,
 * and never rewrites a value the user hasn't changed: a stored `on` keeps
 * its own option, and an unknown value shows as Wait until the user picks.
 */
export function UsageLimitRoutingRow({
  stored,
}: {
  /** The persisted value, as the page loaded it. */
  readonly stored: AiCreditsRoutingMode | undefined;
}): JSX.Element {
  const [value, setValue] = useState<AiCreditsRoutingMode | undefined>(stored);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const errorId = useId();
  const options: readonly SettingsSelectOption[] =
    value === 'on'
      ? [WAIT_OPTION, ON_QUOTA_OPTION, ALWAYS_OPTION]
      : [WAIT_OPTION, ON_QUOTA_OPTION];
  const shown = value === 'on' || value === 'on-quota' ? value : 'off';
  return (
    <SettingsRow
      label="When a usage limit is reached"
      description={
        failed ? (
          <FieldError
            id={errorId}
            announce
            data-testid="settings-usage-limit-routing-error"
          >
            Couldn&rsquo;t save this setting. Try again.
          </FieldError>
        ) : (
          'Keep going on credits when a subscription hits its limit. Credits are used only when you have them.'
        )
      }
      dataTestId="settings-usage-limit-routing"
      control={
        <span className="inline-flex w-56">
          <SettingsSelect
            width="fill"
            data-testid="settings-usage-limit-routing-select"
            {...(failed ? { 'aria-describedby': errorId } : {})}
            options={options}
            value={shown}
            disabled={saving}
            onValueChange={(next): void => {
              if (!isRoutingMode(next) || next === value) return;
              const previous = value;
              setValue(next);
              setSaving(true);
              setFailed(false);
              const api: CanopyApi = window.api;
              void api.savePreferences({ aiCreditsRoutingMode: next }).then(
                () => {
                  setSaving(false);
                  // Open chats read the mode from the usage cache; refresh it
                  // so a chat follows this change now, not after the cache
                  // expires (CAN-7062).
                  invalidateAiCreditsUsageCache();
                },
                () => {
                  // Show the stored value again, never the one that failed.
                  setValue(previous);
                  setSaving(false);
                  setFailed(true);
                },
              );
            }}
          />
        </span>
      }
    >
      <ClaudeConnectorRoutingSettingNote route="ai-credits" />
    </SettingsRow>
  );
}
