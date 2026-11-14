'use client';

import { Badge, Dot } from '@canopy/ui-shared/components/Badge';
import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';
import type { IncomingTeamInvitation } from '@canopy/protocol/settings/organization';
import type {
  WorkspaceContext,
  WorkspaceContextOrganization,
} from '@canopy/protocol/workspace-context';
import { isSameWorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  ActionMenuRowStyle,
  Button,
  ConfirmDialog,
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuLabel,
  FloatingMenu,
  SidebarAiCreditsMenuItem,
  Notice,
  NoticeButton,
} from '@canopy/ui-shared/components';
import {
  BuildingIcon,
  CheckIcon,
  ChevronDownMediumIcon,
  PersonIcon,
  SettingsIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { creditsBillingTargetPath } from '@canopy/protocol/billing';
import {
  SidebarCreateOrganizationMenuItem,
  SidebarFeedMenuItem,
  SidebarInviteTeamMenuItem,
  SidebarStatisticsMenuItem,
} from './AccountMenuActivityItem';
import {
  resolveSidebarContextActions,
  type SidebarContextActions,
} from './sidebar-context-actions';
import type { SidebarContextInvitations } from './usePendingOrganizationInvitations';
import { ROLE_LABEL } from '../../settings/organization/team-role-label';

/**
 * The selected context's actions under the switcher's context list
 * (CAN-4057): Feed, Statistics, Invite your team, the organization's AI
 * Credits, and Organization settings, after Create an organization at the
 * end of the context list (CAN-4554). Which rows show is decided by
 * {@link resolveSidebarContextActions}, never by which callbacks the host
 * passes; the callbacks only say how the host opens each destination.
 */
export interface SidebarContextOrgScopedActions {
  /**
   * Whether account identity is authenticated and non-guest. Defaults to true
   * for hosts mounted only for authenticated users; false hides every action
   * even if an independently loaded membership snapshot has not cleared yet.
   */
  readonly authenticated?: boolean;
  /**
   * External ID of the viewer's personal organization; `null` while loading,
   * for guests, and before it is provisioned (Personal then has only Create
   * an organization).
   */
  readonly personalOrganizationId: string | null;
  /** Free app access: an OWNER or ADMIN gets the organization's AI Credits row. */
  readonly freeAccess: boolean;
  /** Opens a hosted page path; the menu has already closed. */
  readonly onOpenPath: (path: string) => void;
  /** Opens the Create a team flow from Personal; omitted ⇒ no row. */
  readonly onCreateTeam?: () => void;
  /** Opens the invite dialog for an organization; omitted ⇒ no row. */
  readonly onInviteToTeam?: (
    organization: WorkspaceContextOrganization,
  ) => void;
  /**
   * The organization pool's balance, read by the host. The row asks for a
   * fresh read each time it mounts (the menu mounts rows only while open) and
   * shows the number only when it belongs to the organization the row opens.
   */
  readonly credits?: {
    readonly organizationId: string;
    readonly balanceCredits: number | null;
    readonly refresh: () => void;
  };
}

/**
 * The Personal/organization switcher at the top of the sidebar (CAN-2953,
 * CAN-4053, CAN-4057), on both the web portal and the desktop sidebar. Dumb by
 * design: the host supplies the current context and the organizations the
 * account belongs to, and receives the selection; it never grants access,
 * because selecting a context is a navigation fact only.
 *
 * An account with no organizations still gets the row, on Personal with
 * Personal's actions; whether to mount it at all is
 * `sidebarContextSwitcherAvailable`.
 */
export interface SidebarContextRowProps {
  readonly context: WorkspaceContext;
  readonly organizations: readonly WorkspaceContextOrganization[];
  readonly onSelect: (context: WorkspaceContext) => void;
  /** The selected context's actions under the context list (CAN-4057). */
  readonly orgScoped: SidebarContextOrgScopedActions;
  /** Told each time the menu opens or closes. */
  readonly onOpenChange?: (open: boolean) => void;
  /** Disables the trigger while a switch is in flight. */
  readonly disabled?: boolean;
  /**
   * `footer` (default) is a plain row, menu opening upward. `top` sits above
   * New task with no surface at rest, so it never reads as a second selected
   * row; hover, keyboard focus and the open menu wash it with `bg-subtle`. It
   * keeps the rows' 32px height, uses the 16px text style, and opens downward.
   */
  readonly placement?: 'footer' | 'top';
  /**
   * Contexts with work left running, unread, or interrupted (CAN-2959),
   * keyed `'personal'` or by organization id. Each other context in the set
   * gets the unread-blue dot on its menu row, and the trigger carries one dot
   * so the user knows to open the menu. The current context never shows a
   * dot: its work is already on screen.
   */
  readonly contextsWithUpdates?: ReadonlySet<string>;
  /**
   * Pending share invitations per context (CAN-4783), keyed like
   * {@link contextsWithUpdates} (`contextUpdateKey`). A positive count on
   * another listed context gets the same unread-blue dot, one per surface
   * alongside any updates, and its count in the accessible name only. The
   * current context, unlisted organizations and zero counts never show.
   * Optional: hosts that omit it keep the updates-only cue.
   */
  readonly pendingSharesByContext?: ReadonlyMap<string, number>;
  /**
   * Pending organization invitations (CAN-3672), from
   * `usePendingOrganizationInvitations`. A nonempty list gets an Invitations
   * group after the organizations, and the trigger the unread-blue dot with
   * the count in its accessible name. The row asks for a fresh read each
   * time the menu opens. Omitted, or `orgScoped.authenticated` false: no
   * group and no cue.
   */
  readonly invitations?: SidebarContextInvitations;
  /**
   * Re-enter the desktop sidebar's instant-feedback scope by name, as the
   * account row's menu does: the menu portals out of the sidebar's subtree.
   */
  readonly menuInstantInteractions?: boolean;
  readonly testIds?: {
    readonly row?: string;
    readonly menu?: string;
    readonly optionPersonal?: string;
    /** Prefix for organization options; the organization id is appended. */
    readonly optionOrganizationPrefix?: string;
    /** The organization AI Credits row; `-balance` is appended for its pill. */
    readonly credits?: string;
    readonly organizationSettings?: string;
    /** The trigger's other-context updates dot. */
    readonly attentionDot?: string;
    /** Prefix for a menu row's updates dot; `personal` or the id is appended. */
    readonly activityPrefix?: string;
  };
}

interface NamedOrganization {
  readonly id: string;
  readonly name: string;
}

interface OrganizationOption<T extends NamedOrganization> {
  readonly organization: T;
  /** Secondary text shown only when another organization shares the name. */
  readonly secondary: string | null;
}

/** Trailing id characters used to tell two same-named organizations apart. */
const IDENTITY_SUFFIX_LENGTH = 6;

function identitySuffix(id: string): string {
  return id.replace(/-/g, '').slice(-IDENTITY_SUFFIX_LENGTH);
}

/**
 * Organizations sorted by name, with a secondary identity only where two
 * display names collide. Exported for tests and for hosts that render the
 * same list elsewhere (account menu, command palette).
 */
export function buildOrganizationOptions<T extends NamedOrganization>(
  organizations: readonly T[],
): OrganizationOption<T>[] {
  const counts = new Map<string, number>();
  for (const organization of organizations) {
    const key = organization.name.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...organizations]
    .sort(
      (a, b) =>
        a.name
          .trim()
          .toLowerCase()
          .localeCompare(b.name.trim().toLowerCase()) ||
        a.id.localeCompare(b.id),
    )
    .map((organization) => ({
      organization,
      secondary:
        (counts.get(organization.name.trim().toLowerCase()) ?? 0) > 1
          ? identitySuffix(organization.id)
          : null,
    }));
}

/** `1 pending share`, `2 pending shares`. */
function pendingSharesPhrase(count: number): string {
  return `${count} pending ${count === 1 ? 'share' : 'shares'}`;
}

/** `1 pending invitation`, `2 pending invitations`. */
function pendingInvitationsPhrase(count: number): string {
  return `${count} pending ${count === 1 ? 'invitation' : 'invitations'}`;
}

/** The attention a context row carries: updates and pending shares. */
interface ContextAttention {
  readonly updated: boolean;
  /** Positive, or 0 for none. */
  readonly pendingShares: number;
}

/**
 * Each context's attention by key. The current context carries none: its
 * work and shares are already on screen.
 */
function contextAttention(
  currentKey: string,
  contextsWithUpdates: ReadonlySet<string> | undefined,
  pendingSharesByContext: ReadonlyMap<string, number> | undefined,
): (key: string) => ContextAttention {
  return (key) => {
    if (key === currentKey) return { updated: false, pendingShares: 0 };
    const count = pendingSharesByContext?.get(key) ?? 0;
    return {
      updated: contextsWithUpdates?.has(key) ?? false,
      pendingShares: count > 0 ? count : 0,
    };
  };
}

/** A menu row's accessible name: name, then `has updates`, then shares. */
function contextOptionLabel(name: string, attention: ContextAttention): string {
  return [
    name,
    ...(attention.updated ? ['has updates'] : []),
    ...(attention.pendingShares > 0
      ? [pendingSharesPhrase(attention.pendingShares)]
      : []),
  ].join(', ');
}

/**
 * The trigger's accessible name and whether it carries the attention dot:
 * the current context, then other contexts with updates, then each one's
 * pending shares. Personal first, then organizations in menu order, as the
 * menu lists them. Only listed contexts count, so an unknown key never adds
 * an unnamed suffix or a stray dot.
 */
function contextTriggerLabel(
  currentLabel: string,
  options: readonly OrganizationOption<NamedOrganization>[],
  attentionOf: (key: string) => ContextAttention,
  pendingInvitations: number,
): { readonly label: string; readonly attention: boolean } {
  const listedContexts = [
    { name: 'Personal', ...attentionOf('personal') },
    ...options.map(({ organization, secondary }) => ({
      name: secondary ? `${organization.name} ${secondary}` : organization.name,
      ...attentionOf(organization.id),
    })),
  ];
  const updatedContextNames = listedContexts
    .filter(({ updated }) => updated)
    .map(({ name }) => name);
  const pendingShareSuffixes = listedContexts
    .filter(({ pendingShares }) => pendingShares > 0)
    .map(
      ({ name, pendingShares }) =>
        `${pendingSharesPhrase(pendingShares)} in ${name}`,
    );
  return {
    label: [
      `Workspace context: ${currentLabel}`,
      ...(updatedContextNames.length > 0
        ? [`updates in ${updatedContextNames.join(', ')}`]
        : []),
      ...pendingShareSuffixes,
      ...(pendingInvitations > 0
        ? [pendingInvitationsPhrase(pendingInvitations)]
        : []),
    ].join(', '),
    attention:
      updatedContextNames.length > 0 ||
      pendingShareSuffixes.length > 0 ||
      pendingInvitations > 0,
  };
}

function UpdatesDot({ testId }: { readonly testId: string }): JSX.Element {
  return (
    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
      <Dot tone="unread" data-testid={testId} />
    </span>
  );
}

/**
 * A context's 16px glyph: the person icon for Personal, the organization's
 * logo, or the building icon when it has none (or its logo fails to load).
 */
export function SidebarContextGlyph({
  kind,
  logoUrl,
}: {
  readonly kind: WorkspaceContext['kind'];
  readonly logoUrl?: string | null;
}): JSX.Element {
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  if (kind === 'personal') {
    return (
      <PersonIcon
        size={16}
        aria-hidden="true"
        data-testid="sidebar-context-glyph-person"
      />
    );
  }
  if (logoUrl && brokenSrc !== logoUrl) {
    return (
      <img
        src={logoUrl}
        width={16}
        height={16}
        className="rounded-sm object-cover shrink-0"
        alt=""
        aria-hidden="true"
        data-testid="sidebar-context-glyph-logo"
        onError={() => setBrokenSrc(logoUrl)}
      />
    );
  }
  return (
    <BuildingIcon
      size={16}
      aria-hidden="true"
      data-testid="sidebar-context-glyph-building"
    />
  );
}

export function SidebarContextRow({
  context,
  organizations,
  onSelect,
  orgScoped,
  onOpenChange,
  disabled = false,
  placement = 'footer',
  contextsWithUpdates,
  pendingSharesByContext,
  invitations: invitationsProp,
  menuInstantInteractions = false,
  testIds,
}: SidebarContextRowProps): JSX.Element {
  const invitations =
    orgScoped.authenticated === false ? undefined : invitationsProp;
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean): void => {
    setOpenState(next);
    if (next !== open) onOpenChange?.(next);
    // Every open re-reads, even an empty list: invitations arrive by email.
    if (next && !open) invitations?.refresh();
  };
  const [declining, setDeclining] = useState<IncomingTeamInvitation | null>(
    null,
  );
  const declineScope = useRef<object | null | undefined>(undefined);
  const declineRequest = useRef(0);
  const declineSubmitting = useRef(false);
  const [declineError, setDeclineError] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const options = useMemo(
    () => buildOrganizationOptions(organizations),
    [organizations],
  );

  const current =
    context.kind === 'organization'
      ? (organizations.find(
          (organization) => organization.id === context.organizationId,
        ) ?? null)
      : null;
  const currentLabel =
    context.kind === 'personal'
      ? 'Personal'
      : (current?.name ?? 'Organization');
  const currentKey =
    context.kind === 'personal' ? 'personal' : context.organizationId;
  const { label: triggerLabel, attention: triggerAttention } =
    contextTriggerLabel(
      currentLabel,
      options,
      contextAttention(currentKey, contextsWithUpdates, pendingSharesByContext),
      invitations?.items.length ?? 0,
    );
  const closeMenu = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  // The dialog lives only while its invitation is listed for this account;
  // a refresh or account change that drops it never sends a stale decline.
  const declineBusy =
    declining !== null &&
    invitations?.pending?.inviteId === declining.id &&
    invitations.pending.action === 'decline';
  const declineListed =
    declining !== null &&
    (invitations?.items.some((invite) => invite.id === declining.id) ?? false);
  const declineTarget =
    declining !== null &&
    invitations &&
    declineScope.current === invitations.scope &&
    (declineListed || declineBusy)
      ? declining
      : null;
  useEffect(() => {
    if (declining !== null && declineTarget === null) {
      declineRequest.current += 1;
      declineSubmitting.current = false;
      setDeclining(null);
      setDeclineError(null);
    }
  }, [declining, declineTarget]);
  const confirmDecline = (invite: IncomingTeamInvitation): void => {
    if (!invitations || declineBusy || declineSubmitting.current) return;
    declineSubmitting.current = true;
    const request = ++declineRequest.current;
    setDeclineError(null);
    void invitations.decline(invite).then((result) => {
      if (request !== declineRequest.current) return;
      declineSubmitting.current = false;
      if (result.kind === 'failed') {
        setDeclineError(result.message);
        return;
      }
      if (result.kind === 'declined' || result.kind === 'unavailable')
        setDeclining(null);
    });
  };
  const cancelDecline = (): void => {
    declineRequest.current += 1;
    declineSubmitting.current = false;
    if (declineError !== null) invitations?.dismissError();
    setDeclining(null);
    setDeclineError(null);
  };

  useEffect(
    () => (): void => {
      declineRequest.current += 1;
    },
    [],
  );

  const atTop = placement === 'top';

  return (
    <div className="relative w-full min-w-0">
      <div
        ref={rowRef}
        className="group/sidebar-item flex w-full items-center gap-0"
      >
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          onClick={() => setOpen(!open)}
          data-testid={testIds?.row ?? 'sidebar-context-row'}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-controls={open ? menuId : undefined}
          aria-label={triggerLabel}
          className={
            atTop
              ? `focus-ring flex h-8 w-full min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-row py-0 pl-1 pr-2 text-left text-m font-bold fg-primary hover:bg-subtle focus-visible:bg-subtle aria-expanded:bg-subtle disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:min-h-11`
              : 'focus-ring flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap rounded-row px-2 text-left text-s font-normal fg-primary hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:min-h-11'
          }
        >
          <span
            className={
              atTop
                ? 'ml-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center fg-secondary'
                : 'inline-flex h-4 w-4 shrink-0 items-center justify-center fg-secondary'
            }
          >
            <SidebarContextGlyph
              kind={context.kind}
              logoUrl={current?.logoUrl}
            />
          </span>
          <span
            className={
              atTop
                ? 'min-w-0 truncate leading-snug'
                : 'min-w-0 flex-1 truncate leading-snug'
            }
            title={currentLabel}
          >
            {currentLabel}
          </span>
          {triggerAttention ? (
            <UpdatesDot
              testId={testIds?.attentionDot ?? 'sidebar-context-attention-dot'}
            />
          ) : null}
          <ChevronDownMediumIcon
            size={16}
            aria-hidden="true"
            className="shrink-0 fg-secondary"
          />
        </button>
      </div>
      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={rowRef}
        returnFocusRef={triggerRef}
        placement={atTop ? 'bottom-left' : 'top-left'}
        aria-label="Switch context"
        data-testid={testIds?.menu ?? 'sidebar-context-menu'}
        className={`pointer-coarse:[&_.canopy-dropdown-menu-item]:min-h-11 ${
          menuInstantInteractions ? 'sidebar-instant-interactions w-64' : 'w-64'
        }`}
        closeOnSelect={false}
      >
        <SidebarContextMenuItems
          context={context}
          organizations={organizations}
          contextsWithUpdates={contextsWithUpdates}
          pendingSharesByContext={pendingSharesByContext}
          onClose={closeMenu}
          onSelect={onSelect}
          orgScoped={orgScoped}
          invitations={invitations}
          onRequestDecline={(invite): void => {
            declineRequest.current += 1;
            declineScope.current = invitations?.scope;
            setDeclineError(null);
            setDeclining(invite);
          }}
          disabled={disabled}
          testIds={testIds}
        />
      </FloatingMenu>
      {!open && invitations?.error && declineTarget === null ? (
        <InvitationAlert
          error={invitations.error}
          onReview={invitations.review}
          onDismiss={invitations.dismissError}
          placement="row"
        />
      ) : null}
      {declineTarget !== null ? (
        <ConfirmDialog
          title="Decline invitation?"
          message={
            <>
              Decline the invitation to join{' '}
              <span className="font-medium fg-primary">
                {declineTarget.organizationName}
              </span>
              ? An owner will have to invite you again to rejoin.
            </>
          }
          confirmLabel="Decline invitation"
          busyLabel="Declining…"
          busy={declineBusy}
          errorMessage={declineError}
          destructive
          focusCancel
          dataTestId="sidebar-context-decline-invitation"
          confirmTestId="sidebar-context-decline-invitation-confirm"
          cancelTestId="sidebar-context-decline-invitation-cancel"
          restoreFocusRef={triggerRef}
          onConfirm={(): void => confirmDecline(declineTarget)}
          onCancel={cancelDecline}
        />
      ) : null}
    </div>
  );
}

/**
 * A failed or unavailable invitation response. In the menu it is a status
 * line (with Open organizations as a menu row after an accepted invitation
 * whose organization could not open); under the closed trigger it keeps its
 * own Dismiss button, so the message outlives the menu and its last row.
 */
function InvitationAlert({
  error,
  onReview,
  onDismiss,
  placement,
}: {
  readonly error: NonNullable<SidebarContextInvitations['error']>;
  readonly onReview: () => void;
  readonly onDismiss: () => void;
  readonly placement: 'menu' | 'row';
}): JSX.Element {
  if (placement === 'menu') {
    return (
      <>
        <Notice
          errorSource="sidebar-context-invitations-error"
          intent="destructive"
          className="mx-1 my-1"
          data-testid="sidebar-context-invitations-error"
        >
          {error.message}
        </Notice>
        {error.kind === 'follow-up' ? (
          <ActionMenuRowStyle>
            <DropdownMenuItem
              data-testid="sidebar-context-invitations-open-organizations"
              onClick={onReview}
            >
              <DropdownMenuItemIcon>
                <BuildingIcon size="xl" />
              </DropdownMenuItemIcon>
              Open organizations
            </DropdownMenuItem>
          </ActionMenuRowStyle>
        ) : null}
      </>
    );
  }
  return (
    <Notice
      errorSource="sidebar-context-invitations-error"
      intent="destructive"
      className="mt-1"
      data-testid="sidebar-context-invitations-error"
      actionsPlacement="below"
      onDismiss={onDismiss}
      dismissTestId="sidebar-context-invitations-dismiss"
      actions={
        error.kind === 'follow-up' ? (
          <NoticeButton
            data-testid="sidebar-context-invitations-open-organizations"
            onClick={(): void => {
              onDismiss();
              onReview();
            }}
          >
            Open organizations
          </NoticeButton>
        ) : undefined
      }
    >
      {error.message}
    </Notice>
  );
}

/** The organization a row names, with its team or role when names repeat. */
function invitationLabels(
  items: readonly IncomingTeamInvitation[],
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const invite of items) {
    const key = invite.organizationName.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Map(
    items.map((invite) => {
      const repeated =
        (counts.get(invite.organizationName.trim().toLowerCase()) ?? 0) > 1;
      const detail = [invite.organizationTeamName, ROLE_LABEL[invite.role]]
        .filter(Boolean)
        .join(', ');
      return [
        invite.id,
        repeated
          ? `${invite.organizationName} (${detail})`
          : invite.organizationName,
      ];
    }),
  );
}

/**
 * The Invitations group (CAN-3672): each pending invitation's organization
 * and offered role, then its actions as compact menu items. Accept waits for
 * the response with the menu open, so a failure stays beside its row; an
 * invitation with enforced settings offers Review, which opens the consent
 * flow in Settings > Organizations instead of answering it here.
 */
function ContextInvitationItems({
  invitations,
  onClose,
  onRequestDecline,
}: {
  readonly invitations: SidebarContextInvitations;
  readonly onClose: () => void;
  readonly onRequestDecline?: (invite: IncomingTeamInvitation) => void;
}): JSX.Element | null {
  const { items, pending, error } = invitations;
  const labels = useMemo(() => invitationLabels(items), [items]);
  if (items.length === 0 && error === null) return null;
  const busy = pending !== null;
  return (
    <div role="presentation" data-testid="sidebar-context-invitations">
      <DropdownMenuDivider />
      {items.length > 0 ? (
        <DropdownMenuLabel>Invitations</DropdownMenuLabel>
      ) : null}
      {items.map((invite) => {
        const label = labels.get(invite.id) ?? invite.organizationName;
        // Usage-data prohibitions only turn the member's own telemetry off,
        // so they alone need no review before joining.
        const needsReview = (invite.enforcedSettings ?? []).some((org) =>
          org.policies.some((policy) => policy.kind !== 'usage-data'),
        );
        const joining =
          pending?.inviteId === invite.id && pending.action === 'accept';
        return (
          <div
            key={invite.id}
            role="presentation"
            data-testid={`sidebar-context-invitation-${invite.id}`}
            className="flex flex-col px-2 pb-1"
          >
            <div
              role="presentation"
              className="flex h-8 min-w-0 items-center gap-2 text-s fg-primary"
            >
              <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
                <SidebarContextGlyph kind="organization" />
              </span>
              <span
                className="min-w-0 flex-1 truncate"
                title={invite.organizationName}
              >
                {invite.organizationName}
              </span>
              <Badge>{ROLE_LABEL[invite.role]}</Badge>
            </div>
            <div role="presentation" className="flex items-center gap-1 pl-5">
              {needsReview ? (
                <Button
                  variant="ghost-accent"
                  size="compact"
                  role="menuitem"
                  aria-label={`Review invitation to ${label}`}
                  data-testid={`sidebar-context-invitation-review-${invite.id}`}
                  disabled={busy}
                  onClick={(): void => {
                    onClose();
                    invitations.review();
                  }}
                >
                  Review invitation
                </Button>
              ) : (
                <Button
                  variant="ghost-accent"
                  size="compact"
                  role="menuitem"
                  aria-label={`Accept invitation to ${label}`}
                  data-testid={`sidebar-context-invitation-accept-${invite.id}`}
                  disabled={busy}
                  onClick={(): void => {
                    let closed = false;
                    void invitations
                      .accept(invite, (): void => {
                        closed = true;
                        onClose();
                      })
                      .then((result) => {
                        if (!closed && result.kind === 'accepted') onClose();
                      });
                  }}
                >
                  {joining ? 'Joining…' : 'Accept'}
                </Button>
              )}
              {onRequestDecline ? (
                <Button
                  variant="ghost-overlay"
                  size="compact"
                  role="menuitem"
                  aria-label={`Decline invitation to ${label}`}
                  data-testid={`sidebar-context-invitation-decline-${invite.id}`}
                  disabled={busy}
                  onClick={(): void => {
                    onClose();
                    onRequestDecline(invite);
                  }}
                >
                  Decline
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
      {error !== null ? (
        <InvitationAlert
          error={error}
          onReview={(): void => {
            onClose();
            invitations.dismissError();
            invitations.review();
          }}
          onDismiss={invitations.dismissError}
          placement="menu"
        />
      ) : null}
    </div>
  );
}

export interface SidebarContextMenuItemsProps {
  readonly context: WorkspaceContext;
  readonly organizations: readonly WorkspaceContextOrganization[];
  /** Called only when the choice differs from the current context. */
  readonly onSelect: (context: WorkspaceContext) => void;
  /** See {@link SidebarContextRowProps.orgScoped}. */
  readonly orgScoped: SidebarContextOrgScopedActions;
  /** Closes the host menu; called before any row's action. */
  readonly onClose: () => void;
  /** See {@link SidebarContextRowProps.contextsWithUpdates}. */
  readonly contextsWithUpdates?: ReadonlySet<string>;
  /** See {@link SidebarContextRowProps.pendingSharesByContext}. */
  readonly pendingSharesByContext?: ReadonlyMap<string, number>;
  /** See {@link SidebarContextRowProps.invitations}. */
  readonly invitations?: SidebarContextInvitations;
  /** Opens the decline confirmation outside the menu; omitted ⇒ no Decline. */
  readonly onRequestDecline?: (invite: IncomingTeamInvitation) => void;
  /** Disables the context options while a switch is in flight. */
  readonly disabled?: boolean;
  readonly testIds?: SidebarContextRowProps['testIds'];
}

/**
 * The organization pool's AI Credits row. Mounting (opening the menu) asks
 * the host for a fresh balance; so does a host target change while it is open.
 */
function ContextCreditsMenuItem({
  organizationId,
  credits,
  onSelect,
  testId,
}: {
  readonly organizationId: string;
  readonly credits: SidebarContextOrgScopedActions['credits'];
  readonly onSelect: () => void;
  readonly testId: string;
}): JSX.Element {
  const current = credits?.organizationId === organizationId ? credits : null;
  const refresh = current?.refresh;
  useEffect(() => {
    refresh?.();
  }, [refresh]);
  return (
    <SidebarAiCreditsMenuItem
      balanceCredits={current?.balanceCredits ?? null}
      onSelect={onSelect}
      data-testid={testId}
    />
  );
}

/**
 * The selected context's actions, in their fixed order, after a divider when
 * at least one shows. See {@link SidebarContextOrgScopedActions}.
 */
function ContextOrgScopedItems({
  actions,
  orgScoped,
  onClose,
  testIds,
}: {
  readonly actions: SidebarContextActions;
  readonly orgScoped: SidebarContextOrgScopedActions;
  readonly onClose: () => void;
  readonly testIds: SidebarContextRowProps['testIds'];
}): JSX.Element | null {
  const { onOpenPath, onCreateTeam, onInviteToTeam } = orgScoped;
  const openPath = (path: string): void => {
    onClose();
    onOpenPath(path);
  };
  const invite = actions.invite;
  let inviteClick: (() => void) | null = null;
  if (invite?.kind === 'create-team' && onCreateTeam) {
    inviteClick = (): void => {
      onClose();
      onCreateTeam();
    };
  } else if (invite?.kind === 'invite' && onInviteToTeam) {
    const organization = invite.organization;
    inviteClick = (): void => {
      onClose();
      onInviteToTeam(organization);
    };
  }
  const creditsOrganizationId = actions.creditsOrganizationId;
  if (
    actions.feedPath === null &&
    actions.statisticsPath === null &&
    !inviteClick &&
    creditsOrganizationId === null &&
    actions.settingsPath === null
  ) {
    return null;
  }
  // The actions take the action-menu rows (small text, tertiary icons); the
  // context choices above keep the picker's own rows and checkmarks.
  return (
    <>
      <DropdownMenuDivider />
      <ActionMenuRowStyle>
        {actions.feedPath !== null ? (
          <SidebarFeedMenuItem path={actions.feedPath} onOpenPath={openPath} />
        ) : null}
        {actions.statisticsPath !== null ? (
          <SidebarStatisticsMenuItem
            path={actions.statisticsPath}
            onOpenPath={openPath}
          />
        ) : null}
        {invite && inviteClick ? (
          <SidebarInviteTeamMenuItem kind={invite.kind} onClick={inviteClick} />
        ) : null}
        {creditsOrganizationId !== null ? (
          <ContextCreditsMenuItem
            organizationId={creditsOrganizationId}
            credits={orgScoped.credits}
            onSelect={(): void =>
              openPath(
                creditsBillingTargetPath({
                  kind: 'organization',
                  organizationId: creditsOrganizationId,
                }),
              )
            }
            testId={testIds?.credits ?? 'sidebar-context-menu-item-ai-credits'}
          />
        ) : null}
        {actions.settingsPath !== null ? (
          <DropdownMenuItem
            data-testid={
              testIds?.organizationSettings ??
              'sidebar-context-organization-settings'
            }
            onClick={(): void => {
              if (actions.settingsPath !== null) openPath(actions.settingsPath);
            }}
          >
            <DropdownMenuItemIcon>
              <SettingsIcon />
            </DropdownMenuItemIcon>
            Organization settings
          </DropdownMenuItem>
        ) : null}
      </ActionMenuRowStyle>
    </>
  );
}

/**
 * The context switcher's menu rows: Personal, the organizations by name, any
 * pending invitations, Create an organization, then the selected context's
 * actions after a divider ({@link SidebarContextOrgScopedActions}).
 */
export function SidebarContextMenuItems({
  context,
  organizations,
  onSelect,
  orgScoped,
  onClose,
  contextsWithUpdates,
  pendingSharesByContext,
  invitations,
  onRequestDecline,
  disabled = false,
  testIds,
}: SidebarContextMenuItemsProps): JSX.Element {
  const options = useMemo(
    () => buildOrganizationOptions(organizations),
    [organizations],
  );
  const currentKey =
    context.kind === 'personal' ? 'personal' : context.organizationId;
  const attentionOf = contextAttention(
    currentKey,
    contextsWithUpdates,
    pendingSharesByContext,
  );
  const personalAttention = attentionOf('personal');
  const personalNeedsAttention =
    personalAttention.updated || personalAttention.pendingShares > 0;
  const activityPrefix = testIds?.activityPrefix ?? 'sidebar-context-activity-';
  const optionPrefix =
    testIds?.optionOrganizationPrefix ?? 'sidebar-context-option-';
  const select = (next: WorkspaceContext): void => {
    onClose();
    invitations?.cancelFollowUp?.();
    if (!isSameWorkspaceContext(next, context)) {
      onSelect(next);
    }
  };
  const actions = resolveSidebarContextActions({
    context,
    organizations,
    authenticated: orgScoped.authenticated,
    personalOrganizationId: orgScoped.personalOrganizationId,
    freeAccess: orgScoped.freeAccess,
  });
  const createOrganizationPath = actions.createOrganizationPath;
  return (
    <>
      <DropdownMenuItem
        role="menuitemradio"
        aria-checked={context.kind === 'personal'}
        aria-label={
          personalNeedsAttention
            ? contextOptionLabel('Personal', personalAttention)
            : undefined
        }
        data-testid={
          testIds?.optionPersonal ?? 'sidebar-context-option-personal'
        }
        disabled={disabled}
        onClick={() => select({ kind: 'personal' })}
      >
        <DropdownMenuItemIcon>
          <SidebarContextGlyph kind="personal" />
        </DropdownMenuItemIcon>
        <span className="min-w-0 flex-1 truncate">Personal</span>
        {personalNeedsAttention ? (
          <UpdatesDot testId={`${activityPrefix}personal`} />
        ) : null}
        {context.kind === 'personal' ? (
          <CheckIcon size={16} aria-hidden="true" className="shrink-0" />
        ) : null}
      </DropdownMenuItem>
      {options.map(({ organization, secondary }) => {
        const selected =
          context.kind === 'organization' &&
          context.organizationId === organization.id;
        const attention = attentionOf(organization.id);
        const needsAttention = attention.updated || attention.pendingShares > 0;
        const name = secondary
          ? `${organization.name} ${secondary}`
          : organization.name;
        return (
          <DropdownMenuItem
            key={organization.id}
            role="menuitemradio"
            aria-checked={selected}
            // Spell out the identity suffix and the attention dot (updates,
            // pending shares), which the visible spans carry without
            // separators or text.
            aria-label={
              needsAttention
                ? contextOptionLabel(name, attention)
                : secondary
                  ? name
                  : undefined
            }
            data-testid={`${optionPrefix}${organization.id}`}
            disabled={disabled}
            onClick={() =>
              select({
                kind: 'organization',
                organizationId: organization.id,
              })
            }
          >
            <DropdownMenuItemIcon>
              <SidebarContextGlyph
                kind="organization"
                logoUrl={organization.logoUrl}
              />
            </DropdownMenuItemIcon>
            <span className="min-w-0 flex-1 truncate">{organization.name}</span>
            {secondary ? (
              <span className="shrink-0 text-xs fg-secondary">{secondary}</span>
            ) : null}
            {needsAttention ? (
              <UpdatesDot testId={`${activityPrefix}${organization.id}`} />
            ) : null}
            {selected ? (
              <CheckIcon size={16} aria-hidden="true" className="shrink-0" />
            ) : null}
          </DropdownMenuItem>
        );
      })}
      {invitations && orgScoped.authenticated !== false ? (
        <ContextInvitationItems
          invitations={invitations}
          onClose={onClose}
          onRequestDecline={onRequestDecline}
        />
      ) : null}
      {createOrganizationPath !== null ? (
        <ActionMenuRowStyle>
          <SidebarCreateOrganizationMenuItem
            onClick={(): void => {
              onClose();
              orgScoped.onOpenPath(createOrganizationPath);
            }}
          />
        </ActionMenuRowStyle>
      ) : null}
      <ContextOrgScopedItems
        actions={actions}
        orgScoped={orgScoped}
        onClose={onClose}
        testIds={testIds}
      />
    </>
  );
}
