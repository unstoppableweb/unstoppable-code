/**
 * The input values a fork gives a container automation that runs a workflow
 * with a `global` target (CAN-6455): a converted chat automation. Its shared
 * document carries the workflow's input names but none of their values, which
 * named the source machine's project, worktree and chat.
 *
 * - A project input (one a step reads as `project_id`) is the fork's project,
 *   when the step that creates something in it suits the fork: a worktree
 *   for a code fork, a Cowork entry for a Cowork fork.
 * - `task_id` is the fork's worktree or Cowork task, so an automation that ran
 *   in its container keeps running in the fork.
 * - A `chat_id` names a chat no fork has, and an Orchestrator input names no
 *   container, so such an automation isn't added.
 * - Anything else is left empty, as an install leaves it.
 */
import type { SharedWorkflowInputKind } from '@canopy/desktop-shared/lib/shared-workflow-inputs';

/** The converter's input naming an existing worktree or Cowork task. */
const TASK_INPUT = 'task_id';
/** The converter's input naming an existing chat. */
const CHAT_INPUT = 'chat_id';

export function forkWorkflowInputs(
  kinds: Readonly<Record<string, SharedWorkflowInputKind>>,
  fork: { isCode: boolean; projectId: string; worktreeId: string },
): { ok: true; inputs: Record<string, string> } | { ok: false } {
  const inputs: Record<string, string> = {};
  for (const [key, kind] of Object.entries(kinds)) {
    if (kind.kind === 'orchestrator') return { ok: false };
    if (kind.kind === 'project') {
      if (
        kind.projectKind !== 'any' &&
        (kind.projectKind === 'code') !== fork.isCode
      )
        return { ok: false };
      inputs[key] = fork.projectId;
    } else if (key === CHAT_INPUT) {
      return { ok: false };
    } else if (key === TASK_INPUT) {
      inputs[key] = fork.worktreeId;
    }
  }
  return { ok: true, inputs };
}
