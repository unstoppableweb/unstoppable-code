import {
  IPC_CHANNELS,
  type AccountOrganizationSettingsApi,
  type AccountOrganizationSettingsEventMessage,
  type AccountOrganizationSettingsResponse,
  type SettingsTranscriptDownloadResult,
} from '@canopy/desktop-shared/types';
import {
  isSettingsErrorCode,
  settingsPaymentHandoffAvailabilitySchema,
  settingsPaymentHandoffResultSchema,
  settingsRouteSchema,
  type SettingsErrorPayload,
  type SettingsEvent,
  type SettingsPaymentHandoffAvailability,
  type SettingsPaymentHandoffResult,
  type SettingsRoute,
} from '@canopy/protocol/settings';

type SettingsListener = (event: unknown, payload: unknown) => void;

type SettingsInvokeChannel =
  | typeof IPC_CHANNELS.accountOrganizationSettingsRead
  | typeof IPC_CHANNELS.accountOrganizationSettingsWrite
  | typeof IPC_CHANNELS.accountOrganizationSettingsSubscribe
  | typeof IPC_CHANNELS.accountOrganizationSettingsUnsubscribe
  | typeof IPC_CHANNELS.accountOrganizationSettingsPaymentHandoff
  | typeof IPC_CHANNELS.accountOrganizationSettingsPaymentHandoffAvailability
  | typeof IPC_CHANNELS.accountOrganizationSettingsDownloadTranscript;

type SettingsPushChannel =
  | typeof IPC_CHANNELS.accountOrganizationSettingsEvent
  | typeof IPC_CHANNELS.accountOrganizationSettingsOpen;

/** The part of the preload IPC router this bridge uses. */
export interface AccountOrganizationSettingsIpc {
  invoke(channel: SettingsInvokeChannel, request: unknown): Promise<unknown>;
  on(channel: SettingsPushChannel, listener: SettingsListener): unknown;
  removeListener(
    channel: SettingsPushChannel,
    listener: SettingsListener,
  ): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const MALFORMED_REPLY: AccountOrganizationSettingsResponse = {
  ok: false,
  error: { code: 'invalid_response' },
};

/** Main's reply as a fresh envelope; anything else is a malformed reply. */
function parseResponse(value: unknown): AccountOrganizationSettingsResponse {
  if (!isRecord(value)) return MALFORMED_REPLY;
  if (value.ok === true) return { ok: true, result: value.result };
  const error = value.error;
  if (
    value.ok !== false ||
    !isRecord(error) ||
    !isSettingsErrorCode(error.code)
  )
    return MALFORMED_REPLY;
  const payload: SettingsErrorPayload = { code: error.code };
  if (typeof error.message === 'string') payload.message = error.message;
  if (typeof error.status === 'number') payload.status = error.status;
  if (typeof error.serverCode === 'string')
    payload.serverCode = error.serverCode;
  return { ok: false, error: payload };
}

const DOWNLOAD_FAILURE_REASONS: ReadonlySet<unknown> = new Set([
  'invalid',
  'unauthenticated',
  'forbidden',
  'not_found',
  'gone',
  'too_large',
  'busy',
  'failed',
]);

function isDownloadFailureReason(
  value: unknown,
): value is Extract<SettingsTranscriptDownloadResult, { ok: false }>['reason'] {
  return DOWNLOAD_FAILURE_REASONS.has(value);
}

function parseDownloadResult(value: unknown): SettingsTranscriptDownloadResult {
  if (isRecord(value)) {
    if (value.ok === true && typeof value.saved === 'boolean')
      return { ok: true, saved: value.saved };
    if (value.ok === false && isDownloadFailureReason(value.reason))
      return { ok: false, reason: value.reason };
  }
  return { ok: false, reason: 'failed' };
}

const SETTINGS_EVENT_TYPES: ReadonlySet<unknown> = new Set([
  'feed.item',
  'credit.pool',
  'reconnected',
  'state',
]);

function isSettingsEvent(value: unknown): value is SettingsEvent {
  if (!isRecord(value) || !SETTINGS_EVENT_TYPES.has(value.type)) return false;
  // Only a personal credit-pool subscription's events omit the organization.
  if (value.type === 'feed.item')
    return typeof value.organizationId === 'string';
  return (
    value.organizationId === undefined ||
    typeof value.organizationId === 'string'
  );
}

function parseEventMessage(
  value: unknown,
): AccountOrganizationSettingsEventMessage | null {
  if (
    !isRecord(value) ||
    typeof value.subscriptionId !== 'string' ||
    !isSettingsEvent(value.event)
  )
    return null;
  return { subscriptionId: value.subscriptionId, event: value.event };
}

function subscribePush<T>(
  ipc: AccountOrganizationSettingsIpc,
  channel: SettingsPushChannel,
  parse: (payload: unknown) => T | null,
  callback: (value: T) => void,
): () => void {
  const listener: SettingsListener = (_event, payload): void => {
    const parsed = parse(payload);
    if (parsed !== null) callback(parsed);
  };
  let subscribed = true;
  ipc.on(channel, listener);
  return (): void => {
    if (!subscribed) return;
    subscribed = false;
    ipc.removeListener(channel, listener);
  };
}

/**
 * Preload bridge for hosted account and organization settings. Requests are
 * forwarded as named table calls; main validates them. Replies are checked
 * here so the renderer only sees well-formed envelopes.
 */
export function createAccountOrganizationSettingsApi(
  ipc: AccountOrganizationSettingsIpc,
): AccountOrganizationSettingsApi {
  return {
    read: async (request): Promise<AccountOrganizationSettingsResponse> =>
      parseResponse(
        await ipc.invoke(IPC_CHANNELS.accountOrganizationSettingsRead, {
          accountId: request.accountId,
          operation: request.operation,
          input: request.input,
        }),
      ),
    write: async (request): Promise<AccountOrganizationSettingsResponse> =>
      parseResponse(
        await ipc.invoke(IPC_CHANNELS.accountOrganizationSettingsWrite, {
          accountId: request.accountId,
          operation: request.operation,
          input: request.input,
        }),
      ),
    subscribe: async (request): Promise<AccountOrganizationSettingsResponse> =>
      parseResponse(
        await ipc.invoke(IPC_CHANNELS.accountOrganizationSettingsSubscribe, {
          accountId: request.accountId,
          subscriptionId: request.subscriptionId,
          scope: request.scope,
        }),
      ),
    unsubscribe: async (request): Promise<void> => {
      await ipc.invoke(IPC_CHANNELS.accountOrganizationSettingsUnsubscribe, {
        subscriptionId: request.subscriptionId,
      });
    },
    onEvent: (listener): (() => void) =>
      subscribePush(
        ipc,
        IPC_CHANNELS.accountOrganizationSettingsEvent,
        parseEventMessage,
        listener,
      ),
    paymentHandoff: async (request): Promise<SettingsPaymentHandoffResult> => {
      const parsed = settingsPaymentHandoffResultSchema.safeParse(
        await ipc.invoke(
          IPC_CHANNELS.accountOrganizationSettingsPaymentHandoff,
          {
            accountId: request.accountId,
            owner: request.owner,
            intent: request.intent,
          },
        ),
      );
      return parsed.success ? parsed.data : { ok: false, reason: 'failed' };
    },
    paymentHandoffAvailability: async (
      request,
    ): Promise<SettingsPaymentHandoffAvailability> => {
      const parsed = settingsPaymentHandoffAvailabilitySchema.safeParse(
        await ipc.invoke(
          IPC_CHANNELS.accountOrganizationSettingsPaymentHandoffAvailability,
          { accountId: request.accountId },
        ),
      );
      return parsed.success ? parsed.data : { available: false };
    },
    downloadTranscriptFile: async (
      request,
    ): Promise<SettingsTranscriptDownloadResult> =>
      parseDownloadResult(
        await ipc.invoke(
          IPC_CHANNELS.accountOrganizationSettingsDownloadTranscript,
          {
            accountId: request.accountId,
            path: request.path,
            suggestedName: request.suggestedName,
          },
        ),
      ),
    onOpenRequest: (listener): (() => void) =>
      subscribePush(
        ipc,
        IPC_CHANNELS.accountOrganizationSettingsOpen,
        (payload): SettingsRoute | null => {
          const parsed = settingsRouteSchema.safeParse(payload);
          return parsed.success ? parsed.data : null;
        },
        listener,
      ),
  };
}
