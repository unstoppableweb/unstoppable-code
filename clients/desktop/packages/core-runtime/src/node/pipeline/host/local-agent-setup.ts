import type {
  WorkerPipelineHostLaunch,
  WorkerPipelineOwnerResult,
  WorkerPipelineSetupFact,
} from '@canopy/protocol/canopy-core';
import { WorkerPipelinePluginSelectionsSchema } from '@canopy/protocol/canopy-core';
import { isDeepStrictEqual } from 'node:util';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import {
  readPipelineSetupFactVersion,
  localPipelinePluginPolicyFacts,
} from './setup-facts';

export async function readLocalPipelineAgentStore(
  dataRoot: string,
): Promise<unknown> {
  return readSetupJson(join(dataRoot, 'agent-models.json'));
}

async function readSetupJson(filePath: string): Promise<unknown> {
  // eslint-disable-next-line admitted-writers/no-unadmitted-write -- O_RDONLY only reads the bounded Agent definition; no writer is introduced.
  const file = await open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch(() => undefined);
  if (!file) return undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return undefined;
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) return undefined;
    const parsed: unknown = JSON.parse(
      buffer.subarray(0, bytesRead).toString('utf8'),
    );
    return parsed;
  } catch {
    return undefined;
  } finally {
    await file.close();
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function localPipelineSelectionsMatch(
  left: unknown,
  right: unknown,
): boolean {
  const canonical = (value: unknown): unknown => {
    const parsed = WorkerPipelinePluginSelectionsSchema.safeParse(value);
    return parsed.success
      ? {
          ...parsed.data,
          mcpServerRefs: parsed.data.mcpServerRefs ?? [],
          mcpHttpAuthPreferences: parsed.data.mcpHttpAuthPreferences ?? [],
          unresolvedCapabilities: parsed.data.unresolvedCapabilities ?? [],
        }
      : undefined;
  };
  const a = canonical(left);
  return a !== undefined && isDeepStrictEqual(a, canonical(right));
}

/** Authored local identity; selected content is independently classified below. */
export function localPipelineAgentMatches(
  store: unknown,
  agentId: string,
  result: WorkerPipelineOwnerResult,
): boolean {
  if (
    !record(store) ||
    Object.keys(store).some((key) => !['version', 'agents'].includes(key)) ||
    store.version !== 1 ||
    !Array.isArray(store.agents) ||
    result.kind !== 'model.agentAlias' ||
    result.alias === null
  )
    return false;
  const agents = store.agents.filter(
    (agent: unknown) => record(agent) && agent.id === agentId,
  );
  if (agents.length !== 1) return false;
  const agent: unknown = agents[0];
  if (
    !record(agent) ||
    Object.keys(agent).some(
      (key) =>
        ![
          'id',
          'name',
          'baseModel',
          'instructions',
          'pluginSelections',
          'createdAt',
          'updatedAt',
          'contentHash',
        ].includes(key),
    )
  )
    return false;
  const selections = WorkerPipelinePluginSelectionsSchema.safeParse(
    agent.pluginSelections,
  );
  const resolved = WorkerPipelinePluginSelectionsSchema.safeParse(
    result.alias.pluginSelections,
  );
  return (
    agent.id === result.alias.agentId &&
    agent.name === result.alias.name &&
    agent.baseModel === result.alias.base &&
    agent.instructions === result.alias.instructions &&
    selections.success &&
    resolved.success &&
    localPipelineSelectionsMatch(selections.data, resolved.data)
  );
}

/** Directory provenance, exact native facet and content, not a Personal label.
 * Imported/hosted/catalogue sources and policy-filtered selections stay app-bound.
 */
export async function localPipelinePluginFacts(input: {
  readonly dataRoot: string;
  readonly cwd: string;
  readonly selections: unknown;
  readonly harnesses: readonly ('claude' | 'codex')[];
}): Promise<
  readonly Omit<WorkerPipelineSetupFact, 'id' | 'version'>[] | undefined
> {
  const parsed = WorkerPipelinePluginSelectionsSchema.safeParse(
    input.selections,
  );
  if (!parsed.success) return undefined;
  const selections = parsed.data;
  if (
    selections.collectionIds.length ||
    selections.skillRefs.length ||
    (selections.mcpServerRefs?.length ?? 0) ||
    (selections.mcpHttpAuthPreferences?.length ?? 0) ||
    (selections.unresolvedCapabilities?.length ?? 0)
  )
    return undefined;
  if (!selections.pluginRefs.length) return [];
  const catalog = await readSetupJson(
    join(input.dataRoot, 'plugins-cache.json'),
  );
  if (
    !record(catalog) ||
    catalog.version !== 2 ||
    !Array.isArray(catalog.marketplaces)
  )
    return undefined;
  const facts: Omit<WorkerPipelineSetupFact, 'id' | 'version'>[] = [
    { root: 'data', relativePath: 'plugins-cache.json', projection: 'content' },
    {
      root: 'data',
      relativePath: 'plugin-cache-index.json',
      projection: 'content',
    },
    ...localPipelinePluginPolicyFacts(
      catalog.marketplaces.some(
        (market: unknown) =>
          record(market) &&
          Array.isArray(market.plugins) &&
          market.plugins.some(
            (plugin: unknown) =>
              record(plugin) &&
              record(plugin.facets) &&
              plugin.facets.codex !== undefined,
          ),
      ),
    ),
  ];
  for (const ref of selections.pluginRefs) {
    const markets: unknown[] = catalog.marketplaces.filter(
      (market: unknown) => record(market) && market.id === ref.marketplaceId,
    );
    const market = markets[0];
    if (
      markets.length !== 1 ||
      !record(market) ||
      market.sourceType !== 'directory' ||
      typeof market.installLocation !== 'string' ||
      !isAbsolute(market.installLocation) ||
      market.sourceUrl !== market.installLocation ||
      !Array.isArray(market.plugins) ||
      Object.keys(market).some(
        (key) =>
          ![
            'id',
            'name',
            'description',
            'sourceType',
            'sourceUrl',
            'installLocation',
            'plugins',
            'pluginCount',
            'providerStatus',
            'validProviders',
            'lastUpdated',
          ].includes(key),
      )
    )
      return undefined;
    const matches: unknown[] = market.plugins.filter(
      (plugin: unknown) =>
        record(plugin) &&
        typeof plugin.name === 'string' &&
        plugin.name.toLowerCase() === ref.pluginName.toLowerCase(),
    );
    const plugin = matches[0];
    if (
      matches.length !== 1 ||
      !record(plugin) ||
      !record(plugin.facets) ||
      Object.keys(plugin).some(
        (key) =>
          ![
            'name',
            'displayName',
            'description',
            'version',
            'author',
            'category',
            'homepage',
            'logoUrl',
            'facets',
            'marketplaceId',
            'sourcePath',
            'providerSupport',
            'details',
          ].includes(key),
      )
    )
      return undefined;
    for (const harness of input.harnesses) {
      const facet = plugin.facets[harness];
      if (
        !record(facet) ||
        facet.provider !== harness ||
        facet.mode !== 'native' ||
        facet.name !== ref.pluginName ||
        typeof facet.sourcePath !== 'string' ||
        typeof facet.installLocation !== 'string' ||
        Object.keys(facet).some(
          (key) =>
            ![
              'provider',
              'mode',
              'name',
              'sourcePath',
              'installLocation',
              'description',
              'version',
              'category',
              'author',
              'homepage',
              'displayName',
              'details',
            ].includes(key),
        )
      )
        return undefined;
      const location = resolve(market.installLocation, facet.sourcePath);
      if (location !== resolve(facet.installLocation)) return undefined;
      const withinMarket = relative(market.installLocation, location);
      const withinWorktree = relative(input.cwd, location);
      if (
        !withinMarket ||
        withinMarket.startsWith('..') ||
        isAbsolute(withinMarket) ||
        !withinWorktree ||
        withinWorktree.startsWith('..') ||
        isAbsolute(withinWorktree)
      )
        return undefined;
      const fact = {
        root: 'worktree' as const,
        relativePath: withinWorktree.split('\\').join('/'),
        projection: 'local-plugin' as const,
      };
      if (!(await readPipelineSetupFactVersion(input.cwd, fact)))
        return undefined;
      const manifest = await readSetupJson(
        join(location, `.${harness}-plugin`, 'plugin.json'),
      );
      if (!record(manifest) || manifest.name !== facet.name) return undefined;
      facts.push(fact);
    }
  }
  return facts;
}

/** Mirror only the unambiguous Agent-default subset of executor precedence. */
export function localPipelineAgentId(
  launch: Pick<WorkerPipelineHostLaunch, 'pipeline' | 'modelAliasPreferences'>,
  aliasId: string,
): string | undefined {
  const aliases = launch.pipeline.model_aliases;
  if (!Array.isArray(aliases)) return undefined;
  const matches = aliases.filter(
    (alias) => record(alias) && alias.id === aliasId,
  );
  if (
    matches.length !== 1 ||
    !record(matches[0]) ||
    Object.keys(matches[0]).some(
      (key) => !['id', 'name', 'description', 'defaults'].includes(key),
    )
  )
    return undefined;
  const preference = record(launch.modelAliasPreferences)
    ? launch.modelAliasPreferences[aliasId]
    : undefined;
  const defaults =
    record(preference) && preference.mode !== 'reset'
      ? preference
      : matches[0].defaults;
  // Overrides encode another Agent route; inherited/dynamic bases are not covered.
  return record(defaults) &&
    typeof defaults.agent_id === 'string' &&
    Object.keys(defaults).every((key) => ['mode', 'agent_id'].includes(key)) &&
    (defaults.mode === undefined || defaults.mode === 'agent')
    ? defaults.agent_id
    : undefined;
}
