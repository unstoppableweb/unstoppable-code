import {
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from 'react';
import { Skeleton as MeasuredSkeleton } from 'skullet/react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Spread onto an element inside a `Skeleton` to draw it as itself while the
 * rest loads: a heading, a column head, a label that is already known. Only
 * the values around it turn into bars.
 */
export const SKELETON_KEEP = { 'skullet-own': '' } as const;

export interface SkeletonProps {
  /** True while the content is on its way. */
  readonly loading: boolean;
  /**
   * The content's own layout. While loading, render it with sample data of
   * the real shape: skullet lays it out unseen and draws a capsule over each
   * line of text and a block over each image, field and control, so the
   * content replaces the skeleton in place.
   */
  readonly children: ReactNode;
  /** What the status region announces while loading. */
  readonly label?: string;
  /** Placement only: margin, width, and flex participation. */
  readonly className?: string;
  /** Marks the status region while loading. */
  readonly testId?: string;
}

const subscribeNever = (): (() => void) => () => {};

/**
 * False while the server renders and the client hydrates. skullet measures
 * in the browser, and its server-rendered form brings an inline script the
 * web policy's script nonce would refuse.
 */
function useMeasurable(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}

const subscribeReducedMotion = (onChange: () => void): (() => void) => {
  const query =
    typeof window === 'undefined'
      ? null
      : (window.matchMedia?.(REDUCED_MOTION_QUERY) ?? null);
  query?.addEventListener?.('change', onChange);
  return () => query?.removeEventListener?.('change', onChange);
};

/**
 * Whether reduced motion is on, live. skullet reads it only when it draws, so
 * the measured layer is drawn again whenever it changes.
 */
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia?.(REDUCED_MOTION_QUERY).matches === true,
    () => false,
  );
}

/** Text that is only a separator: a bullet, a bar, a dash or a slash. */
const SEPARATOR_TEXT = /^[•·|/\-–—]$/u;
/** At or under this size (px) a mark without text is a dot or an icon. */
const SMALL_MARK_PX = 18;
const DROP_ATTRIBUTE = 'data-skeleton-drop';
/** At or under this height (px) a filled element is a chip: a badge, a button. */
const CHIP_MAX_HEIGHT_PX = 32;
/** Wider than this (px), a filled element is a surface (a table head), not a chip. */
const CHIP_MAX_WIDTH_PX = 200;
const CHIP_ATTRIBUTE = 'data-skeleton-chip';
/** skullet draws an element with this attribute as one block. */
const SKULLET_BLOCK = 'skullet-block';

/**
 * A small element with its own fill, outside running text: drawn as one
 * plain grey block. Inline code or a mark inside a sentence stays part of
 * the sentence's bar.
 */
function isChip(element: Element): boolean {
  const { width, height } = element.getBoundingClientRect();
  if (height > CHIP_MAX_HEIGHT_PX || width > CHIP_MAX_WIDTH_PX) return false;
  const style = getComputedStyle(element);
  if (style.display === 'inline') return false;
  const fill = style.backgroundColor;
  return fill !== 'transparent' && fill !== 'rgba(0, 0, 0, 0)';
}

/**
 * Whether an element of the measured copy is a detail low fidelity leaves
 * out: a separator, or a small mark (a status dot, an icon) on a line that
 * also holds text, so the line draws as one bar.
 */
function isLowFidelityDetail(element: Element): boolean {
  const text = element.textContent?.trim() ?? '';
  if (SEPARATOR_TEXT.test(text)) return true;
  if (text !== '') return false;
  const { width, height } = element.getBoundingClientRect();
  // No layout box yet (a hidden tab): decide once it has one.
  if (width === 0 && height === 0) return false;
  if (width > SMALL_MARK_PX || height > SMALL_MARK_PX) return false;
  // A small icon is left out wherever it sits; a dot only beside text.
  if (element instanceof SVGElement || element instanceof HTMLImageElement) {
    return true;
  }
  return (element.parentElement?.textContent?.trim() ?? '') !== '';
}

/** skullet leaves an element with this attribute out but keeps its space. */
const SKULLET_IGNORE = 'skullet-ignore';

/**
 * A text field wider than a chip (a search box): drawn whole it would be one
 * large solid block, so it is left out and keeps its space.
 */
function isWideField(element: Element): boolean {
  if (
    !(element instanceof HTMLInputElement) &&
    !(element instanceof HTMLTextAreaElement) &&
    !(element instanceof HTMLSelectElement)
  ) {
    return false;
  }
  return element.getBoundingClientRect().width > CHIP_MAX_WIDTH_PX;
}

/** Leaves whose content is their own paint: never an empty slot. */
const REPLACED_ELEMENTS = new Set([
  'AUDIO',
  'CANVAS',
  'EMBED',
  'IFRAME',
  'IMG',
  'INPUT',
  'OBJECT',
  'PICTURE',
  'SELECT',
  'TEXTAREA',
  'VIDEO',
]);

function hasPaint(style: CSSStyleDeclaration): boolean {
  const fill = style.backgroundColor;
  return (
    (fill !== 'transparent' && fill !== 'rgba(0, 0, 0, 0)') ||
    style.backgroundImage !== 'none' ||
    parseFloat(style.borderTopWidth) > 0 ||
    parseFloat(style.borderLeftWidth) > 0
  );
}

/**
 * An empty, unpainted element: a slot that holds a status only sometimes,
 * or a spacer. skullet writes a line of sample text into empty text
 * elements to measure, which would draw a bar where the row shows nothing
 * and join it to the line beside it.
 */
function isEmptySlot(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (REPLACED_ELEMENTS.has(element.tagName)) return false;
  if (element.childElementCount > 0) return false;
  if ((element.textContent ?? '') !== '') return false;
  return !hasPaint(getComputedStyle(element));
}

/** Where the sample copy keeps the test ids it was rendered with. */
const SAMPLE_TEST_ID = 'data-skeleton-testid';

/**
 * Moves the sample copy's test ids aside, so a locator waiting for the real
 * content (a loaded row, a list) never matches the unseen samples.
 */
function hideSampleTestIds(root: HTMLElement): void {
  for (const element of root.querySelectorAll(
    '[skullet-loading] [data-testid]',
  )) {
    element.setAttribute(
      SAMPLE_TEST_ID,
      element.getAttribute('data-testid') ?? '',
    );
    element.removeAttribute('data-testid');
  }
}

/** Marks the low-fidelity details in the measured copy under `root`. */
function markLowFidelityDetails(root: HTMLElement): void {
  // Only the sample copy: skullet's own layer is never a detail.
  for (const element of root.querySelectorAll('[skullet-ghost] *')) {
    if (element.hasAttribute(DROP_ATTRIBUTE)) continue;
    if (element.closest(`[${DROP_ATTRIBUTE}], [skullet-own]`)) continue;
    if (element.closest(`[${CHIP_ATTRIBUTE}]`)) continue;
    // An empty slot keeps its space: dropping it would move the text beside
    // it off the line the loaded row draws it on.
    if (isEmptySlot(element) || isWideField(element)) {
      element.setAttribute(SKULLET_IGNORE, '');
    } else if (isLowFidelityDetail(element)) {
      element.setAttribute(DROP_ATTRIBUTE, '');
    } else if (isChip(element)) {
      element.setAttribute(CHIP_ATTRIBUTE, '');
      element.setAttribute(SKULLET_BLOCK, '');
    }
  }
}

/** Bars narrower than this (px) are slivers: a full stop, a lone glyph. */
const SLIVER_MAX_WIDTH_PX = 8;
/**
 * A block this close to square (px) is a mark, not a sliver: a status dot in
 * its own slot (a row's leading dot) stays as a small neutral dot.
 */
const MARK_SQUARENESS_PX = 1;
/** Bars whose top and height agree within this (px) sit on one line. */
const SAME_LINE_PX = 2;
/** Only bars this short (px) are text; taller blocks are controls. */
const TEXT_BAR_MAX_HEIGHT_PX = 20;
/** Text runs this close (px) are one line; a wider gap separates items. */
const SAME_RUN_GAP_PX = 24;

interface DrawnBar {
  readonly element: HTMLElement;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function readBar(element: HTMLElement): DrawnBar {
  return {
    element,
    left: parseFloat(element.style.left),
    top: parseFloat(element.style.top),
    width: parseFloat(element.style.width),
    height: parseFloat(element.style.height),
  };
}

/** Trims a drawn bar to the skeleton's width, or removes it when outside. */
function clipToWidth(element: HTMLElement, maxWidth: number): void {
  const left = parseFloat(element.style.left);
  const width = parseFloat(element.style.width);
  if (Number.isNaN(left) || Number.isNaN(width)) return;
  if (left >= maxWidth) {
    element.remove();
  } else if (left + width > maxWidth) {
    element.style.width = `${maxWidth - left}px`;
  }
}

/**
 * Simplifies what skullet drew: slivers go (a status dot, being square,
 * stays), and the text runs of one line
 * (same top and height, short enough to be text, and close together) merge
 * into one bar from the first's start to the last's end. Controls, and items
 * a wide gap apart, keep their own blocks.
 */
function simplifyDrawnBars(layer: ShadowRoot): void {
  const lines: DrawnBar[][] = [];
  // skullet measures content a frame scrolls or clips; bars stay inside the
  // skeleton's own width.
  const maxWidth =
    layer.host instanceof HTMLElement ? layer.host.clientWidth : 0;
  // A copy: removing a sliver from the live list would skip the next bar.
  for (const child of Array.from(layer.children)) {
    if (child instanceof HTMLElement && maxWidth > 0) {
      clipToWidth(child, maxWidth);
    }
    if (
      !(child instanceof HTMLElement) ||
      !child.isConnected ||
      !child.hasAttribute('skullet-rect')
    ) {
      continue;
    }
    const bar = readBar(child);
    if (
      bar.width < SLIVER_MAX_WIDTH_PX &&
      Math.abs(bar.width - bar.height) > MARK_SQUARENESS_PX
    ) {
      child.remove();
      continue;
    }
    const line = lines.find((run) => {
      const first = run[0];
      const last = run.at(-1);
      if (first === undefined || last === undefined) return false;
      return (
        bar.height <= TEXT_BAR_MAX_HEIGHT_PX &&
        Math.abs(first.top - bar.top) <= SAME_LINE_PX &&
        Math.abs(first.height - bar.height) <= SAME_LINE_PX &&
        bar.left - (last.left + last.width) <= SAME_RUN_GAP_PX
      );
    });
    if (line) line.push(bar);
    else lines.push([bar]);
  }
  for (const [first, ...rest] of lines) {
    if (first === undefined || rest.length === 0) continue;
    const bars = [first, ...rest];
    const left = Math.min(...bars.map((bar) => bar.left));
    const right = Math.max(...bars.map((bar) => bar.left + bar.width));
    first.element.style.left = `${left}px`;
    first.element.style.width = `${right - left}px`;
    for (const bar of rest) bar.element.remove();
  }
  centerPillsOnLines(lines);
}

/** A block at least this many times as wide as tall is a pill (a badge). */
const PILL_ASPECT = 2;

/**
 * A pill on the same line as a shorter bar (a badge beside a name) sits
 * centred on that bar, not on the font box the measured badge sat on.
 */
function centerPillsOnLines(lines: readonly DrawnBar[][]): void {
  const heads = lines.flatMap(([first]) => (first ? [first] : []));
  for (const pill of heads) {
    if (pill.width < pill.height * PILL_ASPECT) continue;
    const line = heads.find(
      (bar) =>
        bar !== pill &&
        bar.height < pill.height &&
        bar.top < pill.top + pill.height &&
        pill.top < bar.top + bar.height,
    );
    if (!line) continue;
    const top = line.top + (line.height - pill.height) / 2;
    pill.element.style.top = `${top}px`;
  }
}

/**
 * skullet draws by adding bars and by restyling the bars it has, so both
 * count as a new drawing.
 */
const DRAWN_BAR_CHANGES: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['style'],
};

/**
 * Keeps skullet's drawing simplified: skullet draws again on resize and on
 * changes to the copy, so each drawing is simplified as it lands.
 */
function watchDrawnBars(root: HTMLElement): () => void {
  const layer = root.querySelector('[skullet-layer]')?.shadowRoot;
  if (!layer) return () => undefined;
  const observer = new MutationObserver(() => {
    observer.disconnect();
    simplifyDrawnBars(layer);
    observer.observe(layer, DRAWN_BAR_CHANGES);
  });
  simplifyDrawnBars(layer);
  observer.observe(layer, DRAWN_BAR_CHANGES);
  return () => observer.disconnect();
}

/**
 * A skeleton in the content's final layout, measured by skullet from the
 * content itself. It is low fidelity: one grey bar per line of text and one
 * grey block per control, without tints, separators, slivers, small icons
 * beside text, empty slots or indents; a status dot in its own slot stays as
 * a small dot. Give it plain sample data: a few short lines per item. Wrap it in
 * `DelayedLoadingPlaceholder` so fast loads never flash it. Once loaded, the content renders directly with no skullet
 * wrapper, so nothing observes it and no shape is written to storage.
 */
export function Skeleton({
  loading,
  children,
  label = 'Loading',
  className = '',
  testId,
}: SkeletonProps): JSX.Element {
  const measurable = useMeasurable();
  const reducedMotion = useReducedMotion();
  const statusRef = useRef<HTMLDivElement>(null);
  // Runs after skullet has laid the copy out; skullet measures it again on
  // the attribute change.
  useLayoutEffect(() => {
    if (loading && measurable && statusRef.current) {
      hideSampleTestIds(statusRef.current);
      markLowFidelityDetails(statusRef.current);
    }
  });
  useLayoutEffect(() => {
    if (!loading || !measurable || !statusRef.current) return undefined;
    return watchDrawnBars(statusRef.current);
  }, [loading, measurable, reducedMotion]);
  if (!loading) {
    return <div className={className}>{children}</div>;
  }
  return (
    <div
      ref={statusRef}
      role="status"
      data-testid={testId}
      data-skeleton-fidelity="low"
      className={className}
    >
      <span className="sr-only">{label}</span>
      {measurable ? (
        <MeasuredSkeleton key={reducedMotion ? 'still' : 'pulsing'} loading>
          {children}
        </MeasuredSkeleton>
      ) : (
        <div aria-hidden="true" inert className="invisible">
          {children}
        </div>
      )}
    </div>
  );
}
