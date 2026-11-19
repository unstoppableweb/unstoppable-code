import { CoreCoworkRequestError } from '@canopy/app-state/core-cowork';
import { WorkerArtifactDeleteResultSchema } from '@canopy/protocol/canopy-core';
import { CLOUD_ATTACHMENT_MAX_BYTES } from '@canopy/protocol/cloud-attachments';
import type {
  CloudChatsApi,
  CloudWorkspaceFileUploadResult,
} from '@canopy/desktop-shared/types';
import type {
  WorkspaceFilesCardHost,
  WorkspaceFilesFailure,
  WorkspaceFilesWrite,
} from '@canopy/ui-app/workspace-files';
import type { CanopyCoreRelayApi } from '../../../shared/canopy-core-relay';
import { requestWebCore } from '@/lib/files/web-core-file-source';
import { cloudAttachmentMediaType } from './cloud-chat-attachments';

/*
 * A cloud project's shared workspace files written from desktop (CAN-7008).
 * A file the person picks uploads through main (`cloudChats.uploadWorkspaceFile`),
 * which writes it on its own web core connection; a removal goes over the
 * renderer relay's `worker.artifact.delete`. Neither retries: once a write
 * is sent, an answer that never came is an unknown outcome, so the card
 * reads the files again and keeps Try again, which resends under the same
 * operation id.
 */

type FailureReason = Extract<
  CloudWorkspaceFileUploadResult,
  { ok: false }
>['reason'];

/** A refused or unconfirmed workspace file write. */
export class CloudWorkspaceFileWriteError extends Error {
  readonly reason: FailureReason | 'gone';
  /** The web core's own words for a refusal it explained. */
  readonly detail: string | undefined;

  constructor(reason: FailureReason | 'gone', detail?: string) {
    super(detail ?? reason);
    this.name = 'CloudWorkspaceFileWriteError';
    this.reason = reason;
    this.detail = detail;
  }
}

/** `wsf:<workspaceId>:<fileId>`, as `core.artifact.list` names a workspace file. */
export function workspaceFileIdOf(artifactId: string): string | null {
  const parts = artifactId.split(':');
  return parts.length === 3 && parts[0] === 'wsf' && parts[2] !== ''
    ? parts[2]
    : null;
}

/** Relay refusals the web core answered; any other failure may have landed. */
const ANSWERED: ReadonlySet<string> = new Set([
  'invalid_argument',
  'permission_denied',
  'already_exists',
  'conflict',
  'failed_precondition',
  'resource_exhausted',
  'unauthenticated',
  'capability_unavailable',
]);

function removalFailure(error: unknown): CloudWorkspaceFileWriteError {
  if (!(error instanceof CoreCoworkRequestError))
    return new CloudWorkspaceFileWriteError('unknown');
  const { kind } = error.payload;
  if (kind === 'not_found') return new CloudWorkspaceFileWriteError('gone');
  if (kind === 'unauthenticated')
    return new CloudWorkspaceFileWriteError('unauthenticated');
  if (kind === 'capability_unavailable')
    return new CloudWorkspaceFileWriteError('disabled');
  if (!ANSWERED.has(kind)) return new CloudWorkspaceFileWriteError('unknown');
  const message = error.payload.message.trim();
  return new CloudWorkspaceFileWriteError(
    kind === 'conflict' || kind === 'failed_precondition'
      ? 'conflict'
      : 'rejected',
    message === '' ? undefined : message,
  );
}

/** The writes a desktop cloud project's card offers. */
export function cloudWorkspaceFileWrites(deps: {
  readonly workspaceId: string;
  readonly cloudChats: Pick<CloudChatsApi, 'uploadWorkspaceFile'>;
  readonly relay: CanopyCoreRelayApi;
  /**
   * Runs once each write settles, whatever its outcome, so the project's
   * cached list is read again even after the card that started it closed.
   */
  readonly onSettled?: () => void;
}): WorkspaceFilesWrite {
  const write: WorkspaceFilesWrite = {
    upload: async (pending): Promise<void> => {
      // Refused before any byte is read; main checks the cap again.
      if (pending.file.size > CLOUD_ATTACHMENT_MAX_BYTES)
        throw new CloudWorkspaceFileWriteError('too_large');
      const mimeType = cloudAttachmentMediaType(pending.file);
      if (mimeType === null)
        throw new CloudWorkspaceFileWriteError('unsupported_type');
      const replaceFileId =
        pending.replaceFileId === undefined
          ? undefined
          : workspaceFileIdOf(pending.replaceFileId);
      if (replaceFileId === null)
        throw new CloudWorkspaceFileWriteError('rejected');
      const result = await deps.cloudChats.uploadWorkspaceFile({
        workspaceId: deps.workspaceId,
        operationId: pending.operationId,
        ...(replaceFileId === undefined ? {} : { replaceFileId }),
        ...(pending.expectedVersionId === undefined
          ? {}
          : { expectedVersionId: pending.expectedVersionId }),
        name: pending.file.name,
        mimeType,
        bytes: new Uint8Array(await pending.file.arrayBuffer()),
      });
      if (!result.ok)
        throw new CloudWorkspaceFileWriteError(result.reason, result.message);
    },
    remove: async (rowId): Promise<void> => {
      const fileId = workspaceFileIdOf(rowId);
      if (fileId === null) throw new CloudWorkspaceFileWriteError('rejected');
      try {
        await requestWebCore(
          deps.relay,
          'worker.artifact.delete',
          {
            artifactId: `workspace-file:${fileId}`,
            scope: { workspaceId: deps.workspaceId },
          },
          WorkerArtifactDeleteResultSchema,
        );
      } catch (error) {
        throw removalFailure(error);
      }
    },
  };
  const settled = deps.onSettled;
  if (settled === undefined) return write;
  return {
    upload: (pending, signal) => write.upload(pending, signal).finally(settled),
    remove: (rowId) => write.remove(rowId).finally(settled),
  };
}

const COPY: Readonly<Record<FailureReason, string>> = {
  disabled: "Workspace files can't be changed here right now.",
  unauthenticated: 'Sign in again to change workspace files.',
  too_large: 'File is too large.',
  unsupported_type: 'File type is not supported.',
  conflict: 'This file changed since the list loaded. Try again.',
  rejected: "Couldn't save the workspace file.",
  offline: "Couldn't reach the cloud. Try again.",
  // Sent, with no answer: the list is read again so the person can see
  // whether it landed before trying again.
  unknown: "Couldn't confirm the change. Check the list before trying again.",
};

/** How the card reads a desktop write's failure. */
export function describeCloudWorkspaceFileFailure(
  cause: unknown,
): WorkspaceFilesFailure {
  if (!(cause instanceof CloudWorkspaceFileWriteError))
    return { message: "Couldn't save the workspace file.", stale: true };
  if (cause.reason === 'gone')
    return { message: 'This file was already removed.', gone: true };
  const message = cause.detail ?? COPY[cause.reason];
  if (cause.reason === 'conflict') return { message, conflict: true };
  if (cause.reason === 'unknown') return { message, stale: true };
  return { message };
}

export type CloudWorkspaceFilesHostDeps = Parameters<
  typeof cloudWorkspaceFileWrites
>[0] & {
  readonly refresh: () => void;
};

/** The desktop card's host: its writes, each reading the list again as it settles. */
export function cloudWorkspaceFilesHost(
  deps: CloudWorkspaceFilesHostDeps,
): WorkspaceFilesCardHost {
  return {
    // Each write reads the list again as it settles, mounted or not, so the
    // card's own callbacks have nothing left to do on desktop.
    write: cloudWorkspaceFileWrites({ ...deps, onSettled: deps.refresh }),
    describeFailure: describeCloudWorkspaceFileFailure,
    onChanged: (): void => undefined,
    onUnavailable: (): void => undefined,
  };
}
