import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';

jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));
jest.mock('../../ipc/app-advisor', () => ({
  ...jest.requireActual<typeof AppAdvisorIpcModule>('../../ipc/app-advisor'),
  routeRendererToolRequest: jest.fn(() => null),
  requestAppAdvisorRendererTool: jest.fn(),
}));
jest.mock('../presentation-state', () => ({
  capturePresentationTurn: (): { source: 'user' } => ({ source: 'user' }),
  showFilesPresentationPolicy: (): { presentation: 'foreground' } => ({
    presentation: 'foreground',
  }),
}));
jest.mock('../../browser/browser-handoffs', () => ({
  browserHandoffs: { snapshot: (): object => ({}) },
}));

import {
  InterfaceToolRegistry,
  type InterfaceToolCall,
} from '@canopy/core-runtime/node/client';
import {
  interfaceToolDescriptor,
  type InterfaceToolName,
} from '@canopy/protocol/canopy-core';
import {
  requestAppAdvisorRendererTool,
  routeRendererToolRequest,
} from '../../ipc/app-advisor';
import {
  setInterfaceToolAudienceResolver,
  setSessionInterfaceToolRegistry,
} from '../../agents/interface-tool-binding';
import { openShareDialog } from '../sharing-runtime';
import { windowAgentInterfacePort } from '../../agents/agent-interface-port';
import type { WorktreeActionRuntime } from '../worktree-actions';

const routeRequest = jest.mocked(routeRendererToolRequest);
const windowRequest = jest.mocked(requestAppAdvisorRendererTool);

const shareAction = {
  type: 'sharing.open_dialog',
  target: { kind: 'skill', name: 'deploy', sourceId: 'custom:app' },
} as const;

function runtime(): WorktreeActionRuntime & { getWindow: jest.Mock } {
  return {
    projectId: 'proj',
    worktreeId: 'wt',
    chatId: 'chat-1',
    cwd: '/worktrees/proj/wt',
    getWindow: jest.fn((): null => null),
    interfacePort: windowAgentInterfacePort(() => null),
  };
}

function mainLease(
  tools: readonly InterfaceToolName[],
  audience?: string,
): {
  registry: InterfaceToolRegistry;
  calls: InterfaceToolCall[];
} {
  const registry = new InterfaceToolRegistry();
  const calls: InterfaceToolCall[] = [];
  registry.openLease(
    { leaseId: 'main-1', surface: 'main', interfaceKind: 'desktop', audience },
    {
      deliver: (call) => {
        calls.push(call);
        return true;
      },
      cancel: () => undefined,
    },
  );
  registry.register('main-1', {
    tools: tools.map((name) => interfaceToolDescriptor(name)),
    _meta: { idempotencyKey: 'main-1-tools' },
  });
  setSessionInterfaceToolRegistry(registry);
  return { registry, calls };
}

async function delivered(
  calls: InterfaceToolCall[],
): Promise<InterfaceToolCall> {
  for (let attempt = 0; attempt < 20 && calls.length === 0; attempt++)
    await new Promise((resolve) => setImmediate(resolve));
  const call = calls[0];
  if (!call) throw new Error('no call delivered');
  return call;
}

beforeEach(() => {
  routeRequest.mockReset();
  routeRequest.mockReturnValue(null);
  windowRequest.mockReset();
});
afterEach(() => {
  setSessionInterfaceToolRegistry(null);
  setInterfaceToolAudienceResolver(null);
});

describe('worktree chat presentation through interface leases (CAN-5830)', () => {
  it('the share dialog reaches only the main window lease', async () => {
    const lease = mainLease(['ui.app_advisor.present', 'ui.show_files']);
    const chat = runtime();

    const pending = openShareDialog(shareAction, chat);
    const call = await delivered(lease.calls);
    expect(call.toolName).toBe('ui.app_advisor.present');
    expect(call.input).toEqual({
      action: shareAction,
      originWorktreeId: 'wt',
      originProjectId: 'proj',
      originChatTabId: 'chat-1',
    });
    lease.registry.reply('main-1', call.callId, {
      requestId: call.callId,
      ok: true,
    });

    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: {
        message: 'Share dialog requested; the user confirms in the app.',
      },
    });
    expect(windowRequest).not.toHaveBeenCalled();
    expect(chat.getWindow).not.toHaveBeenCalled();
  });

  it('with no lease the share dialog is unavailable and nothing opens', async () => {
    const lease = mainLease(['ui.show_files']);
    const chat = runtime();

    const response = await openShareDialog(shareAction, chat);

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(lease.calls).toHaveLength(0);
    expect(windowRequest).not.toHaveBeenCalled();
    expect(chat.getWindow).not.toHaveBeenCalled();
  });

  it("a remote-driven chat uses its controller's lease with no local window", async () => {
    const lease = mainLease(['ui.app_advisor.present'], 'controller-a');
    setInterfaceToolAudienceResolver(() => 'controller-a');
    const chat = runtime();

    const pending = openShareDialog(shareAction, chat);
    const call = await delivered(lease.calls);
    lease.registry.reply('main-1', call.callId, {
      requestId: call.callId,
      ok: true,
    });

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(windowRequest).not.toHaveBeenCalled();
    expect(chat.getWindow).not.toHaveBeenCalled();
  });

  it('a remote-driven chat cannot use the local window lease', async () => {
    const lease = mainLease(['ui.app_advisor.present']);
    setInterfaceToolAudienceResolver(() => 'controller-a');

    await expect(
      openShareDialog(shareAction, runtime()),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(lease.calls).toHaveLength(0);
    expect(windowRequest).not.toHaveBeenCalled();
  });
});
