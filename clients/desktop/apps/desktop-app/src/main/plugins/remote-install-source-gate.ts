import type { IPCResult } from '@canopy/execution-engine/types/pipeline';
import type { PluginInfo } from '@canopy/execution-engine/types/plugins';
import {
  controllerCredentialFreeGitUrl,
  controllerCredentialFreeText,
  controllerCredentialParts,
} from '../remote-control/host/controller-remote-urls';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  assertSafeExternalPluginCloneUrl,
  UnsafeExternalPluginUrlError,
} from './external-plugin-url';

export const REMOTE_PLUGIN_SOURCE_REFUSAL =
  'Remote control can only install plugins from public https sources. Install it on this computer to use a private or local source.';

export const REMOTE_PLUGIN_SOURCE_MISMATCH =
  'Remote control can only install this plugin from the source this computer has for it. Refresh its marketplace on this computer, then try again.';

/** The install `plugins:install-plugin` runs, as `plugin-service` exposes it. */
export type PluginSourceInstall = (
  marketplaceId: string,
  pluginName: string,
  sourceUrl: string,
  options?: { disableRedirects?: boolean },
) => Promise<IPCResult<PluginInfo>>;

/**
 * The source this computer's marketplace cache records for a plugin, or
 * `undefined` when it records none.
 */
export type StoredPluginSource = (
  marketplaceId: string,
  pluginName: string,
) => Promise<string | undefined>;

/**
 * A plugin record's external source URL, stored as `{ url }` or as the URL
 * itself.
 */
export function storedPluginSourceUrl(plugin: {
  readonly externalSource?: unknown;
}): string | undefined {
  const source = plugin.externalSource;
  const url =
    typeof source === 'object' && source !== null && 'url' in source
      ? source.url
      : source;
  return typeof url === 'string' && url !== '' ? url : undefined;
}

/** Why a controller's install failed, in words that never quote its source. */
const REMOTE_INSTALL_FAILURE_REASONS = [
  [
    /authentication failed|could not read (username|password)|terminal prompts disabled|returned error: 40[13]\b|permission denied/i,
    'authentication failed',
  ],
  [
    /not found|returned error: 404\b|does not exist/i,
    "the source wasn't found",
  ],
  [
    /could not resolve host|failed to connect|connection (refused|timed out|reset)|network is unreachable|timed out/i,
    "the source couldn't be reached",
  ],
] as const;

/** The one allowlisted reason a failed install's error text reads as. */
function remoteInstallFailureReason(error: string): string {
  return (
    REMOTE_INSTALL_FAILURE_REASONS.find(([pattern]) =>
      pattern.test(error),
    )?.[1] ?? 'the install failed'
  );
}

/**
 * The fixed message a controller gets when an install from a stored source
 * that holds a credential part, or any `@`, fails (CAN-7082): the source as
 * a controller sees it and one allowlisted reason. Nothing in it comes from
 * the error text, which can quote the credential in a form no scrub
 * anticipates.
 */
function remoteInstallFailure(stored: string, reason: string): string {
  const source = controllerCredentialFreeGitUrl(stored);
  return `Couldn't install this plugin from ${source === '' ? 'its source' : source}: ${reason}. Its details are in this computer's log.`;
}

/**
 * Runs a renderer plugin install by who asked for it (CAN-5764). A remote
 * principal (a Remote Control bridge sender) gets the Portal's rule: the source
 * must pass {@link assertSafeExternalPluginCloneUrl} and the clone refuses
 * redirects. The local user keeps any source their own git can reach, such as
 * a private-network forge or an ssh remote.
 *
 * A remote principal only ever sees plugin sources without their credentials
 * (CAN-7082), so the URL it sends picks this computer's own record and is
 * never cloned itself: it must be the stored source, or the stored source as
 * a controller sees it. The clone uses the stored source. A failure from a
 * stored source that holds a credential part, or any `@`, reaches the
 * controller only as a fixed message, and its details, scrubbed, are in this
 * computer's log (which can leave the machine in a bug report, so it never
 * holds the raw error); any other failure is scrubbed. A source the record
 * doesn't name is refused, so a new credential only arrives through adding
 * its marketplace.
 */
export async function installPluginForPrincipal(
  request: {
    remote: boolean;
    marketplaceId: string;
    pluginName: string;
    sourceUrl: string;
  },
  install: PluginSourceInstall,
  readStoredSource: StoredPluginSource,
): Promise<IPCResult<PluginInfo>> {
  const { marketplaceId, pluginName, sourceUrl } = request;
  if (!request.remote) return install(marketplaceId, pluginName, sourceUrl);
  const stored = await readStoredSource(marketplaceId, pluginName);
  if (
    stored === undefined ||
    (sourceUrl !== stored &&
      sourceUrl !== controllerCredentialFreeGitUrl(stored))
  )
    return { success: false, error: REMOTE_PLUGIN_SOURCE_MISMATCH };
  try {
    await assertSafeExternalPluginCloneUrl(stored);
  } catch (error) {
    if (error instanceof UnsafeExternalPluginUrlError)
      return {
        success: false,
        error: `${REMOTE_PLUGIN_SOURCE_REFUSAL} ${error.message}`,
      };
    throw error;
  }
  const result = await install(marketplaceId, pluginName, stored, {
    disableRedirects: true,
  });
  if (result.error === undefined) return result;
  // An `@` anywhere in the stored source counts as a credential part: a
  // reader that takes userinfo up to the last `@` finds one there.
  if (controllerCredentialParts(stored).length === 0 && !stored.includes('@'))
    return {
      ...result,
      error: controllerCredentialFreeText(result.error, stored),
    };
  const reason = remoteInstallFailureReason(result.error);
  logMainProcessWarn(
    '[remote-plugin-install] Install from a credentialed source failed',
    {
      marketplaceId,
      pluginName,
      reason,
      error: controllerCredentialFreeText(result.error, stored),
    },
  );
  return { ...result, error: remoteInstallFailure(stored, reason) };
}
