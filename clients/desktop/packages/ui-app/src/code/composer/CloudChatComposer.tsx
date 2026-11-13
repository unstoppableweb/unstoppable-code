'use client';

import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type JSX,
} from 'react';
import {
  CLOUD_ATTACHMENT_MEDIA_TYPES,
  CLOUD_ATTACHMENTS_MAX_PER_MESSAGE,
} from '@canopy/protocol/cloud-attachments';
import type { ModelCatalog } from '@canopy/protocol/models';
import type {
  PortalChatCloudAttachmentRef,
  PortalChatTabPluginSelections,
  PortalPluginCatalog,
} from '@canopy/protocol/portal';
import {
  ChatComposerShell,
  ComposerPlusMenuPresentation,
  type ComposerActionRow,
} from '@canopy/ui-shared/components';
import { FileIcon, PluginsIcon } from '@canopy/ui-shared/icons';
import { ChatComposer } from '../ChatComposer';
import type { ChatComposerHostControls } from '../ChatPanel';
import {
  PendingAttachmentRow,
  type PendingAttachmentChip,
} from './pending-attachment-row';
import { PortalModelPicker } from './PortalModelPicker';
import {
  countPortalPluginSelections,
  PortalPluginsPicker,
} from './PortalPluginsPicker';

/** One file in the composer, as the host's upload reports it. */
export interface CloudComposerAttachment {
  readonly localId: string;
  readonly name: string;
  readonly state: 'uploading' | 'ready' | 'failed';
  /** Present once `ready`: the reference the send carries. */
  readonly attachment?: PortalChatCloudAttachmentRef;
}

export interface CloudChatComposerProps {
  /** From `ChatPanel`'s `renderComposer`. */
  readonly controls: ChatComposerHostControls;
  readonly modelCatalog: ModelCatalog;
  readonly currentModel?: string;
  readonly onSelectModel: (modelId: string) => void | Promise<void>;
  readonly pluginCatalog: PortalPluginCatalog | null;
  readonly selections: PortalChatTabPluginSelections;
  readonly onChangeSelections: (
    next: PortalChatTabPluginSelections,
  ) => void | Promise<void>;
  /** The catalog met a newer selection and re-read it. */
  readonly selectionNotice?: string;
  readonly attachments: readonly CloudComposerAttachment[];
  readonly onAddFiles: (files: readonly File[]) => void;
  readonly onRemoveAttachment: (localId: string) => void;
  readonly onRetryAttachment: (localId: string) => void;
  readonly brandDisplayName: string;
  readonly draftKey?: string;
}

const ACCEPT = CLOUD_ATTACHMENT_MEDIA_TYPES.join(',');

const chipState = (
  state: CloudComposerAttachment['state'],
): PendingAttachmentChip['state'] => (state === 'failed' ? 'error' : state);

/**
 * The cloud chat composer controls (CAN-5972): the shared editor in the
 * composer box, with the model picker, the skills, plugins and MCP picker,
 * and attachments. Every choice and upload goes through host callbacks, so
 * any host that can read a core catalog and upload a file can mount it.
 */
export function CloudChatComposer({
  controls,
  modelCatalog,
  currentModel,
  onSelectModel,
  pluginCatalog,
  selections,
  onChangeSelections,
  selectionNotice,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  onRetryAttachment,
  brandDisplayName,
  draftKey,
}: CloudChatComposerProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null);
  const plusTriggerRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [sending, setSending] = useState(false);
  // A send waits for a model or capability change to save, or the turn would
  // run with the old choice.
  const [settingSaves, setSettingSaves] = useState(0);
  const saveSetting = useCallback((save: void | Promise<void>): void => {
    setSettingSaves((count) => count + 1);
    void Promise.resolve(save)
      .catch(() => undefined)
      .finally(() => setSettingSaves((count) => count - 1));
  }, []);

  const room = CLOUD_ATTACHMENTS_MAX_PER_MESSAGE - attachments.length;
  const uploading = attachments.some(
    (attachment) => attachment.state === 'uploading',
  );
  const ready = attachments.filter(
    (
      attachment,
    ): attachment is CloudComposerAttachment & {
      attachment: PortalChatCloudAttachmentRef;
    } => attachment.state === 'ready' && attachment.attachment !== undefined,
  );

  const addFiles = useCallback(
    (files: readonly File[]): void => {
      const accepted = files.slice(0, Math.max(0, room));
      if (accepted.length > 0) onAddFiles(accepted);
    },
    [onAddFiles, room],
  );

  const { onSend } = controls;
  const send =
    onSend === undefined
      ? undefined
      : async (text: string): Promise<void> => {
          const sent = ready;
          // Attachments stay until the send is accepted; a rejection rethrows
          // so the editor restores the text beside them.
          setSending(true);
          try {
            await onSend(
              text,
              sent.length > 0
                ? {
                    cloudAttachments: sent.map(
                      (attachment) => attachment.attachment,
                    ),
                  }
                : undefined,
            );
          } finally {
            setSending(false);
          }
          for (const attachment of sent) onRemoveAttachment(attachment.localId);
        };

  const pluginCount = countPortalPluginSelections(selections);
  const plusRows: ComposerActionRow[] = [
    {
      id: 'attachment',
      label: 'Files',
      description: 'Add an attachment',
      icon: <FileIcon />,
      group: 'Add',
      popupRole: 'dialog',
      disabled: room <= 0,
      dataTestId: 'cloud-chat-plus-attachment',
      onSelect: (): void => {
        setPlusOpen(false);
        fileInputRef.current?.click();
      },
    },
    {
      id: 'plugins',
      label: 'Plugins',
      value: pluginCount > 0 ? String(pluginCount) : undefined,
      ariaChecked: pluginCount > 0,
      description: 'Choose capabilities for this chat',
      icon: <PluginsIcon size="sm" />,
      group: 'Add',
      popupRole: 'dialog',
      // Until the chat's selection loads, or while a change is saving, the
      // picker would start from a stale selection and could clear it.
      disabled: pluginCatalog === null || settingSaves > 0,
      dataTestId: 'cloud-chat-plus-plugins',
      onSelect: (): void => {
        setPlusOpen(false);
        setPluginsOpen(true);
      },
    },
  ];

  const dropFiles = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setDragActive(false);
    addFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <div className="mx-auto w-full max-w-[var(--chat-reading-width)] px-3 pb-3 chat-width-transition">
      <ChatComposerShell
        shellRef={boxRef}
        dragActive={dragActive}
        dataTestId="cloud-chat-composer"
        onDragOver={(event): void => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(): void => setDragActive(false)}
        onDrop={dropFiles}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          data-testid="cloud-chat-file-input"
          onChange={(event: ChangeEvent<HTMLInputElement>): void => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <ChatComposer
          chrome="shell"
          typeToFocus
          draftKey={draftKey}
          onSend={send}
          onStop={controls.onStop}
          isStreaming={controls.isStreaming}
          sendBlocked={uploading || sending || settingSaves > 0}
          restoreDraftOnReject
          aboveEditor={
            <>
              {selectionNotice === undefined ? null : (
                <p
                  className="px-1 text-xs fg-secondary"
                  role="status"
                  data-testid="cloud-chat-selection-notice"
                >
                  {selectionNotice}
                </p>
              )}
              <PendingAttachmentRow
                attachments={attachments.map((attachment) => ({
                  localId: attachment.localId,
                  filename: attachment.name,
                  state: chipState(attachment.state),
                }))}
                onRemove={onRemoveAttachment}
                onRetry={onRetryAttachment}
              />
            </>
          }
          leadingSlot={
            <ComposerPlusMenuPresentation
              isOpen={plusOpen}
              setIsOpen={setPlusOpen}
              keyboardNavigation
              rows={plusRows}
              anchorRef={boxRef}
              triggerRef={plusTriggerRef}
              returnFocusRef={plusTriggerRef}
              dataTestIdPrefix="cloud-chat"
              menuId="cloud-chat-plus-menu"
            />
          }
          modelSlot={
            <PortalModelPicker
              catalog={modelCatalog}
              currentModel={currentModel}
              brandDisplayName={brandDisplayName}
              menuAlignRef={boxRef}
              onSelect={(modelId): void => {
                saveSetting(onSelectModel(modelId));
              }}
            />
          }
          pluginsSlot={
            <PortalPluginsPicker
              open={pluginsOpen}
              onOpenChange={setPluginsOpen}
              hideTrigger
              returnFocusRef={plusTriggerRef}
              catalog={pluginCatalog}
              selections={selections}
              loading={pluginCatalog === null}
              brandDisplayName={brandDisplayName}
              onChange={(next): void | Promise<void> => {
                const save = onChangeSelections(next);
                saveSetting(save);
                return save;
              }}
            />
          }
        />
      </ChatComposerShell>
    </div>
  );
}
