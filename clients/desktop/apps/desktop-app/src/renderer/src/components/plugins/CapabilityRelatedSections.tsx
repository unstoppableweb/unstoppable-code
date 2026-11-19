import { useEffect, useMemo, useState, type JSX } from 'react';
import { useCustomizeDiscoveryEnabled } from '@canopy/ui-app/customize-discovery';
import { RelatedItemsSection } from '@canopy/ui-shared';
import { marketplaceTitleCase } from '@canopy/ui-shared/lib';
import { PIPELINE_SOURCE_META } from '../pipeline/pipeline-source-meta';
import {
  useNavigationStore,
  type PipelineEditDeepLink,
} from '@/stores/navigationStore';
import { useActiveWorktreeCwd } from '@/hooks/useActiveWorktreeCwd';
import { useInstalledMarketplaces } from '@/hooks/useInstalledMarketplaces';
import { useSkillList } from '@/hooks/useSkillList';
import {
  entryIdForSelection,
  findRelatedCapabilitiesForSubject,
  findRelatedPipelines,
  type CapabilitySubject,
} from '@/lib/relatedCapabilities';
import type { PipelineCapabilityRefsEntry } from '@canopy/execution-engine/types/pipeline';

/**
 * Fetch the per-pipeline capability summaries, including project-local
 * pipelines when a worktree cwd is known. Fail-soft: any IPC failure
 * (including a missing preload bridge in tests) resolves to an empty list so
 * the sections fall back to their empty states.
 */
function usePipelineCapabilityRefs(cwd?: string): {
  entries: PipelineCapabilityRefsEntry[];
  loading: boolean;
} {
  const [entries, setEntries] = useState<PipelineCapabilityRefsEntry[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    // Reset on cwd change so a worktree switch can't leave stale project
    // pipelines (or a stale filePath paired with the new cwd) on screen.
    setEntries([]);
    setLoading(true);
    void (async (): Promise<void> => {
      try {
        const result = await window.pipelines.listCapabilityRefs(
          cwd ? { cwd } : undefined,
        );
        if (!cancelled && result.success && result.data) {
          setEntries(result.data.pipelines);
        }
      } catch {
        // Sections fall back to their empty states.
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [cwd]);
  return { entries, loading };
}

interface CapabilityRelatedSectionsProps {
  subject: CapabilitySubject;
  /** Unified Plugins-page entry id for the current subject. */
  subjectEntryId?: string;
  /** Called before navigating to another page so the host can close itself. */
  onBeforeNavigate?: () => void;
  /** Open another capability entry in the host's detail stack. */
  onOpenEntry?: (entryId: string) => void;
  /** Host-owned pipeline navigation that can preserve its full detail stack. */
  onOpenPipeline?: (link: PipelineEditDeepLink) => void;
  /** Remove standalone spacing when the host already owns section rhythm. */
  flush?: boolean;
  presentation?: 'cards' | 'list';
}

/**
 * "Related pipelines" and "Related skills and plugins" sections for a skill
 * or plugin detail surface (CAN-2382). Related pipelines come from declared
 * `plugin_collections` refs resolved against the installed catalog; related
 * capabilities come from catalog metadata (containment, source, category,
 * marketplace). Self-fetching so hosts only supply the subject and
 * navigation callbacks.
 */
export function CapabilityRelatedSections({
  subject,
  subjectEntryId,
  onBeforeNavigate,
  onOpenEntry,
  onOpenPipeline,
  flush = false,
  presentation = 'cards',
}: CapabilityRelatedSectionsProps): JSX.Element {
  const cwd = useActiveWorktreeCwd();
  // New Customize lists related skills and plugins in the page's shared
  // Related section; this keeps the workflows that use the item.
  const discoveryEnabled = useCustomizeDiscoveryEnabled();
  const { entries, loading: refsLoading } = usePipelineCapabilityRefs(cwd);
  const { marketplaces, loading: marketplacesLoading } =
    useInstalledMarketplaces();
  const { skills, loading: skillsLoading } = useSkillList();
  const openPipelineEdit = useNavigationStore((s) => s.openPipelineEdit);
  const openPluginsNavigation = useNavigationStore(
    (s) => s.openPluginsNavigation,
  );

  // Hosts pass `subject` as an inline literal; key the memos on its value so
  // unrelated host re-renders don't recompute the matching passes.
  const subjectValueKey =
    subject.kind === 'skill'
      ? `skill:${subject.sourceId}:${subject.skillName}`
      : `plugin:${subject.marketplaceId}:${subject.pluginName}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableSubject = useMemo(() => subject, [subjectValueKey]);

  const effectiveSubjectEntryId = useMemo(
    () =>
      subjectEntryId ??
      (stableSubject.kind === 'skill'
        ? `skill:${stableSubject.sourceId}:${stableSubject.skillName}`
        : entryIdForSelection(
            {
              kind: 'plugin',
              marketplaceId: stableSubject.marketplaceId,
              pluginName: stableSubject.pluginName,
            },
            marketplaces,
          )),
    [subjectEntryId, stableSubject, marketplaces],
  );

  const relatedPipelines = useMemo(
    () => findRelatedPipelines(stableSubject, entries),
    [stableSubject, entries],
  );

  const relatedCapabilities = useMemo(
    () =>
      findRelatedCapabilitiesForSubject(stableSubject, {
        skills,
        marketplaces,
      }),
    [stableSubject, skills, marketplaces],
  );

  // A compact list states a reason every row shares once, under the title,
  // instead of repeating it on each row.
  const sharedReason = (
    reasons: readonly (string | undefined)[],
  ): string | undefined =>
    presentation === 'list' &&
    reasons.length > 0 &&
    reasons.every((reason) => reason && reason === reasons[0])
      ? reasons[0]
      : undefined;
  const pipelinesReason = sharedReason(
    relatedPipelines.map((item) => item.reason),
  );
  const capabilitiesReason = sharedReason(
    relatedCapabilities.map((item) => item.reason),
  );

  return (
    <div
      className={
        flush
          ? 'flex flex-col gap-6 empty:hidden'
          : 'pt-8 flex flex-col gap-8 empty:hidden'
      }
      data-testid="capability-related-sections"
    >
      <RelatedItemsSection
        title="Related workflows"
        {...(pipelinesReason ? { description: pipelinesReason } : {})}
        presentation={presentation}
        hideWhenEmpty={presentation === 'list'}
        emptyLabel="No workflows use this yet."
        loading={refsLoading}
        testId="related-pipelines-section"
        items={relatedPipelines.map((item) => ({
          key: `${item.source}:${item.id}`,
          icon: item.icon,
          title: item.name,
          sourceLabel: PIPELINE_SOURCE_META[item.source].label,
          reason: item.reason,
          onOpen: (): void => {
            const link: PipelineEditDeepLink = {
              pipelineId: item.id,
              ...(item.source === 'project'
                ? { cwd, filePath: item.filePath }
                : { source: item.source }),
              returnToEntryId: effectiveSubjectEntryId,
            };
            if (onOpenPipeline) {
              onOpenPipeline(link);
              return;
            }
            onBeforeNavigate?.();
            openPipelineEdit(link);
          },
        }))}
      />
      {!discoveryEnabled && (
        <RelatedItemsSection
          title="Related skills and plugins"
          {...(capabilitiesReason ? { description: capabilitiesReason } : {})}
          presentation={presentation}
          hideWhenEmpty={presentation === 'list'}
          emptyLabel="No related skills or plugins yet."
          loading={marketplacesLoading || skillsLoading}
          testId="related-capabilities-section"
          items={relatedCapabilities.map((item) => ({
            key: item.key,
            // The list's display name, so a related row reads like its row.
            title: marketplaceTitleCase(item.title),
            subtitle: item.subtitle,
            badge: item.kind === 'skill' ? 'Skill' : 'Plugin',
            kind: item.kind,
            reason: item.reason,
            onOpen: (): void => {
              if (onOpenEntry) {
                onOpenEntry(item.entryId);
                return;
              }
              onBeforeNavigate?.();
              // Hosts without a detail stack still get a Back path: the
              // source entry seeds the Plugins-page stack.
              openPluginsNavigation({
                kind: 'entry-detail',
                entryId: item.entryId,
                from: { kind: 'entry', entryId: effectiveSubjectEntryId },
              });
            },
          }))}
        />
      )}
    </div>
  );
}
