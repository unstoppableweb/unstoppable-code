'use client';

import {
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import { COMPOSER_STOPPING_WAITING_FOR_WAKE_LABEL } from './composer-send-button-copy';

export type ComposerPresentationDensity =
  | 'comfortable'
  | 'cozy'
  | 'compact'
  | 'minimal';

// The one-line class names and capsule style live in their own module so
// `ChatComposerShell` can use them without pulling this module (and its hooks
// and status row) into every route that renders a shell.
export {
  ONE_LINE_COMPOSER_BOX_STYLE,
  ONE_LINE_COMPOSER_CLASS_NAMES,
} from './composerLayoutClasses';

/**
 * The expanded editor sizes to its text, as the one-line composer grows: no
 * reserved empty lines, only a cap that keeps a short panel's transcript in
 * view (the density step still picks the cap from the panel height).
 */
const EXPANDED_EDITOR_MAX_HEIGHT_CLASS_NAMES: Record<
  ComposerPresentationDensity,
  string
> = {
  comfortable: 'max-h-50',
  cozy: 'max-h-40',
  compact: 'max-h-30',
  minimal: 'max-h-16',
};

export {
  TERMINAL_MODE_ERROR_SHELL_CLASS,
  TERMINAL_MODE_SHELL_CLASS,
  TerminalModeLabel,
} from './TerminalComposerMode';

/**
 * While dictating, the text area holds two lines (two 20px lines plus its 14px
 * top and 4px bottom padding), so the box stays put while recording and when
 * the take's words are inserted as it ends.
 */
export const VOICE_TAKE_EDITOR_CONTAINER_CLASS =
  'min-h-[calc(2*var(--text-s--line-height)+1.125rem)]';

export function expandedComposerEditorContainerClassName(
  density: ComposerPresentationDensity,
): string {
  return `${EXPANDED_EDITOR_MAX_HEIGHT_CLASS_NAMES[density]} cursor-text overflow-y-auto px-4 pt-3.5 pb-1`;
}

const COMPOSER_RESIZE_DURATION_MS = 200;
// Decelerate into the new size (DESIGN.md: entering motion decelerates).
const COMPOSER_RESIZE_EASING = 'cubic-bezier(0.2, 0, 0, 1)';

/**
 * Eases the composer box between the one-line capsule and the full layout,
 * both ways. Growth or shrinking within the full layout (a third line and
 * beyond) is instant, so typing never waits on the box; the corner radius,
 * which only changes between the two layouts, tells the cases apart.
 * The box's own layout already changed when this runs (a ResizeObserver
 * callback fires after layout and before paint), so the animation starts
 * from the previous height and corner radius and settles on the new ones.
 * A change that lands mid-resize is picked up when it finishes. Reduced
 * motion skips it. `resetKey` re-attaches when the host remounts the box.
 */
export function useAnimatedComposerBox(
  boxRef: RefObject<HTMLElement | null>,
  resetKey?: unknown,
): void {
  const lastRef = useRef<{ height: number; radius: string } | null>(null);
  const animationRef = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return undefined;
    const view = box.ownerDocument.defaultView;
    const reducedMotion =
      view?.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;

    const measure = (
      entry?: ResizeObserverEntry,
    ): { height: number; radius: string } => ({
      // ResizeObserver already measured the untransformed border box. Reuse
      // that height instead of asking layout for the same geometry again.
      height:
        entry?.borderBoxSize?.[0]?.blockSize ??
        box.getBoundingClientRect().height,
      radius: getComputedStyle(box).borderTopLeftRadius,
    });

    lastRef.current = measure();
    const observer = new ResizeObserver((entries) => {
      // A running resize reports its own in-between heights; ignore them.
      if (animationRef.current?.playState === 'running') return;
      const previous = lastRef.current;
      const next = measure(entries.find((entry) => entry.target === box));
      lastRef.current = next;
      if (
        previous === null ||
        Math.abs(previous.height - next.height) < 1 ||
        previous.radius === next.radius ||
        reducedMotion?.matches === true ||
        typeof box.animate !== 'function'
      ) {
        return;
      }
      const animation = box.animate(
        [
          {
            height: `${previous.height}px`,
            borderRadius: previous.radius,
            overflow: 'hidden',
          },
          {
            height: `${next.height}px`,
            borderRadius: next.radius,
            overflow: 'hidden',
          },
        ],
        {
          duration: COMPOSER_RESIZE_DURATION_MS,
          easing: COMPOSER_RESIZE_EASING,
        },
      );
      animationRef.current = animation;
      animation.onfinish = (): void => {
        animationRef.current = null;
        // Content may have changed while the resize ran; settle on it.
        lastRef.current = measure();
      };
    });
    observer.observe(box);
    const stopForReducedMotion = (): void => {
      if (reducedMotion?.matches) animationRef.current?.cancel();
    };
    reducedMotion?.addEventListener('change', stopForReducedMotion);
    return (): void => {
      reducedMotion?.removeEventListener('change', stopForReducedMotion);
      observer.disconnect();
      animationRef.current?.cancel();
      animationRef.current = null;
    };
  }, [boxRef, resetKey]);
}

/** Same 20px line, centered alongside the touch controls below lg. */
export const TOUCH_ONE_LINE_EDITOR_CONTAINER_CLASS =
  'max-h-11 min-h-11 cursor-text overflow-hidden px-1 py-3 lg:max-h-8 lg:min-h-8 lg:py-1.5 [&_[data-slate-placeholder]]:truncate';

export interface UseOneLineComposerOptions {
  /** Opt-in for a staged textarea/Slate editor. Desktop retains its DOM range path. */
  measurementText?: string;
  /** The composer shell; its editable is measured for a second line. */
  boxRef: RefObject<HTMLElement | null>;
  /** Whether the draft has any text. An empty draft always returns to one line. */
  hasDraftText: boolean;
  /**
   * Whether the box holds only the editor and its controls. Attachments,
   * selections, notices and similar content need the full layout.
   */
  allowed: boolean;
  /** Changes whenever the draft changes, so the wrap check runs again. */
  draftRevision: unknown;
  /**
   * The least room the text keeps beside the chips and labels that share its
   * line (Plan, a scheduled send, watchers, the terminal mode label). When
   * they leave less, the box takes two rows: text on top, chips under it.
   * Omit to keep the one line whatever the room.
   */
  minTextWidth?: number;
  /**
   * Changes whenever those chips and labels change, so a box that went to
   * two rows for them tries the one line again.
   */
  sideContentKey?: string;
}

/** Room kept free in the one-line slot before the draft may return to it. */
const ONE_LINE_RETURN_SLACK_PX = 8;

/**
 * How much wider a box that went to two rows for its chips must grow before
 * it tries the one line again, so a resize does not flip it back and forth.
 */
const CRAMPED_RETURN_SLACK_PX = 24;

/** The text's least room beside the chips on the chat composer's one line. */
export const CHAT_COMPOSER_MIN_TEXT_WIDTH_PX = 160;

/**
 * Whether the editable holds one paragraph that renders on one line, and how
 * wide that line is. Slate renders each paragraph as a block child, so a
 * hard line break is a second child; a soft wrap is a second line box.
 */
function measureSingleLine(editable: HTMLElement): number | null {
  if (editable.children.length !== 1) return null;
  const block = editable.firstElementChild;
  if (!block) return null;
  const range = editable.ownerDocument.createRange();
  range.selectNodeContents(block);
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0,
  );
  if (rects.length === 0) return 0;
  const top = rects[0]?.top ?? 0;
  if (rects.some((rect) => Math.abs(rect.top - top) > 2)) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const right = Math.max(...rects.map((rect) => rect.right));
  return right - left;
}

/**
 * One line by default: +, the text and send share a row. The composer opens
 * to the full layout once the draft needs a second line, and returns to one
 * line once the draft fits the one-line text slot again. The slot is
 * narrower than the full editor, so its width is remembered while inline and
 * the draft must fit it with room to spare; text that only fits the wider
 * editor keeps the full layout instead of flipping back and forth.
 */
export function useOneLineComposer({
  boxRef,
  hasDraftText,
  allowed,
  draftRevision,
  minTextWidth,
  sideContentKey,
  measurementText,
}: UseOneLineComposerOptions): boolean {
  const [expanded, setExpanded] = useState(false);
  // The chips beside the text left it too little room.
  const [cramped, setCramped] = useState(false);
  const crampedAtWidthRef = useRef<number | null>(null);
  const inline = allowed && !expanded && !cramped;
  const inlineSlotWidthRef = useRef<number | null>(null);

  // Other chips: try the one line again (the check below re-measures).
  useLayoutEffect(() => {
    crampedAtWidthRef.current = null;
    setCramped(false);
  }, [sideContentKey]);

  useLayoutEffect(() => {
    if (
      measurementText !== undefined ||
      minTextWidth === undefined ||
      !allowed ||
      expanded
    )
      return undefined;
    const box = boxRef.current;
    const editable = box?.querySelector<HTMLElement>(
      '[contenteditable="true"]',
    );
    if (!box || !editable) return undefined;
    const check = (): void => {
      if (!cramped) {
        // Chips can squeeze the text to nothing, so only an unlaid-out box
        // (no width yet) is skipped, not an empty text slot.
        if (box.clientWidth === 0) return;
        if (editable.clientWidth < minTextWidth) {
          crampedAtWidthRef.current = box.clientWidth;
          setCramped(true);
        }
        return;
      }
      const at = crampedAtWidthRef.current;
      if (at !== null && box.clientWidth >= at + CRAMPED_RETURN_SLACK_PX) {
        crampedAtWidthRef.current = null;
        setCramped(false);
      }
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(box);
    observer.observe(editable);
    return (): void => observer.disconnect();
  }, [
    boxRef,
    minTextWidth,
    allowed,
    expanded,
    cramped,
    sideContentKey,
    measurementText,
  ]);

  useLayoutEffect(() => {
    if (measurementText !== undefined) return undefined;
    if (!hasDraftText) {
      setExpanded(false);
      return undefined;
    }
    const editable = boxRef.current?.querySelector<HTMLElement>(
      '[contenteditable="true"]',
    );
    if (!editable) return undefined;
    const check = (): void => {
      if (inline) {
        inlineSlotWidthRef.current = editable.clientWidth;
        const lineHeight = Number.parseFloat(
          getComputedStyle(editable).lineHeight,
        );
        if (editable.scrollHeight > lineHeight * 1.5) setExpanded(true);
        return;
      }
      if (!allowed) return;
      const slot = inlineSlotWidthRef.current;
      const width = measureSingleLine(editable);
      if (
        slot !== null &&
        width !== null &&
        width <= slot - ONE_LINE_RETURN_SLACK_PX
      ) {
        setExpanded(false);
      }
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(editable);
    return (): void => observer.disconnect();
  }, [boxRef, hasDraftText, inline, allowed, draftRevision, measurementText]);

  useLayoutEffect(() => {
    if (measurementText === undefined) return undefined;
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return undefined;
    const doc = box.ownerDocument;
    const view = doc.defaultView;
    if (!view) return undefined;
    const probe = doc.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.inert = true;
    doc.body.append(probe);
    let editable: HTMLElement | null = null;
    let frame: number | null = null;
    let disposed = false;
    const check = (): void => {
      frame = null;
      if (
        disposed ||
        !editable ||
        box.clientWidth <= 0 ||
        editable.clientWidth <= 0
      )
        return;
      const style = view.getComputedStyle(editable);
      const editorPadding =
        (parseFloat(style.paddingLeft) || 0) +
        (parseFloat(style.paddingRight) || 0);
      const fixed = Array.from(
        box.querySelectorAll<HTMLElement>('[data-composer-inline-fixed]'),
      )
        .map((item) => item.getBoundingClientRect().width)
        .filter((width) => width > 0);
      const rail = box.querySelector<HTMLElement>(
        '[data-composer-inline-rail]',
      );
      const railItems = rail
        ? Array.from(rail.children)
            .map((item) => item.getBoundingClientRect().width)
            .filter((width) => width > 0)
        : [];
      const spacing =
        parseFloat(view.getComputedStyle(doc.documentElement).fontSize) / 2;
      // p-2 on the shell, px-1 around the editor, gap-2 around each fixed item.
      const chrome =
        fixed.reduce((sum, width) => sum + width, 0) +
        railItems.reduce((sum, width) => sum + width, 0) +
        spacing * (3 + fixed.length + railItems.length);
      const slot = Math.max(0, box.clientWidth - chrome - editorPadding);
      if (inline) inlineSlotWidthRef.current = slot;
      if (!allowed) return;
      if (minTextWidth !== undefined && slot < minTextWidth) {
        crampedAtWidthRef.current = box.clientWidth;
        setCramped(true);
      } else if (
        crampedAtWidthRef.current === null ||
        box.clientWidth >= crampedAtWidthRef.current + CRAMPED_RETURN_SLACK_PX
      ) {
        crampedAtWidthRef.current = null;
        setCramped(false);
      }
      if (!hasDraftText) {
        setExpanded(false);
        return;
      }
      const width = inline
        ? slot
        : Math.max(0, slot - ONE_LINE_RETURN_SLACK_PX);
      if (width <= 0) return;
      Object.assign(probe.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        visibility: 'hidden',
        pointerEvents: 'none',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        wordBreak: style.wordBreak,
        padding: '0',
        margin: '0',
        border: '0',
        width: `${width}px`,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        lineHeight: style.lineHeight,
      });
      probe.textContent = `${measurementText}\u200b`;
      const lineHeight =
        parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
      const multiline =
        measurementText.includes('\n') ||
        probe.getBoundingClientRect().height > lineHeight * 1.5;
      setExpanded(multiline);
    };
    const schedule = (): void => {
      if (!disposed && frame === null)
        frame = view.requestAnimationFrame(check);
    };
    const resize = new ResizeObserver(schedule);
    const bind = (): void => {
      const next = box.querySelector<HTMLElement>(
        'textarea, [data-slate-editor="true"]',
      );
      if (next !== editable) {
        if (editable) resize.unobserve(editable);
        editable = next;
        if (editable) resize.observe(editable);
      }
      schedule();
    };
    resize.observe(box);
    bind();
    if (frame !== null) view.cancelAnimationFrame(frame);
    check();
    const mutation = new MutationObserver(bind);
    mutation.observe(box, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-slate-editor'],
    });
    resize.observe(doc.documentElement);
    doc.fonts?.addEventListener('loadingdone', schedule);
    view.addEventListener('resize', schedule);
    return (): void => {
      disposed = true;
      if (frame !== null) view.cancelAnimationFrame(frame);
      mutation.disconnect();
      resize.disconnect();
      doc.fonts?.removeEventListener('loadingdone', schedule);
      view.removeEventListener('resize', schedule);
      probe.remove();
    };
  }, [
    boxRef,
    measurementText,
    hasDraftText,
    inline,
    allowed,
    minTextWidth,
    sideContentKey,
    draftRevision,
  ]);

  return inline;
}

/**
 * Whether the row's content needs more room than it has. The trailing group
 * packs against the right edge, so when it is too narrow its content spills
 * off its LEFT side, which `scrollWidth` does not count; measure the group's
 * items against its width instead.
 */
function statusRowOverflows(row: HTMLElement): boolean {
  if (row.scrollWidth - row.clientWidth > 1) return true;
  const group = row.querySelector<HTMLElement>('[data-status-row-fill]');
  if (!group) return false;
  const items = Array.from(group.children);
  const gap = Number.parseFloat(getComputedStyle(group).columnGap) || 0;
  const needed =
    items.reduce(
      (total, item) => total + item.getBoundingClientRect().width,
      0,
    ) +
    gap * Math.max(0, items.length - 1);
  return needed - group.clientWidth > 1;
}

/** Below this box width the chips beside + draw small (icons, a time). */
export const COMPACT_CHIPS_BREAKPOINT_REM = 30;
/** Width a compact box must regain past the breakpoint before chips grow. */
export const COMPACT_CHIPS_HYSTERESIS_REM = 4;

/**
 * Whether the chips beside + should draw small in `element`'s box, with the
 * chat composer's breakpoint and hysteresis. Follows resizes and UI scale.
 * Pass the element through state (a callback ref) so a remount re-measures.
 */
export function useComposerChipsCompact(element: HTMLElement | null): boolean {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const update = (width: number): void => {
      if (width <= 0) return;
      const rootFontSize = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      const breakpoint = COMPACT_CHIPS_BREAKPOINT_REM * rootFontSize;
      const hysteresis = COMPACT_CHIPS_HYSTERESIS_REM * rootFontSize;
      setCompact((prev) =>
        prev ? width < breakpoint + hysteresis : width < breakpoint,
      );
    };
    const measure = (): void => update(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const scaleObserver = new MutationObserver(measure);
    scaleObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-ui-scale'],
    });
    return (): void => {
      observer.disconnect();
      scaleObserver.disconnect();
    };
  }, [element]);
  return compact;
}

/** Width the row must regain past where it overflowed before labels return. */
const STATUS_ROW_EXPAND_SLACK_PX = 24;

/**
 * Whether the status row's selectors should drop their labels. They keep
 * them until the row actually runs out of room (its content overflows), and
 * get them back once the row is wider than where that happened by a margin,
 * so it never flickers at the boundary. Hosts keep the model name at full
 * width until the row is compact, so compacting the other selectors comes
 * first and the model name is the last thing to give way.
 */
export function useStatusRowCompact(
  rowRef: RefObject<HTMLElement | null>,
): boolean {
  const [compact, setCompact] = useState(false);
  const compactedAtRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return undefined;
    const check = (): void => {
      const width = row.clientWidth;
      if (width <= 0) return;
      const compactedAt = compactedAtRef.current;
      if (compactedAt === null) {
        if (statusRowOverflows(row)) {
          compactedAtRef.current = width;
          setCompact(true);
        }
        return;
      }
      if (width >= compactedAt + STATUS_ROW_EXPAND_SLACK_PX) {
        compactedAtRef.current = null;
        setCompact(false);
      }
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(row);
    return (): void => observer.disconnect();
  }, [rowRef, compact]);

  return compact;
}

export interface ComposerStatusRowProps {
  /** Leading settings: the permission level. */
  start: ReactNode;
  /** Trailing settings: model, effort and context usage. */
  end: ReactNode;
  /**
   * The side that takes the row's free width: `end` (the default) packs its
   * selectors against the right edge; `start` packs the leading ones against
   * the left, and the trailing ones hold their width.
   */
  fill?: 'start' | 'end';
  /** The row element, for `useStatusRowCompact`. */
  rowRef?: RefObject<HTMLDivElement | null>;
  /**
   * A sent stop waits for the turn's project to wake: the row says so in
   * text at its trailing edge, under Stop, as its tooltip does (CAN-6721).
   */
  stopWaitsForWake?: boolean;
}

/**
 * Why Stop still reads Stopping…, as visible text: the wait can last half
 * a minute, longer than anyone hovers for a tooltip (CAN-6721).
 */
function ComposerStopStatus(): JSX.Element {
  return (
    <span
      role="status"
      data-testid="chat-composer-stop-status"
      className="shrink-0 whitespace-nowrap text-xs fg-secondary"
    >
      {COMPOSER_STOPPING_WAITING_FOR_WAKE_LABEL}
    </span>
  );
}

/**
 * The session settings under the composer box. Kept outside the box so the
 * input stays focused on the message itself, and so every setting stays
 * visible at every composer width.
 */
export function ComposerStatusRow({
  start,
  end,
  fill = 'end',
  rowRef,
  stopWaitsForWake = false,
}: ComposerStatusRowProps): JSX.Element {
  const stopStatus = stopWaitsForWake ? <ComposerStopStatus /> : null;
  if (fill === 'start') {
    return (
      <div
        ref={rowRef}
        data-testid="chat-composer-status-row"
        className="flex min-w-0 select-none items-center justify-between gap-2 pt-2 pl-1.5 pr-2"
      >
        {/* Fills the rest of the row, so its selectors truncate when space
            runs out rather than pushing the trailing group off the row. */}
        <div
          data-status-row-fill
          data-fit-container
          className="flex min-w-0 flex-1 items-center justify-start gap-0"
        >
          {start}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {end}
          {stopStatus}
        </div>
      </div>
    );
  }
  return (
    // Insets line the row's first and last glyphs up with the composer's:
    // the permission shield under the + glyph, the context ring centred under
    // the send glyph (each control carries its own padding inside these).
    <div
      ref={rowRef}
      data-testid="chat-composer-status-row"
      // Controls, not copy: a drag across the row must not select labels.
      className="flex min-w-0 select-none items-center justify-between gap-2 pt-2 pl-1.5 pr-2"
    >
      <div className="shrink-0">{start}</div>
      {/* Fills the rest of the row and packs its selectors against the
          right edge, so they hold their positions whatever the permission
          label's width; the model name gives way when space runs out. */}
      <div
        data-status-row-fill
        data-fit-container
        // No gap: the controls sit edge to edge, their own padding spacing
        // the labels and glyphs.
        className="flex min-w-0 flex-1 items-center justify-end gap-0"
      >
        {end}
        {stopStatus}
      </div>
    </div>
  );
}

/**
 * While the usage meter shows its weekly % (hover, keyboard focus or its
 * open popover), the access control before it keeps its original 37px slide,
 * on the meter's curve: 180 ms in, 120 ms out. A
 * transform, so the row never relayouts; hover counts only for a fine
 * pointer, so a tap on touch cannot leave it slid. The meter is the next
 * sibling, so the access wrapper watches it with `:has(+ …)`. The wrapper's
 * 37px leading padding keeps the slide clear of the controls before it: free
 * row width absorbs it, and a full row truncates the model name that much
 * earlier.
 */
const ACCESS_WEEKLY_SLIDE_CLASS =
  'flex min-w-0 has-[+*_[data-weekly-trigger]]:pl-9.25 transition-[translate] duration-120 ease-drawer motion-reduce:transition-none pointer-fine:has-[+*_[data-weekly-trigger]:hover]:duration-180 has-[+*_[data-weekly-trigger]:focus-visible]:duration-180 has-[+*_[data-weekly-trigger][aria-expanded=true]]:duration-180 has-[+*_[data-weekly-trigger][data-open=true]]:duration-180 pointer-fine:has-[+*_[data-weekly-trigger]:hover]:-translate-x-9.25 has-[+*_[data-weekly-trigger]:focus-visible]:-translate-x-9.25 has-[+*_[data-weekly-trigger][aria-expanded=true]]:-translate-x-9.25 has-[+*_[data-weekly-trigger][data-open=true]]:-translate-x-9.25';

/** Access precedes supplied usage without adding a flex item around the pair. */
export function ComposerAccessUsage({
  access,
  usage,
}: {
  access?: ReactNode;
  usage?: ReactNode;
}): JSX.Element {
  return (
    <>
      {access != null && usage != null ? (
        <div className={ACCESS_WEEKLY_SLIDE_CLASS}>{access}</div>
      ) : (
        access
      )}
      {usage != null ? <div className="shrink-0">{usage}</div> : null}
    </>
  );
}
