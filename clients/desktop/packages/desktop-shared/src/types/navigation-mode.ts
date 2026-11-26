import type { NavigationMode } from '@canopy/protocol/preferences';
export { NAVIGATION_MODES } from '@canopy/protocol/preferences';
export type { NavigationMode } from '@canopy/protocol/preferences';

export function isNavigationMode(value: unknown): value is NavigationMode {
  return value === 'code' || value === 'work';
}
