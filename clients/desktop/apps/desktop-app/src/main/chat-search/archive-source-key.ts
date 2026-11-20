import { logMainProcessWarn } from '../lib/main-process-logging';
import { getWorkspaceChatArchivesFilePath } from '../lib/paths';
import { IdentifierValidationError } from '../lib/validation';

/**
 * The archive file key for one chat scope, or `undefined` when a stored scope
 * id fails the id check (CAN-7346). Only that entry is skipped and logged; the
 * index pass and other callers carry on.
 */
export function chatArchiveSourceKey(
  projectId: string,
  worktreeId: string,
): string | undefined {
  try {
    return getWorkspaceChatArchivesFilePath(projectId, worktreeId);
  } catch (error) {
    if (!(error instanceof IdentifierValidationError)) throw error;
    logMainProcessWarn(
      '[chat-search] Skipped a chat scope with an invalid id',
      {
        reason: 'chat-search-archive-scope-id-invalid',
        projectId,
      },
    );
    return undefined;
  }
}
