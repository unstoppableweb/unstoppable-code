'use client';

import { ControlButton } from '../../primitives/Button';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  CheckIcon,
  ChevronDownMediumIcon,
  CloseMediumIcon,
} from '../../icons/AppIcons';
import type { PanelTabModel } from '../../panels/registry-types';
import { PickListSearch, usePickListKeys } from '../../primitives/PickList';
import { FloatingMenu } from '../../primitives/FloatingMenu';
import {
  PickerMenuList,
  PickerMenuOption,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
  PickerMenuOptionLeading,
  PickerMenuSearchHeader,
} from '../../primitives/PickerMenu';
import { TitlebarIconButton } from '../TitlebarIconButton';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';

/** A list longer than this gets a search field. */
const TAB_LIST_SEARCH_THRESHOLD = 8;

export interface PanelTabListButtonProps {
  readonly groupId: string;
  readonly tabs: readonly PanelTabModel[];
  readonly activePanelId: string | null;
  readonly onSelectTab: (groupId: string, panelId: string) => void;
  readonly onCloseTab: (groupId: string, panelId: string) => void;
  readonly canCloseTab?: (tab: PanelTabModel) => boolean;
  /** The tab's status glyph, drawn as the strip draws it. */
  readonly renderIcon: (tab: PanelTabModel) => ReactNode;
  readonly renderLabel: (tab: PanelTabModel) => ReactNode;
  readonly renderTrailing?: (tab: PanelTabModel) => ReactNode;
  readonly getTitle: (tab: PanelTabModel) => string;
  /** Replay-masks the close button's label, which names the tab. */
  readonly isTitlePrivate?: (tab: PanelTabModel) => boolean;
  /** The button's root, which the bar measures as room the tabs could use. */
  readonly rootRef?: RefObject<HTMLDivElement | null>;
  /** Hidden while every tab fits (fill rows); it stays mounted and measured. */
  readonly hidden?: boolean;
  /** An unread tab is out of view: the button carries a dot. */
  readonly unreadOutOfView?: boolean;
}

/**
 * Set while a glyph renders inside the ⌄ list rather than the strip: chat
 * glyphs keep their number there and hand a running spinner to the row's
 * right-hand status slot.
 */
export const PanelTabListRowContext = createContext(false);

/** Whether the caller renders inside a ⌄ list row. */
export function useInPanelTabList(): boolean {
  return useContext(PanelTabListRowContext);
}

/**
 * The ⌄ button after a panel's tab strip and the list of every tab it opens:
 * each row shows the tab's status glyph, its title, and at its right end the
 * tab's state dot, which the close button replaces while the row is under the
 * pointer or keyboard (never for a tab still working). The current tab
 * carries the pickers' checkmark, and a long list gets a search field. Pure
 * display: selecting and closing go through the bar's own intents, so the
 * list never disagrees with the strip.
 */
export function PanelTabListButton({
  groupId,
  tabs,
  activePanelId,
  onSelectTab,
  onCloseTab,
  canCloseTab,
  renderIcon,
  renderLabel,
  renderTrailing,
  getTitle,
  isTitlePrivate,
  rootRef,
  hidden = false,
  unreadOutOfView = false,
}: PanelTabListButtonProps): JSX.Element {
  const [open, setOpen] = useState(false);
  // The highlighted row swaps its status for × only once the user has moved
  // it with the keyboard; on opening it rests on the selected tab, which
  // keeps its ✓. Pointer hover always swaps (CSS).
  const [keyboardMoved, setKeyboardMoved] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Row ids, so the focused field or list can name the highlighted row
  // (`aria-activedescendant`) for screen readers.
  const idBase = useId();
  const listId = `${idBase}-list`;
  const rowId = (panelId: string): string => `${idBase}-row-${panelId}`;
  // Decided when the list opens, so closing tabs from it never takes the
  // field (and its query) away mid-search.
  const [searchable, setSearchable] = useState(false);

  const rows = useMemo(() => {
    // A query only filters while its field is there to show it.
    const needle = searchable ? query.trim().toLowerCase() : '';
    return tabs.filter(
      (tab) => needle === '' || getTitle(tab).toLowerCase().includes(needle),
    );
  }, [tabs, query, searchable, getTitle]);

  // A closed or filtered-out row never leaves the highlight past the end:
  // it moves to the row that took its place, or to the new last row.
  const current = Math.min(highlight, Math.max(rows.length - 1, 0));
  const currentRow = rows[current];
  const activeDescendant =
    currentRow === undefined ? undefined : rowId(currentRow.panelId);

  useEffect(() => {
    if (!open) return undefined;
    const reveal = (): void => {
      listRef.current
        ?.querySelector(`[data-index="${current}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    };
    reveal();
    // Once more after the menu has been placed and given its final height
    // (FloatingMenu settles both after this effect), so a row near the end
    // of a long list is not left below the fold.
    const view = listRef.current?.ownerDocument.defaultView;
    let frame = view?.requestAnimationFrame(() => {
      frame = view.requestAnimationFrame(reveal);
    });
    return (): void => {
      if (frame !== undefined) view?.cancelAnimationFrame(frame);
    };
  }, [open, current]);

  // Every opening (click or arrow key) starts on the selected tab, with an
  // empty search; later tab changes while it is open keep the user's place.
  const changeOpen = (next: boolean): void => {
    if (next && !open) {
      setQuery('');
      setSearchable(tabs.length > TAB_LIST_SEARCH_THRESHOLD);
      const selected = tabs.findIndex((tab) => tab.panelId === activePanelId);
      setHighlight(Math.max(selected, 0));
      setKeyboardMoved(false);
    }
    setOpen(next);
  };

  const select = (panelId: string): void => {
    onSelectTab(groupId, panelId);
    setOpen(false);
    // The list's focus goes with it; it returns to the ⌄ button, unless ⌄
    // hides as the list closes (the bar then focuses the picked tab).
    if (!hidden) anchorRef.current?.focus({ preventScroll: true });
  };

  const keyboard = {
    keys: rows.map((tab) => tab.panelId),
    activeKey: currentRow?.panelId ?? null,
    onActiveKeyChange: (key: string): void => {
      setKeyboardMoved(true);
      setHighlight(rows.findIndex((tab) => tab.panelId === key));
    },
    onPick: select,
  };
  const onKeyDown = usePickListKeys(keyboard);

  return (
    // Its own root, like the `+` root, so the row spaces both controls the
    // same way whatever wraps the button (the tooltip adds a span).
    <div
      ref={rootRef}
      className="canopy-panel-tab-list-root"
      // Never while its list is open: the list stays anchored to ⌄ even if
      // closing tabs from it lets the rest fit.
      data-hidden={(hidden && !open) || undefined}
      data-unread={unreadOutOfView || undefined}
      data-testid={`panel-tab-list-root-${groupId}`}
    >
      <TitlebarIconButton
        ref={anchorRef}
        surface="panelTabStrip"
        icon={ChevronDownMediumIcon}
        aria-label="All tabs"
        title="All tabs"
        aria-haspopup="dialog"
        aria-expanded={open}
        holdHoverWhenExpanded
        data-testid={`panel-tab-list-${groupId}`}
        onClick={(): void => changeOpen(!open)}
      />
      <FloatingMenu
        open={open}
        onOpenChange={changeOpen}
        anchorRef={anchorRef}
        placement="bottom-right"
        interaction="manual"
        role="dialog"
        aria-label="All tabs"
        heightLimit={420}
        className="flex w-72 flex-col"
        data-testid={`panel-tab-list-menu-${groupId}`}
        // Focus always moves into the list, so its keys work: the search
        // field, or the list itself when there is none.
        initialFocusRef={searchable ? searchRef : listRef}
        onKeyDown={onKeyDown}
      >
        {/* The list's own styles hang off this wrapper (panels.css). */}
        <div
          className="canopy-panel-tab-list flex min-h-0 flex-1 flex-col"
          data-keyboard-moved={keyboardMoved || undefined}
        >
          {searchable ? (
            <PickerMenuSearchHeader>
              <PickListSearch
                ref={searchRef}
                type="search"
                value={query}
                placeholder={`Search ${tabs.length} tabs`}
                aria-label="Search tabs"
                data-testid={`panel-tab-list-search-${groupId}`}
                listId={listId}
                keyboard={keyboard}
                activeDescendant={activeDescendant}
                onChange={(event): void => {
                  setQuery(event.target.value);
                  setHighlight(0);
                }}
                onClear={(): void => {
                  setQuery('');
                  setHighlight(0);
                  searchRef.current?.focus();
                }}
              />
            </PickerMenuSearchHeader>
          ) : null}
          <PickerMenuList
            presentation="scrolling-tabs"
            ref={listRef}
            id={listId}
            tabIndex={-1}
            aria-activedescendant={activeDescendant}
            aria-label="Tabs"
          >
            {rows.length === 0 ? (
              <div className="canopy-panel-tab-list-empty">
                No matching tabs
              </div>
            ) : null}
            {rows.map((tab, index) => {
              const title = getTitle(tab);
              const privateTitle = isTitlePrivate?.(tab) === true;
              const closeLabelId = `${idBase}-close-${tab.panelId}`;
              const closable = canCloseTab ? canCloseTab(tab) : true;
              const selected = tab.panelId === activePanelId;
              return (
                // The shared menu row (PickerMenuOption, nested 8px corners)
                // in a row group, so the end slot's close button can sit
                // beside it rather than inside its button.
                <div
                  key={tab.panelId}
                  data-index={index}
                  data-highlighted={index === current}
                  className="canopy-panel-tab-list-row group/model-row relative w-full rounded-md"
                  onPointerMove={(): void => setHighlight(index)}
                >
                  <PickerMenuOption
                    id={rowId(tab.panelId)}
                    role="option"
                    aria-selected={selected}
                    tabIndex={-1}
                    active={index === current}
                    trailingSlots="one"
                    rowHoverSurface
                    data-testid={`panel-tab-list-row-${tab.panelId}`}
                    // Keeps focus in the search field.
                    onMouseDown={(event): void => event.preventDefault()}
                    onClick={(): void => select(tab.panelId)}
                  >
                    <PickerMenuOptionLeading tone="tertiary">
                      <PanelTabListRowContext.Provider value>
                        {renderIcon(tab)}
                      </PanelTabListRowContext.Provider>
                    </PickerMenuOptionLeading>
                    <PickerMenuOptionContent>
                      <PickerMenuOptionLabel>
                        <span className="canopy-panel-tab-list-title">
                          {renderLabel(tab)}
                        </span>
                      </PickerMenuOptionLabel>
                    </PickerMenuOptionContent>
                  </PickerMenuOption>
                  {/* One slot at the row's end for every status: the current
                      tab's ✓, the unread dot, or a running spinner (the
                      glyph hands it here, panels.css). Hover, or a keyboard
                      move, swaps it for the close button. */}
                  <span className="canopy-panel-tab-list-end">
                    {selected ? (
                      <span
                        className="canopy-panel-tab-list-check"
                        data-testid={`panel-tab-list-check-${tab.panelId}`}
                      >
                        <CheckIcon size="sm" />
                      </span>
                    ) : null}
                    {renderTrailing ? (
                      <span className="canopy-panel-tab-list-trailing">
                        {renderTrailing(tab)}
                      </span>
                    ) : null}
                    {closable ? (
                      // The mask covers the close label, which names the tab.
                      // A private one is a masked label, not `aria-label`,
                      // which click events copy past the mask.
                      <span
                        className={
                          privateTitle
                            ? `contents ${REPLAY_MASK_CLASS}`
                            : 'contents'
                        }
                      >
                        <ControlButton
                          type="button"
                          presentation="panel-tab-list-close"
                          {...(privateTitle
                            ? { 'aria-labelledby': closeLabelId }
                            : { 'aria-label': `Close ${title}` })}
                          data-testid={`panel-tab-list-close-${tab.panelId}`}
                          tabIndex={-1}
                          // Keeps focus in the search field, so typing carries on.
                          onPointerDown={(event): void =>
                            event.preventDefault()
                          }
                          onClick={(event): void => {
                            // Closing keeps the list open on the next tab.
                            event.stopPropagation();
                            onCloseTab(groupId, tab.panelId);
                          }}
                        >
                          <CloseMediumIcon size="sm" />
                        </ControlButton>
                        {privateTitle ? (
                          <span className="sr-only" id={closeLabelId}>
                            Close {title}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </PickerMenuList>
        </div>
      </FloatingMenu>
    </div>
  );
}
