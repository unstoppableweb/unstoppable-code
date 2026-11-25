import type { CachedIndexEntry } from '@/stores/fileListStore';
import type { TurnGroupOrMessage, TurnMessage } from './types';

/** A small number of long reports can cost more layout work than many turns. */
export function shouldVirtualizeTranscript(
  groups: readonly TurnGroupOrMessage[],
): boolean {
  if (groups.length >= 80) return true;
  if (groups.length < 2) return false;
  let characters = 0;
  for (const group of groups) {
    const messages =
      group.kind === 'turn-group'
        ? [group.userMessage, ...group.assistantMessages]
        : [group.message];
    for (const message of messages) {
      for (const block of message.blocks) {
        // Collapsed tool output is not rendered text. Counting its size would
        // unnecessarily window short chats with a large deferred result.
        if (block.type !== 'text') continue;
        characters += block.text.length;
        if (characters >= 128 * 1024) return true;
      }
    }
  }
  return false;
}

export function shouldPreloadTranscriptFileIndex(
  hasMessages: boolean,
  entry: CachedIndexEntry | undefined,
  isLoading: boolean,
  error: string | undefined,
): boolean {
  return (
    hasMessages && entry === undefined && !isLoading && error === undefined
  );
}

export interface TranscriptWindowRange {
  startIndex: number;
  endIndex: number;
  overscan: number;
  count: number;
}

/** How many new overscan sections each side of the visible ones may mount. */
export interface TranscriptOverscanLimits {
  before: number;
  after: number;
}

/** Mounted content kept past each edge of the viewport, in viewport heights. */
const TRANSCRIPT_OVERSCAN_VIEWPORTS = 2;

/**
 * The overscan sections each side of the visible ones needs for about two
 * viewports of mounted content to lie past that edge of the viewport.
 *
 * Overscan is there so a scroll finds content already mounted. A section
 * holding a long report can run several viewports past the edge on its own:
 * its neighbours are then thousands of pixels from view, and mounting them
 * builds, styles and lays out whole turns nobody is near. Short sections
 * still get the full `range.overscan`. Positions the caller cannot give yet
 * (no viewport height, no section) leave the count unlimited.
 */
export function transcriptOverscanLimits(
  range: TranscriptWindowRange,
  viewport: { top: number; height: number },
  sectionAt: (index: number) => { start: number; end: number } | undefined,
): TranscriptOverscanLimits {
  const first = sectionAt(range.startIndex);
  const last = sectionAt(range.endIndex);
  if (!(viewport.height > 0) || !first || !last) {
    return { before: range.overscan, after: range.overscan };
  }
  const reach = viewport.height * TRANSCRIPT_OVERSCAN_VIEWPORTS;
  let before = 0;
  let covered = viewport.top - first.start;
  while (covered < reach && before < range.overscan) {
    const section = sectionAt(range.startIndex - before - 1);
    if (!section) break;
    before += 1;
    covered += section.end - section.start;
  }
  let after = 0;
  covered = last.end - (viewport.top + viewport.height);
  while (covered < reach && after < range.overscan) {
    const section = sectionAt(range.endIndex + after + 1);
    if (!section) break;
    after += 1;
    covered += section.end - section.start;
  }
  return { before, after };
}

/**
 * The transcript window's sections: every visible one, plus its overscan
 * neighbours added progressively.
 *
 * A transcript section can be a whole turn of rendered Markdown, so a jump
 * that mounts the visible sections and all of their overscan at once builds,
 * styles and lays out several of them in one frame. Overscan sections that
 * are already mounted stay, and ones `measured` reports (a restored
 * position's saved sizes) join at once. Other new ones wait until every
 * visible section is mounted, then join one per pass, nearest first, and
 * only as far out as `limits` allows on their side.
 */
export function progressiveTranscriptRange(
  range: TranscriptWindowRange,
  mounted: ReadonlySet<number>,
  measured: (index: number) => boolean = () => false,
  limits: TranscriptOverscanLimits = {
    before: range.overscan,
    after: range.overscan,
  },
): number[] {
  const { startIndex, endIndex, overscan, count } = range;
  const indexes: number[] = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    indexes.push(index);
  }
  let admissions = indexes.every((index) => mounted.has(index)) ? 1 : 0;
  for (let distance = 1; distance <= overscan; distance += 1) {
    const candidates = [
      { index: endIndex + distance, limit: limits.after },
      { index: startIndex - distance, limit: limits.before },
    ];
    for (const { index, limit } of candidates) {
      if (index < 0 || index >= count) continue;
      if (mounted.has(index) || measured(index)) {
        indexes.push(index);
      } else if (distance <= limit && admissions > 0) {
        indexes.push(index);
        admissions -= 1;
      }
    }
  }
  return indexes.sort((left, right) => left - right);
}

/** Height assumed for a transcript section before it is measured. */
const MIN_ESTIMATED_SECTION_HEIGHT_PX = 168;
/**
 * Rendered Markdown runs at roughly a quarter pixel of height per character
 * of source at the transcript's reading width. The estimate stays below that
 * so it does not overshoot ordinary turns.
 */
const ESTIMATED_HEIGHT_PX_PER_CHARACTER = 0.15;
const visibleCharacterCache = new WeakMap<TurnGroupOrMessage, number>();

function textCharacters(message: TurnMessage | undefined): number {
  let characters = 0;
  for (const block of message?.blocks ?? []) {
    if (block.type === 'text') characters += block.text.length;
  }
  return characters;
}

/** Characters of the text a collapsed item shows: its prompt and final reply. */
function visibleCharacters(item: TurnGroupOrMessage): number {
  const cached = visibleCharacterCache.get(item);
  if (cached !== undefined) return cached;
  let characters: number;
  if (item.kind === 'turn-group') {
    let reply = 0;
    for (
      let index = item.assistantMessages.length - 1;
      index >= 0;
      index -= 1
    ) {
      reply = textCharacters(item.assistantMessages[index]);
      if (reply > 0) break;
    }
    characters = textCharacters(item.userMessage) + reply;
  } else {
    characters = textCharacters(item.message);
  }
  visibleCharacterCache.set(item, characters);
  return characters;
}

/**
 * Pre-measurement height of a transcript section.
 *
 * Until a section is measured the virtualizer places it with this estimate.
 * A flat estimate makes a section holding a long report look a few lines
 * tall, so a jump to it counts several of its neighbours as visible and
 * builds them all, only to drop them once the first one is measured.
 */
export function estimateTranscriptSectionHeight(
  items: readonly TurnGroupOrMessage[],
): number {
  let characters = 0;
  for (const item of items) characters += visibleCharacters(item);
  return Math.max(
    MIN_ESTIMATED_SECTION_HEIGHT_PX,
    Math.round(characters * ESTIMATED_HEIGHT_PX_PER_CHARACTER),
  );
}

/** The size of a transcript's scroll viewport, as the virtualizer reads it. */
export interface TranscriptViewportRect {
  width: number;
  height: number;
}

/** A chat's transcript: its id, or its id within a worktree. */
type TranscriptViewportTarget =
  | string
  | { projectId: string; worktreeId: string; chatId: string };

const TRANSCRIPT_VIEWPORT_RECT_LIMIT = 256;
const transcriptViewportRects = new Map<string, TranscriptViewportRect>();

function transcriptViewportKey(target: TranscriptViewportTarget): string {
  return typeof target === 'string'
    ? target
    : JSON.stringify([target.projectId, target.worktreeId, target.chatId]);
}

/**
 * Remembers the viewport size a chat's transcript was last shown at.
 *
 * A transcript's first render has no viewport to measure, so the virtualizer
 * windows it for a viewport of no height: one section. A restored position
 * that shows several sections then mounts the others in a second commit,
 * once the viewport is read. The remembered size lets the first render
 * window the transcript for the viewport it most likely has; the virtualizer
 * still reads the real one on mount and corrects a size that changed.
 *
 * A collapsed viewport (an inactive panel tab) is no size to return to.
 */
export function rememberTranscriptViewportRect(
  target: TranscriptViewportTarget,
  rect: TranscriptViewportRect,
): void {
  if (!(rect.width > 0) || !(rect.height > 0)) return;
  const key = transcriptViewportKey(target);
  const known = transcriptViewportRects.get(key);
  if (known?.width === rect.width && known.height === rect.height) return;
  // Re-inserted so the oldest entry is the least recently resized chat.
  transcriptViewportRects.delete(key);
  transcriptViewportRects.set(key, { width: rect.width, height: rect.height });
  if (transcriptViewportRects.size > TRANSCRIPT_VIEWPORT_RECT_LIMIT) {
    const oldest = transcriptViewportRects.keys().next();
    if (!oldest.done) transcriptViewportRects.delete(oldest.value);
  }
}

/** The viewport size remembered for a chat's transcript, if any. */
export function recalledTranscriptViewportRect(
  target: TranscriptViewportTarget,
): TranscriptViewportRect | undefined {
  return transcriptViewportRects.get(transcriptViewportKey(target));
}
