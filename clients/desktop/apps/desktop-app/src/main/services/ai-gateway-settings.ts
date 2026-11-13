import type { AiGatewayConnectionResult } from '@canopy/protocol/model-gateway/discovery';
import {
  aiGatewayConnectSchema,
  type AiGatewayScope,
} from '@canopy/protocol/model-gateway';
import { z } from 'zod';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  SettingsOperationError,
  settingsErrorCodeForStatus,
  type SettingsOperationName,
} from '@canopy/protocol/settings';
import { getFeatureFlagService } from '../feature-flags';
import type { SettingsBridgeSession } from '../canopy-cloud/settings-session';
import {
  readCanopyCloudAccountWithStatus,
  subscribeCanopyCloudAccountChanges,
} from '../lib/canopy-cloud-account-store';
import {
  loadModelGatewayCredential,
  GatewayCredentialStorageUnavailableError,
} from '../lib/model-gateway-credential-store';
import { probeModelGateway } from './model-gateway-probe';

export function requireAiGatewaySettings(): void {
  if (
    !getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyAiGatewaySettingsEnabled.key,
    )
  )
    throw new SettingsOperationError({ code: 'not_found' });
}
export async function authorizeDesktopGatewayScope(
  session: SettingsBridgeSession,
  scope: AiGatewayScope,
  intent: 'read' | 'connect' | 'update' = 'connect',
): Promise<string> {
  requireAiGatewaySettings();
  const current = await readCanopyCloudAccountWithStatus();
  if (
    current.status !== 'ok' ||
    current.entry?.account?.id !== session.accountId ||
    session.state === 'disposed'
  )
    throw new SettingsOperationError({ code: 'expired' });
  const response = await session.fetch(
    '/api/v1/settings/ai-gateway/authorize',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope, intent }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok)
    throw new SettingsOperationError({
      code: settingsErrorCodeForStatus(response.status, { write: false }),
      status: response.status,
      ...(response.status === 409 ? { serverCode: 'stale_scope' } : {}),
    });
  const value: unknown = await response.json();
  const result = z.object({ organizationId: z.uuid() }).safeParse(value);
  const expected =
    scope.kind === 'personal'
      ? scope.expectedOrganizationId
      : scope.organizationId;
  if (!result.success || result.data.organizationId !== expected)
    throw new SettingsOperationError({ code: 'invalid_response' });
  return expected;
}

/** Called only by main's operation dispatcher. No API key reaches hosted settings. */
export async function connectDesktopGateway(
  session: SettingsBridgeSession,
  name: SettingsOperationName,
  raw: unknown,
  signal?: AbortSignal,
): Promise<AiGatewayConnectionResult> {
  const personal = name === 'account.settings.ai-gateway.connect';
  const parsed = personal
    ? aiGatewayConnectSchema
        .extend({ expectedOrganizationId: z.uuid() })
        .parse(raw)
    : aiGatewayConnectSchema.extend({ organizationId: z.uuid() }).parse(raw);
  const scope: AiGatewayScope =
    'expectedOrganizationId' in parsed
      ? {
          kind: 'personal',
          expectedOrganizationId: parsed.expectedOrganizationId,
        }
      : { kind: 'organization', organizationId: parsed.organizationId };
  const organizationId = await authorizeDesktopGatewayScope(session, scope);
  const lifetime = new AbortController();
  const stopAccountWatch = subscribeCanopyCloudAccountChanges((next) => {
    if (
      next?.account?.id !== session.accountId ||
      (scope.kind === 'personal' &&
        next.personalOrganizationId !== organizationId)
    )
      lifetime.abort();
  });
  const connectionSignal = signal
    ? AbortSignal.any([signal, lifetime.signal])
    : lifetime.signal;
  const { enqueueModelGatewayCredentialSave } = await import('../ipc/settings');
  try {
    return await enqueueModelGatewayCredentialSave(
      organizationId,
      async (): Promise<AiGatewayConnectionResult> => {
        connectionSignal.throwIfAborted();
        const saved = parsed.apiKey
          ? null
          : await loadModelGatewayCredential(organizationId, parsed.baseUrl);
        const apiKey = parsed.apiKey ?? saved?.apiKey;
        if (!apiKey) return { status: 'key_required' };
        const result = await probeModelGateway({
          baseUrl: parsed.baseUrl,
          apiKey,
          signal: connectionSignal,
        });
        if (result.status !== 'connected') return result;
        await authorizeDesktopGatewayScope(session, scope);
        if (parsed.apiKey) {
          // Reuses serialized validation/storage, including endpoint staging and identity fencing.
          const { saveModelGatewayCredentialInOrder } =
            await import('../ipc/settings');
          const validation = await saveModelGatewayCredentialInOrder(
            {
              organizationId,
              baseUrl: result.baseUrl,
              apiKey,
            },
            {
              signal: connectionSignal,
              expectedAccountId: session.accountId,
              beforeSave: async () => {
                await authorizeDesktopGatewayScope(session, scope);
              },
            },
          );
          if (!validation.valid) return { status: 'unreachable' };
        }
        return result;
      },
    );
  } catch (error) {
    if (error instanceof GatewayCredentialStorageUnavailableError)
      throw new SettingsOperationError({
        code: 'failed',
        serverCode: 'secure_storage_unavailable',
      });
    if (error instanceof SettingsOperationError) throw error;
    // Do not include storage/network errors, which can contain secrets.
    throw new SettingsOperationError({
      code: 'failed',
      serverCode: 'secure_storage_failed',
    });
  } finally {
    stopAccountWatch();
  }
}
