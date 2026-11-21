/** Host adapter for the shared Orchestrator settings dialog. */
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { ErrorState, Stack } from '@canopy/ui-shared/components';
import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  useOptionalCanopyClient,
  useOrchestratorSettingsDraft,
} from '@canopy/app-state';
import { OrchestratorSettingsModal } from '@canopy/ui-app/orchestrator/OrchestratorSettingsModal';
import type {
  ChatTabPluginSelections,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { toAppError } from '@canopy/protocol/app-errors';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { appAdvisorSaveFailure } from './appAdvisorSaveFailure';
import {
  ORCHESTRATOR_PLUGINS_LABEL,
  ORCHESTRATOR_PLUGINS_SELECTION_COPY,
} from '@canopy/ui-shared/lib';
import { ModelThinkingPreferenceRow } from '@/components/settings/ModelThinkingPreferenceRow';
import { SettingsPluginPicker } from '@/components/settings/SettingsPluginPicker';
import { saveAppAdvisorPreferencePatch } from '@/lib/appAdvisorPreferenceSave';
import { createOrchestratorSettingsDraftClient } from '@/client/orchestrator-settings-client';

export interface AppAdvisorSettingsModalProps {
  onClose: () => void;
}

export function AppAdvisorSettingsModal({
  onClose,
}: AppAdvisorSettingsModalProps): JSX.Element {
  const client = useOptionalCanopyClient();
  const settingsClient = useMemo(
    () =>
      client?.orchestratorSettingsDraft ??
      createOrchestratorSettingsDraftClient(),
    [client],
  );
  const draft = useOrchestratorSettingsDraft(settingsClient, (error) =>
    appAdvisorSaveFailure(toAppError(resolveClientAppError(error))),
  );
  const [prefs, setPrefs] = useState<PreferencesData | null>(null);
  const [prefsError, setPrefsError] = useState(false);
  // Each Try again reads once more; the failure stays shown while it runs.
  const [prefsAttempt, setPrefsAttempt] = useState(0);
  const [prefsRetrying, setPrefsRetrying] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void window.api
      .loadPreferences({ view: 'persisted' })
      .then((loaded) => {
        if (cancelled) return;
        setPrefsRetrying(false);
        setPrefsError(false);
        setPrefs(loaded);
      })
      .catch(() => {
        if (cancelled) return;
        setPrefsRetrying(false);
        setPrefsError(true);
      });
    return (): void => {
      cancelled = true;
    };
  }, [prefsAttempt]);
  function savePreferences(patch: Partial<PreferencesData>): void {
    if (!prefs) return;
    saveAppAdvisorPreferencePatch(prefs, patch, setPrefs);
  }
  return (
    <OrchestratorSettingsModal
      onClose={onClose}
      testIdPrefix="app-advisor"
      formLayout="stack"
      defaults={
        prefs ? (
          <Stack gap="section">
            <ModelThinkingPreferenceRow
              title="Default model"
              description={`Model and thinking level used for new ${ORCHESTRATOR_LABEL} chats.`}
              model={prefs.appAdvisorModel}
              thinkingLevel={prefs.appAdvisorThinkingLevel}
              defaultThinkingLevel="high"
              includeOllama={true}
              includeCursor
              onModelChange={(model, thinkingLevel) =>
                savePreferences({
                  appAdvisorModel: model,
                  appAdvisorThinkingLevel: thinkingLevel,
                })
              }
              onThinkingChange={(thinkingLevel) =>
                savePreferences({ appAdvisorThinkingLevel: thinkingLevel })
              }
            />
            <SettingsPluginPicker
              label={ORCHESTRATOR_PLUGINS_LABEL}
              selectionCopy={ORCHESTRATOR_PLUGINS_SELECTION_COPY}
              description={`Loaded when ${ORCHESTRATOR_LABEL} starts a new chat.`}
              selections={prefs.appAdvisorPluginSelections}
              onChange={(selections: ChatTabPluginSelections) =>
                savePreferences({ appAdvisorPluginSelections: selections })
              }
            />
          </Stack>
        ) : prefsError ? (
          <ErrorState
            space="panel"
            message="Couldn't load preferences."
            onRetry={(): void => {
              setPrefsRetrying(true);
              setPrefsAttempt((attempt) => attempt + 1);
            }}
            retrying={prefsRetrying}
            testId="app-advisor-preferences-load-error"
            retryTestId="app-advisor-preferences-load-retry"
          />
        ) : (
          <div className="py-8 text-center text-s fg-secondary">
            Loading preferences...
          </div>
        )
      }
      instructions={draft.instructions}
      onInstructionsChange={draft.setInstructions}
      instructionsLoading={draft.instructionsLoading}
      instructionsPlaceholder={`# ${ORCHESTRATOR_LABEL} instructions\n\nAdd assistant instructions here...`}
      retentionDays={draft.retentionDays}
      onRetentionDaysChange={draft.setRetentionDays}
      autoArchiveEnabled={draft.autoArchiveEnabled}
      onAutoArchiveEnabledChange={draft.setAutoArchiveEnabled}
      autoArchiveDays={draft.autoArchiveDays}
      onAutoArchiveDaysChange={draft.setAutoArchiveDays}
      showSave={draft.isDirty || draft.saveError !== null}
      saveDisabled={draft.saving || !draft.isDirty}
      saving={draft.saving}
      onSave={() => void draft.save()}
      footerError={
        <DesktopErrorBanner
          errorSource="app-advisor-settings-save-error"
          className=""
          error={draft.saveError?.error}
          {...(draft.saveError?.details === undefined
            ? {}
            : { details: draft.saveError.details })}
          testId="app-advisor-settings-save-error"
        />
      }
    />
  );
}
