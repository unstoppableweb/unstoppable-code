import { useMemo, useRef, useState, type JSX } from 'react';
import type {
  ExecutionState,
  MaterializedJob,
  JobResult,
} from '@canopy/execution-engine/types/pipeline';
import {
  getPresentJobStatuses,
  presentedJobStatus,
  type JobStatus,
  type JobStatusCount,
} from '@/lib/pipelineDetailsView';
import type { PipelineEditDeepLink } from '@/stores/navigationStore';
import { CostIcon } from '@canopy/ui-shared/components/cost';
import { capitalizeFirstLetter } from '@canopy/ui-shared/lib';
import {
  Surface,
  Button,
  Count,
  FloatingPickerMenu,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
  PickerMenuOptionTrailing,
  StatusGlyph,
} from '@canopy/ui-shared/components';
import { pipelineStatusGlyphState } from '../utils';
import { ChevronIcon } from '@canopy/ui-shared/icons';
import { isPipelineDetailsDefinitionSelection } from './pipelineDetailTypes';
import {
  FileIcon as AppCatalogFileIcon,
  BoardIcon as AppCatalogBoardIcon,
  FilterIcon,
} from '@canopy/ui-shared/icons/AppIcons';

/**
 * Nav selection target: `null` is the run "Summary" overview, otherwise a job
 * plus an optional physical matrix variant.
 *
 * `null` (rather than a `'summary'` sentinel) keeps the overview distinct from
 * a job that is literally named/id'd `summary`, so such a job stays reachable
 * instead of colliding with the overview entry.
 *
 * `variantJobId` absent means the logical group row is selected. A variant is
 * never a top-level nav row; it always lives under its logical matrix group.
 */
export interface PipelineDetailsTarget {
  jobId: string;
  variantJobId?: string;
}

export interface PipelineDetailsCostTarget {
  entry: 'cost';
}

/** The pipeline definition the run started with (its recorded snapshot). */
export interface PipelineDetailsDefinitionTarget {
  entry: 'definition';
}

export type PipelineDetailsSelection =
  | PipelineDetailsTarget
  | PipelineDetailsCostTarget
  | PipelineDetailsDefinitionTarget
  | null;

/**
 * Max pixel height of the child list under an expanded parent. A fan-out can
 * materialize a couple hundred children, so the list scrolls rather than
 * growing the nav unboundedly.
 */
const CHILD_LIST_MAX_HEIGHT = 240;

/**
 * The selected row's left accent line: a painted element on the row's
 * leading edge. It is not a `border-l` color, because the unlayered
 * `* { border-color }` base rule overrides every `border-<color>` utility
 * (CAN-2734), which drew the same base-colored line on every row. The row
 * carries `relative` so the line spans its full height.
 */
function SelectionMarker(): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 left-0 w-0.5 line-accent"
      data-testid="pipeline-details-nav-selection-marker"
    />
  );
}

/** Selected and unselected row surfaces, shared by every selectable row. */
const SELECTED_ROW_CLASS = 'bg-fg-primary/[0.04] font-semibold';
const UNSELECTED_ROW_CLASS = 'hover:bg-fg-primary/[0.04]';

export function PipelineDetailsNav({
  id,
  state,
  jobOrder,
  selected,
  costEntry,
  statusFilter,
  onSelect,
  onStatusFilter,
  onOpenDefinition,
}: {
  /** DOM id, so a toggle elsewhere can name this list in `aria-controls`. */
  id?: string;
  state: ExecutionState;
  jobOrder: string[];
  selected: PipelineDetailsSelection;
  /** Present when the owned run has an observed cost breakdown. */
  costEntry?: { amount: string };
  statusFilter: JobStatus | 'all';
  onSelect: (target: PipelineDetailsSelection) => void;
  onStatusFilter: (status: JobStatus | 'all') => void;
  /**
   * Opens the pipeline's current definition in the editor. Never closes the
   * detail.
   */
  onOpenDefinition: (link: PipelineEditDeepLink) => void;
}): JSX.Element {
  const present = getPresentJobStatuses(state);
  // A matrix group stays visible when any variant matches the filter.
  const visibleJobs = jobOrder.filter((id) => {
    if (statusFilter === 'all') return true;
    const group = state.job_groups[id];
    return (
      presentedJobStatus(group?.status) === statusFilter ||
      group?.variant_job_ids.some(
        (physicalId) =>
          presentedJobStatus(state.jobs[physicalId]?.status) === statusFilter,
      )
    );
  });
  const openDefinition = (): void => {
    onOpenDefinition({ pipelineId: state.pipeline_id, cwd: state.cwd });
  };
  const costSelected =
    selected !== null && 'entry' in selected && selected.entry === 'cost';
  const definitionSelected = isPipelineDetailsDefinitionSelection(selected);

  // Every row is full-bleed inside this scrolling list, which would cut off
  // a ring drawn outside it, so rows draw the shared focus ring inside their
  // edges (`focus-ring focus-ring-inset`).
  return (
    <nav
      id={id}
      aria-label="Jobs"
      className="flex w-64 shrink-0 flex-col overflow-y-auto border-r bg-card"
      data-testid="pipeline-details-nav"
    >
      <button
        type="button"
        className={`focus-ring focus-ring-inset relative flex items-center gap-2 py-2 pl-4 pr-3.5 text-left transition-colors ${
          selected === null ? SELECTED_ROW_CLASS : UNSELECTED_ROW_CLASS
        }`}
        aria-current={selected === null ? 'true' : undefined}
        onClick={(): void => onSelect(null)}
        data-testid="pipeline-details-nav-summary"
      >
        <AppCatalogBoardIcon
          size="sm"
          aria-hidden="true"
          className="shrink-0"
        />
        Summary
        {selected === null && <SelectionMarker />}
      </button>

      {costEntry !== undefined ? (
        <button
          type="button"
          className={`focus-ring focus-ring-inset relative flex items-center gap-2 py-2 pl-4 pr-3.5 text-left transition-colors ${
            costSelected ? SELECTED_ROW_CLASS : UNSELECTED_ROW_CLASS
          }`}
          aria-current={costSelected ? 'true' : undefined}
          onClick={(): void => onSelect({ entry: 'cost' })}
          data-testid="pipeline-job-list-cost"
        >
          <CostIcon size="sm" className="shrink-0" />
          <span className="min-w-0 flex-1">Cost</span>
          <span className="shrink-0 tabular-nums text-2xs fg-secondary">
            {costEntry.amount}
          </span>
          {costSelected && <SelectionMarker />}
        </button>
      ) : null}

      <button
        type="button"
        className={`focus-ring focus-ring-inset relative flex items-center gap-2 py-2 pl-4 pr-3.5 text-left transition-colors ${
          definitionSelected ? SELECTED_ROW_CLASS : UNSELECTED_ROW_CLASS
        }`}
        aria-current={definitionSelected ? 'true' : undefined}
        onClick={(): void => onSelect({ entry: 'definition' })}
        data-testid="pipeline-job-list-definition"
      >
        <AppCatalogFileIcon size="sm" aria-hidden="true" className="shrink-0" />
        Definition used
        {definitionSelected && <SelectionMarker />}
      </button>

      <div className="flex items-center justify-between px-3.5 pb-1 pt-3 text-2xs fg-secondary">
        <span>All jobs · {visibleJobs.length}</span>
        <PipelineStatusFilter
          present={present}
          value={statusFilter}
          total={jobOrder.length}
          onChange={onStatusFilter}
        />
      </div>

      <div className="flex-1">
        {visibleJobs.map((jobId) => (
          <PipelineNavJob
            key={jobId}
            jobId={jobId}
            state={state}
            selected={selected}
            statusFilter={statusFilter}
            onSelect={onSelect}
          />
        ))}
      </div>

      <Surface variant="section" boundary="top">
        <div className="px-3.5 py-2 text-s">
          <Button
            variant="link"
            onClick={openDefinition}
            data-testid="pipeline-details-open-definition"
          >
            Open current definition ↗
          </Button>
        </div>
      </Surface>
    </nav>
  );
}

function PipelineNavJob({
  jobId,
  state,
  selected,
  statusFilter,
  onSelect,
}: {
  jobId: string;
  state: ExecutionState;
  selected: PipelineDetailsSelection;
  statusFilter: JobStatus | 'all';
  onSelect: (target: PipelineDetailsSelection) => void;
}): JSX.Element {
  const group = state.job_groups[jobId];
  const jobDef = state.pipeline_snapshot.jobs[jobId];
  const isMatrix = group?.kind === 'matrix';
  const children = (group?.variant_job_ids ?? []).map((physicalJobId) => ({
    id: physicalJobId,
    definition: state.job_definitions[physicalJobId],
    result: state.jobs[physicalJobId],
  }));
  const name = jobDef?.name ?? jobId;
  const selectedJob =
    selected !== null && 'jobId' in selected ? selected : null;
  const selectedInJob = selectedJob?.jobId === jobId;
  const parentActive = selectedInJob && selectedJob?.variantJobId === undefined;

  // A filtered nav reveals the matching children rather than hiding them, so
  // failed work under a `continue_on_error` parent stays reachable.
  const filteredChildren = useMemo(
    () =>
      statusFilter === 'all'
        ? children
        : children.filter(
            (child) =>
              presentedJobStatus(child.result?.status) === statusFilter,
          ),
    [children, statusFilter],
  );
  const filterRevealsChildren =
    statusFilter !== 'all' &&
    presentedJobStatus(group?.status) !== statusFilter &&
    filteredChildren.length > 0;

  const [userExpanded, setUserExpanded] = useState(false);
  const expanded =
    isMatrix &&
    (userExpanded ||
      filterRevealsChildren ||
      (selectedInJob && selectedJob?.variantJobId !== undefined));

  return (
    <div>
      <div
        className={`relative flex w-full items-center transition-colors ${
          isMatrix ? 'pl-1.5' : ''
        } ${parentActive ? SELECTED_ROW_CLASS : UNSELECTED_ROW_CLASS}`}
      >
        {isMatrix && (
          <Button
            variant="ghost-quiet"
            size="sm"
            iconOnly
            onClick={(): void => setUserExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse variants' : 'Expand variants'}
            data-testid={`pipeline-details-nav-job-toggle-${jobId}`}
          >
            <ChevronIcon open={expanded} />
          </Button>
        )}
        <button
          type="button"
          onClick={(): void => onSelect({ jobId })}
          className={`focus-ring focus-ring-inset flex min-w-0 flex-1 items-center gap-2 py-2 pr-2.5 text-left ${
            isMatrix ? 'pl-1.5' : 'pl-4'
          }`}
          aria-current={parentActive ? 'true' : undefined}
          data-testid={`pipeline-details-nav-job-${jobId}`}
        >
          <StatusGlyph
            state={pipelineStatusGlyphState(group?.status ?? 'pending')}
            size={12}
          />
          <span className="min-w-0 flex-1 truncate text-s">{name}</span>
          {isMatrix && (
            <span
              className="shrink-0 text-2xs fg-quaternary"
              data-testid={`pipeline-details-nav-job-child-count-${jobId}`}
            >
              <Count value={children.length} /> variants
            </span>
          )}
        </button>
        {parentActive && <SelectionMarker />}
      </div>
      {expanded && (
        // A neutral rail: the base `* { border-color }` rule paints
        // `--line-base` on any `border-<color>` (CAN-2734), so the rail
        // names no color utility of its own.
        <ul
          className="overflow-y-auto border-l pl-1"
          style={{ maxHeight: CHILD_LIST_MAX_HEIGHT }}
          data-testid={`pipeline-details-nav-children-${jobId}`}
        >
          {filteredChildren.map((child) => (
            <li key={child.id}>
              <PipelineNavMatrixVariant
                jobId={jobId}
                child={child}
                active={selectedInJob && selectedJob?.variantJobId === child.id}
                onSelect={onSelect}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One matrix variant row. Renders purely from summary fields rather than
 * `steps`, so a large matrix stays cheap to list.
 */
function PipelineNavMatrixVariant({
  jobId,
  child,
  active,
  onSelect,
}: {
  jobId: string;
  child: {
    id: string;
    definition: MaterializedJob;
    result: JobResult;
  };
  active: boolean;
  onSelect: (target: PipelineDetailsSelection) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={(): void => onSelect({ jobId, variantJobId: child.id })}
      className={`focus-ring focus-ring-inset relative flex w-full items-center gap-2 py-1.5 pl-3.5 pr-2.5 text-left transition-colors ${
        active ? SELECTED_ROW_CLASS : UNSELECTED_ROW_CLASS
      }`}
      aria-current={active ? 'true' : undefined}
      data-testid={`pipeline-details-nav-child-${jobId}-${child.id}`}
    >
      <StatusGlyph
        state={pipelineStatusGlyphState(child.result?.status ?? 'pending')}
        size={12}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-2xs">
          {child.definition?.name ?? child.id}
        </span>
        <span className="block truncate text-3xs fg-secondary">
          {JSON.stringify(child.definition?.matrix?.values ?? {})}
        </span>
      </span>
      {active && <SelectionMarker />}
    </button>
  );
}

function PipelineStatusFilter({
  present,
  value,
  total,
  onChange,
}: {
  present: JobStatusCount[];
  value: JobStatus | 'all';
  total: number;
  onChange: (status: JobStatus | 'all') => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const active = value !== 'all';
  const options: ReadonlyArray<{
    readonly status: JobStatus | 'all';
    readonly label: string;
    readonly count: number;
  }> = [
    { status: 'all', label: 'All', count: total },
    ...present.map(({ status, count }) => ({
      status,
      label: capitalizeFirstLetter(status),
      count,
    })),
  ];

  // The picker owns placement and outside-press dismissal, in whichever
  // window shows the list. Escape on the button is taken here: an enclosing
  // preview handles Escape as the key bubbles through React, before the
  // picker's document listener would see it, so the menu closes first, focus
  // stays on its button, and the preview sees the key as handled.
  return (
    <div
      className="relative"
      onKeyDown={(event): void => {
        if (event.key !== 'Escape' || !open || event.defaultPrevented) return;
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }}
    >
      <Button
        ref={buttonRef}
        variant={active ? 'warning' : 'ghost'}
        size="sm"
        iconOnly
        onClick={(): void => setOpen((v) => !v)}
        data-testid="pipeline-details-filter-button"
        data-active={active ? 'true' : 'false'}
        aria-label="Filter by status"
        aria-expanded={open}
        aria-haspopup="true"
      >
        <FilterIcon
          size="sm"
          fill={active ? 'currentColor' : 'none'}
          aria-hidden="true"
        />
      </Button>
      <FloatingPickerMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={buttonRef}
        placement="bottom-right"
        gap={4}
        interaction="menu"
        aria-label="Filter by status"
        data-testid="pipeline-details-filter-popover"
      >
        {options.map((option) => {
          const selected = option.status === value;
          return (
            <PickerMenuOption
              key={option.status}
              role="menuitemradio"
              aria-checked={selected}
              selected={selected}
              onClick={(): void => {
                onChange(option.status);
                setOpen(false);
              }}
            >
              <PickerMenuOptionContent>
                <PickerMenuOptionLabel>{option.label}</PickerMenuOptionLabel>
              </PickerMenuOptionContent>
              <PickerMenuOptionTrailing tone="tertiary">
                {option.count}
              </PickerMenuOptionTrailing>
              <PickerMenuOptionCheck selected={selected} reserveSpace />
            </PickerMenuOption>
          );
        })}
      </FloatingPickerMenu>
    </div>
  );
}
