import type { JSX } from 'react';
import { RefreshIcon } from '../icons/AppIcons';
import { formatRelativeTime } from '../lib/format-relative-time';
import type { SkillUpdateAction } from '../lib/skill-update-action';
import { useMinuteClock } from '../lib/useMinuteClock';
import type { DetailMoreMenuItem } from './DetailMoreMenu';
import { RefreshSpinner } from './RefreshSpinner';
import { Notice, NoticeButton } from '../primitives/Notice';
import {
  DetailVersionUpdateFact,
  type DetailUpdateState,
  type DetailVersionUpdate,
} from './CapabilityDetailLayout';

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
        errorRecordingDisabled={
          error.kind === 'update-failed' && error.recorded === true
        }
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
        {null}
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

/** The Version row's "Checked just now", then "Checked 5m ago". */
function checkedAgo(checkedAt: number, now: number): string {
  const age =
    now - checkedAt < 60_000 ? 'just now' : formatRelativeTime(checkedAt, now);
  return `Checked ${age}`;
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

/**
 * New Customize's Version row for an installed skill, the row every entity
 * uses: `unknown` until a check this session, `current` only once one found
 * nothing newer, `checking` or `applying` while work runs, `available` with
 * its update action, and a failure in place of the state. A skill with no
 * update action (nothing to check or update here) says `unknown`, with no icon.
 */
export function SkillVersionFact({
  action,
  version,
  onRemove,
  refreshError,
  onShareUpdate,
  sourceChanged,
}: {
  readonly action: SkillUpdateAction | undefined;
  /** From SKILL.md: shown under session replay's block. */
  readonly version?: string;
  readonly onRemove?: () => void;
  /** A failure after an update (reading the new content), on this row. */
  readonly refreshError?: string;
  /** A shared copy's update: the one available, and the one the icon runs. */
  readonly onShareUpdate?: () => void;
  /** A shared copy's source changed but its update cannot run here: no icon. */
  readonly sourceChanged?: boolean;
}): JSX.Element {
  const now = useMinuteClock();
  const ready = action?.status === 'ready' ? action : undefined;
  const error = ready?.error;
  const missing = error?.kind === 'missing-source';
  const failure = ((): DetailVersionUpdate['failure'] => {
    if (refreshError) return { text: refreshError };
    if (!ready || !error) return undefined;
    const label = missing
      ? 'No longer in its source'
      : error.kind === 'check-failed'
        ? 'Couldn’t check for updates'
        : 'Couldn’t update this skill';
    const run = missing
      ? onRemove
      : error.kind === 'check-failed'
        ? ready.onCheck
        : ready.onApply;
    return {
      text: label,
      // The installer's diagnostic can carry the skill's path.
      ...(error.kind !== 'missing-source' && error.detail
        ? { detail: error.detail }
        : {}),
      tone: missing ? 'attention' : 'failed',
      ...(run
        ? {
            retry: {
              label: missing ? 'Remove' : 'Try again',
              run,
              disabled: ready.pending !== 'none',
            },
          }
        : {}),
    };
  })();
  // A skill gone from its source has nothing of its own to update to.
  const available =
    onShareUpdate !== undefined ||
    sourceChanged === true ||
    (action !== undefined && action.updateAvailable && !missing);
  const state: DetailUpdateState =
    ready?.pending === 'applying'
      ? 'applying'
      : ready?.pending === 'checking'
        ? 'checking'
        : available
          ? 'available'
          : hasSkillUpdateStatus(ready)
            ? 'current'
            : 'unknown';
  // Only "Up to date" has a check behind it, and it reads as the header's did.
  const checkedAt =
    state === 'current' && !failure ? ready?.checkedAt : undefined;
  return (
    <DetailVersionUpdateFact
      update={{
        version,
        versionReplay: 'block',
        state,
        ...(checkedAt !== undefined
          ? { checked: checkedAgo(checkedAt, now) }
          : {}),
        ...(onShareUpdate || ready
          ? {
              // A change only the source shows has no update to run here.
              run:
                onShareUpdate ??
                (sourceChanged && !action?.updateAvailable
                  ? undefined
                  : ready?.onApply),
              check: ready?.onCheck,
            }
          : {}),
        // A host that cannot run updates says where to; a share needs none.
        ...(action?.status === 'blocked' && !onShareUpdate
          ? { note: action.reason }
          : {}),
        ...(failure ? { failure } : {}),
      }}
      testId="skill-version-fact"
    />
  );
}
