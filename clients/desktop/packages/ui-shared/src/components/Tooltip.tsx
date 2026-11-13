'use client';

import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ABOVE_BROWSER_ATTRIBUTE } from '../lib/above-browser';
import { trackInputModality, wasFocusVisible } from '../lib/input-modality';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { Button, buttonClassName } from './Button';
import { Kbd } from './Kbd';
import { useTooltipEscape } from './tooltip-escape';
import { useTooltipHandoff } from './tooltip-handoff';

const TOOLTIP_GAP = 6;
/** Side placements sit farther out so a menu surface doesn't crowd the tip. */
const TOOLTIP_SIDE_GAP = TOOLTIP_GAP + 4;
const VIEWPORT_PADDING = 8;
/**
 * Grace period (interactive/link tooltips only) between the pointer leaving the
 * trigger and the tooltip starting to close, so the user can move the cursor
 * across the gap into the tooltip to click the link without it disappearing.
 */
const CLOSE_GRACE_MS = 120;
/** Hover delay for `delay="long"`: long enough that passing over does not open it. */
const LONG_OPEN_DELAY_MS = 500;

export interface TooltipHrefLink {
  href: string;
  /** Visible link text; defaults to "Learn more". */
  text?: string;
  /**
   * Opens the link in a new tab via `target="_blank"` plus
   * `rel="noopener noreferrer"`. Defaults to `true`; pass `false` for in-app
   * routes, which should navigate in the same tab.
   */
  external?: boolean;
  /** Test id for the rendered link. */
  testId?: string;
}

/**
 * An in-app step with no URL, such as opening a setup flow inside the current
 * dialog. Rendered as a link-styled button.
 */
export interface TooltipActionLink {
  onClick: () => void;
  /** Visible link text. */
  text: string;
  /** Test id for the rendered button. */
  testId?: string;
}

export type TooltipLink = TooltipHrefLink | TooltipActionLink;

/**
 * Side of the trigger the tooltip prefers to render on. `'top'` (default)
 * positions the tooltip above the trigger, centered horizontally, falling back
 * below when there is no room. `'left'` / `'right'` position beside the trigger,
 * centered vertically, each falling back to the opposite side when needed.
 */
export type TooltipPlacement = 'top' | 'left' | 'right';

export interface TooltipProps {
  /** Tooltip content. */
  label: ReactNode;
  /** Optional inline link rendered under the label. Makes the tooltip interactive. */
  link?: TooltipLink;
  /**
   * A key or chord that performs the same action, shown as one key cap per
   * key after the label (`@`, `⌘K`). Pass `formatShortcut(id)` so the keys
   * match the platform. Sized to the tooltip's own line.
   */
  shortcut?: string;
  /**
   * How soon a hover opens the tooltip. `'long'` waits half a second, for
   * controls that already show their value (the composer's selectors), so
   * passing over them does not flash help. Keyboard focus always opens at
   * once.
   */
  delay?: 'none' | 'long';
  /** Preferred side to render the tooltip on. Defaults to `'top'`. */
  placement?: TooltipPlacement;
  /**
   * Visual tone. `'default'` uses the quaternary surface; `'inverse'` is the
   * reversed black tooltip in light mode and the regular dark tooltip in dark
   * mode.
   */
  tone?: 'default' | 'inverse';
  /**
   * Applied to the wrapper span, in addition to its default
   * `relative inline-flex shrink-0`. The `shrink-0` default keeps the trigger
   * from being squeezed by flex siblings; callers that need the wrapper to fill
   * its parent (e.g. full-width sidebar buttons) pass `className="w-full"`.
   */
  className?: string;
  /** Surface classes; replaces the default `whitespace-nowrap` when supplied. */
  contentClassName?: string;
  /**
   * Drops the wrapper's `shrink-0` so a trigger inside a space-constrained flex
   * rail can still be squeezed (the desktop composer toolbar, which compresses
   * its chips as the window narrows). A `className` cannot express this:
   * `shrink` and `shrink-0` are both utilities, so which one wins depends on
   * Tailwind's emitted order rather than on the order the caller writes them.
   */
  allowShrink?: boolean;
  /**
   * When true, the trigger is rendered directly with no tooltip behavior,
   * wrapper, portal, or `aria-describedby` wiring. Useful when a tooltip would
   * be redundant in a given state — e.g. an expanded sidebar button already
   * shows its text label, so its tooltip is suppressed via `disabled`.
   */
  disabled?: boolean;
  /** Delay before opening; leaving the trigger cancels the pending open. */
  openDelay?: number;
  /**
   * Dismisses and prevents the tooltip without changing the trigger wrapper.
   * Use while a menu or popover owned by the trigger is open so focus and
   * keyboard behavior remain stable.
   */
  suppressed?: boolean;
  /**
   * Blocks the tooltip surface from session replay. Set it when the label is
   * user content (a file name or path): the surface portals to the document
   * body, outside any replay-blocked transcript or panel around the trigger.
   */
  replayBlock?: boolean;
  /** The trigger element. */
  children: ReactNode;
}

interface TooltipTargetProps {
  children?: ReactNode;
  'aria-describedby'?: string;
  tabIndex?: number;
}

function mergeDescribedBy(
  existing: string | undefined,
  tooltipId: string | undefined,
): string | undefined {
  if (!existing) return tooltipId;
  if (!tooltipId) return existing;
  return `${existing} ${tooltipId}`;
}

/**
 * Wires `aria-describedby` onto the tooltip trigger.
 *
 * Traversal contract: when the child is a non-focusable `<span>`,
 * we recurse into its children rather than annotating the span itself, then
 * attach `aria-describedby` to the first non-span React element we reach
 * (typically a native `button`/`a`). A span with a tab stop is itself the
 * trigger. This lets callers wrap their trigger in layout spans without
 * losing the description link or describing a decorative child instead.
 *
 * It silently no-ops (returns the node unchanged) when the child is not a valid
 * element. Note that a child which is itself a React component is annotated as a
 * single element — the traversal does not descend into component render output —
 * so if that component renders a `<span>` root the `aria-describedby` lands on
 * the component boundary rather than an interactive element.
 */
function attachTooltipDescription(
  node: ReactNode,
  tooltipId: string | undefined,
): ReactNode {
  if (!isValidElement<TooltipTargetProps>(node)) {
    return node;
  }

  if (
    typeof node.type === 'string' &&
    node.type === 'span' &&
    (node.props.tabIndex === undefined || node.props.tabIndex < 0)
  ) {
    return cloneElement(
      node,
      undefined,
      Children.map(node.props.children, (child) =>
        attachTooltipDescription(child, tooltipId),
      ),
    );
  }

  return cloneElement(node, {
    'aria-describedby': mergeDescribedBy(
      node.props['aria-describedby'],
      tooltipId,
    ),
  });
}

export function Tooltip({
  label,
  link,
  shortcut,
  delay = 'none',
  placement = 'top',
  tone = 'default',
  className,
  contentClassName = 'whitespace-nowrap',
  allowShrink = false,
  disabled = false,
  openDelay = 0,
  suppressed = false,
  replayBlock = false,
  children,
}: TooltipProps): JSX.Element {
  const interactive = Boolean(link);
  const tooltipId = useId();
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  // Escape closed the tip: it stays closed until the pointer leaves or focus
  // moves, so the resting pointer's next movement does not reopen it.
  const escapeDismissedRef = useRef(false);
  const [tooltipMounted, setTooltipMounted] = useState(false);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);

  const updatePosition = useCallback((): void => {
    const wrapper = wrapperRef.current;
    const tooltip = tooltipRef.current;
    if (!wrapper || !tooltip) {
      return;
    }

    const rect = wrapper.getBoundingClientRect();
    const view = wrapper.ownerDocument.defaultView ?? window;
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const maxTop = Math.max(
      VIEWPORT_PADDING,
      view.innerHeight - tooltipHeight - VIEWPORT_PADDING,
    );
    const maxLeft = Math.max(
      VIEWPORT_PADDING,
      view.innerWidth - tooltipWidth - VIEWPORT_PADDING,
    );

    let top: number;
    let left: number;
    if (placement === 'left' || placement === 'right') {
      const sideGap = TOOLTIP_SIDE_GAP;
      const preferredLeft =
        placement === 'left'
          ? rect.left - sideGap - tooltipWidth
          : rect.right + sideGap;
      const fallbackLeft =
        placement === 'left'
          ? rect.right + sideGap
          : rect.left - sideGap - tooltipWidth;
      const preferredFits =
        placement === 'left'
          ? preferredLeft >= VIEWPORT_PADDING
          : preferredLeft + tooltipWidth <= view.innerWidth - VIEWPORT_PADDING;
      left = preferredFits
        ? Math.min(Math.max(VIEWPORT_PADDING, preferredLeft), maxLeft)
        : Math.min(Math.max(VIEWPORT_PADDING, fallbackLeft), maxLeft);
      const centeredTop = rect.top + rect.height / 2 - tooltipHeight / 2;
      top = Math.min(Math.max(VIEWPORT_PADDING, centeredTop), maxTop);
    } else {
      const preferredTop = rect.top - TOOLTIP_GAP - tooltipHeight;
      const fallbackTop = rect.bottom + TOOLTIP_GAP;
      top =
        preferredTop >= VIEWPORT_PADDING
          ? preferredTop
          : Math.min(fallbackTop, maxTop);
      const centeredLeft = rect.left + rect.width / 2 - tooltipWidth / 2;
      left = Math.min(Math.max(VIEWPORT_PADDING, centeredLeft), maxLeft);
    }

    setPosition((previous) => {
      if (previous && previous.top === top && previous.left === left) {
        return previous;
      }
      return { top, left };
    });
  }, [placement]);

  const openTimerRef = useRef<number | null>(null);
  const clearOpenTimer = useCallback((): void => {
    if (openTimerRef.current === null) return;
    (wrapperRef.current?.ownerDocument.defaultView ?? window).clearTimeout(
      openTimerRef.current,
    );
    openTimerRef.current = null;
  }, []);
  useEffect(() => {
    if (disabled) clearOpenTimer();
    return clearOpenTimer;
  }, [clearOpenTimer, disabled, openDelay]);

  const clearHideTimer = useCallback((): void => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const hideTooltip = useCallback((): void => {
    clearOpenTimer();
    clearHideTimer();
    setTooltipMounted(false);
    setPosition(null);
  }, [clearOpenTimer, clearHideTimer]);

  const showing = tooltipMounted && !disabled && !suppressed;
  const handoff = useTooltipHandoff({
    open: showing,
    positioned: position !== null,
    close: hideTooltip,
    triggerRef: wrapperRef,
    surfaceRef: tooltipRef,
  });

  useTooltipEscape({
    active: showing,
    triggerRef: wrapperRef,
    onEscape: (): void => {
      escapeDismissedRef.current = true;
      hideTooltip();
    },
  });

  const showTooltipAfter = useCallback(
    (delayMs: number): void => {
      if (suppressed || escapeDismissedRef.current) {
        return;
      }
      clearHideTimer();
      handoff.setLeaving(false);
      if (openTimerRef.current !== null) return;
      if (delayMs <= 0) {
        setTooltipMounted(true);
        return;
      }
      openTimerRef.current = (
        wrapperRef.current?.ownerDocument.defaultView ?? window
      ).setTimeout(() => {
        openTimerRef.current = null;
        setTooltipMounted(true);
      }, delayMs);
    },
    [clearHideTimer, handoff, suppressed],
  );

  const showTooltip = useCallback(
    (): void => showTooltipAfter(openDelay),
    [openDelay, showTooltipAfter],
  );

  // `delay="long"` holds a first hover for half a second; once another
  // tooltip is showing or just closed, the hover opens at once (see
  // `useTooltipHandoff`). Keyboard focus uses `showTooltip` and so
  // `openDelay` alone.
  const showTooltipOnHover = useCallback((): void => {
    const requested =
      delay === 'long' ? Math.max(LONG_OPEN_DELAY_MS, openDelay) : openDelay;
    showTooltipAfter(handoff.pointerOpenDelay(requested));
  }, [delay, handoff, openDelay, showTooltipAfter]);

  // Native `:focus-visible` semantics: open for focus the user reached by
  // keyboard, never for pointer or programmatic focus. A menu that returns
  // focus to its trigger after a pointer pick (the PR status bar's base-branch
  // picker) would otherwise pop the tooltip open until blur.
  const handleFocus = useCallback(
    (event: FocusEvent<HTMLSpanElement>): void => {
      if (!wasFocusVisible(event.target)) {
        return;
      }
      showTooltip();
    },
    [showTooltip],
  );

  // Leaving cancels a pending open. An open tooltip stays for the host's
  // close delay (longer for a link, so the pointer can reach it); a
  // neighbour that opens meanwhile replaces it at once.
  const requestHide = useCallback((): void => {
    escapeDismissedRef.current = false;
    clearOpenTimer();
    clearHideTimer();
    const linger = Math.max(
      handoff.closeDelay,
      interactive ? CLOSE_GRACE_MS : 0,
    );
    if (linger <= 0) {
      hideTooltip();
      return;
    }
    handoff.setLeaving(true);
    hideTimerRef.current = window.setTimeout((): void => {
      hideTimerRef.current = null;
      hideTooltip();
    }, linger);
  }, [clearHideTimer, clearOpenTimer, handoff, hideTooltip, interactive]);

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLSpanElement>): void => {
      const next = event.relatedTarget;
      if (
        next instanceof Node &&
        (wrapperRef.current?.contains(next) ||
          tooltipRef.current?.contains(next))
      ) {
        return;
      }
      escapeDismissedRef.current = false;
      hideTooltip();
    },
    [hideTooltip],
  );

  // `label`/`link` are deliberate dependencies: a mounted tooltip can swap
  // content in place (e.g. a toggle button whose action label flips on click
  // while the pointer stays put), which changes the tooltip's size and
  // invalidates the centered position.
  useLayoutEffect((): void => {
    if (!tooltipMounted) {
      setPosition(null);
      return;
    }

    updatePosition();
  }, [tooltipMounted, updatePosition, label, link]);

  // Inline reposition effect (mirrors the desktop
  // `useWindowPositionInvalidation` hook and ui-shared's existing
  // `RepoTooltipTrigger`): keep the portaled tooltip anchored to the trigger
  // while it is mounted by recomputing on rAF-coalesced resize/scroll.
  useEffect((): (() => void) | void => {
    if (!tooltipMounted) {
      return;
    }

    const schedulePositionUpdate = (): void => {
      if (animationFrameRef.current !== null) {
        return;
      }
      animationFrameRef.current = window.requestAnimationFrame((): void => {
        animationFrameRef.current = null;
        updatePosition();
      });
    };

    // The trigger's realm, not the module-global window: an auxiliary-window
    // tooltip must reposition on ITS window's resize/scroll.
    const view = wrapperRef.current?.ownerDocument.defaultView ?? window;
    view.addEventListener('resize', schedulePositionUpdate);
    view.addEventListener('scroll', schedulePositionUpdate, {
      capture: true,
      passive: true,
    });

    return (): void => {
      view.removeEventListener('resize', schedulePositionUpdate);
      view.removeEventListener('scroll', schedulePositionUpdate, {
        capture: true,
      });
      if (animationFrameRef.current !== null) {
        view.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [tooltipMounted, updatePosition]);

  useEffect((): (() => void) => {
    return (): void => {
      clearHideTimer();
    };
  }, [clearHideTimer]);

  // Record input modality from mount, in the trigger's own document, so the
  // Tab press that precedes the user's first keyboard focus is seen by the
  // time `handleFocus` asks about it.
  useEffect((): void => {
    const doc = wrapperRef.current?.ownerDocument;
    if (doc) trackInputModality(doc);
  }, [disabled]);

  // `disabled` unmounts the wrapper, which never sees the pointer leave: an
  // open tip would come back at its old coordinates, unhovered, once the
  // caller enables it again.
  useEffect((): void => {
    if (suppressed || disabled) {
      hideTooltip();
    }
  }, [disabled, hideTooltip, suppressed]);

  // Resolve the portal target and viewport from the TRIGGER's realm: a
  // wrapper mounted in an auxiliary window must portal into THAT window's
  // body, not the module-global main document — otherwise the tooltip paints
  // at unrelated coordinates in the wrong window. Declared ABOVE the
  // `disabled` early return: a caller toggling `disabled` on a mounted
  // Tooltip must see the same hooks in the same order on every render.
  const [portalBody, setPortalBody] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (disabled) return;
    setPortalBody(wrapperRef.current?.ownerDocument.body ?? null);
  }, [disabled]);
  const canPortal = portalBody !== null;

  // Rendered as a bare fragment when disabled so callers can suppress a
  // redundant tooltip without restructuring their JSX. All hooks above still
  // run unconditionally, keeping hook order stable across renders.
  if (disabled) {
    return <>{children}</>;
  }

  const describedChildren = attachTooltipDescription(
    children,
    tooltipMounted && !suppressed ? tooltipId : undefined,
  );

  return (
    <span
      ref={wrapperRef}
      className={`relative inline-flex ${allowShrink ? 'min-w-0' : 'shrink-0'} ${className ?? ''}`}
      onMouseEnter={showTooltipOnHover}
      // Enter can be swallowed when the trigger mounts under a resting
      // pointer: the node the pointer was on unmounts (e.g. a banner swapping
      // its split row for a single button), Chromium sends no `mouseout` for
      // it and reports a still-connected ancestor as the new `mouseover`'s
      // `relatedTarget`, so React's enter/leave plugin never dispatches
      // `onMouseEnter`. The pointer's next movement inside the trigger only
      // yields `mousemove`; open on it while closed so the hover still shows.
      onMouseMove={tooltipMounted ? undefined : showTooltipOnHover}
      onMouseLeave={requestHide}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      {describedChildren}
      {tooltipMounted &&
        !suppressed &&
        canPortal &&
        createPortal(
          <span
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            // A plain tip draws over an in-app browser page without freezing
            // it; a tip with a link must take the pointer, so it does not.
            {...(interactive ? {} : { [ABOVE_BROWSER_ATTRIBUTE]: 'true' })}
            onMouseEnter={interactive ? showTooltip : undefined}
            onMouseLeave={interactive ? requestHide : undefined}
            onFocus={interactive ? handleFocus : undefined}
            onBlur={interactive ? handleBlur : undefined}
            // Single-line by default, as every pre-existing caller expects.
            // Callers can opt into a bounded, wrapping surface via contentClassName.
            // With a shortcut the key cap sits in the corner: its top, bottom
            // and right insets are all the 4px vertical padding.
            className={`fixed z-tooltip flex flex-col gap-1 ${contentClassName} rounded-md py-1 text-xs font-normal shadow-tooltip ${
              shortcut ? 'pl-2 pr-1' : 'px-2'
            } ${
              tone === 'inverse'
                ? 'bg-tooltip-inverse fg-tooltip-inverse'
                : 'bg-quaternary fg-primary'
            } ${interactive ? 'pointer-events-auto' : 'pointer-events-none'}${
              replayBlock ? ` ${REPLAY_BLOCK_CLASS}` : ''
            }`}
            style={{
              ...(position
                ? { top: position.top, left: position.left }
                : { visibility: 'hidden', top: 0, left: 0 }),
            }}
          >
            {shortcut ? (
              <span className="inline-flex items-center gap-2">
                <span>{label}</span>
                {/* One capsule per key; its 4px inset from the tooltip's
                    top, bottom and end matches the vertical padding. */}
                <Kbd shortcut={shortcut} data-testid="tooltip-shortcut" />
              </span>
            ) : (
              <span>{label}</span>
            )}
            {link &&
              ('href' in link ? (
                <a
                  href={link.href}
                  {...(link.external === false
                    ? {}
                    : { target: '_blank', rel: 'noopener noreferrer' })}
                  data-testid={link.testId}
                  className={buttonClassName({ variant: 'link' })}
                >
                  {link.text ?? 'Learn more'}
                </a>
              ) : (
                <Button
                  variant="link"
                  onClick={link.onClick}
                  data-testid={link.testId}
                  className="self-start"
                >
                  {link.text}
                </Button>
              ))}
          </span>,
          portalBody,
        )}
    </span>
  );
}
