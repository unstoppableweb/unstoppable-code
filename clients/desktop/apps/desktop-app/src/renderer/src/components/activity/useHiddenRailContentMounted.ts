/**
 * Decides when the activity rail's content mounts.
 *
 * The rail's sections are mounted even while the rail is hidden (its group
 * collapsed, or another tab of its group shown), because they load what the
 * rail's auto-expand reads and keep watchers running. Mounting them in the
 * same commit that shows a worktree made every switch build the whole rail,
 * run its measured loading skeletons and re-render it as each load answered,
 * for content nobody could see.
 *
 * So a rail on screen mounts at once, exactly as before, and a hidden one
 * mounts once the browser is idle after the switch. Nothing is skipped: the
 * same sections mount with the same loads, only after the frames that show
 * the worktree. Once mounted for a worktree the content stays mounted, shown
 * or not, so it keeps its state. Showing the rail before the idle moment
 * mounts it in that same commit.
 */
import { startTransition, useEffect, useState } from 'react';

/** The longest a hidden rail waits for an idle moment on a busy thread. */
const HIDDEN_RAIL_MOUNT_TIMEOUT_MS = 2000;

function whenIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const idle = window.requestIdleCallback(run, {
      timeout: HIDDEN_RAIL_MOUNT_TIMEOUT_MS,
    });
    return (): void => window.cancelIdleCallback(idle);
  }
  // No idle callback to wait for (not a browser the app ships in): the next
  // task, which is still after the commit that showed the worktree.
  const timer = window.setTimeout(run, 0);
  return (): void => window.clearTimeout(timer);
}

/**
 * Whether the rail content of `railKey` (the worktree it shows, `null` for
 * none) is mounted, given whether the rail is on screen.
 */
export function useHiddenRailContentMounted(
  shown: boolean,
  railKey: string | null,
): boolean {
  const [mountedKey, setMountedKey] = useState<string | null>(
    shown ? railKey : null,
  );
  // Remembered while rendering, so a rail hidden again keeps its content
  // mounted and showing it costs no commit of its own.
  if (shown && mountedKey !== railKey) setMountedKey(railKey);
  const mounted = shown || railKey === null || mountedKey === railKey;
  useEffect(() => {
    if (mounted) return undefined;
    return whenIdle(() => {
      // Hidden content has no frame to make: React builds it in slices and
      // yields to anything the user does meanwhile.
      startTransition(() => setMountedKey(railKey));
    });
  }, [mounted, railKey]);
  return mounted;
}
