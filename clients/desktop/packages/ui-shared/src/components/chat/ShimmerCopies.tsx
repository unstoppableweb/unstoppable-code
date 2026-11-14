import type { JSX, ReactNode } from 'react';

/**
 * The drawing layers of the live-step shimmer (`canopy-text-shimmer-strong`
 * in the tokens CSS), which sweeps on the compositor. Render it as the last
 * child of the shimmering element, with that element's children, only while
 * it shimmers:
 *
 * ```tsx
 * <span className={`min-w-0 truncate${running ? ' canopy-text-shimmer-strong' : ''}`}>
 *   {words}
 *   {running && <ShimmerCopies>{words}</ShimmerCopies>}
 * </span>
 * ```
 *
 * The element keeps its words (layout, selection, accessible text) with
 * their glyphs unpainted. Two `aria-hidden`, `inert` copies draw them, and
 * take the element's layout through `inherit`, so the element must be its
 * own box (a flex or grid item, or `truncate`) and its children lay out the
 * same in a copy. The children render three times while it shimmers;
 * `data-search-skip` keeps the copies out of content search.
 */
export function ShimmerCopies({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <span
      className="canopy-shimmer-layers"
      aria-hidden="true"
      inert
      data-search-skip=""
    >
      <span className="canopy-shimmer-window" data-shimmer-layer="ink">
        <span className="canopy-shimmer-copy">{children}</span>
      </span>
      <span className="canopy-shimmer-window" data-shimmer-layer="band">
        <span className="canopy-shimmer-copy">{children}</span>
      </span>
    </span>
  );
}
