import {
  parseDesktopBillingDeepLink,
  parseDesktopRemoteControlDeepLink,
  parseDesktopOrgProjectDeepLink,
  parseDesktopSettingsDeepLink,
  parseDesktopShareDeepLink,
  type DesktopBillingDeepLink,
  type DesktopDeepLink,
} from '@canopy/protocol';

/**
 * Deep-link routing core (CAN-2361).
 *
 * Receives raw, untrusted URLs from the OS — macOS `open-url`, Windows/Linux
 * cold-start `process.argv`, and second-instance argv forwarding — validates
 * them through `parseDesktopShareDeepLink`, and buffers at most one parsed
 * link until the renderer reports startup-unlocked (cloud auth + hydration
 * cleared, the same boundary auto-onboarding uses). Anything that fails
 * validation is dropped silently: rejected URLs may be stray mobile OAuth
 * callbacks whose params must never reach logs or telemetry.
 *
 * This module is deliberately Electron-free so Jest can exercise the full
 * argv → parse → buffer → flush pipeline; `index.ts` injects the delivery
 * callback that focuses the main window and pushes the parsed payload over
 * IPC.
 */

/**
 * Delivery callback. Returns `true` only when the payload was actually
 * handed to a live window; on `false` the link stays buffered so a later
 * flush (e.g. after the macOS dock-icon reopen recreates the window) can
 * retry instead of silently dropping it.
 */
type DesktopNavigationLink =
  | DesktopDeepLink
  | { destination: 'settings'; section: 'approvals' };

export type DeepLinkSender = (link: DesktopNavigationLink) => boolean;
export type WebLinkSender = (url: string) => Promise<boolean>;
/** Same contract as {@link DeepLinkSender}, for billing return links. */
export type BillingReturnSender = (link: DesktopBillingDeepLink) => boolean;
export type DeepLinkSchemes = string | readonly string[];

type PendingProtocolLink =
  | { kind: 'deep-link'; link: DesktopNavigationLink }
  | { kind: 'web-link'; url: string };

interface DeepLinkServiceState {
  pendingLink: PendingProtocolLink | null;
  unlocked: boolean;
  sender: DeepLinkSender | null;
  webLinkSender: WebLinkSender | null;
  deliveringWebLink: PendingProtocolLink | null;
  /**
   * A billing return waiting for the renderer, in its OWN slot.
   *
   * Deliberately not part of the last-wins `pendingLink` buffer. A billing
   * return is a refresh hint, not a destination: sharing the slot would let it
   * evict a share or project link the user actually asked to open, and let a
   * later navigation link evict the hint that tells the renderer to re-check a
   * payment.
   */
  pendingBillingReturn: DesktopBillingDeepLink | null;
  billingReturnSender: BillingReturnSender | null;
}

const state: DeepLinkServiceState = {
  pendingLink: null,
  unlocked: false,
  sender: null,
  webLinkSender: null,
  deliveringWebLink: null,
  pendingBillingReturn: null,
  billingReturnSender: null,
};

function flushPendingBillingReturn(): void {
  const pending = state.pendingBillingReturn;
  if (!state.unlocked || pending === null) return;
  if (
    state.billingReturnSender?.(pending) === true &&
    state.pendingBillingReturn === pending
  ) {
    state.pendingBillingReturn = null;
  }
}

function flushPendingDeepLink(): void {
  flushPendingBillingReturn();
  if (!state.unlocked || state.pendingLink === null) {
    return;
  }
  const pending = state.pendingLink;
  if (pending.kind === 'deep-link') {
    if (
      state.sender?.(pending.link) === true &&
      state.pendingLink === pending
    ) {
      state.pendingLink = null;
    }
    return;
  }
  if (state.webLinkSender === null || state.deliveringWebLink !== null) return;
  state.deliveringWebLink = pending;
  void state
    .webLinkSender(pending.url)
    .then((delivered) => {
      if (delivered && state.pendingLink === pending) {
        state.pendingLink = null;
      }
    })
    .catch(() => undefined)
    .finally(() => {
      if (state.deliveringWebLink === pending) {
        state.deliveringWebLink = null;
      }
      // If another URL replaced this one while delivery was in flight, route
      // that newer last-wins value now. A failed unchanged value remains
      // buffered until the next startup-unlocked retry.
      if (state.pendingLink !== null && state.pendingLink !== pending) {
        flushPendingDeepLink();
      }
    });
}

/**
 * Extracts the deep-link URL from a launch/second-instance argv, if any.
 * Windows and Linux append the URL as a positional argument; scanning from
 * the end skips Electron/Chromium flags and dev-mode script paths. Only the
 * scheme prefix is checked here — full validation happens in
 * `handleDeepLinkUrl`.
 */
export function extractDeepLinkUrlFromArgv(
  argv: readonly string[],
  schemes: DeepLinkSchemes,
): string | null {
  const prefixes = (typeof schemes === 'string' ? [schemes] : schemes).map(
    (scheme) => `${scheme.toLowerCase()}://`,
  );
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const arg = argv[i];
    if (
      typeof arg === 'string' &&
      prefixes.some((prefix) => arg.toLowerCase().startsWith(prefix))
    ) {
      return arg;
    }
  }
  return null;
}

/**
 * Validates a raw deep-link URL and buffers/delivers the parsed payload.
 * Invalid URLs are dropped without logging. A newer link replaces an
 * undelivered older one (last-wins).
 */
export function handleDeepLinkUrl(
  rawUrl: string,
  schemes: DeepLinkSchemes,
): void {
  const acceptedSchemes = typeof schemes === 'string' ? [schemes] : schemes;
  // Billing returns are matched first and kept out of the navigation buffer.
  // `parseDesktopBillingDeepLink` accepts only `<scheme>://billing/unlocked`
  // with a well-formed request id, so nothing here can be mistaken for a
  // navigation link, and a malformed return is dropped like any other.
  const billingReturn = acceptedSchemes.reduce<DesktopBillingDeepLink | null>(
    (parsed, scheme) => parsed ?? parseDesktopBillingDeepLink(rawUrl, scheme),
    null,
  );
  if (billingReturn !== null) {
    state.pendingBillingReturn = billingReturn;
    flushPendingBillingReturn();
    return;
  }
  const link = acceptedSchemes.reduce<DesktopDeepLink | null>(
    (parsed, scheme) =>
      parsed ??
      parseDesktopOrgProjectDeepLink(rawUrl, scheme) ??
      parseDesktopRemoteControlDeepLink(rawUrl, scheme) ??
      parseDesktopSettingsDeepLink(rawUrl, scheme) ??
      parseDesktopShareDeepLink(rawUrl, scheme),
    null,
  );
  if (link === null) return;
  queueNavigationLink(link);
}

function queueNavigationLink(link: DesktopNavigationLink): void {
  state.pendingLink = { kind: 'deep-link', link };
  flushPendingDeepLink();
}

/** Queue this local Settings action until the main renderer can receive it. */
export function queueApprovalsSettingsOpen(): void {
  queueNavigationLink({ destination: 'settings', section: 'approvals' });
}

/**
 * Routes an OS-delivered protocol URL through the same last-wins startup
 * buffer as product deep links. HTTP(S) URLs stay raw until the app-link
 * router can hand them to the selected worktree in the renderer.
 */
export function handleProtocolUrl(
  rawUrl: string,
  deepLinkSchemes: DeepLinkSchemes,
): void {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      state.pendingLink = { kind: 'web-link', url: rawUrl };
      flushPendingDeepLink();
      return;
    }
  } catch {
    return;
  }
  handleDeepLinkUrl(rawUrl, deepLinkSchemes);
}

/** Convenience wrapper for cold-start and second-instance argv handling. */
export function handleDeepLinkArgv(
  argv: readonly string[],
  schemes: DeepLinkSchemes,
): void {
  const rawUrl = extractDeepLinkUrlFromArgv(argv, schemes);
  if (rawUrl !== null) {
    handleDeepLinkUrl(rawUrl, schemes);
  }
}

/** Cold-start/second-instance wrapper that accepts product and HTTP(S) URLs. */
export function handleProtocolArgv(
  argv: readonly string[],
  deepLinkSchemes: DeepLinkSchemes,
): void {
  const schemes =
    typeof deepLinkSchemes === 'string'
      ? [deepLinkSchemes, 'http', 'https']
      : [...deepLinkSchemes, 'http', 'https'];
  const rawUrl = extractDeepLinkUrlFromArgv(argv, schemes);
  if (rawUrl !== null) {
    handleProtocolUrl(rawUrl, deepLinkSchemes);
  }
}

/**
 * Injects the delivery callback. Called once from `index.ts`; the callback
 * reads the current main window lazily so it stays valid across window
 * recreation.
 */
export function setDeepLinkSender(sender: DeepLinkSender): void {
  state.sender = sender;
  flushPendingDeepLink();
}

/**
 * Injects delivery for billing return links. The payload only ever asks the
 * renderer to re-check access; it carries no authority of its own.
 */
export function setBillingReturnSender(sender: BillingReturnSender): void {
  state.billingReturnSender = sender;
  flushPendingBillingReturn();
}

/** Injects delivery for HTTP(S) URLs registered as OS protocol launches. */
export function setWebLinkSender(sender: WebLinkSender): void {
  state.webLinkSender = sender;
  flushPendingDeepLink();
}

/**
 * Marks the renderer as ready for navigation payloads and flushes any
 * buffered link. Wired to the renderer's startup-unlocked IPC — which every
 * fresh renderer process sends once — rather than only the first
 * `unlockStartupWork()` call, so a link buffered while the app sat
 * windowless (macOS dock state) is retried when a new window's renderer
 * comes up.
 */
export function notifyDeepLinkStartupUnlocked(): void {
  state.unlocked = true;
  flushPendingDeepLink();
}

/** Test-only: resets module state between Jest cases. */
export function resetDeepLinkServiceForTests(): void {
  state.pendingLink = null;
  state.unlocked = false;
  state.sender = null;
  state.webLinkSender = null;
  state.deliveringWebLink = null;
  state.pendingBillingReturn = null;
  state.billingReturnSender = null;
}
