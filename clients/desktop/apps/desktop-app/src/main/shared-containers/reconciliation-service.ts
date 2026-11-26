import type { SharedContainerReplicaRevisionSnapshot } from './replica/types';
import type { ListSharedContainersResponse } from '@canopy/protocol';
import type {
  ListSharedContainersWithMeRequest,
  SharedContainerAccess,
  SharedContainerReplicaBroadcast,
  SharedContainerReplicaPurge,
  SharedContainerReplicaPurgeReason,
  SharedContainerReplicaState,
  SharedContainerSyncPhaseEvent,
  SharedContainerTrackingChange,
} from '@canopy/desktop-shared/types';
import {
  CanopyCloudClientError,
  resolveCanopyCloudCredentialContext,
  type CanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import { dismissSharedContainer } from './canopy-server-client';
import {
  SharedContainerReplicaManager,
  SharedContainerReplicaPurgedCleanupError,
} from './replica/manager';
import { getBrowserService } from '../browser/browser-service-registry';
import {
  canopySharedContainerReplicaTransport,
  type SharedContainerReplicaTransport,
} from './transport';
import type { SharedContainerRealtimeSubscription } from './realtime-subscription';
import { cleanupSharedContainerRecipientViewState } from './recipient-view-state';
import { workerTerminal } from '../terminal/worker-terminal';
import { stopWorktreeScripts } from '../services/scripts-service';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { removeSharedContainerRunEnvironment } from './run-env-store';
import { withSharedContainerRunLifecycle } from './acceptance-store';
import { getObservabilityService } from '../observability';
import { projectSharedContainerViewerChats } from './chat-projection';
import type { SharedContainerViewerLayoutMode } from './layout-projection';
import {
  DIRECT_SHARED_CONTAINER_SCOPE_KEY,
  resolveSharedContainerAccess,
} from './owner-scope';

/**
 * How a recipient reaches one container: its ownership hint (absent for a
 * personal container) and whether access comes from an organization
 * membership or a direct grant.
 */
interface ReplicaIdentity {
  organizationId?: string;
  access: SharedContainerAccess;
}

function replicaIdentity(
  organizationId: string | undefined,
  access: SharedContainerAccess | undefined,
): ReplicaIdentity {
  return {
    ...(organizationId !== undefined ? { organizationId } : {}),
    access: resolveSharedContainerAccess(organizationId, access),
  };
}

/**
 * Tracking key for {@link ReplicaIdentity}. Organization access keeps the bare
 * organization id, so organization-share tracking is unchanged.
 */
function replicaIdentityKey(identity: ReplicaIdentity): string {
  return identity.access === 'organization' &&
    identity.organizationId !== undefined
    ? identity.organizationId
    : JSON.stringify(['direct', identity.organizationId ?? null]);
}

/** Only direct access is passed down; the manager defaults the rest. */
function syncAccessOption(identity: ReplicaIdentity): {
  access?: SharedContainerAccess;
} {
  return identity.access === 'direct' ? { access: 'direct' } : {};
}

async function cleanupSharedContainerRuntime(
  containerId: string,
): Promise<void> {
  await withSharedContainerRunLifecycle(containerId, async () => {
    workerTerminal.killWorktree({
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: containerId,
    });
    await stopWorktreeScripts({
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: containerId,
    });
    await cleanupSharedContainerRecipientViewState(containerId);
    await removeSharedContainerRunEnvironment(containerId);
  });
}

/**
 * Record why a recipient's decrypted replica was removed.
 *
 * A viewer vanishing with no explanation is the exact failure this subsystem
 * was reported for, so every purge leaves an attributable trace in
 * `agent-observability/diagnostics/session-events/`. It is a *session*
 * diagnostic because it is worktree-scoped - `containerId` occupies the
 * worktree slot for the shared-container viewer - and global `app-events/`
 * must never carry a worktree id.
 *
 * Failure is swallowed on purpose: a diagnostic must never be the reason
 * plaintext fails to be removed.
 */
function recordReplicaPurgeDiagnostic(
  containerIds: readonly string[],
  reason: SharedContainerReplicaPurgeReason,
): void {
  if (containerIds.length === 0) return;
  try {
    const observability = getObservabilityService();
    const timestamp = new Date().toISOString();
    for (const containerId of containerIds) {
      observability.recordSessionDiagnostic({
        version: 1,
        timestamp,
        kind: 'shared_container_replica_purged',
        sessionKey: `${SHARED_CONTAINER_VIEWER_PROJECT_ID}/${containerId}`,
        projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        // A purge is not a chat, but `chatId` is required on every session
        // diagnostic; group by `sharedContainerId` instead.
        worktreeId: containerId,
        chatId: '',
        providerType: 'unknown',
        sharedContainerId: containerId,
        sharedContainerPurgeReason: reason,
      });
    }
  } catch {
    // Diagnostics are best-effort; purging must not depend on them.
  }
}

/**
 * Record a change to an open viewer's live tracking.
 *
 * A viewer that silently stops receiving the publisher's updates looks exactly
 * like one the recipient closed, so every arm and release leaves a trace in
 * `agent-observability/diagnostics/session-events/`, next to the purge
 * diagnostic above and worktree-scoped for the same reason. Called at
 * open/close frequency only - never per pull or per realtime signal.
 *
 * Failure is swallowed on purpose: a diagnostic must never be the reason a
 * viewer fails to open or close.
 */
function recordTrackingDiagnostic(
  containerId: string,
  change: SharedContainerTrackingChange,
): void {
  try {
    getObservabilityService().recordSessionDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'shared_container_tracking_changed',
      sessionKey: `${SHARED_CONTAINER_VIEWER_PROJECT_ID}/${containerId}`,
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      // Tracking is not a chat, but `chatId` is required on every session
      // diagnostic; group by `sharedContainerId` instead.
      worktreeId: containerId,
      chatId: '',
      providerType: 'unknown',
      sharedContainerId: containerId,
      sharedContainerTrackingChange: change,
    });
  } catch {
    // Diagnostics are best-effort; tracking must not depend on them.
  }
}

/** The `released-*` causes of {@link SharedContainerTrackingChange}. */
type TrackingReleaseCause = Extract<
  SharedContainerTrackingChange,
  `released-${string}`
>;

const RECONCILE_DEBOUNCE_MS = 250;
const FALLBACK_PULL_MS = 30_000;
/** Fresh listings after the first, each one superseded by an authorization change. */
const SUPERSEDED_LISTING_RETRIES = 2;

type ChangedListener = (event: SharedContainerReplicaBroadcast) => void;
type PhaseListener = (event: SharedContainerSyncPhaseEvent) => void;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isValidatedAccessLoss(
  error: unknown,
  statuses: readonly number[],
): error is CanopyCloudClientError {
  return (
    error instanceof CanopyCloudClientError &&
    error.code === 'http-error' &&
    error.isValidatedServerError &&
    error.status !== undefined &&
    statuses.includes(error.status)
  );
}

export class SharedContainerReconciliationService {
  private readonly subscriptions = new Map<
    string,
    {
      identityKey: string;
      subscription: SharedContainerRealtimeSubscription;
    }
  >();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pullTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** Open container id -> {@link replicaIdentityKey} it was opened under. */
  private readonly openContainers = new Map<string, string>();
  private desiredOpen: { containerId: string; generation: number } | null =
    null;
  private nextOpenGeneration = 0;
  /**
   * Newest renderer viewer session per container, and whether that session has
   * closed. In-memory only, at most one record per container.
   *
   * A viewer close can land after a later open of the same share: the close
   * waits for the run-lifecycle lock and for process teardown, while the open
   * only waits for one acceptance read. Scoping a close to its session is what
   * stops that late close from releasing the tracking of the visit on screen.
   * The `closed` marker outlives the close on purpose, so an open that arrives
   * after the newest session closed is recognized as having no viewer left to
   * serve.
   *
   * `opened` records that an open for the session has returned. `shown`
   * records that the session has since been given a readable replica, by that
   * open or by a later background sync, so the share is on screen and a retry
   * in that session must not reset the viewer layout under it.
   *
   * Assumes one renderer sends open/retry/close in order.
   */
  private readonly viewerSessions = new Map<
    string,
    { id: string; closed: boolean; opened: boolean; shown: boolean }
  >();
  private readonly listeners = new Set<ChangedListener>();
  private readonly phaseListeners = new Set<PhaseListener>();
  private authorizationEpoch = 0;
  private organizationCleanupTail: Promise<void> = Promise.resolve();
  private nextListingGeneration = 0;
  /**
   * Keyed by listing scope: the organization id, or
   * `DIRECT_SHARED_CONTAINER_SCOPE_KEY` for the direct listing.
   */
  private readonly currentListingGenerations = new Map<string, number>();
  /**
   * Scope the manager reported for a whole-store purge that THIS service
   * fenced, folded into that fence's single `{ purged: 'all' }` emission.
   *
   * Only meaningful while {@link purgeAllFenceDepth} is non-zero. The manager
   * also purges out of band -- `ensureReplicaStoreIntegrity()` self-heals
   * through the manager's own `purgeAll()` -- and buffering those would be a
   * leak with two bites: the purge itself would emit nothing, and its ids
   * would resurface in whatever legitimate purge came next, under that event's
   * reason. Those are emitted immediately instead, so every entry into the
   * manager's fence yields exactly one attributed emission.
   */
  private readonly pendingPurgeAllScope = new Set<string>();
  private purgeAllFenceDepth = 0;

  constructor(
    private readonly manager: SharedContainerReplicaManager,
    private readonly transport: SharedContainerReplicaTransport,
    private readonly dismissRemote: (
      containerId: string,
      organizationId: string | undefined,
      credentials: CanopyCloudCredentialContext,
    ) => Promise<void> = dismissSharedContainer,
    private readonly resolveCredentials: () => Promise<CanopyCloudCredentialContext> = resolveCanopyCloudCredentialContext,
  ) {}

  /**
   * A first-page listing aborted by an authorization change (an organization
   * snapshot refresh, account change or purge, e.g. the account re-probe a
   * renderer runs at startup) was superseded, not refused. Once that abort
   * crosses IPC the renderer cannot tell it from a transport failure and shows
   * "Could not load" until a manual retry, so wait for the change to settle
   * and list again under the new authorization, as a fresh request would. A
   * cursor page still aborts (its listing restarts from the first page), and a
   * newer listing for the same scope is left to answer instead.
   */
  async listSharedWithMe(
    request: ListSharedContainersWithMeRequest,
    // Returns the BARE wire response, not the widened IPC shape. The
    // `refusal` discriminant is added one layer up, in the IPC handler, after
    // this method's access-loss branch has purged the org's replicas — typing
    // it here would imply this service can produce a refusal it never sets.
  ): Promise<ListSharedContainersResponse> {
    const scopeKey =
      request.organizationId ?? DIRECT_SHARED_CONTAINER_SCOPE_KEY;
    for (let retry = 0; ; retry += 1) {
      const authorizationEpoch = this.authorizationEpoch;
      const authorizationGeneration =
        this.manager.captureAuthorizationGeneration();
      try {
        return await this.listSharedWithMeOnce(request);
      } catch (error) {
        const authorizationChanged =
          authorizationEpoch !== this.authorizationEpoch ||
          authorizationGeneration !==
            this.manager.captureAuthorizationGeneration() ||
          this.manager.isAuthorizationTransitioning();
        if (
          request.cursor ||
          retry >= SUPERSEDED_LISTING_RETRIES ||
          !(error instanceof DOMException && error.name === 'AbortError') ||
          !authorizationChanged ||
          this.currentListingGenerations.has(scopeKey)
        )
          throw error;
      }
      await this.organizationCleanupTail;
      await this.manager.settleAuthorizationTransition();
      if (this.currentListingGenerations.has(scopeKey)) {
        throw new DOMException(
          'Shared-container listing was superseded',
          'AbortError',
        );
      }
    }
  }

  private async listSharedWithMeOnce(
    request: ListSharedContainersWithMeRequest,
  ): Promise<ListSharedContainersResponse> {
    if (!this.transport.listSharedWithMe) {
      throw new Error('Shared-container listing is unavailable');
    }
    // Without an organization this is the direct listing: every share made to
    // the caller by email or from outside their organizations. It is one
    // organization-independent snapshot, reconciled only against direct
    // replicas, so a validated 401/403 or an absent container purges direct
    // shares exactly as an organization listing purges that organization's.
    const scopeKey =
      request.organizationId ?? DIRECT_SHARED_CONTAINER_SCOPE_KEY;
    const authorizationEpoch = this.authorizationEpoch;
    const listingGeneration = request.cursor
      ? null
      : ++this.nextListingGeneration;
    if (listingGeneration !== null) {
      this.currentListingGenerations.set(scopeKey, listingGeneration);
    }
    let managerListingGeneration: number | null = null;
    const assertListingIsCurrent = (): void => {
      this.assertAuthorizationEpoch(authorizationEpoch);
      if (
        listingGeneration !== null &&
        this.currentListingGenerations.get(scopeKey) !== listingGeneration
      ) {
        throw new DOMException(
          'Shared-container listing was superseded',
          'AbortError',
        );
      }
    };
    try {
      const managerListingPromise = request.cursor
        ? null
        : this.manager.beginContainerSnapshotListing(scopeKey);
      const responsePromise = this.transport.listSharedWithMe(request);
      let response: ListSharedContainersResponse;
      if (managerListingPromise) {
        // The transport begins immediately, preserving first-page request
        // order, while this handler makes the manager generation authoritative
        // before consuming either a success or an access-denial response.
        void responsePromise.catch(() => undefined);
        managerListingGeneration = await managerListingPromise;
        assertListingIsCurrent();
        response = await responsePromise;
      } else {
        response = await responsePromise;
      }
      assertListingIsCurrent();
      if (request.cursor) return response;

      // Closed containers have no realtime subscription. Build a complete
      // snapshot so a revoked cache is purged even when another share keeps the
      // first page non-empty.
      const visibleContainerIds = new Set(
        response.containers.map((container) => container.id),
      );
      const seenCursors = new Set<string>();
      let cursor = response.nextCursor;
      while (cursor) {
        if (seenCursors.has(cursor)) {
          throw new Error('Shared-container listing returned a cursor cycle');
        }
        seenCursors.add(cursor);
        const page = await this.transport.listSharedWithMe({
          ...request,
          cursor,
        });
        assertListingIsCurrent();
        page.containers.forEach((container) =>
          visibleContainerIds.add(container.id),
        );
        cursor = page.nextCursor;
      }
      assertListingIsCurrent();
      if (managerListingGeneration === null) {
        throw new Error('Shared-container listing generation is missing');
      }
      await this.manager.reconcileContainerSnapshot(
        scopeKey,
        Array.from(visibleContainerIds),
        managerListingGeneration,
        assertListingIsCurrent,
      );
      assertListingIsCurrent();
      return response;
    } catch (error) {
      assertListingIsCurrent();
      if (!request.cursor && isValidatedAccessLoss(error, [401, 403])) {
        if (managerListingGeneration === null) {
          throw new Error('Shared-container listing generation is missing');
        }
        await this.manager.reconcileContainerSnapshot(
          scopeKey,
          [],
          managerListingGeneration,
          assertListingIsCurrent,
        );
        assertListingIsCurrent();
      }
      throw error;
    } finally {
      if (
        listingGeneration !== null &&
        this.currentListingGenerations.get(scopeKey) === listingGeneration
      ) {
        this.currentListingGenerations.delete(scopeKey);
      }
    }
  }

  getState(containerId: string): Promise<SharedContainerReplicaState | null> {
    return this.manager.getState(containerId);
  }

  withReplicaReadGuard<T>(
    containerId: string,
    organizationId: string | undefined,
    revisionId: string,
    operation: (
      revisionRoot: string,
      revision: SharedContainerReplicaRevisionSnapshot,
    ) => Promise<T>,
  ): Promise<T> {
    return this.manager.withReplicaReadGuard(
      containerId,
      organizationId,
      revisionId,
      operation,
    );
  }

  /**
   * Record that a viewer session is opening (or retrying) this container.
   *
   * Synchronous, and called by the IPC handler before its first `await`, so
   * sessions are ordered by IPC arrival rather than by how long each open's
   * acceptance read happens to take. The newest session replaces any older
   * one. Re-registering the recorded session changes nothing: a retry reuses
   * its viewer's session, and a session that already closed must never be
   * revived.
   */
  beginViewerSession(containerId: string, viewerSessionId: string): void {
    if (this.viewerSessions.get(containerId)?.id === viewerSessionId) return;
    this.viewerSessions.set(containerId, {
      id: viewerSessionId,
      closed: false,
      opened: false,
      shown: false,
    });
  }

  /**
   * Whether a newer viewer session has been recorded for this container. No
   * record means not superseded, so a close stays unconditional once a purge
   * has dropped the record.
   */
  isViewerSessionSuperseded(
    containerId: string,
    viewerSessionId: string,
  ): boolean {
    const recorded = this.viewerSessions.get(containerId);
    return recorded !== undefined && recorded.id !== viewerSessionId;
  }

  /**
   * `organizationId` is the container's ownership hint (absent for a personal
   * container); `access` is how the recipient reached it (see
   * `SharedContainerAccess`). Both default the way legacy callers expect:
   * an organization id alone means organization access.
   *
   * `viewerSessionId` is the renderer viewer session this open serves, already
   * registered through {@link beginViewerSession}. Absent on legacy callers.
   */
  async open(
    containerId: string,
    organizationId: string | undefined,
    force = false,
    access?: SharedContainerAccess,
    viewerSessionId?: string,
  ): Promise<SharedContainerReplicaState> {
    const identity = replicaIdentity(organizationId, access);
    const identityKey = replicaIdentityKey(identity);
    if (viewerSessionId !== undefined) {
      if (this.viewerSessions.get(containerId)?.closed) {
        // The newest viewer session for this share already closed, so nobody
        // is left to serve. Either the close overtook this open, or this is an
        // older open that stalled on its acceptance read while a newer session
        // opened and closed. Sync and hand the state back, but claim nothing:
        // it must not arm tracking that no close will ever release, and it
        // must not evict the share that is actually on screen.
        //
        // An older open still arms while the newest session is open: that
        // share is on screen, and the newest session's close releases it.
        recordTrackingDiagnostic(containerId, 'open-not-armed');
        // Nobody is looking at this share, so it seeds like a background sync.
        return this.reconcile(containerId, identity, force);
      }
    }
    const authorizationEpoch = this.authorizationEpoch;
    const trackedIdentityKey = this.openContainers.get(containerId);
    if (
      trackedIdentityKey !== undefined &&
      trackedIdentityKey !== identityKey
    ) {
      this.stopTracking(containerId, 'released-identity-changed');
    }
    const openGeneration = ++this.nextOpenGeneration;
    this.desiredOpen = { containerId, generation: openGeneration };
    // Opening one share releases every other. This is internal and
    // unconditional - it is not a viewer close, so it carries no session.
    Array.from(this.openContainers.keys())
      .filter((openContainerId) => openContainerId !== containerId)
      .forEach((openContainerId) =>
        this.stopTracking(openContainerId, 'released-replaced-by-open'),
      );
    // An open resets the viewer layout, except while the share is on screen:
    // a retry in a session that already shows a readable replica, or an older
    // open that stalled until a newer session replaced it. Those seed.
    const viewerSession =
      viewerSessionId === undefined
        ? undefined
        : this.viewerSessions.get(containerId);
    const viewerLayoutMode: SharedContainerViewerLayoutMode =
      viewerSession !== undefined &&
      (viewerSession.id !== viewerSessionId || viewerSession.shown)
        ? 'seed'
        : 'reset';
    try {
      // The open resolves only after the manager has projected the revision,
      // so the reset has committed before the renderer loads the layout.
      const state = await this.reconcile(
        containerId,
        identity,
        force,
        viewerLayoutMode,
      );
      this.assertAuthorizationEpoch(authorizationEpoch);
      if (viewerSession !== undefined && viewerSession.id === viewerSessionId) {
        viewerSession.opened = true;
        this.markViewerSessionShown(state);
      }
      if (
        this.desiredOpen?.containerId !== containerId ||
        this.desiredOpen.generation !== openGeneration
      ) {
        // A newer open for the same container owns the shared sync result. For a
        // different (or closed) target, this completed operation has no owner,
        // so release its subscription. The bytes stay: an accepted share is
        // retained until the recipient removes it or loses access (CAN-2551),
        // and discarding them here would make a navigation race cost another
        // full clone on the next open.
        if (this.desiredOpen?.containerId !== containerId) {
          this.stopTracking(containerId, 'released-open-abandoned');
        }
        return state;
      }
      this.openContainers.set(containerId, identityKey);
      this.subscribe(containerId, identity);
      this.scheduleFallbackPull(containerId, identity);
      recordTrackingDiagnostic(containerId, 'armed');
      return state;
    } catch (error) {
      // A failed open has returned too: a later sync that hands this session
      // a readable replica puts the share on screen.
      if (viewerSession !== undefined && viewerSession.id === viewerSessionId) {
        viewerSession.opened = true;
      }
      if (
        this.desiredOpen?.containerId === containerId &&
        this.desiredOpen.generation === openGeneration
      ) {
        // Materialization stages and promotes atomically, and an interrupted
        // promotion is repaired on the next sync, so a failed open leaves no
        // half-written revision to clean up. Any previously promoted revision
        // is the recipient's retained copy and must survive the failure.
        this.desiredOpen = null;
        this.stopTracking(containerId, 'released-open-failed');
      }
      throw error;
    }
  }

  async dismiss(
    containerId: string,
    organizationId: string | undefined,
  ): Promise<void> {
    const authorizationEpoch = this.authorizationEpoch;
    const authorizationGeneration =
      this.manager.captureAuthorizationGeneration();
    const credentialContext = await this.resolveCredentials();
    this.assertAuthorizationEpoch(authorizationEpoch);
    if (
      authorizationGeneration !== this.manager.captureAuthorizationGeneration()
    ) {
      throw new DOMException(
        'Shared-container authorization changed',
        'AbortError',
      );
    }
    let remoteError: unknown;
    try {
      await this.dismissRemote(containerId, organizationId, credentialContext);
    } catch (error) {
      remoteError = error;
    }

    this.assertAuthorizationEpoch(authorizationEpoch);
    try {
      // Dismissal is user intent to remove local plaintext as well as the
      // server grant. Always attempt the local half, including when a retry
      // observes that the already-dismissed grant is now absent remotely.
      await this.purgeReplica(containerId, 'dismissed', {
        authorizationGeneration,
      });
    } catch (cleanupError) {
      this.assertAuthorizationEpoch(authorizationEpoch);
      if (remoteError !== undefined) {
        throw new Error(
          `Shared-container dismissal failed (${toError(remoteError).message}) and local cleanup also failed (${toError(cleanupError).message})`,
        );
      }
      throw toError(cleanupError);
    }
    this.assertAuthorizationEpoch(authorizationEpoch);

    if (
      remoteError !== undefined &&
      !(
        remoteError instanceof CanopyCloudClientError &&
        remoteError.code === 'http-error' &&
        remoteError.status === 404 &&
        remoteError.isValidatedServerError
      )
    ) {
      throw toError(remoteError);
    }
  }

  async reconcileOrganizationSnapshot(
    organizationIds: readonly string[],
  ): Promise<void>;
  async reconcileOrganizationSnapshot<T>(
    organizationIds: readonly string[],
    afterCleanup: () => Promise<T>,
  ): Promise<T>;
  async reconcileOrganizationSnapshot<T>(
    organizationIds: readonly string[],
    afterCleanup?: () => Promise<T>,
  ): Promise<T | void> {
    return this.withOrganizationCleanupLock(async () => {
      this.authorizationEpoch += 1;
      await this.manager.ensureReplicaStoreIntegrity();
      const authorizedOrganizationIds = new Set(organizationIds);
      return this.manager.withOrganizationSnapshotFence(
        organizationIds,
        async (): Promise<T | void> => {
          const index = await this.manager.store.readIndex();
          await Promise.all(
            Object.values(index.containers)
              .filter(
                // Direct shares (email grants, personal containers, and
                // outside-organization grants) do not depend on the
                // recipient's memberships, so a membership snapshot never
                // purges them. Legacy entries without `access` are
                // organization shares.
                (state) =>
                  resolveSharedContainerAccess(
                    state.organizationId,
                    state.access,
                  ) !== 'direct' &&
                  (state.organizationId === undefined ||
                    !authorizedOrganizationIds.has(state.organizationId)),
              )
              .map((state) =>
                this.purgeReplica(
                  state.containerId,
                  'organization-unauthorized',
                  { allowDuringAuthorizationTransition: true },
                ),
              ),
          );
          return afterCleanup?.();
        },
      );
    });
  }

  /**
   * Release one container's live tracking. `desiredOpen` is cleared only when
   * it names this container, so releasing one share never abandons an
   * in-flight open of another. The viewer-session record is deliberately left
   * alone: its `closed` marker has to survive the close that set it.
   *
   * `cause` is recorded only when there was armed tracking to release.
   */
  private stopTracking(containerId: string, cause: TrackingReleaseCause): void {
    if (this.openContainers.has(containerId)) {
      recordTrackingDiagnostic(containerId, cause);
    }
    if (this.desiredOpen?.containerId === containerId) {
      this.desiredOpen = null;
    }
    this.subscriptions.get(containerId)?.subscription.stop();
    this.subscriptions.delete(containerId);
    const timer = this.timers.get(containerId);
    if (timer) clearTimeout(timer);
    this.timers.delete(containerId);
    const pullTimer = this.pullTimers.get(containerId);
    if (pullTimer) clearTimeout(pullTimer);
    this.pullTimers.delete(containerId);
    this.openContainers.delete(containerId);
  }

  /**
   * Release the live subscription without touching bytes on disk (CAN-2551).
   *
   * Plaintext now lives as long as the acceptance does. Closing a viewer is
   * ordinary navigation — it happens on every move to another worktree — and
   * purging there made every reopen a cold start: two HTTPS round trips, a full
   * artifact re-download, three GitHub API calls per repository, and a fresh
   * `git clone`, under one indeterminate spinner.
   *
   * The retention boundary is the recipient's own decision instead: `dismiss()`
   * (Remove), access loss via `purgeDeniedReplica`, an organization-snapshot
   * reconcile, and account change all still purge. `pruneRevisions` keeps a
   * single revision per accepted share, so retention is bounded by the number
   * of shares the recipient chose to accept, not by how often they navigate.
   *
   * A close is scoped to the viewer session that sent it. It can land after a
   * later open of the same share - the IPC handler waits for the run-lifecycle
   * lock and for process teardown first - and an unscoped close would then
   * release the tracking of the visit now on screen, which nothing re-arms:
   *
   * - `viewerSessionId` given and a newer session is recorded: no-op.
   * - `viewerSessionId` given and it is the recorded session: mark it closed,
   *   then release. Repeating the close is idempotent.
   * - no `viewerSessionId`, or no recorded session (legacy callers, or the
   *   record was dropped by a purge): release unconditionally, as before.
   */
  close(containerId: string, viewerSessionId?: string): Promise<void> {
    if (viewerSessionId !== undefined) {
      const session = this.viewerSessions.get(containerId);
      if (session !== undefined && session.id !== viewerSessionId) {
        recordTrackingDiagnostic(containerId, 'stale-close-ignored');
        return Promise.resolve();
      }
      if (session !== undefined) session.closed = true;
    }
    this.stopTracking(containerId, 'released-viewer-closed');
    return Promise.resolve();
  }

  /**
   * The reason is required and has no default: a purge closes a recipient's
   * viewer, and an untyped back door here is how an unattributable teardown
   * gets reintroduced.
   *
   * Deliberately retained with no production caller. Every real purge today
   * arrives through a named path (`dismiss`, `purgeDeniedReplica`,
   * `reconcileOrganizationSnapshot`, account change), each of which calls
   * `purgeReplica` with its own reason. This is the reason-carrying seam those
   * paths are held to, and it is what the reconciliation tests exercise
   * directly; a future caller that needs to purge must come through here
   * rather than reaching for the manager, where no broadcast or diagnostic is
   * emitted. Do not delete it as unused without also re-reading
   * `docs/shared-container-recipient-ux.md`.
   */
  async purge(
    containerId: string,
    reason: SharedContainerReplicaPurgeReason,
  ): Promise<void> {
    await this.purgeReplica(containerId, reason);
  }

  private async purgeReplica(
    containerId: string,
    reason: SharedContainerReplicaPurgeReason,
    options: {
      authorizationGeneration?: number;
      allowDuringAuthorizationTransition?: boolean;
      expectedIdentity?: ReplicaIdentity;
    } = {},
  ): Promise<void> {
    const { expectedIdentity, ...rest } = options;
    if (
      expectedIdentity === undefined ||
      this.openContainers.get(containerId) ===
        replicaIdentityKey(expectedIdentity)
    ) {
      this.stopTracking(containerId, 'released-purged');
    }
    // A personal container has no organization to pin the purge to; its
    // container id is globally unique, so the purge proceeds unconditioned.
    const managerOptions = {
      ...rest,
      ...(expectedIdentity?.organizationId !== undefined
        ? {
            expectedOrganizationId: expectedIdentity.organizationId,
            ...(expectedIdentity.access === 'direct'
              ? { expectedAccess: expectedIdentity.access }
              : {}),
          }
        : {}),
    };
    let purged: boolean;
    try {
      purged = await (Object.keys(managerOptions).length > 0
        ? this.manager.purge(containerId, managerOptions)
        : this.manager.purge(containerId));
    } catch (error) {
      if (error instanceof SharedContainerReplicaPurgedCleanupError) {
        this.emitPurge({ purged: 'container', containerId }, reason);
        throw error.cleanupFailure;
      }
      throw error;
    }
    if (purged !== false) {
      this.emitPurge({ purged: 'container', containerId }, reason);
    }
  }

  private async purgeDeniedReplica(
    containerId: string,
    identity: ReplicaIdentity,
    authorizationEpoch: number,
  ): Promise<void> {
    return this.withOrganizationCleanupLock(async () => {
      // A root identity transition is intentionally not serialized by this
      // lock. Revalidate at entry so a queued denial from the old identity can
      // never purge replacement state. Same-identity snapshots use this lock
      // and therefore cannot overtake cleanup that has already started.
      this.assertAuthorizationEpoch(authorizationEpoch);
      await this.manager.ensureReplicaStoreIntegrity();
      this.assertAuthorizationEpoch(authorizationEpoch);
      await this.purgeReplica(containerId, 'access-denied', {
        expectedIdentity: identity,
      });
    });
  }

  private async withOrganizationCleanupLock<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.organizationCleanupTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.organizationCleanupTail = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async purgeAll(): Promise<void> {
    await this.withReplicaPurgeFence(() => Promise.resolve());
  }

  async withReplicaPurgeFence<T>(operation: () => Promise<T>): Promise<T> {
    this.authorizationEpoch += 1;
    // Claim the fence BEFORE the manager can report its scope. `withPurgeAllFence`
    // reports synchronously partway through, and on one path (a view-state
    // cleanup failure) it throws before ever invoking the operation below --
    // so the claim and its release must bracket the whole manager call, not
    // just the inner body.
    this.purgeAllFenceDepth += 1;
    let emitted = false;
    try {
      return await this.manager.withPurgeAllFence(async () => {
        // Snapshot the tracked set before `stopTracking` clears it, so the
        // diagnostic can name each container that lost its plaintext. Without
        // the snapshot an account change records nothing at all.
        const containerIds = new Set<string>([
          ...Array.from(this.subscriptions.keys()),
          ...Array.from(this.timers.keys()),
          ...Array.from(this.pullTimers.keys()),
          ...Array.from(this.openContainers.keys()),
        ]);
        try {
          containerIds.forEach((id) =>
            this.stopTracking(id, 'released-purged'),
          );
          this.desiredOpen = null;
          return await operation();
        } finally {
          // Unconditional, including on failure: a half-completed purge must
          // still tear the viewer down rather than leave plaintext on screen.
          //
          // The tracked set above is only what this service had subscriptions or
          // timers for. The manager reports the authoritative scope it is about
          // to remove (indexed containers, run-data directories, pending view
          // state), so an accepted share the recipient had closed is still named
          // in the diagnostic. Union rather than replace: the manager's report is
          // best-effort and must never shrink attribution.
          this.pendingPurgeAllScope.forEach((id) => containerIds.add(id));
          this.pendingPurgeAllScope.clear();
          emitted = true;
          this.emitPurge(
            { purged: 'all' },
            'account-changed',
            Array.from(containerIds),
          );
        }
      });
    } finally {
      this.purgeAllFenceDepth -= 1;
      // The manager can delete the bytes and then throw before the operation
      // above ever runs, which would leave the reported scope buffered and
      // unannounced. Nothing else drains it, so drain it here.
      if (!emitted && this.pendingPurgeAllScope.size > 0) {
        const orphaned = Array.from(this.pendingPurgeAllScope);
        this.pendingPurgeAllScope.clear();
        orphaned.forEach((id) => this.stopTracking(id, 'released-purged'));
        this.emitPurge({ purged: 'all' }, 'account-changed', orphaned);
      }
      this.pendingPurgeAllScope.clear();
    }
  }

  onSyncPhase(listener: PhaseListener): () => void {
    this.phaseListeners.add(listener);
    return () => this.phaseListeners.delete(listener);
  }

  emitSyncPhase(event: SharedContainerSyncPhaseEvent): void {
    this.phaseListeners.forEach((listener) => listener(event));
  }

  onChanged(listener: ChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private subscribe(containerId: string, identity: ReplicaIdentity): void {
    if (!this.transport.subscribe) return;
    const identityKey = replicaIdentityKey(identity);
    const existing = this.subscriptions.get(containerId);
    if (existing?.identityKey === identityKey) return;
    existing?.subscription.stop();
    const subscription = this.transport.subscribe({
      containerId,
      ...(identity.organizationId !== undefined
        ? { organizationId: identity.organizationId }
        : {}),
      onSignal: () => this.scheduleReconcile(containerId, identity),
      onAccessDenied: () => {
        // A stream status alone is not enough evidence to erase sensitive
        // local state: proxies and captive portals can synthesize 401/403
        // responses. Reconcile through the authenticated JSON transport, whose
        // well-formed access failure path owns the purge decision.
        void this.reconcile(containerId, identity, false).catch(
          () => undefined,
        );
      },
    });
    this.subscriptions.set(containerId, { identityKey, subscription });
  }

  private scheduleReconcile(
    containerId: string,
    identity: ReplicaIdentity,
  ): void {
    const previous = this.timers.get(containerId);
    if (previous) clearTimeout(previous);
    this.timers.set(
      containerId,
      setTimeout(() => {
        this.timers.delete(containerId);
        void this.reconcile(containerId, identity, false).catch(
          () => undefined,
        );
      }, RECONCILE_DEBOUNCE_MS),
    );
  }

  private scheduleFallbackPull(
    containerId: string,
    identity: ReplicaIdentity,
  ): void {
    const identityKey = replicaIdentityKey(identity);
    const previous = this.pullTimers.get(containerId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.pullTimers.delete(containerId);
      if (this.openContainers.get(containerId) !== identityKey) return;
      void this.reconcile(containerId, identity, false)
        .catch(() => undefined)
        .finally(() => {
          if (this.openContainers.get(containerId) === identityKey) {
            this.scheduleFallbackPull(containerId, identity);
          }
        });
    }, FALLBACK_PULL_MS);
    timer.unref?.();
    this.pullTimers.set(containerId, timer);
  }

  private async reconcile(
    containerId: string,
    identity: ReplicaIdentity,
    force: boolean,
    // Only the recipient's open resets the viewer layout. Realtime signals,
    // the fallback pull, and access rechecks seed, so a revision landing
    // mid-session never rearranges what the recipient is looking at.
    viewerLayoutMode: SharedContainerViewerLayoutMode = 'seed',
  ): Promise<SharedContainerReplicaState> {
    const authorizationEpoch = this.authorizationEpoch;
    const { organizationId } = identity;
    try {
      const state = await this.manager.sync(containerId, organizationId, {
        force,
        viewerLayoutMode,
        ...syncAccessOption(identity),
      });
      this.assertAuthorizationEpoch(authorizationEpoch);
      this.emitState(state);
      // A background sync can be what first hands the viewer a readable
      // replica, after an open that found nothing published or was blocked.
      this.markViewerSessionShown(state);
      return state;
    } catch (error) {
      this.assertAuthorizationEpoch(authorizationEpoch);
      if (
        error instanceof CanopyCloudClientError &&
        error.code === 'http-error' &&
        error.status === 404
      ) {
        try {
          await this.transport.resolveLatest(containerId, organizationId);
          this.assertAuthorizationEpoch(authorizationEpoch);
          // A successful probe establishes that access still exists, but does
          // not make stale plaintext persistent or turn the failed sync into a
          // successful open. Preserve the cache's existing lifecycle and
          // propagate the original revision failure below.
        } catch (probeError) {
          this.assertAuthorizationEpoch(authorizationEpoch);
          if (isValidatedAccessLoss(probeError, [403, 404])) {
            await this.purgeDeniedReplica(
              containerId,
              identity,
              authorizationEpoch,
            );
            this.assertAuthorizationEpoch(authorizationEpoch);
          }
        }
      } else if (isValidatedAccessLoss(error, [401, 403])) {
        await this.purgeDeniedReplica(
          containerId,
          identity,
          authorizationEpoch,
        );
        this.assertAuthorizationEpoch(authorizationEpoch);
      }
      throw error;
    }
  }

  private assertAuthorizationEpoch(expected: number): void {
    if (expected !== this.authorizationEpoch) {
      throw new DOMException(
        'Shared-container authorization changed',
        'AbortError',
      );
    }
  }

  /**
   * Records that the newest viewer session has a readable replica on screen.
   * Only once that session's open has returned: a sync that finishes while
   * the open is still on its way must not turn the open's reset into a seed.
   */
  private markViewerSessionShown(state: SharedContainerReplicaState): void {
    if (state.status !== 'available' && state.status !== 'pinned') return;
    const session = this.viewerSessions.get(state.containerId);
    if (session?.opened && !session.closed) session.shown = true;
  }

  private emitState(state: SharedContainerReplicaState): void {
    this.listeners.forEach((listener) => listener(state));
  }

  /**
   * Record the scope a whole-store purge is about to remove.
   *
   * Inside this service's own fence the scope is buffered so it joins that
   * fence's single emission. Outside it -- the manager self-healing through
   * its own `purgeAll()` -- it is emitted immediately, because nothing else
   * will: those bytes are gone, and a viewer rendering them has to be told.
   * Attribution must be self-draining rather than fence-dependent. The one
   * case that emits nothing is the one with nothing to say: an empty scope
   * with nothing tracked, handled below.
   */
  recordPurgeAllScope(containerIds: readonly string[]): void {
    if (this.purgeAllFenceDepth > 0) {
      containerIds.forEach((id) => this.pendingPurgeAllScope.add(id));
      return;
    }
    const tracked = new Set<string>([
      ...containerIds,
      ...Array.from(this.subscriptions.keys()),
      ...Array.from(this.timers.keys()),
      ...Array.from(this.pullTimers.keys()),
      ...Array.from(this.openContainers.keys()),
    ]);
    // Nothing was tracked and nothing was reported, so there is no viewer to
    // tear down and nothing to attribute. Emitting anyway would broadcast an
    // UNATTRIBUTABLE teardown -- the exact thing this subsystem exists to make
    // impossible -- and, because the renderer relists on every purge, would
    // close a purge -> relist -> integrity-recovery -> purge cycle that does
    // not settle while `purgeAllBytes()` keeps failing.
    if (tracked.size === 0) return;
    // Every other purge path bumps the epoch first, to cancel reads and syncs
    // that resolved just before the bytes went. Without it an in-flight
    // `reconcile()` -- from a realtime signal or the fallback poll, neither of
    // which passes through `open()`'s `desiredOpen` gate -- still passes its
    // `assertAuthorizationEpoch` and broadcasts fresh-looking state for a
    // container this purge just wiped.
    this.authorizationEpoch += 1;
    tracked.forEach((id) => this.stopTracking(id, 'released-purged'));
    this.desiredOpen = null;
    this.emitPurge(
      { purged: 'all' },
      'replica-store-unrecoverable',
      Array.from(tracked),
    );
  }

  /**
   * Attribute a purge performed by an authorization snapshot fence, which runs
   * inside the manager and therefore cannot call {@link purgeReplica}. Stops
   * tracking first so the container's timers and subscription do not outlive
   * bytes that are already gone, then emits the same diagnostic and scoped
   * broadcast every service-owned purge emits.
   */
  emitSnapshotPurge(containerId: string, scopeKey?: string): void {
    this.stopTracking(containerId, 'released-purged');
    this.emitPurge(
      { purged: 'container', containerId },
      // The direct listing is not an organization, so its removals read as
      // lost access rather than as a membership change.
      scopeKey === DIRECT_SHARED_CONTAINER_SCOPE_KEY
        ? 'access-denied'
        : 'organization-unauthorized',
    );
  }

  /**
   * The single construction site for purge payloads.
   *
   * Every purge is built here so a scope can never be malformed on its way to
   * the preload guard, which would drop the broadcast and strand decrypted
   * plaintext on screen.
   *
   * It is also where viewer-session records are dropped, because every purge
   * passes through here: the session map must not outlive the bytes it
   * describes. A late close for a dropped session then finds no record and
   * falls back to an unconditional release, which is harmless once the replica
   * is gone.
   */
  private emitPurge(
    scope: SharedContainerReplicaPurge,
    reason: SharedContainerReplicaPurgeReason,
    purgedContainerIds?: readonly string[],
  ): void {
    if (scope.purged === 'container') {
      this.viewerSessions.delete(scope.containerId);
    } else {
      this.viewerSessions.clear();
    }
    recordReplicaPurgeDiagnostic(
      purgedContainerIds ??
        (scope.purged === 'container' ? [scope.containerId] : []),
      reason,
    );
    this.listeners.forEach((listener) => listener(scope));
  }
}

let service: SharedContainerReconciliationService | null = null;

export function getSharedContainerReconciliationService(): SharedContainerReconciliationService {
  if (!service) {
    const created = new SharedContainerReconciliationService(
      new SharedContainerReplicaManager({
        transport: canopySharedContainerReplicaTransport,
        cleanupViewState: cleanupSharedContainerRuntime,
        projectViewerChats: (containerId, revisionId, options): Promise<void> =>
          projectSharedContainerViewerChats(
            containerId,
            revisionId,
            undefined,
            {
              ...options,
              // A reset drops the recipient's own browser sessions; stopping
              // them here keeps the browser service from restoring them.
              stopViewerBrowsers: (viewerContainerId: string): Promise<void> =>
                getBrowserService()?.destroyWorktree(
                  SHARED_CONTAINER_VIEWER_PROJECT_ID,
                  viewerContainerId,
                ) ?? Promise.resolve(),
            },
          ),
        refreshViewerBrowsers: (containerId: string): Promise<void> =>
          getBrowserService()?.refreshSharedContainerViewer(containerId) ??
          Promise.resolve(),
        onPhase: (event: SharedContainerSyncPhaseEvent): void =>
          created.emitSyncPhase(event),
        // An authorization snapshot purges below this service, so without this
        // the removal reaches neither the diagnostics nor the renderer. That
        // is the one purge a recipient is most likely to notice and least able
        // to explain: their access was revoked mid-read.
        onSnapshotContainerPurged: (
          containerId: string,
          scopeKey: string,
        ): void => created.emitSnapshotPurge(containerId, scopeKey),
        onPurgeAllScope: (containerIds: readonly string[]): void =>
          created.recordPurgeAllScope(containerIds),
      }),
      canopySharedContainerReplicaTransport,
    );
    service = created;
  }
  return service;
}
