import { z } from 'zod';
import { join } from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import {
  IPC_CHANNELS,
  type AccountOrganizationSettingsResponse,
  type SettingsTranscriptDownloadResult,
} from '@canopy/desktop-shared/types';
import {
  settingsPaymentHandoffRequestSchema,
  settingsSubscriptionScopeSchema,
  type SettingsPaymentHandoffAvailability,
  type SettingsPaymentHandoffResult,
} from '@canopy/protocol/settings';
import { registerIpcHandler } from './register';
import type { AccountOrganizationSettingsService } from '../services/account-organization-settings';

const getService = async (): Promise<AccountOrganizationSettingsService> =>
  (
    await import('../services/account-organization-settings-host')
  ).getAccountOrganizationSettingsService();

const accountIdSchema = z.string().min(1).max(256);
const subscriptionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/**
 * The whole renderer request. Strict, so a renderer cannot add a URL, method,
 * header, identity or upload target; `input` is validated by main against
 * the named table entry.
 */
const operationRequestSchema = z.strictObject({
  accountId: accountIdSchema,
  operation: z.string().min(1).max(128),
  input: z.unknown(),
});

const subscribeRequestSchema = z.strictObject({
  accountId: accountIdSchema,
  subscriptionId: subscriptionIdSchema,
  scope: settingsSubscriptionScopeSchema,
});

const unsubscribeRequestSchema = z.strictObject({
  subscriptionId: subscriptionIdSchema,
});

const paymentHandoffRequestSchema = settingsPaymentHandoffRequestSchema.extend({
  accountId: accountIdSchema,
});

const availabilityRequestSchema = z.strictObject({
  accountId: accountIdSchema,
});

const INVALID_REQUEST: AccountOrganizationSettingsResponse = {
  ok: false,
  error: { code: 'failed', message: 'Invalid settings request' },
};

/**
 * Hosted account and organization settings over the main bridge session.
 * Compatibility IPC for a main-owned hosted session: no `core.*` or
 * `worker.*` operation exists for these calls.
 *
 * Returns a teardown that closes every window subscription and removes the
 * bridge lifecycle hooks.
 */
export function registerAccountOrganizationSettingsHandlers(): () => void {
  registerIpcHandler(
    IPC_CHANNELS.accountOrganizationSettingsRead,
    async (
      _event,
      value: unknown,
    ): Promise<AccountOrganizationSettingsResponse> => {
      const request = operationRequestSchema.safeParse(value);
      if (!request.success) return INVALID_REQUEST;
      return (await getService()).read(request.data);
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.accountOrganizationSettingsWrite,
    async (
      _event,
      value: unknown,
    ): Promise<AccountOrganizationSettingsResponse> => {
      const request = operationRequestSchema.safeParse(value);
      if (!request.success) return INVALID_REQUEST;
      return (await getService()).write(request.data);
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.accountOrganizationSettingsSubscribe,
    async (
      event,
      value: unknown,
    ): Promise<AccountOrganizationSettingsResponse> => {
      const request = subscribeRequestSchema.safeParse(value);
      if (!request.success) return INVALID_REQUEST;
      return (await getService()).subscribe(event.sender, request.data);
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.accountOrganizationSettingsUnsubscribe,
    async (event, value: unknown): Promise<void> => {
      const request = unsubscribeRequestSchema.safeParse(value);
      if (!request.success) return;
      (await getService()).unsubscribe(
        event.sender,
        request.data.subscriptionId,
      );
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.accountOrganizationSettingsPaymentHandoff,
    async (_event, value: unknown): Promise<SettingsPaymentHandoffResult> => {
      const request = paymentHandoffRequestSchema.safeParse(value);
      if (!request.success) return { ok: false, reason: 'failed' };
      return (await getService()).paymentHandoff(request.data);
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.accountOrganizationSettingsPaymentHandoffAvailability,
    async (
      _event,
      value: unknown,
    ): Promise<SettingsPaymentHandoffAvailability> => {
      const request = availabilityRequestSchema.safeParse(value);
      if (!request.success) return { available: false };
      return (await getService()).paymentHandoffAvailability(
        request.data.accountId,
      );
    },
  );
  // Organization transcript downloads (owners only): main asks where to save,
  // then fetches with the signed-in account's own credential and origin.
  registerIpcHandler(
    IPC_CHANNELS.accountOrganizationSettingsDownloadTranscript,
    async (
      event,
      value: unknown,
    ): Promise<SettingsTranscriptDownloadResult> => {
      const [{ downloadOrganizationTranscript }, client, cloudChats] =
        await Promise.all([
          import('../services/organization-transcript-download'),
          import('../canopy-cloud/client'),
          import('./cloud-chats'),
        ]);
      return downloadOrganizationTranscript(value, {
        signedInAccountId: cloudChats.signedInAccountId,
        readCredentials: async () => {
          const context = await client.resolveCanopyCloudCredentialContext();
          return { baseUrl: context.baseUrl, apiKey: context.apiKey };
        },
        choosePath: async (suggestedName) => {
          const options = {
            defaultPath: join(app.getPath('downloads'), suggestedName),
          };
          const window = BrowserWindow.fromWebContents(event.sender);
          const result = window
            ? await dialog.showSaveDialog(window, options)
            : await dialog.showSaveDialog(options);
          return result.canceled || result.filePath === undefined
            ? null
            : result.filePath;
        },
        fetch: (input, init) => fetch(input, init),
      });
    },
  );

  let closed = false;
  let uninstallLifecycle: (() => void) | null = null;
  // Loaded off the startup path; sessions are created only by these handlers,
  // which load the same module after this import was requested.
  void import('../canopy-cloud/settings-session')
    .then(({ installSettingsBridgeLifecycle }) => {
      if (!closed) uninstallLifecycle = installSettingsBridgeLifecycle();
    })
    .catch(() => undefined);
  return (): void => {
    closed = true;
    uninstallLifecycle?.();
    uninstallLifecycle = null;
    void import('../services/account-organization-settings-host')
      .then(({ disposeAccountOrganizationSettingsService }) =>
        disposeAccountOrganizationSettingsService(),
      )
      .catch(() => undefined);
  };
}
