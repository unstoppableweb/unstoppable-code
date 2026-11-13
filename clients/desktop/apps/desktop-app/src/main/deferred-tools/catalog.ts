import { createHash } from 'node:crypto';
import {
  CORE_AGENT_DEFERRED_TOOLS_GRANTS,
  type CanopyCallerDescriptor,
  type CatalogEntry,
  type CatalogPluginHarness,
} from '@canopy/protocol/canopy-core';
import type {
  ChatTabPluginSelections,
  DeferredResourceKind,
  DeferredResourceSummary,
  DeferredToolMatch,
  DeferredToolProvider,
  DeferredToolsReloadAdditions,
  LoadDeferredToolRejection,
} from '@canopy/desktop-shared/types';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { resolveEffectivePluginSelectionRefs } from '../plugins/plugin-resolver';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';

/**
 * Search reads the catalog as the deferred tools' own principal, with only
 * the catalog read grant (CAN-6034).
 */
const DEFERRED_TOOLS_CATALOG_CALLER: CanopyCallerDescriptor = {
  principalId: 'desktop-agent-deferred-tools',
  clientInstanceId: 'desktop-main',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'mcp',
  grants: [CORE_AGENT_DEFERRED_TOOLS_GRANTS.search],
};

export type DeferredCatalogItemStatus =
  | 'available'
  | 'already_enabled'
  | 'unsupported'
  | 'disabled';

export interface DeferredCatalogItem {
  identityRef: string;
  ref: string;
  kind: DeferredResourceKind;
  name: string;
  description: string;
  sourceLabel?: string;
  status: DeferredCatalogItemStatus;
  reason?: string;
  selection: DeferredResourceSummary;
  /** Search-only capability metadata; the parent plugin remains loadable. */
  pluginMembers?: DeferredPluginMember[];
}

interface DeferredPluginMember {
  kind: 'skill' | 'command';
  name: string;
  description: string;
}

export interface DeferredCatalog {
  provider: DeferredToolProvider;
  items: DeferredCatalogItem[];
  byRef: Map<string, DeferredCatalogItem>;
  additionsFor(
    items: readonly DeferredCatalogItem[],
  ): DeferredToolsReloadAdditions;
}

export interface LoadClassification {
  willEnable: DeferredResourceSummary[];
  rejected: LoadDeferredToolRejection[];
  additions: DeferredToolsReloadAdditions;
}

export interface BuildDeferredToolsCatalogOptions {
  provider: DeferredToolProvider;
  pluginSelections?: ChatTabPluginSelections;
  /** The catalog snapshot's entries; the desktop dispatcher's by default. */
  readSnapshot?: () => Promise<readonly CatalogEntry[]>;
}

export function encodeDeferredCatalogRef(identityRef: string): string {
  const digest = createHash('sha256').update(identityRef).digest('base64url');
  return `deferred:v1:${digest}`;
}

function encodePart(value: string): string {
  return encodeURIComponent(value);
}

export function encodeSkillRef(sourceId: string, skillName: string): string {
  return `skill:${encodePart(sourceId)}:${encodePart(skillName)}`;
}

export function encodePluginRef(
  marketplaceId: string,
  pluginName: string,
): string {
  return `plugin:${encodePart(marketplaceId)}:${encodePart(pluginName)}`;
}

export function encodeMcpRef(serverId: string, configId: string): string {
  return `mcp:${encodePart(serverId)}:${encodePart(configId)}`;
}

function skillKey(ref: { sourceId: string; skillName: string }): string {
  return `${ref.sourceId}\u0000${ref.skillName}`;
}

function pluginKey(ref: { marketplaceId: string; pluginName: string }): string {
  return `${ref.marketplaceId}\u0000${ref.pluginName.toLowerCase()}`;
}

function mcpKey(ref: { serverId: string; configId: string }): string {
  return `${ref.serverId}\u0000${ref.configId}`;
}

function itemSummary(item: DeferredCatalogItem): DeferredResourceSummary {
  return {
    ref: item.ref,
    kind: item.kind,
    name: item.name,
    ...(item.sourceLabel ? { sourceLabel: item.sourceLabel } : {}),
  };
}

/** The entry fields every item reads; content is passed narrowed. */
type EntryLabels = Pick<CatalogEntry, 'name' | 'description' | 'sourceLabel'>;

function skillItem(
  entry: EntryLabels,
  ref: { sourceId: string; skillName: string },
  enabledKeys: ReadonlySet<string>,
): DeferredCatalogItem {
  const identityRef = encodeSkillRef(ref.sourceId, ref.skillName);
  const deferredRef = encodeDeferredCatalogRef(identityRef);
  const enabled = enabledKeys.has(skillKey(ref));
  const sourceLabel = entry.sourceLabel ?? '';
  return {
    identityRef,
    ref: deferredRef,
    kind: 'skill',
    name: entry.name,
    description: entry.description,
    sourceLabel,
    status: enabled ? 'already_enabled' : 'available',
    ...(enabled ? { reason: 'Already enabled in this chat.' } : {}),
    selection: {
      ref: deferredRef,
      kind: 'skill',
      name: entry.name,
      sourceLabel,
    },
  };
}

function pluginItem(
  entry: EntryLabels,
  ref: { marketplaceId: string; pluginName: string },
  harness: CatalogPluginHarness,
  provider: DeferredToolProvider,
  enabledKeys: ReadonlySet<string>,
): DeferredCatalogItem {
  const identityRef = encodePluginRef(ref.marketplaceId, ref.pluginName);
  const deferredRef = encodeDeferredCatalogRef(identityRef);
  const enabled = enabledKeys.has(pluginKey(ref));
  const sourceLabel = entry.sourceLabel ?? '';
  // Copilot projects installed content; native hooks/agents/apps are not capabilities.
  const supported =
    harness.supported && (provider === 'copilot' || harness.enabled);
  const unsupportedReason =
    provider === 'copilot'
      ? 'This plugin has no installed skills, commands, or MCP servers supported by Copilot.'
      : `Plugin is not supported by ${provider}.`;
  return {
    identityRef,
    ref: deferredRef,
    kind: 'plugin',
    name: entry.name,
    description: entry.description,
    sourceLabel,
    status: !supported
      ? 'unsupported'
      : enabled
        ? 'already_enabled'
        : 'available',
    ...(!supported
      ? { reason: unsupportedReason }
      : enabled
        ? { reason: 'Already enabled in this chat.' }
        : {}),
    selection: {
      ref: deferredRef,
      kind: 'plugin',
      name: entry.name,
      sourceLabel,
    },
    pluginMembers: harness.members,
  };
}

/** Whether search lists the plugin for this provider at all. */
function pluginListed(
  harness: CatalogPluginHarness,
  provider: DeferredToolProvider,
): boolean {
  // Copilot lists only installed content; the others leave out a plugin
  // they support but have no installed facet for.
  return provider === 'copilot'
    ? harness.installed
    : !harness.supported || harness.installed;
}

function mcpItem(
  entry: EntryLabels,
  configName: string | undefined,
  ref: { serverId: string; configId: string },
  enabledKeys: ReadonlySet<string>,
): DeferredCatalogItem {
  const identityRef = encodeMcpRef(ref.serverId, ref.configId);
  const deferredRef = encodeDeferredCatalogRef(identityRef);
  const selected = enabledKeys.has(mcpKey(ref));
  const serverName = entry.name;
  const name =
    configName && configName !== serverName
      ? `${serverName} / ${configName}`
      : serverName;
  return {
    identityRef,
    ref: deferredRef,
    kind: 'mcp',
    name,
    description: entry.description,
    sourceLabel: serverName,
    status: selected ? 'already_enabled' : 'available',
    ...(selected ? { reason: 'Already enabled in this chat.' } : {}),
    selection: { ref: deferredRef, kind: 'mcp', name, sourceLabel: serverName },
  };
}

/**
 * The skills, plugins and MCP servers of `core.catalog.snapshot.get`, read
 * through the desktop dispatcher with only the catalog read grant.
 */
async function readCatalogSnapshotEntries(): Promise<readonly CatalogEntry[]> {
  const { getActiveDesktopRuntime } =
    await import('../canopy-runtime/desktop-runtime');
  const { entries } = await getActiveDesktopRuntime().query(
    'core.catalog.snapshot.get',
    {
      scope: {},
      kinds: ['skill', 'plugin', 'mcp_server'],
      includeUnavailable: true,
    },
    { caller: DEFERRED_TOOLS_CATALOG_CALLER },
  );
  return entries;
}

export async function buildDeferredToolsCatalog(
  options: BuildDeferredToolsCatalogOptions,
): Promise<DeferredCatalog> {
  const normalizedSelections = normalizePluginSelections(
    options.pluginSelections,
  );
  const effective =
    await resolveEffectivePluginSelectionRefs(normalizedSelections);
  const enabledSkillKeys = new Set(effective.skillRefs.map(skillKey));
  const enabledPluginKeys = new Set(effective.pluginRefs.map(pluginKey));
  const enabledMcpKeys = new Set(effective.mcpServerRefs.map(mcpKey));

  const items: DeferredCatalogItem[] = [];
  for (const entry of await (
    options.readSnapshot ?? readCatalogSnapshotEntries
  )()) {
    const content = entry.content;
    if (content.kind === 'skill') {
      // A skill or plugin the installed-item policy turned off is left out.
      if (entry.availability === 'disabled' || !content.selectionRef) continue;
      items.push(skillItem(entry, content.selectionRef, enabledSkillKeys));
    } else if (content.kind === 'plugin') {
      const harness = content.harnesses?.[options.provider];
      if (
        entry.availability === 'disabled' ||
        !content.selectionRef ||
        !harness ||
        !pluginListed(harness, options.provider)
      )
        continue;
      items.push(
        pluginItem(
          entry,
          content.selectionRef,
          harness,
          options.provider,
          enabledPluginKeys,
        ),
      );
    } else if (content.kind === 'mcp_server') {
      // The snapshot lists enabled configurations only; search has never
      // applied the installed-item policy or the account connection to them.
      if (!content.selectionRef) continue;
      items.push(
        mcpItem(
          entry,
          content.configName,
          content.selectionRef,
          enabledMcpKeys,
        ),
      );
    }
  }

  items.sort(compareCatalogItems);
  const byRef = new Map(items.map((item) => [item.ref, item]));
  return {
    provider: options.provider,
    items,
    byRef,
    additionsFor(selectedItems): DeferredToolsReloadAdditions {
      const additions: DeferredToolsReloadAdditions = {
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      };
      for (const item of selectedItems) {
        if (item.kind === 'skill') {
          const [, sourceId = '', skillName = ''] = item.identityRef.split(':');
          additions.skillRefs.push({
            sourceId: decodeURIComponent(sourceId),
            skillName: decodeURIComponent(skillName),
          });
        } else if (item.kind === 'plugin') {
          const [, marketplaceId = '', pluginName = ''] =
            item.identityRef.split(':');
          additions.pluginRefs.push({
            marketplaceId: decodeURIComponent(marketplaceId),
            pluginName: decodeURIComponent(pluginName),
          });
        } else {
          const [, serverId = '', configId = ''] = item.identityRef.split(':');
          additions.mcpServerRefs.push({
            serverId: decodeURIComponent(serverId),
            configId: decodeURIComponent(configId),
          });
        }
      }
      return additions;
    },
  };
}

function compareCatalogItems(
  a: DeferredCatalogItem,
  b: DeferredCatalogItem,
): number {
  return (
    a.kind.localeCompare(b.kind) ||
    a.name.localeCompare(b.name) ||
    a.identityRef.localeCompare(b.identityRef)
  );
}

type MatchRank = 0 | 1 | 2 | 3;

function rankText(
  names: readonly string[],
  fields: readonly (string | undefined)[],
  query: string,
): MatchRank | null {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return null;
  }
  const normalizedNames = names.map((name) => name.toLowerCase());
  if (normalizedNames.some((name) => name === needle)) return 0;
  if (normalizedNames.some((name) => name.startsWith(needle))) return 1;
  const haystack = [...names, ...fields]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const tokens = haystack.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.some((token) => token === needle || token.startsWith(needle))) {
    return 2;
  }
  return haystack.includes(needle) ? 3 : null;
}

function rankItem(item: DeferredCatalogItem, query: string): MatchRank | null {
  return rankText(
    [item.name],
    [item.description, item.sourceLabel, item.kind],
    query,
  );
}

interface QualifiedPluginMemberQuery {
  plugin: string;
  member: string;
}

function parseQualifiedPluginMemberQuery(
  query: string,
): QualifiedPluginMemberQuery | null {
  const trimmed = query.trim();
  const separator = trimmed.indexOf(':');
  if (separator <= 0 || separator === trimmed.length - 1) return null;
  const plugin = trimmed.slice(0, separator).trim();
  const member = trimmed.slice(separator + 1).trim();
  return plugin && member ? { plugin, member } : null;
}

function rankPluginMember(
  plugin: DeferredCatalogItem,
  member: DeferredPluginMember,
  query: string,
): MatchRank | null {
  const trimmed = query.trim();
  const names = trimmed.includes(' ')
    ? [
        member.name,
        `${plugin.name}:${member.name}`,
        `${plugin.name} ${member.name}`,
      ]
    : [member.name];
  return rankText(names, [member.description], trimmed);
}

interface RankedPluginMember {
  member: DeferredPluginMember;
  rank: MatchRank;
}

function comparePluginMembers(
  a: RankedPluginMember,
  b: RankedPluginMember,
): number {
  return (
    (a.member.kind === 'skill' ? 0 : 1) - (b.member.kind === 'skill' ? 0 : 1) ||
    a.rank - b.rank ||
    a.member.name.localeCompare(b.member.name)
  );
}

interface RankedCatalogMatch {
  item: DeferredCatalogItem;
  rank: number;
  pluginRank: number;
  pluginMemberMatch: boolean;
  matchedMembers?: RankedPluginMember[];
}

export interface DeferredCatalogSearchResult {
  matches: DeferredToolMatch[];
  unsupportedMatches: number;
}

export function searchDeferredCatalogResult(
  catalog: DeferredCatalog,
  query: string,
  options: { kinds?: DeferredResourceKind[]; limit?: number } = {},
): DeferredCatalogSearchResult {
  const allowedKinds = options.kinds?.length
    ? new Set(options.kinds)
    : undefined;
  const qualified = parseQualifiedPluginMemberQuery(query);
  const rankedByRef = new Map<string, RankedCatalogMatch>();
  for (const item of catalog.items) {
    if (!qualified && (!allowedKinds || allowedKinds.has(item.kind))) {
      const rank = rankItem(item, query);
      if (rank !== null) {
        rankedByRef.set(item.ref, {
          item,
          rank,
          pluginRank: 0,
          pluginMemberMatch: false,
        });
      }
    }

    const deepPluginSearchAllowed =
      item.kind === 'plugin' &&
      (!allowedKinds ||
        allowedKinds.has('skill') ||
        allowedKinds.has('plugin'));
    if (!deepPluginSearchAllowed || !item.pluginMembers?.length) {
      continue;
    }

    const pluginRank = qualified ? rankItem(item, qualified.plugin) : 0;
    if (qualified && pluginRank === null) continue;
    const memberQuery = qualified?.member ?? query;
    const matchedMembers = item.pluginMembers
      .map((member): RankedPluginMember | null => {
        const rank = rankPluginMember(item, member, memberQuery);
        return rank === null ? null : { member, rank };
      })
      .filter((match): match is RankedPluginMember => match !== null)
      .sort(comparePluginMembers);
    if (matchedMembers.length === 0) continue;

    const existing = rankedByRef.get(item.ref);
    if (existing) {
      existing.matchedMembers = matchedMembers;
      continue;
    }
    rankedByRef.set(item.ref, {
      item,
      rank: matchedMembers[0]?.rank ?? 3,
      pluginRank: pluginRank ?? 0,
      pluginMemberMatch: true,
      matchedMembers,
    });
  }
  let ranked = Array.from(rankedByRef.values());
  if (qualified && ranked.some((match) => match.pluginRank === 0)) {
    ranked = ranked.filter((match) => match.pluginRank === 0);
  }
  ranked.sort(
    (a, b) =>
      Number(a.pluginMemberMatch) - Number(b.pluginMemberMatch) ||
      a.pluginRank - b.pluginRank ||
      a.rank - b.rank ||
      compareCatalogItems(a.item, b.item),
  );
  const unsupportedMatches = ranked.filter(
    ({ item }) => item.status === 'unsupported' || item.status === 'disabled',
  ).length;
  const matches = ranked
    .filter(
      ({ item }) => item.status !== 'unsupported' && item.status !== 'disabled',
    )
    .slice(0, options.limit ?? 10)
    .map(
      ({ item, matchedMembers }): DeferredToolMatch => ({
        ref: item.ref,
        kind: item.kind,
        name: item.name,
        description: item.description,
        ...(item.sourceLabel ? { sourceLabel: item.sourceLabel } : {}),
        status:
          item.status === 'already_enabled' ? 'already_enabled' : 'available',
        ...(item.reason ? { reason: item.reason } : {}),
        ...(matchedMembers
          ? {
              matchedMembers: matchedMembers.slice(0, 10).map(({ member }) => ({
                kind: member.kind,
                name: `${item.name}:${member.name}`,
                description: member.description,
              })),
            }
          : {}),
      }),
    );
  return { matches, unsupportedMatches };
}

export function searchDeferredCatalog(
  catalog: DeferredCatalog,
  query: string,
  options: { kinds?: DeferredResourceKind[]; limit?: number } = {},
): DeferredToolMatch[] {
  return searchDeferredCatalogResult(catalog, query, options).matches;
}

export const DEFERRED_REF_NOT_ISSUED_MESSAGE =
  'This chat has not been given that ref. Search with SearchDeferredTools in this chat, then load a ref it returned.';

/**
 * Classifies a Load request against the live catalog. `issued` says whether
 * search returned a ref to this chat (CAN-5995); any other ref is refused
 * before the catalog is consulted.
 */
export function classifyLoadItems(
  catalog: DeferredCatalog,
  refs: readonly string[],
  issued: (ref: string) => boolean,
): LoadClassification {
  const seen = new Set<string>();
  const selected: DeferredCatalogItem[] = [];
  const rejected: LoadDeferredToolRejection[] = [];
  for (const ref of refs) {
    const trimmed = ref.trim();
    if (!trimmed || seen.has(trimmed)) {
      if (!trimmed) {
        rejected.push({
          ref,
          code: 'invalid_ref',
          message: 'Load item ref must be a non-empty string.',
        });
      }
      continue;
    }
    seen.add(trimmed);
    if (!issued(trimmed)) {
      rejected.push({
        ref: trimmed,
        code: 'not_found',
        message: DEFERRED_REF_NOT_ISSUED_MESSAGE,
      });
      continue;
    }
    const item = catalog.byRef.get(trimmed);
    if (!item) {
      rejected.push({
        ref: trimmed,
        code: 'not_found',
        message: 'Catalog item was not found.',
      });
      continue;
    }
    if (item.status === 'already_enabled') {
      rejected.push({
        ref: trimmed,
        code: 'already_enabled',
        message: item.reason ?? 'Item is already enabled.',
      });
      continue;
    }
    if (item.status === 'unsupported') {
      rejected.push({
        ref: trimmed,
        code: 'unsupported',
        message: item.reason ?? 'Item is unsupported by this provider.',
      });
      continue;
    }
    if (item.status === 'disabled') {
      rejected.push({
        ref: trimmed,
        code: 'disabled',
        message: item.reason ?? 'Item is disabled.',
      });
      continue;
    }
    selected.push(item);
  }

  return {
    willEnable: selected.map(itemSummary),
    rejected,
    additions: catalog.additionsFor(selected),
  };
}
