import {
  runClassifiedShare,
  withShareStage,
} from '../sharing/share-operation-result';
import { PLUGINS_CHANNELS } from '@canopy/desktop-shared/constants/plugin-channels';
import { CANOPY_CLOUD_SERVER_ID } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  isCuratedPluginMarketplaceId,
  type InstallBuiltInPluginRequest,
  type ListSharedPluginsResponse,
  type ListSharedPluginsRequest,
  type MarketplaceOperationProgress,
  type PluginProvider,
  type SharedPluginCreateRequest,
  type SharedPluginDeleteRequest,
  type SharedPluginDetail,
  type SharedPluginGetRequest,
  type SharedPluginPublicShareInfo,
  type SharedPluginUpdateRequest,
  type ResolvePortablePluginRefsRequest,
  type ResolvePortablePluginRefsResponse,
  type ResolvePortableEnableRefRequest,
  type AnalyzeSharedPluginReferenceRequest,
} from '@canopy/execution-engine/types/plugins';
import {
  computePluginShareableRef,
  getShareablePluginRefKey,
  isShareablePluginRef,
} from '@canopy/execution-engine/plugin-refs';
import type { ShareablePluginRef } from '@canopy/execution-engine/plugin-refs';
import {
  loadShareablePluginCatalog,
  resolveShareablePluginRefs,
} from './shareable-plugin-resolution';
import type { IPCResult } from '@canopy/execution-engine/types/pipeline';
import type { IpcMainInvokeEvent } from 'electron';
import { registerIpcHandler } from '../ipc/register';
import { reportCuratedPluginInstalled } from './curated-plugin-events';
import { refreshInvocableInventoryAfterMutation } from './invocable-inventory-service';
import { validateId } from '../lib/validation';
import * as service from './plugin-service';
import { installPluginForPrincipal } from './remote-install-source-gate';
import { resolveRemoteBridgeSender } from '../remote-control/host/bridge-window';
import {
  createSharedPlugin,
  deleteSharedPlugin,
  getSharedPlugin,
  listSharedPlugins,
  assertSharedPluginsSupported,
  publishPluginPublicShare,
  revokePluginPublicShare,
  updateSharedPlugin,
} from './canopy-server-client';
import { sendToWebContents } from '../lib/web-contents-send';
import { analyzeSubjectCapabilityPackage } from '../pipelines/pipeline-package-service';
import type { PipelinePackageAnalysisSummary } from '@canopy/execution-engine/types/pipeline';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Plugin marketplace IPC channel registration.
 *
 * Channel signatures (renderer ↔ main) — see `PluginsAPI` in
 * `@canopy/execution-engine/types/plugins` for the typed contract:
 *
 * - `plugins:load`               input: void
 *                                output: IPCResult<PluginsCache>
 * - `plugins:loadCacheOnly`      input: void
 *                                output: IPCResult<PluginsCache>
 *                                (cache-only; never refreshes)
 * - `plugins:refreshMarketplaces` input: void
 *                                output: IPCResult<PluginsCache>
 * - `plugins:addMarketplace`     input: repo: string
 *                                output: IPCResult<MarketplaceRegistrationResult>
 * - `plugins:updateMarketplace`  input: id: string
 *                                output: IPCResult<MarketplaceInfo>
 * - `plugins:removeMarketplace`  input: { id: string; providers?: PluginProvider[] }
 *                                output: IPCResult<MarketplaceRemovalResult>
 * - `plugins:read-component`     input: installLocation, pluginSourcePath, componentFile
 *                                output: IPCResult<PluginComponentContent>
 * - `plugins:install-plugin`     input: marketplaceId, pluginName, sourceUrl
 *                                output: IPCResult<PluginInfo>
 * - `plugins:prepare-codex-compatibility` input: marketplaceId, pluginName
 *                                output: IPCResult<PluginInfo>
 * - `plugins:set-codex-compat-disabled` input: marketplaceId, pluginName, disabled
 *                                output: IPCResult<PluginInfo>
 * - `plugins:install-built-in-plugin` input: InstallBuiltInPluginRequest
 *                                output: IPCResult<InstallBuiltInPluginResult>
 * - `plugins:shared-*`           input/output: portable shared-plugin registry
 *                                contracts from `@canopy/protocol/plugins`
 *
 * Handler contract requirements:
 * - All handlers must serialize result shapes through the existing
 *   `IPCResult` envelope without leaking non-cloneable values (e.g., wrap
 *   `Error` objects into `{ message, code? }`).
 * - The `removeMarketplace` handler accepts `{ id, providers? }`; the
 *   service applies the default full-removal provider list when omitted.
 */
/**
 * Run a mutating plugin/marketplace operation and, on success, kick the
 * invocable-inventory rebuild. Shared by the renderer IPC handlers below and
 * the portal mutation adapters so every mutation path refreshes the inventory
 * the same way.
 */
export async function refreshAfterSuccess<T>(
  reason: string,
  operation: () => Promise<IPCResult<T>> | IPCResult<T>,
): Promise<IPCResult<T>> {
  const result = await operation();
  if (result.success) {
    refreshInvocableInventoryAfterMutation(reason);
  }
  return result;
}

/**
 * Best-effort curated-install telemetry, shared by the renderer IPC handler
 * and the portal install adapter. Curated installs are the only user action
 * that carries adoption intent. Deliberately not awaited: telemetry must
 * never delay or fail an install that already succeeded in the provider.
 */
export function reportCuratedPluginInstallBestEffort(
  marketplaceId: string,
  pluginName: string,
): void {
  if (!isCuratedPluginMarketplaceId(marketplaceId)) {
    return;
  }
  try {
    void reportCuratedPluginInstalled(pluginName).catch(() => undefined);
  } catch {
    // Contain both synchronous mock failures and async rejections.
  }
}

type MarketplaceProgress = (progress: MarketplaceOperationProgress) => void;

/*
 * The window's marketplace and install calls as owners, so App Advisor's
 * shared imports in Electron main make the same ones (CAN-6003). The window's
 * handlers pass the progress callback and whether the sender is a remote
 * bridge; a main caller passes neither, as the window's own sender would.
 */

export function addMarketplaceForCaller(
  repo: string,
  progress?: MarketplaceProgress,
): Promise<Awaited<ReturnType<typeof service.addMarketplace>>> {
  return refreshAfterSuccess('plugins:addMarketplace', () =>
    service.addMarketplace(repo, progress),
  );
}

export async function installBuiltInPluginForCaller(
  request: InstallBuiltInPluginRequest,
  progress?: MarketplaceProgress,
): Promise<Awaited<ReturnType<typeof service.installBuiltInPlugin>>> {
  const result = await refreshAfterSuccess(
    'plugins:install-built-in-plugin',
    () => service.installBuiltInPlugin(request, progress),
  );
  if (result.success) {
    reportCuratedPluginInstallBestEffort(
      request.marketplaceId,
      request.pluginName,
    );
  }
  return result;
}

export function installPluginForCaller(request: {
  marketplaceId: string;
  pluginName: string;
  sourceUrl: string;
  remote: boolean;
}): Promise<Awaited<ReturnType<typeof service.installPlugin>>> {
  return refreshAfterSuccess('plugins:install-plugin', () =>
    installPluginForPrincipal(request, service.installPlugin),
  );
}

export function refreshMarketplacesForCaller(
  providerUpdates: 'always' | 'if-stale' | undefined,
  progress?: MarketplaceProgress,
): Promise<Awaited<ReturnType<typeof service.refreshMarketplaces>>> {
  return refreshAfterSuccess('plugins:refreshMarketplaces', () =>
    service.refreshMarketplaces(progress, {
      providerUpdates: providerUpdates === 'always' ? 'always' : 'if-stale',
    }),
  );
}

export function registerPluginHandlers(): void {
  registerIpcHandler(
    PLUGINS_CHANNELS.SHARED_REFERENCE_ANALYZE,
    async (
      _event,
      request: AnalyzeSharedPluginReferenceRequest,
    ): Promise<IPCResult<PipelinePackageAnalysisSummary>> => {
      try {
        if (!request || !isShareablePluginRef(request.ref)) {
          throw new Error('Portable plugin reference is invalid.');
        }
        const [match] = resolveShareablePluginRefs(
          [request.ref],
          await loadShareablePluginCatalog(),
        );
        const selections: ResolvePortablePluginRefsResponse['selections'] = {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        };
        if (match?.matchState === 'matched') {
          if (match.selection.kind === 'skill') {
            selections.skillRefs.push({
              sourceId: match.selection.sourceId,
              skillName: match.selection.skillName,
            });
          } else {
            selections.pluginRefs.push({
              marketplaceId: match.selection.marketplaceId,
              pluginName: match.selection.pluginName,
            });
          }
        }
        return {
          success: true,
          data: await analyzeSubjectCapabilityPackage({
            rawContent: JSON.stringify(request.ref),
            scopeKey: `plugin-reference:${getShareablePluginRefKey(request.ref)}`,
            selections,
            mode: 'reference',
          }),
        };
      } catch (error) {
        return { success: false, error: toErrorMessage(error) };
      }
    },
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.RESOLVE_PORTABLE_ENABLE_REF,
    async (
      _event,
      request: ResolvePortableEnableRefRequest,
    ): Promise<IPCResult<ShareablePluginRef | null>> => {
      try {
        const enableRef = request?.enableRef;
        if (
          !enableRef ||
          (enableRef.kind !== 'skill' && enableRef.kind !== 'plugin')
        )
          throw new Error('Plugin selection is invalid.');
        const catalog = await loadShareablePluginCatalog();
        if (enableRef.kind === 'skill') {
          const skill = catalog.skills.find(
            (candidate) =>
              candidate.sourceId === enableRef.sourceId &&
              candidate.name === enableRef.skillName,
          );
          return {
            success: true,
            data: skill?.shareableSource
              ? {
                  type: 'skill',
                  source: skill.shareableSource,
                  skill_name: skill.name,
                }
              : null,
          };
        }
        const marketplace = catalog.marketplaces.find(
          (candidate) => candidate.id === enableRef.marketplaceId,
        );
        const plugin = marketplace?.plugins.find(
          (candidate) => candidate.name === enableRef.pluginName,
        );
        const portable =
          marketplace && plugin
            ? computePluginShareableRef(plugin, marketplace)
            : undefined;
        return { success: true, data: portable ?? null };
      } catch (error) {
        return { success: false, error: toErrorMessage(error) };
      }
    },
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.RESOLVE_PORTABLE_REFS,
    async (
      _event,
      request: ResolvePortablePluginRefsRequest,
    ): Promise<IPCResult<ResolvePortablePluginRefsResponse>> => {
      try {
        if (
          !request ||
          !Array.isArray(request.refs) ||
          !request.refs.every(isShareablePluginRef)
        ) {
          throw new Error('Portable plugin references are invalid.');
        }
        const matches = resolveShareablePluginRefs(
          request.refs,
          await loadShareablePluginCatalog(),
          { providerType: request.providerType },
        );
        const selections: ResolvePortablePluginRefsResponse['selections'] = {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        };
        const unresolved: ResolvePortablePluginRefsResponse['unresolved'] = [];
        for (const match of matches) {
          if (match.matchState === 'unmatched') {
            unresolved.push({
              ref: match.ref,
              displayName: match.displayName,
              displaySource: match.displaySource,
            });
          } else if (match.selection.kind === 'skill') {
            selections.skillRefs.push({
              sourceId: match.selection.sourceId,
              skillName: match.selection.skillName,
            });
          } else {
            selections.pluginRefs.push({
              marketplaceId: match.selection.marketplaceId,
              pluginName: match.selection.pluginName,
            });
          }
        }
        return { success: true, data: { selections, unresolved } };
      } catch (error) {
        return { success: false, error: toErrorMessage(error) };
      }
    },
  );
  const progressFor = (
    event: IpcMainInvokeEvent,
  ): ((progress: MarketplaceOperationProgress) => void) => {
    return (progress) => {
      sendToWebContents(
        event.sender,
        PLUGINS_CHANNELS.OPERATION_PROGRESS,
        progress,
      );
    };
  };

  registerIpcHandler(PLUGINS_CHANNELS.LOAD, (event) =>
    service.loadMarketplacesForPresentation(progressFor(event)),
  );
  registerIpcHandler(PLUGINS_CHANNELS.LOAD_CACHE_ONLY, () =>
    service.loadMarketplacesForPresentation(undefined, true),
  );
  // `providerUpdates` is caller-supplied rather than pinned to 'always'.
  // This channel has several renderer callers and not all are user gestures -
  // `PipelineTriggerModal` refreshes catalogs on the window `focus` event, so
  // pinning 'always' here made every alt-tab force a full provider recheck and
  // bypass the 24h TTL entirely. Deliberate gestures (Refresh button, the
  // invalid-marketplace Retry) opt in explicitly; everything else inherits the
  // TTL-respecting default.
  registerIpcHandler(
    PLUGINS_CHANNELS.REFRESH,
    (event, providerUpdates?: 'always' | 'if-stale') =>
      refreshMarketplacesForCaller(providerUpdates, progressFor(event)),
  );
  registerIpcHandler(PLUGINS_CHANNELS.ADD, (event, repo: string) =>
    addMarketplaceForCaller(repo, progressFor(event)),
  );
  registerIpcHandler(PLUGINS_CHANNELS.UPDATE, (event, id: string) =>
    refreshAfterSuccess('plugins:updateMarketplace', () =>
      service.updateMarketplace(id, progressFor(event)),
    ),
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.REMOVE,
    (event, payload: { id: string; providers?: PluginProvider[] }) => {
      const id = payload?.id ?? '';
      return refreshAfterSuccess('plugins:removeMarketplace', () =>
        service.removeMarketplace(
          id,
          { providers: payload?.providers },
          progressFor(event),
        ),
      );
    },
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.READ_COMPONENT,
    (
      _event,
      installLocation: string,
      pluginSourcePath: string,
      componentFile: string,
    ) =>
      service.readComponentContent(
        installLocation,
        pluginSourcePath,
        componentFile,
      ),
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.INSTALL_PLUGIN,
    (event, marketplaceId: string, pluginName: string, sourceUrl: string) =>
      installPluginForCaller({
        remote: resolveRemoteBridgeSender(event.sender) !== null,
        marketplaceId,
        pluginName,
        sourceUrl,
      }),
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.PREPARE_CODEX_COMPATIBILITY,
    (_event, marketplaceId: string, pluginName: string) =>
      refreshAfterSuccess('plugins:prepare-codex-compatibility', () =>
        service.prepareCodexCompatibilityPlugin(marketplaceId, pluginName),
      ),
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.SET_CODEX_COMPAT_DISABLED,
    (_event, marketplaceId: string, pluginName: string, disabled: boolean) =>
      refreshAfterSuccess('plugins:set-codex-compat-disabled', () =>
        service.setCodexCompatDisabled(marketplaceId, pluginName, disabled),
      ),
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN,
    (event, request: InstallBuiltInPluginRequest) =>
      installBuiltInPluginForCaller(request, progressFor(event)),
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.SHARED_LIST,
    async (
      _event,
      request?: ListSharedPluginsRequest,
    ): Promise<IPCResult<ListSharedPluginsResponse>> => {
      try {
        await assertSharedPluginsSupported();
        return {
          success: true,
          data: {
            serverId: CANOPY_CLOUD_SERVER_ID,
            data: await listSharedPlugins(request),
          },
        };
      } catch (error) {
        return { success: false, error: toErrorMessage(error) };
      }
    },
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.SHARED_GET,
    async (
      _event,
      request: SharedPluginGetRequest,
    ): Promise<IPCResult<SharedPluginDetail>> => {
      try {
        validateId(request.remoteId, 'remoteId');
        await assertSharedPluginsSupported();
        return {
          success: true,
          data: await getSharedPlugin(request.remoteId),
        };
      } catch (error) {
        return { success: false, error: toErrorMessage(error) };
      }
    },
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.SHARED_CREATE,
    async (
      _event,
      request: SharedPluginCreateRequest,
    ): Promise<IPCResult<SharedPluginDetail>> => {
      const outcome = await runClassifiedShare(async () => {
        await withShareStage('access', assertSharedPluginsSupported);
        return createSharedPlugin(request);
      });
      return outcome.ok
        ? { success: true, data: outcome.value }
        : {
            success: false,
            error: toErrorMessage(outcome.error),
            failure: outcome.failure,
          };
    },
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.SHARED_UPDATE,
    async (
      _event,
      request: SharedPluginUpdateRequest,
    ): Promise<IPCResult<SharedPluginDetail>> => {
      const outcome = await runClassifiedShare(async () => {
        await withShareStage('access', async () => {
          validateId(request.remoteId, 'remoteId');
          await assertSharedPluginsSupported();
        });
        return updateSharedPlugin(request);
      });
      return outcome.ok
        ? { success: true, data: outcome.value }
        : {
            success: false,
            error: toErrorMessage(outcome.error),
            failure: outcome.failure,
          };
    },
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.SHARED_DELETE,
    async (_event, request: SharedPluginDeleteRequest): Promise<IPCResult> => {
      try {
        validateId(request.remoteId, 'remoteId');
        await assertSharedPluginsSupported();
        await deleteSharedPlugin(request.remoteId);
        return { success: true };
      } catch (error) {
        return { success: false, error: toErrorMessage(error) };
      }
    },
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.SHARED_PUBLIC_PUBLISH,
    async (
      _event,
      remoteId: string,
    ): Promise<IPCResult<SharedPluginPublicShareInfo>> => {
      try {
        validateId(remoteId, 'remoteId');
        await assertSharedPluginsSupported();
        return {
          success: true,
          data: await publishPluginPublicShare(remoteId),
        };
      } catch (error) {
        return { success: false, error: toErrorMessage(error) };
      }
    },
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.SHARED_PUBLIC_REVOKE,
    async (_event, remoteId: string): Promise<IPCResult> => {
      try {
        validateId(remoteId, 'remoteId');
        await assertSharedPluginsSupported();
        await revokePluginPublicShare(remoteId);
        return { success: true };
      } catch (error) {
        return { success: false, error: toErrorMessage(error) };
      }
    },
  );
}
