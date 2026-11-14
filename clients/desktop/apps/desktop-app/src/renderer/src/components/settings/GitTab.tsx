import { type JSX, useEffect, useState } from 'react';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  OLLAMA_MODELS,
  clampThinkingLevelForModel,
  getModelDisplayName,
  getProviderForModel,
  getThinkingUiOptionsForProvider,
  getThinkingUiValueForProvider,
  normalizePersistedThinkingLevel,
  normalizeThinkingForProvider,
  requireProviderForModel,
  resolveOverallDefault,
} from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { toAppError } from '@canopy/protocol/app-errors';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import { DEFAULT_VOICE_DICTATION_ENABLED } from '@canopy/desktop-shared/constants/preferences';
import type {
  BranchNamePrefixMode,
  GitExecutableStatus,
  PreferencesData,
  PrInstructionMode,
  ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { createGitTabFailedLoadPreferences } from './git-tab-fallback-preferences';
import { brandText } from '@/lib/brand';
import {
  GIT_LINUX_INSTALL_URL,
  LinuxGitInstallInstructions,
} from '../startup/LinuxGitInstallInstructions';
import { emitPreferencesUpdated } from '@/lib/preferences-events';
import { useGitHubCliStatus } from '@/hooks/useGitHubCliStatus';
import { useBranchDisplayStore } from '@/stores/branchDisplayStore';
import { useBranchGroupingPreferenceStore } from '@/stores/branchGroupingPreferenceStore';
import { mergeMappingsWithBuiltins } from '@canopy/desktop-shared/lib/branch-display-mapping';
import {
  Stack,
  Button,
  Notice,
  SettingsSelect,
  ToggleSwitch,
  type SettingsSelectItem,
} from '@canopy/ui-shared/components';
import { getHookTriggerDisplayName } from '@canopy/desktop-shared/hooks';
import {
  DEFAULT_MERGE_QUEUE_AGENT_HANDLING,
  isMergeQueueAgentHandling,
  type MergeQueueAgentHandling,
} from '@canopy/desktop-shared/types/github';
import { BranchDisplayMappings } from './BranchDisplayMappings';
import { ModelThinkingPreferenceRow } from './ModelThinkingPreferenceRow';
import { SettingsPluginPicker } from './SettingsPluginPicker';
import {
  SettingsGroup,
  SettingsPage,
  SettingsRadioGroup,
  SettingsRow,
  SettingsSection,
  SettingsSegmentedControl,
  SettingsSubRow,
  SettingsTextArea,
  SettingsTextField,
  type SettingsRadioOption,
} from './SettingsLayout';

const INSTRUCTION_MODES: readonly PrInstructionMode[] = ['append', 'replace'];

const BRANCH_NAME_PREFIX_MODES: readonly BranchNamePrefixMode[] = [
  'github',
  'custom',
  'none',
];

function isBranchNamePrefixMode(value: string): value is BranchNamePrefixMode {
  return BRANCH_NAME_PREFIX_MODES.some((mode) => mode === value);
}

const INSTRUCTION_MODE_LABELS: Record<PrInstructionMode, string> = {
  append: 'Append',
  replace: 'Replace',
};

/**
 * Append/Replace choice for a generator's custom instructions. The
 * explanation follows the selected mode.
 */
function InstructionModeRow({
  mode,
  onChange,
}: {
  readonly mode: PrInstructionMode;
  readonly onChange: (mode: PrInstructionMode) => void;
}): JSX.Element {
  return (
    <SettingsRow
      label="Instruction mode"
      description={
        mode === 'append'
          ? 'Your instructions are added after the default instructions.'
          : 'Your instructions replace the default instructions entirely.'
      }
      control={
        <SettingsSegmentedControl
          label="Instruction mode"
          value={mode}
          onChange={onChange}
          options={INSTRUCTION_MODES.map((option) => ({
            value: option,
            label: INSTRUCTION_MODE_LABELS[option],
          }))}
        />
      }
    />
  );
}

const QUEUE_REMOVED_HOOK_LABEL = getHookTriggerDisplayName('pr:queue:removed');

const MERGE_QUEUE_AGENT_HANDLING_OPTIONS: readonly SettingsRadioOption<MergeQueueAgentHandling>[] =
  [
    {
      value: 'always',
      label: 'Always',
      description:
        'Merge starts an agent chat that oversees the merge right away.',
      dataTestId: 'settings-git-merge-queue-agent-always',
    },
    {
      value: 'when_hook_absent',
      label: 'When project hook is absent',
      description: `Merge starts an agent chat unless the project has a "${QUEUE_REMOVED_HOOK_LABEL}" hook that isn't paused in the worktree.`,
      dataTestId: 'settings-git-merge-queue-agent-when-hook-absent',
    },
    {
      value: 'never',
      label: 'Never',
      description: 'Merge adds the pull request to the merge queue.',
      dataTestId: 'settings-git-merge-queue-agent-never',
    },
  ];

/**
 * Merge queue settings: whether Merge on a pull request whose base branch
 * uses a merge queue hands the merge to an agent chat. The tip points to the
 * project hook and skill that let agents handle evictions instead.
 */
export function MergeQueueSettingsSection({
  handling,
  onChange,
}: {
  readonly handling: MergeQueueAgentHandling;
  readonly onChange: (handling: MergeQueueAgentHandling) => void;
}): JSX.Element {
  return (
    <SettingsSection
      title="Merge queue"
      description="Applies when a pull request's base branch uses a GitHub merge queue."
      dataTestId="settings-git-merge-queue"
    >
      <SettingsGroup>
        <SettingsRow
          label="Agent merge queue eviction handling"
          description="When Merge starts an agent chat that adds the pull request to the merge queue, watches it, and resolves removals from the queue."
        >
          <SettingsRadioGroup
            name="settings-git-merge-queue-agent-handling"
            label="Agent merge queue eviction handling"
            value={handling}
            options={MERGE_QUEUE_AGENT_HANDLING_OPTIONS}
            onChange={onChange}
            dataTestId="settings-git-merge-queue-agent-handling"
          />
          <Notice
            intent="neutral"
            role="none"
            title="Tip"
            data-testid="settings-git-merge-queue-tip"
          >
            Set up a "{QUEUE_REMOVED_HOOK_LABEL}" hook in your project so agents
            handle evictions. Have it use the built-in <code>merge-pr</code>{' '}
            skill from the <code>builtin-gh</code> plugin to handle the merge
            process.
          </Notice>
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}

function getSelectedThinkingLevel(
  value: string,
  fallback: ThinkingLevel,
): ThinkingLevel {
  return normalizePersistedThinkingLevel(value, fallback);
}

function formatGitExecutableVersion(version: string | null): string {
  if (!version) {
    return 'Git detected';
  }
  const normalizedVersion = version.replace(/^git version\s+/i, '').trim();
  return normalizedVersion ? `Git ${normalizedVersion}` : 'Git detected';
}

/**
 * The branch-prefix dropdown. Its GitHub option names the user's login, which
 * shows on the trigger when chosen and in the menu, so session replay blocks
 * the dropdown and its menu while a login is known; it stays recorded
 * otherwise.
 */
export function BranchNamePrefixSelect({
  id,
  username,
  value,
  onValueChange,
}: {
  id?: string;
  username: string | null;
  value: BranchNamePrefixMode;
  onValueChange: (value: string) => void;
}): JSX.Element {
  return (
    <SettingsSelect
      id={id}
      options={[
        {
          value: 'github',
          label: username ? `GitHub username (${username})` : 'GitHub username',
        },
        { value: 'custom', label: 'Custom' },
        { value: 'none', label: 'None' },
      ]}
      value={value}
      onValueChange={onValueChange}
      replayPrivacy={
        username ? { blockClassName: POSTHOG_REPLAY_BLOCK_CLASS } : undefined
      }
    />
  );
}

/**
 * Desktop Git executable management. Shows the cached/detected path and
 * version and exposes Redetect and Browse. Validation happens in the main
 * process; this UI only reflects the returned {@link GitExecutableStatus}. The
 * section uses the same backend status and recheck as startup.
 *
 * This is a validated executable path picker, not a generic PATH editor.
 */
export function WindowsGitExecutableSection(): JSX.Element {
  const supported =
    window.platform === 'win32' ||
    window.platform === 'darwin' ||
    window.platform === 'linux';
  const executableName =
    window.platform === 'win32' ? 'git.exe' : 'Git executable';
  const [status, setStatus] = useState<GitExecutableStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<InlineFailure | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported) return undefined;
    let cancelled = false;
    void window.api
      .getGitExecutableStatus()
      .then((next: GitExecutableStatus) => {
        if (!cancelled) setStatus(next);
      })
      .catch((error: unknown) => {
        // Non-fatal — the section renders the "not detected" state.
        reportClientAppError(error);
      });
    return (): void => {
      cancelled = true;
    };
  }, [supported]);

  async function redetect(): Promise<void> {
    setBusy(true);
    setMessage(null);
    setFailure(null);
    try {
      const next = await window.api.redetectGitExecutable();
      setStatus(next);
      setMessage(
        next.ready && next.path
          ? `Git was detected at ${next.path}.`
          : 'No valid Git installation was detected.',
      );
    } catch (error: unknown) {
      const appError = toAppError(resolveClientAppError(error));
      if (appError)
        setFailure(inlineFailure(appError, "Couldn't check for Git."));
    } finally {
      setBusy(false);
    }
  }

  async function browse(): Promise<void> {
    setBusy(true);
    setMessage(null);
    setFailure(null);
    try {
      const next = await window.api.browseGitExecutable();
      setStatus(next);
      if (next.ready && next.path) {
        setMessage(`Git was detected at ${next.path}.`);
      } else {
        setMessage(
          next.error
            ? `Select a valid ${executableName} file. ${next.error}`
            : `Select a valid ${executableName} file.`,
        );
      }
    } catch (error: unknown) {
      const appError = toAppError(resolveClientAppError(error));
      if (appError)
        setFailure(
          inlineFailure(
            appError,
            `Couldn't use the selected ${executableName}.`,
          ),
        );
    } finally {
      setBusy(false);
    }
  }

  if (!supported) return <></>;

  const currentPath = status?.path ?? null;
  let statusLine: string | null = null;
  let statusIsError = false;
  if (status) {
    if (status.ready) {
      statusLine = formatGitExecutableVersion(status.version);
    } else if (status.error) {
      statusLine = status.error;
      statusIsError = true;
    }
  }

  return (
    <SettingsSection
      title="Git executable"
      dataTestId="settings-git-executable-section"
    >
      <SettingsGroup>
        <SettingsRow
          label="Location"
          description={
            <span
              className="break-all font-mono"
              data-testid="settings-git-executable-path"
            >
              {currentPath ?? 'No Git executable detected'}
            </span>
          }
          control={
            <>
              <Button
                size="compact"
                variant="secondary"
                onClick={() => void redetect()}
                disabled={busy}
                data-testid="settings-git-executable-redetect"
              >
                Redetect
              </Button>
              <Button
                size="compact"
                variant="secondary"
                onClick={() => void browse()}
                disabled={busy}
                data-testid="settings-git-executable-browse"
              >
                Browse
              </Button>
            </>
          }
        >
          {statusLine || message ? (
            <Stack gap="tight">
              {statusLine && (
                <p
                  className={`text-xs ${statusIsError ? 'fg-warning' : 'fg-secondary'}`}
                  data-testid="settings-git-executable-status"
                >
                  {statusLine}
                </p>
              )}
              {message && (
                <p
                  className="text-xs fg-secondary"
                  data-testid="settings-git-executable-message"
                >
                  {message}
                </p>
              )}
            </Stack>
          ) : null}
          <DesktopErrorBanner
            errorSource="settings-git-executable-error"
            className=""
            error={failure?.error}
            {...(failure?.details === undefined
              ? {}
              : { details: failure.details })}
            blockMessageFromReplay
            testId="settings-git-executable-error"
          />
        </SettingsRow>
        {window.platform === 'linux' && status && !status.ready && (
          <SettingsRow
            label="Install Git"
            description="Install Git in your terminal, then check again."
          >
            <LinuxGitInstallInstructions
              brandName={brandText.appName}
              recheckLabel="Redetect"
              onOpenInstructions={(): void => {
                void window.api.browser.openExternal({
                  url: GIT_LINUX_INSTALL_URL,
                });
              }}
            />
          </SettingsRow>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}

export function GitTab(): JSX.Element {
  const [prefs, setPrefs] = useState<PreferencesData | null>(null);
  const [loadError, setLoadError] = useState<InlineFailure | null>(null);
  const [saveError, setSaveError] = useState<InlineFailure | null>(null);
  const ghStatus = useGitHubCliStatus();

  useEffect(() => {
    void window.api
      .loadPreferences({ view: 'persisted' })
      .then((p: PreferencesData) => {
        const withDefaults: PreferencesData = {
          ...p,
          branchNamePrefixMode: p.branchNamePrefixMode ?? 'github',
          branchNameCustomPrefix: p.branchNameCustomPrefix ?? '',
          branchNamingModel: p.branchNamingModel ?? 'haiku',
          branchNamingThinkingLevel: p.branchNamingThinkingLevel ?? 'off',
          branchNamingInstructions: p.branchNamingInstructions ?? '',
          branchDisplayMappings: mergeMappingsWithBuiltins(
            p.branchDisplayMappings ?? [],
          ),
          deleteBranchOnArchive: p.deleteBranchOnArchive ?? true,
          groupChildBranchesWithBase: p.groupChildBranchesWithBase ?? true,
          voiceDictationEnabled:
            p.voiceDictationEnabled ?? DEFAULT_VOICE_DICTATION_ENABLED,
          worktreeSummaryEnabled: p.worktreeSummaryEnabled ?? true,
          worktreeSummaryModel: p.worktreeSummaryModel ?? 'haiku',
          worktreeSummaryThinkingLevel: p.worktreeSummaryThinkingLevel ?? 'off',
          scriptTimeoutMinutes: p.scriptTimeoutMinutes ?? 5,
          mergeQueueAgentHandling: isMergeQueueAgentHandling(
            p.mergeQueueAgentHandling,
          )
            ? p.mergeQueueAgentHandling
            : DEFAULT_MERGE_QUEUE_AGENT_HANDLING,
          providerModelConfigDefaults: p.providerModelConfigDefaults ?? {
            codex: { fastMode: p.codexFastModeDefaultEnabled ?? false },
          },
          codexFastModeDefaultEnabled: p.codexFastModeDefaultEnabled ?? false,
          codexMultiAgentWorktreeChatsEnabled:
            p.codexMultiAgentWorktreeChatsEnabled ?? true,
          codexMultiAgentStandaloneChatsEnabled:
            p.codexMultiAgentStandaloneChatsEnabled ?? true,
          codexMultiAgentPipelinesEnabled:
            p.codexMultiAgentPipelinesEnabled ?? true,
          preventClaudeNativeCaffeinate:
            p.preventClaudeNativeCaffeinate ?? true,
          branchNamingPluginSelections: p.branchNamingPluginSelections,
          commitGenerationPluginSelections: p.commitGenerationPluginSelections,
          prGenerationPluginSelections: p.prGenerationPluginSelections,
          worktreeSummaryPluginSelections: p.worktreeSummaryPluginSelections,
        };
        setPrefs(withDefaults);
      })
      .catch((error: unknown) => {
        setPrefs(createGitTabFailedLoadPreferences());
        const appError = toAppError(resolveClientAppError(error));
        if (appError)
          setLoadError(
            inlineFailure(
              appError,
              "Couldn't load Git settings. Defaults are shown.",
            ),
          );
      });
  }, []);

  function save(patch: Partial<PreferencesData>): void {
    if (!prefs) return;
    const next = { ...prefs, ...patch };
    setPrefs(next);
    setSaveError(null);
    void window.api
      .savePreferences(patch)
      .then((normalized: PreferencesData) => {
        // Broadcast so same-renderer subscribers (e.g. the Split PR gating
        // snapshot used by worktree rows and the PR panel) update live.
        emitPreferencesUpdated(normalized);
      })
      .catch((error: unknown) => {
        // A save can fail if userData is unavailable.
        const appError = toAppError(resolveClientAppError(error));
        if (appError)
          setSaveError(inlineFailure(appError, "Couldn't save Git settings."));
      });
  }

  function handlePrefixModeChange(mode: BranchNamePrefixMode): void {
    save({ branchNamePrefixMode: mode });
  }

  if (!prefs) {
    // Preferences load in a moment; keep the title in place without flashing
    // a loading line.
    return <SettingsPage title="Git" />;
  }

  const ghUsername = ghStatus?.username ?? null;
  const worktreeDefault = resolveOverallDefault(
    prefs.defaultWorktreeModelByProvider,
    prefs.defaultWorktreeProvider,
  );
  const rebaseResolutionModel =
    prefs.agentRebaseResolutionModel ?? worktreeDefault.model;
  // Settings hydration must tolerate a removed persisted model. This provider
  // is display-only until the user selects a current registry-backed option.
  const rebaseResolutionProvider =
    getProviderForModel(rebaseResolutionModel) ?? 'claude';
  // Custom Agent models (`agent_model_*`) are intentionally excluded: the
  // automated rebase-resolution path runs the model directly against a
  // provider and does not resolve Agent presets (instructions + plugins).
  // Only real base models are offered here; Agents appear only in the chat
  // ModelPicker.
  const rebaseResolutionModelOptions: SettingsSelectItem[] = [
    { value: '', label: 'Project default' },
    {
      label: 'Claude',
      options: CLAUDE_MODELS.map((m) => ({
        value: m,
        label: getModelDisplayName(m),
      })),
    },
    {
      label: 'Codex',
      options: CODEX_MODELS.map((m) => ({
        value: m,
        label: getModelDisplayName(m),
      })),
    },
  ];
  if (OLLAMA_MODELS.length > 0) {
    rebaseResolutionModelOptions.push({
      label: 'Ollama',
      options: OLLAMA_MODELS.map((m) => ({
        value: m,
        label: getModelDisplayName(m),
      })),
    });
  }

  return (
    <SettingsPage title="Git" dataTestId="settings-tab-git">
      <DesktopErrorBanner
        errorSource="settings-git-load-error"
        className=""
        error={loadError?.error}
        {...(loadError?.details === undefined
          ? {}
          : { details: loadError.details })}
        testId="settings-git-load-error"
      />
      <DesktopErrorBanner
        errorSource="settings-git-save-error"
        className=""
        error={saveError?.error}
        {...(saveError?.details === undefined
          ? {}
          : { details: saveError.details })}
        testId="settings-git-save-error"
      />
      {/* Windows/macOS Git executable management (hidden elsewhere) */}
      <WindowsGitExecutableSection />

      <SettingsSection title="Branch naming">
        <SettingsGroup>
          <SettingsRow
            label="Branch name prefix"
            htmlFor="settings-git-branch-prefix-mode"
            description="Prefix for new project branch names."
            control={
              <BranchNamePrefixSelect
                id="settings-git-branch-prefix-mode"
                username={ghUsername}
                value={prefs.branchNamePrefixMode}
                onValueChange={(next): void => {
                  if (isBranchNamePrefixMode(next)) {
                    handlePrefixModeChange(next);
                  }
                }}
              />
            }
          >
            {prefs.branchNamePrefixMode === 'custom' && (
              <SettingsSubRow
                label="Custom prefix"
                htmlFor="settings-git-branch-custom-prefix"
                control={
                  <SettingsTextField
                    id="settings-git-branch-custom-prefix"
                    type="text"
                    width="md"
                    value={prefs.branchNameCustomPrefix}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      save({ branchNameCustomPrefix: e.target.value })
                    }
                    placeholder="my-prefix"
                  />
                }
              />
            )}
          </SettingsRow>

          <ModelThinkingPreferenceRow
            title="Branch naming model"
            description="Generates branch names."
            model={prefs.branchNamingModel}
            thinkingLevel={prefs.branchNamingThinkingLevel}
            defaultThinkingLevel="off"
            onModelChange={(model, thinkingLevel) =>
              save({
                branchNamingModel: model,
                branchNamingThinkingLevel: thinkingLevel,
              })
            }
            onThinkingChange={(thinkingLevel) =>
              save({ branchNamingThinkingLevel: thinkingLevel })
            }
            testIdPrefix="settings-git-branch-naming"
          />

          <SettingsRow
            label="Branch naming instructions"
            htmlFor="branch-naming-instructions"
          >
            <SettingsTextArea
              id="branch-naming-instructions"
              value={prefs.branchNamingInstructions}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                save({ branchNamingInstructions: e.target.value })
              }
              placeholder="Follow the repo's naming style and keep names short…"
              rows={3}
            />
          </SettingsRow>

          <SettingsPluginPicker
            label="Branch naming plugins"
            description={`Loaded when ${brandText.appName} generates branch names.`}
            selections={prefs.branchNamingPluginSelections}
            onChange={(selections) =>
              save({ branchNamingPluginSelections: selections })
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <BranchDisplayMappings
        mappings={prefs.branchDisplayMappings}
        onSave={(mappings) => {
          save({ branchDisplayMappings: mappings });
          useBranchDisplayStore.getState().setMappings(mappings);
        }}
      />

      <SettingsSection title="Worktrees">
        <SettingsGroup>
          <SettingsRow
            label="Delete fully merged branches on archive"
            htmlFor="settings-git-delete-branch-on-archive"
            description={
              <>
                Archiving deletes the local branch when it is fully merged.
                Unmerged branches ask first. To delete the remote branch,{' '}
                <a
                  href="https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline transition-colors hover:fg-primary"
                >
                  configure it on GitHub
                </a>
                .
              </>
            }
            control={
              <ToggleSwitch
                id="settings-git-delete-branch-on-archive"
                checked={prefs.deleteBranchOnArchive}
                label="Delete fully merged branches on archive"
                onChange={() =>
                  save({ deleteBranchOnArchive: !prefs.deleteBranchOnArchive })
                }
              />
            }
          />

          <SettingsRow
            label="Stack child branches"
            htmlFor="settings-git-group-child-branches-switch"
            dataTestId="settings-git-group-child-branches"
            description="Nest a worktree under the worktree its branch came from. Change it per worktree from the right-click menu."
            control={
              <ToggleSwitch
                id="settings-git-group-child-branches-switch"
                checked={prefs.groupChildBranchesWithBase}
                label="Stack child branches"
                dataTestId="settings-git-group-child-branches-toggle"
                onChange={(next) => {
                  save({ groupChildBranchesWithBase: next });
                  useBranchGroupingPreferenceStore.getState().setEnabled(next);
                }}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Pull requests"
        description="How AI writes pull request titles and descriptions."
      >
        <SettingsGroup>
          <ModelThinkingPreferenceRow
            title="PR generation model"
            description="Generates PR titles and descriptions."
            model={prefs.prGenerationModel}
            thinkingLevel={prefs.prGenerationThinkingLevel}
            defaultThinkingLevel="high"
            onModelChange={(model, thinkingLevel) =>
              save({
                prGenerationModel: model,
                prGenerationThinkingLevel: thinkingLevel,
              })
            }
            onThinkingChange={(thinkingLevel) =>
              save({ prGenerationThinkingLevel: thinkingLevel })
            }
          />

          <SettingsRow label="PR instructions" htmlFor="pr-instructions">
            <SettingsTextArea
              id="pr-instructions"
              value={prefs.prInstructions}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                save({ prInstructions: e.target.value })
              }
              placeholder="Respect project's github PR template…"
              rows={4}
            />
          </SettingsRow>

          <InstructionModeRow
            mode={prefs.prInstructionMode}
            onChange={(mode) => save({ prInstructionMode: mode })}
          />

          <SettingsPluginPicker
            label="PR generation plugins"
            description={`Loaded when ${brandText.appName} generates pull request titles and descriptions.`}
            selections={prefs.prGenerationPluginSelections}
            onChange={(selections) =>
              save({ prGenerationPluginSelections: selections })
            }
          />

          <SettingsRow
            label="Split PR"
            htmlFor="settings-git-split-pr"
            description="Offer to split large pull requests into smaller, stacked child PRs."
            control={
              <ToggleSwitch
                id="settings-git-split-pr"
                checked={prefs.splitPrEnabled}
                label="Split PR"
                dataTestId="split-pr-enabled-toggle"
                onChange={(next) => save({ splitPrEnabled: next })}
              />
            }
          />

          <SettingsRow
            label="Split PR threshold"
            htmlFor="settings-git-split-pr-threshold"
            description="Changed lines before the Split PR option appears."
            control={
              <SettingsTextField
                id="settings-git-split-pr-threshold"
                type="number"
                width="xs"
                min={50}
                max={100000}
                value={prefs.splitPrThresholdLines}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const raw = parseInt(e.target.value, 10);
                  if (!Number.isFinite(raw)) return;
                  const clamped = Math.min(100000, Math.max(50, raw));
                  save({ splitPrThresholdLines: clamped });
                }}
                data-testid="split-pr-threshold-input"
              />
            }
          />

          <ModelThinkingPreferenceRow
            title="Split PR planner model"
            description="Plans how a large PR is split."
            model={prefs.splitPrPlannerModel}
            thinkingLevel={prefs.splitPrPlannerThinkingLevel}
            defaultThinkingLevel="high"
            testIdPrefix="settings-git-split-pr-planner"
            onModelChange={(model, thinkingLevel) =>
              save({
                splitPrPlannerModel: model,
                splitPrPlannerThinkingLevel: thinkingLevel,
              })
            }
            onThinkingChange={(thinkingLevel) =>
              save({ splitPrPlannerThinkingLevel: thinkingLevel })
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <MergeQueueSettingsSection
        handling={prefs.mergeQueueAgentHandling}
        onChange={(handling) => save({ mergeQueueAgentHandling: handling })}
      />

      <SettingsSection
        title="Commits"
        description="How AI writes commit messages."
      >
        <SettingsGroup>
          <ModelThinkingPreferenceRow
            title="Commit generation model"
            description="Generates commit messages."
            model={prefs.commitGenerationModel}
            thinkingLevel={prefs.commitGenerationThinkingLevel}
            defaultThinkingLevel="high"
            onModelChange={(model, thinkingLevel) =>
              save({
                commitGenerationModel: model,
                commitGenerationThinkingLevel: thinkingLevel,
              })
            }
            onThinkingChange={(thinkingLevel) =>
              save({ commitGenerationThinkingLevel: thinkingLevel })
            }
          />

          <SettingsRow
            label="Commit instructions"
            htmlFor="commit-instructions"
          >
            <SettingsTextArea
              id="commit-instructions"
              value={prefs.commitInstructions}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                save({ commitInstructions: e.target.value })
              }
              placeholder="Write concise conventional-commit messages…"
              rows={4}
            />
          </SettingsRow>

          <InstructionModeRow
            mode={prefs.commitInstructionMode}
            onChange={(mode) => save({ commitInstructionMode: mode })}
          />

          <SettingsPluginPicker
            label="Commit message plugins"
            description={`Loaded when ${brandText.appName} generates commit messages.`}
            selections={prefs.commitGenerationPluginSelections}
            onChange={(selections) =>
              save({ commitGenerationPluginSelections: selections })
            }
          />

          <SettingsRow
            label="Review commit message"
            htmlFor="settings-git-review-commit-message"
            description="Review and edit the generated message before committing."
            control={
              <ToggleSwitch
                id="settings-git-review-commit-message"
                checked={prefs.reviewCommitMessage}
                label="Review commit message"
                onChange={(next) => save({ reviewCommitMessage: next })}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Conflict resolution">
        <SettingsGroup>
          <SettingsRow
            label="Agent rebase and auto stash resolution"
            htmlFor="settings-git-agent-rebase"
            description={
              'When a rebase or autostash conflict interrupts "Pull, Commit & Push", an agent resolves it in a project chat and finishes the commit and push. When off, you get an error toast and resolve it yourself.'
            }
            control={
              <ToggleSwitch
                id="settings-git-agent-rebase"
                checked={prefs.agentRebaseResolutionEnabled}
                label="Agent rebase and auto stash resolution"
                dataTestId="settings-git-agent-rebase-toggle"
                onChange={(next) =>
                  save({ agentRebaseResolutionEnabled: next })
                }
              />
            }
          >
            {prefs.agentRebaseResolutionEnabled && (
              <SettingsSubRow
                label="Resolution model"
                htmlFor="settings-git-agent-rebase-model"
                description={
                  'Model and thinking level for the resolution chat. "Project default" uses the worktree chat defaults.'
                }
                control={
                  <>
                    <SettingsSelect
                      id="settings-git-agent-rebase-model"
                      options={rebaseResolutionModelOptions}
                      value={prefs.agentRebaseResolutionModel ?? ''}
                      onValueChange={(value): void => {
                        const next = value === '' ? null : value;
                        if (next === null) {
                          save({ agentRebaseResolutionModel: null });
                          return;
                        }
                        // The select contains only current provider-registry models.
                        const newProvider = requireProviderForModel(next);
                        const currentThinking =
                          prefs.agentRebaseResolutionThinkingLevel;
                        const clamped =
                          currentThinking === null
                            ? null
                            : clampThinkingLevelForModel(
                                normalizeThinkingForProvider(
                                  currentThinking,
                                  newProvider,
                                ),
                                next,
                                newProvider,
                              );
                        save({
                          agentRebaseResolutionModel: next,
                          agentRebaseResolutionThinkingLevel: clamped,
                        });
                      }}
                      data-testid="settings-git-agent-rebase-model"
                    />
                    <SettingsSelect
                      aria-label="Resolution thinking level"
                      options={[
                        { value: '', label: 'Project default' },
                        ...getThinkingUiOptionsForProvider(
                          rebaseResolutionProvider,
                          rebaseResolutionModel,
                        ),
                      ]}
                      value={
                        prefs.agentRebaseResolutionThinkingLevel === null
                          ? ''
                          : getThinkingUiValueForProvider(
                              prefs.agentRebaseResolutionThinkingLevel,
                              worktreeDefault.thinkingLevel,
                              rebaseResolutionProvider,
                              rebaseResolutionModel,
                            )
                      }
                      onValueChange={(value): void =>
                        save({
                          agentRebaseResolutionThinkingLevel:
                            value === ''
                              ? null
                              : getSelectedThinkingLevel(
                                  value,
                                  prefs.agentRebaseResolutionThinkingLevel ??
                                    worktreeDefault.thinkingLevel,
                                ),
                        })
                      }
                    />
                  </>
                }
              />
            )}
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Scripts">
        <SettingsGroup>
          <SettingsRow
            label="Script timeout"
            htmlFor="settings-git-script-timeout"
            description="Minutes a setup or teardown script can run before it is stopped."
            control={
              <SettingsTextField
                id="settings-git-script-timeout"
                type="number"
                width="xs"
                min={1}
                max={30}
                value={prefs.scriptTimeoutMinutes}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const raw = parseInt(e.target.value, 10);
                  if (!Number.isFinite(raw)) return;
                  const clamped = Math.min(30, Math.max(1, raw));
                  save({ scriptTimeoutMinutes: clamped });
                }}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}
