/**
 * What `core.update` needs from the host that installs the desktop package.
 * The host keeps the feed, the signature checks and the install itself; core
 * owns the status it reports, admission and the restart policy.
 */

/** The build's compiled release flavor. */
export type DesktopReleaseFlavor = 'stable' | 'rc' | 'internal';

export type DesktopUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error';

export interface DesktopUpdateSnapshot {
  readonly phase: DesktopUpdatePhase;
  /** The raw package version, such as `9999.0.0-internal.123`. */
  readonly currentVersion: string;
  /** The version as the host shows it, such as `internal-123`. */
  readonly displayVersion: string;
  readonly availableVersion: string | null;
  readonly availableDisplayVersion: string | null;
  /** Download progress from 0 to 100, while downloading. */
  readonly progressPercent: number | null;
  readonly message: string | null;
  /** A restart waits for the host to be idle. */
  readonly restartPending: boolean;
  /** Someone at the host picked an exact version to install. */
  readonly targeted: boolean;
}

export type DesktopUpdateSupport =
  | { readonly supported: true }
  | {
      readonly supported: false;
      /** `source_build`, `not_packaged`, `linux_package_manager`, ... */
      readonly reason: string;
      readonly message: string;
      readonly manualInstructions?: string;
    };

export type DesktopUpdateBlockers = {
  readonly activeChatWork: boolean;
  readonly windowBusy: boolean;
};

export interface CoreUpdateHost {
  readonly releaseFlavor: DesktopReleaseFlavor;
  /** Whether this host can install its own updates. Checks work regardless. */
  support(): DesktopUpdateSupport;
  snapshot(): DesktopUpdateSnapshot;
  blockers(): DesktopUpdateBlockers;
  /** Calls the listener after every change to the snapshot or blockers. */
  subscribe(listener: () => void): () => void;
  /** Settles when the check ends; rejects with the host's own message. */
  check(): Promise<void>;
  /**
   * Starts the download. Throws synchronously, with the host's own message,
   * when the host refuses; the returned promise settles when it ends.
   */
  startDownload(): Promise<void>;
  /**
   * Installs and restarts now. Throws synchronously, with the host's own
   * message, when the host refuses. The returned promise may never settle:
   * the install shuts the app down, and a later failure reaches clients
   * through the status the host reports.
   */
  installNow(): Promise<void>;
  /** Restarts once the host is idle. Throws when the host refuses. */
  scheduleRestart(): void;
  cancelScheduledRestart(): void;
  /**
   * Remembers the install about to run, so a restart that comes back on the
   * old version can say so; null forgets a withdrawn one.
   */
  recordAttempt?(attempt: DesktopUpdateAttempt | null): void;
  /** The recorded install from an earlier run that did not take. */
  lastFailedAttempt?(): DesktopFailedUpdateAttempt | null;
}

export type DesktopUpdateAttempt = {
  readonly targetVersion: string;
  /** The controller's name, or null when this host's own user asked. */
  readonly requestedBy: string | null;
};

export type DesktopFailedUpdateAttempt = DesktopUpdateAttempt & {
  readonly at: string;
};
