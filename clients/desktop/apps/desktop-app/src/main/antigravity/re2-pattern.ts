/**
 * Whether agy 1.5.1 accepts a schema pattern. Native probes are consistent
 * with Go's `regexp/syntax` (RE2): every non-RE2 construct tried aborted the
 * turn and every RE2 construct tried was accepted (see
 * docs/planning/2026-11-13-antigravity-followups/external-mcp.md). The binary
 * is a Go build (go1.28 RC) linking `regexp/syntax` and Go JSON Schema
 * libraries, but which component compiles tool schemas is inferred, not
 * confirmed. This accepts only syntax the probes and RE2 agree on and treats
 * anything uncertain as unsupported, because the costs are uneven: omitting a
 * pattern loses nothing the host does not still enforce, while one agy
 * rejects aborts the whole turn. One linear pass over the pattern.
 */

/** RE2's repeat-count limit; `{1,1001}` aborts the turn, `{1,1000}` does not. */
const MAX_REPEAT = 1000;
/**
 * Nested counted repeats multiply: `(a{10}){100}` was accepted, while
 * `(a{100}){100}` and `((a{30}){30}){30}` aborted the turn. Products above
 * the largest accepted one are treated as unsupported.
 */
const MAX_REPEAT_PRODUCT = 1000;
const QUANTIFIER_START = new Set('*+?{');
/**
 * RE2 limits parse-tree height to 1000. Each group level can add several
 * nodes, and alternation factoring adds about one per two characters of a
 * prefix adjacent branches share, even without groups (`.`×1000 + `b|` +
 * `.`×1000 + `c` fails). Bounding both keeps the worst case below the limit:
 * factoring adds at most about length/2 ≈ 512 nodes and group levels about
 * 6 × 64 ≈ 384, under 1000, so raise neither cap without re-checking the
 * other. Every adversarial shape tried within these caps compiled in Go.
 * Longer or deeper patterns are unsupported; this also stays far below
 * RE2's class-rune limit (`\pL` repeated 26,000 times fails).
 */
const MAX_DEPTH = 64;
const MAX_PATTERN_LENGTH = 1024;
/**
 * RE2 also refuses programs that are too large (`(?:a…){1000}` with 3,400
 * literals fails). At most about 1.5 instructions per pattern character, so
 * length times the largest repeat product above this is unsupported.
 */
const MAX_EXPANDED_SIZE = 1_000_000;
/** Escaped letters RE2 accepts outside a class; a stray `\E` is an error. */
const ESCAPE_LETTERS = new Set('aftnrvxdDsSwWbBAzpPQ');
/** Escaped letters RE2 accepts inside a class (no assertions or `\Q`). */
const CLASS_ESCAPE_LETTERS = new Set('aftnrvxdDsSwWpP');
/** Escapes that stand for a set of characters, never a range endpoint. */
const CLASS_LIKE_ESCAPES = new Set('dDsSwWpP');
/** One-letter Unicode categories (`\pL`). */
const CATEGORY_LETTERS = new Set('CLMNPSZ');
/** RE2's ASCII classes inside brackets, optionally negated with `^`. */
const POSIX_CLASSES = new Set([
  'alnum',
  'alpha',
  'ascii',
  'blank',
  'cntrl',
  'digit',
  'graph',
  'lower',
  'print',
  'punct',
  'space',
  'upper',
  'word',
  'xdigit',
]);
/** RE2 looks property names up ignoring case, spaces, `_` and `-`. */
function propertyKey(name: string): string {
  return name.toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * `\p{…}` names agy accepts: RE2's general categories, short and long
 * (`Lu`, `Uppercase_Letter`, `Letter`), `Any`, `ASCII`, `Assigned`, and the
 * single-word Unicode 15 script names (`Greek`), matched ignoring case,
 * spaces, underscores and hyphens (`\p{greek}` is accepted). Go's lookup
 * canonicalizes `Old_Italic` to `Olditalic`, which matches no script key, so
 * multi-word and camel-case scripts (`SignWriting`) are left out. Probed:
 * binary properties (`Alphabetic`, `White_Space`, `Emoji`), four-letter
 * script codes (`Latn`) and `name=value` forms abort the turn. Names outside
 * this list are omitted: one agy rejects would abort the whole turn.
 */
const PROPERTY_NAMES: ReadonlySet<string> = new Set(
  [
    'Any',
    'ASCII',
    'Assigned',
    'Cn',
    'LC',
    'C',
    'Cc',
    'Cf',
    'Co',
    'Cs',
    'L',
    'Ll',
    'Lm',
    'Lo',
    'Lt',
    'Lu',
    'M',
    'Mc',
    'Me',
    'Mn',
    'N',
    'Nd',
    'Nl',
    'No',
    'P',
    'Pc',
    'Pd',
    'Pe',
    'Pf',
    'Pi',
    'Po',
    'Ps',
    'S',
    'Sc',
    'Sk',
    'Sm',
    'So',
    'Z',
    'Zl',
    'Zp',
    'Zs',
    'Other',
    'Control',
    'Format',
    'Private_Use',
    'Surrogate',
    'Letter',
    'Lowercase_Letter',
    'Modifier_Letter',
    'Other_Letter',
    'Titlecase_Letter',
    'Uppercase_Letter',
    'Mark',
    'Combining_Mark',
    'Spacing_Mark',
    'Enclosing_Mark',
    'Nonspacing_Mark',
    'Number',
    'Decimal_Number',
    'Letter_Number',
    'Other_Number',
    'Punctuation',
    'Connector_Punctuation',
    'Dash_Punctuation',
    'Close_Punctuation',
    'Final_Punctuation',
    'Initial_Punctuation',
    'Other_Punctuation',
    'Open_Punctuation',
    'Symbol',
    'Currency_Symbol',
    'Modifier_Symbol',
    'Math_Symbol',
    'Other_Symbol',
    'Separator',
    'Line_Separator',
    'Paragraph_Separator',
    'Space_Separator',
    'Adlam',
    'Ahom',
    'Arabic',
    'Armenian',
    'Avestan',
    'Balinese',
    'Bamum',
    'Batak',
    'Bengali',
    'Bhaiksuki',
    'Bopomofo',
    'Brahmi',
    'Braille',
    'Buginese',
    'Buhid',
    'Carian',
    'Chakma',
    'Cham',
    'Cherokee',
    'Chorasmian',
    'Common',
    'Coptic',
    'Cuneiform',
    'Cypriot',
    'Cyrillic',
    'Deseret',
    'Devanagari',
    'Dogra',
    'Duployan',
    'Elbasan',
    'Elymaic',
    'Ethiopic',
    'Georgian',
    'Glagolitic',
    'Gothic',
    'Grantha',
    'Greek',
    'Gujarati',
    'Gurmukhi',
    'Han',
    'Hangul',
    'Hanunoo',
    'Hatran',
    'Hebrew',
    'Hiragana',
    'Inherited',
    'Javanese',
    'Kaithi',
    'Kannada',
    'Katakana',
    'Kawi',
    'Kharoshthi',
    'Khmer',
    'Khojki',
    'Khudawadi',
    'Lao',
    'Latin',
    'Lepcha',
    'Limbu',
    'Lisu',
    'Lycian',
    'Lydian',
    'Mahajani',
    'Makasar',
    'Malayalam',
    'Mandaic',
    'Manichaean',
    'Marchen',
    'Medefaidrin',
    'Miao',
    'Modi',
    'Mongolian',
    'Mro',
    'Multani',
    'Myanmar',
    'Nabataean',
    'Nandinagari',
    'Newa',
    'Nko',
    'Nushu',
    'Ogham',
    'Oriya',
    'Osage',
    'Osmanya',
    'Palmyrene',
    'Phoenician',
    'Rejang',
    'Runic',
    'Samaritan',
    'Saurashtra',
    'Sharada',
    'Shavian',
    'Siddham',
    'Sinhala',
    'Sogdian',
    'Soyombo',
    'Sundanese',
    'Syriac',
    'Tagalog',
    'Tagbanwa',
    'Takri',
    'Tamil',
    'Tangsa',
    'Tangut',
    'Telugu',
    'Thaana',
    'Thai',
    'Tibetan',
    'Tifinagh',
    'Tirhuta',
    'Toto',
    'Ugaritic',
    'Vai',
    'Vithkuqi',
    'Wancho',
    'Yezidi',
    'Yi',
  ].map(propertyKey),
);

/** Index after a construct, or `undefined` when RE2 may reject it. */
type Next = number | undefined;

/** `indexOf` limited to `limit` characters, so every search stays bounded. */
function boundedIndexOf(
  p: string,
  search: string,
  from: number,
  limit: number,
): number {
  const found = p.slice(from, from + limit + search.length).indexOf(search);
  return found < 0 ? -1 : from + found;
}

const isSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdfff;
const isOctal = (c: string | undefined): boolean =>
  c !== undefined && c >= '0' && c <= '7';
const isHex = (c: string | undefined): boolean =>
  c !== undefined && /^[0-9A-Fa-f]$/.test(c);
const isDigit = (c: string | undefined): boolean =>
  c !== undefined && c >= '0' && c <= '9';

/** `\p` / `\P` at `i` (the backslash). */
function unicodeClass(p: string, i: number): Next {
  const open = p[i + 2];
  if (open !== '{')
    return open !== undefined && CATEGORY_LETTERS.has(open) ? i + 3 : undefined;
  const close = boundedIndexOf(p, '}', i + 3, 64);
  if (close < 0) return undefined;
  const name = p.slice(i + 3, close).replace(/^\^/, '');
  if (!PROPERTY_NAMES.has(propertyKey(name))) return undefined;
  return close + 1;
}

/** `\x41` or `\x{41}` at `i`. */
function hexEscape(p: string, i: number): Next {
  if (p[i + 2] === '{') {
    const close = boundedIndexOf(p, '}', i + 3, 8);
    const digits = close < 0 ? '' : p.slice(i + 3, close);
    return /^[0-9A-Fa-f]{1,6}$/.test(digits) &&
      Number.parseInt(digits, 16) <= 0x10ffff
      ? close + 1
      : undefined;
  }
  return isHex(p[i + 2]) && isHex(p[i + 3]) ? i + 4 : undefined;
}

/** `\X` for a letter `c` at `i`; `inClass` limits the letters RE2 accepts. */
function letterEscape(p: string, i: number, c: string, inClass: boolean): Next {
  if (!(inClass ? CLASS_ESCAPE_LETTERS : ESCAPE_LETTERS).has(c))
    return undefined;
  if (c === 'x') return hexEscape(p, i);
  if (c === 'p' || c === 'P') return unicodeClass(p, i);
  if (c !== 'Q') return i + 2;
  // Literal text up to `\E`, or to the end; the scan resumes after it.
  const end = p.indexOf('\\E', i + 2);
  return end < 0 ? p.length : end + 2;
}

/** Any escape at `i`. */
function escape(p: string, i: number, inClass: boolean): Next {
  const c = p[i + 1];
  if (c === undefined) return undefined;
  // Octal: `\0` with up to two more digits, or `\1`–`\7` followed by one
  // (`\12`). A lone `\1`–`\9` is a backreference RE2 rejects.
  if (c === '0' || (isOctal(c) && isOctal(p[i + 2]))) {
    let end = i + 2;
    while (end < i + 4 && isOctal(p[end])) end++;
    return end;
  }
  if (isDigit(c)) return undefined;
  if (/^[A-Za-z]$/.test(c)) return letterEscape(p, i, c, inClass);
  // Escaped ASCII punctuation is itself; other escaped characters are errors.
  return c.charCodeAt(0) < 0x80 ? i + 2 : undefined;
}

const CONTROL_ESCAPES = new Map([
  ['a', 7],
  ['f', 12],
  ['t', 9],
  ['n', 10],
  ['r', 13],
  ['v', 11],
]);

/** The code point an escaped class character at `j` stands for, if one. */
function escapedCode(p: string, j: number, end: number): number | undefined {
  const c = p[j + 1] ?? '';
  if (CLASS_LIKE_ESCAPES.has(c)) return undefined;
  const control = CONTROL_ESCAPES.get(c);
  if (control !== undefined) return control;
  if (c === 'x')
    return Number.parseInt(p.slice(j + 2, end).replace(/[{}]/g, ''), 16);
  if (isOctal(c)) return Number.parseInt(p.slice(j + 1, end), 8);
  return c.charCodeAt(0);
}

/** One class member at `j`: a character (with its code point) or a set. */
function classAtom(
  p: string,
  j: number,
): { end: number; code?: number } | undefined {
  if (p[j] === '[' && p[j + 1] === ':') {
    const close = boundedIndexOf(p, ':]', j + 2, 16);
    const name = close < 0 ? '' : p.slice(j + 2, close).replace(/^\^/, '');
    return POSIX_CLASSES.has(name) ? { end: close + 2 } : undefined;
  }
  if (p[j] === '\\') {
    const end = escape(p, j, true);
    return end === undefined
      ? undefined
      : { end, code: escapedCode(p, j, end) };
  }
  const code = p.codePointAt(j) ?? 0;
  if (isSurrogate(code)) return undefined;
  return { end: j + (code > 0xffff ? 2 : 1), code };
}

/**
 * A bracket class starting at `i`. A range needs two characters in order; a
 * set (`\d`, `[:alpha:]`) as its upper end or a reversed range is rejected.
 */
function bracketClass(p: string, i: number): Next {
  let j = i + 1;
  if (p[j] === '^') j++;
  // A leading `]` is a literal.
  let first = true;
  while (j < p.length) {
    if (p[j] === ']' && !first) return j + 1;
    first = false;
    const low = classAtom(p, j);
    if (low === undefined) return undefined;
    j = low.end;
    // After a set, RE2's Perl mode reads `-` as a literal (`[\d-z]`).
    if (low.code === undefined) continue;
    if (p[j] !== '-' || p[j + 1] === ']' || p[j + 1] === undefined) continue;
    const high = classAtom(p, j + 1);
    if (high?.code === undefined || high.code < low.code) return undefined;
    j = high.end;
  }
  return undefined;
}

/** A `{n}`, `{n,}` or `{n,m}` repeat at `i`, or `literal` when `{` is not one. */
const REPEAT = /\{(\d+)(,(\d*))?\}/y;

function repeat(
  p: string,
  i: number,
): { end: number; count: number } | undefined | 'literal' {
  REPEAT.lastIndex = i;
  const match = REPEAT.exec(p);
  if (!match) return 'literal';
  const min = Number(match[1]);
  const max = match[3] ? Number(match[3]) : min;
  if (min > MAX_REPEAT || max > MAX_REPEAT || max < min) return undefined;
  // RE2 counts `{n,}` by its minimum.
  const count = match[2] !== undefined && !match[3] ? min : max;
  return { end: i + match[0].length, count };
}

/** `(?` group syntax at `i` (the parenthesis): returns the index after it. */
function groupOpen(
  p: string,
  i: number,
  names: Set<string>,
): { next: number; opens: boolean } | undefined {
  const rest = p.slice(i + 2, i + 2 + 256);
  if (rest.startsWith(':')) return { next: i + 3, opens: true };
  const named = /^P?<([A-Za-z0-9_]+)>/.exec(rest);
  if (named?.[1] !== undefined) {
    if (names.has(named[1])) return undefined;
    names.add(named[1]);
    return { next: i + 2 + named[0].length, opens: true };
  }
  // Empty flags (`(?)`) are accepted; `-` must be followed by a flag.
  const flags = /^[imsU]*(?:-[imsU]+)?([):])/.exec(rest);
  if (!flags) return undefined;
  return { next: i + 2 + flags[0].length, opens: flags[1] === ':' };
}

interface ScanState {
  depth: number;
  /** Whether the previous item can take a repetition operator. */
  repeatable: boolean;
  readonly names: Set<string>;
  /** Repeat product of the previous item: 1, or a closed group's largest. */
  atom: number;
  /** Largest repeat product inside each open group, outermost first. */
  readonly products: number[];
  /** Largest repeat product anywhere in the pattern. */
  largest: number;
}

/** Records a repeat product within the innermost open group. */
function noteProduct(state: ScanState, product: number): void {
  state.largest = Math.max(state.largest, product);
  const last = state.products.length - 1;
  state.products[last] = Math.max(state.products[last] ?? 1, product);
}

/** Advances past a repetition operator (with its lazy `?`) at `i`. */
function quantifier(p: string, i: number, state: ScanState): Next | 'literal' {
  const counted = p[i] === '{' ? repeat(p, i) : { end: i + 1, count: 1 };
  if (counted === 'literal') return 'literal';
  if (counted === undefined || !state.repeatable) return undefined;
  const product = state.atom * counted.count;
  if (product > MAX_REPEAT_PRODUCT) return undefined;
  noteProduct(state, product);
  const end = counted.end;
  state.repeatable = false;
  // One lazy `?`; anything after it is a nested repetition RE2 rejects.
  return p[end] === '?' ? end + 1 : end;
}

function openGroup(state: ScanState, next: number): Next {
  if (state.depth >= MAX_DEPTH) return undefined;
  state.depth++;
  state.products.push(1);
  return next;
}

/** A group opening at `i` (the parenthesis). */
function groupStep(p: string, i: number, state: ScanState): Next {
  if (p[i + 1] === '*') return undefined;
  state.repeatable = false;
  if (p[i + 1] !== '?') return openGroup(state, i + 1);
  const group = groupOpen(p, i, state.names);
  if (group === undefined) return undefined;
  return group.opens ? openGroup(state, group.next) : group.next;
}

/** A literal or metacharacter that takes no further parsing. */
function plainStep(p: string, i: number, state: ScanState): Next {
  const c = p[i];
  state.repeatable = c !== '|' && c !== '^' && c !== '$';
  const code = p.codePointAt(i) ?? 0;
  // A lone surrogate is not valid UTF-8 for the runtime.
  if (isSurrogate(code)) return undefined;
  return i + (code > 0xffff ? 2 : 1);
}

/** Whether the escape at `i` ending at `end` is `\Q` with no text. */
function emptyQuote(p: string, i: number, end: Next): boolean {
  if (p[i + 1] !== 'Q' || end === undefined) return false;
  return end === i + 2 || (end === i + 4 && p.startsWith('\\E', i + 2));
}

/** Advances past one item at `i`, updating `state`. */
function step(p: string, i: number, state: ScanState): Next {
  const c = p[i];
  // A quantifier applies to the previous item; anything else starts a new one.
  if (!QUANTIFIER_START.has(c ?? '') && c !== ')') state.atom = 1;
  if (c === '\\') {
    const end = escape(p, i, false);
    // Assertions match no character and an empty `\Q\E` adds nothing, so
    // neither takes a repetition.
    state.repeatable =
      !/^[bBAz]$/.test(p[i + 1] ?? '') && !emptyQuote(p, i, end);
    return end;
  }
  if (c === '[') {
    state.repeatable = true;
    return bracketClass(p, i);
  }
  if (c === '(') return groupStep(p, i, state);
  if (c === ')') {
    if (state.depth === 0) return undefined;
    state.depth--;
    state.atom = state.products.pop() ?? 1;
    noteProduct(state, state.atom);
    state.repeatable = true;
    return i + 1;
  }
  if (QUANTIFIER_START.has(c ?? '')) {
    const end = quantifier(p, i, state);
    if (end !== 'literal') return end;
  }
  return plainStep(p, i, state);
}

export function agyAcceptsPattern(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return false;
  const state: ScanState = {
    depth: 0,
    repeatable: false,
    names: new Set(),
    atom: 1,
    products: [1],
    largest: 1,
  };
  let i = 0;
  while (i < pattern.length) {
    const next = step(pattern, i, state);
    if (next === undefined) return false;
    i = next;
  }
  return (
    state.depth === 0 && pattern.length * state.largest <= MAX_EXPANDED_SIZE
  );
}
