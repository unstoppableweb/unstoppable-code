import { useCallback, useMemo, type JSX } from 'react';
import {
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import type { PanelTabModel } from '@canopy/ui-shared/panels';
import {
  PanelFillChatTabGlyph,
  PanelTabBar,
} from '@canopy/ui-shared/components/panels';
import { CHAT_UNIT_LABEL } from '@canopy/protocol/ui-labels';
import { useChatStore, useWorktreeChatRenderState } from '@/stores/chatStore';
import { PIPELINE_EDITOR_CHAT_KEY } from './pipelineAssistantDraft';

const PIPELINE_EDITOR_SCOPE = {
  projectId: PIPELINE_EDITOR_PROJECT_ID,
  worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
} as const;

/** The strip's group id: one group, the assistant's own. */
const ASSISTANT_GROUP_ID = 'pipeline-assistant';

interface AssistantTab {
  readonly id: string;
  readonly title: string;
  readonly busy: boolean;
}

/**
 * The assistant's chat tabs in an open workflow's edit view (CAN-4319), drawn
 * as a worktree panel group's title row: the shared `fill` tab strip, each
 * tab with the chat icon (a spinner while it works), with `+` for a new chat. The edit
 * view's assistant card is laid out like a worktree panel card, so its tabs
 * read the same.
 */
export function PipelineAssistantTabStrip(): JSX.Element {
  const assistantTabs = useWorktreeChatRenderState(
    PIPELINE_EDITOR_CHAT_KEY,
    (chat): readonly AssistantTab[] =>
      (chat?.tabs ?? []).flatMap((tab) =>
        tab.kind === 'file'
          ? []
          : [
              {
                id: tab.id,
                title: tab.title,
                busy: tab.status === 'streaming',
              },
            ],
      ),
    (left, right) =>
      left.length === right.length &&
      left.every(
        (tab, index) =>
          tab.id === right[index]?.id &&
          tab.title === right[index]?.title &&
          tab.busy === right[index]?.busy,
      ),
  );
  const activeTabId = useWorktreeChatRenderState(
    PIPELINE_EDITOR_CHAT_KEY,
    (chat) => chat?.activeTabId ?? null,
  );
  const switchTab = useChatStore((state) => state.switchTab);
  const closeTab = useChatStore((state) => state.closeTab);
  const createTab = useChatStore((state) => state.createTab);

  const tabs = useMemo(
    (): readonly PanelTabModel[] =>
      assistantTabs.map((tab) => ({
        panelId: tab.id,
        kind: 'chat',
        title: tab.title,
      })),
    [assistantTabs],
  );
  const busyIds = useMemo(
    () => new Set(assistantTabs.filter((tab) => tab.busy).map((tab) => tab.id)),
    [assistantTabs],
  );
  const handleSelectTab = useCallback(
    (_groupId: string, tabId: string): void => {
      switchTab(tabId, PIPELINE_EDITOR_SCOPE);
    },
    [switchTab],
  );
  const handleCloseTab = useCallback(
    (_groupId: string, tabId: string): void => {
      closeTab(tabId, { ...PIPELINE_EDITOR_SCOPE });
    },
    [closeTab],
  );
  const addTab = useMemo(
    () => ({
      label: `New ${CHAT_UNIT_LABEL}`,
      onAddTab: (): void => createTab(PIPELINE_EDITOR_SCOPE),
    }),
    [createTab],
  );

  return (
    <div
      className="canopy-panel-group-title"
      data-testid="pipeline-chat-tabs"
      data-fill-tabs=""
    >
      <PanelTabBar
        groupId={ASSISTANT_GROUP_ID}
        tabs={tabs}
        activePanelId={activeTabId}
        draggable={false}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        renderTabIcon={(tab): JSX.Element | null => (
          <PanelFillChatTabGlyph busy={busyIds.has(tab.panelId)} />
        )}
        addTab={addTab}
        tabStyle="fill"
      />
    </div>
  );
}
