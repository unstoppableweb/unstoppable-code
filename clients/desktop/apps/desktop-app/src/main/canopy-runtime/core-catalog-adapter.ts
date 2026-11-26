import {
  CatalogMutationRuns,
  createCoreCollectionEntryHandlers,
  type CoreCollectionEntryHost,
  createCoreCatalogHandlers,
  createCoreSkillCatalogHandlers,
  createCoreMcpRemovalHandlers,
  type CoreMcpRemovalHost,
  type CoreCatalogHost,
  type CoreSkillCatalogHost,
} from '@canopy/core-runtime/node/catalog';
import type { OperationServicePort } from '@canopy/core-runtime/node/operations';
import {
  createDesktopCatalogHost,
  installedCatalogRefs,
  type DesktopCatalogHostDeps,
} from './core-catalog-host';
import { createDesktopCatalogMutationHost } from './core-catalog-mutation-host';
import { createDesktopSkillCatalogHost } from './core-skill-catalog-host';
import { createDesktopMcpRemovalHost } from './core-mcp-removal-host';
import { createDesktopCollectionEntryHost } from './core-collection-entry-host';
import type { DesktopDomainAdapter } from './desktop-runtime';

/** `core.catalog.*` on the desktop dispatcher (CAN-4123) over Electron main's stores. */
export function createCoreCatalogAdapter(options: {
  operations: OperationServicePort;
  host?: CoreCatalogHost;
  /** Host behind `core.catalog.skill.*` (CAN-4124); tests may inject one. */
  skillHost?: CoreSkillCatalogHost;
  mcpRemovalHost?: CoreMcpRemovalHost;
  /** Host behind the local `core.catalog.entry.*` (CAN-4170); tests may inject one. */
  collectionEntryHost?: CoreCollectionEntryHost;
  dispatchWorkspacePluginsUpdate: DesktopCatalogHostDeps['dispatchWorkspacePluginsUpdate'];
}): DesktopDomainAdapter {
  const runs = new CatalogMutationRuns({ operations: options.operations });
  const host =
    options.host ??
    createDesktopCatalogMutationHost(
      createDesktopCatalogHost({
        dispatchWorkspacePluginsUpdate: options.dispatchWorkspacePluginsUpdate,
      }),
    );
  const handlers = createCoreCatalogHandlers({ host, runs });
  const skillHandlers = createCoreSkillCatalogHandlers({
    host: options.skillHost ?? createDesktopSkillCatalogHost(),
    runs,
  });
  const removal = createCoreMcpRemovalHandlers(
    options.mcpRemovalHost ?? createDesktopMcpRemovalHost(),
  );
  const collectionEntries = createCoreCollectionEntryHandlers({
    host: options.collectionEntryHost ?? createDesktopCollectionEntryHost(),
    runs,
    installed: async () =>
      installedCatalogRefs(
        await (
          await import('../services/plugin-catalog-service')
        ).buildCachedPluginCatalog(),
      ),
  });
  return {
    queries: {
      ...removal.queries,
      'core.catalog.snapshot.get': (params, context) =>
        handlers.queries['core.catalog.snapshot.get'](params, context),
      'core.catalog.selection.get': (params, context) =>
        handlers.queries['core.catalog.selection.get'](params, context),
      'core.catalog.source.list': (params, context) =>
        handlers.queries['core.catalog.source.list'](params, context),
      'core.catalog.skill.list': (params, context) =>
        skillHandlers.queries['core.catalog.skill.list'](params, context),
      'core.catalog.skill.read': (params, context) =>
        skillHandlers.queries['core.catalog.skill.read'](params, context),
      'core.catalog.skill.files.list': (params, context) =>
        skillHandlers.queries['core.catalog.skill.files.list'](params, context),
      'core.catalog.skill.file.read': (params, context) =>
        skillHandlers.queries['core.catalog.skill.file.read'](params, context),
      'core.catalog.skill.discover': (params, context) =>
        skillHandlers.queries['core.catalog.skill.discover'](params, context),
      'core.catalog.entry.get': (params, context) =>
        collectionEntries.queries['core.catalog.entry.get'](params, context),
    },
    instructions: {
      ...removal.instructions,
      'core.catalog.selection.update': (params, context) =>
        handlers.instructions['core.catalog.selection.update'](params, context),
      'core.catalog.source.upsert': (params, context) =>
        handlers.instructions['core.catalog.source.upsert'](params, context),
      'core.catalog.source.delete': (params, context) =>
        handlers.instructions['core.catalog.source.delete'](params, context),
      'core.catalog.source.refresh': (params, context) =>
        handlers.instructions['core.catalog.source.refresh'](params, context),
      'core.catalog.plugin.install': (params, context) =>
        handlers.instructions['core.catalog.plugin.install'](params, context),
      'core.catalog.entry.publish': (params, context) =>
        handlers.instructions['core.catalog.entry.publish'](params, context),
      'core.catalog.entry.unpublish': (params, context) =>
        handlers.instructions['core.catalog.entry.unpublish'](params, context),
      'core.catalog.entry.upsert': (params, context) =>
        collectionEntries.instructions['core.catalog.entry.upsert'](
          params,
          context,
        ),
      'core.catalog.entry.delete': (params, context) =>
        collectionEntries.instructions['core.catalog.entry.delete'](
          params,
          context,
        ),
      'core.catalog.entry.import': (params, context) =>
        collectionEntries.instructions['core.catalog.entry.import'](
          params,
          context,
        ),
      'core.catalog.skill.install': (params, context) =>
        skillHandlers.instructions['core.catalog.skill.install'](
          params,
          context,
        ),
      'core.catalog.skill.update': (params, context) =>
        skillHandlers.instructions['core.catalog.skill.update'](
          params,
          context,
        ),
      'core.catalog.skill.remove': (params, context) =>
        skillHandlers.instructions['core.catalog.skill.remove'](
          params,
          context,
        ),
      'core.catalog.skill.custom.save': (params, context) =>
        skillHandlers.instructions['core.catalog.skill.custom.save'](
          params,
          context,
        ),
      'core.catalog.skill.updates.check': (params, context) =>
        skillHandlers.instructions['core.catalog.skill.updates.check'](
          params,
          context,
        ),
    },
  };
}
