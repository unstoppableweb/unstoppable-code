import { BRAND } from '@canopy/brand/current';
import type { SettingsPaymentHandoffFailure } from '@canopy/protocol/settings';
import { getCanopyCloudCredentials } from '../lib/canopy-cloud-account-store';
import { isRecord } from '../lib/type-guards';
import { openExternalGuarded } from '../lib/open-external';
import {
  requestCanopyCloudJson,
  type CanopyCloudCredentialContext,
} from './client';
import { getCanopyCloudBaseUrl } from './config';

export interface OpenAuthenticatedPortalPageOptions {
  /**
   * The credential to mint the link with, and the cloud it opens on. A flow
   * already bound to one account (an MCP sign-in it started) passes that
   * account's, so a sign-in change in between cannot sign the browser in to
   * another one. Defaults to the current credential.
   */
  credentialContext?: CanopyCloudCredentialContext;
  /**
   * Strict mode: succeed only by opening the authenticated consume URL minted
   * with `credentialContext`, never by falling back to a signed-out page.
   * Requires `credentialContext` and resolves to a
   * {@link StrictAuthenticatedPortalResult} instead of a boolean.
   */
  requireAuthentication?: boolean;
}

/** Options for {@link openAuthenticatedPortalPage} in strict mode. */
export interface OpenStrictAuthenticatedPortalPageOptions extends OpenAuthenticatedPortalPageOptions {
  credentialContext: CanopyCloudCredentialContext;
  requireAuthentication: true;
}

/** Options for the legacy, fallback-to-signed-out mode. */
export interface OpenLegacyAuthenticatedPortalPageOptions extends OpenAuthenticatedPortalPageOptions {
  requireAuthentication?: false;
}

/**
 * Why strict mode opened nothing. A subset of the payment handoff failures:
 * the membership check (`forbidden`) belongs to the caller.
 *
 * - `unavailable`: the captured credential names no account.
 * - `identity_changed`: the captured account is no longer the signed-in one.
 * - `failed`: the link could not be minted or was not on the cloud's origin.
 * - `browser_failed`: the authenticated link was minted but did not open.
 */
export type StrictAuthenticatedPortalFailure = Exclude<
  SettingsPaymentHandoffFailure,
  'forbidden'
>;

export type StrictAuthenticatedPortalResult =
  | { ok: true }
  | { ok: false; reason: StrictAuthenticatedPortalFailure };

const AUTH_LINK_MINT_PATH = `/api/v1/${BRAND.web.apiNamespace}/auth-link`;

/**
 * Open an apps/web page in the user's browser already signed in.
 *
 * The main process exchanges the stored desktop cloud credential (`csk_`) for a
 * short-lived, single-use code by POSTing to the web `auth-link` mint endpoint,
 * then opens the returned consume URL — the browser redeems the code for a real
 * web session and redirects to `path`. The raw token never leaves the main
 * process; the renderer only ever passes a same-origin destination path.
 *
 * When there is no cloud token, the app is offline, or the mint fails for any
 * reason, we fall back to opening the page UNAUTHENTICATED so the CTA still
 * works. This never rejects on
 * a network/mint failure — only on a programming error (an invalid `path`).
 *
 * Resolves to whether a browser page was actually opened, authenticated or not.
 * That answer is load-bearing for callers that render a "finish this in your
 * browser" state: every realistic failure (an unconfigured base URL, mint
 * rejected, offline, a throwing `shell.openExternal`) degrades into
 * `openUnauthenticated`, which SWALLOWS its own error. A caller inferring
 * success from "did not reject" would therefore always see success and could
 * strand the user waiting on a page that was never opened.
 */
export function openAuthenticatedPortalPage(
  path: string,
  options: OpenStrictAuthenticatedPortalPageOptions,
): Promise<StrictAuthenticatedPortalResult>;
export function openAuthenticatedPortalPage(
  path: string,
  options?: OpenLegacyAuthenticatedPortalPageOptions,
): Promise<boolean>;
export async function openAuthenticatedPortalPage(
  path: string,
  options: OpenAuthenticatedPortalPageOptions = {},
): Promise<boolean | StrictAuthenticatedPortalResult> {
  if (options.requireAuthentication === true) {
    if (!options.credentialContext) {
      // Strict mode without a captured credential cannot bind the browser to
      // an account; validate the path first so a malformed caller still throws.
      normalizePortalPath(path);
      return { ok: false, reason: 'unavailable' };
    }
    return openStrictAuthenticatedPortalPage(path, options.credentialContext);
  }
  return openPortalPageWithFallback(path, options.credentialContext);
}

/** Mint a transient authenticated page without opening a browser or exposing credentials. */
export async function mintAuthenticatedPortalUrl(
  path: string,
  credentialContext?: CanopyCloudCredentialContext,
): Promise<string | null> {
  const normalizedPath = normalizePortalPath(path);
  try {
    const payload = await requestCanopyCloudJson<unknown>(AUTH_LINK_MINT_PATH, {
      method: 'POST',
      body: JSON.stringify({ redirectPath: normalizedPath }),
      ...(credentialContext ? { credentialContext } : {}),
    });
    return isRecord(payload) &&
      typeof payload.url === 'string' &&
      isTrustedConsumeUrl(
        payload.url,
        () => credentialContext?.baseUrl ?? getCanopyCloudBaseUrl(),
      )
      ? payload.url
      : null;
  } catch {
    return null;
  }
}

async function openPortalPageWithFallback(
  path: string,
  credentialContext: CanopyCloudCredentialContext | undefined,
): Promise<boolean> {
  const normalizedPath = normalizePortalPath(path);
  // Throws `CanopyCloudConfigError` when the base URL is unconfigured, which
  // is exactly one of the "nothing opened" cases below.
  const baseUrl = (): string =>
    credentialContext?.baseUrl ?? getCanopyCloudBaseUrl();

  const openUnauthenticated = async (): Promise<boolean> => {
    try {
      await openExternalGuarded(`${baseUrl()}${normalizedPath}`);
      return true;
    } catch {
      // Best-effort external open; base URL may be unconfigured in local dev.
      return false;
    }
  };

  const url = await mintAuthenticatedPortalUrl(
    normalizedPath,
    credentialContext,
  );
  if (url === null) return openUnauthenticated();
  try {
    await openExternalGuarded(url);
    return true;
  } catch {
    return openUnauthenticated();
  }
}

/**
 * Strict mode of {@link openAuthenticatedPortalPage}: open `path` signed in as
 * the account `credentialContext` captured, or open nothing.
 *
 * Mints with exactly the captured credential, requires the consume URL to be
 * on that credential's cloud origin, re-checks that the captured account is
 * still the signed-in one after the mint (a sign-in change while the mint was
 * in flight must not open the old account's link), and reports success only
 * once the consume URL was handed to the browser. Every failure is typed; no
 * failure opens the page signed out. Throws only on a malformed `path`.
 */
export async function openStrictAuthenticatedPortalPage(
  path: string,
  credentialContext: CanopyCloudCredentialContext,
): Promise<StrictAuthenticatedPortalResult> {
  const normalizedPath = normalizePortalPath(path);
  const accountId = credentialContext.account?.id;
  if (!accountId) {
    return { ok: false, reason: 'unavailable' };
  }
  if (!(await isCredentialStillCurrent(credentialContext, accountId))) {
    return { ok: false, reason: 'identity_changed' };
  }

  let payload: unknown;
  try {
    payload = await requestCanopyCloudJson<unknown>(AUTH_LINK_MINT_PATH, {
      method: 'POST',
      body: JSON.stringify({ redirectPath: normalizedPath }),
      credentialContext,
    });
  } catch {
    return { ok: false, reason: 'failed' };
  }
  if (
    !isRecord(payload) ||
    typeof payload.url !== 'string' ||
    !isTrustedConsumeUrl(payload.url, () => credentialContext.baseUrl)
  ) {
    return { ok: false, reason: 'failed' };
  }

  if (!(await isCredentialStillCurrent(credentialContext, accountId))) {
    return { ok: false, reason: 'identity_changed' };
  }
  try {
    await openExternalGuarded(payload.url);
  } catch {
    return { ok: false, reason: 'browser_failed' };
  }
  return { ok: true };
}

/**
 * Whether a strict payment handoff can open for `accountId`: the stored
 * credential belongs to that account. Never throws.
 */
export async function isPaymentHandoffAvailable(
  accountId: string,
): Promise<boolean> {
  if (accountId.length === 0) return false;
  try {
    const credentials = await getCanopyCloudCredentials();
    return credentials.account?.id === accountId;
  } catch {
    return false;
  }
}

/**
 * The captured credential is still the signed-in one: same account, on the
 * same cloud. A sign-out or unconfigured cloud counts as a change.
 */
async function isCredentialStillCurrent(
  credentialContext: CanopyCloudCredentialContext,
  accountId: string,
): Promise<boolean> {
  try {
    const current = await getCanopyCloudCredentials();
    return (
      current.account?.id === accountId &&
      originOf(current.baseUrl) !== null &&
      originOf(current.baseUrl) === originOf(credentialContext.baseUrl)
    );
  } catch {
    return false;
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Defense-in-depth on the mint response: the consume URL now arrives over a
 * network round-trip rather than being constructed locally, so validate it is
 * an absolute URL on the SAME origin as the configured cloud base before
 * handing it to `shell.openExternal`. A compromised or buggy backend cannot
 * make us open an arbitrary scheme (`file:`, `javascript:`, …) or a foreign
 * host. If the base URL is unconfigured we cannot establish trust, so reject
 * and fall back to the plain unauthenticated open.
 */
function isTrustedConsumeUrl(url: string, baseUrl: () => string): boolean {
  let baseOrigin: string;
  try {
    baseOrigin = new URL(baseUrl()).origin;
  } catch {
    return false;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    return !parsed.username && !parsed.password && parsed.origin === baseOrigin;
  } catch {
    return false;
  }
}

/**
 * A destination must be a same-origin path (start with `/`) and must not be a
 * protocol-relative `//`/`/\` URL. The renderer never sends a token; this is a
 * defensive guard against a malformed caller.
 */
function normalizePortalPath(path: string): string {
  const trimmed = typeof path === 'string' ? path.trim() : '';
  if (
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('/\\')
  ) {
    throw new Error(
      'openAuthenticatedPortalPage requires a same-origin path starting with "/"',
    );
  }
  return trimmed;
}
