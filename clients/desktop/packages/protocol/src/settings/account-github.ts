// ---------------------------------------------------------------------------
// Moved verbatim from `apps/web/src/lib/github/cloud-connection-contracts.ts`,
// which re-exports every symbol here. The personal GitHub-for-cloud settings
// card on web and desktop reads these DTOs through the hosted settings table.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// "GitHub for cloud" browser contract (REG-3020).
//
// Browser-safe: no server, Node or Prisma imports. These DTOs are what the
// Cloud routes return and what the client parses with the runtime guards
// below. They carry no internal user or database id, token, nonce, Core
// project-source id, or raw provider message. GitHub ids stay decimal strings
// (they can exceed what a JSON number represents safely).
//
// The connection state describes the user's consent plus whether at least one
// installation is eligible; `readyForProjects` additionally requires a target
// verified and adopted for the current evidence generation. Neither is a
// repository write grant: callers re-verify the selected repository and the
// operation-specific permission immediately before issuing one.
// ---------------------------------------------------------------------------

export const GITHUB_CLOUD_CONNECTION_STATES = [
  'DISCONNECTED',
  'NEEDS_REAUTH',
  'NEEDS_INSTALL',
  'ACTIVE',
] as const;
export type GitHubCloudConnectionState =
  (typeof GITHUB_CLOUD_CONNECTION_STATES)[number];

export const GITHUB_CLOUD_TARGET_STATES = [
  'ACTIVE',
  'PENDING_ADOPTION',
  'NEEDS_APPROVAL',
  'SUSPENDED',
  'REMOVED',
] as const;
export type GitHubCloudTargetState =
  (typeof GITHUB_CLOUD_TARGET_STATES)[number];

/**
 * What a Connect asks for once GitHub sign-in is linked:
 * - `connect`: finish, or offer the App install when none is usable.
 * - `install`: always offer the App install (another account).
 * - `identity`: finish as soon as the GitHub identity is linked, whatever the
 *   install state (review approvals need only the linked account).
 */
export const GITHUB_CLOUD_CONNECT_INTENTS = [
  'connect',
  'install',
  'identity',
] as const;
export type GitHubCloudConnectIntent =
  (typeof GITHUB_CLOUD_CONNECT_INTENTS)[number];

export interface GitHubCloudTargetDto {
  /** The target's public external id (UUID), never the database id. */
  id: string;
  /** Canonical positive decimal GitHub installation id. */
  installationId: string;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  repositorySelection: 'all' | 'selected';
  state: GitHubCloudTargetState;
}

export interface GitHubCloudConnectionDto {
  state: GitHubCloudConnectionState;
  githubLogin: string | null;
  /** ISO-8601 time of the last published verification evidence. */
  verifiedAt: string | null;
  readyForProjects: boolean;
  targets: GitHubCloudTargetDto[];
}

export type GitHubCloudConnectResponse = {
  connection: GitHubCloudConnectionDto;
} & (
  | { next: 'link' | 'reauth'; continuationGeneration: number }
  | { next: 'done' }
  | { next: 'install'; installUrl: string }
);

/**
 * Whether the user can ask GitHub to create a repository under one
 * installation's account (REG-3021). Deliberately separate from
 * `GitHubCloudTargetDto.state` and `readyForProjects`, which describe using
 * existing repositories: creation needs all-repositories coverage and an
 * action-specific grant the global Connect minimum does not require.
 *
 * - READY: every precondition the server can check holds. Not a promise that
 *   GitHub (for example an organization's policy) will accept the create.
 * - NEEDS_APPROVAL: the creation grant is missing; approve it on GitHub.
 * - NEEDS_INSTALL: the installation cannot create here (selected-repositories
 *   coverage, suspended or gone); fix the installation on GitHub.
 * - OWNER_MISMATCH: a personal account that is not the signed-in GitHub user.
 */
export const GITHUB_REPOSITORY_CREATION_CAPABILITY_STATES = [
  'READY',
  'NEEDS_APPROVAL',
  'NEEDS_INSTALL',
  'OWNER_MISMATCH',
] as const;
export type GitHubRepositoryCreationCapabilityState =
  (typeof GITHUB_REPOSITORY_CREATION_CAPABILITY_STATES)[number];

export interface GitHubRepositoryCreationCapabilityDto {
  /** Canonical positive decimal GitHub installation id. */
  installationId: string;
  state: GitHubRepositoryCreationCapabilityState;
  /** ISO-8601 time the fresh installation evidence was read. */
  checkedAt: string;
}

interface CreationCapabilityPresentation {
  readonly label: string;
  /** Why creation is unavailable and where to fix it; null when READY. */
  readonly hint: string | null;
}

/** Fixed copy for each capability state; never text from a response. */
export const GITHUB_REPOSITORY_CREATION_CAPABILITY_PRESENTATION: Readonly<
  Record<
    GitHubRepositoryCreationCapabilityState,
    CreationCapabilityPresentation
  >
> = {
  READY: { label: 'Ready', hint: null },
  NEEDS_APPROVAL: {
    label: 'Permission needed',
    hint: 'Creating repositories needs an extra app permission for this account. Approve it on GitHub, then check again.',
  },
  NEEDS_INSTALL: {
    label: 'Access needed',
    hint: 'Creating repositories needs the app installed with access to all repositories. Update it on GitHub, then check again.',
  },
  OWNER_MISMATCH: {
    label: 'Another account',
    hint: 'This personal account belongs to someone else. Choose your own account or an organization.',
  },
};

const DECIMAL_ID = /^[1-9][0-9]{0,18}$/;
/** The signed 64-bit ceiling GitHub ids are stored under (web and Core). */
const MAX_GITHUB_ID = BigInt('9223372036854775807');
const MAX_TEXT_LENGTH = 255;

/**
 * A canonical GitHub id: a positive decimal string without sign, padding or
 * leading zero, within the signed 64-bit range. Numbers are refused because
 * JSON numbers lose precision above 2^53.
 */
export function isCanonicalGitHubId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    DECIMAL_ID.test(value) &&
    BigInt(value) <= MAX_GITHUB_ID
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return values.some((candidate) => candidate === value);
}

function isText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TEXT_LENGTH
  );
}

function isIsoTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function isGitHubCloudConnectIntent(
  value: unknown,
): value is GitHubCloudConnectIntent {
  return isOneOf(GITHUB_CLOUD_CONNECT_INTENTS, value);
}

/** A concurrency fence, not a credential or grant of cloud consent. */
export function isGitHubCloudContinuationGeneration(
  value: unknown,
): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isGitHubCloudTargetDto(
  value: unknown,
): value is GitHubCloudTargetDto {
  return (
    isRecord(value) &&
    isText(value.id) &&
    typeof value.installationId === 'string' &&
    DECIMAL_ID.test(value.installationId) &&
    isText(value.accountLogin) &&
    isOneOf(['User', 'Organization'], value.accountType) &&
    isOneOf(['all', 'selected'], value.repositorySelection) &&
    isOneOf(GITHUB_CLOUD_TARGET_STATES, value.state)
  );
}

function readTargets(value: unknown): GitHubCloudTargetDto[] | null {
  if (!Array.isArray(value)) return null;
  const entries: readonly unknown[] = value;
  const targets: GitHubCloudTargetDto[] = [];
  for (const entry of entries) {
    if (!isGitHubCloudTargetDto(entry)) return null;
    targets.push(entry);
  }
  return targets;
}

/**
 * Validates a connection DTO, including its readiness invariant: a connection
 * is ready for projects only while `ACTIVE` with at least one `ACTIVE` target.
 */
export function isGitHubCloudConnectionDto(
  value: unknown,
): value is GitHubCloudConnectionDto {
  if (!isRecord(value)) return false;
  const targets = readTargets(value.targets);
  if (
    targets === null ||
    !isOneOf(GITHUB_CLOUD_CONNECTION_STATES, value.state) ||
    !(value.githubLogin === null || isText(value.githubLogin)) ||
    !(value.verifiedAt === null || isIsoTimestamp(value.verifiedAt)) ||
    typeof value.readyForProjects !== 'boolean'
  ) {
    return false;
  }
  return (
    !value.readyForProjects ||
    (value.state === 'ACTIVE' &&
      targets.some((target) => target.state === 'ACTIVE'))
  );
}

/** Additive response fields are tolerated, like the other DTO guards. */
export function isGitHubRepositoryCreationCapabilityDto(
  value: unknown,
): value is GitHubRepositoryCreationCapabilityDto {
  return (
    isRecord(value) &&
    isCanonicalGitHubId(value.installationId) &&
    isOneOf(GITHUB_REPOSITORY_CREATION_CAPABILITY_STATES, value.state) &&
    isIsoTimestamp(value.checkedAt)
  );
}

function isGitHubInstallUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com';
  } catch {
    return false;
  }
}

export function isGitHubCloudConnectResponse(
  value: unknown,
): value is GitHubCloudConnectResponse {
  if (!isRecord(value) || !isGitHubCloudConnectionDto(value.connection)) {
    return false;
  }
  if (value.next === 'install') return isGitHubInstallUrl(value.installUrl);
  if (value.installUrl !== undefined) return false;
  if (value.next === 'link' || value.next === 'reauth') {
    return isGitHubCloudContinuationGeneration(value.continuationGeneration);
  }
  return value.next === 'done';
}
