'use client';
import type { JSX } from 'react';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  useOrchestratorRemoteSettings,
  type OrchestratorRemoteSettingsSource,
} from '@canopy/app-state';
import {
  AppAdvisorProjectAgentAccessControl,
  ErrorBanner,
  SettingsSelect,
  ThinkingLevelControl,
  ThinkingLevelProviderHint,
  Stack,
  Heading,
} from '@canopy/ui-shared/components';
import { settingsActionErrorCopy } from '../settings/errors';
import {
  countRemoteControlPluginSelections,
  RemoteControlPluginsPicker,
} from '../code/composer/RemoteControlPluginsPicker';
import {
  ORCHESTRATOR_PLUGINS_LABEL,
  ORCHESTRATOR_PLUGINS_SELECTION_COPY,
  orchestratorPluginsCountText,
} from '@canopy/ui-shared/lib';
import { OrchestratorSettingsModal } from './OrchestratorSettingsModal';

export interface OrchestratorRemoteSettingsModalProps extends OrchestratorRemoteSettingsSource {
  readonly onClose: () => void;
  readonly brandDisplayName: string;
}
export function OrchestratorRemoteSettingsModal({
  onClose,
  brandDisplayName,
  ...source
}: OrchestratorRemoteSettingsModalProps): JSX.Element {
  const draft = useOrchestratorRemoteSettings(source, (error, action) =>
    settingsActionErrorCopy(error, { action }),
  );
  const {
    settings,
    setSettings,
    selectedModel,
    supportedThinkingLevels,
    handleModelChange,
    handlePluginChange,
    savingProjectAgentAccess,
    handleProjectAgentAccessChange,
    saveDefaults,
  } = draft;
  return (
    <OrchestratorSettingsModal
      onClose={onClose}
      testIdPrefix="remote-control-app-advisor"
      formLayout="flow"
      contentReady={settings !== null}
      loading={
        !settings ? (
          <div className="py-8 text-center text-s fg-secondary">
            {draft.loadingError
              ? `${ORCHESTRATOR_LABEL} settings are unavailable.`
              : 'Loading settings...'}
          </div>
        ) : null
      }
      defaults={
        settings ? (
          <Stack gap="section">
            <div className="flex items-start justify-between gap-4">
              <Stack gap="tight">
                <Heading level={2} variant="title">
                  Default model
                </Heading>
                <p className="text-s fg-secondary">
                  Model and thinking level used for new {ORCHESTRATOR_LABEL}{' '}
                  chats.
                </p>
              </Stack>
              <div className="flex items-center gap-2">
                <SettingsSelect
                  aria-label="Default model"
                  width="field"
                  options={settings.availableModels
                    .filter((model) => model.kind !== 'agent')
                    .map((model) => ({
                      value: model.id,
                      label: model.label,
                      disabled: !model.available,
                    }))}
                  value={settings.model}
                  onValueChange={(value): void => handleModelChange(value)}
                  data-testid="remote-control-app-advisor-settings-model"
                />
                {supportedThinkingLevels.length > 0 ? (
                  <ThinkingLevelProviderHint
                    providerHint={selectedModel?.provider}
                  >
                    <ThinkingLevelControl
                      value={settings.thinkingLevel}
                      supportedLevels={supportedThinkingLevels}
                      onChange={(next): void => {
                        if (next !== undefined) {
                          void saveDefaults({
                            thinkingLevel: next,
                          });
                        }
                      }}
                      variant="select"
                      testId="remote-control-app-advisor-settings-thinking"
                    />
                  </ThinkingLevelProviderHint>
                ) : null}
              </div>
            </div>

            <div className="flex items-start justify-between gap-4">
              <Stack gap="tight">
                <Heading level={2} variant="title">
                  {ORCHESTRATOR_PLUGINS_LABEL}
                </Heading>
                <p className="text-s fg-secondary">
                  Loaded when {ORCHESTRATOR_LABEL} starts a new chat.
                </p>
              </Stack>
              <div className="flex items-center gap-2">
                <span className="text-xs fg-secondary">
                  {orchestratorPluginsCountText(
                    countRemoteControlPluginSelections(
                      settings.pluginSelections,
                    ),
                  )}
                </span>
                <RemoteControlPluginsPicker
                  catalog={settings.pluginCatalog}
                  selections={settings.pluginSelections}
                  providerType={selectedModel?.provider}
                  brandDisplayName={brandDisplayName}
                  onChange={handlePluginChange}
                  selectionCopy={ORCHESTRATOR_PLUGINS_SELECTION_COPY}
                />
              </div>
            </div>
            {settings.projectAgentAccess ? (
              <AppAdvisorProjectAgentAccessControl
                value={settings.projectAgentAccess}
                ownerOptions={settings.projectAgentAccessOwnerOptions ?? []}
                onChange={handleProjectAgentAccessChange}
                saving={savingProjectAgentAccess}
              />
            ) : null}
          </Stack>
        ) : null
      }
      instructions={settings?.instructions ?? ''}
      onInstructionsChange={(instructions) => {
        if (settings) setSettings({ ...settings, instructions });
      }}
      instructionsPlaceholder={`# ${ORCHESTRATOR_LABEL} instructions`}
      retentionDays={draft.retentionDays}
      onRetentionDaysChange={draft.setRetentionDays}
      autoArchiveEnabled={draft.autoArchiveEnabled}
      onAutoArchiveEnabledChange={draft.setAutoArchiveEnabled}
      autoArchiveDays={draft.autoArchiveDays}
      onAutoArchiveDaysChange={draft.setAutoArchiveDays}
      showSave={draft.isDirty || draft.saveError !== null}
      saveDisabled={draft.saving || !draft.isDirty}
      saveLabel={draft.saving ? 'Saving…' : 'Save'}
      onSave={() => void draft.handleSave()}
      error={
        draft.saveError !== null ? (
          <div className="px-5 pb-3">
            <ErrorBanner
              errorSource="portal-app-advisor-settings-modal-save"
              className=""
              error={draft.saveError}
            />
          </div>
        ) : null
      }
    />
  );
}
