/** @jest-environment jsdom */
import '../../../cloud-chats/__tests__/jsdom-globals';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanopyClientProvider } from '@canopy/app-state/CanopyClientProvider';
import type { WorktreeSelection } from '@canopy/desktop-shared/types';
import { webCoreScopeId } from '@/lib/chat-authority';
import {
  createDesktopCanopyClient,
  createDesktopCapabilities,
} from '@/client/ipc-canopy-client';
import { SharedActivityPanelAdapter } from '../SharedActivityPanelAdapter';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface BridgeCall {
  readonly path: string;
  readonly args: readonly unknown[];
}

const calls: BridgeCall[] = [];

// A reply that never arrives, usable as either a promise or a release
// function, so the rail shows exactly what it asks for on mount.
function pendingReply(): unknown {
  const never = (): Promise<never> => new Promise(() => {});
  return Object.assign(() => {}, {
    then: never,
    catch: never,
    finally: never,
  });
}

// Every preload bridge records its calls.
function recordingBridge(path: string): unknown {
  const call = (...args: unknown[]): unknown => {
    calls.push({ path, args });
    return pendingReply();
  };
  return new Proxy(call, {
    get(_target, key) {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      return recordingBridge(`${path}.${key}`);
    },
  });
}

for (const bridge of [
  'agents',
  'api',
  'appErrors',
  'bundles',
  'collections',
  'electron',
  'mcpServers',
  'pipelines',
  'plugins',
  'skills',
]) {
  Object.defineProperty(window, bridge, {
    value: recordingBridge(bridge),
    writable: true,
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  calls.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderRail(selection: WorktreeSelection): Promise<void> {
  const client = createDesktopCanopyClient(
    createDesktopCapabilities('darwin', {}, {}),
  );
  act(() => {
    root.render(
      <CanopyClientProvider client={client}>
        <SharedActivityPanelAdapter worktreeSelection={selection} />
      </CanopyClientProvider>,
    );
  });
  // Some loads start a microtask after mount.
  await act(() => Promise.resolve());
}

function callsCarrying(id: string): readonly string[] {
  return [
    ...new Set(
      calls
        .filter((call) => JSON.stringify(call.args).includes(id))
        .map((call) => call.path),
    ),
  ].sort();
}

describe('desktop activity rail by chat scope (CAN-6175)', () => {
  it('loads a local chat scope’s runs and cost', async () => {
    await renderRail({ projectId: 'cowork-project-1', worktreeId: 'entry-1' });
    expect(callsCarrying('entry-1')).toEqual(
      expect.arrayContaining([
        'api.cost.watchScope',
        'api.loadWorktreeHookRuns',
        'api.loadWorktreeScriptRuns',
      ]),
    );
  });

  it('sends no cloud chat scope to the local bridge', async () => {
    await renderRail({
      projectId: webCoreScopeId('ws-1'),
      worktreeId: webCoreScopeId('wt-1'),
    });
    expect(callsCarrying('web-core:')).toEqual([]);
  });
});
