import {
  authenticatedCloudPageRequestSchema,
  authenticatedCloudPageResultSchema,
  classifyAuthenticatedCloudPagePath,
  normalizeAuthenticatedCloudPageOrigin,
  type AuthenticatedCloudPageResult,
} from '@canopy/desktop-shared/lib/authenticated-cloud-page-request';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import {
  getCanopyCloudCredentials,
  loadCanopyCloudAccount,
} from '../lib/canopy-cloud-account-store';
import {
  openAuthenticatedCloudPage,
  openStrictAuthenticatedCloudPage,
} from '../canopy-cloud/authenticated-cloud-page';

/** Main owns credentials; renderer identity and origin are assertions only. */
export async function openAuthenticatedCloudPageRequest(
  value: unknown,
): Promise<AuthenticatedCloudPageResult> {
  const request = authenticatedCloudPageRequestSchema.safeParse(value);
  if (!request.success) return { ok: false, reason: 'failed' };
  try {
    const snapshot = await loadCanopyCloudAccount();
    if (
      !snapshot?.account?.id ||
      isGuestAccount(snapshot) ||
      !snapshot.apiKey.trim()
    )
      return { ok: false, reason: 'unavailable' };
    const credentials = await getCanopyCloudCredentials().catch(() => null);
    if (!credentials?.account?.id || !credentials.apiKey.trim())
      return { ok: false, reason: 'unavailable' };
    const origin = normalizeAuthenticatedCloudPageOrigin(credentials.baseUrl);
    if (
      credentials.account.id !== snapshot.account.id ||
      credentials.apiKey !== snapshot.apiKey ||
      request.data.accountId !== snapshot.account.id ||
      origin === null ||
      origin !== normalizeAuthenticatedCloudPageOrigin(request.data.webOrigin)
    )
      return { ok: false, reason: 'identity_changed' };
    if (
      classifyAuthenticatedCloudPagePath(request.data.path) !==
      request.data.kind
    )
      return { ok: false, reason: 'failed' };
    const result = authenticatedCloudPageResultSchema.safeParse(
      request.data.kind === 'payment'
        ? await openStrictAuthenticatedCloudPage(request.data.path, credentials)
        : await openAuthenticatedCloudPage(request.data.path, {
            requireAuthentication: true,
            credentialContext: credentials,
          }),
    );
    return result.success ? result.data : { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}
