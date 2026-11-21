import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type ChatIngestionLagEventData,
  type PlanExitRequestEvent,
  type PromptSuggestionEventData,
  type WorktreeData,
  type WorktreeGitFailedEvent,
  type WorktreeGitReadyEvent,
  type WorktreeNeedsRepairEvent,
} from '@canopy/desktop-shared/types';
import { sendToWindow } from '../lib/window-send';
import type { DelegationLiveClass } from './delegation/live-frame-class';

/**
 * A delegate's live transcript frame. The delegation service spreads its
 * `canopy_delegation` event into it; these are the members it types, and so
 * the members the controller-visible `chat:event` shape records.
 */
export type DelegationLiveEventData = {
  delivery: string;
  liveClass: DelegationLiveClass;
};

export interface AgentChatTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * What an agent session asks of the interfaces that show its chat: the
 * display-client capability (daemon plan document 10). Electron main backs
 * it with its main window; a daemon host backs it with interface leases.
 * Sessions reach no window except through it (CAN-6995).
 */
export interface AgentInterfacePort {
  /**
   * Transient `chat:event`s outside admission and commit, never written to
   * the transcript. One typed member per event keeps the controller-visible
   * `chat:event` shape what deployed clients read.
   */
  publishPromptSuggestion(
    target: AgentChatTarget,
    data: PromptSuggestionEventData,
  ): void;
  publishIngestionLag(
    target: AgentChatTarget,
    data: ChatIngestionLagEventData,
  ): void;
  /**
   * A managed delegate's live transcript frame on its root chat's
   * `chat:event`, outside admission and commit.
   */
  publishDelegationLive(
    target: AgentChatTarget,
    data: DelegationLiveEventData,
  ): void;
  /** Shows a plan-exit request the session has already committed. */
  presentPlanExit(event: PlanExitRequestEvent): void;
  /**
   * Worktree-action notices. Each member is the one send site of one caller,
   * so each push keeps its own census row and the payload its caller sent.
   * A branched agent's new worktree: its Git setup became ready, failed or
   * needs repair, and then the project's worktree list.
   */
  publishWorktreeGitReady(event: WorktreeGitReadyEvent): void;
  publishWorktreeGitFailed(event: WorktreeGitFailedEvent): void;
  publishWorktreeNeedsRepair(event: WorktreeNeedsRepairEvent): void;
  publishWorkspaceWorktrees(
    workspaceId: string,
    worktrees: WorktreeData[],
  ): void;
  /** A worktree's hooks were paused or resumed (`hook.pause`, `hook.resume`). */
  publishHookPauseChanged(
    workspaceId: string,
    worktree: WorktreeData | undefined,
  ): void;
  /**
   * The window, for the intents still to move onto this port: approvals
   * (including a delegate's), questions, a delegate's detached transcript
   * updates and the other worktree actions.
   */
  legacyWindow(): BrowserWindow | null;
}

/** The port over Electron main's window accessor. */
export function windowAgentInterfacePort(
  getWindow: () => BrowserWindow | null,
): AgentInterfacePort {
  return {
    publishPromptSuggestion: (target, data): void => {
      sendToWindow(getWindow(), IPC_CHANNELS.chatEvent, { ...target, data });
    },
    publishIngestionLag: (target, data): void => {
      sendToWindow(getWindow(), IPC_CHANNELS.chatEvent, { ...target, data });
    },
    publishDelegationLive: (target, data): void => {
      sendToWindow(getWindow(), IPC_CHANNELS.chatEvent, {
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.chatId,
        data,
      });
    },
    presentPlanExit: (event): void => {
      sendToWindow(getWindow(), IPC_CHANNELS.planExitRequest, event);
    },
    publishWorktreeGitReady: (event): void => {
      sendToWindow(getWindow(), IPC_CHANNELS.worktreeGitReady, event);
    },
    publishWorktreeGitFailed: (event): void => {
      sendToWindow(getWindow(), IPC_CHANNELS.worktreeGitFailed, event);
    },
    publishWorktreeNeedsRepair: (event): void => {
      sendToWindow(getWindow(), IPC_CHANNELS.worktreeNeedsRepair, event);
    },
    publishWorkspaceWorktrees: (workspaceId, worktrees): void => {
      sendToWindow(getWindow(), IPC_CHANNELS.workspaceWorktreesUpdated, {
        workspaceId,
        worktrees,
      });
    },
    publishHookPauseChanged: (workspaceId, worktree): void => {
      sendToWindow(getWindow(), IPC_CHANNELS.workspaceWorktreesUpdated, {
        workspaceId,
        ...(worktree ? { worktree } : {}),
      });
    },
    legacyWindow: getWindow,
  };
}
