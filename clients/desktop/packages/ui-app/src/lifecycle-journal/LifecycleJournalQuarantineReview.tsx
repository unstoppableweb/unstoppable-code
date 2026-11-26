import type { JSX, ReactNode } from 'react';
import type { CanopyClient } from '@canopy/app-core';
import { lifecycleJournalQuarantineStoreFor } from '@canopy/app-state/lifecycle-journal';
import type {
  LifecycleJournalEntryMatch,
  LifecycleJournalQuarantineResult,
  LifecycleJournalUnreadableEntry,
} from '@canopy/protocol/remote-control/shell/lifecycle-journal';
import { ConfirmDialog } from '@canopy/ui-shared/primitives/ConfirmDialog';
import { Fact, FactList } from '@canopy/ui-shared/components';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import { LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID } from './test-ids';

/** A path or name: replay-blocked, selectable, breaking anywhere. */
function Detail({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}): JSX.Element {
  return (
    <Fact
      label={label}
      fit="break-all"
      mono
      valueTone="secondary"
      dataTestId={testId}
    >
      <span className={`${REPLAY_BLOCK_CLASS} select-text`}>{value}</span>
    </Fact>
  );
}

function DetailList({ children }: { children: ReactNode }): JSX.Element {
  return (
    <FactList layout="stacked" rowGap="2">
      {children}
    </FactList>
  );
}

function MatchSentence({
  match,
}: {
  match: LifecycleJournalEntryMatch;
}): JSX.Element {
  return match.kind === 'project' ? (
    <>
      Its file name matches the project{' '}
      <span className={REPLAY_MASK_CLASS}>“{match.projectName}”</span>.
    </>
  ) : (
    <>
      Its file name matches the worktree{' '}
      <span className={REPLAY_MASK_CLASS}>“{match.worktreeName}”</span> in{' '}
      <span className={REPLAY_MASK_CLASS}>“{match.projectName}”</span>.
    </>
  );
}

function MovedDetails({
  moved,
}: {
  moved: LifecycleJournalQuarantineResult;
}): JSX.Element {
  return (
    <DetailList>
      <Detail
        label="Moved to"
        value={moved.quarantineLocationLabel}
        testId={`${LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID}-moved-to`}
      />
      <Detail
        label="New name"
        value={moved.quarantinedName}
        testId={`${LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID}-moved-name`}
      />
    </DetailList>
  );
}

function EntryMessage({
  entry,
  remaining,
  movedBefore,
}: {
  entry: LifecycleJournalUnreadableEntry;
  remaining: number;
  movedBefore: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {movedBefore ? (
        <p>The previous record was moved. This one is unreadable too.</p>
      ) : null}
      <p>
        Its owner can’t be determined. It may have been protecting recovery data
        for a project. Moving it lets deleting, archiving and background cleanup
        resume for all projects. It’s moved, never deleted.
      </p>
      {entry.match ? (
        <p data-testid={`${LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID}-match`}>
          <MatchSentence match={entry.match} />
        </p>
      ) : null}
      {entry.identityVerified ? null : (
        <p>
          This file system can’t confirm the record is the one reviewed here, so
          it can’t be moved from here. Move it manually.
        </p>
      )}
      {remaining > 1 ? (
        <p>
          {remaining - 1} more unreadable{' '}
          {remaining - 1 === 1 ? 'record follows' : 'records follow'}.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Opens `client`'s review for a refusal; a review already open keeps its
 * state. `LifecycleJournalQuarantineHost` calls it once this module loads.
 */
export function openLifecycleJournalQuarantineReview(
  client: CanopyClient,
): void {
  const { view, open } = lifecycleJournalQuarantineStoreFor(client).getState();
  if (view.phase === 'closed') void open();
}

/** CAN-5335: the review and its store, loaded by `LifecycleJournalQuarantineHost`. */
export function LifecycleJournalQuarantineReview({
  client,
  supported,
}: {
  client: CanopyClient;
  supported: boolean;
}): JSX.Element | null {
  const store = lifecycleJournalQuarantineStoreFor(client);
  const view = store((state) => state.view);
  const { open, close, quarantine } = store.getState();
  if (!supported) return null;
  const testIds = {
    dataTestId: LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID,
    confirmTestId: `${LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID}-confirm`,
    cancelTestId: `${LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID}-cancel`,
  };
  switch (view.phase) {
    case 'closed':
    case 'loading':
      return null;
    case 'failed':
      return (
        <ConfirmDialog
          {...testIds}
          title="Couldn’t review the operation records"
          message={view.message}
          confirmLabel="Try again"
          onConfirm={() => void open()}
          onCancel={close}
        />
      );
    case 'moved-unchecked':
      return (
        <ConfirmDialog
          {...testIds}
          title="Record moved to quarantine"
          message="Couldn’t check for other unreadable records. Check again before you try your action."
          confirmLabel="Check again"
          onConfirm={() => void open()}
          onCancel={close}
        >
          <MovedDetails moved={view.moved} />
        </ConfirmDialog>
      );
    case 'inspected':
      break;
  }
  const { inspection, moved, moving, moveError, moveRecorded } = view;
  if (inspection.status === 'directory-unreadable')
    return (
      <ConfirmDialog
        {...testIds}
        title="Operation records can’t be listed"
        message="Deleting and archiving stay paused for every project until this folder can be read. Check its permissions, then check again."
        confirmLabel="Check again"
        errorMessage={moveError}
        // A failure the host recorded is linked, not recorded again.
        {...(moveRecorded
          ? { errorRecordingDisabled: true as const }
          : { errorSource: 'lifecycle-journal-quarantine-move' })}
        onConfirm={() => void open()}
        onCancel={close}
      >
        <DetailList>
          <Detail
            label="Folder"
            value={inspection.locationLabel}
            testId={`${LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID}-location`}
          />
        </DetailList>
      </ConfirmDialog>
    );
  if (inspection.status === 'clear')
    return (
      <ConfirmDialog
        {...testIds}
        title={moved ? 'Record moved to quarantine' : 'No unreadable records'}
        message={
          moved
            ? 'Deleting and archiving can resume. Try your action again.'
            : 'Nothing is pausing deleting or archiving now. Try your action again.'
        }
        confirmLabel="Done"
        // A failed move's re-read can land here; keep what it reported.
        errorMessage={moveError}
        // A failure the host recorded is linked, not recorded again.
        {...(moveRecorded
          ? { errorRecordingDisabled: true as const }
          : { errorSource: 'lifecycle-journal-quarantine-move' })}
        onConfirm={close}
        onCancel={close}
      >
        {moved ? <MovedDetails moved={moved} /> : null}
      </ConfirmDialog>
    );
  const [entry] = inspection.entries;
  if (!entry) return null;
  const details: ReactNode = (
    <DetailList>
      <Detail
        label={entry.kind === 'directory' ? 'Folder' : 'File'}
        value={entry.name}
        testId={`${LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID}-name`}
      />
      <Detail
        label="Location"
        value={inspection.locationLabel}
        testId={`${LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID}-location`}
      />
      <Detail
        label="Moves to"
        value={inspection.quarantineLocationLabel}
        testId={`${LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID}-destination`}
      />
    </DetailList>
  );
  return (
    <ConfirmDialog
      {...testIds}
      title="Move unreadable record to quarantine?"
      message={
        <EntryMessage
          entry={entry}
          remaining={inspection.entries.length}
          movedBefore={moved !== null}
        />
      }
      confirmLabel="Move to quarantine"
      busyLabel="Moving…"
      busy={moving}
      confirmDisabled={!entry.identityVerified}
      errorMessage={moveError}
      // A failure the host recorded is linked, not recorded again.
      {...(moveRecorded
        ? { errorRecordingDisabled: true as const }
        : { errorSource: 'lifecycle-journal-quarantine-move' })}
      // Lifts a fence for every project: Enter must not confirm by accident.
      focusCancel
      onConfirm={() => void quarantine(entry)}
      onCancel={close}
    >
      {details}
    </ConfirmDialog>
  );
}
