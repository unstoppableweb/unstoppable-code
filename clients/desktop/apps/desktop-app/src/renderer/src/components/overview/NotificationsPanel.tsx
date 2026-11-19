import { Surface } from '@canopy/ui-shared/components';
import { Badge, type BadgeTone } from '@canopy/ui-shared/components/Badge';
import type { JSX, KeyboardEvent, MouseEvent } from 'react';
import type { Notification } from '@/stores/toastStore';
import { useToastStore } from '@/stores/toastStore';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { EmptyState } from '@/components/shared/StatusBlocks';
import { formatRelativeTime } from '@/lib/format';
import { canNavigateToWorktreeFromSidebarItems } from '@/lib/worktreeNavigation';
import { Button, Tooltip } from '@canopy/ui-shared';
import { useContextScopedWorkspaces } from '@/hooks/useContextScopedWorkspaces';
import { openInWorkspaceContext } from '@/lib/contextScope';
import { toastCategoryLabel } from '@/lib/osNotifications';
import { toastMessageReplayClass } from '@/lib/replayPrivacy';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { CloseIcon as AppCatalogCloseIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useCoworkEntryLabel } from '@/components/shared/useCoworkEntryLabel';

function badgeTone(type: Notification['type']): BadgeTone {
  switch (type) {
    case 'error':
      return 'danger';
    case 'success':
      return 'success';
    case 'warning':
      return 'warning';
    default:
      return 'info';
  }
}

function badgeLabel(notification: Notification): string {
  const category = notification.meta?.category;
  return category === undefined
    ? typeLabel(notification.type)
    : toastCategoryLabel(category);
}

function typeLabel(type: Notification['type']): string {
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

export function NotificationsPanel({
  showAllContexts = false,
}: {
  showAllContexts?: boolean;
}): JSX.Element {
  const notifications = useToastStore((state) => state.notifications);
  const { isInContext } = useContextScopedWorkspaces();
  const dismissNotification = useToastStore(
    (state) => state.dismissNotification,
  );
  const visibleNotifications = notifications.filter(
    (notification) =>
      showAllContexts ||
      notification.meta?.projectId === undefined ||
      isInContext(notification.meta.projectId),
  );

  if (visibleNotifications.length === 0) {
    return (
      <EmptyState
        title="No notifications"
        subtitle="Recent messages you haven't dismissed yet will appear here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {visibleNotifications.map((notification) => (
        <NotificationCard
          key={notification.id}
          notification={notification}
          onDismiss={(): void => dismissNotification(notification.id)}
        />
      ))}
    </div>
  );
}

function NotificationCard({
  notification,
  onDismiss,
}: {
  notification: Notification;
  onDismiss: () => void;
}): JSX.Element {
  const meta = notification.meta;
  const projects = useProjectsStore((state) => state.projects);
  // A Cowork entry id is opaque; show the entry's name, as its toast did.
  const coworkEntryLabel = useCoworkEntryLabel(
    meta?.projectId,
    meta?.worktreeId,
    meta?.chatId,
  );
  const placeLabel =
    projects.find((entry) => entry.id === meta?.projectId)?.type === 'cowork'
      ? (coworkEntryLabel ?? meta?.worktreeId)
      : meta?.worktreeId;
  const hasHydratedProjects = useProjectsStore(
    (state) => state.hasHydratedProjects,
  );
  const projectId = meta?.projectId;
  const worktreeId = meta?.worktreeId;
  const hasWorktreeTarget = projectId !== undefined && worktreeId !== undefined;
  const canNavigateToWorktree =
    hasWorktreeTarget &&
    canNavigateToWorktreeFromSidebarItems(
      projects,
      projectId,
      worktreeId,
      hasHydratedProjects,
    );
  const clickable = hasWorktreeTarget
    ? canNavigateToWorktree
    : Boolean(notification.onClick);

  const activate = (): void => {
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

    const open = (): void => {
      if (notification.onClick) {
        notification.onClick();
      } else if (projectId !== undefined && worktreeId !== undefined) {
        useNavigationStore.getState().navigate('main');
        useChatStore.getState().selectWorktree(projectId, worktreeId);
      }
      onDismiss();
    };
    if (projectId !== undefined) {
      openInWorkspaceContext(projectId, open);
    } else {
      open();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!clickable || event.currentTarget !== event.target) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  };

  const handleDismissClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    onDismiss();
  };

  return (
    <Surface
      variant="card"
      size="small"
      interactive={clickable}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? activate : undefined}
      onKeyDown={clickable ? handleKeyDown : undefined}
      data-testid="overview-notification-card"
      data-project-id={projectId}
      data-worktree-id={worktreeId}
      focusRing
      className={clickable ? 'w-full cursor-pointer' : 'w-full'}
    >
      <div className="flex flex-col gap-1.5 px-3 py-2.5 text-left">
        <div className="flex items-center gap-2">
          <Badge tone={badgeTone(notification.type)}>
            {badgeLabel(notification)}
          </Badge>
          <div className="min-w-0 flex-1 text-2xs font-mono fg-secondary truncate">
            <span className={POSTHOG_REPLAY_MASK_CLASS}>
              {meta?.workspaceName ?? ''}
            </span>
            {meta?.workspaceName && meta?.worktreeId && (
              <span className="px-1 opacity-60">·</span>
            )}
            {placeLabel && (
              <span className={`${POSTHOG_REPLAY_MASK_CLASS} fg-primary/80`}>
                {placeLabel}
              </span>
            )}
          </div>
          <span className="shrink-0 text-3xs fg-secondary/80">
            {formatRelativeTime(new Date(notification.createdAt).toISOString())}
          </span>
          <Tooltip label="Dismiss notification">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              onClick={handleDismissClick}
              aria-label="Dismiss notification"
              data-testid="overview-notification-dismiss"
            >
              <AppCatalogCloseIcon size="sm" aria-hidden="true" />
            </Button>
          </Tooltip>
        </div>
        <div
          className={`text-xs fg-secondary line-clamp-3 whitespace-pre-line ${toastMessageReplayClass(notification.type, notification.meta?.category, notification.meta?.blockMessageFromReplay)}`}
        >
          {notification.message}
        </div>
      </div>
    </Surface>
  );
}
