import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  AppAdvisorProjectAgentAccess,
  CanopyApi,
  ChatTabPluginSelections,
  PreferencesData,
  ProjectOwnerContext,
} from '@canopy/desktop-shared/types';
import {
  AppAdvisorProjectAgentAccessControl,
  ErrorBanner,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import {
  ORCHESTRATOR_PLUGINS_LABEL,
  ORCHESTRATOR_PLUGINS_SELECTION_COPY,
} from '@canopy/ui-shared/lib';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { ModelThinkingPreferenceRow } from './ModelThinkingPreferenceRow';
import { SettingsPluginPicker } from './SettingsPluginPicker';
import {
  SettingsGroup,
  SettingsPage,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
} from './SettingsLayout';
import { saveAppAdvisorPreferencePatch } from '@/lib/appAdvisorPreferenceSave';
import {
  appAdvisorProjectAgentAccessEquals,
  buildAppAdvisorProjectAgentAccessOwnerOptions,
  coerceAppAdvisorProjectAgentAccess,
} from './app-advisor-project-agent-access-preferences';
import { useExperimentalFeaturesEnabled } from '@/stores/experimentalFeaturesStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

const PROJECT_AGENT_ACCESS_SAVE_ERROR =
  "Couldn't save project agent access. Try again.";

/**
 * Settings tab for the App Advisor (the local Canopy assistant). Surfaces
 * three groups of preferences:
 *
 *  1. **Embedded assistant** — defaults used by the floating App Advisor
 *     chat dialog (model/thinking level, plugin selections).
 *  2. **Project agents** — which project owners' agents can use App Advisor.
 *  3. **Pipeline monitoring** — the existing automatic-supervisor preferences.
 *     The persisted preference keys still use `pipelineAdvisor*` for storage
 *     compatibility; only the surface copy is renamed to App Advisor.
 *
 * The renderer only persists the preference; downstream consumers (the App
 * Advisor runtime, the pipeline supervisor) pick up the new values the next
 * time they start a session.
 */
const PIPELINE_MONITOR_TOGGLE_ID = 'settings-pipeline-advisor-enabled';
const PIPELINE_MONITOR_LABEL = 'Automatically monitor workflow runs';

export function AppAdvisorTab(): JSX.Element {
  const [prefs, setPrefs] = useState<PreferencesData | null>(null);
  const [savingProjectAgentAccess, setSavingProjectAgentAccess] =
    useState(false);
  const [projectAgentAccessSaveError, setProjectAgentAccessSaveError] =
    useState<string | null>(null);
  const projectAgentAccessRef = useRef<AppAdvisorProjectAgentAccess>(
    coerceAppAdvisorProjectAgentAccess(undefined),
  );
  const organizations = useWorkspaceContextStore(
    (state) => state.state.organizations,
  );
  const ownerOptions = useMemo(
    () => buildAppAdvisorProjectAgentAccessOwnerOptions(organizations),
    [organizations],
  );
  const segmentShape = useExperimentalFeaturesEnabled() ? 'capsule' : 'rounded';
  const projectAgentAccess = useMemo(
    () =>
      coerceAppAdvisorProjectAgentAccess(prefs?.appAdvisorProjectAgentAccess),
    [prefs],
  );
  const selectedOwners: ProjectOwnerContext[] =
    projectAgentAccess.selectedOwners.map(
      (owner): ProjectOwnerContext =>
        owner.kind === 'personal'
          ? { kind: 'personal' }
          : {
              kind: 'organization',
              organizationId: owner.organizationId,
            },
    );

  useEffect(() => {
    const api: CanopyApi = window.api;
    void api
      .loadPreferences({ view: 'persisted' })
      .then((p: PreferencesData) => {
        const access = coerceAppAdvisorProjectAgentAccess(
          p.appAdvisorProjectAgentAccess,
        );
        projectAgentAccessRef.current = access;
        setPrefs({ ...p, appAdvisorProjectAgentAccess: access });
      })
      .catch(() => setPrefs(null));
  }, []);

  useEffect(() => {
    projectAgentAccessRef.current = projectAgentAccess;
  }, [projectAgentAccess]);

  function savePreferences(patch: Partial<PreferencesData>): void {
    if (!prefs) return;
    // Shared save loop (`saveAppAdvisorPreferencePatch`) so this tab and the
    // popout settings modal cannot drift on partial-save/error behavior.
    saveAppAdvisorPreferencePatch(prefs, patch, setPrefs);
  }

  const persistProjectAgentAccess = useCallback(
    async (next: AppAdvisorProjectAgentAccess): Promise<void> => {
      const previous = projectAgentAccessRef.current;
      projectAgentAccessRef.current = next;
      setPrefs((current) =>
        current ? { ...current, appAdvisorProjectAgentAccess: next } : current,
      );
      setSavingProjectAgentAccess(true);
      setProjectAgentAccessSaveError(null);
      try {
        const savedPreferences = await window.api.savePreferences(
          { appAdvisorProjectAgentAccess: next },
          { view: 'persisted' },
        );
        const savedAccess = coerceAppAdvisorProjectAgentAccess(
          savedPreferences.appAdvisorProjectAgentAccess,
        );
        projectAgentAccessRef.current = savedAccess;
        setPrefs({
          ...savedPreferences,
          appAdvisorProjectAgentAccess: savedAccess,
        });
      } catch {
        projectAgentAccessRef.current = previous;
        setPrefs((current) =>
          current
            ? { ...current, appAdvisorProjectAgentAccess: previous }
            : current,
        );
        setProjectAgentAccessSaveError(PROJECT_AGENT_ACCESS_SAVE_ERROR);
      } finally {
        setSavingProjectAgentAccess(false);
      }
    },
    [],
  );

  const handleProjectAgentAccessChange = useCallback(
    (next: AppAdvisorProjectAgentAccess): void => {
      if (
        !prefs ||
        savingProjectAgentAccess ||
        appAdvisorProjectAgentAccessEquals(next, projectAgentAccessRef.current)
      ) {
        return;
      }
      void persistProjectAgentAccess(next);
    },
    [persistProjectAgentAccess, prefs, savingProjectAgentAccess],
  );

  useCurrentUiStateReporter('settings.appAdvisorProjectAgentAccess', {
    loaded: prefs !== null,
    mode: projectAgentAccess.mode,
    selectedOwners,
    saving: savingProjectAgentAccess,
    saveErrorVisible: projectAgentAccessSaveError !== null,
  });

  if (!prefs) {
    return (
      <SettingsPage title={ORCHESTRATOR_LABEL}>
        <SettingsLoading />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title={ORCHESTRATOR_LABEL}
      dataTestId="settings-tab-app-advisor"
    >
      <SettingsSection title="Embedded assistant">
        <SettingsGroup>
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
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Project agents">
        <ErrorBanner
          errorSource="app-advisor-tab-project-agent-access-save"
          className=""
          error={projectAgentAccessSaveError}
        />
        <SettingsGroup dataTestId="settings-app-advisor-project-agent-access">
          <AppAdvisorProjectAgentAccessControl
            value={projectAgentAccess}
            ownerOptions={ownerOptions}
            onChange={handleProjectAgentAccessChange}
            saving={savingProjectAgentAccess}
            segmentShape={segmentShape}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Workflow monitoring">
        <SettingsGroup>
          <SettingsRow
            label={PIPELINE_MONITOR_LABEL}
            htmlFor={PIPELINE_MONITOR_TOGGLE_ID}
            description="Monitor each new workflow run as it starts. Manual monitoring from workflow details stays available."
            control={
              <ToggleSwitch
                id={PIPELINE_MONITOR_TOGGLE_ID}
                checked={prefs.pipelineAdvisorEnabled}
                label={PIPELINE_MONITOR_LABEL}
                onChange={(next) =>
                  savePreferences({ pipelineAdvisorEnabled: next })
                }
                dataTestId="pipeline-advisor-enabled-toggle"
              />
            }
          />

          <ModelThinkingPreferenceRow
            title="Workflow monitor model"
            description="Model and thinking level for health, inefficiency, ETA, and final recommendation updates."
            model={prefs.pipelineAdvisorModel}
            thinkingLevel={prefs.pipelineAdvisorThinkingLevel}
            defaultThinkingLevel="high"
            includeOllama={false}
            onModelChange={(model, thinkingLevel) =>
              savePreferences({
                pipelineAdvisorModel: model,
                pipelineAdvisorThinkingLevel: thinkingLevel,
              })
            }
            onThinkingChange={(thinkingLevel) =>
              savePreferences({ pipelineAdvisorThinkingLevel: thinkingLevel })
            }
          />
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}
