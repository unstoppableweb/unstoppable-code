'use client';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type {
  RemoteControlAppAdvisorSettings,
  RemoteControlAppAdvisorSettingsSavePayload,
  RemoteControlChatTabPluginSelections,
} from '@canopy/protocol/remote-control/shell';
import {
  clampThinkingLevelToDeclared,
  type ThinkingLevel,
} from '@canopy/protocol/thinking';

export interface OrchestratorRemoteSettingsSource {
  readonly onLoad: () => Promise<RemoteControlAppAdvisorSettings | null>;
  readonly onSave: (
    patch: RemoteControlAppAdvisorSettingsSavePayload,
  ) => Promise<void>;
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
/** Remote settings keep one aggregate read and one patch acknowledgement. */
export function useOrchestratorRemoteSettings(
  { onLoad, onSave }: OrchestratorRemoteSettingsSource,
  errorCopy: (error: unknown, action: string) => string,
): RemoteSettingsState {
  const [settings, setSettings] =
    useState<RemoteControlAppAdvisorSettings | null>(null);
  const [savedInstructions, setSavedInstructions] = useState('');
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
    let cancelled = false;
    void onLoad()
      .then((loaded) => {
        if (cancelled) return;
        setReloading(false);
        if (!loaded) {
          setLoadingError(true);
          return;
        }
        setLoadingError(false);
        setSettings(loaded);
        setSavedInstructions(loaded.instructions);
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
  }, [onLoad, loadAttempt]);

  const selectedModel = useMemo(
    () =>
      settings?.availableModels.find((model) => model.id === settings.model),
    [settings],
  );
  const supportedThinkingLevels =
    selectedModel?.supportedThinkingLevels ??
    (['off', 'medium', 'high', 'xhigh'] as const);
  const instructionsDirty =
    settings !== null && settings.instructions !== savedInstructions;
  const persistedRetention = retentionDays;
  const retentionDirty =
    settings !== null &&
    (settings.archiveRetentionDays === null ||
      settings.archiveRetentionDays !== persistedRetention);
  const persistedAutoArchive = autoArchiveEnabled ? autoArchiveDays : null;
  const autoArchiveDirty =
    settings !== null && settings.autoArchiveDays !== persistedAutoArchive;
  const isDirty = instructionsDirty || retentionDirty || autoArchiveDirty;

  const saveDefaults = async (
    patch: RemoteControlAppAdvisorSettingsSavePayload,
  ): Promise<void> => {
    if (!settings) return;
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
      await onSave(patch);
    } catch (error) {
      setSaveError(errorCopy(error, 'save the defaults'));
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
    if (!settings?.projectAgentAccess || savingProjectAgentAccess) return;
    const savedAccess = settings.projectAgentAccess;
    setSaveError(null);
    setSavingProjectAgentAccess(true);
    setSettings((current) =>
      current ? { ...current, projectAgentAccess } : current,
    );
    try {
      await onSave({ projectAgentAccess });
    } catch (error) {
      setSettings((current) =>
        current ? { ...current, projectAgentAccess: savedAccess } : current,
      );
      setSaveError(errorCopy(error, 'save project agent access'));
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
    if (!settings || saving || !isDirty) return;
    setSaving(true);
    setSaveError(null);
    const patch: RemoteControlAppAdvisorSettingsSavePayload = {};
    if (instructionsDirty) patch.instructions = settings.instructions;
    if (retentionDirty) patch.archiveRetentionDays = persistedRetention;
    if (autoArchiveDirty) patch.autoArchiveDays = persistedAutoArchive;
    try {
      await onSave(patch);
      setSavedInstructions(settings.instructions);
      setSettings({
        ...settings,
        archiveRetentionDays: persistedRetention,
        autoArchiveDays: persistedAutoArchive,
      });
    } catch (error) {
      setSaveError(errorCopy(error, 'save settings'));
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
