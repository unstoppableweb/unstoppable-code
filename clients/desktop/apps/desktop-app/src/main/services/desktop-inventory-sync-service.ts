// ---------------------------------------------------------------------------
// Desktop inventory sync service (CAN-2830).
//
// Pushes the desktop's capability inventory — marketplaces, skills, MCP
// servers, Collections, per-worktree project pipelines, and the installed-item
// status snapshot — to the cloud as hash-diffed documents so the web reads
// them from the database instead of asking this machine live over Remote
// Control. The list documents are the exact `Portal*ListResult` shapes the
// portal browse commands already return, and `installed_items` is the
// snapshot the live installed-items command returns (built by the same
// readers), so nothing leaves the machine that the portal did not already
// transmit, and nothing is projected twice.
//
// Design: docs/planning/2026-09-06-desktop-inventory-cloud-sync/design.md
//
// Triggers: the invocable-inventory rebuild completing (plugins/skills/MCP and
// installed items), Collection / MCP index writes, installed-item and plugin
// selection changes, and worktree or pipeline mutations
// (`desktop-inventory-sync-signals`), cloud identity changes, the inventory
// sync gate opening, a periodic reconcile, and start-up. Every trigger
// coalesces through one trailing debounce; one flush runs at a time and a
// trigger during a flush gets its own push once that flush settles.
//
// Gate: the service pushes only while Allow incoming and the per-device
// inventory sync switch are both on (`inventory-sync-gate.ts`, CAN-5986) and
// the account holds cloud credentials. The server additionally enforces the
// Remote Control entitlement, and a 401/403/404 suspends pushing until the
// next identity change or gate flip. Allow incoming off only pauses uploads.
//
// Opt-out: turning the switch off closes the gate, aborts and settles the
// flush in flight (so a late PUT cannot recreate rows), forgets the local
// accepted-hash record, then sends one DELETE for this device under the
// account that opted out. The pending delete survives restarts (its marker
// lives in `remote-control.json`), retries on the upload ladder and then
// every five minutes (every six hours after a 405 or validated 404 from a
// web deploy without the route), waits while another account is signed in, and stops on
// a validated 401/403 until the credentials change. It does not depend on
// Allow incoming. Turning the switch back on drops the pending delete, waits
// for one in flight, cancels an opt-out still waiting for its flush to
// settle, and forces a full re-sync.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { BRAND } from '@canopy/brand/current';
import {
  DESKTOP_INVENTORY_DEVICE_SCOPE_KEY,
  DESKTOP_INVENTORY_KINDS,
  MAX_DESKTOP_INVENTORY_DOCUMENTS_PER_REQUEST,
  MAX_DESKTOP_INVENTORY_REMOVALS_PER_REQUEST,
  MAX_DESKTOP_INVENTORY_REQUEST_BYTES,
  stableStringify,
  parseWorktreeInventoryScopeKey,
  isDesktopInventoryDeleteResponse,
  type DesktopInventoryDocument,
  type DesktopInventoryKind,
  type DesktopInventoryManifestResponse,
  type DesktopInventoryDocumentOf,
  type DesktopInventoryPayloadMap,
  type DesktopInventoryRemoval,
  type DesktopInventorySyncRequest,
  type DesktopInventorySyncResponse,
} from '@canopy/protocol/desktop-inventory';
import {
  CanopyCloudClientError,
  type CanopyCloudCredentialContext,
  requestCanopyCloudJson,
} from '../canopy-cloud/client';
import {
  getCanopyCloudCredentials,
  subscribeCanopyCloudAccountChanges,
} from '../lib/canopy-cloud-account-store';
import { logMainProcessError } from '../lib/main-process-logging';
import { installedItemService } from '../installed-items/installed-item-service';
import { subscribeInvocableInventoryChanges } from '../plugins/invocable-inventory-service';
import { getInstallId } from '../lib/install-identity';
import {
  listWorktreePipelineInventoryDocuments,
  type WorktreePipelineInventoryRead,
} from './desktop-inventory-pipeline-documents';
import { subscribeDesktopInventoryChanges } from './desktop-inventory-sync-signals';
import {
  listRemoteControlMarketplaces,
  listRemoteControlMcpServers,
  listPersonalRemoteControlCollections,
  listPersonalRemoteControlSkills,
} from './plugin-catalog-service';

/** Trailing debounce so a burst of mutations produces one push. */
export const DESKTOP_INVENTORY_SYNC_DEBOUNCE_MS = 2_000;
/** Drift reconcile cadence; a no-op costs one small hash-only request. */
export const DESKTOP_INVENTORY_SYNC_RECONCILE_INTERVAL_MS = 30 * 60 * 1000;
/** Retry ladder for transient upload failures. */
export const DESKTOP_INVENTORY_SYNC_RETRY_MS = [
  15_000,
  60_000,
  5 * 60 * 1000,
] as const;

/** Steady-state retry interval for a pending delete once the ladder runs out. */
export const DESKTOP_INVENTORY_DELETE_STEADY_RETRY_MS = 5 * 60 * 1000;
/**
 * Retry interval after a 405, or a 404 from the Cloud API itself: a web
 * deploy that predates the delete route answers that way until a newer one
 * ships, which takes hours, not minutes. A start-up or credential change
 * still retries at once.
 */
export const DESKTOP_INVENTORY_DELETE_UNSUPPORTED_RETRY_MS = 6 * 60 * 60 * 1000;
/**
 * Longest an opt-out waits for the flush in flight to settle after aborting
 * it. The abort normally settles it at once; the bound keeps a wedged
 * request from holding the delete back forever.
 */
export const DESKTOP_INVENTORY_OPT_OUT_SETTLE_TIMEOUT_MS = 10_000;

/**
 * Aborting a PUT drops only the client side: one the server already
 * received can still commit after the delete. When the opt-out aborted a
 * flush, the delete is sent once more after this delay, and the marker
 * stays until that second delete succeeds.
 */
export const DESKTOP_INVENTORY_OPT_OUT_CONFIRM_DELAY_MS = 15_000;

/** What the settings row shows about this device's server-side delete. */
export type DesktopInventoryDeleteStatus = 'idle' | 'pending' | 'failed';

/** Main-owned callbacks for the opt-out delete; set once at start-up. */
export interface DesktopInventoryDeleteHooks {
  /**
   * Every key the signed-in account is known by, the opt-out marker's form
   * (Remote Control's `signedInAccount`) first; empty when signed out.
   */
  currentAccountKeys: () => readonly string[];
  /**
   * The delete for one account succeeded; clear its persisted marker under
   * `accountKeys`, every form that account had when the delete started.
   */
  onDeleteSucceeded: (accountKeys: readonly string[]) => Promise<void>;
  onDeleteStatusChanged: (status: DesktopInventoryDeleteStatus) => void;
}

/** Kinds with one document per device (empty scope key). */
export const DESKTOP_INVENTORY_DEVICE_KINDS = [
  'marketplaces',
  'skills',
  'mcp_servers',
  'collections',
  'installed_items',
] as const satisfies readonly DesktopInventoryKind[];

export type DesktopInventoryDeviceKind =
  (typeof DESKTOP_INVENTORY_DEVICE_KINDS)[number];

type DeviceKindReaders = {
  [K in DesktopInventoryDeviceKind]: () => Promise<
    DesktopInventoryPayloadMap[K]
  >;
};

interface Readers extends DeviceKindReaders {
  pipelines: () => Promise<WorktreePipelineInventoryRead>;
}

const DEFAULT_READERS: Readers = {
  marketplaces: listRemoteControlMarketplaces,
  skills: listPersonalRemoteControlSkills,
  mcp_servers: listRemoteControlMcpServers,
  collections: listPersonalRemoteControlCollections,
  // The status snapshot the live installed-items command and the settings
  // sections read; it starts no MCP probes.
  installed_items: () => installedItemService.listStatus(),
  pipelines: listWorktreePipelineInventoryDocuments,
};

export interface DesktopInventorySyncServiceOptions {
  readers?: Partial<Readers>;
  /** Injected for tests; defaults to `hostname()`. */
  clientName?: () => string;
  now?: () => Date;
}

export function hashDesktopInventoryPayload(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function deviceDocument<K extends DesktopInventoryDeviceKind>(
  kind: K,
  payload: DesktopInventoryPayloadMap[K],
  capturedAt: string,
): DesktopInventoryDocumentOf<K> {
  return {
    kind,
    scopeKey: DESKTOP_INVENTORY_DEVICE_SCOPE_KEY,
    contentHash: hashDesktopInventoryPayload(payload),
    capturedAt,
    payload,
  };
}

function documentIdentity(
  kind: DesktopInventoryKind,
  scopeKey: string,
): string {
  return `${kind} ${scopeKey}`;
}

function isSuspendingStatus(status: number | undefined): boolean {
  return status === 401 || status === 403 || status === 404;
}

/** A delete stops retrying on these until the credentials change. */
function isDeleteRefusedStatus(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

/**
 * A server without the delete route: Next answers 405, with no error body,
 * since the documents route serves only PUT and GET there. A 404 counts
 * only when the Cloud API itself said it; one a gateway, captive portal or
 * brand mismatch synthesizes is transient and stays on the ladder.
 */
function isDeleteUnsupported(error: CanopyCloudClientError): boolean {
  return (
    error.status === 405 ||
    (error.status === 404 && error.isValidatedServerError)
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Resolves when `promise` settles or after `timeoutMs`, whichever is first. */
async function settleWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    promise.then(
      (): void => undefined,
      (): void => undefined,
    ),
    new Promise<void>((resolve): void => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer !== null) clearTimeout(timer);
}

/**
 * Headroom kept under the request cap for the envelope (`clientDeviceId`,
 * `clientName`, JSON punctuation) so a batch measured by its members alone
 * still serializes under the server's hard limit.
 */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 16 * 1024;
const REQUEST_BUDGET_BYTES =
  MAX_DESKTOP_INVENTORY_REQUEST_BYTES - REQUEST_ENVELOPE_HEADROOM_BYTES;

/**
 * Kinds that always travel in a request of their own. A server older than
 * the kind rejects the whole request with 400 (`unknown kind`), which drops
 * the batch; alone, and sent after every other batch, such a kind can never
 * take other kinds' documents down with it.
 */
const OWN_REQUEST_KINDS: ReadonlySet<DesktopInventoryKind> =
  new Set<DesktopInventoryKind>(['installed_items']);

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** One request's worth of work, split to respect the wire limits. */
interface SyncBatch {
  documents: DesktopInventoryDocument[];
  removals: DesktopInventoryRemoval[];
}

/**
 * Split into requests that respect all three wire limits: documents per
 * request, removals per request, and total serialized bytes. Batches are
 * built incrementally by measured size, so six near-budget documents land
 * in separate requests instead of one 4 MiB-plus rejection. Removals go
 * FIRST, in their own batches: the server checks its per-device storage cap
 * before applying a request's removals, so a worktree replacement at the
 * cap only fits when the rows it frees are gone before the new rows arrive.
 * Documents of an {@link OWN_REQUEST_KINDS} kind go LAST, one per request,
 * so the batching of every other kind is unchanged.
 */
function splitIntoBatches(
  documents: readonly DesktopInventoryDocument[],
  removals: readonly DesktopInventoryRemoval[],
): SyncBatch[] {
  const batches: SyncBatch[] = [];
  let current: SyncBatch = { documents: [], removals: [] };
  let currentBytes = 0;
  const flush = (): void => {
    if (current.documents.length > 0 || current.removals.length > 0) {
      batches.push(current);
    }
    current = { documents: [], removals: [] };
    currentBytes = 0;
  };
  for (const removal of removals) {
    const bytes = utf8Bytes(removal);
    if (
      current.removals.length >= MAX_DESKTOP_INVENTORY_REMOVALS_PER_REQUEST ||
      (currentBytes + bytes > REQUEST_BUDGET_BYTES &&
        current.removals.length > 0)
    ) {
      flush();
    }
    current.removals.push(removal);
    currentBytes += bytes;
  }
  flush();
  for (const document of documents) {
    if (OWN_REQUEST_KINDS.has(document.kind)) continue;
    const bytes = utf8Bytes(document);
    if (
      current.documents.length >= MAX_DESKTOP_INVENTORY_DOCUMENTS_PER_REQUEST ||
      (currentBytes + bytes > REQUEST_BUDGET_BYTES &&
        current.documents.length > 0)
    ) {
      flush();
    }
    current.documents.push(document);
    currentBytes += bytes;
  }
  flush();
  for (const document of documents) {
    if (!OWN_REQUEST_KINDS.has(document.kind)) continue;
    current.documents.push(document);
    flush();
  }
  return batches;
}

export class DesktopInventorySyncService {
  private readonly readers: Readers;
  private readonly clientName: () => string;
  private readonly now: () => Date;

  /** Allow incoming and the inventory sync switch are both on. */
  private gateOpen = false;
  private started = false;
  private disposed = false;
  /** Set by a 401/403/404; cleared by an identity change or gate flip. */
  private suspended = false;

  private readonly pendingKinds = new Set<DesktopInventoryKind>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private retryAttempt = 0;
  private flushInFlight: Promise<void> | null = null;
  /** Aborts the requests of the flush in flight; replaced per flush. */
  private flushAbort: AbortController | null = null;

  /** The accounts whose documents for this device still need deleting. */
  private pendingDeleteAccounts: readonly string[] = [];
  /** The opt-out aborted a flush, so the delete is confirmed once more. */
  private confirmDeleteAfterAbort = false;
  private deleteHooks: DesktopInventoryDeleteHooks | null = null;
  private deleteInFlight: Promise<void> | null = null;
  private deleteRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private deleteRetryAttempt = 0;
  /** Set by a validated 401/403 on the delete; cleared by an identity change. */
  private deleteRefused = false;
  private deleteStatus: DesktopInventoryDeleteStatus = 'idle';
  /**
   * Bumped by every opt-out and opt-in. An opt-out captures it before it
   * waits for the flush in flight and gives up if it moved, so an opt-in
   * during that wait is never followed by the delete it cancelled.
   */
  private optSequence = 0;
  /**
   * Bumped on every cloud identity change. A flush captures it when it
   * starts and discards its own result if it moved, so a response for the
   * previous account can never update the current account's bookkeeping.
   */
  private identityGeneration = 0;
  /** Set when a flush found no cloud credentials; cleared by an identity change. */
  private awaitingCredentials = false;
  /** Set by the reconcile timer so the next flush re-sends unchanged documents. */
  private reconcilePending = false;
  /**
   * True once the cloud manifest for the current identity seeded
   * `acceptedHashes`. Removals are derived from that record, so until the
   * manifest is known (fresh start, identity change, or a failed fetch) the
   * service pushes documents but never deletes.
   */
  private manifestLoaded = false;

  /**
   * Content hashes the server last accepted, per document identity. In
   * memory on purpose: start-up always recomputes and pushes, and the server
   * answers a matching hash with `unchanged` without rewriting the row, so
   * persisting this map would only save one small request per launch. For
   * `pipelines` it is also the record of which worktree documents exist in
   * the cloud, so a worktree that disappears locally becomes a removal.
   */
  private readonly acceptedHashes = new Map<string, string>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(options: DesktopInventorySyncServiceOptions = {}) {
    this.readers = { ...DEFAULT_READERS, ...options.readers };
    this.clientName = options.clientName ?? ((): string => hostname());
    this.now = options.now ?? ((): Date => new Date());
  }

  /** Subscribe to every trigger and schedule the start-up push. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.unsubscribers.push(
      subscribeInvocableInventoryChanges((): void => {
        this.schedule([
          'marketplaces',
          'skills',
          'mcp_servers',
          'installed_items',
        ]);
      }),
      subscribeDesktopInventoryChanges((kinds): void => {
        this.schedule(kinds);
      }),
      subscribeCanopyCloudAccountChanges((): void => {
        // A different account (or a sign-out) invalidates every accepted
        // hash: the new identity has its own rows. Any flush in flight is
        // stale from here on (see identityGeneration).
        this.identityGeneration += 1;
        this.acceptedHashes.clear();
        this.manifestLoaded = false;
        this.suspended = false;
        this.awaitingCredentials = false;
        this.scheduleAll();
        // A pending delete runs only under the account that opted out; a
        // sign-in may be that account, and new credentials lift a refusal.
        this.deleteRefused = false;
        this.deleteRetryAttempt = 0;
        this.kickPendingDelete();
      }),
    );
    this.reconcileTimer = setInterval((): void => {
      // Reconcile must actually contact the server: unchanged documents are
      // re-sent (the server answers `unchanged` cheaply) so a row missing in
      // the cloud is restored even when nothing changed locally.
      this.reconcilePending = true;
      this.scheduleAll();
    }, DESKTOP_INVENTORY_SYNC_RECONCILE_INTERVAL_MS);
    this.scheduleAll();
  }

  /**
   * Open or close the inventory sync gate (Allow incoming and the switch;
   * see `inventory-sync-gate.ts`). Opening clears a suspension and schedules
   * every kind, so changes made while the gate was closed go out; closing
   * cancels the pending debounce and retry and aborts the flush in flight.
   */
  setGateOpen(open: boolean): void {
    if (this.gateOpen === open) return;
    this.gateOpen = open;
    if (open) {
      this.suspended = false;
      this.scheduleAll();
    } else {
      this.clearTimers();
      this.pendingKinds.clear();
      this.flushAbort?.abort();
    }
  }

  /** Main supplies the account and marker callbacks once at start-up. */
  setDeleteHooks(hooks: DesktopInventoryDeleteHooks): void {
    this.deleteHooks = hooks;
  }

  /** The delete status the Remote access settings row shows. */
  getDeleteStatus(): DesktopInventoryDeleteStatus {
    return this.deleteStatus;
  }

  /**
   * Restore a delete that an earlier session persisted but did not finish
   * (the marker in `remote-control.json`). Called once the Remote Control
   * settings load; empty means nothing is pending.
   */
  restorePendingDelete(accountKeys: readonly string[]): void {
    if (this.disposed) return;
    this.pendingDeleteAccounts = accountKeys;
    this.setDeleteStatus(accountKeys.length === 0 ? 'idle' : 'pending');
    this.kickPendingDelete();
  }

  /**
   * The user turned inventory sync off and confirmed. `accountKeys` are the
   * accounts the marker lists; signed out, the setting added none (nothing
   * of this account to delete). Closes the gate, aborts and settles the
   * flush in flight, forgets the accepted hashes, then sends the delete.
   * Resolves once the delete is sent or queued; its outcome arrives through
   * the delete status.
   */
  async optOut(accountKeys: readonly string[]): Promise<void> {
    if (this.disposed) return;
    this.optSequence += 1;
    const sequence = this.optSequence;
    if (this.flushInFlight) this.confirmDeleteAfterAbort = true;
    this.setGateOpen(false);
    this.flushAbort?.abort();
    if (this.flushInFlight) {
      await settleWithin(
        this.flushInFlight,
        DESKTOP_INVENTORY_OPT_OUT_SETTLE_TIMEOUT_MS,
      );
      // The user opted back in (or out again) while this waited: the later
      // call owns the delete marker, and arming it here would delete
      // documents sync is about to re-upload.
      if (this.disposed || sequence !== this.optSequence) return;
    }
    // Local state never waits on the delete: whatever it holds describes
    // documents the user asked to remove.
    this.acceptedHashes.clear();
    this.manifestLoaded = false;
    this.reconcilePending = false;
    this.pendingDeleteAccounts = accountKeys;
    this.deleteRefused = false;
    this.deleteRetryAttempt = 0;
    this.setDeleteStatus(accountKeys.length === 0 ? 'idle' : 'pending');
    this.kickPendingDelete();
  }

  /**
   * The user turned inventory sync back on. Drops the pending delete, waits
   * for a delete in flight to settle, then forces a full re-sync (the same
   * path as start-up or an identity change), which also replaces any
   * documents a delete that never succeeded left behind. The gate itself
   * opens from the Remote Control state.
   *
   * `keepDeleteFor` are the deletes the setting kept because they belong to
   * other accounts than the one signed in: this account's re-sync cannot
   * replace those accounts' documents, so their deletes stay pending.
   */
  async optIn(keepDeleteFor: readonly string[]): Promise<void> {
    if (this.disposed) return;
    // Cancels an opt-out still waiting for its flush to settle.
    this.optSequence += 1;
    const sequence = this.optSequence;
    this.pendingDeleteAccounts = keepDeleteFor;
    this.confirmDeleteAfterAbort = false;
    this.clearDeleteRetry();
    this.deleteRetryAttempt = 0;
    if (this.deleteInFlight) {
      await this.deleteInFlight;
      // Opted out again while this waited: that call owns the marker and the
      // status, which must not read idle while its delete is pending.
      if (this.disposed || sequence !== this.optSequence) return;
    }
    this.setDeleteStatus(keepDeleteFor.length === 0 ? 'idle' : 'pending');
    this.acceptedHashes.clear();
    this.manifestLoaded = false;
    this.suspended = false;
    this.scheduleAll();
    this.kickPendingDelete();
  }

  /** Coalesce a push of `kinds`; safe to call from any write path. */
  schedule(kinds: readonly DesktopInventoryKind[]): void {
    if (this.disposed || kinds.length === 0) return;
    for (const kind of kinds) this.pendingKinds.add(kind);
    if (!this.gateOpen || this.suspended) return;
    // While a transient failure is backing off, accumulate only: the retry
    // callback flushes everything pending when the delay expires.
    if (this.retryTimer !== null) return;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout((): void => {
      this.debounceTimer = null;
      void this.flush();
    }, DESKTOP_INVENTORY_SYNC_DEBOUNCE_MS);
  }

  scheduleAll(): void {
    this.schedule(DESKTOP_INVENTORY_KINDS);
  }

  /**
   * Build and push the pending kinds now. Exposed for tests and for the
   * shutdown path; production callers go through {@link schedule}.
   */
  async flush(): Promise<void> {
    if (this.flushInFlight) {
      // A trigger during a flush already re-added its kinds to the pending
      // set; the in-flight flush schedules a follow-up when it settles.
      return this.flushInFlight;
    }
    this.flushInFlight = this.runFlush().finally((): void => {
      this.flushInFlight = null;
      // A transient failure armed the retry ladder, and a missing credential
      // waits for the identity-change subscription; neither re-arms here.
      if (
        this.pendingKinds.size > 0 &&
        this.retryTimer === null &&
        !this.awaitingCredentials
      ) {
        this.schedule(Array.from(this.pendingKinds));
      }
    });
    return this.flushInFlight;
  }

  private async runFlush(): Promise<void> {
    // A delete in flight finishes first, so a re-sync after opting back in
    // can never be overtaken by the delete it follows.
    if (this.deleteInFlight) await this.deleteInFlight;
    if (this.disposed || !this.gateOpen || this.suspended) return;
    // Snapshot and clear: kinds that change while this flush is in flight
    // land in a fresh pending set and get their own push afterwards, so a
    // response for the OLD payload can never mark the NEW change as done.
    const kinds = Array.from(this.pendingKinds);
    this.pendingKinds.clear();
    if (kinds.length === 0) return;
    const generation = this.identityGeneration;
    const reconcile = this.reconcilePending;
    this.reconcilePending = false;
    const abort = new AbortController();
    this.flushAbort = abort;
    try {
      await this.runFlushRequests(kinds, generation, reconcile, abort.signal);
    } finally {
      if (this.flushAbort === abort) this.flushAbort = null;
    }
  }

  private async runFlushRequests(
    kinds: DesktopInventoryKind[],
    generation: number,
    initialReconcile: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    let reconcile = initialReconcile;

    // One credential context for the whole flush: the manifest read and
    // every upload it leads to speak for the same account, so removals
    // decided against one account's manifest can never be sent under an
    // account that signed in mid-flush.
    let credentials: CanopyCloudCredentialContext;
    try {
      credentials = await getCanopyCloudCredentials();
    } catch {
      // Keep the kinds pending without re-arming: the identity-change
      // subscription pushes as soon as the user signs in.
      this.awaitingCredentials = true;
      this.requeue(kinds);
      return;
    }

    const clientDeviceId = await getInstallId();
    if (this.flushAborted(generation)) {
      this.requeue(kinds);
      return;
    }
    if (!this.manifestLoaded) {
      const loaded = await this.loadManifest(
        clientDeviceId,
        generation,
        credentials,
        signal,
      );
      if (loaded === 'suspended') {
        this.requeue(kinds);
        return;
      }
      if (loaded === 'loaded') {
        reconcile = true;
        this.reconcilePending = false;
      }
    }

    const capturedAt = this.now().toISOString();
    const documents: DesktopInventoryDocument[] = [];
    const removals: DesktopInventoryRemoval[] = [];
    for (const kind of kinds) {
      if (kind === 'pipelines') {
        const result = await this.buildPipelineDocuments(capturedAt, reconcile);
        documents.push(...result.documents);
        removals.push(...result.removals);
        continue;
      }
      const document = await this.buildDeviceDocument(kind, capturedAt);
      if (document && (reconcile || !this.isAccepted(document))) {
        documents.push(document);
      }
    }
    if (documents.length === 0 && removals.length === 0) return;

    const clientName = this.clientName() || BRAND.displayName;
    try {
      for (const batch of splitIntoBatches(documents, removals)) {
        // Every request re-checks the gate and the identity: the reads and
        // the previous batch awaited, and meanwhile the flag may have turned
        // off, the service may have been disposed, or the account may have
        // changed. Never start an upload under a state that no longer holds.
        if (this.flushAborted(generation)) {
          this.requeue(kinds);
          return;
        }
        const request: DesktopInventorySyncRequest = {
          clientDeviceId,
          clientName,
          documents: batch.documents,
          ...(batch.removals.length > 0 ? { removals: batch.removals } : {}),
        };
        const response =
          await requestCanopyCloudJson<DesktopInventorySyncResponse>(
            `/api/v1/${BRAND.web.apiNamespace}/desktop-inventory/documents`,
            {
              method: 'PUT',
              body: JSON.stringify(request),
              credentialContext: credentials,
              signal,
            },
          );
        // The identity changed mid-flight: this response belongs to the
        // previous account and must not touch the new one's bookkeeping.
        if (generation !== this.identityGeneration) return;
        response.accepted.forEach((accepted): void => {
          this.acceptedHashes.set(
            documentIdentity(accepted.kind, accepted.scopeKey),
            accepted.contentHash,
          );
        });
        for (const removal of batch.removals) {
          this.acceptedHashes.delete(
            documentIdentity(removal.kind, removal.scopeKey),
          );
        }
      }
      this.retryAttempt = 0;
    } catch (error) {
      if (generation !== this.identityGeneration) return;
      if (isAbortError(error) || !this.gateOpen) {
        // The gate closed mid-request (opt-out or Allow incoming off): keep
        // the kinds for when it reopens, without arming a retry.
        this.requeue(kinds);
        return;
      }
      this.handleUploadFailure(error, kinds);
    }
  }

  /**
   * True once this flush must not issue another request: the service was
   * disposed, the inventory sync gate closed, or the account changed since the
   * flush started (`generation` is the identity it was started under).
   */
  private flushAborted(generation: number): boolean {
    return (
      this.disposed || !this.gateOpen || generation !== this.identityGeneration
    );
  }

  /**
   * Seed `acceptedHashes` from what the cloud holds for this device. On
   * success removals become possible; on a transient failure the flush
   * proceeds without removals and the next flush retries; on a validated
   * 401/403/404 the service suspends exactly as for an upload.
   */
  private async loadManifest(
    clientDeviceId: string,
    generation: number,
    credentials: CanopyCloudCredentialContext,
    signal: AbortSignal,
  ): Promise<'loaded' | 'skipped' | 'suspended'> {
    try {
      const manifest =
        await requestCanopyCloudJson<DesktopInventoryManifestResponse>(
          documentsPath(clientDeviceId),
          { credentialContext: credentials, signal },
        );
      if (generation !== this.identityGeneration || !this.gateOpen) {
        return 'skipped';
      }
      this.acceptedHashes.clear();
      for (const entry of manifest.documents) {
        this.acceptedHashes.set(
          documentIdentity(entry.kind, entry.scopeKey),
          entry.contentHash,
        );
      }
      this.manifestLoaded = true;
      // The manifest only tells what the cloud holds; the flush that follows
      // still uploads every document so syncedAt reflects this session and a
      // row the cloud lost is restored. The hashes serve removal discovery.
      this.reconcilePending = true;
      return 'loaded';
    } catch (error) {
      if (generation !== this.identityGeneration || isAbortError(error)) {
        return 'skipped';
      }
      // Only the Cloud API's own rejection suspends; a gateway or captive
      // portal synthesizing the status is a transient read failure.
      if (
        error instanceof CanopyCloudClientError &&
        isSuspendingStatus(error.status) &&
        error.isValidatedServerError
      ) {
        this.suspended = true;
        logMainProcessError('Desktop inventory sync suspended', error);
        return 'suspended';
      }
      logMainProcessError('Desktop inventory manifest read failed', error);
      return 'skipped';
    }
  }

  private isAccepted(document: DesktopInventoryDocument): boolean {
    return (
      this.acceptedHashes.get(
        documentIdentity(document.kind, document.scopeKey),
      ) === document.contentHash
    );
  }

  private async buildDeviceDocument(
    kind: DesktopInventoryDeviceKind,
    capturedAt: string,
  ): Promise<DesktopInventoryDocument | null> {
    try {
      // One branch per kind keeps the payload correlated with its
      // discriminant; indexing the readers by a union-typed key would only
      // yield the union of every payload.
      switch (kind) {
        case 'marketplaces':
          return deviceDocument(
            kind,
            await this.readers.marketplaces(),
            capturedAt,
          );
        case 'skills':
          return deviceDocument(kind, await this.readers.skills(), capturedAt);
        case 'mcp_servers': {
          const payload = await this.readers.mcp_servers();
          return deviceDocument(
            kind,
            {
              ...payload,
              servers: payload.servers.filter(
                (server): boolean => server.scope !== 'account',
              ),
            },
            capturedAt,
          );
        }
        case 'collections':
          return deviceDocument(
            kind,
            await this.readers.collections(),
            capturedAt,
          );
        case 'installed_items':
          return deviceDocument(
            kind,
            await this.readers.installed_items(),
            capturedAt,
          );
      }
    } catch (error) {
      // One unreadable kind must not block the others; the last accepted
      // document for it stays in the cloud until the reader recovers.
      logMainProcessError(`Desktop inventory read failed (${kind})`, error);
      return null;
    }
  }

  /**
   * One document per worktree, plus a removal for every worktree document
   * the cloud still holds (per the manifest-seeded accepted-hash record)
   * that no longer exists locally. Documents that read fine push even when
   * the read is incomplete; removals require a complete read and a loaded
   * manifest, so a transient error can never delete cloud rows.
   */
  private async buildPipelineDocuments(
    capturedAt: string,
    reconcile: boolean,
  ): Promise<SyncBatch> {
    let read: WorktreePipelineInventoryRead;
    try {
      read = await this.readers.pipelines();
    } catch (error) {
      logMainProcessError('Desktop inventory read failed (pipelines)', error);
      return { documents: [], removals: [] };
    }
    const documents: DesktopInventoryDocument<'pipelines'>[] = [];
    const currentScopeKeys = new Set<string>();
    for (const source of read.documents) {
      currentScopeKeys.add(source.scopeKey);
      const document: DesktopInventoryDocument<'pipelines'> = {
        kind: 'pipelines',
        scopeKey: source.scopeKey,
        contentHash: hashDesktopInventoryPayload(source.payload),
        capturedAt,
        payload: source.payload,
      };
      if (reconcile || !this.isAccepted(document)) documents.push(document);
    }
    const removals: DesktopInventoryRemoval[] = [];
    const nonPersonalWorkspaceIds = new Set(read.nonPersonalWorkspaceIds ?? []);
    if (this.manifestLoaded && nonPersonalWorkspaceIds.size > 0) {
      const prefix = documentIdentity('pipelines', '');
      for (const identity of Array.from(this.acceptedHashes.keys())) {
        if (!identity.startsWith(prefix)) continue;
        const scopeKey = identity.slice(prefix.length);
        const scope = parseWorktreeInventoryScopeKey(scopeKey);
        if (scope && nonPersonalWorkspaceIds.has(scope.workspaceLocalId)) {
          removals.push({ kind: 'pipelines', scopeKey });
        }
      }
    }
    // Removals need two authorities: the cloud manifest (what exists there)
    // and a complete local read (what exists here). Missing either, absence
    // is not proven and nothing is deleted.
    if (!this.manifestLoaded || !read.complete) return { documents, removals };
    const prefix = documentIdentity('pipelines', '');
    for (const identity of Array.from(this.acceptedHashes.keys())) {
      if (!identity.startsWith(prefix)) continue;
      const scopeKey = identity.slice(prefix.length);
      if (
        !currentScopeKeys.has(scopeKey) &&
        !removals.some((removal) => removal.scopeKey === scopeKey)
      ) {
        removals.push({ kind: 'pipelines', scopeKey });
      }
    }
    return { documents, removals };
  }

  /** Put kinds back without arming the debounce (the caller decides when). */
  private requeue(kinds: readonly DesktopInventoryKind[]): void {
    for (const kind of kinds) this.pendingKinds.add(kind);
  }

  private handleUploadFailure(
    error: unknown,
    kinds: readonly DesktopInventoryKind[],
  ): void {
    if (
      error instanceof CanopyCloudClientError &&
      isSuspendingStatus(error.status) &&
      error.isValidatedServerError
    ) {
      // Not entitled, not enabled, or the key is gone — said by the Cloud
      // API itself, not a gateway or captive portal synthesizing the status.
      // Stop trying until the identity or the gate changes; the kinds stay
      // queued for then.
      this.suspended = true;
      this.requeue(kinds);
      logMainProcessError('Desktop inventory sync suspended', error);
      return;
    }
    if (
      error instanceof CanopyCloudClientError &&
      error.isValidatedServerError &&
      error.status !== undefined &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 429
    ) {
      // A validation rejection will not fix itself by retrying the same
      // documents; drop them and let the next change rebuild them.
      logMainProcessError('Desktop inventory sync rejected', error);
      return;
    }
    this.requeue(kinds);
    const retryAfterMs =
      error instanceof CanopyCloudClientError && error.retryAfterMs
        ? error.retryAfterMs
        : DESKTOP_INVENTORY_SYNC_RETRY_MS[
            Math.min(
              this.retryAttempt,
              DESKTOP_INVENTORY_SYNC_RETRY_MS.length - 1,
            )
          ];
    this.retryAttempt += 1;
    // A change that arrived during the failed upload armed the debounce;
    // the retry ladder owns the timing from here.
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout((): void => {
      this.retryTimer = null;
      void this.flush();
    }, retryAfterMs);
  }

  // -------------------------------------------------------------------------
  // Opt-out delete
  // -------------------------------------------------------------------------

  private setDeleteStatus(status: DesktopInventoryDeleteStatus): void {
    if (this.deleteStatus === status) return;
    this.deleteStatus = status;
    this.deleteHooks?.onDeleteStatusChanged(status);
  }

  private clearDeleteRetry(): void {
    if (this.deleteRetryTimer !== null) {
      clearTimeout(this.deleteRetryTimer);
      this.deleteRetryTimer = null;
    }
  }

  /** Start the pending delete now unless one is running or must wait. */
  private kickPendingDelete(): void {
    if (
      this.disposed ||
      this.pendingDeleteAccounts.length === 0 ||
      this.deleteInFlight !== null ||
      this.deleteRefused
    ) {
      return;
    }
    this.clearDeleteRetry();
    const run = this.runPendingDelete().then(
      (succeeded): void => {
        if (this.deleteInFlight === run) this.deleteInFlight = null;
        // Another account may have signed in while this ran, its own
        // delete waiting behind this one: start it now.
        if (succeeded) this.kickPendingDelete();
      },
      (): void => {
        if (this.deleteInFlight === run) this.deleteInFlight = null;
      },
    );
    this.deleteInFlight = run;
  }

  /** The signed-in account's pending delete, if it has one. */
  private signedInPendingDelete(): string | undefined {
    const keys = this.deleteHooks?.currentAccountKeys() ?? [];
    return this.pendingDeleteAccounts.find((key) => keys.includes(key));
  }

  /** Resolves true once a delete succeeded and its marker went. */
  private async runPendingDelete(): Promise<boolean> {
    // Only the account that opted out may delete its documents; other
    // accounts' deletes (or all of them, signed out) wait for a sign-in.
    const accountKey = this.signedInPendingDelete();
    if (accountKey === undefined || this.deleteHooks === null) return false;
    const hooks = this.deleteHooks;
    // Every form of this account, captured now: by the time the request
    // returns, another account may be signed in, or none, and its forms
    // must neither clear that account's delete nor miss one of this one's.
    const accountForms: readonly string[] = [
      ...new Set([accountKey, ...hooks.currentAccountKeys()]),
    ];
    let credentials: CanopyCloudCredentialContext;
    try {
      credentials = await getCanopyCloudCredentials();
    } catch {
      return false; // The identity-change subscription retries on sign-in.
    }
    if (this.disposed || this.signedInPendingDelete() !== accountKey) {
      return false;
    }
    try {
      const clientDeviceId = await getInstallId();
      const response = await requestCanopyCloudJson<unknown>(
        documentsPath(clientDeviceId),
        { method: 'DELETE', credentialContext: credentials },
      );
      if (!isDesktopInventoryDeleteResponse(response)) {
        throw new Error('Inventory delete returned an unexpected response.');
      }
    } catch (error) {
      if (this.disposed || !this.pendingDeleteAccounts.includes(accountKey)) {
        return false;
      }
      this.setDeleteStatus('failed');
      if (
        error instanceof CanopyCloudClientError &&
        error.isValidatedServerError &&
        isDeleteRefusedStatus(error.status)
      ) {
        // The credentials cannot delete; wait for them to change.
        this.deleteRefused = true;
        logMainProcessError('Desktop inventory delete refused', error);
        return false;
      }
      if (
        error instanceof CanopyCloudClientError &&
        isDeleteUnsupported(error)
      ) {
        // The web deploy predates the route: retrying every five minutes
        // cannot help until a newer one ships.
        logMainProcessError('Desktop inventory delete unsupported', error);
        this.scheduleDeleteRetry(DESKTOP_INVENTORY_DELETE_UNSUPPORTED_RETRY_MS);
        return false;
      }
      // Anything else is transient.
      logMainProcessError('Desktop inventory delete failed', error);
      this.scheduleDeleteRetry();
      return false;
    }
    // Opting back in mid-request dropped the marker; the re-sync it started
    // waits for this request and then replaces whatever was deleted.
    if (!this.pendingDeleteAccounts.includes(accountKey)) return false;
    this.deleteRetryAttempt = 0;
    if (this.confirmDeleteAfterAbort) {
      // A PUT the opt-out aborted may still commit server-side; delete once
      // more before the marker goes.
      this.confirmDeleteAfterAbort = false;
      this.scheduleDeleteRetry(DESKTOP_INVENTORY_OPT_OUT_CONFIRM_DELAY_MS);
      return false;
    }
    // The marker may list several forms of this account; the delete covered
    // them all, and no other account's.
    this.pendingDeleteAccounts = this.pendingDeleteAccounts.filter(
      (key) => !accountForms.includes(key),
    );
    this.setDeleteStatus(
      this.pendingDeleteAccounts.length === 0 ? 'idle' : 'pending',
    );
    try {
      await hooks.onDeleteSucceeded(accountForms);
    } catch (error) {
      // The next start-up repeats an idempotent delete; nothing is lost.
      logMainProcessError('Desktop inventory delete marker not cleared', error);
    }
    return true;
  }

  /**
   * Retries the pending delete on the upload ladder, then steadily; an
   * explicit `fixedDelayMs` (the one confirming delete, or the long wait
   * after a 405 or validated 404) is used instead and leaves the ladder
   * where it is.
   */
  private scheduleDeleteRetry(fixedDelayMs?: number): void {
    if (this.disposed) return;
    let delayMs = fixedDelayMs;
    if (delayMs === undefined) {
      delayMs =
        this.deleteRetryAttempt < DESKTOP_INVENTORY_SYNC_RETRY_MS.length
          ? DESKTOP_INVENTORY_SYNC_RETRY_MS[this.deleteRetryAttempt]
          : DESKTOP_INVENTORY_DELETE_STEADY_RETRY_MS;
      this.deleteRetryAttempt += 1;
    }
    this.clearDeleteRetry();
    this.deleteRetryTimer = setTimeout((): void => {
      this.deleteRetryTimer = null;
      this.kickPendingDelete();
    }, delayMs);
  }

  private clearTimers(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Stop every timer and subscription. Called from runtime cleanup. */
  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    this.clearDeleteRetry();
    this.flushAbort?.abort();
    if (this.reconcileTimer !== null) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.pendingKinds.clear();
  }
}

function documentsPath(clientDeviceId: string): string {
  return `/api/v1/${BRAND.web.apiNamespace}/desktop-inventory/documents?clientDeviceId=${encodeURIComponent(clientDeviceId)}`;
}

let singleton: DesktopInventorySyncService | null = null;

export function getDesktopInventorySyncService(): DesktopInventorySyncService {
  if (!singleton) singleton = new DesktopInventorySyncService();
  return singleton;
}

export function resetDesktopInventorySyncServiceForTests(): void {
  if (process.env.NODE_ENV !== 'test') return;
  singleton?.dispose();
  singleton = null;
}
