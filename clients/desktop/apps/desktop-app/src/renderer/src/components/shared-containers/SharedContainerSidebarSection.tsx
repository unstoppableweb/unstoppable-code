/**
 * "Shared with you" sidebar section (CAN-2550).
 *
 * Composes the existing `SidebarSection` / `SidebarList` primitives, the same
 * way the Code and Hidden sections do. Shared containers are deliberately NOT
 * synthesized as `SidebarItem` entries and are never written into
 * `workspaces/index.json` — they are not workspaces, they are read-only
 * replicas of someone else's, and the sidebar index is the source of truth for
 * user-owned workspaces only.
 */
import { useEffect, useRef, useState, type JSX, type RefObject } from 'react';
import {
  SHARED_WITH_YOU_SECTION_LABEL,
  SidebarList,
  SidebarSection,
} from '@canopy/ui-app';
import {
  Dot,
  RailIconButton,
  SIDEBAR_ROW_TRAILING_CELL_CLASSNAME,
  SIDEBAR_ROW_GRID_CLASSNAME,
  SIDEBAR_ROW_LEADING_SLOT_CLASSNAME,
  SIDEBAR_ROW_TEXT_INSET_CLASSNAME,
  SharedContainerInvitationDialog,
  SidebarOverviewNavLink,
  Badge,
} from '@canopy/ui-shared/components';
import {
  ChevronDownMediumIcon,
  RetryIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { LoadingSpinner } from '@/components/shared/loading';
import { SharedContainerRecipientActionsMenu } from './SharedContainerRecipientActionsMenu';
import { useScopedSharedContainerEntries } from './useScopedSharedContainerEntries';
import { useSharedContainerRecipientActions } from './useSharedContainerRecipientActions';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useSharedContainerEntryPointVisible } from '@/hooks/useSharedContainerEntryPointVisible';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  useSharedContainerReplicasStore,
  type SharedContainerListEntry,
} from '@/stores/sharedContainerReplicasStore';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import {
  openAcceptedSharedContainer,
  openPastSharesSurface,
} from '@/lib/sharedContainerPastSharesNavigation';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

const SECTION_TOGGLE_TEST_ID = 'sidebar-section-shared-with-me-toggle';

export function SharedContainerSidebarSection({
  expanded,
  onExpandedChange,
}: {
  expanded: boolean;
  onExpandedChange: (next: boolean) => void;
}): JSX.Element | null {
  const listStatus = useSharedContainerReplicasStore(
    (state) => state.listStatus,
  );
  const activeContainerId = useSharedContainerReplicasStore(
    (state) => state.viewer?.containerId ?? null,
  );
  const featureVisible = useSharedContainerEntryPointVisible();
  const loadSharedWithMe = useSharedContainerReplicasStore(
    (state) => state.loadSharedWithMe,
  );
  // CAN-2551. `loadSharedWithMe` sets `listStatus: 'loading'` on entry, which
  // satisfies the "nothing to show" guard below and would unmount the whole
  // section — including the Retry button — the instant it is clicked. This
  // local flag keeps the error row mounted for the duration of the retry
  // without widening what `listStatus` means to its other consumers
  // (`navigationHistoryStore` keys pruning on `=== 'success'`).
  const [retrying, setRetrying] = useState(false);
  const pastSharesOpen = useSharedContainerReplicasStore(
    (state) => state.pastSharesOpen,
  );
  // A server that keeps no removed shares has no Past shares page to open:
  // the row would promise a restore the client cannot perform. Until the
  // first listing answers, that is not yet known.
  const pastSharesAvailable = useSharedContainerReplicasStore(
    (state) =>
      state.removedStatus === 'success' || state.removedStatus === 'error',
  );
  const {
    scopingContext,
    viewableEntries,
    invitations,
    acceptedEntries,
    removedEntries,
    homeOf,
  } = useScopedSharedContainerEntries();
  const pastSharesCount = pastSharesAvailable
    ? acceptedEntries.length + removedEntries.length
    : 0;

  // The invitation whose dialog is open. A snapshot rather than an id: the
  // store drops a removed row optimistically, and the dialog has to stay up
  // (showing "Removing…") until the removal settles.
  const [dialogEntry, setDialogEntry] =
    useState<SharedContainerListEntry | null>(null);
  // Where focus lands when the dialog closes after its row is gone. The
  // section header button takes no ref, so it is looked up when a dialog
  // opens.
  const sectionToggleRef = useRef<HTMLElement | null>(null);

  const activeEntry = viewableEntries.find(
    (candidate) => candidate.container.id === activeContainerId,
  );
  const activeReplica = useSharedContainerReplicasStore(
    (state) => state.viewer?.replica ?? null,
  );
  const viewerLoading = useSharedContainerReplicasStore(
    (state) => state.viewer?.loading ?? false,
  );

  // Report the list as well as the open surface. Keeping this reporter in the
  // always-mounted sidebar means Advisor can discover a received share before
  // the recipient opens it, without exposing any replica content or paths.
  useCurrentUiStateReporter('sharedContainers.recipientSurface', {
    open: activeContainerId !== null,
    containerId: activeContainerId,
    organizationId: activeEntry?.organizationId ?? null,
    containerType:
      activeReplica?.containerType ??
      activeEntry?.container.containerType ??
      null,
    containerTitle: activeEntry?.container.title ?? null,
    status: viewerLoading ? 'loading' : (activeReplica?.status ?? null),
    blockedReason:
      activeReplica?.status === 'blocked' ? activeReplica.reason : null,
    withheldFileCount:
      activeReplica?.status === 'available' ||
      activeReplica?.status === 'pinned'
        ? (activeReplica.withheldFileCount ?? 0)
        : null,
    listedContainerCount: featureVisible ? viewableEntries.length : 0,
    pendingInvitationCount: featureVisible ? invitations.length : 0,
    pastSharesOpen: featureVisible && pastSharesOpen,
    removedShareCount:
      featureVisible && pastSharesAvailable ? removedEntries.length : 0,
    listedContainers: featureVisible
      ? viewableEntries.slice(0, 50).map((entry) => ({
          containerId: entry.container.id,
          organizationId: entry.organizationId ?? null,
          access: entry.access ?? 'organization',
          containerType: entry.container.containerType,
          title: entry.container.title,
        }))
      : [],
  });

  if (!featureVisible) return null;
  // Personal lists only the shares homed there (direct invitations and shares
  // accepted as direct), so it shows none of the section's failure states: a
  // listing failure or a reconnecting row would be about organization shares
  // the context deliberately hides (CAN-2954).
  // Removed shares keep the section, and with it the Past shares row, so
  // removing the only share does not also remove the way to restore it.
  // An open invitation dialog keeps it too: removing the only invitation
  // drops its row before the removal settles, and the dialog is mounted here.
  if (
    scopingContext?.kind === 'personal' &&
    viewableEntries.length === 0 &&
    pastSharesCount === 0 &&
    dialogEntry === null
  ) {
    return null;
  }

  // A transient server condition (the Cloud API's retryable 503, a gateway
  // 502/504, a 429) is a different thing from a genuine failure: the store
  // retries it on a backoff ladder, so the row reports that it is healing
  // instead of handing the user a button to press at a database blip.
  const unavailable = listStatus === 'unavailable';
  const listFailed = unavailable || listStatus === 'error';

  // Nothing shared with this user is not a state worth a permanent empty
  // section; the whole section stays absent until there is something in it.
  //
  // `!listFailed` is deliberate and must NOT be tightened to `=== 'success'`:
  // it is what keeps the section hidden for a brand-new member ('idle',
  // 'loading') and for an account whose organizations are all billing-lapsed
  // ('blocked-by-org-billing', CAN-2551). Only a failure the user can do
  // something about — a genuine one to retry, or a transient one that is
  // actively healing — earns a visible row.
  //
  // The `retrying` term is keyed on `listStatus !== 'loading'`, not on any one
  // terminal status. `retrying` exists to keep this row (and its own Retry
  // button) mounted across a click, but it resets one render pass AFTER the
  // status settles — so gating on `!retrying` alone flashes the section for a
  // frame in a state meant to render nothing. Every terminal outcome leaves
  // `'loading'`, so this covers `'success'` with zero rows (a retry that
  // succeeds after the last share was revoked) and `'blocked-by-org-billing'`
  // alike, plus the `!bridge` / no-organizations paths that set `'success'`
  // synchronously and never enter `'loading'` at all.
  //
  // The polarity is load-bearing: `=== 'loading'` would unmount the button
  // mid-click, which is the exact hazard `retrying` was introduced to prevent.
  if (
    viewableEntries.length === 0 &&
    pastSharesCount === 0 &&
    dialogEntry === null &&
    !listFailed &&
    (!retrying || listStatus !== 'loading')
  ) {
    return null;
  }

  return (
    <SidebarSection
      as="div"
      className="group/section mt-3 flex flex-col"
      data-testid="sidebar-section-shared-with-me"
      collapsed={!expanded}
      onCollapsedChange={(nextCollapsed): void =>
        onExpandedChange(!nextCollapsed)
      }
      headerButtonProps={{
        'data-testid': SECTION_TOGGLE_TEST_ID,
      }}
      headerClassName="group group/shared-containers"
      spacing="inset"
      header={
        // Label, chevron, count: the Projects header's order, with the count
        // in the sidebar's one counter cell at the header's right edge.
        <div className="flex h-8 min-w-0 flex-1 items-center gap-1 px-1 text-s font-normal">
          <span className="min-w-0 truncate fg-quaternary transition-colors group-hover/shared-containers:fg-secondary group-focus-within/shared-containers:fg-secondary">
            {SHARED_WITH_YOU_SECTION_LABEL}
          </span>
          <ChevronDownMediumIcon
            size="sm"
            data-testid="sidebar-shared-with-me-chevron"
            className={`shrink-0 fg-quaternary transition-[color,opacity] group-hover/shared-containers:fg-secondary group-hover/shared-containers:opacity-100 group-focus-within/shared-containers:fg-secondary group-focus-within/shared-containers:opacity-100 ${
              expanded ? 'opacity-0' : '-rotate-90 opacity-100'
            }`}
          />
          {invitations.length > 0 ? (
            // The header is the only place a newly arrived invitation can
            // announce itself. `sharedWithMeExpanded` is session-local state,
            // so a recipient who collapsed this section would otherwise see
            // nothing change when a share lands. The count is on the header
            // rather than the list for exactly that reason.
            <span
              data-testid="sidebar-shared-with-me-pending-count"
              // `status` so the count is announced when a share lands rather
              // than only on the next time the header is reached, which is the
              // same reason the count is here at all.
              role="status"
              aria-label={`${invitations.length} pending ${
                invitations.length === 1 ? 'invitation' : 'invitations'
              }`}
              className={SIDEBAR_ROW_TRAILING_CELL_CLASSNAME}
            >
              {invitations.length}
            </span>
          ) : null}
        </div>
      }
    >
      <SidebarList>
        {/* `listFailed || retrying`: the section can now be mounted with no
            listed share (it holds only the Past shares row), where a merely
            loading listing is not a failure to report. */}
        {listStatus !== 'success' &&
        (listFailed || retrying) &&
        (viewableEntries.length === 0 || unavailable) ? (
          <li
            data-testid={
              unavailable
                ? 'shared-container-list-unavailable'
                : 'shared-container-list-error'
            }
            className={`grid h-8 grid-cols-[minmax(0,1fr)_1.5rem] items-center gap-1.5 py-0 ${SIDEBAR_ROW_TEXT_INSET_CLASSNAME} pr-1 text-s fg-quaternary`}
          >
            <span
              data-testid="shared-container-list-message"
              className="min-w-0 truncate"
            >
              {retrying
                ? 'Loading shared containers\u2026'
                : unavailable
                  ? 'Reconnecting to shared containers\u2026'
                  : 'Could not load shared containers.'}
            </span>
            {unavailable ? (
              // No Retry button: the store is already retrying on a backoff
              // ladder, and a button next to copy that says it is reconnecting
              // reads as the reconnect not working.
              <span
                data-testid="shared-container-list-trailing"
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center"
              >
                <LoadingSpinner sizePx={12} />
              </span>
            ) : (
              <RailIconButton
                icon={RetryIcon}
                data-testid="shared-container-list-retry"
                aria-label="Try again"
                tooltipLabel="Try again"
                tone="secondary"
                hoverSurface
                disabled={retrying}
                onClick={(): void => {
                  setRetrying(true);
                  // `.catch` BEFORE `.finally`: `.finally` re-throws, so a bare
                  // `void load().finally(...)` turns any rejection into an
                  // unhandled renderer rejection AND leaves `retrying` latched
                  // true, permanently disabling this button. `loadSharedWithMe`
                  // handles its own per-org failures, so a rejection here means
                  // something structural (a missing bridge method) — the section
                  // still shows its error row, which stays retryable.
                  void loadSharedWithMe()
                    .catch(() => undefined)
                    .finally(() => setRetrying(false));
                }}
              />
            )}
          </li>
        ) : null}
        {invitations.map((entry) => (
          <li key={entry.container.id}>
            <SharedContainerInvitationRow
              entry={entry}
              onOpen={(): void => {
                sectionToggleRef.current = document.querySelector<HTMLElement>(
                  `[data-testid="${SECTION_TOGGLE_TEST_ID}"]`,
                );
                setDialogEntry(entry);
              }}
            />
          </li>
        ))}
        {acceptedEntries.map((entry) => (
          <li key={entry.container.id}>
            <SharedContainerAcceptedRow
              entry={entry}
              home={homeOf(entry)}
              active={activeContainerId === entry.container.id}
              onOpen={(): void => openAcceptedSharedContainer(entry)}
            />
          </li>
        ))}
        {pastSharesCount > 0 ? (
          <li>
            <SidebarOverviewNavLink
              label="Past shares"
              count={pastSharesCount}
              selected={pastSharesOpen}
              onOpen={openPastSharesSurface}
              testId="sidebar-shared-with-me-past-shares"
              size="row"
            />
          </li>
        ) : null}
      </SidebarList>
      {dialogEntry !== null && (
        <SharedContainerInvitationDialogHost
          entry={dialogEntry}
          // Still a pending invitation: not accepted, not removed, and not
          // revoked by its owner while the dialog was open.
          pending={invitations.some(
            (entry) => entry.container.id === dialogEntry.container.id,
          )}
          restoreFocusRef={sectionToggleRef}
          onClose={(): void => setDialogEntry(null)}
        />
      )}
    </SidebarSection>
  );
}

/**
 * The open invitation's dialog, wired to the store.
 *
 * Accepting clones the publisher's repositories onto this machine, so it runs
 * exactly what the row's Accept button ran. Removing needs no second
 * confirmation: nothing is on disk yet, and the share can be restored from
 * Past shares.
 */
function SharedContainerInvitationDialogHost({
  entry,
  pending,
  restoreFocusRef,
  onClose,
}: {
  entry: SharedContainerListEntry;
  pending: boolean;
  restoreFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}): JSX.Element {
  const containerId = entry.container.id;
  const accepting = useSharedContainerReplicasStore(
    (state) => state.acceptingId === containerId,
  );
  const acceptFailed = useSharedContainerReplicasStore(
    (state) => state.acceptFailedId === containerId,
  );
  const acceptContainer = useSharedContainerReplicasStore(
    (state) => state.acceptContainer,
  );
  const clearAcceptFailed = useSharedContainerReplicasStore(
    (state) => state.clearAcceptFailed,
  );
  const actions = useSharedContainerRecipientActions(
    containerId,
    entry.organizationId,
    entry.container.title,
  );
  const removing = actions.dismissing;

  // The invitation left the list: accepted, removed, or revoked by its owner.
  // A removal in flight has already dropped the row optimistically, and a
  // failed one puts it back, so the dialog waits for the removal to settle.
  useEffect(() => {
    if (!pending && !removing) onClose();
  }, [onClose, pending, removing]);

  // A failure belongs to the attempt this dialog showed, not to the next
  // time the invitation is opened.
  useEffect(() => clearAcceptFailed, [clearAcceptFailed]);

  return (
    <SharedContainerInvitationDialog
      title={entry.container.title}
      {...(entry.ownerName !== undefined ? { ownerName: entry.ownerName } : {})}
      {...(entry.container.organizationName
        ? { organizationName: entry.container.organizationName }
        : {})}
      kind={
        entry.container.containerType === 'CODE_WORKTREE' ? 'code' : 'cowork'
      }
      accepting={accepting}
      removing={removing}
      acceptFailed={acceptFailed}
      restoreFocusRef={restoreFocusRef}
      onAccept={(): void => {
        dismissPageLikeViewers();
        useNavigationStore.getState().navigate('main');
        void acceptContainer({
          containerId,
          containerType: entry.container.containerType,
          ...(entry.organizationId
            ? { organizationId: entry.organizationId }
            : {}),
          ...(entry.access ? { access: entry.access } : {}),
        });
      }}
      onRemove={(): void => {
        void actions.dismiss();
      }}
      onCancel={onClose}
    />
  );
}

/**
 * The secondary line under a share's title. A direct share names its owner's
 * organization too, since it arrived from outside the recipient's own
 * organization contexts.
 *
 * An accepted row passes its home context, and the line follows it instead of
 * the round's classification: a share homed in an organization reads as that
 * organization's share, and one homed in Personal names the owner's
 * organization when the row carries it. An invitation, and an accepted row no
 * context lists, pass no home and follow the listing.
 */
function sharedByLabel(
  entry: SharedContainerListEntry,
  acceptedHome: WorkspaceContext | null = null,
): JSX.Element | null {
  if (entry.ownerName === undefined) return null;
  const owner = <SharedOwnerName name={entry.ownerName} />;
  const sharedBy = <>Shared by {owner}</>;
  const organizationName = entry.container.organizationName;
  const fromOrganization = organizationName ? (
    <>
      From {owner}
      {' \u00B7 '}
      {organizationName}
    </>
  ) : null;
  if (acceptedHome?.kind === 'organization') return sharedBy;
  if (acceptedHome?.kind === 'personal' && entry.access !== 'direct') {
    return fromOrganization ?? sharedBy;
  }
  if (entry.access !== 'direct') return sharedBy;
  return fromOrganization ?? <>From {owner}</>;
}

/**
 * A share owner's name. It is a person's identity, so session replay records
 * a same-size box for it; the copy around it and organization names stay
 * recorded.
 */
function SharedOwnerName({ name }: { name: string }): JSX.Element {
  return <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{name}</span>;
}

/**
 * An invitation is not a link to the share. Opening a share clones the
 * publisher's repositories onto this machine, so the row opens the dialog
 * that asks, and accepting or removing happens there.
 */
function SharedContainerInvitationRow({
  entry,
  onOpen,
}: {
  entry: SharedContainerListEntry;
  onOpen: () => void;
}): JSX.Element {
  const ownerLabel = sharedByLabel(entry);

  return (
    <button
      type="button"
      aria-haspopup="dialog"
      data-testid={`shared-container-invitation-${entry.container.id}`}
      onClick={onOpen}
      // The standard row grid and the hover treatment the accepted row uses.
      // The leading slot carries the pending dot, so the title starts where a
      // worktree title does.
      className={`focus-ring flex w-full min-w-0 items-center ${SIDEBAR_ROW_GRID_CLASSNAME} rounded-row py-1 pr-1 text-left text-s fg-secondary hover:bg-subtle`}
    >
      <span
        aria-hidden="true"
        // Two-line row: the slot belongs to the title line.
        className={`${SIDEBAR_ROW_LEADING_SLOT_CLASSNAME} self-start`}
        data-testid={`shared-container-invitation-${entry.container.id}-leading-slot`}
      >
        <Dot
          tone="attention"
          data-testid={`shared-container-invitation-${entry.container.id}-pending`}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className="truncate"
          title={entry.container.title}
          data-testid={`shared-container-invitation-${entry.container.id}-title`}
        >
          {entry.container.title}
        </span>
        {ownerLabel !== null && (
          <span
            className="truncate text-xs fg-quaternary"
            data-testid={`shared-container-owner-${entry.container.id}`}
          >
            {ownerLabel}
          </span>
        )}
      </span>
      <span className="sr-only">Pending invitation</span>
    </button>
  );
}

/**
 * An accepted share, with the same hover-revealed action menu archived rows
 * use. Removing is the reclaim path for the local copy: replicas are retained
 * until dismissed or revoked, with no size cap or quota, so this is how a
 * recipient gets the disk space back.
 */
function SharedContainerAcceptedRow({
  entry,
  home,
  active,
  onOpen,
}: {
  entry: SharedContainerListEntry;
  /** The context that lists this share; `null` when no context does. */
  home: WorkspaceContext | null;
  active: boolean;
  onOpen: () => void;
}): JSX.Element {
  const ownerLabel = sharedByLabel(entry, home);
  return (
    <div
      className="group group/sidebar-item relative"
      // Sticky-selection scrolling keys on this mark; without it the sidebar
      // treats shared rows as unselectable, unlike every worktree row.
      data-sidebar-selected-item={active ? '' : undefined}
    >
      <button
        type="button"
        data-testid={`shared-container-row-${entry.container.id}`}
        aria-current={active}
        onClick={onOpen}
        // The standard row grid and the selected/hover treatment `WorktreeRow`
        // uses, so a shared container reads as one more selectable row. The
        // leading slot stays reserved, which puts the title on the worktree
        // title column; `pr-8` keeps room for the actions menu.
        className={`flex w-full min-w-0 items-center ${SIDEBAR_ROW_GRID_CLASSNAME} rounded-row py-1 pr-8 text-left text-s ${
          active ? 'bg-muted fg-primary' : 'fg-secondary hover:bg-subtle'
        }`}
      >
        <span
          aria-hidden="true"
          // Two-line row: the slot belongs to the title line.
          className={`${SIDEBAR_ROW_LEADING_SLOT_CLASSNAME} self-start`}
          data-testid={`shared-container-row-${entry.container.id}-leading-slot`}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className="truncate"
            title={entry.container.title}
            data-testid={`shared-container-row-${entry.container.id}-title`}
          >
            {entry.container.title}
          </span>
          {ownerLabel !== null && (
            <span
              className="truncate text-xs fg-quaternary"
              data-testid={`shared-container-owner-${entry.container.id}`}
            >
              {ownerLabel}
            </span>
          )}
        </span>
        {/* Read-only state the recipient reads, not a control: a quiet Badge. */}
        <Badge data-testid="shared-container-read-only-badge">View only</Badge>
      </button>
      <div className="absolute right-1 top-1/2 -translate-y-1/2">
        <SharedContainerRecipientActionsMenu entry={entry} />
      </div>
    </div>
  );
}
