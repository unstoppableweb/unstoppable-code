'use client';

// ---------------------------------------------------------------------------
// The one "GitHub for cloud" controller per page (REG-3020).
//
// Owns loading, the live check, Connect/link/install/Disconnect and the
// continuation of a callback that landed on this page. Views (the Settings
// card, the Connect step, the reauth notice) render from the returned
// controller; mount the hook once per page and pass the controller down.
//
// Race safety:
// - every flow carries a monotonic generation, and every flow start, user
//   change and unmount advances it; only the current generation may write
//   state, so a late response after Disconnect, a newer action, an account
//   switch or unmount is dropped;
// - reads and live checks also share one AbortController, aborted by the next
//   flow and by effect cleanup;
// - the mount flow starts one microtask late, so Strict Mode's discarded
//   effect run cancels before it sends a request or claims a callback, and
//   the surviving run always settles `loading`.
//
// Callback continuation: Cloud Git parameters (and only those) are stripped
// from the address bar once and stashed in a module-level slot keyed by the
// resulting URL and user. Exactly one mounted controller claims it; another
// controller on the page only reads the stored status (no live check) while
// the claim runs. A claim is consumed when it finishes or its owner unmounts,
// so a later mount never replays it.
//
// `github_cloud=linked` is not proof of anything. It continues the explicit
// Connect only when this tab's one-shot link marker (written immediately
// before the in-app GitHub link, for this user, intent and server-issued
// generation) is present;
// otherwise the page just loads and verifies. The server still authenticates
// and verifies the Connect, and a continuation never sends the user back to
// GitHub a second time.
//
// Data goes through the settings client (`useSettingsClient`); the in-place
// GitHub link through the GitHub host (`useGitHubCloudHost`). A host without
// in-place linking (the browser handoff) never reads or rewrites this page's
// address, link marker or history: Connect, Reconnect, Install and Add
// account open the web Integrations page in the browser and show "Continue
// in your browser." with a Check again that reads the connection again.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import {
  isGitHubCloudConnectIntent,
  isGitHubCloudContinuationGeneration,
  type GitHubCloudConnectIntent,
  type GitHubCloudConnectResponse,
  type GitHubCloudConnectionDto,
} from '@canopy/protocol/settings/account-github';
import {
  GITHUB_CLOUD_ERROR_COPY,
  isGitHubCloudErrorCode,
  type GitHubCloudErrorCode,
} from '@canopy/protocol/settings/github-cloud-errors';
import {
  readGitHubCloudSetupResult,
  stripGitHubCloudCallbackParams,
  writeGitHubCloudLinkMarker,
  type GitHubCloudCallbackResult,
  type GitHubCloudLinkError,
  type GitHubCloudLinkMarker,
  type GitHubCloudSetupErrorReason,
} from '@canopy/protocol/settings/github-cloud-setup-outcome';
import { useSettingsClient } from '../host';
import {
  useGitHubCloudHost,
  type GitHubCloudHost,
  type GitHubCloudHostPorts,
} from './github-cloud-host';
import {
  disconnectGitHubCloud,
  fetchGitHubCloudConnection,
  GITHUB_CLOUD_UNAVAILABLE_COPY,
  gitHubCloudErrorMessage,
  isGitHubCloudApiError,
  startGitHubCloudConnect,
  verifyGitHubCloudConnection,
  type GitHubCloudApiAction,
} from './github-cloud-api';

export const GITHUB_CLOUD_LINK_FAILED_COPY = "Couldn't link GitHub. Try again.";
export const GITHUB_CLOUD_LINKED_ELSEWHERE_COPY =
  'This GitHub account is already linked to another account. Sign in with that account, or link a different GitHub account.';
export const GITHUB_CLOUD_SETUP_FAILED_COPY =
  "Couldn't finish GitHub setup. Try again.";
export const GITHUB_CLOUD_REQUESTED_COPY =
  'Your request to install the GitHub app was sent. An owner of that GitHub organization needs to approve it.';
/** A browser handoff: Connect continues on the web Integrations page. */
export const GITHUB_CLOUD_CONTINUE_IN_BROWSER_COPY =
  'Continue in your browser.';

/** The user action in flight. */
export type GitHubCloudBusyAction =
  | 'connect'
  | 'install'
  | 'verify'
  | 'disconnect';

/** What failed: an API call, the GitHub link, or the Setup callback. */
export type GitHubCloudErrorSource = GitHubCloudApiAction | 'link' | 'setup';

export interface GitHubCloudControllerError {
  readonly source: GitHubCloudErrorSource;
  /** The allowlisted service code, when the failure carried one. */
  readonly code: GitHubCloudErrorCode | null;
  /** Fixed local copy; never text from a response or a URL. */
  readonly message: string;
}

export interface GitHubCloudNotice {
  /**
   * `requested`: owner approval pending; `unavailable`: rollout off;
   * `handoff`: Connect continues in the browser (Check again reads again).
   */
  readonly kind: 'requested' | 'unavailable' | 'handoff';
  readonly message: string;
}

export interface GitHubCloudConnectOptions {
  /** `install` always offers the App install step (Add account). */
  readonly intent?: GitHubCloudConnectIntent;
}

export interface GitHubCloudConnectionController {
  /** Last known projection, or null before the first answer. */
  readonly connection: GitHubCloudConnectionDto | null;
  /** No snapshot yet: the first read (or callback Connect) is running. */
  readonly loading: boolean;
  /** A live check is running against GitHub. */
  readonly checking: boolean;
  /**
   * install-verify answered 200 (or a Connect collected fresh evidence) with
   * nothing newer since. That is a live check except while the connection is
   * DISCONNECTED or an install nonce is pending: then the server returns the
   * stored projection (for up to 10 minutes). Never implies project readiness
   * on its own: also require `ACTIVE` and `readyForProjects`.
   */
  readonly verified: boolean;
  /** The last live check failed; `connection` is the older snapshot. */
  readonly stale: boolean;
  /** The user action in flight; kept while a redirect to GitHub is pending. */
  readonly busy: GitHubCloudBusyAction | null;
  readonly error: GitHubCloudControllerError | null;
  readonly notice: GitHubCloudNotice | null;
  /** Connect, Reconnect (`intent` omitted) or Add account (`install`). */
  readonly connect: (options?: GitHubCloudConnectOptions) => Promise<void>;
  /** Check again: verify live. */
  readonly verify: () => Promise<void>;
  /** Resolves true once disconnected; on failure the connection is kept. */
  readonly disconnect: () => Promise<boolean>;
  /** Read and verify again, e.g. after a failed first read. */
  readonly reload: () => void;
  readonly dismissNotice: () => void;
  readonly clearError: () => void;
}

export interface UseGitHubCloudConnectionOptions {
  /** Signed-in user; a change drops all pending work and reloads. */
  readonly userId: string;
  /** In-app path GitHub returns to; the current page by default. */
  readonly returnTo?: string;
  /** Same-tab navigation to GitHub; `location.assign` by default. */
  readonly navigate?: (url: string) => void;
}

/** Ready for projects: nothing is left to continue in the browser. */
function isReadyConnection(connection: GitHubCloudConnectionDto): boolean {
  return connection.state === 'ACTIVE' && connection.readyForProjects;
}

interface ControllerState {
  readonly userId: string;
  readonly connection: GitHubCloudConnectionDto | null;
  readonly loading: boolean;
  readonly checking: boolean;
  readonly verified: boolean;
  readonly stale: boolean;
  readonly busy: GitHubCloudBusyAction | null;
  readonly error: GitHubCloudControllerError | null;
  readonly notice: GitHubCloudNotice | null;
}

type StatePatch = Partial<Omit<ControllerState, 'userId'>>;
type DerivedPatch = (previous: ControllerState) => Omit<StatePatch, 'busy'>;

function initialState(userId: string): ControllerState {
  return {
    userId,
    connection: null,
    loading: true,
    checking: false,
    verified: false,
    stale: false,
    busy: null,
    error: null,
    notice: null,
  };
}

function failure(
  source: GitHubCloudApiAction,
  error: unknown,
): GitHubCloudControllerError {
  return {
    source,
    code: isGitHubCloudApiError(error) ? error.code : null,
    message: gitHubCloudErrorMessage(error, source),
  };
}

function linkFailure(kind: GitHubCloudLinkError): GitHubCloudControllerError {
  return {
    source: 'link',
    code: null,
    message:
      kind === 'identity-linked-elsewhere'
        ? GITHUB_CLOUD_LINKED_ELSEWHERE_COPY
        : GITHUB_CLOUD_LINK_FAILED_COPY,
  };
}

function setupFailure(
  reason: GitHubCloudSetupErrorReason,
): GitHubCloudControllerError {
  return isGitHubCloudErrorCode(reason)
    ? {
        source: 'setup',
        code: reason,
        message: GITHUB_CLOUD_ERROR_COPY[reason],
      }
    : { source: 'setup', code: null, message: GITHUB_CLOUD_SETUP_FAILED_COPY };
}

function busyFor(intent: GitHubCloudConnectIntent): GitHubCloudBusyAction {
  return intent === 'install' ? 'install' : 'connect';
}

function assignLocation(url: string): void {
  window.location.assign(url);
}

// ---------------------------------------------------------------------------
// Callback slot shared by every controller in this document.
// ---------------------------------------------------------------------------

interface PendingCallback {
  /** The landing URL after the strip; another URL drops the slot. */
  readonly href: string;
  readonly userId: string;
  readonly result: GitHubCloudCallbackResult;
  owner: symbol | null;
}

let pendingCallback: PendingCallback | null = null;

/** Strips this flow's parameters once and stashes their result. */
function captureCallback(userId: string): void {
  const url = new URL(window.location.href);
  const result = readGitHubCloudSetupResult(url.searchParams);
  if (!stripGitHubCloudCallbackParams(url.searchParams)) return;
  window.history.replaceState(window.history.state, '', url);
  pendingCallback =
    result === null ? null : { href: url.href, userId, result, owner: null };
}

type CallbackClaim =
  | { readonly kind: 'none' }
  | { readonly kind: 'elsewhere' }
  | { readonly kind: 'claimed'; readonly result: GitHubCloudCallbackResult };

function claimCallback(userId: string, owner: symbol): CallbackClaim {
  const pending = pendingCallback;
  if (pending === null) return { kind: 'none' };
  if (pending.href !== window.location.href || pending.userId !== userId) {
    pendingCallback = null;
    return { kind: 'none' };
  }
  if (pending.owner !== null) return { kind: 'elsewhere' };
  pending.owner = owner;
  return { kind: 'claimed', result: pending.result };
}

/**
 * Consumes `owner`'s claim: when its continuation finishes, and when it
 * unmounts mid-way (a later mount must never replay a sent Connect).
 */
function finishCallback(owner: symbol): void {
  if (pendingCallback?.owner === owner) pendingCallback = null;
}

// ---------------------------------------------------------------------------
// One-shot link marker (per tab)
// ---------------------------------------------------------------------------

/** sessionStorage key of the marker an in-app link writes. */
export const GITHUB_CLOUD_LINK_MARKER_KEY = 'canopy.githubCloud.linkPending';

interface LinkContinuation {
  readonly intent: GitHubCloudConnectIntent;
  readonly continuationGeneration: number;
}

function writeLinkMarker(
  userId: string,
  intent: GitHubCloudConnectIntent,
  continuationGeneration: number,
): void {
  try {
    window.sessionStorage.setItem(
      GITHUB_CLOUD_LINK_MARKER_KEY,
      JSON.stringify({ userId, intent, continuationGeneration }),
    );
  } catch {
    // Unavailable storage: the callback then only loads and verifies.
  }
}

function clearLinkMarker(): void {
  try {
    window.sessionStorage.removeItem(GITHUB_CLOUD_LINK_MARKER_KEY);
  } catch {
    // Nothing was stored.
  }
}

/**
 * Takes (removes) this user's fenced continuation. Legacy/unfenced markers,
 * unavailable or malformed storage read as no marker.
 */
function takeLinkMarker(userId: string): LinkContinuation | null {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(GITHUB_CLOUD_LINK_MARKER_KEY);
  } catch {
    return null;
  }
  clearLinkMarker();
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const intent: unknown = Reflect.get(parsed, 'intent');
  const continuationGeneration: unknown = Reflect.get(
    parsed,
    'continuationGeneration',
  );
  return Reflect.get(parsed, 'userId') === userId &&
    isGitHubCloudConnectIntent(intent) &&
    isGitHubCloudContinuationGeneration(continuationGeneration)
    ? { intent, continuationGeneration }
    : null;
}

// ---------------------------------------------------------------------------
// Return paths and link callback URLs
// ---------------------------------------------------------------------------

/** A same-origin path and query (no fragment), free of this flow's params. */
function returnPath(requested: string | undefined): string {
  const origin = window.location.origin;
  const page = window.location.pathname + window.location.search;
  let url = new URL(page, origin);
  if (requested !== undefined) {
    try {
      const candidate = new URL(requested, origin);
      if (candidate.origin === origin) url = candidate;
    } catch {
      // Keep the current page.
    }
  }
  stripGitHubCloudCallbackParams(url.searchParams);
  return url.pathname + url.search;
}

/**
 * A link callback path (same-origin path and query, carrying `marker`). The
 * sign-in client appends `?error=`/`&error=` to the error URL as a string,
 * so the paths carry no fragment.
 */
function linkCallbackPath(path: string, marker: GitHubCloudLinkMarker): string {
  const url = new URL(path, window.location.origin);
  writeGitHubCloudLinkMarker(url.searchParams, marker);
  return url.pathname + url.search;
}

// ---------------------------------------------------------------------------
// Headless identity link (review approval calls to action, CAN-7162)
//
// "Link GitHub" outside Settings links the GitHub identity only (`identity`
// intent: no App install step). It shares this module's marker and callback
// slot with every mounted controller, so exactly one claimer continues a
// callback whatever else is on the page.
// ---------------------------------------------------------------------------

/** True for a same-origin relative path (`/x`), never `//host` or a URL. */
export function isSameOriginRelativePath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\');
}

export interface StartGitHubIdentityLinkInput {
  readonly client: AccountOrganizationSettingsClient;
  readonly linkGitHubAccount: GitHubCloudHostPorts['linkGitHubAccount'];
  readonly userId: string;
  /** Same-origin relative path GitHub returns to; anything else is refused. */
  readonly returnTo: string;
  /** Same-tab navigation to GitHub; `location.assign` by default. */
  readonly navigate?: (url: string) => void;
}

/**
 * Starts linking GitHub from a click. `linked`: the identity was already
 * linked; `leaving`: this tab is going to GitHub. Rejects with fixed copy and
 * leaves no marker behind.
 */
export async function startGitHubIdentityLink({
  client,
  linkGitHubAccount,
  userId,
  returnTo,
  navigate = assignLocation,
}: StartGitHubIdentityLinkInput): Promise<'linked' | 'leaving'> {
  if (!isSameOriginRelativePath(returnTo)) {
    throw new Error(GITHUB_CLOUD_LINK_FAILED_COPY);
  }
  const path = returnPath(returnTo);
  let response: GitHubCloudConnectResponse;
  try {
    response = await startGitHubCloudConnect(client, {
      returnTo: path,
      intent: 'identity',
    });
  } catch {
    throw new Error(GITHUB_CLOUD_LINK_FAILED_COPY);
  }
  if (response.next === 'done' || response.next === 'install') {
    // `install` is never answered for `identity`; the identity is linked.
    return 'linked';
  }
  writeLinkMarker(userId, 'identity', response.continuationGeneration);
  try {
    const result = await linkGitHubAccount({
      callbackPath: linkCallbackPath(path, {
        outcome: 'linked',
        intent: 'identity',
      }),
      errorCallbackPath: linkCallbackPath(path, { outcome: 'link_error' }),
    });
    if (!result.ok || result.url === null) {
      throw new Error(GITHUB_CLOUD_LINK_FAILED_COPY);
    }
    navigate(result.url);
    return 'leaving';
  } catch {
    clearLinkMarker();
    throw new Error(GITHUB_CLOUD_LINK_FAILED_COPY);
  }
}

/** Reads this user's marker intent without taking it. */
function peekLinkMarkerIntent(userId: string): GitHubCloudConnectIntent | null {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(GITHUB_CLOUD_LINK_MARKER_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const intent: unknown = Reflect.get(parsed, 'intent');
    return Reflect.get(parsed, 'userId') === userId &&
      isGitHubCloudConnectIntent(intent)
      ? intent
      : null;
  } catch {
    return null;
  }
}

async function resumeIdentityLink(
  client: AccountOrganizationSettingsClient,
  userId: string,
): Promise<'none' | 'linked' | 'failed'> {
  // As the controller: Strict Mode's discarded run settles first.
  await Promise.resolve();
  if (peekLinkMarkerIntent(userId) !== 'identity') return 'none';
  captureCallback(userId);
  const pending = pendingCallback;
  if (
    pending === null ||
    (pending.result.outcome !== 'linked' &&
      pending.result.outcome !== 'link_error')
  ) {
    return 'none';
  }
  const owner = Symbol('github-identity-link');
  const claim = claimCallback(userId, owner);
  if (claim.kind !== 'claimed') return 'none';
  if (claim.result.outcome !== 'linked') {
    clearLinkMarker();
    finishCallback(owner);
    return 'failed';
  }
  const continuation = takeLinkMarker(userId);
  if (continuation === null) {
    finishCallback(owner);
    return 'failed';
  }
  try {
    // Never back to GitHub: a continuation that still needs sign-in fails.
    const response = await startGitHubCloudConnect(client, {
      returnTo: returnPath(undefined),
      intent: continuation.intent,
      continuationGeneration: continuation.continuationGeneration,
    });
    return response.next === 'done' || response.next === 'install'
      ? 'linked'
      : 'failed';
  } catch {
    return 'failed';
  } finally {
    finishCallback(owner);
  }
}

let identityResume: {
  readonly userId: string;
  readonly promise: Promise<'none' | 'linked' | 'failed'>;
} | null = null;

/**
 * Finishes an `identity` link whose GitHub round trip landed on this page.
 * Acts only when this tab's marker names `identity`; any other marker or no
 * callback resolves `none` and leaves everything for the page's controller.
 * Single-flight per page load: every caller sees the same outcome.
 */
export function resumeGitHubIdentityLink({
  client,
  userId,
}: {
  readonly client: AccountOrganizationSettingsClient;
  readonly userId: string;
}): Promise<'none' | 'linked' | 'failed'> {
  if (identityResume?.userId !== userId) {
    identityResume = { userId, promise: resumeIdentityLink(client, userId) };
  }
  return identityResume.promise;
}

// ---------------------------------------------------------------------------
// Controller engine: one per hook instance, outside React state.
// ---------------------------------------------------------------------------

interface EngineOptions {
  readonly returnTo: string | undefined;
  readonly navigate: (url: string) => void;
  /** The host's settings client, re-read on every call. */
  readonly client: AccountOrganizationSettingsClient;
}

type ConnectOutcome = 'settled' | 'failed' | 'superseded';

interface ControllerEngine extends Pick<
  GitHubCloudConnectionController,
  | 'connect'
  | 'verify'
  | 'disconnect'
  | 'reload'
  | 'dismissNotice'
  | 'clearError'
> {
  readonly setOptions: (options: EngineOptions) => void;
  /** Starts the mount flow for `userId`; returns the effect cleanup. */
  readonly start: (userId: string) => () => void;
}

/**
 * `github` is fixed for the engine's lifetime: a GitHub host provider is
 * never added or removed above a mounted controller.
 */
function createControllerEngine(
  setState: Dispatch<SetStateAction<ControllerState>>,
  github: GitHubCloudHost,
  initialClient: AccountOrganizationSettingsClient,
): ControllerEngine {
  /** Connect links and follows GitHub here; false: the browser handoff. */
  const inline = github.kind === 'inline';
  let options: EngineOptions = {
    returnTo: undefined,
    navigate: assignLocation,
    client: initialClient,
  };
  let userId = '';
  let generation = 0;
  let controller: AbortController | null = null;
  let busy: GitHubCloudBusyAction | null = null;
  /** A full-page navigation to GitHub was started and has not unloaded. */
  let navigating = false;
  /** Bumped per in-app link, so an older link never clears a newer marker. */
  let linkAttempt = 0;

  function write(patch: StatePatch, derive?: DerivedPatch): void {
    const owner = userId;
    setState((previous) => {
      const base = previous.userId === owner ? previous : initialState(owner);
      return { ...base, ...patch, ...(derive ? derive(base) : {}) };
    });
  }

  /** Writes only while `flow` is still the current generation. */
  function apply(
    flow: number,
    patch: StatePatch,
    derive?: DerivedPatch,
  ): boolean {
    if (flow !== generation) return false;
    if ('busy' in patch) busy = patch.busy ?? null;
    write(patch, derive);
    return true;
  }

  /** Supersedes every earlier flow. */
  function begin(): { flow: number; signal: AbortSignal } {
    controller?.abort();
    const next = new AbortController();
    controller = next;
    generation += 1;
    return { flow: generation, signal: next.signal };
  }

  async function check(
    flow: number,
    signal: AbortSignal,
    settle: StatePatch = {},
  ): Promise<void> {
    try {
      const live = await verifyGitHubCloudConnection(options.client, signal);
      apply(
        flow,
        {
          ...settle,
          connection: live,
          loading: false,
          checking: false,
          verified: true,
          stale: false,
        },
        (previous) =>
          // Ready now: nothing is left to continue in the browser.
          previous.notice?.kind === 'handoff' && isReadyConnection(live)
            ? { notice: null }
            : {},
      );
    } catch (error) {
      apply(flow, settle, (previous) => ({
        loading: false,
        checking: false,
        verified: false,
        stale: previous.connection !== null,
        error: failure('verify', error),
      }));
    }
  }

  async function load(
    flow: number,
    signal: AbortSignal,
    verify: boolean,
  ): Promise<void> {
    let stored: GitHubCloudConnectionDto;
    try {
      stored = await fetchGitHubCloudConnection(options.client, signal);
    } catch (error) {
      apply(flow, {}, (previous) => ({
        loading: false,
        checking: false,
        // The callback's notice already explains a rollout 404.
        error:
          previous.notice?.kind === 'unavailable' &&
          isGitHubCloudApiError(error) &&
          error.kind === 'unavailable'
            ? previous.error
            : failure('load', error),
      }));
      return;
    }
    const live = verify && stored.state !== 'DISCONNECTED';
    const applied = apply(flow, {
      connection: stored,
      loading: false,
      checking: live,
      verified: false,
      stale: false,
    });
    if (applied && live) await check(flow, signal);
  }

  function startNavigation(flow: number, url: string): void {
    navigating = true;
    try {
      options.navigate(url);
    } catch (error) {
      navigating = false;
      apply(flow, { busy: null, error: failure('connect', error) });
    }
  }

  /**
   * The sign-in client's own redirect is disabled: it would navigate before
   * the awaited call resolves, even after a Disconnect, unmount or user
   * switch. The URL is followed here only while this flow is still current.
   */
  async function linkGitHub(
    flow: number,
    intent: GitHubCloudConnectIntent,
    continuationGeneration: number,
  ): Promise<void> {
    if (github.kind !== 'inline') return;
    const path = returnPath(options.returnTo);
    linkAttempt += 1;
    const attempt = linkAttempt;
    const abandon = (): void => {
      if (attempt === linkAttempt) clearLinkMarker();
    };
    writeLinkMarker(userId, intent, continuationGeneration);
    try {
      const result = await github.linkGitHubAccount({
        callbackPath: linkCallbackPath(path, { outcome: 'linked', intent }),
        errorCallbackPath: linkCallbackPath(path, { outcome: 'link_error' }),
      });
      if (flow !== generation) {
        abandon();
        return;
      }
      if (!result.ok) {
        abandon();
        apply(flow, { busy: null, error: linkFailure('link-failed') });
        return;
      }
      if (result.url === null) {
        abandon();
        apply(flow, { busy: null });
        return;
      }
      // Stay busy until the page unloads (or a bfcache restore clears it).
      navigating = true;
      options.navigate(result.url);
    } catch {
      navigating = false;
      abandon();
      apply(flow, { busy: null, error: linkFailure('link-failed') });
    }
  }

  /** Follows `next`, never the connection state. */
  async function runConnect(
    flow: number,
    intent: GitHubCloudConnectIntent,
    mayLink: boolean,
    continuationGeneration?: number,
  ): Promise<ConnectOutcome> {
    let response: GitHubCloudConnectResponse;
    try {
      response = await startGitHubCloudConnect(options.client, {
        returnTo: returnPath(options.returnTo),
        intent,
        continuationGeneration,
      });
    } catch (error) {
      return apply(flow, {
        busy: null,
        loading: false,
        checking: false,
        error: failure('connect', error),
      })
        ? 'failed'
        : 'superseded';
    }
    if (flow !== generation) return 'superseded';
    const fresh: StatePatch = {
      connection: response.connection,
      loading: false,
      checking: false,
      stale: false,
    };
    switch (response.next) {
      case 'done':
        apply(flow, { ...fresh, verified: true, busy: null });
        return 'settled';
      case 'install':
        apply(flow, { ...fresh, verified: true });
        startNavigation(flow, response.installUrl);
        return 'settled';
      case 'link':
      case 'reauth':
        if (!mayLink) {
          // Just back from linking: never loop back to GitHub on our own.
          apply(flow, {
            ...fresh,
            verified: false,
            busy: null,
            error: linkFailure('link-failed'),
          });
          return 'settled';
        }
        apply(flow, { ...fresh, verified: false });
        await linkGitHub(flow, intent, response.continuationGeneration);
        return 'settled';
    }
  }

  function callbackPatch(
    result: Exclude<GitHubCloudCallbackResult, { outcome: 'linked' }>,
  ): StatePatch {
    switch (result.outcome) {
      case 'connected':
        return {};
      case 'requested':
        return {
          notice: { kind: 'requested', message: GITHUB_CLOUD_REQUESTED_COPY },
        };
      case 'unavailable':
        return {
          notice: {
            kind: 'unavailable',
            message: GITHUB_CLOUD_UNAVAILABLE_COPY,
          },
        };
      case 'error':
        return { error: setupFailure(result.reason) };
      case 'link_error':
        return { error: linkFailure(result.linkError) };
    }
  }

  async function continueCallback(
    flow: number,
    signal: AbortSignal,
    result: GitHubCloudCallbackResult,
    owner: symbol,
  ): Promise<void> {
    if (result.outcome === 'linked') {
      // Only an in-app link from this tab continues; the marker wins over the
      // URL's intent. Anything else is a plain landing.
      const continuation = takeLinkMarker(userId);
      if (continuation === null) {
        finishCallback(owner);
        await load(flow, signal, true);
        return;
      }
      apply(flow, { busy: busyFor(continuation.intent) });
      const outcome = await runConnect(
        flow,
        continuation.intent,
        false,
        continuation.continuationGeneration,
      );
      finishCallback(owner);
      if (outcome === 'failed') await load(flow, signal, false);
      return;
    }
    if (result.outcome === 'link_error') clearLinkMarker();
    finishCallback(owner);
    apply(flow, callbackPatch(result));
    await load(flow, signal, true);
  }

  function reload(): void {
    if (busy !== null) return;
    const { flow, signal } = begin();
    apply(flow, { busy: null, error: null }, (previous) => ({
      loading: previous.connection === null,
      checking: previous.connection !== null,
    }));
    void load(flow, signal, true);
  }

  return {
    setOptions: (next): void => {
      options = next;
    },

    start: (nextUserId): (() => void) => {
      userId = nextUserId;
      busy = null;
      navigating = false;
      if (!inline) {
        // The browser handoff: no callback lands here, nothing is followed.
        const { flow, signal } = begin();
        void (async (): Promise<void> => {
          // As below: Strict Mode's discarded run cancels before it sends.
          await Promise.resolve();
          if (flow !== generation) return;
          await load(flow, signal, true);
        })();
        return (): void => {
          generation += 1;
          controller?.abort();
          controller = null;
        };
      }
      const owner = Symbol('github-cloud-connection');
      const { flow, signal } = begin();
      captureCallback(nextUserId);
      void (async (): Promise<void> => {
        // Strict Mode re-runs this effect synchronously: one microtask lets
        // the discarded run cancel before it sends or claims anything.
        await Promise.resolve();
        if (flow !== generation) return;
        const claim = claimCallback(nextUserId, owner);
        if (claim.kind === 'claimed') {
          await continueCallback(flow, signal, claim.result, owner);
        } else {
          // No link callback landed here: a leftover marker is stale.
          if (claim.kind === 'none') clearLinkMarker();
          await load(flow, signal, claim.kind === 'none');
        }
      })();

      // A back/forward cache restore: the navigation to GitHub is over.
      const onPageShow = (event: PageTransitionEvent): void => {
        if (!event.persisted || !navigating) return;
        navigating = false;
        busy = null;
        clearLinkMarker();
        reload();
      };
      window.addEventListener('pageshow', onPageShow);

      return (): void => {
        window.removeEventListener('pageshow', onPageShow);
        generation += 1;
        controller?.abort();
        controller = null;
        finishCallback(owner);
      };
    },

    connect: async (connectOptions = {}): Promise<void> => {
      if (busy !== null) return;
      if (github.kind === 'browser') {
        // Connect, Reconnect, Install and Add account all continue on the
        // web Integrations page; Check again reads the connection again.
        try {
          github.continueInBrowser();
        } catch (error) {
          write({ notice: null, error: failure('connect', error) });
          return;
        }
        write({
          error: null,
          notice: {
            kind: 'handoff',
            message: GITHUB_CLOUD_CONTINUE_IN_BROWSER_COPY,
          },
        });
        return;
      }
      const intent = connectOptions.intent ?? 'connect';
      const { flow } = begin();
      navigating = false;
      apply(flow, { busy: busyFor(intent), error: null, notice: null });
      await runConnect(flow, intent, true);
    },

    verify: async (): Promise<void> => {
      if (busy !== null) return;
      const { flow, signal } = begin();
      apply(flow, { busy: 'verify', checking: true, error: null });
      await check(flow, signal, { busy: null });
    },

    disconnect: async (): Promise<boolean> => {
      if (busy === 'disconnect') return false;
      const { flow } = begin();
      navigating = false;
      // A link callback after Disconnect must not reconnect.
      if (inline) clearLinkMarker();
      apply(flow, { busy: 'disconnect', error: null, notice: null });
      try {
        const connection = await disconnectGitHubCloud(options.client);
        apply(flow, {
          connection,
          busy: null,
          loading: false,
          checking: false,
          verified: false,
          stale: false,
        });
        return true;
      } catch (error) {
        apply(flow, {
          busy: null,
          loading: false,
          checking: false,
          error: failure('disconnect', error),
        });
        return false;
      }
    },

    reload,

    dismissNotice: (): void => {
      write({ notice: null });
    },

    clearError: (): void => {
      write({ error: null });
    },
  };
}

/**
 * The GitHub for cloud controller. Mount it once per page and pass the
 * result to every view that needs it.
 */
export function useGitHubCloudConnection({
  userId,
  returnTo,
  navigate,
}: UseGitHubCloudConnectionOptions): GitHubCloudConnectionController {
  const client = useSettingsClient();
  const github = useGitHubCloudHost();
  const [stored, setStored] = useState<ControllerState>(() =>
    initialState(userId),
  );
  const [engine] = useState(() =>
    createControllerEngine(setStored, github, client),
  );

  useEffect(() => {
    engine.setOptions({
      returnTo,
      navigate: navigate ?? assignLocation,
      client,
    });
  });

  useEffect(() => engine.start(userId), [engine, userId]);

  // Until the reset for a new user commits, render one stable empty state.
  const reset = useMemo(() => initialState(userId), [userId]);
  const state = stored.userId === userId ? stored : reset;

  return useMemo(
    (): GitHubCloudConnectionController => ({
      connection: state.connection,
      loading: state.loading,
      checking: state.checking,
      verified: state.verified,
      stale: state.stale,
      busy: state.busy,
      error: state.error,
      notice: state.notice,
      connect: engine.connect,
      verify: engine.verify,
      disconnect: engine.disconnect,
      reload: engine.reload,
      dismissNotice: engine.dismissNotice,
      clearError: engine.clearError,
    }),
    [state, engine],
  );
}
