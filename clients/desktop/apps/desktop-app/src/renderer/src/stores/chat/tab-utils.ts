import { noteChatCreatedInSession } from './created-in-session';
// ChatTab transforms and stateful helpers shared by tab lifecycle actions.
import type { StateCreator } from 'zustand';
import {
  chatBannerKey,
  useAiCreditsBannerStore,
  type ChatBannerTarget,
} from '../aiCreditsBannerStore';
import type { ChatState } from './state';
import { chatStoreApi } from './store-ref';
import {
  getProviderForModel,
  resolveProviderModelConfig,
  type AgentModelConfig,
  type AgentProviderType,
  type AiCreditsRoutingState,
  type ChatBillingFramework,
  type ChatInterfaceMode,
  type ChatModel,
  type ChatTabPluginSelections,
  isTerminalBackedInterfaceMode,
  type ModelHarness,
  type PluginSelectionTombstones,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { useProjectsStore } from '../projectsStore';
import { nextTabId } from './ids';
import { sanitizePluginSelectionsWithCachedSupport } from './plugin-provider-support';
import type { WorktreeChatState } from './types';
import {
  CHAT_UNIT_LABEL,
  getModelCatalogProviderLabel,
} from '@canopy/protocol';
import { isUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import { normalizeAgentArtifactCarryByTurn } from '@canopy/desktop-shared/lib/agent-artifacts';
import { isGatewayOnlyModel } from '@canopy/execution-engine/lib/gateway-model-availability';
import { chatSurfaceUsesGlobalPluginDefaults } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import {
  DEFAULT_CODEX_SPEED,
  readCodexSpeedRecord,
} from '@canopy/execution-engine/lib/codex-speed';
import { isClaudeTerminalEligibleChatTab } from '@/lib/chat-provider';
import { getEffectiveClaudeChatInterfaceMode } from '@/lib/claude-tui-chats';
import { draftHasContent } from '@/lib/chat-draft-content';
import { codexSpeedFields, retainedCodexSpeedFields } from './codex-speed';
import type {
  ChatMessage,
  ChatTab,
  QueuedChatDispatchOptions,
  QueuedChatMessage,
  SendMessageDispatchOptions,
} from './types';

/**
 * Billing route to use for per-model capability lookups (supported thinking
 * levels, context window). Mirrors the hydration and event-transform
 * derivation: the authoritative per-session route recorded by main wins;
 * before that, an accepted/requested AI Credits routing state or a
 * gateway-only model implies the AI Credits route.
 */
export function isTabAiCreditsRouted(
  tab: Pick<ChatTab, 'aiCreditsRouted' | 'aiCreditsRouting' | 'model'>,
): boolean {
  return (
    tab.aiCreditsRouted ??
    (tab.aiCreditsRouting?.active === true ||
      (tab.model !== undefined && isGatewayOnlyModel(tab.model)))
  );
}

/**
 * Why a watcher message was refused by this renderer. Main delivers watcher
 * messages straight into its chat queue; only a terminal-backed Claude chat,
 * whose terminal lives in this window, still receives them from the renderer.
 */
export const WATCHER_TERMINAL_ONLY_MESSAGE =
  'This window delivers watcher messages only to terminal chats.';

/**
 * True when the tab's turns run in the managed Claude Code terminal. Matches
 * main's rule for handing a watcher delivery to the window presenter: a
 * Claude-managed chat whose effective interface mode is terminal-backed.
 */
export function isClaudeTerminalBackedChatTab(
  tab: Pick<ChatTab, 'interfaceMode' | 'model' | 'providerType'>,
): boolean {
  return (
    isClaudeTerminalEligibleChatTab(tab) &&
    isTerminalBackedInterfaceMode(
      getEffectiveClaudeChatInterfaceMode(tab.interfaceMode),
    )
  );
}

export function isEditableChatTab(tab: ChatTab | undefined): tab is ChatTab {
  return tab !== undefined && tab.kind !== 'file' && !tab.readOnly;
}

export function buildClosedTabsState(
  current: WorktreeChatState,
  tabs: ChatTab[],
  activeTabId: string,
): WorktreeChatState {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const rememberedTab = tabs.find(
    (tab) => tab.id === current.lastActiveEditableChatId,
  );
  const fallbackTab = [...tabs].reverse().find(isEditableChatTab);
  const lastActiveEditableChatId = isEditableChatTab(activeTab)
    ? activeTab.id
    : isEditableChatTab(rememberedTab)
      ? rememberedTab.id
      : fallbackTab?.id;

  return {
    tabs,
    activeTabId,
    ...(lastActiveEditableChatId ? { lastActiveEditableChatId } : {}),
    ...(current.lastActiveChatProvider
      ? { lastActiveChatProvider: current.lastActiveChatProvider }
      : {}),
  };
}

/**
 * Fork, continuation and branch titles derive from the source's effective
 * name (its custom title first); the user-owned `customTitle` itself is never
 * copied onto the new chat.
 */
export function createForkTabTitle(source: ChatTab): string {
  const generatedDescription =
    source.customTitle?.trim() || source.description?.trim();
  const fallbackTitle = source.title.trim() || CHAT_UNIT_LABEL;
  const forkLabel = generatedDescription || fallbackTitle;
  return forkLabel.startsWith('Fork: ') ? forkLabel : `Fork: ${forkLabel}`;
}

/**
 * Title for a chat continued on another execution harness, e.g.
 * `Codex: Fix the flaky archive spec`. Deliberately not the `Fork:` prefix:
 * a continued chat is a different agent, not another run of the same one.
 * The prefix guard is idempotent so re-continuing does not stack prefixes.
 */
export function createContinuedTabTitle(
  source: ChatTab,
  targetProviderLabel: string,
): string {
  const generatedDescription =
    source.customTitle?.trim() || source.description?.trim();
  const fallbackTitle = source.title.trim() || CHAT_UNIT_LABEL;
  const currentProviderPrefix =
    source.forkedFrom?.continuedFromProvider && source.providerType
      ? `${getModelCatalogProviderLabel(source.providerType)}: `
      : undefined;
  const label =
    generatedDescription ||
    (currentProviderPrefix && fallbackTitle.startsWith(currentProviderPrefix)
      ? fallbackTitle.slice(currentProviderPrefix.length).trim() ||
        CHAT_UNIT_LABEL
      : fallbackTitle);
  const prefix = `${targetProviderLabel}: `;
  return label.startsWith(prefix) ? label : `${prefix}${label}`;
}

export function createBranchTabTitle(source: ChatTab): string {
  const generatedDescription =
    source.customTitle?.trim() || source.description?.trim();
  const fallbackTitle = source.title.trim() || CHAT_UNIT_LABEL;
  const branchLabel = generatedDescription || fallbackTitle;
  return branchLabel.startsWith('Fork: ')
    ? branchLabel.slice('Fork: '.length).trim() || CHAT_UNIT_LABEL
    : branchLabel;
}

export interface ForkTranscriptSelection {
  messagesToClone: ChatMessage[];
  truncated: boolean;
  activeSnapshot: boolean;
}

export interface ChatTabTranscriptClone {
  messages: ChatMessage[];
  agentArtifactCarryByTurn?: ChatTab['agentArtifactCarryByTurn'];
  discovery?: ChatTab['discovery'];
  pluginSelections?: ChatTab['pluginSelections'];
  usage?: ChatTab['usage'];
  agentUsage?: ChatTab['agentUsage'];
  turnDiffs?: ChatTab['turnDiffs'];
}

/**
 * Deep-clone the transcript-scoped state shared by fork, branch, and
 * cross-harness continue actions. Provider/session/config fields deliberately
 * stay with each caller because their carry rules differ.
 */
export function cloneChatTabTranscript(
  source: ChatTab,
  messagesToClone: readonly ChatMessage[],
): ChatTabTranscriptClone {
  const messages: ChatMessage[] = structuredClone([...messagesToClone]);
  const usage = source.usage ? structuredClone(source.usage) : undefined;
  // Response snapshots belong to the source tip. A historical fork cannot
  // attribute those counters to the earlier transcript it retained.
  if (usage && messagesToClone.length < source.messages.length) {
    delete usage.cursorReportedUsage;
    if (usage.reportedTurnUsage !== undefined) usage.reportedTurnUsage = null;
    if (usage.opencodeReportedUsage) {
      delete usage.opencodeReportedUsage;
      usage.contextTokens = 0;
      usage.contextWindow = 0;
    }
  }
  const artifactCarry = normalizeAgentArtifactCarryByTurn(
    source.agentArtifactCarryByTurn,
    new Set(
      messages
        .filter((message) => message.role === 'user')
        .map((message) => message.id),
    ),
  );

  return {
    messages,
    ...(artifactCarry ? { agentArtifactCarryByTurn: artifactCarry } : {}),
    ...(source.discovery
      ? { discovery: structuredClone(source.discovery) }
      : {}),
    ...(source.pluginSelections
      ? { pluginSelections: structuredClone(source.pluginSelections) }
      : {}),
    ...(usage ? { usage } : {}),
    ...(source.agentUsage
      ? { agentUsage: structuredClone(source.agentUsage) }
      : {}),
    ...(source.turnDiffs
      ? { turnDiffs: structuredClone(source.turnDiffs) }
      : {}),
  };
}

export function selectMessagesForForkOrBranch(
  source: ChatTab,
  options?: {
    forkAfterUserMessageId?: string;
    includeActiveTurn?: boolean;
  },
): ForkTranscriptSelection | null {
  const forkAfterUserMessageId = options?.forkAfterUserMessageId;
  const includeActiveTurn = options?.includeActiveTurn === true;
  if (forkAfterUserMessageId === undefined) {
    return source.status === 'streaming' && !includeActiveTurn
      ? null
      : {
          messagesToClone: source.messages,
          truncated: false,
          activeSnapshot: source.status === 'streaming',
        };
  }

  const userIdx = source.messages.findIndex(
    (m) => m.id === forkAfterUserMessageId,
  );
  if (userIdx < 0) return null;

  const promptIds = new Set(
    source.messages.filter(isUserTurnBoundary).map((message) => message.id),
  );
  // Steering and async answers stay in this reply. An autonomous execution
  // starts another reply even when no person sends a new prompt.
  for (let i = userIdx + 1; i < source.messages.length; i++) {
    const message = source.messages[i];
    const block = message.blocks[0];
    const startsAutonomousReply =
      block?.type === 'turn_timer' &&
      block.turnId !== undefined &&
      block.spawnedBy !== undefined &&
      (block.userMessageId === undefined ||
        !promptIds.has(block.userMessageId) ||
        block.spawnedBy.toolsLoaded === true);
    if (isUserTurnBoundary(message) || startsAutonomousReply) {
      return {
        messagesToClone: source.messages.slice(0, i),
        truncated: true,
        activeSnapshot: false,
      };
    }
  }

  return source.status === 'streaming'
    ? null
    : {
        messagesToClone: source.messages,
        truncated: false,
        activeSnapshot: false,
      };
}

export function shouldGenerateTitleFromFirstMessage(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized === '' || normalized === 'new chat';
}

/**
 * Optimistic first-message label for a placeholder-titled chat. It marks the
 * chat `pending` so a renderer snapshot cannot turn the derived label into a
 * saved name that blocks main's one-time automatic title; `closed` is kept.
 */
export function firstMessageTitlePatch(
  tab: Pick<ChatTab, 'title' | 'automaticTitleState'>,
  text: string,
): Pick<ChatTab, 'title' | 'automaticTitleState'> | null {
  if (!shouldGenerateTitleFromFirstMessage(tab.title) || !text.trim()) {
    return null;
  }
  return {
    title: text.slice(0, 40) + (text.length > 40 ? '...' : ''),
    automaticTitleState:
      tab.automaticTitleState === 'closed' ? 'closed' : 'pending',
  };
}

export function chatTabHasConversationContent(
  tab: ChatTab | undefined,
): boolean {
  if (!tab || tab.kind === 'file') return false;
  return (
    (tab.transcript?.messageCount ??
      tab.transcript?.committedMessageCount ??
      tab.messages.length) > 0 || tab.queuedMessages.length > 0
  );
}

/** Composer state, keyed by tab ID, that {@link isPristineChatTab} reads. */
export type PristineChatTabComposerState = Pick<
  ChatState,
  'tabDrafts' | 'composerTextPresent' | 'pendingEditorSelections'
>;

/**
 * Whether a chat tab is an untouched starter that a new conversation may take
 * over. Anything the user typed, staged, or scheduled keeps the tab, including
 * a saved draft whose composer has unmounted (for example after navigating to
 * Home). An untouched empty editor paragraph still counts as pristine.
 */
export function isPristineChatTab(
  tab: ChatTab | undefined,
  composer: PristineChatTabComposerState,
): tab is ChatTab {
  if (!tab || tab.kind === 'file') return false;
  if (tab.status !== 'idle' || chatTabHasConversationContent(tab)) {
    return false;
  }
  if (tab.pendingPlanExit !== undefined) return false;
  if ((tab.pendingAttachments?.length ?? 0) > 0) return false;
  if (tab.pendingRevertAttachmentPath !== undefined) return false;
  if (tab.scheduledSendDraft !== undefined) return false;
  if (composer.composerTextPresent[tab.id] === true) return false;
  const draft = composer.tabDrafts[tab.id];
  if (draft !== undefined && draftHasContent(draft)) return false;
  return (composer.pendingEditorSelections[tab.id]?.length ?? 0) === 0;
}

/**
 * The tab fields {@link getOnlyQueuedHookPlaceholderQueueId} reads: a chat
 * tab, or a tab-strip projection (`ChatTabStripTab`), which carries
 * `hasMessages` instead of the transcript.
 */
export type QueuedHookPlaceholderTab = Pick<
  ChatTab,
  'kind' | 'queuedHookPlaceholder' | 'queuedMessages'
> &
  (
    | { readonly messages: readonly unknown[] }
    | { readonly hasMessages: boolean }
  );

function tabHasMessages(tab: QueuedHookPlaceholderTab): boolean {
  return 'messages' in tab ? tab.messages.length > 0 : tab.hasMessages;
}

export function getOnlyQueuedHookPlaceholderQueueId(
  tab: QueuedHookPlaceholderTab | undefined,
): string | null {
  if (
    !tab ||
    tab.kind === 'file' ||
    tab.queuedHookPlaceholder !== true ||
    tabHasMessages(tab) ||
    tab.queuedMessages.length !== 1
  ) {
    return null;
  }

  return tab.queuedMessages[0]?.queuedHookQueueId ?? null;
}

export interface FilePathRewrite {
  fromRoot: string;
  toRoot: string;
}

/**
 * Apply the first matching file-path rewrite (the backend guarantees the
 * rewrites are sorted longest-`fromRoot`-first). Returns `null` when no
 * rewrite applies, in which case the caller decides whether to keep the tab
 * (typically dropped because the file no longer lives under any path the
 * destination knows about).
 */
export function rewriteFilePathForAdhocMigration(
  filePath: string,
  rewrites: readonly FilePathRewrite[],
): string | null {
  for (const rewrite of rewrites) {
    const { fromRoot, toRoot } = rewrite;
    if (!fromRoot) continue;
    if (filePath === fromRoot) {
      return toRoot;
    }
    // Match on a path boundary so `foo/bar` does not match `foo/barbaz`.
    if (
      filePath.startsWith(fromRoot) &&
      (filePath[fromRoot.length] === '/' || filePath[fromRoot.length] === '\\')
    ) {
      return `${toRoot}${filePath.slice(fromRoot.length)}`;
    }
  }
  return null;
}

/**
 * Append a queued message to the given tab while clearing
 * `pendingAttachments` unless the composer already reserved this send's
 * inputs. In that case, attachments still on the tab belong to a later draft.
 * Used by the duplicate `set(...)` reducers in `sendMessage` (hook
 * placeholder, setup-pending, streaming queue paths).
 */
export function appendQueuedMessageToTab(
  tab: ChatTab,
  message: QueuedChatMessage,
  executionHarness?: ModelHarness,
  preservePendingAttachments = false,
): ChatTab {
  return {
    ...tab,
    queuedMessages: [...tab.queuedMessages, message],
    pendingAttachments: preservePendingAttachments
      ? tab.pendingAttachments
      : undefined,
    ...(tab.executionHarness === undefined && executionHarness
      ? { executionHarness }
      : {}),
  };
}

export function clearUsageLimitBannerForNewUserMessage(
  tab: ChatTab,
  preserveCreditWarning = false,
): ChatTab {
  if (
    tab.llmProviderUsageLimitBanner === undefined &&
    tab.dismissedLlmProviderUsageLimitBannerKey === undefined &&
    (preserveCreditWarning || tab.aiCreditsNoBillingSource === undefined)
  ) {
    return tab;
  }

  const nextTab: ChatTab = { ...tab };
  delete nextTab.llmProviderUsageLimitBanner;
  delete nextTab.dismissedLlmProviderUsageLimitBannerKey;
  // The persisted no-billing-source flag clears on the same boundary (CAN-2413):
  // a dispatched message is the point at which the recorded failure stops
  // describing the chat's current state. If credits are still empty the new turn
  // re-emits the runtime signal, so a premature clear only ever costs one
  // render, while never clearing would strand the banner forever.
  if (!preserveCreditWarning) delete nextTab.aiCreditsNoBillingSource;
  return nextTab;
}

export function toQueuedDispatchOptions(
  options?: SendMessageDispatchOptions,
  includeDispatchAcceptance = true,
): QueuedChatDispatchOptions | undefined {
  if (!options) return undefined;
  const queuedOptions: QueuedChatDispatchOptions = {
    ...(options.assistantMode ? { assistantMode: options.assistantMode } : {}),
    ...(options.hiddenContext ? { hiddenContext: options.hiddenContext } : {}),
    ...(options.activePlan ? { activePlan: options.activePlan } : {}),
    ...(options.appAdvisorContext
      ? { appAdvisorContext: options.appAdvisorContext }
      : {}),
    ...(options.initiationSource
      ? { initiationSource: options.initiationSource }
      : {}),
    ...(options.automationName
      ? { automationName: options.automationName }
      : {}),
    ...(options.watcherFired ? { watcherFired: options.watcherFired } : {}),
    ...(options.watcherDeliveryId
      ? { watcherDeliveryId: options.watcherDeliveryId }
      : {}),
    // Main-accepted input keeps its canonical id (= acceptedInputId) so a
    // drained replay still matches main's retained request; other queued
    // copies deliberately carry no message id.
    ...(options.acceptedInputId
      ? {
          acceptedInputId: options.acceptedInputId,
          userMessageId: options.acceptedInputId,
        }
      : {}),
    ...(options.agentSent ? { agentSent: options.agentSent } : {}),
    ...(includeDispatchAcceptance && options.onDispatchAccepted
      ? { onDispatchAccepted: options.onDispatchAccepted }
      : {}),
    ...(includeDispatchAcceptance && options.onDispatchRejected
      ? { onDispatchRejected: options.onDispatchRejected }
      : {}),
  };
  return Object.keys(queuedOptions).length > 0 ? queuedOptions : undefined;
}

/**
 * Map a remembered billing seed onto the mutually-exclusive per-tab billing
 * bits, exactly as `selectBillingFramework` writes them on an explicit toggle:
 * `'ai-credits'` → persistent `aiCreditsRouting`, `'subscription'` →
 * `subscriptionBillingOverride`, unset → neither (today's default behavior).
 */
export function billingSeedFields(
  billingSeed?: ChatBillingFramework,
):
  | Pick<ChatTab, 'aiCreditsRouting'>
  | Pick<ChatTab, 'subscriptionBillingOverride'>
  | Record<string, never> {
  if (billingSeed === 'ai-credits') {
    const aiCreditsRouting: AiCreditsRoutingState = {
      active: true,
      scope: 'persistent',
      activatedAt: Date.now(),
    };
    return { aiCreditsRouting };
  }
  if (billingSeed === 'subscription') {
    return { subscriptionBillingOverride: true };
  }
  return {};
}

export interface CreateEmptyTabOptions {
  pluginSelections?: ChatTabPluginSelections;
  model?: ChatModel;
  thinkingLevel?: ThinkingLevel;
  defaultChatInterfaceMode?: ChatInterfaceMode;
  modelConfig?: AgentModelConfig;
  /**
   * Whether the tab's Codex speed was explicitly chosen (so provider-default
   * changes leave it alone). Defaults to whether `modelConfig` records any
   * speed information (`speed`, or the legacy `fastMode`).
   */
  fastModeExplicit?: boolean;
  deferredToolsAllowed?: boolean;
  billingSeed?: ChatBillingFramework;
  providerTypeHint?: AgentProviderType;
  modelExplicitlyChosen?: boolean;
  defaultStampModel?: ChatModel;
  /**
   * Pass `newChatPluginDefaultsStamp(projectId)` for a new chat, or the
   * source's value when the tab continues another chat.
   */
  inheritedPluginDefaultsVersion?: number;
}

export function createEmptyTab(options: CreateEmptyTabOptions = {}): ChatTab {
  const {
    pluginSelections,
    model,
    thinkingLevel,
    defaultChatInterfaceMode,
    modelConfig,
    fastModeExplicit = readCodexSpeedRecord(modelConfig) !== undefined,
    deferredToolsAllowed = true,
    billingSeed,
    providerTypeHint,
    modelExplicitlyChosen = false,
    // NO destructuring default here. A default fires on `undefined`, so
    // `stale-session.ts` — which carries `sourceTab.defaultStampModel` across a
    // restart — could not express "this tab has NO stamp": a pre-stamp tab whose
    // model the user picked by hand would come back with
    // `defaultStampModel = sourceTab.model`, flipping `modelIsOurs` to true and
    // letting the next re-stamp overwrite that pick. Seed paths pass
    // `defaultStampModel: model` explicitly instead.
    defaultStampModel,
    inheritedPluginDefaultsVersion,
  } = options;
  const id = nextTabId();
  noteChatCreatedInSession(id);
  const providerType = model
    ? (getProviderForModel(model) ?? providerTypeHint)
    : providerTypeHint;
  // Only persist a non-default `interfaceMode` for Claude-backed tabs. The
  // managed Claude Code terminal experience is Claude-specific, so Codex and
  // Ollama chats stay on the default Canopy-native transcript.
  const interfaceMode =
    defaultChatInterfaceMode &&
    defaultChatInterfaceMode !== 'canopy' &&
    isClaudeTerminalEligibleChatTab({ model, providerType })
      ? defaultChatInterfaceMode
      : undefined;
  const resolvedModelConfig = providerType
    ? resolveProviderModelConfig(
        providerType,
        { thinkingLevel, modelConfig },
        undefined,
      )
    : {
        thinkingLevel: modelConfig?.thinkingLevel ?? thinkingLevel ?? 'high',
        // No provider yet, so no Codex speed applies.
        ...codexSpeedFields(DEFAULT_CODEX_SPEED),
      };
  const effectivePluginSelections = sanitizePluginSelectionsWithCachedSupport(
    pluginSelections,
    providerType,
  );
  return {
    id,
    title: `New ${CHAT_UNIT_LABEL}`,
    messages: [],
    status: 'idle',
    error: null,
    createdAt: new Date().toISOString(),
    newChatStartedWatcherPending: true,
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: resolvedModelConfig.thinkingLevel,
    modelConfig: resolvedModelConfig,
    fastModeExplicit,
    deferredToolsAllowed,
    // Record what the tab was seeded with, so a later lane-aware re-stamp can
    // tell "still holding our own default" from "changed by something else"
    // without needing to re-derive the default that was in force back then.
    ...(model ? { model, providerType } : {}),
    ...(defaultStampModel ? { defaultStampModel } : {}),
    ...(modelExplicitlyChosen ? { modelExplicitlyChosen: true } : {}),
    ...(providerType === 'codex'
      ? { codexFastModeEnabled: resolvedModelConfig.fastMode }
      : {}),
    ...(effectivePluginSelections
      ? { pluginSelections: effectivePluginSelections }
      : {}),
    ...(inheritedPluginDefaultsVersion !== undefined
      ? { inheritedPluginDefaultsVersion }
      : {}),
    ...(interfaceMode ? { interfaceMode } : {}),
    ...(providerType === 'cursor' ||
    providerType === 'copilot' ||
    providerType === 'antigravity' ||
    providerType === 'opencode'
      ? {}
      : billingSeedFields(billingSeed)),
  };
}

export function resolveTabProviderType(
  tab: ChatTab | undefined,
): AgentProviderType | undefined {
  if (!tab || tab.kind === 'file') return undefined;
  return (
    tab.providerType ?? (tab.model ? getProviderForModel(tab.model) : undefined)
  );
}

export type EmptyWorktreeChatOptions = Omit<
  CreateEmptyTabOptions,
  'fastModeExplicit'
>;

export function emptyWorktreeChat(
  options: EmptyWorktreeChatOptions = {},
): WorktreeChatState {
  const tab = createEmptyTab({
    ...options,
    // A SEED path: the tab is being created with this model right now, so it is
    // ours to re-stamp later.
    defaultStampModel: options.defaultStampModel ?? options.model,
    fastModeExplicit: readCodexSpeedRecord(options.modelConfig) !== undefined,
  });
  const lastActiveChatProvider = resolveTabProviderType(tab);
  return {
    tabs: [tab],
    activeTabId: tab.id,
    lastActiveEditableChatId: tab.id,
    ...(lastActiveChatProvider ? { lastActiveChatProvider } : {}),
  };
}

function projectPluginDefaultsFor(
  projectId: string,
  worktreeId: string,
  worktreeDefaultPlugins: Record<string, ChatTabPluginSelections>,
): ChatTabPluginSelections | undefined {
  const override = worktreeDefaultPlugins[`${projectId}/${worktreeId}`];
  if (override) return override;

  const projects = useProjectsStore.getState().projects;
  const project = projects.find((p) => p.id === projectId);
  return project?.defaultPluginSelections;
}

/**
 * Selections a NEW chat copies into its own `pluginSelections`. Surfaces that
 * inherit default plugins (worktree and cowork chats) copy nothing: their
 * project defaults stay a live layer resolved at every turn (see
 * {@link getProjectPluginDefaults}). Purpose-built surfaces (App Advisor,
 * plan-explore, code-review, pipeline editor) still seed from their scoped
 * override or project default at creation.
 */
export function getDefaultPlugins(
  projectId: string,
  worktreeId: string,
  worktreeDefaultPlugins: Record<string, ChatTabPluginSelections>,
): ChatTabPluginSelections | undefined {
  if (chatSurfaceUsesGlobalPluginDefaults(projectId)) return undefined;
  return projectPluginDefaultsFor(
    projectId,
    worktreeId,
    worktreeDefaultPlugins,
  );
}

/**
 * The live project layer a chat at `(projectId, worktreeId)` inherits: the
 * scoped override (cowork mirrors its workspace defaults there) or the
 * project's `defaultPluginSelections`. `undefined` for surfaces that do not
 * inherit default plugins.
 */
export function getProjectPluginDefaults(
  projectId: string,
  worktreeId: string,
  worktreeDefaultPlugins: Record<string, ChatTabPluginSelections>,
): ChatTabPluginSelections | undefined {
  if (!chatSurfaceUsesGlobalPluginDefaults(projectId)) return undefined;
  return projectPluginDefaultsFor(
    projectId,
    worktreeId,
    worktreeDefaultPlugins,
  );
}

/**
 * The global defaults `projectId` turned off for all its chats (its
 * workspace's `disabledGlobalPluginSelections`). Every renderer resolution of
 * a chat's inherited layers passes these as `projectTombstones`, as main
 * does, so a global the project turned off never shows as on. `undefined`
 * for surfaces that do not inherit default plugins.
 */
export function getProjectPluginTombstones(
  projectId: string,
): PluginSelectionTombstones | undefined {
  if (!chatSurfaceUsesGlobalPluginDefaults(projectId)) return undefined;
  return useProjectsStore
    .getState()
    .projects.find((project) => project.id === projectId)
    ?.disabledGlobalPluginSelections;
}

/**
 * Inherited-defaults state a cloned chat (fork, branch, continue) keeps from
 * its source: the defaults it turned off, and the layering version that says
 * whether its `pluginSelections` still hold copied project defaults.
 */
export function inheritedPluginDefaultsCarry(
  source: Pick<
    ChatTab,
    'disabledGlobalPluginSelections' | 'inheritedPluginDefaultsVersion'
  >,
): Pick<
  ChatTab,
  'disabledGlobalPluginSelections' | 'inheritedPluginDefaultsVersion'
> {
  return {
    ...(source.disabledGlobalPluginSelections
      ? {
          disabledGlobalPluginSelections: structuredClone(
            source.disabledGlobalPluginSelections,
          ),
        }
      : {}),
    ...(source.inheritedPluginDefaultsVersion !== undefined
      ? {
          inheritedPluginDefaultsVersion: source.inheritedPluginDefaultsVersion,
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Adhoc multi-repo: tab cloning helpers
//
// Extracted from `forkTab` / `branchTab` so the adhoc multi-repo combine
// migration (`migrateWorktreeTabsToAdhocWorkspace`) can reuse the same
// continuity rules — Claude-only `sdkSessionId` carry, Codex thread/fork,
// file-path rewrite. `forkTab` and `branchTab` are unchanged.
// ---------------------------------------------------------------------------

export interface ChatTabClonePolicy {
  /** Optional override for the cloned tab's title. */
  titleOverride?: string;
  /** Destination `selectedRepoId` after remapping (undefined for root). */
  selectedRepoId?: string;
  /** Stable identity for idempotent adhoc migration retries. */
  adhocMigrationSource?: {
    projectId: string;
    worktreeId: string;
    tabId: string;
  };
}

/**
 * Deep-clone a chat tab for placement in another worktree (or sibling slot).
 * Carries Claude's `sdkSessionId` so the renderer can resume the session;
 * Codex tabs intentionally omit the SDK session id at clone time — callers
 * must call {@link forkCodexThreadForClonedTab} to backfill a forked thread.
 *
 * Reused by the adhoc multi-repo combine migration. Does NOT carry tab id;
 * a fresh id is generated via {@link nextTabId} so the source and clone are
 * independent records, matching the existing `forkTab` / `branchTab`
 * semantics.
 */
export function cloneChatTabForWorktree(
  source: ChatTab,
  policy: ChatTabClonePolicy = {},
): ChatTab {
  const clonedMessages: ChatMessage[] = structuredClone(source.messages);
  const clonedDiscovery = source.discovery
    ? structuredClone(source.discovery)
    : undefined;
  const clonedPluginSelections = source.pluginSelections
    ? structuredClone(source.pluginSelections)
    : undefined;
  const clonedUsage = source.usage ? structuredClone(source.usage) : undefined;
  const clonedAgentUsage = source.agentUsage
    ? structuredClone(source.agentUsage)
    : undefined;
  const clonedTurnDiffs = source.turnDiffs
    ? structuredClone(source.turnDiffs)
    : undefined;
  const clonedPendingPlanExit = source.pendingPlanExit
    ? structuredClone(source.pendingPlanExit)
    : undefined;
  const clonedArtifactCarry = normalizeAgentArtifactCarryByTurn(
    source.agentArtifactCarryByTurn,
    new Set(
      clonedMessages
        .filter((message) => message.role === 'user')
        .map((message) => message.id),
    ),
  );

  // Context preservation: only safe for Claude. Codex starts a fresh
  // forked thread (patched in via `forkCodexThreadForClonedTab`).
  const sourceProviderType = resolveTabProviderType(source) ?? 'claude';
  const carriedSdkSessionId =
    sourceProviderType === 'claude' ? source.sdkSessionId : undefined;

  const title = policy.titleOverride ?? source.title;
  const selectedRepoId = policy.selectedRepoId;

  return {
    id: nextTabId(),
    title,
    messages: clonedMessages,
    status: 'idle',
    error: null,
    createdAt: new Date().toISOString(),
    queuedMessages: [],
    planMode: source.planMode,
    proposalMode: source.proposalMode,
    thinkingLevel: source.thinkingLevel,
    modelConfig: source.modelConfig,
    fastModeExplicit: source.fastModeExplicit,
    ...(sourceProviderType === 'codex'
      ? { codexFastModeEnabled: Boolean(source.codexFastModeEnabled) }
      : {}),
    ...retainedCodexSpeedFields(source.retainedCodexSpeed),
    ...(source.description ? { description: source.description } : {}),
    ...(source.model ? { model: source.model } : {}),
    providerType: sourceProviderType,
    ...(source.executionHarness
      ? { executionHarness: source.executionHarness }
      : {}),
    ...(carriedSdkSessionId ? { sdkSessionId: carriedSdkSessionId } : {}),
    ...(carriedSdkSessionId && source.globalInstructionsSnapshot !== undefined
      ? { globalInstructionsSnapshot: source.globalInstructionsSnapshot }
      : {}),
    ...(carriedSdkSessionId ? { claudeForkSessionOnNextSend: true } : {}),
    ...(policy.adhocMigrationSource
      ? { adhocMigrationSource: policy.adhocMigrationSource }
      : {}),
    ...(clonedPluginSelections
      ? { pluginSelections: clonedPluginSelections }
      : {}),
    ...inheritedPluginDefaultsCarry(source),
    ...(clonedDiscovery ? { discovery: clonedDiscovery } : {}),
    ...(clonedUsage ? { usage: clonedUsage } : {}),
    ...(clonedAgentUsage ? { agentUsage: clonedAgentUsage } : {}),
    ...(clonedTurnDiffs ? { turnDiffs: clonedTurnDiffs } : {}),
    ...(clonedPendingPlanExit
      ? { pendingPlanExit: clonedPendingPlanExit }
      : {}),
    ...(clonedArtifactCarry
      ? { agentArtifactCarryByTurn: clonedArtifactCarry }
      : {}),
    ...(source.trackedPlanId ? { trackedPlanId: source.trackedPlanId } : {}),
    ...(source.trackedPlanSource
      ? { trackedPlanSource: source.trackedPlanSource }
      : {}),
    ...(source.trackedPlanReviewStatus
      ? { trackedPlanReviewStatus: source.trackedPlanReviewStatus }
      : {}),
    ...(source.hasOutstandingProposal !== undefined
      ? { hasOutstandingProposal: source.hasOutstandingProposal }
      : {}),
    ...(source.latestRevisionNumber !== undefined
      ? { latestRevisionNumber: source.latestRevisionNumber }
      : {}),
    ...(selectedRepoId ? { selectedRepoId } : {}),
  };
}

/**
 * Clone a file tab into the destination worktree, rewriting its `filePath`
 * through the supplied rewrites. The title temporarily mirrors the rewritten
 * path so a subsequent `relabelFileTabs` pass can pick a unique suffix among
 * the destination's file tabs. Returns `null` when no rewrite applies (file
 * lived outside any path the backend mapped) so the caller can drop the tab.
 */
export function cloneFileTabForPathRewrite(
  source: ChatTab,
  rewrites: readonly FilePathRewrite[],
): ChatTab | null {
  if (source.kind !== 'file' || !source.filePath) {
    return null;
  }
  const nextPath = rewriteFilePathForAdhocMigration(source.filePath, rewrites);
  if (nextPath === null) {
    return null;
  }
  return {
    ...source,
    id: nextTabId(),
    filePath: nextPath,
    description: nextPath,
    // `relabelFileTabs` rewrites `title` to the unique suffix among siblings.
    title: nextPath,
    messages: [],
    queuedMessages: [],
    status: 'idle',
    error: null,
  };
}

export function clearUsageLimitBannerForDispatchedUserMessage(
  projectId: string,
  worktreeId: string,
  chatId: string,
  set: Parameters<StateCreator<ChatState>>[0],
): void {
  const key = `${projectId}/${worktreeId}`;
  const bannerTarget = { projectId, worktreeId, chatId };
  const bannerKey = chatBannerKey(bannerTarget);
  const bannerStoreState = useAiCreditsBannerStore.getState();
  if (
    bannerStoreState.usageLimitByChat[bannerKey] !== undefined ||
    bannerStoreState.dismissedUsageLimitKeyByChat[bannerKey] !== undefined
  ) {
    bannerStoreState.clearUsageLimitForChat(bannerTarget);
  }
  // Same dispatched-message boundary for the runtime no-billing-source banner
  // (CAN-2413), and deliberately NOT send intent: the main process emits
  // `canopy_user_prompt` before external dispatch completes, so clearing any
  // earlier would hide a still-unrecoverable chat the moment a send is
  // attempted and rejected.
  if (bannerStoreState.noBillingSourceByChat[bannerKey] !== undefined) {
    bannerStoreState.clearNoBillingSourceForChat(bannerTarget);
  }
  set((state) => {
    const currentWc = state.worktreeChats[key];
    if (!currentWc) return state;
    const sync = state.chatStateSync[key];
    const usesCommittedChatState =
      sync !== undefined && sync.phase !== 'hydrating';
    let changed = false;
    const tabs = currentWc.tabs.map((tab) => {
      if (tab.id !== chatId) return tab;
      const nextTab = clearUsageLimitBannerForNewUserMessage(
        tab,
        usesCommittedChatState,
      );
      if (nextTab !== tab) {
        changed = true;
      }
      return nextTab;
    });
    if (!changed) return state;
    const updated: WorktreeChatState = { ...currentWc, tabs };
    return {
      worktreeChats: { ...state.worktreeChats, [key]: updated },
    };
  });
}

/**
 * Clears target-keyed usage-limit banner state for a successfully resumed chat,
 * and clears persisted loaded-tab banner state when the tab is loaded.
 */
export function clearResumedChatUsageLimitBanner(
  target: ChatBannerTarget,
): void {
  clearUsageLimitBannerForDispatchedUserMessage(
    target.projectId,
    target.worktreeId,
    target.chatId,
    chatStoreApi().setState,
  );
}
