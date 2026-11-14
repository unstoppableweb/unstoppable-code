import type { PersistedChatTab } from '@canopy/desktop-shared/types';

/**
 * The Claude config folder the chat's own runtime reads at `cwd`. Managed
 * Claude Code terminal chats (`claude-code`, `auto`) launch with the
 * worktree's terminal environment; other chats with the workspace agent
 * environment. Each runtime's CLAUDE_CONFIG_DIR wins, else its default.
 */
export async function chatClaudeConfigDir(args: {
  projectId: string;
  worktreeId: string;
  cwd: string;
  tab: PersistedChatTab;
}): Promise<string> {
  const { resolveClaudeModConfigDirectory } =
    await import('../agents/claude-mod-admission-launch');
  if (
    args.tab.interfaceMode === 'claude-code' ||
    args.tab.interfaceMode === 'auto'
  ) {
    const { desktopTerminalEnvironmentFor } =
      await import('../terminal/worker-terminal');
    const terminalEnv = desktopTerminalEnvironmentFor(
      args.projectId,
      args.worktreeId,
    );
    return resolveClaudeModConfigDirectory({
      cwd: args.cwd,
      environment: false,
      ...(terminalEnv.CLAUDE_CONFIG_DIR !== undefined
        ? { claudeConfigDir: terminalEnv.CLAUDE_CONFIG_DIR }
        : {}),
      ...(terminalEnv.HOME ? { home: terminalEnv.HOME } : {}),
    });
  }
  return resolveClaudeModConfigDirectory({
    cwd: args.cwd,
    environment: { runtime: 'agent', workspaceId: args.projectId },
  });
}
