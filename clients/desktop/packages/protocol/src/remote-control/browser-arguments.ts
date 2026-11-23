import { ORG_REPOSITORY_OWNER_URL_MAX_LENGTH } from '../org-projects';
import { REMOTE_PLUGIN_INSTALL_PROVIDERS } from '../plugins/remote-install';

/**
 * Argument policies the host applies to browser controllers on top of the
 * channel allowlist. A browser reaches these channels only with the
 * arguments the portable adapter sends; the web golden asserts the adapter
 * never sends anything else.
 *
 * - Repository owner lookup (CAN-7433): exactly `{ remoteUrl }`.
 * - Worktree discard description (CAN-7443, CAN-7444): `recovery` only on
 *   the first argument, as exactly the recovery request the adapter sends.
 * - Project and workspace deletion (CAN-7443, CAN-7444):
 *   `discardPendingRecovery` only on the first argument, as a bounded list of
 *   exactly `{ operationId, confirmation }` entries. The computer compares it
 *   with its own fresh description and refuses any difference.
 *
 * Shapes are checked by hand, key by key: the handlers' own schemas strip
 * unknown keys rather than refusing them.
 *
 * Channel names are string literals: this module can't import `channels.ts`,
 * which re-exports it.
 */

const REPOSITORY_OWNER_LOOKUP_CHANNEL = 'org-projects:find-repository-owner';
const INSTALLED_ITEMS_LIST_STATUS_CHANNEL = 'installed-items:list-status';
const INSTALLED_ITEMS_SET_STATUS_CHANNEL = 'installed-items:set-status';
const INSTALLED_ITEMS_UNINSTALL_CHANNEL = 'installed-items:uninstall';
const PLUGINS_INSTALL_PLUGIN_CHANNEL = 'plugins:install-plugin';
const PLUGINS_INSTALL_BUILT_IN_PLUGIN_CHANNEL =
  'plugins:install-built-in-plugin';

/**
 * Longest marketplace or plugin name a browser may send to a plugin install.
 * Both are lookup keys into the computer's own marketplace records.
 */
export const BROWSER_PLUGIN_INSTALL_NAME_MAX_LENGTH = 256;
const WORKTREE_DISCARD_DESCRIBE_CHANNEL = 'worktree:discard-describe';
const WORKSPACE_DELETE_CHANNEL = 'workspace:delete';
const PROJECT_DELETE_CHANNEL = 'project:delete';

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

function isInstallName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= BROWSER_PLUGIN_INSTALL_NAME_MAX_LENGTH
  );
}

/**
 * Exactly `(marketplaceId, pluginName, '')` (CAN-7442). The empty source URL
 * asks the computer to install from the source it has stored for that
 * plugin; a browser never names a source, so any other URL is refused here.
 */
export function browserPluginInstallAllowed(args: readonly unknown[]): boolean {
  if (args.length !== 3) return false;
  const [marketplaceId, pluginName, sourceUrl] = args;
  return (
    isInstallName(marketplaceId) &&
    isInstallName(pluginName) &&
    sourceUrl === ''
  );
}

/**
 * Exactly one `{ marketplaceId, pluginName, providers }` object with no other
 * key, and one or both known providers, each once (CAN-7442). The handler's
 * own marketplace check refuses anything but the built-in or curated one.
 */
export function browserBuiltInPluginInstallAllowed(
  args: readonly unknown[],
): boolean {
  if (args.length !== 1) return false;
  const [request] = args;
  if (!isRecord(request)) return false;
  const keys = Object.keys(request).sort();
  if (keys.join(',') !== 'marketplaceId,pluginName,providers') return false;
  const { marketplaceId, pluginName, providers } = request;
  if (!isInstallName(marketplaceId) || !isInstallName(pluginName)) return false;
  if (!Array.isArray(providers) || providers.length === 0) return false;
  const known: readonly unknown[] = REMOTE_PLUGIN_INSTALL_PROVIDERS;
  return (
    providers.every((provider) => known.includes(provider)) &&
    new Set(providers).size === providers.length
  );
}

/**
 * Whether any argument after the first is a record with `key` as an own key,
 * whatever its value (`undefined` included). Nested objects are not searched;
 * `null`, arrays, strings and numbers never match.
 */
function someLaterArgumentHasOwnKey(
  args: readonly unknown[],
  key: string,
): boolean {
  return args
    .slice(1)
    .some(
      (arg) => isRecord(arg) && Object.prototype.hasOwnProperty.call(arg, key),
    );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** The UUID form the handler's `operationId` schema accepts. */
const BROWSER_RECOVERY_OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A worktree recovery request, key for key: `intent` (`archive` or
 * `delete`) and `expectedCreatedAt` (a non-empty string or `null`) are
 * required, `operationId` is an optional UUID, and no other key appears.
 */
function isBrowserWorktreeRecoveryRequest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ['intent', 'expectedCreatedAt', 'operationId']))
    return false;
  const { intent, expectedCreatedAt } = value;
  if (intent !== 'archive' && intent !== 'delete') return false;
  if (!hasOwn(value, 'expectedCreatedAt')) return false;
  if (
    expectedCreatedAt !== null &&
    (typeof expectedCreatedAt !== 'string' || expectedCreatedAt.length === 0)
  )
    return false;
  if (!hasOwn(value, 'operationId')) return true;
  return (
    typeof value.operationId === 'string' &&
    BROWSER_RECOVERY_OPERATION_ID_PATTERN.test(value.operationId)
  );
}

/**
 * `worktree:discard-describe` with `recovery` only as an own key of the first
 * argument, and only as exactly the recovery request the adapter sends for a
 * target with settled worktree recovery (CAN-7444). A `recovery` key on any
 * later argument is refused; nested objects are not searched, as the handler
 * reads only the first argument's own `recovery`.
 */
export function browserWorktreeDiscardDescribeAllowed(
  args: readonly unknown[],
): boolean {
  if (someLaterArgumentHasOwnKey(args, 'recovery')) return false;
  const [request] = args;
  if (!isRecord(request) || !hasOwn(request, 'recovery')) return true;
  return isBrowserWorktreeRecoveryRequest(request.recovery);
}

/**
 * Most pending recoveries a browser may confirm discarding in one deletion.
 * The handler has no bound of its own; it compares the list with its fresh
 * description, so a longer list is refused there anyway.
 */
export const BROWSER_PENDING_RECOVERY_MAX_ENTRIES = 256;
/**
 * Longest `operationId` or `confirmation` a browser may send: the computer's
 * own values are a UUID and a SHA-256 hex digest.
 */
export const BROWSER_PENDING_RECOVERY_FIELD_MAX_LENGTH = 256;

function isPendingRecoveryField(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= BROWSER_PENDING_RECOVERY_FIELD_MAX_LENGTH
  );
}

function isBrowserPendingRecovery(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.join(',') === 'confirmation,operationId' &&
    isPendingRecoveryField(value.operationId) &&
    isPendingRecoveryField(value.confirmation)
  );
}

/**
 * `workspace:delete` and `project:delete` with `discardPendingRecovery` only
 * as an own key of the first argument, and only as an array of at most
 * {@link BROWSER_PENDING_RECOVERY_MAX_ENTRIES} exact
 * `{ operationId, confirmation }` entries (CAN-7444). An empty list is
 * accepted: the handler treats it as confirming no pending recovery, and
 * refuses it when any is pending. The key on a later argument is refused.
 * `supersedeInterruptedDeletion` is accepted.
 */
export function browserWorkspaceDeleteAllowed(
  args: readonly unknown[],
): boolean {
  if (someLaterArgumentHasOwnKey(args, 'discardPendingRecovery')) return false;
  const [request] = args;
  if (!isRecord(request) || !hasOwn(request, 'discardPendingRecovery'))
    return true;
  const pending = request.discardPendingRecovery;
  return (
    Array.isArray(pending) &&
    pending.length <= BROWSER_PENDING_RECOVERY_MAX_ENTRIES &&
    pending.every(isBrowserPendingRecovery)
  );
}

/**
 * Whether a browser controller may invoke `channel` with `args`, beyond the
 * allowlist. Channels without a policy here pass. The installed-item status
 * read takes no argument, and each installed-item change exactly one request,
 * which the handler parses strictly.
 */
export function browserInvocationAllowed(
  channel: string,
  args: readonly unknown[],
): boolean {
  switch (channel) {
    case REPOSITORY_OWNER_LOOKUP_CHANNEL:
      return browserRepositoryOwnerLookupAllowed(args);
    case INSTALLED_ITEMS_LIST_STATUS_CHANNEL:
      return args.length === 0;
    case INSTALLED_ITEMS_SET_STATUS_CHANNEL:
    case INSTALLED_ITEMS_UNINSTALL_CHANNEL:
      return args.length === 1;
    case PLUGINS_INSTALL_PLUGIN_CHANNEL:
      return browserPluginInstallAllowed(args);
    case PLUGINS_INSTALL_BUILT_IN_PLUGIN_CHANNEL:
      return browserBuiltInPluginInstallAllowed(args);
    case WORKTREE_DISCARD_DESCRIBE_CHANNEL:
      return browserWorktreeDiscardDescribeAllowed(args);
    case WORKSPACE_DELETE_CHANNEL:
    case PROJECT_DELETE_CHANNEL:
      return browserWorkspaceDeleteAllowed(args);
    default:
      return true;
  }
}
