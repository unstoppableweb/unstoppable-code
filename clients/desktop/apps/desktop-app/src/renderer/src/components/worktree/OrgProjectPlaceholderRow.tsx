import { Surface } from '@canopy/ui-shared/components';
import {
  OrgProjectRelationshipNotice,
  type OrgProjectRelationshipActions,
} from './OrgProjectRelationshipNotice';
import { useRef, type JSX, type ReactNode } from 'react';
import { SidebarList } from '@canopy/ui-app';
import { LoadingSpinner } from '../shared/loading';
import { Button, Tooltip } from '@canopy/ui-shared/components';
import { FolderIcon } from '@canopy/ui-shared/icons/AppIcons';
import type {
  OrgProjectPlaceholderState,
  OrgProjectSummary,
  OrgProjectSetupProgress,
} from '@canopy/protocol/org-projects';
import { ORG_PROJECT_STATE_TEXT } from './orgProjectStateText';
import { useGitHubStore } from '@/stores/githubStore';

/**
 * A bound project whose setup never finished. Its files are on disk, so
 * "Ready to set up" would be wrong twice over: the work is partly done, and
 * the action that sentence points at is deliberately not offered.
 */
const UNFINISHED_TEXT = 'Setup did not finish';

interface OrgProjectPlaceholderRowProps {
  relationship?: OrgProjectRelationshipActions;
  project: OrgProjectSummary;
  state: OrgProjectPlaceholderState;
  progress?: OrgProjectSetupProgress;
  /** The project is already a workspace whose setup never finished. */
  unfinished?: boolean;
  onSetup: (
    projectId: string,
    restoreFocusTarget?: HTMLElement | null,
  ) => Promise<void>;
  onCancel: (projectId: string) => Promise<void>;
}

/** Catalog metadata only: no worktree selection, loaders, or workspace actions. */
export function OrgProjectPlaceholderRow({
  project,
  relationship,
  state,
  progress,
  unfinished,
  onSetup,
  onCancel,
}: OrgProjectPlaceholderRowProps): JSX.Element {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const running =
    progress?.state === 'claiming' || progress?.state === 'materializing';
  const failed = progress?.state === 'failed';
  // A lapsed claim (CAN-3129) is the one failure after binding that Retry can
  // finish: it reclaims the claim and completes, without cloning again.
  const reclaimable = failed && progress?.errorCode === 'claim-expired';
  // An offline completion also lands after the checkout is bound. The next
  // launch finishes it (CAN-3130), so the row offers no action of its own.
  const retryable =
    failed && !reclaimable && progress?.errorCode !== 'completion-pending';
  // After a restart there is no progress event to read a reason from, but the
  // workspace on disk says the same thing: setup is refused for a project that
  // is already a workspace, so neither Set up nor Retry can do anything here.
  // Dismissal withdraws the offer, and Retry is an offer. Re-list the project
  // from the Add project catalog and retry there; retained rows report setup.
  const actionable =
    project.listed && (reclaimable || (!unfinished && (!failed || retryable)));
  const statusText = unfinished
    ? UNFINISHED_TEXT
    : ORG_PROJECT_STATE_TEXT[state];
  // `choose-folder` opens the same setup dialog, which asks for the folder.
  const available =
    state === 'ready-to-set-up' ||
    state === 'choose-folder' ||
    state === 'needs-github-access';
  const actOnSetup = (action: (projectId: string) => Promise<void>): void => {
    void action(project.id).catch((error: unknown): void => {
      useGitHubStore
        .getState()
        .addToast(
          error instanceof Error ? error.message : 'Project setup failed',
          'error',
          undefined,
          { caught: error },
        );
    });
  };
  return (
    <div
      ref={rowRef}
      tabIndex={-1}
      className="flex flex-wrap items-center gap-2 px-3 py-2"
      data-testid={`sidebar-org-project-placeholder-${project.id}`}
    >
      <Tooltip label={statusText}>
        {/*
          The dash is the point — it reads as "not on this machine yet" — and
          `ring-*` cannot be dashed, so this one stays a border. No
          `border-<color>` utility though: those are inert (CAN-2734), and the
          unlayered base style already paints `--line-base` here.
        */}
        <Surface
          as="span"
          variant="dashed"
          size="small"
          role="img"
          aria-label={statusText}
          className="flex shrink-0 items-center justify-center"
        >
          <span className="p-1 fg-quaternary">
            <FolderIcon size="sm" aria-hidden="true" />
          </span>
        </Surface>
      </Tooltip>
      <div className="min-w-0 flex-1">
        <div className="truncate text-s fg-primary" title={project.name}>
          {project.name}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs fg-secondary">
          <span role="status">
            {progress?.message ?? statusText}
            {running && progress?.percent != null
              ? ` ${progress.percent}%`
              : ''}
          </span>
          {!running && actionable && (
            <Button
              variant="link"
              disabled={!available}
              aria-label={`${failed ? 'Try again for' : 'Set up'} ${project.name}`}
              data-testid={`sidebar-org-project-${failed ? 'retry' : 'setup'}-${project.id}`}
              className="shrink-0"
              onClick={(): void =>
                actOnSetup(
                  (projectId): Promise<void> =>
                    onSetup(projectId, rowRef.current),
                )
              }
            >
              {failed ? 'Try again' : 'Set up'}
            </Button>
          )}
        </div>
      </div>
      {running && (
        <div className="flex items-center gap-2">
          <LoadingSpinner tone="accent" />
          <Button
            size="sm"
            variant="secondary"
            data-testid={`sidebar-org-project-cancel-${project.id}`}
            onClick={(): void => actOnSetup(onCancel)}
          >
            Cancel
          </Button>
        </div>
      )}
      {relationship && actionable && running === false && (
        <div className="w-full min-w-0">
          <OrgProjectRelationshipNotice
            actions={relationship}
            onSetupSeparately={(): void =>
              actOnSetup(
                (projectId): Promise<void> =>
                  onSetup(projectId, rowRef.current),
              )
            }
          />
        </div>
      )}
    </div>
  );
}

interface OrgProjectPlaceholderSectionProps {
  children: ReactNode;
}

/** Shared grouping for the native and shared desktop sidebar hosts. */
export function OrgProjectPlaceholderSection({
  children,
}: OrgProjectPlaceholderSectionProps): JSX.Element {
  return (
    <div data-testid="sidebar-section-shared-projects">
      <div className="flex h-8 items-center gap-1 px-2 text-s font-normal">
        <span className="shrink-0 whitespace-nowrap fg-quaternary">
          Shared projects
        </span>
      </div>
      <SidebarList>{children}</SidebarList>
    </div>
  );
}
