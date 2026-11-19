'use client';

import { useEffect, useState, type RefObject } from 'react';
import {
  SCROLLBAR_PROBE_ATTRIBUTE,
  SCROLLBAR_PROBE_STYLE,
} from './scrollbar-mode-script';

const PREFERENCE_ATTRIBUTE = 'data-scrollbar-behavior';
const NATIVE_SCROLLING_ATTRIBUTE = 'data-native-scrollbar-scrolling';
const NATIVE_HOVERED_ATTRIBUTE = 'data-native-scrollbar-hovered';
const NATIVE_SCROLLBAR_HIDE_DELAY_MS = 600;

interface NativePolicySubscription {
  subscriberCount: number;
  detach: () => void;
}

const nativePolicySubscriptions = new WeakMap<
  Document,
  NativePolicySubscription
>();

export type ResolvedScrollbarBehavior = 'always' | 'scroll' | 'hover' | 'never';

function readExplicitScrollbarBehavior(
  ownerDocument?: Document,
): ResolvedScrollbarBehavior | null {
  const targetDocument =
    ownerDocument ?? (typeof document === 'undefined' ? undefined : document);
  if (targetDocument === undefined) return null;
  const behavior = targetDocument.documentElement.dataset.scrollbarBehavior;
  return behavior === 'always' ||
    behavior === 'scroll' ||
    behavior === 'hover' ||
    behavior === 'never'
    ? behavior
    : null;
}

/**
 * Whether the OS is set to keep scrollbars permanently visible (macOS
 * "Show scroll bars: Always"; also the effective mode with a mouse attached
 * under "Automatically based on mouse or trackpad").
 *
 * There is no media query or Electron API for the scroller style, so this
 * probes the behavior itself: an `overflow: scroll` element reserves layout
 * width for a classic scrollbar and reserves none for an overlay one.
 */
export function measureNativeScrollbarWidth(): number {
  if (typeof document === 'undefined' || document.body === null) return 0;
  const probe = document.createElement('div');
  // See SCROLLBAR_PROBE_ATTRIBUTE: the global scrollbar styles skip it.
  probe.setAttribute(SCROLLBAR_PROBE_ATTRIBUTE, '');
  probe.style.cssText = SCROLLBAR_PROBE_STYLE;
  document.body.appendChild(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return width;
}

export function detectAlwaysVisibleScrollbars(): boolean {
  return measureNativeScrollbarWidth() > 0;
}

/**
 * Publishes the detected mode on the document root so stylesheets can size
 * every scrollbar — the overlay rails AND the native `::-webkit-scrollbar`
 * long tail — from one source:
 *
 *  - `data-scrollbars="always" | "overlay"` switches the geometry. The web
 *    root layout publishes the same value before first paint with
 *    `buildScrollbarModeScript`, so hydration does not change it.
 *  - `--canopy-native-scrollbar-width` carries the platform's own track width
 *    (15px on macOS) so the always-visible thumb matches native thickness
 *    instead of hard-coding a number.
 */
function publishScrollbarMode(
  behavior: ResolvedScrollbarBehavior,
  nativeWidth?: number,
  ownerDocument: Document = document,
): void {
  const root = ownerDocument.documentElement;
  root.dataset.scrollbars = behavior === 'always' ? 'always' : 'overlay';
  if (behavior === 'always' && nativeWidth !== undefined && nativeWidth > 0) {
    root.style.setProperty(
      '--canopy-native-scrollbar-width',
      `${nativeWidth}px`,
    );
  } else {
    root.style.removeProperty('--canopy-native-scrollbar-width');
  }
}

/**
 * One probe per document per task. Each probe forces a layout of the whole
 * document, and every scroll area resolves the behavior on mount and on every
 * window focus, so without sharing one focus costs one layout per scroll area.
 * An entry lives until the end of the task that measured it, so the scroll
 * areas mounting in one React flush share it. A focus clears it first (see
 * `installFocusInvalidation`), because a hidden window's timers can be
 * throttled for seconds and the setting usually changes while unfocused.
 */
interface SharedScrollbarWidth {
  width: number;
}

const sharedScrollbarWidths = new WeakMap<Document, SharedScrollbarWidth>();
const focusInvalidatedDocuments = new WeakSet<Document>();

function sharedNativeScrollbarWidth(ownerDocument: Document): number {
  const shared = sharedScrollbarWidths.get(ownerDocument);
  if (shared !== undefined) return shared.width;
  const entry: SharedScrollbarWidth = { width: measureNativeScrollbarWidth() };
  sharedScrollbarWidths.set(ownerDocument, entry);
  ownerDocument.defaultView?.setTimeout(() => {
    if (sharedScrollbarWidths.get(ownerDocument) === entry) {
      sharedScrollbarWidths.delete(ownerDocument);
    }
  }, 0);
  return entry.width;
}

/** Once per document, ahead of every scroll area's own focus listener. */
function installFocusInvalidation(ownerDocument: Document, view: Window): void {
  if (focusInvalidatedDocuments.has(ownerDocument)) return;
  focusInvalidatedDocuments.add(ownerDocument);
  view.addEventListener(
    'focus',
    (event) => {
      if (event.target === view) sharedScrollbarWidths.delete(ownerDocument);
    },
    true,
  );
}

function resolveScrollbarBehavior(
  ownerDocument: Document = document,
): ResolvedScrollbarBehavior {
  const explicit = readExplicitScrollbarBehavior(ownerDocument);
  if (explicit !== null) {
    publishScrollbarMode(explicit, undefined, ownerDocument);
    return explicit;
  }

  const nativeWidth = sharedNativeScrollbarWidth(ownerDocument);
  const resolved = nativeWidth > 0 ? 'always' : 'scroll';
  publishScrollbarMode(resolved, nativeWidth, ownerDocument);
  return resolved;
}

function findScrollableAncestor(
  target: EventTarget | null,
  ownerDocument: Document,
): Element | null {
  const view = ownerDocument.defaultView;
  if (view === null || !isElement(target)) return null;
  let element: Element | null = target;
  while (element !== null) {
    const style = view.getComputedStyle(element);
    const scrollsVertically =
      element.scrollHeight - element.clientHeight > 1 &&
      (style.overflowY === 'auto' || style.overflowY === 'scroll');
    const scrollsHorizontally =
      element.scrollWidth - element.clientWidth > 1 &&
      (style.overflowX === 'auto' || style.overflowX === 'scroll');
    if (scrollsVertically || scrollsHorizontally) {
      return element;
    }
    element = element.parentElement;
  }
  return null;
}

function isElement(target: EventTarget | null): target is Element {
  return (
    target !== null &&
    'nodeType' in target &&
    target.nodeType === 1 &&
    'setAttribute' in target &&
    'removeAttribute' in target
  );
}

function subscribeToNativeScrollbarActivity(
  ownerDocument: Document,
): () => void {
  let subscription = nativePolicySubscriptions.get(ownerDocument);
  if (subscription === undefined) {
    const view = ownerDocument.defaultView;
    if (view === null) return () => {};
    const timers = new Map<Element, number>();
    const markedElements = new Set<Element>();
    let hoveredElement: Element | null = null;
    const handleScroll = (event: Event): void => {
      if (readExplicitScrollbarBehavior(ownerDocument) !== 'scroll') return;
      const target = isElement(event.target)
        ? event.target
        : event.target === ownerDocument
          ? ownerDocument.scrollingElement
          : null;
      if (target === null) return;

      target.setAttribute(NATIVE_SCROLLING_ATTRIBUTE, 'true');
      markedElements.add(target);
      const existingTimer = timers.get(target);
      if (existingTimer !== undefined) view.clearTimeout(existingTimer);
      timers.set(
        target,
        view.setTimeout(() => {
          target.removeAttribute(NATIVE_SCROLLING_ATTRIBUTE);
          timers.delete(target);
          markedElements.delete(target);
        }, NATIVE_SCROLLBAR_HIDE_DELAY_MS),
      );
    };

    const updateHoveredElement = (next: Element | null): void => {
      if (next === hoveredElement) return;
      hoveredElement?.removeAttribute(NATIVE_HOVERED_ATTRIBUTE);
      hoveredElement = next;
      hoveredElement?.setAttribute(NATIVE_HOVERED_ATTRIBUTE, 'true');
    };
    const handlePointerOver = (event: PointerEvent): void => {
      if (readExplicitScrollbarBehavior(ownerDocument) !== 'hover') return;
      updateHoveredElement(findScrollableAncestor(event.target, ownerDocument));
    };
    const handlePointerOut = (event: PointerEvent): void => {
      if (readExplicitScrollbarBehavior(ownerDocument) !== 'hover') return;
      updateHoveredElement(
        findScrollableAncestor(event.relatedTarget, ownerDocument),
      );
    };

    ownerDocument.addEventListener('scroll', handleScroll, true);
    ownerDocument.addEventListener('pointerover', handlePointerOver, true);
    ownerDocument.addEventListener('pointerout', handlePointerOut, true);
    const detach = (): void => {
      ownerDocument.removeEventListener('scroll', handleScroll, true);
      ownerDocument.removeEventListener('pointerover', handlePointerOver, true);
      ownerDocument.removeEventListener('pointerout', handlePointerOut, true);
      for (const timer of timers.values()) view.clearTimeout(timer);
      for (const element of markedElements) {
        element.removeAttribute(NATIVE_SCROLLING_ATTRIBUTE);
      }
      timers.clear();
      markedElements.clear();
      updateHoveredElement(null);
    };
    subscription = { subscriberCount: 0, detach };
    nativePolicySubscriptions.set(ownerDocument, subscription);
  }
  subscription.subscriberCount += 1;

  return (): void => {
    if (subscription === undefined) return;
    subscription.subscriberCount -= 1;
    if (subscription.subscriberCount === 0) {
      subscription.detach();
      nativePolicySubscriptions.delete(ownerDocument);
    }
  };
}

/**
 * Live version of {@link detectAlwaysVisibleScrollbars} for the overlay scroll
 * areas: when the OS keeps scrollbars visible, they stop auto-hiding and stay
 * shown for as long as their content overflows.
 *
 * The setting can change while the app runs, and macOS sends no event for it,
 * so the probe re-runs whenever the window regains focus — the earliest moment
 * after a trip to System Settings.
 */
export function useAlwaysVisibleScrollbars(
  ownerElementRef?: RefObject<Element | null>,
): boolean {
  return useScrollbarBehavior(ownerElementRef) === 'always';
}

/**
 * Resolves the configured scrollbar policy. Explicit preferences are applied
 * directly and never invoke the native-scroller probe; only System performs
 * behavior detection. A root-attribute observer makes settings changes live,
 * while the focus listener refreshes System after visiting OS settings.
 */
export function useScrollbarBehavior(
  ownerElementRef?: RefObject<Element | null>,
): ResolvedScrollbarBehavior {
  const [behavior, setBehavior] = useState<ResolvedScrollbarBehavior>(
    () => readExplicitScrollbarBehavior() ?? 'scroll',
  );

  useEffect(() => {
    const ownerDocument = ownerElementRef?.current?.ownerDocument ?? document;
    const view = ownerDocument.defaultView ?? window;
    const sync = (): void => {
      setBehavior(resolveScrollbarBehavior(ownerDocument));
    };
    installFocusInvalidation(ownerDocument, view);
    sync();
    view.addEventListener('focus', sync);
    const observer = new view.MutationObserver((records) => {
      if (
        records.some((record) => record.attributeName === PREFERENCE_ATTRIBUTE)
      ) {
        sync();
      }
    });
    observer.observe(ownerDocument.documentElement, {
      attributes: true,
      attributeFilter: [PREFERENCE_ATTRIBUTE],
    });
    const unsubscribeNativeActivity =
      subscribeToNativeScrollbarActivity(ownerDocument);
    return (): void => {
      view.removeEventListener('focus', sync);
      observer.disconnect();
      unsubscribeNativeActivity();
    };
  }, [ownerElementRef]);

  return behavior;
}
