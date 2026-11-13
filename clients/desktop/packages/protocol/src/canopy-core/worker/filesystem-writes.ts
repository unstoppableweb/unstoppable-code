import { z } from 'zod';

import {
  CanopyRequestMetadataSchema,
  CanopyWorkspaceScopeSchema,
} from '../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  CanopyKeyedRetryDirectiveSchema,
  type CanopyErrorPayload,
} from '../errors';
import type { CanopyOperationCode } from '../names';

const ID = z.string().min(1).max(512);
const VERSION = z.string().min(1).max(512);
const PATH = z.string().min(1).max(4096);

const KeyedMetaSchema = CanopyRequestMetadataSchema.extend({
  idempotencyKey: ID,
});

/** The scope `directory.create` and `entry.copy` take: no execution ids. */
const CreateScopeSchema = CanopyWorkspaceScopeSchema.pick({
  organizationId: true,
  workspaceId: true,
  worktreeId: true,
  chatId: true,
  targetId: true,
});

const FileWriteBase = {
  scope: CanopyWorkspaceScopeSchema,
  fileRootId: ID,
  relativePath: z.string(),
  content: z.string().max(16_777_216).nullable().optional(),
  sourceArtifactId: z.string().nullable().optional(),
  executable: z.boolean().optional(),
  _meta: KeyedMetaSchema,
};

// The catalog's if/then: replacing a file needs its version; creating forbids one.
export const WorkerFilesystemFileWriteParamsSchema = z.union([
  z.strictObject({
    ...FileWriteBase,
    createOnly: z.literal(false),
    expectedVersion: z.string(),
  }),
  z.strictObject({ ...FileWriteBase, createOnly: z.literal(true) }),
]);

export type WorkerFilesystemFileWriteParams = z.output<
  typeof WorkerFilesystemFileWriteParamsSchema
>;

export const WorkerFilesystemFileWriteResultSchema = z
  .object({
    relativePath: z.string(),
    sizeBytes: z.number().int().min(0),
    sha256: z.string(),
    version: VERSION,
    modifiedAt: z.iso.datetime({ offset: true }),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerFilesystemFileWriteResult = z.output<
  typeof WorkerFilesystemFileWriteResultSchema
>;

export const WorkerFilesystemDirectoryCreateParamsSchema = z.strictObject({
  scope: CreateScopeSchema,
  fileRootId: ID,
  relativePath: PATH,
  createParents: z.boolean(),
  expectedAbsent: z.literal(true),
  _meta: KeyedMetaSchema,
});

export type WorkerFilesystemDirectoryCreateParams = z.output<
  typeof WorkerFilesystemDirectoryCreateParamsSchema
>;

export const WorkerFilesystemDirectoryCreateResultSchema = z.strictObject({
  fileRootId: ID,
  relativePath: PATH,
  createdParentPaths: z.array(PATH),
  version: VERSION,
});

export type WorkerFilesystemDirectoryCreateResult = z.output<
  typeof WorkerFilesystemDirectoryCreateResultSchema
>;

const DISPOSITION = z.enum(['permanent', 'trash']);

export const WorkerFilesystemEntryDeleteParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  fileRootId: ID,
  relativePath: z.string(),
  expectedVersion: z.string().nullable(),
  recursive: z.boolean(),
  disposition: DISPOSITION,
  _meta: KeyedMetaSchema,
});

export type WorkerFilesystemEntryDeleteParams = z.output<
  typeof WorkerFilesystemEntryDeleteParamsSchema
>;

export const WorkerFilesystemEntryDeleteResultSchema = z
  .object({
    deleted: z.boolean(),
    deletedEntryCount: z.number().int().min(0),
    disposition: DISPOSITION,
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerFilesystemEntryDeleteResult = z.output<
  typeof WorkerFilesystemEntryDeleteResultSchema
>;

const CONFLICT_POLICY = z.enum(['error', 'increment']);

export const WorkerFilesystemEntryCopyParamsSchema = z.strictObject({
  scope: CreateScopeSchema,
  sourceFileRootId: ID,
  sourceRelativePath: PATH,
  destinationFileRootId: ID,
  destinationRelativePath: PATH,
  expectedSourceVersion: VERSION.nullable(),
  conflictPolicy: CONFLICT_POLICY,
  _meta: KeyedMetaSchema,
});

export type WorkerFilesystemEntryCopyParams = z.output<
  typeof WorkerFilesystemEntryCopyParamsSchema
>;

export const WorkerFilesystemEntryCopyResultSchema = z.strictObject({
  sourceFileRootId: ID,
  sourceRelativePath: PATH,
  destinationFileRootId: ID,
  requestedDestinationRelativePath: PATH,
  /** Where the copy landed; `increment` may pick another free name. */
  destinationRelativePath: PATH,
  copiedEntryCount: z.number().int().min(1),
  version: VERSION,
});

export type WorkerFilesystemEntryCopyResult = z.output<
  typeof WorkerFilesystemEntryCopyResultSchema
>;

export const WorkerFilesystemEntryMoveParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  sourceFileRootId: ID,
  destinationFileRootId: ID,
  fromRelativePath: z.string(),
  toRelativePath: z.string(),
  expectedSourceVersion: z.string().nullable(),
  expectedDestinationAbsent: z.boolean(),
  conflictPolicy: CONFLICT_POLICY,
  _meta: KeyedMetaSchema,
});

export type WorkerFilesystemEntryMoveParams = z.output<
  typeof WorkerFilesystemEntryMoveParamsSchema
>;

export const WorkerFilesystemEntryMoveResultSchema = z
  .object({
    fromRelativePath: z.string(),
    toRelativePath: z.string(),
    version: VERSION,
    sourceFileRootId: ID,
    destinationFileRootId: ID,
    requestedToRelativePath: z.string().max(4096),
    conflictPolicy: CONFLICT_POLICY,
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerFilesystemEntryMoveResult = z.output<
  typeof WorkerFilesystemEntryMoveResultSchema
>;

function keyedError<
  const Codes extends [CanopyOperationCode, ...CanopyOperationCode[]],
>(codes: Codes): z.ZodType<CanopyErrorPayload> {
  return CanopyErrorPayloadSchema.extend({
    code: z.enum(codes).optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });
}

/**
 * The `worker.filesystem.entry.delete` and `.move` codes. The first three are
 * the catalog's; the rest are the desktop host's guards (CAN-4101), which its
 * explorer projection maps back to legacy messages. A host emits only those
 * it checks.
 */
export const WORKER_FILESYSTEM_ENTRY_ERROR_CODES = [
  'worker.filesystem.entry.invalidState',
  'worker.filesystem.entry.revisionConflict',
  'worker.filesystem.entry.notFound',
  'worker.filesystem.entry.invalidPath',
  'worker.filesystem.entry.outsideRoot',
  'worker.filesystem.entry.changed',
  'worker.filesystem.root.notFound',
  'worker.filesystem.root.excluded',
  'worker.filesystem.trash.unavailable',
  'worker.filesystem.trash.failed',
  'worker.filesystem.entry.exists',
  'worker.filesystem.entry.nested',
  'worker.filesystem.entry.crossRootSymlink',
] as const;

export type WorkerFilesystemEntryErrorCode =
  (typeof WORKER_FILESYSTEM_ENTRY_ERROR_CODES)[number];

const ENTRY_ERROR = keyedError([...WORKER_FILESYSTEM_ENTRY_ERROR_CODES]);

/**
 * The `worker.filesystem.entry.copy` codes: the catalog's eight, then the
 * desktop host's two guards it has no code for (CAN-4101).
 */
export const WORKER_FILESYSTEM_ENTRY_COPY_ERROR_CODES = [
  'worker.filesystem.root.notFound',
  'worker.filesystem.source.notFound',
  'worker.filesystem.source.conflict',
  'worker.filesystem.destination.exists',
  'worker.filesystem.path.escape',
  'worker.filesystem.destination.nested',
  'worker.filesystem.symlink.rejected',
  'worker.filesystem.split.locked',
  'worker.filesystem.entry.invalidPath',
  'worker.filesystem.root.excluded',
] as const;

export type WorkerFilesystemEntryCopyErrorCode =
  (typeof WORKER_FILESYSTEM_ENTRY_COPY_ERROR_CODES)[number];

/**
 * The `worker.filesystem.file.write` codes: the catalog's three, then the
 * path and root codes `directory.create` declares, plus `root.excluded`
 * (CAN-4100). A host emits only those it checks.
 */
export const WORKER_FILESYSTEM_FILE_WRITE_ERROR_CODES = [
  'worker.filesystem.file.invalidState',
  'worker.filesystem.file.revisionConflict',
  'worker.filesystem.file.notFound',
  'worker.filesystem.root.notFound',
  'worker.filesystem.path.invalid',
  'worker.filesystem.path.escape',
  'worker.filesystem.split.locked',
  'worker.filesystem.root.excluded',
] as const;

export type WorkerFilesystemFileWriteErrorCode =
  (typeof WORKER_FILESYSTEM_FILE_WRITE_ERROR_CODES)[number];

/**
 * The `worker.filesystem.directory.create` codes: the catalog's six, then
 * `root.excluded` for the desktop host's other-root guard (CAN-4100).
 */
export const WORKER_FILESYSTEM_DIRECTORY_CREATE_ERROR_CODES = [
  'worker.filesystem.root.notFound',
  'worker.filesystem.path.invalid',
  'worker.filesystem.path.escape',
  'worker.filesystem.entry.exists',
  'worker.filesystem.symlink.rejected',
  'worker.filesystem.split.locked',
  'worker.filesystem.root.excluded',
] as const;

export type WorkerFilesystemDirectoryCreateErrorCode =
  (typeof WORKER_FILESYSTEM_DIRECTORY_CREATE_ERROR_CODES)[number];

// Served by the web core (CAN-4159) and the desktop dispatcher (CAN-4100).
// Composed into WORKER_INSTRUCTION_DEFINITIONS (CAN-5518); the daemon
// registers both, with no production grant and fail-closed write admission.
export const WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.filesystem.file.write': defineCanopyInstruction({
      plane: 'worker',
      domain: 'filesystem',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'keyed',
      requiredGrants: ['worker.filesystem.write'],
      params: WorkerFilesystemFileWriteParamsSchema,
      result: WorkerFilesystemFileWriteResultSchema,
      error: keyedError([...WORKER_FILESYSTEM_FILE_WRITE_ERROR_CODES]),
    }),
    'worker.filesystem.directory.create': defineCanopyInstruction({
      plane: 'worker',
      domain: 'filesystem',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'keyed',
      requiredGrants: ['worker.filesystem.write'],
      params: WorkerFilesystemDirectoryCreateParamsSchema,
      result: WorkerFilesystemDirectoryCreateResultSchema,
      error: keyedError([...WORKER_FILESYSTEM_DIRECTORY_CREATE_ERROR_CODES]),
    }),
  });

// Composed into WORKER_INSTRUCTION_DEFINITIONS (CAN-5502) so the daemon's
// core+worker profile admits them; the daemon serves one only once its Files
// module declares it with a handler. The desktop dispatcher serves
// all three (CAN-4101); the web core serves delete and move (CAN-4159).
export const WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.filesystem.entry.delete': defineCanopyInstruction({
      plane: 'worker',
      domain: 'filesystem',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'keyed',
      abandonedRetry: 'same_idempotency_key',
      requiredGrants: ['worker.filesystem.write'],
      params: WorkerFilesystemEntryDeleteParamsSchema,
      result: WorkerFilesystemEntryDeleteResultSchema,
      error: ENTRY_ERROR,
    }),
    'worker.filesystem.entry.copy': defineCanopyInstruction({
      plane: 'worker',
      domain: 'filesystem',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'keyed',
      abandonedRetry: 'same_idempotency_key',
      requiredGrants: ['worker.filesystem.write'],
      params: WorkerFilesystemEntryCopyParamsSchema,
      result: WorkerFilesystemEntryCopyResultSchema,
      error: keyedError([...WORKER_FILESYSTEM_ENTRY_COPY_ERROR_CODES]),
    }),
    'worker.filesystem.entry.move': defineCanopyInstruction({
      plane: 'worker',
      domain: 'filesystem',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'keyed',
      abandonedRetry: 'same_idempotency_key',
      requiredGrants: ['worker.filesystem.write'],
      params: WorkerFilesystemEntryMoveParamsSchema,
      result: WorkerFilesystemEntryMoveResultSchema,
      error: ENTRY_ERROR,
    }),
  });

export type WorkerFilesystemEntryInstructionDefinitions =
  typeof WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS;
