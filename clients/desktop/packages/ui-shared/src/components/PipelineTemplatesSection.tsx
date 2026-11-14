'use client';

import { Stack } from './Stack';
import { useRef, useState, type JSX } from 'react';
import type { CuratedPipelineSummary } from '@canopy/protocol/pipeline-catalog';
import {
  CuratedPipelineCatalog,
  type CuratedPipelineCatalogProps,
} from './CuratedPipelineCatalog';
import { Button } from './Button';
import { DialogModal } from './DialogModal';
import { Notice, NoticeButton } from './Notice';
import { TRY_AGAIN_LABEL } from './useRetry';
import { curatedPipelineFiltersActive } from '../lib/curated-pipeline-search';
import { Heading } from './Heading';
import { Tooltip } from './Tooltip';

export interface PipelineTemplatesSectionProps {
  catalog: CuratedPipelineCatalogProps;
}

function CatalogStatus({
  catalog,
}: {
  catalog: CuratedPipelineCatalogProps;
}): JSX.Element {
  return catalog.error ? (
    <Notice
      errorSource="catalog-status"
      intent="destructive"
      liveRegionScope="content"
      actions={
        <NoticeButton
          disabled={catalog.loading}
          onClick={catalog.onRefresh}
          data-testid="pipeline-templates-retry"
        >
          {TRY_AGAIN_LABEL}
        </NoticeButton>
      }
    >
      <span className="break-words">{catalog.error}</span>
    </Notice>
  ) : (
    <p role="status" className="text-s fg-secondary">
      Loading workflow templates…
    </p>
  );
}

export function PipelineTemplatesSection({
  catalog,
}: PipelineTemplatesSectionProps): JSX.Element | null {
  const [catalogOpen, setCatalogOpen] = useState(false);
  // The cards on screen when "View all templates" opened the catalog. A
  // search or filter in the catalog narrows `rows` (a host may clear them
  // while it refetches), which must not unmount the button the dialog returns
  // focus to. The cards stay until the catalog's own rows are back, or until
  // the catalog settles empty.
  const [openedCards, setOpenedCards] = useState<
    CuratedPipelineSummary[] | null
  >(null);
  const viewAllRef = useRef<HTMLButtonElement>(null);
  const dialogOpen = catalogOpen || Boolean(catalog.selectedKey);
  const filtered = curatedPipelineFiltersActive(catalog.query);
  const rowsPending =
    catalog.rows.length === 0 &&
    (filtered || catalog.loading || Boolean(catalog.error));
  const keepOpenedCards =
    openedCards !== null &&
    openedCards.length > 0 &&
    (catalogOpen || rowsPending);
  const cards = keepOpenedCards ? openedCards : catalog.rows;
  const hasCards = cards.length > 0;
  // Without cards or filters, the first page is still loading or failed: say
  // so, with a retry, instead of hiding the section. Only a successful empty
  // catalog hides it.
  const unfilteredStatus =
    !hasCards && !filtered && (Boolean(catalog.error) || catalog.loading);
  if (!hasCards && !unfilteredStatus && !dialogOpen) return null;

  const close = (): void => {
    setCatalogOpen(false);
    catalog.onBack();
    // Only a search or filter needs resetting; an unchanged query keeps the
    // pages already loaded, and the catalog's rows are on screen again.
    if (filtered) catalog.onQueryChange({ limit: 25 });
    else setOpenedCards(null);
  };

  return (
    <>
      {unfilteredStatus && (
        <Stack
          as="section"
          gap="item"
          className="mt-10 min-w-0"
          aria-label="Workflow templates"
          data-testid="pipeline-templates-section-status"
        >
          <Heading level={2} variant="title">
            Workflow templates
          </Heading>
          <CatalogStatus catalog={catalog} />
        </Stack>
      )}
      {hasCards && (
        <Stack
          as="section"
          gap="item"
          className="mt-10 min-w-0"
          aria-label="Workflow templates"
          data-testid="pipeline-templates-section"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Heading level={2} variant="title">
              Workflow templates
            </Heading>
            <Button
              ref={viewAllRef}
              variant="ghost"
              size="compact"
              onClick={() => {
                setOpenedCards(cards);
                setCatalogOpen(true);
              }}
              data-testid="pipeline-templates-view-all"
            >
              View all templates
            </Button>
          </div>
          {/* The kept cards stand in while the catalog reloads after a reset;
              a failed reload says so here, with a retry. */}
          {keepOpenedCards && !catalogOpen && catalog.error && (
            <CatalogStatus catalog={catalog} />
          )}
          <ul className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
            {cards.slice(0, 3).map((row) => (
              <li
                key={row.key}
                className="flex min-w-0 flex-col gap-3 rounded-lg ring-1 ring-inset ring-line-base p-3"
                data-testid={`pipeline-template-${row.key}`}
              >
                <Stack gap="tight" className="min-w-0">
                  <Heading level={3} variant="title" truncate title={row.name}>
                    {row.name}
                  </Heading>
                  <Tooltip label={row.shortDescription} clamp allowShrink>
                    <span className="min-w-0 truncate text-xs fg-secondary">
                      {row.shortDescription}
                    </span>
                  </Tooltip>
                </Stack>
                <Button
                  size="compact"
                  className="self-start"
                  onClick={() => catalog.onSelect(row)}
                  data-testid={`pipeline-template-use-${row.key}`}
                  aria-label={`Use template: ${row.name}`}
                >
                  Use template
                </Button>
              </li>
            ))}
          </ul>
        </Stack>
      )}
      {dialogOpen && (
        <DialogModal
          title={
            catalog.selectedKey ? 'Preview workflow' : 'Workflow templates'
          }
          onClose={close}
          maxWidth="3xl"
          // Modal for the keyboard too: focus moves in, stays in, and returns
          // to the control that opened it.
          trapFocus
          restoreFocusRef={viewAllRef}
          dataTestId="pipeline-templates-dialog"
        >
          <div className="">
            <CuratedPipelineCatalog {...catalog} />
          </div>
        </DialogModal>
      )}
    </>
  );
}
