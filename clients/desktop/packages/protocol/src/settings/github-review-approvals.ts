// ---------------------------------------------------------------------------
// Code review approval policy: whether the GitHub App approves a pull request
// when a packaged code review passes. One model for both owners: an
// organization (set by its owners and admins) and a person (covering only
// repositories on their own GitHub account). Browser-safe.
//
// Six settings operations over three routes, built by one factory so both
// scopes share schemas and request shapes:
//   account.github.reviewApprovals.{read,update,repositories}
//   organization.github.reviewApprovals.{read,update,repositories}
// plus `account.github.reviewApprovals.readiness`: whether the signed-in
// person's passing reviews can approve in one repository under a run owner,
// which drives the "Link GitHub" calls to action.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import {
  defineSettingsRead,
  defineSettingsWrite,
  settingsPathWithQuery,
  type SettingsOperationDefinition,
  type SettingsOperationRequest,
} from './operation-definition';
import {
  GITHUB_REPOSITORY_QUERY_MAX_LENGTH,
  gitHubRepositoryPickerPageSchema,
} from './organization-repositories';
import { settingsRouteIdSchema } from './routes';

export type ReviewApprovalOwner =
  | {
      kind: 'organization';
      /** Organization external id. */ organizationId: string;
    }
  | { kind: 'personal' };

export interface ReviewApprovalRepository {
  /** GitHub's immutable repository id, as a canonical decimal string. */
  id: string;
  fullName: string;
}

export const REVIEW_APPROVAL_REPO_SCOPES = ['all', 'selected'] as const;
export type ReviewApprovalRepoScope =
  (typeof REVIEW_APPROVAL_REPO_SCOPES)[number];

export const REVIEW_APPROVAL_MIN_SCORE_MIN = 1;
export const REVIEW_APPROVAL_MIN_SCORE_MAX = 10;
export const REVIEW_APPROVAL_DEFAULT_MIN_SCORE = 8;
/** Most repositories one policy can select. */
export const REVIEW_APPROVAL_MAX_REPOSITORIES = 200;

export interface ReviewApprovalPolicy {
  enabled: boolean;
  /** Integer 1-10. */
  minScore: number;
  repoScope: ReviewApprovalRepoScope;
  /** Kept whatever `repoScope` is, so switching to All and back keeps it. */
  repositories: ReviewApprovalRepository[];
}

export const DEFAULT_REVIEW_APPROVAL_POLICY: ReviewApprovalPolicy = {
  enabled: false,
  minScore: REVIEW_APPROVAL_DEFAULT_MIN_SCORE,
  repoScope: 'all',
  repositories: [],
};

export interface ReviewApprovalPolicyReadResult {
  /** False while the rollout flag is off: render nothing. */
  available: boolean;
  policy: ReviewApprovalPolicy;
  /** GitHub login of the org installation or the person; null when not connected. */
  scopeLabel: string | null;
}

/** The whole policy, not a patch. The server resolves repository names. */
export interface ReviewApprovalPolicyUpdateInput {
  owner: ReviewApprovalOwner;
  enabled: boolean;
  minScore: number;
  repoScope: ReviewApprovalRepoScope;
  repositoryIds: string[];
}

/**
 * Server codes (`code` in the error body, `serverCode` on the settings error)
 * the policy routes answer with besides the generic settings failures.
 */
export const REVIEW_APPROVAL_POLICY_ERROR_CODES = [
  'unavailable',
  'not_connected',
  'invalid_repository',
] as const;
export type ReviewApprovalPolicyErrorCode =
  (typeof REVIEW_APPROVAL_POLICY_ERROR_CODES)[number];

/** A canonical positive decimal GitHub id (no leading zeros). */
export const ReviewApprovalRepositoryIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/);

export const ReviewApprovalOwnerSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('organization'),
    organizationId: settingsRouteIdSchema,
  }),
  z.strictObject({ kind: z.literal('personal') }),
]);

export const ReviewApprovalRepositorySchema = z.strictObject({
  id: ReviewApprovalRepositoryIdSchema,
  fullName: z.string().min(1).max(256),
});

export const ReviewApprovalMinScoreSchema = z
  .number()
  .int()
  .min(REVIEW_APPROVAL_MIN_SCORE_MIN)
  .max(REVIEW_APPROVAL_MIN_SCORE_MAX);

export const ReviewApprovalPolicySchema = z.strictObject({
  enabled: z.boolean(),
  minScore: ReviewApprovalMinScoreSchema,
  repoScope: z.enum(REVIEW_APPROVAL_REPO_SCOPES),
  repositories: z
    .array(ReviewApprovalRepositorySchema)
    .max(REVIEW_APPROVAL_MAX_REPOSITORIES),
});

export const ReviewApprovalPolicyReadResultSchema = z.strictObject({
  available: z.boolean(),
  policy: ReviewApprovalPolicySchema,
  scopeLabel: z.string().max(256).nullable(),
});

/**
 * Whole-policy update. Distinctness and the 200 bound are checked on the
 * distinct set, so the route refuses more than 200 distinct ids.
 */
export const ReviewApprovalPolicyUpdateInputSchema = z.strictObject({
  owner: ReviewApprovalOwnerSchema,
  enabled: z.boolean(),
  minScore: ReviewApprovalMinScoreSchema,
  repoScope: z.enum(REVIEW_APPROVAL_REPO_SCOPES),
  repositoryIds: z
    .array(ReviewApprovalRepositoryIdSchema)
    .max(REVIEW_APPROVAL_MAX_REPOSITORIES)
    .refine((ids) => new Set(ids).size === ids.length, 'duplicate id'),
});

/** The policy route, shared by both owners. */
export const REVIEW_APPROVAL_POLICY_PATH =
  '/api/v1/github/review-approval-policy';
export const REVIEW_APPROVAL_POLICY_REPOSITORIES_PATH = `${REVIEW_APPROVAL_POLICY_PATH}/repositories`;

/** The owner as GET query parameters. */
export function reviewApprovalOwnerQuery(
  owner: ReviewApprovalOwner,
): Record<string, string> {
  return owner.kind === 'organization'
    ? { owner: 'organization', organizationId: owner.organizationId }
    : { owner: 'personal' };
}

/**
 * Parse the owner from GET query parameters, or `null` when malformed. The
 * route answers a malformed owner as a bad request.
 */
export function parseReviewApprovalOwnerQuery(
  params: URLSearchParams,
): ReviewApprovalOwner | null {
  const owner = params.get('owner');
  const organizationId = params.get('organizationId');
  const candidate =
    owner === 'organization'
      ? { kind: 'organization', organizationId }
      : owner === 'personal' && organizationId === null
        ? { kind: 'personal' }
        : null;
  const parsed = ReviewApprovalOwnerSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// --- Readiness -------------------------------------------------------------

/**
 * Readiness states, in the order the server decides them:
 * - `unavailable`: the flag or Cloud Git is off, or the run owner isn't an
 *   organization the person can use (not a member, personal, no installation).
 * - `off`: a personal run owner, or the organization's policy is off.
 * - `not_covered`: the repository is outside the installation or the policy.
 * - `connect_github`: the person hasn't linked GitHub.
 * - `reconnect_github`: their linked GitHub account needs sign-in again.
 * - `ready`: linked; approvals still need write access, checked at publish.
 *
 * A client treats any other state as "show nothing": the result schema is
 * lenient so a later state can't break an older client.
 */
export const REVIEW_APPROVAL_READINESS_STATES = [
  'unavailable',
  'off',
  'not_covered',
  'connect_github',
  'reconnect_github',
  'ready',
] as const;
export type ReviewApprovalReadinessState =
  (typeof REVIEW_APPROVAL_READINESS_STATES)[number];

export function isReviewApprovalReadinessState(
  value: string,
): value is ReviewApprovalReadinessState {
  return (REVIEW_APPROVAL_READINESS_STATES as readonly string[]).includes(
    value,
  );
}

export interface ReviewApprovalReadiness {
  state: ReviewApprovalReadinessState;
  /**
   * The organization's display name, for the notice body. Null for
   * `unavailable` and for a personal run owner, so a non-member never learns
   * an organization's name or policy.
   */
  organizationName: string | null;
}

/** `personal`, or `org:<uuid>`: the run's execution owner, as `publish` takes it. */
export const ReviewApprovalRunOwnerSchema = z
  .string()
  .regex(
    /^(?:personal|org:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
  );

/** A GitHub owner or repository name (the `publish` operation's pattern). */
export const ReviewApprovalGitHubNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/);

export const ReviewApprovalReadinessInputSchema = z.strictObject({
  runOwner: ReviewApprovalRunOwnerSchema,
  repoOwner: ReviewApprovalGitHubNameSchema,
  repoName: ReviewApprovalGitHubNameSchema,
});
export type ReviewApprovalReadinessInput = z.infer<
  typeof ReviewApprovalReadinessInputSchema
>;

/** Lenient on purpose: unknown keys are dropped and any state string parses. */
export const ReviewApprovalReadinessResultSchema = z.object({
  state: z.string().max(64),
  organizationName: z.string().max(256).nullable(),
});
export type ReviewApprovalReadinessResult = z.infer<
  typeof ReviewApprovalReadinessResultSchema
>;

export const REVIEW_APPROVAL_READINESS_PATH =
  '/api/v1/github/review-approval-readiness';

/** The readiness input as GET query parameters. */
export function reviewApprovalReadinessQuery(
  input: ReviewApprovalReadinessInput,
): Record<string, string> {
  return {
    runOwner: input.runOwner,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
  };
}

/** Parse the readiness input from GET query parameters, or `null` when malformed. */
export function parseReviewApprovalReadinessQuery(
  params: URLSearchParams,
): ReviewApprovalReadinessInput | null {
  const parsed = ReviewApprovalReadinessInputSchema.safeParse({
    runOwner: params.get('runOwner'),
    repoOwner: params.get('repoOwner'),
    repoName: params.get('repoName'),
  });
  return parsed.success ? parsed.data : null;
}

const policyFields = {
  enabled: z.boolean(),
  minScore: ReviewApprovalMinScoreSchema,
  repoScope: z.enum(REVIEW_APPROVAL_REPO_SCOPES),
  repositoryIds: ReviewApprovalPolicyUpdateInputSchema.shape.repositoryIds,
};

const repositoryPageFields = {
  cursor: z.string().min(1).max(2048).optional(),
  query: z.string().max(GITHUB_REPOSITORY_QUERY_MAX_LENGTH).optional(),
};

const readResultSchema = ReviewApprovalPolicyReadResultSchema;

function readRequest(owner: ReviewApprovalOwner): SettingsOperationRequest {
  return {
    method: 'GET',
    path: settingsPathWithQuery(
      REVIEW_APPROVAL_POLICY_PATH,
      reviewApprovalOwnerQuery(owner),
    ),
  };
}

function updateRequest(
  owner: ReviewApprovalOwner,
  policy: Omit<ReviewApprovalPolicyUpdateInput, 'owner'>,
): SettingsOperationRequest {
  const body: ReviewApprovalPolicyUpdateInput = {
    owner,
    enabled: policy.enabled,
    minScore: policy.minScore,
    repoScope: policy.repoScope,
    repositoryIds: policy.repositoryIds,
  };
  return { method: 'PATCH', path: REVIEW_APPROVAL_POLICY_PATH, body };
}

function repositoriesRequest(
  owner: ReviewApprovalOwner,
  page: { cursor?: string; query?: string },
): SettingsOperationRequest {
  return {
    method: 'GET',
    path: settingsPathWithQuery(REVIEW_APPROVAL_POLICY_REPOSITORIES_PATH, {
      ...reviewApprovalOwnerQuery(owner),
      cursor: page.cursor,
      q: page.query === '' ? undefined : page.query,
    }),
  };
}

const accountReadInputSchema = z.strictObject({});
const accountUpdateInputSchema = z.strictObject(policyFields);
const accountRepositoriesInputSchema = z.strictObject(repositoryPageFields);

const organizationIdField = { organizationId: settingsRouteIdSchema };
const organizationReadInputSchema = z.strictObject(organizationIdField);
const organizationUpdateInputSchema = z.strictObject({
  ...organizationIdField,
  ...policyFields,
});
const organizationRepositoriesInputSchema = z.strictObject({
  ...organizationIdField,
  ...repositoryPageFields,
});

type ReadResultSchema = typeof readResultSchema;
type RepositoryPageSchema = typeof gitHubRepositoryPickerPageSchema;

export interface AccountReviewApprovalOperations {
  readonly 'account.github.reviewApprovals.read': SettingsOperationDefinition<
    'read',
    typeof accountReadInputSchema,
    ReadResultSchema
  >;
  readonly 'account.github.reviewApprovals.update': SettingsOperationDefinition<
    'write',
    typeof accountUpdateInputSchema,
    ReadResultSchema
  >;
  readonly 'account.github.reviewApprovals.repositories': SettingsOperationDefinition<
    'read',
    typeof accountRepositoriesInputSchema,
    RepositoryPageSchema
  >;
  readonly 'account.github.reviewApprovals.readiness': SettingsOperationDefinition<
    'read',
    typeof ReviewApprovalReadinessInputSchema,
    typeof ReviewApprovalReadinessResultSchema
  >;
}

export interface OrganizationReviewApprovalOperations {
  readonly 'organization.github.reviewApprovals.read': SettingsOperationDefinition<
    'read',
    typeof organizationReadInputSchema,
    ReadResultSchema
  >;
  readonly 'organization.github.reviewApprovals.update': SettingsOperationDefinition<
    'write',
    typeof organizationUpdateInputSchema,
    ReadResultSchema
  >;
  readonly 'organization.github.reviewApprovals.repositories': SettingsOperationDefinition<
    'read',
    typeof organizationRepositoriesInputSchema,
    RepositoryPageSchema
  >;
}

/** The personal-scope operations, spread into the account table. */
export function accountReviewApprovalOperations(): AccountReviewApprovalOperations {
  const owner: ReviewApprovalOwner = { kind: 'personal' };
  return {
    'account.github.reviewApprovals.read': defineSettingsRead({
      transport: 'backend',
      input: accountReadInputSchema,
      result: readResultSchema,
      request: () => readRequest(owner),
    }),
    'account.github.reviewApprovals.update': defineSettingsWrite({
      transport: 'backend',
      input: accountUpdateInputSchema,
      result: readResultSchema,
      request: (input) => updateRequest(owner, input),
    }),
    'account.github.reviewApprovals.repositories': defineSettingsRead({
      transport: 'backend',
      input: accountRepositoriesInputSchema,
      result: gitHubRepositoryPickerPageSchema,
      request: (input) => repositoriesRequest(owner, input),
    }),
    'account.github.reviewApprovals.readiness': defineSettingsRead({
      transport: 'backend',
      input: ReviewApprovalReadinessInputSchema,
      result: ReviewApprovalReadinessResultSchema,
      request: (input) => ({
        method: 'GET',
        path: settingsPathWithQuery(
          REVIEW_APPROVAL_READINESS_PATH,
          reviewApprovalReadinessQuery(input),
        ),
      }),
    }),
  };
}

/** The three organization-scope operations, spread into the organization table. */
export function organizationReviewApprovalOperations(): OrganizationReviewApprovalOperations {
  const ownerOf = (input: { organizationId: string }): ReviewApprovalOwner => ({
    kind: 'organization',
    organizationId: input.organizationId,
  });
  return {
    'organization.github.reviewApprovals.read': defineSettingsRead({
      transport: 'backend',
      input: organizationReadInputSchema,
      result: readResultSchema,
      request: (input) => readRequest(ownerOf(input)),
    }),
    'organization.github.reviewApprovals.update': defineSettingsWrite({
      transport: 'backend',
      input: organizationUpdateInputSchema,
      result: readResultSchema,
      request: (input) => updateRequest(ownerOf(input), input),
    }),
    'organization.github.reviewApprovals.repositories': defineSettingsRead({
      transport: 'backend',
      input: organizationRepositoriesInputSchema,
      result: gitHubRepositoryPickerPageSchema,
      request: (input) => repositoriesRequest(ownerOf(input), input),
    }),
  };
}

// --- Code review launches ---------------------------------------------------

/**
 * Whether a pipeline definition publishes a GitHub review: the code review
 * launch shows the "Link GitHub" notice for a definition with a step that
 * uses `builtin/github-publish-review`, whatever its preset id. Structural,
 * so the desktop launch modal and the web cloud run dialog read the same
 * answer from whatever definition shape they hold;
 * `builtin/./github-publish-review` normalizes as the resolver does.
 */
const PUBLISH_REVIEW_ACTION = 'github-publish-review';
const BUILTIN_PREFIX = 'builtin/';

function publishesReview(step: unknown): boolean {
  if (typeof step !== 'object' || step === null) return false;
  const uses: unknown = Reflect.get(step, 'uses');
  if (typeof uses !== 'string' || !uses.startsWith(BUILTIN_PREFIX)) {
    return false;
  }
  const segments = uses
    .slice(BUILTIN_PREFIX.length)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
  return segments.length === 1 && segments[0] === PUBLISH_REVIEW_ACTION;
}

/**
 * True when any job has a step that uses `builtin/github-publish-review`.
 * Takes any definition shape (a parsed or normalized document).
 */
export function pipelineDefinitionPublishesReview(
  definition: unknown,
): boolean {
  if (typeof definition !== 'object' || definition === null) return false;
  const jobs: unknown = Reflect.get(definition, 'jobs');
  if (typeof jobs !== 'object' || jobs === null) return false;
  return Object.values(jobs).some((job: unknown) => {
    if (typeof job !== 'object' || job === null) return false;
    const steps: unknown = Reflect.get(job, 'steps');
    return Array.isArray(steps) && steps.some(publishesReview);
  });
}
