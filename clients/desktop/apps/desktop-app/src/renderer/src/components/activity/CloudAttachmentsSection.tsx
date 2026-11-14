/**
 * A cloud chat's attachments in the activity rail (CAN-6175 R8d), through the
 * same shared section body as a local chat's. The rows are the selected tab's
 * chat's attachments, listed by the web core; add uploads through main as the
 * composer does (R6), save goes through main to a path the user picks,
 * delete goes to the web core, and mention attaches the file to the next
 * message. Nothing reads or writes this computer's attachment folder.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type JSX,
} from 'react';
import {
  AttachmentsSectionBody,
  attachmentsSectionTestIds,
  type AttachmentListLoad,
  type AttachmentListRow,
  type AttachmentsSource,
} from '@canopy/ui-app/attachments';
import { HeaderActionButton } from '@canopy/ui-shared/components';
import { AttachmentIcon as CentralAttachmentIcon } from '@canopy/ui-shared/icons/AppIcons';
import { FileTypeIcon } from '@canopy/ui-shared/icons';
import {
  PanelSection,
  type CollapsedIconColor,
  useActivitySectionChrome,
} from '@/components/shared/panel-section';
import {
  cloudChatAttachmentList,
  deleteCloudChatAttachment,
  ensureCloudChatAttachments,
  refreshCloudChatAttachments,
  subscribeCloudChatAttachmentLists,
  type CloudChatAttachmentList,
} from '@/cloud-chats/cloud-chat-attachment-list';
import {
  cloudAttachmentMediaType,
  cloudAttachmentPath,
  cloudAttachmentRefusal,
} from '@/cloud-chats/cloud-chat-attachments';
import { CLOUD_UPLOAD_FAILURE } from '@/lib/chatAttachments';
import { webCoreLocalId } from '@/lib/chat-authority';
import { useChatStore } from '@/stores/chatStore';
import {
  uploadWebCoreChatAttachment,
  webCoreChatId,
} from '@/stores/chat/web-core';
import { bareScope, qualifiedId } from '@/stores/chat/web-core/translate';
import { useCloudChatDeleted } from '@/stores/chat/web-core/task-deletions';
import type { ActivitySectionRenderProps } from './activity-sections';
import { PlusIcon } from './workspace-items-shared';

const TEST_IDS = attachmentsSectionTestIds('cloud-attachments', {
  root: 'cloud-attachments',
});

/** Uploads one file to a cloud chat as the composer does, or throws why not. */
async function uploadToChat(
  file: File,
  target: { projectId: string; worktreeId: string; chatId: string },
): Promise<void> {
  const mediaType = cloudAttachmentMediaType(file);
  const refusal = cloudAttachmentRefusal(file);
  if (refusal !== null || mediaType === null)
    throw new Error(refusal ?? 'Attachment type is not supported');
  const result = await uploadWebCoreChatAttachment(target, {
    name: file.name,
    mediaType,
    bytes: new Uint8Array(await file.arrayBuffer()),
  });
  if (!result.ok)
    throw new Error(
      result.message ??
        CLOUD_UPLOAD_FAILURE[result.reason] ??
        CLOUD_UPLOAD_FAILURE.rejected,
    );
}

/** The selected tab of a cloud scope, by its store and web core ids. */
function useSelectedCloudChat(
  projectId: string,
  worktreeId: string,
): { readonly storeChatId: string; readonly chatId: string } | null {
  // Both ids in one selector: a new tab's web core id resolves after its
  // store id appears, and the store changes when it does.
  const activeTabId = useChatStore(
    (state) => state.worktreeChats[`${projectId}/${worktreeId}`]?.activeTabId,
  );
  // A chat deleted on another device, or its whole task, has no attachments
  // to read, add or delete on the web core (CAN-6614).
  const deleted = useCloudChatDeleted(projectId, worktreeId, activeTabId);
  const ids = useChatStore((state) => {
    if (deleted || webCoreLocalId(worktreeId) === null) return undefined;
    const storeChatId =
      state.worktreeChats[`${projectId}/${worktreeId}`]?.activeTabId;
    if (storeChatId === undefined) return undefined;
    const chatId = webCoreChatId(storeChatId);
    return chatId === null ? undefined : `${storeChatId}\u0000${chatId}`;
  });
  return useMemo(() => {
    if (ids === undefined) return null;
    const at = ids.indexOf('\u0000');
    return { storeChatId: ids.slice(0, at), chatId: ids.slice(at + 1) };
  }, [ids]);
}

function useCloudAttachmentList(
  chatId: string | undefined,
): CloudChatAttachmentList | undefined {
  return useSyncExternalStore(
    subscribeCloudChatAttachmentLists,
    () => (chatId === undefined ? undefined : cloudChatAttachmentList(chatId)),
    () => undefined,
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCloudAttachmentsHeaderChrome({
  projectId,
  worktreeId,
}: ActivitySectionRenderProps): {
  hasContent: boolean;
  subtitle: string | undefined;
  collapsedIconColor: CollapsedIconColor;
} {
  const selected = useSelectedCloudChat(projectId, worktreeId);
  const list = useCloudAttachmentList(selected?.chatId);
  // The header counts the chat's attachments with the card collapsed, so
  // it reads them itself the first time; the body rereads on open.
  useEffect(() => {
    if (selected !== null)
      ensureCloudChatAttachments(window.canopyCore, selected.chatId);
  }, [selected]);
  const count = list?.kind === 'ready' ? list.rows.length : 0;
  return {
    // The rail draws an empty section as a lone action card and a full one
    // as a panel, remounting the body between them. The body owns the upload
    // queue, so a chat's section stays a panel, empty or not: the first
    // upload to land would otherwise drop the files queued behind it.
    hasContent: selected !== null,
    subtitle: count > 0 ? `${count} file${count !== 1 ? 's' : ''}` : undefined,
    collapsedIconColor: count > 0 ? 'amber' : 'muted',
  };
}

export function CloudAttachmentsSection(
  props: ActivitySectionRenderProps,
): JSX.Element {
  const { projectId, worktreeId } = props;
  const frameless = useActivitySectionChrome() === 'frameless';
  const selected = useSelectedCloudChat(projectId, worktreeId);
  const list = useCloudAttachmentList(selected?.chatId);
  const headerChrome = useCloudAttachmentsHeaderChrome(props);
  const addTriggerRef = useRef<(() => void) | null>(null);
  // Opening the card rereads the list, unless the header's first read is
  // still on its way.
  useEffect(() => {
    if (selected === null) return;
    if (cloudChatAttachmentList(selected.chatId)?.kind === 'loading') return;
    void refreshCloudChatAttachments(window.canopyCore, selected.chatId);
  }, [selected]);

  const source = useMemo((): AttachmentsSource => {
    const load: AttachmentListLoad =
      selected === null || list === undefined || list.kind === 'loading'
        ? { kind: 'loading' }
        : list.kind === 'error'
          ? {
              kind: 'error',
              retry: () =>
                void refreshCloudChatAttachments(
                  window.canopyCore,
                  selected.chatId,
                ),
            }
          : {
              kind: 'ready',
              rows: list.rows.map(
                (row): AttachmentListRow => ({
                  id: row.attachmentId,
                  domId: row.attachmentId,
                  filename: row.filename,
                  sizeBytes: row.sizeBytes,
                  mediaType: row.mediaType,
                }),
              ),
            };
    if (selected === null) return { scopeKey: undefined, load };
    const { storeChatId, chatId } = selected;
    const target = {
      key: qualifiedId(chatId),
      ...bareScope({ projectId, worktreeId }),
    };
    return {
      scopeKey: chatId,
      load,
      showSize: true,
      rowIcon: (row) => (
        <FileTypeIcon filename={row.filename} size="sm" className="shrink-0" />
      ),
      add: {
        kind: 'upload',
        upload: (file: File): Promise<void> =>
          uploadToChat(file, { projectId, worktreeId, chatId: storeChatId }),
        failureMessage: (error: unknown): string =>
          error instanceof Error
            ? error.message
            : CLOUD_UPLOAD_FAILURE.rejected,
      },
      // Attaching it to the next message is how a cloud chat refers to a
      // file it already holds: the send carries its id (R6).
      mention: (row: AttachmentListRow): void => {
        useChatStore.getState().addPendingAttachments(
          [
            {
              filename: row.filename,
              absolutePath: cloudAttachmentPath(row.id, row.filename),
              ...(row.sizeBytes === undefined
                ? {}
                : { sizeBytes: row.sizeBytes }),
            },
          ],
          { projectId, worktreeId, chatId: storeChatId },
        );
      },
      download: async (row: AttachmentListRow): Promise<void> => {
        const result = await window.api.cloudChats.downloadFile(target, {
          kind: 'attachment',
          id: row.id,
          filename: row.filename,
        });
        // The body says the save failed; a cancelled dialog is no failure.
        if (!result.ok && result.reason !== 'canceled')
          throw new Error(`The attachment was not saved: ${result.reason}`);
      },
      remove: (row: AttachmentListRow): Promise<void> =>
        deleteCloudChatAttachment(window.canopyCore, chatId, row.id),
    };
  }, [list, projectId, selected, worktreeId]);

  return (
    <PanelSection
      icon={<CentralAttachmentIcon size="sm" />}
      title="Attachments"
      subtitle={headerChrome.subtitle}
      collapsedIconColor={headerChrome.collapsedIconColor}
      // Always the body, never the empty card's lone add button: switching
      // between the two remounts the body, which owns the upload queue and
      // its errors. An empty chat shows the body's own drop zone.
      hasExpandableContent
      headerAction={
        <HeaderActionButton
          iconOnly
          onClick={() => addTriggerRef.current?.()}
          aria-label="Add attachments"
          data-testid="cloud-attachments-add"
          disabled={selected === null}
        >
          <PlusIcon />
        </HeaderActionButton>
      }
      framelessBody="flex"
    >
      <AttachmentsSectionBody
        source={source}
        testIds={TEST_IDS}
        fill={frameless}
        addTriggerRef={addTriggerRef}
      />
    </PanelSection>
  );
}
