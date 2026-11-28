'use client';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  OrchestratorInstructionsConflictError,
  type RemoteControlAppAdvisorSettings,
  type RemoteControlAppAdvisorSettingsSavePayload,
  type RemoteControlChatTabPluginSelections,
} from '@canopy/protocol/remote-control/shell';
import {
  clampThinkingLevelToDeclared,
  type ThinkingLevel,
} from '@canopy/protocol/thinking';

export interface LoadedOrchestratorRemoteSettings {
  readonly settings: RemoteControlAppAdvisorSettings;
  readonly signal: AbortSignal;
  readonly save: (
    patch: RemoteControlAppAdvisorSettingsSavePayload,
  ) => Promise<string | undefined>;
}

export interface OrchestratorRemoteSettingsSource {
  readonly onLoad: () => Promise<LoadedOrchestratorRemoteSettings | null>;
}
interface RemoteSettingsState {
  readonly settings: RemoteControlAppAdvisorSettings | null;
  readonly setSettings: Dispatch<
    SetStateAction<RemoteControlAppAdvisorSettings | null>
  >;
  readonly retentionDays: number;
  readonly setRetentionDays: Dispatch<SetStateAction<number>>;
  readonly autoArchiveEnabled: boolean;
  readonly setAutoArchiveEnabled: Dispatch<SetStateAction<boolean>>;
  readonly autoArchiveDays: number;
  readonly setAutoArchiveDays: Dispatch<SetStateAction<number>>;
  readonly loadingError: boolean;
  /** Reads the settings again after a failed load (CAN-7473). */
  readonly reload: () => void;
  readonly reloading: boolean;
  readonly saveError: string | null;
  readonly saving: boolean;
  readonly savingProjectAgentAccess: boolean;
  readonly isDirty: boolean;
  readonly handleSave: () => Promise<void>;
  readonly handleModelChange: (model: string) => void;
  readonly handlePluginChange: (
    selections: RemoteControlChatTabPluginSelections,
  ) => void;
  readonly handleProjectAgentAccessChange: (
    access: NonNullable<RemoteControlAppAdvisorSettings['projectAgentAccess']>,
  ) => void;
  readonly saveDefaults: (
    patch: RemoteControlAppAdvisorSettingsSavePayload,
  ) => Promise<void>;
  readonly selectedModel:
    | RemoteControlAppAdvisorSettings['availableModels'][number]
    | undefined;
  readonly supportedThinkingLevels: readonly ThinkingLevel[];
}
const DEFAULT_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 36_500;
function retentionDraft(value: number | null): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_RETENTION_DAYS
    ? value
    : DEFAULT_RETENTION_DAYS;
}
/** Keep the loaded draft and its saves on the same remote connection. */
export function useOrchestratorRemoteSettings(
  { onLoad }: OrchestratorRemoteSettingsSource,
  errorCopy: (error: unknown, action: string) => string,
): RemoteSettingsState {
  const [binding, setBinding] =
    useState<LoadedOrchestratorRemoteSettings | null>(null);
  const [settings, setSettings] =
    useState<RemoteControlAppAdvisorSettings | null>(null);
  const [savedInstructions, setSavedInstructions] = useState<{
    content: string;
    revision: string | undefined;
  } | null>(null);
  const [retentionDays, setRetentionDays] = useState(DEFAULT_RETENTION_DAYS);
  const [autoArchiveEnabled, setAutoArchiveEnabled] = useState(false);
  const [autoArchiveDays, setAutoArchiveDays] = useState(
    DEFAULT_RETENTION_DAYS,
  );
  const [loadingError, setLoadingError] = useState(false);
  // Each Try again reads once more; the failure stays shown while it runs.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [reloading, setReloading] = useState(false);
  const reload = useCallback((): void => {
    setReloading(true);
    setLoadAttempt((attempt) => attempt + 1);
  }, []);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingProjectAgentAccess, setSavingProjectAgentAccess] =
    useState(false);

  useEffect(() => {
    // A computer change must leave the open draft available to copy.
    if (binding) return;
    let cancelled = false;
    void onLoad()
      .then((loadedBinding) => {
        if (cancelled) return;
        setReloading(false);
        if (!loadedBinding || loadedBinding.signal.aborted) {
          setLoadingError(true);
          return;
        }
        const { settings: loaded } = loadedBinding;
        setLoadingError(false);
        setBinding(loadedBinding);
        setSettings(loaded);
        setSavedInstructions({
          content: loaded.instructions,
          revision: loaded.instructionsRevision,
        });
        setRetentionDays(retentionDraft(loaded.archiveRetentionDays));
        setAutoArchiveEnabled(
          typeof loaded.autoArchiveDays === 'number' &&
            loaded.autoArchiveDays > 0,
        );
        setAutoArchiveDays(
          typeof loaded.autoArchiveDays === 'number' &&
            loaded.autoArchiveDays > 0
            ? loaded.autoArchiveDays
            : DEFAULT_RETENTION_DAYS,
        );
      })
      .catch(() => {
        if (cancelled) return;
        setReloading(false);
        setLoadingError(true);
      });
    return (): void => {
      cancelled = true;
    };
  }, [binding, onLoad, loadAttempt]);

  const selectedModel = useMemo(
    () =>
      settings?.availableModels.find((model) => model.id === settings.model),
    [settings],
  );
  const supportedThinkingLevels =
    selectedModel?.supportedThinkingLevels ??
    (['off', 'medium', 'high', 'xhigh'] as const);
  const instructionsDirty =
    settings !== null && settings.instructions !== savedInstructions?.content;
  const persistedRetention = retentionDays;
  const retentionDirty =
    settings !== null &&
    (settings.archiveRetentionDays === null ||
      settings.archiveRetentionDays !== persistedRetention);
  const persistedAutoArchive = autoArchiveEnabled ? autoArchiveDays : null;
  const autoArchiveDirty =
    settings !== null && settings.autoArchiveDays !== persistedAutoArchive;
  const isDirty = instructionsDirty || retentionDirty || autoArchiveDirty;

  const reportSaveError = (error: unknown, action: string): void => {
    setSaveError(
      binding?.signal.aborted
        ? "Couldn't finish saving to the original computer. Copy your draft, then reopen settings."
        : errorCopy(error, action),
    );
  };

  const saveDefaults = async (
    patch: RemoteControlAppAdvisorSettingsSavePayload,
  ): Promise<void> => {
    if (!settings || !binding) return;
    setSaveError(null);
    setSettings({
      ...settings,
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.thinkingLevel !== undefined
        ? { thinkingLevel: patch.thinkingLevel }
        : {}),
      ...(patch.pluginSelections !== undefined
        ? { pluginSelections: patch.pluginSelections }
        : {}),
    });
    try {
      await binding.save(patch);
    } catch (error) {
      reportSaveError(error, 'save the defaults');
    }
  };

  const handleModelChange = (model: string): void => {
    if (!settings) return;
    const option = settings.availableModels.find(
      (candidate) => candidate.id === model,
    );
    const levels = option?.supportedThinkingLevels ?? supportedThinkingLevels;
    const thinkingLevel =
      levels.length > 0
        ? clampThinkingLevelToDeclared(settings.thinkingLevel, levels)
        : settings.thinkingLevel;
    void saveDefaults({ model, thinkingLevel });
  };

  const handlePluginChange = (
    pluginSelections: RemoteControlChatTabPluginSelections,
  ): void => {
    void saveDefaults({ pluginSelections });
  };

  const saveProjectAgentAccess = async (
    projectAgentAccess: NonNullable<
      RemoteControlAppAdvisorSettings['projectAgentAccess']
    >,
  ): Promise<void> => {
    if (!settings?.projectAgentAccess || !binding || savingProjectAgentAccess)
      return;
    const savedAccess = settings.projectAgentAccess;
    setSaveError(null);
    setSavingProjectAgentAccess(true);
    setSettings((current) =>
      current ? { ...current, projectAgentAccess } : current,
    );
    try {
      await binding.save({ projectAgentAccess });
    } catch (error) {
      setSettings((current) =>
        current ? { ...current, projectAgentAccess: savedAccess } : current,
      );
      reportSaveError(error, 'save project agent access');
    } finally {
      setSavingProjectAgentAccess(false);
    }
  };

  const handleProjectAgentAccessChange = (
    projectAgentAccess: NonNullable<
      RemoteControlAppAdvisorSettings['projectAgentAccess']
    >,
  ): void => {
    void saveProjectAgentAccess(projectAgentAccess);
  };

  const handleSave = async (): Promise<void> => {
    if (!settings || !binding || saving || !isDirty) return;
    setSaving(true);
    setSaveError(null);
    const draftRevision = savedInstructions?.revision;
    try {
      if (instructionsDirty && draftRevision) {
        const revision = await binding.save({
          instructions: {
            content: settings.instructions,
            revision: draftRevision,
          },
        });
        if (!revision) throw new Error('The settings were not saved.');
        setSavedInstructions((current) =>
          current === savedInstructions
            ? { content: settings.instructions, revision }
            : current,
        );
      }
      if (retentionDirty || autoArchiveDirty) {
        await binding.save({
          ...(retentionDirty
            ? { archiveRetentionDays: persistedRetention }
            : {}),
          ...(autoArchiveDirty
            ? { autoArchiveDays: persistedAutoArchive }
            : {}),
        });
        setSettings((current) =>
          current &&
          current.instructionsRevision === settings.instructionsRevision
            ? {
                ...current,
                archiveRetentionDays: persistedRetention,
                autoArchiveDays: persistedAutoArchive,
              }
            : current,
        );
      }
      if (instructionsDirty && !draftRevision) {
        setSaveError(
          "Couldn't save instructions. Update the connected computer.",
        );
      }
    } catch (error) {
      if (
        !binding.signal.aborted &&
        error instanceof OrchestratorInstructionsConflictError
      ) {
        const { title, description } =
          OrchestratorInstructionsConflictError.copy;
        setSaveError(`${title} ${description}`);
      } else {
        reportSaveError(error, 'save settings');
      }
    } finally {
      setSaving(false);
    }
  };

  return {
    settings,
    setSettings,
    retentionDays,
    setRetentionDays,
    autoArchiveEnabled,
    setAutoArchiveEnabled,
    autoArchiveDays,
    setAutoArchiveDays,
    loadingError,
    reload,
    reloading,
    saveError,
    saving,
    savingProjectAgentAccess,
    isDirty,
    handleSave,
    handleModelChange,
    handlePluginChange,
    handleProjectAgentAccessChange,
    saveDefaults,
    selectedModel,
    supportedThinkingLevels,
  };
}
