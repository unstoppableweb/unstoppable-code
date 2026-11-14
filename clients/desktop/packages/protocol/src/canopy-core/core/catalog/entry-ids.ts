// Catalog entry ids (CAN-4123): one scheme for the web and desktop cores, so a
// client reads one closed catalog whichever core serves it.

/** The selection refs a catalog entry id names (the persisted selection shape, without extras). */
export interface CatalogSelectionRefs {
  collectionIds: string[];
  skillRefs: { sourceId: string; skillName: string }[];
  pluginRefs: { marketplaceId: string; pluginName: string }[];
  mcpServerRefs: { serverId: string; configId: string }[];
}

/** The web core's source of the account's own and shared custom skills. */
export const CLOUD_CUSTOM_SKILL_SOURCE_ID = 'cloud-custom';

/**
 * The web core's source of curated skills. A curated skill is a member of a
 * curated plugin, which its catalog lists as well.
 */
export const CLOUD_CURATED_SKILL_SOURCE_ID = 'cloud-curated';

export const modelEntryId = (id: string): string => `model:${id}`;
export const skillEntryId = (ref: {
  sourceId: string;
  skillName: string;
}): string => `skill:${ref.sourceId}/${ref.skillName}`;
export const pluginEntryId = (ref: {
  marketplaceId: string;
  pluginName: string;
}): string => `plugin:${ref.marketplaceId}/${ref.pluginName}`;
export const mcpServerEntryId = (ref: {
  serverId: string;
  configId: string;
}): string => `mcp_server:${ref.serverId}/${ref.configId}`;
export const collectionEntryId = (id: string): string => `collection:${id}`;

/** Empty refs. */
export function emptyCatalogSelectionRefs(): CatalogSelectionRefs {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  };
}

/** The four ref lists of a selection-shaped value, each defaulting to []. */
export function catalogSelectionRefsOf(
  value: Partial<CatalogSelectionRefs> | null | undefined,
): CatalogSelectionRefs {
  return {
    collectionIds: value?.collectionIds ?? [],
    skillRefs: value?.skillRefs ?? [],
    pluginRefs: value?.pluginRefs ?? [],
    mcpServerRefs: value?.mcpServerRefs ?? [],
  };
}

/** The entry ids a selection names: collections, skills, plugins, MCP servers, each in its order. */
export function selectionEntryIds(
  selections: Partial<CatalogSelectionRefs> | null | undefined,
): string[] {
  return [
    ...(selections?.collectionIds ?? []).map(collectionEntryId),
    ...(selections?.skillRefs ?? []).map(skillEntryId),
    ...(selections?.pluginRefs ?? []).map(pluginEntryId),
    ...(selections?.mcpServerRefs ?? []).map(mcpServerEntryId),
  ];
}

export type CatalogEntryIdResolution =
  | { ok: true; refs: CatalogSelectionRefs }
  | { ok: false; unknownId: string };

type CatalogRefTarget =
  | { kind: 'collection'; id: string }
  | { kind: 'skill'; ref: { sourceId: string; skillName: string } }
  | { kind: 'plugin'; ref: { marketplaceId: string; pluginName: string } }
  | { kind: 'mcp_server'; ref: { serverId: string; configId: string } };

/**
 * The refs `ids` name, in their order, looked up among the refs of `known`
 * (later sources never replace an id an earlier one defined). An id is never
 * split: a ref part may hold `/`. A repeated id is kept once, at its first
 * position. The first id no source names fails the resolution.
 */
export function resolveCatalogEntryIds(
  ids: readonly string[],
  known: readonly (Partial<CatalogSelectionRefs> | null | undefined)[],
): CatalogEntryIdResolution {
  const targets = new Map<string, CatalogRefTarget>();
  const define = (id: string, target: CatalogRefTarget): void => {
    if (!targets.has(id)) targets.set(id, target);
  };
  for (const source of known) {
    const refs = catalogSelectionRefsOf(source);
    for (const id of refs.collectionIds) {
      define(collectionEntryId(id), { kind: 'collection', id });
    }
    for (const ref of refs.skillRefs) {
      define(skillEntryId(ref), {
        kind: 'skill',
        ref: { sourceId: ref.sourceId, skillName: ref.skillName },
      });
    }
    for (const ref of refs.pluginRefs) {
      define(pluginEntryId(ref), {
        kind: 'plugin',
        ref: { marketplaceId: ref.marketplaceId, pluginName: ref.pluginName },
      });
    }
    for (const ref of refs.mcpServerRefs) {
      define(mcpServerEntryId(ref), {
        kind: 'mcp_server',
        ref: { serverId: ref.serverId, configId: ref.configId },
      });
    }
  }
  const refs = emptyCatalogSelectionRefs();
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    const target = targets.get(id);
    if (!target) return { ok: false, unknownId: id };
    seen.add(id);
    switch (target.kind) {
      case 'collection':
        refs.collectionIds.push(target.id);
        break;
      case 'skill':
        refs.skillRefs.push(target.ref);
        break;
      case 'plugin':
        refs.pluginRefs.push(target.ref);
        break;
      case 'mcp_server':
        refs.mcpServerRefs.push(target.ref);
        break;
    }
  }
  return { ok: true, refs };
}
