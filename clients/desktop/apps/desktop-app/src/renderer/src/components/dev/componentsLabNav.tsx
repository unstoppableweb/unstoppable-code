import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  Divider,
  Heading,
  ListRow,
  OverlayScrollArea,
  SearchField,
  SegmentedControl,
  Surface,
} from '@canopy/ui-shared/components';
import { BrandLogo } from '@/components/BrandLogo';
import {
  COMPONENTS_LAB_SECTIONS,
  type ComponentsLabPage,
} from './componentsLabPages';
import { baseName, expandSource } from './componentsLabPageSheet';

export type LabThemeChoice = 'system' | 'light' | 'dark';

export const LAB_OVERVIEW = 'overview';
export const LAB_ALL = 'all';

const SEARCH_SHORTCUT = ['⌘', 'K'] as const;

interface SearchHit {
  readonly page: ComponentsLabPage;
  /** What to open: the page, or the sheet inside it that matched. */
  readonly openId: string;
}

/** Letters and digits only, so `TextArea` finds `Text area`. */
function searchKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** How well a name answers a query: exact, then its start, then anywhere. */
function nameRank(names: readonly string[], key: string): number | null {
  const keys = names.map(searchKey);
  if (keys.includes(key)) return 0;
  if (keys.some((name) => name.startsWith(key))) return 1;
  return keys.some((name) => name.includes(key)) ? 2 : null;
}

/**
 * The pages a query finds, best first. Names come before prose: a page's
 * name, then a sheet's name or one of the components its source files
 * export, and only then a note or a source path. A hit on a sheet opens the
 * page at that sheet. Enter opens the first hit, so it is the named one.
 */
function searchPages(
  pages: readonly ComponentsLabPage[],
  needle: string,
): readonly SearchHit[] {
  const key = searchKey(needle);
  if (key === '') return pages.map((page) => ({ page, openId: page.id }));
  const inProse = (text: string | undefined): boolean =>
    text !== undefined && searchKey(text).includes(key);
  const ranked = pages.flatMap((page, order) => {
    const offers: { rank: number; openId: string }[] = [];
    const offer = (rank: number | null, openId: string): void => {
      if (rank !== null) offers.push({ rank, openId });
    };
    offer(nameRank([page.name], key), page.id);
    for (const entry of page.entries) {
      const components = expandSource(entry.source).map(baseName);
      offer(
        nameRank([entry.name, ...(entry.components ?? []), ...components], key),
        entry.id,
      );
    }
    if (inProse(page.note)) offer(3, page.id);
    for (const entry of page.entries) {
      if (inProse(entry.note) || inProse(entry.source)) offer(3, entry.id);
    }
    // The first offer wins a tie: the page before its sheets, names before
    // prose.
    const [best] = offers.sort((a, b) => a.rank - b.rank);
    return best === undefined
      ? []
      : [{ rank: best.rank, order, hit: { page, openId: best.openId } }];
  });
  return ranked
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((item) => item.hit);
}

function NavRow({
  id,
  openId = id,
  selected,
  onSelect,
  children,
}: {
  readonly id: string;
  readonly openId?: string;
  readonly selected: string;
  readonly onSelect: (id: string) => void;
  readonly children: string;
}): JSX.Element {
  const current = selected === id;
  return (
    <ListRow
      size="sm"
      selected={current}
      aria-current={current ? 'page' : undefined}
      title={children}
      onClick={(): void => onSelect(openId)}
    >
      {children}
    </ListRow>
  );
}

/**
 * The lab's sidebar: the brand mark, a search over the pages (⌘K, Enter
 * opens the first hit), the pages by section, and the theme switch pinned
 * to the bottom. It sits on the shell's own fill, with no edge of its own.
 */
export function ComponentsLabNav({
  pages,
  selected,
  onSelect,
  theme,
  onThemeChange,
}: {
  readonly pages: readonly ComponentsLabPage[];
  readonly selected: string;
  readonly onSelect: (id: string) => void;
  readonly theme: LabThemeChoice;
  readonly onThemeChange: (next: LabThemeChoice) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k')
        return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // A page opened by a link, by Back or from a tile may sit far down the
  // list; bring its row into view without moving a row already on screen.
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const needle = query.trim().toLowerCase();
  const hits = useMemo(() => searchPages(pages, needle), [pages, needle]);
  const sections = useMemo(
    () =>
      COMPONENTS_LAB_SECTIONS.map((section) => ({
        section,
        hits: hits.filter((hit) => hit.page.section === section),
      })).filter((group) => group.hits.length > 0),
    [hits],
  );

  const onSearchKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    // Enter that confirms an input method's candidate is not a search.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const [first] = hits;
    if (event.key !== 'Enter' || needle === '' || !first) return;
    event.preventDefault();
    onSelect(first.openId);
    setQuery('');
  };

  return (
    <Surface
      as="nav"
      aria-label="Components"
      variant="section"
      extent="viewport"
      className="sticky top-0 flex w-70 shrink-0 flex-col"
    >
      <div className="flex items-center px-6 pt-5 pb-4">
        <BrandLogo size={24} />
      </div>
      <div className="px-4 pb-3">
        <SearchField
          ref={searchRef}
          value={query}
          onValueChange={setQuery}
          onKeyDown={onSearchKeyDown}
          aria-label="Search components"
          placeholder="Search"
          count={needle === '' ? undefined : hits.length}
          shortcut={SEARCH_SHORTCUT}
        />
      </div>
      <OverlayScrollArea
        className="min-h-0 flex-1"
        viewportRef={listRef}
        contentClassName="flex flex-col gap-4 px-4 pb-4"
      >
        {needle === '' ? (
          <div className="flex flex-col gap-0.5">
            <NavRow id={LAB_OVERVIEW} selected={selected} onSelect={onSelect}>
              Introduction
            </NavRow>
            <NavRow id={LAB_ALL} selected={selected} onSelect={onSelect}>
              All unified
            </NavRow>
          </div>
        ) : null}
        {needle === '' ? null : (
          // A search lists its hits best first, not by section, so the row
          // Enter opens is the one on top.
          <div className="flex flex-col gap-0.5">
            {hits.map(({ page, openId }) => (
              <NavRow
                key={page.id}
                id={page.id}
                openId={openId}
                selected={selected}
                onSelect={onSelect}
              >
                {page.name}
              </NavRow>
            ))}
          </div>
        )}
        {(needle === '' ? sections : []).map(({ section, hits: rows }) => (
          <div key={section} className="flex flex-col gap-0.5">
            <div className="px-2 pb-1">
              <Heading level={2} variant="sidebar">
                {section}
              </Heading>
            </div>
            {rows.map(({ page, openId }) => (
              <NavRow
                key={page.id}
                id={page.id}
                openId={openId}
                selected={selected}
                onSelect={onSelect}
              >
                {page.name}
              </NavRow>
            ))}
          </div>
        ))}
        {hits.length === 0 ? (
          <p className="px-2 text-xs fg-tertiary">No pages match.</p>
        ) : null}
      </OverlayScrollArea>
      <div className="flex flex-col gap-2 px-4 pb-4">
        <Divider />
        <SegmentedControl
          label="Color mode"
          value={theme}
          width="fill"
          onChange={onThemeChange}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </div>
    </Surface>
  );
}
