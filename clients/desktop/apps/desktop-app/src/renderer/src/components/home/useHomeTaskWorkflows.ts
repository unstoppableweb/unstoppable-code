import { useEffect } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';
import type { PipelineExecutionScope } from '@canopy/protocol/pipelines';
import { pipelineSupportsExecutionScope } from '@/lib/pipelineExecutionScope';
import { loadDisabledPipelineIdsBestEffort } from '@/lib/pipelineEnablement';
import {
  useHomeComposerStore,
  type HomeSelectedWorkflow,
} from '@/stores/homeComposerStore';

/**
 * Whether an attached workflow still runs as it was inserted: turned on and,
 * for a saved or bundled workflow, still listed under the same definition,
 * unchanged since Insert and able to run in `scope`. A project workflow is
 * read from its checkout, which this list does not cover, so only its
 * enablement is checked here.
 */
function attachmentStillFits(
  attached: HomeSelectedWorkflow,
  infos: readonly PipelineInfo[],
  disabledIds: ReadonlySet<string>,
  scope: PipelineExecutionScope,
): boolean {
  if (disabledIds.has(attached.id)) return false;
  if (attached.source !== 'user' && attached.source !== 'bundled') return true;
  // The runner resolves an id to the user's definition first, so a bundled
  // workflow a user workflow shadows is not the attached one.
  const shadowed =
    attached.source === 'bundled' &&
    infos.some((info) => info.source === 'user' && info.id === attached.id);
  const current = infos.find(
    (info) => info.id === attached.id && info.source === attached.source,
  );
  return (
    !shadowed &&
    current !== undefined &&
    current.updatedAt === attached.pipeline.info.updatedAt &&
    current.triggerTypes?.includes('task_ready') === true &&
    pipelineSupportsExecutionScope(current, scope)
  );
}

/**
 * Detaches the composer's attached workflow (CAN-7513) once it no longer
 * runs as it was inserted: deleted, turned off, changed since Insert, or not
 * runnable in the send target (such as a worktree-only workflow for a Cowork
 * folder), so the Workflow chip never names a run Send would not make.
 * Checked when the attachment or the target's scope changes, and when
 * `recheckKey` changes (the host passes what changes when it is shown again,
 * such as the active page, since Home stays mounted while hidden).
 */
export function useDropUnfitWorkflowPick(
  attached: HomeSelectedWorkflow | null,
  scope: PipelineExecutionScope,
  recheckKey: string,
): void {
  useEffect(() => {
    if (attached === null) return undefined;
    let cancelled = false;
    void Promise.all([
      window.pipelines.list(),
      loadDisabledPipelineIdsBestEffort(),
    ])
      .then(([listed, disabledIds]) => {
        // A failed read proves nothing about the attachment: keep it.
        if (cancelled || !listed.success || !listed.data) return;
        if (
          !attachmentStillFits(attached, listed.data, disabledIds, scope) &&
          useHomeComposerStore.getState().selectedWorkflow === attached
        ) {
          useHomeComposerStore.getState().detachWorkflow();
        }
      })
      .catch((error: unknown) => {
        // Send still runs it; a run that fails opens the dialog on it.
        reportClientAppError(error);
      });
    return (): void => {
      cancelled = true;
    };
  }, [attached, scope, recheckKey]);
}
