import {
  IPC_CHANNELS,
  type SharedContainerInboxChangedEvent,
} from '@canopy/desktop-shared/types';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { app, BrowserWindow } from 'electron';
import { getFeatureFlagService } from '../feature-flags';
import {
  hasCanopyCloudIdentityChanged,
  loadCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges,
  type CanopyCloudAccountEntry,
} from '../lib/canopy-cloud-account-store';
import {
  createSharedContainerInboxSubscription,
  type CreateSharedContainerInboxSubscriptionOptions,
  type SharedContainerRealtimeSubscription,
} from '../shared-containers/realtime-subscription';
import { sendToWebContents } from '../lib/web-contents-send';

/** Pull remains the delivery guarantee when realtime is absent or disconnected. */
export const INBOX_REFRESH_INTERVAL_MS = 2 * 60_000;
export const FOCUS_THROTTLE_MS = 30_000;
export const SIGNAL_DEBOUNCE_MS = 250;
export const SIGNAL_MIN_EMIT_INTERVAL_MS = 5_000;

type SubscribeInbox = (
  options: CreateSharedContainerInboxSubscriptionOptions,
) => SharedContainerRealtimeSubscription;

interface InboxWatcherDeps {
  subscribe: SubscribeInbox;
  emit: (event: SharedContainerInboxChangedEvent) => void;
  loadAccount: () => Promise<CanopyCloudAccountEntry | null>;
  subscribeAccountChanges: (
    listener: (entry: CanopyCloudAccountEntry | null) => void,
  ) => () => void;
  subscribeEnabledChanges: (listener: () => void) => () => void;
  isEnabled: () => boolean;
  now: () => number;
}

interface InboxWatcherTiming {
  refreshIntervalMs: number;
  focusThrottleMs: number;
  signalDebounceMs: number;
  signalMinEmitIntervalMs: number;
}

function broadcast(event: SharedContainerInboxChangedEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      sendToWebContents(
        window.webContents,
        IPC_CHANNELS.sharedContainersInboxChanged,
        event,
      );
    }
  }
}

function isSharedContainersEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key,
  );
}

const defaultDeps: InboxWatcherDeps = {
  subscribe: createSharedContainerInboxSubscription,
  emit: broadcast,
  loadAccount: loadCanopyCloudAccount,
  subscribeAccountChanges: subscribeCanopyCloudAccountChanges,
  subscribeEnabledChanges: (listener) =>
    getFeatureFlagService().onSnapshotChanged(listener),
  isEnabled: isSharedContainersEnabled,
  now: () => Date.now(),
};

function envDuration(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), fallback);
}

function readTiming(): InboxWatcherTiming {
  return {
    refreshIntervalMs: envDuration(
      'CANOPY_E2E_SHARED_CONTAINER_INBOX_INTERVAL_MS',
      INBOX_REFRESH_INTERVAL_MS,
    ),
    focusThrottleMs: envDuration(
      'CANOPY_E2E_SHARED_CONTAINER_INBOX_FOCUS_THROTTLE_MS',
      FOCUS_THROTTLE_MS,
    ),
    signalDebounceMs: envDuration(
      'CANOPY_E2E_SHARED_CONTAINER_INBOX_SIGNAL_DEBOUNCE_MS',
      SIGNAL_DEBOUNCE_MS,
    ),
    signalMinEmitIntervalMs: envDuration(
      'CANOPY_E2E_SHARED_CONTAINER_INBOX_SIGNAL_MIN_EMIT_INTERVAL_MS',
      SIGNAL_MIN_EMIT_INTERVAL_MS,
    ),
  };
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.();
}

class SharedContainerInboxWatcher {
  private readonly deps: InboxWatcherDeps;
  private readonly timing: InboxWatcherTiming;
  private started = false;
  private accountRevision = 0;
  private account: CanopyCloudAccountEntry | null = null;
  private subscription: SharedContainerRealtimeSubscription | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private signalDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private trailingSignalTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeAccountChanges: (() => void) | null = null;
  private unsubscribeEnabledChanges: (() => void) | null = null;
  private focusListener: (() => void) | null = null;
  private lastFocusEmitAt = Number.NEGATIVE_INFINITY;
  private lastRealtimeEmitAt = Number.NEGATIVE_INFINITY;

  constructor(deps: InboxWatcherDeps, timing: InboxWatcherTiming) {
    this.deps = deps;
    this.timing = timing;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.unsubscribeAccountChanges = this.deps.subscribeAccountChanges(
      (entry) => {
        this.accountRevision += 1;
        this.applyAccount(entry);
      },
    );
    this.unsubscribeEnabledChanges = this.deps.subscribeEnabledChanges(() => {
      this.applyAccount(this.account);
    });
    const loadRevision = this.accountRevision;
    void this.deps
      .loadAccount()
      .then((entry) => {
        if (this.started && this.accountRevision === loadRevision) {
          this.applyAccount(entry);
        }
      })
      .catch(() => undefined);

    this.heartbeatTimer = setInterval(() => {
      this.emitSignal('poll');
    }, this.timing.refreshIntervalMs);
    this.heartbeatTimer.unref?.();

    this.focusListener = (): void => {
      if (!this.account || !this.deps.isEnabled()) return;
      const now = this.deps.now();
      if (now - this.lastFocusEmitAt < this.timing.focusThrottleMs) return;
      this.lastFocusEmitAt = now;
      this.emitSignal('focus');
    };
    app.on('browser-window-focus', this.focusListener);
  }

  shutdown(): void {
    if (!this.started) return;
    this.started = false;
    this.accountRevision += 1;
    this.stopSubscription();
    this.clearRealtimeTimers();
    this.account = null;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.unsubscribeAccountChanges?.();
    this.unsubscribeAccountChanges = null;
    this.unsubscribeEnabledChanges?.();
    this.unsubscribeEnabledChanges = null;
    if (this.focusListener) {
      app.removeListener('browser-window-focus', this.focusListener);
      this.focusListener = null;
    }
    this.lastFocusEmitAt = Number.NEGATIVE_INFINITY;
    this.lastRealtimeEmitAt = Number.NEGATIVE_INFINITY;
  }

  private applyAccount(entry: CanopyCloudAccountEntry | null): void {
    const previous = this.account;
    if (!entry || !this.deps.isEnabled()) {
      this.stopSubscription();
      this.clearRealtimeTimers();
      this.account = entry;
      return;
    }

    const reconnect =
      this.subscription === null ||
      hasCanopyCloudIdentityChanged(previous, entry) ||
      previous?.apiKey !== entry.apiKey;
    if (!reconnect) {
      this.account = entry;
      return;
    }

    // Stop account A before account B can start. A late frame must never cause
    // a list using B's credentials.
    this.stopSubscription();
    this.clearRealtimeTimers();
    this.account = entry;
    let nextSubscription: SharedContainerRealtimeSubscription | null = null;
    nextSubscription = this.deps.subscribe({
      onSignal: () => {
        if (this.subscription === nextSubscription) {
          this.handleRealtimeSignal();
        }
      },
      onAccessDenied: () => {
        if (this.subscription === nextSubscription) {
          this.subscription = null;
        }
      },
    });
    this.subscription = nextSubscription;
  }

  private stopSubscription(): void {
    const current = this.subscription;
    this.subscription = null;
    current?.stop();
  }

  private clearRealtimeTimers(): void {
    if (this.signalDebounceTimer) {
      clearTimeout(this.signalDebounceTimer);
      this.signalDebounceTimer = null;
    }
    if (this.trailingSignalTimer) {
      clearTimeout(this.trailingSignalTimer);
      this.trailingSignalTimer = null;
    }
    this.lastRealtimeEmitAt = Number.NEGATIVE_INFINITY;
  }

  /**
   * This device just removed or restored a share. Emitted at once and outside
   * the realtime debounce: the change is already committed, so every section
   * listing removed or pending shares re-lists without waiting for a signal.
   */
  signalLocalChange(): void {
    this.emitSignal('local');
  }

  private emitSignal(reason: SharedContainerInboxChangedEvent['reason']): void {
    if (!this.started || !this.account || !this.deps.isEnabled()) return;
    this.deps.emit({ reason });
  }

  private handleRealtimeSignal(): void {
    if (!this.started || !this.account || !this.deps.isEnabled()) return;
    if (this.signalDebounceTimer) return;

    this.signalDebounceTimer = setTimeout(() => {
      this.signalDebounceTimer = null;
    }, this.timing.signalDebounceMs);
    unref(this.signalDebounceTimer);

    const now = this.deps.now();
    const remaining =
      this.timing.signalMinEmitIntervalMs - (now - this.lastRealtimeEmitAt);
    if (remaining <= 0) {
      this.lastRealtimeEmitAt = now;
      this.emitSignal('realtime');
      return;
    }
    if (this.trailingSignalTimer) return;
    this.trailingSignalTimer = setTimeout(() => {
      this.trailingSignalTimer = null;
      if (!this.started || !this.account || !this.deps.isEnabled()) return;
      this.lastRealtimeEmitAt = this.deps.now();
      this.emitSignal('realtime');
    }, remaining);
    unref(this.trailingSignalTimer);
  }
}

let instance: SharedContainerInboxWatcher | null = null;

export function getSharedContainerInboxWatcher(): SharedContainerInboxWatcher {
  if (!instance) {
    instance = new SharedContainerInboxWatcher(defaultDeps, readTiming());
  }
  return instance;
}

/** Test seam: build an isolated watcher with injected side effects. */
export function createSharedContainerInboxWatcherForTest(
  deps: Partial<InboxWatcherDeps>,
): SharedContainerInboxWatcher {
  return new SharedContainerInboxWatcher(
    { ...defaultDeps, ...deps },
    readTiming(),
  );
}
