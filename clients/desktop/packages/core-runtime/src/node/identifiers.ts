/** A caller-supplied identifier failed {@link validateId}. */
export class IdentifierValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IdentifierValidationError';
  }
}

const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** The workspace, worktree and repository id charset. */
export function validateId(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !value || !SAFE_ID_RE.test(value)) {
    throw new IdentifierValidationError(
      `Invalid ${label}: must be lowercase alphanumeric with hyphens`,
    );
  }
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/** `baseId`, or the first free `baseId-<n>` from 2. */
export function uniqueId(baseId: string, existingIds: Set<string>): string {
  if (!existingIds.has(baseId)) return baseId;
  let n = 2;
  while (existingIds.has(`${baseId}-${n}`)) n++;
  return `${baseId}-${n}`;
}

const SAFE_WORKSPACE_ID_MAX = 128;
const RESERVED_WORKSPACE_ID = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Portable new identities, distinct from accepted historical record keys. */
export function isSafeWorkspaceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
    !RESERVED_WORKSPACE_ID.test(value)
  );
}

export function safeWorkspaceIdBase(name: string): string {
  const base = (slugify(name) || 'workspace').slice(0, SAFE_WORKSPACE_ID_MAX);
  return RESERVED_WORKSPACE_ID.test(base) ? `${base}-2` : base;
}

/** Leave room for uniqueness suffixes without exceeding the allocation cap. */
function safeWorkspaceIdCandidate(base: string, suffix: number): string {
  const ending = suffix === 1 ? '' : `-${suffix}`;
  return `${base.slice(0, SAFE_WORKSPACE_ID_MAX - ending.length)}${ending}`;
}

export function allocateSafeWorkspaceId(
  name: string,
  existingIds: ReadonlySet<string>,
): string {
  const taken = new Set(Array.from(existingIds, (id) => id.toLowerCase()));
  const base = safeWorkspaceIdBase(name);
  let suffix = 1;
  let candidate = base;
  while (taken.has(candidate.toLowerCase())) {
    candidate = safeWorkspaceIdCandidate(base, ++suffix);
  }
  return candidate;
}
