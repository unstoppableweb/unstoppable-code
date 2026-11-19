'use client';

import { useMemo, type ComponentType, type JSX, type ReactNode } from 'react';
import type { McpServerLogoProps } from '@canopy/ui-shared';
import {
  ComponentSection,
  CustomizeEntryLogo,
  RelatedItemsSection,
  customizePublisherReplayClass,
  customizePublisherText,
} from '@canopy/ui-shared/components';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib/unified-plugin-entry';
import {
  customizeRelatedEntries,
  type CustomizeRelatedSubject,
} from './customizeRelated';
import { customizeDiscoveryIdentity } from './customizeCopyIdentity';

/** Kinds whose names are a user's own, masked in session replay. */
const AUTHORED_KINDS: ReadonlySet<UnifiedPluginEntry['kind']> = new Set([
  'pipeline',
  'automation',
  'collection',
  'agent',
]);

/**
 * New Customize's Related section on every detail page, desktop and Portal:
 * `customizeRelatedEntries` over the host's entries, each opening its own
 * page. A failed read of those entries is said here, with its retry.
 */
export function CustomizeRelatedSection({
  subject,
  entries,
  onOpenEntry,
  loading = false,
  failure,
  McpServerLogoComponent,
}: {
  /** The host's logo component, as its tiles use. */
  McpServerLogoComponent?: ComponentType<McpServerLogoProps>;
  subject: UnifiedPluginEntry | CustomizeRelatedSubject;
  entries: readonly UnifiedPluginEntry[];
  onOpenEntry: (entry: UnifiedPluginEntry) => void;
  loading?: boolean;
  /** Some entries couldn't be read: said under the list. */
  failure?: ReactNode;
}): JSX.Element {
  const related = useMemo(
    () =>
      customizeRelatedEntries(
        'ref' in subject ? customizeDiscoveryIdentity(subject) : subject,
        entries.map(customizeDiscoveryIdentity),
      ),
    [subject, entries],
  );
  const list = (
    <RelatedItemsSection
      title="Related"
      presentation="list"
      emptyLabel="Nothing related yet."
      loading={loading}
      testId="customize-related-section"
      // A partial read's failure, inside the section under its rows.
      footer={failure}
      items={related.map(({ entry, reason }) => ({
        key: entry.id,
        title: entry.name,
        ...(customizePublisherText(entry)
          ? {
              subtitle: customizePublisherText(entry),
              // The tile's own replay class: a person's name is blocked.
              subtitleReplayClass: customizePublisherReplayClass(entry),
            }
          : {}),
        reasonInline: true,
        ...(entry.typeLabel ? { badge: entry.typeLabel } : {}),
        kind: entry.kind,
        reason,
        privateTitle: AUTHORED_KINDS.has(entry.kind),
        // The tile's logo chain and plate, at the row's size.
        logo: (
          <CustomizeEntryLogo
            entry={entry}
            size={28}
            {...(McpServerLogoComponent ? { McpServerLogoComponent } : {})}
          />
        ),
        onOpen: (): void => onOpenEntry(entry),
      }))}
    />
  );
  if (!failure || related.length > 0) return list;
  // Nothing listed: the failure stands in the section alone.
  return (
    <div data-testid="customize-related-section">
      <ComponentSection title="Related">{failure}</ComponentSection>
    </div>
  );
}
