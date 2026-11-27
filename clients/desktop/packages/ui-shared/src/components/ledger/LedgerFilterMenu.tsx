'use client';

import { Dot } from '../../primitives/Badge';
import { useRef, useState, type JSX, type ReactNode } from 'react';
import type {
  LedgerEntryType,
  LedgerStatus,
} from '@canopy/protocol/canopy-core';
import type {
  LedgerFeedFilters,
  LedgerFeedPeriod,
  LedgerViewFilters,
} from '@canopy/protocol/ledger-view';
import {
  ArchiveIcon,
  CircleCheckIcon,
  FilterIcon,
  HistoryIcon,
  ListFilterIcon,
  MacbookIcon,
  PersonIcon,
  SparkleIcon,
} from '../../icons/AppIcons';
import {
  LEDGER_ENTRY_TYPE_LABELS,
  LEDGER_STATUS_LABELS,
} from '../../lib/ledger-display';
import { Picker } from '../../primitives/Picker';
import {
  PickerOption,
  PickerOptionCheck,
  PickerOptionContent,
  PickerOptionLabel,
  PickerOptionLeading,
  PickerSection,
  PickerSectionLabel,
} from '../../primitives/PickerParts';
import { FilterMenuButton, pageFilter } from '../PageSearchRow';
import { RailIconButton } from '../RailIconButton';
import { LedgerEntryTypeIcon } from '../../icons/LedgerEntryTypeIcon';

const TYPE_OPTIONS: readonly LedgerEntryType[] = [
  'TASK',
  'ACTION',
  'DECISION',
  'OBSERVATION',
  'SUMMARY',
];

/** Open statuses first: they are the ones someone acts on. */
const STATUS_OPTIONS: readonly LedgerStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'NEEDS_REVIEW',
  'COMPLETED',
  'FAILED',
  'INFO',
];

export function isLedgerViewFiltered(filters: LedgerViewFilters): boolean {
  return (
    filters.types.length > 0 ||
    filters.statuses.length > 0 ||
    filters.owner !== 'anyone'
  );
}

function toggled<Value>(values: readonly Value[], value: Value): Value[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

export interface LedgerFilterMenuProps<Filters extends LedgerViewFilters> {
  filters: Filters;
  onChange: (filters: Filters) => void;
  /** Whether a filter is on; the panel's filters decide by default. */
  active?: boolean;
  /** Sections after Owner, for a view with more filters. */
  children?: ReactNode;
}

/**
 * The Ledger's filter control: entry types, statuses and owner, as checkbox
 * rows that stay open while the person picks. A dot on the trigger shows a
 * filter is on.
 */
export function LedgerFilterMenu<Filters extends LedgerViewFilters>({
  filters,
  onChange,
  active = isLedgerViewFiltered(filters),
  children,
}: LedgerFilterMenuProps<Filters>): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Opening focuses the first option, not the first checked one ("Anyone"
  // under Owner), so the menu starts at the top and reads in order.
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative shrink-0">
      <RailIconButton
        ref={triggerRef}
        icon={FilterIcon}
        iconSize={16}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((previous) => !previous);
        }}
        // The dot is visual only, so the name says a filter is on.
        aria-label={active ? 'Filter entries, filters on' : 'Filter entries'}
        aria-expanded={open}
        aria-haspopup="true"
        title="Filter entries"
        data-testid="ledger-filter-trigger"
        data-active={active ? 'true' : 'false'}
        hoverSurface
      />
      {active && (
        <Dot
          tone="filter"
          data-testid="ledger-filter-active-dot"
          className="pointer-events-none absolute right-0.5 top-0.5"
        />
      )}
      <Picker
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-left"
        heightLimit={360}
        interaction="menu"
        closeOnSelect={false}
        initialFocusRef={firstOptionRef}
        data-testid="ledger-filter-menu"
      >
        <PickerSectionLabel>Type</PickerSectionLabel>
        {TYPE_OPTIONS.map((type, index) => {
          const checked = filters.types.includes(type);
          return (
            <PickerOption
              key={type}
              ref={index === 0 ? firstOptionRef : undefined}
              role="menuitemcheckbox"
              aria-checked={checked}
              selected={checked}
              data-testid={`ledger-filter-type-${type.toLowerCase()}`}
              onClick={() =>
                onChange({ ...filters, types: toggled(filters.types, type) })
              }
            >
              <PickerOptionCheck selected={checked} reserveSpace />
              <PickerOptionLeading tone="secondary">
                <LedgerEntryTypeIcon type={type} />
              </PickerOptionLeading>
              <PickerOptionContent>
                <PickerOptionLabel>
                  {LEDGER_ENTRY_TYPE_LABELS[type]}
                </PickerOptionLabel>
              </PickerOptionContent>
            </PickerOption>
          );
        })}
        <PickerSection>
          <PickerSectionLabel>Status</PickerSectionLabel>
          {STATUS_OPTIONS.map((status) => {
            const checked = filters.statuses.includes(status);
            return (
              <PickerOption
                key={status}
                role="menuitemcheckbox"
                aria-checked={checked}
                selected={checked}
                data-testid={`ledger-filter-status-${status.toLowerCase()}`}
                onClick={() =>
                  onChange({
                    ...filters,
                    statuses: toggled(filters.statuses, status),
                  })
                }
              >
                <PickerOptionCheck selected={checked} reserveSpace />
                <PickerOptionContent>
                  <PickerOptionLabel>
                    {LEDGER_STATUS_LABELS[status]}
                  </PickerOptionLabel>
                </PickerOptionContent>
              </PickerOption>
            );
          })}
        </PickerSection>
        <PickerSection>
          <PickerSectionLabel>Owner</PickerSectionLabel>
          {(['anyone', 'you'] as const).map((owner) => {
            const checked = filters.owner === owner;
            return (
              <PickerOption
                key={owner}
                role="menuitemradio"
                aria-checked={checked}
                selected={checked}
                data-testid={`ledger-filter-owner-${owner}`}
                onClick={() => onChange({ ...filters, owner })}
              >
                <PickerOptionCheck selected={checked} reserveSpace />
                <PickerOptionContent>
                  <PickerOptionLabel>
                    {owner === 'anyone' ? 'Anyone' : 'You'}
                  </PickerOptionLabel>
                </PickerOptionContent>
              </PickerOption>
            );
          })}
        </PickerSection>
        {children}
      </Picker>
    </div>
  );
}

const PERIOD_OPTIONS: ReadonlyArray<{
  readonly period: LedgerFeedPeriod;
  readonly label: string;
}> = [
  { period: 'any', label: 'Any time' },
  { period: 'day', label: 'Past day' },
  { period: 'week', label: 'Past week' },
  { period: 'month', label: 'Past month' },
];

export function isLedgerFeedFiltered(filters: LedgerFeedFilters): boolean {
  return (
    isLedgerViewFiltered(filters) ||
    filters.author !== 'anyone' ||
    filters.period !== 'any' ||
    filters.includeArchived
  );
}

export interface LedgerFeedFilterMenuProps {
  filters: LedgerFeedFilters;
  onChange: (filters: LedgerFeedFilters) => void;
  onlyThisDevice?: {
    readonly checked: boolean;
    readonly onChange: (checked: boolean) => void;
  };
  /**
   * `icon` is the panel's filter glyph with a dot while a filter is on;
   * `page` is the quiet `Filter · 2` dropdown after a page's search, a row
   * per filter group, each opening its choices.
   */
  trigger?: 'icon' | 'page';
}

/**
 * The Feed's filter control: the Ledger's, plus who added an entry, when it
 * last changed, and whether archived work shows.
 */
export function LedgerFeedFilterMenu({
  filters,
  onChange,
  onlyThisDevice,
  trigger = 'icon',
}: LedgerFeedFilterMenuProps): JSX.Element {
  if (trigger === 'page') {
    return (
      <LedgerFeedPageFilter
        filters={filters}
        onChange={onChange}
        {...(onlyThisDevice === undefined ? {} : { onlyThisDevice })}
      />
    );
  }
  return (
    <LedgerFilterMenu
      filters={filters}
      onChange={onChange}
      active={
        isLedgerFeedFiltered(filters) || (onlyThisDevice?.checked ?? false)
      }
    >
      <PickerSection>
        <PickerSectionLabel>Added by</PickerSectionLabel>
        {(['anyone', 'you'] as const).map((author) => {
          const checked = filters.author === author;
          return (
            <PickerOption
              key={author}
              role="menuitemradio"
              aria-checked={checked}
              selected={checked}
              data-testid={`ledger-filter-author-${author}`}
              onClick={() => onChange({ ...filters, author })}
            >
              <PickerOptionCheck selected={checked} reserveSpace />
              <PickerOptionContent>
                <PickerOptionLabel>
                  {author === 'anyone' ? 'Anyone' : 'You'}
                </PickerOptionLabel>
              </PickerOptionContent>
            </PickerOption>
          );
        })}
      </PickerSection>
      <PickerSection>
        <PickerSectionLabel>Last changed</PickerSectionLabel>
        {PERIOD_OPTIONS.map(({ period, label }) => {
          const checked = filters.period === period;
          return (
            <PickerOption
              key={period}
              role="menuitemradio"
              aria-checked={checked}
              selected={checked}
              data-testid={`ledger-filter-period-${period}`}
              onClick={() => onChange({ ...filters, period })}
            >
              <PickerOptionCheck selected={checked} reserveSpace />
              <PickerOptionContent>
                <PickerOptionLabel>{label}</PickerOptionLabel>
              </PickerOptionContent>
            </PickerOption>
          );
        })}
      </PickerSection>
      <PickerSection>
        <PickerOption
          role="menuitemcheckbox"
          aria-checked={filters.includeArchived}
          selected={filters.includeArchived}
          data-testid="ledger-filter-include-archived"
          onClick={() =>
            onChange({ ...filters, includeArchived: !filters.includeArchived })
          }
        >
          <PickerOptionCheck selected={filters.includeArchived} reserveSpace />
          <PickerOptionContent>
            <PickerOptionLabel>Show archived work</PickerOptionLabel>
          </PickerOptionContent>
        </PickerOption>
      </PickerSection>
      {onlyThisDevice !== undefined && (
        <PickerSection>
          <PickerOption
            role="menuitemcheckbox"
            aria-checked={onlyThisDevice.checked}
            selected={onlyThisDevice.checked}
            data-testid="feed-only-this-device"
            onClick={() => onlyThisDevice.onChange(!onlyThisDevice.checked)}
          >
            <PickerOptionCheck selected={onlyThisDevice.checked} reserveSpace />
            <PickerOptionContent>
              <PickerOptionLabel>Only this device</PickerOptionLabel>
            </PickerOptionContent>
          </PickerOption>
        </PickerSection>
      )}
    </LedgerFilterMenu>
  );
}

const OWNER_OPTIONS = [{ value: 'you', label: 'You' }] as const;

/** The Feed's filters with nothing on. */
const LEDGER_FEED_NO_FILTERS: LedgerFeedFilters = {
  types: [],
  statuses: [],
  owner: 'anyone',
  author: 'anyone',
  period: 'any',
  includeArchived: false,
};

/**
 * The Feed's filters after its search: one quiet Filter dropdown with a row
 * per group (Type, Status, Owner, Added by, Last changed, Archived), each
 * naming its value and opening its choices as a submenu.
 */
function LedgerFeedPageFilter({
  filters,
  onChange,
  onlyThisDevice,
}: {
  readonly filters: LedgerFeedFilters;
  readonly onChange: (filters: LedgerFeedFilters) => void;
  readonly onlyThisDevice?: LedgerFeedFilterMenuProps['onlyThisDevice'];
}): JSX.Element {
  const groups = [
    pageFilter<LedgerEntryType>({
      key: 'type',
      title: 'Type',
      groupIcon: <ListFilterIcon />,
      anyLabel: 'Any type',
      multiple: true,
      options: TYPE_OPTIONS.map((type) => ({
        value: type,
        label: LEDGER_ENTRY_TYPE_LABELS[type],
        icon: <LedgerEntryTypeIcon type={type} />,
      })),
      selected: filters.types,
      onToggle: (type): void =>
        onChange({ ...filters, types: toggled(filters.types, type) }),
      onClear: (): void => onChange({ ...filters, types: [] }),
      testId: 'ledger-filter-type',
    }),
    pageFilter<LedgerStatus>({
      key: 'status',
      title: 'Status',
      groupIcon: <CircleCheckIcon />,
      anyLabel: 'Any status',
      multiple: true,
      options: STATUS_OPTIONS.map((status) => ({
        value: status,
        label: LEDGER_STATUS_LABELS[status],
      })),
      selected: filters.statuses,
      onToggle: (status): void =>
        onChange({ ...filters, statuses: toggled(filters.statuses, status) }),
      onClear: (): void => onChange({ ...filters, statuses: [] }),
      testId: 'ledger-filter-status',
    }),
    pageFilter<'you'>({
      key: 'owner',
      title: 'Owner',
      groupIcon: <PersonIcon />,
      anyLabel: 'Anyone',
      options: OWNER_OPTIONS,
      selected: filters.owner === 'you' ? ['you'] : [],
      onToggle: (): void =>
        onChange({
          ...filters,
          owner: filters.owner === 'you' ? 'anyone' : 'you',
        }),
      onClear: (): void => onChange({ ...filters, owner: 'anyone' }),
      testId: 'ledger-filter-owner',
    }),
    pageFilter<'you'>({
      key: 'author',
      title: 'Added by',
      groupIcon: <SparkleIcon />,
      anyLabel: 'Anyone',
      options: OWNER_OPTIONS,
      selected: filters.author === 'you' ? ['you'] : [],
      onToggle: (): void =>
        onChange({
          ...filters,
          author: filters.author === 'you' ? 'anyone' : 'you',
        }),
      onClear: (): void => onChange({ ...filters, author: 'anyone' }),
      testId: 'ledger-filter-author',
    }),
    pageFilter<Exclude<LedgerFeedPeriod, 'any'>>({
      key: 'period',
      title: 'Last changed',
      groupIcon: <HistoryIcon />,
      anyLabel: 'Any time',
      options: PERIOD_OPTIONS.flatMap(({ period, label }) =>
        period === 'any' ? [] : [{ value: period, label }],
      ),
      selected: filters.period === 'any' ? [] : [filters.period],
      onToggle: (period): void =>
        onChange({
          ...filters,
          period: filters.period === period ? 'any' : period,
        }),
      onClear: (): void => onChange({ ...filters, period: 'any' }),
      testId: 'ledger-filter-period',
    }),
    pageFilter<'archived'>({
      key: 'archived',
      title: 'Archived',
      groupIcon: <ArchiveIcon />,
      options: [{ value: 'archived', label: 'Show archived work' }],
      multiple: true,
      selected: filters.includeArchived ? ['archived'] : [],
      onToggle: (): void =>
        onChange({ ...filters, includeArchived: !filters.includeArchived }),
      onClear: (): void => onChange({ ...filters, includeArchived: false }),
      testId: 'ledger-filter-archived',
    }),
    ...(onlyThisDevice === undefined
      ? []
      : [
          pageFilter<'this_device'>({
            key: 'device',
            title: 'Device',
            groupIcon: <MacbookIcon />,
            anyLabel: 'Any device',
            options: [{ value: 'this_device', label: 'Only this device' }],
            selected: onlyThisDevice.checked ? ['this_device'] : [],
            onToggle: (): void =>
              onlyThisDevice.onChange(!onlyThisDevice.checked),
            onClear: (): void => onlyThisDevice.onChange(false),
            testId: 'feed-only-this-device',
          }),
        ]),
  ].map((filter) => filter.group);
  return (
    <FilterMenuButton
      groups={groups}
      onClearAll={(): void => {
        onChange(LEDGER_FEED_NO_FILTERS);
        onlyThisDevice?.onChange(false);
      }}
      name="Filter entries"
      testId="ledger-filter-trigger"
    />
  );
}
