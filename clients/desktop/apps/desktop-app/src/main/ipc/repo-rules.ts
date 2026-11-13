import type { IpcMainInvokeEvent } from 'electron';
import {
  CORE_WORKSPACE_REPO_RULES_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  repoRulesScanRequestSchema,
  repoRulesApplyRequestSchema,
  repoRulesPreviewRequestSchema,
  type RepoRulesScanResponse,
  type RepoRulesApplyResponse,
  type RepoRulesStatus,
  type RepoRulesPreviewResponse,
  type EditorSetupPresence,
} from '@canopy/protocol/repo-rules';
import {
  isRepoRulesLocalCaller,
  REPO_RULES_LOCAL_ONLY_MESSAGE,
} from '@canopy/core-runtime/node/workspace/workspace-repo-rules';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { preserveRuntimeCauseError } from '../canopy-runtime/runtime-cause-error';
import { registerIpcHandler } from './register';
import { resolveRepoRuleCheckouts } from '../repo-rules/host';
import { repoRulesWorker } from '../repo-rules/worker';

/*
 * Compatibility projections over `core.workspace.repoRules.*`. Each handler
 * parses with the request schema first, so malformed input keeps its legacy
 * error, then authorizes the workspace and dispatches holding only the grant
 * each call requires. The core handlers repeat the local-only check.
 */
export function registerRepoRulesHandlers(
  dispatcher: Pick<DesktopCanopyDispatcher, 'query' | 'instruction'>,
  resolveCaller: (event: IpcMainInvokeEvent) => CanopyCallerDescriptor,
): void {
  const authorize = async (
    event: IpcMainInvokeEvent,
    workspaceId: string,
    worktreeId?: string,
  ): Promise<CanopyCallerDescriptor> => {
    const caller = resolveCaller(event);
    // Local opt-in grants ongoing checkout reads. Remote bridge callers cannot
    // consent on behalf of the local account in this Phase 1 implementation.
    if (!isRepoRulesLocalCaller(caller))
      throw new Error(REPO_RULES_LOCAL_ONLY_MESSAGE);
    const workspace = await dispatcher.query(
      'core.workspace.get',
      { workspaceId },
      { caller: { ...caller, grants: ['core.workspace.read'] } },
    );
    if (workspace.kind !== 'git') throw new Error('Select a code workspace.');
    if (worktreeId) {
      const worktree = await dispatcher.query(
        'core.worktree.get',
        { worktreeId, scope: { workspaceId } },
        { caller: { ...caller, grants: ['core.worktree.read'] } },
      );
      if (worktree.workspaceId !== workspaceId)
        throw new Error('The checkout does not belong to this workspace.');
    }
    return caller;
  };
  const reading = (
    caller: CanopyCallerDescriptor,
  ): { caller: CanopyCallerDescriptor } => ({
    caller: { ...caller, grants: [CORE_WORKSPACE_REPO_RULES_GRANTS.read] },
  });
  registerIpcHandler<[unknown], RepoRulesScanResponse>(
    IPC_CHANNELS.repoRulesScan,
    async (event, input) => {
      const request = repoRulesScanRequestSchema.parse(input);
      const caller = await authorize(
        event,
        request.workspaceId,
        request.worktreeId,
      );
      return preserveRuntimeCauseError(
        dispatcher.query(
          'core.workspace.repoRules.scan',
          request,
          reading(caller),
        ),
      );
    },
  );
  registerIpcHandler<[unknown], RepoRulesApplyResponse>(
    IPC_CHANNELS.repoRulesApply,
    async (event, input) => {
      const request = repoRulesApplyRequestSchema.parse(input);
      const caller = await authorize(event, request.workspaceId);
      return preserveRuntimeCauseError(
        dispatcher.instruction('core.workspace.repoRules.apply', request, {
          caller: {
            ...caller,
            grants: [CORE_WORKSPACE_REPO_RULES_GRANTS.write],
          },
        }),
      );
    },
  );
  registerIpcHandler<[unknown], RepoRulesStatus>(
    IPC_CHANNELS.repoRulesStatus,
    async (event, input) => {
      const request = repoRulesScanRequestSchema
        .pick({ workspaceId: true })
        .parse(input);
      const caller = await authorize(event, request.workspaceId);
      return preserveRuntimeCauseError(
        dispatcher.query(
          'core.workspace.repoRules.status',
          request,
          reading(caller),
        ),
      );
    },
  );
  registerIpcHandler<[unknown], RepoRulesPreviewResponse>(
    IPC_CHANNELS.repoRulesPreview,
    async (event, input) => {
      const request = repoRulesPreviewRequestSchema.parse(input);
      const caller = await authorize(event, request.workspaceId);
      return preserveRuntimeCauseError(
        dispatcher.query(
          'core.workspace.repoRules.preview',
          request,
          reading(caller),
        ),
      );
    },
  );
  // Out of scope for CAN-4905 (CAN-3745 RC-12): presence still reads the
  // checkouts directly after the same authorization.
  registerIpcHandler<[unknown], EditorSetupPresence>(
    IPC_CHANNELS.editorSetupPresence,
    async (event, input) => {
      const request = repoRulesScanRequestSchema.parse(input);
      await authorize(event, request.workspaceId, request.worktreeId);
      return repoRulesWorker
        .presence(await resolveRepoRuleCheckouts(request))
        .catch(() => ({ cursorRulesPresent: false }));
    },
  );
}
