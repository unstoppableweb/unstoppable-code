'use client';

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type { MarkdownProps } from './markdown-render';
import { useSingleDollarMathEnabled } from './use-single-dollar-math';
import type { SmoothMarkdownTools } from './streaming-text';
import {
  STREAMING_SOURCE_QUIET_MS,
  STREAMING_WORD_FADE_MS,
  StreamingWordFade,
  useSmoothStreamingText,
} from './streaming-text-pacing';

/**
 * A streaming document under Smooth streaming (Labs): paced in whole words,
 * each new stretch fading in. `Markdown` renders it for a document that
 * mounts streaming with the switch on, for the document's lifetime, so the
 * end of the stream never re-mounts the reply. Loaded as its own chunk.
 */
export function SmoothMarkdown({
  children: source,
  options,
  streaming,
  tools,
  alreadyOnScreen,
}: MarkdownProps & {
  readonly tools: SmoothMarkdownTools;
  /** It was there before the reader arrived: only what follows is paced. */
  readonly alreadyOnScreen: boolean;
}): JSX.Element {
  const { compiler, prepareMarkdownRender, textRule } = tools;
  const children = useSmoothStreamingText(
    source,
    Boolean(streaming),
    true,
    alreadyOnScreen,
  );
  const [fade] = useState(() => new StreamingWordFade(alreadyOnScreen));
  // Bumped once the newest stretch has faded in, to turn its spans back into
  // plain text when no further beat would.
  const [settleRender, setSettleRender] = useState(0);
  // The text is still arriving: it changed within the last moment of a
  // stream. Hosts mark a whole turn as streaming, so a block that arrived
  // whole and finished its reveal must not keep hiding what follows an
  // unclosed mark until the turn ends.
  const [growing, setGrowing] = useState(!alreadyOnScreen);
  const settledSource = useRef(alreadyOnScreen ? source : null);
  useEffect(() => {
    if (!streaming) {
      setGrowing(false);
      return;
    }
    if (source === settledSource.current) return;
    settledSource.current = null;
    setGrowing(true);
    const timer = window.setTimeout(
      () => setGrowing(false),
      STREAMING_SOURCE_QUIET_MS,
    );
    return (): void => window.clearTimeout(timer);
  }, [source, streaming]);
  // Still streaming as far as the reader can see: more text is arriving, or
  // the paced reveal has not reached the whole text yet.
  const revealing = growing || children.length < source.length;
  const singleDollarMath = useSingleDollarMathEnabled();
  const rendered = useMemo(() => {
    // Prepared afresh for each compile: its render rule counts the Mermaid
    // and math blocks it renders, and a settle pass must not count them twice.
    const prepared = prepareMarkdownRender(children, options, revealing);
    const baseRule = prepared.options.renderRule;
    fade.beginRender(performance.now());
    return compiler(prepared.markdown, {
      ...prepared.options,
      // Hide an unclosed `**` or backtick until its closing mark is shown.
      optimizeForStreaming: revealing,
      renderRule(next, node, renderChildren, state): ReactNode {
        if (node.type !== textRule) {
          return baseRule
            ? baseRule(next, node, renderChildren, state)
            : next();
        }
        if (!baseRule) return fade.renderText(node.text);
        // The configured rule may rewrite text (soft line breaks become
        // `<br>`s); fade the strings it returns and keep everything else.
        let deferred = false;
        const output = baseRule(
          () => {
            deferred = true;
            return fade.renderText(node.text);
          },
          node,
          renderChildren,
          state,
        );
        if (deferred) return output;
        if (typeof output === 'string') return fade.renderText(output);
        if (!Array.isArray(output)) return output;
        return output.map((piece: ReactNode) =>
          typeof piece === 'string' ? fade.renderText(piece) : piece,
        );
      },
    });
    // `settleRender` re-renders the settled spans as plain text.
  }, [
    children,
    compiler,
    fade,
    options,
    prepareMarkdownRender,
    revealing,
    settleRender,
    singleDollarMath,
    textRule,
  ]);
  useLayoutEffect(() => {
    fade.commit();
    if (!fade.fading) return;
    const timer = window.setTimeout(
      () => setSettleRender((value) => value + 1),
      STREAMING_WORD_FADE_MS + 20,
    );
    return (): void => window.clearTimeout(timer);
  }, [fade, rendered]);
  return <>{rendered}</>;
}
