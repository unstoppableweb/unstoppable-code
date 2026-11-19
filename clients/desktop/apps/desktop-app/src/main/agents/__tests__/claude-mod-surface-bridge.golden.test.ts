import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  validateExtensionUiTree,
  type ClaudeModSurfacePushEvent,
} from '@canopy/protocol/extension-ui';
import { registerClaudeModsHandlers } from '../../ipc/claude-mods';
import { registerIpcHandler } from '../../ipc/register';
import { sendToAllWindows } from '../../lib/window-send';
import {
  ClaudeModSurfaceBridge,
  type ClaudeModUiHost,
} from '../claude-mod-surface-bridge';

let mockSurfaceFlag = true;
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): unknown => ({ isEnabled: () => mockSurfaceFlag }),
}));
jest.mock('../../lib/window-send', () => ({ sendToAllWindows: jest.fn() }));
jest.mock('../../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../../ipc/preferences', () => ({
  broadcastCommittedPreferences: jest.fn(),
}));
jest.mock('../../lib/claude-mod-admission-service', () => ({
  getClaudeModsState: jest.fn(),
  updateClaudeModsState: jest.fn(),
}));

const sent = jest.mocked(sendToAllWindows);
// A request or press id the bridge makes up.
const ANY_ID: unknown = expect.any(String);
const CHAT = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
// The init and pushes Claude Code 2.1.319 sent in the probe (06-evidence.md).
const INIT = {
  type: 'system',
  subtype: 'init',
  capabilities: ['msg_lifecycle_v1', 'ui_surface_v1'],
};
const TOAST = {
  type: 'system',
  subtype: 'ui_toast',
  plugin: 'ping-mod',
  text: 'ping toast from session.start',
  timeout_ms: 4000,
  uuid: 'u',
  session_id: 's',
};

beforeEach(() => {
  sent.mockClear();
  mockSurfaceFlag = true;
});

it('sends an attached chat its Mod pushes on the surface channel', () => {
  const bridge = new ClaudeModSurfaceBridge(CHAT, true);
  bridge.init(INIT);
  bridge.receive(TOAST);
  bridge.receive({ ...TOAST, subtype: 'ui_status', text: null });
  expect(sent.mock.calls).toEqual([
    [
      IPC_CHANNELS.claudeModSurfacePush,
      {
        ...CHAT,
        push: {
          kind: 'toast',
          plugin: 'ping-mod',
          text: 'ping toast from session.start',
          timeoutMs: 4000,
        },
      },
    ],
    [
      IPC_CHANNELS.claudeModSurfacePush,
      { ...CHAT, push: { kind: 'status', plugin: 'ping-mod', text: null } },
    ],
  ]);
});

it('keeps the pushes a Mod sends before the root init, and sends them once attached', () => {
  const bridge = new ClaudeModSurfaceBridge(CHAT, true);
  bridge.receive(TOAST);
  expect(sent).not.toHaveBeenCalled();
  bridge.init(INIT);
  expect(sent.mock.calls).toEqual([
    [
      IPC_CHANNELS.claudeModSurfacePush,
      {
        ...CHAT,
        push: {
          kind: 'toast',
          plugin: 'ping-mod',
          text: 'ping toast from session.start',
          timeoutMs: 4000,
        },
      },
    ],
  ]);

  sent.mockClear();
  mockSurfaceFlag = false;
  const off = new ClaudeModSurfaceBridge(CHAT, true);
  off.receive(TOAST);
  off.init(INIT);
  off.receive(TOAST);
  expect(sent).not.toHaveBeenCalled();
});

it('sends nothing unless both flags are on and the CLI speaks the surface', () => {
  const cases: [boolean, boolean, unknown[]][] = [
    [false, true, INIT.capabilities],
    [true, false, INIT.capabilities],
    [true, true, ['msg_lifecycle_v1']],
  ];
  for (const [admissionOn, surfaceFlag, capabilities] of cases) {
    mockSurfaceFlag = surfaceFlag;
    const bridge = new ClaudeModSurfaceBridge(CHAT, admissionOn);
    bridge.init({ ...INIT, capabilities });
    bridge.receive(TOAST);
  }
  const unattached = new ClaudeModSurfaceBridge(CHAT, true);
  unattached.receive(TOAST);
  const attached = new ClaudeModSurfaceBridge(CHAT, true);
  attached.init(INIT);
  attached.receive({ ...TOAST, subtype: 'ui_panes', panes: [] });
  attached.receive({ ...TOAST, plugin: undefined });
  expect(sent).not.toHaveBeenCalled();
});

describe('the desktop surface (M2)', () => {
  // The band tree and roster shapes the probe's ping Mod answered with.
  const BAND = {
    type: 'Box',
    children: [{ type: 'Text', children: ['ping band'] }],
  };
  const ROSTER = {
    panes: [{ id: 'ping', title: 'Ping', plugin: 'ping-mod' }],
    shown_id: 'ping',
    focused_id: null,
    focus_requested_id: null,
  };

  function fakeCli(
    answer: (request: Record<string, unknown>) => unknown = (request) => {
      if (request.subtype === 'ui_panes') return ROSTER;
      if (request.subtype === 'ui_render') {
        return { tree: BAND, hooked: true, props: {}, rewritten: false };
      }
      return {};
    },
  ): {
    requests: Record<string, unknown>[];
    request: (request: Record<string, unknown>) => Promise<unknown>;
  } {
    const requests: Record<string, unknown>[] = [];
    return {
      requests,
      request: (request) => {
        requests.push(request);
        const response = answer(request);
        return response instanceof Error
          ? Promise.reject(response)
          : Promise.resolve({ subtype: 'success', request_id: 'r', response });
      },
    };
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    jest.advanceTimersByTime(16);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  }

  const pushes = (): unknown[] => sent.mock.calls.map(([, event]) => event);
  const isPushEvent = (event: unknown): event is ClaudeModSurfacePushEvent =>
    typeof event === 'object' && event !== null && 'push' in event;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('attaches as the desktop surface and sends the roster and the band', async () => {
    const cli = fakeCli();
    const bridge = new ClaudeModSurfaceBridge(CHAT, true, cli.request);
    bridge.init(INIT);
    await settle();
    expect(cli.requests.map((request) => request.subtype)).toEqual([
      'ui_attach',
      'ui_panes',
      'ui_render',
      'ui_render',
    ]);
    expect(cli.requests[0]).toMatchObject({
      surface: 'desktop',
      viewport: { isFullscreen: true },
      answers: [],
    });
    const renders = new Map(
      cli.requests.slice(2).map((request) => [request.component, request]),
    );
    expect(renders.get('AbovePrompt')).toMatchObject({
      instance_id: 'above-prompt',
    });
    expect(renders.get('Pane')).toMatchObject({
      instance_id: 'ping',
      props: { title: 'Ping', isFocused: false, placement: 'dock' },
    });
    expect(pushes()).toEqual(
      expect.arrayContaining([
        {
          ...CHAT,
          push: {
            kind: 'panes',
            roster: {
              panes: [{ id: 'ping', title: 'Ping', plugin: 'ping-mod' }],
              shownId: 'ping',
              focusedId: null,
              focusRequestedId: null,
            },
          },
        },
      ]),
    );
    expect(pushes()).toContainEqual({
      ...CHAT,
      push: {
        kind: 'tree',
        site: 'band',
        instanceId: 'above-prompt',
        tree: validateExtensionUiTree(BAND).tree,
      },
    });
  });

  it('draws invalidated sites once per frame and skips a site that is not hooked until invalidated', async () => {
    const cli = fakeCli((request) => {
      if (request.subtype === 'ui_panes') return ROSTER;
      if (request.subtype !== 'ui_render') return {};
      return request.component === 'Pane'
        ? { tree: null, hooked: false }
        : { tree: BAND, hooked: true };
    });
    const bridge = new ClaudeModSurfaceBridge(CHAT, true, cli.request);
    bridge.init(INIT);
    await settle();
    const renders = (): unknown[] =>
      cli.requests
        .filter((request) => request.subtype === 'ui_render')
        .map((request) => request.instance_id);
    expect(renders().sort()).toEqual(['above-prompt', 'ping']);

    const invalidate = (component: string, instanceId: string): void =>
      bridge.receive({
        type: 'system',
        subtype: 'ui_invalidate',
        instances: [{ surface: 'desktop', component, instance_id: instanceId }],
      });
    cli.requests.length = 0;
    invalidate('AbovePrompt', 'above-prompt');
    invalidate('AbovePrompt', 'above-prompt');
    await settle();
    expect(renders()).toEqual(['above-prompt']);

    // The pane answered `hooked: false`: closed and opened again, it is not
    // asked for; its next invalidation is.
    cli.requests.length = 0;
    bridge.receive({
      type: 'system',
      subtype: 'ui_panes',
      ...ROSTER,
      panes: [],
    });
    bridge.receive({ type: 'system', subtype: 'ui_panes', ...ROSTER });
    await settle();
    expect(renders()).toEqual([]);
    invalidate('Pane', 'ping');
    await settle();
    expect(renders()).toEqual(['ping']);
  });

  it('asks every mounted site again on an invalidation that names none, as a Mod load sends', async () => {
    const cli = fakeCli((request) => {
      if (request.subtype === 'ui_panes') return ROSTER;
      if (request.subtype !== 'ui_render') return {};
      return request.component === 'AbovePrompt'
        ? { tree: null, hooked: false }
        : { tree: BAND, hooked: true };
    });
    const bridge = new ClaudeModSurfaceBridge(CHAT, true, cli.request);
    bridge.init(INIT);
    await settle();
    cli.requests.length = 0;
    // The engine's own shape (2.1.319): no `instances` means all of them.
    bridge.receive({
      type: 'system',
      subtype: 'ui_invalidate',
      event: 'ui.render',
    });
    bridge.receive({
      type: 'system',
      subtype: 'ui_invalidate',
      event: 'ui.render',
    });
    await settle();
    expect(
      cli.requests
        .filter((request) => request.subtype === 'ui_render')
        .map((request) => request.instance_id)
        .sort(),
    ).toEqual(['above-prompt', 'ping']);
  });

  it('draws a pane for the cells its panel reports, and only when they change', async () => {
    const cli = fakeCli();
    const bridge = new ClaudeModSurfaceBridge(CHAT, true, cli.request);
    // A panel can measure before the session attaches; its size is kept.
    await bridge.command({
      kind: 'pane-resize',
      paneId: 'ping',
      columns: 42,
      rows: 17,
    });
    bridge.init(INIT);
    await settle();
    const paneRenders = (): Record<string, unknown>[] =>
      cli.requests.filter(
        (request) =>
          request.subtype === 'ui_render' && request.component === 'Pane',
      );
    expect(paneRenders()).toHaveLength(1);
    expect(paneRenders()[0]).toMatchObject({
      viewport: { columns: 42, rows: 17, isFullscreen: true },
      props: { bodyColumns: 42 },
    });

    cli.requests.length = 0;
    await bridge.command({
      kind: 'pane-resize',
      paneId: 'ping',
      columns: 42,
      rows: 17,
    });
    await settle();
    expect(cli.requests).toEqual([]);
    await bridge.command({
      kind: 'pane-resize',
      paneId: 'ping',
      columns: 60,
      rows: 20,
    });
    await settle();
    expect(paneRenders()).toHaveLength(1);
    expect(paneRenders()[0]).toMatchObject({
      viewport: { columns: 60, rows: 20, isFullscreen: true },
    });
    // The resize itself is never sent to the CLI.
    expect(cli.requests.map((request) => request.subtype)).toEqual([
      'ui_render',
    ]);
  });

  // The ui_scroll and ui_focus shapes the 06c contract pins (2.1.319).
  const SCROLL = {
    kind: 'scroll',
    site: 'pane',
    instanceId: 'ping',
    by: 2,
    bodyRows: 5,
    contentRows: 20,
  } as const;

  it("sends the person's scrolls and keyboard moves, and follows a hook's rewrite", async () => {
    const cli = fakeCli((request) => {
      if (request.subtype === 'ui_panes') return ROSTER;
      if (request.subtype === 'ui_render') return { tree: BAND, hooked: true };
      if (request.subtype === 'ui_scroll') {
        // A hook keeps the window on the end from row 8 down.
        return request.offset === 8
          ? { moved: true, offset: 15, follow_end: true }
          : { moved: true, offset: request.offset };
      }
      if (request.subtype === 'ui_focus') {
        // A hook sends the ring from the button to the field.
        return {
          moved: true,
          element: !request.is_held
            ? null
            : request.element === null
              ? null
              : { plugin: 'ping-mod', key: 'note' },
        };
      }
      return {};
    });
    const bridge = new ClaudeModSurfaceBridge(CHAT, true, cli.request);
    bridge.init(INIT);
    await settle();
    cli.requests.length = 0;
    sent.mockClear();

    await bridge.command({ ...SCROLL, offset: 2 });
    await bridge.command({ ...SCROLL, offset: 8, by: 6 });
    await bridge.command({
      kind: 'focus',
      site: 'pane',
      instanceId: 'ping',
      isHeld: true,
      element: { plugin: 'ping-mod', key: 'inc' },
    });
    await bridge.command({
      kind: 'focus',
      site: 'pane',
      instanceId: 'ping',
      isHeld: false,
      element: null,
    });
    expect(cli.requests).toEqual([
      {
        subtype: 'ui_scroll',
        component: 'Pane',
        instance_id: 'ping',
        offset: 2,
        by: 2,
        body_rows: 5,
        content_rows: 20,
        surface: 'desktop',
        client_id: 'canopy-desktop',
      },
      expect.objectContaining({ subtype: 'ui_scroll', offset: 8, by: 6 }),
      {
        subtype: 'ui_focus',
        component: 'Pane',
        instance_id: 'ping',
        is_held: true,
        element: { plugin: 'ping-mod', key: 'inc' },
        surface: 'desktop',
        client_id: 'canopy-desktop',
      },
      // A release names no element, so it moves no ring.
      {
        subtype: 'ui_focus',
        component: 'Pane',
        instance_id: 'ping',
        is_held: false,
        surface: 'desktop',
        client_id: 'canopy-desktop',
      },
    ]);
    // Only the rewritten scroll and the redirected ring come back.
    expect(pushes()).toEqual([
      {
        ...CHAT,
        push: {
          kind: 'scroll',
          site: 'pane',
          instanceId: 'ping',
          offset: 15,
          followEnd: true,
        },
      },
      {
        ...CHAT,
        push: {
          kind: 'focus',
          site: 'pane',
          instanceId: 'ping',
          element: { plugin: 'ping-mod', key: 'note' },
        },
      },
    ]);

    // The content height reported rides the site's next draw.
    cli.requests.length = 0;
    bridge.receive({
      type: 'system',
      subtype: 'ui_invalidate',
      event: 'ui.render',
    });
    await settle();
    expect(
      cli.requests.find((request) => request.component === 'Pane'),
    ).toMatchObject({ content_rows: 20 });
  });

  it('lets only the latest scroll or focus report of a site move it', async () => {
    const answers: Array<(response: unknown) => void> = [];
    const requests: Record<string, unknown>[] = [];
    const bridge = new ClaudeModSurfaceBridge(CHAT, true, (request) => {
      requests.push(request);
      if (request.subtype === 'ui_attach') {
        return Promise.resolve({ subtype: 'success', response: {} });
      }
      if (request.subtype === 'ui_panes') {
        return Promise.resolve({ subtype: 'success', response: ROSTER });
      }
      if (request.subtype !== 'ui_scroll' && request.subtype !== 'ui_focus') {
        return Promise.resolve({
          subtype: 'success',
          response: { tree: BAND, hooked: true },
        });
      }
      return new Promise((done) => {
        answers.push((response) => done({ subtype: 'success', response }));
      });
    });
    bridge.init(INIT);
    await settle();
    sent.mockClear();
    const first = bridge.command({ ...SCROLL, offset: 2 });
    const second = bridge.command({ ...SCROLL, offset: 4 });
    await settle();
    // The first answer lands after the person scrolled on: it moves nothing.
    answers[0]?.({ moved: false, offset: 0, deny: 'held' });
    answers[1]?.({ moved: true, offset: 3 });
    await Promise.all([first, second]);
    // Two focus reports answered in reverse order: the older redirect is late.
    const focus = (key: string): Promise<void> =>
      bridge.command({
        kind: 'focus',
        site: 'pane',
        instanceId: 'ping',
        isHeld: true,
        element: { plugin: 'ping-mod', key },
      });
    const older = focus('inc');
    const newer = focus('pick');
    await settle();
    answers[3]?.({ moved: true, element: { plugin: 'ping-mod', key: 'note' } });
    answers[2]?.({
      moved: true,
      element: { plugin: 'ping-mod', key: 'inc-2' },
    });
    await Promise.all([older, newer]);
    expect(pushes()).toEqual([
      {
        ...CHAT,
        push: {
          kind: 'scroll',
          site: 'pane',
          instanceId: 'ping',
          offset: 3,
          followEnd: false,
        },
      },
      {
        ...CHAT,
        push: {
          kind: 'focus',
          site: 'pane',
          instanceId: 'ping',
          element: { plugin: 'ping-mod', key: 'note' },
        },
      },
    ]);
  });

  it("forwards a Mod's scroll and focus pushes to this client's chat only", async () => {
    const cli = fakeCli();
    const bridge = new ClaudeModSurfaceBridge(CHAT, true, cli.request);
    const site = {
      type: 'system',
      client_id: 'canopy-desktop',
      component: 'Pane',
      instance_id: 'ping',
      uuid: 'u',
      session_id: 's',
    };
    // Before the surface attaches, a site push has no site to move.
    bridge.receive({ ...site, subtype: 'ui_scroll', offset: 15 });
    bridge.init(INIT);
    await settle();
    sent.mockClear();
    bridge.receive({ ...site, subtype: 'ui_scroll', offset: 15 });
    bridge.receive({
      ...site,
      subtype: 'ui_scroll',
      offset: 15,
      follow_end: true,
    });
    bridge.receive({
      ...site,
      subtype: 'ui_focus',
      plugin: 'ping-mod',
      key: 'note',
    });
    bridge.receive({
      ...site,
      subtype: 'ui_scroll',
      offset: 3,
      client_id: 'other',
    });
    bridge.receive({ ...site, subtype: 'ui_scroll', offset: -1 });
    bridge.receive({
      ...site,
      subtype: 'ui_focus',
      component: 'Prompt',
      plugin: 'ping-mod',
      key: 'note',
    });
    expect(pushes()).toEqual([
      {
        ...CHAT,
        push: {
          kind: 'scroll',
          site: 'pane',
          instanceId: 'ping',
          offset: 15,
          followEnd: false,
        },
      },
      {
        ...CHAT,
        push: {
          kind: 'scroll',
          site: 'pane',
          instanceId: 'ping',
          offset: 15,
          followEnd: true,
        },
      },
      {
        ...CHAT,
        push: {
          kind: 'focus',
          site: 'pane',
          instanceId: 'ping',
          element: { plugin: 'ping-mod', key: 'note' },
        },
      },
    ]);
  });

  it('sends its current surface again when a client asks, and only what is still up', async () => {
    const cli = fakeCli((request) => {
      if (request.subtype === 'ui_panes') return ROSTER;
      if (request.subtype === 'ui_render') return { tree: BAND, hooked: true };
      return {};
    });
    const bridge = new ClaudeModSurfaceBridge(CHAT, true, cli.request);
    bridge.init(INIT);
    bridge.receive({ ...TOAST, subtype: 'ui_status', text: 'ping status' });
    bridge.receive({
      ...TOAST,
      subtype: 'ui_status',
      plugin: 'gone-mod',
      text: 'gone',
    });
    bridge.receive({
      ...TOAST,
      subtype: 'ui_status',
      plugin: 'gone-mod',
      text: null,
    });
    await settle();
    sent.mockClear();
    cli.requests.length = 0;
    await bridge.command({ kind: 'resend' });
    const tree = validateExtensionUiTree(BAND).tree;
    expect(pushes().slice(0, 2)).toEqual([
      {
        ...CHAT,
        push: { kind: 'status', plugin: 'ping-mod', text: 'ping status' },
      },
      {
        ...CHAT,
        push: {
          kind: 'panes',
          roster: {
            panes: [{ id: 'ping', title: 'Ping', plugin: 'ping-mod' }],
            shownId: 'ping',
            focusedId: null,
            focusRequestedId: null,
          },
        },
      },
    ]);
    // Each site's last tree, in the order the sites were drawn.
    expect(pushes().slice(2)).toHaveLength(2);
    expect(pushes().slice(2)).toEqual(
      expect.arrayContaining([
        {
          ...CHAT,
          push: {
            kind: 'tree',
            site: 'band',
            instanceId: 'above-prompt',
            tree,
          },
        },
        {
          ...CHAT,
          push: { kind: 'tree', site: 'pane', instanceId: 'ping', tree },
        },
      ]),
    );
    // Nothing is asked of the CLI; a closed pane's tree is not sent again.
    expect(cli.requests).toEqual([]);
    bridge.receive({
      ...ROSTER,
      type: 'system',
      subtype: 'ui_panes',
      panes: [],
    });
    sent.mockClear();
    await bridge.command({ kind: 'resend' });
    expect(
      pushes()
        .filter(isPushEvent)
        .filter((event) => event.push.kind === 'tree')
        .map((event) => (event.push.kind === 'tree' ? event.push.site : '')),
    ).toEqual(['band']);
  });

  it('attaches once per CLI process, although every turn sends a root init', async () => {
    const cli = fakeCli();
    const bridge = new ClaudeModSurfaceBridge(CHAT, true, cli.request);
    bridge.init(INIT);
    await settle();
    cli.requests.length = 0;
    sent.mockClear();

    bridge.init(INIT);
    await settle();
    expect(cli.requests).toEqual([]);
    expect(sent).not.toHaveBeenCalled();

    // A restarted process attaches again at its own first init.
    bridge.restart();
    bridge.init(INIT);
    await settle();
    expect(cli.requests[0]).toMatchObject({ subtype: 'ui_attach' });
  });

  it('never lets an older render replace a newer one, or an ended surface take down the current one', async () => {
    type Pending = {
      request: Record<string, unknown>;
      resolve: (response: unknown) => void;
      reject: (error: Error) => void;
    };
    const renders: Pending[] = [];
    const requests: Record<string, unknown>[] = [];
    const request = (call: Record<string, unknown>): Promise<unknown> => {
      requests.push(call);
      if (call.subtype !== 'ui_render') {
        return Promise.resolve({ subtype: 'success', response: {} });
      }
      return new Promise((resolve, reject) => {
        renders.push({
          request: call,
          resolve: (response) => resolve({ subtype: 'success', response }),
          reject,
        });
      });
    };
    const bandText = (text: string): unknown => ({
      type: 'Text',
      children: [text],
    });
    const bandPushes = (): unknown[] =>
      pushes().flatMap((event) => {
        if (!isPushEvent(event)) return [];
        const { push } = event;
        return push.kind === 'tree' && push.site === 'band' ? [push.tree] : [];
      });

    const bridge = new ClaudeModSurfaceBridge(CHAT, true, request);
    bridge.init(INIT);
    await settle();
    bridge.receive({
      type: 'system',
      subtype: 'ui_invalidate',
      instances: [{ component: 'AbovePrompt', instance_id: 'above-prompt' }],
    });
    await settle();
    expect(renders).toHaveLength(2);
    sent.mockClear();
    renders[1]?.resolve({ tree: bandText('newer'), hooked: true });
    renders[0]?.resolve({ tree: bandText('older'), hooked: true });
    await settle();
    expect(bandPushes()).toEqual([
      validateExtensionUiTree(bandText('newer')).tree,
    ]);

    // A render left over from the process before a restart fails late.
    bridge.receive({
      type: 'system',
      subtype: 'ui_invalidate',
      instances: [{ component: 'AbovePrompt', instance_id: 'above-prompt' }],
    });
    await settle();
    const stale = renders[2];
    bridge.restart();
    bridge.init(INIT);
    await settle();
    renders[3]?.resolve({ tree: bandText('current'), hooked: true });
    await settle();
    sent.mockClear();
    stale?.reject(new Error('process exited'));
    await settle();
    expect(sent).not.toHaveBeenCalled();
    requests.length = 0;
    await bridge.command({ kind: 'pane-show', paneId: 'ping' });
    expect(requests).toEqual([
      expect.objectContaining({ subtype: 'ui_pane_show', id: 'ping' }),
    ]);
  });

  it('falls back to M1 when a request fails, and a failed press changes nothing', async () => {
    let failRender = false;
    const cli = fakeCli((request) => {
      if (request.subtype === 'ui_press') return new Error('stale handle');
      if (request.subtype === 'ui_render' && failRender)
        return new Error('gone');
      return request.subtype === 'ui_render'
        ? { tree: BAND, hooked: true }
        : {};
    });
    const bridge = new ClaudeModSurfaceBridge(CHAT, true, cli.request);
    bridge.init(INIT);
    await settle();

    await bridge.command({
      kind: 'press',
      press: { plugin: 'ping-mod', handle: 3 },
      key: 'press-me',
    });
    expect(cli.requests.at(-1)).toEqual({
      subtype: 'ui_press',
      plugin: 'ping-mod',
      handle: 3,
      key: 'press-me',
      // Names the press, so a fill its handler makes can name its Mod (M3).
      press_id: ANY_ID,
      surface: 'desktop',
      client_id: 'canopy-desktop',
    });
    await bridge.command({ kind: 'pane-close', paneId: 'ping' });
    expect(cli.requests.at(-1)).toEqual({
      subtype: 'ui_close',
      id: 'ping',
      client_id: 'canopy-desktop',
    });

    failRender = true;
    sent.mockClear();
    bridge.receive({
      type: 'system',
      subtype: 'ui_invalidate',
      instances: [{ component: 'AbovePrompt', instance_id: 'above-prompt' }],
    });
    await settle();
    expect(pushes()).toEqual([
      {
        ...CHAT,
        push: {
          kind: 'tree',
          site: 'band',
          instanceId: 'above-prompt',
          tree: null,
        },
      },
      {
        ...CHAT,
        push: {
          kind: 'panes',
          roster: {
            panes: [],
            shownId: null,
            focusedId: null,
            focusRequestedId: null,
          },
          // The panes ended with the surface; their Mods did not close them.
          reset: true,
        },
      },
    ]);

    // Back on M1: no more requests, and the Mod's pushes still arrive.
    cli.requests.length = 0;
    sent.mockClear();
    bridge.receive({ type: 'system', subtype: 'ui_invalidate', instances: [] });
    await bridge.command({ kind: 'pane-show', paneId: 'ping' });
    bridge.receive(TOAST);
    await settle();
    expect(cli.requests).toEqual([]);
    expect(pushes()).toHaveLength(1);
  });

  it('sends no request unless both flags are on and the CLI speaks the surface', async () => {
    const cli = fakeCli();
    mockSurfaceFlag = false;
    new ClaudeModSurfaceBridge(CHAT, true, cli.request).init(INIT);
    mockSurfaceFlag = true;
    new ClaudeModSurfaceBridge(CHAT, false, cli.request).init(INIT);
    new ClaudeModSurfaceBridge(CHAT, true, cli.request).init({
      ...INIT,
      capabilities: ['msg_lifecycle_v1'],
    });
    await settle();
    expect(cli.requests).toEqual([]);
  });
});

it('forwards a valid claude-mods:surface-command to its chat session only', async () => {
  registerClaudeModsHandlers();
  const handler = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.claudeModSurfaceCommand,
    )?.[1];
  if (!handler) throw new Error('No surface command handler');
  const bridge = new ClaudeModSurfaceBridge(CHAT, true);
  const command = jest.spyOn(bridge, 'command').mockResolvedValue();
  const send = (args: unknown): Promise<unknown> =>
    Promise.resolve(Reflect.apply(handler, undefined, [{}, args]));

  await send({ ...CHAT, command: { kind: 'pane-close', paneId: 'ping' } });
  expect(command).toHaveBeenCalledWith({ kind: 'pane-close', paneId: 'ping' });

  command.mockClear();
  await send({
    ...CHAT,
    chatId: 'other',
    command: { kind: 'pane-close', paneId: 'ping' },
  });
  await expect(
    send({ ...CHAT, command: { kind: 'pane-close', paneId: '../x' } }),
  ).rejects.toThrow('Invalid Claude Mod surface command.');
  await expect(
    send({
      ...CHAT,
      projectId: '../escape',
      command: { kind: 'pane-close', paneId: 'ping' },
    }),
  ).rejects.toThrow();
  expect(command).not.toHaveBeenCalled();
});

describe('composer answers (M3)', () => {
  const PANE_ROSTER = {
    panes: [{ id: 'ping', title: 'Ping', plugin: 'ping-mod' }],
    shown_id: null,
    focused_id: null,
    focus_requested_id: null,
  };
  const PRESS = { plugin: 'ping-mod', handle: 7 };
  const signal = new AbortController().signal;

  async function attached(): Promise<{
    bridge: ClaudeModSurfaceBridge;
    host: () => ClaudeModUiHost;
    hosts: (ClaudeModUiHost | undefined)[];
    requests: Record<string, unknown>[];
  }> {
    const requests: Record<string, unknown>[] = [];
    const hosts: (ClaudeModUiHost | undefined)[] = [];
    const bridge = new ClaudeModSurfaceBridge(
      CHAT,
      true,
      (request) => {
        requests.push(request);
        const response =
          request.subtype === 'ui_panes'
            ? PANE_ROSTER
            : request.subtype === 'ui_render'
              ? { tree: null, hooked: false }
              : {};
        return Promise.resolve({ subtype: 'success', response });
      },
      (host) => void hosts.push(host),
    );
    bridge.init(INIT);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    const host = (): ClaudeModUiHost => {
      const current = hosts.at(-1);
      if (current === undefined) throw new Error('No UI host');
      return current;
    };
    return { bridge, host, hosts, requests };
  }

  /** The composer requests the bridge sent its windows. */
  const asked = (): { requestId: string; request: unknown }[] =>
    sent.mock.calls.flatMap(([, event]) => {
      const push = (event as { push?: Record<string, unknown> }).push;
      return push?.kind === 'composer-request'
        ? [{ requestId: String(push.requestId), request: push.request }]
        : [];
    });
  const askedId = (index: number): string => {
    const ask = asked()[index];
    if (ask === undefined) throw new Error(`No composer request ${index}`);
    return ask.requestId;
  };
  const answer = (
    bridge: ClaudeModSurfaceBridge,
    requestId: string,
    composerAnswer: unknown,
  ): Promise<void> =>
    bridge.command({
      kind: 'composer-answer',
      requestId,
      answer: composerAnswer as never,
    });
  const activity = (): unknown[] =>
    sent.mock.calls.flatMap(([, event]) => {
      const push = (event as { push?: Record<string, unknown> }).push;
      return push?.kind === 'composer-activity' ? [push] : [];
    });

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('names the composer answers only with a UI host, and removes the host on close', async () => {
    const { bridge, hosts, requests } = await attached();
    expect(requests[0]).toMatchObject({
      subtype: 'ui_attach',
      answers: [
        'ui_copy',
        'ui_prompt_read',
        'ui_prompt_fill',
        'ui_read_selection',
      ],
    });
    expect(hosts).toHaveLength(1);
    bridge.close();
    expect(hosts.at(-1)).toBeUndefined();
  });

  it("answers a read with the chat window's draft, and shows reads once a minute", async () => {
    const { bridge, host } = await attached();
    sent.mockClear();
    const read = host().promptRead(
      { surface: 'desktop', client_id: 'canopy-desktop' },
      { signal },
    );
    expect(asked()).toEqual([{ requestId: ANY_ID, request: { kind: 'read' } }]);
    await answer(bridge, askedId(0), {
      kind: 'read',
      text: 'my draft',
      cursor: 3,
    });
    await expect(read).resolves.toEqual({ text: 'my draft', cursor: 3 });
    expect(activity()).toEqual([
      { kind: 'composer-activity', action: 'read', plugin: null },
    ]);

    const again = host().promptRead({}, { signal });
    await answer(bridge, askedId(1), {
      kind: 'read',
      text: 'x',
      cursor: 1,
    });
    await again;
    expect(activity()).toHaveLength(1);

    // No window shows the chat: the bridge's 3 s setTimeout answers the
    // empty box, before the CLI's 5 s run out.
    const unanswered = host().promptRead({}, { signal });
    jest.advanceTimersByTime(3000);
    await expect(unanswered).resolves.toEqual({ text: '', cursor: 0 });
  });

  it('fills the draft through the window, naming the Mod whose press asked', async () => {
    const { bridge, host, requests } = await attached();
    await bridge.command({ kind: 'press', press: PRESS, key: 'fill' });
    const press = requests.find((request) => request.subtype === 'ui_press');
    expect(press).toMatchObject({
      plugin: 'ping-mod',
      handle: 7,
      press_id: ANY_ID,
    });
    sent.mockClear();

    const fill = host().promptFill(
      { text: 'hello', mode: 'append', answers_press: press?.press_id },
      { signal },
    );
    expect(asked()).toEqual([
      {
        requestId: ANY_ID,
        request: { kind: 'fill', text: 'hello', mode: 'append' },
      },
    ]);
    await answer(bridge, askedId(0), { kind: 'fill', filled: true });
    await expect(fill).resolves.toEqual({ filled: true });
    expect(activity()).toEqual([
      { kind: 'composer-activity', action: 'fill', plugin: 'ping-mod' },
    ]);

    // A hook's fill names no Mod; a refused fill shows nothing.
    const hooked = host().promptFill(
      { text: 'x', mode: 'replace', cursor: 0 },
      { signal },
    );
    await answer(bridge, askedId(1), { kind: 'fill', filled: true });
    await hooked;
    const refused = host().promptFill(
      { text: 'y', mode: 'insert' },
      { signal },
    );
    await answer(bridge, askedId(2), {
      kind: 'fill',
      filled: false,
    });
    await expect(refused).resolves.toEqual({ filled: false });
    expect(activity().slice(1)).toEqual([
      { kind: 'composer-activity', action: 'fill', plugin: null },
    ]);
  });

  it('refuses a malformed fill without asking, and ignores an answer of another kind', async () => {
    const { bridge, host } = await attached();
    sent.mockClear();
    await expect(
      host().promptFill({ text: 'x', mode: 'over' }, { signal }),
    ).resolves.toEqual({ filled: false });
    expect(asked()).toEqual([]);

    const fill = host().promptFill({ text: 'x', mode: 'append' }, { signal });
    await answer(bridge, askedId(0), {
      kind: 'read',
      text: '',
      cursor: 0,
    });
    jest.advanceTimersByTime(3000);
    await expect(fill).resolves.toEqual({ filled: false });
  });

  it('copies through the window and reads the selection in its transcript', async () => {
    const { bridge, host } = await attached();
    sent.mockClear();
    const copy = host().copy(
      { plugin: 'ping-mod', text: 'copied text' },
      { signal },
    );
    expect(asked()[0]?.request).toEqual({
      kind: 'copy',
      plugin: 'ping-mod',
      text: 'copied text',
    });
    await answer(bridge, askedId(0), { kind: 'copy', copied: true });
    await expect(copy).resolves.toEqual({ copied: true });
    expect(activity()).toEqual([
      { kind: 'composer-activity', action: 'copy', plugin: 'ping-mod' },
    ]);

    const selected = host().readSelection({}, { signal });
    await answer(bridge, askedId(1), {
      kind: 'selection',
      text: 'a quote',
    });
    await expect(selected).resolves.toEqual({ text: 'a quote' });
    const none = host().readSelection({}, { signal });
    await answer(bridge, askedId(2), {
      kind: 'selection',
      text: null,
    });
    await expect(none).resolves.toEqual({});
  });

  it('leaves the UI host alone on close when it never installed one', () => {
    // As a session whose query was never made: removing a host there throws.
    const setUiHost = jest.fn(() => {
      throw new ReferenceError('queryResult is not initialized');
    });
    const bridge = new ClaudeModSurfaceBridge(
      CHAT,
      true,
      () => Promise.resolve({}),
      setUiHost,
    );
    expect(() => bridge.close()).not.toThrow();
    expect(setUiHost).not.toHaveBeenCalled();
  });

  it('gives each composer request a deadline before its 3 s run out', async () => {
    const { host } = await attached();
    sent.mockClear();
    const before = Date.now();
    void host().promptRead({}, { signal });
    const push = sent.mock.calls
      .map(
        ([, event]) =>
          (event as { push?: { kind?: string; expiresAt?: number } }).push,
      )
      .find((candidate) => candidate?.kind === 'composer-request');
    expect(push?.expiresAt).toBeGreaterThan(before);
    expect(push?.expiresAt).toBeLessThan(before + 3000);
  });

  it('withdraws a request from its windows when the CLI cancels it', async () => {
    const { bridge, host } = await attached();
    sent.mockClear();
    const cancel = new AbortController();
    const fill = host().promptFill(
      { text: 'x', mode: 'append' },
      { signal: cancel.signal },
    );
    const requestId = askedId(0);
    cancel.abort();
    await expect(fill).resolves.toEqual({ filled: false });
    expect(sent.mock.calls.map(([, event]) => event)).toContainEqual({
      ...CHAT,
      push: { kind: 'composer-withdraw', requestId },
    });
    // A window's late answer is ignored, as before.
    await answer(bridge, requestId, { kind: 'fill', filled: true });
    expect(activity()).toEqual([]);
  });

  it('answers empty once the surface ends, and never asks a window then', async () => {
    const { bridge, host } = await attached();
    const ended = host();
    sent.mockClear();
    const pending = ended.promptRead({}, { signal });
    bridge.close();
    await expect(pending).resolves.toEqual({ text: '', cursor: 0 });
    await expect(ended.promptRead({}, { signal })).resolves.toEqual({
      text: '',
      cursor: 0,
    });
    expect(asked()).toHaveLength(1);
  });
});
