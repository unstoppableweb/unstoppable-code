import {
  type JSX,
  type ReactNode,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ClaudeLogo,
  CodexLogo,
  PluginsIcon,
  SkillIcon,
  StorefrontIcon,
} from '../icons';
import { BundleIcon, RepoIcon } from '../icons/AppIcons';
import { formatDate } from '../lib/format-date';
import { Tooltip } from './Tooltip';
import {
  DEFAULT_SELECTION_TABLE_COPY,
  type SelectionTableCopy,
} from '../lib/installed-item-status';
import {
  ProviderSupportIcons,
  type ProviderSupportScope,
  type UnifiedProviderSupport,
} from './ProviderSupportIcons';
import { getUnifiedTableItemKey } from './unified-table-virtualization';
import { DelayedLoadingPlaceholder } from './DelayedLoadingPlaceholder';
import { Skeleton } from './Skeleton';
import { SegmentedControl } from './SegmentedControl';
import { Badge } from './Badge';
import {
  DataTableBody,
  DataTableCell,
  DataTableFrame,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
} from './DataTable';
import { Button } from './Button';
import { Checkbox, ChoiceField } from './Choice';
import { Disclosure } from './Disclosure';
import { Stack } from './Stack';
import { SettingsSelect, type SettingsSelectOption } from './SettingsSelect';
import { SearchField } from './SearchField';
import { FloatingMenu } from './FloatingMenu';

/**
 * Row kinds. MCP servers are one kind however the host built the row: the
 * portal's catalog refs and the desktop's device and account servers both
 * project as `mcp` (REG-3033). Device versus account is the Source column.
 */
export type UnifiedTableKind = 'skill' | 'plugin' | 'collection' | 'mcp';
export type UnifiedTableSelectedFilter = 'all' | 'yes' | 'no';
export type UnifiedTableSourceIcon =
  | 'repo'
  | 'marketplace'
  | 'claude'
  | 'codex'
  | 'mixed'
  | 'app'
  | 'none';
export type UnifiedTableBadgeTone = 'neutral' | 'info' | 'warning' | 'danger';
export type UnifiedTableToggleMode =
  | 'normal'
  | 'locked'
  | 'disabled'
  | 'unsupported';

export interface UnifiedTableBadge {
  label: string;
  tone: UnifiedTableBadgeTone;
}

export interface UnifiedTableRow {
  kind: UnifiedTableKind;
  key: string;
  name: string;
  description: string;
  logoUrl?: string;
  curatedKey?: string;
  /**
   * Keep this row out of the "N selected" summary even while it is in
   * `selectedKeys`. For rows that are checked to state a fact rather than to
   * record a choice — a capability linked on the user's provider account is
   * checked, unchangeable, and never written to any saved configuration, so
   * counting it tells the user they selected something they did not.
   */
  excludeFromSelectionCount?: boolean;
  source: string;
  /** Stable filter identity; falls back to `source` for legacy desktop rows. */
  sourceId?: string;
  sourceSubtitle: string;
  sourceIcon: UnifiedTableSourceIcon;
  lastUpdated: string;
  badges?: UnifiedTableBadge[];
  toggleMode?: UnifiedTableToggleMode;
  toggleReason?: string;
  /** Display-only host action for a row that needs setup before selection. */
  selectionAction?: ReactNode;
  /**
   * Host action for a row that stays selectable while it needs attention,
   * such as connecting a server chosen before it is connected. Renders in the
   * trailing cell, before View.
   */
  rowAction?: ReactNode;
  providerSupport?: UnifiedProviderSupport;
  codexCompatDisabled?: boolean;
  viewDisabled?: boolean;
  /** Optional plugin contents, already resolved for the host's provider. */
  members?: { name: string; description: string; kind: string }[];
}

export interface UnifiedTableSourceOption {
  value: string;
  label: string;
  subtitle?: string;
  icon: Exclude<UnifiedTableSourceIcon, 'none'>;
}

export interface UnifiedTableProps {
  rows: UnifiedTableRow[];
  sourceOptions: UnifiedTableSourceOption[];
  selectedKeys: Set<string>;
  onToggle: (key: string) => void;
  onView: (row: UnifiedTableRow) => void;
  showCollectionKind: boolean;
  loading?: boolean;
  defaultSelectedFilter?: UnifiedTableSelectedFilter;
  hideSelectionSummary?: boolean;
  providerIconScope?: ProviderSupportScope;
  /** Host renderer for desktop's resolved MCP logos. */
  renderMcpLogo?: (row: UnifiedTableRow) => ReactNode;
  /** Host renderer for a brand-aware first-party source mark. */
  renderAppLogo?: () => ReactNode;
  rowCheckboxTestId?: string;
  /**
   * Mark only the rows' table body with the session-replay block class, so a
   * recorder keeps a same-size placeholder while the controls stay recorded.
   */
  blockRowsFromReplay?: boolean;
  /** Rendered at the end of the filter row, such as a scope chip. */
  toolbarTrailing?: ReactNode;
  /** What selecting means here; words only, never selection behavior. */
  selectionCopy?: SelectionTableCopy;
}

/** The source filter's glyphs; an app's logo comes from the host. */
const SOURCE_OPTION_GLYPHS: Readonly<
  Record<Exclude<UnifiedTableSourceIcon, 'none' | 'app'>, JSX.Element>
> = {
  repo: <RepoIcon size="sm" />,
  marketplace: <StorefrontIcon size="sm" />,
  claude: <ClaudeLogo width={12} height={12} />,
  codex: <CodexLogo width={12} height={12} />,
  mixed: (
    <span className="inline-flex gap-0.5">
      <ClaudeLogo width={10} height={10} />
      <CodexLogo width={10} height={10} />
    </span>
  ),
};

function SourceMultiSelect({
  options,
  active,
  onChange,
  renderAppLogo,
}: {
  options: UnifiedTableSourceOption[];
  active: Set<string>;
  onChange: (next: Set<string>) => void;
  renderAppLogo?: () => ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) setSearch('');
  }, [open]);
  const foldedSearch = search.toLowerCase();
  const filtered = useMemo(
    () =>
      options.filter(
        (option) =>
          option.label.toLowerCase().includes(foldedSearch) ||
          option.subtitle?.toLowerCase().includes(foldedSearch),
      ),
    [foldedSearch, options],
  );
  const toggle = (value: string): void => {
    const next = new Set(active);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };
  return (
    <>
      <Button
        ref={buttonRef}
        size="compact"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="max-w-30 truncate">
          {active.size === 0
            ? 'All sources'
            : `${String(active.size)} source${active.size === 1 ? '' : 's'}`}
        </span>
        <span aria-hidden>⌄</span>
      </Button>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={buttonRef}
        placement="bottom-left"
        interaction="manual"
        // A filter form: the search field and the checkboxes take Tab, and
        // Escape or a press outside closes it.
        trapFocus
        openOnArrowKeys={false}
        initialFocusRef={searchRef}
        role="dialog"
        aria-label="Sources"
        className="w-64"
      >
        <div className="p-0.5 pb-0">
          <SearchField
            ref={searchRef}
            value={search}
            onValueChange={setSearch}
            placeholder="Search sources…"
            aria-label="Search sources"
            // Escape closes the dropdown, as it does from its rows.
            clearOnEscape={false}
          />
        </div>
        <div className="max-h-60 overflow-y-auto p-0.5">
          {filtered.length === 0 && (
            <p className="px-2 py-3 text-center text-xs fg-secondary">
              {options.length === 0
                ? 'No sources available'
                : 'No matching sources'}
            </p>
          )}
          {filtered.map((option) => (
            // The row draws the inset and hover fill; the field's text
            // toggles it.
            <div
              key={option.value}
              className="rounded-md px-2 py-1.5 transition-colors hover:bg-secondary/50"
            >
              <ChoiceField
                checked={active.has(option.value)}
                onChange={() => toggle(option.value)}
                label={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 fg-secondary">
                      {option.icon === 'app'
                        ? (renderAppLogo?.() ?? <StorefrontIcon size="sm" />)
                        : SOURCE_OPTION_GLYPHS[option.icon]}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs fg-primary">
                        {option.label}
                      </span>
                      {option.subtitle && (
                        <span className="block truncate text-3xs fg-secondary">
                          {option.subtitle}
                        </span>
                      )}
                    </span>
                  </span>
                }
              />
            </div>
          ))}
        </div>
        {active.size > 0 && (
          <div className="border-t px-1.5 pt-1">
            <Button
              variant="ghost"
              size="compact"
              onClick={() => onChange(new Set())}
            >
              Clear all
            </Button>
          </div>
        )}
      </FloatingMenu>
    </>
  );
}

/** A row's kind glyph; an MCP server's logo comes from the host. */
const KIND_GLYPHS: Readonly<Partial<Record<UnifiedTableKind, JSX.Element>>> = {
  skill: <SkillIcon size="sm" />,
  plugin: <PluginsIcon size="sm" />,
  collection: <BundleIcon size="sm" />,
};

/** A row's source glyph; an app's logo comes from the host. */
const SOURCE_GLYPHS: Readonly<
  Record<Exclude<UnifiedTableSourceIcon, 'none' | 'app'>, JSX.Element>
> = {
  repo: <RepoIcon size="sm" data-testid="source-icon-repo" />,
  marketplace: (
    <StorefrontIcon size="sm" data-testid="source-icon-marketplace" />
  ),
  claude: (
    <ClaudeLogo width={12} height={12} data-testid="source-icon-claude" />
  ),
  codex: <CodexLogo width={12} height={12} data-testid="source-icon-codex" />,
  mixed: (
    <span className="inline-flex gap-0.5" data-testid="source-icon-mixed">
      <ClaudeLogo
        width={10}
        height={10}
        data-testid="source-icon-mixed-claude"
      />
      <CodexLogo width={10} height={10} data-testid="source-icon-mixed-codex" />
    </span>
  ),
};

/** Selection, Name, Source, Last updated and Actions. */
const COLUMN_COUNT = 5;
const VIRTUALIZED_ROW_THRESHOLD = 120;
const ESTIMATED_ROW_HEIGHT_PX = 48;

interface RowViewProps {
  row: UnifiedTableRow;
  checked: boolean;
  expanded: boolean;
  onExpand: (key: string) => void;
  providerIconScope: ProviderSupportScope;
  onToggle: (key: string) => void;
  onView: (row: UnifiedTableRow) => void;
  renderMcpLogo?: (row: UnifiedTableRow) => ReactNode;
  renderAppLogo?: () => ReactNode;
  measureRef?: (element: HTMLTableRowElement | null) => void;
  virtualIndex?: number;
  rowCheckboxTestId?: string;
  selectionCopy: SelectionTableCopy;
  /** False when no row of the table has a date, so the column is left out. */
  showLastUpdated: boolean;
}

const UnifiedTableRowView = memo(function UnifiedTableRowView({
  row,
  checked,
  expanded,
  onExpand,
  providerIconScope,
  onToggle,
  onView,
  renderMcpLogo,
  renderAppLogo,
  measureRef,
  virtualIndex,
  rowCheckboxTestId,
  selectionCopy,
  showLastUpdated,
}: RowViewProps): JSX.Element {
  const toggleMode = row.toggleMode ?? 'normal';
  const locked = toggleMode === 'locked';
  const disabled =
    locked ||
    toggleMode === 'disabled' ||
    (toggleMode === 'unsupported' && !checked);
  const handleToggle = (): void => {
    if (!disabled) onToggle(row.key);
  };
  return (
    <DataTableRow
      ref={measureRef}
      data-index={virtualIndex}
      title={row.toggleReason}
    >
      <DataTableCell align="center">
        {row.selectionAction}
        {(!row.selectionAction || checked) && (
          <Checkbox
            checked={locked || checked}
            onChange={handleToggle}
            disabled={disabled}
            // Centred in its cell; the row's text carries the unsupported
            // dimming.
            className="mx-auto"
            data-toggle-mode={toggleMode}
            data-testid={rowCheckboxTestId}
            data-row-key={row.key}
            aria-label={
              toggleMode === 'unsupported' && row.toggleReason
                ? `${selectionCopy.rowLabel(row.name)} (${row.toggleReason})`
                : selectionCopy.rowLabel(row.name)
            }
          />
        )}
      </DataTableCell>
      <DataTableCell overflow="wrap">
        <Stack gap="tight">
          <Stack gap="inline">
            <button
              type="button"
              onClick={handleToggle}
              disabled={disabled}
              className={`flex w-full min-w-0 items-center gap-2 text-left ${disabled ? 'cursor-not-allowed' : ''} ${toggleMode === 'unsupported' ? 'opacity-70' : ''}`}
            >
              <span className="shrink-0 fg-secondary">
                {KIND_GLYPHS[row.kind] ??
                  (row.kind === 'mcp' && renderMcpLogo ? (
                    renderMcpLogo(row)
                  ) : (
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-subtle text-3xs font-medium fg-secondary">
                      {row.name.trim().charAt(0).toUpperCase() || '•'}
                    </span>
                  ))}
              </span>
              <Stack as="span" gap="tight" className="min-w-0 flex-1">
                {row.badges && row.badges.length > 0 && (
                  <span className="flex flex-wrap gap-1">
                    {row.badges.map((badge, index) => (
                      <Badge
                        key={`${badge.label}-${String(index)}`}
                        tone={badge.tone}
                      >
                        {badge.label}
                      </Badge>
                    ))}
                  </span>
                )}
                <span className="block">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      className="block min-w-0 truncate text-s font-medium fg-primary"
                      title={row.name}
                    >
                      {row.name}
                    </span>
                    {row.kind === 'plugin' && row.providerSupport && (
                      <ProviderSupportIcons
                        support={row.providerSupport}
                        codexCompatDisabled={row.codexCompatDisabled}
                        scope={providerIconScope}
                        size={12}
                        className="shrink-0"
                      />
                    )}
                  </span>
                  {row.description && (
                    <Tooltip
                      label={row.description}
                      clamp
                      allowShrink
                      className="max-w-full"
                      replayBlock
                    >
                      <span className="min-w-0 truncate text-xs fg-secondary">
                        {row.description}
                      </span>
                    </Tooltip>
                  )}
                </span>
              </Stack>
            </button>
            {row.members && row.members.length > 0 && (
              <Disclosure
                label={
                  expanded
                    ? 'Hide capabilities'
                    : `${row.members.length} capabilities`
                }
                open={expanded}
                onOpenChange={() => onExpand(row.key)}
                dataTestId="plugin-members"
                toggleTestId="plugin-members-toggle"
              >
                <ul
                  className="flex flex-col gap-2 border-l pl-3"
                  aria-label={`${row.name} capabilities`}
                >
                  {row.members.map((member, index) => (
                    <li
                      key={`${member.kind}:${member.name}:${index}`}
                      className="text-xs"
                    >
                      <span className="font-medium fg-primary">
                        {member.name}
                      </span>
                      <span className="ml-2 fg-secondary">{member.kind}</span>
                      <p className="whitespace-normal break-words fg-secondary">
                        {member.description}
                      </p>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
          </Stack>
          {row.members && (
            <p className="text-xs fg-secondary">
              {row.toggleReason ??
                selectionCopy.rowStateText?.(checked) ??
                (checked ? 'Selected' : 'Available to enable')}
            </p>
          )}
        </Stack>
      </DataTableCell>
      <DataTableCell overflow="wrap">
        {row.source ? (
          <span className="flex items-start gap-1.5">
            <span className="mt-0.5 shrink-0 fg-secondary">
              {row.sourceIcon === 'none' ? null : row.sourceIcon === 'app' ? (
                <span data-testid="source-icon-app">
                  {renderAppLogo?.() ?? <StorefrontIcon size="sm" />}
                </span>
              ) : (
                SOURCE_GLYPHS[row.sourceIcon]
              )}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-s fg-primary">
                {row.source}
              </span>
              {row.sourceSubtitle && (
                <span className="block truncate text-xs fg-secondary">
                  {row.sourceSubtitle}
                </span>
              )}
            </span>
          </span>
        ) : (
          <span className="fg-secondary">—</span>
        )}
      </DataTableCell>
      {showLastUpdated && (
        <DataTableCell>
          {row.lastUpdated ? formatDate(row.lastUpdated) : '—'}
        </DataTableCell>
      )}
      <DataTableCell align="right">
        <span className="inline-flex items-center justify-end gap-1">
          {row.rowAction}
          {row.viewDisabled ? (
            row.rowAction ? null : (
              <span className="inline-block px-1.5 py-0.5 text-3xs fg-secondary/60">
                —
              </span>
            )
          ) : (
            <Button
              variant="ghost-quiet"
              size="compact"
              onClick={() => onView(row)}
            >
              View
            </Button>
          )}
        </span>
      </DataTableCell>
    </DataTableRow>
  );
});

function SelectionFilterCount({
  value,
  testId,
}: {
  value: number;
  testId: string;
}): JSX.Element {
  return (
    <span className="tabular-nums fg-tertiary" data-testid={testId}>
      {' '}
      {value}
    </span>
  );
}

/** The Kind filter's options: Collection and MCP server only when offered. */
function kindFilterOptionsFor(
  showCollectionKind: boolean,
  showMcpKind: boolean,
): readonly SettingsSelectOption<UnifiedTableKind | 'all'>[] {
  const options: SettingsSelectOption<UnifiedTableKind | 'all'>[] = [
    { value: 'all', label: 'All kinds' },
    { value: 'skill', label: 'Skill' },
    { value: 'plugin', label: 'Plugin' },
  ];
  if (showCollectionKind) {
    options.push({ value: 'collection', label: 'Collection' });
  }
  if (showMcpKind) options.push({ value: 'mcp', label: 'MCP server' });
  return options;
}

function UnifiedTableHead({
  selectionLabel,
  showLastUpdated,
}: {
  selectionLabel: string;
  showLastUpdated: boolean;
}): JSX.Element {
  return (
    <DataTableHead sticky>
      <DataTableHeaderCell width="2.5rem" labelHidden>
        {selectionLabel}
      </DataTableHeaderCell>
      <DataTableHeaderCell width="40%">Name</DataTableHeaderCell>
      <DataTableHeaderCell width="30%">Source</DataTableHeaderCell>
      {showLastUpdated && (
        <DataTableHeaderCell width="7rem">Last updated</DataTableHeaderCell>
      )}
      <DataTableHeaderCell width="3.5rem" labelHidden>
        Actions
      </DataTableHeaderCell>
    </DataTableHead>
  );
}

/** Plain rows the loading skeleton measures: a name, a line, a source. */
const SAMPLE_ROWS: readonly UnifiedTableRow[] = [
  {
    kind: 'plugin',
    key: 'unified-table-sample-1',
    name: 'Release notes',
    description: 'Drafts release notes from merged pull requests',
    source: 'Marketplace',
    sourceSubtitle: '',
    sourceIcon: 'none',
    lastUpdated: '2026-01-01T00:00:00.000Z',
  },
  {
    kind: 'skill',
    key: 'unified-table-sample-2',
    name: 'Code review',
    description: 'Reviews a change for bugs before it merges',
    source: 'Repository',
    sourceSubtitle: '',
    sourceIcon: 'none',
    lastUpdated: '2026-01-01T00:00:00.000Z',
  },
  {
    kind: 'mcp',
    key: 'unified-table-sample-3',
    name: 'Issue tracker',
    description: 'Reads and updates issues in your tracker',
    source: 'Account',
    sourceSubtitle: '',
    sourceIcon: 'none',
    lastUpdated: '2026-01-01T00:00:00.000Z',
  },
];

const noop = (): void => undefined;

/**
 * Rows that have not arrived: the table itself, with its real header and
 * rows, rendered from plain samples inside the measured `Skeleton`.
 */
function UnifiedTableSkeleton({
  providerIconScope,
}: {
  providerIconScope: ProviderSupportScope;
}): JSX.Element {
  return (
    <DelayedLoadingPlaceholder slowNote="Still loading plugins, skills and MCP servers…">
      <Skeleton
        loading
        label="Loading plugins, skills and MCP servers"
        testId="unified-table-loading"
      >
        <DataTableFrame
          layout="fixed"
          caption="Plugins, skills and MCP servers"
        >
          <UnifiedTableHead
            selectionLabel={DEFAULT_SELECTION_TABLE_COPY.headerLabel}
            showLastUpdated
          />
          <DataTableBody>
            {SAMPLE_ROWS.map((row) => (
              <UnifiedTableRowView
                key={row.key}
                row={row}
                checked={false}
                expanded={false}
                onExpand={noop}
                providerIconScope={providerIconScope}
                onToggle={noop}
                onView={noop}
                selectionCopy={DEFAULT_SELECTION_TABLE_COPY}
                showLastUpdated
              />
            ))}
          </DataTableBody>
        </DataTableFrame>
      </Skeleton>
    </DelayedLoadingPlaceholder>
  );
}

export function UnifiedTable({
  rows,
  sourceOptions,
  selectedKeys,
  onToggle,
  onView,
  showCollectionKind,
  loading = false,
  defaultSelectedFilter = 'all',
  hideSelectionSummary = false,
  providerIconScope = 'mixed',
  renderMcpLogo,
  renderAppLogo,
  rowCheckboxTestId,
  blockRowsFromReplay = false,
  toolbarTrailing,
  selectionCopy = DEFAULT_SELECTION_TABLE_COPY,
}: UnifiedTableProps): JSX.Element {
  const [selectedFilter, setSelectedFilter] =
    useState<UnifiedTableSelectedFilter>(defaultSelectedFilter);
  const [nameSearch, setNameSearch] = useState('');
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleExpanded = useCallback((key: string): void => {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const [kindFilter, setKindFilter] = useState<UnifiedTableKind | 'all'>('all');
  const [activeSources, setActiveSources] = useState<Set<string>>(
    () => new Set(),
  );
  const deferredNameSearch = useDeferredValue(nameSearch);
  const query = deferredNameSearch.toLowerCase();

  const onToggleRef = useRef(onToggle);
  const onViewRef = useRef(onView);
  useEffect(() => {
    onToggleRef.current = onToggle;
    onViewRef.current = onView;
  }, [onToggle, onView]);
  const stableToggle = useCallback((key: string): void => {
    onToggleRef.current(key);
  }, []);
  const stableView = useCallback((row: UnifiedTableRow): void => {
    onViewRef.current(row);
  }, []);

  const rowKindByKey = useMemo(() => {
    const result = new Map<string, UnifiedTableKind>();
    for (const row of rows) {
      if (row.excludeFromSelectionCount) continue;
      result.set(row.key, row.kind);
    }
    return result;
  }, [rows]);
  const availableKinds = useMemo(
    () => new Set(rows.map((row) => row.kind)),
    [rows],
  );
  // A catalog whose rows carry no dates, such as a cloud chat's on desktop,
  // would show a column of dashes; it is left out instead (CAN-6397). Every
  // row counts, not only the filtered ones, so a filter never moves columns.
  const showLastUpdated = useMemo(
    () => rows.some((row) => row.lastUpdated !== ''),
    [rows],
  );
  const columnCount = showLastUpdated ? COLUMN_COUNT : COLUMN_COUNT - 1;
  const showMcpKind = availableKinds.has('mcp');
  const kindFilterOptions = useMemo(
    () => kindFilterOptionsFor(showCollectionKind, showMcpKind),
    [showCollectionKind, showMcpKind],
  );
  const selection = useMemo(() => {
    const counts = new Map<UnifiedTableKind, number>();
    let total = 0;
    for (const key of selectedKeys) {
      const kind = rowKindByKey.get(key);
      if (kind) {
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
        total += 1;
      }
    }
    const labels: Array<[UnifiedTableKind, string]> = [
      ['collection', 'collection'],
      ['skill', 'skill'],
      ['plugin', 'plugin'],
      ['mcp', 'MCP server'],
    ];
    const parts = labels.flatMap(([kind, label]) => {
      const count = counts.get(kind) ?? 0;
      return count === 0
        ? []
        : [`${String(count)} ${label}${count === 1 ? '' : 's'}`];
    });
    return {
      count: total,
      summary:
        parts.length === 0
          ? undefined
          : selectionCopy.countTooltip(parts.join(', ')),
    };
  }, [rowKindByKey, selectedKeys, selectionCopy]);
  const selectionFilterOptions = useMemo(
    () => [
      {
        value: 'all' as const,
        label: 'All',
        dataTestId: 'unified-table-filter-all',
        trailing: hideSelectionSummary ? undefined : (
          <SelectionFilterCount
            value={rows.length}
            testId="unified-table-total-count"
          />
        ),
      },
      {
        value: 'yes' as const,
        label: selectionCopy.selectedFilterLabel,
        dataTestId: 'unified-table-filter-selected',
        tooltip: hideSelectionSummary ? undefined : selection.summary,
        trailing: hideSelectionSummary ? undefined : (
          <SelectionFilterCount
            value={selection.count}
            testId="unified-table-selected-count"
          />
        ),
      },
      {
        value: 'no' as const,
        label: selectionCopy.unselectedFilterLabel,
        dataTestId: 'unified-table-filter-not-selected',
      },
    ],
    [hideSelectionSummary, rows.length, selection, selectionCopy],
  );

  const sortedEntries = useMemo(() => {
    const entries = rows.map((row) => ({
      row,
      foldedName: row.name.toLowerCase(),
      foldedDescription: row.description.toLowerCase(),
      foldedMembers: row.members?.map((member) =>
        `${member.name} ${member.description}`.toLowerCase(),
      ),
    }));
    entries.sort((left, right) => left.row.name.localeCompare(right.row.name));
    return entries;
  }, [rows]);
  const selectionFilterKeys = selectedFilter === 'all' ? null : selectedKeys;
  const filteredRows = useMemo(() => {
    const result: UnifiedTableRow[] = [];
    for (const entry of sortedEntries) {
      const row = entry.row;
      if (
        selectionFilterKeys &&
        ((selectedFilter === 'yes' && !selectionFilterKeys.has(row.key)) ||
          (selectedFilter === 'no' && selectionFilterKeys.has(row.key)))
      ) {
        continue;
      }
      if (
        query &&
        !entry.foldedName.includes(query) &&
        !entry.foldedDescription.includes(query) &&
        !entry.foldedMembers?.some((member) => member.includes(query))
      )
        continue;
      if (kindFilter !== 'all' && row.kind !== kindFilter) continue;
      if (
        activeSources.size > 0 &&
        !activeSources.has(row.sourceId ?? row.source)
      ) {
        continue;
      }
      result.push(row);
    }
    return result;
  }, [
    activeSources,
    kindFilter,
    query,
    selectedFilter,
    selectionFilterKeys,
    sortedEntries,
  ]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualized = filteredRows.length > VIRTUALIZED_ROW_THRESHOLD;
  const getItemKey = useCallback(
    (index: number) => getUnifiedTableItemKey(filteredRows, index),
    [filteredRows],
  );
  const rowVirtualizer = useVirtualizer({
    count: virtualized ? filteredRows.length : 0,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: () => ESTIMATED_ROW_HEIGHT_PX,
    overscan: 10,
  });
  const measureRow = useCallback(
    (element: HTMLTableRowElement | null): void => {
      rowVirtualizer.measureElement(element);
    },
    [rowVirtualizer],
  );
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [activeSources, kindFilter, query, selectedFilter]);
  const virtualItems = virtualized ? rowVirtualizer.getVirtualItems() : [];
  const firstVirtualItem = virtualItems[0];
  const lastVirtualItem = virtualItems[virtualItems.length - 1];
  const paddingTop = firstVirtualItem?.start ?? 0;
  const paddingBottom = lastVirtualItem
    ? rowVirtualizer.getTotalSize() - lastVirtualItem.end
    : 0;
  const showLoading = loading && rows.length === 0;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-2"
      data-testid="unified-table"
      data-row-count={filteredRows.length}
      data-virtualized={virtualized ? 'true' : 'false'}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <SegmentedControl
          value={selectedFilter}
          options={selectionFilterOptions}
          onChange={setSelectedFilter}
          label="Selection filter"
          width="content"
          dataTestId="unified-table-selection-filter"
        />
        <SearchField
          value={nameSearch}
          onValueChange={setNameSearch}
          placeholder="Search by name…"
          aria-label="Search by name"
          // Escape keeps closing the dialog that hosts the table.
          clearOnEscape={false}
          className="min-w-35 flex-1"
        />
        <SettingsSelect
          value={kindFilter}
          options={kindFilterOptions}
          onValueChange={setKindFilter}
          aria-label="Kind filter"
          width="fit"
        />
        <SourceMultiSelect
          options={sourceOptions}
          active={activeSources}
          onChange={setActiveSources}
          renderAppLogo={renderAppLogo}
        />
        {toolbarTrailing}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {showLoading && (
          <UnifiedTableSkeleton providerIconScope={providerIconScope} />
        )}
        {!showLoading && filteredRows.length === 0 && (
          <p className="py-8 text-center text-s fg-secondary">
            {deferredNameSearch ||
            selectedFilter !== 'all' ||
            kindFilter !== 'all' ||
            activeSources.size > 0
              ? 'No results match the current filters.'
              : 'No items available.'}
          </p>
        )}
        {filteredRows.length > 0 && (
          <DataTableFrame
            fill
            scrollRef={scrollRef}
            layout="fixed"
            caption="Plugins, skills and MCP servers"
          >
            <UnifiedTableHead
              selectionLabel={selectionCopy.headerLabel}
              showLastUpdated={showLastUpdated}
            />
            <DataTableBody replay={blockRowsFromReplay ? 'block' : undefined}>
              {paddingTop > 0 && (
                <tr aria-hidden style={{ height: paddingTop }}>
                  <td colSpan={columnCount} />
                </tr>
              )}
              {(virtualized ? virtualItems : filteredRows).map(
                (item, index) => {
                  const virtualItem = virtualized ? item : undefined;
                  const row = virtualized
                    ? filteredRows[
                        typeof virtualItem === 'object' &&
                        virtualItem !== null &&
                        'index' in virtualItem &&
                        typeof virtualItem.index === 'number'
                          ? virtualItem.index
                          : -1
                      ]
                    : filteredRows[index];
                  if (!row) return null;
                  const virtualIndex =
                    typeof virtualItem === 'object' &&
                    virtualItem !== null &&
                    'index' in virtualItem &&
                    typeof virtualItem.index === 'number'
                      ? virtualItem.index
                      : undefined;
                  return (
                    <UnifiedTableRowView
                      key={row.key}
                      row={row}
                      checked={selectedKeys.has(row.key)}
                      expanded={expandedKeys.has(row.key)}
                      onExpand={toggleExpanded}
                      providerIconScope={providerIconScope}
                      onToggle={stableToggle}
                      onView={stableView}
                      renderMcpLogo={renderMcpLogo}
                      renderAppLogo={renderAppLogo}
                      measureRef={virtualized ? measureRow : undefined}
                      virtualIndex={virtualIndex}
                      rowCheckboxTestId={rowCheckboxTestId}
                      selectionCopy={selectionCopy}
                      showLastUpdated={showLastUpdated}
                    />
                  );
                },
              )}
              {paddingBottom > 0 && (
                <tr aria-hidden style={{ height: paddingBottom }}>
                  <td colSpan={columnCount} />
                </tr>
              )}
            </DataTableBody>
          </DataTableFrame>
        )}
      </div>
    </div>
  );
}
