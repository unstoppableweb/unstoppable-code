// ---------------------------------------------------------------------------
// Related-item computation for detail pages (CAN-2382)
//
// Pure, deterministic helpers that derive the "Related pipelines", "Similar
// pipelines", and "Related skills and plugins" sections shown on skill,
// plugin, and pipeline detail surfaces. Relationships come from declared
// dependencies first (`plugin_collections` capability refs resolved by the
// `pipelines:list-capability-refs` IPC), then curated/catalog metadata
// (categories, marketplaces, sources). Every function excludes the current
// item, deduplicates, and caps its result list; unmatched (not installed)
// capability refs are never returned as recommendations.
// ---------------------------------------------------------------------------

import { pluginDisplayName } from '@canopy/ui-shared';
import type {
  PipelineCapabilityRefsEntry,
  PipelineCapabilitySelection,
  PipelineCapabilitySummary,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { MarketplaceInfo } from '@canopy/execution-engine/types/plugins';
import { entryIdForSelection } from '@canopy/desktop-shared/lib/capability-entry-id';

export { entryIdForSelection };
import { TRIGGER_META } from '@/components/pipeline/pipeline-trigger-meta';

/** The capability whose detail page is asking for related items. */
export type CapabilitySubject =
  | { kind: 'skill'; sourceId: string; skillName: string }
  | { kind: 'plugin'; marketplaceId: string; pluginName: string };

export interface RelatedPipelineItem {
  id: string;
  source: 'bundled' | 'user' | 'project';
  name: string;
  /** Pipeline icon (emoji), empty when the pipeline declares none. */
  icon: string;
  filePath?: string;
  reason: string;
}

/**
 * Compound identity for a pipeline across sources. Bundled, user, and project
 * pipelines live in separate namespaces, so a bare id is ambiguous — every
 * cross-pipeline map in this module keys on this form.
 */
export function pipelineRefsKey(
  info: Pick<PipelineInfo, 'id' | 'source'>,
): string {
  return `${info.source}:${info.id}`;
}

export interface SimilarPipelineItem {
  info: PipelineInfo;
  score: number;
  reasons: string[];
}

export interface RelatedCapabilityItem {
  /** Stable dedupe/react key (`skill:` / `plugin:` prefixed identity). */
  key: string;
  kind: 'skill' | 'plugin';
  title: string;
  subtitle?: string;
  reason?: string;
  /** Unified Plugins-page entry id this item navigates to. */
  entryId: string;
  selection: PipelineCapabilitySelection;
}

export const RELATED_ITEMS_LIMIT = 5;

function fold(value: string): string {
  return value.trim().toLowerCase();
}

function selectionMatchesSubject(
  selection: PipelineCapabilitySelection,
  subject: CapabilitySubject,
): boolean {
  if (selection.kind === 'skill' && subject.kind === 'skill') {
    return (
      fold(selection.sourceId) === fold(subject.sourceId) &&
      fold(selection.skillName) === fold(subject.skillName)
    );
  }
  if (selection.kind === 'plugin' && subject.kind === 'plugin') {
    return (
      fold(selection.marketplaceId) === fold(subject.marketplaceId) &&
      fold(selection.pluginName) === fold(subject.pluginName)
    );
  }
  return false;
}

function selectionKey(selection: PipelineCapabilitySelection): string {
  return selection.kind === 'skill'
    ? `skill:${fold(selection.sourceId)}:${fold(selection.skillName)}`
    : `plugin:${fold(selection.marketplaceId)}:${fold(selection.pluginName)}`;
}

/** Stable similarity identity for a raw ref that could not be resolved. */
export function rawCapabilitySimilarityKey(key: string): string {
  return `raw:${fold(key)}`;
}

/**
 * Stable similarity identity for a capability summary. Supported portable-ref
 * syntaxes that resolve to the same installed selection intentionally share a
 * key; unresolved refs retain their folded raw syntax as a fail-soft fallback.
 */
export function capabilitySimilarityKey(
  capability: Pick<
    PipelineCapabilitySummary,
    'key' | 'matchState' | 'selection'
  >,
): string {
  return capability.matchState === 'matched' && capability.selection
    ? selectionKey(capability.selection)
    : rawCapabilitySimilarityKey(capability.key);
}

/**
 * Pipelines whose declared `plugin_collections` resolve to the given
 * skill/plugin. The reason names the declaring collection so the relationship
 * is explained ("Required by collection …").
 */
export function findRelatedPipelines(
  subject: CapabilitySubject,
  entries: readonly PipelineCapabilityRefsEntry[],
): RelatedPipelineItem[] {
  const items: RelatedPipelineItem[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const capability = entry.capabilities.find(
      (candidate) =>
        candidate.matchState === 'matched' &&
        candidate.selection !== undefined &&
        selectionMatchesSubject(candidate.selection, subject),
    );
    if (!capability) {
      continue;
    }
    const dedupeKey = `${entry.source}:${entry.id}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    items.push({
      id: entry.id,
      source: entry.source,
      name: entry.name,
      icon: entry.icon,
      filePath: entry.filePath,
      reason: `${capability.required ? 'Required' : 'Used'} by collection "${capability.collectionName}"`,
    });
    if (items.length >= RELATED_ITEMS_LIMIT) {
      break;
    }
  }
  return items;
}

const TEXT_TOKEN_STOPWORDS = new Set([
  'and',
  'for',
  'from',
  'into',
  'pipeline',
  'that',
  'the',
  'this',
  'with',
  'your',
]);

function textTokens(
  info: Pick<PipelineInfo, 'name' | 'description'>,
): Set<string> {
  const tokens = `${info.name} ${info.description}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !TEXT_TOKEN_STOPWORDS.has(token));
  return new Set(tokens);
}

/**
 * Rank other pipelines by similarity to the current one. Structural signals
 * dominate (shared resolved capability refs, then shared trigger types); a
 * bounded name/description token overlap breaks ties. Candidates below the
 * minimum score are dropped so the section stays meaningful.
 */
export function findSimilarPipelines(
  current: {
    info: Pick<
      PipelineInfo,
      'id' | 'source' | 'name' | 'description' | 'triggerTypes'
    >;
    capabilityKeys: readonly string[];
  },
  candidates: readonly PipelineInfo[],
  /** Capability keys per pipeline, keyed by {@link pipelineRefsKey}. */
  refsByPipeline: ReadonlyMap<string, readonly string[]>,
): SimilarPipelineItem[] {
  const currentKeys = new Set(current.capabilityKeys);
  const currentTriggers = new Set(current.info.triggerTypes ?? []);
  const currentTokens = textTokens({
    name: current.info.name,
    description: current.info.description,
  });

  const scored: SimilarPipelineItem[] = [];
  const seenCandidates = new Set<string>();
  for (const candidate of candidates) {
    const candidateIdentity = pipelineRefsKey(candidate);
    if (seenCandidates.has(candidateIdentity)) {
      continue;
    }
    seenCandidates.add(candidateIdentity);
    if (
      candidate.id === current.info.id &&
      candidate.source === current.info.source
    ) {
      continue;
    }

    const reasons: string[] = [];
    let score = 0;

    const candidateKeys = new Set(refsByPipeline.get(candidateIdentity) ?? []);
    const sharedRefs = Array.from(candidateKeys).filter((key) =>
      currentKeys.has(key),
    );
    if (sharedRefs.length > 0) {
      // A single shared declared capability outranks the maximum text-overlap
      // contribution: declared dependencies are the strongest signal.
      score += sharedRefs.length * 4;
      reasons.push(
        sharedRefs.length === 1
          ? 'Uses the same skill or plugin'
          : `Uses ${sharedRefs.length} of the same skills or plugins`,
      );
    }

    const sharedTriggers = (candidate.triggerTypes ?? []).filter((trigger) =>
      currentTriggers.has(trigger),
    );
    if (sharedTriggers.length > 0 && currentTriggers.size > 0) {
      score += sharedTriggers.length * 2;
      const labels = sharedTriggers
        .map((trigger) => TRIGGER_META[trigger]?.label ?? trigger)
        .join(', ');
      reasons.push(`Same trigger: ${labels}`);
    }

    const candidateTokens = textTokens(candidate);
    let overlap = 0;
    candidateTokens.forEach((token) => {
      if (currentTokens.has(token)) {
        overlap += 1;
      }
    });
    if (overlap >= 2) {
      score += Math.min(overlap, 3);
      reasons.push('Similar name or description');
    }

    if (score >= 2) {
      scored.push({ info: candidate, score, reasons });
    }
  }

  scored.sort(
    (a, b) => b.score - a.score || a.info.name.localeCompare(b.info.name),
  );
  return scored.slice(0, RELATED_ITEMS_LIMIT);
}

/**
 * The skills and plugins a pipeline declares, as navigable related items.
 * Only refs that resolved against the installed catalog are returned —
 * an unmatched ref has no detail page to open.
 */
export function findRelatedCapabilitiesForPipeline(
  capabilities: readonly PipelineCapabilitySummary[],
  marketplaces: readonly Pick<MarketplaceInfo, 'id' | 'curated'>[],
): RelatedCapabilityItem[] {
  const items: RelatedCapabilityItem[] = [];
  const seen = new Set<string>();
  for (const capability of capabilities) {
    if (capability.matchState !== 'matched' || !capability.selection) {
      continue;
    }
    const key = selectionKey(capability.selection);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({
      key,
      kind: capability.kind,
      title: capability.displayName,
      subtitle: capability.displaySource,
      reason: `${capability.required ? 'Required' : 'Used'} by collection "${capability.collectionName}"`,
      entryId: entryIdForSelection(capability.selection, marketplaces),
      selection: capability.selection,
    });
    if (items.length >= RELATED_ITEMS_LIMIT) {
      break;
    }
  }
  return items;
}

/**
 * Skills and plugins related to the given skill/plugin, from catalog
 * metadata. Priority order: containment (a plugin that includes a skill with
 * the subject's name, or vice versa), then same source/category, then same
 * marketplace. The subject itself is always excluded.
 */
export function findRelatedCapabilitiesForSubject(
  subject: CapabilitySubject,
  catalog: {
    skills: readonly InstalledSkillInfo[];
    marketplaces: readonly MarketplaceInfo[];
  },
): RelatedCapabilityItem[] {
  const items: RelatedCapabilityItem[] = [];
  const seen = new Set<string>();

  const push = (
    selection: PipelineCapabilitySelection,
    title: string,
    subtitle: string | undefined,
    reason: string,
  ): void => {
    if (items.length >= RELATED_ITEMS_LIMIT) {
      return;
    }
    if (selectionMatchesSubject(selection, subject)) {
      return;
    }
    const key = selectionKey(selection);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    items.push({
      key,
      kind: selection.kind,
      title,
      subtitle,
      reason,
      entryId: entryIdForSelection(selection, catalog.marketplaces),
      selection,
    });
  };

  if (subject.kind === 'skill') {
    // Plugins that bundle a skill with the same name — the packaged form of
    // this capability.
    for (const marketplace of catalog.marketplaces) {
      for (const plugin of marketplace.plugins) {
        const containsSkill = plugin.details?.skills.some(
          (skill) => fold(skill.name) === fold(subject.skillName),
        );
        if (containsSkill) {
          push(
            {
              kind: 'plugin',
              marketplaceId: marketplace.id,
              pluginName: plugin.name,
            },
            pluginDisplayName(plugin),
            marketplace.name,
            `Includes a "${subject.skillName}" skill`,
          );
        }
      }
    }
    // Other skills installed from the same source (same repo/collection).
    for (const skill of catalog.skills) {
      if (fold(skill.sourceId) !== fold(subject.sourceId)) {
        continue;
      }
      push(
        {
          kind: 'skill',
          sourceId: skill.sourceId,
          skillName: skill.name,
        },
        skill.name,
        skill.description || undefined,
        'From the same source',
      );
    }
    return items;
  }

  const subjectMarketplace = catalog.marketplaces.find(
    (marketplace) => fold(marketplace.id) === fold(subject.marketplaceId),
  );
  const subjectPlugin = subjectMarketplace?.plugins.find(
    (plugin) => fold(plugin.name) === fold(subject.pluginName),
  );

  // Skills installed standalone that this plugin also bundles.
  for (const pluginSkill of subjectPlugin?.details?.skills ?? []) {
    const installed = catalog.skills.find(
      (skill) => fold(skill.name) === fold(pluginSkill.name),
    );
    if (installed) {
      push(
        {
          kind: 'skill',
          sourceId: installed.sourceId,
          skillName: installed.name,
        },
        installed.name,
        installed.description || undefined,
        'Included in this plugin',
      );
    }
  }

  // Plugins sharing the subject's category, nearest marketplace first.
  const category = subjectPlugin?.category;
  if (category) {
    for (const marketplace of catalog.marketplaces) {
      for (const plugin of marketplace.plugins) {
        if (fold(plugin.category ?? '') !== fold(category)) {
          continue;
        }
        push(
          {
            kind: 'plugin',
            marketplaceId: marketplace.id,
            pluginName: plugin.name,
          },
          pluginDisplayName(plugin),
          marketplace.name,
          `Same category: ${category}`,
        );
      }
    }
  }

  // Remaining plugins from the same marketplace.
  for (const plugin of subjectMarketplace?.plugins ?? []) {
    push(
      {
        kind: 'plugin',
        marketplaceId: subjectMarketplace?.id ?? subject.marketplaceId,
        pluginName: plugin.name,
      },
      pluginDisplayName(plugin),
      subjectMarketplace?.name,
      'From the same marketplace',
    );
  }

  return items;
}
