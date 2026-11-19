'use client';

import { useState, type JSX, type ReactNode } from 'react';
import { Plus, UserPlus } from '@canopy/ui-shared/icons/AppIcons';
import { Button, buttonClassName, Notice } from '@canopy/ui-shared/components';
import { PageHeader } from '@canopy/ui-shared/components/PageHeader';
import { useOptionalSettingsStoreApi } from '@canopy/app-state/settings';
import {
  ORGANIZATION_SETTINGS_SUBTABS,
  type OrganizationDetail,
  type OrganizationSettingsSubtab,
} from '@canopy/protocol/settings';
import {
  canEditOrg,
  canManageMembers,
  canManageSubTeams,
  visibleOrganizationSettingsSubtabs,
} from '@canopy/protocol/settings/organization-permissions';
import {
  organizationSettingsSubtabItem,
  resolveOrganizationSettingsSubtab,
  teamNavItem,
  type TeamTab,
} from '../navigation/organization-nav-items';
import { SettingsPageColumn } from '../layout/SettingsPageColumn';
import { SettingsPageNotice } from '../layout/settings-page-notice';
import {
  SettingsLink,
  useSettingsHost,
  useSettingsNavigation,
  useSettingsRouter,
  useSettingsSearchParams,
  useSettingsWorkspaceContext,
} from '../host';
import {
  organizationTabColumnWidth,
  PersonalOverviewHeader,
} from './organization-header';
import { TeamFeedSection } from './team-feed-section';
import { TeamPageHeaderSlotContext } from './team-page-header-slot';
import { TeamMembersSection } from './team-members-section';
import {
  TeamProjectsHeaderActions,
  TeamProjectsSection,
  teamProjectsRepositoriesAvailable,
} from './team-projects-section';
import { TeamSubTeamsSection } from './team-subteams-section';
import { TeamSettingsSection } from './settings/team-settings-section';
import { useOrganizationSettingsSubtabSlots } from './settings/organization-settings-subtab-slots';
import { canManageOrganizationExternalAgents } from './settings/external-agents-policy';
import { TeamStatisticsSection } from './statistics/TeamStatisticsSection';
import { useOrganizationSettingsSlots } from './organization-settings-slots';
import { useMembershipChangeFollowUp } from './membership-change';
import { Surface } from '@canopy/ui-shared/components';

export interface TeamPageProps {
  initialDetail: OrganizationDetail;
  /** Session email used to identify the viewer's own member row. */
  viewerEmail: string;
  /**
   * Whether the `canopy-billing-enabled` flag is on for this viewer. The Billing
   * settings subtab only appears when this is true and the viewer can edit the
   * org.
   */
  billingEnabled: boolean;
  /** Whether organization memory is rolled out for this org. */
  memoryEnabled: boolean;
  projectsEnabled: boolean;
  /** Which tab this route renders; the feed is the primary view. */
  activeTab: TeamTab;
  /**
   * Server-derived from the request user agent. Mobile browsers cannot open
   * the desktop app, so the data-sharing hints give text guidance instead.
   */
  mobileBrowser: boolean;
  /** When set (permalink route), the feed anchors on and highlights this item. */
  highlightItemId?: string;
  /**
   * Server-rendered archive content for the `digests` tab. Only the digests
   * route passes it; the archive read is authorization-sensitive and stays on
   * the server rather than being re-implemented as a client fetch here.
   */
  digestContent?: ReactNode;
  /**
   * The `memory` tab's content: the Memory views and the selected view, built
   * by `OrganizationMemoryLayout` from the Memory page's own data.
   */
  memoryContent?: ReactNode;
  /**
   * Set when the viewer arrived here straight from redeeming an invite
   * (`/organization/<id>?joined=1`). Renders a one-line confirmation so the
   * join is stated outright rather than inferred from an org page the viewer
   * has never seen before.
   */
  justJoined?: boolean;
  /**
   * Members route only: open the invite dialog on arrival (`?invite=1`, from
   * the post-create redirect or the empty feed's "Invite people"), for viewers
   * who can invite.
   */
  inviteOnLoad?: boolean;
  /**
   * Settings route only: whether outside agents (the hosted MCP servers) are
   * on for this viewer. Lets an OWNER see the External agents card in
   * Settings → Policies. Other routes omit it.
   */
  externalAgentsEnabled?: boolean;
  /**
   * Settings route only: AI gateway setup is on for this viewer. Adds the AI
   * gateway page for owners and admins, and moves gateway configuration out
   * of Policies.
   */
  aiGatewayEnabled?: boolean;
}

/**
 * Client shell for the team routes. Holds the authoritative
 * {@link OrganizationDetail} (each settings section's mutations return a fresh
 * detail) and renders the page header naming the current destination, the
 * notices, and that destination's content. The settings rail names the
 * organization, switches between organizations and navigates between
 * destinations, including each Settings page (`?tab=`). Feed is the
 * primary view; members and teams are first-class pages so any member can view
 * them, while management actions stay role-gated inside the Members and Teams
 * sections.
 */

export function TeamPage({
  initialDetail,
  viewerEmail,
  billingEnabled,
  memoryEnabled,
  projectsEnabled,
  activeTab,
  mobileBrowser,
  highlightItemId,
  digestContent,
  memoryContent,
  justJoined = false,
  inviteOnLoad = false,
  externalAgentsEnabled = false,
  aiGatewayEnabled = false,
}: TeamPageProps): JSX.Element {
  const router = useSettingsRouter();
  const navigation = useSettingsNavigation();
  const searchParams = useSettingsSearchParams();
  const webOrigin = useSettingsHost().webOrigin();
  const { accountKey } = useSettingsWorkspaceContext();
  const { renderExternalAgentsPolicy } = useOrganizationSettingsSubtabSlots();
  const { PromotionDialog } = useOrganizationSettingsSlots();
  // Desktop's settings store keeps the latest detail per organization, so a
  // tab that is still loading draws this header with current values. Web has
  // no store and nothing to keep.
  const settingsStore = useOptionalSettingsStoreApi();
  const [detail, setDetailState] = useState<OrganizationDetail>(initialDetail);
  const [personalInviteId, setPersonalInviteId] = useState<string | null>(null);
  // Promotion keeps this organization id, so router refresh preserves the
  // shell. Adopt its committed team detail while retaining the open dialog.
  if (
    detail.id === initialDetail.id &&
    detail.isPersonal === true &&
    initialDetail.isPersonal !== true
  ) {
    setDetailState(initialDetail);
  }
  // The settings rail is published by the persistent organization layout from
  // server data, so it does not see this client-held detail. When a mutation
  // changes what the rail shows (the name, or the role that gates Statistics,
  // Memory, and the billing deep link), refresh the server tree so the rail
  // catches up. Authorization stays server-side throughout.
  const setDetail = (next: OrganizationDetail): void => {
    const railChanged =
      next.name !== detail.name ||
      next.logoUrl !== detail.logoUrl ||
      next.viewerRole !== detail.viewerRole ||
      next.canViewUsageStats !== detail.canViewUsageStats ||
      next.githubConnection.connected !== detail.githubConnection.connected;
    setDetailState(next);
    settingsStore?.getState().rememberOrganizationDetail(next.id, next);
    if (railChanged) router.refresh();
  };

  // A personal organization shows only its owner's Feed and Statistics: no
  // switcher, branding, member counts, or team-management tabs. Its invite
  // action promotes Personal through the shared Create a team flow.
  // The server refuses the other routes independently of this shell.
  const personal = detail.isPersonal === true;
  const canEdit = canEditOrg(detail.viewerRole);

  // Each Settings page is its own rail row (`?tab=`). The rail and this page
  // share one visibility rule; a stale or hidden `?tab=` shows the first
  // page the viewer gets.
  const settingsSubtabs = visibleOrganizationSettingsSubtabs({
    aiGatewayEnabled,
    viewerRole: detail.viewerRole,
    lapsed: false,
    billingEnabled,
    canViewUsageStats: detail.canViewUsageStats,
    githubConnected: detail.githubConnection.connected,
    externalAgentsPolicy:
      renderExternalAgentsPolicy !== undefined &&
      canManageOrganizationExternalAgents(detail, externalAgentsEnabled),
  });
  const settingsSubtab =
    activeTab === 'settings'
      ? resolveOrganizationSettingsSubtab(
          parseSettingsSubtab(searchParams.get('tab')),
          settingsSubtabs,
        )
      : null;
  const pageNavItem =
    settingsSubtab === null
      ? teamNavItem(activeTab)
      : organizationSettingsSubtabItem(settingsSubtab);

  // Leaving or deleting removes the membership, so the host's organization
  // switcher re-reads after landing on the index.
  const followMembershipChange = useMembershipChangeFollowUp();
  const afterMembershipRemoved = (): void =>
    followMembershipChange('/organization');
  const refreshPage = (): void => router.refresh();
  const onBillingChanged = refreshPage;

  // The Personal header's invite promotes Personal to a team. The host's
  // promotion controller owns that flow; a host without one continues on
  // this organization's web page, which offers the same invite.
  const openPersonalInvite = (): void => {
    if (PromotionDialog !== undefined) {
      setPersonalInviteId(detail.id);
      return;
    }
    navigation.openExternal(
      `${webOrigin}${teamNavItem('feed').href(detail.id)}`,
    );
  };

  // Each page's sole action sits in the page header, so its panel holds only
  // rows. The shell owns the open state; the sections render the dialog and
  // the inline form.
  const canInvite = canManageMembers(detail.viewerRole);
  const canCreateTeam = canManageSubTeams(detail.viewerRole);
  const [addingMember, setAddingMember] = useState(inviteOnLoad && canInvite);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectRepositoriesOpen, setProjectRepositoriesOpen] = useState(false);
  const [projectAddAvailable, setProjectAddAvailable] = useState(false);
  const projectRepositoriesAvailable = teamProjectsRepositoriesAvailable(
    detail,
    projectsEnabled,
  );

  // Sections whose page actions read their own state (the Timeline's Live
  // toggle, the Projects Refresh from GitHub) portal them into this slot,
  // first in the header's actions.
  const [headerSlot, setHeaderSlot] = useState<HTMLSpanElement | null>(null);
  const headerSlotElement = (
    <span
      ref={setHeaderSlot}
      className="contents"
      data-testid="team-page-header-slot"
    />
  );
  const headerActions = ((): ReactNode => {
    switch (activeTab) {
      case 'feed':
        return headerSlotElement;
      case 'members':
        if (!canInvite) return undefined;
        return (
          <Button
            size="compact"
            variant="secondary"
            onClick={() => setAddingMember(true)}
            data-testid="team-add-member"
          >
            <UserPlus size={14} />
            Add member
          </Button>
        );
      case 'groups':
        return canCreateTeam && !creatingTeam ? (
          <Button
            size="compact"
            variant="secondary"
            onClick={() => setCreatingTeam(true)}
            data-testid="team-create-subteam"
          >
            <Plus size={14} />
            New team
          </Button>
        ) : undefined;
      case 'projects':
        return projectRepositoriesAvailable || projectAddAvailable ? (
          <>
            {headerSlotElement}
            <TeamProjectsHeaderActions
              repositoriesAvailable={projectRepositoriesAvailable}
              addAvailable={projectAddAvailable}
              onAdd={() => setCreatingProject(true)}
              onRepositories={() => setProjectRepositoriesOpen(true)}
            />
          </>
        ) : undefined;
      case 'digests':
        // Forward link to the cadence settings. The left nav is what moves
        // around the org, so this never reads as a back link.
        return canEdit ? (
          <SettingsLink
            href={`/organization/${detail.id}/settings`}
            className={buttonClassName({
              variant: 'secondary',
              size: 'compact',
            })}
            data-testid="org-digest-settings-link"
          >
            Digest settings
          </SettingsLink>
        ) : undefined;
      default:
        return undefined;
    }
  })();

  const tabContent = ((): ReactNode => {
    switch (activeTab) {
      case 'feed':
        return (
          <TeamFeedSection
            key={`${detail.id}:${highlightItemId ?? ''}`}
            orgId={detail.id}
            organizationName={detail.name}
            viewerIdentity={viewerEmail}
            mobileBrowser={mobileBrowser}
            canManageMembers={canManageMembers(detail.viewerRole)}
            members={detail.members}
            highlightItemId={highlightItemId}
            personal={personal}
          />
        );
      case 'digests':
        return digestContent ?? null;
      case 'statistics':
        return detail.canViewUsageStats ? (
          <TeamStatisticsSection
            orgId={detail.id}
            organizationName={detail.name}
            viewerIdentity={viewerEmail}
            mobileBrowser={mobileBrowser}
            subTeams={detail.subTeams}
            members={detail.members}
            personal={personal}
          />
        ) : (
          <Surface variant="dashed">
            <p
              className="px-4 py-12 text-center text-s fg-secondary"
              data-testid="team-statistics-forbidden"
            >
              You don&apos;t have permission to view usage statistics for this
              organization.
            </p>
          </Surface>
        );
      case 'members':
        return (
          <TeamMembersSection
            detail={detail}
            viewerEmail={viewerEmail}
            onDetailChange={setDetail}
            onLeft={afterMembershipRemoved}
            adding={addingMember && canInvite}
            onAddingChange={setAddingMember}
          />
        );
      case 'groups':
        return (
          <TeamSubTeamsSection
            detail={detail}
            onDetailChange={setDetail}
            creating={creatingTeam}
            onCreatingChange={setCreatingTeam}
          />
        );
      case 'projects':
        return (
          <TeamProjectsSection
            detail={detail}
            onDetailChange={setDetail}
            projectsEnabled={projectsEnabled}
            creating={creatingProject}
            onCreatingChange={setCreatingProject}
            repositoriesOpen={projectRepositoriesOpen}
            onRepositoriesOpenChange={setProjectRepositoriesOpen}
            onAddAvailableChange={setProjectAddAvailable}
          />
        );
      case 'memory':
        return memoryContent ?? null;
      case 'settings':
        return settingsSubtab === null ? null : (
          <TeamSettingsSection
            subtab={settingsSubtab}
            detail={detail}
            onDetailChange={setDetail}
            onBillingChanged={onBillingChanged}
            memoryEnabled={memoryEnabled}
            onDeleted={afterMembershipRemoved}
            externalAgentsEnabled={externalAgentsEnabled}
            aiGatewayEnabled={aiGatewayEnabled}
            projectsEnabled={projectsEnabled}
          />
        );
    }
    const exhaustive: never = activeTab;
    return exhaustive;
  })();

  return (
    <SettingsPageColumn
      className="relative"
      width={organizationTabColumnWidth(activeTab)}
    >
      {personal ? (
        <PersonalOverviewHeader onInvite={openPersonalInvite} />
      ) : null}

      {personalInviteId && accountKey !== null && PromotionDialog && (
        <PromotionDialog
          accountKey={accountKey}
          personalOrganizationId={personalInviteId}
          inviteRequired
          onClose={() => setPersonalInviteId(null)}
        />
      )}

      <PageHeader
        inset="none"
        headingLevel={personal ? 'h2' : 'h1'}
        reserveActions
        title={pageNavItem.label}
        description={pageNavItem.description}
        actions={headerActions}
      />

      <SettingsPageNotice />

      {justJoined && (
        <Notice intent="positive" data-testid="team-joined-notice">
          {`You've joined ${detail.name}.`}
        </Notice>
      )}

      <TeamPageHeaderSlotContext.Provider value={headerSlot}>
        {tabContent}
      </TeamPageHeaderSlotContext.Provider>
    </SettingsPageColumn>
  );
}

function parseSettingsSubtab(
  value: string | null,
): OrganizationSettingsSubtab | null {
  return (
    ORGANIZATION_SETTINGS_SUBTABS.find((subtab) => subtab === value) ?? null
  );
}
