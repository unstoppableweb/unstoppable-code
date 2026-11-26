import { TERMINAL_SETTINGS_PREFERENCE_KEYS } from '@canopy/protocol/canopy-core/core';
import type { PreferencesData } from '../../types';

// The save rule lives with the other preference save rules (CAN-7935).
export {
  TERMINAL_SETTINGS_PREFERENCE_KEYS,
  applyTerminalSettingsSaveRule,
  isLegacyTerminalSettingsSave,
} from '@canopy/protocol/canopy-core/core';

/** A stored revision, or 0 when it is missing or not a non-negative safe integer. */
export function normalizeTerminalSettingsRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

type TerminalSettingsFields = Pick<
  PreferencesData,
  | (typeof TERMINAL_SETTINGS_PREFERENCE_KEYS)[number]
  | 'terminalSettingsRevision'
>;

/** The revision `next` commits: one more than `existing`'s when shells or presets changed. */
export function nextTerminalSettingsRevision(
  existing: TerminalSettingsFields,
  next: TerminalSettingsFields,
): number {
  const changed = TERMINAL_SETTINGS_PREFERENCE_KEYS.some(
    (key) => JSON.stringify(existing[key]) !== JSON.stringify(next[key]),
  );
  return changed
    ? existing.terminalSettingsRevision + 1
    : existing.terminalSettingsRevision;
}
