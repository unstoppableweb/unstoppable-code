// Which commands a command (stdio) MCP server may start with. Desktop main
// enforces this list when it saves, checks or starts a server; the forms use
// the same rule to say so before saving (CAN-6404).

export const MCP_SERVER_COMMANDS: readonly string[] = Object.freeze([
  'npx',
  'npm',
  'node',
  'python',
  'python3',
  'uv',
  'uvx',
]);

/** True for a command named on the list, with no path. */
export function isMcpServerCommandAllowed(
  command: string | undefined,
): boolean {
  if (!command) return false;
  if (command.includes('/') || command.includes('\\')) return false;
  return MCP_SERVER_COMMANDS.includes(command);
}

const COMMAND_LIST = `${MCP_SERVER_COMMANDS.slice(0, -1).join(', ')} or ${
  MCP_SERVER_COMMANDS[MCP_SERVER_COMMANDS.length - 1]
}`;

/**
 * Why a command can't start a server, as a sentence for the person adding
 * it, or null when it can (or is still empty).
 */
export function mcpServerCommandRefusal(command: string): string | null {
  if (command === '' || isMcpServerCommandAllowed(command)) return null;
  const name = command.split(/[/\\]/).pop() ?? '';
  if (name !== command && MCP_SERVER_COMMANDS.includes(name)) {
    return `Enter ${name} by name, without a path.`;
  }
  return `Only ${COMMAND_LIST} can start a server. Enter one by name, without a path.`;
}
