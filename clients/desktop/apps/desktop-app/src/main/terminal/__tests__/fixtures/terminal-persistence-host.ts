import { join } from 'node:path';
import { createHash } from 'node:crypto';

function worktreeFile(p: string, w: string, file: string): string {
  return join(
    process.env.TERMINAL_TEST_ROOT ?? '',
    'workspaces',
    p,
    'worktree-data',
    w,
    file,
  );
}
export function getWorktreeTerminalStateFilePath(p: string, w: string): string {
  return worktreeFile(p, w, 'terminal-state.json');
}
export function getWorktreeTerminalPresentationFilePath(
  p: string,
  w: string,
): string {
  return worktreeFile(p, w, 'terminal-presentation.json');
}
export function getWorktreeTerminalLegacyLayout(): 'workspaces' {
  return 'workspaces';
}
export function getWorktreeTerminalReplayWitnessFilePath(
  p: string,
  w: string,
  id: string,
): string {
  return worktreeFile(
    p,
    w,
    `terminal-replay-witness.${createHash('sha256').update(id).digest('hex')}.json`,
  );
}
export function getTerminalOutboxDataRoot(): string {
  return process.env.TERMINAL_TEST_ROOT ?? '';
}
export function logMainProcessWarn(): void {}
/** The child passes its own record port; the daemon's is never reached. */
export const daemonTerminalRecordClient = {
  available: (): Promise<boolean> => Promise.resolve(false),
};
