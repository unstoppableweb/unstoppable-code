import { useCallback, useRef, useState } from 'react';

/**
 * Manages search state for AnsiOutput-based search.
 *
 * AnsiOutput handles highlighting internally via its searchQuery/activeMatchIndex
 * props and reports match count via onMatchCountChange. This hook manages
 * the query, current index, and total count, providing props for both
 * FindBar and AnsiOutput.
 */

interface AnsiSearchResult {
  /** Current search query. */
  query: string;
  /** Update the search query. */
  setQuery: (q: string) => void;
  /** 0-based index of the active match. */
  currentIndex: number;
  /** Total number of matches found. */
  totalCount: number;
  /** Navigate to the next match. */
  goToNext: () => void;
  /** Navigate to the previous match. */
  goToPrevious: () => void;
  /** Clear search state. */
  close: () => void;

  // ---- Props to forward to AnsiOutput ----
  /** Pass to AnsiOutput searchQuery prop. */
  ansiSearchQuery: string;
  /** Pass to AnsiOutput activeMatchIndex prop. */
  ansiActiveMatchIndex: number;
  /** Pass to AnsiOutput onMatchCountChange prop. */
  ansiOnMatchCountChange: (count: number) => void;
}

export function useAnsiSearch(): AnsiSearchResult {
  const [query, setQueryRaw] = useState('');
  const [totalCount, setTotalCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const totalCountRef = useRef(0);

  const setQuery = useCallback((q: string): void => {
    setQueryRaw(q);
    // Reset index when query changes; the match count will be
    // reported by AnsiOutput's onMatchCountChange callback.
    setCurrentIndex(q.length >= 2 ? 0 : -1);
    if (q.length < 2) {
      setTotalCount(0);
      totalCountRef.current = 0;
    }
  }, []);

  const ansiOnMatchCountChange = useCallback((count: number): void => {
    totalCountRef.current = count;
    setTotalCount(count);
    // Clamp current index if count decreased
    setCurrentIndex((prev) => {
      if (count === 0) return -1;
      if (prev < 0) return 0;
      return prev >= count ? count - 1 : prev;
    });
  }, []);

  const goToNext = useCallback((): void => {
    const count = totalCountRef.current;
    if (count === 0) return;
    setCurrentIndex((prev) => (prev + 1) % count);
  }, []);

  const goToPrevious = useCallback((): void => {
    const count = totalCountRef.current;
    if (count === 0) return;
    setCurrentIndex((prev) => (prev - 1 + count) % count);
  }, []);

  const close = useCallback((): void => {
    setQueryRaw('');
    setTotalCount(0);
    setCurrentIndex(-1);
    totalCountRef.current = 0;
  }, []);

  return {
    query,
    setQuery,
    currentIndex,
    totalCount,
    goToNext,
    goToPrevious,
    close,
    ansiSearchQuery: query,
    ansiActiveMatchIndex: currentIndex,
    ansiOnMatchCountChange,
  };
}
