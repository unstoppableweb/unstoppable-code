import { normalizeMemoryText } from './text';

// One definition of "the same topic" for every local memory decision that
// compares topic names: usage rows and their lookups, auto-prune, snapshot
// restore and its cleanup, rebuild clearing, chat history profile
// preservation, and index-link resolution.
//
// macOS and Windows default to case-insensitive filesystems, where
// `topics/Build.md` and `topics/build.md` name one file. A comparison that
// keeps case can therefore record usage under a key no lookup finds, or
// delete a file it just wrote under another spelling. Identity is always
// case-folded; reads and writes keep the real on-disk filename. On a
// case-sensitive filesystem folding can only merge two names, never split
// one, so it can keep a file that might otherwise go, never lose one.

const TOPICS_PREFIX = 'topics/';
const MARKDOWN_EXTENSION = '.md';

/** Identity of a `topics/` filename such as `Build.md`. */
export function topicIdentity(filename: string): string {
  return filename.toLowerCase();
}

/**
 * Identity of a scope-relative memory file key. `topics/<name>` keys fold
 * the folder and the name; every other key (inbox notes, imports, MEMORY.md)
 * is returned unchanged, since those names are generated and never
 * respelled.
 */
export function memoryFileIdentity(fileKey: string): string {
  if (
    fileKey.length > TOPICS_PREFIX.length &&
    fileKey.slice(0, TOPICS_PREFIX.length).toLowerCase() === TOPICS_PREFIX
  ) {
    return `${TOPICS_PREFIX}${topicIdentity(fileKey.slice(TOPICS_PREFIX.length))}`;
  }
  return fileKey;
}

/** The identity of a topic filename as a scope-relative file key. */
export function topicFileKeyIdentity(filename: string): string {
  return `${TOPICS_PREFIX}${topicIdentity(filename)}`;
}

/**
 * Every topic a scope holds, as the scope itself lists them. A run's input
 * carries only as many topics as its budget fits, so it can never say what
 * else is there: a write policy or an index-link resolution built from the
 * input would treat a topic left out of the prompt as one that does not
 * exist, and replace or fail to link saved memory the helper never read.
 */
export interface ScopeTopicInventory {
  /** The `topics/` filenames the store lists, so a reference resolves. */
  readonly names: readonly string[];
  /**
   * Identities of every `topics/` entry a generated filename would replace.
   * A superset of {@link names}: an entry the store does not list still holds
   * its name on disk.
   */
  readonly identities: ReadonlySet<string>;
}

/**
 * Normalize a topic name to the stem the store reads and lists. Consolidation
 * output validation enforces the same round-trip contract: only filenames
 * whose stem satisfies `normalizeTopicName(stem) === stem` are reachable
 * through the store's topic listing and reads.
 */
export function normalizeTopicName(topic: string): string | undefined {
  const normalized = normalizeMemoryText(topic);
  if (normalized.includes('/') || normalized.includes('\\')) return undefined;
  const name = normalized.replace(/\.md$/i, '');
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
  ) {
    return undefined;
  }
  return name;
}

/** Whether the store lists a topic under `filename`, so a link resolves. */
export function isListedTopicName(filename: string): boolean {
  if (!filename.endsWith(MARKDOWN_EXTENSION)) return false;
  const stem = filename.slice(0, -MARKDOWN_EXTENSION.length);
  return normalizeTopicName(stem) === stem;
}

/**
 * The inventory of a scope whose listed topics are everything it holds, such
 * as a cloud scope's documents: every name is an entry and every entry has a
 * name. A store that can hold entries it does not list reports both sets.
 */
export function scopeTopicInventory(
  filenames: Iterable<string>,
): ScopeTopicInventory {
  const all = [...filenames];
  return {
    names: all.filter(isListedTopicName),
    identities: new Set(all.map(topicIdentity)),
  };
}
