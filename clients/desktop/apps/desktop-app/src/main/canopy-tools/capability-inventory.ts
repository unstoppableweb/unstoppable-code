import type { CapabilityItemKind } from '@canopy/protocol/agent-artifacts';
import { readInstalledItemPolicy } from '../installed-items/installed-item-policy';
import type {
  CapabilityCandidate,
  CapabilityInventory,
  CapabilityTier,
} from './show-capabilities';
import type { WorktreeActionRuntime } from './worktree-actions';

interface Source {
  tiers: ReadonlyArray<CapabilityTier>;
  read: () => Promise<CapabilityInventory>;
}
function inventorySource(tiers: Source['tiers'], read: Source['read']): Source {
  return { tiers, read };
}
const MAX_ITEMS = 2000;
function row(
  itemKind: CapabilityItemKind,
  source: string,
  sourceId: string,
  name: string,
  navigationTarget: CapabilityCandidate['navigationTarget'],
  description?: string,
  state: CapabilityCandidate['state'] = 'installed',
): CapabilityCandidate {
  return {
    id: `${source}:${sourceId}`,
    itemKind,
    source,
    sourceId,
    name,
    description,
    sourceLabel:
      source === 'shared'
        ? 'Shared'
        : source === 'plugin'
          ? 'Plugin'
          : source === 'marketplace'
            ? 'Marketplace'
            : source === 'curated'
              ? 'Catalog'
              : 'Local',
    state,
    navigationTarget,
  };
}

/** Scoped authenticated lists and cache-only catalogs; never refreshes or fetches a supplied URL. */
export async function readCapabilityInventory(
  kind: CapabilityItemKind,
  scope?: WorktreeActionRuntime,
): Promise<CapabilityInventory> {
  const { resourceContextSnapshot, assertResourceContextSnapshot } =
    await import('../lib/resource-context');
  const snapshot = await resourceContextSnapshot();
  const sources: Source[] = [];
  if (kind === 'skill') {
    sources.push(
      inventorySource(['installed'], async () => {
        const { loadSkills } = await import('../skills/skill-service');
        const { filterStoredSkillContexts } =
          await import('../skills/skill-install-context');
        const result = loadSkills();
        if (!result.success || !result.data)
          throw new Error('Skill inventory unavailable');
        const skills = await filterStoredSkillContexts(result.data);
        return {
          items: skills.slice(0, MAX_ITEMS).map((s) => ({
            ...row(
              kind,
              'installed',
              `${s.sourceId}/${s.name}`,
              s.name,
              {
                kind: 'installed_skill',
                sourceId: s.sourceId,
                skillName: s.name,
              },
              s.description,
            ),
            locators: [`${s.sourceId}:${s.name}`],
          })),
          unavailable: skills.length > MAX_ITEMS,
        };
      }),
    );
    sources.push(
      inventorySource(['available'], async () => {
        const { listSharedSkills } =
          await import('../skills/canopy-server-client');
        const result = await listSharedSkills({ limit: 100 });
        return {
          items: result.skills.map((s) =>
            row(
              kind,
              'shared',
              s.id,
              s.name,
              { kind: 'shared_skill', skillId: s.id },
              s.description,
              'available',
            ),
          ),
          unavailable: Boolean(result.nextCursor),
        };
      }),
    );
    sources.push(
      inventorySource(['installed'], async () => {
        const { loadMarketplacesCacheOnly } =
          await import('../plugins/plugin-service');
        const result = await loadMarketplacesCacheOnly();
        if (!result.success || !result.data)
          throw new Error('Plugin skill inventory unavailable');
        const items: CapabilityCandidate[] = [];
        for (const marketplace of result.data.marketplaces) {
          for (const plugin of marketplace.plugins) {
            if (
              !plugin.cachePath &&
              !plugin.globalInstallStatus?.claude?.installed &&
              !plugin.globalInstallStatus?.codex?.installed
            )
              continue;
            const details =
              plugin.facets.claude?.details ??
              plugin.facets.codex?.details ??
              plugin.facets.codexCompatibility?.details ??
              plugin.details;
            const names = new Set<string>();
            for (const skill of details?.skills ?? []) {
              const key = skill.name.toLocaleLowerCase('en-US');
              if (names.has(key)) continue;
              names.add(key);
              if (items.length === MAX_ITEMS)
                return { items, partialTiers: ['installed'] };
              const name = `${plugin.name}:${skill.name}`;
              items.push({
                ...row(
                  kind,
                  'plugin',
                  `${marketplace.id}/${name}`,
                  name,
                  {
                    kind: 'capability_entry',
                    entry: {
                      type: 'marketplace-plugin',
                      marketplaceId: marketplace.id,
                      pluginName: plugin.name,
                    },
                  },
                  skill.description,
                ),
                locators: [name],
              });
            }
          }
        }
        return { items };
      }),
    );
  } else if (kind === 'pipeline') {
    sources.push(
      inventorySource(['installed'], async () => {
        const { listPipelines } = await import('../pipelines/pipeline-service');
        const { assertStoredPipelineContext } =
          await import('../pipelines/pipeline-install-context');
        const result = listPipelines();
        if (!result.success || !result.data)
          throw new Error('Pipeline inventory unavailable');
        const items: CapabilityCandidate[] = [];
        for (const p of result.data.slice(0, MAX_ITEMS)) {
          try {
            await assertStoredPipelineContext(p.id, scope?.projectId);
          } catch {
            continue;
          }
          items.push(
            row(
              kind,
              p.source,
              p.id,
              p.name,
              {
                kind: 'pipeline_editor',
                source: p.source,
                pipelineId: p.id,
                ...(p.remote?.remoteId
                  ? { sharedRemoteId: p.remote.remoteId }
                  : {}),
              },
              p.description,
            ),
          );
        }
        return { items, unavailable: result.data.length > MAX_ITEMS };
      }),
      inventorySource(['available'], async () => {
        const { listSharedPipelines } =
          await import('../pipelines/canopy-server-client');
        const result = await listSharedPipelines({ limit: 100 });
        return {
          items: result.data.map((p) =>
            row(
              kind,
              'shared',
              p.id,
              p.name,
              {
                kind: 'pipeline_editor',
                source: 'shared',
                pipelineId: p.id,
                sharedRemoteId: p.id,
              },
              p.description,
              'available',
            ),
          ),
          unavailable: Boolean(result.nextCursor),
        };
      }),
    );
    if (scope)
      sources.push(
        inventorySource(['installed'], async () => {
          const { discoverProjectPipelinesBounded } =
            await import('../pipelines/project-pipeline-discovery');
          const { filterProjectPipelineContexts } =
            await import('../pipelines/pipeline-install-context');
          const discovery = await discoverProjectPipelinesBounded(scope.cwd, {
            maxEntries: 2000,
            maxFiles: 200,
            maxBytes: 2 * 1024 * 1024,
            maxSerializedBytes: 4 * 1024 * 1024,
          });
          const result = await filterProjectPipelineContexts(
            discovery.pipelines,
            scope.cwd,
            scope.projectId,
          );
          return {
            items: result.slice(0, MAX_ITEMS).map((p) =>
              row(
                kind,
                'project',
                p.id,
                p.name,
                {
                  kind: 'pipeline_editor',
                  source: 'project',
                  pipelineId: p.id,
                  projectId: scope.projectId,
                  worktreeId: scope.worktreeId,
                },
                p.description,
              ),
            ),
            unavailable: discovery.truncated || result.length > MAX_ITEMS,
          };
        }),
      );
  } else if (kind === 'automation') {
    sources.push(
      inventorySource(['installed'], async () => {
        const { getAutomationsService } =
          await import('../automations/service');
        const { scopeAutomationsToSelectedContext } =
          await import('../services/background-execution-context');
        const result = await scopeAutomationsToSelectedContext(
          await getAutomationsService().list(),
        );
        return {
          items: result.activities.map((a) =>
            row(kind, 'local', a.id, a.name, {
              kind: 'automation_editor',
              activityId: a.id,
            }),
          ),
        };
      }),
    );
    sources.push(
      inventorySource(['available'], async () => {
        const { listSharedAutomations } =
          await import('../automations/canopy-server-client');
        const result = await listSharedAutomations({ limit: 100 });
        return {
          items: result.automations.map((automation) =>
            row(
              kind,
              'shared',
              automation.id,
              automation.name,
              {
                kind: 'capability_entry',
                entry: {
                  type: 'shared-automation',
                  automationId: automation.id,
                },
              },
              automation.description,
              'available',
            ),
          ),
          unavailable: Boolean(result.nextCursor),
        };
      }),
      inventorySource(['available'], async () => {
        const { readCachedCuratedAutomations } =
          await import('../automations/curated-automation-catalog');
        const result = await readCachedCuratedAutomations();
        if (!result) return { items: [], unavailable: true };
        return {
          items: result.data.map((automation) =>
            row(
              kind,
              'curated',
              automation.key,
              automation.name,
              {
                kind: 'capability_entry',
                entry: { type: 'curated-automation', key: automation.key },
              },
              automation.shortDescription,
              'available',
            ),
          ),
          unavailable: Boolean(result.nextCursor),
        };
      }),
    );
  } else if (kind === 'agent') {
    sources.push(
      inventorySource(['installed'], async () => {
        const { listAgentModels } = await import('../agents/agent-model-store');
        return {
          items: (await listAgentModels()).map((a) =>
            row(kind, 'local', a.id, a.name, {
              kind: 'agent_editor',
              agentId: a.id,
            }),
          ),
        };
      }),
      inventorySource(['available'], async () => {
        const { listSharedAgents } =
          await import('../agents/canopy-server-client');
        const result = await listSharedAgents({ limit: 100 });
        return {
          items: result.agents.map((a) =>
            row(
              kind,
              'shared',
              a.id,
              a.name,
              { kind: 'shared_agent', agentId: a.id },
              undefined,
              'available',
            ),
          ),
          unavailable: Boolean(result.nextCursor),
        };
      }),
    );
  } else if (kind === 'plugin') {
    sources.push(
      inventorySource(['installed', 'available'], async () => {
        const { listRemoteControlMarketplaces } =
          await import('../services/plugin-catalog-service');
        const result = await listRemoteControlMarketplaces();
        return {
          items: result.marketplaces.flatMap((m) =>
            m.plugins.map((p) =>
              row(
                kind,
                'marketplace',
                `${m.id}/${p.name}`,
                p.displayName ?? p.name,
                {
                  kind: 'capability_entry',
                  entry: {
                    type: 'marketplace-plugin',
                    marketplaceId: m.id,
                    pluginName: p.name,
                  },
                },
                p.description,
                p.installed ? 'installed' : 'available',
              ),
            ),
          ),
          unavailable: result.truncated,
        };
      }),
    );
  } else if (kind === 'mcp-server') {
    sources.push(
      inventorySource(['installed'], async () => {
        const { listRemoteControlMcpServers } =
          await import('../services/plugin-catalog-service');
        const result = await listRemoteControlMcpServers();
        return {
          items: result.servers.map((s) =>
            row(
              kind,
              'local',
              s.id,
              s.name,
              {
                kind: 'capability_entry',
                entry: { type: 'local-mcp', serverId: s.id },
              },
              s.description,
            ),
          ),
          unavailable: result.truncated,
        };
      }),
    );
    sources.push(
      inventorySource(['available'], async () => {
        const { readCachedCuratedMcpServers } =
          await import('../mcp/curated-catalog');
        const result = await readCachedCuratedMcpServers();
        if (!result) return { items: [], unavailable: true };
        return {
          items: result.servers.map((server) =>
            row(
              kind,
              'curated',
              server.key,
              server.name,
              {
                kind: 'capability_entry',
                entry: { type: 'curated-mcp', key: server.key },
              },
              server.shortDescription,
              'available',
            ),
          ),
        };
      }),
    );
  } else if (kind === 'collection') {
    sources.push(
      inventorySource(['installed'], async () => {
        const { listRemoteControlCollections } =
          await import('../services/plugin-catalog-service');
        const result = await listRemoteControlCollections();
        return {
          items: result.collections.map((c) =>
            row(
              kind,
              'local',
              c.id,
              c.name,
              {
                kind: 'capability_entry',
                entry: { type: 'local-collection', collectionId: c.id },
              },
              c.description,
            ),
          ),
          unavailable: result.truncated,
        };
      }),
      inventorySource(['available'], async () => {
        const { listSharedCollections } =
          await import('../collections/canopy-server-client');
        const result = await listSharedCollections({ limit: 100 });
        return {
          items: result.collections.map((c) =>
            row(
              kind,
              'shared',
              c.id,
              c.name,
              {
                kind: 'capability_entry',
                entry: { type: 'shared-collection', collectionId: c.id },
              },
              c.description,
              'available',
            ),
          ),
          unavailable: Boolean(result.nextCursor),
        };
      }),
    );
  }
  const results = await Promise.allSettled(
    sources.map(async ({ read }) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Inventory timed out')),
              5000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
  await assertResourceContextSnapshot(snapshot);
  const policy = await readInstalledItemPolicy();
  const items = results
    .flatMap((r) => (r.status === 'fulfilled' ? r.value.items : []))
    .filter((item) => {
      const target = item.navigationTarget;
      if (target.kind === 'installed_skill')
        return !policy.isDisabled({
          kind: 'skill',
          sourceId: target.sourceId,
          skillName: target.skillName,
        });
      if (target.kind !== 'capability_entry') return true;
      const entry = target.entry;
      if (entry.type === 'marketplace-plugin')
        return !policy.isDisabled({
          kind: 'plugin',
          marketplaceId: entry.marketplaceId,
          pluginName: entry.pluginName,
        });
      if (entry.type === 'local-collection')
        return !policy.isDisabled({
          kind: 'collection',
          collectionId: entry.collectionId,
        });
      return true;
    });
  const partialTiers = new Set<CapabilityTier>();
  results.forEach((result, index) => {
    const source = sources[index];
    if (!source) return;
    const partial =
      result.status === 'rejected'
        ? source.tiers
        : (result.value.partialTiers ??
          (result.value.unavailable ? source.tiers : []));
    for (const tier of partial) partialTiers.add(tier);
  });
  if (items.length > MAX_ITEMS) {
    partialTiers.add('installed');
    partialTiers.add('available');
  }
  return {
    items: items.slice(0, MAX_ITEMS),
    partialTiers: Array.from(partialTiers),
    unavailable: partialTiers.size > 0,
  };
}
