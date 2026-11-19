import { useState, type JSX, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Chip,
  CopyButton,
  DataTable,
  DisplayAvatar,
  Fact,
  FactList,
  FormField,
  Heading,
  InlineMention,
  ListRow,
  ProgressBar,
  SegmentedControl,
  StatusGlyph,
  Surface,
  TabBar,
  TextInput,
  Tooltip,
  type DataTableColumn,
} from '@canopy/ui-shared/components';
import {
  ChatIcon,
  GitPullRequestIcon,
  LinearIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { brand } from '@/lib/brand';
import { COMPONENTS_LAB_ENTRIES } from './componentsLabCatalog';
import { COMPONENTS_LAB_PAGES } from './componentsLabPages';

/**
 * The lab's introduction: a bento of tiles on the shell, 4px apart as the
 * content card sits 4px from the shell's edge. The title tile sits in the
 * middle; around it, one tile per page shows that page's component itself,
 * live and at its real size, over the page's name. The stages (the scripted
 * windows) stay on the sheets.
 */

const noop = (): void => undefined;

function ButtonTile(): JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <Button>Cancel</Button>
      <Button variant="primary">Create pull request</Button>
    </div>
  );
}

function FieldTile(): JSX.Element {
  return (
    <div className="w-full">
      <FormField label="Branch name" description="Letters, numbers and dashes.">
        {(control) => (
          <TextInput {...control} defaultValue="fix-sidebar-zoom" />
        )}
      </FormField>
    </div>
  );
}

function SegmentedTile(): JSX.Element {
  const [value, setValue] = useState<'light' | 'dark' | 'system'>('dark');
  return (
    <SegmentedControl
      label="Appearance"
      value={value}
      width="content"
      onChange={setValue}
      options={[
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
        { value: 'system', label: 'System' },
      ]}
    />
  );
}

function TabsTile(): JSX.Element {
  const [tab, setTab] = useState<'overview' | 'runs' | 'settings'>('runs');
  return (
    <TabBar
      label="Workflow sections"
      items={[
        { id: 'overview', label: 'Overview' },
        { id: 'runs', label: 'Runs', count: 12 },
        { id: 'settings', label: 'Settings' },
      ]}
      value={tab}
      onChange={setTab}
    />
  );
}

function MarkersTile(): JSX.Element {
  return (
    <div className="flex flex-col gap-2 text-s fg-primary">
      <span className="flex items-center gap-2">
        <StatusGlyph state="done" size={14} />
        Code review <Badge tone="success">Passed</Badge>
      </span>
      <span className="flex items-center gap-2">
        <StatusGlyph state="failed" size={14} />
        Unit tests <Badge tone="danger">Failed</Badge>
      </span>
      <span className="flex items-center gap-2">
        <StatusGlyph state="queued" size={14} />
        Release build <Badge tone="neutral">Queued</Badge>
      </span>
    </div>
  );
}

function ChipTile(): JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <Chip onClick={noop}>design.png</Chip>
      <Chip onClick={noop}>README.md</Chip>
      <Chip>Fast</Chip>
    </div>
  );
}

function AvatarsTile(): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <DisplayAvatar name="Ana Ruiz" size="lg" />
      <DisplayAvatar name="Sam Lee" size="lg" />
      <DisplayAvatar name="Kai Mori" size="lg" />
      <DisplayAvatar name="Platform team" subject="group" size="lg" />
    </div>
  );
}

function ProgressTile(): JSX.Element {
  return (
    <div className="w-full">
      <ProgressBar value={42} label="Importing 4 of 10 projects" />
    </div>
  );
}

function TooltipTile(): JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <Tooltip label="New chat" shortcut="⌘N">
        <Button size="compact">New chat</Button>
      </Tooltip>
      <CopyButton
        value="fix-sidebar-zoom"
        label="Copy branch"
        variant="secondary"
        size="compact"
      />
    </div>
  );
}

function ReferenceTile(): JSX.Element {
  return (
    <p className="text-s text-pretty fg-primary">
      Fixed in{' '}
      <InlineMention icon={GitPullRequestIcon} onClick={noop}>
        #7116
      </InlineMention>{' '}
      for{' '}
      <InlineMention icon={LinearIcon} onClick={noop}>
        CAN-2405
      </InlineMention>
      .
    </p>
  );
}

function FactsTile(): JSX.Element {
  return (
    <FactList>
      <Fact label="Branch" mono>
        fix-sidebar-zoom
      </Fact>
      <Fact label="Updated">2 minutes ago</Fact>
      <Fact label="Cost" numeric>
        $1.24
      </Fact>
    </FactList>
  );
}

function TextTile(): JSX.Element {
  return (
    <div className="flex flex-col gap-1 fg-primary">
      <span className="text-m">Larger body, 16</span>
      <span className="text-s">Default body, 14</span>
      <span className="text-xs fg-secondary">Dense rows, 13</span>
      <span className="text-2xs fg-tertiary">Badge labels, 11</span>
    </div>
  );
}

function RadiusTile(): JSX.Element {
  return (
    <div className="grid w-full grid-cols-3 gap-2">
      <Surface variant="inset">
        <div className="h-14" />
      </Surface>
      <Surface variant="outline">
        <div className="h-14" />
      </Surface>
      <Surface variant="raised">
        <div className="h-14" />
      </Surface>
    </div>
  );
}

const CHATS: readonly { readonly title: string; readonly age: string }[] = [
  { title: 'Release notes draft', age: '2m' },
  { title: 'Fix flaky checkout test', age: '18m' },
  { title: 'Sidebar collapse at 200%', age: '1h' },
];

function ListTile(): JSX.Element {
  const [selected, setSelected] = useState(CHATS[1]?.title);
  return (
    <div className="flex w-full flex-col gap-0.5">
      {CHATS.map((chat) => (
        <ListRow
          key={chat.title}
          size="sm"
          icon={<ChatIcon />}
          trailing={chat.age}
          selected={selected === chat.title}
          onClick={(): void => setSelected(chat.title)}
        >
          {chat.title}
        </ListRow>
      ))}
    </div>
  );
}

interface RunRow {
  readonly name: string;
  readonly trigger: string;
  readonly duration: string;
}

const RUNS: readonly RunRow[] = [
  { name: 'Nightly release notes', trigger: 'Schedule', duration: '4m 12s' },
  { name: 'Dependency audit', trigger: 'Manual', duration: '38s' },
  { name: 'Weekly digest', trigger: 'Schedule', duration: '1m 03s' },
];

const RUN_COLUMNS: ReadonlyArray<DataTableColumn<RunRow>> = [
  { key: 'name', header: 'Workflow', render: (row) => row.name },
  {
    key: 'trigger',
    header: 'Trigger',
    tone: 'tertiary',
    render: (row) => row.trigger,
  },
  {
    key: 'duration',
    header: 'Duration',
    align: 'right',
    render: (row) => row.duration,
  },
];

function TableTile(): JSX.Element {
  return (
    <div className="w-full">
      <DataTable<RunRow>
        columns={RUN_COLUMNS}
        rows={RUNS}
        rowKey={(row): string => row.name}
        caption="Workflow runs"
      />
    </div>
  );
}

interface TileSpec {
  /** The page the tile opens, by its id in `componentsLabPages.ts`. */
  readonly pageId: string;
  readonly wide?: boolean;
  readonly Sample: () => JSX.Element;
}

const TILES: readonly TileSpec[] = [
  { pageId: 'button', Sample: ButtonTile },
  { pageId: 'text-input', Sample: FieldTile },
  { pageId: 'segmented-control', Sample: SegmentedTile },
  { pageId: 'markers', Sample: MarkersTile },
  { pageId: 'tab-bar', Sample: TabsTile },
  { pageId: 'list-row', Sample: ListTile },
  { pageId: 'text', Sample: TextTile },
  { pageId: 'chip', Sample: ChipTile },
  { pageId: 'data-table', wide: true, Sample: TableTile },
  { pageId: 'avatars', Sample: AvatarsTile },
  { pageId: 'facts', Sample: FactsTile },
  { pageId: 'reference-chips', Sample: ReferenceTile },
  { pageId: 'progress', Sample: ProgressTile },
  { pageId: 'tooltip-copy', Sample: TooltipTile },
  { pageId: 'radius', Sample: RadiusTile },
];

function Tile({
  name,
  wide,
  onOpen,
  children,
}: {
  readonly name: string;
  readonly wide: boolean;
  readonly onOpen: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Surface
      variant="card"
      padding="default"
      gap="item"
      className={wide ? 'col-span-2 min-w-0' : 'min-w-0'}
    >
      <div className="flex min-h-40 min-w-0 flex-1 items-center justify-center">
        {children}
      </div>
      <div className="flex justify-center">
        <Button
          size="compact"
          variant="ghost"
          aria-label={`Open the ${name} page`}
          onClick={onOpen}
        >
          {name}
        </Button>
      </div>
    </Surface>
  );
}

export function ComponentsLabIntro({
  onOpen,
}: {
  readonly onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <div
      data-testid="components-lab-overview"
      className="grid grid-flow-dense grid-cols-2 gap-1 xl:grid-cols-4"
    >
      <Surface
        variant="card"
        padding="roomy"
        gap="group"
        className="col-span-2 items-center justify-center text-center xl:col-start-2 xl:row-span-2 xl:row-start-2"
      >
        <Heading level={1} variant="display">
          {brand.displayName} design system
        </Heading>
        <p className="max-w-100 text-s text-pretty fg-secondary">
          Real shared components only. Every sample here and on the pages is
          live, so point at a control to judge it.
        </p>
        <FactList layout="stacked" columns={2} valueSize="large">
          <Fact label="Pages" numeric>
            {COMPONENTS_LAB_PAGES.length}
          </Fact>
          <Fact label="Specimen sheets" numeric>
            {COMPONENTS_LAB_ENTRIES.length}
          </Fact>
        </FactList>
      </Surface>
      {TILES.map(({ pageId, wide = false, Sample }) => {
        const page = COMPONENTS_LAB_PAGES.find(
          (candidate) => candidate.id === pageId,
        );
        if (!page) return null;
        return (
          <Tile
            key={pageId}
            name={page.name}
            wide={wide}
            onOpen={(): void => onOpen(pageId)}
          >
            <Sample />
          </Tile>
        );
      })}
    </div>
  );
}
