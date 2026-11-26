import { useCallback, useMemo, useRef, useState, type JSX } from 'react';
import {
  Tooltip,
  ConfirmDialog,
  FloatingMenu,
  Notice,
  NoticeButton,
} from '@canopy/ui-shared';
import { MoreHorizontalIcon } from '@canopy/ui-shared/icons';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  type ActionMenuItem,
} from '@canopy/ui-shared/components';
import {
  PauseIcon,
  PencilIcon,
  ScheduleIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { getDocument } from '@canopy/ui-shared/panels';
import type { AutomationMutationResponse } from '@canopy/desktop-shared/types';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { toAppError } from '@canopy/protocol/app-errors';
import type { ChatBannerTarget } from '@/stores/aiCreditsBannerStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  formatScheduledCadence,
  formatScheduledSendLabel,
  getScheduledMessagesForChat,
  type ScheduledQueuedMessage,
} from '@/lib/worktreeSessionPromptAutomations';

/** Prompt lines previewed in the name tooltip; the Automations page has the rest. */
const PROMPT_PREVIEW_LINES = 3;
const PROMPT_PREVIEW_MAX_CHARS = 240;

/** Shown only when the backend gives no reason of its own. */
const RUN_FAILED_FALLBACK = "Couldn't start the run.";
const PAUSE_FAILED_FALLBACK = "Couldn't pause the automation.";

interface ScheduledAutomationsNoticeProps {
  /**
   * The chat whose recurring automations to surface. Pass `null` to render
   * nothing (embedded mirrors, editing states).
   */
  target: ChatBannerTarget | null;
}

function promptPreview(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, PROMPT_PREVIEW_LINES)
    .join('\n');
  return lines.length > PROMPT_PREVIEW_MAX_CHARS
    ? `${lines.slice(0, PROMPT_PREVIEW_MAX_CHARS).trimEnd()}…`
    : lines;
}

function scheduledAtMs(message: ScheduledQueuedMessage): number {
  const ms = new Date(message.scheduledAt).getTime();
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * Quiet composer notice for recurring (`cron`) `worktree_session_prompt`
 * automations that target this chat. A recurring automation always has a
 * next run, so rendering it as a transcript bubble pinned it under the
 * conversation forever; one line above the composer states the cadence and
 * the next run instead.
 *
 * Deliberately offers no Clear and no inline edit: both were written for
 * one-time sends (Clear disables, inline Save rewrites the schedule as
 * one-time). Run now never disables anything; Pause asks first; Edit hands
 * off to the Automations editor, which understands cron schedules.
 */
export function ScheduledAutomationsNotice({
  target,
}: ScheduledAutomationsNoticeProps): JSX.Element | null {
  const activities = useAutomationsStore((s) => s.activities);
  const runNow = useAutomationsStore((s) => s.runNow);
  const updateActivity = useAutomationsStore((s) => s.updateActivity);

  const recurring = useMemo(
    (): ScheduledQueuedMessage[] =>
      target
        ? getScheduledMessagesForChat({
            activities,
            workspaceId: target.projectId,
            worktreeId: target.worktreeId,
            chatId: target.chatId,
          })
            .filter((message) => message.scheduleKind === 'cron')
            .sort((a, b) => scheduledAtMs(a) - scheduledAtMs(b))
        : [],
    [activities, target],
  );

  const pause = useCallback(
    (id: string): Promise<AutomationMutationResponse> =>
      updateActivity({ id, enabled: false }),
    [updateActivity],
  );

  if (!target) return null;
  // Run and Pause state belongs to one automation. Remount the view when the
  // single automation changes (or the notice switches to or from the summary)
  // so a pending Pause dialog or a run error never follows a different one.
  const viewKey =
    recurring.length === 1 ? `single:${recurring[0]?.automationId}` : 'multi';
  return (
    <ScheduledAutomationsNoticeView
      key={viewKey}
      automations={recurring}
      onRunNow={runNow}
      onPause={pause}
      onEdit={openAutomationEditor}
      onManage={openAutomationsPage}
    />
  );
}

function openAutomationEditor(activityId: string): void {
  useNavigationStore.getState().openAutomationEdit({ activityId });
}

function openAutomationsPage(): void {
  useNavigationStore.getState().navigate('automations');
}

interface ScheduledAutomationsNoticeViewProps {
  /** Recurring automations for one chat, soonest next run first. */
  automations: ScheduledQueuedMessage[];
  onRunNow: (id: string) => Promise<AutomationMutationResponse>;
  /** Disables the automation. Only called after the user confirms. */
  onPause: (id: string) => Promise<AutomationMutationResponse>;
  onEdit: (id: string) => void;
  onManage: () => void;
}

/**
 * Presentational half of {@link ScheduledAutomationsNotice}, driven entirely
 * by props so the Message Bubble States gallery can render it from fixtures.
 */
export function ScheduledAutomationsNoticeView({
  automations: recurring,
  onRunNow: runNow,
  onPause,
  onEdit,
  onManage,
}: ScheduledAutomationsNoticeViewProps): JSX.Element | null {
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [pauseId, setPauseId] = useState<string | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);
  // The shown text is an answer main gave or an IPC failure it already
  // recorded, so the dialog must not record it again. Reset with `pauseError`.
  const [pauseErrorRecorded, setPauseErrorRecorded] = useState(false);
  // The close icon hides the notice until the schedule changes.
  const scheduleKey = recurring
    .map((automation) => `${automation.automationId}@${automation.scheduledAt}`)
    .join('|');
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const dismiss = useCallback(
    (): void => setDismissedKey(scheduleKey),
    [scheduleKey],
  );

  const single = recurring.length === 1 ? recurring[0] : undefined;
  const singleId = single?.automationId;

  const handleRunNow = useCallback(async (): Promise<void> => {
    if (!singleId) return;
    setRunBusy(true);
    setRunError(null);
    try {
      const result = await runNow(singleId);
      // The backend's reason is user-ready ("Activity is already running.").
      if (!result.ok) setRunError(result.error || RUN_FAILED_FALLBACK);
    } catch {
      setRunError(RUN_FAILED_FALLBACK);
    } finally {
      setRunBusy(false);
    }
  }, [runNow, singleId]);

  const handleEdit = useCallback((): void => {
    if (!singleId) return;
    setMenuOpen(false);
    onEdit(singleId);
  }, [onEdit, singleId]);

  const handleRequestPause = useCallback((): void => {
    if (!singleId) return;
    setMenuOpen(false);
    setPauseError(null);
    setPauseErrorRecorded(false);
    setPauseId(singleId);
  }, [singleId]);

  const handleCancelPause = useCallback((): void => {
    setPauseId(null);
    setPauseError(null);
    setPauseErrorRecorded(false);
  }, []);

  const handleConfirmPause = useCallback(async (): Promise<void> => {
    if (!pauseId) return;
    setPauseBusy(true);
    setPauseError(null);
    setPauseErrorRecorded(false);
    try {
      const result = await onPause(pauseId);
      if (result.ok) {
        setPauseId(null);
      } else {
        // The store turns a rejected IPC call into this answer after main
        // recorded it, and main's own refusals are not failures.
        setPauseErrorRecorded(true);
        setPauseError(result.error || PAUSE_FAILED_FALLBACK);
      }
    } catch (error: unknown) {
      setPauseErrorRecorded(
        toAppError(resolveClientAppError(error))?.recordedBy !== undefined,
      );
      setPauseError(PAUSE_FAILED_FALLBACK);
    } finally {
      setPauseBusy(false);
    }
  }, [onPause, pauseId]);

  if (recurring.length === 0 || dismissedKey === scheduleKey) return null;

  const first = recurring[0];
  const nextLabel = first ? formatScheduledSendLabel(first.scheduledAt) : null;

  if (!single) {
    return (
      <Notice
        intent="neutral"
        role="none"
        icon={<ScheduleIcon size={16} aria-hidden="true" />}
        title={`${recurring.length} recurring automations`}
        data-testid="chat-input-scheduled-automations-notice"
        onDismiss={dismiss}
        dismissTestId="scheduled-automations-dismiss"
        actions={
          <NoticeButton
            variant="secondary"
            onClick={onManage}
            data-testid="scheduled-automations-manage"
          >
            Manage
          </NoticeButton>
        }
      >
        {nextLabel ? `Next run ${nextLabel}` : 'Scheduled to run again'}
      </Notice>
    );
  }

  const cadence = formatScheduledCadence(single) ?? 'Recurring';
  const menuItems: readonly ActionMenuItem[] = [
    {
      key: 'edit',
      label: 'Edit automation',
      icon: <PencilIcon />,
      testId: 'scheduled-automation-edit',
      onSelect: handleEdit,
    },
    {
      key: 'pause',
      label: 'Pause automation',
      icon: <PauseIcon />,
      testId: 'scheduled-automation-pause',
      onSelect: handleRequestPause,
    },
  ];
  const preview = promptPreview(single.text);

  return (
    <>
      <Notice
        intent="neutral"
        role="none"
        icon={<ScheduleIcon size={16} aria-hidden="true" />}
        title={cadence}
        data-testid="chat-input-scheduled-automations-notice"
        // The notice itself is static (`role="none"`); the failure arrives
        // after the click, so it needs its own live region to be announced.
        detail={runError ?? undefined}
        announceDetail
        onDismiss={dismiss}
        dismissTestId="scheduled-automations-dismiss"
        actions={
          <>
            <NoticeButton
              variant="secondary"
              onClick={(): void => void handleRunNow()}
              disabled={runBusy}
              busy={runBusy}
              busyLabel="Running…"
              data-testid="scheduled-automation-run-now"
            >
              Run now
            </NoticeButton>
            <NoticeButton
              ref={moreButtonRef}
              variant="secondary"
              aria-label="Automation options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={(): void => setMenuOpen((open) => !open)}
              data-testid="scheduled-automation-more"
            >
              <MoreHorizontalIcon size="sm" />
            </NoticeButton>
            <FloatingMenu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              anchorRef={moreButtonRef}
              placement="top-right"
              aria-label="Automation options"
              data-testid="scheduled-automation-menu"
              className="min-w-44"
            >
              <ActionMenuRowStyle>
                <ActionMenuItems
                  items={menuItems}
                  onSelect={(item): void => {
                    if (item.disabled || !item.onSelect) return;
                    item.onSelect();
                    setMenuOpen(false);
                    moreButtonRef.current?.focus({ preventScroll: true });
                  }}
                />
              </ActionMenuRowStyle>
            </FloatingMenu>
          </>
        }
      >
        {/* Portaled to the body: the automation name is recorded, and the
            prompt preview carries its own replay block. */}
        <Tooltip
          label={single.activityName}
          description={
            <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{preview}</span>
          }
          disabled={preview.length === 0}
        >
          <span
            // Focusable so keyboard users can reach the prompt preview.
            tabIndex={0}
            data-testid="scheduled-automation-name"
            className="focus-ring inline-block max-w-72 truncate align-bottom"
          >
            {single.activityName}
          </span>
        </Tooltip>
        {nextLabel ? ` · next ${nextLabel}` : null}
      </Notice>
      {pauseId !== null && (
        <ConfirmDialog
          dataTestId="scheduled-automation-pause-dialog"
          confirmTestId="scheduled-automation-pause-confirm"
          title="Pause this automation?"
          message="It won't run again until you turn it back on from Automations."
          confirmLabel="Pause"
          busy={pauseBusy}
          busyLabel="Pausing…"
          errorMessage={pauseError}
          {...(pauseErrorRecorded
            ? { errorRecordingDisabled: true as const }
            : { errorSource: 'scheduled-automations-pause' })}
          onConfirm={(): void => void handleConfirmPause()}
          onCancel={handleCancelPause}
          ownerDocument={getDocument(moreButtonRef.current)}
        />
      )}
    </>
  );
}
