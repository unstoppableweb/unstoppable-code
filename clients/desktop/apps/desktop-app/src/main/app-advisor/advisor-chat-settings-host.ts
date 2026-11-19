import type { BrowserWindow } from 'electron';
import {
  CoreChatLifecycleResultSchema,
  CoreChatUpdateParamsSchema,
} from '@canopy/protocol/canopy-core';
import type {
  AppAdvisorActionResponse,
  AppAdvisorUiStateSnapshot,
} from '@canopy/desktop-shared/types';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { getClaudeTerminalSessionService } from '../integration/claude-terminal-session-service';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { advisorChatCommandId } from './advisor-chat-command-id';
import { mainAdvisorChatReadHost } from './advisor-chat-read-host';
import type {
  AdvisorChatSettingAction,
  AdvisorChatSettingsHost,
} from './advisor-chat-settings';

/**
 * The main owners behind App Advisor's moved chat setters (CAN-5999 part 2):
 * core.chat.update as the advisor chat with only core.chat.write, the Claude
 * terminal restart the Portal makes after a settings change, the live
 * session's plugin update the window's chat.updatePlugins uses, and the main
 * window's lease for a change its guard sends to the window.
 */
export function mainAdvisorChatSettingsHost(options: {
  chatId: string;
  readUiState: () => Promise<AppAdvisorUiStateSnapshot | null>;
  getMainWindow: () => BrowserWindow | null;
  hasPresentationLease: () => Promise<boolean>;
  presentInMainWindow: (
    action: AdvisorChatSettingAction,
  ) => Promise<AppAdvisorActionResponse>;
}): AdvisorChatSettingsHost {
  const reads = mainAdvisorChatReadHost({
    chatId: options.chatId,
    readUiState: options.readUiState,
  });
  return {
    readUiState: () => reads.readUiState(),
    readTabs: (projectId, worktreeId) => reads.readTabs(projectId, worktreeId),
    locateCoworkChat: (projectId, chatId) =>
      reads.locateCoworkChat(projectId, chatId),
    isMainWindowOpen: () => {
      const window = options.getMainWindow();
      return window !== null && !window.isDestroyed();
    },
    hasPresentationLease: options.hasPresentationLease,
    presentInMainWindow: options.presentInMainWindow,
    updateChat: async (request) => {
      // The adapter requires the command id and both keys to match.
      const commandId = advisorChatCommandId(request.idempotencyKey);
      const result = CoreChatLifecycleResultSchema.parse(
        await getActiveDesktopRuntime().instruction(
          'core.chat.update',
          CoreChatUpdateParamsSchema.parse({
            projectId: request.projectId,
            worktreeId: request.worktreeId,
            commandId,
            origin: 'desktop',
            action: request.action,
            _meta: { idempotencyKey: commandId },
          }),
          {
            caller: {
              principalId: 'local-desktop-user',
              clientInstanceId: `agent-action:${options.chatId}`,
              authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
              interfaceKind: 'mcp',
              grants: ['core.chat.write'],
            },
            metadata: { idempotencyKey: commandId },
          },
        ),
      );
      return {
        outcome: result.outcome,
        ...(result.reason ? { reason: result.reason } : {}),
      };
    },
    applyLivePluginSelections: async (request) => {
      try {
        const { applyChatPluginSelectionsUpdate } = await import('../ipc/chat');
        // Committed already through core.chat.update; this only updates
        // the live session and never writes the selections again.
        await applyChatPluginSelectionsUpdate(request, { committed: true });
        return true;
      } catch (error: unknown) {
        logMainProcessWarn(
          '[app-advisor] Could not apply plugin selections to the live session',
          { error: error instanceof Error ? error.message : String(error) },
        );
        return false;
      }
    },
    restartTerminal: async (target) => {
      try {
        await getClaudeTerminalSessionService().restartForSettingsChange(
          target,
        );
      } catch (error: unknown) {
        logMainProcessWarn(
          '[app-advisor] Could not restart the Claude terminal after a settings change',
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
    },
  };
}
