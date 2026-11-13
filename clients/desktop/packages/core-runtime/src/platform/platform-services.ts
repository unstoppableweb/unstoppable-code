// ADR 25 host-adapter port. Type-only: no Node, Electron, net, or transport
// imports. Local paths stay at this boundary, outside portable operation DTOs;
// no Node handles cross it. `@canopy/core-platform`
// selects one implementation per host at composition. Endpoint families land
// first (C2a scaffold, CAN-3763; behavior in CAN-3766); secure files and paths
// are C2b/C2b2 members; child supervision is C2c; power is CAN-5066; the
// host-supplied Trash member is CAN-4101.

export type PlatformOperatingSystem = 'darwin' | 'win32' | 'linux';

export type PlatformSupportTier = 'primary';

/**
 * `filesystem-socket`: a Unix socket path that can outlive its process, so a
 * stale path needs probe, identity re-check, and unlink under the startup claim.
 * `first-instance-pipe`: a Windows named pipe bound with first-instance
 * semantics; it has no filesystem node and nothing to unlink.
 */
export type PlatformEndpointSemantics =
  | 'filesystem-socket'
  | 'first-instance-pipe';

/**
 * A short path to a long data root's runtime directory (CAN-5694). The socket
 * stays in that directory; binding and connecting resolve the link, so every
 * real directory on the way keeps its permission check.
 */
export interface PlatformSocketAlias {
  /** `<tmp>/canopy-<uid>`: a real directory the user owns, mode 0700. */
  readonly directory: string;
  /** `<directory>/<hash of the data root>`: the user's link to `runtimeDirectory`. */
  readonly link: string;
  /** The canonical runtime directory the link must resolve to. */
  readonly runtimeDirectory: string;
}

export interface PlatformUnixSocketAddress {
  readonly kind: 'unix-socket';
  readonly path: string;
  /** Present when the runtime directory's own socket path is too long. */
  readonly alias?: PlatformSocketAlias;
}

export interface PlatformNamedPipeAddress {
  readonly kind: 'named-pipe';
  readonly path: string;
}

export interface PlatformEndpointAddressRequest {
  /** Trusted host input; never serialized as an operation DTO (D3). */
  readonly dataRoot: string;
  readonly endpointName: string;
}

/**
 * Filesystem identity of a socket path, captured when a probe was refused.
 * It proves only that the path is the node that refused, never which daemon
 * owns a live endpoint: daemon identity (D3 token + nonce and the hashed
 * data-root echo) is established by the transport handshake, not this port.
 */
export interface PlatformEndpointPathIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

/**
 * Held by the caller across probe, unlink, bind, and descriptor publication.
 * Acquiring it is the caller's job (C5); this port only demands it for the
 * destructive step. This is host-adapter state, not a portable operation DTO.
 */
export interface PlatformStartupClaim {
  readonly dataRoot: string;
  readonly claimId: string;
}

/** A raw, pull-based byte stream. Backpressure: `write` resolves once a bounded buffer accepts the bytes. */
export interface PlatformByteStream {
  /** Aborts when the stream closes from either side. */
  readonly signal: AbortSignal;
  /** Resolves `null` once the peer has closed and buffered bytes are drained. */
  read(options?: { readonly signal?: AbortSignal }): Promise<Uint8Array | null>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface PlatformEndpointListener<TAddress> {
  readonly address: TAddress;
  /** At most 32 live streams; excess connections are closed. Ends after `close`. */
  connections(): AsyncIterable<PlatformByteStream>;
  /**
   * Stops accepting and releases the endpoint. Resolves only once the
   * endpoint is closed; descriptor cleanup must wait for it (D3).
   */
  close(): Promise<void>;
}

/** `in-use`: another instance owns the endpoint. The bound endpoint is the lifetime lock. */
export type PlatformEndpointBindResult<TAddress> =
  | {
      readonly kind: 'bound';
      readonly listener: PlatformEndpointListener<TAddress>;
    }
  | { readonly kind: 'in-use' };

export type PlatformSocketBindResult =
  | {
      readonly kind: 'bound';
      readonly listener: PlatformEndpointListener<PlatformUnixSocketAddress>;
      /** Receipt for the node published at the path; descriptors record it as `socketIdentity`. */
      readonly identity: PlatformEndpointPathIdentity;
    }
  | { readonly kind: 'in-use' };

/** `ambiguous` fails closed: never unlink or bind on it. */
export type PlatformSocketProbeResult =
  | { readonly state: 'live' }
  | { readonly state: 'absent' }
  | {
      readonly state: 'refused';
      readonly identity: PlatformEndpointPathIdentity;
    }
  | { readonly state: 'ambiguous'; readonly reason: string };

export type PlatformPipeProbeResult =
  | { readonly state: 'live' }
  | { readonly state: 'absent' }
  | { readonly state: 'ambiguous'; readonly reason: string };

export type PlatformEndpointIdentityCheck = 'match' | 'changed' | 'absent';

export interface PlatformUnlinkStaleRequest {
  readonly address: PlatformUnixSocketAddress;
  readonly expected: PlatformEndpointPathIdentity;
  readonly claim: PlatformStartupClaim;
}

/**
 * `changed` fails closed. The startup claim serializes cooperating launchers;
 * re-checking identity before unlink narrows, but does not eliminate, the
 * window in which a non-cooperating process replaces the path.
 */
export type PlatformUnlinkStaleResult = 'unlinked' | 'changed' | 'absent';

export interface PlatformSocketEndpointServices {
  readonly semantics: 'filesystem-socket';
  address(request: PlatformEndpointAddressRequest): PlatformUnixSocketAddress;
  bind(address: PlatformUnixSocketAddress): Promise<PlatformSocketBindResult>;
  probe(address: PlatformUnixSocketAddress): Promise<PlatformSocketProbeResult>;
  /**
   * Before every connect: verifies the address's alias, or recreates a
   * missing one, and refuses one that is not private or not this root's. A
   * no-op without an alias. `bind`, `probe`, `verifyIdentity` and
   * `unlinkStale` run the same check.
   */
  prepare(address: PlatformUnixSocketAddress): Promise<void>;
  verifyIdentity(
    address: PlatformUnixSocketAddress,
    expected: PlatformEndpointPathIdentity,
  ): Promise<PlatformEndpointIdentityCheck>;
  /**
   * Caller must first prove the path is the descriptor's recorded socket and
   * its owner exited, or hold a claim recovered from a departed holder that
   * marked its bind; refusal alone is insufficient.
   */
  unlinkStale(
    request: PlatformUnlinkStaleRequest,
  ): Promise<PlatformUnlinkStaleResult>;
}

export interface PlatformPipeEndpointServices {
  readonly semantics: 'first-instance-pipe';
  address(request: PlatformEndpointAddressRequest): PlatformNamedPipeAddress;
  bind(
    address: PlatformNamedPipeAddress,
  ): Promise<PlatformEndpointBindResult<PlatformNamedPipeAddress>>;
  probe(address: PlatformNamedPipeAddress): Promise<PlatformPipeProbeResult>;
}

/** Callers branch on `semantics`, not on the OS name. */
export type PlatformEndpointServices =
  | PlatformSocketEndpointServices
  | PlatformPipeEndpointServices;

export type PlatformPermissionResult =
  | { readonly state: 'private' }
  | { readonly state: 'insecure' | 'unverifiable'; readonly reason: string };

export interface PlatformPermissionRequest {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly mode: 'owner-only' | 'owner-executable';
  readonly action: 'verify' | 'restrict';
}

export interface PlatformRenameRequest {
  readonly from: string;
  readonly to: string;
  readonly mode: 'replace' | 'no-replace';
}

export type PlatformRenameResult =
  | { readonly kind: 'exists' }
  | {
      readonly kind: 'renamed';
      /** Observation at completion, never permission to blindly unlink the path later. */
      readonly sourceState:
        | 'removed'
        | 'retained'
        | 'changed-or-absent'
        | 'unknown';
    };

/** Host paths only. Callers supply already-private parent directories. */
export interface PlatformSecureFileServices {
  readonly permissionModel: 'posix-mode' | 'windows-dacl';
  /** POSIX uses 0600/0700 and removes Darwin ACLs. Windows verifies without repair. */
  permissions(
    request: PlatformPermissionRequest,
  ): Promise<PlatformPermissionResult>;
  /** Singly-linked regular sources only; atomic no-replace fails closed without hard links. */
  rename(request: PlatformRenameRequest): Promise<PlatformRenameResult>;
  /**
   * Rejects on any open or flush failure. Windows `flushed` is CAN-5151 D1's
   * API-level flush: namespace ordering undocumented, power-loss unverified.
   * `unsupported` stays for hosts with no directory flush.
   */
  syncDirectory(path: string): Promise<'flushed' | 'unsupported'>;
}

export interface PlatformAppDirectoryRequest {
  readonly appName: string;
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface PlatformAppDirectories {
  readonly data: string;
  readonly config: string;
  readonly logs: string;
  readonly runtime: string | null;
}

export interface PlatformPathServices {
  appDataDir(request: PlatformAppDirectoryRequest): PlatformAppDirectories;
  /** Derives discovery storage from the explicit canonical data root; never relocates it to XDG. */
  runtimeDirectory(request: { readonly dataRoot: string }): string;
}

export interface PlatformChildProcessRequest {
  readonly lifetime: 'owned' | 'independent';
}

export interface PlatformChildProcessOptions {
  readonly detached: boolean;
  readonly windowsHide: boolean;
}

export interface PlatformChildEnvironmentRequest {
  /** Trusted host inputs, selected through an allowlist; never operation DTOs. */
  readonly source: Readonly<Record<string, string | undefined>>;
  readonly pathEntries?: readonly string[];
}

export type PlatformStopMode = 'graceful' | 'force';

export interface PlatformKillTreeRequest {
  /** Owned, unreaped child PID; POSIX children must lead their process group. */
  readonly pid: number;
  readonly mode: PlatformStopMode;
  readonly signal?: AbortSignal;
}

export type PlatformKillTreeResult =
  | { readonly kind: 'signaled'; readonly mode: PlatformStopMode }
  | { readonly kind: 'absent' };

export interface PlatformProcessInspectionRequest {
  readonly pid: number;
  readonly signal?: AbortSignal;
}

export type PlatformProcessInspection =
  | { readonly state: 'running'; readonly startIdentity: string }
  | { readonly state: 'absent' }
  | { readonly state: 'unverifiable'; readonly reason: string };

/** One host process, for resource accounting only; never authority to signal. */
export interface PlatformProcessTableRow {
  readonly pid: number;
  readonly ppid: number;
  /** The POSIX process group; Windows has none and reports the PID. */
  readonly pgid: number;
  /** Share of all logical CPUs, 0 to 100. */
  readonly cpuPercent: number;
  readonly memoryRssBytes: number;
  /** The executable's base name, never its arguments. */
  readonly command: string;
}

export interface PlatformProcessTableRequest {
  readonly signal?: AbortSignal;
}

export type PlatformProcessTable =
  | {
      readonly kind: 'sampled';
      readonly rows: ReadonlyMap<number, PlatformProcessTableRow>;
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

export interface PlatformSupervisionServices {
  childProcessOptions(
    request: PlatformChildProcessRequest,
  ): PlatformChildProcessOptions;
  childEnvironment(
    request: PlatformChildEnvironmentRequest,
  ): Readonly<Record<string, string>>;
  /** Signal delivery is not confirmation of exit; Windows always reports force. */
  killProcessTree(
    request: PlatformKillTreeRequest,
  ): Promise<PlatformKillTreeResult>;
  /** Identity observation is not daemon authentication or authority to kill. */
  inspectProcess(
    request: PlatformProcessInspectionRequest,
  ): Promise<PlatformProcessInspection>;
  /**
   * Every host process the user can see, for resource accounting. CPU is
   * measured between this services instance's consecutive reads where the
   * platform reports cumulative time, so a first read may report zero.
   * Never rejects for an unreadable table: it reports `unavailable`.
   */
  readProcessTable(
    request?: PlatformProcessTableRequest,
  ): Promise<PlatformProcessTable>;
}

/**
 * Host-only: a spawned root whose process group (a job on Windows) stays
 * owned until committed or terminated. Not part of PlatformServices or any
 * portable DTO.
 */
export interface PlatformOwnedChild {
  /** The actual root PID, for correlation only; never authority to signal. */
  readonly pid: number;
  /** Resolves when root exit is observed; termination may still be pending. */
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: string | null;
  }>;
  /**
   * Synchronously gives up stop authority; the root is reaped once it exits.
   * Throws once the root has exited: its group is left for `terminate`.
   */
  commit(signal?: AbortSignal): void;
  /**
   * Stops the owned group and reaps the root once no member remains.
   * Idempotent after cleanup; rejects once committed or when cleanup is unconfirmed.
   */
  terminate(signal?: AbortSignal): Promise<void>;
}

export interface PlatformOwnedChildServices {
  /** Rejects only when no child was created; otherwise returns the owning handle. */
  spawn(request: {
    readonly executable: string;
    readonly args: readonly string[];
    /** The complete child environment; nothing is inherited. */
    readonly environment: Readonly<Record<string, string>>;
    /**
     * Private bounded handoff, written then closed; never argv or environment.
     * Refused on Windows, where the launcher passes no startup claim.
     */
    readonly stdin?: string;
  }): Promise<PlatformOwnedChild>;
}

/**
 * Host-only: one stdio stream of an execution child, metered by credit.
 * Delivered bytes hold credit until acknowledged, so at most the window is
 * outstanding; past it the pipe stops being read and the child blocks.
 */
export interface PlatformExecutionOutput {
  /**
   * The next bytes, no more than the unacknowledged window allows; `null`
   * once the stream has ended and everything was delivered, or once it was
   * discarded. One read may be pending at a time.
   */
  read(options?: { readonly signal?: AbortSignal }): Promise<Uint8Array | null>;
  /** Returns credit for delivered bytes; more than is outstanding is clamped. */
  acknowledge(bytes: number): void;
  /** Drops unread and later output and returns all credit. Idempotent. */
  discard(): void;
}

/** Host-only: the stdin pipe of an execution child. */
export interface PlatformExecutionInput {
  /** Resolves once the OS has accepted every byte; rejects once stdin is closed. */
  write(bytes: Uint8Array): Promise<void>;
  /** Closes stdin after earlier writes. Idempotent. */
  end(): Promise<void>;
}

/**
 * `exited`: the root ended on its own with an exit code. `crashed`: a signal
 * or Windows exception status ended it without a stop request. `cancelled`:
 * a stop was requested before the root's exit was observed. `lost`: cleanup
 * could not confirm that the root ended.
 */
export type PlatformExecutionOutcomeKind =
  | 'exited'
  | 'crashed'
  | 'cancelled'
  | 'lost';

export interface PlatformExecutionOutcome {
  readonly kind: PlatformExecutionOutcomeKind;
  readonly code: number | null;
  readonly signal: string | null;
  /** `discarded` once any output was dropped unread. */
  readonly output: 'complete' | 'discarded';
}

export interface PlatformExecutionRequest {
  /** Fully qualified for the host; never resolved through PATH. */
  readonly executable: string;
  readonly args: readonly string[];
  /** Fully qualified working directory. */
  readonly cwd: string;
  /** The complete child environment; nothing is inherited. */
  readonly environment: Readonly<Record<string, string>>;
  /** Defaults to `ignore`. */
  readonly stdin?: 'pipe' | 'ignore';
  /** `discard` still drains the pipe, so the child never blocks on it. Defaults to `pipe`. */
  readonly stderr?: 'pipe' | 'discard';
  /** Credit window per output stream; 1 byte to 1 MiB, default 64 KiB. */
  readonly outputWindowBytes?: number;
}

/**
 * Host-only: an execution child whose process tree stays owned until it is
 * stopped, or its root exits and no other member remains. POSIX trees are
 * process groups; descendants that start a new session or group leave them.
 * Windows trees are kill-on-close jobs that forbid breakaway; the root is
 * created inside its job, so every descendant it creates is in the tree.
 * Members are only what the tree holds: stopping it says nothing of
 * processes outside. Not part of PlatformServices or any portable DTO.
 */
export interface PlatformExecutionProcess {
  /** The root PID, for correlation only; never authority to signal. */
  readonly pid: number;
  readonly stdin: PlatformExecutionInput | null;
  readonly stdout: PlatformExecutionOutput;
  readonly stderr: PlatformExecutionOutput | null;
  /**
   * Resolves exactly once, after the root's exit and the full delivery or
   * discard of every output stream. Never rejects.
   */
  readonly outcome: Promise<PlatformExecutionOutcome>;
  /**
   * Discards output and stops every tree member, survivors of an exited root
   * included. `graceful` sends TERM first on POSIX; Windows always forces.
   * Resolves once the tree holds no member; rejects when that cannot be confirmed,
   * and the outcome is then `lost` unless the root's exit was observed.
   * Concurrent callers share one attempt; a failed attempt may be retried.
   * `keepOutput` delivers what the tree writes while it stops instead; a
   * later call without it discards the rest.
   */
  terminate(options?: {
    readonly mode?: PlatformStopMode;
    readonly signal?: AbortSignal;
    readonly keepOutput?: boolean;
  }): Promise<void>;
}

export interface PlatformExecutionProcessServices {
  /**
   * Resolves once the child has started inside its owned tree. Rejects when
   * it could not start or be placed in custody; such a child is stopped first.
   */
  start(request: PlatformExecutionRequest): Promise<PlatformExecutionProcess>;
  /** Refuses later starts and force-stops every owned tree. */
  shutdown(options?: { readonly signal?: AbortSignal }): Promise<void>;
}

/**
 * `power-assertion`: an idle-sleep power assertion (macOS).
 * `thread-execution-state`: `SetThreadExecutionState` on the host's main
 * thread (Windows). `logind-inhibitor`: a systemd-logind sleep inhibitor
 * (Linux). `electron`: Electron's `powerSaveBlocker`, which only the
 * in-process desktop composition supplies. `unavailable`: nothing is held.
 */
export type PlatformPowerMechanism =
  | 'power-assertion'
  | 'thread-execution-state'
  | 'logind-inhibitor'
  | 'electron'
  | 'unavailable';

/** Why an assertion stopped being held, or never was. */
export type PlatformPowerAssertionEnd =
  | { readonly kind: 'released' }
  | { readonly kind: 'lost'; readonly reason: string };

/** Host-only: one held request to keep the system awake. Not a portable DTO. */
export interface PlatformPowerAssertion {
  /** Unique per services instance; for correlation only. */
  readonly id: number;
  /** Whether the OS holds it now. Throws when the backend cannot tell. */
  isHeld(): boolean;
  /** Resolves `true` once held, or `false` when it ended first. Never rejects. */
  readonly held: Promise<boolean>;
  /** Resolves once, when it is no longer held. Never rejects. */
  readonly ended: Promise<PlatformPowerAssertionEnd>;
  /**
   * Throws without releasing when the backend refuses the request; the
   * caller keeps the handle and may retry. Otherwise resolves once release
   * is confirmed, or rejects when it cannot be. Idempotent once released.
   */
  release(): Promise<void>;
}

export type PlatformPowerAcquireResult =
  | { readonly kind: 'acquired'; readonly assertion: PlatformPowerAssertion }
  /** The host has no backend; repeating the request cannot help. */
  | { readonly kind: 'unavailable'; readonly reason: string }
  /** This attempt failed and holds nothing; a later request may succeed. */
  | {
      readonly kind: 'failed';
      readonly reason: string;
      readonly id?: number;
    };

/**
 * Keeps the host out of idle system sleep; the display may still sleep. An
 * assertion ends with the process that holds it, so a crashed host never
 * leaves the machine awake.
 */
export interface PlatformPowerServices {
  readonly mechanism: PlatformPowerMechanism;
  /** Throws only for a request the backend refused outright. */
  preventSystemSleep(request: {
    readonly reason: string;
  }): PlatformPowerAcquireResult;
}

/**
 * Why a Trash request rejected. Neither code reports success, and no backend
 * deletes permanently instead. `unavailable`: this host, or the entry's
 * volume, has no trash; nothing was moved. `failed`: nothing was moved, and
 * an entry the request named is still in place. `unconfirmed`: the outcome
 * is unknown and the entry is no longer at its path, as when the trash
 * helper ended without reporting; it may be in the trash, or gone. A
 * rejection that carries no code, such as Electron's `shell.trashItem`,
 * means `failed`.
 */
export type PlatformTrashErrorCode = 'unavailable' | 'failed' | 'unconfirmed';

/**
 * Moves an entry to the OS trash or recycle bin, with the signature of
 * Electron's `shell.trashItem`. `path` is absolute, and the entry at it is
 * moved itself: a symlink or junction, never its target. Resolves only once
 * the OS reports the move; rejects otherwise, with `PlatformTrashError` from
 * the native backends.
 */
export interface PlatformTrashServices {
  trashItem(path: string): Promise<void>;
}

export interface PlatformServices {
  readonly os: PlatformOperatingSystem;
  readonly tier: PlatformSupportTier;
  readonly endpoints: PlatformEndpointServices;
  readonly secureFiles: PlatformSecureFileServices;
  readonly paths: PlatformPathServices;
  readonly supervision: PlatformSupervisionServices;
  readonly power: PlatformPowerServices;
  /**
   * Host-supplied; absent where the host has none, and a Trash request then
   * fails instead of deleting permanently. `createNativeTrashServices` in
   * `@canopy/core-platform` builds the native backends; no host composes
   * them yet.
   */
  readonly trash?: PlatformTrashServices;
}
