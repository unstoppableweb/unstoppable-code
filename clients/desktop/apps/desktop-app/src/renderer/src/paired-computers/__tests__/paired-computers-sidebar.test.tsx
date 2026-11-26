/** @jest-environment jsdom */
import '../../cloud-chats/__tests__/jsdom-globals';
import { act, createElement, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionViewModel } from '@canopy/app-core';
import { createProjectGrouper } from '@canopy/desktop-shared/lib/project-groups';
import type {
  PairedComputerHoldResult,
  PairedComputerState,
  PairedComputerUpdate,
  PairedComputersApi,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import type {
  WorktreeRowOverrides,
  WorktreeRowSlotContext,
} from '@canopy/ui-app';
import {
  PairedComputersSidebarFollower,
  pairedSidebarStore,
} from '../paired-computers-sidebar-store';
import {
  appendPairedSidebarRows,
  createPairedSidebarRowsBuilder,
} from '../paired-sidebar-rows';
import {
  PairedComputerStatusRows,
  usePairedWorktreeRowOverrides,
} from '../usePairedComputersSidebar';

const MAC = 'Mb8kQz3Vh2xN0pRt5LwY7a';
const LINUX = 'Lx4_Tn9-Wd2Kc7Hs1Qe6Zb';
const ORG = '7b7e9f62-6a1c-4d0e-9a51-3f6c2d1e8a40';
const ORG_PROJECT = '5d2f1a3b-8c4e-4f6a-9b7d-1e2c3a4b5c6d';

const CONNECTED: PairedComputerState = {
  status: 'connected',
  version: { protocolVersion: 26, appVersion: '1.24.0' },
  capabilities: ['approvals', 'chats', 'composer', 'sidebar'],
};

const LOCAL_STOREFRONT: SingleRepoSidebarItem = {
  type: 'single-repo',
  id: 'storefront',
  name: 'storefront',
  repoPath: '/repos/storefront',
  color: '#3B82F6',
  collapsed: false,
  order: 0,
  worktrees: [],
  owner: {
    type: 'organization',
    organizationId: ORG,
    projectId: ORG_PROJECT,
    instanceId: '0c9a7e51-3d2b-4f18-8e6a-5b4c3d2e1f00',
    bindingGeneration: 1,
  },
};
const LOCAL_DOCS: SingleRepoSidebarItem = {
  type: 'single-repo',
  id: 'docs',
  name: 'docs',
  repoPath: '/repos/docs',
  color: '#10B981',
  collapsed: false,
  order: 1,
  worktrees: [],
};

const LOCAL_SNAPSHOT: Pick<SessionViewModel, 'workspaces' | 'worktrees'> = {
  workspaces: [
    {
      localId: 'storefront',
      name: 'storefront',
      type: 'single-repo',
      order: 0,
    },
    { localId: 'docs', name: 'docs', type: 'single-repo', order: 1 },
  ],
  worktrees: [
    {
      localId: 'csv-export',
      workspaceLocalId: 'storefront',
      branch: 'csv-export',
      order: 0,
    },
  ],
};

/** A paired computer's `desktop:session-snapshot`, as it sends one. */
function macSnapshot(
  task: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    workspaces: [
      {
        localId: 'shop',
        name: 'storefront',
        type: 'single-repo',
        owner: {
          type: 'organization',
          organizationId: ORG,
          projectId: ORG_PROJECT,
        },
      },
      // Personal, with no address sent: it can't be matched, so it lists as
      // its own project even though this computer has one named the same.
      { localId: 'docs-remote', name: 'docs', type: 'single-repo' },
      // A flat (Chats) project lists no tasks from paired computers yet.
      { localId: 'chats', name: 'Personal', type: 'cowork' },
    ],
    worktrees: [
      {
        localId: 'fix-upload',
        workspaceLocalId: 'shop',
        branch: 'fix-upload',
        label: 'Fix flaky upload test',
        order: 0,
        ...task,
      },
      {
        localId: 'search',
        workspaceLocalId: 'docs-remote',
        branch: 'search',
        order: 0,
      },
      { localId: 'chat-1', workspaceLocalId: 'chats', branch: 'cloud' },
    ],
  };
}

interface FakeApi {
  readonly api: PairedComputersApi;
  readonly invoke: jest.Mock;
  readonly release: jest.Mock;
  readonly hold: jest.Mock;
  readonly localProjectFacts: jest.Mock;
  state(deviceId: string, state: PairedComputerState): void;
  update(deviceId: string, update: PairedComputerUpdate): void;
  /** Answers held calls in the order they were made. */
  readonly pendingHolds: Map<
    string,
    (result: PairedComputerHoldResult) => void
  >;
}

function fakeApi(
  replies: (deviceId: string) => Promise<unknown> = () =>
    Promise.resolve(macSnapshot()),
  { autoHold = true }: { autoHold?: boolean } = {},
): FakeApi {
  const states = new Map<string, Set<(state: PairedComputerState) => void>>();
  const updates = new Map<
    string,
    Set<(update: PairedComputerUpdate) => void>
  >();
  const pendingHolds = new Map<
    string,
    (result: PairedComputerHoldResult) => void
  >();
  const invoke = jest.fn((deviceId: string) => replies(deviceId));
  const release = jest.fn((): Promise<void> => Promise.resolve());
  const hold = jest.fn(
    (deviceId: string): Promise<PairedComputerHoldResult> =>
      autoHold
        ? Promise.resolve({ holdId: `hold-${deviceId}`, state: CONNECTED })
        : new Promise((resolve) => pendingHolds.set(deviceId, resolve)),
  );
  const localProjectFacts = jest.fn(() => Promise.resolve({}));
  const listen = <T,>(
    map: Map<string, Set<(value: T) => void>>,
    deviceId: string,
    listener: (value: T) => void,
  ): (() => void) => {
    const set = map.get(deviceId) ?? new Set();
    set.add(listener);
    map.set(deviceId, set);
    return () => set.delete(listener);
  };
  const api: PairedComputersApi = {
    hold,
    release,
    invoke,
    send: jest.fn(),
    getState: jest.fn(() => Promise.resolve(CONNECTED)),
    onUpdate: (deviceId, listener) => listen(updates, deviceId, listener),
    onStateChanged: (deviceId, listener) => listen(states, deviceId, listener),
    localProjectFacts,
  };
  return {
    api,
    invoke,
    release,
    hold,
    localProjectFacts,
    pendingHolds,
    state: (deviceId, state) => {
      for (const listener of states.get(deviceId) ?? []) listener(state);
    },
    update: (deviceId, update) => {
      for (const listener of updates.get(deviceId) ?? []) listener(update);
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function rowsFor(
  build: ReturnType<typeof createPairedSidebarRowsBuilder>,
): ReturnType<ReturnType<typeof createPairedSidebarRowsBuilder>> {
  return build({
    localProjects: [LOCAL_STOREFRONT, LOCAL_DOCS],
    localFacts: null,
    accountId: null,
    computers: pairedSidebarStore.getState().structures,
  });
}

function rowContext(
  workspaceLocalId: string,
  localId: string,
): WorktreeRowSlotContext {
  return {
    workspace: {
      localId: workspaceLocalId,
      name: 'storefront',
      type: 'single-repo',
    },
    worktree: { localId, workspaceLocalId, branch: localId },
  } as unknown as WorktreeRowSlotContext;
}

/** Renders the row override hook for one row; returns its latest result and the render count. */
function renderOverrides(context: WorktreeRowSlotContext): {
  current: () => WorktreeRowOverrides | undefined;
  renders: () => number;
  root: Root;
} {
  let latest: WorktreeRowOverrides | undefined;
  let count = 0;
  function Probe(): null {
    latest = usePairedWorktreeRowOverrides(context);
    count += 1;
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => {
    root.render(createElement(Probe));
  });
  return { current: () => latest, renders: () => count, root };
}

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

let follower: PairedComputersSidebarFollower | null = null;
afterEach(() => {
  follower?.dispose();
  follower = null;
});

describe("paired computers' tasks in the main window's sidebar (CAN-7766)", () => {
  it("lists a computer's tasks under the matching project after the local ones, and a project only there as its own, never by name", async () => {
    const fake = fakeApi();
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([{ deviceId: MAC, name: 'MacBook Pro' }]);
    await settle();

    expect(fake.hold).toHaveBeenCalledWith(MAC);
    // The snapshot is read with no qualified id and no selector.
    expect(fake.invoke).toHaveBeenCalledWith(MAC, 'desktop:session-snapshot', [
      {},
    ]);
    const build = createPairedSidebarRowsBuilder(createProjectGrouper());
    const rows = rowsFor(build);
    const merged = appendPairedSidebarRows(LOCAL_SNAPSHOT, rows);

    // The org project matches by its identity: the task joins this
    // computer's storefront, after its local task.
    const storefront = merged.worktrees.filter(
      (worktree) => worktree.workspaceLocalId === 'storefront',
    );
    expect(storefront.map((worktree) => worktree.localId)).toEqual([
      'csv-export',
      `computer-${MAC}:fix-upload`,
    ]);
    expect(storefront[1]?.order ?? 0).toBeGreaterThan(
      storefront[0]?.order ?? 0,
    );
    expect(storefront[1]).toMatchObject({ label: 'Fix flaky upload test' });
    // Live status never rides on the list's rows; each row reads its own.
    expect(storefront[1]).not.toHaveProperty('isStreaming');

    // The Personal docs copy sent no address, so it is its own project,
    // after every local one, named for its computer; nothing merged it with
    // this computer's docs.
    const remoteDocs = `computer-${MAC}:docs-remote`;
    expect(merged.workspaces.map((workspace) => workspace.localId)).toEqual([
      'storefront',
      'docs',
      remoteDocs,
    ]);
    expect(merged.workspaces[2]).toMatchObject({
      name: 'docs on MacBook Pro',
      type: 'single-repo',
      layout: 'tree',
    });
    expect(
      merged.worktrees.find(
        (worktree) => worktree.localId === `computer-${MAC}:search`,
      )?.workspaceLocalId,
    ).toBe(remoteDocs);
    expect(rows.projects.get(remoteDocs)).toMatchObject({
      onlyOnPairedComputers: true,
      deviceIds: [MAC],
    });
    expect(rows.projects.get(remoteDocs)?.notSent.get(MAC)).toEqual([
      'identity',
      'repository-address',
    ]);
    expect(rows.projects.get('storefront')).toMatchObject({
      onlyOnPairedComputers: false,
    });
    // The flat Chats project is not listed from a paired computer yet.
    expect(
      merged.worktrees.some((worktree) => worktree.localId.endsWith(':chat-1')),
    ).toBe(false);
    // Unchanged input gives the same rows object back.
    expect(rowsFor(build)).toBe(rows);
  });

  it('keeps a task status live without rebuilding any list row, and one computer never rebuilds another', async () => {
    let macTask: Record<string, unknown> = {};
    const fake = fakeApi((deviceId) =>
      Promise.resolve(deviceId === MAC ? macSnapshot(macTask) : macSnapshot()),
    );
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([
      { deviceId: MAC, name: 'MacBook Pro' },
      { deviceId: LINUX, name: 'Linux workstation' },
    ]);
    await settle();
    const build = createPairedSidebarRowsBuilder(createProjectGrouper());
    const rows = rowsFor(build);
    const linux = pairedSidebarStore.getState().computers.get(LINUX);
    const probe = renderOverrides(
      rowContext('storefront', `computer-${MAC}:fix-upload`),
    );
    const local = renderOverrides(rowContext('storefront', 'csv-export'));
    expect(probe.current()).toMatchObject({ unavailable: false });
    expect(probe.current()?.isStreaming).toBeUndefined();

    // The task starts on the MacBook Pro.
    macTask = { isStreaming: true };
    await act(async () => {
      fake.update(MAC, {
        type: 'push',
        channel: 'desktop:session-snapshot-stale',
        args: [],
      });
      await settle();
    });
    expect(probe.current()).toMatchObject({
      isStreaming: true,
      uiStatus: 'working',
    });
    // The list is not rebuilt and the other computer's entry is untouched.
    expect(rowsFor(build)).toBe(rows);
    expect(pairedSidebarStore.getState().computers.get(LINUX)).toBe(linux);
    // A local row does not render for a paired computer's update.
    expect(local.current()).toBeUndefined();
    expect(local.renders()).toBe(1);

    // It finishes, waiting for review.
    macTask = { isStreaming: false, hasUnread: true };
    await act(async () => {
      fake.update(MAC, { type: 'reconnected' });
      await settle();
    });
    expect(probe.current()).toMatchObject({
      isStreaming: false,
      hasUnread: true,
      uiStatus: 'unread',
    });
    macTask = { status: 'done' };
    await act(async () => {
      fake.update(MAC, {
        type: 'push',
        channel: 'desktop:session-snapshot-stale',
        args: [],
      });
      await settle();
    });
    expect(probe.current()).toMatchObject({
      uiStatus: 'done',
      runtimeState: 'done',
    });
    expect(rowsFor(build)).toBe(rows);
    act(() => {
      probe.root.unmount();
      local.root.unmount();
    });
  });

  it('reads one snapshot at a time, so a stale signal mid-read reads once more after it, and a failed read keeps the rows', async () => {
    const answers: Array<(value: unknown) => void> = [];
    const failures: Array<(error: unknown) => void> = [];
    const fake = fakeApi(
      () =>
        new Promise((resolve, reject) => {
          answers.push(resolve);
          failures.push(reject);
        }),
    );
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([{ deviceId: MAC, name: 'MacBook Pro' }]);
    await settle();
    expect(fake.invoke).toHaveBeenCalledTimes(1);
    // Two signals while the first read runs ask for one more read, not two.
    fake.update(MAC, {
      type: 'push',
      channel: 'desktop:session-snapshot-stale',
      args: [],
    });
    fake.update(MAC, { type: 'reconnected' });
    expect(fake.invoke).toHaveBeenCalledTimes(1);
    answers[0]?.(macSnapshot({ label: 'First' }));
    await settle();
    expect(fake.invoke).toHaveBeenCalledTimes(2);
    answers[1]?.(macSnapshot({ label: 'Second' }));
    await settle();
    const tasks = pairedSidebarStore.getState().computers.get(MAC)
      ?.structure?.tasks;
    expect(tasks?.find((task) => task.localId === 'fix-upload')?.label).toBe(
      'Second',
    );

    // A read that fails leaves the rows last read.
    fake.update(MAC, { type: 'reconnected' });
    failures[2]?.(new Error('remote_protocol_mismatch'));
    await settle();
    expect(
      pairedSidebarStore.getState().computers.get(MAC)?.structure?.tasks,
    ).toBe(tasks);
    // A reply that is not a snapshot changes nothing either.
    fake.update(MAC, { type: 'reconnected' });
    answers[3]?.({ refused: true });
    await settle();
    expect(
      pairedSidebarStore.getState().computers.get(MAC)?.structure?.tasks,
    ).toBe(tasks);
  });

  it("marks a connecting or outdated computer's rows unavailable and says why, with one row per computer before any task arrives", async () => {
    const fake = fakeApi(() => Promise.resolve(macSnapshot()), {
      autoHold: false,
    });
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([
      { deviceId: MAC, name: 'MacBook Pro' },
      { deviceId: LINUX, name: 'Linux workstation' },
    ]);
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(createElement(PairedComputerStatusRows));
    });
    // Nothing has arrived: one row per computer, saying why.
    expect(container.textContent).toContain('MacBook Pro');
    expect(container.textContent).toContain('Connecting…');
    await act(async () => {
      fake.pendingHolds.get(LINUX)?.({
        holdId: 'hold-linux',
        state: {
          status: 'needs-update',
          reason: 'computer-too-old',
          computerVersion: null,
          computerAppVersion: '1.10.0',
          thisComputerVersion: { protocolVersion: 26, appVersion: '1.24.0' },
          update: null,
        },
      });
      fake.pendingHolds.get(MAC)?.({ holdId: 'hold-mac', state: CONNECTED });
      await settle();
    });
    expect(container.textContent).toContain('Linux workstation');
    expect(container.textContent).toContain('Needs an update');
    // The MacBook Pro's tasks arrived, so it has no status row now.
    expect(container.textContent).not.toContain('MacBook Pro');

    // It drops and reconnects: its rows stay, unavailable, and say why.
    const probe = renderOverrides(
      rowContext('storefront', `computer-${MAC}:fix-upload`),
    );
    await act(async () => {
      fake.state(MAC, { status: 'connecting' });
      await settle();
    });
    expect(probe.current()).toMatchObject({ unavailable: true });
    expect(probe.current()?.isStreaming).toBeUndefined();
    const marker = document.createElement('div');
    const markerRoot = createRoot(marker);
    act(() => {
      markerRoot.render(
        createElement(
          (): JSX.Element => <>{probe.current()?.trailingIconSlot}</>,
        ),
      );
    });
    expect(
      marker.querySelector('[role="img"]')?.getAttribute('aria-label'),
    ).toBe('On MacBook Pro, connecting');
    expect(marker.querySelector('[role="img"]')?.getAttribute('tabindex')).toBe(
      '0',
    );
    act(() => {
      markerRoot.unmount();
      probe.root.unmount();
      root.unmount();
    });
  });

  it('turning the switch off releases every hold and removes the rows; a hold that answers after is released at once', async () => {
    const fake = fakeApi(() => Promise.resolve(macSnapshot()), {
      autoHold: false,
    });
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([
      { deviceId: MAC, name: 'MacBook Pro' },
      { deviceId: LINUX, name: 'Linux workstation' },
    ]);
    fake.pendingHolds.get(MAC)?.({ holdId: 'hold-mac', state: CONNECTED });
    await settle();
    expect(pairedSidebarStore.getState().computers.size).toBe(2);

    follower.dispose();
    expect(fake.release).toHaveBeenCalledWith('hold-mac');
    expect(pairedSidebarStore.getState().computers.size).toBe(0);
    expect(pairedSidebarStore.getState().structures.size).toBe(0);
    // The Linux workstation's hold answers after the switch went off.
    fake.pendingHolds.get(LINUX)?.({ holdId: 'hold-linux', state: CONNECTED });
    await settle();
    expect(fake.release).toHaveBeenCalledWith('hold-linux');
    expect(fake.invoke).toHaveBeenCalledTimes(1);
    expect(pairedSidebarStore.getState().computers.size).toBe(0);
    // Late events change nothing.
    fake.update(MAC, { type: 'reconnected' });
    expect(fake.invoke).toHaveBeenCalledTimes(1);
  });

  it('a computer unpaired while held leaves at once, and offline or ended computers are not listed or held again', async () => {
    const fake = fakeApi();
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([
      { deviceId: MAC, name: 'MacBook Pro' },
      { deviceId: LINUX, name: 'Linux workstation' },
    ]);
    await settle();
    // Main reports the MacBook Pro unpaired: its rows go, and its hold is let go.
    fake.state(MAC, {
      status: 'unavailable',
      reason: 'not-paired',
      message: null,
    });
    expect(pairedSidebarStore.getState().computers.has(MAC)).toBe(false);
    expect(fake.release).toHaveBeenCalledWith(`hold-${MAC}`);
    // The pairing list catching up holds it no more.
    follower.follow([{ deviceId: LINUX, name: 'Linux workstation' }]);
    expect(fake.hold).toHaveBeenCalledTimes(2);

    // The Linux workstation ends the session on purpose: it is not listed,
    // and is not held again while it stays in the list.
    fake.state(LINUX, {
      status: 'unavailable',
      reason: 'ended',
      message: null,
    });
    follower.follow([{ deviceId: LINUX, name: 'Linux workstation' }]);
    expect(fake.hold).toHaveBeenCalledTimes(2);
    expect(pairedSidebarStore.getState().computers.size).toBe(0);
    // Once it goes offline and comes back, it is held again.
    follower.follow([]);
    follower.follow([{ deviceId: LINUX, name: 'Linux workstation' }]);
    expect(fake.hold).toHaveBeenCalledTimes(3);
  });
});
