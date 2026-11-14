import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { useChatStore } from '@/stores/chatStore';
import type { ChatState } from '@/stores/chat/state';
import type { ChatTab, ChatMessage } from '@/stores/chat/types';
import { createEmptyTab } from '@/stores/chat/tab-utils';
import { redactMcpAnswersForDisplay } from '@/stores/chat/messages';
import { formatAskUserAnswers } from '@canopy/desktop-shared/lib/ask-user-answers';
import {
  QUESTION_PRESETS,
  initialPlaygroundMachine,
  reduceQuestionPlayground,
  type PlaygroundEvent,
  type PlaygroundMachine,
} from './chatQuestionPlaygroundData';

const KEY = 'question-sandbox';
const TAB_ID = 'question-sandbox-chat';

interface QuestionSandbox {
  store: UseBoundStore<StoreApi<ChatState>>;
  machine: UseBoundStore<StoreApi<PlaygroundMachine>>;
  dispatch: (event: PlaygroundEvent) => void;
  getTab: () => ChatTab;
  sendMessage: (text: string) => Promise<void>;
  /** Show the question mid-turn, as when an agent keeps working. */
  setTurnRunning: (running: boolean) => void;
  dispose: () => void;
}

/** A disposable renderer-only session. No live action closures enter this store. */
export function createQuestionSandbox(): QuestionSandbox {
  // A typed copy of the live initial state: every action becomes a no-op and
  // every value a deep clone, so nothing in the sandbox reaches the live store.
  const base = useChatStore.getInitialState();
  const initial: ChatState = { ...base };
  for (const key of Object.keys(base)) {
    const value: unknown = Reflect.get(base, key);
    Reflect.set(
      initial,
      key,
      typeof value === 'function'
        ? (): undefined => undefined
        : value === undefined
          ? undefined
          : structuredClone(value),
    );
  }
  const store = create<ChatState>()(() => initial);
  const machine = create(() => initialPlaygroundMachine);
  let waiting:
    | { resolve: () => void; reject: (error: Error) => void }
    | undefined;
  let tab: ChatTab = {
    ...createEmptyTab({ providerTypeHint: 'claude' }),
    id: TAB_ID,
  };
  const publish = (): void =>
    store.setState({
      worktreeChats: { [KEY]: { tabs: [tab], activeTabId: TAB_ID } },
    });
  const updateTab = (patch: Partial<ChatTab>): void => {
    tab = { ...tab, ...patch };
    publish();
  };
  const appendQuestion = (text: string, clear = false): void => {
    const state = machine.getState();
    const preset =
      QUESTION_PRESETS.find((p) => p.id === state.presetId) ??
      QUESTION_PRESETS[0];
    const id = `sandbox-${state.generation}`;
    const messages: ChatMessage[] = [
      {
        id: `${id}-user`,
        role: 'user',
        timestamp: state.generation * 1000,
        blocks: [{ type: 'text', text }],
      },
      {
        id: `${id}-assistant`,
        role: 'assistant',
        timestamp: state.generation * 1000 + 1,
        blocks: [
          { type: 'text', text: preset.prompt },
          {
            type: 'tool_use',
            toolUseId: id,
            toolName: 'mcp__canopy__AskUserQuestion',
            input: JSON.stringify({ questions: preset.questions }),
          },
        ],
      },
    ];
    store.setState({
      pendingQuestions: {
        [id]: {
          requestId: id,
          toolUseId: id,
          projectId: KEY,
          worktreeId: KEY,
          chatId: TAB_ID,
          questions: preset.questions,
        },
      },
    });
    updateTab({ messages: [...(clear ? [] : tab.messages), ...messages] });
  };
  const dispatch = (event: PlaygroundEvent): void => {
    const previous = machine.getState();
    const next = reduceQuestionPlayground(previous, event);
    if (next === previous) return;
    machine.setState(next, true);
    if (event.type === 'reset' || event.type === 'preset') {
      waiting?.reject(new Error('Sandbox reset'));
      waiting = undefined;
      appendQuestion('Help me plan the next step.', true);
    } else if (event.type === 'fail') {
      waiting?.reject(new Error('Simulated delivery failure'));
      waiting = undefined;
    } else if (event.type === 'resolve') {
      const id = `sandbox-${previous.generation}`;
      const question = store.getState().pendingQuestions[id];
      const output =
        next.phase === 'answered'
          ? formatAskUserAnswers(
              redactMcpAnswersForDisplay(question.questions, next.answers),
            )
          : 'Question dismissed. We can come back to this later.';
      updateTab({
        messages: [
          ...tab.messages,
          {
            id: `${id}-result`,
            role: 'assistant',
            timestamp: previous.generation * 1000 + 2,
            blocks: [
              {
                type: 'tool_result',
                toolName: 'mcp__canopy__AskUserQuestion',
                toolUseId: id,
                output,
                isError: false,
              },
              {
                type: 'text',
                text:
                  next.phase === 'answered'
                    ? 'Thanks, I have what I need to continue.'
                    : output,
              },
            ],
          },
        ],
      });
      store.setState({ pendingQuestions: {} });
      waiting?.resolve();
      waiting = undefined;
    }
  };
  const request = (id: string, event: PlaygroundEvent): Promise<void> => {
    if (
      waiting ||
      !store.getState().pendingQuestions[id] ||
      !['pending', 'error'].includes(machine.getState().phase)
    )
      return Promise.reject(new Error('Question unavailable'));
    dispatch(event);
    return new Promise<void>((resolve, reject) => {
      waiting = { resolve, reject };
    });
  };
  store.setState({
    selectedWorktree: null,
    worktreeChats: {},
    pendingQuestions: {},
    tabDrafts: {},
    composerTextPresent: {},
    pendingEditorSelections: {},
    answerMcpQuestionAndWait: (id, answers) =>
      request(id, { type: 'submit', answers }),
    dismissMcpQuestionAndWait: (id) => request(id, { type: 'dismiss' }),
    getTabDraft: (id) => store.getState().tabDrafts[id],
    saveTabDraft: (id, content) =>
      store.setState((s) => ({ tabDrafts: { ...s.tabDrafts, [id]: content } })),
    scheduleTabDraftWrite: () => {},
    clearTabDraft: (id) =>
      store.setState((s) => {
        const tabDrafts = { ...s.tabDrafts };
        delete tabDrafts[id];
        return { tabDrafts };
      }),
    setComposerTextPresent: (id, present) =>
      store.setState((s) => ({
        composerTextPresent: { ...s.composerTextPresent, [id]: present },
      })),
    loadTurnFeedback: async () => {},
    verifyStreamingTabs: async () => {},
    setThinkingLevel: (thinkingLevel) => {
      updateTab({ thinkingLevel });
      return Promise.resolve();
    },
    setModel: (model) => updateTab({ model }),
    setModelAndWait: (model) => {
      updateTab({ model });
      return Promise.resolve(true);
    },
    setTabApprovalMode: (_target, approvalMode) => {
      updateTab({ approvalMode });
      return Promise.resolve();
    },
    toggleFastMode: () =>
      updateTab({
        modelConfig: {
          ...tab.modelConfig,
          fastMode: !tab.modelConfig?.fastMode,
        },
      }),
    setPluginSelections: (pluginSelections) => {
      updateTab({ pluginSelections });
      return pluginSelections;
    },
    togglePlanMode: () => updateTab({ planMode: !tab.planMode }),
  });
  appendQuestion('Help me plan the next step.');
  return {
    store,
    machine,
    dispatch,
    getTab: (): ChatTab => store.getState().worktreeChats[KEY].tabs[0],
    sendMessage: async (text: string): Promise<void> => {
      if (waiting || machine.getState().phase === 'disconnected')
        throw new Error(
          'Resolve the pending request or reconnect before sending.',
        );
      // Close an unanswered tool before starting the next local turn.
      if (Object.keys(store.getState().pendingQuestions).length) {
        await Promise.resolve();
        const pending = store
          .getState()
          .dismissMcpQuestionAndWait(
            `sandbox-${machine.getState().generation}`,
          );
        dispatch({ type: 'resolve' });
        await pending;
      }
      machine.setState(
        reduceQuestionPlayground(machine.getState(), { type: 'reset' }),
        true,
      );
      appendQuestion(text);
    },
    setTurnRunning: (running: boolean): void =>
      updateTab({ status: running ? 'streaming' : 'idle' }),
    dispose: (): void => {
      waiting?.reject(new Error('Sandbox closed'));
      waiting = undefined;
    },
  };
}
