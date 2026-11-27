# Core runtime

`@canopy/core-runtime` provides the typed in-process dispatcher and portable
kernel primitives. It depends on the protocol package and Node built-ins;
host services and transport bindings belong in their adapters.

## Storage write policy

`@canopy/core-runtime/storage` exposes the manifest-backed writer policy and
`namespace_backup` record shape without loading the kernel. The ownership census
generates guarded rows for `required_before_flip`, `daemon`, and `offline`
namespaces. Writers supply an explicit principal; daemon rows accept only
`daemon`, legacy/interface-local rows accept their listed writers, and offline
rows refuse ordinary writes pending maintenance-lock authority.

The Node atomic writer checks its optional `storage: { namespace, writer }`
context before creating a sibling file. W5 caller adoption and the static import
boundary are separate legs; untagged existing writes retain their current path.
No ownership row changes here. Backup helpers validate metadata and require a
trusted host predicate proving the data-root-relative path is outside checkouts;
they perform no copy, digest verification, restore, or ownership transfer.

## W5 commit log

`@canopy/core-runtime/node/w5/commit-log` holds the W5 commit log (CAN-3805):
the SQLite library, its applier, the worker message contract and request
handler, and `ensureW5DataRoot`. It is never re-exported from `/node`, so
`node:sqlite` stays out of hosts that only import the barrel. The host supplies
a `W5DurabilityPort` (durable file writes and folder syncs); the package reads
no platform. `/worker-contract`, `/errors`, `/fingerprint` and
`/reservation-diagnostics` load without the database. `/worker` exports the
portable worker body (`runW5CommitLogWorker`), which each host's worker entry
runs with its durability port and trusted OS; `/node-durability` is a node:fs
port for a host-named OS, taking the host's folder flush. `/data-root` names a data root's commit log and W5
root without loading the database.

`/node/w5/commit-log-host` is the worker-thread host (`W5CommitLogHost`): its
queue, admission check before every worker start, timeouts and bounded
shutdown. It structurally satisfies the commit-log file store's host port. A
host composition supplies the worker entry and an admission. The desktop
composes it with atomic-file durability through
`@canopy/desktop-shared/node/w5-commit-log`; the core daemon composes it only
in a W5 qualification build (W5b, CAN-5450).

## W5 workspace metadata commands

`/node/w5/workspace-metadata/` holds the policy of seven W5 commands
(CAN-5520): `metadata` (`core.workspace.update` and `.reorder`), `settings`
(`.scripts.update` and `.planDetection.update`), `private-memory` and
`repositories` (`.repository.add` and `.remove`). Each factory takes its host
through the `/ports` contracts: the one-decision bindings, revision check,
commit, path projection, id check, index repository and a manifest edit port.
A manifest edit returns only the fields its command changes, never plugin
defaults. The host also supplies outcome decoders and post-commit hooks.
`/manifest-keys` lists the manifest's known fields in write order. Desktop
main hosts the commands in process. The W5 qualification daemon also hosts
them (CAN-5522, W7a-3): `/daemon-binding` binds the cores to its W5 host with
the `daemon` writer and `daemon:<principalId>:<source>` receipts, addressing
each wire call before any reservation, `/manifest-edit` writes only the keys a
change names into the stored document, and `/module` serves the registered
`core.workspace.*` handlers (`/node/workspace/metadata-commands`) over a
daemon host, with its bounded retry (`retry`), stored-outcome decoders
(`projectors`), the decided-workspace projection (`decided-workspace`) and
the path-free message rule (`wire-errors`).

## Vault migration sessions (inert)

`src/node/vault/` holds the ADR 7 legacy-store migration session state machine
(CAN-4504 VA-1). Only disabled qualification wiring composes it; production
migration remains disabled.
`createMigrationSessionRegistry` issues single-use sessions, each bound to
one admitted launcher channel, one source (flavor and secure mode), one slot
and one challenge. Failures after a possible release become `uncertain` and
fence the slot's source generation. It never revokes them or issues them again.
Import is create-only through `MigrationImportPort`. The slot set is data
(`MIGRATION_SLOTS_AT_PIN`), and the host supplies the OS. `migration-protocol.ts`
defines the private, versioned frames; they carry no evidence or identity.

Admission from native evidence (VA-2) is inert too. `migration-evidence.ts`
keeps each native capture as a frozen copy in a host-only `WeakMap`, keyed by
an opaque handle that carries and serializes nothing.
`createMigrationAdmission` admits at most one channel per daemon, the fd 3
launcher of the daemon's own flavor, as a constant `MigrationCaller`. It
refuses anything else with a typed reason and reports it as ambiguity. On
Windows and Linux it returns `unavailable`. Its `port` is the registry's
`MigrationAdmissionPort`. `authenticateMigrationDestination` is the launcher's
check of the daemon it spawned (R-12).

CAN-5857 unit A adds the host-only `migration-platform.ts` evidence and
expectations contract. Windows creation ticks use uint64 `bigint`; Linux uses
boot ID and canonical decimal start ticks, with process-instance (not exec)
continuity. Linux pidfd custody is a separate channel observation.
Executable/package/signing observations are separate from identity and do not
authorize admission. Strict parsers freeze copies; the evidence
store still exports only opaque handles. Session bindings retain and compare
the complete OS-tagged identity at presentation and release, including changes
between consume and release. The contract is exported from `/node/vault` for
host verifiers. Darwin admission is unchanged. W2/L2 must consume authenticated
expectations and invalidation from unit T (CAN-5855)
before platform verification/integration; neither is enabled here. Eight
registered migration goldens cover admission, sessions, private protocol,
platform evidence, transport, daemon/Electron composition and package-role checks.
They do not qualify native Windows/Linux verifiers or signed release packages.

## Filesystem watch

`/node` serves `worker.filesystem.watch` (CAN-4102).
`createFilesystemWatchRegistry` shares one native handle per path and
recursion flag across subscribers. It batches each callback burst by path,
counts the native notifications per item, and re-attaches after an error with a
1 s to 30 s backoff. It emits `overflow` once when a re-attach first fails and
again once it re-attaches. That error path is where
platform limits such as Linux `ENOSPC` belong: a host `unavailable` policy
classifies them, and the registry then retries every 30 s after the first
attempt and reports the error to the host once per detachment. The desktop
reuses its worktree observers' codes and warning (CAN-3190). The host injects
`watch`, `lstat` and that policy; the registry never names an error code or
branches on platform. A `close` handle closes with
its last subscriber; a `retain` handle stays dormant and starts a new epoch when
it is reused. `createWorkerFilesystemWatchHandler` resolves a root through a
host `FilesystemWatchResolutionPort`. It serves nested roots from the outer
root's handle, bridges an absent root through its nearest existing ancestor,
and resumes only at a handle's exact live cursor. Hosts supply resolution, the
`onAttached` and `onAttachFailed` hooks, and their own debounce.

## Filesystem entry mutations

`/node` exports `deleteFilesystemEntry`, the `worker.filesystem.entry.delete`
engine (CAN-4101), ported from the desktop explorer's delete. Its guards live
in `filesystem/entry-mutation-guards.ts` for every entry instruction: root
containment by real path, other roots at, inside or contained by the entry,
root and backslash paths, and a re-check of the parent's real path right
before the effect. The host port (`FilesystemEntryMutationHost`) supplies the
scope's roots, its refusals (read-only, managed target, lock), the OS and an
optional `PlatformServices` Trash member; without one, a Trash request fails
before any effect. It serves the CAN-4159 keyed definition: a non-null
`expectedVersion` fails as `capability_unavailable` before any lookup,
`recursive: false` refuses a non-empty folder, and any folder bound for the
trash, before any effect, and the result
counts one entry. It retains no keyed outcome (CAN-4733). The engine checks the
call's signal before the effect and acts on the lexical path, so a symlink is
removed as a link. Only the desktop mutation adapter composes it
(`check:core-filesystem-boundary`); the daemon registers no entry instruction.

`copyFilesystemEntry` and `moveFilesystemEntry`
(`filesystem/entry-transfers.ts`) are the `worker.filesystem.entry.copy` and
`.move` engines, a literal port of the explorer's copy, move and rename over
the same guards and host port: increment naming, same-root nesting and
cross-root symlink refusals, staged exclusive publication, the case-only
rename, the macOS symlink move, cross-device copy then `rm`, and the file
move's link then unlink, rolled back only while the source is still the linked
entry. The host's `os` chooses the Windows and macOS strategies, and the
`FilesystemEntryTransferIo` seams wrap each filesystem effect for fault tests.
They serve the keyed definitions in
`WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS`, which CAN-5502 split from
the CAN-4159 write registry (CAN-4101 added `entry.copy` from its page): a
non-null `expectedSourceVersion`,
and for a move `expectedDestinationAbsent: false` or `conflictPolicy:
'increment'`, fail as `capability_unavailable` before any lookup, and results
carry a `<size>:<mtimeMs>` version. The copy engine renames the shared guards'
codes to its catalog page's. They retain no keyed outcome (CAN-4733), and they
check the call's signal before the first effect, before publishing, and
before removing a move's source.

`writeFilesystemFile` and `createFilesystemDirectory`
(`filesystem/file-writes.ts`) are the `worker.filesystem.file.write` and
`.directory.create` engines (CAN-4100), over the same guards and host port. A
replace opens the contained file without truncating, pins it by device and
inode against its real path, compares the exact `<size>:<mtimeMs>` version on
the handle, then truncates and writes in place, so the inode, hard links and
mode stay; it is not atomic. A stale version whose bytes already match
succeeds without writing; any other is a `file.revisionConflict`. A create is
exclusive (`O_EXCL|O_NOFOLLOW`) and never makes parent folders; a folder
create makes missing parents one level at a time, each re-checked right
before its `mkdir`. Both refuse another root reached through this one. The
host port's optional `fileWriteLimitBytes`, `admitWrite` and `beforeReplace`
supply the content cap, an admission held around a replace, and a hook right
before its bytes change; creates use neither hook. The engines rename the
shared guards' codes to each instruction's and drop codes it does not
declare, keeping kind and message. They retain no keyed outcome (CAN-4733).
Only the desktop mutation adapter composes them; the daemon registers neither
yet (a separate CAN-4100 follow-up PR, unblocked by CAN-4802).

## File annotations

`@canopy/core-runtime/node/annotations` holds the `core.annotation.*` engine
(CAN-4104): the v1 `file-annotations.json` format, its merge, per-document
revisions and compare-and-swap, the per-file write lock and atomic replacement,
and the projection between host file paths and portable file references (root
ID and relative path, or an opaque handle for files outside every root). It is
never re-exported from `/node`, so the daemon bundle does not carry it. The
host supplies each scope's state-file path, its file roots and whether the
scope may change; every write refuses a read-only scope. Electron main's core
annotation adapter is its only owner, and `check:core-annotation-boundary`
keeps other callers out.

## Worker terminal

`@canopy/core-runtime/node/terminal` holds the terminal engine (CAN-4147):
`TerminalEngine` implements the in-process `WorkerTerminalPort` (create,
restore, list, get, attach, write, resize, kill, release and the
worktree-wide kill, release and liveness reads), with replay and sequence
numbers, initial-command submission, the running detector and Windows
foreground-process tracking. `TerminalShells` resolves profiles, the default
shell, Linux login shells and the shell a restored terminal restarts with.
Every host fact and effect is a `TerminalEngineHost` port: PTY spawning,
shell facts, base and worktree environment, checkouts and archive exclusion,
resource registration, persistence, process control and logging. It is
never re-exported from `/node`. Electron main composes it in
`apps/desktop-app/src/main/terminal/worker-terminal.ts`.

## Operation ledger

`@canopy/core-runtime/node/operations` holds the operation service and the
`core.operation.*` handlers (CAN-4130); `/node/operations/ledger` holds the
SQLite ledger, so `node:sqlite` loads only when a host opens it. The ledger
keeps one durable record per unit of accepted execution work: lineage,
origin, accountable owner, keyed retry receipt, cancellation intent,
restart reconciliation, terminal outcome and an ordered event log whose
cursor epoch is the ledger's stable identity. Domains register their kinds,
restart class (`lost`, `resumable`, `reattachable`), cancellation rules and
recovery with `OperationService`, and admit work before acknowledging it.
`kernel/keyed-receipt.ts` holds the keyed-receipt identity and decisions it
shares with the W5 commit log. `backupOperationLedger` issues verified,
restore-tested `namespace_backup` records and `restoreOperationLedgerBackup`
is their rollback. Electron main's core operation adapter is its only owner.

Where the daemon owns the ledger, its first open copies it before writing
(`createDaemonOperationService`): a verified copy under
`<data>/backups/operation-ledger/`, then an owner record naming the daemon
that cites it. One exclusive connection holds the ledger from the copy through
the owner record and the schema upgrade, so the copy keeps the schema it had
on disk; the backup record names the row's schema, and a restore upgrades an
older copy before it replaces the ledger. Any other owner record refuses the
open without touching the file. It keeps the three newest copies, and the
cited one. To roll
back, stop the daemon and run `returnOperationLedger` with the copy's record
and `owner: 'legacy'`: it restores the copy and records the app as the owner
again. It refuses over a ledger written since the copy unless a person
confirms the loss (`acceptNewerLoss: 'person-confirmed'`). The daemon then
refuses to open the ledger. To give the ledger back to the daemon, stop the
app and the daemon and run `reclaimDaemonOperationLedger`; it takes a fresh
copy, and the next daemon open admits calls.

`LocalWorkerExecution` (CAN-4132) records work on the builtin local worker
(`in_process_worker`): each worker instruction it dispatches becomes a child
operation of its parent, committed with a dispatch record (resolved target,
this run's degenerate delegation lease, activation digest, secret
fingerprints) before the worker is called. Ledger schema 2 holds the target
row, leases and dispatch records. A reply lost to a cancel or transport
error is resolved from the worker's executor receipt
(`createWorkerExecutorReceipts`, which wraps the worker's instruction
handlers) and never sent again; cancelling the child aborts its own request.
It runs over a `LocalWorkerTransport`: Electron main's direct call
(`createDirectLocalWorkerTransport`) or the bundled binding
(`localWorkerTransportOf`, exposed as the graph's `localWorker`), and both
write identical records.

The binding has two halves (CAN-5073): `connectLocalWorkerBinding` is the
core end and `serveLocalWorkerBinding` the worker end, each over one framed
connection; `createInProcessWorkerBinding` joins both over a pair. A split
host passes `supervisedWorker` to `createRuntimeProfileGraph` with its worker
modules' definitions and a `createSupervisedLocalWorker` route, which its
supervisor attaches to each worker process's binding. While no worker is
attached, calls fail as `unavailable`, and a receipt for a keyed instruction
sent to a worker that has gone answers `unavailable`, never "not started". A
`worker` profile graph records executor receipts and exposes its maps as
`executor`, for the binding's worker end.

## Script execution

`@canopy/core-runtime/node/script/execution` (CAN-4143) is the worker side of
script runs: `ScriptExecutionWorker` holds the run registry, the durable run
log (`ScriptRunLogStore`: each script key's latest run, at most 2000 lines and
1 MiB, a run another store instance left running read as lost) and the
non-interactive process runner, and `createWorkerScriptHandlers` serves
`worker.script.execute`, `.execution.cancel`, `.execution.get` and
`.execution.list` over it. `CoreScriptRuns` is the core side: each run is a
`core.script.run` operation (restart class `lost`) whose child is the
`worker.script.execute` dispatch through `LocalWorkerExecution`. The package
creates no process: process creation and its kill, drain and priority, the
run-log location and durability, and the projection of a scope and context
onto a checkout and environment are host ports.

## Initiated work

`@canopy/core-runtime/node/initiated-work` (CAN-4144) holds
`InitiatedWorkEngine`, the common engine for work a source starts on its own
behalf (hooks first). Each occurrence is a `core.initiatedWork.run` operation
(restart class `lost`) with the source's admission gates, deduplication by
the origin's `occurrenceKey`, one run at a time per target key, and
cancellation through `core.operation.cancel`; the run record lists every gate
outcome, the artifacts and the result. `HookInvocationStore` is the hook
source's owned `hook_invocations` run log. Sources supply the gates and the
executor; the store's directory and atomic writer are host ports.

## Execution accounting

`ExecutionAccounting` (CAN-4135) owns admission and lifetime accounting for
pipeline, script, terminal and code-graph work. `admit(family)` refuses a
start past the family's limit (active leases plus pending starts) or, for
memory-guarded families, at critical memory while the host's guard is on,
with `ExecutionAdmissionError`; the reservation it returns is released once
the work holds a lease. `track(family, id)` counts accepted work until its
lease is released, and `releaseWhenSettled` ends it however the work settles:
success, failure, crash or cancel. `keepAwake` applies the family policy:
pipeline executions hold a `WakeLockPolicy` holder. `register` adds processes
and work items, and `sample()` builds the snapshot from the host's
`PlatformServices.supervision.readProcessTable` and any rows the host
measures itself: groups, pipeline steps rolled up under their execution,
unregistered descendants classified by command, and pressure against the
host's thresholds. One instance serves every client of its host; `subscribe`
listeners only unsubscribe, so a client going away never ends work. Hosts
supply limits, labels and copy; Electron main composes it in process
(`apps/desktop-app/src/main/execution-accounting`).

## Event journal

`createEventJournal<E>({ epoch, maxEntries })` retains at most `maxEntries`
entries (default 1024). Each append receives an epoch-qualified, increasing
sequence. Cursor objects are copied on reads; event payloads remain owned by
the publisher and must not be mutated after publication.

`resume(cursor)` returns entries after a retained cursor. An omitted or null
cursor returns only the latest entry, for last-status replay. Foreign epochs,
evicted history, and future cursors return `snapshot_required`; an adapter
maps that result to its protocol error and refresh resource.

`subscribe(cursor, listener)` replays before live delivery, including entries
appended reentrantly by another listener. Its unsubscribe function removes the
listener. A throwing listener is removed without interrupting its peers.

## Operation manifest

`createOperationRegistry({ profile, definitions, owners })` validates explicit
ownership of every query, instruction, and stream definition. It rejects
duplicate names or claims, missing owners, unknown operations, and excluded
planes. The returned manifest and entries are frozen. Handler validation and
call admission remain the dispatcher's responsibility.

## Shutdown runner

`createShutdownSequence({ phases, now })` runs ascending phase IDs from 1–7.
Every phase has a finite, nonnegative deadline and receives an abort signal.
Failure or timeout is recorded before proceeding to the next phase. Repeated
`run(reason)` calls return the same promise and report the first reason.

Deadlines bound the wait for asynchronous hooks; hooks must cooperate with
abort to release their resources. The runner cannot interrupt synchronous
JavaScript or terminate a process tree itself. Host adapters supply those
actions and map the migration plan's shutdown steps to the phase hooks.

## Service container

`createServiceContainer({ profile, services, onChange })` validates plane
placement, unique names, dependencies, cycles, and required services depending
on optional ones. Startup follows stable dependency order, runs each service's
migrations before its start hook, and becomes ready only after startup settles
with passing health checks. Required failures reject startup and leave degraded
health; optional failures warn and block their dependents.

`health()` publishes changed snapshots through `onChange`. Startup is
idempotent. `markStopping()` aborts startup and publishes stopping health;
`stopPhase(3..7, signal)` invokes attempted services' cleanup in reverse order,
including after an expired deadline. Signals bound waits for asynchronous hooks;
hooks must cooperate with abort to release resources. Sequential startup has no
per-service deadline. The host assigns phase meanings and integrates cleanup
with the shutdown runner.

## Dispatcher lifecycle and journal cursors

`drainInstructions()` idempotently refuses new instructions while admitted work,
queries, and streams continue until `shutdown()`. It never reopens a closed
runtime.

A stream sink's `emitAt(cursor, item)` preserves canonical source cursors. The
first cursor establishes the stream's source epoch; later cursors must retain
that epoch and increase their sequence. Cursors are copied and validated;
mixing `emit` allocation with `emitAt` ends the stream with a handler error.
`endAt(cursor, outcome)` ends at the source's cursor under the same rules,
except that it may repeat the last sequence; a stream with no items adopts
it. The worker binding client ends each bridged stream there, so a resume
from a worker stream that ended before its first item reaches the worker.

## Runtime composition

`createCanopyRuntime` composes the journal, manifest, container, and shutdown
runner around a host-built dispatcher. It adds the canonical
`core.runtime.health.get` query and `core.runtime.events` stream, owned by
`core.runtime`, and rejects host definitions that reuse those names. A
worker-only profile cannot host them, so it fails at construction. The host
supplies a stable `runtimeId`, `hostId`, and `authorityId`; the daemon epoch
is new per runtime and qualifies every runtime event cursor. Events stream
journal cursors through `sink.emitAt`. A missing cursor replays the latest
status. A foreign, expired, or future cursor ends the stream as
`core.runtime.snapshotRequired`, retryable after refreshing
`core.runtime.health.get`.

`createDispatcher(input)` receives the merged definitions and the runtime's
handlers; the host merges those into its concrete handler maps. The runtime
captures the dispatcher's `drainInstructions` and `shutdown` at creation, so a
host may wrap `shutdown` to call `runtime.shutdown(reason)`. Shutdown phases:
1 refuse new instructions; 2 publish `stopping`; 3 end event streams, close
the dispatcher, then always run service phase 3 hooks; 4 schedulers;
5 processes; 6 flush; 7 databases and physical transports.

Desktop composes this runtime while retaining the Phase 0A compatibility
adapters. Its tests run the reusable journal conformance cases against
`core.runtime.events` through a test-only framed bridge. No production physical
transport, endpoint, or handshake serves these operations yet.

`createRuntimeProfileGraph` requires `workerCaller` and `workerBinding` when
bundled `core+worker` modules install worker operations. The host supplies a
`WorkerBindingPair` with JSON-RPC send/receive endpoints, serialization,
bounded buffers, close signals, and any physical handshake. The graph runs the
worker dispatcher behind the server endpoint and gives the core dispatcher only
the binding's forwarders for worker queries, instructions and streams; worker
handlers never join its handler map, so no direct-call fallback exists. Both
interface and owning-core grants are checked. Composition rejects a definition
filed under another kind and a stream without an open result or an object end.

Cancellation, a deadline or a stream close sends a binding-private
`worker.binding.cancel` notification for the request, which aborts the worker
call; the core still consumes the late reply. Two more binding-private
messages serve dispatch records: a `worker.binding.receipt` request asks how
a keyed instruction's handler settled, waiting for a running one, and a
`worker.binding.receipt.release` notification lets the worker forget it. The binding caps unanswered
requests of every kind, undrained request sends, and concurrent reply sends at
128 each, and open streams at 128 more. At most 128 replies wait for a send
slot; closing the binding releases those waiters. Worker stream frames bypass
the reply slots: each open stream keeps one send in flight, and its worker
dispatcher ends it at the 1,024-frame bound if the transport stalls. On the
core side frames feed the calling dispatcher's sink, which applies the same
bound, cursor order and end schema. When a stream ends on the core first, the
binding drops the worker's later frames until the worker's end arrives.
Closing the binding aborts the worker calls it serves, ends open streams and
fails pending calls as `unavailable`. Host close must settle pending sends and
receives as well as aborting its connection signal. An `unavailable` or
`deadline_exceeded` failure the binding raises for an instruction takes the
dispatcher's retry class: `never` for `idempotency: 'none'` and
`same_idempotency_key` for keyed instructions. As on the daemon wire, one
`_meta` carries the request metadata; the worker receives it in its params too
when the params schema declares `_meta`. The daemon control plane applies the
same rule before the core dispatcher, using each operation's `declaresMeta`
from the operation registry. A schema declares `_meta` when it is an object
with `_meta`, a union whose branches all declare it, or a pipe whose parsing
side declares it (the output side after a preprocess). The package root exports
that predicate as `paramsDeclareMeta`; the desktop renderer relay's interim
binding uses it too.

The portable package imports no transport implementation. Its tests inject a
strict serializing adapter. C7 (CAN-3768) owns composing the real L0 framed
pair and running framed conformance in the daemon host. Desktop's existing
composition retains its direct worker handlers in Phase 1.
