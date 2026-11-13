/**
 * In-popout App Advisor settings modal (DialogModal + the
 * `ChatProjectSettingsModal` tab pattern). Three tabs:
 *
 *  1. Defaults — model, thinking level, and default plugins. Saved
 *     immediately through the shared {@link saveAppAdvisorPreferencePatch}
 *     loop into the GLOBAL `appAdvisor*` preferences (the same values quick
 *     prompts, automations, and watchers consume).
 *  2. Instructions — the App Advisor CLAUDE.md, edited through
 *     `window.api.appAdvisor.loadClaudeMd/saveClaudeMd`. Dirty-tracked with
 *     an explicit Save, matching the existing modal pattern.
 *  3. Advanced — deletion retention, edited through
 *     `window.api.appAdvisor.settingsLoad/settingsSave` (nullable days).
 *
 * Deliberately NO rename, color, or danger tabs — the App Advisor workspace
 * is app-managed and cannot be deleted. The global Settings → App Advisor
 * tab remains available in the main window.
 */
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { Stack, Heading, Surface, TabBar } from '@canopy/ui-shared/components';
import { useEffect, useState, type JSX } from 'react';
import type {
  AppAdvisorWorkspaceSettingsFile,
  ChatTabPluginSelections,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import { DialogModal } from '@/components/shared';
import { AutoArchiveSettingsControl } from '@canopy/ui-shared';
import { Button, TextArea, TextInput } from '@canopy/ui-shared/components';
import {
  ORCHESTRATOR_PLUGINS_LABEL,
  ORCHESTRATOR_PLUGINS_SELECTION_COPY,
} from '@canopy/ui-shared/lib';
import { ModelThinkingPreferenceRow } from '@/components/settings/ModelThinkingPreferenceRow';
import { SettingsPluginPicker } from '@/components/settings/SettingsPluginPicker';
import { saveAppAdvisorPreferencePatch } from '@/lib/appAdvisorPreferenceSave';
import {
  DEFAULT_AUTO_ARCHIVE_DAYS,
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  MAX_ARCHIVE_RETENTION_DAYS,
  shouldPersistArchiveRetention,
  toArchiveRetentionDraft,
  toPersistedArchiveRetentionDays,
} from '@/lib/archiveRetentionSettings';
import { APP_ADVISOR_SETTINGS_SAVED_EVENT } from '@/lib/appAdvisorSettingsEvents';

type AppAdvisorSettingsTab = 'defaults' | 'instructions' | 'advanced';

export interface AppAdvisorSettingsModalProps {
  onClose: () => void;
}

export function AppAdvisorSettingsModal({
  onClose,
}: AppAdvisorSettingsModalProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<AppAdvisorSettingsTab>('defaults');

  // Defaults tab state (global appAdvisor* preferences).
  const [prefs, setPrefs] = useState<PreferencesData | null>(null);
  const [prefsError, setPrefsError] = useState(false);

  // Instructions tab state.
  const [claudeMd, setClaudeMd] = useState('');
  const [savedClaudeMd, setSavedClaudeMd] = useState('');
  const [claudeMdLoading, setClaudeMdLoading] = useState(true);

  // Advanced tab state.
  const [settings, setSettings] =
    useState<AppAdvisorWorkspaceSettingsFile | null>(null);
  const [retentionDays, setRetentionDays] = useState(
    DEFAULT_ARCHIVE_RETENTION_DAYS,
  );
  const [autoArchiveEnabled, setAutoArchiveEnabled] = useState(false);
  const [autoArchiveDays, setAutoArchiveDays] = useState(
    DEFAULT_AUTO_ARCHIVE_DAYS,
  );

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .loadPreferences({ view: 'persisted' })
      .then((loaded) => {
        if (!cancelled) setPrefs(loaded);
      })
      .catch(() => {
        if (!cancelled) setPrefsError(true);
      });
    void window.api.appAdvisor
      .loadClaudeMd()
      .then((contents) => {
        if (cancelled) return;
        setClaudeMd(contents);
        setSavedClaudeMd(contents);
        setClaudeMdLoading(false);
      })
      .catch(() => {
        if (!cancelled) setClaudeMdLoading(false);
      });
    void window.api.appAdvisor
      .settingsLoad()
      .then((loaded) => {
        if (cancelled) return;
        setSettings(loaded);
        // Shared retention semantics: never-set, legacy `null`, and legacy
        // `0` all render as the 7-day default (deletion retention is always
        // on).
        setRetentionDays(
          toArchiveRetentionDraft('app-advisor', loaded.archiveRetentionDays)
            .days,
        );
        setAutoArchiveEnabled(
          typeof loaded.autoArchiveDays === 'number' &&
            loaded.autoArchiveDays > 0,
        );
        setAutoArchiveDays(
          typeof loaded.autoArchiveDays === 'number' &&
            loaded.autoArchiveDays > 0
            ? loaded.autoArchiveDays
            : DEFAULT_AUTO_ARCHIVE_DAYS,
        );
      })
      .catch(() => undefined);
    return (): void => {
      cancelled = true;
    };
  }, []);

  function savePreferences(patch: Partial<PreferencesData>): void {
    if (!prefs) return;
    // Shared save loop keeps this modal and the global Settings tab from
    // drifting on partial-save/error/refresh behavior.
    saveAppAdvisorPreferencePatch(prefs, patch, setPrefs);
  }

  const claudeMdDirty = !claudeMdLoading && claudeMd !== savedClaudeMd;
  // Persist-on-save compares EFFECTIVE retention (resolved days) AND forces a
  // write while the persisted value is still a legacy `null`/absent/`0`, so
  // the first Save arms the archived-chat sweep to match the 7-day default
  // this modal displays.
  const retentionDraft = { days: retentionDays };
  const retentionDirty =
    settings !== null &&
    shouldPersistArchiveRetention(
      'app-advisor',
      settings.archiveRetentionDays,
      retentionDraft,
    );
  const nextAutoArchiveDays = autoArchiveEnabled ? autoArchiveDays : null;
  const autoArchiveDirty =
    settings !== null &&
    (settings.autoArchiveDays ?? null) !== nextAutoArchiveDays;
  const isDirty = claudeMdDirty || retentionDirty || autoArchiveDirty;

  async function handleSave(): Promise<void> {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (claudeMdDirty) {
        await window.api.appAdvisor.saveClaudeMd(claudeMd);
        setSavedClaudeMd(claudeMd);
      }
      if (retentionDirty || autoArchiveDirty) {
        const saved = await window.api.appAdvisor.settingsSave({
          ...(retentionDirty
            ? {
                archiveRetentionDays: toPersistedArchiveRetentionDays(
                  'app-advisor',
                  retentionDraft,
                ),
              }
            : {}),
          ...(autoArchiveDirty ? { autoArchiveDays: nextAutoArchiveDays } : {}),
        });
        setSettings(saved);
        setRetentionDays(
          toArchiveRetentionDraft('app-advisor', saved.archiveRetentionDays)
            .days,
        );
        setAutoArchiveEnabled(
          typeof saved.autoArchiveDays === 'number' &&
            saved.autoArchiveDays > 0,
        );
        setAutoArchiveDays(
          typeof saved.autoArchiveDays === 'number' && saved.autoArchiveDays > 0
            ? saved.autoArchiveDays
            : DEFAULT_AUTO_ARCHIVE_DAYS,
        );
        window.dispatchEvent(
          new CustomEvent(APP_ADVISOR_SETTINGS_SAVED_EVENT, { detail: saved }),
        );
      }
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : 'Failed to save settings.',
      );
    } finally {
      setSaving(false);
    }
  }

  const tabs: Array<{ id: AppAdvisorSettingsTab; label: string }> = [
    { id: 'defaults', label: 'Defaults' },
    { id: 'instructions', label: 'Instructions' },
    { id: 'advanced', label: 'Advanced' },
  ];

  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      title={ORCHESTRATOR_LABEL}
      titleId="app-advisor-settings-title"
      maxWidth="2xl"
      minHeight="28rem"
      dataTestId="app-advisor-settings-modal"
    >
      <TabBar
        items={tabs.map((tab) => ({
          id: tab.id,
          label: tab.label,
          dataTestId: `app-advisor-settings-tab-${tab.id}`,
        }))}
        value={activeTab}
        onChange={(next): void => setActiveTab(next)}
        label={`${ORCHESTRATOR_LABEL} settings sections`}
        density="compact"
        inset="dialog"
      />

      <div
        className={`flex-1 p-6 ${
          activeTab === 'instructions'
            ? 'flex min-h-0 flex-col'
            : 'overflow-y-auto'
        }`}
      >
        {activeTab === 'defaults' &&
          (prefs ? (
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
          ) : (
            <div className="py-8 text-center text-s fg-secondary">
              {prefsError
                ? 'Preferences are unavailable.'
                : 'Loading preferences...'}
            </div>
          ))}

        {activeTab === 'instructions' && (
          <Stack gap="inline" className="min-h-0 flex-1">
            <Stack gap="tight">
              <Heading
                level={3}
                variant="title"
                id="app-advisor-claude-md-label"
              >
                CLAUDE.md
              </Heading>
              <p
                id="app-advisor-claude-md-description"
                className="text-xs fg-secondary"
              >
                Instructions loaded into every {ORCHESTRATOR_LABEL} chat.
              </p>
            </Stack>
            <TextArea
              mono
              value={claudeMd}
              onChange={(event) => setClaudeMd(event.target.value)}
              disabled={claudeMdLoading}
              aria-labelledby="app-advisor-claude-md-label"
              aria-describedby="app-advisor-claude-md-description"
              data-testid="app-advisor-settings-claude-md"
              className="min-h-0 flex-1"
              placeholder={`# ${ORCHESTRATOR_LABEL} instructions\n\nAdd assistant instructions here...`}
            />
          </Stack>
        )}

        {activeTab === 'advanced' && (
          <Stack gap="group">
            <Surface
              variant="outline"
              padding="default"
              data-testid="app-advisor-settings-retention"
            >
              <Stack
                gap="item"
                data-testid="app-advisor-settings-retention-card"
              >
                <Stack gap="tight">
                  <Heading level={3} variant="title">
                    Deletion retention
                  </Heading>
                  <p className="text-xs fg-secondary">
                    {`Deleted and archived chats are kept for ${retentionDays} ${retentionDays === 1 ? 'day' : 'days'} before they're removed. Archived work entries are kept until you delete them.`}
                  </p>
                </Stack>
                <div className="flex flex-col gap-0">
                  <div className="flex items-center gap-3">
                    <span
                      id="app-advisor-retention-days-label"
                      className="text-s fg-primary"
                    >
                      Keep deleted chats for
                    </span>
                    <div className="w-28">
                      <TextInput
                        density="settings"
                        type="number"
                        aria-labelledby="app-advisor-retention-days-label"
                        trailing="days"
                        value={retentionDays}
                        onChange={(e) =>
                          setRetentionDays(
                            Math.max(
                              1,
                              Math.min(
                                MAX_ARCHIVE_RETENTION_DAYS,
                                parseInt(e.target.value) ||
                                  DEFAULT_ARCHIVE_RETENTION_DAYS,
                              ),
                            ),
                          )
                        }
                        min={1}
                        max={MAX_ARCHIVE_RETENTION_DAYS}
                        data-testid="app-advisor-settings-retention-days"
                      />
                    </div>
                  </div>
                  <AutoArchiveSettingsControl
                    enabled={autoArchiveEnabled}
                    days={autoArchiveDays}
                    maxDays={MAX_ARCHIVE_RETENTION_DAYS}
                    fallbackDays={DEFAULT_AUTO_ARCHIVE_DAYS}
                    description="Delete fully idle sessions after a period of inactivity."
                    toggleTestId="app-advisor-settings-auto-archive-toggle"
                    daysTestId="app-advisor-settings-auto-archive-days"
                    onEnabledChange={setAutoArchiveEnabled}
                    onDaysChange={setAutoArchiveDays}
                  />
                </div>
              </Stack>
            </Surface>
          </Stack>
        )}
      </div>

      {(isDirty || saveError) && (
        <div className="flex items-center justify-end gap-3 border-t px-6 py-3">
          {saveError && (
            <span className="min-w-0 flex-1 truncate text-xs text-destructive">
              {saveError}
            </span>
          )}
          <Button
            variant="primary"
            size="compact"
            onClick={() => void handleSave()}
            disabled={saving || !isDirty}
            data-testid="app-advisor-settings-save"
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      )}
    </DialogModal>
  );
}
