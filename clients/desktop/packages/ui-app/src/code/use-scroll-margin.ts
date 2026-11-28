import { useCallback, useLayoutEffect, useState } from 'react';

/**
 * How far a list nested inside `scrollElement` starts from the top of the
 * scrolled content, for a virtualizer's `scrollMargin`. Remeasured when the
 * scroller, its direct children or the list resize, and when the window
 * does, since content above the list can grow or shrink.
 */
export function useScrollMargin(
  listRef: { readonly current: HTMLElement | null },
  scrollElement: HTMLElement | null,
): number {
  const [scrollMargin, setScrollMargin] = useState(0);
  const measure = useCallback((): void => {
    const listElement = listRef.current;
    if (listElement === null || scrollElement === null) return;
    const margin = Math.round(
      listElement.getBoundingClientRect().top -
        scrollElement.getBoundingClientRect().top +
        scrollElement.scrollTop,
    );
    setScrollMargin((previous) => (previous === margin ? previous : margin));
  }, [scrollElement, listRef]);

  useLayoutEffect(measure);
  useLayoutEffect(() => {
    if (scrollElement === null) return undefined;
    const view = scrollElement.ownerDocument.defaultView;
    if (view === null) return undefined;
    const observer =
      typeof view.ResizeObserver === 'undefined'
        ? null
        : new view.ResizeObserver((): void => measure());
    if (observer !== null) {
      observer.observe(scrollElement);
      for (const child of Array.from(scrollElement.children)) {
        observer.observe(child);
      }
      if (listRef.current !== null) observer.observe(listRef.current);
    }
    view.addEventListener('resize', measure);
    return (): void => {
      observer?.disconnect();
      view.removeEventListener('resize', measure);
    };
  }, [measure, scrollElement, listRef]);

  return scrollMargin;
}
