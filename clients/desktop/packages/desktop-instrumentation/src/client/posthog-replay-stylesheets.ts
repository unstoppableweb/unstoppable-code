import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';
import { findSharedTextCredentialRule } from '@canopy/protocol/shared-containers';
import {
  atRuleName,
  BLOCK_AT_RULES,
  blockStart,
  isBlank,
  isStyleRule,
  splitTopLevel,
} from './stylesheet-items';

/**
 * The SDK compresses some recording fields before `before_send` sees them
 * (`cv: '2024-10'`): JSON, UTF-8, gzip, then one character per byte.
 */
const COMPRESSION_VERSION = '2024-10';
const MAX_DECOMPRESSED_BYTES = 16 * 1024 * 1024;
/** UTF-16 code units, the unit the credential check's cost grows with. */
const MAX_STYLESHEET_LENGTH = 4 * 1024 * 1024;

const FULL_SNAPSHOT = 2;
const INCREMENTAL_SNAPSHOT = 3;
const MUTATION = 0;
const STYLE_SHEET_RULE = 8;
const STYLE_DECLARATION = 13;
const ADOPTED_STYLE_SHEET = 15;
const ELEMENT_NODE = 2;
const TEXT_NODE = 3;

/** Stands in for a masked style rule, so the sheet keeps its rule indices. */
const PLACEHOLDER_RULE = ':not(*){}';
const DROP = Symbol('drop');

const counts = { eventsDropped: 0, payloadsEmptied: 0, rulesMasked: 0 };

/** Counts only, for debugging; never any stylesheet text. */
export function readReplayStylesheetMaskCounts(): Readonly<typeof counts> {
  return { ...counts };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const trips = (text: string): boolean =>
  findSharedTextCredentialRule(text) !== null;

/**
 * Replace each style rule the check flags with {@link PLACEHOLDER_RULE},
 * recursing into block at-rules. Null when a flagged item can't be masked on
 * its own (an at-rule such as `@font-face`, or `@keyframes` content).
 */
function maskFlaggedRules(css: string): string | null {
  const items = splitTopLevel(css);
  if (items === null) return null;
  let kept = '';
  for (const item of items) {
    if (!trips(item)) {
      kept += item;
      continue;
    }
    if (isBlank(item)) continue;
    if (isStyleRule(item)) {
      counts.rulesMasked += 1;
      kept += PLACEHOLDER_RULE;
      continue;
    }
    const name = atRuleName(item);
    if (name === null || !BLOCK_AT_RULES.has(name)) return null;
    const open = blockStart(item);
    if (open === -1 || !item.endsWith('}') || trips(item.slice(0, open))) {
      return null;
    }
    const body = maskFlaggedRules(item.slice(open + 1, -1));
    if (body === null) return null;
    kept += `${item.slice(0, open + 1)}${body}}`;
  }
  return kept;
}

/**
 * Stylesheet text with each style rule the shared credential check flags
 * replaced by {@link PLACEHOLDER_RULE}. Text that can't be split into rules,
 * is too long to scan, flags an at-rule, or still trips the check once those
 * rules are masked (a token across two rules or in a comment) becomes empty.
 */
function maskStylesheet(css: string): string {
  if (css.length > MAX_STYLESHEET_LENGTH) {
    counts.payloadsEmptied += 1;
    return '';
  }
  if (!trips(css)) return css;
  const kept = maskFlaggedRules(css);
  if (kept === null || trips(kept)) {
    counts.payloadsEmptied += 1;
    return '';
  }
  return kept;
}

function maskNode(node: unknown): unknown {
  if (!isRecord(node)) return node;
  let next: Record<string, unknown> | undefined;
  if (
    node.type === TEXT_NODE &&
    node.isStyle === true &&
    typeof node.textContent === 'string'
  ) {
    const textContent = maskStylesheet(node.textContent);
    if (textContent !== node.textContent) next = { ...node, textContent };
  }
  if (node.type === ELEMENT_NODE && isRecord(node.attributes)) {
    const attributes = maskCssTextAttribute(node.attributes);
    if (attributes !== node.attributes) next = { ...node, attributes };
  }
  if (Array.isArray(node.childNodes)) {
    const childNodes = mapChanged(node.childNodes, maskNode);
    if (childNodes !== node.childNodes) {
      next = { ...(next ?? node), childNodes };
    }
  }
  return next ?? node;
}

function maskCssTextAttribute(
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  const cssText = attributes._cssText;
  if (typeof cssText !== 'string') return attributes;
  const masked = maskStylesheet(cssText);
  return masked === cssText ? attributes : { ...attributes, _cssText: masked };
}

/** The same array when nothing changed, so untouched payloads stay as they were. */
function mapChanged(
  values: readonly unknown[],
  map: (value: unknown) => unknown,
): unknown[] | readonly unknown[] {
  let changed: unknown[] | undefined;
  values.forEach((value, index) => {
    const next = map(value);
    if (next !== value) {
      changed ??= [...values];
      changed[index] = next;
    }
  });
  return changed ?? values;
}

/**
 * One CSSOM rule: a flagged style rule becomes {@link PLACEHOLDER_RULE} so
 * later index-based edits still line up; any other flagged rule drops the
 * whole event.
 */
const maskRuleEntry = (entry: unknown): unknown => {
  if (!isRecord(entry) || typeof entry.rule !== 'string') return entry;
  if (entry.rule.length > MAX_STYLESHEET_LENGTH) return DROP;
  if (!trips(entry.rule)) return entry;
  if (!isStyleRule(entry.rule) || splitTopLevel(entry.rule)?.length !== 1) {
    return DROP;
  }
  counts.rulesMasked += 1;
  return { ...entry, rule: PLACEHOLDER_RULE };
};

const maskAddedNode = (entry: unknown): unknown => {
  if (!isRecord(entry)) return entry;
  const node = maskNode(entry.node);
  return node === entry.node ? entry : { ...entry, node };
};

const maskAttributeMutation = (entry: unknown): unknown => {
  if (!isRecord(entry) || !isRecord(entry.attributes)) return entry;
  const attributes = maskCssTextAttribute(entry.attributes);
  return attributes === entry.attributes ? entry : { ...entry, attributes };
};

const maskAdoptedStyle = (entry: unknown): unknown => {
  if (!isRecord(entry) || !Array.isArray(entry.rules)) return entry;
  const rules = mapChanged(entry.rules, maskRuleEntry);
  if (rules.includes(DROP)) return DROP;
  return rules === entry.rules ? entry : { ...entry, rules };
};

const tooLongOrTrips = (text: string): boolean =>
  text.length > MAX_STYLESHEET_LENGTH || trips(text);

/** Whether a declaration edit's property, or property and value, is flagged. */
function declarationTrips(data: Record<string, unknown>): boolean {
  const { set, remove } = data;
  if (isRecord(set)) {
    const property = typeof set.property === 'string' ? set.property : '';
    const value = typeof set.value === 'string' ? set.value : '';
    if (tooLongOrTrips(property) || tooLongOrTrips(`${property}: ${value}`)) {
      return true;
    }
  }
  return (
    isRecord(remove) &&
    typeof remove.property === 'string' &&
    tooLongOrTrips(remove.property)
  );
}

/** Parse a compressed field, or undefined when it isn't in the known format. */
function decodeField(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  const bytes = strToU8(value, true);
  const length = bytes.length;
  if (length < 18) return undefined;
  // fflate reads the gzip trailer's ISIZE this way when it sizes its output.
  const isize =
    (bytes[length - 4] | (bytes[length - 3] << 8) | (bytes[length - 2] << 16)) +
    2 * (bytes[length - 1] << 23);
  if (isize < 0 || isize > MAX_DECOMPRESSED_BYTES) return undefined;
  try {
    // One spare byte: fflate truncates silently into a buffer that is too small.
    const output = gunzipSync(bytes, new Uint8Array(isize + 1));
    if (output.length !== isize) return undefined;
    const parsed: unknown = JSON.parse(strFromU8(output));
    return parsed;
  } catch {
    return undefined;
  }
}

/** The SDK's encoding for a compressed recording field. */
export const encodeReplayField = (value: unknown): string =>
  strFromU8(gzipSync(strToU8(JSON.stringify(value))), true);

/**
 * Mask one array field of an event: decoded and re-encoded only when masking
 * changed it, so a field without a hit keeps its original string.
 */
function maskArrayField(
  value: unknown,
  compressed: boolean,
  map: (entry: unknown) => unknown,
): unknown {
  const decoded = compressed ? decodeField(value) : value;
  if (!Array.isArray(decoded)) return compressed ? DROP : value;
  const masked = mapChanged(decoded, map);
  if (masked.includes(DROP)) return DROP;
  if (masked === decoded) return value;
  return compressed ? encodeReplayField(masked) : masked;
}

function maskIncremental(
  event: Record<string, unknown>,
  data: Record<string, unknown>,
  compressed: boolean,
): unknown {
  const source = data.source;
  const next: Record<string, unknown> = { ...data };
  if (source === MUTATION) {
    if (compressed) {
      for (const field of ['texts', 'removes'] as const) {
        if (!Array.isArray(decodeField(data[field]))) return DROP;
      }
    }
    for (const [field, map] of [
      ['adds', maskAddedNode],
      ['attributes', maskAttributeMutation],
    ] as const) {
      const masked = maskArrayField(data[field], compressed, map);
      if (masked === DROP) return DROP;
      next[field] = masked;
    }
  } else if (source === STYLE_SHEET_RULE) {
    for (const [field, map] of [
      ['adds', maskRuleEntry],
      ['removes', (entry: unknown) => entry],
    ] as const) {
      if (data[field] === undefined) continue;
      const masked = maskArrayField(data[field], compressed, map);
      if (masked === DROP) return DROP;
      next[field] = masked;
    }
    for (const field of ['replace', 'replaceSync'] as const) {
      const text = data[field];
      if (typeof text === 'string') next[field] = maskStylesheet(text);
    }
  } else if (compressed) {
    return DROP;
  } else if (source === STYLE_DECLARATION) {
    if (declarationTrips(data)) return DROP;
  } else if (source === ADOPTED_STYLE_SHEET && Array.isArray(data.styles)) {
    const styles = mapChanged(data.styles, maskAdoptedStyle);
    if (styles.includes(DROP)) return DROP;
    next.styles = styles;
  }
  const changed = Object.keys(next).some((key) => next[key] !== data[key]);
  return changed ? { ...event, data: next } : event;
}

function maskEvent(event: unknown): unknown {
  if (!isRecord(event)) return DROP;
  const cv = event.cv;
  if (cv !== undefined && cv !== COMPRESSION_VERSION) return DROP;
  const compressed = cv === COMPRESSION_VERSION;
  if (event.type === FULL_SNAPSHOT) {
    const data = compressed ? decodeField(event.data) : event.data;
    if (!isRecord(data)) return DROP;
    const node = maskNode(data.node);
    if (node === data.node) return event;
    const masked = { ...data, node };
    return { ...event, data: compressed ? encodeReplayField(masked) : masked };
  }
  if (event.type === INCREMENTAL_SNAPSHOT) {
    if (!isRecord(event.data)) return DROP;
    return maskIncremental(event, event.data, compressed);
  }
  return compressed ? DROP : event;
}

/**
 * Run every stylesheet payload in a `$snapshot` batch through the shared
 * credential check: `<style>` text, `_cssText`, CSSOM rule edits,
 * declarations and adopted sheets, in plain and compressed events. A
 * flagged style rule is replaced by an inert placeholder, the rest of its
 * sheet kept; a flagged declaration edit drops its event. An event in an
 * unknown format is dropped; a batch that isn't an event array returns null.
 */
export function maskReplaySnapshotData(data: unknown): unknown[] | null {
  if (!Array.isArray(data)) return null;
  const events: unknown[] = [];
  for (const event of data) {
    const masked = maskEvent(event);
    if (masked === DROP) counts.eventsDropped += 1;
    else events.push(masked);
  }
  return events;
}
