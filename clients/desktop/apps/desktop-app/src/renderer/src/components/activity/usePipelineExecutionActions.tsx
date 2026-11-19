import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type RefCallback,
} from 'react';
import { useShallow } from 'zustand/shallow';
import type { AppAdvisorWatcherSummary } from '@canopy/desktop-shared/types';
import type {
  ExecutionState,
  PipelineData,
  PipelinePauseResponse,
} from '@canopy/execution-engine/types/pipeline';
import type { PipelinePluginCollectionRunContext } from './PipelineTriggerModal';
import { dispatchAppAction } from '@/lib/app-actions/dispatcher';
import { extractIpcErrorMessage } from '@/lib/errors';
import { revealChatPanel } from '@/lib/panels/reveal-chat-panel';
import { openTrackedPlan } from '@/lib/plans/open-tracked-plan';
import { resolveSendMessageTargetTab } from '@/stores/chat/context';
import { canRetryExecution, hasRerunReplayData } from '@/lib/execution-actions';
import {
  retainAppAdvisorWatchersBridge,
  useAppAdvisorWatchersStore,
} from '@/stores/appAdvisorWatchersStore';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import type { ToastMeta } from '@/stores/toastStore';
import {
  usePipelineExecutionActionsStore,
  withInFlightId,
} from '@/stores/pipelineExecutionActionsStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { watchersForPipelineExecution } from '@/components/watchers/watcherFilters';
import {
  PipelineExecutionActionDialogs,
  type PipelineExecutionFollowUpDialog,
  type PipelineExecutionReportDialog,
} from './PipelineExecutionActionDialogs';

/**
 * The shared execution-action controller. Every surface that acts on a
 * pipeline run (Activity run rows, the compatibility detail modal, and
 * pipeline execution panels) uses it, so a panel can act on its run without
 * the Activity panel being mounted.
 *
 * Commands act on the execution's own captured scope: its state (read or
 * loaded by id) supplies the project, worktree, working directory, plan, and
 * report, never the worktree that happens to be selected. The single
 * exception is a chat follow-up for a run with no owner, which falls back to
 * the selected worktree's chat because there is nowhere else to send it.
 *
 * In-flight guards live in the renderer-wide `pipelineExecutionActionsStore`
 * and are checked and set synchronously, so concurrent surfaces and double
 * clicks cannot start one action twice.
 */
export interface PipelineExecutionActions {
  readonly cancellingId: string | null;
  readonly resumingId: string | null;
  readonly retryingIds: ReadonlySet<string>;
  readonly rerunningIds: ReadonlySet<string>;
  readonly debuggingFailureId: string | null;
  readonly chatFollowUpInProgress: boolean;
  cancel: (executionId: string) => Promise<void>;
  resume: (
    executionId: string,
    pauseResponses?: readonly PipelinePauseResponse[],
  ) => Promise<void>;
  retry: (executionId: string) => Promise<void>;
  rerun: (executionId: string) => Promise<void>;
  /** Opens App Advisor on a failed run. Resolves true once it opened. */
  debugFailure: (executionId: string) => Promise<boolean>;
  /** Asks the run's worktree chat to review its saved plan. */
  chatFollowUp: (executionId: string) => Promise<void>;
  /** Asks the run's worktree chat to review its saved report. */
  reportChatFollowUp: (executionId: string) => Promise<void>;
  /** Opens the plan-ready pipeline dialog for the run's saved plan. */
  pipelineFollowUp: (executionId: string) => Promise<void>;
  /** Opens the run's report dialog. */
  openReport: (executionId: string) => void;
  /** Opens the run's tracked plan in its own worktree. */
  openPlan: (executionId: string) => Promise<void>;
  /**
   * The report and follow-up dialog host. Render it once in the consuming
   * surface. It renders nothing in place; the dialogs portal into the owner
   * document.
   */
  readonly dialogs: JSX.Element;
  /**
   * Attach to any element of the consuming surface: dialogs open in that
   * element's document, so a surface in an auxiliary window gets them there.
   * Without it (or an explicit `ownerDocument`), dialogs use the main
   * document.
   */
  readonly dialogAnchorRef: RefCallback<HTMLElement>;
}

export interface UsePipelineExecutionActionsOptions {
  /**
   * Document that hosts the report and follow-up dialogs. Defaults to the
   * document of the element attached to `dialogAnchorRef`, captured when a
   * dialog opens, so a surface adopted into another window still opens its
   * dialogs there.
   */
  ownerDocument?: Document;
}

function addPipelineToast(
  message: string,
  type: 'error' | 'info' | 'success',
  caught?: Pick<ToastMeta, 'caught'>,
): void {
  useGitHubStore
    .getState()
    .addToast(message, type, undefined, { category: 'Pipeline', ...caught });
}

function getExecutionPlanPath(state: ExecutionState): string | undefined {
  return (
    state.event_data?.plan_ready?.plan_path ??
    state.event_data?.task_ready?.plan_path
  );
}

function createRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `pipeline-debug-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The run's state from the cache, or one read by id. */
async function resolveExecution(
  executionId: string,
): Promise<ExecutionState | null> {
  const store = usePipelineRunsStore.getState();
  const state =
    store.statesById[executionId] ??
    (await store.loadExecutionDetails(executionId));
  if (!state) {
    addPipelineToast('Failed to load workflow execution details', 'error');
    return null;
  }
  return state;
}

function selectExecutionWorktree(state: ExecutionState): void {
  if (!state.project_id || !state.worktree_id) return;
  const chatStore = useChatStore.getState();
  const selected = chatStore.selectedWorktree;
  if (
    selected?.projectId !== state.project_id ||
    selected?.worktreeId !== state.worktree_id
  ) {
    chatStore.selectWorktree(state.project_id, state.worktree_id);
  }
}

/**
 * Selects the run's own worktree and waits until its chat tabs are loaded,
 * so the follow-up message is not dropped.
 */
async function ensureExecutionChatContext(
  state: ExecutionState,
): Promise<boolean> {
  if (state.project_id && state.worktree_id) {
    selectExecutionWorktree(state);
  } else if (!useChatStore.getState().selectedWorktree) {
    addPipelineToast('No worktree is selected for chat follow-up', 'error');
    return false;
  }

  // selectWorktree fires loadTabs() without awaiting it, and loadTabs()
  // early-returns when a load is already in-flight. Poll until the worktree
  // chat state is actually populated so sendMessage() won't no-op.
  const target =
    state.project_id && state.worktree_id
      ? { projectId: state.project_id, worktreeId: state.worktree_id }
      : useChatStore.getState().selectedWorktree;
  if (!target) return false;
  const targetKey = `${target.projectId}/${target.worktreeId}`;
  const deadline = Date.now() + 5000;
  while (!useChatStore.getState().worktreeChats[targetKey]) {
    if (Date.now() >= deadline) {
      addPipelineToast('Timed out waiting for chat tabs to load', 'error');
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/** The worktree chat scope a follow-up for this run is sent to. */
function followUpChatScope(
  state: ExecutionState,
): { projectId: string; worktreeId: string } | null {
  if (state.project_id && state.worktree_id) {
    return { projectId: state.project_id, worktreeId: state.worktree_id };
  }
  return useChatStore.getState().selectedWorktree;
}

/** How often to look for the chat a send creates while it is in flight. */
const CREATED_CHAT_POLL_MS = 25;

/**
 * Brings the chat that receives a follow-up into view: selects its tab,
 * expands its group, leaves a conflicting maximize, and focuses its window
 * when it is popped out. `sendMessage` writes to the worktree's active chat
 * (or the first writable one, or a new one), and selecting that chat is a
 * no-op for the panel grid when it is already active, so the receiving chat
 * is resolved the same way the send does and revealed explicitly.
 */
function revealFollowUpChat(
  scope: { projectId: string; worktreeId: string } | null,
  sending: () => Promise<void>,
): Promise<void> {
  if (!scope) return sending();
  const scopeKey = `${scope.projectId}/${scope.worktreeId}`;
  const before = useChatStore.getState().worktreeChats[scopeKey];
  const resolution = before
    ? resolveSendMessageTargetTab(before, undefined)
    : ({ kind: 'abort' } as const);
  if (resolution.kind === 'existing') {
    void revealChatPanel({ ...scope, chatId: resolution.chatId });
    return sending();
  }
  if (resolution.kind === 'abort') return sending();
  // The send creates the chat: reveal it as soon as it is the active tab,
  // without waiting for the send itself to finish. The send may first wait
  // for a chat-state refresh, so keep looking for as long as it is in flight
  // and once more after it settles, rather than on a deadline of our own.
  const knownIds = new Set(before?.tabs.map((tab) => tab.id));
  const createdChatId = (): string | null => {
    const wc = useChatStore.getState().worktreeChats[scopeKey];
    return wc && wc.activeTabId && !knownIds.has(wc.activeTabId)
      ? wc.activeTabId
      : null;
  };
  let settled = false;
  const sent = sending().finally(() => {
    settled = true;
  });
  void (async (): Promise<void> => {
    for (;;) {
      // Read `settled` before looking, so the look after it flips is the
      // final one.
      const lastLook = settled;
      const chatId = createdChatId();
      if (chatId !== null) {
        await revealChatPanel({ ...scope, chatId });
        return;
      }
      if (lastLook) return;
      await new Promise((resolve) => setTimeout(resolve, CREATED_CHAT_POLL_MS));
    }
  })();
  return sent;
}

async function sendExecutionFollowUp(
  executionId: string,
  buildMessage: (state: ExecutionState) => string | null,
  missingMessage: string,
): Promise<void> {
  const inFlight = usePipelineExecutionActionsStore.getState();
  if (inFlight.chatFollowUpInProgress) return;
  usePipelineExecutionActionsStore.setState({ chatFollowUpInProgress: true });
  try {
    const state = await resolveExecution(executionId);
    if (!state) return;
    const message = buildMessage(state);
    if (!message) {
      addPipelineToast(missingMessage, 'error');
      return;
    }
    if (!(await ensureExecutionChatContext(state))) return;
    // Re-select the run's worktree immediately before sending in case the
    // user changed selection while its tabs were loading.
    selectExecutionWorktree(state);
    await revealFollowUpChat(followUpChatScope(state), () =>
      useChatStore.getState().sendMessage(message),
    );
  } catch (error: unknown) {
    addPipelineToast(
      error instanceof Error ? error.message : 'Failed to start chat follow-up',
      'error',
      { caught: error },
    );
  } finally {
    usePipelineExecutionActionsStore.setState({
      chatFollowUpInProgress: false,
    });
  }
}

export function usePipelineExecutionActions(
  options: UsePipelineExecutionActionsOptions = {},
): PipelineExecutionActions {
  const { ownerDocument } = options;
  const inFlight = usePipelineExecutionActionsStore(
    useShallow((state) => ({
      cancellingId: state.cancellingId,
      resumingId: state.resumingId,
      retryingIds: state.retryingIds,
      rerunningIds: state.rerunningIds,
      debuggingFailureId: state.debuggingFailureId,
      chatFollowUpInProgress: state.chatFollowUpInProgress,
    })),
  );
  const anchorRef = useRef<HTMLElement | null>(null);
  const dialogAnchorRef = useCallback((element: HTMLElement | null): void => {
    anchorRef.current = element;
  }, []);
  const [report, setReport] = useState<PipelineExecutionReportDialog | null>(
    null,
  );
  const [followUp, setFollowUp] =
    useState<PipelineExecutionFollowUpDialog | null>(null);
  const [followUpRunning, setFollowUpRunning] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  const dialogDocument = useCallback(
    (): Document | undefined =>
      ownerDocument ?? anchorRef.current?.ownerDocument ?? undefined,
    [ownerDocument],
  );

  const cancel = useCallback(async (executionId: string): Promise<void> => {
    if (
      usePipelineExecutionActionsStore.getState().cancellingId === executionId
    )
      return;
    usePipelineExecutionActionsStore.setState({ cancellingId: executionId });
    try {
      await window.pipelines.cancelExecution(executionId);
    } finally {
      usePipelineExecutionActionsStore.setState((state) =>
        state.cancellingId === executionId ? { cancellingId: null } : state,
      );
    }
  }, []);

  const resume = useCallback(
    async (
      executionId: string,
      pauseResponses?: readonly PipelinePauseResponse[],
    ): Promise<void> => {
      if (
        usePipelineExecutionActionsStore.getState().resumingId === executionId
      )
        return;
      usePipelineExecutionActionsStore.setState({ resumingId: executionId });
      try {
        const result = await usePipelineRunsStore
          .getState()
          .resumeExecution(
            executionId,
            pauseResponses?.length
              ? { pauseResponses: [...pauseResponses] }
              : {},
          );
        if (!result.success) {
          addPipelineToast(
            result.error ?? 'Failed to resume execution',
            'error',
          );
        }
      } catch (error: unknown) {
        addPipelineToast(extractIpcErrorMessage(error), 'error', {
          caught: error,
        });
      } finally {
        usePipelineExecutionActionsStore.setState((state) =>
          state.resumingId === executionId ? { resumingId: null } : state,
        );
      }
    },
    [],
  );

  const retry = useCallback(async (executionId: string): Promise<void> => {
    if (
      usePipelineExecutionActionsStore.getState().retryingIds.has(executionId)
    )
      return;
    usePipelineExecutionActionsStore.setState((state) => ({
      retryingIds: withInFlightId(state.retryingIds, executionId, true),
    }));
    try {
      const state = await resolveExecution(executionId);
      if (!state) return;
      if (state.parent_execution_id) {
        addPipelineToast('Only root executions can be retried', 'error');
        return;
      }
      if (!canRetryExecution(state)) {
        addPipelineToast(
          'Only failed or cancelled executions can be retried',
          'error',
        );
        return;
      }
      const result = await usePipelineRunsStore
        .getState()
        .retryExecution(executionId);
      if (!result.success) {
        addPipelineToast(result.error ?? 'Failed to retry execution', 'error');
      }
    } catch (error: unknown) {
      addPipelineToast(extractIpcErrorMessage(error), 'error', {
        caught: error,
      });
    } finally {
      usePipelineExecutionActionsStore.setState((state) => ({
        retryingIds: withInFlightId(state.retryingIds, executionId, false),
      }));
    }
  }, []);

  const rerun = useCallback(async (executionId: string): Promise<void> => {
    if (
      usePipelineExecutionActionsStore.getState().rerunningIds.has(executionId)
    )
      return;
    usePipelineExecutionActionsStore.setState((state) => ({
      rerunningIds: withInFlightId(state.rerunningIds, executionId, true),
    }));
    try {
      const state = await resolveExecution(executionId);
      if (!state) return;
      if (state.parent_execution_id) {
        addPipelineToast('Only root executions can be rerun', 'error');
        return;
      }
      if (
        state.status !== 'success' &&
        state.status !== 'failure' &&
        state.status !== 'cancelled'
      ) {
        addPipelineToast('Only terminal executions can be rerun', 'error');
        return;
      }
      if (!hasRerunReplayData(state)) {
        addPipelineToast(
          'This execution cannot be rerun because its original plan input was not preserved',
          'error',
        );
        return;
      }
      const result = await usePipelineRunsStore
        .getState()
        .rerunExecution(executionId);
      if (!result.success) {
        addPipelineToast(result.error ?? 'Failed to rerun execution', 'error');
      }
    } catch (error: unknown) {
      addPipelineToast(extractIpcErrorMessage(error), 'error', {
        caught: error,
      });
    } finally {
      usePipelineExecutionActionsStore.setState((state) => ({
        rerunningIds: withInFlightId(state.rerunningIds, executionId, false),
      }));
    }
  }, []);

  const debugFailure = useCallback(
    async (executionId: string): Promise<boolean> => {
      if (usePipelineExecutionActionsStore.getState().debuggingFailureId) {
        return false;
      }
      usePipelineExecutionActionsStore.setState({
        debuggingFailureId: executionId,
      });
      try {
        const state = await resolveExecution(executionId);
        if (!state) return false;
        if (state.status !== 'failure') {
          addPipelineToast(
            `Only failed workflow runs can be debugged with ${ORCHESTRATOR_LABEL}`,
            'error',
          );
          return false;
        }
        const response = await dispatchAppAction({
          requestId: createRequestId(),
          source: 'ui',
          action: { type: 'pipeline.debug_run', executionId },
        });
        if (!response.ok) {
          addPipelineToast(
            response.error?.message ??
              `Failed to open ${ORCHESTRATOR_LABEL} for workflow debug`,
            'error',
          );
          return false;
        }
        return true;
      } catch (error: unknown) {
        addPipelineToast(
          error instanceof Error
            ? error.message
            : `Failed to open ${ORCHESTRATOR_LABEL} for workflow debug`,
          'error',
          { caught: error },
        );
        return false;
      } finally {
        usePipelineExecutionActionsStore.setState({ debuggingFailureId: null });
      }
    },
    [],
  );

  const chatFollowUp = useCallback(
    (executionId: string): Promise<void> =>
      sendExecutionFollowUp(
        executionId,
        (state) => {
          const planPath = getExecutionPlanPath(state);
          return planPath ? `Review this plan: ${planPath}` : null;
        },
        'This workflow run does not have a saved plan file',
      ),
    [],
  );

  const reportChatFollowUp = useCallback(
    (executionId: string): Promise<void> =>
      sendExecutionFollowUp(
        executionId,
        (state) => {
          const reportPath =
            state.report_outputs?.report_file ??
            state.report_outputs?.report_json_file;
          return reportPath ? `Review this report: ${reportPath}` : null;
        },
        'This workflow run does not have a saved report file',
      ),
    [],
  );

  const openReport = useCallback(
    (executionId: string): void => {
      const store = usePipelineRunsStore.getState();
      const pipelineName =
        store.summaries.find((summary) => summary.id === executionId)
          ?.pipeline_name ??
        store.statesById[executionId]?.pipeline_snapshot.name ??
        'Workflow run';
      setReport({
        executionId,
        pipelineName,
        ownerDocument: dialogDocument(),
      });
    },
    [dialogDocument],
  );

  const openPlan = useCallback(async (executionId: string): Promise<void> => {
    const state = await resolveExecution(executionId);
    if (!state) return;
    const summary = usePipelineRunsStore
      .getState()
      .summaries.find((entry) => entry.id === executionId);
    const planId = state.planId ?? summary?.planId;
    const projectId = state.project_id ?? summary?.project_id;
    const worktreeId = state.worktree_id ?? summary?.worktree_id;
    if (!planId || !projectId || !worktreeId) {
      addPipelineToast(
        'This workflow run is not linked to a tracked plan',
        'error',
      );
      return;
    }
    // Open (or reveal) the plan in its owning worktree, switching to that
    // worktree when another is shown.
    await openTrackedPlan({ projectId, worktreeId, planId });
  }, []);

  const pipelineFollowUp = useCallback(
    async (executionId: string): Promise<void> => {
      // Capture the dialog document before awaiting: the surface that asked
      // may move or close while the run loads.
      const targetDocument = dialogDocument();
      const state = await resolveExecution(executionId);
      if (!state) return;
      if (!getExecutionPlanPath(state)) {
        addPipelineToast(
          'This workflow run does not have a saved plan file',
          'error',
        );
        return;
      }
      if (!mountedRef.current) return;
      setFollowUpError(null);
      setFollowUp({ execution: state, ownerDocument: targetDocument });
    },
    [dialogDocument],
  );

  const closeFollowUp = useCallback((): void => {
    if (followUpRunning) return;
    setFollowUp(null);
    setFollowUpError(null);
  }, [followUpRunning]);

  const runFollowUp = useCallback(
    async (
      _pipelineId: string,
      pipeline: PipelineData,
      inputs: Record<string, string> | undefined,
      selectedRepoId: string | undefined,
      pluginCollectionContext: PipelinePluginCollectionRunContext,
    ): Promise<void> => {
      const execution = followUp?.execution;
      if (!execution) {
        setFollowUpError('Missing execution context for follow-up run');
        return;
      }
      const planPath = getExecutionPlanPath(execution);
      if (!planPath) {
        setFollowUpError('This workflow run does not have a saved plan file');
        return;
      }

      setFollowUpRunning(true);
      setFollowUpError(null);

      // The follow-up runs in the source run's own worktree.
      let cwd = execution.cwd;
      if (execution.project_id && execution.worktree_id) {
        try {
          cwd = await window.api.getWorktreePath({
            projectId: execution.project_id,
            worktreeId: execution.worktree_id,
            repoId: selectedRepoId,
          });
        } catch (error: unknown) {
          setFollowUpRunning(false);
          setFollowUpError(
            error instanceof Error
              ? error.message
              : 'Failed to resolve worktree path',
          );
          return;
        }
      }

      try {
        const result = await window.pipelines.execute(pipeline.content, {
          cwd,
          pipelineId: pipeline.info.id,
          pipelineFilePath:
            pipeline.info.source === 'project'
              ? pipeline.info.filePath
              : undefined,
          repoPath: pipeline.info.source === 'project' && cwd ? cwd : undefined,
          projectId: execution.project_id,
          worktreeId: execution.worktree_id,
          eventName: 'plan_ready',
          eventData: {
            plan_ready: { plan_path: planPath },
          },
          ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
          pluginCollectionPreferences: pluginCollectionContext.preferences,
          ...(pluginCollectionContext.modelAliasPreferences
            ? {
                modelAliasPreferences:
                  pluginCollectionContext.modelAliasPreferences,
              }
            : {}),
          modelConfig: pluginCollectionContext.modelConfig,
          ...(pluginCollectionContext.pipelinePreferenceLocator
            ? {
                pipelinePreferenceLocator:
                  pluginCollectionContext.pipelinePreferenceLocator,
              }
            : {}),
          ...(pipeline.info.source === 'shared' &&
          pipeline.info.serverId &&
          pipeline.info.remoteId
            ? {
                sharedPipeline: {
                  serverId: pipeline.info.serverId,
                  remoteId: pipeline.info.remoteId,
                },
              }
            : {}),
        });

        if (!result.success) {
          setFollowUpError(result.error ?? 'Workflow execution failed');
          return;
        }
        setFollowUp(null);
        setFollowUpError(null);
      } catch (error: unknown) {
        setFollowUpError(extractIpcErrorMessage(error));
      } finally {
        setFollowUpRunning(false);
      }
    },
    [followUp],
  );

  const closeReport = useCallback((): void => setReport(null), []);

  const dialogs = useMemo(
    () => (
      <PipelineExecutionActionDialogs
        report={report}
        onCloseReport={closeReport}
        followUp={followUp}
        followUpRunning={followUpRunning}
        followUpError={followUpError}
        onCloseFollowUp={closeFollowUp}
        onRunFollowUp={runFollowUp}
      />
    ),
    [
      closeFollowUp,
      closeReport,
      followUp,
      followUpError,
      followUpRunning,
      report,
      runFollowUp,
    ],
  );

  return useMemo(
    () => ({
      ...inFlight,
      cancel,
      resume,
      retry,
      rerun,
      debugFailure,
      chatFollowUp,
      reportChatFollowUp,
      pipelineFollowUp,
      openReport,
      openPlan,
      dialogs,
      dialogAnchorRef,
    }),
    [
      inFlight,
      cancel,
      resume,
      retry,
      rerun,
      debugFailure,
      chatFollowUp,
      reportChatFollowUp,
      pipelineFollowUp,
      openReport,
      openPlan,
      dialogs,
      dialogAnchorRef,
    ],
  );
}

const EMPTY_WATCHERS: AppAdvisorWatcherSummary[] = [];

export interface PipelineExecutionWatcherTarget {
  projectId?: string;
  worktreeId?: string;
  executionId: string;
  pipelineId?: string;
}

/**
 * Active App Advisor watchers for one run. Retains the ref-counted watcher
 * bridge (which also hydrates it) while `target` is set, so a detail works
 * without the Activity panel mounted. Pass `null` to hold no bridge (archived
 * runs have no live watchers).
 */
export function usePipelineExecutionWatchers(
  target: PipelineExecutionWatcherTarget | null,
): AppAdvisorWatcherSummary[] {
  const enabled = target !== null;
  useEffect(() => {
    if (!enabled) return undefined;
    return retainAppAdvisorWatchersBridge();
  }, [enabled]);
  return useAppAdvisorWatchersStore(
    useShallow((s) =>
      target === null
        ? EMPTY_WATCHERS
        : watchersForPipelineExecution(s.watchers, {
            projectId: target.projectId,
            worktreeId: target.worktreeId,
            executionId: target.executionId,
            pipelineId: target.pipelineId,
          }),
    ),
  );
}
