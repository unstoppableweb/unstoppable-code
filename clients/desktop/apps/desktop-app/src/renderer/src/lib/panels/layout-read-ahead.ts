/**
 * Read-ahead for a worktree's first visit. Before its panel grid can mount,
 * a first visit reads the worktree's saved layout mode and its saved layout.
 * Each answer arrives in a later task than the click, so the page painted its
 * loading card in between. Read when the user shows intent (the pointer rests
 * on the sidebar row or presses it, or keyboard focus moves onto it), the
 * answers are already here when the click or the Enter key lands, and the
 * grid mounts in that event's own frame.
 *
 * Only the raw answers of the two reads are kept, never a store: a row the
 * user points at and does not open leaves nothing behind but an entry here
 * that expires. Nothing is written, and no panel, window or session is made.
 *
 * An answer is used only while it is known to match what a read made now
 * would return:
 *
 * - it is dropped whenever this window saves, resets or disposes that
 *   worktree's layout or saves its mode ({@link dropWorktreeLayoutReadAhead}),
 *   and a read still out when that happens is never used;
 * - it expires {@link MAX_AGE_MS} after its read began, which bounds how old
 *   it can be against a writer this window cannot see (main, another window).
 *
 * A failed read keeps nothing, so the visit reads again and reports the
 * failure the way it always has. Cloud scopes keep their layouts in this
 * window's own storage and have nothing to read ahead.
 */
import type {
  LoadWorktreeModeResponse,
  LoadWorktreePanelLayoutResponse,
} from '@canopy/desktop-shared/types';
import { isWebCoreScope } from '@/lib/chat-authority';
import { whenExperimentalFeaturesHydrated } from '@/stores/experimentalFeaturesStore';

/** How long after its read began an answer may still be used. */
const MAX_AGE_MS = 2000;
/** Entries kept at once; the oldest goes first. */
const ENTRY_LIMIT = 16;

interface ReadAheadEntry {
  readonly startedAt: number;
  /** Resolves once both reads have answered or failed. Never rejects. */
  readonly settled: Promise<void>;
  mode?: LoadWorktreeModeResponse;
  layout?: LoadWorktreePanelLayoutResponse;
}

const entries = new Map<string, ReadAheadEntry>();

function freshEntry(
  worktreeKey: string,
  maxAgeMs: number,
): ReadAheadEntry | undefined {
  const entry = entries.get(worktreeKey);
  if (entry === undefined) return undefined;
  if (performance.now() - entry.startedAt < maxAgeMs) return entry;
  if (maxAgeMs >= MAX_AGE_MS) entries.delete(worktreeKey);
  return undefined;
}

/**
 * Starts reading a worktree's saved mode and saved layout, unless reads begun
 * less than `reuseWithinMs` ago are already kept. Resolves once the kept
 * reads have answered or failed; never rejects.
 */
export function readWorktreeLayoutAhead(
  worktreeKey: string,
  reuseWithinMs: number,
): Promise<void> {
  const separator = worktreeKey.indexOf('/');
  const scope = {
    projectId: worktreeKey.slice(0, separator),
    worktreeId: worktreeKey.slice(separator + 1),
  };
  if (separator < 0 || isWebCoreScope(scope.projectId)) {
    return Promise.resolve();
  }
  const kept = freshEntry(worktreeKey, Math.min(reuseWithinMs, MAX_AGE_MS));
  if (kept !== undefined) return kept.settled;

  // The Minimal layout repair reads the early access setting, so a mode is
  // only ever handed out once that setting is known, as on a visit.
  const modeRead = whenExperimentalFeaturesHydrated().then(() =>
    window.api.panelLayout.loadWorktreeMode(scope),
  );
  // Inside a `then`, so an API that is not there fails the read instead of
  // throwing into the pointer event that asked for it.
  const layoutRead = Promise.resolve().then(() =>
    window.api.panelLayout.loadWorktreeLayout(scope),
  );
  const drop = (): void => {
    // The visit reads again, and handles the failure as it always has.
    if (entries.get(worktreeKey) === entry) entries.delete(worktreeKey);
  };
  const entry: ReadAheadEntry = {
    startedAt: performance.now(),
    settled: Promise.all([
      modeRead.then((response): void => {
        entry.mode = response;
      }, drop),
      layoutRead.then((response): void => {
        entry.layout = response;
      }, drop),
    ]).then((): void => undefined),
  };
  entries.delete(worktreeKey);
  entries.set(worktreeKey, entry);
  if (entries.size > ENTRY_LIMIT) {
    for (const oldest of entries.keys()) {
      entries.delete(oldest);
      break;
    }
  }
  return entry.settled;
}

/**
 * The reads kept for a worktree, while their answers can still be used:
 * resolves once they have answered or failed. Undefined when nothing usable
 * is kept. Starts no read.
 */
export function worktreeLayoutReadAheadSettled(
  worktreeKey: string,
): Promise<void> | undefined {
  return freshEntry(worktreeKey, MAX_AGE_MS)?.settled;
}

/** The saved mode read ahead for a worktree, while it can still be used. */
export function worktreeModeReadAhead(
  worktreeKey: string,
): LoadWorktreeModeResponse | undefined {
  return freshEntry(worktreeKey, MAX_AGE_MS)?.mode;
}

/** The saved layout read ahead for a worktree, while it can still be used. */
export function savedWorktreeLayoutReadAhead(
  worktreeKey: string,
): LoadWorktreePanelLayoutResponse | undefined {
  return freshEntry(worktreeKey, MAX_AGE_MS)?.layout;
}

/**
 * Forgets what was read ahead for a worktree. Called for every change this
 * window makes to its saved layout or mode; a read still out is never used.
 */
export function dropWorktreeLayoutReadAhead(worktreeKey: string): void {
  entries.delete(worktreeKey);
}
