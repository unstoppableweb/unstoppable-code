import type {
  SaveSharedContainerFileScopeRequest,
  SaveSharedContainerFileScopeResponse,
} from '@canopy/desktop-shared/types';
import { fileScopeIsAllowlist } from '@canopy/desktop-shared/lib/shared-container-scope-mode';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import {
  normalizeSharedContainerFileScope,
  readSharedContainerFileScope,
  SharedContainerScopeWriteAbandonedError,
  writeSharedContainerFileScope,
} from './file-scope-store';
import { getSharedContainerPublishScheduler } from './publish/scheduler';
import { listSharedContainerUntrackedCandidatePaths } from './share-preview';

/** A Cowork allowlist path that is neither a current candidate nor approved. */
export class SharedContainerForgedScopePathError extends Error {
  constructor() {
    super('includedPaths must be current untracked files');
    this.name = 'SharedContainerForgedScopePathError';
  }
}

/**
 * Saves a worktree's share file scope as save-file-scope always has, behind
 * core.publication.fileScope.update (CAN-6501 PR 6). The caller has already
 * checked the gate, the ids and the list shapes and bounds.
 */
export async function saveSharedContainerFileScope(
  request: SaveSharedContainerFileScopeRequest,
  signal?: AbortSignal,
): Promise<SaveSharedContainerFileScopeResponse> {
  const preferredLayoutRequest = request.preferredLayout ?? 'keep';
  // Up to and including the atomic scope write, a save its caller abandoned
  // stops as abandoned whatever failed; after the write, it finishes.
  let written = false;
  try {
    const normalizedScope = normalizeSharedContainerFileScope({
      includedPaths: request.includedPaths,
      ...(request.excludedPaths !== undefined
        ? { excludedPaths: request.excludedPaths }
        : {}),
      ...(request.legacyAllowlist === true ? { legacyAllowlist: true } : {}),
      includedNoteIds: request.includedNoteIds ?? [],
      excludedNoteIds: request.excludedNoteIds ?? [],
      includedPromptIds: request.includedPromptIds ?? [],
      excludedPromptIds: request.excludedPromptIds ?? [],
      runSharingEnabled: request.runSharingEnabled,
      runSharingDisabled: request.runSharingDisabled,
      includedRunScripts: request.includedRunScripts,
      excludedRunScripts: request.excludedRunScripts,
    });
    const isCoworkContainer = isCoworkWorkspace(request.projectId);
    // Worktrees are permanently opt-out. Old clients and persisted previews
    // may still send their former allowlist fields, but retaining those fields
    // would stop an otherwise-default scope from collapsing back to no file.
    let includedPaths = isCoworkContainer ? normalizedScope.includedPaths : [];
    if (
      normalizedScope.includedPaths.length > 0 &&
      isCoworkContainer &&
      fileScopeIsAllowlist('COWORK_WORK_ENTRY', normalizedScope)
    ) {
      const [persistedScope, currentCandidatePaths] = await Promise.all([
        readSharedContainerFileScope(request.projectId, request.worktreeId),
        listSharedContainerUntrackedCandidatePaths(
          request.projectId,
          request.worktreeId,
        ),
      ]);
      const candidatePaths = new Set(currentCandidatePaths);
      const previouslyApprovedPaths = new Set(persistedScope.includedPaths);
      if (
        normalizedScope.includedPaths.some(
          (path) =>
            !candidatePaths.has(path) && !previouslyApprovedPaths.has(path),
        )
      ) {
        throw new SharedContainerForgedScopePathError();
      }
      // A path may become tracked or disappear between opening the preview and
      // editing the scope. It is safe to prune a previously persisted approval,
      // but a never-approved non-candidate remains a forged request and fails.
      includedPaths = normalizedScope.includedPaths.filter((path) =>
        candidatePaths.has(path),
      );
    }
    // The pin runs under the scope write's lock, so no save commits between
    // them, and the answer is the scope both left.
    const fileScope = await writeSharedContainerFileScope(
      request.projectId,
      request.worktreeId,
      {
        includedPaths,
        ...(normalizedScope.excludedPaths !== undefined
          ? { excludedPaths: normalizedScope.excludedPaths }
          : {}),
        ...(isCoworkContainer && normalizedScope.legacyAllowlist === true
          ? { legacyAllowlist: true }
          : {}),
        includedNoteIds: normalizedScope.includedNoteIds,
        excludedNoteIds: normalizedScope.excludedNoteIds,
        includedPromptIds: normalizedScope.includedPromptIds,
        excludedPromptIds: normalizedScope.excludedPromptIds,
        runSharingEnabled: normalizedScope.runSharingEnabled,
        runSharingDisabled: normalizedScope.runSharingDisabled,
        includedRunScripts: normalizedScope.includedRunScripts,
        excludedRunScripts: normalizedScope.excludedRunScripts,
        // The store leaves the persisted preferred layout unchanged when this
        // field is absent, which is `keep`.
        ...(preferredLayoutRequest === 'clear'
          ? { preferredLayout: { enabled: false } }
          : {}),
      },
      {
        signal,
        pinCurrentLayout: preferredLayoutRequest === 'pin-current',
        onWritten: () => {
          written = true;
        },
      },
    );
    return { fileScope };
  } catch (error) {
    if (signal?.aborted && !written)
      throw new SharedContainerScopeWriteAbandonedError();
    throw error;
  } finally {
    // Once the scope write has persisted, its publication is scheduled even
    // when the pin after it fails.
    if (written)
      void getSharedContainerPublishScheduler()
        .scheduleKnown(request.projectId, request.worktreeId, true)
        .catch((error) =>
          logMainProcessWarn(
            '[shared-containers] failed to schedule scope publication',
            error,
          ),
        );
  }
}
