export const MAX_MATH_EXPRESSIONS_PER_DOCUMENT = 1_000;
export const MAX_MATH_EXPRESSION_LENGTH = 20_000;

export interface MarkdownMathExpression {
  readonly source: string;
  readonly display: boolean;
}

export interface PreparedMarkdownMath {
  readonly markdown: string;
  readonly expressions: ReadonlyMap<string, MarkdownMathExpression>;
  readonly originalSources: ReadonlyMap<string, string>;
  readonly hasMath: boolean;
}

const MATH_FENCE_LANGUAGES = new Set(['latex', 'math', 'tex']);
const INLINE_MATH_PREFIX = '\uE000canopy-math-';
const INLINE_MATH_SUFFIX = '\uE001';

function mightContainMath(markdown: string, singleDollar: boolean): boolean {
  if (
    markdown.includes('\\(') ||
    markdown.includes('\\[') ||
    markdown.includes(singleDollar ? '$' : '$$')
  ) {
    return true;
  }

  let lineStart = 0;
  while (lineStart < markdown.length) {
    const fence = openingFenceAt(markdown, lineStart);
    if (fence && MATH_FENCE_LANGUAGES.has(fence.language)) return true;
    const currentLineEnd = lineEnd(markdown, lineStart);
    if (currentLineEnd === markdown.length) break;
    lineStart = currentLineEnd + 1;
  }
  return false;
}

function precedingBackslashes(markdown: string, index: number): number {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (markdown[cursor] !== '\\') break;
    count += 1;
  }
  return count;
}

function isEscaped(markdown: string, index: number): boolean {
  return precedingBackslashes(markdown, index) % 2 === 1;
}

function lineEnd(markdown: string, index: number): number {
  const newline = markdown.indexOf('\n', index);
  return newline === -1 ? markdown.length : newline;
}

function isLineStart(markdown: string, index: number): boolean {
  return index === 0 || markdown[index - 1] === '\n';
}

function blockquoteContentStart(markdown: string, index: number): number {
  let cursor = index;
  while (cursor < markdown.length) {
    const prefixStart = cursor;
    let indentation = 0;
    while (markdown[cursor] === ' ' && indentation < 4) {
      cursor += 1;
      indentation += 1;
    }
    if (indentation > 3 || markdown[cursor] !== '>') {
      cursor = prefixStart;
      break;
    }
    cursor += 1;
    if (markdown[cursor] === ' ' || markdown[cursor] === '\t') cursor += 1;
  }
  return cursor;
}

function leadingIndentColumns(value: string, start = 0): number {
  let columns = 0;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (character === ' ') {
      columns += 1;
    } else if (character === '\t') {
      columns += 4 - (columns % 4);
    } else {
      break;
    }
  }
  return columns;
}

function markdownColumns(value: string): number {
  let columns = 0;
  for (const character of value) {
    columns += character === '\t' ? 4 - (columns % 4) : 1;
  }
  return columns;
}

interface ListIndent {
  readonly marker: number;
  readonly content: number;
}

function listIndent(line: string): ListIndent | null {
  const listMarker = /^([ \t]*)(?:[-+*]|\d+[.)])([ \t]{1,4})/.exec(line);
  if (!listMarker) return null;
  return {
    marker: markdownColumns(listMarker[1] ?? ''),
    content: markdownColumns(listMarker[0]),
  };
}

function buildPrecedingListContentIndents(
  markdown: string,
): ReadonlyMap<number, number> {
  const indents = new Map<number, number>();
  const activeIndents: number[] = [];
  let start = 0;

  while (start < markdown.length) {
    const end = lineEnd(markdown, start);
    const contentStart = blockquoteContentStart(markdown, start);
    const line = markdown.slice(contentStart, end);
    if (line.trim().length > 0) {
      const indentation = leadingIndentColumns(line);
      while (
        activeIndents.length > 0 &&
        indentation < (activeIndents[activeIndents.length - 1] ?? 0)
      ) {
        activeIndents.pop();
      }

      const precedingIndent = activeIndents[activeIndents.length - 1];
      if (precedingIndent !== undefined) indents.set(start, precedingIndent);

      const currentListIndent = listIndent(line);
      if (
        currentListIndent &&
        (currentListIndent.marker <= 3 ||
          (precedingIndent !== undefined &&
            currentListIndent.marker >= precedingIndent &&
            currentListIndent.marker < precedingIndent + 4))
      ) {
        activeIndents.push(currentListIndent.content);
      }
    } else {
      const precedingIndent = activeIndents[activeIndents.length - 1];
      if (precedingIndent !== undefined) indents.set(start, precedingIndent);
    }

    if (end === markdown.length) break;
    start = end + 1;
  }

  return indents;
}

function indentedCodeLineEnd(
  markdown: string,
  index: number,
  precedingListContentIndents: ReadonlyMap<number, number>,
): number | null {
  if (!isLineStart(markdown, index)) return null;
  const contentStart = blockquoteContentStart(markdown, index);
  const indentation = leadingIndentColumns(markdown, contentStart);
  if (indentation < 4) return null;
  const precedingListContentIndent = precedingListContentIndents.get(index);
  if (
    precedingListContentIndent !== undefined &&
    indentation < precedingListContentIndent + 4
  ) {
    return null;
  }
  const end = lineEnd(markdown, index);
  return end < markdown.length ? end + 1 : end;
}

function referenceDefinitionLineEnd(
  markdown: string,
  index: number,
): number | null {
  if (!isLineStart(markdown, index)) return null;
  const end = lineEnd(markdown, index);
  const line = markdown.slice(index, end);
  const definition = /^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*(.*)$/.exec(line);
  if (!definition) return null;

  let definitionEnd = end < markdown.length ? end + 1 : end;
  let hasDestination = (definition[1] ?? '').trim().length > 0;
  let hasTitle = false;

  while (definitionEnd < markdown.length) {
    const continuationEnd = lineEnd(markdown, definitionEnd);
    const continuationLine = markdown.slice(definitionEnd, continuationEnd);
    const continuation = /^ {1,3}(\S.*)$/.exec(continuationLine);
    if (!continuation) break;

    const contents = continuation[1] ?? '';
    if (!hasDestination) {
      hasDestination = true;
    } else if (
      !hasTitle &&
      /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^)\\]|\\.)*\))[ \t]*$/.test(
        contents,
      )
    ) {
      hasTitle = true;
    } else {
      break;
    }

    definitionEnd =
      continuationEnd < markdown.length ? continuationEnd + 1 : continuationEnd;
  }

  return definitionEnd;
}

function buildAngleDestinationEnds(
  markdown: string,
): ReadonlyMap<number, number> {
  const ends = new Map<number, number>();
  let nextClosingAngle = -1;
  let nextNewline = markdown.length;
  let nextWhitespace = markdown.length;

  for (let index = markdown.length - 1; index >= 0; index -= 1) {
    const character = markdown[index];
    if (character === '\n') {
      nextNewline = index;
      nextClosingAngle = -1;
      nextWhitespace = index;
    } else if (character === '>') {
      nextClosingAngle = index;
    } else if (character !== undefined && /\s/.test(character)) {
      nextWhitespace = index;
    } else if (
      character === '<' &&
      nextClosingAngle > index + 1 &&
      nextClosingAngle < nextNewline &&
      nextWhitespace >= nextClosingAngle
    ) {
      ends.set(index, nextClosingAngle + 1);
    }
  }
  return ends;
}

function inlineDestinationEnd(markdown: string, index: number): number | null {
  if (!markdown.startsWith('](', index)) return null;
  let depth = 1;
  let cursor = index + 2;
  while (cursor < markdown.length) {
    if (markdown[cursor] === '\n') return cursor + 1;
    if (markdown[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (markdown[cursor] === '(') {
      depth += 1;
    } else if (markdown[cursor] === ')') {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
    cursor += 1;
  }
  return markdown.length;
}

/**
 * Where each closed image label (`![…]`) ends, keyed by its `!`. One pass
 * matches brackets with a stack: a backslash escapes the next character and
 * a newline drops every open label. Scanning ahead from each `![` instead
 * made a line of unclosed labels quadratic.
 */
function buildImageLabelEnds(markdown: string): ReadonlyMap<number, number> {
  const ends = new Map<number, number>();
  const open: number[] = [];
  let cursor = 0;
  while (cursor < markdown.length) {
    const character = markdown[cursor];
    if (character === '\\') {
      cursor += 2;
      continue;
    }
    if (character === '[') {
      open.push(cursor);
    } else if (character === ']') {
      const start = open.pop();
      if (start !== undefined && start > 0 && markdown[start - 1] === '!') {
        ends.set(start - 1, cursor + 1);
      }
    } else if (character === '\n') {
      open.length = 0;
    }
    cursor += 1;
  }
  return ends;
}

function imageLabelEnd(
  markdown: string,
  index: number,
  imageLabelEnds: ReadonlyMap<number, number>,
): number | null {
  if (!markdown.startsWith('![', index)) return null;
  return imageLabelEnds.get(index) ?? null;
}

function bareAutolinkEnd(markdown: string, index: number): number | null {
  const previous = markdown[index - 1];
  if (index > 0 && previous !== undefined && !/[\s([<{]/.test(previous)) {
    return null;
  }
  const remainder = markdown.slice(index, index + 8).toLowerCase();
  if (
    !remainder.startsWith('http://') &&
    !remainder.startsWith('https://') &&
    !remainder.startsWith('www.')
  ) {
    return null;
  }
  let cursor = index;
  while (cursor < markdown.length && !/[\s<>]/.test(markdown[cursor] ?? '')) {
    cursor += 1;
  }
  return cursor;
}

interface Fence {
  readonly marker: '`' | '~';
  readonly length: number;
  readonly language: string;
  readonly openingLineEnd: number;
  readonly markerColumn: number;
}

function containerContentStart(
  markdown: string,
  index: number,
  allowListMarker: boolean,
): number | null {
  if (!isLineStart(markdown, index)) return null;
  let cursor = index;

  const consumeIndentation = (): boolean => {
    let indentation = 0;
    while (markdown[cursor] === ' ' && indentation < 4) {
      cursor += 1;
      indentation += 1;
    }
    return indentation <= 3;
  };

  while (true) {
    if (!consumeIndentation()) return null;
    if (markdown[cursor] === '>') {
      cursor += 1;
      if (markdown[cursor] === ' ' || markdown[cursor] === '\t') cursor += 1;
      continue;
    }
    if (allowListMarker) {
      const listMarker = /^(?:[-+*]|\d+[.)])[ \t]{1,4}/.exec(
        markdown.slice(cursor),
      );
      if (!listMarker) break;
      cursor += listMarker[0].length;
      continue;
    }
    break;
  }
  return cursor;
}

function openingFenceAt(markdown: string, index: number): Fence | null {
  let cursor = containerContentStart(markdown, index, true);
  if (cursor === null) return null;

  const marker = markdown[cursor];
  if (marker !== '`' && marker !== '~') return null;
  const markerStart = cursor;
  while (markdown[cursor] === marker) cursor += 1;
  const length = cursor - markerStart;
  if (length < 3) return null;

  const openingLineEnd = lineEnd(markdown, cursor);
  const language =
    markdown
      .slice(cursor, openingLineEnd)
      .trim()
      .split(/\s+/, 1)[0]
      ?.toLowerCase() ?? '';
  return {
    marker,
    length,
    language,
    openingLineEnd,
    markerColumn: markdownColumns(markdown.slice(index, markerStart)),
  };
}

function closingFenceEnd(
  markdown: string,
  contentStart: number,
  fence: Fence,
): number {
  let cursor = contentStart;
  while (cursor < markdown.length) {
    const currentLineEnd = lineEnd(markdown, cursor);
    const containerMarkerStart = containerContentStart(markdown, cursor, false);
    const indentationEnd = ((): number | null => {
      let end = blockquoteContentStart(markdown, cursor);
      while (markdown[end] === ' ' || markdown[end] === '\t') end += 1;
      return markdownColumns(markdown.slice(cursor, end)) <= fence.markerColumn
        ? end
        : null;
    })();
    const markerStart = containerMarkerStart ?? indentationEnd;
    if (markerStart === null) {
      cursor =
        currentLineEnd < markdown.length ? currentLineEnd + 1 : markdown.length;
      continue;
    }
    let markerEnd = markerStart;
    while (markdown[markerEnd] === fence.marker) markerEnd += 1;
    if (
      markerEnd - markerStart >= fence.length &&
      markdown.slice(markerEnd, currentLineEnd).trim().length === 0
    ) {
      return currentLineEnd < markdown.length
        ? currentLineEnd + 1
        : currentLineEnd;
    }
    cursor =
      currentLineEnd < markdown.length ? currentLineEnd + 1 : markdown.length;
  }
  return markdown.length;
}

function inlineCodeEnd(
  markdown: string,
  index: number,
  unavailableRuns: Set<number>,
): number | null {
  let openingEnd = index;
  while (markdown[openingEnd] === '`') openingEnd += 1;
  const runLength = openingEnd - index;
  if (runLength > 32) return openingEnd;
  if (unavailableRuns.has(runLength)) return null;

  let cursor = openingEnd;
  while (cursor < markdown.length) {
    const candidate = markdown.indexOf('`', cursor);
    if (candidate === -1) {
      unavailableRuns.add(runLength);
      return null;
    }
    let candidateEnd = candidate;
    while (markdown[candidateEnd] === '`') candidateEnd += 1;
    if (candidateEnd - candidate === runLength) return candidateEnd;
    cursor = candidateEnd;
  }
  unavailableRuns.add(runLength);
  return null;
}

interface DelimiterSearchResult {
  readonly closingIndex: number;
  readonly nextOpeningIndex: number;
}

function findClosingDelimiter(
  markdown: string,
  delimiter: Delimiter,
  from: number,
  unavailableBacktickRuns: Set<number>,
  precedingListContentIndents: ReadonlyMap<number, number>,
  angleDestinationEnds: ReadonlyMap<number, number>,
  until = markdown.length,
): DelimiterSearchResult {
  let cursor = from;
  while (cursor < until) {
    const referenceDefinitionEnd = referenceDefinitionLineEnd(markdown, cursor);
    const indentedLineEnd = indentedCodeLineEnd(
      markdown,
      cursor,
      precedingListContentIndents,
    );
    const fence = openingFenceAt(markdown, cursor);
    const destinationEnd =
      inlineDestinationEnd(markdown, cursor) ??
      angleDestinationEnds.get(cursor) ??
      bareAutolinkEnd(markdown, cursor);
    if (referenceDefinitionEnd !== null) {
      cursor = referenceDefinitionEnd;
      continue;
    }
    if (indentedLineEnd !== null) {
      cursor = indentedLineEnd;
      continue;
    }
    if (fence) {
      const contentStart =
        fence.openingLineEnd < markdown.length
          ? fence.openingLineEnd + 1
          : markdown.length;
      cursor = closingFenceEnd(markdown, contentStart, fence);
      continue;
    }
    if (destinationEnd !== null) {
      cursor = destinationEnd;
      continue;
    }
    if (markdown[cursor] === '`') {
      const codeEnd = inlineCodeEnd(markdown, cursor, unavailableBacktickRuns);
      cursor = codeEnd ?? cursor + 1;
      continue;
    }
    if (
      markdown.startsWith(delimiter.closing, cursor) &&
      !isEscaped(markdown, cursor) &&
      (delimiter.isClosingValid === undefined ||
        delimiter.isClosingValid(markdown, cursor))
    ) {
      return { closingIndex: cursor, nextOpeningIndex: -1 };
    }
    if (
      delimiter.isOpeningValid !== undefined &&
      markdown.startsWith(delimiter.opening, cursor) &&
      !isEscaped(markdown, cursor) &&
      delimiter.isOpeningValid(markdown, cursor)
    ) {
      // If this delimiter can open but not close, let the later opening take
      // precedence (for example, a price before a separate inline formula).
      return { closingIndex: -1, nextOpeningIndex: cursor };
    }
    cursor += 1;
  }
  return { closingIndex: -1, nextOpeningIndex: -1 };
}

function inlineMathBoundary(markdown: string, from: number): number {
  let cursor = from;
  while (cursor < markdown.length) {
    const newline = markdown.indexOf('\n', cursor);
    if (newline === -1) return markdown.length;
    const nextLineEnd = lineEnd(markdown, newline + 1);
    const nextLine = markdown.slice(newline + 1, nextLineEnd);
    if (
      nextLine.trim().length === 0 ||
      /^(?: {0,3})(?:#{1,6}(?:[ \t]|$)|>|[-+*][ \t]+|\d+[.)][ \t]+|`{3,}|~{3,})/.test(
        nextLine,
      ) ||
      /^(?: {0,3})(?:(?:=+|-+)[ \t]*|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(
        nextLine,
      )
    ) {
      return newline;
    }
    cursor = newline + 1;
  }
  return markdown.length;
}

function expressionHash(source: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function expressionToken(source: string, index: number): string {
  return `${INLINE_MATH_PREFIX}${index}-${expressionHash(source)}${INLINE_MATH_SUFFIX}`;
}

interface Delimiter {
  readonly opening: string;
  readonly closing: string;
  readonly display: boolean;
  readonly inline: boolean;
  readonly isOpeningValid?: (markdown: string, index: number) => boolean;
  readonly isClosingValid?: (markdown: string, index: number) => boolean;
}

function isSingleDollarOpeningValid(markdown: string, index: number): boolean {
  const next = markdown[index + 1];
  return (
    next !== undefined &&
    next !== '$' &&
    markdown[index - 1] !== '$' &&
    !/\s/.test(next)
  );
}

function isSingleDollarClosingValid(markdown: string, index: number): boolean {
  const previous = markdown[index - 1];
  const next = markdown[index + 1];
  return (
    previous !== undefined &&
    previous !== '$' &&
    next !== '$' &&
    !/\s/.test(previous) &&
    (next === undefined || !/[0-9]/.test(next))
  );
}

const SHARED_DELIMITERS: readonly Delimiter[] = [
  { opening: '\\(', closing: '\\)', display: false, inline: true },
  { opening: '\\[', closing: '\\]', display: true, inline: false },
  { opening: '$$', closing: '$$', display: true, inline: false },
];

const DELIMITERS: readonly Delimiter[] = [
  ...SHARED_DELIMITERS,
  {
    opening: '$',
    closing: '$',
    display: false,
    inline: true,
    isOpeningValid: isSingleDollarOpeningValid,
    isClosingValid: isSingleDollarClosingValid,
  },
];

/**
 * Protect TeX delimiters from CommonMark escape handling by replacing them
 * with opaque inline-code AST nodes. Fenced code and inline code are skipped,
 * and fenced `math`, `tex`, or `latex` blocks remain intact for renderRule.
 *
 * The scanner is bounded and linear in document size for each fixed delimiter
 * kind. Oversized or excessive expressions stay as readable source.
 */
export function prepareMarkdownMath(
  markdown: string,
  options: { readonly singleDollar?: boolean } = {},
): PreparedMarkdownMath {
  const singleDollar = options.singleDollar !== false;
  const delimiters = singleDollar ? DELIMITERS : SHARED_DELIMITERS;
  if (!mightContainMath(markdown, singleDollar)) {
    return {
      markdown,
      expressions: new Map(),
      originalSources: new Map(),
      hasMath: false,
    };
  }

  const expressions = new Map<string, MarkdownMathExpression>();
  const originalSources = new Map<string, string>();
  const unavailableDelimiters = new Set<string>();
  const blockedDelimitersUntil = new Map<string, number>();
  const unavailableBacktickRuns = new Set<number>();
  const precedingListContentIndents =
    buildPrecedingListContentIndents(markdown);
  const angleDestinationEnds = buildAngleDestinationEnds(markdown);
  const imageLabelEnds = buildImageLabelEnds(markdown);
  const output: string[] = [];
  let copyFrom = 0;
  let index = 0;
  let hasMath = false;
  // Every start inside [boundaryFrom, boundary] ends at the same paragraph
  // boundary, so repeated `$` retries in one paragraph stay linear.
  let boundaryFrom = -1;
  let boundary = -1;
  const inlineBoundary = (from: number): number => {
    if (from < boundaryFrom || from > boundary) {
      boundaryFrom = from;
      boundary = inlineMathBoundary(markdown, from);
    }
    return boundary;
  };

  while (index < markdown.length) {
    const referenceDefinitionEnd = referenceDefinitionLineEnd(markdown, index);
    if (referenceDefinitionEnd !== null) {
      index = referenceDefinitionEnd;
      continue;
    }

    const indentedLineEnd = indentedCodeLineEnd(
      markdown,
      index,
      precedingListContentIndents,
    );
    if (indentedLineEnd !== null) {
      index = indentedLineEnd;
      continue;
    }

    const fence = openingFenceAt(markdown, index);
    if (fence) {
      if (MATH_FENCE_LANGUAGES.has(fence.language)) hasMath = true;
      const contentStart =
        fence.openingLineEnd < markdown.length
          ? fence.openingLineEnd + 1
          : markdown.length;
      index = closingFenceEnd(markdown, contentStart, fence);
      continue;
    }

    const destinationEnd =
      imageLabelEnd(markdown, index, imageLabelEnds) ??
      inlineDestinationEnd(markdown, index) ??
      angleDestinationEnds.get(index) ??
      bareAutolinkEnd(markdown, index);
    if (destinationEnd !== null) {
      index = destinationEnd;
      continue;
    }

    if (markdown[index] === '`') {
      const codeEnd = inlineCodeEnd(markdown, index, unavailableBacktickRuns);
      index = codeEnd ?? index + 1;
      continue;
    }

    let matched = false;
    for (const delimiter of delimiters) {
      if (
        unavailableDelimiters.has(delimiter.opening) ||
        index < (blockedDelimitersUntil.get(delimiter.opening) ?? 0) ||
        !markdown.startsWith(delimiter.opening, index) ||
        isEscaped(markdown, index) ||
        (delimiter.isOpeningValid !== undefined &&
          !delimiter.isOpeningValid(markdown, index))
      ) {
        continue;
      }

      const sourceStart = index + delimiter.opening.length;
      const closingBoundary = delimiter.inline
        ? inlineBoundary(sourceStart)
        : markdown.length;
      const searchResult = findClosingDelimiter(
        markdown,
        delimiter,
        sourceStart,
        unavailableBacktickRuns,
        precedingListContentIndents,
        angleDestinationEnds,
        closingBoundary,
      );
      const closingIndex = searchResult.closingIndex;
      if (closingIndex === -1) {
        if (searchResult.nextOpeningIndex !== -1) {
          blockedDelimitersUntil.set(
            delimiter.opening,
            searchResult.nextOpeningIndex,
          );
          continue;
        }
        if (delimiter.inline) {
          blockedDelimitersUntil.set(delimiter.opening, closingBoundary);
        } else {
          unavailableDelimiters.add(delimiter.opening);
        }
        continue;
      }

      const expressionSource = markdown.slice(sourceStart, closingIndex);
      if (expressionSource.length > MAX_MATH_EXPRESSION_LENGTH) {
        blockedDelimitersUntil.set(
          delimiter.opening,
          closingIndex + delimiter.closing.length,
        );
        continue;
      }
      if (
        expressionSource.trim().length === 0 ||
        expressions.size >= MAX_MATH_EXPRESSIONS_PER_DOCUMENT
      ) {
        index = closingIndex + delimiter.closing.length;
        matched = true;
        break;
      }

      const token = expressionToken(expressionSource, expressions.size);
      output.push(markdown.slice(copyFrom, index), `\`${token}\``);
      expressions.set(token, {
        source: expressionSource,
        display: delimiter.display,
      });
      originalSources.set(
        token,
        markdown.slice(index, closingIndex + delimiter.closing.length),
      );
      index = closingIndex + delimiter.closing.length;
      copyFrom = index;
      hasMath = true;
      matched = true;
      break;
    }
    if (!matched) index += 1;
  }

  if (expressions.size === 0) {
    return { markdown, expressions, originalSources, hasMath };
  }
  output.push(markdown.slice(copyFrom));
  return {
    markdown: output.join(''),
    expressions,
    originalSources,
    hasMath,
  };
}

export function restoreMarkdownMathSource(
  value: string,
  originalSources: ReadonlyMap<string, string>,
): string {
  if (!value.includes(INLINE_MATH_PREFIX)) return value;

  const output: string[] = [];
  let copyFrom = 0;
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const tokenStart = value.indexOf(INLINE_MATH_PREFIX, searchFrom);
    if (tokenStart === -1) break;
    const tokenSuffix = value.indexOf(INLINE_MATH_SUFFIX, tokenStart);
    if (tokenSuffix === -1) break;
    const tokenEnd = tokenSuffix + INLINE_MATH_SUFFIX.length;
    const token = value.slice(tokenStart, tokenEnd);
    const originalSource = originalSources.get(token);
    if (originalSource === undefined) {
      searchFrom = tokenEnd;
      continue;
    }

    const wrappedInBackticks =
      tokenStart > 0 &&
      value[tokenStart - 1] === '`' &&
      value[tokenEnd] === '`';
    const replacementStart = wrappedInBackticks ? tokenStart - 1 : tokenStart;
    const replacementEnd = wrappedInBackticks ? tokenEnd + 1 : tokenEnd;
    output.push(value.slice(copyFrom, replacementStart), originalSource);
    copyFrom = replacementEnd;
    searchFrom = replacementEnd;
  }

  if (copyFrom === 0) return value;
  output.push(value.slice(copyFrom));
  return output.join('');
}
