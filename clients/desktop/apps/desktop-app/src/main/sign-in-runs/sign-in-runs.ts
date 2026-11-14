import type { AntigravitySignIn } from '../antigravity/sign-in';
import { randomUUID } from 'node:crypto';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  WorkerAgentSignInMethod,
  WorkerAgentSignInProvider,
} from '@canopy/protocol/canopy-core';
import type { CoreSignInRunResult } from '@canopy/core-runtime/node/agent/sign-in';
import { getActiveDesktopRuntimeIfAccepting } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import type { AuthTerminalEventSender } from '../ipc/auth-terminal-events';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  SignInTerminal,
  type SignInTerminalOptions,
  type SignInTerminalProvider,
} from './sign-in-terminal';
import {
  stageSignInLaunch,
  type SignInLaunch,
  type SignInLaunchOutcome,
} from './sign-in-worker-host';

export class SignInWorkerUnavailableError extends Error {
  declare readonly cause?: unknown;

  constructor(options?: { cause?: unknown }) {
    super('Sign-in could not start on the local worker.');
    this.name = 'SignInWorkerUnavailableError';
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

export interface SignInTerminalStartRequest {
  provider: SignInTerminalProvider;
  cols: number;
  rows: number;
  verifiedOpenCodeExecutable?: string;
}

let sender: AuthTerminalEventSender = (): void => {};
let active: {
  sessionId: string;
  terminal: SignInTerminal | AntigravitySignIn;
  generation: number;
} | null = null;
let latestStart = 0;
let terminalOptions: SignInTerminalOptions | null = null;
const liveRuns = new Map<string, AbortController>();

export function setSignInTerminalEventSender(
  next: AuthTerminalEventSender,
): void {
  sender = next;
}

/** Test-only: injects the PTY spawn and paths into new sign-in terminals. */
export function setSignInTerminalOptionsForTesting(
  options: SignInTerminalOptions | null,
): void {
  terminalOptions = options;
}

/** One recorded sign-in run around a staged launch (also used by PR3). */
export function beginSignInRun(request: {
  provider: WorkerAgentSignInProvider;
  method: WorkerAgentSignInMethod;
  launch: SignInLaunch;
}): { signInRunId: string; settled: Promise<{ ran: boolean }> } {
  const runtime = getActiveDesktopRuntimeIfAccepting();
  if (!runtime) throw new SignInWorkerUnavailableError();
  const { provider, method } = request;
  const signInRunId = randomUUID();
  const staged = stageSignInLaunch(signInRunId, request.launch);
  const controller = new AbortController();
  liveRuns.set(signInRunId, controller);
  const settled = (async (): Promise<{ ran: boolean }> => {
    let record: CoreSignInRunResult | undefined;
    let recordThrew = false;
    let ran: boolean;
    try {
      record = await runtime.signInRuns.run(
        {
          params: { signInRunId, provider, method },
          origin: { kind: 'client', sourceId: 'local-desktop-user' },
          owner: { kind: 'system', id: LOCAL_DESKTOP_AUTHORITY_ID },
        },
        { signal: controller.signal, cancelledBy: 'local-desktop-user' },
      );
    } catch {
      recordThrew = true;
    } finally {
      ran = staged.take().ran;
      liveRuns.delete(signInRunId);
    }
    if (
      ran &&
      (recordThrew ||
        (record?.status !== 'succeeded' && record?.status !== 'cancelled'))
    )
      logMainProcessWarn(
        '[sign-in-runs] The sign-in run record did not settle',
        {
          provider,
          signInRunId,
        },
      );
    return { ran };
  })();
  return { signInRunId, settled };
}

function outcomeOf(exit: {
  exitCode: number | null;
  signal: string | null;
}): SignInLaunchOutcome {
  const { exitCode, signal } = exit;
  const cancelled = exitCode === null || (signal !== null && signal !== '0');
  return {
    status: cancelled ? 'cancelled' : exitCode === 0 ? 'succeeded' : 'failed',
    exitCode,
    signal,
  };
}

export async function startSignInTerminal(
  request: SignInTerminalStartRequest,
): Promise<{ sessionId: string }> {
  if (active && !active.terminal.exited) active.terminal.forceKill();
  const generation = ++latestStart;
  let resolveSpawned: () => void = () => undefined;
  let rejectSpawned: (error: unknown) => void = () => undefined;
  const spawned = new Promise<void>((resolve, reject) => {
    resolveSpawned = resolve;
    rejectSpawned = reject;
  });
  const { signInRunId, settled } = beginSignInRun({
    provider: request.provider,
    method: 'terminal',
    launch: async (signal) => {
      let terminal: SignInTerminal | AntigravitySignIn;
      try {
        terminal =
          request.provider === 'antigravity'
            ? new (await import('../antigravity/sign-in')).AntigravitySignIn(
                signInRunId,
                {
                  output: (event): void =>
                    sender(IPC_CHANNELS.authTerminalOutput, event),
                  exit: (event): void =>
                    sender(IPC_CHANNELS.authTerminalExit, event),
                },
              )
            : new SignInTerminal(
                {
                  sessionId: signInRunId,
                  provider: request.provider,
                  cols: request.cols,
                  rows: request.rows,
                  ...(request.verifiedOpenCodeExecutable !== undefined
                    ? {
                        verifiedOpenCodeExecutable:
                          request.verifiedOpenCodeExecutable,
                      }
                    : {}),
                  emitter: {
                    output: (event): void =>
                      sender(IPC_CHANNELS.authTerminalOutput, event),
                    exit: (event): void =>
                      sender(IPC_CHANNELS.authTerminalExit, event),
                  },
                },
                terminalOptions ?? undefined,
              );
      } catch (error) {
        rejectSpawned(error);
        throw error;
      }
      // Starts overlap while their runs are dispatched; the newest start
      // keeps the one live terminal, whichever PTY spawned first.
      if (active && !active.terminal.exited) {
        if (active.generation > generation) {
          resolveSpawned();
          terminal.forceKill();
          return outcomeOf(await terminal.exit);
        }
        active.terminal.forceKill();
      }
      active = { sessionId: signInRunId, terminal, generation };
      resolveSpawned();
      if (signal.aborted) terminal.stop();
      else
        signal.addEventListener('abort', () => terminal.stop(), {
          once: true,
        });
      const exit = await terminal.exit;
      if (active?.sessionId === signInRunId) active = null;
      return outcomeOf(exit);
    },
  });
  void settled.then(({ ran }) => {
    if (!ran) rejectSpawned(new SignInWorkerUnavailableError());
  });
  await spawned;
  return { sessionId: signInRunId };
}

function liveTerminal(
  sessionId: string,
): SignInTerminal | AntigravitySignIn | null {
  return active?.sessionId === sessionId && !active.terminal.exited
    ? active.terminal
    : null;
}

export function writeSignInTerminal(sessionId: string, data: string): void {
  liveTerminal(sessionId)?.write(data);
}

export function resizeSignInTerminal(
  sessionId: string,
  cols: number,
  rows: number,
): void {
  liveTerminal(sessionId)?.resize(cols, rows);
}

export function stopSignInTerminal(sessionId: string): void {
  liveTerminal(sessionId)?.stop();
}

export function getActiveSignInTerminalSessionId(): string | null {
  return active && !active.terminal.exited ? active.sessionId : null;
}

export function shutdownSignInRuns(): void {
  if (active && !active.terminal.exited) active.terminal.forceKill();
  for (const controller of liveRuns.values()) controller.abort();
  active = null;
}
