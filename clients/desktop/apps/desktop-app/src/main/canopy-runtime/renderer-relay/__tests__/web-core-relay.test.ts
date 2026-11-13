import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { CanopyTransportError } from '@canopy/core-transport';
import type { RelayBindingProvider } from '../definitions';
import {
  createRendererRelay,
  type RendererRelayEvent,
  type RendererRelaySurfaceResolution,
} from '../relay';
import { routeRendererRelayRequest } from '../relay-authority';
import type { RendererRelaySurface } from '../surface-allowlist';
import {
  WEB_CORE_PIPELINE_RUN_RELAY_OPERATIONS,
  WEB_CORE_RELAY_OPERATIONS,
} from '../web-core-relay-definitions';
import { createWebCoreRendererRelay } from '../../../ipc/canopy-core-relay';

const CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop',
  clientInstanceId: 'main',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.chat.read', 'core.runtime.read'],
};

function rendererEvent(): RendererRelayEvent {
  const frame = {
    url: 'app://canopy/index.html',
    detached: false,
    isDestroyed: (): boolean => false,
  };
  return {
    sender: {
      id: 1,
      mainFrame: frame,
      getURL: () => frame.url,
      isDestroyed: () => false,
      on: () => undefined,
      removeListener: () => undefined,
    },
    senderFrame: frame,
  };
}

const unreachable = (): Promise<never> =>
  Promise.reject(
    new CanopyTransportError({
      kind: 'unavailable',
      message: 'Not connected in this test.',
      retry: { kind: 'never' },
    }),
  );

function webCoreRelay(
  bindingProvider: RelayBindingProvider,
  surface: RendererRelaySurface = 'main',
): ReturnType<typeof createRendererRelay> {
  return createWebCoreRendererRelay({
    bindingProvider,
    resolveSurface: (): RendererRelaySurfaceResolution => ({
      surface,
      caller: CALLER,
    }),
  });
}

describe('web core authority on the canopy-core:relay channel (CAN-4185 PR-C)', () => {
  it('a web-core request is refused for an operation outside WEB_CORE_RELAY_OPERATIONS', async () => {
    const binding = jest.fn<
      ReturnType<RelayBindingProvider>,
      Parameters<RelayBindingProvider>
    >(unreachable);
    const relay = webCoreRelay(binding);
    const event = rendererEvent();
    // Registered core operations, but cloud worktree features or admin.
    for (const method of [
      'core.workspace.create',
      'core.git.status.get',
      'core.runtime.initialize',
      'worker.filesystem.file.write',
      'worker.filesystem.entry.delete',
      'worker.terminal.create',
    ]) {
      expect(WEB_CORE_RELAY_OPERATIONS.has(method)).toBe(false);
      await expect(
        relay.invoke(event, { kind: 'request', method, params: {} }),
      ).resolves.toMatchObject({
        ok: false,
        error: { kind: 'capability_unavailable' },
      });
    }
    await expect(
      relay.invoke(event, {
        kind: 'openStream',
        method: 'core.events.subscribe',
        params: {},
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'capability_unavailable' },
    });
    // App Advisor gets no web core access, even for an allowed operation.
    const advisor = webCoreRelay(binding, 'app-advisor');
    await expect(
      advisor.invoke(rendererEvent(), {
        kind: 'request',
        method: 'core.chat.list',
        params: {},
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'capability_unavailable' },
    });
    expect(binding).not.toHaveBeenCalled();

    // An allowed operation does reach the web core binding.
    await relay.invoke(event, {
      kind: 'request',
      method: 'core.chat.list',
      params: {},
    });
    expect(binding).toHaveBeenCalledTimes(1);
    relay.dispose();
    advisor.dispose();
  });

  it('cloud project reorder, update and delete reach the web core binding (CAN-6099)', async () => {
    const binding = jest.fn<
      ReturnType<RelayBindingProvider>,
      Parameters<RelayBindingProvider>
    >(unreachable);
    const relay = webCoreRelay(binding);
    const requests = [
      {
        method: 'core.workspace.reorder',
        params: {
          visibleWorkspaceIds: ['ws-1', 'ws-2'],
          activeWorkspaceId: 'ws-1',
          overWorkspaceId: 'ws-2',
          _meta: { idempotencyKey: 'key-1' },
        },
      },
      {
        method: 'core.workspace.update',
        params: {
          workspaceId: 'ws-1',
          patch: { name: 'Renamed' },
          _meta: { idempotencyKey: 'key-3' },
        },
      },
      {
        method: 'core.workspace.delete',
        params: {
          workspaceId: 'ws-1',
          expectedRevision: 1,
          _meta: { idempotencyKey: 'key-2' },
        },
      },
    ];
    for (const { method, params } of requests) {
      expect(WEB_CORE_RELAY_OPERATIONS.has(method)).toBe(true);
      // Past the allowlist, the request fails only at the unreachable binding.
      await expect(
        relay.invoke(rendererEvent(), { kind: 'request', method, params }),
      ).resolves.toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    }
    expect(binding).toHaveBeenCalledTimes(requests.length);
    relay.dispose();
  });

  it('cloud project writes reach only the web core, from the main window, and update only name and colour (CAN-6099)', async () => {
    const binding = jest.fn<
      ReturnType<RelayBindingProvider>,
      Parameters<RelayBindingProvider>
    >(unreachable);
    const relay = webCoreRelay(binding);
    const advisor = webCoreRelay(binding, 'app-advisor');
    const local = {
      invoke: jest.fn(() =>
        Promise.resolve({ ok: true as const, value: { from: 'local' } }),
      ),
    };
    const targets = { local, webCore: relay };
    const update = (
      patch: Record<string, unknown>,
    ): Record<string, unknown> => ({
      kind: 'request',
      method: 'core.workspace.update',
      params: {
        workspaceId: 'ws-1',
        patch,
        _meta: { idempotencyKey: 'key-u' },
      },
    });

    // Another principal (App Advisor's surface) gets none of them.
    for (const method of [
      'core.workspace.reorder',
      'core.workspace.update',
      'core.workspace.delete',
    ]) {
      await expect(
        advisor.invoke(rendererEvent(), {
          kind: 'request',
          method,
          params: {},
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { kind: 'capability_unavailable' },
      });
    }
    // Without the web-core authority a request goes to the local relay only;
    // an unknown authority goes nowhere.
    await routeRendererRelayRequest(
      targets,
      rendererEvent(),
      update({ name: 'x' }),
    );
    expect(local.invoke).toHaveBeenCalledTimes(1);
    await expect(
      routeRendererRelayRequest(targets, rendererEvent(), {
        ...update({ name: 'x' }),
        authority: 'elsewhere',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'invalid_argument' },
    });
    expect(binding).not.toHaveBeenCalled();

    // Any patch field besides name and colour is refused before it leaves main.
    for (const patch of [{ pinned: true }, { name: 'x', collapsed: true }]) {
      await expect(
        routeRendererRelayRequest(targets, rendererEvent(), {
          ...update(patch),
          authority: 'web-core',
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { kind: 'invalid_argument' },
      });
    }
    expect(binding).not.toHaveBeenCalled();
    await expect(
      routeRendererRelayRequest(targets, rendererEvent(), {
        ...update({ name: 'Renamed', color: '#336699' }),
        authority: 'web-core',
      }),
    ).resolves.toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(binding).toHaveBeenCalledTimes(1);
    expect(local.invoke).toHaveBeenCalledTimes(1);
    relay.dispose();
    advisor.dispose();
  });

  it('cloud file reads reach the web core binding (CAN-6175 R9)', async () => {
    const binding = jest.fn<
      ReturnType<RelayBindingProvider>,
      Parameters<RelayBindingProvider>
    >(unreachable);
    const relay = webCoreRelay(binding);
    const reads = [
      'worker.filesystem.roots.list',
      'worker.filesystem.directory.list',
      'worker.filesystem.file.read',
      'worker.filesystem.search',
      'worker.filesystem.link.resolve',
    ];
    for (const method of reads) {
      expect(WEB_CORE_RELAY_OPERATIONS.has(method)).toBe(true);
      // Past the allowlist, the request fails only at the unreachable binding.
      await expect(
        relay.invoke(rendererEvent(), {
          kind: 'request',
          method,
          params: { scope: { chatId: 'chat-1' } },
        }),
      ).resolves.toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    }
    expect(binding).toHaveBeenCalled();
    relay.dispose();
  });

  it('cloud run operations reach the web core without the cloud chats flag, and chats still need it (CAN-6326)', async () => {
    const binding = jest.fn<
      ReturnType<RelayBindingProvider>,
      Parameters<RelayBindingProvider>
    >(unreachable);
    let cloudChats = false;
    const relay = createWebCoreRendererRelay({
      bindingProvider: binding,
      resolveSurface: (): RendererRelaySurfaceResolution => ({
        surface: 'main',
        caller: CALLER,
      }),
      cloudChatsEnabled: () => cloudChats,
    });
    const event = rendererEvent();
    const requests: readonly {
      readonly kind: 'request' | 'openStream';
      readonly method: string;
    }[] = [
      { kind: 'request', method: 'worker.pipeline.execution.list' },
      { kind: 'request', method: 'worker.pipeline.execution.get' },
      { kind: 'openStream', method: 'worker.pipeline.execution.events' },
      { kind: 'request', method: 'worker.pipeline.execution.cancel' },
      { kind: 'request', method: 'worker.pipeline.execution.resume' },
      { kind: 'request', method: 'worker.pipeline.execution.retry' },
      { kind: 'request', method: 'worker.pipeline.matrixJob.retry' },
      { kind: 'request', method: 'worker.pipeline.matrixVariant.cancel' },
      { kind: 'request', method: 'core.pipeline.execution.stepLog.read' },
      { kind: 'request', method: 'core.pipeline.execution.artifact.read' },
    ];
    for (const { kind, method } of requests) {
      expect(WEB_CORE_PIPELINE_RUN_RELAY_OPERATIONS.has(method)).toBe(true);
      expect(WEB_CORE_RELAY_OPERATIONS.has(method)).toBe(true);
      // Past the allowlist, the call fails only at the unreachable binding.
      await expect(
        relay.invoke(event, { kind, method, params: { executionId: 'run-1' } }),
      ).resolves.toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    }
    expect(binding).toHaveBeenCalled();
    binding.mockClear();

    // Starting a run stays in main, after its model preflight (CAN-6187).
    expect(WEB_CORE_RELAY_OPERATIONS.has('core.pipeline.execution.start')).toBe(
      false,
    );
    // Host requests are the run owner's alone.
    expect(WEB_CORE_RELAY_OPERATIONS.has('worker.pipeline.hostRequests')).toBe(
      false,
    );

    // Cloud chats are refused while their flag is off, before the binding.
    await expect(
      relay.invoke(event, {
        kind: 'request',
        method: 'core.chat.list',
        params: {},
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'capability_unavailable',
        message: 'Cloud chats are not available.',
      },
    });
    expect(binding).not.toHaveBeenCalled();
    cloudChats = true;
    await relay.invoke(event, {
      kind: 'request',
      method: 'core.chat.list',
      params: {},
    });
    expect(binding).toHaveBeenCalledTimes(1);
    relay.dispose();
  });

  it('core.chat.live.events reaches the web core only (CAN-5984)', async () => {
    const localBinding = jest.fn<
      ReturnType<RelayBindingProvider>,
      Parameters<RelayBindingProvider>
    >(unreachable);
    const webCoreBinding = jest.fn<
      ReturnType<RelayBindingProvider>,
      Parameters<RelayBindingProvider>
    >(unreachable);
    const local = createRendererRelay({
      bindingProvider: localBinding,
      resolveSurface: () => ({ surface: 'main', caller: CALLER }),
    });
    const webCore = webCoreRelay(webCoreBinding);
    const open = {
      kind: 'openStream',
      method: 'core.chat.live.events',
      params: {
        scope: { workspaceId: 'ws-1', worktreeId: 'task-1', chatId: 'chat-1' },
      },
    } as const;
    // The desktop core serves no live replies.
    await expect(
      routeRendererRelayRequest({ local, webCore }, rendererEvent(), open),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'capability_unavailable' },
    });
    expect(localBinding).not.toHaveBeenCalled();
    await routeRendererRelayRequest({ local, webCore }, rendererEvent(), {
      ...open,
      authority: 'web-core',
    });
    expect(webCoreBinding).toHaveBeenCalledTimes(1);
    expect(localBinding).not.toHaveBeenCalled();
    local.dispose();
    webCore.dispose();
  });

  it('a local request never reaches the web-core binding', async () => {
    const localBinding = jest.fn<
      ReturnType<RelayBindingProvider>,
      Parameters<RelayBindingProvider>
    >(unreachable);
    const webCoreBinding = jest.fn<
      ReturnType<RelayBindingProvider>,
      Parameters<RelayBindingProvider>
    >(unreachable);
    const local = createRendererRelay({
      bindingProvider: localBinding,
      resolveSurface: () => ({ surface: 'main', caller: CALLER }),
    });
    const webCore = webCoreRelay(webCoreBinding);
    const relays = { local, webCore };
    const event = rendererEvent();

    // Operations both relays allow, so a misrouted request would reach the web core.
    for (const input of [
      { kind: 'request', method: 'core.chat.list', params: {} },
      { kind: 'request', method: 'core.workspace.list', params: {} },
      { kind: 'openStream', method: 'core.chat.events', params: {} },
      { kind: 'close' },
    ])
      await routeRendererRelayRequest(relays, event, input);

    expect(localBinding).toHaveBeenCalled();
    expect(webCoreBinding).not.toHaveBeenCalled();
    local.dispose();
    webCore.dispose();
  });
});
