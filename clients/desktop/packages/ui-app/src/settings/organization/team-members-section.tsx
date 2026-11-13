'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from 'react';
import { LogOut, Mail, Trash2 } from '@canopy/ui-shared/icons/AppIcons';
import {
  Stack,
  Badge,
  Button,
  CopyButton,
  DialogFormField,
  DialogModal,
  ErrorBanner,
  StatusBadge,
  SettingsSelect,
  TextInput,
  Heading,
} from '@canopy/ui-shared/components';
import { formatUsd } from '@canopy/ui-shared/lib';
import { BILLING_NO_SAVED_CARD_CODE } from '@canopy/protocol/billing';
import {
  type OrganizationCreatedInvite,
  type OrganizationDetail,
  type OrganizationOpenInvite,
  type OrganizationMember,
  type OrganizationRole,
  type OrganizationSubTeam,
} from '@canopy/protocol/settings';
import {
  canManageMembers,
  canAssignRole,
  canRemoveMember,
} from '@canopy/protocol/settings/organization-permissions';
import { formatPlanDate } from '@canopy/protocol/settings/plan-display';
import {
  SettingsConfirmDialog,
  SettingsLink,
  useSettingsClient,
  useSettingsHost,
  useSettingsPrivacy,
} from '../host';
import {
  settingsErrorFacts,
  useSettingsErrorCopy,
  type KnownSettingsError,
} from '../errors';
import {
  changeMemberRole,
  leaveOrganization,
  removeMember,
  TeamApiError,
} from './team-api';
import { ROLE_LABEL } from './team-role-label';
import { MemberAvatar } from './MemberAvatar';
import { memberProfileHref } from './profile-links';
import { joinClassNames } from './join-class-names';
import {
  useOrganizationSettingsSlots,
  type OrganizationSeatQuote,
} from './organization-settings-slots';
import type { InviteSeatChargeMode } from './invite-seat-charge';
import {
  SETTINGS_GROUP_CLASS,
  SETTINGS_GROUP_GRID_CLASS,
  SETTINGS_GROUP_GRID_ROW_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import type { SettingsFailure } from '../errors';
import { Surface } from '@canopy/ui-shared/components';

interface TeamMembersSectionProps {
  detail: OrganizationDetail;
  /** Session email used to mark the viewer's own row and offer "Leave". */
  viewerEmail: string;
  onDetailChange: (detail: OrganizationDetail) => void;
  /** Refresh persistent navigation after an invite flow saves a card. */
  onBillingChanged?: () => void;
  /** Called after an invitation is created. */
  onInvited?: () => void;
  /** Called after the viewer leaves the org so the page can navigate away. */
  onLeft: () => void;
  /**
   * The org has lost the `teams` capability (CAN-2311).
   *
   * This tab deliberately stays LIVE while lapsed so the exempt actions
   * (offboard a member, demote an admin, shrink to a payable seat count, leave)
   * remain reachable. Growing the roster is NOT exempt: invitation creation and
   * acceptance are both gated server-side, so the "Add member" CTA and the
   * `?invite=1` auto-open are suppressed rather than left to 403 on submit.
   */
  lapsed?: boolean;
  /**
   * Whether the invite dialog is open. The page shell owns this because its
   * "Add member" action sits in the page header.
   */
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
  /**
   * Re-checks, right before an invite is sent without the seat-charge slot,
   * that inviting still cannot add a paid seat. `handoff` blocks the invite.
   */
  recheckInviteSeatCharge?: () => Promise<
    Exclude<InviteSeatChargeMode, 'checking'>
  >;
}

/** Roles an invitation can carry; ownership is only ever transferred. */
type AddableRole = 'MEMBER' | 'ADMIN';

const ADDABLE_ROLES: AddableRole[] = ['MEMBER', 'ADMIN'];
const ASSIGNABLE_ROLES: OrganizationRole[] = ['OWNER', 'ADMIN', 'MEMBER'];

/** A destructive action awaiting confirmation in a {@link SettingsConfirmDialog}. */
type PendingAction =
  | { type: 'leave' }
  | { type: 'remove'; member: OrganizationMember }
  | { type: 'revoke'; inviteId: string; email: string | null };

/** One invite from `organization.invitations.list`. */
type TeamInvite = OrganizationOpenInvite;

/**
 * Invite links leave the host (the invitee opens them), so they are built on
 * the web origin, never a desktop file origin.
 */
function buildInviteUrl(origin: string, code: string): string {
  return `${origin}/invite/${encodeURIComponent(code)}`;
}

const MEMBERS_ERROR_SCOPE = 'settings.organization.members';

/**
 * Failures of a role change or leave that have their own copy: the server
 * refuses to demote or let leave the last owner.
 */
const LAST_OWNER_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  {
    status: 409,
    copy: 'An organization needs at least one owner. Make someone else an owner first.',
  },
];

const ROLE_CHANGE_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  {
    status: 409,
    serverCode: 'member_role_changed',
    copy: 'This member’s role changed. Refresh the page and try again.',
  },
  ...LAST_OWNER_KNOWN_ERRORS,
];

/**
 * Failures of `organization.members.invite` that have their own copy, by the
 * invite route's status and `code`. `no_saved_card` is not listed: the dialog
 * switches to its add-card state for it instead.
 */
const INVITE_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  {
    // The per-organization invitation rate limit.
    status: 429,
    copy: "You've sent a lot of invitations recently. Try again later.",
  },
  {
    // The card on file was declined for the prorated seat; no invite stands.
    status: 402,
    copy: "The payment for this seat was declined, so we didn't add this member. Update the payment method, then try again.",
  },
  {
    // The seat charge could not be confirmed; the invite was rolled back.
    status: 503,
    copy: "We couldn't confirm the payment for this seat, so we didn't add this member. Try again in a moment.",
  },
  {
    // Already a member, an outstanding invite with another role or team, or
    // a seat charge the payment provider refused.
    status: 409,
    serverCode: 'invite_refused',
    copy: "Couldn't add this member. They may already be in the organization or have a pending invitation.",
  },
];

function titleCaseRole(role: OrganizationRole): string {
  return role.charAt(0) + role.slice(1).toLowerCase();
}

/**
 * Members list with avatar/initials, email, permission-filtered role control, team
 * chips, and remove. The single "Add member" action always creates a pending
 * invitation and the server emails the invitee their link, so the admin sees one
 * outcome whether or not that address already had an account. Outstanding
 * invites render below the members with organization-scoped revocation.
 * The viewer can leave the organization from their own row.
 */
export function TeamMembersSection({
  detail,
  viewerEmail,
  onDetailChange,
  onBillingChanged,
  onInvited,
  onLeft,
  adding,
  onAddingChange,
  recheckInviteSeatCharge,
}: TeamMembersSectionProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(MEMBERS_ERROR_SCOPE);
  const { blockClassName } = useSettingsPrivacy();
  // Removal, role changes, and Leave stay available while lapsed; adding a
  // member is gated by the shell, which owns the invite action.
  const manageMembers = canManageMembers(detail.viewerRole);
  // Removing a member destroys the row holding the Remove button, so focus
  // has no trigger to return to. The member list survives the mutation: the
  // viewer is always on it.
  const membersListRef = useRef<HTMLUListElement | null>(null);

  const [error, setError] = useState<SettingsFailure | null>(null);
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [loadedInvites, setPendingInvites] = useState<TeamInvite[]>([]);
  const inviteRefreshVersion = useRef(0);
  const [loadedInviteScope, setLoadedInviteScope] = useState('');
  const inviteScope = `${detail.id}:${detail.viewerRole}`;
  const pendingInvites = loadedInviteScope === inviteScope ? loadedInvites : [];
  const [revokingId, setRevokingId] = useState<string | null>(null);
  // Destructive actions confirm via a modal before firing (see ConfirmDialog).
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null,
  );

  const subTeamNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const team of detail.subTeams) {
      map.set(team.id, team.name);
    }
    return map;
  }, [detail.subTeams]);

  const normalizedViewerEmail = viewerEmail.trim().toLowerCase();
  const roleLabelPrefix = useId();

  const refreshInvites = useCallback(async (): Promise<void> => {
    const version = ++inviteRefreshVersion.current;
    if (!manageMembers) {
      return;
    }
    try {
      const invites: TeamInvite[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.read('organization.invitations.list', {
          organizationId: detail.id,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (version !== inviteRefreshVersion.current) return;
        if (!page.enabled) {
          setPendingInvites([]);
          return;
        }
        invites.push(
          ...page.items.filter(
            (invite) =>
              invite.organizationId === detail.id && invite.status === 'ACTIVE',
          ),
        );
        cursor = page.nextCursor ?? undefined;
        if (cursor !== undefined) {
          if (cursors.has(cursor))
            throw new Error('Repeated invitation cursor');
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      setPendingInvites(invites);
      setLoadedInviteScope(inviteScope);
    } catch {
      // Pending invites are supplementary; a load failure leaves the list
      // empty rather than blocking the members view.
      if (version === inviteRefreshVersion.current) setPendingInvites([]);
    }
  }, [client, detail.id, manageMembers, inviteScope]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void refreshInvites();
    }, 0);
    return (): void => {
      window.clearTimeout(timeoutId);
      inviteRefreshVersion.current += 1;
    };
  }, [refreshInvites]);

  const handleChangeRole = async (
    member: OrganizationMember,
    role: OrganizationRole,
  ): Promise<void> => {
    if (
      role === member.role ||
      !canAssignRole(detail.viewerRole, member.role, role) ||
      (detail.viewerRole === 'ADMIN' &&
        member.email.trim().toLowerCase() === normalizedViewerEmail)
    ) {
      return;
    }
    try {
      setBusyMemberId(member.id);
      setError(null);
      const updated = await changeMemberRole(
        client,
        detail.id,
        member.id,
        role,
      );
      onDetailChange(updated);
    } catch (err) {
      setError(
        errorCopy.actionFailure(err, {
          action: 'change the role',
          known: ROLE_CHANGE_KNOWN_ERRORS,
        }),
      );
    } finally {
      setBusyMemberId(null);
    }
  };

  const handleRemove = async (member: OrganizationMember): Promise<void> => {
    try {
      setBusyMemberId(member.id);
      setError(null);
      const updated = await removeMember(client, detail.id, member.id);
      onDetailChange(updated);
    } catch (err) {
      setError(errorCopy.actionFailure(err, { action: 'remove the member' }));
    } finally {
      setBusyMemberId(null);
      setPendingAction(null);
    }
  };

  const handleLeave = async (): Promise<void> => {
    try {
      setLeaving(true);
      setError(null);
      await leaveOrganization(client, detail.id);
      onLeft();
    } catch (err) {
      setError(
        errorCopy.actionFailure(err, {
          action: 'leave the organization',
          known: LAST_OWNER_KNOWN_ERRORS,
        }),
      );
      setLeaving(false);
      setPendingAction(null);
    }
  };

  const handleRevokeInvite = async (id: string): Promise<void> => {
    try {
      setRevokingId(id);
      setError(null);
      await client.write('organization.invitations.revoke', {
        organizationId: detail.id,
        inviteId: id,
      });
      await refreshInvites();
    } catch (err) {
      setError(
        errorCopy.actionFailure(err, { action: 'revoke the invitation' }),
      );
    } finally {
      setRevokingId(null);
      setPendingAction(null);
    }
  };

  return (
    // The panel is the list itself: the page header above carries the name,
    // description, and Add member, so nothing else needs a frame.
    <section className="flex flex-col gap-6" data-testid="team-members-section">
      <span id={`${roleLabelPrefix}-caption`} hidden>
        Role for
      </span>
      <ErrorBanner className="" error={error?.copy} details={error?.details} />

      {/* One grid for the whole list, each row a subgrid of it: the role
          and action columns size to their widest entry across every row, so
          Remove and Leave share one width and the role dropdowns line up. */}
      <ul
        ref={membersListRef}
        tabIndex={-1}
        aria-label="Members"
        className={`${SETTINGS_GROUP_GRID_CLASS} grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:gap-x-2`}
      >
        {detail.members.map((member) => {
          const isViewer =
            member.email.trim().toLowerCase() === normalizedViewerEmail;
          const roleOptions = ASSIGNABLE_ROLES.filter((nextRole) =>
            canAssignRole(detail.viewerRole, member.role, nextRole),
          );
          const canEditRole =
            roleOptions.length > 0 &&
            !(detail.viewerRole === 'ADMIN' && isViewer);
          const canRemove =
            !isViewer && canRemoveMember(detail.viewerRole, member.role);
          const busy = busyMemberId === member.id;
          return (
            <li
              key={member.id}
              data-testid="team-member-row"
              className={SETTINGS_GROUP_GRID_ROW_CLASS}
            >
              <SettingsLink
                href={memberProfileHref(detail.id, member.id)}
                data-testid="member-profile-link"
                className="flex min-w-0 items-center gap-3 rounded-md transition-colors hover:bg-secondary/40"
              >
                <MemberAvatar name={member.name} image={member.image} />
                <div className={joinClassNames('min-w-0', blockClassName)}>
                  <p className="flex items-center gap-2 truncate text-s font-medium fg-primary">
                    <span id={`${roleLabelPrefix}-name-${member.id}`}>
                      {member.name}
                    </span>
                    {isViewer && (
                      <span className="text-xs font-normal fg-secondary">
                        (you)
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs fg-secondary">
                    {member.email}
                  </p>
                  {member.subTeamIds.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {member.subTeamIds.map((id) => (
                        <Badge key={id}>
                          {subTeamNameById.get(id) ?? 'Team'}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </SettingsLink>

              {/* Phone width: one right-aligned line under the member. From
                  `sm`, the role and the action are the list grid's own
                  columns; an action stretches to its column's width. */}
              <div className="flex items-center justify-end gap-2 sm:contents">
                <div className="flex">
                  {canEditRole ? (
                    <SettingsSelect
                      value={member.role}
                      disabled={busy}
                      onValueChange={(next) => {
                        if (
                          next === 'OWNER' ||
                          next === 'ADMIN' ||
                          next === 'MEMBER'
                        ) {
                          void handleChangeRole(member, next);
                        }
                      }}
                      // Named through ids: the menu renders outside the
                      // replay-blocked page, so the member's name stays off it.
                      aria-labelledby={`${roleLabelPrefix}-caption ${roleLabelPrefix}-name-${member.id}`}
                      data-testid="team-member-role"
                      options={roleOptions.map((role) => ({
                        value: role,
                        label: titleCaseRole(role),
                      }))}
                    />
                  ) : (
                    <Badge>{ROLE_LABEL[member.role]}</Badge>
                  )}
                </div>

                {canRemove && (
                  <Button
                    size="compact"
                    onClick={() => setPendingAction({ type: 'remove', member })}
                    disabled={busy}
                    aria-label={`Remove ${member.name}`}
                    data-testid="team-member-remove"
                  >
                    <Trash2 size={13} />
                    {busy ? 'Removing…' : 'Remove'}
                  </Button>
                )}

                {isViewer && (
                  <Button
                    size="compact"
                    onClick={() => setPendingAction({ type: 'leave' })}
                    disabled={leaving}
                    data-testid="team-leave"
                  >
                    <LogOut size={13} />
                    {leaving ? 'Leaving…' : 'Leave'}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {manageMembers && pendingInvites.length > 0 && (
        <div data-testid="team-pending-invites">
          <Heading level={3} variant="title">
            Pending invitations
          </Heading>
          <p className="mt-1 text-xs fg-secondary">
            {detail.viewerRole === 'OWNER'
              ? 'People invited to this organization who haven’t joined yet.'
              : 'People you’ve invited who haven’t joined yet.'}
          </p>
          <ul className={`mt-3 ${SETTINGS_GROUP_CLASS}`}>
            {pendingInvites.map((invite) => (
              <li
                key={invite.externalId}
                data-testid="team-pending-invite-row"
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary fg-secondary">
                    <Mail size={14} />
                  </span>
                  <Stack gap="tight" className="min-w-0">
                    <p
                      className={joinClassNames(
                        'truncate text-s font-medium fg-primary',
                        blockClassName,
                      )}
                    >
                      {invite.invitedEmail ?? 'Invite link'}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge
                        variant={
                          invite.seatPaymentState === 'FAILED'
                            ? 'destructive'
                            : 'warning'
                        }
                        label={
                          invite.seatPaymentState === 'PROCESSING'
                            ? 'Payment processing'
                            : invite.seatPaymentState === 'FAILED'
                              ? 'Payment failed'
                              : 'Pending'
                        }
                      />
                      {invite.role && (
                        <span className="text-xs fg-secondary">
                          {titleCaseRole(invite.role)}
                        </span>
                      )}
                      {invite.organizationTeamName && (
                        <Badge>{invite.organizationTeamName}</Badge>
                      )}
                    </div>
                  </Stack>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="compact"
                    onClick={() =>
                      setPendingAction({
                        type: 'revoke',
                        inviteId: invite.externalId,
                        email: invite.invitedEmail,
                      })
                    }
                    disabled={revokingId === invite.externalId}
                    data-testid="team-invite-revoke"
                  >
                    <Trash2 size={13} />
                    {revokingId === invite.externalId ? 'Revoking…' : 'Revoke'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {adding && (
        <AddMemberDialog
          orgId={detail.id}
          teamName={detail.name}
          subTeams={detail.subTeams}
          canAssignAdmin={canAssignRole(detail.viewerRole, 'MEMBER', 'ADMIN')}
          canManageBilling={detail.viewerRole === 'OWNER'}
          onClose={() => onAddingChange(false)}
          onInvited={() => {
            onInvited?.();
            void refreshInvites();
          }}
          onBillingChanged={onBillingChanged}
          recheckInviteSeatCharge={recheckInviteSeatCharge}
        />
      )}

      {pendingAction?.type === 'leave' && (
        <SettingsConfirmDialog
          title="Leave this organization?"
          message="You'll lose access to this organization and its teams. Worktrees, chats and Cowork entries you shared here stop being available to everyone. Your private projects here are archived, but your local files stay."
          confirmLabel="Leave organization"
          busyLabel="Leaving…"
          busy={leaving}
          destructive
          dataTestId="confirm-leave-team"
          onConfirm={() => void handleLeave()}
          onCancel={() => setPendingAction(null)}
        />
      )}

      {pendingAction?.type === 'remove' && (
        <SettingsConfirmDialog
          title={
            <>
              Remove{' '}
              <span className={blockClassName}>
                {pendingAction.member.name}
              </span>
              ?
            </>
          }
          message="They'll lose access to this organization and its teams. Worktrees, chats and Cowork entries they shared here stop being available to everyone. Their private projects here are archived. They keep their local files, but this organization's projects move to their Personal space."
          confirmLabel="Remove member"
          busyLabel="Removing…"
          busy={busyMemberId === pendingAction.member.id}
          destructive
          dataTestId="confirm-remove-member"
          onConfirm={() => void handleRemove(pendingAction.member)}
          onCancel={() => setPendingAction(null)}
          restoreFocusRef={membersListRef}
        />
      )}

      {pendingAction?.type === 'revoke' && (
        <SettingsConfirmDialog
          title="Revoke invite?"
          message={
            <>
              Revoke the invite
              {pendingAction.email ? (
                <>
                  {' '}
                  for{' '}
                  <span
                    className={joinClassNames(
                      'font-medium fg-primary',
                      blockClassName,
                    )}
                  >
                    {pendingAction.email}
                  </span>
                </>
              ) : null}
              ? The invite link will stop working.
            </>
          }
          confirmLabel="Revoke invite"
          busyLabel="Revoking…"
          busy={revokingId === pendingAction.inviteId}
          destructive
          dataTestId="confirm-revoke-invite"
          onConfirm={() => void handleRevokeInvite(pendingAction.inviteId)}
          onCancel={() => setPendingAction(null)}
          // Same shape as remove-member: `refreshInvites()` drops the
          // pending-invite row holding the Revoke button, so the opener is
          // detached by the time focus would return to it.
          restoreFocusRef={membersListRef}
        />
      )}
    </section>
  );
}

interface AddMemberDialogProps {
  orgId: string;
  teamName: string;
  subTeams: OrganizationSubTeam[];
  /** Whether the viewer may invite an Admin (Owners and Admins). */
  canAssignAdmin: boolean;
  /**
   * Whether the viewer may add a payment method (owner-only, matching the
   * server-side gate on the org billing routes). Admins can invite members but
   * cannot fix a missing card, so they get a "ask an owner" note instead of the
   * add-card CTA.
   */
  canManageBilling: boolean;
  onClose: () => void;
  /** An invitation was created — refresh the pending list. */
  onInvited: () => void;
  onBillingChanged?: () => void;
  recheckInviteSeatCharge?: TeamMembersSectionProps['recheckInviteSeatCharge'];
}

/** Loading state of the prorated-seat quote that gates submission. */
type QuoteStatus = 'loading' | 'ready' | 'error';

/** Outcome of one "Add member" submission attempt. */
type AddAttempt =
  | { kind: 'created' }
  /** The org needs a card on file before the prorated seat can be charged. */
  | { kind: 'needs-card' }
  /** Any other failure, with the copy to show for it. */
  | { kind: 'failed'; failure: SettingsFailure };

const ADD_MEMBER_ACTION = 'add this member';
const QUOTE_ERROR =
  'Could not check whether adding a member costs anything right now.';

/**
 * Stand-in quote used when the seat-quote endpoint is absent for this viewer
 * (billing flagged off, so it 404s). Adding a member cannot be charged in that
 * case, so the dialog renders its plain, free path instead of blocking on a
 * surface that does not exist.
 */
const FREE_SEAT_QUOTE: OrganizationSeatQuote = {
  chargeRequired: false,
  amountUsd: 0,
  minimumApplied: false,
  periodEndsAt: null,
  daysRemaining: 0,
  hasPaymentMethod: false,
  card: null,
};

/** Shown when the price moved between opening the dialog and submitting it. */
const QUOTE_CHANGED_ERROR =
  'The price for this seat changed. Review the updated amount and try again.';

/**
 * Shown when the pre-submit re-check could not be completed. Distinct from
 * {@link QUOTE_CHANGED_ERROR}: nothing changed and there is no new amount to
 * review, so telling the admin the price moved would be wrong.
 */
const QUOTE_RECHECK_FAILED_ERROR =
  'Could not re-check the price for this seat. Please try again.';

/**
 * Shown when a host without inline seat quoting finds, right before sending,
 * that inviting may now add a paid seat. The page header then offers the web
 * handoff instead of this dialog.
 */
const SEAT_CHARGE_HANDOFF_ERROR =
  'Inviting can add a paid seat. Continue in your browser.';

/**
 * The result of a successful "Add member" submission. One shape regardless of
 * whether the address already had an account: both branches mint the same
 * redeemable code, the invitee is emailed the link either way, and branching
 * here would leak whether an arbitrary address is registered.
 */
interface AddOutcome {
  emailQueued: boolean;
  emailSuppressed: boolean;
  emailDeferred: boolean;
  seatPaymentState: OrganizationCreatedInvite['seatPaymentState'];
  email: string;
  role: OrganizationRole;
  url: string;
}

function AddMemberDialog({
  orgId,
  teamName,
  subTeams,
  canAssignAdmin,
  canManageBilling,
  onClose,
  onInvited,
  onBillingChanged,
  recheckInviteSeatCharge,
}: AddMemberDialogProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(MEMBERS_ERROR_SCOPE);
  const webOrigin = useSettingsHost().webOrigin();
  const { blockClassName } = useSettingsPrivacy();
  const fieldId = useId();
  // Quoting a seat and adding a card are financial; only a host with inline
  // checkout supplies them. Without the slot no charge can apply here (the
  // page hands paid per-seat invites off to the web), so the dialog starts
  // on its plain, free path.
  const { seatCharge } = useOrganizationSettingsSlots();
  // Only owners may grant ADMIN, so admins don't see it as an option (the
  // server enforces this too).
  const roleOptions: AddableRole[] = canAssignAdmin
    ? ADDABLE_ROLES
    : ['MEMBER'];
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AddableRole>('MEMBER');
  const [groupId, setGroupId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [outcome, setOutcome] = useState<AddOutcome | null>(null);
  const [quote, setQuote] = useState<OrganizationSeatQuote | null>(
    seatCharge === undefined ? FREE_SEAT_QUOTE : null,
  );
  const [quoteStatus, setQuoteStatus] = useState<QuoteStatus>(
    seatCharge === undefined ? 'ready' : 'loading',
  );
  const [cardModalOpen, setCardModalOpen] = useState(false);

  // Load (and reload, after a card is added) what the next seat costs. The quote
  // gates submission: this dialog must never create an invitation that silently
  // charges the card, so an unresolved quote disables the submit button rather
  // than falling back to the un-priced label.
  const loadQuote = useCallback(async (): Promise<void> => {
    if (seatCharge === undefined) {
      setQuote(FREE_SEAT_QUOTE);
      setQuoteStatus('ready');
      return;
    }
    setQuoteStatus('loading');
    try {
      const next = await seatCharge.getSeatQuote(orgId);
      setQuote(next);
      setQuoteStatus('ready');
    } catch (err) {
      // A 404 means billing is flagged off for this viewer (the route is absent);
      // a 403 means they may not read it. Neither can produce a charge, so treat
      // both as "free" rather than blocking member management. Only a real
      // failure (5xx, network) blocks.
      if (
        err instanceof TeamApiError &&
        (err.status === 404 || err.status === 403)
      ) {
        setQuote(FREE_SEAT_QUOTE);
        setQuoteStatus('ready');
        return;
      }
      setQuote(null);
      setQuoteStatus('error');
    }
  }, [orgId, seatCharge]);

  useEffect(() => {
    if (seatCharge === undefined) return undefined;
    // Deferred to a macrotask rather than called inline: `loadQuote` sets state
    // synchronously on entry, and doing that in an effect body triggers a
    // cascading render (react-hooks/set-state-in-effect). Mirrors how
    // `refreshInvites` schedules its own load above.
    const timeoutId = window.setTimeout(() => {
      void loadQuote();
    }, 0);
    return (): void => {
      window.clearTimeout(timeoutId);
    };
  }, [loadQuote, seatCharge]);

  /**
   * Re-read the quote and report whether the amount the admin is looking at is
   * still the amount that will be charged. A changed quote is written to state so
   * the notice and the button re-render with the new figure before they retry.
   * A failed re-quote blocks rather than charging blind.
   */
  const confirmQuoteUnchanged = async (): Promise<
    'unchanged' | 'changed' | 'failed' | 'handoff'
  > => {
    if (seatCharge === undefined) {
      // No inline quote: confirm instead that inviting still cannot add a
      // paid seat, so a plan change since the page loaded never charges one.
      if (recheckInviteSeatCharge === undefined) return 'unchanged';
      try {
        return (await recheckInviteSeatCharge()) === 'inline'
          ? 'unchanged'
          : 'handoff';
      } catch {
        return 'failed';
      }
    }
    const previous = quote;
    try {
      const next = await seatCharge.getSeatQuote(orgId);
      setQuote(next);
      setQuoteStatus('ready');
      const same =
        previous !== null &&
        previous.chargeRequired === next.chargeRequired &&
        previous.amountUsd === next.amountUsd;
      return same ? 'unchanged' : 'changed';
    } catch (err) {
      // Billing absent for this viewer: nothing can be charged, so there is no
      // consent to invalidate and the submit proceeds.
      if (
        err instanceof TeamApiError &&
        (err.status === 404 || err.status === 403)
      ) {
        setQuote(FREE_SEAT_QUOTE);
        setQuoteStatus('ready');
        return 'unchanged';
      }
      setQuoteStatus('error');
      return 'failed';
    }
  };

  const chargeRequired = quote?.chargeRequired === true;
  // A charge is owed but there is no usable payment method to take it from. Keyed
  // on `hasPaymentMethod`, which is what the server's charge path actually gates
  // on — the `card` display cache can be empty on an account that charges fine.
  const needsCard = chargeRequired && quote?.hasPaymentMethod === false;

  // Every "Add member" submission creates a pending invite and the server emails
  // the invitee their link, so the outcome is the same whether or not the
  // address already had an account.
  const createInvite = async (trimmedEmail: string): Promise<AddAttempt> => {
    let parsed: OrganizationCreatedInvite;
    try {
      parsed = await client.write('organization.members.invite', {
        organizationId: orgId,
        ...(groupId ? { organizationTeamId: groupId } : {}),
        email: trimmedEmail,
        role,
      });
    } catch (error: unknown) {
      // The route tells its refusals apart by status and `code`: a
      // `no_saved_card` 409, a 402 card decline, an unconfirmed-charge 503, a
      // rate-limit 429, or an `invite_refused` 409. Each known one gets its
      // own copy, so a declined card reads as a decline rather than a generic
      // failure; the server's text goes to the log only.
      if (settingsErrorFacts(error).serverCode === BILLING_NO_SAVED_CARD_CODE) {
        // The card disappeared between the quote and the submit; re-quote so the
        // dialog switches to its add-card state.
        void loadQuote();
        return { kind: 'needs-card' };
      }
      return {
        kind: 'failed',
        failure: errorCopy.actionFailure(error, {
          action: ADD_MEMBER_ACTION,
          known: INVITE_KNOWN_ERRORS,
        }),
      };
    }
    setOutcome({
      email: trimmedEmail,
      emailQueued: parsed.emailQueued,
      emailSuppressed: parsed.emailSuppressed,
      emailDeferred: parsed.emailDeferred,
      seatPaymentState: parsed.seatPaymentState,
      role: parsed.role,
      url: buildInviteUrl(webOrigin, parsed.code),
    });
    onInvited();
    return { kind: 'created' };
  };

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Re-quote immediately before charging. The dialog can sit open across a
      // UTC day boundary (which changes the prorated days) or across another
      // admin's seat add, and the button states a specific amount the admin is
      // consenting to. If it moved, show the new figure and make them confirm
      // again rather than charging a price they never saw.
      const recheck = await confirmQuoteUnchanged();
      if (recheck !== 'unchanged') {
        setError({
          copy:
            recheck === 'changed'
              ? QUOTE_CHANGED_ERROR
              : recheck === 'handoff'
                ? SEAT_CHARGE_HANDOFF_ERROR
                : QUOTE_RECHECK_FAILED_ERROR,
        });
        return;
      }
      const result = await createInvite(trimmed);
      if (result.kind === 'needs-card') {
        setError({
          copy: canManageBilling
            ? 'Add a payment method to charge the new seat.'
            : 'An organization owner needs to add a payment method before you can add members.',
        });
      } else if (result.kind === 'failed') {
        setError(result.failure);
      }
    } catch (err) {
      setError(errorCopy.actionFailure(err, { action: ADD_MEMBER_ACTION }));
    } finally {
      setSubmitting(false);
    }
  };

  const submitLabel =
    chargeRequired && quote !== null
      ? `Add member and pay ${formatUsd(quote.amountUsd)}`
      : 'Add member';

  return (
    <DialogModal
      onClose={onClose}
      title="Add member"
      subtitle={`Add someone by email. We'll send them an invitation to join ${teamName}.`}
      maxWidth="md"
      dataTestId="add-member-dialog"
    >
      {outcome ? (
        <div className="flex flex-col gap-4" data-testid="add-member-success">
          <Surface variant="group" size="small" padding="default">
            <p className="text-s font-medium fg-primary">
              {outcome.seatPaymentState === 'PROCESSING'
                ? 'Payment processing'
                : outcome.emailSuppressed
                  ? 'Invitation requested recently'
                  : outcome.emailQueued
                    ? 'Invitation sent'
                    : 'Invitation created'}
            </p>
            <p
              className={joinClassNames(
                'mt-1 text-s fg-secondary',
                blockClassName,
              )}
            >
              {outcome.seatPaymentState === 'PROCESSING' ? (
                outcome.emailDeferred ? (
                  <>
                    We&apos;ll send the invitation email once payment confirms.
                    The link will become available then.
                  </>
                ) : (
                  <>
                    Payment is still confirming, and we won&apos;t send an
                    invitation email for this request. The link will become
                    available after payment confirms.
                  </>
                )
              ) : outcome.emailSuppressed ? (
                <>
                  This invitation was requested recently, so we didn&apos;t send
                  another email. Copy the link below so {outcome.email} can join{' '}
                  {teamName} as {titleCaseRole(outcome.role)}.
                </>
              ) : outcome.emailQueued ? (
                <>
                  We sent an invitation email to {outcome.email}. They&apos;ll
                  join {teamName} as {titleCaseRole(outcome.role)}.
                </>
              ) : (
                <>
                  Invitation created, but we couldn&apos;t send the email. Copy
                  the link below so {outcome.email} can join {teamName} as{' '}
                  {titleCaseRole(outcome.role)}.
                </>
              )}
            </p>
            {outcome.seatPaymentState !== 'PROCESSING' &&
              !outcome.emailDeferred && (
                <div className="mt-3 flex items-center gap-2">
                  <Surface
                    variant="card"
                    size="small"
                    className="min-w-0 flex-1"
                  >
                    <code
                      className={joinClassNames(
                        'block truncate px-3 py-2 text-xs fg-secondary',
                        blockClassName,
                      )}
                    >
                      {outcome.url}
                    </code>
                  </Surface>
                  <CopyButton
                    value={outcome.url}
                    label="Copy"
                    copiedLabel="Copied"
                    ariaLabel="Copy invite link"
                    variant="secondary"
                    size="compact"
                  />
                </div>
              )}
          </Surface>
          <div className="flex items-center justify-end gap-2">
            <Button
              size="compact"
              onClick={() => {
                setOutcome(null);
                setEmail('');
                setRole('MEMBER');
                setGroupId('');
                setError(null);
              }}
            >
              Add another
            </Button>
            <Button
              size="compact"
              variant="primary"
              onClick={onClose}
              data-testid="add-member-done"
            >
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <ErrorBanner error={error?.copy} details={error?.details} />
          <DialogFormField label="Email" htmlFor={`${fieldId}-email`}>
            <div className={joinClassNames('min-w-0 flex-1', blockClassName)}>
              <TextInput
                id={`${fieldId}-email`}
                density="settings"
                type="email"
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="add-member-email"
              />
            </div>
          </DialogFormField>
          <div className="flex flex-wrap gap-3">
            <div className="min-w-0 flex-1">
              <DialogFormField label="Role" htmlFor={`${fieldId}-role`}>
                <SettingsSelect
                  id={`${fieldId}-role`}
                  value={role}
                  onValueChange={(next) => {
                    if (
                      next === 'MEMBER' ||
                      (next === 'ADMIN' && canAssignAdmin)
                    ) {
                      setRole(next);
                    }
                  }}
                  data-testid="add-member-role"
                  width="fill"
                  options={roleOptions.map((option) => ({
                    value: option,
                    label: titleCaseRole(option),
                  }))}
                />
              </DialogFormField>
            </div>
            {subTeams.length > 0 && (
              <div className="min-w-0 flex-1">
                <DialogFormField
                  label="Team (optional)"
                  htmlFor={`${fieldId}-group`}
                >
                  <SettingsSelect
                    id={`${fieldId}-group`}
                    value={groupId}
                    onValueChange={setGroupId}
                    data-testid="add-member-group"
                    width="fill"
                    options={[
                      { value: '', label: 'No team' },
                      ...subTeams.map((team) => ({
                        value: team.id,
                        label: team.name,
                      })),
                    ]}
                  />
                </DialogFormField>
              </div>
            )}
          </div>

          <SeatChargeNotice
            teamName={teamName}
            quote={quote}
            status={quoteStatus}
            needsCard={needsCard}
            canManageBilling={canManageBilling}
            canAddCard={seatCharge?.canAddCard === true}
            onRetryQuote={() => void loadQuote()}
            onAddCard={() => setCardModalOpen(true)}
          />

          {/* No Cancel: the dialog closes from its X, Escape, or the
              backdrop, including while a submit is in flight. */}
          <div className="flex items-center justify-end gap-2">
            <Button
              size="compact"
              variant="primary"
              type="submit"
              // Blocked until the quote resolves so the button label always
              // states the real price, and while a charge is owed with no card on
              // file (the server would reject it anyway).
              disabled={
                submitting ||
                !email.trim() ||
                quoteStatus !== 'ready' ||
                needsCard
              }
              data-testid="add-member-submit"
            >
              {submitting ? 'Adding…' : submitLabel}
            </Button>
          </div>
        </form>
      )}

      {cardModalOpen && seatCharge?.canAddCard === true ? (
        <seatCharge.AddCardModal
          // A pure card save: the org already holds a live subscription, so
          // the slot confirms the card without a plan key.
          organizationId={orgId}
          onClose={() => setCardModalOpen(false)}
          onSaved={() => {
            setCardModalOpen(false);
            setError(null);
            onBillingChanged?.();
            // Re-quote so the notice picks up the saved card and the submit
            // button unblocks.
            void loadQuote();
          }}
        />
      ) : null}
    </DialogModal>
  );
}

interface SeatChargeNoticeProps {
  teamName: string;
  quote: OrganizationSeatQuote | null;
  status: QuoteStatus;
  needsCard: boolean;
  canManageBilling: boolean;
  /** Whether Stripe is configured, so the card modal can actually be mounted. */
  canAddCard: boolean;
  onRetryQuote: () => void;
  onAddCard: () => void;
}

/**
 * The in-dialog confirmation for a prorated seat charge.
 *
 * Renders nothing at all when adding a member is free (a free, trialing, or
 * flat-rate org, or a seat already paid for this period), so the common case
 * keeps today's dialog. When a charge is owed it states the amount, what window
 * it covers, and which card will be charged before the admin commits.
 */
function SeatChargeNotice({
  teamName,
  quote,
  status,
  needsCard,
  canManageBilling,
  canAddCard,
  onRetryQuote,
  onAddCard,
}: SeatChargeNoticeProps): JSX.Element | null {
  if (status === 'loading') {
    return (
      <p className="text-xs fg-secondary" data-testid="seat-charge-loading">
        Checking seat availability…
      </p>
    );
  }

  if (status === 'error') {
    return (
      <Surface
        gap="inline"
        variant="group"
        size="small"
        padding="compact"
        data-testid="seat-charge-error"
      >
        <p className="text-s fg-primary">{QUOTE_ERROR}</p>
        <Button
          size="compact"
          className="self-start"
          onClick={onRetryQuote}
          data-testid="seat-charge-retry"
        >
          Try again
        </Button>
      </Surface>
    );
  }

  if (quote === null || !quote.chargeRequired) {
    return null;
  }

  const through =
    quote.periodEndsAt !== null ? formatPlanDate(quote.periodEndsAt) : null;

  return (
    <Surface
      variant="group"
      size="small"
      padding="compact"
      data-testid="seat-charge-notice"
    >
      <p className="text-s font-medium fg-primary">This adds a paid seat</p>
      <p className="mt-1 text-s fg-secondary">
        {teamName} will be charged{' '}
        <span className="font-medium fg-primary">
          {formatUsd(quote.amountUsd)}
        </span>{' '}
        now for the {quote.daysRemaining}{' '}
        {quote.daysRemaining === 1 ? 'day' : 'days'} left in this billing period
        {through !== null ? ` (through ${through})` : ''}
        {quote.minimumApplied
          ? `, our ${formatUsd(quote.amountUsd)} minimum for adding a seat`
          : ''}
        . The seat then renews with the rest of your plan.
      </p>
      {needsCard ? (
        <Stack
          gap="inline"
          className="mt-3"
          data-testid="seat-charge-needs-card"
        >
          <p className="text-s fg-secondary">
            {canManageBilling && canAddCard
              ? 'There is no payment method on file yet. Add a card to continue.'
              : 'There is no payment method on file yet. An organization owner needs to add a card before you can add members.'}
          </p>
          {canManageBilling && canAddCard ? (
            <Button
              size="compact"
              variant="secondary"
              className="self-start"
              onClick={onAddCard}
              data-testid="seat-charge-add-card"
            >
              Add card
            </Button>
          ) : null}
        </Stack>
      ) : quote.card !== null ? (
        <p className="mt-2 text-xs fg-secondary">
          Charging {quote.card.brand} ending in {quote.card.last4}.
        </p>
      ) : null}
    </Surface>
  );
}
