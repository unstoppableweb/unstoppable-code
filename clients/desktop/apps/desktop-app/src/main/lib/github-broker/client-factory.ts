import type { Octokit } from '@octokit/rest';
import type {
  GitHubBrokerClientFactory,
  GitHubBrokerClientHooks,
} from '@canopy/core-runtime/node/github/broker/broker';
import {
  isGitHubBrokerCredentialLease,
  type GitHubBrokerCredentialPort,
} from './credential-port';
import {
  GitHubBrokerCredentialResetError,
  GitHubBrokerError,
  githubErrorHeaders,
  githubErrorStatus,
} from './errors';
import {
  resolveOctokitBrokerClientOptions,
  type OctokitClientLog,
} from '../github-octokit-options';
import { loadOctokitConstructor } from '../github-octokit-loader';
import { logMainProcessWarn } from '../main-process-logging';

/**
 * Octokit's logger for the broker client. Request options (and so headers)
 * are never logged: debug and info are dropped, and warnings and errors keep
 * only their message.
 */
const OCTOKIT_LOG: OctokitClientLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message) => logMainProcessWarn(`[github] ${message}`),
  error: (message) => logMainProcessWarn(`[github] ${message}`),
};

type OctokitRequest = Octokit['request'];
type OctokitEndpoint = Required<
  ReturnType<OctokitRequest['endpoint']['merge']>
>;

/**
 * The broker's Octokit client, built in Electron main. The credential port
 * stays here: core hands back only the leases it was given, and this module
 * authorizes them for each HTTP request.
 */
export function createGitHubBrokerClientFactory(
  credentialPort: GitHubBrokerCredentialPort,
): GitHubBrokerClientFactory<Octokit> {
  return {
    create(hooks) {
      const OctokitConstructor = loadOctokitConstructor();
      const octokit = new OctokitConstructor(
        resolveOctokitBrokerClientOptions(
          () => leaseAuthentication(credentialPort, hooks),
          OCTOKIT_LOG,
        ),
      );
      octokit.hook?.wrap('request', async (request, requestOptions) => {
        if (!hooks.attempt()) return request(requestOptions);
        try {
          const response = await request(requestOptions);
          hooks.observe(response.status, response.headers);
          return response;
        } catch (error) {
          const status = githubErrorStatus(error);
          if (status !== undefined) {
            hooks.observe(status, githubErrorHeaders(error));
          }
          throw error;
        }
      });
      return octokit;
    },
  };
}

/**
 * The client's auth strategy. Octokit wraps this hook first, so it runs
 * innermost: every plugin hook (request logging included) sees the request
 * without its `authorization` header. The header is set on a fresh endpoint
 * object for one HTTP request and removed when that request settles.
 */
function leaseAuthentication(
  credentialPort: GitHubBrokerCredentialPort,
  hooks: GitHubBrokerClientHooks,
): unknown {
  const hook = async (
    request: OctokitRequest,
    options: OctokitEndpoint,
  ): ReturnType<OctokitRequest> => {
    const attempt = hooks.attempt();
    if (!attempt) {
      throw new GitHubBrokerError(
        'not_authenticated',
        'GitHub requests are authorized only inside a broker attempt.',
      );
    }
    const { lease } = attempt;
    if (!isGitHubBrokerCredentialLease(lease)) {
      throw new GitHubBrokerError(
        'not_authenticated',
        'The GitHub credential lease was not issued by the credential port.',
      );
    }
    // Each Octokit hook receives the options its request started with, not
    // what an outer hook passes on, so the attempt's signal is attached here,
    // next to the header, where the HTTP request is actually sent.
    const endpoint = request.endpoint.merge(options);
    endpoint.request = { ...endpoint.request, signal: attempt.signal };
    // A call left running after its attempt settled is never authorized.
    attempt.signal.throwIfAborted();
    const authorization = await credentialPort.authorize(lease);
    attempt.signal.throwIfAborted();
    // A reset while the lease was being authorized means the header may be
    // the previous credential's: send nothing and let the attempt reissue.
    if (!attempt.isCurrent()) {
      throw new GitHubBrokerCredentialResetError('credential_reset');
    }
    // The last check before sending: a lease that expired or was revoked
    // while it was being authorized sends nothing.
    credentialPort.assertLive(lease);
    endpoint.headers.authorization = authorization;
    try {
      return await request(endpoint);
    } finally {
      delete endpoint.headers.authorization;
    }
  };
  return Object.assign(
    (): Promise<{ type: 'lease' }> => Promise.resolve({ type: 'lease' }),
    { hook },
  );
}
