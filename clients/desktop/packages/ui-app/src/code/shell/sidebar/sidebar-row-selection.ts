import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

/**
 * Multi-select for sidebar rows (CAN-3975), keyed by row key: worktree and
 * session rows by `worktreeRowKey`, Work Entry rows by `workEntryRowKey`.
 * A selection holds one kind of row: a gesture on a row of another kind
 * replaces it, so a rail never mixes worktrees and chats.
 * Separate from navigation: selecting rows never moves the open row.
 * The gestures follow a macOS Finder list: a plain row click navigates, ends
 * the selection, and anchors the row it opened (the rows call `anchor`);
 * Cmd-click toggles one row and re-anchors there; Shift-click (with or
 * without Cmd) selects from the anchor to the row, replacing the previous
 * Shift range but keeping earlier picks; Shift+Up/Down move that range's far
 * end. A click anywhere else ends it too (the bulk hook listens for it).
 */

/** What a selectable row is; a selection holds rows of one kind. */
export type SidebarRowKind = 'worktree' | 'session' | 'work-entry';

/**
 * Marks a row that handles its own clicks for the selection: modifier clicks
 * build it and a plain click ends it, so a click there is not "elsewhere".
 */
export const SIDEBAR_SELECTION_ROW_ATTR = 'data-worktree-selection-row';

/**
 * Where a click leaves the selection alone: its rows, and the menus and
 * dialogs that act on it.
 */
export const SIDEBAR_SELECTION_KEEPER_SELECTOR = [
  `[${SIDEBAR_SELECTION_ROW_ATTR}]`,
  '[data-sidebar-selection-keeper]',
  '[role="menu"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
].join(', ');

/** One rendered row of a list, in the order the list renders it. */
export interface SidebarSelectionRow {
  readonly key: string;
  readonly kind: SidebarRowKind;
  readonly selectable: boolean;
  /** Names for a batch confirm; lists whose rows are not in the snapshot supply them. */
  readonly label?: string;
  readonly projectName?: string;
  /** The navigated row: a batch removes it last. */
  readonly open?: boolean;
}

/**
 * Rendered rows per list id (a workspace local id). Children of a collapsed
 * group are not rendered, so they are absent here and never fall inside a
 * range.
 */
export type SidebarSelectionRows = ReadonlyMap<
  string,
  readonly SidebarSelectionRow[]
>;

interface SidebarSelectionAnchor {
  readonly listId: string;
  readonly key: string;
  /** The anchored row's kind, set when a plain click anchors without a pick. */
  readonly kind?: SidebarRowKind;
}

export interface SidebarRowSelectionState {
  readonly keys: ReadonlySet<string>;
  /** The kind every selected key has; absent exactly when `keys` is empty. */
  readonly kind?: SidebarRowKind;
  /** Where Shift ranges start: the last plain or Cmd-clicked row. */
  readonly anchor?: SidebarSelectionAnchor;
  /** The far end of the current Shift range, which Shift+arrows move. */
  readonly lead?: string;
  /** The picks made before the current Shift range, which a new range keeps. */
  readonly base?: ReadonlySet<string>;
}

export type SidebarRowSelectionAction =
  | {
      readonly type: 'toggle';
      readonly listId: string;
      readonly key: string;
      readonly kind: SidebarRowKind;
      /** The rows open now; a Cmd-click seeds the anchor only while it is one. */
      readonly openKeys?: ReadonlySet<string>;
    }
  | {
      readonly type: 'selectRange';
      readonly listId: string;
      readonly key: string;
      readonly kind: SidebarRowKind;
      readonly rows: readonly SidebarSelectionRow[];
    }
  /** A plain click: no selection, with Shift ranges starting at `key`. */
  | {
      readonly type: 'anchor';
      readonly listId: string;
      readonly key: string;
      readonly kind: SidebarRowKind;
      /** Moves only the anchor, keeping the picks (Shift+Arrow in a new list). */
      readonly keepKeys?: boolean;
    }
  | {
      readonly type: 'selectAllInList';
      readonly kind: SidebarRowKind;
      readonly rows: readonly SidebarSelectionRow[];
    }
  | { readonly type: 'clear' }
  /**
   * Keep exactly these keys, e.g. the rows a finished batch left behind. A
   * key that is no longer rendered is dropped.
   */
  | {
      readonly type: 'replace';
      readonly keys: readonly string[];
      readonly kind: SidebarRowKind | undefined;
      readonly visibleKeys: ReadonlySet<string>;
    }
  | { readonly type: 'prune'; readonly visibleKeys: ReadonlySet<string> };

export const EMPTY_SIDEBAR_ROW_SELECTION: SidebarRowSelectionState = {
  keys: new Set(),
};

/** The facts that decide whether a row can join a bulk selection. */
export interface WorktreeSelectableInputs {
  /**
   * `'session'` for cowork rows. Sessions are selectable too; their row
   * kind keeps them out of a worktree selection.
   */
  readonly subject: 'worktree' | 'session';
  /** The row's own `worktreeRemoval` capability. */
  readonly worktreeRemoval: false | 'archive' | 'delete' | undefined;
  readonly commandsDisabled: boolean;
  readonly hidden: boolean;
  /** Already being removed: the row is muted and inert. */
  readonly removalInProgress: boolean;
}

/**
 * Whether a row can be selected. A working agent, a Split PR lock, or setup
 * in progress does not prevent selection: the confirm lists such a row under
 * Not included with its reason.
 */
export function isWorktreeSelectable(
  inputs: WorktreeSelectableInputs,
): boolean {
  return (
    inputs.worktreeRemoval !== undefined &&
    inputs.worktreeRemoval !== false &&
    !inputs.commandsDisabled &&
    !inputs.hidden &&
    !inputs.removalInProgress
  );
}

function withKeys(
  keys: ReadonlySet<string>,
  kind: SidebarRowKind | undefined,
  anchor: SidebarSelectionAnchor | undefined,
  range?: { readonly lead: string; readonly base: ReadonlySet<string> },
): SidebarRowSelectionState {
  const state: SidebarRowSelectionState =
    keys.size === 0 || kind === undefined ? { keys } : { keys, kind };
  if (anchor === undefined) return state;
  return range === undefined
    ? { ...state, anchor }
    : { ...state, anchor, lead: range.lead, base: range.base };
}

/** The selectable rows of one kind, in the order the list renders them. */
function selectableOfKind(
  rows: readonly SidebarSelectionRow[],
  kind: SidebarRowKind,
): readonly SidebarSelectionRow[] {
  return rows.filter((row) => row.selectable && row.kind === kind);
}

/** A gesture on a row of another kind starts from an empty selection. */
function forKind(
  state: SidebarRowSelectionState,
  kind: SidebarRowKind,
): SidebarRowSelectionState {
  return state.kind !== undefined && state.kind !== kind
    ? EMPTY_SIDEBAR_ROW_SELECTION
    : state;
}

function toggleKey(
  state: SidebarRowSelectionState,
  listId: string,
  key: string,
  kind: SidebarRowKind,
  openKeys: ReadonlySet<string> | undefined,
): SidebarRowSelectionState {
  const base = forKind(state, kind);
  const keys = new Set(base.keys);
  // Finder: Cmd-click after a plain click keeps the row that click opened.
  const anchor = base.anchor;
  if (
    keys.size === 0 &&
    anchor !== undefined &&
    anchor.listId === listId &&
    anchor.kind === kind &&
    anchor.key !== key &&
    // Navigation outside the rail can leave the anchor on a closed row.
    openKeys?.has(anchor.key) === true
  ) {
    keys.add(anchor.key);
  }
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  return withKeys(keys, kind, { listId, key }, { lead: key, base: keys });
}

function selectRange(
  state: SidebarRowSelectionState,
  listId: string,
  key: string,
  kind: SidebarRowKind,
  rows: readonly SidebarSelectionRow[],
): SidebarRowSelectionState {
  const selectable = selectableOfKind(rows, kind);
  const targetIndex = selectable.findIndex((row) => row.key === key);
  if (targetIndex === -1) return state;
  const base = forKind(state, kind);
  const anchor = base.anchor;
  const anchorIndex =
    anchor?.listId === listId
      ? selectable.findIndex((row) => row.key === anchor.key)
      : -1;
  // No usable anchor (none yet, another list, another kind, or no longer
  // selectable): select the one row and anchor there.
  if (anchor === undefined || anchorIndex === -1) {
    const keys = new Set(base.keys);
    keys.add(key);
    return withKeys(keys, kind, { listId, key }, { lead: key, base: keys });
  }
  // The previous Shift range from this anchor is replaced; picks made
  // before it stay.
  const kept = base.base ?? base.keys;
  const keys = new Set(kept);
  const from = Math.min(anchorIndex, targetIndex);
  const to = Math.max(anchorIndex, targetIndex);
  for (const row of selectable.slice(from, to + 1)) keys.add(row.key);
  return withKeys(keys, kind, anchor, { lead: key, base: kept });
}

/** Whether Shift ranges in `listId` for `kind` start at the state's anchor. */
function anchoredIn(
  state: SidebarRowSelectionState,
  listId: string,
  kind: SidebarRowKind,
): boolean {
  if (state.anchor?.listId !== listId) return false;
  return (state.kind ?? state.anchor.kind ?? kind) === kind;
}

/**
 * The row Shift+Up/Down moves the current range's far end to: one selectable
 * row past the lead (or the anchor, or `fromKey` with neither), clamped to
 * the list. `undefined` when there is nothing to move.
 */
function sidebarSelectionStepTarget(
  state: SidebarRowSelectionState,
  listId: string,
  fromKey: string,
  step: 1 | -1,
  rows: readonly SidebarSelectionRow[],
  kind: SidebarRowKind,
): string | undefined {
  const selectable = selectableOfKind(rows, kind);
  const lead = anchoredIn(state, listId, kind)
    ? (state.lead ?? state.anchor?.key ?? fromKey)
    : fromKey;
  const index = selectable.findIndex((row) => row.key === lead);
  if (index === -1) return undefined;
  const next =
    selectable[Math.max(0, Math.min(selectable.length - 1, index + step))];
  return next?.key;
}

function selectAll(
  state: SidebarRowSelectionState,
  kind: SidebarRowKind,
  rows: readonly SidebarSelectionRow[],
): SidebarRowSelectionState {
  const base = forKind(state, kind);
  const keys = new Set(base.keys);
  for (const row of selectableOfKind(rows, kind)) keys.add(row.key);
  if (base === state && keys.size === state.keys.size) return state;
  return withKeys(keys, kind, base.anchor);
}

function prune(
  state: SidebarRowSelectionState,
  visibleKeys: ReadonlySet<string>,
): SidebarRowSelectionState {
  const keys = new Set([...state.keys].filter((key) => visibleKeys.has(key)));
  const anchor =
    state.anchor !== undefined && visibleKeys.has(state.anchor.key)
      ? state.anchor
      : undefined;
  if (keys.size === state.keys.size && anchor === state.anchor) return state;
  // A vanished range end falls back to the anchor, so the range keeps its
  // earlier picks instead of treating every selected row as one.
  const lead =
    state.lead !== undefined && visibleKeys.has(state.lead)
      ? state.lead
      : anchor?.key;
  const range =
    lead === undefined || state.base === undefined
      ? undefined
      : {
          lead,
          base: new Set([...state.base].filter((key) => visibleKeys.has(key))),
        };
  return withKeys(keys, state.kind, anchor, range);
}

export function sidebarRowSelectionReducer(
  state: SidebarRowSelectionState,
  action: SidebarRowSelectionAction,
): SidebarRowSelectionState {
  switch (action.type) {
    case 'toggle':
      return toggleKey(
        state,
        action.listId,
        action.key,
        action.kind,
        action.openKeys,
      );
    case 'selectRange':
      return selectRange(
        state,
        action.listId,
        action.key,
        action.kind,
        action.rows,
      );
    case 'anchor':
      if (action.keepKeys === true) {
        const kept = forKind(state, action.kind);
        return withKeys(
          kept.keys,
          kept.keys.size === 0 ? undefined : action.kind,
          { listId: action.listId, key: action.key, kind: action.kind },
          { lead: action.key, base: kept.keys },
        );
      }
      // An empty selection keeps its key set, so anchoring on navigation
      // does not re-render the rows.
      return withKeys(
        state.keys.size === 0 ? state.keys : new Set(),
        undefined,
        {
          listId: action.listId,
          key: action.key,
          kind: action.kind,
        },
      );
    case 'selectAllInList':
      return selectAll(state, action.kind, action.rows);
    case 'clear':
      return state.keys.size === 0 && state.anchor === undefined
        ? state
        : EMPTY_SIDEBAR_ROW_SELECTION;
    case 'replace':
      return withKeys(
        new Set(action.keys.filter((key) => action.visibleKeys.has(key))),
        action.kind,
        state.anchor,
      );
    case 'prune':
      return prune(state, action.visibleKeys);
  }
}

export interface SidebarRowSelection {
  readonly keys: ReadonlySet<string>;
  /** The kind of the selected rows; `undefined` while nothing is selected. */
  readonly kind: SidebarRowKind | undefined;
  /** True while any row is selected: selected rows take the open row's fill. */
  readonly active: boolean;
  readonly count: number;
  readonly isSelected: (key: string) => boolean;
  /** Toggles a rendered row; its kind comes from the reported rows. */
  readonly toggle: (listId: string, key: string) => void;
  /** Shift-click: from the anchor to `key` over the list's rendered rows. */
  readonly selectRange: (listId: string, key: string) => void;
  readonly selectAllInList: (listId: string) => void;
  /** A plain click on `key`: clears the selection and anchors Shift there. */
  readonly anchor: (listId: string, key: string) => void;
  /**
   * Shift+Up/Down from the focused `key`: moves the Shift range's far end one
   * row and returns that row's key, for the caller to focus.
   */
  readonly extend: (
    listId: string,
    key: string,
    step: 1 | -1,
  ) => string | undefined;
  readonly clear: () => void;
  readonly replace: (keys: readonly string[]) => void;
}

/**
 * Selection state over the rail's rendered rows. Keys that stop rendering
 * (removed, filtered out, project collapsed) or stop being selectable are
 * pruned. A running batch keeps its own snapshot, so pruning never affects
 * it.
 */
export function useSidebarRowSelection(
  rows: SidebarSelectionRows,
  /**
   * The latest reported rows, when `rows` may hold a stale open row: gestures
   * read which row is open from them.
   */
  readLiveRows?: () => SidebarSelectionRows,
): SidebarRowSelection {
  const [state, dispatch] = useReducer(
    sidebarRowSelectionReducer,
    EMPTY_SIDEBAR_ROW_SELECTION,
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  // Only rows a list reports as selectable can be selected: a row no list
  // reports (a read-only list's menu) never enters the selection, and one
  // that becomes unselectable (hidden, removal withdrawn) leaves it. Kinds
  // cover every reported row, so a selected row that turned unselectable can
  // still be toggled off.
  const { visibleKeys, kindByKey, openKeys } = useMemo(() => {
    const keys = new Set<string>();
    const kinds = new Map<string, SidebarRowKind>();
    const open = new Set<string>();
    for (const listRows of rows.values()) {
      for (const row of listRows) {
        kinds.set(row.key, row.kind);
        if (row.selectable) keys.add(row.key);
        if (row.open === true) open.add(row.key);
      }
    }
    return { visibleKeys: keys, kindByKey: kinds, openKeys: open };
  }, [rows]);

  useEffect(() => {
    dispatch({ type: 'prune', visibleKeys });
  }, [visibleKeys]);

  const rowsFor = useCallback(
    (listId: string): readonly SidebarSelectionRow[] => rows.get(listId) ?? [],
    [rows],
  );
  const readOpenKeys = useCallback((): ReadonlySet<string> => {
    if (readLiveRows === undefined) return openKeys;
    const open = new Set<string>();
    for (const listRows of readLiveRows().values()) {
      for (const row of listRows) {
        if (row.open === true && kindByKey.has(row.key)) open.add(row.key);
      }
    }
    return open;
  }, [readLiveRows, openKeys, kindByKey]);
  const keysRef = useRef(state.keys);
  keysRef.current = state.keys;
  const seedOpenRangeAnchor = useCallback(
    (listId: string, kind: SidebarRowKind): void => {
      const current = stateRef.current;
      if (current.anchor !== undefined || current.keys.size > 0) return;
      // An already-open row may come from restored navigation rather than a
      // rail click. The first Shift gesture still starts from that visible row.
      const openKeysNow = readOpenKeys();
      const open = rowsFor(listId).find(
        (row) =>
          openKeysNow.has(row.key) && row.selectable && row.kind === kind,
      );
      if (open !== undefined) {
        dispatch({ type: 'anchor', listId, key: open.key, kind });
      }
    },
    [rowsFor, readOpenKeys],
  );
  const toggle = useCallback(
    (listId: string, key: string): void => {
      if (!keysRef.current.has(key) && !visibleKeys.has(key)) return;
      const kind = kindByKey.get(key);
      if (kind === undefined) return;
      dispatch({
        type: 'toggle',
        listId,
        key,
        kind,
        openKeys: readOpenKeys(),
      });
    },
    [visibleKeys, kindByKey, readOpenKeys],
  );
  const selectRange = useCallback(
    (listId: string, key: string): void => {
      const kind = kindByKey.get(key);
      if (kind === undefined) return;
      seedOpenRangeAnchor(listId, kind);
      dispatch({
        type: 'selectRange',
        listId,
        key,
        kind,
        rows: rowsFor(listId),
      });
    },
    [kindByKey, rowsFor, seedOpenRangeAnchor],
  );
  const selectAllInList = useCallback(
    (listId: string): void => {
      const listRows = rowsFor(listId);
      const kind = listRows.find((row) => row.selectable)?.kind;
      if (kind === undefined) return;
      dispatch({ type: 'selectAllInList', kind, rows: listRows });
    },
    [rowsFor],
  );
  const anchor = useCallback(
    (listId: string, key: string): void => {
      const kind = kindByKey.get(key);
      if (kind === undefined) return;
      dispatch({ type: 'anchor', listId, key, kind });
    },
    [kindByKey],
  );
  const extend = useCallback(
    (listId: string, key: string, step: 1 | -1): string | undefined => {
      const kind = kindByKey.get(key);
      if (kind === undefined) return undefined;
      const listRows = rowsFor(listId);
      const target = sidebarSelectionStepTarget(
        stateRef.current,
        listId,
        key,
        step,
        listRows,
        kind,
      );
      if (target === undefined) return undefined;
      const current = stateRef.current;
      // No anchor in this list yet: the focused row anchors the range.
      if (!anchoredIn(current, listId, kind)) {
        dispatch({ type: 'anchor', listId, key, kind, keepKeys: true });
      }
      dispatch({
        type: 'selectRange',
        listId,
        key: target,
        kind,
        rows: listRows,
      });
      return target;
    },
    [kindByKey, rowsFor],
  );
  const clear = useCallback((): void => dispatch({ type: 'clear' }), []);
  // A batch's completion calls `replace` from the render that confirmed it,
  // so it reads the rows rendered now rather than that render's.
  const visibleKeysRef = useRef(visibleKeys);
  visibleKeysRef.current = visibleKeys;
  const kindByKeyRef = useRef(kindByKey);
  kindByKeyRef.current = kindByKey;
  const replace = useCallback((keys: readonly string[]): void => {
    const first = keys.find((key) => kindByKeyRef.current.has(key));
    const kind =
      first === undefined ? undefined : kindByKeyRef.current.get(first);
    dispatch({
      type: 'replace',
      keys: keys.filter((key) => kindByKeyRef.current.get(key) === kind),
      kind,
      visibleKeys: visibleKeysRef.current,
    });
  }, []);

  return useMemo(
    () => ({
      keys: state.keys,
      kind: state.kind,
      active: state.keys.size > 0,
      count: state.keys.size,
      isSelected: (key: string): boolean => state.keys.has(key),
      toggle,
      selectRange,
      selectAllInList,
      anchor,
      extend,
      clear,
      replace,
    }),
    [
      anchor,
      extend,
      state.keys,
      state.kind,
      toggle,
      selectRange,
      selectAllInList,
      clear,
      replace,
    ],
  );
}
