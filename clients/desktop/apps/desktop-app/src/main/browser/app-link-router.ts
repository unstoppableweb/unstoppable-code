import { randomUUID } from 'node:crypto';
import { isGitHubPullRequestUrl } from '@canopy/protocol/portable-tasks/pull-request-reference';
import {
  IPC_CHANNELS,
  type AppLinkBrowserEvent,
  type AppLinkOpenRequestSource,
  type BrowserOpenLinkRequestResolution,
} from '@canopy/desktop-shared/types';
import { readPreferencesFile } from '../lib/preferences-store';
import { openExternalGuarded } from '../lib/open-external';
import {
  normalizeSafeExternalBrowserUrl,
  resolveAppLinkTarget,
  type AppLinkTarget,
} from './browser-url-policy';
import { sendToWebContents } from '../lib/web-contents-send';
import { getCanopyCloudBaseUrl } from '../canopy-cloud/config';
import { resolveWebSettingsLink } from './web-settings-link';

const RENDERER_RESPONSE_TIMEOUT_MS = 1_500;
const RENDERER_DELIVERY_TIMEOUT_MS = 30_000;

export interface AppLinkRendererTarget {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, event: AppLinkBrowserEvent): void;
}

interface PendingRequest {
  senderId: number;
  resolve: (handled: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  awaitCompletion: boolean;
  acknowledged: boolean;
  reserved: boolean;
}

const pendingRequests = new Map<string, PendingRequest>();

function requestRendererDecision(
  sender: AppLinkRendererTarget | null,
  buildEvent: (requestId: string) => AppLinkBrowserEvent,
  awaitCompletion: boolean,
): Promise<boolean> {
  if (sender === null || sender.isDestroyed()) return Promise.resolve(false);
  const requestId = randomUUID();
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve(false);
    }, RENDERER_RESPONSE_TIMEOUT_MS);
    pendingRequests.set(requestId, {
      senderId: sender.id,
      resolve,
      timer,
      awaitCompletion,
      acknowledged: false,
      reserved: false,
    });
    try {
      sendToWebContents(
        sender,
        IPC_CHANNELS.browserEvent,
        buildEvent(requestId),
      );
    } catch {
      pendingRequests.delete(requestId);
      clearTimeout(timer);
      resolve(false);
    }
  });
}

function requestRendererOpen(
  sender: AppLinkRendererTarget | null,
  url: string,
  source: AppLinkOpenRequestSource,
  openInApp: boolean,
): Promise<boolean> {
  const awaitCompletion = source === 'system-default' && openInApp;
  return requestRendererDecision(
    sender,
    (requestId) => ({
      type: 'app-link-open-requested',
      requestId,
      url,
      source,
      awaitCompletion,
      openInApp,
    }),
    awaitCompletion,
  );
}

function requestRendererSettingsOpen(
  sender: AppLinkRendererTarget | null,
  url: string,
  path: string,
): Promise<boolean> {
  return requestRendererDecision(
    sender,
    (requestId) => ({
      type: 'settings-link-open-requested',
      requestId,
      url,
      path,
    }),
    false,
  );
}

/**
 * The settings path for an in-app link to a web settings page, or `null` when
 * the link should keep ordinary app-link routing. OS-delivered links are out
 * of scope. Cloud configuration may not break link routing, so any failure (an unconfigured base URL throws
 * `CanopyCloudConfigError`) means no hand-off. The renderer still decides
 * whether Settings can open the page.
 */
function resolveSettingsHandoffPath(
  url: string,
  source: AppLinkOpenRequestSource,
): string | null {
  if (source !== 'app-link') return null;
  try {
    return resolveWebSettingsLink(url, getCanopyCloudBaseUrl());
  } catch {
    return null;
  }
}

/**
 * Settings requests use the single-phase acknowledge path, like browser
 * requests for links that are not OS-delivered; any other phase is ignored.
 */
export function resolveAppLinkRequest(
  sender: Pick<AppLinkRendererTarget, 'id'>,
  response: BrowserOpenLinkRequestResolution,
): boolean {
  const pending = pendingRequests.get(response.requestId);
  if (!pending || pending.senderId !== sender.id) return false;
  if (!pending.awaitCompletion) {
    if (response.phase !== 'acknowledge') return false;
    pendingRequests.delete(response.requestId);
    clearTimeout(pending.timer);
    pending.resolve(response.handled);
    return true;
  }
  if (response.phase === 'acknowledge') {
    if (pending.acknowledged) return false;
    if (!response.handled) {
      pendingRequests.delete(response.requestId);
      clearTimeout(pending.timer);
      pending.resolve(false);
      return true;
    }
    pending.acknowledged = true;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      pendingRequests.delete(response.requestId);
      pending.resolve(false);
    }, RENDERER_DELIVERY_TIMEOUT_MS);
    return true;
  }
  if (response.phase === 'reserve') {
    if (!pending.acknowledged || pending.reserved || !response.handled) {
      return false;
    }
    pending.reserved = true;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      pendingRequests.delete(response.requestId);
      pending.resolve(false);
    }, RENDERER_DELIVERY_TIMEOUT_MS);
    return true;
  }
  if (response.phase !== 'complete' || !pending.reserved) return false;
  pendingRequests.delete(response.requestId);
  clearTimeout(pending.timer);
  pending.resolve(response.handled);
  return true;
}

export async function routeAppLink(args: {
  url: string;
  sender: AppLinkRendererTarget | null;
  source: AppLinkOpenRequestSource;
}): Promise<AppLinkTarget> {
  const url = normalizeSafeExternalBrowserUrl(args.url);
  if (url === null) {
    throw new Error('Invalid url: must be an http or https URL');
  }
  const settingsPath = resolveSettingsHandoffPath(url, args.source);
  if (
    settingsPath !== null &&
    (await requestRendererSettingsOpen(args.sender, url, settingsPath))
  ) {
    return 'settings';
  }
  // Pull requests clicked inside the app always open in the system browser,
  // where the user is signed in to GitHub, whatever the app-link setting says.
  // OS-delivered links keep their routing: when this app is the system
  // default, an external open would only hand the link back to us. The shared
  // matcher is HTTPS-only, so an http:// link is matched as its HTTPS form.
  if (
    args.source === 'app-link' &&
    isGitHubPullRequestUrl(url.replace(/^http:/, 'https:'))
  ) {
    await openExternalGuarded(url);
    return 'external';
  }
  const preferences = await readPreferencesFile();
  // Links clicked inside the app follow the app-link setting. Links handed to
  // us by the OS arrive because the user made this app their default browser,
  // so that setting also admits them in-app; an echo of our own external open
  // is consumed by the loop guard before it reaches this router.
  const openInBuiltInBrowser =
    preferences.openAppLinksInBuiltInBrowser === true ||
    (args.source === 'system-default' &&
      preferences.useAsSystemDefaultBrowser === true);
  const target = resolveAppLinkTarget({
    url,
    openAppLinksInBuiltInBrowser: openInBuiltInBrowser,
    localServersOnly: preferences.inAppBrowserLocalServersOnly === true,
    // Main cannot know renderer selection state. A declined acknowledgement
    // is the no-worktree branch and preserves the external fallback.
    hasWorktreeContext: args.sender !== null && !args.sender.isDestroyed(),
  });

  if (target === 'in-app') {
    const handled = await requestRendererOpen(
      args.sender,
      url,
      args.source,
      true,
    );
    if (handled) return 'in-app';
    await openExternalGuarded(url);
    return 'external';
  }

  if (target === 'external-blocked-by-local-only') {
    // Main cannot inspect renderer-owned selection state. Confirm that a
    // worktree is actually selected before classifying this as a restriction
    // conflict; with no worktree, the plan's earlier fallback rule wins.
    const hasWorktreeContext = await requestRendererOpen(
      args.sender,
      url,
      args.source,
      false,
    );
    await openExternalGuarded(url);
    if (!hasWorktreeContext) {
      return 'external';
    }
    if (args.sender !== null && !args.sender.isDestroyed()) {
      try {
        sendToWebContents(args.sender, IPC_CHANNELS.browserEvent, {
          type: 'app-link-local-only-conflict',
          url,
        });
      } catch {
        // The URL is already open externally; this notification is best-effort.
      }
    }
    return target;
  }

  await openExternalGuarded(url);
  return target;
}

/**
 * The link context menu's explicit "Open in browser" (CAN-2632). The user
 * chose the destination, so the app-link preferences are not consulted and
 * nothing falls back to the external browser: a decline, a missing sender or
 * an unanswered request resolves `false`. `true` means the renderer
 * acknowledged the request; placement failures are the renderer's to report.
 */
export async function openLinkInBuiltInBrowser(args: {
  url: string;
  sender: AppLinkRendererTarget | null;
}): Promise<boolean> {
  const url = normalizeSafeExternalBrowserUrl(args.url);
  if (url === null) return false;
  return requestRendererOpen(args.sender, url, 'link-context-menu', true);
}

/**
 * Routes navigation targets already admitted by the window's safe-scheme
 * policy. Only HTTP(S) participates in app-link routing; protocols such as
 * `mailto:` preserve the explicit OS hand-off they had before CAN-2305.
 */
export async function routeSafeNavigation(args: {
  url: string;
  sender: AppLinkRendererTarget | null;
  source: AppLinkOpenRequestSource;
}): Promise<AppLinkTarget> {
  let protocol: string;
  try {
    protocol = new URL(args.url).protocol;
  } catch {
    throw new Error('Invalid navigation URL');
  }
  if (protocol === 'mailto:') {
    await openExternalGuarded(args.url);
    return 'external';
  }
  return routeAppLink(args);
}

export function resetAppLinkRouterForTests(): void {
  pendingRequests.forEach((pending) => {
    clearTimeout(pending.timer);
    pending.resolve(false);
  });
  pendingRequests.clear();
}
