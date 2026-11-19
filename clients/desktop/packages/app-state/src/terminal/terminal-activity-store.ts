// ---------------------------------------------------------------------------
// Terminal activity store (renderer-only, indicator + tooltip state)
// ---------------------------------------------------------------------------
//
// Tracks foreground-process activity and PTY exit events per worktree so the
// sidebar can render a colored terminal indicator (running / unseen-completion
// / unseen-failure) parallel to the existing pipeline indicator. Producers that
// report a command's exit status (`TerminalRunningChangedEvent.exitCode`) also
// record each command's outcome; environment shutdowns are never outcomes.
//
// This store is intentionally separate from `useTerminalStore` (which is
// drawer/group/split-shaped) and mirrors the shape of `pipelineRunsStore`.
//
// See `planning/terminal-activity-indicator.md` for the design rationale.

import { create } from 'zustand';
import type {
  TerminalExitEvent,
  TerminalKind,
  TerminalRunningChangedEvent,
} from '@canopy/protocol/terminal';
import {
  endedByAppShutdown,
  isEnvironmentTerminalShutdown,
  isIntentionalTerminalShutdown,
  normalizeTerminalExitSignal,
} from './terminal-session-state';
import { isShellProcessName } from './terminal-process-names';

import { registerTerminalClientReset } from './terminal-client-binding';

export const TOAST_THRESHOLD_MS = 3000;

export interface TerminalActivityHost {
  isLifecycleManagedTerminal?: (terminalId: string) => boolean;
  isWorktreeSelected?: (worktreeKey: string) => boolean;
}
let host: TerminalActivityHost = {};
export function configureTerminalActivityHost(
  next: TerminalActivityHost,
): void {
  host = next;
}

export interface TerminalActivityEntry {
  terminalId: string;
  groupId: string | null;
  running: boolean;
  processName: string | null;
  /** ms since epoch; for ≥3s toast threshold. */
  processStartedAt: number | null;
  /**
   * Latest outcome for the popover: the shell's exit code from
   * `terminal.exit`, or the last command's status when a running→idle
   * `terminal.running-changed` reports `exitCode` (`null` = unknown outcome).
   * `null` when nothing was reported. A new command clears it.
   */
  exitCode: number | null;
  /** Shell exit signal from `terminal.exit`. A new command clears it. */
  signal: string | null;
  /**
   * ms since epoch when `exitCode`/`signal` were observed (shell exit, or a
   * command end that reported a status); for tooltip ordering and the
   * popover. A new command clears it.
   */
  endedAt: number | null;
  /**
   * True when `exitCode` is a command status the producer reported with
   * `interruptedByUser` (Ctrl+C), so the popover does not show it as a
   * failure. False (or absent) otherwise: shell exits and legacy producers
   * that omit `exitCode` never set it. A new command clears it.
   */
  interruptedByUser?: boolean;
}

interface TerminalActivityState {
  /** `${projectId}/${worktreeId}` -> terminalId -> entry. */
  entriesByWorktree: Record<string, Record<string, TerminalActivityEntry>>;
  runningWorktreeKeys: Set<string>;
  unseenWorktreeKeys: Set<string>;
  unseenFailureWorktreeKeys: Set<string>;
  /**
   * Set of terminalIds we have seen at least one event for. Suppresses the
   * initial running:false snapshot from terminal.list() re-emit on app start.
   */
  baselineEstablished: Set<string>;
  /**
   * Set of terminalIds the user has explicitly closed via UI. The next
   * `terminalExit` for a marked id is treated as benign (no unseen-failure,
   * no toast) and the id is removed from the set during handleExit.
   */
  userInitiatedCloseTerminalIds: Set<string>;
  handleRunningChanged: (event: TerminalRunningChangedEvent) => void;
  handleExit: (event: TerminalExitEvent) => void;
  handleTerminalRemoved: (
    projectId: string,
    worktreeId: string,
    terminalId: string,
  ) => void;
  markUserInitiatedClose: (terminalId: string) => void;
  markWorktreeTerminalSeen: (worktreeKey: string) => void;
  pruneWorktree: (worktreeKey: string) => void;
}

function buildWorktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

/**
 * Lifecycle-managed script and Claude Code terminals are represented by their
 * owning feature, not the generic terminal activity surface.
 */
function isLifecycleManagedTerminalEvent(event: {
  terminalId: string;
  kind?: TerminalKind;
}): boolean {
  return (
    event.kind === 'script' ||
    event.kind === 'claude-code' ||
    host.isLifecycleManagedTerminal?.(event.terminalId) === true
  );
}

function isWorktreeSelected(worktreeKey: string): boolean {
  return host.isWorktreeSelected?.(worktreeKey) ?? false;
}

interface RecomputedSets {
  running: Set<string>;
  changed: boolean;
}

function recomputeRunningSet(
  entriesByWorktree: Record<string, Record<string, TerminalActivityEntry>>,
  previous: Set<string>,
): RecomputedSets {
  const next = new Set<string>();
  for (const [worktreeKey, entries] of Object.entries(entriesByWorktree)) {
    for (const entry of Object.values(entries)) {
      if (entry.running) {
        next.add(worktreeKey);
        break;
      }
    }
  }

  if (next.size === previous.size) {
    let identical = true;
    next.forEach((key) => {
      if (!previous.has(key)) {
        identical = false;
      }
    });
    if (identical) {
      return { running: previous, changed: false };
    }
  }

  return { running: next, changed: true };
}

function cloneEntriesByWorktree(
  entries: Record<string, Record<string, TerminalActivityEntry>>,
  worktreeKey: string,
): Record<string, Record<string, TerminalActivityEntry>> {
  return {
    ...entries,
    [worktreeKey]: { ...(entries[worktreeKey] ?? {}) },
  };
}

function addToSet<T>(previous: Set<T>, value: T): Set<T> {
  if (previous.has(value)) {
    return previous;
  }
  const next = new Set(previous);
  next.add(value);
  return next;
}

function removeFromSet<T>(previous: Set<T>, value: T): Set<T> {
  if (!previous.has(value)) {
    return previous;
  }
  const next = new Set(previous);
  next.delete(value);
  return next;
}

function hasNonRunningEntries(
  bucket: Record<string, TerminalActivityEntry> | undefined,
): boolean {
  if (!bucket) {
    return false;
  }
  return Object.values(bucket).some((entry) => !entry.running);
}

function hasFailureEntries(
  bucket: Record<string, TerminalActivityEntry> | undefined,
): boolean {
  if (!bucket) {
    return false;
  }
  return Object.values(bucket).some(
    (entry) =>
      !entry.running &&
      ((typeof entry.exitCode === 'number' && entry.exitCode > 0) ||
        (entry.signal !== null &&
          !isIntentionalTerminalShutdown(
            normalizeTerminalExitSignal(entry.signal),
          ))),
  );
}

function removeActivityEntryByWorktreeKey(
  prev: TerminalActivityState,
  worktreeKey: string,
  terminalId: string,
): Partial<TerminalActivityState> | null {
  const bucket = prev.entriesByWorktree[worktreeKey];
  const baselineEstablished = removeFromSet(
    prev.baselineEstablished,
    terminalId,
  );

  if (!bucket || !(terminalId in bucket)) {
    if (baselineEstablished === prev.baselineEstablished) {
      return null;
    }
    return { baselineEstablished };
  }

  const nextBucket = { ...bucket };
  delete nextBucket[terminalId];

  const nextEntriesByWorktree = { ...prev.entriesByWorktree };
  if (Object.keys(nextBucket).length === 0) {
    delete nextEntriesByWorktree[worktreeKey];
  } else {
    nextEntriesByWorktree[worktreeKey] = nextBucket;
  }

  const { running: runningWorktreeKeys } = recomputeRunningSet(
    nextEntriesByWorktree,
    prev.runningWorktreeKeys,
  );
  const hasRemainingNonRunningEntries = hasNonRunningEntries(nextBucket);
  const hasRemainingFailureEntries = hasFailureEntries(nextBucket);
  const unseenWorktreeKeys = hasRemainingNonRunningEntries
    ? prev.unseenWorktreeKeys
    : removeFromSet(prev.unseenWorktreeKeys, worktreeKey);
  const unseenFailureWorktreeKeys = hasRemainingFailureEntries
    ? prev.unseenFailureWorktreeKeys
    : removeFromSet(prev.unseenFailureWorktreeKeys, worktreeKey);

  return {
    entriesByWorktree: nextEntriesByWorktree,
    baselineEstablished,
    runningWorktreeKeys,
    unseenWorktreeKeys,
    unseenFailureWorktreeKeys,
  };
}

function removeActivityEntryForTerminal(
  prev: TerminalActivityState,
  projectId: string,
  worktreeId: string,
  terminalId: string,
): Partial<TerminalActivityState> | null {
  return removeActivityEntryByWorktreeKey(
    prev,
    buildWorktreeKey(projectId, worktreeId),
    terminalId,
  );
}

function removeKnownActivityEntry(
  prev: TerminalActivityState,
  terminalId: string,
): Partial<TerminalActivityState> | null {
  for (const [worktreeKey, bucket] of Object.entries(prev.entriesByWorktree)) {
    if (terminalId in bucket) {
      return removeActivityEntryByWorktreeKey(prev, worktreeKey, terminalId);
    }
  }

  const baselineEstablished = removeFromSet(
    prev.baselineEstablished,
    terminalId,
  );
  if (baselineEstablished === prev.baselineEstablished) {
    return null;
  }
  return { baselineEstablished };
}

function clearUserInitiatedCloseMarker(
  prev: TerminalActivityState,
  terminalId: string,
  patch: Partial<TerminalActivityState> | null,
): Partial<TerminalActivityState> | null {
  const userInitiatedCloseTerminalIds = removeFromSet(
    prev.userInitiatedCloseTerminalIds,
    terminalId,
  );
  if (userInitiatedCloseTerminalIds === prev.userInitiatedCloseTerminalIds) {
    return patch;
  }
  return { ...(patch ?? {}), userInitiatedCloseTerminalIds };
}

/** Evict entries identified by a host-owned lifecycle, including close markers. */
export function removeTerminalActivityEntries(
  terminalIds: readonly string[],
): void {
  useTerminalActivityStore.setState((prev) => {
    let next: TerminalActivityState = prev;
    for (const terminalId of terminalIds) {
      const patch = clearUserInitiatedCloseMarker(
        next,
        terminalId,
        removeKnownActivityEntry(next, terminalId),
      );
      if (patch) next = { ...next, ...patch };
    }
    return next;
  });
}

export const useTerminalActivityStore = create<TerminalActivityState>(
  (set) => ({
    entriesByWorktree: {},
    runningWorktreeKeys: new Set<string>(),
    unseenWorktreeKeys: new Set<string>(),
    unseenFailureWorktreeKeys: new Set<string>(),
    baselineEstablished: new Set<string>(),
    userInitiatedCloseTerminalIds: new Set<string>(),

    handleRunningChanged: (event: TerminalRunningChangedEvent): void => {
      if (isLifecycleManagedTerminalEvent(event)) {
        set((prev) => {
          const patch = removeActivityEntryForTerminal(
            prev,
            event.projectId,
            event.worktreeId,
            event.terminalId,
          );
          return (
            clearUserInitiatedCloseMarker(prev, event.terminalId, patch) ?? prev
          );
        });
        return;
      }
      set((prev) => {
        const now = Date.now();
        const worktreeKey = buildWorktreeKey(event.projectId, event.worktreeId);
        const existingEntry =
          prev.entriesByWorktree[worktreeKey]?.[event.terminalId];
        const runningEntry =
          existingEntry?.running === true ? existingEntry : null;

        const wasBaselineEstablished = prev.baselineEstablished.has(
          event.terminalId,
        );

        // First event for this terminalId always seeds the baseline. We
        // detect a foreground-process completion by comparing the previous
        // running:true event with the next running:false event — so the very
        // first event must never mark the worktree unseen.
        const willMarkBaselineEstablished = !wasBaselineEstablished;

        // Status reported for the command that just ended: a number or an
        // explicit null (unknown) on a running→idle transition; undefined for
        // legacy producers that omit it and for idle snapshots.
        const reportedExitCode =
          !event.running && runningEntry !== null ? event.exitCode : undefined;

        // Build the next entry shape.
        let nextEntry: TerminalActivityEntry;
        if (event.running) {
          // A running entry carries no outcome: a new command clears the
          // previous command's or shell's exit state.
          nextEntry = {
            terminalId: event.terminalId,
            groupId: existingEntry?.groupId ?? null,
            running: true,
            processName: event.processName,
            processStartedAt: runningEntry?.processStartedAt ?? now,
            exitCode: null,
            signal: null,
            endedAt: null,
            interruptedByUser: false,
          };
        } else if (reportedExitCode !== undefined) {
          nextEntry = {
            terminalId: event.terminalId,
            groupId: existingEntry?.groupId ?? null,
            running: false,
            processName: null,
            processStartedAt: null,
            exitCode: reportedExitCode,
            signal: null,
            endedAt: now,
            interruptedByUser: event.interruptedByUser === true,
          };
        } else {
          nextEntry = {
            terminalId: event.terminalId,
            groupId: existingEntry?.groupId ?? null,
            running: false,
            processName: null,
            processStartedAt: null,
            exitCode: existingEntry?.exitCode ?? null,
            signal: existingEntry?.signal ?? null,
            endedAt: existingEntry?.endedAt ?? null,
            interruptedByUser: existingEntry?.interruptedByUser ?? false,
          };
        }

        const nextEntriesByWorktree = cloneEntriesByWorktree(
          prev.entriesByWorktree,
          worktreeKey,
        );
        nextEntriesByWorktree[worktreeKey][event.terminalId] = nextEntry;

        const baselineEstablished = willMarkBaselineEstablished
          ? addToSet(prev.baselineEstablished, event.terminalId)
          : prev.baselineEstablished;

        // Explicit command outcomes can have shell names (for example bash).
        // Filter idle shells only for legacy foreground-process observations.
        const isForegroundCompletion =
          !event.running &&
          event.interruptedByUser !== true &&
          wasBaselineEstablished &&
          runningEntry !== null &&
          runningEntry.processStartedAt !== null &&
          now - runningEntry.processStartedAt >= TOAST_THRESHOLD_MS &&
          (event.exitCode !== undefined ||
            !isShellProcessName(runningEntry.processName));

        const isEligibleUnseenCompletion =
          isForegroundCompletion && !isWorktreeSelected(worktreeKey);

        // An omitted status keeps the legacy (desktop) rule. A reported
        // status marks completion for 0 and completion plus failure for
        // non-zero; an explicit null (unknown outcome) adds neither badge.
        const shouldMarkUnseen =
          isEligibleUnseenCompletion && reportedExitCode !== null;
        const shouldMarkFailure =
          isEligibleUnseenCompletion &&
          typeof reportedExitCode === 'number' &&
          reportedExitCode !== 0;

        const unseenWorktreeKeys = shouldMarkUnseen
          ? addToSet(prev.unseenWorktreeKeys, worktreeKey)
          : prev.unseenWorktreeKeys;
        const unseenFailureWorktreeKeys = shouldMarkFailure
          ? addToSet(prev.unseenFailureWorktreeKeys, worktreeKey)
          : prev.unseenFailureWorktreeKeys;

        const { running: runningWorktreeKeys } = recomputeRunningSet(
          nextEntriesByWorktree,
          prev.runningWorktreeKeys,
        );

        return {
          entriesByWorktree: nextEntriesByWorktree,
          baselineEstablished,
          unseenWorktreeKeys,
          unseenFailureWorktreeKeys,
          runningWorktreeKeys,
        };
      });
    },

    handleExit: (event: TerminalExitEvent): void => {
      if (isLifecycleManagedTerminalEvent(event)) {
        set((prev) => {
          const patch = removeActivityEntryForTerminal(
            prev,
            event.projectId,
            event.worktreeId,
            event.terminalId,
          );
          return (
            clearUserInitiatedCloseMarker(prev, event.terminalId, patch) ?? prev
          );
        });
        return;
      }
      set((prev) => {
        const signal = normalizeTerminalExitSignal(event.signal);
        const worktreeKey = buildWorktreeKey(event.projectId, event.worktreeId);
        const isUserInitiatedClose = prev.userInitiatedCloseTerminalIds.has(
          event.terminalId,
        );

        // User-initiated UI close: drop the suppression marker, do not
        // surface completion/failure state for this terminal. If a
        // terminalRunningChanged(false) arrived before the exit event,
        // remove that stale entry so derived sets stay accurate.
        if (isUserInitiatedClose) {
          const userInitiatedCloseTerminalIds = removeFromSet(
            prev.userInitiatedCloseTerminalIds,
            event.terminalId,
          );
          const bucket = prev.entriesByWorktree[worktreeKey];
          const existingEntry = bucket?.[event.terminalId];
          if (
            userInitiatedCloseTerminalIds ===
              prev.userInitiatedCloseTerminalIds &&
            !existingEntry
          ) {
            return prev;
          }

          if (!bucket || !existingEntry) {
            return { userInitiatedCloseTerminalIds };
          }

          const nextBucket: Record<string, TerminalActivityEntry> = {
            ...bucket,
          };
          delete nextBucket[event.terminalId];

          const nextEntriesByWorktree = { ...prev.entriesByWorktree };
          if (Object.keys(nextBucket).length === 0) {
            delete nextEntriesByWorktree[worktreeKey];
          } else {
            nextEntriesByWorktree[worktreeKey] = nextBucket;
          }

          const { running: runningWorktreeKeys } = recomputeRunningSet(
            nextEntriesByWorktree,
            prev.runningWorktreeKeys,
          );
          const hasRemainingNonRunningEntries =
            hasNonRunningEntries(nextBucket);
          const hasRemainingFailureEntries = hasFailureEntries(nextBucket);
          const unseenWorktreeKeys = hasRemainingNonRunningEntries
            ? prev.unseenWorktreeKeys
            : removeFromSet(prev.unseenWorktreeKeys, worktreeKey);
          const unseenFailureWorktreeKeys = hasRemainingFailureEntries
            ? prev.unseenFailureWorktreeKeys
            : removeFromSet(prev.unseenFailureWorktreeKeys, worktreeKey);

          return {
            userInitiatedCloseTerminalIds,
            entriesByWorktree: nextEntriesByWorktree,
            runningWorktreeKeys,
            unseenWorktreeKeys,
            unseenFailureWorktreeKeys,
          };
        }

        // Intentional cleanup signals are filtered everywhere — they should
        // not affect indicator state, even after a restart re-emits exit events.
        // An app shutdown still clears the running state below: its exit
        // carries no idle `runningChanged`.
        if (
          isIntentionalTerminalShutdown(signal) &&
          !endedByAppShutdown(signal)
        ) {
          return prev;
        }

        // Environment shutdowns (connection lost, project asleep) and app
        // shutdowns are neither a command nor a shell outcome. Drop only this
        // terminal's entry and baseline, so its running state clears and a
        // restart that reuses the id re-seeds. The worktree's unread badges
        // stay sticky (no add, no recompute) until selection acknowledges them.
        if (
          isEnvironmentTerminalShutdown(signal) ||
          endedByAppShutdown(signal)
        ) {
          const patch = removeActivityEntryByWorktreeKey(
            prev,
            worktreeKey,
            event.terminalId,
          );
          if (!patch) return prev;
          return {
            ...patch,
            unseenWorktreeKeys: prev.unseenWorktreeKeys,
            unseenFailureWorktreeKeys: prev.unseenFailureWorktreeKeys,
          };
        }

        const existingEntry =
          prev.entriesByWorktree[worktreeKey]?.[event.terminalId];

        const nextEntriesByWorktree = cloneEntriesByWorktree(
          prev.entriesByWorktree,
          worktreeKey,
        );
        nextEntriesByWorktree[worktreeKey][event.terminalId] = {
          terminalId: event.terminalId,
          groupId: existingEntry?.groupId ?? null,
          running: false,
          processName: null,
          processStartedAt: null,
          exitCode: event.exitCode,
          signal,
          endedAt: Date.now(),
          interruptedByUser: false,
        };

        const baselineEstablished = prev.baselineEstablished.has(
          event.terminalId,
        )
          ? prev.baselineEstablished
          : addToSet(prev.baselineEstablished, event.terminalId);

        const isFailure =
          (typeof event.exitCode === 'number' && event.exitCode > 0) ||
          (signal !== null && !isIntentionalTerminalShutdown(signal));
        const isCleanExit = event.exitCode === 0 && signal === null;

        const selected = isWorktreeSelected(worktreeKey);

        const unseenFailureWorktreeKeys =
          isFailure && !selected
            ? addToSet(prev.unseenFailureWorktreeKeys, worktreeKey)
            : prev.unseenFailureWorktreeKeys;

        // A clean exit gets the amber indicator; a failure also implies an
        // unseen entry (red dominates yellow at render time).
        const shouldMarkUnseen = (isCleanExit || isFailure) && !selected;

        const unseenWorktreeKeys = shouldMarkUnseen
          ? addToSet(prev.unseenWorktreeKeys, worktreeKey)
          : prev.unseenWorktreeKeys;

        const { running: runningWorktreeKeys } = recomputeRunningSet(
          nextEntriesByWorktree,
          prev.runningWorktreeKeys,
        );

        return {
          entriesByWorktree: nextEntriesByWorktree,
          baselineEstablished,
          unseenWorktreeKeys,
          unseenFailureWorktreeKeys,
          runningWorktreeKeys,
        };
      });
    },

    handleTerminalRemoved: (
      projectId: string,
      worktreeId: string,
      terminalId: string,
    ): void => {
      set((prev) => {
        return (
          removeActivityEntryForTerminal(
            prev,
            projectId,
            worktreeId,
            terminalId,
          ) ?? prev
        );
      });
    },

    markUserInitiatedClose: (terminalId: string): void => {
      set((prev) => {
        const userInitiatedCloseTerminalIds = addToSet(
          prev.userInitiatedCloseTerminalIds,
          terminalId,
        );
        if (
          userInitiatedCloseTerminalIds === prev.userInitiatedCloseTerminalIds
        ) {
          return prev;
        }
        return { userInitiatedCloseTerminalIds };
      });
    },

    markWorktreeTerminalSeen: (worktreeKey: string): void => {
      set((prev) => {
        const hadUnseen = prev.unseenWorktreeKeys.has(worktreeKey);
        const hadFailed = prev.unseenFailureWorktreeKeys.has(worktreeKey);
        const bucket = prev.entriesByWorktree[worktreeKey];

        if (!hadUnseen && !hadFailed && !bucket) {
          return prev;
        }

        const unseenWorktreeKeys = removeFromSet(
          prev.unseenWorktreeKeys,
          worktreeKey,
        );
        const unseenFailureWorktreeKeys = removeFromSet(
          prev.unseenFailureWorktreeKeys,
          worktreeKey,
        );

        // Prune terminated entries from the popover list — we only keep
        // running entries after acknowledgment, mirroring
        // `pipelineRunsStore.markWorktreePipelineSeen`.
        let entriesByWorktree = prev.entriesByWorktree;
        if (bucket) {
          const running: Record<string, TerminalActivityEntry> = {};
          for (const entry of Object.values(bucket)) {
            if (entry.running) {
              running[entry.terminalId] = entry;
            }
          }

          if (Object.keys(running).length !== Object.keys(bucket).length) {
            entriesByWorktree = { ...prev.entriesByWorktree };
            if (Object.keys(running).length === 0) {
              delete entriesByWorktree[worktreeKey];
            } else {
              entriesByWorktree[worktreeKey] = running;
            }
          }
        }

        if (
          unseenWorktreeKeys === prev.unseenWorktreeKeys &&
          unseenFailureWorktreeKeys === prev.unseenFailureWorktreeKeys &&
          entriesByWorktree === prev.entriesByWorktree
        ) {
          return prev;
        }

        return {
          unseenWorktreeKeys,
          unseenFailureWorktreeKeys,
          entriesByWorktree,
        };
      });
    },

    pruneWorktree: (worktreeKey: string): void => {
      set((prev) => {
        const hadEntries = worktreeKey in prev.entriesByWorktree;
        const hadRunning = prev.runningWorktreeKeys.has(worktreeKey);
        const hadUnseen = prev.unseenWorktreeKeys.has(worktreeKey);
        const hadFailed = prev.unseenFailureWorktreeKeys.has(worktreeKey);

        if (!hadEntries && !hadRunning && !hadUnseen && !hadFailed) {
          return prev;
        }

        let entriesByWorktree = prev.entriesByWorktree;
        let baselineEstablished = prev.baselineEstablished;

        if (hadEntries) {
          const removed = prev.entriesByWorktree[worktreeKey];
          entriesByWorktree = { ...prev.entriesByWorktree };
          delete entriesByWorktree[worktreeKey];

          if (removed) {
            for (const terminalId of Object.keys(removed)) {
              if (baselineEstablished.has(terminalId)) {
                if (baselineEstablished === prev.baselineEstablished) {
                  baselineEstablished = new Set(prev.baselineEstablished);
                }
                baselineEstablished.delete(terminalId);
              }
            }
          }
        }

        const runningWorktreeKeys = removeFromSet(
          prev.runningWorktreeKeys,
          worktreeKey,
        );
        const unseenWorktreeKeys = removeFromSet(
          prev.unseenWorktreeKeys,
          worktreeKey,
        );
        const unseenFailureWorktreeKeys = removeFromSet(
          prev.unseenFailureWorktreeKeys,
          worktreeKey,
        );

        return {
          entriesByWorktree,
          baselineEstablished,
          runningWorktreeKeys,
          unseenWorktreeKeys,
          unseenFailureWorktreeKeys,
        };
      });
    },
  }),
);

registerTerminalClientReset((): void => {
  useTerminalActivityStore.setState({
    entriesByWorktree: {},
    runningWorktreeKeys: new Set<string>(),
    unseenWorktreeKeys: new Set<string>(),
    unseenFailureWorktreeKeys: new Set<string>(),
    baselineEstablished: new Set<string>(),
    userInitiatedCloseTerminalIds: new Set<string>(),
  });
});
