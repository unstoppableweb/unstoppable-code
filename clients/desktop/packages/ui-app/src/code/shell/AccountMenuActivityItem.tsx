'use client';

import type { JSX } from 'react';
import type {
  WorkspaceContext,
  WorkspaceContextOrganization,
} from '@canopy/protocol/workspace-context';
import { MenuItem, MenuItemIcon } from '@canopy/ui-shared/components';
import {
  BarChart3,
  FeedIcon,
  Plus,
  UserPlus,
} from '@canopy/ui-shared/icons/AppIcons';

/** The hosted organization index. */
const ORGANIZATIONS_PATH = '/organization';

/** A team's settings page on the web, where its members are managed. */
export function organizationSettingsPath(organizationId: string): string {
  return `${ORGANIZATIONS_PATH}/${encodeURIComponent(organizationId)}/settings`;
}

/**
 * The organization index with its create dialog open on arrival (CAN-4554).
 * The page reads exactly one `create=1` and clears it once the dialog closes.
 */
export function organizationCreatePath(): string {
  return `${ORGANIZATIONS_PATH}?create=1`;
}

/**
 * The selected organization when the viewer may invite people into it (its
 * owners and admins), otherwise `null`. Both hosts' context switchers use
 * this so the Invite your team row means the same thing everywhere.
 */
export function invitableOrganization(
  context: WorkspaceContext,
  organizations: readonly WorkspaceContextOrganization[],
): WorkspaceContextOrganization | null {
  if (context.kind !== 'organization') return null;
  const organization = organizations.find(
    (entry) => entry.id === context.organizationId,
  );
  return organization?.role === 'OWNER' || organization?.role === 'ADMIN'
    ? organization
    : null;
}

/**
 * The Timeline row of the context switcher's organization actions: opens the
 * selected context's Timeline at `path`.
 */
export function SidebarFeedMenuItem({
  path,
  onOpenPath,
}: {
  readonly path: string;
  readonly onOpenPath: (path: string) => void;
}): JSX.Element {
  return (
    <MenuItem
      onClick={(): void => onOpenPath(path)}
      // Historical name: it also marks the organization destination, and is
      // kept so existing flow and capture specs keep their selector.
      data-testid="account-personal-activity-row"
    >
      <MenuItemIcon>
        <FeedIcon />
      </MenuItemIcon>
      Timeline
    </MenuItem>
  );
}

/**
 * The Statistics row of the context switcher's organization actions: opens
 * the selected context's Statistics at `path`.
 */
export function SidebarStatisticsMenuItem({
  path,
  onOpenPath,
}: {
  readonly path: string;
  readonly onOpenPath: (path: string) => void;
}): JSX.Element {
  return (
    <MenuItem
      onClick={(): void => onOpenPath(path)}
      data-testid="account-context-statistics-row"
    >
      <MenuItemIcon>
        <BarChart3 size="xl" />
      </MenuItemIcon>
      Statistics
    </MenuItem>
  );
}

/**
 * The Invite your team row. One label in both scopes: Personal becomes a team
 * first (`create-team`), an organization only takes invitations (`invite`).
 */
export function SidebarInviteTeamMenuItem({
  kind,
  onClick,
}: {
  readonly kind: 'create-team' | 'invite';
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <MenuItem
      onClick={onClick}
      data-testid={
        kind === 'create-team'
          ? 'account-create-team-row'
          : 'account-invite-team-row'
      }
    >
      <MenuItemIcon>
        <UserPlus size="xl" />
      </MenuItemIcon>
      Invite your team
    </MenuItem>
  );
}

/**
 * The Create an organization row, last in the context switcher (CAN-4554).
 * An action, not a context option: it opens the create dialog and never
 * changes the selected context itself.
 */
export function SidebarCreateOrganizationMenuItem({
  onClick,
}: {
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <MenuItem
      onClick={onClick}
      data-testid="sidebar-context-create-organization"
    >
      <MenuItemIcon>
        <Plus size="xl" />
      </MenuItemIcon>
      Create an organization
    </MenuItem>
  );
}
