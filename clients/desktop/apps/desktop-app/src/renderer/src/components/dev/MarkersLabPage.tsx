import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import {
  Badge,
  type BadgeSize,
  type BadgeTone,
  Button,
  Chip,
  type ChipForcedState,
  Count,
  type CountTone,
  Dot,
  type DotSize,
  type DotTone,
  Heading,
  StatusGlyph,
  type StatusGlyphSize,
  Surface,
} from '@canopy/ui-shared/components';
import { STATUS_GLYPH_STATES } from '@canopy/ui-shared/lib';
import {
  FileIcon,
  SparkleIcon,
  ScheduleIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { applyTheme } from '@/lib/theme';

/**
 * Localhost lab for checking every shared marker state by hand
 * (`markers-lab.vite.mts`, port 5187). It mounts only the real shared
 * markers (Badge, Count, Dot, StatusGlyph) and Chip; nothing here restyles
 * them.
 *
 * `?view=` shows one section: `badge`, `count`, `dot`, `glyph`, `chip` or
 * `context`; the default shows all of them. `?theme=dark` starts in dark.
 * Chip hover and press are drawn with its `forcedState`, so every look is
 * visible at once; the focused cell focuses one chip on load.
 */

type ColorMode = 'light' | 'dark';

const SECTIONS = ['badge', 'count', 'dot', 'glyph', 'chip', 'context'] as const;
type Section = (typeof SECTIONS)[number];

const SECTION_LABELS: Readonly<Record<Section, string>> = {
  badge: 'Badge',
  count: 'Count',
  dot: 'Dot',
  glyph: 'StatusGlyph',
  chip: 'Chip',
  context: 'In context',
};

const BADGE_TONES: readonly BadgeTone[] = [
  'neutral',
  'info',
  'success',
  'warning',
  'danger',
  'special',
];
const BADGE_SIZES: readonly BadgeSize[] = ['regular', 'compact'];
const COUNT_TONES: readonly CountTone[] = ['neutral', 'unread', 'attention'];
const COUNT_VALUES: readonly number[] = [0, 1, 12, 240];
const DOT_TONES: readonly { tone: DotTone; meaning: string }[] = [
  { tone: 'unread', meaning: 'Unread' },
  { tone: 'attention', meaning: 'Waiting on you' },
  { tone: 'filter', meaning: 'Filter on' },
  { tone: 'working', meaning: 'Working' },
  { tone: 'success', meaning: 'Connected' },
  { tone: 'danger', meaning: 'Offline' },
];
const DOT_SIZES: readonly DotSize[] = ['regular', 'large'];
const GLYPH_SIZES: readonly StatusGlyphSize[] = [12, 14, 20];

const LONG_LABEL = 'Waiting for the deploy preview to finish building';

function isSection(value: string | null): value is Section {
  return SECTIONS.some((section) => section === value);
}

function initialSection(): Section | 'all' {
  const view = new URLSearchParams(window.location.search).get('view');
  return isSection(view) ? view : 'all';
}

function initialColorMode(): ColorMode {
  return new URLSearchParams(window.location.search).get('theme') === 'dark'
    ? 'dark'
    : 'light';
}

function Panel({
  id,
  title,
  children,
}: {
  readonly id: Section;
  readonly title: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section
      id={id}
      data-testid={`markers-lab-${id}`}
      className="flex flex-col gap-3"
    >
      <Heading level={2} variant="section">
        {title}
      </Heading>
      <Surface variant="group" padding="default" gap="item">
        {children}
      </Surface>
    </section>
  );
}

function Cell({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex h-6 min-w-0 items-center gap-2">{children}</div>
      <span className="text-2xs fg-tertiary">{label}</span>
    </div>
  );
}

export function BadgeSection(): JSX.Element {
  return (
    <Panel id="badge" title="Badge">
      {BADGE_SIZES.map((size) => (
        <div key={size} className="flex flex-col gap-3">
          <span className="text-xs font-medium fg-secondary">
            {size === 'regular' ? 'Regular, 18px capsule' : 'Compact, 16px tag'}
          </span>
          <div className="grid grid-cols-3 gap-3 md:grid-cols-6">
            {BADGE_TONES.map((tone) => (
              <Cell key={tone} label={tone}>
                <Badge tone={tone} size={size}>
                  {size === 'compact' ? 'added' : 'Connected'}
                </Badge>
              </Cell>
            ))}
            {BADGE_TONES.map((tone) => (
              <Cell key={`${tone}-icon`} label={`${tone}, icon`}>
                <Badge tone={tone} size={size} icon={SparkleIcon}>
                  {size === 'compact' ? 'new' : 'Update available'}
                </Badge>
              </Cell>
            ))}
            {BADGE_TONES.map((tone) => (
              <Cell key={`${tone}-muted`} label={`${tone}, muted`}>
                <Badge tone={tone} size={size} muted>
                  {size === 'compact' ? 'PK' : 'Done'}
                </Badge>
              </Cell>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Cell label="Long label">
              <Badge size={size}>{LONG_LABEL}</Badge>
            </Cell>
            <Cell label="Long label in a 120px cell (clips)">
              <div className="w-30 overflow-hidden">
                <Badge size={size}>{LONG_LABEL}</Badge>
              </div>
            </Cell>
          </div>
        </div>
      ))}
    </Panel>
  );
}

export function CountSection(): JSX.Element {
  return (
    <Panel id="count" title="Count">
      <span className="text-xs font-medium fg-secondary">Next to a label</span>
      <div className="flex flex-wrap gap-6">
        {COUNT_VALUES.map((value) => (
          <Cell key={value} label={String(value)}>
            <span className="flex items-center gap-1.5 text-s fg-primary">
              Jobs <Count value={value} />
            </span>
          </Cell>
        ))}
      </div>
      <span className="text-xs font-medium fg-secondary">On an icon</span>
      <div className="grid grid-cols-4 gap-3">
        {COUNT_TONES.map((tone) =>
          COUNT_VALUES.map((value) => (
            <Cell key={`${tone}-${value}`} label={`${tone}, ${value}`}>
              <Count value={value} placement="icon" tone={tone} />
            </Cell>
          )),
        )}
      </div>
    </Panel>
  );
}

export function DotSection(): JSX.Element {
  return (
    <Panel id="dot" title="Dot">
      {DOT_SIZES.map((size) => (
        <div key={size} className="flex flex-col gap-3">
          <span className="text-xs font-medium fg-secondary">
            {size === 'regular'
              ? 'Regular, 6px'
              : 'Large, 8px, in a leading icon slot'}
          </span>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            {DOT_TONES.map(({ tone, meaning }) => (
              <Cell key={tone} label={tone}>
                <span className="flex items-center gap-1.5 text-s fg-primary">
                  <Dot tone={tone} size={size} /> {meaning}
                </span>
              </Cell>
            ))}
          </div>
        </div>
      ))}
    </Panel>
  );
}

export function GlyphSection(): JSX.Element {
  return (
    <Panel id="glyph" title="StatusGlyph">
      {GLYPH_SIZES.map((size) => (
        <div key={size} className="flex flex-wrap items-center gap-4">
          <span className="w-10 text-xs fg-tertiary">{size}px</span>
          {STATUS_GLYPH_STATES.map((state) => (
            <span
              key={state}
              className="flex items-center gap-1 text-xs fg-secondary"
            >
              <StatusGlyph state={state} size={size} />
              {state}
            </span>
          ))}
        </div>
      ))}
    </Panel>
  );
}

const noop = (): void => {};

/** Focuses the chip inside on load so its focus ring is visible. */
function Focused({ children }: { readonly children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current
      ?.querySelector<HTMLButtonElement>('button')
      ?.focus({ preventScroll: true });
  }, []);
  return (
    <div ref={ref} className="flex min-w-0">
      {children}
    </div>
  );
}

export function ChipSection(): JSX.Element {
  const forced: readonly { label: string; state: ChipForcedState }[] = [
    { label: 'Hover', state: 'hover' },
    { label: 'Pressed', state: 'pressed' },
  ];
  return (
    <Panel id="chip" title="Chip">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Cell label="Rest, not clickable">
          <Chip>Fast</Chip>
        </Cell>
        <Cell label="Rest, clickable">
          <Chip onClick={noop}>Fast</Chip>
        </Cell>
        {forced.map(({ label, state }) => (
          <Cell key={state} label={label}>
            <Chip onClick={noop} forcedState={state}>
              Fast
            </Chip>
          </Cell>
        ))}
        <Cell label="Focus-visible">
          <Focused>
            <Chip onClick={noop}>Fast</Chip>
          </Focused>
        </Cell>
        <Cell label="Disabled">
          <Chip onClick={noop} onRemove={noop} disabled>
            Fast
          </Chip>
        </Cell>
        <Cell label="Icon">
          <Chip icon={FileIcon} onClick={noop}>
            README.md
          </Chip>
        </Cell>
        <Cell label="Removable">
          <Chip icon={FileIcon} onClick={noop} onRemove={noop}>
            README.md
          </Chip>
        </Cell>
        <Cell label="Remove only">
          <Chip onRemove={noop}>design.png</Chip>
        </Cell>
        <Cell label="Remove button hover">
          <Chip
            icon={FileIcon}
            onClick={noop}
            onRemove={noop}
            forcedState="remove-hover"
          >
            README.md
          </Chip>
        </Cell>
        <Cell label="Truncated at 160px">
          <Chip
            icon={FileIcon}
            onClick={noop}
            onRemove={noop}
            className="max-w-40"
          >
            a-very-long-file-name-that-keeps-going.tsx
          </Chip>
        </Cell>
        <Cell label="Calendar event">
          <Chip icon={ScheduleIcon} onClick={noop}>
            Standup 10:00
          </Chip>
        </Cell>
      </div>
    </Panel>
  );
}

function ContextRow({
  label,
  children,
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 border-b px-3 py-1.5 text-s fg-primary last:border-b-0">
      <span className="min-w-0 truncate">{label}</span>
      <span className="flex shrink-0 items-center gap-1.5">{children}</span>
    </div>
  );
}

export function ContextSection(): JSX.Element {
  return (
    <Panel id="context" title="In context">
      <span className="text-xs font-medium fg-secondary">Schema diagram</span>
      <Surface variant="group" size="small" className="w-full max-w-90">
        <Surface variant="section" boundary="bottom">
          <div className="px-3 py-1.5 text-xs font-medium fg-primary">
            users
          </div>
        </Surface>
        <ContextRow label={<span className="font-mono text-xs">id uuid</span>}>
          <Badge size="compact">PK</Badge>
        </ContextRow>
        <ContextRow
          label={<span className="font-mono text-xs">org_id uuid</span>}
        >
          <Badge size="compact">FK</Badge>
          <Badge size="compact" tone="success">
            added
          </Badge>
        </ContextRow>
        <ContextRow
          label={<span className="font-mono text-xs">email text</span>}
        >
          <Badge size="compact" tone="warning">
            changed
          </Badge>
        </ContextRow>
      </Surface>

      <span className="text-xs font-medium fg-secondary">Settings</span>
      <Surface variant="group" size="small" className="w-full max-w-160">
        <ContextRow label="Linear plugin">
          <Badge tone="info">Update available</Badge>
        </ContextRow>
        <ContextRow label="Model alias: fast">
          <Badge>Customized</Badge>
        </ContextRow>
      </Surface>

      <span className="text-xs font-medium fg-secondary">Cloud sync</span>
      <Surface variant="group" size="small" className="w-full max-w-160">
        <ContextRow label="Cloud sync">
          <Dot tone="success" />
          <span className="text-xs fg-secondary">Connected</span>
        </ContextRow>
        <ContextRow label="Build worker">
          <Dot tone="danger" />
          <span className="text-xs fg-secondary">Offline</span>
        </ContextRow>
      </Surface>

      <span className="text-xs font-medium fg-secondary">Terminals</span>
      <Surface variant="group" size="small" className="w-full max-w-160">
        <ContextRow label="Terminal 1">
          <Dot tone="working" />
          <span className="text-xs fg-secondary">node</span>
        </ContextRow>
        <ContextRow label="Terminal 2">
          <Dot tone="unread" />
          <span className="text-xs fg-secondary">exit 0, not seen</span>
        </ContextRow>
      </Surface>

      <span className="text-xs font-medium fg-secondary">Composer</span>
      <Surface
        variant="group"
        padding="compact"
        gap="inline"
        className="w-full max-w-160"
      >
        <div className="flex flex-wrap gap-1.5">
          <Chip icon={FileIcon} onClick={noop} onRemove={noop}>
            README.md
          </Chip>
          <Chip icon={FileIcon} onClick={noop} onRemove={noop}>
            screenshot-2026-10-30.png
          </Chip>
        </div>
        <span className="text-s fg-tertiary">Ask anything…</span>
        <div className="flex items-center gap-1.5">
          <Chip onClick={noop}>Fast</Chip>
          <Chip icon={SparkleIcon} onClick={noop} onRemove={noop}>
            Plan
          </Chip>
        </div>
      </Surface>
    </Panel>
  );
}

const SECTION_VIEWS: Readonly<Record<Section, () => JSX.Element>> = {
  badge: BadgeSection,
  count: CountSection,
  dot: DotSection,
  glyph: GlyphSection,
  chip: ChipSection,
  context: ContextSection,
};

export function MarkersLabPage(): JSX.Element {
  const [colorMode, setColorMode] = useState<ColorMode>(initialColorMode);
  const [view, setView] = useState<Section | 'all'>(initialSection);

  useEffect(() => {
    applyTheme('default', colorMode);
  }, [colorMode]);

  const selectView = (next: Section | 'all'): void => {
    setView(next);
    const url = new URL(window.location.href);
    if (next === 'all') url.searchParams.delete('view');
    else url.searchParams.set('view', next);
    window.history.replaceState(null, '', url);
  };

  const visible = view === 'all' ? SECTIONS : [view];

  return (
    <Surface variant="pane">
      <div className="min-h-screen fg-primary">
        <main className="mx-auto flex max-w-240 flex-col gap-8 px-4 py-6">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <Heading level={1} variant="page">
              Markers lab
            </Heading>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant={view === 'all' ? 'secondary' : 'ghost'}
                onClick={(): void => selectView('all')}
              >
                All
              </Button>
              {SECTIONS.map((section) => (
                <Button
                  key={section}
                  size="sm"
                  variant={view === section ? 'secondary' : 'ghost'}
                  onClick={(): void => selectView(section)}
                >
                  {SECTION_LABELS[section]}
                </Button>
              ))}
              <Button
                size="sm"
                variant="outline"
                onClick={(): void =>
                  setColorMode(colorMode === 'light' ? 'dark' : 'light')
                }
              >
                {colorMode === 'light' ? 'Dark' : 'Light'}
              </Button>
            </div>
          </header>
          {visible.map((section) => {
            const View = SECTION_VIEWS[section];
            return <View key={section} />;
          })}
        </main>
      </div>
    </Surface>
  );
}
