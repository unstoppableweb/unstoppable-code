import { assertAntigravityHarnessEnabled } from './feature-flag';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderProcess } from '@canopy/desktop-shared/node/provider-process/spawn';
import { openAntigravityTerminalLogin } from '@canopy/desktop-shared/node/antigravity/terminal-login';
import type { SignInTerminalEmitter } from '../sign-in-runs/sign-in-terminal';
import { assertSignInWorkerContext } from '../sign-in-runs/sign-in-worker-context';
import { spawnProviderProcess } from '../agent-runs/provider-process-host';
import {
  antigravityProfileDirectory,
  openAntigravityRuntime,
  prepareAntigravityProfile,
  type AntigravityRuntime,
} from './runtime';
import { invalidateAntigravityModels } from './models';

/**
 * How the person signs in:
 * - `browser`: ACP `oauth-personal`; the runtime opens this computer's
 *   browser with a loopback callback, so it only works at this computer.
 * - `paste-code`: the runtime's own `--login` flow prints a Google link that
 *   any computer can open and reads the code Google's page shows. Used when
 *   another computer started the sign-in through Remote Control.
 */
export type AntigravitySignInMode = 'browser' | 'paste-code';

/** The longest code or landing-page URL accepted before Enter. */
const MAX_CODE_LENGTH = 4096;

/**
 * The most one write may carry: a full code and its key sequences. A longer
 * write is not a pasted code and is ignored whole, so one write's work stays
 * bounded. IPC refuses anything over 16 KiB before it gets here.
 */
const MAX_WRITE_LENGTH = MAX_CODE_LENGTH * 2;

/** How long either mode waits for the person: browser mode's ACP deadline. */
const SIGN_IN_DEADLINE_MS = 600_000;

/** The most of the CLI's error output kept, and of its last line shown. */
const MAX_STDERR_LENGTH = 8192;
const MAX_ERROR_LINE_LENGTH = 300;

// eslint-disable-next-line no-control-regex -- the pattern is for them.
const ESCAPE_SEQUENCES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-_]/gu;
// eslint-disable-next-line no-control-regex -- the pattern is for them.
const CONTROLS = /[\u0000-\u001f\u007f]/gu;

/**
 * The CLI's last non-empty error line, as plain text. Once the code has been
 * tried it is spent, so the CLI's own reason holds no secret.
 */
function lastErrorLine(stderr: string): string | undefined {
  const lines = stderr
    .replace(ESCAPE_SEQUENCES, '')
    .split(/\r?\n|\r/u)
    .map((candidate) => candidate.replace(CONTROLS, '').trim())
    .filter((candidate) => candidate.length > 0);
  return lines[lines.length - 1]?.slice(0, MAX_ERROR_LINE_LENGTH);
}

/**
 * Where the line editor is inside a terminal key sequence: after `ESC`, in a
 * CSI (`ESC [` params, final byte `@`–`~`) or SS3 (`ESC O` plus one byte).
 */
type EscapeState = 'none' | 'escape' | 'csi' | 'ss3';

/** Adapts native personal sign-in to the existing recorded sign-in view. */
export class AntigravitySignIn {
  private readonly abort = new AbortController();
  private readonly sessionId: string;
  private readonly emitter: SignInTerminalEmitter;
  readonly mode: AntigravitySignInMode;
  private runtime: AntigravityRuntime | undefined;
  private login: ProviderProcess | undefined;
  private line = '';
  // The CLI spends a code once it tries it, so a sign-in sends one.
  private codeSent = false;
  private escape: EscapeState = 'none';
  private done = false;
  readonly exit: Promise<{ exitCode: number | null; signal: string | null }>;

  constructor(
    sessionId: string,
    emitter: SignInTerminalEmitter,
    mode: AntigravitySignInMode = 'browser',
  ) {
    assertSignInWorkerContext('AntigravitySignIn');
    assertAntigravityHarnessEnabled();
    this.sessionId = sessionId;
    this.emitter = emitter;
    this.mode = mode;
    this.exit = (async (): Promise<{
      exitCode: number | null;
      signal: string | null;
    }> => {
      let exitCode: number | null = 1;
      let signal: string | null = null;
      try {
        if (mode === 'paste-code') await this.pasteCodeSignIn();
        else await this.browserSignIn();
        this.abort.signal.throwIfAborted();
        invalidateAntigravityModels();
        this.output('Google sign-in completed.\r\n');
        exitCode = 0;
      } catch (error) {
        if (this.abort.signal.aborted) {
          exitCode = null;
          signal = 'cancelled';
        } else
          this.output(
            `${error instanceof Error ? error.message : 'Google sign-in failed.'}\r\n`,
          );
      } finally {
        try {
          await this.runtime?.close();
          await this.login?.stop();
        } catch {
          exitCode = 1;
        }
        this.done = true;
        emitter.exit({ sessionId, provider: 'antigravity', exitCode, signal });
      }
      return { exitCode, signal };
    })();
  }

  private output(data: string): void {
    this.emitter.output({ sessionId: this.sessionId, data });
  }

  private async signInDirectory(): Promise<string> {
    const cwd = join(antigravityProfileDirectory(), 'sign-in');
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    return cwd;
  }

  private async browserSignIn(): Promise<void> {
    this.output(
      'Sign in with your personal Google account in the browser. Antigravity on this computer will use the same account.\r\n',
    );
    const cwd = await this.signInDirectory();
    this.runtime = await openAntigravityRuntime({
      cwd,
      owner: { kind: 'discovery', id: this.sessionId },
      requestTimeoutMs: 600_000,
      onUpdate: (): void => undefined,
    });
    this.abort.signal.throwIfAborted();
    await this.runtime.client.authenticate(
      { methodId: 'oauth-personal' },
      this.abort.signal,
    );
  }

  private async pasteCodeSignIn(): Promise<void> {
    this.output(
      'Open the Google link below on the computer you are using and sign in with your personal Google account. Then paste the code Google shows here and press Enter.\r\n\r\n',
    );
    const cwd = await this.signInDirectory();
    const profile = await prepareAntigravityProfile();
    this.abort.signal.throwIfAborted();
    const login = await openAntigravityTerminalLogin({
      cwd,
      profile,
      spawnProcess: spawnProviderProcess,
      assertEnabled: assertAntigravityHarnessEnabled,
      owner: { kind: 'discovery', id: this.sessionId },
      signal: this.abort.signal,
    });
    this.login = login;
    if (this.abort.signal.aborted) void login.stop().catch(() => undefined);
    // The runtime writes plain lines to a pipe; the sign-in view is a
    // terminal, so line ends become carriage return plus line feed.
    login.stdout.setEncoding('utf8');
    login.stdout.on('data', (chunk: string) => {
      if (!this.done) this.output(chunk.replace(/\r?\n/g, '\r\n'));
    });
    // Kept only to name the CLI's reason if the sign-in fails.
    let stderr = '';
    login.stderr.setEncoding('utf8');
    login.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_LENGTH);
    });
    // Bounded like browser mode: the person, often on another computer, may
    // never paste a code, and nothing else would end the process.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let code: number | null;
    try {
      ({ code } = await Promise.race([
        new Promise<{ code: number | null }>((resolve, reject) => {
          login.once('error', reject);
          login.once('close', (closedCode: number | null) =>
            resolve({ code: closedCode }),
          );
        }),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => {
            // Settles the race first: the stop below may close at once.
            reject(new Error('Google sign-in timed out. Start it again.'));
            void login.stop().catch(() => undefined);
          }, SIGN_IN_DEADLINE_MS);
        }),
      ]));
    } finally {
      clearTimeout(deadline);
    }
    this.abort.signal.throwIfAborted();
    if (code !== 0) {
      const reason = lastErrorLine(stderr);
      throw new Error(
        reason
          ? `Google sign-in did not complete: ${reason}`
          : 'Google sign-in did not complete.',
      );
    }
  }

  get exited(): boolean {
    return this.done;
  }

  /**
   * Browser sign-in takes no input. Paste-code sign-in reads one line: a pipe
   * has no terminal to echo or edit it, so this keeps the line, echoes one
   * `*` per character (the echo reaches only the window that started the
   * sign-in), handles backspace, skips terminal key sequences such as arrows
   * and Home, and sends the line on Enter. One write's echo is one event.
   * It sends one code per sign-in and ignores input after it, so the window
   * that owns the sign-in can't flood the shared provider process host.
   */
  write(data: string): void {
    const stdin = this.login?.stdin;
    if (this.mode !== 'paste-code' || !stdin || this.done || this.codeSent)
      return;
    if (data.length > MAX_WRITE_LENGTH) return;
    let echo = '';
    for (const character of data) {
      if (this.skipsEscape(character)) continue;
      if (character === '\r' || character === '\n') {
        if (!this.line) continue;
        const line = this.line;
        this.line = '';
        this.codeSent = true;
        echo += '\r\n';
        stdin.write(`${line}\n`);
        break;
      } else if (character === '\x7f' || character === '\b') {
        if (!this.line) continue;
        this.line = this.line.slice(0, -1);
        echo += '\b \b';
      } else if (
        character >= ' ' &&
        character !== '\x7f' &&
        this.line.length < MAX_CODE_LENGTH
      ) {
        this.line += character;
        echo += '*';
      }
    }
    if (echo) this.output(echo);
  }

  /** Whether `character` belongs to a terminal key sequence, which is dropped. */
  private skipsEscape(character: string): boolean {
    switch (this.escape) {
      case 'none':
        if (character !== '\x1b') return false;
        this.escape = 'escape';
        return true;
      case 'escape':
        this.escape =
          character === '[' ? 'csi' : character === 'O' ? 'ss3' : 'none';
        return true;
      case 'csi':
        if (character >= '@' && character <= '~') this.escape = 'none';
        return true;
      case 'ss3':
        this.escape = 'none';
        return true;
    }
  }

  resize(_cols: number, _rows: number): void {
    void _cols;
    void _rows;
    /* No terminal process is used. */
  }

  stop(): void {
    this.abort.abort();
    this.runtime?.client.close();
    void this.login?.stop().catch(() => undefined);
  }

  forceKill(): void {
    this.stop();
  }
}
