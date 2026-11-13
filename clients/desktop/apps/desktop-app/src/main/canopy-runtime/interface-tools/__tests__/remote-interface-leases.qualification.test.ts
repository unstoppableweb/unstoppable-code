jest.mock('../../../canopy-tools/presentation-state', () => ({
  capturePresentationTurn: (): { source: 'user' } => ({ source: 'user' }),
  showFilesPresentationPolicy: (): { presentation: 'foreground' } => ({
    presentation: 'foreground',
  }),
}));
jest.mock('../../../browser/browser-handoffs', () => ({
  browserHandoffs: { snapshot: (): object => ({}) },
}));
jest.mock('../../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (): string => '/worktree',
}));
jest.mock('../../../observability', () => ({
  getObservabilityService: (): object => ({
    recordAppDiagnostic: (): undefined => undefined,
  }),
}));

import type { BrowserWindow, WebContents } from 'electron';
import { InterfaceToolRegistry } from '@canopy/core-runtime/node/client';
import {
  interfaceToolDescriptor,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  type AppAdvisorRendererToolRequest,
} from '@canopy/desktop-shared/types';
import {
  sendInterfaceToolCancellation,
  sendInterfaceToolRequest,
} from '../../../ipc/app-advisor';
import { interceptWebContentsSends } from '../../../lib/web-contents-send';
import type { RemoteSurface } from '@canopy/desktop-shared/remote-control/surfaces';
import type { DeviceKind } from '@canopy/protocol/device-relay';
import {
  resolveSessionInterfaceTools,
  setInterfaceToolAudienceResolver,
  setSessionInterfaceToolRegistry,
} from '../../../agents/interface-tool-binding';
import { requestShowFilesThroughLease } from '../../../canopy-tools/show-files-runtime';
import { RemoteHostSession } from '../../../remote-control/host/host-session';
import type { HostBridge } from '../../../remote-control/host/bridge-window';
import { REMOTE_PROTOCOL_VERSION } from '../../../remote-control/remote-protocol';
import type { SecureSession } from '../../../remote-control/transport/session-manager';
import {
  createDesktopInterfaceLeases,
  type DesktopInterfaceLeases,
  type InterfaceLeaseWebContents,
} from '../desktop-interface-leases';
import {
  REMOTE_SURFACE_INTERFACE_TOOLS,
  setRemoteInterfaceLeaseHost,
} from '../remote-interface-leases';

type LeaseEvent = 'did-navigate' | 'render-process-gone' | 'destroyed';

class FakeWebContents implements InterfaceLeaseWebContents {
  private destroyed = false;
  private readonly listeners = new Map<LeaseEvent, Set<() => void>>();
  constructor(readonly id: number) {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
  once(event: LeaseEvent, listener: () => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }
  removeListener(event: LeaseEvent, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }
  destroy(): void {
    this.destroyed = true;
    for (const listener of [...(this.listeners.get('destroyed') ?? [])])
      listener();
  }
}

/** The members of a secure session the RPC peer uses. */
class FakeSession {
  lastReceivedAt = Date.now();
  private closed = false;
  private readonly messages = new Set<(value: unknown) => void>();
  private readonly closes = new Set<(reason: string) => void>();
  constructor(readonly peerDeviceId: string) {}
  get isClosed(): boolean {
    return this.closed;
  }
  /** Never suspends: this relay-less session is active until it closes. */
  get state(): 'active' | 'closed' {
    return this.closed ? 'closed' : 'active';
  }
  onStateChange(): () => void {
    return () => undefined;
  }
  readonly purpose = 'control';
  /** The hello's resume negotiation; this session never resumes. */
  setResumeNegotiated(): void {}
  onMessage(listener: (value: unknown) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }
  onClose(listener: (reason: string) => void): () => void {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }
  sendMessage(): boolean {
    return !this.closed;
  }
  closeAfterDelivery(reason: string): void {
    this.close(reason);
  }
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.closes]) listener(reason);
  }
  receive(value: unknown): void {
    for (const listener of [...this.messages]) listener(value);
  }
}

const input = {
  files: [{ path: 'README.md' }],
  target: { projectId: 'p', worktreeId: 'w' },
};
const rendererResult = {
  opened: 1,
  failed: 0,
  activated: true,
  files: [{ path: 'README.md', ok: true, opened: true }],
};
const showFiles = (
  chatId: string,
): ReturnType<typeof requestShowFilesThroughLease> =>
  requestShowFilesThroughLease({
    ...input,
    origin: { projectId: 'p', worktreeId: 'w', chatTabId: chatId },
  });

const flush = async (): Promise<void> => {
  for (let tick = 0; tick < 20; tick += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

interface Controller {
  session: FakeSession;
  host: RemoteHostSession;
  bridges: Map<RemoteSurface, { contents: FakeWebContents; close(): void }>;
  closedReasons: string[];
}

interface World {
  registry: InterfaceToolRegistry;
  desktop: DesktopInterfaceLeases;
  contents: Map<number, FakeWebContents>;
  sent: { target: number; request: AppAdvisorRendererToolRequest }[];
  drivers: Map<string, string>;
  connect(
    deviceId: string,
    firstWebContentsId: number,
    protocolVersion?: number,
    kind?: DeviceKind,
  ): Promise<Controller>;
}

const localCaller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-renderer:main',
  clientInstanceId: 'renderer-relay:local',
  authorityId: 'local',
  interfaceKind: 'desktop',
  grants: ['core.client.manage'],
};

function world(): World {
  const registry = new InterfaceToolRegistry();
  const contents = new Map<number, FakeWebContents>([
    [1, new FakeWebContents(1)],
  ]);
  const sent: World['sent'] = [];
  const desktop = createDesktopInterfaceLeases({
    registry,
    webContentsFromId: (id) => contents.get(id) ?? null,
    send: (target, request) => {
      sent.push({ target: target.id, request });
      return true;
    },
    sendCancellation: () => true,
    sendPipelineEditor: () => true,
  });
  // This computer's own main window registers through the relay.
  desktop.register(
    localCaller,
    {
      tools: REMOTE_SURFACE_INTERFACE_TOOLS.main.map(interfaceToolDescriptor),
      _meta: { idempotencyKey: 'local-main' },
    },
    1,
  );
  const drivers = new Map<string, string>();
  setSessionInterfaceToolRegistry(registry);
  setRemoteInterfaceLeaseHost(desktop);
  setInterfaceToolAudienceResolver((chatId) => drivers.get(chatId) ?? null);
  const connect: World['connect'] = async (
    deviceId,
    firstWebContentsId,
    protocolVersion = REMOTE_PROTOCOL_VERSION,
    kind = 'desktop',
  ) => {
    const session = new FakeSession(deviceId);
    const bridges: Controller['bridges'] = new Map();
    const closedReasons: string[] = [];
    let nextId = firstWebContentsId;
    const host = new RemoteHostSession({
      session: session as unknown as SecureSession,
      kind,
      attributedDeviceId: deviceId,
      createBridge: (surface): Promise<HostBridge> => {
        const bridgeContents = new FakeWebContents(nextId++);
        contents.set(bridgeContents.id, bridgeContents);
        const closed = new Set<() => void>();
        // Like bridge-window.ts, a closing bridge destroys its window before
        // its closed listeners run, and Electron then throws on webContents.
        const close = (): void => {
          bridgeContents.destroy();
          for (const listener of [...closed]) listener();
        };
        bridges.set(surface, { contents: bridgeContents, close });
        const window = {
          get webContents(): { id: number } {
            if (bridgeContents.isDestroyed())
              throw new TypeError('Object has been destroyed');
            return { id: bridgeContents.id };
          },
        };
        const bridge: HostBridge = {
          getChatInterest: () => undefined,
          window: window as unknown as BrowserWindow,
          invoke: () => Promise.resolve(undefined),
          post: () => undefined,
          onPush: () => () => undefined,
          onClosed: (listener) => {
            closed.add(listener);
            return () => closed.delete(listener);
          },
          destroy: close,
        };
        return Promise.resolve(bridge);
      },
      mainWindowPushes: {
        subscribe: (): (() => void) => (): undefined => undefined,
      },
      uploads: {} as never,
      readFile: ((): Promise<object> => Promise.resolve({})) as never,
      disposition: (): 'tunnel' => 'tunnel',
      isAuthorized: (): boolean => true,
      version: { protocolVersion: REMOTE_PROTOCOL_VERSION, appVersion: '1' },
      hello: (): { name: string; platform: 'darwin' } => ({
        name: 'host',
        platform: 'darwin',
      }),
      onClose: (reason): void => {
        closedReasons.push(reason);
      },
    });
    session.receive({
      kind: 'request',
      id: 1,
      method: 'session.hello',
      params: { version: { protocolVersion, appVersion: '1' } },
    });
    await flush();
    return { session, host, bridges, closedReasons };
  };
  return { registry, desktop, contents, sent, drivers, connect };
}

function answer(
  w: World,
  from: number,
  requestId: string | undefined,
): ReturnType<DesktopInterfaceLeases['reply']> {
  return w.desktop.reply(from, { requestId, ok: true, result: rendererResult });
}

async function sentTo(w: World, count: number): Promise<number[]> {
  for (let tick = 0; tick < 50 && w.sent.length < count; tick += 1)
    await new Promise((resolve) => setImmediate(resolve));
  return w.sent.map((entry) => entry.target);
}

afterEach(() => {
  setSessionInterfaceToolRegistry(null);
  setRemoteInterfaceLeaseHost(null);
  setInterfaceToolAudienceResolver(null);
});

describe('remote-control window interface leases (CAN-5823)', () => {
  it("a remote window's lease follows the local registration rules", async () => {
    const w = world();
    const a = await w.connect('controller-a', 10);
    expect([...a.bridges.keys()]).toEqual(['main']);
    expect(w.registry.availableFor('controller-a')).toEqual(
      [...REMOTE_SURFACE_INTERFACE_TOOLS.main].sort(),
    );
    // The bridge page itself can never register or unregister on its lease.
    expect(() =>
      w.desktop.register(
        localCaller,
        {
          tools: [interfaceToolDescriptor('ui.show_files')],
          _meta: { idempotencyKey: 'bridge' },
        },
        10,
      ),
    ).toThrow('Untrusted interface tool registration.');
    // The catalog's surface rule applies to host registrations too.
    expect(() =>
      w.desktop.openRemote({
        webContentsId: 10,
        surface: 'app-advisor',
        controllerDeviceId: 'controller-a',
        tools: ['ui.show_files'],
      }),
    ).toThrow('This interface cannot serve this tool.');
    expect(w.registry.availableFor('controller-a')).toEqual([]);
  });

  it("a local chat is never served by a controller's window", async () => {
    const w = world();
    await w.connect('controller-a', 10);
    expect(resolveSessionInterfaceTools({ chatId: 'local' })).toEqual([
      'ui.show_files',
    ]);
    const pending = showFiles('local');
    expect(await sentTo(w, 1)).toEqual([1]);
    expect(answer(w, 1, w.sent[0]?.request.requestId)).toBe('settled');
    await expect(pending).resolves.toMatchObject({ opened: 1 });
    // Without this computer's window, a local chat has no ShowFiles at all.
    w.contents.get(1)?.destroy();
    expect(resolveSessionInterfaceTools({ chatId: 'local' })).toEqual([]);
    await expect(showFiles('local')).rejects.toThrow();
    expect(await sentTo(w, 2)).toEqual([1]);
  });

  it('a remote-driven chat is served only by its own controller', async () => {
    const w = world();
    const a = await w.connect('controller-a', 10);
    await w.connect('controller-b', 20);
    w.drivers.set('driven', 'controller-a');
    expect(resolveSessionInterfaceTools({ chatId: 'driven' })).toEqual([
      'ui.show_files',
    ]);
    const pending = showFiles('driven');
    expect(await sentTo(w, 1)).toEqual([10]);
    answer(w, 10, w.sent[0]?.request.requestId);
    await pending;
    // Its controller's window gone, the chat is refused: neither this
    // computer's window nor another controller's serves it.
    a.bridges.get('main')?.contents.destroy();
    expect(resolveSessionInterfaceTools({ chatId: 'driven' })).toEqual([]);
    await expect(showFiles('driven')).rejects.toThrow();
    expect(await sentTo(w, 2)).toEqual([10]);
  });

  it('a reply from any other WebContents with a valid request id is refused', async () => {
    const w = world();
    await w.connect('controller-a', 10);
    await w.connect('controller-b', 20);
    w.drivers.set('driven', 'controller-a');
    const pending = showFiles('driven');
    await sentTo(w, 1);
    const requestId = w.sent[0]?.request.requestId;
    expect(answer(w, 1, requestId)).toBe('wrong_lease');
    expect(answer(w, 20, requestId)).toBe('wrong_lease');
    expect(answer(w, 99, requestId)).toBe('wrong_lease');
    expect(answer(w, 10, requestId)).toBe('settled');
    await expect(pending).resolves.toMatchObject({ opened: 1 });
  });

  it('the lease ends on bridge close, session end, revocation and protocol mismatch, failing calls in flight', async () => {
    const w = world();
    const ends: Array<[string, (controller: Controller) => void]> = [
      ['bridge close', (c) => c.bridges.get('main')?.close()],
      ['session end', (c) => c.session.close('peer_closed')],
      ['revocation', (c) => c.host.end('revoked')],
    ];
    let nextId = 10;
    for (const [label, end] of ends) {
      const deviceId = `controller-${label}`;
      const controller = await w.connect(deviceId, nextId);
      nextId += 10;
      w.drivers.set(label, deviceId);
      const pending = showFiles(label);
      const before = w.sent.length;
      await sentTo(w, before + 1);
      end(controller);
      await expect(pending).rejects.toThrow();
      expect(controller.closedReasons).toHaveLength(1);
      expect(w.registry.availableFor(deviceId)).toEqual([]);
      expect(resolveSessionInterfaceTools({ chatId: label })).toEqual([]);
    }
    // A controller on another protocol never gets a bridge or a lease.
    const mismatched = await w.connect(
      'controller-old',
      90,
      REMOTE_PROTOCOL_VERSION + 1,
    );
    expect(mismatched.bridges.size).toBe(0);
    expect(w.registry.availableFor('controller-old')).toEqual([]);
  });

  it('a bridge that closes ends every lease of its session and still closes it', async () => {
    const w = world();
    const a = await w.connect('controller-a', 10);
    await a.host.bridgeFor('app-advisor');
    expect(w.registry.availableFor('controller-a')).toEqual(
      [
        ...REMOTE_SURFACE_INTERFACE_TOOLS.main,
        ...REMOTE_SURFACE_INTERFACE_TOOLS['app-advisor'],
      ].sort(),
    );
    // The App Advisor bridge crashes; its window is destroyed, the main
    // bridge's lease ends with the session.
    a.bridges.get('app-advisor')?.close();
    expect(a.closedReasons).toEqual(['protocol_error']);
    expect(w.registry.availableFor('controller-a')).toEqual([]);
  });

  it.each<DeviceKind>(['mobile', 'browser'])(
    'a %s controller implements none of the tools, so its windows hold no lease',
    async (kind) => {
      const w = world();
      const c = await w.connect(
        `controller-${kind}`,
        10,
        REMOTE_PROTOCOL_VERSION,
        kind,
      );
      await c.host.bridgeFor('main');
      expect(c.bridges.size).toBe(1);
      expect(w.registry.availableFor(`controller-${kind}`)).toEqual([]);
      w.drivers.set('driven', `controller-${kind}`);
      expect(resolveSessionInterfaceTools({ chatId: 'driven' })).toEqual([]);
    },
  );

  it("a change of driver mid-chat never reaches the former driver's window", async () => {
    const w = world();
    await w.connect('controller-a', 10);
    const b = await w.connect('controller-b', 20);
    w.drivers.set('chat', 'controller-a');
    const first = showFiles('chat');
    await sentTo(w, 1);
    answer(w, 10, w.sent[0]?.request.requestId);
    await first;
    w.drivers.set('chat', 'controller-b');
    const second = showFiles('chat');
    expect(await sentTo(w, 2)).toEqual([10, 20]);
    answer(w, 20, w.sent[1]?.request.requestId);
    await second;
    // The new driver loses its window: refused, never sent to the old one.
    b.bridges.get('main')?.contents.destroy();
    await expect(showFiles('chat')).rejects.toThrow();
    w.drivers.delete('chat');
    const local = showFiles('chat');
    expect(await sentTo(w, 3)).toEqual([10, 20, 1]);
    answer(w, 1, w.sent[2]?.request.requestId);
    await local;
  });

  it("a remote lease's calls and cancellations reach the controller through its bridge", () => {
    // A bridge window intercepts what main sends it and forwards it to the
    // controller; a direct webContents.send would stop at the hidden page.
    const pageSend = jest.fn();
    const bridge = {
      id: 10,
      isDestroyed: (): boolean => false,
      send: pageSend,
    };
    const forwarded: Array<[string, readonly unknown[]]> = [];
    const stop = interceptWebContentsSends(bridge, (channel, args) => {
      forwarded.push([channel, args]);
      return true;
    });
    try {
      const contents = bridge as unknown as WebContents;
      expect(
        sendInterfaceToolRequest(contents, {
          kind: 'get_current_ui_state',
          requestId: 'call-1',
        }),
      ).toBe(true);
      expect(
        sendInterfaceToolCancellation(contents, { requestId: 'call-1' }),
      ).toBe(true);
    } finally {
      stop();
    }
    expect(forwarded.map(([channel]) => channel)).toEqual([
      IPC_CHANNELS.appAdvisorToolRequest,
      IPC_CHANNELS.appAdvisorToolRequestCancelled,
    ]);
    expect(pageSend).not.toHaveBeenCalled();
  });
});
