import {
  CatalogMutationRuns,
  createCoreCatalogHandlers,
  createCoreSkillCatalogHandlers,
  type CoreCatalogHost,
  type CoreSkillCatalogHost,
} from '@canopy/core-runtime/node/catalog';
import type { OperationService } from '@canopy/core-runtime/node/operations';
import {
  createDesktopCatalogHost,
  type DesktopCatalogHostDeps,
} from './core-catalog-host';
import { createDesktopCatalogMutationHost } from './core-catalog-mutation-host';
import { createDesktopSkillCatalogHost } from './core-skill-catalog-host';
import type { DesktopDomainAdapter } from './desktop-runtime';

/** `core.catalog.*` on the desktop dispatcher (CAN-4123) over Electron main's stores. */
export function createCoreCatalogAdapter(options: {
  operations: OperationService;
  host?: CoreCatalogHost;
  /** Host behind `core.catalog.skill.*` (CAN-4124); tests may inject one. */
  skillHost?: CoreSkillCatalogHost;
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
  return {
    queries: {
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
    },
    instructions: {
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
