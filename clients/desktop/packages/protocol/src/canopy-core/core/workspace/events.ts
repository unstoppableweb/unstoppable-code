import { z } from 'zod';
import { CanopyJsonValueSchema } from '../../errors';

/*
 * Workspace commit events (W5e, CAN-5497), served on `core.events.subscribe`
 * in the `core.workspace` family. Host-neutral: the desktop daemon emits
 * `files` and `publishedBy`; a core that has neither emits the same events
 * from `changes` alone. The web core emits no commit events, only the
 * refetch signal `core.workspace.changed` (CAN-6111). Payloads may gain
 * optional fields; subscribers ignore fields and event names they do not
 * understand.
 */

/** The event family a workspace commit subscriber names. */
export const CORE_WORKSPACE_EVENT_FAMILY = 'core.workspace';
/** Exactly once per applied commit; never for a refused or unapplied one. */
export const CORE_WORKSPACE_COMMITTED_EVENT = 'core.workspace.committed';
/** Never a success: an uncertain outcome or a recovery that may have applied commits. */
export const CORE_WORKSPACE_INVALIDATED_EVENT = 'core.workspace.invalidated';
/**
 * Refetch only: a cloud project the caller can see changed, such as a chat
 * now existing in it, whoever made it (web core, CAN-6111).
 */
export const CORE_WORKSPACE_CHANGED_EVENT = 'core.workspace.changed';

export const CORE_WORKSPACE_EVENT_NAMES = [
  CORE_WORKSPACE_COMMITTED_EVENT,
  CORE_WORKSPACE_INVALIDATED_EVENT,
  CORE_WORKSPACE_CHANGED_EVENT,
] as const;

const id = z.string().min(1).max(512);
/** An opaque commit reference, such as `w5:<commitId>`. */
const commit = z.string().min(1).max(128);

export const CORE_WORKSPACE_CHANGE_KINDS = [
  'index',
  'workspace',
  'worktreeList',
  'worktree',
] as const;

/** One resource whose revision the commit advanced. */
export const CoreWorkspaceCommittedChangeSchema = z
  .object({
    workspaceId: id.optional(),
    worktreeId: id.optional(),
    kind: z.enum(CORE_WORKSPACE_CHANGE_KINDS),
    revision: z.number().int().nonnegative(),
  })
  .catchall(CanopyJsonValueSchema);

export const CORE_WORKSPACE_COMMITTED_FILE_KINDS = [
  'index',
  'index-backup',
  'manifest',
  'worktrees',
] as const;

/** Desktop only: a file the commit wrote, path-free. */
export const CoreWorkspaceCommittedFileSchema = z
  .object({
    kind: z.enum(CORE_WORKSPACE_COMMITTED_FILE_KINDS),
    workspaceId: id.optional(),
  })
  .catchall(CanopyJsonValueSchema);

export const CoreWorkspaceCommittedPayloadSchema = z
  .object({
    commit,
    changes: z.array(CoreWorkspaceCommittedChangeSchema).max(4096),
    files: z.array(CoreWorkspaceCommittedFileSchema).max(1024).optional(),
    /** The client instance whose attributed call made the commit. */
    publishedBy: id.optional(),
  })
  .catchall(CanopyJsonValueSchema);
export type CoreWorkspaceCommittedPayload = z.output<
  typeof CoreWorkspaceCommittedPayloadSchema
>;

export const CORE_WORKSPACE_INVALIDATION_REASONS = [
  'uncertain',
  'recovered',
] as const;

export const CoreWorkspaceInvalidatedPayloadSchema = z
  .object({
    reason: z.enum(CORE_WORKSPACE_INVALIDATION_REASONS),
    /** Commits known to be involved, when the core knows them. */
    commits: z.array(commit).max(1024).optional(),
  })
  .catchall(CanopyJsonValueSchema);
export type CoreWorkspaceInvalidatedPayload = z.output<
  typeof CoreWorkspaceInvalidatedPayloadSchema
>;

/** Scoped `{ workspaceId }`; the client re-reads the project's listing. */
export const CoreWorkspaceChangedPayloadSchema = z
  .object({
    /** The chat that now exists in the project, when that is the change. */
    chatId: id.optional(),
  })
  .catchall(CanopyJsonValueSchema);
export type CoreWorkspaceChangedPayload = z.output<
  typeof CoreWorkspaceChangedPayloadSchema
>;
