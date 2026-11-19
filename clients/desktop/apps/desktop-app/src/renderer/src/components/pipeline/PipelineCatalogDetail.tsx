import { useResourceContext } from '@canopy/ui-app/capability';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { PipelineReadDetail } from '@canopy/ui-app';
import type { PortalPipelineDefinitionViewModel } from '@canopy/protocol/portal';
import { formatDateOrEmpty } from '@canopy/ui-shared/lib/format-date';
import { toPipelineDefinitionViewModel } from './pipeline-read-detail-adapter';
import { toAppError } from '@canopy/protocol/app-errors';
import { RelatedItemsSection } from '@canopy/ui-shared';
import {
  Button,
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
  DetailFactError,
  DetailPageActions,
  Divider,
  Tooltip,
  ExecutionActionButton,
  Heading,
  PipelineDetailTag,
} from '@canopy/ui-shared/components';
import { McpServerLogo } from '../shared/McpServerLogo';
import { useInstalledMarketplaces } from '@/hooks/useInstalledMarketplaces';
import { useActiveWorktreeCwd } from '@/hooks/useActiveWorktreeCwd';
import {
  findRelatedCapabilitiesForPipeline,
  pipelineRefsKey,
} from '@/lib/relatedCapabilities';
import { PIPELINE_SOURCE_META } from './pipeline-source-meta';
import { TRIGGER_META } from './pipeline-trigger-meta';
import { PIPELINE_EXECUTION_SCOPE_META } from './pipeline-execution-scope-meta';
import {
  getPipelineScopeBadgeLabel,
  getPipelineScopeBadgeTooltipLines,
} from './pipeline-scope-badge-helpers';
import type {
  PipelineCapabilityRefsEntry,
  PipelineInfo,
  PipelineLookupRequest,
} from '@canopy/execution-engine/types/pipeline';

interface PipelineCatalogDetailProps {
  pipeline: PipelineInfo;
  onOpenEditor: () => void;
  onOpenEntry?: (entryId: string) => void;
  /**
   * New Customize: the shared workflow page (Jobs, YAML) with the tile's
   * identity and its Run, read from the stored definition.
   */
  layout?: {
    /** The tile's name and description, so the header matches the row. */
    readonly title: string;
    readonly description: string;
    readonly logo: ReactNode;
    readonly publisher: ReactNode;
    /** The Source row, from the tile's entry. */
    readonly source?: string;
    /** The Source names a person: masked in session replay. */
    readonly sourceIsPerson?: boolean;
    /** The stored definition to read, given the active worktree's path. */
    readonly lookupFor: (cwd: string | null) => PipelineLookupRequest | null;
    readonly run: {
      readonly available: boolean;
      readonly reason?: string;
      readonly onRun: () => void | Promise<void>;
    };
  };
}

/** Read-only Marketplace summary for a pipeline before entering its editor. */
export function PipelineCatalogDetail({
  pipeline,
  onOpenEditor,
  onOpenEntry,
  layout,
}: PipelineCatalogDetailProps): JSX.Element {
  const [refs, setRefs] = useState<PipelineCapabilityRefsEntry | null>(null);
  const [refsLoading, setRefsLoading] = useState(true);
  const cwd = useActiveWorktreeCwd();
  const { marketplaces, loading: marketplacesLoading } =
    useInstalledMarketplaces();

  useEffect(() => {
    let cancelled = false;
    const request = window.pipelines.listCapabilityRefs(
      cwd ? { cwd } : undefined,
    );
    void request
      .then((result) => {
        if (!cancelled && result.success && result.data) {
          setRefs(
            result.data.pipelines.find(
              (candidate) =>
                pipelineRefsKey(candidate) === pipelineRefsKey(pipeline),
            ) ?? null,
          );
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setRefsLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [cwd, pipeline]);

  const relatedCapabilities = useMemo(
    () =>
      findRelatedCapabilitiesForPipeline(
        refs?.capabilities ?? [],
        marketplaces,
      ),
    [marketplaces, refs],
  );
  const { personalOrganizationId } = useResourceContext();
  const sharedLines =
    pipeline.source === 'shared'
      ? [
          getPipelineScopeBadgeLabel(
            pipeline.shareScope,
            pipeline.owner,
            personalOrganizationId,
          ),
          ...getPipelineScopeBadgeTooltipLines(
            pipeline.shareScope,
            pipeline.owner,
            personalOrganizationId,
          ).filter(
            (line) =>
              line !==
              getPipelineScopeBadgeLabel(
                pipeline.shareScope,
                pipeline.owner,
                personalOrganizationId,
              ),
          ),
        ]
      : [];
  const scopes = pipeline.scopes ?? ['directory'];
  const related = (
    <RelatedItemsSection
      title="Related skills and plugins"
      emptyLabel="No related skills or plugins yet."
      loading={refsLoading || marketplacesLoading}
      testId="pipeline-catalog-related-capabilities-section"
      presentation={layout ? 'list' : 'cards'}
      items={relatedCapabilities.map((item) => ({
        key: item.key,
        title: item.title,
        subtitle: item.subtitle,
        badge: item.kind === 'skill' ? 'Skill' : 'Plugin',
        reason: item.reason,
        onOpen: (): void => onOpenEntry?.(item.entryId),
      }))}
    />
  );
  if (layout) {
    return (
      <PipelineLayoutPage
        pipeline={pipeline}
        layout={layout}
        source={
          layout.source ??
          [PIPELINE_SOURCE_META[pipeline.source].label, ...sharedLines].join(
            ' · ',
          )
        }
        onOpenEditor={onOpenEditor}
        related={related}
        lookup={layout.lookupFor(cwd ?? null)}
      />
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto"
      data-testid="pipeline-catalog-detail"
    >
      <div className="flex items-start gap-3">
        <McpServerLogo
          size={40}
          fallback="monogram"
          name={pipeline.name}
          shape="circle"
          fit="contain"
        />
        <div className="min-w-0 flex-1">
          <Heading level={2} variant="section">
            {pipeline.name}
          </Heading>
          <p className="mt-0.5 text-xs fg-secondary">
            {PIPELINE_SOURCE_META[pipeline.source].label}
            {sharedLines.map((line) => ` · ${line}`).join('')}
          </p>
        </div>
        <DetailPageActions
          primary={
            <ExecutionActionButton
              label="Open in editor"
              ariaLabel="Open in editor"
              variant="primary"
              placement="detail"
              onClick={onOpenEditor}
              dataTestId="pipeline-catalog-open-editor"
              stopKeyDownPropagation={false}
            />
          }
        />
      </div>

      {pipeline.description && (
        <p className="text-s fg-secondary">{pipeline.description}</p>
      )}

      <div>
        <Divider />
        <div className="grid gap-4 pt-4 sm:grid-cols-2">
          <MetadataBadges
            label="Triggers"
            kind="trigger"
            values={(pipeline.triggerTypes ?? []).map(
              (type) => TRIGGER_META[type].label,
            )}
            empty="No trigger information"
          />
          <MetadataBadges
            label="Scopes"
            kind="scope"
            values={scopes.map(
              (scope) => PIPELINE_EXECUTION_SCOPE_META[scope].label,
            )}
            empty="No scope information"
          />
        </div>
      </div>

      {related}
    </div>
  );
}

/**
 * New Customize's workflow page: the stored definition on the shared
 * `PipelineReadDetail` layout, Run as the primary (the tile's action) and
 * Open in editor as the secondary.
 */
function PipelineLayoutPage({
  pipeline,
  layout,
  source,
  onOpenEditor,
  related,
  lookup,
}: {
  pipeline: PipelineInfo;
  layout: NonNullable<PipelineCatalogDetailProps['layout']>;
  source: string;
  onOpenEditor: () => void;
  related: ReactNode;
  lookup: PipelineLookupRequest | null;
}): JSX.Element {
  const [definition, setDefinition] =
    useState<PortalPipelineDefinitionViewModel | null>(null);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState('');
  // Read again only when the definition it names changes, not each render.
  const lookupKey = JSON.stringify(lookup);
  const lookupRef = useRef(lookup);
  lookupRef.current = lookup;
  useEffect(() => {
    const current = lookupRef.current;
    // A new lookup (another worktree, a retry) starts from loading, never
    // from the previous workflow's jobs or error.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDefinition(null);
    setLoadError('');
    if (current === null) {
      // No definition to read without a project; the page says so.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoadError('Open a project to read this workflow.');
      return;
    }
    let cancelled = false;
    void window.pipelines
      .get(current)
      .then((result) => {
        if (cancelled) return;
        if (result.success && result.data) {
          setDefinition(toPipelineDefinitionViewModel(result.data.content));
          setLoadError('');
        } else {
          setLoadError(result.error || 'Couldn’t read this workflow.');
        }
      })
      .catch((error: unknown) => {
        const reason = toAppError(error)?.detail.message.trim();
        if (!cancelled) setLoadError(reason || 'Couldn’t read this workflow.');
      });
    return (): void => {
      cancelled = true;
    };
  }, [lookupKey, attempt]);
  const run = (): void => {
    setRunError('');
    setRunning(true);
    void Promise.resolve()
      .then(() => layout.run.onRun())
      .catch((error: unknown) => {
        const reason = toAppError(error)?.detail.message.trim();
        setRunError(reason || 'Couldn’t start this run.');
      })
      .finally(() => setRunning(false));
  };
  const runButton = (
    <ExecutionActionButton
      label={running ? 'Starting…' : 'Run'}
      ariaLabel={`Run ${pipeline.name}`}
      variant="primary"
      placement="detail"
      onClick={run}
      disabled={!layout.run.available || running}
      dataTestId="pipeline-detail-run"
      stopKeyDownPropagation={false}
    />
  );
  return (
    <>
      <DetailPageActions
        secondary={
          <Button
            type="button"
            size="compact"
            onClick={onOpenEditor}
            data-testid="pipeline-catalog-open-editor"
          >
            Open in editor
          </Button>
        }
        primary={
          layout.run.available || !layout.run.reason ? (
            runButton
          ) : (
            <Tooltip label={layout.run.reason}>
              <span tabIndex={0} className="inline-flex">
                {runButton}
              </span>
            </Tooltip>
          )
        }
      />
      {/* The page keeps its layout while the definition loads or fails:
          the header and facts from the row, the state in Jobs. */}
      <PipelineReadDetail
        definition={
          definition ?? {
            name: pipeline.name,
            description: pipeline.description ?? '',
            triggerSummary: (pipeline.triggerTypes ?? [])
              .map((type) => TRIGGER_META[type].label)
              .join(', '),
            scopes: pipeline.scopes ?? ['directory'],
            jobs: [],
          }
        }
        layout={{
          title: layout.title,
          description: layout.description,
          logo: layout.logo,
          publisher: layout.publisher,
          source,
          ...(layout.sourceIsPerson ? { sourceIsPerson: true } : {}),
          ...(formatDateOrEmpty(pipeline.updatedAt)
            ? { updated: formatDateOrEmpty(pipeline.updatedAt) }
            : {}),
          actionsNotice: runError ? (
            <DetailFactError
              error={runError}
              testId="pipeline-detail-run-error"
            />
          ) : undefined,
          ...(definition
            ? {}
            : {
                jobsNotice: loadError ? (
                  <span className="inline-flex flex-wrap items-center gap-1.5 text-s">
                    <DetailFactError
                      error={loadError}
                      testId="pipeline-detail-load-error"
                    />
                    {/* Opening a project is the way on, not a retry. */}
                    {lookup !== null && (
                      <>
                        <span aria-hidden>·</span>
                        <Button
                          variant="link"
                          onClick={() => {
                            setLoadError('');
                            setAttempt((count) => count + 1);
                          }}
                        >
                          Try again
                        </Button>
                      </>
                    )}
                  </span>
                ) : (
                  <DelayedLoadingPlaceholder slowNote="Still loading workflow…">
                    <CenteredLoadingSpinner spacing="section" />
                  </DelayedLoadingPlaceholder>
                ),
              }),
          related,
        }}
      />
    </>
  );
}

function MetadataBadges({
  label,
  kind,
  values,
  empty,
}: {
  label: string;
  kind: 'trigger' | 'scope';
  values: string[];
  empty: string;
}): JSX.Element {
  return (
    <section
      className={`flex flex-col ${values.length === 0 ? 'gap-1' : 'gap-1.5'}`}
    >
      <Heading level={3} variant="label">
        {label}
      </Heading>
      {values.length === 0 ? (
        <p className="text-xs fg-secondary">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {values.map((value) => (
            <PipelineDetailTag key={value} kind={kind}>
              {value}
            </PipelineDetailTag>
          ))}
        </div>
      )}
    </section>
  );
}
