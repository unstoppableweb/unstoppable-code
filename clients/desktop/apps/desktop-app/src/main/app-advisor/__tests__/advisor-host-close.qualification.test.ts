import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  IPC_CHANNELS,
  type AppAdvisorWindowState,
} from '@canopy/desktop-shared/types';
import { AppAdvisorViewHost, type HostRect } from '../advisor-host';

class WindowStub extends EventEmitter {
  destroyed = false;
  visible = true;
  focused = true;
  contentView = {
    children: [],
    addChildView: jest.fn(),
    removeChildView: jest.fn(),
  };
  webContents = { focus: jest.fn() };

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isVisible(): boolean {
    this.assertAlive();
    return this.visible;
  }

  isFocused(): boolean {
    this.assertAlive();
    return this.focused;
  }

  isMinimized(): boolean {
    this.assertAlive();
    return false;
  }

  getContentBounds(): HostRect {
    this.assertAlive();
    return { x: 0, y: 0, width: 1000, height: 800 };
  }

  private assertAlive(): void {
    if (this.destroyed) throw new TypeError('Object has been destroyed');
  }
}

class ViewStub {
  setBounds = jest.fn();
  setVisible = jest.fn();
  webContents = {
    isDestroyed: jest.fn(() => false),
    isFocused: jest.fn(() => true),
    focus: jest.fn(),
  };
}

interface Fixture {
  main: WindowStub;
  shell: WindowStub;
  view: ViewStub;
  host: AppAdvisorViewHost<ViewStub, WindowStub>;
}

function fixture(): Fixture {
  const main = new WindowStub();
  const shell = new WindowStub();
  const view = new ViewStub();
  const host = new AppAdvisorViewHost({
    view,
    shell,
    getMainWindow: (): WindowStub => main,
    floatingBounds: (): HostRect => ({
      x: 500,
      y: 400,
      width: 400,
      height: 300,
    }),
    onPlacementChange: jest.fn(),
  });
  return { main, shell, view, host };
}

async function place(
  f: ReturnType<typeof fixture>,
  placement: 'floating' | 'full',
): Promise<void> {
  if (placement === 'floating') await f.host.showFloating();
  else f.host.showFull();
}

// Run the production listener and its state projection without starting the
// entire Electron entrypoint. AST extraction tolerates formatting and types;
// neither the close ordering nor the broadcast logic is copied into this test.
function readMainSource(relativePath: string): ts.SourceFile {
  const file = path.join(__dirname, '../../', relativePath);
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}

function windowStateScript(): string {
  const source = readMainSource('index.ts');
  const names = new Set([
    'isAppAdvisorVisible',
    'isAppAdvisorFocused',
    'currentAppAdvisorLayout',
    'getAppAdvisorWindowState',
    'broadcastAppAdvisorWindowState',
  ]);
  const functions: string[] = [];
  const listeners: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? '')) {
      functions.push(node.getText(source));
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'mainWindow' &&
      node.expression.name.text === 'on' &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === 'closed'
    ) {
      listeners.push(`${node.getText(source)};`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(functions).toHaveLength(names.size);
  expect(listeners).toHaveLength(1);
  return ts.transpileModule([...functions, ...listeners].join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function approvalsNavigationScript(): string {
  const main = readMainSource('index.ts');
  const ipc = readMainSource('ipc/app-advisor.ts');
  const openApprovals = main.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === 'openAppAdvisorApprovalsSettings',
  );
  const register = ipc.statements
    .filter(ts.isFunctionDeclaration)
    .find((node) => node.name?.text === 'registerAppAdvisorHandlers');
  const registration = register?.body?.statements.find(
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.arguments[0]?.getText(ipc) ===
        'IPC_CHANNELS.appAdvisorOpenApprovalsSettings',
  );
  if (!openApprovals || !registration) {
    throw new Error('Orchestrator Approvals host route is missing');
  }
  return ts.transpileModule(
    [
      openApprovals.getText(main),
      'const accessors = { openAppAdvisorApprovalsSettings };',
      registration.getText(ipc),
    ].join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
}

describe.each(['floating', 'full'] as const)('%s placement', (placement) => {
  test('preserves live visibility and focus state', async () => {
    const f = fixture();
    await place(f, placement);
    const window = placement === 'floating' ? f.main : f.shell;
    expect(f.host.isVisible()).toBe(true);
    expect(f.host.isFocused()).toBe(true);
    window.visible = false;
    window.focused = false;
    expect(f.host.isVisible()).toBe(false);
    expect(f.host.isFocused()).toBe(false);
    window.visible = true;
    window.focused = true;
    f.view.webContents.isFocused.mockReturnValue(false);
    expect(f.host.isFocused()).toBe(false);
  });

  test.each([
    ['host', 'isVisible'],
    ['host', 'isFocused'],
    ['shell', 'isVisible'],
    ['shell', 'isFocused'],
  ] as const)(
    'returns false with destroyed %s for %s before closed listeners run',
    async (destroyed, query) => {
      const f = fixture();
      await place(f, placement);
      const window =
        destroyed === 'shell' || placement === 'full' ? f.shell : f.main;
      window.destroyed = true;
      expect(f.host[query]()).toBe(false);
    },
  );

  test('main closure detaches a floating host before broadcasting and preserves a full host', async () => {
    const f = fixture();
    const sends: {
      window: WindowStub | null;
      channel: string;
      state: AppAdvisorWindowState;
      placement: string;
    }[] = [];
    const quit = jest.fn();
    runInNewContext(windowStateScript(), {
      mainWindow: f.main,
      mainWindowRendererReady: true,
      mainWindowPageDown: false,
      appAdvisorWindow: f.shell,
      appAdvisorHost: f.host,
      appAdvisorMinimized: false,
      appAdvisorFloatingSize: { width: 400, height: 300 },
      appIsQuitting: false,
      IPC_CHANNELS,
      setLinkBrowserTargetAvailable: jest.fn(),
      sendToWindowDetailed: (
        window: WindowStub | null,
        channel: string,
        state: AppAdvisorWindowState,
      ): void => {
        sends.push({ window, channel, state, placement: f.host.placement });
      },
      shouldQuitOnAllWindowsClosed: () => false,
      isCloseToTrayEnabled: () => false,
      process: { platform: 'linux' },
      app: { quit },
    });
    // The main listener is registered before the host attaches its listener.
    await place(f, placement);
    f.main.destroyed = true;
    expect(() => f.main.emit('closed')).not.toThrow();
    expect(sends).toHaveLength(2);
    expect(sends.map((send) => send.window)).toEqual([null, f.shell]);
    for (const send of sends) {
      expect(send.channel).toBe(IPC_CHANNELS.appAdvisorWindowStateChanged);
      expect(send.placement).toBe(placement === 'floating' ? 'hidden' : 'full');
      expect(send.state).toMatchObject({
        open: placement === 'full',
        focused: placement === 'full',
        mainWindowOpen: false,
        layout: placement,
      });
    }
    expect(quit).not.toHaveBeenCalled();
  });

  test('hands an Orchestrator Settings request to the main window', async () => {
    const f = fixture();
    await place(f, placement);
    const frame = {};
    const sender = { mainFrame: frame };
    const order: string[] = [];
    type Handler = (event: {
      sender: typeof sender;
      senderFrame: object;
    }) => Promise<void>;
    const handlers = new Map<string, Handler>();
    const closeAppAdvisorWindow = jest.fn(() =>
      Promise.resolve().then(() => {
        f.host.hide();
        order.push('minimize');
      }),
    );
    runInNewContext(approvalsNavigationScript(), {
      IPC_CHANNELS,
      registerIpcHandler: (channel: string, handler: Handler) => {
        handlers.set(channel, handler);
      },
      mainWindow: placement === 'floating' ? f.main : null,
      appAdvisorHost: f.host,
      getAppAdvisorRendererSurface: () => ({ webContents: sender }),
      ensureMainWindowFromPreferences: () =>
        Promise.resolve().then(() => {
          order.push('reopen');
        }),
      closeAppAdvisorWindow,
      queueApprovalsSettingsOpen: () => order.push('open Approvals'),
    });
    const invoke = handlers.get(IPC_CHANNELS.appAdvisorOpenApprovalsSettings);
    if (!invoke) throw new Error('Orchestrator Approvals IPC is missing');

    expect(() => invoke({ sender, senderFrame: {} })).toThrow('request frame');
    await expect(
      invoke({ sender: { mainFrame: frame }, senderFrame: frame }),
    ).rejects.toThrow('request sender');
    expect(order).toEqual([]);

    await invoke({ sender, senderFrame: frame });
    if (placement === 'floating') {
      expect(closeAppAdvisorWindow).toHaveBeenCalledWith({ minimize: true });
      expect(f.host.isVisible()).toBe(false);
      expect(order).toEqual(['open Approvals', 'minimize']);
    } else {
      expect(closeAppAdvisorWindow).not.toHaveBeenCalled();
      expect(f.host.isVisible()).toBe(true);
      expect(order).toEqual(['open Approvals', 'reopen']);
    }
  });
});
