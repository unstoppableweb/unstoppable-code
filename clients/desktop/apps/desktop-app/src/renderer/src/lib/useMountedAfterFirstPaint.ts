/**
 * Mounts heavy content one frame after the surface around it.
 *
 * A chat or worktree switch mounts the whole surface in the click's task:
 * the panel card, the tab bars, the composer and every transcript row, in
 * one commit (about half of the components it mounted were rows), so the
 * old page stayed on screen until all of it was built. With this hook a
 * surface draws its frame in the first frame after the click and its heavy
 * content in the task right after that paint, which every content gated here
 * shares, so it arrives in one commit and one frame.
 *
 * Only new content waits: content already shown renders at once, and content
 * that was never deferred keeps rendering at once.
 */
import { useLayoutEffect, useState } from 'react';
import { flushSync } from 'react-dom';

/**
 * How long a deferred mount waits for its frame. A hidden or occluded window
 * draws no frames, so its content mounts after this instead.
 */
const FRAME_FALLBACK_MS = 100;

let pending: (() => void)[] = [];
let scheduled = false;

function flush(): void {
  scheduled = false;
  const run = pending;
  pending = [];
  // All of them in one commit, rendered now: an ordinary update would wait
  // behind every update queued since the click (the composer's loads, say),
  // and the content would miss the frame right after the first one.
  flushSync(() => {
    for (const callback of run) callback();
  });
}

/**
 * Runs `callback` in a task right after the next frame is painted, together
 * with every other callback queued for that frame. Returns a cancel function.
 */
function afterNextPaint(callback: () => void): () => void {
  let cancelled = false;
  const entry = (): void => {
    if (!cancelled) callback();
  };
  pending.push(entry);
  if (!scheduled) {
    scheduled = true;
    let done = false;
    const run = (): void => {
      if (done) return;
      done = true;
      window.clearTimeout(fallback);
      flush();
    };
    const fallback = window.setTimeout(run, FRAME_FALLBACK_MS);
    window.requestAnimationFrame(() => {
      // An animation frame callback runs before its frame's paint; a task
      // posted from it runs after that paint. User-blocking, it runs ahead of
      // the ordinary tasks queued since the click (load replies, the
      // composer's follow-up renders), so the content takes the next frame.
      if (typeof scheduler !== 'undefined') {
        void scheduler.postTask(run, { priority: 'user-blocking' });
        return;
      }
      const channel = new MessageChannel();
      channel.port1.onmessage = (): void => {
        channel.port1.close();
        run();
      };
      channel.port2.postMessage(null);
    });
  }
  return (): void => {
    cancelled = true;
  };
}

/**
 * Whether this page draws frames to wait for. A test DOM has no frames and no
 * task channel, so content there mounts at once, as it always did.
 */
function drawsFrames(): boolean {
  return (
    typeof window.requestAnimationFrame === 'function' &&
    (typeof scheduler !== 'undefined' || typeof MessageChannel !== 'undefined')
  );
}

/**
 * Whether the content shown for `contentKey` (the chat a transcript shows,
 * say) is mounted. Content first shown while `deferContent` is `true`
 * renders without it in that commit and with it right after that commit's
 * frame is drawn; content first shown while it is `false` mounts at once, as
 * before. Once mounted for a key it stays mounted, whatever `deferContent`
 * says later, until the key changes.
 */
export function useMountedAfterFirstPaint(
  contentKey: string,
  deferContent: boolean,
): boolean {
  const defer = deferContent && drawsFrames();
  const [mountedKey, setMountedKey] = useState<string | null>(
    defer ? null : contentKey,
  );
  // Remembered while rendering, so content that grows heavy later (a
  // transcript whose page loads after mount) never steps back out.
  if (!defer && mountedKey !== contentKey) setMountedKey(contentKey);
  const mounted = !defer || mountedKey === contentKey;
  // Queued while committing, not from a passive effect: React may run those
  // after the frame, and the wait would then miss the very next paint.
  useLayoutEffect(() => {
    if (mounted) return undefined;
    return afterNextPaint(() => setMountedKey(contentKey));
  }, [mounted, contentKey]);
  return mounted;
}
