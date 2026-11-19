# @canopy/core-client

Client for the Canopy core daemon.

`@canopy/core-client` (`src/index.ts`) is browser-safe. Production code
imports only `@canopy/protocol`, `@canopy/core-transport/types` and
`@canopy/core-transport/lost-reply`. A reply the binding tagged as lost is a
lost call, retried as the operation's idempotency allows (CAN-6940). It
exports:

- the typed client contracts (`CanopyClient`, `CanopyClientOptions`, the
  effective manifest and runtime identity types, structurally compatible with
  the in-process client) and `CanopyClientError`;
- the pure strict `core.runtime.initialize` handshake helpers
  (`buildCanopyInitializeParams`, `acceptCanopyInitializeResult`,
  `toCanopyInitializeError`);
- `createCanopyClient`, which takes an authenticated framed connection,
  runs the handshake, and returns a client whose `query` and `instruction`
  calls are validated locally, correlated by request id, and settled on
  cancellation, deadline, disconnect, or `close()`. `openStream` applies the
  same local gates against the `streams` manifest.

The handshake accepts only the canonical initialize result
(`runtime.buildVersion` and `capabilities.{operations,events,streams}`). A
protocol version the client did not offer, or the daemon does not advertise,
fails closed with a restart-or-update message. Operations, events, and streams
are gated on the effective manifest snapshot taken at connect time; authority,
runtime, host, and daemon epoch are reported as independent identities.

## Authority registry

`createCanopyAuthorityRegistry({ primary: localClient })` starts with the
authenticated local client returned by the K1 factory or Node connector. The
registry keys clients by their handshake `authorityId`, rejects worker-only
runtimes and duplicate authorities, and requires exactly one selected primary.
The caller owns client lifecycle; removal never closes a client, and a primary
cannot be removed until another registered, live authority is selected.

An `authority` destination resolves that authority's client. A `primary-routed`
destination must name the selected primary and retains its `executionTargetId`
(`local`, `automatic`, or an opaque target ID) without resolving it as an
authority. A disconnected primary fails closed without automatic failover.
This PR supplies the local-only constructor seam; app wiring and remote
connections remain later work.

Each authority owns a separate `CanopyAuthorityCursorSlot` with `read`, `write`,
and `clear`. Writes validate and copy the cursor; reads expose an immutable
snapshot. Slots start empty, including after removal and re-registration.
K4 can adopt this ownership interface for acknowledged event cursors: ordering,
acknowledgement, epoch changes, and snapshot recovery remain its responsibility.
Stream-end placeholder cursors must not seed event recovery.

## Streams

A stream is routable as soon as its open reply is read, and an `onFrame`
option sees every frame. Frames are routed by `subscriptionId` and validated
against the stream's schemas: a malformed frame ends only that stream as
`internal`, unknown subscriptions are never answered, and a reused active
subscription id fails the session closed.

- Frames can outrun their open reply: the POST plus SSE binding carries them
  on separate legs. While any open waits for its reply, frames of unknown
  subscriptions are held, up to 16 MiB of encoded bytes in all, not charged
  to the connection budget. The reply that registers a subscription replays
  its held frames in order before any later frame; once no open waits, the
  rest are dropped, so an error reply drops them. When the bound is passed,
  every open then waiting ends on registration with `resource_exhausted` at
  its accepted cursor, so a resume from it skips nothing.
- A stream ended locally, or opened by a call abandoned before its reply, is
  an orphan: the core still serves it, so its frames are dropped, never held,
  until the core ends it. Up to 1,024 orphans are tracked; the oldest past
  that is forgotten.

- Consume by push (`onFrame`) or pull (`frames`), not both. Listener errors
  are contained; the `onListenerError` option observes them, and those of
  `onLeaseEvicted` listeners. Leaving the iterator early keeps the stream
  live, buffering, and charged, as in process; a later iterator resumes in
  order.
- Undelivered frames are bounded at 1,024 items and 16 MiB per stream, and
  64 MiB per connection. A frame is charged once, on arrival, the UTF-8 length
  of its JSON-encoded notification. That is an accounting measure: it ignores
  the raw wire spelling and does not bound heap use. Delivering a frame
  releases its charge.
- Each active stream reserves 4,096 bytes against both budgets for its end,
  which fits the largest generated end. Opening a stream whose reservation
  does not fit the connection rejects with `resource_exhausted`; the core's
  subscription still runs and its frames are dropped. Nothing cancels it on
  the wire, so its id stays reserved until the core sends a valid end for it:
  reopening that id first fails the session closed as `internal`. Refused ids
  are retained uncharged, up to 1,024 ids and 1 MiB of encoded id bytes; a
  refusal past either bound fails the session closed with
  `resource_exhausted` rather than forget an id.
- An item over either budget, or the count, ends only that stream with
  `resource_exhausted` (retry `after_refresh`, resource `stream`) at the last
  accepted cursor, after the items already accepted. Any other end, from the
  core or local, that does not fit the reservation plus the remaining room is
  replaced the same way.
  Replies and other streams are unaffected.
- `close()` or abort ends a stream as `cancelled`, and its deadline as an
  `error` with `deadline_exceeded`. All three discard unread frames, including a
  core end already received, and release every charge at once. Unlike the
  in-process queue, this keeps an undrained cancelled handle from starving
  its siblings. The one local end is uncharged and carries the last delivered
  cursor, which may precede the last accepted one. Abort and deadline stay
  armed until the stream's end is read; after that they do nothing.
- Session closure, or a malformed frame, ends a stream after its queued items
  with the session reason (`cancelled` only for a cancelled session) or
  `internal`, at the last accepted cursor. Before any item, a local end
  carries the accepted cursor, else this connection's
  `{ daemonEpoch, sequence: 0 }`: a client-local marker, never sent and never
  a server checkpoint.

Known limit: the protocol has no cancel, unsubscribe, or flow-control message.
A local end releases client state and drops later frames; the core's handler
runs until it ends or the connection closes. A stream that ended but was never
drained or closed keeps its charges until its handle is drained or closed.

## Event subscriptions

`createCanopyEventSubscription` layers filtered `core.events.subscribe` streams
and `core.events.ack` on the initialized client. Supply event `families`, optional
workspace `scope`, a durable async `handle`, and a canonical `snapshot` callback;
then `attach(client)` after each connection. Authority identity and ack capability
are required. Each authority keeps its own epoch and cursor. A replacement attach
waits for old callbacks to settle, and prevents their late results from advancing
or acknowledging the replacement stream.

`handle` must finish durable handling before resolving. The helper saves the
settled received prefix through the optional cursor `store`, then wire-acks it.
Global sequence numbers may be sparse after filtering. Reconnect resumes the
saved checkpoint. Without a store, checkpoints last only for this subscription
object. Handlers must tolerate redelivery after interruption or a failed save.
Use one owner per authority and canonical filter key in a shared store.

On first attach, epoch change, or `snapshot_required` (open error or stream end),
the helper clears the checkpoint, awaits canonical rehydration, saves the returned
cursor, and resubscribes. The snapshot callback must atomically apply canonical
state with a same-epoch checkpoint; returning `null` requests retained replay.
A different non-null accepted start fails before delivery. A null accepted start
for a saved checkpoint triggers bounded canonical recovery. Callback cursor and
authority-context mutations cannot change the helper's checkpoint state.
A stream end cursor is never used as a handled checkpoint. Recovery is bounded
by `maxSnapshotAttempts` (default 3 per attach).

Unclassified events are lifecycle events. Explicitly classify output to bound it
by count (256) and encoded UTF-8 bytes (1 MiB), including in-flight output. Overflow
replaces queued output with a `gap` delivery that must also be durably handled.
Lifecycle events and gaps take priority over queued output; an in-flight handler
is not preempted. Acks cannot cross unsettled output or gaps. Total pending events
are bounded at 1,024: overload fails the subscription instead of omitting a
lifecycle event and continuing. `state(authorityId)` and `error(authorityId)` expose
failures; callers reconnect and reattach. `close()` stops all streams and waits for
in-flight callbacks. Local closure cannot unsubscribe on the current wire protocol.

## Test fixtures

`src/__tests__/fixtures/canonical-core.ts` serves a canonical core with typed
operation errors and a `core.test.ticks` stream it can drive frame by frame.
`client-conformance.ts` runs the shared request and stream conformance suite,
including a 1 MiB request, against any binding's framed pair. `client.test.ts`
and `abandoned-ids.test.ts` cover exact abandoned-request history and its
bound.

`fixtures/raw-wire.ts` is an authenticated framed pair that also writes raw
bytes, or EOF, into the client's receiver. `raw-wire.test.ts` drives the facade
through it:

- Replies split byte by byte and answered out of order are reassembled.
- An oversized length header (rejected before its body is buffered), invalid
  UTF-8 or JSON, a malformed envelope, or a reply to an unissued, settled,
  zero, string, or null id fails closed: the pending call, client, and
  connection settle with the typed reason, and later calls reuse it.
- Deadlines past the 2^31 ms timer limit fire on time; params are validated
  locally and sent exactly; an outgoing request over the frame cap is rejected
  and the client stays usable.
- Valid notifications without a live subscription, split or whole and
  interleaved with a reply, are dropped without settling or answering
  anything. Split frames for a live subscription arrive in order, and a reused
  subscription id fails closed. Malformed or over-cap notifications fail
  closed.
- A truncated header or body holds pending calls until EOF, which settles them
  as `unavailable` with idempotency-aware retry.

The mid-session `unauthenticated` and daemon-update closes in the conformance
suite are simulated typed closes. Real authentication failure is covered by
`@canopy/core-transport`'s `in-memory.test.ts` (wrong secret or foreign data
root), and version negotiation by `handshake.test.ts`. The client has no
mid-session re-authentication.

## Delivery policy

`deliverCanopy(run, options)` is the one retry loop for calls to a core, and
`CANOPY_CONNECTION_DEFAULTS` holds the bounded defaults: a 10 s connect
deadline, a 30 s delivery deadline, and backoff from 1 s doubling to 8 s.

- A failure is retried only when its directive is the delivery's `replay`
  kind: `same_request` resends the exact arguments, and `same_idempotency_key`
  also keeps the original key, so a lost reply returns the core's recorded
  outcome instead of repeating the effect. `never` and `after_refresh` end the
  delivery with the failure as it arrived. The client already maps a lost
  reply by idempotency: `keyed` becomes `same_idempotency_key`, `none` becomes
  `never`, so an unkeyed call with an unknown outcome is never replayed.
- `cancelled`, `unauthenticated` and `permission_denied` are never retried.
- A directive's `delayMs` is a floor under the backoff. Every attempt and
  wait shares one deadline; a wait that would pass it fails at once with
  `deadline_exceeded`, which keeps the last replay directive because that
  attempt's outcome is still unknown.
- The caller's signal aborts waits and the attempt's own signal. Each attempt
  gets `remainingMs()`, so a nested connect uses the time left instead of a
  fresh deadline.
- `current()` is checked before each send and before a result is accepted. A
  changed authority, account, or connection fails closed as
  `failed_precondition` (`after_refresh`, resource `destination`), with no
  failover. Stale or late results go to `release`, never to the caller.
- `accept` adopts a result in the same turn as that last check. Code after
  `await` runs later, so state adopted there may already be stale.

`run` must send the same operation and arguments to the same destination on
every attempt. Transport bindings send once: `connectCanopyClient` runs on a
`CanopyDeliveryScope` with no retry of its own, and the caller's delivery owns
any retry. Durable admission and restart recovery stay with the core (CAN-4130).

## Node connector (`@canopy/core-client/node`)

The browser root never imports `./node`. `connectCanopyFramedConnection` stops
after auth, and `connectCanopyClient` also initializes a `CanopyClient`.
A `socket` (non-Windows) or `pipe` (Windows) endpoint carries a path, framed
auth, and optional `maxFrameBytes`; either on the other platform is
`capability_unavailable`. An `inMemory` endpoint carries an authenticated
connection. Existing codecs are reused; the connector has no wire cancel.

One deadline covers connect, auth, and initialize: default
`connectTimeoutMs` (10 s), else an integer 1..2147483647 ms or
`invalid_argument`. Setup sends once and never retries. Abort rejects `cancelled`, the
deadline `deadline_exceeded`. Failed setup, including pre-aborted `inMemory`,
closes owned connections and removes its timer and listeners. After success a
framed connection ignores aborts; a client closes. Real socket conformance
runs; pipes are unexecuted off Windows. CAN-3861 adds compile-time parity.

`attachOrStartCanopyDaemon` attaches to a live core or spawns once with explicit
`--data-root` and `--runtime-mode`. Hosts inject read-only discovery, a supervisor,
a startup claim (required off Windows), and `attach`, usually `connectCanopyClient`.
Auth carries the requested `dataRootHash`; discovery checks PID start identity
before protocol range. Nothing deletes a descriptor. One deadline (default 30 s)
bounds every phase, re-probing every 100 ms. The startup claim only serializes
startup; the bound endpoint has its own lifetime lock. Release atomically compares
our unique acquisition token, retained on adoption, only if no child was created
or its exit is confirmed: absence/mismatch has no effect, ambiguity fails closed,
and no endpoint is unlinked. A release failure never replaces an attached client
or an earlier error: `onClaimReleaseError` gets it redacted and crashed-claim
recovery owns the claim. Late spawns are terminated and must confirm exit
within a 5 s cleanup window before release; late clients are disposed. The ports
stand in for CAN-3766 (C5) and CAN-3852 (C2c); this package supplies no host spawn,
file-writing, or lock implementation. Real binding/adoption/fault injection is CAN-3729.

### W5 startup handoff (GB12, CAN-5543)

The contract the desktop flip launch and the CLI cutover (CAN-5533 C4) share.
Later lanes conform to it and extend it only additively. Nothing in production
turns it on yet.

- `daemon.w5Host` (or `w5Host` on `createCanopyDaemonHostLaunch`) appends
  `--w5-host v1` to a spawn. Callers still may not pass the switch in `args`.
- `beforeSpawn: { timeoutMs, run }` runs once, only on the spawn path: after the
  startup claim is held, which the child then adopts, and before `spawnDaemon`.
  The launch deadline stops while it runs under its own budget; caller abort
  still applies. A failure spawns nothing. The claim is released only after
  `run` settles, even when its budget expired first. Windows has no claim, so
  it refuses the hook `capability_unavailable`.
- `probeCanopyDaemon` classifies the descriptor and connects to a live daemon
  through the caller's `connect`, which must not lease, so the daemon's idle
  grace keeps running. It returns `absent`, `stale`, `incompatible`,
  `unreachable` or `live` with the value, which the caller closes.
- `CanopyDaemonDeadline` lets hosts share a monotonic budget and caller abort
  across discovery and post-connect capability queries. Pass its signal and
  remaining budget to the probe and queries; dispose it in `finally`. Hosts
  still own client cleanup, including values returned after the budget ends.
- `classifyCanopyDaemonCapability` is pure. It takes the operations the host
  needs (its definition maps fit), the effective manifest, the lease-free
  `manifest.get` operations, and optionally `health.get` checks. Calls carry no
  operation version, so the `manifest.get` versions are required. It accepts
  when every needed operation is served at a matching version, even if the
  runtime is `degraded`. It refuses `version_skew` when only some are served
  or a version differs. When none is served, it refuses `writer_held` if the
  `core.daemon.w5-commit-log` check reports `writer_unavailable`, and otherwise
  returns `wait`.
- `waitForCanopyDaemonRelease` re-reads only the descriptor until the refused
  PID and start identity stop publishing. It returns whatever replaced them,
  for the caller to probe again. At its bound (default 45 s: a 30 s idle grace,
  the stop, and slack) it refuses `peer_held`.
- Refusals are `CanopyClientError`s with `details.refusal` from
  `CANOPY_DAEMON_REFUSALS`; read one with `canopyDaemonRefusal`. Each is
  `failed_precondition`, so a launcher `attach` never retries it, except
  `exited_before_ready`, which keeps the launcher's existing `unavailable`
  failure and now carries the tag.
- Launch and connect failures may also carry closed facts in `details`:
  `errno`, `exitCode`, `signal` and `nativeStage`, and `claim: 'ambiguous'`
  with a `cause` for an unprovable startup claim (not a refusal). Read them
  with `canopyLaunchDetails`; it keeps only allowlisted values.

## Client lease (`createCanopyClientLease`)

One owner per logical client; the host owns clients, `attach`, eviction and
resume signals. Renewal follows each reply: the earlier of `renewAfterMs`
(monotonic) and `expiresAt` (wall), no local TTL or clamp. `checkClock()` and
a watchdog every quarter `renewAfterMs` renew at once after a wall-clock jump.

- Reconnecting within `reconnectGraceMs` (default 10 s, by the later of both
  clocks since the drop) sends `previousLeaseId`; the same id keeps completed
  registrations. A new id, `notifyEvicted` for the current lease, or a renew
  `notFound`/`invalidState` replays them; evictions omit `previousLeaseId`.
  One `revisionConflict` renews again; a second re-acquires.
- Acquire, renew and reconnect each run as one delivery under the shared
  policy, bounded by `deliveryTimeoutMs` (default 30 s). Only fitting
  directives replay: acquire on `same_idempotency_key` with its key, renew
  (exact arguments) and attach on `same_request`. Any other directive
  (`after_refresh` has no refresh operation), an exhausted deadline, or a
  throwing `presence` fails the owner. `attach` receives the attempt's signal
  and remaining time; a replacement that closed before use is closed and
  retried. A drop, eviction or release aborts the epoch's waits and attach.
- `register` issues serially, in order, once per connection and lease. Success
  is per lease id; failures and post-drop results retry on the next connection
  or lease, never looping. A stalled one blocks later ones until reconnect.
- An acquisition's params and key are frozen: until a reply binds a lease, even
  on error, a drop replays it unchanged before any new key. Evicting a retained
  id awaits its answer, then acquires fresh once. Late replies are fenced.
- `release` is terminal at once and keeps an earlier failure's error. One
  cleanup pass within `releaseTimeoutMs` (default 5 s) drains pending writes,
  replays an unresolved acquire once with its exact key, then releases what the
  attached connection may hold, even after a failed replay. Expiry, checked
  after each wait, stops it; daemon eviction bounds the rest. Detached, it
  sends nothing; late attaches close.

Release never reconnects. If the last transport is lost after release starts,
the remaining leases are left to daemon eviction when that connection's
reconnect grace expires, as they are when the release budget is exhausted.

Limits: eviction is host-fed until CAN-3729 joins C6's notification; no window
or CLI hookup; `crypto.randomUUID` needs a secure context. Errors carry no
current revision, so a conflict retry resends the same one.

## Not in this stage

The daemon event journal, remote routing, automatic reconnection, and host cursor
persistence are outside this package. Hosts supply connections and durable stores.
