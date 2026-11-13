import { randomBytes } from 'node:crypto';
import {
  encodeMemoryUlid,
  isMemoryUlid,
  MEMORY_ULID_MAX_TIME_MS,
  MemoryNoteFrontmatterIdentitySchema,
  type MemoryNoteFrontmatterIdentity,
} from '@canopy/protocol/memory-sync';

const ULID_RANDOM_BYTES = 10;

/**
 * A note ID whose time part is `createdMs`, the note's `created`. Not
 * monotonic: notes are ordered by their times, and 80 random bits keep IDs
 * minted in one millisecond, on any device, apart.
 */
export function memoryNoteIdAt(createdMs: number): string {
  const time = Number.isFinite(createdMs)
    ? Math.min(Math.max(Math.trunc(createdMs), 0), MEMORY_ULID_MAX_TIME_MS)
    : 0;
  return encodeMemoryUlid(time, randomBytes(ULID_RANDOM_BYTES));
}

export function memoryNoteSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'note';
}

/** The last millisecond whose ISO year has four digits. */
const LAST_FOUR_DIGIT_YEAR_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

function filenameTimestamp(timeMs: number): string {
  const clamped = Number.isFinite(timeMs)
    ? Math.min(Math.max(timeMs, 0), LAST_FOUR_DIGIT_YEAR_MS)
    : 0;
  return new Date(clamped).toISOString().slice(0, 19).replace(/:/g, '-');
}

/**
 * `<created>-<slug>-<last 6 of the ID, lower>.md`: two devices saving the
 * same text in the same second still mint different names.
 */
export function memoryNoteFileName(
  createdMs: number,
  slugSource: string,
  noteId: string,
): string {
  return `${filenameTimestamp(createdMs)}-${memoryNoteSlug(slugSource)}-${noteId.slice(-6).toLowerCase()}.md`;
}

interface FrontMatterBlock {
  /** The lines between the delimiters, without line endings. */
  lines: string[];
  eol: string;
  /** Where the opening delimiter starts (after a byte order mark). */
  start: number;
  /** Where the body starts, after the closing delimiter's line ending. */
  end: number;
}

function frontMatterBlock(content: string): FrontMatterBlock | null {
  const start = content.startsWith('\uFEFF') ? 1 : 0;
  const opening = /^---(\r?\n)/.exec(content.slice(start));
  if (!opening) return null;
  const eol = opening[1];
  const lines: string[] = [];
  let cursor = start + opening[0].length;
  while (cursor <= content.length) {
    const next = content.indexOf('\n', cursor);
    const lineEnd = next === -1 ? content.length : next;
    const line = content.slice(cursor, lineEnd).replace(/\r$/, '');
    if (line === '---') {
      return { lines, eol, start, end: next === -1 ? lineEnd : next + 1 };
    }
    if (next === -1) return null;
    lines.push(line);
    cursor = next + 1;
  }
  return null;
}

function frontMatterScalar(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (!value.startsWith('"')) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

type FrontMatterValue = string | Record<string, string>;

/** Top-level `key: value` fields and one level of indented `key:` blocks. */
function frontMatterFields(
  lines: readonly string[],
): Record<string, FrontMatterValue> {
  const fields: Record<string, FrontMatterValue> = {};
  let block: Record<string, string> | null = null;
  for (const line of lines) {
    const nested = /^\s+([A-Za-z][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (nested && block !== null) {
      const value = frontMatterScalar(nested[2]);
      if (value !== undefined) block[nested[1]] = value;
      continue;
    }
    const top = /^([A-Za-z][A-Za-z0-9_]*):(.*)$/.exec(line);
    block = null;
    if (!top) continue;
    const value = frontMatterScalar(top[2]);
    if (value !== undefined) {
      fields[top[1]] = value;
    } else if (top[2].trim() === '') {
      block = {};
      fields[top[1]] = block;
    }
  }
  return fields;
}

/**
 * A note's front matter fields (top-level scalars and one level of nested
 * blocks) and the text after its closing delimiter; null without front
 * matter.
 */
export function readMemoryNoteFrontMatter(content: string): {
  fields: Record<string, FrontMatterValue>;
  rest: string;
} | null {
  const block = frontMatterBlock(content);
  if (block === null) return null;
  return {
    fields: frontMatterFields(block.lines),
    rest: content.slice(block.end),
  };
}

/** The identity fields of a version 2 note; null for a note without an ID. */
export function parseMemoryNoteIdentity(
  content: string,
): MemoryNoteFrontmatterIdentity | null {
  const block = frontMatterBlock(content);
  if (block === null) return null;
  const parsed = MemoryNoteFrontmatterIdentitySchema.safeParse(
    frontMatterFields(block.lines),
  );
  return parsed.success ? parsed.data : null;
}

/**
 * The note's ID alone. A note keeps a valid ID even when another identity
 * field is malformed, so nothing ever mints it a second one.
 */
export function memoryNoteId(content: string): string | null {
  const block = frontMatterBlock(content);
  if (block === null) return null;
  const id = frontMatterFields(block.lines).id;
  return isMemoryUlid(id) ? id : null;
}

/** The note's `created` time, when its front matter records a valid one. */
export function memoryNoteCreatedMs(content: string): number | null {
  const block = frontMatterBlock(content);
  if (block === null) return null;
  const created = frontMatterFields(block.lines).created;
  if (typeof created !== 'string') return null;
  const ms = Date.parse(created);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The note with `id` as the first front matter field, replacing any `id`
 * line it had. A note without front matter gets a block holding only the ID;
 * the body is unchanged.
 */
export function withMemoryNoteId(content: string, noteId: string): string {
  const idLine = `id: ${JSON.stringify(noteId)}`;
  const block = frontMatterBlock(content);
  if (block === null) {
    const body = content.replace(/^\uFEFF/, '');
    return `---\n${idLine}\n---\n${body}`;
  }
  const kept = block.lines.filter((line) => !/^id:/.test(line));
  const { eol } = block;
  return [
    content.slice(0, block.start),
    `---${eol}`,
    [idLine, ...kept].map((line) => `${line}${eol}`).join(''),
    `---${eol}`,
    content.slice(block.end),
  ].join('');
}

/**
 * The note with each given top-level scalar field set, replacing the line it
 * had or adding one at the end of the front matter; the body is unchanged. A
 * note without front matter is returned as it is.
 */
export function withMemoryNoteScalarFields(
  content: string,
  fields: Readonly<Record<string, string>>,
): string {
  const block = frontMatterBlock(content);
  if (block === null) return content;
  const names = Object.keys(fields);
  const isReplaced = (line: string): boolean =>
    names.some((name) => line.startsWith(`${name}:`));
  const kept = block.lines.filter((line) => !isReplaced(line));
  const added = names.map((name) => `${name}: ${JSON.stringify(fields[name])}`);
  const { eol } = block;
  return [
    content.slice(0, block.start),
    `---${eol}`,
    [...kept, ...added].map((line) => `${line}${eol}`).join(''),
    `---${eol}`,
    content.slice(block.end),
  ].join('');
}
