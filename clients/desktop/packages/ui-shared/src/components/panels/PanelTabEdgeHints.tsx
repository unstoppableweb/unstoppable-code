'use client';

import { ControlButton } from '../Button';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from 'react';
import { prefersReducedMotion } from '../../lib/reduced-motion';
import { ThinkingSpinner } from '../ThinkingSpinner';
import { Tooltip } from '../Tooltip';

/**
 * How far in from a strip edge a tab must sit to clear the "N running" hint
 * on that edge (the width it publishes on the strip's wrapper) and the fade
 * after it. 0 when no hint shows there.
 */
export function edgeHintClearance(
  strip: HTMLElement,
  side: 'start' | 'end',
): number {
  const wrap = strip.parentElement;
  if (wrap === null) return 0;
  const hintWidth =
    Number.parseFloat(
      wrap.style.getPropertyValue(
        `--canopy-panel-tab-edge-count-${side}-width`,
      ),
    ) || 0;
  if (hintWidth === 0) return 0;
  const fadeWidth =
    Number.parseFloat(
      getComputedStyle(wrap).getPropertyValue('--canopy-scroll-fade-width'),
    ) || 20;
  return hintWidth + fadeWidth + 4;
}

export interface HiddenBusyTabs {
  /** Busy tabs scrolled out past the strip's start, nearest last. */
  readonly start: readonly HTMLElement[];
  /** Busy tabs scrolled out past the strip's end, nearest first. */
  readonly end: readonly HTMLElement[];
  /** Scrolls the nearest hidden busy tab on that side into view. */
  readonly reveal: (side: 'start' | 'end') => void;
  /** The strip's visible width when last measured. */
  readonly width: number;
}

interface HiddenLists {
  readonly start: readonly HTMLElement[];
  readonly end: readonly HTMLElement[];
  /** The strip's visible width when last measured. */
  readonly width: number;
}

const NONE: HiddenLists = { start: [], end: [], width: 0 };

/** A tab counts as out of view once more than half of it is clipped. */
function measureHidden(strip: HTMLElement, busyAttribute: string): HiddenLists {
  const box = strip.getBoundingClientRect();
  // A tab under a hint (or its fade) is out of view too, not just one past
  // the strip's edge.
  // Not at a scroll limit, though: a tab at the very start or end is in
  // view there, so that side's hint goes away instead of covering it.
  const atStart = strip.scrollLeft <= 0;
  const atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
  const left = box.left + (atStart ? 0 : edgeHintClearance(strip, 'start'));
  const right = box.right - (atEnd ? 0 : edgeHintClearance(strip, 'end'));
  const start: HTMLElement[] = [];
  const end: HTMLElement[] = [];
  for (const busy of Array.from(
    strip.querySelectorAll<HTMLElement>(`[${busyAttribute}]`),
  )) {
    const tab = busy.closest<HTMLElement>('[role="tab"]');
    if (tab === null) continue;
    const rect = tab.getBoundingClientRect();
    const middle = rect.left + rect.width / 2;
    if (middle < left) start.push(tab);
    else if (middle > right) end.push(tab);
  }
  return { start, end, width: strip.clientWidth };
}

function sameTabs(
  a: readonly HTMLElement[],
  b: readonly HTMLElement[],
): boolean {
  return a.length === b.length && a.every((tab, index) => tab === b[index]);
}

/**
 * The busy tabs (those whose icon carries `busyAttribute`) scrolled out of an
 * overflowing strip, per side. Watches only while the strip overflows.
 */
export function useHiddenBusyTabs(
  stripRef: RefObject<HTMLElement | null>,
  overflowing: boolean,
  busyAttribute: string,
): HiddenBusyTabs {
  const [hidden, setHidden] = useState<HiddenLists>(NONE);

  useEffect(() => {
    const strip = stripRef.current;
    if (!overflowing || strip === null) {
      setHidden(NONE);
      return undefined;
    }
    const view = strip.ownerDocument.defaultView;
    let frame: number | null = null;
    const measure = (): void => {
      frame = null;
      const next = measureHidden(strip, busyAttribute);
      // The width only sizes the hints, so with nothing hidden on either
      // side a new width changes nothing: a window resize would otherwise
      // render the whole tab bar on every step.
      setHidden((previous) =>
        sameTabs(previous.start, next.start) &&
        sameTabs(previous.end, next.end) &&
        (previous.width === next.width ||
          next.start.length + next.end.length === 0)
          ? previous
          : next,
      );
    };
    const schedule = (): void => {
      if (frame === null) frame = view?.requestAnimationFrame(measure) ?? null;
    };
    measure();
    strip.addEventListener('scroll', schedule, { passive: true });
    // Work starts and stops inside the tabs' icons without the strip moving.
    const mutations =
      view && 'MutationObserver' in view
        ? new view.MutationObserver(schedule)
        : null;
    mutations?.observe(strip, {
      subtree: true,
      childList: true,
      attributes: true,
      // Selecting a tab changes tab widths (the selected tab keeps a wider
      // floor), which can move a running tab in or out of view.
      attributeFilter: [busyAttribute, 'data-active'],
    });
    // A hint publishes its width on the wrapper; a new width moves the edge
    // a tab counts as hidden past.
    if (strip.parentElement) {
      mutations?.observe(strip.parentElement, {
        attributes: true,
        attributeFilter: ['style'],
      });
    }
    const resize =
      view && 'ResizeObserver' in view
        ? new view.ResizeObserver(schedule)
        : null;
    resize?.observe(strip);
    return (): void => {
      strip.removeEventListener('scroll', schedule);
      mutations?.disconnect();
      resize?.disconnect();
      if (frame !== null) view?.cancelAnimationFrame(frame);
    };
  }, [stripRef, overflowing, busyAttribute]);

  const reveal = useCallback(
    (side: 'start' | 'end'): void => {
      const strip = stripRef.current;
      const tab =
        side === 'start'
          ? hidden.start[hidden.start.length - 1]
          : hidden.end[0];
      if (strip === null || tab === undefined) return;
      const box = strip.getBoundingClientRect();
      const rect = tab.getBoundingClientRect();
      // Clear of the edge fade and of any hint still on that edge, so the
      // tab lands fully readable.
      const margin = Math.max(48, edgeHintClearance(strip, side));
      // The hint clicked sets the direction: a tab under the start hint can
      // still be inside the strip.
      const delta =
        side === 'start'
          ? rect.left - box.left - margin
          : rect.right - box.right + margin;
      strip.scrollBy({
        left: delta,
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    },
    [stripRef, hidden],
  );

  return { start: hidden.start, end: hidden.end, reveal, width: hidden.width };
}

function hiddenRunningLabel(count: number, where: string): string {
  return `${count} running ${count === 1 ? 'tab' : 'tabs'} ${where}`;
}

/** The hint's 2px offset from the strip edge plus a 2px gap after it. */
const EDGE_HINT_CLEARANCE = 4;

/**
 * One edge's hint. It sizes to its text like a tab, and publishes its width
 * (`--canopy-panel-tab-edge-count-<side>-width`) on the strip wrap, which
 * clears the strip's mask under it.
 */
/**
 * Room a hint takes from its edge, with its fade and gap: the full "N
 * running" tile and the compact one (spinner and count), at the tabs' 13px.
 */
const FULL_HINT_CLEARANCE = 126;
const COMPACT_HINT_CLEARANCE = 78;

type EdgeHintSize = 'full' | 'compact';

/**
 * How the hints draw in a strip `width` wide that must still show a tab of
 * `minTabWidth` between them: spelled out while they fit, compact (spinner
 * and count) when only that fits, and not at all in a strip too narrow even
 * for that (its running tabs stay in the ⌄ list). The masks follow the
 * hints' own widths, so the tab is never left under either.
 */
function edgeHintSize(
  width: number,
  sides: number,
  minTabWidth: number,
): EdgeHintSize | null {
  const room = width - minTabWidth;
  if (sides * FULL_HINT_CLEARANCE <= room) return 'full';
  if (sides * COMPACT_HINT_CLEARANCE <= room) return 'compact';
  return null;
}

function EdgeHint({
  side,
  count,
  size,
  testIdPrefix,
  onReveal,
}: {
  readonly side: 'start' | 'end';
  readonly count: number;
  readonly size: EdgeHintSize;
  readonly testIdPrefix: string;
  readonly onReveal: () => void;
}): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const hint = ref.current;
    const wrap = hint?.closest<HTMLElement>('.canopy-panel-tab-strip-wrap');
    if (!hint || !wrap) return undefined;
    const property = `--canopy-panel-tab-edge-count-${side}-width`;
    const publish = (): void => {
      wrap.style.setProperty(
        property,
        `${Math.ceil(hint.getBoundingClientRect().width) + EDGE_HINT_CLEARANCE}px`,
      );
    };
    publish();
    const view = hint.ownerDocument.defaultView;
    const resize =
      view && 'ResizeObserver' in view
        ? new view.ResizeObserver(publish)
        : null;
    resize?.observe(hint);
    return (): void => {
      resize?.disconnect();
      wrap.style.removeProperty(property);
    };
  }, [side, size]);
  const label = hiddenRunningLabel(
    count,
    side === 'start' ? 'to the left' : 'to the right',
  );
  return (
    <span className="canopy-panel-tab-edge-anchor" data-side={side}>
      <Tooltip label={label}>
        <ControlButton
          ref={ref}
          type="button"
          presentation="panel-tab-edge-count"
          data-side={side}
          data-size={size}
          aria-label={label}
          tabIndex={-1}
          data-testid={`${testIdPrefix}-${side}`}
          onClick={onReveal}
        >
          <span className="canopy-panel-tab-edge-count-icon">
            {/* Deliberate deviation from DESIGN.md "run states use the intent
              roles": the accent, like the fill tabs' own running spinner and the
              sidebar's running worktree spinner it counts, so the hint matches
              the tabs. Moving all three to the info intent is separate work. */}
            <ThinkingSpinner sizePx={10} tone="accent" />
          </span>
          <span>{size === 'full' ? `${count} running` : count}</span>
        </ControlButton>
      </Tooltip>
    </span>
  );
}

/**
 * `edge-count`: a spinner and "N running" on the edge of the strip that
 * running tabs are scrolled past, drawn as a sibling tab. Spelled out, so it
 * does not read as one more tab; compact or left out where the strip is too
 * narrow (see {@link edgeHintSize}). Clicking it scrolls to the nearest of
 * them.
 */
export function PanelTabEdgeHints({
  hidden,
  minTabWidth,
  testIdPrefix = 'panel-tab-edge-hint',
}: {
  readonly hidden: HiddenBusyTabs;
  /** The narrowest tab the strip must still show between its hints. */
  readonly minTabWidth: number;
  readonly testIdPrefix?: string;
}): JSX.Element | null {
  const sides =
    (hidden.start.length > 0 ? 1 : 0) + (hidden.end.length > 0 ? 1 : 0);
  const size = edgeHintSize(hidden.width, sides, minTabWidth);
  if (sides === 0 || size === null) return null;
  return (
    <>
      {hidden.start.length > 0 ? (
        <EdgeHint
          side="start"
          count={hidden.start.length}
          size={size}
          testIdPrefix={testIdPrefix}
          onReveal={(): void => hidden.reveal('start')}
        />
      ) : null}
      {hidden.end.length > 0 ? (
        <EdgeHint
          side="end"
          count={hidden.end.length}
          size={size}
          testIdPrefix={testIdPrefix}
          onReveal={(): void => hidden.reveal('end')}
        />
      ) : null}
    </>
  );
}
