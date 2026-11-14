import type { SidebarItemsFile } from '@canopy/desktop-shared/types';
import { writeAllSidebarItems } from './sidebar-items';
import {
  workspaceAdditionWriteFor,
  workspaceCreationWriteFor,
} from './worktree-record-decision-apply';
import type {
  WorkspaceAdditionDecision,
  WorkspaceCreationDecision,
} from './worktree-record-decisions';

// The workspace-service staging members of `W5RecordDecisionPort` (W6a1),
// applied through the whole-sidebar writer the records used, unchanged. Kept
// apart so the other ports' importers do not load it.

/**
 * Applies a find-or-create addition in the caller's workspace mutation queue,
 * and in its boundary step when the addition is scoped.
 */
export async function applyWorkspaceAdditionDecision(
  decision: WorkspaceAdditionDecision,
): Promise<SidebarItemsFile> {
  const write = workspaceAdditionWriteFor(decision);
  return writeAllSidebarItems(write.items, write.options);
}

/**
 * Publishes a create or an import in its creation boundary step;
 * `beforeEffects` marks the write as the step's first potential effect.
 */
export async function applyWorkspaceCreationDecision(
  decision: WorkspaceCreationDecision,
  beforeEffects: () => void,
): Promise<void> {
  const write = workspaceCreationWriteFor(decision);
  beforeEffects();
  await writeAllSidebarItems(write.items, write.options);
}
