import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
  type RefCallback,
} from 'react';
import { useCapabilities } from '@canopy/app-state';
import {
  availableWorkflowRunKinds,
  cloudExecutionIdOfRow,
  CloudPipelineRunDialog,
  EMPTY_WORKFLOW_LIBRARY_FILTERS,
  isCloudRunRowControl,
  sendCloudRunRowControl,
  WORKFLOW_RUN_STARTERS,
  WorkflowsRunsList,
  type WorkflowRunAction,
  type WorkflowRunRow,
  type WorkflowRunStarter,
  type WorkflowsRunsListProps,
} from '@canopy/ui-app/workflows';
import { ConfirmDialog } from '@canopy/ui-shared/components';
import { openPipelineExecutionFromUi } from '@/lib/panels/open-pipeline-execution';
import {
  cloudPipelineRunsStore,
  cloudRunControlKeys,
  cloudRunControlSession,
  cloudRunsInvoker,
  onCloudRunsAccountChange,
} from '@/lib/workflows/cloud-runs';
import { useExecutionFeedStore } from '@/lib/workflows/execution-feed';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useWorkflowsViewStore } from '@/stores/workflowsViewStore';
import { usePipelineExecutionActions } from '../../activity/usePipelineExecutionActions';
import {
  openAutomationRunDestination,
  resolveAutomationRunDestination,
  resolveAvailableAutomationRunDestination,
} from '../../automations/resolveAutomationRunDestination';
import { jumpToWatcherSubscriberChat } from '../../watchers/jumpToWatcherSubscriberChat';
import { WatcherManagementModal } from '../../watchers/WatcherManagementModal';
import type { WorkflowRunFeed } from './useWorkflowRunFeed';

/**
 * What a desktop run can be attributed to: every starter, now that a
 * pipeline run's summary records its initiator, App Advisor and Remote
 * Control included (CAN-6326).
 */
export const DESKTOP_RUN_STARTERS: readonly WorkflowRunStarter[] =
  WORKFLOW_RUN_STARTERS;

function showError(message: string): void {
  useGitHubStore
    .getState()
    .addToast(message, 'error', undefined, { category: 'Automation' });
}

/** The lookups a row's actions resolve its run, execution and watcher in. */
export type WorkflowRunRowSources = Pick<
  WorkflowRunFeed,
  'executionsById' | 'runsById' | 'watchersById'
>;

/** The execution a row acts on: its own, or the one its automation owns. */
// The list and the row actions it pairs with are one unit for hosts.
// eslint-disable-next-line react-refresh/only-export-components
export function executionIdForWorkflowRunRow(
  row: WorkflowRunRow,
  executionsById: WorkflowRunRowSources['executionsById'],
): string | undefined {
  if (row.kind === 'pipeline') return row.summary.id;
  if (row.kind === 'automation' && row.linkedExecutionId !== undefined) {
    return executionsById.has(row.linkedExecutionId)
      ? row.linkedExecutionId
      : undefined;
  }
  return undefined;
}

export interface WorkflowRunRowActions {
  /** Opens a row: its execution, its automation run's destination, or the watcher. */
  readonly openRow: (row: WorkflowRunRow) => void;
  readonly handleAction: (
    row: WorkflowRunRow,
    action: WorkflowRunAction,
  ) => void;
  /** Rows with an action in flight. */
  readonly busyKeys: ReadonlySet<string>;
  /** Attach to the element that contains the list, so dialogs open in its window. */
  readonly dialogAnchorRef: RefCallback<HTMLElement>;
  /** The execution, watcher and cancel dialogs these actions open. */
  readonly dialogs: ReactNode;
}

/**
 * Row open and actions for a runs list. Every action goes to the handler that
 * already owns it, and always carries the row's own id.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useWorkflowRunRowActions(
  sources: WorkflowRunRowSources,
): WorkflowRunRowActions {
  const { executionsById, runsById, watchersById } = sources;
  const executionActions = usePipelineExecutionActions();
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const [inspectingWatcherId, setInspectingWatcherId] = useState<string | null>(
    null,
  );
  const [cancellingWatcherId, setCancellingWatcherId] = useState<string | null>(
    null,
  );
  const [watcherCancelError, setWatcherCancelError] = useState<string | null>(
    null,
  );
  const [watcherCancelBusy, setWatcherCancelBusy] = useState(false);
  const [openCloudRunId, setOpenCloudRunId] = useState<string | null>(null);
  // An open cloud run belongs to the account that opened it.
  useEffect(() => onCloudRunsAccountChange(() => setOpenCloudRunId(null)), []);

  const withBusy = useCallback(
    async (key: string, action: () => Promise<void>): Promise<void> => {
      setBusyKeys((current) => new Set(current).add(key));
      try {
        await action();
      } catch (error) {
        showError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [],
  );

  const executionIdFor = useCallback(
    (row: WorkflowRunRow): string | undefined =>
      executionIdForWorkflowRunRow(row, executionsById),
    [executionsById],
  );

  /** Opens what an automation run produced: its chat, or what it started. */
  const openAutomationRunResult = useCallback(
    (runId: string): void => {
      const run = runsById.get(runId);
      if (!run) return;
      void (async (): Promise<void> => {
        const destination = await resolveAvailableAutomationRunDestination(
          resolveAutomationRunDestination(run),
        );
        if (destination.kind === 'none') {
          showError(destination.reason);
          return;
        }
        const result = await openAutomationRunDestination(destination);
        if (!result.ok) showError(result.error);
      })();
    },
    [runsById],
  );

  const openRow = useCallback(
    (row: WorkflowRunRow): void => {
      if (row.kind === 'watcher') {
        setInspectingWatcherId(row.watcherId);
        return;
      }
      const cloudExecutionId = cloudExecutionIdOfRow(row);
      if (cloudExecutionId !== undefined) {
        setOpenCloudRunId(cloudExecutionId);
        return;
      }
      const executionId = executionIdFor(row);
      if (executionId !== undefined) {
        void openPipelineExecutionFromUi({ executionId });
        return;
      }
      if (row.kind !== 'automation') return;
      openAutomationRunResult(row.runId);
    },
    [executionIdFor, openAutomationRunResult],
  );

  const openInLibrary = useCallback((row: WorkflowRunRow): void => {
    // A run keeps the name its automation had then; the Library lists the
    // name it has now.
    const activity =
      row.kind === 'automation'
        ? useAutomationsStore
            .getState()
            .activities.find((candidate) => candidate.id === row.activityId)
        : undefined;
    // Preset the Library to this workflow's name, then open it.
    useWorkflowsViewStore.getState().setLibraryFilters({
      ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
      query: activity?.name ?? row.name,
    });
    useNavigationStore.getState().navigate('workflows-library');
  }, []);

  /** A cloud run's row control, answered by the web core (CAN-6326). */
  const handleCloudAction = useCallback(
    (
      row: WorkflowRunRow,
      executionId: string,
      action: WorkflowRunAction,
    ): void => {
      if (action === 'respond' || action === 'inspect') {
        setOpenCloudRunId(executionId);
        return;
      }
      if (!isCloudRunRowControl(action)) return;
      const session = cloudRunControlSession(executionId);
      if (session === null) return;
      void withBusy(row.key, () => sendCloudRunRowControl(session, action));
    },
    [withBusy],
  );

  const handleAction = useCallback(
    (row: WorkflowRunRow, action: WorkflowRunAction): void => {
      const cloudExecutionId = cloudExecutionIdOfRow(row);
      if (cloudExecutionId !== undefined) {
        handleCloudAction(row, cloudExecutionId, action);
        return;
      }
      const executionId = executionIdFor(row);
      switch (action) {
        case 'respond':
        case 'inspect':
          // Responding happens in the run's own detail, where the question
          // and its choices are shown.
          openRow(row);
          return;
        case 'open-library':
          openInLibrary(row);
          return;
        case 'open-workflow':
          // The schedule's edit link lands on its Workflow page's Runs
          // section with this run selected (CAN-5782).
          if (row.kind !== 'automation') return;
          useNavigationStore.getState().openAutomationEdit({
            activityId: row.activityId,
            runId: row.runId,
          });
          return;
        case 'go-to-chat': {
          // An automation row that opens its execution reaches its chat here.
          if (row.kind === 'automation') {
            openAutomationRunResult(row.runId);
            return;
          }
          if (row.kind !== 'watcher') return;
          const watcher = watchersById.get(row.watcherId);
          if (!watcher) return;
          const result = jumpToWatcherSubscriberChat(watcher);
          if (!result.ok) showError(result.error);
          return;
        }
        case 'cancel':
          if (row.kind === 'watcher') {
            setWatcherCancelError(null);
            setCancellingWatcherId(row.watcherId);
            return;
          }
          void withBusy(row.key, async () => {
            if (executionId !== undefined) {
              await executionActions.cancel(executionId);
              return;
            }
            if (row.kind !== 'automation') return;
            const response = await useAutomationsStore
              .getState()
              .cancelRun(row.runId);
            if (!response.ok) {
              showError(response.error);
            }
          });
          return;
        case 'retry':
          if (executionId === undefined) return;
          void withBusy(row.key, () => executionActions.retry(executionId));
          return;
        case 'rerun':
          if (executionId === undefined) return;
          void withBusy(row.key, () => executionActions.rerun(executionId));
          return;
        case 'hide':
          if (executionId === undefined) return;
          void withBusy(row.key, async () => {
            const result = await usePipelineRunsStore
              .getState()
              .setExecutionHidden(executionId, true);
            if (result.success) {
              useExecutionFeedStore.getState().setHidden(executionId, true);
            } else {
              showError(result.error ?? 'Could not hide the run.');
            }
          });
          return;
      }
    },
    [
      executionActions,
      executionIdFor,
      handleCloudAction,
      watchersById,
      openAutomationRunResult,
      openInLibrary,
      openRow,
      withBusy,
    ],
  );

  const inspectingWatcher =
    inspectingWatcherId !== null
      ? watchersById.get(inspectingWatcherId)
      : undefined;
  const cancellingWatcher =
    cancellingWatcherId !== null
      ? watchersById.get(cancellingWatcherId)
      : undefined;

  const cloudInvoker = cloudRunsInvoker();
  const dialogs = (
    <>
      {executionActions.dialogs}
      {openCloudRunId !== null && cloudInvoker !== null && (
        <CloudPipelineRunDialog
          key={openCloudRunId}
          invoker={cloudInvoker}
          executionId={openCloudRunId}
          onClose={(): void => setOpenCloudRunId(null)}
          onOpenRun={setOpenCloudRunId}
          onView={(view): void => cloudPipelineRunsStore()?.upsert(view)}
          controlKeys={cloudRunControlKeys}
        />
      )}
      {inspectingWatcher && (
        <WatcherManagementModal
          title="Watcher"
          emptyMessage="This watcher is no longer available."
          watchers={[inspectingWatcher]}
          onClose={(): void => setInspectingWatcherId(null)}
        />
      )}
      {cancellingWatcher && (
        <ConfirmDialog
          title="Cancel this watcher?"
          message={`"${cancellingWatcher.label}" stops watching and leaves this list. The chat it reports to is not told.`}
          confirmLabel="Cancel watcher"
          busyLabel="Canceling…"
          busy={watcherCancelBusy}
          errorMessage={watcherCancelError}
          destructive
          dataTestId="workflows-runs-cancel-watcher"
          onCancel={(): void => setCancellingWatcherId(null)}
          onConfirm={(): void => {
            setWatcherCancelBusy(true);
            void useAppAdvisorWatchersStore
              .getState()
              .deleteWatcher(cancellingWatcher.id)
              .then(
                (result) => {
                  if (result.ok) setCancellingWatcherId(null);
                  else setWatcherCancelError(result.error);
                },
                (error: unknown) => {
                  setWatcherCancelError(
                    error instanceof Error ? error.message : String(error),
                  );
                },
              )
              .finally(() => setWatcherCancelBusy(false));
          }}
        />
      )}
    </>
  );

  return {
    openRow,
    handleAction,
    busyKeys,
    dialogAnchorRef: executionActions.dialogAnchorRef,
    dialogs,
  };
}

export type WorkflowRunsListProps = Omit<
  WorkflowsRunsListProps,
  'kinds' | 'starters'
> &
  Partial<Pick<WorkflowsRunsListProps, 'kinds' | 'starters'>>;

/**
 * The shared runs list with desktop's defaults: the kinds this host's
 * capabilities can list, and every starter a desktop run records. Render it
 * inside an element that carries the row actions' `dialogAnchorRef`.
 */
export function WorkflowRunsList({
  kinds,
  starters = DESKTOP_RUN_STARTERS,
  ...props
}: WorkflowRunsListProps): JSX.Element {
  const capabilities = useCapabilities();
  const capabilityKinds = useMemo(
    () => availableWorkflowRunKinds(capabilities),
    [capabilities],
  );
  return (
    <WorkflowsRunsList
      {...props}
      kinds={kinds ?? capabilityKinds}
      starters={starters}
    />
  );
}
