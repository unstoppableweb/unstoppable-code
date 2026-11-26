import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import {
  createCoreTerminalSettingsHandlers,
  TerminalPresetIconMissingError,
  TerminalSettingsOutcomeUnknownError,
  TerminalSettingsUnavailableError,
  type CoreTerminalSettingsHandlers,
  type TerminalSettingsStore,
  type TerminalSettingsValue,
} from '@canopy/core-runtime/node/terminal';
import { isStorageOutcomeUnknownError } from '@canopy/core-runtime/storage';
import type {
  CoreTerminalPreset,
  CoreTerminalSettings,
} from '@canopy/protocol/canopy-core';
import type { TerminalPreset } from '@canopy/desktop-shared/types';
import type { DomainPreferencesData } from '@canopy/desktop-shared/node/preferences/client-local-preferences';

export const TERMINAL_PRESET_IMAGE_ARTIFACT_PREFIX =
  'terminal-preset-image:sha256:';

/** The artifact id of a preset image data URL (CAN-4148 D6). */
export function terminalPresetImageArtifactId(dataUrl: string): string {
  return `${TERMINAL_PRESET_IMAGE_ARTIFACT_PREFIX}${createHash('sha256').update(dataUrl, 'utf8').digest('hex')}`;
}

/**
 * The preference reads and writes the store needs; defaults to Electron main's
 * store. Domain keys only: terminal settings never touch the client-local
 * document (CAN-4472).
 */
export interface DesktopTerminalSettingsPreferences {
  readAuthority(): Promise<{
    preferences: DomainPreferencesData;
    authority: 'ok' | 'absent' | 'unreadable';
  }>;
  update(
    updater: (
      latest: DomainPreferencesData,
    ) => Partial<DomainPreferencesData> | null,
  ): Promise<{ previous: DomainPreferencesData; next: DomainPreferencesData }>;
}

const captures = new AsyncLocalStorage<Map<string, string>>();
const staged = new AsyncLocalStorage<ReadonlyMap<string, string>>();

export async function captureTerminalPresetImages<Result>(
  dispatch: () => Promise<Result>,
): Promise<{ result: Result; images: ReadonlyMap<string, string> }> {
  const images = new Map<string, string>();
  const result = await captures.run(images, dispatch);
  return { result, images };
}

export function withStagedTerminalPresetImages<Result>(
  dataUrls: readonly string[],
  run: () => Promise<Result>,
): Promise<Result> {
  return staged.run(
    new Map(dataUrls.map((url) => [terminalPresetImageArtifactId(url), url])),
    run,
  );
}

function project(preferences: DomainPreferencesData): CoreTerminalSettings {
  const imageId = (url: string | undefined): string | null => {
    if (!url) return null;
    const id = terminalPresetImageArtifactId(url);
    captures.getStore()?.set(id, url);
    return id;
  };
  return {
    revision: preferences.terminalSettingsRevision,
    disabledProfileIds: [...preferences.disabledTerminalShellProfileIds],
    presets: preferences.terminalPresets.map((preset) => ({
      presetId: preset.id,
      name: preset.name,
      profileId: preset.terminalProfileId,
      command: preset.command,
      enabled: preset.enabled,
      icon: !preset.icon
        ? null
        : preset.icon.kind === 'character'
          ? { ...preset.icon }
          : {
              kind: 'image',
              lightArtifactId: imageId(preset.icon.lightDataUrl),
              darkArtifactId: imageId(preset.icon.darkDataUrl),
            },
    })),
  };
}

function toStored(
  preset: CoreTerminalPreset,
  images: ReadonlyMap<string, string>,
): TerminalPreset {
  const stored: TerminalPreset = {
    id: preset.presetId,
    name: preset.name,
    terminalProfileId: preset.profileId,
    command: preset.command,
    enabled: preset.enabled,
  };
  if (!preset.icon) return stored;
  if (preset.icon.kind === 'character')
    return { ...stored, icon: { ...preset.icon } };
  const resolveImage = (id: string): string => {
    const url = images.get(id) ?? staged.getStore()?.get(id);
    if (url) return url;
    throw new TerminalPresetIconMissingError(preset.presetId);
  };
  const { lightArtifactId, darkArtifactId } = preset.icon;
  return {
    ...stored,
    icon: {
      kind: 'image',
      ...(lightArtifactId !== null
        ? { lightDataUrl: resolveImage(lightArtifactId) }
        : {}),
      ...(darkArtifactId !== null
        ? { darkDataUrl: resolveImage(darkArtifactId) }
        : {}),
    },
  };
}

const defaultPreferences: DesktopTerminalSettingsPreferences = {
  readAuthority: async () => {
    const store = await import('../lib/preferences-store');
    return store.readPreferencesFileDetailed();
  },
  update: async (updater) => {
    const store = await import('../lib/preferences-store');
    return store.updatePreferencesFileWithPrevious(updater);
  },
};

export function createDesktopTerminalSettingsStore(
  preferences: DesktopTerminalSettingsPreferences = defaultPreferences,
): TerminalSettingsStore {
  return {
    read: async () => {
      const read = await preferences.readAuthority();
      if (read.authority === 'unreadable')
        throw new TerminalSettingsUnavailableError();
      return project(read.preferences);
    },
    replace: async (
      expected: number,
      next: TerminalSettingsValue,
      signal?: AbortSignal,
    ) => {
      let conflict = false;
      let aborted = false;
      try {
        const change = await preferences.update((latest) => {
          if (signal?.aborted) {
            aborted = true;
            return null;
          }
          if (latest.terminalSettingsRevision !== expected) {
            conflict = true;
            return null;
          }
          const images = new Map<string, string>();
          for (const preset of latest.terminalPresets) {
            if (preset.icon?.kind !== 'image') continue;
            for (const url of [
              preset.icon.lightDataUrl,
              preset.icon.darkDataUrl,
            ]) {
              if (url) images.set(terminalPresetImageArtifactId(url), url);
            }
          }
          return {
            disabledTerminalShellProfileIds: [...next.disabledProfileIds],
            terminalPresets: next.presets.map((preset) =>
              toStored(preset, images),
            ),
          };
        });
        if (aborted) signal?.throwIfAborted();
        return {
          outcome: conflict ? 'conflict' : 'replaced',
          settings: project(change.next),
        };
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'PREFERENCES_RECOVERY_REQUIRED'
        ) {
          throw new TerminalSettingsUnavailableError();
        }
        if (isStorageOutcomeUnknownError(error))
          throw new TerminalSettingsOutcomeUnknownError();
        throw error;
      }
    },
  };
}

export function createCoreTerminalSettingsAdapter(
  store: TerminalSettingsStore = createDesktopTerminalSettingsStore(),
): CoreTerminalSettingsHandlers {
  const handlers = createCoreTerminalSettingsHandlers(store);
  return {
    queries: {
      'core.terminal.settings.get': (params, context) =>
        handlers.queries['core.terminal.settings.get'](params, context),
    },
    instructions: {
      'core.terminal.settings.update': (params, context) =>
        handlers.instructions['core.terminal.settings.update'](params, context),
    },
  };
}
