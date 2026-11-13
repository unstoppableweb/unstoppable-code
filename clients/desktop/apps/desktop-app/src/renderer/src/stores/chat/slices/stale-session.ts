import { getActiveStaleSessionContext } from '../context';
import { type ChatTab } from '../types';
import {
  createEmptyTab,
  inheritedPluginDefaultsCarry,
  isTabAiCreditsRouted,
} from '../tab-utils';
import { createSeededTabUsage } from '@/lib/chatUsageNormalization';
import { retainedCodexSpeedFields } from '../codex-speed';
import { applyStaleSessionTabReplacement } from '../session-restore';
import {
  requestTabDiscovery,
  resolveDiscoveryProviderType,
} from '../discovery';
import { buildHandoffConversationText } from '../messages';
import { worktreeKey } from '../utils';
import type { StateCreator } from 'zustand';
import type { ChatState, ChatStaleSessionSlice } from '../state';
import { chatBackendFor } from '../backend';

/**
 * The replacement tab runs a NEW provider session, so the source chat's
 * running usage total does not carry. The meter must, though: `createEmptyTab`
 * leaves `usage` undefined, which renders a dead 0% ring whose popover never
 * opens until the first turn lands (CAN-2799). Seed zeroed counters sized to
 * the model the replacement keeps, resolved against the REPLACEMENT's own
 * billing state: it does not inherit the source's routing, so the source's
 * route could name a window the replacement session never executes under.
 */
function seededReplacementUsage(
  replacement: ChatTab,
): Pick<ChatTab, 'usage'> | Record<string, never> {
  const usage = createSeededTabUsage(
    replacement.model,
    isTabAiCreditsRouted(replacement),
  );
  return usage ? { usage } : {};
}

export const createStaleSessionSlice: StateCreator<
  ChatState,
  [],
  [],
  ChatStaleSessionSlice
> = (set, get) => ({
  handleStaleSessionStartNew: async (): Promise<void> => {
    const context = getActiveStaleSessionContext(get());
    if (!context) return;

    const { sel, key, sourceTab, staleSession } = context;

    const movedQueuedMessages = [...sourceTab.queuedMessages];
    const replacementBase: ChatTab = {
      ...createEmptyTab({
        pluginSelections: sourceTab.pluginSelections,
        model: sourceTab.model,
        thinkingLevel: sourceTab.thinkingLevel,
        modelConfig: sourceTab.modelConfig,
        fastModeExplicit: sourceTab.fastModeExplicit,
        deferredToolsAllowed: sourceTab.deferredToolsAllowed !== false,
        modelExplicitlyChosen: sourceTab.modelExplicitlyChosen,
        defaultStampModel: sourceTab.defaultStampModel,
      }),
      ...inheritedPluginDefaultsCarry(sourceTab),
      ...retainedCodexSpeedFields(sourceTab.retainedCodexSpeed),
      queuedMessages: movedQueuedMessages,
      planMode: sourceTab.planMode,
      ...(sourceTab.providerType
        ? { providerType: sourceTab.providerType }
        : {}),
    };
    const replacementTab: ChatTab = {
      ...replacementBase,
      ...seededReplacementUsage(replacementBase),
    };

    set((state) =>
      applyStaleSessionTabReplacement(state, {
        key,
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        sourceTabId: sourceTab.id,
        replacementTab,
      }),
    );

    requestTabDiscovery({
      projectId: sel.projectId,
      worktreeId: sel.worktreeId,
      chatId: replacementTab.id,
      pluginSelections: replacementTab.pluginSelections,
      providerType: resolveDiscoveryProviderType(replacementTab),
    });

    // Tolerate absent stale-session data (read-only restored archives) and
    // already-cleared dropped-message fields: with nothing dropped there is
    // nothing to re-send — never auto-send on behalf of a read-only tab.
    if (staleSession === null || staleSession.droppedMessageText.length === 0) {
      return;
    }

    await get().sendMessage(
      staleSession.droppedMessageText,
      staleSession.droppedFileReferences,
      {
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId: replacementTab.id,
      },
      staleSession.droppedInputMode,
    );
  },

  handleStaleSessionHandOff: async (): Promise<void> => {
    const context = getActiveStaleSessionContext(get());
    if (!context) return;

    const { sel, key, sourceTab, staleSession } = context;

    // Exclude the undelivered user turn — it's sent explicitly below, not
    // prior context. Without stale-session data (read-only restored archive)
    // no turn was dropped, so the full transcript is the context.
    const historyMessages =
      staleSession !== null
        ? sourceTab.messages.slice(0, -1)
        : sourceTab.messages;
    const conversationText = buildHandoffConversationText(historyMessages);
    const response = await chatBackendFor(sel).chat.generateHandoffSummary({
      projectId: sel.projectId,
      worktreeId: sel.worktreeId,
      conversationText,
      kind: 'stale-session',
      chatId: sourceTab.id,
    });
    const summary = response.summary.trim();
    if (!summary) {
      throw new Error('Summary generation returned no content.');
    }

    const currentWc = get().worktreeChats[key];
    const currentSourceTab = currentWc?.tabs.find(
      (tab) => tab.id === sourceTab.id,
    );
    // Tolerate a stale-session record cleared while the summary generated
    // (or absent entirely for read-only restored archives) — the dropped
    // message is simply empty in that case.
    const currentStaleSession = currentSourceTab?.staleSessionDetected ?? null;
    if (
      !currentSourceTab ||
      (currentStaleSession === null && currentSourceTab.readOnly !== true)
    ) {
      return;
    }

    const movedQueuedMessages = [...currentSourceTab.queuedMessages];
    const replacementBase: ChatTab = {
      ...createEmptyTab({
        pluginSelections: currentSourceTab.pluginSelections,
        model: currentSourceTab.model,
        thinkingLevel: currentSourceTab.thinkingLevel,
        modelConfig: currentSourceTab.modelConfig,
        fastModeExplicit: currentSourceTab.fastModeExplicit,
        deferredToolsAllowed: currentSourceTab.deferredToolsAllowed !== false,
        modelExplicitlyChosen: currentSourceTab.modelExplicitlyChosen,
        defaultStampModel: currentSourceTab.defaultStampModel,
      }),
      ...inheritedPluginDefaultsCarry(currentSourceTab),
      ...retainedCodexSpeedFields(currentSourceTab.retainedCodexSpeed),
      queuedMessages: movedQueuedMessages,
      planMode: currentSourceTab.planMode,
      ...(currentSourceTab.providerType
        ? { providerType: currentSourceTab.providerType }
        : {}),
    };
    const replacementTab: ChatTab = {
      ...replacementBase,
      ...seededReplacementUsage(replacementBase),
    };

    set((state) =>
      applyStaleSessionTabReplacement(state, {
        key,
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        sourceTabId: currentSourceTab.id,
        replacementTab,
      }),
    );

    requestTabDiscovery({
      projectId: sel.projectId,
      worktreeId: sel.worktreeId,
      chatId: replacementTab.id,
      pluginSelections: replacementTab.pluginSelections,
      providerType: resolveDiscoveryProviderType(replacementTab),
    });

    const droppedMessageText = currentStaleSession?.droppedMessageText ?? '';
    const handoffMessage = `[SESSION HANDOFF]

This is a continuation of a previous chat session. Below is a summary of what was discussed. Use this context to continue seamlessly.

---
${summary}
---${droppedMessageText.length > 0 ? `\n\n${droppedMessageText}` : ''}`;

    await get().sendMessage(
      handoffMessage,
      currentStaleSession?.droppedFileReferences,
      {
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId: replacementTab.id,
      },
      currentStaleSession?.droppedInputMode,
    );
  },

  dismissStaleSession: (): void => {
    const sel = get().selectedWorktree;
    if (!sel) {
      return;
    }

    const key = worktreeKey(sel);
    const wc = get().worktreeChats[key];
    if (!wc) {
      return;
    }

    const chatId = wc.activeTabId;
    set((state) => {
      const currentWc = state.worktreeChats[key];
      if (!currentWc) {
        return state;
      }

      const tabs = currentWc.tabs.map((tab) =>
        tab.id === chatId
          ? {
              ...tab,
              readOnly: undefined,
              staleSessionDetected: undefined,
              staleSessionResumeId: undefined,
              sdkSessionId: undefined,
              claudeForkSessionOnNextSend: undefined,
              lastTurnWasResumeAttempt: undefined,
            }
          : tab,
      );
      const updated = { ...currentWc, tabs };
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [key]: updated,
        },
      };
    });
  },
});
