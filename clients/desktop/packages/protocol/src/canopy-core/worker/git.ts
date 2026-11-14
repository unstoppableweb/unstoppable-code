import { z } from 'zod';

import { CanopyWorkspaceScopeSchema } from '../common';
import { defineCanopyQuery, defineCanopyQueryRegistry } from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../errors';

export const WORKER_GIT_GRANTS = {
  read: 'worker.git.read',
  write: 'worker.git.write',
} as const;

/**
 * Which fact selected `defaultBranch`: the host's recorded remote default
 * (`hint` while fresh, `stale-hint` once expired), the live remote HEAD, the
 * local `origin/HEAD`, or the first conventional `origin/{main,master,develop}`.
 */
export const WORKER_GIT_DEFAULT_BRANCH_SOURCES = [
  'hint',
  'remote',
  'local-origin-head',
  'stale-hint',
  'conventional',
] as const;

export type WorkerGitDefaultBranchSource =
  (typeof WORKER_GIT_DEFAULT_BRANCH_SOURCES)[number];

export const WORKER_GIT_BRANCH_LIST_ERROR_CODES = [
  'worker.git.branch.invalidScope',
  'worker.git.branch.scopeUnsupported',
  'worker.git.branch.repositoryUnavailable',
] as const;

/**
 * `checkout` is the worktree checkout `scope.worktreeId` names, or its
 * `scope.repoId` child checkout; `reference` is the workspace's configured
 * source repository.
 */
export const WorkerGitRepositorySelectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('checkout') }),
  z.strictObject({ kind: z.literal('reference') }),
]);

export type WorkerGitRepositorySelector = z.output<
  typeof WorkerGitRepositorySelectorSchema
>;

export const WorkerGitBranchListParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  repository: WorkerGitRepositorySelectorSchema,
  /** Use full ref identity for an exact worktree base selection. */
  exactWorktreeBaseBranch: z.literal(true).optional(),
  /** Opt into the additive result; legacy callers retain their closed shape. */
  includeHeadState: z.literal(true).optional(),
  /** Deadline-sensitive catalogues may use only local default-branch facts. */
  allowRemoteLookup: z.literal(false).optional(),
  /** Advisory remote knowledge; never authorizes repository access or writes. */
  defaultBranchHint: z
    .strictObject({
      defaultBranch: z.string().min(1),
      resolvedAt: z.iso.datetime(),
    })
    .optional(),
});

export type WorkerGitBranchListParams = z.output<
  typeof WorkerGitBranchListParamsSchema
>;

export const WorkerGitBranchSchema = z.strictObject({
  /** Short name; a remote-tracking ref drops its `origin/` prefix. */
  name: z.string(),
  /** Only a remote-tracking ref exists. */
  isRemote: z.boolean(),
  isCurrent: z.boolean(),
  /** Checked out by another worktree of the same repository. */
  isUsedByWorktree: z.boolean(),
  hasLocalRef: z.boolean(),
  hasRemoteRef: z.boolean(),
});

export type WorkerGitBranch = z.output<typeof WorkerGitBranchSchema>;

// Unpaginated: the desktop branch pickers list every ref today.
export const WorkerGitBranchListResultSchema = z.strictObject({
  branches: z.array(WorkerGitBranchSchema),
  defaultBranch: z.string().nullable(),
  defaultBranchSource: z.enum(WORKER_GIT_DEFAULT_BRANCH_SOURCES).nullable(),
  /** True: verified unborn source branch; false: verified commit; absent: unknown. */
  headUnborn: z.boolean().optional(),
});

export type WorkerGitBranchListResult = z.output<
  typeof WorkerGitBranchListResultSchema
>;

export const WorkerGitBranchListErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(WORKER_GIT_BRANCH_LIST_ERROR_CODES).optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const WORKER_GIT_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'worker',
  {
    'worker.git.branch.list': defineCanopyQuery({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'target-selectable',
      params: WorkerGitBranchListParamsSchema,
      result: WorkerGitBranchListResultSchema,
      error: WorkerGitBranchListErrorSchema,
      idempotency: 'inherent',
      requiredGrants: ['worker.git.read'],
    }),
  },
);

export const WORKER_GIT_REMOTE_GET_ERROR_CODES = [
  'worker.git.remote.invalidScope',
  'worker.git.remote.repositoryUnavailable',
  'worker.git.remote.notRepository',
] as const;

/**
 * `recorded` is the repository a workspace record names, at its recorded
 * location: the workspace's own repository (a single-repo repository or a
 * multi-repo source repository), or the multi-repo member `scope.repoId`
 * names. `source` is the workspace's source repository, resolved to its main
 * repository root.
 */
export const WorkerGitRemoteRepositorySelectorSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({ kind: z.literal('recorded') }),
    z.strictObject({ kind: z.literal('source') }),
  ],
);

export type WorkerGitRemoteRepositorySelector = z.output<
  typeof WorkerGitRemoteRepositorySelectorSchema
>;

export const WorkerGitRemoteGetParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  repository: WorkerGitRemoteRepositorySelectorSchema,
});

export type WorkerGitRemoteGetParams = z.output<
  typeof WorkerGitRemoteGetParamsSchema
>;

// Schemes Git serves over its own network transports; any other scheme goes
// to a `git-remote-<scheme>` helper on the host.
const NETWORK_GIT_REMOTE_SCHEMES = new Set([
  'ssh',
  'git',
  'http',
  'https',
  'ftp',
  'ftps',
  'git+ssh',
  'ssh+git',
]);

const SCHEME_URL_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
// A `scheme://` URL's `user[:password]@`: up to the last `@` before the path.
const SCHEME_URL_USERINFO = /^[^/?#]*@/;

/**
 * Whether Git reaches `url` over the network: a `scheme://` URL with one of
 * Git's network schemes and a host, or an scp-like `[user@]host:path`. Paths
 * (absolute, relative, UNC or drive-letter), `file:` URLs, remote-helper
 * `<transport>::<address>` forms, other schemes and host-less URLs such as
 * `ssh:///srv/repo.git` are not, and neither is a value that is ambiguous
 * between them.
 */
export function isNetworkGitRemoteUrl(url: string): boolean {
  const scheme = SCHEME_URL_PREFIX.exec(url)?.[1];
  if (scheme !== undefined)
    return (
      NETWORK_GIT_REMOTE_SCHEMES.has(scheme.toLowerCase()) &&
      /^[^/?#:]/.test(
        url.slice(scheme.length + 3).replace(SCHEME_URL_USERINFO, ''),
      )
    );
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(url)) return false;
  // Git's scp-like rule: a colon before any slash. A drive letter, `file:`
  // or an empty host reads as a host path instead.
  const colon = url.indexOf(':');
  const separator = url.search(/[/\\]/);
  if (colon <= 0 || (separator !== -1 && separator < colon)) return false;
  return !/^(?:[A-Za-z]|file):/i.test(url);
}

/**
 * `url` without the `user[:password]@` userinfo that can carry an access
 * token, as Git's `transport_anonymize_url` strips it. An scp-like URL's
 * userinfo runs to the last `@` before any slash that a colon follows, so
 * stripping it again changes nothing.
 */
function withoutGitRemoteUserinfo(url: string): string {
  const scheme = SCHEME_URL_PREFIX.exec(url)?.[1];
  if (scheme !== undefined) {
    const authorityStart = scheme.length + 3;
    return (
      url.slice(0, authorityStart) +
      url.slice(authorityStart).replace(SCHEME_URL_USERINFO, '')
    );
  }
  const separator = url.search(/[/\\]/);
  const head = separator === -1 ? url : url.slice(0, separator);
  const colon = url.lastIndexOf(':');
  const at = colon === -1 ? -1 : head.lastIndexOf('@', colon);
  return at === -1 ? url : url.slice(at + 1);
}

function isCanonicalNetworkGitRemoteUrl(url: string): boolean {
  return isNetworkGitRemoteUrl(url) && withoutGitRemoteUserinfo(url) === url;
}

/**
 * Where `origin` points. A `network` URL names another machine and carries no
 * userinfo, which can hold an access token; a `local` remote's URL (a path, a
 * `file:` URL, a remote helper or any value Git does not reach over the
 * network) can name this host's filesystem, so it stays with the host.
 */
export const WorkerGitRemoteEndpointSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('network'),
    /** The URL as Git prints it, trimmed, without its userinfo. */
    url: z.string().refine(isCanonicalNetworkGitRemoteUrl, {
      message: 'A local remote URL and remote userinfo stay with the host.',
    }),
  }),
  z.strictObject({ kind: z.literal('local') }),
]);

export type WorkerGitRemoteEndpoint = z.output<
  typeof WorkerGitRemoteEndpointSchema
>;

/** The canonical endpoint of a remote URL Git printed. */
export function gitRemoteEndpoint(url: string): WorkerGitRemoteEndpoint {
  if (!isNetworkGitRemoteUrl(url)) return { kind: 'local' };
  const anonymous = withoutGitRemoteUserinfo(url);
  // Without its userinfo, `me@c:repo` reads as a drive path.
  return isNetworkGitRemoteUrl(anonymous)
    ? { kind: 'network', url: anonymous }
    : { kind: 'local' };
}

/** The `origin` remote and where it points, or no `origin` at all. */
export const WorkerGitRemoteOriginSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('configured'),
    endpoint: WorkerGitRemoteEndpointSchema,
  }),
  z.strictObject({ state: z.literal('absent') }),
]);

export type WorkerGitRemoteOrigin = z.output<
  typeof WorkerGitRemoteOriginSchema
>;

export const WorkerGitRemoteGetResultSchema = z.strictObject({
  origin: WorkerGitRemoteOriginSchema,
});

export type WorkerGitRemoteGetResult = z.output<
  typeof WorkerGitRemoteGetResultSchema
>;

export const WorkerGitRemoteGetErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(WORKER_GIT_REMOTE_GET_ERROR_CODES).optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

// Its own partition, so the spec lands before the handler joins
// `WORKER_QUERY_DEFINITIONS` (CAN-5135).
export const WORKER_GIT_REMOTE_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'worker',
  {
    'worker.git.remote.get': defineCanopyQuery({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'target-selectable',
      params: WorkerGitRemoteGetParamsSchema,
      result: WorkerGitRemoteGetResultSchema,
      error: WorkerGitRemoteGetErrorSchema,
      idempotency: 'inherent',
      requiredGrants: ['worker.git.read'],
    }),
  },
);
