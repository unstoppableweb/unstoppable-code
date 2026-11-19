import type {
  RemoteControlChatFileReference,
  RemoteControlChatSendPayload,
  RemoteControlEditorFileMentionOption,
} from '@canopy/protocol/remote-control/shell';

export type HostRemoteControlChatFileReference = Omit<
  RemoteControlChatFileReference,
  'referenceId'
> & {
  absolutePath: string;
};

export type HostRemoteControlChatSendPayload = Omit<
  RemoteControlChatSendPayload,
  'fileReferences'
> & {
  fileReferences?: HostRemoteControlChatFileReference[];
};

export type HostRemoteControlEditorFileMentionOption = Omit<
  RemoteControlEditorFileMentionOption,
  'referenceId'
> & {
  absolutePath: string;
};
