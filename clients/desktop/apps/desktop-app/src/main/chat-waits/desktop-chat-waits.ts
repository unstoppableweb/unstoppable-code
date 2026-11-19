import {
  ChatWaitLifecycle,
  type ChatWaitNoClientMode,
} from '@canopy/core-runtime/node/agent/waits';
import { logMainProcessWarn } from '../lib/main-process-logging';

/** What makes a desktop chat client eligible to answer (CAN-4128 D18). */
export interface DesktopChatWaitPresenceSource {
  getMainWindow(): { isDestroyed(): boolean } | null;
  /** True while a paired device controls this computer over Remote Control. */
  remoteControllerAttached?(): boolean;
}

let presenceSource: DesktopChatWaitPresenceSource | null = null;
let lifecycle: ChatWaitLifecycle | null = null;
let noClientModeForTest: ChatWaitNoClientMode | undefined;

/** Installed once by the IPC registration; null answers "no client". */
export function setDesktopChatWaitPresence(
  source: DesktopChatWaitPresenceSource | null,
): void {
  presenceSource = source;
}

/** The process's one chat wait lifecycle (questions now, approvals with CAN-4129). */
export function getDesktopChatWaits(): ChatWaitLifecycle {
  lifecycle ??= new ChatWaitLifecycle({
    presence: {
      attached: (): boolean => {
        const source = presenceSource;
        if (!source) return false;
        const window = source.getMainWindow();
        return (
          (window !== null && !window.isDestroyed()) ||
          source.remoteControllerAttached?.() === true
        );
      },
    },
    ...(noClientModeForTest !== undefined
      ? { noClientMode: noClientModeForTest }
      : {}),
    onError: (error, context): void =>
      logMainProcessWarn(`[chat-waits] ${context} failed`, error),
  });
  return lifecycle;
}

/** Tests only: drop the singleton; the next get builds a fresh one with these options. */
export function resetDesktopChatWaitsForTest(options?: {
  noClientMode?: ChatWaitNoClientMode;
}): void {
  lifecycle = null;
  noClientModeForTest = options?.noClientMode;
}
