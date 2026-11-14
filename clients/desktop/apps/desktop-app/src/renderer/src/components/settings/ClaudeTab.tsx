import { toAppError } from '@canopy/protocol/app-errors';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  DEFAULT_CLAUDE_MAX_TURNS,
  CLAUDE_MAX_TURNS_MIN,
  CLAUDE_MAX_TURNS_MAX,
} from '@canopy/desktop-shared/constants/preferences';
import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  DEFAULT_CLAUDE_SESSION_IDLE_TIMEOUT_MINUTES,
  type ChatInterfaceMode,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { brandText } from '@/lib/brand';
import { useChatStore } from '@/stores/chatStore';
import { useClaudeAuthStatus } from '@/hooks/useClaudeAuthStatus';
import {
  emitPreferencesUpdated,
  subscribePreferencesUpdated,
} from '@/lib/preferences-events';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useClaudeTuiChatsEnabled } from '@/lib/claude-tui-chats';
import { hasVisibleClaudeSettingsSections } from '@/lib/claude-settings-availability';
import { Tooltip } from '@canopy/ui-shared';
import {
  Button,
  ChoiceList,
  ChoiceListRow,
  ErrorState,
  ToggleSwitch,
  FieldError,
} from '@canopy/ui-shared/components';
import {
  SettingsGroup,
  SettingsPage,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
  SettingsSubRow,
  SettingsTextField,
} from './SettingsLayout';
import { IdleTimeoutMinutesRow } from './IdleTimeoutMinutesRow';
import { ClaudeModsKillSwitch } from '@canopy/ui-app/capability';

interface InterfaceModeOption {
  value: ChatInterfaceMode;
  label: string;
  description: string;
}

type InterfaceModePreferenceKey =
  | 'defaultChatInterfaceMode'
  | 'defaultStandaloneChatInterfaceMode'
  | 'defaultAppAdvisorInterfaceMode';

function getInterfaceModeOptions(): InterfaceModeOption[] {
  return [
    {
      value: 'canopy',
      label: brandText.appName,
      description: `Stream turns in the native ${brandText.appName} transcript.`,
    },
    {
      value: 'claude-code',
      label: 'Terminal',
      description: 'Run chats in the managed Claude Code terminal.',
    },
    {
      value: 'auto',
      label: `Auto: ${brandText.appName} viewing, terminal execution`,
      description: `Run each turn in the terminal, then return to the ${brandText.appName} transcript.`,
    },
  ];
}

const INTERFACE_MODE_OPTIONS = getInterfaceModeOptions();

function isChatInterfaceMode(value: string): value is ChatInterfaceMode {
  return value === 'canopy' || value === 'claude-code' || value === 'auto';
}

type WorkerExecutionMode = 'canopy' | 'terminal';

type WorkerModePreferenceKey =
  | 'canopyBackgroundProcessesMode'
  | 'pipelinesMode';

interface WorkerModeOption {
  value: WorkerExecutionMode;
  label: string;
  description: string;
}

function getWorkerModeOptions(): WorkerModeOption[] {
  return [
    {
      value: 'canopy',
      label: brandText.appName,
      description: `Run in-process with the Claude SDK, inside ${brandText.appName}.`,
    },
    {
      value: 'terminal',
      label: 'Terminal',
      description:
        'Run as managed Claude Code sessions, shown on the Claude workers page.',
    },
  ];
}

const WORKER_MODE_OPTIONS = getWorkerModeOptions();

function isWorkerExecutionMode(value: string): value is WorkerExecutionMode {
  return value === 'canopy' || value === 'terminal';
}

const WORKER_CONCURRENCY_MIN = 1;
const WORKER_CONCURRENCY_MAX = 16;

interface ClaudeTabProps {
  onOpenPerformanceSettings?: () => void;
}

export function ClaudeTab({
  onOpenPerformanceSettings,
}: ClaudeTabProps): JSX.Element {
  const [prefs, setPrefs] = useState<PreferencesData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<InlineFailure | null>(null);
  const [turnLimitInput, setTurnLimitInput] = useState(
    String(DEFAULT_CLAUDE_MAX_TURNS),
  );
  const [turnLimitError, setTurnLimitError] = useState<string | null>(null);
  const [savingTurnLimit, setSavingTurnLimit] = useState(false);
  const turnLimitSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingTurnLimitSaves = useRef(0);
  useEffect(() => subscribePreferencesUpdated(setPrefs), []);
  useEffect((): void => {
    setTurnLimitInput(
      String(prefs?.claudeMaxTurns ?? DEFAULT_CLAUDE_MAX_TURNS),
    );
  }, [prefs?.claudeMaxTurns]);

  const loadModelDefaults = useChatStore((state) => state.loadModelDefaults);
  const claudeTuiWorkersEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key),
  );
  const claudeTuiChatsEnabled = useClaudeTuiChatsEnabled();
  const claudeSettingsAvailable = hasVisibleClaudeSettingsSections({
    platform: window.platform,
    claudeTuiChatsEnabled,
    claudeTuiWorkersEnabled,
  });
  const claudeAuthStatus = useClaudeAuthStatus(0, {
    forceRefreshOnMount: true,
  });
  const claudeAuthenticated = claudeAuthStatus?.authenticated === true;
  const terminalAuthRequiredMessage =
    'Sign in to Claude from Account settings before using Terminal mode.';

  const loadPreferences = useCallback((): void => {
    setLoadError(null);
    setSaveError(null);
    void window.api
      .loadPreferences()
      .then((p: PreferencesData) => {
        setPrefs(p);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        reportClientAppError(error);
        setPrefs(null);
        setLoadError("Couldn't load Claude settings.");
      });
  }, []);

  useEffect(() => {
    if (!claudeSettingsAvailable) return;
    loadPreferences();
  }, [claudeSettingsAvailable, loadPreferences]);

  const commitInterfaceMode = useCallback(
    (key: InterfaceModePreferenceKey, next: ChatInterfaceMode): void => {
      if (!prefs || prefs[key] === next) return;
      if (next !== 'canopy' && !claudeAuthenticated) {
        setSaveError({ error: terminalAuthRequiredMessage });
        return;
      }
      const previous = prefs;
      setPrefs({ ...prefs, [key]: next });
      setSaveError(null);
      void window.api
        .savePreferences({ [key]: next })
        .then((normalized: PreferencesData) => {
          setPrefs(normalized);
          emitPreferencesUpdated(normalized);
          useAppAdvisorStore.getState().applyPreferences(normalized);
          void loadModelDefaults().catch((error: unknown) => {
            reportClientAppError(error);
          });
        })
        .catch((error: unknown) => {
          setPrefs(previous);
          const appError = toAppError(resolveClientAppError(error));
          if (appError)
            setSaveError(
              inlineFailure(appError, 'Could not save Claude settings.'),
            );
        });
    },
    [
      claudeAuthenticated,
      loadModelDefaults,
      prefs,
      terminalAuthRequiredMessage,
    ],
  );

  const commitWorkerMode = useCallback(
    (key: WorkerModePreferenceKey, next: WorkerExecutionMode): void => {
      if (!prefs || prefs[key] === next) return;
      if (next === 'terminal' && !claudeAuthenticated) {
        setSaveError({ error: terminalAuthRequiredMessage });
        return;
      }
      const previous = prefs;
      setPrefs({ ...prefs, [key]: next });
      setSaveError(null);
      void window.api
        .savePreferences({ [key]: next })
        .then((normalized: PreferencesData) => {
          setPrefs(normalized);
          emitPreferencesUpdated(normalized);
          useAppAdvisorStore.getState().applyPreferences(normalized);
        })
        .catch((error: unknown) => {
          setPrefs(previous);
          const appError = toAppError(resolveClientAppError(error));
          if (appError)
            setSaveError(
              inlineFailure(appError, 'Could not save Claude settings.'),
            );
        });
    },
    [claudeAuthenticated, prefs, terminalAuthRequiredMessage],
  );

  const commitBooleanPreference = useCallback(
    (key: keyof Pick<PreferencesData, 'preventClaudeNativeCaffeinate'>) =>
      (next: boolean): void => {
        if (!prefs || prefs[key] === next) return;
        const previous = prefs;
        setPrefs({ ...prefs, [key]: next });
        setSaveError(null);
        void window.api
          .savePreferences({ [key]: next })
          .then((normalized: PreferencesData) => {
            setPrefs(normalized);
            emitPreferencesUpdated(normalized);
            useAppAdvisorStore.getState().applyPreferences(normalized);
          })
          .catch((error: unknown) => {
            setPrefs(previous);
            const appError = toAppError(resolveClientAppError(error));
            if (appError)
              setSaveError(
                inlineFailure(appError, 'Could not save Claude settings.'),
              );
          });
      },
    [prefs],
  );

  const commitWorkerConcurrency = useCallback(
    (rawValue: number): void => {
      if (!prefs || !Number.isFinite(rawValue)) return;
      // Mirror the backend clamp (1–16) so the optimistic value never displays
      // out of range before the normalized value comes back.
      const next = Math.min(
        WORKER_CONCURRENCY_MAX,
        Math.max(WORKER_CONCURRENCY_MIN, Math.round(rawValue)),
      );
      if (prefs.workerConcurrencyLimit === next) return;
      const previous = prefs;
      setPrefs({ ...prefs, workerConcurrencyLimit: next });
      setSaveError(null);
      void window.api
        .savePreferences({ workerConcurrencyLimit: next })
        .then((normalized: PreferencesData) => {
          setPrefs(normalized);
          emitPreferencesUpdated(normalized);
          useAppAdvisorStore.getState().applyPreferences(normalized);
        })
        .catch((error: unknown) => {
          setPrefs(previous);
          const appError = toAppError(resolveClientAppError(error));
          if (appError)
            setSaveError(
              inlineFailure(appError, 'Could not save Claude settings.'),
            );
        });
    },
    [prefs],
  );

  const commitIdleTimeout = useCallback(
    (next: number): void => {
      if (!prefs || prefs.claudeSessionIdleTimeoutMinutes === next) return;
      const previous = prefs;
      setPrefs({ ...prefs, claudeSessionIdleTimeoutMinutes: next });
      setSaveError(null);
      void window.api
        .savePreferences({ claudeSessionIdleTimeoutMinutes: next })
        .then((normalized: PreferencesData) => {
          setPrefs(normalized);
          emitPreferencesUpdated(normalized);
          useAppAdvisorStore.getState().applyPreferences(normalized);
        })
        .catch((error: unknown) => {
          setPrefs(previous);
          const appError = toAppError(resolveClientAppError(error));
          if (appError)
            setSaveError(
              inlineFailure(appError, 'Could not save Claude settings.'),
            );
        });
    },
    [prefs],
  );

  const commitTurnLimit = useCallback(
    (next: number | null): void => {
      if (!prefs) return;
      setTurnLimitError(null);
      if (pendingTurnLimitSaves.current === 0 && prefs.claudeMaxTurns === next)
        return;
      pendingTurnLimitSaves.current += 1;
      setSavingTurnLimit(true);
      setSaveError(null);
      // A switch click can follow the number field's blur save. Serialize
      // both writes so the requested switch state is persisted last.
      turnLimitSaveQueue.current = turnLimitSaveQueue.current
        .then(async (): Promise<void> => {
          const normalized = await window.api.savePreferences({
            claudeMaxTurns: next,
          });
          setSaveError(null);
          setPrefs(normalized);
          setTurnLimitInput(
            String(normalized.claudeMaxTurns ?? DEFAULT_CLAUDE_MAX_TURNS),
          );
          emitPreferencesUpdated(normalized);
          useAppAdvisorStore.getState().applyPreferences(normalized);
        })
        .catch((error: unknown): void => {
          const appError = toAppError(resolveClientAppError(error));
          if (appError)
            setSaveError(
              inlineFailure(appError, 'Could not save Claude settings.'),
            );
        })
        .finally((): void => {
          pendingTurnLimitSaves.current -= 1;
          if (pendingTurnLimitSaves.current === 0) setSavingTurnLimit(false);
        });
    },
    [prefs],
  );

  const saveTurnLimitInput = (): void => {
    const next = Number(turnLimitInput);
    if (
      turnLimitInput.trim().length === 0 ||
      !Number.isInteger(next) ||
      next < CLAUDE_MAX_TURNS_MIN ||
      next > CLAUDE_MAX_TURNS_MAX
    ) {
      setTurnLimitError('Enter a whole number from 1 to 9,999.');
      return;
    }
    commitTurnLimit(next);
  };

  if (!claudeSettingsAvailable) {
    return <></>;
  }

  if (loadError) {
    return (
      <SettingsPage title="Claude" dataTestId="settings-tab-claude">
        <ErrorState
          message={loadError}
          onRetry={loadPreferences}
          testId="settings-claude-load-error"
        />
      </SettingsPage>
    );
  }

  if (!prefs) {
    return (
      <SettingsPage title="Claude">
        <SettingsLoading />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title="Claude" dataTestId="settings-tab-claude">
      <DesktopErrorBanner
        errorSource="settings-claude-save-error"
        className=""
        error={saveError?.error}
        {...(saveError?.details === undefined
          ? {}
          : { details: saveError.details })}
        testId="settings-claude-save-error"
      />

      <SettingsSection
        title="Chat turns"
        description="A chat can take several turns to answer one message, including turns between tool calls. Changes apply to new Claude chat sessions."
      >
        <SettingsGroup>
          <SettingsRow
            label="Limit chat turns"
            htmlFor="settings-claude-limit-turns"
            description={
              prefs.claudeMaxTurns === null
                ? 'No limit. Claude can keep working until it finishes or you stop it.'
                : 'Pause Claude at the limit and offer Resume to continue.'
            }
            control={
              <ToggleSwitch
                id="settings-claude-limit-turns"
                checked={prefs.claudeMaxTurns !== null}
                label="Limit chat turns"
                onChange={(enabled): void =>
                  commitTurnLimit(enabled ? DEFAULT_CLAUDE_MAX_TURNS : null)
                }
                dataTestId="settings-claude-limit-turns"
              />
            }
          >
            {prefs.claudeMaxTurns !== null && (
              <SettingsSubRow
                label="Maximum turns"
                htmlFor="settings-claude-max-turns"
                description="1–9,999. The default is 500."
                control={
                  <SettingsTextField
                    id="settings-claude-max-turns"
                    type="number"
                    width="xs"
                    min={CLAUDE_MAX_TURNS_MIN}
                    max={CLAUDE_MAX_TURNS_MAX}
                    step={1}
                    value={turnLimitInput}
                    disabled={savingTurnLimit}
                    aria-invalid={turnLimitError !== null}
                    aria-describedby={
                      turnLimitError
                        ? 'settings-claude-max-turns-error'
                        : undefined
                    }
                    onChange={(event): void => {
                      setTurnLimitInput(event.target.value);
                      setTurnLimitError(null);
                    }}
                    onBlur={saveTurnLimitInput}
                    onKeyDown={(event): void => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                    data-testid="settings-claude-max-turns"
                  />
                }
              >
                {turnLimitError && (
                  <FieldError
                    id="settings-claude-max-turns-error"
                    announce
                    data-testid="settings-claude-max-turns-error"
                  >
                    {turnLimitError}
                  </FieldError>
                )}
              </SettingsSubRow>
            )}
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Idle chats">
        <SettingsGroup>
          <IdleTimeoutMinutesRow
            id="settings-claude-idle-timeout-minutes"
            description="Stop the Claude process of an idle chat after this long. Applies to Claude chats and to Ollama chats that run on Claude. Your next message resumes the chat. Chats that run on Codex use the Codex setting."
            minutes={
              Number.isFinite(prefs.claudeSessionIdleTimeoutMinutes)
                ? prefs.claudeSessionIdleTimeoutMinutes
                : DEFAULT_CLAUDE_SESSION_IDLE_TIMEOUT_MINUTES
            }
            onCommit={commitIdleTimeout}
          />
        </SettingsGroup>
      </SettingsSection>

      {window.platform === 'darwin' && (
        <SettingsSection title="Sleep">
          <SettingsGroup>
            <SettingsRow
              dataTestId="settings-claude-native-caffeinate"
              label="Prevent Claude native caffeinate"
              htmlFor="settings-claude-prevent-native-caffeinate"
              description="Stops managed Claude Code terminal and worker sessions from starting their own macOS sleep inhibitor. Improves performance."
              control={
                <ToggleSwitch
                  id="settings-claude-prevent-native-caffeinate"
                  checked={prefs.preventClaudeNativeCaffeinate}
                  label="Prevent Claude native caffeinate"
                  onChange={commitBooleanPreference(
                    'preventClaudeNativeCaffeinate',
                  )}
                  dataTestId="settings-claude-prevent-native-caffeinate"
                />
              }
            />
            <SettingsRow
              label="Sleep prevention"
              description={`To keep your Mac awake while agents run, use the ${brandText.appName} "Keep system awake" setting.`}
              control={
                <Button
                  size="compact"
                  variant="secondary"
                  onClick={(): void => onOpenPerformanceSettings?.()}
                  data-testid="settings-claude-open-performance"
                >
                  Performance settings
                </Button>
              }
            />
          </SettingsGroup>
        </SettingsSection>
      )}

      {claudeTuiChatsEnabled && (
        <SettingsSection
          title="Default chat mode"
          description="Where new Claude-backed chats run."
        >
          <SettingsGroup>
            <InterfaceModeRow
              label="Worktree chats"
              description="Includes chats switched from Codex before the first message and chat-based hooks on Claude models."
              name="settings-claude-default-chat-mode"
              testIdPrefix="settings-claude-default-chat-mode"
              selected={prefs.defaultChatInterfaceMode}
              terminalModesDisabled={!claudeAuthenticated}
              terminalDisabledReason={terminalAuthRequiredMessage}
              onChange={(next): void =>
                commitInterfaceMode('defaultChatInterfaceMode', next)
              }
            />

            <InterfaceModeRow
              label="Standalone chats"
              description="Includes standalone chats switched from Codex before the first message."
              name="settings-claude-default-standalone-chat-mode"
              testIdPrefix="settings-claude-default-standalone-chat-mode"
              selected={prefs.defaultStandaloneChatInterfaceMode}
              terminalModesDisabled={!claudeAuthenticated}
              terminalDisabledReason={terminalAuthRequiredMessage}
              onChange={(next): void =>
                commitInterfaceMode('defaultStandaloneChatInterfaceMode', next)
              }
            />

            <InterfaceModeRow
              label={`${ORCHESTRATOR_LABEL} chats`}
              name="settings-claude-default-app-advisor-chat-mode"
              testIdPrefix="settings-claude-default-app-advisor-chat-mode"
              selected={prefs.defaultAppAdvisorInterfaceMode}
              terminalModesDisabled={!claudeAuthenticated}
              terminalDisabledReason={terminalAuthRequiredMessage}
              onChange={(next): void =>
                commitInterfaceMode('defaultAppAdvisorInterfaceMode', next)
              }
            />
          </SettingsGroup>
        </SettingsSection>
      )}

      {claudeTuiWorkersEnabled && (
        <SettingsSection
          title="Claude workers"
          description="Where background and workflow tasks run."
          dataTestId="settings-claude-workers-section"
        >
          <SettingsGroup>
            <WorkerModeRow
              label={`${brandText.appName} background processes`}
              description="Branch names, commit messages, PR text, and worktree, chat, and archive summaries."
              name="settings-claude-background-processes-mode"
              testIdPrefix="settings-claude-background-processes-mode"
              selected={prefs.canopyBackgroundProcessesMode}
              terminalModeDisabled={!claudeAuthenticated}
              terminalDisabledReason={terminalAuthRequiredMessage}
              onChange={(next): void =>
                commitWorkerMode('canopyBackgroundProcessesMode', next)
              }
            />

            <WorkerModeRow
              label="Workflows"
              description="Agent prompt steps in workflows."
              name="settings-claude-pipelines-mode"
              testIdPrefix="settings-claude-pipelines-mode"
              selected={prefs.pipelinesMode}
              terminalModeDisabled={!claudeAuthenticated}
              terminalDisabledReason={terminalAuthRequiredMessage}
              onChange={(next): void => commitWorkerMode('pipelinesMode', next)}
            />

            <SettingsRow
              label="Max concurrent workers"
              htmlFor="settings-claude-worker-concurrency-input"
              description={
                <>
                  Terminal-mode workers that can run at once (
                  {WORKER_CONCURRENCY_MIN}–{WORKER_CONCURRENCY_MAX}). Others
                  wait for a free slot.
                </>
              }
              control={
                <SettingsTextField
                  id="settings-claude-worker-concurrency-input"
                  type="number"
                  width="xs"
                  min={WORKER_CONCURRENCY_MIN}
                  max={WORKER_CONCURRENCY_MAX}
                  step={1}
                  defaultValue={prefs.workerConcurrencyLimit}
                  key={`worker-concurrency-${prefs.workerConcurrencyLimit}`}
                  onBlur={(e: React.FocusEvent<HTMLInputElement>): void => {
                    const parsed = Number.parseInt(e.target.value, 10);
                    if (Number.isFinite(parsed)) {
                      commitWorkerConcurrency(parsed);
                    }
                  }}
                  onKeyDown={(
                    e: React.KeyboardEvent<HTMLInputElement>,
                  ): void => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    }
                  }}
                  data-testid="settings-claude-worker-concurrency"
                />
              }
            />
          </SettingsGroup>
        </SettingsSection>
      )}
      <ClaudeModsKillSwitch />
    </SettingsPage>
  );
}

interface InterfaceModeRowProps {
  label: string;
  description?: string;
  name: string;
  testIdPrefix: string;
  selected: ChatInterfaceMode;
  terminalModesDisabled?: boolean;
  terminalDisabledReason?: string;
  onChange: (next: ChatInterfaceMode) => void;
}

/** One chat surface's default mode: a row with its three choices under it. */
function InterfaceModeRow({
  label,
  description,
  name,
  testIdPrefix,
  selected,
  terminalModesDisabled = false,
  terminalDisabledReason,
  onChange,
}: InterfaceModeRowProps): JSX.Element {
  return (
    <SettingsRow label={label} description={description}>
      <ModeRadioList label={label}>
        {INTERFACE_MODE_OPTIONS.map((option) => {
          const isDisabled = terminalModesDisabled && option.value !== 'canopy';
          return (
            <ModeRadioOption
              key={option.value}
              name={name}
              value={option.value}
              label={option.label}
              description={option.description}
              checked={selected === option.value}
              disabled={isDisabled}
              disabledReason={terminalDisabledReason}
              dataTestId={`${testIdPrefix}-${option.value}`}
              onSelect={(value): void => {
                if (!isDisabled && isChatInterfaceMode(value)) {
                  onChange(value);
                }
              }}
            />
          );
        })}
      </ModeRadioList>
    </SettingsRow>
  );
}

interface WorkerModeRowProps {
  label: string;
  description: string;
  name: string;
  testIdPrefix: string;
  selected: WorkerExecutionMode;
  terminalModeDisabled?: boolean;
  terminalDisabledReason?: string;
  onChange: (next: WorkerExecutionMode) => void;
}

/** One task family's execution mode: a row with its two choices under it. */
function WorkerModeRow({
  label,
  description,
  name,
  testIdPrefix,
  selected,
  terminalModeDisabled = false,
  terminalDisabledReason,
  onChange,
}: WorkerModeRowProps): JSX.Element {
  return (
    <SettingsRow label={label} description={description}>
      <ModeRadioList label={label}>
        {WORKER_MODE_OPTIONS.map((option) => {
          const isDisabled =
            terminalModeDisabled && option.value === 'terminal';
          return (
            <ModeRadioOption
              key={option.value}
              name={name}
              value={option.value}
              label={option.label}
              description={option.description}
              checked={selected === option.value}
              disabled={isDisabled}
              disabledReason={terminalDisabledReason}
              dataTestId={`${testIdPrefix}-${option.value}`}
              onSelect={(value): void => {
                if (!isDisabled && isWorkerExecutionMode(value)) {
                  onChange(value);
                }
              }}
            />
          );
        })}
      </ModeRadioList>
    </SettingsRow>
  );
}

/**
 * The radio list under a mode row. Same layout as `SettingsRadioGroup`, which
 * cannot say why an option is disabled; these options explain it in a tooltip.
 */
function ModeRadioList({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <ChoiceList kind="radio" aria-label={label}>
      {children}
    </ChoiceList>
  );
}

interface ModeRadioOptionProps {
  name: string;
  value: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  disabledReason?: string;
  dataTestId: string;
  onSelect: (value: string) => void;
}

/** One shared radio with its label and explanation; a disabled choice says why. */
function ModeRadioOption({
  name,
  value,
  label,
  description,
  checked,
  disabled,
  disabledReason,
  dataTestId,
  onSelect,
}: ModeRadioOptionProps): JSX.Element {
  return (
    <Tooltip label={disabledReason} disabled={!disabled} className="w-full">
      <ChoiceListRow
        kind="radio"
        name={name}
        value={value}
        selected={checked}
        disabled={disabled}
        onClick={(): void => onSelect(value)}
        data-testid={dataTestId}
      >
        <span className="block font-medium">{label}</span>
        <span className="block text-xs text-pretty fg-secondary">
          {description}
        </span>
      </ChoiceListRow>
    </Tooltip>
  );
}
