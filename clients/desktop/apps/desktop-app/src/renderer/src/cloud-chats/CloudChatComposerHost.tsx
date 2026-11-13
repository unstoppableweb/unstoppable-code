import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useStore } from 'zustand';
import {
  createCloudChatCatalog,
  type CloudChatCatalog,
  type CloudChatThreadTarget,
} from '@canopy/app-state/core-cowork';
import {
  CloudChatComposer,
  type ChatComposerHostControls,
  type CloudComposerAttachment,
} from '@canopy/ui-app/chat-panel';
import {
  CLOUD_ATTACHMENT_MAX_BYTES,
  isCloudAttachmentMediaType,
  portalAttachmentMediaTypeForFilename,
} from '@canopy/protocol/cloud-attachments';
import type { PortalChatTabPluginSelections } from '@canopy/protocol/portal';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { brandText } from '@/lib/brand';
import { createRelayCoreCoworkInvoker } from './relay-invoker';

interface HostAttachment extends CloudComposerAttachment {
  /** Kept to retry: the file the user picked or dropped, never a path. */
  readonly file: File;
}

function devLog(message: string): void {
  if (process.env.NODE_ENV === 'production') return;
  // eslint-disable-next-line no-console
  console.info(message);
}

/** The chat's catalog over the web-core relay, or null without the relay. */
export function useCloudChatCatalog(
  target: CloudChatThreadTarget,
): CloudChatCatalog | null {
  const { workspaceId, worktreeId, chatId } = target;
  return useMemo(() => {
    if (typeof window === 'undefined' || !window.canopyCore) return null;
    return createCloudChatCatalog(
      createRelayCoreCoworkInvoker(window.canopyCore),
      { workspaceId, worktreeId, chatId },
      { logDev: devLog },
    );
  }, [workspaceId, worktreeId, chatId]);
}

/**
 * The desktop host of the shared cloud chat composer (CAN-5972): the chat's
 * catalog over the web-core relay, and uploads through main, which holds the
 * session. The renderer only reads the bytes of files the user chose.
 */
export function CloudChatComposerHost({
  controls,
  target,
  catalog,
}: {
  controls: ChatComposerHostControls;
  target: CloudChatThreadTarget;
  catalog: CloudChatCatalog;
}): JSX.Element {
  const [attachments, setAttachments] = useState<readonly HostAttachment[]>([]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void catalog.refresh().catch((error: unknown) => {
      reportClientAppError(error);
    });
  }, [catalog]);
  const state = useStore(catalog.store);

  const patch = useCallback(
    (localId: string, next: Partial<HostAttachment>): void => {
      if (!mounted.current) return;
      setAttachments((current) =>
        current.map((attachment) =>
          attachment.localId === localId
            ? { ...attachment, ...next }
            : attachment,
        ),
      );
    },
    [],
  );

  const upload = useCallback(
    async (localId: string, file: File): Promise<void> => {
      // Refused before the bytes are read or copied over IPC; main checks again.
      if (file.size > CLOUD_ATTACHMENT_MAX_BYTES) {
        patch(localId, { state: 'failed', attachment: undefined });
        return;
      }
      patch(localId, { state: 'uploading', attachment: undefined });
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await window.api.cloudChats.uploadAttachment(
          {
            key: target.key,
            workspaceId: target.workspaceId,
            worktreeId: target.worktreeId,
          },
          {
            name: file.name,
            mimeType: isCloudAttachmentMediaType(file.type)
              ? file.type
              : portalAttachmentMediaTypeForFilename(file.name),
            bytes,
          },
        );
        patch(
          localId,
          result.ok
            ? { state: 'ready', attachment: result.attachment }
            : { state: 'failed' },
        );
      } catch (error) {
        reportClientAppError(error);
        patch(localId, { state: 'failed' });
      }
    },
    [patch, target.key, target.workspaceId, target.worktreeId],
  );

  const onAddFiles = useCallback(
    (files: readonly File[]): void => {
      const added = files.map(
        (file): HostAttachment => ({
          localId: globalThis.crypto.randomUUID(),
          name: file.name,
          state: 'uploading',
          file,
        }),
      );
      setAttachments((current) => [...current, ...added]);
      for (const attachment of added)
        void upload(attachment.localId, attachment.file);
    },
    [upload],
  );

  const onRetryAttachment = useCallback(
    (localId: string): void => {
      const attachment = attachments.find((each) => each.localId === localId);
      if (attachment !== undefined) void upload(localId, attachment.file);
    },
    [attachments, upload],
  );

  const onRemoveAttachment = useCallback((localId: string): void => {
    setAttachments((current) =>
      current.filter((attachment) => attachment.localId !== localId),
    );
  }, []);

  const onChangeSelections = useCallback(
    (next: PortalChatTabPluginSelections): Promise<void> =>
      catalog.setSelections(next).catch((error: unknown) => {
        reportClientAppError(error);
      }),
    [catalog],
  );

  const onSelectModel = useCallback(
    (modelId: string): Promise<void> =>
      catalog.setModel(modelId).catch((error: unknown) => {
        reportClientAppError(error);
      }),
    [catalog],
  );

  return (
    <CloudChatComposer
      key={target.key}
      draftKey={target.key}
      controls={controls}
      modelCatalog={state.models}
      currentModel={state.currentModel}
      onSelectModel={onSelectModel}
      pluginCatalog={state.plugins}
      selections={state.selections}
      onChangeSelections={onChangeSelections}
      {...(state.selectionConflict
        ? {
            selectionNotice:
              'This chat’s capabilities changed elsewhere. Review them and try again.',
          }
        : {})}
      attachments={attachments}
      onAddFiles={onAddFiles}
      onRemoveAttachment={onRemoveAttachment}
      onRetryAttachment={onRetryAttachment}
      brandDisplayName={brandText.appName}
    />
  );
}
