import { randomUUID } from 'node:crypto';
import {
  IPC_CHANNELS,
  type AccountOrganizationSettingsEventMessage,
  type AccountOrganizationSettingsResponse,
} from '@canopy/desktop-shared/types';
import {
  accountBillingPath,
  buildBillingPaymentModalIntentPath,
  buildBillingTopUpIntentPath,
  isBillingRequestId,
  organizationBillingPath,
} from '@canopy/protocol/billing';
import {
  SettingsOperationError,
  isSettingsReadName,
  isSettingsWriteName,
  paymentModalIntentForHandoff,
  settingsBootstrapHasOrganization,
  settingsBootstrapSchema,
  settingsOperation,
  validateSettingsOperationInput,
  validateSettingsOperationResult,
  type SettingsErrorPayload,
  type SettingsEvent,
  type SettingsOperationName,
  type SettingsPaymentHandoffAvailability,
  type SettingsPaymentHandoffRequest,
  type SettingsPaymentHandoffResult,
  type SettingsSubscriptionScope,
} from '@canopy/protocol/settings';
import type { CanopyCloudCredentialContext } from '../canopy-cloud/client';
import type { StrictAuthenticatedPortalResult } from '../canopy-cloud/authenticated-portal';
import { sendToWebContents } from '../lib/web-contents-send';
import { isRecord } from '../lib/type-guards';
import { logMainProcessWarn } from '../lib/main-process-logging';

/**
 * Main-side dispatch for hosted account and organization settings.
 *
 * The renderer names a fixed `SETTINGS_OPERATIONS` entry and sends its input;
 * this module re-validates both, executes the entry through the isolated
 * settings bridge session of the asserted account, fences the result against
 * an account change, and returns an `AccountOrganizationSettingsResponse`.
 * Nothing the renderer sends selects a URL, method, header, identity, or
 * upload target.
 *
 * Error codes for refusals that never reach the server:
 * - unknown name, wrong kind, malformed or oversized input, or a malformed
 *   upload file: `failed` (the renderer asked for something the table does
 *   not allow; there is no server response to call `invalid_response`).
 * - asserted account is not the signed-in one: `unauthenticated` (from the
 *   bridge session).
 * - the account or session generation changed while the call was in flight:
 *   the result is discarded; `expired` for reads, `uncertain` for writes,
 *   because the write may have landed.
 * - an unexpected non-settings error: `failed` for reads, `uncertain` for
 *   writes, because a write may have reached the server.
 *
 * Every renderer read and write is treated as user-initiated, so an expired
 * session may remint once on that call. Stream subscriptions are not: a
 * subscription never remints an expired session.
 */

/** Field of an upload entry's input that carries the file from the renderer. */
export const SETTINGS_UPLOAD_FILE_FIELD = 'file';

export type SettingsBridgeSessionState =
  | 'uninitialized'
  | 'minting'
  | 'ready'
  | 'expired'
  | 'disposed';

/** The part of a settings bridge session this module uses. */
export interface SettingsSessionPort {
  readonly accountId: string;
  readonly generation: number;
  readonly state: SettingsBridgeSessionState;
  ensureReady(options?: { userInitiated?: boolean }): Promise<void>;
  onStateChange(
    listener: (state: SettingsBridgeSessionState) => void,
  ): () => void;
}

export interface SettingsExecuteOptions {
  signal?: AbortSignal;
  uploadBytes?: Uint8Array;
  uploadContentType?: string;
}

export interface SettingsFeedStreamHandle {
  close(): void;
}

/**
 * A table call executed through existing desktop orchestration instead of a
 * raw table request. It returns the entry's result shape, which is validated
 * again before it is returned.
 */
export type SettingsOrchestratedOperation = () => Promise<unknown>;

/**
 * Chooses existing orchestration for a validated table call, or `null` to
 * execute the entry through the bridge session.
 */
export type SettingsOrchestrationResolver = (
  name: SettingsOperationName,
  validatedInput: unknown,
) => SettingsOrchestratedOperation | null;

/** Best-effort synchronization after a confirmed, validated write. */
export type SettingsWriteFollowUp = () => Promise<void>;
export type SettingsWriteFollowUpResolver = (
  name: SettingsOperationName,
  validatedInput: unknown,
  /** The signed-in account the write was authorized for. */
  accountId: string,
) => SettingsWriteFollowUp | null;

export type SettingsWriteObserver = (
  name: SettingsOperationName,
  validatedInput: unknown,
  validatedResult: unknown,
  accountId: string,
) => void;

export interface AccountOrganizationSettingsDeps<
  TSession extends SettingsSessionPort,
> {
  /** Throws `SettingsOperationError('unauthenticated')` for another account. */
  acquireSession(this: void, accountId: string): Promise<TSession>;
  execute(
    this: void,
    session: TSession,
    name: SettingsOperationName,
    validatedInput: unknown,
    options?: SettingsExecuteOptions,
  ): Promise<unknown>;
  openFeedStream(
    this: void,
    session: TSession,
    scope: SettingsSubscriptionScope,
    handlers: { onEvent(event: SettingsEvent): void },
  ): SettingsFeedStreamHandle;
  credentials(
    this: void,
    accountId: string,
  ): Promise<CanopyCloudCredentialContext>;
  /** The signed-in account id, or null when signed out or unreadable. */
  currentAccountId(this: void): Promise<string | null>;
  /** The live bridge session, read from memory; never creates one. */
  currentSession(this: void): TSession | null;
  /**
   * The signed-in account id from main's in-memory account: null when signed
   * out, undefined when main holds no snapshot yet. Never reads storage.
   */
  signedInAccountId(this: void): string | null | undefined;
  subscribeAccountChanges(
    this: void,
    listener: (accountId: string | null) => void,
  ): () => void;
  openStrictPortalPage(
    this: void,
    path: string,
    credentialContext: CanopyCloudCredentialContext,
  ): Promise<StrictAuthenticatedPortalResult>;
  paymentHandoffAvailable(this: void, accountId: string): Promise<boolean>;
  /** Table calls routed through existing desktop orchestration. */
  resolveOrchestrated?: SettingsOrchestrationResolver;
  /** Await synchronization without turning a confirmed write into a retry. */
  resolveWriteFollowUp?: SettingsWriteFollowUpResolver;
  /** Synchronous no-throw observation before unrelated synchronization. */
  observeWrite?: SettingsWriteObserver;
  randomId?(this: void): string;
}

/** The window that owns a subscription. Structural over `WebContents`. */
export interface SettingsEventSender {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  once(event: 'destroyed', listener: () => void): unknown;
  on(event: 'did-navigate', listener: () => void): unknown;
  removeListener(
    event: 'destroyed' | 'did-navigate',
    listener: () => void,
  ): unknown;
}

export interface AccountOrganizationSettingsOperationRequest {
  accountId: string;
  operation: string;
  input: unknown;
}

export interface AccountOrganizationSettingsSubscribeRequest {
  accountId: string;
  subscriptionId: string;
  scope: SettingsSubscriptionScope;
}

export interface AccountOrganizationSettingsService {
  read(
    this: void,
    request: AccountOrganizationSettingsOperationRequest,
  ): Promise<AccountOrganizationSettingsResponse>;
  write(
    this: void,
    request: AccountOrganizationSettingsOperationRequest,
  ): Promise<AccountOrganizationSettingsResponse>;
  subscribe(
    this: void,
    sender: SettingsEventSender,
    request: AccountOrganizationSettingsSubscribeRequest,
  ): Promise<AccountOrganizationSettingsResponse>;
  unsubscribe(
    this: void,
    sender: SettingsEventSender,
    subscriptionId: string,
  ): void;
  paymentHandoff(
    this: void,
    request: SettingsPaymentHandoffRequest & { accountId: string },
  ): Promise<SettingsPaymentHandoffResult>;
  paymentHandoffAvailability(
    this: void,
    accountId: string,
  ): Promise<SettingsPaymentHandoffAvailability>;
  /** Number of open window subscriptions (diagnostics and tests). */
  subscriptionCount(this: void): number;
  dispose(this: void): void;
}

function failure(
  code: SettingsErrorPayload['code'],
  message?: string,
): AccountOrganizationSettingsResponse {
  return {
    ok: false,
    error: message === undefined ? { code } : { code, message },
  };
}

type PreparedInput =
  | {
      ok: true;
      name: SettingsOperationName;
      input: unknown;
      upload?: { bytes: Uint8Array; contentType: string };
    }
  | { ok: false; response: AccountOrganizationSettingsResponse };

/**
 * Split the renderer's upload file from the entry's input, enforcing the
 * table's size and type limits before the rest of the input is examined.
 */
function splitUploadInput(
  name: SettingsOperationName,
  input: unknown,
):
  | { ok: true; input: unknown; bytes: Uint8Array; contentType: string }
  | { ok: false; response: AccountOrganizationSettingsResponse } {
  const upload = settingsOperation(name).upload;
  if (upload === undefined)
    return { ok: false, response: failure('failed', 'Upload unavailable') };
  if (!isRecord(input))
    return { ok: false, response: failure('failed', 'Invalid input') };
  const file = input[SETTINGS_UPLOAD_FILE_FIELD];
  if (
    !isRecord(file) ||
    !(file.bytes instanceof Uint8Array) ||
    typeof file.contentType !== 'string'
  )
    return { ok: false, response: failure('failed', 'Invalid upload file') };
  if (file.bytes.byteLength > upload.maxBytes)
    return { ok: false, response: failure('failed', 'Upload too large') };
  if (file.bytes.byteLength === 0)
    return { ok: false, response: failure('failed', 'Invalid upload file') };
  const contentType = file.contentType.toLowerCase();
  if (!upload.contentTypes.includes(contentType))
    return {
      ok: false,
      response: failure('failed', 'Unsupported upload type'),
    };
  const rest = Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== SETTINGS_UPLOAD_FILE_FIELD),
  );
  // Entries that declare the file's size or type to the signing route must
  // declare the bytes actually sent.
  if (
    (typeof rest.size === 'number' && rest.size !== file.bytes.byteLength) ||
    (typeof rest.mimeType === 'string' &&
      rest.mimeType.toLowerCase() !== contentType)
  )
    return { ok: false, response: failure('failed', 'Invalid upload file') };
  return { ok: true, input: rest, bytes: file.bytes, contentType };
}

function prepareInput(
  kind: 'read' | 'write',
  operation: string,
  input: unknown,
): PreparedInput {
  const name: SettingsOperationName | null =
    kind === 'read'
      ? isSettingsReadName(operation)
        ? operation
        : null
      : isSettingsWriteName(operation)
        ? operation
        : null;
  if (name === null)
    return {
      ok: false,
      response: failure('failed', 'Unknown settings operation'),
    };
  let upload: { bytes: Uint8Array; contentType: string } | undefined;
  let rest: unknown = input;
  if (settingsOperation(name).transport === 'upload') {
    const split = splitUploadInput(name, input);
    if (!split.ok) return split;
    upload = { bytes: split.bytes, contentType: split.contentType };
    rest = split.input;
  }
  const validation = validateSettingsOperationInput(name, rest);
  if (!validation.ok)
    return {
      ok: false,
      response: failure(
        'failed',
        validation.reason === 'too_large' ? 'Input too large' : 'Invalid input',
      ),
    };
  return upload === undefined
    ? { ok: true, name, input: validation.input }
    : { ok: true, name, input: validation.input, upload };
}

function errorResponse(
  error: unknown,
  write: boolean,
): AccountOrganizationSettingsResponse {
  if (error instanceof SettingsOperationError)
    return { ok: false, error: error.toPayload() };
  return failure(write ? 'uncertain' : 'failed');
}

/** A billing request id from a fresh UUID, filtered to the allowed charset. */
function billingRequestId(random: () => string): string {
  const id = random().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!isBillingRequestId(id)) throw new Error('Invalid billing request id');
  return id;
}

function billingHandoffPath(
  request: SettingsPaymentHandoffRequest,
  requestId: string,
): string {
  const billingPath =
    request.owner.kind === 'organization'
      ? organizationBillingPath(request.owner.organizationId)
      : accountBillingPath();
  const intent = request.intent;
  if (intent.kind === 'top-up')
    return buildBillingTopUpIntentPath(billingPath, {
      reason: intent.reason,
      source: intent.source ?? 'desktop',
      ...(intent.modelId === undefined ? {} : { modelId: intent.modelId }),
      ...(intent.chatId === undefined ? {} : { chatId: intent.chatId }),
      ...(intent.amountUsd === undefined
        ? {}
        : { amountUsd: intent.amountUsd }),
      requestId,
    });
  return buildBillingPaymentModalIntentPath(
    billingPath,
    paymentModalIntentForHandoff(intent, requestId),
  );
}

interface StreamEntry {
  readonly key: string;
  readonly sender: SettingsEventSender;
  readonly subscriptionId: string;
  readonly accountId: string;
  stream: SettingsFeedStreamHandle | null;
  stopSessionWatch: () => void;
}

interface SenderEntry {
  readonly subscriptions: Set<string>;
  readonly release: () => void;
}

export function createAccountOrganizationSettingsService<
  TSession extends SettingsSessionPort,
>(
  deps: AccountOrganizationSettingsDeps<TSession>,
): AccountOrganizationSettingsService {
  const random = deps.randomId ?? ((): string => randomUUID());
  const streams = new Map<string, StreamEntry>();
  const senders = new Map<number, SenderEntry>();

  const streamKey = (
    sender: SettingsEventSender,
    subscriptionId: string,
  ): string => `${sender.id}:${subscriptionId}`;

  function closeStream(entry: StreamEntry): void {
    if (streams.get(entry.key) !== entry) return;
    streams.delete(entry.key);
    entry.stopSessionWatch();
    const stream = entry.stream;
    entry.stream = null;
    stream?.close();
    const owner = senders.get(entry.sender.id);
    if (owner === undefined) return;
    owner.subscriptions.delete(entry.subscriptionId);
    if (owner.subscriptions.size === 0) {
      senders.delete(entry.sender.id);
      owner.release();
    }
  }

  function closeSender(sender: SettingsEventSender): void {
    const owner = senders.get(sender.id);
    if (owner === undefined) return;
    for (const subscriptionId of Array.from(owner.subscriptions)) {
      const entry = streams.get(streamKey(sender, subscriptionId));
      if (entry !== undefined) closeStream(entry);
    }
  }

  function trackSender(
    sender: SettingsEventSender,
    subscriptionId: string,
  ): void {
    const existing = senders.get(sender.id);
    if (existing !== undefined) {
      existing.subscriptions.add(subscriptionId);
      return;
    }
    const onGone = (): void => closeSender(sender);
    sender.once('destroyed', onGone);
    // A reload keeps the same WebContents; its new page owns none of these.
    sender.on('did-navigate', onGone);
    senders.set(sender.id, {
      subscriptions: new Set([subscriptionId]),
      release: (): void => {
        sender.removeListener('destroyed', onGone);
        sender.removeListener('did-navigate', onGone);
      },
    });
  }

  function deliver(entry: StreamEntry, event: SettingsEvent): void {
    if (streams.get(entry.key) !== entry || entry.sender.isDestroyed()) return;
    const message: AccountOrganizationSettingsEventMessage = {
      subscriptionId: entry.subscriptionId,
      event,
    };
    try {
      sendToWebContents(
        entry.sender,
        IPC_CHANNELS.accountOrganizationSettingsEvent,
        message,
      );
    } catch {
      // The window went away between the check and the send.
      closeStream(entry);
    }
  }

  const stopAccountWatch = deps.subscribeAccountChanges((accountId) => {
    for (const entry of Array.from(streams.values()))
      if (entry.accountId !== accountId) closeStream(entry);
  });

  /**
   * Whether `session` is still the live session of the signed-in account.
   * Reads memory only, so an unreadable credential store cannot turn a
   * completed operation into `uncertain` or `expired`. Without an in-memory
   * account snapshot the account check is inconclusive; disposal and the
   * live session still fence, since the lifecycle disposes on any identity
   * or credential change.
   */
  function stillCurrent(accountId: string, session: TSession): boolean {
    const signedIn = deps.signedInAccountId();
    return (
      session.state !== 'disposed' &&
      deps.currentSession() === session &&
      (signedIn === undefined || signedIn === accountId)
    );
  }

  async function run(
    kind: 'read' | 'write',
    request: AccountOrganizationSettingsOperationRequest,
  ): Promise<AccountOrganizationSettingsResponse> {
    const prepared = prepareInput(kind, request.operation, request.input);
    if (!prepared.ok) return prepared.response;
    const write = kind === 'write';
    try {
      const session = await deps.acquireSession(request.accountId);
      if (session.accountId !== request.accountId) return failure('expired');
      await session.ensureReady({ userInitiated: true });
      const orchestrated =
        deps.resolveOrchestrated?.(prepared.name, prepared.input) ?? null;
      let result: unknown;
      if (orchestrated !== null) {
        const raw = await orchestrated();
        const validated = validateSettingsOperationResult(prepared.name, raw);
        if (!validated.ok) return failure('invalid_response');
        result = validated.result;
      } else {
        result = await deps.execute(
          session,
          prepared.name,
          prepared.input,
          prepared.upload === undefined
            ? undefined
            : {
                uploadBytes: prepared.upload.bytes,
                uploadContentType: prepared.upload.contentType,
              },
        );
      }
      if (!stillCurrent(request.accountId, session))
        return failure(write ? 'uncertain' : 'expired');
      if (write) {
        // The bridge validates too; enforce the same boundary for every port
        // before resolving any post-write work.
        const validated = validateSettingsOperationResult(
          prepared.name,
          result,
        );
        if (!validated.ok) return failure('invalid_response');
        result = validated.result;
        try {
          deps.observeWrite?.(
            prepared.name,
            prepared.input,
            result,
            request.accountId,
          );
        } catch {
          /* Product telemetry must not change the result or retries. */
        }
        try {
          const followUp = deps.resolveWriteFollowUp?.(
            prepared.name,
            prepared.input,
            request.accountId,
          );
          if (followUp !== undefined && followUp !== null) await followUp();
        } catch (error) {
          // Resolver and refresh errors may contain credentials or payloads,
          // so only the error's class name is logged. The periodic account
          // refresh retries synchronization.
          logMainProcessWarn('[settings] Post-write follow-up failed', {
            operation: prepared.name,
            errorName:
              error instanceof Error ? error.constructor.name : typeof error,
          });
        }
        if (!stillCurrent(request.accountId, session))
          return failure('uncertain');
      }
      return { ok: true, result };
    } catch (error) {
      return errorResponse(error, write);
    }
  }

  async function subscribe(
    sender: SettingsEventSender,
    request: AccountOrganizationSettingsSubscribeRequest,
  ): Promise<AccountOrganizationSettingsResponse> {
    if (sender.isDestroyed()) return failure('failed');
    const key = streamKey(sender, request.subscriptionId);
    const previous = streams.get(key);
    if (previous !== undefined) closeStream(previous);
    const entry: StreamEntry = {
      key,
      sender,
      subscriptionId: request.subscriptionId,
      accountId: request.accountId,
      stream: null,
      stopSessionWatch: () => undefined,
    };
    // Registered before the first await so an unsubscribe or a destroyed
    // window during session setup cancels the pending stream.
    streams.set(key, entry);
    trackSender(sender, request.subscriptionId);
    try {
      const session = await deps.acquireSession(request.accountId);
      if (session.accountId !== request.accountId) {
        closeStream(entry);
        return failure('expired');
      }
      await session.ensureReady({ userInitiated: false });
      if (
        streams.get(key) !== entry ||
        !stillCurrent(request.accountId, session)
      ) {
        const cancelled = streams.get(key) !== entry;
        closeStream(entry);
        return cancelled ? { ok: true, result: null } : failure('expired');
      }
      entry.stopSessionWatch = session.onStateChange((state) => {
        if (state !== 'disposed') return;
        const organizationId = request.scope.organizationId;
        deliver(entry, {
          type: 'state',
          ...(organizationId === undefined ? {} : { organizationId }),
          state: 'disabled',
          error: 'expired',
        });
        closeStream(entry);
      });
      entry.stream = deps.openFeedStream(session, request.scope, {
        onEvent: (event) => deliver(entry, event),
      });
      if (streams.get(key) !== entry) entry.stream?.close();
      return { ok: true, result: null };
    } catch (error) {
      closeStream(entry);
      return errorResponse(error, false);
    }
  }

  async function verifyMembership(
    accountId: string,
    organizationId: string,
  ): Promise<'member' | 'forbidden' | 'identity_changed' | 'failed'> {
    const input = validateSettingsOperationInput('settings.bootstrap', {});
    if (!input.ok) return 'failed';
    try {
      const session = await deps.acquireSession(accountId);
      await session.ensureReady({ userInitiated: true });
      const bootstrap = settingsBootstrapSchema.safeParse(
        await deps.execute(session, 'settings.bootstrap', input.input),
      );
      if (!bootstrap.success) return 'failed';
      if (bootstrap.data.viewer.id !== accountId) return 'identity_changed';
      return settingsBootstrapHasOrganization(bootstrap.data, organizationId)
        ? 'member'
        : 'forbidden';
    } catch (error) {
      if (!(error instanceof SettingsOperationError)) return 'failed';
      if (error.code === 'unauthenticated') return 'identity_changed';
      if (error.code === 'forbidden' || error.code === 'not_found')
        return 'forbidden';
      return 'failed';
    }
  }

  async function paymentHandoff(
    request: SettingsPaymentHandoffRequest & { accountId: string },
  ): Promise<SettingsPaymentHandoffResult> {
    const { accountId } = request;
    if (!(await deps.paymentHandoffAvailable(accountId)))
      return { ok: false, reason: 'unavailable' };
    let credentials: CanopyCloudCredentialContext;
    try {
      credentials = await deps.credentials(accountId);
    } catch {
      return { ok: false, reason: 'identity_changed' };
    }
    if (request.owner.kind === 'organization') {
      const membership = await verifyMembership(
        accountId,
        request.owner.organizationId,
      );
      if (membership !== 'member') return { ok: false, reason: membership };
    }
    let path: string;
    let requestId: string;
    try {
      requestId = billingRequestId(random);
      path = billingHandoffPath(request, requestId);
    } catch {
      return { ok: false, reason: 'failed' };
    }
    if ((await deps.currentAccountId()) !== accountId)
      return { ok: false, reason: 'identity_changed' };
    try {
      const result = await deps.openStrictPortalPage(path, credentials);
      return result.ok &&
        request.intent.kind === 'top-up' &&
        request.intent.reason === 'unlock_models'
        ? { ok: true, requestId }
        : result;
    } catch {
      return { ok: false, reason: 'failed' };
    }
  }

  return {
    read: (request) => run('read', request),
    write: (request) => run('write', request),
    subscribe,
    unsubscribe: (sender, subscriptionId): void => {
      const entry = streams.get(streamKey(sender, subscriptionId));
      if (entry !== undefined) closeStream(entry);
    },
    paymentHandoff,
    paymentHandoffAvailability: async (accountId) => ({
      available: await deps.paymentHandoffAvailable(accountId),
    }),
    subscriptionCount: () => streams.size,
    dispose: (): void => {
      stopAccountWatch();
      for (const entry of Array.from(streams.values())) closeStream(entry);
    },
  };
}
