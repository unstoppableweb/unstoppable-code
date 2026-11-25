import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { ErrorBanner } from '@canopy/ui-shared/components';
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
import {
  revealChatPanel,
  type ChatPanelRevealTarget,
} from '@/lib/panels/reveal-chat-panel';
import { openTrackedPlan } from '@/lib/plans/open-tracked-plan';
import { canRetryExecution, hasRerunReplayData } from '@/lib/execution-actions';
import {
  retainAppAdvisorWatchersBridge,
  useAppAdvisorWatchersStore,
} from '@/stores/appAdvisorWatchersStore';
import { useChatStore } from '@/stores/chatStore';
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
  chatFollowUp: (executionId: string) => Promise<boolean>;
  /** Asks the run's worktree chat to review its saved report. */
  reportChatFollowUp: (executionId: string) => Promise<boolean>;
  /** Opens the plan-ready pipeline dialog for the run's saved plan. */
  pipelineFollowUp: (executionId: string) => Promise<void>;
  /** Opens the run's report dialog. */
  openReport: (executionId: string) => void;
  /** Opens the run's tracked plan in its own worktree. */
  openPlan: (executionId: string) => Promise<boolean>;
  /**
   * The report and follow-up dialog host. Render it once in the consuming
   * surface. It renders nothing in place; the dialogs portal into the owner
   * document.
   */
  readonly dialogs: JSX.Element;
  /**
   * Place next to the workflow controls. A detail supplies its guarded chat
   * navigation callback so a successful recovery also closes a covering modal.
   */
  renderActionError: (
    scope?: string | ReadonlySet<string>,
    onChatRevealed?: () => void,
  ) => JSX.Element | null;
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

interface RunActionError {
  readonly message: string;
  readonly reported: boolean;
}

type RunAction =
  | 'resume'
  | 'retry'
  | 'rerun'
  | 'debug'
  | 'plan'
  | 'workflow'
  | 'plan-chat'
  | 'report-chat';

type ShowActionError = (
  message: string,
  recordResult?: boolean,
  openChat?: () => Promise<boolean>,
) => void;

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
  showError: ShowActionError,
): Promise<ExecutionState | null> {
  const store = usePipelineRunsStore.getState();
  const state =
    store.statesById[executionId] ??
    (await store.loadExecutionDetails(executionId));
  if (!state) {
    showError('Failed to load workflow execution details', true);
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
  showError: ShowActionError,
): Promise<boolean> {
  if (state.project_id && state.worktree_id) {
    selectExecutionWorktree(state);
  } else if (!useChatStore.getState().selectedWorktree) {
    showError('No worktree is selected for chat follow-up');
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
      showError('Timed out waiting for chat tabs to load', true);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/** Reveal failure is recovered locally without sending the accepted message again. */
async function revealFollowUpTarget(
  target: ChatPanelRevealTarget,
): Promise<boolean> {
  const [result] = await Promise.allSettled([revealChatPanel(target)]);
  return result.status === 'fulfilled' && result.value;
}

/**
 * Keep the run visible until admission answers. The send may outlive that
 * answer, so observe its promise but let an explicit acceptance reveal the
 * chat immediately. The first admission outcome is authoritative.
 */
function dispatchFollowUpMessage(
  message: string,
): Promise<ChatPanelRevealTarget | undefined> {
  return new Promise<ChatPanelRevealTarget | undefined>((resolve, reject) => {
    let recipient: ChatPanelRevealTarget | undefined;
    const rejectDispatch = (): void => {
      reject(new Error('The chat could not accept this workflow follow-up'));
    };
    void useChatStore
      .getState()
      .sendMessage(message, undefined, undefined, undefined, {
        onTargetResolved: (target): void => {
          recipient = target;
        },
        onDispatchAccepted: (): void => resolve(recipient),
        onDispatchRejected: rejectDispatch,
        onPreDispatchRejected: rejectDispatch,
        throwOnDispatchFailure: true,
        suppressDispatchErrorToast: true,
      })
      // A completed send is the compatibility acknowledgment when no callback
      // fires. Consume a later rejection after an authoritative callback too.
      .then(() => resolve(recipient), reject);
  });
}

/**
 * Brings the chat that receives a follow-up into view: selects its tab,
 * expands its group, leaves a conflicting maximize, and focuses its window
 * when it is popped out. The send captures its actual recipient before
 * admission, so changing selection while it waits cannot redirect this reveal
 * or the later recovery to a different chat.
 */
async function revealFollowUpChat(
  sending: () => Promise<ChatPanelRevealTarget | undefined>,
  onTarget?: (target: ChatPanelRevealTarget) => void,
): Promise<boolean> {
  const target = await sending();
  if (!target) return false;
  onTarget?.(target);
  return revealFollowUpTarget(target);
}

async function sendExecutionFollowUp(
  executionId: string,
  buildMessage: (state: ExecutionState) => string | null,
  missingMessage: string,
  action: RunAction,
  beginAction: (executionId: string, action: RunAction) => ShowActionError,
): Promise<boolean> {
  const inFlight = usePipelineExecutionActionsStore.getState();
  if (inFlight.chatFollowUpInProgress) return false;
  const showError = beginAction(executionId, action);
  usePipelineExecutionActionsStore.setState({ chatFollowUpInProgress: true });
  try {
    const state = await resolveExecution(executionId, showError);
    if (!state) return false;
    const message = buildMessage(state);
    if (!message) {
      showError(missingMessage);
      return false;
    }
    if (!(await ensureExecutionChatContext(state, showError))) return false;
    // Re-select the run's worktree immediately before sending in case the
    // user changed selection while its tabs were loading.
    selectExecutionWorktree(state);
    let target: ChatPanelRevealTarget | undefined;
    const revealed = await revealFollowUpChat(
      () => dispatchFollowUpMessage(message),
      (resolvedTarget) => {
        target = resolvedTarget;
      },
    );
    if (!revealed) {
      const sentTarget = target;
      // Recovery opens the accepted send's chat; it must never send it again.
      showError(
        'Follow-up sent, but the chat could not be opened',
        true,
        sentTarget
          ? (): Promise<boolean> => revealFollowUpTarget(sentTarget)
          : undefined,
      );
      return false;
    }
    return true;
  } catch (error: unknown) {
    reportClientAppError(error);
    showError(
      error instanceof Error ? error.message : 'Failed to start chat follow-up',
    );
    return false;
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
  const [followUpError, setFollowUpError] = useState<RunActionError | null>(
    null,
  );
  const [actionErrors, setActionErrors] = useState(
    () =>
      new Map<
        string,
        {
          executionId: string;
          message: string;
          openChat?: () => Promise<boolean>;
        }
      >(),
  );
  const dismissActionError = useCallback((key: string): void => {
    setActionErrors((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }, []);
  const beginAction = useCallback(
    (executionId: string, action: RunAction): ShowActionError => {
      const key = `${executionId}:${action}`;
      dismissActionError(key);
      return (message, recordResult = false, openChat): void => {
        if (recordResult) {
          reportClientAppError(
            new Error(`Workflow run action failed: ${action}`),
          );
        }
        setActionErrors((current) =>
          new Map(current).set(key, { executionId, message, openChat }),
        );
      };
    },
    [dismissActionError],
  );
  const renderActionError = useCallback(
    (
      scope?: string | ReadonlySet<string>,
      onChatRevealed?: () => void,
    ): JSX.Element | null => {
      const visible = [...actionErrors].filter(
        ([, error]) =>
          scope === undefined ||
          (typeof scope === 'string'
            ? error.executionId === scope
            : scope.has(error.executionId)),
      );
      if (!visible.length) return null;
      return (
        <>
          {visible.map(([key, { message, openChat }]) => (
            <ErrorBanner
              key={key}
              error={message}
              errorSource="workflow-run-action"
              blockMessageFromReplay
              errorRecordingDisabled
              retryLabel="Open chat"
              onRetry={
                openChat
                  ? () => {
                      void openChat()
                        .then((opened) => {
                          if (opened) {
                            dismissActionError(key);
                            onChatRevealed?.();
                          }
                        })
                        .catch(reportClientAppError);
                    }
                  : undefined
              }
              onDismiss={() => dismissActionError(key)}
              testId="workflow-run-action-error"
            />
          ))}
        </>
      );
    },
    [actionErrors, dismissActionError],
  );
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
      const showError = beginAction(executionId, 'resume');
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
          showError(result.error ?? 'Failed to resume execution', true);
        }
      } catch (error: unknown) {
        reportClientAppError(error);
        showError(extractIpcErrorMessage(error));
      } finally {
        usePipelineExecutionActionsStore.setState((state) =>
          state.resumingId === executionId ? { resumingId: null } : state,
        );
      }
    },
    [beginAction],
  );

  const retry = useCallback(
    async (executionId: string): Promise<void> => {
      if (
        usePipelineExecutionActionsStore.getState().retryingIds.has(executionId)
      )
        return;
      const showError = beginAction(executionId, 'retry');
      usePipelineExecutionActionsStore.setState((state) => ({
        retryingIds: withInFlightId(state.retryingIds, executionId, true),
      }));
      try {
        const state = await resolveExecution(executionId, showError);
        if (!state) return;
        if (state.parent_execution_id) {
          showError('Only root executions can be retried');
          return;
        }
        if (!canRetryExecution(state)) {
          showError('Only failed or cancelled executions can be retried');
          return;
        }
        const result = await usePipelineRunsStore
          .getState()
          .retryExecution(executionId);
        if (!result.success) {
          showError(result.error ?? 'Failed to retry execution', true);
        }
      } catch (error: unknown) {
        reportClientAppError(error);
        showError(extractIpcErrorMessage(error));
      } finally {
        usePipelineExecutionActionsStore.setState((state) => ({
          retryingIds: withInFlightId(state.retryingIds, executionId, false),
        }));
      }
    },
    [beginAction],
  );

  const rerun = useCallback(
    async (executionId: string): Promise<void> => {
      if (
        usePipelineExecutionActionsStore
          .getState()
          .rerunningIds.has(executionId)
      )
        return;
      const showError = beginAction(executionId, 'rerun');
      usePipelineExecutionActionsStore.setState((state) => ({
        rerunningIds: withInFlightId(state.rerunningIds, executionId, true),
      }));
      try {
        const state = await resolveExecution(executionId, showError);
        if (!state) return;
        if (state.parent_execution_id) {
          showError('Only root executions can be rerun');
          return;
        }
        if (
          state.status !== 'success' &&
          state.status !== 'failure' &&
          state.status !== 'cancelled'
        ) {
          showError('Only terminal executions can be rerun');
          return;
        }
        if (!hasRerunReplayData(state)) {
          showError(
            'This execution cannot be rerun because its original plan input was not preserved',
          );
          return;
        }
        const result = await usePipelineRunsStore
          .getState()
          .rerunExecution(executionId);
        if (!result.success) {
          showError(result.error ?? 'Failed to rerun execution', true);
        }
      } catch (error: unknown) {
        reportClientAppError(error);
        showError(extractIpcErrorMessage(error));
      } finally {
        usePipelineExecutionActionsStore.setState((state) => ({
          rerunningIds: withInFlightId(state.rerunningIds, executionId, false),
        }));
      }
    },
    [beginAction],
  );

  const debugFailure = useCallback(
    async (executionId: string): Promise<boolean> => {
      if (usePipelineExecutionActionsStore.getState().debuggingFailureId) {
        return false;
      }
      const showError = beginAction(executionId, 'debug');
      usePipelineExecutionActionsStore.setState({
        debuggingFailureId: executionId,
      });
      try {
        const state = await resolveExecution(executionId, showError);
        if (!state) return false;
        if (state.status !== 'failure') {
          showError(
            `Only failed workflow runs can be debugged with ${ORCHESTRATOR_LABEL}`,
          );
          return false;
        }
        const response = await dispatchAppAction({
          requestId: createRequestId(),
          source: 'ui',
          action: { type: 'pipeline.debug_run', executionId },
        });
        if (!response.ok) {
          showError(
            response.error?.message ??
              `Failed to open ${ORCHESTRATOR_LABEL} for workflow debug`,
            true,
          );
          return false;
        }
        return true;
      } catch (error: unknown) {
        reportClientAppError(error);
        showError(
          error instanceof Error
            ? error.message
            : `Failed to open ${ORCHESTRATOR_LABEL} for workflow debug`,
        );
        return false;
      } finally {
        usePipelineExecutionActionsStore.setState({ debuggingFailureId: null });
      }
    },
    [beginAction],
  );

  const chatFollowUp = useCallback(
    (executionId: string): Promise<boolean> =>
      sendExecutionFollowUp(
        executionId,
        (state) => {
          const planPath = getExecutionPlanPath(state);
          return planPath ? `Review this plan: ${planPath}` : null;
        },
        'This workflow run does not have a saved plan file',
        'plan-chat',
        beginAction,
      ),
    [beginAction],
  );

  const reportChatFollowUp = useCallback(
    (executionId: string): Promise<boolean> =>
      sendExecutionFollowUp(
        executionId,
        (state) => {
          const reportPath =
            state.report_outputs?.report_file ??
            state.report_outputs?.report_json_file;
          return reportPath ? `Review this report: ${reportPath}` : null;
        },
        'This workflow run does not have a saved report file',
        'report-chat',
        beginAction,
      ),
    [beginAction],
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

  const openPlan = useCallback(
    async (executionId: string): Promise<boolean> => {
      const showError = beginAction(executionId, 'plan');
      try {
        const state = await resolveExecution(executionId, showError);
        if (!state) return false;
        const summary = usePipelineRunsStore
          .getState()
          .summaries.find((entry) => entry.id === executionId);
        const planId = state.planId ?? summary?.planId;
        const projectId = state.project_id ?? summary?.project_id;
        const worktreeId = state.worktree_id ?? summary?.worktree_id;
        if (!planId || !projectId || !worktreeId) {
          showError('This workflow run is not linked to a tracked plan');
          return false;
        }
        const result = await openTrackedPlan(
          { projectId, worktreeId, planId },
          { reportFailure: false },
        );
        if (result.status === 'placed' || result.status === 'revealed')
          return true;
        showError(
          'Could not open the tracked plan for this workflow run',
          true,
        );
      } catch (error: unknown) {
        reportClientAppError(error);
        showError(extractIpcErrorMessage(error));
      }
      return false;
    },
    [beginAction],
  );

  const pipelineFollowUp = useCallback(
    async (executionId: string): Promise<void> => {
      // Capture the dialog document before awaiting: the surface that asked
      // may move or close while the run loads.
      const targetDocument = dialogDocument();
      const showError = beginAction(executionId, 'workflow');
      const state = await resolveExecution(executionId, showError);
      if (!state) return;
      if (!getExecutionPlanPath(state)) {
        showError('This workflow run does not have a saved plan file');
        return;
      }
      if (!mountedRef.current) return;
      setFollowUpError(null);
      setFollowUp({ execution: state, ownerDocument: targetDocument });
    },
    [beginAction, dialogDocument],
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
        setFollowUpError({
          message: 'Missing execution context for follow-up run',
          reported: false,
        });
        return;
      }
      const planPath = getExecutionPlanPath(execution);
      if (!planPath) {
        setFollowUpError({
          message: 'This workflow run does not have a saved plan file',
          reported: false,
        });
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
          reportClientAppError(error);
          setFollowUpRunning(false);
          setFollowUpError({
            message:
              error instanceof Error
                ? error.message
                : 'Failed to resolve worktree path',
            reported: true,
          });
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
          reportClientAppError(
            new Error('Workflow follow-up execution failed'),
          );
          setFollowUpError({
            message: result.error ?? 'Workflow execution failed',
            reported: true,
          });
          return;
        }
        setFollowUp(null);
        setFollowUpError(null);
      } catch (error: unknown) {
        reportClientAppError(error);
        setFollowUpError({
          message: extractIpcErrorMessage(error),
          reported: true,
        });
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
        followUpError={followUpError?.message ?? null}
        followUpErrorRecorded={followUpError?.reported ?? false}
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
      renderActionError,
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
      renderActionError,
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
