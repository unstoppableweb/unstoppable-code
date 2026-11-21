import { useState, type JSX } from 'react';
import {
  Button,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableFrame,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
  StatusGlyph,
  TableActionButton,
  TableActionsCell,
  type DataTableColumn,
} from '@canopy/ui-shared/components';
import type { StatusGlyphState } from '@canopy/ui-shared/lib';
import { DocumentPencilIcon } from '@canopy/ui-shared/icons/AppIcons';
import { SpecimenPanel } from './componentsLabParts';

interface RunRow {
  readonly name: string;
  readonly state: StatusGlyphState;
  readonly stateLabel: string;
  readonly trigger: string;
  readonly duration: string;
  readonly started: string;
}

const RUNS: readonly RunRow[] = [
  {
    name: 'Nightly release notes',
    state: 'done',
    stateLabel: 'Done',
    trigger: 'Schedule',
    duration: '4m 12s',
    started: '2h ago',
  },
  {
    name: 'Review pull request #7304',
    state: 'running',
    stateLabel: 'Running',
    trigger: 'Pull request',
    duration: '1m 03s',
    started: '5m ago',
  },
  {
    name: 'Dependency audit',
    state: 'failed',
    stateLabel: 'Failed',
    trigger: 'Manual',
    duration: '38s',
    started: 'Yesterday',
  },
  {
    name: 'Weekly digest',
    state: 'queued',
    stateLabel: 'Queued',
    trigger: 'Schedule',
    duration: '—',
    started: 'Mon',
  },
];

const RUN_COLUMNS: ReadonlyArray<DataTableColumn<RunRow>> = [
  { key: 'name', header: 'Workflow', render: (row) => row.name },
  {
    key: 'status',
    header: 'Status',
    render: (row) => (
      <span className="inline-flex items-center gap-1.5">
        <StatusGlyph state={row.state} size={14} />
        {row.stateLabel}
      </span>
    ),
  },
  { key: 'trigger', header: 'Trigger', render: (row) => row.trigger },
  {
    key: 'duration',
    header: 'Duration',
    align: 'right',
    render: (row) => row.duration,
  },
  {
    key: 'started',
    header: 'Started',
    tone: 'tertiary',
    render: (row) => row.started,
  },
];

/** The run columns with `showFrom`, for the breakpoint specimens. */
const RESPONSIVE_RUN_COLUMNS: ReadonlyArray<DataTableColumn<RunRow>> =
  RUN_COLUMNS.map((column) =>
    column.key === 'trigger'
      ? { ...column, showFrom: 'md' }
      : column.key === 'started'
        ? { ...column, showFrom: 'sm' }
        : column,
  );

interface StatRow {
  readonly person: string;
  readonly chats: number;
  readonly pullRequests: number;
  readonly credits: number | null;
}

const STATS: readonly StatRow[] = [
  { person: 'Ana Ruiz', chats: 128, pullRequests: 14, credits: 42.1 },
  { person: 'Kai Mori', chats: 96, pullRequests: 21, credits: 31.75 },
  { person: 'Sam Lee', chats: 41, pullRequests: 3, credits: null },
];

const STAT_COLUMNS: ReadonlyArray<DataTableColumn<StatRow>> = [
  {
    key: 'person',
    header: 'Person',
    replay: 'block',
    render: (row) => row.person,
    sortValue: (row) => row.person,
  },
  {
    key: 'chats',
    header: 'Chats',
    align: 'right',
    render: (row) => row.chats,
    sortValue: (row) => row.chats,
  },
  {
    key: 'pullRequests',
    header: 'Pull requests',
    align: 'right',
    render: (row) => row.pullRequests,
    sortValue: (row) => row.pullRequests,
  },
  {
    key: 'credits',
    header: 'Credits',
    align: 'right',
    render: (row) =>
      row.credits === null ? '—' : `$${row.credits.toFixed(2)}`,
    sortValue: (row) => row.credits,
  },
];

function SelectableRuns(): JSX.Element {
  const [selected, setSelected] = useState<string | null>(
    RUNS[1]?.name ?? null,
  );
  return (
    <DataTable<RunRow>
      columns={[
        ...RUN_COLUMNS.slice(0, 3),
        {
          key: 'actions',
          header: 'Actions',
          headerHidden: true,
          align: 'right',
          render: (row) => (
            <TableActionsCell>
              <TableActionButton
                label={`Edit ${row.name}`}
                onClick={(): void => undefined}
              >
                <DocumentPencilIcon size="sm" />
              </TableActionButton>
            </TableActionsCell>
          ),
        },
      ]}
      rows={RUNS}
      rowKey={(row) => row.name}
      onRowActivate={(row): void => setSelected(row.name)}
      selectedRowKey={selected}
      caption="Workflow runs"
    />
  );
}

/** A selectable row can also offer its named action as a button. */
function RowsWithOwnControl(): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <DataTableFrame caption="Workflow runs, selected by their name">
      <DataTableHead>
        <DataTableHeaderCell>Workflow</DataTableHeaderCell>
        <DataTableHeaderCell>Trigger</DataTableHeaderCell>
      </DataTableHead>
      <DataTableBody>
        {RUNS.slice(0, 2).map((run) => {
          const select = (): void => setSelected(run.name);
          return (
            <DataTableRow
              key={run.name}
              selected={selected === run.name}
              onActivate={select}
            >
              <DataTableCell tone="primary">
                <Button
                  size="compact"
                  aria-pressed={selected === run.name}
                  onClick={select}
                >
                  {run.name}
                </Button>
              </DataTableCell>
              <DataTableCell>{run.trigger}</DataTableCell>
            </DataTableRow>
          );
        })}
      </DataTableBody>
    </DataTableFrame>
  );
}

/** Grouped rows: a row header that spans its group, built from the parts. */
function GroupedParts(): JSX.Element {
  return (
    <DataTableFrame caption="Project readiness" layout="fixed">
      <DataTableHead>
        <DataTableHeaderCell width="36%">Project</DataTableHeaderCell>
        <DataTableHeaderCell>Recommendation</DataTableHeaderCell>
      </DataTableHead>
      <DataTableBody>
        <DataTableRow verticalAlign="top">
          <DataTableCell rowHeader rowSpan={2} tone="primary">
            canopy
          </DataTableCell>
          <DataTableCell>Add a setup script</DataTableCell>
        </DataTableRow>
        <DataTableRow verticalAlign="top">
          <DataTableCell>Share agent instructions</DataTableCell>
        </DataTableRow>
        <DataTableRow verticalAlign="top">
          <DataTableCell rowHeader tone="primary">
            ui-kit
          </DataTableCell>
          <DataTableCell overflow="wrap">
            Add a launch script so new worktrees start the dev server on their
            own.
          </DataTableCell>
        </DataTableRow>
      </DataTableBody>
    </DataTableFrame>
  );
}

export function TablesSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel
        title="DataTable"
        hint="Framed card, 32px header band, 36px rows"
      >
        <DataTable<RunRow>
          columns={RUN_COLUMNS}
          rows={RUNS}
          rowKey={(row) => row.name}
          caption="Workflow runs"
        />
      </SpecimenPanel>
      <SpecimenPanel
        title="Sortable columns with a group row"
        hint="Click a label"
      >
        <DataTable<StatRow>
          columns={STAT_COLUMNS}
          rows={STATS}
          rowKey={(row) => row.person}
          defaultSort={{ key: 'chats', direction: 'desc' }}
          columnGroups={[
            { label: 'Member', span: 1 },
            { label: 'Activity', span: 3 },
          ]}
          caption="Activity by member"
        />
      </SpecimenPanel>
      <SpecimenPanel
        title="Rows that open"
        hint="Hover fill, focus, selected row, an actions column"
      >
        <SelectableRuns />
      </SpecimenPanel>
      <SpecimenPanel
        title="Rows with no tab stop of their own"
        hint="A button inside is the keyboard path"
      >
        <RowsWithOwnControl />
      </SpecimenPanel>
      <SpecimenPanel
        title="Container breakpoints"
        hint="showFrom measures the table, not the window: Trigger from 42rem, Started from 36rem"
      >
        {['28rem', '48rem'].map((width) => (
          <div key={width} style={{ width }}>
            <DataTable<RunRow>
              columns={RESPONSIVE_RUN_COLUMNS}
              rows={RUNS}
              rowKey={(row) => row.name}
              breakpoints="container"
              caption={`Workflow runs at ${width}`}
            />
          </div>
        ))}
      </SpecimenPanel>
      <SpecimenPanel title="Empty and loading">
        <DataTable<RunRow>
          columns={RUN_COLUMNS}
          rows={[]}
          rowKey={(row) => row.name}
          emptyLabel="No runs yet"
        />
        <DataTable<RunRow>
          columns={RUN_COLUMNS}
          rows={RUNS}
          rowKey={(row) => row.name}
          loading
        />
      </SpecimenPanel>
      <SpecimenPanel title="Parts" hint="Grouped rows that span">
        <GroupedParts />
      </SpecimenPanel>
    </div>
  );
}
