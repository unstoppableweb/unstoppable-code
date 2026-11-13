import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import {
  Editor,
  Range,
  Transforms,
  Point,
  type BaseSelection,
  type Descendant,
  type RangeRef,
} from 'slate';
import { ReactEditor } from 'slate-react';
import type {
  ChatEditor,
  FileMentionOption,
  FileReferenceElement,
} from '../types';
import { editorDocumentGeneration, focusEditor } from './slate-utils';

/**
 * A bounded Slate-point scan preserves inline pills and ignores email/path
 * punctuation. It reads the render's document and selection snapshots, which
 * are the editor's own at render time.
 */
function findTrigger(
  editor: ChatEditor,
  slash: boolean,
  at: boolean,
  dollar: boolean,
  children: Descendant[],
  selection: BaseSelection,
): { range: Range; query: string; variant: 'add' | 'commands' } | null {
  if (!selection || !Range.isCollapsed(selection) || children.length === 0)
    return null;
  let point = selection.anchor;
  let query = '';
  for (let count = 0; count < 200; count++) {
    const previous = Editor.before(editor, point, { unit: 'character' });
    if (!previous) return null;
    const character = Editor.string(editor, { anchor: previous, focus: point });
    if (!character || /\s/.test(character)) return null;
    if (
      (slash && character === '/') ||
      (at && character === '@') ||
      (dollar && character === '$')
    ) {
      const before = Editor.before(editor, previous, { unit: 'character' });
      if (
        !before ||
        /[\s([{]/.test(
          Editor.string(editor, { anchor: before, focus: previous }),
        )
      ) {
        return {
          range: { anchor: previous, focus: selection.anchor },
          query,
          variant: character === '@' ? 'add' : 'commands',
        };
      }
    }
    query = character + query;
    point = previous;
  }
  return null;
}

/** The text in `range`, or `''` when its paths no longer resolve. */
function readRange(editor: ChatEditor, range: Range): string {
  try {
    return Editor.string(editor, range);
  } catch {
    return '';
  }
}

/** The character just before `point`, or `''` at the start of the draft. */
function characterBefore(editor: ChatEditor, point: Point): string {
  const before = Editor.before(editor, point, { unit: 'character' });
  return before ? Editor.string(editor, { anchor: before, focus: point }) : '';
}

/** The character just after `point`, or `''` at the end of the draft. */
function characterAfter(editor: ChatEditor, point: Point): string {
  const after = Editor.after(editor, point, { unit: 'character' });
  return after ? Editor.string(editor, { anchor: point, focus: after }) : '';
}

/**
 * The trigger a held pick was made from (`holdSelection`): its range, kept
 * current through edits elsewhere, and the text in and around it when it was
 * picked, so an edit to the trigger itself is detected. `generation` is the
 * editor's document generation then: a replaced document (a send's reset, a
 * restored draft) leaves the range's paths pointing into a different draft.
 */
interface PickedTrigger {
  range: RangeRef;
  text: string;
  before: string;
  after: string;
  generation: number;
}

/**
 * Whether the picked trigger still reads as it did when picked: the same
 * draft and text, not run into new text on either side. Whitespace typed
 * beside it (the person moving on) leaves it intact. A range whose paths no
 * longer resolve is not intact.
 */
function isPickIntact(
  editor: ChatEditor,
  range: Range,
  pick: PickedTrigger,
): boolean {
  if (editorDocumentGeneration(editor) !== pick.generation) return false;
  try {
    const before = characterBefore(editor, Range.start(range));
    const after = characterAfter(editor, Range.end(range));
    return (
      Editor.string(editor, range) === pick.text &&
      (before === pick.before || /^\s$/u.test(before)) &&
      (after === pick.after || /^\s$/u.test(after))
    );
  } catch {
    return false;
  }
}

export interface ComposerMenuController {
  open: boolean;
  variant: 'add' | 'commands';
  /** Whether the active session came from typed editor input or the + trigger. */
  origin: 'editor' | 'toolbar';
  query: string;
  setQuery: (query: string) => void;
  onOpenChange: (open: boolean) => void;
  /**
   * Removes the trigger so the caller can insert in its place, and reports
   * whether it may. For a held pick (`holdSelection`) it removes the trigger
   * the pick was made from, and only while that trigger reads as it did when
   * picked, in the same draft; otherwise, and after the person abandoned the
   * pick, it changes nothing and returns `false`, and the caller inserts
   * nothing.
   */
  consumeTrigger: () => boolean;
  beginSelection: () => void;
  /**
   * Holds the session for a pick whose insertion waits on the host, such as
   * a command that must be enabled first: the picked trigger is kept, the
   * menu stays open, and the keys that would pick, move or send do nothing
   * until the returned release runs. Text typed meanwhile stays where it was
   * typed; the insertion lands at the picked trigger only if that is
   * unchanged (see `consumeTrigger`), and the caret returns to where the
   * person was typing. Escape or a press outside the menu abandons the pick:
   * the menu closes and a late insertion inserts nothing.
   */
  holdSelection: () => () => void;
  anchorRef: RefObject<HTMLSpanElement | null>;
  menuRef: RefObject<HTMLDivElement | null>;
  editorRef: RefObject<HTMLElement | null>;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  /**
   * The row under the pointer, reported by the list. Pointer hover clears the
   * keyboard highlight so the hover style shows; Enter (or Tab in a typed
   * session) then activates the hovered row rather than silently falling
   * back to the first one.
   */
  setHoveredId: (id: string | null) => void;
  /**
   * Re-resolves the highlight against the rendered rows. A menu rendered in
   * the session's own commit never needs it; one rendered after it (through
   * a `ComposerMenuChannel`) calls it once its rows are in the document:
   * `reset` for a new query, variant or session, otherwise to follow rows
   * that changed under the highlight.
   */
  syncActiveRow: (reset: boolean) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLDivElement>) => boolean;
  prepareAction: () => void;
  /**
   * Replaces the active query (or a held pick's trigger, see
   * `consumeTrigger`) and keeps the inserted invocation token separated; the
   * caret lands after the token and the space that follows it, so the menu
   * does not reopen on it. Returns `false`, having inserted nothing, when a
   * held pick's trigger has changed or the pick was abandoned.
   */
  insertCommandText: (text: string) => boolean;
  insertFile: (file: FileMentionOption, repoCount: number) => void;
  /**
   * Insert a non-file mention pill (a whole plugin, for example) at the
   * trigger, the way `insertFile` inserts a file pill. `displayPath` is the
   * user-facing name and becomes the pill's display token in the serialized
   * text; `absolutePath` and `kind` are the host's opaque locator.
   */
  insertPill: (pill: {
    displayPath: string;
    absolutePath: string;
    kind: string;
  }) => void;
}

export interface UseComposerMenuOptions {
  enabled: boolean;
  /** Whether `/` opens the commands menu; a host without commands turns it off. */
  slash?: boolean;
  /** Whether `@` opens the Add menu; a host that cannot mention files turns it off. */
  at?: boolean;
  /** Codex's `$` opens the commands menu like `/`. */
  dollar: boolean;
  /** A new scope closes the session and forgets a dismissed trigger. */
  scopeKey: string;
  /** Publishes an editor change the controller made (insertions, query edits). */
  onChange: () => void;
  /**
   * The display path written into a picked file's pill. Defaults to the
   * file's repository-relative path.
   */
  buildFileDisplayPath?: (file: FileMentionOption, repoCount: number) => string;
}

const relativeFileDisplayPath = (file: FileMentionOption): string =>
  file.relativePath;

/** One composer-owned dialog session for /, @, $, and the toolbar trigger. */
export function useComposerMenu(
  editor: ChatEditor,
  {
    enabled,
    slash = true,
    at = true,
    dollar,
    scopeKey,
    onChange,
    buildFileDisplayPath = relativeFileDisplayPath,
  }: UseComposerMenuOptions,
): ComposerMenuController {
  const [open, setOpen] = useState(false);
  const [variant, setVariant] = useState<'add' | 'commands'>('add');
  const [query, updateQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const trigger = useRef<RangeRef | null>(null);
  /**
   * The editor's document generation when `trigger` was taken. A replaced
   * document (`resetEditor`, `restoreEditorContent`) does not move range
   * refs, so a trigger from an earlier generation points into another draft.
   */
  const triggerGeneration = useRef(0);
  /** The trigger of a held pick, while it is held. */
  const picked = useRef<PickedTrigger | null>(null);
  /** The current hold's identity; a stale release does nothing. */
  const hold = useRef<symbol | null>(null);
  /** Where the person was typing when a held pick was inserted elsewhere. */
  const caretAfterPick = useRef<RangeRef | null>(null);
  /**
   * The person dismissed a held pick before it settled: its late insertion
   * must insert nothing. Cleared when the next session opens, since every
   * insertion comes from an open session.
   */
  const abandonedPick = useRef(false);
  const hoveredIdRef = useRef<string | null>(null);
  /**
   * Whether the session is showing no highlight because it had no enabled
   * row to give one to (rows still loading, or a re-projection that briefly
   * emptied the list), as opposed to the pointer clearing it. Only the former
   * is restored when rows arrive.
   */
  const lostHighlight = useRef(false);
  /** Mirror of `activeId` for the row observer, which must not update state from inside an updater. */
  const activeIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  const dismissed = useRef<string | null>(null);
  const fromEditor = useRef(false);
  const selecting = useRef(false);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const children = editor.children;
  const selection = editor.selection;
  // Slate keeps the editor identity stable while replacing these snapshots,
  // so the scan reads (and re-runs on) the snapshots themselves.
  const match = useMemo(
    () =>
      enabled
        ? findTrigger(editor, slash, at, dollar, children, selection)
        : null,
    [editor, enabled, slash, at, dollar, children, selection],
  );
  const signature = match ? JSON.stringify(match) : null;
  const signatureRef = useRef(signature);
  signatureRef.current = signature;

  const toolbarRange =
    open && !fromEditor.current ? trigger.current?.current : null;
  const toolbarQuery = toolbarRange ? readRange(editor, toolbarRange) : '';

  // Resolve typed triggers before paint, rather than opening one frame later.
  useLayoutEffect(() => {
    try {
      editorRef.current = ReactEditor.toDOMNode(editor, editor);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes('Cannot resolve a DOM node from Slate node')
      )
        throw error;
      editorRef.current = null;
      return;
    }
    // A held pick freezes the session until it settles.
    if (hold.current) return;
    if (!signature) dismissed.current = null;
    if (!enabled || !editorRef.current.contains(document.activeElement)) return;
    if (selecting.current) {
      if (open || !match || dismissed.current === signature) return;
      selecting.current = false;
    }
    if (open && !fromEditor.current) {
      updateQuery(toolbarQuery);
      return;
    }
    if (!match) {
      if (open) setOpen(false);
      return;
    }
    if (!open && dismissed.current === signature) return;
    trigger.current?.unref();
    trigger.current = Editor.rangeRef(editor, match.range, {
      affinity: 'inward',
    });
    triggerGeneration.current = editorDocumentGeneration(editor);
    fromEditor.current = true;
    abandonedPick.current = false;
    updateQuery(match.query);
    setVariant(match.variant);
    setOpen(true);
  }, [editor, enabled, signature, match, open, toolbarQuery]);

  useLayoutEffect(() => {
    const first = open
      ? (menuRef.current?.querySelector<HTMLButtonElement>(
          '[data-action-row]:not(:disabled)',
        )?.id ?? null)
      : null;
    // An open session with nothing to highlight yet (rows still loading) is
    // waiting for a row, not cleared by the pointer.
    lostHighlight.current = open && first === null;
    activeIdRef.current = first;
    setActiveId(first);
  }, [query, open, variant]);
  useEffect(() => {
    const element = editorRef.current;
    if (!element) return;
    if (open && menuRef.current)
      element.setAttribute('aria-controls', menuRef.current.id);
    else element.removeAttribute('aria-controls');
    if (open && activeId)
      element.setAttribute('aria-activedescendant', activeId);
    else element.removeAttribute('aria-activedescendant');
    return (): void => {
      element.removeAttribute('aria-activedescendant');
      element.removeAttribute('aria-controls');
    };
  }, [open, activeId]);

  // Rows can change while the session stays open: a harness switch
  // re-projects the catalog (often through a momentarily empty list while
  // the next inventory loads), discovery finishes, an inventory broadcast
  // lands. A keyboard highlight that named a row which is no longer listed
  // (or is now disabled) moves to the first enabled row, and a highlight the
  // session lost for want of rows is restored once a row exists, so
  // `aria-activedescendant` never points at a node that is gone and one row
  // stays highlighted. A highlight the pointer cleared is left alone.
  // Resolved here, not in a state updater: updaters must stay pure, and a
  // same-value update would still re-render the composer once per batch.
  const syncActiveRow = useCallback((reset: boolean): void => {
    const menu = menuRef.current;
    if (!menu) return;
    const current = activeIdRef.current;
    // A reset (new query, variant or session) starts on the first enabled row.
    if (!reset && current !== null) {
      const row = menu.ownerDocument.getElementById(current);
      if (
        row &&
        menu.contains(row) &&
        row.matches('[data-action-row]:not(:disabled)')
      )
        return;
    } else if (!reset && !lostHighlight.current) {
      return;
    }
    const first =
      menu.querySelector<HTMLButtonElement>('[data-action-row]:not(:disabled)')
        ?.id ?? null;
    lostHighlight.current = first === null;
    if (first === current) return;
    activeIdRef.current = first;
    setActiveId(first);
  }, []);
  useEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver((): void => syncActiveRow(false));
    observer.observe(menu, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'id'],
    });
    return (): void => observer.disconnect();
  }, [open, syncActiveRow]);

  /** Forgets a held pick: its trigger and the caret it would restore. */
  const dropHold = useCallback((): void => {
    hold.current = null;
    picked.current?.range.unref();
    picked.current = null;
    caretAfterPick.current?.unref();
    caretAfterPick.current = null;
  }, []);

  useEffect(() => {
    // A new scope ends a held pick: its late insertion inserts nothing.
    if (hold.current) abandonedPick.current = true;
    dropHold();
    setOpen(false);
    dismissed.current = signatureRef.current;
    fromEditor.current = false;
    selecting.current = false;
    trigger.current?.unref();
    trigger.current = null;
    return (): void => {
      dropHold();
      trigger.current?.unref();
      trigger.current = null;
    };
  }, [scopeKey, enabled, dropHold]);

  /**
   * The draft the session's trigger belongs to was replaced: the session
   * ends. Its trigger is forgotten, the menu closes on the current draft
   * (dismissed, so it does not reopen there), and picks insert nothing until
   * a new trigger opens a session.
   */
  const endStaleSession = useCallback((): void => {
    trigger.current?.unref();
    trigger.current = null;
    abandonedPick.current = true;
    selecting.current = false;
    fromEditor.current = false;
    dismissed.current = signatureRef.current;
    setOpen(false);
  }, []);

  const consumeTrigger = useCallback((): boolean => {
    if (abandonedPick.current) return false;
    selecting.current = true;
    const pick = picked.current;
    if (pick) {
      picked.current = null;
      const range = pick.range.unref();
      if (editorDocumentGeneration(editor) !== pick.generation) {
        endStaleSession();
        return false;
      }
      if (!range || !isPickIntact(editor, range, pick)) return false;
      trigger.current?.unref();
      trigger.current = null;
      // The person kept typing elsewhere: return the caret there once the
      // insertion lands (`holdSelection`'s release).
      const caret = editor.selection;
      caretAfterPick.current?.unref();
      caretAfterPick.current =
        caret && !Point.equals(Range.end(caret), Range.end(range))
          ? Editor.rangeRef(editor, caret)
          : null;
      Transforms.select(editor, range);
      if (!Range.isCollapsed(range)) Transforms.delete(editor);
      return true;
    }
    const range = trigger.current?.unref();
    trigger.current = null;
    if (range) {
      if (editorDocumentGeneration(editor) !== triggerGeneration.current) {
        endStaleSession();
        return false;
      }
      try {
        Transforms.select(editor, range);
        if (!Range.isCollapsed(range)) Transforms.delete(editor);
      } catch {
        // The trigger's paths no longer resolve in this draft.
        endStaleSession();
        return false;
      }
    } else if (!editor.selection) {
      Transforms.select(editor, Editor.end(editor, []));
    }
    return true;
  }, [editor, endStaleSession]);

  const onOpenChange = useCallback(
    (next: boolean): void => {
      if (hold.current) {
        // The + cannot start another session over a held pick; dismissing
        // the menu (Escape, a press outside) abandons the pick.
        if (next) return;
        dropHold();
        abandonedPick.current = true;
        selecting.current = false;
      }
      if (next) {
        setVariant('add');
        fromEditor.current = false;
        abandonedPick.current = false;
        selecting.current = false;
        trigger.current?.unref();
        if (!editor.selection)
          Transforms.select(editor, Editor.end(editor, []));
        if (editor.selection) Transforms.collapse(editor, { edge: 'end' });
        if (editor.selection) {
          trigger.current = Editor.rangeRef(editor, editor.selection, {
            affinity: 'outward',
          });
          triggerGeneration.current = editorDocumentGeneration(editor);
        }
        updateQuery('');
        requestAnimationFrame(() => focusEditor(editor));
      } else {
        dismissed.current = signatureRef.current;
        if (!selecting.current) {
          trigger.current?.unref();
          trigger.current = null;
        }
      }
      setOpen(next);
    },
    [editor, dropHold],
  );

  const beginSelection = useCallback((): void => {
    selecting.current = true;
    const range = trigger.current?.unref();
    trigger.current = range
      ? Editor.rangeRef(editor, range, { affinity: 'inward' })
      : null;
  }, [editor]);

  const holdSelection = useCallback((): (() => void) => {
    dropHold();
    abandonedPick.current = false;
    // A trigger from a replaced draft is not held: `consumeTrigger` then
    // ends its session instead of inserting.
    const range =
      editorDocumentGeneration(editor) === triggerGeneration.current
        ? (trigger.current?.current ?? null)
        : null;
    picked.current = null;
    if (range) {
      try {
        const text = Editor.string(editor, range);
        const before = characterBefore(editor, Range.start(range));
        const after = characterAfter(editor, Range.end(range));
        picked.current = {
          range: Editor.rangeRef(editor, range, { affinity: 'inward' }),
          text,
          before,
          after,
          generation: triggerGeneration.current,
        };
      } catch {
        // The trigger's paths no longer resolve: nothing is held.
      }
    }
    const generation = editorDocumentGeneration(editor);
    const token = Symbol('composer-menu-hold');
    hold.current = token;
    return (): void => {
      if (hold.current !== token) return;
      const caret = caretAfterPick.current?.current ?? null;
      dropHold();
      // A replaced draft has no caret of the person's to go back to.
      if (caret && editorDocumentGeneration(editor) === generation) {
        try {
          Transforms.select(editor, caret);
        } catch {
          // The caret's paths no longer resolve: leave the selection.
        }
      }
      // The session follows the draft again from the next edit: a settled
      // failure stays on screen until then.
      selecting.current = false;
    };
  }, [editor, dropHold]);

  const setQuery = useCallback(
    (next: string): void => {
      const range = trigger.current?.current;
      if (!range) return;
      if (editorDocumentGeneration(editor) !== triggerGeneration.current) {
        endStaleSession();
        return;
      }
      try {
        const start = fromEditor.current
          ? Editor.after(editor, Range.start(range))
          : Range.start(range);
        if (!start) return;
        Transforms.select(editor, { anchor: start, focus: Range.end(range) });
        Transforms.insertText(editor, next);
      } catch {
        // The trigger's paths no longer resolve in this draft.
        endStaleSession();
        return;
      }
      updateQuery(next);
      changeRef.current();
      requestAnimationFrame(() => focusEditor(editor));
    },
    [editor, endStaleSession],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): boolean => {
      if (!open || event.nativeEvent.isComposing) return false;
      if (hold.current && event.key !== 'Escape') {
        // While a pick is held, Enter neither sends the draft nor picks again,
        // and the menu keeps its rows and stays open. Escape abandons the pick
        // (below); Shift+Enter, Tab and typing keep their usual meaning.
        if (
          (event.key === 'Enter' && !event.shiftKey) ||
          ['ArrowUp', 'ArrowDown'].includes(event.key)
        ) {
          event.preventDefault();
          return true;
        }
        return false;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onOpenChange(false);
        return true;
      }
      const buttons = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          '[data-action-row]:not(:disabled)',
        ) ?? [],
      );
      /** Activates the keyboard highlight, else the hovered row, else the first. */
      const activateRow = (rows: HTMLButtonElement[]): true => {
        event.preventDefault();
        (
          rows.find((button) => button.id === activeId) ??
          rows.find((button) => button.id === hoveredIdRef.current) ??
          rows[0]
        )?.click();
        return true;
      };
      if (event.key === 'Tab') {
        // Plain Tab completes a typed `/`, `@`, or `$` suggestion like Enter,
        // but only suggestion rows: never an action that opens a picker or
        // dialog (Files and folders, Plugins, Linear). Shift+Tab, chords, a +
        // menu session, and a list without suggestions keep Tab as focus
        // navigation so keyboard users can leave the composer.
        const suggestions = buttons.filter((button) =>
          button.hasAttribute('data-completion-row'),
        );
        // Tab never activates Show all, and is consumed on it so the open
        // menu stays put instead of completing a different row.
        const highlighted =
          buttons.find((button) => button.id === activeId) ??
          buttons.find((button) => button.id === hoveredIdRef.current);
        if (
          fromEditor.current &&
          highlighted?.hasAttribute('data-show-all-row')
        ) {
          event.preventDefault();
          return true;
        }
        if (
          fromEditor.current &&
          suggestions.length > 0 &&
          !event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        )
          return activateRow(suggestions);
        onOpenChange(false);
        return false;
      }
      if (
        !buttons.length &&
        ['Enter', 'ArrowUp', 'ArrowDown'].includes(event.key)
      ) {
        onOpenChange(false);
        return false;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const current = buttons.findIndex((button) => button.id === activeId);
        const index =
          current < 0
            ? event.key === 'ArrowDown'
              ? 0
              : buttons.length - 1
            : (current +
                (event.key === 'ArrowDown' ? 1 : -1) +
                buttons.length) %
              buttons.length;
        const button = buttons[index];
        setActiveId(button.id);
        button.scrollIntoView({ block: 'nearest' });
        return true;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.metaKey)
        return activateRow(buttons);
      return false;
    },
    [open, activeId, onOpenChange],
  );

  const setHoveredId = useCallback((id: string | null): void => {
    hoveredIdRef.current = id;
  }, []);
  /** A host-driven highlight change (keyboard or pointer) is never "lost". */
  const setActiveIdExplicit = useCallback((id: string | null): void => {
    lostHighlight.current = false;
    activeIdRef.current = id;
    setActiveId(id);
  }, []);

  const prepareAction = useCallback((): void => {
    consumeTrigger();
    changeRef.current();
  }, [consumeTrigger]);

  const insertCommandText = useCallback(
    (text: string): boolean => {
      if (!consumeTrigger()) return false;
      const point = editor.selection ? Range.start(editor.selection) : null;
      const before = point
        ? Editor.before(editor, point, { unit: 'character' })
        : null;
      const after = point
        ? Editor.after(editor, point, { unit: 'character' })
        : null;
      const previous =
        before && point
          ? Editor.string(editor, { anchor: before, focus: point })
          : '';
      const next =
        point && after
          ? Editor.string(editor, { anchor: point, focus: after })
          : '';
      const leading =
        previous !== '' && !/\s/.test(previous) && !/^\s/.test(text) ? ' ' : '';
      const trailing =
        next !== '' && !/\s/.test(next) && !/\s$/.test(text) ? ' ' : '';
      // Whitespace already follows: the token's own trailing space would
      // double it, so the caret steps over that whitespace instead. Left on
      // the token, it would read as a fresh trigger and reopen the menu.
      const spaced = /\s/.test(next);
      const body = spaced ? text.replace(/\s+$/u, '') : text;
      Transforms.insertText(editor, `${leading}${body}${trailing}`);
      if (spaced) Transforms.move(editor, { distance: 1, unit: 'character' });
      changeRef.current();
      requestAnimationFrame(() => focusEditor(editor));
      return true;
    },
    [editor, consumeTrigger],
  );

  const insertFile = useCallback(
    (file: FileMentionOption, repoCount: number): void => {
      if (!consumeTrigger()) return;
      const node: FileReferenceElement = {
        type: 'file-reference',
        displayPath: buildFileDisplayPath(file, repoCount),
        absolutePath: file.absolutePath,
        ...(repoCount > 1 && file.repoName ? { repoName: file.repoName } : {}),
        ...(file.kind !== undefined ? { kind: file.kind } : {}),
        children: [{ text: '' }],
      };
      Transforms.insertNodes(editor, node);
      Transforms.move(editor);
      Transforms.insertText(editor, ' ');
      changeRef.current();
      requestAnimationFrame(() => focusEditor(editor));
    },
    [editor, consumeTrigger, buildFileDisplayPath],
  );

  const insertPill = useCallback(
    (pill: {
      displayPath: string;
      absolutePath: string;
      kind: string;
    }): void => {
      if (!consumeTrigger()) return;
      // The pill's label is inlined verbatim into the sent text, and the
      // transcript chip only matches it at a word boundary, so keep a space
      // between preceding text and the label (`tools @x`, never `toolsx`).
      const start = editor.selection ? Range.start(editor.selection) : null;
      const before = start
        ? Editor.before(editor, start, { unit: 'character' })
        : null;
      const previous =
        before && start
          ? Editor.string(editor, { anchor: before, focus: start })
          : '';
      if (previous !== '' && !/\s/.test(previous)) {
        Transforms.insertText(editor, ' ');
      }
      const node: FileReferenceElement = {
        type: 'file-reference',
        displayPath: pill.displayPath,
        absolutePath: pill.absolutePath,
        kind: pill.kind,
        children: [{ text: '' }],
      };
      Transforms.insertNodes(editor, node);
      Transforms.move(editor);
      Transforms.insertText(editor, ' ');
      changeRef.current();
      requestAnimationFrame(() => focusEditor(editor));
    },
    [editor, consumeTrigger],
  );

  // One controller per session state, so a host that publishes it (see
  // `ComposerMenuChannel`) re-renders its menu only when the session
  // changes, never for a keystroke that leaves the session as it was.
  const origin = fromEditor.current ? 'editor' : 'toolbar';
  return useMemo(
    (): ComposerMenuController => ({
      open,
      variant,
      origin,
      query,
      setQuery,
      onOpenChange,
      consumeTrigger,
      beginSelection,
      holdSelection,
      anchorRef,
      menuRef,
      editorRef,
      activeId,
      setActiveId: setActiveIdExplicit,
      setHoveredId,
      syncActiveRow,
      handleKeyDown,
      prepareAction,
      insertCommandText,
      insertFile,
      insertPill,
    }),
    [
      open,
      variant,
      origin,
      query,
      setQuery,
      onOpenChange,
      consumeTrigger,
      beginSelection,
      holdSelection,
      activeId,
      setActiveIdExplicit,
      setHoveredId,
      syncActiveRow,
      handleKeyDown,
      prepareAction,
      insertCommandText,
      insertFile,
      insertPill,
    ],
  );
}
