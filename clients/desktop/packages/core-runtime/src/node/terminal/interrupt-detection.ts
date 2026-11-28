/**
 * Claude terminals' user-interrupted status line, read from their output
 * (Q-D). Shared by main's Claude session service and the daemon's terminal
 * host, which sees the bytes of terminals no client attaches to.
 */

/** The output tail kept per terminal to find a status line split across chunks. */
export const TERMINAL_OUTPUT_INTERRUPTION_DETECTION_TAIL_CHARS = 2048;

function stripTerminalControlSequences(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

export function terminalOutputIndicatesUserInterruptedTurn(
  text: string,
): boolean {
  // Defense-in-depth for Claude Code builds that do not emit the PTY
  // interruptedByUser signal. Keep this anchored to standalone status lines to
  // limit false positives from arbitrary assistant or command output.
  return stripTerminalControlSequences(text)
    .replace(/\r/g, '\n')
    .split('\n')
    .some((line) => {
      const normalized = line.trim().toLowerCase();
      return (
        /^(interrupted|cancelled|canceled) by user[.!]?$/.test(normalized) ||
        /^user (cancelled|canceled)[.!]?$/.test(normalized)
      );
    });
}
