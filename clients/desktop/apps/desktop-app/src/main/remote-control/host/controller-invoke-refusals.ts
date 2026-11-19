import { MCP_SERVER_CHANNELS } from '@canopy/desktop-shared/constants/mcp-server-channels';

/**
 * Calls a remote-control controller may not make, whatever its kind
 * (CAN-7030). An embedded account MCP sign-in mints an authenticated portal
 * link for this computer's cloud account and returns it, so a controller may
 * only start the external sign-in, which the host opens in its own browser.
 */
export const CONTROLLER_EMBEDDED_SIGN_IN_REFUSAL =
  "Signing in inside the app isn't available from another device. Finish signing in on the computer you're controlling, or choose Open in default browser.";

interface ControllerRefusedCall {
  /** The URL fields this refusal keeps from controllers, as the check reads them. */
  readonly fields: readonly string[];
  readonly message: string;
  /** Whether a controller may make the call with these arguments. */
  readonly allows: (args: readonly unknown[]) => boolean;
}

/**
 * Only a request object without a browser mode is the external sign-in;
 * anything else, including arguments the handler would reject, is refused
 * before it reaches main.
 */
function isExternalAccountStart(args: readonly unknown[]): boolean {
  const [request] = args;
  return (
    typeof request === 'object' &&
    request !== null &&
    !Array.isArray(request) &&
    (!('browser' in request) || request.browser === undefined)
  );
}

/**
 * Keyed by channel. `check:remote-control-remote-urls` reads these keys and
 * fails when `remote-url-fields.json` lists a refused channel not here.
 */
export const CONTROLLER_REFUSED_CALLS = {
  [MCP_SERVER_CHANNELS.START_ACCOUNT]: {
    fields: ['embeddedUrl'],
    message: CONTROLLER_EMBEDDED_SIGN_IN_REFUSAL,
    allows: isExternalAccountStart,
  },
} as const satisfies Readonly<Record<string, ControllerRefusedCall>>;

const REFUSED_CALLS: Readonly<Record<string, ControllerRefusedCall>> =
  CONTROLLER_REFUSED_CALLS;

/** Why a controller's call is refused, or `undefined` when it may proceed. */
export function controllerInvokeRefusal(
  channel: string,
  args: readonly unknown[],
): string | undefined {
  const refused = REFUSED_CALLS[channel];
  return refused && !refused.allows(args) ? refused.message : undefined;
}
