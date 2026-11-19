import { BrowserWindow } from 'electron';
import { sendToWindowDetailed } from '../../lib/window-send';
import type * as WindowSendModule from '../../lib/window-send';

jest.mock('../../lib/window-send', () => ({
  ...jest.requireActual<typeof WindowSendModule>('../../lib/window-send'),
  sendToWindowDetailed: jest.fn(() => ({ delivered: true })),
}));

import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';

jest.mock('../../ipc/app-advisor', () => ({
  ...jest.requireActual<typeof AppAdvisorIpcModule>('../../ipc/app-advisor'),
  routeRendererToolRequest: jest.fn(() => null),
  requestAppAdvisorRendererTool: jest.fn(),
}));
jest.mock('../../canopy-tools/presentation-state', () => ({
  capturePresentationTurn: (): { source: 'user' } => ({ source: 'user' }),
  showFilesPresentationPolicy: (): { presentation: 'foreground' } => ({
    presentation: 'foreground',
  }),
}));
jest.mock('../../browser/browser-handoffs', () => ({
  browserHandoffs: { snapshot: (): object => ({}) },
}));
let mockBoundTools: readonly string[] = [];
jest.mock('../../agents/session-manager', () => ({
  getActiveSessionCapabilityProfile: (): {
    interfaceTools: readonly string[];
  } => ({
    interfaceTools: mockBoundTools,
  }),
}));
jest.mock('../../agent-messaging/creation-orchestration', () => ({
  dispatchAgentChatCreation: (): Promise<object> =>
    Promise.resolve({
      address: { projectId: 'proj', taskId: 'task', chatId: 'new-chat' },
    }),
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
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type AppAdvisorActionResponse,
} from '@canopy/desktop-shared/types';
import {
  getLatestAppAdvisorUiState,
  setLatestAppAdvisorUiState,
  requestAppAdvisorRendererTool,
  routeRendererToolRequest,
  surfaceUnavailableResponse,
  type RemoteAppAdvisorWindowHost,
  type AppAdvisorRendererToolSurfaces,
} from '../../ipc/app-advisor';
import {
  setInterfaceToolAudienceResolver,
  setSessionInterfaceToolRegistry,
} from '../../agents/interface-tool-binding';
import { dispatchLegacyChatCreation } from '../creation-adapters';
import { presentAppAdvisorAction } from '../presentation-tools';
import { executeAppAdvisorTool } from '../tool-executor';
import {
  createAppAdvisorToolRuntime,
  type AppAdvisorToolRuntimeSurfaces,
} from '../runtime';

const routeRequest = jest.mocked(routeRendererToolRequest);
const windowRequest = jest.mocked(requestAppAdvisorRendererTool);

const destination = {
  projectId: APP_ADVISOR_PROJECT_ID,
  worktreeId: APP_ADVISOR_WORKTREE_ID,
  chatId: 'advisor-chat',
};

function surfaces(): AppAdvisorToolRuntimeSurfaces & {
  getMainWindow: jest.Mock;
  openAppAdvisorWindow: jest.Mock;
  ensureAppAdvisorWindow: jest.Mock;
} {
  return {
    getMainWindow: jest.fn((): null => null),
    getAppAdvisorWindow: jest.fn((): null => null),
    openAppAdvisorWindow: jest.fn(() =>
      Promise.resolve({ open: false, focused: false }),
    ),
    ensureAppAdvisorWindow: jest.fn(() =>
      Promise.resolve({ open: false, focused: false }),
    ),
  };
}

interface Leases {
  registry: InterfaceToolRegistry;
  main: InterfaceToolCall[];
  advisor: InterfaceToolCall[];
}

function openLease(
  registry: InterfaceToolRegistry,
  leaseId: string,
  surface: 'main' | 'app-advisor',
  tools: readonly InterfaceToolName[],
): InterfaceToolCall[] {
  const delivered: InterfaceToolCall[] = [];
  registry.openLease(
    { leaseId, surface, interfaceKind: 'desktop' },
    {
      deliver: (call) => {
        delivered.push(call);
        return true;
      },
      cancel: () => undefined,
    },
  );
  registry.register(leaseId, {
    tools: tools.map((name) => interfaceToolDescriptor(name)),
    _meta: { idempotencyKey: `${leaseId}-tools` },
  });
  return delivered;
}

function leases(): Leases {
  const registry = new InterfaceToolRegistry();
  const main = openLease(registry, 'main-1', 'main', [
    'ui.app_advisor.present',
    'ui.show_files',
  ]);
  const advisor = openLease(registry, 'advisor-1', 'app-advisor', [
    'ui.app_advisor.show_files',
  ]);
  setSessionInterfaceToolRegistry(registry);
  return { registry, main, advisor };
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
  mockBoundTools = [];
  routeRequest.mockReset();
  routeRequest.mockReturnValue(null);
  windowRequest.mockReset();
});
afterEach(() => {
  setSessionInterfaceToolRegistry(null);
  setInterfaceToolAudienceResolver(null);
});

describe('App Advisor presentation through interface leases (CAN-4133)', () => {
  it('a presentation action reaches only the serving lease', async () => {
    const lease = leases();
    mockBoundTools = ['ui.app_advisor.present'];

    const pending = presentAppAdvisorAction({
      action: { type: 'navigation.go_to_page', page: 'workflows' },
      requestId: 'r1',
      expectedUiRevision: 4,
      destination,
    });
    const call = await delivered(lease.main);
    expect(call.toolName).toBe('ui.app_advisor.present');
    expect(call.input).toEqual({
      action: { type: 'navigation.go_to_page', page: 'workflows' },
      originWorktreeId: APP_ADVISOR_WORKTREE_ID,
      originProjectId: APP_ADVISOR_PROJECT_ID,
      originChatTabId: 'advisor-chat',
      expectedUiRevision: 4,
    });
    lease.registry.reply('main-1', call.callId, {
      requestId: call.callId,
      ok: true,
    });

    await expect(pending).resolves.toEqual({ requestId: 'r1', ok: true });
    expect(lease.advisor).toHaveLength(0);
    expect(windowRequest).not.toHaveBeenCalled();
    expect(routeRequest).not.toHaveBeenCalled();
  });

  it('with no lease it is unavailable and no window opens', async () => {
    const lease = leases();

    const response = await presentAppAdvisorAction({
      action: { type: 'navigation.go_to_page', page: 'workflows' },
      requestId: 'r2',
      destination,
    });

    expect(response).toEqual({
      ...surfaceUnavailableResponse({
        kind: 'dispatch_action',
        requestId: 'r2',
        action: { type: 'navigation.go_to_page', page: 'workflows' },
        originWorktreeId: APP_ADVISOR_WORKTREE_ID,
      }),
      requestId: 'r2',
    });
    expect(lease.main).toHaveLength(0);
    expect(windowRequest).not.toHaveBeenCalled();
  });

  it('a domain action is never sent through the presentation tool', async () => {
    const lease = leases();
    mockBoundTools = ['ui.app_advisor.present'];

    const response: AppAdvisorActionResponse = await presentAppAdvisorAction({
      action: { type: 'pipeline.create', name: 'Nightly' },
      requestId: 'r3',
      destination,
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'unsupported_action' },
    });
    expect(lease.main).toHaveLength(0);
  });

  it('a guarded core write reaches the lease only when main marks it guarded (CAN-5999 D3)', async () => {
    const lease = leases();
    mockBoundTools = ['ui.app_advisor.present'];
    const action = {
      type: 'worktree-chat.set_model',
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      model: 'sonnet',
    } as const;

    const unguarded = await presentAppAdvisorAction({
      action,
      requestId: 'r4',
      destination,
    });
    expect(unguarded).toMatchObject({
      ok: false,
      error: { code: 'unsupported_action' },
    });
    expect(lease.main).toHaveLength(0);

    const pending = presentAppAdvisorAction({
      action,
      requestId: 'r5',
      destination,
      guarded: true,
    });
    const call = await delivered(lease.main);
    expect(call.input).toMatchObject({ action });
    lease.registry.reply('main-1', call.callId, {
      requestId: call.callId,
      ok: true,
    });
    await expect(pending).resolves.toEqual({ requestId: 'r5', ok: true });
  });

  it('a chat without an SDK session presents with the tools its call bound', async () => {
    const lease = leases();
    const runtime = createAppAdvisorToolRuntime(surfaces(), destination);

    const pending = executeAppAdvisorTool(
      'dispatch_action',
      { action: { type: 'navigation.go_to_page', page: 'workflows' } },
      runtime,
      { toolUseId: 'toolu_t', interfaceTools: ['ui.app_advisor.present'] },
    );
    const call = await delivered(lease.main);
    expect(call.toolName).toBe('ui.app_advisor.present');
    lease.registry.reply('main-1', call.callId, {
      requestId: call.callId,
      ok: true,
    });

    expect((await pending).isError).toBe(false);
    await expect(runtime.boundInterfaceTools()).resolves.toEqual([
      'ui.app_advisor.present',
    ]);
  });

  it("App Advisor files open in its own window's lease", async () => {
    const lease = leases();
    const runtime = createAppAdvisorToolRuntime(surfaces(), destination);

    const advisorFiles = runtime.showFiles([{ path: '/home/notes.md' }]);
    const advisorCall = await delivered(lease.advisor);
    expect(advisorCall.toolName).toBe('ui.app_advisor.show_files');
    lease.registry.reply('advisor-1', advisorCall.callId, {
      requestId: advisorCall.callId,
      ok: true,
      result: { opened: 1, failed: 0, files: [] },
    });
    await advisorFiles;

    const worktreeFiles = runtime.showFiles([{ path: '/repo/a.ts' }], {
      projectId: 'proj',
      worktreeId: 'task',
    });
    const mainCall = await delivered(lease.main);
    expect(mainCall.toolName).toBe('ui.show_files');
    lease.registry.reply('main-1', mainCall.callId, {
      requestId: mainCall.callId,
      ok: true,
      result: { opened: 1, failed: 0, files: [] },
    });
    await worktreeFiles;
    expect(lease.advisor).toHaveLength(1);
  });

  it("a remote-driven chat is never presented in this computer's windows (CAN-5823)", async () => {
    const lease = leases();
    mockBoundTools = ['ui.app_advisor.present'];
    // The driving controller has no lease of its own.
    setInterfaceToolAudienceResolver(() => 'controller');

    const response = await presentAppAdvisorAction({
      action: { type: 'navigation.go_to_page', page: 'workflows' },
      requestId: 'r5',
      destination,
    });

    expect(response).toMatchObject({ requestId: 'r5', ok: false });
    expect(windowRequest).not.toHaveBeenCalled();
    expect(lease.main).toHaveLength(0);
    expect(lease.advisor).toHaveLength(0);

    // Its controller's lease presents it; the controller's screen state never
    // becomes this computer's.
    // A known local state: with none cached, each read builds a fallback
    // stamped with the current time.
    const localState = {
      ...getLatestAppAdvisorUiState(),
      capturedAt: '2026-11-09T00:00:00.000Z',
      digest: 'local',
    };
    setLatestAppAdvisorUiState(localState);
    const remote: InterfaceToolCall[] = [];
    lease.registry.openLease(
      {
        leaseId: 'remote-1',
        surface: 'main',
        interfaceKind: 'desktop',
        audience: 'controller',
      },
      {
        deliver: (call) => {
          remote.push(call);
          return true;
        },
        cancel: () => undefined,
      },
    );
    lease.registry.register('remote-1', {
      tools: [interfaceToolDescriptor('ui.app_advisor.present')],
      _meta: { idempotencyKey: 'remote-tools' },
    });
    const pending = presentAppAdvisorAction({
      action: { type: 'navigation.go_to_page', page: 'workflows' },
      requestId: 'r5b',
      destination,
    });
    const call = await delivered(remote);
    lease.registry.reply('remote-1', call.callId, {
      requestId: call.callId,
      ok: true,
      uiState: {
        version: 1,
        revision: 99,
        capturedAt: '2026-11-09T00:00:00.000Z',
        digest: 'controller',
        snapshot: { activePage: 'workflows' },
      },
    });
    await expect(pending).resolves.toMatchObject({
      requestId: 'r5b',
      ok: true,
    });
    expect(lease.main).toHaveLength(0);
    expect(getLatestAppAdvisorUiState()).toEqual(localState);
  });

  it('the creation reveal runs through the lease and an unbound reveal keeps the chat', async () => {
    const lease = leases();
    mockBoundTools = ['ui.app_advisor.present'];
    const context = {
      destination,
      surfaces: surfaces(),
      requestId: 'r6',
    };

    const created = dispatchLegacyChatCreation(
      { type: 'standalone-chat.create_chat', projectId: 'proj' },
      context,
    );
    const reveal = await delivered(lease.main);
    expect(reveal.toolName).toBe('ui.app_advisor.present');
    expect(reveal.input.action).toEqual({
      type: 'standalone-chat.switch_chat',
      projectId: 'proj',
      chatId: 'new-chat',
    });
    lease.registry.reply('main-1', reveal.callId, {
      requestId: reveal.callId,
      ok: true,
      result: { chat: {}, settings: {}, workEntryId: 'task' },
    });
    await expect(created).resolves.toMatchObject({ ok: true });

    mockBoundTools = [];
    const unbound = await dispatchLegacyChatCreation(
      { type: 'standalone-chat.create_chat', projectId: 'proj' },
      { ...context, requestId: 'r7' },
    );
    expect(unbound).toMatchObject({
      requestId: 'r7',
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(lease.main).toHaveLength(1);
  });
});

// Core continuity flow: a question from a desktop-started turn must also be
// shown in a ready paired view, without transferring its original route.
it('a paired Orchestrator view replays a desktop-started question', async () => {
  const host = jest.requireActual<typeof AppAdvisorIpcModule>(
    '../../ipc/app-advisor',
  );
  const localWindow = new BrowserWindow();
  const pairedWindow = new BrowserWindow();
  const state = { open: true, focused: true };
  const local: AppAdvisorRendererToolSurfaces = {
    getMainWindow: () => localWindow,
    getAppAdvisorWindow: () => localWindow,
    openAppAdvisorWindow: () => Promise.resolve(state),
    ensureAppAdvisorWindow: () => Promise.resolve(state),
  };
  const paired: RemoteAppAdvisorWindowHost = {
    ...local,
    routeKey: 'paired-phone',
    getAppAdvisorWindow: () => pairedWindow,
    focusMainWindow: () => Promise.resolve(),
    closeAppAdvisorWindow: () => Promise.resolve(state),
    toggleAppAdvisorWindow: () => Promise.resolve(state),
    getAppAdvisorWindowState: () => state,
    markAppAdvisorWindowRendererReady: () => state,
    reportAppAdvisorWindowUiState: () => undefined,
  };
  jest.mocked(sendToWindowDetailed).mockClear();
  const requestId = 'desktop-to-paired-question';
  const chatId = 'desktop-origin-chat';
  const abort = new AbortController();
  const pendingQuestion = host.requestAppAdvisorRendererTool(
    {
      kind: 'ask_user_question',
      requestId,
      chatId,
      question: { question: 'Which release?', options: ['Stable', 'Preview'] },
    },
    local,
    { signal: abort.signal },
  );
  try {
    host.redeliverPendingAppAdvisorAskUserRequests(() => pairedWindow, paired);
    expect(sendToWindowDetailed).toHaveBeenCalledWith(
      pairedWindow,
      'app-advisor:tool-request',
      expect.objectContaining({ requestId, chatId }),
    );
  } finally {
    abort.abort();
    await pendingQuestion;
  }
});
