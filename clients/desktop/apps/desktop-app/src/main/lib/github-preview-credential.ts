import {
  readCanopyCloudAccountWithStatus,
  subscribeCanopyCloudAccountChanges,
  type CanopyCloudAccountEntry,
} from './canopy-cloud-account-store';
import {
  getGitHubBrokerCredentialPort,
  type GitHubBrokerCredentialLease,
} from './github-broker/credential-port';

function accountIdentity(entry: CanopyCloudAccountEntry | null): string | null {
  return entry
    ? `${entry.account?.id ?? ''}\0${entry.createdAt}\0${entry.apiKey}`
    : null;
}

export function githubPreviewAccountIdentity(
  entry: CanopyCloudAccountEntry | null,
): string {
  return entry
    ? `${entry.account?.id ?? ''}\0${entry.createdAt}\0${entry.apiKey}`
    : '';
}

// `undefined` until an account event or successful read proves an identity:
// the store's peek is `null` both on a cold cache and after sign-out, so the
// first proof is adopted rather than fenced as a replacement.
let cloudIdentity: string | null | undefined;
let cloudIdentityGeneration = 0;
function observeCloudIdentity(entry: CanopyCloudAccountEntry | null): void {
  const next = accountIdentity(entry);
  if (cloudIdentity !== undefined && next !== cloudIdentity) {
    cloudIdentityGeneration += 1;
  }
  cloudIdentity = next;
}
subscribeCanopyCloudAccountChanges(observeCloudIdentity);

export function getCloudAccountIdentityGeneration(): number {
  return cloudIdentityGeneration;
}

/**
 * The account identity that scopes GitHub previews; `''` when confirmed signed
 * out. Throws when the account cannot be read, which is unknown rather than a
 * sign-out, so callers keep what they show and change no generation.
 */
export async function readGitHubPreviewAccountIdentity(): Promise<string> {
  const read = await readCanopyCloudAccountWithStatus();
  if (read.status !== 'ok') {
    throw new Error('Cloud account state is unavailable.');
  }
  observeCloudIdentity(read.entry);
  return githubPreviewAccountIdentity(read.entry);
}

/** Tracking needs GitHub authentication; preview provenance is optional. */
export async function readGitHubTrackingCredential(): Promise<{
  credential: GitHubBrokerCredentialLease;
  authenticationScope: string;
  scope: string | undefined;
} | null> {
  const port = getGitHubBrokerCredentialPort();
  const grant = await port.lease('resolved').catch(() => null);
  if (!grant) return null;
  const accountId = await readGitHubPreviewAccountIdentity().catch(() => null);
  return {
    credential: grant.lease,
    authenticationScope: await port.derivedScope(grant.lease, {
      kind: 'pr-tracking',
    }),
    scope:
      accountId === null
        ? undefined
        : await port.derivedScope(grant.lease, {
            kind: 'reference-preview',
            accountIdentity: accountId,
          }),
  };
}
