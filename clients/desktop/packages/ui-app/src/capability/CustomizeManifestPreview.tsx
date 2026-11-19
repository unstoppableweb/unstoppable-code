'use client';

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { toAppError } from '@canopy/protocol/app-errors';
import type {
  HarnessCompatibility,
  PluginManifestPreview,
  PluginManifestPreviewResult,
} from '@canopy/protocol/plugins';
import { customizeWorksWithRows } from '@canopy/ui-shared/components';
import { WORKS_WITH_LEVELS } from '@canopy/ui-shared/lib';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib/unified-plugin-entry';

/**
 * A plugin not added yet with what its light preview read (spec 3b): the
 * preview's compatibility fills only the harnesses nothing had settled, and
 * its skill names fill an entry that named none.
 */
export function customizeEntryWithManifestPreview(
  entry: UnifiedPluginEntry,
  preview: PluginManifestPreview,
): UnifiedPluginEntry {
  const own = entry.harnessCompatibility;
  const read = preview.compatibility;
  const harnessCompatibility: HarnessCompatibility | undefined = read
    ? {
        version: own?.version ?? read.version,
        rulesVersion: own?.rulesVersion ?? read.rulesVersion,
        // The listing's own results win; the preview adds the rest.
        harnesses: { ...read.harnesses, ...own?.harnesses },
      }
    : own;
  const results = Object.entries(harnessCompatibility?.harnesses ?? {});
  const harnessRows = entry.harnessRows?.map((row) => {
    if (row.installation !== 'Unknown until added') return row;
    const result = results.find(([harness]) => harness === row.id)?.[1];
    if (result === undefined) return row;
    return {
      ...row,
      installation: WORKS_WITH_LEVELS.has(result.level)
        ? 'Not installed'
        : 'Not supported',
    } satisfies typeof row;
  });
  return {
    ...entry,
    ...(harnessCompatibility ? { harnessCompatibility } : {}),
    ...(harnessRows ? { harnessRows } : {}),
    ...(entry.bundledSkillNames?.length || preview.skills.length === 0
      ? {}
      : { bundledSkillNames: preview.skills }),
  };
}

/**
 * Whether a page has anything left for a preview to settle: a harness
 * still unknown, or Contents no installed copy has read yet (a listing's
 * own names may be only part of what the repository holds).
 */
function needsPreview(entry: UnifiedPluginEntry): boolean {
  if (entry.kind !== 'plugin' || entry.state !== 'available') return false;
  const copyRead = (entry.marketplaceListings ?? []).some(
    (listing) =>
      listing.state === 'installed' || listing.state === 'needs-auth',
  );
  return (
    !copyRead ||
    customizeWorksWithRows(entry).some(
      (row) => row.installation === 'Unknown until added',
    )
  );
}

type PreviewRead =
  | { readonly key: string; readonly phase: 'checking' }
  | {
      readonly key: string;
      readonly phase: 'done';
      readonly preview: PluginManifestPreview | null;
    };

/**
 * Reads a plugin's light preview once per page, while anything is still
 * unknown, and hands the page the entry with what it read. `checking` is
 * true while the read is out; a failed read changes nothing, so the
 * marketplace's own harness stays supported and the rest Unknown until added.
 */
export function CustomizeManifestPreview({
  entry,
  load,
  enabled = true,
  children,
}: {
  entry: UnifiedPluginEntry;
  /** Off (New Customize off): no read, the entry as it is. */
  enabled?: boolean;
  /** The host's preview read; `null` when it couldn't answer. */
  load: () => Promise<PluginManifestPreviewResult | null>;
  children: (
    shown: UnifiedPluginEntry,
    checking: boolean,
    preview: PluginManifestPreview | undefined,
  ) => ReactNode;
}): JSX.Element {
  const wanted = enabled && needsPreview(entry);
  const key = entry.id;
  const [read, setRead] = useState<PreviewRead | null>(null);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    setRead({ key, phase: 'checking' });
    loader
      .current()
      .then((result) => {
        if (!cancelled)
          setRead({
            key,
            phase: 'done',
            preview: result?.ok ? result.preview : null,
          });
      })
      .catch((failure: unknown) => {
        // A failed read leaves the page as it was: the marketplace's own
        // harness supported, the rest Unknown until added.
        toAppError(failure);
        if (!cancelled) setRead({ key, phase: 'done', preview: null });
      });
    return (): void => {
      cancelled = true;
    };
  }, [key, wanted]);
  const current = read?.key === key ? read : null;
  const checking = wanted && (current === null || current.phase === 'checking');
  const shown =
    current?.phase === 'done' && current.preview
      ? customizeEntryWithManifestPreview(entry, current.preview)
      : entry;
  return (
    <>
      {children(
        shown,
        checking,
        current?.phase === 'done' ? (current.preview ?? undefined) : undefined,
      )}
    </>
  );
}
