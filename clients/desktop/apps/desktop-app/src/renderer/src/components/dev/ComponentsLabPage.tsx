import { Heading } from '@canopy/ui-shared/components';
import { useEffect, useState, type JSX } from 'react';
import {
  Button,
  ListRow,
  SegmentedControl,
  Surface,
} from '@canopy/ui-shared/components';
import { applyTheme } from '@/lib/theme';
import {
  LabColorModeContext,
  LabOverviewContext,
} from './componentsLabStageContext';
import {
  COMPONENTS_LAB_ENTRIES,
  COMPONENTS_LAB_GROUPS,
  type ComponentsLabEntry,
} from './componentsLabCatalog';

/**
 * Localhost components library (`components-lab.vite.mts`, port 5188). The
 * layout follows the stageshow playground: a catalog grouped into the
 * unified shared components and the UI still waiting to be unified, one
 * specimen sheet at a time (or all of them), a Desktop / Phone width switch
 * and a light / dark switch. Specimens mount only the real shared
 * components; nothing here restyles them.
 *
 * With no `?component` the lab opens on the overview: one card per unified
 * component in a grid, each with its live stage, linking to its sheet.
 * `?component=<id>` opens one entry, `?component=all` every unified sheet in
 * one scroll (the capture view), `?width=phone` the 358px column, and
 * `?theme=dark` (or a dark system preference, when no theme is given)
 * starts in dark.
 */

type ColorMode = 'light' | 'dark';
type PreviewWidth = 'desktop' | 'phone';

const ALL = 'all';
const OVERVIEW = 'overview';
// A 390px phone viewport with 16px gutters: the 358px column stageshow
// designs its compact layouts for.
const PHONE_VIEWPORT_PX = 390;

function searchParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function initialColorMode(): ColorMode {
  const theme = searchParam('theme');
  if (theme === 'dark' || theme === 'light') return theme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function initialWidth(): PreviewWidth {
  return searchParam('width') === 'phone' ? 'phone' : 'desktop';
}

function initialSelection(): string {
  const id = searchParam('component');
  if (id === ALL) return ALL;
  return COMPONENTS_LAB_ENTRIES.some((entry) => entry.id === id) && id
    ? id
    : OVERVIEW;
}

function Caption({
  entry,
}: {
  readonly entry: ComponentsLabEntry;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Heading level={2} variant="section">
        {entry.name}
      </Heading>
      <p className="text-s fg-secondary">{entry.note}</p>
      <p className="flex flex-wrap gap-x-3 text-xs fg-tertiary">
        <code>{entry.source}</code>
        {entry.prs.length > 0 ? (
          <span>{entry.prs.map((pr) => `#${pr}`).join(', ')}</span>
        ) : null}
      </p>
    </div>
  );
}

function Sheet({ entry }: { readonly entry: ComponentsLabEntry }): JSX.Element {
  const { Stage, View } = entry;
  return (
    <section
      id={entry.id}
      data-testid={`components-lab-${entry.id}`}
      className="flex flex-col gap-4"
    >
      <Caption entry={entry} />
      {Stage ? <Stage /> : null}
      <View />
    </section>
  );
}

function OverviewCard({
  entry,
  onOpen,
}: {
  readonly entry: ComponentsLabEntry;
  readonly onOpen: (id: string) => void;
}): JSX.Element {
  const { Stage } = entry;
  return (
    <div
      data-testid={`components-lab-card-${entry.id}`}
      className="flex min-w-0 flex-col items-center gap-3"
    >
      <div className="pointer-events-none aspect-4/3 w-full overflow-hidden rounded-row">
        <LabOverviewContext.Provider value>
          {Stage ? <Stage /> : null}
        </LabOverviewContext.Provider>
      </div>
      <Button
        variant="link"
        aria-label={`Open the ${entry.name} sheet`}
        onClick={(): void => onOpen(entry.id)}
      >
        {entry.name}
      </Button>
    </div>
  );
}

export function ComponentsLabPage(): JSX.Element {
  const [colorMode, setColorMode] = useState<ColorMode>(initialColorMode);
  const [width, setWidth] = useState<PreviewWidth>(initialWidth);
  const [selected, setSelected] = useState<string>(initialSelection);

  useEffect(() => {
    applyTheme('default', colorMode);
  }, [colorMode]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('component', selected);
    url.searchParams.set('theme', colorMode);
    if (width === 'phone') url.searchParams.set('width', 'phone');
    else url.searchParams.delete('width');
    window.history.replaceState(null, '', url);
  }, [selected, colorMode, width]);

  const overview = selected === OVERVIEW;
  const visible = overview
    ? []
    : selected === ALL
      ? COMPONENTS_LAB_ENTRIES.filter((entry) => entry.group === 'Unified')
      : COMPONENTS_LAB_ENTRIES.filter((entry) => entry.id === selected);

  return (
    <Surface variant="pane">
      <div className="flex min-h-screen fg-primary">
        <Surface
          as="nav"
          aria-label="Components"
          variant="section"
          boundary="right"
          extent="viewport"
          className="sticky top-0 w-60 shrink-0 overflow-y-auto"
        >
          <div className="flex flex-col gap-4 px-2 py-4">
            <div className="px-2">
              <Heading level={1} variant="title">
                Components
              </Heading>
            </div>
            <ListRow
              selected={selected === OVERVIEW}
              aria-current={selected === OVERVIEW ? 'page' : undefined}
              onClick={(): void => setSelected(OVERVIEW)}
            >
              Overview
            </ListRow>
            <ListRow
              selected={selected === ALL}
              aria-current={selected === ALL ? 'page' : undefined}
              onClick={(): void => setSelected(ALL)}
            >
              All unified
            </ListRow>
            {COMPONENTS_LAB_GROUPS.map((group) => (
              <div key={group} className="flex flex-col gap-0.5">
                <div className="px-2 pb-1">
                  <Heading level={2} variant="label">
                    {group}
                  </Heading>
                </div>
                {COMPONENTS_LAB_ENTRIES.filter(
                  (entry) => entry.group === group,
                ).map((entry) => (
                  <ListRow
                    key={entry.id}
                    selected={selected === entry.id}
                    aria-current={selected === entry.id ? 'page' : undefined}
                    onClick={(): void => setSelected(entry.id)}
                  >
                    {entry.name}
                  </ListRow>
                ))}
              </div>
            ))}
          </div>
        </Surface>
        <div className="flex min-w-0 flex-1 flex-col">
          <Surface
            as="header"
            variant="pane"
            boundary="bottom"
            className="sticky top-0 z-10"
          >
            <div className="flex flex-wrap items-center gap-3 px-6 py-3">
              <SegmentedControl
                label="Preview width"
                value={width}
                width="content"
                onChange={setWidth}
                options={[
                  { value: 'desktop', label: 'Desktop' },
                  { value: 'phone', label: 'Phone' },
                ]}
              />
              <SegmentedControl
                label="Color mode"
                value={colorMode}
                width="content"
                onChange={setColorMode}
                options={[
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
              />
              <p className="text-xs fg-tertiary">
                Real shared components only. Each stage plays its story once;
                the sheets under it are live, so point at a control to judge it.
              </p>
            </div>
          </Surface>
          <main
            id="components-lab-preview"
            className={`flex flex-col gap-12 py-6 ${width === 'phone' ? 'px-4' : 'px-6'}`}
            data-view={overview ? 'overview' : 'sheets'}
            style={
              width === 'phone'
                ? { width: PHONE_VIEWPORT_PX, maxWidth: '100%' }
                : undefined
            }
          >
            <LabColorModeContext.Provider value={colorMode}>
              {overview ? (
                <div
                  data-testid="components-lab-overview"
                  className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),35rem))] gap-x-8 gap-y-10"
                >
                  {COMPONENTS_LAB_ENTRIES.filter(
                    (entry) => entry.group === 'Unified' && entry.Stage,
                  ).map((entry) => (
                    <OverviewCard
                      key={entry.id}
                      entry={entry}
                      onOpen={setSelected}
                    />
                  ))}
                </div>
              ) : null}
              {visible.map((entry) => (
                <Sheet key={entry.id} entry={entry} />
              ))}
            </LabColorModeContext.Provider>
          </main>
        </div>
      </div>
    </Surface>
  );
}
