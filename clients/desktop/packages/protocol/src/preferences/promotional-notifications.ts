import type {
  PromotionalNotificationCategory,
  PromotionalNotificationPreferences,
} from './types';

/**
 * Promotional notification hierarchy (CAN-3013): one master and one
 * category. Pure and browser-safe so main's send gate and the Settings UI
 * answer "is this category on" with the same function.
 */
export const DEFAULT_PROMOTIONAL_NOTIFICATIONS: PromotionalNotificationPreferences =
  {
    enabled: true,
    arbitrary: true,
  };

/**
 * The master gates its category without touching them. A child's stored
 * value is the user's own choice and survives the master being switched off,
 * so switching it back on restores exactly what they had selected.
 */
export function isPromotionalCategoryEnabled(
  preferences: PromotionalNotificationPreferences,
  category: PromotionalNotificationCategory,
): boolean {
  return preferences.enabled && preferences[category];
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * `legacyActivationCategoryEnabled` is the pre-CAN-3013 OS `activation`
 * category, which gated every promotional send on its own. It seeds the
 * category only while no hierarchy has been saved, so an existing opt-out
 * carries over and nobody is re-enrolled by the upgrade. Once a value exists
 * the hierarchy is authoritative and the legacy category is never consulted.
 */
export function normalizePromotionalNotifications(
  value: unknown,
  legacyActivationCategoryEnabled: boolean,
): PromotionalNotificationPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      enabled: DEFAULT_PROMOTIONAL_NOTIFICATIONS.enabled,
      arbitrary: legacyActivationCategoryEnabled,
    };
  }
  const raw: Record<string, unknown> = { ...value };
  return {
    enabled: readBoolean(
      raw.enabled,
      DEFAULT_PROMOTIONAL_NOTIFICATIONS.enabled,
    ),
    arbitrary: readBoolean(
      raw.arbitrary,
      DEFAULT_PROMOTIONAL_NOTIFICATIONS.arbitrary,
    ),
  };
}
