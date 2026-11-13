import { lazy, Suspense } from 'react';
import { EmbeddedDiffFileTree } from '@/components/activity/EmbeddedDiffFileTree';
/**
 * Desktop panel content registry — Phase 2 of the VS Code-style panel system.
 *
 * This module is the concrete map from `PanelKind` (the closed wire union in
 * `@canopy/protocol`) to rendered desktop content. Panel content is rendered
 * exactly once per panel by `PanelContentRoot` (the no-remount portal-target
 * handoff), which resolves it through {@link renderPanelContent} and portals
 * it into a stable per-panel container that grid hosts ADOPT (see
 * `PanelGroup`'s adoption mode); page-shell state (view mode, settings
 * navigation) is threaded via `PanelHostContext`.
 *
 * Design rules:
 * - Wrapper components stay THIN: they read the selected worktree from the
 *   store hooks and delegate to the extracted surface components
 *   (`WorktreeChatSurface`, `TerminalPanelSurface`, `FileViewerPanelHost`,
 *   `ActivityPanel`, `BrowserPanelSurface`). Heavy logic stays in those
 *   components.
 * - The wrapped components are NOT modified by this layer. Where a surface
 *   still assumes the fixed WorktreeManager stack, a `// PHASE3:` comment
 *   states the exact remaining decomposition.
 * - When no worktree is selected, every wrapper renders a neutral empty
 *   state instead of mounting worktree-scoped content.
 *
 * react-refresh/only-export-components fires because this registry module
 * deliberately exports non-component values (the definitions map and lookup/
 * render functions) alongside private wrapper components — the registry IS
 * the export surface, so fast-refresh granularity is intentionally traded
 * away here (same posture as ToolDisplayInfo.tsx / AutomationsPage.tsx).
 */
/* eslint-disable react-refresh/only-export-components */
import { RenderFaultProbe } from '@/lib/e2e-render-fault';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  isPanelKind,
  isSessionBreakdownPanelInstance,
  isSubagentChatPanelInstance,
  PANEL_KINDS,
  SINGLETON_PANEL_KINDS,
  type PanelKind,
} from '@canopy/protocol';
import type {
  PanelContentProps,
  PanelDefinition,
} from '@canopy/ui-shared/panels';
import {
  PANEL_KIND_REPLAY_PRIVACY,
  replayBlockClassFor,
} from '@canopy/desktop-instrumentation/posthog-replay-surfaces';
import {
  WorkflowsIcon,
  BarChart4BarsIcon,
  LineChart1Icon,
  ChatIcon,
  ChatVisualsIcon,
  DataUsageIcon,
  FeedIcon,
  FilesIcon,
  FolderIcon,
  GlobeIcon,
  MultiRepoIcon,
  PipelineIcon,
  PlansIcon,
  SquarePlusIcon,
  TerminalIcon,
  ChangeDiagramIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { AgentIcon } from '@canopy/ui-shared/icons';
import { useShallow } from 'zustand/react/shallow';
import type {
  ActivitySurface,
  AppAdvisorJson,
  FileTabViewMode,
  WorktreeSelection,
} from '@canopy/desktop-shared/types';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  useChatStore,
  useChatTabRenderState,
  useWorktreeChatRenderState,
  type ChatRenderTarget,
} from '@/stores/chatStore';
import {
  resolveFileTreeVisible,
  useFileTabUiStore,
} from '@/stores/fileTabUiStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useDesktopFileTabDirty } from '@/lib/file-viewer/desktop-file-session-controller';
import {
  findPanelByInstanceKey,
  getPanelInstanceKey,
  isAuxPanelLayoutKey,
  makeWorktreePanelKey,
} from '@/stores/panelLayoutStore';
import { isInAppBrowserAvailable } from '@/lib/remote-control/in-app-browser-availability';
import { CHAT_VISUALS_PANEL_TITLE } from '@canopy/ui-app/panel-layout-store';
import {
  Surface,
  EmptyState,
  LoadingRegion,
  Heading,
} from '@canopy/ui-shared/components';
import { LoadingSpinner } from '@/components/shared/loading/spinners/LoadingSpinner';
import { WorktreeChatSurface } from '@/components/chat/WorktreeChatSurface';
import { getWorktreeChatSelection } from '@/components/chat/useWorktreeChatSurfaceState';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { DesktopSharedFileViewer } from '@/components/chat/DesktopSharedFileViewer';
import { TerminalPanelSurface } from '@/components/terminal/TerminalPanelSurface';
import { SharedActivityPanelAdapter } from '@/components/activity/SharedActivityPanelAdapter';
import { ActivityCardChatLayout } from '@/components/activity/ActivityCardControl';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import {
  getActivitySectionDefinition,
  getActivitySectionsForSurface,
} from '@/components/activity/activity-sections';
import { panelSurfaceForWorktreeKey } from './panel-surface';
import { PIPELINE_EXECUTION_PANEL_TITLE } from './pipeline-execution-panel-identity';
import { requestFilePanelPlacementAsSibling } from './chat-panel-sync';
import { ActivitySectionChromeContext } from '@/components/shared/panel-section';
import { FilesTreeTab } from '@/components/activity/FilesTreeTab';
import { BrowserPanelSurface } from '@/components/browser/BrowserPanelSurface';
import { UsagePanel } from '@/components/panels/usage/UsagePanel';
import { usePanelWorktreeSelection } from './panel-worktree-context';
import { usePanelHostState } from './panel-host-context';
import {
  useDocumentVisible,
  usePanelOwnerDocument,
} from './panel-owner-document';
import { useWorkspaceAccess } from '@/lib/workspace-access';
import { isActivitySectionAllowedForAccess } from '@/lib/shared-containers/panel-allowlist';
import {
  isUsagePanelVariant,
  USAGE_PANEL_VARIANTS,
  USAGE_PANEL_VARIANT_LABELS,
} from './usage-variants';
import {
  isAutomationsPanelVariant,
  AUTOMATIONS_PANEL_VARIANTS,
  AUTOMATIONS_PANEL_VARIANT_LABELS,
} from './automations-variants';
import {
  Button,
  DelayedLoadingPlaceholder,
  HeaderActionButton,
  LedgerThreadListSkeleton,
  Notice,
} from '@canopy/ui-shared/components';
import { formatShortcut as formatShortcutHint } from '@canopy/ui-shared/lib/shortcuts';
import { CostIcon } from '@canopy/ui-shared/components/cost';
import type { PlanPanelHostProps } from '@/components/plan-explore/PlanPanelHost';
import {
  SUBAGENT_CHAT_PANEL_FALLBACK_TITLE,
  SUBAGENTS_PANEL_TITLE,
} from './subagent-panel-identity';
import { NewTabPanel } from '@/components/panels/NewTabPanel';

/**
 * Registry entry for one desktop panel kind: the shared engine contract
 * instantiated with React content and the open `kind` string bound to the
 * closed `PanelKind` union from `@canopy/protocol`.
 */
export interface DesktopPanelDefinition extends PanelDefinition<ReactNode> {
  readonly kind: PanelKind;
  /**
   * Whether this kind is a worktree SINGLETON: at most one such panel may be
   * open across a worktree's layout family, and it carries no `instance`
   * binding. Defined canonically by the protocol's
   * `SINGLETON_PANEL_KINDS` set: activity-section/file-explorer/change-diagram,
   * subagents/ledger/cost; terminal/chat/file-diff/activity-card/usage/browser,
   * pipeline-execution, and session-breakdown are per-entity
   * (instance-bound) kinds.
   */
  readonly singleton: boolean;
}

// ---------------------------------------------------------------------------
// Selection + shell helpers
// ---------------------------------------------------------------------------

/**
 * The currently selected worktree (excluding standalone-chat), or null.
 * Shared implementation: `useWorktreeChatSelection` in
 * `@/components/chat/useWorktreeChatSurfaceState` (also used by ChatPanel).
 */
function useSelectedWorktree(): WorktreeSelection | null {
  const panelWorktree = usePanelWorktreeSelection();
  return useChatStore(
    useShallow((s): WorktreeSelection | null =>
      panelWorktree !== undefined
        ? panelWorktree
        : getWorktreeChatSelection(s.selectedWorktree),
    ),
  );
}

const PANEL_CONTENT_FRAME_CLASS =
  'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden';

/**
 * Stable fill container around every panel's content. Gives each mounted
 * panel a durable automation hook (`panel-content-<kind>`) and a
 * flex-column that fills the grid leaf.
 *
 * It also carries the kind's session-replay classification
 * (`PANEL_KIND_REPLAY_PRIVACY`). A panel never changes kind, so the frame
 * mounts with the classification it keeps, which the recorder requires.
 */
function PanelContentFrame({
  kind,
  panelId,
  children,
}: {
  kind: PanelKind;
  panelId: string;
  children: ReactNode;
}): JSX.Element {
  const replayBlockClass = replayBlockClassFor(PANEL_KIND_REPLAY_PRIVACY[kind]);
  return (
    <div
      data-testid={`panel-content-${kind}`}
      data-panel-id={panelId}
      className={
        replayBlockClass
          ? `${replayBlockClass} ${PANEL_CONTENT_FRAME_CLASS}`
          : PANEL_CONTENT_FRAME_CLASS
      }
    >
      {children}
    </div>
  );
}

/** Neutral empty state shown when a panel has no selected worktree. */
function PanelEmptyState(): JSX.Element {
  return (
    <div
      data-testid="panel-empty-state"
      className="flex min-h-0 flex-1 items-center justify-center"
    >
      <EmptyState
        title="Select a worktree to view this panel"
        tone="quiet"
        titleWeight="normal"
      />
    </div>
  );
}

/** 'new-tab' — the `+` button's empty tab: what can be opened in its place. */
function PanelNewTabContent(props: PanelContentProps): JSX.Element {
  const selectedWorktree = useSelectedWorktree();
  return selectedWorktree ? (
    <NewTabPanel
      panelId={props.panelId}
      worktreeKey={makeWorktreePanelKey(
        selectedWorktree.projectId,
        selectedWorktree.worktreeId,
      )}
    />
  ) : (
    <PanelEmptyState />
  );
}

// ---------------------------------------------------------------------------
// Per-kind wrapper components (module-private; reachable only through the
// registry definitions below)
// ---------------------------------------------------------------------------

/**
 * Neutral empty state for an instance-bound panel whose bound chat/file tab
 * no longer exists (deleted tab, stale persisted binding). The chat ⇄ panel
 * sync bridge closes such panels on its next sweep; this renders only for
 * the intervening frame(s).
 */
function PanelMissingBindingState({ label }: { label: string }): JSX.Element {
  return (
    <div
      data-testid="panel-missing-binding"
      className="flex min-h-0 flex-1 items-center justify-center"
    >
      <EmptyState title={label} tone="quiet" titleWeight="normal" />
    </div>
  );
}

/** Temporary state while an instance-bound chat panel is waiting for its
 * owning worktree's persisted chat tabs to hydrate. */
function PanelBindingLoadingState(): JSX.Element {
  return (
    <div
      data-testid="panel-binding-loading"
      className="flex min-h-0 flex-1 items-center justify-center"
    >
      <LoadingSpinner tone="secondary" />
    </div>
  );
}

/**
 * 'chat' — renders ONE chat tab's surface, bound to `instance.chatTabId`:
 * {@link WorktreeChatSurface} = (ClaudeCodeTerminalExperience | ChatContent)
 * for that tab, with the interface-mode toggle. No PrStatusBar (lives in
 * WorktreeTopBar above the grid), no ChatTabBar (panel tabs replace it), no
 * FileViewerPanelHost (file tabs are their own 'file-diff' panels), no
 * nested terminal surface (terminal sessions are their own panels).
 *
 * Sends route per-tab: the surface passes a `targetOverride` bound to the
 * instance's chatTabId into the composer, so a visible-but-non-focused chat
 * panel sends to its OWN tab. Missing binding / deleted tab → neutral empty
 * state (the sync bridge closes the panel on its next sweep).
 */
const VisiblePanelChatContent = memo(function VisiblePanelChatContent(
  props: PanelContentProps,
): JSX.Element {
  const selectedWorktree = useSelectedWorktree();
  const chatTabId = props.instance?.chatTabId;
  const chatTarget: ChatRenderTarget | null =
    selectedWorktree && chatTabId !== undefined
      ? {
          projectId: selectedWorktree.projectId,
          worktreeId: selectedWorktree.worktreeId,
          chatId: chatTabId,
        }
      : null;
  const worktreeChatLoaded = useWorktreeChatRenderState(
    chatTarget ? `${chatTarget.projectId}/${chatTarget.worktreeId}` : null,
    (worktreeChat) => worktreeChat !== undefined,
  );
  // The bound chat alone: its selector runs only when that chat's tab
  // changes, never for another chat's commit.
  const boundTabExists = useChatTabRenderState(
    chatTarget,
    ({ tab }) => tab !== undefined && tab.kind !== 'file',
  );
  const chatBinding = { worktreeChatLoaded, boundTabExists };
  return selectedWorktree ? (
    chatTabId !== undefined && chatBinding.boundTabExists ? (
      <WorktreeChatSurface
        chatTabId={chatTabId}
        worktreeSelection={selectedWorktree}
        visible
        isActivePanel={props.isActive}
        isVisiblePanel={props.isVisible}
      />
    ) : chatTabId !== undefined && !chatBinding.worktreeChatLoaded ? (
      <PanelBindingLoadingState />
    ) : (
      <PanelMissingBindingState label="This chat is no longer open" />
    )
  ) : (
    <PanelEmptyState />
  );
});

const PanelChatContent = memo(function PanelChatContent(
  props: PanelContentProps,
): JSX.Element {
  // Early access places the Activity card inside the chat surface. The
  // layout stays mounted with it off, so toggling keeps the chat's state.
  const activityCardEnabled = useLabsExperimentEnabled('activity-card');
  return (
    <PanelContentFrame kind="chat" panelId={props.panelId}>
      <ActivityCardChatLayout
        panelId={props.panelId}
        enabled={activityCardEnabled}
        visible={props.isVisible}
      >
        {props.isVisible ? <VisiblePanelChatContent {...props} /> : null}
      </ActivityCardChatLayout>
    </PanelContentFrame>
  );
});

/** The bound file tab's live view for a 'file-diff' panel. */
interface BoundFileTabView {
  id: string;
  filePath: string;
  fileViewMode?: FileTabViewMode;
  selectedRepoId?: string;
  recheckAfterWorktreeSetup?: boolean;
}

/**
 * Single-owner `files.activeTab` App Advisor slice reporter, mounted only by
 * the file panel whose bound tab is the chat store's ACTIVE tab (within one
 * React commit, an outgoing instance's unmount cleanup clears the slice
 * before the incoming instance's mount effect writes it).
 */
function ActiveFileTabUiStateReporter({
  tab,
  fileTreeVisible,
}: {
  tab: BoundFileTabView;
  fileTreeVisible: boolean;
}): null {
  const dirty = useDesktopFileTabDirty(tab.id);
  const value: AppAdvisorJson = {
    tabId: tab.id,
    path: tab.filePath,
    ...(tab.selectedRepoId ? { repoId: tab.selectedRepoId } : {}),
    mode: tab.fileViewMode ?? 'raw',
    dirty,
    fileTreeVisible,
  };
  useCurrentUiStateReporter('files.activeTab', value);
  return null;
}

/**
 * Toggle for a file panel's embedded workspace tree. Rendered in the
 * viewer's header (trailing slot) and in the empty tab's own header.
 */
function FileTabTreeToggleButton({
  tabId,
  visible,
}: {
  tabId: string;
  visible: boolean;
}): JSX.Element {
  const setFileTreeVisible = useFileTabUiStore((s) => s.setFileTreeVisible);
  const label = visible ? 'Hide file tree' : 'Show file tree';
  return (
    <HeaderActionButton
      iconOnly
      tone="neutral"
      stateStyle="toolbar"
      aria-pressed={visible}
      aria-label={label}
      data-testid="file-tab-tree-toggle"
      onClick={(): void => setFileTreeVisible(tabId, !visible)}
    >
      <MultiRepoIcon aria-hidden="true" />
    </HeaderActionButton>
  );
}

/**
 * Body of an EMPTY file tab (no file assigned yet): a header carrying the
 * tree toggle plus a centered prompt pointing at the embedded workspace
 * tree and an Open file button carrying the quick-open shortcut.
 */
function EmptyFileTabBody({
  tabId,
  treeVisible,
}: {
  tabId: string;
  treeVisible: boolean;
}): JSX.Element {
  const openFileSearchPalette = useNavigationStore(
    (state) => state.openFileSearchPalette,
  );
  const panelWorktree = useSelectedWorktree();
  const mainWorktree = useChatStore(
    useShallow((s) => getWorktreeChatSelection(s.selectedWorktree)),
  );
  // File search opens in the main window over its selected worktree, so it
  // is offered only from a panel in that window showing that same worktree.
  // A popped-out panel, or one whose worktree the main window has left,
  // keeps the file tree alone. The owner document follows the panel when it
  // moves between windows without remounting.
  const ownerDocument = usePanelOwnerDocument();
  const inMainWindow =
    ownerDocument === undefined || ownerDocument === document;
  const canSearchFiles =
    inMainWindow &&
    panelWorktree !== null &&
    mainWorktree !== null &&
    panelWorktree.projectId === mainWorktree.projectId &&
    panelWorktree.worktreeId === mainWorktree.worktreeId;
  const openFileSearch = (): void => {
    // File search fills the worktree's active empty file tab. A pointer
    // press activates this panel's tab on its own; a keyboard press does
    // not, so make this tab the active one first.
    if (panelWorktree !== null) {
      useChatStore.getState().switchTab(tabId, panelWorktree);
    }
    openFileSearchPalette();
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Surface variant="section" boundary="bottom">
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
          <span className="min-w-0 flex-1 truncate fg-secondary">
            Open file
          </span>
          <FileTabTreeToggleButton tabId={tabId} visible={treeVisible} />
        </div>
      </Surface>
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center p-6 text-center gap-2"
        data-testid="file-tab-empty-state"
      >
        <FolderIcon size="xl" className="fg-secondary/60" />
        <Heading level={3} variant="title">
          No file open
        </Heading>
        <p className="text-xs text-pretty fg-secondary">
          {canSearchFiles
            ? 'Pick one in the file tree, or search by name.'
            : 'Pick one in the file tree.'}
        </p>
        {/* The quick-open shortcut rides inside the button that does the
            same thing, instead of a sentence telling you to press it. */}
        {canSearchFiles && (
          <Button
            className=""
            size="sm"
            shortcut={formatShortcutHint('open-file-search-palette')}
            onClick={openFileSearch}
            data-testid="file-tab-empty-open-file"
          >
            Open file
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * 'file-diff' — renders ONE file, bound to `instance.fileTabId`/`filePath`:
 * the real {@link FileViewerPanel} for that single file (raw/preview/diff
 * modes follow the chatStore tab's live `fileViewMode`). The panel stays
 * mounted while its tab is open, so a sandboxed HTML preview's iframe DOM —
 * and thus its internal scroll position — survives tab switches without the
 * multi-tab FileViewerPanelHost's preserved-mount bookkeeping.
 *
 * A bound tab with an EMPTY `filePath` is a deliberate empty file tab (the
 * add-panel menu's "New File"): it renders a file-picker prompt with the
 * embedded workspace tree expanded; picking a file assigns it into this
 * same tab and collapses the tree. Non-empty tabs keep a toggleable
 * embedded tree whose file clicks go through the normal open-or-activate
 * funnel.
 *
 * Missing binding / deleted file tab → neutral empty state (the sync bridge
 * closes the panel on its next sweep).
 */
const ChangeDiagramPanel = lazy(() =>
  import('@/components/code-review/ChangeDiagramPanel').then((module) => ({
    default: module.ChangeDiagramPanel,
  })),
);

function PanelChangeDiagramContent(props: PanelContentProps): JSX.Element {
  const scope = useSelectedWorktree();
  return (
    <PanelContentFrame kind="change-diagram" panelId={props.panelId}>
      {scope ? (
        <Suspense
          fallback={
            <LoadingRegion
              layout="fill"
              slowNote="Still loading change diagram…"
            />
          }
        >
          <ChangeDiagramPanel {...scope} active={props.isVisible} />
        </Suspense>
      ) : (
        <PanelEmptyState />
      )}
    </PanelContentFrame>
  );
}

/**
 * 'pipeline-execution' — one pipeline run, bound to `instance.executionId`,
 * owned by the panel's layout owner (a Cowork Work Entry fills the worktree
 * slot). Lazy so the run-detail bundle never loads until a run tab is first
 * shown: a restored layout's background tab mounts nothing and reads no run
 * data. The detail's data demand follows the full visibility gate: this tab
 * visible, its host page visible (main page, or the aux window itself), and
 * the owning window's document visible. A missing binding is a contract
 * error and renders an inline notice.
 */
const PipelineExecutionPanel = lazy(() =>
  import('@/components/panels/pipeline/PipelineExecutionPanel').then(
    (module) => ({ default: module.PipelineExecutionPanel }),
  ),
);

const PanelPipelineExecutionContent = memo(
  function PanelPipelineExecutionContent(
    props: PanelContentProps,
  ): JSX.Element {
    const scope = useSelectedWorktree();
    const hostVisible = usePanelHostState().visible !== false;
    const ownerDocument = usePanelOwnerDocument();
    const documentVisible = useDocumentVisible(ownerDocument);
    const visible = props.isVisible && hostVisible && documentVisible;
    const [shown, setShown] = useState(visible);
    if (visible && !shown) setShown(true);
    const executionId = props.instance?.executionId?.trim() ?? '';
    return (
      <PanelContentFrame kind="pipeline-execution" panelId={props.panelId}>
        {scope ? (
          executionId.length > 0 ? (
            shown ? (
              <Suspense
                fallback={
                  <LoadingRegion layout="fill" slowNote="Still loading run…" />
                }
              >
                <PipelineExecutionPanel
                  panelId={props.panelId}
                  executionId={executionId}
                  owner={scope}
                  visible={visible}
                  active={props.isActive}
                  ownerDocument={ownerDocument}
                />
              </Suspense>
            ) : null
          ) : (
            <div className="shrink-0 p-2">
              <Notice
                intent="destructive"
                data-testid="panel-pipeline-execution-unbound"
                className=""
              >
                This run tab is missing its run. Close it and open the run
                again.
              </Notice>
            </div>
          )
        ) : (
          <PanelEmptyState />
        )}
      </PanelContentFrame>
    );
  },
);

/**
 * 'plan' / 'plan-diagram' — ONE tracked plan, bound to `instance.planId`: the
 * plan's document view, or its diagram split into its own panel. The hosts
 * (and the Markdown / diagram modules behind them) load lazily so nothing new
 * joins the empty-startup path. A plan panel always renders inside its owning
 * worktree's scope (the panel worktree context), never the globally selected
 * worktree. A missing binding is a contract error (the layout store refuses
 * and prunes unbound plan entries) and renders a neutral missing state.
 */
const PlanPanelHost = lazy(() =>
  import('@/components/plan-explore/PlanPanelHost').then((module) => ({
    default: module.PlanPanelHost,
  })),
);

const PlanDiagramPanelHost = lazy(() =>
  import('@/components/plan-explore/PlanPanelHost').then((module) => ({
    default: module.PlanDiagramPanelHost,
  })),
);

function PlanPanelBoundContent({
  kind,
  props,
}: {
  kind: 'plan' | 'plan-diagram';
  props: PanelContentProps;
}): JSX.Element {
  const scope = useSelectedWorktree();
  const hostVisible = usePanelHostState().visible !== false;
  const planId = props.instance?.planId?.trim();
  if (!scope) {
    return (
      <PanelContentFrame kind={kind} panelId={props.panelId}>
        <PanelEmptyState />
      </PanelContentFrame>
    );
  }
  if (planId === undefined || planId.length === 0) {
    return (
      <PanelContentFrame kind={kind} panelId={props.panelId}>
        <PanelMissingBindingState label="This plan panel is missing its plan" />
      </PanelContentFrame>
    );
  }
  const hostProps: PlanPanelHostProps = {
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    planId,
    panelId: props.panelId,
    isActive: props.isActive,
    isVisible: props.isVisible && hostVisible,
  };
  return (
    <PanelContentFrame kind={kind} panelId={props.panelId}>
      <Suspense
        fallback={
          <LoadingRegion layout="fill" slowNote="Still loading plan…" />
        }
      >
        {kind === 'plan' ? (
          <PlanPanelHost {...hostProps} />
        ) : (
          <PlanDiagramPanelHost {...hostProps} />
        )}
      </Suspense>
    </PanelContentFrame>
  );
}

/**
 * 'chat-visuals' — every visual of one chat of the selected worktree, bound by
 * `instance.chatId`. The chat publishes its visuals and the panel lists them,
 * so it holds no transcript of its own. Lazy so the visual UI loads only when
 * a visuals tab is first shown.
 */
const DesktopChatVisualsPanel = lazy(() =>
  import('@/components/panels/chat-visuals/DesktopChatVisualsPanel').then(
    (module) => ({ default: module.DesktopChatVisualsPanel }),
  ),
);

const PanelChatVisualsContent = memo(function PanelChatVisualsContent(
  props: PanelContentProps,
): JSX.Element {
  const scope = useSelectedWorktree();
  const chatId = props.instance?.chatId;
  return (
    <PanelContentFrame kind="chat-visuals" panelId={props.panelId}>
      {!scope ? (
        <PanelEmptyState />
      ) : chatId === undefined || chatId.length === 0 ? (
        <PanelMissingBindingState label="This panel is missing its chat" />
      ) : (
        <Suspense
          fallback={
            <LoadingRegion layout="fill" slowNote="Still loading visuals…" />
          }
        >
          <DesktopChatVisualsPanel
            projectId={scope.projectId}
            worktreeId={scope.worktreeId}
            chatId={chatId}
          />
        </Suspense>
      )}
    </PanelContentFrame>
  );
});

const PanelPlanContent = memo(function PanelPlanContent(
  props: PanelContentProps,
): JSX.Element {
  return <PlanPanelBoundContent kind="plan" props={props} />;
});

const PanelPlanDiagramContent = memo(function PanelPlanDiagramContent(
  props: PanelContentProps,
): JSX.Element {
  return <PlanPanelBoundContent kind="plan-diagram" props={props} />;
});

/**
 * 'subagents' / 'subagent-chat' — the subagent viewer. Both hosts (and the
 * shared viewer UI behind them) load lazily, only once the tab is first
 * shown, so a restored background tab mounts nothing and reads nothing. They
 * render inside the panel owner's scope (a Cowork Work Entry or App Advisor
 * fills the worktree slot) and receive the full visibility gate; a hidden
 * host stays inert (no reads, no tree builds).
 */
const DesktopSubagentsPanelHost = lazy(() =>
  import('@/components/subagents/DesktopSubagentsPanelHost').then((module) => ({
    default: module.DesktopSubagentsPanelHost,
  })),
);

const DesktopSubagentChatPanelHost = lazy(() =>
  import('@/components/subagents/DesktopSubagentChatPanelHost').then(
    (module) => ({ default: module.DesktopSubagentChatPanelHost }),
  ),
);

/** The panel's full visibility gate, latched to "shown once" for lazy loads. */
function useSubagentPanelVisibility(isVisible: boolean): {
  readonly visible: boolean;
  readonly shown: boolean;
} {
  const hostVisible = usePanelHostState().visible !== false;
  const documentVisible = useDocumentVisible(usePanelOwnerDocument());
  const visible = isVisible && hostVisible && documentVisible;
  const [shown, setShown] = useState(visible);
  if (visible && !shown) setShown(true);
  return { visible, shown };
}

const PanelSubagentsContent = memo(function PanelSubagentsContent(
  props: PanelContentProps,
): JSX.Element {
  const selectedWorktree = useSelectedWorktree();
  const { visible, shown } = useSubagentPanelVisibility(props.isVisible);
  const projectId = selectedWorktree?.projectId;
  const worktreeId = selectedWorktree?.worktreeId;
  const scope = useMemo(
    () =>
      projectId !== undefined && worktreeId !== undefined
        ? { projectId, worktreeId }
        : null,
    [projectId, worktreeId],
  );
  return (
    <PanelContentFrame kind="subagents" panelId={props.panelId}>
      {scope ? (
        shown ? (
          <Suspense
            fallback={
              <LoadingRegion
                layout="fill"
                slowNote="Still loading subagents…"
              />
            }
          >
            <DesktopSubagentsPanelHost
              scope={scope}
              isVisible={visible}
              isActive={props.isActive}
            />
          </Suspense>
        ) : null
      ) : (
        <PanelEmptyState />
      )}
    </PanelContentFrame>
  );
});

const PanelSubagentChatContent = memo(function PanelSubagentChatContent(
  props: PanelContentProps,
): JSX.Element {
  const selectedWorktree = useSelectedWorktree();
  const { visible, shown } = useSubagentPanelVisibility(props.isVisible);
  const projectId = selectedWorktree?.projectId;
  const worktreeId = selectedWorktree?.worktreeId;
  const scope = useMemo(
    () =>
      projectId !== undefined && worktreeId !== undefined
        ? { projectId, worktreeId }
        : null,
    [projectId, worktreeId],
  );
  const binding = {
    rootChatId: props.instance?.rootChatId,
    subagentId: props.instance?.subagentId,
    subagentKind: props.instance?.subagentKind,
  };
  if (!scope) {
    return (
      <PanelContentFrame kind="subagent-chat" panelId={props.panelId}>
        <PanelEmptyState />
      </PanelContentFrame>
    );
  }
  if (!isSubagentChatPanelInstance(binding)) {
    return (
      <PanelContentFrame kind="subagent-chat" panelId={props.panelId}>
        <PanelMissingBindingState label="This subagent chat is missing its subagent" />
      </PanelContentFrame>
    );
  }
  return (
    <PanelContentFrame kind="subagent-chat" panelId={props.panelId}>
      {shown ? (
        <Suspense
          fallback={
            <LoadingRegion
              layout="fill"
              slowNote="Still loading subagent chat…"
            />
          }
        >
          <DesktopSubagentChatPanelHost
            scope={scope}
            rootChatId={binding.rootChatId}
            subagentId={binding.subagentId}
            subagentKind={binding.subagentKind}
            panelId={props.panelId}
            isVisible={visible}
            isActive={props.isActive}
          />
        </Suspense>
      ) : null}
    </PanelContentFrame>
  );
});

const PanelFileDiffContent = memo(function PanelFileDiffContent(
  props: PanelContentProps,
): JSX.Element {
  const selectedWorktree = useSelectedWorktree();
  const fileTabId = props.instance?.fileTabId;
  const loadTabsForTarget = useChatStore((s) => s.loadTabsForTarget);
  const worktreeChatLoaded = useWorktreeChatRenderState(
    selectedWorktree
      ? `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`
      : null,
    (worktreeChat) => worktreeChat !== undefined,
  );
  useEffect(() => {
    if (!selectedWorktree || fileTabId === undefined || worktreeChatLoaded) {
      return;
    }
    void loadTabsForTarget(
      selectedWorktree.projectId,
      selectedWorktree.worktreeId,
    );
  }, [fileTabId, loadTabsForTarget, selectedWorktree, worktreeChatLoaded]);
  const fileTabTarget: ChatRenderTarget | null =
    selectedWorktree && fileTabId !== undefined
      ? {
          projectId: selectedWorktree.projectId,
          worktreeId: selectedWorktree.worktreeId,
          chatId: fileTabId,
        }
      : null;
  const boundTab = useChatTabRenderState(
    fileTabTarget,
    useShallow(({ tab }): BoundFileTabView | null => {
      if (!tab || tab.kind !== 'file') {
        return null;
      }
      return {
        id: tab.id,
        // '' (or a legacy missing path) is the deliberate EMPTY file tab
        // state, not a broken binding.
        filePath: tab.filePath ?? '',
        ...(tab.fileViewMode ? { fileViewMode: tab.fileViewMode } : {}),
        ...(tab.selectedRepoId ? { selectedRepoId: tab.selectedRepoId } : {}),
        ...(tab.recheckAfterWorktreeSetup
          ? { recheckAfterWorktreeSetup: true }
          : {}),
      };
    }),
  );
  const isActiveTab = useWorktreeChatRenderState(
    fileTabTarget
      ? `${fileTabTarget.projectId}/${fileTabTarget.worktreeId}`
      : null,
    (worktreeChat) =>
      fileTabId !== undefined && worktreeChat?.activeTabId === fileTabId,
  );
  const isEmpty = boundTab !== null && boundTab.filePath === '';
  const boundTabId = boundTab?.id;
  const treeVisible = useFileTabUiStore((s) =>
    boundTabId !== undefined
      ? resolveFileTreeVisible(s.fileTreeVisibleByTabId, boundTabId, isEmpty)
      : false,
  );
  const treeMode = useFileTabUiStore((s) =>
    boundTabId
      ? (s.fileTreeModeByTabId[boundTabId] ??
        (boundTab?.fileViewMode === 'diff' ? 'diff' : 'file'))
      : 'file',
  );
  useEffect(() => {
    if (boundTabId)
      useFileTabUiStore.getState().initializeFileTreeMode(boundTabId, treeMode);
  }, [boundTabId, treeMode]);
  const setTreeMode = (mode: 'file' | 'diff'): void => {
    if (boundTabId)
      useFileTabUiStore.getState().setFileTreeMode(boundTabId, mode);
  };
  const treeRevealedPath = useFileTabUiStore((s) =>
    boundTabId !== undefined
      ? s.fileTreeRevealedPathByTabId[boundTabId]
      : undefined,
  );
  const treeDirectoryPath = useFileTabUiStore((s) =>
    boundTabId !== undefined
      ? s.fileTreeDirectoryPathByTabId[boundTabId]
      : undefined,
  );

  // Embedded-tree file clicks: an EMPTY tab consumes the file itself (and
  // collapses its tree on the empty → non-empty transition); a file-bearing
  // tab routes through the normal open-or-activate funnel. Read live state at
  // click time — the panel-level `isEmpty` could be a render behind.
  const handleTreeOpenFile = useCallback(
    (file: { absolutePath: string; filename: string }): void => {
      if (!selectedWorktree || fileTabId === undefined) return;
      const chat = useChatStore.getState();
      const key = `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`;
      const tab = chat.worktreeChats[key]?.tabs.find(
        (candidate) => candidate.id === fileTabId,
      );
      const tabIsEmpty =
        tab?.kind === 'file' &&
        (tab.filePath === undefined || tab.filePath === '');
      if (tabIsEmpty) {
        const assigned = chat.assignFileTab(fileTabId, file, selectedWorktree);
        if (assigned === fileTabId) {
          useFileTabUiStore.getState().setFileTreeVisible(fileTabId, false);
        }
        return;
      }
      const openedTabId = chat.openFileTab(file, selectedWorktree);
      if (openedTabId !== null) {
        // A file opened from within a file tab lands as that tab's SIBLING
        // (same group, right after it). Already-open files keep their panel
        // — the hint is dropped and the existing tab just activates.
        requestFilePanelPlacementAsSibling(openedTabId, fileTabId);
      }
    },
    [fileTabId, selectedWorktree],
  );

  return (
    <PanelContentFrame kind="file-diff" panelId={props.panelId}>
      {selectedWorktree ? (
        boundTab !== null ? (
          <>
            {isActiveTab && (
              <ActiveFileTabUiStateReporter
                tab={boundTab}
                fileTreeVisible={treeVisible}
              />
            )}
            <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                {isEmpty ? (
                  <EmptyFileTabBody
                    tabId={boundTab.id}
                    treeVisible={treeVisible}
                  />
                ) : (
                  <DesktopSharedFileViewer
                    tabId={boundTab.id}
                    projectId={selectedWorktree.projectId}
                    worktreeId={selectedWorktree.worktreeId}
                    filePath={boundTab.filePath}
                    viewMode={boundTab.fileViewMode ?? 'raw'}
                    active={props.isVisible}
                    searchShortcutActive={props.isActive && props.isVisible}
                    trailingHeaderActions={
                      <FileTabTreeToggleButton
                        tabId={boundTab.id}
                        visible={treeVisible}
                      />
                    }
                    {...(boundTab.recheckAfterWorktreeSetup
                      ? { recheckAfterWorktreeSetup: true }
                      : {})}
                  />
                )}
              </div>
              {treeVisible && (
                <Surface
                  as="aside"
                  variant="section"
                  boundary="left"
                  className="flex w-64 shrink-0 flex-col overflow-hidden"
                  data-testid="file-tab-tree"
                >
                  {treeMode === 'diff' ? (
                    <EmbeddedDiffFileTree
                      projectId={selectedWorktree.projectId}
                      worktreeId={selectedWorktree.worktreeId}
                      tabId={boundTab.id}
                      currentFilePath={boundTab.filePath}
                      onModeChange={setTreeMode}
                    />
                  ) : (
                    <FilesTreeTab
                      key={boundTab.id}
                      projectId={selectedWorktree.projectId}
                      worktreeId={selectedWorktree.worktreeId}
                      uiStateScope={`file-tab:${boundTab.id}`}
                      onTreeModeChange={setTreeMode}
                      searchShortcutActive={false}
                      isVisible={props.isVisible}
                      onOpenFile={handleTreeOpenFile}
                      currentFilePath={isEmpty ? undefined : boundTab.filePath}
                      initialDirectoryPath={
                        isEmpty ? treeDirectoryPath : undefined
                      }
                      revealInitialDirectory={
                        isEmpty &&
                        treeDirectoryPath !== undefined &&
                        treeRevealedPath !== treeDirectoryPath
                      }
                      onInitialDirectoryReveal={(directoryPath): void =>
                        useFileTabUiStore
                          .getState()
                          .markFileTreeRevealed(boundTab.id, directoryPath)
                      }
                      revealCurrentFileInitially={
                        !isEmpty && treeRevealedPath !== boundTab.filePath
                      }
                      onCurrentFileInitialReveal={(filePath): void =>
                        useFileTabUiStore
                          .getState()
                          .markFileTreeRevealed(boundTab.id, filePath)
                      }
                    />
                  )}
                </Surface>
              )}
            </div>
          </>
        ) : fileTabId !== undefined && !worktreeChatLoaded ? (
          <PanelBindingLoadingState />
        ) : (
          <PanelMissingBindingState label="This file is no longer open" />
        )
      ) : (
        <PanelEmptyState />
      )}
    </PanelContentFrame>
  );
});

/**
 * 'terminal' — renders one terminal session directly. The outer workspace
 * panel tab is the terminal tab; there is no nested terminal tab/split bar.
 * An unbound legacy/default panel renders the one-button empty state.
 */
const PanelTerminalContent = memo(function PanelTerminalContent(
  props: PanelContentProps,
): JSX.Element {
  const selectedWorktree = useSelectedWorktree();
  return (
    <PanelContentFrame kind="terminal" panelId={props.panelId}>
      {selectedWorktree ? (
        <TerminalPanelSurface
          projectId={selectedWorktree.projectId}
          worktreeId={selectedWorktree.worktreeId}
          panelId={props.panelId}
          terminalId={props.instance?.terminalId}
          active={props.isActive && props.isVisible}
        />
      ) : (
        <PanelEmptyState />
      )}
    </PanelContentFrame>
  );
});

/**
 * 'activity-section' — renders the real {@link ActivityPanel} (which reads
 * the selected worktree from the chat store itself): the whole sortable
 * section stack. The sections own their auxiliary controllers themselves
 * (dispatch-pipeline modal, diff-viewer/revert modals) and read the settings
 * navigation callback from PanelHostContext, so this wrapper stays thin.
 */
const PanelActivityContent = memo(function PanelActivityContent(
  props: PanelContentProps,
): JSX.Element {
  const selectedWorktree = useSelectedWorktree();
  return (
    <PanelContentFrame kind="activity-section" panelId={props.panelId}>
      {selectedWorktree ? (
        <SharedActivityPanelAdapter worktreeSelection={selectedWorktree} />
      ) : (
        <PanelEmptyState />
      )}
    </PanelContentFrame>
  );
});

/**
 * 'browser' — renders ONE browser session's surface, bound to
 * `instance.browserId`: {@link BrowserPanelSurface} = the BrowserBar plus one
 * native WebContentsView-backed {@link BrowserPane} for exactly that session.
 * Browser panels are repeatable (one per session id) and window-bound: the
 * panes are native views attached to this OS window, so the kind is not
 * poppable.
 *
 * A missing/blank `browserId` is a CONTRACT error (creation/restore paths
 * refuse unbound Browser panels) and renders an inline error state — it must
 * never fall back to the active browser.
 *
 * Browser bounds contract: the native view tracks the pane's DOM rect, so
 * the grid host must invalidate browser view bounds on panel relayouts that
 * MOVE the surface (see dispatchBrowserViewBoundsInvalidated usage in
 * PanelGridSurface) — `isVisible` alone only covers show/hide, not geometry
 * changes; pane RESIZES are covered by BrowserPane's own ResizeObserver.
 */
const PanelBrowserContent = memo(function PanelBrowserContent(
  props: PanelContentProps,
): JSX.Element {
  const selectedWorktree = useSelectedWorktree();
  const hostVisible = usePanelHostState().visible !== false;
  const browserId = props.instance?.browserId?.trim();
  return (
    <PanelContentFrame kind="browser" panelId={props.panelId}>
      {selectedWorktree ? (
        browserId !== undefined && browserId.length > 0 ? (
          <BrowserPanelSurface
            projectId={selectedWorktree.projectId}
            worktreeId={selectedWorktree.worktreeId}
            browserId={browserId}
            visible={props.isVisible && hostVisible}
          />
        ) : (
          <div className="shrink-0 p-2">
            <Notice
              intent="destructive"
              data-testid="panel-browser-unbound"
              className=""
            >
              This Browser panel is missing its session binding.
            </Notice>
          </div>
        )
      ) : (
        <PanelEmptyState />
      )}
    </PanelContentFrame>
  );
});

/**
 * 'file-explorer' — worktree singleton standalone file tree (VS Code's
 * Explorer view): the real {@link FilesTreeTab}, previously the FILES rail
 * tab of the activity panel. Keyed by worktree so the tree remounts (and
 * reloads roots) on selection change, matching the old rail-tab behavior.
 */
const PanelFileExplorerContent = memo(function PanelFileExplorerContent(
  props: PanelContentProps,
): JSX.Element {
  const selectedWorktree = useSelectedWorktree();
  const hostVisible = usePanelHostState().visible !== false;
  return (
    <PanelContentFrame kind="file-explorer" panelId={props.panelId}>
      {selectedWorktree ? (
        <FilesTreeTab
          key={`${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`}
          projectId={selectedWorktree.projectId}
          worktreeId={selectedWorktree.worktreeId}
          searchShortcutActive={props.isActive}
          isVisible={props.isVisible && hostVisible}
        />
      ) : (
        <PanelEmptyState />
      )}
    </PanelContentFrame>
  );
});

/**
 * 'activity-card' — ONE activity section rendered as its own panel, bound to
 * `instance.sectionId` and resolved against {@link ACTIVITY_SECTIONS}. The
 * section renders FRAMELESS — the `ActivitySectionChromeContext` provider
 * re-skins the section's own `PanelSection` wrapper (the single choke point
 * every activity section funnels through) so the card box and the
 * expand/collapse UX are dropped while the header row (title, actions) and
 * content stay intact — inside a padded scroll container so it breathes as a
 * full panel. Unknown/missing section ids (stale persisted layouts) render a
 * neutral empty state.
 */
const PanelActivityCardContent = memo(function PanelActivityCardContent(
  props: PanelContentProps,
): JSX.Element {
  const selectedWorktree = useSelectedWorktree();
  const access = useWorkspaceAccess();
  const sectionId = props.instance?.sectionId;
  // A read-only scope refuses sections outside its access filter, so a
  // published layout cannot mount a write-only card (fails closed).
  const section =
    sectionId !== undefined &&
    isActivitySectionAllowedForAccess(sectionId, access)
      ? getActivitySectionDefinition(sectionId)
      : undefined;
  return (
    <PanelContentFrame kind="activity-card" panelId={props.panelId}>
      {selectedWorktree ? (
        section ? (
          <div
            data-testid={`activity-card-section-${section.id}`}
            className="flex min-h-0 flex-1 flex-col"
          >
            <ActivitySectionChromeContext.Provider value="frameless">
              {section.render({
                projectId: selectedWorktree.projectId,
                worktreeId: selectedWorktree.worktreeId,
              })}
            </ActivitySectionChromeContext.Provider>
          </div>
        ) : (
          <div
            data-testid="activity-card-unknown-section"
            className="flex min-h-0 flex-1"
          >
            <EmptyState
              title="This activity section is no longer available"
              tone="quiet"
              titleWeight="normal"
            />
          </div>
        )
      ) : (
        <PanelEmptyState />
      )}
    </PanelContentFrame>
  );
});

/**
 * 'usage' — the standalone Usage page's provider usage / rate-limit cards,
 * re-flowed for the panel grid and scoped by `instance.variant`
 * (`all` | `active-chat` | `codex` | `claude`). {@link UsagePanel} owns the
 * responsive layout and (for `active-chat`) resolves the worktree's active
 * chat provider. An unknown/missing variant (stale persisted layout) falls
 * back to `all`. Provider usage is global, but the panel still follows the
 * worktree-scoped empty-state convention when no worktree is selected.
 */
const PanelUsageContent = memo(function PanelUsageContent(
  props: PanelContentProps,
): JSX.Element {
  const selectedWorktree = useSelectedWorktree();
  const hostVisible = usePanelHostState().visible !== false;
  const documentVisible = useDocumentVisible(usePanelOwnerDocument());
  const variant = isUsagePanelVariant(props.instance?.variant)
    ? props.instance.variant
    : 'all';
  return (
    <PanelContentFrame kind="usage" panelId={props.panelId}>
      {selectedWorktree ? (
        <UsagePanel
          variant={variant}
          projectId={selectedWorktree.projectId}
          worktreeId={selectedWorktree.worktreeId}
          visible={props.isVisible && hostVisible && documentVisible}
        />
      ) : (
        <PanelEmptyState />
      )}
    </PanelContentFrame>
  );
});

/**
 * Loaded on first use: the Workflows panel reads the Workflows run feed, which
 * startup never needs.
 */
const AutomationsPanel = lazy(() =>
  import('@/components/panels/automations/AutomationsPanel').then((module) => ({
    default: module.AutomationsPanel,
  })),
);

/**
 * 'automations' — the workspace Workflows panel: workflows and watchers
 * (Schedule / Library / Runs), scoped by `instance.variant`
 * (`full` | `upcoming` | `overview` | `completed`). {@link AutomationsPanel}
 * owns section rendering, the worktree-scope toggle, and the add/detail
 * modals. An unknown/missing variant (stale persisted layout) falls back to
 * `full`.
 */
const PanelAutomationsContent = memo(function PanelAutomationsContent(
  props: PanelContentProps,
): JSX.Element {
  const selectedWorktree = useSelectedWorktree();
  const variant = isAutomationsPanelVariant(props.instance?.variant)
    ? props.instance.variant
    : 'full';
  return (
    <PanelContentFrame kind="automations" panelId={props.panelId}>
      {selectedWorktree ? (
        <Suspense fallback={<LoadingRegion layout="fill" />}>
          <AutomationsPanel
            panelId={props.panelId}
            variant={variant}
            projectId={selectedWorktree.projectId}
            worktreeId={selectedWorktree.worktreeId}
          />
        </Suspense>
      ) : (
        <PanelEmptyState />
      )}
    </PanelContentFrame>
  );
});

const LedgerPanelHost = lazy(() =>
  import('@/components/panels/ledger/LedgerPanelHost').then((module) => ({
    default: module.LedgerPanelHost,
  })),
);

const CostPanelHost = lazy(() =>
  import('@/components/panels/cost/CostPanelHost').then((module) => ({
    default: module.CostPanelHost,
  })),
);

const SessionBreakdownPanelHost = lazy(() =>
  import('@/components/panels/session-breakdown/SessionBreakdownPanelHost').then(
    (module) => ({ default: module.SessionBreakdownPanelHost }),
  ),
);

/**
 * The Feed panel while its code loads: nothing for the shared delay, then
 * entry rows in skeleton at the list's own inset, then a note if it is slow.
 */
function LedgerPanelLoading(): JSX.Element {
  return (
    <div
      data-testid="ledger-panel-loading"
      className="flex min-h-0 min-w-0 flex-1 flex-col p-3"
    >
      <DelayedLoadingPlaceholder slowNote="Still loading the Feed…">
        <LedgerThreadListSkeleton density="panel" />
      </DelayedLoadingPlaceholder>
    </div>
  );
}

/**
 * 'ledger' — the Agent Ledger of the panel's own work scope: a Code worktree,
 * or a Cowork or App Advisor Work Entry, including in a detached window. It
 * never follows the global selection. Lazy, so its code stays out of the
 * startup bundle; {@link LedgerPanelHost} reads nothing while the Ledger is
 * off.
 */
const PanelLedgerContent = memo(function PanelLedgerContent(
  props: PanelContentProps,
): JSX.Element {
  const selectedWorktree = useSelectedWorktree();
  return (
    <PanelContentFrame kind="ledger" panelId={props.panelId}>
      {selectedWorktree ? (
        <Suspense fallback={<LedgerPanelLoading />}>
          <LedgerPanelHost
            key={`${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`}
            projectId={selectedWorktree.projectId}
            worktreeId={selectedWorktree.worktreeId}
          />
        </Suspense>
      ) : (
        <PanelEmptyState />
      )}
    </PanelContentFrame>
  );
});

/**
 * 'cost' — the shared Cost view of the panel's owning work scope. The host
 * loads lazily so the cost client and view stay out of the startup bundle.
 */
const PanelCostContent = memo(function PanelCostContent(
  props: PanelContentProps,
): JSX.Element {
  const selectedWorktree = useSelectedWorktree();
  return (
    <PanelContentFrame kind="cost" panelId={props.panelId}>
      {selectedWorktree ? (
        <Suspense
          fallback={
            <LoadingRegion layout="fill" slowNote="Still loading cost…" />
          }
        >
          <CostPanelHost
            key={`${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`}
            projectId={selectedWorktree.projectId}
            worktreeId={selectedWorktree.worktreeId}
          />
        </Suspense>
      ) : (
        <PanelEmptyState />
      )}
    </PanelContentFrame>
  );
});

/**
 * 'session-breakdown' — one chat's shared cost, context and activity view.
 * Its validated chat binding is read from the panel descriptor, not the
 * globally selected chat.
 */
const PanelSessionBreakdownContent = memo(function PanelSessionBreakdownContent(
  props: PanelContentProps,
): JSX.Element {
  const selectedWorktree = useSelectedWorktree();
  const instance = props.instance;
  return (
    <PanelContentFrame kind="session-breakdown" panelId={props.panelId}>
      {selectedWorktree && isSessionBreakdownPanelInstance(instance) ? (
        <Suspense
          fallback={
            <LoadingRegion
              layout="fill"
              slowNote="Still loading session breakdown…"
            />
          }
        >
          <SessionBreakdownPanelHost
            key={`${selectedWorktree.projectId}/${selectedWorktree.worktreeId}/${instance.chatId}`}
            projectId={selectedWorktree.projectId}
            worktreeId={selectedWorktree.worktreeId}
            chatId={instance.chatId}
          />
        </Suspense>
      ) : (
        <PanelEmptyState />
      )}
    </PanelContentFrame>
  );
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Display title for an `activity-card` section id (open-string tolerant:
 * unknown ids from stale layouts fall back to the raw id). Resolved from
 * {@link ACTIVITY_SECTIONS} — the single registration source shared with
 * ActivityPanel's stacked rail — which replaced the old static title map.
 */
export function getActivitySectionTitle(sectionId: string): string {
  return getActivitySectionDefinition(sectionId)?.title ?? sectionId;
}

/**
 * The internal icon an `activity-card` section renders with (open-string
 * tolerant: unknown ids from stale layouts return `undefined`). Resolved from
 * {@link ACTIVITY_SECTIONS} so the standalone panel's tab surfaces the same
 * per-kind icon the section's own card header uses, instead of the generic
 * `activity-card` glyph.
 */
export function getActivitySectionIcon(
  sectionId: string,
): JSX.Element | undefined {
  return getActivitySectionDefinition(sectionId)?.icon;
}

/**
 * All desktop panel definitions, keyed by kind. `browser` is window-bound
 * (native WebContentsView content) and therefore not poppable until Phase 8+
 * reattachment; every other kind is React-rendered and may pop out.
 */
export const DESKTOP_PANEL_DEFINITIONS: Readonly<
  Record<PanelKind, DesktopPanelDefinition>
> = {
  chat: {
    kind: 'chat',
    title: 'Chat',
    icon: <ChatIcon />,
    canPopOut: true,
    isWindowBound: false,
    singleton: SINGLETON_PANEL_KINDS.has('chat'),
    render: (props: PanelContentProps): ReactNode => (
      <PanelChatContent {...props} />
    ),
  },
  'file-diff': {
    kind: 'file-diff',
    title: 'Files',
    icon: <FilesIcon />,
    canPopOut: true,
    isWindowBound: false,
    singleton: SINGLETON_PANEL_KINDS.has('file-diff'),
    render: (props: PanelContentProps): ReactNode => (
      <PanelFileDiffContent {...props} />
    ),
  },
  terminal: {
    kind: 'terminal',
    title: 'Terminal',
    icon: <TerminalIcon />,
    canPopOut: true,
    isWindowBound: false,
    singleton: SINGLETON_PANEL_KINDS.has('terminal'),
    render: (props: PanelContentProps): ReactNode => (
      <PanelTerminalContent {...props} />
    ),
  },
  'activity-section': {
    kind: 'activity-section',
    title: 'Activity',
    icon: <LineChart1Icon />,
    canPopOut: true,
    isWindowBound: false,
    singleton: SINGLETON_PANEL_KINDS.has('activity-section'),
    render: (props: PanelContentProps): ReactNode => (
      <PanelActivityContent {...props} />
    ),
  },
  browser: {
    kind: 'browser',
    title: 'Browser',
    icon: <GlobeIcon />,
    canPopOut: false,
    isWindowBound: true,
    singleton: SINGLETON_PANEL_KINDS.has('browser'),
    render: (props: PanelContentProps): ReactNode => (
      <PanelBrowserContent {...props} />
    ),
  },
  'change-diagram': {
    kind: 'change-diagram',
    title: 'Change Diagram',
    icon: <ChangeDiagramIcon size="sm" />,
    canPopOut: true,
    isWindowBound: false,
    singleton: true,
    render: (props: PanelContentProps): ReactNode => (
      <PanelChangeDiagramContent {...props} />
    ),
  },
  'file-explorer': {
    kind: 'file-explorer',
    title: 'File Explorer',
    icon: <FolderIcon />,
    canPopOut: true,
    isWindowBound: false,
    singleton: SINGLETON_PANEL_KINDS.has('file-explorer'),
    render: (props: PanelContentProps): ReactNode => (
      <PanelFileExplorerContent {...props} />
    ),
  },
  'activity-card': {
    kind: 'activity-card',
    // Default title only; instance-bound tabs display the section title.
    title: 'Activity card',
    icon: <LineChart1Icon />,
    canPopOut: true,
    isWindowBound: false,
    singleton: SINGLETON_PANEL_KINDS.has('activity-card'),
    render: (props: PanelContentProps): ReactNode => (
      <PanelActivityCardContent {...props} />
    ),
  },
  usage: {
    kind: 'usage',
    // Default title only; instance-bound tabs display the variant label
    // ("Usage" / "Usage (Codex)" / …).
    title: 'Usage',
    icon: <DataUsageIcon />,
    canPopOut: true,
    isWindowBound: false,
    singleton: SINGLETON_PANEL_KINDS.has('usage'),
    render: (props: PanelContentProps): ReactNode => (
      <PanelUsageContent {...props} />
    ),
  },
  automations: {
    kind: 'automations',
    // Default title only; instance-bound tabs display the variant label
    // ("Workflows" / "Workflows (Schedule)" / …).
    title: 'Workflows',
    icon: <WorkflowsIcon size="xl" />,
    canPopOut: true,
    isWindowBound: false,
    singleton: SINGLETON_PANEL_KINDS.has('automations'),
    render: (props: PanelContentProps): ReactNode => (
      <PanelAutomationsContent {...props} />
    ),
  },
  'pipeline-execution': {
    kind: 'pipeline-execution',
    // Default title only; the panel binds one run via `instance.executionId`.
    title: PIPELINE_EXECUTION_PANEL_TITLE,
    icon: <PipelineIcon />,
    // React-rendered, so it may move into an auxiliary window.
    canPopOut: true,
    isWindowBound: false,
    // Repeatable per run; `singleton: false` also keeps it out of the add
    // menu, which offers only singleton kinds plus explicit rows.
    singleton: SINGLETON_PANEL_KINDS.has('pipeline-execution'),
    render: (props: PanelContentProps): ReactNode => (
      <PanelPipelineExecutionContent {...props} />
    ),
  },
  plan: {
    kind: 'plan',
    // Default title only; instance-bound tabs display the plan's own title.
    title: 'Plan',
    icon: <PlansIcon />,
    canPopOut: true,
    isWindowBound: false,
    singleton: SINGLETON_PANEL_KINDS.has('plan'),
    render: (props: PanelContentProps): ReactNode => (
      <PanelPlanContent {...props} />
    ),
  },
  'plan-diagram': {
    kind: 'plan-diagram',
    // Default title only; instance-bound tabs display "<plan title> (Diagram)".
    title: 'Plan diagram',
    icon: <ChangeDiagramIcon size="sm" />,
    canPopOut: true,
    isWindowBound: false,
    singleton: SINGLETON_PANEL_KINDS.has('plan-diagram'),
    render: (props: PanelContentProps): ReactNode => (
      <PanelPlanDiagramContent {...props} />
    ),
  },
  'chat-visuals': {
    kind: 'chat-visuals',
    title: CHAT_VISUALS_PANEL_TITLE,
    icon: <ChatVisualsIcon />,
    // A visual renders only in the window that owns its chat, so the panel
    // stays in the main window with it.
    canPopOut: false,
    isWindowBound: false,
    // One per worktree, but opened from a visual and never from the add menu.
    singleton: SINGLETON_PANEL_KINDS.has('chat-visuals'),
    render: (props: PanelContentProps): ReactNode => (
      <PanelChatVisualsContent {...props} />
    ),
  },
  subagents: {
    kind: 'subagents',
    title: SUBAGENTS_PANEL_TITLE,
    icon: <AgentIcon />,
    canPopOut: true,
    isWindowBound: false,
    singleton: SINGLETON_PANEL_KINDS.has('subagents'),
    render: (props: PanelContentProps): ReactNode => (
      <PanelSubagentsContent {...props} />
    ),
  },
  'subagent-chat': {
    kind: 'subagent-chat',
    title: SUBAGENT_CHAT_PANEL_FALLBACK_TITLE,
    icon: <AgentIcon />,
    canPopOut: true,
    isWindowBound: false,
    singleton: SINGLETON_PANEL_KINDS.has('subagent-chat'),
    render: (props: PanelContentProps): ReactNode => (
      <PanelSubagentChatContent {...props} />
    ),
  },
  ledger: {
    kind: 'ledger',
    title: 'Feed',
    icon: <FeedIcon />,
    canPopOut: true,
    isWindowBound: false,
    singleton: SINGLETON_PANEL_KINDS.has('ledger'),
    render: (props: PanelContentProps): ReactNode => (
      <PanelLedgerContent {...props} />
    ),
  },
  cost: {
    kind: 'cost',
    title: 'Cost',
    icon: <CostIcon />,
    canPopOut: true,
    isWindowBound: false,
    singleton: SINGLETON_PANEL_KINDS.has('cost'),
    render: (props: PanelContentProps): ReactNode => (
      <PanelCostContent {...props} />
    ),
  },
  'session-breakdown': {
    kind: 'session-breakdown',
    title: 'Session breakdown',
    icon: <BarChart4BarsIcon />,
    canPopOut: true,
    isWindowBound: false,
    singleton: SINGLETON_PANEL_KINDS.has('session-breakdown'),
    render: (props: PanelContentProps): ReactNode => (
      <PanelSessionBreakdownContent {...props} />
    ),
  },
  'new-tab': {
    kind: 'new-tab',
    title: 'New tab',
    icon: <SquarePlusIcon />,
    // Only a picker: nothing worth its own window.
    canPopOut: false,
    isWindowBound: false,
    singleton: SINGLETON_PANEL_KINDS.has('new-tab'),
    render: (props: PanelContentProps): ReactNode => (
      <PanelContentFrame kind="new-tab" panelId={props.panelId}>
        <PanelNewTabContent {...props} />
      </PanelContentFrame>
    ),
  },
};

/** Looks up the registered definition for a known panel kind. */
export function getPanelDefinition(kind: PanelKind): DesktopPanelDefinition {
  return DESKTOP_PANEL_DEFINITIONS[kind];
}

/**
 * The content-injection function the panel grid host consumes: resolves the
 * open `kind` string against the closed union and renders the registered
 * content. Unknown kinds (corrupt/forward-versioned persisted layouts) render
 * a small inline error box instead of throwing.
 */
export function renderPanelContent(props: PanelContentProps): ReactNode {
  if (!isPanelKind(props.kind)) {
    return (
      <div className="shrink-0 p-2">
        <Notice
          intent="destructive"
          data-testid="panel-unknown-kind"
          className=""
        >
          Unknown panel kind: {props.kind}
        </Notice>
      </div>
    );
  }
  const content = getPanelDefinition(props.kind).render(props);
  return __CANOPY_E2E__ ? (
    <>
      <RenderFaultProbe target={`panel:${props.panelId}`} />
      {content}
    </>
  ) : (
    content
  );
}

// ---------------------------------------------------------------------------
// Add-menu catalog
// ---------------------------------------------------------------------------

/**
 * Named add-menu group for entries that should render together under a labeled
 * section (e.g. the four `usage` variants). Absent for the ungrouped primary
 * entries and the divider-only activity-card section.
 */
export type AddablePanelGroup = 'usage' | 'automations' | 'session-breakdown';

/** One offerable entry of the add-panel menu (kind + optional binding). */
export interface AddablePanelEntry {
  readonly kind: PanelKind;
  /** Per-instance entity binding for instance-bound kinds; absent for singletons. */
  readonly instance?: Readonly<Record<string, string>>;
  /** Menu label (and the added tab's instance title for bound entries). */
  readonly label: string;
  readonly icon: ReactNode;
  /** Labeled section this entry belongs to in the add menu, if any. */
  readonly group?: AddablePanelGroup;
}

/** Last path segment of a file path (menu label for file-diff entries). */
function basenameOf(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, '');
  const separator = Math.max(
    normalized.lastIndexOf('/'),
    normalized.lastIndexOf('\\'),
  );
  return separator === -1 ? normalized : normalized.slice(separator + 1);
}

/**
 * Everything that can be ADDED to `worktreeKey`'s layout right now:
 *
 * 1. singleton kinds (including Cost, and the Ledger while
 *    `canopy-ledger-enabled` is on) not already open
 *    anywhere in the worktree's layout family, plus exactly one `Browser` row
 *    offered wherever the in-app browser is available (not in pop-outs or a
 *    window that shows another computer) — Browser panels are repeatable
 *    (selecting the row creates a fresh session first, then binds a panel to
 *    it — see PanelAddTabMenu's transactional create-then-bind flow), and one
 *    always-offered `Subagents` row that reveals the worktree singleton;
 * 2. every chatStore chat/file tab of the worktree that is not yet open as a
 *    per-entity panel (`chat` → `{ chatTabId }`, `file-diff` →
 *    `{ fileTabId, filePath }`), plus a Session breakdown row for each chat
 *    without one (`session-breakdown` → `{ chatId }`);
 * 3. every Usage variant not yet open as a `usage` panel on either Code or
 *    Cowork (provider usage is global, not Git/worktree-bound), and every
 *    Automations variant not yet open as an `automations` panel;
 * 4. every surface-compatible activity section id not yet open as an
 *    `activity-card`
 *    (`{ sectionId }`).
 *
 * Openness is resolved through the layout store's family-wide instance-key
 * index ({@link findPanelByInstanceKey} + {@link getPanelInstanceKey}), the
 * same uniqueness unit `addTab` enforces.
 */
export function listAddablePanels(
  worktreeKey: string,
  cursorEnabled = useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key),
  copilotEnabled = useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key),
  ledgerEnabled = useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key),
): AddablePanelEntry[] {
  const entries: AddablePanelEntry[] = [];

  // 1. Singleton kinds not open in the family, plus the always-present
  // Browser row (repeatable kind; the menu creates a session on selection)
  // and Subagents row (a singleton whose selection reveals it when open).
  // Terminal profile rows are assembled by PanelAddTabMenu because creating a
  // terminal is likewise a transactional create-then-bind operation.
  for (const kind of PANEL_KINDS) {
    const definition = DESKTOP_PANEL_DEFINITIONS[kind];
    if (
      kind === 'change-diagram' &&
      panelSurfaceForWorktreeKey(worktreeKey) === 'cowork'
    )
      continue;
    if (kind === 'ledger' && !ledgerEnabled) continue;
    if (kind === 'browser') {
      // Not in pop-outs, nor in a window that shows another computer.
      if (isAuxPanelLayoutKey(worktreeKey) || !isInAppBrowserAvailable()) {
        continue;
      }
      entries.push({
        kind,
        label: definition.title,
        icon: definition.icon,
      });
      continue;
    }
    if (kind === 'subagents') {
      entries.push({
        kind,
        label: definition.title,
        icon: definition.icon,
      });
      continue;
    }
    if (!definition.singleton) {
      continue;
    }
    const instanceKey = getPanelInstanceKey({ kind, instance: undefined });
    if (findPanelByInstanceKey(worktreeKey, instanceKey) === null) {
      entries.push({
        kind,
        label: definition.title,
        icon: definition.icon,
      });
    }
  }

  // 2. Chat / file tabs of the worktree without a bound panel.
  const chatTabs =
    useChatStore.getState().worktreeChats[worktreeKey]?.tabs ?? [];
  for (const tab of chatTabs) {
    if (tab.kind === 'file') {
      const instance: Record<string, string> = {
        fileTabId: tab.id,
        ...(tab.filePath !== undefined ? { filePath: tab.filePath } : {}),
      };
      const instanceKey = getPanelInstanceKey({ kind: 'file-diff', instance });
      if (findPanelByInstanceKey(worktreeKey, instanceKey) === null) {
        entries.push({
          kind: 'file-diff',
          instance,
          // An empty file tab ('' path) keeps its stored title ("Open file").
          label: tab.filePath ? basenameOf(tab.filePath) : tab.title,
          icon: DESKTOP_PANEL_DEFINITIONS['file-diff'].icon,
        });
      }
      continue;
    }
    const instance: Record<string, string> = { chatTabId: tab.id };
    const instanceKey = getPanelInstanceKey({ kind: 'chat', instance });
    if (findPanelByInstanceKey(worktreeKey, instanceKey) === null) {
      entries.push({
        kind: 'chat',
        instance,
        label: tab.title,
        icon: DESKTOP_PANEL_DEFINITIONS.chat.icon,
      });
    }
    const breakdownInstance: Record<string, string> = { chatId: tab.id };
    const breakdownKey = getPanelInstanceKey({
      kind: 'session-breakdown',
      instance: breakdownInstance,
    });
    if (findPanelByInstanceKey(worktreeKey, breakdownKey) === null) {
      // Listed by chat name under the menu's `Session breakdown` group.
      entries.push({
        kind: 'session-breakdown',
        instance: breakdownInstance,
        label: tab.title,
        icon: DESKTOP_PANEL_DEFINITIONS['session-breakdown'].icon,
        group: 'session-breakdown',
      });
    }
  }

  // 3. Usage view variants without an open panel. Each variant is a distinct
  // instance of the single `usage` kind, keyed on `instance.variant`, so all
  // variants can coexist while each variant stays deduped.
  for (const variant of USAGE_PANEL_VARIANTS) {
    if (
      (variant === 'cursor' && !cursorEnabled) ||
      (variant === 'copilot' && !copilotEnabled)
    ) {
      continue;
    }
    const instance: Record<string, string> = { variant };
    const instanceKey = getPanelInstanceKey({ kind: 'usage', instance });
    if (findPanelByInstanceKey(worktreeKey, instanceKey) === null) {
      entries.push({
        kind: 'usage',
        instance,
        label: USAGE_PANEL_VARIANT_LABELS[variant],
        icon: DESKTOP_PANEL_DEFINITIONS.usage.icon,
        group: 'usage',
      });
    }
  }

  // 3b. Automations view variants without an open panel. Same shape as the
  // usage block: each variant is a distinct instance of the single
  // `automations` kind, keyed on `instance.variant`.
  for (const variant of AUTOMATIONS_PANEL_VARIANTS) {
    const instance: Record<string, string> = { variant };
    const instanceKey = getPanelInstanceKey({ kind: 'automations', instance });
    if (findPanelByInstanceKey(worktreeKey, instanceKey) === null) {
      entries.push({
        kind: 'automations',
        instance,
        label: AUTOMATIONS_PANEL_VARIANT_LABELS[variant],
        icon: DESKTOP_PANEL_DEFINITIONS.automations.icon,
        group: 'automations',
      });
    }
  }

  // 4. Activity sections without an open card. Iterating the registration
  // source means newly registered sections automatically become addable;
  // per-surface filtering keeps git-bound sections out of the Cowork menu.
  const surface: ActivitySurface =
    panelSurfaceForWorktreeKey(worktreeKey) === 'cowork'
      ? 'cowork'
      : 'worktree';
  for (const section of getActivitySectionsForSurface(surface)) {
    const instance: Record<string, string> = { sectionId: section.id };
    const instanceKey = getPanelInstanceKey({
      kind: 'activity-card',
      instance,
    });
    if (findPanelByInstanceKey(worktreeKey, instanceKey) === null) {
      entries.push({
        kind: 'activity-card',
        instance,
        label: section.title,
        // The section's own icon (unique per kind), matching the panel tab and
        // the section's card header — not the generic `activity-card` glyph.
        icon: section.icon,
      });
    }
  }

  return entries;
}
