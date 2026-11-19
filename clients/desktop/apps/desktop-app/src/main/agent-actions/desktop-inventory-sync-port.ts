/**
 * The desktop port for the shared inventory-sync family (CAN-7262): this
 * computer's "Sync lists to the web" switch.
 *
 * Turning the switch off deletes this computer's synced lists from the web,
 * so the port always asks the person first, exactly as the Settings dialog
 * does. The prompt ignores the chat's approval mode and every saved project
 * or global rule: it offers no "always allow" (no `suggestedTarget`), no
 * policy can decide it (`revalidate` always answers `prompt`), and an allow
 * is never persisted. A decline, timeout or cancel is
 * `authorization_conflict`; a missing approval surface fails closed as
 * `surface_unavailable`. A paired controller may answer the mirrored card:
 * controllers are the same account's own devices. Turning the switch on is
 * not prompted by the port.
 */
import {
  AgentPortError,
  type AgentActionCall,
  type AgentInventorySyncPort,
  type AgentInventorySyncState,
  type AgentInventorySyncWriteResult,
} from '@canopy/agent-actions';
import type { RemoteControlState } from '@canopy/desktop-shared/types/remote-control';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol/ui-labels';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import type { SendableBrowserWindow } from '../lib/window-send';
import {
  ApprovalRequestEndedError,
  requestApprovalDecision,
  type ApprovalBridgeResult,
} from '../approvals/prompt-bridge';
import { cancelApproval } from '../approvals/pending-approvals';
import { peekCanopyCloudAccountId } from '../lib/canopy-cloud-account-store';

// The Settings dialog's title and message for the same choice. Main can't
// import the renderer's constants, so keep these in step with
// INVENTORY_SYNC_TURN_OFF_MESSAGE and the dialog title in
// renderer/src/components/settings/RemoteAccessTab.tsx.
export const INVENTORY_SYNC_TURN_OFF_TITLE = 'Stop syncing lists to the web?';
export const INVENTORY_SYNC_TURN_OFF_DESCRIPTION =
  "This computer's synced plugin, MCP server and pipeline lists are removed from the web. Turn it back on to sync them again.";

const TURN_OFF_TIMEOUT_MS = 120_000;
const TOOL_NAME = 'inventory_sync.set_enabled';

type RemoteControlServiceLike = {
  getState(request?: { discover?: boolean }): Promise<RemoteControlState>;
  setInventorySyncEnabled(enabled: boolean): Promise<RemoteControlState>;
};

export interface DesktopInventorySyncPortDeps {
  service: () => Promise<RemoteControlServiceLike | null>;
  /** The signed-in account's id, `null` signed out, `undefined` unknown. */
  accountId: () => string | null | undefined;
  requestApproval: typeof requestApprovalDecision;
  cancelApproval: (requestId: string, reason: string) => boolean;
}

export function projectInventorySyncState(
  state: RemoteControlState,
): AgentInventorySyncState {
  const enabled = state.inventorySyncEnabled ?? true;
  return {
    enabled,
    allowIncoming: state.allowIncoming,
    signedIn: state.signedIn,
    syncing: enabled && state.allowIncoming && state.signedIn,
    pausedReason: enabled && !state.allowIncoming ? 'allow_incoming_off' : null,
    deleteStatus: state.inventoryDeleteStatus ?? 'idle',
  };
}

function approvalWindow(
  call: AgentActionCall<CanopyInjectedToolRuntime>,
): SendableBrowserWindow | null {
  const window =
    call.host.worktreeActionRuntime?.getWindow() ??
    call.host.approvalWindow?.() ??
    null;
  return window && !window.isDestroyed() ? window : null;
}

/** Asks the person to approve turning the switch off; resolves only on allow. */
async function askToTurnOff(
  deps: DesktopInventorySyncPortDeps,
  call: AgentActionCall<CanopyInjectedToolRuntime>,
): Promise<void> {
  const scope = call.scope;
  if (!scope)
    throw new AgentPortError(
      'surface_unavailable',
      'There is no chat to ask for approval in.',
    );
  if (!approvalWindow(call))
    throw new AgentPortError(
      'surface_unavailable',
      'There is no window to ask for approval in.',
    );
  const signal = call.signal;
  if (signal?.aborted)
    throw new AgentPortError(
      'authorization_conflict',
      'The request was cancelled before it was approved.',
    );
  let approvalId: string | undefined;
  const cancel = (): void => {
    if (approvalId)
      deps.cancelApproval(approvalId, 'inventory_sync_turn_off_cancelled');
  };
  signal?.addEventListener('abort', cancel, { once: true });
  let result: ApprovalBridgeResult;
  try {
    result = await deps.requestApproval({
      sessionKey: `${scope.workspaceId}/${scope.worktreeId}/${scope.chatId}`,
      getWindow: () => approvalWindow(call),
      timeoutMs: TURN_OFF_TIMEOUT_MS,
      // No suggestedTarget: the card offers no "always allow".
      event: {
        projectId: scope.workspaceId,
        worktreeId: scope.worktreeId,
        chatId: scope.chatId,
        provider: 'claude',
        ...(call.toolUseId ? { toolUseId: call.toolUseId } : {}),
        title: INVENTORY_SYNC_TURN_OFF_TITLE,
        description: INVENTORY_SYNC_TURN_OFF_DESCRIPTION,
        details: {
          kind: 'tool',
          toolName: TOOL_NAME,
          inputSummary: INVENTORY_SYNC_TURN_OFF_TITLE,
        },
      },
      // No chat mode, policy or saved rule decides this prompt.
      revalidate: () => Promise.resolve('prompt'),
      onRegistered: (id) => {
        approvalId = id;
        if (signal?.aborted) cancel();
      },
    });
  } catch (error) {
    if (error instanceof ApprovalRequestEndedError) {
      if (error.message === 'approval_no_client')
        throw new AgentPortError(
          'surface_unavailable',
          'There is no window to ask for approval in.',
        );
      throw new AgentPortError(
        'authorization_conflict',
        'The person did not approve turning off syncing.',
      );
    }
    throw new AgentPortError(
      'execution_failed',
      'Could not ask for approval to turn off syncing.',
    );
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  // The decision's scope and target are ignored: nothing is remembered.
  if (result.kind !== 'decision' || result.decision.behavior !== 'allow')
    throw new AgentPortError(
      'authorization_conflict',
      'The person declined turning off syncing.',
    );
}

export function createDesktopInventorySyncPort(
  deps: DesktopInventorySyncPortDeps,
): AgentInventorySyncPort<CanopyInjectedToolRuntime> {
  const requireService = async (): Promise<RemoteControlServiceLike> => {
    const service = await deps.service();
    if (!service)
      throw new AgentPortError(
        'surface_unavailable',
        `${REMOTE_CONTROL_LABEL} is not running.`,
      );
    return service;
  };
  // Approved turn-offs re-check and write one at a time, so two chats
  // approved together make one service call; the second finds it off.
  let commits: Promise<unknown> = Promise.resolve();
  const serialized = <T>(run: () => Promise<T>): Promise<T> => {
    const next = commits.then(run, run);
    commits = next.catch((): void => undefined);
    return next;
  };
  return {
    getState: async (): Promise<AgentInventorySyncState> =>
      projectInventorySyncState(
        await (await requireService()).getState({ discover: false }),
      ),
    setEnabled: async (
      request,
      call,
    ): Promise<AgentInventorySyncWriteResult> => {
      const service = await requireService();
      const before = await service.getState({ discover: false });
      const state = projectInventorySyncState(before);
      // Settings shows no switch signed out.
      if (!before.signedIn)
        throw new AgentPortError(
          'authentication_failed',
          'Sign in to change syncing.',
        );
      if (state.enabled === request.enabled)
        return { changed: false, stateAtCommit: state };
      if (request.enabled) {
        // The Settings switch waits for Allow incoming before turning on.
        if (!before.allowIncoming)
          throw new AgentPortError(
            'validation_failed',
            // The visible switch label (ALLOW_INCOMING_LABEL in the renderer's
            // remote-access-copy.ts), since agents relay this to the person.
            `Turn on "Allow your other devices to control this computer" in Settings → ${REMOTE_CONTROL_LABEL} before syncing lists to the web.`,
          );
        return {
          changed: true,
          stateAtCommit: projectInventorySyncState(
            await service.setInventorySyncEnabled(true),
          ),
        };
      }
      // Turning off asks, whether or not Allow incoming is on: a paused
      // computer can still be opted out.
      const accountBefore = deps.accountId();
      // Without a known account there is nothing to compare after approval,
      // so fail before asking rather than after.
      if (!accountBefore)
        throw new AgentPortError(
          'authentication_failed',
          accountBefore === undefined
            ? "Couldn't confirm the signed-in account. Try again."
            : 'Sign in to change syncing.',
        );
      await askToTurnOff(deps, call);
      if (call.signal?.aborted)
        throw new AgentPortError(
          'authorization_conflict',
          'The request was cancelled.',
        );
      return serialized(async (): Promise<AgentInventorySyncWriteResult> => {
        const after = await service.getState({ discover: false });
        // The person approved deleting the first account's lists, not
        // another's.
        if (!after.signedIn || deps.accountId() !== accountBefore)
          throw new AgentPortError(
            'authentication_failed',
            'The signed-in account changed while waiting for approval.',
          );
        const current = projectInventorySyncState(after);
        if (!current.enabled) return { changed: false, stateAtCommit: current };
        return {
          changed: true,
          stateAtCommit: projectInventorySyncState(
            await service.setInventorySyncEnabled(false),
          ),
        };
      });
    },
  };
}

export const desktopInventorySyncPort = createDesktopInventorySyncPort({
  // Loaded on first use: the Remote Control runtime pulls in Electron-only
  // modules at load, and this port is reachable from the shared agent-action
  // host that main-process services (and their tests) import.
  service: async () => {
    const { getRemoteControlRuntime } =
      await import('../remote-control/electron-remote-control');
    return getRemoteControlRuntime()?.service ?? null;
  },
  accountId: peekCanopyCloudAccountId,
  requestApproval: requestApprovalDecision,
  cancelApproval,
});
