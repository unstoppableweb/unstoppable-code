import { isAgentModel } from '@canopy/desktop-shared/types';
import type { ChatState } from '@/stores/chat/state';
import type { ChatTab } from '@/stores/chat/types';
import type { HomeComposerState } from '@/stores/homeComposerStore';
import type { ModelRecoveryTarget } from './modelRecoveryLease';

type ChatTarget = { projectId: string; worktreeId: string; chatId: string };

// A request can also change billing/harness or pin an inherited Agent. Record
// its actual transition, not any unrelated edits present when it settles.
const requestSettlements = new WeakMap<
  object,
  { before: string; after: string }
>();

/** Record only the selection transition owned by an accepted model request. */
export function recordChatModelRecoverySettlement(
  request: object,
  before: ChatTab,
  after: ChatTab,
): void {
  requestSettlements.set(request, {
    before: chatSelection(before),
    after: chatSelection(after),
  });
}

function chatSelection(tab: ChatTab): string {
  // Only the default resolver's plain-model stamp is implicit. Agent routes
  // still mean explicit overrides, even when they equal an Agent's default.
  const resolverOwned =
    !isAgentModel(tab.model ?? '') &&
    tab.modelExplicitlyChosen !== true &&
    tab.billingExplicitlyChosen !== true &&
    tab.interfaceMode !== 'claude-code' &&
    (tab.model === undefined || tab.model === tab.defaultStampModel);
  return JSON.stringify([
    resolverOwned ? undefined : tab.model,
    tab.modelExplicitlyChosen === true,
    tab.modelSelectionMode ?? 'manual',
    tab.executionHarnessExplicitlyChosen ? tab.executionHarness : undefined,
    tab.billingExplicitlyChosen === true,
    tab.billingExplicitlyChosen ? tab.aiCreditsRouting : undefined,
    tab.billingExplicitlyChosen ? tab.subscriptionBillingOverride : undefined,
  ]);
}

export function chatModelRecoveryTarget(
  target: ChatTarget | undefined,
  readState: () => Pick<ChatState, 'worktreeChats' | 'pendingModelChanges'>,
): ModelRecoveryTarget {
  return {
    key: JSON.stringify(['chat', target]),
    capture: () => {
      if (!target) return undefined;
      const key = `${target.projectId}/${target.worktreeId}`;
      const requestKey = `${key}/${target.chatId}`;
      const readTab = (): ChatTab | undefined =>
        readState().worktreeChats[key]?.tabs.find(
          (tab) => tab.id === target.chatId,
        );
      const tab = readTab();
      if (!tab || tab.kind === 'file') return undefined;
      const selection = chatSelection(tab);
      const previousRequest = readState().pendingModelChanges[requestKey];
      // Settling an older selection is not a new command. It can leave the
      // selection unchanged (failure) or land its already-requested model.
      const settledSelection = previousRequest
        ? chatSelection({
            ...tab,
            model: previousRequest.model,
            modelExplicitlyChosen: true,
          })
        : selection;
      return (ownRequestId): boolean => {
        const current = readTab();
        const pending = readState().pendingModelChanges[requestKey]?.requestId;
        const settlement = previousRequest
          ? requestSettlements.get(previousRequest)
          : undefined;
        const currentSelection = current && chatSelection(current);
        return (
          current !== undefined &&
          current.kind !== 'file' &&
          (currentSelection === selection ||
            currentSelection === settledSelection ||
            (settlement !== undefined &&
              (settlement.before === selection ||
                settlement.before === settledSelection) &&
              currentSelection === settlement.after)) &&
          (pending === undefined ||
            pending === previousRequest?.requestId ||
            (ownRequestId !== undefined && pending === ownRequestId))
        );
      };
    },
  };
}

export function homeModelRecoveryTarget(
  readState: () => Pick<
    HomeComposerState,
    | 'workspaceId'
    | 'draftGeneration'
    | 'model'
    | 'modelSelectionMode'
    | 'executionHarness'
  >,
): ModelRecoveryTarget {
  const snapshot = (): string => {
    const state = readState();
    return JSON.stringify([
      state.workspaceId,
      state.draftGeneration,
      state.model,
      state.modelSelectionMode,
      state.executionHarness,
    ]);
  };
  const state = readState();
  return {
    key: JSON.stringify(['home', state.workspaceId, state.draftGeneration]),
    capture: () => {
      const selection = snapshot();
      return (): boolean => snapshot() === selection;
    },
  };
}
