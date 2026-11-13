import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { SharedImportPort } from '@canopy/desktop-shared/lib/shared-import/port';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/** Whether scoped skill installs are receipt-bound (context enforcement). */
export function sharedSkillReceiptsEnforced(): boolean {
  return useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key);
}

/** The window's preload APIs, read when an import runs. */
export function rendererSharedImportPort(): SharedImportPort {
  return {
    skills: window.skills,
    plugins: window.plugins,
    receiptsEnforced: sharedSkillReceiptsEnforced,
  };
}
