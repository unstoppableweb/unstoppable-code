import { ControlButton } from './Button';
import {
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  CheckIcon,
  CloseMediumIcon,
  EditBigIcon,
  ExternalIcon,
  MinusIcon,
} from '../icons/AppIcons';
import { DropdownMenuItem } from './DropdownMenu';
import { FloatingMenu } from './FloatingMenu';
import { PickerTriggerChevron } from './PickerMenu';
import { TitlebarIconButton } from './TitlebarIconButton';
import { Heading } from './Heading';
import { ListRow } from './ListRow';

/**
 * Where the floating chat sits. `panel` fills a transparent native panel its
 * host places inside the app window (desktop App Advisor, whose host draws
 * the shadow behind it); it rounds its own corners and never drags the
 * window. `card` floats over a page in the bottom-right corner (web).
 */
export type FloatingChatWindowSurface = 'panel' | 'card';

/** The chats the title's menu switches between. */
export interface FloatingChatSwitcher {
  /** Every chat to switch to, newest first, the open one included. */
  items: readonly FloatingChatRecentItem[];
  /** The open chat, checked in the menu. */
  activeId: string | null;
  onSelect: (id: string) => void;
}

export interface FloatingChatWindowSize {
  width: number;
  height: number;
}

/**
 * Lets the user resize the window from its top and left edges and its
 * top-left corner, within these limits (CSS px). The window stays anchored
 * at its bottom-right; the host applies each size it reports.
 */
export interface FloatingChatWindowResize {
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
  onResize: (size: FloatingChatWindowSize) => void;
  /**
   * The page's zoom (CSS px to screen px), read when a drag starts. Pointer
   * screen coordinates are not page-zoomed, so drag distances are divided by
   * it to stay under the pointer. Absent means 1.
   */
  pageZoom?: () => number;
}

export interface FloatingChatWindowProps {
  /** The chat's title, or a neutral label for a chat with no messages. */
  title: string;
  surface: FloatingChatWindowSurface;
  /**
   * Turns the title into a menu of chats to switch to. The title stays
   * plain text when absent.
   */
  switcher?: FloatingChatSwitcher;
  /** Makes the window resizable. Absent keeps a fixed size. */
  resize?: FloatingChatWindowResize;
  /** Starts a new chat. The control is omitted when absent. */
  onNewChat?: () => void;
  /** Opens the full chat window on the same chat. */
  onExpand: () => void;
  /** Hides the floating chat (the host may leave a way back, like a bubble). */
  onMinimize: () => void;
  /** Closes the floating chat. The control is omitted when absent. */
  onClose?: () => void;
  /** The chat: its transcript and composer. */
  children: ReactNode;
  dataTestId?: string;
}

const SURFACE_CLASS_NAMES: Record<FloatingChatWindowSurface, string> = {
  panel: 'h-full w-full rounded-2xl',
  // Above page content, below dialogs; inset 16px from the viewport corner.
  card: 'fixed bottom-4 right-4 z-drawer h-160 max-h-[calc(100vh-32px)] w-100 max-w-[calc(100vw-32px)] rounded-2xl shadow-xl',
};

/**
 * A compact chat window: a quiet title, the window's controls, and the chat
 * below. Shared by the desktop App Advisor floating window and the web
 * Portal's App Advisor card.
 */
export function FloatingChatWindow({
  title,
  surface,
  onNewChat,
  onExpand,
  onMinimize,
  onClose,
  switcher,
  resize,
  children,
  dataTestId = 'floating-chat-window',
}: FloatingChatWindowProps): JSX.Element {
  return (
    <section
      aria-label={title}
      data-testid={dataTestId}
      data-surface={surface}
      // The window's surface is `bg-tertiary`, and it is also the base surface
      // for everything inside: the transcript paints `bg-base` wherever it
      // covers what scrolls behind it (the pinned message's strip and
      // backing, the edge fades), and those must match the window rather
      // than the app behind it, or they read as dark bands. `--bg-raised` is
      // the step above that base (the transcript's elevated controls, such
      // as the agent steps banner), so they stay above the window instead
      // of sinking below it. The composer, tertiary elsewhere, would vanish
      // into the window, so it takes quaternary through `--bg-composer`.
      className={`relative flex min-h-0 flex-col overflow-hidden bg-tertiary [--bg-base:var(--bg-tertiary)] [--bg-raised:var(--bg-quaternary)] [--bg-composer:var(--bg-quaternary)] ${SURFACE_CLASS_NAMES[surface]}`}
    >
      <header
        data-testid={`${dataTestId}-header`}
        className="flex h-11 shrink-0 select-none items-center gap-1 pl-4 pr-2"
      >
        {/* With no chat to switch to, the title is plain text: a menu
            always has a row. */}
        {switcher && switcher.items.length > 0 ? (
          <div className="flex min-w-0 flex-1">
            <FloatingChatTitleMenu
              title={title}
              switcher={switcher}
              dataTestId={dataTestId}
            />
          </div>
        ) : (
          <Heading
            level={2}
            variant="sidebar"
            tone="muted"
            truncate
            data-testid={`${dataTestId}-title`}
            className="min-w-0 flex-1"
          >
            {title}
          </Heading>
        )}
        {onNewChat && (
          <TitlebarIconButton
            icon={EditBigIcon}
            aria-label="New chat"
            onClick={onNewChat}
          />
        )}
        <TitlebarIconButton
          icon={ExternalIcon}
          aria-label="Open full window"
          onClick={onExpand}
        />
        <TitlebarIconButton
          icon={MinusIcon}
          aria-label="Minimize"
          onClick={onMinimize}
        />
        {onClose && (
          <TitlebarIconButton
            icon={CloseMediumIcon}
            aria-label="Close"
            onClick={onClose}
          />
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      {/* The header's background fades into the chat below it instead of
          ending in a hard edge, so messages dissolve as they scroll under
          it. `--bg-base` is this window's own surface (set above). It stops
          short of the transcript's scrollbar rail, so the bar stays clear. */}
      <div
        aria-hidden="true"
        data-testid={`${dataTestId}-header-fade`}
        className="pointer-events-none absolute left-0 right-[var(--canopy-scrollbar-rail-size)] top-11 z-30 h-6 bg-gradient-to-b from-base to-transparent"
      />
      {/* The desktop panel is a native view, which clips everything outside
          its bounds. Its host draws `shadow-xl` behind it (the outer ring and
          drop shadow, on the same 16px CSS corners as this frame); this draws
          the same `shadow-xl` inside, where only its inner ring shows, so
          together the panel wears the design system's whole shadow. The web
          card wears `shadow-xl` on the frame itself. */}
      {surface === 'panel' && (
        <div
          aria-hidden="true"
          data-testid={`${dataTestId}-edge`}
          className="pointer-events-none absolute inset-0 z-30 rounded-2xl shadow-xl"
        />
      )}
      {resize && (
        <FloatingChatResizeHandles resize={resize} dataTestId={dataTestId} />
      )}
    </section>
  );
}

type ResizeEdge = 'top' | 'left' | 'top-left';

const RESIZE_HANDLE_CLASS_NAMES: Record<ResizeEdge, string> = {
  top: 'inset-x-4 top-0 h-1.5 cursor-ns-resize',
  left: 'inset-y-4 left-0 w-1.5 cursor-ew-resize',
  'top-left': 'left-0 top-0 size-4 cursor-nwse-resize',
};

/**
 * Invisible drag strips along the window's top and left edges, plus its
 * top-left corner. Dragging reports a new size, measured from where the drag
 * started in screen coordinates: the window moves under the pointer as it
 * grows toward the top-left, so its own coordinates would drift.
 */
function FloatingChatResizeHandles({
  resize,
  dataTestId,
}: {
  resize: FloatingChatWindowResize;
  dataTestId: string;
}): JSX.Element {
  const drag = useRef<{
    edge: ResizeEdge;
    x: number;
    y: number;
    width: number;
    height: number;
    zoom: number;
  } | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<FloatingChatWindowSize | null>(null);
  const clamp = (value: number, min: number, max: number): number =>
    Math.round(Math.min(max, Math.max(min, value)));
  const flush = (): void => {
    frame.current = null;
    if (pending.current) resize.onResize(pending.current);
    pending.current = null;
  };
  const start =
    (edge: ResizeEdge) =>
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return;
      const frameElement = event.currentTarget.closest('section');
      if (!frameElement) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const rect = frameElement.getBoundingClientRect();
      const zoom = resize.pageZoom?.() ?? 1;
      drag.current = {
        edge,
        x: event.screenX,
        y: event.screenY,
        width: rect.width,
        height: rect.height,
        zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1,
      };
    };
  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (!current) return;
    const resizesWidth = current.edge !== 'top';
    const resizesHeight = current.edge !== 'left';
    pending.current = {
      width: resizesWidth
        ? clamp(
            current.width + (current.x - event.screenX) / current.zoom,
            resize.minWidth,
            resize.maxWidth,
          )
        : Math.round(current.width),
      height: resizesHeight
        ? clamp(
            current.height + (current.y - event.screenY) / current.zoom,
            resize.minHeight,
            resize.maxHeight,
          )
        : Math.round(current.height),
    };
    frame.current ??= window.requestAnimationFrame(flush);
  };
  const end = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (frame.current !== null) {
      window.cancelAnimationFrame(frame.current);
      flush();
    }
  };
  return (
    <>
      {(['top', 'left', 'top-left'] as const).map((edge) => (
        <div
          key={edge}
          aria-hidden="true"
          data-testid={`${dataTestId}-resize-${edge}`}
          className={`absolute z-40 touch-none ${RESIZE_HANDLE_CLASS_NAMES[edge]}`}
          onPointerDown={start(edge)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
      ))}
    </>
  );
}

/** The longest the chat menu grows before it scrolls, in CSS px. */
const SWITCHER_MENU_MAX_HEIGHT = 360;

/**
 * The window title as a menu button: the chat's title and a chevron, opening
 * every chat to switch to.
 */
function FloatingChatTitleMenu({
  title,
  switcher,
  dataTestId,
}: {
  title: string;
  switcher: FloatingChatSwitcher;
  dataTestId: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const choose = (action: () => void): void => {
    setOpen(false);
    action();
  };
  return (
    <>
      <Heading level={2} variant="sidebar" className="flex min-w-0">
        {/* `-ml-1.5` pulls the button's hover surface out to the left; its
            8px left padding keeps the text clear of that surface's edge. */}
        <ControlButton
          ref={triggerRef}
          type="button"
          data-testid={`${dataTestId}-title`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={(): void => setOpen((wasOpen) => !wasOpen)}
          presentation="floating-chat-menu"
        >
          <span className="min-w-0 truncate">{title}</span>
          <PickerTriggerChevron open={open} />
        </ControlButton>
      </Heading>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-left"
        aria-label="Switch chat"
        data-testid={`${dataTestId}-chats`}
        heightLimit={SWITCHER_MENU_MAX_HEIGHT}
        className="w-72 max-w-[calc(100vw-32px)] overflow-y-auto"
      >
        {switcher.items.map((item) => {
          const active = item.id === switcher.activeId;
          return (
            <DropdownMenuItem
              key={item.id}
              role="menuitemradio"
              aria-checked={active}
              data-testid={`${dataTestId}-chat`}
              onClick={(): void => choose(() => switcher.onSelect(item.id))}
            >
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              {active ? (
                <CheckIcon size="sm" aria-hidden="true" className="shrink-0" />
              ) : (
                <span className="shrink-0 text-xs fg-tertiary">
                  {item.timeLabel}
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
      </FloatingMenu>
    </>
  );
}

export interface FloatingChatRecentItem {
  id: string;
  title: string;
  /** Compact age of the chat's last activity, such as `2h`. */
  timeLabel: string;
}

export interface FloatingChatRecentListProps {
  items: readonly FloatingChatRecentItem[];
  onSelect: (id: string) => void;
}

/**
 * The floating chat's empty state: the latest chats to pick up. The rest are
 * in the title menu. It sits above the composer, at the bottom of the empty
 * chat.
 */
export function FloatingChatRecentList({
  items,
  onSelect,
}: FloatingChatRecentListProps): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label="Recent chats"
      data-testid="floating-chat-recent"
      className="flex flex-col text-s"
    >
      <div className="px-2 pb-2">
        <Heading level={3} variant="title">
          Recent chats
        </Heading>
      </div>
      {items.map((item) => (
        <ListRow
          key={item.id}
          data-testid="floating-chat-recent-item"
          onClick={(): void => onSelect(item.id)}
          trailing={item.timeLabel}
        >
          {item.title}
        </ListRow>
      ))}
    </nav>
  );
}
