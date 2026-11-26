'use client';

import { CodeBlock } from '@canopy/ui-shared/primitives/CodeBlock';
import { FileLineRangeHighlight } from '@canopy/ui-shared/components';

import { useCallback, useEffect, useMemo, useRef, type JSX } from 'react';
import {
  resolveFileLineRange,
  splitFileLineRange,
} from '@canopy/ui-shared/lib/file-line-range';
import type { FileContentScrollBinding, FileLineReveal } from './FileViewer';

export interface FileReadOnlyCodeProps {
  readonly content: string;
  readonly scrollBinding?: FileContentScrollBinding;
  readonly reveal?: FileLineReveal;
  readonly revealReady?: boolean;
  /**
   * Stable host file identity when this component is reused across files.
   * Hosts may instead key the component by file. Content edits never replay.
   */
  readonly fileIdentity?: string;
}

/**
 * Center a line target in its own scroller. Only `scrollTop` of `container`
 * changes, so the surrounding chat or page never moves.
 */
function centerLineTarget(container: HTMLElement, target: HTMLElement): void {
  const containerTop =
    container.getBoundingClientRect().top + container.clientTop;
  const targetRect = target.getBoundingClientRect();
  const offset = targetRect.top - containerTop;
  const centering = Math.max(
    0,
    (container.clientHeight - targetRect.height) / 2,
  );
  container.scrollTop = Math.max(0, container.scrollTop + offset - centering);
}

export function FileReadOnlyCode({
  content,
  scrollBinding,
  reveal,
  revealReady = true,
  fileIdentity,
}: FileReadOnlyCodeProps): JSX.Element {
  const line = reveal?.line;
  const lineEnd = reveal?.lineEnd;
  const revision = reveal?.revision;
  const highlight = useMemo(() => {
    if (line === undefined) return null;
    const range = resolveFileLineRange(content, { line, lineEnd });
    return { range, segments: splitFileLineRange(content, range) };
  }, [content, line, lineEnd]);

  const appliedReveal = useRef<string | null>(null);
  const scrollerRef = useRef<HTMLPreElement | null>(null);
  const targetRef = useRef<HTMLSpanElement | null>(null);
  const bindScroller = scrollBinding?.ref;
  const setScroller = useCallback(
    (node: HTMLPreElement | null): void => {
      scrollerRef.current = node;
      bindScroller?.(node);
    },
    [bindScroller],
  );

  // One scroll per request: mounting (content ready, or entering raw mode)
  // and each new file/line/revision. Content edits and reloads do not replay it.
  const revealKey =
    line === undefined ? null : `${line}:${lineEnd ?? ''}:${revision ?? ''}`;
  useEffect(() => {
    const scroller = scrollerRef.current;
    const target = targetRef.current;
    if (revealKey === null) {
      appliedReveal.current = null;
      return;
    }
    const key = JSON.stringify([fileIdentity, revealKey]);
    if (
      !revealReady ||
      scroller === null ||
      target === null ||
      appliedReveal.current === key
    )
      return;
    appliedReveal.current = key;
    centerLineTarget(scroller, target);
  }, [fileIdentity, revealKey, revealReady]);

  return (
    <CodeBlock
      ref={setScroller}
      onScroll={scrollBinding?.onScroll}
      variant="pane"
      size="xs"
      wrap="none"
      tone="soft"
      replay="block"
      className="min-h-0 flex-1"
      data-testid="file-viewer-raw-text-scroll"
    >
      {highlight === null ? (
        content
      ) : (
        <>
          {highlight.segments.before}
          <FileLineRangeHighlight
            // A terminal newline creates an empty final source line, but
            // creates no final CSS line box. Reserve that row without text.
            style={{
              minHeight: `${highlight.range.lineEnd - highlight.range.line + 1}lh`,
            }}
            data-testid="file-viewer-line-range"
            data-line-start={highlight.range.line}
            data-line-end={highlight.range.lineEnd}
          >
            {/* A zero-width, line-tall target keeps blank and empty final
                lines measurable without adding text to the file. */}
            <span
              ref={targetRef}
              aria-hidden
              className="inline-block h-5 w-0 align-top"
              data-testid="file-viewer-line-target"
            />
            {highlight.segments.range}
          </FileLineRangeHighlight>
          {highlight.segments.after}
        </>
      )}
    </CodeBlock>
  );
}
