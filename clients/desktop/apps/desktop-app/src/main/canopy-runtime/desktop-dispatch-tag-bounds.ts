import {
  dispatchTagPrincipal,
  WORKER_EXECUTOR_DISPATCH_TAGS_PER_PEER_MAX,
} from '@canopy/core-runtime';

/**
 * Dispatch tags one renderer principal may record in the in-process worker's
 * run, across all its relay sessions (CAN-4733). A renderer opens a new relay
 * session, and so a new peer, whenever it likes, so the per-peer bound alone
 * would let it take the whole run. Four sessions' worth keeps both renderer
 * principals together at half the run-wide bound, so the main process's
 * peers always keep the other half.
 */
export const DESKTOP_DISPATCH_TAGS_PER_RENDERER_MAX =
  4 * WORKER_EXECUTOR_DISPATCH_TAGS_PER_PEER_MAX;

/**
 * The renderer relay's principals, `local-desktop-renderer:<surface>`
 * (`renderer-relay/relay.ts`), as a dispatch tag carries them.
 */
const RENDERER_TAG_PRINCIPALS: ReadonlySet<string> = new Set(
  ['main', 'app-advisor'].map((surface) =>
    dispatchTagPrincipal(`local-desktop-renderer:${surface}`),
  ),
);

/** The in-process worker's tag bound for a tag's principal: only renderers have one. */
export function desktopDispatchTagsForPrincipal(
  principal: string,
): number | undefined {
  return RENDERER_TAG_PRINCIPALS.has(principal)
    ? DESKTOP_DISPATCH_TAGS_PER_RENDERER_MAX
    : undefined;
}
