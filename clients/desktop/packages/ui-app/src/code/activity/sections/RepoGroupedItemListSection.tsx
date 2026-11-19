'use client';

import { useState, type JSX } from 'react';
import { Stack, Disclosure } from '@canopy/ui-shared/components';
import { ItemListSection, type ActivityListItem } from './ItemListSection';

export interface RepoGroupedEntry {
  readonly repoId?: string;
  readonly repoName?: string;
  readonly target?: string;
  /** Active run inside this entry; keeps its repo bucket auto-expanded. */
  readonly running?: boolean;
  readonly item: ActivityListItem;
}

export interface RepoBucket {
  readonly repoId: string;
  readonly repoName: string;
  readonly entries: RepoGroupedEntry[];
}

export function groupByRepo(entries: readonly RepoGroupedEntry[]): {
  repoless: RepoGroupedEntry[];
  repos: RepoBucket[];
} {
  const repoless: RepoGroupedEntry[] = [];
  const repos = new Map<string, RepoBucket>();
  for (const entry of entries) {
    if (entry.target !== 'workspace-repo' || !entry.repoId) {
      repoless.push(entry);
      continue;
    }
    const bucket = repos.get(entry.repoId);
    if (bucket) bucket.entries.push(entry);
    else
      repos.set(entry.repoId, {
        repoId: entry.repoId,
        repoName: entry.repoName ?? entry.repoId,
        entries: [entry],
      });
  }
  return { repoless, repos: Array.from(repos.values()) };
}

export interface RepoGroupedItemListSectionProps {
  readonly entries: readonly RepoGroupedEntry[];
  readonly kind: 'scripts' | 'hooks';
}

export function RepoGroupedItemListSection({
  entries,
  kind,
}: RepoGroupedItemListSectionProps): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  if (entries.length === 0)
    return (
      <p
        className="text-xs fg-secondary"
        data-testid={`activity-${kind}-empty`}
      >
        No {kind}.
      </p>
    );
  const grouped = groupByRepo(entries);
  return (
    <Stack gap="inline" data-testid={`activity-${kind}`}>
      {grouped.repoless.length > 0 && (
        <ItemListSection
          emptyLabel={`No ${kind}.`}
          items={grouped.repoless.map((entry) => entry.item)}
        />
      )}
      {grouped.repos.map((bucket) => {
        const hasRunningChild = bucket.entries.some(
          (entry) => entry.running === true,
        );
        const open = expanded.has(bucket.repoId) || hasRunningChild;
        return (
          <Disclosure
            key={bucket.repoId}
            variant="box"
            label={bucket.repoName}
            meta={`${bucket.entries.length} ${kind}`}
            open={open}
            onOpenChange={(): void =>
              setExpanded((previous) => {
                const next = new Set(previous);
                if (next.has(bucket.repoId)) next.delete(bucket.repoId);
                else next.add(bucket.repoId);
                return next;
              })
            }
            dataTestId={`remote-control-${kind}-repo`}
            toggleTestId={`remote-control-${kind}-repo-header`}
          >
            <ItemListSection
              emptyLabel={`No ${kind}.`}
              items={bucket.entries.map((entry) => entry.item)}
            />
          </Disclosure>
        );
      })}
    </Stack>
  );
}
