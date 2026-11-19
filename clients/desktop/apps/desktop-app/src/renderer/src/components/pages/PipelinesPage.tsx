import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '../../stores/featureFlagsStore';
import {
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type {
  PipelineEditorOpenLocator,
  PipelineEditorRow,
} from '@canopy/desktop-shared/types';
import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';
import { ChatIcon } from '@canopy/ui-shared/icons';
import {
  usePipelineList,
  type SharedCloudListState,
} from '../../hooks/usePipelineList';
import { PipelineListView } from '../pipeline/PipelineListView';
import { useClearWorkflowsKeyboardTarget } from '../workflows/workflowsTabContext';
import { pipelineAssistantHasConversation } from '../pipeline/pipelineAssistantConversation';
import { PipelineChatPanel } from '../pipeline/PipelineChatPanel';
import type { PipelineAssistantContext } from '../pipeline/pipelineAssistantSuggestions';
import { useCurrentUiStateReporter } from '../../hooks/useCurrentUiStateReporter';
import { useChatStore } from '../../stores/chatStore';
import {
  askNavigationGuard,
  runWithoutNavigationGuard,
  useNavigationStore,
} from '../../stores/navigationStore';
import {
  pipelineEditLinkFromLocator,
  workflowEditKey,
  type WorkflowEditTarget,
} from '@/lib/workflows/edit-target';
import {
  usePipelineEditorBridgeStore,
  type PipelineEditorControllerTarget,
  type PipelineEditorPageController,
} from '../../stores/pipelineEditorBridgeStore';
import {
  PIPELINE_ASSISTANT_OPEN_EVENT,
  consumePipelineAssistantNewChatRequest,
  consumePipelineAssistantOpenRequest,
  requestPipelineAssistantNewChat,
} from '@/lib/pipelineAssistantEvents';
import { startPipelineInterviewChat } from '@/lib/pipelineInterview';
import { WorkflowEditToolbar } from '@canopy/ui-app/workflows';
import { Button, Tooltip } from '@canopy/ui-shared';
import { useWorkflowEditView } from './useWorkflowEditView';
import { workflowEditBackLabel } from '@/lib/workflows/edit-back';
import { WORKFLOW_ITEM_LABEL } from '@canopy/ui-shared/lib/workflow-labels';
import { ResizeRailIndicator } from '@canopy/ui-shared/components';
import { SharePipelineModal } from '../pipeline/SharePipelineModal';
import { useShareAccess } from '../../hooks/useShareAccess';
import { SHARE_PIPELINE_GATE_CONTEXT } from '@/lib/share-gate-context';
import {
  fetchPipelineDocument,
  pipelineInfoToDocumentLocator,
} from '@/lib/pipelineDocument';
import type { PipelineData } from '@canopy/execution-engine/types/pipeline';
import { openCloudAccountSettings } from '@/lib/navigation/settings-destinations';

export type ProjectContext = {
  cwd: string;
  worktree: { projectId: string; worktreeId: string; repoId?: string };
};
type ProjectContextResolution = {
  selectionKey: string;
  context?: ProjectContext;
};

/** Resolves the guard's answer for leaving the shown item; a failure keeps it. */
async function guardAllowsLeaving(): Promise<boolean> {
  const decision = askNavigationGuard('workflows-library');
  if (typeof decision === 'boolean') return decision;
  return decision.catch(() => false);
}

/**
 * Opens `target` in the edit shell once the unsaved-changes guard allows it,
 * for the pipeline assistant's tools, which must learn whether it opened.
 * Resolves the opened target (a new draft carries its key), or null when the
 * person kept editing. The guard also answers "kept editing" when another
 * item replaced its prompt or the shell unmounted, so a tool call never
 * waits on a prompt that is gone.
 */
async function openGuardedWorkflowEdit(
  target: WorkflowEditTarget,
): Promise<WorkflowEditTarget | null> {
  const shown = useNavigationStore.getState().workflowEdit;
  const sameItem =
    shown !== undefined && workflowEditKey(shown) === workflowEditKey(target);
  if (!sameItem && !(await guardAllowsLeaving())) return null;
  runWithoutNavigationGuard((): void =>
    useNavigationStore.getState().openWorkflowEdit(target),
  );
  return useNavigationStore.getState().workflowEdit ?? null;
}

/** Closes the edit shell onto the Library list, asking first when dirty. */
async function leaveWorkflowEditForList(): Promise<boolean> {
  const navigation = useNavigationStore.getState();
  if (navigation.workflowEdit !== undefined && !(await guardAllowsLeaving())) {
    return false;
  }
  runWithoutNavigationGuard((): void => {
    useNavigationStore.getState().navigate('workflows-library');
    useNavigationStore.setState({ workflowEdit: undefined });
  });
  return true;
}

const MIN_PANEL_PERCENT = 20;
const MAX_PANEL_PERCENT = 65;
const DEFAULT_PANEL_PERCENT = 30;
/**
 * Opens a new pipeline draft with a new assistant chat for it (CAN-4319).
 * A person who keeps the open item keeps its chat too.
 */
async function openNewPipelineDraft(): Promise<void> {
  // Asked first, so the edit view's assistant opens on it.
  requestPipelineAssistantNewChat();
  const opened = await openGuardedWorkflowEdit({
    kind: 'pipeline',
    pipelineId: null,
  });
  if (opened === null) consumePipelineAssistantNewChatRequest();
}

/** What the edit shell reports about the open pipeline. */
export interface WorkflowEditDetails {
  readonly title: string;
  readonly readOnly: boolean;
  /** For the assistant's empty chat; absent for a new workflow. */
  readonly assistant?: PipelineAssistantContext;
}

/**
 * The edit view bar's first crumb: where its way back goes. The Library is
 * a tab of the Workflows page, which the crumb names.
 */
function workflowEditCrumbLabel(target: WorkflowEditTarget): string {
  const label = workflowEditBackLabel(target);
  return label === 'Library' ? 'Workflows' : label;
}

interface PipelineAssistantDrawerProps {
  /**
   * `start` leads an open pipeline's edit view (CAN-4319), as its own card;
   * `end` sits beside the Workflows list.
   */
  readonly placement: 'start' | 'end';
  /** A new workflow: its empty chat offers starters. */
  readonly creating: boolean;
  /** The open saved workflow, for what its empty chat offers. */
  readonly assistantContext: PipelineAssistantContext | undefined;
  readonly widthPercent: number;
  /** Hides the list's drawer; the edit view's assistant always shows. */
  readonly onCollapse?: () => void;
}

/** The Pipeline Assistant beside the list or leading an edit view. */
function PipelineAssistantDrawer({
  placement,
  creating,
  assistantContext,
  widthPercent,
  onCollapse,
}: PipelineAssistantDrawerProps): JSX.Element {
  const inEditView = placement === 'start';
  return (
    <div
      // The edit view keeps its chat at every width: it is where a workflow
      // is described and changed. The list's drawer folds away below `lg`.
      className={
        inEditView ? 'min-h-0 shrink-0' : 'hidden min-h-0 shrink-0 lg:block'
      }
      style={{ width: `${widthPercent}%` }}
      data-testid="pipeline-chat-drawer"
      data-placement={placement}
      {...(inEditView ? { 'data-workflow-edit-card': '' } : {})}
    >
      {/* This full-height assistant has no terminal strip below its
          composer. Keep its controls above the shell's bottom status chip
          even while the chip appears or disappears during a turn. */}
      <div className="flex h-full min-h-0 flex-col pb-12">
        <PipelineChatPanel
          {...(onCollapse ? { onCollapse } : {})}
          placement={placement}
          creating={creating}
          {...(assistantContext ? { assistantContext } : {})}
        />
      </div>
    </div>
  );
}

function clampPanelPercent(percent: number): number {
  return Math.min(MAX_PANEL_PERCENT, Math.max(MIN_PANEL_PERCENT, percent));
}

/**
 * Map a `PipelineInfo` row into the transport's source-aware
 * {@link PipelineEditorRow} so the assistant can `open` any visible row. The
 * optional locator fields carry whatever the row's source needs:
 * project rows carry `cwd` + `pipelineFilePath`; shared rows carry
 * `sharedRemoteId`; user/bundled rows are addressed by `pipelineId` alone.
 */
function toPipelineEditorRow(
  info: PipelineInfo,
  cwd: string | undefined,
): PipelineEditorRow {
  return {
    pipelineId: info.id,
    name: info.name,
    source: info.source,
    readonly: info.readonly,
    ...(info.source === 'project' && cwd ? { cwd } : {}),
    ...(info.source === 'project' && info.filePath
      ? { pipelineFilePath: info.filePath }
      : {}),
    ...(info.source === 'shared' && info.remoteId
      ? { sharedRemoteId: info.remoteId }
      : {}),
  };
}

/**
 * What the page's list view works with: the pipelines it loaded and the row
 * handlers it owns. The Workflows Library (CAN-3981) draws its own table from
 * this instead of the page's `PipelineListView`.
 */
export interface PipelinesPageListApi {
  readonly pipelines: readonly PipelineInfo[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly shared: SharedCloudListState;
  readonly refreshSharedList: () => Promise<void>;
  /** Loads the next page of shared pipelines, when there is one. */
  readonly loadMoreSharedList: () => Promise<void>;
  readonly disabledPipelineIds: ReadonlySet<string>;
  readonly setPipelineEnabled: (id: string, enabled: boolean) => Promise<void>;
  /**
   * Opens a new pipeline (CAN-4319): the assistant chat beside the editor,
   * on a new chat, with no choice to make first.
   */
  readonly createNew: () => void;
  /** Starts the AI pipeline interview in a new chat. */
  readonly startInterview: () => void;
  readonly interviewPending: boolean;
  readonly edit: (pipeline: PipelineInfo) => void;
  readonly remove: (pipeline: PipelineInfo) => Promise<void>;
  readonly duplicate: (pipeline: PipelineInfo) => Promise<void>;
  readonly share: (pipeline: PipelineInfo) => void;
  /** Source-qualified `<source>:<id>` of the row whose Share is loading. */
  readonly sharePendingId: string | null;
  readonly shareError: string | null;
  /** The Pipeline Assistant toggle, when its drawer is closed. */
  readonly headerAction: ReactNode;
  /** The Pipeline Assistant drawer beside the list. */
  readonly assistant: {
    readonly open: boolean;
    readonly toggle: () => void;
  };
  /**
   * The open pipeline as the edit shell has loaded it, or `null` to clear
   * it: its name for the page's bar, so a rename shows there before it is
   * saved, and what its assistant's empty chat offers.
   */
  readonly reportEdit: (details: WorkflowEditDetails | null) => void;
  /**
   * Where the edit shell renders its actions: the edit view's bar (CAN-4319).
   * `null` until the bar mounts.
   */
  readonly editActionsTarget: HTMLElement | null;
  /** Project of the selected worktree, for project pipelines. */
  readonly projectId: string | undefined;
  /** The selected worktree's checkout, for project pipelines. */
  readonly projectContext: ProjectContext | undefined;
  /**
   * The selected worktree's checkout is still resolving, so a project
   * pipeline cannot open yet.
   */
  readonly projectContextPending: boolean;
  /**
   * Copies a pipeline and opens the copy, editable, in place of the one it
   * came from. Rejects when no copy was made.
   */
  readonly openDuplicate: (pipeline: PipelineInfo) => Promise<void>;
}

export interface PipelinesPageProps {
  /**
   * Draws the list view. Omit for the page's own `PipelineListView`. The
   * editor, the Pipeline Assistant drawer and the Share dialog stay with the
   * page either way.
   */
  readonly renderList?: (api: PipelinesPageListApi) => ReactNode;
  /**
   * `false` keeps the Pipeline Assistant drawer and its toggle away, except
   * while a pipeline is open in the edit shell.
   */
  readonly assistantEnabled?: boolean;
}

export function PipelinesPage({
  renderList,
  assistantEnabled = true,
}: PipelinesPageProps = {}): JSX.Element {
  const contextEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
  );
  const selectedWorktree = useChatStore((s) => s.selectedWorktree);
  // The edit shell (CAN-4072) shows a pipeline or an automation over the
  // list; this page keeps the assistant drawer beside it.
  const workflowEdit = useNavigationStore((s) => s.workflowEdit);
  const pipelineEditorOpen = workflowEdit?.kind === 'pipeline';
  const selectedWorktreeKey = selectedWorktree
    ? `${selectedWorktree.projectId}\0${selectedWorktree.worktreeId}`
    : undefined;
  const [projectContextResolution, setProjectContextResolution] = useState<
    ProjectContextResolution | undefined
  >(undefined);
  const projectContext =
    selectedWorktreeKey !== undefined &&
    projectContextResolution?.selectionKey === selectedWorktreeKey
      ? projectContextResolution.context
      : undefined;
  const projectContextPending =
    selectedWorktreeKey !== undefined &&
    projectContextResolution?.selectionKey !== selectedWorktreeKey;
  const cwd = projectContext?.cwd;

  // ---------------------------------------------------------------------------
  // Chat drawer visibility + width (persisted via preferences). The drawer is
  // anchored to the right edge and reserves its width so the Pipelines page is
  // centered within the visible region to its left. The saved preference only
  // allows the drawer: it opens by default when the assistant already holds a
  // conversation, so an empty assistant stays closed until the user opens it
  // (CAN-3980). Width falls back to 30% if the field is absent.
  // ---------------------------------------------------------------------------
  const [chatPanelVisible, setChatPanelVisible] = useState(false);
  // An explicit open or toggle before the default resolves wins over it.
  const chatPanelChosenRef = useRef(false);
  const [chatPanelWidthPercent, setChatPanelWidthPercent] = useState(
    DEFAULT_PANEL_PERCENT,
  );
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const latestWidthRef = useRef(chatPanelWidthPercent);
  useEffect(() => {
    latestWidthRef.current = chatPanelWidthPercent;
  }, [chatPanelWidthPercent]);
  const {
    pipelines,
    loading,
    error,
    refresh,
    deletePipeline,
    duplicatePipeline,
    disabledPipelineIds,
    setPipelineEnabled,
    refreshSharedList,
    loadMoreShared,
    deleteSharedPipeline,
    setSharedFilters,
    shared,
  } = usePipelineList(cwd, projectContext?.worktree);

  const [editDetails, reportEdit] = useState<WorkflowEditDetails | null>(null);
  // Where the edit shell puts its actions, in the edit view's bar.
  const [editActionsTarget, setEditActionsTarget] =
    useState<HTMLDivElement | null>(null);
  const editView = useWorkflowEditView(pipelineEditorOpen);
  const editViewOpen = editView.open;
  // CAN-3487: the main "New pipeline" action starts an AI interview in
  // a new Cowork chat. The flag stops a double click from opening two chats.
  const [interviewPending, setInterviewPending] = useState(false);
  const interviewPendingRef = useRef(false);
  const handleStartInterview = useCallback((): void => {
    if (interviewPendingRef.current) return;
    interviewPendingRef.current = true;
    setInterviewPending(true);
    void startPipelineInterviewChat().finally(() => {
      interviewPendingRef.current = false;
      setInterviewPending(false);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const prefs = await window.api.loadPreferences();
        if (cancelled) return;
        setChatPanelWidthPercent(
          clampPanelPercent(
            prefs.pipelineChatPanelWidthPercent ?? DEFAULT_PANEL_PERCENT,
          ),
        );
        if (prefs.pipelineChatPanelVisible === false) return;
        const hasConversation = await pipelineAssistantHasConversation(
          prefs.pipelineEditorPluginSelections,
        );
        if (cancelled || chatPanelChosenRef.current) return;
        setChatPanelVisible(hasConversation);
      } catch {
        // Keep the drawer closed and the default width on load failure.
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, []);

  const handleToggleChatPanel = useCallback((): void => {
    chatPanelChosenRef.current = true;
    setChatPanelVisible((prev) => {
      const next = !prev;
      void window.api
        .savePreferences({ pipelineChatPanelVisible: next })
        .catch(() => {
          // Local state still applies even if the save fails.
        });
      return next;
    });
  }, []);

  useEffect(() => {
    const handleOpenAssistant = (): void => {
      consumePipelineAssistantOpenRequest();
      chatPanelChosenRef.current = true;
      setChatPanelVisible(true);
      void window.api
        .savePreferences({ pipelineChatPanelVisible: true })
        .catch(() => {
          // Local state still applies even if the save fails.
        });
    };
    // A request made before this page mounted (the caller navigated here).
    if (consumePipelineAssistantOpenRequest()) handleOpenAssistant();
    window.addEventListener(PIPELINE_ASSISTANT_OPEN_EVENT, handleOpenAssistant);
    return (): void => {
      window.removeEventListener(
        PIPELINE_ASSISTANT_OPEN_EVENT,
        handleOpenAssistant,
      );
    };
  }, []);

  const updateWidthFromPointer = useCallback((clientX: number): void => {
    const container = containerRef.current;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    if (bounds.width <= 0) return;
    // The edit view's chat is on the left edge, so its width is
    // pointer − left edge; the drawer is on the right, right edge − pointer.
    if (editView.openRef.current) {
      const percent = ((clientX - bounds.left) / bounds.width) * 100;
      editView.setChatPercent(clampPanelPercent(percent));
      return;
    }
    const percent = ((bounds.right - clientX) / bounds.width) * 100;
    setChatPanelWidthPercent(clampPanelPercent(percent));
  }, []);

  const handleResizeMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      event.preventDefault();
      setIsResizing(true);
      updateWidthFromPointer(event.clientX);
    },
    [updateWidthFromPointer],
  );

  useEffect((): (() => void) | undefined => {
    if (!isResizing) return undefined;

    const handleMouseMove = (event: globalThis.MouseEvent): void => {
      updateWidthFromPointer(event.clientX);
    };
    const handleMouseUp = (): void => {
      setIsResizing(false);
      // The edit view's split is not the drawer's saved width.
      if (editView.openRef.current) return;
      void window.api
        .savePreferences({
          pipelineChatPanelWidthPercent: latestWidthRef.current,
        })
        .catch(() => {
          // Local state still applies even if the save fails.
        });
    };

    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return (): void => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
    };
  }, [isResizing, updateWidthFromPointer]);

  useEffect(() => {
    let cancelled = false;

    async function loadCwd(): Promise<void> {
      if (!selectedWorktree) {
        setProjectContextResolution(undefined);
        return;
      }

      try {
        const worktree = {
          projectId: selectedWorktree.projectId,
          worktreeId: selectedWorktree.worktreeId,
        };
        const nextCwd = await window.api.getWorktreePath({
          projectId: worktree.projectId,
          worktreeId: worktree.worktreeId,
        });
        if (!cancelled) {
          setProjectContextResolution({
            selectionKey: `${worktree.projectId}\0${worktree.worktreeId}`,
            context: { cwd: nextCwd, worktree },
          });
        }
      } catch {
        if (!cancelled) {
          setProjectContextResolution({
            selectionKey: `${selectedWorktree.projectId}\0${selectedWorktree.worktreeId}`,
          });
        }
      }
    }

    void loadCwd();
    return (): void => {
      cancelled = true;
    };
  }, [selectedWorktree]);

  // ---------------------------------------------------------------------------
  // Row-level Share. The page owns the modal (mirroring `AutomationsPage`); a
  // row only raises the request. A list row carries `PipelineInfo`, so the full
  // definition is fetched on demand through the same source dispatch the editor
  // uses.
  // ---------------------------------------------------------------------------
  const { requestShare, shareGateModal } = useShareAccess();
  const [shareTarget, setShareTarget] = useState<PipelineData | null>(null);
  // Source-qualified (`<source>:<id>`), matching how rows are keyed: pipeline
  // ids are only unique per source, so a bare id would mark every same-id row
  // across sources as pending.
  const [sharePendingId, setSharePendingId] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);

  // Row Share loads the full pipeline document asynchronously while every other
  // row's Share button stays clickable, so two in-flight loads can race. Only
  // the most recent request may touch page state: without this guard a slow
  // first load can resolve last and silently retarget the open share modal at a
  // pipeline the user did not pick — one click from publishing the wrong one.
  // Same pattern as `SharePipelineModal`'s `analysisSeq`/`teamReqSeq` and
  // `usePipelineEditor`'s `cancelled` flag.
  const shareSeqRef = useRef(0);
  // `requestShare` never runs `proceed` synchronously: the connected path
  // defers it behind an account load, and the gated path defers it until the
  // user closes the cloud-connect modal. A `proceed` that lands after the page
  // left the list would allocate a *fresh* seq and therefore look current to
  // the guard below, so the seq check alone cannot cover it.
  const listViewActiveRef = useRef(true);

  const handleRowShare = useCallback(
    (info: PipelineInfo): void => {
      setShareError(null);
      // ALLOCATE the sequence here, at request time — do not merely snapshot it.
      // `requestShare` runs an independent async chain per call with no dedupe,
      // and no Share button is disabled while its gate is open, so two rows can
      // be gated at once. Allocating here makes the ordering click order: each
      // click claims a strictly higher number, so an earlier click is already
      // stale by the time its gate resolves and the LAST click wins regardless
      // of which gate resolves first. Merely snapshotting would let both clicks
      // capture the same value, hand the win to whichever IPC returned first,
      // and silently drop the other click.
      //
      // Leaving the list also bumps `shareSeqRef`, so the same comparison
      // cancels a request still sitting behind the gate when the user navigated
      // away — including one whose gate modal survived a round trip back to the
      // list, where the `listViewActiveRef` check alone would let it through.
      const requestSeq = ++shareSeqRef.current;
      requestShare(SHARE_PIPELINE_GATE_CONTEXT, () => {
        if (!listViewActiveRef.current || requestSeq !== shareSeqRef.current) {
          return;
        }
        const seq = requestSeq;
        setSharePendingId(`${info.source}:${info.id}`);
        void (async (): Promise<void> => {
          try {
            const loaded = await fetchPipelineDocument(info, cwd);
            if (seq !== shareSeqRef.current) {
              return;
            }
            if (loaded.error !== undefined || !loaded.data) {
              setShareError(loaded.error ?? 'Failed to load workflow');
              return;
            }
            setShareTarget(loaded.data);
          } finally {
            if (seq === shareSeqRef.current) {
              setSharePendingId(null);
            }
          }
        })();
      });
    },
    [cwd, requestShare],
  );

  // Leaving the list (into the editor or a draft) must abandon any in-flight
  // row-Share load, otherwise a late resolve stacks this page-owned modal on
  // top of the editor's own SharePipelineModal.
  const listViewActive = workflowEdit === undefined;
  useClearWorkflowsKeyboardTarget(!listViewActive);
  useEffect(() => {
    const wasActive = listViewActiveRef.current;
    listViewActiveRef.current = listViewActive;
    if (listViewActive) {
      // Back from the shell: a save, rename or create there changed the list.
      if (!wasActive) void refresh();
      return;
    }
    shareSeqRef.current += 1;
    setSharePendingId(null);
    setShareTarget(null);
    setShareError(null);
  }, [listViewActive, refresh]);

  // ---------------------------------------------------------------------------
  // Page-mode controller registration for the renderer live-edit bridge. The
  // controller is registered once and reads the latest list/cwd through refs
  // so the bridge can open/list any visible row and navigate the edit shell.
  // ---------------------------------------------------------------------------
  const registerPageController = usePipelineEditorBridgeStore(
    (s) => s.registerPageController,
  );
  const unregisterPageController = usePipelineEditorBridgeStore(
    (s) => s.unregisterPageController,
  );
  const pipelinesRef = useRef(pipelines);
  pipelinesRef.current = pipelines;
  const sharedRowsRef = useRef(shared.rows);
  sharedRowsRef.current = shared.rows;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const controller: PipelineEditorPageController = {
      openEditor: (locator: PipelineEditorOpenLocator): Promise<boolean> =>
        openGuardedWorkflowEdit({
          kind: 'pipeline',
          pipelineId: locator.pipelineId ?? null,
          ...(locator.cwd !== undefined ? { cwd: locator.cwd } : {}),
          ...(locator.pipelineFilePath !== undefined
            ? { filePath: locator.pipelineFilePath }
            : {}),
          ...(locator.sharedRemoteId !== undefined
            ? { sharedRemoteId: locator.sharedRemoteId }
            : {}),
        }).then((opened) => opened !== null),
      openNewDraft:
        async (): Promise<PipelineEditorControllerTarget | null> => {
          const opened = await openGuardedWorkflowEdit({
            kind: 'pipeline',
            pipelineId: null,
          });
          return opened?.kind === 'pipeline'
            ? {
                pipelineId: null,
                ...(opened.draftKey !== undefined
                  ? { draftKey: opened.draftKey }
                  : {}),
              }
            : null;
        },
      goToList: async (): Promise<boolean> => {
        const left = await leaveWorkflowEditForList();
        if (left) void refreshRef.current();
        return left;
      },
      getPipelineRows: (): PipelineEditorRow[] => {
        const currentCwd = cwdRef.current;
        return [
          // `pipelines` already merges user/bundled/project rows.
          ...pipelinesRef.current.map((info) =>
            toPipelineEditorRow(info, currentCwd),
          ),
          // Shared rows live in a separate cloud-backed substate, so merge the
          // rows currently loaded (the cloud list paginates via loadMoreShared).
          ...sharedRowsRef.current.map((info) =>
            toPipelineEditorRow(info, currentCwd),
          ),
        ];
      },
    };
    registerPageController(controller);
    return (): void => {
      unregisterPageController(controller);
    };
  }, [registerPageController, unregisterPageController]);

  // `electron-no-drag` on the button is load-bearing: the list view scrolls
  // under the main shell's top-40px OS window-drag rect
  // (`app-main-titlebar-drag-region` in App.tsx), and app-region hit testing
  // ignores z-order, so this control can end up inside a drag region and
  // receive a window drag instead of a click. See PipelineChatPanel, whose
  // header sits in that band unconditionally.
  const chatToggle = (
    <span className="electron-no-drag inline-flex">
      <Tooltip
        label={
          chatPanelVisible
            ? 'Hide workflow assistant'
            : 'Show workflow assistant'
        }
      >
        <Button
          variant={chatPanelVisible ? 'ghost' : 'secondary'}
          size="compact"
          iconOnly
          onClick={handleToggleChatPanel}
          aria-label={
            chatPanelVisible
              ? 'Hide workflow assistant'
              : 'Show workflow assistant'
          }
          aria-pressed={chatPanelVisible}
          data-testid="pipeline-chat-toggle"
        >
          <ChatIcon size="sm" aria-hidden="true" />
        </Button>
      </Tooltip>
    </span>
  );

  // An open pipeline always shows its assistant; the list shows the drawer
  // when it is chosen.
  const assistantVisible =
    editViewOpen || (chatPanelVisible && assistantEnabled);
  const headerAction = assistantVisible ? undefined : chatToggle;
  // What is on screen, not the drawer's saved choice: an edit view shows its
  // chat whatever that choice is, and focused-chat interest reads this to
  // keep the visible assistant streaming.
  useCurrentUiStateReporter('pipelines.chatPanel', {
    visible: assistantVisible,
    widthPercent: Math.round(chatPanelWidthPercent),
  });
  // Throws when nothing was deleted, so the caller's dialog stays open.
  const handleRowDelete = async (pipeline: PipelineInfo): Promise<void> => {
    const deleted =
      pipeline.source === 'shared'
        ? pipeline.remoteId !== undefined &&
          (await deleteSharedPipeline(pipeline.remoteId))
        : await deletePipeline(pipeline.id);
    if (!deleted) throw new Error('The workflow could not be deleted.');
  };
  const handleRowEdit = (pipeline: PipelineInfo): void =>
    // Share and Edit must resolve a row to the same document; both go
    // through `pipelineInfoToDocumentLocator` so they cannot drift.
    useNavigationStore
      .getState()
      .openPipelineEdit(
        pipelineEditLinkFromLocator(
          pipelineInfoToDocumentLocator(pipeline, cwd),
        ),
      );
  const handleOpenDuplicate = async (pipeline: PipelineInfo): Promise<void> => {
    const origin = useNavigationStore.getState().workflowEdit;
    const originKey = origin === undefined ? null : workflowEditKey(origin);
    const copy = await duplicatePipeline(pipeline);
    if (!copy) throw new Error('The workflow could not be duplicated.');
    // The copy is the user's own, so it opens editable. Back from it returns
    // to where the original would have. A user who left while the copy was
    // made stays where they went.
    const shown = useNavigationStore.getState().workflowEdit;
    if ((shown === undefined ? null : workflowEditKey(shown)) !== originKey) {
      return;
    }
    useNavigationStore.getState().replaceWorkflowEdit({
      kind: 'pipeline',
      ...pipelineEditLinkFromLocator(pipelineInfoToDocumentLocator(copy, cwd)),
      ...(shown?.returnTo !== undefined ? { returnTo: shown.returnTo } : {}),
    });
  };
  const createNew = (): void => {
    void openNewPipelineDraft();
  };
  // The bar's first crumb goes where the editor's Back would, asking first
  // about unsaved work.
  const leaveEditView = (): void => {
    useNavigationStore.getState().closeWorkflowEdit();
  };

  const mainContent = renderList ? (
    renderList({
      pipelines,
      loading,
      error,
      refresh,
      shared,
      refreshSharedList,
      loadMoreSharedList: loadMoreShared,
      disabledPipelineIds,
      setPipelineEnabled,
      createNew,
      startInterview: handleStartInterview,
      interviewPending,
      edit: handleRowEdit,
      remove: handleRowDelete,
      duplicate: async (pipeline) => {
        const copy = await duplicatePipeline(pipeline);
        // The Library raises this as the reason under `Couldn't duplicate …`.
        if (!copy) throw new Error('No copy was made.');
      },
      share: handleRowShare,
      sharePendingId,
      shareError,
      headerAction,
      assistant: {
        open: assistantVisible,
        toggle: handleToggleChatPanel,
      },
      reportEdit,
      editActionsTarget,
      projectId: projectContext?.worktree.projectId,
      projectContext,
      projectContextPending,
      openDuplicate: handleOpenDuplicate,
    })
  ) : (
    <PipelineListView
      onOpenImported={(id) =>
        useNavigationStore
          .getState()
          .openPipelineEdit({ pipelineId: id, source: 'user' })
      }
      pipelines={pipelines}
      loading={loading}
      error={error}
      onRefresh={refresh}
      onCreateNew={createNew}
      onStartInterview={handleStartInterview}
      interviewPending={interviewPending}
      onEdit={handleRowEdit}
      onDelete={async (id) => {
        await deletePipeline(id);
      }}
      onDuplicate={async (pipeline) => {
        await duplicatePipeline(pipeline);
      }}
      onShare={handleRowShare}
      sharePendingId={sharePendingId}
      actionError={shareError}
      disabledPipelineIds={disabledPipelineIds}
      onToggleEnabled={setPipelineEnabled}
      sharedState={shared}
      onSharedActivate={() => {
        void refreshSharedList();
      }}
      onSharedRefresh={refreshSharedList}
      onLoadMoreShared={loadMoreShared}
      onSharedFilterChange={setSharedFilters}
      onSharedDelete={async (remoteId) => {
        await deleteSharedPipeline(remoteId);
      }}
      onOpenAccountSettings={() => openCloudAccountSettings()}
      headerAction={headerAction}
    />
  );

  const drawerWidthPercent = editViewOpen
    ? editView.chatPercent
    : chatPanelWidthPercent;
  const drawer = assistantVisible ? (
    <PipelineAssistantDrawer
      placement={editViewOpen ? 'start' : 'end'}
      creating={
        workflowEdit?.kind === 'pipeline' && workflowEdit.pipelineId === null
      }
      assistantContext={editViewOpen ? editDetails?.assistant : undefined}
      widthPercent={drawerWidthPercent}
      {...(editViewOpen ? {} : { onCollapse: handleToggleChatPanel })}
    />
  ) : null;
  const resizeRail = !assistantVisible ? null : editViewOpen ? (
    // The gap between the edit view's cards resizes them the way a
    // worktree's panel gaps do: the same sash, whose handle shows on hover.
    <div
      className={`canopy-sash vertical -translate-x-1/2 [--canopy-sash-size:8px] ${isResizing ? 'active' : ''}`}
      style={{
        left: `calc(${drawerWidthPercent}% + var(--inset-card-gap, 0px) / 2)`,
      }}
      onMouseDown={handleResizeMouseDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize workflow assistant"
      aria-valuemin={MIN_PANEL_PERCENT}
      aria-valuemax={MAX_PANEL_PERCENT}
      aria-valuenow={Math.round(drawerWidthPercent)}
    />
  ) : (
    <div
      className="group absolute inset-y-0 z-30 hidden w-2 translate-x-1/2 cursor-col-resize items-stretch justify-center lg:flex"
      style={{ right: `${drawerWidthPercent}%` }}
      onMouseDown={handleResizeMouseDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize workflow assistant"
      aria-valuemin={MIN_PANEL_PERCENT}
      aria-valuemax={MAX_PANEL_PERCENT}
      aria-valuenow={Math.round(drawerWidthPercent)}
    >
      <ResizeRailIndicator active={isResizing} />
    </div>
  );
  const main = (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="pipelines-main"
      {...(editViewOpen ? { 'data-workflow-edit-card': '' } : {})}
    >
      {mainContent}
    </div>
  );

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      data-testid="page-pipelines-root"
    >
      {/* An open pipeline is laid out like a worktree page (CAN-4319): its
          bar sits in the window's top bar row with where the person is, the
          way back and the workflow's actions, and the assistant and the
          editor below it are two cards. */}
      {editViewOpen && workflowEdit !== undefined ? (
        <WorkflowEditToolbar
          backLabel={workflowEditCrumbLabel(workflowEdit)}
          onLeave={leaveEditView}
          actionsRef={setEditActionsTarget}
          {...(editDetails !== null
            ? { title: editDetails.title, privateTitle: true }
            : {
                title:
                  workflowEdit.kind === 'pipeline' &&
                  workflowEdit.pipelineId === null
                    ? 'New workflow'
                    : WORKFLOW_ITEM_LABEL,
              })}
        />
      ) : null}
      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1"
        {...(editViewOpen ? { 'data-testid': 'workflow-edit-cards' } : {})}
      >
        {editViewOpen ? drawer : null}
        {main}
        {resizeRail}
        {editViewOpen ? null : drawer}
      </div>

      {shareGateModal}
      {/* Gated on the list view as well as on `shareTarget`: this modal is
          page-owned and renders outside `mainContent`, so without the gate a
          late share resolution could stack it on top of the editor's own
          `SharePipelineModal`. */}
      {listViewActive && shareTarget && (
        <SharePipelineModal
          pipeline={shareTarget.content}
          localPipelineInfo={shareTarget.info}
          {...(contextEnabled && shareTarget.info.source === 'project'
            ? { worktree: projectContext?.worktree }
            : {})}
          onClose={() => setShareTarget(null)}
          onOpenAccountSettings={() => openCloudAccountSettings()}
          onShared={() => {
            // A successful share adds a Shared row and updates the local
            // pipeline's sharing metadata, so both lists need refreshing.
            // The dialog stays open on its success notice until Done.
            void refresh();
            void refreshSharedList();
          }}
          onPublicLinkRemoved={() => void refreshSharedList()}
        />
      )}
    </div>
  );
}
