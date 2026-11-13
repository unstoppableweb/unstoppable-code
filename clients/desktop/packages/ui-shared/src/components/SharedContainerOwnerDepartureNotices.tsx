import { useId, type JSX } from 'react';
import type { SharedContainerOwnerDepartureNotice } from '@canopy/protocol/shared-containers';
import { REPLAY_BLOCK_CLASS, REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { Notice } from './Notice';
import { ListRow } from './ListRow';
import { RailIconButton } from './RailIconButton';
import { Tooltip } from './Tooltip';
import { TrashIcon } from '../icons/AppIcons';

export interface SharedContainerOwnerDepartureNoticesProps {
  notices: readonly SharedContainerOwnerDepartureNotice[];
  /** Called with the notice's own id, never its container's. */
  onDismiss: (noticeId: string) => void;
  /** Notices whose dismissal is in flight. */
  dismissingIds?: ReadonlySet<string>;
  className?: string;
  /** Sidebar records are unavailable rows; an open chat keeps its notice. */
  presentation?: 'notice' | 'row';
}

/**
 * The record that a share ended because its owner left the organization. It
 * reports a fact and offers only dismissal: the original is gone, so there is
 * nothing here to open, restore or copy.
 */
export function SharedContainerOwnerDepartureNotices({
  notices,
  onDismiss,
  dismissingIds,
  className = '',
  presentation = 'notice',
}: SharedContainerOwnerDepartureNoticesProps): JSX.Element | null {
  if (notices.length === 0) return null;
  return (
    <div
      className={`flex flex-col ${presentation === 'row' ? '' : 'gap-2'} ${className}`}
    >
      {notices.map((notice) =>
        presentation === 'row' ? (
          <OwnerDepartureRow
            key={notice.id}
            notice={notice}
            dismissing={dismissingIds?.has(notice.id) === true}
            onDismiss={onDismiss}
          />
        ) : (
          <OwnerDepartureNotice
            key={notice.id}
            notice={notice}
            dismissing={dismissingIds?.has(notice.id) === true}
            onDismiss={onDismiss}
          />
        ),
      )}
    </div>
  );
}

function OwnerDepartureRow({
  notice,
  dismissing,
  onDismiss,
}: {
  notice: SharedContainerOwnerDepartureNotice;
  dismissing: boolean;
  onDismiss: (noticeId: string) => void;
}): JSX.Element {
  const descriptionId = useId();
  const testId = `shared-container-owner-departure-${notice.containerId}`;
  const reason = (
    <span className="text-pretty">
      Shared by <span className={REPLAY_BLOCK_CLASS}>{notice.ownerName}</span>,
      who is no longer in the organization.
    </span>
  );
  return (
    <>
      <span id={descriptionId} hidden>
        {reason}
      </span>
      <Tooltip
        label={reason}
        showOnTouch
        className="w-full"
        contentClassName="max-w-70"
      >
        <ListRow
          aria-disabled="true"
          aria-describedby={descriptionId}
          data-testid={`${testId}-row`}
          rowProps={{ 'data-testid': testId }}
          size="md"
          onKeyDown={(event): void => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          actionsReveal={false}
          actions={
            <RailIconButton
              icon={TrashIcon}
              aria-label="Remove"
              tooltipLabel="Remove"
              data-testid={`${testId}-dismiss`}
              disabled={dismissing}
              // Only the record is removed; access to the departed share has ended.
              onClick={(): void => onDismiss(notice.id)}
            />
          }
        >
          {/* Match the nav label's 32px column without an empty icon slot. */}
          <span className={`pl-6 ${REPLAY_MASK_CLASS}`}>{notice.title}</span>
        </ListRow>
      </Tooltip>
    </>
  );
}

function OwnerDepartureNotice({
  notice,
  dismissing,
  onDismiss,
}: {
  notice: SharedContainerOwnerDepartureNotice;
  dismissing: boolean;
  onDismiss: (noticeId: string) => void;
}): JSX.Element {
  const dismissLabelId = useId();
  const testId = `shared-container-owner-departure-${notice.containerId}`;
  return (
    <>
      <span id={dismissLabelId} hidden className={REPLAY_BLOCK_CLASS}>
        Dismiss notice about {notice.title}
      </span>
      <Notice
        data-testid={testId}
        // A standing record, read in place: each one would otherwise announce
        // again on every mount of the surface that lists it.
        role="none"
        titleLayout="stacked"
        title={
          <span className={`wrap-anywhere ${REPLAY_MASK_CLASS}`}>
            {notice.title}
          </span>
        }
        onDismiss={(): void => onDismiss(notice.id)}
        dismissLabelledBy={dismissLabelId}
        dismissDisabled={dismissing}
        dismissTestId={`${testId}-dismiss`}
      >
        <span className="wrap-anywhere">
          Shared by{' '}
          <span className={REPLAY_BLOCK_CLASS}>{notice.ownerName}</span>, who is
          no longer in the organization.
        </span>
      </Notice>
    </>
  );
}
