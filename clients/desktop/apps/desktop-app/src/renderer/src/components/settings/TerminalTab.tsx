import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  TerminalPreset,
  TerminalPresetIcon,
  TerminalShellProfile,
  TerminalShellProfileId,
} from '@canopy/desktop-shared/types';
import {
  getTerminalPresetImageMaxFileBytes,
  isTerminalPresetImageDataUrl,
  isTerminalPresetImageMimeType,
  TERMINAL_PRESET_IMAGE_ACCEPT,
} from '@canopy/desktop-shared/lib/terminal-preset-images';
import {
  ImagePlus,
  PlusIcon,
  SyncIcon,
  TerminalBorderedIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  fetchTerminalPanelPreferences,
  loadTerminalShellProfiles,
  setCachedTerminalPanelPreferences,
} from '@/lib/terminalShellProfiles';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { Tooltip } from '@canopy/ui-shared/components/Tooltip';
import {
  Button,
  SettingsSelect,
  Surface,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import {
  TerminalDefaultShellNote,
  TERMINAL_DEFAULT_SHELL_TOOLTIP,
} from '@/components/terminal/TerminalDefaultShellNote';
import { useTerminalPresetColorMode } from '@/hooks/useTerminalPresetColorMode';
import {
  resolveTerminalPresetImageDataUrl,
  type TerminalPresetColorMode,
} from '@/lib/terminalPresetIcons';
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSubRow,
  SettingsTextField,
} from './SettingsLayout';

interface ShellOption {
  id: TerminalShellProfileId;
  label: string;
  isDefault: boolean;
}

function presetIconPreview(preset: TerminalPreset): JSX.Element {
  if (preset.icon?.kind === 'image') {
    return (
      <span className="flex items-center gap-1">
        {preset.icon.lightDataUrl ? (
          <img
            src={preset.icon.lightDataUrl}
            alt="Light mode preset icon"
            data-testid="terminal-preset-image-light"
            className="h-6 w-6 rounded object-contain"
          />
        ) : null}
        {preset.icon.darkDataUrl ? (
          <img
            src={preset.icon.darkDataUrl}
            alt="Dark mode preset icon"
            data-testid="terminal-preset-image-dark"
            className="h-6 w-6 rounded object-contain"
          />
        ) : null}
      </span>
    );
  }
  if (preset.icon?.kind === 'character') {
    return <span className="text-m leading-none">{preset.icon.value}</span>;
  }
  return <TerminalBorderedIcon size="xl" />;
}

/**
 * A file picker behind a settings button: the button opens the hidden input,
 * which keeps its own accessible name for the picked file.
 */
function PresetImageButton({
  inputLabel,
  onChange,
  children,
}: {
  inputLabel: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  children: ReactNode;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <Button
        size="compact"
        variant="secondary"
        onClick={() => inputRef.current?.click()}
      >
        {children}
      </Button>
      <input
        ref={inputRef}
        type="file"
        tabIndex={-1}
        aria-label={inputLabel}
        accept={TERMINAL_PRESET_IMAGE_ACCEPT}
        onChange={onChange}
        className="sr-only"
      />
    </>
  );
}

/** One mode's image, a sub-row of the preset's "Image or SVG" row. */
function PresetImageModeRow({
  colorMode,
  configuredDataUrl,
  resolvedDataUrl,
  onChange,
}: {
  colorMode: TerminalPresetColorMode;
  configuredDataUrl?: string;
  resolvedDataUrl: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}): JSX.Element {
  const modeLabel = colorMode === 'light' ? 'Light' : 'Dark';
  return (
    <SettingsSubRow
      label={`${modeLabel} mode`}
      description={
        configuredDataUrl ? 'Configured' : 'Using the other mode image'
      }
      control={
        <>
          <img
            src={resolvedDataUrl}
            alt={`${modeLabel} mode preset icon preview`}
            data-testid={`terminal-preset-image-${colorMode}-preview`}
            className="h-7 w-7 shrink-0 rounded object-contain"
          />
          <PresetImageButton
            inputLabel={`${modeLabel} mode image`}
            onChange={onChange}
          >
            {configuredDataUrl ? 'Replace' : 'Set image'}
          </PresetImageButton>
        </>
      }
    />
  );
}

/** The presets header row's hint: how many presets the list holds. */
function presetCountLabel(count: number): string {
  if (count === 0) return 'No presets yet';
  return `${String(count)} preset${count === 1 ? '' : 's'}`;
}

export function TerminalTab(): JSX.Element {
  const colorMode = useTerminalPresetColorMode();
  const [profiles, setProfiles] = useState<TerminalShellProfile[]>([]);
  const [disabledShells, setDisabledShells] = useState<
    TerminalShellProfileId[]
  >([]);
  const [presets, setPresets] = useState<TerminalPreset[]>([]);
  const [draft, setDraft] = useState<TerminalPreset | null>(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState<number | null>(null);
  const [loadError, setLoadError] = useState(false);
  // A failure shows in the section whose change failed.
  const [error, setError] = useState<{
    readonly section: 'shells' | 'presets';
    readonly failure: InlineFailure;
  } | null>(null);

  useEffect(() => {
    let canceled = false;
    const profilesLoad = loadTerminalShellProfiles().then((nextProfiles) => {
      if (!canceled) setProfiles(nextProfiles);
    });
    void Promise.all([profilesLoad, fetchTerminalPanelPreferences()])
      .then(([, preferences]) => {
        if (canceled) return;
        setDisabledShells(preferences.disabledTerminalShellProfileIds);
        setPresets(preferences.terminalPresets);
        setRevision(preferences.revision);
        setLoaded(true);
      })
      .catch((caught: unknown) => {
        reportClientAppError(caught);
        if (!canceled) setLoadError(true);
      });
    return (): void => {
      canceled = true;
    };
  }, []);

  const shellOptions = useMemo<ShellOption[]>(() => {
    return profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      isDefault: profile.isDefault,
    }));
  }, [profiles]);

  const defaultShellProfileId =
    shellOptions.find((option) => option.isDefault)?.id ?? 'default';

  const persist = async (
    nextDisabledShells: TerminalShellProfileId[],
    nextPresets: TerminalPreset[],
    section: 'shells' | 'presets' = 'presets',
  ): Promise<boolean> => {
    if (revision === null) return false;
    setSaving(true);
    setError(null);
    try {
      const result = await window.api.terminal.updateSettings({
        expectedRevision: revision,
        disabledTerminalShellProfileIds: nextDisabledShells,
        terminalPresets: nextPresets,
        idempotencyKey: crypto.randomUUID(),
      });
      const saved = result.ok
        ? result.settings
        : result.error.code === 'conflict'
          ? result.error.settings
          : null;
      if (saved) {
        setDisabledShells(saved.disabledTerminalShellProfileIds);
        setPresets(saved.terminalPresets);
        setRevision(saved.revision);
        setCachedTerminalPanelPreferences(saved);
      }
      if (!result.ok) {
        setError({ section, failure: { error: result.error.message } });
        return false;
      }
      return true;
    } catch (caught) {
      const appError = toAppError(resolveClientAppError(caught));
      if (appError)
        setError({
          section,
          failure: inlineFailure(appError, "Couldn't save Terminal settings."),
        });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleShellToggle = (
    profileId: TerminalShellProfileId,
    enabled: boolean,
  ): void => {
    const next = enabled
      ? disabledShells.filter((id) => id !== profileId)
      : Array.from(new Set([...disabledShells, profileId]));
    setDisabledShells(next);
    void persist(next, presets, 'shells');
  };

  const startAddPreset = (): void => {
    setDraft({
      id: crypto.randomUUID(),
      name: '',
      terminalProfileId: defaultShellProfileId,
      command: '',
      enabled: true,
    });
  };

  const handleSavePreset = (): void => {
    if (!draft || !draft.name.trim() || !draft.command.trim()) return;
    const normalized = {
      ...draft,
      name: draft.name.trim(),
      command: draft.command.trim(),
    };
    const next = presets.some((preset) => preset.id === normalized.id)
      ? presets.map((preset) =>
          preset.id === normalized.id ? normalized : preset,
        )
      : [...presets, normalized];
    void persist(disabledShells, next).then((saved) => {
      if (saved) setDraft(null);
    });
  };

  const handleImage = (
    event: ChangeEvent<HTMLInputElement>,
    targetMode: TerminalPresetColorMode,
  ): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!isTerminalPresetImageMimeType(file.type)) {
      setError({
        section: 'presets',
        failure: {
          error: 'Preset icons must be PNG, JPEG, GIF, WebP, or SVG images.',
        },
      });
      return;
    }
    if (file.size > getTerminalPresetImageMaxFileBytes(file.type)) {
      setError({
        section: 'presets',
        failure: {
          error: 'Preset icons must be smaller than 1 MB after encoding.',
        },
      });
      return;
    }
    setError(null);
    const reader = new FileReader();
    reader.onload = (): void => {
      if (!isTerminalPresetImageDataUrl(reader.result)) {
        setError({
          section: 'presets',
          failure: {
            error: "Couldn't read this preset icon. Try a different image.",
          },
        });
        return;
      }
      const dataUrl = reader.result;
      setDraft((current) =>
        current
          ? {
              ...current,
              icon: {
                ...(current.icon?.kind === 'image'
                  ? current.icon
                  : { kind: 'image' as const }),
                [targetMode === 'light' ? 'lightDataUrl' : 'darkDataUrl']:
                  dataUrl,
              },
            }
          : current,
      );
    };
    reader.readAsDataURL(file);
  };

  const handleSwapImages = (): void => {
    setDraft((current) => {
      if (
        current?.icon?.kind !== 'image' ||
        !current.icon.lightDataUrl ||
        !current.icon.darkDataUrl
      ) {
        return current;
      }
      return {
        ...current,
        icon: {
          kind: 'image',
          lightDataUrl: current.icon.darkDataUrl,
          darkDataUrl: current.icon.lightDataUrl,
        },
      };
    });
  };

  const draftImage = draft?.icon?.kind === 'image' ? draft.icon : undefined;
  const draftLightImage = resolveTerminalPresetImageDataUrl(
    draftImage,
    'light',
  );
  const draftDarkImage = resolveTerminalPresetImageDataUrl(draftImage, 'dark');

  return (
    <SettingsPage
      title="Terminal"
      description="Choose the shells and command presets available when opening a Terminal panel."
      dataTestId="settings-tab-terminal"
    >
      <SettingsSection
        title="Shells"
        description="Show or hide shells detected on this computer."
        dataTestId="terminal-settings-shells"
      >
        <DesktopErrorBanner
          errorSource="terminal-settings-load-error"
          className=""
          // The Terminal settings golden reads this exact sentence.
          error={loadError ? 'Could not load Terminal settings.' : null}
          testId="terminal-settings-load-error"
        />
        {error?.section === 'shells' ? (
          <DesktopErrorBanner
            errorSource="terminal-tab"
            className=""
            error={error.failure.error}
            {...(error.failure.details === undefined
              ? {}
              : { details: error.failure.details })}
            onDismiss={(): void => setError(null)}
          />
        ) : null}
        <SettingsGroup>
          {shellOptions.map((option) => {
            const switchId = `terminal-shell-switch-${option.id}`;
            return (
              <SettingsRow
                key={option.id}
                label={option.label}
                htmlFor={switchId}
                dataTestId={`terminal-shell-option-${option.id}`}
                control={
                  <>
                    {option.isDefault ? (
                      <Tooltip label={TERMINAL_DEFAULT_SHELL_TOOLTIP}>
                        {/* Focusable so the keyboard reaches the tooltip. */}
                        <TerminalDefaultShellNote
                          testId="terminal-shell-default-badge"
                          focusable
                        />
                      </Tooltip>
                    ) : null}
                    <ToggleSwitch
                      id={switchId}
                      checked={!disabledShells.includes(option.id)}
                      label={`${option.label} shell`}
                      dataTestId={`terminal-shell-toggle-${option.id}`}
                      disabled={!loaded || saving}
                      onChange={(next) => handleShellToggle(option.id, next)}
                    />
                  </>
                }
              />
            );
          })}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Presets"
        description="Open a selected shell and immediately run a default command."
        dataTestId="terminal-settings-presets"
      >
        {error?.section === 'presets' ? (
          <DesktopErrorBanner
            errorSource="terminal-tab"
            className=""
            error={error.failure.error}
            {...(error.failure.details === undefined
              ? {}
              : { details: error.failure.details })}
            onDismiss={(): void => setError(null)}
          />
        ) : null}
        <SettingsGroup>
          <SettingsRow
            label="Saved presets"
            description={presetCountLabel(presets.length)}
            control={
              <Button
                size="compact"
                variant="secondary"
                data-testid="terminal-preset-add"
                onClick={startAddPreset}
                disabled={!loaded || draft !== null || saving}
              >
                <PlusIcon size="sm" />
                Add preset
              </Button>
            }
          />
          {presets.map((preset) => (
            <div
              key={preset.id}
              data-testid={`terminal-preset-${preset.id}`}
              className="flex min-h-10 items-center gap-3"
            >
              <Surface
                variant="group"
                size="small"
                className="min-w-8 shrink-0"
              >
                <div className="flex items-center justify-center min-h-8 px-1 fg-secondary">
                  {presetIconPreview(preset)}
                </div>
              </Surface>
              <div className="min-w-0 flex-1">
                {/* The name flips the preset's switch; the command below stays
                    selectable text. */}
                <SettingsRow
                  htmlFor={`terminal-preset-switch-${preset.id}`}
                  label={preset.name}
                  description={
                    <span
                      className={`${POSTHOG_REPLAY_BLOCK_CLASS} block truncate font-mono`}
                    >
                      {preset.command}
                    </span>
                  }
                />
              </div>
              <Button
                size="compact"
                variant="secondary"
                disabled={!loaded || saving}
                onClick={() =>
                  setDraft({
                    ...preset,
                    terminalProfileId:
                      preset.terminalProfileId === 'default'
                        ? defaultShellProfileId
                        : preset.terminalProfileId,
                  })
                }
              >
                Edit
              </Button>
              <ToggleSwitch
                id={`terminal-preset-switch-${preset.id}`}
                checked={preset.enabled}
                label={`${preset.name} preset`}
                dataTestId={`terminal-preset-toggle-${preset.id}`}
                disabled={!loaded || saving}
                onChange={(enabled) => {
                  const next = presets.map((entry) =>
                    entry.id === preset.id ? { ...entry, enabled } : entry,
                  );
                  setPresets(next);
                  void persist(disabledShells, next);
                }}
              />
              <Button
                size="compact"
                variant="secondary"
                iconOnly
                aria-label={`Remove ${preset.name}`}
                disabled={!loaded || saving}
                onClick={() => {
                  const next = presets.filter(
                    (entry) => entry.id !== preset.id,
                  );
                  setPresets(next);
                  void persist(disabledShells, next);
                }}
              >
                <TrashIcon size="sm" />
              </Button>
            </div>
          ))}
        </SettingsGroup>

        {draft ? (
          <SettingsGroup dataTestId="terminal-preset-editor">
            <SettingsRow
              label="Name"
              htmlFor="terminal-preset-name"
              control={
                <SettingsTextField
                  id="terminal-preset-name"
                  width="md"
                  aria-label="Preset name"
                  value={draft.name}
                  maxLength={64}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                  placeholder="Custom TUI"
                />
              }
            />
            <SettingsRow
              label="Shell"
              htmlFor="terminal-preset-shell"
              control={
                <SettingsSelect
                  id="terminal-preset-shell"
                  aria-label="Shell"
                  options={shellOptions.map((option) => ({
                    value: option.id,
                    label: option.label,
                  }))}
                  value={draft.terminalProfileId}
                  onValueChange={(next) => {
                    const selected = shellOptions.find(
                      (option) => option.id === next,
                    );
                    if (!selected) return;
                    setDraft({
                      ...draft,
                      terminalProfileId: selected.id,
                    });
                  }}
                />
              }
            />
            <SettingsRow
              label="Command"
              htmlFor="terminal-preset-command"
              description="Runs in the shell when the terminal opens."
            >
              <SettingsTextField
                mono
                id="terminal-preset-command"
                width="full"
                aria-label="Command"
                value={draft.command}
                maxLength={4000}
                onChange={(event) =>
                  setDraft({ ...draft, command: event.target.value })
                }
                placeholder="npm run dev"
              />
            </SettingsRow>
            <SettingsRow
              label="Icon"
              htmlFor="terminal-preset-icon-character"
              description="A character, or an image or SVG."
              control={
                <>
                  <SettingsTextField
                    id="terminal-preset-icon-character"
                    width="xs"
                    aria-label="Icon character"
                    value={
                      draft.icon?.kind === 'character' ? draft.icon.value : ''
                    }
                    maxLength={16}
                    onChange={(event) => {
                      const value = event.target.value;
                      const icon: TerminalPresetIcon | undefined = value
                        ? { kind: 'character', value }
                        : undefined;
                      setDraft({ ...draft, icon });
                    }}
                    placeholder="★"
                  />
                  {!draftImage ? (
                    <PresetImageButton
                      inputLabel="Image or SVG"
                      onChange={(event) => handleImage(event, colorMode)}
                    >
                      <ImagePlus size="sm" />
                      Image or SVG
                    </PresetImageButton>
                  ) : null}
                </>
              }
            />
            {draftImage && draftLightImage && draftDarkImage ? (
              <SettingsRow
                label="Image or SVG"
                description="A missing mode reuses the configured image."
                dataTestId="terminal-preset-images"
                control={
                  draftImage.lightDataUrl && draftImage.darkDataUrl ? (
                    <Tooltip label="Swap light and dark images">
                      <Button
                        size="compact"
                        variant="secondary"
                        iconOnly
                        aria-label="Swap light and dark preset images"
                        onClick={handleSwapImages}
                      >
                        <SyncIcon size="sm" />
                      </Button>
                    </Tooltip>
                  ) : null
                }
              >
                <PresetImageModeRow
                  colorMode="light"
                  configuredDataUrl={draftImage.lightDataUrl}
                  resolvedDataUrl={draftLightImage}
                  onChange={(event) => handleImage(event, 'light')}
                />
                <PresetImageModeRow
                  colorMode="dark"
                  configuredDataUrl={draftImage.darkDataUrl}
                  resolvedDataUrl={draftDarkImage}
                  onChange={(event) => handleImage(event, 'dark')}
                />
              </SettingsRow>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                size="compact"
                variant="secondary"
                onClick={() => setDraft(null)}
              >
                Cancel
              </Button>
              <Button
                size="compact"
                variant="primary"
                onClick={handleSavePreset}
                disabled={
                  !loaded ||
                  saving ||
                  !draft.name.trim() ||
                  !draft.command.trim()
                }
              >
                Save preset
              </Button>
            </div>
          </SettingsGroup>
        ) : null}
      </SettingsSection>
    </SettingsPage>
  );
}
