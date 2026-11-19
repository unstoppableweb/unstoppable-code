/**
 * Main-process compatibility facade for the browser-safe chat projectors.
 * Electron main and renderer must consume the same whole-message projection so
 * their canonical message ids and turn lifecycle cannot drift.
 */
export {
  REMOTE_CONTROL_CHAT_SEED_MESSAGE_LIMIT,
  REMOTE_CONTROL_CHAT_TRANSCRIPT_MESSAGE_LIMIT,
  limitRemoteControlChatTranscript,
  limitRemoteControlChatTranscriptForSeedWithMetadata,
  type RemoteControlChatTranscriptSeed,
  persistedMessageToRemoteControlMessage,
  projectPersistedChatTranscript,
} from '@canopy/desktop-shared/remote-control/persisted-chat-projection';
export { isTerminalRuntimeChatEvent } from '@canopy/desktop-shared/remote-control/runtime-chat-projection';
