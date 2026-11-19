/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CURSOR_APPROVAL_CHECK_PROJECT_ID,
  type ApprovalRequestEvent,
} from '@canopy/desktop-shared/types';
// Static import: a cold load of this module graph inside the test body counted
// against the 5s per-test timeout.
import { CursorApprovalCheck } from '../CursorApprovalCheck';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => undefined,
}));
jest.mock('@/lib/cursor-settings-actions', () => ({
  registerCursorSettingsAction: (): (() => void) => () => undefined,
}));

const CARD: ApprovalRequestEvent = {
  requestId: 'cursor-req-1',
  projectId: CURSOR_APPROVAL_CHECK_PROJECT_ID,
  worktreeId: 'cursor-check',
  chatId: 'cursor-check',
  provider: 'cursor',
  surface: 'non-chat',
  title: 'Create the check file',
  details: { kind: 'tool', toolName: 'Write' },
  policyRevision: 1,
};

let root: Root;
let container: HTMLDivElement;

function findButton(text: string): HTMLButtonElement | null {
  const match = Array.from(container.querySelectorAll('button')).find(
    (element) => element.textContent?.trim() === text,
  );
  return match instanceof HTMLButtonElement ? match : null;
}

function enabledButton(text: string): HTMLButtonElement | null {
  const match = findButton(text);
  return match && !match.disabled ? match : null;
}

async function drainMicrotasks(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function settle<T>(
  description: string,
  read: () => T | null,
): Promise<T> {
  for (let round = 0; round < 50; round += 1) {
    const value = read();
    if (value !== null) return value;
    await drainMicrotasks();
  }
  throw new Error(`Timed out waiting for ${description}`);
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('a refused stale allow keeps the still-live Cursor approval card', async () => {
  let deliver: (event: ApprovalRequestEvent) => void = () => undefined;
  const respond = jest.fn<Promise<boolean>, [unknown]>(() =>
    Promise.resolve(false),
  );
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: (): Promise<unknown> =>
        Promise.resolve({ cursorAgentPath: '/usr/local/bin/cursor-agent' }),
      cursorApprovalCheck: {
        available: (): Promise<boolean> => Promise.resolve(true),
        run: (): Promise<unknown> => new Promise(() => undefined),
        cancel: (): Promise<void> => Promise.resolve(),
      },
      approvals: {
        onRequest: (listener: (event: ApprovalRequestEvent) => void) => {
          deliver = listener;
          return (): void => undefined;
        },
        onCancelled: (): (() => void) => () => undefined,
        respond,
        pendingRequests: (): Promise<ApprovalRequestEvent[]> =>
          Promise.resolve([{ ...CARD, policyRevision: 2 }]),
      },
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<CursorApprovalCheck />);
  });

  const runButton = await settle(
    'an enabled Test Cursor approvals button',
    () => enabledButton('Test Cursor approvals'),
  );
  act(() => {
    runButton.click();
  });
  act(() => {
    deliver(CARD);
  });
  const staleAllow = await settle('the Allow once button', () =>
    findButton('Allow once'),
  );
  act(() => {
    staleAllow.click();
  });
  await drainMicrotasks();

  expect(respond).toHaveBeenCalledWith(
    expect.objectContaining({ policyRevision: 1 }),
  );
  expect(
    container.querySelector('[data-testid="tool-approval-card"]'),
  ).not.toBeNull();
  expect(container.textContent).not.toContain(
    'This approval is no longer pending.',
  );

  const liveAllow = await settle('the Allow once button', () =>
    findButton('Allow once'),
  );
  act(() => {
    liveAllow.click();
  });
  await drainMicrotasks();
  expect(respond).toHaveBeenLastCalledWith(
    expect.objectContaining({ policyRevision: 2 }),
  );
});
