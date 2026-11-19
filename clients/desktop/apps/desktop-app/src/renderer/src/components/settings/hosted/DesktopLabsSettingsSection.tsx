import { type JSX, useEffect, useMemo } from 'react';
import type {
  LabsExperimentRowView,
  LabsExperimentsSectionLayout,
} from '@canopy/ui-shared/components';
import {
  LabsSettingsPortProvider,
  LabsSettingsSection,
  type LabsSettingsPort,
} from '@canopy/ui-app/settings/labs';
import { EARLY_ACCESS_EXPERIMENT_ID } from '@canopy/protocol/experiments';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { LABS_EXPERIMENTS } from '@canopy/desktop-shared/lib/labs-experiments';
import { isPageFeatureFlagGateOpen } from '@/lib/navigation/page-availability';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  ensureLabsExperimentsSubscription,
  setLabsExperimentChoice,
  useLabsExperimentsStore,
} from '@/stores/labsExperimentsStore';
import { SettingsGroup, SettingsRow, SettingsSection } from '../SettingsLayout';

const LAYOUT: LabsExperimentsSectionLayout = {
  Section: SettingsSection,
  Group: SettingsGroup,
  Row: SettingsRow,
};

function handleToggle(experimentId: string, enabled: boolean): void {
  void setLabsExperimentChoice(experimentId, enabled);
}

/**
 * Desktop's host for the shared Labs section, backed by main's Labs snapshot. Main decides which
 * experiments are listed and on; the switch shows a pending save's requested
 * value until main confirms it. Until a ready snapshot arrives, feature rows
 * are disabled. The legacy master preference is retained only for migration.
 *
 * Experiments that do not require Early access are independent and go
 * in the Experiments section. One whose page a feature flag still refuses is left
 * out: switching it on would show nothing.
 */
export function DesktopLabsSettingsSection(): JSX.Element {
  const snapshot = useLabsExperimentsStore((state) => state.snapshot);
  const pending = useLabsExperimentsStore((state) => state.pending);
  const errors = useLabsExperimentsStore((state) => state.errors);
  // Re-evaluates the page flag gates on every flag snapshot.
  const featureFlags = useFeatureFlagsStore((state) => state.snapshot);

  useEffect(() => {
    ensureLabsExperimentsSubscription();
  }, []);

  const rows = useMemo((): LabsExperimentRowView[] => {
    if (!snapshot?.ready) {
      return LABS_EXPERIMENTS.filter((entry) => {
        const flag = Object.values(CLIENT_FEATURE_FLAGS).find(
          (candidate) => candidate.key === entry.flagKey,
        );
        return (
          entry.id !== EARLY_ACCESS_EXPERIMENT_ID &&
          entry.id !== 'sidebar' &&
          entry.id !== 'activity-card' &&
          entry.pages.length === 0 &&
          flag?.launchDarklyDisabledDefaultValue !== 'hidden'
        );
      }).map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        checked: false,
        disabled: true,
        group: 'pages',
      }));
    }
    const listed = snapshot.experiments.filter(
      (entry) =>
        entry.id !== EARLY_ACCESS_EXPERIMENT_ID &&
        entry.id !== 'sidebar' &&
        entry.id !== 'activity-card' &&
        entry.listed &&
        entry.pages.every(isPageFeatureFlagGateOpen),
    );
    return [
      ...listed.filter((entry) => entry.id === EARLY_ACCESS_EXPERIMENT_ID),
      ...listed.filter((entry) => entry.id !== EARLY_ACCESS_EXPERIMENT_ID),
    ].map((entry) => {
      const blocked = entry.blockedBy !== undefined;
      const hasPendingChoice = Object.prototype.hasOwnProperty.call(
        pending,
        entry.id,
      );
      return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        checked: blocked
          ? false
          : hasPendingChoice
            ? (pending[entry.id] ?? entry.enabled)
            : entry.enabled,
        disabled: blocked || hasPendingChoice,
        disabledReason: blocked ? entry.requiresExperimentReason : undefined,
        group:
          entry.id === EARLY_ACCESS_EXPERIMENT_ID || entry.requiresEarlyAccess
            ? 'early-access'
            : 'pages',
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `featureFlags` is the invalidation key for the flag gates
  }, [snapshot, pending, featureFlags]);

  const error =
    Object.entries(errors).find(
      ([id]) => id !== 'sidebar' && id !== 'activity-card',
    )?.[1] ?? null;

  const port = useMemo(
    (): LabsSettingsPort => ({
      rows,
      error,
      onToggle: handleToggle,
      layout: LAYOUT,
    }),
    [rows, error],
  );

  return (
    <LabsSettingsPortProvider value={port}>
      <LabsSettingsSection />
    </LabsSettingsPortProvider>
  );
}
