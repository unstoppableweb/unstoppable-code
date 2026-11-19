import type { WriteSecretsFileFormat } from '@canopy/agent-actions';

/*
 * The text WriteSecretsFile writes, per format. Pure functions: values come
 * in, file text goes out, and nothing here keeps or logs either.
 */

export class SecretsFileFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsFileFormatError';
  }
}

/**
 * One dotenv value, quoted so a dotenv parser reads back exactly the value:
 * single quotes are literal, so they are preferred; a value that holds a
 * single quote uses backticks, which are also literal. A value with both, or
 * with a carriage return, cannot be written losslessly and is refused (use
 * json or raw).
 */
export function quoteDotenvValue(value: string): string {
  // Parsers turn a quoted CRLF into LF, so the value wouldn't read back.
  if (value.includes('\r'))
    throw new SecretsFileFormatError(
      'A secret holds a carriage return, which a .env file cannot hold exactly. Use format json or raw.',
    );
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('`')) return `\`${value}\``;
  throw new SecretsFileFormatError(
    'A secret holds both a single quote and a backtick, which a .env file cannot hold exactly. Use format json or raw.',
  );
}

interface DotenvLine {
  /** The key this line (or line group) assigns, if any. */
  key?: string;
  /** The original text, inner line breaks included, exactly as in the file. */
  text: string;
  /** The line break that ends it in the file (`\n`, `\r\n`), or '' at the end. */
  eol: string;
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/;

/** The file's lines, each with the line break that ends it. */
function physicalLines(text: string): Array<{ line: string; eol: string }> {
  const lines: Array<{ line: string; eol: string }> = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) {
      lines.push({ line: text.slice(start), eol: '' });
      break;
    }
    const crlf = newline > start && text[newline - 1] === '\r';
    lines.push({
      line: text.slice(start, crlf ? newline - 1 : newline),
      eol: crlf ? '\r\n' : '\n',
    });
    start = newline + 1;
  }
  return lines;
}

/**
 * Whether `text` holds the quote that closes a value opened with `quote`.
 * Inside double quotes a backslash escapes the next character, so `\"`
 * does not close it; single quotes and backticks are literal.
 */
function closesQuote(text: string, quote: string): boolean {
  if (quote !== '"') return text.includes(quote);
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') index += 1;
    else if (text[index] === '"') return true;
  }
  return false;
}

/**
 * Splits an existing .env file into lines, keeping a quoted value that
 * spans several lines together, so a merge can replace whole assignments.
 * Every line keeps its own line breaks, so a merge writes what it doesn't
 * replace back byte for byte (a CRLF value stays CRLF).
 */
export function splitDotenv(text: string): DotenvLine[] {
  const lines = physicalLines(text);
  const result: DotenvLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const { line, eol } = lines[index] ?? { line: '', eol: '' };
    const match = ASSIGNMENT.exec(line);
    if (!match) {
      result.push({ text: line, eol });
      continue;
    }
    const [, key, rest = ''] = match;
    const quote = rest[0];
    let group = line;
    let groupEol = eol;
    if (
      (quote === '"' || quote === "'" || quote === '`') &&
      !closesQuote(rest.slice(1), quote)
    ) {
      // An open quote: the value continues to the line that closes it.
      let end = index + 1;
      while (end < lines.length && !closesQuote(lines[end]?.line ?? '', quote))
        end += 1;
      if (end < lines.length) {
        group = lines
          .slice(index, end + 1)
          .map((part, offset) =>
            offset === end - index ? part.line : part.line + part.eol,
          )
          .join('');
        groupEol = lines[end]?.eol ?? '';
        index = end;
      }
    }
    result.push({ ...(key ? { key } : {}), text: group, eol: groupEol });
  }
  return result;
}

function dotenvText(
  existing: string | null,
  entries: ReadonlyArray<readonly [string, string]>,
): string {
  const assignments = new Map(
    entries.map(([key, value]) => [key, `${key}=${quoteDotenvValue(value)}`]),
  );
  const lines = existing === null ? [] : splitDotenv(existing);
  // New lines follow the file's own line breaks.
  const newline = lines.find((line) => line.eol)?.eol ?? '\n';
  let text = '';
  const written = new Set<string>();
  for (const line of lines) {
    const replacement = line.key ? assignments.get(line.key) : undefined;
    if (replacement === undefined || !line.key) {
      text += line.text + (line.eol || newline);
      continue;
    }
    // The first assignment of a key takes the new value; later ones go.
    if (!written.has(line.key)) text += replacement + (line.eol || newline);
    written.add(line.key);
  }
  for (const [key, line] of assignments)
    if (!written.has(key)) text += line + newline;
  return text;
}

function jsonText(
  existing: string | null,
  entries: ReadonlyArray<readonly [string, string]>,
): string {
  let object: Record<string, unknown> = {};
  if (existing !== null && existing.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new SecretsFileFormatError(
        'The existing file is not valid JSON, so it cannot be merged. Use mode replace.',
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new SecretsFileFormatError(
        'The existing file is not a JSON object, so it cannot be merged. Use mode replace.',
      );
    object = { ...parsed };
  }
  for (const [key, value] of entries) object[key] = value;
  return `${JSON.stringify(object, null, 2)}\n`;
}

/**
 * The file text for `entries` (key, value pairs). `existing` is the file's
 * current text for a merge, or null to replace it.
 */
export function secretsFileText(
  format: WriteSecretsFileFormat,
  entries: ReadonlyArray<readonly [string, string]>,
  existing: string | null,
): string {
  switch (format) {
    case 'dotenv':
      return dotenvText(existing, entries);
    case 'json':
      return jsonText(existing, entries);
    case 'raw': {
      const [entry] = entries;
      if (!entry || entries.length !== 1)
        throw new SecretsFileFormatError('raw writes exactly one secret.');
      return entry[1];
    }
  }
}
