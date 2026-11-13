import { useCallback, useRef, useState, type JSX, type ReactNode } from 'react';
import {
  ActionMenuRowStyle,
  Button,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuItemTrailing,
  FloatingMenu,
  PipelineDispatchedTime,
  PlanReviewStatusBadge,
  PlanStatusNote,
  SettingsSelect,
} from '@canopy/ui-shared/components';
import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import { PipelineIcon } from '@canopy/ui-shared/icons';
import { ChevronDownMediumIcon as AppCatalogChevronDownMediumIcon } from '@canopy/ui-shared/icons/AppIcons';
import { PlanReadyPipelineModal } from '@/components/chat/PlanReadyPipelineModal';
import type {
  PlanFollowUpActions,
  PlanLinkedExecution,
} from '@/components/plan-explore/usePlanFollowUpActions';
import { PlanActionControls } from '@/components/shared/PlanActionControls';
import { SharePlanModal } from '@/components/shared/SharePlanModal';
import { shareButtonLabel } from '@/components/shared/planShareLabel';
import { getPlanSourceLabel } from '@/lib/providerLabels';
import {
  planExecuteAvailability,
  usePlanImplementationState,
  type PlanStatusNoteTarget,
} from '@/components/plan-explore/usePlanImplementationState';

export interface PlanViewHeaderProps {
  /** The latest tracked plan. */
  plan: TrackedPlanData;
  actions: PlanFollowUpActions;
  /** Revision on screen; `null` is Latest. */
  viewedRevision: number | null;
  onViewedRevisionChange: (revision: number | null) => void;
  /** Read-only views (shared-container recipients) hide every follow-up. */
  readOnly: boolean;
  /**
   * Prefix for the header's test ids: `<prefix>-status-badge`,
   * `-revision-select`, `-executions`, `-execute`, `-execute-implement`,
   * `-share`, … (`plan-explore` in the takeover, `plan-panel` in a panel).
   */
  testIdPrefix: string;
  /** Controls placed before the status badge (e.g. a panel toggle). */
  leading?: ReactNode;
  /** Controls placed after the follow-up actions (e.g. a panel toggle). */
  trailing?: ReactNode;
  /**
   * Fit the header to a resizable view (plan panels): the source and
   * revision text truncates rather than pushing controls onto another line,
   * and the follow-up actions wrap below the plan details when they no
   * longer fit. The takeover omits it and keeps its single fixed row.
   */
  responsive?: boolean;
  /** Open a linked pipeline run. */
  onOpenExecution: (executionId: string) => void;
  /** Bring up a chat in the plan's worktree; omitted hides View chat. */
  onOpenChat?: (chatId: string) => void;
}

interface LinkedExecutionsMenuProps {
  executions: readonly PlanLinkedExecution[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenExecution: (executionId: string) => void;
  testId: string;
}

function LinkedExecutionsMenu({
  executions,
  open,
  onOpenChange,
  onOpenExecution,
  testId,
}: LinkedExecutionsMenuProps): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div className="relative shrink-0">
      <Button
        size="compact"
        ref={triggerRef}
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(): void => onOpenChange(!open)}
      >
        <PipelineIcon size="sm" className="shrink-0" />
        {executions.length} linked
        <AppCatalogChevronDownMediumIcon
          size="sm"
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </Button>
      <FloatingMenu
        open={open}
        onOpenChange={onOpenChange}
        anchorRef={triggerRef}
        placement="bottom-left"
        data-testid={`${testId}-menu`}
        className="min-w-50 max-w-96"
      >
        <ActionMenuRowStyle>
          {/* Every row opens a linked run, so the rows share one icon and
              only the first shows it. */}
          {executions.map((execution, index) => (
            <DropdownMenuItem
              key={execution.id}
              onClick={(): void => onOpenExecution(execution.id)}
            >
              <DropdownMenuItemIcon>
                {index === 0 ? <PipelineIcon /> : null}
              </DropdownMenuItemIcon>
              <span className="min-w-0 truncate">{execution.label}</span>
              {/* One trailing slot keeps the status beside the dispatched
                  time instead of splitting the row's free space. */}
              <DropdownMenuItemTrailing className="flex items-center">
                {execution.status}
                <PipelineDispatchedTime
                  startedAt={execution.startedAt}
                  variant="menu"
                />
              </DropdownMenuItemTrailing>
            </DropdownMenuItem>
          ))}
        </ActionMenuRowStyle>
      </FloatingMenu>
    </div>
  );
}

interface RevisionSelectProps {
  plan: TrackedPlanData;
  viewedRevision: number | null;
  onChange: (revision: number | null) => void;
  testId: string;
}

function RevisionSelect({
  plan,
  viewedRevision,
  onChange,
  testId,
}: RevisionSelectProps): JSX.Element {
  return (
    <SettingsSelect
      width="fit"
      data-testid={testId}
      aria-label="Plan revision"
      value={viewedRevision === null ? 'latest' : String(viewedRevision)}
      onValueChange={(value): void => {
        onChange(value === 'latest' ? null : Number(value));
      }}
      options={[
        { value: 'latest', label: 'Latest' },
        ...plan.revisions
          .slice()
          .reverse()
          .map((revision) => ({
            value: String(revision.revisionNumber),
            label: `Revision ${revision.revisionNumber}`,
          })),
      ]}
    />
  );
}

interface PlanFollowUpDialogsProps {
  plan: TrackedPlanData;
  actions: PlanFollowUpActions;
  ownerDocument: Document | undefined;
}

/** The pipeline, share, and cloud sign-in dialogs behind the header actions. */
function PlanFollowUpDialogs({
  plan,
  actions,
  ownerDocument,
}: PlanFollowUpDialogsProps): JSX.Element {
  return (
    <>
      {actions.pipelineModalOpen && (
        <PlanReadyPipelineModal
          projectId={plan.projectId}
          worktreeId={plan.worktreeId}
          onClose={actions.closePipelineModal}
          onRun={actions.runPipeline}
          isRunning={actions.pipelineRunning}
          runError={actions.pipelineRunError}
          ownerDocument={ownerDocument}
        />
      )}
      {actions.shareModalOpen && (
        <SharePlanModal
          planId={plan.id}
          planTitle={plan.title}
          existingShare={plan.share}
          onClose={actions.closeShareModal}
          onShare={actions.submitShare}
          onUnshare={actions.submitUnshare}
        />
      )}
      {actions.shareGateModal}
    </>
  );
}

/**
 * A plan view's header row: review status, source and revision, the revision
 * picker, linked pipeline runs, and the follow-up actions
 * (Implement, pipeline, share) with their dialogs. Shared by the plan takeover
 * and the plan panels; each view supplies its own `leading`/`trailing`
 * controls and test id prefix.
 */
export function PlanViewHeader({
  plan,
  actions,
  viewedRevision,
  onViewedRevisionChange,
  readOnly,
  testIdPrefix,
  leading,
  trailing,
  responsive = false,
  onOpenExecution,
  onOpenChat,
}: PlanViewHeaderProps): JSX.Element {
  // Dialogs open in the document hosting this header, so a header inside a
  // popped-out panel window opens them in that window.
  const [ownerDocument, setOwnerDocument] = useState<Document | undefined>();
  const rowRef = useCallback((node: HTMLDivElement | null): void => {
    if (node) {
      setOwnerDocument(node.ownerDocument);
    }
  }, []);
  const { setExecutionsOpen } = actions;
  const openExecution = useCallback(
    (executionId: string): void => {
      setExecutionsOpen(false);
      onOpenExecution(executionId);
    },
    [onOpenExecution, setExecutionsOpen],
  );
  const reviewedRevisionNumber = viewedRevision ?? plan.latestRevisionNumber;
  const implementation = usePlanImplementationState(plan);
  const openNoteTarget = (target: PlanStatusNoteTarget): void => {
    if (target.kind === 'run') {
      openExecution(target.executionId);
    } else {
      onOpenChat?.(target.chatId);
    }
  };
  const notes = readOnly
    ? []
    : implementation.notes.filter(
        (note) => note.target.kind === 'run' || onOpenChat !== undefined,
      );
  const openTarget = implementation.openTarget;
  const canOpen =
    openTarget !== undefined &&
    (openTarget.kind === 'run' || onOpenChat !== undefined);

  return (
    <>
      <div
        ref={rowRef}
        className={
          responsive
            ? 'electron-no-drag flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2'
            : 'electron-no-drag flex items-center gap-3 border-b px-4 py-2'
        }
      >
        {leading}
        <PlanReviewStatusBadge
          status={implementation.status}
          data-testid={`${testIdPrefix}-status-badge`}
        />
        {notes.map((note) => (
          <PlanStatusNote
            key={`${note.target.kind}-${note.target.kind === 'run' ? note.target.executionId : note.target.chatId}-${note.text ?? ''}`}
            text={note.text}
            className="shrink-0"
            data-testid={`${testIdPrefix}-status-note${note.text ? '-outcome' : ''}`}
            link={{
              label: note.linkLabel,
              onSelect: (): void => openNoteTarget(note.target),
              'data-testid': `${testIdPrefix}-status-note-${note.target.kind}${note.text ? '-outcome' : ''}`,
            }}
          />
        ))}
        <span
          className={
            responsive
              ? 'min-w-0 max-w-fit grow basis-24 truncate text-xs fg-secondary'
              : 'shrink-0 text-xs fg-secondary'
          }
        >
          {getPlanSourceLabel(plan.source)} • Revision {reviewedRevisionNumber}
        </span>

        <RevisionSelect
          plan={plan}
          viewedRevision={viewedRevision}
          onChange={onViewedRevisionChange}
          testId={`${testIdPrefix}-revision-select`}
        />

        {!readOnly && actions.linkedExecutions.length > 0 && (
          <LinkedExecutionsMenu
            executions={actions.linkedExecutions}
            open={actions.executionsOpen}
            onOpenChange={setExecutionsOpen}
            onOpenExecution={openExecution}
            testId={`${testIdPrefix}-executions`}
          />
        )}

        {/* In a responsive header the actions wrap in reverse, so they keep
            the upper line of their group when they no longer fit. */}
        <div
          className={
            responsive
              ? 'flex min-w-0 grow flex-wrap-reverse items-center justify-end gap-2'
              : 'flex flex-1 items-center justify-end gap-2'
          }
        >
          {!readOnly && (
            <PlanActionControls
              showExplore={false}
              dataTestIdPrefix={testIdPrefix}
              planContent={plan.content}
              {...planExecuteAvailability(plan, implementation)}
              executeEmphasis={implementation.status.executeEmphasis}
              primaryAction={
                canOpen ? implementation.status.primaryAction : 'execute'
              }
              openVenue={openTarget?.kind === 'run' ? 'pipeline' : 'chat'}
              onOpen={
                openTarget ? (): void => openNoteTarget(openTarget) : undefined
              }
              onExplore={(): void => {}}
              onImplement={actions.implement}
              onPipeline={actions.openPipelineModal}
              onShare={actions.shareEnabled ? actions.requestShare : undefined}
              shareLabel={shareButtonLabel(plan, actions.sharing)}
              shareBusy={actions.sharing}
              shareDisabled={viewedRevision !== null}
              shareTitle={
                viewedRevision !== null
                  ? 'Switch to Latest to share this plan.'
                  : undefined
              }
            />
          )}
        </div>
        {trailing}
      </div>

      {!readOnly && (
        <PlanFollowUpDialogs
          plan={plan}
          actions={actions}
          ownerDocument={ownerDocument}
        />
      )}
    </>
  );
}
