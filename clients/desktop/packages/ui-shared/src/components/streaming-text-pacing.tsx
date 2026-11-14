'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/*
 * The pacing and fading behind Smooth streaming (see `streaming-text.tsx`).
 * Only the lazily loaded `MarkdownSmooth` chunk imports this module.
 */

/**
 * A streaming text that has not changed for this long has stopped growing
 * for now, so a mark it leaves open (`**`, a backtick) is shown as written.
 */
export const STREAMING_SOURCE_QUIET_MS = 1500;

/** Matches the animation duration of `.stream-word-fade` in streaming-text.css. */
export const STREAMING_WORD_FADE_MS = 180;

/** How far the beat may trail a token stream before it speeds up. */
const STEADY_LAG_SECONDS = 0.28;
/**
 * The fastest beat. A whole block that lands at once (Claude and Codex text
 * arrives as complete blocks on desktop) types in at this rate rather than
 * appearing in one frame...
 */
const MAX_CHARACTERS_PER_SECOND = 1400;
/** ...unless that would take longer than this, then it goes faster. */
const MAX_CATCH_UP_SECONDS = 0.9;
/** The slowest beat, so a slow stream still reads as typing, not stalling. */
const MIN_CHARACTERS_PER_SECOND = 45;
/** A half-arrived last word waits this long for the rest before showing. */
const PARTIAL_WORD_HOLD_MS = 450;
/**
 * The beat: at most one reveal per this many milliseconds. Each reveal
 * re-renders the whole document, and with the fade a 30 Hz beat reads as
 * smoothly as 60 Hz at about half the work.
 */
const BEAT_MS = 32;
/** Longer "words" (URLs, paths) are revealed by the beat, not whole. */
const MAX_SNAPPED_WORD_LENGTH = 32;

/**
 * Where a word may end: whitespace, or any CJK character (ideographs, kana,
 * fullwidth forms), since those scripts write words without spaces.
 */
const WORD_BREAK = /[\s\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;

function isBoundary(character: string | undefined): boolean {
  return character === undefined || WORD_BREAK.test(character);
}

/** Extends `index` to the end of the word it lands in, if that word is short. */
function snapToWordEnd(text: string, index: number): number {
  if (index <= 0 || index >= text.length || isBoundary(text[index])) {
    return index;
  }
  let end = index;
  while (end < text.length && !isBoundary(text[end])) end += 1;
  return end - index <= MAX_SNAPPED_WORD_LENGTH ? end : index;
}

/**
 * The end of the last whole word, so a half-arrived word can wait. A tail too
 * long to be one word (a URL, a path) does not wait.
 */
function lastWordBoundary(text: string): number {
  let index = text.length - 1;
  while (index >= 0 && !isBoundary(text[index])) index -= 1;
  return text.length - (index + 1) > MAX_SNAPPED_WORD_LENGTH
    ? text.length
    : index + 1;
}

/**
 * The part of a streaming `text` to show now. While `pacing`, it starts empty,
 * trails the stream on a steady beat and drains the rest once streaming
 * stops; otherwise it is `text` itself. Text that is already there at mount is
 * paced too, since on desktop a Claude or Codex text block mounts with its
 * whole text, unless `alreadyShown` says the reader had it before (a return to
 * a running chat). Text that was on screen before pacing turned on (the Labs
 * switch flipped mid-turn) stays on screen. Only the caller re-renders per
 * beat.
 */
export function useSmoothStreamingText(
  text: string,
  streaming: boolean,
  pacing: boolean,
  alreadyShown = false,
): string {
  const [shown, setShown] = useState(alreadyShown ? text.length : 0);
  const state = useRef({
    revealed: alreadyShown ? text.length : 0,
    text,
    streaming,
    /** When the text last changed; 0 until the first commit. */
    lastChangeAt: 0,
    /** Everything that has arrived is on screen by then. */
    deadline: 0,
    /** The text has been shown whole, without pacing. */
    unpaced: false,
    frame: 0,
    lastBeatAt: 0,
  });

  useLayoutEffect(() => {
    const current = state.current;
    if (!pacing) {
      current.revealed = text.length;
      current.text = text;
      current.unpaced = true;
      return;
    }
    const now = performance.now();
    if (current.unpaced) {
      // Pacing just turned on: what was already on screen stays.
      current.unpaced = false;
      setShown(current.revealed);
    }
    if (text !== current.text || current.lastChangeAt === 0) {
      // A rewritten (not appended) text restarts from what still matches.
      if (!text.startsWith(current.text.slice(0, current.revealed))) {
        let common = 0;
        const limit = Math.min(current.revealed, text.length);
        while (common < limit && text[common] === current.text[common]) {
          common += 1;
        }
        current.revealed = common;
        setShown(common);
      }
      current.text = text;
      current.lastChangeAt = now;
      current.deadline = now + MAX_CATCH_UP_SECONDS * 1000;
    }
    current.streaming = streaming;
  }, [pacing, text, streaming]);

  useEffect(() => {
    const current = state.current;
    if (!pacing || current.revealed >= text.length) return;
    const tick = (now: number): void => {
      if (current.lastBeatAt !== 0 && now - current.lastBeatAt < BEAT_MS) {
        current.frame = window.requestAnimationFrame(tick);
        return;
      }
      const elapsed =
        current.lastBeatAt === 0
          ? BEAT_MS / 1000
          : Math.min(0.1, (now - current.lastBeatAt) / 1000);
      current.lastBeatAt = now;
      const target = current.text;
      const holdPartialWord =
        current.streaming && now - current.lastChangeAt < PARTIAL_WORD_HOLD_MS;
      const limit = holdPartialWord ? lastWordBoundary(target) : target.length;
      const backlog = limit - current.revealed;
      if (backlog <= 0) {
        current.lastBeatAt = 0;
        // Wait for more text, or for the partial word's hold to run out.
        current.frame =
          current.revealed < target.length
            ? window.requestAnimationFrame(tick)
            : 0;
        return;
      }
      // Fast enough to keep the lag short, and to have everything that has
      // arrived on screen by the deadline.
      const secondsLeft = Math.max(BEAT_MS, current.deadline - now) / 1000;
      const perSecond = Math.max(
        MIN_CHARACTERS_PER_SECOND,
        Math.min(MAX_CHARACTERS_PER_SECOND, backlog / STEADY_LAG_SECONDS),
        backlog / secondsLeft,
      );
      const next =
        now + BEAT_MS >= current.deadline
          ? limit
          : Math.min(
              limit,
              snapToWordEnd(
                target,
                Math.ceil(current.revealed + perSecond * elapsed),
              ),
            );
      if (next !== current.revealed) {
        current.revealed = next;
        setShown(next);
      }
      current.frame =
        current.revealed < target.length
          ? window.requestAnimationFrame(tick)
          : 0;
      if (current.frame === 0) current.lastBeatAt = 0;
    };
    current.frame = window.requestAnimationFrame(tick);
    // Cancelled on every change and on unmount (and StrictMode's replay), so
    // a stale frame id never blocks the next run.
    return (): void => {
      window.cancelAnimationFrame(current.frame);
      current.frame = 0;
    };
  }, [pacing, text, streaming]);

  if (!pacing) return text;
  return text.slice(0, Math.min(shown, text.length));
}

interface RevealStretch {
  /** Rendered-text offsets of the stretch one commit revealed. */
  readonly start: number;
  readonly end: number;
  readonly at: number;
}

/**
 * Remembers which stretch of rendered text each commit revealed, so markdown
 * text nodes can wrap the stretches still fading in one span each. A span
 * keeps its key (its start offset) from the render that revealed it, so its
 * CSS fade runs once; stretches older than the fade are plain strings again,
 * which keeps transcript decorators that read string children working.
 */
export class StreamingWordFade {
  private stretches: RevealStretch[] = [];
  /** Everything before this rendered offset has finished fading. */
  private settledEnd = 0;
  private cursor = 0;
  private renderAt = 0;

  /** `firstCommitSettled`: the first commit's text is already on screen, so it never fades. */
  constructor(private firstCommitSettled = false) {}

  /** Call before each compile of the document. */
  beginRender(now: number): void {
    this.cursor = 0;
    this.renderAt = now;
    const settledBefore = now - STREAMING_WORD_FADE_MS;
    let oldest = this.stretches[0];
    while (oldest !== undefined && oldest.at <= settledBefore) {
      this.settledEnd = Math.max(this.settledEnd, oldest.end);
      this.stretches.shift();
      oldest = this.stretches[0];
    }
  }

  /** Call after the compiled document commits. */
  commit(): void {
    if (this.firstCommitSettled) {
      this.firstCommitSettled = false;
      this.settledEnd = this.cursor;
      return;
    }
    const start = this.stretches.at(-1)?.end ?? this.settledEnd;
    if (this.cursor > start) {
      this.stretches.push({ start, end: this.cursor, at: this.renderAt });
    }
  }

  /** Whether a later render would turn fading spans back into plain text. */
  get fading(): boolean {
    return this.stretches.length > 0;
  }

  /** One markdown text node, with its still-fading stretches in spans. */
  renderText(text: string): ReactNode {
    const start = this.cursor;
    const end = start + text.length;
    this.cursor = end;
    if (this.firstCommitSettled || end <= this.settledEnd) return text;
    const parts: ReactNode[] = [];
    let offset = Math.max(start, this.settledEnd);
    if (offset > start) parts.push(text.slice(0, offset - start));
    for (const stretch of this.stretches) {
      if (stretch.end <= offset) continue;
      if (offset >= end) break;
      const sliceEnd = Math.min(end, stretch.end);
      parts.push(this.span(text, start, offset, sliceEnd));
      offset = sliceEnd;
    }
    // Text this render reveals for the first time.
    if (offset < end) parts.push(this.span(text, start, offset, end));
    return parts;
  }

  private span(
    text: string,
    nodeStart: number,
    from: number,
    to: number,
  ): ReactNode {
    return (
      <span key={from} className="stream-word-fade">
        {text.slice(from - nodeStart, to - nodeStart)}
      </span>
    );
  }
}
