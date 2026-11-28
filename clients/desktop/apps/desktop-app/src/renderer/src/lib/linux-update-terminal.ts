import { subscribeTerminalInput } from '@canopy/ui-app/terminal-core';
import { linuxUpdateCopy } from '@canopy/desktop-shared/lib/linux-update-copy';
import { toAppError, type AppErrorCode } from '@canopy/protocol/app-errors';
import { brand } from '@/lib/brand';
import { isWebCoreScope } from '@/lib/chat-authority';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useTerminalStore } from '@/stores/terminalStore';
import {
  findPanelByInstanceKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { createTerminalPanel } from '@/lib/panels/panel-creation-actions';
import { DEFAULT_TERMINAL_GROUP_ID } from '@/lib/panels/panel-group-ids';
import { extractIpcErrorMessage } from '@/lib/errors';

interface UpdateTerminalFailure {
  message: string;
  details?: string;
  code?: AppErrorCode;
}

// Settings unmounts its content on close. Keep only this transient action's
// failure across that unmount; no persisted state or backend authority here.
let terminalFailure: UpdateTerminalFailure | null = null;
const failureListeners = new Set<() => void>();
let updateActionId = 0;
let supersedeUpdateAction: (() => void) | undefined;

/** The latest updater gesture wins across Settings and the sidebar. */
export function beginLinuxUpdateAction(
  onSuperseded?: () => void,
  offerVersion?: string,
): () => boolean {
  supersedeUpdateAction?.();
  const requestId = ++updateActionId;
  clearLinuxUpdateTerminalError();
  const supersede = (): void => {
    if (requestId !== updateActionId) return;
    updateActionId += 1;
    unsubscribe();
    supersedeUpdateAction = undefined;
    clearLinuxUpdateTerminalError();
    onSuperseded?.();
  };
  supersedeUpdateAction = supersede;
  const unsubscribe = window.api.update.onUpdateEvent((event): void => {
    if (
      event.type !== 'checking' &&
      !(event.type === 'available' && event.info.version === offerVersion)
    )
      supersede();
  });
  return (): boolean => requestId === updateActionId;
}

export function getLinuxUpdateTerminalError(): UpdateTerminalFailure | null {
  return terminalFailure;
}

export function subscribeLinuxUpdateTerminalError(
  listener: () => void,
): () => void {
  failureListeners.add(listener);
  return (): void => {
    failureListeners.delete(listener);
  };
}

export function clearLinuxUpdateTerminalError(): void {
  if (terminalFailure === null) return;
  terminalFailure = null;
  for (const listener of failureListeners) listener();
}

function showTerminalFailure(failure: UpdateTerminalFailure): void {
  terminalFailure = failure;
  useNavigationStore.getState().openSettings('canopy', {
    scrollTo: 'settings-linux-update-guidance',
  });
  for (const listener of failureListeners) listener();
}

/** Update commands must stay on this computer, not a remote worktree. */
export function canOpenLinuxUpdateTerminal(): boolean {
  const selected = useChatStore.getState().selectedWorktree;
  return (
    window.api.remoteControl.getContext().mode === 'local' &&
    selected !== null &&
    !isWebCoreScope(selected.worktreeId) &&
    !useGitHubStore
      .getState()
      .splitLockedWorktrees.has(`${selected.projectId}/${selected.worktreeId}`)
  );
}

/** Types trusted display copy into a new shell, never initialCommand or Enter. */
export async function openLinuxUpdateTerminal(
  isActionCurrent?: () => boolean,
  offerVersion?: string,
): Promise<{
  opened: boolean;
  reason?: string;
}> {
  const isLatestAction =
    isActionCurrent ?? beginLinuxUpdateAction(undefined, offerVersion);
  if (!isLatestAction()) return { opened: false, reason: 'superseded' };
  clearLinuxUpdateTerminalError();
  const selected = useChatStore.getState().selectedWorktree;
  if (!selected || !canOpenLinuxUpdateTerminal()) {
    return { opened: false, reason: 'no-local-worktree' };
  }
  const copy = linuxUpdateCopy(brand, __CANOPY_RELEASE_FLAVOR__);
  const data = copy.apt?.command;
  // The allowlist excludes all control characters, shell substitutions and
  // quoting. Brand validation restricts cliName too; never accept feed text.
  if (!data || !/^[a-z0-9 &.\-]+$/.test(data) || /[\r\n]/.test(data)) {
    showTerminalFailure({
      message: "Couldn't open the update terminal. Copy the command instead.",
    });
    return { opened: false };
  }

  useNavigationStore.getState().closeSettings();
  useChatStore
    .getState()
    .selectWorktree(selected.projectId, selected.worktreeId);
  useTerminalStore
    .getState()
    .setDrawerCollapsed(selected.projectId, selected.worktreeId, false);

  const navigationRevision = useNavigationStore.getState();
  const selectedWorktree = useChatStore.getState().selectedWorktree;
  const isCurrent = (): boolean =>
    isLatestAction() &&
    useNavigationStore.getState() === navigationRevision &&
    useChatStore.getState().selectedWorktree === selectedWorktree;

  let terminalId: string | undefined;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeInput: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let panelBound = false;
  let writeStarted = false;
  let userOwned = false;
  let failureShown = false;
  let bound = false;
  let disposed = false;
  let quiet = false;
  let finish: () => void = (): void => {};
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let attach: Promise<void> | undefined;
  let attachFailure: { error: unknown } | undefined;
  const markQuiet = (): void => {
    if (disposed) return;
    quiet = true;
    if (bound) finish();
  };
  const sawOutput = (): void => {
    if (disposed) return;
    if (!isCurrent()) {
      finish();
      return;
    }
    quiet = false;
    clearTimeout(timer);
    timer = setTimeout(markQuiet, 100);
  };

  try {
    const opened = await createTerminalPanel(
      `${selected.projectId}/${selected.worktreeId}`,
      DEFAULT_TERMINAL_GROUP_ID,
      'default',
      copy.terminalTitle,
      undefined,
      document,
      (id: string): void => {
        if (!isCurrent()) return;
        terminalId = id;
        unsubscribeInput = subscribeTerminalInput(id, (): void => {
          userOwned = true;
          finish();
        });
        const stopOutput = window.api.terminal.onOutput((event): void => {
          if (event.terminalId === id && event.data.length > 0) sawOutput();
        });
        // A daemon terminal this window reads itself reports only progress
        // (CAN-8070), always for bytes.
        const stopProgress = window.api.terminal.onOutputProgress(
          (event): void => {
            if (event.terminalId === id) sawOutput();
          },
        );
        unsubscribe = (): void => {
          stopOutput();
          stopProgress();
        };
        timer = setTimeout(markQuiet, 1000);
        // Observe rejection immediately, even if tab binding is still pending.
        // The caller surfaces the failure after binding; never type on failure.
        attach = window.api.terminal.attach({ terminalId: id }).then(
          (response): void => {
            if (response.replay.length > 0) sawOutput();
          },
          (error: unknown): void => {
            attachFailure = { error };
          },
        );
      },
      isCurrent,
    );
    panelBound = opened;
    if (userOwned) return { opened };
    if (!isCurrent()) return { opened: false, reason: 'superseded' };
    if (!opened || !terminalId) {
      // Panel creation already reports its failure through the existing
      // terminal-opening convention. Return to the copyable guidance too.
      useNavigationStore.getState().openSettings('canopy', {
        scrollTo: 'settings-linux-update-guidance',
      });
      return { opened: false };
    }
    await attach;
    if (userOwned) return { opened: true };
    if (!isCurrent()) return { opened: false, reason: 'superseded' };
    if (attachFailure) {
      const classified = toAppError(attachFailure.error);
      failureShown = true;
      showTerminalFailure({
        message:
          "Couldn't type the update command. Copy it and paste it into the terminal.",
        details: extractIpcErrorMessage(attachFailure.error),
        code: classified?.code,
      });
      return { opened: false };
    }
    bound = true;
    if (quiet) finish();
    await ready;
    if (userOwned) return { opened: true };
    if (!isCurrent()) return { opened: false, reason: 'superseded' };
    // Stop observing before the write's echo. The receipt is per terminal,
    // so a replay cannot type twice and a new tab still gets its own command.
    unsubscribe?.();
    unsubscribe = undefined;
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    writeStarted = true;
    await window.api.terminal.write({
      terminalId,
      data,
      idempotencyKey: 'linux-update-typed',
    });
    return { opened: true };
  } catch (error: unknown) {
    if (userOwned) return { opened: true };
    if (!isCurrent()) return { opened: false, reason: 'superseded' };
    const classified = toAppError(error);
    failureShown = true;
    showTerminalFailure({
      message:
        "Couldn't type the update command. Copy it and paste it into the terminal.",
      details: extractIpcErrorMessage(error),
      code: classified?.code,
    });
    return { opened: false };
  } finally {
    disposed = true;
    unsubscribeInput?.();
    clearTimeout(timer);
    unsubscribe?.();
    if (
      panelBound &&
      terminalId &&
      !writeStarted &&
      !userOwned &&
      !failureShown &&
      !isCurrent()
    ) {
      const panel = findPanelByInstanceKey(
        `${selected.projectId}/${selected.worktreeId}`,
        `terminal:${terminalId}`,
      );
      if (panel)
        usePanelLayoutStore
          .getState()
          .closeTab(panel.layoutKey, panel.groupId, panel.panelId, {
            keepEmptyGroup:
              panel.layoutKey ===
                `${selected.projectId}/${selected.worktreeId}` &&
              panel.groupId === DEFAULT_TERMINAL_GROUP_ID,
          });
    }
  }
}
