import { create } from 'zustand';
import {
  createSidebarPlacementStore,
  createSidebarPlacementWriteQueue,
  projectSidebarPlacementOrders,
  moveSidebarItemMembership,
  type SidebarPlacementSnapshot,
  type SidebarPlacementStore,
} from '@canopy/app-state';
import {
  isSidebarItemGroupRetained,
  normalizeSidebarItemGroups,
  nextSidebarItemGroupColor,
  resolveSidebarItemGroupCollapsed,
  resolveSidebarItemGroupLabel,
  type SidebarItemGroup,
  type SidebarItemGroupScope,
  type SidebarItemGroupCreateRequest,
  type SidebarItemGroupUpdateRequest,
  type SidebarItemGroupMoveItemRequest,
  type SidebarItemGroupMoveRequest,
} from '@canopy/protocol/sidebar';
import type { SessionViewModel } from '@canopy/app-core';
import type {
  SidebarItemGroupPendingPlacement,
  SidebarItemGroupView,
} from '@canopy/ui-app/sidebar';
import { useWorkspaceContextStore } from './workspaceContextStore';
import { useProjectsStore } from './projectsStore';
import {
  getWorkEntrySnapshotRevision,
  useStandaloneChatStore,
} from './standaloneChatStore';

export function sidebarItemGroupScopeKey(scope: SidebarItemGroupScope): string {
  return scope.appAdvisor
    ? 'app-advisor'
    : `workspace:${scope.workspaceLocalId}`;
}

interface SidebarItemGroupsState {
  byScope: Record<string, SidebarItemGroupView[]>;
  orderByScope: Record<string, readonly string[]>;
  errors: Record<string, string | undefined>;
  confirmCreatedItem: (
    scope: SidebarItemGroupScope,
    destinationGroupId: string | null,
    itemId: string,
  ) => void;
  hydrate: (scope: SidebarItemGroupScope) => Promise<void>;
  create: (request: SidebarItemGroupCreateRequest) => Promise<SidebarItemGroup>;
  update: (request: SidebarItemGroupUpdateRequest) => Promise<void>;
  ungroup: (request: {
    scope: SidebarItemGroupScope;
    groupId: string;
  }) => Promise<void>;
  moveItem: (
    request: SidebarItemGroupMoveItemRequest,
    membershipOnly?: boolean,
  ) => Promise<void>;
  moveGroup: (request: SidebarItemGroupMoveRequest) => Promise<void>;
}

// Created on first write so importing this store has no load-time dependency
// on @canopy/app-state.
let scopeWrites: ReturnType<typeof createSidebarPlacementWriteQueue> | null =
  null;
let writeContext = 0;
function saveInScope<T>(
  scope: SidebarItemGroupScope,
  operation: () => Promise<T>,
): Promise<T> {
  const context = writeContext;
  scopeWrites ??= createSidebarPlacementWriteQueue();
  return scopeWrites(`${context}:${sidebarItemGroupScopeKey(scope)}`, () => {
    if (context !== writeContext)
      return Promise.reject(new Error('Sidebar context changed'));
    return operation();
  });
}

const generations = new Map<string, number>();
const mutationQueues = new Map<string, Promise<unknown>>();
const pendingCreationConfirmations = new Map<
  string,
  Map<string, string | null>
>();

/**
 * Every move into a group, in order, per scope. Kept beside the store, not in
 * `byScope`: other consumers read `byScope` as registry-shaped groups, and
 * only the sidebar needs this, while its row order is stale. A later move can
 * be anchored on the slot an earlier one made, so the sidebar replays them
 * all; once the order includes a row, its entries no longer move it.
 */
interface PlacementRequest {
  groupId: string;
  placement: SidebarItemGroupPendingPlacement;
}
const placementRequests = new Map<string, PlacementRequest[]>();
/** Bounds a long session; dropped entries have long been overtaken. */
const PLACEMENT_REQUEST_LIMIT = 100;

function recordPlacementRequest(key: string, request: PlacementRequest): void {
  const requests = [...(placementRequests.get(key) ?? []), request];
  placementRequests.set(key, requests.slice(-PLACEMENT_REQUEST_LIMIT));
}

function forgetPlacementRequests(key: string, itemId: string): void {
  const requests = placementRequests.get(key);
  if (requests)
    placementRequests.set(
      key,
      requests.filter((request) => request.placement.itemId !== itemId),
    );
}

/** Drops requests for rows that are no longer members of their group. */
function prunePlacementRequests(
  key: string,
  groups: readonly SidebarItemGroup[],
): void {
  const requests = placementRequests.get(key);
  if (!requests) return;
  placementRequests.set(
    key,
    requests.filter((request) =>
      groups
        .find((group) => group.id === request.groupId)
        ?.memberIds.includes(request.placement.itemId),
    ),
  );
}

function placementRequestsFor(
  key: string,
  groupId: string,
): SidebarItemGroupPendingPlacement[] {
  return (placementRequests.get(key) ?? [])
    .filter((request) => request.groupId === groupId)
    .map((request) => request.placement);
}

function confirmMembership(
  groups: SidebarItemGroupView[],
  destinationGroupId: string | null,
  itemId: string,
): SidebarItemGroup[] {
  // A missing destination must not remove membership from a known group.
  if (
    destinationGroupId !== null &&
    !groups.some((group) => group.id === destinationGroupId)
  )
    return groups;
  return groups
    .map((group) => {
      const memberIds =
        group.id === destinationGroupId
          ? [...group.memberIds.filter((id) => id !== itemId), itemId]
          : group.memberIds.filter((id) => id !== itemId);
      const next = { ...group, memberIds };
      return {
        ...next,
        collapsed: resolveSidebarItemGroupCollapsed(
          next,
          group.memberIds.length,
        ),
      };
    })
    .filter(isSidebarItemGroupRetained);
}

function nextGeneration(key: string): number {
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  return generation;
}

function isCoworkScope(scope: SidebarItemGroupScope): boolean {
  if (scope.appAdvisor) return false;
  const project = useProjectsStore
    .getState()
    .projects.find((candidate) => candidate.id === scope.workspaceLocalId);
  if (project) return project.type === 'cowork';
  const entries = useStandaloneChatStore.getState();
  return (
    entries.activeChatProjectId === scope.workspaceLocalId ||
    entries.sidebarEntriesByProject?.[scope.workspaceLocalId] !== undefined
  );
}

async function refreshOrder(scope: SidebarItemGroupScope): Promise<void> {
  if (scope.appAdvisor)
    await useStandaloneChatStore.getState().refreshWorkEntries('app-advisor');
  else if (isCoworkScope(scope))
    await useStandaloneChatStore
      .getState()
      .refreshWorkEntries(scope.workspaceLocalId);
  else await useProjectsStore.getState().loadProjects({ silent: true });
}

async function readGroups(scope: SidebarItemGroupScope): Promise<void> {
  const key = sidebarItemGroupScopeKey(scope);
  const placement = coworkPlacements.get(key);
  if (placement) {
    placement.reconcile();
    return;
  }
  const generation = nextGeneration(key);
  const groups = await window.api.sidebarItemGroups.list(scope);
  if (generations.get(key) !== generation) return;
  const confirmations = pendingCreationConfirmations.get(key);
  let projected = groups;
  confirmations?.forEach((destinationGroupId, itemId) => {
    projected = confirmMembership(projected, destinationGroupId, itemId);
  });
  pendingCreationConfirmations.delete(key);
  prunePlacementRequests(key, projected);
  useSidebarItemGroupsStore.setState((state) => ({
    byScope: { ...state.byScope, [key]: projected },
  }));
}

async function mutate<T>(
  scope: SidebarItemGroupScope,
  optimistic: (groups: SidebarItemGroup[]) => SidebarItemGroup[],
  operation: () => Promise<T>,
  confirmed?: (groups: SidebarItemGroup[], result: T) => SidebarItemGroup[],
): Promise<T> {
  const key = sidebarItemGroupScopeKey(scope);
  const placement = coworkPlacement(scope);
  if (placement)
    return placement.changeGroups(
      optimistic,
      () => saveInScope(scope, operation),
      confirmed,
    );
  const run = async (): Promise<T> => {
    const store = useSidebarItemGroupsStore;
    if (store.getState().byScope[key] === undefined) await readGroups(scope);
    nextGeneration(key); // A read started before this intent cannot erase optimism.
    const before = store.getState().byScope[key] ?? [];
    const copies = before.map((group) => ({
      ...group,
      memberIds: [...group.memberIds],
    }));
    store.setState((state) => ({
      byScope: {
        ...state.byScope,
        [key]: optimistic(copies).map((group) => {
          const previous = before.find((item) => item.id === group.id);
          const membershipChanged =
            previous &&
            (previous.memberIds.length !== group.memberIds.length ||
              previous.memberIds.some(
                (id, index) => id !== group.memberIds[index],
              ));
          const next = {
            ...group,
            collapsed: previous
              ? resolveSidebarItemGroupCollapsed(
                  group,
                  previous.memberIds.length,
                )
              : group.collapsed,
          };
          return membershipChanged
            ? {
                ...next,
                retainedMemberIds:
                  previous.retainedMemberIds ?? previous.memberIds,
              }
            : next;
        }),
      },
      errors: { ...state.errors, [key]: undefined },
    }));
    let result: T;
    try {
      result = await saveInScope(scope, operation);
    } catch (error) {
      nextGeneration(key);
      store.setState((state) => ({
        byScope: { ...state.byScope, [key]: before },
        errors: {
          ...state.errors,
          [key]:
            error instanceof Error
              ? error.message
              : 'Sidebar item groups are unavailable',
        },
      }));
      // An order-first write may be durable even when membership failed. Refetch
      // both owners; retaining the optimistic snapshot would fabricate success.
      await Promise.allSettled([readGroups(scope), refreshOrder(scope)]);
      throw error;
    }
    if (confirmed)
      store.setState((state) => ({
        byScope: {
          ...state.byScope,
          [key]: confirmed(state.byScope[key] ?? [], result),
        },
      }));
    // The command committed. A failed projection refresh must not fabricate a
    // failed mutation or invite the caller to retry an already applied intent.
    // Retain the old visual anchor until the canonical row order is present.
    const orderRefresh = await Promise.allSettled([refreshOrder(scope)]);
    const groupRefresh = await Promise.allSettled([readGroups(scope)]);
    const refreshed = [...orderRefresh, ...groupRefresh];
    const failure = refreshed.find((item) => item.status === 'rejected');
    if (failure?.status === 'rejected')
      store.setState((state) => ({
        errors: {
          ...state.errors,
          [key]:
            failure.reason instanceof Error
              ? failure.reason.message
              : 'Sidebar item groups are unavailable',
        },
      }));
    return result;
  };
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  mutationQueues.set(key, next);
  try {
    return await next;
  } finally {
    if (mutationQueues.get(key) === next) mutationQueues.delete(key);
  }
}

export const useSidebarItemGroupsStore = create<SidebarItemGroupsState>(
  (set, get) => ({
    byScope: {},
    orderByScope: {},
    errors: {},
    // Called only after the host's grouped creation acknowledgement, before
    // publishing the new renderer row. In-flight older reads cannot erase it.
    confirmCreatedItem: (scope, destinationGroupId, itemId): void => {
      const key = sidebarItemGroupScopeKey(scope);
      const placement = coworkPlacements.get(key);
      if (placement) {
        void placement
          .changeGroups(
            (groups) => confirmMembership(groups, destinationGroupId, itemId),
            () => Promise.resolve(),
          )
          .catch(() => undefined);
        return;
      }
      // A created row arrives already ordered; no earlier request applies.
      forgetPlacementRequests(key, itemId);
      // Keep an unhydrated scope undefined so its snapshot groups remain
      // visible. The first successful read merges acknowledged new members;
      // it must remain eligible instead of being invalidated by this ACK.
      if (get().byScope[key] === undefined) {
        const confirmations =
          pendingCreationConfirmations.get(key) ??
          new Map<string, string | null>();
        confirmations.set(itemId, destinationGroupId);
        pendingCreationConfirmations.set(key, confirmations);
        return;
      }
      nextGeneration(key);
      set((state) => ({
        byScope: {
          ...state.byScope,
          [key]: confirmMembership(
            state.byScope[key] ?? [],
            destinationGroupId,
            itemId,
          ).map((group) => {
            const previous = state.byScope[key]?.find(
              (item) => item.id === group.id,
            );
            return group.id === destinationGroupId && previous
              ? {
                  ...group,
                  retainedMemberIds:
                    previous.retainedMemberIds ?? previous.memberIds,
                }
              : group;
          }),
        },
      }));
    },
    hydrate: async (scope): Promise<void> => {
      // Main broadcasts a change as soon as a local write commits, before the
      // canonical row order reloads. Reading then would drop the retained
      // anchor and briefly move the group to the incoming row. Each mutation
      // ends with its own read, so wait for the queue and read afterwards.
      const key = sidebarItemGroupScopeKey(scope);
      for (let pending = mutationQueues.get(key); pending; ) {
        await pending.catch(() => undefined);
        const next = mutationQueues.get(key);
        pending = next === pending ? undefined : next;
      }
      await readGroups(scope);
    },
    create: (request): Promise<SidebarItemGroup> =>
      mutate(
        request.scope,
        (groups) => {
          for (const group of groups)
            group.memberIds = group.memberIds.filter(
              (id) => id !== request.itemId,
            );
          const remainingGroups = groups.filter(isSidebarItemGroupRetained);
          const color =
            request.color ?? nextSidebarItemGroupColor(remainingGroups);
          const label = resolveSidebarItemGroupLabel({
            name: request.name,
            labelHidden: request.labelHidden,
            others: remainingGroups,
          });
          return [
            ...remainingGroups,
            {
              id: 'grp-pending',
              name: label.name,
              color,
              ...(label.labelHidden ? { labelHidden: true } : {}),
              collapsed: false,
              memberIds: [request.itemId],
            },
          ];
        },
        () => window.api.sidebarItemGroups.create(request),
        (groups, created) =>
          groups.map((group) =>
            group.id === 'grp-pending'
              ? { ...created, memberIds: [...created.memberIds] }
              : group,
          ),
      ),
    update: (request): Promise<void> =>
      mutate(
        request.scope,
        (groups) => {
          const group = groups.find(
            (candidate) => candidate.id === request.groupId,
          );
          if (group) {
            // An empty group owns its editor until the host confirms removal.
            if (request.keepWhenEmpty === false && group.memberIds.length === 0)
              return groups;
            if (
              request.name !== undefined ||
              request.labelHidden !== undefined ||
              request.color !== undefined
            ) {
              const label = resolveSidebarItemGroupLabel({
                name: request.name,
                labelHidden: request.labelHidden,
                previous: group,
                others: groups.filter((candidate) => candidate.id !== group.id),
              });
              group.name = label.name;
              group.color = request.color ?? group.color;
              if (label.labelHidden) group.labelHidden = true;
              else delete group.labelHidden;
            }
            if (request.collapsed !== undefined)
              group.collapsed = request.collapsed;
            if (request.keepWhenEmpty === true) group.keepWhenEmpty = true;
            else if (request.keepWhenEmpty === false)
              delete group.keepWhenEmpty;
          }
          // Anchors are live rows too; dropping one would move an empty group.
          return normalizeSidebarItemGroups(groups, {
            liveItemIds: groups.flatMap((candidate) => [
              ...candidate.memberIds,
              ...(candidate.emptyAnchorId ? [candidate.emptyAnchorId] : []),
            ]),
          });
        },
        () => window.api.sidebarItemGroups.update(request),
        request.keepWhenEmpty === false
          ? (groups) =>
              groups.filter(
                (group) =>
                  group.id !== request.groupId || group.memberIds.length > 0,
              )
          : undefined,
      ),
    ungroup: (request): Promise<void> =>
      mutate(
        request.scope,
        (groups) => groups.filter((group) => group.id !== request.groupId),
        () => window.api.sidebarItemGroups.ungroup(request),
      ),
    moveItem: (request, membershipOnly = false): Promise<void> => {
      const placementStore = coworkPlacement(request.scope);
      if (placementStore) return placementStore.move(request, membershipOnly);
      const key = sidebarItemGroupScopeKey(request.scope);
      // Main puts the row where the request says, or last without one.
      const placement: SidebarItemGroupPendingPlacement = {
        itemId: request.itemId,
        ...(request.before !== undefined
          ? { before: request.before }
          : request.after !== undefined
            ? { after: request.after }
            : {}),
      };
      return mutate(
        request.scope,
        (groups) => {
          const moved = moveSidebarItemMembership<SidebarItemGroupView>(
            groups,
            request.itemId,
            request.groupId,
          );
          const target = moved.find((group) => group.id === request.groupId);
          if (target && request.groupId !== null) {
            recordPlacementRequest(key, {
              groupId: request.groupId,
              placement,
            });
            // The pending view replays the same sequence the overlay will.
            target.pendingPlacements = placementRequestsFor(
              key,
              request.groupId,
            );
          }
          return moved.filter(isSidebarItemGroupRetained);
        },
        () => window.api.sidebarItemGroups.moveItem(request),
      ).catch((error: unknown) => {
        // The rolled-back read prunes it if the row did not join; a failed
        // move inside the group must not leave a request main never applied.
        const requests = placementRequests.get(key);
        if (requests)
          placementRequests.set(
            key,
            requests.filter((entry) => entry.placement !== placement),
          );
        throw error;
      });
    },
    moveGroup: (request): Promise<void> =>
      mutate(
        request.scope,
        (groups) => groups,
        () => window.api.sidebarItemGroups.moveGroup(request),
      ),
  }),
);

/**
 * The snapshot's row order was built from the snapshot's own membership, and
 * main rebuilds it on its own schedule. Where hydrated membership is newer,
 * keep each group at the slot that order gives it until the snapshot catches
 * up; otherwise an incoming row above the group becomes its anchor and the
 * group jumps to that row first. Once it has caught up, its order is the
 * canonical one and nothing is retained.
 */
function retainSnapshotAnchors(
  key: string,
  groups: SidebarItemGroupView[],
  projected: readonly SidebarItemGroup[] | undefined,
): SidebarItemGroupView[] {
  if (projected === undefined) return groups;
  let changed = false;
  const retained = groups.map((group): SidebarItemGroupView => {
    const shown = projected.find((item) => item.id === group.id);
    if (shown === undefined) return group;
    const caughtUp =
      shown.memberIds.length === group.memberIds.length &&
      shown.memberIds.every((id) => group.memberIds.includes(id));
    if (
      caughtUp &&
      group.retainedMemberIds === undefined &&
      group.pendingPlacements === undefined
    )
      return group;
    changed = true;
    const current = { ...group };
    delete current.retainedMemberIds;
    delete current.pendingPlacements;
    if (caughtUp) return current;
    // Rows the order does not place yet go where they asked to.
    const requested = placementRequestsFor(key, group.id);
    return {
      ...current,
      retainedMemberIds: shown.memberIds,
      ...(requested.length ? { pendingPlacements: requested } : {}),
    };
  });
  return changed ? retained : groups;
}

export function overlaySidebarItemGroups(
  snapshot: SessionViewModel,
  byScope: Readonly<Record<string, SidebarItemGroupView[]>>,
  orders: Readonly<Record<string, readonly string[]>> = {},
): SessionViewModel {
  snapshot = projectSidebarPlacementOrders(snapshot, orders);
  let changed = false;
  const workspaces = (snapshot.workspaces ?? []).map((workspace) => {
    const key = `workspace:${workspace.localId}`;
    const hydrated = byScope[key];
    if (hydrated === undefined || hydrated === workspace.itemGroups)
      return workspace;
    changed = true;
    return {
      ...workspace,
      itemGroups: retainSnapshotAnchors(key, hydrated, workspace.itemGroups),
    };
  });
  const appAdvisorItemGroups =
    byScope['app-advisor'] ?? snapshot.appAdvisorItemGroups;
  if (appAdvisorItemGroups !== snapshot.appAdvisorItemGroups) changed = true;
  return changed
    ? {
        ...snapshot,
        workspaces,
        ...(appAdvisorItemGroups === undefined ? {} : { appAdvisorItemGroups }),
      }
    : snapshot;
}

type PlacementEntries = Awaited<
  ReturnType<typeof window.api.workEntries.list>
>['entries'];
const coworkPlacements = new Map<string, SidebarPlacementStore>();

function coworkPlacement(
  scope: SidebarItemGroupScope,
): SidebarPlacementStore | undefined {
  if (scope.appAdvisor) return undefined;
  const projectId = scope.workspaceLocalId;
  if (!isCoworkScope(scope)) return undefined;
  const key = sidebarItemGroupScopeKey(scope);
  const existing = coworkPlacements.get(key);
  if (existing) return existing;
  const entriesForScope = (): PlacementEntries => {
    const state = useStandaloneChatStore.getState();
    return state.activeChatProjectId === projectId
      ? state.workEntries
      : (state.sidebarEntriesByProject[projectId] ?? []);
  };
  const snapshot = (
    entries: PlacementEntries,
    groups: readonly SidebarItemGroup[],
  ): SidebarPlacementSnapshot => ({
    order: entries.map((entry) => entry.id),
    groups,
    movableItemIds: new Set(
      entries.filter((entry) => !entry.pinned).map((entry) => entry.id),
    ),
  });
  const acceptedEntries = new WeakMap<
    SidebarPlacementSnapshot,
    PlacementEntries
  >();
  const controller = createSidebarPlacementStore(
    snapshot(
      entriesForScope(),
      useSidebarItemGroupsStore.getState().byScope[key] ?? [],
    ),
    {
      save: (request) =>
        saveInScope(scope, () =>
          window.api.sidebarItemGroups.moveItem(request),
        ),
      read: async (): Promise<SidebarPlacementSnapshot> => {
        const revision = getWorkEntrySnapshotRevision(projectId);
        const [response, groups] = await Promise.all([
          window.api.workEntries.list({ projectId }),
          window.api.sidebarItemGroups.list(scope),
        ]);
        if (revision !== getWorkEntrySnapshotRevision(projectId))
          throw new Error('Sidebar entries changed during reconciliation');
        const next = snapshot(response.entries, groups);
        acceptedEntries.set(next, response.entries);
        return next;
      },
      // IPC rejection alone does not prove that an order-first write did not commit.
      classifyFailure: () => 'uncertain',
    },
  );
  // A hydration read begun before this controller must not overwrite its intents.
  nextGeneration(key);
  coworkPlacements.set(key, controller);
  let applied: SidebarPlacementSnapshot | undefined;
  controller.subscribe((state) => {
    const entries = acceptedEntries.get(state.confirmed);
    const authoritative = entries !== undefined && applied !== state.confirmed;
    if (entries && authoritative) {
      applied = state.confirmed;
      useStandaloneChatStore
        .getState()
        .applyWorkEntriesSnapshot(projectId, entries);
    }
    useSidebarItemGroupsStore.setState((current) => ({
      byScope: {
        ...current.byScope,
        [key]: [...state.rendered.groups],
      },
      orderByScope: { ...current.orderByScope, [key]: state.rendered.order },
      errors: {
        ...current.errors,
        [key]: state.error instanceof Error ? state.error.message : undefined,
      },
    }));
  });
  return controller;
}

useWorkspaceContextStore.subscribe((state, previous) => {
  if (
    state.accountEpoch === previous.accountEpoch &&
    JSON.stringify(state.state.context) ===
      JSON.stringify(previous.state.context)
  )
    return;
  writeContext += 1;
  generations.forEach((_generation, key) => {
    nextGeneration(key);
  });
  for (const controller of Array.from(coworkPlacements.values()))
    controller.dispose();
  coworkPlacements.clear();
  useSidebarItemGroupsStore.setState({
    orderByScope: {},
    byScope: {},
    errors: {},
  });
});

/** Unsolicited entry inventory can delete or add rows, but cannot acknowledge a move. */
export function observeCoworkSidebarEntries(
  projectId: string,
  entries: PlacementEntries,
): void {
  const controller = coworkPlacements.get(
    sidebarItemGroupScopeKey({ workspaceLocalId: projectId }),
  );
  if (!controller) return;
  controller.updateInventory({
    order: entries.map((entry) => entry.id),
    groups: controller.getState().confirmed.groups,
    movableItemIds: new Set(
      entries.filter((entry) => !entry.pinned).map((entry) => entry.id),
    ),
  });
}
