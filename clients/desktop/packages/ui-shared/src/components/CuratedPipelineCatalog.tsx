'use client';

import { TextLink } from '../primitives/TextLink';
import { CodeBlock } from '../primitives/CodeBlock';
import { Stack } from '../primitives/Stack';
import { useId, type JSX } from 'react';
import type {
  CuratedPipelineDetail,
  CuratedPipelineListQuery,
  CuratedPipelineSummary,
} from '@canopy/protocol/pipeline-catalog';
import {
  formatPipelinePackageFileSummary,
  pipelinePackageKindLabel,
  pipelinePackageRequirementKindLabel,
} from '../lib/pipeline-package-display';
import { Disclosure } from '../primitives/Disclosure';
import { EmptyStateText, ErrorBanner } from '../primitives/StatusBlocks';
import { Button } from '../primitives/Button';
import { BusyLabel } from '../primitives/BusyLabel';
import { DelayedLoadingPlaceholder } from './DelayedLoadingPlaceholder';
import { Skeleton } from '../primitives/Skeleton';
import { Surface } from '../primitives/Surface';
import { SearchEmptyState, SearchField } from '../primitives/SearchField';
import { curatedPipelineFiltersActive } from '../lib/curated-pipeline-search';
import {
  SettingsSelect,
  type SettingsSelectOption,
} from '../primitives/SettingsSelect';
import { Heading } from '../primitives/Heading';

export interface CuratedPipelineCatalogProps {
  cloudDisplayName: string;
  rows: CuratedPipelineSummary[];
  query: CuratedPipelineListQuery;
  onQueryChange: (query: CuratedPipelineListQuery) => void;
  loading: boolean;
  error?: string | null;
  stale?: boolean;
  nextCursor?: string | null;
  onRefresh: () => void;
  onLoadMore: () => void;
  selectedKey?: string | null;
  detail?: CuratedPipelineDetail | null;
  detailLoading?: boolean;
  detailError?: string | null;
  onSelect: (row: CuratedPipelineSummary) => void;
  onBack: () => void;
  onImport: (detail: CuratedPipelineDetail) => void;
  onDownload?: (detail: CuratedPipelineDetail) => void;
  importing?: boolean;
  importError?: string | null;
  importedPipelineId?: string | null;
  onOpenImported?: (id: string) => void;
  importDisabledReason?: string;
  hideSearch?: boolean;
  /** Drop the heading and its description, for a host that titles the catalog (a dialog). */
  hideHeading?: boolean;
  /**
   * Whether the previewed template appears when running a pipeline, and how
   * to change that. The host owns the preference; omit it where the host
   * keeps none.
   */
  launchAvailability?: CuratedPipelineLaunchAvailability;
}

export interface CuratedPipelineLaunchAvailability {
  enabled: boolean;
  pending?: boolean;
  onChange: (enabled: boolean) => void;
}

const TRIGGER_FILTER_OPTIONS: readonly SettingsSelectOption<
  '' | 'dispatch' | 'plan_ready' | 'task_ready'
>[] = [
  { value: '', label: 'All triggers' },
  { value: 'dispatch', label: 'Manual' },
  { value: 'plan_ready', label: 'Plan ready' },
  { value: 'task_ready', label: 'Task ready' },
];

const SCOPE_FILTER_OPTIONS: readonly SettingsSelectOption<
  '' | 'global' | 'directory' | 'worktree'
>[] = [
  { value: '', label: 'All execution scopes' },
  { value: 'global', label: 'Global' },
  { value: 'directory', label: 'Directory' },
  { value: 'worktree', label: 'Worktree' },
];

export function curatedPipelineStaleMessage(cloudDisplayName: string): string {
  return `Showing saved catalog metadata. Connect to ${cloudDisplayName} to preview or add a workflow.`;
}

/** Display only: all content loading, authorization and import work belongs to the host. */
export function CuratedPipelineCatalog(
  props: CuratedPipelineCatalogProps,
): JSX.Element {
  const { detail, selectedKey, query, importedPipelineId } = props;
  const importReasonId = useId();
  const filter = (next: Partial<CuratedPipelineListQuery>): void =>
    props.onQueryChange({ ...query, ...next, cursor: undefined });
  // A host-owned search (`hideSearch`) is not this catalog's filter to clear.
  const clearFilters = curatedPipelineFiltersActive(
    props.hideSearch ? { ...query, q: undefined } : query,
  )
    ? (): void =>
        filter({
          q: props.hideSearch ? query.q : undefined,
          category: undefined,
          triggerType: undefined,
          scope: undefined,
        })
    : undefined;
  return (
    <Stack
      as="section"
      gap="group"
      className="min-w-0"
      data-testid="curated-pipeline-catalog"
      aria-label="Workflow templates"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!props.hideHeading && (
          <Stack gap="tight" className="min-w-0">
            <Heading level={2} variant="section">
              Workflow templates
            </Heading>
            <p className="text-s fg-secondary">
              Ready-made workflows you can add and customize.
            </p>
          </Stack>
        )}
        <Button
          // `loading` also covers Load more and filter fetches, so it only
          // disables: a spinner here would claim a refresh that isn't running.
          disabled={props.loading}
          onClick={props.onRefresh}
          data-testid="curated-pipeline-refresh"
        >
          Refresh catalog
        </Button>
      </div>
      {props.stale && (
        <p role="status" className="text-s fg-secondary">
          {curatedPipelineStaleMessage(props.cloudDisplayName)}
        </p>
      )}
      <ErrorBanner
        errorSource="curated-pipeline-catalog"
        className=""
        error={props.error}
      />
      {selectedKey ? (
        <div
          className="min-w-0 flex flex-col gap-4"
          data-testid="curated-pipeline-detail"
        >
          <Button className="self-start" onClick={props.onBack}>
            Back to workflow templates
          </Button>
          {props.launchAvailability && (
            <LaunchAvailabilityControl {...props.launchAvailability} />
          )}
          {props.detailLoading && (
            <DelayedLoadingPlaceholder slowNote="Still loading workflow preview…">
              <Skeleton loading label="Loading workflow preview">
                <CuratedPipelineDetailSummary detail={SAMPLE_DETAIL} />
              </Skeleton>
            </DelayedLoadingPlaceholder>
          )}
          <ErrorBanner
            errorSource="curated-pipeline-catalog-detail"
            className=""
            error={props.detailError}
          />
          {detail && (
            <>
              <CuratedPipelineDetailSummary detail={detail} />
              {props.onDownload && (
                <Button
                  className="self-start"
                  onClick={() => props.onDownload?.(detail)}
                  data-testid="curated-pipeline-download"
                >
                  Download YAML
                </Button>
              )}
              {detail.package && (
                <Disclosure
                  variant="box"
                  label="Included dependencies"
                  meta={formatPipelinePackageFileSummary(
                    detail.package.totalFiles,
                    detail.package.totalBytes,
                  )}
                  keepMounted
                  dataTestId="curated-pipeline-package-summary"
                >
                  {detail.package.resources.length > 0 && (
                    <Stack as="ul" gap="inline">
                      {detail.package.resources.map((resource) => (
                        <li key={resource.id} className="text-s fg-primary">
                          {resource.displayName}
                          <span className="pl-1 text-xs fg-secondary">
                            {pipelinePackageKindLabel(resource.kind)}
                          </span>
                        </li>
                      ))}
                    </Stack>
                  )}
                  {detail.package.environmentRequirements.length > 0 && (
                    <Stack gap="tight">
                      <p className="text-xs font-medium fg-secondary">
                        Setup required
                      </p>
                      <Stack as="ul" gap="tight">
                        {detail.package.environmentRequirements.map(
                          (requirement) => (
                            <li
                              key={requirement.id}
                              className="text-xs fg-secondary"
                            >
                              {requirement.displayName} ·{' '}
                              {pipelinePackageRequirementKindLabel(
                                requirement.kind,
                              )}
                            </li>
                          ),
                        )}
                      </Stack>
                    </Stack>
                  )}
                </Disclosure>
              )}
              <Disclosure
                label="View workflow YAML"
                keepMounted
                dataTestId="curated-pipeline-yaml-disclosure"
              >
                <CodeBlock
                  variant="catalog-source"
                  size="xs"
                  wrap="none"
                  tone="primary"
                  replay="inherit"
                  className="max-h-80"
                  data-testid="curated-pipeline-yaml"
                >
                  {detail.rawPipeline}
                </CodeBlock>
              </Disclosure>
              <p className="text-s fg-secondary">
                Adds an editable copy to your workflows. Review its commands and
                required tools before running. Future catalog changes do not
                replace your copy.
              </p>
              {props.importDisabledReason && (
                <p id={importReasonId} className="text-s fg-secondary">
                  {props.importDisabledReason}
                </p>
              )}
              <ErrorBanner
                errorSource="curated-pipeline-catalog-import"
                className=""
                error={props.importError}
              />
              {importedPipelineId ? (
                <div
                  role="status"
                  className="flex flex-wrap items-center gap-3 text-s fg-success"
                >
                  Added to your workflows.
                  {props.onOpenImported && (
                    <Button
                      onClick={() => props.onOpenImported?.(importedPipelineId)}
                      data-testid="curated-pipeline-open-imported"
                    >
                      Open workflow
                    </Button>
                  )}
                </div>
              ) : (
                <Button
                  className="self-start"
                  variant="primary"
                  loading={props.importing ?? false}
                  loadingLabel="Adding workflow…"
                  aria-disabled={props.importDisabledReason ? true : undefined}
                  aria-describedby={
                    props.importDisabledReason ? importReasonId : undefined
                  }
                  onClick={() => props.onImport(detail)}
                  data-testid="curated-pipeline-add"
                >
                  Add to my workflows
                </Button>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {!props.hideSearch && (
              <SearchField
                className="flex-1"
                aria-label="Search workflow templates"
                placeholder="Search workflow templates…"
                value={query.q ?? ''}
                onValueChange={(next) => filter({ q: next || undefined })}
                // Escape closes the catalog, as it does from any other field.
                clearOnEscape={false}
                data-testid="curated-pipeline-search"
              />
            )}
            <SearchField
              size="sm"
              className="w-36"
              aria-label="Workflow template category"
              placeholder="Category"
              value={query.category ?? ''}
              onValueChange={(next) => filter({ category: next || undefined })}
              clearLabel="Clear category"
              clearOnEscape={false}
            />
            <SettingsSelect
              aria-label="Workflow template trigger"
              options={TRIGGER_FILTER_OPTIONS}
              value={query.triggerType ?? ''}
              onValueChange={(next) =>
                filter({ triggerType: next === '' ? undefined : next })
              }
            />
            <SettingsSelect
              aria-label="Workflow template scope"
              options={SCOPE_FILTER_OPTIONS}
              value={query.scope ?? ''}
              onValueChange={(next) =>
                filter({ scope: next === '' ? undefined : next })
              }
            />
          </div>
          {props.loading && props.rows.length === 0 && (
            <DelayedLoadingPlaceholder slowNote="Still loading workflow templates…">
              <Skeleton loading label="Loading workflow templates">
                <CuratedPipelineRows rows={SAMPLE_ROWS} />
              </Skeleton>
            </DelayedLoadingPlaceholder>
          )}
          {!props.loading &&
            !props.error &&
            props.rows.length === 0 &&
            (clearFilters ? (
              <SearchEmptyState
                title="No workflow templates match these filters."
                actionLabel="Clear filters"
                onAction={clearFilters}
              />
            ) : (
              <p className="text-s">
                <EmptyStateText
                  title="No workflow templates match these filters."
                  tone="secondary"
                />
              </p>
            ))}
          {props.rows.length > 0 && (
            <CuratedPipelineRows rows={props.rows} onSelect={props.onSelect} />
          )}
          {props.nextCursor && (
            <Button
              className="self-start"
              aria-busy={props.loading || undefined}
              aria-disabled={props.loading || undefined}
              onClick={props.onLoadMore}
              data-testid="curated-pipeline-load-more"
            >
              <BusyLabel busy={props.loading} busyText="Loading templates…">
                Load more templates
              </BusyLabel>
            </Button>
          )}
        </>
      )}
    </Stack>
  );
}

/**
 * Available without the definition, so a disabled template can be re-enabled
 * even when its preview cannot load.
 */
function LaunchAvailabilityControl({
  enabled,
  pending = false,
  onChange,
}: CuratedPipelineLaunchAvailability): JSX.Element {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3"
      data-testid="curated-pipeline-availability"
    >
      <p className="text-s fg-secondary">
        {enabled
          ? 'Enabled. It appears when you run a workflow.'
          : 'Disabled. It is hidden when you run a workflow.'}
      </p>
      <Button
        loading={pending}
        loadingLabel={enabled ? 'Disabling…' : 'Enabling…'}
        onClick={() => onChange(!enabled)}
        data-testid="curated-pipeline-toggle-enabled"
      >
        {enabled ? 'Disable workflow' : 'Enable workflow'}
      </Button>
    </div>
  );
}

type CuratedPipelineRowFields = Pick<
  CuratedPipelineSummary,
  | 'key'
  | 'name'
  | 'shortDescription'
  | 'jobCount'
  | 'stepCount'
  | 'categories'
  | 'scopes'
>;

type CuratedPipelineDetailFields = Pick<
  CuratedPipelineDetail,
  | 'name'
  | 'shortDescription'
  | 'version'
  | 'revision'
  | 'jobCount'
  | 'stepCount'
  | 'scopes'
  | 'triggerTypes'
  | 'authorName'
  | 'docsUrl'
>;

/** Sample data for the measured loading skeletons. */
const SAMPLE_ROWS: readonly CuratedPipelineRowFields[] = [1, 2, 3].map(
  (index) => ({
    key: `sample-${index}`,
    name: 'Review pull request',
    shortDescription: 'Checks a change and reports what to fix.',
    jobCount: 2,
    stepCount: 4,
    categories: ['General'],
    scopes: ['worktree'],
  }),
);

const SAMPLE_DETAIL: CuratedPipelineDetailFields = {
  name: 'Review pull request',
  shortDescription: 'Checks a change and reports what to fix.',
  version: '1.0.0',
  revision: 1,
  jobCount: 2,
  stepCount: 4,
  scopes: ['worktree'],
  triggerTypes: ['dispatch'],
  authorName: null,
  docsUrl: null,
};

function CuratedPipelineDetailSummary({
  detail,
}: {
  detail: CuratedPipelineDetailFields;
}): JSX.Element {
  return (
    <Stack gap="inline" className="min-w-0">
      <Heading level={3} variant="section" className="break-words">
        {detail.name}
      </Heading>
      <p className="break-words text-s fg-secondary">
        {detail.shortDescription}
      </p>
      <p className="break-words text-xs fg-secondary">
        {detail.version
          ? `Version ${detail.version}`
          : `Revision ${detail.revision}`}{' '}
        · {detail.jobCount} jobs · {detail.stepCount} steps ·{' '}
        {detail.scopes.join(', ')} · {detail.triggerTypes.join(', ')}
      </p>
      {detail.authorName && (
        <p className="text-s fg-secondary">By {detail.authorName}</p>
      )}
      {detail.docsUrl && /^https?:\/\//.test(detail.docsUrl) && (
        <TextLink
          variant="inline"
          size="s"
          className="self-start"
          href={detail.docsUrl}
          target="_blank"
          rel="noreferrer"
        >
          Documentation
        </TextLink>
      )}
    </Stack>
  );
}

function CuratedPipelineRows<Row extends CuratedPipelineRowFields>({
  rows,
  onSelect,
}: {
  rows: readonly Row[];
  /** Omitted for the loading skeleton's sample rows. */
  onSelect?: (row: Row) => void;
}): JSX.Element {
  return (
    <Surface variant="outline">
      <ul
        className="divide-y"
        data-testid={onSelect ? 'curated-pipeline-rows' : undefined}
      >
        {rows.map((row) => (
          <li key={row.key} className="flex min-w-0 items-center gap-4 p-4">
            <div className="min-w-0 flex-1 flex flex-col gap-2">
              <Stack gap="tight">
                <Heading level={3} variant="title" className="break-words">
                  {row.name}
                </Heading>

                <p className="break-words text-s fg-secondary">
                  {row.shortDescription}
                </p>
              </Stack>

              <p className="break-words text-xs fg-secondary">
                {row.jobCount} jobs · {row.stepCount} steps ·{' '}
                {row.categories.join(', ') || 'General'} ·{' '}
                {row.scopes.join(', ')}
              </p>
            </div>
            <Button
              onClick={() => onSelect?.(row)}
              data-testid={`curated-pipeline-preview-${row.key}`}
              aria-label={`Preview ${row.name}`}
            >
              Preview
            </Button>
          </li>
        ))}
      </ul>
    </Surface>
  );
}
