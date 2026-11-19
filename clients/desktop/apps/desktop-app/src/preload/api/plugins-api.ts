import type { IpcRendererEvent } from 'electron';
import { ipcRenderer } from '../ipc-router';
import { PLUGINS_CHANNELS } from '@canopy/desktop-shared/constants/plugin-channels';
import type { ItemHarnessInstalls } from '@canopy/protocol/plugins';
import type {
  InstallBuiltInPluginRequest,
  MarketplaceOperationProgress,
  PluginsAPI,
  RemoveMarketplaceOptions,
} from '@canopy/execution-engine/types/plugins';

export type { PluginsAPI };

export function createPluginsAPI(): PluginsAPI {
  return {
    analyzeSharedReference: (request) =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.SHARED_REFERENCE_ANALYZE, request),
    resolvePortableRefs: (request) =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.RESOLVE_PORTABLE_REFS, request),
    resolvePortableEnableRef: (request) =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.RESOLVE_PORTABLE_ENABLE_REF, request),
    loadMarketplaces: () => ipcRenderer.invoke(PLUGINS_CHANNELS.LOAD),
    loadMarketplacesCacheOnly: () =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.LOAD_CACHE_ONLY),
    refreshMarketplaces: (providerUpdates?: 'always' | 'if-stale') =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.REFRESH, providerUpdates),
    addMarketplace: (repo: string) =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.ADD, repo),
    updateMarketplace: (id: string) =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.UPDATE, id),
    removeMarketplace: (id: string, options?: RemoveMarketplaceOptions) =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.REMOVE, { id, ...(options ?? {}) }),
    readComponentContent: (
      installLocation: string,
      pluginSourcePath: string,
      componentFile: string,
    ) =>
      ipcRenderer.invoke(
        PLUGINS_CHANNELS.READ_COMPONENT,
        installLocation,
        pluginSourcePath,
        componentFile,
      ),
    previewManifest: (marketplaceId: string, pluginName: string) =>
      ipcRenderer.invoke(
        PLUGINS_CHANNELS.PREVIEW_MANIFEST,
        marketplaceId,
        pluginName,
      ),
    installPlugin: (
      marketplaceId: string,
      pluginName: string,
      sourceUrl: string,
    ) =>
      ipcRenderer.invoke(
        PLUGINS_CHANNELS.INSTALL_PLUGIN,
        marketplaceId,
        pluginName,
        sourceUrl,
      ),
    prepareCodexCompatibilityPlugin: (
      marketplaceId: string,
      pluginName: string,
    ) =>
      ipcRenderer.invoke(
        PLUGINS_CHANNELS.PREPARE_CODEX_COMPATIBILITY,
        marketplaceId,
        pluginName,
      ),
    setCodexCompatDisabled: (
      marketplaceId: string,
      pluginName: string,
      disabled: boolean,
    ) =>
      ipcRenderer.invoke(
        PLUGINS_CHANNELS.SET_CODEX_COMPAT_DISABLED,
        marketplaceId,
        pluginName,
        disabled,
      ),
    installBuiltInPlugin: (request: InstallBuiltInPluginRequest) =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN, request),
    installForHarnesses: (request): Promise<ItemHarnessInstalls | null> =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.INSTALL_FOR_HARNESSES, request),
    retryHarnessInstall: (request): Promise<ItemHarnessInstalls> =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.RETRY_HARNESS_INSTALL, request),
    listShared: (request) =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.SHARED_LIST, request),
    getShared: (request) =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.SHARED_GET, request),
    createShared: (request) =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.SHARED_CREATE, request),
    updateShared: (request) =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.SHARED_UPDATE, request),
    deleteShared: (request) =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.SHARED_DELETE, request),
    publishPublicShare: (remoteId) =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.SHARED_PUBLIC_PUBLISH, remoteId),
    revokePublicShare: (remoteId) =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.SHARED_PUBLIC_REVOKE, remoteId),
    onMarketplaceOperationProgress: (callback): (() => void) => {
      const handler = (_event: IpcRendererEvent, payload: unknown): void => {
        callback(payload as MarketplaceOperationProgress);
      };
      ipcRenderer.on(PLUGINS_CHANNELS.OPERATION_PROGRESS, handler);
      return () => {
        ipcRenderer.removeListener(
          PLUGINS_CHANNELS.OPERATION_PROGRESS,
          handler,
        );
      };
    },
  };
}
