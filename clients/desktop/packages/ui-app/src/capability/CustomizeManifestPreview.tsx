'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { toAppError } from '@canopy/protocol/app-errors';
import type {
  HarnessCompatibility,
  PluginManifestPreview,
  PluginManifestPreviewResult,
} from '@canopy/protocol/plugins';
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
 * Where the preview read stands, for the Contents a page shows before Add:
 * still out, failed (with a retry), answered, `partial` when the answer left
 * part of the repository unread (with a retry), or `listing` when there is
 * nothing beyond the listing to read, so the listing's contents are all that
 * is known. A page waiting on its first answer, or one whose read failed or
 * was partial, never claims the plugin's contents arrive only with Add, nor
 * that it has none.
 */
export interface CustomizeContentsRead {
  readonly state: 'checking' | 'unavailable' | 'partial' | 'read' | 'listing';
  readonly retry?: () => void;
}

type PreviewRead =
  | {
      readonly key: string;
      readonly phase: 'checking';
      /** The last preview of this source, shown while it is read again. */
      readonly kept?: PluginManifestPreview;
    }
  | {
      readonly key: string;
      readonly phase: 'done';
      readonly preview: PluginManifestPreview | null;
      /** The last preview of this source, kept when reading again failed. */
      readonly kept?: PluginManifestPreview;
      /**
       * The read answered that it has nothing to read for this source (a
       * local listing without a README, or a source it cannot preview), so
       * the listing's own contents stand and reading again changes nothing.
       */
      readonly nothingToRead?: true;
    };

/**
 * Reads a light preview once per not-added plugin page, even when a copy
 * already filled Works with and Contents (it may not have the README).
 * `checking` is true while the read is out; a failed read changes nothing, so the
 * marketplace's own harness stays supported and the rest Unknown until added,
 * and `contents` says it failed so the page can offer to read again.
 */
export function CustomizeManifestPreview({
  entry,
  load,
  enabled = true,
  sourceKey = '',
  notAddedYet = entry.state === 'available',
  children,
}: {
  entry: UnifiedPluginEntry;
  /**
   * Whether the plugin is not added yet, when the host knows better than the
   * entry's state (a curated plugin whose content is on disk reads
   * `installed` before any harness has it). The summary, this read and the
   * checkout reader share the host's one answer.
   */
  notAddedYet?: boolean;
  /**
   * The plugin's source as the host knows it (marketplace, name, where its
   * files come from). A read is for one source: when it changes under the
   * same entry, the read out or settled is dropped and a new one starts.
   */
  sourceKey?: string;
  /** Off (New Customize off): no read, the entry as it is. */
  enabled?: boolean;
  /**
   * The host's preview read; `null` when it couldn't answer. `retry` is set
   * when the user asks again after a failed read, so the host reads afresh
   * instead of answering with the failure it remembers.
   */
  load: (options: {
    readonly retry: boolean;
  }) => Promise<PluginManifestPreviewResult | null>;
  children: (
    shown: UnifiedPluginEntry,
    checking: boolean,
    preview: PluginManifestPreview | undefined,
    contents: CustomizeContentsRead | undefined,
  ) => ReactNode;
}): JSX.Element {
  const wanted = enabled && entry.kind === 'plugin' && notAddedYet;
  // Fixed before the read goes out; a late answer for another key is dropped.
  const key = JSON.stringify([entry.id, sourceKey]);
  const [read, setRead] = useState<PreviewRead | null>(null);
  // Bumped by a retry, so the same source is read again, afresh. The key it
  // was asked for is used up by the next read, so a later read of that source,
  // or another one, is an ordinary read.
  const [attempt, setAttempt] = useState(0);
  const retryKey = useRef<string | null>(null);
  const retry = useCallback((): void => {
    retryKey.current = key;
    setAttempt((count) => count + 1);
  }, [key]);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    // Try again keeps what the page shows of this source until a read
    // replaces it; a failed one leaves it beside the failure.
    const keptOf = (
      previous: PreviewRead | null,
    ): PluginManifestPreview | undefined =>
      previous?.key !== key
        ? undefined
        : previous.phase === 'done'
          ? (previous.preview ?? previous.kept)
          : previous.kept;
    const failed = (): void =>
      setRead((previous) => {
        const kept = keptOf(previous);
        return { key, phase: 'done', preview: null, ...(kept ? { kept } : {}) };
      });
    setRead((previous) => {
      const kept = keptOf(previous);
      return { key, phase: 'checking', ...(kept ? { kept } : {}) };
    });
    const fresh = retryKey.current === key;
    retryKey.current = null;
    loader
      .current({ retry: fresh })
      .then((result) => {
        if (cancelled) return;
        if (result?.ok === false && result.reason === 'unsupported_source')
          setRead({ key, phase: 'done', preview: null, nothingToRead: true });
        else if (result?.ok)
          setRead({ key, phase: 'done', preview: result.preview });
        else failed();
      })
      .catch((failure: unknown) => {
        // A failed read leaves the page as it was: the marketplace's own
        // harness supported, the rest Unknown until added.
        toAppError(failure);
        if (!cancelled) failed();
      });
    return (): void => {
      cancelled = true;
    };
  }, [key, wanted, attempt]);
  const current = wanted && read?.key === key ? read : null;
  const checking = wanted && (current === null || current.phase === 'checking');
  const known =
    current?.phase === 'done'
      ? (current.preview ?? current.kept)
      : current?.kept;
  const shown = known ? customizeEntryWithManifestPreview(entry, known) : entry;
  const contents: CustomizeContentsRead | undefined = !wanted
    ? undefined
    : checking
      ? { state: 'checking' }
      : current?.phase === 'done' && current.nothingToRead === true
        ? { state: 'listing' }
        : current?.phase === 'done' && current.preview === null
          ? { state: 'unavailable', retry }
          : current?.phase === 'done' && current.preview?.partial === true
            ? { state: 'partial', retry }
            : { state: 'read' };
  return <>{children(shown, checking, known, contents)}</>;
}
