'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { prefersReducedMotion } from '../lib/reduced-motion';
import type { compiler, RuleType } from 'markdown-to-jsx';
import type { MarkdownProps, prepareMarkdownRender } from './markdown-render';

/**
 * Smooth streaming: a streaming reply's
 * text is revealed in whole words on a steady 30 Hz beat that trails the
 * stream slightly, and each newly revealed stretch fades in. Half-typed
 * markdown (an unclosed `**` or backtick) stays hidden until it closes.
 * Hosts provide the choice once at their root; `Markdown` reads it while a
 * document streams. Reduced motion turns the beat and the fade off.
 *
 * The pacing and fading renderer (`MarkdownSmooth`) is its own chunk, kept
 * off every page's first load: the provider loads it once the choice is on,
 * and a document that mounts before it has loaded renders as today.
 */
const SmoothStreamingContext = createContext(false);

export function SmoothStreamingProvider({
  value,
  children,
}: {
  readonly value: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  useEffect(() => {
    if (value) void preloadSmoothMarkdown();
  }, [value]);
  return (
    <SmoothStreamingContext.Provider value={value}>
      {children}
    </SmoothStreamingContext.Provider>
  );
}

/**
 * Whether smooth streaming applies here: the host's choice, unless the
 * reader asked for reduced motion, which keeps today's rendering everywhere.
 */
export function useSmoothStreaming(): boolean {
  return useContext(SmoothStreamingContext) && !prefersReducedMotion();
}

/**
 * How long text mounting in a transcript that just opened counts as already
 * there. A window, not one commit: a virtualized transcript mounts its rows
 * only after it measures. Text landing within it simply shows without typing.
 */
const TRANSCRIPT_OPENING_MS = 300;

interface OpeningTranscript {
  readonly id: string;
  readonly opened: { id: string | null };
}

const OpeningTranscriptContext = createContext<OpeningTranscript | null>(null);

/**
 * One chat's transcript. What it already holds when it opens, a return to a
 * running chat included, stays on screen rather than typing in again: only
 * text that arrives while the reader is here is paced. Blocks of a running
 * turn cannot tell this from their props, since hosts mark the whole turn as
 * streaming and desktop text mounts whole either way.
 */
export function StreamingTranscript({
  id,
  hasContent,
  children,
}: {
  readonly id: string;
  /** False until the transcript has loaded, which keeps it opening. */
  readonly hasContent: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  const [opened] = useState<OpeningTranscript['opened']>(() => ({ id: null }));
  useEffect(() => {
    if (!hasContent) return;
    const timer = window.setTimeout(() => {
      opened.id = id;
    }, TRANSCRIPT_OPENING_MS);
    return (): void => window.clearTimeout(timer);
  }, [hasContent, id, opened]);
  const opening = useMemo(() => ({ id, opened }), [id, opened]);
  return (
    <OpeningTranscriptContext.Provider value={opening}>
      {children}
    </OpeningTranscriptContext.Provider>
  );
}

/** Whether this document mounted inside a transcript that was just opening. */
export function useMountedInOpeningTranscript(): boolean {
  const opening = useContext(OpeningTranscriptContext);
  const [mountedOpening] = useState(
    () => opening !== null && opening.opened.id !== opening.id,
  );
  return mountedOpening;
}

/**
 * What the smooth renderer compiles with, handed over by `Markdown`. The
 * renderer's chunk imports none of these itself, so it shares no module with
 * the first load and the first load's chunks stay as they were.
 */
export interface SmoothMarkdownTools {
  readonly compiler: typeof compiler;
  readonly prepareMarkdownRender: typeof prepareMarkdownRender;
  readonly textRule: typeof RuleType.text;
}

type SmoothMarkdownComponent = (
  props: MarkdownProps & {
    readonly tools: SmoothMarkdownTools;
    readonly alreadyOnScreen: boolean;
  },
) => JSX.Element;

let smoothMarkdown: SmoothMarkdownComponent | null = null;
let smoothMarkdownLoad: Promise<void> | null = null;

/** Loads the smooth Markdown renderer; resolves once it can render. */
export function preloadSmoothMarkdown(): Promise<void> {
  smoothMarkdownLoad ??= import('./MarkdownSmooth').then((module) => {
    smoothMarkdown = module.SmoothMarkdown;
  });
  return smoothMarkdownLoad;
}

/** The smooth Markdown renderer once loaded, otherwise `null`. */
export function loadedSmoothMarkdown(): SmoothMarkdownComponent | null {
  return smoothMarkdown;
}
