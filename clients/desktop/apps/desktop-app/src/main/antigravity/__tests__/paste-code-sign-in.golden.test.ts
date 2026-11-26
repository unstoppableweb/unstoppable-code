/**
 * Antigravity's paste-code sign-in (CAN-6718), which another computer starts
 * through Remote Control: `antigravity acp --login` over pipes. Its line
 * editor sends exactly the code the person typed (terminal key sequences
 * such as arrows are dropped whole), echoes only `*`, names the CLI's own
 * reason on failure, and a sign-in whose code never arrives is stopped by its
 * 600-second setTimeout deadline, the browser sign-in's bound.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

jest.mock('../feature-flag', () => ({
  assertAntigravityHarnessEnabled: (): void => undefined,
}));
jest.mock('../../sign-in-runs/sign-in-worker-context', () => ({
  assertSignInWorkerContext: (): void => undefined,
}));
jest.mock('../../agent-runs/provider-process-host', () => ({
  spawnProviderProcess: jest.fn(),
}));
jest.mock('node:fs/promises', () => ({
  mkdir: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../runtime', () => ({
  antigravityProfileDirectory: (): string => '/profile',
  prepareAntigravityProfile: (): Promise<string> => Promise.resolve('/profile'),
  openAntigravityRuntime: jest.fn(),
}));
jest.mock('../models', () => ({
  invalidateAntigravityModels: (): void => undefined,
}));

class FakeLogin extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: string[] = [];
  readonly stdin = {
    write: (data: string): boolean => {
      this.written.push(data);
      return true;
    },
  };
  readonly stop = jest.fn((): Promise<void> => {
    this.emit('close', null, 'SIGTERM');
    return Promise.resolve();
  });
}

let login: FakeLogin;
jest.mock('@canopy/desktop-shared/node/antigravity/terminal-login', () => ({
  openAntigravityTerminalLogin: (): Promise<FakeLogin> =>
    Promise.resolve(login),
}));

import { AntigravitySignIn } from '../sign-in';

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function start(): { signIn: AntigravitySignIn; output: string[] } {
  const output: string[] = [];
  const signIn = new AntigravitySignIn(
    'session-1',
    {
      output: ({ data }): void => {
        output.push(data);
      },
      exit: (): void => undefined,
    },
    'paste-code',
  );
  return { signIn, output };
}

beforeEach(() => {
  login = new FakeLogin();
});

it('swallows whole arrow, Home and End sequences instead of typing their tails', async () => {
  const { signIn, output } = start();
  await flush();
  output.length = 0;
  signIn.write('ab\x1b[Dc\x1b[H\x1bOHd\x1b[1;5C');
  // A sequence split across two writes is still one key.
  signIn.write('e\x1b[');
  signIn.write('Ff\r');
  expect(login.written).toEqual(['abcdef\n']);
  expect(output.join('')).not.toMatch(/[[\]OHDCF;]/u);
});

it('masks the echoed code', async () => {
  const { signIn, output } = start();
  await flush();
  output.length = 0;
  signIn.write('4/0Abc');
  signIn.write('\x7f');
  expect(output.join('')).toBe('******\b \b');
  signIn.write('\r');
  expect(login.written).toEqual(['4/0Ab\n']);
});

// CAN-6718 review: one write is processed in bounded time, and its echo is
// one output event, however much it carries.
it('echoes one write in one event and ignores a write too long to be a code', async () => {
  const { signIn, output } = start();
  await flush();
  output.length = 0;
  signIn.write('abc\x7fd');
  expect(output).toEqual(['***\b \b*']);
  signIn.write('x'.repeat(16_385));
  expect(output).toHaveLength(1);
  signIn.write('\r');
  expect(login.written).toEqual(['abd\n']);
});

// CAN-6718 review: the CLI spends a code once it tries it, so a sign-in
// sends one code. Later input, from the window that owns the sign-in or a
// flood of lines, never reaches the shared provider process host.
it('sends one code per sign-in and ignores input after it', async () => {
  const { signIn, output } = start();
  await flush();
  signIn.write('first\r');
  output.length = 0;
  signIn.write('second\r');
  signIn.write('third\rfourth\n');
  for (let i = 0; i < 100; i += 1) signIn.write('again\r');
  expect(login.written).toEqual(['first\n']);
  expect(output).toEqual([]);
});

it('stops a sign-in whose code never arrives after the browser-mode deadline', async () => {
  jest.useFakeTimers();
  try {
    const { signIn, output } = start();
    await flush();
    jest.advanceTimersByTime(599_999);
    await flush();
    expect(login.stop).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await flush();
    expect(login.stop).toHaveBeenCalled();
    await expect(signIn.exit).resolves.toEqual({ exitCode: 1, signal: null });
    expect(output.join('')).toContain('timed out');
  } finally {
    jest.useRealTimers();
  }
});

it('names the CLI’s own last error line when the sign-in fails', async () => {
  const { signIn, output } = start();
  await flush();
  login.stderr.write(
    'Exchanging code…\n\x1b[31mError: invalid_grant (Bad Request)\x1b[0m\n\n',
  );
  await flush();
  login.emit('close', 1, null);
  await expect(signIn.exit).resolves.toEqual({ exitCode: 1, signal: null });
  expect(output.join('')).toContain(
    'Google sign-in did not complete: Error: invalid_grant (Bad Request)',
  );
});
