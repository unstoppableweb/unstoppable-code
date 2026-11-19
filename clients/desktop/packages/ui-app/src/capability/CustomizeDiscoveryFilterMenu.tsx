'use client';

import { useRef, useState, type JSX } from 'react';
import {
  Button,
  Count,
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuRowStyleProvider,
  FloatingMenu,
  HelpHint,
  PickerMenuSectionLabel,
  PickerTrigger,
  PickerTriggerChevron,
  Popover,
  QUIET_MENU_ROW_STYLE,
  RailIconButton,
  SegmentedControl,
  SettingsSelect,
  Tooltip,
  pipelineFilterDimensions,
  withPipelineFilterValue,
} from '@canopy/ui-shared/components';
import {
  CheckIcon,
  FilterIcon,
  PlusIcon,
  SettingsIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  CUSTOMIZE_DISCOVERY_HARNESS_OPTIONS,
  customizeDiscoveryFilterCount,
  customizeDiscoveryFiltersForTab,
  type CustomizeDiscoveryFilters,
  type CustomizeDiscoveryHarness,
} from '@canopy/ui-shared/lib';
import type { PipelineFilterValues } from '@canopy/ui-shared/lib/pipeline-filter-values';
import type { PipelineSourceBadgeKey } from '@canopy/ui-shared/lib/pipeline-source-badges';
import {
  useCustomizeDiscoveryFilters,
  useCustomizeDiscoverySourceOptions,
} from './CustomizeDiscoveryProvider';

export interface CustomizeDiscoveryFilterMenuProps {
  /** Runs after any filter changes, such as to drop a focused section. */
  readonly onFiltersChanged?: () => void;
  /**
   * Opens Settings → Harnesses at the first harness still to connect;
   * omitted where the host has none or every harness is connected.
   */
  readonly onAddHarness?: () => void;
  /** Opens the Marketplaces view; omitted where the host has none. */
  readonly onManageMarketplaces?: () => void;
  /**
   * The Workflows tab's Source, Scope and Trigger filters, shown as their
   * own sections; omitted on every other tab (Sergii's QA).
   */
  readonly workflowFilters?: CustomizeWorkflowFilters;
  /** The tab the menu filters; the Workflows tab has no marketplaces. */
  readonly tab?: string;
}

/** Why Marketplace is off on the Workflows tab (pending Sergii's OK). */
const MARKETPLACE_OFF_ON_WORKFLOWS =
  'Workflows don’t come from marketplaces. Use Source to filter them.';

export interface CustomizeWorkflowFilters {
  readonly values: PipelineFilterValues;
  readonly onChange: (values: PipelineFilterValues) => void;
  /** The Source choices; every source by default. */
  readonly sources?: readonly PipelineSourceBadgeKey[];
}

/** How many of the workflow filters are set. */
function workflowFilterCount(
  filters: CustomizeWorkflowFilters | undefined,
): number {
  if (filters === undefined) return 0;
  const { source, scope, trigger } = filters.values;
  return [source, scope, trigger].filter((value) => value !== 'all').length;
}

const ANY_SOURCE = '';
const TEST_ID = 'customize-discovery-filter';

/**
 * What each filter section does, in the help hint after its label (Sergii's
 * QA).
 */
const FILTER_HELP = {
  collections:
    'Yes shows only collections: bundles of skills, plugins and MCP servers. No lists them with everything else on the All tab.',
  marketplace:
    'The marketplace an item is listed in. Use the cog to add or remove marketplaces.',
  worksWith: 'Show only items that work with the selected harnesses.',
  source:
    'Who provides the workflow: Custom (made on this computer), Project (checked into this repo), Bundled (ships with the app), Shared (shared with you by a teammate or your organization), Curated (from the curated catalog).',
  scope:
    'Where a workflow can run: Global (no project), Directory (in a project folder, no worktree), Worktree (in a task’s git worktree).',
  trigger:
    'How a run starts: Dispatch (you or an agent start it), Plan ready (it builds a plan that’s ready), Task ready (it plans a task that’s ready).',
} as const;

/** A filter section's label with its help hint right after it. */
function FilterSectionLabel({
  label,
  help,
  hintKey,
}: {
  readonly label: string;
  readonly help: string;
  readonly hintKey: string;
}): JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <PickerMenuSectionLabel>{label}</PickerMenuSectionLabel>
      <HelpHint
        label={label}
        help={help}
        testId={`${TEST_ID}-help-${hintKey}`}
      />
    </span>
  );
}

function harnessLabel(harnesses: readonly CustomizeDiscoveryHarness[]): string {
  if (harnesses.length === 0) return 'Any harness';
  const labels = CUSTOMIZE_DISCOVERY_HARNESS_OPTIONS.filter((option) =>
    harnesses.includes(option.value),
  ).map((option) => option.label);
  return labels.length <= 2
    ? labels.join(', ')
    : `${String(labels.length)} harnesses`;
}

/** Works with: a multi-select field that starts at Any harness. */
function HarnessSelect({
  value,
  onChange,
  onAddHarness,
}: {
  readonly value: readonly CustomizeDiscoveryHarness[];
  readonly onChange: (value: readonly CustomizeDiscoveryHarness[]) => void;
  readonly onAddHarness?: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const label = harnessLabel(value);
  return (
    <>
      <PickerTrigger
        ref={triggerRef}
        variant="field"
        className="w-full"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Works with: ${label}`}
        data-testid={`${TEST_ID}-harness`}
        onClick={(): void => setOpen((current) => !current)}
      >
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <PickerTriggerChevron open={open} />
      </PickerTrigger>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-left"
        closeOnSelect={false}
        className="min-w-56"
        aria-label="Works with"
        data-testid={`${TEST_ID}-harness-menu`}
      >
        <DropdownMenuRowStyleProvider value={QUIET_MENU_ROW_STYLE}>
          <DropdownMenuItem
            role="menuitemradio"
            aria-checked={value.length === 0}
            data-testid={`${TEST_ID}-harness-any`}
            onClick={(): void => onChange([])}
          >
            <DropdownMenuItemIcon>
              {value.length === 0 ? <CheckIcon size="sm" aria-hidden /> : null}
            </DropdownMenuItemIcon>
            <span className="truncate">Any harness</span>
          </DropdownMenuItem>
          {CUSTOMIZE_DISCOVERY_HARNESS_OPTIONS.map((option) => {
            const checked = value.includes(option.value);
            return (
              <DropdownMenuItem
                key={option.value}
                role="menuitemcheckbox"
                aria-checked={checked}
                data-testid={`${TEST_ID}-harness-option-${option.value}`}
                onClick={(): void =>
                  onChange(
                    checked
                      ? value.filter((harness) => harness !== option.value)
                      : CUSTOMIZE_DISCOVERY_HARNESS_OPTIONS.map(
                          (candidate) => candidate.value,
                        ).filter(
                          (harness) =>
                            harness === option.value || value.includes(harness),
                        ),
                  )
                }
              >
                <DropdownMenuItemIcon>
                  {checked ? <CheckIcon size="sm" aria-hidden /> : null}
                </DropdownMenuItemIcon>
                <span className="truncate">{option.label}</span>
              </DropdownMenuItem>
            );
          })}
          {onAddHarness ? (
            <>
              <DropdownMenuDivider />
              <DropdownMenuItem
                data-testid={`${TEST_ID}-add-harness`}
                onClick={(): void => {
                  setOpen(false);
                  onAddHarness();
                }}
              >
                <DropdownMenuItemIcon>
                  <PlusIcon size="sm" aria-hidden />
                </DropdownMenuItemIcon>
                <span className="truncate">Connect a harness…</span>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuRowStyleProvider>
      </FloatingMenu>
    </>
  );
}

/**
 * New Customize's filter button after the search (CAN-6809): an icon button
 * with a count while filters are on, opening one menu with Only collections
 * (All tab), Marketplace (its cog opens Manage marketplaces) and Works with, each label
 * with a help hint; the Workflows tab adds Source, Scope and Trigger. Shared by desktop and Portal;
 * the host owns the filters.
 *
 * Deliberate deviation from docs/design/search.md (more than three filters go
 * behind a `Filter · n` dropdown of submenus): the CAN-6809 design draws one
 * panel with every filter visible, so this composes the shared Popover,
 * SegmentedControl and SettingsSelect instead.
 */
export function CustomizeDiscoveryFilterMenu({
  onFiltersChanged,
  onAddHarness,
  onManageMarketplaces,
  workflowFilters,
  tab,
}: CustomizeDiscoveryFilterMenuProps): JSX.Element {
  const marketplaceOff = tab === 'workflow';
  const { filters, setFilters } = useCustomizeDiscoveryFilters();
  const sourceOptions = useCustomizeDiscoverySourceOptions();
  const onFiltersChange = (next: CustomizeDiscoveryFilters): void => {
    setFilters(next);
    onFiltersChanged?.();
  };
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeCount =
    // Status is a pill beside the search, so the funnel counts only its own.
    customizeDiscoveryFilterCount({
      ...(tab === undefined
        ? filters
        : customizeDiscoveryFiltersForTab(filters, tab)),
      status: 'any',
    }) + workflowFilterCount(workflowFilters);
  const name =
    activeCount > 0 ? `Filters: ${String(activeCount)} on` : 'Filter';
  // A source the entries no longer carry still shows as picked, so it can be
  // cleared.
  const sources =
    filters.source !== null && !sourceOptions.includes(filters.source)
      ? [...sourceOptions, filters.source]
      : sourceOptions;
  const marketplaceSelect = (
    <SettingsSelect<string>
      width="fill"
      aria-label="Marketplace"
      data-testid={`${TEST_ID}-source`}
      // Off on Workflows: a marketplace picked elsewhere is kept, not applied.
      value={marketplaceOff ? ANY_SOURCE : (filters.source ?? ANY_SOURCE)}
      disabled={marketplaceOff}
      options={[
        { value: ANY_SOURCE, label: 'Any marketplace' },
        ...sources.map((source) => ({ value: source, label: source })),
      ]}
      onValueChange={(source): void =>
        onFiltersChange({
          ...filters,
          source: source === ANY_SOURCE ? null : source,
        })
      }
    />
  );
  return (
    <div className="relative shrink-0">
      <RailIconButton
        ref={triggerRef}
        icon={FilterIcon}
        size="row"
        tone={activeCount > 0 ? 'secondary' : 'neutral'}
        aria-label={name}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Filter"
        data-testid={TEST_ID}
        data-active={activeCount > 0 ? 'true' : 'false'}
        onClick={(): void => setOpen((current) => !current)}
      />
      {activeCount > 0 && (
        <Count
          value={activeCount}
          placement="icon"
          tone="unread"
          aria-hidden
          data-testid={`${TEST_ID}-count`}
          className="pointer-events-none absolute -right-1 -top-1"
        />
      )}
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        width="lg"
        aria-label="Filter"
        data-testid={`${TEST_ID}-menu`}
      >
        <div className="flex flex-col gap-3">
          {(tab === undefined || tab === 'all') && (
            <section className="flex flex-col gap-1">
              <FilterSectionLabel
                label="Only collections"
                help={FILTER_HELP.collections}
                hintKey="collections"
              />
              <SegmentedControl
                label="Only collections"
                value={filters.collections ? 'yes' : 'no'}
                width="fill"
                options={[
                  {
                    value: 'yes',
                    label: 'Yes',
                    dataTestId: `${TEST_ID}-collections-yes`,
                  },
                  {
                    value: 'no',
                    label: 'No',
                    dataTestId: `${TEST_ID}-collections-no`,
                  },
                ]}
                onChange={(value): void =>
                  onFiltersChange({ ...filters, collections: value === 'yes' })
                }
                dataTestId={`${TEST_ID}-collections`}
              />
            </section>
          )}
          <section className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <FilterSectionLabel
                label="Marketplace"
                help={FILTER_HELP.marketplace}
                hintKey="marketplace"
              />
              {onManageMarketplaces ? (
                <Tooltip label="Manage marketplaces">
                  <Button
                    iconOnly
                    size="sm"
                    variant="ghost"
                    aria-label="Manage marketplaces"
                    data-testid={`${TEST_ID}-manage-marketplaces`}
                    onClick={(): void => {
                      setOpen(false);
                      onManageMarketplaces();
                    }}
                  >
                    <SettingsIcon size="sm" aria-hidden />
                  </Button>
                </Tooltip>
              ) : null}
            </div>
            {marketplaceOff ? (
              // A disabled control fires no pointer or focus events, so the
              // wrapper holds the tooltip and the keyboard stop.
              <Tooltip label={MARKETPLACE_OFF_ON_WORKFLOWS} clamp={false}>
                <span
                  tabIndex={0}
                  aria-label={`Marketplace: ${MARKETPLACE_OFF_ON_WORKFLOWS}`}
                  data-testid={`${TEST_ID}-source-off`}
                  className="focus-ring block w-full"
                >
                  {marketplaceSelect}
                </span>
              </Tooltip>
            ) : (
              marketplaceSelect
            )}
          </section>
          {workflowFilters
            ? pipelineFilterDimensions(workflowFilters.sources).map(
                (dimension) => (
                  <section key={dimension.key} className="flex flex-col gap-1">
                    <FilterSectionLabel
                      label={dimension.title}
                      help={FILTER_HELP[dimension.key]}
                      hintKey={dimension.key}
                    />
                    <SettingsSelect<string>
                      width="fill"
                      aria-label={dimension.title}
                      data-testid={`${TEST_ID}-workflow-${dimension.key}`}
                      value={workflowFilters.values[dimension.key]}
                      options={[
                        { value: 'all', label: dimension.anyLabel },
                        ...dimension.options,
                      ]}
                      onValueChange={(value): void => {
                        workflowFilters.onChange(
                          withPipelineFilterValue(
                            workflowFilters.values,
                            dimension.key,
                            value,
                          ),
                        );
                        onFiltersChanged?.();
                      }}
                    />
                  </section>
                ),
              )
            : null}
          <section className="flex flex-col gap-1">
            <FilterSectionLabel
              label="Works with"
              help={FILTER_HELP.worksWith}
              hintKey="works-with"
            />
            <HarnessSelect
              value={filters.harnesses}
              onChange={(harnesses): void =>
                onFiltersChange({ ...filters, harnesses })
              }
              onAddHarness={
                onAddHarness
                  ? (): void => {
                      setOpen(false);
                      onAddHarness();
                    }
                  : undefined
              }
            />
          </section>
        </div>
      </Popover>
    </div>
  );
}
