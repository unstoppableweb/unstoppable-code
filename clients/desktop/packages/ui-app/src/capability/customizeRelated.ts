import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib/unified-plugin-entry';
import { customizePublisherText } from '@canopy/ui-shared/components';

/** How many related items a detail page lists. */
export const CUSTOMIZE_RELATED_LIMIT = 5;

export interface CustomizeRelatedEntry {
  readonly entry: UnifiedPluginEntry;
  /** Why it's listed: the only place the category shows on a detail page. */
  readonly reason: string;
}

/** Detail-page facts used when the subject has no tile in the browse results. */
export type CustomizeRelatedSubject = Pick<
  UnifiedPluginEntry,
  | 'id'
  | 'kind'
  | 'categories'
  | 'bundledBy'
  | 'installedEntryId'
  | 'marketplaceGroup'
  | 'integrationKey'
  | 'marketplaceSourceName'
> & { publisher?: string };

function fold(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The items related to a Customize entry, from the host's list of entries,
 * the same on desktop and the Portal: what it contains or what contains it,
 * then the same publisher, the same category and the same marketplace. Other
 * copies of the same item (its marketplace group, its integration) are not
 * related items.
 */
export function customizeRelatedEntries(
  subject: UnifiedPluginEntry | CustomizeRelatedSubject,
  entries: readonly UnifiedPluginEntry[],
  limit = CUSTOMIZE_RELATED_LIMIT,
): CustomizeRelatedEntry[] {
  const related: CustomizeRelatedEntry[] = [];
  const seen = new Set<string>([subject.id]);
  if (subject.installedEntryId) seen.add(subject.installedEntryId);
  const sameItem = (entry: UnifiedPluginEntry): boolean =>
    entry.installedEntryId === subject.id ||
    (subject.marketplaceGroup !== undefined &&
      entry.marketplaceGroup === subject.marketplaceGroup) ||
    (subject.integrationKey !== undefined &&
      entry.integrationKey === subject.integrationKey);
  const add = (
    entry: UnifiedPluginEntry,
    reason: string,
    contained = false,
  ): void => {
    if (related.length >= limit || seen.has(entry.id)) return;
    if (entry.pluginServerResult) return;
    // Bundled skills open their parent plugin, which may be this detail.
    if (
      entry.ref.type === 'plugin-skill' &&
      entry.bundledBy &&
      (entry.bundledBy.entryId === subject.id ||
        entry.bundledBy.entryId === subject.installedEntryId)
    )
      return;
    // A contained item may share its plugin's integration; it is still
    // related, not another copy.
    if (!contained && sameItem(entry)) return;
    seen.add(entry.id);
    related.push({ entry, reason });
  };
  const addWhere = (
    match: (entry: UnifiedPluginEntry) => boolean,
    reason: string,
    contained = false,
  ): void => {
    for (const entry of entries)
      if (match(entry)) add(entry, reason, contained);
  };

  // What it contains, and what contains it: only the list's own links,
  // never a guess from a shared name.
  addWhere(
    (entry) => entry.bundledBy?.entryId === subject.id,
    'Included in this plugin',
    true,
  );
  addWhere(
    (entry) => entry.id === subject.bundledBy?.entryId,
    subject.kind === 'skill'
      ? 'Includes this skill'
      : subject.kind === 'app'
        ? 'Includes this MCP server'
        : 'Includes this item',
    true,
  );
  // The same publisher, as the tiles name it (a publisher, "You",
  // "Shared by X").
  const publisherOf = (entry: UnifiedPluginEntry): string | undefined => {
    const name = customizePublisherText(entry);
    return name ? fold(name) : undefined;
  };
  const publisher =
    'ref' in subject ? publisherOf(subject) : fold(subject.publisher ?? '');
  if (publisher)
    addWhere(
      (entry) => publisherOf(entry) === publisher,
      'From the same publisher',
    );
  for (const category of subject.categories)
    addWhere(
      (entry) =>
        entry.categories.some((other) => fold(other) === fold(category)),
      `Same category: ${category}`,
    );
  const marketplace = subject.marketplaceSourceName
    ? fold(subject.marketplaceSourceName)
    : undefined;
  if (marketplace)
    addWhere(
      (entry) =>
        entry.marketplaceSourceName !== undefined &&
        fold(entry.marketplaceSourceName) === marketplace,
      'From the same marketplace',
    );
  return related;
}
