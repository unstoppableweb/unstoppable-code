import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useCallback, useMemo } from 'react';
import { useScriptActions } from '@canopy/app-state/script-actions';
import {
  buildScriptActionPins,
  ScriptActionRunError,
  TerminalRunError,
  useRunScriptAction,
  useScriptActionShortcutDispatcher,
  type ReservedScriptActionChord,
  type ScriptActionRunHost,
  type ScriptActionRunVia,
} from '@canopy/ui-app/script-actions';
import type { WorktreeTopBarPinnedAction } from '@canopy/ui-app';
import type { ScriptAction } from '@canopy/protocol/script-actions';
import {
  DEFAULT_TERMINAL_DRAWER_HEIGHT,
  type TerminalSession,
} from '@canopy/protocol/terminal';
import { GLOBAL_FOCUS_SHORTCUT_DEFAULT_ACCELERATOR } from '@canopy/protocol/shortcuts';
import { computeColsRowsForPixels } from '@/lib/terminal-dimensions';
import { rendererShortcutPlatform } from '@/lib/globalFocusShortcut';
import {
  desktopTerminalRunHost,
  revealDesktopTerminal,
} from '@/lib/script-actions-terminal-host';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useGlobalFocusShortcutStore } from '@/stores/globalFocusShortcutStore';

const DEFAULT_SPAWN_SIZE = { cols: 80, rows: 24 } as const;

function runFailureMessage(action: ScriptAction, error: unknown): string {
  const lead = `Couldn't run ${action.name}.`;
  if (error instanceof ScriptActionRunError) return `${lead} ${error.message}`;
  if (error instanceof TerminalRunError && error.stage === 'write')
    return `${lead} The command may not have reached the terminal. Check it before running it again.`;
  return error instanceof Error && error.message
    ? `${lead} ${error.message}`
    : `${lead} The terminal didn't start.`;
}

/**
 * Desktop wiring for the active worktree's pinned and shortcut-bound
 * scripts: one snapshot, one runner, and the window's single shortcut
 * dispatcher. Mounted once by `WorktreePart`; `active` is that part's
 * on-screen state, which already excludes Settings, split locks and archived
 * worktree viewers.
 */
export function useWorktreeScriptActions({
  projectId,
  worktreeId,
  active,
}: {
  projectId: string | null;
  worktreeId: string | null;
  active: boolean;
}): readonly WorktreeTopBarPinnedAction[] {
  const { snapshot } = useScriptActions({
    projectId,
    worktreeId,
    includeDismissed: true,
  });
  const actions = snapshot?.actions ?? null;
  useCurrentUiStateReporter(
    'scriptActions.active',
    active && projectId && worktreeId && snapshot
      ? {
          projectId,
          worktreeId,
          pendingCount: snapshot.pendingCount,
          approvedCount: snapshot.actions.filter(
            (action) => action.status === 'approved',
          ).length,
          dismissedCount: snapshot.actions.filter(
            (action) => action.status === 'dismissed',
          ).length,
          scanStatus: snapshot.scanStatus,
        }
      : null,
  );
  const selectedRepoId = useChatStore((state) => {
    if (projectId === null || worktreeId === null) return undefined;
    const worktreeChat = state.worktreeChats[`${projectId}/${worktreeId}`];
    return worktreeChat?.tabs.find((tab) => tab.id === worktreeChat.activeTabId)
      ?.selectedRepoId;
  });
  const focusShortcut = useGlobalFocusShortcutStore((state) => state.status);
  const platform = focusShortcut?.platform ?? rendererShortcutPlatform();

  const host = useMemo<ScriptActionRunHost>(() => {
    if (projectId === null || worktreeId === null) return {};
    const { hydrate, reveal } = desktopTerminalRunHost({
      projectId,
      worktreeId,
    });
    return {
      hydrate,
      reveal,
      revealExisting: (session: TerminalSession): void =>
        revealDesktopTerminal({
          projectId,
          worktreeId,
          terminalId: session.id,
        }),
      spawnSize: (): { cols: number; rows: number } => {
        const width =
          typeof document === 'undefined'
            ? 0
            : (document
                .querySelector('[data-testid="worktree-part"]')
                ?.getBoundingClientRect().width ?? 0);
        return (
          computeColsRowsForPixels(width, DEFAULT_TERMINAL_DRAWER_HEIGHT) ??
          DEFAULT_SPAWN_SIZE
        );
      },
    };
  }, [projectId, worktreeId]);

  const runner = useRunScriptAction({
    projectId,
    worktreeId,
    actions,
    active,
    selectedRepoId: selectedRepoId ?? null,
    host,
  });
  const { run } = runner;

  const runAndReport = useCallback(
    (action: ScriptAction, via: ScriptActionRunVia): void => {
      run(action, via).catch((error: unknown) => {
        useGitHubStore
          .getState()
          .addToast(runFailureMessage(action, error), 'error', undefined, {
            category: 'Terminal',
            caught: error,
            ...(projectId !== null ? { projectId } : {}),
            ...(worktreeId !== null ? { worktreeId } : {}),
          });
      });
    },
    [projectId, run, worktreeId],
  );

  // The OS takes a registered global chord before the renderer sees it; the
  // service reports that conflict too, and this keeps dispatch consistent
  // before its snapshot catches up. The default is reserved until loaded.
  const reserved = useMemo<readonly ReservedScriptActionChord[]>(
    () =>
      focusShortcut === null
        ? [
            {
              accelerator: GLOBAL_FOCUS_SHORTCUT_DEFAULT_ACCELERATOR,
              title: 'Focus app',
            },
          ]
        : focusShortcut.enabled
          ? [{ accelerator: focusShortcut.accelerator, title: 'Focus app' }]
          : [],
    [focusShortcut],
  );
  const onShortcut = useCallback(
    (action: ScriptAction): void => runAndReport(action, 'shortcut'),
    [runAndReport],
  );
  useScriptActionShortcutDispatcher({
    enabled: runner.enabled,
    actions,
    platform,
    reserved,
    onRun: onShortcut,
  });

  return useMemo(
    () =>
      buildScriptActionPins(actions, runner, {
        platform,
        onRun: (action) => runAndReport(action, 'pin'),
      }),
    [actions, platform, runAndReport, runner],
  );
}
