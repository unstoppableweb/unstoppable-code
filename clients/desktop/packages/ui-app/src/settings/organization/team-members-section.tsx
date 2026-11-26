'use client';

import { StatusIllustration } from '@canopy/ui-shared/components';
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
  FormField,
  DialogModal,
  ErrorBanner,
  SettingsSelect,
  TextInput,
  Heading,
} from '@canopy/ui-shared/components';
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
import {
  SettingsConfirmDialog,
  SettingsLink,
  useSettingsClient,
  useSettingsHost,
  useSettingsPrivacy,
} from '../host';
import { useSettingsErrorCopy, type KnownSettingsError } from '../errors';
import { changeMemberRole, leaveOrganization, removeMember } from './team-api';
import { ROLE_LABEL } from './team-role-label';
import { MemberAvatar } from './MemberAvatar';
import { memberProfileHref } from './profile-links';
import { joinClassNames } from './join-class-names';
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
  /** Called after an invitation is created. */
  onInvited?: () => void;
  /** Called after the viewer leaves the org so the page can navigate away. */
  onLeft: () => void;
  /**
   * Whether the invite dialog is open. The page shell owns this because its
   * "Add member" action sits in the page header.
   */
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
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
 * invite route's status and `code`.
 */
const INVITE_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  {
    // The per-organization invitation rate limit.
    status: 429,
    copy: "You've sent a lot of invitations recently. Try again later.",
  },
  {
    // Already a member, or an outstanding invite with another role or team.
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
  onInvited,
  onLeft,
  adding,
  onAddingChange,
}: TeamMembersSectionProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(MEMBERS_ERROR_SCOPE);
  const { blockClassName } = useSettingsPrivacy();
  // Adding a member is gated by the shell, which owns the invite action.
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
      <ErrorBanner
        errorSource="team-members-section"
        className=""
        error={error?.copy}
        details={error?.details}
      />

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
                  <Stack gap="tight">
                    <div className="min-w-0">
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
                    </div>
                    {member.subTeamIds.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {member.subTeamIds.map((id) => (
                          <Badge key={id}>
                            {subTeamNameById.get(id) ?? 'Team'}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </Stack>
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
        <Stack gap="item" data-testid="team-pending-invites">
          <Stack gap="tight">
            <Heading level={3} variant="title">
              Pending invitations
            </Heading>
            <p className="text-xs fg-secondary">
              {detail.viewerRole === 'OWNER'
                ? 'People invited to this organization who haven’t joined yet.'
                : 'People you’ve invited who haven’t joined yet.'}
            </p>
          </Stack>
          <ul className={SETTINGS_GROUP_CLASS}>
            {pendingInvites.map((invite) => (
              <li
                key={invite.externalId}
                data-testid="team-pending-invite-row"
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <StatusIllustration variant="member" tone="neutral">
                    <Mail size={14} />
                  </StatusIllustration>
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
                      {/* Invites no longer charge a seat, so an older invite's
                        stored seat payment state is not shown. */}
                      <Badge tone="warning">Pending</Badge>
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
        </Stack>
      )}

      {adding && (
        <AddMemberDialog
          orgId={detail.id}
          teamName={detail.name}
          subTeams={detail.subTeams}
          canAssignAdmin={canAssignRole(detail.viewerRole, 'MEMBER', 'ADMIN')}
          onClose={() => onAddingChange(false)}
          onInvited={() => {
            onInvited?.();
            void refreshInvites();
          }}
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
  onClose: () => void;
  /** An invitation was created — refresh the pending list. */
  onInvited: () => void;
}

/** Outcome of one "Add member" submission attempt. */
type AddAttempt =
  | { kind: 'created' }
  /** A failure, with the copy to show for it. */
  | { kind: 'failed'; failure: SettingsFailure };

const ADD_MEMBER_ACTION = 'add this member';

/**
 * The result of a successful "Add member" submission. One shape regardless of
 * whether the address already had an account: both branches mint the same
 * redeemable code, the invitee is emailed the link either way, and branching
 * here would leak whether an arbitrary address is registered.
 */
interface AddOutcome {
  emailQueued: boolean;
  emailSuppressed: boolean;
  email: string;
  role: OrganizationRole;
  url: string;
}

function AddMemberDialog({
  orgId,
  teamName,
  subTeams,
  canAssignAdmin,
  onClose,
  onInvited,
}: AddMemberDialogProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(MEMBERS_ERROR_SCOPE);
  const webOrigin = useSettingsHost().webOrigin();
  const { blockClassName } = useSettingsPrivacy();
  const fieldId = useId();
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
      // The route tells its refusals apart by status and `code`: a rate-limit
      // 429 or an `invite_refused` 409 each get their own copy; the server's
      // text goes to the log only.
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
      const result = await createInvite(trimmed);
      if (result.kind === 'failed') {
        setError(result.failure);
      }
    } catch (err) {
      setError(errorCopy.actionFailure(err, { action: ADD_MEMBER_ACTION }));
    } finally {
      setSubmitting(false);
    }
  };

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
            <Stack gap="item">
              <Stack gap="tight">
                <p className="text-s font-medium fg-primary">
                  {outcome.emailSuppressed
                    ? 'Invitation requested recently'
                    : outcome.emailQueued
                      ? 'Invitation sent'
                      : 'Invitation created'}
                </p>
                <p
                  className={joinClassNames(
                    'text-s fg-secondary',
                    blockClassName,
                  )}
                >
                  {outcome.emailSuppressed ? (
                    <>
                      This invitation was requested recently, so we didn&apos;t
                      send another email. Copy the link below so {outcome.email}{' '}
                      can join {teamName} as {titleCaseRole(outcome.role)}.
                    </>
                  ) : outcome.emailQueued ? (
                    <>
                      We sent an invitation email to {outcome.email}.
                      They&apos;ll join {teamName} as{' '}
                      {titleCaseRole(outcome.role)}.
                    </>
                  ) : (
                    <>
                      Invitation created, but we couldn&apos;t send the email.
                      Copy the link below so {outcome.email} can join {teamName}{' '}
                      as {titleCaseRole(outcome.role)}.
                    </>
                  )}
                </p>
              </Stack>
              <div className="flex items-center gap-2">
                <Surface variant="card" size="small" className="min-w-0 flex-1">
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
            </Stack>
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
          <ErrorBanner
            errorSource="add-member-dialog"
            error={error?.copy}
            details={error?.details}
          />
          <FormField label="Email" id={`${fieldId}-email`}>
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
          </FormField>
          <div className="flex flex-wrap gap-3">
            <div className="min-w-0 flex-1">
              <FormField label="Role" id={`${fieldId}-role`}>
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
              </FormField>
            </div>
            {subTeams.length > 0 && (
              <div className="min-w-0 flex-1">
                <FormField label="Team (optional)" id={`${fieldId}-group`}>
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
                </FormField>
              </div>
            )}
          </div>

          {/* No Cancel: the dialog closes from its X, Escape, or the
              backdrop, including while a submit is in flight. */}
          <div className="flex items-center justify-end gap-2">
            <Button
              size="compact"
              variant="primary"
              type="submit"
              disabled={submitting || !email.trim()}
              data-testid="add-member-submit"
            >
              {submitting ? 'Adding…' : 'Add member'}
            </Button>
          </div>
        </form>
      )}
    </DialogModal>
  );
}
