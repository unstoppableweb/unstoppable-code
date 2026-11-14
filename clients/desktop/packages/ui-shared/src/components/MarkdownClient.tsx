'use client';

import {
  Children,
  cloneElement,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import MarkdownToJsx, { compiler, RuleType } from 'markdown-to-jsx';
import { prepareMarkdownRender, type MarkdownProps } from './markdown-render';
import { useSingleDollarMathEnabled } from './use-single-dollar-math';
import {
  loadedSmoothMarkdown,
  useMountedInOpeningTranscript,
  useSmoothStreaming,
  type SmoothMarkdownTools,
} from './streaming-text';

const SMOOTH_MARKDOWN_TOOLS: SmoothMarkdownTools = {
  compiler,
  prepareMarkdownRender,
  textRule: RuleType.text,
};

/** Browser-safe markdown renderer shared by desktop, web, and ui-app. */
export const Markdown = memo(function Markdown(
  props: MarkdownProps,
): JSX.Element {
  // Smooth streaming (Labs): decided once, when the document mounts. One
  // that mounts streaming with the switch on (and its renderer loaded) keeps
  // the paced, fading renderer for its lifetime, so the end of the stream
  // never re-mounts the reply; one already on screen when the switch flips
  // stays as it is.
  const smoothStreaming = useSmoothStreaming();
  const alreadyOnScreen = useMountedInOpeningTranscript();
  const [SmoothRenderer] = useState(() =>
    props.streaming && smoothStreaming ? loadedSmoothMarkdown() : null,
  );
  return SmoothRenderer ? (
    <SmoothRenderer
      {...props}
      tools={SMOOTH_MARKDOWN_TOOLS}
      alreadyOnScreen={alreadyOnScreen}
    />
  ) : (
    <StandardMarkdown {...props} />
  );
});

function StandardMarkdown({
  children,
  options,
  streaming,
  progressive,
}: MarkdownProps): JSX.Element {
  // The setting is read inside prepareMarkdownRender; subscribing re-renders.
  const singleDollarMath = useSingleDollarMathEnabled();
  const prepared = useMemo(
    () => prepareMarkdownRender(children, options, streaming),
    [children, options, progressive, streaming, singleDollarMath],
  );
  const minimumCharacters = progressive?.minimumCharacters ?? 16_000;
  const initialBlocks = Math.max(1, progressive?.initialBlocks ?? 12);
  const blocksPerFrame = Math.max(1, progressive?.blocksPerFrame ?? 12);
  const atomicallyRenderedMarkdown = useRef<string | null>(null);
  const wasStreamingRef = useRef(Boolean(streaming));
  const completedAfterStreaming = wasStreamingRef.current && !streaming;
  const compiledDocument = useMemo(() => {
    if (
      !progressive ||
      streaming ||
      completedAfterStreaming ||
      children.length < minimumCharacters ||
      atomicallyRenderedMarkdown.current === prepared.markdown
    ) {
      return null;
    }
    const rendered = compiler(prepared.markdown, prepared.options);
    if (!isValidElement<{ children?: ReactNode }>(rendered)) return null;
    const blocks = Children.toArray(rendered.props.children);
    return {
      root: rendered,
      blocks,
    };
  }, [
    children.length,
    completedAfterStreaming,
    initialBlocks,
    minimumCharacters,
    prepared.markdown,
    prepared.options,
    progressive,
    streaming,
  ]);
  const progressiveDocument =
    compiledDocument && compiledDocument.blocks.length > initialBlocks
      ? compiledDocument
      : null;
  useEffect(() => {
    if (!progressiveDocument) {
      atomicallyRenderedMarkdown.current = prepared.markdown;
    }
  }, [prepared.markdown, progressiveDocument]);
  useEffect(() => {
    wasStreamingRef.current = Boolean(streaming);
  }, [streaming]);
  const [progress, setProgress] = useState(() => ({
    markdown: progressiveDocument ? prepared.markdown : null,
    visibleBlocks: initialBlocks,
  }));
  let currentProgress = progress;
  const progressiveMarkdown = progressiveDocument ? prepared.markdown : null;
  if (progress.markdown !== progressiveMarkdown) {
    currentProgress = {
      markdown: progressiveMarkdown,
      visibleBlocks: initialBlocks,
    };
    setProgress(currentProgress);
  }
  useEffect(() => {
    if (!progressiveDocument) return;
    if (currentProgress.visibleBlocks >= progressiveDocument.blocks.length) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      setProgress((current) => ({
        markdown: prepared.markdown,
        visibleBlocks: Math.min(
          progressiveDocument.blocks.length,
          current.visibleBlocks + blocksPerFrame,
        ),
      }));
    });
    return (): void => window.cancelAnimationFrame(frame);
  }, [
    blocksPerFrame,
    currentProgress.visibleBlocks,
    prepared.markdown,
    progressiveDocument,
  ]);

  if (progressiveDocument) {
    const visibleBlockCount = Math.min(
      currentProgress.visibleBlocks,
      progressiveDocument.blocks.length,
    );
    const complete = visibleBlockCount >= progressiveDocument.blocks.length;
    const visibleBlocks = progressiveDocument.blocks
      .slice(0, visibleBlockCount)
      .map((block, index) =>
        index === 0 &&
        isValidElement<{
          'data-progressive-markdown-complete'?: string;
        }>(block)
          ? cloneElement(block, {
              'data-progressive-markdown-complete': String(complete),
            })
          : block,
      );
    return cloneElement(progressiveDocument.root, undefined, ...visibleBlocks);
  }
  if (compiledDocument) return compiledDocument.root;
  return (
    <MarkdownToJsx options={prepared.options}>
      {prepared.markdown}
    </MarkdownToJsx>
  );
}
