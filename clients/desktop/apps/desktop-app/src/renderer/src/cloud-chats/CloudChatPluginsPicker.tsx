import {
  useEffect,
  useEffectEvent,
  useState,
  type JSX,
  type RefObject,
} from 'react';
import { useStore } from 'zustand';
import type { CloudChatCatalog } from '@canopy/app-state/core-cowork';
import { PortalPluginsPicker } from '@canopy/ui-app';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { brandText } from '@/lib/brand';
import type { CloudChatThreadTarget } from '@canopy/app-state/core-cowork';
import {
  selectionSaveSettled,
  trackSelectionSave,
} from '@/stores/chat/web-core/selection-saves';
import { taskCreationSettled } from '@/stores/chat/web-core/task-creations';
import { webCoreScopeId } from '@/lib/chat-authority';
import { useCloudChatCatalog } from './cloud-chat-catalog';

/**
 * A cloud chat's skills, plugins and MCP servers in the desktop composer
 * (CAN-6175 R5): the shared picker the web's cloud chats use, over the chat's
 * web core catalog. A change is the chat's selection on the web core.
 */
export function CloudChatPluginsPicker({
  target,
  onClose,
  returnFocusRef,
}: {
  target: CloudChatThreadTarget;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}): JSX.Element | null {
  const catalog = useCloudChatCatalog(target);
  if (catalog === null) return null;
  return (
    <CatalogPicker
      catalog={catalog}
      chatId={target.key}
      projectId={webCoreScopeId(target.workspaceId)}
      worktreeId={webCoreScopeId(target.worktreeId)}
      onClose={onClose}
      {...(returnFocusRef === undefined ? {} : { returnFocusRef })}
    />
  );
}

function CatalogPicker({
  catalog,
  chatId,
  projectId,
  worktreeId,
  onClose,
  returnFocusRef,
}: {
  catalog: CloudChatCatalog;
  /** The chat's store id, which its sends wait under. */
  chatId: string;
  /** The chat's task, as the store scopes it. */
  projectId: string;
  worktreeId: string;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}): JSX.Element {
  // A save still in flight from the last open is read first, so a reopened
  // picker's draft starts from what it wrote (CAN-6331).
  // A task still being created has no selection yet: the picker reads it
  // once the web core created the task, and closes if the create failed
  // (CAN-6098).
  const [read, setRead] = useState(false);
  const closeUncreated = useEffectEvent((): void => onClose());
  useEffect(() => {
    let current = true;
    void taskCreationSettled({ projectId, worktreeId }).then(
      () =>
        selectionSaveSettled(chatId)
          .then(() => catalog.refresh())
          .then((): void => {
            if (current) setRead(true);
          })
          .catch((error: unknown): void => {
            reportClientAppError(error);
          }),
      (): void => {
        if (current) closeUncreated();
      },
    );
    return (): void => {
      current = false;
    };
  }, [catalog, chatId, projectId, worktreeId]);
  const state = useStore(catalog.store);
  // A failed read closes the picker: it never offers a draft without the
  // chat's saved selection.
  useEffect(() => {
    if (state.status === 'error') onClose();
  }, [onClose, state.status]);
  // The picker takes its draft from the selection when it opens, so it opens
  // only once this open has read the chat's saved selection; Save then keeps it.
  return (
    <PortalPluginsPicker
      open={read && state.status === 'ready'}
      onOpenChange={(open): void => {
        if (!open) onClose();
      }}
      hideTrigger
      {...(returnFocusRef === undefined ? {} : { returnFocusRef })}
      catalog={state.plugins}
      selections={state.selections}
      brandDisplayName={brandText.appName}
      onChange={(next): Promise<void> => {
        // The picker closes before the save lands: a send meanwhile waits.
        const save = catalog.setSelections(next);
        trackSelectionSave(chatId, save);
        return save.catch((error: unknown) => {
          reportClientAppError(error);
          throw error;
        });
      }}
    />
  );
}
