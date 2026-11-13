/**
 * Shared-container recipient store (CAN-2550).
 *
 * The recipient-side mirror of `archivedContainersStore`: a read-only cache
 * over the `window.api.sharedContainers` recipient bridge. It never touches
 * the replica cache on disk and never re-implements the main-process access
 * gate — every listing, open, retry, and content read goes through the typed
 * transport surface.
 *
 * Three responsibilities:
 *
 * 1. **Listing.** `listSharedWithMe` is per-organization, so the sidebar
 *    section fans out across every organization the account store hydrated
 *    and merges the results into one ordered list.
 * 2. **Viewer state.** One container is open at a time. Opening runs the
 *    access gate (`open`), which is also what materializes the replica; the
 *    resulting {@link SharedContainerReplicaState} drives every rendered
 *    state (blocked / nothing-published / available / pinned).
 * Content is deliberately not mirrored here. The standard chat, workspace
 * item, plans, files and activity stores own the viewer scope exactly as they
 * do a local workspace; this store owns replica lifecycle only.
 *
 * `pinned` is rendered as a defensive alias of `available` (see CAN-2550:
 * `manager.pin()` has no non-test caller yet, so the state is currently
 * unreachable rather than meaningful).
 */
import { create } from 'zustand';
import { isOrgTeamsLapsed } from '@canopy/desktop-shared/lib/org-billing-state-parsing';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import type {
  SharedContainerAcceptedIdentity,
  SharedContainerAccess,
  SharedContainerInboxChangedEvent,
  SharedContainerReplicaBroadcast,
  SharedContainerReplicaState,
  SharedContainerSyncPhase,
  SharedContainerSyncPhaseEvent,
} from '@canopy/desktop-shared/types';
import type {
  DismissedSharedContainerSummary,
  SharedContainerSummary,
  SharedContainerType,
} from '@canopy/protocol/shared-containers';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { useSharedContainersStore } from '@/stores/sharedContainersStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';

/**
 * Reserved app-managed workspace id used to key panel layout and other
 * worktree-scoped view state for the recipient surface. The container id
 * occupies the `worktreeId` slot, mirroring how App Advisor keys its own
 * surface. Sealed replica content stays under
 * `shared-containers/{containerId}/revisions/{revisionId}/`, so purging a
 * revision never rewrites view state.
 *
 * Re-exported from the shared constant rather than re-declared as a literal:
 * main's `isAppManagedChatWorkspaceId` gate keys on the same value to route
 * this id to `app-workspaces/`, and the two must not be able to drift.
 */
export const SHARED_CONTAINER_VIEWER_WORKSPACE_ID =
  SHARED_CONTAINER_VIEWER_PROJECT_ID;

/**
 * Drops the renderer's copy of a viewer's panel layout, so the next open
 * loads the layout from disk. Main resets that file to the publisher's layout
 * on open, and a layout still held in memory would be shown instead and then
 * saved back over it.
 *
 * The pending save is committed first, so a share that ships no layout keeps
 * the recipient's arrangement across visits. The returned promise settles
 * once that save has reached main; the open and close requests wait on it so
 * the save cannot land after main's reset. The sweep history is forgotten so
 * the reopened viewer keeps the selection its restored layout carries.
 *
 * The panel modules are imported on demand: they reach back into the stores
 * that import this one, and a static import closes that cycle.
 */
async function releaseViewerPanelLayout(containerId: string): Promise<void> {
  const viewerKey = makeWorktreePanelKey(
    SHARED_CONTAINER_VIEWER_WORKSPACE_ID,
    containerId,
  );
  const [bridge, sync, browser] = await Promise.all([
    import('@/lib/panels/persistence-bridge'),
    import('@/lib/panels/chat-panel-sync'),
    import('@/stores/browserStore'),
  ]);
  // The save snapshots the live layout before it is dropped below.
  const flushed = bridge
    .flushPanelLayoutSaveForWorktree(viewerKey)
    .catch(() => undefined);
  usePanelLayoutStore.getState().disposeLayout(viewerKey);
  bridge.disposeWorktreePanelHydration(viewerKey);
  sync.forgetChatPanelSyncWorktree(viewerKey);
  // Browser sessions kept in memory would be rebound into the layout main
  // resets to, so the next mount hydrates them from disk again.
  browser.useBrowserStore
    .getState()
    .forgetWorktree(SHARED_CONTAINER_VIEWER_WORKSPACE_ID, containerId);
  await flushed;
}

/**
 * Stable empty list for selectors. Never allocate `[]` inside a
 * Zustand/useShallow selector — a fresh array each snapshot loops
 * `useSyncExternalStore` (React #185) and blank-pages the app.
 */
export const EMPTY_SHARED_CONTAINERS: readonly SharedContainerSummary[] =
  Object.freeze<SharedContainerSummary[]>([]);

/** A listing row plus the organization it was listed under. */
export interface SharedContainerListEntry {
  /**
   * Organization the row was listed under. For a direct share it is the
   * container's owning organization, and absent for a personal container.
   */
  organizationId?: string;
  /**
   * `direct`: shared with this account by email or from outside its
   * organizations, listed by the organization-free direct listing. Absent
   * means `organization`.
   */
  access?: SharedContainerAccess;
  container: SharedContainerSummary;
  /** Display name of the owner, resolved lazily from the members directory. */
  ownerName?: string;
}

/** A share this recipient removed and may still restore (CAN-4052). */
export interface SharedContainerRemovedEntry extends SharedContainerListEntry {
  /** ISO time of the removal. */
  dismissedAt: string;
}

/**
 * Stable empty list for selectors that narrow the removed entries, for the
 * same reason as {@link EMPTY_SHARED_CONTAINERS}.
 */
export const EMPTY_REMOVED_SHARED_CONTAINERS: readonly SharedContainerRemovedEntry[] =
  Object.freeze<SharedContainerRemovedEntry[]>([]);

/** Removed shares requested per page while draining the listing. */
export const SHARED_CONTAINER_REMOVED_PAGE_LIMIT = 100;
/**
 * Removed shares kept in the store. The sidebar count reads the loaded
 * entries, so the listing is drained to here rather than paged on demand.
 */
export const SHARED_CONTAINER_REMOVED_ENTRY_CAP = 500;

export type SharedContainerRestoreOutcome =
  | 'restored'
  /** The owner revoked the removed share, or it is no longer shared. */
  | 'not-restorable'
  /** The connected server predates recoverable removal. */
  | 'unsupported'
  | 'failed'
  | 'in-flight';

/**
 * Result of listing one organization in the "shared with me" fan-out
 * (CAN-2551).
 *
 * Refusals are distinct from both a rejection and an empty `'listed'` result.
 * Billing is benign and non-retryable. Unavailability is retryable and carries
 * the server delay that survived the main-to-renderer IPC boundary.
 */
type OrgListingOutcome =
  | { status: 'listed'; entries: SharedContainerListEntry[] }
  | { status: 'refused' }
  | { status: 'unavailable'; retryAfterMs?: number };

export interface SharedContainerViewerState {
  containerId: string;
  /** Absent for a personal container shared directly. */
  organizationId?: string;
  /** Preserves the server authorization path across open and retry. */
  access?: SharedContainerAccess;
  /**
   * Identifies this viewer mount to main. Minted by `openContainer`, reused by
   * retry, and sent with the close, so main can ignore a close from an earlier
   * visit that lands after a newer open of the same share (CAN-3559).
   */
  viewerSessionId?: string;
  /** Null until the access gate resolves; drives the loading state. */
  replica: SharedContainerReplicaState | null;
  /** Set when `open` itself rejected (transport failure, not an access block). */
  openError: string | null;
  loading: boolean;
  /**
   * Coarse progress of the in-flight open, so a multi-second checkout reads as
   * work rather than a hang (CAN-2551). Internal ids only — render them
   * through `SHARED_CONTAINER_SYNC_PHASE_LABELS`, never directly.
   */
  syncPhase?: SharedContainerSyncPhase;
}

export interface SharedContainerReplicasState {
  /** Listing rows across every hydrated organization, most recent first. */
  entries: SharedContainerListEntry[];
  /**
   * `'blocked-by-org-billing'` is a BENIGN terminal outcome, not a failure
   * (CAN-2551): every organization that could have been listed has lost the
   * Teams entitlement, so there is nothing to show and nothing to retry.
   *
   * `'unavailable'` is a TRANSIENT outcome: every rejection in the fan-out was
   * a retryable server or network failure (a 503 from the Cloud API's
   * `database_unavailable` envelope, a gateway 502/504, a 429). The section
   * says so and heals itself on a backoff timer, because asking the user to
   * click Retry against a database blip is asking them to do the computer's
   * job.
   *
   * `'error'` is reserved for genuine failures, which are the only ones that
   * earn a manual Retry affordance and a renderer diagnostic. A MIXED result
   * lands on `'error'` on purpose — one org refused for billing plus one real
   * failure, or one transient plus one real failure — because a real failure
   * is present and must stay explicitly retryable.
   */
  listStatus:
    | 'idle'
    | 'loading'
    | 'success'
    | 'error'
    | 'unavailable'
    | 'blocked-by-org-billing';
  /** Container ids the recipient dismissed this session; hidden immediately. */
  dismissedIds: string[];
  /**
   * Container ids this device has accepted. Everything else is an invitation:
   * listed and titled, but never opened, because opening is what clones the
   * publisher's repositories onto this machine.
   */
  acceptedIds: string[];
  /**
   * The identity each accepted container was accepted under, keyed like
   * `acceptedIds`. It decides which workspace context lists the share (see
   * `sharedContainerHomeContext`); the access path sent to main still comes
   * from the listing. Empty when main's response carries no records.
   *
   * Select this object itself. Building a fresh one inside a selector loops
   * `useSyncExternalStore`, as `EMPTY_SHARED_CONTAINERS` explains.
   */
  acceptedRecords: Record<string, SharedContainerAcceptedIdentity>;
  acceptedStatus: 'idle' | 'loading' | 'success' | 'error';
  /** Container id whose accept is in flight, so its row can show progress. */
  acceptingId: string | null;
  /**
   * Container id whose last accept failed. The invitation dialog stays open
   * on it and says so; the next accept, or closing the dialog, clears it.
   */
  acceptFailedId: string | null;
  /**
   * Shares this recipient removed and may still restore, most recently
   * removed first. Drained across pages up to
   * {@link SHARED_CONTAINER_REMOVED_ENTRY_CAP}, so the sidebar count is the
   * loaded count.
   */
  removedEntries: SharedContainerRemovedEntry[];
  /**
   * `'unsupported'`: the connected server cannot list or restore removed
   * shares. The surface then keeps the irreversible-remove copy and shows no
   * Past shares row, since it must never promise a restore it cannot perform.
   */
  removedStatus: 'idle' | 'loading' | 'success' | 'error' | 'unsupported';
  /** Container ids whose restore is in flight. */
  restoringIds: string[];
  /** The Past shares page is open. */
  pastSharesOpen: boolean;
  viewer: SharedContainerViewerState | null;

  /**
   * `background: true` marks a refresh the user did not ask for (the inbox
   * accelerator/heartbeat). See the suppression rules at the terminal `set`:
   * a background failure must never be the reason an otherwise-absent section
   * materializes as an error row.
   */
  loadSharedWithMe: (options?: { background?: boolean }) => Promise<void>;
  loadAccepted: () => Promise<void>;
  /** Records consent, then opens the container it authorized. */
  acceptContainer: (entry: {
    containerId: string;
    organizationId?: string;
    access?: SharedContainerAccess;
    /** The listing's type, an analytics hint only; never authorization. */
    containerType?: SharedContainerType;
    /** Rechecked after consent, before materializing the viewer. */
    shouldOpen?: () => boolean;
  }) => Promise<void>;
  openContainer: (entry: {
    containerId: string;
    organizationId?: string;
    access?: SharedContainerAccess;
  }) => Promise<void>;
  closeViewer: () => void;
  retryContainer: () => Promise<void>;
  /** Resolves `true` only when the server revoked the grant. */
  dismissContainer: (
    containerId: string,
    organizationId: string | undefined,
  ) => Promise<boolean>;
  /** Lists the shares this recipient removed. Never rejects. */
  loadRemoved: () => Promise<void>;
  /** Returns a removed share to the inbox as a pending invitation. */
  restoreContainer: (
    containerId: string,
  ) => Promise<SharedContainerRestoreOutcome>;
  clearAcceptFailed: () => void;
  openPastShares: () => void;
  closePastShares: () => void;
  applyReplicaState: (event: SharedContainerReplicaBroadcast) => void;
  subscribeToReplicaChanges: () => () => void;
  applySyncPhase: (event: SharedContainerSyncPhaseEvent) => void;
  subscribeToSyncPhases: () => () => void;
  /** Main → renderer signal that the account-wide recipient inbox moved. */
  subscribeToInboxChanges: (
    onSignal: (event: SharedContainerInboxChangedEvent) => void,
  ) => () => void;
  reset: () => void;
}

/** The revision a mounted viewer reads content from, or null when unavailable. */
export function viewerRevisionId(
  viewer: SharedContainerViewerState | null,
): string | null {
  const replica = viewer?.replica;
  if (
    replica === null ||
    replica === undefined ||
    (replica.status !== 'available' && replica.status !== 'pinned')
  ) {
    return null;
  }
  return replica.revisionId;
}

/** `pinned` renders exactly like `available` until pinning is reachable. */
export function isReadableReplica(
  replica: SharedContainerReplicaState | null,
): boolean {
  return replica?.status === 'available' || replica?.status === 'pinned';
}

/**
 * Backoff ladder for the self-healing retry armed by `'unavailable'`.
 *
 * The last entry is the steady-state interval: a genuinely long outage polls
 * every 30s rather than growing unboundedly, so the section recovers within
 * one interval of the server coming back.
 */
export const SHARED_CONTAINER_UNAVAILABLE_RETRY_DELAYS_MS: readonly number[] = [
  2_000, 5_000, 15_000, 30_000,
];

/** HTTP statuses that mean "come back shortly", not "this failed". */
const TRANSIENT_HTTP_STATUSES = new Set<number>([429, 502, 503, 504]);

function transientStatusFromMessage(message: string): number | null {
  // `CanopyCloudClientError` builds its message as `HTTP ${status}: ${message}`
  // whenever a status is present, and Electron's `ipcRenderer.invoke` rejection
  // preserves that message verbatim inside its own wrapper prose. The status is
  // therefore structural, unlike the trailing text, which is server-authored
  // and free to be reworded.
  const match = /\bHTTP (\d{3})\b/.exec(message);
  if (!match?.[1]) return null;
  const status = Number.parseInt(match[1], 10);
  return Number.isFinite(status) ? status : null;
}

/**
 * Whether a fan-out rejection is a transient server condition rather than a
 * genuine failure.
 *
 * Main converts exhausted HTTP and network failures to the typed
 * `temporarily-unavailable` response before IPC. This message parser remains as
 * compatibility for an older main process or an unexpected raw rejection.
 */
function isTransientCloudListingFailure(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null) return false;
  // Forward-compatible with a future main-process change that forwards the
  // status structurally; today this only matches in unit tests.
  if ('status' in reason) {
    const status: unknown = reason.status;
    if (typeof status === 'number' && Number.isFinite(status)) {
      return TRANSIENT_HTTP_STATUSES.has(status);
    }
  }
  if (!(reason instanceof Error)) return false;
  const status = transientStatusFromMessage(reason.message);
  return status !== null && TRANSIENT_HTTP_STATUSES.has(status);
}

let unavailableRetryTimer: ReturnType<typeof setTimeout> | null = null;
let unavailableRetryAttempt = 0;

function clearUnavailableRetryTimer(): void {
  if (unavailableRetryTimer !== null) {
    clearTimeout(unavailableRetryTimer);
    unavailableRetryTimer = null;
  }
}

/**
 * Drop both the armed timer and the backoff position.
 *
 * Called on every terminal outcome that is NOT `'unavailable'`, so a blip
 * followed by a recovery starts the next ladder from the top instead of
 * inheriting a 30s wait from an unrelated earlier outage.
 */
function resetUnavailableRetry(): void {
  clearUnavailableRetryTimer();
  unavailableRetryAttempt = 0;
}

function scheduleUnavailableRetry(
  load: () => Promise<void>,
  retryAfterMs?: number,
): void {
  clearUnavailableRetryTimer();
  const index = Math.min(
    unavailableRetryAttempt,
    SHARED_CONTAINER_UNAVAILABLE_RETRY_DELAYS_MS.length - 1,
  );
  const ladderDelayMs =
    SHARED_CONTAINER_UNAVAILABLE_RETRY_DELAYS_MS[index] ?? 30_000;
  const delayMs =
    retryAfterMs === undefined
      ? ladderDelayMs
      : Math.max(ladderDelayMs, Math.min(Math.max(0, retryAfterMs), 60_000));
  unavailableRetryAttempt += 1;
  unavailableRetryTimer = setTimeout(() => {
    unavailableRetryTimer = null;
    // `loadSharedWithMe` owns its own per-org failures and arms the next rung
    // itself, so a rejection here is structural (a missing bridge method) and
    // must not become an unhandled renderer rejection.
    void load().catch(() => undefined);
  }, delayMs);
}

let listEpoch = 0;
let activeListLoadCount = 0;
let backgroundListLoadQueued = false;
let queuedBackgroundListLoad: Promise<void> | null = null;
let resolveQueuedBackgroundListLoad: (() => void) | null = null;
let viewerRequestEpoch = 0;
let removedEpoch = 0;
let recipientViewerClose = Promise.resolve();

function cancelQueuedSharedContainerListLoad(): void {
  backgroundListLoadQueued = false;
  const resolveQueued = resolveQueuedBackgroundListLoad;
  queuedBackgroundListLoad = null;
  resolveQueuedBackgroundListLoad = null;
  resolveQueued?.();
}

function finishSharedContainerListLoad(
  runQueuedBackground: () => Promise<void>,
): void {
  activeListLoadCount -= 1;
  if (activeListLoadCount !== 0 || !backgroundListLoadQueued) return;
  backgroundListLoadQueued = false;
  const resolveQueued = resolveQueuedBackgroundListLoad;
  queuedBackgroundListLoad = null;
  resolveQueuedBackgroundListLoad = null;
  void runQueuedBackground()
    .catch(() => undefined)
    .finally(() => resolveQueued?.());
}

/**
 * Resolved share-owner display names, keyed `${organizationId}:${ownerUserId}`.
 *
 * `loadSharedWithMe` issues one `searchMembers` call per unique owner per org
 * per listing. That is fine once at boot; at the inbox heartbeat's cadence it
 * is a standing multiplier on a value that effectively never changes. Caching
 * also stops the owner name from momentarily disappearing from a row when a
 * member search fails, since that path falls back to `[]`.
 *
 * Cleared by `reset()` alongside the transcript cache, so an account or
 * organization change cannot carry a name across.
 */
const ownerNameCache = new Map<string, string>();

function ownerNameCacheKey(
  organizationId: string,
  ownerUserId: string,
): string {
  return `${organizationId}:${ownerUserId}`;
}

function clearOwnerNameCache(): void {
  ownerNameCache.clear();
}

type SharedContainerReplicasData = Omit<
  SharedContainerReplicasState,
  | 'loadSharedWithMe'
  | 'loadAccepted'
  | 'acceptContainer'
  | 'openContainer'
  | 'closeViewer'
  | 'retryContainer'
  | 'dismissContainer'
  | 'loadRemoved'
  | 'restoreContainer'
  | 'clearAcceptFailed'
  | 'openPastShares'
  | 'closePastShares'
  | 'applyReplicaState'
  | 'subscribeToReplicaChanges'
  | 'applySyncPhase'
  | 'subscribeToSyncPhases'
  | 'subscribeToInboxChanges'
  | 'reset'
>;

const initialState: SharedContainerReplicasData = {
  entries: [],
  listStatus: 'idle',
  dismissedIds: [],
  acceptedIds: [],
  acceptedRecords: {},
  acceptedStatus: 'idle',
  acceptingId: null,
  acceptFailedId: null,
  removedEntries: [],
  removedStatus: 'idle',
  restoringIds: [],
  pastSharesOpen: false,
  viewer: null,
};

function toRemovedEntry(
  container: DismissedSharedContainerSummary,
  listingOrganizationId: string | undefined,
): SharedContainerRemovedEntry {
  const organizationId = listingOrganizationId ?? container.organizationId;
  const ownerName = container.owner?.name;
  return {
    ...(organizationId ? { organizationId } : {}),
    ...(listingOrganizationId ? {} : { access: 'direct' as const }),
    container,
    ...(ownerName ? { ownerName } : {}),
    dismissedAt: container.dismissedAt,
  };
}

function sortRemovedEntries(
  entries: SharedContainerRemovedEntry[],
): SharedContainerRemovedEntry[] {
  return entries.sort((left, right) =>
    right.dismissedAt.localeCompare(left.dismissedAt),
  );
}

/** The records without one container's; the same object when it has none. */
function withoutAcceptedRecord(
  records: Record<string, SharedContainerAcceptedIdentity>,
  containerId: string,
): Record<string, SharedContainerAcceptedIdentity> {
  if (!(containerId in records)) return records;
  return Object.fromEntries(
    Object.entries(records).filter(([id]) => id !== containerId),
  );
}

export const useSharedContainerReplicasStore =
  create<SharedContainerReplicasState>((set, get) => ({
    ...initialState,

    loadSharedWithMe: async (options): Promise<void> => {
      const background = options?.background === true;
      if (background && activeListLoadCount > 0) {
        // One queued rerun covers every signal because a listing reads current
        // server state. Foreground loads remain free to supersede older loads:
        // an org-loss refresh must still invalidate a stale fan-out at once.
        backgroundListLoadQueued = true;
        if (!queuedBackgroundListLoad) {
          queuedBackgroundListLoad = new Promise<void>((resolve) => {
            resolveQueuedBackgroundListLoad = resolve;
          });
        }
        await queuedBackgroundListLoad;
        return;
      }
      activeListLoadCount += 1;
      // Captured before the `'loading'` set below, so the suppression rule can
      // tell "the section was already showing a failure" (keep showing it)
      // from "the section was absent" (stay absent).
      const statusBeforeLoad = get().listStatus;
      // Bump the epoch BEFORE any early return. Every branch below sets
      // terminal state, and an in-flight fan-out started at an older epoch
      // must not be allowed to overwrite it: an account refresh that empties
      // `organizations` could otherwise be undone by a load that started while
      // the user was still entitled, restoring rows for orgs they no longer
      // belong to.
      listEpoch += 1;
      const epoch = listEpoch;
      // A load in flight supersedes any armed self-heal. The backoff POSITION
      // is deliberately not reset here: only a terminal non-`'unavailable'`
      // outcome earns a fresh ladder, so a manual Retry during an outage cannot
      // be used to reset the interval back to 2s over and over.
      clearUnavailableRetryTimer();
      const bridge = window.api?.sharedContainers;
      if (!bridge) {
        resetUnavailableRetry();
        set({ listStatus: 'success', entries: [] });
        finishSharedContainerListLoad(() =>
          get().loadSharedWithMe({ background: true }),
        );
        return;
      }
      const accountState = useSharedContainersStore.getState();
      const organizations = accountState.organizations;
      // Direct shares (by email, or from outside this account's
      // organizations) are organization-independent: one extra listing with
      // no organization id, run even for an account with no organization.
      const reconcileDirect = accountState.accountKind === 'connected';
      const showDirect =
        reconcileDirect &&
        useFeatureFlagsStore
          .getState()
          .isEnabled(
            CLIENT_FEATURE_FLAGS.canopySharedContainerExternalSharing.key,
          );
      const listings: Array<{ organizationId?: string }> = [
        ...organizations.map((organization) => ({
          organizationId: organization.id,
        })),
        ...(reconcileDirect ? [{}] : []),
      ];
      if (listings.length === 0) {
        resetUnavailableRetry();
        set({ listStatus: 'success', entries: [] });
        finishSharedContainerListLoad(() =>
          get().loadSharedWithMe({ background: true }),
        );
        return;
      }
      // CAN-2551. Every organization is queried, including ones this renderer
      // believes are billing-lapsed. Filtering them out here looks like a free
      // optimization — skip a round-trip the server will refuse anyway — but it
      // silently drops the replica purge: a lapsed org's 403 is what drives
      // `ReconciliationService.listSharedWithMe`'s `isValidatedAccessLoss`
      // branch into `reconcileContainerSnapshot(org, [])`, which purges every
      // decrypted replica for that org. Skipping the call leaves that plaintext
      // on disk indefinitely, and makes the on-disk outcome depend on whether
      // the local snapshot happened to be stale (call made, replicas purged) or
      // fresh (call skipped, replicas retained).
      //
      // So the server stays the single source of truth: main converts the 403
      // into a typed `refusal` AFTER the purge has run, and the refusal is
      // aggregated below into `blocked-by-org-billing`. Correctness over one
      // saved request.
      // An automatic retry during an outage must NOT flip the section back to
      // `'loading'`. The sidebar's "nothing to show" guard treats `'loading'`
      // with no rows as nothing to render, so every backoff tick would unmount
      // the reconnecting row, flash "Could not load shared containers." with a
      // Retry button, and unmount again — the exact churn this state exists to
      // replace. Staying `'unavailable'` until a terminal outcome keeps the row
      // still while it heals.
      //
      // A background refresh does not announce itself at all. Flipping to
      // `'loading'` here would move the section's visible state on every
      // heartbeat tick (and, when the terminal outcome is suppressed below,
      // strand it at `'loading'` — neither the status it had nor a status any
      // consumer can act on, since `navigationHistoryStore` prunes on
      // `=== 'success'`). An unattended refresh either produces a terminal
      // outcome worth showing or leaves the section exactly as it found it.
      if (!background) {
        set({
          listStatus:
            get().listStatus === 'unavailable' ? 'unavailable' : 'loading',
        });
      }
      // Multi-org fan-out: one org failing must not blank the whole section.
      const results = await Promise.allSettled(
        listings.map(async (listing): Promise<OrgListingOutcome> => {
          const listingOrganizationId = listing.organizationId;
          const containers: SharedContainerSummary[] = [];
          const seenCursors = new Set<string>();
          let cursor: string | undefined;
          do {
            const response = await bridge.listSharedWithMe({
              ...(listingOrganizationId
                ? { organizationId: listingOrganizationId }
                : {}),
              ...(cursor ? { cursor } : {}),
            });
            // A stale local account snapshot can still name an org the server
            // considers lapsed, so main converts that 403 into a typed
            // refusal. Bail out of the cursor loop and the owner lookups: this
            // org contributes no rows and is not a failure.
            if (response.refusal === 'temporarily-unavailable') {
              return {
                status: 'unavailable',
                ...(response.retryAfterMs !== undefined
                  ? { retryAfterMs: response.retryAfterMs }
                  : {}),
              };
            }
            if (response.refusal === 'blocked-by-org-billing') {
              return { status: 'refused' };
            }
            containers.push(...response.containers);
            if (response.nextCursor === null) {
              cursor = undefined;
            } else {
              if (seenCursors.has(response.nextCursor)) {
                throw new Error('Shared-container listing cursor repeated');
              }
              seenCursors.add(response.nextCursor);
              cursor = response.nextCursor;
            }
          } while (cursor !== undefined);
          // The listing carries the owner's display name. The members lookup
          // stays only as a fallback for an organization listing whose row
          // came back without one; a direct share's owner may not be in any
          // organization this account can search.
          const ownerIds = listingOrganizationId
            ? Array.from(
                new Set(
                  containers
                    .filter((container) => !container.owner?.name)
                    .map((container) => container.ownerUserId),
                ),
              )
            : [];
          // Only owners whose name is not already cached cost a round-trip.
          const uncachedOwnerIds = ownerIds.filter(
            (ownerUserId) =>
              !ownerNameCache.has(
                ownerNameCacheKey(listingOrganizationId ?? '', ownerUserId),
              ),
          );
          const members = (
            await Promise.all(
              uncachedOwnerIds.map((ownerUserId) =>
                bridge
                  .searchMembers({
                    organizationId: listingOrganizationId ?? '',
                    query: ownerUserId,
                    limit: 1,
                  })
                  .then((response) =>
                    response.members.filter(
                      (member) => member.userId === ownerUserId,
                    ),
                  )
                  .catch(() => []),
              ),
            )
          ).flat();
          for (const member of members) {
            ownerNameCache.set(
              ownerNameCacheKey(listingOrganizationId ?? '', member.userId),
              member.name,
            );
          }
          const nameForOwner = (
            container: SharedContainerSummary,
          ): string | undefined =>
            container.owner?.name ||
            ownerNameCache.get(
              ownerNameCacheKey(
                listingOrganizationId ?? '',
                container.ownerUserId,
              ),
            );
          return {
            status: 'listed',
            entries:
              listingOrganizationId || showDirect
                ? containers.map((container): SharedContainerListEntry => {
                    const ownerName = nameForOwner(container);
                    const organizationId =
                      listingOrganizationId ?? container.organizationId;
                    return {
                      ...(organizationId ? { organizationId } : {}),
                      ...(listingOrganizationId
                        ? {}
                        : { access: 'direct' as const }),
                      container,
                      ...(ownerName ? { ownerName } : {}),
                    };
                  })
                : [],
          };
        }),
      );
      if (listEpoch !== epoch) {
        finishSharedContainerListLoad(() =>
          get().loadSharedWithMe({ background: true }),
        );
        return;
      }
      // A dismiss the server has not caught up with must not resurrect the row
      // on the next listing: the recipient already made that decision, and
      // re-offering it reads as the dismiss not having worked. A dismiss that
      // *failed* clears its own id first, so this only ever hides a revoke the
      // server accepted (CAN-2551).
      const dismissed = new Set(get().dismissedIds);
      // One row per container: an organization listing wins over the direct
      // listing (it is listed first), so a container reachable both ways
      // keeps its organization context.
      const listedIds = new Set<string>();
      const entries = results
        .flatMap((result) =>
          result.status === 'fulfilled' && result.value.status === 'listed'
            ? result.value.entries
            : [],
        )
        .filter((entry) => {
          if (dismissed.has(entry.container.id)) return false;
          if (listedIds.has(entry.container.id)) return false;
          listedIds.add(entry.container.id);
          return true;
        });
      // `PromiseRejectedResult.reason` is typed `any`; funnel it through a
      // single `unknown` narrowing here rather than at each use.
      const rejectedReasons: unknown[] = [];
      for (const result of results) {
        if (result.status === 'rejected') {
          const reason: unknown = result.reason;
          rejectedReasons.push(reason);
        }
      }
      const listedCount = results.filter(
        (result) =>
          result.status === 'fulfilled' && result.value.status === 'listed',
      ).length;
      const unavailableOutcomes = results.flatMap((result) =>
        result.status === 'fulfilled' && result.value.status === 'unavailable'
          ? [result.value]
          : [],
      );
      entries.sort((left, right) =>
        right.container.updatedAt.localeCompare(left.container.updatedAt),
      );
      const onlyTransientRejections =
        rejectedReasons.length > 0 &&
        rejectedReasons.every(isTransientCloudListingFailure);
      const hasTransientOutcome =
        unavailableOutcomes.length > 0 ||
        rejectedReasons.some(isTransientCloudListingFailure);
      const hasGenuineRejection = rejectedReasons.some(
        (reason) => !isTransientCloudListingFailure(reason),
      );
      const listStatus: SharedContainerReplicasState['listStatus'] =
        hasTransientOutcome && hasGenuineRejection
          ? 'error'
          : listedCount > 0
            ? hasTransientOutcome
              ? // Keep rows from healthy orgs visible, but keep polling until the
                // transiently unavailable orgs have also been listed.
                'unavailable'
              : // Preserve the existing partial-success behavior when another
                // organization has a genuine failure.
                'success'
            : rejectedReasons.length > 0
              ? onlyTransientRejections
                ? // Nothing but retryable server conditions. Say "temporarily
                  // unavailable" and heal on the backoff ladder below.
                  'unavailable'
                : // At least one genuine transport failure is present. A mixed
                  // billing-refusal + failure result, and a mixed transient +
                  // genuine one, both land here on purpose: the real failure must
                  // stay retryable.
                  'error'
              : unavailableOutcomes.length > 0
                ? 'unavailable'
                : // Every attempted org came back as a benign refusal.
                  'blocked-by-org-billing';
      // The anti-flicker contract for unattended refreshes.
      //
      // Before the inbox accelerator, a failing listing was only reachable at
      // boot or on an organization change — both moments the user initiated.
      // A heartbeat makes it reachable at any instant, so a recipient who has
      // never been sent a share would watch the section materialize out of
      // nothing with "Could not load shared containers." and a Retry button on
      // any transient network hiccup: the sidebar's guard treats a failed
      // status as sufficient reason to render.
      //
      // So a background failure that produces no rows, on a section that was
      // not already showing a failure, leaves both the current entries and
      // `listStatus` exactly as they were. An absent section stays absent, and
      // a section with visible shares does not lose them to transient network
      // weather. A foreground load — boot, an organization change, the Retry
      // button — is unchanged, and a section already showing an error keeps
      // showing it rather than silently going quiet.
      const suppressBackgroundFailure =
        background &&
        (listStatus === 'error' || listStatus === 'unavailable') &&
        entries.length === 0 &&
        statusBeforeLoad !== 'error' &&
        statusBeforeLoad !== 'unavailable';
      if (listStatus === 'unavailable') {
        const retryAfterMs = unavailableOutcomes.reduce<number | undefined>(
          (largest, outcome) =>
            outcome.retryAfterMs === undefined
              ? largest
              : Math.max(largest ?? 0, outcome.retryAfterMs),
          undefined,
        );
        // The ladder inherits the initiating load's disposition. A foreground
        // load keeps its visible "Reconnecting…" row and heals in view; a
        // background one keeps healing silently, since every rung of a ladder
        // armed by a heartbeat is just as unattended as the tick that armed
        // it — a foreground rung would paint the very error row suppressed
        // one line above.
        scheduleUnavailableRetry(
          () =>
            get().loadSharedWithMe(
              background ? { background: true } : undefined,
            ),
          retryAfterMs,
        );
      } else {
        resetUnavailableRetry();
      }
      if (listStatus === 'error' && !suppressBackgroundFailure) {
        // Only genuine transport failures are worth a diagnostic; main already
        // records `shared_container_listing_blocked` once per refused org.
        // No organization names or ids — this lands in global app-events.
        const firstReason = rejectedReasons[0];
        // Deliberately NOT `error.message`: a `CanopyCloudClientError` message
        // is the server's free-form `error` prose, which the server is free to
        // reword and which can embed organization names. This lands in global
        // app-events, so only the error's classification is forwarded. The
        // concrete error class does not survive IPC serialization, so `name` is
        // the most specific label available on this side of the bridge.
        reportRendererConsoleError('Shared-container listing failed', {
          attempted: results.length,
          rejected: rejectedReasons.length,
          reason:
            firstReason instanceof Error
              ? firstReason.name
              : typeof firstReason,
        });
      }
      if (!suppressBackgroundFailure) {
        set({ entries, listStatus });
      }
      finishSharedContainerListLoad(() =>
        get().loadSharedWithMe({ background: true }),
      );
    },

    loadAccepted: async (): Promise<void> => {
      const bridge = window.api?.sharedContainers;
      if (!bridge) {
        set({
          acceptedStatus: 'success',
          acceptedIds: [],
          acceptedRecords: {},
        });
        return;
      }
      set({ acceptedStatus: 'loading' });
      try {
        const response = await bridge.listAccepted();
        set({
          acceptedIds: response.containerIds,
          // A responder that predates `records` leaves every accepted share
          // following its listing classification.
          acceptedRecords: response.records ?? {},
          acceptedStatus: 'success',
        });
      } catch {
        // Fail closed: an unreadable acceptance list leaves every row an
        // invitation, which asks again rather than cloning unasked.
        set({ acceptedIds: [], acceptedRecords: {}, acceptedStatus: 'error' });
      }
    },

    acceptContainer: async ({
      containerId,
      organizationId,
      access,
      containerType,
      shouldOpen,
    }): Promise<void> => {
      const bridge = window.api?.sharedContainers;
      if (!bridge) return;
      set({ acceptingId: containerId, acceptFailedId: null });
      try {
        const response = await bridge.accept({
          containerId,
          ...(containerType ? { containerType } : {}),
          ...(organizationId ? { organizationId } : {}),
          ...(access ? { access } : {}),
        });
        // The record lands in the same update as the acceptance, before the
        // viewer mounts: the context selection sync reads it on that very
        // transition. Main writes the record once per accept and answers with
        // the identity it holds, which on a repeat accept is not the one sent
        // here: a link claim, or an accept this store never read, may have
        // written it first. A responder that predates the answer leaves an
        // existing record alone and otherwise records the identity just sent.
        set((current) => {
          const existing: SharedContainerAcceptedIdentity | undefined =
            current.acceptedRecords[containerId];
          const record: SharedContainerAcceptedIdentity = response.record ??
            existing ?? {
              ...(organizationId ? { organizationId } : {}),
              ...(access ? { access } : {}),
            };
          return {
            acceptedIds: current.acceptedIds.includes(containerId)
              ? current.acceptedIds
              : [...current.acceptedIds, containerId],
            acceptedRecords:
              existing !== undefined &&
              existing.organizationId === record.organizationId &&
              existing.access === record.access &&
              existing.acceptedAt === record.acceptedAt
                ? current.acceptedRecords
                : { ...current.acceptedRecords, [containerId]: record },
          };
        });
      } catch {
        set({ acceptingId: null, acceptFailedId: containerId });
        return;
      }
      set({ acceptingId: null });
      if (shouldOpen?.() === false) return;
      await get().openContainer({ containerId, organizationId, access });
    },

    openContainer: async ({
      containerId,
      organizationId,
      access,
    }): Promise<void> => {
      const bridge = window.api?.sharedContainers;
      // Defense in depth against a caller that skipped the accept step; main
      // refuses the same request, and this keeps the surface from flashing a
      // loading state for a container it will never materialize.
      if (!get().acceptedIds.includes(containerId)) return;
      // Re-clicking the share that is already mounted is a no-op. Re-opening
      // tore the whole viewer down to `loading` and re-ran the access gate,
      // which on the recipient side can mean a multi-second re-materialization
      // for a container that is already on screen (CAN-2551).
      const mounted = get().viewer;
      if (
        mounted !== null &&
        mounted.containerId === containerId &&
        mounted.organizationId === organizationId &&
        mounted.access === access &&
        mounted.openError === null &&
        // Deliberately not `mounted.loading`: an open that never settles has no
        // retry affordance on the surface, so treating a re-click as a no-op
        // while loading would make re-selecting the row the one escape and then
        // take it away. Only a container that is actually readable is a no-op
        // (CAN-2551).
        mounted.replica !== null
      ) {
        return;
      }
      const requestId = ++viewerRequestEpoch;
      // One session per viewer mount. The already-mounted no-op above mints
      // nothing, so a mounted share keeps the session main is tracking.
      const viewerSessionId = crypto.randomUUID();
      set({
        viewer: {
          containerId,
          organizationId,
          access,
          viewerSessionId,
          replica: null,
          openError: null,
          loading: true,
          syncPhase: 'checking-access',
        },
      });
      // After the `set`, which unmounts the previous viewer's grid: switching
      // shares bypasses `closeViewer`, so the share being left is released
      // here, along with any layout still held for the one being opened.
      const released = Promise.all(
        Array.from(
          new Set([
            containerId,
            ...(mounted !== null ? [mounted.containerId] : []),
          ]),
          releaseViewerPanelLayout,
        ),
      ).catch(() => undefined);
      if (!bridge) {
        set((current) =>
          requestId === viewerRequestEpoch &&
          current.viewer?.containerId === containerId &&
          current.viewer.organizationId === organizationId
            ? {
                viewer: {
                  ...current.viewer,
                  loading: false,
                  syncPhase: undefined,
                  openError: 'Shared containers are unavailable.',
                },
              }
            : {},
        );
        return;
      }
      try {
        // The replica is marked readable only after this resolves, and main
        // resolves it only after its layout reset has committed, so the grid
        // mounts on the reset layout.
        await released;
        // Closed or superseded while the save committed: opening now would
        // leave main holding a session no viewer owns.
        if (requestId !== viewerRequestEpoch) return;
        const replica = await bridge.open({
          containerId,
          ...(organizationId ? { organizationId } : {}),
          ...(access ? { access } : {}),
          viewerSessionId,
        });
        set((current) =>
          requestId === viewerRequestEpoch &&
          current.viewer?.containerId === containerId &&
          current.viewer.organizationId === organizationId
            ? {
                viewer: {
                  ...current.viewer,
                  replica,
                  loading: false,
                  syncPhase: undefined,
                },
              }
            : {},
        );
      } catch (error) {
        set((current) =>
          requestId === viewerRequestEpoch &&
          current.viewer?.containerId === containerId &&
          current.viewer.organizationId === organizationId
            ? {
                viewer: {
                  ...current.viewer,
                  loading: false,
                  syncPhase: undefined,
                  openError:
                    error instanceof Error
                      ? error.message
                      : 'Could not open this shared container.',
                },
              }
            : {},
        );
      }
    },

    closeViewer: (): void => {
      viewerRequestEpoch += 1;
      const viewer = get().viewer;
      if (viewer !== null) {
        // Captured now, not when the queued close runs: by then the store may
        // hold the next visit's session, and the close must name its own.
        const { containerId, viewerSessionId } = viewer;
        // Unmount the grid before its layout is dropped.
        set({ viewer: null });
        const released = releaseViewerPanelLayout(containerId).catch(
          () => undefined,
        );
        // `close` releases the realtime subscription; a failure there is not
        // something the recipient can act on, so it must not block the close.
        recipientViewerClose = recipientViewerClose
          .then(() => released)
          .then(() =>
            window.api?.sharedContainers?.close({
              containerId,
              ...(viewerSessionId ? { viewerSessionId } : {}),
            }),
          )
          .then(() => undefined)
          .catch(() => undefined);
      } else {
        set({ viewer: null });
      }
    },

    retryContainer: async (): Promise<void> => {
      const viewer = get().viewer;
      const bridge = window.api?.sharedContainers;
      if (viewer === null || !bridge) return;
      const requestId = ++viewerRequestEpoch;
      set({
        viewer: {
          ...viewer,
          loading: true,
          openError: null,
          syncPhase: 'checking-access',
        },
      });
      try {
        // Main resets the layout on a retry as it does on an open, unless
        // this session already showed a readable replica, which it seeds. The
        // grid is unmounted unless the replica is readable, so a layout still
        // held from earlier in this session is dropped and reloaded from disk.
        if (!isReadableReplica(viewer.replica)) {
          await releaseViewerPanelLayout(viewer.containerId).catch(
            () => undefined,
          );
          // Closed or superseded while the save committed.
          if (requestId !== viewerRequestEpoch) return;
        }
        const replica = await bridge.retry({
          containerId: viewer.containerId,
          organizationId: viewer.organizationId,
          ...(viewer.access ? { access: viewer.access } : {}),
          // A retry reuses its viewer's session; main keeps the session it
          // already recorded rather than treating this as a new visit.
          ...(viewer.viewerSessionId
            ? { viewerSessionId: viewer.viewerSessionId }
            : {}),
        });
        set((current) =>
          requestId === viewerRequestEpoch &&
          current.viewer?.containerId === viewer.containerId &&
          current.viewer.organizationId === viewer.organizationId
            ? {
                viewer: {
                  ...current.viewer,
                  replica,
                  loading: false,
                  syncPhase: undefined,
                },
              }
            : {},
        );
      } catch (error) {
        set((current) =>
          requestId === viewerRequestEpoch &&
          current.viewer?.containerId === viewer.containerId &&
          current.viewer.organizationId === viewer.organizationId
            ? {
                viewer: {
                  ...current.viewer,
                  loading: false,
                  syncPhase: undefined,
                  openError:
                    error instanceof Error
                      ? error.message
                      : 'Could not re-check access.',
                },
              }
            : {},
        );
      }
    },

    /**
     * Declines an invitation or removes an accepted share.
     *
     * Resolves `true` only when the server actually revoked the grant. The
     * optimistic row removal is rolled back otherwise, because this is the one
     * destructive action the recipient has: the confirm copy promises the local
     * copy is deleted and access given up, so a failed revoke that silently
     * hid the row would leave a live grant behind a UI that said it was gone,
     * with no way to retry in-session — `dismissedIds` filters the very
     * listing the old recovery path relied on (CAN-2551).
     */
    dismissContainer: async (
      containerId: string,
      organizationId: string | undefined,
    ): Promise<boolean> => {
      // Capture just this container's own row, not whole-array snapshots: a
      // listing or replica broadcast can land while the revoke is in flight,
      // and restoring wholesale would roll those unrelated updates back too.
      const dismissedEntry =
        get().entries.find((entry) => entry.container.id === containerId) ??
        null;
      const wasAccepted = get().acceptedIds.includes(containerId);
      const acceptedRecord: SharedContainerAcceptedIdentity | undefined =
        get().acceptedRecords[containerId];
      set((current) => ({
        dismissedIds: current.dismissedIds.includes(containerId)
          ? current.dismissedIds
          : [...current.dismissedIds, containerId],
        acceptedIds: current.acceptedIds.filter((id) => id !== containerId),
        acceptedRecords: withoutAcceptedRecord(
          current.acceptedRecords,
          containerId,
        ),
        entries: current.entries.filter(
          (entry) => entry.container.id !== containerId,
        ),
      }));
      if (get().viewer?.containerId === containerId) {
        get().closeViewer();
      }
      try {
        const bridge = window.api?.sharedContainers;
        // Optional chaining would short-circuit to `undefined` without
        // throwing, and this function promises `true` only when the server
        // actually revoked the grant.
        if (!bridge) throw new Error('Shared containers are unavailable.');
        await bridge.dismiss({
          containerId,
          ...(organizationId ? { organizationId } : {}),
        });
        // The removed share is restorable from Past shares at once: a
        // provisional row stands in until the listing answers, which then
        // replaces the entries wholesale, so the row is never duplicated. An
        // unsupported server has no removed list to put it in.
        if (dismissedEntry !== null && get().removedStatus !== 'unsupported') {
          const provisional: SharedContainerRemovedEntry = {
            ...dismissedEntry,
            dismissedAt: new Date().toISOString(),
          };
          set((current) => ({
            removedEntries: sortRemovedEntries([
              provisional,
              ...current.removedEntries.filter(
                (entry) => entry.container.id !== containerId,
              ),
            ]),
          }));
        }
        void get().loadRemoved();
        return true;
      } catch {
        // Put the row back and stop suppressing it, so the next authoritative
        // listing can legitimately restore it and the caller can surface a
        // real failure.
        set((current) => ({
          dismissedIds: current.dismissedIds.filter((id) => id !== containerId),
          acceptedIds:
            wasAccepted && !current.acceptedIds.includes(containerId)
              ? [...current.acceptedIds, containerId]
              : current.acceptedIds,
          acceptedRecords:
            acceptedRecord !== undefined &&
            !(containerId in current.acceptedRecords)
              ? { ...current.acceptedRecords, [containerId]: acceptedRecord }
              : current.acceptedRecords,
          entries:
            dismissedEntry !== null &&
            !current.entries.some((entry) => entry.container.id === containerId)
              ? [...current.entries, dismissedEntry].sort((left, right) =>
                  right.container.updatedAt.localeCompare(
                    left.container.updatedAt,
                  ),
                )
              : current.entries,
        }));
        void get().loadSharedWithMe();
        return false;
      }
    },

    loadRemoved: async (): Promise<void> => {
      removedEpoch += 1;
      const epoch = removedEpoch;
      // Optional-chained on the method as well as the bridge: without it there
      // is no removed list, which reads the same as an unsupported server.
      const bridge = window.api?.sharedContainers;
      if (!bridge?.listDismissed) {
        set({ removedStatus: 'unsupported', removedEntries: [] });
        return;
      }
      const accountState = useSharedContainersStore.getState();
      const showDirect =
        accountState.accountKind === 'connected' &&
        useFeatureFlagsStore
          .getState()
          .isEnabled(
            CLIENT_FEATURE_FLAGS.canopySharedContainerExternalSharing.key,
          );
      const listings: Array<{ organizationId?: string }> = [
        ...accountState.organizations.map((organization) => ({
          organizationId: organization.id,
        })),
        ...(showDirect ? [{}] : []),
      ];
      if (listings.length === 0) {
        set({ removedStatus: 'success', removedEntries: [] });
        return;
      }
      // A refresh of a list already on screen stays quiet; only the first
      // load and a retry after a failure announce themselves.
      const statusBeforeLoad = get().removedStatus;
      if (statusBeforeLoad === 'idle' || statusBeforeLoad === 'error') {
        set({ removedStatus: 'loading' });
      }
      const results = await Promise.allSettled(
        listings.map(
          async (
            listing,
          ): Promise<SharedContainerRemovedEntry[] | 'unsupported'> => {
            const entries: SharedContainerRemovedEntry[] = [];
            const seenCursors = new Set<string>();
            let cursor: string | undefined;
            do {
              const response = await bridge.listDismissed({
                ...(listing.organizationId
                  ? { organizationId: listing.organizationId }
                  : {}),
                ...(cursor ? { cursor } : {}),
                limit: SHARED_CONTAINER_REMOVED_PAGE_LIMIT,
              });
              if ('unsupported' in response) return 'unsupported';
              entries.push(
                ...response.containers.map((container) =>
                  toRemovedEntry(container, listing.organizationId),
                ),
              );
              if (
                response.nextCursor === null ||
                entries.length >= SHARED_CONTAINER_REMOVED_ENTRY_CAP
              ) {
                cursor = undefined;
              } else {
                if (seenCursors.has(response.nextCursor)) {
                  throw new Error('Removed-share listing cursor repeated');
                }
                seenCursors.add(response.nextCursor);
                cursor = response.nextCursor;
              }
            } while (cursor !== undefined);
            return entries;
          },
        ),
      );
      if (removedEpoch !== epoch) return;
      if (
        results.some(
          (result) =>
            result.status === 'fulfilled' && result.value === 'unsupported',
        )
      ) {
        set({ removedStatus: 'unsupported', removedEntries: [] });
        return;
      }
      if (results.some((result) => result.status === 'rejected')) {
        // Keep what is listed, including a provisional row: a failed refresh
        // is not evidence that a removed share stopped being restorable.
        set({ removedStatus: 'error' });
        return;
      }
      const seen = new Set<string>();
      const removedEntries = sortRemovedEntries(
        results
          .flatMap((result) =>
            result.status === 'fulfilled' && result.value !== 'unsupported'
              ? result.value
              : [],
          )
          .filter((entry) => {
            if (seen.has(entry.container.id)) return false;
            seen.add(entry.container.id);
            return true;
          }),
      ).slice(0, SHARED_CONTAINER_REMOVED_ENTRY_CAP);
      set({ removedStatus: 'success', removedEntries });
    },

    restoreContainer: async (
      containerId: string,
    ): Promise<SharedContainerRestoreOutcome> => {
      // One guard for every entry point (the page's Restore and the remove
      // toast's), so the two cannot double-send.
      if (get().restoringIds.includes(containerId)) return 'in-flight';
      const entry = get().removedEntries.find(
        (candidate) => candidate.container.id === containerId,
      );
      const bridge = window.api?.sharedContainers;
      if (!bridge?.restore) {
        set({ removedStatus: 'unsupported', removedEntries: [] });
        return 'unsupported';
      }
      set((current) => ({
        restoringIds: [...current.restoringIds, containerId],
      }));
      const withoutEntry = (
        entries: SharedContainerRemovedEntry[],
      ): SharedContainerRemovedEntry[] =>
        entries.filter((candidate) => candidate.container.id !== containerId);
      try {
        const result = await bridge.restore({
          containerId,
          ...(entry?.organizationId
            ? { organizationId: entry.organizationId }
            : {}),
        });
        if (result.restored) {
          set((current) => ({
            removedEntries: withoutEntry(current.removedEntries),
            // Otherwise the listing keeps hiding the share it just got back.
            dismissedIds: current.dismissedIds.filter(
              (id) => id !== containerId,
            ),
          }));
          void get()
            .loadSharedWithMe({ background: true })
            .catch(() => undefined);
          return 'restored';
        }
        if (result.reason === 'unsupported') {
          set({ removedStatus: 'unsupported', removedEntries: [] });
          return 'unsupported';
        }
        // The owner revoking a removed share sends this device nothing, so
        // this answer is how it finds out. Re-list in case more went with it.
        set((current) => ({
          removedEntries: withoutEntry(current.removedEntries),
        }));
        void get().loadRemoved();
        return 'not-restorable';
      } catch {
        return 'failed';
      } finally {
        set((current) => ({
          restoringIds: current.restoringIds.filter((id) => id !== containerId),
        }));
      }
    },

    clearAcceptFailed: (): void => {
      if (get().acceptFailedId !== null) set({ acceptFailedId: null });
    },

    openPastShares: (): void => {
      set({ pastSharesOpen: true });
    },

    closePastShares: (): void => {
      if (get().pastSharesOpen) set({ pastSharesOpen: false });
    },

    /**
     * Applies a main → renderer replica broadcast.
     *
     * A purge says "these bytes are gone" and names its scope. Only a purge
     * that names the *mounted* container — or `purged: 'all'` — tears the
     * viewer down; the CAN-2551 behavior of closing immediately on a genuine
     * revocation is unchanged. A purge about some other container must not
     * touch the viewer at all: dismissing a different share, an organization
     * re-probe that fires one purge per unauthorized container, or an access
     * loss elsewhere all used to close the share being read, because the old
     * `null` broadcast carried no identity.
     *
     * There is deliberately no exemption for an in-flight open. It existed
     * only because an untargeted `null` could not be told apart from main
     * closing the previously open container; `close()` no longer purges
     * (CAN-2551), and a purge that explicitly names the container being
     * opened is a genuine denial that must tear down.
     */
    applyReplicaState: (event: SharedContainerReplicaBroadcast): void => {
      const viewer = get().viewer;
      if ('purged' in event) {
        if (
          event.purged === 'container' &&
          viewer?.containerId !== event.containerId
        ) {
          // Not our share. Refresh the sidebar only when the purged container
          // could actually be shown there, so a purge for a container this
          // device never listed costs no listing at all. It does NOT coalesce
          // a burst: containers purged because they were listed still pass
          // this gate, and `loadSharedWithMe` has no in-flight dedupe, only a
          // last-write-wins `listEpoch`.
          const current = get();
          const listed =
            current.entries.some(
              (entry) => entry.container.id === event.containerId,
            ) || current.dismissedIds.includes(event.containerId);
          if (listed) {
            void current.loadSharedWithMe();
          }
          return;
        }
        viewerRequestEpoch += 1;
        set({ viewer: null });
        void get().loadSharedWithMe();
        return;
      }
      if (viewer === null || viewer.containerId !== event.containerId) {
        return;
      }
      // A pending open or retry owns the first readable state: main resets
      // the viewer layout before that request resolves. A background sync's
      // broadcast must not mount the grid on the layout about to be replaced.
      if (
        viewer.loading &&
        !isReadableReplica(viewer.replica) &&
        isReadableReplica(event)
      ) {
        return;
      }
      set({
        viewer: {
          ...viewer,
          replica: event,
          loading: false,
          openError: null,
          syncPhase: undefined,
        },
      });
    },

    subscribeToReplicaChanges: (): (() => void) => {
      const bridge = window.api?.sharedContainers;
      if (!bridge) {
        return (): void => {};
      }
      return bridge.onReplicaChanged((event) => {
        get().applyReplicaState(event);
      });
    },

    /**
     * Advisory progress for the open currently on screen. Ignored unless the
     * event names the mounted container *and* that container is still
     * loading, so a late phase from a previous open can never relabel a
     * settled surface.
     */
    applySyncPhase: (event: SharedContainerSyncPhaseEvent): void => {
      const viewer = get().viewer;
      if (
        viewer === null ||
        viewer.containerId !== event.containerId ||
        !viewer.loading
      ) {
        return;
      }
      if (viewer.syncPhase === event.phase) return;
      set({ viewer: { ...viewer, syncPhase: event.phase } });
    },

    subscribeToSyncPhases: (): (() => void) => {
      const bridge = window.api?.sharedContainers;
      if (!bridge?.onSyncPhase) {
        return (): void => {};
      }
      return bridge.onSyncPhase((event) => {
        get().applySyncPhase(event);
      });
    },

    /**
     * The account-wide inbox signal from main. Optional-chained because an
     * older preload has no such bridge method, and the heartbeat this
     * accelerates is not worth a hard failure at startup.
     *
     * The signal deliberately carries no container identity and no store
     * mutation of its own: it means "something in your inbox moved", and the
     * caller owns the re-listing (and its coalescing).
     */
    subscribeToInboxChanges: (onSignal): (() => void) => {
      const bridge = window.api?.sharedContainers;
      if (!bridge?.onInboxChanged) {
        return (): void => {};
      }
      return bridge.onInboxChanged((event) => {
        onSignal(event);
      });
    },

    reset: (): void => {
      cancelQueuedSharedContainerListLoad();
      listEpoch += 1;
      viewerRequestEpoch += 1;
      removedEpoch += 1;
      resetUnavailableRetry();
      clearOwnerNameCache();
      set({ ...initialState });
    },
  }));

/**
 * Wire the recipient store to replica broadcasts once, from the app shell.
 */
export function initializeSharedContainerReplicasStore(): () => void {
  const unsubscribeReplicaChanges = useSharedContainerReplicasStore
    .getState()
    .subscribeToReplicaChanges();
  const unsubscribeSyncPhases = useSharedContainerReplicasStore
    .getState()
    .subscribeToSyncPhases();
  let active = true;
  let organizationFingerprint = '';
  const refreshInbox = (): void => {
    if (!active) return;
    // Deliberately NOT routed through `syncOrganizations`: that path is for
    // authorization changes. It can close the viewer and reset the store, and
    // it does nothing while the organization fingerprint is unchanged.
    void useSharedContainerReplicasStore
      .getState()
      .loadSharedWithMe({ background: true })
      .catch(() => undefined);
    // Any inbox signal, including this device's own remove or restore
    // (`local`), can move a share into or out of the removed list.
    void useSharedContainerReplicasStore.getState().loadRemoved();
  };
  const unsubscribeInboxChanges = useSharedContainerReplicasStore
    .getState()
    .subscribeToInboxChanges((): void => {
      refreshInbox();
    });
  const syncOrganizations = (): void => {
    const accountState = useSharedContainersStore.getState();
    // A failed account read is inconclusive, not a sign-out. The account store
    // already preserves its last-known-good organizations in that case, so
    // acting on this snapshot would tear the open share down over a transient
    // probe failure and leave the recipient staring at whatever was behind it.
    if (accountState.accountHydrationFailed) return;
    const organizations = accountState.organizations;
    const externalSharingEnabled = useFeatureFlagsStore
      .getState()
      .isEnabled(CLIENT_FEATURE_FLAGS.canopySharedContainerExternalSharing.key);
    // The fingerprint covers billing state as well as membership. An org that
    // loses its Teams entitlement mid-session changes neither the id set nor
    // its order, so an ids-only fingerprint treated the refresh as a no-op and
    // left the section rendering rows the server would now refuse — until the
    // next restart. Folding the entitlement in makes a lapse (or a resubscribe)
    // re-run the listing like any other authorization change.
    const billingStates = accountState.orgBillingStates;
    const nextFingerprint = [
      accountState.accountKind,
      externalSharingEnabled ? 'external-on' : 'external-off',
      ...organizations
        .map(
          (organization) =>
            `${organization.id}:${isOrgTeamsLapsed(billingStates, organization.id) ? 'lapsed' : 'ok'}`,
        )
        .sort(),
    ].join('\0');
    if (nextFingerprint === organizationFingerprint) return;
    organizationFingerprint = nextFingerprint;
    const store = useSharedContainerReplicasStore.getState();
    // Only an organization the open share actually belongs to leaving the
    // authorized set is a reason to close it. Membership churn elsewhere, or a
    // re-hydration that reorders the same organizations, must leave the
    // recipient's view exactly where they left it.
    const viewer = store.viewer;
    const viewerAuthorizationRetained =
      viewer !== null &&
      (viewer.access === 'direct' ||
        organizations.some(
          (organization) => organization.id === viewer.organizationId,
        ));
    const restore = viewerAuthorizationRetained
      ? {
          containerId: viewer.containerId,
          organizationId: viewer.organizationId,
        }
      : null;
    if (restore === null) {
      // The organization backing the open share is gone (or there is no
      // viewer at all): close and start from a clean slate.
      store.closeViewer();
      store.reset();
    }
    // When the viewer's organization is retained the store is deliberately
    // NOT reset. `reset()` is `set({ ...initialState })`, which nulls
    // `viewer` — so an unrelated membership or billing refresh closed the
    // share mid-read and depended on a best-effort re-open to put it back.
    // Refreshing in place is both steadier and safer: main re-validates every
    // content read through `withReplicaReadGuard`, so a share that really did
    // lose authorization still cannot be read.
    //
    // Consequently these no longer get cleared on this path, all intentional:
    // `dismissedIds` (session suppression that should outlive an unrelated
    // org refresh), `acceptingId` (transient, and its own flow clears it),
    // and the unavailable-retry ladder (`loadSharedWithMe` below supersedes
    // an armed retry on its own).
    const canReconcileDirect = accountState.accountKind === 'connected';
    if (organizations.length > 0 || canReconcileDirect) {
      const closeBarrier = recipientViewerClose;
      void closeBarrier.then(async () => {
        if (!active || organizationFingerprint !== nextFingerprint) return;
        // Acceptance first: until this device's accepted set is known, every
        // row is an invitation, and nothing is openable.
        await store.loadAccepted();
        if (!active || organizationFingerprint !== nextFingerprint) return;
        await store.loadSharedWithMe();
        if (!active || organizationFingerprint !== nextFingerprint) return;
        void store.loadRemoved();
        if (restore === null) return;
        // The viewer never closed, so there is nothing to re-open -- only a
        // conditional close. Neither loader throws: a failed `loadAccepted`
        // leaves `acceptedIds: []` / `acceptedStatus: 'error'`, and a failed
        // `loadSharedWithMe` leaves `entries: []` / `listStatus: 'error'`.
        // Reading either of those as "not listed" is what closed a share
        // permanently over one bad listing, so only a CONCLUSIVE listing that
        // excludes the container may close it.
        //
        // CONCLUSIVE is not the same as `'success'`. `'blocked-by-org-billing'`
        // means every attempted organization answered with a benign refusal --
        // a definitive server answer that this account may no longer list
        // there, not a read that failed. Main converts that 403 into the
        // refusal only AFTER `reconcileContainerSnapshot` has already purged
        // the replica. That manager-level purge now broadcasts a scoped
        // teardown of its own, so the two are independent halves rather than
        // one safety net: the broadcast covers the mixed fan-outs where an
        // unrelated organization's failure drags `listStatus` to `error`, and
        // this guard is the renderer-side close when the refusal is
        // conclusive. Do not remove either on the strength of the other.
        // Treating a refusal as inconclusive left the recipient reading a
        // decrypted transcript whose bytes main had already deleted.
        //
        // `'error'` and `'unavailable'` stay inconclusive on purpose: those
        // are a failed or retryable read, and closing on them is the original
        // bug. A refused listing contributes no entries, so `stillListed` is
        // already false and the existing close path below handles it.
        //
        // This status is an aggregate across every organization in the
        // fan-out, so a refusal for the viewer's OWN org can be masked here by
        // an unrelated org failing in the same round (`listStatus` becomes
        // `'error'`). That case is covered by the per-container purge
        // broadcast, not by this guard -- main emits a scoped teardown for
        // exactly those containers. Do not conclude from this guard alone that
        // a masked refusal leaves the viewer open.
        const latest = useSharedContainerReplicasStore.getState();
        const listingWasConclusive =
          latest.listStatus === 'success' ||
          latest.listStatus === 'blocked-by-org-billing';
        if (latest.acceptedStatus !== 'success' || !listingWasConclusive) {
          return;
        }
        const stillListed = latest.entries.some(
          (entry) =>
            entry.container.id === restore.containerId &&
            entry.organizationId === restore.organizationId,
        );
        if (!stillListed || !latest.acceptedIds.includes(restore.containerId)) {
          // `closeViewer()` closes whatever viewer is mounted RIGHT NOW, and
          // `restore` was captured before two awaited loads. If the recipient
          // opened a different share while those were in flight, closing here
          // would tear down the share they just opened and release its
          // realtime subscription -- the same "the viewer closed for no
          // reason" symptom this subscription was rewritten to eliminate. So
          // only close when the mounted viewer is still the one this decision
          // was made about.
          if (
            latest.viewer?.containerId === restore.containerId &&
            latest.viewer.organizationId === restore.organizationId
          ) {
            latest.closeViewer();
          }
        }
      });
    } else if (restore !== null) {
      // No organizations at all is not something the retained viewer can
      // survive, since nothing can list or authorize it.
      store.closeViewer();
    }
  };
  const unsubscribeOrganizations =
    useSharedContainersStore.subscribe(syncOrganizations);
  const unsubscribeFeatureFlags =
    useFeatureFlagsStore.subscribe(syncOrganizations);
  const onAccountChanged = (): void => {
    // Force the next hydrated organization snapshot to reload even when the
    // new account belongs to the same organizations as the old account.
    organizationFingerprint = `account-change:${Date.now()}`;
    const store = useSharedContainerReplicasStore.getState();
    store.closeViewer();
    store.reset();
    // An account refresh may resolve to the same organization snapshot and
    // therefore produce no later store transition for this subscriber. Start
    // a fresh listing now; if hydration changes the account snapshot, that
    // transition supersedes this load through the normal list epoch.
    syncOrganizations();
  };
  window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, onAccountChanged);
  syncOrganizations();
  return () => {
    active = false;
    window.removeEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      onAccountChanged,
    );
    unsubscribeOrganizations();
    unsubscribeFeatureFlags();
    unsubscribeReplicaChanges();
    unsubscribeSyncPhases();
    unsubscribeInboxChanges();
    const store = useSharedContainerReplicasStore.getState();
    store.closeViewer();
    store.reset();
  };
}
