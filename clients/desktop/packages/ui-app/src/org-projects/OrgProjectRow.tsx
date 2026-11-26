'use client';

// ---------------------------------------------------------------------------
// One organization project row, shared by the Add project dialog's catalog
// and the organization Projects settings page so both lists read the same.
// The row is frameless: the list around it owns borders and dividers.
// ---------------------------------------------------------------------------

import { ControlButton, ProjectCatalogRow } from '@canopy/ui-shared/components';
import { type JSX, type ReactNode, type SyntheticEvent } from 'react';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { StatusPill } from '@canopy/ui-shared';
import { formatRelativeTime } from '@canopy/ui-shared/lib';
import { CHAT_LABEL } from '@canopy/protocol';
import { hasCompleteOrgProjectRepositories } from '@canopy/protocol/org-projects';
import type {
  OrgProjectRepositoryVisibility,
  OrgProjectSummary,
} from '@canopy/protocol/org-projects';
import { Badge } from '@canopy/ui-shared/primitives/Badge';

const VISIBILITY_LABEL: Record<OrgProjectRepositoryVisibility, string> = {
  PUBLIC: 'Public',
  PRIVATE: 'Private',
  INTERNAL: 'Internal',
};

/** The row's name: the GitHub repository, like GitHub's own list (CAN-3489). */
/**
 * The list grid for rows with `columns`: text, the middle column (from `sm`
 * up), and the actions. Each column is as wide as its widest cell, so the
 * access summaries and actions line up from row to row.
 */
export const ORG_PROJECT_ROW_COLUMNS_CLASS =
  'grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 sm:grid-cols-[minmax(0,1fr)_auto_auto]';

function orgProjectRowName(project: OrgProjectSummary): string {
  return project.topology === 'multi-repo'
    ? project.name
    : (project.repository?.name ?? project.name);
}

export interface OrgProjectRowProps {
  readonly project: OrgProjectSummary;
  /** Test-id prefix: `add-workspace-org-catalog` or `team-projects`. */
  readonly testIdPrefix: string;
  /** The row's title; the repository name by default (CAN-3489). */
  readonly name?: string;
  /**
   * The host's session-replay block token for the name and description; ''
   * when the host has none. A privacy marker, not styling.
   */
  readonly replayBlock?: string;
  /** The line under the name; the repository's GitHub description by default. */
  readonly description?: string | null;
  /** Extra pills after the visibility pills (Archived, Hidden, Stale). */
  readonly pills?: ReactNode;
  /** Drops the "Only you" pill when the list's heading already says it. */
  readonly hidePrivatePill?: boolean;
  /** Leading status text of the "status · Updated …" line, or null. */
  readonly status?: string | null;
  /** Optional column between the text and the actions (the access summary). */
  readonly middle?: ReactNode;
  /** Right-side controls (Add / Added, or Set up / Open and the ⋯ menu). */
  readonly actions?: ReactNode;
  /** Makes the row activatable (the settings page opens the editor). */
  readonly onActivate?: (() => void) | undefined;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  /**
   * Lays the row on its list's grid (`ORG_PROJECT_ROW_COLUMNS_CLASS`) instead
   * of sizing each row's columns to its own content.
   */
  readonly columns?: boolean;
}

function projectDescription(project: OrgProjectSummary): string | null {
  if (project.topology !== 'multi-repo')
    return project.repository?.description ?? null;
  if (
    !hasCompleteOrgProjectRepositories(project) ||
    !project.repositories?.length
  )
    return 'Full repository list unavailable';
  return `${project.repositories.length} ${project.repositories.length === 1 ? 'repository' : 'repositories'} · ${project.repositories.map((repository) => `${repository.owner}/${repository.name}`).join(', ')}`;
}

function joinClasses(...classes: string[]): string {
  return classes.filter(Boolean).join(' ');
}

function stop(event: SyntheticEvent): void {
  event.stopPropagation();
}

export function OrgProjectRow({
  project,
  testIdPrefix,
  name = orgProjectRowName(project),
  replayBlock = '',
  description = projectDescription(project),
  pills,
  hidePrivatePill = false,
  status = null,
  middle,
  actions,
  onActivate,
  disabled = false,
  busy,
  columns = false,
}: OrgProjectRowProps): JSX.Element {
  const multiRepo = project.topology === 'multi-repo';
  const visibility = multiRepo
    ? null
    : (project.repository?.visibility ?? null);
  const updatedAt = project.repository?.updatedAt ?? null;
  const activatable = onActivate !== undefined;
  const hasMiddle = middle !== undefined && middle !== null;
  const hasActions = actions !== undefined && actions !== null;
  const activate = (): void => {
    if (!disabled && !busy) onActivate?.();
  };
  const nameLabel = (
    <span
      data-testid={`${testIdPrefix}-name-${project.id}`}
      className={joinClasses(
        'truncate text-s fg-primary',
        replayBlock,
        multiRepo ? REPLAY_MASK_CLASS : '',
      )}
    >
      {name}
    </span>
  );
  return (
    <ProjectCatalogRow
      columns={Boolean(columns)}
      activatable={activatable}
      data-testid={`${testIdPrefix}-row-${project.id}`}
      aria-busy={busy}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {activatable ? (
            <ControlButton
              presentation="project-catalog-row-press"
              aria-disabled={disabled || busy || undefined}
              onClick={activate}
            >
              {nameLabel}
            </ControlButton>
          ) : (
            nameLabel
          )}
          {visibility && (
            <StatusPill
              data-testid={`${testIdPrefix}-visibility-${project.id}`}
            >
              {VISIBILITY_LABEL[visibility]}
            </StatusPill>
          )}
          {project.visibility === 'private' && !hidePrivatePill && (
            <Badge
              className="shrink-0"
              data-testid={`${testIdPrefix}-private-${project.id}`}
            >
              Only you
            </Badge>
          )}
          {pills}
        </div>
        {project.kind === 'COWORK' && (
          <div className="truncate text-xs fg-secondary">{CHAT_LABEL}</div>
        )}
        {description && (
          <div
            data-testid={`${testIdPrefix}-description-${project.id}`}
            className={joinClasses(
              'line-clamp-2 text-xs fg-secondary',
              replayBlock,
              multiRepo ? REPLAY_MASK_CLASS : '',
            )}
          >
            {description}
          </div>
        )}
        {(status !== null || updatedAt) && (
          <div className="truncate text-xs fg-tertiary">
            {status !== null && <span className="fg-secondary">{status}</span>}
            {status !== null && updatedAt && ' · '}
            {updatedAt && (
              <span data-testid={`${testIdPrefix}-updated-${project.id}`}>
                Updated {formatRelativeTime(updatedAt)}
              </span>
            )}
          </div>
        )}
      </div>
      {/* On the list grid, every row keeps its cells so columns hold. */}
      {(hasMiddle || columns) && (
        <div className="hidden shrink-0 text-xs fg-secondary sm:block">
          {middle}
        </div>
      )}
      {(hasActions || columns) && (
        // Controls never activate the row around them.
        <div
          className="relative z-10 flex shrink-0 items-center justify-end gap-2"
          onClick={stop}
          onKeyDown={stop}
        >
          {actions}
        </div>
      )}
    </ProjectCatalogRow>
  );
}
