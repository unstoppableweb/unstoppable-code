'use client';

import {
  createContext,
  useContext,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';

/**
 * Whether shared tooltips may stack. `stack` keeps each tooltip independent.
 * `single` shows one at a time per window: the tooltip or card that opens
 * closes the one already open, so a row's preview card can never sit over
 * another row's card or an unrelated control's tooltip. A row's card and the
 * tooltips of controls inside that row show together.
 */
export type TooltipStacking = 'stack' | 'single';

/** How every shared tooltip and hover card in a host behaves. */
export interface TooltipSettings {
  readonly stacking: TooltipStacking;
  /**
   * Hover delay before the first tooltip in a window opens. Once one is
   * showing, or closed less than {@link TOOLTIP_WARM_MS} ago, the next opens
   * at once. A trigger's own longer delay still applies to that first open.
   */
  readonly openDelay: number;
  /** How long a tooltip stays after the pointer leaves its trigger. */
  readonly closeDelay: number;
}

/** The hosts' timings: a short first delay, then instant handoff. */
export const HOST_TOOLTIP_TIMINGS = {
  openDelay: 400,
  closeDelay: 150,
} as const satisfies Partial<TooltipSettings>;

/** After the last tooltip closes, how long the next one still opens at once. */
export const TOOLTIP_WARM_MS = 400;
/** The slide from the previous tooltip's place to the next one's. */
const HANDOFF_SLIDE_MS = 120;

const DEFAULT_TOOLTIP_SETTINGS: TooltipSettings = {
  stacking: 'stack',
  openDelay: 0,
  closeDelay: 0,
};

const TooltipSettingsContext = createContext<TooltipSettings>(
  DEFAULT_TOOLTIP_SETTINGS,
);

/**
 * The one tooltip provider. Desktop and web mount it once at their root;
 * a nested provider overrides only the settings it names.
 */
export function TooltipProvider({
  stacking,
  openDelay,
  closeDelay,
  children,
}: Partial<TooltipSettings> & {
  readonly children: ReactNode;
}): JSX.Element {
  const parent = useContext(TooltipSettingsContext);
  const value = useMemo(
    (): TooltipSettings => ({
      stacking: stacking ?? parent.stacking,
      openDelay: openDelay ?? parent.openDelay,
      closeDelay: closeDelay ?? parent.closeDelay,
    }),
    [closeDelay, openDelay, parent, stacking],
  );
  return (
    <TooltipSettingsContext.Provider value={value}>
      {children}
    </TooltipSettingsContext.Provider>
  );
}

/**
 * The provider each host mounts at its root, with {@link HOST_TOOLTIP_TIMINGS}.
 * A server layout cannot spread those timings itself: a constant imported
 * from this client module is only a reference there, not its value.
 */
export function HostTooltipProvider({
  stacking,
  children,
}: {
  readonly stacking?: TooltipStacking;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <TooltipProvider stacking={stacking} {...HOST_TOOLTIP_TIMINGS}>
      {children}
    </TooltipProvider>
  );
}

interface SurfaceRect {
  readonly top: number;
  readonly centerX: number;
}

interface OpenTooltip {
  readonly close: () => void;
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly surfaceRef: RefObject<HTMLElement | null>;
  /** The pointer has left the trigger and the close is pending. */
  leaving: boolean;
  rect: SurfaceRect | null;
}

interface TooltipWindow {
  readonly entries: Set<OpenTooltip>;
  lastClosedAt: number;
  lastRect: SurfaceRect | null;
}

const tooltipWindows = new WeakMap<Document, TooltipWindow>();

function tooltipWindow(doc: Document): TooltipWindow {
  let state = tooltipWindows.get(doc);
  if (!state) {
    state = {
      entries: new Set(),
      lastClosedAt: Number.NEGATIVE_INFINITY,
      lastRect: null,
    };
    tooltipWindows.set(doc, state);
  }
  return state;
}

/**
 * Whether a tooltip on `trigger` belongs with an open one instead of
 * replacing it: its trigger sits inside the open tooltip's surface (a control
 * inside an interactive card), inside the open tooltip's trigger (a control
 * inside a row whose card is open), or around it (the row's card opening
 * while one of its controls shows a tooltip).
 */
function belongsWith(open: OpenTooltip, trigger: HTMLElement): boolean {
  const openTrigger = open.triggerRef.current;
  return (
    open.surfaceRef.current?.contains(trigger) === true ||
    openTrigger?.contains(trigger) === true ||
    (openTrigger !== null && trigger.contains(openTrigger))
  );
}

function measure(surface: HTMLElement): SurfaceRect {
  const rect = surface.getBoundingClientRect();
  return { top: rect.top, centerX: rect.left + rect.width / 2 };
}

export interface TooltipHandoff {
  /**
   * The hover delay to wait before opening: 0 while a tooltip the pointer
   * just left is still showing or closed less than {@link TOOLTIP_WARM_MS}
   * ago, otherwise the longer of `requested`
   * and the host's first-open delay.
   */
  readonly pointerOpenDelay: (requested: number) => number;
  /** How long to wait after the pointer leaves before closing. */
  readonly closeDelay: number;
  /**
   * Marks a pending close: a tooltip that opens meanwhile replaces this one
   * at once instead of showing beside it.
   */
  readonly setLeaving: (leaving: boolean) => void;
}

/**
 * Shared hover behaviour for every tooltip and hover card. While `open`, it
 * claims the window's open-tooltip slot: a tooltip still showing for a
 * trigger the pointer has left closes at once, and with `single` stacking so
 * does every open tooltip it does not belong with (see `belongsWith`), so
 * moving along a row of buttons never blinks. The new surface appears at
 * its own place at once; with `slide` it instead slides from the previous
 * one's place once `positioned` (tab hover cards).
 */
export function useTooltipHandoff({
  open,
  positioned,
  close,
  triggerRef,
  surfaceRef,
  slide = false,
}: {
  readonly open: boolean;
  /** The surface has its final position (it renders hidden until then). */
  readonly positioned: boolean;
  readonly close: () => void;
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly surfaceRef: RefObject<HTMLElement | null>;
  /** Slide from the previous surface's place instead of appearing at once. */
  readonly slide?: boolean;
}): TooltipHandoff {
  const settings = useContext(TooltipSettingsContext);
  const entryRef = useRef<OpenTooltip | null>(null);
  const slideFromRef = useRef<SurfaceRect | null>(null);
  const { stacking } = settings;

  useLayoutEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    const trigger = triggerRef.current;
    if (!trigger) return undefined;
    const state = tooltipWindow(trigger.ownerDocument);
    let from: SurfaceRect | null = null;
    for (const other of [...state.entries]) {
      if (other.close === close || belongsWith(other, trigger)) continue;
      if (!other.leaving && stacking !== 'single') continue;
      from = other.rect ?? from;
      state.entries.delete(other);
      other.close();
    }
    if (!from && Date.now() - state.lastClosedAt < TOOLTIP_WARM_MS) {
      from = state.lastRect;
    }
    slideFromRef.current = from;
    const entry: OpenTooltip = {
      close,
      triggerRef,
      surfaceRef,
      leaving: false,
      rect: null,
    };
    state.entries.add(entry);
    entryRef.current = entry;
    return (): void => {
      // Only a pointer moving on warms the window; a close by click,
      // Escape, blur or unmount does not.
      if (state.entries.delete(entry) && entry.leaving) {
        state.lastClosedAt = Date.now();
        state.lastRect = entry.rect;
      }
      if (entryRef.current === entry) entryRef.current = null;
    };
  }, [stacking, open, close, triggerRef, surfaceRef]);

  // Slide in from the previous surface, then remember where this one sits
  // so the next tooltip can slide from it. Measured once it is positioned
  // and again when its size changes, never on each render: an open tooltip
  // renders with its parent (a control under a streaming reply), and each
  // measurement there made the browser lay the page out.
  useLayoutEffect((): (() => void) | undefined => {
    const surface = surfaceRef.current;
    const entry = entryRef.current;
    if (!open || !positioned || !surface || !entry) return undefined;
    const rect = measure(surface);
    entry.rect = rect;
    const resized =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((): void => {
            entry.rect = measure(surface);
          });
    resized?.observe(surface);
    const stop = (): void => resized?.disconnect();
    const from = slideFromRef.current;
    slideFromRef.current = null;
    if (!slide || !from || typeof surface.animate !== 'function') return stop;
    const view = surface.ownerDocument.defaultView;
    if (view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return stop;
    }
    const dx = from.centerX - rect.centerX;
    const dy = from.top - rect.top;
    if (dx === 0 && dy === 0) return stop;
    surface.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], {
      duration: HANDOFF_SLIDE_MS,
      easing: 'ease-out',
    });
    return stop;
  }, [open, positioned, slide, surfaceRef]);

  const pointerOpenDelay = useCallback(
    (requested: number): number => {
      const trigger = triggerRef.current;
      if (trigger) {
        const state = tooltipWindow(trigger.ownerDocument);
        // A tooltip the pointer just left, other than one this trigger
        // sits in or around (a row's card and its controls are layers,
        // not neighbours).
        const showing = [...state.entries].some(
          (other) =>
            other.leaving &&
            other.triggerRef !== triggerRef &&
            !belongsWith(other, trigger),
        );
        if (showing || Date.now() - state.lastClosedAt < TOOLTIP_WARM_MS) {
          return 0;
        }
      }
      return Math.max(requested, settings.openDelay);
    },
    [settings.openDelay, triggerRef],
  );

  const setLeaving = useCallback((leaving: boolean): void => {
    if (entryRef.current) entryRef.current.leaving = leaving;
  }, []);

  return useMemo(
    (): TooltipHandoff => ({
      pointerOpenDelay,
      closeDelay: settings.closeDelay,
      setLeaving,
    }),
    [pointerOpenDelay, setLeaving, settings.closeDelay],
  );
}
