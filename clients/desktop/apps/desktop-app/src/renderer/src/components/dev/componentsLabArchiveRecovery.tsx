import { useState, type ComponentProps, type JSX } from 'react';
import {
  WorktreeRecoveryDialog,
  WorktreeRecoveryListDialog,
  type RecoveryHold,
} from '@canopy/ui-app/worktree-discard/presentation';
import { Button } from '@canopy/ui-shared/components';
import { ProjectDeletionDiscardDialog } from '@canopy/ui-shared/components/ProjectDeletionDiscardDialog';
import { worktreeRecoveryResultCopy } from '@canopy/ui-shared/lib/worktree-discard-copy';
import type {
  WorktreeRecoveryFinishResult,
  WorktreeRecoveryResolveResult,
} from '@canopy/protocol/canopy-core';
import { SpecimenCell, SpecimenPanel } from './componentsLabParts';
import {
  archiveListCases,
  archiveOperationId,
  archiveRecovery,
  recoveryActions,
  recoveryHold,
  recoveryProjectName,
  recoveryProjects,
  type ArchiveListCase,
  type RecoveryAction,
} from './componentsLabArchiveRecoveryFixtures';

const noop = (): void => undefined;
type RecoveryDialogProps = ComponentProps<typeof WorktreeRecoveryDialog>;
type Result = WorktreeRecoveryFinishResult | WorktreeRecoveryResolveResult;
type DialogCase = {
  readonly label: string;
  readonly action: RecoveryAction;
  readonly busy?: RecoveryDialogProps['busy'];
  readonly error?: RecoveryDialogProps['error'];
  readonly outcome?: Result;
  readonly name?: string;
  readonly canResolve?: boolean;
};

function result(
  action: RecoveryAction,
  operationId = archiveOperationId,
): Result {
  return action === 'finish'
    ? {
        status: 'finished',
        operationId,
        cleanupRequired: false,
        gitCleanupPending: false,
      }
    : {
        status: action === 'release' ? 'attempt-withdrawn' : 'worktree-kept',
        operationId,
        holdId: operationId,
        retainedSnapshots: 2,
        retainedPayload: true,
      };
}

function unsuccessfulResult(
  action: RecoveryAction,
  status: 'refused' | 'interrupted',
): Result {
  const failure =
    status === 'refused'
      ? { status, check: 'resolution-not-admitted' as const }
      : { status, check: 'resume-exact-resolution' as const };
  // Finish refusals and interruptions do not carry an operation ID.
  return action === 'finish'
    ? (failure satisfies WorktreeRecoveryFinishResult)
    : ({
        ...failure,
        operationId: archiveOperationId,
      } satisfies WorktreeRecoveryResolveResult);
}

const dialogCases: readonly DialogCase[] = [
  ...recoveryActions.flatMap((action): DialogCase[] => [
    { label: `${action}: offer`, action },
    {
      label: `${action}: busy and disabled`,
      action,
      busy:
        action === 'finish'
          ? 'finishArchive'
          : action === 'release'
            ? 'release'
            : 'keepWorktree',
    },
    { label: `${action}: result`, action, outcome: result(action) },
    {
      label: `${action}: refused`,
      action,
      outcome: unsuccessfulResult(action, 'refused'),
    },
    {
      label: `${action}: interrupted`,
      action,
      outcome: unsuccessfulResult(action, 'interrupted'),
    },
    { label: `${action}: unconfirmed`, action, error: 'unconfirmed' },
  ]),
  {
    label: 'Keep: no saved material remains',
    action: 'keep-worktree',
    outcome: {
      status: 'worktree-kept',
      operationId: archiveOperationId,
      holdId: archiveOperationId,
      retainedSnapshots: 0,
      retainedPayload: false,
    },
  },
  {
    label: 'Release: no saved material remains',
    action: 'release',
    outcome: {
      status: 'attempt-withdrawn',
      operationId: archiveOperationId,
      holdId: archiveOperationId,
      retainedSnapshots: 0,
      retainedPayload: false,
    },
  },
  {
    label: 'Finish: separate cleanup pending',
    action: 'finish',
    outcome: {
      status: 'cleanup-pending',
      operationId: archiveOperationId,
      cleanupRequired: true,
      gitCleanupPending: false,
    },
  },
  {
    label: 'Finish: Git cleanup pending',
    action: 'finish',
    outcome: {
      status: 'cleanup-pending',
      operationId: archiveOperationId,
      cleanupRequired: false,
      gitCleanupPending: true,
    },
  },
  {
    label: 'Finish: Git and other cleanup pending',
    action: 'finish',
    outcome: {
      status: 'cleanup-pending',
      operationId: archiveOperationId,
      cleanupRequired: true,
      gitCleanupPending: true,
    },
  },
  {
    label: 'Checking after refusal',
    action: 'keep-worktree',
    busy: 'refresh',
    outcome: {
      status: 'refused',
      operationId: archiveOperationId,
      check: 'resolution-not-admitted',
    },
  },
  {
    label: "Couldn't check recovery",
    action: 'keep-worktree',
    error: 'transport-failed',
  },
  {
    label: 'Long worktree name',
    action: 'keep-worktree',
    name: recoveryProjectName,
  },
  {
    label: 'Host without resolution capability',
    action: 'keep-worktree',
    canResolve: false,
  },
];

/** Real dialogs, fixture-only callbacks; opening a case focuses its dialog. */
export function WorktreeRecoverySpecimen(): JSX.Element {
  const [selected, setSelected] = useState<DialogCase | null>(null);
  const close = (): void => setSelected(null);
  return (
    <SpecimenPanel title="Archive resolution: offers and action-specific results">
      <p className="text-s text-pretty fg-secondary">
        Open a fixture to inspect it. Hover or press its actions, Tab to check
        focus, and expand Details to inspect the selected result. Busy fixtures
        keep actions disabled. No recovery operation runs. Reload the sheet to
        reset a busy fixture.
      </p>
      {dialogCases.map((entry) => (
        <SpecimenCell key={entry.label} label={entry.label}>
          <Button size="compact" onClick={() => setSelected(entry)}>
            Open {entry.label}
          </Button>
        </SpecimenCell>
      ))}
      {selected ? (
        <WorktreeRecoveryDialog
          name={selected.name ?? 'Worktree'}
          recovery={archiveRecovery(selected.action)}
          canResolve={selected.canResolve ?? true}
          busy={selected.busy ?? null}
          error={selected.error ?? null}
          unconfirmedAction={
            selected.error === 'unconfirmed' ? selected.action : undefined
          }
          outcome={selected.outcome}
          onAction={() =>
            setSelected({
              ...selected,
              outcome: result(selected.action),
              error: null,
            })
          }
          onDiscard={noop}
          onRefresh={() =>
            setSelected({
              ...selected,
              busy: null,
              error: null,
              outcome: undefined,
            })
          }
          onClose={close}
        />
      ) : null}
    </SpecimenPanel>
  );
}

export function ArchiveRecoveryListSpecimen(): JSX.Element {
  const [selected, setSelected] = useState<ArchiveListCase | null>(null);
  const [deleting, setDeleting] = useState<RecoveryHold | null>(null);
  const [review, setReview] = useState<RecoveryDialogProps['recovery'] | null>(
    null,
  );
  const [reviewOutcome, setReviewOutcome] = useState<Result>();
  const [message, setMessage] = useState<string | null>(null);
  const close = (): void => {
    setSelected(null);
    setDeleting(null);
    setReview(null);
    setReviewOutcome(undefined);
    setMessage(null);
  };
  return (
    <SpecimenPanel title="Live archive list: fixture records, never live operations">
      <p className="text-s text-pretty fg-secondary">
        Review rows without a listed worktree, expand Details, and open the
        delete confirmation. Hover, press, and keyboard focus use the real
        controls. Checking, busy, and error fixtures disable resolution. No
        selectable or editable fields are present.
      </p>
      {archiveListCases.map((state) => (
        <SpecimenCell key={state} label={state}>
          <Button
            size="compact"
            onClick={() => {
              setSelected(state);
              setDeleting(
                state.startsWith('delete confirmation') ? recoveryHold() : null,
              );
              setMessage(null);
            }}
          >
            Open {state}
          </Button>
        </SpecimenCell>
      ))}
      {selected && !review ? (
        <WorktreeRecoveryListDialog
          projects={recoveryProjects(selected)}
          checking={selected === 'checking'}
          error={selected === 'error'}
          busy={
            selected === 'busy resolution' ||
            selected === 'delete confirmation busy'
          }
          message={message}
          deleting={deleting}
          onClose={close}
          onRefresh={() => setSelected('one')}
          onReview={(_project, recovery) => {
            setReview(recovery);
            setReviewOutcome(undefined);
          }}
          onDelete={setDeleting}
          onFinishCleanup={() => {
            setSelected('empty');
            setMessage('Cleanup finished. The worktree was already removed.');
          }}
          onCancelDelete={() => setDeleting(null)}
          onResolve={(_hold, action) => {
            setDeleting(null);
            setMessage(
              worktreeRecoveryResultCopy(
                action === 'delete-hold'
                  ? { status: 'hold-deleted', operationId: archiveOperationId }
                  : {
                      status: 'interrupted',
                      operationId: archiveOperationId,
                      check: 'resume-exact-resolution',
                    },
                action,
              ),
            );
            if (action === 'delete-hold') setSelected('empty');
          }}
        />
      ) : null}
      {review ? (
        <WorktreeRecoveryDialog
          name="Unlisted worktree"
          recovery={review}
          canResolve
          busy={null}
          error={null}
          outcome={reviewOutcome}
          onAction={(action) => {
            if (action === 'retry') return;
            setReviewOutcome(
              result(
                action === 'keepWorktree'
                  ? 'keep-worktree'
                  : action === 'release'
                    ? 'release'
                    : 'finish',
                review.diagnosis?.operationId,
              ),
            );
          }}
          onDiscard={noop}
          onRefresh={noop}
          onClose={() => setReview(null)}
        />
      ) : null}
    </SpecimenPanel>
  );
}

const deletionCases = [
  'default',
  'busy',
  'error',
  'long project name',
] as const;
export function ProjectDeletionRecoverySpecimen(): JSX.Element {
  const [selected, setSelected] = useState<
    (typeof deletionCases)[number] | null
  >(null);
  const close = (): void => setSelected(null);
  return (
    <SpecimenPanel title="Project deletion: explicit discard pending recovery confirmation">
      {deletionCases.map((state) => (
        <SpecimenCell key={state} label={state}>
          <Button size="compact" onClick={() => setSelected(state)}>
            Open {state}
          </Button>
        </SpecimenCell>
      ))}
      {selected ? (
        <ProjectDeletionDiscardDialog
          projectName={
            selected === 'long project name' ? recoveryProjectName : 'Project'
          }
          pendingRecovery
          items={[]}
          interruptedDeletion={false}
          earlierDiscarded={[]}
          busy={selected === 'busy'}
          errorMessage={
            selected === 'error'
              ? "Couldn't delete the project. Check again before continuing."
              : null
          }
          onConfirm={close}
          onCancel={close}
        />
      ) : null}
    </SpecimenPanel>
  );
}
