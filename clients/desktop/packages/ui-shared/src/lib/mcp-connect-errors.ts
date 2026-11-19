/** Fallback for a connect failure without a code the copy below names. */
export const MCP_CONNECT_FAILED_MESSAGE = 'Couldn’t connect. Try again.';

/**
 * `sign_in_unavailable` when no device can sign in either: the server lets
 * only apps its provider approved sign in.
 */
const SIGN_IN_UNAVAILABLE =
  "This server only lets approved apps sign in, so your account can't connect it yet.";

const OAUTH_APP_REJECTED =
  'This server didn’t accept the OAuth app. Check its client ID and secret, then sign in again.';
const SIGN_IN_EXPIRED = 'This sign-in expired. Sign in again.';

/**
 * Plain copy for every code the account MCP connect flow can report: the
 * broker's start refusals, its OAuth callback outcomes, and the client's own
 * `network_error`. The code never appears in the sentence; hosts keep it for
 * debugging next to the message.
 */
const MCP_CONNECT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  network_error:
    'Couldn’t reach your account. Check your connection and try again.',
  not_found: 'MCP connections aren’t available for your account.',
  server_not_found:
    'This server is no longer available. Refresh the list and try again.',
  invalid_token: 'Check the access token and try again.',
  invalid_oauth_client: 'Check the client ID and secret, then try again.',
  invalid_headers:
    'Your account couldn’t store these headers. Check them and try again.',
  unsupported_provider:
    'Connect this server from the desktop app with your Claude or Codex account.',
  desktop_only: 'Connect this server from the desktop app.',
  unsupported_configuration:
    'This server needs setup your account doesn’t support yet.',
  configuration_required:
    'This server needs its own OAuth app. Enter its details to connect.',
  client_credentials_required:
    'This server needs its own OAuth app. Enter its client ID to connect.',
  sign_in_unavailable: SIGN_IN_UNAVAILABLE,
  registration_unavailable:
    'This server doesn’t support automatic client registration. Connect with an access token instead.',
  authorization_server_unavailable:
    'Couldn’t read this server’s sign-in settings. Try again later.',
  invalid_url: 'Your account can’t reach this address. Use a public HTTPS URL.',
  endpoint_required: 'Choose an endpoint for this server, then sign in again.',
  connection_limit_reached:
    'Your account already has 32 custom servers. Disconnect one to add another.',
  untrusted_authorization_server:
    'This server signs in through a service that isn’t trusted for it, so it can’t connect.',
  oauth_unavailable:
    'This server doesn’t use OAuth sign-in. Connect without an OAuth app.',
  discovery_failed:
    'Couldn’t find how to sign in to this server. Check its address and try again.',
  unsupported_redirect:
    'This server doesn’t accept the sign-in return address, so it can’t connect.',
  unsupported_pkce:
    'This server’s sign-in doesn’t support the PKCE protection MCP requires, so it can’t connect.',
  connection_busy: 'This server changed while connecting. Try again.',
  mcp_extra_headers_unavailable:
    'Couldn’t read this server’s stored headers. Edit the server and add them again.',
  transient: 'Couldn’t reach this server’s sign-in service. Try again.',
  invalid_metadata:
    'This server’s sign-in settings aren’t valid, so it can’t connect.',
  invalid_client: OAUTH_APP_REJECTED,
  unauthorized_client: OAUTH_APP_REJECTED,
  invalid_grant: 'Sign-in expired before it finished. Sign in again.',
  invalid_state: SIGN_IN_EXPIRED,
  invalid_callback: SIGN_IN_EXPIRED,
  account_mismatch:
    'This sign-in started from a different account. Sign in to that account, then try again.',
  // The sign-in page saw a browser session it can't use: an account that
  // isn't active (usually not the one that started the sign-in), or one
  // that hasn't finished two-factor verification.
  account_inactive:
    'Your browser is signed in to an account that isn’t active. Sign in with your active account, then try again.',
  two_factor_required:
    'Finish two-factor verification in your browser, then try again.',
  // What the app that started the sign-in is told: the browser's account
  // couldn't continue, without saying why (only that browser sees why).
  browser_account_refused:
    'The account your browser is signed in to can’t finish this sign-in. Sign in with the account you use here, then try again.',
  issuer_mismatch: 'Sign-in came back from a different service. Sign in again.',
  access_denied: 'Access wasn’t approved. Sign in again to approve it.',
  oauth_error: 'The sign-in page reported a problem. Sign in again.',
  callback_failed: 'Couldn’t finish signing in. Sign in again.',
};

/** The sentence for a connect failure; unknown or absent codes fall back. */
export function mcpConnectErrorMessage(
  code: string | null | undefined,
): string {
  return (
    (code ? MCP_CONNECT_ERROR_MESSAGES[code] : undefined) ??
    MCP_CONNECT_FAILED_MESSAGE
  );
}

/** Which app shows a connect failure, for copy that points at the other. */
export type McpConnectSurface = 'web' | 'desktop';

/**
 * The sentence for `sign_in_unavailable`: the account can't sign in to a
 * catalog server that lets only approved apps sign in. When a desktop device
 * can (`desktopSignIn`), the web points at the desktop app and the desktop
 * at adding the server to this device; otherwise it says no app can yet.
 */
export function mcpSignInUnavailableMessage(
  desktopSignIn: boolean,
  surface: McpConnectSurface,
): string {
  if (!desktopSignIn) return SIGN_IN_UNAVAILABLE;
  return surface === 'web'
    ? 'Connect this server from the desktop app.'
    : "Your account can't sign in to this server. Add it to this device instead.";
}

/** Tooltip text that keeps a failure's code at hand without putting it in the sentence. */
export function mcpConnectErrorCodeTitle(
  code: string | null | undefined,
): string | undefined {
  return code ? `Error code: ${code}` : undefined;
}

/** What a connect form needs from the broker's client setup to explain itself. */
export interface McpClientSetupCopyInput {
  readonly clientSecretRequired: boolean;
  readonly clientSecretAccepted: boolean;
  /** The server refused registration by policy: it takes approved apps only. */
  readonly registrationRefused?: boolean;
}

/**
 * The explanation above the OAuth app fields when a server registers no
 * clients itself. `serverName` is the catalog or connection name.
 */
export function mcpClientSetupExplanation(
  serverName: string,
  setup: McpClientSetupCopyInput,
): string {
  if (setup.clientSecretRequired && !setup.clientSecretAccepted)
    return `${serverName} needs its own app with a client secret, which your account can’t store for this server. Connect with an access token instead.`;
  const credentials = setup.clientSecretRequired
    ? 'its client ID and client secret'
    : 'its client ID';
  if (setup.registrationRefused)
    return `${serverName} only lets approved apps sign in. Register an app with ${serverName} using this redirect URI, then paste ${credentials}.`;
  return `${serverName} doesn’t let apps register themselves. Create an app in ${serverName}’s developer dashboard with this redirect URI, then paste ${credentials}.`;
}

/** Whether the form collects the app's client ID (and maybe secret) at all. */
export function mcpClientSetupCollectsClient(
  setup: McpClientSetupCopyInput,
): boolean {
  return !(setup.clientSecretRequired && !setup.clientSecretAccepted);
}
