/** @jest-environment jsdom */
/**
 * CAN-6937: the desktop unlock reads the account before checkout reads the
 * navigation context, and checkout bills that context. A switch to another
 * workspace during the account read must stop the unlock, or checkout opens
 * for the new context's owner instead of the one the user was looking at.
 * Local and cloud chats share this unlock.
 */
import { unlockModels } from '../openBillingPage';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

const ACCOUNT = {
  hasApiKey: true,
  connected: true,
  account: { id: 'account-1', isGuest: false },
};

/** `window.api` with a held account read; every other call answers nothing. */
function heldAccountRead(): {
  readonly load: jest.Mock;
  readonly release: () => void;
} {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const load = jest.fn(() => held.then(() => ACCOUNT));
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: new Proxy(
      { loadCanopyCloudAccount: load },
      {
        get: (target, key): unknown =>
          key === 'loadCanopyCloudAccount'
            ? target.loadCanopyCloudAccount
            : (): Promise<undefined> => Promise.resolve(undefined),
      },
    ),
  });
  return { load, release };
}

beforeEach(() => {
  useWorkspaceContextStore.setState((store) => ({
    hydrated: true,
    state: { ...store.state, context: { kind: 'personal' } },
  }));
});

it('stops an unlock whose navigation context changed while it read the account', async () => {
  const { load, release } = heldAccountRead();
  const result = unlockModels(undefined, { source: 'desktop' });
  useWorkspaceContextStore.setState((store) => ({
    state: {
      ...store.state,
      context: { kind: 'organization', organizationId: 'org-2' },
    },
  }));
  release();
  await expect(result).resolves.toEqual({ outcome: 'failed' });
  // Checkout never started for the new context: it reads the account again.
  expect(load).toHaveBeenCalledTimes(1);
});

it('goes on to checkout when the context is unchanged', async () => {
  const { load, release } = heldAccountRead();
  const result = unlockModels(undefined, { source: 'desktop' });
  release();
  await result;
  expect(load).toHaveBeenCalledTimes(2);
});
