import { useRef, useState, type JSX } from 'react';
import { DropdownMenuItem } from './DropdownMenu';
import { FloatingMenu } from './FloatingMenu';
import { PickerTrigger, PickerTriggerChevron } from './PickerMenu';
import { CheckIcon } from '../icons/AppIcons';
import {
  PIPELINE_EXECUTION_SCOPE_LABELS,
  PIPELINE_FILTER_SCOPES,
  PIPELINE_FILTER_SOURCES,
  PIPELINE_FILTER_TRIGGERS,
  PIPELINE_SOURCE_LABELS,
  PIPELINE_TRIGGER_LABELS,
  type PipelineFilterValues,
} from '../lib/pipeline-filter-values';
import type { PipelineSourceBadgeKey } from '../lib/pipeline-source-badges';

export type PipelineFilterKey = keyof PipelineFilterValues;

export interface PipelineFilterOption {
  readonly value: string;
  readonly label: string;
}

export interface PipelineFilterDimension {
  readonly key: PipelineFilterKey;
  readonly title: string;
  readonly anyLabel: string;
  readonly options: readonly PipelineFilterOption[];
}

function sourceDimension(
  sources: readonly PipelineSourceBadgeKey[],
): PipelineFilterDimension {
  return {
    key: 'source',
    title: 'Source',
    anyLabel: 'Any source',
    options: sources.map((source) => ({
      value: source,
      label: PIPELINE_SOURCE_LABELS[source],
    })),
  };
}

const SCOPE_AND_TRIGGER_DIMENSIONS: readonly PipelineFilterDimension[] = [
  {
    key: 'scope',
    title: 'Scope',
    anyLabel: 'Any scope',
    options: PIPELINE_FILTER_SCOPES.map((scope) => ({
      value: scope,
      label: PIPELINE_EXECUTION_SCOPE_LABELS[scope],
    })),
  },
  {
    key: 'trigger',
    title: 'Trigger',
    anyLabel: 'Any trigger',
    options: PIPELINE_FILTER_TRIGGERS.map((type) => ({
      value: type,
      label: PIPELINE_TRIGGER_LABELS[type],
    })),
  },
];

/**
 * The Source, Scope and Trigger dimensions, in render order, for a host that
 * lays the filters out itself (New Customize's filter menu).
 */
export function pipelineFilterDimensions(
  sources: readonly PipelineSourceBadgeKey[] = PIPELINE_FILTER_SOURCES,
): readonly PipelineFilterDimension[] {
  return [sourceDimension(sources), ...SCOPE_AND_TRIGGER_DIMENSIONS];
}

export function withPipelineFilterValue(
  values: PipelineFilterValues,
  key: PipelineFilterKey,
  value: string,
): PipelineFilterValues {
  switch (key) {
    case 'source':
      return {
        ...values,
        source: PIPELINE_FILTER_SOURCES.find((item) => item === value) ?? 'all',
      };
    case 'scope':
      return {
        ...values,
        scope: PIPELINE_FILTER_SCOPES.find((item) => item === value) ?? 'all',
      };
    case 'trigger':
      return {
        ...values,
        trigger:
          PIPELINE_FILTER_TRIGGERS.find((item) => item === value) ?? 'all',
      };
  }
}

export interface PluginsPipelineFiltersProps {
  readonly values: PipelineFilterValues;
  readonly onChange: (values: PipelineFilterValues) => void;
  /**
   * The Source choices, in render order. Defaults to every source; a list
   * that cannot contain a source (such as owned pipelines, which never
   * include catalog templates) omits it rather than offering an empty result.
   */
  readonly sources?: readonly PipelineSourceBadgeKey[];
}

/**
 * Filters for the Marketplace Pipelines tab: one capsule picker per
 * dimension, each showing its current value. Every dimension narrows
 * pipelines only, so the host renders this on that tab alone.
 */
export function PluginsPipelineFilters({
  values,
  onChange,
  sources = PIPELINE_FILTER_SOURCES,
}: PluginsPipelineFiltersProps): JSX.Element {
  const dimensions = [
    sourceDimension(sources),
    ...SCOPE_AND_TRIGGER_DIMENSIONS,
  ];
  return (
    <div
      role="group"
      aria-label="Filter workflows"
      data-testid="plugins-pipeline-filters"
      className="-mr-2.5 flex flex-wrap items-center gap-0"
    >
      {dimensions.map((dimension) => (
        <PipelineFilterPicker
          key={dimension.key}
          dimension={dimension}
          value={values[dimension.key]}
          onSelect={(value) =>
            onChange(withPipelineFilterValue(values, dimension.key, value))
          }
        />
      ))}
    </div>
  );
}

interface PipelineFilterPickerProps {
  readonly dimension: PipelineFilterDimension;
  readonly value: string;
  readonly onSelect: (value: string) => void;
}

function PipelineFilterPicker({
  dimension,
  value,
  onSelect,
}: PipelineFilterPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = dimension.options.find((option) => option.value === value);
  const options: readonly PipelineFilterOption[] = [
    { value: 'all', label: dimension.anyLabel },
    ...dimension.options,
  ];

  return (
    <div className="relative shrink-0">
      <PickerTrigger
        ref={triggerRef}
        data-testid={`plugins-pipeline-filter-${dimension.key}`}
        labelOnly
        onClick={(): void => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${dimension.title}: ${selected?.label ?? dimension.anyLabel}`}
      >
        {/* A set filter takes the primary ink; Any stays in the capsule's quiet ink. */}
        <span className={selected ? 'fg-primary' : undefined}>
          {selected?.label ?? dimension.anyLabel}
        </span>
        <PickerTriggerChevron open={open} />
      </PickerTrigger>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        aria-label={`${dimension.title} filter`}
        data-testid={`plugins-pipeline-filter-${dimension.key}-menu`}
        className="min-w-44"
      >
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <DropdownMenuItem
              key={option.value}
              role="menuitemradio"
              aria-checked={checked}
              data-testid={`plugins-pipeline-filter-${dimension.key}-${option.value}`}
              onMouseDown={(event): void => event.preventDefault()}
              onClick={(): void => {
                onSelect(option.value);
                setOpen(false);
              }}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {checked && (
                <span
                  aria-hidden="true"
                  className="ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center"
                >
                  <CheckIcon size="sm" />
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
      </FloatingMenu>
    </div>
  );
}
