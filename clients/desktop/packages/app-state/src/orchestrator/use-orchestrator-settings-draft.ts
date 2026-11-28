'use client';

import { useEffect, useState } from 'react';
import type { OrchestratorInstructionsDraft } from '@canopy/protocol/remote-control/shell';
import { normalizeArchiveRetentionDays } from '@canopy/protocol/archive-retention';
import type {
  OrchestratorRetentionSettings,
  OrchestratorSettingsDraftClient,
} from '@canopy/app-core';

const DEFAULT_DAYS = 7;

export interface OrchestratorSettingsDraft<Failure> {
  readonly instructions: string;
  readonly setInstructions: (value: string) => void;
  readonly instructionsLoading: boolean;
  readonly instructionsLoadError: boolean;
  readonly retryInstructions: () => void;
  readonly retentionDays: number;
  readonly setRetentionDays: (value: number) => void;
  readonly autoArchiveEnabled: boolean;
  readonly setAutoArchiveEnabled: (value: boolean) => void;
  readonly autoArchiveDays: number;
  readonly setAutoArchiveDays: (value: number) => void;
  readonly isDirty: boolean;
  readonly saving: boolean;
  readonly saveError: Failure | null;
  readonly save: () => Promise<void>;
}

/**
 * Acknowledges instructions before retention, preserving partial-save recovery.
 * The host owns transport, error presentation and the settings-saved broadcast.
 */
export function useOrchestratorSettingsDraft<Failure>(
  client: OrchestratorSettingsDraftClient,
  failureFor: (error: unknown) => Failure | null,
): OrchestratorSettingsDraft<Failure> {
  const [instructions, setInstructions] = useState('');
  const [savedInstructions, setSavedInstructions] =
    useState<OrchestratorInstructionsDraft | null>(null);
  const [instructionsLoading, setInstructionsLoading] = useState(true);
  const [instructionsLoadError, setInstructionsLoadError] = useState(false);
  const [instructionsLoadAttempt, setInstructionsLoadAttempt] = useState(0);
  const [settings, setSettings] =
    useState<OrchestratorRetentionSettings | null>(null);
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [autoArchiveEnabled, setAutoArchiveEnabled] = useState(false);
  const [autoArchiveDays, setAutoArchiveDays] = useState(DEFAULT_DAYS);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<Failure | null>(null);

  const applyRetention = (loaded: OrchestratorRetentionSettings): void => {
    setSettings(loaded);
    setDays(normalizeArchiveRetentionDays(loaded.archiveRetentionDays));
    setAutoArchiveEnabled(
      typeof loaded.autoArchiveDays === 'number' && loaded.autoArchiveDays > 0,
    );
    setAutoArchiveDays(
      typeof loaded.autoArchiveDays === 'number' && loaded.autoArchiveDays > 0
        ? loaded.autoArchiveDays
        : DEFAULT_DAYS,
    );
  };

  useEffect(() => {
    let cancelled = false;
    void client
      .loadInstructions()
      .then((loaded) => {
        if (cancelled) return;
        setInstructions(loaded.content);
        setSavedInstructions(loaded);
        setInstructionsLoadError(false);
        setInstructionsLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setInstructionsLoadError(true);
        setInstructionsLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [client, instructionsLoadAttempt]);

  useEffect(() => {
    let cancelled = false;
    void client
      .loadRetention()
      .then((loaded) => {
        if (cancelled) return;
        setSettings(loaded);
        setDays(normalizeArchiveRetentionDays(loaded.archiveRetentionDays));
        setAutoArchiveEnabled(
          typeof loaded.autoArchiveDays === 'number' &&
            loaded.autoArchiveDays > 0,
        );
        setAutoArchiveDays(
          typeof loaded.autoArchiveDays === 'number' &&
            loaded.autoArchiveDays > 0
            ? loaded.autoArchiveDays
            : DEFAULT_DAYS,
        );
      })
      .catch(() => undefined);
    return (): void => {
      cancelled = true;
    };
  }, [client]);

  const instructionsDirty =
    !instructionsLoading &&
    !instructionsLoadError &&
    savedInstructions !== null &&
    instructions !== savedInstructions.content;
  const retentionDirty =
    settings !== null &&
    (settings.archiveRetentionDays == null ||
      settings.archiveRetentionDays === 0 ||
      normalizeArchiveRetentionDays(settings.archiveRetentionDays) !== days);
  const nextAutoArchiveDays = autoArchiveEnabled ? autoArchiveDays : null;
  const autoArchiveDirty =
    settings !== null &&
    (settings.autoArchiveDays ?? null) !== nextAutoArchiveDays;
  const isDirty = instructionsDirty || retentionDirty || autoArchiveDirty;

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (instructionsDirty && savedInstructions) {
        const revision = await client.saveInstructions({
          content: instructions,
          revision: savedInstructions.revision,
        });
        setSavedInstructions((current) =>
          current === savedInstructions
            ? { content: instructions, revision }
            : current,
        );
      }
      if (retentionDirty || autoArchiveDirty) {
        applyRetention(
          await client.saveRetention({
            ...(retentionDirty ? { archiveRetentionDays: days } : {}),
            ...(autoArchiveDirty
              ? { autoArchiveDays: nextAutoArchiveDays }
              : {}),
          }),
        );
      }
    } catch (error) {
      const failure = failureFor(error);
      if (failure) setSaveError(failure);
    } finally {
      setSaving(false);
    }
  };
  return {
    instructions,
    setInstructions,
    instructionsLoading,
    instructionsLoadError,
    retryInstructions: (): void => {
      setInstructionsLoading(true);
      setInstructionsLoadAttempt((attempt) => attempt + 1);
    },
    retentionDays: days,
    setRetentionDays: setDays,
    autoArchiveEnabled,
    setAutoArchiveEnabled,
    autoArchiveDays,
    setAutoArchiveDays,
    isDirty,
    saving,
    saveError,
    save,
  };
}
