import { ORG_REPOSITORY_OWNER_URL_MAX_LENGTH } from '../org-projects';

/**
 * Argument policies the host applies to browser controllers on top of the
 * channel allowlist (CAN-7433). A browser reaches these channels only with
 * the exact arguments the portable adapter sends; the web golden asserts the
 * adapter never sends anything else.
 */

const REPOSITORY_OWNER_LOOKUP_CHANNEL = 'org-projects:find-repository-owner';

/**
 * Longest `remoteUrl` a browser may send to the repository owner lookup: the
 * handler's own clone URL limit.
 */
export const BROWSER_REPOSITORY_OWNER_URL_MAX_LENGTH =
  ORG_REPOSITORY_OWNER_URL_MAX_LENGTH;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Exactly one argument, an object whose only own key is `remoteUrl`: a
 * non-blank string of at most {@link BROWSER_REPOSITORY_OWNER_URL_MAX_LENGTH}
 * characters. The handler also accepts `{ path }`, which resolves a host
 * folder and reads its Git origin; a browser never reaches that form.
 */
export function browserRepositoryOwnerLookupAllowed(
  args: readonly unknown[],
): boolean {
  if (args.length !== 1) return false;
  const [request] = args;
  if (!isRecord(request)) return false;
  const keys = Object.keys(request);
  if (keys.length !== 1 || keys[0] !== 'remoteUrl') return false;
  const { remoteUrl } = request;
  return (
    typeof remoteUrl === 'string' &&
    remoteUrl.trim().length > 0 &&
    remoteUrl.length <= BROWSER_REPOSITORY_OWNER_URL_MAX_LENGTH
  );
}

/**
 * Whether a browser controller may invoke `channel` with `args`, beyond the
 * allowlist. Channels without a policy here pass.
 */
export function browserInvocationAllowed(
  channel: string,
  args: readonly unknown[],
): boolean {
  if (channel === REPOSITORY_OWNER_LOOKUP_CHANNEL)
    return browserRepositoryOwnerLookupAllowed(args);
  return true;
}
