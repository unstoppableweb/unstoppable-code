import { copyTextToClipboard } from '@/lib/clipboard';
import { openAuthenticatedCloudUrl } from '@/lib/openAuthenticatedCloudPage';
import { toastCategoryLabel } from '@/lib/osNotifications';
import { toastMessageReplayClass } from '@/lib/replayPrivacy';
import { openInWorkspaceContext } from '@/lib/contextScope';
import { brandText } from '@/lib/brand';
import {
  canNavigateToToastWorktree,
  navigateToToastWorktree,
} from '@/lib/toastWorktreeNavigation';
import { canNavigateToWorktreeFromSidebarItems } from '@/lib/worktreeNavigation';
import type {
  PinnedToast,
  Toast,
  ToastLink,
  ToastMeta,
} from '@/stores/toastStore';
import {
  toastLifetimeMs,
  toastStack,
  useToastStore,
} from '@/stores/toastStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  ReportActionBoundary,
  ReportThisDialog,
  ToastFailureReference,
  ToastFailureReportButton,
  type ToastFailureReport,
} from '@canopy/ui-app/feedback';
import {
  DEFAULT_IN_APP_NOTIFICATION_PLACEMENT,
  NoticeButton,
  NotificationDetailsDialog,
  previewToastMessage,
  ToastActionButton,
  ToastNotice,
  ToastStack,
  ToastStackActivatableCard,
  type InAppNotificationPlacement,
  type ToastStackItem,
} from '@canopy/ui-shared';
import {
  Button,
  CopyDetailsButton,
  CopyLinkButton,
} from '@canopy/ui-shared/components';
import { ExternalIcon } from '@canopy/ui-shared/icons/AppIcons';
import { TOAST_INTENT } from '@canopy/ui-shared/lib';
import type { AppError } from '@canopy/protocol/app-errors';
import type { JSX, MouseEvent, ReactNode } from 'react';
import { useState, useSyncExternalStore } from 'react';
import { DesktopReportEligibility } from './DesktopReportThisAction';
import { ProjectIcon } from './ProjectIcon';
import { toastTrackpadSwipe } from './toastTrackpadSwipe';
import { useCoworkEntryLabel } from './useCoworkEntryLabel';

const OPEN_LABEL = 'Open';

function noop(): void {}

/**
 * Copy/open actions for a shareable link attached to a toast. Rendered inside
 * both the compact toast and its detail modal so a "shared" notification always
 * hands the user the link. Both are the standard toast action button (the
 * `NoticeButton` recovery actions such as "Allow all sites" use), each with a
 * leading glyph, so they read as one set of peer actions (CAN-3510). Copy is
 * the shared `CopyLinkButton` in its `notice` variant, so its copy behavior and
 * `Copied` confirmation stay in one place. Clicks stop propagation so they
 * never trigger the toast's own navigate-and-dismiss behavior.
 */
function ToastLinkActions({ link }: { link: ToastLink }): JSX.Element {
  const handleOpen = (e: MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    const openLink = (): void => {
      void window.api.browser.openLink({ url: link.url });
    };
    if (link.signedIn === true) openAuthenticatedCloudUrl(link.url, openLink);
    else openLink();
  };

  return (
    <div className="flex items-center gap-2">
      <CopyLinkButton
        url={link.url}
        variant="notice"
        dataTestId="toast-copy-link"
        write={copyTextToClipboard}
      />
      <NoticeButton
        onClick={handleOpen}
        data-testid="toast-open-link"
        icon={<ExternalIcon size="sm" />}
      >
        {OPEN_LABEL}
      </NoticeButton>
    </div>
  );
}

function modalTitleColor(type: Toast['type']): string {
  switch (type) {
    case 'error':
      return 'text-red-600 dark:text-red-400';
    case 'success':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'warning':
      return 'text-amber-600 dark:text-amber-400';
    default:
      return 'text-blue-600 dark:text-blue-400';
  }
}

function modalTitle(type: Toast['type']): string {
  switch (type) {
    case 'error':
      return 'Error';
    case 'success':
      return 'Success';
    case 'warning':
      return 'Warning';
    default:
      return 'Info';
  }
}

/**
 * Opens where a background failure happened. A failure naming a worktree stays
 * up unless that worktree's context opens, so a refused switch loses nothing.
 */
function openToastFailureOrigin(toast: Toast, onOpened: () => void): void {
  const origin = toast.failure?.origin;
  if (origin === undefined) return;
  const projectId = toast.meta?.projectId;
  const worktreeId = toast.meta?.worktreeId;
  if (projectId === undefined || worktreeId === undefined) {
    origin.open();
    onOpened();
    return;
  }
  if (!canNavigateToToastWorktree(projectId, worktreeId)) return;
  openInWorkspaceContext(projectId, (): void => {
    origin.open();
    onOpened();
  });
}

/** The error a toast's reference row and `Report this` describe. */
function reportedError(toast: PinnedToast): AppError | undefined {
  return toast.failure?.error ?? toast.reference;
}

/** Runs a defect's card or details under the account's report capability. */
function WithToastReportEligibility({
  toast,
  children,
}: {
  toast: PinnedToast;
  children: (eligible: boolean) => ReactNode;
}): ReactNode {
  return reportedError(toast)?.kind === 'defect' ? (
    <DesktopReportEligibility>{children}</DesktopReportEligibility>
  ) : (
    children(false)
  );
}

function ModalMetaDetails({
  meta,
  onNavigate,
}: {
  meta: ToastMeta;
  onNavigate?: () => void;
}): JSX.Element | null {
  const hasContent =
    meta.title || meta.category || meta.workspaceName || meta.worktreeId;
  if (!hasContent) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs fg-secondary">
      {meta.title && (
        <span>
          <span className="fg-secondary/60">Title</span>{' '}
          <span
            className="font-semibold fg-primary/80"
            data-testid="toast-detail-title"
          >
            {meta.title}
          </span>
        </span>
      )}
      {meta.category && (
        <span>
          <span className="fg-secondary/60">Category</span>{' '}
          <span
            className="font-semibold fg-primary/80"
            data-testid="toast-detail-category"
          >
            {toastCategoryLabel(meta.category)}
          </span>
        </span>
      )}
      {meta.workspaceName && (
        <span>
          <span className="fg-secondary/60">Project</span>{' '}
          <span className={`${POSTHOG_REPLAY_MASK_CLASS} fg-primary/80`}>
            {meta.workspaceName}
          </span>
        </span>
      )}
      {meta.worktreeId && (
        <span>
          <span className="fg-secondary/60">Worktree</span>{' '}
          {onNavigate ? (
            <Button variant="link" onClick={onNavigate}>
              <span className={POSTHOG_REPLAY_MASK_CLASS}>
                {meta.worktreeId}
              </span>
            </Button>
          ) : (
            <span className={`${POSTHOG_REPLAY_MASK_CLASS} fg-primary/80`}>
              {meta.worktreeId}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

function ToastDetailModal({
  toast,
  onClose,
  onActionDone,
  onReport,
}: {
  toast: Toast;
  onClose: () => void;
  onActionDone: () => void;
  onReport: (report: ToastFailureReport) => void;
}): JSX.Element {
  const projects = useProjectsStore((state) => state.projects);
  const hasHydratedProjects = useProjectsStore(
    (state) => state.hasHydratedProjects,
  );
  const projectId = toast.meta?.projectId;
  const worktreeId = toast.meta?.worktreeId;
  const canNavigateToWorktree =
    projectId !== undefined &&
    worktreeId !== undefined &&
    canNavigateToWorktreeFromSidebarItems(
      projects,
      projectId,
      worktreeId,
      hasHydratedProjects,
    );
  const handleNavigate =
    projectId !== undefined && worktreeId !== undefined && canNavigateToWorktree
      ? (): void => {
          // A worktree in another organization opens once its context does.
          openInWorkspaceContext(projectId, (): void => {
            if (
              navigateToToastWorktree(
                projectId,
                worktreeId,
                toast.meta?.chatId ? toast.onClick : undefined,
              )
            ) {
              onClose();
            }
          });
        }
      : undefined;

  return (
    <NotificationDetailsDialog
      onClose={onClose}
      title={
        <span className={modalTitleColor(toast.type)}>
          {modalTitle(toast.type)}
        </span>
      }
      titleId="toast-detail-modal-title"
      slotGap="item"
      // Error, chat, and hook messages can quote output or replies, so their
      // detail body is blocked; the card around it is recorded.
      blockFromReplay={
        toastMessageReplayClass(
          toast.type,
          toast.meta?.category,
          toast.meta?.blockMessageFromReplay,
        ) !== ''
      }
      tone={toast.type}
      message={toast.message}
      leading={
        toast.meta && (
          <ModalMetaDetails meta={toast.meta} onNavigate={handleNavigate} />
        )
      }
      trailing={
        <>
          {toast.meta?.link && (
            <div className="flex flex-col gap-2">
              <span className="break-all text-xs fg-secondary">
                {toast.meta.link.url}
              </span>
              <ToastLinkActions link={toast.meta.link} />
            </div>
          )}
          {toast.meta?.action && (
            <div className="flex justify-end">
              <ToastActionButton
                data-testid="toast-action"
                label={toast.meta.action.label}
                busyLabel={toast.meta.action.busyLabel}
                busy={toast.meta.action.busy === true}
                actionKey={toast.id}
                run={toast.meta.action.onClick}
                onDone={onActionDone}
              />
            </div>
          )}
          {toast.failure && (
            <div className="flex flex-col gap-3">
              <ToastFailureReference error={toast.failure.error} />
              <div className="flex flex-wrap justify-end gap-2">
                <WithToastReportEligibility toast={toast}>
                  {(eligible): ReactNode =>
                    eligible && toast.failure ? (
                      <ToastFailureReportButton
                        error={toast.failure.error}
                        {...(toast.failure.telemetry
                          ? { telemetry: toast.failure.telemetry }
                          : {})}
                        onReport={onReport}
                      />
                    ) : null
                  }
                </WithToastReportEligibility>
                {(projectId === undefined ||
                  worktreeId === undefined ||
                  canNavigateToWorktree) && (
                  <NoticeButton
                    data-testid="toast-failure-origin"
                    onClick={(): void =>
                      openToastFailureOrigin(toast, onActionDone)
                    }
                  >
                    {toast.failure.origin.label}
                  </NoticeButton>
                )}
              </div>
            </div>
          )}
        </>
      }
    />
  );
}

interface StackedToast extends ToastStackItem {
  readonly toast: PinnedToast;
}

// One stack item per store toast, so an unchanged toast keeps its identity
// across store updates and the stack leaves it alone.
const stackedToasts = new WeakMap<PinnedToast, StackedToast>();

function stacked(toast: PinnedToast): StackedToast {
  const cached = stackedToasts.get(toast);
  if (cached !== undefined) return cached;
  const item: StackedToast = {
    id: toast.id,
    intent: TOAST_INTENT[toast.type],
    timeoutMs: toastLifetimeMs(toast),
    toast,
  };
  stackedToasts.set(toast, item);
  return item;
}

/**
 * One toast in the early-access stack: the shared `Notice` on the stack's
 * floating card. A toast with an `onClick` or a live worktree opens its
 * destination when the card itself is clicked; its buttons do only their own
 * job.
 */
function StackToastCard(props: {
  toast: PinnedToast;
  onExpand: () => void;
  onDismiss: () => void;
  onReport: (report: ToastFailureReport) => void;
}): ReactNode {
  return (
    <WithToastReportEligibility toast={props.toast}>
      {(eligible): ReactNode => (
        <StackToastCardBody {...props} canReport={eligible} />
      )}
    </WithToastReportEligibility>
  );
}

function StackToastCardBody({
  toast,
  onExpand,
  onDismiss,
  onReport,
  canReport,
}: {
  toast: PinnedToast;
  onExpand: () => void;
  onDismiss: () => void;
  onReport: (report: ToastFailureReport) => void;
  canReport: boolean;
}): JSX.Element {
  const projects = useProjectsStore((state) => state.projects);
  const hasHydratedProjects = useProjectsStore(
    (state) => state.hasHydratedProjects,
  );
  const meta = toast.meta;
  const projectId = meta?.projectId;
  const worktreeId = meta?.worktreeId;
  const chatId = meta?.chatId;
  const hasWorktreeTarget = projectId !== undefined && worktreeId !== undefined;
  const coworkEntryLabel = useCoworkEntryLabel(projectId, worktreeId, chatId);
  const canNavigateToWorktree =
    hasWorktreeTarget &&
    canNavigateToWorktreeFromSidebarItems(
      projects,
      projectId,
      worktreeId,
      hasHydratedProjects,
    );
  // As in notification history, a toast naming a worktree opens it even when
  // it carries no click handler of its own (script, hook and git failures).
  const hasDestination = hasWorktreeTarget
    ? canNavigateToWorktree
    : !!toast.onClick;
  const openDestination = (): void => {
    if (
      projectId !== undefined &&
      worktreeId !== undefined &&
      !canNavigateToWorktreeFromSidebarItems(
        useProjectsStore.getState().projects,
        projectId,
        worktreeId,
        useProjectsStore.getState().hasHydratedProjects,
      )
    ) {
      return;
    }
    if (toast.failure) {
      openToastFailureOrigin(toast, onDismiss);
      return;
    }
    if (toast.onClick) {
      toast.onClick();
      onDismiss();
      return;
    }
    if (projectId === undefined || worktreeId === undefined) return;
    // The toast stays up unless its worktree's context opens and it shows.
    openInWorkspaceContext(projectId, (): void => {
      if (navigateToToastWorktree(projectId, worktreeId)) onDismiss();
    });
  };
  // An ordinary update from a project wears that project's icon in place of
  // the neutral info glyph. A failure, warning, or success keeps its own
  // glyph, whose shape and ink carry the outcome.
  const knownProject =
    projectId === undefined
      ? undefined
      : projects.find((entry) => entry.id === projectId);
  const project = toast.type === 'info' ? knownProject : undefined;
  // The headline names the project, then, muted, the worktree's animal name
  // or the Cowork entry's name. The toast's own title leads otherwise, then
  // its category. A title the headline displaces opens the message instead,
  // so it is never lost.
  const worktreeName =
    knownProject === undefined
      ? undefined
      : knownProject.type === 'cowork'
        ? coworkEntryLabel
        : knownProject.worktrees.some((entry) => entry.id === worktreeId)
          ? worktreeId
          : undefined;
  // The live project names itself; some producers send no workspaceName.
  const projectName = knownProject?.name || meta?.workspaceName || undefined;
  const contextName =
    projectName !== undefined && worktreeName !== undefined
      ? `${projectName} · ${worktreeName}`
      : (projectName ?? worktreeName);
  const headline =
    contextName ??
    meta?.title ??
    (meta?.category === undefined
      ? undefined
      : toastCategoryLabel(meta.category));
  const message =
    meta?.title && headline !== meta.title
      ? `${meta.title}${/[.:!?…]$/.test(meta.title) ? '' : '.'} ${toast.message}`
      : toast.message;
  const messageContext = meta?.messageContext;
  const preview = previewToastMessage(
    messageContext !== undefined && message.endsWith(messageContext)
      ? message.slice(0, message.length - messageContext.length).trimEnd()
      : message,
  );
  // The text preview can keep a message that still wraps past the three-line
  // clamp; the clamp reports that, and the card then opens the full message.
  const [clampOverflow, setClampOverflow] = useState(false);
  const truncated =
    preview.truncated || clampOverflow || preview.text !== message;
  // The card opens the destination the toast names. A cut-off toast that only
  // has its worktree opens its message in full instead (the dialog links the
  // worktree), so a click never discards text the card could not show.
  // A failure's message always wins: its details link the origin too.
  const activate =
    hasDestination &&
    (toast.failure === undefined
      ? toast.onClick !== undefined || !truncated
      : !truncated)
      ? openDestination
      : truncated
        ? onExpand
        : undefined;
  const opensDestination = activate === openDestination;
  const link = meta?.link;
  const action = meta?.action;
  const copyDetails = meta?.copyDetails;
  const failure = toast.failure;
  const reported = reportedError(toast);
  const reportedTelemetry = failure?.telemetry ?? toast.referenceTelemetry;
  const actions =
    link === undefined &&
    action === undefined &&
    copyDetails === undefined &&
    !canReport ? undefined : (
      <>
        {link !== undefined && <ToastLinkActions link={link} />}
        {copyDetails !== undefined && (
          <CopyDetailsButton
            details={copyDetails}
            write={copyTextToClipboard}
            data-testid="toast-copy-details"
          />
        )}
        {canReport && reported !== undefined && (
          <ToastFailureReportButton
            error={reported}
            {...(reportedTelemetry === undefined
              ? {}
              : { telemetry: reportedTelemetry })}
            onReport={onReport}
          />
        )}
        {action !== undefined && (
          <ToastActionButton
            data-testid={action.testId ?? 'toast-action'}
            label={action.label}
            busyLabel={action.busyLabel}
            busy={action.busy === true}
            actionKey={toast.id}
            run={action.onClick}
            onDone={action.keepOpen === true ? noop : onDismiss}
          />
        )}
      </>
    );

  return (
    <ToastStackActivatableCard
      onActivate={activate}
      activateLabel={
        opensDestination ? 'Open notification' : 'Read full notification'
      }
      blurFocusBeforeActivate={!opensDestination}
      toastType={toast.type}
    >
      <ToastNotice
        intent={TOAST_INTENT[toast.type]}
        icon={
          project === undefined ? undefined : (
            <span data-testid="toast-project-icon" className="inline-flex">
              <ProjectIcon
                kind={project.type}
                color={project.color}
                temporary={
                  project.type === 'multi-repo' ? project.temporary : undefined
                }
                repoPath={
                  project.type === 'single-repo' ? project.repoPath : undefined
                }
                size="sm"
              />
            </span>
          )
        }
        title={
          headline === undefined ? undefined : (
            <span
              data-testid="toast-meta-title"
              // The headline names the worktree or project when it has one.
              className={
                headline === contextName ? POSTHOG_REPLAY_MASK_CLASS : undefined
              }
            >
              {projectName !== undefined && worktreeName !== undefined ? (
                // A long entry name truncates; the project stays whole.
                <span className="flex min-w-0">
                  <span className="shrink-0">{projectName}</span>
                  <span
                    data-testid="toast-meta-worktree"
                    className="min-w-0 truncate fg-tertiary"
                  >
                    <span aria-hidden="true" className="whitespace-pre">
                      {' · '}
                    </span>
                    {worktreeName}
                  </span>
                </span>
              ) : (
                headline
              )}
            </span>
          )
        }
        text={preview.text}
        // A message that names a person, such as an invite, opts out of
        // session replay.
        blockTextFromReplay={
          toastMessageReplayClass(
            toast.type,
            meta?.category,
            meta?.blockMessageFromReplay,
          ) !== ''
        }
        {...(messageContext === undefined
          ? {}
          : { textContext: messageContext })}
        onOverflowChange={setClampOverflow}
        footer={
          // A card that leaves the row off relies on Report this for the
          // reference; without Report this (a guest) the row stays.
          reported === undefined ||
          (toast.hideReference === true && canReport) ? undefined : (
            <ToastFailureReference error={reported} />
          )
        }
        actions={actions}
        onDismiss={onDismiss}
      />
    </ToastStackActivatableCard>
  );
}

/**
 * The early-access toast stack: the shared `ToastStack` over this window's
 * toasts. Expiry and swipes hide a toast (it stays in notification history);
 * Dismiss removes it, as in the original list.
 */
function ToastStackHost({
  placement,
}: {
  placement: InAppNotificationPlacement;
}): JSX.Element {
  const toasts = useSyncExternalStore(
    toastStack.subscribe,
    toastStack.getSnapshot,
  );
  const dismissToast = useToastStore((state) => state.dismissToast);
  const expireToast = useToastStore((state) => state.expireToast);
  const [expandedToast, setExpandedToast] = useState<Toast | null>(null);
  // Here, not on the card: the form outlives a toast that is cleared, replaced
  // or dismissed while it is open.
  const [report, setReport] = useState<ToastFailureReport | null>(null);
  const openReport = (next: ToastFailureReport): void => {
    setExpandedToast(null);
    setReport(next);
  };

  return (
    <>
      <div
        data-testid="toast-stack-host"
        // The in-app browser is a native view that paints over the page
        // whatever the z-index; it steps aside for anything carrying this
        // attribute. Cards move by transform, which nothing reports, so this
        // still box around the resting stack speaks for them.
        data-canopy-browser-native-overlay={
          toasts.length > 0 ? 'true' : undefined
        }
      >
        <ToastStack
          data-testid="toast-live-region"
          placement={placement}
          toasts={toasts.map(stacked)}
          onClose={expireToast}
          // A two-finger trackpad swipe toward the stack's side hides a
          // toast, as dragging it away does.
          swipeInput={toastTrackpadSwipe}
          renderToast={(item): JSX.Element => (
            <div data-toast-id={item.toast.id} data-testid={item.toast.testId}>
              <StackToastCard
                toast={item.toast}
                onExpand={(): void => setExpandedToast(item.toast)}
                onDismiss={(): void => dismissToast(item.toast.id)}
                onReport={openReport}
              />
            </div>
          )}
        />
      </div>
      {expandedToast && (
        <ToastDetailModal
          toast={expandedToast}
          onClose={(): void => setExpandedToast(null)}
          onActionDone={(): void => {
            // A slow action can finish after its dialog closed and another
            // toast's opened: close only the dialog it was started from.
            const { id } = expandedToast;
            dismissToast(id);
            setExpandedToast((current) =>
              current?.id === id ? null : current,
            );
          }}
          onReport={openReport}
        />
      )}
      {report && (
        <ReportActionBoundary key={report.error.referenceId}>
          <DesktopReportEligibility>
            {(eligible): ReactNode =>
              eligible ? (
                <ReportThisDialog
                  error={report.error}
                  appName={brandText.appName}
                  {...(report.telemetry ? { telemetry: report.telemetry } : {})}
                  onClose={(): void => setReport(null)}
                />
              ) : null
            }
          </DesktopReportEligibility>
        </ReportActionBoundary>
      )}
    </>
  );
}

export interface ToastContainerProps {
  /** The corner the surrounding notification container is pinned to. */
  placement?: InAppNotificationPlacement;
}

/**
 * The window's shared notification stack.
 */
export function ToastContainer({
  placement = DEFAULT_IN_APP_NOTIFICATION_PLACEMENT,
}: ToastContainerProps): JSX.Element {
  return <ToastStackHost placement={placement} />;
}
