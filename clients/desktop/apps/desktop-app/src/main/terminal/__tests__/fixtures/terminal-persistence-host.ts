import { join } from 'node:path';
export function getWorktreeTerminalStateFilePath(p: string, w: string): string {
  return join(
    process.env.TERMINAL_TEST_ROOT ?? '',
    p,
    w,
    'terminal-state.json',
  );
}
export function getWorktreeTerminalPresentationFilePath(
  p: string,
  w: string,
): string {
  return join(
    process.env.TERMINAL_TEST_ROOT ?? '',
    p,
    w,
    'terminal-presentation.json',
  );
}
export function logMainProcessWarn(): void {}
