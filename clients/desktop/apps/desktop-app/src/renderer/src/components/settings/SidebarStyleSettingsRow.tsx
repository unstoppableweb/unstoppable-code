import { useEffect, type JSX } from 'react';
import { SidebarStylePicker, ErrorBanner } from '@canopy/ui-shared/components';
import {
  ensureLabsExperimentsSubscription,
  setLabsExperimentChoice,
  useLabsExperimentsStore,
} from '@/stores/labsExperimentsStore';
import { SettingsRow } from './SettingsLayout';

/** Appearance owns the control; the existing account service remains its writer. */
export function SidebarStyleSettingsRow(): JSX.Element | null {
  const snapshot = useLabsExperimentsStore((state) => state.snapshot);
  const pending = useLabsExperimentsStore((state) => state.pending);
  const error = useLabsExperimentsStore((state) => state.errors.sidebar);
  useEffect(() => {
    ensureLabsExperimentsSubscription();
  }, []);
  const entry = snapshot?.experiments.find(
    (experiment) => experiment.id === 'sidebar',
  );
  if (snapshot?.ready && entry && !entry.listed) return null;
  const saving = Object.prototype.hasOwnProperty.call(pending, 'sidebar');
  const compact = saving ? pending.sidebar === true : entry?.enabled === true;
  return (
    <SettingsRow
      contentGap="block"
      label="Sidebar style"
      description={
        compact
          ? 'Chat titles, status and activity ages.'
          : 'Branch and pull request details.'
      }
      dataTestId="settings-sidebar-style-row"
      control={
        <SidebarStylePicker
          value={compact ? 'compact' : 'advanced'}
          disabled={
            !snapshot?.ready || !snapshot.choicesReady || !entry || saving
          }
          busy={saving}
          onChange={(style) => {
            void setLabsExperimentChoice('sidebar', style === 'compact');
          }}
        />
      }
    >
      <ErrorBanner
        errorSource="sidebar-style-settings-row"
        error={error}
        className=""
      />
    </SettingsRow>
  );
}
