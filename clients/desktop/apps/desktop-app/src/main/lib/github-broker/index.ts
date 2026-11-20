import type { Octokit } from '@octokit/rest';
import {
  createGitHubBroker,
  type GitHubBroker as CoreGitHubBroker,
  type GitHubBrokerCredentialLeases,
  type GitHubBrokerRequestOptions as CoreGitHubBrokerRequestOptions,
  type GitHubBrokerResult,
  type GitHubQuotaSnapshot,
  type GitHubRateLimitResource,
  type GitHubRawResponse,
} from '@canopy/core-runtime/node/github/broker/broker';
import { invalidateTokenCache } from '../github-auth';
import { logMainProcessInfo } from '../main-process-logging';
import { createGitHubBrokerClientFactory } from './client-factory';
import {
  getGitHubBrokerCredentialPort,
  type GitHubBrokerCredentialLease,
  type GitHubBrokerCredentialPort,
} from './credential-port';

export type {
  GitHubBrokerResult,
  GitHubQuotaDiagnostics,
  GitHubQuotaSnapshot,
  GitHubRateLimitResource,
  GitHubRateLimitSnapshot,
  GitHubRateLimitState,
  GitHubRawResponse,
  GitHubSpendSummary,
} from '@canopy/core-runtime/node/github/broker/broker';
export {
  GitHubBrokerCredentialResetError,
  GitHubBrokerError,
  GitHubBrokerLeaseExpiredError,
  GitHubBrokerTimeoutError,
  isGitHubBrokerError,
} from '@canopy/core-runtime/node/github/broker/broker';

export interface GitHubBrokerRequestOptions<
  T = unknown,
> extends CoreGitHubBrokerRequestOptions<T> {
  credential?: GitHubBrokerCredentialLease;
}

/** The core broker, typed for Electron main's Octokit and credential leases. */
export interface GitHubBroker extends Omit<
  CoreGitHubBroker<Octokit>,
  'execute' | 'currentQuota'
> {
  execute<T>(
    request: (
      octokit: Octokit,
      conditionalHeaders: Record<string, string>,
    ) => Promise<GitHubRawResponse<T>>,
    options: GitHubBrokerRequestOptions<T>,
  ): Promise<GitHubBrokerResult<T>>;
  currentQuota(
    resource?: GitHubRateLimitResource,
    credential?: GitHubBrokerCredentialLease,
  ): GitHubQuotaSnapshot | undefined;
}

/** The leases-only view of the port that core receives: no `authorize`. */
function credentialLeases(
  port: GitHubBrokerCredentialPort,
): GitHubBrokerCredentialLeases {
  return {
    defaultLease: port.defaultLease,
    verify: (lease: GitHubBrokerCredentialLease) => port.verify(lease),
    scopeId: (lease: GitHubBrokerCredentialLease) => port.scopeId(lease),
    isDefault: (lease: GitHubBrokerCredentialLease) => port.isDefault(lease),
  };
}

let singleton: GitHubBroker | null = null;

export function getGitHubBroker(): GitHubBroker {
  if (!singleton) {
    const credentialPort = getGitHubBrokerCredentialPort();
    singleton = createGitHubBroker({
      credentials: credentialLeases(credentialPort),
      client: createGitHubBrokerClientFactory(credentialPort),
      invalidateTokenCache,
      logMainProcessInfo,
    });
  }
  return singleton;
}

/** Test-only reset for fresh singleton state between isolated module tests. */
export function resetGitHubBrokerForTests(): void {
  singleton?.shutdown();
  singleton = null;
}
