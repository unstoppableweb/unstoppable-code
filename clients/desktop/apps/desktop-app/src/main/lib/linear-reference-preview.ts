import { createHash } from 'node:crypto';
import {
  LINEAR_ISSUE_TITLE_MAX_CODE_POINTS,
  LINEAR_TEAM_KEY_PATTERN,
  isLinearAvatarUrl,
  isLinearStatusType,
  type LinearIssuePreview,
  type LinearIssuePreviewRequest,
  type LinearIssuePreviewResult,
  type LinearPreviewScope,
  type LinearTeamKeysResult,
} from '@canopy/protocol/reference-previews';
import { loadCanopyCloudAccount } from './canopy-cloud-account-store';
import {
  isLinearApiError,
  readLinearIssuePreview,
  readLinearTeamKeys,
  type LinearIssuePreviewNode,
} from './linear-api';
import { resolveLinearToken } from './linear-auth';

const TEAM_KEYS_FRESH_MS = 5 * 60 * 1000;
const TEAM_KEYS_RETRY_MS = 60 * 1000;

const MAX_DESCRIPTION_SOURCE = 4_000;
const MAX_DESCRIPTION_EXCERPT = 280;
const MAX_FIELD = 200;
const ISSUE_URL_RE = /^https:\/\/linear\.app\/([^/]+)\/issue\//i;

export interface LinearReferencePreviewDeps {
  resolveToken: () => Promise<string>;
  resolveAccountId: () => Promise<string>;
  requestIssue: (
    token: string,
    identifier: string,
  ) => Promise<LinearIssuePreviewNode | null>;
  requestTeamKeys: (token: string) => Promise<string[]>;
  now: () => number;
}

const defaultDeps: LinearReferencePreviewDeps = {
  resolveToken: resolveLinearToken,
  resolveAccountId: async () =>
    (await loadCanopyCloudAccount())?.account?.id ?? '',
  requestIssue: (token, identifier) =>
    readLinearIssuePreview(token, identifier),
  requestTeamKeys: (token) => readLinearTeamKeys(token),
  now: () => Date.now(),
};

/** Collapses whitespace and bounds by code point; a cut ends with `…`. */
function boundedText(value: unknown, max = MAX_FIELD): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const codePoints = Array.from(text);
  return codePoints.length > max
    ? `${codePoints
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : text;
}

/** Markdown to a short plain-text excerpt; never rendered as HTML. */
function descriptionExcerpt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return boundedText(
    value
      .slice(0, MAX_DESCRIPTION_SOURCE)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, ' ')
      .replace(/[`*_~#>|]/g, ''),
    MAX_DESCRIPTION_EXCERPT,
  );
}

function nestedName(
  value: {
    readonly name: string | null;
    readonly displayName?: string | null;
  } | null,
): string | null {
  if (!value) return null;
  return boundedText(value.displayName) ?? boundedText(value.name);
}

function toPreview(
  node: LinearIssuePreviewNode | null,
  request: LinearIssuePreviewRequest,
): LinearIssuePreview | null {
  if (!node) return null;
  const identifier = boundedText(node.identifier, 32);
  const title = boundedText(node.title, LINEAR_ISSUE_TITLE_MAX_CODE_POINTS);
  const url = typeof node.url === 'string' ? node.url : '';
  const workspace = ISSUE_URL_RE.exec(url)?.[1]?.toLowerCase();
  // A token belongs to one workspace: a URL naming another workspace must not
  // preview this workspace's issue that shares its identifier.
  if (
    !identifier ||
    !title ||
    !workspace ||
    url.length > 2_048 ||
    (request.workspaceSlug !== undefined && workspace !== request.workspaceSlug)
  ) {
    return null;
  }
  return {
    identifier,
    title,
    url,
    description: descriptionExcerpt(node.description),
    status: nestedName(node.state),
    statusType: isLinearStatusType(node.state?.type) ? node.state.type : null,
    assignee: nestedName(node.assignee),
    assigneeAvatarUrl: isLinearAvatarUrl(node.assignee?.avatarUrl)
      ? node.assignee.avatarUrl
      : null,
    project: nestedName(node.project),
    updatedAt: typeof node.updatedAt === 'string' ? node.updatedAt : '',
  };
}

function failureResult(
  error: unknown,
  scope: string,
): LinearIssuePreviewResult {
  if (!isLinearApiError(error)) return { status: 'failed' };
  switch (error.type) {
    case 'authentication':
      return { status: 'disconnected' };
    case 'forbidden':
    case 'feature_not_accessible':
    case 'invalid_input':
      return { status: 'unavailable', scope };
    case 'ratelimited':
      return { status: 'rate-limited', retryAfterMs: error.retryAfterMs };
    default:
      return error.notFound
        ? { status: 'unavailable', scope }
        : { status: 'failed' };
  }
}

function createLinearReferencePreviewReader(
  deps: LinearReferencePreviewDeps = defaultDeps,
): {
  readScope: () => Promise<LinearPreviewScope>;
  readIssue: (
    request: LinearIssuePreviewRequest,
  ) => Promise<LinearIssuePreviewResult>;
  readTeamKeys: () => Promise<LinearTeamKeysResult>;
} {
  // A credential Linear rejected reads as disconnected for one freshness
  // window, so every window stops calling Linear with it until the key changes
  // (a new scope) or the window passes.
  const revokedUntil = new Map<string, number>();
  const markRevoked = (scope: string): void => {
    revokedUntil.set(scope, deps.now() + TEAM_KEYS_FRESH_MS);
    if (teamKeys?.scope === scope) teamKeys = null;
  };

  const resolveScope = async (): Promise<{
    token: string;
    scope: string;
  } | null> => {
    // The token is read last, so a sign-out during the account lookup is seen.
    const accountId = await deps.resolveAccountId().catch(() => '');
    const token = (await deps.resolveToken()).trim();
    if (!token) return null;
    const scope = createHash('sha256')
      .update(`reference-preview\0${accountId}\0${token}`)
      .digest('base64url')
      .slice(0, 24);
    const until = revokedUntil.get(scope);
    if (until !== undefined) {
      if (deps.now() < until) return null;
      revokedUntil.delete(scope);
    }
    return { token, scope };
  };

  // Shared by every window: identical concurrent reads make one provider call.
  const issueReads = new Map<string, Promise<LinearIssuePreviewResult>>();
  let teamKeys: {
    scope: string;
    result: LinearTeamKeysResult | null;
    pending: Promise<LinearTeamKeysResult> | null;
    retryAt: number;
  } | null = null;

  const fetchTeamKeys = async (identity: {
    token: string;
    scope: string;
  }): Promise<LinearTeamKeysResult> => {
    try {
      const rawKeys = await deps.requestTeamKeys(identity.token);
      const keys = new Set<string>();
      for (const rawKey of rawKeys) {
        const key = rawKey.trim().toUpperCase();
        if (LINEAR_TEAM_KEY_PATTERN.test(key)) keys.add(key);
      }
      return {
        status: 'ok',
        scope: identity.scope,
        keys: Array.from(keys).sort(),
        fetchedAt: deps.now(),
      };
    } catch (error: unknown) {
      if (!isLinearApiError(error)) {
        return { status: 'failed', scope: identity.scope };
      }
      if (error.type === 'authentication') {
        markRevoked(identity.scope);
        return { status: 'disconnected' };
      }
      if (error.type === 'ratelimited') {
        return {
          status: 'rate-limited',
          scope: identity.scope,
          retryAfterMs: error.retryAfterMs,
        };
      }
      return { status: 'failed', scope: identity.scope };
    }
  };

  return {
    readScope: async () => ({ scope: (await resolveScope())?.scope ?? null }),
    readIssue: async (request): Promise<LinearIssuePreviewResult> => {
      const identity = await resolveScope();
      if (!identity) return { status: 'disconnected' };
      const key = `${identity.scope}\0${request.workspaceSlug ?? ''}\0${request.identifier}`;
      const existing = issueReads.get(key);
      if (existing) return existing;
      const read = (async (): Promise<LinearIssuePreviewResult> => {
        try {
          const preview = toPreview(
            await deps.requestIssue(identity.token, request.identifier),
            request,
          );
          return preview
            ? { status: 'ok', scope: identity.scope, preview }
            : { status: 'unavailable', scope: identity.scope };
        } catch (error: unknown) {
          const result = failureResult(error, identity.scope);
          if (result.status === 'disconnected') markRevoked(identity.scope);
          return result;
        }
      })().finally(() => issueReads.delete(key));
      issueReads.set(key, read);
      return read;
    },
    // One catalog per credential, shared by every window: fresh for five
    // minutes, coalesced while loading, and held back during a retry cooldown.
    readTeamKeys: async (): Promise<LinearTeamKeysResult> => {
      const identity = await resolveScope();
      if (!identity) {
        teamKeys = null;
        return { status: 'disconnected' };
      }
      if (teamKeys?.scope !== identity.scope) {
        teamKeys = {
          scope: identity.scope,
          result: null,
          pending: null,
          retryAt: 0,
        };
      }
      const entry = teamKeys;
      const now = deps.now();
      if (entry.pending) return entry.pending;
      if (
        entry.result?.status === 'ok' &&
        now - entry.result.fetchedAt < TEAM_KEYS_FRESH_MS
      ) {
        return entry.result;
      }
      if (entry.result && entry.result.status !== 'ok' && now < entry.retryAt) {
        return entry.result.status === 'rate-limited'
          ? { ...entry.result, retryAfterMs: entry.retryAt - now }
          : entry.result;
      }
      const pending = fetchTeamKeys(identity).then((result) => {
        if (teamKeys !== entry) return result;
        entry.pending = null;
        entry.result = result.status === 'disconnected' ? null : result;
        entry.retryAt =
          result.status === 'rate-limited'
            ? deps.now() + (result.retryAfterMs ?? TEAM_KEYS_RETRY_MS)
            : deps.now() + TEAM_KEYS_RETRY_MS;
        return result;
      });
      entry.pending = pending;
      return pending;
    },
  };
}

let sharedReader:
  | ReturnType<typeof createLinearReferencePreviewReader>
  | undefined;

/**
 * The one reader the preview IPC and the core.integration host share, so
 * they share its revocation hold-back and team-key catalog. Built on first use.
 */
export function sharedLinearReferencePreviewReader(): ReturnType<
  typeof createLinearReferencePreviewReader
> {
  sharedReader ??= createLinearReferencePreviewReader();
  return sharedReader;
}
