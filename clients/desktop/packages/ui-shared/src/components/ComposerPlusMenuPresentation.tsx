'use client';

import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from 'react';
import {
  ComposerActionList,
  type ComposerActionListError,
  type ComposerShowAllControl,
  type ComposerActionRow,
} from './ComposerActionList';
import { FloatingMenu } from './FloatingMenu';
import { Tooltip } from './Tooltip';
import { ComposerIconButton } from './ComposerIconButton';
import { PlusLargeIcon } from '../icons/AppIcons';

export interface ComposerPlusMenuPresentationProps {
  keyboardNavigation?: boolean;
  /** Disable when the anchor contains an editor that owns its arrow keys. */
  openOnArrowKeys?: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  rows: ComposerActionRow[];
  anchorRef: RefObject<HTMLElement | null>;
  triggerRef: Ref<HTMLButtonElement>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  outsidePressBoundaryRef?: RefObject<HTMLElement | null>;
  menuRef?: RefObject<HTMLDivElement | null>;
  activeId?: string | null;
  onActiveIdChange?: (id: string | null) => void;
  onHoveredIdChange?: (id: string | null) => void;
  onTriggerKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onMenuKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  gap?: number;
  placement?: 'top-left' | 'bottom-left';
  allowFlip?: boolean;
  disabled?: boolean;
  dataTestIdPrefix: string;
  menuId: string;
  variant?: string;
  capsuleTrigger?: boolean;
  active?: boolean;
  triggerAriaLabel?: string;
  tooltipLabel?: string;
  menuLabel?: string;
  shortcut?: string;
  loading?: boolean;
  /** Head contiguous group runs so ranked rows keep their order. */
  groupRuns?: boolean;
  /** Preserve ranked order in one list without section headings. */
  flat?: boolean;
  /** Expands a capped result list; rendered after the groups. */
  showAll?: ComposerShowAllControl;
  /** A pick that failed or only partly finished, above the rows. */
  error?: ComposerActionListError | null;
  fullWidth?: boolean;
  tapTarget?: 'compact' | 'touch';
  /**
   * Renders the menu without its `+` trigger, for a composer that hides its
   * toolbar but still opens the menu from `/` and `@` in the draft.
   */
  hideTrigger?: boolean;
}

/** Controlled presentation only. Hosts own discovery, policy and action execution. */
export function ComposerPlusMenuPresentation({
  keyboardNavigation = false,
  openOnArrowKeys = !keyboardNavigation,
  isOpen,
  setIsOpen,
  rows,
  anchorRef,
  triggerRef,
  returnFocusRef,
  outsidePressBoundaryRef,
  menuRef,
  activeId,
  onActiveIdChange,
  onHoveredIdChange,
  onTriggerKeyDown,
  onMenuKeyDown,
  gap,
  placement = 'top-left',
  allowFlip = true,
  disabled = false,
  dataTestIdPrefix,
  menuId,
  variant = 'add',
  capsuleTrigger = false,
  active = false,
  triggerAriaLabel = 'More actions',
  tooltipLabel = 'More actions',
  menuLabel = 'Composer actions',
  shortcut,
  loading = false,
  groupRuns = false,
  flat = false,
  showAll,
  error = null,
  fullWidth = false,
  tapTarget = 'compact',
  hideTrigger = false,
}: ComposerPlusMenuPresentationProps): JSX.Element {
  const localMenuRef = useRef<HTMLDivElement | null>(null);
  const listRef = menuRef ?? localMenuRef;
  const [localActiveId, setLocalActiveId] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const setActive = (id: string | null): void => {
    activeRef.current = id;
    setLocalActiveId(id);
  };
  useEffect(() => {
    if (keyboardNavigation && disabled && isOpen) setIsOpen(false);
  }, [keyboardNavigation, disabled, isOpen, setIsOpen]);
  useEffect(() => {
    if (!keyboardNavigation || !isOpen) return undefined;
    const menu = listRef.current;
    if (!menu) return undefined;
    const buttons = (): HTMLButtonElement[] =>
      Array.from(
        menu.querySelectorAll<HTMLButtonElement>(
          '[data-action-row]:not(:disabled)',
        ),
      );
    const initialize = (): void => {
      const enabled = buttons();
      if (
        activeRef.current !== null &&
        enabled.some((button) => button.id === activeRef.current)
      )
        return;
      setActive(enabled[0]?.id ?? null);
    };
    activeRef.current = null;
    hoveredRef.current = null;
    initialize();
    let hadEnabledRows = buttons().length > 0;
    const observer = new MutationObserver(() => {
      const enabled = buttons();
      if (
        (!hadEnabledRows && enabled.length > 0) ||
        (activeRef.current !== null &&
          !enabled.some((button) => button.id === activeRef.current))
      )
        initialize();
      hadEnabledRows = enabled.length > 0;
    });
    observer.observe(menu, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled'],
    });
    const handleKey = (event: globalThis.KeyboardEvent): void => {
      if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
      const enabled = buttons();
      if (enabled.length === 0) {
        setIsOpen(false);
        return;
      }
      const id = activeRef.current ?? hoveredRef.current;
      const index = enabled.findIndex((button) => button.id === id);
      if (event.key === 'Enter') {
        if (index < 0) return;
        event.preventDefault();
        event.stopPropagation();
        enabled[index]?.click();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const next =
        index < 0
          ? event.key === 'ArrowDown'
            ? 0
            : enabled.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) %
            enabled.length;
      const button = enabled[next];
      if (button) {
        setActive(button.id);
        button.scrollIntoView?.({ block: 'nearest' });
      }
    };
    const doc = menu.ownerDocument;
    doc.addEventListener('keydown', handleKey, true);
    return (): void => {
      observer.disconnect();
      doc.removeEventListener('keydown', handleKey, true);
    };
  }, [keyboardNavigation, isOpen, listRef, setIsOpen]);
  return (
    <>
      {hideTrigger ? null : (
        <Tooltip
          // Typing @ in the draft opens this same menu, so the tooltip teaches
          // the shortcut beside what the button does.
          label={tooltipLabel}
          {...(shortcut ? { shortcut } : {})}
          suppressed={isOpen}
        >
          {capsuleTrigger ? (
            // The capsule trigger (the chat and Home composers): send-button
            // geometry (32px circle, 16px glyph) on a flat subtle fill that
            // steps up to muted on hover, written as one explicit class list
            // so no variant background can override it.
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setIsOpen(!isOpen)}
              onKeyDown={(event): void => {
                onTriggerKeyDown?.(event);
                if (
                  keyboardNavigation &&
                  !isOpen &&
                  ['ArrowDown', 'ArrowUp'].includes(event.key)
                ) {
                  event.preventDefault();
                  setIsOpen(true);
                }
              }}
              disabled={disabled}
              className={`focus-ring inline-flex ${tapTarget === 'touch' ? 'h-11 w-11 lg:h-8 lg:w-8' : 'h-8 w-8'} shrink-0 items-center justify-center rounded-full transition-transform enabled:active:scale-97 disabled:cursor-not-allowed disabled:fg-tertiary disabled:opacity-100 ${
                active
                  ? 'bg-warning-subtle fg-warning enabled:hover:bg-warning-subtle'
                  : // A one-device-pixel inset rim in the quiet line role
                    // keeps the + defined against the composer's surface.
                    'bg-subtle fg-primary ring-[length:var(--border-hairline)] ring-inset ring-line-tertiary enabled:hover:bg-muted'
              }`}
              data-testid={`${dataTestIdPrefix}-plus-button`}
              data-active={active ? 'true' : undefined}
              aria-label={triggerAriaLabel}
              aria-haspopup="dialog"
              aria-expanded={isOpen}
              aria-controls={isOpen ? menuId : undefined}
            >
              {/* The large plus: its ink matches the send arrow, the microphone
              and stop beside it (the medium plus read a size smaller). */}
              <PlusLargeIcon size={16} />
            </button>
          ) : (
            <ComposerIconButton
              ref={triggerRef}
              onClick={() => setIsOpen(!isOpen)}
              onKeyDown={(event): void => {
                onTriggerKeyDown?.(event);
                if (
                  keyboardNavigation &&
                  !isOpen &&
                  ['ArrowDown', 'ArrowUp'].includes(event.key)
                ) {
                  event.preventDefault();
                  setIsOpen(true);
                }
              }}
              disabled={disabled}
              tone={active ? 'warning' : 'default'}
              active={active}
              data-testid={`${dataTestIdPrefix}-plus-button`}
              data-active={active ? 'true' : undefined}
              aria-label={triggerAriaLabel}
              aria-haspopup="dialog"
              aria-expanded={isOpen}
              aria-controls={isOpen ? menuId : undefined}
            >
              <PlusLargeIcon size="sm" />
            </ComposerIconButton>
          )}
        </Tooltip>
      )}

      <FloatingMenu
        id={menuId}
        open={isOpen}
        onOpenChange={setIsOpen}
        anchorRef={anchorRef}
        {...(gap !== undefined ? { gap } : {})}
        placement={placement}
        allowFlip={allowFlip}
        interaction="manual"
        openOnArrowKeys={openOnArrowKeys}
        onKeyDown={onMenuKeyDown}
        outsidePressBoundaryRef={outsidePressBoundaryRef}
        returnFocusRef={returnFocusRef ?? anchorRef}
        role="dialog"
        aria-label={menuLabel}
        data-testid={`${dataTestIdPrefix}-plus-menu`}
        data-menu-variant={variant}
        data-chat-cancel-shortcut-ignore
        motion="none"
        className={`flex flex-col overflow-hidden ${
          fullWidth
            ? 'w-[var(--floating-menu-anchor-width)]'
            : 'w-[min(42rem,calc(100vw-2rem))]'
        }`}
        // This composer-attached surface matches the composer’s 20px corners.
        style={{ borderRadius: 'var(--radius-2xl)', paddingBlock: 0 }}
        heightLimit={280}
      >
        <ComposerActionList
          rows={rows}
          menuRef={listRef}
          activeId={keyboardNavigation ? localActiveId : activeId}
          onActiveIdChange={keyboardNavigation ? setActive : onActiveIdChange}
          onHoveredIdChange={
            keyboardNavigation
              ? (id): void => {
                  hoveredRef.current = id;
                }
              : onHoveredIdChange
          }
          loading={loading}
          groupRuns={groupRuns}
          flat={flat}
          showAll={showAll}
          error={error}
          dataTestIdPrefix={dataTestIdPrefix}
          // Session replay records each group's rows as a placeholder: the
          // menu lists the whole skill/plugin/command catalog unwindowed, so
          // opening it would otherwise serialize thousands of elements.
          blockRowsFromReplay
        />
      </FloatingMenu>
    </>
  );
}
