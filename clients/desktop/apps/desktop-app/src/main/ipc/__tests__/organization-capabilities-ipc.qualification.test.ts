/**
 * The organization layer over IPC (CAN-6237): organization-capabilities:get-layer
 * answers a chat target with the layer its turn resolves, read through the same
 * service, workspace id and connector scope, so the desktop composer and pickers
 * show what the agent loads. App-managed surfaces and workspaces with no layer
 * answer null; a bad id is refused before anything is read.
 * organization-capabilities:layer-changed forwards each changed workspace to
 * every open window.
 */
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { parseOrganizationLayerView } from '@canopy/desktop-shared/lib/organization-capabilities';

const mockHandlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => Promise<unknown>
>();
const mockSent: { channel: string; payload: unknown }[] = [];
const mockReads: { workspaceId: string; scope: unknown }[] = [];
const mockListeners: ((workspaceId: string) => void)[] = [];
const ORG = 'org-acme';
const owner = { type: 'organization' as const, organizationId: ORG };
const layer = {
  collectionIds: [],
  skillRefs: [{ sourceId: `org:${ORG}`, skillName: 'review-1a2b3c4d', owner }],
  pluginRefs: [],
  mcpServerRefs: [],
};
let mockLayer: unknown = {
  layer,
  allowed: { organizationId: ORG, selections: layer },
  items: [
    {
      name: 'Review',
      source: 'organization',
      ref: {
        kind: 'skill',
        sourceId: `org:${ORG}`,
        skillName: 'review-1a2b3c4d',
      },
    },
  ],
};

jest.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: (): unknown[] => [
      { isDestroyed: (): boolean => false, webContents: {} },
    ],
  },
}));
jest.mock('../register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => Promise<unknown>,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));
jest.mock('../../lib/web-contents-send', () => ({
  sendToWebContents: (
    _contents: unknown,
    channel: string,
    payload: unknown,
  ): void => {
    mockSent.push({ channel, payload });
  },
}));
jest.mock('../../organization-capabilities/service', () => ({
  organizationLayerForWorkspace: (
    workspaceId: string,
    scope: unknown,
  ): Promise<unknown> => {
    mockReads.push({ workspaceId, scope });
    return Promise.resolve(mockLayer);
  },
  // The flag watch that removes organization Agent copies (phase 10a) is
  // started with the handlers; this test covers the layer channels only.
  watchOrganizationAgentsFlag: (): (() => void) => () => undefined,
  // Registered as the Agent gate (phase 10a); not exercised here.
  organizationAgentAllowed: (): Promise<boolean> => Promise.resolve(true),
  subscribeOrganizationLayerChanged: (
    listener: (workspaceId: string) => void,
  ): (() => void) => {
    mockListeners.push(listener);
    return () => undefined;
  },
}));
jest.mock('../../plugins/connector-scope', () => ({
  resolveCachedConnectorScope: (): Promise<unknown> =>
    Promise.resolve({
      kind: 'org-project',
      organizationId: ORG,
      orgProjectId: 'project-1',
    }),
}));
jest.mock('../../plugins/plugin-defaults-revision', () => ({
  pluginDefaultsWorkspaceId: (target: {
    projectId: string;
    worktreeId: string;
  }): string => `ws:${target.projectId}`,
}));

import { registerOrganizationCapabilitiesHandlers } from '../organization-capabilities';

function getLayer(...args: unknown[]): Promise<unknown> {
  const handler = mockHandlers.get(
    IPC_CHANNELS.organizationCapabilitiesGetLayer,
  );
  if (!handler) throw new Error('organization-capabilities:get-layer');
  return handler({}, ...args);
}

describe('organization-capabilities IPC (CAN-6237)', () => {
  beforeAll(() => registerOrganizationCapabilitiesHandlers());

  it('answers a chat with the layer its turn resolves, in the shape the renderer reads', async () => {
    const view = await getLayer('project-1', 'worktree-1');
    expect(mockReads.at(-1)).toEqual({
      workspaceId: 'ws:project-1',
      scope: {
        kind: 'org-project',
        organizationId: ORG,
        orgProjectId: 'project-1',
      },
    });
    expect(parseOrganizationLayerView(view)).toEqual({
      organizationId: ORG,
      layer,
      items: [
        {
          name: 'Review',
          source: 'organization',
          ref: {
            kind: 'skill',
            sourceId: `org:${ORG}`,
            skillName: 'review-1a2b3c4d',
          },
        },
      ],
    });
  });

  it('answers null without a layer or on an app-managed surface', async () => {
    mockLayer = undefined;
    expect(await getLayer('project-1', 'worktree-1')).toBeNull();
    const reads = mockReads.length;
    expect(await getLayer(APP_ADVISOR_PROJECT_ID, 'worktree-1')).toBeNull();
    expect(mockReads).toHaveLength(reads);
  });

  it('refuses a bad id before reading', async () => {
    const reads = mockReads.length;
    await expect(getLayer('../escape', 'worktree-1')).rejects.toThrow();
    await expect(getLayer('project-1', 42)).rejects.toThrow();
    expect(mockReads).toHaveLength(reads);
  });

  it('organization-capabilities:layer-changed tells every window which workspace changed', () => {
    for (const listener of mockListeners) listener('ws:project-1');
    expect(mockSent).toEqual([
      {
        channel: IPC_CHANNELS.organizationCapabilitiesLayerChanged,
        payload: 'ws:project-1',
      },
    ]);
  });
});
