'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { isFocusReturnTarget } from '../lib/focusable';
import {
  copyTextToClipboard,
  DEFAULT_COPIED_DURATION_MS,
} from './copy-to-clipboard';
import { DropdownMenuStatusRow } from './DropdownMenu';
import { RichHoverCard } from './RichHoverTooltip';
import { ErrorBanner } from './StatusBlocks';
import { selectionTextWithMathSource } from './markdown-math-copy';
import { TabContextMenu, type TabContextMenuItem } from './TabContextMenu';
import { CopyIcon, GlobeIcon, LinkIcon } from '../icons/AppIcons';

/**
 * Writes the copied text through the clipboard of `ownerDocument`'s window.
 * Resolves to whether the write succeeded; a rejection counts as a failure.
 */
export type ChatMessageClipboardWriter = (
  text: string,
  ownerDocument: Document,
) => Promise<boolean>;

/** Props a host spreads onto the element that represents one message. */
export interface ChatMessageContextMenuTargetProps {
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  tabIndex?: 0;
}

const MessageMenuEnabledContext = createContext(true);

/**
 * Host actions for a link under the message menu (CAN-2632). Each item shows
 * only when its host supplies the action; Copy link needs none.
 */
export interface ChatMessageLinkActions {
  /** Opens the link in the message's worktree built-in browser. */
  openInBrowser?: (url: string) => void;
  /** Opens the link in the OS default browser. */
  openExternal?: (url: string) => void;
}

/**
 * Set by a non-anchor element to declare the http(s) URL it opens, so the
 * message menu offers the link section there too (CAN-2632).
 */
export const CHAT_MESSAGE_LINK_URL_ATTRIBUTE = 'data-link-url';

/** Props a generated reference spreads once its URL is known; `{}` until then. */
export function chatMessageLinkUrlProps(url: string | null | undefined): {
  readonly 'data-link-url'?: string;
} {
  return url ? { [CHAT_MESSAGE_LINK_URL_ATTRIBUTE]: url } : {};
}

const NO_LINK_ACTIONS: ChatMessageLinkActions = {};

const ChatMessageLinkActionsContext =
  createContext<ChatMessageLinkActions>(NO_LINK_ACTIONS);

/** Supplies the link actions a host can perform to every message menu below. */
export function ChatMessageLinkActionsProvider({
  value,
  children,
}: {
  value: ChatMessageLinkActions;
  children?: ReactNode;
}): JSX.Element {
  return (
    <ChatMessageLinkActionsContext.Provider value={value}>
      {children}
    </ChatMessageLinkActionsContext.Provider>
  );
}

/** Keep read-only transcript viewers outside the live-chat message menu. */
export function ChatMessageContextMenuScope({
  enabled,
  children,
}: {
  enabled: boolean;
  children?: ReactNode;
}): JSX.Element {
  return (
    <MessageMenuEnabledContext.Provider value={enabled}>
      {children}
    </MessageMenuEnabledContext.Provider>
  );
}

export interface UseChatMessageContextMenuOptions {
  /** The message's identity. An open menu belongs to this id only. */
  messageId: string;
  /** Clipboard writer; defaults to {@link copyTextToClipboard}. */
  writeText?: ChatMessageClipboardWriter;
  /**
   * Whether the row becomes a Tab stop for the keyboard menu, which reaches
   * Copy selection and the link actions. Hosts pass `false` for rows with no
   * message text, so long transcripts do not gain stops with nothing to
   * select. Right-click still opens the menu there. Defaults to `true`.
   */
  focusable?: boolean;
}

export interface UseChatMessageContextMenuResult {
  /** Spread onto the message element (and give it a focus target). */
  targetProps: ChatMessageContextMenuTargetProps | undefined;
  /**
   * The open menu or copy status (`Copied` or the failure), portaled into the
   * message's own document. `null` while closed, so a closed row renders
   * nothing extra.
   */
  menu: JSX.Element | null;
}

/**
 * Descendants that own their own context menu: form fields, the terminal,
 * Monaco, and any control that opts out with `data-owns-context-menu`.
 * Editable regions are checked separately, since `contenteditable` inherits.
 */
const CONTEXT_MENU_OWNER_SELECTOR =
  'input, textarea, select, .xterm, .monaco-editor, [data-owns-context-menu]';

/** Whether `element` sits in an effectively editable region. */
function isInEditableRegion(element: Element): boolean {
  if (
    'isContentEditable' in element &&
    typeof element.isContentEditable === 'boolean'
  ) {
    return element.isContentEditable;
  }
  // jsdom and detached trees do not compute `isContentEditable`; resolve the
  // nearest explicit state, skipping `inherit`, the same way the browser does.
  let host = element.closest('[contenteditable]');
  while (host) {
    const state = host.getAttribute('contenteditable')?.toLowerCase();
    if (state === 'false') return false;
    if (state === '' || state === 'true' || state === 'plaintext-only') {
      return true;
    }
    host = host.parentElement?.closest('[contenteditable]') ?? null;
  }
  return false;
}

/**
 * Whether the event's target, inside the message element, owns its own
 * context menu (and keyboard menu shortcut), so the message menu must yield.
 */
export function chatMessageContextMenuTargetOwnsMenu(
  target: EventTarget | null,
  ownerDocument: Document,
): boolean {
  const view = ownerDocument.defaultView;
  if (!view || !(target instanceof view.Element)) return false;
  return (
    target.closest(CONTEXT_MENU_OWNER_SELECTOR) !== null ||
    isInEditableRegion(target)
  );
}

/** The normalized `value` when it is an absolute http(s) URL, else `null`. */
function httpUrlOrNull(value: string | null): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:'
    ? url.href
    : null;
}

/**
 * The resolved http(s) URL under `target` inside `messageElement`: the
 * anchor's href, or the URL a non-anchor element declares with
 * {@link CHAT_MESSAGE_LINK_URL_ATTRIBUTE}. `null` for any other target,
 * including `mailto:` and relative-scheme links the browser cannot open. The
 * nearest anchor wins over a declaration, even when it is not http(s).
 */
function linkUrlAt(
  target: EventTarget | null,
  messageElement: HTMLElement,
): string | null {
  const view = messageElement.ownerDocument.defaultView;
  if (!view || !(target instanceof view.Element)) return null;
  const anchor = target.closest('a[href]');
  if (
    anchor instanceof view.HTMLAnchorElement &&
    messageElement.contains(anchor)
  ) {
    return anchor.protocol === 'http:' || anchor.protocol === 'https:'
      ? anchor.href
      : null;
  }
  const declared = target.closest(`[${CHAT_MESSAGE_LINK_URL_ATTRIBUTE}]`);
  if (!declared || !messageElement.contains(declared)) return null;
  return httpUrlOrNull(declared.getAttribute(CHAT_MESSAGE_LINK_URL_ATTRIBUTE));
}

/**
 * The open message menu in each document. Opening a menu on another message
 * closes the previous one, so a document never shows two.
 */
const openMenuByDocument = new WeakMap<Document, OpenMenuToken>();

interface OpenMenuToken {
  readonly close: () => void;
}

interface OpenMenuState {
  readonly token: OpenMenuToken;
  readonly messageId: string;
  readonly ownerDocument: Document;
  readonly x: number;
  readonly y: number;
  /** The selection when the menu opened; empty when there was none. */
  readonly selection: string;
  /** The http(s) link the menu opened on, resolved; `null` elsewhere. */
  readonly linkUrl: string | null;
  /** Focus goes back here when the menu closes from inside. */
  readonly returnFocusTo: Element | null;
}

/** The outcome of the latest copy, shown where its menu was. */
interface CopyFeedbackState {
  readonly kind: 'copied' | 'failed';
  /** The copy it reports; a repeat copy gets a fresh status. */
  readonly operation: number;
  readonly ownerDocument: Document;
  readonly x: number;
  readonly y: number;
}

/** The selection's text, with each rendered formula as its TeX source. */
function capturedSelection(ownerDocument: Document): string {
  const selection = ownerDocument.getSelection();
  if (!selection || selection.isCollapsed) return '';
  return selectionTextWithMathSource(selection);
}

function isKeyboardMenuShortcut(event: KeyboardEvent<HTMLElement>): boolean {
  return (
    event.key === 'ContextMenu' ||
    (event.key === 'F10' && event.shiftKey && !event.altKey && !event.ctrlKey)
  );
}

/** A keyboard-opened menu anchors to the message's visible top-left. */
function anchorPoint(element: HTMLElement): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  const view = element.ownerDocument.defaultView;
  const height = view?.innerHeight ?? rect.bottom;
  return {
    x: Math.max(0, rect.left),
    y: Math.min(Math.max(0, rect.top), Math.max(0, height)),
  };
}

/**
 * The right-click menu for one chat message (CAN-4277): Copy selection, which
 * copies the plain-text selection captured when the menu opened and is
 * disabled when there was none (CAN-4870). Whole-message copies live in the
 * row's footer, not here. On an http(s) link, or an element that declares one with
 * {@link CHAT_MESSAGE_LINK_URL_ATTRIBUTE}, it first lists Copy link and the
 * open actions from {@link ChatMessageLinkActionsProvider} (CAN-2632). Hosts call it
 * unconditionally in the row, spread `targetProps` onto the message element,
 * and render `menu`.
 *
 * The menu yields to an already-handled event, a touch long-press, and to
 * descendants that own a context menu (fields, editable regions, the
 * terminal, Monaco). It opens from the pointer, or from the Menu key or
 * Shift+F10 at the message's top-left, in the message's own document, so a
 * pulled-out window reads its own selection and clipboard.
 */
export function useChatMessageContextMenu({
  messageId,
  writeText = copyTextToClipboard,
  focusable = true,
}: UseChatMessageContextMenuOptions): UseChatMessageContextMenuResult {
  const enabled = useContext(MessageMenuEnabledContext);
  const [openMenu, setOpenMenu] = useState<OpenMenuState | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedbackState | null>(
    null,
  );
  // Counts copies. A write that settles after a newer copy, a new menu, an
  // identity change or unmount reports nothing, so a stale result never
  // replaces newer feedback or lands on another message.
  const copyOperationRef = useRef(0);

  // A virtualized row can change identity and later reuse an earlier id.
  // Discard its open state, rather than merely hiding the old portal.
  useEffect((): void => {
    setOpenMenu((current) =>
      !enabled || (current && current.messageId !== messageId) ? null : current,
    );
    copyOperationRef.current += 1;
    setCopyFeedback(null);
  }, [messageId, enabled]);

  useEffect(
    (): (() => void) => (): void => {
      copyOperationRef.current += 1;
    },
    [],
  );

  const open = useCallback(
    (
      element: HTMLElement,
      point: { x: number; y: number },
      target: EventTarget | null,
    ): void => {
      const ownerDocument = element.ownerDocument;
      const token: OpenMenuToken = {
        close: (): void => {
          setOpenMenu((current) => (current?.token === token ? null : current));
        },
      };
      openMenuByDocument.get(ownerDocument)?.close();
      openMenuByDocument.set(ownerDocument, token);
      copyOperationRef.current += 1;
      setCopyFeedback(null);
      setOpenMenu({
        token,
        messageId,
        ownerDocument,
        x: point.x,
        y: point.y,
        selection: capturedSelection(ownerDocument),
        linkUrl: linkUrlAt(target, element),
        returnFocusTo: ownerDocument.activeElement,
      });
    },
    [messageId],
  );

  const onContextMenu = useCallback(
    (event: MouseEvent<HTMLElement>): void => {
      if (event.defaultPrevented) return;
      const native = event.nativeEvent;
      // Touch long-press keeps the platform's own selection behavior.
      if ('pointerType' in native && native.pointerType === 'touch') return;
      const element = event.currentTarget;
      if (
        chatMessageContextMenuTargetOwnsMenu(
          event.target,
          element.ownerDocument,
        )
      ) {
        return;
      }
      event.preventDefault();
      // A keyboard-generated contextmenu event carries no pointer position.
      const fromKeyboard = event.clientX === 0 && event.clientY === 0;
      open(
        element,
        fromKeyboard
          ? anchorPoint(element)
          : { x: event.clientX, y: event.clientY },
        fromKeyboard ? element.ownerDocument.activeElement : event.target,
      );
    },
    [open],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): void => {
      if (event.defaultPrevented || !isKeyboardMenuShortcut(event)) return;
      const element = event.currentTarget;
      if (
        chatMessageContextMenuTargetOwnsMenu(
          event.target,
          element.ownerDocument,
        )
      ) {
        return;
      }
      event.preventDefault();
      open(element, anchorPoint(element), element.ownerDocument.activeElement);
    },
    [open],
  );

  // Drop this row's registration once its menu closes or the row unmounts.
  useEffect((): (() => void) | undefined => {
    if (!openMenu) return undefined;
    const { ownerDocument, token } = openMenu;
    return (): void => {
      if (openMenuByDocument.get(ownerDocument) === token) {
        openMenuByDocument.delete(ownerDocument);
      }
    };
  }, [openMenu]);

  const closeMenu = useCallback((): void => {
    if (!openMenu) return;
    const { ownerDocument, returnFocusTo } = openMenu;
    const active = ownerDocument.activeElement;
    // Return focus only when it was inside the menu (or dropped to the body);
    // an outside click keeps the focus it moves to.
    const focusInMenu =
      active === null ||
      active === ownerDocument.body ||
      active.closest('[data-testid="chat-message-context-menu"]') !== null;
    setOpenMenu(null);
    if (
      focusInMenu &&
      isFocusReturnTarget(returnFocusTo) &&
      returnFocusTo.isConnected
    ) {
      returnFocusTo.focus({ preventScroll: true });
    }
  }, [openMenu]);

  const copy = useCallback(
    (text: string, state: OpenMenuState): void => {
      // An empty result would only erase what the clipboard already holds.
      if (text.length === 0) return;
      copyOperationRef.current += 1;
      const operation = copyOperationRef.current;
      // A new copy clears the previous one's outcome; success and failure
      // never show together.
      setCopyFeedback(null);
      const settle = (kind: CopyFeedbackState['kind']): void => {
        if (operation !== copyOperationRef.current) return;
        setCopyFeedback({
          kind,
          operation,
          ownerDocument: state.ownerDocument,
          x: state.x,
          y: state.y,
        });
      };
      let write: Promise<boolean>;
      try {
        write = writeText(text, state.ownerDocument);
      } catch {
        settle('failed');
        return;
      }
      write.then(
        (copied) => settle(copied ? 'copied' : 'failed'),
        () => settle('failed'),
      );
    },
    [writeText],
  );

  const dismissCopyFeedback = useCallback((): void => {
    setCopyFeedback(null);
  }, []);

  const targetProps = useMemo(
    (): ChatMessageContextMenuTargetProps | undefined =>
      enabled
        ? { onContextMenu, onKeyDown, ...(focusable ? { tabIndex: 0 } : {}) }
        : undefined,
    [enabled, focusable, onContextMenu, onKeyDown],
  );

  let menu: JSX.Element | null = null;
  if (enabled && openMenu && openMenu.messageId === messageId) {
    menu = (
      <ChatMessageContextMenu
        state={openMenu}
        onCopy={copy}
        onClose={closeMenu}
      />
    );
  } else if (enabled && copyFeedback) {
    menu = (
      <ChatMessageCopyStatus
        key={copyFeedback.operation}
        feedback={copyFeedback}
        onDismiss={dismissCopyFeedback}
      />
    );
  }
  return { targetProps, menu };
}

function stopPropagation(event: SyntheticEvent): void {
  event.stopPropagation();
}

export function ChatMessageContextMenu({
  state,
  onCopy,
  onClose,
}: {
  state: OpenMenuState;
  onCopy: (text: string, state: OpenMenuState) => void;
  onClose: () => void;
}): JSX.Element | null {
  const linkActions = useContext(ChatMessageLinkActionsContext);

  const items = useMemo((): TabContextMenuItem[] => {
    const { linkUrl } = state;
    const linkItems: TabContextMenuItem[] = [];
    if (linkUrl !== null) {
      const { openInBrowser, openExternal } = linkActions;
      linkItems.push({
        key: 'copy-link',
        label: 'Copy link',
        icon: <LinkIcon />,
        testId: 'chat-message-copy-link',
        onSelect: (): void => onCopy(linkUrl, state),
      });
      if (openInBrowser) {
        linkItems.push({
          key: 'open-in-browser',
          label: 'Open in browser',
          icon: <GlobeIcon />,
          testId: 'chat-message-open-link-in-browser',
          onSelect: (): void => openInBrowser(linkUrl),
        });
      }
      if (openExternal) {
        linkItems.push({
          key: 'open-external',
          label: 'Open in external browser',
          icon: <GlobeIcon />,
          testId: 'chat-message-open-link-external',
          onSelect: (): void => openExternal(linkUrl),
        });
      }
    }
    // Copy selection is always listed, so its place never shifts; it copies
    // the selection captured as the menu opened and is disabled without one.
    const copySelection: TabContextMenuItem = {
      key: 'copy-selection',
      label: 'Copy selection',
      icon: <CopyIcon />,
      testId: 'chat-message-copy-selection',
      disabled: state.selection.length === 0,
      onSelect: (): void => onCopy(state.selection, state),
    };
    return [
      ...linkItems,
      linkItems.length > 0
        ? { ...copySelection, separatorBefore: true }
        : copySelection,
    ];
  }, [linkActions, onCopy, state]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>): void => {
      // Stopping propagation also keeps the key from the menu's own document
      // listener, so Escape is handled here.
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Tab') {
        onClose();
      }
    },
    [onClose],
  );

  // With no enabled item, focus stays outside the menu, where a trigger can
  // consume Escape itself (a hover card's dismissal does). The open menu is
  // the topmost layer, so it takes Escape first there.
  useEffect((): (() => void) => {
    const { ownerDocument } = state;
    const handleEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      const active = ownerDocument.activeElement;
      if (active?.closest('[data-testid="chat-message-context-menu"]')) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    ownerDocument.addEventListener('keydown', handleEscape, true);
    return (): void => {
      ownerDocument.removeEventListener('keydown', handleEscape, true);
    };
  }, [state, onClose]);

  // The boundary keeps the menu's React events (clicks, keys, context menus)
  // from bubbling into the message row or transcript that rendered it. The
  // menu portals itself, but React bubbles its events through this tree; the
  // span is hidden and holds none of the menu's nodes.
  return (
    <span
      hidden
      data-chat-message-context-menu-boundary=""
      onClick={stopPropagation}
      onMouseDown={stopPropagation}
      onContextMenu={stopPropagation}
      onKeyDown={handleKeyDown}
    >
      <TabContextMenu
        x={state.x}
        y={state.y}
        items={items}
        onClose={onClose}
        ownerDocument={state.ownerDocument}
        dataTestId="chat-message-context-menu"
        focusOnOpen
      />
    </span>
  );
}

/**
 * How long a `Copied` status waits before filling its live region. Screen
 * readers skip text a live region already holds when it appears, so the
 * announcement lands once the region is in place and the menu has closed.
 */
const COPIED_ANNOUNCE_DELAY_MS = 100;

/**
 * Shown where the menu was once a copy settles: `Copied` for
 * {@link DEFAULT_COPIED_DURATION_MS} (CAN-4704), or the failure until
 * dismissed. Either goes on the next pointer press, key press, resize or
 * window blur in that document. It never takes focus.
 */
function ChatMessageCopyStatus({
  feedback,
  onDismiss,
}: {
  feedback: CopyFeedbackState;
  onDismiss: () => void;
}): JSX.Element | null {
  const { ownerDocument, kind } = feedback;
  const [announced, setAnnounced] = useState(false);

  useEffect((): (() => void) => {
    const view = ownerDocument.defaultView;
    ownerDocument.addEventListener('mousedown', onDismiss, true);
    ownerDocument.addEventListener('keydown', onDismiss, true);
    view?.addEventListener('resize', onDismiss);
    view?.addEventListener('blur', onDismiss);
    return (): void => {
      ownerDocument.removeEventListener('mousedown', onDismiss, true);
      ownerDocument.removeEventListener('keydown', onDismiss, true);
      view?.removeEventListener('resize', onDismiss);
      view?.removeEventListener('blur', onDismiss);
    };
  }, [ownerDocument, onDismiss]);

  useEffect((): (() => void) | undefined => {
    if (kind !== 'copied') return undefined;
    const announce = setTimeout((): void => {
      setAnnounced(true);
    }, COPIED_ANNOUNCE_DELAY_MS);
    const dismiss = setTimeout(onDismiss, DEFAULT_COPIED_DURATION_MS);
    return (): void => {
      clearTimeout(announce);
      clearTimeout(dismiss);
    };
  }, [kind, onDismiss]);

  // Where the menu was, pulled back inside the window near an edge.
  const point = { x: feedback.x, y: feedback.y };
  return kind === 'copied' ? (
    <RichHoverCard
      anchorPoint={point}
      ownerDocument={ownerDocument}
      placement="at-point"
      dataTestId="chat-message-copied"
      elevation="menu"
      surfacePadding="frame"
      surfaceClassName="w-max"
    >
      <DropdownMenuStatusRow role="presentation" aria-hidden="true">
        Copied
      </DropdownMenuStatusRow>
      <span role="status" className="sr-only">
        {announced ? 'Copied' : ''}
      </span>
    </RichHoverCard>
  ) : (
    // The failure is the shared error notice, which brings its own tray.
    <RichHoverCard
      anchorPoint={point}
      ownerDocument={ownerDocument}
      placement="at-point"
      dataTestId="chat-message-copy-failed"
      elevation="menu"
      surfacePadding="flush"
      surfaceClassName="w-max"
    >
      <ErrorBanner className="" error="Couldn't copy to clipboard" />
    </RichHoverCard>
  );
}
