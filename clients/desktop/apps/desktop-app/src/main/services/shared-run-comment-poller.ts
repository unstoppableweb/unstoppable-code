// ---------------------------------------------------------------------------
// Background poll for new comments on shared runs (CAN-397).
//
// The desktop deliberately does NOT open an SSE connection from Electron main.
// Comments are server-authoritative and low-frequency, so a bounded poll (slow
// interval + an app-focus trigger) is the delivery mechanism in production.
//
// Shape follows two existing precedents:
//   - `org-enforced-settings.ts`: module-level unref'd timer, double-start
//     guard, self-gating on signed-in state, never throws.
//   - `shared-run-auto-updater.ts`: records a session diagnostic on failure
//     instead of surfacing an error.
//
// Bounded on purpose: only sessions registered at share time are candidates,
// at most `MAX_RUNS_PER_TICK` are polled per tick, and the whole tick short
// circuits when the connected Canopy Cloud does not advertise
// `run-comments-v1`. The per-tick window ROTATES through the registry, so a
// bounded tick throttles the poll without ever starving an entry.
//
// Liveness comes from the fetch (a 404/410 unregisters the entry) rather than
// from re-parsing each session's chat-tabs file, which carries whole
// transcripts and would put a multi-MB `JSON.parse` per entry on the Electron
// main thread every tick.
// ---------------------------------------------------------------------------

import { app, BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type RunCommentsUpdatedEvent,
} from '@canopy/desktop-shared/types';
import type { SharedRunDetail } from '@canopy/protocol/runs';
import { getObservabilityService } from '../observability';
import {
  claimSharedRunCommentPollWindow,
  readSharedRunCommentEntries,
  recordPolledCommentRevision,
  unregisterSharedRunForComments,
  type SharedRunCommentEntry,
} from '../lib/shared-run-comments-registry';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import {
  getSharedRun,
  supportsRunComments,
} from '../runs/canopy-server-client';
import { sendToWebContents } from '../lib/web-contents-send';

/** Slow by design: comments are a review-loop signal, not a live channel. */
const POLL_INTERVAL_MS = 5 * 60_000;

/** Upper bound on runs polled per tick, so a heavy sharer cannot flood main. */
const MAX_RUNS_PER_TICK = 20;

/** Minimum spacing between focus-triggered ticks, so refocus spam is cheap. */
const FOCUS_THROTTLE_MS = 60_000;

interface PollDeps {
  /** Non-mutating check for "is anything registered at all?". */
  hasEntries: () => Promise<boolean>;
  /**
   * Claim this tick's window of entries, rotating the persisted cursor so no
   * registration can be starved by a full window of quiet runs ahead of it.
   */
  claimWindow: (limit: number) => Promise<SharedRunCommentEntry[]>;
  fetchRun: (externalId: string) => Promise<SharedRunDetail>;
  capabilityAvailable: () => Promise<boolean>;
  recordRevision: typeof recordPolledCommentRevision;
  unregister: typeof unregisterSharedRunForComments;
  emit: (event: RunCommentsUpdatedEvent) => void;
  now: () => number;
}

/**
 * A run that is gone server-side (deleted grant, revoked access) should stop
 * being polled. The fetch itself is the liveness check — previously this meant
 * re-parsing the worktree's whole chat-tabs file (full transcripts, on the main
 * thread) before every request just to re-derive an id the registry already
 * persists.
 */
function isMissingRunError(error: unknown): boolean {
  return (
    error instanceof CanopyCloudClientError &&
    (error.status === 404 || error.status === 410)
  );
}

function broadcast(event: RunCommentsUpdatedEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      sendToWebContents(
        window.webContents,
        IPC_CHANNELS.runsCommentsUpdated,
        event,
      );
    }
  }
}

const defaultDeps: PollDeps = {
  hasEntries: async () => (await readSharedRunCommentEntries()).length > 0,
  claimWindow: claimSharedRunCommentPollWindow,
  fetchRun: getSharedRun,
  capabilityAvailable: supportsRunComments,
  recordRevision: recordPolledCommentRevision,
  unregister: unregisterSharedRunForComments,
  emit: broadcast,
  now: () => Date.now(),
};

/**
 * Sortable timestamp for a comment. An unparseable `createdAt` sorts oldest
 * rather than throwing — a malformed row must never break the poll.
 */
function commentTimestamp(comment: { createdAt: string }): number {
  const parsed = Date.parse(comment.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Count comments newer than the last-seen revision. The revision counter is
 * bumped once per mutation (create/reply/resolve), so the delta is only an
 * UPPER BOUND on new comments — a resolve-only change still advances it. The
 * count is therefore the delta clamped to the run's real comment total, which
 * keeps the badge from ever over-promising more comments than exist (a
 * resolve-only bump can still show as one unread).
 */
export function countUnreadComments(
  detail: SharedRunDetail,
  entry: SharedRunCommentEntry,
): { unreadCount: number; ownCommentsOnly: boolean } {
  const totalComments = detail.commentThreads.reduce(
    (sum, thread) => sum + thread.comments.length,
    0,
  );
  // First poll of an already-commented run: everything is unread.
  const previouslyCounted =
    entry.lastSeenCommentRevision === 0 ? 0 : entry.unreadCommentCount;
  const revisionDelta = Math.max(
    0,
    detail.commentRevision - entry.lastSeenCommentRevision,
  );
  const unreadCount = Math.min(
    totalComments,
    Math.max(previouslyCounted, revisionDelta),
  );
  // "Own comments" is derived from the server-provided viewer id, so a reply
  // the user just posted from the web never fires an OS notification back at
  // them. With no resolvable viewer we do not claim ownership.
  //
  // `commentThreads` arrives ordered by THREAD creation with each thread's
  // comments ordered within it, so a flat concatenation is NOT chronological
  // across threads — a fresh reply on an old thread sorts before an older
  // comment on a newer one. Sort by comment timestamp before taking the
  // newest-N window, or `ownCommentsOnly` describes the wrong comments and the
  // renderer (which suppresses its OS notification on that flag) either
  // swallows a real reviewer comment or notifies the user about their own.
  //
  // Scan only as far as the revisions above the seen marker: after a partial
  // markSeen the carried count still includes comments the user has read.
  const authorWindow = Math.min(unreadCount, revisionDelta);
  const newestComments =
    authorWindow === 0
      ? []
      : detail.commentThreads
          .flatMap((thread) => thread.comments)
          .sort((a, b) => commentTimestamp(a) - commentTimestamp(b))
          .slice(-authorWindow);
  const ownCommentsOnly =
    unreadCount > 0 &&
    detail.viewerUserId !== null &&
    newestComments.length > 0 &&
    newestComments.every(
      (comment) => comment.author.userId === detail.viewerUserId,
    );
  return { unreadCount, ownCommentsOnly };
}

class SharedRunCommentPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private focusListener: (() => void) | null = null;
  private running = false;
  private lastFocusTickAt = 0;
  private readonly deps: PollDeps;

  constructor(deps: PollDeps = defaultDeps) {
    this.deps = deps;
  }

  /**
   * Idempotent start. A second call neither stacks timers nor fires an extra
   * tick, matching `startOrgEnforcedSettingsSync`.
   */
  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, POLL_INTERVAL_MS);
    // A pending poll must never keep the app alive on quit.
    this.timer.unref?.();

    this.focusListener = (): void => {
      const now = this.deps.now();
      if (now - this.lastFocusTickAt < FOCUS_THROTTLE_MS) {
        return;
      }
      this.lastFocusTickAt = now;
      void this.pollOnce();
    };
    app.on('browser-window-focus', this.focusListener);
  }

  shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.focusListener) {
      app.removeListener('browser-window-focus', this.focusListener);
      this.focusListener = null;
    }
  }

  /**
   * One poll pass. Never throws: a failure is recorded as a session diagnostic
   * (matching the auto-reshare failure path) and the next tick retries.
   */
  async pollOnce(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      // Cheapest gate first: a non-mutating read. Nothing registered means
      // nothing to poll, and a user who has never shared a run should not pay
      // for a capability probe — which can fall through to a live
      // `/.well-known/` fetch when the cached credential capabilities are not
      // yet populated.
      if (!(await this.deps.hasEntries())) {
        return;
      }
      // Then skip the whole tick — including any network call AND the cursor
      // advance — when the connected server has no comment routes or we are
      // signed out. This gate runs BEFORE the claim so a signed-out client does
      // not take a registry write every interval forever, and does not burn a
      // rotation window polling nothing.
      if (!(await this.deps.capabilityAvailable())) {
        return;
      }
      // Claim a rotating window rather than a fixed prefix: with more than
      // MAX_RUNS_PER_TICK registrations, a fixed prefix permanently starved
      // every entry past it (new shares append to the end, and a quiet run
      // never reorders itself), so the most recently shared runs — the ones
      // most likely to be under review — never polled at all.
      const entries = await this.deps.claimWindow(MAX_RUNS_PER_TICK);
      if (entries.length === 0) {
        return;
      }
      for (const entry of entries) {
        await this.pollEntry(entry);
      }
    } catch {
      // Defensive only: the registry read and the capability probe both degrade
      // internally, and per-entry failures are handled (and diagnosed) below. A
      // background poll must never throw into the main process.
    } finally {
      this.running = false;
    }
  }

  private async pollEntry(entry: SharedRunCommentEntry): Promise<void> {
    const externalId = entry.externalId;
    try {
      const detail = await this.deps.fetchRun(externalId);
      if (detail.commentRevision <= entry.lastPolledCommentRevision) {
        return;
      }

      const { unreadCount, ownCommentsOnly } = countUnreadComments(
        detail,
        entry,
      );
      const updated = await this.deps.recordRevision(entry, {
        externalId,
        commentRevision: detail.commentRevision,
        unreadCount,
      });

      // Decide from the FRESHLY PERSISTED row, not from `entry`. `entry` is a
      // snapshot taken before the network round trip above, so a `markSeen`
      // that landed mid-flight (the user opening the very badge this tick is
      // about to raise) is invisible to it. Gating on the stale snapshot
      // re-lit the badge — and could fire an OS notification — for comments the
      // user was reading at that moment.
      if (detail.commentRevision <= updated.lastSeenCommentRevision) {
        return;
      }
      this.deps.emit({
        projectId: entry.projectId,
        worktreeId: entry.worktreeId,
        chatId: entry.chatId,
        externalId,
        commentRevision: detail.commentRevision,
        lastSeenCommentRevision: updated.lastSeenCommentRevision,
        unreadCommentCount: updated.unreadCommentCount,
        ownCommentsOnly,
      });
    } catch (error) {
      // The grant is gone (unshared here or revoked elsewhere): stop watching
      // it. This is an expected outcome, not a failure worth diagnosing.
      if (isMissingRunError(error)) {
        await this.deps.unregister(entry);
        return;
      }
      this.recordFailure(entry, error);
    }
  }

  private recordFailure(entry: SharedRunCommentEntry, error: unknown): void {
    // Best-effort delivery: a failed poll just means the badge lags until the
    // next tick. A persistently failing poll would otherwise be invisible, so
    // record a triageable session diagnostic (same pattern as a failed
    // auto-reshare).
    getObservabilityService().recordSessionDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'shared_run_comment_poll_failed',
      sessionKey: `${entry.projectId}/${entry.worktreeId}/${entry.chatId}`,
      projectId: entry.projectId,
      worktreeId: entry.worktreeId,
      chatId: entry.chatId,
      providerType: 'unknown',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

let instance: SharedRunCommentPoller | null = null;

export function getSharedRunCommentPoller(): SharedRunCommentPoller {
  if (!instance) {
    instance = new SharedRunCommentPoller();
  }
  return instance;
}

/** Test seam: build an isolated poller with injected dependencies. */
export function createSharedRunCommentPollerForTest(
  deps: Partial<PollDeps>,
): SharedRunCommentPoller {
  return new SharedRunCommentPoller({ ...defaultDeps, ...deps });
}
