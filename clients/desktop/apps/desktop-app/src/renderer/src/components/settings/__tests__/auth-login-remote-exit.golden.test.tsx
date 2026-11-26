/** @jest-environment jsdom */
/**
 * Harness setup from a remote controller (CAN-6718, review L1): a Claude
 * sign-in a controlling computer drives keeps Claude's "exit 0 only on
 * success" rule and its `Login failed: …` detail; only the UI mode
 * (terminal first) differs from a sign-in on this computer.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let remote = true;
jest.mock('@/lib/remote-control/open-sign-in-link', () => ({
  isRemoteSignIn: (): boolean => remote,
  openSignInLink: (): void => undefined,
}));
const disposable = { dispose: (): void => undefined };
jest.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    write(): void {}
    dispose(): void {}
    getSelection(): string {
      return '';
    }
    onData(): typeof disposable {
      return disposable;
    }
    onSelectionChange(): typeof disposable {
      return disposable;
    }
    onScroll(): typeof disposable {
      return disposable;
    }
    onResize(): typeof disposable {
      return disposable;
    }
    onKey(): typeof disposable {
      return disposable;
    }
    resize(): void {}
    clearSelection(): void {}
    registerLinkProvider(): typeof disposable {
      return disposable;
    }
    attachCustomKeyEventHandler(): void {}
  },
}));
jest.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
jest.mock('@canopy/ui-app/terminal', () => ({
  installTerminalLinks: (): (() => void) => () => undefined,
  TERMINAL_BG_COLOR: '#000',
  TERMINAL_THEME: {},
}));

import { AuthLoginModal } from '../AuthLoginModal';

/** What `claude auth login` prints when it rejects the pasted code. */
const CLAUDE_CLI = {
  failureLine: 'Login failed: The code was not accepted.',
};

let root: Root;
let container: HTMLDivElement;
let emitOutput: (event: { sessionId: string; data: string }) => void;
let emitExit: (event: { sessionId: string; exitCode: number }) => void;

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const signedIn = {
    authenticated: true,
    accountLabel: 'old@example.com',
    email: 'old@example.com',
  };
  Object.assign(window, {
    api: {
      getClaudeAuthStatus: jest.fn(() => Promise.resolve(signedIn)),
      getModelRegistry: jest.fn(() => Promise.resolve({ antigravity: [] })),
      authTerminal: {
        start: jest.fn(() => Promise.resolve({ sessionId: 's1' })),
        stop: jest.fn(() => Promise.resolve()),
        write: jest.fn(() => Promise.resolve()),
        resize: jest.fn(() => Promise.resolve()),
        onOutput: (listener: typeof emitOutput): (() => void) => {
          emitOutput = listener;
          return () => undefined;
        },
        onExit: (listener: typeof emitExit): (() => void) => {
          emitExit = listener;
          return () => undefined;
        },
      },
      observability: {
        loadSnapshot: jest.fn(() =>
          Promise.resolve({
            recentEntries: [],
            usage: { providers: [], accountSnapshots: [] },
          }),
        ),
        onEntry: (): (() => void) => () => undefined,
        onUpdate: (): (() => void) => () => undefined,
        onUsageUpdated: (): (() => void) => () => undefined,
      },
    },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it.each([true, false])(
  'a Claude sign-in that exits 1 stays open with its failure line (remote: %s)',
  async (isRemote) => {
    remote = isRemote;
    const onClose = jest.fn();
    await act(async () => {
      root.render(<AuthLoginModal provider="claude" onClose={onClose} />);
      await Promise.resolve();
    });
    await flush();
    act(() => {
      emitOutput({
        sessionId: 's1',
        data: `${CLAUDE_CLI.failureLine}\r\n`,
      });
      emitExit({ sessionId: 's1', exitCode: 1 });
    });
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(CLAUDE_CLI.failureLine);
  },
);

// CAN-6718 review: the failed view keeps Antigravity's own reason, which the
// paste-code sign-in prints as its last line, instead of a generic failure.
it('a failed Antigravity sign-in shows the reason it printed', async () => {
  remote = true;
  const reason =
    'Google sign-in did not complete: invalid_grant: Malformed auth code.';
  await act(async () => {
    root.render(<AuthLoginModal provider="antigravity" onClose={jest.fn()} />);
    await Promise.resolve();
  });
  await flush();
  act(() => {
    emitOutput({ sessionId: 's1', data: 'Paste the code: ********' });
    emitOutput({ sessionId: 's1', data: '\r\n' });
    emitOutput({ sessionId: 's1', data: `\x1b[31m${reason}\x1b[0m\r\n` });
    emitExit({ sessionId: 's1', exitCode: 1 });
  });
  await flush();
  // The failed view replaces the terminal, so the reason shows only there.
  expect(document.body.textContent).toContain(reason);
});

// CAN-6718 review round 12: an older Google credential still on the host
// lists models, so a model check alone would close a sign-in the CLI
// rejected. Antigravity, like Claude, succeeds only on exit 0.
it.each([true, false])(
  'a failed Antigravity sign-in stays open with its reason while an older sign-in lists models (remote: %s)',
  async (isRemote) => {
    remote = isRemote;
    Object.assign(window.api, {
      getModelRegistry: jest.fn(() =>
        Promise.resolve({ antigravity: [{ id: 'gemini-3-pro' }] }),
      ),
    });
    const reason = 'Google sign-in did not complete: invalid_grant: Bad code.';
    const onClose = jest.fn();
    await act(async () => {
      root.render(<AuthLoginModal provider="antigravity" onClose={onClose} />);
      await Promise.resolve();
    });
    await flush();
    act(() => {
      emitOutput({ sessionId: 's1', data: `${reason}\r\n` });
      emitExit({ sessionId: 's1', exitCode: 1 });
    });
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(reason);
  },
);

it('an Antigravity sign-in that exits 0 with models closes', async () => {
  remote = true;
  Object.assign(window.api, {
    getModelRegistry: jest.fn(() =>
      Promise.resolve({ antigravity: [{ id: 'gemini-3-pro' }] }),
    ),
  });
  const onClose = jest.fn();
  await act(async () => {
    root.render(<AuthLoginModal provider="antigravity" onClose={onClose} />);
    await Promise.resolve();
  });
  await flush();
  act(() => {
    emitExit({ sessionId: 's1', exitCode: 0 });
  });
  await flush();
  expect(onClose).toHaveBeenCalled();
});

// CAN-6718 review: a sign-in can print, and even exit, before its start
// answers; the dialog keeps those events and replays its own once the
// answer names the session.
it('replays output and exit that arrive before the start answers', async () => {
  remote = true;
  let answer: (value: { sessionId: string }) => void = () => undefined;
  Object.assign(window.api.authTerminal, {
    start: jest.fn(
      () =>
        new Promise<{ sessionId: string }>((resolve) => {
          answer = resolve;
        }),
    ),
  });
  const reason = 'Google sign-in did not complete: early failure.';
  await act(async () => {
    root.render(<AuthLoginModal provider="antigravity" onClose={jest.fn()} />);
    await Promise.resolve();
  });
  await flush();
  act(() => {
    emitOutput({ sessionId: 'other', data: 'Not this one.\r\n' });
    emitOutput({ sessionId: 's9', data: `${reason}\r\n` });
    emitExit({ sessionId: 's9', exitCode: 1 });
  });
  await act(async () => {
    answer({ sessionId: 's9' });
    await Promise.resolve();
  });
  await flush();
  expect(document.body.textContent).toContain(reason);
  expect(document.body.textContent).not.toContain('Not this one.');
});
