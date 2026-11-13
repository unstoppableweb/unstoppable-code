import {
  CORE_CHAT_VISUAL_STAGE_GRANTS,
  WORKER_VISUAL_GRANTS,
  type CanopyCallerDescriptor,
  type CoreChatVisualStageResult,
  type WorkerVisualRenderParams,
  type WorkerVisualRenderResult,
} from '@canopy/protocol/canopy-core';
import type { StageVisualDocument } from '../lib/chat-visual-contracts';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { activeAgentCoreOperations } from './active-agent-core-operations';

/**
 * ShowVisual and PreviewVisual act as their own principal (CAN-5996,
 * CAN-6040). Kept private to this module, and each call is narrowed to its
 * operation's grant: the chat write grant reaches only
 * `core.chat.visual.stage`, the render grant only `worker.visual.render`.
 */
const AGENT_VISUALS_CALLER: CanopyCallerDescriptor = {
  principalId: 'desktop-agent-visuals',
  clientInstanceId: 'desktop-main',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'mcp',
  grants: [CORE_CHAT_VISUAL_STAGE_GRANTS.write, WORKER_VISUAL_GRANTS.render],
};

type MeasureResult = Extract<WorkerVisualRenderResult, { mode: 'measure' }>;
type PreviewResult = Extract<WorkerVisualRenderResult, { mode: 'preview' }>;

function render(
  params: WorkerVisualRenderParams,
  signal: AbortSignal | undefined,
): Promise<WorkerVisualRenderResult> {
  return activeAgentCoreOperations('visuals').query(
    'worker.visual.render',
    params,
    { caller: AGENT_VISUALS_CALLER, ...(signal ? { signal } : {}) },
  );
}

/**
 * Measures a prepared visual through `worker.visual.render`. A host without
 * a render engine refuses with `capability_unavailable`, which reaches the
 * caller as a CanopyOperationError.
 */
export async function measureVisualThroughCore(
  request: Omit<
    Extract<WorkerVisualRenderParams, { mode: 'measure' }>,
    'scope' | 'mode'
  >,
  signal?: AbortSignal,
): Promise<MeasureResult> {
  const result = await render(
    { scope: {}, mode: 'measure', ...request },
    signal,
  );
  if (result.mode !== 'measure')
    throw new Error('The render result does not match the request.');
  return result;
}

/** Previews a prepared visual through `worker.visual.render`, as above. */
export async function previewVisualThroughCore(
  request: Omit<
    Extract<WorkerVisualRenderParams, { mode: 'preview' }>,
    'scope' | 'mode'
  >,
  signal?: AbortSignal,
): Promise<PreviewResult> {
  const result = await render(
    { scope: {}, mode: 'preview', ...request },
    signal,
  );
  if (result.mode !== 'preview')
    throw new Error('The render result does not match the request.');
  return result;
}

/**
 * Stages a prepared visual into the session's chat. The key is the visual's
 * own id, which ShowVisual mints once per call, so a replayed dispatch stages
 * once.
 */
export async function stageVisualThroughCore(
  target: { projectId: string; worktreeId: string; chatId: string },
  document: StageVisualDocument,
): Promise<CoreChatVisualStageResult> {
  const idempotencyKey = `agent-visual-stage:${target.chatId}:${document.visualId}`;
  return activeAgentCoreOperations('visuals').instruction(
    'core.chat.visual.stage',
    {
      recipient: {
        workspaceId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.chatId,
      },
      visual: {
        visualId: document.visualId,
        html: document.html,
        title: document.title,
        maxHeight: document.maxHeight,
        ...(document.heights
          ? {
              heights: document.heights.map(
                ([width, height]): [number, number] => [width, height],
              ),
            }
          : {}),
        ...(document.codexCallId ? { codexCallId: document.codexCallId } : {}),
      },
      _meta: { idempotencyKey },
    },
    { caller: AGENT_VISUALS_CALLER, metadata: { idempotencyKey } },
  );
}
