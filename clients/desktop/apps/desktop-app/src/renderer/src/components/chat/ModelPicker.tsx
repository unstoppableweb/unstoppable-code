import {
  acquireModelRecoveryLease,
  supersedeModelRecovery,
  type ModelRecoveryLease,
  type ModelRecoveryTarget,
  type ModelRecoveryFreshness,
} from '@/lib/modelRecoveryLease';
import {
  isAntigravityHarnessReleased,
  getAntigravitySettingsSection,
} from '@/lib/antigravity-settings';
import { useOpenCodeChatAvailable } from '@/hooks/useOpenCodeChatAvailable';
import { useOpenCodeModels } from '@/hooks/useOpenCodeModels';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { openAccountOrganizationPage } from '@/lib/navigation/settings-destinations';
import {
  getCursorSettingsSection,
  isCursorHarnessReleased,
} from '@/lib/cursor-settings';
import { getCopilotSettingsSection } from '@/lib/copilot-settings';
import { getOpenCodeSettingsSection } from '@/lib/opencode-settings';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useCopilotChatAvailable } from '@/hooks/useCopilotChatAvailable';
import { useCopilotModels } from '@/hooks/useCopilotModels';
import { brandText } from '@/lib/brand';
import { registerChatHarnessAction } from '@/lib/chat-harness-actions';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useCursorModels } from '@/hooks/useCursorModels';
import { useCursorChatAvailable } from '@/hooks/useCursorChatAvailable';
import {
  useCallback,
  useId,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type RefObject,
} from 'react';
import type {
  AgentProviderType,
  AiCreditsScopeRequest,
  ChatModel,
  ModelHarness,
} from '@canopy/desktop-shared/types';
import {
  AGENT_MODELS,
  AI_GATEWAY_MODELS,
  CLAUDE_MODELS,
  CODEX_ACCOUNT_MODELS,
  CODEX_MODELS,
  OLLAMA_MODELS,
  getAgentModelAvailability,
  getChatHarnessOptions,
  getExecutionHarnessForModel,
  getGatewayModelEntry,
  getModelDisplayName,
  getCanonicalPickerModel,
  getModelPickerMappings,
  isCopilotModel,
  isOpenCodeModel,
  resolveDefaultChatModel,
  getModelSource,
  getProviderForModel,
  hasHydratedGatewayCatalog,
  getAgentModelSelectionId,
  isAgentModel,
  isInheritingAgentModel,
  pinInheritingAgentModel,
  isCursorModel,
  resolveAgentModelDefinition,
  resolveKnownModel,
} from '@canopy/desktop-shared/types';
import {
  isGatewayOnlyModel,
  isGatewayRoutableModel,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import { buildModelCatalogOption } from '@canopy/desktop-shared/lib/model-catalog-projection';
import { getModelFamilyMetadata } from '@canopy/desktop-shared/model-config';
import {
  AI_CREDITS_PURCHASE_LABEL,
  connectProviderLabel,
  ModelPickerMenu,
  MODEL_PICKER_AUTO_REASONS,
  managedOpenCodeAutoUnavailableReason,
  MODEL_PICKER_ROW_CUE_COPY,
  modelLibraryUnlockHint,
  modelLibraryUnlockLabel,
  pickerChromeMenuHeightPx,
  FloatingMenu,
  DropdownMenuItem,
  ChatComposerToolbarChip,
  type ModelCatalog,
  type ModelCatalogOption,
  type ModelPickerAutoOption,
  type ModelPickerGatewayTab,
  type ModelPickerMenuControls,
  type ModelPickerOptionState,
  type ModelPickerMenuProps,
  type ModelPickerSelectionContext,
  type ModelPickerSelectionDisposition,
  CompactToggleIndicator,
  preferredGatewayTabId,
} from '@canopy/ui-shared';
import { matchAiGatewayPreset } from '@canopy/protocol/model-gateway/presets';
import {
  resolveModelRowGate,
  type LockedProviderBehavior,
  isGuestAllowedSelection,
  type ModelRecovery,
  type VisibleModelRowGate,
} from '@/lib/modelPickerRowGate';
import { resolveDesktopModelRowCue } from '@/lib/modelPickerRowCue';
import {
  resolveModelLibraryLock,
  type LockedModelLibraryAccess,
} from '@/lib/modelLibraryAccess';
import { guestModelGateTitle, guestModelGateToast } from '@/lib/guest-cta-copy';
import { useIsGuestCredential } from '@/hooks/useIsGuestCredential';
import { useWorkModelLibraryAccess } from '@/hooks/useModelLibraryAccess';
import { useComposerWorkIsPersonal } from '@/hooks/useComposerAiCreditsBalance';
import {
  useUnlockModelsAction,
  type UnlockModelsResult,
} from '@/lib/openBillingPage';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
import {
  getRendererCodexAccountModelsKey,
  subscribeRendererBillingLaneFacts,
} from '@/stores/billingLaneRuntime';
import { useNavigationStore } from '@/stores/navigationStore';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import { getProviderLabel } from '@/lib/providerLabels';
import type { ProviderAvailability } from '@/hooks/useProviderAvailability';
import { RichHoverTooltip } from '@/components/shared/RichHoverTooltip';
import type {
  BillingFramework,
  ChatBillingResolution,
} from '@/lib/chatBillingFramework';
import { AuthLoginModal } from '@/components/settings/AuthLoginModal';
import { GetAiCreditsCta } from './GetAiCreditsCta';
import { BrandLogo } from '@/components/BrandLogo';
import { DEFAULT_MODEL_PICKER_FAVORITES } from '@/lib/model-picker-default-favorites';
import {
  resolveGuestModelFallback,
  revalidateGuestModelFallback,
  type GuestModelFallback,
} from '@/lib/guestModelFallback';
import {
  ModelRecoveryModal,
  type GuestFallbackOutcome,
  type ModelCommitOutcome,
  type PendingModelRecovery,
} from './ModelRecoveryModal';
import {
  AgentModelPicker,
  Button,
  Divider,
} from '@canopy/ui-shared/components';
import {
  changeSelectedAgent,
  changeSelectedModel,
  selectedAgentId,
} from '@canopy/ui-shared/lib';
import { parseAgentRouteModelId } from '@canopy/protocol/agents';

// Re-exported from its new home in the pure resolver so the seven existing
// call sites keep importing it from the picker.
export type { LockedProviderBehavior };

/** One row, with its gate already resolved (CAN-2349 §2). */
interface ModelRow {
  readonly model: ChatModel;
  readonly runtimeModel: ChatModel;
  /**
   * What picking the row sends when it differs from `runtimeModel`: an Agent
   * on the default model is described and gated by its pinned route, but each
   * destination pins the bare Agent to its own default.
   */
  readonly selectionModel?: ChatModel;
  readonly provider: AgentProviderType;
  readonly gate: VisibleModelRowGate;
}

interface ModelRowGroup {
  readonly key: string;
  readonly rows: readonly ModelRow[];
}

interface ModelPickerBillingProps {
  /** Home has no explicit billing intent until a preference is remembered. */
  value: BillingFramework | undefined;
  onChange: (framework: BillingFramework) => void;
  /** This chat explicitly chose a native attempt despite an auth probe. */
  allowUnverifiedSubscription?: boolean;
  disabled?: boolean;
  lockedReason?: string;
  lockKind?: ChatBillingResolution['lockKind'];
  provider: AgentProviderType;
}

interface BaseModelPickerProps {
  triggerControlProps?: ModelPickerMenuProps['triggerControlProps'];
  ownerDocument?: Document;
  lockedProvider?: AgentProviderType;
  /** See {@link LockedProviderBehavior}. Defaults to `'disabled'`. */
  lockedProviderBehavior?: LockedProviderBehavior;
  /**
   * Overrides the generic locked-row copy with a more specific reason, for a
   * chat that is eligible for continuing in principle but blocked right now
   * (streaming, queued turns, a pending plan approval).
   */
  lockedProviderReason?: string;
  lockedHarness?: ModelHarness;
  /**
   * The harness a new chat's hosted model will run on, as picked in this
   * picker. The trigger shows it, as it shows a started chat's harness.
   */
  executionHarness?: ModelHarness;
  executionHarnessExplicitlyChosen?: boolean;
  hideLabel?: boolean;
  disabled?: boolean;
  openSignal?: number;
  externalTriggerRef?: RefObject<HTMLElement | null>;
  onRestoreFocus?: () => void;
  capsule?: boolean;
  /**
   * Opts a composer into the harness browser: favorites, All, and one tab per
   * execution harness, with a credits model's harness chosen per model.
   */
  browserLayout?: 'harnesses';
  /** Horizontal shift of the menu against the trigger (see `ModelPickerMenu`). */
  menuAlignOffset?: number;
  /** Right-aligns the menu to this element, the composer box (see `ModelPickerMenu`). */
  menuAlignRef?: RefObject<HTMLElement | null>;
  /** The edge of `menuAlignRef` the menu lines up with (see `ModelPickerMenu`). */
  menuAlignEdge?: 'left' | 'right';
  /** Lets the trigger shrink and truncate its model name in a tight row. */
  allowTriggerShrink?: boolean;
  /** Folds the trigger's icon once the name nearly truncates away (capsule). */
  foldTriggerIconWhenTight?: boolean;
  /** Folds it at the first ellipsis instead (see `ModelPickerMenu`). */
  foldTriggerIconOnTruncate?: boolean;
  /** Leaves the capsule trigger's chevron off (see `ModelPickerMenu`). */
  hideTriggerChevron?: boolean;
  hideAgents?: boolean;
  /** Local composers opt in; aliases and Agent definitions keep concrete-only menus. */
  separateAgents?: boolean;
  /** Raw form/Home choice, before display-only default pinning. */
  selectionModel?: ChatModel;
  workspaceDefaultLabel?: string;
  /**
   * The default model an Agent that inherits the default would run on in this
   * chat.
   */
  inheritedDefaultModel?: ChatModel;
  placeholderLabel?: string;
  /**
   * What this picker governs, shown as the trigger's tooltip (CAN-2701).
   * Defaults to the chat composer's meaning; the config surfaces that set a
   * pipeline alias, a hook action, an automation, or an Agent's base model
   * pass their own so the tooltip is never a lie about scope.
   */
  triggerTooltip?: string | null;
  providerAvailability?: ProviderAvailability;
  /**
   * CAN-2349 case H. Open a NEW chat already set to `model`, for a row whose
   * harness pair can never be continued (Ollama in either direction). Passed
   * only by `ChatInput`; `canStartNewChat` is `onStartNewChat !== undefined`,
   * so the five config surfaces stay unaffected.
   *
   * The picker deliberately does NOT commit the model itself here — that would
   * change the OLD chat too.
   */
  onStartNewChat?: (
    model: ChatModel,
    billingFramework?: BillingFramework,
  ) => void;
  /**
   * Identity of the chat these props describe (`ChatInput` passes `tab.id`).
   *
   * Exists solely so a pending recovery can tell whether the rows it is looking
   * at still belong to the chat that STARTED it. This component survives a
   * chat-tab switch on some surfaces (`CodeReviewModal`), and after one the
   * gates describe the newly active chat while the captured recovery still
   * commits to the original — so a lock read off the current rows would be a
   * verdict about the wrong chat. Omitted by the five config surfaces, which
   * never raise a recovery at all.
   */
  recoveryChatKey?: string;
  recoveryTarget?: ModelRecoveryTarget;
  /**
   * Owner of the chat this picker belongs to (CAN-3463). The recovery modal and
   * credits CTA ask about THIS owner's organization pool only. Snapshotted when
   * a recovery starts, like {@link recoveryChatKey}. Omitted = navigation.
   */
  aiCreditsScope?: AiCreditsScopeRequest;
  /**
   * Whether this surface supports Cursor models, including custom Agents backed
   * by Cursor. Chat, Home, and the Agent editor opt in; other configuration
   * pickers stay excluded.
   */
  allowCursor?: boolean;
  allowAntigravity?: boolean;
  allowCopilot?: boolean;
  allowOpenCode?: boolean;
  /**
   * Commit a recovered model and report whether it actually LANDED.
   *
   * The authoritative answer, and the reason the recovery flow no longer has to
   * guess from the rendered rows: `ChatInput` routes this through
   * `setModelAndWait`, which surfaces main's `accepted` verdict for the
   * ORIGINATING chat — correct even when this picker has since switched to a
   * different one. `onModelChange` cannot serve here because it is
   * fire-and-forget, so a refusal reaches the caller as silence.
   *
   * Optional: the five config surfaces never raise a recovery, and a caller
   * that omits it keeps the previous fire-and-forget behavior.
   */
  onRecoveryCommit?: (
    model: ChatModel,
    billingFramework?: BillingFramework,
    executionHarness?: ModelHarness,
    isStillWanted?: ModelRecoveryFreshness,
    retainContinuation?: () => () => void,
  ) => Promise<boolean>;
  /**
   * Per-chat billing framework toggle. When provided, an "AI Credits" switch is
   * pinned as a footer at the bottom of the popup (off = the user's Claude/Codex
   * subscription) and the model list above is constrained to gateway-routable
   * models while it is on (`value === 'ai-credits'`). Omitted at the
   * pipeline/workspace-default call sites where billing does not apply, so the
   * toggle never renders there.
   */
  billing?: ModelPickerBillingProps;
  /**
   * Per-turn Auto routing. Supplied only by the two interactive composers
   * (`ChatInput` and `HomeComposerControls`); the configuration surfaces —
   * pipeline aliases, hook actions, automations, Agent base models — never
   * route per turn and pass nothing, so the row does not render there.
   *
   * The host resolves the rollout flag, the server capability, and the AI
   * Credits funding chain; this component contributes the one gate only it can
   * see, the "at least two compatible models" candidate count.
   */
  auto?: {
    readonly selected: boolean;
    readonly onSelect: () => void;
    /** Host-resolved reason, if any, that already blocks Auto. */
    readonly unavailableReason?: string;
    /** Opens the fix for the host's reason; dropped for picker-owned reasons. */
    readonly unavailableAction?: () => void;
    /** Compact/quick pickers hide an unavailable Auto row outright. */
    readonly hideWhenUnavailable?: boolean;
  };
}

interface RequiredModelPickerProps extends BaseModelPickerProps {
  currentModel: ChatModel;
  onModelChange: (
    model: ChatModel,
    billingFramework?: BillingFramework,
    executionHarness?: ModelHarness,
  ) => void;
  allowWorkspaceDefault?: false;
}

interface OptionalModelPickerProps extends BaseModelPickerProps {
  currentModel: ChatModel | undefined;
  onModelChange: (
    model: ChatModel | undefined,
    billingFramework?: BillingFramework,
    executionHarness?: ModelHarness,
  ) => void;
  allowWorkspaceDefault: true;
}

type ModelPickerProps = RequiredModelPickerProps | OptionalModelPickerProps;

const WORKSPACE_DEFAULT_LABEL = 'Project default';

/**
 * CAN-4028 — the lock hint for a recovery that is a model-library lock, or
 * `undefined` for every other recovery.
 *
 * Library locks are the one deliberate exception to "a recoverable row is
 * indistinguishable from an available one" (see `modelPickerRowGate`). The
 * other recoveries depend on account state the user may fix in passing; this
 * one is a standing property of the account, so the row says so up front and
 * names the remedy with the hint every platform shares.
 */
function libraryLockCopy(
  recovery: ModelRecovery,
): { readonly hint: string; readonly label?: string } | undefined {
  const access =
    recovery.kind === 'needs-purchase'
      ? 'needs_purchase'
      : recovery.kind === 'needs-account'
        ? (recovery.access ?? 'needs_sign_in')
        : undefined;
  const hint = modelLibraryUnlockHint(access);
  if (hint === undefined) return undefined;
  const label = modelLibraryUnlockLabel(access);
  return label === undefined ? { hint } : { hint, label };
}

/** The library recovery a lock for `access` names. */
function libraryRecoveryFor(access: LockedModelLibraryAccess): ModelRecovery {
  return access === 'needs_purchase'
    ? { kind: 'needs-purchase' }
    : { kind: 'needs-account', access };
}

/**
 * The harness picker fits its rail, but never drops below a six-tab rail, so a
 * short rail still shows about five models.
 */
const HARNESS_PICKER_MIN_HEIGHT_PX = pickerChromeMenuHeightPx({
  railTabCount: 6,
});
/**
 * Shown when the commit did not land and the picker can no longer see the row
 * to quote its own reason — i.e. after a chat-tab switch, where the rendered
 * rows belong to a different chat.
 *
 * Names no cause ON PURPOSE. `setModelAndWait` resolves `false` for a refusal
 * from main, but ALSO for its two pre-flight bail-outs (no such chat, a file
 * tab) and for any IPC rejection it swallows. Asserting "that chat is busy"
 * would be a guess, and on the bail-out paths it would be a wrong one attached
 * to a Try again that can never clear — the dead end this ticket removes, one
 * layer deeper. Say only what is certainly true and keep the retry honest.
 */
const LOCKED_COMMIT_FALLBACK_REASON = 'We couldn’t switch models on that chat.';

/**
 * CAN-4703 — the offered guest model can no longer be selected from here: its
 * row vanished, was disabled, or the picker now shows a different chat.
 */
function guestFallbackUnavailableReason(label: string): string {
  return `${label} isn’t available right now. Sign in, or pick another model.`;
}

/**
 * One shared per-row projection with the portal catalog (CAN-2540): every
 * field — description, family/vendor grouping, harness, thinking sets,
 * context window, billing markers — comes from
 * `buildModelCatalogOption`, so the desktop dropdown and the web picker
 * cannot drift. The desktop picker resolves its own selection state, so no
 * `defaultModel` is stamped here.
 */
/**
 * The organization whose own gateway serves this model, or `undefined` for a
 * hosted AI Credits row.
 *
 * Read off the ROUTE, not the model id: an org may declare a model we also
 * ship, so nothing about the id itself distinguishes the two. The route is
 * where `origin` lives, and it is the same field routing dispatches on.
 */
function orgGatewayOrganizationId(model: ChatModel): string | undefined {
  const entry = getGatewayModelEntry(model);
  return entry?.origin === 'org-gateway' ? entry.organizationId : undefined;
}

/** Section key an org's own gateway rows group under in the picker menu. */
function orgVendorKey(organizationId: string): string {
  return `org-gateway:${organizationId}`;
}

/** The execution harness a picker selection names, if it is one we run. */
function toModelHarness(value: string | undefined): ModelHarness | undefined {
  return value === 'claude' ||
    value === 'codex' ||
    value === 'antigravity' ||
    value === 'cursor' ||
    value === 'copilot' ||
    value === 'opencode'
    ? value
    : undefined;
}

function rowToCatalogOption(row: ModelRow): ModelCatalogOption {
  const identity: ModelCatalogOption = buildModelCatalogOption(row.model, {
    provider: row.provider,
  }) ?? {
    // Unreachable in practice (only an unregistered Agent id projects to
    // nothing, and such ids never produce a visible row); typed fallback
    // keeps the catalog total without a cast.
    id: row.model,
    label: getModelDisplayName(row.model),
    provider: row.provider,
    kind: 'model',
    available: true,
  };
  if (row.runtimeModel === row.model) return identity;
  const runtime = buildModelCatalogOption(row.runtimeModel, {
    provider: row.provider,
  });
  // An Agent on the default model reads exactly as the route it would pin,
  // billing included, but keeps the id that picking it sends.
  if (row.selectionModel !== undefined && runtime) {
    return { ...runtime, id: identity.id };
  }
  return {
    ...identity,
    provider: row.provider,
    harness: runtime?.harness,
    // Cursor reports no context window; the model's own still describes it.
    contextWindow: runtime?.contextWindow ?? identity.contextWindow,
    supportedThinkingLevels: runtime?.supportedThinkingLevels ?? [],
    thinkingLevels: runtime?.thinkingLevels ?? [],
  };
}

/**
 * Same projection, with the row's vendor forced to its organization.
 *
 * `ModelPickerMenu` draws its section headings from the VENDOR, and an org
 * model carries none of the id prefixes the family-metadata fallback matches —
 * so without this every org row falls into the unclaimed bucket and, worse,
 * mixes with the hosted AI Credits rows it must never be confused with. The
 * heading is the primary disambiguation between an org's "Claude Opus" and
 * ours.
 */
function orgRowToCatalogOption(
  row: ModelRow,
  organizationId: string,
): ModelCatalogOption {
  return {
    ...rowToCatalogOption(row),
    vendor: orgVendorKey(organizationId),
    // Gateway-only normally means hosted AI Credits. Organization models use
    // the member's own key and the organization's provider contract instead.
    extraChargeOnly: false,
    extraChargeMessage: undefined,
  };
}

/** The trigger label for a chat whose model was removed. */
const RETIRED_MODEL_LABEL = 'Model no longer available';

/**
 * The picker's message when the organization allows no models. Names the org
 * that owns the active work; generic when that owner is unknown.
 */
function organizationEmptyCatalog(
  organizationName: string | undefined,
  policyOrganizationId: string | null,
): {
  title: string;
  subtitle: string;
  action?: { label: string; onClick: () => void; testId: string };
} {
  const title = `${organizationName ?? 'Your organization'} turned off all models`;
  if (policyOrganizationId === null) {
    return { title, subtitle: 'Ask your admin to turn one on' };
  }
  // An owner or admin can turn models back on themselves.
  return {
    title,
    subtitle: 'Turn one on in the organization model policy',
    action: {
      label: 'Manage model policy',
      testId: 'model-catalog-empty-manage-policy',
      onClick: (): void => {
        openAccountOrganizationPage({
          scope: 'organization',
          organizationId: policyOrganizationId,
          page: 'settings',
          subtab: 'policies',
        });
      },
    },
  };
}

/** The message when the organization requires its gateway but has no models. */
function organizationGatewayEmptyCatalog(
  organizationName: string | undefined,
): { title: string; subtitle: string } {
  return {
    title: `${organizationName ?? 'Your organization'} hasn't added any models yet`,
    subtitle: 'Ask your admin to add one',
  };
}

export function ModelPicker(props: ModelPickerProps): JSX.Element {
  return props.separateAgents ? (
    <LocalAgentModelPicker {...props} />
  ) : (
    <ConcreteModelPicker {...props} />
  );
}

interface LocalAgentSelection {
  selection: ChatModel | undefined;
  effectiveModel: ChatModel | undefined;
  onRemoveAgent: (effectiveModel: ChatModel, harness?: ModelHarness) => void;
}

function LocalAgentModelPicker(props: ModelPickerProps): JSX.Element {
  // Registry hydration also updates Agent definitions and their display names.
  useModelCatalogStore((state) => state.snapshot);
  const selection =
    'selectionModel' in props ? props.selectionModel : props.currentModel;
  const agentId = selectedAgentId(selection);
  const definition = agentId ? resolveAgentModelDefinition(agentId) : undefined;
  const base = selection && parseAgentRouteModelId(selection)?.baseModel;
  const inheritedDefaultModel =
    props.inheritedDefaultModel && !isAgentModel(props.inheritedDefaultModel)
      ? props.inheritedDefaultModel
      : undefined;
  const effective =
    base ||
    (agentId
      ? definition?.baseModel === 'default'
        ? inheritedDefaultModel
        : definition?.baseModel
      : props.currentModel);
  const commit = (
    next: string | undefined,
    billing?: BillingFramework,
    harness?: ModelHarness,
  ): void => {
    if (next !== undefined) props.onModelChange(next, billing, harness);
    else if (props.allowWorkspaceDefault)
      props.onModelChange(undefined, billing, harness);
  };
  const compose = (next: string): string =>
    isAgentModel(next)
      ? next
      : (changeSelectedModel(definition ? selection : undefined, next) ?? next);
  const concreteChange = (
    next: string | undefined,
    billing?: BillingFramework,
    harness?: ModelHarness,
  ): void => {
    commit(
      next === undefined ? changeSelectedModel(selection, next) : compose(next),
      billing,
      harness,
    );
  };
  const concreteProps: ModelPickerProps =
    agentId || props.allowWorkspaceDefault
      ? {
          ...props,
          currentModel: effective ?? '',
          allowWorkspaceDefault: true,
          onModelChange: concreteChange,
        }
      : {
          ...props,
          currentModel: effective ?? '',
          allowWorkspaceDefault: false,
          onModelChange: concreteChange,
        };
  return (
    <ConcreteModelPicker
      {...concreteProps}
      hideAgents
      agentSelection={{
        selection,
        effectiveModel: effective,
        onRemoveAgent: (next, harness): void =>
          commit(next, undefined, harness),
      }}
      workspaceDefaultLabel={
        agentId ? 'Use agent default' : props.workspaceDefaultLabel
      }
      {...(props.auto && agentId
        ? {
            auto: {
              ...props.auto,
              unavailableReason: 'Remove the agent to use Auto',
              unavailableAction: undefined,
              onSelect: (): void => undefined,
            },
          }
        : {})}
      {...(props.onRecoveryCommit
        ? {
            onRecoveryCommit: (
              next: ChatModel,
              billing?: BillingFramework,
              harness?: ModelHarness,
              isStillWanted?: ModelRecoveryFreshness,
              retainContinuation?: () => () => void,
            ): Promise<boolean> =>
              (isStillWanted
                ? props.onRecoveryCommit?.(
                    compose(next),
                    billing,
                    harness,
                    isStillWanted,
                    retainContinuation,
                  )
                : props.onRecoveryCommit?.(compose(next), billing, harness)) ??
              Promise.resolve(false),
          }
        : {})}
      {...(props.onStartNewChat
        ? {
            onStartNewChat: (
              next: ChatModel,
              billing?: BillingFramework,
            ): void => props.onStartNewChat?.(compose(next), billing),
          }
        : {})}
    />
  );
}

interface RecoveryEpisode {
  readonly pending: PendingModelRecovery;
  readonly epoch: number;
  readonly chatKey: string | undefined;
  readonly scope: AiCreditsScopeRequest | undefined;
  readonly lease: ModelRecoveryLease;
  readonly isCurrent: ModelRecoveryFreshness;
  readonly retainSelection: () => void;
  readonly retainContinuation: () => () => void;
  readonly complete: () => void;
  readonly isAdmitted: () => boolean;
  readonly dismiss: () => void;
  readonly changeModel: (model: ChatModel) => void;
  readonly commit: ((model: ChatModel) => Promise<boolean>) | undefined;
  readonly changeBilling: ModelPickerBillingProps['onChange'] | undefined;
  readonly startNewChat: ModelPickerProps['onStartNewChat'];
  readonly selectedBilling: BillingFramework | undefined;
  readonly fallbackBindings: Pick<
    ModelPickerProps,
    'onModelChange' | 'onRecoveryCommit'
  >;
}

function ConcreteModelPicker(
  props: ModelPickerProps & { agentSelection?: LocalAgentSelection },
): JSX.Element {
  const { agentSelection } = props;
  const {
    currentModel,
    lockedProvider,
    lockedProviderBehavior = 'disabled',
    lockedProviderReason,
    lockedHarness,
    executionHarness,
    executionHarnessExplicitlyChosen,
    hideLabel = false,
    disabled = false,
    capsule = false,
    menuAlignOffset,
    menuAlignRef,
    menuAlignEdge,
    allowTriggerShrink,
    foldTriggerIconWhenTight,
    foldTriggerIconOnTruncate,
    hideTriggerChevron,
    hideAgents = false,
    inheritedDefaultModel,
    placeholderLabel,
    triggerTooltip,
    providerAvailability,
    billing,
    browserLayout,
    openSignal,
    externalTriggerRef,
    onRestoreFocus,
    onStartNewChat,
    recoveryChatKey,
    onRecoveryCommit,
    ownerDocument,
    auto,
    aiCreditsScope,
  } = props;
  const antigravityReleased = useFeatureFlagsStore(
    isAntigravityHarnessReleased,
  );
  const antigravityHarnessEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarness.key),
  );
  const cursorReleased = useFeatureFlagsStore(isCursorHarnessReleased);
  const opencodeEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key),
  );
  const copilotEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key),
  );
  const opencodeAvailable = useOpenCodeChatAvailable(
    props.allowOpenCode === true,
  );
  const copilotAvailable = useCopilotChatAvailable(props.allowCopilot === true);
  const cursorAvailable = useCursorChatAvailable(props.allowCursor === true);
  const separateVendorTabs = browserLayout === 'harnesses';
  // The harness browser sets billing from each model's own menu, Auto
  // included, so the chat-wide footer is for the single list only.
  const showBillingFooter = billing !== undefined && !separateVendorTabs;
  // The harness layout has no chat-wide toggle, but must still expose the
  // existing provider remedy when confirmed sign-out locks billing to credits.
  const showBillingSignIn =
    billing?.disabled === true &&
    billing.lockKind === 'no-native-login' &&
    (billing.provider === 'claude' || billing.provider === 'codex');
  /**
   * CAN-3026 — is the saved Canopy Cloud credential a guest?
   *
   * Read IN-COMPONENT rather than taken as a prop: guest-ness is a session
   * fact, and none of this component's eight call sites knows it better than
   * the account store. The hook is already event-driven on
   * `CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT`, so a sign-in anywhere re-resolves
   * every row without further plumbing.
   */
  const isGuest = useIsGuestCredential();
  /**
   * CAN-4028 — model-library access for the owner of THIS chat's work.
   *
   * Read only where rows can be gated at all (`providerAvailability` present),
   * so the five configuration surfaces issue no reads. `undefined` is unknown,
   * which the gate renders as no purchase lock: organization-owned work lands
   * there today, and the server still enforces it.
   */
  const libraryAccess = useWorkModelLibraryAccess(
    aiCreditsScope,
    providerAvailability !== undefined,
  );
  /** CAN-5213 — the lock that applies to this work's owner, if any. */
  const viewerLibraryLock =
    providerAvailability === undefined
      ? undefined
      : resolveModelLibraryLock(isGuest, libraryAccess);
  // CAN-5028 — the access describes the personal wallet, so organization-owned
  // work forwards none. The credits tag always reads `AI Credits` (CAN-4769).
  const libraryLabelAccess = useComposerWorkIsPersonal(
    aiCreditsScope?.kind === 'work' ? aiCreditsScope.projectId : undefined,
  )
    ? libraryAccess
    : undefined;
  // Row admission describes the chosen route, not the latest auth probe. An
  // explicit subscription choice must not be relabeled as hosted credits or
  // blocked by the hosted library gate when a negative probe may be wrong.
  // Main still validates the native attempt and provides its real recovery.
  const rowGateAvailability = useMemo<ProviderAvailability | undefined>(() => {
    if (
      !providerAvailability ||
      billing?.value !== 'subscription' ||
      billing.allowUnverifiedSubscription !== true ||
      (billing.provider !== 'claude' && billing.provider !== 'codex')
    ) {
      return providerAvailability;
    }
    return {
      ...providerAvailability,
      [billing.provider]: {
        ...providerAvailability[billing.provider],
        nativeAuth: true,
      },
    };
  }, [
    providerAvailability,
    billing?.value,
    billing?.provider,
    billing?.allowUnverifiedSubscription,
  ]);
  const [cursorMenuOpen, setCursorMenuOpen] = useState(false);
  const [harnessMenuOpen, setHarnessMenuOpen] = useState(false);
  const harnessButtonRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const harnessPickerId = useId();
  const allowWorkspaceDefault = props.allowWorkspaceDefault === true;
  // Re-render on authoritative harness-assignment changes so locked-harness
  // filtering and gateway grouping always reflect main's newest snapshot. Also
  // a dependency of the row-gate memo below: assignments feed
  // `getExecutionHarnessForModel`, so a reassignment has to re-resolve the rows.
  const harnessAssignments = useModelCatalogStore(
    (state) => state.harnessAssignments,
  );
  const [billingLoginProvider, setBillingLoginProvider] = useState<
    'claude' | 'codex' | null
  >(null);
  const [recoveryEpisode, setRecoveryEpisode] =
    useState<RecoveryEpisode | null>(null);
  const episodeRef = useRef<RecoveryEpisode | null>(null);
  const recoveryEpochRef = useRef(0);
  const ownedLeasesRef = useRef(new Set<ModelRecoveryLease>());
  const ownedEpisodesRef = useRef(new Set<RecoveryEpisode>());
  const creditsEpisodeRef = useRef<RecoveryEpisode | null>(null);
  const localRecoveryKey = useId();
  const recoveryTargetKey = props.recoveryTarget?.key ?? localRecoveryKey;
  const pendingRecovery = recoveryEpisode?.pending ?? null;
  const pendingRecoveryAction = pendingRecovery?.intent ?? 'select-model';
  const recoveryAttempt = recoveryEpisode?.epoch ?? 0;
  const recoveryAiCreditsScope = recoveryEpisode?.scope;
  const recoveryChatKeyRef = useRef<string | undefined>(undefined);
  const beginSelectionCommand = useCallback((): void => {
    supersedeModelRecovery(recoveryTargetKey);
    for (const lease of ownedLeasesRef.current) {
      if (!lease.isCurrent()) ownedLeasesRef.current.delete(lease);
    }
    recoveryEpochRef.current += 1;
    episodeRef.current = null;
    setRecoveryEpisode(null);
  }, [recoveryTargetKey]);
  // Hoisted from `ModelGroup` + `AgentModelGroup`: one subscription instead of
  // two, and the gate is now evaluated once per row rather than once to filter
  // and again to render.
  const modelPolicy = useModelCatalogStore((s) => s.policy);
  const modelGatewayEnforced = useModelCatalogStore(
    (s) => s.modelGatewayEnforced,
  );
  const personalOwner = useModelCatalogStore(
    (s) => s.activeOwner?.kind === 'personal',
  );
  /** The active owner's organization, named in policy and gateway copy. */
  const activeOrganizationName = useModelCatalogStore(
    (s) => s.activeOrganizationName,
  );
  /**
   * The active owner's organization when the viewer is its OWNER or ADMIN,
   * who may manage its model policy. The owner ID is the workspace context's
   * organization ID, the same one the settings routes take.
   */
  const policyOrganizationId = useModelCatalogStore((s) =>
    s.activeOwner?.kind === 'organization'
      ? s.activeOwner.organizationId
      : null,
  );
  // The membership's own ID, so the route takes the settings-route spelling
  // even when the catalog's owner ID differs in case.
  const managedPolicyOrganizationId = useWorkspaceContextStore((s) => {
    if (policyOrganizationId === null) return null;
    const membership = s.state.organizations.find(
      (organization) =>
        organization.id.toLowerCase() === policyOrganizationId.toLowerCase(),
    );
    return membership?.role === 'OWNER' || membership?.role === 'ADMIN'
      ? membership.id
      : null;
  });
  /**
   * Subscribed purely so the hoisted row-gate memo below re-runs when the model
   * registries change. The value itself is unused: the memo reads the module
   * registries that `applySnapshot` populates, and this is what tells React
   * they may have moved.
   */
  const catalogSnapshot = useModelCatalogStore((s) => s.snapshot);
  // The lane sync registers the account-only Codex models (CAN-4716) outside
  // the catalog snapshot, then publishes their id set; this key moves with it.
  const codexAccountModelsKey = useSyncExternalStore(
    subscribeRendererBillingLaneFacts,
    getRendererCodexAccountModelsKey,
    getRendererCodexAccountModelsKey,
  );
  const gatewayCatalogStatus = useModelCatalogStore(
    (s) => s.aiGatewayCatalogStatus,
  );
  const cursorCatalog = useCursorModels(
    cursorAvailable && !modelGatewayEnforced,
    cursorMenuOpen,
  );
  const copilotCatalog = useCopilotModels(
    copilotAvailable && !modelGatewayEnforced,
    cursorMenuOpen,
  );
  const opencodeCatalog = useOpenCodeModels(
    opencodeAvailable && !modelGatewayEnforced,
    cursorMenuOpen,
  );
  const antigravityModels = catalogSnapshot?.antigravity;
  const antigravityEnabled =
    props.allowAntigravity === true &&
    antigravityHarnessEnabled &&
    window.platform === 'darwin' &&
    !modelGatewayEnforced;
  const antigravityAvailable =
    antigravityEnabled && Boolean(antigravityModels?.length);
  const opencodeModels = opencodeCatalog.models;
  const copilotModels = copilotCatalog.models;
  const cursorModels = cursorCatalog.models;
  const managedMappings = useMemo(() => {
    void cursorModels;
    void copilotModels;
    void opencodeModels;
    void catalogSnapshot;
    return {
      cursor:
        cursorAvailable && !modelGatewayEnforced
          ? getModelPickerMappings('cursor')
          : {},
      copilot:
        copilotAvailable && !modelGatewayEnforced
          ? getModelPickerMappings('copilot')
          : {},
      opencode:
        opencodeAvailable && !modelGatewayEnforced
          ? getModelPickerMappings('opencode')
          : {},
    };
  }, [
    cursorModels,
    copilotModels,
    opencodeModels,
    catalogSnapshot,
    cursorAvailable,
    copilotAvailable,
    opencodeAvailable,
    modelGatewayEnforced,
  ]);
  const hostedHarness = lockedHarness ?? executionHarness;
  const currentProvider = currentModel
    ? (getModelSource(currentModel) === 'ai-gateway' ||
        hostedHarness === 'opencode') &&
      hostedHarness
      ? hostedHarness
      : getProviderForModel(currentModel)
    : undefined;
  // A chat stamped on a model that is gone keeps it, but shows it plainly
  // instead of its raw id. Checked only once the registry has loaded and the
  // hosted-model list is not still downloading or failed, so a hosted model
  // is not reported missing just because its list has not arrived.
  const currentModelRetired =
    currentModel !== undefined &&
    catalogSnapshot !== null &&
    gatewayCatalogStatus !== 'loading' &&
    gatewayCatalogStatus !== 'failed' &&
    !isAgentModel(currentModel) &&
    resolveKnownModel(currentModel) === undefined;
  const currentModelLabel = currentModel
    ? currentModelRetired
      ? RETIRED_MODEL_LABEL
      : getModelDisplayName(currentModel)
    : (placeholderLabel ?? WORKSPACE_DEFAULT_LABEL);

  /**
   * CAN-2349 §2 — evaluate every gate ONCE, here.
   *
   * This is what makes the case-E hidden count and the group-header drop
   * possible without evaluating the gate twice (filter, then render), which is
   * exactly how the two quietly drift apart. `ModelGroup`/`AgentModelGroup` are
   * now `.map`s over already-resolved rows and carry no gating arithmetic.
   */
  const rowGroups = useMemo((): {
    agentRows: readonly ModelRow[];
    recoveryRows: readonly ModelRow[];
    providerGroups: readonly ModelRowGroup[];
    favoriteModelAliases: ReadonlyMap<string, string>;
    /**
     * Hidden rows, per cause. Counted apart rather than summed: the two have
     * different copy, and only one of them names a remedy.
     */
    hiddenRows: { notBillableToCredits: number; orgGatewayOnly: number };
  } => {
    // Read purely to declare the dependency. The rows below come from the
    // MUTABLE module registries that `applySnapshot` fills, so the snapshot
    // identity — not its contents — is what tells this memo they may have
    // changed. Referencing it here keeps the dep honest rather than suppressing
    // the exhaustive-deps warning it would otherwise raise.
    void catalogSnapshot;
    // Same story for the authoritative harness assignments: they land in the
    // module registry that `getExecutionHarnessForModel` reads inside the gate.
    void harnessAssignments;
    // And for the account-only Codex models (CAN-4716) in CODEX_ACCOUNT_MODELS.
    void codexAccountModelsKey;
    // LOAD-BEARING (§"don't arm the five config surfaces"): a gate may only
    // resolve to `recoverable` when the caller passes `providerAvailability`.
    // Those five surfaces write a CONFIG value, not a chat turn.
    const gatingEnabled = providerAvailability !== undefined;
    const canStartNewChat = onStartNewChat !== undefined;
    let hidden = 0;
    let orgGatewayHidden = 0;

    const resolveRow = (
      model: ChatModel,
      provider: AgentProviderType,
      staleAgent: boolean,
    ): ModelRow | null => {
      const selectedHarness =
        lockedHarness ??
        lockedProvider ??
        (separateVendorTabs &&
        currentModel &&
        getCanonicalPickerModel(currentModel) === model
          ? currentProvider
          : undefined);
      const managedId =
        selectedHarness === 'cursor' ||
        selectedHarness === 'copilot' ||
        selectedHarness === 'opencode'
          ? managedMappings[selectedHarness][model]
          : undefined;
      const runtimeModel =
        managedId ??
        (managedMappings.cursor[model] && !lockedHarness && !lockedProvider
          ? resolveDefaultChatModel(model)
          : model);
      const runtimeProvider = getProviderForModel(runtimeModel) ?? provider;
      const gate = resolveModelRowGate({
        model: runtimeModel,
        provider: runtimeProvider,
        currentModel,
        gatingEnabled,
        availability: rowGateAvailability?.[runtimeProvider],
        billingValue: billing?.value,
        lockedProvider,
        lockedProviderBehavior,
        lockedProviderReason,
        lockedHarness,
        executionHarnessExplicitlyChosen,
        canStartNewChat,
        modelPolicy,
        staleAgent,
        modelGatewayEnforced,
        organizationName: activeOrganizationName,
        personalOwner,
        isGuest,
        libraryAccess,
      });
      if (gate.kind === 'hidden') {
        if (gate.cause === 'org-gateway-only') {
          orgGatewayHidden += 1;
        } else {
          hidden += 1;
        }
        return null;
      }
      return { model, runtimeModel, provider: runtimeProvider, gate };
    };

    /**
     * Agent models (`agent_model_*`) are registry overlays that resolve to a
     * concrete provider base model at execution time, so every gating decision
     * is evaluated against the Agent's BASE model / provider. A stale Agent
     * (base model no longer in the registry) renders hard-disabled rather than
     * silently substituting a different model.
     */
    const agents: ModelRow[] = [];
    for (const model of AGENT_MODELS) {
      if (agentSelection) {
        const intended =
          changeSelectedAgent(
            agentSelection.selection,
            model,
            agentSelection.effectiveModel,
          ) ?? model;
        const route = pinInheritingAgentModel(intended, inheritedDefaultModel);
        const routeBase =
          parseAgentRouteModelId(route)?.baseModel ??
          resolveAgentModelDefinition(model)?.baseModel;
        const provider = getProviderForModel(routeBase ?? route) ?? 'claude';
        if (provider === 'antigravity' && !antigravityAvailable) continue;
        if (provider === 'cursor' && !cursorAvailable) continue;
        if (provider === 'copilot' && !copilotAvailable) continue;
        if (provider === 'opencode' && !opencodeAvailable) continue;
        const row = resolveRow(
          route,
          provider,
          !getAgentModelAvailability(route).available,
        );
        if (row) agents.push({ ...row, model, selectionModel: intended });
        continue;
      }
      if (isInheritingAgentModel(model) && inheritedDefaultModel) {
        // Describe and gate the row by the route the chat would store, but
        // send the Agent itself when it is picked.
        const route = pinInheritingAgentModel(model, inheritedDefaultModel);
        const routeProvider = getProviderForModel(route) ?? 'claude';
        if (routeProvider === 'antigravity' && !antigravityAvailable) continue;
        if (routeProvider === 'cursor' && !cursorAvailable) continue;
        if (routeProvider === 'copilot' && !copilotAvailable) continue;
        if (routeProvider === 'opencode' && !opencodeAvailable) continue;
        const row = resolveRow(
          route,
          routeProvider,
          !getAgentModelAvailability(route).available,
        );
        if (row) agents.push({ ...row, model, selectionModel: model });
        continue;
      }
      const definition = resolveAgentModelDefinition(model);
      // An inheriting Agent runs on this chat's default, so gate it like the
      // chat's current provider.
      const baseProvider: AgentProviderType = definition
        ? (getProviderForModel(definition.baseModel) ??
          (isInheritingAgentModel(model) ? currentProvider : undefined) ??
          'claude')
        : 'claude';
      if (baseProvider === 'antigravity' && !antigravityAvailable) continue;
      if (baseProvider === 'cursor' && !cursorAvailable) continue;
      if (baseProvider === 'copilot' && !copilotAvailable) continue;
      if (baseProvider === 'opencode' && !opencodeAvailable) continue;
      const row = resolveRow(
        model,
        baseProvider,
        !getAgentModelAvailability(model).available,
      );
      if (row) agents.push(row);
    }

    // API-only gateway models render as their own branded "AI Credits" source
    // group. They live in the dedicated AI_GATEWAY_MODELS registry; gateway-only
    // ids still present in the managed registries (legacy snapshots that inlined
    // them into Claude/Codex/Ollama) are regrouped here for back-compat. This is
    // presentation only — each row's execution harness comes from the
    // authoritative assignment snapshot, and routing remains model-ID based. The
    // section is sorted alphabetically by display label regardless of catalog
    // order.
    const allGatewayOnlyModels = Array.from(
      new Set(
        [
          ...AI_GATEWAY_MODELS,
          ...CLAUDE_MODELS,
          ...CODEX_MODELS,
          ...OLLAMA_MODELS,
        ].filter(isGatewayOnlyModel),
      ),
    ).sort((a, b) =>
      getModelDisplayName(a).localeCompare(getModelDisplayName(b)),
    );
    /*
     * An organization's own gateway rows are ALSO `gatewayOnly`, so without
     * this split they would render under the hosted "AI Credits" heading —
     * wrong on the facts (the org is billed by its own provider contract, not
     * by us) and a support call waiting to happen. They get their own group,
     * ordered after ours, keyed on the route's `origin`.
     */
    const gatewayOnlyModels = allGatewayOnlyModels.filter(
      (model) => orgGatewayOrganizationId(model) === undefined,
    );
    const orgGatewayModels = allGatewayOnlyModels.filter(
      (model) => orgGatewayOrganizationId(model) !== undefined,
    );

    const buildRows = (
      models: readonly ChatModel[],
      provider: AgentProviderType | undefined,
    ): ModelRow[] => {
      const rows: ModelRow[] = [];
      for (const model of models) {
        const row = resolveRow(
          model,
          provider ?? getProviderForModel(model) ?? 'claude',
          false,
        );
        if (row) rows.push(row);
      }
      return rows;
    };

    const groups: ModelRowGroup[] = [
      ...(antigravityAvailable
        ? [
            {
              key: 'antigravity',
              rows: buildRows(
                antigravityModels?.map((model) => model.id) ?? [],
                'antigravity',
              ),
            },
          ]
        : []),
      ...(opencodeAvailable
        ? [
            {
              key: 'opencode',
              rows: buildRows(
                opencodeModels.map((model) => model.id),
                'opencode',
              ),
            },
          ]
        : []),
      ...(copilotAvailable
        ? [
            {
              key: 'copilot',
              rows: buildRows(
                copilotModels.map((model) => model.id),
                'copilot',
              ),
            },
          ]
        : []),
      ...(cursorAvailable
        ? [
            {
              key: 'cursor',
              rows: buildRows(
                cursorModels.map((model) => model.id),
                'cursor',
              ),
            },
          ]
        : []),
      {
        key: 'claude',
        rows: buildRows(
          CLAUDE_MODELS.filter((m) => !isGatewayOnlyModel(m)),
          'claude',
        ),
      },
      {
        key: 'codex',
        rows: buildRows(
          [...CODEX_MODELS, ...CODEX_ACCOUNT_MODELS].filter(
            (m) => !isGatewayOnlyModel(m),
          ),
          'codex',
        ),
      },
      {
        // The owner's gateway follows native Claude and Codex, before AI Credits.
        key: 'org-gateway',
        rows: buildRows(orgGatewayModels, undefined),
      },
      {
        key: 'ai-credits',
        rows: buildRows(gatewayOnlyModels, undefined),
      },
      {
        key: 'ollama',
        rows: buildRows(
          OLLAMA_MODELS.filter((m) => !isGatewayOnlyModel(m)),
          'ollama',
        ),
      },
    ];

    const listedIds = new Set(
      groups.flatMap((group) => group.rows.map((row) => row.model)),
    );
    const favoriteModelAliases = new Map<string, string>();
    return {
      agentRows: agents,
      // Recovery follows exact account routes, including those merged into a
      // canonical display row. Hidden gates were already omitted by resolveRow.
      recoveryRows: [...agents, ...groups.flatMap((group) => group.rows)],
      favoriteModelAliases,
      providerGroups: groups.map((group) => ({
        ...group,
        rows: group.rows.filter((row) => {
          // Without account tabs, each runtime needs its own selectable row.
          if (!separateVendorTabs) return true;
          const canonical = getCanonicalPickerModel(row.model);
          if (canonical === row.model) return true;
          favoriteModelAliases.set(row.model, canonical);
          return !listedIds.has(canonical);
        }),
      })),
      hiddenRows: {
        notBillableToCredits: hidden,
        orgGatewayOnly: orgGatewayHidden,
      },
    };
  }, [
    billing?.value,
    agentSelection?.selection,
    agentSelection?.effectiveModel,
    separateVendorTabs,
    managedMappings,
    antigravityAvailable,
    antigravityModels,
    cursorAvailable,
    cursorModels,
    copilotAvailable,
    copilotModels,
    opencodeAvailable,
    opencodeModels,
    // The body reads the MUTABLE module-level registries (CLAUDE_MODELS,
    // CODEX_MODELS, OLLAMA_MODELS, AGENT_MODELS). Those used to be re-read on
    // every render inside the group components, so a registry refresh landed on
    // the next render for free; hoisting the gate into this memo removed that.
    // `hydrate`/`onModelRegistryUpdated` set `snapshot` without touching
    // `policy`, so without this dep a newly pulled Ollama model or added Agent
    // could not reach the list until some unrelated prop identity changed.
    catalogSnapshot,
    codexAccountModelsKey,
    harnessAssignments,
    currentModel,
    currentProvider,
    inheritedDefaultModel,
    lockedProvider,
    lockedProviderBehavior,
    lockedProviderReason,
    lockedHarness,
    executionHarnessExplicitlyChosen,
    modelPolicy,
    modelGatewayEnforced,
    activeOrganizationName,
    personalOwner,
    isGuest,
    libraryAccess,
    onStartNewChat,
    providerAvailability,
    rowGateAvailability,
  ]);

  const {
    agentRows,
    recoveryRows,
    providerGroups,
    hiddenRows,
    favoriteModelAliases,
  } = rowGroups;
  const visibleRows = useMemo<readonly ModelRow[]>(
    () => [
      ...(!hideAgents ? agentRows : []),
      ...providerGroups.flatMap((group) => group.rows),
    ],
    [agentRows, hideAgents, providerGroups],
  );
  const catalog = useMemo<ModelCatalog>(() => {
    const nativeSortCeiling = Math.max(
      0,
      ...[
        ...(catalogSnapshot?.claude ?? []),
        ...(catalogSnapshot?.codex ?? []),
      ].map((model) => model.sortOrder ?? 0),
    );
    return visibleRows.map((row) => {
      const organizationId = orgGatewayOrganizationId(row.model);
      return organizationId === undefined
        ? rowToCatalogOption(row)
        : {
            ...orgRowToCatalogOption(row, organizationId),
            sortOrder: nativeSortCeiling + 0.5,
          };
    });
  }, [visibleRows, catalogSnapshot]);

  /**
   * Heading text for each org-gateway section. The vendor key is synthetic, so
   * the menu has no catalog-derived label to fall back on — without this the
   * section renders with a generic heading and the whole point of grouping the
   * org's rows separately is lost.
   */
  const vendorLabels = useMemo<Record<string, string>>(() => {
    const labels: Record<string, string> = {};
    for (const route of catalogSnapshot?.gatewayRoutes ?? []) {
      if (route.origin !== 'org-gateway' || !route.organizationId) continue;
      const model = (catalogSnapshot?.aiGatewayModels ?? []).find(
        (entry) => entry.id === route.modelId,
      );
      labels[orgVendorKey(route.organizationId)] =
        model?.familyLabel ??
        getModelFamilyMetadata(route.modelId)?.familyLabel ??
        'Your organization';
    }
    return labels;
  }, [catalogSnapshot]);
  const hasAgentSelection = agentSelection !== undefined;
  const rowById = useMemo<ReadonlyMap<string, ModelRow>>(
    () =>
      new Map([
        ...visibleRows.map((row): [string, ModelRow] => [row.model, row]),
        ...(hasAgentSelection
          ? agentRows.map((row): [string, ModelRow] => [row.model, row])
          : []),
      ]),
    [visibleRows, agentRows, hasAgentSelection],
  );
  // Separate Agent controls still need catalog metadata for harness admission.
  const catalogById = useMemo<ReadonlyMap<string, ModelCatalogOption>>(
    () =>
      new Map([
        ...catalog.map((option): [string, ModelCatalogOption] => [
          option.id,
          option,
        ]),
        ...(hasAgentSelection
          ? agentRows.map((row): [string, ModelCatalogOption] => [
              row.model,
              rowToCatalogOption(row),
            ])
          : []),
      ]),
    [catalog, agentRows, hasAgentSelection],
  );
  /**
   * One rail tab per connected AI gateway, Personal or organization, listing
   * the rows it serves (CAN-6444). A preset gateway shows its own icon; a
   * custom one the generic gateway glyph.
   */
  const gatewayTabs = useMemo<readonly ModelPickerGatewayTab[]>(() => {
    const byOrganization = new Map<
      string,
      { baseUrl: string | undefined; modelIds: string[] }
    >();
    for (const route of catalogSnapshot?.gatewayRoutes ?? []) {
      if (route.origin !== 'org-gateway' || !route.organizationId) continue;
      if (!rowById.has(route.modelId)) continue;
      const gateway = byOrganization.get(route.organizationId) ?? {
        baseUrl: route.baseUrl,
        modelIds: [],
      };
      gateway.modelIds.push(route.modelId);
      byOrganization.set(route.organizationId, gateway);
    }
    return Array.from(byOrganization, ([organizationId, gateway]) => {
      const iconProvider = matchAiGatewayPreset(gateway.baseUrl)?.id;
      return {
        id: `gateway:${organizationId}` as const,
        label: vendorLabels[orgVendorKey(organizationId)] ?? 'AI gateway',
        ...(iconProvider ? { iconProvider } : {}),
        modelIds: gateway.modelIds,
      };
    });
  }, [catalogSnapshot, rowById, vendorLabels]);
  // Whether any model outside the user's AI gateways can run here, judged by
  // the same row gates the picker shows: native Claude and Codex, credits,
  // Ollama, Cursor, Copilot and OpenCode alike. A gate still loading reads as
  // available, so a probe in flight never moves the picker.
  const builtInRunnable = useMemo(
    () =>
      visibleRows.some(
        (row) =>
          orgGatewayOrganizationId(row.model) === undefined &&
          !isAgentModel(row.model) &&
          row.gate.kind === 'available',
      ),
    [visibleRows],
  );
  const preferredTab = preferredGatewayTabId({
    gatewayTabs,
    currentModel,
    builtInRunnable,
  });
  /**
   * Why the chat's current model can't run for this account, from the same
   * row gate the picker rows use (CAN-6444): a signed-out harness with no AI
   * Credits, or a model the library needs an account or purchase for. The chip
   * warns before send instead of the turn failing after it.
   */
  const currentModelUnavailableReason = useMemo(() => {
    const gate = currentModel ? rowById.get(currentModel)?.gate : undefined;
    if (gate?.kind !== 'recoverable') return undefined;
    if (gate.recovery.kind === 'needs-billing-source')
      return MODEL_PICKER_ROW_CUE_COPY.needsBillingSourceHint(
        getProviderLabel(gate.recovery.provider),
      );
    return libraryLockCopy(gate.recovery)?.hint;
  }, [currentModel, rowById]);
  // A native model can have two billing routes without changing its source
  // identity. Hosted picks use the canonical model, never a Cursor default.
  const creditsRows = useMemo(() => {
    const rows = new Map<string, ModelRow>();
    for (const row of visibleRows) {
      const gateModel =
        row.selectionModel === undefined ? row.model : row.runtimeModel;
      if (
        isGatewayOnlyModel(gateModel) ||
        !isGatewayRoutableModel(gateModel) ||
        orgGatewayOrganizationId(gateModel) !== undefined
      )
        continue;
      const provider = getProviderForModel(gateModel) ?? row.provider;
      const gate =
        providerAvailability === undefined
          ? row.gate
          : resolveModelRowGate({
              model: gateModel,
              provider,
              currentModel,
              gatingEnabled: true,
              availability: providerAvailability[provider],
              billingValue: 'ai-credits',
              requireCredits: true,
              lockedProvider,
              lockedProviderBehavior,
              lockedProviderReason,
              lockedHarness,
              executionHarnessExplicitlyChosen,
              canStartNewChat: onStartNewChat !== undefined,
              modelPolicy,
              staleAgent:
                row.gate.kind === 'hard-disabled' &&
                row.gate.cause === 'stale-agent',
              modelGatewayEnforced,
              organizationName: activeOrganizationName,
              personalOwner,
              isGuest,
              libraryAccess,
            });
      if (gate.kind !== 'hidden')
        rows.set(row.model, {
          ...row,
          runtimeModel: gateModel,
          provider,
          gate,
        });
    }
    return rows;
  }, [
    visibleRows,
    providerAvailability,
    currentModel,
    lockedProvider,
    lockedProviderBehavior,
    lockedProviderReason,
    lockedHarness,
    executionHarnessExplicitlyChosen,
    onStartNewChat,
    modelPolicy,
    modelGatewayEnforced,
    activeOrganizationName,
    personalOwner,
    isGuest,
    libraryAccess,
  ]);
  const creditsModelIds = useMemo(
    () => new Set(creditsRows.keys()),
    [creditsRows],
  );
  /**
   * Native models this chat will run on AI Credits: every credits-routable one
   * while the chat pays with credits, otherwise those whose own harness is not
   * signed in. Their rows say AI credits, not nothing. An empty balance does
   * not change the route, only whether it can pay (CAN-5213); an inconclusive
   * credits read proves neither.
   */
  const creditsRoutedModelIds = useMemo((): ReadonlySet<string> => {
    const routed = new Set<string>();
    for (const option of catalog) {
      if (!creditsModelIds.has(option.id)) continue;
      const harness = option.source ?? option.provider;
      const availability =
        harness === 'claude' || harness === 'codex'
          ? providerAvailability?.[harness]
          : undefined;
      if (
        billing?.value === 'ai-credits' ||
        ((billing?.value !== 'subscription' || billing.provider !== harness) &&
          availability !== undefined &&
          !availability.nativeAuth &&
          !availability.loading &&
          availability.creditsInconclusive !== true)
      ) {
        routed.add(option.id);
      }
    }
    return routed;
  }, [
    billing?.value,
    billing?.provider,
    catalog,
    creditsModelIds,
    providerAvailability,
  ]);
  /**
   * Harnesses each hosted or local model can run on, from main's assignments.
   * A model main has not described yet stays on the harness its row resolved
   * to. Native models Cursor also runs are listed under Cursor too, as the
   * same row, so the Cursor tab holds every model Cursor can run.
   */
  const harnessSupportedModelIds = useMemo<
    Record<string, readonly string[]>
  >(() => {
    const byHarness: Record<string, string[]> = {};
    // A started chat cannot re-assign a model's harness (main runs it on its
    // assignment), so list each hosted model only under the harness it will
    // actually run on; a new chat may still pick any available one.
    const chatStarted =
      lockedHarness !== undefined || lockedProvider !== undefined;
    for (const option of catalog) {
      for (const choice of option.harnessChoices ?? []) {
        if (choice.harness === 'opencode' && opencodeAvailable)
          (byHarness.opencode ??= []).push(option.id);
      }
      for (const harness of ['cursor', 'copilot', 'opencode'] as const) {
        if (managedMappings[harness][option.id])
          (byHarness[harness] ??= []).push(option.id);
      }
      if (option.source !== 'ai-gateway' && option.source !== 'ollama')
        continue;
      const assignment = harnessAssignments?.assignments.find(
        (candidate) => candidate.modelId === option.id,
      );
      const assigned = assignment?.harness ?? option.harness ?? option.provider;
      const harnesses = chatStarted
        ? [assigned]
        : (assignment?.availableHarnesses ?? [assigned]);
      for (const harness of harnesses) {
        (byHarness[harness] ??= []).push(option.id);
      }
    }
    return byHarness;
  }, [
    catalog,
    opencodeAvailable,
    managedMappings,
    harnessAssignments,
    lockedHarness,
    lockedProvider,
  ]);
  /**
   * The route represented by the chosen harness. Started chats re-evaluate
   * the lock so an explicit choice offers recovery or explains why it is blocked.
   * Managed harnesses run their advertised account route; native harnesses run
   * the model itself, even when Cursor is its saved default. `undefined` when that
   * choice is hidden from this chat.
   */
  const rowForHarness = useCallback(
    (
      row: ModelRow,
      harness: ModelHarness | undefined,
      harnessExplicitlyChosen = false,
    ): ModelRow | undefined => {
      const capturedOpenCode = (lockedHarness ?? lockedProvider) === 'opencode';
      if (
        capturedOpenCode &&
        !isOpenCodeModel(currentModel) &&
        harness &&
        harness !== 'opencode'
      ) {
        return {
          ...row,
          gate: {
            kind: 'hard-disabled',
            cause: 'locked-provider',
            reason: 'Start a new chat to change its execution harness.',
          },
        };
      }
      const selectedOpenCodeChoice =
        executionHarness === 'opencode' &&
        catalogById
          .get(row.model)
          ?.harnessChoices?.some((choice) => choice.harness === 'opencode');
      const selectedHarness =
        harness ??
        (capturedOpenCode || selectedOpenCodeChoice ? 'opencode' : undefined);
      if (
        selectedHarness === 'opencode' &&
        getModelSource(row.runtimeModel) !== 'opencode-managed' &&
        (!managedMappings.opencode[row.model] ||
          (capturedOpenCode && !isOpenCodeModel(currentModel)))
      ) {
        const option = catalogById.get(row.model);
        const choice = option?.harnessChoices?.find(
          (entry) => entry.harness === 'opencode',
        );
        if (!choice) return undefined;
        if (!opencodeAvailable)
          return {
            ...row,
            provider: 'opencode',
            gate: {
              kind: 'hard-disabled',
              cause: 'no-billing-source',
              reason: 'Connect OpenCode in Settings.',
            },
          };
        const fundingAvailability = providerAvailability?.claude;
        const gate = resolveModelRowGate({
          model: row.runtimeModel,
          provider: 'opencode',
          selectedHarness: 'opencode',
          currentModel,
          gatingEnabled: providerAvailability !== undefined,
          availability: fundingAvailability
            ? { ...fundingAvailability, nativeAuth: opencodeAvailable }
            : undefined,
          requireCredits: choice.funding === 'ai-credits',
          billingValue:
            choice.funding === 'ai-credits' ? 'ai-credits' : undefined,
          lockedProvider,
          lockedProviderBehavior,
          lockedProviderReason,
          lockedHarness,
          executionHarnessExplicitlyChosen,
          canStartNewChat: false,
          modelPolicy,
          staleAgent: option?.available === false,
          modelGatewayEnforced,
          organizationName: activeOrganizationName,
          personalOwner,
          isGuest,
          libraryAccess,
        });
        return gate.kind === 'hidden'
          ? undefined
          : { ...row, provider: 'opencode', gate };
      }
      if (
        !harness ||
        ((lockedHarness || lockedProvider) && !harnessExplicitlyChosen)
      )
        return row;
      const runtimeModel =
        harness === 'cursor' || harness === 'copilot' || harness === 'opencode'
          ? managedMappings[harness][row.model]
          : isCursorModel(row.runtimeModel) ||
              isCopilotModel(row.runtimeModel) ||
              isOpenCodeModel(row.runtimeModel)
            ? row.model
            : undefined;
      if (!runtimeModel || runtimeModel === row.runtimeModel) return row;
      const provider = getProviderForModel(runtimeModel) ?? row.provider;
      const gate = resolveModelRowGate({
        model: runtimeModel,
        provider,
        currentModel,
        gatingEnabled: providerAvailability !== undefined,
        availability: rowGateAvailability?.[provider],
        billingValue: billing?.value,
        lockedProvider,
        lockedProviderBehavior,
        lockedProviderReason,
        lockedHarness,
        executionHarnessExplicitlyChosen,
        canStartNewChat: onStartNewChat !== undefined,
        modelPolicy,
        staleAgent: false,
        modelGatewayEnforced,
        organizationName: activeOrganizationName,
        personalOwner,
        isGuest,
        libraryAccess,
      });
      return gate.kind === 'hidden'
        ? undefined
        : { ...row, runtimeModel, selectionModel: undefined, provider, gate };
    },
    [
      catalogById,
      executionHarness,
      opencodeAvailable,
      activeOrganizationName,
      personalOwner,
      billing?.value,
      currentModel,
      managedMappings,
      executionHarnessExplicitlyChosen,
      isGuest,
      libraryAccess,
      lockedHarness,
      lockedProvider,
      lockedProviderBehavior,
      lockedProviderReason,
      modelGatewayEnforced,
      modelPolicy,
      onStartNewChat,
      providerAvailability,
      rowGateAvailability,
    ],
  );

  /**
   * `handleRecover` as of the latest render, for {@link lockedOptionState}.
   * It closes over props and is rebuilt every render, so the memoized option
   * state reaches it through a ref instead of taking it as a dependency.
   */
  const handleRecoverRef = useRef<
    | ((
        model: ChatModel,
        recovery: ModelRecovery,
        billingFramework?: BillingFramework,
        selectedHarness?: ModelHarness,
      ) => void)
    | null
  >(null);
  /**
   * The state of a row that is not hard-disabled: plain, or library-locked
   * (CAN-4028). A locked row stays reachable and shows the shared hint;
   * activating it starts the same recovery a click on the row always started,
   * so there is one path into the recovery modal, not two.
   */
  const lockedOptionState = useCallback(
    (
      row: ModelRow,
      billingFramework?: BillingFramework,
      selectedHarness?: ModelHarness,
    ): ModelPickerOptionState => {
      const { runtimeModel: model, gate } = row;
      const recover = (recovery: ModelRecovery) => (): void =>
        handleRecoverRef.current?.(
          model,
          recovery,
          billingFramework,
          selectedHarness,
        );
      // CAN-5213 — what the row tells a library-locked viewer. It reads the
      // gate and never changes it: selection and recovery stay as they were.
      const cue = resolveDesktopModelRowCue({
        model,
        provider: row.provider,
        agent: isAgentModel(row.model),
        gate,
        viewerLock: viewerLibraryLock,
        availability: providerAvailability?.[row.provider],
        billingValue: billingFramework ?? billing?.value,
        requireCredits: billingFramework === 'ai-credits',
      });
      if (gate.kind !== 'recoverable')
        return cue?.kind === 'available'
          ? { disabled: false, available: true }
          : { disabled: false };
      const { recovery } = gate;
      const copy =
        libraryLockCopy(recovery) ??
        (cue?.kind === 'library-lock'
          ? libraryLockCopy(libraryRecoveryFor(cue.access))
          : undefined);
      if (copy !== undefined)
        return {
          disabled: false,
          locked: {
            ...copy,
            onUnlock: recover(recovery),
            // A lock the gate did not draw keeps the row where it was.
            ...(cue?.kind === 'library-lock' ? { keepsOrder: true } : {}),
          },
        };
      if (cue?.kind === 'needs-provider-sign-in')
        return {
          disabled: false,
          locked: {
            hint: MODEL_PICKER_ROW_CUE_COPY.needsProviderSignInHint(
              cue.providerLabel,
            ),
            label: MODEL_PICKER_ROW_CUE_COPY.needsProviderSignIn,
            onUnlock: recover(recovery),
            keepsOrder: true,
          },
        };
      // CAN-6444 — a built-in model this account can't bill (its harness is
      // signed out and AI Credits can't pay) looked runnable until it was
      // picked. It now shows the lock, with no label repeated on every row,
      // and sinks below the models that can run; a click still opens the same
      // recovery.
      if (recovery.kind === 'needs-billing-source')
        return {
          disabled: false,
          locked: {
            hint: MODEL_PICKER_ROW_CUE_COPY.needsBillingSourceHint(
              getProviderLabel(recovery.provider),
            ),
            onUnlock: recover(recovery),
          },
        };
      return { disabled: false };
    },
    [billing?.value, providerAvailability, viewerLibraryLock],
  );

  const getCreditsOptionState = (
    option: ModelCatalogOption,
    selection?: ModelPickerSelectionContext,
  ): ModelPickerOptionState => {
    const row = creditsRows.get(option.id);
    // Credits-only rows have no separate credits route; they always bill to
    // AI Credits, so their normal row state applies. Managed account picks
    // keep their account billing even when the same model has a credits route.
    if (
      (!row && rowById.has(option.id)) ||
      ['cursor', 'copilot', 'opencode'].includes(selection?.harness ?? '')
    )
      return getOptionState(option, selection);
    if (!row)
      return { disabled: true, unavailableReason: 'Model unavailable.' };
    if (row.gate.kind === 'hard-disabled')
      return { disabled: true, unavailableReason: row.gate.reason };
    return lockedOptionState(row, 'ai-credits');
  };

  const getOptionState = useCallback(
    (
      option: ModelCatalogOption,
      selection?: ModelPickerSelectionContext,
    ): ModelPickerOptionState => {
      const listed = rowById.get(option.id);
      // A row picked for another harness runs that harness's model.
      const row = listed
        ? rowForHarness(
            listed,
            toModelHarness(selection?.harness),
            selection?.harnessExplicitlyChosen,
          )
        : undefined;
      if (!row) {
        return { disabled: true, unavailableReason: 'Model unavailable.' };
      }
      // `hard-disabled` is answered first, so an organization policy or a
      // provider restriction keeps its own reason and is never dressed up as
      // something a purchase could fix.
      if (row.gate.kind === 'hard-disabled')
        return { disabled: true, unavailableReason: row.gate.reason };
      return lockedOptionState(
        row,
        undefined,
        toModelHarness(selection?.harness) ??
          (row.provider === 'opencode' && !isOpenCodeModel(row.runtimeModel)
            ? 'opencode'
            : undefined),
      );
    },
    [lockedOptionState, rowById, rowForHarness],
  );

  /**
   * Auto's candidate count is resolved from the rows this picker is ACTUALLY
   * showing, after every harness, lane, policy, and availability gate. Reading
   * the raw catalog instead would offer Auto on a surface where exactly one
   * model can run, and every turn would then fall back to it.
   *
   * Agent rows are excluded: a custom Agent is not a routable candidate.
   */
  const autoOption = useMemo<ModelPickerAutoOption | undefined>(() => {
    if (!auto) return undefined;
    if (hostedHarness === 'opencode' || currentProvider === 'opencode') {
      const reason =
        auto.unavailableReason ??
        managedOpenCodeAutoUnavailableReason(
          catalog.find((option) => option.id === currentModel),
          catalog.filter((option) => {
            const state = getOptionState(option, { harness: 'opencode' });
            return !state.disabled && !state.locked;
          }),
        );
      return {
        ...auto,
        unavailableReason: reason,
        unavailableAction: auto.unavailableReason
          ? auto.unavailableAction
          : undefined,
      };
    }
    const candidateCount = catalog.filter(
      (option) =>
        option.kind !== 'agent' &&
        rowById.get(option.id)?.gate.kind !== 'hard-disabled',
    ).length;
    const unavailableReason =
      auto.unavailableReason ??
      (candidateCount < 2
        ? MODEL_PICKER_AUTO_REASONS.tooFewCandidates
        : undefined);
    return {
      selected: auto.selected,
      onSelect: (): void => {
        beginSelectionCommand();
        auto.onSelect();
      },
      ...(unavailableReason ? { unavailableReason } : {}),
      // The action fixes the host's reason only; a candidate-count reason has
      // nothing to open.
      ...(auto.unavailableReason && auto.unavailableAction
        ? { unavailableAction: auto.unavailableAction }
        : {}),
      ...(auto.hideWhenUnavailable ? { hideWhenUnavailable: true } : {}),
    };
  }, [
    auto,
    beginSelectionCommand,
    catalog,
    currentProvider,
    currentModel,
    getOptionState,
    hostedHarness,
    rowById,
  ]);

  /**
   * A recoverable row was clicked. Close the dropdown (not via `closeMenu` —
   * focus belongs to the modal now, not the composer) and snapshot the
   * recovery resolved at THIS moment. The modal never re-derives its branch
   * from live props; see §4.
   */
  const startRecovery = (
    pending: PendingModelRecovery,
    billingFramework?: BillingFramework,
    selectedHarness?: ModelHarness,
    transferred?: RecoveryEpisode,
    showModal = true,
  ): RecoveryEpisode | undefined => {
    if (!transferred) beginSelectionCommand();
    const target = props.recoveryTarget;
    const lease =
      transferred?.lease ??
      acquireModelRecoveryLease(
        target ?? {
          key: recoveryTargetKey,
          capture: (): undefined => undefined,
        },
        (): void => {
          ownedLeasesRef.current.delete(lease);
          for (const owned of ownedEpisodesRef.current)
            if (owned.lease === lease) ownedEpisodesRef.current.delete(owned);
        },
      );
    if (!lease.isCurrent()) return undefined;
    ownedLeasesRef.current.add(lease);
    const bindings = transferred?.fallbackBindings ?? {
      onModelChange: props.onModelChange,
      onRecoveryCommit,
    };
    const epoch = ++recoveryEpochRef.current;
    const chatKey = transferred?.chatKey ?? recoveryChatKey;
    let checkoutStarted = false;
    let continuationHeld = false;
    const retainContinuation = (): (() => void) => {
      continuationHeld = true;
      return lease.revoke;
    };
    const isAdmitted = (): boolean => {
      const live = livePickerRef.current;
      if (!live.mounted) return false;
      // Another chat's catalog/disabled state cannot retire the source chat.
      if (live.chatKey !== chatKey) return true;
      const row = live.rows.find(
        (candidate) =>
          candidate.model === pending.model ||
          candidate.runtimeModel === pending.model,
      );
      return (
        !live.disabled &&
        row !== undefined &&
        !(
          row.gate.kind === 'hard-disabled' &&
          (row.gate.cause === 'org-policy' || row.gate.cause === 'stale-agent')
        )
      );
    };
    const isCurrent: ModelRecoveryFreshness = (requestId): boolean => {
      if (!isAdmitted()) lease.revoke();
      return lease.isCurrent(requestId);
    };
    const episode: RecoveryEpisode = {
      pending,
      epoch,
      chatKey,
      lease,
      isCurrent,
      isAdmitted,
      retainContinuation,
      complete: (): void => {
        checkoutStarted = false;
        if (!continuationHeld) lease.revoke();
      },
      scope: transferred?.scope ?? aiCreditsScope,
      retainSelection: (): void => {
        checkoutStarted = true;
      },
      dismiss: (): void => {
        if (!checkoutStarted && !continuationHeld) lease.revoke();
      },
      fallbackBindings: bindings,
      changeBilling: transferred?.changeBilling ?? billing?.onChange,
      startNewChat: transferred?.startNewChat ?? onStartNewChat,
      selectedBilling: billingFramework,
      changeModel: (model): void => {
        if (selectedHarness !== undefined)
          bindings.onModelChange(model, billingFramework, selectedHarness);
        else if (billingFramework !== undefined)
          bindings.onModelChange(model, billingFramework);
        else bindings.onModelChange(model);
      },
      commit: bindings.onRecoveryCommit
        ? (model): Promise<boolean> => {
            if (target)
              return (
                bindings.onRecoveryCommit?.(
                  model,
                  billingFramework,
                  selectedHarness,
                  isCurrent,
                  retainContinuation,
                ) ?? Promise.resolve(false)
              );
            if (selectedHarness !== undefined)
              return (
                bindings.onRecoveryCommit?.(
                  model,
                  billingFramework,
                  selectedHarness,
                ) ?? Promise.resolve(false)
              );
            if (billingFramework !== undefined)
              return (
                bindings.onRecoveryCommit?.(model, billingFramework) ??
                Promise.resolve(false)
              );
            return bindings.onRecoveryCommit?.(model) ?? Promise.resolve(false);
          }
        : undefined,
    };
    ownedEpisodesRef.current.add(episode);
    if (showModal) {
      recoveryChatKeyRef.current = chatKey;
      episodeRef.current = episode;
      setRecoveryEpisode(episode);
    }
    return episode;
  };
  const handleRecover = (
    model: ChatModel,
    recovery: ModelRecovery,
    billingFramework?: BillingFramework,
    selectedHarness?: ModelHarness,
  ): void => {
    const guestFallback =
      recovery.kind === 'needs-account'
        ? resolveGuestModelFallback({
            gatedModel: model,
            currentModel,
            rows: recoveryRows,
          })
        : undefined;
    startRecovery(
      { model, recovery, ...(guestFallback ? { guestFallback } : {}) },
      billingFramework,
      selectedHarness,
    );
  };
  handleRecoverRef.current = handleRecover;

  /**
   * The harness a pick names, unless it is the one this chat already runs on.
   * A pick on the captured harness can use the canonical implicit selection;
   * a different choice carries its harness for admission and persistence.
   */
  const pickedHarness = (
    selection?: ModelPickerSelectionContext,
  ): ModelHarness | undefined => {
    const harness = toModelHarness(selection?.harness);
    return harness !== undefined &&
      harness === (lockedHarness ?? lockedProvider)
      ? undefined
      : harness;
  };

  const handleSelectModel = (
    modelId: string,
    selection?: ModelPickerSelectionContext,
  ): ModelPickerSelectionDisposition => {
    const listed = rowById.get(modelId);
    if (!listed) return 'close';
    const row = rowForHarness(
      listed,
      toModelHarness(selection?.harness),
      selection?.harnessExplicitlyChosen,
    );
    if (!row) return 'dismiss';
    const selected = row.selectionModel ?? row.runtimeModel;
    if (row.gate.kind === 'recoverable') {
      handleRecover(
        row.runtimeModel,
        row.gate.recovery,
        undefined,
        toModelHarness(selection?.harness),
      );
      return 'dismiss';
    }
    if (row.gate.kind === 'hard-disabled') return 'dismiss';
    beginSelectionCommand();
    // Cursor's copy and a native model already name where they run; only a
    // hosted or local model is told its harness.
    const option = catalogById.get(modelId);
    const source = option?.source;
    const selectedHarness = toModelHarness(selection?.harness);
    const returningFromOpenCode =
      (hostedHarness === 'opencode' || currentProvider === 'opencode') &&
      !isOpenCodeModel(currentModel);
    const openCodeChoice = option?.harnessChoices?.some(
      (choice) => choice.harness === 'opencode',
    );
    let harness: ModelHarness | undefined;
    if (returningFromOpenCode) {
      if (selectedHarness) harness = pickedHarness(selection);
      else if (!openCodeChoice)
        harness = getExecutionHarnessForModel(row.runtimeModel);
    } else if (
      !isCursorModel(row.runtimeModel) &&
      !isCopilotModel(row.runtimeModel) &&
      !isOpenCodeModel(row.runtimeModel) &&
      (source === 'ai-gateway' ||
        source === 'ollama' ||
        selectedHarness === 'opencode')
    ) {
      harness = pickedHarness(selection);
    }
    // Agent changes name a new route, so the setter cannot infer the old pin.
    if (
      agentSelection &&
      isAgentModel(modelId) &&
      executionHarnessExplicitlyChosen === true &&
      selectedHarness
    )
      harness = selectedHarness;
    if (harness) props.onModelChange(selected, undefined, harness);
    else props.onModelChange(selected);
    return 'close';
  };

  const handleSelectCredits = (
    modelId: string,
    selection?: ModelPickerSelectionContext,
  ): ModelPickerSelectionDisposition => {
    // Configuration pickers select a model id; they do not govern billing.
    // Managed account routes retain their own billing.
    if (
      providerAvailability === undefined ||
      ['cursor', 'copilot', 'opencode'].includes(selection?.harness ?? '')
    )
      return handleSelectModel(modelId, selection);
    const row = creditsRows.get(modelId);
    if (!row) return handleSelectModel(modelId, selection);
    if (row.gate.kind === 'recoverable') {
      handleRecover(row.runtimeModel, row.gate.recovery, 'ai-credits');
      return 'dismiss';
    }
    if (row.gate.kind === 'hard-disabled') return 'dismiss';
    beginSelectionCommand();
    // Credits rows are native models, which name their own harness.
    props.onModelChange(row.model, 'ai-credits');
    return 'close';
  };

  /**
   * Why the organization left nothing to pick, if it did. Every listed row
   * must be blocked by the organization itself. The gateway case also needs
   * the hosted-model list to have arrived: before it does, every row is
   * blocked the same way, and that is loading, not empty.
   */
  const organizationEmptiedList = ((): 'gateway' | 'policy' | undefined => {
    const rows = Array.from(rowById.values());
    const blockedBy = (cause: 'org-gateway' | 'org-policy'): boolean =>
      rows.every(
        (row) => row.gate.kind === 'hard-disabled' && row.gate.cause === cause,
      );
    if (
      modelGatewayEnforced &&
      hasHydratedGatewayCatalog() &&
      blockedBy('org-gateway')
    )
      return 'gateway';
    if (modelPolicy.size > 0 && blockedBy('org-policy')) return 'policy';
    return undefined;
  })();
  // A locked subscription value is only a display default until the user
  // confirms it. Keep the existing row action reachable when a negative probe
  // would otherwise prevent dispatch; never turn this into a credits opt-in.
  const canConfirmSubscription =
    billing?.disabled === true &&
    billing.value === 'subscription' &&
    (billing.provider === 'claude' || billing.provider === 'codex') &&
    billing.lockKind === 'no-credits' &&
    billing.allowUnverifiedSubscription !== true &&
    providerAvailability?.[billing.provider]?.nativeAuth === false &&
    !modelGatewayEnforced &&
    currentModel !== undefined &&
    !isGatewayOnlyModel(currentModel) &&
    orgGatewayOrganizationId(currentModel) === undefined;

  /**
   * The harness browser: stars lead each row, All groups by vendor, and one
   * tab per harness. Billing in a row's menu is this chat's billing; per-model
   * billing and its limits fallback are not built yet (CAN-3365).
   */
  const lockedTab:
    | 'claude'
    | 'codex'
    | 'cursor'
    | 'copilot'
    | 'antigravity'
    | 'opencode'
    | undefined =
    lockedHarness === 'claude' ||
    lockedHarness === 'codex' ||
    lockedHarness === 'cursor' ||
    lockedHarness === 'copilot' ||
    lockedHarness === 'opencode'
      ? lockedHarness
      : lockedProvider === 'claude' ||
          lockedProvider === 'codex' ||
          lockedProvider === 'cursor' ||
          lockedProvider === 'copilot' ||
          lockedProvider === 'opencode'
        ? lockedProvider
        : undefined;
  const harnessStatusLine = (message: string): JSX.Element => (
    <div
      role="status"
      data-testid="cursor-models-status"
      className="px-2 py-1 text-3xs leading-snug fg-secondary"
    >
      {message}
    </div>
  );
  // Pickers without harness tabs keep the discovery status in the footer.
  const footerHarnessStatus = separateVendorTabs
    ? undefined
    : cursorCatalog.message ||
      copilotCatalog.message ||
      opencodeCatalog.message;
  const harnessBrowser: Partial<
    NonNullable<ModelPickerMenuProps['harnessTabs']>
  > = {
    gatewayLayout: 'harnesses',
    chrome: 'picker',
    allModelsTab: true,
    leadingFavorites: true,
    defaultFavorites: DEFAULT_MODEL_PICKER_FAVORITES,
    favoriteModelAliases,
    creditsRoutedModelIds,
    // Hosted models that have not arrived yet show where they will appear.
    ...(gatewayCatalogStatus === 'loading' || gatewayCatalogStatus === 'failed'
      ? {
          gatewayCatalog: {
            status: gatewayCatalogStatus,
            onRetry: (): void => {
              void useModelCatalogStore.getState().retryAiGatewayCatalog();
            },
          },
        }
      : {}),
    // A chat that cannot leave its harness opens on that harness's tab.
    ...(lockedProviderBehavior === 'disabled' && lockedTab
      ? { initialTab: lockedTab }
      : {}),
    ...(gatewayTabs.length > 0 ? { gatewayTabs } : {}),
    // When the user's gateways hold the only models they can run, open there.
    ...(preferredTab ? { preferredTab } : {}),
    // Only when the organization is the reason nothing can be picked; a
    // locked harness or a not-yet-loaded gateway list keeps its own rows.
    ...(organizationEmptiedList === 'gateway'
      ? {
          emptyCatalog: personalOwner
            ? {
                title: 'Your AI gateway has no available models',
                subtitle: 'Add a model in AI gateway settings',
              }
            : organizationGatewayEmptyCatalog(activeOrganizationName),
        }
      : organizationEmptiedList === 'policy'
        ? {
            emptyCatalog: organizationEmptyCatalog(
              activeOrganizationName,
              managedPolicyOrganizationId,
            ),
          }
        : {}),
    supportedModelIds: harnessSupportedModelIds,
    // Cursor and Copilot report their model discovery inside their own
    // sections rather than in the footer.
    harnessStatus: {
      ...(opencodeCatalog.message
        ? { opencode: harnessStatusLine(opencodeCatalog.message) }
        : {}),
      ...(cursorCatalog.message
        ? { cursor: harnessStatusLine(cursorCatalog.message) }
        : {}),
      ...(copilotCatalog.message
        ? { copilot: harnessStatusLine(copilotCatalog.message) }
        : {}),
    },
    runnableHarnesses: [
      ...(antigravityEnabled && (antigravityReleased || antigravityAvailable)
        ? [{ id: 'antigravity' as const, connected: antigravityAvailable }]
        : []),
      ...(props.allowOpenCode === true && opencodeEnabled
        ? [{ id: 'opencode' as const, connected: opencodeAvailable }]
        : []),
      {
        id: 'claude',
        connected: providerAvailability?.claude.selectable ?? true,
        connectVia: 'sign-in',
      },
      {
        id: 'codex',
        connected: providerAvailability?.codex.selectable ?? true,
        connectVia: 'sign-in',
      },
      ...(props.allowCopilot === true && copilotEnabled && !modelGatewayEnforced
        ? [{ id: 'copilot' as const, connected: copilotAvailable }]
        : []),
      // Released Cursor is discoverable before setup. Experimental Cursor
      // appears here only after connecting it in Labs.
      ...(props.allowCursor === true &&
      !modelGatewayEnforced &&
      (cursorReleased || cursorAvailable)
        ? [{ id: 'cursor' as const, connected: cursorAvailable }]
        : []),
    ],
    onConnectHarness: (harness): void => {
      if (harness === 'claude' || harness === 'codex') {
        setBillingLoginProvider(harness);
      } else if (harness === 'antigravity') {
        useNavigationStore
          .getState()
          .openSettings(getAntigravitySettingsSection());
      } else if (harness === 'cursor') {
        useNavigationStore.getState().openSettings(getCursorSettingsSection());
      } else if (harness === 'copilot') {
        useNavigationStore.getState().openSettings(getCopilotSettingsSection());
      } else if (harness === 'opencode') {
        useNavigationStore
          .getState()
          .openSettings(getOpenCodeSettingsSection());
      }
    },
    onModelHarnessChange: (modelId, harness): void => {
      const next = toModelHarness(harness);
      if (next)
        void useModelCatalogStore.getState().setModelHarness(modelId, next);
    },
    ...(billing && (!billing.disabled || canConfirmSubscription)
      ? {
          billing: {
            modelIds: creditsModelIds,
            fallback: false,
            getPreference: () => ({
              payment:
                billing.value === 'ai-credits' ? 'credits' : 'subscription',
              fallback: false,
            }),
            onChange: (modelId, _harness, preference): void => {
              const next =
                preference.payment === 'credits'
                  ? 'ai-credits'
                  : 'subscription';
              if (canConfirmSubscription && next === 'ai-credits') {
                // The locked state has no confirmed credits route. Use the
                // existing recovery gate, not a direct paid routing change.
                handleSelectCredits(modelId);
                return;
              }
              if (next !== billing.value || canConfirmSubscription) {
                beginSelectionCommand();
                billing.onChange(next);
              }
            },
          },
        }
      : {}),
  };

  /**
   * The locked-provider reason for `model`'s row RIGHT NOW, or `undefined`
   * when the row is not provider-locked (including when it is not listed —
   * that is Guard 2's case, and it clears the recovery rather than refusing).
   *
   * Read at commit time rather than snapshotted with the recovery: the whole
   * point is to catch a lock that engaged WHILE the modal was open.
   *
   * COPY ONLY. It no longer decides anything: the refusal itself now comes from
   * `onRecoveryCommit`, i.e. main's verdict on the ORIGINATING chat. This just
   * supplies the row's own sentence when the picker still happens to be showing
   * that chat, so the user reads the same words the row uses.
   *
   * Still key-guarded. This component survives a chat-tab switch on some surfaces
   * (`CodeReviewModal`), and after one these gates belong to the newly active
   * chat while the captured recovery still commits to the original — so a
   * lock read here would be a verdict about a different chat, able to block a
   * perfectly valid commit. When the keys do not match we cannot see the
   * originating chat at all, so we decline to judge and let the commit through.
   *
   * A mismatch is no longer dangerous, only uninformative: the commit has
   * already been refused by then, and all this decides is whether we can quote
   * the row's sentence or must fall back to
   * {@link LOCKED_COMMIT_FALLBACK_REASON}.
   *
   * Surfaces that pass no key (the five config surfaces) never raise a
   * recovery, so they never reach this.
   */
  const findRowGate = (model: ChatModel): string | undefined => {
    if (recoveryChatKey !== recoveryChatKeyRef.current) return undefined;
    const row =
      agentRows.find((r) => r.model === model || r.runtimeModel === model) ??
      providerGroups
        .flatMap((g) => g.rows)
        .find((r) => r.model === model || r.runtimeModel === model);
    return row?.gate.kind === 'hard-disabled' &&
      row.gate.cause === 'locked-provider'
      ? row.gate.reason
      : undefined;
  };

  /**
   * Read through a ref so this callback keeps a STABLE identity.
   *
   * Every caller passes an inline arrow (`onRestoreFocus={(): void =>
   * focusEditor(editor)}`), so depending on the prop directly gives
   * `clearPendingRecovery` a new identity on each parent render — and the
   * guards below take it as an effect dependency, which would re-run them on
   * every render rather than on the state they actually watch.
   */
  const onRestoreFocusRef = useRef(onRestoreFocus);
  onRestoreFocusRef.current = onRestoreFocus;

  /**
   * Is some OTHER surface currently holding the screen?
   *
   * The recovery modal hides (`display:none`) rather than unmounting behind the
   * shared cloud gate, and the picker's own `AuthLoginModal` sits above it too.
   * Focus in either of those belongs to that dialog, so a teardown must not
   * pull the caret out from under it and into the composer.
   */
  const cloudGatePending = useCloudConnectGateStore((s) => s.pending);
  // CAN-3026 §4c — the billing-mode toggle's guest gate. Same shared
  // `CloudSyncModal` every other contextual sign-in prompt uses.
  const requestConnect = useCloudConnectGateStore((s) => s.requestConnect);
  const childSurfaceOwnsFocus =
    cloudGatePending !== null || billingLoginProvider !== null;
  const childSurfaceOwnsFocusRef = useRef(childSurfaceOwnsFocus);
  childSurfaceOwnsFocusRef.current = childSurfaceOwnsFocus;

  /**
   * Tear the pending recovery down.
   *
   * `restoreFocus` defaults to true for the user-driven cancel, where the user
   * is looking at the modal and expects the caret back. The guards pass it too,
   * but only when no child surface owns the screen: a background registry
   * broadcast or org-policy refresh landing while a sign-in dialog is open
   * would otherwise yank the caret into the composer underneath it.
   */
  const clearPendingRecovery = useCallback(
    (options: { readonly restoreFocus?: boolean } = {}): void => {
      const episode = episodeRef.current;
      episode?.dismiss();
      episodeRef.current = null;
      setRecoveryEpisode(null);
      // Retire this episode so an already-issued commit that settles after this
      // point cannot run its post-await teardown or steal focus.
      recoveryEpochRef.current += 1;
      // Focus too, and not only on the user-driven cancel: the guards below
      // unmount the same modal, and a recovery that self-cancels while focus
      // lives inside it drops focus to `<body>`, stranding a keyboard-only
      // user with no place in the composer to return to.
      if (
        (options.restoreFocus ?? true) &&
        livePickerRef.current.mounted &&
        livePickerRef.current.chatKey === recoveryChatKeyRef.current
      ) {
        onRestoreFocusRef.current?.();
      }
    },
    [],
  );

  /** Guard teardown: same clear, but never steals focus from a child surface. */
  const clearPendingRecoveryFromGuard = useCallback((): void => {
    episodeRef.current?.lease.revoke();
    clearPendingRecovery({
      restoreFocus: !childSurfaceOwnsFocusRef.current,
    });
  }, [clearPendingRecovery]);

  // Guard 1: a picker that becomes `disabled` (terminal mode) must not keep a
  // pending selection alive behind a control the user can no longer operate.
  //
  // Gated on there BEING a recovery, exactly like Guards 2 and 3. Without it
  // this fires whenever `disabled` is true at all — and since
  // `clearPendingRecovery` now moves focus, that is a focus steal rather than a
  // harmless no-op. `ChatInput` passes `disabled={isTerminalMode}`, which is
  // the bang-prefix composer mode: the moment a draft starts with `!`, every
  // render of this picker would yank the caret back into the composer.
  useEffect(() => {
    if (
      disabled &&
      pendingRecovery &&
      recoveryChatKey === recoveryEpisode?.chatKey
    ) {
      clearPendingRecoveryFromGuard();
    }
  }, [
    disabled,
    pendingRecovery,
    recoveryChatKey,
    recoveryEpisode?.chatKey,
    clearPendingRecoveryFromGuard,
  ]);

  // Guard 2: the pending route left the gated catalog entirely, for example
  // when its account removed the model or a hidden gate took effect. Display
  // deduplication must not cancel recovery for an otherwise valid account route.
  //
  // Deliberately NOT the org-policy case: a policy-blocked model resolves to
  // `hard-disabled`, which keeps rendering, so it stays listed and this guard
  // never fires for it. Guard 3 below is what covers a row that is still
  // listed but has degraded to `hard-disabled`.
  useEffect(() => {
    if (!pendingRecovery || recoveryChatKey !== recoveryEpisode?.chatKey)
      return;
    const stillListed = recoveryRows.some(
      (row) =>
        row.model === pendingRecovery.model ||
        row.runtimeModel === pendingRecovery.model,
    );
    if (!stillListed) {
      // Both captured callbacks die with the recovery that created them — the
      // whole point of holding them is that they never outlive it.
      clearPendingRecoveryFromGuard();
    }
  }, [
    pendingRecovery,
    recoveryRows,
    recoveryChatKey,
    recoveryEpisode?.chatKey,
    clearPendingRecoveryFromGuard,
  ]);

  // Guard 3: the pending row is STILL LISTED but is no longer recoverable —
  // its gate degraded to `hard-disabled` while the modal was open (an Agent's
  // base model left the registry → `stale-agent`, or a provider lock engaged →
  // `locked-provider`). Guard 2 cannot see this: the row keeps rendering, so
  // `stillListed` passes. Without this, a coverage or sign-in success commits a
  // model the picker itself would now refuse to select.
  //
  // Deliberately narrow on BOTH axes, because the failure mode of
  // over-clearing is a recovery that silently cancels itself — the dead-end
  // this ticket exists to remove:
  //
  //  - Only `hard-disabled`, never "no longer `recoverable`". A gate that
  //    becomes `selectable` means the recovery SUCCEEDED (credits arrived, the
  //    provider login landed), and that is precisely when the pending commit
  //    must be allowed to fire.
  //  - Only the PERMANENT `hard-disabled` causes. `locked-provider` is
  //    transient: `ChatInput` derives `lockedProviderBehavior` from
  //    `continueEligibility.ok`, which goes false merely because a turn is
  //    streaming, a turn is queued, or a plan is awaiting approval — and the
  //    gate's own copy says so ("stop the current turn, then switch"). Clearing
  //    on it would mean a queued turn starting while the user is off in the
  //    browser signing in cancels their recovery and unmounts the very
  //    `AuthLoginModal` they are using. `org-policy` and `stale-agent` are the
  //    two that genuinely will not resolve on their own.
  //  - Only the row-click path. The case-C escalation pends the CURRENT model
  //    to switch billing mode, and that model's row is ordinarily `selectable`
  //    or otherwise unrelated to the recovery; clearing on its gate would
  //    cancel every billing-mode switch the instant it opened.
  useEffect(() => {
    if (!pendingRecovery || recoveryChatKey !== recoveryEpisode?.chatKey)
      return;
    if (pendingRecoveryAction !== 'select-model') return;
    const row = recoveryRows.find(
      (candidate) =>
        candidate.model === pendingRecovery.model ||
        candidate.runtimeModel === pendingRecovery.model,
    );
    // Not listed at all is Guard 2's case, not this one.
    if (!row) return;
    if (
      row.gate.kind === 'hard-disabled' &&
      (row.gate.cause === 'org-policy' || row.gate.cause === 'stale-agent')
    ) {
      clearPendingRecoveryFromGuard();
    }
  }, [
    pendingRecovery,
    pendingRecoveryAction,
    recoveryRows,
    recoveryChatKey,
    recoveryEpisode?.chatKey,
    clearPendingRecoveryFromGuard,
  ]);

  const livePickerRef = useRef({
    mounted: true,
    chatKey: recoveryChatKey,
    disabled,
    rows: recoveryRows,
  });
  livePickerRef.current.chatKey = recoveryChatKey;
  livePickerRef.current.disabled = disabled;
  livePickerRef.current.rows = recoveryRows;
  useEffect(() => {
    const live = livePickerRef.current;
    live.mounted = true;
    const owned = ownedLeasesRef.current;
    return (): void => {
      live.mounted = false;
      recoveryEpochRef.current += 1;
      for (const lease of owned) lease.revoke();
      owned.clear();
    };
  }, []);

  useEffect(() => {
    for (const episode of ownedEpisodesRef.current)
      if (!episode.isAdmitted()) episode.lease.revoke();
  }, [disabled, recoveryChatKey, recoveryRows]);

  const canApplyRecovery = (episode: RecoveryEpisode): boolean => {
    if (episode.isCurrent()) return true;
    episode.lease.revoke();
    if (episodeRef.current === episode)
      clearPendingRecovery({ restoreFocus: false });
    return false;
  };

  const commitRecoveryModel = async (
    episode: RecoveryEpisode,
    model: ChatModel,
  ): Promise<boolean> => {
    if (!canApplyRecovery(episode)) return false;
    if (episode.commit) return episode.commit(model);
    episode.changeModel(model);
    return true;
  };

  /**
   * CAN-4703 — select the guest fallback on the chat that STARTED this
   * recovery, through the same captured commit a recovered model uses.
   *
   * Re-checks the row first and never bypasses its gate: a row that became
   * recoverable replaces this recovery with its own (keeping the originating
   * chat's bindings, so that recovery commits to the same chat), and one that
   * vanished or was disabled is refused. When the rendered rows describe a
   * different chat we cannot vet the fallback for the original one, so it is
   * refused rather than guessed.
   */
  const handleUseGuestFallback = async (
    episode: RecoveryEpisode,
    fallback: GuestModelFallback,
  ): Promise<GuestFallbackOutcome> => {
    const unavailable: GuestFallbackOutcome = {
      kind: 'blocked',
      reason: guestFallbackUnavailableReason(fallback.label),
    };
    if (
      episodeRef.current !== episode ||
      !canApplyRecovery(episode) ||
      livePickerRef.current.chatKey !== episode.chatKey
    )
      return unavailable;
    const check = revalidateGuestModelFallback(
      fallback,
      livePickerRef.current.rows,
    );
    if (check.kind === 'blocked')
      return check.reason
        ? { kind: 'blocked', reason: check.reason }
        : unavailable;
    if (check.kind === 'recoverable') {
      startRecovery(
        { model: check.model, recovery: check.recovery },
        undefined,
        undefined,
        episode,
      );
      return { kind: 'redirected' };
    }
    const commit = episode.fallbackBindings.onRecoveryCommit;
    const accepted = commit
      ? await commit(
          check.model,
          undefined,
          undefined,
          episode.isCurrent,
          episode.retainContinuation,
        )
      : (episode.fallbackBindings.onModelChange(check.model), true);
    if (!accepted)
      return {
        kind: 'blocked',
        reason: findRowGate(check.model) ?? LOCKED_COMMIT_FALLBACK_REASON,
      };
    if (recoveryEpochRef.current === episode.epoch) {
      episode.complete();
      clearPendingRecovery();
    }
    return { kind: 'committed' };
  };

  const unlockModels = useUnlockModelsAction(recoveryAiCreditsScope);
  const handleUnlockPurchase = async (
    episode: RecoveryEpisode,
    onResumed?: (result: UnlockModelsResult) => void,
  ): Promise<UnlockModelsResult> => {
    if (episodeRef.current !== episode || !canApplyRecovery(episode))
      return { outcome: 'failed' };
    const { pending, chatKey } = episode;
    episode.retainSelection();
    let applied = false;
    const isStillWanted = (): boolean =>
      !applied &&
      livePickerRef.current.chatKey === chatKey &&
      episode.isCurrent();
    return unlockModels({
      source: 'desktop',
      modelId: pending.model,
      ...(chatKey !== undefined ? { chatId: chatKey } : {}),
      ...(onResumed ? { onResumed } : {}),
      isStillWanted,
      apply: async (): Promise<boolean> => {
        if (!isStillWanted()) return false;
        let landed: boolean;
        if (pending.intent === 'enable-ai-credits') {
          episode.changeBilling?.('ai-credits');
          landed = episode.changeBilling !== undefined;
        } else landed = await commitRecoveryModel(episode, pending.model);
        if (landed) {
          applied = true;
          episode.complete();
          if (recoveryEpochRef.current === episode.epoch)
            clearPendingRecovery();
        }
        return landed;
      },
    });
  };

  const canonicalModel = currentModel
    ? getCanonicalPickerModel(currentModel)
    : undefined;
  const managedChoices = canonicalModel
    ? Object.values(managedMappings).flatMap((mapping) =>
        mapping[canonicalModel] ? [mapping[canonicalModel]] : [],
      )
    : [];
  const harnessChoices =
    !modelGatewayEnforced &&
    !lockedHarness &&
    !lockedProvider &&
    canonicalModel &&
    getModelSource(canonicalModel) !== 'ai-gateway' &&
    managedChoices.length > 0
      ? [canonicalModel, ...managedChoices].flatMap((model) => {
          const provider = getProviderForModel(model);
          if (!provider) return [];
          const gate = resolveModelRowGate({
            model,
            provider,
            currentModel,
            gatingEnabled: providerAvailability !== undefined,
            availability: rowGateAvailability?.[provider],
            billingValue: billing?.value,
            lockedProvider,
            lockedProviderReason,
            lockedHarness,
            lockedProviderBehavior,
            canStartNewChat: false,
            modelPolicy,
            staleAgent: false,
            modelGatewayEnforced,
            organizationName: activeOrganizationName,
            personalOwner,
            isGuest,
            libraryAccess,
          });
          return [{ model, provider, gate }];
        })
      : [];
  const selectHarness = (harness: string): boolean => {
    if (disabled) return false;
    const choice = harnessChoices.find(({ provider }) => provider === harness);
    if (
      !choice ||
      choice.gate.kind === 'hard-disabled' ||
      choice.gate.kind === 'hidden'
    )
      return false;
    setHarnessMenuOpen(false);
    if (choice.gate.kind === 'recoverable')
      handleRecover(choice.model, choice.gate.recovery);
    else {
      beginSelectionCommand();
      props.onModelChange(choice.model);
    }
    return true;
  };
  // Register before publishing the slice so snapshot filtering sees this control.
  // The harness browser offers these choices inside the picker, so App
  // Advisor's action follows the picker there instead of a separate chip.
  useEffect(() =>
    registerChatHarnessAction(harnessPickerId, selectHarness, () => {
      const control = separateVendorTabs
        ? rootRef.current
        : harnessButtonRef.current;
      return Boolean(
        !disabled &&
        harnessChoices.length > 1 &&
        control?.isConnected &&
        control.checkVisibility?.({
          visibilityProperty: true,
          opacityProperty: true,
        }),
      );
    }),
  );
  useCurrentUiStateReporter(
    `chat.harnessPicker.${harnessPickerId}`,
    harnessChoices.length > 1 && !disabled
      ? {
          pickerId: harnessPickerId,
          model: canonicalModel ?? '',
          harness: currentProvider ?? '',
          availableHarnesses: harnessChoices
            .filter(
              ({ gate }) =>
                gate.kind !== 'hard-disabled' && gate.kind !== 'hidden',
            )
            .map(({ provider }) => provider),
        }
      : null,
  );

  const picker = (
    <div
      ref={rootRef}
      className={`relative flex items-center gap-1${allowTriggerShrink ? ' min-w-0' : ''}`}
    >
      {harnessChoices.length > 1 && !separateVendorTabs && (
        <>
          <ChatComposerToolbarChip
            buttonRef={harnessButtonRef}
            dataTestId="chat-harness-picker"
            label={getProviderLabel(currentProvider ?? 'codex')}
            title="Harness for this chat"
            ariaLabel="Harness for this chat"
            ariaHasPopup="menu"
            ariaExpanded={harnessMenuOpen}
            icon={null}
            disabled={disabled}
            active={harnessMenuOpen}
            onClick={(): void => setHarnessMenuOpen(!harnessMenuOpen)}
          />
          <FloatingMenu
            open={harnessMenuOpen}
            onOpenChange={setHarnessMenuOpen}
            anchorRef={harnessButtonRef}
            aria-label="Harness for this chat"
            placement="top-left"
          >
            {harnessChoices.map(({ provider, gate }) => {
              return (
                <DropdownMenuItem
                  key={provider}
                  data-testid={`chat-harness-option-${provider}`}
                  disabled={
                    gate.kind === 'hard-disabled' || gate.kind === 'hidden'
                  }
                  onClick={(): void => {
                    selectHarness(provider);
                  }}
                >
                  {getProviderLabel(provider)}
                </DropdownMenuItem>
              );
            })}
          </FloatingMenu>
        </>
      )}
      <ModelPickerMenu
        triggerControlProps={props.triggerControlProps}
        cursorExperimental={!cursorReleased}
        catalog={catalog}
        libraryAccess={libraryLabelAccess}
        // Composers opt into the harness browser; every other surface keeps
        // the single vendor-grouped list.
        harnessTabs={
          separateVendorTabs
            ? {
                brandIcon: <BrandLogo size={18} aria-hidden={true} />,
                brandLabel: brandText.shortName,
                favoritesStorageKey: 'unstoppable:model-picker-favorites',
                ...harnessBrowser,
                credits: {
                  modelIds: creditsModelIds,
                  active: billing?.value === 'ai-credits',
                  onSelect: handleSelectCredits,
                  getOptionState: getCreditsOptionState,
                },
              }
            : undefined
        }
        vendorLabels={
          separateVendorTabs
            ? { ...vendorLabels, anthropic: 'Claude', openai: 'Codex' }
            : vendorLabels
        }
        currentModel={
          currentModel
            ? getAgentModelSelectionId(
                separateVendorTabs &&
                  rowById.has(getCanonicalPickerModel(currentModel))
                  ? getCanonicalPickerModel(currentModel)
                  : currentModel,
              )
            : currentModel
        }
        currentModelLabel={currentModelLabel}
        {...(currentModelUnavailableReason
          ? { currentModelUnavailableReason }
          : {})}
        providerType={currentProvider}
        triggerProvider={currentProvider}
        onSelect={handleSelectModel}
        getOptionState={getOptionState}
        getOptionPresentation={(option, selection): ModelCatalogOption => {
          const row = rowById.get(option.id);
          const route =
            row &&
            rowForHarness(
              row,
              pickedHarness(selection),
              selection?.harnessExplicitlyChosen,
            );
          if (
            !route ||
            (!isCursorModel(route.runtimeModel) &&
              !isCopilotModel(route.runtimeModel) &&
              !isOpenCodeModel(route.runtimeModel))
          )
            return option;
          return (
            buildModelCatalogOption(route.runtimeModel, {
              provider: route.provider,
            }) ?? option
          );
        }}
        autoOption={autoOption}
        variant={capsule ? 'capsule' : 'compact'}
        {...(menuAlignOffset !== undefined ? { menuAlignOffset } : {})}
        {...(menuAlignRef ? { menuAlignRef } : {})}
        {...(menuAlignEdge ? { menuAlignEdge } : {})}
        {...(allowTriggerShrink ? { allowTriggerShrink } : {})}
        {...(foldTriggerIconWhenTight ? { foldTriggerIconWhenTight } : {})}
        {...(foldTriggerIconOnTruncate ? { foldTriggerIconOnTruncate } : {})}
        {...(hideTriggerChevron ? { hideTriggerChevron } : {})}
        hideLabel={hideLabel}
        disabled={disabled}
        openSignal={openSignal}
        externalTriggerRef={externalTriggerRef}
        onRestoreFocus={onRestoreFocus}
        onOpenChange={setCursorMenuOpen}
        allowWorkspaceDefault={allowWorkspaceDefault}
        workspaceDefaultLabel={props.workspaceDefaultLabel}
        onSelectWorkspaceDefault={
          props.allowWorkspaceDefault
            ? (): void => {
                beginSelectionCommand();
                props.onModelChange(undefined);
              }
            : undefined
        }
        placeholderLabel={placeholderLabel}
        triggerTooltip={triggerTooltip}
        testIdPrefix="chat-model"
        menuMinHeightPx={
          separateVendorTabs ? HARNESS_PICKER_MIN_HEIGHT_PX : undefined
        }
        highlightSelection={separateVendorTabs}
        agentsPosition="first"
        footerGap="tight"
        footer={
          showBillingFooter ||
          showBillingSignIn ||
          (personalOwner && modelGatewayEnforced) ||
          hiddenRows.orgGatewayOnly > 0 ||
          footerHarnessStatus
            ? ({ dismissMenu }: ModelPickerMenuControls): JSX.Element => (
                <div role="group">
                  <Divider />
                  <div className="flex flex-col gap-1.5 pt-1">
                    <div className="empty:hidden">
                      {footerHarnessStatus
                        ? harnessStatusLine(footerHarnessStatus)
                        : null}
                      {/* The enforced-gateway filter. No count and no remedy,
                    deliberately: the models are not coming back while the org
                    routes everything through its own gateway, so a count would
                    only invite the reader to look for the control that restores
                    them. Rendered ahead of (and independently of) the billing
                    rows, which `resolveChatBillingFramework` hides outright
                    under enforcement. */}
                      {hiddenRows.orgGatewayOnly > 0 ||
                      (personalOwner && modelGatewayEnforced) ? (
                        <div
                          data-testid="chat-billing-org-gateway-note"
                          className="px-2 py-1 text-3xs leading-snug fg-secondary"
                        >
                          {personalOwner
                            ? 'Showing only your AI gateway.'
                            : `${activeOrganizationName ?? 'Your organization'} routes all models through its AI gateway.`}
                        </div>
                      ) : null}
                      {billing && showBillingFooter ? (
                        <div className="flex flex-col gap-1.5">
                          {/* Preserve the trigger's inline line box before the notes. */}
                          <div>
                            <RichHoverTooltip
                              triggerWrapperClassName="w-full"
                              dataTestId="chat-billing-tooltip"
                              surfaceClassName="w-max max-w-56"
                              surfacePadding="relaxed"
                              content={
                                <span className="flex flex-col text-left">
                                  <span className="text-2xs font-medium leading-tight fg-primary">
                                    {billing.value === 'ai-credits'
                                      ? 'Currently billing to AI Credits'
                                      : 'Currently billing to your subscription'}
                                  </span>
                                  <span className="mt-0.5 text-3xs leading-snug fg-secondary">
                                    {billing.disabled
                                      ? (billing.lockedReason ??
                                        'This is the only billing option for this model.')
                                      : billing.value === 'ai-credits'
                                        ? 'Toggle off to use your Claude or Codex subscription.'
                                        : 'Toggle on to bill this chat to your AI Credits balance.'}
                                  </span>
                                </span>
                              }
                            >
                              <button
                                type="button"
                                role="menuitemcheckbox"
                                aria-checked={billing.value === 'ai-credits'}
                                aria-disabled={billing.disabled === true}
                                disabled={billing.disabled === true}
                                aria-label="Bill this chat to AI Credits"
                                data-testid="chat-billing-framework"
                                onMouseDown={(e): void => {
                                  e.preventDefault();
                                }}
                                onClick={(event): void => {
                                  event.preventDefault();
                                  if (billing.disabled) {
                                    return;
                                  }
                                  beginSelectionCommand();
                                  const nextBilling: BillingFramework =
                                    billing.value === 'ai-credits'
                                      ? 'subscription'
                                      : 'ai-credits';
                                  // CAN-3026 — the "manually selected" half of the
                                  // guest gate. Flipping a chat that sits on a
                                  // non-allowlisted model ONTO AI Credits routes that
                                  // model through the lane Canopy pays for, which is
                                  // exactly what the row gate refuses. Route it
                                  // through the SHARED cloud connect gate rather than
                                  // duplicating the recovery modal: this is a billing
                                  // switch, not a model selection, and it has no
                                  // model to commit afterwards.
                                  //
                                  // Turning credits OFF is never gated — moving a
                                  // guest back onto their own subscription lowers
                                  // Canopy's cost.
                                  //
                                  // `isGuestAllowedSelection` (not the raw protocol
                                  // predicate) so an Agent overlay is judged by its
                                  // BASE model here exactly as it is in the row gate.
                                  if (
                                    nextBilling === 'ai-credits' &&
                                    isGuest &&
                                    currentModel !== undefined &&
                                    !isGuestAllowedSelection(currentModel)
                                  ) {
                                    dismissMenu();
                                    requestConnect(
                                      {
                                        title: guestModelGateTitle(),
                                        subtitle: null,
                                        toastMessage: guestModelGateToast(
                                          getModelDisplayName(currentModel),
                                        ),
                                        guestBenefits: true,
                                      },
                                      // Empty on purpose: the gate close re-reads the
                                      // account, and the user re-flips the toggle
                                      // themselves. Auto-applying a billing mode
                                      // behind a sign-in would be a silent write.
                                      () => {},
                                    );
                                    return;
                                  }
                                  // CAN-4028 — the same switch for a signed-in
                                  // account that has not purchased. Signing in is
                                  // not the remedy here, so it opens the purchase
                                  // recovery instead, as a billing-mode switch: the
                                  // unlock applies AI Credits billing to this chat,
                                  // not a different model.
                                  if (
                                    nextBilling === 'ai-credits' &&
                                    !isGuest &&
                                    libraryAccess === 'needs_purchase' &&
                                    currentModel !== undefined &&
                                    !isGuestAllowedSelection(currentModel)
                                  ) {
                                    dismissMenu();
                                    startRecovery({
                                      model: currentModel,
                                      recovery: { kind: 'needs-purchase' },
                                      intent: 'enable-ai-credits',
                                    });
                                    return;
                                  }
                                  billing.onChange(nextBilling);
                                }}
                                className={`outline-none flex h-8 w-full items-center justify-between rounded-md px-2 text-s fg-primary/80 transition-colors ${
                                  billing.disabled
                                    ? 'cursor-not-allowed opacity-50'
                                    : 'group hover:bg-subtle focus-visible:bg-subtle'
                                }`}
                              >
                                {/* Verb-framed billing-mode label keeps the chat-wide switch
                    distinct from the family-grouped model rows above. */}
                                <span>Use AI Credits</span>
                                <CompactToggleIndicator
                                  checked={billing.value === 'ai-credits'}
                                />
                              </button>
                            </RichHoverTooltip>
                          </div>
                          {billing.disabled && billing.lockedReason ? (
                            <div
                              data-testid="chat-billing-locked-reason"
                              className="px-2 text-3xs leading-snug fg-secondary"
                            >
                              {billing.lockedReason}
                            </div>
                          ) : null}
                          {/* Case E: the rows AI Credits can't pay for are hidden rather than
                dimmed, so this note is the only thing that says they exist and
                that the toggle brings them back. Sibling of the locked reason,
                same visual weight. */}
                          {hiddenRows.notBillableToCredits > 0 ? (
                            <div
                              data-testid="chat-billing-hidden-count"
                              className="px-2 text-3xs leading-snug fg-secondary"
                            >
                              {/* Names the REMEDY as well as the count: a shrinking list
                    otherwise reads as models being gone rather than filtered,
                    which is the specific failure this note exists to prevent.

                    ...but only when the remedy is actually available. With
                    credits and no native login the toggle is `disabled`, and
                    telling someone to turn off a control they cannot operate is
                    worse than saying nothing: it reads as the user having
                    missed something. There the note states the filter and
                    stops. */}
                              {billing.disabled
                                ? hiddenRows.notBillableToCredits === 1
                                  ? '1 model is hidden because AI Credits can’t pay for it.'
                                  : `${hiddenRows.notBillableToCredits} models are hidden because AI Credits can’t pay for them.`
                                : hiddenRows.notBillableToCredits === 1
                                  ? '1 model is hidden because AI Credits can’t pay for it — turn AI Credits off to see it.'
                                  : `${hiddenRows.notBillableToCredits} models are hidden because AI Credits can’t pay for them — turn AI Credits off to see them.`}
                            </div>
                          ) : null}
                          {/* Case C: the toggle is locked purely because the account has no
                credits — which the user can fix. Renders the SAME
                `GetAiCreditsCta` as the modal, so the purchase chain, spinner,
                hand-off and reprobe are one implementation. `onCovered` flips
                the toggle instead of committing a model; that seam is the only
                difference from cases A/B.

                Deliberately absent for `'model-not-routable'` and
                `'gateway-only-model'` (case D): those are properties of the
                MODEL, not the account, and no purchase changes them. */}
                          {billing.disabled &&
                          billing.lockKind === 'no-credits' ? (
                            <div className="px-2">
                              <GetAiCreditsCta
                                variant="inline"
                                label={AI_CREDITS_PURCHASE_LABEL}
                                {...(aiCreditsScope ? { aiCreditsScope } : {})}
                                onGetCreditsClick={(): void => {
                                  if (!currentModel) return;
                                  creditsEpisodeRef.current =
                                    startRecovery(
                                      {
                                        model: currentModel,
                                        recovery: { kind: 'needs-credits' },
                                        intent: 'enable-ai-credits',
                                      },
                                      undefined,
                                      undefined,
                                      undefined,
                                      false,
                                    ) ?? null;
                                }}
                                onCovered={(): boolean => {
                                  const episode = creditsEpisodeRef.current;
                                  if (!episode || !canApplyRecovery(episode))
                                    return false;
                                  episode.changeBilling?.('ai-credits');
                                  episode.complete();
                                  return episode.changeBilling !== undefined;
                                }}
                                // The browser, like the chat banners: the purchase
                                // stays tracked here, so Check again works and the
                                // composer confirms the credits once they land
                                // (CAN-5160). Settings would end the hand-off.
                                billingDestination="browser"
                                confirmArrival="model-picker"
                                // Escalation needs a model to snapshot. Without one, OMIT the
                                // prop entirely so the CTA takes its plain billing hand-off
                                // path — an `onNeedsRecovery` that early-returns would be a
                                // click that visibly does nothing, which is the dead end this
                                // ticket exists to remove.
                                {...(currentModel
                                  ? {
                                      onNeedsRecovery: (): void => {
                                        const episode =
                                          creditsEpisodeRef.current;
                                        if (
                                          !episode ||
                                          !canApplyRecovery(episode)
                                        )
                                          return;
                                        dismissMenu();
                                        recoveryChatKeyRef.current =
                                          episode.chatKey;
                                        episodeRef.current = episode;
                                        setRecoveryEpisode(episode);
                                      },
                                    }
                                  : {})}
                                dataTestId="chat-billing-get-credits"
                              />
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      {separateVendorTabs &&
                      showBillingSignIn &&
                      billing?.lockedReason ? (
                        <div
                          data-testid="chat-billing-locked-reason"
                          className="px-2 py-1 text-3xs leading-snug fg-secondary"
                        >
                          {billing.lockedReason}
                        </div>
                      ) : null}
                    </div>
                    {billing &&
                    billing.disabled &&
                    billing.lockKind === 'no-native-login' &&
                    (billing.provider === 'claude' ||
                      billing.provider === 'codex') ? (
                      <Button
                        size="compact"
                        className="w-full"
                        data-testid="chat-billing-sign-in"
                        onMouseDown={(e): void => {
                          e.preventDefault();
                        }}
                        onClick={(): void => {
                          // Close the picker dropdown before opening the modal so
                          // the menu doesn't linger behind AuthLoginModal and
                          // steal keyboard focus / Escape handling. The modal is
                          // rendered at the picker root (outside the `open &&`
                          // menu portal), so closing the dropdown does not unmount
                          // it.
                          dismissMenu();
                          // Snapshot the provider instead of deriving the open modal
                          // from the live `billing` prop. AuthLoginModal invalidates
                          // provider availability before each fresh probe, and the
                          // parent temporarily omits `billing` while that read is
                          // loading. Keeping the provider here prevents that transient
                          // state from unmounting/remounting the modal in a loop.
                          if (
                            billing.provider === 'claude' ||
                            billing.provider === 'codex'
                          ) {
                            setBillingLoginProvider(billing.provider);
                          }
                        }}
                      >
                        {connectProviderLabel(
                          getProviderLabel(billing.provider),
                        )}
                      </Button>
                    ) : null}
                  </div>
                </div>
              )
            : undefined
        }
      />
      {/* Rendered at the picker root (not inside the `open &&` menu portal) so
          the login modal survives the dropdown closing. AuthLoginModal
          invalidates the provider auth-status cache on close, so
          `useProviderAvailability` refreshes and the toggle unlocks once the
          user signs in. */}
      {billingLoginProvider ? (
        <AuthLoginModal
          provider={billingLoginProvider}
          ownerDocument={ownerDocument}
          onClose={(): void => setBillingLoginProvider(null)}
        />
      ) : null}
      {/* Also mounted at the picker root, OUTSIDE the `open &&` menu portal, so
          it survives the dropdown closing. Both gated surfaces (chat composer
          and Home composer) get it with zero extra plumbing. */}
      {pendingRecovery ? (
        <ModelRecoveryModal
          key={recoveryAttempt}
          pending={pendingRecovery}
          ownerDocument={ownerDocument}
          {...(recoveryAiCreditsScope
            ? { aiCreditsScope: recoveryAiCreditsScope }
            : {})}
          onCommit={async (model): Promise<ModelCommitOutcome> => {
            const episode = recoveryEpisode;
            if (
              !episode ||
              episodeRef.current !== episode ||
              !canApplyRecovery(episode)
            )
              return { ok: false, reason: LOCKED_COMMIT_FALLBACK_REASON };
            const accepted =
              episode.pending.intent === 'enable-ai-credits'
                ? (episode.changeBilling?.('ai-credits'),
                  episode.changeBilling !== undefined)
                : await commitRecoveryModel(episode, model);
            if (!accepted)
              return {
                ok: false,
                reason: findRowGate(model) ?? LOCKED_COMMIT_FALLBACK_REASON,
              };
            if (recoveryEpochRef.current === episode.epoch) {
              episode.complete();
              clearPendingRecovery();
            }
            return { ok: true };
          }}
          {...(recoveryEpisode?.startNewChat
            ? {
                onStartNewChat: (model: ChatModel): void => {
                  const episode = recoveryEpisode;
                  if (
                    episodeRef.current !== episode ||
                    !canApplyRecovery(episode)
                  )
                    return;
                  episode.startNewChat?.(model, episode.selectedBilling);
                  if (recoveryEpochRef.current === episode.epoch)
                    clearPendingRecovery();
                },
              }
            : {})}
          onCancel={(): void => {
            if (recoveryEpisode && episodeRef.current === recoveryEpisode)
              clearPendingRecovery();
          }}
          onUnlockPurchase={(onResumed): Promise<UnlockModelsResult> =>
            recoveryEpisode
              ? handleUnlockPurchase(recoveryEpisode, onResumed)
              : Promise.resolve({ outcome: 'failed' })
          }
          onUseGuestFallback={(fallback): Promise<GuestFallbackOutcome> =>
            recoveryEpisode
              ? handleUseGuestFallback(recoveryEpisode, fallback)
              : Promise.resolve({
                  kind: 'blocked',
                  reason: LOCKED_COMMIT_FALLBACK_REASON,
                })
          }
        />
      ) : null}
    </div>
  );
  if (!agentSelection) return picker;
  const agentChangeHarness = (next: ChatModel): ModelHarness | undefined =>
    executionHarnessExplicitlyChosen === true &&
    executionHarness &&
    getChatHarnessOptions(
      pinInheritingAgentModel(next, inheritedDefaultModel),
    ).includes(executionHarness)
      ? executionHarness
      : undefined;
  return (
    <AgentModelPicker
      agentRoutesSupported={agentSelection !== undefined}
      selection={agentSelection?.selection}
      effectiveModel={agentSelection?.effectiveModel}
      agents={agentRows.map((listed) => {
        const state = getOptionState(rowToCatalogOption(listed), {
          harness: agentChangeHarness(
            listed.selectionModel ?? listed.runtimeModel,
          ),
        });
        return {
          id: listed.model,
          label: getModelDisplayName(listed.model),
          unavailableReason: state.unavailableReason,
          description: 'locked' in state ? state.locked?.hint : undefined,
        };
      })}
      onAgentChange={(next): void => {
        if (next === agentSelection?.selection) return;
        const id = selectedAgentId(next);
        if (id)
          handleSelectModel(id, { harness: agentChangeHarness(next ?? id) });
        // Removal is a complete selection, not a model pick under this Agent.
        else if (next) {
          beginSelectionCommand();
          agentSelection.onRemoveAgent(next, agentChangeHarness(next));
        }
      }}
      disabled={disabled}
      capsule={capsule}
    >
      {picker}
    </AgentModelPicker>
  );
}
