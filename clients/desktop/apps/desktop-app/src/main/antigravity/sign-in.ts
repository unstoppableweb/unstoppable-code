import { assertAntigravityHarnessEnabled } from './feature-flag';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SignInTerminalEmitter } from '../sign-in-runs/sign-in-terminal';
import { assertSignInWorkerContext } from '../sign-in-runs/sign-in-worker-context';
import {
  antigravityProfileDirectory,
  openAntigravityRuntime,
  type AntigravityRuntime,
} from './runtime';
import { invalidateAntigravityModels } from './models';

/** Adapts native ACP personal sign-in to the existing recorded sign-in view. */
export class AntigravitySignIn {
  private readonly abort = new AbortController();
  private runtime: AntigravityRuntime | undefined;
  private done = false;
  readonly exit: Promise<{ exitCode: number | null; signal: string | null }>;

  constructor(sessionId: string, emitter: SignInTerminalEmitter) {
    assertSignInWorkerContext('AntigravitySignIn');
    assertAntigravityHarnessEnabled();
    this.exit = (async (): Promise<{
      exitCode: number | null;
      signal: string | null;
    }> => {
      let exitCode: number | null = 1;
      let signal: string | null = null;
      try {
        emitter.output({
          sessionId,
          data: 'Sign in with your personal Google account in the browser.\r\n',
        });
        const cwd = join(antigravityProfileDirectory(), 'sign-in');
        await mkdir(cwd, { recursive: true, mode: 0o700 });
        this.runtime = await openAntigravityRuntime({
          cwd,
          owner: { kind: 'discovery', id: sessionId },
          requestTimeoutMs: 600_000,
          onUpdate: (): void => undefined,
        });
        this.abort.signal.throwIfAborted();
        await this.runtime.client.authenticate(
          { methodId: 'oauth-personal' },
          this.abort.signal,
        );
        this.abort.signal.throwIfAborted();
        invalidateAntigravityModels();
        emitter.output({ sessionId, data: 'Google sign-in completed.\r\n' });
        exitCode = 0;
      } catch (error) {
        if (this.abort.signal.aborted) {
          exitCode = null;
          signal = 'cancelled';
        } else
          emitter.output({
            sessionId,
            data: `${error instanceof Error ? error.message : 'Google sign-in failed.'}\r\n`,
          });
      } finally {
        try {
          await this.runtime?.close();
        } catch {
          exitCode = 1;
        }
        this.done = true;
        emitter.exit({ sessionId, provider: 'antigravity', exitCode, signal });
      }
      return { exitCode, signal };
    })();
  }
  get exited(): boolean {
    return this.done;
  }
  write(_data: string): void {
    void _data;
    /* Google owns the browser interaction. */
  }
  resize(_cols: number, _rows: number): void {
    void _cols;
    void _rows;
    /* No terminal process is used. */
  }
  stop(): void {
    this.abort.abort();
    this.runtime?.client.close();
  }
  forceKill(): void {
    this.stop();
  }
}
