/** @jest-environment jsdom */
/**
 * Harness setup from a remote controller (CAN-6718, review L4): a Codex
 * sign-in dialog acts only on the attempt its own start returned. Another
 * window's attempt (a controller's, or this computer's) neither opens its
 * page here nor closes this dialog.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodexLoginState } from '@canopy/desktop-shared/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockOpenLink = jest.fn();
jest.mock('@/lib/remote-control/open-sign-in-link', () => ({
  isRemoteSignIn: (): boolean => true,
  openSignInLink: (url: string): void => {
    mockOpenLink(url);
  },
}));

import { CodexLoginModal } from '../CodexLoginModal';

let root: Root;
let container: HTMLDivElement;
let push: (state: CodexLoginState) => void = () => undefined;
let start: jest.Mock;

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

const foreignWaiting: CodexLoginState = {
  attemptId: 'other-window',
  phase: 'waiting',
  activeWorkCount: 0,
  method: 'chatgptDeviceCode',
  userCode: 'ABCD-1234',
  verificationUrl: 'https://auth.openai.com/codex/device',
};

beforeEach(() => {
  mockOpenLink.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  start = jest.fn();
  Object.assign(window, {
    api: {
      codexLogin: {
        start,
        cancel: jest.fn(() =>
          Promise.resolve({
            attemptId: null,
            phase: 'ready',
            activeWorkCount: 0,
          }),
        ),
        retryVerification: jest.fn(),
        openBrowser: jest.fn(() => Promise.resolve()),
        onState: (listener: typeof push): (() => void) => {
          push = listener;
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
        onUpdate: (): (() => void) => () => undefined,
      },
    },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('ignores another window’s attempt after its own start was refused', async () => {
  // Main answers a busy start with a refusal; a thrown error would reach the
  // dialog as generic copy.
  start.mockResolvedValue({
    attemptId: null,
    phase: 'ready',
    activeWorkCount: 0,
    refusal: 'already-running',
  });
  const onClose = jest.fn();
  await act(async () => {
    root.render(<CodexLoginModal onClose={onClose} />);
    await Promise.resolve();
  });
  await flush();
  expect(document.body.textContent).toContain(
    'A Codex sign-in is already running on the computer. Try again when it finishes.',
  );
  act(() => push(foreignWaiting));
  await flush();
  expect(mockOpenLink).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain('ABCD-1234');
  act(() =>
    push({
      attemptId: 'other-window',
      phase: 'complete',
      activeWorkCount: 0,
      outcome: 'success',
    }),
  );
  await flush();
  expect(onClose).not.toHaveBeenCalled();
});

it('still follows its own attempt', async () => {
  start.mockResolvedValue({
    attemptId: 'mine',
    phase: 'waiting',
    activeWorkCount: 0,
    method: 'chatgptDeviceCode',
    userCode: 'MINE-0001',
    verificationUrl: 'https://auth.openai.com/codex/device',
  });
  const onClose = jest.fn();
  await act(async () => {
    root.render(<CodexLoginModal onClose={onClose} />);
    await Promise.resolve();
  });
  await flush();
  expect(mockOpenLink).toHaveBeenCalledWith(
    'https://auth.openai.com/codex/device',
  );
  act(() => push(foreignWaiting));
  await flush();
  expect(document.body.textContent).toContain('MINE-0001');
  act(() =>
    push({
      attemptId: 'mine',
      phase: 'complete',
      activeWorkCount: 0,
      outcome: 'success',
    }),
  );
  await flush();
  expect(onClose).toHaveBeenCalled();
});

// CAN-6718 review: the controlled computer checks the page before it
// publishes it, and this computer checks again before opening it, so a
// host that sends another address never opens it here.
it('opens only an OpenAI sign-in page from the other computer', async () => {
  start.mockResolvedValue({
    attemptId: 'mine',
    phase: 'waiting',
    activeWorkCount: 0,
    method: 'chatgptDeviceCode',
    userCode: 'MINE-0002',
    verificationUrl: 'https://auth.openai.com.example.net/codex/device',
  });
  await act(async () => {
    root.render(<CodexLoginModal onClose={jest.fn()} />);
    await Promise.resolve();
  });
  await flush();
  expect(mockOpenLink).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(
    "The other computer sent a sign-in page that isn't OpenAI's, so it wasn't opened.",
  );
});

// CAN-6718 review: the waiting state with the device code can arrive before
// the start answers; the dialog keeps it and applies it once the answer
// names its attempt.
it('keeps its attempt’s state pushed before the start answers', async () => {
  let answer: (state: CodexLoginState) => void = () => undefined;
  start.mockReturnValue(
    new Promise<CodexLoginState>((resolve) => {
      answer = resolve;
    }),
  );
  await act(async () => {
    root.render(<CodexLoginModal onClose={jest.fn()} />);
    await Promise.resolve();
  });
  act(() =>
    push({
      attemptId: 'mine',
      phase: 'waiting',
      activeWorkCount: 0,
      method: 'chatgptDeviceCode',
      userCode: 'EARL-0001',
      verificationUrl: 'https://auth.openai.com/codex/device',
    }),
  );
  act(() => push(foreignWaiting));
  await act(async () => {
    answer({
      attemptId: 'mine',
      phase: 'pausing',
      activeWorkCount: 0,
      method: 'chatgptDeviceCode',
    });
    await Promise.resolve();
  });
  await flush();
  expect(document.body.textContent).toContain('EARL-0001');
  expect(document.body.textContent).not.toContain('ABCD-1234');
  expect(mockOpenLink).toHaveBeenCalledWith(
    'https://auth.openai.com/codex/device',
  );
});

// CAN-6718 review: a retry after a failed attempt starts a new attempt while
// the dialog still knows the old one; its waiting state can also arrive
// before the start answers.
it('keeps a retry’s state pushed before its start answers', async () => {
  start.mockResolvedValueOnce({
    attemptId: 'old',
    phase: 'complete',
    activeWorkCount: 0,
    outcome: 'failed',
  });
  await act(async () => {
    root.render(<CodexLoginModal onClose={jest.fn()} />);
    await Promise.resolve();
  });
  await flush();
  let answer: (state: CodexLoginState) => void = () => undefined;
  start.mockReturnValueOnce(
    new Promise<CodexLoginState>((resolve) => {
      answer = resolve;
    }),
  );
  const retry = Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent === 'Try again',
  );
  act(() => retry?.click());
  act(() =>
    push({
      attemptId: 'new',
      phase: 'waiting',
      activeWorkCount: 0,
      method: 'chatgptDeviceCode',
      userCode: 'RTRY-0002',
      verificationUrl: 'https://auth.openai.com/codex/device',
    }),
  );
  await act(async () => {
    answer({
      attemptId: 'new',
      phase: 'pausing',
      activeWorkCount: 0,
      method: 'chatgptDeviceCode',
    });
    await Promise.resolve();
  });
  await flush();
  expect(retry).toBeDefined();
  expect(document.body.textContent).toContain('RTRY-0002');
});
