import {
  useEffect,
  useEffectEvent,
  useMemo,
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
import { useCanopyCloudAccountState } from '../hooks/useCanopyCloudAccountState';
import { CloudCopyConsentHost } from './CloudCopyConsentHost';
import {
  localPickerItem,
  localUploadRows,
  readLocalCatalog,
  selectionForCloudEntry,
  type LocalCatalog,
} from './cloud-picker-local-items';
import type { CloudCapabilityUploadRow } from '@canopy/app-state/core-cowork';
import type { PortalPluginsLocalItemsSeam } from '@canopy/ui-app';

type AddedSelection = Awaited<ReturnType<PortalPluginsLocalItemsSeam['onAdd']>>;

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
  // This computer's skills and plugins the cloud account lacks (CAN-6176):
  // offered under the table, each added only through the consent dialog.
  const accountId = useCanopyCloudAccountState().account?.account?.id ?? null;
  const [local, setLocal] = useState<LocalCatalog | null>(null);
  const [consent, setConsent] = useState<{
    readonly row: CloudCapabilityUploadRow;
    readonly resolve: (added: AddedSelection) => void;
  } | null>(null);
  // Read once the picker opens, and again after a copy is added.
  const [localReads, setLocalReads] = useState(0);
  useEffect(() => {
    if (!read) return;
    let current = true;
    void readLocalCatalog().then(
      (next): void => {
        if (current) setLocal(next);
      },
      (error: unknown): void => {
        reportClientAppError(error);
      },
    );
    return (): void => {
      current = false;
    };
  }, [read, localReads]);
  const harness = state.models.find(
    (model) => model.id === state.currentModel,
  )?.harness;
  const rows = useMemo(
    () =>
      local === null ? [] : localUploadRows(local, state.entries, harness),
    [local, state.entries, harness],
  );
  const localItems: PortalPluginsLocalItemsSeam | undefined =
    accountId === null || rows.length === 0
      ? undefined
      : {
          items: rows.map(localPickerItem),
          onAdd: (key) =>
            new Promise<AddedSelection>((resolve) => {
              const row = rows.find((item) => item.localEntry.entryId === key);
              if (row === undefined) {
                resolve(null);
                return;
              }
              setConsent({ row, resolve });
            }),
        };
  // A failed read closes the picker: it never offers a draft without the
  // chat's saved selection.
  useEffect(() => {
    if (state.status === 'error') onClose();
  }, [onClose, state.status]);
  // The picker takes its draft from the selection when it opens, so it opens
  // only once this open has read the chat's saved selection; Save then keeps it.
  return (
    <>
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
        {...(localItems === undefined ? {} : { localItems })}
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
      {consent !== null && accountId !== null && (
        <CloudCopyConsentHost
          row={consent.row}
          accountId={accountId}
          onDone={(cloudEntryId): void => {
            const { resolve } = consent;
            setConsent(null);
            // The cloud copy is selected once the catalog lists it.
            void catalog
              .refresh()
              .then(() => {
                setLocalReads((count) => count + 1);
                resolve(
                  selectionForCloudEntry(
                    catalog.store.getState().entries,
                    cloudEntryId,
                  ),
                );
              })
              .catch((error: unknown): void => {
                reportClientAppError(error);
                resolve(null);
              });
          }}
          onCancel={(): void => {
            consent.resolve(null);
            setConsent(null);
          }}
        />
      )}
    </>
  );
}
