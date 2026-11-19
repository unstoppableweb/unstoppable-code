import { createHash } from 'node:crypto';
import {
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  WORKER_ARTIFACT_INSTRUCTION_DEFINITIONS,
  WorkerArtifactSchema,
  WorkerArtifactUploadOpenResultSchema,
  WorkerArtifactUploadWriteResultSchema,
  composeCanopyInstructionRegistries,
  type CanopyErrorPayload,
  type WorkerArtifactUploadCommitParams,
  type WorkerArtifactUploadOpenParams,
  type WorkerArtifactUploadWriteParams,
} from '@canopy/protocol/canopy-core';
import {
  CLOUD_ATTACHMENT_MAX_BYTES,
  isCloudAttachmentMediaType,
} from '@canopy/protocol/cloud-attachments';
import { createKeyedWriteHistory } from '@canopy/app-state/core-cowork';
import { CanopyClientError } from '@canopy/core-client';
import { CanopyTransportError } from '@canopy/core-transport';
import type { CloudWorkspaceFileUploadResult } from '@canopy/desktop-shared/types';
import { z } from 'zod';
import { validateId } from '../lib/validation';
import {
  isUnconfirmedKeyedWrite,
  logUnreadableUploadAnswer,
  withLeasedWebCoreClient,
} from './cloud-chat-attachments';
import type { WebCoreBindingOptions } from './web-core-connection';

/**
 * Adding a file to a cloud project's shared workspace files, or a new version
 * of one, from Electron main (CAN-7008).
 *
 * The renderer hands over the bytes of a file the person picked; main never
 * opens a path the renderer names, and the renderer never holds a credential.
 * Main writes them with `worker.artifact.upload.open`, `.write` and `.commit`
 * on a web core connection of its own.
 *
 * Fails closed: main never retries. Once the open is sent, an answer that
 * never came (lost and never retried, or a same-key retry, as the client's
 * own deadline arrives) is `unknown`, since the file may have been stored, as
 * is an answer main can't read. Every error the web core answered keeps its
 * own kind (CAN-7196). The person's Try again resends under the same
 * operation id, which the web core keys the upload by, so it can store the
 * file once at most.
 */

const UPLOAD_TIMEOUT_MS = 120_000;
/** The web's per-user upload slots, as attachments use. */
const MAX_ACTIVE_UPLOADS = 3;
const MAX_IN_FLIGHT = 8;
const WORKSPACE_FILE_PREFIX = 'workspace-file:';

const uuid = z.uuid();

const requestSchema = z
  .strictObject({
    workspaceId: z.string().min(1).max(512),
    operationId: uuid,
    replaceFileId: uuid.optional(),
    expectedVersionId: uuid.optional(),
    name: z.string().min(1).max(1024),
    mimeType: z.string().min(1).max(256),
    bytes: z.instanceof(Uint8Array),
  })
  .refine(
    (request) =>
      (request.replaceFileId === undefined) ===
      (request.expectedVersionId === undefined),
  );

/** Each sends one upload instruction and answers its value, or throws its error. */
export interface WorkspaceFileInstructions {
  readonly open: (params: WorkerArtifactUploadOpenParams) => Promise<unknown>;
  readonly write: (params: WorkerArtifactUploadWriteParams) => Promise<unknown>;
  readonly commit: (
    params: WorkerArtifactUploadCommitParams,
  ) => Promise<unknown>;
}

export interface CloudWorkspaceFileUploadOptions {
  /** `canopyDesktopCloudChats`, evaluated in main. */
  readonly isEnabled: () => boolean;
  /** Runs `write` with instructions on one web core connection. */
  readonly withWriter: <T>(
    write: (instructions: WorkspaceFileInstructions) => Promise<T>,
  ) => Promise<T>;
}

/** Each upload on a web core connection of its own, leased for its life. */
/** What main's workspace file writer calls on its own web core connection. */
export const CLOUD_WORKSPACE_FILE_WRITER_DEFINITIONS = {
  queries: {},
  instructions: composeCanopyInstructionRegistries(
    CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    WORKER_ARTIFACT_INSTRUCTION_DEFINITIONS,
  ),
};

export function createWebCoreWorkspaceFileWriter(
  binding: WebCoreBindingOptions,
  clientVersion: string,
): CloudWorkspaceFileUploadOptions['withWriter'] {
  return (write) =>
    withLeasedWebCoreClient(
      binding,
      {
        clientName: 'canopy-desktop-cloud-workspace-files',
        clientVersion,
        label: 'Desktop cloud workspace file upload',
        definitions: CLOUD_WORKSPACE_FILE_WRITER_DEFINITIONS,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      },
      (client) =>
        write({
          open: (params) =>
            client.instruction('worker.artifact.upload.open', params),
          write: (params) =>
            client.instruction('worker.artifact.upload.write', params),
          commit: (params) =>
            client.instruction('worker.artifact.upload.commit', params),
        }),
    );
}

const payloadOf = (error: unknown): CanopyErrorPayload | null =>
  error instanceof CanopyClientError || error instanceof CanopyTransportError
    ? error.payload
    : null;

/** A failure before anything was sent: nothing reached the web core. */
function beforeDispatch(error: unknown): CloudWorkspaceFileUploadResult {
  const payload = payloadOf(error);
  if (payload?.kind === 'unauthenticated')
    return { ok: false, reason: 'unauthenticated' };
  if (payload?.kind === 'capability_unavailable')
    return { ok: false, reason: 'disabled' };
  return { ok: false, reason: 'offline' };
}

/** Refusal kinds the web core answers; anything else may have landed. */
const REFUSALS: ReadonlySet<string> = new Set([
  'invalid_argument',
  'permission_denied',
  'not_found',
  'already_exists',
  'conflict',
  'failed_precondition',
  'resource_exhausted',
  'unauthenticated',
  'capability_unavailable',
]);

/** Errors the web core answered that a later try may clear. */
const TRANSIENT: ReadonlySet<string> = new Set([
  'unavailable',
  'deadline_exceeded',
  'cancelled',
]);

/**
 * The web core's commit refusals raised before this attempt stores anything
 * (CAN-7196, SWAN 05:33): only these keep their kind once the commit is sent.
 * `capability_unavailable` comes from the upload's record read, the commit's
 * first step (apps/web/src/lib/web-core/artifact-uploads.ts:285-294, :590);
 * a digest mismatch is checked before any byte is read or stored (:596-607,
 * :617-621). Every other commit answer, a conflict included, may follow a
 * stored file: the same code can come from Core's own write, or from a
 * retry after the file was stored but its record wasn't.
 */
function isRefusedBeforeStore(payload: CanopyErrorPayload): boolean {
  return (
    payload.kind === 'capability_unavailable' ||
    payload.code === 'worker.artifact.upload.digestMismatch'
  );
}

/**
 * A failure once the open was sent: `unknown` only when its answer never
 * came, or main couldn't read it; an answered error keeps its kind. The
 * commit, which stores the file, is inherent rather than keyed, so a lost
 * reply to it can't be told from an answered one: once it is sent, only a
 * refusal proven to come before the store keeps its kind (CAN-7196).
 */
function afterDispatch(
  error: unknown,
  committing: boolean,
): CloudWorkspaceFileUploadResult {
  if (isUnconfirmedKeyedWrite(error)) return { ok: false, reason: 'unknown' };
  const payload = payloadOf(error);
  if (payload === null) {
    logUnreadableUploadAnswer('workspace-file');
    return { ok: false, reason: 'unknown' };
  }
  const message = payload.message.trim();
  const withMessage = message === '' ? {} : { message };
  const refused =
    error instanceof CanopyClientError && REFUSALS.has(payload.kind);
  if (committing && !(refused && isRefusedBeforeStore(payload)))
    return { ok: false, reason: 'unknown' };
  // Only a refusal the web core answered keeps its words: any other error,
  // such as internal, can be the client's own, in developer words.
  if (!refused)
    return TRANSIENT.has(payload.kind)
      ? { ok: false, reason: 'offline' }
      : { ok: false, reason: 'rejected' };
  const { kind, code } = payload;
  if (kind === 'unauthenticated')
    return { ok: false, reason: 'unauthenticated' };
  if (kind === 'capability_unavailable')
    return { ok: false, reason: 'disabled' };
  if (code?.endsWith('.tooLarge') === true)
    return { ok: false, reason: 'too_large' };
  if (code?.endsWith('.unsupportedType') === true)
    return { ok: false, reason: 'unsupported_type' };
  if (kind === 'conflict' || kind === 'failed_precondition')
    return { ok: false, reason: 'conflict', ...withMessage };
  return { ok: false, reason: 'rejected', ...withMessage };
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    'base64',
  );
}

/**
 * One upload per call, refused before anything is sent when its ids, size or
 * type are not ones the web core takes. At most three run at a time; the rest
 * wait instead of failing.
 */
export function createCloudWorkspaceFileUpload(
  options: CloudWorkspaceFileUploadOptions,
): (request: unknown) => Promise<CloudWorkspaceFileUploadResult> {
  let inFlight = 0;
  let active = 0;
  const waiting: (() => void)[] = [];
  // Uploads whose answer never came, by operation id: Try again resends the
  // same id, so any failure of the retry leaves it unknown (CAN-7196).
  const unknownUploads = createKeyedWriteHistory();

  function remembered(
    operationId: string,
    result: CloudWorkspaceFileUploadResult,
  ): CloudWorkspaceFileUploadResult {
    if (result.ok) unknownUploads.settle(operationId);
    else if (
      result.reason === 'unknown' ||
      unknownUploads.wasUnknown(operationId)
    ) {
      unknownUploads.markUnknown(operationId);
      return { ok: false, reason: 'unknown' };
    }
    return result;
  }

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
    request: z.output<typeof requestSchema>,
  ): Promise<CloudWorkspaceFileUploadResult> {
    const { bytes } = request;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const scope = { workspaceId: request.workspaceId };
    let dispatched = false;
    let committing = false;
    let artifactId: string;
    try {
      artifactId = await options.withWriter(async (instructions) => {
        dispatched = true;
        const opened = WorkerArtifactUploadOpenResultSchema.parse(
          await instructions.open({
            artifactId: `${WORKSPACE_FILE_PREFIX}${request.replaceFileId ?? ''}`,
            scope,
            name: request.name,
            mediaType: request.mimeType,
            sizeBytes: bytes.byteLength,
            sha256,
            ...(request.expectedVersionId === undefined
              ? {}
              : { expectedVersionId: request.expectedVersionId }),
            _meta: { idempotencyKey: request.operationId },
          }),
        );
        let offset = opened.nextOffset;
        while (offset < bytes.byteLength) {
          const next = WorkerArtifactUploadWriteResultSchema.parse(
            await instructions.write({
              scope,
              uploadId: opened.uploadId,
              offset,
              data: base64(
                bytes.subarray(offset, offset + opened.chunkSizeBytes),
              ),
            }),
          ).nextOffset;
          if (next <= offset) throw new Error('The upload did not advance.');
          offset = next;
        }
        committing = true;
        return WorkerArtifactSchema.parse(
          await instructions.commit({
            scope,
            uploadId: opened.uploadId,
            finalSizeBytes: bytes.byteLength,
            sha256,
          }),
        ).artifactId;
      });
    } catch (error) {
      return dispatched
        ? afterDispatch(error, committing)
        : beforeDispatch(error);
    }
    if (!artifactId.startsWith(WORKSPACE_FILE_PREFIX)) {
      logUnreadableUploadAnswer('workspace-file');
      return { ok: false, reason: 'unknown' };
    }
    return { ok: true, fileId: artifactId.slice(WORKSPACE_FILE_PREFIX.length) };
  }

  return async (input) => {
    if (!options.isEnabled()) return { ok: false, reason: 'disabled' };
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: 'rejected' };
    try {
      validateId(parsed.data.workspaceId, 'cloud workspace id');
      validateId(parsed.data.operationId, 'workspace file operation id');
      if (parsed.data.replaceFileId !== undefined)
        validateId(parsed.data.replaceFileId, 'workspace file id');
      if (parsed.data.expectedVersionId !== undefined)
        validateId(parsed.data.expectedVersionId, 'workspace file version id');
    } catch {
      return { ok: false, reason: 'rejected' };
    }
    if (parsed.data.bytes.byteLength > CLOUD_ATTACHMENT_MAX_BYTES)
      return { ok: false, reason: 'too_large' };
    if (!isCloudAttachmentMediaType(parsed.data.mimeType))
      return { ok: false, reason: 'unsupported_type' };
    if (inFlight >= MAX_IN_FLIGHT) return { ok: false, reason: 'rejected' };
    inFlight += 1;
    try {
      await takeSlot();
      try {
        return remembered(parsed.data.operationId, await send(parsed.data));
      } finally {
        releaseSlot();
      }
    } finally {
      inFlight -= 1;
    }
  };
}
