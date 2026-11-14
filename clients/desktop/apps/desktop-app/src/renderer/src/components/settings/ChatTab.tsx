import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { type JSX, useEffect, useState } from 'react';
import type {
  AgentProviderType,
  CanopyApi,
  ModelDefaultsByProvider,
  PreferencesData,
  PreferencesLoadResult,
  ProviderModelSelection,
  ThinkingLevel,
} from '@canopy/desktop-shared/types';
import type { BillingLane } from '@canopy/desktop-shared/lib/default-model-lane';
import {
  AI_GATEWAY_MODELS,
  CLAUDE_MODELS,
  CODEX_MODELS,
  OLLAMA_MODELS,
  THINKING_UI_OPTIONS,
  getExecutionHarnessForModel,
  getThinkingUiValueForProvider,
  hasHydratedGatewayCatalog,
  getModelDisplayName,
  getThinkingUiOptionsForProvider,
  modelSupportsThinkingLevel,
  normalizePersistedThinkingLevel,
  normalizeThinkingForProvider,
  defaultSummaryModel,
} from '@canopy/desktop-shared/types';
import { isGatewayRoutableModel } from '@canopy/execution-engine/lib/gateway-model-availability';
import { isModelBlocked } from '@canopy/desktop-shared/lib/model-policy';
import { getRendererModelPolicy } from '@/stores/modelPolicyRuntime';
import { useProviderAvailability } from '@/hooks/useProviderAvailability';
import { useAiCreditsAvailability } from '@/hooks/useAiCreditsAvailability';
import { isOllamaSupportedOnPlatform } from '@canopy/desktop-shared/platform-capabilities';
import { useChatStore } from '@/stores/chatStore';
import { useActivityStore } from '@/stores/activityStore';
import { brandText } from '@/lib/brand';
import { subscribePreferencesUpdated } from '@/lib/preferences-events';
import { ModelThinkingPreferenceRow } from './ModelThinkingPreferenceRow';
import { SettingsPluginPicker } from './SettingsPluginPicker';
import {
  SettingsSelect,
  ToggleSwitch,
  type SettingsSelectOption,
} from '@canopy/ui-shared/components';
import {
  SettingsGroup,
  SettingsPage,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
  SettingsSubRow,
} from './SettingsLayout';
import { Radio } from '@canopy/ui-shared/components';

function getSelectedThinkingLevel(
  value: string,
  fallback: ThinkingLevel,
): ThinkingLevel {
  return normalizePersistedThinkingLevel(value, fallback);
}

/**
 * The AI Credits lane is a fourth ROW, not a fourth `AgentProviderType`.
 *
 * Widening that union would drag `getProviderForModel`,
 * `providerModelConfigDefaults`, `chatProviderLock` and
 * `normalizeThinkingForProvider` along with it. `ModelDefaultsByProvider`
 * simply carries an extra optional key instead — nothing iterates it with
 * `Object.keys`, so the extra key is inert everywhere else.
 */
type DefaultsRowKey =
  | Exclude<
      AgentProviderType,
      'cursor' | 'copilot' | 'opencode' | 'antigravity'
    >
  | 'aiCredits';

/** The only model whose default rows offer Low (CAN-4646). */
const SOL_LOW_MODEL = 'gpt-6.1-sol';

const PROVIDER_LABELS: Record<DefaultsRowKey, string> = {
  claude: 'Claude',
  codex: 'Codex',
  ollama: 'Ollama',
  aiCredits: 'AI Credits',
};

interface ProviderDefaultsGroupProps {
  title: string;
  description: string;
  byProvider: ModelDefaultsByProvider;
  defaultProvider: AgentProviderType;
  radioName: string;
  resolvedLane?: BillingLane;
  onChange: (next: {
    byProvider: ModelDefaultsByProvider;
    defaultProvider: AgentProviderType;
  }) => void;
}

function ProviderDefaultsGroup({
  title,
  description,
  byProvider,
  defaultProvider,
  radioName,
  resolvedLane,
  onChange,
}: ProviderDefaultsGroupProps): JSX.Element {
  const hasOllamaModels = OLLAMA_MODELS.length > 0;
  const availability = useProviderAvailability();
  // Read the credits fact from its own source rather than through
  // `availability.claude`, whose `loading` is
  // `claudeAuthLoading || claudeProbeFailed || credits.loading` and whose
  // `creditsEligible` is the same value this hook returns. Going through the
  // Claude slot made the AI Credits row report "Checking…" whenever an
  // unrelated Claude auth probe was in flight or had blipped.
  const credits = useAiCreditsAvailability();

  function laneReason(row: DefaultsRowKey): string | undefined {
    if (row === 'ollama') return undefined;
    if (row === 'aiCredits') {
      if (credits.loading) return 'Checking…';
      if (credits.eligible) return 'Available';
      // An inconclusive read is not a balance of zero — saying so would tell a
      // funded user they have no credits because the cloud call failed.
      return credits.inconclusive ? 'Unable to check' : 'No spendable credits';
    }
    const provider = availability[row];
    if (provider.loading) return 'Checking…';
    return provider.nativeAuth ? 'Signed in' : 'Not signed in';
  }

  function laneDimmed(row: DefaultsRowKey): boolean {
    if (row === 'ollama') return false;
    if (row === 'aiCredits') {
      // Dim only on a CONFIRMED negative, never on an unsettled or
      // inconclusive read.
      return !credits.loading && !credits.inconclusive && !credits.eligible;
    }
    return !availability[row].loading && !availability[row].nativeAuth;
  }

  function writeProviderSelection(
    provider: AgentProviderType | 'aiCredits',
    selection: ProviderModelSelection | null,
  ): void {
    const next: ModelDefaultsByProvider = {
      ...byProvider,
      [provider]: selection,
    };
    let nextDefault = defaultProvider;
    if (
      provider === 'ollama' &&
      selection === null &&
      nextDefault === 'ollama'
    ) {
      nextDefault = 'claude';
    }
    onChange({ byProvider: next, defaultProvider: nextDefault });
  }

  function selectDefault(provider: AgentProviderType): void {
    if (provider === 'ollama' && byProvider.ollama === null) return;
    onChange({ byProvider, defaultProvider: provider });
  }

  return (
    <SettingsSection
      title={title}
      description={
        <>
          <p>{description}</p>
          <p data-testid={`chat-defaults-resolved-lane-${radioName}`}>
            {/* HISTORICAL, not live. `lastResolvedDefaultLaneByScope` is written
                only by a non-provisional MAIN-PROCESS resolution; renderer-side
                availability changes (sign-in/out, account change, retry recovery)
                never update it, and this tab does not subscribe to background
                preference writes. Labelling it "Currently resolved" claimed a
                freshness it does not have — after Claude became unavailable and
                credits became available, new chats resolved to AI Credits while
                this line still read "Claude subscription", and on first run it
                sat on "Checking…" indefinitely despite settled availability. */}
            {resolvedLane
              ? `Last resolved: ${
                  resolvedLane === 'claude-native'
                    ? 'Claude subscription'
                    : resolvedLane === 'codex-native'
                      ? 'Codex subscription'
                      : resolvedLane === 'ai-credits'
                        ? 'AI Credits'
                        : 'Ollama'
                }`
              : 'Last resolved: not recorded yet'}
          </p>
        </>
      }
    >
      <SettingsGroup>
        <ProviderRow
          provider="claude"
          radioName={radioName}
          isDefault={defaultProvider === 'claude'}
          dimmed={laneDimmed('claude')}
          reason={laneReason('claude')}
          selection={byProvider.claude}
          onChangeSelection={(sel: ProviderModelSelection | null): void => {
            if (sel) writeProviderSelection('claude', sel);
          }}
          onSelectDefault={(): void => selectDefault('claude')}
        />
        <ProviderRow
          provider="codex"
          radioName={radioName}
          isDefault={defaultProvider === 'codex'}
          dimmed={laneDimmed('codex')}
          reason={laneReason('codex')}
          selection={byProvider.codex}
          onChangeSelection={(sel: ProviderModelSelection | null): void => {
            if (sel) writeProviderSelection('codex', sel);
          }}
          onSelectDefault={(): void => selectDefault('codex')}
        />
        {/* Ollama visibility flows through the shared platform-support
            predicate: the row is hidden entirely on unsupported desktop
            platforms and otherwise behaves as before (disabled when no Ollama
            models are installed). Supported on macOS and Windows. */}
        {isOllamaSupportedOnPlatform() && (
          <ProviderRow
            provider="ollama"
            radioName={radioName}
            isDefault={defaultProvider === 'ollama'}
            selection={byProvider.ollama}
            disabled={!hasOllamaModels}
            onChangeSelection={(sel: ProviderModelSelection | null): void =>
              writeProviderSelection('ollama', sel)
            }
            onSelectDefault={(): void => selectDefault('ollama')}
          />
        )}
        {/* AI Credits lane. Always rendered, never disabled: a user can set
            their credits default up before connecting a cloud account. */}
        <ProviderRow
          provider="aiCredits"
          radioName={radioName}
          isDefault={false}
          dimmed={laneDimmed('aiCredits')}
          reason={laneReason('aiCredits')}
          selection={byProvider.aiCredits ?? null}
          onChangeSelection={(sel: ProviderModelSelection | null): void =>
            writeProviderSelection('aiCredits', sel)
          }
          onSelectDefault={(): void => undefined}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}

interface ProviderRowProps {
  provider: DefaultsRowKey;
  radioName: string;
  isDefault: boolean;
  selection: ProviderModelSelection | null;
  disabled?: boolean;
  /**
   * Dimmed, but still interactive. A user may legitimately preconfigure a lane
   * they have not signed into yet, so an unavailable lane is communicated, not
   * locked — disabling it would make "set this up before I sign in" impossible.
   */
  dimmed?: boolean;
  /** Live one-line explanation of this lane's current availability. */
  reason?: string;
  onChangeSelection: (selection: ProviderModelSelection | null) => void;
  onSelectDefault: () => void;
}

function providerModelOptions(
  provider: DefaultsRowKey,
  /** The model currently persisted for this lane, if any. */
  selectedModel?: string,
): readonly string[] {
  if (provider === 'claude') return CLAUDE_MODELS;
  if (provider === 'codex') return CODEX_MODELS;
  if (provider === 'ollama') return OLLAMA_MODELS;
  // Gateway ROUTABILITY, not harness identity, is the credits-lane contract.
  // Policy-filtered on top of it, so an admin-restricted user cannot persist an
  // org-blocked model as their credits default.
  //
  // The routability half is skipped while the gateway route catalog is COLD:
  // `isGatewayRoutableModel` is false for everything until it hydrates, so on an
  // offline or cold launch this returned an empty list, the select rendered
  // DISABLED with a blank value, and a saved AI Credits default was silently
  // misrepresented as "Automatic" with no way to correct it. A cold catalog
  // cannot say a route is missing — only that it is not known yet.
  const policy = getRendererModelPolicy();
  const routesHydrated = hasHydratedGatewayCatalog();
  const options = AI_GATEWAY_MODELS.filter(
    (model) =>
      (!routesHydrated || isGatewayRoutableModel(model)) &&
      !isModelBlocked(model, policy),
  );
  // A saved default is always representable, even once the catalog says its
  // route is gone — otherwise the select shows a value it does not contain.
  return selectedModel && !options.includes(selectedModel)
    ? [selectedModel, ...options]
    : options;
}

function ProviderRow({
  provider,
  radioName,
  isDefault,
  selection,
  disabled,
  dimmed = false,
  reason,
  onChangeSelection,
  onSelectDefault,
}: ProviderRowProps): JSX.Element {
  const models = providerModelOptions(provider, selection?.model);
  const isCreditsRow = provider === 'aiCredits';
  // A gateway model's thinking options follow the harness that will actually
  // execute it. `?? 'codex'` because gateway-only ids are absent from the local
  // registries on a cold catalog and codex is their harness in the seed.
  const thinkingProvider: AgentProviderType = isCreditsRow
    ? ((selection?.model
        ? getExecutionHarnessForModel(selection.model)
        : undefined) ?? 'codex')
    : provider;
  const hasModels = models.length > 0;
  const radioDisabled = disabled || selection === null;
  const radioId = `chat-defaults-radio-${radioName}-${provider}`;

  const effectiveModel = selection?.model ?? '';
  const effectiveThinking = selection?.thinkingLevel ?? 'high';
  const selectedModelUnavailable =
    effectiveModel !== '' &&
    (isCreditsRow
      ? isModelBlocked(effectiveModel, getRendererModelPolicy()) ||
        (hasHydratedGatewayCatalog() && !isGatewayRoutableModel(effectiveModel))
      : !models.includes(effectiveModel));
  // The shared UI levels show Low as Medium. Sol is the one model whose
  // defaults offer Low, and only when its route declares it.
  const exposeSolLow =
    !selectedModelUnavailable &&
    selection?.model === SOL_LOW_MODEL &&
    modelSupportsThinkingLevel(
      selection.model,
      'low',
      thinkingProvider,
      isCreditsRow,
    );
  const uiThinkingOptions = getThinkingUiOptionsForProvider(
    thinkingProvider,
    selection?.model,
  );
  const thinkingOptions: { value: ThinkingLevel; label: string }[] =
    exposeSolLow
      ? [
          ...uiThinkingOptions.filter((t) => t.value === 'off'),
          { value: 'low', label: 'Low' },
          ...uiThinkingOptions.filter((t) => t.value !== 'off'),
        ]
      : uiThinkingOptions;

  const modelOptions: SettingsSelectOption[] = [];
  if (selectedModelUnavailable) {
    modelOptions.push({
      value: effectiveModel,
      label: `${effectiveModel} (unavailable)`,
      disabled: true,
    });
  }
  if (!hasModels) {
    modelOptions.push({
      value: '',
      label: isCreditsRow ? 'Automatic' : 'No models available',
    });
  } else {
    // `null` IS the credits-lane sentinel for "pick the current
    // catalog-backed default", so it needs a real, re-selectable option
    // rather than a placeholder that vanishes once a concrete model is
    // chosen. A literal gateway-only id cannot be seeded instead: it is
    // absent from `package.json`, so a cold or offline launch would
    // normalize it straight back out.
    if (isCreditsRow) {
      modelOptions.push({ value: '', label: 'Automatic' });
    } else if (selection === null) {
      modelOptions.push({ value: '', label: 'Select a model…' });
    }
    // Only real provider base models are listed here. Custom Agent models
    // (`agent_model_*`) are intentionally excluded from these
    // workspace/standalone default selectors: `models` is sourced from the
    // provider registries (CLAUDE/CODEX/OLLAMA), never from AGENT_MODELS.
    // Agent presets are offered exclusively in the chat ModelPicker, which
    // resolves them to a base model at send time.
    for (const m of models) {
      if (selectedModelUnavailable && m === effectiveModel) continue;
      modelOptions.push({
        value: m,
        label:
          isCreditsRow && !AI_GATEWAY_MODELS.includes(m)
            ? m
            : getModelDisplayName(m),
      });
    }
  }
  const thinkingSelectOptions: readonly SettingsSelectOption[] =
    selectedModelUnavailable
      ? [
          {
            value: effectiveThinking,
            label:
              THINKING_UI_OPTIONS.find((t) => t.value === effectiveThinking)
                ?.label ?? effectiveThinking,
          },
        ]
      : thinkingOptions;

  // The settings row's geometry: the label and its one-line reason leading,
  // the paired 144px model and effort dropdowns trailing, as in the feature
  // model rows below it.
  return (
    <div
      data-testid={`chat-defaults-row-${provider}`}
      data-lane-dimmed={dimmed ? 'true' : 'false'}
      className={dimmed ? 'opacity-60' : undefined}
    >
      <SettingsRow
        htmlFor={isCreditsRow ? undefined : radioId}
        label={
          <span className="flex min-w-0 items-center gap-2.5">
            {isCreditsRow ? (
              // No radio: the credits lane is not an `AgentProviderType`, so it
              // can never be `defaultProvider`. It is reached by lane
              // resolution when no native subscription can pay, and
              // configured here.
              <span aria-hidden="true" className="size-4 shrink-0" />
            ) : (
              <Radio
                id={radioId}
                name={radioName}
                checked={isDefault}
                disabled={radioDisabled}
                onChange={(): void => onSelectDefault()}
              />
            )}
            {PROVIDER_LABELS[provider]}
          </span>
        }
        description={
          reason ? (
            <span data-testid={`chat-defaults-reason-${provider}`}>
              {reason}
            </span>
          ) : undefined
        }
        control={
          <div className="flex shrink-0 items-center gap-2">
            <span className="inline-flex w-36">
              <SettingsSelect
                width="fill"
                data-testid={`chat-defaults-model-${provider}`}
                options={modelOptions}
                value={effectiveModel}
                disabled={disabled || !hasModels}
                onValueChange={(value): void => {
                  if (!value) {
                    onChangeSelection(null);
                    return;
                  }
                  // Leaving a visible Sol Low saves the level the row then shows,
                  // so no hidden `low` reaches new chats on the next model.
                  const clampedThinking =
                    exposeSolLow &&
                    effectiveThinking === 'low' &&
                    value !== SOL_LOW_MODEL
                      ? getThinkingUiValueForProvider(
                          'low',
                          'high',
                          thinkingProvider,
                          value,
                        )
                      : isCreditsRow
                        ? effectiveThinking
                        : normalizeThinkingForProvider(
                            effectiveThinking,
                            provider,
                          );
                  onChangeSelection({
                    model: value,
                    thinkingLevel: clampedThinking,
                  });
                }}
              />
            </span>
            <span className="inline-flex w-36">
              <SettingsSelect
                width="fill"
                data-testid={`chat-defaults-thinking-${provider}`}
                options={thinkingSelectOptions}
                value={
                  selectedModelUnavailable
                    ? effectiveThinking
                    : exposeSolLow && effectiveThinking === 'low'
                      ? 'low'
                      : getThinkingUiValueForProvider(
                          effectiveThinking,
                          'high',
                          thinkingProvider,
                          selection?.model,
                        )
                }
                disabled={
                  disabled || selection === null || selectedModelUnavailable
                }
                onValueChange={(next): void => {
                  if (!selection) return;
                  onChangeSelection({
                    ...selection,
                    thinkingLevel: getSelectedThinkingLevel(
                      next,
                      selection.thinkingLevel,
                    ),
                  });
                }}
              />
            </span>
          </div>
        }
      />
    </div>
  );
}

export function ChatTab(): JSX.Element {
  const cursorHarnessEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key),
  );

  const [prefs, setPrefs] = useState<PreferencesLoadResult | null>(null);
  const loadModelDefaults = useChatStore((s) => s.loadModelDefaults);
  const setWorktreeSummaryEnabled = useActivityStore(
    (state) => state.setWorktreeSummaryEnabled,
  );

  useEffect(() => {
    const api: CanopyApi = window.api;
    void api
      .loadPreferences({ view: 'persisted' })
      .then((p: PreferencesData) => setPrefs(p))
      .catch(() => setPrefs(null));
  }, []);

  useEffect(
    () =>
      subscribePreferencesUpdated((updated) => {
        // Advisor events may include effective overrides; keep other persisted rows intact.
        setPrefs((current) =>
          current
            ? {
                ...current,
                handoffSummaryModel: updated.handoffSummaryModel,
                handoffSummaryThinkingLevel:
                  updated.handoffSummaryThinkingLevel,
              }
            : current,
        );
      }),
    [],
  );

  function save(patch: Partial<PreferencesData>): void {
    if (!prefs) return;
    const next = { ...prefs, ...patch };
    setPrefs(next);
    if (patch.worktreeSummaryEnabled !== undefined) {
      setWorktreeSummaryEnabled(next.worktreeSummaryEnabled);
    }
    const api: CanopyApi = window.api;
    void api
      .savePreferences(patch)
      .then(() => {
        void loadModelDefaults();
      })
      .catch(() => {
        // Swallow — preference save can fail if userData is unavailable.
      });
  }

  if (!prefs) {
    return (
      <SettingsPage title="Models">
        <SettingsLoading />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title="Models" dataTestId="settings-tab-chat">
      <ProviderDefaultsGroup
        title="Default code model"
        description="Per-provider defaults for worktree chats. The chosen provider is the overall default."
        byProvider={prefs.defaultWorktreeModelByProvider}
        defaultProvider={prefs.defaultWorktreeProvider}
        radioName="worktree-default-provider"
        resolvedLane={prefs.lastResolvedDefaultLaneByScope?.worktree}
        onChange={({ byProvider, defaultProvider }): void =>
          save({
            defaultWorktreeModelByProvider: byProvider,
            defaultWorktreeProvider: defaultProvider,
          })
        }
      />

      <ProviderDefaultsGroup
        title="Default chat model"
        description="Per-provider defaults for new standalone chats. The chosen provider is the overall default."
        byProvider={prefs.defaultChatModelByProvider}
        defaultProvider={prefs.defaultChatProvider}
        radioName="chat-default-provider"
        resolvedLane={prefs.lastResolvedDefaultLaneByScope?.chat}
        onChange={({ byProvider, defaultProvider }): void =>
          save({
            defaultChatModelByProvider: byProvider,
            defaultChatProvider: defaultProvider,
          })
        }
      />

      <SettingsSection title="Feature models">
        <SettingsGroup>
          <ModelThinkingPreferenceRow
            title="Chat title model"
            description="Generates names for chat tabs."
            model={prefs.summaryModel ?? defaultSummaryModel()}
            thinkingLevel={prefs.summaryThinkingLevel}
            defaultThinkingLevel="off"
            onModelChange={(model, thinkingLevel) =>
              save({
                summaryModel: model,
                summaryModelSetByUser: true,
                summaryThinkingLevel: thinkingLevel,
              })
            }
            onThinkingChange={(thinkingLevel) =>
              save({ summaryThinkingLevel: thinkingLevel })
            }
          />
          <ModelThinkingPreferenceRow
            title="Conversation handoff model"
            description="Summarizes conversations for provider switching, session recovery, and continuation from archived chats."
            model={prefs.handoffSummaryModel}
            thinkingLevel={prefs.handoffSummaryThinkingLevel}
            defaultThinkingLevel="off"
            onModelChange={(model, thinkingLevel) =>
              save({
                handoffSummaryModel: model,
                handoffSummaryThinkingLevel: thinkingLevel,
              })
            }
            onThinkingChange={(thinkingLevel) =>
              save({ handoffSummaryThinkingLevel: thinkingLevel })
            }
            testIdPrefix="settings-handoff-summary"
          />
          <ModelThinkingPreferenceRow
            title="Cron generation model"
            description="Turns natural-language schedules into cron expressions."
            model={prefs.cronGenerationModel}
            thinkingLevel={prefs.cronGenerationThinkingLevel}
            defaultThinkingLevel="off"
            onModelChange={(model, thinkingLevel) =>
              save({
                cronGenerationModel: model,
                cronGenerationThinkingLevel: thinkingLevel,
              })
            }
            onThinkingChange={(thinkingLevel) =>
              save({ cronGenerationThinkingLevel: thinkingLevel })
            }
            includeOllama={false}
          />
          <ModelThinkingPreferenceRow
            title="If Command generation model"
            description="Turns natural-language descriptions into automation If Commands."
            model={prefs.ifCommandGenerationModel}
            thinkingLevel={prefs.ifCommandGenerationThinkingLevel}
            defaultThinkingLevel="off"
            onModelChange={(model, thinkingLevel) =>
              save({
                ifCommandGenerationModel: model,
                ifCommandGenerationThinkingLevel: thinkingLevel,
              })
            }
            onThinkingChange={(thinkingLevel) =>
              save({ ifCommandGenerationThinkingLevel: thinkingLevel })
            }
            includeOllama={false}
          />
          <ModelThinkingPreferenceRow
            title="Plan parsing and diagrams model"
            description="Parses tracked plans and draws plan diagrams, separate from the chat defaults."
            model={prefs.planDiagramModel}
            thinkingLevel={prefs.planDiagramThinkingLevel}
            defaultThinkingLevel="off"
            onModelChange={(model, thinkingLevel) =>
              save({
                planDiagramModel: model,
                planDiagramThinkingLevel: thinkingLevel,
              })
            }
            onThinkingChange={(thinkingLevel) =>
              save({ planDiagramThinkingLevel: thinkingLevel })
            }
            includeOllama={false}
          />
          <ModelThinkingPreferenceRow
            title="Code review"
            description="Review annotations and diagrams."
            model={prefs.codeReviewModel}
            thinkingLevel={prefs.codeReviewThinkingLevel}
            defaultThinkingLevel="off"
            onModelChange={(model, thinkingLevel) =>
              save({
                codeReviewModel: model,
                codeReviewThinkingLevel: thinkingLevel,
              })
            }
            onThinkingChange={(thinkingLevel) =>
              save({ codeReviewThinkingLevel: thinkingLevel })
            }
            includeOllama={false}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Worktree summary">
        <SettingsGroup>
          <SettingsRow
            label="Worktree summary"
            htmlFor="settings-worktree-summary-enabled"
            description="An activity-panel summary for the whole worktree."
            control={
              <ToggleSwitch
                id="settings-worktree-summary-enabled"
                checked={prefs.worktreeSummaryEnabled}
                label="Worktree summary"
                onChange={(next) => save({ worktreeSummaryEnabled: next })}
                dataTestId="settings-worktree-summary-enabled"
              />
            }
          />
          <ModelThinkingPreferenceRow
            title="Worktree activity summary model"
            description="Generates activity-panel summaries covering the whole worktree."
            model={prefs.worktreeSummaryModel}
            thinkingLevel={prefs.worktreeSummaryThinkingLevel}
            defaultThinkingLevel="off"
            onModelChange={(model, thinkingLevel) =>
              save({
                worktreeSummaryModel: model,
                worktreeSummaryThinkingLevel: thinkingLevel,
              })
            }
            onThinkingChange={(thinkingLevel) =>
              save({ worktreeSummaryThinkingLevel: thinkingLevel })
            }
            disabled={!prefs.worktreeSummaryEnabled}
            includeOllama={false}
          />
          <SettingsPluginPicker
            label="Summary generator plugins"
            description={`Loaded when ${brandText.appName} generates whole-worktree summaries.`}
            selections={prefs.worktreeSummaryPluginSelections}
            onChange={(selections) =>
              save({ worktreeSummaryPluginSelections: selections })
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Execution">
        <SettingsGroup>
          <SettingsRow
            label="RTK command rewriting"
            htmlFor="settings-rtk-enabled"
            description={
              cursorHarnessEnabled
                ? 'The bundled RTK helper rewrites compatible Claude and Cursor shell commands to lower-output equivalents. Applies to Claude chats, Claude workflow agents, and Cursor chats.'
                : 'The bundled RTK helper rewrites compatible Claude shell commands to lower-output equivalents. Applies to Claude chats and Claude workflow agents.'
            }
            control={
              <ToggleSwitch
                id="settings-rtk-enabled"
                checked={prefs.rtkEnabled}
                label="RTK command rewriting"
                onChange={(next) => save({ rtkEnabled: next })}
                dataTestId="settings-rtk-enabled"
              />
            }
          />
          <SettingsRow
            label="Retry transient errors"
            description="Overloaded, 5xx, and dropped-connection errors are retried after a short delay. Retries back off and stop after a few attempts."
          >
            <SettingsSubRow
              label="Chats"
              htmlFor="settings-auto-retry-transient-chats"
              control={
                <ToggleSwitch
                  id="settings-auto-retry-transient-chats"
                  checked={prefs.autoRetryTransientErrorsChats}
                  label="Retry transient errors in chats"
                  onChange={(next) =>
                    save({ autoRetryTransientErrorsChats: next })
                  }
                  dataTestId="settings-auto-retry-transient-chats"
                />
              }
            />
            <SettingsSubRow
              label="Workflows"
              htmlFor="settings-auto-retry-transient-pipelines"
              control={
                <ToggleSwitch
                  id="settings-auto-retry-transient-pipelines"
                  checked={prefs.autoRetryTransientErrorsPipelines}
                  label="Retry transient errors in workflows"
                  onChange={(next) =>
                    save({ autoRetryTransientErrorsPipelines: next })
                  }
                  dataTestId="settings-auto-retry-transient-pipelines"
                />
              }
            />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Composer">
        <SettingsGroup>
          <SettingsRow
            label="Next prompt suggestions"
            htmlFor="settings-prompt-suggestions-enabled"
            description="After a Claude or Codex turn, the empty composer shows a likely next message. Press Tab to use it. Each suggestion is a small extra request."
            control={
              <ToggleSwitch
                id="settings-prompt-suggestions-enabled"
                checked={prefs.promptSuggestionsEnabled !== false}
                label="Next prompt suggestions"
                onChange={(next) => save({ promptSuggestionsEnabled: next })}
                dataTestId="settings-prompt-suggestions-enabled"
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}
