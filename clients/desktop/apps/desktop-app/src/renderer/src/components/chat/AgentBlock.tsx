import { DeferredToolOutput } from '@canopy/ui-app';
import { useContext, type JSX } from 'react';
import { useActivityStore } from '@/stores/activityStore';
import { ChatMarkdownFileTargetContext } from './chat-markdown-file-target';
import { isClaudeAgentRunning } from './agent-block-state';
import { AgentBlockCard } from '@canopy/ui-shared/components';
import { TaskStopAction } from '@canopy/ui-app';
import type { ToolResult, DisplayBlock } from './types';
import type { AgentUsage } from '@canopy/desktop-shared/types';
import {
  liveBackgroundTaskKey,
  useLiveBackgroundTaskStore,
} from '@/stores/liveBackgroundTaskStore';
import { NativeTaskStopContext } from './native-task-stop';
import { TranscriptSearchRevealContext } from './transcript-search-reveal';
import { useSubagentOpenChatCallback } from '@/components/subagents/subagent-entry-actions';

interface AgentBlockSubagentIdentity {
  readonly kind: 'claude-native' | 'codex-native';
  readonly id?: string;
  readonly title: string;
}

interface AgentBlockProps {
  toolUseId?: string;
  chatId?: string;
  subagentType: string;
  description: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  runInBackground: boolean;
  result?: ToolResult;
  taskOutputResult?: ToolResult;
  subBlocks: DisplayBlock[];
  usage?: AgentUsage;
  isRunningOverride?: boolean;
  isErrorOverride?: boolean;
  nativeTaskStop?: boolean;
  subagentIdentity?: AgentBlockSubagentIdentity;
  renderSubBlock: AgentSubBlockRenderer;
}

/**
 * Render a sub-block belonging to an agent. The renderer is injected by the
 * parent (typically `ChatBlockRenderer`) so this component does not have to
 * import its caller — that breaks the otherwise mutually-recursive cycle
 * between `AgentBlock` and `ChatBlockRenderer`.
 */
export type AgentSubBlockRenderer = (
  block: DisplayBlock,
  index: number,
) => JSX.Element | null;

/**
 * Desktop wrapper around the shared `AgentBlockCard`. Owns the desktop-only
 * concerns: Codex `agentsStates`-derived running/error overrides, background
 * process status, and the recursive sub-block rendering via `renderSubBlock`.
 * The shared card lays out the visual chrome and the usage cells.
 */
export function AgentBlock({
  toolUseId,
  chatId,
  subagentType,
  description,
  prompt,
  model,
  reasoningEffort,
  runInBackground,
  result,
  taskOutputResult,
  subBlocks,
  usage,
  isRunningOverride,
  isErrorOverride,
  nativeTaskStop,
  subagentIdentity,
  renderSubBlock,
}: AgentBlockProps): JSX.Element {
  const target = useContext(ChatMarkdownFileTargetContext);
  const nativeStop = useContext(NativeTaskStopContext);
  const searchReveal = useContext(TranscriptSearchRevealContext);
  const nativeStopTarget = nativeStop?.target;
  const liveTaskId = useLiveBackgroundTaskStore((state) => {
    if (!nativeStopTarget || !toolUseId) return undefined;
    const key = liveBackgroundTaskKey(
      nativeStopTarget.projectId,
      nativeStopTarget.worktreeId,
      nativeStopTarget.chatId,
    );
    return state.byChat[key]?.liveTasks.find(
      (task) => task.toolUseId === toolUseId,
    )?.taskId;
  });
  const onOpenChat = useSubagentOpenChatCallback(
    subagentIdentity?.kind ?? 'claude-native',
    subagentIdentity?.id,
    subagentIdentity?.title ?? description,
  );
  const backgroundProcess = useActivityStore((state) =>
    target && chatId && toolUseId
      ? state.bgProcesses[`${target.projectId}/${target.worktreeId}`]?.find(
          (process) =>
            process.chatId === chatId && process.toolUseId === toolUseId,
        )
      : undefined,
  );
  const backgroundStatus = backgroundProcess?.status;
  // A background agent whose transcript carries no output of its own (a
  // cloud subagent, whose task row reports how it ended) shows its process's
  // summary, as an error when it failed.
  const processResult: ToolResult | undefined =
    backgroundProcess?.summary !== undefined &&
    (backgroundStatus === 'completed' || backgroundStatus === 'failed')
      ? {
          output: backgroundProcess.summary,
          isError: backgroundStatus === 'failed',
        }
      : undefined;
  const displayResult = taskOutputResult ?? processResult ?? result;
  const isRunning =
    isRunningOverride ??
    isClaudeAgentRunning(
      runInBackground,
      result,
      taskOutputResult,
      backgroundStatus,
    );
  const isError = isErrorOverride ?? displayResult?.isError === true;
  const hasSubBlocks = subBlocks.length > 0;
  const headerAction =
    nativeTaskStop &&
    nativeStop !== null &&
    toolUseId &&
    liveTaskId !== undefined &&
    isRunning ? (
      <TaskStopAction
        target={{ ...nativeStop.target, taskId: liveTaskId }}
        live
        accessibleLabel="Stop agent"
        dataTestId="agent-task-stop"
        onError={nativeStop.onError}
      />
    ) : undefined;

  return (
    <>
      <AgentBlockCard
        dataTestId="agent-block"
        toolUseId={toolUseId}
        subagentType={subagentType}
        description={description}
        runInBackground={runInBackground}
        isRunning={isRunning}
        isError={isError}
        headerAction={headerAction}
        usage={usage}
        result={displayResult ? displayResult.output : undefined}
        prompt={prompt}
        model={model}
        reasoningEffort={reasoningEffort}
        onOpenChat={onOpenChat}
        forceExpanded={searchReveal}
        subBlocks={
          hasSubBlocks
            ? subBlocks.map((block, i) => renderSubBlock(block, i))
            : undefined
        }
      />
      {displayResult?.fullOutputRef &&
        displayResult.messageId &&
        displayResult.toolUseId && (
          // The card already shows the bounded output above; the viewer only
          // contributes the full-output control, so it gets an empty preview.
          <div data-testid="chat-deferred-output-host">
            <DeferredToolOutput
              identity={{
                kind: 'reference',
                reference: displayResult.fullOutputRef,
                messageId: displayResult.messageId,
                toolUseId: displayResult.toolUseId,
              }}
              preview=""
              isError={displayResult.isError}
            />
          </div>
        )}
    </>
  );
}
