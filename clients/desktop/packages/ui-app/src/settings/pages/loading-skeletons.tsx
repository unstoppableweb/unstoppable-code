'use client';

import type { JSX } from 'react';
import {
  CenteredLoadingSpinner,
  DataTableBody,
  DataTableCell,
  DataTableFrame,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
  DelayedLoadingPlaceholder,
  DisplayAvatar,
  Fact,
  FactList,
  SettingsRowsGroup,
  SettingsRowsRow,
  SettingsRowsSection,
  SettingsRowsValue,
  Skeleton,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import type { SettingsPageDataKind } from '@canopy/protocol/settings';

/**
 * The shape a settings page's body takes while it loads. A page whose shape
 * is predictable gets a skeleton of it; a page whose shape is not gets one
 * centered spinner.
 */
export type SettingsPageSkeletonVariant =
  | 'list'
  | 'form'
  | 'table'
  | 'cards'
  | 'chart'
  | 'graph'
  | 'spinner';

/**
 * The loading body of every hosted settings page, keyed by page-data kind.
 * Kept apart from the lazy page registry so a loading frame can import it
 * without loading page chunks. The mapped type makes a new page kind fail to
 * compile until it is listed here.
 */
export const HOSTED_SETTINGS_PAGE_SKELETONS: {
  readonly [K in SettingsPageDataKind]: SettingsPageSkeletonVariant;
} = {
  'account.account': 'form',
  'account.profile': 'form',
  'account.digests': 'cards',
  'account.digest': 'cards',
  'account.notifications': 'form',
  'account.integrations': 'list',
  'account.plugins': 'form',
  'account.mcp': 'form',
  'account.delegation': 'form',
  'account.security': 'form',
  'account.model-providers': 'list',
  'account.ai-gateway': 'form',
  'account.billing': 'cards',
  'account.invoice': 'table',
  'account.labs': 'form',
  'account.appearance': 'form',
  'organization.list': 'list',
  'organization.feed': 'list',
  'organization.feedItem': 'spinner',
  'organization.statistics': 'chart',
  'organization.digests': 'cards',
  'organization.digest': 'cards',
  'organization.members': 'list',
  'organization.member': 'spinner',
  'organization.memberDigest': 'cards',
  'organization.groups': 'list',
  'organization.projects': 'list',
  'organization.memory.facts': 'list',
  'organization.memory.graph': 'graph',
  'organization.memory.ops': 'table',
  'organization.memory.fact': 'spinner',
  'organization.settings': 'form',
  'organization.invoice': 'table',
};

/** Lists of organizations, teams, projects and tools show square logos. */
const SQUARE_AVATAR_KINDS: ReadonlySet<SettingsPageDataKind> = new Set([
  'account.integrations',
  'organization.list',
  'organization.groups',
  'organization.projects',
]);

/**
 * Form, table and cards pages load as the shared settings parts they render
 * once loaded, filled with plain sample data, inside the measured
 * `Skeleton`: skullet draws bars over the unseen samples, so the loaded page
 * replaces the skeleton in place. These are generic per page kind, so the
 * samples are short placeholders, not any one page's copy.
 */

const DEFAULT_ROWS = 3;

const noop = (): void => undefined;

function sampleIndexes(rows: number | undefined): readonly number[] {
  const count = Math.max(1, Math.floor(rows ?? DEFAULT_ROWS));
  return Array.from({ length: count }, (_, index) => index);
}

function sampleAt<T>(samples: readonly [T, ...T[]], index: number): T {
  return samples[index % samples.length] ?? samples[0];
}

interface SampleFormRow {
  readonly label: string;
  readonly description: string;
}

const SAMPLE_FORM_ROWS: readonly [SampleFormRow, ...SampleFormRow[]] = [
  { label: 'Email updates', description: 'Send a summary once a week' },
  { label: 'Sound', description: 'Play a sound when a task ends' },
  { label: 'Show previews', description: 'Show message text in alerts' },
];

/** Setting rows in the settings box, each with a switch. */
function SettingsFormSample({
  rows,
}: {
  readonly rows: number | undefined;
}): JSX.Element {
  return (
    <SettingsRowsGroup>
      {sampleIndexes(rows).map((index) => {
        const row = sampleAt(SAMPLE_FORM_ROWS, index);
        return (
          <SettingsRowsRow
            key={index}
            label={row.label}
            description={row.description}
            control={
              <ToggleSwitch checked={false} label={row.label} onChange={noop} />
            }
          />
        );
      })}
    </SettingsRowsGroup>
  );
}

const SAMPLE_TABLE_COLUMNS = ['Name', 'Date', 'Amount'] as const;

type SampleTableRow = readonly [string, string, string];

const SAMPLE_TABLE_ROWS: readonly [SampleTableRow, ...SampleTableRow[]] = [
  ['Sample item', 'Jan 1, 2026', '$10.00'],
  ['Another item', 'Jan 2, 2026', '$20.00'],
  ['Third item', 'Jan 3, 2026', '$30.00'],
];

/** The shared data table: a header row over three-column body rows. */
function SettingsTableSample({
  rows,
}: {
  readonly rows: number | undefined;
}): JSX.Element {
  return (
    <DataTableFrame layout="fixed">
      <DataTableHead>
        {SAMPLE_TABLE_COLUMNS.map((column) => (
          <DataTableHeaderCell key={column}>{column}</DataTableHeaderCell>
        ))}
      </DataTableHead>
      <DataTableBody>
        {sampleIndexes(rows).map((index) => (
          <DataTableRow key={index}>
            {sampleAt(SAMPLE_TABLE_ROWS, index).map((cell) => (
              <DataTableCell key={cell}>{cell}</DataTableCell>
            ))}
          </DataTableRow>
        ))}
      </DataTableBody>
    </DataTableFrame>
  );
}

const SAMPLE_CARD_SECTIONS = [
  {
    title: 'Summary',
    rows: [
      ['Plan', 'Sample plan'],
      ['Schedule', 'Every week'],
      ['Next update', 'Jan 1, 2026'],
    ],
  },
  {
    title: 'Details',
    rows: [
      ['Owner', 'Sample name'],
      ['Status', 'Active'],
    ],
  },
] as const;

/** Two settings sections of fact rows, the second shorter than the first. */
function SettingsCardsSample(): JSX.Element {
  return (
    <div className="flex flex-col gap-10">
      {SAMPLE_CARD_SECTIONS.map((section) => (
        <SettingsRowsSection key={section.title} title={section.title}>
          <SettingsRowsGroup>
            {section.rows.map(([label, value]) => (
              <SettingsRowsRow
                key={label}
                label={label}
                fact
                control={<SettingsRowsValue>{value}</SettingsRowsValue>}
              />
            ))}
          </SettingsRowsGroup>
        </SettingsRowsSection>
      ))}
    </div>
  );
}

const SAMPLE_CHART_TILES: readonly (readonly [string, string])[] = [
  ['Total runs', '1,280'],
  ['Tokens used', '48.2k'],
  ['Active people', '36'],
  ['Total cost', '$126.40'],
];

/**
 * A statistics section while it loads: the stat tiles are measured, and the
 * chart below them keeps its height with nothing drawn, because a chart is
 * drawn on a canvas and has nothing to measure.
 */
export function SettingsChartLoading(): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading statistics"
      testId="settings-skeleton-chart-bars"
      className="w-full"
    >
      <div className="flex flex-col gap-4">
        <FactList layout="stacked" columns={4} valueSize="large" rowGap="3">
          {SAMPLE_CHART_TILES.map(([label, value]) => (
            <Fact key={label} label={label}>
              {value}
            </Fact>
          ))}
        </FactList>
        <div className="h-48" />
      </div>
    </Skeleton>
  );
}

interface ListSample {
  readonly name: string;
  readonly meta: string;
}

const SAMPLE_LIST_ROWS: readonly [ListSample, ...ListSample[]] = [
  { name: 'Release notes', meta: 'Updated today' },
  { name: 'Checkout service', meta: 'Updated yesterday' },
  { name: 'Design review', meta: 'Updated last week' },
];

/** A list page's rows: an avatar beside a name and a line of detail. */
function SettingsListSample({
  rows,
  subject,
}: {
  readonly rows: number | undefined;
  readonly subject: 'person' | 'group';
}): JSX.Element {
  return (
    <SettingsRowsGroup>
      {sampleIndexes(rows).map((index) => {
        const row = sampleAt(SAMPLE_LIST_ROWS, index);
        return (
          <div key={index} className="flex items-center gap-3">
            <DisplayAvatar name={row.name} subject={subject} size="md" />
            <SettingsRowsRow label={row.name} description={row.meta} />
          </div>
        );
      })}
    </SettingsRowsGroup>
  );
}

function skeletonBody(
  kind: SettingsPageDataKind,
  rows: number | undefined,
): JSX.Element {
  switch (HOSTED_SETTINGS_PAGE_SKELETONS[kind]) {
    case 'list':
      return (
        <Skeleton
          loading
          label="Loading settings"
          testId="settings-skeleton-list"
          className="w-full"
        >
          <SettingsListSample
            rows={rows}
            subject={SQUARE_AVATAR_KINDS.has(kind) ? 'group' : 'person'}
          />
        </Skeleton>
      );
    case 'form':
      return (
        <Skeleton
          loading
          label="Loading settings"
          testId="settings-skeleton-form"
          className="w-full"
        >
          <SettingsFormSample rows={rows} />
        </Skeleton>
      );
    case 'table':
      return (
        <Skeleton
          loading
          label="Loading settings"
          testId="settings-skeleton-table"
          className="w-full"
        >
          <SettingsTableSample rows={rows} />
        </Skeleton>
      );
    case 'cards':
      return (
        <Skeleton
          loading
          label="Loading settings"
          testId="settings-skeleton-cards"
          className="w-full"
        >
          <SettingsCardsSample />
        </Skeleton>
      );
    case 'chart':
      return <SettingsChartLoading />;
    case 'graph':
    case 'spinner':
      return <CenteredLoadingSpinner />;
  }
}

/** Said below a settings page's skeleton once its load runs long. */
export const SETTINGS_PAGE_SLOW_LOAD_NOTE = 'Still loading settings…';

/**
 * The loading body for a settings page of `kind`: its skeleton (or the
 * centered spinner), in a box reserved from the first render and shown only
 * once loading takes noticeably long, with one quiet line below it if the
 * load runs long. `rows` sets the row count of list, form and table
 * skeletons. `delayMs` overrides the delay, for example `0` when the
 * previous page already held the screen for it.
 */
export function settingsPageSkeleton(
  kind: SettingsPageDataKind,
  rows?: number,
  delayMs?: number,
): JSX.Element {
  return (
    <DelayedLoadingPlaceholder
      delayMs={delayMs}
      slowNote={SETTINGS_PAGE_SLOW_LOAD_NOTE}
    >
      {skeletonBody(kind, rows)}
    </DelayedLoadingPlaceholder>
  );
}
