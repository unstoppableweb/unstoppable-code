'use client';

import { Stack } from '../primitives/Stack';
import { useRef, useState, type JSX } from 'react';
import type { CuratedPipelineSummary } from '@canopy/protocol/pipeline-catalog';
import {
  CuratedPipelineCatalog,
  type CuratedPipelineCatalogProps,
} from './CuratedPipelineCatalog';
import { Button } from '../primitives/Button';
import { DialogModal } from '../primitives/DialogModal';
import { Notice, NoticeButton } from '../primitives/Notice';
import { TRY_AGAIN_LABEL } from '../primitives/useRetry';
import { curatedPipelineFiltersActive } from '../lib/curated-pipeline-search';
import { Heading } from '../primitives/Heading';
import { Tooltip } from '../primitives/Tooltip';
import { Surface } from '../primitives/Surface';
import { DelayedLoadingPlaceholder } from './DelayedLoadingPlaceholder';
import { Skeleton } from '../primitives/Skeleton';

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
          busy={catalog.loading}
          busyLabel="Trying again…"
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
    <DelayedLoadingPlaceholder slowNote="Still loading workflow templates…">
      <Skeleton loading label="Loading workflow templates">
        <TemplateCards cards={SAMPLE_CARDS} />
      </Skeleton>
    </DelayedLoadingPlaceholder>
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
        <div className="pt-10 empty:hidden">
          <Stack
            as="section"
            gap="item"
            className="min-w-0"
            aria-label="Workflow templates"
            data-testid="pipeline-templates-section-status"
          >
            <Heading level={2} variant="title">
              Workflow templates
            </Heading>
            <CatalogStatus catalog={catalog} />
          </Stack>
        </div>
      )}
      {hasCards && (
        <div className="pt-10 empty:hidden">
          <Stack
            as="section"
            gap="item"
            className="min-w-0"
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
            <TemplateCards cards={cards} onUse={catalog.onSelect} />
          </Stack>
        </div>
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
            <CuratedPipelineCatalog {...catalog} hideHeading />
          </div>
        </DialogModal>
      )}
    </>
  );
}

type TemplateCardFields = Pick<
  CuratedPipelineSummary,
  'key' | 'name' | 'shortDescription'
>;

/** Sample cards for the measured loading skeleton. */
const SAMPLE_CARDS: readonly TemplateCardFields[] = [1, 2, 3].map((index) => ({
  key: `sample-${index}`,
  name: 'Review pull request',
  shortDescription: 'Checks a change and reports what to fix.',
}));

function TemplateCards<Card extends TemplateCardFields>({
  cards,
  onUse,
}: {
  cards: readonly Card[];
  /** Omitted for the loading skeleton's sample cards. */
  onUse?: (card: Card) => void;
}): JSX.Element {
  return (
    // Columns follow the section's own width, not the viewport's.
    <div className="@container min-w-0">
      <ul className="grid min-w-0 grid-cols-1 gap-3 @min-[40rem]:grid-cols-3">
        {cards.slice(0, 3).map((row) => (
          <Surface
            as="li"
            variant="outline"
            padding="compact"
            gap="item"
            key={row.key}
            className="min-w-0"
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
              onClick={() => onUse?.(row)}
              data-testid={`pipeline-template-use-${row.key}`}
              aria-label={`Use template: ${row.name}`}
            >
              Use template
            </Button>
          </Surface>
        ))}
      </ul>
    </div>
  );
}
