// The save rule lives with the other preference save rules (CAN-7935).
export {
  TERMINAL_SETTINGS_PREFERENCE_KEYS,
  applyTerminalSettingsSaveRule,
  isLegacyTerminalSettingsSave,
} from '@canopy/protocol/canopy-core/core';

/** Compatibility path: the revision functions live in `@canopy/core-runtime/node/preferences/domain`. */
export {
  normalizeTerminalSettingsRevision,
  nextTerminalSettingsRevision,
} from '@canopy/core-runtime/node/preferences/domain';
