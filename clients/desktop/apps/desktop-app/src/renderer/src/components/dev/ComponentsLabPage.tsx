import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
} from 'react';
import { OverlayScrollArea, Surface } from '@canopy/ui-shared/components';
import { applyTheme } from '@/lib/theme';
import {
  LabColorModeContext,
  type LabColorMode,
} from './componentsLabStageContext';
import { COMPONENTS_LAB_ENTRIES } from './componentsLabCatalog';
import { ComponentsLabIntro } from './componentsLabIntro';
import {
  ComponentsLabNav,
  LAB_ALL,
  LAB_OVERVIEW,
  type LabThemeChoice,
} from './componentsLabNav';
import {
  COMPONENTS_LAB_PAGES,
  resolveComponentsLabTarget,
  type ComponentsLabPage as LabPage,
} from './componentsLabPages';
import {
  EntrySheet,
  OnThisPage,
  PageSheet,
  scrollToHeading,
} from './componentsLabPageSheet';

/**
 * Localhost components library (`components-lab.vite.mts`, port 5188). The
 * shell is a sidebar on the page's rail fill beside one floating content
 * card: the sidebar holds the search, the pages by section, and the theme
 * switch; the card holds one page in a 760px column with an "On this page"
 * list beside it. Specimens mount only the real shared
 * components; nothing here restyles them.
 *
 * With no `?component` the lab opens on the introduction. `?component=<id>`
 * opens a page, or the page that holds that sheet, scrolled to it; each page
 * opened is a history step, so Back returns to the last one.
 * `?component=all` shows every unified sheet in one page-length scroll (the
 * capture view). `?theme=dark` or `?theme=light` pins the color mode (with no
 * theme, it follows the system). `?frame=1` draws the page alone, with no
 * sidebar or card: open it in a 390px viewport to see or capture a page at a
 * phone's width, with 16px gutters around the 358px column stageshow designs
 * its compact layouts for.
 */

const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';
const PREVIEW_ID = 'components-lab-preview';

type LabView =
  | { readonly kind: 'overview' }
  | { readonly kind: 'all' }
  | {
      readonly kind: 'page';
      readonly page: LabPage;
      readonly entryId?: string;
    };

function searchParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function readView(): LabView {
  const id = searchParam('component');
  if (id === LAB_ALL) return { kind: 'all' };
  const target = resolveComponentsLabTarget(id);
  return target ? { kind: 'page', ...target } : { kind: 'overview' };
}

function viewId(view: LabView): string {
  if (view.kind === 'page') return view.page.id;
  return view.kind === 'all' ? LAB_ALL : LAB_OVERVIEW;
}

function readTheme(): LabThemeChoice {
  const theme = searchParam('theme');
  return theme === 'dark' || theme === 'light' ? theme : 'system';
}

function subscribeToSystemScheme(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_SCHEME_QUERY);
  query.addEventListener('change', onChange);
  return (): void => query.removeEventListener('change', onChange);
}

function systemColorMode(): LabColorMode {
  return window.matchMedia(DARK_SCHEME_QUERY).matches ? 'dark' : 'light';
}

const UNIFIED_ENTRIES = COMPONENTS_LAB_ENTRIES.filter(
  (entry) => entry.group === 'Unified',
);

/** The sheets of a view, in the 760px column. */
function Sheets({ view }: { readonly view: LabView }): JSX.Element | null {
  if (view.kind === 'page') return <PageSheet page={view.page} />;
  if (view.kind === 'all') {
    return (
      <div className="flex flex-col gap-16">
        {UNIFIED_ENTRIES.map((entry) => (
          <EntrySheet key={entry.id} entry={entry} titleLevel={2} lead />
        ))}
      </div>
    );
  }
  return null;
}

export function ComponentsLabPage(): JSX.Element {
  const [theme, setTheme] = useState<LabThemeChoice>(readTheme);
  const [view, setView] = useState<LabView>(readView);
  const [selection, setSelection] = useState(0);
  const [framed] = useState(() => searchParam('frame') === '1');
  const systemMode = useSyncExternalStore(
    subscribeToSystemScheme,
    systemColorMode,
  );
  const colorMode = theme === 'system' ? systemMode : theme;
  const column = useRef<HTMLDivElement>(null);

  useEffect(() => {
    applyTheme('default', colorMode);
  }, [colorMode]);

  // The theme describes how the page is shown, so it updates the current
  // history entry; only opening a page adds one.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (theme === 'system') url.searchParams.delete('theme');
    else url.searchParams.set('theme', theme);
    window.history.replaceState(window.history.state, '', url);
  }, [theme]);

  useEffect(() => {
    // Back and Forward restore the entry's page and the theme its URL pins.
    const onPopState = (): void => {
      setView(readView());
      setTheme(readTheme());
    };
    window.addEventListener('popstate', onPopState);
    return (): void => window.removeEventListener('popstate', onPopState);
  }, []);

  const open = useCallback((id: string): void => {
    const url = new URL(window.location.href);
    if (id === LAB_OVERVIEW) url.searchParams.delete('component');
    else url.searchParams.set('component', id);
    if (url.toString() !== window.location.href) {
      window.history.pushState(null, '', url);
    }
    setView(readView());
    setSelection((count) => count + 1);
  }, []);

  // A link that names a sheet inside a page lands on that sheet; any other
  // page opens at its top.
  const entryId = view.kind === 'page' ? view.entryId : undefined;
  const openId = viewId(view);
  useEffect(() => {
    const preview = document.getElementById(PREVIEW_ID);
    const target = entryId
      ? document
          .getElementById(entryId)
          ?.querySelector('[data-lab-entry-title]')
      : null;
    if (target) scrollToHeading(target);
    else preview?.scrollTo({ top: 0 });
    if (!target) window.scrollTo({ top: 0 });
    // `selection` re-runs this when the open page is chosen again.
  }, [openId, entryId, selection]);

  if (framed) {
    return (
      <LabColorModeContext.Provider value={colorMode}>
        <Surface variant="panel">
          <div
            id={PREVIEW_ID}
            data-view="frame"
            className="min-h-screen px-4 py-6 fg-primary"
          >
            {/* A framed link with no component, or one the catalog does not
                have, opens the introduction, as the full lab does. */}
            {view.kind === 'overview' ? (
              <ComponentsLabIntro onOpen={open} />
            ) : (
              <Sheets view={view} />
            )}
          </div>
        </Surface>
      </LabColorModeContext.Provider>
    );
  }

  const all = view.kind === 'all';

  return (
    // The capture view grows with its sheets, so a full-page capture holds
    // them all; every other view keeps the shell at the viewport and scrolls
    // inside the content card. Each scroll region is an `OverlayScrollArea`:
    // its scrollbar floats over the content, so the card keeps its 4px from
    // the shell's edge and the column stays centred whether or not a
    // scrollbar shows (docs/design/layout.md, Overflow and scroll).
    <Surface variant="rail" extent={all ? 'content' : 'viewport'}>
      <div
        className={
          all ? 'flex min-h-screen fg-primary' : 'flex h-full fg-primary'
        }
      >
        <ComponentsLabNav
          pages={COMPONENTS_LAB_PAGES}
          selected={openId}
          onSelect={open}
          theme={theme}
          onThemeChange={setTheme}
        />
        <LabColorModeContext.Provider value={colorMode}>
          {view.kind === 'overview' ? (
            <main data-view="overview" className="flex min-w-0 flex-1 flex-col">
              <OverlayScrollArea
                className="min-h-0 flex-1"
                viewportProps={{ id: PREVIEW_ID }}
                contentClassName="py-1 pr-1"
              >
                <ComponentsLabIntro onOpen={open} />
              </OverlayScrollArea>
            </main>
          ) : (
            <div className="flex min-w-0 flex-1 flex-col py-1 pr-1">
              <Surface
                as="main"
                variant="card"
                data-view="sheets"
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
              >
                <OverlayScrollArea
                  className="min-h-0 flex-1"
                  viewportProps={{ id: PREVIEW_ID }}
                >
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,47.5rem)_minmax(0,1fr)] gap-x-6 px-10 py-15 xl:grid-cols-[minmax(0,1fr)_minmax(0,47.5rem)_minmax(10rem,1fr)]">
                    <div ref={column} className="col-start-2 min-w-0">
                      <Sheets view={view} />
                    </div>
                    {view.kind === 'page' ? (
                      <div className="hidden min-w-0 xl:block">
                        <div className="sticky top-15">
                          <OnThisPage page={view.page} container={column} />
                        </div>
                      </div>
                    ) : null}
                  </div>
                </OverlayScrollArea>
              </Surface>
            </div>
          )}
        </LabColorModeContext.Provider>
      </div>
    </Surface>
  );
}
