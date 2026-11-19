import { IPC_CHANNELS, type CanopyApi } from '@canopy/desktop-shared/types';
import {
  authenticatedCloudPageRequestSchema,
  authenticatedCloudPageResultSchema,
  type AuthenticatedCloudPageRequest,
  type AuthenticatedCloudPageResult,
} from '@canopy/desktop-shared/lib/authenticated-cloud-page-request';

export interface AuthenticatedCloudPageIpc {
  invoke(
    channel: typeof IPC_CHANNELS.settingsOpenAuthenticatedCloudPage,
    path: string,
  ): Promise<boolean>;
  invoke(
    channel: typeof IPC_CHANNELS.settingsOpenAuthenticatedCloudPage,
    request: AuthenticatedCloudPageRequest,
  ): Promise<unknown>;
}

/** Strict objects never retry through the legacy string overload. */
export function createAuthenticatedCloudPageApi(
  ipc: AuthenticatedCloudPageIpc,
): Pick<CanopyApi, 'openAuthenticatedCloudPage'> {
  function openAuthenticatedCloudPage(path: string): Promise<boolean>;
  function openAuthenticatedCloudPage(
    request: AuthenticatedCloudPageRequest,
  ): Promise<AuthenticatedCloudPageResult>;
  async function openAuthenticatedCloudPage(
    value: string | AuthenticatedCloudPageRequest,
  ): Promise<boolean | AuthenticatedCloudPageResult> {
    if (typeof value === 'string')
      return ipc.invoke(IPC_CHANNELS.settingsOpenAuthenticatedCloudPage, value);
    const request = authenticatedCloudPageRequestSchema.safeParse(value);
    if (!request.success) return { ok: false, reason: 'failed' };
    try {
      const result = authenticatedCloudPageResultSchema.safeParse(
        await ipc.invoke(
          IPC_CHANNELS.settingsOpenAuthenticatedCloudPage,
          request.data,
        ),
      );
      return result.success ? result.data : { ok: false, reason: 'failed' };
    } catch {
      return { ok: false, reason: 'failed' };
    }
  }
  return { openAuthenticatedCloudPage };
}
