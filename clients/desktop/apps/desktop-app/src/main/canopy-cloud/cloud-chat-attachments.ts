import { createHash, randomUUID } from 'node:crypto';
import {
  CORE_CHAT_ATTACHMENT_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  composeCanopyInstructionRegistries,
  CoreChatAttachmentUploadResultSchema,
  type CanopyInstructionDefinitionMap,
  type CanopyQueryDefinitionMap,
  type CoreChatAttachmentUploadParams,
} from '@canopy/protocol/canopy-core';
import {
  CLOUD_ATTACHMENT_MAX_BYTES,
  CLOUD_ATTACHMENTS_MAX_PER_MESSAGE,
  isCloudAttachmentMediaType,
  truncateCloudAttachmentFilename,
} from '@canopy/protocol/cloud-attachments';
import {
  CanopyClientError,
  createCanopyClient,
  createCanopyClientLease,
  type CanopyClient,
} from '@canopy/core-client';
import { CanopyTransportError } from '@canopy/core-transport';
import type {
  CloudChatAttachmentUploadResult,
  CloudChatUploadTarget,
} from '@canopy/desktop-shared/types';
import { z } from 'zod';
import { validateId } from '../lib/validation';
import {
  connectWebCore,
  type WebCoreBindingOptions,
} from './web-core-connection';

/**
 * Cloud chat attachment upload from Electron main (CAN-5972, CAN-5988).
 *
 * The renderer hands over the bytes it read from a file the user picked or
 * dropped; main never opens a path the renderer names, and the renderer never
 * sees a credential. Main sends the bytes as `core.chat.attachment.upload` on
 * its own web core connection, authenticated as every other web core request.
 */

const CLOUD_CHAT_KEY_PREFIX = 'web-core:';
const UPLOAD_TIMEOUT_MS = 120_000;
/** As the renderer relay renews its leases. */
const LEASE_RENEWAL_MS = 30_000;
/** The web's per-user upload slots (MAX_CONCURRENT_UPLOADS_PER_USER). */
const MAX_ACTIVE_UPLOADS = 3;

const fileSchema = z.strictObject({
  name: z.string().min(1).max(4096),
  mimeType: z.string().min(1).max(256),
  bytes: z.instanceof(Uint8Array),
});

const targetSchema = z.strictObject({
  key: z.string().min(1).max(1024),
  workspaceId: z.string().min(1).max(512),
  worktreeId: z.string().min(1).max(512),
});

/** Sends one upload and answers its result, or throws its protocol error. */
export type CloudChatAttachmentSender = (
  params: CoreChatAttachmentUploadParams,
) => Promise<unknown>;

export interface CloudChatAttachmentUploadOptions {
  /** `canopyDesktopCloudChats`, evaluated in main. */
  readonly isEnabled: () => boolean;
  readonly send: CloudChatAttachmentSender;
}

/** The chat id of a cloud chat key, or null for a local or malformed key. */
export function cloudChatIdOfKey(chatKey: unknown): string | null {
  if (typeof chatKey !== 'string' || !chatKey.startsWith(CLOUD_CHAT_KEY_PREFIX))
    return null;
  const chatId = chatKey.slice(CLOUD_CHAT_KEY_PREFIX.length);
  try {
    validateId(chatId, 'cloud chat id');
    return chatId;
  } catch {
    return null;
  }
}

/** Whether a cloud chat target's workspace and task ids pass the shared validator. */
export function validIds(target: {
  readonly workspaceId: string;
  readonly worktreeId: string;
}): boolean {
  try {
    validateId(target.workspaceId, 'cloud workspace id');
    validateId(target.worktreeId, 'cloud task id');
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `run` on a client of a web core connection of its own: opened with
 * main's web core binding, closed once `run` settles. The connection holds a
 * client lease for its life, so slow work outlives the web core's unleased
 * connection TTL.
 */
export async function withLeasedWebCoreClient<
  Q extends CanopyQueryDefinitionMap,
  I extends CanopyInstructionDefinitionMap,
  T,
>(
  binding: WebCoreBindingOptions,
  options: {
    readonly clientName: string;
    readonly clientVersion: string;
    readonly label: string;
    readonly definitions: { readonly queries: Q; readonly instructions: I };
    readonly signal: AbortSignal;
  },
  run: (client: CanopyClient<Q, I, Record<never, never>>) => Promise<T>,
): Promise<T> {
  // The client owns the connection: closing it, or a failed handshake,
  // closes the connection too.
  const client = await createCanopyClient<Q, I>({
    connection: await connectWebCore(binding, options.signal),
    clientName: options.clientName,
    clientVersion: options.clientVersion,
    definitions: { ...options.definitions, streams: {} },
    signal: options.signal,
  });
  const lease = createCanopyClientLease({
    client,
    // One piece of work per connection: a dropped connection fails it.
    attach: () =>
      Promise.reject(
        new CanopyClientError({
          kind: 'unavailable',
          message: 'The connection closed.',
          retry: { kind: 'never' },
        }),
      ),
    identity: {
      clientInstanceId: randomUUID(),
      interfaceKind: 'http',
      label: options.label,
    },
    renewalIntervalMs: LEASE_RENEWAL_MS,
    presence: () => ({ interactive: true, foreground: true }),
  });
  try {
    await lease.acquire();
    return await run(client);
  } finally {
    await lease.release('normal_shutdown').catch(() => undefined);
    await client.close();
  }
}

/** Sends each upload on a connection of its own (`withLeasedWebCoreClient`). */
export function createWebCoreAttachmentSender(
  binding: WebCoreBindingOptions,
  clientVersion: string,
): CloudChatAttachmentSender {
  return (params) =>
    withLeasedWebCoreClient(
      binding,
      {
        clientName: 'canopy-desktop-cloud-chat-attachments',
        clientVersion,
        label: 'Desktop cloud chat upload',
        definitions: {
          queries: {},
          instructions: composeCanopyInstructionRegistries(
            CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
            CORE_CHAT_ATTACHMENT_DEFINITIONS,
          ),
        },
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      },
      (client) => client.instruction('core.chat.attachment.upload', params),
    );
}

/** The renderer-facing reason for a refused or failed upload. */
function failureReason(
  error: unknown,
): Exclude<CloudChatAttachmentUploadResult, { ok: true }>['reason'] {
  const payload =
    error instanceof CanopyClientError || error instanceof CanopyTransportError
      ? error.payload
      : null;
  if (payload === null) return 'offline';
  if (payload.kind === 'unauthenticated') return 'unauthenticated';
  if (payload.kind === 'capability_unavailable') return 'disabled';
  if (payload.code === 'core.chat.attachment.tooLarge') return 'too_large';
  if (
    payload.kind === 'unavailable' ||
    payload.kind === 'deadline_exceeded' ||
    payload.kind === 'cancelled'
  )
    return 'offline';
  return 'rejected';
}

/**
 * Refusals the web core answers in words meant for the person. An error the
 * client or transport raised itself, such as `internal`, can carry developer
 * text, so it never reaches the composer.
 */
const EXPLAINED_REFUSALS: ReadonlySet<string> = new Set([
  'invalid_argument',
  'permission_denied',
  'not_found',
  'already_exists',
  'conflict',
  'failed_precondition',
  'resource_exhausted',
]);

/** The web core's message for a refusal it answered, or null. */
function refusalMessage(error: unknown): string | null {
  if (!(error instanceof CanopyClientError)) return null;
  if (!EXPLAINED_REFUSALS.has(error.payload.kind)) return null;
  const message = error.payload.message.trim();
  return message === '' ? null : message;
}

/**
 * One upload per call. Main accepts at most as many uploads as one message can
 * carry and sends at most three at a time, the web's per-user slots, so the
 * rest wait instead of failing; the web core caps the size of each.
 */
export function createCloudChatAttachmentUpload(
  options: CloudChatAttachmentUploadOptions,
): (
  target: unknown,
  file: unknown,
) => Promise<CloudChatAttachmentUploadResult> {
  let inFlight = 0;
  let active = 0;
  const waiting: (() => void)[] = [];

  async function takeSlot(): Promise<void> {
    if (active < MAX_ACTIVE_UPLOADS) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  function releaseSlot(): void {
    const next = waiting.shift();
    if (next === undefined) active -= 1;
    else next();
  }

  async function send(
    target: CloudChatUploadTarget,
    chatId: string,
    file: z.output<typeof fileSchema>,
    mediaType: CoreChatAttachmentUploadParams['mediaType'],
  ): Promise<CloudChatAttachmentUploadResult> {
    let value: unknown;
    try {
      value = await options.send({
        scope: {
          workspaceId: target.workspaceId,
          worktreeId: target.worktreeId,
        },
        chatId,
        filename: truncateCloudAttachmentFilename(file.name),
        mediaType,
        size: file.bytes.byteLength,
        contentSha256: createHash('sha256').update(file.bytes).digest('hex'),
        data: Buffer.from(file.bytes).toString('base64'),
        _meta: { idempotencyKey: randomUUID() },
      });
    } catch (error) {
      const reason = failureReason(error);
      const message = refusalMessage(error);
      // A refusal the web core explained keeps its words (CAN-6369).
      return reason === 'rejected' && message !== null
        ? { ok: false, reason, message }
        : { ok: false, reason };
    }
    const parsed = CoreChatAttachmentUploadResultSchema.safeParse(value);
    if (!parsed.success) return { ok: false, reason: 'rejected' };
    const { attachment } = parsed.data;
    return { ok: true, attachmentId: attachment.attachmentId, attachment };
  }

  return async (target, file) => {
    if (!options.isEnabled()) return { ok: false, reason: 'disabled' };
    const parsedTarget = targetSchema.safeParse(target);
    const chatId = parsedTarget.success
      ? cloudChatIdOfKey(parsedTarget.data.key)
      : null;
    const parsed = fileSchema.safeParse(file);
    if (
      !parsedTarget.success ||
      chatId === null ||
      !validIds(parsedTarget.data) ||
      !parsed.success
    )
      return { ok: false, reason: 'rejected' };
    if (parsed.data.bytes.byteLength > CLOUD_ATTACHMENT_MAX_BYTES)
      return { ok: false, reason: 'too_large' };
    const mediaType = parsed.data.mimeType;
    if (!isCloudAttachmentMediaType(mediaType))
      return { ok: false, reason: 'rejected' };
    if (inFlight >= CLOUD_ATTACHMENTS_MAX_PER_MESSAGE)
      return { ok: false, reason: 'rejected' };
    inFlight += 1;
    try {
      await takeSlot();
      try {
        return await send(parsedTarget.data, chatId, parsed.data, mediaType);
      } finally {
        releaseSlot();
      }
    } finally {
      inFlight -= 1;
    }
  };
}
