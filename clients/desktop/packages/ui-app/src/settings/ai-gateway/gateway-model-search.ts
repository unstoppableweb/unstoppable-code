import type { ModelGatewayModel } from '@canopy/protocol/canopy-server';
import type { DiscoveredGatewayModel } from '@canopy/protocol/model-gateway/discovery';

/** The browser's filter segments. */
export type GatewayModelFilter = 'all' | 'claude' | 'openai' | 'open' | 'on';

/** One model, folded once per discovery result for search and filters. */
export interface GatewayModelIndexEntry {
  readonly model: ModelGatewayModel;
  /** Lowercased label with separator runs folded to one space. */
  readonly label: string;
  /** Lowercased gateway ID with separator runs folded to one space. */
  readonly gatewayId: string;
  /** The gateway ID's provider prefix (`openai` of `openai/gpt-…`), or null. */
  readonly provider: string | null;
  readonly claude: boolean;
  readonly openai: boolean;
  /** The gateway said this model's weights are published. */
  readonly openWeights: boolean;
}

export type GatewayModelListItem =
  | {
      readonly kind: 'header';
      readonly key: string;
      readonly label: string;
      readonly count: number;
    }
  | {
      readonly kind: 'option';
      readonly key: string;
      readonly model: ModelGatewayModel;
    };

export interface GatewayModelListView {
  readonly items: readonly GatewayModelListItem[];
  readonly optionCount: number;
}

const SEPARATORS = /[\s\-./_:@]+/g;
// An OpenAI model a gateway routes under another prefix (`azure/gpt-4o`).
const OPENAI_SEGMENT = /^(gpt-|o1|o3|o4|codex)/;
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  openai: 'OpenAI',
};

/** Case and separators (`-` `.` `/` `_` `:` `@`) fold, so `5.5` finds `5-5`. */
export function foldGatewayText(text: string): string {
  return text.toLowerCase().replace(SEPARATORS, ' ').trim();
}

/** The query's tokens; an empty list means no search. */
export function gatewayQueryTokens(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** Gateway IDs the gateway marked as open-weight; empty when it didn't say. */
export function openWeightGatewayIds(
  discovered: readonly DiscoveredGatewayModel[],
): ReadonlySet<string> {
  return new Set(
    discovered.flatMap((model) => (model.openWeights ? [model.id] : [])),
  );
}

export function indexGatewayModels(
  models: readonly ModelGatewayModel[],
  openWeightIds: ReadonlySet<string> = new Set(),
): GatewayModelIndexEntry[] {
  return models.map((model) => {
    const slash = model.gatewayId.indexOf('/');
    const provider =
      slash > 0 ? model.gatewayId.slice(0, slash).toLowerCase() : null;
    const lastSegment = model.gatewayId
      .slice(model.gatewayId.lastIndexOf('/') + 1)
      .toLowerCase();
    return {
      model,
      label: foldGatewayText(model.label),
      gatewayId: foldGatewayText(model.gatewayId),
      provider,
      claude: model.harness === 'claude',
      openai: provider === 'openai' || OPENAI_SEGMENT.test(lastSegment),
      openWeights: openWeightIds.has(model.gatewayId),
    };
  });
}

function matchesFilter(
  entry: GatewayModelIndexEntry,
  filter: GatewayModelFilter,
  selected: ReadonlySet<string>,
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'claude':
      return entry.claude;
    case 'openai':
      return entry.openai;
    case 'open':
      return entry.openWeights;
    case 'on':
      return selected.has(entry.model.id);
  }
}

/** A query folded once, then matched against every entry. */
export interface GatewayQuery {
  readonly tokens: readonly string[];
  readonly folded: string;
}

export function foldGatewayQuery(query: string): GatewayQuery {
  return {
    // A token of separators only (`-`) folds away, so it isn't a search.
    tokens: gatewayQueryTokens(query)
      .map(foldGatewayText)
      .filter((token) => token.length > 0),
    folded: foldGatewayText(query),
  };
}

/**
 * How well every token matches: 0 an exact gateway ID, 1 each token starts
 * a word of the label or ID, 2 each token occurs somewhere, null no match.
 */
export function gatewayMatchRank(
  entry: GatewayModelIndexEntry,
  { tokens, folded }: GatewayQuery,
): 0 | 1 | 2 | null {
  if (tokens.length === 0) return null;
  if (folded === entry.gatewayId) return 0;
  const label = ` ${entry.label}`;
  const id = ` ${entry.gatewayId}`;
  let rank: 1 | 2 = 1;
  for (const token of tokens) {
    if (label.includes(` ${token}`) || id.includes(` ${token}`)) continue;
    if (!label.includes(token) && !id.includes(token)) return null;
    rank = 2;
  }
  return rank;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Regional duplicates (`bedrock/claude-…@eu-west-1`) sort right after their
// base ID rather than among other models.
function compareGatewayIds(left: string, right: string): number {
  const [leftBase = left, leftRegion = ''] = left.split('@', 2);
  const [rightBase = right, rightRegion = ''] = right.split('@', 2);
  return (
    compareText(leftBase, rightBase) || compareText(leftRegion, rightRegion)
  );
}

function providerLabel(provider: string): string {
  return (
    PROVIDER_NAMES[provider] ??
    `${provider.slice(0, 1).toUpperCase()}${provider.slice(1)}`
  );
}

/**
 * The rows the browser shows. With a query the list is flat and ranked, ID
 * order breaking ties. Without one it is grouped: Suggested first (in the
 * preset's order, and not repeated in their provider group), then one group
 * per provider prefix alphabetically, then Other for unprefixed IDs.
 */
export function gatewayModelListView({
  index,
  query,
  filter,
  selected,
  suggestedIds,
}: {
  readonly index: readonly GatewayModelIndexEntry[];
  readonly query: string;
  readonly filter: GatewayModelFilter;
  readonly selected: ReadonlySet<string>;
  readonly suggestedIds: readonly string[];
}): GatewayModelListView {
  const filtered = index.filter((entry) =>
    matchesFilter(entry, filter, selected),
  );
  const items: GatewayModelListItem[] = [];
  let optionCount = 0;
  const pushOption = (model: ModelGatewayModel): void => {
    optionCount += 1;
    items.push({ kind: 'option', key: model.id, model });
  };

  const prepared = foldGatewayQuery(query);
  if (prepared.tokens.length > 0) {
    filtered
      .flatMap((entry) => {
        const rank = gatewayMatchRank(entry, prepared);
        return rank === null ? [] : [{ entry, rank }];
      })
      .sort(
        (left, right) =>
          left.rank - right.rank ||
          compareGatewayIds(
            left.entry.model.gatewayId,
            right.entry.model.gatewayId,
          ),
      )
      .forEach(({ entry }) => pushOption(entry.model));
    return { items, optionCount };
  }

  const suggestedOrder = new Map(suggestedIds.map((id, at) => [id, at]));
  const suggested: GatewayModelIndexEntry[] = [];
  const groups = new Map<string | null, GatewayModelIndexEntry[]>();
  for (const entry of filtered) {
    if (suggestedOrder.has(entry.model.gatewayId)) {
      suggested.push(entry);
      continue;
    }
    const group = groups.get(entry.provider);
    if (group) group.push(entry);
    else groups.set(entry.provider, [entry]);
  }
  const pushGroup = (
    key: string,
    label: string,
    entries: readonly GatewayModelIndexEntry[],
  ): void => {
    if (entries.length === 0) return;
    items.push({ kind: 'header', key, label, count: entries.length });
    for (const entry of entries) pushOption(entry.model);
  };

  pushGroup(
    'suggested',
    'Suggested',
    suggested.sort(
      (left, right) =>
        (suggestedOrder.get(left.model.gatewayId) ?? 0) -
          (suggestedOrder.get(right.model.gatewayId) ?? 0) ||
        compareText(left.model.id, right.model.id),
    ),
  );
  const providers = [...groups.keys()]
    .filter((provider): provider is string => provider !== null)
    .sort(compareText);
  const byId = (
    left: GatewayModelIndexEntry,
    right: GatewayModelIndexEntry,
  ): number => compareGatewayIds(left.model.gatewayId, right.model.gatewayId);
  for (const provider of providers) {
    pushGroup(
      `provider:${provider}`,
      providerLabel(provider),
      (groups.get(provider) ?? []).sort(byId),
    );
  }
  pushGroup('other', 'Other', (groups.get(null) ?? []).sort(byId));
  return { items, optionCount };
}

/**
 * Character indices of each query token where it occurs literally in `text`,
 * ignoring case. A token that matches only after separator folding (`5.5`
 * against `5-5`) still matches in search but shows no highlight here; this
 * is not a second matcher.
 */
export function gatewayHighlightIndices(text: string, query: string): number[] {
  const lower = text.toLowerCase();
  const indices = new Set<number>();
  for (const token of gatewayQueryTokens(query)) {
    // Search ignores a token of separators only, so it highlights nothing.
    if (foldGatewayText(token).length === 0) continue;
    const needle = token.toLowerCase();
    let from = lower.indexOf(needle);
    while (from !== -1) {
      for (let at = from; at < from + needle.length; at += 1) indices.add(at);
      from = lower.indexOf(needle, from + needle.length);
    }
  }
  return [...indices].sort((left, right) => left - right);
}

/** Models a fresh selection turns on, by model ID, stored models first. */
export function initialGatewaySelection({
  stored,
  candidates,
  suggestedIds,
  reservedCount,
  limit,
}: {
  /** Models already saved that stay rows (a re-setup); none on refresh. */
  readonly stored: readonly ModelGatewayModel[];
  /** Discovered models the gateway doesn't have yet. */
  readonly candidates: readonly ModelGatewayModel[];
  /** The preset's suggested gateway IDs, in its order; empty for custom. */
  readonly suggestedIds: readonly string[];
  /** Saved models that count against the limit but aren't rows. */
  readonly reservedCount: number;
  readonly limit: number;
}): string[] {
  const chosen = stored.map((model) => model.id);
  if (suggestedIds.length > 0) {
    const byGatewayId = new Map(
      candidates.map((model) => [model.gatewayId, model]),
    );
    for (const gatewayId of suggestedIds) {
      const model = byGatewayId.get(gatewayId);
      if (!model) continue;
      if (reservedCount + chosen.length >= limit) break;
      chosen.push(model.id);
    }
    return chosen;
  }
  if (reservedCount + stored.length + candidates.length <= limit)
    return [...chosen, ...candidates.map((model) => model.id)];
  return chosen;
}
