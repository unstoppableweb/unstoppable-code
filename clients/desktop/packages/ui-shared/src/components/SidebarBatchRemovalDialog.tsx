'use client';

import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import { CheckIcon, CloseIcon, InfoIcon, WarningIcon } from '../icons/AppIcons';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { Dot } from './Badge';
import { Button } from './Button';
import { DialogModal } from './DialogModal';
import { LoadingSpinner } from './LoadingSpinner';
import { OverlayScrollArea } from './OverlayScrollArea';
import { RichHoverTooltip } from './RichHoverTooltip';
import {
  unitCountLabel,
  type SidebarBatchUnitLabel,
} from './worktree-count-label';
import { Heading } from './Heading';
import {
  KeepLocalBranchToggle,
  DEFAULT_KEEP_LOCAL_BRANCH,
} from './KeepLocalBranchToggle';

export type SidebarBatchRemovalDialogMode = 'archive' | 'delete';

export type SidebarBatchRemovalDialogPhase = 'confirm' | 'results';

export type SidebarBatchRemovalDialogRowStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped';

/** Local work a row's removal takes with it, as the host reports it. */
export interface SidebarBatchRemovalDialogLocalWork {
  readonly insertions?: number;
  readonly deletions?: number;
  readonly uncommitted?: boolean;
  readonly unpushed?: boolean;
}

export interface SidebarBatchRemovalDialogRow {
  readonly key: string;
  readonly projectName: string;
  readonly label: string;
  readonly branchName?: string;
  readonly localWork?: SidebarBatchRemovalDialogLocalWork;
  /** Results phase. */
  readonly status?: SidebarBatchRemovalDialogRowStatus;
  /** Why the row failed or was skipped. */
  readonly reason?: string;
}

/** A selected row that can't be removed right now, with why. */
export interface SidebarBatchRemovalDialogExcludedRow {
  readonly key: string;
  readonly projectName: string;
  readonly label: string;
  readonly branchName?: string;
  readonly reason: string;
}

export interface SidebarBatchRemovalDialogProps {
  readonly mode: SidebarBatchRemovalDialogMode;
  readonly phase: SidebarBatchRemovalDialogPhase;
  /** The rows the batch removes, in the order it runs them. */
  readonly rows: readonly SidebarBatchRemovalDialogRow[];
  /** Listed under Not included; they don't count toward the title. */
  readonly excluded: readonly SidebarBatchRemovalDialogExcludedRow[];
  /** One-line retention outcome for the included rows. */
  readonly retentionSummary: string;
  readonly retentionDetail: string;
  /**
   * The host's warning when included rows have local work, or its own
   * wording for what the removal does with saved changes.
   */
  readonly warning?: string;
  /**
   * One keep-local-branch switch, applied to every included row. Without
   * it the confirm offers one `Archive N <unit>` / `Delete N <unit>`.
   */
  readonly branchChoice: boolean;
  /** Names the rows in the title, the confirm, and the empty copy. */
  readonly unitLabel: SidebarBatchUnitLabel;
  readonly testId?: string;
  readonly onCancel: () => void;
  /** `deleteBranch` is set only where `branchChoice` is offered. */
  readonly onConfirm: (deleteBranch?: boolean) => void;
  /** Closes the results phase. */
  readonly onDone: () => void;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function hasLocalWork(
  localWork: SidebarBatchRemovalDialogLocalWork | undefined,
): boolean {
  if (localWork === undefined) return false;
  return (
    (localWork.insertions ?? 0) + (localWork.deletions ?? 0) > 0 ||
    localWork.uncommitted === true ||
    localWork.unpushed === true
  );
}

function LocalWorkBadge({
  localWork,
}: {
  localWork: SidebarBatchRemovalDialogLocalWork;
}): JSX.Element | null {
  const insertions = localWork.insertions ?? 0;
  const deletions = localWork.deletions ?? 0;
  if (insertions + deletions > 0) {
    return (
      <span className="shrink-0 text-xs font-medium tabular-nums">
        <span className="fg-success">+{insertions}</span>{' '}
        <span className="fg-destructive">−{deletions}</span>
      </span>
    );
  }
  const label =
    localWork.uncommitted === true
      ? 'Uncommitted changes'
      : localWork.unpushed === true
        ? 'Unpushed commits'
        : null;
  return label === null ? null : (
    <span className="shrink-0 text-xs fg-warning">{label}</span>
  );
}

function StatusMark({
  status,
}: {
  status: SidebarBatchRemovalDialogRowStatus | undefined;
}): JSX.Element | null {
  switch (status) {
    case undefined:
      return null;
    case 'pending':
      return <Dot tone="pending" label="Not started" />;
    case 'running':
      return <LoadingSpinner sizePx={14} />;
    case 'done':
      return <CheckIcon size={14} aria-label="Done" className="fg-success" />;
    case 'failed':
      return (
        <CloseIcon size={14} aria-label="Failed" className="fg-destructive" />
      );
    case 'skipped':
      return (
        <WarningIcon size={14} aria-label="Skipped" className="fg-warning" />
      );
  }
}

function RowIdentity({
  projectName,
  label,
  branchName,
  trailing,
  reason,
}: {
  projectName: string;
  label: string;
  branchName?: string;
  trailing?: ReactNode;
  reason?: string;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex min-w-0 items-center gap-2">
        <span className={`${REPLAY_MASK_CLASS} min-w-0 truncate fg-primary`}>
          {label}
        </span>
        {trailing}
      </div>
      <span className="min-w-0 truncate text-xs fg-tertiary">
        <span className={REPLAY_MASK_CLASS}>{projectName}</span>
        {branchName !== undefined && branchName !== label && (
          <>
            {' · '}
            <span className={REPLAY_MASK_CLASS}>{branchName}</span>
          </>
        )}
      </span>
      {reason !== undefined && (
        <span className="min-w-0 text-xs fg-secondary">{reason}</span>
      )}
    </div>
  );
}

function resultSummary(
  mode: SidebarBatchRemovalDialogMode,
  rows: readonly SidebarBatchRemovalDialogRow[],
): string {
  const count = (status: SidebarBatchRemovalDialogRowStatus): number =>
    rows.filter((row) => row.status === status).length;
  const parts = [
    `${count('done')} ${mode === 'archive' ? 'archived' : 'deleted'}`,
  ];
  if (count('failed') > 0) parts.push(`${count('failed')} failed`);
  if (count('skipped') > 0) parts.push(`${count('skipped')} skipped`);
  if (count('pending') > 0) parts.push(`${count('pending')} not started`);
  return parts.join(', ');
}

interface ConfirmSummaryProps {
  readonly mode: SidebarBatchRemovalDialogMode;
  readonly nothingRemovable: boolean;
  readonly warning?: string;
  readonly retentionSummary: string;
  readonly retentionDetail: string;
  readonly unitLabel: SidebarBatchUnitLabel;
  readonly testId: string;
}

/** What the removal does: the warning and retention. */
function ConfirmSummary({
  mode,
  nothingRemovable,
  warning,
  retentionSummary,
  retentionDetail,
  unitLabel,
  testId,
}: ConfirmSummaryProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1 text-s">
      {nothingRemovable ? (
        <p className="fg-secondary" data-testid={`${testId}-nothing-removable`}>
          None of the selected {unitLabel.plural} can be{' '}
          {mode === 'archive' ? 'archived' : 'deleted'} right now.
        </p>
      ) : (
        <>
          {warning !== undefined && (
            <p className="fg-primary" data-testid={`${testId}-warning`}>
              {warning}
            </p>
          )}
          <p className="fg-secondary" data-testid={`${testId}-summary`}>
            {retentionSummary}
            <span className="inline-flex pl-1 align-middle">
              <RichHoverTooltip
                content={
                  <span className="block text-xs leading-snug fg-primary">
                    {retentionDetail}
                  </span>
                }
                surfaceClassName="w-72"
                showOnPress
                triggerWrapperClassName="inline-flex h-5 items-center align-middle"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={`About restoring these ${unitLabel.plural}`}
                >
                  <InfoIcon size={14} aria-hidden="true" />
                </Button>
              </RichHoverTooltip>
            </span>
          </p>
        </>
      )}
    </div>
  );
}

function ExcludedRows({
  excluded,
  testId,
}: {
  excluded: readonly SidebarBatchRemovalDialogExcludedRow[];
  testId: string;
}): JSX.Element {
  return (
    <section
      className="flex flex-col gap-2 text-s"
      aria-labelledby={`${testId}-excluded-heading`}
      data-testid={`${testId}-excluded`}
    >
      <Heading level={3} variant="label" id={`${testId}-excluded-heading`}>
        Not included ({excluded.length})
      </Heading>
      <OverlayScrollArea viewportClassName="max-h-40">
        <ul className="flex flex-col gap-2">
          {excluded.map((row) => (
            <li
              key={row.key}
              className="flex min-w-0 items-start gap-2"
              data-testid={`${testId}-excluded-row`}
              data-row-key={row.key}
            >
              <RowIdentity
                projectName={row.projectName}
                label={row.label}
                branchName={row.branchName}
                reason={row.reason}
              />
            </li>
          ))}
        </ul>
      </OverlayScrollArea>
    </section>
  );
}

interface ConfirmActionsProps {
  readonly mode: SidebarBatchRemovalDialogMode;
  readonly count: number;
  readonly unitLabel: SidebarBatchUnitLabel;
  readonly cancelRef: RefObject<HTMLButtonElement | null>;
  readonly testId: string;
  readonly onCancel: () => void;
  readonly onConfirm: (deleteBranch?: boolean) => void;
}

/** Cancel, then one Archive/Delete action. */
function ConfirmActions({
  mode,
  count,
  unitLabel,
  cancelRef,
  testId,
  onCancel,
  onConfirm,
}: ConfirmActionsProps): JSX.Element {
  const verb = mode === 'archive' ? 'Archive' : 'Delete';
  const nothingRemovable = count === 0;
  return (
    <>
      <Button
        ref={cancelRef}
        variant="ghost"
        size="lg"
        onClick={onCancel}
        data-testid={`${testId}-cancel`}
      >
        Cancel
      </Button>
      <Button
        variant={mode === 'delete' ? 'destructive' : 'primary'}
        size="lg"
        className="ml-auto"
        disabled={nothingRemovable}
        onClick={(): void => onConfirm()}
        data-testid={`${testId}-confirm`}
      >
        {nothingRemovable
          ? verb
          : `${verb} ${unitCountLabel(unitLabel, count)}`}
      </Button>
    </>
  );
}

/**
 * Bulk removal of sidebar rows (CAN-3975): worktrees, chats, or App Advisor
 * entries. One confirm for the selection, then what happened to each row.
 * Pure display; the rail runs the batch in the background and feeds each
 * row's status back for the results.
 */
export function SidebarBatchRemovalDialog({
  mode,
  phase,
  rows,
  excluded,
  retentionSummary,
  retentionDetail,
  warning,
  branchChoice,
  unitLabel,
  testId = 'worktree-batch-removal-dialog',
  onCancel,
  onConfirm,
  onDone,
}: SidebarBatchRemovalDialogProps): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const doneRef = useRef<HTMLButtonElement | null>(null);
  // Confirm unmounts with the confirm phase; Done takes focus so it never
  // falls to the page behind the modal.
  useEffect(() => {
    if (phase === 'results') doneRef.current?.focus();
  }, [phase]);
  const [keepBranch, setKeepBranch] = useState(DEFAULT_KEEP_LOCAL_BRANCH);
  const titleId = `${testId}-title`;
  const verb = mode === 'archive' ? 'Archive' : 'Delete';
  const count = rows.length;
  const nothingRemovable = count === 0;
  // Rows with local work lead in the confirm, so the warning names what the
  // user sees first. Results keep the batch's own order.
  const orderedRows =
    phase === 'confirm'
      ? [
          ...rows.filter((row) => hasLocalWork(row.localWork)),
          ...rows.filter((row) => !hasLocalWork(row.localWork)),
        ]
      : rows;
  const title =
    phase === 'confirm'
      ? nothingRemovable
        ? `${verb} ${unitLabel.plural}?`
        : `${verb} ${unitCountLabel(unitLabel, count)}?`
      : resultSummary(mode, rows);
  const close = phase === 'results' ? onDone : onCancel;
  return (
    // The dialog portals to <body>, but React still bubbles its clicks to the
    // rail that opened it; stop them here so they never reach a row.
    <div className="contents" onClick={(event) => event.stopPropagation()}>
      <DialogModal
        title={title}
        titleId={titleId}
        maxWidth="md"
        headerBorder={false}
        headerSpacing="tight"
        showCloseButton={false}
        scrollableBody={false}
        trapFocus
        initialFocusRef={phase === 'confirm' ? cancelRef : undefined}
        dataTestId={testId}
        onClose={close}
      >
        <div className="flex flex-col gap-4" data-phase={phase}>
          {/* The results title changes as rows finish; read it out. */}
          <p role="status" className="sr-only">
            {phase === 'results' ? title : ''}
          </p>
          {phase === 'confirm' && (
            <ConfirmSummary
              mode={mode}
              nothingRemovable={nothingRemovable}
              warning={warning}
              retentionSummary={retentionSummary}
              retentionDetail={retentionDetail}
              unitLabel={unitLabel}
              testId={testId}
            />
          )}
          {count > 0 && (
            <OverlayScrollArea viewportClassName="max-h-64">
              <ul
                className="flex flex-col gap-2 text-s"
                aria-label={
                  phase === 'confirm'
                    ? `${capitalize(unitLabel.plural)} to ${mode}`
                    : 'Results'
                }
                data-testid={`${testId}-rows`}
              >
                {orderedRows.map((row) => (
                  <li
                    key={row.key}
                    className="flex min-w-0 items-start gap-2"
                    data-testid={`${testId}-row`}
                    data-row-key={row.key}
                    data-status={row.status}
                  >
                    {row.status !== undefined && (
                      <span className="inline-flex h-5 w-4 shrink-0 items-center justify-center">
                        <StatusMark status={row.status} />
                      </span>
                    )}
                    <RowIdentity
                      projectName={row.projectName}
                      label={row.label}
                      branchName={row.branchName}
                      reason={
                        row.status === 'failed' || row.status === 'skipped'
                          ? row.reason
                          : undefined
                      }
                      trailing={
                        phase === 'confirm' && row.localWork ? (
                          <LocalWorkBadge localWork={row.localWork} />
                        ) : undefined
                      }
                    />
                  </li>
                ))}
              </ul>
            </OverlayScrollArea>
          )}
          {phase === 'confirm' && excluded.length > 0 && (
            <ExcludedRows excluded={excluded} testId={testId} />
          )}
          {phase === 'confirm' && branchChoice && !nothingRemovable && (
            <KeepLocalBranchToggle
              checked={keepBranch}
              onChange={setKeepBranch}
              dataTestId={`${testId}-keep-branch`}
            >
              {keepBranch
                ? 'Each local branch stays in its project.'
                : 'Each local branch is deleted from its project.'}
            </KeepLocalBranchToggle>
          )}
          <div className="flex items-center gap-2 pt-1">
            {phase === 'confirm' && (
              <ConfirmActions
                mode={mode}
                count={count}
                unitLabel={unitLabel}
                cancelRef={cancelRef}
                testId={testId}
                onCancel={onCancel}
                onConfirm={(): void =>
                  onConfirm(branchChoice ? !keepBranch : undefined)
                }
              />
            )}
            {phase === 'results' && (
              <Button
                ref={doneRef}
                variant="primary"
                size="lg"
                className="ml-auto"
                onClick={onDone}
                data-testid={`${testId}-done`}
              >
                Done
              </Button>
            )}
          </div>
        </div>
      </DialogModal>
    </div>
  );
}
