import type { JSX } from 'react';
import { RefreshIcon } from '../icons/AppIcons';
import { formatRelativeTime } from '../lib/format-relative-time';
import type { SkillUpdateAction } from '../lib/skill-update-action';
import { useMinuteClock } from '../lib/useMinuteClock';
import type { DetailMoreMenuItem } from './DetailMoreMenu';
import { RefreshSpinner } from './RefreshSpinner';
import { Notice, NoticeButton } from './Notice';

export interface SkillUpdateNoticeProps {
  /** Omitted when the skill is not updatable: nothing renders. */
  action: SkillUpdateAction | undefined;
  /**
   * Opens the host's remove confirmation, offered when the skill is no longer
   * in its source. Omit when the host cannot remove it.
   */
  onRemove?: () => void;
}

/**
 * The installed skill detail's one update notice (CAN-4264), under the page
 * header: a failure first, then an update in progress, then an available
 * update with its Update action. A host that cannot run updates shows the
 * cached availability and says where to update. Renders nothing when there
 * is nothing to say; the meta line reports checks and "Up to date".
 */
export function SkillUpdateNotice({
  action,
  onRemove,
}: SkillUpdateNoticeProps): JSX.Element | null {
  if (!action) return null;

  if (action.status === 'blocked') {
    if (!action.updateAvailable) return null;
    return (
      <Notice
        title="Update available"
        data-testid="skill-update-notice"
        data-state="blocked"
      >
        {action.reason}
      </Notice>
    );
  }

  const { error } = action;
  if (error?.kind === 'missing-source') {
    return (
      <Notice
        intent="attention"
        title="This skill is no longer in its source"
        data-testid="skill-update-notice"
        data-state="missing-source"
        actions={
          onRemove ? (
            <NoticeButton
              onClick={onRemove}
              data-testid="skill-update-notice-remove"
            >
              Remove
            </NoticeButton>
          ) : undefined
        }
      >
        You can keep using this copy or remove it.
      </Notice>
    );
  }
  if (error) {
    const checkFailed = error.kind === 'check-failed';
    return (
      <Notice
        errorSource="skill-update-notice"
        intent="destructive"
        title={
          checkFailed
            ? 'Couldn’t check for updates'
            : 'Couldn’t update this skill'
        }
        data-testid="skill-update-notice"
        data-state={error.kind}
        detail={error.detail}
        actions={
          <NoticeButton
            onClick={checkFailed ? action.onCheck : action.onApply}
            disabled={action.pending !== 'none'}
            data-testid="skill-update-notice-retry"
          >
            Try again
          </NoticeButton>
        }
      >
        Try again.
      </Notice>
    );
  }

  if (action.pending === 'applying') {
    return (
      <Notice
        icon={<RefreshSpinner spinning size="sm" tone="secondary" />}
        data-testid="skill-update-notice"
        data-state="applying"
      >
        Updating to the latest version…
      </Notice>
    );
  }

  if (!action.updateAvailable) return null;
  return (
    <Notice
      title="Update available"
      data-testid="skill-update-notice"
      data-state="available"
      actions={
        <NoticeButton
          variant="primary"
          onClick={action.onApply}
          disabled={action.pending !== 'none'}
          data-testid="skill-read-detail-apply-update"
        >
          Update
        </NoticeButton>
      }
    >
      A newer version of this skill is ready to install.
    </Notice>
  );
}

export interface SkillUpdateStatusProps {
  action: SkillUpdateAction | undefined;
}

/** Whether {@link SkillUpdateStatus} has anything to say for `action`. */
export function hasSkillUpdateStatus(
  action: SkillUpdateAction | undefined,
): boolean {
  if (action?.status !== 'ready') return false;
  if (action.pending === 'checking') return true;
  return (
    !action.updateAvailable &&
    action.error === undefined &&
    action.checkedAt !== undefined
  );
}

/**
 * The update state in the detail header's meta line: a check in progress,
 * or "Up to date" once a check in this session found nothing newer. A
 * cached "no update known" says nothing, so the page never claims more than
 * it knows.
 */
export function SkillUpdateStatus({
  action,
}: SkillUpdateStatusProps): JSX.Element | null {
  const now = useMinuteClock();
  if (action?.status !== 'ready' || !hasSkillUpdateStatus(action)) return null;
  if (action.pending === 'checking') {
    return (
      <span
        className="inline-flex items-center gap-1.5"
        role="status"
        data-testid="skill-update-status"
        data-state="checking"
      >
        <RefreshSpinner spinning size="sm" />
        Checking for updates…
      </span>
    );
  }
  const checkedAt = action.checkedAt ?? now;
  return (
    <span
      className="inline-flex items-center gap-1.5"
      role="status"
      data-testid="skill-update-status"
      data-state="up-to-date"
    >
      Up to date
      <span aria-hidden="true">·</span>
      Checked{' '}
      {now - checkedAt < 60_000
        ? 'just now'
        : formatRelativeTime(checkedAt, now)}
    </span>
  );
}

/**
 * The detail More menu's "Check for updates" item: disabled while an update
 * operation runs, and with the reason on a host that cannot run updates.
 */
export function skillUpdateMenuItem(
  action: SkillUpdateAction | undefined,
): DetailMoreMenuItem | null {
  if (!action) return null;
  if (action.status === 'blocked') {
    return {
      id: 'check-updates',
      label: 'Check for updates',
      icon: <RefreshIcon />,
      testId: 'skill-read-detail-check-updates',
      onSelect: (): void => {},
      disabled: true,
      reason: action.reason,
    };
  }
  return {
    id: 'check-updates',
    label: 'Check for updates',
    icon: <RefreshIcon />,
    testId: 'skill-read-detail-check-updates',
    onSelect: action.onCheck,
    disabled: action.pending !== 'none',
  };
}
