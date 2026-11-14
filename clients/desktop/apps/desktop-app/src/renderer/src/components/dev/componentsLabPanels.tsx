import {
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type { OpenCodeAccountSnapshot } from '@canopy/protocol/portal';
import {
  Button,
  CodeBlock,
  ComposerDrawer,
  ComposerSuggestionMenu,
  MarkdownCodeBlock,
  ModelUnlockPendingNotice,
  OnboardingTip,
  OpenCodeAccountCard,
  PageColumn,
  PickerMenuOptionLabel,
  PickerMenuTab,
  PickerMenuTabList,
  PickList,
  PickListResults,
  PipelineDispatchedTime,
  SearchField,
  Surface,
  pickListOptionId,
  resolvePickListActiveKey,
  usePickListKeys,
  type CodeBlockSize,
  type CodeBlockTone,
  type CodeBlockVariant,
  type CodeBlockWrap,
  type PageColumnWidth,
} from '@canopy/ui-shared/components';
import { CloseIcon, SkillIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  FocusOnMount,
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

const CODE_SAMPLE = 'pnpm run checks:dirty\npnpm test path/to/file.test.ts';
const LONG_CODE_LINE =
  'const message = "a line that is far wider than its column and must scroll sideways instead of wrapping or overflowing";';
const TALL_CODE = Array.from(
  { length: 30 },
  (_, index) => `line ${String(index + 1)}`,
).join('\n');
const ANSI_LINES = [
  '\u001b[32m✓\u001b[0m compiled in 2.1s',
  '\u001b[33mwarn\u001b[0m a deprecated option is set',
  '\u001b[31merror\u001b[0m the build failed',
];
const LONG_ANSI_LINE =
  'INSERT INTO very_long_table_name (first_column, second_column, third_column) VALUES (1, 2, 3), (4, 5, 6), (7, 8, 9), (10, 11, 12)';

const CODE_BLOCK_VARIANTS: readonly {
  readonly variant: CodeBlockVariant;
  readonly label: string;
}[] = [
  { variant: 'tint', label: 'Tint: on a card or dialog' },
  { variant: 'well', label: 'Well: on the code-block fill' },
  { variant: 'snippet', label: 'Snippet: a command in a row' },
  { variant: 'row', label: 'Row: a padded section of a card' },
  { variant: 'bare', label: 'Bare: the host draws the box' },
  { variant: 'card', label: 'Card: a document on a page' },
  { variant: 'pane', label: 'Pane: a full-height file view' },
  { variant: 'warning', label: 'Warning: standard error' },
];
const CODE_BLOCK_TONES: readonly CodeBlockTone[] = [
  'inherit',
  'primary',
  'soft',
  'secondary',
  'tertiary',
  'destructive',
  'warning',
];
const CODE_BLOCK_SIZES: readonly CodeBlockSize[] = [
  'inherit',
  '2xs',
  'xs',
  's',
];
const CODE_BLOCK_WRAPS: readonly CodeBlockWrap[] = [
  'none',
  'words',
  'all',
  'anywhere',
];

/** The page fill the `panel` surfaces sit on; the sheet itself is that fill. */
function OnPageFill({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Surface variant="inset" padding="compact" className="w-full">
      {children}
    </Surface>
  );
}

/** CodeBlock: every format, and every variant, size, wrap and tone of plain. */
export function CodeBlockSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Plain: variants">
        <SpecimenCell label="Panel (default): on the page fill">
          <OnPageFill>
            <CodeBlock>{CODE_SAMPLE}</CodeBlock>
          </OnPageFill>
        </SpecimenCell>
        {CODE_BLOCK_VARIANTS.map(({ variant, label }) => (
          <SpecimenCell key={variant} label={label}>
            <div className="w-full">
              <CodeBlock variant={variant}>{CODE_SAMPLE}</CodeBlock>
            </div>
          </SpecimenCell>
        ))}
      </SpecimenPanel>
      <SpecimenPanel title="Plain: long lines">
        {CODE_BLOCK_WRAPS.map((wrap) => (
          <SpecimenCell key={wrap} label={`Wrap ${wrap}`}>
            <div className="w-72">
              <CodeBlock variant="tint" wrap={wrap}>
                {LONG_CODE_LINE}
              </CodeBlock>
            </div>
          </SpecimenCell>
        ))}
      </SpecimenPanel>
      <SpecimenPanel title="Plain: type and ink">
        {CODE_BLOCK_SIZES.map((size) => (
          <SpecimenCell key={size} label={`Size ${size}`}>
            <div className="w-full text-xs">
              <CodeBlock variant="tint" size={size}>
                {CODE_SAMPLE}
              </CodeBlock>
            </div>
          </SpecimenCell>
        ))}
        {CODE_BLOCK_TONES.map((tone) => (
          <SpecimenCell key={tone} label={`Tone ${tone}`}>
            <div className="w-full">
              <CodeBlock variant="tint" tone={tone}>
                {CODE_SAMPLE}
              </CodeBlock>
            </div>
          </SpecimenCell>
        ))}
        <SpecimenCell label="Relaxed: 20px lines">
          <div className="w-full">
            <CodeBlock variant="tint" relaxed>
              {CODE_SAMPLE}
            </CodeBlock>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Sans: verbatim prose">
          <div className="w-full">
            <CodeBlock variant="tint" font="sans" size="s" tone="primary">
              {'Review the plan.\nAsk before changing it.'}
            </CodeBlock>
          </div>
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel title="Plain: height and content">
        <SpecimenCell label="Capped by the host: scrolls inside">
          <div className="w-full">
            <CodeBlock variant="tint" className="max-h-32">
              {TALL_CODE}
            </CodeBlock>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Collapsed: clipped, no scrollbar">
          <div className="w-full">
            <CodeBlock variant="tint" overflow="hidden" className="max-h-16">
              {TALL_CODE}
            </CodeBlock>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Empty">
          <div className="w-full">
            <CodeBlock variant="tint" />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Public text: replay not blocked">
          <div className="w-full">
            <CodeBlock variant="tint" replay="inherit" selectable>
              {CODE_SAMPLE}
            </CodeBlock>
          </div>
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel title="ANSI: terminal output, colors kept">
        <SpecimenCell label="Panel">
          <OnPageFill>
            <CodeBlock format="ansi" lines={ANSI_LINES} />
          </OnPageFill>
        </SpecimenCell>
        <SpecimenCell label="Tail: the last lines, one row each">
          <OnPageFill>
            <CodeBlock
              format="ansi"
              lines={[...ANSI_LINES, LONG_ANSI_LINE]}
              variant="tail"
              maxRenderLines={3}
              truncateLines
            />
          </OnPageFill>
        </SpecimenCell>
        <SpecimenCell label="Reader: the whole log, in a dialog">
          <OnPageFill>
            <CodeBlock format="ansi" lines={ANSI_LINES} variant="reader" />
          </OnPageFill>
        </SpecimenCell>
        <SpecimenCell label="Long line: wraps">
          <OnPageFill>
            <CodeBlock format="ansi" lines={[LONG_ANSI_LINE]} />
          </OnPageFill>
        </SpecimenCell>
        <SpecimenCell label="Search: matches are highlighted">
          <OnPageFill>
            <CodeBlock format="ansi" lines={ANSI_LINES} searchQuery="the" />
          </OnPageFill>
        </SpecimenCell>
        <SpecimenCell label="Empty: placeholder">
          <OnPageFill>
            <CodeBlock
              format="ansi"
              lines={[]}
              placeholder="Waiting for output"
            />
          </OnPageFill>
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel title="Markdown: the copy button reveals on hover or focus">
        <SpecimenCell label="Default" wide>
          <div className="w-full">
            <CodeBlock format="markdown">
              <code>{CODE_SAMPLE}</code>
            </CodeBlock>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Focused: the copy button is visible" wide>
          <div className="w-full">
            <FocusOnMount>
              <CodeBlock format="markdown" aria-label="Install command">
                <code>pnpm add @canopy/ui-shared</code>
              </CodeBlock>
            </FocusOnMount>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Long line: scrolls inside the block" wide>
          <div className="w-72">
            <CodeBlock format="markdown">
              <code>{LONG_CODE_LINE}</code>
            </CodeBlock>
          </div>
        </SpecimenCell>
        <SpecimenCell
          label="MarkdownCodeBlock: the renderer Markdown mounts directly"
          wide
        >
          <div className="w-full">
            <MarkdownCodeBlock>
              <code>{CODE_SAMPLE}</code>
            </MarkdownCodeBlock>
          </div>
        </SpecimenCell>
      </SpecimenPanel>
    </div>
  );
}

/** ModelUnlockPendingNotice: waiting and timed-out phases. */
export function ModelUnlockPendingSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="Advanced-model purchase finishing in the browser">
      <SpecimenCell label="Waiting, model named" wide>
        <div className="w-full">
          <ModelUnlockPendingNotice
            phase="waiting"
            modelLabel="Claude Opus 5.5"
            onCheckNow={noop}
          />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Waiting, model unknown" wide>
        <div className="w-full">
          <ModelUnlockPendingNotice phase="waiting" onCheckNow={noop} />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Waiting, a check in flight (busy)" wide>
        <div className="w-full">
          <ModelUnlockPendingNotice
            phase="waiting"
            modelLabel="Claude Opus 5.5"
            checking
            onCheckNow={noop}
          />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Timed out, checks stopped (no dismiss offered)" wide>
        <div className="w-full">
          <ModelUnlockPendingNotice phase="timed-out" onCheckNow={noop} />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Timed out, dismissible" wide>
        <div className="w-full">
          <ModelUnlockPendingNotice
            phase="timed-out"
            onCheckNow={noop}
            onDismiss={noop}
          />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Timed out, a check in flight (busy)" wide>
        <div className="w-full">
          <ModelUnlockPendingNotice
            phase="timed-out"
            checking
            onCheckNow={noop}
            onDismiss={noop}
          />
        </div>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

const TIP_ICON = <SkillIcon size="md" />;

function Tip({
  children,
  ...props
}: Partial<Parameters<typeof OnboardingTip>[0]> & {
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <OnboardingTip
      placement="inline"
      icon={TIP_ICON}
      title="Skills teach the agent your way"
      onDismiss={noop}
      {...props}
    >
      {children ?? 'Save a repeatable workflow once and reuse it in any chat.'}
    </OnboardingTip>
  );
}

/** OnboardingTip: inline, composer drawer and composer notice. */
export function OnboardingTipSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Inline (heads a page or panel)">
        <SpecimenCell label="Got it and close" wide>
          <div className="w-full max-w-xl">
            <Tip />
          </div>
        </SpecimenCell>
        <SpecimenCell label="With an action" wide>
          <div className="w-full max-w-xl">
            <Tip
              action={{ label: 'Open Library', onClick: noop, testId: 'a' }}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell
          label="Primary action, no Got it (the action is the point)"
          wide
        >
          <div className="w-full max-w-xl">
            <Tip
              dismissLabel={null}
              action={{
                label: 'Star on GitHub',
                onClick: noop,
                variant: 'primary',
              }}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Action busy (a click does nothing)" wide>
          <div className="w-full max-w-xl">
            <Tip
              action={{
                label: 'Connect',
                onClick: noop,
                busy: true,
                busyText: 'Connecting…',
              }}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Long copy wraps" wide>
          <div className="w-full max-w-xl">
            <Tip title="A tip with a title long enough that it has to wrap onto a second line in a narrow column">
              A single sentence that keeps going well past the width of the card
              so that the card has to grow taller instead of clipping its text.
            </Tip>
          </div>
        </SpecimenCell>
        <SpecimenCell
          label="Truncate: one line each (user-supplied names)"
          wide
        >
          <div className="w-full max-w-xs">
            <Tip
              truncate
              title="Connect the Linear workspace of Acme Platform Engineering"
            >
              Acme Platform Engineering is not connected to this chat yet.
            </Tip>
          </div>
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel title="Composer">
        <SpecimenCell label="Drawer section" wide>
          <div className="w-full max-w-2xl">
            <ComposerDrawer edge="top">
              <Tip
                placement="composer"
                action={{ label: 'Open Library', onClick: noop }}
              />
            </ComposerDrawer>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Drawer section, announced politely" wide>
          <div className="w-full max-w-2xl">
            <ComposerDrawer edge="top">
              <Tip placement="composer" announce />
            </ComposerDrawer>
          </div>
        </SpecimenCell>
        <SpecimenCell
          label="Notice appearance (a banner above the drawer)"
          wide
        >
          <div className="w-full max-w-2xl">
            <Tip
              placement="composer"
              appearance="notice"
              action={{ label: 'Open Library', onClick: noop }}
            />
          </div>
        </SpecimenCell>
      </SpecimenPanel>
    </div>
  );
}

const OPENCODE_UPDATED_AT = '2026-11-04T09:00:00.000Z';

const OPENCODE_READY: OpenCodeAccountSnapshot = {
  status: 'ready',
  updatedAt: OPENCODE_UPDATED_AT,
  providers: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      accounts: [
        {
          label: 'dev@acme.test',
          method: 'oauth',
          selected: true,
          needsSignIn: false,
        },
        {
          label: 'ANTHROPIC_API_KEY',
          method: 'env',
          selected: false,
          needsSignIn: false,
        },
      ],
    },
    {
      id: 'openai',
      name: 'OpenAI',
      accounts: [
        {
          label: 'sk-…4f2a',
          method: 'key',
          selected: false,
          needsSignIn: true,
        },
        { label: '', method: 'external', selected: false, needsSignIn: false },
      ],
    },
    {
      id: 'opencode-go',
      name: 'OpenCode Go',
      accounts: [
        {
          label: 'Go personal',
          method: 'key',
          selected: true,
          needsSignIn: false,
          usage: {
            status: 'ready',
            plan: 'OpenCode Go',
            checkedAt: OPENCODE_UPDATED_AT,
            windows: [
              {
                id: 'rolling',
                percent: 25,
                resetsAt: '2030-01-01T00:00:00.000Z',
              },
              {
                id: 'weekly',
                percent: 85,
                resetsAt: '2030-01-07T00:00:00.000Z',
              },
              { id: 'monthly', percent: 100, resetsAt: OPENCODE_UPDATED_AT },
            ],
          },
        },
        {
          label: 'Other Go account',
          method: 'key',
          selected: false,
          needsSignIn: false,
          usage: { status: 'not-selected' },
        },
      ],
    },
    { id: 'groq', name: 'Groq', accounts: [] },
  ],
};

/** OpenCodeAccountCard: ready, long text, empty and unavailable. */
export function OpenCodeAccountSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Provider accounts">
        <SpecimenGrid min={320}>
          <SpecimenCell label="Ready: every method, selected, sign in again, no name, no account">
            <div className="w-full">
              <OpenCodeAccountCard
                snapshot={OPENCODE_READY}
                onManageProviders={noop}
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Management unavailable: desktop handoff">
            <div className="w-full">
              <OpenCodeAccountCard snapshot={OPENCODE_READY} />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Long account label">
            <div className="w-full">
              <OpenCodeAccountCard
                snapshot={{
                  status: 'ready',
                  updatedAt: OPENCODE_UPDATED_AT,
                  providers: [
                    {
                      id: 'custom',
                      name: 'A provider with a rather long display name',
                      accounts: [
                        {
                          label:
                            'a.very.long.account.name.that.keeps.going@subdomain.example-company.test',
                          method: 'oauth',
                          selected: true,
                          needsSignIn: false,
                        },
                      ],
                    },
                  ],
                }}
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Empty: no providers reported">
            <div className="w-full">
              <OpenCodeAccountCard
                snapshot={{
                  status: 'ready',
                  updatedAt: OPENCODE_UPDATED_AT,
                  providers: [],
                }}
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Error: unavailable">
            <div className="w-full">
              <OpenCodeAccountCard
                snapshot={{
                  status: 'unavailable',
                  updatedAt: OPENCODE_UPDATED_AT,
                  providers: [],
                }}
              />
            </div>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

function PageColumnSample({
  width,
  as,
}: {
  readonly width: PageColumnWidth;
  readonly as?: 'main' | 'div' | 'section' | 'article';
}): JSX.Element {
  return (
    <Surface variant="dashed" className="w-full overflow-hidden">
      <PageColumn width={width} as={as === 'main' ? 'div' : as}>
        <Surface as="section" variant="group" size="small" padding="compact">
          <span className="text-xs">Section one</span>
        </Surface>
        <Surface as="section" variant="group" size="small" padding="compact">
          <span className="text-xs">Section two, 32px below</span>
        </Surface>
      </PageColumn>
    </Surface>
  );
}

/** PageColumn: both page widths and a section element. */
export function PageColumnSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="Centered column, one gutter, the page gap between sections">
      <SpecimenCell label="content: 640px reading column" wide>
        <PageColumnSample width="content" />
      </SpecimenCell>
      <SpecimenCell
        label="wide: 1088px of content, for a page with a table"
        wide
      >
        <PageColumnSample width="wide" />
      </SpecimenCell>
      <SpecimenCell label="Rendered as a section" wide>
        <PageColumnSample width="content" as="section" />
      </SpecimenCell>
    </SpecimenPanel>
  );
}

interface Command {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
}

const COMMANDS: readonly Command[] = [
  { id: 'new', label: 'New chat', hint: '⌘N' },
  { id: 'open', label: 'Open project', hint: '⌘O' },
  { id: 'review', label: 'Review changes' },
  { id: 'settings', label: 'Open settings', hint: '⌘,' },
  {
    id: 'long',
    label:
      'A command whose label is long enough to run past the edge of a narrow picker',
  },
];

const getKey = (item: Command): string => item.id;
const getLabel = (item: Command): string => item.label;

function Frame({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="w-full max-w-sm overflow-hidden rounded-xl bg-popover shadow-md">
      {children}
    </div>
  );
}

function LivePickList(): JSX.Element {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <Frame>
      <PickList
        items={COMMANDS}
        getKey={getKey}
        getLabel={getLabel}
        onPick={(item): void => setPicked(item.label)}
        searchLabel="Search commands"
        listLabel="Commands"
        emptyLabel="No commands match."
        autoFocus={false}
        listMaxHeight="md"
        selectedKey="settings"
        renderItem={(item) => (
          <>
            <PickerMenuOptionLabel>{item.label}</PickerMenuOptionLabel>
            {item.hint ? (
              <span className="text-2xs fg-tertiary">{item.hint}</span>
            ) : null}
          </>
        )}
      />
      <p className="px-3 py-2 text-2xs fg-tertiary">
        {picked ? `Picked: ${picked}` : 'Type, use the arrows, Enter or click.'}
      </p>
    </Frame>
  );
}

const SECTIONED: readonly (Command & { readonly section: string })[] = [
  { id: 'chat', label: 'Fix the checkout form', section: 'Chats' },
  { id: 'chat-2', label: 'Refresh the sidebar list', section: 'Chats' },
  { id: 'off', label: 'Archived chat', section: 'Chats' },
  { id: 'setting', label: 'Appearance', section: 'Settings' },
  { id: 'setting-2', label: 'Notifications', section: 'Settings' },
];

const isArchivedRow = (item: Command): boolean => item.id === 'off';
const getSection = (item: (typeof SECTIONED)[number]): string => item.section;

/** A host that owns its field, as a palette does. */
function LivePickListResults(): JSX.Element {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [moved, setMoved] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const rows = useMemo(
    () =>
      SECTIONED.filter((item) =>
        item.label.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [query],
  );
  const keys = useMemo(
    () => rows.filter((item) => !isArchivedRow(item)).map(getKey),
    [rows],
  );
  const activeKey = resolvePickListActiveKey(keys, moved);
  const handleKeys = usePickListKeys({
    keys,
    activeKey,
    onActiveKeyChange: setMoved,
    onPick: setPicked,
  });
  return (
    <Frame>
      <div className="p-1">
        <SearchField
          value={query}
          onValueChange={(next): void => {
            setQuery(next);
            setMoved(null);
          }}
          onKeyDown={handleKeys}
          placeholder="Search"
          aria-label="Search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-activedescendant={
            activeKey === null ? undefined : pickListOptionId(listId, activeKey)
          }
        />
      </div>
      <div className="flex max-h-64 min-h-0 flex-col px-1 pb-1">
        <PickListResults
          items={rows}
          getKey={getKey}
          getLabel={getLabel}
          getSection={getSection}
          isItemDisabled={isArchivedRow}
          onPick={(item): void => setPicked(item.id)}
          listId={listId}
          listLabel="Results"
          activeKey={activeKey}
          onActiveKeyChange={setMoved}
          emptyLabel="Nothing matches."
        />
      </div>
      <p className="px-3 py-2 text-2xs fg-tertiary">
        {picked ? `Picked: ${picked}` : 'The field keeps focus.'}
      </p>
    </Frame>
  );
}

function PickListTabs(): JSX.Element {
  const [tab, setTab] = useState('branches');
  return (
    <PickerMenuTabList>
      {['Branches', 'Worktrees'].map((label) => (
        <PickerMenuTab
          key={label}
          active={tab === label.toLowerCase()}
          onClick={(): void => setTab(label.toLowerCase())}
        >
          {label}
        </PickerMenuTab>
      ))}
    </PickerMenuTabList>
  );
}

/** PickListResults and the PickList slots built on it. */
export function PickListResultsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="A host's own field over the shared results">
        <SpecimenGrid min={320}>
          <SpecimenCell label="Live: sections, a disabled row the keyboard skips">
            <LivePickListResults />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="PickList slots">
        <SpecimenGrid min={320}>
          <SpecimenCell label="A header between the search and the list">
            <Frame>
              <PickList
                items={COMMANDS.slice(0, 3)}
                getKey={getKey}
                getLabel={getLabel}
                onPick={noop}
                header={<PickListTabs />}
                searchLabel="Search branches"
                listLabel="Branches"
                emptyLabel="No branches match."
                autoFocus={false}
              />
            </Frame>
          </SpecimenCell>
          <SpecimenCell label="A control beside each row, outside its option">
            <Frame>
              <PickList
                items={COMMANDS.slice(0, 3)}
                getKey={getKey}
                getLabel={getLabel}
                onPick={noop}
                renderRowEnd={(item) => (
                  <Button
                    iconOnly
                    variant="ghost"
                    size="sm"
                    aria-label={`Close ${item.label}`}
                    onClick={noop}
                  >
                    <CloseIcon />
                  </Button>
                )}
                searchLabel="Search tabs"
                listLabel="Tabs"
                emptyLabel="No tabs match."
                autoFocus={false}
              />
            </Frame>
          </SpecimenCell>
          <SpecimenCell label="Default rows mark the current value">
            <Frame>
              <PickList
                items={COMMANDS.slice(0, 3)}
                getKey={getKey}
                getLabel={getLabel}
                onPick={noop}
                selectedKey="open"
                searchLabel="Search commands"
                listLabel="Commands"
                emptyLabel="No commands match."
                autoFocus={false}
              />
            </Frame>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

/** ComposerSuggestionMenu: floats above a sample composer without taking focus. */
export function ComposerSuggestionMenuSpecimen(): JSX.Element {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <SpecimenPanel title="Above the composer, at its width">
      <SpecimenCell label="Opens above the box; the button keeps focus" wide>
        <div className="flex w-full max-w-md flex-col gap-3">
          <div ref={anchorRef}>
            <Surface variant="outline">
              <span className="text-s fg-tertiary">A sample composer</span>
            </Surface>
          </div>
          <div>
            <Button variant="secondary" onClick={(): void => setOpen(!open)}>
              {open ? 'Close the list' : 'Open the list'}
            </Button>
          </div>
          <ComposerSuggestionMenu
            open={open}
            onDismiss={(): void => setOpen(false)}
            anchorRef={anchorRef}
            aria-label="Suggestions"
          >
            <p className="px-3 py-2 text-s fg-primary">
              Suggestions go here, in the composer&apos;s 20px corners.
            </p>
          </ComposerSuggestionMenu>
        </div>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

/** PickList: live, empty, loading and server-search states. */
export function PickListSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Search-and-pick list">
        <SpecimenGrid min={320}>
          <SpecimenCell label="Live: filters, arrows, Enter or click pick; the current value starts active">
            <LivePickList />
          </SpecimenCell>
          <SpecimenCell label="Plain rows, no selection">
            <Frame>
              <PickList
                items={COMMANDS.slice(0, 3)}
                getKey={getKey}
                getLabel={getLabel}
                onPick={noop}
                searchLabel="Search commands"
                listLabel="Commands"
                emptyLabel="No commands match."
                autoFocus={false}
              />
            </Frame>
          </SpecimenCell>
          <SpecimenCell label="Empty: the search returned nothing">
            <Frame>
              <PickList
                items={[]}
                getKey={getKey}
                getLabel={getLabel}
                onPick={noop}
                searchLabel="Search commands"
                listLabel="Commands"
                emptyLabel="No commands match."
                query="zzz"
                onQueryChange={noop}
                autoFocus={false}
              />
            </Frame>
          </SpecimenCell>
          <SpecimenCell label="Loading: placeholder rows replace the list (busy)">
            <Frame>
              <PickList
                items={[]}
                getKey={getKey}
                getLabel={getLabel}
                onPick={noop}
                searchLabel="Search commands"
                listLabel="Commands"
                emptyLabel="No commands match."
                loading
                loadingLabel="Loading commands"
                autoFocus={false}
              />
            </Frame>
          </SpecimenCell>
          <SpecimenCell label="Server search: controlled query, results as given">
            <Frame>
              <PickList
                items={COMMANDS.slice(0, 2)}
                getKey={getKey}
                getLabel={getLabel}
                onPick={noop}
                searchLabel="Search commands"
                listLabel="Commands"
                emptyLabel="No commands match."
                query="chat"
                onQueryChange={noop}
                autoFocus={false}
              />
            </Frame>
          </SpecimenCell>
          <SpecimenCell label="Focused search field">
            <Frame>
              <PickList
                items={COMMANDS.slice(0, 3)}
                getKey={getKey}
                getLabel={getLabel}
                onPick={noop}
                searchLabel="Search commands"
                listLabel="Commands"
                emptyLabel="No commands match."
                listMaxHeight="md"
              />
            </Frame>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

const NOW = Date.parse('2026-11-04T12:00:00.000Z');

/** PipelineDispatchedTime: row and menu variants, and the unknown start. */
export function PipelineDispatchedTimeSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="Dispatched time (hover for the exact local time)">
      <SpecimenGrid min={240}>
        <SpecimenCell label="Row variant, 2 hours ago">
          <PipelineDispatchedTime
            startedAt="2026-11-04T10:00:00.000Z"
            now={NOW}
          />
        </SpecimenCell>
        <SpecimenCell label="Row variant, just now">
          <PipelineDispatchedTime
            startedAt="2026-11-04T11:59:50.000Z"
            now={NOW}
          />
        </SpecimenCell>
        <SpecimenCell label="Row variant, days ago">
          <PipelineDispatchedTime
            startedAt="2026-10-28T12:00:00.000Z"
            now={NOW}
          />
        </SpecimenCell>
        <SpecimenCell label="Menu variant, right-aligned after name and status">
          <Surface variant="group" size="small" className="w-64">
            <div className="flex items-center px-2 py-1 text-xs">
              <span>Release pipeline</span>
              <PipelineDispatchedTime
                startedAt="2026-11-04T10:00:00.000Z"
                variant="menu"
                now={NOW}
              />
            </div>
          </Surface>
        </SpecimenCell>
        <SpecimenCell label="Unknown start renders nothing">
          <PipelineDispatchedTime startedAt={undefined} now={NOW} />
          <span className="text-2xs fg-tertiary">(nothing before this)</span>
        </SpecimenCell>
        <SpecimenCell label="Unparseable start renders nothing">
          <PipelineDispatchedTime startedAt="not a date" now={NOW} />
          <span className="text-2xs fg-tertiary">(nothing before this)</span>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}
