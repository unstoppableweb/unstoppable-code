import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type JSX,
  type ReactNode,
} from 'react';
import { AnsiUp } from 'ansi_up';
import { highlightAnsiHtml } from './ansi-search-highlight';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';

const NEAR_BOTTOM_THRESHOLD = 80;

interface HtmlLine {
  /** Stable monotonic id — survives array slicing in the store. */
  id: number;
  html: string;
}

interface AnsiCache {
  /** The source lines array from the previous render. */
  prevLines: readonly string[];
  /** Converted HTML lines with stable ids. */
  htmlLines: HtmlLine[];
  /** Next monotonic id to assign. */
  nextId: number;
  /** Shared AnsiUp instance — preserves ANSI state across lines. */
  ansiUp: AnsiUp;
}

interface RenderedLineCacheEntry {
  html: string;
  truncateLines: boolean;
  element: JSX.Element;
}

/**
 * What the panel is for. The variant picks the radius, padding, and type
 * together, so the panel's corners stay concentric with its host.
 *
 * - `panel`: stands alone in a section or a detail view.
 * - `tail`: the live ribbon inside `RunningProcessCard`. Its radius is the
 *   card's radius minus the card's inset, and its height fits exactly the
 *   `maxRenderLines` it renders.
 * - `reader`: the full log in a dialog. It runs edge to edge, shares the
 *   dialog's clipped corners, and aligns its text to the dialog's column.
 */
export type AnsiOutputVariant = 'panel' | 'tail' | 'reader';

/**
 * One surface for every log: the code-block fill with no outline. The host
 * chooses the panel's height; the panel always scrolls itself.
 */
const SURFACE_CLASS_NAME = 'overflow-auto bg-secondary font-mono fg-secondary';

const VARIANT_CLASS_NAMES: Record<AnsiOutputVariant, string> = {
  panel: 'rounded-md p-3 text-2xs leading-5',
  tail: 'rounded-sm p-3 text-2xs',
  reader: 'px-5 py-4 text-xs',
};

/** The 2xs line height and the tail's vertical padding (`p-3`, twice). */
const TAIL_LINE_HEIGHT_REM = 0.75;
const TAIL_VERTICAL_PADDING_REM = 1.5;

function tailMaxHeight(maxRenderLines: number): string {
  return `calc(${String(maxRenderLines)} * ${String(TAIL_LINE_HEIGHT_REM)}rem + ${String(TAIL_VERTICAL_PADDING_REM)}rem)`;
}

export interface AnsiOutputProps {
  lines: readonly string[];
  /** What the panel is for (default: `panel`). */
  variant?: AnsiOutputVariant;
  /** Placement and height in the host. The surface is not the caller's. */
  className?: string;
  /** Inline styles for the outer container */
  style?: CSSProperties;
  /**
   * Shown on the same surface while there are no lines. Without it the
   * component renders nothing until output arrives.
   */
  placeholder?: ReactNode;
  /** Auto-scroll to bottom when new lines arrive (default: true) */
  autoScroll?: boolean;
  /**
   * When set, render only the last N converted lines. Used by the inline
   * live-output ribbon, which is a tiny tail view — capping the rendered DOM
   * keeps reconciliation O(N) instead of O(total) while a script streams.
   * The full log remains available in the enlarge modal (which omits this).
   */
  maxRenderLines?: number;
  /**
   * When true, each rendered line is clamped to a single row with an ellipsis
   * instead of wrapping. Used by the inline live-output ribbon so one
   * pathologically long line (e.g. a multi-thousand-char SQL log) stays one
   * row — bounding the tail's height and layout cost regardless of line
   * length. The enlarge modal omits this and wraps in full.
   */
  truncateLines?: boolean;
  /** When set, highlight matching text within the output. */
  searchQuery?: string;
  /** The globally active match index (0-based) to apply "active" styling. */
  activeMatchIndex?: number;
  /** Called when the total match count changes. */
  onMatchCountChange?: (totalCount: number) => void;
}

function isNearBottom(element: HTMLElement): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <
    NEAR_BOTTOM_THRESHOLD
  );
}

function createAnsiUp(): AnsiUp {
  const au = new AnsiUp();
  au.escape_html = true;
  return au;
}

function createEmptyCache(): AnsiCache {
  return {
    prevLines: [],
    htmlLines: [],
    nextId: 0,
    ansiUp: createAnsiUp(),
  };
}

// Retain terminal state established before a bounded tail without converting
// the omitted text. Feeding only control sequences into the first visible
// conversion gives AnsiUp the same formatting state while keeping expensive
// text-to-HTML work proportional to maxRenderLines.
const ANSI_CONTROL_SEQUENCE = new RegExp(
  [
    '[\\u001B\\u009B][[\\]\\()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
  ].join('|'),
  'g',
);

function collectAnsiStatePrelude(
  lines: readonly string[],
  end: number,
): string {
  const sequences: string[] = [];
  for (let index = 0; index < end; index++) {
    const matches = lines[index].match(ANSI_CONTROL_SEQUENCE);
    if (matches) {
      sequences.push(...matches);
    }
  }
  return sequences.join('');
}

/**
 * Find the number of lines at the *end* of `prev` that appear at the
 * *start* of `next`.  The store caps output by slicing from the front,
 * so a common pattern is:
 *
 *   prev = [a, b, c, d, e]          (old lines)
 *   next = [c, d, e, f, g]          (front-sliced + new lines)
 *
 * We want to find the suffix overlap (c, d, e → length 3) so we can
 * reuse those cached HtmlLine entries and only convert f, g.
 *
 * The search starts from the end of `prev` and walks backward,
 * checking whether the last N lines of prev match the first N of next.
 */
function findSuffixOverlap(
  prev: readonly string[],
  next: readonly string[],
): number {
  const maxOverlap = Math.min(prev.length, next.length);
  // Try the longest possible overlap first and shrink.
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    const prevStart = prev.length - overlap;
    let match = true;
    for (let i = 0; i < overlap; i++) {
      if (prev[prevStart + i] !== next[i]) {
        match = false;
        break;
      }
    }
    if (match) return overlap;
  }
  return 0;
}

/**
 * Compute the next cache state without mutating the previous cache.
 * Returned as a new object so it is safe to call during render (no
 * side-effects on the ref until committed via `useMemo`).
 */
function computeNextCache(
  prev: AnsiCache,
  lines: readonly string[],
): AnsiCache {
  if (lines === prev.prevLines) return prev;

  // --- Append-only fast path (prefix match) ---
  if (lines.length >= prev.prevLines.length && prev.htmlLines.length > 0) {
    let prefixMatch = true;
    const prevLen = prev.prevLines.length;
    for (let i = 0; i < prevLen; i++) {
      if (lines[i] !== prev.prevLines[i]) {
        prefixMatch = false;
        break;
      }
    }
    if (prefixMatch) {
      let { nextId } = prev;
      const newHtml: HtmlLine[] = [];
      for (let i = prevLen; i < lines.length; i++) {
        newHtml.push({
          id: nextId++,
          html: prev.ansiUp.ansi_to_html(lines[i]) || '\u00A0',
        });
      }
      const htmlLines =
        newHtml.length > 0 ? [...prev.htmlLines, ...newHtml] : prev.htmlLines;
      return { prevLines: lines, htmlLines, nextId, ansiUp: prev.ansiUp };
    }
  }

  // --- Suffix-overlap path (front-sliced by the store's line cap) ---
  if (prev.htmlLines.length > 0) {
    const overlap = findSuffixOverlap(prev.prevLines, lines);
    if (overlap > 0) {
      // Reuse the HtmlLine entries for the overlapping suffix.
      const reused = prev.htmlLines.slice(prev.htmlLines.length - overlap);
      let { nextId } = prev;
      const newHtml: HtmlLine[] = [];
      // Convert only lines after the overlapping prefix of `next`.
      for (let i = overlap; i < lines.length; i++) {
        newHtml.push({
          id: nextId++,
          html: prev.ansiUp.ansi_to_html(lines[i]) || '\u00A0',
        });
      }
      return {
        prevLines: lines,
        htmlLines: newHtml.length > 0 ? [...reused, ...newHtml] : reused,
        nextId,
        ansiUp: prev.ansiUp,
      };
    }
  }

  // --- Full replacement ---
  const au = createAnsiUp();
  let nextId = 0;
  const htmlLines = lines.map((line) => ({
    id: nextId++,
    html: au.ansi_to_html(line) || '\u00A0',
  }));
  return { prevLines: lines, htmlLines, nextId, ansiUp: au };
}

/**
 * Renders an array of output lines with ANSI color escape sequences
 * converted to styled HTML spans.
 *
 * Uses incremental conversion: only newly appended (or front-sliced)
 * lines are passed through AnsiUp, and previously converted lines keep
 * their stable identity so React can skip re-rendering them.
 */
export function AnsiOutput({
  lines,
  variant = 'panel',
  className = '',
  style,
  placeholder,
  autoScroll = true,
  maxRenderLines,
  truncateLines = false,
  searchQuery,
  activeMatchIndex,
  onMatchCountChange,
}: AnsiOutputProps): JSX.Element | null {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const prevLinesLengthRef = useRef(0);
  const prevMatchCountRef = useRef(0);
  const renderedLineCacheRef = useRef(
    new Map<number, RenderedLineCacheEntry>(),
  );

  // Persistent cache stored in a ref.  `useMemo` computes the next
  // cache without side-effects during render; the ref is committed
  // only via the returned value, which is safe even under concurrent
  // rendering / StrictMode (aborted renders simply discard the memo
  // result without touching the ref).
  const cacheRef = useRef<AnsiCache>(createEmptyCache());

  // Inline live-output ribbons render only a small tail. Bound ANSI
  // conversion and overlap detection to that same tail as well; converting
  // the store's full retained log before slicing the DOM defeats the cap and
  // creates long renderer tasks during chatty setup scripts.
  const conversionLines = useMemo(() => {
    if (maxRenderLines == null || lines.length <= maxRenderLines) {
      return lines;
    }
    const tailStart = lines.length - maxRenderLines;
    const tail = lines.slice(tailStart);
    const statePrelude = collectAnsiStatePrelude(lines, tailStart);
    return statePrelude.length > 0
      ? [`${statePrelude}${tail[0]}`, ...tail.slice(1)]
      : tail;
  }, [lines, maxRenderLines]);

  const htmlLines = useMemo((): HtmlLine[] => {
    const next = computeNextCache(cacheRef.current, conversionLines);
    cacheRef.current = next;
    return next.htmlLines;
  }, [conversionLines]);

  // Apply search highlighting over the cached HTML lines
  const normalizedQuery = searchQuery?.trim() ?? '';
  const highlighted = useMemo(() => {
    if (normalizedQuery.length < 2) {
      return { lines: htmlLines, totalCount: 0 };
    }
    return highlightAnsiHtml(
      htmlLines,
      normalizedQuery,
      activeMatchIndex ?? -1,
    );
  }, [htmlLines, normalizedQuery, activeMatchIndex]);

  // maxRenderLines is a tail-view optimization; callers should not combine it
  // with searchQuery because match metadata is computed before slicing.
  const displayLines =
    maxRenderLines != null && highlighted.lines.length > maxRenderLines
      ? highlighted.lines.slice(highlighted.lines.length - maxRenderLines)
      : highlighted.lines;
  const totalMatchCount = highlighted.totalCount;

  // Reuse the exact React element for every unchanged line. This avoids both
  // rewriting selection-anchored text nodes and adding a component fiber per
  // line to large, actively streaming logs.
  const renderedLineResult = useMemo(() => {
    const previous = renderedLineCacheRef.current;
    const next = new Map<number, RenderedLineCacheEntry>();
    const elements = displayLines.map((entry) => {
      const cached = previous.get(entry.id);
      if (
        cached?.html === entry.html &&
        cached.truncateLines === truncateLines
      ) {
        next.set(entry.id, cached);
        return cached.element;
      }

      const element = (
        <div
          key={entry.id}
          className={
            truncateLines
              ? 'overflow-hidden text-ellipsis whitespace-nowrap'
              : undefined
          }
          dangerouslySetInnerHTML={{ __html: entry.html }}
        />
      );
      next.set(entry.id, { html: entry.html, truncateLines, element });
      return element;
    });
    return { elements, next };
  }, [displayLines, truncateLines]);
  const renderedLines = renderedLineResult.elements;

  useLayoutEffect(() => {
    renderedLineCacheRef.current = renderedLineResult.next;
  }, [renderedLineResult.next]);

  // Report match count changes
  useEffect(() => {
    if (totalMatchCount !== prevMatchCountRef.current) {
      prevMatchCountRef.current = totalMatchCount;
      onMatchCountChange?.(totalMatchCount);
    }
  }, [totalMatchCount, onMatchCountChange]);

  // Scroll to active match
  useLayoutEffect(() => {
    if (
      activeMatchIndex == null ||
      activeMatchIndex < 0 ||
      normalizedQuery.length < 2
    ) {
      return;
    }
    const container = scrollRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(
      `[data-match-index="${String(activeMatchIndex)}"]`,
    );
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      stickToBottomRef.current = false;
    }
  }, [activeMatchIndex, normalizedQuery, displayLines]);

  const handleScroll = useCallback((): void => {
    if (!autoScroll) return;
    const element = scrollRef.current;
    if (!element) return;
    stickToBottomRef.current = isNearBottom(element);
  }, [autoScroll]);

  // Reset stick-to-bottom when lines are replaced (e.g. selecting a different step)
  useEffect(() => {
    if (lines.length < prevLinesLengthRef.current) {
      stickToBottomRef.current = true;
    }
    prevLinesLengthRef.current = lines.length;
  }, [lines.length]);

  // Scroll to bottom on initial render and when new lines arrive
  useLayoutEffect(() => {
    if (!autoScroll || !stickToBottomRef.current) return;
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [htmlLines, autoScroll]);

  const surfaceClassName = `${SURFACE_CLASS_NAME} ${VARIANT_CLASS_NAMES[variant]}`;

  if (lines.length === 0) {
    if (placeholder == null) return null;
    return (
      <div
        data-testid="ansi-output-empty"
        className={`flex items-center justify-center ${surfaceClassName} ${className}`}
        style={style}
      >
        {placeholder}
      </div>
    );
  }

  // The tail shows exactly the lines it renders, so its height follows them.
  const rootStyle: CSSProperties | undefined =
    variant === 'tail' && maxRenderLines != null
      ? { maxHeight: tailMaxHeight(maxRenderLines), ...style }
      : style;

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      data-testid="ansi-output"
      className={`${REPLAY_BLOCK_CLASS} ${truncateLines ? 'whitespace-nowrap' : 'whitespace-pre-wrap break-words'} ${surfaceClassName} ${className}`}
      style={rootStyle}
    >
      {renderedLines}
    </div>
  );
}
