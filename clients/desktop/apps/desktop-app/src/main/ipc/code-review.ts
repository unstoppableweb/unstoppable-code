import type { BrowserWindow, WebContents } from 'electron';
import {
  IPC_CHANNELS,
  buildCodeReviewScopeKey,
  type CodeReviewArmRequest,
  type CodeReviewFile,
  type CodeReviewGenerateRequest,
  type CodeReviewGenerationResult,
  type CodeReviewGetRequest,
  type CodeReviewGetResponse,
  type CodeReviewModalOpenRequest,
  type CodeReviewSaveCommentsRequest,
  type CodeReviewUpdatedEvent,
  type RegisterCodeReviewRequest,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from './register';
import { validateId } from '../lib/validation';
import {
  readCodeReviewState,
  saveCodeReviewComments,
  skippedCommentThreadsField,
} from '../lib/code-review-persistence';
import {
  computeReviewFingerprint,
  listReviewRepos,
} from '../lib/code-review-diff';
import {
  armCodeReview,
  requestManualCodeReviewRefresh,
  setCodeReviewModalOpen,
} from '../lib/code-review-scheduler';
import { registerCodeReviewTarget } from '../lib/code-review-registry';
import { sendToAllWindows } from '../lib/window-send';

const visibilityLeases = new WeakMap<WebContents, Map<string, () => void>>();

export function registerCodeReviewHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  registerIpcHandler<[CodeReviewGetRequest], CodeReviewGetResponse>(
    IPC_CHANNELS.codeReviewGet,
    async (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      const [review, repos] = await Promise.all([
        readCodeReviewState(request.projectId, request.worktreeId),
        listReviewRepos(request.projectId, request.worktreeId),
      ]);
      const fingerprint = await computeReviewFingerprint(repos);
      return {
        review,
        fingerprint,
        ...skippedCommentThreadsField(request.projectId, request.worktreeId),
      };
    },
  );

  registerIpcHandler<[CodeReviewArmRequest], CodeReviewGenerationResult>(
    IPC_CHANNELS.codeReviewArm,
    async (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      return armCodeReview(request, getWindow);
    },
  );

  registerIpcHandler<[CodeReviewGenerateRequest], CodeReviewGenerationResult>(
    IPC_CHANNELS.codeReviewGenerate,
    async (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      return requestManualCodeReviewRefresh(request, getWindow);
    },
  );

  registerIpcHandler<[CodeReviewSaveCommentsRequest], CodeReviewFile | null>(
    IPC_CHANNELS.codeReviewSaveComments,
    async (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      const updated = await saveCodeReviewComments(request);
      if (updated) {
        const repos = await listReviewRepos(
          request.projectId,
          request.worktreeId,
        );
        const fingerprint = await computeReviewFingerprint(repos);
        const event: CodeReviewUpdatedEvent = {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          fingerprint,
          review: updated,
          ...skippedCommentThreadsField(request.projectId, request.worktreeId),
        };
        sendToAllWindows(IPC_CHANNELS.codeReviewUpdated, event);
      }
      return updated;
    },
  );

  registerIpcHandler<[RegisterCodeReviewRequest], void>(
    IPC_CHANNELS.codeReviewRegister,
    async (_event, request) => {
      validateId(request.worktreeId, 'worktreeId');
      validateId(request.projectId, 'projectId');
      // The IPC request carries the REAL ids; compute the composite scope key
      // and store the full ref so downstream resolution never parses it back.
      await registerCodeReviewTarget(
        buildCodeReviewScopeKey(request.projectId, request.worktreeId),
        { projectId: request.projectId, worktreeId: request.worktreeId },
      );
    },
  );

  registerIpcHandler<[CodeReviewModalOpenRequest], void>(
    IPC_CHANNELS.codeReviewModalOpen,
    (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      if (typeof request.open !== 'boolean')
        throw new Error('open must be a boolean');
      if (request.consumerId !== undefined)
        validateId(request.consumerId, 'consumerId');
      if (_event.sender) {
        let leases = visibilityLeases.get(_event.sender);
        if (!leases) {
          leases = new Map();
          visibilityLeases.set(_event.sender, leases);
          const ownedLeases = leases;
          const release = (): void => {
            for (const close of Array.from(ownedLeases.values())) close();
            ownedLeases.clear();
          };
          _event.sender.once('destroyed', release);
          _event.sender.on('render-process-gone', release);
        }
        const key = `${request.projectId}/${request.worktreeId}/${request.consumerId ?? 'legacy'}`;
        if (request.open)
          leases.set(key, () =>
            setCodeReviewModalOpen(
              request,
              false,
              getWindow,
              request.consumerId,
            ),
          );
        else leases.delete(key);
      }
      setCodeReviewModalOpen(
        request,
        request.open,
        getWindow,
        request.consumerId,
      );
    },
  );
}
