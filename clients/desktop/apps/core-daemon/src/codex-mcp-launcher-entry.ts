import {
  CODEX_MCP_STDIO_LAUNCHER_COMMAND,
  CodexMcpLauncherError,
  processCodexMcpLauncherIo,
  runCodexMcpStdioLauncher,
  type CodexMcpLaunchRequest,
} from '@canopy/core-platform/codex-mcp-launcher';

export const CODEX_MCP_LAUNCHER_USAGE_EXIT = 64;
export const CODEX_MCP_LAUNCHER_USAGE_TEXT =
  'MCP launcher arguments are invalid.';
export const CODEX_MCP_LAUNCHER_FAILURE_TEXT = 'MCP launcher failed.';

export interface CodexMcpLauncherEntryHost {
  run(request: CodexMcpLaunchRequest): Promise<number>;
  setExitCode(code: number): void;
  writeStderr(text: string): void;
}

const processLauncherEntryHost: CodexMcpLauncherEntryHost = {
  run: (request) =>
    runCodexMcpStdioLauncher(request, processCodexMcpLauncherIo()),
  setExitCode: (code) => {
    process.exitCode = code;
  },
  writeStderr: (text) => {
    process.stderr.write(text);
  },
};

/**
 * The daemon executable's hidden launcher mode (CAN-4117): the Codex
 * app-server starts `<daemon> __codex-mcp-stdio-launcher <capabilityId>
 * <routeId>` as an MCP stdio server. True when `args` ask for it; the relay
 * then runs on its own and never starts a daemon.
 */
export function runRequestedCodexMcpLauncher(
  args: readonly string[],
  host: CodexMcpLauncherEntryHost = processLauncherEntryHost,
): boolean {
  if (args[0] !== CODEX_MCP_STDIO_LAUNCHER_COMMAND) return false;
  if (args.length !== 3) {
    host.writeStderr(`${CODEX_MCP_LAUNCHER_USAGE_TEXT}\n`);
    host.setExitCode(CODEX_MCP_LAUNCHER_USAGE_EXIT);
    return true;
  }
  void host.run({ capabilityId: args[1], routeId: args[2] }).then(
    (code) => host.setExitCode(code),
    (error: unknown) => {
      host.writeStderr(
        `${error instanceof CodexMcpLauncherError ? error.message : CODEX_MCP_LAUNCHER_FAILURE_TEXT}\n`,
      );
      host.setExitCode(1);
    },
  );
  return true;
}
