import { createHash } from 'node:crypto';
import {
  CanopyClientError,
  type CanopyClientInstructionOptions,
} from '@canopy/core-client';
import {
  cloudAccountRouteIdentity,
  readCloudAccountRecord,
} from '@canopy/core-runtime/node/cloud-account/record';
import {
  CloudAccountEntryJsonSchema,
  type CanopyJsonValue,
  type CloudAccountCustodyView,
  type CoreCloudAccountProvisionParams,
  type CoreCloudAccountProvisionResult,
} from '@canopy/protocol/canopy-core';

/*
 * Provisions each connected daemon's own Cloud account record from this
 * app's sign-in (CAN-6997), so one desktop sign-in serves both and nobody
 * signs in to the daemon separately.
 *
 * The app's record stays the app's, written only by the app's store; the
 * daemon's record is written only by the daemon's authority. Provisioning
 * follows the app's changes best-effort and never gates them: an
 * unreachable daemon is brought up to date when it is next observed, and a
 * second daemon is provisioned on its own. Inert until account authority is
 * selected.
 */

export interface DaemonCloudAccountClient {
  readonly signal: AbortSignal;
  query(
    name: 'core.integration.cloudAccount.custody.get',
    params: { readonly endpointAuthority?: string },
    options?: CanopyClientInstructionOptions,
  ): Promise<CloudAccountCustodyView>;
  instruction(
    name: 'core.integration.cloudAccount.provision',
    params: CoreCloudAccountProvisionParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<CoreCloudAccountProvisionResult>;
}

export interface DaemonCloudAccountSession {
  readonly signal: AbortSignal;
  readonly client: DaemonCloudAccountClient;
  readonly lease: {
    readonly state: string;
    readonly lease?: { readonly leaseId: string } | null;
    register?(
      key: string,
      issue: (lease: { readonly leaseId: string }) => void,
    ): () => void;
  };
}

/** The app's sign-in as the route sees it: a whole entry, or signed out. */
export type ClientCloudAccountEntry = { readonly apiKey: string } | null;

export function cloudAccountCredentialDigest(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

/** An entry as it crosses to the daemon: JSON, without the app's loss handoff. */
function provisionedEntry(
  entry: NonNullable<ClientCloudAccountEntry>,
): Record<string, CanopyJsonValue> {
  const json = CloudAccountEntryJsonSchema.parse(
    JSON.parse(JSON.stringify(entry)),
  );
  delete json.organizationAccessLossState;
  return json;
}

/** The daemon custody an intent's first write was sent against. */
interface CustodyFence {
  readonly digest: string | null;
  readonly generation: number;
}

function fenceOf(view: CloudAccountCustodyView): CustodyFence {
  return {
    digest: view.credentialDigest,
    generation: view.credentialGeneration ?? 0,
  };
}

function sameFence(a: CustodyFence, b: CustodyFence): boolean {
  return a.digest === b.digest && a.generation === b.generation;
}

/** Whether a read shows this endpoint's custody at all. */
function readable(
  view: CloudAccountCustodyView,
  endpointAuthority: string,
): boolean {
  return (
    view.state !== 'unavailable' && view.endpointAuthority === endpointAuthority
  );
}

/**
 * Whether a custody read holds this sign-in's credential under the route
 * identity launch admission binds to, expired or not.
 */
function holdsCredential(
  view: CloudAccountCustodyView,
  entry: ClientCloudAccountEntry,
  target: string | null,
): boolean {
  if (entry === null || target === null || view.credentialDigest !== target)
    return false;
  // As the daemon parsed it; the matching digest proves its key is this one.
  const wanted = readCloudAccountRecord(provisionedEntry(entry));
  const held = view.entry
    ? readCloudAccountRecord({ ...view.entry, apiKey: entry.apiKey })
    : null;
  return (
    wanted !== null &&
    held !== null &&
    cloudAccountRouteIdentity(held) === cloudAccountRouteIdentity(wanted)
  );
}

/**
 * Whether a custody read shows the daemon serving this sign-in: signed out,
 * or holding its unexpired credential under the route identity launch
 * admission binds to.
 */
function holdsSignIn(
  view: CloudAccountCustodyView,
  entry: ClientCloudAccountEntry,
  target: string | null,
): boolean {
  if (target === null) return view.credentialDigest === null;
  return (
    view.state === 'active' &&
    !view.sessionExpired &&
    holdsCredential(view, entry, target)
  );
}

/** The sign-in provisioning follows: its credential and route identity. */
interface Target {
  readonly digest: string | null;
  readonly identity?: string;
}

function sameTarget(a: Target, b: Target): boolean {
  return a.digest === b.digest && a.identity === b.identity;
}

interface SignIn {
  readonly entry: ClientCloudAccountEntry;
  readonly target: Target;
}

/**
 * What a session's daemon is being brought to, from a sign-in change or an
 * observation, until one of its owners reconciles it. Its first write fixes
 * its fence, which every later owner keeps across follow-ups, gets, leases
 * and clients: once custody moved past it, they only read, so no timeout or
 * retry writes over another client's change. A new session starts its own:
 * without a daemon identity it may be another daemon, which must still be
 * provisioned. Revisit when custody reads carry a daemon identity.
 */
interface Intent {
  readonly target: Target;
  /**
   * An explicit sign-out: until it settles, it sends a fenced clear even to
   * an empty custody, superseding this app's provisions still in transit.
   */
  readonly signOut: boolean;
  fence?: CustodyFence;
  /** Reconciled, including by reading custody past the fence. */
  settled: boolean;
}

interface Held {
  readonly session: DaemonCloudAccountSession;
  client?: DaemonCloudAccountClient;
  /** The latest lease observed; an owner of an earlier one stops. */
  leaseId?: string;
  intent?: Intent;
  queue: Promise<void>;
  owner?: Owner;
  unregister?: () => void;
  unwatch?: () => void;
}

/**
 * The one reconciliation of a session's daemon with the app's sign-in: a
 * fresh observation on a lease and client, or a sign-in change. Only the
 * session's current owner sends a write or records an outcome, and an owner
 * stops once its lease, client or revision is replaced.
 */
interface Owner {
  readonly held: Held;
  readonly kind: 'observation' | 'change';
  readonly revision: number;
  readonly leaseId: string | undefined;
  readonly client: DaemonCloudAccountClient;
  readonly controller: AbortController;
  /** A change's sign-in, known before its owner reads it. */
  readonly changeTarget?: Target;
  signIn?: SignIn;
  intent?: Intent;
  /** Yielding to another writer's change counts as reconciled: it stands. */
  outcome: 'pending' | 'reconciled' | 'unreconciled';
  /** This sign-in's credential if the owner's last custody read served it. */
  heldDigest: string | null | undefined;
}

/**
 * A sign-in sent against an empty custody that may still land at its fence.
 * Its client is released when it closes, leaving a marker.
 */
interface LandableWrite {
  client?: DaemonCloudAccountClient;
  readonly endpointAuthority: string;
  readonly generation: number;
  unwatch?: () => void;
}

/** A request ran out of time; one cancelled by its owner or client did not. */
class RequestTimedOut extends Error {}

const REQUEST_TIMEOUT_MS = 10_000;
/** Retry same-generation contention only, never a new custody intent. */
const PROVISION_ATTEMPTS = 3;
/** Re-asks after a timeout; the daemon's probe deadline is 15 s plus billing. */
const VERIFICATION_FOLLOW_UPS = 2;

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Feeds a route the app's store commits and session status changes; returns
 * the unsubscribe. Provisioning composes it with the app's store.
 */
export function followAppCloudAccount(
  route: Pick<DaemonCloudAccountRoute, 'committed' | 'rejectionChanged'>,
  app: {
    readonly subscribeCommits: (
      listener: (entry: ClientCloudAccountEntry) => void,
    ) => () => void;
    readonly subscribeSessionStatus: (listener: () => void) => () => void;
    /** The store's loaded entry; signed out also while it holds none. */
    readonly peek: () => ClientCloudAccountEntry;
  },
): () => void {
  const commits = app.subscribeCommits((entry) => route.committed(entry));
  // A signed-out peek, including an unloaded store's, updates nothing.
  const status = app.subscribeSessionStatus(() =>
    route.rejectionChanged(app.peek()),
  );
  return () => {
    commits();
    status();
  };
}

export type DaemonCloudAccountRoute = ReturnType<
  typeof createDaemonCloudAccountRoute
>;

export function createDaemonCloudAccountRoute(options: {
  readonly selected: boolean;
  /** The app's current sign-in; throws when its store is unreadable. */
  readonly current: () => Promise<ClientCloudAccountEntry>;
  /** Known client rejection only; acceptance must come from the daemon's probe. */
  readonly credentialRejected?: (apiKey: string) => boolean;
  readonly endpointAuthority: () => string;
}): {
  observe(session: DaemonCloudAccountSession): void;
  /** The app's sign-in changed: bring every observed daemon up to date. */
  changed(entry: ClientCloudAccountEntry): void;
  /**
   * The app's store committed this entry. A sign-out after any other commit,
   * or a different credential or route identity than the sign-in last
   * followed, is a sign-in change; a capability or metadata save, or a
   * repeated sign-out, provisions nothing, so it cannot undo another
   * client's change to a daemon.
   */
  committed(entry: ClientCloudAccountEntry): void;
  /**
   * The app's known rejection of its credential changed. Updates only the
   * daemons that still hold this sign-in; never writes it back elsewhere.
   */
  rejectionChanged(entry: ClientCloudAccountEntry): void;
  /**
   * Whether a connected daemon holds the credential this app holds now, so
   * launch admission may describe account routes as daemon-served. As of the
   * last custody read: another client's later sign-out shows only after the
   * next observation, and the daemon's own admission still gates launches.
   */
  provisioned(client?: DaemonCloudAccountClient): boolean;
  /** Waits for pending reconciliation and binds launch intent to this account. */
  admissionIdentity(
    client: DaemonCloudAccountClient,
  ): Promise<string | undefined>;
  /** Settles queued provisioning; tests and quit. */
  idle(): Promise<void>;
} {
  const sessions = new Map<DaemonCloudAccountSession, Held>();
  let wanted: Target | undefined;
  /** The store's latest commit, whether or not it changed the sign-in. */
  let lastCommitted: Target | undefined;
  let revision = 0;
  /** Counts the store's commits, so a read a commit outdated is read again. */
  let commits = 0;
  /**
   * Digests of every sign-in this app sent, on any session. Custody that
   * moved past an intent's fence to one of them, other than the intent's
   * own, is written over again: only this app's own late write from another
   * session, or a client signing in with a key this app left, puts it there.
   */
  const sentDigests = new Set<string>();
  /**
   * This app's sign-in writes sent against an empty custody, on any session,
   * from send (a failed lease can report its end late) until they can no
   * longer land: their reply, or a later generation read through their own
   * client. Without a daemon identity, no other client's read shows a write's
   * daemon moved past its fence, so a closed client's write stays a marker,
   * one per endpoint and generation, for the process's life: at worst an
   * empty clear of a fresh daemon at that fence. Revisit when custody reads
   * carry a daemon identity. Matching the endpoint is sound: the daemon
   * refuses a write for another one.
   */
  const landable = new Set<LandableWrite>();

  function inTransit<T>(
    client: DaemonCloudAccountClient,
    endpointAuthority: string,
    generation: number,
    sent: Promise<T>,
  ): Promise<T> {
    const write: LandableWrite = { client, endpointAuthority, generation };
    const closed = (): void => {
      write.client = undefined;
      write.unwatch = undefined;
      for (const other of landable)
        if (
          other !== write &&
          other.client === undefined &&
          other.endpointAuthority === endpointAuthority &&
          other.generation === generation
        ) {
          landable.delete(write);
          return;
        }
    };
    landable.add(write);
    // Closures hold the signal only, so they never retain the client.
    const { signal } = client;
    if (signal.aborted) closed();
    else {
      signal.addEventListener('abort', closed, { once: true });
      write.unwatch = (): void => signal.removeEventListener('abort', closed);
    }
    // A rejected write may still have reached the daemon.
    void sent.then(
      () => drop(write),
      () => undefined,
    );
    return sent;
  }

  function drop(write: LandableWrite): void {
    write.unwatch?.();
    landable.delete(write);
  }

  /** Generations only increase, so a later one fences the write for good. */
  function passed(
    client: DaemonCloudAccountClient,
    endpointAuthority: string,
    view: CloudAccountCustodyView,
  ): void {
    if (!readable(view, endpointAuthority)) return;
    const { generation } = fenceOf(view);
    for (const write of landable)
      if (
        write.client === client &&
        write.endpointAuthority === endpointAuthority &&
        generation > write.generation
      )
        drop(write);
  }

  function landableAt(endpointAuthority: string, generation: number): boolean {
    for (const write of landable)
      if (
        write.endpointAuthority === endpointAuthority &&
        write.generation === generation
      )
        return true;
    return false;
  }

  function forget(session: DaemonCloudAccountSession): void {
    const held = sessions.get(session);
    if (!held) return;
    held.unregister?.();
    held.unwatch?.();
    sessions.delete(session);
  }

  function registerRecovery(session: DaemonCloudAccountSession): void {
    const held = sessions.get(session);
    if (!held || session.signal.aborted) return;
    held.unregister?.();
    held.unregister = session.lease.register?.('cloud-account', (lease) =>
      observeSignIn(session, lease.leaseId),
    );
  }

  /**
   * One observation of the app's sign-in per lease and client. Repeated gets
   * and an active lease's registration replay are covered by its owner, so
   * another client's later change stands. A new lease or client is a recovery
   * and observes again; so does the next get after an owner ends unreconciled.
   * Either keeps the fence of an unsettled intent's sent write.
   */
  function observeSignIn(
    session: DaemonCloudAccountSession,
    leaseId: string | undefined,
  ): void {
    const held = sessions.get(session);
    if (!held) return;
    held.leaseId = leaseId;
    const client = trackClient(session);
    const { owner } = held;
    // Nothing to reconcile without a usable client: the next get or the
    // recovered lease's replay observes the one it gets.
    if (
      !client ||
      (owner !== undefined &&
        owner.leaseId === leaseId &&
        owner.client === client &&
        owner.outcome !== 'unreconciled')
    )
      return;
    start(held, 'observation', options.current);
  }

  /**
   * Whether an entry is the sign-in last followed, by the route and by every
   * owner: an observation can read a commit before its notification, which
   * must still reach the daemons reconciled before it. A change compares its
   * own sign-in before reading it; an observation still reading matches,
   * since `reconcile` reads again after any commit during its read.
   */
  function following(entry: ClientCloudAccountEntry): boolean {
    const next = targetOf(entry);
    const same = (target: Target | undefined): boolean =>
      target === undefined || sameTarget(target, next);
    return (
      wanted !== undefined &&
      same(wanted) &&
      [...sessions.values()].every(({ owner }) =>
        same(owner?.signIn?.target ?? owner?.changeTarget),
      )
    );
  }

  function targetOf(entry: ClientCloudAccountEntry): Target {
    const record = entry && readCloudAccountRecord(entry);
    return {
      digest: entry?.apiKey.trim()
        ? cloudAccountCredentialDigest(entry.apiKey)
        : null,
      ...(record && { identity: cloudAccountRouteIdentity(record) }),
    };
  }

  function usable(
    session: DaemonCloudAccountSession,
  ): DaemonCloudAccountClient | null {
    const state = session.lease.state;
    if (session.signal.aborted || state === 'released' || state === 'failed') {
      forget(session);
      return null;
    }
    if (state !== 'active') return null;
    try {
      // A lease replaces its client in place; its getter can refuse during recovery.
      const client = session.client;
      return client.signal.aborted ? null : client;
    } catch {
      return null;
    }
  }

  function trackClient(
    session: DaemonCloudAccountSession,
  ): DaemonCloudAccountClient | null {
    const client = usable(session);
    const held = sessions.get(session);
    if (!held || !client || held.client === client) return client;
    held.unwatch?.();
    held.client = client;
    const disconnected = (): void => {
      // Retained lease ids do not replay already-issued registrations.
      if (held.client === client && !session.signal.aborted)
        registerRecovery(session);
    };
    // Watch before any queued account read: a disconnect during that read
    // must also rearm reconciliation when recovery retains the lease id.
    client.signal.addEventListener('abort', disconnected, { once: true });
    held.unwatch = (): void =>
      client.signal.removeEventListener('abort', disconnected);
    return client;
  }

  /** Checked before every send and before applying every reply. */
  function alive(owner: Owner): boolean {
    const { held } = owner;
    return (
      sessions.get(held.session) === held &&
      held.owner === owner &&
      owner.revision === revision &&
      held.leaseId === owner.leaseId &&
      !owner.controller.signal.aborted &&
      trackClient(held.session) === owner.client
    );
  }

  /**
   * The one writer of an owner's state. Only the owner's own reconciliation
   * passes an outcome; a replaced owner records nothing. A reconciled owner
   * settles its intent, including by reading custody past its fence.
   */
  function settle(
    owner: Owner,
    heldDigest: string | null | undefined,
    outcome?: Owner['outcome'],
  ): void {
    const { held, intent } = owner;
    if (held.owner !== owner) return;
    owner.heldDigest = heldDigest;
    if (outcome) owner.outcome = outcome;
    if (outcome === 'reconciled' && intent && held.intent === intent)
      intent.settled = true;
  }

  /**
   * The session's intent for a sign-in an owner read: its unsettled intent
   * for that same sign-in, with any fence already sent, or a new one. So a
   * recovery after the intent settled re-asserts the app's sign-in over
   * another client's change, as never refusing the user's sign-in requires;
   * revisit if a re-assertion should need a new app sign-in.
   */
  function intentOf(held: Held, target: Target): Intent {
    const { intent } = held;
    if (intent && !intent.settled && sameTarget(intent.target, target))
      return intent;
    held.intent = { target, signOut: false, settled: false };
    return held.intent;
  }

  /** Replaces the session's owner; the previous one stops at its next check. */
  function start(
    held: Held,
    kind: Owner['kind'],
    read: () => Promise<ClientCloudAccountEntry>,
    changeTarget?: Target,
  ): void {
    held.owner?.controller.abort();
    held.owner = undefined;
    const client = trackClient(held.session);
    if (!client || sessions.get(held.session) !== held) return;
    const owner: Owner = {
      held,
      kind,
      revision,
      leaseId: held.leaseId,
      client,
      controller: new AbortController(),
      ...(changeTarget && { changeTarget }),
      outcome: 'pending',
      heldDigest: undefined,
    };
    held.owner = owner;
    held.queue = held.queue.then(() => reconcile(owner, read));
  }

  async function request<T>(
    owner: Owner,
    send: (requestOptions: CanopyClientInstructionOptions) => Promise<T>,
    mutation = false,
  ): Promise<T> {
    const { client } = owner;
    const fenced = AbortSignal.any([owner.controller.signal, client.signal]);
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    // An issued write can commit after local cancellation, so only its
    // session cancels it: the next owner's read queues behind it.
    const signal = AbortSignal.any([
      mutation ? owner.held.session.signal : fenced,
      client.signal,
      deadline,
    ]);
    try {
      return await untilAborted(
        send({
          metadata: {
            deadlineAt: new Date(Date.now() + REQUEST_TIMEOUT_MS).toISOString(),
          },
          signal,
        }),
        signal,
      );
    } catch (error) {
      // The client's own RPC deadline can reject before the local timer.
      if (
        (deadline.aborted ||
          (error instanceof CanopyClientError &&
            error.payload.kind === 'deadline_exceeded')) &&
        !fenced.aborted
      )
        throw new RequestTimedOut();
      throw error;
    }
  }

  async function readCustody(
    owner: Owner,
    endpointAuthority: string,
  ): Promise<CloudAccountCustodyView> {
    const view = await request(owner, (requestOptions) =>
      owner.client.query(
        'core.integration.cloudAccount.custody.get',
        { endpointAuthority },
        requestOptions,
      ),
    );
    passed(owner.client, endpointAuthority, view);
    return view;
  }

  /** Call only right after `alive`: the write is sent in the same turn. */
  async function provision(
    owner: Owner,
    { entry, target }: SignIn,
    endpointAuthority: string,
    fence: CustodyFence,
  ): Promise<CoreCloudAccountProvisionResult> {
    const { client } = owner;
    const provisioned =
      entry !== null && target.digest !== null ? provisionedEntry(entry) : null;
    if (provisioned !== null && target.digest !== null)
      sentDigests.add(target.digest);
    const result = await request(
      owner,
      (requestOptions) => {
        const write = client.instruction(
          'core.integration.cloudAccount.provision',
          {
            endpointAuthority,
            entry: provisioned,
            expectedCredentialDigest: fence.digest,
            expectedCredentialGeneration: fence.generation,
            ...(rejected(entry) ? { credentialRejected: true } : {}),
          },
          requestOptions,
        );
        return provisioned !== null && fence.digest === null
          ? inTransit(client, endpointAuthority, fence.generation, write)
          : write;
      },
      true,
    );
    passed(client, endpointAuthority, result.custody);
    return result;
  }

  function rejected(entry: ClientCloudAccountEntry): boolean {
    return (
      entry !== null && options.credentialRejected?.(entry.apiKey) === true
    );
  }

  /**
   * The sign-in's credential if `view` serves it; never a known-rejected key.
   * `invalid` is the daemon's answer for this entry, which a retry repeats.
   */
  function served(
    view: CloudAccountCustodyView,
    signIn: SignIn,
    status?: CoreCloudAccountProvisionResult['status'],
  ): string | null | undefined {
    return status !== 'invalid' &&
      holdsSignIn(view, signIn.entry, signIn.target.digest) &&
      !rejected(signIn.entry)
      ? signIn.target.digest
      : undefined;
  }

  async function reconcile(
    owner: Owner,
    read: () => Promise<ClientCloudAccountEntry>,
  ): Promise<void> {
    let ending: { readonly heldDigest: string | null | undefined } | undefined;
    try {
      // A commit during the read may have outdated it, and `following` then
      // counted this owner as matching: read again.
      let entry: ClientCloudAccountEntry;
      let seen: number;
      do {
        seen = commits;
        entry = await untilAborted(read(), owner.controller.signal);
      } while (seen !== commits && alive(owner));
      if (alive(owner)) {
        const signIn: SignIn = { entry, target: targetOf(entry) };
        owner.signIn = signIn;
        if (owner.kind === 'observation') wanted = signIn.target;
        const intent = intentOf(owner.held, signIn.target);
        owner.intent = intent;
        ending = await provisionSignIn(owner, signIn, intent);
      }
    } catch {
      // Not served, not reachable or refused: the app's own sign-in is
      // unaffected, and the next get tries again.
    }
    settle(owner, ending?.heldDigest, ending ? 'reconciled' : 'unreconciled');
  }

  /**
   * Writes only against the intent's fence: the custody its first write was
   * sent against, kept by contention retries, timeout follow-ups and every
   * later owner of the intent. Until a write is sent, each read may set it,
   * so a follow-up after a timed-out read writes against what it reads, as
   * a slow read would have. Resolves unreconciled as `undefined`.
   */
  async function provisionSignIn(
    owner: Owner,
    signIn: SignIn,
    intent: Intent,
  ): Promise<{ readonly heldDigest: string | null | undefined } | undefined> {
    const endpointAuthority = options.endpointAuthority();
    let followUps = VERIFICATION_FOLLOW_UPS;
    let attempts = 0;
    let view: CloudAccountCustodyView | undefined;
    for (;;) {
      try {
        view ??= await readCustody(owner, endpointAuthority);
        if (!alive(owner) || !readable(view, endpointAuthority))
          return undefined;
        // Nothing to clear on a daemon that holds no credential, unless this
        // is an unsettled explicit sign-out or a sign-in this app sent is in
        // transit at its custody's fence: that clear supersedes it. Any other
        // clear advances the generation under another client's newer sign-in.
        if (
          !(intent.signOut && !intent.settled) &&
          signIn.target.digest === null &&
          view.credentialDigest === null &&
          !landableAt(endpointAuthority, fenceOf(view).generation)
        )
          return { heldDigest: null };
        let fence = intent.fence ?? fenceOf(view);
        // Custody moved past the intent's fence, by its own landed write or
        // another writer's clear or replacement. Never write again: only
        // record whether the daemon now holds this sign-in, without waiting
        // for its probe (which alone qualifies managed admission). Except
        // over a replaced sign-in this app sent itself, as one landing late
        // from another of its sessions: those share no queue, so the intent
        // re-fences at that custody and writes again.
        if (!sameFence(fenceOf(view), fence)) {
          if (
            view.credentialDigest === null ||
            view.credentialDigest === signIn.target.digest ||
            !sentDigests.has(view.credentialDigest)
          )
            return { heldDigest: served(view, signIn) };
          fence = fenceOf(view);
        }
        if (attempts === PROVISION_ATTEMPTS) return undefined;
        attempts += 1;
        intent.fence = fence;
        const result = await provision(owner, signIn, endpointAuthority, fence);
        view = result.custody;
        // A reply whose custody could not be read reconciled nothing,
        // whatever its status.
        if (!alive(owner) || !readable(view, endpointAuthority))
          return undefined;
        // The status is this write's; the custody is read after the daemon's
        // verification, so another client may have replaced it with the same
        // key under another account meanwhile. `superseded` rechecks the
        // returned custody against the fence.
        if (result.status !== 'superseded')
          return { heldDigest: served(view, signIn, result.status) };
      } catch (error) {
        // A timed-out write can still land, and the daemon's shared
        // verification outlives the request: re-read under the same fence so
        // later launches see the result, never beyond the owner's life.
        if (
          !(error instanceof RequestTimedOut) ||
          followUps === 0 ||
          !alive(owner)
        )
          throw error;
        followUps -= 1;
        view = undefined;
      }
    }
  }

  /**
   * Brings a daemon that still holds the owner's sign-in up to date with the
   * app's known rejection, after the owner settles. Never writes the sign-in
   * back elsewhere, and leaves the owner's outcome alone.
   */
  async function amendRejection(owner: Owner): Promise<void> {
    const { signIn } = owner;
    try {
      const endpointAuthority = options.endpointAuthority();
      if (!signIn || !alive(owner)) return;
      const view = await readCustody(owner, endpointAuthority);
      if (!alive(owner) || !readable(view, endpointAuthority)) return;
      // A daemon whose session state already matches, as after the owner's
      // own write carried this rejection, needs no second write.
      if (
        !holdsCredential(view, signIn.entry, signIn.target.digest) ||
        view.sessionExpired === rejected(signIn.entry)
      ) {
        settle(owner, served(view, signIn));
        return;
      }
      const result = await provision(
        owner,
        signIn,
        endpointAuthority,
        fenceOf(view),
      );
      if (alive(owner) && readable(result.custody, endpointAuthority))
        settle(owner, served(result.custody, signIn, result.status));
    } catch {
      // The owner's outcome stands; the next recovery reconciles again.
    }
  }

  function changed(entry: ClientCloudAccountEntry): void {
    if (!options.selected) return;
    revision += 1;
    const target = targetOf(entry);
    wanted = target;
    lastCommitted = target;
    for (const held of sessions.values()) {
      // Installed even without a usable client, so a recovery fences it.
      held.intent = { target, signOut: target.digest === null, settled: false };
      start(held, 'change', () => Promise.resolve(entry), target);
    }
  }

  return {
    observe(session): void {
      if (!options.selected || session.signal.aborted) return;
      // A get of a lease and client not yet observed reconciles the daemon
      // with the app's sign-in as it is now, before registration replays it.
      const first = !sessions.has(session);
      if (first) sessions.set(session, { session, queue: Promise.resolve() });
      observeSignIn(session, session.lease.lease?.leaseId);
      if (first) {
        // Lease recovery need not be followed by another get()/observation.
        // Re-read the committed client record, including a missed sign-out.
        registerRecovery(session);
        session.signal.addEventListener('abort', () => forget(session), {
          once: true,
        });
      }
    },
    changed,
    committed(entry): void {
      commits += 1;
      const previous = lastCommitted;
      lastCommitted = targetOf(entry);
      // A store sign-out is a command even while a read already showed it
      // signed out, unless the store's previous commit was one too: a
      // repeated clear would advance custody under another client's sign-in.
      // Deduped against commits only, since an observation can read a
      // sign-in before its commit arrives. Before the first commit the
      // store's state is unknown, so a sign-out is a command: it also fences
      // a previous process's write still in transit.
      if (entry === null ? previous?.digest !== null : !following(entry))
        changed(entry);
    },
    rejectionChanged(entry): void {
      if (!options.selected || entry === null || !following(entry)) return;
      // Queued behind each session's owner, never replacing it.
      for (const held of sessions.values()) {
        const { owner } = held;
        if (owner) held.queue = held.queue.then(() => amendRejection(owner));
      }
    },
    provisioned(client): boolean {
      if (!options.selected || !wanted || wanted.digest === null) return false;
      for (const { session, owner } of sessions.values())
        if (
          owner !== undefined &&
          usable(session) === owner.client &&
          (client === undefined || owner.client === client) &&
          owner.heldDigest === wanted.digest
        )
          return true;
      return false;
    },
    async admissionIdentity(client): Promise<string | undefined> {
      if (!options.selected || wanted?.digest === null) return undefined;
      // One launch budget, not one per queued observation or account change.
      const signal = AbortSignal.any([
        client.signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]);
      for (const [session, held] of sessions) {
        if (usable(session) !== client) continue;
        // Account changes can enqueue again while verification is pending.
        let pending: Promise<void>;
        do {
          pending = held.queue;
          try {
            await untilAborted(pending, signal);
          } catch {
            return undefined;
          }
        } while (pending !== held.queue);
        const heldDigest = held.owner?.heldDigest;
        if (
          usable(session) === client &&
          held.owner?.client === client &&
          heldDigest !== undefined &&
          heldDigest !== null &&
          heldDigest === wanted?.digest
        )
          return wanted.identity;
      }
      return undefined;
    },
    idle: async (): Promise<void> => {
      // Owners and rejection amendments extend a queue while it settles.
      await Promise.all(
        [...sessions.values()].map(async (held) => {
          let pending: Promise<void>;
          do {
            pending = held.queue;
            await pending;
          } while (pending !== held.queue);
        }),
      );
    },
  };
}
