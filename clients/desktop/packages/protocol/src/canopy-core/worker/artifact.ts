import { z } from 'zod';
import {
  CanopyRequestMetadataSchema,
  CanopyWorkspaceScopeSchema,
} from '../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../errors';

/*
 * Artifact uploads, deletes, download opens (CAN-6108) and download reads
 * (CAN-6175 R8d). The web core serves them over a
 * cloud chat's attachments (`attachment:<id>`) and a workspace's files
 * (`workspace-file:<id>`). Like the other web-only registries they stay out
 * of the composed worker registry, so the desktop dispatcher needs no
 * handler and answers `capability_unavailable`.
 */

const id = z.string().min(1).max(512);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * The largest chunk one `worker.artifact.upload.write` takes. Its base64 (about
 * 5.3 MiB) stays under the 10 MiB raw body the REST upload route already sends
 * through the same edge.
 */
export const WORKER_ARTIFACT_UPLOAD_CHUNK_MAX_BYTES = 4 * 1024 * 1024;
/** That chunk in base64. */
export const WORKER_ARTIFACT_UPLOAD_WRITE_MAX_BASE64 =
  Math.ceil(WORKER_ARTIFACT_UPLOAD_CHUNK_MAX_BYTES / 3) * 4;

export const WorkerArtifactSchema = z.strictObject({
  artifactId: id,
  name: z.string().min(1).max(1024),
  mediaType: z.string().min(1).max(256),
  sizeBytes: z.number().int().min(0),
  sha256,
  storageState: z.enum(['pending', 'available', 'deleted']),
  createdAt: z.iso.datetime({ offset: true }),
  /** An attachment's content source, which a chat message references. */
  source: z.string().max(256).optional(),
});
export type WorkerArtifact = z.output<typeof WorkerArtifactSchema>;

export const WorkerArtifactUploadOpenParamsSchema = z.strictObject({
  /** The kind only (`attachment:`, `workspace-file:`), or a file to version. */
  artifactId: id,
  scope: CanopyWorkspaceScopeSchema,
  name: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number().int().min(0),
  sha256,
  /** The file's current version; a new version is refused once it moved. */
  expectedVersionId: id.optional(),
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: id }),
});
export type WorkerArtifactUploadOpenParams = z.output<
  typeof WorkerArtifactUploadOpenParamsSchema
>;

export const WorkerArtifactUploadOpenResultSchema = z.strictObject({
  artifact: WorkerArtifactSchema,
  uploadId: id,
  chunkSizeBytes: z.number().int().min(1),
  nextOffset: z.number().int().min(0),
});

export const WorkerArtifactUploadWriteParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  uploadId: id,
  offset: z.number().int().min(0),
  /** Base64 of at most `chunkSizeBytes` bytes. */
  data: z.string().min(1).max(WORKER_ARTIFACT_UPLOAD_WRITE_MAX_BASE64),
});
export type WorkerArtifactUploadWriteParams = z.output<
  typeof WorkerArtifactUploadWriteParamsSchema
>;

export const WorkerArtifactUploadWriteResultSchema = z.strictObject({
  nextOffset: z.number().int().min(0),
});

export const WorkerArtifactUploadCommitParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  uploadId: id,
  finalSizeBytes: z.number().int().min(0),
  sha256,
});
export type WorkerArtifactUploadCommitParams = z.output<
  typeof WorkerArtifactUploadCommitParamsSchema
>;

export const WorkerArtifactDeleteParamsSchema = z.strictObject({
  artifactId: id,
  scope: CanopyWorkspaceScopeSchema,
});
export type WorkerArtifactDeleteParams = z.output<
  typeof WorkerArtifactDeleteParamsSchema
>;

export const WorkerArtifactDeleteResultSchema = z.strictObject({
  artifactId: id,
  storageState: z.literal('deleted'),
});

export const WorkerArtifactDownloadOpenParamsSchema = z.strictObject({
  artifactId: id,
  scope: CanopyWorkspaceScopeSchema,
});
export type WorkerArtifactDownloadOpenParams = z.output<
  typeof WorkerArtifactDownloadOpenParamsSchema
>;

export const WorkerArtifactDownloadOpenResultSchema = z.strictObject({
  /** The artifact's same-origin content route, after `/api`. */
  contentPath: z.string().min(1).max(1024),
});

/** The most one `worker.artifact.download.read` answers, as one upload write takes. */
export const WORKER_ARTIFACT_DOWNLOAD_CHUNK_MAX_BYTES =
  WORKER_ARTIFACT_UPLOAD_CHUNK_MAX_BYTES;

/**
 * One range of an artifact's bytes, for a caller that holds no web session to
 * fetch the content route `worker.artifact.download.open` answers (desktop
 * main over its own web core connection, CAN-6175 R8d).
 */
export const WorkerArtifactDownloadReadParamsSchema = z.strictObject({
  artifactId: id,
  scope: CanopyWorkspaceScopeSchema,
  offset: z.number().int().min(0),
  /** At most `WORKER_ARTIFACT_DOWNLOAD_CHUNK_MAX_BYTES`. */
  length: z.number().int().min(1).max(WORKER_ARTIFACT_DOWNLOAD_CHUNK_MAX_BYTES),
});
export type WorkerArtifactDownloadReadParams = z.output<
  typeof WorkerArtifactDownloadReadParamsSchema
>;

export const WorkerArtifactDownloadReadResultSchema = z.strictObject({
  /** The whole artifact's size. */
  sizeBytes: z.number().int().min(0),
  offset: z.number().int().min(0),
  /** Base64 of the bytes from `offset`, at most `length` of them. */
  data: z.string().max(WORKER_ARTIFACT_UPLOAD_WRITE_MAX_BASE64),
  /** Where the next range starts, or null once this one reached the end. */
  nextOffset: z.number().int().min(0).nullable(),
});
export type WorkerArtifactDownloadReadResult = z.output<
  typeof WorkerArtifactDownloadReadResultSchema
>;

const UPLOAD_CODE = z
  .enum([
    'worker.artifact.upload.notFound',
    'worker.artifact.upload.invalidState',
    'worker.artifact.upload.revisionConflict',
    'worker.artifact.upload.tooLarge',
    'worker.artifact.upload.unsupportedType',
    'worker.artifact.upload.digestMismatch',
    'worker.artifact.upload.busy',
  ])
  .optional();

export const WorkerArtifactUploadOpenErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: UPLOAD_CODE,
    retry: CanopyKeyedRetryDirectiveSchema,
  });

export const WorkerArtifactUploadErrorSchema = CanopyErrorPayloadSchema.extend({
  code: UPLOAD_CODE,
  retry: CanopyQueryRetryDirectiveSchema,
});

export const WorkerArtifactDeleteErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(['worker.artifact.notFound']).optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const WorkerArtifactDownloadOpenErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(['worker.artifact.notFound']).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

export const WORKER_ARTIFACT_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'worker',
  {
    'worker.artifact.download.open': defineCanopyQuery({
      plane: 'worker',
      domain: 'artifact',
      version: 1,
      placement: 'target-selectable',
      requiredGrants: ['worker.artifact.read'],
      idempotency: 'inherent',
      params: WorkerArtifactDownloadOpenParamsSchema,
      result: WorkerArtifactDownloadOpenResultSchema,
      error: WorkerArtifactDownloadOpenErrorSchema,
    }),
    'worker.artifact.download.read': defineCanopyQuery({
      plane: 'worker',
      domain: 'artifact',
      version: 1,
      placement: 'target-selectable',
      requiredGrants: ['worker.artifact.read'],
      idempotency: 'inherent',
      params: WorkerArtifactDownloadReadParamsSchema,
      result: WorkerArtifactDownloadReadResultSchema,
      error: WorkerArtifactDownloadOpenErrorSchema,
    }),
  },
);

export const WORKER_ARTIFACT_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.artifact.upload.open': defineCanopyInstruction({
      plane: 'worker',
      domain: 'artifact',
      version: 1,
      placement: 'target-selectable',
      requiredGrants: ['worker.artifact.write'],
      idempotency: 'keyed',
      params: WorkerArtifactUploadOpenParamsSchema,
      result: WorkerArtifactUploadOpenResultSchema,
      error: WorkerArtifactUploadOpenErrorSchema,
    }),
    'worker.artifact.upload.write': defineCanopyInstruction({
      plane: 'worker',
      domain: 'artifact',
      version: 1,
      placement: 'target-selectable',
      requiredGrants: ['worker.artifact.write'],
      idempotency: 'inherent',
      params: WorkerArtifactUploadWriteParamsSchema,
      result: WorkerArtifactUploadWriteResultSchema,
      error: WorkerArtifactUploadErrorSchema,
    }),
    'worker.artifact.upload.commit': defineCanopyInstruction({
      plane: 'worker',
      domain: 'artifact',
      version: 1,
      placement: 'target-selectable',
      requiredGrants: ['worker.artifact.write'],
      idempotency: 'inherent',
      params: WorkerArtifactUploadCommitParamsSchema,
      result: WorkerArtifactSchema,
      error: WorkerArtifactUploadErrorSchema,
    }),
    'worker.artifact.delete': defineCanopyInstruction({
      plane: 'worker',
      domain: 'artifact',
      version: 1,
      placement: 'target-selectable',
      requiredGrants: ['worker.artifact.write'],
      idempotency: 'inherent',
      params: WorkerArtifactDeleteParamsSchema,
      result: WorkerArtifactDeleteResultSchema,
      error: WorkerArtifactDeleteErrorSchema,
    }),
  });
