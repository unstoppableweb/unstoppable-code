import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  isGitHubPreviewTarget,
  isGitHubReferenceOrigin,
  isLinearIssuePreviewRequest,
  type GitHubOriginRepository,
  type GitHubPreviewResult,
  type GitHubPreviewScope,
  type LinearIssuePreviewResult,
  type LinearPreviewScope,
  type LinearTeamKeysResult,
} from '@canopy/protocol/reference-previews';
import type { CoreIntegrationDispatcher } from '../canopy-runtime/core-integration-adapter';
import {
  readLinearIssueForIpc,
  readLinearTeamKeysForIpc,
} from '../canopy-runtime/linear-integration-dispatch';
import { createGitHubReferencePreviewReader } from '../lib/github-reference-preview';
import { sharedLinearReferencePreviewReader } from '../lib/linear-reference-preview';
import type { DesktopIpcCallerResolver } from './file-tree';
import { registerIpcHandler } from './register';

/**
 * Read-only previews for transcript references; credentials stay in main.
 * The Linear team keys and issue reads project core.integration (CAN-4178).
 */
export function registerReferencePreviewHandlers(runtime: {
  dispatcher: CoreIntegrationDispatcher;
  resolveCaller: DesktopIpcCallerResolver;
}): void {
  const github = createGitHubReferencePreviewReader();

  // Direct (CAN-4095): no core.integration operation reads the scope alone.
  registerIpcHandler<[], LinearPreviewScope>(
    IPC_CHANNELS.referencePreviewLinearScope,
    () => sharedLinearReferencePreviewReader().readScope(),
  );

  registerIpcHandler<[], LinearTeamKeysResult>(
    IPC_CHANNELS.referencePreviewLinearTeams,
    (event) =>
      readLinearTeamKeysForIpc(
        runtime.dispatcher,
        runtime.resolveCaller(event),
      ),
  );

  registerIpcHandler<[unknown], LinearIssuePreviewResult>(
    IPC_CHANNELS.referencePreviewLinearIssue,
    async (event, request) => {
      if (!isLinearIssuePreviewRequest(request)) {
        throw new Error('Invalid Linear issue preview request.');
      }
      return readLinearIssueForIpc(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        {
          identifier: request.identifier,
          ...(request.workspaceSlug !== undefined
            ? { workspaceSlug: request.workspaceSlug }
            : {}),
        },
      );
    },
  );

  registerIpcHandler<[], GitHubPreviewScope>(
    IPC_CHANNELS.referencePreviewGitHubScope,
    () => github.readScope(),
  );

  registerIpcHandler<[unknown], GitHubOriginRepository>(
    IPC_CHANNELS.referencePreviewGitHubOrigin,
    async (_event, origin) => {
      if (!isGitHubReferenceOrigin(origin)) {
        throw new Error('Invalid GitHub reference origin.');
      }
      return github.readOrigin(
        origin.kind === 'worktree'
          ? {
              kind: 'worktree',
              projectId: origin.projectId,
              worktreeId: origin.worktreeId,
            }
          : { kind: 'cowork' },
      );
    },
  );

  registerIpcHandler<[unknown], GitHubPreviewResult>(
    IPC_CHANNELS.referencePreviewGitHub,
    async (_event, target) => {
      if (!isGitHubPreviewTarget(target)) {
        throw new Error('Invalid GitHub preview request.');
      }
      return github.read(
        target.kind === 'item'
          ? {
              kind: 'item',
              owner: target.owner,
              repository: target.repository,
              number: target.number,
            }
          : {
              kind: 'repository',
              owner: target.owner,
              repository: target.repository,
            },
      );
    },
  );
}
