import {
  CatalogHostRefusedError,
  type CatalogPluginTarget,
  type CoreCatalogHost,
} from '@canopy/core-runtime/node/catalog';
import { pluginEntryId } from '@canopy/protocol/canopy-core';
import { parseGitHubRepo } from '@canopy/desktop-shared/lib/github-repo';
import type { IPCResult } from '@canopy/execution-engine/types/pipeline';
import type {
  MarketplaceInfo,
  PluginInfo,
  PluginsCache,
} from '@canopy/execution-engine/types/plugins';
import type { PortalMarketplaceMutationResult } from '@canopy/protocol/portal';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import type * as CloudMarketplaces from '../canopy-cloud/plugin-marketplaces';
import { UnsafeExternalPluginUrlError } from '../plugins/external-plugin-url';
import type * as PluginHandlers from '../plugins/plugin-handlers';
import type * as PluginService from '../plugins/plugin-service';
import type * as PluginCatalogService from '../services/plugin-catalog-service';
import { offerCatalogPortalResult } from './catalog-portal-results';

/** What the mutation host calls; tests inject fakes. Defaults load lazily. */
export interface DesktopCatalogMutationDeps {
  service: Pick<
    typeof PluginService,
    | 'loadMarketplacesCacheOnly'
    | 'removeMarketplace'
    | 'refreshMarketplaces'
    | 'updateMarketplace'
  >;
  handlers: Pick<typeof PluginHandlers, 'refreshAfterSuccess'>;
  portal: Pick<
    typeof PluginCatalogService,
    | 'addPortalMarketplace'
    | 'installPortalBuiltInPluginWithOutcomes'
    | 'installPortalExternalPlugin'
  >;
  runSerialized: <T>(operation: () => Promise<T>) => Promise<T>;
  cloud: Pick<
    typeof CloudMarketplaces,
    'addCloudPluginMarketplace' | 'confirmCloudPluginMarketplace'
  >;
}

const defaultDeps: DesktopCatalogMutationDeps = {
  service: {
    loadMarketplacesCacheOnly: async () =>
      (await import('../plugins/plugin-service')).loadMarketplacesCacheOnly(),
    removeMarketplace: async (marketplaceId, options) =>
      (await import('../plugins/plugin-service')).removeMarketplace(
        marketplaceId,
        options,
      ),
    refreshMarketplaces: async (progress, options) =>
      (await import('../plugins/plugin-service')).refreshMarketplaces(
        progress,
        options,
      ),
    updateMarketplace: async (marketplaceId) =>
      (await import('../plugins/plugin-service')).updateMarketplace(
        marketplaceId,
      ),
  },
  handlers: {
    refreshAfterSuccess: async (reason, operation) =>
      (await import('../plugins/plugin-handlers')).refreshAfterSuccess(
        reason,
        operation,
      ),
  },
  portal: {
    addPortalMarketplace: async (repo) =>
      (await import('../services/plugin-catalog-service')).addPortalMarketplace(
        repo,
      ),
    installPortalBuiltInPluginWithOutcomes: async (
      marketplaceId,
      pluginName,
      providers,
    ) =>
      (
        await import('../services/plugin-catalog-service')
      ).installPortalBuiltInPluginWithOutcomes(
        marketplaceId,
        pluginName,
        providers,
      ),
    installPortalExternalPlugin: async (marketplaceId, pluginName) =>
      (
        await import('../services/plugin-catalog-service')
      ).installPortalExternalPlugin(marketplaceId, pluginName),
  },
  cloud: {
    addCloudPluginMarketplace: async (source) =>
      (
        await import('../canopy-cloud/plugin-marketplaces')
      ).addCloudPluginMarketplace(source),
    confirmCloudPluginMarketplace: async (marketplaceId, expectedRevision) =>
      (
        await import('../canopy-cloud/plugin-marketplaces')
      ).confirmCloudPluginMarketplace(marketplaceId, expectedRevision),
  },
  runSerialized: async (operation) =>
    (
      await import('../plugins/plugin-mutation-queue')
    ).runSerializedPluginMutation(operation),
};

const runningRefreshes = new Map<string, string>();

/** Source ids with a running refresh, by operation id (read by listSources). */
export function runningCatalogRefresh(sourceId: string): string | null {
  return runningRefreshes.get(sourceId) ?? null;
}

const MARKETPLACE_NOT_FOUND = /^Marketplace ".*" not found\.$/;
const UNINSTALL_PENDING =
  'Finish uninstalling this plugin before adding it again.';

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

interface RefreshSorting {
  refreshed: string[];
  failed: string[];
}

function hasValidProvider(marketplace: MarketplaceInfo): boolean {
  return marketplace.validProviders.length > 0;
}

function installTarget(
  marketplace: MarketplaceInfo,
  plugin: PluginInfo,
): CatalogPluginTarget['install'] {
  if (marketplace.builtIn === true || marketplace.curated === true)
    return 'managed';
  return (plugin.externalSource?.url ??
    plugin.facets.claude?.externalSource?.url)
    ? 'external'
    : 'none';
}

/** The catalog host with the marketplace and install effects (CAN-4123 PR4) over the Portal mutation functions. */
export function createDesktopCatalogMutationHost(
  base: CoreCatalogHost,
  overrides: Partial<DesktopCatalogMutationDeps> = {},
): CoreCatalogHost {
  const deps: DesktopCatalogMutationDeps = { ...defaultDeps, ...overrides };

  const settle = <T>(
    operation: () => Promise<IPCResult<T>>,
  ): Promise<IPCResult<T>> =>
    deps.runSerialized(() =>
      deps.handlers.refreshAfterSuccess(
        'core.catalog.source.refresh',
        operation,
      ),
    );
  const sort = (
    ids: readonly string[],
    result: IPCResult<PluginsCache>,
    into: RefreshSorting,
  ): void => {
    const rows = result.success ? (result.data?.marketplaces ?? []) : [];
    for (const id of ids) {
      const row = rows.find((marketplace) => marketplace.id === id);
      (row && hasValidProvider(row) ? into.refreshed : into.failed).push(id);
    }
  };

  const findCachedPlugin = async (
    entryId: string,
  ): Promise<CatalogPluginTarget | null> => {
    const cache = await deps.service.loadMarketplacesCacheOnly();
    if (!cache.success || !cache.data) return null;
    for (const marketplace of cache.data.marketplaces) {
      const prefix = pluginEntryId({
        marketplaceId: marketplace.id,
        pluginName: '',
      });
      if (!entryId.startsWith(prefix)) continue;
      // Today's Portal lookup: an exact name, else one case-insensitive match.
      const name = entryId.slice(prefix.length);
      const exact = marketplace.plugins.filter(
        (plugin) => plugin.name === name,
      );
      const matches =
        exact.length > 0
          ? exact
          : marketplace.plugins.filter(
              (plugin) => plugin.name.toLowerCase() === name.toLowerCase(),
            );
      const plugin = matches.length === 1 ? matches[0] : undefined;
      if (plugin)
        return {
          entryId: pluginEntryId({
            marketplaceId: marketplace.id,
            pluginName: plugin.name,
          }),
          marketplaceId: marketplace.id,
          pluginName: plugin.name,
          install: installTarget(marketplace, plugin),
        };
    }
    return null;
  };

  const isUnlistedCachedRow = async (sourceId: string): Promise<boolean> => {
    const cache = await deps.service.loadMarketplacesCacheOnly();
    const row = cache.success
      ? cache.data?.marketplaces.find(
          (marketplace) => marketplace.id === sourceId,
        )
      : undefined;
    return row !== undefined && row.builtIn !== true && row.curated !== true;
  };

  return {
    snapshot: () => base.snapshot(),
    readSelection: (scope) => base.readSelection(scope),
    replaceGlobalSelection: (expectedRevision, refs) =>
      base.replaceGlobalSelection(expectedRevision, refs),
    replaceWorkspaceSelection: (request) =>
      base.replaceWorkspaceSelection(request),
    listSources: () => base.listSources(),
    addGitSource: async (repository) => {
      if (parseGitHubRepo(repository) === null)
        throw new CatalogHostRefusedError('source-invalid');
      let result: PortalMarketplaceMutationResult;
      try {
        result = await deps.portal.addPortalMarketplace(repository);
      } catch (error) {
        const code = codeOf(error);
        if (code === 'invalid_payload')
          throw new CatalogHostRefusedError('source-invalid', error);
        if (code === 'execution_failed')
          throw new CatalogHostRefusedError('source-provider-rejected', error);
        throw error;
      }
      offerCatalogPortalResult(result);
      const added = (await base.listSources()).find(
        (source) => source.sourceId === result.marketplace.id,
      );
      if (!added) throw new Error('The added source is not in the catalog.');
      return added;
    },
    deleteSource: ({ sourceId, providers, guard }) =>
      deps.runSerialized(async () => {
        const current =
          (await base.listSources()).find(
            (source) => source.sourceId === sourceId,
          ) ?? null;
        const verdict = guard(current);
        // A cached marketplace source.list leaves out (D15) is still removed by
        // id, with no revision to check.
        if (verdict === 'absent' && !(await isUnlistedCachedRow(sourceId)))
          throw new CatalogHostRefusedError('source-not-found');
        if (verdict === 'builtin')
          throw new CatalogHostRefusedError('source-builtin');
        if (verdict === 'conflict')
          throw new CatalogHostRefusedError('source-conflict');
        const removal = await deps.handlers.refreshAfterSuccess(
          'core.catalog.source.delete',
          () =>
            deps.service.removeMarketplace(sourceId, {
              providers: [...providers],
            }),
        );
        if (!removal.success || !removal.data) {
          const message = removal.success
            ? 'The marketplace could not be removed.'
            : (removal.error ?? 'The marketplace could not be removed.');
          if (MARKETPLACE_NOT_FOUND.test(message))
            throw new CatalogHostRefusedError('source-not-found');
          throw new CatalogHostRefusedError(
            'source-provider-failed',
            codedError('execution_failed', message),
          );
        }
        const outcomes = removal.data.providerOutcomes;
        const errors = providers
          .map((provider) => {
            const error = outcomes[provider].error;
            return error ? `${provider}: ${error}` : null;
          })
          .filter((entry): entry is string => entry !== null);
        if (errors.length > 0)
          throw new CatalogHostRefusedError(
            'source-provider-failed',
            codedError('execution_failed', errors.join('; ')),
          );
        const alreadyAbsent = providers.every(
          (provider) => outcomes[provider].alreadyAbsent,
        );
        offerCatalogPortalResult({
          removed: true,
          ...(alreadyAbsent ? { alreadyAbsent: true } : {}),
        });
        return {
          removedProviders: removal.data.removedProviders,
          alreadyAbsent,
        };
      }),
    refreshSources: async (plan) => {
      const ids = [...plan.updateSourceIds, ...plan.scanOnlySourceIds];
      for (const id of ids) runningRefreshes.set(id, plan.operationId);
      const outcome: RefreshSorting = { refreshed: [], failed: [] };
      try {
        if (plan.all && plan.mode === 'update_then_scan') {
          const result = await settle(() =>
            deps.service.refreshMarketplaces(undefined, {
              providerUpdates: 'always',
            }),
          );
          sort(ids, result, outcome);
        } else {
          for (const id of plan.updateSourceIds) {
            const refreshed = await deps.runSerialized(async () => {
              // A delete queued since the plan was made must not be undone by
              // updating the source again.
              const listed = (await base.listSources()).some(
                (source) => source.sourceId === id,
              );
              if (!listed) return false;
              const result = await settle(() =>
                deps.service.updateMarketplace(id),
              );
              return (
                result.success &&
                result.data !== undefined &&
                hasValidProvider(result.data)
              );
            });
            (refreshed ? outcome.refreshed : outcome.failed).push(id);
          }
          if (plan.scanOnlySourceIds.length > 0) {
            const result = await settle(() =>
              deps.service.refreshMarketplaces(undefined, {
                providerUpdates: 'if-stale',
              }),
            );
            sort(plan.scanOnlySourceIds, result, outcome);
          }
        }
      } finally {
        for (const id of ids)
          if (runningRefreshes.get(id) === plan.operationId)
            runningRefreshes.delete(id);
      }
      return outcome;
    },
    // A plugin already in the cache is found at once, so identical installs
    // still reach the Portal install's in-flight collapse together; one that is
    // missing is read again behind queued marketplace changes that may add it.
    findPlugin: async (entryId) =>
      (await findCachedPlugin(entryId)) ??
      deps.runSerialized(() => findCachedPlugin(entryId)),
    publishPlugin: async (target) => {
      const cache = await deps.service.loadMarketplacesCacheOnly();
      const marketplace = cache.success
        ? cache.data?.marketplaces.find(
            (candidate) => candidate.id === target.marketplaceId,
          )
        : undefined;
      if (marketplace === undefined)
        throw new CatalogHostRefusedError('plugin-not-found');
      // Only a public GitHub marketplace is a source the cloud can fetch.
      const repository =
        marketplace.builtIn !== true &&
        marketplace.curated !== true &&
        marketplace.sourceType === 'github'
          ? parseGitHubRepo(marketplace.sourceUrl)
          : null;
      if (repository === null)
        throw new CatalogHostRefusedError('publish-source-unsupported');
      const refusal = (error: unknown): CatalogHostRefusedError =>
        new CatalogHostRefusedError(
          error instanceof CanopyCloudClientError && error.status === 409
            ? 'publish-revision-moved'
            : error instanceof CanopyCloudClientError && error.status === 400
              ? 'publish-source-unsupported'
              : 'publish-remote-unavailable',
          error,
        );
      let added: Awaited<
        ReturnType<
          DesktopCatalogMutationDeps['cloud']['addCloudPluginMarketplace']
        >
      >;
      try {
        added = await deps.cloud.addCloudPluginMarketplace(repository);
      } catch (error) {
        throw refusal(error);
      }
      let sync = added.sync;
      if (sync.status === 'preview') {
        try {
          sync = await deps.cloud.confirmCloudPluginMarketplace(
            added.marketplaceId,
            sync.revision,
          );
        } catch (error) {
          throw refusal(error);
        }
      }
      if (sync.status !== 'applied')
        throw new CatalogHostRefusedError('publish-revision-moved');
      const pluginKey =
        sync.pluginKeys.find((key) => key === target.pluginName) ??
        sync.pluginKeys.find(
          (key) => key.toLowerCase() === target.pluginName.toLowerCase(),
        );
      if (pluginKey === undefined)
        throw new CatalogHostRefusedError('plugin-not-found');
      return {
        publicationId: added.marketplaceId,
        remoteEntryId: pluginEntryId({
          marketplaceId: `marketplace:${added.marketplaceId}`,
          pluginName: pluginKey,
        }),
        revision: sync.revision,
      };
    },
    publishSkill: async (entryId, pkg) =>
      (await import('../skills/publish-skill-to-cloud')).publishSkillToCloud(
        entryId,
        pkg,
      ),
    installPlugin: async (target, providers) => {
      let outcome: PluginCatalogService.PortalPluginInstallOutcome;
      try {
        outcome =
          target.install === 'external'
            ? {
                result: await deps.portal.installPortalExternalPlugin(
                  target.marketplaceId,
                  target.pluginName,
                ),
                installedProviders: ['claude'],
                failedProviders: [],
              }
            : await deps.portal.installPortalBuiltInPluginWithOutcomes(
                target.marketplaceId,
                target.pluginName,
                [...providers],
              );
      } catch (error) {
        const code = codeOf(error);
        if (
          error instanceof UnsafeExternalPluginUrlError ||
          (target.install === 'external' && code === 'invalid_payload')
        )
          throw new CatalogHostRefusedError('plugin-source-rejected', error);
        if (
          code === 'execution_failed' &&
          error instanceof Error &&
          error.message === UNINSTALL_PENDING
        )
          throw new CatalogHostRefusedError('plugin-uninstall-pending', error);
        throw new CatalogHostRefusedError('plugin-install-failed', error);
      }
      offerCatalogPortalResult(outcome.result);
      return {
        installed: outcome.installedProviders,
        failed: outcome.failedProviders,
      };
    },
  };
}
