// Eye button rendered next to the fork action on a worktree chat's active turn
// (the active turn timer and the Claude terminal floating bar). Unlike
// {@link WatcherManagementButton} — which lists watchers whose *destination* is
// this chat and hides when empty — this button is always shown for an active
// turn and reflects watchers whose *target* is this chat (i.e. what is watching
// it). Clicking opens the app-level modal hosted by {@link WatcherModalHost};
// the modal (not this button) owns the open lifetime and the firing hold, so it
// stays open even after the turn ends and this button unmounts.

import { useEffect, useMemo, type JSX } from 'react';
import {
  Button,
  CLEAN_ICON_BUTTON_VARIANT,
  Tooltip,
} from '@canopy/ui-shared/components';
import { WatcherEyeIcon } from '@canopy/ui-shared/icons';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useWatcherModalStore } from '@/stores/watcherModalStore';

export interface ChatWatcherButtonProps {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

export function ChatWatcherButton({
  projectId,
  worktreeId,
  chatId,
}: ChatWatcherButtonProps): JSX.Element {
  const allWatchers = useAppAdvisorWatchersStore((s) => s.watchers);
  const openModal = useWatcherModalStore((s) => s.open);

  // Keep the watcher store hydrated/subscribed (safe to mount from multiple
  // consumers — each call mounts its own listener).
  useEffect(() => {
    const unsubscribe = useAppAdvisorWatchersStore.getState().subscribeBridge();
    void useAppAdvisorWatchersStore.getState().hydrate();
    return unsubscribe;
  }, []);

  const watchers = useMemo(
    () =>
      allWatchers.filter(
        (watcher) =>
          watcher.target.kind === 'worktree_chat' &&
          watcher.target.projectId === projectId &&
          watcher.target.worktreeId === worktreeId &&
          watcher.target.chatId === chatId &&
          (watcher.status === 'active' || watcher.status === 'delivery_failed'),
      ),
    [allWatchers, projectId, worktreeId, chatId],
  );

  const hasWatchers = watchers.length > 0;

  return (
    <Tooltip label="Watch this chat">
      {hasWatchers ? (
        <Button
          variant="ghost-accent"
          size="sm"
          onClick={(): void => openModal({ projectId, worktreeId, chatId })}
          aria-label="Watch this chat"
          data-testid={`chat-watcher-button-${chatId}`}
          data-attention=""
        >
          <WatcherEyeIcon size="sm" aria-hidden="true" />
          <span data-testid={`chat-watcher-button-${chatId}-count`}>
            {watchers.length}
          </span>
        </Button>
      ) : (
        <Button
          variant={CLEAN_ICON_BUTTON_VARIANT}
          size="sm"
          iconOnly
          onClick={(): void => openModal({ projectId, worktreeId, chatId })}
          aria-label="Watch this chat"
          data-testid={`chat-watcher-button-${chatId}`}
        >
          <WatcherEyeIcon size="sm" aria-hidden="true" />
        </Button>
      )}
    </Tooltip>
  );
}
