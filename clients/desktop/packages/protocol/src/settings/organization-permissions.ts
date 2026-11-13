import type { OrganizationRole } from './organization';
import type { OrganizationSettingsSubtab } from './routes';

/**
 * Typed error for the team service layer. Mirrors `InviteServiceError`:
 * routes catch it and map `status`/`message` onto an HTTP response.
 *
 * Defined here (not in `team-service.ts`) so the pure permission helpers below
 * can throw it without creating a circular import back into the service.
 */
export class TeamServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'TeamServiceError';
  }
}

/**
 * Privilege ordering: higher rank = more authority. Used for "can this actor
 * act on that target" comparisons throughout the service.
 */
export function roleRank(role: OrganizationRole): number {
  switch (role) {
    case 'OWNER':
      return 3;
    case 'ADMIN':
      return 2;
    case 'MEMBER':
      return 1;
  }
}

/** Edit org name. OWNER + ADMIN. */
export function canEditOrg(role: OrganizationRole): boolean {
  return roleRank(role) >= roleRank('ADMIN');
}

/** Create / rename / delete sub-teams and manage their membership. OWNER + ADMIN. */
export function canManageSubTeams(role: OrganizationRole): boolean {
  return roleRank(role) >= roleRank('ADMIN');
}

/** Manage organization project definitions and access. OWNER + ADMIN. */
export function canManageProjects(role: OrganizationRole): boolean {
  return roleRank(role) >= roleRank('ADMIN');
}

/** Invite members / add existing by email. OWNER + ADMIN. */
export function canManageMembers(role: OrganizationRole): boolean {
  return roleRank(role) >= roleRank('ADMIN');
}

/**
 * View the team usage & cost dashboard. The threshold is org-configurable
 * (`OrganizationConfig.usageStatsMinRole`, default `ADMIN`); a viewer qualifies
 * when their rank meets or exceeds the configured minimum.
 */
export function canViewUsageStats(
  viewerRole: OrganizationRole,
  minRole: OrganizationRole,
): boolean {
  return roleRank(viewerRole) >= roleRank(minRole);
}

/** Edit the org usage-stats configuration. OWNER + ADMIN (same as org edit). */
export function canEditUsageStatsConfig(role: OrganizationRole): boolean {
  return canEditOrg(role);
}

/** Edit org-enforced member settings (e.g. required telemetry sync). OWNER + ADMIN. */
export function canEditOrgEnforcedSettings(role: OrganizationRole): boolean {
  return canEditOrg(role);
}

/** Edit per-member organization-memory participation. OWNER + ADMIN. */
export function canEditMemorySettings(role: OrganizationRole): boolean {
  return canEditOrg(role);
}

/**
 * Role transitions: Owners may assign any role; Admins may change non-owners
 * between Member and Admin. Identity and last-owner checks belong at the
 * authoritative mutation boundary, separately from this role matrix.
 */
export function canAssignRole(
  actorRole: OrganizationRole,
  currentRole: OrganizationRole,
  newRole: OrganizationRole,
): boolean {
  return (
    actorRole === 'OWNER' ||
    (actorRole === 'ADMIN' && currentRole !== 'OWNER' && newRole !== 'OWNER')
  );
}

/**
 * Remove a member. The actor must be able to manage members and outrank the
 * target. This yields: ADMIN can remove MEMBER only; OWNER can remove ADMIN and
 * MEMBER; nobody can remove an OWNER via this path (demote/transfer first).
 */
export function canRemoveMember(
  actorRole: OrganizationRole,
  targetRole: OrganizationRole,
): boolean {
  return (
    canManageMembers(actorRole) && roleRank(actorRole) > roleRank(targetRole)
  );
}

/**
 * Guard the invariant that an org always retains at least one OWNER. Throws
 * `TeamServiceError(409)` when the operation would remove, demote, or let leave
 * the final remaining owner.
 */
export function assertNotLastOwner(params: {
  targetIsOwner: boolean;
  ownerCount: number;
}): void {
  if (params.targetIsOwner && params.ownerCount <= 1) {
    throw new TeamServiceError(
      409,
      'An organization must always have at least one owner',
    );
  }
}

/** What decides which organization Settings pages a viewer gets. */
export interface OrganizationSettingsSubtabAccess {
  readonly aiGatewayEnabled?: boolean;
  readonly viewerRole: OrganizationRole;
  /** The organization lost its `teams` capability (CAN-2311). */
  readonly lapsed: boolean;
  /** The billing flag is on for this viewer. */
  readonly billingEnabled: boolean;
  /** The viewer meets the organization's statistics role threshold. */
  readonly canViewUsageStats: boolean;
  /**
   * The GitHub App is connected, or `null` when the caller does not know.
   * While the organization is lapsed, Integrations stays only to disconnect:
   * it shows when connected or unknown, so a connection is never stranded.
   */
  readonly githubConnected: boolean | null;
  /**
   * The viewer manages members' outside agents here (the host supplies the
   * card, the viewer is an OWNER, the organization is not Personal).
   */
  readonly externalAgentsPolicy: boolean;
}

/**
 * The organization Settings pages (General, Policies, Integrations, Usage,
 * AI gateway, Billing) the viewer can open, in rail order. Each page shows only when at
 * least one of its sections renders for this viewer, so neither the settings
 * rail nor the page offers an empty page. The page and the rail share this
 * one rule; the server stays the enforcement boundary.
 *
 * - Billing is reachable while lapsed: it is the one page that undoes a lapse.
 * - Integrations stays while lapsed only to disconnect an existing connection,
 *   since connecting is refused.
 * - Policies stays while lapsed only for the outside-agents card.
 */
export function visibleOrganizationSettingsSubtabs(
  access: OrganizationSettingsSubtabAccess,
): OrganizationSettingsSubtab[] {
  const canEdit = canEditOrg(access.viewerRole);
  const healthy = !access.lapsed;
  const visible: OrganizationSettingsSubtab[] = [];
  if (canEdit) visible.push('general');
  if (
    (healthy && canEditOrgEnforcedSettings(access.viewerRole)) ||
    access.externalAgentsPolicy
  )
    visible.push('policies');
  if (canEdit && (healthy || access.githubConnected !== false))
    visible.push('integrations');
  if (
    (healthy && canEditUsageStatsConfig(access.viewerRole)) ||
    access.canViewUsageStats
  )
    visible.push('usage');
  if (healthy && canAccessAiGatewaySettings(access)) visible.push('ai-gateway');
  if (access.billingEnabled && canEdit) visible.push('billing');
  return visible;
}

/** Owners and admins manage the AI gateway page while setup is on. */
export function canAccessAiGatewaySettings(
  access: Pick<
    OrganizationSettingsSubtabAccess,
    'aiGatewayEnabled' | 'viewerRole'
  >,
): boolean {
  return access.aiGatewayEnabled === true && canEditOrg(access.viewerRole);
}
