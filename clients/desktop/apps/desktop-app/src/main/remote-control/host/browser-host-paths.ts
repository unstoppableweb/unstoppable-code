import type { CloneJobSnapshot } from '@canopy/protocol/clone-jobs';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { PLUGINS_CHANNELS } from '@canopy/desktop-shared/constants/plugin-channels';
import { INSTALLED_ITEM_CHANNELS } from '@canopy/desktop-shared/types/installed-items';
import {
  browserPluginInstallError,
  REMOTE_PLUGIN_INSTALL_FAILED_MESSAGE,
  type RemoteBuiltInPluginInstallResult,
  type RemoteInstalledPlugin,
  type RemotePluginInstallResult,
  type RemotePluginProviderOutcome,
  type RemotePluginProviderOutcomes,
} from '@canopy/protocol/plugins/remote-install';
import { repositoryCloneErrorMessage } from '@canopy/protocol/remote-control/shell';

/**
 * Host paths a browser controller does not receive (CAN-7433, CAN-7442). A clone job's
 * `destinationPath` names a folder on this computer; mobile has always
 * received it, but the browser's pending clone rows never read it, so a
 * browser gets `null`. `error` is free text, so a browser receives it only
 * when it is one of the safe clone messages: a failed cleanup, which names the
 * folder, gets path-free copy, and any other text gets the generic failure.
 * Applied after the remote URL projection, to browser sessions only.
 *
 * An archive recovery Finish result's `check` (CAN-7444) is a diagnostic code,
 * but a W5 refusal's `check` is whatever string its thrower set. A browser
 * receives it only when it is code-shaped; anything else, whatever the result's
 * `status`, becomes `finish-refused`. Resolve results carry only ids, counts and
 * enums and pass unchanged, as do recovery-aware discard descriptions, which
 * stay under the CAN-5334 path exception like plain ones.
 */

const BROWSER_CLEANUP_FAILED_MESSAGE =
  "Couldn't remove the incomplete clone. Remove it on the computer.";

/**
 * The snapshot fields a browser receives as the host sent them. None is free
 * text that can name a host path: `received` and `throughput` are formatted
 * sizes, `workspaceName` is the project's display name, and `remoteUrl` is
 * already blank for controllers. `destinationPath` and `error` are projected
 * below, and any other field (one a newer host adds) is never sent.
 */
const BROWSER_CLONE_JOB_FIELDS = [
  'id',
  'repoName',
  'remoteUrl',
  'status',
  'phase',
  'phasePercent',
  'percent',
  'processedCount',
  'totalCount',
  'received',
  'throughput',
  'startedAt',
  'background',
  'cancellable',
  'workspaceId',
  'workspaceName',
] as const satisfies readonly Exclude<
  keyof CloneJobSnapshot,
  'destinationPath' | 'error'
>[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function browserCloneError(error: string, path: unknown): string {
  if (typeof path === 'string' && path !== '' && error.includes(path))
    return BROWSER_CLEANUP_FAILED_MESSAGE;
  // Returns `error` unchanged only when it is a safe clone message.
  return repositoryCloneErrorMessage(error);
}

// Fails closed: every job record gets the projection whether or not it
// carries a `destinationPath` key, an `error` that is not text becomes `null`
// (the wire value for "no error", which the controller's parser requires),
// and anything that is not a job list or a job record reaches a browser as no
// jobs.
function cloneJobWithoutPath(
  job: Record<string, unknown>,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of BROWSER_CLONE_JOB_FIELDS)
    if (field in job) projected[field] = job[field];
  projected.destinationPath = null;
  projected.error =
    typeof job.error === 'string'
      ? browserCloneError(job.error, job.destinationPath)
      : null;
  return projected;
}

function cloneJobsWithoutPaths(jobs: unknown): Record<string, unknown>[] {
  return Array.isArray(jobs)
    ? jobs.filter(isRecord).map(cloneJobWithoutPath)
    : [];
}

/**
 * Plugin installs (CAN-7442). A browser receives an install result built from
 * an allowlist of fields, never the full `PluginInfo`, which names source,
 * cache and install paths. A field a newer host adds is never sent. A kept
 * field is copied only when it has the expected type, an error only when it
 * is one of the computer's fixed messages (`browserPluginInstallError`), and
 * `appError` never. A result that is not the expected shape reaches a browser
 * as the generic failure.
 */
const INSTALL_FAILED = {
  success: false,
  error: REMOTE_PLUGIN_INSTALL_FAILED_MESSAGE,
} as const;

type BrowserProviderInstallStatus = NonNullable<
  NonNullable<RemoteInstalledPlugin['globalInstallStatus']>['claude']
>;

// No install path, and no status-read or install error text.
function providerInstallStatus(
  value: unknown,
): BrowserProviderInstallStatus | undefined {
  if (
    !isRecord(value) ||
    typeof value.available !== 'boolean' ||
    typeof value.installed !== 'boolean'
  )
    return undefined;
  const { enabled, version } = value;
  return {
    available: value.available,
    installed: value.installed,
    ...(typeof enabled === 'boolean' ? { enabled } : {}),
    ...(typeof version === 'string' ? { version } : {}),
  };
}

function globalInstallStatus(
  value: unknown,
): Pick<RemoteInstalledPlugin, 'globalInstallStatus'> {
  if (!isRecord(value) || typeof value.checkedAt !== 'string') return {};
  const claude = providerInstallStatus(value.claude);
  const codex = providerInstallStatus(value.codex);
  return {
    globalInstallStatus: {
      checkedAt: value.checkedAt,
      ...(claude ? { claude } : {}),
      ...(codex ? { codex } : {}),
    },
  };
}

function providerSupport(
  value: unknown,
): Pick<RemoteInstalledPlugin, 'providerSupport'> {
  return isRecord(value) &&
    typeof value.claude === 'string' &&
    typeof value.codex === 'string'
    ? { providerSupport: { claude: value.claude, codex: value.codex } }
    : {};
}

function installedPlugin(value: unknown): RemoteInstalledPlugin | undefined {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.marketplaceId !== 'string'
  )
    return undefined;
  const { displayName, version, builtIn, curated, cachedAt } = value;
  return {
    name: value.name,
    marketplaceId: value.marketplaceId,
    ...(typeof displayName === 'string' ? { displayName } : {}),
    ...(typeof version === 'string' ? { version } : {}),
    ...(typeof builtIn === 'boolean' ? { builtIn } : {}),
    ...(typeof curated === 'boolean' ? { curated } : {}),
    ...providerSupport(value.providerSupport),
    ...globalInstallStatus(value.globalInstallStatus),
    ...(typeof cachedAt === 'string' ? { cachedAt } : {}),
  };
}

function providerOutcome(
  value: unknown,
): RemotePluginProviderOutcome | undefined {
  if (!isRecord(value) || typeof value.installed !== 'boolean')
    return undefined;
  return {
    installed: value.installed,
    ...(value.error === undefined
      ? {}
      : { error: browserPluginInstallError(value.error) }),
  };
}

function providerOutcomes(value: unknown): RemotePluginProviderOutcomes {
  if (!isRecord(value)) return {};
  const claude = providerOutcome(value.claude);
  const codex = providerOutcome(value.codex);
  return { ...(claude ? { claude } : {}), ...(codex ? { codex } : {}) };
}

function installEnvelope(
  value: unknown,
): { success: boolean; error?: string } | undefined {
  if (!isRecord(value) || typeof value.success !== 'boolean') return undefined;
  return value.success
    ? { success: true }
    : { success: false, error: browserPluginInstallError(value.error) };
}

function browserPluginInstallResult(value: unknown): RemotePluginInstallResult {
  const envelope = installEnvelope(value);
  if (!envelope || !isRecord(value)) return INSTALL_FAILED;
  const plugin = installedPlugin(value.data);
  return { ...envelope, ...(plugin ? { data: plugin } : {}) };
}

function browserBuiltInPluginInstallResult(
  value: unknown,
): RemoteBuiltInPluginInstallResult {
  const envelope = installEnvelope(value);
  if (!envelope || !isRecord(value)) return INSTALL_FAILED;
  const data = value.data;
  const plugin = isRecord(data) ? installedPlugin(data.plugin) : undefined;
  return {
    ...envelope,
    ...(plugin && isRecord(data)
      ? {
          data: {
            plugin,
            providerOutcomes: providerOutcomes(data.providerOutcomes),
          },
        }
      : {}),
  };
}

/**
 * Installed-item changes (CAN-7442). The status snapshot is fixed copy from
 * the computer (reasons, notices, uninstall descriptions), the same snapshot
 * the computer syncs to the account, so a browser receives it as sent. A
 * failed change's message is fixed copy for every error code except a status
 * transition's, which carries the thrown text (CLI output, file errors): a
 * browser gets fixed copy for that code and for any code a newer host adds.
 */
const BROWSER_INSTALLED_ITEM_CHANGE_FAILED_MESSAGE =
  "Couldn't change this item. Check the desktop app for details.";

const INSTALLED_ITEM_FIXED_MESSAGE_CODES: ReadonlySet<string> = new Set([
  'not_found',
  'not_removable',
  'provider_pending',
  'refresh_failed',
  'state_unavailable',
  'uninstall_incomplete',
]);

function installedItemMutationError(error: unknown): unknown {
  if (!isRecord(error)) return error;
  return typeof error.code === 'string' &&
    INSTALLED_ITEM_FIXED_MESSAGE_CODES.has(error.code)
    ? error
    : { ...error, message: BROWSER_INSTALLED_ITEM_CHANGE_FAILED_MESSAGE };
}

// Anything but a result record reaches a browser as `null`, which the
// adapter's parser refuses as a malformed reply.
function browserInstalledItemMutationResult(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.errors)) return null;
  return { ...value, errors: value.errors.map(installedItemMutationError) };
}

/**
 * Every literal `check` code `worktree-recovery-finish.ts` and the recovery
 * diagnosis produce is lowercase kebab case. No path separator, drive colon,
 * space or `~` fits.
 */
const BROWSER_FINISH_CHECK_PATTERN = /^[a-z0-9-]{1,64}$/;
const BROWSER_FINISH_REFUSED_CHECK = 'finish-refused';

function browserWorktreeRecoveryFinishResult(value: unknown): unknown {
  if (!isRecord(value) || !('check' in value)) return value;
  return typeof value.check === 'string' &&
    BROWSER_FINISH_CHECK_PATTERN.test(value.check)
    ? value
    : { ...value, check: BROWSER_FINISH_REFUSED_CHECK };
}

/** A tunnelled invoke's result as a browser controller may see it. */
export function projectBrowserResult(channel: string, value: unknown): unknown {
  switch (channel) {
    case IPC_CHANNELS.cloneJobsList:
      return cloneJobsWithoutPaths(value);
    case PLUGINS_CHANNELS.INSTALL_PLUGIN:
      return browserPluginInstallResult(value);
    case PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN:
      return browserBuiltInPluginInstallResult(value);
    case INSTALLED_ITEM_CHANNELS.SET_STATUS:
    case INSTALLED_ITEM_CHANNELS.UNINSTALL:
      return browserInstalledItemMutationResult(value);
    case IPC_CHANNELS.worktreeRecoveryFinish:
      return browserWorktreeRecoveryFinishResult(value);
    default:
      return value;
  }
}

/**
 * A push's arguments as a browser controller may see them. A clone job push
 * carries only the projected job list.
 */
export function projectBrowserPush(
  channel: string,
  args: readonly unknown[],
): unknown[] {
  if (channel !== IPC_CHANNELS.cloneJobsChanged) return [...args];
  return [cloneJobsWithoutPaths(args[0])];
}
