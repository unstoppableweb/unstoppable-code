import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { PipelineIcon } from '@canopy/ui-shared/icons';
import { DialogModal } from '@canopy/ui-shared/components';
import type { PipelineDetailOwner } from '@/stores/pipelineDetailCoordinator';
import { PipelineExecutionDetail } from './details/PipelineExecutionDetail';
import type {
  ArchivedPipelineSource,
  BreadcrumbEntry,
  PipelineDetailDestination,
  PipelineExecutionDetailRevealTarget,
} from './details/pipelineDetailTypes';
import type { PipelineExecutionActions } from './usePipelineExecutionActions';
import { PIPELINE_DETAIL_MODAL_UI_STATE_KEY } from '@/lib/current-ui-state/pipelineDetailUiState';

/** The current-UI slice the compatibility modal reports under. */
export { PIPELINE_DETAIL_MODAL_UI_STATE_KEY };

export type { BreadcrumbEntry } from './details/pipelineDetailTypes';

interface PipelineExecutionDetailModalProps {
  executionId: string;
  onClose: () => void;
  initialJobId?: string;
  /** Pre-populate breadcrumb navigation when opening directly to a child. */
  initialViewStack?: BreadcrumbEntry[];
  /**
   * Explicit target for an already-open modal. Re-opening the same run at a
   * different job or breadcrumb changes the nonce, and the open detail
   * applies it instead of ignoring it.
   */
  revealTarget?: PipelineExecutionDetailRevealTarget;
  /**
   * Execution-action controller that outlives the modal (the run list's), so
   * report and follow-up dialogs survive the modal closing to reveal them.
   * Omit it for a read-only host; archived runs show no actions.
   */
  actions?: PipelineExecutionActions;
  /**
   * Read-only archived-container source. Execution state, reports, and step
   * logs are read through the archive transport, and every live-only control
   * is hidden. Pass a referentially stable (memoized) object.
   */
  archivedSource?: ArchivedPipelineSource;
  /**
   * Owner of this detail's lease. Defaults to the worktree selected when the
   * modal opened.
   */
  detailOwner?: PipelineDetailOwner | null;
}

/** Hands the title the detail shows (it follows the breadcrumb) to the dialog header. */
function ReportTitle({
  title,
  onTitle,
}: {
  title: string;
  onTitle: (title: string) => void;
}): null {
  useLayoutEffect(() => {
    onTitle(title);
  }, [onTitle, title]);
  return null;
}

/**
 * The compatibility host around {@link PipelineExecutionDetail}: a page over
 * the app (`DialogModal variant="page"`) titled with the run being shown. It
 * is the host for runs the Activity run list opens and for archived runs; the
 * detail body carries no modal chrome of its own.
 *
 * Escape closes the page only when nothing else handled it: a nested dialog
 * or menu that owns Escape, or a search field that prevented it, keeps the
 * page open (the shared overlay Escape stack).
 */
export function PipelineExecutionDetailModal({
  executionId,
  onClose,
  initialJobId,
  initialViewStack,
  revealTarget,
  actions,
  archivedSource,
  detailOwner,
}: PipelineExecutionDetailModalProps): JSX.Element {
  const titleId = `${useId()}-pipeline-execution-detail-title`;
  const [title, setTitle] = useState('Workflow run');
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const navigationRef = useRef({ mounted: false, revealTarget });
  navigationRef.current.revealTarget = revealTarget;
  useLayoutEffect(() => {
    const navigation = navigationRef.current;
    navigation.mounted = true;
    return (): void => {
      navigation.mounted = false;
    };
  }, []);

  // A covering modal gets out of the way when an action opens another
  // surface. Report and follow-up dialogs live in `actions`, so closing only
  // happens when that controller outlives the modal; the report chat
  // follow-up never closed the modal.
  const handleNavigatedAway = useCallback(
    (destination: PipelineDetailDestination): void => {
      if (
        !navigationRef.current.mounted ||
        navigationRef.current.revealTarget !== revealTarget ||
        destination === 'report-chat'
      )
        return;
      if (
        actions === undefined &&
        (destination === 'report' || destination === 'pipeline-follow-up')
      ) {
        return;
      }
      onCloseRef.current();
    },
    [actions, revealTarget],
  );

  return (
    <DialogModal
      variant="page"
      onClose={onClose}
      titleId={titleId}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <PipelineIcon size="sm" className="shrink-0 fg-secondary" />
          <span className="truncate">{title}</span>
        </span>
      }
      inset="flush"
      scrollableBody={false}
    >
      {/* The frame records; `PipelineExecutionDetail` blocks its own body
          (step logs, output, reports, pause inputs, job and step names). */}
      <PipelineExecutionDetail
        executionId={executionId}
        owner={detailOwner}
        initialTarget={{ viewStack: initialViewStack, jobId: initialJobId }}
        revealTarget={revealTarget}
        archivedSource={archivedSource}
        actions={actions}
        onNavigatedAway={handleNavigatedAway}
        uiStateKey={
          archivedSource === undefined
            ? PIPELINE_DETAIL_MODAL_UI_STATE_KEY
            : undefined
        }
        renderHeader={({ title: shownTitle }) => (
          <ReportTitle title={shownTitle} onTitle={setTitle} />
        )}
      />
    </DialogModal>
  );
}
