/** DOM search shared by rendered previews and desktop content search. */
export interface SearchExecutor {
  findMatches: (query: string) => number;
  clearHighlights: () => void;
  setActiveMatch: (index: number) => void;
  scrollToMatch: (index: number) => void;
}

export interface DomSearchOptions {
  matches?: string;
  active?: string;
  visibleOnly?: boolean;
}

/**
 * Self-contained so the HTML preview can install this same implementation in
 * its opaque frame. Keep runtime dependencies inside the factory.
 */
export function createDomSearchExecutor(
  getContainer: () => HTMLElement | null,
  getScrollContainer?: () => HTMLElement | null,
  options: DomSearchOptions = {},
): SearchExecutor {
  const maxTextParts = 10_000;
  const maxMatches = 1_000;
  const matchesName = options.matches ?? 'search-matches';
  const activeName = options.active ?? 'search-match-active';
  let matchRanges: Range[] = [];
  // Highlights belong to the window that owns the container: a popped-out
  // panel keeps its DOM in its own window, whose registry paints it. The
  // realm is resolved on each scan (the container mounts after construction
  // and can move between windows), and every registry written to is
  // remembered so a clear reaches all of them.
  type HighlightRealm = Pick<typeof globalThis, 'Highlight' | 'CSS'> & {
    closed?: boolean;
  };
  let realm: HighlightRealm = globalThis;
  const writtenRealms = new Set<HighlightRealm>();

  function adoptRealm(doc: Document): void {
    realm = doc.defaultView ?? globalThis;
  }

  function register(name: string, ranges: Range[]): void {
    const registry = realm.CSS?.highlights;
    if (!registry) return;
    if (realm.Highlight && ranges.length > 0) {
      const highlight = new realm.Highlight();
      ranges.forEach((range) => highlight.add(range));
      registry.set(name, highlight);
      writtenRealms.add(realm);
    } else registry.delete(name);
  }

  function clearHighlights(): void {
    for (const written of writtenRealms) {
      if (written.closed) continue;
      try {
        written.CSS?.highlights?.delete(matchesName);
        written.CSS?.highlights?.delete(activeName);
      } catch {
        // The window went away mid-query; it has nothing left to paint.
      }
    }
    writtenRealms.clear();
    matchRanges = [];
  }

  function findMatches(query: string): number {
    clearHighlights();
    const container = getContainer();
    if (!container || !query) return 0;
    const doc = container.ownerDocument;
    adoptRealm(doc);
    const pattern = new RegExp(
      query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'gi',
    );
    const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const blockTags = new Set([
      'ADDRESS',
      'ARTICLE',
      'ASIDE',
      'BLOCKQUOTE',
      'BODY',
      'DD',
      'DIV',
      'DL',
      'DT',
      'FIGCAPTION',
      'FIGURE',
      'FOOTER',
      'FORM',
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'HEADER',
      'HR',
      'LI',
      'MAIN',
      'NAV',
      'OL',
      'P',
      'PRE',
      'SECTION',
      'TABLE',
      'TBODY',
      'TD',
      'TFOOT',
      'TH',
      'THEAD',
      'TR',
      'UL',
    ]);
    type TextPart = { node: Node; start: number; end: number };
    type TextRun = { block: Element; text: string; parts: TextPart[] };
    const runs: TextRun[] = [];
    let currentRun: TextRun | null = null;
    let node: Node | null;
    let traversedTextParts = 0;
    while (traversedTextParts < maxTextParts && (node = walker.nextNode())) {
      traversedTextParts += 1;
      const parent = node.parentElement;
      if (parent?.closest('[data-markdown-generated]')) continue;
      if (
        options.visibleOnly &&
        (!parent ||
          parent.closest(
            'script, style, noscript, template, [hidden], [aria-hidden="true"]',
          ) ||
          parent.getClientRects().length === 0)
      )
        continue;
      const text = node.textContent ?? '';
      if (!text) continue;
      let block: Element = container;
      for (
        let element = parent;
        element && element !== container;
        element = element.parentElement
      ) {
        if (blockTags.has(element.tagName)) {
          block = element;
          break;
        }
      }
      if (!currentRun || currentRun.block !== block) {
        currentRun = { block, text: '', parts: [] };
        runs.push(currentRun);
      }
      const start = currentRun.text.length;
      currentRun.text += text;
      currentRun.parts.push({ node, start, end: start + text.length });
    }
    let processedMatches = 0;
    for (const run of runs) {
      pattern.lastIndex = 0;
      let startPartIndex = 0;
      let endPartIndex = 0;
      let match: RegExpExecArray | null;
      while (
        processedMatches < maxMatches &&
        (match = pattern.exec(run.text))
      ) {
        processedMatches += 1;
        const matchIndex = match.index;
        const matchEnd = matchIndex + match[0].length;
        while (
          startPartIndex < run.parts.length &&
          matchIndex >= run.parts[startPartIndex].end
        )
          startPartIndex += 1;
        if (endPartIndex < startPartIndex) endPartIndex = startPartIndex;
        while (
          endPartIndex < run.parts.length &&
          matchEnd > run.parts[endPartIndex].end
        )
          endPartIndex += 1;
        const startPart = run.parts[startPartIndex];
        const endPart = run.parts[endPartIndex];
        if (!startPart || !endPart) continue;
        const range = doc.createRange();
        range.setStart(startPart.node, matchIndex - startPart.start);
        range.setEnd(endPart.node, matchEnd - endPart.start);
        if (!options.visibleOnly || range.getClientRects().length > 0)
          matchRanges.push(range);
      }
      if (processedMatches >= maxMatches) break;
    }
    register(matchesName, matchRanges);
    return matchRanges.length;
  }

  function setActiveMatch(index: number): void {
    const range = matchRanges[index];
    register(activeName, range ? [range] : []);
  }

  function scrollToMatch(index: number): void {
    const range = matchRanges[index];
    const scrollEl = getScrollContainer?.() ?? getContainer();
    if (!range || !scrollEl) return;
    const rect = range.getBoundingClientRect();
    const isDocumentScroller =
      scrollEl === scrollEl.ownerDocument.scrollingElement;
    const bounds = isDocumentScroller
      ? { top: 0, left: 0 }
      : scrollEl.getBoundingClientRect();
    const top = rect.top - bounds.top;
    if (
      top < (options.visibleOnly ? 48 : 0) ||
      rect.bottom - bounds.top > scrollEl.clientHeight
    ) {
      scrollEl.scrollTop += top - scrollEl.clientHeight / 2 + rect.height / 2;
    }
    const left = rect.left - bounds.left;
    if (left < 0 || rect.right - bounds.left > scrollEl.clientWidth) {
      scrollEl.scrollLeft += left - scrollEl.clientWidth / 2 + rect.width / 2;
    }
  }

  return { findMatches, clearHighlights, setActiveMatch, scrollToMatch };
}
