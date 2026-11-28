/** @jest-environment jsdom */
import '../../cloud-chats/__tests__/jsdom-globals';
import { act, createElement, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCapabilities, SessionViewModel } from '@canopy/app-core';
import { createProjectGrouper } from '@canopy/desktop-shared/lib/project-groups';
import { maskReplayAttribute } from '@canopy/desktop-instrumentation/client/posthog-replay-masking';
import { sanitizePostHogEvent } from '@canopy/desktop-instrumentation/posthog-privacy';
import { WorkspaceSectionHeader } from '@canopy/ui-shared/components';
import type {
  PairedComputerHoldResult,
  PairedComputerState,
  PairedComputerUpdate,
  PairedComputersApi,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import {
  SidebarSurface,
  WorkspacesSidebarSections,
  type WorktreeRowOverrides,
  type WorktreeRowSlotContext,
} from '@canopy/ui-app';
import {
  partitionWorkspaces,
  partitionWorktrees,
} from '@canopy/ui-app/code/shell/workspace-sections-model';
import { isWorktreeSelectable } from '@canopy/ui-app/code/shell/sidebar/sidebar-row-selection';
import { DESKTOP_SHARED_SIDEBAR_STORAGE_KEY } from '@/components/sidebar/desktop-shared-sidebar-flag';
import {
  applyPairedSnapshot,
  MAX_PAIRED_SNAPSHOT_TASKS,
  MAX_PAIRED_SNAPSHOT_WORKSPACES,
  pairedTaskKey,
  PairedComputersSidebarFollower,
  pairedSidebarStore,
} from '../paired-computers-sidebar-store';
import {
  appendPairedSidebarRows,
  createPairedSidebarRowsBuilder,
  selectDeferredEmptyWorkspaceIds,
} from '../paired-sidebar-rows';
import { pairedSidebarRowCapabilities } from '../paired-sidebar-capabilities';
import {
  collectVisiblePairedDeviceIds,
  PairedComputerStatusRows,
  setPairedProjectCollapsed,
  usePairedSidebarRows,
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
  readonly send: jest.Mock;
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
  // Approvals answer at once with none pending; snapshots as the test says.
  const invoke = jest.fn((deviceId: string, channel: string) =>
    channel === 'approval:pending-requests'
      ? Promise.resolve([])
      : replies(deviceId),
  );
  const release = jest.fn((): Promise<void> => Promise.resolve());
  const hold = jest.fn(
    (deviceId: string): Promise<PairedComputerHoldResult> =>
      autoHold
        ? Promise.resolve({ holdId: `hold-${deviceId}`, state: CONNECTED })
        : new Promise((resolve) => pendingHolds.set(deviceId, resolve)),
  );
  const localProjectFacts = jest.fn(() => Promise.resolve({}));
  const send = jest.fn();
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
    send,
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
    send,
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

function snapshotReads(fake: FakeApi): number {
  return fake.invoke.mock.calls.filter(
    ([, channel]) => channel === 'desktop:session-snapshot',
  ).length;
}

/** Lets every pending reply and the reads they chain run to the end. */
async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
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

const DESKTOP: CanopyCapabilities = {
  localExecution: true,
  terminalPty: true,
  fileSystemAccess: 'read-write',
  voice: true,
  settingsScope: 'full',
  pipelines: 'execute',
  routing: 'in-memory',
  overviewNotifications: true,
  workspaceReordering: true,
  worktreeReordering: true,
  itemGrouping: true,
  worktreePinning: true,
  workspaceSettings: 'full',
  workspaceRemoval: 'archive',
  worktreeRemoval: 'archive',
  worktreeRetention: 'archive-or-delete',
  workspaceMoveToOrganization: true,
  worktreeCreation: true,
  worktreeMetadata: true,
  worktreeBranching: true,
  scriptActions: true,
};

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
    expect(snapshotReads(fake)).toBe(1);
    // Two signals while the first read runs ask for one more read, not two.
    fake.update(MAC, {
      type: 'push',
      channel: 'desktop:session-snapshot-stale',
      args: [],
    });
    fake.update(MAC, { type: 'reconnected' });
    expect(snapshotReads(fake)).toBe(1);
    answers[0]?.(macSnapshot({ label: 'First' }));
    await settle();
    expect(snapshotReads(fake)).toBe(2);
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
    expect(snapshotReads(fake)).toBe(1);
    expect(pairedSidebarStore.getState().computers.size).toBe(0);
    // Late events change nothing.
    fake.update(MAC, { type: 'reconnected' });
    expect(snapshotReads(fake)).toBe(1);
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

  it('shows a task waiting for a tool approval on its computer, read only, and keeps pushes that land during the read', async () => {
    let pendingReply: (value: unknown) => void = () => undefined;
    const fake = fakeApi(() => Promise.resolve(macSnapshot()));
    fake.invoke.mockImplementation((_deviceId: string, channel: string) =>
      channel === 'approval:pending-requests'
        ? new Promise((resolve) => {
            pendingReply = resolve;
          })
        : Promise.resolve(macSnapshot()),
    );
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([{ deviceId: MAC, name: 'MacBook Pro' }]);
    await settle();
    // Read after the snapshot, with no arguments; nothing answers it from here.
    expect(fake.invoke).toHaveBeenCalledWith(
      MAC,
      'approval:pending-requests',
      [],
    );
    const probe = renderOverrides(
      rowContext('storefront', `computer-${MAC}:fix-upload`),
    );
    // A request pushed while the read is in flight survives the reply,
    // which was taken before it.
    await act(async () => {
      fake.update(MAC, {
        type: 'push',
        channel: 'approval:request',
        args: [
          {
            requestId: 'r-2',
            projectId: 'docs-remote',
            worktreeId: 'search',
            chatId: 'c',
          },
        ],
      });
      pendingReply([
        {
          requestId: 'r-1',
          projectId: 'shop',
          worktreeId: 'fix-upload',
          chatId: 'c',
        },
      ]);
      await settle();
    });
    expect(probe.current()).toMatchObject({ hasPendingToolApproval: true });
    expect(
      pairedSidebarStore.getState().computers.get(MAC)?.toolApprovals,
    ).toEqual(
      new Set([
        pairedTaskKey('shop', 'fix-upload'),
        pairedTaskKey('docs-remote', 'search'),
      ]),
    );
    // An approval for the same worktreeId in a different project must not mark
    // this project's task as awaiting approval.
    await act(async () => {
      fake.update(MAC, {
        type: 'push',
        channel: 'approval:request',
        args: [
          {
            requestId: 'r-other',
            projectId: 'other-project',
            worktreeId: 'fix-upload',
            chatId: 'c',
          },
        ],
      });
      await settle();
    });
    // Answered or withdrawn on that computer: the row no longer waits.
    await act(async () => {
      fake.update(MAC, {
        type: 'push',
        channel: 'approval:cancelled',
        args: [{ requestId: 'r-1' }],
      });
      await settle();
    });
    expect(probe.current()).toMatchObject({ hasPendingToolApproval: false });
    expect(
      fake.invoke.mock.calls.every(
        ([, channel]) =>
          channel === 'desktop:session-snapshot' ||
          channel === 'approval:pending-requests',
      ),
    ).toBe(true);
    expect(fake.send).not.toHaveBeenCalled();
    act(() => {
      probe.root.unmount();
    });
  });

  it('never reads approvals from a computer that does not announce them', async () => {
    const fake = fakeApi();
    fake.hold.mockImplementation((deviceId: string) =>
      Promise.resolve({
        holdId: `hold-${deviceId}`,
        state: { ...CONNECTED, capabilities: ['chats', 'composer', 'sidebar'] },
      }),
    );
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([{ deviceId: MAC, name: 'MacBook Pro' }]);
    await settle();
    fake.update(MAC, {
      type: 'push',
      channel: 'approval:request',
      args: [{ requestId: 'r-1', projectId: 'shop', worktreeId: 'fix-upload' }],
    });
    expect(fake.invoke).not.toHaveBeenCalledWith(
      MAC,
      'approval:pending-requests',
      [],
    );
    expect(
      pairedSidebarStore.getState().computers.get(MAC)?.toolApprovals.size,
    ).toBe(0);
  });

  it("a paired row offers nothing that changes it and never reaches this computer's local paths", async () => {
    const caps = pairedSidebarRowCapabilities(DESKTOP);
    expect(caps).toMatchObject({
      worktreeRemoval: false,
      worktreeReordering: false,
      worktreePinning: false,
      worktreeMetadata: false,
      worktreeCreation: false,
      worktreeBranching: false,
      itemGrouping: false,
      workspaceSettings: false,
      workspaceRemoval: false,
      workspaceReordering: false,
      scriptActions: false,
      localExecution: false,
    });
    expect(caps).not.toHaveProperty('worktreeRetention');
    // Multi-select needs removal, so a paired row can't join a selection.
    expect(
      isWorktreeSelectable({
        subject: 'worktree',
        worktreeRemoval: caps.worktreeRemoval,
        commandsDisabled: false,
        hidden: false,
        removalInProgress: false,
      }),
    ).toBe(false);

    const { routeDesktopSidebarSelection, isSnapshotWorktreeListed } =
      await import('@/components/sidebar/DesktopSharedSidebarHost');
    // Listed in this computer's project though its store never holds it, as
    // a local row the store let go of is not.
    const storeProjects = [
      { id: 'storefront', type: 'single-repo', worktrees: [] },
    ];
    expect(
      isSnapshotWorktreeListed(storeProjects, {
        workspaceLocalId: 'storefront',
        localId: `computer-${MAC}:fix-upload`,
      }),
    ).toBe(true);
    expect(
      isSnapshotWorktreeListed(storeProjects, {
        workspaceLocalId: 'storefront',
        localId: 'csv-export',
      }),
    ).toBe(false);
    const actions = {
      navigate: jest.fn(),
      openStandaloneChat: jest.fn(),
      selectWorkspace: jest.fn(),
      selectWorktree: jest.fn(),
      openPairedComputer: jest.fn(),
    };
    const snapshot = {
      ...appendPairedSidebarRows(LOCAL_SNAPSHOT, {
        workspaces: [],
        worktrees: [
          {
            localId: `computer-${MAC}:fix-upload`,
            workspaceLocalId: 'storefront',
            branch: 'fix-upload',
          },
        ],
        projects: new Map(),
        rowRemoteWorkspaceIds: new Map(),
      }),
      standaloneChats: [],
    } as unknown as SessionViewModel;
    routeDesktopSidebarSelection(
      {
        kind: 'worktree',
        workspaceLocalId: 'storefront',
        worktreeLocalId: `computer-${MAC}:fix-upload`,
      },
      snapshot,
      actions,
    );
    // It opens that computer's own window and selects nothing here.
    expect(actions.openPairedComputer).toHaveBeenCalledWith(MAC);
    expect(actions.selectWorktree).not.toHaveBeenCalled();
    expect(actions.navigate).not.toHaveBeenCalled();
    expect(actions.openStandaloneChat).not.toHaveBeenCalled();
    // A local row still selects as before.
    routeDesktopSidebarSelection(
      {
        kind: 'worktree',
        workspaceLocalId: 'storefront',
        worktreeLocalId: 'csv-export',
      },
      snapshot,
      actions,
    );
    expect(actions.selectWorktree).toHaveBeenCalledWith(
      'storefront',
      'csv-export',
    );
    expect(actions.openPairedComputer).toHaveBeenCalledTimes(1);
  });

  it('keeps local tasks ahead of paired tasks under last-updated sorting', () => {
    const olderLocal = {
      localId: 'csv-export',
      workspaceLocalId: 'storefront',
      branch: 'csv-export',
      createdAt: '2026-11-20T00:00:00Z',
      lastActivityAt: '2026-11-20T00:00:00Z',
      order: 0,
    };
    const newerLocal = {
      localId: 'checkout-fix',
      workspaceLocalId: 'storefront',
      branch: 'checkout-fix',
      createdAt: '2026-11-21T00:00:00Z',
      lastActivityAt: '2026-11-21T00:00:00Z',
      order: 1,
    };
    const newestPaired = {
      localId: `computer-${MAC}:fix-upload`,
      workspaceLocalId: 'storefront',
      branch: 'fix-upload',
      createdAt: '2026-11-25T12:00:00Z',
      lastActivityAt: '2026-11-25T12:00:00Z',
      order: 1_000_000_000,
    };

    const { visible } = partitionWorktrees(
      [olderLocal, newerLocal, newestPaired],
      'storefront',
      'last-updated',
    );
    expect(visible.map((row) => row.localId)).toEqual([
      'checkout-fix',
      'csv-export',
      `computer-${MAC}:fix-upload`,
    ]);
  });

  it('rejects a paired snapshot with malformed nested workspace metadata and keeps the last valid snapshot', async () => {
    const fake = fakeApi(() =>
      Promise.resolve({
        workspaces: [
          {
            localId: 'mac-sf',
            name: 'storefront',
            type: 'single-repo',
            repositoryIdentity: { owner: 'acme', repo: 'storefront' },
          },
        ],
        worktrees: [
          {
            localId: 'fix-upload',
            workspaceLocalId: 'mac-sf',
            branch: 'fix-upload',
          },
        ],
      }),
    );
    const follower = new PairedComputersSidebarFollower(
      fake.api,
      () => undefined,
    );
    follower.follow([{ deviceId: MAC, name: 'Work Mac' }]);
    await settle();

    const validStructure = pairedSidebarStore
      .getState()
      .computers.get(MAC)?.structure;
    expect(validStructure?.workspaces).toHaveLength(1);
    expect(validStructure?.tasks.map((t) => t.localId)).toEqual(['fix-upload']);

    // Malformed nested repositoryIdentity (null) and malformed owner must be
    // rejected cleanly without crashing downstream row building.
    applyPairedSnapshot(MAC, {
      workspaces: [
        {
          localId: 'mac-sf',
          name: 'storefront',
          type: 'single-repo',
          repositoryIdentity: null,
        },
      ],
      worktrees: [],
    });
    applyPairedSnapshot(MAC, {
      workspaces: [
        {
          localId: 'mac-sf',
          name: 'storefront',
          type: 'single-repo',
          owner: { type: 'organization', organizationId: null, projectId: 123 },
        },
      ],
      worktrees: [],
    });

    const afterMalformed = pairedSidebarStore
      .getState()
      .computers.get(MAC)?.structure;
    expect(afterMalformed).toBe(validStructure);

    const buildRows = createPairedSidebarRowsBuilder(createProjectGrouper());
    expect(() =>
      buildRows({
        localProjects: [LOCAL_STOREFRONT],
        localFacts: null,
        accountId: 'acc-1',
        computers: pairedSidebarStore.getState().structures,
      }),
    ).not.toThrow();

    follower.dispose();
  });

  it('caps the approval journal and times out hung pending-requests reads without stacking RPCs', async () => {
    const errors: unknown[] = [];
    const fake = fakeApi(() => Promise.resolve(macSnapshot()));
    let approvalReadCalls = 0;
    let settleHungApprovalRead: (error: Error) => void = () => undefined;
    fake.api.invoke = (_deviceId, channel): Promise<unknown> => {
      if (channel === 'approval:pending-requests') {
        approvalReadCalls += 1;
        if (approvalReadCalls === 1) {
          return new Promise((_resolve, reject) => {
            settleHungApprovalRead = reject;
          });
        }
        return Promise.resolve([]);
      }
      return Promise.resolve(macSnapshot());
    };

    const follower = new PairedComputersSidebarFollower(
      fake.api,
      (err) => errors.push(err),
      { approvalJournalLimit: 3, approvalReadTimeoutMs: 40 },
    );
    follower.follow([{ deviceId: MAC, name: 'Work Mac' }]);
    await settle();

    // Flood approval pushes beyond the journal limit while the read hangs.
    for (let i = 0; i < 6; i += 1) {
      fake.update(MAC, {
        type: 'push',
        channel: 'approval:request',
        args: [
          {
            requestId: `req-${i}`,
            projectId: 'shop',
            worktreeId: 'fix-upload',
          },
        ],
      });
    }
    expect(
      pairedSidebarStore
        .getState()
        .computers.get(MAC)
        ?.toolApprovals.has(pairedTaskKey('shop', 'fix-upload')),
    ).toBe(true);

    // Past the read deadline: partial state is discarded and error reported,
    // without launching a duplicate overlapping approval RPC while the first
    // invoke is still pending in RpcPeer.
    await new Promise((resolve) => setTimeout(resolve, 90));
    await settle();

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(approvalReadCalls).toBe(1);
    expect(
      pairedSidebarStore.getState().computers.get(MAC)?.toolApprovals.size,
    ).toBe(0);

    // Once the timed-out RPC finally settles, the single bounded resync runs.
    settleHungApprovalRead(new Error('session closed'));
    await settle();
    expect(approvalReadCalls).toBe(2);

    follower.dispose();
  });

  it('does not start the paired follower when the legacy sidebar escape hatch is active', async () => {
    const previous = window.localStorage.getItem(
      DESKTOP_SHARED_SIDEBAR_STORAGE_KEY,
    );
    window.localStorage.setItem(DESKTOP_SHARED_SIDEBAR_STORAGE_KEY, '0');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const fake = fakeApi();
    const prevApi = window.api;
    try {
      const { usePairedComputersSidebarFollower } =
        await import('../usePairedComputersSidebar');
      const { useRemoteControlStore } =
        await import('@/stores/remoteControlStore');
      const { refreshOneWindowSwitch } =
        await import('@/stores/oneWindowStore');
      const noopUnsub = (): void => undefined;
      window.api = {
        ...prevApi,
        loadPreferences: jest
          .fn()
          .mockResolvedValue({ __oneWindowEnabled: true }),
        onPreferencesSynced: jest.fn((): (() => void) => noopUnsub),
        onPreferencesChanged: jest.fn((): (() => void) => noopUnsub),
        pairedComputers: fake.api,
      };
      await refreshOneWindowSwitch();
      useRemoteControlStore.setState((state) => ({
        ...state,
        context: { mode: 'local' },
        state: {
          ...state.state,
          signedIn: true,
          hosts: [
            {
              deviceId: MAC,
              name: 'Work Mac',
              online: true,
            } as (typeof state.state.hosts)[number],
          ],
        },
      }));
      function Probe(): JSX.Element | null {
        usePairedComputersSidebarFollower();
        return null;
      }
      act(() => {
        root.render(createElement(Probe));
      });
      await settle();
      expect(fake.hold).not.toHaveBeenCalled();
    } finally {
      window.api = prevApi;
      act(() => {
        root.unmount();
      });
      container.remove();
      if (previous === null) {
        window.localStorage.removeItem(DESKTOP_SHARED_SIDEBAR_STORAGE_KEY);
      } else {
        window.localStorage.setItem(
          DESKTOP_SHARED_SIDEBAR_STORAGE_KEY,
          previous,
        );
      }
    }
  });

  it("accepts a paired snapshot containing a 'not-local' placeholder workspace", async () => {
    const fake = fakeApi(() =>
      Promise.resolve({
        workspaces: [
          {
            localId: 'cloud-only',
            name: 'Cloud project',
            type: 'single-repo',
            placeholder: { projectId: 'cloud-proj-1', state: 'not-local' },
          },
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
        ],
        worktrees: [
          {
            localId: 'fix-upload',
            workspaceLocalId: 'shop',
            branch: 'fix-upload',
          },
        ],
      }),
    );
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([{ deviceId: MAC, name: 'Work Mac' }]);
    await settle();

    const structure = pairedSidebarStore
      .getState()
      .computers.get(MAC)?.structure;
    expect(structure?.workspaces).toHaveLength(2);
    expect(structure?.workspaces[0]?.placeholder).toEqual({
      projectId: 'cloud-proj-1',
      state: 'not-local',
    });
    expect(structure?.tasks.map((task) => task.localId)).toEqual([
      'fix-upload',
    ]);
  });

  it('refreshes snapshots immediately even while an approval pending-requests read is hung', async () => {
    let label = 'First';
    let approvalCalls = 0;
    const fake = fakeApi();
    fake.api.invoke = (_deviceId, channel): Promise<unknown> => {
      if (channel === 'approval:pending-requests') {
        approvalCalls += 1;
        return new Promise(() => undefined);
      }
      return Promise.resolve(macSnapshot({ label }));
    };

    follower = new PairedComputersSidebarFollower(fake.api, jest.fn(), {
      approvalReadTimeoutMs: 5_000,
    });
    follower.follow([{ deviceId: MAC, name: 'Work Mac' }]);
    await settle();

    expect(approvalCalls).toBe(1);
    expect(
      pairedSidebarStore
        .getState()
        .computers.get(MAC)
        ?.structure?.tasks.find((task) => task.localId === 'fix-upload')?.label,
    ).toBe('First');

    // Trigger a snapshot refresh while the first approval RPC is still hanging.
    label = 'Second';
    fake.update(MAC, {
      type: 'push',
      channel: 'desktop:session-snapshot-stale',
      args: [],
    });
    await settle();

    expect(
      pairedSidebarStore
        .getState()
        .computers.get(MAC)
        ?.structure?.tasks.find((task) => task.localId === 'fix-upload')?.label,
    ).toBe('Second');
    // Single-flight approval guard avoids starting a duplicate approval RPC.
    expect(approvalCalls).toBe(1);
  });

  it('keeps paired rows out of local branch grouping and local item-group drop targets', () => {
    const pairedId = `computer-${MAC}:remote-parent`;
    const localCaps: CanopyCapabilities = {
      ...DESKTOP,
      worktreeBranchGrouping: true,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={{
              workspaces: [
                {
                  localId: 'storefront',
                  name: 'storefront',
                  type: 'single-repo',
                  order: 0,
                  itemGroups: [
                    {
                      id: 'g-1',
                      name: 'Sprint',
                      color: 'categorical-1',
                      collapsed: false,
                      memberIds: ['local-child'],
                    },
                  ],
                },
              ],
              worktrees: [
                {
                  localId: 'local-parent',
                  workspaceLocalId: 'storefront',
                  branch: 'local-base',
                  order: 0,
                },
                {
                  localId: 'local-stacked',
                  workspaceLocalId: 'storefront',
                  branch: 'feature/on-local',
                  order: 1,
                },
                {
                  localId: 'local-child',
                  workspaceLocalId: 'storefront',
                  branch: 'feature/stacked',
                  order: 2,
                },
                {
                  localId: pairedId,
                  workspaceLocalId: 'storefront',
                  branch: 'shared-base',
                  order: 1_000_000_000,
                },
              ],
            }}
            capabilities={localCaps}
            capabilitiesFor={(localId): CanopyCapabilities =>
              localId === pairedId
                ? pairedSidebarRowCapabilities(localCaps)
                : localCaps
            }
            selected={null}
            onSelectWorktree={(): void => undefined}
            onCreateWorktree={(): Promise<undefined> =>
              Promise.resolve(undefined)
            }
            branchGroupingEnabled
            getBranchGrouping={(): {
              readonly groupingEnabled: boolean;
              readonly defaultBranches: ReadonlySet<string>;
              readonly baseBranchByWorktreeId: ReadonlyMap<string, string>;
            } => ({
              groupingEnabled: true,
              defaultBranches: new Set(['main']),
              baseBranchByWorktreeId: new Map([
                ['local-stacked', 'local-base'],
                ['local-child', 'shared-base'],
              ]),
            })}
          />,
        );
      });

      // Local-to-local branch grouping is active, proving the check is live.
      expect(
        container.querySelector(
          '[data-testid="worktree-branch-group-children"][data-parent-worktree-id="local-parent"]',
        ),
      ).not.toBeNull();
      // Local child must not nest under the paired row even though its base
      // branch matches the paired row's branch.
      expect(
        container.querySelector(
          `[data-testid="worktree-branch-group-children"][data-parent-worktree-id="${pairedId}"]`,
        ),
      ).toBeNull();
      // Paired row must not become a local item-group block or drop target.
      expect(
        container.querySelector(`[data-sidebar-group-block="${pairedId}"]`),
      ).toBeNull();
      const itemGroups = container.querySelector(
        '[data-testid="sidebar-code-item-groups"]',
      );
      expect(itemGroups).not.toBeNull();
      expect(
        itemGroups?.querySelector(`[data-worktree-id="${pairedId}"]`),
      ).toBeNull();
      // Paired row still renders in flow, after the local item-groups list.
      const pairedRow = container.querySelector(
        `[data-worktree-id="${pairedId}"]`,
      );
      expect(pairedRow).not.toBeNull();
      expect(
        Boolean(
          itemGroups &&
          pairedRow &&
          itemGroups.compareDocumentPosition(pairedRow) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).toBe(true);
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });

  describe("a paired computer's unchanged rows while this computer works (CAN-8047)", () => {
    const pairedA = `computer-${MAC}:remote-a`;
    const pairedB = `computer-${MAC}:remote-b`;
    const sectionsState = (overrides: {
      readonly localLabel: string;
      readonly pairedBLabel?: string;
    }): Pick<SessionViewModel, 'workspaces' | 'worktrees'> => ({
      workspaces: [
        {
          localId: 'storefront',
          name: 'storefront',
          type: 'single-repo',
          order: 0,
        },
      ],
      worktrees: [
        {
          localId: 'local-task',
          workspaceLocalId: 'storefront',
          branch: 'local-task',
          label: overrides.localLabel,
          order: 0,
        },
        // Rebuilt on every render, as a snapshot refresh rebuilds them.
        {
          localId: pairedA,
          workspaceLocalId: 'storefront',
          branch: 'remote-a',
          label: 'Remote A',
          order: 1_000_000_000,
        },
        {
          localId: pairedB,
          workspaceLocalId: 'storefront',
          branch: 'remote-b',
          label: overrides.pairedBLabel ?? 'Remote B',
          order: 1_000_000_001,
        },
      ],
    });
    const renderSections = (
      root: Root,
      state: Pick<SessionViewModel, 'workspaces' | 'worktrees'>,
      onSelectWorktree: (workspaceId: string, worktreeId: string) => void,
      rendered: Map<string, number>,
    ): void => {
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={state}
            capabilities={DESKTOP}
            // A new function on every render, as the desktop host passes it.
            capabilitiesFor={(localId): CanopyCapabilities =>
              localId.startsWith('computer-')
                ? pairedSidebarRowCapabilities(DESKTOP)
                : DESKTOP
            }
            selected={null}
            onSelectWorktree={onSelectWorktree}
            onCreateWorktree={(): Promise<undefined> =>
              Promise.resolve(undefined)
            }
            useWorktreeRowOverrides={(context): undefined => {
              const id = context.worktree.localId;
              rendered.set(id, (rendered.get(id) ?? 0) + 1);
              return undefined;
            }}
          />,
        );
      });
    };

    it("re-renders this computer's changed row but not the paired rows, and a paired row that changed renders again", () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root: Root = createRoot(container);
      const rendered = new Map<string, number>();
      try {
        renderSections(
          root,
          sectionsState({ localLabel: 'Streaming 1' }),
          jest.fn(),
          rendered,
        );
        const first = new Map(rendered);
        expect(first.get(pairedA)).toBeGreaterThan(0);
        expect(first.get(pairedB)).toBeGreaterThan(0);

        // This computer's chat streams: its own row changes, the paired
        // computer's rows do not, and every callback is new.
        renderSections(
          root,
          sectionsState({ localLabel: 'Streaming 2' }),
          jest.fn(),
          rendered,
        );
        expect(rendered.get('local-task')).toBeGreaterThan(
          first.get('local-task') ?? 0,
        );
        expect(rendered.get(pairedA)).toBe(first.get(pairedA));
        expect(rendered.get(pairedB)).toBe(first.get(pairedB));

        // The paired computer renames one of its tasks: only that row
        // renders again, and shows the new name.
        renderSections(
          root,
          sectionsState({
            localLabel: 'Streaming 2',
            pairedBLabel: 'Remote B renamed',
          }),
          jest.fn(),
          rendered,
        );
        expect(rendered.get(pairedA)).toBe(first.get(pairedA));
        expect(rendered.get(pairedB)).toBeGreaterThan(first.get(pairedB) ?? 0);
        expect(
          container.querySelector(`[data-worktree-id="${pairedB}"]`)
            ?.textContent,
        ).toContain('Remote B renamed');
      } finally {
        act(() => {
          root.unmount();
        });
        container.remove();
      }
    });

    it("a reused paired row's click reaches the host's current handler", () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root: Root = createRoot(container);
      const rendered = new Map<string, number>();
      try {
        const firstHandler = jest.fn();
        renderSections(
          root,
          sectionsState({ localLabel: 'Streaming 1' }),
          firstHandler,
          rendered,
        );
        const pairedRenders = rendered.get(pairedA);
        const currentHandler = jest.fn();
        renderSections(
          root,
          sectionsState({ localLabel: 'Streaming 2' }),
          currentHandler,
          rendered,
        );
        // The row was reused, not rendered with the new handler.
        expect(rendered.get(pairedA)).toBe(pairedRenders);

        const row = container.querySelector(`[data-worktree-id="${pairedA}"]`);
        expect(row).toBeInstanceOf(HTMLElement);
        act(() => {
          row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(currentHandler).toHaveBeenCalledWith('storefront', pairedA);
        expect(firstHandler).not.toHaveBeenCalled();
      } finally {
        act(() => {
          root.unmount();
        });
        container.remove();
      }
    });
  });

  describe("a long list of a paired computer's tasks (CAN-8060)", () => {
    const ROW_HEIGHT = 32;
    const VIEWPORT_HEIGHT = 400;
    // A test may give its rows another height.
    let rowHeight = ROW_HEIGHT;
    const pairedId = (index: number): string =>
      `computer-${MAC}:remote-${String(index).padStart(3, '0')}`;
    const longState = (
      count: number,
      omit?: number,
    ): Pick<SessionViewModel, 'workspaces' | 'worktrees'> => ({
      workspaces: [
        {
          localId: 'storefront',
          name: 'storefront',
          type: 'single-repo',
          order: 0,
        },
      ],
      worktrees: Array.from({ length: count }, (_, index) => ({
        localId: pairedId(index),
        workspaceLocalId: 'storefront',
        branch: `remote-${index}`,
        label: `Remote ${index + 1}`,
        order: 1_000_000_000 + index,
      })).filter((_, index) => index !== omit),
    });
    // The sidebar's scroller and its rows, sized as a layout engine would.
    let rects: jest.SpyInstance<DOMRect, []>;
    let heights: jest.SpyInstance<number, []>;
    const scrollIntoView = jest.fn<void, [ScrollIntoViewOptions?]>();
    beforeEach(() => {
      rects = jest
        .spyOn(Element.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: Element): DOMRect {
          if (this instanceof HTMLElement && this.dataset['testScroller'])
            return new DOMRect(0, 0, 300, VIEWPORT_HEIGHT);
          if (
            this instanceof HTMLElement &&
            this.dataset['index'] !== undefined
          )
            return new DOMRect(0, 0, 300, rowHeight);
          return new DOMRect(0, 0, 0, 0);
        });
      heights = jest
        .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
        .mockImplementation(function (this: HTMLElement): number {
          if (this.dataset['testScroller']) return VIEWPORT_HEIGHT;
          return this.dataset['index'] === undefined ? 0 : rowHeight;
        });
      scrollIntoView.mockClear();
      Element.prototype.scrollIntoView = scrollIntoView;
      // jsdom elements cannot scroll; a scroller keeps the offset it is given.
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
        configurable: true,
        value(this: HTMLElement, options?: ScrollToOptions): void {
          if (options?.top !== undefined) this.scrollTop = options.top;
        },
      });
    });
    afterEach(() => {
      rowHeight = ROW_HEIGHT;
      rects.mockRestore();
      heights.mockRestore();
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
    });
    const mount = (
      count: number,
      props: Partial<
        Pick<
          Parameters<typeof WorkspacesSidebarSections>[0],
          'selected' | 'pendingRevealTarget' | 'renderWorktreeStatus'
        >
      > = {},
    ): {
      container: HTMLDivElement;
      rerender: (nextCount: number, omit?: number) => void;
      unmount: () => void;
    } => {
      const container = document.createElement('div');
      container.dataset['testScroller'] = 'true';
      container.style.overflowY = 'auto';
      document.body.appendChild(container);
      const root = createRoot(container);
      const render = (rowCount: number, omit?: number): void => {
        root.render(
          <WorkspacesSidebarSections
            state={longState(rowCount, omit)}
            capabilities={DESKTOP}
            capabilitiesFor={(localId): CanopyCapabilities =>
              localId.startsWith('computer-')
                ? pairedSidebarRowCapabilities(DESKTOP)
                : DESKTOP
            }
            selected={props.selected ?? null}
            pendingRevealTarget={props.pendingRevealTarget ?? null}
            renderWorktreeStatus={props.renderWorktreeStatus}
            onSelectWorktree={jest.fn()}
            onCreateWorktree={(): Promise<undefined> =>
              Promise.resolve(undefined)
            }
          />,
        );
      };
      act(() => {
        render(count);
      });
      return {
        container,
        rerender: (nextCount: number, omit?: number): void => {
          act(() => {
            render(nextCount, omit);
          });
        },
        unmount: (): void => {
          act(() => {
            root.unmount();
          });
          container.remove();
        },
      };
    };
    const renderedRows = (container: HTMLElement): string[] =>
      [...container.querySelectorAll('[data-worktree-id^="computer-"]')].map(
        (row) => row.getAttribute('data-worktree-id') ?? '',
      );
    const frameOf = (container: HTMLElement, id: string): Element | null =>
      container
        .querySelector(`[data-worktree-id="${id}"]`)
        ?.closest('[data-sidebar-row-frame]') ?? null;
    // Moves focus to the next tabbable element in document order, as Tab does.
    const pressTab = (container: HTMLElement): void => {
      const tabbable = [
        ...container.querySelectorAll<HTMLElement>(
          'a[href], button, input, select, textarea, [tabindex]',
        ),
      ].filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.hasAttribute('disabled') &&
          element.closest('[inert], [hidden]') === null,
      );
      const active = document.activeElement;
      const next =
        tabbable[
          active instanceof HTMLElement ? tabbable.indexOf(active) + 1 : 0
        ];
      if (next === undefined) throw new Error('nothing left to Tab to');
      act(() => {
        next.focus();
      });
    };

    it('renders every row of a list of up to 30, as before', () => {
      const { container, unmount } = mount(30);
      try {
        expect(renderedRows(container)).toHaveLength(30);
        expect(
          frameOf(container, pairedId(0))?.hasAttribute('aria-setsize'),
        ).toBe(false);
      } finally {
        unmount();
      }
    });

    it('renders only the rows near the viewport of a longer list, plus its first and last, and gives each its place in the whole list', () => {
      const { container, unmount } = mount(120);
      try {
        const rows = renderedRows(container);
        expect(rows.length).toBeGreaterThan(VIEWPORT_HEIGHT / ROW_HEIGHT);
        expect(rows.length).toBeLessThan(40);
        expect(rows).toContain(pairedId(0));
        expect(rows).toContain(pairedId(119));
        expect(rows).not.toContain(pairedId(60));
        const first = frameOf(container, pairedId(0));
        expect(first?.getAttribute('aria-setsize')).toBe('120');
        expect(first?.getAttribute('aria-posinset')).toBe('1');
        expect(
          frameOf(container, pairedId(119))?.getAttribute('aria-posinset'),
        ).toBe('120');
      } finally {
        unmount();
      }
    });

    it('Tab walks from the first paired row past the window, one row after another, without scrolling by hand', () => {
      const { container, unmount } = mount(120);
      try {
        const scroller = container;
        expect(renderedRows(container)).not.toContain(pairedId(40));
        const firstFrame = frameOf(container, pairedId(0));
        if (!(firstFrame instanceof HTMLElement))
          throw new Error('no first paired row');
        act(() => {
          firstFrame.focus();
        });
        const visited: number[] = [];
        for (let press = 0; press < 400 && visited.at(-1) !== 41; press += 1) {
          pressTab(container);
          const frame = document.activeElement?.closest(
            '[data-sidebar-row-frame]',
          );
          const position = Number(frame?.getAttribute('aria-posinset'));
          if (Number.isInteger(position) && position !== visited.at(-1))
            visited.push(position);
        }
        // Rows 2 to 41: every row in turn, well past the 31st.
        expect(visited).toEqual(
          Array.from({ length: 40 }, (_, index) => index + 2),
        );
        expect(scroller.scrollTop).toBe(0);
      } finally {
        unmount();
      }
    });

    it('keeps focus on the same row when the list grows past 30 rows and shrinks back', async () => {
      const { container, rerender, unmount } = mount(30);
      try {
        const focusedId = (): string | null =>
          document.activeElement
            ?.closest('[data-sidebar-row-frame]')
            ?.querySelector('[data-worktree-id]')
            ?.getAttribute('data-worktree-id') ?? null;
        const frame = frameOf(container, pairedId(5));
        if (!(frame instanceof HTMLElement))
          throw new Error('no sixth paired row');
        act(() => {
          frame.focus();
        });
        expect(focusedId()).toBe(pairedId(5));

        rerender(31);
        await act(() => Promise.resolve());
        expect(
          frameOf(container, pairedId(5))?.hasAttribute('aria-setsize'),
        ).toBe(true);
        expect(focusedId()).toBe(pairedId(5));

        rerender(30);
        await act(() => Promise.resolve());
        expect(
          frameOf(container, pairedId(5))?.hasAttribute('aria-setsize'),
        ).toBe(false);
        expect(focusedId()).toBe(pairedId(5));
      } finally {
        unmount();
      }
    });

    it('keeps the sidebar where it is scrolled when a list grows past 30 rows', () => {
      const { container, rerender, unmount } = mount(30);
      try {
        container.scrollTop = 600;
        rerender(31);
        expect(
          frameOf(container, pairedId(0))?.hasAttribute('aria-setsize'),
        ).toBe(true);
        expect(container.scrollTop).toBe(600);
      } finally {
        unmount();
      }
    });

    it('gives focus back to the control inside a row, not just the row, when the list grows past 30 rows', async () => {
      const { container, rerender, unmount } = mount(30, {
        // A control inside each row, as a status badge with a popover is.
        renderWorktreeStatus: (): JSX.Element => (
          <button type="button">Status</button>
        ),
      });
      try {
        const controlIn = (frame: Element | null): HTMLElement | null =>
          frame?.querySelector<HTMLElement>(
            'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ) ?? null;
        const control = controlIn(frameOf(container, pairedId(5)));
        if (control === null) throw new Error('no control in the sixth row');
        act(() => {
          control.focus();
        });
        expect(document.activeElement).toBe(control);

        rerender(31);
        await act(() => Promise.resolve());
        const frame = frameOf(container, pairedId(5));
        expect(frame?.hasAttribute('aria-setsize')).toBe(true);
        expect(document.activeElement).not.toBe(frame);
        expect(document.activeElement).toBe(controlIn(frame));
      } finally {
        unmount();
      }
    });

    it('places a windowed row by its top offset, which layout measurements of the selected row read', () => {
      const { container, unmount } = mount(120, {
        selected: {
          kind: 'worktree',
          workspaceLocalId: 'storefront',
          worktreeLocalId: pairedId(80),
        },
      });
      try {
        const place = frameOf(container, pairedId(80))?.parentElement;
        expect(place?.dataset['index']).toBe('80');
        // offsetTop ignores a transform; the rail's pin measures offsetTop.
        expect(place?.style.transform).toBe('');
        expect(place?.style.top).toBe(`${80 * (ROW_HEIGHT + 1)}px`);
      } finally {
        unmount();
      }
    });

    it('never renders a list shorter than the one it replaces when it grows past 30 rows', () => {
      rowHeight = 50;
      const plainHeight = 30 * rowHeight + 29;
      // The browser's resize reports: the plain list's measured height.
      const original = window.ResizeObserver;
      window.ResizeObserver = class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element): void {
          const height =
            target.getAttribute('role') === 'list' ? plainHeight : rowHeight;
          this.callback(
            [
              {
                target,
                contentRect: new DOMRect(0, 0, 300, height),
                borderBoxSize: [],
                contentBoxSize: [],
                devicePixelContentBoxSize: [],
              },
            ],
            this,
          );
        }
        unobserve(): void {}
        disconnect(): void {}
      };
      const { container, rerender, unmount } = mount(30);
      try {
        const seen: number[] = [];
        const styles = new MutationObserver(() => undefined);
        styles.observe(container, {
          subtree: true,
          attributes: true,
          attributeFilter: ['style'],
          attributeOldValue: true,
        });
        rerender(31);
        for (const record of styles.takeRecords()) {
          const height = /height: (\d+)px/.exec(record.oldValue ?? '')?.[1];
          if (
            record.target instanceof HTMLElement &&
            record.target.getAttribute('role') === 'list' &&
            height !== undefined
          )
            seen.push(Number(height));
        }
        styles.disconnect();
        const list = frameOf(container, pairedId(0))?.closest('[role="list"]');
        if (!(list instanceof HTMLElement)) throw new Error('no paired list');
        seen.push(Number.parseFloat(list.style.height));
        expect(Math.min(...seen)).toBeGreaterThanOrEqual(plainHeight);
      } finally {
        unmount();
        window.ResizeObserver = original;
      }
    });

    it('does not give focus to a row that leaves and comes back once focus has moved on, even when the list later crosses 30 rows', async () => {
      const { container, rerender, unmount } = mount(120);
      const outside = document.createElement('button');
      document.body.appendChild(outside);
      try {
        const frame = frameOf(container, pairedId(5));
        if (!(frame instanceof HTMLElement))
          throw new Error('no sixth paired row');
        act(() => {
          frame.focus();
        });
        rerender(120, 5);
        act(() => {
          outside.focus();
        });
        act(() => {
          outside.blur();
        });
        rerender(120);
        expect(frameOf(container, pairedId(5))).not.toBeNull();
        expect(document.activeElement).toBe(document.body);

        // Nor at a later threshold crossing, with focus on nothing.
        rerender(30);
        await act(() => Promise.resolve());
        expect(document.activeElement).toBe(document.body);
        rerender(31);
        await act(() => Promise.resolve());
        expect(document.activeElement).toBe(document.body);
      } finally {
        unmount();
        outside.remove();
      }
    });

    it('keeps the selected row rendered wherever the list is scrolled, and reveals a row waiting to be revealed', () => {
      const { container, unmount } = mount(120, {
        selected: {
          kind: 'worktree',
          workspaceLocalId: 'storefront',
          worktreeLocalId: pairedId(80),
        },
        pendingRevealTarget: {
          workspaceLocalId: 'storefront',
          worktreeLocalId: pairedId(95),
        },
      });
      try {
        const rows = renderedRows(container);
        expect(rows).toContain(pairedId(80));
        expect(rows).toContain(pairedId(95));
        expect(rows).not.toContain(pairedId(60));
        const revealed = container.querySelector(
          `[data-worktree-id="${pairedId(95)}"]`,
        );
        expect(scrollIntoView).toHaveBeenCalled();
        expect(scrollIntoView.mock.contexts).toContain(revealed);
      } finally {
        unmount();
      }
    });
  });

  it('keeps tasks with the same localId in different paired workspaces distinct for rows, live status, and approvals', async () => {
    const fake = fakeApi(() =>
      Promise.resolve({
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
          { localId: 'docs-remote', name: 'docs', type: 'single-repo' },
        ],
        worktrees: [
          {
            localId: 'shared-id',
            workspaceLocalId: 'shop',
            branch: 'shop-branch',
            isStreaming: true,
          },
          {
            localId: 'shared-id',
            workspaceLocalId: 'docs-remote',
            branch: 'docs-branch',
            status: 'done',
          },
        ],
      }),
    );
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([{ deviceId: MAC, name: 'MacBook Pro' }]);
    await settle();

    // Both tasks survive snapshot deduplication and appear under their own workspaces.
    const build = createPairedSidebarRowsBuilder(createProjectGrouper());
    const rows = rowsFor(build);
    const qualifiedId = `computer-${MAC}:shared-id`;
    const remoteDocsId = `computer-${MAC}:docs-remote`;
    expect(
      rows.worktrees.map((w) => [w.workspaceLocalId, w.localId, w.branch]),
    ).toEqual([
      ['storefront', qualifiedId, 'shop-branch'],
      [remoteDocsId, qualifiedId, 'docs-branch'],
    ]);

    // Mount usePairedSidebarRows so rowRemoteWorkspaceIds is published, and verify
    // each row resolves its own workspace's live status and tool approval.
    const { usePairedSidebarRows } =
      await import('../usePairedComputersSidebar');
    const { useProjectsStore } = await import('@/stores/projectsStore');
    const prevProjects = useProjectsStore.getState().projects;
    useProjectsStore.setState({ projects: [LOCAL_STOREFRONT, LOCAL_DOCS] });
    let shopOverrides: WorktreeRowOverrides | undefined;
    let docsOverrides: WorktreeRowOverrides | undefined;
    const shopCtx = rowContext('storefront', qualifiedId);
    const docsCtx = rowContext(remoteDocsId, qualifiedId);
    function Probe(): null {
      usePairedSidebarRows();
      shopOverrides = usePairedWorktreeRowOverrides(shopCtx);
      docsOverrides = usePairedWorktreeRowOverrides(docsCtx);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => {
        root.render(createElement(Probe));
        await settle();
      });
      await act(async () => {
        fake.update(MAC, {
          type: 'push',
          channel: 'approval:request',
          args: [
            {
              requestId: 'r-docs',
              projectId: 'docs-remote',
              worktreeId: 'shared-id',
            },
          ],
        });
        await settle();
      });
      expect(shopOverrides).toMatchObject({
        isStreaming: true,
        uiStatus: 'working',
        hasPendingToolApproval: false,
      });
      expect(docsOverrides).toMatchObject({
        uiStatus: 'done',
        runtimeState: 'done',
        hasPendingToolApproval: true,
      });
    } finally {
      act(() => {
        root.unmount();
      });
      useProjectsStore.setState({ projects: prevProjects });
    }
  });

  it('bounds oversized paired snapshots, reports an error, and keeps tasks within the cap', async () => {
    const errors: unknown[] = [];
    const fake = fakeApi();
    follower = new PairedComputersSidebarFollower(fake.api, (err) =>
      errors.push(err),
    );
    follower.follow([{ deviceId: MAC, name: 'MacBook Pro' }]);
    await settle();

    applyPairedSnapshot(
      MAC,
      {
        workspaces: Array.from(
          { length: MAX_PAIRED_SNAPSHOT_WORKSPACES + 2 },
          (_, i) => ({
            localId: `ws-${i}`,
            name: `ws-${i}`,
            type: 'single-repo',
          }),
        ),
        worktrees: [
          { localId: 'kept', workspaceLocalId: 'ws-0', branch: 'kept' },
          {
            localId: 'dropped',
            workspaceLocalId: `ws-${MAX_PAIRED_SNAPSHOT_WORKSPACES + 1}`,
            branch: 'dropped',
          },
        ],
      },
      (err) => errors.push(err),
    );
    const afterWorkspacesCap = pairedSidebarStore
      .getState()
      .computers.get(MAC)?.structure;
    expect(afterWorkspacesCap?.workspaces).toHaveLength(
      MAX_PAIRED_SNAPSHOT_WORKSPACES,
    );
    expect(afterWorkspacesCap?.tasks.map((task) => task.localId)).toEqual([
      'kept',
    ]);

    applyPairedSnapshot(
      MAC,
      {
        workspaces: [
          { localId: 'shop', name: 'storefront', type: 'single-repo' },
        ],
        worktrees: Array.from(
          { length: MAX_PAIRED_SNAPSHOT_TASKS + 2 },
          (_, i) => ({
            localId: `wt-${i}`,
            workspaceLocalId: 'shop',
            branch: `b-${i}`,
          }),
        ),
      },
      (err) => errors.push(err),
    );

    expect(errors).toHaveLength(2);
    expect(
      pairedSidebarStore.getState().computers.get(MAC)?.structure?.tasks,
    ).toHaveLength(MAX_PAIRED_SNAPSHOT_TASKS);
  });

  it('suppresses Working streaming status while a paired task has a pending tool approval', async () => {
    const fake = fakeApi(() =>
      Promise.resolve(macSnapshot({ isStreaming: true, busy: true })),
    );
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([{ deviceId: MAC, name: 'MacBook Pro' }]);
    await settle();

    const probe = renderOverrides(
      rowContext('storefront', `computer-${MAC}:fix-upload`),
    );
    try {
      expect(probe.current()).toMatchObject({
        isStreaming: true,
        uiStatus: 'working',
        hasPendingToolApproval: false,
      });

      await act(async () => {
        fake.update(MAC, {
          type: 'push',
          channel: 'approval:request',
          args: [
            {
              requestId: 'r-stream',
              projectId: 'shop',
              worktreeId: 'fix-upload',
            },
          ],
        });
        await settle();
      });
      expect(probe.current()).toMatchObject({
        isStreaming: false,
        uiStatus: 'idle',
        hasPendingToolApproval: true,
      });

      await act(async () => {
        fake.update(MAC, {
          type: 'push',
          channel: 'approval:cancelled',
          args: [{ requestId: 'r-stream' }],
        });
        await settle();
      });
      expect(probe.current()).toMatchObject({
        isStreaming: true,
        uiStatus: 'working',
        hasPendingToolApproval: false,
      });
    } finally {
      act(() => {
        probe.root.unmount();
      });
    }
  });

  it('keeps showing a status row when a peer with no projected tree tasks reconnects or needs an update', async () => {
    const fake = fakeApi((deviceId) =>
      Promise.resolve(
        deviceId === MAC
          ? {
              workspaces: [
                {
                  localId: 'cowork',
                  name: 'Notes',
                  type: 'cowork',
                  layout: 'flat',
                },
              ],
              worktrees: [],
            }
          : { workspaces: [], worktrees: [] },
      ),
    );
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([
      { deviceId: MAC, name: 'MacBook Pro' },
      { deviceId: LINUX, name: 'Linux Box' },
    ]);
    await settle();
    expect(
      pairedSidebarStore.getState().computers.get(MAC)?.structure?.workspaces,
    ).toHaveLength(1);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(createElement(PairedComputerStatusRows));
      });
      expect(container.textContent).toBe('');

      await act(async () => {
        fake.state(MAC, { status: 'connecting' });
        fake.state(LINUX, {
          status: 'needs-update',
          reason: 'computer-too-old',
          computerVersion: null,
          computerAppVersion: '1.10.0',
          thisComputerVersion: { protocolVersion: 26, appVersion: '1.24.0' },
          update: null,
        });
        await settle();
      });
      expect(container.textContent).toContain('MacBook Pro');
      expect(container.textContent).toContain('Connecting…');
      expect(container.textContent).toContain('Linux Box');
      expect(container.textContent).toContain('Needs an update');
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('ignores oversized approval ids and bounds sparse pending-requests replies', async () => {
    const sparseReply = new Array<unknown>(10_000_000);
    sparseReply[0] = {
      requestId: 'r-valid',
      projectId: 'shop',
      worktreeId: 'fix-upload',
    };
    sparseReply[9_999_999] = {
      requestId: 'r-out-of-range',
      projectId: 'shop',
      worktreeId: 'other',
    };
    const fake = fakeApi();
    fake.api.invoke = (_deviceId, channel): Promise<unknown> =>
      Promise.resolve(
        channel === 'approval:pending-requests' ? sparseReply : macSnapshot(),
      );
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([{ deviceId: MAC, name: 'MacBook Pro' }]);
    await settle();

    // Oversized id push is rejected instead of retained.
    fake.update(MAC, {
      type: 'push',
      channel: 'approval:request',
      args: [
        {
          requestId: 'r-' + 'x'.repeat(300),
          projectId: 'shop',
          worktreeId: 'other',
        },
      ],
    });
    expect(
      pairedSidebarStore.getState().computers.get(MAC)?.toolApprovals,
    ).toEqual(new Set([pairedTaskKey('shop', 'fix-upload')]));
  });

  it('shows a status row when visibleDeviceIds excludes an unreachable peer whose tasks are hidden by context', async () => {
    const fake = fakeApi(() => Promise.resolve(macSnapshot()));
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([{ deviceId: MAC, name: 'MacBook Pro' }]);
    await settle();
    await act(async () => {
      fake.state(MAC, { status: 'connecting' });
      await settle();
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(
          <PairedComputerStatusRows visibleDeviceIds={new Set<string>()} />,
        );
      });
      expect(container.textContent).toContain('MacBook Pro');
      expect(container.textContent).toContain('Connecting…');

      act(() => {
        root.render(
          <PairedComputerStatusRows visibleDeviceIds={new Set([MAC])} />,
        );
      });
      expect(container.textContent).toBe('');
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('masks paired project and computer names in WorkspaceSectionHeader button aria-labels for PostHog replay', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(
          <WorkspaceSectionHeader
            workspaceType="single-repo"
            name="Secret Repo on Nick's Mac"
            collapsed={false}
            onToggleCollapse={(): void => undefined}
            worktreeCount={2}
            textScale="sidebar"
            inlineCollapseChevron
          />,
        );
      });
      const labeledButtons = Array.from(
        container.querySelectorAll('button[aria-label]'),
      );
      expect(labeledButtons.length).toBeGreaterThanOrEqual(2);
      for (const button of labeledButtons) {
        const label = button.getAttribute('aria-label');
        expect(label).toContain('Secret Repo');
        expect(maskReplayAttribute('aria-label', label ?? '', button)).toBe(
          '********',
        );
      }
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('redacts data-worktree-selection-row and identifier-bearing data-testid on rendered paired sidebar rows and headers', () => {
    const pairedWorkspaceId = `computer-${MAC}:secret-repo`;
    const pairedWorktreeId = `computer-${MAC}:secret-task`;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={{
              workspaces: [
                {
                  localId: pairedWorkspaceId,
                  name: 'Secret Repo',
                  type: 'single-repo',
                  order: 0,
                },
              ],
              worktrees: [
                {
                  localId: pairedWorktreeId,
                  workspaceLocalId: pairedWorkspaceId,
                  branch: 'secret-branch',
                  order: 0,
                },
              ],
            }}
            capabilities={DESKTOP}
            capabilitiesFor={(): CanopyCapabilities =>
              pairedSidebarRowCapabilities(DESKTOP)
            }
            selected={null}
            onSelectWorktree={(): void => undefined}
            onCreateWorktree={(): Promise<undefined> =>
              Promise.resolve(undefined)
            }
            worktreeMultiSelect={{
              selectMode: false,
              onRowsChange: jest.fn(),
              escapeClears: true,
              isRemoving: () => false,
              rowMenuFor: () => undefined,
              menuItemsFor: () => ({ items: [], replacesMenu: false }),
              selection: {
                keys: new Set(),
                kind: undefined,
                active: false,
                count: 0,
                isSelected: () => false,
                toggle: jest.fn(),
                selectRange: jest.fn(),
                anchor: jest.fn(),
                extend: jest.fn(() => undefined),
                selectAllInList: jest.fn(),
                clear: jest.fn(),
                replace: jest.fn(),
              },
              selectModeFor: () => false,
              isSelectable: () => false,
            }}
            testIds={{
              workspace: (workspaceId) => `sidebar-project-${workspaceId}`,
              workspaceHeader: (workspaceId) =>
                `sidebar-project-header-${workspaceId}`,
              workspaceToggle: (workspaceId) =>
                `sidebar-project-toggle-${workspaceId}`,
              workspaceSortableHeader: (workspaceId) =>
                `sidebar-project-sortable-header-${workspaceId}`,
              workspaceEmpty: (workspaceId) =>
                `sidebar-project-${workspaceId}-empty`,
              hiddenWorktreesToggle: (workspaceId) =>
                `hidden-worktrees-toggle-${workspaceId}`,
              worktreeRow: () => 'worktree-row',
            }}
          />,
        );
      });

      const selectionEl = container.querySelector(
        '[data-worktree-selection-row]',
      );
      expect(selectionEl).not.toBeNull();
      expect(
        maskReplayAttribute(
          'data-worktree-selection-row',
          selectionEl?.getAttribute('data-worktree-selection-row') ?? '',
          selectionEl ?? undefined,
        ),
      ).toBe('********');

      const headerTestIdEl = container.querySelector(
        `[data-testid="sidebar-project-header-${pairedWorkspaceId}"]`,
      );
      const sectionTestIdEl = container.querySelector(
        `[data-testid="sidebar-project-${pairedWorkspaceId}"]`,
      );
      const staticRowEl = container.querySelector(
        '[data-testid="worktree-row"]',
      );
      expect(headerTestIdEl).not.toBeNull();
      expect(sectionTestIdEl).not.toBeNull();
      expect(staticRowEl).not.toBeNull();
      expect(
        maskReplayAttribute(
          'data-testid',
          headerTestIdEl?.getAttribute('data-testid') ?? '',
          headerTestIdEl ?? undefined,
        ),
      ).toBe('********');
      expect(
        maskReplayAttribute(
          'data-testid',
          sectionTestIdEl?.getAttribute('data-testid') ?? '',
          sectionTestIdEl ?? undefined,
        ),
      ).toBe('********');
      expect(
        maskReplayAttribute(
          'data-testid',
          staticRowEl?.getAttribute('data-testid') ?? '',
          staticRowEl ?? undefined,
        ),
      ).toBe('worktree-row');

      for (const el of Array.from(container.querySelectorAll('*'))) {
        for (const attr of Array.from(el.attributes)) {
          const masked = maskReplayAttribute(attr.name, attr.value, el);
          expect(masked).not.toContain(MAC);
          expect(masked).not.toContain('secret-repo');
          expect(masked).not.toContain('secret-task');
          expect(masked).not.toContain('secret-branch');
        }
      }
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('keeps the fallback status row visible when a reconnecting peer only has tasks in collapsed projects or hidden tasks', async () => {
    const fake = fakeApi(() => Promise.resolve(macSnapshot()));
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([{ deviceId: MAC, name: 'MacBook Pro' }]);
    await settle();
    await act(async () => {
      fake.state(MAC, { status: 'connecting' });
      await settle();
    });

    const pairedWorkspaceId = `computer-${MAC}:shop`;
    const pairedWorktreeId = `computer-${MAC}:fix-upload`;
    const expandedVisible = collectVisiblePairedDeviceIds({
      workspaces: [
        {
          localId: pairedWorkspaceId,
          name: 'shop',
          type: 'single-repo',
          order: 0,
          collapsed: false,
        },
      ],
      pairedWorktrees: [
        {
          localId: pairedWorktreeId,
          workspaceLocalId: pairedWorkspaceId,
          branch: 'fix-upload',
          order: 0,
        },
      ],
      hiddenWorkspaceIds: [],
      matchesWorkspaceContext: () => true,
    });
    expect(expandedVisible.has(MAC)).toBe(true);

    const collapsedVisible = collectVisiblePairedDeviceIds({
      workspaces: [
        {
          localId: pairedWorkspaceId,
          name: 'shop',
          type: 'single-repo',
          order: 0,
          collapsed: true,
        },
      ],
      pairedWorktrees: [
        {
          localId: pairedWorktreeId,
          workspaceLocalId: pairedWorkspaceId,
          branch: 'fix-upload',
          order: 0,
        },
      ],
      hiddenWorkspaceIds: [],
      matchesWorkspaceContext: () => true,
    });
    expect(collapsedVisible.has(MAC)).toBe(false);

    const hiddenTaskVisible = collectVisiblePairedDeviceIds({
      workspaces: [
        {
          localId: pairedWorkspaceId,
          name: 'shop',
          type: 'single-repo',
          order: 0,
          collapsed: false,
        },
      ],
      pairedWorktrees: [
        {
          localId: pairedWorktreeId,
          workspaceLocalId: pairedWorkspaceId,
          branch: 'fix-upload',
          hidden: true,
          order: 0,
        },
      ],
      hiddenWorkspaceIds: [],
      matchesWorkspaceContext: () => true,
    });
    expect(hiddenTaskVisible.has(MAC)).toBe(false);

    function LiveCollapsedStatusProbe(): JSX.Element {
      const pairedRows = usePairedSidebarRows();
      const visible = collectVisiblePairedDeviceIds({
        workspaces: pairedRows.workspaces,
        pairedWorktrees: pairedRows.worktrees,
        hiddenWorkspaceIds: [],
        matchesWorkspaceContext: () => true,
      });
      return <PairedComputerStatusRows visibleDeviceIds={visible} />;
    }

    const secondPairedWorkspaceId = `computer-${MAC}:docs-remote`;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        setPairedProjectCollapsed(pairedWorkspaceId, false);
        setPairedProjectCollapsed(secondPairedWorkspaceId, false);
        root.render(<LiveCollapsedStatusProbe />);
      });
      expect(container.textContent).toBe('');

      // Collapsing only one project leaves the peer's other project visible.
      act(() => {
        setPairedProjectCollapsed(pairedWorkspaceId, true);
      });
      expect(container.textContent).toBe('');

      // Collapsing all projects containing the peer's tasks reveals the fallback status row.
      act(() => {
        setPairedProjectCollapsed(secondPairedWorkspaceId, true);
      });
      expect(container.textContent).toContain('MacBook Pro');
      expect(container.textContent).toContain('Connecting…');

      act(() => {
        setPairedProjectCollapsed(pairedWorkspaceId, false);
        setPairedProjectCollapsed(secondPairedWorkspaceId, false);
      });
      expect(container.textContent).toBe('');

      act(() => {
        root.render(
          <PairedComputerStatusRows visibleDeviceIds={hiddenTaskVisible} />,
        );
      });
      expect(container.textContent).toContain('MacBook Pro');
      expect(container.textContent).toContain('Connecting…');
    } finally {
      act(() => {
        setPairedProjectCollapsed(pairedWorkspaceId, false);
        setPairedProjectCollapsed(secondPairedWorkspaceId, false);
        root.unmount();
      });
      container.remove();
    }
  });

  it('keeps previously confirmed pending approvals when a subsequent approval read times out without overflow', async () => {
    let approvalCall = 0;
    const fake = fakeApi();
    fake.api.invoke = (_deviceId, channel): Promise<unknown> => {
      if (channel === 'approval:pending-requests') {
        approvalCall += 1;
        if (approvalCall === 1) {
          return Promise.resolve([
            { requestId: 'r-1', projectId: 'shop', worktreeId: 'fix-upload' },
          ]);
        }
        return new Promise(() => undefined);
      }
      return Promise.resolve(macSnapshot());
    };
    const onError = jest.fn();
    follower = new PairedComputersSidebarFollower(fake.api, onError, {
      approvalReadTimeoutMs: 25,
    });
    follower.follow([{ deviceId: MAC, name: 'MacBook Pro' }]);
    await settle();
    expect(
      pairedSidebarStore.getState().computers.get(MAC)?.toolApprovals,
    ).toEqual(new Set([pairedTaskKey('shop', 'fix-upload')]));

    // Trigger a second read whose approval RPC hangs past the timeout.
    fake.update(MAC, { type: 'reconnected' });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(approvalCall).toBe(2);
    expect(
      onError.mock.calls.some(
        ([err]: [unknown]) =>
          err instanceof Error &&
          err.message.includes('Timed out reading pending approvals'),
      ),
    ).toBe(true);
    expect(
      pairedSidebarStore.getState().computers.get(MAC)?.toolApprovals,
    ).toEqual(new Set([pairedTaskKey('shop', 'fix-upload')]));
  });

  it('preserves the running workflow indicator alongside pending tool approval instead of showing generic Working', async () => {
    const fake = fakeApi();
    fake.api.invoke = (_deviceId, channel): Promise<unknown> =>
      Promise.resolve(
        channel === 'approval:pending-requests'
          ? [{ requestId: 'r-1', projectId: 'shop', worktreeId: 'fix-upload' }]
          : macSnapshot({
              isStreaming: true,
              isRunningRun: true,
              pipelineStatus: 'running',
            }),
      );
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([{ deviceId: MAC, name: 'MacBook Pro' }]);
    await settle();

    const pairedWorkspaceId = `computer-${MAC}:shop`;
    const pairedWorktreeId = `computer-${MAC}:fix-upload`;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={{
              workspaces: [
                {
                  localId: pairedWorkspaceId,
                  name: 'storefront',
                  type: 'single-repo',
                  order: 0,
                },
              ],
              worktrees: [
                {
                  localId: pairedWorktreeId,
                  workspaceLocalId: pairedWorkspaceId,
                  branch: 'fix-upload',
                  order: 0,
                },
              ],
            }}
            capabilities={DESKTOP}
            capabilitiesFor={(): CanopyCapabilities =>
              pairedSidebarRowCapabilities(DESKTOP)
            }
            useWorktreeRowOverrides={usePairedWorktreeRowOverrides}
            selected={null}
            onSelectWorktree={(): void => undefined}
            onCreateWorktree={(): Promise<undefined> =>
              Promise.resolve(undefined)
            }
          />,
        );
      });

      expect(
        container.querySelector('[aria-label="Workflow running"]'),
      ).not.toBeNull();
      expect(container.querySelector('[aria-label="Working"]')).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('keeps the fallback status row visible when the Projects section is collapsed or a paired project is paginated out of view', async () => {
    const fake = fakeApi(() => Promise.resolve(macSnapshot()));
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([{ deviceId: MAC, name: 'MacBook Pro' }]);
    await settle();
    await act(async () => {
      fake.state(MAC, { status: 'connecting' });
      await settle();
    });

    const pairedWorkspaceId = `computer-${MAC}:shop`;
    const pairedWorktreeId = `computer-${MAC}:fix-upload`;

    // 1) Projects section collapse via SidebarSurface.
    function CollapsibleProjectsHarness(): JSX.Element {
      const [renderedIds, setRenderedIds] =
        useState<ReadonlySet<string> | null>(null);
      const workspaces = [
        {
          localId: pairedWorkspaceId,
          name: 'storefront',
          type: 'single-repo' as const,
          order: 0,
        },
      ];
      const pairedWorktrees = [
        {
          localId: pairedWorktreeId,
          workspaceLocalId: pairedWorkspaceId,
          branch: 'fix-upload',
          order: 0,
        },
      ];
      const visible = collectVisiblePairedDeviceIds({
        workspaces,
        pairedWorktrees,
        hiddenWorkspaceIds: [],
        renderedWorktreeKeys: renderedIds ?? undefined,
        matchesWorkspaceContext: () => true,
      });
      return (
        <SidebarSurface
          variant="drawer"
          chrome="navigation-only"
          workspacesSectionCollapsible
          contentState="ready"
          capabilities={DESKTOP}
          capabilitiesFor={(): CanopyCapabilities =>
            pairedSidebarRowCapabilities(DESKTOP)
          }
          snapshot={{
            workspaces,
            worktrees: pairedWorktrees,
            standaloneChats: [],
          }}
          selection={null}
          onSelect={(): void => undefined}
          onRenderedWorktreeKeysChange={setRenderedIds}
          testIds={{
            workspacesSection: 'sidebar-section-code',
            workspacesSectionToggle: 'sidebar-section-code-toggle',
          }}
          additionalRows={
            <PairedComputerStatusRows visibleDeviceIds={visible} />
          }
        />
      );
    }

    const collapseContainer = document.createElement('div');
    document.body.appendChild(collapseContainer);
    const collapseRoot: Root = createRoot(collapseContainer);
    try {
      act(() => {
        collapseRoot.render(<CollapsibleProjectsHarness />);
      });
      expect(
        collapseContainer.querySelector(
          '[data-testid="sidebar-paired-computer-status"]',
        ),
      ).toBeNull();

      const sectionToggle = collapseContainer.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-section-code-toggle"]',
      );
      expect(sectionToggle).not.toBeNull();
      act(() => {
        sectionToggle?.click();
      });
      const statusRow = collapseContainer.querySelector(
        '[data-testid="sidebar-paired-computer-status"]',
      );
      expect(statusRow?.textContent).toContain('MacBook Pro');
      expect(statusRow?.textContent).toContain('Connecting…');
    } finally {
      act(() => {
        collapseRoot.unmount();
      });
      collapseContainer.remove();
    }

    // 2) Pagination hiding the paired project past page 1.
    function PaginatedProjectsHarness(): JSX.Element {
      const [renderedIds, setRenderedIds] =
        useState<ReadonlySet<string> | null>(null);
      const workspaces = [
        ...Array.from({ length: 10 }, (_, index) => ({
          localId: `local-proj-${index}`,
          name: `Local ${index}`,
          type: 'single-repo' as const,
          order: index,
        })),
        {
          localId: pairedWorkspaceId,
          name: 'storefront',
          type: 'single-repo' as const,
          order: 10,
        },
      ];
      const pairedWorktrees = [
        {
          localId: pairedWorktreeId,
          workspaceLocalId: pairedWorkspaceId,
          branch: 'fix-upload',
          order: 0,
        },
      ];
      const visible = collectVisiblePairedDeviceIds({
        workspaces,
        pairedWorktrees,
        hiddenWorkspaceIds: [],
        renderedWorktreeKeys: renderedIds ?? undefined,
        matchesWorkspaceContext: () => true,
      });
      return (
        <>
          <WorkspacesSidebarSections
            paginateProjects
            state={{ workspaces, worktrees: pairedWorktrees }}
            capabilities={DESKTOP}
            capabilitiesFor={(): CanopyCapabilities =>
              pairedSidebarRowCapabilities(DESKTOP)
            }
            selected={null}
            onSelectWorktree={(): void => undefined}
            onCreateWorktree={(): Promise<undefined> =>
              Promise.resolve(undefined)
            }
            onRenderedWorktreeKeysChange={setRenderedIds}
          />
          <PairedComputerStatusRows visibleDeviceIds={visible} />
        </>
      );
    }

    const pageContainer = document.createElement('div');
    document.body.appendChild(pageContainer);
    const pageRoot: Root = createRoot(pageContainer);
    try {
      act(() => {
        pageRoot.render(<PaginatedProjectsHarness />);
      });
      const pagedStatus = pageContainer.querySelector(
        '[data-testid="sidebar-paired-computer-status"]',
      );
      expect(pagedStatus?.textContent).toContain('MacBook Pro');
      expect(pagedStatus?.textContent).toContain('Connecting…');

      const showMore = pageContainer.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-projects-show-more"]',
      );
      expect(showMore).not.toBeNull();
      act(() => {
        showMore?.click();
      });
      expect(
        pageContainer.querySelector(
          '[data-testid="sidebar-paired-computer-status"]',
        ),
      ).toBeNull();
    } finally {
      act(() => {
        pageRoot.unmount();
      });
      pageContainer.remove();
    }
  });

  it("removes the fallback status row when a reconnecting peer's Hidden tasks disclosure is expanded and restores it when closed", async () => {
    const fake = fakeApi(() =>
      Promise.resolve({
        workspaces: [
          { localId: 'shop', name: 'storefront', type: 'single-repo' },
        ],
        worktrees: [
          {
            localId: 'fix-upload',
            workspaceLocalId: 'shop',
            branch: 'fix-upload',
            hidden: true,
            order: 0,
          },
        ],
      }),
    );
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([{ deviceId: MAC, name: 'MacBook Pro' }]);
    await settle();
    await act(async () => {
      fake.state(MAC, { status: 'connecting' });
      await settle();
    });

    const pairedWorkspaceId = `computer-${MAC}:shop`;
    const pairedWorktreeId = `computer-${MAC}:fix-upload`;

    function HiddenDisclosureHarness(): JSX.Element {
      const [renderedKeys, setRenderedKeys] =
        useState<ReadonlySet<string> | null>(null);
      const workspaces = [
        {
          localId: pairedWorkspaceId,
          name: 'storefront',
          type: 'single-repo' as const,
          order: 0,
        },
      ];
      const pairedWorktrees = [
        {
          localId: pairedWorktreeId,
          workspaceLocalId: pairedWorkspaceId,
          branch: 'fix-upload',
          hidden: true,
          order: 0,
        },
      ];
      const visible = collectVisiblePairedDeviceIds({
        workspaces,
        pairedWorktrees,
        hiddenWorkspaceIds: [],
        renderedWorktreeKeys: renderedKeys ?? undefined,
        matchesWorkspaceContext: () => true,
      });
      return (
        <>
          <WorkspacesSidebarSections
            state={{ workspaces, worktrees: pairedWorktrees }}
            capabilities={DESKTOP}
            capabilitiesFor={(): CanopyCapabilities =>
              pairedSidebarRowCapabilities(DESKTOP)
            }
            useWorktreeRowOverrides={usePairedWorktreeRowOverrides}
            hiddenWorktreesPlacement={() => 'inline'}
            testIds={{
              hiddenWorktreesToggle: (workspaceId) =>
                `hidden-worktrees-toggle-${workspaceId}`,
            }}
            selected={null}
            onSelectWorktree={(): void => undefined}
            onCreateWorktree={(): Promise<undefined> =>
              Promise.resolve(undefined)
            }
            onRenderedWorktreeKeysChange={setRenderedKeys}
          />
          <PairedComputerStatusRows visibleDeviceIds={visible} />
        </>
      );
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(<HiddenDisclosureHarness />);
      });
      // Closed disclosure: task row is not rendered, fallback status row shows.
      expect(
        container.querySelector(`[data-worktree-id="${pairedWorktreeId}"]`),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="sidebar-paired-computer-status"]',
        )?.textContent,
      ).toContain('Connecting…');

      // Expanding Hidden tasks shows the task row and removes the duplicate fallback row.
      const toggle = container.querySelector<HTMLButtonElement>(
        `[data-testid="hidden-worktrees-toggle-${pairedWorkspaceId}"]`,
      );
      expect(toggle).not.toBeNull();
      act(() => {
        toggle?.click();
      });
      expect(
        container.querySelector(`[data-worktree-id="${pairedWorktreeId}"]`),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="sidebar-paired-computer-status"]',
        ),
      ).toBeNull();

      // Closing Hidden tasks hides the task row and brings the fallback row back.
      act(() => {
        toggle?.click();
      });
      expect(
        container.querySelector(`[data-worktree-id="${pairedWorktreeId}"]`),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="sidebar-paired-computer-status"]',
        )?.textContent,
      ).toContain('Connecting…');
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("updates a paired row's workflow badge live when snapshot-stale pushes follow workflow status changes without a reconnect", async () => {
    let currentPipelineStatus: 'running' | 'paused' | undefined;
    const fake = fakeApi(() =>
      Promise.resolve(
        macSnapshot(
          currentPipelineStatus === undefined
            ? {}
            : { pipelineStatus: currentPipelineStatus },
        ),
      ),
    );
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([{ deviceId: MAC, name: 'MacBook Pro' }]);
    await settle();

    const pairedWorkspaceId = `computer-${MAC}:shop`;
    const pairedWorktreeId = `computer-${MAC}:fix-upload`;
    const renderPipelinePopover = jest.fn(() => (
      <div data-testid="local-pipeline-popover">No workflow details</div>
    ));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={{
              workspaces: [
                {
                  localId: pairedWorkspaceId,
                  name: 'storefront',
                  type: 'single-repo',
                  order: 0,
                },
              ],
              worktrees: [
                {
                  localId: pairedWorktreeId,
                  workspaceLocalId: pairedWorkspaceId,
                  branch: 'fix-upload',
                  order: 0,
                },
              ],
            }}
            capabilities={DESKTOP}
            capabilitiesFor={(): CanopyCapabilities =>
              pairedSidebarRowCapabilities(DESKTOP)
            }
            useWorktreeRowOverrides={usePairedWorktreeRowOverrides}
            renderPipelinePopover={renderPipelinePopover}
            selected={null}
            onSelectWorktree={(): void => undefined}
            onCreateWorktree={(): Promise<undefined> =>
              Promise.resolve(undefined)
            }
          />,
        );
      });
      expect(
        container.querySelector('[aria-label="Workflow running"]'),
      ).toBeNull();

      // Workflow starts on peer -> stale push refreshes badge to running.
      currentPipelineStatus = 'running';
      await act(async () => {
        fake.update(MAC, {
          type: 'push',
          channel: 'desktop:session-snapshot-stale',
          args: [],
        });
        await settle();
      });
      const runningBadge = container.querySelector(
        '[aria-label="Workflow running"]',
      );
      expect(runningBadge).not.toBeNull();
      act(() => {
        runningBadge?.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true }),
        );
        runningBadge?.dispatchEvent(
          new FocusEvent('focusin', { bubbles: true }),
        );
      });
      expect(renderPipelinePopover).not.toHaveBeenCalled();
      expect(
        container.querySelector('[data-testid="local-pipeline-popover"]'),
      ).toBeNull();

      // Workflow pauses on peer -> stale push refreshes badge to paused.
      currentPipelineStatus = 'paused';
      await act(async () => {
        fake.update(MAC, {
          type: 'push',
          channel: 'desktop:session-snapshot-stale',
          args: [],
        });
        await settle();
      });
      const pausedBadge = container.querySelector(
        '[aria-label="Workflow paused"]',
      );
      expect(pausedBadge).not.toBeNull();
      act(() => {
        pausedBadge?.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true }),
        );
        pausedBadge?.dispatchEvent(
          new FocusEvent('focusin', { bubbles: true }),
        );
      });
      expect(renderPipelinePopover).not.toHaveBeenCalled();
      expect(
        container.querySelector('[data-testid="local-pipeline-popover"]'),
      ).toBeNull();

      // Workflow finishes on peer -> stale push clears workflow badge.
      currentPipelineStatus = undefined;
      await act(async () => {
        fake.update(MAC, {
          type: 'push',
          channel: 'desktop:session-snapshot-stale',
          args: [],
        });
        await settle();
      });
      expect(
        container.querySelector('[aria-label="Workflow running"]'),
      ).toBeNull();
      expect(
        container.querySelector('[aria-label="Workflow paused"]'),
      ).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('masks paired project and computer names in PostHog click autocapture events from rendered headers', () => {
    const projectName = 'Secret Project';
    const computerName = "Nick's Mac";
    const displayName = `${projectName} on ${computerName}`;
    const pairedWorkspaceId = `computer-${MAC}:secret`;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(
          <WorkspaceSectionHeader
            name={displayName}
            workspaceType="single-repo"
            worktreeCount={2}
            collapsed={false}
            onToggleCollapse={(): void => undefined}
            onSettings={(): void => undefined}
            onDelete={(): void => undefined}
            dataTestId={`sidebar-project-${pairedWorkspaceId}`}
          />,
        );
      });

      const collapseButton = container.querySelector<HTMLButtonElement>(
        `button[aria-label*="Collapse ${displayName}"]`,
      );
      expect(collapseButton).not.toBeNull();

      // Build PostHog's innermost-first $elements chain from the rendered DOM.
      const elements: Record<string, unknown>[] = [];
      for (
        let node: Element | null = collapseButton;
        node && node !== document.body;
        node = node.parentElement
      ) {
        const entry: Record<string, unknown> = {
          tag_name: node.tagName.toLowerCase(),
        };
        for (const attr of Array.from(node.attributes)) {
          entry[`attr__${attr.name}`] = attr.value;
        }
        if (node === collapseButton) {
          entry.$el_text = node.textContent ?? '';
        }
        elements.push(entry);
      }

      for (const eventName of ['$autocapture', '$rageclick', '$dead_click']) {
        const sanitized = sanitizePostHogEvent({
          event: eventName,
          properties: {
            $event_type: 'click',
            $el_text: collapseButton?.textContent ?? '',
            $elements: elements,
          },
        });
        expect(sanitized).not.toBeNull();
        const serialized = JSON.stringify(sanitized);
        expect(serialized).not.toContain(projectName);
        expect(serialized).not.toContain(computerName);
        expect(serialized).not.toContain(MAC);
        const sanitizedElements = sanitized?.properties?.$elements;
        expect(sanitizedElements?.[0]?.['attr__aria-label']).toBe('********');
      }

      // String-only $elements_chain payloads that omit $elements fail closed.
      const stringOnly = sanitizePostHogEvent({
        event: '$autocapture',
        properties: {
          $event_type: 'click',
          $el_text: displayName,
          'attr__aria-label': `Collapse ${displayName}`,
          $elements_chain: `button.focus-ring:aria-label="Collapse ${displayName}";div.ph-mask`,
        },
      });
      const stringOnlySerialized = JSON.stringify(stringOnly);
      expect(stringOnlySerialized).not.toContain(projectName);
      expect(stringOnlySerialized).not.toContain(computerName);
      expect(stringOnly?.properties?.$elements_chain).toBeUndefined();
      expect(stringOnly?.properties?.['attr__aria-label']).toBe('********');

      // Clicks outside a masked subtree keep ordinary button labels intact.
      const unmasked = sanitizePostHogEvent({
        event: '$autocapture',
        properties: {
          $event_type: 'click',
          $el_text: 'Open settings',
          $elements: [
            {
              tag_name: 'button',
              'attr__aria-label': 'Open settings',
              $el_text: 'Open settings',
            },
            { tag_name: 'div', attr__class: 'toolbar' },
          ],
        },
      });
      const unmaskedElements = unmasked?.properties?.$elements;
      expect(unmaskedElements?.[0]?.['attr__aria-label']).toBe('Open settings');
      expect(unmaskedElements?.[0]?.$el_text).toBe('Open settings');
      expect(unmasked?.properties?.$el_text).toBe('Open settings');
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('does not show a duplicate Connecting status row when a reconnecting peer task is revealed under expanded Hidden projects', async () => {
    const fake = fakeApi();
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([{ deviceId: MAC, name: 'MacBook Pro' }]);
    await settle();
    fake.state(MAC, { status: 'connecting' });

    const pairedWorkspaceId = `computer-${MAC}:shop`;
    const pairedWorktreeId = `computer-${MAC}:fix-upload`;

    function HiddenProjectsHarness(): JSX.Element {
      const [renderedKeys, setRenderedKeys] =
        useState<ReadonlySet<string> | null>(null);
      const workspaces = [
        {
          localId: 'local-visible',
          name: 'visible-repo',
          type: 'single-repo' as const,
          order: 0,
        },
        {
          localId: pairedWorkspaceId,
          name: 'storefront',
          type: 'single-repo' as const,
          order: 1,
          hidden: true,
        },
      ];
      const pairedWorktrees = [
        {
          localId: pairedWorktreeId,
          workspaceLocalId: pairedWorkspaceId,
          branch: 'fix-upload',
          order: 0,
        },
      ];
      const visible = collectVisiblePairedDeviceIds({
        workspaces,
        pairedWorktrees,
        hiddenWorkspaceIds: [pairedWorkspaceId],
        renderedWorktreeKeys: renderedKeys ?? undefined,
        matchesWorkspaceContext: () => true,
      });
      return (
        <>
          <WorkspacesSidebarSections
            state={{ workspaces, worktrees: pairedWorktrees }}
            capabilities={DESKTOP}
            capabilitiesFor={(): CanopyCapabilities =>
              pairedSidebarRowCapabilities(DESKTOP)
            }
            useWorktreeRowOverrides={usePairedWorktreeRowOverrides}
            testIds={{
              hiddenWorkspacesToggle: 'hidden-workspaces-toggle',
            }}
            selected={null}
            onSelectWorktree={(): void => undefined}
            onCreateWorktree={(): Promise<undefined> =>
              Promise.resolve(undefined)
            }
            onRenderedWorktreeKeysChange={setRenderedKeys}
          />
          <PairedComputerStatusRows visibleDeviceIds={visible} />
        </>
      );
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(<HiddenProjectsHarness />);
      });
      // Collapsed Hidden projects: task row hidden, fallback Connecting row visible.
      expect(
        container.querySelector(`[data-worktree-id="${pairedWorktreeId}"]`),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="sidebar-paired-computer-status"]',
        )?.textContent,
      ).toContain('Connecting…');

      // Expanding Hidden projects renders the task row and removes the duplicate fallback row.
      const toggle = container.querySelector<HTMLButtonElement>(
        '[data-testid="hidden-workspaces-toggle"]',
      );
      expect(toggle).not.toBeNull();
      act(() => {
        toggle?.click();
      });
      expect(
        container.querySelector(`[data-worktree-id="${pairedWorktreeId}"]`),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="sidebar-paired-computer-status"]',
        ),
      ).toBeNull();

      // Collapsing Hidden projects restores the fallback Connecting row.
      act(() => {
        toggle?.click();
      });
      expect(
        container.querySelector(`[data-worktree-id="${pairedWorktreeId}"]`),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="sidebar-paired-computer-status"]',
        )?.textContent,
      ).toContain('Connecting…');
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('keeps a deferred local project with visible paired tasks in the main Projects section while keeping explicitly hidden projects hidden', async () => {
    const fake = fakeApi(() => Promise.resolve(macSnapshot()));
    follower = new PairedComputersSidebarFollower(fake.api, jest.fn());
    follower.follow([{ deviceId: MAC, name: 'MacBook Pro' }]);
    await settle();

    const emptyDeferredStorefront: SingleRepoSidebarItem = {
      ...LOCAL_STOREFRONT,
      alwaysShow: false,
      worktrees: [],
    };
    const buildRows = createPairedSidebarRowsBuilder(createProjectGrouper());
    const paired = buildRows({
      localProjects: [emptyDeferredStorefront],
      localFacts: null,
      accountId: null,
      computers: pairedSidebarStore.getState().structures,
    });

    // Paired task grouped into the empty deferred local project prevents auto-hiding.
    const deferredEmpty = selectDeferredEmptyWorkspaceIds(
      [emptyDeferredStorefront],
      paired.worktrees,
    );
    expect(deferredEmpty.has('storefront')).toBe(false);

    const combined = appendPairedSidebarRows(
      {
        workspaces: [
          {
            localId: 'storefront',
            name: 'storefront',
            type: 'single-repo' as const,
            order: 0,
            alwaysShow: false,
            ...(deferredEmpty.has('storefront') ? { hidden: true } : {}),
          },
        ],
        worktrees: [],
      },
      paired,
    );
    const partitions = partitionWorkspaces(
      combined.workspaces,
      combined.worktrees,
    );
    expect(partitions.visible.map((w) => w.localId)).toContain('storefront');
    expect(partitions.hidden.map((w) => w.localId)).not.toContain('storefront');

    // Explicitly hidden projects remain hidden even when they hold visible paired tasks.
    const explicitlyHiddenPartitions = partitionWorkspaces(
      combined.workspaces.map((w) =>
        w.localId === 'storefront' ? { ...w, hidden: true } : w,
      ),
      combined.worktrees,
    );
    expect(
      explicitlyHiddenPartitions.visible.map((w) => w.localId),
    ).not.toContain('storefront');
    expect(explicitlyHiddenPartitions.hidden.map((w) => w.localId)).toContain(
      'storefront',
    );
  });

  it('renders a snapshot-backed paused badge through desktop row overrides and hydrates its popover details on open', async () => {
    const {
      resetDesktopRowLiveKeys,
      setDesktopRowLiveKeys,
      useDesktopWorktreeRowOverrides,
    } = await import('@/components/sidebar/desktopWorktreeRowOverrides');
    const {
      readDesktopPipelinePopoverEntries,
      subscribeDesktopPipelinePopoverEntries,
    } = await import('@/components/sidebar/DesktopSharedSidebarHost');
    const { SidebarPipelineStatusPopover } =
      await import('@canopy/ui-app/code/shell/SidebarPipelineStatusPopover');
    const { usePipelineRunsStore } = await import('@/stores/pipelineRunsStore');

    const key = 'storefront/csv-export';
    const baseKeys = {
      statusByKey: new Map([[key, 'idle' as const]]),
      streaming: new Set<string>(),
      awaitingApproval: new Set<string>(),
      pendingQuestion: new Set<string>(),
      toolApproval: new Set<string>(),
      unread: new Set<string>(),
      pipelineRunning: new Set<string>(),
      pipelineUnseen: new Set<string>(),
      pipelineUnseenFailed: new Set<string>(),
      pipelinePaused: new Set<string>(),
      backgroundTasks: new Map<string, number>(),
    };

    const previousPipelines = window.pipelines;
    const listExecutionsMock = jest.fn().mockResolvedValue({
      success: true,
      data: [
        {
          id: 'exec-restored-pause-1',
          pipeline_id: 'deploy-check',
          pipeline_name: 'Deploy Check',
          status: 'paused',
          started_at: '2026-11-26T00:00:00.000Z',
          cwd: '/repos/storefront/csv-export',
          project_id: 'storefront',
          worktree_id: 'csv-export',
        },
      ],
    });
    const listAdvisorSnapshotsMock = jest.fn().mockResolvedValue({
      success: true,
      data: {},
    });
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      writable: true,
      value: {
        ...(previousPipelines ?? {}),
        listExecutions: listExecutionsMock,
        listAdvisorSnapshots: listAdvisorSnapshotsMock,
      },
    });

    usePipelineRunsStore.setState({
      pipelineSummariesByWorktree: {},
      pausedExecutionsByWorktree: {},
      runningExecutionsByWorktree: {},
      unseenPipelineWorktreeKeys: new Set<string>(),
      unseenFailedPipelineWorktreeKeys: new Set<string>(),
      isHydratingGlobalPipelineStatuses: false,
      hasHydratedGlobalPipelineStatuses: true,
    });
    // Renderer only knows an unseen completion; snapshot carries the restored pause.
    setDesktopRowLiveKeys({
      ...baseKeys,
      pipelineUnseen: new Set([key]),
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={{
              workspaces: [
                {
                  localId: 'storefront',
                  name: 'storefront',
                  type: 'single-repo',
                  order: 0,
                },
              ],
              worktrees: [
                {
                  localId: 'csv-export',
                  workspaceLocalId: 'storefront',
                  branch: 'csv-export',
                  order: 0,
                  pipelineStatus: 'paused',
                },
              ],
            }}
            capabilities={DESKTOP}
            useWorktreeRowOverrides={useDesktopWorktreeRowOverrides}
            renderPipelinePopover={({
              worktree,
              workspace,
              anchorRect,
              pipelineStatus,
              popoverListId,
            }) =>
              pipelineStatus && anchorRect ? (
                <SidebarPipelineStatusPopover
                  anchorRect={anchorRect}
                  worktreeLocalId={worktree.localId}
                  workspaceLocalId={workspace.localId}
                  getEntries={readDesktopPipelinePopoverEntries}
                  subscribeEntries={subscribeDesktopPipelinePopoverEntries}
                  status={pipelineStatus}
                  listId={popoverListId}
                />
              ) : null
            }
            selected={null}
            onSelectWorktree={(): void => undefined}
            onCreateWorktree={(): Promise<undefined> =>
              Promise.resolve(undefined)
            }
          />,
        );
      });

      // Production hook merges snapshot paused above renderer-only unseen.
      const pausedBadge = container.querySelector<HTMLElement>(
        '[aria-label="Workflow paused"]',
      );
      expect(pausedBadge).not.toBeNull();

      // Focusing the snapshot-backed paused badge opens the popover and
      // hydrates workflow details on demand instead of showing "No workflow details".
      await act(async () => {
        pausedBadge?.dispatchEvent(
          new FocusEvent('focusin', { bubbles: true }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      await settle();

      expect(listExecutionsMock).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain('Deploy Check');
      expect(document.body.textContent).not.toContain('No workflow details');

      // Renderer unseen-failure and running still outrank snapshot paused.
      act(() => {
        setDesktopRowLiveKeys({
          ...baseKeys,
          pipelineUnseenFailed: new Set([key]),
        });
      });
      expect(
        container.querySelector('[aria-label="Workflow failed"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[aria-label="Workflow paused"]'),
      ).toBeNull();

      act(() => {
        setDesktopRowLiveKeys({
          ...baseKeys,
          pipelineRunning: new Set([key]),
        });
      });
      expect(
        container.querySelector('[aria-label="Workflow running"]'),
      ).not.toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
      resetDesktopRowLiveKeys();
      Object.defineProperty(window, 'pipelines', {
        configurable: true,
        writable: true,
        value: previousPipelines,
      });
    }
  });
});
