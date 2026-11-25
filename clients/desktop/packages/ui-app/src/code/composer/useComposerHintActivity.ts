'use client';

import { useEffect, useState, type RefObject } from 'react';

/** Visibility and IME state for a mounted composer, including hidden hosts. */
export function useComposerHintActivity(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
): { active: boolean; composing: boolean } {
  const [visible, setVisible] = useState(false);
  const [composing, setComposing] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) {
      setComposing(false);
      setVisible(false);
      return;
    }
    const update = (): void =>
      setVisible(enabled && node.getClientRects().length > 0);
    const start = (): void => setComposing(true);
    const end = (): void => setComposing(false);
    node.addEventListener('compositionstart', start, true);
    node.addEventListener('compositionend', end, true);
    // A hidden host takes the composer's layout box away, which a resize
    // observer reports after the browser's own layout. Watching every
    // ancestor's attributes instead measured the composer, and so laid the
    // page out, on each class or style change above it: every frame of a
    // sidebar or panel animation. That is kept only where there is no
    // resize observer.
    const resize =
      !enabled || typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(update);
    resize?.observe(node);
    const observer = new MutationObserver(update);
    for (
      let ancestor: HTMLElement | null = node;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      if (enabled && !resize)
        observer.observe(ancestor, {
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden'],
        });
    }
    // A resize observer reports once when it starts, after the browser's
    // layout; measuring here as well would lay the page out on every mount.
    if (!resize) update();
    return (): void => {
      observer.disconnect();
      resize?.disconnect();
      node.removeEventListener('compositionstart', start, true);
      node.removeEventListener('compositionend', end, true);
    };
  }, [ref, enabled]);
  return { active: enabled && visible, composing };
}
