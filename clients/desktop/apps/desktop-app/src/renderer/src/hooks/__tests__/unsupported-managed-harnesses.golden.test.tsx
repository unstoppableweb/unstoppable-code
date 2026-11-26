/** @jest-environment jsdom */
/**
 * Harness setup from a remote controller (CAN-6718): the desktop picker says
 * a disconnected managed harness can't run on this computer instead of
 * offering a connect. Antigravity's answer reuses the window's manifest-only
 * host-support read, never the runtime status, which can resolve and hash
 * the CLI (CAN-6718's Linux change keeps picker mounts off it).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ModelPickerManagedHarness } from '@canopy/ui-shared/components';
import {
  antigravityPickerEntry,
  useUnsupportedManagedHarnesses,
} from '../useUnsupportedManagedHarnesses';

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const status = jest.fn(() => Promise.resolve({ supported: true }));
const hostSupported = jest.fn(() => Promise.resolve(true));
const cursorStatus = jest.fn(() => Promise.resolve({ supported: false }));

let root: Root;
let container: HTMLDivElement;
let seen: ReadonlySet<ModelPickerManagedHarness> = new Set();

function Probe(props: {
  harnesses: readonly ModelPickerManagedHarness[];
}): null {
  seen = useUnsupportedManagedHarnesses(props.harnesses);
  return null;
}

beforeEach(() => {
  Object.defineProperty(window, 'platform', {
    configurable: true,
    value: 'linux',
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      antigravityRuntime: { status, hostSupported },
      cursorConnection: { status: cursorStatus },
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('answers Antigravity from host support, never the runtime status', async () => {
  await act(async () => {
    root.render(<Probe harnesses={['antigravity', 'cursor']} />);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
  expect(status).not.toHaveBeenCalled();
  expect(hostSupported).toHaveBeenCalledTimes(1);
  expect([...seen]).toEqual(['cursor']);
});

// CAN-6718 review round 9: host support must not hide the Antigravity entry
// itself, or a computer without a pinned CLI never says why.
it('lists Antigravity with its reason on a host without a pinned CLI, once support answers', () => {
  expect(
    antigravityPickerEntry({
      hostSupport: false,
      released: true,
      available: false,
    }),
  ).toEqual({ listed: true, unsupported: true });
  expect(
    antigravityPickerEntry({
      hostSupport: undefined,
      released: true,
      available: false,
    }),
  ).toEqual({ listed: false, unsupported: false });
  expect(
    antigravityPickerEntry({
      hostSupport: true,
      released: true,
      available: false,
    }),
  ).toEqual({ listed: true, unsupported: false });
  expect(
    antigravityPickerEntry({
      hostSupport: false,
      released: false,
      available: false,
    }),
  ).toEqual({ listed: false, unsupported: true });
});
