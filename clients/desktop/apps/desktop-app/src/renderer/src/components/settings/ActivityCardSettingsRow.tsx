import { useEffect, type JSX } from 'react';
import { ToggleSwitch, ErrorBanner } from '@canopy/ui-shared/components';
import {
  ensureLabsExperimentsSubscription,
  setLabsExperimentChoice,
  useLabsExperimentsStore,
} from '@/stores/labsExperimentsStore';
import { SettingsRow } from './SettingsLayout';

/** Appearance owns the control; the existing account service remains its writer. */
export function ActivityCardSettingsRow(): JSX.Element | null {
  const snapshot = useLabsExperimentsStore((state) => state.snapshot);
  const pending = useLabsExperimentsStore((state) => state.pending);
  const error = useLabsExperimentsStore(
    (state) => state.errors['activity-card'],
  );
  useEffect(() => {
    ensureLabsExperimentsSubscription();
  }, []);
  const entry = snapshot?.experiments.find(
    (experiment) => experiment.id === 'activity-card',
  );
  if (snapshot?.ready && entry && !entry.listed) return null;
  const saving = Object.prototype.hasOwnProperty.call(pending, 'activity-card');
  const compact = saving
    ? pending['activity-card'] === true
    : entry?.enabled === true;
  return (
    <SettingsRow
      contentGap="block"
      label="Activity card"
      description="Show Activity beside the chat and keep new chats in the main chat group."
      dataTestId="settings-activity-card-row"
      control={
        <ToggleSwitch
          checked={compact}
          disabled={
            !snapshot?.ready || !snapshot.choicesReady || !entry || saving
          }
          onChange={(enabled) => {
            void setLabsExperimentChoice('activity-card', enabled);
          }}
          dataTestId="settings-activity-card-toggle"
          label="Activity card"
          busy={saving}
        />
      }
    >
      <ErrorBanner
        errorSource="activity-card-settings-row"
        error={error}
        className=""
      />
    </SettingsRow>
  );
}
