import type {
  GitHubPermission,
  GitHubPermissionSource,
  GitHubPermissionsStatus,
  GitHubTokenType,
  PermissionState,
} from '@canopy/desktop-shared/types';
import type { GitHubTokenSource } from './github-auth';
import { getGitHubClient } from './github-client';
import {
  getGitHubBrokerCredentialPort,
  type GitHubBrokerCredentialGrant,
  type GitHubBrokerCredentialTokenFamily,
} from './github-broker/credential-port';

interface PermissionSpec {
  scope: string;
  label: string;
  description: string;
  required: boolean;
  satisfiedBy: string[];
}

const PERMISSION_SPECS: PermissionSpec[] = [
  {
    scope: 'repo',
    label: 'repo',
    description:
      'Full control of private repositories. Needed to create and update pull requests, fetch check runs, and read reviews.',
    required: true,
    satisfiedBy: ['repo'],
  },
  {
    scope: 'read:org',
    label: 'read:org',
    description:
      'Read organization membership. Needed to list repositories from organizations you belong to.',
    required: false,
    satisfiedBy: ['read:org', 'admin:org'],
  },
  {
    scope: 'workflow',
    label: 'workflow',
    description:
      'Update GitHub Actions workflow files. Needed when pushing changes that modify files under .github/workflows/.',
    required: false,
    satisfiedBy: ['workflow'],
  },
];

function detectTokenType(
  family: GitHubBrokerCredentialTokenFamily,
  source: GitHubTokenSource,
): GitHubTokenType {
  if (family === 'fine-grained') {
    return 'fine-grained';
  }
  if (family === 'classic') {
    return source === 'gh-cli' ? 'gh-cli' : 'classic';
  }
  return source === 'gh-cli' ? 'gh-cli' : 'unknown';
}

function parseScopes(header: string | undefined): string[] {
  if (!header) {
    return [];
  }
  return header
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

function evaluatePermission(
  spec: PermissionSpec,
  scopes: string[],
  tokenType: GitHubTokenType,
): PermissionState {
  if (tokenType === 'fine-grained') {
    return 'unknown';
  }
  const granted = spec.satisfiedBy.some((match) => scopes.includes(match));
  return granted ? 'granted' : 'missing';
}

function buildPermissions(
  scopes: string[],
  tokenType: GitHubTokenType,
): GitHubPermission[] {
  return PERMISSION_SPECS.map((spec) => ({
    scope: spec.scope,
    label: spec.label,
    description: spec.description,
    required: spec.required,
    state: evaluatePermission(spec, scopes, tokenType),
  }));
}

function canListRepos(scopes: string[], tokenType: GitHubTokenType): boolean {
  if (tokenType === 'fine-grained') {
    return true;
  }
  return scopes.includes('repo') || scopes.includes('public_repo');
}

function emptyPermissions(): GitHubPermission[] {
  return PERMISSION_SPECS.map((spec) => ({
    scope: spec.scope,
    label: spec.label,
    description: spec.description,
    required: spec.required,
    state: 'unknown',
  }));
}

async function leaseForSource(source: GitHubPermissionSource): Promise<{
  grant: GitHubBrokerCredentialGrant | null;
  label: GitHubTokenSource;
}> {
  const port = getGitHubBrokerCredentialPort();
  if (source === 'pat') {
    return { grant: await port.lease('pat'), label: 'pat' };
  }
  if (source === 'oauth') {
    return { grant: await port.lease('gh-cli'), label: 'gh-cli' };
  }
  // 'any' — resolve whichever source has a token, PAT first then gh CLI.
  const grant = await port.lease('resolved');
  return { grant, label: grant?.source ?? 'none' };
}

function missingTokenError(source: GitHubPermissionSource): string {
  if (source === 'pat') {
    return 'No personal access token configured. Add one in Settings.';
  }
  if (source === 'oauth') {
    return 'gh CLI is not signed in. Click Sign in above to authenticate.';
  }
  return 'No GitHub token found. Add a personal access token in Settings or sign in with `gh auth login`.';
}

/**
 * Probe the GitHub API using *only* the requested credential source. There
 * is no fallback to the other source — the Permissions UI shows scopes for
 * the user's currently-selected auth mode, never a mix.
 */
export async function probeGitHubPermissions(
  source: GitHubPermissionSource,
): Promise<GitHubPermissionsStatus> {
  const { grant, label } = await leaseForSource(source);

  if (!grant) {
    return {
      tokenAvailable: false,
      tokenType: source === 'oauth' ? 'gh-cli' : 'unknown',
      scopes: [],
      permissions: emptyPermissions(),
      canListRepos: false,
      error: missingTokenError(source),
    };
  }

  const tokenType = detectTokenType(grant.tokenFamily, label);

  try {
    const response = await getGitHubClient().enqueue(
      (octokit) => octokit.request('GET /user'),
      'high',
      { credential: grant.lease },
    );
    const scopes = parseScopes(response.headers['x-oauth-scopes']);
    const permissions = buildPermissions(scopes, tokenType);

    return {
      tokenAvailable: true,
      tokenType,
      scopes,
      permissions,
      canListRepos: canListRepos(scopes, tokenType),
      error: null,
    };
  } catch (error: unknown) {
    const status = (error as { status?: number }).status;
    const message =
      error instanceof Error ? error.message : 'GitHub API request failed.';

    if (status === 401) {
      let rejectionMessage: string;
      if (source === 'pat') {
        rejectionMessage =
          'The stored personal access token was rejected (401). Replace it with a valid token.';
      } else if (source === 'oauth') {
        rejectionMessage =
          'The gh CLI token was rejected (401). Re-run the OAuth sign-in.';
      } else {
        rejectionMessage =
          'GitHub token was rejected (401). Replace it with a valid token.';
      }
      return {
        tokenAvailable: true,
        tokenType,
        scopes: [],
        permissions: buildPermissions([], tokenType),
        canListRepos: false,
        error: rejectionMessage,
      };
    }

    return {
      tokenAvailable: true,
      tokenType,
      scopes: [],
      permissions: buildPermissions([], tokenType),
      canListRepos: false,
      error: `Unable to verify GitHub permissions: ${message}`,
    };
  } finally {
    getGitHubBrokerCredentialPort().revoke(grant.lease);
  }
}
