import type { JSX, ReactNode } from 'react';
import { Tooltip } from '../primitives/Tooltip';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { CloseIcon as AppCatalogCloseIcon } from '../icons/AppIcons';

export interface ChatTabProps {
  /** Visible tab label. Truncated when the pill is narrower than the
   * label. */
  label: string;
  /** When true, the active accent treatment and underline are applied. */
  active?: boolean;
  /** When true, the tab is decorated with a streaming spinner area (the
   * caller provides the spinner content via `leading`). */
  busy?: boolean;
  /** When true, the leading icon shows the "unread" warning color. */
  unread?: boolean;
  /** Click handler. Also triggered by Enter/Space when focused. */
  onSelect?: () => void;
  /** A visual placeholder until the host has a real chat to select. */
  staticPlaceholder?: boolean;
  /** When provided AND `closable` is true, a small close button is
   * rendered. The button stops propagation so it does not trigger
   * `onSelect`. */
  onClose?: () => void;
  /** Show the close button on hover/focus. Defaults to true when an
   * `onClose` handler is supplied. */
  closable?: boolean;
  /**
   * The tab cannot close right now (the host refuses it, e.g. a busy chat).
   * The close button stays in place, marked disabled, and clicking it does
   * nothing. Without {@link closeDisabledReason} it keeps the normal
   * hover/focus reveal.
   */
  closeDisabled?: boolean;
  /**
   * Why the tab cannot close. With {@link closeDisabled}, the disabled close
   * button is always visible (not hover-revealed) and explains itself in a
   * tooltip, for reasons the tab does not otherwise show.
   */
  closeDisabledReason?: string;
  /**
   * Leading content (e.g., a chat-provider icon, file-type icon, or
   * streaming spinner). The shared component intentionally does not
   * pick the icon — the host app owns provider/file icon resolution.
   */
  leading?: ReactNode;
  /** Optional trailing content rendered between the label and the close
   * button (e.g., a dirty-buffer dot or read-only padlock). */
  trailing?: ReactNode;
  /** Tooltip shown on the label. */
  tooltip?: string;
  /** Optional read-only visual treatment (muted text). */
  readOnly?: boolean;
  /** The label is a user-authored chat title, masked in session replay. */
  maskLabel?: boolean;
  /** Test ID hook for automation. */
  dataTestId?: string;
  /** Extra data attribute used by automation for selecting a specific
   * tab (e.g., the underlying chat or file id). */
  dataChatId?: string;
  /** Whether the close button is currently visible (used by hosts that
   * want the close button to appear on group hover or focus-within). */
  closeButtonAriaLabel?: string;
  /** Extra DOM props for the outer tab element (e.g., drag-and-drop
   * handlers, refs are passed via this object's `ref` if needed). */
  outerRef?: (node: HTMLDivElement | null) => void;
  /** Native drag attributes for re-orderable tabs. */
  draggable?: boolean;
  onDragStart?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragOver?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd?: (event: React.DragEvent<HTMLDivElement>) => void;
  onContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void;
  /** Drop indicator on the left edge. */
  dropBefore?: boolean;
  /** Drop indicator on the right edge. */
  dropAfter?: boolean;
  /** Marks the tab as currently being dragged. Reduces opacity. */
  dragging?: boolean;
  /**
   * When true, the tab renders in Chrome-style "pinned" compact mode: icon
   * only, no label, no close button (even on hover), and a narrower pill.
   * Hosts can attach hover handlers to drive a rich popover.
   */
  pinned?: boolean;
  /** Pointer-enter handler used by hosts to show a hover popover. */
  onPointerEnter?: (event: React.PointerEvent<HTMLDivElement>) => void;
  /** Pointer-leave handler used by hosts to dismiss a hover popover. */
  onPointerLeave?: (event: React.PointerEvent<HTMLDivElement>) => void;
}

/**
 * Pure display tab pill. Renders a single tab row consistent with both
 * the desktop ChatTabBar (`role="tab"` pill with hover-revealed close)
 * and the web portal's tab bar. Host apps own selection state, drag and
 * drop, and provider icon resolution.
 */
export function ChatTab({
  label,
  active = false,
  busy = false,
  unread = false,
  onSelect,
  staticPlaceholder = false,
  onClose,
  closable,
  closeDisabled = false,
  closeDisabledReason,
  leading,
  trailing,
  tooltip,
  readOnly = false,
  maskLabel = false,
  dataTestId,
  dataChatId,
  closeButtonAriaLabel = 'Close tab',
  outerRef,
  draggable,
  onDragStart,
  onDragOver,
  onDragEnd,
  onContextMenu,
  dropBefore,
  dropAfter,
  dragging,
  pinned = false,
  onPointerEnter,
  onPointerLeave,
}: ChatTabProps): JSX.Element {
  const isCloseable = !pinned && (closable ?? typeof onClose === 'function');
  const closeTestId = dataTestId ? `${dataTestId}-close` : undefined;
  const closeGlyph = <AppCatalogCloseIcon size="sm" aria-hidden="true" />;
  // `aria-disabled` rather than `disabled`: a disabled button swallows the
  // pointer events its tooltip needs, and stays out of the tab order.
  const disabledCloseButton = (
    <button
      type="button"
      aria-disabled="true"
      aria-label={closeButtonAriaLabel}
      data-testid={closeTestId}
      data-close-disabled="true"
      onClick={(e): void => {
        // Never falls through to selecting the tab, and never closes it.
        e.stopPropagation();
      }}
      className={`focus-ring shrink-0 cursor-not-allowed rounded p-0.5 fg-disabled ${
        closeDisabledReason
          ? ''
          : 'ml-auto opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100'
      }`}
    >
      {closeGlyph}
    </button>
  );
  const activeClasses = active
    ? readOnly
      ? 'bg-muted fg-primary/70'
      : 'bg-muted fg-primary'
    : readOnly
      ? 'fg-secondary hover:bg-subtle hover:fg-primary/60'
      : 'fg-secondary hover:bg-subtle hover:fg-primary/80';

  const labelClass = `${maskLabel ? `${REPLAY_MASK_CLASS} ` : ''}${
    readOnly ? 'truncate fg-secondary' : 'truncate'
  }`;

  return (
    <div
      role={staticPlaceholder ? undefined : 'tab'}
      tabIndex={staticPlaceholder ? undefined : 0}
      aria-selected={staticPlaceholder ? undefined : active}
      aria-label={pinned ? (tooltip ?? label) : undefined}
      data-testid={dataTestId}
      data-chat-id={dataChatId}
      data-pinned={pinned || undefined}
      ref={outerRef}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onContextMenu={onContextMenu}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onClick={onSelect}
      onKeyDown={
        staticPlaceholder
          ? undefined
          : (e): void => {
              // Keys from the close button keep their own click.
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect?.();
              }
            }
      }
      className={`focus-ring focus-ring-inset group relative flex shrink-0 items-center border-r text-xs transition-opacity ${staticPlaceholder ? '' : 'cursor-pointer'} ${
        pinned
          ? 'justify-center gap-0 px-2.5 py-3'
          : 'max-w-45 gap-1.5 px-3 py-3'
      } ${dragging ? 'opacity-50' : ''} ${activeClasses}`}
      // The unread/busy styles are communicated via the leading icon's
      // class in the host; we expose `unread` and `busy` here only as
      // semantic markup so styles can be projected through data-*
      // attributes if a host opts in.
      data-unread={unread || undefined}
      data-busy={busy || undefined}
    >
      {dropBefore && (
        <div className="pointer-events-none absolute -left-px top-0 bottom-0 w-0.5 bg-accent" />
      )}
      {dropAfter && (
        <div className="pointer-events-none absolute -right-px top-0 bottom-0 w-0.5 bg-accent" />
      )}
      {active && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent" />
      )}
      {leading}
      {!pinned && (
        <span className={labelClass} title={tooltip ?? label}>
          {label}
        </span>
      )}
      {!pinned && trailing}
      {isCloseable &&
        (closeDisabled ? (
          closeDisabledReason ? (
            <Tooltip label={closeDisabledReason} className="ml-auto">
              {disabledCloseButton}
            </Tooltip>
          ) : (
            disabledCloseButton
          )
        ) : (
          <button
            type="button"
            data-testid={closeTestId}
            onClick={(e): void => {
              e.stopPropagation();
              onClose?.();
            }}
            className="focus-ring relative before:absolute before:inset-0 before:content-[''] pointer-coarse:before:-inset-y-3.25 pointer-coarse:before:-right-3 ml-auto shrink-0 rounded p-0.5 fg-secondary opacity-0 transition-opacity hover:bg-muted hover:fg-primary group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:bg-muted focus-visible:fg-primary focus-visible:opacity-100 pointer-coarse:opacity-100"
            aria-label={closeButtonAriaLabel}
          >
            {closeGlyph}
          </button>
        ))}
    </div>
  );
}
