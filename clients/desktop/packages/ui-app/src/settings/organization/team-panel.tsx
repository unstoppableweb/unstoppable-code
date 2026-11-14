'use client';

import { useCallback, useEffect, useState, type JSX } from 'react';
import { Check, Mail, Plus, Users, X } from '@canopy/ui-shared/icons/AppIcons';
import {
  Stack,
  Badge,
  Button,
  DelayedLoadingPlaceholder,
  EmptyState,
  ErrorBanner,
  OrgEnforcedConsentList,
  Skeleton,
  StatusBadge,
  Heading,
} from '@canopy/ui-shared/components';
import type {
  IncomingTeamInvitation,
  OrganizationSummary,
} from '@canopy/protocol/settings';
import {
  SettingsConfirmDialog,
  useSettingsClient,
  useSettingsPrivacy,
  useSettingsRouter,
  useSettingsWorkspaceContext,
} from '../host';
import { useSettingsErrorCopy } from '../errors';
import {
  listIncomingInvitations,
  listOrganizations,
  respondToInvitation,
} from './team-api';
import { ROLE_LABEL } from './team-role-label';
import { OrganizationLogo } from './OrganizationLogo';
import { joinClassNames } from './join-class-names';
import { useMembershipChangeFollowUp } from './membership-change';
import { resolveJoinedOrganization } from './resolve-joined-organization';
import type { SettingsFailure } from '../errors';
import { Surface } from '@canopy/ui-shared/components';

export type TeamPanelStatus = 'loading' | 'ready' | 'error';

/** What the page needs to decide whether to show its "New organization". */
export interface TeamPanelState {
  readonly status: TeamPanelStatus;
  readonly hasOrgs: boolean;
}

export interface TeamPanelProps {
  /**
   * Memberships a server already read (`organization.list` page data). With
   * {@link initialInvitations} the panel renders them at once instead of
   * reading on mount; either absent means "read through the table".
   */
  readonly initialOrganizations?: OrganizationSummary[];
  readonly initialInvitations?: IncomingTeamInvitation[];
  /**
   * Starts creating an organization from the empty state's call to action.
   * The page owns the create dialog, so the header action and the empty
   * state open the same one.
   */
  readonly onCreate: () => void;
  /**
   * Reports the load status and whether any organization is listed whenever
   * either changes. Pass a stable callback.
   */
  readonly onStateChange?: (state: TeamPanelState) => void;
}

/**
 * The Organizations list body: pending invitations, then the memberships.
 * With no organizations it is a call to action to create one; with one or
 * more it lists each org (name, your role, member + sub-team counts) and
 * links to `/organization/[orgId]` for management. The page owns the header,
 * its "New organization" action and the create dialog.
 */
export function TeamPanel({
  initialOrganizations,
  initialInvitations,
  onCreate,
  onStateChange,
}: TeamPanelProps): JSX.Element {
  const router = useSettingsRouter();
  const client = useSettingsClient();
  const { blockClassName } = useSettingsPrivacy();
  const errorCopy = useSettingsErrorCopy('settings.organizations');
  const followMembershipChange = useMembershipChangeFollowUp();
  // Opening or joining an organization selects it in the app's sidebar too,
  // so leaving settings lands in that organization.
  const { selectOrganization } = useSettingsWorkspaceContext();
  // Fixed at mount: a server-prefilled panel never reads on mount, and later
  // changes (accept, decline) refresh through the table.
  const [prefilled] = useState(
    initialOrganizations !== undefined && initialInvitations !== undefined,
  );
  const [status, setStatus] = useState<TeamPanelStatus>(
    prefilled ? 'ready' : 'loading',
  );
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>(
    initialOrganizations ?? [],
  );
  const [invitations, setInvitations] = useState<IncomingTeamInvitation[]>(
    initialInvitations ?? [],
  );
  // A failed list load offers Retry; a failed accept or decline does not.
  const [loadError, setLoadError] = useState<SettingsFailure | null>(null);
  const [actionError, setActionError] = useState<SettingsFailure | null>(null);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  // Declining is irreversible, so it confirms via the shared ConfirmDialog.
  const [pendingDecline, setPendingDecline] =
    useState<IncomingTeamInvitation | null>(null);

  /** Re-reads the lists; resolves the memberships, or `null` on failure. */
  const refresh = useCallback(async (): Promise<
    OrganizationSummary[] | null
  > => {
    try {
      // A refresh after a loaded list keeps the list on screen; only a panel
      // with nothing to show yet goes back to its skeleton.
      setStatus((current) => (current === 'ready' ? current : 'loading'));
      setLoadError(null);
      // Invitations are supplementary; a load failure there should not block
      // the org list, so it resolves to an empty list instead of throwing.
      const loadInvitations = async (): Promise<IncomingTeamInvitation[]> => {
        try {
          return await listIncomingInvitations(client);
        } catch {
          return [];
        }
      };
      const [orgs, incoming] = await Promise.all([
        listOrganizations(client),
        loadInvitations(),
      ]);
      setOrganizations(orgs);
      setInvitations(incoming);
      setStatus('ready');
      return orgs;
    } catch (err) {
      setLoadError(errorCopy.loadFailure(err));
      setStatus('error');
      return null;
    }
  }, [client, errorCopy]);

  const handleRespond = useCallback(
    async (
      invite: IncomingTeamInvitation,
      action: 'accept' | 'decline',
    ): Promise<void> => {
      try {
        setRespondingId(invite.id);
        setActionError(null);
        await respondToInvitation(client, invite.id, action);
        // Accepting adds a membership, so the host's organization switcher
        // re-reads too; declining changes only this list.
        if (action === 'accept') followMembershipChange();
        // Refresh so the team appears (accept) or the card clears (decline).
        const listed = await refresh();
        // The invitation's organization id when the server sends one,
        // otherwise the one same-named membership the refresh added.
        const match =
          action === 'accept' && listed !== null
            ? resolveJoinedOrganization({
                invite,
                before: organizations,
                after: listed,
              })
            : null;
        if (match !== null) selectOrganization(match.id);
      } catch (err) {
        setActionError(
          errorCopy.actionFailure(err, {
            action:
              action === 'accept'
                ? 'accept the invitation'
                : 'decline the invitation',
          }),
        );
      } finally {
        setRespondingId(null);
        setPendingDecline(null);
      }
    },
    [
      client,
      errorCopy,
      followMembershipChange,
      organizations,
      refresh,
      selectOrganization,
    ],
  );

  useEffect(() => {
    if (prefilled) return undefined;
    const timeoutId = window.setTimeout(() => {
      void refresh();
    }, 0);
    return (): void => {
      window.clearTimeout(timeoutId);
    };
  }, [prefilled, refresh]);

  const hasOrgs = organizations.length > 0;

  useEffect(() => {
    onStateChange?.({ status, hasOrgs });
  }, [onStateChange, status, hasOrgs]);

  // No card of its own: the page header sits directly above, and the rows
  // keep their own borders.
  return (
    <section className="flex flex-col gap-6" data-testid="team-panel">
      <ErrorBanner
        errorSource="team-panel-load"
        className=""
        error={loadError?.copy}
        details={loadError?.details}
        onRetry={() => void refresh()}
      />
      <ErrorBanner
        errorSource="team-panel-action"
        className=""
        error={actionError?.copy}
        details={actionError?.details}
      />

      {status === 'ready' && invitations.length > 0 && (
        <div className="flex flex-col gap-3" data-testid="team-invitations">
          <Stack gap="tight">
            <Heading level={2} variant="title">
              Pending invitations
            </Heading>

            <p className="text-xs fg-secondary">
              You&apos;ve been invited to these organizations. Accept to join,
              or decline to remove the invitation.
            </p>
          </Stack>

          <ul className="flex flex-col gap-3">
            {invitations.map((invite) => {
              const busy = respondingId === invite.id;
              return (
                <Surface
                  as="li"
                  variant="outline"
                  size="small"
                  key={invite.id}
                  data-testid="team-invitation-row"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary fg-secondary">
                        <Mail size={14} />
                      </span>
                      <Stack gap="tight" className="min-w-0">
                        <p className="truncate text-s font-medium fg-primary">
                          {invite.organizationName}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge variant="warning" label="Invited" />
                          <Badge>{ROLE_LABEL[invite.role]}</Badge>
                          {invite.organizationTeamName && (
                            <Badge>{invite.organizationTeamName}</Badge>
                          )}
                          <span
                            className={joinClassNames(
                              'text-xs fg-secondary',
                              blockClassName,
                            )}
                          >
                            from {invite.invitedByName}
                          </span>
                        </div>
                      </Stack>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="compact"
                        onClick={() => void handleRespond(invite, 'accept')}
                        disabled={busy}
                        data-testid="team-invitation-accept"
                      >
                        <Check size={13} />
                        {busy ? 'Joining…' : 'Accept'}
                      </Button>
                      <Button
                        variant="secondary"
                        size="compact"
                        onClick={() => setPendingDecline(invite)}
                        disabled={busy}
                        data-testid="team-invitation-decline"
                      >
                        <X size={13} />
                        Decline
                      </Button>
                    </div>
                    <OrgEnforcedConsentList
                      className="mt-2 w-full basis-full"
                      settings={invite.enforcedSettings}
                      heading="Required organization settings:"
                    />
                  </div>
                </Surface>
              );
            })}
          </ul>
        </div>
      )}

      {status === 'loading' && (
        <DelayedLoadingPlaceholder>
          <OrganizationListSkeleton />
        </DelayedLoadingPlaceholder>
      )}

      {status === 'ready' && !hasOrgs && (
        <EmptyState
          testId="team-panel-empty"
          icon={<Users size={20} className="fg-secondary" aria-hidden />}
          title="You’re not part of an organization yet."
          subtitle="Create one to invite collaborators and organize teams."
          action={
            <Button
              variant="secondary"
              size="compact"
              onClick={onCreate}
              data-testid="team-panel-create-empty"
            >
              <Plus size={14} />
              Create an organization
            </Button>
          }
        />
      )}

      {status === 'ready' && hasOrgs && (
        <ul className="flex flex-col gap-3">
          {organizations.map((org) => (
            <li key={org.id}>
              <OrganizationRow
                org={org}
                onOpen={() => {
                  selectOrganization(org.id);
                  router.push(`/organization/${org.id}`);
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {pendingDecline && (
        <SettingsConfirmDialog
          title="Decline invitation?"
          message={
            <>
              Decline the invitation to join{' '}
              <span className="font-medium fg-primary">
                {pendingDecline.organizationName}
              </span>
              ? An owner will have to invite you again to rejoin.
            </>
          }
          confirmLabel="Decline invitation"
          busyLabel="Declining…"
          busy={respondingId === pendingDecline.id}
          destructive
          dataTestId="confirm-decline-invitation"
          onConfirm={() => void handleRespond(pendingDecline, 'decline')}
          onCancel={() => setPendingDecline(null)}
        />
      )}
    </section>
  );
}

/** One organization the viewer belongs to, opening its settings. */
function OrganizationRow({
  org,
  onOpen,
}: {
  org: OrganizationSummary;
  onOpen: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      data-settings-control="row"
      onClick={onOpen}
      data-testid="team-panel-org"
      className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 text-left transition-colors hover:bg-secondary"
    >
      <div className="flex min-w-0 items-center gap-3">
        <OrganizationLogo name={org.name} logoUrl={org.logoUrl} size="xl" />
        <Stack gap="tight" className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-s font-medium fg-primary">
              {org.name}
            </span>
            <Badge>{ROLE_LABEL[org.role]}</Badge>
          </div>
          <p className="text-xs fg-secondary">
            {org.memberCount} {org.memberCount === 1 ? 'member' : 'members'} ·{' '}
            {org.subTeamCount} {org.subTeamCount === 1 ? 'team' : 'teams'}
          </p>
        </Stack>
      </div>
      <span className="text-s font-medium fg-accent">Open</span>
    </button>
  );
}

const noop = (): void => undefined;

/** Sample organizations for the loading state: plain, of the loaded shape. */
const SAMPLE_ORGANIZATIONS: readonly OrganizationSummary[] = [
  {
    id: 'sample-org-1',
    name: 'Sample organization',
    role: 'OWNER',
    memberCount: 4,
    subTeamCount: 2,
    logoUrl: null,
  },
  {
    id: 'sample-org-2',
    name: 'Another organization',
    role: 'MEMBER',
    memberCount: 3,
    subTeamCount: 1,
    logoUrl: null,
  },
];

/**
 * The organization list while it loads: the real rows with sample
 * organizations inside `Skeleton`, so skullet measures them into bars in place.
 */
function OrganizationListSkeleton(): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading organizations"
      testId="settings-skeleton-list"
      className="w-full"
    >
      <ul className="flex flex-col gap-3">
        {SAMPLE_ORGANIZATIONS.map((org) => (
          <li key={org.id}>
            <OrganizationRow org={org} onOpen={noop} />
          </li>
        ))}
      </ul>
    </Skeleton>
  );
}
