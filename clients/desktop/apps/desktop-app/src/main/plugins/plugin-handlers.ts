import {
  runClassifiedShare,
  withShareStage,
} from '../sharing/share-operation-result';
import { PLUGINS_CHANNELS } from '@canopy/desktop-shared/constants/plugin-channels';
import { PluginInstallRefreshTokenSchema } from '@canopy/protocol/remote-control';
import { pluginCompanionsFromCatalog } from './plugin-companions';
import { isCustomizeDiscoveryEnabledInMain } from '../lib/customize-discovery-enabled';
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
import {
  ITEM_INSTALL_HARNESSES,
  harnessInstallItemKey,
  isItemInstallHarness,
  parseHarnessInstallItemRef,
  parseItemHarnessCompanions,
  parsePluginStandInCandidate,
  pluginNeedsInstall,
  type HarnessCompatibilityHarness,
  type HarnessInstallItemRef,
  type InstallItemForHarnessesRequest,
  type ItemHarnessCompanion,
  type ItemHarnessInstalls,
  type MarketplaceInfo,
  type PluginInfo,
  type RetryItemHarnessInstallRequest,
  type PluginManifestPreviewResult,
} from '@canopy/protocol/plugins';
import {
  installItemForHarnesses,
  itemUninstallGeneration,
  retryItemHarnessInstall,
  withPluginHarnessInstalls,
} from './harness-installs';
import {
  itemHarnessInstallDeps,
  itemHarnessInstallStore,
  resyncHarnessInstallsAfterUpdate,
  beginCompanionInstall,
  companionInstallInFlight,
  companionRemovalPending,
  directPluginAddGeneration,
  endCompanionInstall,
  noteCompanionClaim,
  releasePluginCompanionLinks,
  snapshotCompanionOwnership,
  servedPluginHarnessInstalls,
  uninstallItemCompanions,
} from './harness-install-runtime';
import * as service from './plugin-service';
import {
  installPluginForPrincipal,
  storedPluginSourceUrl,
} from './remote-install-source-gate';
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

/** A catalog's marketplace or plugin name: a short, non-empty string. */
function isCatalogName(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim() !== '' && value.length <= 256
  );
}

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
 * the same way. Catalog effects/publications also schedule settled invalidation
 * in plugin-service, independently of this success-only compatibility hook.
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
  if (result.success)
    await releasePluginCompanionLinks({
      kind: 'plugin',
      marketplaceId: request.marketplaceId,
      pluginName: request.pluginName,
    });
  if (result.success) {
    reportCuratedPluginInstallBestEffort(
      request.marketplaceId,
      request.pluginName,
    );
  }
  return result;
}

/** A plugin's source as this computer's marketplace cache records it. */
async function cachedPluginSource(
  marketplaceId: string,
  pluginName: string,
): Promise<string | undefined> {
  const { data } = await service.loadMarketplacesForPresentation(
    undefined,
    true,
  );
  const plugin = data?.marketplaces
    .find((marketplace) => marketplace.id === marketplaceId)
    ?.plugins.find((entry) => entry.name === pluginName);
  return plugin === undefined ? undefined : storedPluginSourceUrl(plugin);
}

export async function installPluginForCaller(
  request: {
    marketplaceId: string;
    pluginName: string;
    sourceUrl: string;
    remote: boolean;
  },
  /** A native copy another item's Add brings along, not the user's own. */
  options: { readonly asCompanion?: boolean } = {},
): Promise<Awaited<ReturnType<typeof service.installPlugin>>> {
  const result = await refreshAfterSuccess('plugins:install-plugin', () =>
    installPluginForPrincipal(
      request,
      service.installPlugin,
      cachedPluginSource,
    ),
  );
  // Installed on its own, the plugin is the user's: no item that brought it
  // along as a copy removes it any more.
  if (result.success && options.asCompanion !== true)
    await releasePluginCompanionLinks({
      kind: 'plugin',
      marketplaceId: request.marketplaceId,
      pluginName: request.pluginName,
    });
  // Installing an installed plugin again is its update (CAN-6817).
  if (result.success)
    await resyncHarnessInstallsAfterUpdate({
      plugins: {
        marketplaceId: request.marketplaceId,
        name: request.pluginName,
      },
    });
  return result;
}

export async function refreshMarketplacesForCaller(
  providerUpdates: 'always' | 'if-stale' | undefined,
  progress?: MarketplaceProgress,
): Promise<Awaited<ReturnType<typeof service.refreshMarketplaces>>> {
  const result = await refreshAfterSuccess('plugins:refreshMarketplaces', () =>
    service.refreshMarketplaces(progress, {
      providerUpdates: providerUpdates === 'always' ? 'always' : 'if-stale',
    }),
  );
  // A refresh the user asked for updates every marketplace (CAN-6817).
  if (result.success && providerUpdates === 'always')
    await resyncHarnessInstallsAfterUpdate({ plugins: {} });
  return result;
}

/** A marketplace update, for the window and App Advisor alike. */
export async function updateMarketplaceForCaller(
  id: string,
  progress?: MarketplaceProgress,
): Promise<Awaited<ReturnType<typeof service.updateMarketplace>>> {
  const result = await refreshAfterSuccess('plugins:updateMarketplace', () =>
    service.updateMarketplace(id, progress),
  );
  // Every harness copy of its plugins is rebuilt from the update (CAN-6817).
  if (result.success)
    await resyncHarnessInstallsAfterUpdate({ plugins: { marketplaceId: id } });
  return result;
}

/** Adds the CAN-6816 records to rows served to a window; never persisted. */
async function withServedHarnessInstalls<
  T extends { success: boolean; data?: { marketplaces: MarketplaceInfo[] } },
>(result: T): Promise<T> {
  if (!result.success || result.data === undefined) return result;
  const records = await itemHarnessInstallStore
    .read()
    .catch((): Record<string, never> => ({}));
  return {
    ...result,
    data: withPluginHarnessInstalls(
      result.data,
      await servedPluginHarnessInstalls(records, result.data.marketplaces),
    ),
  };
}

/**
 * Adds the CAN-6816 record to one plugin row a handler answers with, so a
 * window that replaces its row with this one keeps the record. Never
 * persisted.
 */
async function withServedPluginHarnessInstalls<
  T extends { success: boolean; data?: PluginInfo },
>(result: T): Promise<T> {
  const plugin = result.data;
  if (!result.success || plugin === undefined) return result;
  const records = await itemHarnessInstallStore
    .read()
    .catch((): Record<string, never> => ({}));
  const key = harnessInstallItemKey({
    kind: 'plugin',
    marketplaceId: plugin.marketplaceId,
    pluginName: plugin.name,
  });
  const record = Object.prototype.hasOwnProperty.call(records, key)
    ? records[key]
    : undefined;
  if (record === undefined) return result;
  const served =
    (await servedPluginRecord(key, record, plugin.marketplaceId)) ?? record;
  return { ...result, data: { ...plugin, harnessInstalls: served } };
}

/** One plugin's record with outside changes flagged (CAN-6817). */
async function servedPluginRecord(
  key: string,
  record: ItemHarnessInstalls,
  marketplaceId: string,
): Promise<ItemHarnessInstalls | undefined> {
  const cache = await service.loadMarketplacesCacheOnly();
  const marketplace = cache.success
    ? cache.data?.marketplaces.find((entry) => entry.id === marketplaceId)
    : undefined;
  if (marketplace === undefined) return undefined;
  return (await servedPluginHarnessInstalls({ [key]: record }, [marketplace]))[
    key
  ];
}

function parseHarnessList(value: unknown): HarnessCompatibilityHarness[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ITEM_INSTALL_HARNESSES.length)
    throw new Error('Invalid harness list.');
  if (!value.every(isItemInstallHarness)) throw new Error('Unknown harness.');
  return value;
}

function parseItemRef(value: unknown): HarnessInstallItemRef {
  const item = parseHarnessInstallItemRef(value);
  // The record key and the cache lookup are the only uses; a skill folder
  // is resolved inside the skills root.
  if (item === undefined) throw new Error('Invalid plugin or skill.');
  return item;
}

function parseInstallForHarnessesRequest(
  value: unknown,
): InstallItemForHarnessesRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid install request.');
  const request: Record<string, unknown> = { ...value };
  const pendingHarnesses = parseHarnessList(request.pendingHarnesses);
  if (
    request.mode !== undefined &&
    request.mode !== 'add' &&
    request.mode !== 'catch-up'
  )
    throw new Error('Invalid install mode.');
  const item = parseItemRef(request.item);
  // The publisher's MCP server for a plugin's ChatGPT app (CAN-6818). Main
  // installs it only when the catalog lists that endpoint.
  const standIn =
    request.standIn === undefined
      ? undefined
      : parsePluginStandInCandidate(request.standIn);
  if (request.standIn !== undefined && standIn === undefined)
    throw new Error('Invalid stand-in MCP server.');
  if (standIn !== undefined && item.kind !== 'plugin')
    throw new Error('Only a plugin has a stand-in MCP server.');
  // Native copies of the same integration for harnesses this item can't
  // serve (Sergii's QA). Only a plugin brings them, never itself.
  const companions =
    item.kind === 'plugin'
      ? parseItemHarnessCompanions(request.companions).filter(
          (companion) =>
            harnessInstallItemKey(companion.item) !==
            harnessInstallItemKey(item),
        )
      : [];
  return {
    item,
    harnesses: parseHarnessList(request.harnesses),
    ...(pendingHarnesses.length > 0 ? { pendingHarnesses } : {}),
    ...(request.mode !== undefined ? { mode: request.mode } : {}),
    ...(standIn !== undefined ? { standIn } : {}),
    ...(companions.length > 0 ? { companions } : {}),
  };
}

/**
 * The plugins this Add must leave alone (every plugin already installed
 * that no item brought along as a copy), this item's linked copies, and
 * every item's copies (shared, so this item links them too). A copy the user
 * installed themselves is never linked, so removing the item never removes
 * it. Undefined when the installed list can't be read; then no copy is
 * added.
 */
async function companionInstallState(
  item: HarnessInstallItemRef,
): Promise<
  | { independent: Set<string>; linked: Set<string>; managed: Set<string> }
  | undefined
> {
  try {
    const { installedItemService } =
      await import('../installed-items/installed-item-service');
    const [snapshot, records] = await Promise.all([
      installedItemService.listStatus(),
      itemHarnessInstallStore.read(),
    ]);
    const linked = new Set(
      (records[harnessInstallItemKey(item)]?.companions ?? []).map((entry) =>
        harnessInstallItemKey(entry.item),
      ),
    );
    // Copies any item brought along: another item's copy is shared, not the
    // user's own, so this item links it too.
    const managed = new Set(
      Object.values(records).flatMap((record) =>
        (record.companions ?? []).map((entry) =>
          harnessInstallItemKey(entry.item),
        ),
      ),
    );
    const installed = [
      ...snapshot.items.flatMap((entry) =>
        entry.target.kind === 'plugin'
          ? [
              harnessInstallItemKey({
                kind: 'plugin',
                marketplaceId: entry.target.marketplaceId,
                pluginName: entry.target.pluginName,
              }),
            ]
          : [],
      ),
      ...Object.keys(records),
    ];
    // A copy whose removal is still queued is claimed again, not taken for
    // the user's own.
    return {
      independent: new Set(
        installed.filter(
          (key) =>
            !managed.has(key) &&
            !companionInstallInFlight(key) &&
            !companionRemovalPending(key),
        ),
      ),
      linked,
      managed,
    };
  } catch {
    return undefined;
  }
}

/**
 * Installs each companion copy for its harnesses, the way one Add installs
 * any plugin, and links the ones that landed on the item's record so they
 * show on its Works with rows and go when it is uninstalled. A copy already
 * installed on its own is left as it is, and a companion that fails leaves
 * the item's own install as it is.
 */
async function installCompanions(
  item: HarnessInstallItemRef,
  request: InstallItemForHarnessesRequest,
  remote: boolean,
): Promise<ItemHarnessInstalls | undefined> {
  const inFlight: string[] = [];
  try {
    return await installAndLinkCompanions(item, request, remote, inFlight);
  } finally {
    for (const key of inFlight) endCompanionInstall(key);
  }
}

async function installAndLinkCompanions(
  item: HarnessInstallItemRef,
  request: InstallItemForHarnessesRequest,
  remote: boolean,
  /** The copies this Add marked in flight; the caller ends them. */
  inFlight: string[],
): Promise<ItemHarnessInstalls | undefined> {
  // A copy this Add removes again stops being in flight first: a queued
  // removal leaves in-flight copies to the Add adopting them.
  const releaseInFlight = (copies: readonly ItemHarnessCompanion[]): void => {
    for (const copy of copies) {
      const index = inFlight.indexOf(harnessInstallItemKey(copy.item));
      if (index === -1) continue;
      endCompanionInstall(inFlight[index] ?? '');
      inFlight.splice(index, 1);
    }
  };
  const companions = request.companions ?? [];
  if (companions.length === 0) return undefined;
  const itemKey = harnessInstallItemKey(item);
  // An uninstall of the item while its copies install removes the copies
  // this Add brought instead of leaving them behind unlinked.
  const generation = itemUninstallGeneration(itemKey);
  const directAdds = new Map(
    companions.map((companion) => {
      const key = harnessInstallItemKey(companion.item);
      return [key, directPluginAddGeneration(key)];
    }),
  );
  const addedOnItsOwn = (companion: ItemHarnessCompanion): boolean => {
    const key = harnessInstallItemKey(companion.item);
    return directPluginAddGeneration(key) !== directAdds.get(key);
  };
  const state = await companionInstallState(item);
  if (state === undefined) return undefined;
  const linked: ItemHarnessCompanion[] = [];
  for (const companion of companions) {
    if (itemUninstallGeneration(itemKey) !== generation) break;
    if (state.independent.has(harnessInstallItemKey(companion.item))) continue;
    // A removal queued before now leaves the copy this Add relies on, and
    // until the link lands another Add counts it as an item's copy.
    noteCompanionClaim(harnessInstallItemKey(companion.item));
    beginCompanionInstall(harnessInstallItemKey(companion.item));
    inFlight.push(harnessInstallItemKey(companion.item));
    // Whether this Add fetched the copy or wrote its record: a copy it
    // brought that serves none of its harnesses goes again, so it never
    // stays behind unowned and a later Add can retry it.
    let touched = false;
    let served = false;
    try {
      // Installed the way Add installs any plugin, through the same source
      // gate, then recorded for its harnesses.
      const cache = await service.loadMarketplacesCacheOnly();
      const listed = cache.success
        ? cache.data?.marketplaces
            .find((entry) => entry.id === companion.item.marketplaceId)
            ?.plugins.find(
              (entry) =>
                entry.name.toLowerCase() ===
                companion.item.pluginName.toLowerCase(),
            )
        : undefined;
      if (listed === undefined) continue;
      // A marketplace plugin's content is already local; only an external
      // listing that hasn't been fetched yet is cloned first, the way its
      // plugin page installs it.
      if (pluginNeedsInstall(listed)) {
        const added = await installPluginForCaller(
          {
            remote,
            marketplaceId: companion.item.marketplaceId,
            pluginName: listed.name,
            sourceUrl:
              typeof listed.externalSource === 'string'
                ? listed.externalSource
                : (listed.externalSource?.url ?? ''),
          },
          { asCompanion: true },
        );
        if (!added.success) continue;
        touched = true;
      }
      // Only the harnesses this copy serves for the item: the item itself
      // (or another copy) already covers the rest.
      const record = await installItemForHarnesses(
        { ...itemHarnessInstallDeps, confirmedSetUpHarnesses: undefined },
        {
          item: companion.item,
          harnesses: companion.harnesses,
          ...(request.mode !== undefined ? { mode: request.mode } : {}),
        },
      );
      touched ||= record !== null;
      const installed = companion.harnesses.filter(
        (harness) => record?.harnesses[harness]?.status === 'installed',
      );
      if (installed.length > 0) {
        served = true;
        linked.push({ item: companion.item, harnesses: installed });
      }
    } catch {
      // The item itself is installed; the companion row says nothing more.
    }
    if (
      touched &&
      !served &&
      !state.managed.has(harnessInstallItemKey(companion.item)) &&
      !addedOnItsOwn(companion)
    ) {
      releaseInFlight([companion]);
      uninstallItemCompanions([companion], snapshotCompanionOwnership());
    }
  }
  // A copy the user added on its own meanwhile is theirs, never linked.
  const owned = linked.filter((companion) => !addedOnItsOwn(companion));
  if (owned.length === 0) return undefined;
  const added = owned.filter(
    (companion) => !state.linked.has(harnessInstallItemKey(companion.item)),
  );
  // Joined to the copies an earlier Add linked, so adding one harness's copy
  // later never drops another's.
  // A link the disk refuses leaves the copies this Add brought unowned, so
  // they go again like an uninstall race's, and a retry starts clean.
  const record = await itemHarnessInstallStore
    .update(itemKey, (existing) => {
      if (existing === undefined) return existing;
      const merged = [...(existing.companions ?? [])];
      for (const companion of owned) {
        if (addedOnItsOwn(companion)) continue;
        const key = harnessInstallItemKey(companion.item);
        const index = merged.findIndex(
          (entry) => harnessInstallItemKey(entry.item) === key,
        );
        const current = index === -1 ? undefined : merged[index];
        if (current === undefined) merged.push(companion);
        else
          merged[index] = {
            item: companion.item,
            harnesses: [
              ...new Set([...current.harnesses, ...companion.harnesses]),
            ],
          };
      }
      return { ...existing, companions: merged };
    })
    .catch((): undefined => undefined);
  if (record === undefined || itemUninstallGeneration(itemKey) !== generation) {
    const orphaned = added.filter((companion) => !addedOnItsOwn(companion));
    if (orphaned.length > 0) {
      releaseInFlight(orphaned);
      uninstallItemCompanions(orphaned, snapshotCompanionOwnership());
    }
    return undefined;
  }
  return record;
}

/**
 * New Customize's one Add for every harness (CAN-6816), the single entry
 * every Add goes through: a plugin page, a Browse row and the Portal. It
 * records what each set-up harness loads from the item, then installs the
 * native copies (resolved here from the catalog) for the harnesses it can't
 * serve, and tells every window and the Portal that installed items changed.
 */
export async function addItemForHarnesses(
  request: InstallItemForHarnessesRequest,
  remote: boolean,
): Promise<ItemHarnessInstalls | null> {
  const own = await installItemForHarnesses(itemHarnessInstallDeps, request);
  if (own !== null && request.mode !== 'catch-up')
    await releasePluginCompanionLinks(request.item);
  let record = own;
  // Native copies are New Customize only, checked here in main: a window
  // still showing it after the experiment is turned off adds no copies.
  if (
    own !== null &&
    request.item.kind === 'plugin' &&
    (await isCustomizeDiscoveryEnabledInMain())
  ) {
    const cache = await service.loadMarketplacesCacheOnly();
    const harnesses = ITEM_INSTALL_HARNESSES.filter(
      (harness) =>
        own.harnesses[harness] !== undefined &&
        own.harnesses[harness]?.status !== 'installed',
    );
    const companions =
      cache.success && cache.data
        ? pluginCompanionsFromCatalog(
            cache.data.marketplaces,
            request.item,
            harnesses,
          )
        : [];
    record =
      (await installCompanions(
        request.item,
        { ...request, companions },
        remote,
      )) ?? own;
  }
  const { notifyInstalledItemsChanged } =
    await import('../installed-items/installed-item-events');
  notifyInstalledItemsChanged();
  return record === null ? null : servedItemRecord(request.item, record);
}

/**
 * A record an install or Try again answers with, served the way rows are
 * (outside changes and stand-ins, CAN-6817 and CAN-6818), so the window that
 * asked shows it without reloading. Never persisted.
 */
async function servedItemRecord(
  item: HarnessInstallItemRef,
  record: ItemHarnessInstalls,
): Promise<ItemHarnessInstalls> {
  if (item.kind !== 'plugin') return record;
  const served = await servedPluginRecord(
    harnessInstallItemKey(item),
    record,
    item.marketplaceId,
  ).catch((): undefined => undefined);
  return served ?? record;
}

function parseRetryHarnessInstallRequest(
  value: unknown,
): RetryItemHarnessInstallRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid retry request.');
  const request: Record<string, unknown> = { ...value };
  if (!isItemInstallHarness(request.harness))
    throw new Error('Unknown harness.');
  return { item: parseItemRef(request.item), harness: request.harness };
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

  registerIpcHandler(PLUGINS_CHANNELS.LOAD, async (event) =>
    withServedHarnessInstalls(
      await service.loadMarketplacesForPresentation(progressFor(event)),
    ),
  );
  registerIpcHandler(PLUGINS_CHANNELS.LOAD_CACHE_ONLY, async () =>
    withServedHarnessInstalls(
      await service.loadMarketplacesForPresentation(undefined, true),
    ),
  );
  // An install changes what the installed-items snapshot lists, so every
  // window rereads statuses; without it a fresh Add read "Unavailable" (not
  // in the installed list) until something else refreshed the snapshot.
  const installedItemsChanged = (): void => {
    void import('../installed-items/installed-item-events')
      .then(({ notifyInstalledItemsChanged }) => notifyInstalledItemsChanged())
      .catch(() => undefined);
  };
  // One Add for every harness, for plugins and skills (CAN-6816). The
  // renderer calls these only while the `customize-discovery` Labs
  // experiment is on. The record file and the installed items change; the
  // window that asked reloads the rows it shows, and every window rereads
  // installed-item status.
  registerIpcHandler(
    PLUGINS_CHANNELS.INSTALL_FOR_HARNESSES,
    async (event, request: unknown) =>
      addItemForHarnesses(
        parseInstallForHarnessesRequest(request),
        resolveRemoteBridgeSender(event.sender) !== null,
      ),
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.RETRY_HARNESS_INSTALL,
    async (event, request: unknown) => {
      const parsed = parseRetryHarnessInstallRequest(request);
      const record = await retryItemHarnessInstall(
        itemHarnessInstallDeps,
        parsed,
        // A remote caller can check again but never fetch a plugin's source.
        { restore: resolveRemoteBridgeSender(event.sender) === null },
      );
      installedItemsChanged();
      return servedItemRecord(parsed.item, record);
    },
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
    async (event, providerUpdates?: 'always' | 'if-stale') =>
      withServedHarnessInstalls(
        await refreshMarketplacesForCaller(providerUpdates, progressFor(event)),
      ),
  );
  registerIpcHandler(PLUGINS_CHANNELS.ADD, (event, repo: string) =>
    addMarketplaceForCaller(repo, progressFor(event)),
  );
  registerIpcHandler(PLUGINS_CHANNELS.UPDATE, (event, id: string) =>
    updateMarketplaceForCaller(id, progressFor(event)),
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
      mode?: 'catalog-checkout',
    ) =>
      service.readComponentContent(
        installLocation,
        pluginSourcePath,
        componentFile,
        mode,
      ),
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.PREVIEW_MANIFEST,
    async (
      _event,
      marketplaceId: unknown,
      pluginName: unknown,
    ): Promise<IPCResult<PluginManifestPreviewResult>> => {
      if (!isCatalogName(marketplaceId) || !isCatalogName(pluginName))
        return {
          success: false,
          error: 'A preview needs a marketplace and a plugin name.',
        };
      const { previewPluginManifest } =
        await import('./plugin-manifest-preview');
      return {
        success: true,
        data: await previewPluginManifest(marketplaceId, pluginName),
      };
    },
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.INSTALL_PLUGIN,
    async (
      event,
      marketplaceId: string,
      pluginName: string,
      sourceUrl: string,
      bridgeInstallRefreshToken?: unknown,
    ) => {
      const senderId = event.sender.id;
      const remote = resolveRemoteBridgeSender(event.sender) !== null;
      const token = remote
        ? PluginInstallRefreshTokenSchema.safeParse(bridgeInstallRefreshToken)
        : undefined;
      const result = await withServedPluginHarnessInstalls(
        await installPluginForCaller({
          remote,
          marketplaceId,
          pluginName,
          sourceUrl,
        }),
      );
      // Remote Add needs a snapshot refresh, not a chat defaults invalidation.
      if (remote && result.success) {
        void import('../installed-items/installed-item-events')
          .then(({ notifyInstalledItemSnapshotChanged }) =>
            notifyInstalledItemSnapshotChanged(
              token?.success
                ? { senderId, installRefreshToken: token.data }
                : undefined,
            ),
          )
          .catch(() => undefined);
      }
      return result;
    },
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.PREPARE_CODEX_COMPATIBILITY,
    async (_event, marketplaceId: string, pluginName: string) =>
      withServedPluginHarnessInstalls(
        await refreshAfterSuccess('plugins:prepare-codex-compatibility', () =>
          service.prepareCodexCompatibilityPlugin(marketplaceId, pluginName),
        ),
      ),
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.SET_CODEX_COMPAT_DISABLED,
    async (
      _event,
      marketplaceId: string,
      pluginName: string,
      disabled: boolean,
    ) =>
      withServedPluginHarnessInstalls(
        await refreshAfterSuccess('plugins:set-codex-compat-disabled', () =>
          service.setCodexCompatDisabled(marketplaceId, pluginName, disabled),
        ),
      ),
  );
  registerIpcHandler(
    PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN,
    async (event, request: InstallBuiltInPluginRequest) => {
      const result = await installBuiltInPluginForCaller(
        request,
        progressFor(event),
      );
      if (result.data === undefined) return result;
      const served = await withServedPluginHarnessInstalls({
        success: true,
        data: result.data.plugin,
      });
      return served.data === undefined
        ? result
        : { ...result, data: { ...result.data, plugin: served.data } };
    },
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
