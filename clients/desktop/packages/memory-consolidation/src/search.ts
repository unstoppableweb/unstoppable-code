import { normalizeMemoryText } from './text';

/*
 * How SearchMemory matches one memory file and what ReadMemory returns of
 * one, shared by the desktop store and Canopy Cloud so an agent sees the
 * same hits, headings, snippets and read budget on either (CAN-6314).
 */

/** The longest snippet a search hit carries. */
export const MEMORY_SEARCH_SNIPPET_MAX_CHARS = 400;
/** The most hits one search returns, live and archived together. */
export const MEMORY_SEARCH_MAX_HITS = 50;
/** The most archived notes or imports one search returns. */
export const MEMORY_SEARCH_MAX_ARCHIVED_HITS = 10;
/** The most a read returns of one file, notice included. */
export const MEMORY_READ_MAX_BYTES = 24 * 1024;
const MEMORY_READ_TRUNCATION_NOTICE =
  '\n\n[Memory content truncated at 24 KiB.]';

/** A search query, normalized, and its distinct word tokens. */
export interface MemorySearchTerms {
  readonly normalizedQuery: string;
  readonly tokens: readonly string[];
}

/** One file a search matched: its best heading and a snippet around the match. */
export interface MemorySearchFileHit {
  readonly fileKey: string;
  readonly heading?: string;
  readonly snippet: string;
}

/** The terms of a query, or null when it normalizes to nothing. */
export function memorySearchTerms(query: string): MemorySearchTerms | null {
  const normalizedQuery = normalizeMemoryText(query).toLowerCase();
  if (!normalizedQuery) return null;
  const tokens = Array.from(
    new Set(normalizedQuery.match(/[a-z0-9_-]+/g) ?? []),
  ).filter((token) => token.length > 1);
  return { normalizedQuery, tokens };
}

/** A file's lines after a leading front matter block. */
export function memoryContentLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines[0] !== '---') return lines;
  const end = lines.indexOf('---', 1);
  return end >= 0 ? lines.slice(end + 1) : lines;
}

function bestMatchIndex(text: string, terms: MemorySearchTerms): number {
  const normalizedText = text.toLowerCase();
  const phraseIndex = normalizedText.indexOf(terms.normalizedQuery);
  if (phraseIndex >= 0) return phraseIndex;

  let bestToken = '';
  let bestIndex = -1;
  for (const token of terms.tokens) {
    const tokenIndex = normalizedText.indexOf(token);
    if (
      tokenIndex >= 0 &&
      (token.length > bestToken.length ||
        (token.length === bestToken.length &&
          (bestIndex < 0 || tokenIndex < bestIndex)))
    ) {
      bestToken = token;
      bestIndex = tokenIndex;
    }
  }
  return bestIndex;
}

function sliceWholeCodePoints(
  text: string,
  requestedStart: number,
  requestedEnd: number,
): string {
  let start = requestedStart;
  let end = requestedEnd;
  if (
    start > 0 &&
    start < text.length &&
    /[\uDC00-\uDFFF]/.test(text[start] ?? '') &&
    /[\uD800-\uDBFF]/.test(text[start - 1] ?? '')
  ) {
    start += 1;
  }
  if (
    end > 0 &&
    end < text.length &&
    /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') &&
    /[\uDC00-\uDFFF]/.test(text[end] ?? '')
  ) {
    end -= 1;
  }
  return text.slice(start, end);
}

function searchSnippetWindow(text: string, terms: MemorySearchTerms): string {
  if (text.length <= MEMORY_SEARCH_SNIPPET_MAX_CHARS) return text;
  const matchIndex = bestMatchIndex(text, terms);
  if (matchIndex < 0) {
    return sliceWholeCodePoints(text, 0, MEMORY_SEARCH_SNIPPET_MAX_CHARS);
  }
  const halfWindow = Math.floor(MEMORY_SEARCH_SNIPPET_MAX_CHARS / 2);
  let start = Math.max(0, matchIndex - halfWindow);
  const end = Math.min(text.length, start + MEMORY_SEARCH_SNIPPET_MAX_CHARS);
  if (end === text.length) {
    start = Math.max(0, end - MEMORY_SEARCH_SNIPPET_MAX_CHARS);
  }
  return sliceWholeCodePoints(text, start, end);
}

/**
 * The hit for one normalized file, or undefined when neither the phrase nor
 * every token appears in its key or body. The snippet is the first line
 * that matches (else the first non-blank line), windowed around the match,
 * and the heading the last one above it.
 */
export function memorySearchHit(input: {
  readonly fileKey: string;
  readonly content: string;
  readonly terms: MemorySearchTerms;
}): MemorySearchFileHit | undefined {
  const { terms } = input;
  const lines = memoryContentLines(input.content);
  const searchable = `${input.fileKey}\n${lines.join('\n')}`.toLowerCase();
  const matchesPhrase = searchable.includes(terms.normalizedQuery);
  const matchesTokens =
    terms.tokens.length > 0 &&
    terms.tokens.every((token) => searchable.includes(token));
  if (!matchesPhrase && !matchesTokens) return undefined;

  let heading: string | undefined;
  let matchedHeading: string | undefined;
  let snippet = '';
  let fallbackSnippet = '';
  let fallbackHeading: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,6}\s+/.test(trimmed)) {
      heading = trimmed.replace(/^#{1,6}\s+/, '').trim();
    }
    if (!fallbackSnippet && trimmed) {
      fallbackSnippet = trimmed;
      fallbackHeading = heading;
    }
    const normalizedLine = trimmed.toLowerCase();
    if (
      !snippet &&
      trimmed &&
      (normalizedLine.includes(terms.normalizedQuery) ||
        terms.tokens.some((token) => normalizedLine.includes(token)))
    ) {
      snippet = trimmed;
      matchedHeading = heading;
    }
  }
  if (!snippet) {
    snippet = fallbackSnippet;
    matchedHeading = fallbackHeading;
  }
  const hit = {
    fileKey: input.fileKey,
    snippet: searchSnippetWindow(snippet, terms),
  };
  return matchedHeading ? { ...hit, heading: matchedHeading } : hit;
}

/** The snippet of an archived hit, labelled with the date it was saved. */
export function archivedMemorySnippet(
  snippet: string,
  savedAt: string | undefined,
): string {
  return `[Archived; saved ${savedAt ?? 'date unknown'}] ${snippet}`;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The longest UTF-8 prefix of `text` within `maxBytes`, whole characters only. */
function clipUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const encoded = encoder.encode(text);
  if (encoded.byteLength <= maxBytes) return text;
  let end = maxBytes;
  // Back off continuation bytes so the cut never splits a character.
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return decoder.decode(encoded.subarray(0, end));
}

/** A file as a read returns it: whole, or cut at 24 KiB with a notice. */
export function clipMemoryReadContent(content: string): string {
  if (encoder.encode(content).byteLength <= MEMORY_READ_MAX_BYTES) {
    return content;
  }
  const contentBudget =
    MEMORY_READ_MAX_BYTES -
    encoder.encode(MEMORY_READ_TRUNCATION_NOTICE).byteLength;
  return `${clipUtf8(content, contentBudget)}${MEMORY_READ_TRUNCATION_NOTICE}`;
}
