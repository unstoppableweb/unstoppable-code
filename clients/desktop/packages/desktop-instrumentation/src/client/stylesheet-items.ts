/** At-rules whose blocks hold style rules that can each be masked. */
export const BLOCK_AT_RULES: ReadonlySet<string> = new Set([
  'media',
  'supports',
  'layer',
  'container',
  'scope',
]);

/** Ends of each top-level item (rule, at-rule or statement), or null if unbalanced. */
export function splitTopLevel(css: string): string[] | null {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  let quote = '';
  for (let i = 0; i < css.length; i += 1) {
    const c = css[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
      else if (c === '\n') return null;
      continue;
    }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 1;
    } else if (c === '\\') {
      i += 1;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth < 0) return null;
      if (depth === 0) {
        items.push(css.slice(start, i + 1));
        start = i + 1;
      }
    } else if (c === ';' && depth === 0) {
      items.push(css.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (quote || depth !== 0) return null;
  if (start < css.length) items.push(css.slice(start));
  return items;
}

/** The index of an item's first top-level `{`, skipping strings and comments. */
export function blockStart(item: string): number {
  let quote = '';
  for (let i = 0; i < item.length; i += 1) {
    const c = item[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && item[i + 1] === '*') {
      i = item.indexOf('*/', i + 2) + 1;
      if (i === 0) return -1;
    } else if (c === '\\') {
      i += 1;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '{') {
      return i;
    }
  }
  return -1;
}

export function atRuleName(item: string): string | null {
  const match = /^(?:\s|\/\*[\s\S]*?\*\/)*@([-\w]+)/.exec(item);
  return match?.[1]?.toLowerCase() ?? null;
}

/** Whether an item holds only comments and whitespace. */
export const isBlank = (item: string): boolean =>
  item.replace(/\/\*[\s\S]*?\*\//g, '').trim() === '';

export const isStyleRule = (item: string): boolean =>
  atRuleName(item) === null &&
  blockStart(item) !== -1 &&
  item.trimEnd().endsWith('}');
