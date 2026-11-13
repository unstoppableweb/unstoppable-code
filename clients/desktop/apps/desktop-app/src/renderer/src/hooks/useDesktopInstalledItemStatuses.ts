import { useMemo } from 'react';
import {
  useInstalledItemStatuses,
  type InstalledItemStatusController,
  type InstalledItemStatusSource,
} from '@canopy/ui-shared';
import { SKILLS_CHANGED_EVENT } from '@/lib/skillsChanged';

/**
 * Desktop transport for installed-item status (CAN-4255): the preload
 * `installedItems` bridge, refetched on its change event and on the renderer
 * skills-changed event, which a renderer-initiated install (a shared skill,
 * CAN-5309) fires without `installed-items:changed`. Absent in renderer
 * contexts without the bridge, where status renders read-only.
 */
function desktopInstalledItemSource(): InstalledItemStatusSource | null {
  const api = typeof window === 'undefined' ? undefined : window.installedItems;
  if (!api) return null;
  return {
    listStatus: () => api.listStatus(),
    setStatus: (request) => api.setStatus(request),
    uninstall: (request) => api.uninstall(request),
    subscribe: (onChange) => {
      const unsubscribe = api.onChanged(onChange);
      const unsubscribePreferences =
        window.api?.onPreferencesChanged?.(onChange);
      // A plain preferences save (new global selections, for example) only
      // broadcasts the synced preferences, so Active must reread on it too.
      const unsubscribeSynced = window.api?.onPreferencesSynced?.(() =>
        onChange(),
      );
      const onSkillsChanged = (): void => onChange();
      window.addEventListener(SKILLS_CHANGED_EVENT, onSkillsChanged);
      return () => {
        window.removeEventListener(SKILLS_CHANGED_EVENT, onSkillsChanged);
        unsubscribe();
        unsubscribePreferences?.();
        unsubscribeSynced?.();
      };
    },
  };
}

/**
 * `enabled: false` skips the read while the surface is hidden; the provider
 * enumeration behind it is not free.
 */
export function useDesktopInstalledItemStatuses(
  enabled = true,
): InstalledItemStatusController {
  // One stable source while enabled, so the shared hook loads once and then
  // follows change events.
  const source = useMemo(
    () => (enabled ? desktopInstalledItemSource() : null),
    [enabled],
  );
  return useInstalledItemStatuses(
    source,
    'Status is unavailable in this window.',
  );
}
