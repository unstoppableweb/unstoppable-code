import { useState, type JSX } from 'react';
import { Button, LoadingSpinner } from '@canopy/ui-shared/components';
import { FolderIcon } from '@canopy/ui-shared/icons/AppIcons';
import { Surface } from '@canopy/ui-shared/components';

/**
 * A project the host is still adding: a clone that has not produced a
 * workspace row yet. The host owns the lifecycle and every policy decision
 * (which actions are allowed, when the row goes away); this is presentation.
 */
export interface SidebarPendingProject {
  readonly id: string;
  readonly name: string;
  readonly status: 'cloning' | 'cancelling' | 'failed';
  /** Replaces the default status line while the row is not failed. */
  readonly statusText?: string;
  /** Failure detail, or the reason an unresolved row stopped. */
  readonly message?: string;
  /**
   * False when the host can no longer tell whether work is still happening,
   * so the row must not show motion. Defaults to true for non-failed rows.
   */
  readonly active?: boolean;
  /** True while a Retry is being submitted; disables the control. */
  readonly retrying?: boolean;
  readonly onRetry?: () => void;
  /**
   * Stops a running clone. Offered on a `cloning` row only; after a click the
   * row shows "Cancelling…" with the control disabled until the host's next
   * snapshot moves or removes it. A rejection is reported in the row, which
   * offers Cancel again.
   */
  readonly onCancel?: () => Promise<void>;
  readonly onDismiss?: () => void;
}

function defaultStatusText(project: SidebarPendingProject): string {
  if (project.status === 'failed') return `Couldn't clone ${project.name}`;
  if (project.status === 'cancelling') return 'Cancelling…';
  return 'Cloning…';
}

export function PendingProjectRow({
  project,
}: {
  readonly project: SidebarPendingProject;
}): JSX.Element {
  const [cancelSent, setCancelSent] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);
  const failed = project.status === 'failed';
  const cloning = project.status === 'cloning';
  const onCancel = cloning ? project.onCancel : undefined;
  // From the click until the host answers, the row reads as cancelling. A
  // job that stopped being cancellable first (the host ignored the Cancel)
  // drops `onCancel`, and the row reads as cloning again.
  const cancelPending = cancelSent && onCancel !== undefined;
  // The name is the row's title, so a failure with a reason shows the reason
  // alone instead of naming the project a second time.
  const statusLine = failed
    ? (project.message ?? defaultStatusText(project))
    : [
        cancelPending
          ? 'Cancelling…'
          : (project.statusText ?? defaultStatusText(project)),
        project.message,
        cloning && !cancelPending && cancelFailed ? "Couldn't cancel." : null,
      ]
        .filter(Boolean)
        .join(' ');
  const hasActions =
    (failed && project.onRetry !== undefined) ||
    onCancel !== undefined ||
    project.onDismiss !== undefined;
  const cancel = (): void => {
    if (onCancel === undefined || cancelSent) return;
    setCancelSent(true);
    setCancelFailed(false);
    // The host's next snapshot moves the row to cancelling or removes it, so
    // the pending state is held after success. The Cancel was clicked here,
    // so its failure is reported here, and the row offers Cancel again.
    void onCancel().catch((): void => {
      setCancelSent(false);
      setCancelFailed(true);
    });
  };
  const showsSpinner = !failed && project.active !== false;
  return (
    <div
      className="flex items-start gap-2 py-1.5 pl-2 pr-3"
      data-pending-project-row=""
      data-status={project.status}
      data-testid={`sidebar-pending-project-${project.id}`}
    >
      {/* Dashed like the organization project placeholder: "not here yet". */}
      <Surface
        as="span"
        variant="dashed"
        size="small"
        className="mt-0.5 shrink-0"
      >
        <span
          aria-hidden="true"
          className="flex size-4 items-center justify-center fg-quaternary"
        >
          <FolderIcon size="sm" aria-hidden="true" />
        </span>
      </Surface>
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <div>
          <div className="truncate text-s fg-primary" title={project.name}>
            {project.name}
          </div>
          <div
            role="status"
            className="break-words text-xs fg-secondary"
            data-testid={`sidebar-pending-project-status-${project.id}`}
          >
            {statusLine}
          </div>
        </div>
        {hasActions && (
          // The link actions take the size of the copy around them.
          <div className="flex items-center gap-3 text-xs">
            {failed && project.onRetry && (
              <Button
                variant="link"
                disabled={project.retrying === true}
                aria-label={`Try again for ${project.name}`}
                data-testid={`sidebar-pending-project-retry-${project.id}`}
                className="shrink-0"
                onClick={project.onRetry}
              >
                Try again
              </Button>
            )}
            {onCancel && (
              <Button
                variant="link"
                disabled={cancelPending}
                aria-label={`Cancel cloning ${project.name}`}
                data-testid={`sidebar-pending-project-cancel-${project.id}`}
                className="shrink-0"
                onClick={cancel}
              >
                Cancel
              </Button>
            )}
            {project.onDismiss && (
              <Button
                variant="link"
                aria-label={`Dismiss ${project.name}`}
                data-testid={`sidebar-pending-project-dismiss-${project.id}`}
                className="shrink-0"
                onClick={project.onDismiss}
              >
                Dismiss
              </Button>
            )}
          </div>
        )}
      </div>
      {showsSpinner && (
        <span
          className="mt-0.5 flex shrink-0 items-center"
          data-testid={`sidebar-pending-project-spinner-${project.id}`}
        >
          <LoadingSpinner tone="accent" />
        </span>
      )}
    </div>
  );
}

export function PendingProjectRows({
  projects,
}: {
  readonly projects: readonly SidebarPendingProject[];
}): JSX.Element | null {
  if (projects.length === 0) return null;
  return (
    <>
      {projects.map((project) => (
        <PendingProjectRow key={project.id} project={project} />
      ))}
    </>
  );
}
