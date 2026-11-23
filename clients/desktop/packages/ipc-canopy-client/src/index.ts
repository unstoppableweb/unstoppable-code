export { createIpcCanopyClient } from './client';
export type {
  IpcCanopyClient,
  IpcCanopyClientPorts,
  ScopedFileOperations,
  StandaloneChatActiveWork,
  WorktreeStateForkRequest,
} from './ports';
export {
  OPERATION_UNSUPPORTED_CODE,
  REMOTE_IPC_MALFORMED_REPLY_CODE,
  REMOTE_IPC_UNAUTHORIZED_CODE,
  RemoteIpcChannelUnauthorizedError,
  RemoteIpcMalformedReplyError,
  UnsupportedOperationError,
} from './channel-client';
export {
  INSTALLED_ITEM_CHANGE_HOST_OUTDATED,
  INSTALLED_ITEM_STATUS_HOST_OUTDATED,
  PLUGIN_INSTALL_HOST_OUTDATED,
  REMOTE_HOST_OUTDATED_CODE,
  RemoteHostOutdatedError,
} from './marketplace-mutations';
export {
  CHAT_HISTORY_INVALID_CURSOR_CODE,
  ChatHistoryCursorError,
} from './chat-history';
export {
  capabilityLimitForChannels,
  intersectCanopyCapabilities,
  type CapabilityLimit,
} from './capabilities';
export type { WireFileTreeRoot } from './wire';
export { languageForPath } from './projections';
