import { homedir } from 'node:os';
import { spawn as spawnPty, type IPty } from 'node-pty';
import type {
  AuthTerminalExitEvent,
  AuthTerminalOutputEvent,
} from '@canopy/desktop-shared/types';
import type { WorkerAgentSignInProvider } from '@canopy/protocol/canopy-core';
import {
  getBundledClaudeBinaryPath,
  getBundledGhBinaryPath,
  getEnhancedEnv,
} from '@canopy/execution-engine/pipelines/config-paths';
import { startWindowsProcessTreeKill } from '@canopy/execution-engine/node/lib/process-kill';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { assertSignInWorkerContext } from './sign-in-worker-context';

export type SignInTerminalProvider = Exclude<
  WorkerAgentSignInProvider,
  'codex'
>;

export const SIGN_IN_TERMINAL_SIGTERM_GRACE_MS = 1500;
const DEFAULT_LANG = 'en_US.UTF-8';

export interface SignInTerminalEmitter {
  output(event: AuthTerminalOutputEvent): void;
  exit(event: AuthTerminalExitEvent): void;
}

export interface SignInTerminalOptions {
  ptySpawn?: typeof spawnPty;
  getEnhancedEnvFn?: typeof getEnhancedEnv;
  getClaudeBinaryPath?: () => string;
  getGhBinaryPath?: () => string;
  /** Override for the working directory used when spawning login binaries. */
  homedirFn?: () => string;
  /** Override for the SIGTERM → SIGKILL grace period (ms). */
  sigtermGraceMs?: number;
}

export interface SignInTerminalInput {
  sessionId: string;
  provider: SignInTerminalProvider;
  cols: number;
  rows: number;
  verifiedOpenCodeExecutable?: string;
  emitter: SignInTerminalEmitter;
}

function tryKillPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function forceKillPtyTree(pty: IPty): void {
  if (Number.isInteger(pty.pid) && pty.pid > 0) {
    if (hostOperatingSystem() === 'win32') {
      startWindowsProcessTreeKill(pty.pid, true, () => pty.kill());
      return;
    }
    if (tryKillPid(-pty.pid, 'SIGKILL')) {
      return;
    }
    if (tryKillPid(pty.pid, 'SIGKILL')) {
      return;
    }
  }
  try {
    pty.kill();
  } catch {
    // best effort
  }
}

function destroyPtyIfAvailable(pty: IPty): void {
  if (!('destroy' in pty)) {
    return;
  }
  const destroy = pty.destroy;
  if (typeof destroy !== 'function') {
    return;
  }
  try {
    destroy.call(pty);
  } catch {
    // best effort
  }
}

/** The only commands a sign-in terminal may run (custody rule 4). */
export function signInCommandFor(
  provider: SignInTerminalProvider,
  paths: { claude: () => string; gh: () => string },
  verifiedOpenCodeExecutable?: string,
): { executable: string; args: string[] } {
  if (provider === 'antigravity')
    throw new Error('Google sign-in uses the native ACP authentication flow.');
  if (provider === 'claude')
    return { executable: paths.claude(), args: ['auth', 'login'] };
  if (provider === 'github')
    return { executable: paths.gh(), args: ['auth', 'login'] };
  if (!verifiedOpenCodeExecutable)
    throw new Error('OpenCode runtime must be verified before sign-in.');
  return { executable: verifiedOpenCodeExecutable, args: ['auth', 'login'] };
}

export class SignInTerminal {
  private readonly sessionId: string;
  private readonly provider: SignInTerminalProvider;
  private readonly emitter: SignInTerminalEmitter;
  private readonly sigtermGraceMs: number;
  private readonly pty: IPty;
  private dataDisposable: { dispose(): void } | null = null;
  private exitDisposable: { dispose(): void } | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private done = false;
  private resolveExit: (value: {
    exitCode: number | null;
    signal: string | null;
  }) => void = () => undefined;

  /** Resolves once with the exit, including forced cleanup. */
  readonly exit: Promise<{ exitCode: number | null; signal: string | null }>;

  constructor(input: SignInTerminalInput, options: SignInTerminalOptions = {}) {
    assertSignInWorkerContext('SignInTerminal');
    const { cols, rows } = input;
    if (!Number.isInteger(cols) || cols <= 0) {
      throw new Error('Invalid cols: must be a positive integer');
    }
    if (!Number.isInteger(rows) || rows <= 0) {
      throw new Error('Invalid rows: must be a positive integer');
    }
    this.sessionId = input.sessionId;
    this.provider = input.provider;
    this.emitter = input.emitter;
    this.sigtermGraceMs =
      options.sigtermGraceMs ?? SIGN_IN_TERMINAL_SIGTERM_GRACE_MS;
    this.exit = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    const provider = input.provider;
    const { executable, args } = signInCommandFor(
      provider,
      {
        claude: options.getClaudeBinaryPath ?? getBundledClaudeBinaryPath,
        gh: options.getGhBinaryPath ?? getBundledGhBinaryPath,
      },
      input.verifiedOpenCodeExecutable,
    );
    // Auth login shells should not inherit user-configured Canopy
    // environments. The github (`gh auth login`) flow also must not inject the
    // Canopy-managed PAT as GH_TOKEN because gh refuses interactive login when
    // a token is already present.
    const enhancedEnv = (options.getEnhancedEnvFn ?? getEnhancedEnv)({
      environment: false,
      ...(['github', 'opencode'].includes(provider)
        ? { includeCanopySecrets: false }
        : {}),
    });
    const env = {
      ...enhancedEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: enhancedEnv.LANG ?? DEFAULT_LANG,
      // Claude Code opens the system browser with its localhost callback URL,
      // so sign-in finishes without pasting a code; overriding BROWSER would
      // discard that URL. E2E builds must never open an OS browser. GitHub's
      // device flow also keeps its defaults.
      ...((provider === 'claude' && !__CANOPY_E2E__) || provider === 'github'
        ? {}
        : { BROWSER: 'echo' }),
    };

    const pty = (options.ptySpawn ?? spawnPty)(executable, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: (options.homedirFn ?? homedir)(),
      env,
    });
    this.pty = pty;

    try {
      this.dataDisposable = pty.onData((data: string): void => {
        if (this.done) {
          return;
        }
        this.emitter.output({ sessionId: this.sessionId, data });
      });

      this.exitDisposable = pty.onExit((event): void => {
        this.finalize(
          event.exitCode,
          typeof event.signal === 'number' ? String(event.signal) : null,
        );
      });
    } catch (error) {
      this.done = true;
      this.disposeResources();
      forceKillPtyTree(pty);
      throw error;
    }
  }

  get exited(): boolean {
    return this.done;
  }

  write(data: string): void {
    if (this.done) {
      return;
    }
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.done) {
      return;
    }
    if (!Number.isInteger(cols) || cols <= 0) {
      return;
    }
    if (!Number.isInteger(rows) || rows <= 0) {
      return;
    }
    try {
      this.pty.resize(cols, rows);
    } catch {
      // Resizing a dying PTY can throw on some platforms; ignore.
    }
  }

  stop(): void {
    if (this.done) {
      return;
    }
    try {
      this.pty.kill('SIGTERM');
    } catch {
      // best effort
    }
    if (this.done) {
      return;
    }
    if (this.killTimer) {
      return;
    }
    const timer = setTimeout((): void => {
      this.killTimer = null;
      if (!this.done) {
        forceKillPtyTree(this.pty);
        this.finalize(null, 'forced-cleanup');
      }
    }, this.sigtermGraceMs);
    timer.unref?.();
    this.killTimer = timer;
  }

  forceKill(): void {
    forceKillPtyTree(this.pty);
    if (!this.done) {
      this.finalize(null, 'forced-cleanup');
    }
  }

  private finalize(exitCode: number | null, signal: string | null): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.disposeResources();
    this.resolveExit({ exitCode, signal });
    this.emitter.exit({
      sessionId: this.sessionId,
      provider: this.provider,
      exitCode,
      signal,
    });
  }

  private disposeResources(): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }

    try {
      this.dataDisposable?.dispose();
    } catch {
      // best effort
    }
    this.dataDisposable = null;

    try {
      this.exitDisposable?.dispose();
    } catch {
      // best effort
    }
    this.exitDisposable = null;

    destroyPtyIfAvailable(this.pty);
  }
}
