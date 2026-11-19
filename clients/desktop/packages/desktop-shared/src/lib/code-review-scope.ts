/**
 * Code Review chat scope keys: the sentinel scope's `worktreeId`, which is
 * also the chat-storage identity of its review chats (CAN-6848 PR 4).
 *
 * Version 2 (current): `cr2`, then `-1` before each of projectId and
 * worktreeId, with every `-` inside an id written as `-0`. For example
 * `(a--b, c)` is `cr2-1a-0-0b-1c` and `(a, b--c)` is `cr2-1a-1b-0-0c`. The
 * encoding is injective, satisfies `validateId`, and never contains `--`, so
 * it cannot equal a version 1 key.
 *
 * Version 1 (historical, never built again): `${projectId}--${worktreeId}`.
 * Ids may contain `--`, so different targets can share one version 1 key.
 * Existing version 1 registry rows and their chats keep that key as their
 * storage identity; nothing renames them.
 *
 * Changing either format orphans persisted registry rows and chats.
 */
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;
const V2_PREFIX = 'cr2';
const V2_SEPARATOR = '-1';
const V2_HYPHEN = '-0';

export interface CodeReviewScopeTarget {
  projectId: string;
  worktreeId: string;
}

export type CodeReviewScopeKeyIdentity =
  | { version: 2; target: CodeReviewScopeTarget }
  /** Every target the historical builder maps to this key. */
  | { version: 1; candidates: CodeReviewScopeTarget[] }
  | { version: null };

export function buildCodeReviewScopeKey(
  projectId: string,
  worktreeId: string,
): string {
  if (!SAFE_ID.test(projectId) || !SAFE_ID.test(worktreeId))
    throw new Error('Code review scope ids must be valid ids.');
  const escape = (id: string): string => id.split('-').join(V2_HYPHEN);
  return `${V2_PREFIX}${V2_SEPARATOR}${escape(projectId)}${V2_SEPARATOR}${escape(worktreeId)}`;
}

export function parseCodeReviewScopeKey(
  scopeKey: string,
): CodeReviewScopeKeyIdentity {
  const target = parseVersion2(scopeKey);
  if (target) return { version: 2, target };
  const candidates = legacyCandidates(scopeKey);
  return candidates.length > 0 ? { version: 1, candidates } : { version: null };
}

function parseVersion2(scopeKey: string): CodeReviewScopeTarget | null {
  const prefix = `${V2_PREFIX}${V2_SEPARATOR}`;
  if (!scopeKey.startsWith(prefix)) return null;
  const parts: string[] = [];
  let current = '';
  for (let index = prefix.length; index < scopeKey.length; index += 1) {
    const char = scopeKey.charAt(index);
    if (char !== '-') {
      current += char;
      continue;
    }
    const marker = scopeKey.slice(index, index + 2);
    if (marker === V2_HYPHEN) current += '-';
    else if (marker === V2_SEPARATOR) {
      parts.push(current);
      current = '';
    } else return null;
    index += 1;
  }
  if (parts.length !== 1) return null;
  const projectId = parts[0] ?? '';
  return SAFE_ID.test(projectId) && SAFE_ID.test(current)
    ? { projectId, worktreeId: current }
    : null;
}

function legacyCandidates(scopeKey: string): CodeReviewScopeTarget[] {
  const candidates: CodeReviewScopeTarget[] = [];
  for (
    let index = scopeKey.indexOf('--');
    index !== -1;
    index = scopeKey.indexOf('--', index + 1)
  ) {
    const projectId = scopeKey.slice(0, index);
    const worktreeId = scopeKey.slice(index + 2);
    if (SAFE_ID.test(projectId) && SAFE_ID.test(worktreeId))
      candidates.push({ projectId, worktreeId });
  }
  return candidates;
}
