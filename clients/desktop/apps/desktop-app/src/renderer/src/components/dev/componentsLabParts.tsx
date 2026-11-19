import { Heading, Surface } from '@canopy/ui-shared/components';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';

/**
 * Layout helpers for the components library's specimen sheets. They only
 * place the real shared components on the page and label each cell; they
 * never restyle what they hold.
 */

/**
 * `data-lab-toc` marks a heading the sheet's "On this page" list offers.
 * Sheets that title their sections themselves set it on their own headings.
 */
export const LAB_TOC_SELECTOR = '[data-lab-toc]';

/**
 * One titled section of a sheet. The title is short: `Variants`, `Sizes`,
 * `States` on a sheet about one component, or the component's own name on a
 * sheet that holds several. What a reader should do or notice ("click to
 * open", a size, a rule) goes in `hint`, the quiet line under the title.
 */
export function SpecimenPanel({
  title,
  hint,
  children,
}: {
  readonly title?: string;
  readonly hint?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {title ? (
        <div className="flex flex-col gap-0.5">
          <Heading level={3} variant="title" data-lab-toc="">
            {title}
          </Heading>
          {hint ? (
            <p className="text-xs text-pretty fg-tertiary">{hint}</p>
          ) : null}
        </div>
      ) : null}
      <Surface variant="group" padding="default" gap="group">
        {children}
      </Surface>
    </div>
  );
}

/**
 * The boxes a cell lays out: its children, looking through wrappers that
 * draw no box of their own (`display: contents`, as `FocusOnMount`'s).
 */
function flowBoxes(parent: Element): Element[] {
  return Array.from(parent.children).flatMap((child) =>
    getComputedStyle(child).display === 'contents' ? flowBoxes(child) : [child],
  );
}

// A row that bleeds 4px past its column on purpose (a list's `-mx-1` rows)
// is not a spill: a wider cell would not change it, and it stays inside the
// 16px gap between cells.
const SPILL_TOLERANCE_PX = 4;

/** True when a specimen is wider than the cell it was given. */
function spillsFrom(box: Element): boolean {
  const limit = box.getBoundingClientRect().right + SPILL_TOLERANCE_PX;
  return flowBoxes(box).some(
    (child) => child.getBoundingClientRect().right > limit,
  );
}

/**
 * A labelled cell: the specimen, then a quiet caption under it.
 *
 * A specimen never draws over its neighbour. When it is wider than the grid
 * column it was given (a tab bar, a long label that does not truncate), the
 * cell takes the whole row instead, as `wide` does. Only the specimen's own
 * box counts: a badge or hit area a component hangs off its corner is part
 * of that component, not a spill.
 */
export function SpecimenCell({
  label,
  children,
  wide = false,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly wide?: boolean;
}): JSX.Element {
  const content = useRef<HTMLDivElement>(null);
  const [spills, setSpills] = useState(false);
  useLayoutEffect(() => {
    const box = content.current;
    if (!box || wide) return;
    const measure = (): void => {
      if (spillsFrom(box)) setSpills(true);
    };
    measure();
    // A specimen can grow after mount (a font, an image, a live control).
    const observer = new ResizeObserver(measure);
    for (const child of flowBoxes(box)) observer.observe(child);
    // A resized window changes the columns: try the narrow cell again.
    let frame = 0;
    const retry = (): void => {
      setSpills(false);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    window.addEventListener('resize', retry);
    return (): void => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', retry);
    };
  }, [wide]);
  return (
    <div
      className={`flex min-w-0 flex-col gap-1.5${wide || spills ? ' col-span-full' : ''}`}
    >
      <div
        ref={content}
        className="flex min-h-9 min-w-0 flex-wrap items-center gap-2"
      >
        {children}
      </div>
      <span className="text-2xs fg-tertiary">{label}</span>
    </div>
  );
}

/** A responsive grid of cells that wraps to one column at phone width. */
export function SpecimenGrid({
  children,
  min = 160,
}: {
  readonly children: ReactNode;
  /** Narrowest cell, in CSS px. */
  readonly min?: number;
}): JSX.Element {
  return (
    <div
      className="grid gap-4"
      style={{
        gridTemplateColumns: `repeat(auto-fill, minmax(min(${min}px, 100%), 1fr))`,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Gives its first focusable descendant real browser focus once on mount, so
 * a "Focused" cell shows the focus ring without a pointer. Only one cell per
 * sheet should use it; focus moves to whichever mounted last.
 */
export function FocusOnMount({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const target = ref.current?.querySelector<HTMLElement>(
      'button, input, textarea, [tabindex]',
    );
    target?.focus({ preventScroll: true });
  }, []);
  return (
    <span ref={ref} className="contents">
      {children}
    </span>
  );
}
