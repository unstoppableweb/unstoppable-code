import type { StageVisualDocument } from '../lib/chat-visual-contracts';
import type { ShowVisualHost } from './show-visual-runtime';
import type { VisualMeasureResult } from '../browser/visual-preview-types';
import {
  measureVisualThroughCore,
  stageVisualThroughCore,
} from './visual-core-client';

/**
 * The trusted ShowVisual host for one authenticated chat route. Scope, chat,
 * and working directory come from the session, never from tool arguments.
 * Staging goes through `core.chat.visual.stage`, measuring through
 * `worker.visual.render` (CAN-6040). A host without a render engine refuses
 * the measurement with `capability_unavailable`, and ShowVisual stages
 * without heights.
 */
export function createShowVisualHost(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  cwd: string;
}): ShowVisualHost {
  const scope = { projectId: target.projectId, worktreeId: target.worktreeId };
  return {
    scope,
    chatId: target.chatId,
    cwd: target.cwd,
    measureVisual: async (prepared, options): Promise<VisualMeasureResult> =>
      measureVisualThroughCore(
        {
          prepared: { html: prepared.html },
          maxHeight: options.maxHeight,
          widths: [...options.widths],
          deadlineMs: options.deadlineMs,
        },
        options.signal,
      ),
    stageVisual: async (document: StageVisualDocument): Promise<void> => {
      await stageVisualThroughCore(
        { ...scope, chatId: target.chatId },
        document,
      );
    },
  };
}
