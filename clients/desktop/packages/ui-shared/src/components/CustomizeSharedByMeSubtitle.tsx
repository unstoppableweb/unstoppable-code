import { useLayoutEffect, useRef, useState, type JSX } from 'react';
import { GlobeIcon } from '../icons/AppIcons';
import type { CustomizeSharedByMeLine } from '../lib/customize-row-copy';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { SHARED_BY_YOU_PUBLIC_LINK_LABEL } from '../lib/shared-by-you';
import { Badge } from './Badge';
import { Tooltip } from './Tooltip';

const SEPARATOR = ' · ';

/**
 * A Shared by me row's second line: audience, public-link badge, then the
 * share date (CAN-5220). When the line runs short the date is dropped whole
 * before the audience truncates, and the badge always keeps its width.
 */
export function CustomizeSharedByMeSubtitle({
  entryId,
  line,
}: {
  readonly entryId: string;
  readonly line: CustomizeSharedByMeLine;
}): JSX.Element {
  const lineRef = useRef<HTMLSpanElement>(null);
  const audienceRef = useRef<HTMLSpanElement>(null);
  const linkRef = useRef<HTMLSpanElement>(null);
  const sinceRef = useRef<HTMLSpanElement>(null);
  const [sinceFits, setSinceFits] = useState(true);
  const { audience, since, publicLink, publicLinkTitle } = line;

  // Measures only this row. A dropped date stays laid out (absolute and
  // invisible) so its width is still known when the row widens again or the
  // text scale changes.
  useLayoutEffect(() => {
    const lineEl = lineRef.current;
    const sinceEl = sinceRef.current;
    if (!lineEl || !sinceEl || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      const needed =
        (audienceRef.current?.scrollWidth ?? 0) +
        (linkRef.current?.getBoundingClientRect().width ?? 0) +
        sinceEl.getBoundingClientRect().width;
      // One pixel of slack: scrollWidth rounds to whole pixels.
      setSinceFits(needed + 1 <= lineEl.getBoundingClientRect().width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(lineEl);
    observer.observe(sinceEl);
    if (audienceRef.current) observer.observe(audienceRef.current);
    return (): void => observer.disconnect();
  }, [audience, since, publicLink, publicLinkTitle]);

  return (
    <span
      ref={lineRef}
      data-testid={`customize-row-subtitle-${entryId}`}
      className={`relative mt-0.5 flex min-w-0 items-center overflow-hidden whitespace-nowrap text-xs fg-tertiary ${REPLAY_BLOCK_CLASS}`}
    >
      {audience !== undefined && (
        <Tooltip label={audience} allowShrink replayBlock>
          <span
            ref={audienceRef}
            data-testid={`customize-row-audience-${entryId}`}
            className="min-w-0 truncate"
          >
            {audience}
          </span>
        </Tooltip>
      )}
      {publicLink && (
        <span ref={linkRef} className="inline-flex shrink-0 items-center">
          {audience !== undefined && (
            <span className="whitespace-pre">{SEPARATOR}</span>
          )}
          <Badge
            tone="neutral"
            icon={GlobeIcon}
            title={publicLinkTitle}
            data-testid={`customize-row-public-link-${entryId}`}
          >
            {SHARED_BY_YOU_PUBLIC_LINK_LABEL}
          </Badge>
        </span>
      )}
      {since !== undefined && (
        <span
          ref={sinceRef}
          data-testid={`customize-row-shared-since-${entryId}`}
          aria-hidden={sinceFits ? undefined : true}
          className={`shrink-0 whitespace-pre${sinceFits ? '' : ' invisible absolute left-0 top-0'}`}
        >
          {audience !== undefined || publicLink ? SEPARATOR : ''}
          {since}
        </span>
      )}
    </span>
  );
}
