/**
 * Live panel tab display for the VS Code-style panel grid.
 *
 * The shared `PanelTabBar` renders a static string title by default; these
 * renderers plug into its `renderTabLabel` / `renderTabTrailing` seams (and a
 * matching icon seam) so chat- and file-bound panel tabs replicate the live
 * derivations `ChatTabBar.renderTab` shows on the classic chat tab strip:
 *
 * - **Leading icon** (via {@link renderPanelTabIcon}): file tabs show the
 *   file-type icon; chat tabs show a thinking spinner while streaming, the
 *   plan-mode icon while awaiting a plan approval, otherwise the provider
 *   logo (status-amber while unread) — the exact components ChatTabBar
 *   uses (`FileTypeIcon`, `ThinkingSpinner`, `PlanModeIcon`,
 *   `ModelProviderIcon`). With early access (the `fill` tab style) the icon
 *   is only the spinner or the provider logo; the states move to the right.
 * - **Label** (via {@link renderPanelTabLabel}): the LIVE title from the
 *   bound chatStore tab (`customTitle`, then `description ?? title` for
 *   chats; `title` for file tabs), falling back to the panel descriptor's stored title when the
 *   bound tab is not (yet) loaded. Activity cards resolve their section
 *   title from the static registry map.
 * - **Trailing** (via {@link renderPanelTabTrailing}): unsaved-changes dot for
 *   dirty file tabs and the read-only lock for chat tabs. Chat unread state is
 *   conveyed by the status-amber leading icon, not a separate trailing dot.
 *   With early access, chat tabs also show the orange dot while a plan review
 *   or tool approval waits and the blue unread dot here.
 * - **Question waiting**: a chat with an unanswered question shows the shared
 *   orange question marker instead of every other needs-input or working
 *   state, in the leading slot on classic tabs (and collapsed icon strips)
 *   and on the right of fill tabs.
 *
 * Each bound tab renders a small component that SUBSCRIBES to the chat store
 * (and the shared file-session controller for dirty state), so titles/status
 * update live without any panel-layout-store mutation.
 *
 * react-refresh/only-export-components fires because this module exports
 * plain render functions alongside the private subscriber components — the
 * render seams ARE the export surface (same posture as registry.tsx).
 */
/* eslint-disable react-refresh/only-export-components */
import { Dot } from '@canopy/ui-shared/components/Badge';
import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type { PanelTabModel } from '@canopy/ui-shared/panels';
import {
  PANEL_TAB_BUSY_ATTRIBUTE,
  PanelChatTabBackgroundGlyph,
  PanelChatTabQuestionMarker,
  PanelFillChatTabGlyph,
  PANEL_TAB_UNREAD_ATTRIBUTE,
  usePanelTabPosition,
  usePanelTabStyle,
} from '@canopy/ui-shared/components/panels';
import { ActivityPingDot } from '@canopy/ui-shared/components';
import { isCloseBlockingTaskType } from '@canopy/desktop-shared/lib/background-work';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';
import { isPanelKind, isSessionBreakdownPanelInstance } from '@canopy/protocol';
import {
  ChatIcon,
  GlobeIcon,
  Lock,
  PlanModeIcon,
  Lock as AppCatalogLock,
} from '@canopy/ui-shared/icons/AppIcons';
import { AgentIcon } from '@canopy/ui-shared/icons';
import {
  resolveOverallDefault,
  type ChatModel,
} from '@canopy/desktop-shared/types';
import type { BrowserSessionSnapshot } from '@canopy/desktop-shared/types';
import {
  useChatStore,
  useChatTabStripTabById,
  type ChatTab,
  type ChatTabStripTab,
} from '@/stores/chatStore';
import {
  selectPipelinePanelTitle,
  usePipelinePanelUiStore,
} from '@/stores/pipelinePanelUiStore';
import { useDelegationActivityStore } from '@/stores/delegationActivityStore';
import { useLiveBackgroundTaskStore } from '@/stores/liveBackgroundTaskStore';
import { hasPendingQuestionForChat } from '@/stores/chat/pending-questions';
import { useDesktopFileTabDirty } from '@/lib/file-viewer/desktop-file-session-controller';
import { useBrowserLoading, useBrowserStore } from '@/stores/browserStore';
import { useTerminalActivityStore } from '@/stores/terminalActivityStore';
import { useWorktreeChatSelection } from '@/components/chat/useWorktreeChatSurfaceState';
import { ThinkingSpinner } from '@/components/shared/loading/spinners/ThinkingSpinner';
import { FileTypeIcon } from '@canopy/ui-shared/icons';
import { resolveChatTabProvider } from '@/lib/providerUi';
import { ModelProviderIcon } from '@canopy/ui-shared/components';
import { usePanelWorktreeSelection } from '@/lib/panels/panel-worktree-context';
import {
  getActivitySectionIcon,
  getActivitySectionTitle,
  getPanelDefinition,
} from '@/lib/panels/registry';
import { currentEarlyAccessTitle } from '@/lib/earlyAccessTitles';
import { automationsPanelTabTitle } from '@/lib/panels/automations-variants';
import { chatTabStripLabel } from '@/lib/chatTabLabel';
import type { WorktreeSelection } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

/**
 * Finds a browser session's snapshot by exact id across every worktree
 * bucket (browser ids are UUIDs, globally unique). Returns the snapshot
 * OBJECT (immutably replaced on change), so subscriptions re-render exactly
 * when the bound session changes.
 */
export function selectBrowserSnapshotById(
  worktrees: ReturnType<typeof useBrowserStore.getState>['worktrees'],
  browserId: string,
): BrowserSessionSnapshot | undefined {
  for (const bucket of Object.values(worktrees)) {
    const snapshot = bucket.browsers[browserId];
    if (snapshot !== undefined) {
      return snapshot;
    }
  }
  return undefined;
}

/**
 * Resolved display label for a browser session, in priority order: the
 * trimmed live page title, the current URL, the plain kind title `Browser`.
 */
function browserDisplayLabel(
  snapshot: BrowserSessionSnapshot | undefined,
): string {
  const title = snapshot?.title.trim() ?? '';
  if (title.length > 0) {
    return title;
  }
  const url = snapshot?.url ?? '';
  if (url.length > 0 && url !== 'about:blank') {
    return url;
  }
  return getPanelDefinition('browser').title;
}

/**
 * A panel tab's plain display title. Instance titles pass through untouched;
 * a MISSING instance title resolves to the registry definition's friendly
 * kind title ("Terminal", "File Explorer", ...) instead of leaking the raw
 * kind id. The layout store's view model falls back to `tab.kind` when a tab
 * has no instance title (singleton kinds never carry one), so `title ===
 * kind` is exactly that fallback and must be re-resolved here.
 *
 * Browser tabs resolve their LIVE page title (→ URL → `Browser`) from the
 * browser store so accessible tab names and close-button labels carry the
 * full title; titles/favicons are live presentation and are never persisted
 * as panel-title overrides.
 */
export function panelTabDisplayTitle(tab: PanelTabModel): string {
  // Chat/file tabs resolve the same LIVE title the visible label renders
  // (`BoundChatTabLabel`); the panel view-model's own `title` is the stored
  // panel title, which for chat panels stays the "New Chat" default and
  // would otherwise surface as a stale tooltip / accessible name.
  const bound = boundChatTabId(tab);
  if (bound !== null) {
    const chatTab = selectChatTabById(
      useChatStore.getState().worktreeChats,
      bound,
    );
    if (chatTab !== undefined) {
      const live =
        tab.kind === 'file-diff' ? chatTab.title : chatTabStripLabel(chatTab);
      if (live !== undefined && live !== '') {
        return live;
      }
    }
  }
  if (tab.kind === 'browser') {
    const browserId = tab.instance?.browserId;
    if (browserId !== undefined && browserId.length > 0) {
      return browserDisplayLabel(
        selectBrowserSnapshotById(
          useBrowserStore.getState().worktrees,
          browserId,
        ),
      );
    }
    return getPanelDefinition('browser').title;
  }
  if (tab.kind === 'pipeline-execution') {
    const runTitle = boundPipelineRunTitle(tab);
    if (runTitle !== undefined) return runTitle;
  }
  if (tab.kind === 'session-breakdown') {
    // The tab shows its chat's name, which is user-written. This plain title
    // feeds accessible names, close labels and tooltips, and session replay
    // records attributes as written, so it stays generic. The visible label
    // (`BoundSessionBreakdownTabLabel`) carries the name, masked.
    return getPanelDefinition('session-breakdown').title;
  }
  if (tab.kind === 'automations') {
    // Saved tabs keep the label they were added with, so a variant's former
    // Automations label shows its current Workflows name.
    const label = automationsPanelTabTitle(tab.title, tab.instance?.variant);
    if (label !== undefined) return label;
  }
  if (tab.kind === 'subagent-chat') {
    const title = tab.title.trim();
    return title.length > 0 && title !== tab.kind
      ? title
      : getPanelDefinition('subagent-chat').title;
  }
  if (isPanelKind(tab.kind) && (tab.title === '' || tab.title === tab.kind)) {
    return currentEarlyAccessTitle(getPanelDefinition(tab.kind).title);
  }
  // A stored title equal to its kind's (or section's) default name, current
  // or former, is that default, so it shows the current sentence-case name.
  // Own titles never are.
  const fallback = defaultTabTitle(tab);
  return fallback !== undefined &&
    currentEarlyAccessTitle(tab.title) === currentEarlyAccessTitle(fallback)
    ? currentEarlyAccessTitle(fallback)
    : tab.title;
}

/**
 * The registry name a tab of this kind (an activity card: of this section)
 * carries by default, or `undefined` for an unknown kind.
 */
function defaultTabTitle(tab: PanelTabModel): string | undefined {
  if (tab.kind === 'activity-card') {
    const sectionId = tab.instance?.sectionId;
    return sectionId !== undefined
      ? getActivitySectionTitle(sectionId)
      : undefined;
  }
  return isPanelKind(tab.kind) ? getPanelDefinition(tab.kind).title : undefined;
}

/**
 * The run name a `pipeline-execution` panel learned once its run loaded
 * (kept in the panel's session state), or `undefined` before then. Titles are
 * live presentation and never persisted into the panel descriptor.
 */
function boundPipelineRunTitle(tab: PanelTabModel): string | undefined {
  const executionId = tab.instance?.executionId;
  if (executionId === undefined || executionId.length === 0) return undefined;
  return selectPipelinePanelTitle(
    usePipelinePanelUiStore.getState(),
    tab.panelId,
    executionId,
  );
}

/** The chatStore tab id a panel tab is bound to, or `null` when unbound. */
function boundChatTabId(tab: PanelTabModel): string | null {
  if (tab.kind === 'chat') {
    return tab.instance?.chatTabId ?? null;
  }
  if (tab.kind === 'file-diff') {
    return tab.instance?.fileTabId ?? null;
  }
  return null;
}

/** The validated chat id a Session breakdown tab is bound to, if present. */
function sessionBreakdownChatId(tab: PanelTabModel): string | null {
  return tab.kind === 'session-breakdown' &&
    isSessionBreakdownPanelInstance(tab.instance)
    ? tab.instance.chatId
    : null;
}

/**
 * Finds a chat/file tab by id across every loaded worktree's chats. Panel tab
 * models don't carry their worktree key, and chat tab ids are globally unique
 * (uuid-based), so a scan is unambiguous; the selector returns the tab OBJECT
 * (immutably replaced on change), so subscriptions re-render exactly when the
 * bound tab changes.
 */
function selectChatTabById(
  worktreeChats: ReturnType<typeof useChatStore.getState>['worktreeChats'],
  tabId: string,
): ChatTab | undefined {
  for (const wc of Object.values(worktreeChats)) {
    const tab = wc.tabs.find((candidate) => candidate.id === tabId);
    if (tab) {
      return tab;
    }
  }
  return undefined;
}

/**
 * The bound tab's strip projection (the same first match by id). It keeps
 * its identity while only transcript state changes, so a streaming reply
 * does not re-render the panel tab header.
 */
function useBoundChatTab(tabId: string): ChatTabStripTab | undefined {
  return useChatTabStripTabById(tabId);
}

/**
 * The bound chat's background work (turn-state D11) and whether it blocks
 * close (D8): delegations and provider agents or workflows do, shells don't.
 * Read from the activity mirrors, never from `tab.status`, and matched by chat
 * id alone (chat tab ids are globally unique), so the selectors re-run only
 * on activity changes, not on every streaming token.
 */
function useBoundChatBackgroundWork(tabId: string): {
  tasks: number;
  blocksClose: boolean;
} {
  const delegations = useDelegationActivityStore((state) =>
    Object.values(state.byChat).reduce(
      (total, entry) =>
        entry.chatId === tabId ? total + entry.live + entry.queued : total,
      0,
    ),
  );
  const liveTasks = useLiveBackgroundTaskStore((state) =>
    Object.values(state.byChat).reduce(
      (total, entry) =>
        entry.chatId === tabId ? total + entry.liveTasks.length : total,
      0,
    ),
  );
  const blockingTasks = useLiveBackgroundTaskStore((state) =>
    Object.values(state.byChat).some(
      (entry) =>
        entry.chatId === tabId &&
        entry.liveTasks.some((task) => isCloseBlockingTaskType(task.taskType)),
    ),
  );
  return {
    tasks: delegations + liveTasks,
    blocksClose: delegations > 0 || blockingTasks,
  };
}

/** Whether a chat tab is awaiting a plan-exit approval (ChatTabBar parity). */
function useAwaitingApproval(tab: ChatTabStripTab | undefined): boolean {
  const pendingForChat = useChatStore((s) =>
    tab !== undefined
      ? Object.values(s.pendingPlanExits).some((pe) => pe.chatId === tab.id)
      : false,
  );
  return tab !== undefined && (!!tab.pendingPlanExit || pendingForChat);
}

/**
 * True when a Canopy tool-approval prompt is blocking this chat. Distinct from
 * {@link useAwaitingApproval}, which is plan review (`pendingPlanExit`).
 */
function useAwaitingToolApproval(tab: ChatTabStripTab | undefined): boolean {
  return useChatStore((s) =>
    tab !== undefined
      ? Object.values(s.pendingApprovals).some(
          (approval) => approval.chatId === tab.id,
        )
      : false,
  );
}

/**
 * True while an agent question in this chat waits for an answer: the same
 * unanswered-question predicate the sidebar row reads, scoped to the panel's
 * worktree. Merely viewing the question keeps it; answering the last one
 * clears it.
 */
function useAwaitingQuestion(chatTabId: string): boolean {
  const selection = usePanelActivityWorktreeSelection();
  return useChatStore((s) =>
    selection !== null
      ? hasPendingQuestionForChat(
          s.pendingQuestions,
          selection.projectId,
          selection.worktreeId,
          chatTabId,
        )
      : false,
  );
}

/** ChatTabBar's default-model fallback for the provider logo. */
function useDefaultWorktreeModel(): ChatModel | undefined {
  return useChatStore((s) =>
    s.modelDefaults
      ? resolveOverallDefault(
          s.modelDefaults.worktreeModelByProvider,
          s.modelDefaults.worktreeProvider,
        ).model
      : undefined,
  );
}

// ---------------------------------------------------------------------------
// Icon (leading) components
// ---------------------------------------------------------------------------

function ChatPanelTabIcon({ chatTabId }: { chatTabId: string }): JSX.Element {
  const tab = useBoundChatTab(chatTabId);
  const background = useBoundChatBackgroundWork(chatTabId);
  const awaitingApproval = useAwaitingApproval(tab);
  const awaitingToolApproval = useAwaitingToolApproval(tab);
  const awaitingQuestion = useAwaitingQuestion(chatTabId);
  const defaultWorktreeModel = useDefaultWorktreeModel();
  // A `fill` tab bar (early access) shows the states on the tab's right.
  // Read from the bar itself: a collapsed group's icon strip has no right
  // side, so it keeps the classic icon states.
  const fillTabs = usePanelTabStyle() === 'fill';
  const tabPosition = usePanelTabPosition();
  const unread = tab?.unread === true;
  const unreadProps = unread
    ? {
        'aria-label': 'Unread chat tab',
        'data-testid': `panel-tab-unread-${chatTabId}`,
        'data-unread': true,
        title: 'Unread chat tab',
      }
    : {};

  if (tab === undefined) {
    return (
      <span className="inline-flex shrink-0 items-center" {...unreadProps}>
        {getPanelDefinition('chat').icon}
      </span>
    );
  }
  if (!fillTabs && awaitingQuestion) {
    // A waiting question outranks every other state, working included: the
    // turn may still stream while it waits, and the user is what it needs.
    return (
      <span className="inline-flex shrink-0 items-center" {...unreadProps}>
        <PanelChatTabQuestionMarker chatId={chatTabId} />
      </span>
    );
  }
  // Fill tabs show the question on their right, so the slot keeps the
  // tab's number rather than a busy spinner.
  if (
    background.tasks > 0 &&
    tab.status !== 'streaming' &&
    !awaitingApproval &&
    !awaitingToolApproval &&
    !awaitingQuestion
  ) {
    // Background work alone. A shell doesn't block close, so its tab stays
    // closable.
    return (
      <PanelChatTabBackgroundGlyph
        backgroundTasks={background.tasks}
        fill={fillTabs}
        unread={unread}
        blocksClose={background.blocksClose}
        {...unreadProps}
      />
    );
  }
  if (
    tab.status === 'streaming' &&
    !awaitingApproval &&
    !awaitingToolApproval &&
    !awaitingQuestion
  ) {
    // Working: its own turn streams.
    // The busy marker withholds the close button while the work runs; a
    // classic tab also keeps this spinner visible on hover, where it would
    // otherwise hide the leading icon and reveal the close button in that
    // slot, erasing the only signal that the tab is working.
    if (fillTabs) return <PanelFillChatTabGlyph busy {...unreadProps} />;
    return (
      <span
        className="inline-flex shrink-0 items-center"
        {...{ [PANEL_TAB_BUSY_ATTRIBUTE]: 'true' }}
        {...unreadProps}
      >
        <ThinkingSpinner
          // Matches the 12px provider/plan glyphs it alternates with, so the
          // running tab does not read narrower than the idle one.
          sizePx={12}
          tone={unread ? 'unread' : 'active'}
          className="shrink-0"
        />
      </span>
    );
  }
  if (!fillTabs && awaitingApproval) {
    return (
      <span className="inline-flex shrink-0 items-center" {...unreadProps}>
        <PlanModeIcon
          size="sm"
          className={`shrink-0 ${OPERATIONAL_STATUS_COLORS.unread.foreground}`}
        />
      </span>
    );
  }
  if (!fillTabs && awaitingToolApproval) {
    // The sidebar dot only says this worktree needs input; this says which
    // tab, so landing here is not a hunt through the strip. Orange matches
    // the row's needs-input dot rather than the blue plan-review glyph.
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center"
        aria-label="Approval needed"
        title="Approval needed"
        data-testid={`panel-tab-tool-approval-${chatTabId}`}
        {...unreadProps}
      >
        <Dot tone="attention" />
      </span>
    );
  }
  // Fill tabs (early access) number their chats by place in the strip
  // instead of repeating the provider glyph on every tab.
  if (fillTabs && tabPosition !== null) {
    return <PanelFillChatTabGlyph busy={false} {...unreadProps} />;
  }
  const provider = resolveChatTabProvider(tab, defaultWorktreeModel);
  // Classic tabs color the glyph: status-amber is their unread indicator.
  // Fill tabs show unread, plan review, and tool approval on the tab's right
  // (see ChatPanelTabTrailing), and the glyph inherits the tab's ink:
  // secondary at rest, primary when the tab is selected or hovered.
  const glyphClassName = fillTabs
    ? 'shrink-0'
    : `shrink-0 ${unread ? OPERATIONAL_STATUS_COLORS.unread.foreground : 'fg-secondary'}`;
  return (
    <span
      className="inline-flex shrink-0 items-center"
      // Keep the automation and accessibility unread hooks on a stable
      // wrapper so every state exposes the same unread marker.
      {...unreadProps}
    >
      {provider !== undefined ? (
        <ModelProviderIcon
          provider={provider}
          size="xs"
          tone={fillTabs ? 'inherit' : unread ? 'unread' : 'secondary'}
          className="shrink-0"
        />
      ) : (
        <ChatIcon size="sm" className={glyphClassName} />
      )}
    </span>
  );
}

function FilePanelTabIcon({
  fileTabId,
  fallbackTitle,
}: {
  fileTabId: string;
  fallbackTitle: string;
}): JSX.Element {
  const tab = useBoundChatTab(fileTabId);
  return (
    <FileTypeIcon
      filename={tab?.title ?? fallbackTitle}
      size="sm"
      className="shrink-0"
    />
  );
}

// ---------------------------------------------------------------------------
// Browser (per-session) display components
// ---------------------------------------------------------------------------

/** The bound browser id of a browser panel tab, or `null`. */
export function boundBrowserId(tab: PanelTabModel): string | null {
  if (tab.kind !== 'browser') {
    return null;
  }
  const browserId = tab.instance?.browserId;
  return browserId !== undefined && browserId.length > 0 ? browserId : null;
}

/** Narrow live-label subscription for one browser session. */
export function useBrowserLabel(browserId: string): string {
  return useBrowserStore((s) =>
    browserDisplayLabel(selectBrowserSnapshotById(s.worktrees, browserId)),
  );
}

function BrowserPanelTabLabel({
  browserId,
}: {
  browserId: string;
}): JSX.Element {
  // Preserves the tab bar's existing single-line truncation: the label is
  // plain text inside `.canopy-panel-tab-title`.
  return <>{useBrowserLabel(browserId)}</>;
}

/**
 * Favicon (or globe fallback) for one browser session, sized for the 14×14
 * icon slot. Fails CLOSED to the globe: a missing, empty, or broken favicon
 * never renders a broken image, and the local error latch resets whenever
 * `faviconUrl` changes so a later good favicon shows again.
 */
export function BrowserPanelTabIcon({
  browserId,
}: {
  browserId: string;
}): JSX.Element {
  const faviconUrl = useBrowserStore((s) => {
    const url = selectBrowserSnapshotById(s.worktrees, browserId)?.faviconUrl;
    return url !== undefined && url.length > 0 ? url : undefined;
  });
  const [failedFaviconUrl, setFailedFaviconUrl] = useState<string | null>(null);
  useEffect(() => {
    // Reset the error latch whenever the favicon source changes.
    setFailedFaviconUrl(null);
  }, [faviconUrl]);

  if (faviconUrl === undefined || failedFaviconUrl === faviconUrl) {
    return (
      <GlobeIcon
        size="sm"
        className="shrink-0"
        data-testid={`panel-tab-browser-globe-${browserId}`}
      />
    );
  }
  return (
    <img
      src={faviconUrl}
      alt=""
      aria-hidden="true"
      width={14}
      height={14}
      className="shrink-0 object-contain"
      draggable={false}
      data-testid={`panel-tab-browser-favicon-${browserId}`}
      onError={(): void => {
        setFailedFaviconUrl(faviconUrl);
      }}
    />
  );
}

/**
 * Rich tooltip content for a Browser tab: one compact row containing the
 * muted globe + `Browser` identity, a middle dot, and the resolved page title.
 * Shared by normal, pinned, and collapsed presentations.
 */
function BrowserPanelTabTooltip({
  browserId,
}: {
  browserId: string;
}): JSX.Element {
  const label = useBrowserLabel(browserId);
  return (
    <span
      className="canopy-panel-tab-rich-tooltip"
      data-testid={`panel-tab-browser-tooltip-${browserId}`}
    >
      <span className="canopy-panel-tab-rich-tooltip-subtitle">
        <GlobeIcon size="sm" aria-hidden="true" />
        Browser
      </span>
      <span
        className="canopy-panel-tab-rich-tooltip-separator"
        aria-hidden="true"
      >
        {' · '}
      </span>
      <span className="canopy-panel-tab-rich-tooltip-title">{label}</span>
    </span>
  );
}

/**
 * Per-tab icon renderer for the shared tab bar's `renderTabIcon` seam:
 * chat/file-bound tabs get their LIVE leading icon (spinner / plan /
 * provider / file-type, ChatTabBar parity), browser tabs get their live
 * favicon (globe fallback), activity cards get their bound section's own
 * icon (unique per section kind, falling back to the generic `activity-card`
 * glyph for unknown/missing sections from stale layouts); everything else
 * gets the registry's static kind icon — including `pipeline-execution`,
 * whose run tabs share the app `PipelineIcon` the Pipeline runs section
 * uses, with the run's instance title (default `Workflow run`) as the label.
 */
export function renderPanelTabIcon(tab: PanelTabModel): ReactNode {
  const bound = boundChatTabId(tab);
  if (bound !== null && tab.kind === 'chat') {
    return <ChatPanelTabIcon chatTabId={bound} />;
  }
  if (bound !== null && tab.kind === 'file-diff') {
    return <FilePanelTabIcon fileTabId={bound} fallbackTitle={tab.title} />;
  }
  const browserId = boundBrowserId(tab);
  if (browserId !== null) {
    return <BrowserPanelTabIcon browserId={browserId} />;
  }
  if (tab.kind === 'activity-card') {
    const sectionId = tab.instance?.sectionId;
    const sectionIcon =
      sectionId !== undefined ? getActivitySectionIcon(sectionId) : undefined;
    return sectionIcon ?? getPanelDefinition('activity-card').icon;
  }
  if (tab.kind === 'subagents' || tab.kind === 'subagent-chat') {
    return <AgentIcon />;
  }
  return isPanelKind(tab.kind) ? getPanelDefinition(tab.kind).icon : undefined;
}

/**
 * Per-tab RICH tooltip renderer for the shared tab bar's `renderTabTooltip`
 * seam. Browser tabs get the one-line `Browser · title` tooltip
 * (replacing the native `title` tooltip); every other kind returns `null`
 * and keeps its existing simple tooltip.
 */
export function renderPanelTabTooltip(tab: PanelTabModel): ReactNode | null {
  if (tab.kind === 'session-breakdown') {
    return getPanelDefinition('session-breakdown').title;
  }
  const browserId = boundBrowserId(tab);
  if (browserId !== null) {
    return <BrowserPanelTabTooltip browserId={browserId} />;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Label components
// ---------------------------------------------------------------------------

function BoundChatTabLabel({
  tabId,
  isFileTab,
  fallbackTitle,
}: {
  tabId: string;
  isFileTab: boolean;
  fallbackTitle: string;
}): JSX.Element {
  const tab = useBoundChatTab(tabId);
  // ChatTabBar parity: chats prefer a custom name, then the generated
  // description; file tabs always show their (uniquely suffixed) title.
  const label =
    tab === undefined
      ? fallbackTitle
      : isFileTab
        ? tab.title
        : chatTabStripLabel(tab);
  // A chat's title is user-authored, so session replay masks it.
  return isFileTab ? (
    <>{label}</>
  ) : (
    <span className={POSTHOG_REPLAY_MASK_CLASS}>{label}</span>
  );
}

/**
 * Per-tab label renderer for the shared tab bar's `renderTabLabel` seam.
 * Returns the LIVE display title for chat/file-bound tabs, the section title
 * for activity cards, and the stored title otherwise.
 */
export function renderPanelTabLabel(tab: PanelTabModel): ReactNode {
  const bound = boundChatTabId(tab);
  if (bound !== null) {
    return (
      <BoundChatTabLabel
        tabId={bound}
        isFileTab={tab.kind === 'file-diff'}
        fallbackTitle={panelTabDisplayTitle(tab)}
      />
    );
  }
  const breakdownChatId = sessionBreakdownChatId(tab);
  if (breakdownChatId !== null) {
    return (
      <BoundSessionBreakdownTabLabel
        chatId={breakdownChatId}
        fallbackTitle={sessionBreakdownStoredTitle(tab)}
      />
    );
  }
  const browserId = boundBrowserId(tab);
  if (browserId !== null) {
    return <BrowserPanelTabLabel browserId={browserId} />;
  }
  if (tab.kind === 'activity-card') {
    const sectionId = tab.instance?.sectionId;
    return sectionId !== undefined
      ? currentEarlyAccessTitle(getActivitySectionTitle(sectionId))
      : panelTabDisplayTitle(tab);
  }
  const executionId = tab.instance?.executionId;
  if (
    tab.kind === 'pipeline-execution' &&
    executionId !== undefined &&
    executionId.length > 0
  ) {
    return (
      <PipelineRunTabLabel
        panelId={tab.panelId}
        executionId={executionId}
        fallbackTitle={panelTabDisplayTitle(tab)}
      />
    );
  }
  return panelTabDisplayTitle(tab);
}

/** The chat name a breakdown tab was opened with, or the panel's own name. */
function sessionBreakdownStoredTitle(tab: PanelTabModel): string {
  const storedTitle = tab.title.trim();
  return storedTitle.length > 0 && storedTitle !== tab.kind
    ? tab.title
    : getPanelDefinition('session-breakdown').title;
}

/** Live chat name for a breakdown tab, with its stored title as fallback. */
function BoundSessionBreakdownTabLabel({
  chatId,
  fallbackTitle,
}: {
  chatId: string;
  fallbackTitle: string;
}): JSX.Element {
  const chatTab = useBoundChatTab(chatId);
  const description = chatTab?.description?.trim() ?? '';
  const title =
    chatTab === undefined
      ? fallbackTitle
      : description.length > 0
        ? description
        : chatTab.title;
  // The tab is named after its chat, and a chat's title is user-authored.
  return <span className={POSTHOG_REPLAY_MASK_CLASS}>{title}</span>;
}

/** Live label for a run tab: the run's name once known, else the default. */
function PipelineRunTabLabel({
  panelId,
  executionId,
  fallbackTitle,
}: {
  panelId: string;
  executionId: string;
  fallbackTitle: string;
}): JSX.Element {
  const title = usePipelinePanelUiStore((state) =>
    selectPipelinePanelTitle(state, panelId, executionId),
  );
  return <>{title ?? fallbackTitle}</>;
}

// ---------------------------------------------------------------------------
// Trailing components
// ---------------------------------------------------------------------------

/** Read-only lock (the exact inline SVG ChatTabBar renders). */
function ClassicReadOnlyLockGlyph(): JSX.Element {
  return (
    <AppCatalogLock
      width="11"
      height="11"
      className="shrink-0 fg-secondary"
      aria-hidden="true"
    />
  );
}

/** Fill tabs' read-only lock: the app glyph at the close button's 14px. */
function ReadOnlyLockGlyph(): JSX.Element {
  // App icons render `aria-hidden`, so the wrapper carries the name.
  return (
    <span aria-label="Read-only" title="Read-only" className="inline-flex">
      <Lock width={14} height={14} className="shrink-0" />
    </span>
  );
}

/**
 * A chat tab's trailing content, matching the tab bar it sits in. Classic tabs
 * show only the read-only lock (their leading icon carries the other states).
 */
function ChatPanelTabTrailing({
  chatTabId,
}: {
  chatTabId: string;
}): JSX.Element | null {
  return usePanelTabStyle() === 'fill' ? (
    <FillChatPanelTabTrailing chatTabId={chatTabId} />
  ) : (
    <ClassicChatPanelTabTrailing chatTabId={chatTabId} />
  );
}

function ClassicChatPanelTabTrailing({
  chatTabId,
}: {
  chatTabId: string;
}): JSX.Element | null {
  const tab = useBoundChatTab(chatTabId);
  const awaitingQuestion = useAwaitingQuestion(chatTabId);
  if (tab === undefined) {
    return null;
  }
  return (
    <>
      {/* The tab bar hides the leading slot from assistive technology, so
          the visible question marker there is named here instead. */}
      {awaitingQuestion ? (
        <span
          className="sr-only"
          data-testid={`panel-tab-question-label-${chatTabId}`}
        >
          Question waiting
        </span>
      ) : null}
      {tab.readOnly === true ? <ClassicReadOnlyLockGlyph /> : null}
    </>
  );
}

/**
 * A fill tab shows every state indicator on its right, where the close button
 * appears on hover (the tab bar hides them while it shows the button): a
 * waiting question, plan review, tool approval, unread, and read-only. A
 * question outranks the other needs-input dots, so one indicator says what
 * the chat waits on.
 */
function FillChatPanelTabTrailing({
  chatTabId,
}: {
  chatTabId: string;
}): JSX.Element | null {
  const tab = useBoundChatTab(chatTabId);
  const awaitingApproval = useAwaitingApproval(tab);
  const awaitingToolApproval = useAwaitingToolApproval(tab);
  const awaitingQuestion = useAwaitingQuestion(chatTabId);
  if (tab === undefined) {
    return null;
  }
  const unread = tab.unread === true;
  if (
    !awaitingQuestion &&
    !awaitingApproval &&
    !awaitingToolApproval &&
    !unread &&
    tab.readOnly !== true
  ) {
    return null;
  }
  return (
    <>
      {/* Plan review and tool approval both wait on the user, so both show
          the orange needs-input dot the sidebar row uses; one dot covers
          either. */}
      {awaitingQuestion ? null : awaitingToolApproval ? (
        <span title="Approval needed" className="inline-flex shrink-0">
          <Dot
            tone="attention"
            label="Approval needed"
            data-testid={`panel-tab-tool-approval-${chatTabId}`}
          />
        </span>
      ) : awaitingApproval ? (
        <span title="Plan waiting for review" className="inline-flex shrink-0">
          <Dot
            tone="attention"
            label="Plan waiting for review"
            data-testid={`panel-tab-plan-review-${chatTabId}`}
          />
        </span>
      ) : null}
      {unread ? (
        <span
          title="Unread"
          // The tab bar reads it to dot ⌄ while this tab is out of view.
          {...{ [PANEL_TAB_UNREAD_ATTRIBUTE]: 'true' }}
          className="inline-flex shrink-0"
        >
          <Dot
            tone="unread"
            label="Unread"
            data-testid={`panel-tab-unread-dot-${chatTabId}`}
          />
        </span>
      ) : null}
      {tab.readOnly === true ? <ReadOnlyLockGlyph /> : null}
    </>
  );
}

function FilePanelTabTrailing({
  fileTabId,
}: {
  fileTabId: string;
}): JSX.Element | null {
  const isDirty = useDesktopFileTabDirty(fileTabId);
  const fillTabs = usePanelTabStyle() === 'fill';
  if (!isDirty) {
    return null;
  }
  // ChatTabBar's unsaved-changes dot; fill tabs center it in the indicator
  // box, so it drops the classic leading margin.
  return (
    <span
      title="Unsaved changes"
      className={`${fillTabs ? '' : 'ml-0.5 '}inline-flex shrink-0`}
    >
      <Dot
        tone="attention"
        label="Unsaved changes"
        data-testid={`panel-tab-dirty-${fileTabId}`}
      />
    </span>
  );
}

function usePanelActivityWorktreeSelection(): WorktreeSelection | null {
  const panelSelection = usePanelWorktreeSelection();
  const globalSelection = useWorktreeChatSelection();
  return panelSelection !== undefined ? panelSelection : globalSelection;
}

function useTerminalActivityRunning(
  selection: WorktreeSelection | null,
  terminalId?: string,
): boolean {
  return useTerminalActivityStore((state) => {
    if (!selection) return false;
    const worktreeKey = `${selection.projectId}/${selection.worktreeId}`;
    if (terminalId) {
      return (
        state.entriesByWorktree[worktreeKey]?.[terminalId]?.running ?? false
      );
    }
    return state.runningWorktreeKeys.has(worktreeKey);
  });
}

/**
 * Lifts a terminal session's running indicator onto its OUTER panel tab. Each
 * terminal panel is bound to one session, so the dot reads only that session's
 * live running state from the worktree-wide activity subscription.
 */
function TerminalPanelTabTrailing({
  terminalId,
}: {
  terminalId?: string;
}): JSX.Element | null {
  const selection = usePanelActivityWorktreeSelection();
  const running = useTerminalActivityRunning(selection, terminalId);
  return running ? (
    <ActivityPingDot
      label="Running"
      testId={
        terminalId
          ? `panel-tab-terminal-running-${terminalId}`
          : 'panel-tab-terminal-running'
      }
    />
  ) : null;
}

/**
 * Browser counterpart to {@link TerminalPanelTabTrailing}: shows the
 * activity dot on the OUTER browser panel tab while EXACTLY this bound
 * session is loading a navigation. Per-browser on purpose: another
 * browser's loading must never light up (or rerender) this tab.
 */
function BrowserPanelTabTrailing({
  browserId,
}: {
  browserId: string;
}): JSX.Element | null {
  const loading = useBrowserLoading(browserId);
  return loading ? (
    <ActivityPingDot
      label="Loading"
      testId={`panel-tab-browser-loading-${browserId}`}
    />
  ) : null;
}

/**
 * Per-tab trailing renderer for the shared tab bar's `renderTabTrailing`
 * seam: unread dot + read-only lock for chat-bound tabs, unsaved-changes dot
 * for file-bound tabs, the activity dot for terminal (running) and browser
 * (loading) tabs, nothing otherwise.
 */
export function renderPanelTabTrailing(tab: PanelTabModel): ReactNode {
  if (tab.kind === 'terminal') {
    return <TerminalPanelTabTrailing terminalId={tab.instance?.terminalId} />;
  }
  const trailingBrowserId = boundBrowserId(tab);
  if (trailingBrowserId !== null) {
    return <BrowserPanelTabTrailing browserId={trailingBrowserId} />;
  }
  const bound = boundChatTabId(tab);
  if (bound === null) {
    return null;
  }
  return tab.kind === 'chat' ? (
    <ChatPanelTabTrailing chatTabId={bound} />
  ) : (
    <FilePanelTabTrailing fileTabId={bound} />
  );
}

// ---------------------------------------------------------------------------
// Collapsed-bar icon components
// ---------------------------------------------------------------------------

/**
 * Wraps a panel's static kind icon so it renders blue and pulsing while the
 * panel has live activity — the collapsed icon bar's counterpart to the
 * expanded tab's trailing activity dot (a collapsed group shows no tab strip,
 * so the dot has nowhere to live). Inactive, it renders the plain icon.
 */
function CollapsedActivityIcon({
  icon,
  active,
  label,
  testId,
}: {
  icon: ReactNode;
  active: boolean;
  label: string;
  testId: string;
}): JSX.Element {
  return (
    <span
      className={`inline-flex shrink-0 items-center${
        active
          ? ` animate-pulse ${OPERATIONAL_STATUS_COLORS.active.foreground}`
          : ''
      }`}
      {...(active
        ? { 'aria-label': label, title: label, 'data-testid': testId }
        : {})}
    >
      {icon}
    </span>
  );
}

function TerminalCollapsedTabIcon({
  terminalId,
}: {
  terminalId?: string;
}): JSX.Element {
  const selection = usePanelActivityWorktreeSelection();
  const running = useTerminalActivityRunning(selection, terminalId);
  return (
    <CollapsedActivityIcon
      icon={getPanelDefinition('terminal').icon}
      active={running}
      label="Running"
      testId={
        terminalId
          ? `panel-collapsed-terminal-active-${terminalId}`
          : 'panel-collapsed-terminal-active'
      }
    />
  );
}

function BrowserCollapsedTabIcon({
  browserId,
}: {
  browserId: string;
}): JSX.Element {
  // Same favicon/globe treatment as the expanded tab icon, pulsing only
  // while EXACTLY this session loads — another browser's loading may not
  // make this collapsed icon pulse.
  const loading = useBrowserLoading(browserId);
  return (
    <CollapsedActivityIcon
      icon={<BrowserPanelTabIcon browserId={browserId} />}
      active={loading}
      label="Loading"
      testId={`panel-collapsed-browser-active-${browserId}`}
    />
  );
}

/**
 * Per-tab icon renderer for the shared tab bar's `renderCollapsedTabIcon` seam
 * (the collapsed icon bar only). Terminal/browser panels get an activity-aware
 * icon that turns blue and pulses while running/loading, so a collapsed panel
 * still surfaces activity the way the expanded tab's dot does. Every other kind
 * falls back to the standard leading icon ({@link renderPanelTabIcon}).
 */
export function renderPanelCollapsedTabIcon(tab: PanelTabModel): ReactNode {
  if (tab.kind === 'terminal') {
    return <TerminalCollapsedTabIcon terminalId={tab.instance?.terminalId} />;
  }
  const browserId = boundBrowserId(tab);
  if (browserId !== null) {
    return <BrowserCollapsedTabIcon browserId={browserId} />;
  }
  return renderPanelTabIcon(tab);
}

/** Status description for pinned and collapsed chat tabs. */
export function renderPanelTabAccessibleStatus(tab: PanelTabModel): ReactNode {
  const chatId = tab.kind === 'chat' ? tab.instance?.chatTabId : undefined;
  return chatId ? <ChatPanelTabQuestionDescription chatTabId={chatId} /> : null;
}

function ChatPanelTabQuestionDescription({
  chatTabId,
}: {
  chatTabId: string;
}): ReactNode {
  return useAwaitingQuestion(chatTabId) ? 'Question waiting' : null;
}

/** Persistent fill-tab attention, outside the label that wraps away. */
export function renderPanelTabAttention(tab: PanelTabModel): ReactNode {
  const chatId = tab.kind === 'chat' ? tab.instance?.chatTabId : undefined;
  return chatId ? <ChatPanelTabAttention chatTabId={chatId} /> : null;
}

function ChatPanelTabAttention({
  chatTabId,
}: {
  chatTabId: string;
}): ReactNode {
  return useAwaitingQuestion(chatTabId) ? (
    <PanelChatTabQuestionMarker chatId={chatTabId} />
  ) : null;
}
