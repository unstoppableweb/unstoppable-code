import {
  CONFIG_DOCUMENT_DROPPED_KEYS,
  CONFIG_DOCUMENT_REFUSED_KEYS,
} from './document';

/*
 * The preference save rules (CAN-7935, slice K of CAN-5722): what a generic
 * preferences save may write. Electron's `savePreferencesPatch` runs them
 * today; the daemon's `core.config.document.update` is to reuse this module,
 * never a copy.
 * Generic over the patch type: the rules read keys and value kinds only.
 */

export type PreferenceSaveRefusedKey =
  (typeof CONFIG_DOCUMENT_REFUSED_KEYS)[number];

export type PreferenceSaveRulesResult<P extends object> =
  | {
      /** The patch to write: a copy of the caller's without `dropped`. */
      readonly patch: Partial<P>;
      /** The caller's keys the rules removed, in the patch's order. */
      readonly dropped: readonly string[];
    }
  | {
      /** The first refused key the patch holds; nothing may be written. */
      readonly refused: PreferenceSaveRefusedKey;
    };

/** The preference keys `core.terminal.settings.*` owns (CAN-4148). */
export const TERMINAL_SETTINGS_PREFERENCE_KEYS = [
  'disabledTerminalShellProfileIds',
  'terminalPresets',
] as const;

/** The preference key holding the global plugin defaults (CAN-5766). */
export const GLOBAL_PLUGIN_DEFAULTS_PREFERENCE_KEY = 'globalPluginSelections';

const hasKey = (patch: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(patch, key);

/**
 * Whether a generic save is the legacy terminal settings intent: exactly the
 * two settings keys, as Settings > Terminal sent them before CAN-4148.
 */
export function isLegacyTerminalSettingsSave(preferences: object): boolean {
  const keys = Object.keys(preferences);
  return (
    keys.length === TERMINAL_SETTINGS_PREFERENCE_KEYS.length &&
    TERMINAL_SETTINGS_PREFERENCE_KEYS.every((key) => hasKey(preferences, key))
  );
}

/**
 * Removes terminal settings from a generic save unless `preferences` is the
 * legacy intent, and always removes the revision. Mutates `patch`.
 */
export function applyTerminalSettingsSaveRule(
  preferences: object,
  patch: object,
): void {
  Reflect.deleteProperty(patch, 'terminalSettingsRevision');
  if (isLegacyTerminalSettingsSave(preferences)) return;
  for (const key of TERMINAL_SETTINGS_PREFERENCE_KEYS)
    Reflect.deleteProperty(patch, key);
}

/**
 * Whether a generic save is the intent to change the global plugin defaults:
 * a patch whose only key is `globalPluginSelections`, as every writer sends it.
 */
export function isGlobalPluginDefaultsSave(preferences: object): boolean {
  const keys = Object.keys(preferences);
  return keys.length === 1 && keys[0] === GLOBAL_PLUGIN_DEFAULTS_PREFERENCE_KEY;
}

/**
 * Removes the global plugin defaults from a generic save unless `preferences`
 * is the one-key intent: a wider patch may carry a stale copy read before the
 * core catalog or another window changed them. Mutates `patch`.
 */
export function applyGlobalPluginDefaultsSaveRule(
  preferences: object,
  patch: object,
): void {
  if (isGlobalPluginDefaultsSave(preferences)) return;
  Reflect.deleteProperty(patch, GLOBAL_PLUGIN_DEFAULTS_PREFERENCE_KEY);
}

/** A one-key save of a boolean: the only shape that may change `key`. */
function isOneKeyBooleanIntent(patch: object, key: string): boolean {
  return (
    Object.keys(patch).length === 1 &&
    typeof Reflect.get(patch, key) === 'boolean'
  );
}

/**
 * Runs the rules on a caller's patch, as sent: the one-key and two-key
 * intents count every key it holds, `usageData` and client-local keys
 * included. Rule 1 refuses a patch holding a key with its own typed owner.
 * Rule 2 drops main-owned records a snapshot may hold an old copy of. Rule 3
 * keeps a shape-guarded key only in its exact intent: a wider snapshot may
 * predate a change made elsewhere. Never mutates `patch`.
 */
export function applyPreferenceSaveRules<P extends object>(
  patch: P,
): PreferenceSaveRulesResult<P> {
  const refused = CONFIG_DOCUMENT_REFUSED_KEYS.find((key) =>
    hasKey(patch, key),
  );
  if (refused !== undefined) return { refused };
  const next: Partial<P> = { ...patch };
  // Each has a typed writer: main's native account tracking (CAN-4200), the
  // Copilot connection with its account pin (CAN-4880), the dedicated
  // suggestions command, the approval authority, and
  // accountProxy.setRoutingStrategy.
  for (const key of CONFIG_DOCUMENT_DROPPED_KEYS)
    Reflect.deleteProperty(next, key);
  // A wider snapshot may predate a disconnect in another window.
  if (!isOneKeyBooleanIntent(patch, 'googleSubscriptionDisconnected'))
    Reflect.deleteProperty(next, 'googleSubscriptionDisconnected');
  // An older controller sends the suggestions master as this exact intent.
  if (!isOneKeyBooleanIntent(patch, 'repeatTaskAutomationSuggestionsEnabled'))
    Reflect.deleteProperty(next, 'repeatTaskAutomationSuggestionsEnabled');
  // Shells and presets belong to core.terminal.settings (CAN-4148).
  applyTerminalSettingsSaveRule(patch, next);
  // Global plugin defaults also change through core.catalog (CAN-4123).
  applyGlobalPluginDefaultsSaveRule(patch, next);
  return {
    patch: next,
    dropped: Object.keys(patch).filter((key) => !hasKey(next, key)),
  };
}

/** Who may make an internal preference write. */
export type PreferenceWriteAdmission = 'open' | 'owner';

/**
 * For internal writers only: whether a write the host itself builds may take
 * the open path (`open`: the rules would write it as sent) or needs the owner
 * path (`owner`: the rules would refuse it or drop a key). Caller-supplied
 * patches (the renderer, Remote Control, `core.config.update`) are always
 * open and run `applyPreferenceSaveRules`; never classify them.
 */
export function classifyPreferenceWrite(
  patch: object,
): PreferenceWriteAdmission {
  const result = applyPreferenceSaveRules(patch);
  return 'refused' in result || result.dropped.length > 0 ? 'owner' : 'open';
}

/**
 * Merges a usage-data patch over the stored switches per key, so a partial
 * patch never turns the flows it omits back on through their defaults.
 */
export function mergeUsageDataPatch<U extends object>(
  stored: U,
  patch: Partial<U>,
): U {
  return { ...stored, ...patch };
}
