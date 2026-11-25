'use client';

import {
  Children,
  Fragment,
  isValidElement,
  useLayoutEffect,
  useRef,
  type RefObject,
  type JSX,
  type ReactNode,
} from 'react';
import { HomeSections } from './HomeSection';
import { Stack } from './Stack';

export type ComposerHeroFrameRhythm = 'spacious' | 'compact';

/**
 * `centred`: the composer's midpoint sits on the frame's centre and everything
 * else hangs off it. `column`: a plain top-to-bottom column (the web phone
 * hero). Both render the same element tree, so a host can switch between them
 * without remounting the composer.
 */
export type ComposerHeroFrameLayout = 'centred' | 'column';

const COLUMN_CLASSNAME =
  'relative flex w-full max-w-3xl flex-col items-center gap-5 sm:gap-6';

const GROUP_CLASSNAME: Record<ComposerHeroFrameRhythm, string> = {
  spacious: 'absolute inset-x-0 top-1/2 w-full px-6',
  compact: 'absolute inset-x-0 top-1/2 w-full',
};

// The rows own the gap from `hanging` to the `below` rows.
const ROWS_CLASSNAME: Record<ComposerHeroFrameRhythm, string> = {
  spacious: 'absolute inset-x-0 top-full flex flex-col gap-16 pb-6',
  compact: 'absolute inset-x-0 top-full flex flex-col gap-5 sm:gap-6',
};

const BELOW_CLASSNAME: Record<ComposerHeroFrameRhythm, string> = {
  spacious: 'flex w-full flex-col gap-12',
  compact: 'flex w-full flex-col gap-10',
};

export interface ComposerHeroFrameProps {
  /** Hangs above the composer, out of flow: the heading and its notices. */
  readonly above?: ReactNode;
  /** Margin-free notices, kept 12px apart above the context or composer. */
  readonly aboveNotices?: ReactNode;
  /** One context group; a tray and drawer inside it keep their own adjacency. */
  readonly aboveContext?: ReactNode;

  /** The composer box. Its vertical midpoint sits on the frame's centre. */
  readonly composer: ReactNode;
  /**
   * Hangs under the composer, out of flow. It never moves the composer; the
   * `below` rows move down by its height instead.
   */
  readonly hanging?: ReactNode;
  /** Rows under the composer and `hanging`: suggestions, setup steps, recents. */
  readonly below?: ReactNode;
  /**
   * `spacious`: the desktop Home rhythm, 64px from the composer to the rows
   * and between them, with the rows padded so overflowing rows clear the
   * scroll limit. `compact`: the web hero rhythm, 20px (24px from `sm`), with
   * the host's own section supplying the padding.
   */
  readonly rhythm: ComposerHeroFrameRhythm;
  /** Defaults to `centred`. */
  readonly layout?: ComposerHeroFrameLayout;
  readonly anchorTestId?: string;
  readonly groupTestId?: string;
  readonly shellTestId?: string;
  readonly hangingTestId?: string;
}

/**
 * The composer hero's positioning frame, shared by the desktop Home surface and
 * the web New Task and guest heroes.
 *
 * The composer is the control the visitor is aiming at, so nothing that
 * arrives around it may move it. Its midpoint sits on the frame's centre (the
 * group's top, with the shell translated up by half its height); the heading
 * hangs above it, and everything under it (`hanging`, then the `below` rows)
 * hangs from its bottom edge in one column. Rows that load, grow or disappear
 * change nothing above them, and rows that outgrow the frame extend the host's
 * scroll area below the composer.
 *
 * Pure CSS on purpose: no measurement, so the server HTML already has the
 * final geometry and hydrating moves nothing.
 */
function visibleAboveContent(children: ReactNode): ReactNode[] {
  const result: ReactNode[] = [];
  Children.forEach(children, (child) => {
    if (
      child == null ||
      typeof child === 'boolean' ||
      (typeof child === 'string' && child.trim() === '')
    )
      return;
    if (
      isValidElement<{ readonly children?: ReactNode }>(child) &&
      child.type === Fragment
    ) {
      result.push(...visibleAboveContent(child.props.children));
    } else {
      result.push(child);
    }
  });
  return Children.toArray(result);
}

/**
 * Keeps the centred frame's top in view. The heading and notices hang above
 * the composer out of flow, so in a host too short for them they would reach
 * past the host's top edge, where no scrolling brings them back. The frame
 * then moves down by what is missing, so the heading starts at the host's
 * top padding and the rest scrolls. A host with room is not touched, and the
 * measurements run in resize observers, after the browser's own layout.
 */
function useTopAnchor(
  anchorRef: RefObject<HTMLDivElement | null>,
  aboveRef: RefObject<HTMLDivElement | null>,
  shellRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
): void {
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const above = aboveRef.current;
    const shell = shellRef.current;
    const host = anchor?.parentElement;
    if (
      !enabled ||
      !anchor ||
      !above ||
      !shell ||
      !host ||
      typeof ResizeObserver === 'undefined'
    ) {
      return undefined;
    }
    let shift = 0;
    const update = (): void => {
      const hostRect = host.getBoundingClientRect();
      // A hidden host (a page kept mounted) has no layout to read.
      if (hostRect.width === 0 && hostRect.height === 0) return;
      const paddingTop = parseFloat(getComputedStyle(host).paddingTop) || 0;
      // Where the hanging content starts when the frame sits centred.
      const centredTop =
        above.getBoundingClientRect().top + host.scrollTop - shift;
      const next = Math.max(
        0,
        Math.ceil(hostRect.top + paddingTop - centredTop),
      );
      if (next === shift) return;
      shift = next;
      anchor.style.top = next === 0 ? '' : `${next}px`;
    };
    const observer = new ResizeObserver(update);
    observer.observe(host);
    observer.observe(above);
    observer.observe(shell);
    return (): void => {
      observer.disconnect();
      anchor.style.top = '';
    };
  }, [anchorRef, aboveRef, shellRef, enabled]);
}

export function ComposerHeroFrame({
  above,
  aboveNotices,
  aboveContext,
  composer,
  hanging,
  below,
  rhythm,
  layout = 'centred',
  anchorTestId,
  groupTestId,
  shellTestId,
  hangingTestId,
}: ComposerHeroFrameProps): JSX.Element {
  const composerFocusTarget = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const aboveRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  // The column keeps every wrapper and lets the ones that only position the
  // centred frame drop out of layout with `contents`.
  const column = layout === 'column';
  const structuredAbove =
    aboveNotices !== undefined || aboveContext !== undefined;
  const noticeNodes = visibleAboveContent(aboveNotices);
  const contextNodes = visibleAboveContent(aboveContext);
  // With no context after the notices, the frame owns the final notice-to-box gap.
  const noticeEndsAboveComposer =
    !column && noticeNodes.length > 0 && contextNodes.length === 0;

  useTopAnchor(anchorRef, aboveRef, shellRef, !column);

  return (
    <div
      ref={anchorRef}
      data-testid={anchorTestId}
      data-layout={layout}
      className={
        column ? COLUMN_CLASSNAME : 'relative h-48 w-full max-w-3xl shrink-0'
      }
    >
      <div
        data-testid={groupTestId}
        className={column ? 'contents' : GROUP_CLASSNAME[rhythm]}
      >
        <div
          ref={shellRef}
          data-testid={shellTestId}
          className={column ? 'contents' : 'relative w-full -translate-y-1/2'}
        >
          <div
            ref={aboveRef}
            className={
              column
                ? 'contents'
                : 'pointer-events-none absolute inset-x-0 bottom-full flex flex-col items-stretch'
            }
            style={
              noticeEndsAboveComposer
                ? { bottom: 'calc(100% + var(--spacing) * 3)' }
                : undefined
            }
          >
            {above}
            {structuredAbove ? (
              <Stack gap="item">
                {noticeNodes}
                {contextNodes.length > 0 ? (
                  <div className="flex flex-col">{contextNodes}</div>
                ) : null}
              </Stack>
            ) : null}
          </div>
          {/* Above the rows that hang after it, so the composer's own menus
              open over them. */}
          <div
            ref={composerFocusTarget}
            tabIndex={-1}
            role="group"
            aria-label="Chat composer"
            className={
              column
                ? 'focus-ring relative z-10 w-full'
                : 'focus-ring relative z-10'
            }
          >
            {composer}
          </div>
          <div className={column ? 'contents' : ROWS_CLASSNAME[rhythm]}>
            <div
              data-testid={hangingTestId}
              className={column ? 'contents' : undefined}
            >
              {hanging}
            </div>
            <div className={column ? 'contents' : BELOW_CLASSNAME[rhythm]}>
              <HomeSections fallbackFocusRef={composerFocusTarget}>
                {below}
              </HomeSections>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
