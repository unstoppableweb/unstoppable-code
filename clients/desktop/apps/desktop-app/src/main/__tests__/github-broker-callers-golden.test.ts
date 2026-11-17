// CAN-4176 golden: which GitHub credential each broker caller hands the
// broker today, captured before the broker takes opaque credential leases
// instead of raw tokens. The callers run unchanged; the broker is a recorder,
// the token sources return labelled tokens, and the git and cloud account
// reads the callers need are stubbed. A change here is a behaviour change:
// re-record deliberately with `pnpm test <this file> -u` and review the diff.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as BrokerModule from '../lib/github-broker';

const TOKENS: Record<string, string> = {
  ghp_default_token: 'default',
  ghp_with_source_token: 'with-source',
  ghp_stored_pat: 'stored-pat',
  gho_cli_token: 'gh-cli',
};
const label = (token: unknown): string =>
  token === undefined
    ? 'broker-default'
    : typeof token === 'string' && token in TOKENS
      ? TOKENS[token]
      : 'unknown';

jest.mock('../lib/github-auth', () => ({
  ...jest.requireActual<object>('../lib/github-auth'),
  resolveGitHubToken: (): Promise<string> =>
    Promise.resolve('ghp_default_token'),
  resolveGitHubTokenWithSource: (): Promise<{
    token: string;
    source: string;
  }> => Promise.resolve({ token: 'ghp_with_source_token', source: 'pat' }),
  loadStoredPat: (): Promise<string> => Promise.resolve('ghp_stored_pat'),
  loadGhCliToken: (): Promise<string> => Promise.resolve('gho_cli_token'),
  invalidateTokenCache: (): void => undefined,
}));

const calls: unknown[] = [];
let respond: (
  options: BrokerModule.GitHubBrokerRequestOptions,
) => unknown = () => ({});
jest.mock('../lib/github-broker', () => {
  const actual = jest.requireActual<typeof BrokerModule>(
    '../lib/github-broker',
  );
  const broker = {
    getCredentialGeneration: (): number => 1,
    execute: (
      _request: unknown,
      options: BrokerModule.GitHubBrokerRequestOptions,
    ): Promise<unknown> => {
      calls.push({
        credential: label(options.authenticationToken),
        priority: options.priority,
        operation: options.operation,
        idempotency: options.idempotency,
        caller: options.caller ?? null,
        resourceKey: options.resourceKey ?? null,
        conditional: options.conditional ?? false,
      });
      return Promise.resolve({
        kind: options.operation === 'mutation' ? 'mutation' : 'read',
        status: 200,
        changed: true,
        rateLimit: {},
        data: respond(options),
      });
    },
    subscribeRateLimits: (): (() => void) => () => undefined,
    getQuotaDiagnostics: (): unknown => ({
      quota: [],
      pausedUntil: {},
      spend: null,
    }),
    currentQuota: (): undefined => undefined,
    resetCredentials: (): void => undefined,
    shutdown: (): void => undefined,
  };
  return { ...actual, getGitHubBroker: (): typeof broker => broker };
});

jest.mock('../lib/git', () => ({
  ...jest.requireActual<object>('../lib/git'),
  getHeadCommitSha: (): Promise<string> => Promise.resolve('head-sha'),
  listRemoteTrackingCandidates: (): Promise<string[]> =>
    Promise.resolve(['origin/develop']),
  mergeBase: (): Promise<string> => Promise.resolve('base-sha'),
  countCommits: (): Promise<number> => Promise.resolve(2),
  getRemoteUrlStrict: (): Promise<string> =>
    Promise.resolve('https://github.com/acme/app.git'),
}));
jest.mock('../lib/worktree-base-branches', () => ({
  ...jest.requireActual<object>('../lib/worktree-base-branches'),
  resolveEffectiveBaseBranchForRepo: (): Promise<{ branch: string }> =>
    Promise.resolve({ branch: 'develop' }),
}));
let accountRead: () => Promise<unknown> = () =>
  Promise.resolve({ status: 'ok', entry: null });
jest.mock('../lib/canopy-cloud-account-store', () => ({
  ...jest.requireActual<object>('../lib/canopy-cloud-account-store'),
  readCanopyCloudAccountWithStatus: (): Promise<unknown> => accountRead(),
}));

beforeEach(() => {
  calls.length = 0;
  respond = (): unknown => ({});
  accountRead = (): Promise<unknown> =>
    Promise.resolve({ status: 'ok', entry: null });
});

describe('broker callers', () => {
  it('the shared client passes a caller credential through and otherwise uses the broker default', async () => {
    const { getGitHubClient } = await import('../lib/github-client');
    const client = getGitHubClient();
    await client.enqueue(
      () => Promise.resolve({ status: 200, data: {} }),
      'high',
    );
    await client.enqueue(
      () => Promise.resolve({ status: 200, data: {} }),
      'normal',
      {
        authenticationToken: 'ghp_with_source_token',
      },
    );
    expect(calls).toMatchSnapshot();
  });

  it('the permission probe reads with the credential its source names', async () => {
    const { probeGitHubPermissions } =
      await import('../lib/github-permissions');
    respond = (): unknown => ({});
    for (const source of ['any', 'pat', 'oauth'] as const) {
      await probeGitHubPermissions(source).catch(() => undefined);
    }
    expect(calls).toMatchSnapshot();
  });

  it('the shared-container pushed base probes commits with the resolved credential', async () => {
    const { resolveSharedContainerPushedBase } =
      await import('../shared-containers/pushed-base');
    await resolveSharedContainerPushedBase({
      projectId: 'golden-project',
      worktreeId: 'golden-wt',
      repoId: 'repo',
      repoPath: '/repo',
    }).catch(() => undefined);
    expect(calls).toMatchSnapshot();
  });

  it('the reference preview reads with the resolved credential under the reference-preview label', async () => {
    const { createGitHubReferencePreviewReader } =
      await import('../lib/github-reference-preview');
    respond = (): unknown => ({
      number: 7,
      title: 'Feature',
      state: 'open',
      html_url: 'https://github.com/acme/app/pull/7',
      pull_request: {},
      user: { login: 'octo' },
      labels: [],
      created_at: '2026-11-16T10:00:00Z',
      updated_at: '2026-11-16T10:00:00Z',
    });
    const reader = createGitHubReferencePreviewReader();
    await reader
      .read({ kind: 'item', owner: 'acme', repository: 'app', number: 7 })
      .catch(() => undefined);
    expect(calls).toMatchSnapshot();
  });

  it('shared-container code materialization probes the repository, commit and tree with the resolved credential', async () => {
    const { materializeCodeRevision } =
      await import('../shared-containers/materialize/code');
    const replies = [
      { status: 200, data: {} },
      { status: 200, data: { commit: { tree: { sha: 'tree-sha' } } } },
      { status: 200, data: { truncated: true, tree: [] } },
    ];
    respond = (): unknown => replies.shift() ?? { status: 200, data: {} };
    const root = mkdtempSync(join(tmpdir(), 'materialize-callers-'));
    const outcome = await materializeCodeRevision({
      layout: {
        schemaVersion: 1,
        containerType: 'CODE_WORKTREE',
        title: 'Shared',
        repositories: [
          {
            repoId: 'app',
            repoName: 'app',
            remoteUrl: 'https://github.com/acme/app.git',
            owner: 'acme',
            repository: 'app',
            baseCommitSha: 'a'.repeat(40),
            files: [],
          },
        ],
        files: [],
        notes: [],
        prompts: [],
        attachmentPaths: {},
      },
      artifactsDir: join(root, 'artifacts'),
      reposDir: join(root, 'repos'),
      committedRangesDir: join(root, 'ranges'),
      artifactPathsById: new Map(),
    }).then(
      () => 'resolved',
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );
    rmSync(root, { recursive: true, force: true });
    expect({ outcome, calls }).toMatchSnapshot();
  });

  it('PR tracking derives one opaque scope per credential, with an account scope when signed out', async () => {
    const { readGitHubTrackingCredential, githubTrackingCredentialScope } =
      await import('../lib/github-preview-credential');
    const tracking = await readGitHubTrackingCredential();
    expect({
      credential: label(tracking?.token),
      authenticationScopeIsOpaque:
        tracking !== null &&
        !tracking.authenticationScope.includes('ghp_') &&
        tracking.authenticationScope ===
          githubTrackingCredentialScope('ghp_with_source_token'),
      differsPerToken:
        githubTrackingCredentialScope('ghp_stored_pat') !==
        githubTrackingCredentialScope('ghp_with_source_token'),
      signedOutAccountScopeIsOpaque:
        typeof tracking?.scope === 'string' &&
        tracking.scope.length > 0 &&
        !tracking.scope.includes('ghp_'),
    }).toMatchSnapshot();
  });
});
