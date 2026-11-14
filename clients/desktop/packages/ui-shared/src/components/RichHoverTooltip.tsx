import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEventHandler,
  type JSX,
  type KeyboardEventHandler,
  type SyntheticEvent,
  type MouseEventHandler,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { ABOVE_BROWSER_ATTRIBUTE } from '../lib/above-browser';
import { trackInputModality, wasFocusVisible } from '../lib/input-modality';
import { isImeComposing, useTooltipEscape } from './tooltip-escape';
import { useTooltipHandoff } from './tooltip-handoff';
import { escapeStartedInBoundary } from './useOverlayEscape';
import { computeFloatingMenuPosition } from './FloatingMenu';

const TOOLTIP_GAP = 6;
/** First-hover delay for item previews, shared by worktrees, chats and files. */
export const ITEM_PREVIEW_OPEN_DELAY_MS = 500;
const VIEWPORT_PADDING = 8;
const INTERACTIVE_CLOSE_GRACE_MS = 120;
/** Keys that open an interactive surface from its trigger by default. */
const DEFAULT_TRIGGER_OPEN_KEYS: readonly string[] = ['Enter', ' '];

/**
 * Surface inset. `compact` (8px by 4px) is a single line that happens to
 * wrap, the same inset as {@link Tooltip}; `default` (8px by 6px) is the
 * multi-line surface; `relaxed` (10px by 6px) is the composer chip tooltips'
 * label-and-description pair; `card` (12px by 8px) holds a titled card such as
 * a pull request's details. `frame` (4px all round) holds sections with
 * their own inset and nested corners, as a menu holds its rows (a diff
 * preview's header and diff well); `flush` holds sections that run to the
 * card's edges (an attachment preview's header rule).
 */
export type RichHoverTooltipSurfacePadding =
  | 'compact'
  | 'default'
  | 'relaxed'
  | 'card'
  | 'frame'
  | 'flush';

const SURFACE_PADDING_CLASS_NAMES: Record<
  RichHoverTooltipSurfacePadding,
  string
> = {
  compact: 'px-2 py-1',
  default: 'px-2 py-1.5',
  relaxed: 'px-2.5 py-1.5',
  card: 'px-3 py-2',
  frame: 'p-1',
  flush: 'p-0',
};

/**
 * The surface's look without its placement: type, corners, shadow, fill and
 * inset. Exported so a gallery can draw a card on the exact surface it hovers
 * on.
 */
export function richHoverTooltipSurfaceClassName({
  elevation = 'tooltip',
  tone = 'default',
  surfacePadding = 'default',
  surfaceWidth,
}: {
  elevation?: 'tooltip' | 'menu';
  tone?: 'default' | 'inverse';
  surfacePadding?: RichHoverTooltipSurfacePadding;
  surfaceWidth?: RichHoverTooltipSurfaceWidth;
}): string {
  return `text-left text-2xs font-normal ${
    elevation === 'menu' ? 'rounded-lg shadow-xl' : 'rounded-md shadow-tooltip'
  } ${
    tone === 'inverse'
      ? 'bg-tooltip-inverse fg-tooltip-inverse'
      : 'bg-quaternary fg-primary'
  } ${SURFACE_PADDING_CLASS_NAMES[surfacePadding]}${
    surfaceWidth ? ` ${SURFACE_WIDTH_CLASS_NAMES[surfaceWidth]}` : ''
  }`;
}

/**
 * The hover card that previews an item: the sidebar worktree card and the
 * GitHub pull request card. The menu's corners and shadow, with card inset.
 */
export const PREVIEW_CARD_SURFACE = {
  elevation: 'menu',
  surfacePadding: 'card',
  surfaceWidth: 'preview-card',
} as const satisfies {
  elevation: 'menu';
  surfacePadding: RichHoverTooltipSurfacePadding;
  surfaceWidth: RichHoverTooltipSurfaceWidth;
};

/**
 * Surface width bands owned by the component. `preview-card` is a fixed 280px
 * (or the window less 16px each side): wide enough for a typical worktree,
 * branch and pull request line, so long names truncate at one steady edge.
 */
export type RichHoverTooltipSurfaceWidth = 'preview-card';

const SURFACE_WIDTH_CLASS_NAMES: Record<RichHoverTooltipSurfaceWidth, string> =
  {
    'preview-card': 'w-70 max-w-[calc(100vw-2rem)]',
  };

interface RichHoverTooltipProps {
  /** Rich content rendered inside the portaled tooltip surface. */
  content: ReactNode;
  /** Mount the controller on first interaction without replacing the trigger. */
  deferUntilInteraction?: boolean;
  /** Retire an activated controller when the described identity changes. */
  resetKey?: string | number;
  /** The single trigger element that receives tooltip interaction/ARIA props. */
  children: ReactElement<TooltipTriggerProps>;
  dataTestId?: string;
  /**
   * Surface id, for a trigger that already names its description (for
   * example a row whose `aria-describedby` also lists an unavailable reason).
   */
  id?: string;
  /**
   * When true, the tooltip never opens. Note the child is returned *bare*: the
   * wrapper span is not rendered at all, so `triggerWrapperClassName` does not
   * apply on this path and any layout the caller routes through it must move
   * onto the child. Used to suppress the tooltip for idle states.
   */
  disabled?: boolean;
  /** Hide the tooltip while preserving the trigger and its focus. */
  suppressed?: boolean;
  /** Undefined uses hover/focus behavior; true/false force the surface open/closed. */
  open?: boolean;
  /** Interaction requests; controlled callers update `open` to honor dismissal. */
  onOpenChange?: (open: boolean) => void;
  /** Delay before opening; leaving the trigger cancels the pending open. */
  openDelay?: number;
  /**
   * How the surface moves when it opens in place of a neighbour's: `jump`
   * (default) appears at its own place at once; `slide` glides over from the
   * previous surface, for tab hover cards.
   */
  handoffMotion?: 'jump' | 'slide';
  /** Delay for keyboard focus; defaults to `openDelay`. */
  focusOpenDelay?: number;
  /** Block pointer-triggered tooltips while content scrolls under a stationary cursor. */
  suppressPointerHover?: boolean;
  /**
   * Width classes for the tooltip surface (`w-max`, `min-w-*`, `max-w-*`).
   * Defaults to the multi-line surface's 180px–320px band; consumers can pass
   * narrower or wider sizing. The inset is `surfacePadding`, never a class.
   */
  surfaceClassName?: string;
  surfacePadding?: RichHoverTooltipSurfacePadding;
  /** A width band the component owns; `surfaceClassName` adds to it. */
  surfaceWidth?: RichHoverTooltipSurfaceWidth;
  /**
   * Surface color treatment. `inverse` is the reversed black sheet in light
   * mode and the regular dark tooltip surface in dark mode, matching
   * {@link Tooltip}'s inverse tone.
   */
  tone?: 'default' | 'inverse';
  /**
   * Surface corners and shadow. `tooltip` (default) is the tooltip's 8px
   * corners and light shadow; `menu` is {@link DropdownMenuSurface}'s 12px
   * corners and menu shadow, for a card that previews an item the way its
   * menu would sit beside it.
   */
  elevation?: 'tooltip' | 'menu';
  /**
   * When true, the tooltip prefers side placement to the right of the trigger
   * (left edge at the trigger's right edge plus the tooltip gap, vertically
   * centered on it). This is only used when the tooltip fits within the viewport
   * that way; otherwise it falls back to the default above/below,
   * horizontally-centered behavior.
   */
  preferRightPlacement?: boolean;
  /**
   * Vertical alignment for right placement: `center` (default) centers on the
   * trigger; `start` lines the surface's top up with the trigger's top, for a
   * card that previews a row.
   */
  rightPlacementAlign?: 'center' | 'start';
  /**
   * `below-start` hangs the surface under its anchor with its left edge on the
   * anchor's left edge, for a card that previews a tab. Near the right edge it
   * lines up with the anchor's right edge instead (or clamps when neither
   * fits), and it flips above when there is no room below. The default,
   * `auto`, prefers above and centers.
   */
  placement?: 'auto' | 'below-start';
  /** Distance between the anchor and the surface; defaults to 6px. */
  placementGap?: number;
  /**
   * The element the surface is placed against, when it is larger than the
   * trigger (for example the whole tab around a tab's label). Defaults to the
   * trigger itself. Its visibility also determines whether the surface can
   * show, including when a `contents` trigger has no layout box of its own.
   */
  getPlacementAnchor?: (trigger: HTMLElement) => Element | null;
  /**
   * Extra classes for the inline wrapper that hosts the trigger. The wrapper is
   * `relative inline-flex` by default (shrinks to the trigger); pass e.g.
   * `w-full` so the trigger can fill a grid/flex cell instead of hugging its
   * content.
   */
  triggerWrapperClassName?: string;
  /** Preserve the child's layout box when the entire child is the hover region. */
  triggerDisplay?: 'inline-flex' | 'contents';
  /**
   * Keep the portaled surface open while the pointer/focus moves into it and
   * allow pointer interaction (for example, scrolling a bounded detail list).
   */
  interactive?: boolean;
  /**
   * Draw a noninteractive surface over a live in-app browser page instead of
   * hiding the page behind a still frame ({@link ABOVE_BROWSER_ATTRIBUTE}). For
   * hover cards the pointer never enters; ignored with `interactive`. Web
   * ignores the attribute.
   */
  aboveBrowser?: boolean;
  /**
   * With `interactive`, Enter or Space on the trigger opens the surface and
   * moves focus into it. Turn it off when the trigger owns those keys (a row
   * that opens on Enter); the surface then stays a pointer affordance.
   */
  openOnTriggerKey?: boolean;
  /**
   * The trigger keys that open an interactive surface and move focus into
   * it; Enter and Space by default. A trigger that acts on Enter itself (a
   * button that opens a panel) can open its surface on ArrowDown instead,
   * the menu-button key.
   */
  triggerOpenKeys?: readonly string[];
  /**
   * Escape closes the showing surface until the pointer leaves or focus
   * moves, wherever focus is, and that press goes no further: a dialog under
   * the surface stays open. A menu or listbox with focus keeps Escape and
   * closes with the surface. On by default; a caller that forces `open` owns
   * visibility and opts in explicitly. With focus inside an interactive
   * surface, Escape also returns focus to the trigger.
   */
  dismissOnEscape?: boolean;
  /**
   * With `interactive`, keep presses, clicks, and Enter or Space inside the
   * surface from bubbling (through the React tree) to the trigger's
   * ancestors. The surface is portaled out of the trigger's DOM, but React
   * still bubbles its events to them, so selecting text in a row's card would
   * otherwise start a drag on, open, or open the menu of that row.
   */
  containEvents?: boolean;
}

export interface TooltipTriggerProps {
  'aria-controls'?: string;
  'aria-describedby'?: string;
  'aria-expanded'?: boolean;
  onBlur?: FocusEventHandler<HTMLElement>;
  onFocus?: FocusEventHandler<HTMLElement>;
  onMouseEnter?: MouseEventHandler<HTMLElement>;
  onMouseLeave?: MouseEventHandler<HTMLElement>;
}

const mergeDescribedBy = (
  existing: string | undefined,
  tooltipId: string | undefined,
): string | undefined =>
  [existing, tooltipId]
    .filter((value): value is string => Boolean(value))
    .join(' ') || undefined;

/**
 * `cloneElement` overwrites a prop whenever the key is present, even when the
 * value is `undefined`. A non-interactive tooltip therefore omits
 * `aria-expanded` and `aria-controls` so the trigger keeps its own (a menu
 * button wrapped in a hover tip). An interactive tooltip owns both, because
 * its surface is the disclosure.
 */
const ariaStateWhenInteractive = (
  interactive: boolean,
  expanded: boolean,
  controls: string | undefined,
):
  | {
      readonly 'aria-expanded': boolean;
      readonly 'aria-controls': string | undefined;
    }
  | Record<string, never> =>
  interactive ? { 'aria-expanded': expanded, 'aria-controls': controls } : {};

function stopAtSurface(event: SyntheticEvent): void {
  event.stopPropagation();
}

interface TooltipControllerHandlers {
  enter: () => void;
  leave: () => void;
  focus: FocusEventHandler<HTMLSpanElement>;
  blur: FocusEventHandler<HTMLElement>;
  keyDown: KeyboardEventHandler<HTMLSpanElement>;
}

interface ExternalTooltipTrigger {
  ref: RefObject<HTMLSpanElement | null>;
  handlers: RefObject<TooltipControllerHandlers | null>;
  onOpenChange: (open: boolean) => void;
}

type FocusReturnTarget = Pick<HTMLElement, 'focus' | 'isConnected'>;

// Adoption changes ownerDocument without changing a node's prototype realm.
function isDomNode(target: EventTarget): target is Node {
  return 'nodeType' in target && typeof target.nodeType === 'number';
}

function isFocusReturnTarget(
  target: EventTarget,
): target is EventTarget & FocusReturnTarget {
  return (
    isDomNode(target) &&
    target.nodeType === Node.ELEMENT_NODE &&
    'focus' in target &&
    typeof target.focus === 'function'
  );
}

type TooltipDelay =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'opening' | 'closing';
      readonly view: Window;
      readonly id: number;
    };

export function RichHoverTooltip(props: RichHoverTooltipProps): JSX.Element {
  return props.deferUntilInteraction ? (
    <DeferredRichHoverTooltip {...props} />
  ) : (
    <RichHoverTooltipController {...props} />
  );
}

function DeferredRichHoverTooltip(props: RichHoverTooltipProps): JSX.Element {
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const handlers = useRef<TooltipControllerHandlers | null>(null);
  const [activation, setActivation] = useState<{
    resetKey: RichHoverTooltipProps['resetKey'];
  } | null>(null);
  const active = activation !== null && activation.resetKey === props.resetKey;
  const [open, setOpen] = useState(false);
  const generatedId = useId();
  const tooltipId = props.id ?? generatedId;
  useEffect((): void => {
    const doc = triggerRef.current?.ownerDocument;
    if (doc) trackInputModality(doc);
  }, [props.disabled]);
  useLayoutEffect((): void => {
    setActivation(null);
    setOpen(false);
  }, [props.resetKey]);
  useLayoutEffect((): void => {
    if (props.open !== undefined && !props.disabled)
      setActivation({ resetKey: props.resetKey });
  }, [props.disabled, props.open, props.resetKey]);

  const activate = (): TooltipControllerHandlers | null => {
    if (props.disabled || props.suppressed) return null;
    // Commit the controller before forwarding this event: preserve its delay,
    // cancellation and preventDefault semantics without replaying browser input.
    if (!handlers.current) {
      flushSync(() => setActivation({ resetKey: props.resetKey }));
    }
    return handlers.current;
  };
  const enter = (): void => {
    if (props.suppressPointerHover) return;
    activate()?.enter();
  };
  const focus: FocusEventHandler<HTMLSpanElement> = (event): void => {
    if (wasFocusVisible(event.target)) activate()?.focus(event);
  };
  const keyDown: KeyboardEventHandler<HTMLSpanElement> = (event): void => {
    const opens =
      props.interactive &&
      props.openOnTriggerKey !== false &&
      (props.triggerOpenKeys ?? DEFAULT_TRIGGER_OPEN_KEYS).includes(event.key);
    (opens ? activate() : handlers.current)?.keyDown(event);
  };
  if (props.disabled) return <>{props.children}</>;
  const described = active && (props.open ?? open) && !props.suppressed;
  const trigger = cloneElement(props.children, {
    'aria-describedby': mergeDescribedBy(
      props.children.props['aria-describedby'],
      described ? tooltipId : undefined,
    ),
    ...ariaStateWhenInteractive(
      props.interactive === true,
      described,
      described ? tooltipId : undefined,
    ),
  });
  return (
    <span
      ref={triggerRef}
      className={`relative ${props.triggerDisplay ?? 'inline-flex'} ${props.triggerWrapperClassName ?? ''}`.trim()}
      onMouseEnter={enter}
      onMouseMove={open ? undefined : enter}
      onMouseLeave={() => handlers.current?.leave()}
      onFocus={focus}
      onBlur={(event) => handlers.current?.blur(event)}
      onKeyDown={keyDown}
    >
      {trigger}
      {active && (
        <RichHoverTooltipController
          {...props}
          id={tooltipId}
          externalTrigger={{ ref: triggerRef, handlers, onOpenChange: setOpen }}
        />
      )}
    </span>
  );
}

/**
 * Generic portaled hover/focus tooltip for rich (multi-line / card-like)
 * content. Positions above the trigger, flips below and clamps to the viewport
 * when there is not enough room, and follows the trigger on scroll/resize.
 */
function RichHoverTooltipController({
  content,
  children,
  dataTestId,
  id,
  disabled = false,
  suppressed = false,
  open: controlledOpen,
  onOpenChange,
  openDelay = 0,
  handoffMotion = 'jump',
  focusOpenDelay = openDelay,
  suppressPointerHover = false,
  surfaceClassName,
  surfacePadding = 'default',
  surfaceWidth,
  tone = 'default',
  elevation = 'tooltip',
  preferRightPlacement = false,
  rightPlacementAlign = 'center',
  placement = 'auto',
  placementGap = TOOLTIP_GAP,
  getPlacementAnchor,
  triggerWrapperClassName = '',
  triggerDisplay = 'inline-flex',
  interactive = false,
  aboveBrowser = false,
  openOnTriggerKey = true,
  triggerOpenKeys = DEFAULT_TRIGGER_OPEN_KEYS,
  dismissOnEscape = controlledOpen === undefined,
  containEvents = false,
  externalTrigger,
}: RichHoverTooltipProps & {
  externalTrigger?: ExternalTooltipTrigger;
}): JSX.Element {
  const containsEvents = interactive && containEvents;
  const ownTriggerRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = externalTrigger?.ref ?? ownTriggerRef;
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<FocusReturnTarget | null>(null);
  const focusTooltipOnOpenRef = useRef(false);
  const suppressNextTriggerFocusRef = useRef(false);
  const pointerHoverRef = useRef(false);
  // The pointer is over the trigger or the surface: React's enter and leave
  // follow the component tree, so the portaled surface counts as inside the
  // trigger's wrapper.
  const pointerInsideRef = useRef(false);
  const escapeDismissedRef = useRef(false);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = useCallback(
    (next: boolean): void => {
      setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const generatedTooltipId = useId();
  const tooltipId = id ?? generatedTooltipId;

  // Opening and closing delays supersede each other. Visibility remains
  // separate because a controlled tooltip can be opened by its caller.
  const delayRef = useRef<TooltipDelay>({ phase: 'idle' });
  const clearDelay = useCallback((phase?: 'opening' | 'closing'): void => {
    const pending = delayRef.current;
    if (pending.phase === 'idle' || (phase && pending.phase !== phase)) return;
    pending.view.clearTimeout(pending.id);
    delayRef.current = { phase: 'idle' };
  }, []);
  useEffect(() => {
    if (disabled || suppressed) {
      clearDelay('opening');
      setInternalOpen(false);
    }
    return (): void => clearDelay('opening');
  }, [clearDelay, disabled, suppressed, openDelay]);

  const scheduleDelay = useCallback(
    (phase: 'opening' | 'closing', delay: number): void => {
      const view = triggerRef.current?.ownerDocument.defaultView ?? window;
      const id = view.setTimeout(() => {
        delayRef.current = { phase: 'idle' };
        setOpen(phase === 'opening');
      }, delay);
      delayRef.current = { phase, view, id };
    },
    [setOpen, triggerRef],
  );

  const closeTooltip = useCallback((): void => {
    clearDelay();
    setOpen(false);
  }, [clearDelay, setOpen]);

  const handoff = useTooltipHandoff({
    open: open && !suppressed && !disabled,
    positioned: position !== null,
    close: closeTooltip,
    triggerRef,
    surfaceRef: tooltipRef,
    slide: handoffMotion === 'slide',
  });

  const showTooltipAfter = useCallback(
    (delay: number): void => {
      if (suppressed || escapeDismissedRef.current) return;
      clearDelay('closing');
      handoff.setLeaving(false);
      if (delayRef.current.phase === 'opening') return;
      if (delay <= 0) {
        setOpen(true);
        return;
      }
      scheduleDelay('opening', delay);
    },
    [clearDelay, handoff, scheduleDelay, suppressed, setOpen],
  );
  const showTooltip = useCallback(
    (): void => showTooltipAfter(openDelay),
    [openDelay, showTooltipAfter],
  );

  const showPointerTooltip = useCallback((): void => {
    pointerInsideRef.current = true;
    if (suppressPointerHover) return;
    pointerHoverRef.current = true;
    showTooltipAfter(handoff.pointerOpenDelay(openDelay));
  }, [handoff, openDelay, showTooltipAfter, suppressPointerHover]);

  useEffect((): void => {
    if (controlledOpen === false) {
      clearDelay();
      setInternalOpen(false);
    }
  }, [clearDelay, controlledOpen]);

  useEffect((): void => {
    if (suppressPointerHover && pointerHoverRef.current) closeTooltip();
  }, [closeTooltip, suppressPointerHover]);

  const requestClose = useCallback((): void => {
    escapeDismissedRef.current = false;
    // The surface stays for the host's close delay (longer when interactive,
    // so the pointer can reach it); a neighbour that opens meanwhile replaces
    // it at once.
    const linger = Math.max(
      handoff.closeDelay,
      interactive ? INTERACTIVE_CLOSE_GRACE_MS : 0,
    );
    if (linger <= 0) {
      closeTooltip();
      return;
    }
    // Leaving before the open delay elapses cancels the open, or the surface
    // would appear later with nothing under the pointer to close it.
    clearDelay();
    handoff.setLeaving(true);
    scheduleDelay('closing', linger);
  }, [clearDelay, closeTooltip, handoff, interactive, scheduleDelay]);

  const handlePointerLeave = useCallback((): void => {
    pointerInsideRef.current = false;
    requestClose();
  }, [requestClose]);

  // React bubbles the portaled surface's focus events to the trigger's
  // wrapper too. Focus moving between the trigger and the surface is not
  // leaving, and neither is a press on the hovered card's text or another of
  // its controls: the pointer is still there, and leaving will close it.
  const handleBlur: FocusEventHandler<HTMLElement> = useCallback(
    (event): void => {
      const next = event.relatedTarget;
      if (
        next !== null &&
        isDomNode(next) &&
        (triggerRef.current?.contains(next) ||
          tooltipRef.current?.contains(next))
      ) {
        return;
      }
      if (interactive && pointerInsideRef.current) return;
      requestClose();
    },
    [interactive, requestClose],
  );

  const showing = open && !suppressed && !disabled;
  // A surface removed under the pointer (Escape, a card action) fires no
  // mouseleave, so every close clears the pointer flag; otherwise blur would
  // keep skipping requestClose and an Escape dismissal could never reset.
  useEffect((): void => {
    if (!showing) pointerInsideRef.current = false;
  }, [showing]);
  const dismissByEscape = useCallback((): void => {
    escapeDismissedRef.current = true;
    closeTooltip();
  }, [closeTooltip]);
  useTooltipEscape({
    active: dismissOnEscape && showing,
    triggerRef,
    onEscape: dismissByEscape,
  });

  const focusTooltipContent = useCallback((): boolean => {
    const focusTarget = tooltipRef.current?.querySelector<HTMLElement>(
      '[data-rich-tooltip-autofocus], [tabindex]:not([tabindex="-1"]), button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
    );
    focusTarget?.focus();
    return Boolean(focusTarget);
  }, []);

  // Native `:focus-visible` semantics: open for focus the user reached by
  // keyboard, never for pointer or programmatic focus. A menu that returns
  // focus to its trigger after a pointer pick (the PR status bar's base-branch
  // picker) would otherwise pop the tooltip open until blur.
  const handleFocusVisible: FocusEventHandler<HTMLElement> = useCallback(
    (event): void => {
      if (!wasFocusVisible(event.target)) return;
      pointerHoverRef.current = false;
      showTooltipAfter(focusOpenDelay);
    },
    [focusOpenDelay, showTooltipAfter],
  );

  const handleTriggerFocus: FocusEventHandler<HTMLSpanElement> = useCallback(
    (event): void => {
      if (suppressNextTriggerFocusRef.current) {
        suppressNextTriggerFocusRef.current = false;
        return;
      }
      handleFocusVisible(event);
    },
    [handleFocusVisible],
  );

  const handleTriggerKeyDown: KeyboardEventHandler<HTMLSpanElement> =
    useCallback(
      (event): void => {
        if (
          dismissOnEscape &&
          event.key === 'Escape' &&
          !isImeComposing(event.nativeEvent) &&
          !escapeStartedInBoundary(
            event.target,
            event.currentTarget.ownerDocument,
          )
        ) {
          // A pending open is cancelled without claiming the press: with no
          // surface showing, Escape still belongs to whatever is beneath.
          if (!showing) {
            if (delayRef.current.phase !== 'opening') return;
            clearDelay('opening');
            escapeDismissedRef.current = true;
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          dismissByEscape();
          return;
        }
        if (
          !interactive ||
          !openOnTriggerKey ||
          !triggerOpenKeys.includes(event.key)
        ) {
          return;
        }
        if (
          isDomNode(event.target) &&
          tooltipRef.current?.contains(event.target)
        ) {
          return;
        }
        event.preventDefault();
        returnFocusRef.current = isFocusReturnTarget(event.target)
          ? event.target
          : null;
        clearDelay('closing');
        setOpen(true);
        if (!focusTooltipContent()) {
          focusTooltipOnOpenRef.current = true;
        }
      },
      [
        clearDelay,
        dismissByEscape,
        dismissOnEscape,
        focusTooltipContent,
        interactive,
        openOnTriggerKey,
        setOpen,
        showing,
        triggerOpenKeys,
      ],
    );

  const handleTooltipKeyDown: KeyboardEventHandler<HTMLDivElement> =
    useCallback(
      (event): void => {
        if (!interactive) return;
        // Enter and Space would act on the trigger's row (open it, or start
        // dragging it) through the portal; other keys reach app shortcuts.
        if (containEvents && (event.key === 'Enter' || event.key === ' ')) {
          event.stopPropagation();
          return;
        }
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        const returnFocusTarget = returnFocusRef.current;
        const canRestoreFocus = returnFocusTarget?.isConnected === true;
        if (canRestoreFocus) suppressNextTriggerFocusRef.current = true;
        closeTooltip();
        if (canRestoreFocus) returnFocusTarget.focus();
      },
      [closeTooltip, containEvents, interactive],
    );

  const updatePosition = useCallback((): void => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!trigger || !tooltip) return;

    // A trigger that stops rendering never sees the pointer leave: clicking a
    // chat tile that navigates to another page only hides the always-mounted
    // main page. Its zeroed rect would otherwise pin the surface to the
    // viewport's top-left corner, over the sidebar, until the user returns
    // and hovers out. Check the placement anchor: a display:contents trigger
    // can still describe a visible tab without creating its own layout box.
    const anchor = getPlacementAnchor?.(trigger) ?? trigger;
    if (!trigger.isConnected || anchor.checkVisibility?.() === false) {
      closeTooltip();
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const view = trigger.ownerDocument.defaultView ?? window;
    const viewportWidth = view.innerWidth;
    const viewportHeight = view.innerHeight;

    // Prefer side placement to the right of the trigger when requested and it
    // fits within the viewport. Otherwise fall through to the default
    // above/below, horizontally-centered behavior below.
    if (preferRightPlacement) {
      const rightLeft = rect.right + TOOLTIP_GAP;
      const fitsRight =
        rightLeft + tooltipWidth <= viewportWidth - VIEWPORT_PADDING;
      if (fitsRight) {
        const preferredSideTop =
          rightPlacementAlign === 'start'
            ? rect.top
            : rect.top + rect.height / 2 - tooltipHeight / 2;
        const top = Math.min(
          Math.max(VIEWPORT_PADDING, preferredSideTop),
          Math.max(
            VIEWPORT_PADDING,
            viewportHeight - tooltipHeight - VIEWPORT_PADDING,
          ),
        );
        setPosition((previous) => {
          if (previous && previous.top === top && previous.left === rightLeft) {
            return previous;
          }
          return { top, left: rightLeft };
        });
        return;
      }
    }

    if (placement === 'below-start') {
      const { top, left } = belowStartPosition({
        rect,
        width: tooltipWidth,
        height: tooltipHeight,
        viewportWidth,
        viewportHeight,
        gap: placementGap,
      });
      setPosition((previous) => {
        if (previous && previous.top === top && previous.left === left) {
          return previous;
        }
        return { top, left };
      });
      return;
    }

    const preferredTop = rect.top - TOOLTIP_GAP - tooltipHeight;
    const fallbackTop = rect.bottom + TOOLTIP_GAP;
    const clampedMaxTop = Math.max(
      VIEWPORT_PADDING,
      viewportHeight - tooltipHeight - VIEWPORT_PADDING,
    );
    const top =
      preferredTop >= VIEWPORT_PADDING
        ? preferredTop
        : Math.min(fallbackTop, clampedMaxTop);

    const centerLeft = rect.left + rect.width / 2 - tooltipWidth / 2;
    const clampedMaxLeft = Math.max(
      VIEWPORT_PADDING,
      viewportWidth - tooltipWidth - VIEWPORT_PADDING,
    );
    const left = Math.min(
      Math.max(VIEWPORT_PADDING, centerLeft),
      clampedMaxLeft,
    );

    setPosition((previous) => {
      if (previous && previous.top === top && previous.left === left) {
        return previous;
      }
      return { top, left };
    });
  }, [
    closeTooltip,
    getPlacementAnchor,
    placement,
    placementGap,
    preferRightPlacement,
    rightPlacementAlign,
  ]);

  // Portal into the TRIGGER's realm, like the shared Tooltip: a trigger
  // mounted in an auxiliary window (a popped-out activity card) must render
  // its surface in that window's body, not the module-global main document,
  // or the tooltip paints in the wrong window. Positioning already measures
  // against the trigger's own view. Declared above the `disabled` early
  // return so hook order is stable when a caller toggles `disabled`.
  // Resolved on first open rather than on mount: a mount-time state update
  // re-rendered every closed trigger once more before its first paint.
  const [portalBody, setPortalBody] = useState<HTMLElement | null>(null);
  useLayoutEffect((): void => {
    if (disabled || !open) return;
    setPortalBody(triggerRef.current?.ownerDocument.body ?? null);
  }, [disabled, open]);
  const canPortal = portalBody !== null;

  // `canPortal`: the first open mounts the surface one render later.
  useLayoutEffect((): void => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
  }, [canPortal, open, updatePosition]);

  // Focus requested by an Enter/Space open lands only once the surface has a
  // position: until then it is `visibility: hidden`, and Chromium refuses to
  // focus anything inside a hidden subtree.
  useLayoutEffect((): void => {
    if (!open || position === null || !focusTooltipOnOpenRef.current) return;
    focusTooltipOnOpenRef.current = false;
    focusTooltipContent();
  }, [focusTooltipContent, open, position]);

  useEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    const view = triggerRef.current?.ownerDocument.defaultView ?? window;
    let frame: number | null = null;
    const schedule = (): void => {
      if (frame !== null) return;
      frame = view.requestAnimationFrame((): void => {
        frame = null;
        updatePosition();
      });
    };
    view.addEventListener('resize', schedule);
    view.addEventListener('scroll', schedule, {
      capture: true,
      passive: true,
    });
    // Re-anchor when the tooltip's own content resizes (e.g. async PR data
    // populating the surface) or when the trigger resizes. Without this, a
    // tooltip that grows taller after positioning keeps its top fixed and
    // extends downward over the anchor it is supposed to sit above.
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(schedule)
        : null;
    if (observer) {
      if (tooltipRef.current) observer.observe(tooltipRef.current);
      if (triggerRef.current) observer.observe(triggerRef.current);
    }
    return (): void => {
      view.removeEventListener('resize', schedule);
      view.removeEventListener('scroll', schedule, { capture: true });
      observer?.disconnect();
      if (frame !== null) {
        view.cancelAnimationFrame(frame);
      }
    };
  }, [canPortal, open, updatePosition]);

  useEffect(
    () => (): void => {
      clearDelay('closing');
    },
    [clearDelay],
  );

  // Record input modality from mount, in the trigger's own document, so the
  // Tab press that precedes the user's first keyboard focus is seen by the
  // time `handleTriggerFocus` asks about it.
  useEffect((): void => {
    const doc = triggerRef.current?.ownerDocument;
    if (doc) trackInputModality(doc);
  }, [disabled]);

  useLayoutEffect(() => {
    if (!externalTrigger) return undefined;
    externalTrigger.handlers.current = {
      enter: showPointerTooltip,
      leave: handlePointerLeave,
      focus: handleTriggerFocus,
      blur: handleBlur,
      keyDown: handleTriggerKeyDown,
    };
    return (): void => {
      externalTrigger.handlers.current = null;
    };
  });
  useLayoutEffect((): void => {
    externalTrigger?.onOpenChange(open && !suppressed && !disabled);
  }, [disabled, externalTrigger, open, suppressed]);

  if (disabled) {
    return <>{children}</>;
  }
  // Associate the tooltip with the trigger for assistive tech only. The
  // open/close handlers live on the wrapper span below — NOT on the trigger —
  // because a disabled trigger (e.g. an in-progress git button) emits no
  // pointer/focus events, so handlers cloned onto it would never fire and the
  // tooltip would never open exactly when it is supposed to.
  const trigger = cloneElement(children, {
    'aria-describedby': mergeDescribedBy(
      children.props['aria-describedby'],
      open && !suppressed ? tooltipId : undefined,
    ),
    ...ariaStateWhenInteractive(
      interactive,
      open && !suppressed,
      open && !suppressed ? tooltipId : undefined,
    ),
  });

  const surface =
    open &&
    !suppressed &&
    canPortal &&
    createPortal(
      <div
        id={tooltipId}
        ref={tooltipRef}
        role="tooltip"
        data-testid={dataTestId}
        {...(aboveBrowser && !interactive
          ? { [ABOVE_BROWSER_ATTRIBUTE]: 'true' }
          : {})}
        onMouseEnter={interactive ? showTooltip : undefined}
        onMouseLeave={interactive ? requestClose : undefined}
        onFocus={interactive ? handleFocusVisible : undefined}
        onBlur={interactive ? handleBlur : undefined}
        onKeyDown={interactive ? handleTooltipKeyDown : undefined}
        onPointerDown={containsEvents ? stopAtSurface : undefined}
        onMouseDown={containsEvents ? stopAtSurface : undefined}
        onClick={containsEvents ? stopAtSurface : undefined}
        onDoubleClick={containsEvents ? stopAtSurface : undefined}
        onContextMenu={containsEvents ? stopAtSurface : undefined}
        className={`${interactive ? 'electron-no-drag pointer-events-auto' : 'pointer-events-none'} fixed z-tooltip ${richHoverTooltipSurfaceClassName(
          { elevation, tone, surfacePadding, surfaceWidth },
        )} ${surfaceClassName ?? (surfaceWidth ? '' : 'min-w-45 max-w-80')}`}
        style={
          position
            ? { top: position.top, left: position.left }
            : { visibility: 'hidden', top: 0, left: 0 }
        }
      >
        {content}
      </div>,
      portalBody,
    );
  if (externalTrigger) return <>{surface}</>;

  return (
    <span
      ref={triggerRef}
      className={`relative ${triggerDisplay} ${triggerWrapperClassName}`.trim()}
      onMouseEnter={showPointerTooltip}
      // Same swallowed-enter fallback as the shared Tooltip: when the trigger
      // mounts under a resting pointer, Chromium's `mouseover` names a
      // still-connected ancestor as `relatedTarget` and React never fires
      // `onMouseEnter`; the pointer's next `mousemove` inside the trigger
      // opens the tooltip instead. Only wired while closed.
      onMouseMove={open ? undefined : showPointerTooltip}
      onMouseLeave={handlePointerLeave}
      onFocus={handleTriggerFocus}
      onBlur={handleBlur}
      onKeyDown={handleTriggerKeyDown}
    >
      {trigger}
      {surface}
    </span>
  );
}

interface HoverCardRect {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

interface HoverCardPosition {
  readonly top: number;
  readonly left: number;
}

/**
 * Under the anchor with left edges aligned; near the right edge, right edges
 * aligned instead (or clamped when neither fits). Flips above when there is
 * no room below and room above; fitting neither, it is clamped 8px inside
 * the window.
 */
function belowStartPosition({
  rect,
  width,
  height,
  viewportWidth,
  viewportHeight,
  gap,
}: {
  rect: HoverCardRect;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  gap: number;
}): HoverCardPosition {
  const below = rect.bottom + gap;
  const above = rect.top - gap - height;
  const preferred =
    below + height <= viewportHeight - VIEWPORT_PADDING ||
    above < VIEWPORT_PADDING
      ? below
      : above;
  // Fitting neither side, it stays inside the window, over the anchor if it
  // must, rather than running off the bottom.
  const top = Math.max(
    VIEWPORT_PADDING,
    Math.min(preferred, viewportHeight - height - VIEWPORT_PADDING),
  );
  const maxLeft = viewportWidth - width - VIEWPORT_PADDING;
  const left =
    rect.left <= maxLeft
      ? Math.max(VIEWPORT_PADDING, rect.left)
      : Math.max(VIEWPORT_PADDING, Math.min(rect.right - width, maxLeft));
  return { top, left };
}

const FLOATING_MENU_SURFACE_SELECTOR = '.canopy-floating-menu';
/** Between a menu's edge and a card beside it, as between a menu and its submenu. */
const BESIDE_MENU_GAP = 8;
/** Between a badge and the card under it: the menu gap. */
const HOVER_CARD_GAP = 4;

function boxesIntersect(first: HoverCardRect, second: HoverCardRect): boolean {
  return (
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top
  );
}

/**
 * Beside the floating menu that holds `row`, vertically centred on the row.
 * The candidates come from the menu's surface, not the row: beside a "More"
 * flyout, "left of the row" is exactly where the parent menu sits. Right of
 * the surface, then left, taking the first that fits the window without
 * covering another open menu; failing that, the first clamped side that
 * covers no other menu. Menus still awaiting their first position sit hidden
 * at 0,0 and are skipped.
 */
function besideMenuPosition(
  row: Element,
  width: number,
  height: number,
): HoverCardPosition {
  const view = row.ownerDocument.defaultView ?? window;
  const rowRect = row.getBoundingClientRect();
  const maxLeft = Math.max(
    VIEWPORT_PADDING,
    view.innerWidth - width - VIEWPORT_PADDING,
  );
  const maxTop = Math.max(
    VIEWPORT_PADDING,
    view.innerHeight - height - VIEWPORT_PADDING,
  );
  const centeredTop = rowRect.top + rowRect.height / 2 - height / 2;
  const top = Math.min(Math.max(VIEWPORT_PADDING, centeredTop), maxTop);
  const surface = row.closest(FLOATING_MENU_SURFACE_SELECTOR);
  const surfaceRect = surface?.getBoundingClientRect() ?? rowRect;
  const otherMenus = Array.from(
    row.ownerDocument.querySelectorAll(FLOATING_MENU_SURFACE_SELECTOR),
  )
    .filter(
      (element) =>
        element !== surface &&
        element.getAttribute('data-positioned') !== 'false',
    )
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  const coversOtherMenu = (left: number): boolean =>
    otherMenus.some((menu) =>
      boxesIntersect(
        { left, top, right: left + width, bottom: top + height },
        menu,
      ),
    );
  const fitsViewport = (left: number): boolean =>
    left >= VIEWPORT_PADDING && left <= maxLeft;
  const clamp = (left: number): number =>
    Math.min(Math.max(VIEWPORT_PADDING, left), maxLeft);
  const rightOfSurface = surfaceRect.right + BESIDE_MENU_GAP;
  const leftOfSurface = surfaceRect.left - BESIDE_MENU_GAP - width;
  const left =
    [rightOfSurface, leftOfSurface].find(
      (candidate) => fitsViewport(candidate) && !coversOtherMenu(candidate),
    ) ??
    [clamp(leftOfSurface), clamp(rightOfSurface)].find(
      (candidate) => !coversOtherMenu(candidate),
    ) ??
    clamp(leftOfSurface);
  return { top, left };
}

interface RichHoverCardBaseProps {
  readonly children: ReactNode;
  readonly id?: string;
  readonly dataTestId?: string;
  /**
   * `tooltip` when the trigger names the card with `aria-describedby`. A card
   * that only previews what the trigger already says has no role.
   */
  readonly role?: 'tooltip';
  readonly tone?: 'default' | 'inverse';
  readonly elevation?: 'tooltip' | 'menu';
  readonly surfacePadding?: RichHoverTooltipSurfacePadding;
  readonly surfaceWidth?: RichHoverTooltipSurfaceWidth;
  /** Width classes (`w-*`, `min-w-*`, `max-w-*`), as for {@link RichHoverTooltip}. */
  readonly surfaceClassName?: string;
}

interface RichHoverCardAtRectProps extends RichHoverCardBaseProps {
  /**
   * The trigger's box, measured by a caller that tracks its own hover and
   * focus (a sidebar row's status badges). The card hangs under it, left
   * edges aligned, and flips above when there is no room below.
   */
  readonly anchorRect: HoverCardRect;
  /** The window the trigger is in (default: the global document). */
  readonly ownerDocument?: Document;
  /** Distance below (or above) the anchor; defaults to 4px. */
  readonly placementGap?: number;
  readonly placement?: 'below-start';
  readonly anchorRef?: never;
  readonly anchorPoint?: never;
  readonly interactive?: never;
  readonly onMouseEnter?: never;
  readonly onMouseLeave?: never;
}

interface RichHoverCardBesideMenuProps extends RichHoverCardBaseProps {
  /**
   * A row inside a floating menu. The card sits beside the menu's surface,
   * right then left, never over another open menu, centred on the row.
   */
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly placement: 'beside-menu';
  readonly anchorRect?: never;
  readonly anchorPoint?: never;
  readonly ownerDocument?: never;
  readonly placementGap?: never;
  readonly interactive?: never;
  readonly onMouseEnter?: never;
  readonly onMouseLeave?: never;
}

interface RichHoverCardAtControlProps extends RichHoverCardBaseProps {
  /**
   * The control the card previews (a changed file, an attachment). The card
   * is centred on it, 8px above or below: `above` and `below` flip only when
   * the card does not fit and the other side has more room, `auto` takes the
   * side with more room. Its height is capped to the room it gets, so a long
   * body scrolls inside it. `left` and `right` sit beside the control, cap
   * width to its gutter, and flip when that gutter cannot fit a readable card.
   */
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly placement: 'above' | 'below' | 'auto' | 'left' | 'right';
  /**
   * The card holds controls the pointer moves onto (an Open or Edit action):
   * it takes the pointer, reports `onMouseEnter` and `onMouseLeave` so the
   * caller can keep it open while the pointer crosses over, and makes a live
   * in-app browser page yield beneath it.
   */
  readonly interactive?: boolean;
  readonly onMouseEnter?: () => void;
  readonly onMouseLeave?: () => void;
  readonly anchorRect?: never;
  readonly anchorPoint?: never;
  readonly ownerDocument?: never;
  readonly placementGap?: never;
}

interface RichHoverCardAtPointProps extends RichHoverCardBaseProps {
  /**
   * A point in `ownerDocument`'s viewport, such as where a context menu was:
   * the card's top-left corner sits there, pulled back inside the window
   * near an edge as the menu would be.
   */
  readonly anchorPoint: { readonly x: number; readonly y: number };
  readonly ownerDocument: Document;
  readonly placement: 'at-point';
  readonly anchorRect?: never;
  readonly anchorRef?: never;
  readonly placementGap?: never;
  readonly interactive?: never;
  readonly onMouseEnter?: never;
  readonly onMouseLeave?: never;
}

export type RichHoverCardProps =
  | RichHoverCardAtRectProps
  | RichHoverCardBesideMenuProps
  | RichHoverCardAtControlProps
  | RichHoverCardAtPointProps;

/** A card at a point keeps this far inside the window, as a context menu does. */
const POINT_VIEWPORT_PADDING = 4;

/** Between a control and the card that previews it. */
const AT_CONTROL_GAP = 8;

interface HoverCardPlacedPosition extends HoverCardPosition {
  readonly maxHeight?: number;
  readonly maxWidth?: number;
}

/**
 * The rich hover surface for a caller that decides when it shows: a status
 * badge whose row tracks hover and focus itself, a menu row's detail card, or
 * a preview hovering over a control. Mounted means shown. Like
 * {@link RichHoverTooltip} it portals into the anchor's window, sits on the
 * tooltip layer, ignores the pointer unless `interactive` (content that
 * scrolls opts back in with `pointer-events-auto`), and re-places itself when
 * the window resizes or scrolls or the card's content changes size. It takes
 * no focus, so Escape and dismissal stay with the caller's trigger.
 */
export function RichHoverCard(props: RichHoverCardProps): JSX.Element | null {
  const {
    children,
    id,
    dataTestId,
    role,
    tone = 'default',
    elevation = 'tooltip',
    surfacePadding = 'default',
    surfaceWidth,
    surfaceClassName,
  } = props;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<HoverCardPlacedPosition | null>(
    null,
  );
  const placement = props.placement ?? 'below-start';
  const anchorRef = props.anchorRef;
  const anchorRect = props.anchorRect;
  const pointX = props.anchorPoint?.x;
  const pointY = props.anchorPoint?.y;
  const placementGap = props.placementGap ?? HOVER_CARD_GAP;
  const atControl =
    placement === 'above' ||
    placement === 'below' ||
    placement === 'auto' ||
    placement === 'left' ||
    placement === 'right';
  const interactive = atControl && props.interactive === true;
  const doc =
    (anchorRef ? anchorRef.current?.ownerDocument : props.ownerDocument) ??
    (typeof document === 'undefined' ? undefined : document);

  const updatePosition = useCallback((): void => {
    const card = cardRef.current;
    if (!card) return;
    const view = card.ownerDocument.defaultView ?? window;
    let next: HoverCardPlacedPosition;
    if (placement === 'at-point') {
      if (pointX === undefined || pointY === undefined) return;
      const inside = (start: number, size: number, extent: number): number =>
        Math.max(
          POINT_VIEWPORT_PADDING,
          Math.min(start, extent - size - POINT_VIEWPORT_PADDING),
        );
      next = {
        top: inside(pointY, card.offsetHeight, view.innerHeight),
        left: inside(pointX, card.offsetWidth, view.innerWidth),
      };
    } else if (placement === 'beside-menu') {
      const row = anchorRef?.current;
      if (!row) return;
      next = besideMenuPosition(row, card.offsetWidth, card.offsetHeight);
    } else if (placement === 'left' || placement === 'right') {
      const control = anchorRef?.current;
      if (!control) return;
      const rect = control.getBoundingClientRect();
      const leftRoom = Math.max(
        0,
        rect.left - AT_CONTROL_GAP - VIEWPORT_PADDING,
      );
      const rightRoom = Math.max(
        0,
        view.innerWidth - rect.right - AT_CONTROL_GAP - VIEWPORT_PADDING,
      );
      const preferredRoom = placement === 'left' ? leftRoom : rightRoom;
      const otherRoom = placement === 'left' ? rightRoom : leftRoom;
      const side =
        preferredRoom < 160 && otherRoom > preferredRoom
          ? placement === 'left'
            ? 'right'
            : 'left'
          : placement;
      const room = side === 'left' ? leftRoom : rightRoom;
      const maxWidth = Math.min(
        Math.max(160, room),
        view.innerWidth - 2 * VIEWPORT_PADDING,
      );
      const width = Math.min(card.offsetWidth, maxWidth);
      next = {
        left: Math.min(
          Math.max(
            VIEWPORT_PADDING,
            side === 'left'
              ? rect.left - AT_CONTROL_GAP - width
              : rect.right + AT_CONTROL_GAP,
          ),
          view.innerWidth - width - VIEWPORT_PADDING,
        ),
        top: Math.max(
          VIEWPORT_PADDING,
          Math.min(
            rect.top + (rect.height - card.offsetHeight) / 2,
            view.innerHeight - card.offsetHeight - VIEWPORT_PADDING,
          ),
        ),
        maxWidth,
        maxHeight: view.innerHeight - 2 * VIEWPORT_PADDING,
      };
    } else if (
      placement === 'above' ||
      placement === 'below' ||
      placement === 'auto'
    ) {
      const control = anchorRef?.current;
      if (!control) return;
      const rect = control.getBoundingClientRect();
      const side =
        placement === 'auto'
          ? rect.top >= view.innerHeight - rect.bottom
            ? 'top'
            : 'bottom'
          : placement === 'above'
            ? 'top'
            : 'bottom';
      // The natural height, not the capped one, decides the side.
      const placed = computeFloatingMenuPosition({
        anchorRect: rect,
        menuWidth: card.offsetWidth,
        menuHeight: card.scrollHeight,
        viewportWidth: view.innerWidth,
        viewportHeight: view.innerHeight,
        placement: side === 'top' ? 'top-center' : 'bottom-center',
        allowFlip: placement !== 'auto',
        gap: AT_CONTROL_GAP,
        viewportPadding: VIEWPORT_PADDING,
      });
      next = {
        top: placed.top,
        left: placed.left,
        maxHeight: placed.maxHeight,
      };
    } else {
      if (!anchorRect) return;
      next = belowStartPosition({
        rect: anchorRect,
        width: card.offsetWidth,
        height: card.offsetHeight,
        viewportWidth: view.innerWidth,
        viewportHeight: view.innerHeight,
        gap: placementGap,
      });
    }
    setPosition((previous) =>
      previous?.top === next.top &&
      previous.left === next.left &&
      previous.maxWidth === next.maxWidth &&
      previous.maxHeight === next.maxHeight
        ? previous
        : next,
    );
  }, [anchorRect, anchorRef, placement, placementGap, pointX, pointY]);

  useLayoutEffect((): (() => void) | void => {
    updatePosition();
    const view = cardRef.current?.ownerDocument.defaultView;
    if (!view) return;
    // A second pass once the card's fonts and rows have laid out.
    const frame = view.requestAnimationFrame(updatePosition);
    return (): void => view.cancelAnimationFrame(frame);
  }, [updatePosition]);

  // A caller may point the same ref at another control (hovering from one
  // changed file straight onto the next); re-place when the element changes.
  const placedAnchorRef = useRef<HTMLElement | null>(null);
  useLayoutEffect((): void => {
    const anchor = anchorRef?.current ?? null;
    if (anchor === placedAnchorRef.current) return;
    placedAnchorRef.current = anchor;
    updatePosition();
  });

  useEffect((): (() => void) | void => {
    const card = cardRef.current;
    const view = card?.ownerDocument.defaultView;
    if (!card || !view) return;
    let frame: number | null = null;
    const schedule = (): void => {
      if (frame !== null) return;
      frame = view.requestAnimationFrame((): void => {
        frame = null;
        updatePosition();
      });
    };
    view.addEventListener('resize', schedule);
    view.addEventListener('scroll', schedule, { capture: true, passive: true });
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(schedule);
    observer?.observe(card);
    return (): void => {
      view.removeEventListener('resize', schedule);
      view.removeEventListener('scroll', schedule, { capture: true });
      observer?.disconnect();
      if (frame !== null) view.cancelAnimationFrame(frame);
    };
  }, [updatePosition]);

  const body = doc?.body;
  if (!body) return null;
  return createPortal(
    <div
      ref={cardRef}
      id={id}
      role={role}
      data-testid={dataTestId}
      {...(interactive ? { 'data-canopy-browser-native-overlay': 'true' } : {})}
      onMouseEnter={interactive ? props.onMouseEnter : undefined}
      onMouseLeave={interactive ? props.onMouseLeave : undefined}
      className={`${interactive ? 'electron-no-drag pointer-events-auto' : 'pointer-events-none'} fixed z-tooltip ${
        atControl ? 'flex flex-col overflow-hidden ' : ''
      }${richHoverTooltipSurfaceClassName({
        elevation,
        tone,
        surfacePadding,
        surfaceWidth,
      })} ${surfaceClassName ?? (surfaceWidth ? '' : 'min-w-45 max-w-80')}`}
      style={
        position
          ? {
              top: position.top,
              left: position.left,
              ...(position.maxWidth === undefined
                ? {}
                : { maxWidth: position.maxWidth }),
              ...(position.maxHeight === undefined
                ? {}
                : { maxHeight: position.maxHeight }),
            }
          : { visibility: 'hidden', top: 0, left: 0 }
      }
    >
      {children}
    </div>,
    body,
  );
}
