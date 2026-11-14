import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type {
  ChatTranscriptSearchMatch,
  ChatTranscriptSearchResult,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { createDomSearchExecutor } from '@/lib/dom-search-highlight';
import { useChatStore, useChatTabRenderState } from '@/stores/chatStore';
import { chatBackendFor } from '@/stores/chat/backend';
import { loadChatTranscriptPage } from '@/stores/chat/transcript-pages';

export interface TranscriptSearchSelection extends ChatTranscriptSearchMatch {
  /** Source-relative index across rendered pieces and folded results. */
  occurrence: number;
  query: string;
  generation: number;
}

const EMPTY_RESULT: ChatTranscriptSearchResult = { matches: [], totalCount: 0 };
const QUERY_DEBOUNCE_MS = 150;
/** Committed-transcript changes coalesce so a streaming turn does not rescan
 * the canonical JSONL (under the scope lease) for every message it commits. */
const CONTENT_REFRESH_DEBOUNCE_MS = 2_000;
/** Frames the active match must hold still before the scroll stops following it. */
const MATCH_SETTLED_FRAMES = 10;
/** Upper bound on following virtualizer corrections after the first scroll. */
const MATCH_FOLLOW_MAX_FRAMES = 300;

interface ResolvedTranscriptMatch {
  match: ChatTranscriptSearchMatch;
  occurrence: number;
}

/**
 * Main groups counts per (row, rendered owner) in transcript order, and the
 * renderer resolves an occurrence across the DOM pieces of each rendered owner,
 * which holds the owner's own text plus every tool result folded into it.
 * Offsets therefore accumulate per owner across groups; restarting at zero per
 * group re-highlights the owner's first hit and leaves later ones unreachable.
 */
function resolveMatchAtIndex(
  matches: readonly ChatTranscriptSearchMatch[],
  index: number,
): ResolvedTranscriptMatch | null {
  const offsets = new Map<string, number>();
  let remaining = index;
  for (const match of matches) {
    const owner = match.renderMessageId ?? match.messageId;
    const base = offsets.get(owner) ?? 0;
    if (remaining < match.count) return { match, occurrence: base + remaining };
    remaining -= match.count;
    offsets.set(owner, base + match.count);
  }
  return null;
}

/** Global index of a previously selected occurrence in a fresh result, or -1. */
function indexOfSelection(
  matches: readonly ChatTranscriptSearchMatch[],
  selection: Pick<
    TranscriptSearchSelection,
    'messageId' | 'renderMessageId' | 'occurrence'
  >,
): number {
  const offsets = new Map<string, number>();
  let start = 0;
  for (const match of matches) {
    const owner = match.renderMessageId ?? match.messageId;
    const base = offsets.get(owner) ?? 0;
    if (
      match.messageId === selection.messageId &&
      match.renderMessageId === selection.renderMessageId &&
      selection.occurrence >= base &&
      selection.occurrence < base + match.count
    )
      return start + (selection.occurrence - base);
    start += match.count;
    offsets.set(owner, base + match.count);
  }
  return -1;
}

interface TranscriptSearchState {
  query: string;
  setQuery: (query: string) => void;
  currentIndex: number;
  totalCount: number;
  selection: TranscriptSearchSelection | null;
  error: string | null;
  close: () => void;
  goToNext: () => void;
  goToPrevious: () => void;
  refresh: () => void;
}

export type TranscriptSearchPageTab = Pick<
  PersistedChatTab,
  'messages' | 'transcriptWindow'
>;

export interface TranscriptSearchPageSource {
  currentTab: () => TranscriptSearchPageTab | null | undefined;
  loadPage: (older: boolean, turnId?: string) => Promise<void>;
}

export function useTranscriptSearch(
  target: { projectId: string; worktreeId: string; chatId: string } | null,
  revision: number | undefined,
  container: RefObject<HTMLDivElement | null>,
  pageSource?: TranscriptSearchPageSource,
): TranscriptSearchState {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<ChatTranscriptSearchResult>({
    matches: [],
    totalCount: 0,
  });
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [selection, setSelection] = useState<TranscriptSearchSelection | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const highlighted = useRef<ReturnType<typeof createDomSearchExecutor> | null>(
    null,
  );
  const generation = useRef(0);
  const navigation = useRef(0);
  const loading = useRef(Promise.resolve());
  const selectionRef = useRef<TranscriptSearchSelection | null>(null);
  const lastScanKey = useRef<string | null>(null);
  const projectId = target?.projectId;
  const worktreeId = target?.worktreeId;
  const chatId = target?.chatId;
  // Streaming deltas advance `transcriptRevision` every debounce window; only
  // committed rows change what a canonical scan can find. Fall back to the
  // revision when the tab exposes no descriptor.
  const committedKey = useChatTabRenderState(
    projectId && worktreeId && chatId
      ? { projectId, worktreeId, chatId }
      : null,
    ({ tab }) => {
      if (!projectId || !worktreeId || !chatId) return undefined;
      const descriptor = tab?.transcript;
      return descriptor
        ? `committed:${descriptor.committedMessageCount}:${descriptor.committedByteLength}:${descriptor.committedDigest ?? ''}`
        : undefined;
    },
  );
  const contentKey =
    committedKey ?? (revision === undefined ? '' : `revision:${revision}`);
  const clearHighlights = useCallback((): void => {
    highlighted.current?.clearHighlights();
    highlighted.current = null;
  }, []);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    setQuery('');
    setSelection(null);
    setResult(EMPTY_RESULT);
    setCurrentIndex(-1);
    navigation.current++;
    clearHighlights();
  }, [projectId, worktreeId, chatId, clearHighlights]);

  useEffect(() => {
    const scanKey = JSON.stringify([
      projectId,
      worktreeId,
      chatId,
      query,
      refreshKey,
    ]);
    // Same chat and query, new committed content: rescan in place. The current
    // selection, its highlight, and any in-flight page load stay put until the
    // fresh counts arrive.
    const refresh = lastScanKey.current === scanKey;
    lastScanKey.current = scanKey;
    const request = ++generation.current;
    if (!refresh) {
      navigation.current++;
      setSelection(null);
      setResult(EMPTY_RESULT);
      setCurrentIndex(-1);
      setError(null);
      clearHighlights();
    }
    if (!projectId || !worktreeId || !chatId || query.length < 2) return;
    if (query.length > 256) {
      if (!refresh) setError('Search is limited to 256 characters.');
      return;
    }
    const requestId = crypto.randomUUID();
    let started = false;
    const timer = setTimeout(
      () => {
        started = true;
        void chatBackendFor({ projectId })
          .chat.searchTranscript({
            projectId,
            worktreeId,
            chatId,
            query,
            requestId,
          })
          .then((found) => {
            if (generation.current !== request) return;
            const previous = selectionRef.current;
            const preserved =
              refresh && previous
                ? indexOfSelection(found.matches, previous)
                : -1;
            setResult(found);
            setCurrentIndex((index) => {
              if (!found.totalCount) return -1;
              if (!refresh) return 0;
              if (preserved >= 0) return preserved;
              return Math.min(Math.max(index, 0), found.totalCount - 1);
            });
          })
          .catch(() => {
            if (generation.current === request)
              setError("Couldn't search messages. Try again.");
          });
      },
      refresh ? CONTENT_REFRESH_DEBOUNCE_MS : QUERY_DEBOUNCE_MS,
    );
    return (): void => {
      generation.current++;
      clearTimeout(timer);
      if (started)
        void chatBackendFor({ projectId })
          .chat.cancelTranscriptSearch(requestId)
          .catch(() => undefined);
    };
  }, [
    projectId,
    worktreeId,
    chatId,
    query,
    contentKey,
    refreshKey,
    clearHighlights,
  ]);

  useEffect(() => {
    if (currentIndex < 0 || !projectId || !worktreeId || !chatId) return;
    const resolved = resolveMatchAtIndex(result.matches, currentIndex);
    if (!resolved) return;
    const { match, occurrence } = resolved;
    const request = ++navigation.current;
    const scope = { projectId, worktreeId, chatId };
    const currentTab =
      pageSource?.currentTab ??
      ((): TranscriptSearchPageTab | undefined =>
        useChatStore
          .getState()
          .worktreeChats[
            `${projectId}/${worktreeId}`
          ]?.tabs.find((tab) => tab.id === chatId));
    setError(null);
    loading.current = loading.current
      .catch(() => undefined)
      .then(async () => {
        // Load only the selected turn's missing pages. Other turns retain their
        // summaries and remain collapsed; the matcher never hydrates the store.
        while (request === navigation.current) {
          const tab = currentTab();
          if (!tab) return;
          if (
            tab.messages.some((row) => row.id === match.messageId) &&
            (!match.renderMessageId ||
              tab.messages.some((row) => row.id === match.renderMessageId))
          )
            break;
          const turn = tab.transcriptWindow?.turns?.find(
            (item) => item.id === match.turnId,
          );
          const cursor = turn ? turn.before : tab.transcriptWindow?.before;
          if (cursor === undefined)
            throw new Error('Search result is no longer available');
          if (pageSource) await pageSource.loadPage(true, turn?.id);
          else await loadChatTranscriptPage(scope, true, turn?.id);
          if (currentTab() === tab)
            throw new Error('Transcript page did not advance');
        }
        if (request === navigation.current)
          setSelection({ ...match, occurrence, query, generation: request });
      })
      .catch(() => {
        if (request === navigation.current)
          setError("Couldn't load this match. Try again.");
      });
    return (): void => {
      navigation.current++;
    };
  }, [currentIndex, result, projectId, worktreeId, chatId, query, pageSource]);

  useEffect(() => {
    if (!selection) return;
    let frame = 0;
    let remaining = 120;
    let executor: ReturnType<typeof createDomSearchExecutor> | undefined;
    let highlightedMessage: HTMLElement | undefined;
    let highlightedOccurrence = selection.occurrence;
    // The virtualized transcript keeps correcting estimated row heights after
    // the first scroll, which can carry a freshly loaded match off screen.
    // Follow it until its position settles, unless the user takes over.
    let followFrames = 0;
    let settledFrames = 0;
    let lastTop: number | undefined;
    let userScrolled = false;
    const scrollRoot = container.current;
    const stopFollowing = (): void => {
      userScrolled = true;
    };
    const userScrollEvents = [
      'wheel',
      'pointerdown',
      'touchstart',
      'keydown',
    ] as const;
    for (const type of userScrollEvents) {
      scrollRoot?.addEventListener(type, stopFollowing, { passive: true });
    }
    const highlight = (): void => {
      const root = container.current;
      const messages = root
        ? Array.from(
            root.querySelectorAll<HTMLElement>('[data-chat-message-id]'),
          ).filter(
            (element) =>
              element.dataset.chatMessageId ===
              (selection.renderMessageId ?? selection.messageId),
          )
        : [];
      if (!highlightedMessage || !messages.includes(highlightedMessage)) {
        executor?.clearHighlights();
        highlightedMessage = undefined;
        // A source message may render as several step/text pieces. Search
        // occurrences are source-relative, so carry the offset across every
        // piece rather than stopping at the first row with the source id.
        let occurrence = selection.occurrence;
        for (const message of messages) {
          executor = createDomSearchExecutor(
            () => message,
            () => root,
          );
          const count = executor.findMatches(selection.query);
          if (count > occurrence) {
            executor.setActiveMatch(occurrence);
            highlightedOccurrence = occurrence;
            highlightedMessage = message;
            highlighted.current = executor;
            break;
          }
          occurrence -= count;
          executor.clearHighlights();
        }
      }
      const message = highlightedMessage;
      if (message && executor) {
        if (userScrolled) return;
        executor.scrollToMatch(highlightedOccurrence);
        const top = message.getBoundingClientRect().top;
        settledFrames =
          lastTop !== undefined && Math.abs(top - lastTop) < 1
            ? settledFrames + 1
            : 0;
        lastTop = top;
        followFrames += 1;
        if (
          settledFrames < MATCH_SETTLED_FRAMES &&
          followFrames < MATCH_FOLLOW_MAX_FRAMES
        ) {
          frame = requestAnimationFrame(highlight);
        }
        return;
      }
      if (--remaining > 0) frame = requestAnimationFrame(highlight);
    };
    frame = requestAnimationFrame(highlight);
    return (): void => {
      cancelAnimationFrame(frame);
      for (const type of userScrollEvents) {
        scrollRoot?.removeEventListener(type, stopFollowing);
      }
      executor?.clearHighlights();
    };
  }, [selection, container]);

  const close = useCallback((): void => {
    generation.current++;
    navigation.current++;
    setQuery('');
    setSelection(null);
    setResult(EMPTY_RESULT);
    setCurrentIndex(-1);
    clearHighlights();
  }, [clearHighlights]);
  return {
    query,
    setQuery,
    currentIndex,
    totalCount: result.totalCount,
    selection,
    error,
    close,
    goToNext: (): void =>
      setCurrentIndex((index) =>
        result.totalCount ? (index + 1) % result.totalCount : -1,
      ),
    goToPrevious: (): void =>
      setCurrentIndex((index) =>
        result.totalCount
          ? (index - 1 + result.totalCount) % result.totalCount
          : -1,
      ),
    refresh: (): void => setRefreshKey((key) => key + 1),
  };
}
