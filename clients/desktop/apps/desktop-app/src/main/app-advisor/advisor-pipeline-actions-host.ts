import { stat } from 'node:fs/promises';
import type { BrowserWindow } from 'electron';
import { loadExecutionState } from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import { toAdvisorJson as json } from './advisor-json';
import type {
  AdvisorPipelineActionHost,
  ChatTarget,
} from './advisor-pipeline-actions';

/**
 * The main owners behind App Advisor's moved pipeline actions (CAN-6001):
 * the execution store, the containment-checked report and plan reader
 * worktree chats use, main's rerun, the stored chat tabs, the send owner
 * behind worktree-chat.send_message, main's failure debug prompt and the
 * advisor-chat creation owner.
 */
export function mainAdvisorPipelineActionHost(options: {
  getWindow: () => BrowserWindow | null;
  readTabs: AdvisorPipelineActionHost['readTabs'];
  sendToChat: (target: ChatTarget, text: string) => Promise<void>;
  revealChat: (target: ChatTarget) => Promise<void>;
  createAdvisorChat: AdvisorPipelineActionHost['createAdvisorChat'];
}): AdvisorPipelineActionHost {
  return {
    loadExecution: async (executionId) => {
      const { createElectronExecutionRuntime } =
        await import('../pipelines/execution-runtime');
      return loadExecutionState(
        executionId,
        createElectronExecutionRuntime().executionsDir,
      );
    },
    readArtifact: async (state, artifact) => {
      const { readExecutionArtifact } =
        await import('../canopy-tools/execution-artifacts');
      return readExecutionArtifact(state, artifact);
    },
    statFile: async (filePath) => {
      const info = await stat(filePath).catch(() => null);
      return info ? { sizeBytes: info.size, modifiedAtMs: info.mtimeMs } : null;
    },
    rerun: async (executionId) => {
      const { rerunPipelineExecutionFromMain } =
        await import('../pipelines/pipeline-handlers');
      return json(
        await rerunPipelineExecutionFromMain({
          executionId,
          getWindow: options.getWindow,
        }),
      );
    },
    readTabs: options.readTabs,
    sendToChat: options.sendToChat,
    revealChat: options.revealChat,
    debugPrompt: async (executionId) => {
      const { getPipelineFailureDebugContext } =
        await import('../services/pipelines-service');
      return (await getPipelineFailureDebugContext(executionId)).prompt;
    },
    createAdvisorChat: options.createAdvisorChat,
  };
}
