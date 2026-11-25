import type { InvocableInventoryEntry } from '@canopy/desktop-shared/types';

export interface InvocableMentionTarget {
  entry: InvocableInventoryEntry;
  label: string;
  aliases: string[];
}

export interface InvocableMentionIndex {
  targets: InvocableMentionTarget[];
  aliases: Map<string, InvocableMentionTarget>;
  sortedAliases: string[];
  /**
   * Single compiled matcher for all aliases. Replaces the previous explicit
   * textLength-by-aliasCount character walk with the JS regex engine's compiled
   * alternation. `null` when there are no aliases (callers guard on
   * `aliases.size === 0`).
   */
  matcher: RegExp | null;
  /**
   * Candidate marker characters where every alias in this index contains at
   * least one member of the list. When present, text without a syntactically
   * viable marker cannot contain a mention, so streaming prose can bypass the
   * large compiled matcher entirely.
   */
  requiredMarkerCharacters: string[] | null;
}

export type InvocableMentionPiece =
  | { type: 'text'; text: string }
  | {
      type: 'mention';
      text: string;
      target: InvocableMentionTarget;
    };

function normalizeAlias(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function addAlias(aliases: Set<string>, value: string | undefined): void {
  const alias = value?.trim();
  if (!alias) return;
  aliases.add(alias);
}

function aliasesForEntry(entry: InvocableInventoryEntry): string[] {
  const aliases = new Set<string>();
  const invocation = entry.invocationKey.trim();

  addAlias(aliases, entry.displayName);
  addAlias(aliases, invocation);
  addAlias(aliases, entry.insertText.trim());

  const withoutProviderPrefix = invocation.replace(/^[$/]/, '');
  if (withoutProviderPrefix.includes(':')) {
    addAlias(aliases, withoutProviderPrefix);
  }

  if (entry.enableRef.kind === 'plugin') {
    addAlias(aliases, `${entry.enableRef.pluginName}:${entry.name}`);
    if (entry.sourceName) {
      addAlias(aliases, `${entry.enableRef.pluginName}:${entry.sourceName}`);
    }
  }

  return Array.from(aliases).sort((left, right) => {
    if (right.length !== left.length) return right.length - left.length;
    return left.localeCompare(right);
  });
}

// Characters that count as part of a token. Mentions only match on token
// boundaries, not inside larger identifiers.
const TOKEN_CHAR_CLASS = '[A-Za-z0-9_$:./-]';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile all aliases into one global, case-sensitive regex. `sortedAliases` is
 * longest-first, so the alternation prefers the longest alias matching at a
 * given position, mirroring the previous longest-match loop. Lookarounds
 * enforce the same token boundaries as the old `matchesAt` check.
 */
function buildMentionMatcher(sortedAliases: readonly string[]): RegExp | null {
  if (sortedAliases.length === 0) return null;
  const pattern = sortedAliases.map(escapeRegExp).join('|');
  return new RegExp(
    `(?<!${TOKEN_CHAR_CLASS})(?:${pattern})(?!${TOKEN_CHAR_CLASS})`,
    'g',
  );
}

const INVOCABLE_MARKER_CHARACTERS = ['/', '$', ':'] as const;
const TOKEN_QUALIFIED_COLON = /[A-Za-z0-9_$./-]:[A-Za-z0-9_$./-]/;

function requiredMarkerCharacters(
  sortedAliases: readonly string[],
): string[] | null {
  const markers = new Set<string>();
  for (const alias of sortedAliases) {
    const aliasMarkers = INVOCABLE_MARKER_CHARACTERS.filter((marker) =>
      marker === ':'
        ? TOKEN_QUALIFIED_COLON.test(alias)
        : alias.includes(marker),
    );
    if (aliasMarkers.length === 0) return null;
    for (const marker of aliasMarkers) markers.add(marker);
  }
  return Array.from(markers);
}

function hasPossibleInvocableMarker(
  text: string,
  markers: readonly string[],
): boolean {
  for (const marker of markers) {
    if (marker === ':') {
      if (TOKEN_QUALIFIED_COLON.test(text)) return true;
    } else if (text.includes(marker)) {
      return true;
    }
  }
  return false;
}

function targetPriority(entry: InvocableInventoryEntry): number {
  const providerPriority =
    entry.provider === 'codex' ? 0 : entry.provider === 'claude' ? 1 : 2;
  const kindPriority =
    entry.kind === 'plugin_command' ? 0 : entry.kind === 'plugin_skill' ? 1 : 2;
  return providerPriority * 10 + kindPriority;
}

export function buildInvocableMentionIndex(
  entries: readonly InvocableInventoryEntry[],
): InvocableMentionIndex {
  const targets = entries
    .slice()
    .sort((left, right) => {
      const priority = targetPriority(left) - targetPriority(right);
      if (priority !== 0) return priority;
      return left.invocationKey.localeCompare(right.invocationKey);
    })
    .map<InvocableMentionTarget>((entry) => ({
      entry,
      label: entry.displayName || entry.invocationKey || entry.name,
      aliases: aliasesForEntry(entry),
    }));

  const aliases = new Map<string, InvocableMentionTarget>();
  for (const target of targets) {
    for (const alias of target.aliases) {
      const key = normalizeAlias(alias);
      if (!aliases.has(key)) {
        aliases.set(key, target);
      }
    }
  }

  const sortedAliases = Array.from(aliases.keys()).sort((left, right) => {
    if (right.length !== left.length) return right.length - left.length;
    return left.localeCompare(right);
  });

  return {
    targets,
    aliases,
    sortedAliases,
    matcher: buildMentionMatcher(sortedAliases),
    requiredMarkerCharacters: requiredMarkerCharacters(sortedAliases),
  };
}

const indexByEntries = new WeakMap<
  readonly InvocableInventoryEntry[],
  InvocableMentionIndex
>();

/**
 * The index for one inventory list, built once per list. Every transcript reads
 * the same cached list, so a chat that mounts (a chat or worktree switch) reuses
 * the index instead of sorting and compiling it again.
 */
export function invocableMentionIndexFor(
  entries: readonly InvocableInventoryEntry[],
): InvocableMentionIndex {
  const cached = indexByEntries.get(entries);
  if (cached) return cached;
  const built = buildInvocableMentionIndex(entries);
  indexByEntries.set(entries, built);
  return built;
}

/**
 * Resolves a bare skill or command name (as a `Skill` tool call reports it)
 * to its inventory target: the supplied alias first, then `/name`, then
 * `$name`. Each lookup uses the index's established alias precedence, so an
 * ambiguous name resolves the same way a typed mention does. Returns `null`
 * rather than guessing when the index does not know the name.
 */
export function findInvocableMentionTarget(
  index: InvocableMentionIndex | null | undefined,
  name: string,
): InvocableMentionTarget | null {
  if (!index) return null;
  const alias = normalizeAlias(name);
  if (!alias) return null;
  const direct = index.aliases.get(alias);
  if (direct) return direct;
  if (alias.startsWith('/') || alias.startsWith('$')) return null;
  return (
    index.aliases.get(`/${alias}`) ?? index.aliases.get(`$${alias}`) ?? null
  );
}

// Per-index memo of split results keyed by the source text. The markdown
// renderer decorates the same text repeatedly (once per markdown element and on
// every re-render, including the inventory-changed cascade), so caching keeps
// those repeats O(1). Keyed by index identity via a WeakMap, so replacing the
// index (entries changed) drops the stale cache for GC.
const splitCache = new WeakMap<
  InvocableMentionIndex,
  Map<string, InvocableMentionPiece[]>
>();
const SPLIT_CACHE_MAX_ENTRIES = 4096;

export function splitTextByInvocableMentions(
  text: string,
  index: InvocableMentionIndex | null | undefined,
): InvocableMentionPiece[] {
  if (
    !index ||
    !index.matcher ||
    index.aliases.size === 0 ||
    text.length === 0
  ) {
    return [{ type: 'text', text }];
  }

  if (
    index.requiredMarkerCharacters &&
    !hasPossibleInvocableMarker(text, index.requiredMarkerCharacters)
  ) {
    return [{ type: 'text', text }];
  }

  let cache = splitCache.get(index);
  if (cache) {
    const cached = cache.get(text);
    if (cached) return cached;
  } else {
    cache = new Map();
    splitCache.set(index, cache);
  }

  const matcher = index.matcher;
  matcher.lastIndex = 0;
  const pieces: InvocableMentionPiece[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const alias = match[0];
    if (match.index > lastIndex) {
      pieces.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }
    const target = index.aliases.get(alias);
    if (target) {
      pieces.push({ type: 'mention', text: alias, target });
    } else {
      pieces.push({ type: 'text', text: alias });
    }
    lastIndex = match.index + alias.length;
    // Defensive guard against a zero-length match stalling the loop; aliases are
    // always non-empty, so this should never trigger.
    if (matcher.lastIndex === match.index) {
      matcher.lastIndex += 1;
    }
  }
  if (lastIndex < text.length) {
    pieces.push({ type: 'text', text: text.slice(lastIndex) });
  }

  const result: InvocableMentionPiece[] =
    pieces.length > 0 ? pieces : [{ type: 'text', text }];

  if (cache.size >= SPLIT_CACHE_MAX_ENTRIES) cache.clear();
  cache.set(text, result);
  return result;
}
