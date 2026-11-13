# Electron renderer relay

`window.canopyCore.invoke` uses the single `canopy-core:relay` IPC channel.
It coexists with legacy preload APIs. No domain caller has moved to this path.

Main checks the tracked WebContents, its attached main frame, and the exact
main or App Advisor page on every call. The renderer cannot supply identity,
grants, or a surface. Each lazy connection uses a distinct renderer principal
and a fresh client instance id. Committed main-frame navigation, renderer exit, explicit close, and
host disposal close the connection and invalidate pending results.
Cancelled, same-document, and subframe navigations preserve the connection. A dropped
binding or client closes its session; the next call gets a fresh connection.

The generated table comes from `runtime-profiles.yaml` interface principal
rows, including access modes and authority-only restrictions. Regenerate with
`node scripts/core-daemon-census/renderer-relay-allowlist.mjs`; CI checks drift.
The main renderer receives that set intersected with installed definitions and
the negotiated manifest. App Advisor is narrowed to health, runtime events,
and capability registration. Initialization and client leases stay host-owned.

Requests and delivered frames have a 1 MiB cap. Each renderer connection has
32 call slots, 16 streams, one pending pull per stream, and 30-second setup,
request, open, and read deadlines. A timed-out read retains its pending frame
for the next pull. Request/open reservations last until the underlying work
settles. The K1 client also bounds buffered stream frames and bytes.

The relay accepts an injected `RelayBindingProvider`. The isolated
`interim-in-memory-binding.ts` bridges an L0 framed pair to the existing
in-process dispatcher. Lane C replaces this provider at CAN-3729; it supplies
no persistence, leases, or daemon initialization policy. Its host-local
`releaseStream` hook closes the existing in-process stream handle. K1 has no
wire cancellation of its own; the web core serves `core.events.unsubscribe`,
which the shared client sends when a stream is released (CAN-5970). An adapter
without this hook closes the whole connection when a renderer abandons a
stream.

`core.client.capabilities.register` forwards validated presentation capability
declarations to a main-owned connection table. Registrations and bounded
idempotency history disappear on disconnect. Outcomes are retained for all 32
accepted keys; further new keys are refused until reconnect rather than evicting
old outcomes. Nested object key order does not affect equal-key replay.
These declarations do not install
operation handlers or grant permission to invoke a presentation intent.
Durable lease-bound capability ownership belongs to CAN-3767.

The interim wire cap is 2 MiB to leave room around the 1 MiB renderer value
cap. Oversized replies fail individually and oversized streams end at the last
delivered cursor. A keyed instruction's unknown outcome keeps
`same_idempotency_key` recovery across deadlines, disconnects, lost IPC replies,
and reply limits. The exception is a keyed instruction the host serves without
a retained outcome (`worker.filesystem.entry.delete`, `.copy` and `.move`,
and `worker.filesystem.file.write` and `.directory.create`, until CAN-4733):
the relay and preload answer its every retry as `never`, since a same-key
replay would act again.
