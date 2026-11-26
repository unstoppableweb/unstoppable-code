import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';

/** Deletion authority is fully qualified, lexical and case-preserving. */
export function pluginCopyPathIdentity(value: string): string | undefined {
  const windows = hostOperatingSystem() === 'win32';
  if (
    windows
      ? !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(value)
      : !path.posix.isAbsolute(value)
  )
    return undefined;
  const normalized = windows
    ? path.win32.normalize(value).replace(/\\/g, '/')
    : path.posix.normalize(value);
  return /^(?:\/|[a-z]:\/)$/i.test(normalized)
    ? normalized
    : normalized.replace(/\/$/, '');
}

export function pluginCopyProtectionIdentity(value: string): string {
  // Case folding can only keep extra copies, never authorize their deletion.
  const os = hostOperatingSystem();
  return os === 'win32' || os === 'darwin' ? value.toLowerCase() : value;
}

export function isPluginCopyPathWithin(
  parent: string,
  candidate: string,
): boolean {
  return (
    candidate === parent ||
    candidate.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// At least a 32,767-unit Windows path tripled by percent-encoding.
const maxReferenceCharacters = 131_072;

/** Charged per string before classification; exhaustion is unmappable evidence. */
interface ReferenceBudget {
  characters: number;
}

/** A prefix check only: an over-cap string is never normalized. */
function isPathShaped(value: string): boolean {
  return (
    /^file:/i.test(value) ||
    (hostOperatingSystem() === 'win32' ? /^(?:[a-z]:)?[\\/]/i : /^\//).test(
      value,
    )
  );
}

/** URL decoding adds protection only; null means an unmappable local source. */
function referenceIdentity(value: string): string | undefined | null {
  if (!/^file:/i.test(value)) return pluginCopyPathIdentity(value);
  const windows = hostOperatingSystem() === 'win32';
  try {
    // Git keeps raw path bytes that WHATWG trims, removes or treats as syntax.
    // Surrogates sit above the class, so astral characters stay literal.
    const literal = value.replace(
      // eslint-disable-next-line no-control-regex -- escapes raw control bytes
      windows ? /[\u0000- #?]/g : /[\u0000- #?\\]/g,
      (character) => encodeURIComponent(character),
    );
    // Decode separators before parsing: WHATWG otherwise collapses
    // "%2Fchild/.." as one segment, losing part of Git's resolved path.
    const decoded = literal.replace(windows ? /%2f|%5c/gi : /%2f/gi, '/');
    return pluginCopyPathIdentity(fileURLToPath(new URL(decoded))) ?? null;
  } catch {
    return null;
  }
}

/** Text is retention evidence only: never resolve it or perform I/O from it. */
function* documentReferences(
  document: unknown,
  currentIndex = false,
): Generator<string> {
  const pending: unknown[] = [document];
  const visited = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') yield value;
    else if (
      typeof value === 'object' &&
      value !== null &&
      !visited.has(value)
    ) {
      visited.add(value);
      if (Array.isArray(value)) {
        const entries: unknown[] = value;
        for (const entry of entries) pending.push(entry);
      } else if (isRecord(value)) {
        for (const [key, entry] of Object.entries(value)) {
          if (currentIndex && value === document && key === 'retired') continue;
          yield key;
          pending.push(entry);
        }
      }
    }
  }
}

function protectionText(value: string): string {
  // Decode each byte independently: malformed escapes/UTF-8 cannot hide ASCII names.
  return value
    .replace(/%([0-9a-f]{2})/gi, (_match, hex: string): string =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .toLowerCase();
}

function textProtectsCopy(candidate: string, texts: Iterable<string>): boolean {
  const name = path.basename(candidate).toLowerCase();
  if (!name) return false;
  for (const text of texts) if (text.includes(name)) return true;
  return false;
}

/** One retention interpretation for current evidence and process history. */
function* classifiedReferences(
  document: unknown,
  budget: ReferenceBudget,
  currentIndex = false,
): Generator<{
  identity: string | undefined | null;
  raw: string;
  decoded: string;
}> {
  for (const value of documentReferences(document, currentIndex)) {
    budget.characters -= value.length;
    const overCap = value.length > maxReferenceCharacters;
    if (budget.characters < 0 || (overCap && isPathShaped(value))) {
      yield { identity: null, raw: '', decoded: '' };
      return;
    }
    yield {
      // Too long to name a real path: other text, such as a data: URL logo, only protects textually.
      identity: overCap ? undefined : referenceIdentity(value),
      raw: value.toLowerCase(),
      decoded: protectionText(value),
    };
  }
}

function isWithinAny(sortedKeys: readonly string[], key: string): boolean {
  const prefix = key.endsWith('/') ? key : `${key}/`;
  let low = 0;
  let high = sortedKeys.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sortedKeys[middle] < prefix) low = middle + 1;
    else high = middle;
  }
  return sortedKeys[low]?.startsWith(prefix) === true;
}

/** Every key `isPluginCopyPathWithin(key, value)` accepts. */
function ancestorsOrSelf(value: string): string[] {
  const keys = [value];
  for (let index = value.indexOf('/'); index >= 0; ) {
    if (index > 0 && value[index - 1] !== '/') keys.push(value.slice(0, index));
    keys.push(value.slice(0, index + 1));
    index = value.indexOf('/', index + 1);
  }
  return keys;
}

const copyToken = /-(?=[0-9a-f]{8})/g;

/** Precomputed once per sweep: protection must not renormalize every reference per candidate. */
export function pluginCopyReferenceCollector({
  maxTokenOccurrences = 100_000,
}: { maxTokenOccurrences?: number } = {}): {
  readonly uncertain: boolean;
  collect: (document: unknown, currentIndex?: boolean) => void;
  protects: (candidate: string) => boolean;
} {
  const pathKeys = new Set<string>();
  let sortedPathKeys: string[] | undefined;
  const texts = new Set<string>();
  // "-" plus eight hex digits -> each text and offset where that token starts.
  const tokens = new Map<string, Array<{ text: string; offset: number }>>();
  let tokenOccurrences = 0;
  let uncertain = false;
  // One sweep's current evidence, read once per refresh.
  const budget: ReferenceBudget = { characters: 64 * 1024 * 1024 };
  /** False once the record cap is reached: the character budget alone admits millions. */
  const indexText = (text: string): boolean => {
    if (texts.has(text)) return true;
    texts.add(text);
    for (const match of text.matchAll(copyToken)) {
      tokenOccurrences += 1;
      if (tokenOccurrences > maxTokenOccurrences) return false;
      const token = text.slice(match.index, match.index + 9);
      const occurrences = tokens.get(token) ?? [];
      occurrences.push({ text, offset: match.index });
      tokens.set(token, occurrences);
    }
    return true;
  };
  const textProtects = (candidate: string): boolean => {
    const name = path.basename(candidate).toLowerCase();
    const token = name.slice(-9);
    if (name.length <= 9 || !/^-[0-9a-f]{8}$/.test(token))
      return textProtectsCopy(candidate, texts);
    const prefix = name.slice(0, -9);
    return (tokens.get(token) ?? []).some(
      ({ text, offset }) =>
        offset >= prefix.length &&
        text.startsWith(prefix, offset - prefix.length),
    );
  };
  const pathProtects = (candidate: string): boolean => {
    const identity = pluginCopyPathIdentity(candidate);
    if (!identity) return false;
    const key = pluginCopyProtectionIdentity(identity);
    sortedPathKeys ??= Array.from(pathKeys).sort();
    return (
      pathKeys.has(key) ||
      isWithinAny(sortedPathKeys, key) ||
      ancestorsOrSelf(key).some((ancestor) => pathKeys.has(ancestor))
    );
  };
  return {
    get uncertain(): boolean {
      return uncertain;
    },
    protects: (candidate): boolean =>
      uncertain || textProtects(candidate) || pathProtects(candidate),
    collect: (document, currentIndex = false): void => {
      if (uncertain) return;
      sortedPathKeys = undefined;
      for (const { identity, raw, decoded } of classifiedReferences(
        document,
        budget,
        currentIndex,
      )) {
        if (identity === null) {
          uncertain = true;
          return;
        }
        if (identity) {
          const referencePath = pluginCopyPathIdentity(identity);
          if (referencePath)
            pathKeys.add(pluginCopyProtectionIdentity(referencePath));
        }
        if (!indexText(raw) || !indexText(decoded)) {
          // Partial evidence: release it and leak this cycle's copies.
          uncertain = true;
          pathKeys.clear();
          texts.clear();
          tokens.clear();
          return;
        }
      }
    },
  };
}

// Catalog snapshots can outlive the file that served them. Leak until restart.
const managedCopyToken = /-[0-9a-f]{8}/i;
const observed = new Set<string>();
const observedPaths = new Set<string>();
let observedCharacters = 0;
let observedFull = false;

export function observePluginCopyReferences(
  document: unknown,
  managedRoot: string,
): void {
  if (observedFull) return;
  const remember = (key: string): boolean => {
    if (observed.has(key)) return true;
    // Never evict live evidence to make room for new observations.
    if (
      observed.size >= 10_000 ||
      observedCharacters + key.length > 1_000_000
    ) {
      observedFull = true;
      observed.clear();
      observedPaths.clear();
      return false;
    }
    observed.add(key);
    observedCharacters += key.length;
    return true;
  };
  const budget: ReferenceBudget = { characters: 16 * 1024 * 1024 };
  for (const { identity, raw, decoded } of classifiedReferences(
    document,
    budget,
  )) {
    if (identity === null) {
      observedFull = true;
      observed.clear();
      observedPaths.clear();
      return;
    }
    if (identity && overlapsPluginCopyReferences(managedRoot, [identity])) {
      const key = pluginCopyProtectionIdentity(identity);
      if (!remember(key)) return;
      observedPaths.add(key);
    }
    // Classify tokenless ancestors first; ordinary text must not exhaust history.
    if (!managedCopyToken.test(decoded)) continue;
    if (!remember(raw) || !remember(decoded)) return;
  }
}

export function overlapsPluginCopyReferences(
  candidate: string,
  references: Iterable<string>,
): boolean {
  const identity = pluginCopyPathIdentity(candidate);
  if (!identity) return false;
  const key = pluginCopyProtectionIdentity(identity);
  for (const reference of references) {
    const referencePath = pluginCopyPathIdentity(reference);
    if (!referencePath) continue;
    const ref = pluginCopyProtectionIdentity(referencePath);
    if (isPluginCopyPathWithin(key, ref) || isPluginCopyPathWithin(ref, key))
      return true;
  }
  return false;
}

export function isObservedPluginCopy(candidate: string): boolean {
  return (
    observedFull ||
    textProtectsCopy(candidate, observed) ||
    overlapsPluginCopyReferences(candidate, observedPaths)
  );
}
