import type { TerminalClient, TerminalShellSpawnArgs } from '@canopy/app-core';
import type { TerminalSession } from '@canopy/protocol/terminal';
import { beginTerminalPlacement } from '@canopy/app-state/terminal';

/** Where a {@link runCommandInTerminal} attempt stopped. */
export type TerminalRunStage = 'hydrate' | 'spawn' | 'reveal' | 'write';

/**
 * A failed run. `session` is set once a PTY exists, so callers can surface it;
 * a `write` failure may already have reached the shell and must not be retried.
 */
export class TerminalRunError extends Error {
  readonly stage: TerminalRunStage;
  readonly session: TerminalSession | null;
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare readonly cause: unknown;

  constructor(
    stage: TerminalRunStage,
    session: TerminalSession | null,
    cause: unknown,
  ) {
    super(
      cause instanceof Error && cause.message
        ? cause.message
        : `Terminal ${stage} failed`,
    );
    this.name = 'TerminalRunError';
    this.stage = stage;
    this.session = session;
    this.cause = cause;
  }
}

export interface RunCommandInTerminalOptions {
  readonly client: Pick<TerminalClient, 'command'>;
  readonly spawn: Omit<TerminalShellSpawnArgs, 'relativeCwd'> & {
    /** Package directory beneath the selected target; empty means none. */
    readonly relativeCwd?: string | null;
  };
  /** Shell input. Trailing newlines are trimmed; one submission newline is added. */
  readonly command: string;
  /** Host terminal-store hydration before the new PTY joins the layout. */
  readonly hydrate?: () => Promise<void>;
  /** Host reveal: add the session to its layout and show the panel. */
  readonly reveal?: (session: TerminalSession) => void;
  /** Stable key so a replayed renderer write is not delivered twice. */
  readonly idempotencyKey?: string;
}

/** Exact bytes written for `command`: its body plus one submission newline. */
export function terminalSubmission(command: string): string {
  return `${command.replace(/[\r\n]+$/, '')}\n`;
}

/**
 * Spawn a fresh shell, reveal it, then write the command exactly once. Never
 * retries: every failure is reported with its stage and leaves retrying to the
 * user, because a failed write may already have been accepted by the shell.
 */
export async function runCommandInTerminal({
  client,
  spawn,
  command,
  hydrate,
  reveal,
  idempotencyKey,
}: RunCommandInTerminalOptions): Promise<TerminalSession> {
  if (hydrate) {
    try {
      await hydrate();
    } catch (error) {
      throw new TerminalRunError('hydrate', null, error);
    }
  }
  const { relativeCwd, ...rest } = spawn;
  let session: TerminalSession;
  // Main can publish the shell before the spawn reply; `reveal` places it.
  const endPlacement = beginTerminalPlacement(
    spawn.projectId,
    spawn.worktreeId,
  );
  try {
    try {
      session = await client.command('terminal.spawn', {
        ...rest,
        ...(relativeCwd ? { relativeCwd } : {}),
      });
    } catch (error) {
      throw new TerminalRunError('spawn', null, error);
    }
    if (reveal) {
      try {
        reveal(session);
      } catch (error) {
        throw new TerminalRunError('reveal', session, error);
      }
    }
  } finally {
    endPlacement();
  }
  try {
    await client.command('terminal.write', {
      terminalId: session.id,
      data: terminalSubmission(command),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  } catch (error) {
    throw new TerminalRunError('write', session, error);
  }
  return session;
}
