/** @jest-environment jsdom */
import '../../cloud-chats/__tests__/jsdom-globals';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCapabilities } from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state/CanopyClientProvider';
import { CoworkTopBar } from '@/components/panels/CoworkTopBar';
import { webCoreScopeId } from '@/lib/chat-authority';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import {
  createDesktopCanopyClient,
  createDesktopCapabilities,
} from '../ipc-canopy-client';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// A reply that never arrives, usable as either a promise or a release
// function, so the bar renders from what it has on mount.
function pendingReply(): unknown {
  const never = (): Promise<never> => new Promise(() => {});
  return Object.assign(() => {}, {
    then: never,
    catch: never,
    finally: never,
  });
}

function bridge(): unknown {
  return new Proxy(() => pendingReply(), {
    get(_target, key) {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      return bridge();
    },
  });
}

for (const name of [
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
  Object.defineProperty(window, name, { value: bridge(), writable: true });
}

// Capabilities of the window itself, which hold for any chat it shows.
const WINDOW_CAPABILITIES: ReadonlySet<string> = new Set([
  'routing',
  'voice',
  'settingsScope',
  'imageClipboard',
  'accountOrganizationSettings',
  'referencePreviews',
  'cloudCapabilityLinks',
]);

/**
 * What the web core serves for a cloud chat (CAN-6175 R5, R6), and its
 * sandbox's files (R9). Its terminals (R10) follow their flag, off here.
 */
const SERVED_BY_WEB_CORE: ReadonlySet<string> = new Set([
  'chatThinkingLevel',
  'chatFastMode',
  'chatPluginSelections',
  // Uploads go through main's web core connection (R6).
  'chatAttachments',
  'fileSystemAccess',
]);

function grants(value: unknown): boolean {
  if (value === true) return true;
  // The lowest level of `fileSystemAccess` and `pipelines`.
  if (typeof value === 'string')
    return value !== 'none' && value !== 'read-only';
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.values(value).some(grants);
  }
  return false;
}

const desktop = createDesktopCapabilities('darwin', {}, {});
const localProject = 'cowork-project-1';
const cloudProject = webCoreScopeId('ws-1');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useStandaloneChatStore.setState({ activeWorkEntryId: 'entry-1' });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderTopBar(host: CanopyCapabilities, projectId: string): void {
  act(() => {
    root.render(
      <CanopyClientProvider client={createDesktopCanopyClient(host)}>
        <CoworkTopBar workspaceId={projectId} />
      </CanopyClientProvider>,
    );
  });
}

function offersOpenIn(): boolean {
  return container.querySelector('[data-testid^="worktree-open"]') !== null;
}

describe('desktop chat scope capabilities (CAN-6175)', () => {
  it('offers Open in for a local cowork project', () => {
    renderTopBar(desktop, localProject);
    expect(container.querySelector('[data-testid="cowork-top-bar"]')).not.toBe(
      null,
    );
    expect(offersOpenIn()).toBe(true);
  });

  it('hides Open in for a cloud cowork project, which has no local folder', () => {
    renderTopBar(desktop, cloudProject);
    expect(container.querySelector('[data-testid="cowork-top-bar"]')).not.toBe(
      null,
    );
    expect(offersOpenIn()).toBe(false);
  });

  it('fails closed: a cloud project gets nothing beyond the window, whatever the desktop adds', () => {
    const everything = {
      ...desktop,
      futureLocalFeature: true,
    } satisfies CanopyCapabilities & { futureLocalFeature: boolean };
    renderTopBar(everything, cloudProject);
    expect(offersOpenIn()).toBe(false);

    const cloud =
      createDesktopCanopyClient(everything).capabilitiesFor?.(cloudProject);
    const leaked = Object.entries(cloud ?? {})
      .filter(
        ([key, value]) =>
          !WINDOW_CAPABILITIES.has(key) &&
          !SERVED_BY_WEB_CORE.has(key) &&
          grants(value),
      )
      .map(([key]) => key);
    expect(cloud).toBeDefined();
    expect(leaked).toEqual([]);
    expect(cloud?.fileSystemAccess).toBe('read-write');
    expect(cloud?.terminalPty).toBe(false);
    // A cloud chat still sets this computer's skills, plugins and MCP
    // servers beside its catalog.
    expect(cloud?.cloudCapabilityLinks).toBe(true);
    for (const key of SERVED_BY_WEB_CORE)
      expect([key, grants(Reflect.get(cloud ?? {}, key))]).toEqual([key, true]);
  });
});
