'use client';

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import {
  escapeStartedInBoundary,
  registerShowingEscapeTooltip,
} from './useOverlayEscape';

/** Whether a key press belongs to an IME composition rather than the page. */
export function isImeComposing(event: KeyboardEvent): boolean {
  // Safari reports the composition-ending Escape with `isComposing` false
  // but the legacy 229 key code.
  return event.isComposing || event.keyCode === 229;
}

/**
 * While a tooltip is showing, Escape anywhere in its trigger's document
 * closes it (WCAG 1.4.13: dismissable without moving the pointer or focus),
 * including a tip the pointer opened while focus sits elsewhere.
 *
 * The listener sits on the window in the bubble phase, on purpose: after
 * the focused control's own handlers, so a tip resting under the pointer
 * never pre-empts that control's Escape (SearchField clearing,
 * InlineTextInput cancelling). React listens at its root container, which
 * on web is the document itself (Next.js hydrates it), so anything closer
 * than the window would run first there. Dialogs and sheets still yield:
 * while a tip shows it is registered with `useOverlayEscape`, whose document
 * listeners then leave the press to the tip, so one press closes the tip and
 * keeps the overlay beneath it open.
 *
 * It is attached only while a tip shows, so with none open Escape reaches
 * everything as before. A press something else already handled
 * (`defaultPrevented`) is left alone, and so is one from inside a menu,
 * listbox or other widget that owns Escape, as `useOverlayEscape` leaves it:
 * that widget closes, taking a tip on one of its rows with it. Its own
 * handler usually runs first anyway; this keeps a menu that listens on the
 * document behaving the same.
 */
export function useTooltipEscape({
  active,
  triggerRef,
  onEscape,
}: {
  readonly active: boolean;
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly onEscape: () => void;
}): void {
  const onEscapeRef = useRef(onEscape);
  useLayoutEffect((): void => {
    onEscapeRef.current = onEscape;
  });

  useEffect((): (() => void) | undefined => {
    if (!active) return undefined;
    const ownerDocument = triggerRef.current?.ownerDocument;
    const view = ownerDocument?.defaultView;
    if (!ownerDocument || !view) return undefined;
    const unregister = registerShowingEscapeTooltip(ownerDocument);
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        isImeComposing(event) ||
        escapeStartedInBoundary(event.target, ownerDocument)
      ) {
        return;
      }
      event.preventDefault();
      onEscapeRef.current();
    };
    view.addEventListener('keydown', handleKeyDown);
    return (): void => {
      unregister();
      view.removeEventListener('keydown', handleKeyDown);
    };
  }, [active, triggerRef]);
}
