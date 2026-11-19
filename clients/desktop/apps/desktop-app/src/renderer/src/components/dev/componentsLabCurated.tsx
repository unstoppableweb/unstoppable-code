import { useState, type JSX } from 'react';
import {
  Button,
  CuratedCatalogNotice,
  CuratedPipelinePreviewDialog,
  type CuratedPipelineCatalogProps,
} from '@canopy/ui-shared/components';
import type { CuratedPipelineDetail } from '@canopy/protocol/pipeline-catalog';
import { SpecimenCell, SpecimenPanel } from './componentsLabParts';

const noop = (): void => undefined;

const DETAIL: CuratedPipelineDetail = {
  key: 'review',
  name: 'Review a pull request',
  shortDescription: 'Reads the diff, runs the checks and leaves a review.',
  version: '2',
  icon: '',
  triggerTypes: ['dispatch'],
  scopes: ['directory'],
  jobCount: 2,
  stepCount: 5,
  contentHash: 'a'.repeat(64),
  contentSizeBytes: 240,
  categories: ['quality'],
  popular: true,
  sortOrder: 0,
  revision: 2,
  authorName: 'Acme',
  authorUrl: null,
  docsUrl: null,
  createdAt: '2026-09-10',
  updatedAt: '2026-10-02',
  rawPipeline: 'name: Review a pull request\njobs:\n  review:\n    steps: []',
};

type PreviewState = 'ready' | 'loading' | 'error' | 'imported';

function previewCatalog(
  state: PreviewState,
  onBack: () => void,
): CuratedPipelineCatalogProps {
  return {
    cloudDisplayName: 'Acme Cloud',
    rows: [],
    query: {},
    onQueryChange: noop,
    loading: false,
    onRefresh: noop,
    onLoadMore: noop,
    onSelect: noop,
    onBack,
    onImport: noop,
    selectedKey: DETAIL.key,
    detail: state === 'loading' || state === 'error' ? null : DETAIL,
    detailLoading: state === 'loading',
    detailError: state === 'error' ? 'The catalog could not be reached.' : null,
    importedPipelineId: state === 'imported' ? 'pipeline-1' : null,
    onOpenImported: noop,
  };
}

const PREVIEW_STATES: readonly { state: PreviewState; label: string }[] = [
  { state: 'ready', label: 'Loaded: Add to workflows' },
  { state: 'loading', label: 'Loading the preview' },
  { state: 'error', label: 'The preview failed to load' },
  { state: 'imported', label: 'Already added: Open workflow' },
];

/**
 * The curated workflow catalog's failure notices and the preview dialog a
 * Browse row opens. The dialog is a real modal: each button opens it in one
 * state, and Escape or the close control returns here.
 */
export function CuratedWorkflowsSpecimen(): JSX.Element {
  const [open, setOpen] = useState<PreviewState | null>(null);
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="CuratedCatalogNotice">
        <SpecimenCell label="Load failed: the error and a retry" wide>
          <div className="w-full">
            <CuratedCatalogNotice
              error="The workflow catalog returned an unexpected response (503)."
              stale={false}
              onRetry={noop}
              cloudDisplayName="Acme Cloud"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Showing the saved copy" wide>
          <div className="w-full">
            <CuratedCatalogNotice
              error={null}
              stale
              onRetry={noop}
              cloudDisplayName="Acme Cloud"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Long error text wraps" wide>
          <div className="w-full max-w-md">
            <CuratedCatalogNotice
              error={`The workflow catalog could not be read. ${'The request timed out. '.repeat(8)}`}
              stale={false}
              onRetry={noop}
              cloudDisplayName="Acme Cloud"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Nothing wrong: renders nothing">
          <CuratedCatalogNotice
            error={null}
            stale={false}
            onRetry={noop}
            cloudDisplayName="Acme Cloud"
          />
          <span className="text-2xs fg-tertiary">(nothing renders)</span>
        </SpecimenCell>
      </SpecimenPanel>

      <SpecimenPanel title="CuratedPipelinePreviewDialog" hint="Opens a modal">
        <div className="flex flex-wrap gap-2">
          {PREVIEW_STATES.map(({ state, label }) => (
            <Button
              key={state}
              data-testid={`lab-curated-preview-open-${state}`}
              onClick={() => setOpen(state)}
            >
              {label}
            </Button>
          ))}
        </div>
        {open ? (
          <CuratedPipelinePreviewDialog
            catalog={previewCatalog(open, () => setOpen(null))}
            breadcrumbsGap="item"
            breadcrumbs={
              <p className="text-xs fg-tertiary">Browse / Workflows</p>
            }
          />
        ) : null}
      </SpecimenPanel>
    </div>
  );
}
