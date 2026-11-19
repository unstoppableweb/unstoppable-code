import {
  createContext,
  useContext,
  type RefObject,
  type MouseEvent,
} from 'react';
import type {
  AccountOrganizationSettingsApi,
  CanopyApi,
  CanopyCloudAccountPublicState,
} from '@canopy/desktop-shared/types';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import {
  authenticatedCloudPageResultSchema,
  classifyAuthenticatedCloudPagePath,
  normalizeAuthenticatedCloudPageOrigin,
} from '@canopy/desktop-shared/lib/authenticated-cloud-page-request';
import { toAppError } from '@canopy/protocol/app-errors';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { settingsActionErrorCopy } from '@canopy/ui-app/settings/errors';
import { inlineFailure } from '@/lib/inline-app-error';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  beginHostedSettingsAction,
  hostedSettingsFailureScope,
  raiseHostedSettingsFailure,
} from './hosted-settings-host-failure';
import {
  hostedSettingsPathname,
  hostedSettingsSearchParams,
  type HostedSettingsLocation,
  resolveHostedSettingsHref,
} from './hosted-settings-location';
import type { PersistedSettingsNavModel } from './hosted-settings-model';

/**
 * State the desktop settings host shares with the Settings overlay's hosted
 * rail and content: the signed-in account, the configured web origin, the
 * content scroller and the preload bridge. `DesktopHostedSettingsProvider`
 * supplies it.
 */

/** The signed-in cloud account, as hosted settings sees it. */
export type HostedSettingsAccount =
  | { readonly status: 'loading' }
  | { readonly status: 'signed_out' }
  | { readonly status: 'signed_in'; readonly accountId: string };

const LOADING_ACCOUNT: HostedSettingsAccount = { status: 'loading' };
const SIGNED_OUT_ACCOUNT: HostedSettingsAccount = { status: 'signed_out' };

/** Mirrors the settings client's own account rule: a guest is signed out. */
export function hostedSettingsAccountFrom(
  account: CanopyCloudAccountPublicState | null,
): HostedSettingsAccount {
  if (account === null) return LOADING_ACCOUNT;
  if (!account.hasApiKey || isGuestAccount(account)) return SIGNED_OUT_ACCOUNT;
  const accountId = account.account?.id;
  return accountId ? { status: 'signed_in', accountId } : SIGNED_OUT_ACCOUNT;
}

export interface DesktopSettingsHostContextValue {
  readonly account: HostedSettingsAccount;
  /** The configured web origin, `''` until main has answered. */
  readonly webOrigin: string;
  readonly scrollElementRef: RefObject<HTMLElement | null>;
  readonly settingsApi: AccountOrganizationSettingsApi | null;
  /**
   * The signed-in account's persisted rail entry, read when the Settings
   * session starts, or `null`. Drawn only until a bootstrap is known.
   */
  readonly persistedNavModel: PersistedSettingsNavModel | null;
}

export const DesktopSettingsHostContext =
  createContext<DesktopSettingsHostContextValue | null>(null);

export function useDesktopSettingsHostContext(): DesktopSettingsHostContextValue {
  const value = useContext(DesktopSettingsHostContext);
  if (value === null)
    throw new Error(
      'Desktop settings host hooks must render inside <DesktopHostedSettingsProvider>.',
    );
  return value;
}

/** The signed-in account hosted settings is scoped to. */
export function useHostedSettingsAccount(): HostedSettingsAccount {
  return useDesktopSettingsHostContext().account;
}

/** The signed-in account's persisted rail entry, or `null`. */
export function useHostedSettingsPersistedNavModel(): PersistedSettingsNavModel | null {
  return useDesktopSettingsHostContext().persistedNavModel;
}

/** The configured web origin (`''` until known). */
export function useHostedSettingsWebOrigin(): string {
  return useDesktopSettingsHostContext().webOrigin;
}

/** Facts supplied by the host, never inferred from the Electron document. */
export interface HostedSettingsLinkContext {
  readonly account: HostedSettingsAccount;
  readonly webOrigin: string;
  readonly location: HostedSettingsLocation | null;
}

/** Reject raw input before URL parsing can normalize unsafe characters. */
function safeHostedSettingsHref(href: string): boolean {
  return (
    href.length > 0 &&
    !/[\s\\]/.test(href) &&
    !Array.from(href).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })
  );
}

function currentHostedSettingsPath(
  location: HostedSettingsLocation | null,
): string {
  if (location === null) return '/';
  // Keep the raw query, including repeated tab values used by payment
  // classification. Add only route defaults that the location omits.
  const existing = new URLSearchParams(location.search);
  const defaults = new URLSearchParams();
  hostedSettingsSearchParams({ ...location, search: '' }).forEach(
    (value, key) => {
      if (!existing.has(key)) defaults.append(key, value);
    },
  );
  const query = [defaults.toString(), location.search]
    .filter(Boolean)
    .join('&');
  return `${hostedSettingsPathname(location.route)}${query ? `?${query}` : ''}${location.hash ? `#${location.hash}` : ''}`;
}

/**
 * One activation owns one failure notice, shown on the page it started from
 * (see `hosted-settings-host-failure`); no destination or server text is
 * shown.
 */
export async function openHostedSettingsExternalUrl(
  href: string,
  { account, webOrigin, location }: HostedSettingsLinkContext,
): Promise<boolean> {
  const attempt = beginHostedSettingsAction();
  const scope = hostedSettingsFailureScope(location, account);
  let action = 'open this page';
  try {
    if (!safeHostedSettingsHref(href)) throw new Error('Invalid destination');
    const origin = normalizeAuthenticatedCloudPageOrigin(webOrigin);
    const url =
      origin === null
        ? new URL(href)
        : new URL(href, new URL(currentHostedSettingsPath(location), origin));
    if (url.username || url.password || /^https?:\/\/[^/]*@/i.test(href))
      throw new Error('Invalid destination');
    const api: Partial<CanopyApi> | undefined = window.api;
    if (url.protocol === 'mailto:' && url.pathname) {
      if (!api?.browser?.openExternal) throw new Error('Unavailable');
      await api.browser.openExternal({ url: url.href });
      return true;
    }
    if (
      origin === null ||
      (url.protocol !== 'https:' && url.protocol !== 'http:')
    )
      throw new Error('Unavailable');
    if (url.origin !== origin) {
      if (!api?.browser?.openExternal) throw new Error('Unavailable');
      await api.browser.openExternal({ url: url.href });
      return true;
    }
    const path = `${url.pathname}${url.search}${url.hash}`;
    const kind = classifyAuthenticatedCloudPagePath(path);
    if (kind === 'payment') action = 'open this payment page';
    // eslint-disable-next-line no-restricted-properties -- This host adapter uses the strict object overload; legacy navigation helpers permit fallback.
    const openAuthenticated = api?.openAuthenticatedCloudPage;
    if (kind === null || account.status !== 'signed_in' || !openAuthenticated)
      throw new Error('Unavailable');
    const result = authenticatedCloudPageResultSchema.safeParse(
      await openAuthenticated({
        requireAuthentication: true,
        kind,
        path,
        accountId: account.accountId,
        webOrigin: origin,
      }),
    );
    if (result.success && result.data.ok) return true;
    if (
      result.success &&
      !result.data.ok &&
      result.data.reason === 'browser_failed'
    )
      action = 'open your browser';
  } catch (error: unknown) {
    // A rejected invoke may follow a launch. Never retry or downgrade it.
    const appError = toAppError(resolveClientAppError(error));
    if (appError)
      raiseHostedSettingsFailure(
        attempt,
        scope,
        inlineFailure(appError, settingsActionErrorCopy(null, { action })),
      );
    return false;
  }
  raiseHostedSettingsFailure(attempt, scope, {
    error: settingsActionErrorCopy(null, { action }),
  });
  return false;
}

/** Internal settings routing remains available without the external bridge. */
export function followHostedSettingsHref(
  href: string,
  context: HostedSettingsLinkContext,
  options: { readonly replace?: boolean } = {},
): void {
  if (!safeHostedSettingsHref(href)) {
    void openHostedSettingsExternalUrl(href, context);
    return;
  }
  const origin = normalizeAuthenticatedCloudPageOrigin(context.webOrigin);
  const baseOrigin = origin ?? 'https://settings.invalid';
  const basePath = currentHostedSettingsPath(context.location);
  const base = URL.canParse(basePath, baseOrigin)
    ? new URL(basePath, baseOrigin)
    : null;
  const url =
    base !== null && URL.canParse(href, base) ? new URL(href, base) : null;
  // A destination that doesn't parse, or carries credentials, goes through
  // the guarded external open, which refuses it and says so.
  if (
    url === null ||
    url.username ||
    url.password ||
    /^https?:\/\/[^/]*@/i.test(href)
  ) {
    void openHostedSettingsExternalUrl(href, context);
    return;
  }
  const target = resolveHostedSettingsHref(
    href,
    origin ?? '',
    currentHostedSettingsPath(context.location),
  );
  if (target.kind === 'settings') {
    const { route, search, hash } = target.location;
    useNavigationStore.getState().openAccountOrganizationSettings(route, {
      search,
      hash,
      ...(options.replace === true ? { replace: true } : {}),
    });
  } else {
    void openHostedSettingsExternalUrl(href, context);
  }
}

/** Bubbling boundary also covers raw shared anchors and React portals. */
export function activateHostedSettingsAnchor(
  event: MouseEvent<HTMLElement>,
  context: HostedSettingsLinkContext,
  options: { readonly replace?: boolean } = {},
): void {
  if (event.defaultPrevented || (event.button !== 0 && event.button !== 1))
    return;
  const target = event.target;
  const element =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  const anchor = element?.closest('a');
  const href = anchor?.getAttribute('href');
  if (href === null || href === undefined) return;
  event.preventDefault();
  if (href === '') return;
  const external =
    event.button === 1 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    (anchor?.target && anchor.target.toLowerCase() !== '_self');
  if (external) void openHostedSettingsExternalUrl(href, context);
  else followHostedSettingsHref(href, context, options);
}
