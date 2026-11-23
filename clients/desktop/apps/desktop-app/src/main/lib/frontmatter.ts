import * as yaml from 'js-yaml';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

function isFrontmatterRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns `null` if no frontmatter block is found or parsing fails.
 */
export function parseFrontmatter<T = Record<string, unknown>>(
  content: string,
): T | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;
  try {
    return yaml.load(match[1]) as T;
  } catch {
    return null;
  }
}

/**
 * Split a markdown string into its frontmatter and body parts.
 */
export function parseFrontmatterAndBody(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = raw.match(FRONTMATTER_RE);
  let frontmatter: Record<string, unknown> = {};
  let body = raw;

  if (match) {
    try {
      const parsed = yaml.load(match[1]);
      frontmatter = isFrontmatterRecord(parsed) ? parsed : {};
    } catch {
      // Keep the body-stripping behavior, but ignore malformed metadata.
    }
    body = raw.slice(match[0].length).replace(/^\r?\n/, '');
  }

  return { frontmatter, body };
}

/** Front matter from a publisher file opened before install. */
export function parseCatalogFrontmatterAndBody(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = FRONTMATTER_RE.exec(raw);
  const source = match?.[1];
  if (source === undefined || !match) return { frontmatter: {}, body: raw };
  let frontmatter: Record<string, unknown> = {};
  // Do not evaluate a document that could expand an alias: CORE_SCHEMA alone
  // still expands aliases when coercing sequence keys to strings. An alias
  // needs an anchor, and both need a literal `&` and `*`. Checking for those
  // characters anywhere, instead of re-deriving where YAML starts a node,
  // cannot disagree with the parser's grammar (verbatim tags, U+FEFF in
  // names). It may skip a file whose text merely contains both characters,
  // which only costs that file its description.
  if (source.length <= 32 * 1024) {
    if (!(source.includes('&') && source.includes('*'))) {
      try {
        let depth = 0;
        const parsed: unknown = yaml.load(source, {
          schema: yaml.CORE_SCHEMA,
          listener(event): void {
            depth += event === 'open' ? 1 : -1;
            if (depth > 32)
              throw new Error('Front matter nesting limit exceeded.');
          },
        });
        if (isFrontmatterRecord(parsed)) frontmatter = parsed;
      } catch {
        // Keep the Markdown body even if its metadata cannot be read safely.
      }
    }
  }
  return {
    frontmatter,
    body: raw.slice(match[0].length).replace(/^\r?\n/, ''),
  };
}

/**
 * The front matter the installed plugin scanner reads from a publisher file
 * (`parseFrontmatter` on its whole text, under the default schema), worked
 * out from a prefix of it read before install. Empty when the scanner reads
 * none, as it does for a file with a byte order mark or malformed YAML;
 * undefined when the prefix cannot settle what it reads: the block does not
 * close within a cut prefix, it could expand an alias (it holds both `&` and
 * `*`), or it nests deeper than is parsed here.
 */
export function readCatalogScannerFrontmatter(
  prefix: string,
  /** Whether `prefix` is the whole file. */
  whole: boolean,
): Record<string, unknown> | undefined {
  const source = FRONTMATTER_RE.exec(prefix)?.[1];
  if (source === undefined) return whole ? {} : undefined;
  if (source.includes('&') && source.includes('*')) return undefined;
  let tooDeep = false;
  try {
    let depth = 0;
    const parsed: unknown = yaml.load(source, {
      listener(event): void {
        depth += event === 'open' ? 1 : -1;
        if (depth > 32) {
          tooDeep = true;
          throw new Error('Front matter nesting limit exceeded.');
        }
      },
    });
    return isFrontmatterRecord(parsed) ? parsed : {};
  } catch {
    // The scanner reads no front matter from YAML it cannot parse.
    return tooDeep ? undefined : {};
  }
}
