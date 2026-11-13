import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type JSX,
} from 'react';
import { useStore } from 'zustand';
import { CanopyClientProvider, useChatStoreApi } from '@canopy/app-state';
import type {
  CloudChatThread,
  CloudChatThreadTarget,
} from '@canopy/app-state/core-cowork';
import {
  ChatPanel as SharedChatPanel,
  type ChatComposerHostControls,
} from '@canopy/ui-app/chat-panel';
import {
  AskUserQuestionInteractionProvider,
  BackgroundTray,
  ChatTranscript,
  type AskUserQuestionInteraction,
  type ChatPanelSendContext,
} from '@canopy/ui-app';
import { Notice } from '@canopy/ui-shared/components';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { agentTaskBackgroundTasks } from '@canopy/agent-transcript/agent-tasks';
import { cloudChatCanopyClient } from './cloud-chat-client';
import {
  CloudChatComposerHost,
  useCloudChatCatalog,
} from './CloudChatComposerHost';
import { useCloudChatSelection } from './cloud-chat-selection';
import {
  closeAllCloudChatThreads,
  retainCloudChatThread,
} from './cloud-chat-threads';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { webCoreLocalId } from '@/lib/chat-authority';
import { cloudCoworkStore } from './useCloudCoworkSidebar';

/** The selected chat's ids on the web core, while the cloud is online. */
function useCloudChatTarget(): CloudChatThreadTarget | null {
  const selectedChatKey = useCloudChatSelection(
    (state) => state.selectedChatKey,
  );
  const status = useStore(cloudCoworkStore, (state) => state.status);
  const tasksByProject = useStore(
    cloudCoworkStore,
    (state) => state.tasksByProject,
  );
  return useMemo(() => {
    if (status !== 'online' || selectedChatKey === null) return null;
    const chatId = webCoreLocalId(selectedChatKey);
    if (chatId === null) return null;
    // A task's root chat is the task: its chat id is the task's worktree id.
    for (const tasks of Object.values(tasksByProject)) {
      const task = tasks.find((each) => each.worktreeId === chatId);
      if (task)
        return {
          key: selectedChatKey,
          workspaceId: task.workspaceId,
          worktreeId: task.worktreeId,
          chatId,
        };
    }
    return null;
  }, [selectedChatKey, status, tasksByProject]);
}

/** CAN-5974: names the open cloud chat in the current UI state, ids and title only. */
function useReportOpenCloudChat(target: CloudChatThreadTarget | null): void {
  const title = useStore(cloudCoworkStore, (state) => {
    if (target === null) return null;
    for (const tasks of Object.values(state.tasksByProject)) {
      const task = tasks.find((each) => each.worktreeId === target.worktreeId);
      if (task) return task.title;
    }
    return null;
  });
  useCurrentUiStateReporter(
    'cloudChat.open',
    target === null
      ? null
      : {
          chatId: target.chatId,
          projectId: target.workspaceId,
          title: title ?? '',
        },
  );
}

function CloudChatSurface({
  target,
}: {
  target: CloudChatThreadTarget;
}): JSX.Element {
  const chatStore = useChatStoreApi();
  const thread = useMemo(
    () => retainCloudChatThread(target, chatStore),
    [target, chatStore],
  );
  if (thread === null)
    return (
      <div className="p-4">
        <Notice intent="destructive">Cloud chats are unavailable.</Notice>
      </div>
    );
  return <CloudChatThreadView target={target} thread={thread} />;
}

function CloudChatThreadView({
  target,
  thread,
}: {
  target: CloudChatThreadTarget;
  thread: CloudChatThread;
}): JSX.Element {
  const subscribeQuestions = useCallback(
    (listener: () => void): (() => void) => thread.subscribeQuestions(listener),
    [thread],
  );
  const getQuestions = useCallback(() => thread.getQuestions(), [thread]);
  const questions = useSyncExternalStore(subscribeQuestions, getQuestions);
  const subscribeAgentTasks = useCallback(
    (listener: () => void): (() => void) =>
      thread.subscribeAgentTasks(listener),
    [thread],
  );
  const getAgentTasks = useCallback(() => thread.getAgentTasks(), [thread]);
  const agentTasks = useSyncExternalStore(subscribeAgentTasks, getAgentTasks);
  // Background work the chat's tasks report (CAN-5976); a cloud task has no
  // Stop here until the web core serves one.
  const backgroundTasks = useMemo(
    () => agentTaskBackgroundTasks(agentTasks),
    [agentTasks],
  );
  // Live reply text only for the chat on screen (CAN-5984).
  useEffect((): (() => void) => {
    thread.setLive(true);
    return (): void => thread.setLive(false);
  }, [thread]);
  const [sendError, setSendError] = useState<string | null>(null);
  const catalog = useCloudChatCatalog(target);
  const questionInteraction = useMemo<AskUserQuestionInteraction>(
    () => ({
      states: questions,
      onAnswer: (requestId, answers): void => {
        void thread
          .answerQuestion(requestId, answers)
          .catch(reportClientAppError);
      },
      onDismiss: (requestId): void => {
        void thread.dismissQuestion(requestId).catch(reportClientAppError);
      },
    }),
    [questions, thread],
  );
  return (
    <AskUserQuestionInteractionProvider value={questionInteraction}>
      <SharedChatPanel
        chatId={target.key}
        onSend={async (
          text: string,
          context: ChatPanelSendContext,
        ): Promise<void> => {
          try {
            await thread.send({
              text,
              ...(context.optimisticLocalId === undefined
                ? {}
                : { optimisticLocalId: context.optimisticLocalId }),
              ...(context.cloudAttachments === undefined
                ? {}
                : {
                    attachments: context.cloudAttachments.map(
                      ({ attachmentId }) => ({ attachmentId }),
                    ),
                  }),
            });
            setSendError(null);
          } catch (error) {
            // The notice records the failure; a second report would count it twice.
            const reason = toAppError(error)?.detail.message.trim();
            setSendError(
              reason
                ? `Your message wasn't sent: ${reason}`
                : "Your message wasn't sent.",
            );
            // The composer restores the draft and its attachments (CAN-5972).
            throw error;
          }
        }}
        onStop={(): void => {
          void thread.stop().catch(reportClientAppError);
        }}
        onLoadOlder={(): Promise<void> => thread.loadOlder()}
        queueActionsEnabled={false}
        {...(catalog === null
          ? {}
          : {
              renderComposer: (
                controls: ChatComposerHostControls,
              ): JSX.Element => (
                <CloudChatComposerHost
                  controls={controls}
                  target={target}
                  catalog={catalog}
                />
              ),
            })}
        // Shown whether or not a turn is running, unlike the thread's banner.
        footerStatus={
          sendError === null && backgroundTasks.length === 0 ? undefined : (
            <>
              {backgroundTasks.length === 0 ? null : (
                <BackgroundTray chatId={target.key} tasks={backgroundTasks} />
              )}
              {sendError === null ? null : (
                <Notice intent="destructive">
                  <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
                    {sendError}
                  </span>
                </Notice>
              )}
            </>
          )
        }
        // The shared parts block their own content from session replay
        // (CAN-5975), so the transcript's controls stay recorded.
        renderTranscript={(controls): JSX.Element => (
          <div className="flex min-h-0 flex-1 flex-col">
            <ChatTranscript
              {...controls}
              onLoadOlder={(): Promise<void> => thread.loadOlder()}
            />
          </div>
        )}
      />
    </AskUserQuestionInteractionProvider>
  );
}

/** One cloud cowork chat, rendered by the shared chat panel (CAN-4185 D10). */
export function CloudChatPage(): JSX.Element {
  const target = useCloudChatTarget();
  useReportOpenCloudChat(target);
  const status = useStore(cloudCoworkStore, (state) => state.status);
  useEffect(() => {
    if (status !== 'online') closeAllCloudChatThreads();
  }, [status]);
  // The shared chat store lives with this page's provider; its threads go too.
  useEffect(() => closeAllCloudChatThreads, []);
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col"
      data-testid="cloud-chat-page"
    >
      {/* Mounted for the page's whole life, like the threads bound to its store. */}
      <CanopyClientProvider client={cloudChatCanopyClient}>
        {target === null ? (
          <div className="p-4">
            <Notice intent="neutral">
              {status === 'online'
                ? 'Choose a cloud chat in the sidebar.'
                : 'Cloud chats are offline.'}
            </Notice>
          </div>
        ) : (
          <CloudChatSurface key={target.key} target={target} />
        )}
      </CanopyClientProvider>
    </div>
  );
}
