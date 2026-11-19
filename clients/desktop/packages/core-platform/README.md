# @canopy/core-platform

Selects the ADR 25 `PlatformServices` implementation for a host. Its host-adapter
contract is type-only in `@canopy/core-runtime`
(`src/platform/platform-services.ts`). This package is the only place
`process.platform` is read for it (`check-platform-boundary`).

Endpoint addresses, data roots and startup claims are trusted host-adapter
inputs. They stay at this in-process boundary; portable operation DTOs do not
carry them.

- `createPlatformServices(platform, endpoints, host)` composes services for
  `darwin`, `win32`, or `linux` with an injected endpoint provider. It fails
  closed with `PlatformServicesError`: `unsupported_platform` for any other
  platform, and `endpoint_semantics_mismatch` when the provider does not match
  the host policy (`filesystem-socket` on darwin and linux,
  `first-instance-pipe` on win32).
- `hostPlatformServices(endpoints, host)` does the same for the running host.

The optional trusted `host.windowsProcessPath` selects only the standalone x64
Windows process observer. Missing paths yield unverifiable live inspection;
composition does not discover paths or spawn probes. POSIX ignores this input.

The optional `host.trash` is passed through as the `trash` member unchanged;
composition never builds one of its own. When it is absent, `trash` is absent,
and a Trash request fails instead of deleting. `createNativeTrashServices`
builds the native backends a host may pass; see [Trash](#trash).

Darwin, Windows, and Linux are supported composition targets.
`createPlatformEndpointServices(os, options)` provides the endpoints (C5b,
CAN-3932): POSIX sockets bind under a temporary name and are published by hard
link, so the bind result's `identity` receipt names the node at the path. A
refused probe unlinks only through `unlinkStale`, under a host-validated
startup claim and an identity re-check. Windows first-instance pipes are
created by the native addon in `native/windows-pipe` (CAN-3931): every pipe
instance carries an owner-only DACL from creation, the descriptor is
re-verified before accepting, and binds fail closed without the addon. Node's
own pipe server is never used on Windows because its default DACL grants
Everyone read access. Build it with `pnpm run build:windows-pipe-security`
(Windows only); `pnpm run test:windows-pipe-security` runs the native
cross-user suite and shared secured-pipe kits. Hosted qualification requires
**10 transport + 2 lease + 8 channel + N01–N08**, exact file/ancestry/title,
complete per-case teardown and reviewed source/inventory/addon digests;
unrelated passes cannot fill [inventory](../../scripts/lib/windows-pipe-inventory.json) gaps.
Late ownership permanently invalidates passing case and aggregate receipts.
Failed rewrites remove stale evidence and fail Jest—even after its final hook,
failed deletion, or caught I/O errors. Hosted `always()` cleanup still runs.
Portable hook tests do not establish native callback/authentication teardown.
T07–T11 are named reference-journal exclusions; T16 is the reference
protocol-major mismatch exclusion because production closure differs. The eight
`todo` declarations are named inventory-only exclusions, not qualifying skips:
seven pending shared cases, and P08, the lost-reply case only a binding with one
reply per request can run (CAN-6940).
The existing POSIX control-plane tests reuse extracted clock and consumers.

Shared-case limits: T02 checks framed IDs/payloads, not request promises; T14
cannot prove another channel's progress while blocked; L02 does not compare
registrations; C01 fabricates a foreign ID; C07 does not prove connection-wide
revocation; T15 wrong-root proves client challenge rejection only.

Normal runs require three prober journals, security observations and verified cleanup.
CAN-4598's source-fixture qualification and its Windows evidence are recorded in
the [CAN-4598 record](../../docs/planning/2026-10-23-can-4598-secured-pipe-conformance/README.md);
cleanup rehearsals remain distinct from normal qualification. These kits do not
run against the packaged daemon, whose Windows serving smoke first passed on windows-2022 in Develop UI
Automation run 40128639752 (job 120975471044, 2026-10-24), and passed
again in run 40472555301 (2026-10-27; CAN-3996).

## Scope

C2a (CAN-3763) supplies endpoint scaffolding; C2b (CAN-3851) adds permission
checks and directory syncing. C2b2 (CAN-3865) adds path resolution and regular-file
rename, including its source-state and retry regression coverage.
C2c (CAN-3852) adds child environment, launch options, tree signals and PID inspection.
C5b (CAN-3932) adds the endpoints; `bindCanopyDaemonEndpoint` in
`@canopy/core-runtime/node` coordinates them with the stale-owner proof.
Descriptor publication is CAN-3934.

The Jest contract in `src/__tests__/` checks per-OS selection, mismatched
providers, and preservation of the injected endpoint interface. Real-socket
suites cover the probe, bind, unlink, bounded streams, and stale-owner
recovery; pipe behavior is tested with a fake verifier.

## Secure files

`secureFiles.permissions` checks regular files or directories. Only `private`
permits use. POSIX restriction verifies owner and identity through a no-follow
handle, then sets 0600/0700. Darwin also clears extended ACLs through that
handle and verifies a native ACL/identity receipt; unavailable native checks
return `unverifiable`. Windows verifies current-user ownership and the
DACL without repairing it. SYSTEM and Administrators are permitted privileged
trustees. Unsupported ACL forms, unavailable identity and read failures fail
closed. Elevated files owned by Administrators are refused.

`secureFiles.rename` requires singly-linked regular sources and supports
replacement or atomic no-replace publication by hard link, with bounded Windows
lock retries that recheck source identity and shape. Existing targets
are preserved; unavailable hard links fail closed. `sourceState` distinguishes
removal, a retained original, a changed or absent source, and an unreadable
identity. It is an observation, not authorization to unlink the source pathname
later. Callers must supply private parent directories; identity checks narrow
races without eliminating them.

`secureFiles.syncDirectory` uses the shared `flushDirectory`
(`@canopy/core-platform/directory-flush`) and rejects with a typed
`DirectoryFlushError` (`stage` open, flush or close; `code` the errno),
preserving a flush failure if closing also fails. POSIX `fsync`s the folder.
Windows opens it read-write and flushes it: "API-level flush; namespace
ordering undocumented; power-loss unverified" (CAN-5151 D1).

## Paths

`paths.appDataDir` uses injected home/environment inputs and host path rules,
including Linux XDG defaults. Windows rejects device namespaces and invalid leaf
names. Its runtime candidate has unverified permissions and is not an endpoint.
`runtimeDirectory` derives only `<explicit canonical data root>/runtime`;
branded root discovery stays with the existing host adapter. No storage, caller
or writer migrates here.

Contract tests use real files on the running host, per-host path tables and
injected Windows receipts. Native Windows ACL execution is gated to Windows;
macOS tests do not establish Windows verification. Cross-OS runtime evidence
remains required at the CAN-3729 join.

## Child supervision

`supervision.childProcessOptions` creates POSIX group leaders and hides Windows
consoles. Windows `owned` children join libuv's parent-exit job; `independent`
children detach. The launcher owns stdio and `unref()`. `childEnvironment` selects
home, temp and application-directory inputs through an allowlist and builds PATH
from explicit absolute directories plus system directories. Inherited PATH,
credentials, loaders and locale are omitted; invalid paths or conflicting
Windows key casing fail closed except for the optional discovery hints below.

Windows also copies optional `ProgramFiles`, `ProgramFiles(x86)` and
`CANOPY_GIT_EXECUTABLE` for Git selection. Program Files roots must be qualified
absolute paths. The override is preserved as supplied, including relative and
space-padded values, so selection can report its presence even when rejected.
All three exclude C0 controls and DEL; missing, empty, control-containing or
conflicting case variants are omitted without blocking startup. Values are
never additions to PATH. The Windows Git selector trims the override and
rejects relative/device paths before file/version probes and requires a
`git.exe` basename before version probes. Rejection bookkeeping can still stat
absolute candidates with other basenames; no override resolves through PATH.
Invalid overrides fall back to discovery. No other Git settings or host PATH
entries are inherited; macOS and Linux keep their existing allowlists.

This narrow allowlist is shared by all daemon hosts and becomes the startup
snapshot for the daemon and its inherited subprocess environments. The inputs
remain host-supplied hints, not trusted executable identities: Git selection
still validates the candidate name, file and version, and prefers a saved
choice. No shell evaluation, filesystem probe or preference mutation occurs
while building the environment. Semicolons stay in individual values, never
in the generated PATH. User-PATH-only discovery is not forwarded; see the
[CAN-5920 inventory debt](../../docs/planning/2026-07-31-desktop-core-daemon/artifacts/behavior-inventory/CAN-5920-windows-daemon-git-environment.yaml).

`killProcessTree` requires an owned, unreaped child (a group leader on POSIX).
It sends group TERM/KILL without bare-PID fallback, or forced `taskkill /t /f`.
`signaled` confirms delivery; `absent` observes only the root PID. Windows
traversal cannot recover already-orphaned descendants.

`inspectProcess` reports a versioned start identity, absence or unverifiable
observation: Linux boot ID/proc ticks in the same PID/time namespace, macOS
C-locale UTC `ps` time at one-second precision, or Windows native creation time.
Windows uses the trusted, source-built x64 `canopy-process-identity.exe`, not
PowerShell/CIM. `OpenProcess` uses limited-query and synchronize rights; zero-time
waits on the same handle bracket `GetProcessTimes`. The handle has one close owner.
Integer FILETIME normalization preserves `win32:v1:<pid>:<UTC yyyyMMddHHmmssffffff>`
with microsecond truncation, including rejection of default timestamps. This is
an incarnation snapshot, not authentication, signal authority or continuing liveness.
Legacy microsecond precision cannot guarantee uniqueness across clock discontinuities.

Commands and each Linux proc read retain cancellation and a four-second deadline.
Windows allows four outstanding observer children per host, shared across fresh
inspectors, with no queue and 64 KiB per-stream output limits. Aborted/timed-out
waiters retain admission until child close. Only a successful explicit no-process
receipt plus independent ESRCH confirms absence after initial presence; query,
access, wait, exit and malformed-output failures stay unverifiable. Windows PIDs
are restricted to 2..2147483647, matching Node's independent presence probe.
Missing/wrong helpers fail closed and composition never eagerly launches one.
The same helper's fixed `--token-user` mode backs `windowsPrincipalObserver`.
It shares that admission and returns the pinned canonical decimal SID, or
fails with `principal_unavailable`. Its receipt contract is in
[bundled runtime maintenance](../../docs/bundled-runtime-maintenance.md#windows-process-identity-helper).
CAN-4722 passes each authority host's selected helper path to it: the daemon
through its closure gate, and Electron main. `deriveLocalAuthorityIdentity`
hashes `["canopy.local-authority", 1, brandId, canonicalDataRoot, principal]`,
where principal is `["posix-uid", uid]` on Darwin and Linux (bytes unchanged)
and `["windows-sid", sid]` on Windows. It refuses a missing observer, a failed
observation or non-canonical SID text with `principal_unavailable`, and a root
that is not a drive or UNC path before or after `realpath` with
`invalid_root`. The transport's root-only hash is separate. Windows serving smoke has passed on windows-2022 since run 40128639752,
including run 40472555301 (CAN-4576).
The historical windows-2022 failure and measured ARM VM PowerShell timeouts are
separate evidence; neither proves the other's cause. Native candidate qualification
must use cold local VM observations; Windows Server qualification remains outstanding.
Existing callers and the other five supervision methods remain unmigrated.

The historical CAN-4576 [test-only backend gate](../../docs/planning/2026-10-21-can-4576-backend-gate/README.md)
rejects job membership/accounting alone as complete descendant evidence: permitted
breakaway can leave a live process outside an empty job. Its native handle-oracle
fixture targets control, contained, silent/explicit-breakaway and nested-job
launches without kill-on-close containment. On the local Windows 11 ARM64 VM it
compiled, then exited 3 with `unsupported_context` on the first childless control
before measured-root creation; Node/task exited 1. No pair or escape scenario ran.
Archived artifacts and verified pre-root cleanup do not prove descendant absence;
the empty diagnostic job-probe scan is not lineage evidence.
The gate's published-contract assessment keeps file-backed process ETW unselected:
stop and recorded-event consumption are documented; complete provider emission and
incarnation-bound ownership attribution remain unestablished. Actual-creator fields
are one possible solution, not mandatory if an audited equivalent binds ownership.
Offline replay could retrospectively prove quiescence at the recording cutoff if
complete history, all owned exits and discharged broker requests are established;
an online consumer is not mandatory. Neither composition is qualified. Classic V2
schema does not qualify an uninspected modern provider. Kernel callbacks offer
process-object/creator and callback-removal primitives but require an excluded
driver route; debugging lacks an accepted non-masking argument. No ETW privilege
failure was observed. Broker-request quiescence and harness bootstrap/post-trace
closure remain separate obligations. No examined option is a complete authorized
backend yet; this is not platform-wide infeasibility. Authority/serving remain
deferred, and no split PR is accepted yet. No production behavior changes.

CAN-4657 (E2) supersedes that paragraph's current-direction claims, preserving
its feasibility record. `src/supervision/windows-closure.ts` is an owned-run-only
contextual witness over Windows Git host/runner, identity and ACL edges: spawn
failures, discarded probes, refused helpers and rejected helper tails stay unsafe.
Only the same live instance accepts its frozen report; late work can revoke
eligibility. Wrapper close is not recursive descendant proof. The gate's
self-contained [current status](../../docs/planning/2026-10-21-can-4576-backend-gate/README.md#current-delivery-status-can-4657--e2)
owns the separate I1 next step, where finite source-compositional proof is
admissible and no universal ledger is required. No daemon wiring, authority/serving
cutover or production launch/termination policy change is included.

CAN-4671 (I1) consumes the witness in the daemon. The barrel exports only
`createWindowsClosureWitness`, `captureWindowsClosureContext` and the
`WindowsClosureReport` type; `observeWindowsClosure` stays internal. On win32 a
Git `check-ignore` run marks its edge unsafe, since it may leave an fsmonitor
daemon; argv, environment, kill and timing are unchanged.

CAN-4722 (C1) discharges that mark. Win32 `check-ignore` with a `git.exe`
image whose selected version is an audited Git for Windows release
(`fsmonitorDischargeAudited`) now runs as
`git -c core.fsmonitor=false check-ignore -z --stdin`, and the runner marks a
`check-ignore` edge unsafe when its plan lacks that prefix
(`dischargesFsmonitor`). Selection passes the version it parsed and the file's
`stat` identity with the executable (`SelectedGit`); a bare path, an unaudited
version or a file replaced since validation gets no prefix and stays unsafe.
In a closure run the edge also stays unsafe unless the file still has that
identity just before and just after the spawn. POSIX argv is
unchanged. The discharge rests on a source audit of Git for Windows 2.36
through 2.56, recorded in
[bundled runtime maintenance](../../docs/bundled-runtime-maintenance.md#windows-check-ignore-fsmonitor-discharge).
The packaged smoke uses the same predicate and reports any other Git version
as `unsupported_context`.

CAN-4672 (E3) adds a manual native [survivor-negative fixture](../../scripts/fixtures/windows-fsmonitor-oracle/README.md)
for that witness. With the persistent-monitor obligation explicitly reserved, a
real repository fsmonitor bound to a retained process handle is live at the
frozen nonpass, then exits 0 through that same handle. That nonpass carries the
`check-ignore` unsafe mark above and keeps the reserved edge pending. It is
test-only and outside CI, and neither discovers the obligation nor qualifies
daemon lifetime or serving ([status](../../docs/planning/2026-10-21-can-4576-backend-gate/README.md#survivor-negative-challenge-can-4672--e3)).

`readProcessTable` (CAN-4135) returns every host process the user can see,
for resource accounting only: PID, parent, process group (Windows reports the
PID), CPU as a share of all logical CPUs, resident memory and the executable's
base name, never its arguments. darwin runs `/bin/ps -axo` and win32 runs the
`Win32_Process` query through `powershell.exe` (15 s timeout), each with an
8 MiB output bound; linux reads `/proc/*/stat` and `/proc/*/cmdline` and the
page size from `/proc/self/auxv`, starting no child. Windows and Linux report
cumulative CPU time, so CPU is measured between one reader's consecutive
reads, a first read reports zero, and a reused Linux PID (a new start time)
is not charged with its predecessor's time. An unreadable table is
`unavailable`; only the caller's abort rejects. The daemon closure gate
refuses it once sealed.

## Owned daemon roots (host-only)

`createOwnedChildServices` launches the daemon root for startup rollback on
Darwin and, since CAN-4966, Linux (a process group held by its unreaped root)
and, since CAN-4929, on Windows: one kill-on-close job per root with no
breakaway flags, entered while
the root is still suspended and held with the root's process handle. Job
membership is containment here, unlike the libuv parent-exit job above: the job
forbids breakaway, so a descendant that silently leaves a nested libuv job
stops in it. The root's hidden `conhost.exe` follows job inheritance like any
child, so members and cleanup count it until it leaves after the root; the
native suite records its membership. On its first spawn, a Node or Electron
process joins a kill-on-close libuv job of its own, with its attached
children. The launcher therefore usually sits in such a job, and the root
breaks away from it so that a committed daemon outlives the launcher. The
root and its attached helpers likewise sit in the root's libuv job, nested in
the owned one. Job queries made from inside those processes report the libuv
job, so the suite reads the owned job from a detached leaf that spawns
nothing. `commit()` clears kill-on-close. `spawnWithChannel` stays
Darwin-only. Linux shares the Darwin source (`owned_child.c`): it enumerates
the group from `/proc/<pid>/stat`, signals it before trusting an empty
listing, does not count exited (zombie) members unless another of their
threads still runs, closes descriptors above 2 with a `closefrom` spawn
action, and blocks and consumes `SIGPIPE` around the stdin write. Like
Darwin, a host killed before commit leaves the uncommitted root to idle out; neither sets `PR_SET_PDEATHSIG`, which would also end committed
daemons. Since CAN-5140 the addon's `launch`
also starts execution children inside jobs of their own; see below. The contract, staging and failure
behavior are in
[bundled runtime maintenance](../../docs/bundled-runtime-maintenance.md).
`supervision-owned-child.windows.test.ts` records native Windows evidence:
containment of a silent-breakaway Node grandchild and of `git.exe` → `sh.exe`,
host-exit and crash rollback, committed survival, the PID-reuse guard, argv
and environment round trips, and loads in `electron.exe` and a renamed
`node.exe`. On windows-2022 it passed in run 40128639752 (job 120975551613):
the Jest process's job permits breakaway (`0x3c00`), host roots broke away
from their launcher's job, owned-job flags went from `0x2400` to `0x400` at
commit, and host exit, throw and crash left no tree process; the
`electron.exe` and real-daemon cases skip there. The CLI and client daemon-host suites exercise the same backend
through the production host composition on Windows (CAN-4964), though not yet
on windows-2022. Their descendants are detached, so only the owned job, never
a libuv job, can end them. Hosts that compose their own `PlatformServices` on Windows must pass
`windowsProcessPath`; without it every inspection is `unverifiable`.

## Execution processes (host-only)

`createExecutionProcessServices({ os, nativePath })` (CAN-4134) starts
execution children for worker hosts. It is host-only, like owned roots, and
outside `PlatformServices`; the contract is `PlatformExecutionProcessServices`
in `@canopy/core-runtime`. The darwin and linux [power](#power) helpers use
it lazily, Electron main composes it for login-shell PATH probes, and
`createOwnedProcessHostPort` in `@canopy/core-platform/execution-host`
launches the pipeline and graph hosts on it for hosts without Electron
(CAN-5071). Terminals, scripts and the separate local worker build on it
later.

## Execution host shell (CAN-5085)

`@canopy/core-platform/execution-host/shell` enforces a host's memory budget
from inside the host process, so it works in the closed single executable,
which refuses Node options. `runRequestedExecutionHostShell(args, entries)`
returns false unless `args` are the shell arguments
(`executionHostShellArgs`); otherwise it runs the named entry from
`entries.directory`, refusing any name not in `entries.names`, on a worker
thread whose old generation is capped with `resourceLimits`. The idle main
thread relays stdio, samples the resident set and the entry's heap, and
stops the entry past either limit; the heap watch holds the budget even when
a process-wide V8 heap option (which the owned-process port strips from
`NODE_OPTIONS` for budgeted hosts) lifts `resourceLimits`. Exit codes: the entry's own, 251 at the heap limit, 252 at the
resident limit, 143 after SIGTERM, 130 after SIGINT and 64 for malformed
arguments. Terminating the entry thread tears down its isolate, closing its
SQLite connections. The owned-process port runs budgeted launches through a
`shell` command; the core daemon's port relaunches the daemon, which calls
the shell before any daemon startup.

Each child gets stdio pipes and a whole-tree owner. stdout and
stderr are credit-metered: delivered bytes hold credit until acknowledged, so
no more than the window (64 KiB by default, at most 1 MiB) is outstanding, and
past it the pipe stops being read and the child blocks. `stderr: 'discard'`
still drains. `start` resolves once the child has started inside its tree;
`outcome` resolves exactly once, after the root's exit and the delivery or
discard of all output, as `exited`, `crashed` (a signal or Windows exception
status without a stop request), `cancelled` or `lost`. `terminate` discards
output, so a consumer that stops reading never withholds the outcome.

Trees are POSIX process groups on darwin and linux: the root is a detached
group leader, signals go to the group (TERM, then KILL after a grace), and
custody ends at the first probe that finds the group empty, so an empty
group's ID is never signaled again. Until the root is reaped its PID reserves
the group's ID; after that only a living member does, so the group of an
exited root is re-probed every 250 ms. If it goes unseen for 2 s (a stalled
host), its ID could have been recycled: custody lapses without another
signal, and `terminate` and `shutdown` report unconfirmed cleanup. That signal path is
`signalProcessGroup`, shared with `killProcessTree`.

On win32 the owned-child addon's `launch` (CAN-5140) creates the child
suspended inside a kill-on-close job of its own that forbids breakaway, so
the child runs no instruction outside it and no descendant can start outside
it. Node cannot hand pipes it owns to a child it did not start, so stdio are
named pipes instead: the addon creates one per stream, single-instance, local
only and open to the current user alone, and the child inherits the server
ends. The service connects to each as its client, and the addon's `resume`
runs the child only once every pipe's client is this process; otherwise the
job is stopped before the child ran and the start fails. Stdout and stderr
are then the same credit-metered streams as on POSIX. The executable is
picked as libuv picks it (the name, then `.com`, then `.exe`), batch files
are refused as Node refuses them without a shell, and libuv's required
variables missing from the request are passed empty, as Node passes them.
The root's exit is polled through the addon, and a
stopped tree reports SIGKILL with no code, as daemon roots do. The record
takes the same stop loop, release and host-exit rollback as daemon roots, so
roots and execution children share one Windows kill path; a host crash ends
the job through kill-on-close. Without an addon that can launch, win32
starts fail with `capability_unavailable` before anything starts. A root's surviving members
stay owned until `terminate` or `shutdown`, and are rechecked until gone.
Handled host exit force-stops every tree still held, through the same exit
custody as owned roots. On POSIX, a host killed without running its exit
handlers leaves the group running.

The suites run real children under plain Node: `supervision-execution-process`
(stdio, credit bounds, outcome under output pressure, tree cleanup after
cancel, shutdown and host exit, a grandchild started first thing stopped by
`terminate` and by `shutdown`, and on win32 a launched child that runs
nothing before `resume` and is refused when this process did not connect its
pipes), `supervision-execution-claude-conformance`
(the Claude process-host protocol served over the primitive, replaying the
utility worker's backpressure, kill, crash and shutdown cases) and the
controlled `supervision-execution-process-custody`. darwin and linux need
nothing native. win32 builds the addon, or in the PlatformServices job
requires the prebuilt `CANOPY_OWNED_CHILD_ADDON`.

## Power

`PlatformServices.power` (CAN-5066) keeps the host out of idle system sleep;
the display may still sleep. `preventSystemSleep({ reason })` returns an
assertion, `unavailable` when the host has no backend, or `failed` for one
refused attempt. An assertion reports `held` once the OS holds it and `ended`
once it no longer does, as `released` or `lost` with a fixed reason. Nothing
loads or starts until the first request. Holder policy (which work keeps the
computer awake, and when it lets go) is the core `WakeLockPolicy` in
`@canopy/core-runtime`, not this port.

- darwin runs `/usr/bin/caffeinate -i` and linux the first of
  `/usr/bin/systemd-inhibit` and `/bin/systemd-inhibit` with
  `--what=sleep --mode=block`, each around `/bin/sh -c` that prints a ready
  marker and waits on stdin. They start through the execution-process
  services with a fixed environment and no PATH lookup; release stops the
  helper's group gracefully. Handled host exit stops it through the custody,
  and a crashed host closes the helper's stdin, so the helper exits and the
  OS drops the assertion. `caffeinate` asserts from a forked child as it
  execs the command, so the marker can precede the assertion by moments. A
  logind block inhibitor also refuses a user-initiated suspend until it ends;
  lid-close handling ignores it by default.
- win32 calls `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`
  through the owned-child addon's `setExecutionState`, set for the first
  assertion and cleared after the last. Windows drops it with the host's
  main thread. Without the trusted `ownedChildPath` composition input,
  requests are `unavailable`; the Windows daemon does not stage the addon
  yet (CAN-5091).

The daemon's closure gate refuses power requests once sealed. The daemon
requests power for its running workflows while the keep-awake preference is
on (CAN-5872, `apps/core-daemon/src/wake-lock.ts`). The in-process desktop
composition supplies Electron `powerSaveBlocker` behind the same port.
`power.test.ts` covers the adapters over fakes; `power-native.test.ts` checks
the real backend on the host: the `pmset` assertion on darwin, including after
a SIGKILLed host, `systemd-inhibit --list` on linux when logind grants the
inhibitor, and the execution state through `CANOPY_OWNED_CHILD_ADDON` on
win32.

## Trash

`PlatformServices.trash` moves an entry to the OS trash or recycle bin with
the signature of Electron's `shell.trashItem`: `trashItem(path)` resolves only
once the OS reports the move, and rejects otherwise. This contract holds for
every host that supplies the member, the desktop daemon now and any later
host. `path` is absolute and normalized (no `.` or `..` segments and no
repeated or trailing separator; on Windows, no forward slash; elsewhere a
backslash is part of a name), and the entry
at it is moved itself: a symlink or junction goes to the trash, never its
target. No backend falls back to a permanent delete, a copy then delete, or
`rm`.

`createNativeTrashServices(os, { ownedChildPath })` (CAN-4726) builds the
native backends. Nothing loads or starts until the first request, and
`createPlatformServices` never composes it on its own: no host passes it yet,
and Electron keeps its `shell.trashItem` adapter. Its rejections are
`PlatformTrashError` (from `@canopy/core-runtime`), with fixed messages and
no paths:

- `unavailable`: this host, or the entry's volume, has no trash, or the
  backend is missing (no `gio`, no staged addon). Nothing was moved.
- `failed`: nothing was moved; the entry is still in place, or the request
  named no readable entry (an invalid path, or one that does not exist).
- `unconfirmed`: the backend ended without a report it stands behind (it
  crashed, timed out, overflowed its output or contradicted itself) and the
  entry is no longer at its path. It may be in the trash, or gone.

A rejection that carries no code, such as Electron's, means `failed`. Every
request reads the entry's `lstat` identity (device and inode) before the
move and again after it, so a report is checked against the filesystem: a
claimed move with the entry still in place is `failed`, and any other outcome
with the entry gone is `unconfirmed`, never "not removed".

- darwin runs `/usr/bin/osascript` with a fixed JXA script that calls
  `NSFileManager trashItemAtURL:resultingItemURL:error:`, the API Electron
  uses. The path arrives URI-encoded through argv, never in the script, and
  the URL is built without a directory check, so a link to a directory stays
  a link. `NSFeatureUnsupportedError` is `unavailable`; other refusals are
  `failed`. The helper runs under execution-process custody with `LC_ALL=C`,
  no PATH lookup, bounded output and a 60 s timeout. It runs under the host's
  privacy attribution, so a protected folder may refuse it or wait on a
  prompt until the timeout.
- win32 calls the owned-child addon's `recycleItem`: `IFileOperation`
  `DeleteItem` with `FOFX_RECYCLEONDELETE` on a thread of its own in a fresh
  STA. Its progress sink aborts any delete the shell does not mark
  `TSF_DELETE_RECYCLE_IF_POSSIBLE`, so an entry on a volume without a Recycle
  Bin, or one too large for it, is `unavailable` instead of deleted; a
  success the shell reports without a Recycle Bin item is `unconfirmed`.
  Without the trusted `ownedChildPath`, Trash is `unavailable`.
- linux runs the first of `/usr/bin/gio` and `/bin/gio` as `gio trash` with
  `GIO_USE_VFS=local`, `LC_ALL=C`, a fixed PATH, and only the host's `HOME`
  and `XDG_DATA_HOME`. GLib renames the entry into the home trash or the
  volume's `.Trash-$UID` and never copies across devices. GLib's "no trash
  directory", "not supported" and "across filesystem boundaries" messages are
  `unavailable`: an entry off the home device on a system-internal mount
  (tmpfs, as `/tmp` is on some distributions) has no trash, nor has one whose
  home trash is on another device. Without `gio`, Trash is `unavailable`.

Engines map the codes: `unavailable` to the protocol's Trash-unavailable
outcome, and `failed` to "not removed". `unconfirmed` has no protocol outcome
yet; whoever composes the backends into a daemon route (E2) must give it one
rather than report it as either. The daemon's closure gate refuses Trash
requests once sealed. `trash.test.ts` covers classification, the helper runs
and each backend's argv, environment and report parsing over fakes;
`trash-native.test.ts` moves real entries on the host: darwin through
osascript, linux through `gio` with `HOME` and `XDG_DATA_HOME` in the test
directory (or the `unavailable` report without `gio`), and win32 through
`CANOPY_OWNED_CHILD_ADDON` (else the `build:owned-child` output), checking
each recycled entry's Recycle Bin record, including a junction and a UNC path
that must be refused in place.

## W5 capture reads on Windows

`@canopy/core-platform/w5-confined-read` (CAN-5202) supplies the
`W5ConfinedFileReader` the W5 capture in `@canopy/core-runtime` requires on
win32, over the owned-child addon's `readConfinedFile`
(`native/owned-child/src/confined_read_win.c`). The trusted root opens by its
resolved path without following a final reparse point, and its handle's final
path must equal that path. Each component then opens with `NtCreateFile`
relative to its parent's handle and `FILE_OPEN_REPARSE_POINT`, so renaming or
replacing an ancestor cannot redirect the walk. Any reparse point is
`unsafe-path`, never followed, and the file handle's final path must still be
the intended in-root path before bytes are read. The capture passes the root
the host anchored (its realpath, resolved once before any capture), since an
ancestor swap would redirect `realpath` too; a root that no longer resolves
to that anchor refuses as `root-changed`. A swap after that check is
root-level too, never one file's image: a root handle that does not name the
root, checked again after any outcome but `present`, is `root-changed`, as is
a file whose final path is no longer under the root's (the root moved
mid-walk, even if back by that check), and a root that does not open is
`root-unavailable`; either refuses the whole
capture before log evidence is read. Handles share read, write and
delete. The call is stateless, so each W5 worker thread, the desktop's or
the core daemon's, loads the addon its host stages, once, on its first
capture. Without the addon, or with
one that lacks the call, there is no reader and Windows capture refuses
(`confinement-unavailable`); a malformed or throwing call reads as `io`.
`w5-confined-read.test.ts` covers the result validation and loading;
`w5-confined-read.windows.test.ts` runs the native walk on Windows, including
races that repeatedly swap a workspace directory or a root ancestor for a
junction, against `CANOPY_OWNED_CHILD_ADDON` or an addon it builds.

## Git reads (private)

`src/git-read/` (CAN-4331, U1 of CAN-4303) runs a fixed command set with
desktop's arguments, environments, per-stream limits and kill signals: `git
--version`, the macOS bare-init smoke, `git check-ignore -z --stdin`,
`xcode-select --print-path`, the macOS and Linux login-shell PATH probes,
`getent passwd <uid>` and `where.exe git`. The package index exports none
of it; its only caller is the [Git read host](#git-read-host).

CAN-5943 additionally admits the exact fifteen repository kinds behind
branch, remote, worktree-health and change-set queries on Windows. They use
the staged CAN-5140 owned-child addon's suspended launch in a no-breakaway
job. A launch that starts nothing (no addon, or a failed job, pipe or process
creation) runs the read uncontained through Node spawn and taskkill instead
of refusing it, with unsafe closure evidence. Every job result waits for
job-empty cleanup; failed cleanup proof latches non-idle. A helper surviving
root exit invalidates qualification evidence even if later cleanup succeeds.
The [per-kind closure analysis](../../docs/bundled-runtime-maintenance.md#windows-repository-command-closure-can-5943)
records filters, lazy fetch and unsupported broker-created processes. Files
Git reads and POSIX process-group behavior below are unchanged.

Each request takes an explicit `cwd`, a caller-supplied environment (ambient
`process.env` is never read) and a monotonic deadline. A command name without
a directory (`where.exe`, a Git or `SHELL` such as `git`) is looked up only in
the absolute directories of that environment's PATH, and the absolute path
found is what is spawned. Neither the `cwd` nor the host's PATH is searched,
although spawn's own lookup would use both: Windows tries the `cwd` first, an
empty or `.` POSIX entry names it, and a missing PATH falls back to the host's
(Windows) or `/usr/bin:/bin` (POSIX). On Windows the candidates are libuv's:
the name as given when it has an extension (a first dot followed by any
character, so `a.b.` but not `git.`), then `.com`, then `.exe`, with no second
dot after a trailing one (`git.com` for `git.`). A
relative path with a directory part (`./git`, `sub\git.exe`) is rejected with
`invalid_request`, and a name the PATH lacks with `command_not_found`, both
before any process starts. The lookup counts against the request's deadline
and abort. On Windows, the PATH searched is the case variant Node keeps: the
first in sort order. Except for Windows repository jobs, owned children are stopped from a timer or `setImmediate` turn, after an
`exitCode`/`signalCode` check in that turn, by `killProcessTree`. Work stops a
cleanup reserve before the deadline. After the root exits, held pipes drain
for a bounded window and are then destroyed. A root that exited or failed to
spawn settles its request at the child's `close`; an abort before then rejects
a successful result. Group members left after a normal
exit are not killed. A stdin failure stops the root and settles first, as
desktop's EPIPE does; on Windows the write fails with EOF instead. The first
failure or abort decides the result. If the root's exit is unconfirmed when the
reserve ends, the request rejects with `cleanup_unconfirmed`, carrying the kill
failure or that first cause.

On Windows, `taskkill` runs asynchronously, so the port's PID-reuse window
remains, and settlement waits for it within the cleanup reserve (2 s by
default). When the reserve ends first, the request still settles then, with
`cleanup_unconfirmed` while the root's exit is unconfirmed. The kill call is
not cancelled: it gets no abort signal, runs on within the port's 4 s
`execFile` bound, and is not awaited. Its late result cannot change the settled
request: `onKillCleanup` reports `cleanup_unconfirmed` for each kill still
running at settlement and `failed` if it then fails. A failure before
settlement belongs to the request instead. A request or host abort does not stop it. The host process exiting
can, through libuv's kill-on-close job; that is not observed for `taskkill`.
No signal is passed because
`execFile` given an already-aborted one still starts `taskkill.exe` and then
terminates it, leaving the tree; the native suite records this. It also shows
a call made after the reserve, and a Node stand-in still running then that
calls the real `taskkill` later, each ending the tree. A real `taskkill` still
running when the reserve ends is not observed directly. `taskkill` uses the
child environment's SystemRoot. When the host exits, libuv's kill-on-close job
ends only the owned child. The job allows silent breakaway, so the child's descendants survive
unless the child puts them in a job of its own, as a libuv child does. An owned
`cmd.exe`'s child survives. So do the `conhost.exe`, `sh.exe` and `sleep.exe`
below an owned Git for Windows `git.exe` running a shell alias; the suite
asserts only `sh.exe`.

Windows child environment: libuv v1.51 (`src/win/process.c`, bundled with
Node 24) copies HOMEDRIVE, HOMEPATH, LOGONSERVER, PATH, SYSTEMDRIVE,
SYSTEMROOT, TEMP, USERDOMAIN, USERNAME, USERPROFILE and WINDIR from the host
into a child whose environment lacks the key, matched case-insensitively. No
other host variable reaches the child, and a key with an empty value is kept.
The runner therefore passes only the case variant of each key that Node keeps
(the first in sort order) and adds each of these keys the request omits with
an empty value, so the child receives nothing from the host. A request whose
child would get a PATH with no absolute directory, or a SystemRoot that is
missing, empty or not a drive path (`C:\…`), is rejected with
`invalid_request` before any process starts: a Node child with an empty
SYSTEMROOT fails to start, and `taskkill` could not be located. `taskkill`
itself receives only that SystemRoot, so libuv fills its other listed keys
from the host; they reach `taskkill`, never the git-read tree.

The macOS bare-init smoke's scratch directory (desktop parity) is created and
removed under the same deadline and abort: creation must finish by the
reserve, and removal waits at most the reserve, never past the deadline. After
an abort, one reserve covers both stopping git and removal. The request keeps
its first result: a failed removal, or one still pending at its bound
(`cleanup_unconfirmed`), never replaces it and is reported separately through
`onScratchCleanupFailure`. A directory created after the request settled is
removed when it appears. `checkIgnoredPathsWith` keeps desktop's 5,000-path chunks,
decoding, results and first-failure ordering, with one executable and a
`requestDeadlineMs` (30 s) deadline. `checkIgnoredPathsSelected` keeps the same
rules under the caller's deadline and signal, and awaits
`executableForChunk(chunk, signal, deadlineAt)` before each chunk. With any
paths, an invalid `cwd` or environment rejects `invalid_request` before the
first selection, and an aborted request makes no further selection. The runner
waits for it until the cleanup reserve or an abort, then aborts its signal; a
selection failure counts as that chunk's failure. The optional
`onChunkStarted(chunk, selected)` runs once the chunk's process has spawned,
never for a chunk aborted, refused in planning or failed at spawn; the Git read
host records its `selections()` from it. `whenIdle(signal)` resolves
`idle` once no request is in flight and no owned root (until its `close`),
continuing kill, or scratch creation or removal remains, and `pending` if
`signal` aborts first.
An abandoned PATH lookup or selection does not count: the lookup only reads,
and the selection is the caller's work. The fsmonitor hook runs inside
the owned group. Where Git has the builtin fsmonitor daemon (macOS, Windows,
and Git 2.55 on ubuntu-latest), it detaches and outlives the request; a Git
built without it (Debian's 2.39) reports it unsupported.

The runner and check-ignore suites run on POSIX hosts.
`git-read-windows.test.ts` asserts the Windows behavior above, and
`git-read-host-probes.test.ts` runs each host's real probes. Both run only on
their own OS, which for Windows means the PlatformServices job. The Windows
suite separates a kill call made after the reserve ended from a kill helper
still running then. The helper is a Node stand-in that calls the real
`taskkill` only after the reserve. Each Node fixture holds a named-pipe
connection to the suite that closes only when its process ends. Native
processes a case leaves running (an owned `cmd.exe` or `git.exe`, what they
started, the fsmonitor daemon) are identified by their .NET start time. After
each test, the suite ends what remains and confirms it gone; a survivor fails
that test. A survivor of the final sweep, or a temp directory it cannot
remove, fails the suite. After that sweep, the suite records, without
asserting, any other process created during it that still runs under a
fixture's process name or in its directory. Untracked processes it does not
wait for, such as Node fixtures' console hosts, are covered only by that
record. The Linux login-shell probe is
compared with the same shell run directly, because a host's system profile can
replace HOME so that the supplied profile is never read. In CI, the suites write their observations to
`.cache/platform-contracts/git-read-*.json`, which the job uploads. Each
observation carries its full test name, as in the job's `jest-results.json`.

## Git read host

`createGitReadHost({ os, environment, probeDirectory, onCleanupReport })`
(CAN-4395, U2b of CAN-4303) is the trusted, read-only Git selection and
`check-ignore` host behind the `GitIgnoreHostPort` that
`createReadOnlyDirectoryInputs` consumes. It reproduces desktop's
`detectGitExecutableInternal` and `getResolvedGitExecutableForSpawn` over the
private runner. It never installs Git, writes or clears a preference, or
publishes an environment variable, and it exposes no generic command API.
The packaged daemon composes it behind directory reads (CAN-4304), with its
environment snapshot taken after the claim marker is consumed and the
canonical data root as `probeDirectory`. It prewarms the host on start and
stops it in shutdown phase 5.

- **Construction** copies the daemon's own startup environment once, dropping
  undefined values, and does no I/O. It never throws. An unusable probe
  directory fails each request with `invalid_request`, and an unusable
  snapshot with `environment_invalid`. Only a successful validation is kept;
  a failure is checked again on the next request (CAN-7113).
- **Each request** returns an empty set for no paths, without a saved read or
  spawn. A pre-aborted or aborted request rejects with its signal's reason. One
  30 s deadline covers selection and every 5,000-path chunk. Before each chunk
  the host reads the saved value and selects. `check-ignore` then runs in the
  request root with the snapshot environment.
- **Repository reads** (`repository.readRepository`, the `worker.git.*`
  commands) run with the snapshot unless the request carries its own
  `environment`, the per-request environment a trusted caller forwards
  (CAN-5496). That environment replaces the snapshot for this command only:
  it is validated before any spawn (`invalid_request` otherwise), never kept,
  cached or reported, and `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`
  still override it. Selection, its probes, `check-ignore` and the ignored
  listing keep the snapshot.
  The change-set operation still refuses forwarded execution and keeps the
  startup snapshot, lazy-fetch suppression and no-patch policy (CAN-4729).
- **Errors** are `GitIgnoreHostError` codes with fixed text: runner codes pass
  through, except `command_not_found` and spawn errors, which become
  `git_unavailable`. `lastFailure()` keeps the last code until a request
  succeeds.
- **Selection** on macOS and Windows tries the trimmed saved value, then the
  snapshot `CANOPY_GIT_EXECUTABLE`, then discovery. macOS discovery uses
  `getMacGitCandidates`, skipping shims. Windows runs `where.exe git`, then
  `getWindowsGitCandidates`, deduplicated case-insensitively. Windows accepts
  only host-absolute paths. Linux x64 and arm64 keep an explicit choice (the saved value,
  else the snapshot override) and reports it when broken, never replacing it.
  Without one, it revalidates its discovery cache, awaits the login-PATH
  refresh and tries `getLinuxGitCandidates`. A request with a saved choice
  drops that cache when it becomes the latest (below), whichever detection then
  serves it, as desktop's saving or clearing one does. Other Linux spawns the
  override or `git` through the snapshot PATH, unvalidated. A validated
  selection keeps desktop's spawn fast path. ENOENT or ENOTDIR there reselects;
  any other lookup error is `selection_rejected`.
- **Shared work**: detection is single-flight per trimmed saved value and its
  `stat` identity, with its own 30 s deadline under the host's lifetime. The
  deadline and a stop end each of its filesystem lookups, probes and any
  login-PATH refresh it awaits; a stalled lookup is abandoned. A request waits
  for it only within its own deadline and never cancels it, so a cold first
  listing can fail with `deadline_exceeded` while the next one uses the result.
  A failed explicit value is remembered, not cleared, for 5 minutes while its
  `stat` identity (`dev`, `ino`, `size`, `mtimeMs`, `ctimeMs`) is unchanged; the
  next detection re-checks a changed one. A selection is keyed by the saved
  value and its identity only, so a fallback discovered over a failed snapshot
  override stays selected until detection re-runs: at the TTL, when the fallback
  fails the spawn fast path, or when the saved value or its identity changes.
  A detection records (an explicit value's rejection or its clearing, a Linux
  discovery-cache update, its selection) only while it serves the latest
  request, started or joined, and has not ended; afterwards it records nothing.
  What it recorded while current is a real observation, so it stays after a
  later supersession. Requests are ordered by when they read the saved value.
  Once its `stat` identity is known, a request becomes the latest unless a
  newer read already has. It then supersedes a pending detection for another
  key, even when the fast path keeps its selection.
- **Probes** run in `probeDirectory`. On macOS they add `SHELL` (the snapshot's,
  else the account's absolute shell, else `/bin/zsh`) and the account's `USER`
  and `LOGNAME`, omitted when `os.userInfo()` throws. The macOS login PATH is
  stale-while-revalidate with a 5-minute TTL. Each refresh has its own 30 s
  deadline from its start. Linux x64 and arm64 detection awaits it only within its own
  deadline. The Linux refresh chooses the shell from the snapshot `SHELL`, then
  `getent`, then `/bin/bash`. The macOS bare-init scratch goes under the
  snapshot `TMPDIR`, else `/tmp`.
- **`prewarm()`** starts the login-PATH refresh on macOS and Linux x64/arm64. It has
  no preference source, so it does not select.
- **`stop(signal)`** aborts in-flight work and waits for detection and the
  runner, including a Windows `taskkill` still running after settlement. A
  filesystem lookup that detection abandoned is not waited for. It
  returns `cleanup_unconfirmed` if `signal` aborts first. Later calls reject
  with `stopped`. `onCleanupReport` receives the runner's kill and scratch
  removal reports.

The architecture, a `SelectionIo` seam (`stat`, `realpath`, `access`), the clock
and the runner are private seams for tests (`createGitReadHostWith`). The
shared selection table
(`packages/protocol/src/git-executable/__tests__/selection-scenarios.json`)
replays through desktop's module mocks and through this host. Each daemon
difference must be one of the named deliberate divergences in
`git-read-host-fakes.ts`. `git-read-host-process.test.ts` covers real
processes, real repositories, the composed no-write inventory and Windows
`taskkill` after settlement. `git-read-feasibility.test.ts` (G1) records
production selection under the daemon child environment, with and without
account facts, against the runner's full environment.

## Git write host

`createGitWriteHost({ os, environment, selectExecutable })` (CAN-4108) runs
the daemon's `worker.git` branch writes behind the `GitRepositoryWritePort`
that `createRecordedWorkerGitHosts` consumes: thirteen fixed POSIX command
kinds (status, two `show-ref` probes, `check-ref-format --branch`,
`for-each-ref`, `rev-parse --abbrev-ref HEAD`, the single-branch fetch,
`checkout` and `checkout -b`, and, for CAN-5516, `branch -m`, `branch -d`,
`branch -D` and `update-ref -d refs/heads/<branch> <tip>`). Every kind is
refused on Windows with `unsupported_command` before any process starts (D10),
and a ref value that is empty, option-like or NUL-bearing, or a tip that is
not a full lowercase object ID, is refused with `invalid_request`. Commands run in a trusted
absolute directory with the request's forwarded environment (CAN-5496) when
the caller supplies one, else the daemon's own startup environment, plus Git's
non-interactive switches, as the read host's repository reads do. A forwarded
environment a child cannot hold is `invalid_request` before selection; it is
used for that command only and never kept.

The executable is the [Git read host](#git-read-host)'s selection
(`selectWriteExecutable`), so a daemon selects Git once; an executable that is
not absolute is `git_unavailable`. Commands take no signal and no deadline: a
caller's cancel never reaches a child (CAN-4108 Q11). Only the single-branch
fetch is bounded, and its process group is killed at 10 seconds. `stop` refuses new
commands and waits for started ones, killing none; it reports
`cleanup_unconfirmed` when its signal aborts first. The daemon folds this stop
into the Git read service's phase-5 stop, ahead of the read host's.

CAN-5517 adds six kinds for `worker.git.fetch` and `worker.git.pull`:
`fetch [--prune] origin`, `pull --ff-only origin <branch>`,
`pull --rebase --autostash origin <branch>`, `rev-parse --git-path` for
`rebase-merge` or `rebase-apply` only, `stash list` and
`status --porcelain=v1`. They follow the same rules; the fetch and both pulls
contact `origin` and, like every effect, are never bounded or killed. The
recorded host classifies a failed rebase pull from the rebase state, the
stash list and the status alone.

CAN-7113: a non-zero exit answers `failure` (`authFailed`, `nonFastForward`,
`hookRejected`, `nothingToCommit`, `gpgFailed` or `other`), classified from the
last 16 KiB of Git's English stderr and its stdout, never returned. A signal
exit is `exit_status` with an allowlisted `signal`; a spawn failure is
`git_unavailable` with `{ errno, stage: 'spawn' }`.

CAN-5882 adds `head-sha`, `tracking-head-sha`, `stage-all`, `commit-message`
and `push-head`. They run `rev-parse --verify`, `add -A`, `commit -m` and
`push -u origin HEAD` only, without force or a child abort signal. CAN-6869
pins the push to the commit the worker checked: `push-head` carries its
branch and head and runs `push origin <head>:refs/heads/<branch>`, and a
`set-upstream` kind (`branch --set-upstream-to`) then tracks it, best effort,
as `-u` did. Push takes
the dispatch key, mints the daemon-owned GitHub authority's K3 `git-push`
lease for `worker.git.push`, and spawns synchronously inside `lease.deliver`
with the delivered `GH_TOKEN`. K10 refuses forwarded token, askpass and
credential configuration authority; refusal is typed, never a token-forwarding
fallback. Phase 2 authority and lease contracts are unchanged. Production has
no grant or route for either instruction; CAN-4731 owns enablement, and
CAN-4733 owns keyed retention and durable operation follow-up.

CAN-5884 adds six fixed POSIX merge command kinds: worktree list/add/remove,
merge --no-edit, merge --abort and rev-parse HEAD. Worktree paths come only
from trusted host resolution or its unique temporary path and are absolute
and NUL-free. Commands use the request's environment and never take a signal
or timeout; conflict classification reads status before best-effort abort.
Production grants and Electron routing remain unchanged.

Together the branch, sync, commit/push and merge hosts expose 30 fixed command
kinds; the daemon registers nine Git instructions without production grants.
