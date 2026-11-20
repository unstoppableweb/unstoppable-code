import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  GITHUB_CLI_ENVIRONMENT_VARIABLES,
  GITHUB_CLI_INTEGRATION_ID,
  GITHUB_INTEGRATION_ID,
  LINEAR_INTEGRATION_ID,
  type CanopyInstructionHandler,
  type CanopyQueryHandler,
  type CanopyWorkspaceScope,
  type CoreIntegration,
  type CoreIntegrationGitHubCli,
  type CoreIntegrationCredentialValidateResult,
  type CoreIntegrationGitHubCredential,
  type CoreIntegrationLinearCredential,
  type CoreIntegrationListResult,
  type CoreIntegrationResourceGetResult,
  type CoreIntegrationResourceListParams,
  type CoreIntegrationResourceListResult,
} from '@canopy/protocol/canopy-core';
import type {
  LinearIssuePreviewRequest,
  LinearIssuePreviewResult,
  LinearTeamKeysResult,
} from '@canopy/protocol/reference-previews';
import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import type { GitHubCliObservation } from './github-cli-status';
import { createContinuations, gitHubFailure } from './github-errors';
import {
  GITHUB_REPOSITORY_PERMISSIONS,
  type GitHubRepositorySnapshot,
  type GitHubRequestHandle,
} from './request-handle';

/**
 * Host port for `core.integration.*`. The host reads its own configuration;
 * GitHub CLI and secure-store failures arrive as observations, never throws.
 */
export interface CoreIntegrationHost {
  /** The authority and target this host serves; any other scope is refused. */
  readonly authorityId: string;
  readonly targetId?: string;
  readonly github: GitHubRequestHandle;
  /** Runs the GitHub CLI's status command without Canopy secrets. */
  observeGitHubCli(): Promise<GitHubCliObservation>;
  /**
   * The product's own github.com repository, resolved by the host from its
   * bundled brand; `null` when the brand declares none.
   */
  readonly sourceRepository: GitHubRepositoryTarget | null;
  /** Stars `target` with the GitHub CLI's github.com account. */
  starRepository(
    target: GitHubRepositoryTarget,
    options: { readonly signal: AbortSignal },
  ): Promise<GitHubCliStarOutcome>;
  /** The machine's Linear connection; a host without it lists no `linear`. */
  readonly linear?: LinearIntegrationPort;
}

/**
 * Host port for the Linear connection. Expected outcomes are results, never
 * throws, in the reference-preview reader's statuses with its opaque scope.
 */
export interface LinearIntegrationPort {
  /**
   * Whether a Linear API token is stored, or the store couldn't be read;
   * no network.
   */
  readCredentialState(): Promise<'stored' | 'absent' | 'unreadable'>;
  /** The opaque scope of the credential now in use; `null` when none. */
  readCurrentScope(): Promise<string | null>;
  readTeamKeys(options: {
    readonly signal: AbortSignal;
  }): Promise<LinearTeamKeysResult>;
  readIssue(
    request: LinearIssuePreviewRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<LinearIssuePreviewResult>;
  /** Probes a candidate token with Linear and stores nothing. */
  validate(
    secret: string,
    options: { readonly signal: AbortSignal },
  ): Promise<CoreIntegrationCredentialValidateResult>;
}

export interface GitHubRepositoryTarget {
  readonly owner: string;
  readonly repo: string;
}

/** Observations of one `gh api` star request; the host never throws. */
export type GitHubCliStarOutcome =
  | { readonly kind: 'starred' }
  | { readonly kind: 'not-installed' }
  | { readonly kind: 'not-authenticated' }
  | { readonly kind: 'failed'; readonly detail: string };

export interface CoreIntegrationHandlers {
  'core.integration.get': CanopyQueryHandler<
    'core.integration.get',
    CanopyHandlerContext
  >;
  'core.integration.list': CanopyQueryHandler<
    'core.integration.list',
    CanopyHandlerContext
  >;
  'core.integration.resource.list': CanopyQueryHandler<
    'core.integration.resource.list',
    CanopyHandlerContext
  >;
  'core.integration.resource.get': CanopyQueryHandler<
    'core.integration.resource.get',
    CanopyHandlerContext
  >;
}

export interface CoreIntegrationInstructionHandlers {
  'core.integration.sourceRepository.star': CanopyInstructionHandler<
    'core.integration.sourceRepository.star',
    CanopyHandlerContext
  >;
  'core.integration.credential.validate': CanopyInstructionHandler<
    'core.integration.credential.validate',
    CanopyHandlerContext
  >;
}

/**
 * Listed in this order; `core.integration.get` serves exactly these, and
 * `linear` after them when the host has it, so GitHub's offsets never move.
 */
const CONNECTION_IDS = [GITHUB_INTEGRATION_ID, GITHUB_CLI_INTEGRATION_ID];
const DEFAULT_PAGE_SIZE = 100;

/** A connection's state before its revision is assigned. */
interface Connection {
  readonly integrationId: string;
  readonly kind: string;
  readonly accountLabel: string;
  readonly state: CoreIntegration['state'];
  readonly capabilities: string[];
  readonly githubCredential?: CoreIntegrationGitHubCredential;
  readonly githubCli?: CoreIntegrationGitHubCli;
  readonly linearCredential?: CoreIntegrationLinearCredential;
}

const ENVIRONMENT_VARIABLES: ReadonlySet<string> = new Set(
  GITHUB_CLI_ENVIRONMENT_VARIABLES,
);

function environmentVariable(
  tokenSource: string,
): CoreIntegrationGitHubCli['environmentVariable'] {
  return (
    GITHUB_CLI_ENVIRONMENT_VARIABLES.find((name) => name === tokenSource) ??
    null
  );
}

// `hosts.yml` (or its `oauth_token` key) is the CLI's own config file.
function tokenSourceKind(
  tokenSource: string,
): NonNullable<CoreIntegrationGitHubCli['tokenSourceKind']> {
  if (tokenSource === 'keyring') return 'keyring';
  if (ENVIRONMENT_VARIABLES.has(tokenSource)) return 'environment';
  if (
    tokenSource === 'oauth_token' ||
    /(?:^|[\\/])hosts\.yml$/.test(tokenSource)
  )
    return 'config-file';
  return 'other';
}

function hostReadFailed(error: unknown): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'internal',
      message: 'The host could not read its credential state.',
      retry: { kind: 'never' },
    },
    error,
  );
}

async function readGitHub(host: CoreIntegrationHost): Promise<Connection> {
  let description: Awaited<ReturnType<GitHubRequestHandle['describe']>>;
  try {
    description = await host.github.describe();
  } catch (error) {
    throw hostReadFailed(error);
  }
  const { tokenSource, storedCredential } = description;
  const connected = tokenSource !== 'none';
  return {
    integrationId: GITHUB_INTEGRATION_ID,
    kind: 'github',
    // Reading the account would call GitHub.
    accountLabel: '',
    state: connected
      ? 'connected'
      : storedCredential === 'storage-unavailable' ||
          storedCredential === 'unreadable'
        ? 'error'
        : 'disconnected',
    capabilities: connected ? ['pull-requests', 'repositories'] : [],
    githubCredential: { tokenSource, storedCredential },
  };
}

function githubCliConnection(
  state: CoreIntegration['state'],
  githubCli: CoreIntegrationGitHubCli,
): Connection {
  return {
    integrationId: GITHUB_CLI_INTEGRATION_ID,
    kind: 'github-cli',
    accountLabel: githubCli.login ?? '',
    state,
    capabilities: state === 'connected' ? ['token-source'] : [],
    githubCli,
  };
}

/** The CLI's account as configured state; its raw token source never crosses. */
function projectGitHubCliConnection(
  observation: GitHubCliObservation,
): Connection {
  const none: CoreIntegrationGitHubCli = {
    login: null,
    tokenSourceKind: null,
    environmentVariable: null,
    hasCredentialStoreLogin: false,
    unavailableReason: null,
  };
  if (observation.kind === 'not-installed')
    return githubCliConnection('error', {
      ...none,
      unavailableReason: 'not_installed',
    });
  if (observation.kind === 'unparseable-output')
    return githubCliConnection('error', {
      ...none,
      unavailableReason: 'unparseable_output',
    });
  // A non-zero exit, including a timeout, reads as no account.
  if (observation.kind === 'failed')
    return githubCliConnection('disconnected', none);
  const { entries } = observation;
  const hasCredentialStoreLogin = entries.some(
    (entry) => !ENVIRONMENT_VARIABLES.has(entry.tokenSource),
  );
  const active = entries.find((entry) => entry.active);
  if (!active)
    return githubCliConnection('disconnected', {
      ...none,
      hasCredentialStoreLogin,
    });
  return githubCliConnection('connected', {
    login: active.login === '' ? null : active.login,
    tokenSourceKind: tokenSourceKind(active.tokenSource),
    environmentVariable: environmentVariable(active.tokenSource),
    hasCredentialStoreLogin,
    unavailableReason: null,
  });
}

async function readLinear(linear: LinearIntegrationPort): Promise<Connection> {
  let credential: Awaited<
    ReturnType<LinearIntegrationPort['readCredentialState']>
  >;
  try {
    credential = await linear.readCredentialState();
  } catch (error) {
    throw hostReadFailed(error);
  }
  const connection = {
    integrationId: LINEAR_INTEGRATION_ID,
    kind: 'linear',
    // Reading the account would call Linear.
    accountLabel: '',
  };
  // An unreadable store is not a confirmed disconnection: no credential member.
  if (credential === 'unreadable')
    return { ...connection, state: 'error', capabilities: [] };
  const storedCredential = credential === 'stored';
  return {
    ...connection,
    state: storedCredential ? 'connected' : 'disconnected',
    capabilities: storedCredential ? ['issues', 'teams'] : [],
    linearCredential: { storedCredential },
  };
}

async function readGitHubCli(host: CoreIntegrationHost): Promise<Connection> {
  let observation: GitHubCliObservation;
  try {
    observation = await host.observeGitHubCli();
  } catch (error) {
    throw hostReadFailed(error);
  }
  return projectGitHubCliConnection(observation);
}

function assertServedScope(
  scope: CanopyWorkspaceScope | undefined,
  host: CoreIntegrationHost,
): void {
  if (
    (scope?.authorityId !== undefined &&
      scope.authorityId !== host.authorityId) ||
    (scope?.targetId !== undefined && scope.targetId !== host.targetId)
  )
    throw new CanopyOperationError({
      kind: 'capability_unavailable',
      message: 'The selected integration authority or target is unavailable.',
      retry: { kind: 'never' },
    });
}

/** Process-local revisions: each changes when a read observes a new state. */
function createRevisions(): (connection: Connection) => CoreIntegration {
  const last = new Map<string, { state: string; revision: number }>();
  return (connection) => {
    const state = JSON.stringify(connection);
    const previous = last.get(connection.integrationId);
    const revision =
      previous === undefined
        ? 0
        : previous.state === state
          ? previous.revision
          : previous.revision + 1;
    last.set(connection.integrationId, { state, revision });
    return { ...connection, revision };
  };
}

/** Canonical JSON of a scope, so a cursor binds to the scope it was minted for. */
function scopeKey(scope: CanopyWorkspaceScope | undefined): string {
  const entries = Object.entries(scope ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return JSON.stringify(entries);
}

/** Opaque list cursors, authenticated with a per-process key. */
function createCursors(connectionCount: number): {
  mint(offset: number, scope: CanopyWorkspaceScope | undefined): string;
  read(cursor: string, scope: CanopyWorkspaceScope | undefined): number;
} {
  const key = randomBytes(32);
  const sign = (
    offset: number,
    scope: CanopyWorkspaceScope | undefined,
  ): string =>
    createHmac('sha256', key)
      .update(`${offset}\n${scopeKey(scope)}`)
      .digest('base64url');
  return {
    mint: (offset, scope) => `${offset}.${sign(offset, scope)}`,
    read: (cursor, scope) => {
      const match = /^(\d{1,4})\.([\w-]{43})$/.exec(cursor);
      const offset = match ? Number(match[1]) : Number.NaN;
      const expected = match ? Buffer.from(sign(offset, scope)) : null;
      const actual = match ? Buffer.from(match[2]) : null;
      if (
        !expected ||
        !actual ||
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual) ||
        offset < 1 ||
        offset >= connectionCount
      )
        throw new CanopyOperationError({
          kind: 'invalid_argument',
          code: 'core.integration.list.invalidCursor',
          message: 'The integration list cursor is not valid for this scope.',
          retry: { kind: 'never' },
        });
      return offset;
    },
  };
}

function resourceFailure(
  code:
    | 'core.integration.resource.kindUnsupported'
    | 'core.integration.resource.queryUnsupported',
  message: string,
): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'capability_unavailable',
    code,
    message,
    retry: { kind: 'never' },
  });
}

function invalidResourceCursor(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'invalid_argument',
    code: 'core.integration.resource.invalidCursor',
    message:
      'The resource cursor is not valid for these params or this snapshot.',
    retry: { kind: 'never' },
  });
}

type Resource = CoreIntegrationResourceListResult['resources'][number];

/**
 * The repositories of one snapshot as resources. GitHub types a listed
 * repository's update time as nullable; one without it is left out rather
 * than given an invented time (recorded debt).
 */
function repositoryResources(snapshot: GitHubRepositorySnapshot): Resource[] {
  return snapshot.repositories.flatMap((repository): Resource[] =>
    repository.updatedAt === null
      ? []
      : [
          {
            integrationId: GITHUB_INTEGRATION_ID,
            resourceId: `github-repository.${Buffer.from(
              repository.fullName.toLowerCase(),
            ).toString('base64url')}`,
            kind: 'repository',
            name: repository.fullName,
            locator: repository.webUrl,
            capabilities: GITHUB_REPOSITORY_PERMISSIONS.filter((permission) =>
              repository.permissions.includes(permission),
            ),
            updatedAt: repository.updatedAt,
          },
        ],
  );
}

const MAX_RETRY_DELAY_MS = 86_400_000;

/** A Linear read that answered neither `ok` nor `unavailable`. */
/**
 * A failed Linear read as its typed error. The reader can't tell an unreadable
 * store from no token, so `disconnected` asks the store: a read failure is
 * retryable, not a confirmed missing credential. A `stored` token stays
 * `notAuthenticated`: Linear refused it or it is held back as revoked, and a
 * store that recovered mid-request can't be told apart from that. The text is
 * fixed.
 */
async function linearReadFailure(
  port: LinearIntegrationPort,
  result: Parameters<typeof linearFailure>[0],
): Promise<CanopyOperationError> {
  if (
    result.status === 'disconnected' &&
    (await port.readCredentialState()) === 'unreadable'
  )
    return new CanopyOperationError({
      kind: 'unavailable',
      message: 'The Linear credential store could not be read.',
      retry: { kind: 'same_request' },
    });
  return linearFailure(result);
}

function linearFailure(
  result: Exclude<
    LinearIssuePreviewResult | LinearTeamKeysResult,
    { status: 'ok' } | { status: 'unavailable' }
  >,
): CanopyOperationError {
  switch (result.status) {
    case 'disconnected':
      return new CanopyOperationError({
        kind: 'failed_precondition',
        code: 'core.integration.notAuthenticated',
        message: 'No working Linear API token is stored.',
        retry: { kind: 'never' },
      });
    case 'rate-limited':
      return new CanopyOperationError({
        kind: 'resource_exhausted',
        message: 'Linear is rate limiting requests.',
        retry:
          result.retryAfterMs === null
            ? { kind: 'same_request' }
            : {
                kind: 'same_request',
                delayMs: Math.min(
                  Math.max(0, Math.ceil(result.retryAfterMs)),
                  MAX_RETRY_DELAY_MS,
                ),
              },
      });
    case 'failed':
      return new CanopyOperationError({
        kind: 'unavailable',
        message: 'Linear could not be read.',
        retry: { kind: 'same_request' },
      });
  }
}

/**
 * The Linear issue a read found. The preview's fields are already bounded;
 * one its schema still refuses fails the call rather than being cut again.
 */
function linearIssueResource(
  scope: string,
  preview: Extract<LinearIssuePreviewResult, { status: 'ok' }>['preview'],
): CoreIntegrationResourceGetResult {
  return {
    integrationId: LINEAR_INTEGRATION_ID,
    resourceId: preview.identifier,
    kind: 'issue',
    name: preview.title,
    locator: preview.url,
    capabilities: [],
    updatedAt: preview.updatedAt,
    linearIssue: {
      description: preview.description,
      status: preview.status,
      statusType: preview.statusType ?? null,
      assignee: preview.assignee,
      assigneeAvatarUrl: preview.assigneeAvatarUrl ?? null,
      project: preview.project,
    },
    credentialScope: scope,
  };
}

/**
 * The connection's team keys as resources. A key names no workspace, so a
 * team has no URL to locate it (`locator` is empty), and Linear reports no
 * team time: `updatedAt` is when the host read the catalog.
 */
function teamResources(
  result: Extract<LinearTeamKeysResult, { status: 'ok' }>,
): Resource[] {
  const updatedAt = new Date(result.fetchedAt).toISOString();
  return result.keys.map(
    (key): Resource => ({
      integrationId: LINEAR_INTEGRATION_ID,
      resourceId: key,
      kind: 'team',
      name: key,
      locator: '',
      capabilities: [],
      updatedAt,
    }),
  );
}

/**
 * `core.integration.get` and `list` for the desktop host's GitHub
 * connections (CAN-4109): configured state only, never a credential. And
 * `core.integration.resource.list`: the repositories the credential reaches,
 * paged over the host's cached snapshot. With a Linear port the host also
 * serves the `linear` connection, its team keys and issue reads (CAN-4178).
 */
export function createCoreIntegrationHandlers(
  host: CoreIntegrationHost,
): CoreIntegrationHandlers {
  const { linear } = host;
  const connectionIds = linear
    ? [...CONNECTION_IDS, LINEAR_INTEGRATION_ID]
    : CONNECTION_IDS;
  const withRevision = createRevisions();
  const cursors = createCursors(connectionIds.length);
  const resourceCursors = createContinuations();
  const read = async (integrationId: string): Promise<CoreIntegration> =>
    withRevision(
      integrationId === GITHUB_INTEGRATION_ID
        ? await readGitHub(host)
        : linear && integrationId === LINEAR_INTEGRATION_ID
          ? await readLinear(linear)
          : await readGitHubCli(host),
    );
  const listLinearTeams = async (
    port: LinearIntegrationPort,
    { kinds, query, cursor, limit }: CoreIntegrationResourceListParams,
    signal: AbortSignal,
  ): Promise<CoreIntegrationResourceListResult> => {
    if (kinds.length === 0 || kinds.some((kind) => kind !== 'team'))
      throw resourceFailure(
        'core.integration.resource.kindUnsupported',
        'The host lists Linear teams only.',
      );
    if (query !== null)
      throw resourceFailure(
        'core.integration.resource.queryUnsupported',
        'The host does not filter Linear teams.',
      );
    const result = await port.readTeamKeys({ signal });
    if (result.status !== 'ok') throw await linearReadFailure(port, result);
    // A list carries no scope, so a page read under a replaced credential is refused.
    if ((await port.readCurrentScope()) !== result.scope)
      throw new CanopyOperationError({
        kind: 'unavailable',
        message: 'The Linear credential changed during the read.',
        retry: { kind: 'same_request' },
      });
    const resources = teamResources(result);
    // Bound to the catalog read: a refreshed catalog invalidates its cursors.
    const binding = JSON.stringify([
      LINEAR_INTEGRATION_ID,
      result.scope,
      result.fetchedAt,
    ]);
    let start = 0;
    if (cursor !== null) {
      const position = resourceCursors.read(cursor, binding);
      start =
        position !== null && /^\d{1,6}$/.test(position) ? Number(position) : 0;
      if (start < 1 || start >= resources.length) throw invalidResourceCursor();
    }
    const end = start + limit;
    return {
      resources: resources.slice(start, end),
      nextCursor:
        end < resources.length
          ? resourceCursors.mint(String(end), binding)
          : null,
    };
  };
  return {
    'core.integration.get': async ({ scope, integrationId }) => {
      assertServedScope(scope, host);
      if (!connectionIds.includes(integrationId))
        throw new CanopyOperationError({
          kind: 'not_found',
          code: 'core.integration.notFound',
          message: 'The host serves no integration with this id.',
          retry: { kind: 'never' },
        });
      return read(integrationId);
    },
    'core.integration.list': async ({
      scope,
      pageSize,
      cursor,
    }): Promise<CoreIntegrationListResult> => {
      assertServedScope(scope, host);
      const start = cursor === undefined ? 0 : cursors.read(cursor, scope);
      const end = start + (pageSize ?? DEFAULT_PAGE_SIZE);
      const items: CoreIntegration[] = [];
      for (const integrationId of connectionIds.slice(start, end))
        items.push(await read(integrationId));
      return {
        items,
        nextCursor:
          end < connectionIds.length ? cursors.mint(end, scope) : null,
      };
    },
    'core.integration.resource.list': async (
      { integrationId, kinds, query, cursor, limit },
      context,
    ): Promise<CoreIntegrationResourceListResult> => {
      if (linear && integrationId === LINEAR_INTEGRATION_ID)
        return listLinearTeams(
          linear,
          { integrationId, kinds, query, cursor, limit },
          context.signal,
        );
      if (integrationId !== GITHUB_INTEGRATION_ID)
        throw new CanopyOperationError({
          kind: 'not_found',
          code: 'core.integration.notFound',
          message: 'The host serves no resources for this integration.',
          retry: { kind: 'never' },
        });
      if (kinds.length === 0 || kinds.some((kind) => kind !== 'repository'))
        throw resourceFailure(
          'core.integration.resource.kindUnsupported',
          'The host lists repositories only.',
        );
      if (query !== null)
        throw resourceFailure(
          'core.integration.resource.queryUnsupported',
          'The host does not filter repositories.',
        );
      let snapshot: GitHubRepositorySnapshot;
      try {
        snapshot = await host.github.listRepositories({
          signal: context.signal,
        });
      } catch (error) {
        throw gitHubFailure(error, {
          notAuthenticated: 'core.integration.notAuthenticated',
        });
      }
      const resources = repositoryResources(snapshot);
      // Bound to the snapshot: a replaced snapshot invalidates its cursors.
      const binding = JSON.stringify([integrationId, snapshot.snapshotId]);
      let start = 0;
      if (cursor !== null) {
        const position = resourceCursors.read(cursor, binding);
        start =
          position !== null && /^\d{1,6}$/.test(position)
            ? Number(position)
            : 0;
        if (start < 1 || start >= resources.length)
          throw invalidResourceCursor();
      }
      const end = start + limit;
      return {
        resources: resources.slice(start, end),
        nextCursor:
          end < resources.length
            ? resourceCursors.mint(String(end), binding)
            : null,
      };
    },
    // Linear issues only; GitHub reads its resources through core.pullRequest.
    'core.integration.resource.get': async (
      { integrationId, resourceId, workspaceSlug },
      context,
    ): Promise<CoreIntegrationResourceGetResult> => {
      if (!linear || integrationId !== LINEAR_INTEGRATION_ID)
        throw new CanopyOperationError({
          kind: 'not_found',
          code: 'core.integration.notFound',
          message: 'The host serves no resource reads for this integration.',
          retry: { kind: 'never' },
        });
      const result = await linear.readIssue(
        {
          identifier: resourceId,
          ...(workspaceSlug === undefined ? {} : { workspaceSlug }),
        },
        { signal: context.signal },
      );
      if (result.status === 'ok')
        return linearIssueResource(result.scope, result.preview);
      // Not found, not permitted, or in another workspace than the link names.
      if (result.status === 'unavailable')
        throw new CanopyOperationError({
          kind: 'not_found',
          code: 'core.integration.resource.notFound',
          message: 'The Linear credential reaches no such issue.',
          retry: { kind: 'never' },
        });
      throw await linearReadFailure(linear, result);
    },
  };
}

function starFailure(
  outcome: Exclude<GitHubCliStarOutcome, { kind: 'starred' }>,
): CanopyOperationError {
  switch (outcome.kind) {
    case 'not-installed':
      return new CanopyOperationError({
        kind: 'failed_precondition',
        code: 'core.integration.githubCli.notInstalled',
        message: 'The GitHub CLI is not installed.',
        retry: { kind: 'never' },
      });
    case 'not-authenticated':
      return new CanopyOperationError({
        kind: 'failed_precondition',
        code: 'core.integration.notAuthenticated',
        message: 'The GitHub CLI is not signed in to github.com.',
        retry: { kind: 'never' },
      });
    case 'failed':
      // The CLI's stderr is diagnostic only and never crosses the wire.
      return new CanopyOperationError(
        {
          kind: 'unavailable',
          code: 'core.integration.sourceRepository.star.failed',
          message: 'The GitHub CLI could not star the repository.',
          retry: { kind: 'same_request' },
        },
        new Error(outcome.detail),
      );
  }
}

/**
 * `core.integration.sourceRepository.star`: stars the brand's own repository
 * with the GitHub CLI. The repository comes from the host, never the caller.
 */
export function createCoreIntegrationInstructionHandlers(
  host: CoreIntegrationHost,
): CoreIntegrationInstructionHandlers {
  return {
    'core.integration.sourceRepository.star': async (_params, context) => {
      const repository = host.sourceRepository;
      if (repository === null)
        throw new CanopyOperationError({
          kind: 'capability_unavailable',
          code: 'core.integration.sourceRepository.unavailable',
          message: 'This build declares no source repository to star.',
          retry: { kind: 'never' },
        });
      const outcome = await host.starRepository(repository, {
        signal: context.signal,
      });
      if (outcome.kind !== 'starred') throw starFailure(outcome);
      return {
        repository: { owner: repository.owner, repo: repository.repo },
      };
    },
    // `linear.apiToken` is the only kind; the secret goes to the probe alone.
    'core.integration.credential.validate': async ({ secret }, context) => {
      if (!host.linear)
        throw new CanopyOperationError({
          kind: 'capability_unavailable',
          message: 'This host validates no Linear credential.',
          retry: { kind: 'never' },
        });
      return host.linear.validate(secret, { signal: context.signal });
    },
  };
}
