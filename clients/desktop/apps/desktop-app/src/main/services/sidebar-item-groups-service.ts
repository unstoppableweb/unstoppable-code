import { reorderWorktreeGroupMembership } from '../lib/worktree-update';
import { serializeWorkspaceMutation } from '../lib/chat-project-operation-queue';
import { readPreferencesFile } from '../lib/preferences-store';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { randomUUID } from 'node:crypto';
import {
  orderedSidebarItemGroups,
  sidebarItemGroupIds,
} from '@canopy/desktop-shared/lib/sidebar-item-group-actions';
import { z } from 'zod';
import {
  SIDEBAR_ITEM_GROUP_COLORS,
  anchorKeptSidebarItemGroups,
  SIDEBAR_ITEM_GROUP_LIMIT,
  findSidebarItemGroupByName,
  normalizeSidebarItemGroupName,
  normalizeSidebarItemGroups,
  normalizeGroupedOrder,
  nextSidebarItemGroupColor,
  pickSidebarItemGroupColor,
  parseSidebarItemGroupsFile,
  resolveSidebarItemGroupLabel,
  resolveSidebarItemGroupCollapsed,
  type SidebarItemGroup,
  type SidebarItemGroupScope,
  type SidebarItemGroupInventory,
} from '@canopy/protocol/sidebar';
import type {
  CoworkWorkEntryData,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import {
  readSidebarItemGroups,
  readSidebarItemGroupsEnvelope,
  writeSidebarItemGroups,
  sidebarGroupInventory,
  sidebarGroupStackUnits,
  SidebarItemGroupsVersionError,
  reconcileSidebarItemGroups,
  restoreSidebarItemGroupsEnvelope,
  type SidebarGroupRegistryReconciliation,
  type SidebarGroupRegistryItem,
} from '../lib/sidebar-item-groups';
import {
  readWorkspaceConfigDetailed,
  setWorktreeRegistryReconciler,
  type WorktreeRegistryWriteOptions,
} from '../lib/workspace-persistence';
import {
  readWorkEntriesFileStrict,
  updateWorkEntryRegistry,
  setWorkEntryRegistryReconciler,
  type WorkEntryRegistryWriteOptions,
} from '../lib/cowork-work-entries';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { validateId } from '../lib/validation';
import { assertWritableScope } from '../lib/read-only-scope';
import { getW5IdentityStore } from '../lib/w5-commit-log-file-store';
import { W5CommitRefusedError } from '@canopy/core-runtime/node/w5/commit-log/errors';

const id = z.string().transform((value) => {
  validateId(value, 'sidebar id');
  return value;
});
const groupId = id.transform((value) => {
  if (!value.startsWith('grp-')) throw new Error('Invalid group id prefix');
  validateId(value.slice(4), 'group id');
  return value;
});
const scopeSchema = z.union([
  z.object({ workspaceLocalId: id }).strict(),
  z.object({ appAdvisor: z.literal(true) }).strict(),
]);
const groupTarget = z.object({ scope: scopeSchema, groupId }).strict();
const createSchema = z
  .object({
    scope: scopeSchema,
    itemId: id,
    name: z.string().optional(),
    color: z.enum(SIDEBAR_ITEM_GROUP_COLORS).optional(),
    labelHidden: z.boolean().optional(),
  })
  .strict();
const assignNamedGroupSchema = z
  .object({
    scope: scopeSchema,
    itemId: id,
    name: z.string(),
    color: z.enum(SIDEBAR_ITEM_GROUP_COLORS).optional(),
  })
  .strict();

export type SidebarItemGroupRefusalCode =
  | 'group_limit_reached'
  | 'item_not_groupable'
  | 'group_not_found';

/** Thrown for refusals a caller may treat as best-effort; the message is unchanged from before it was typed. */
export class SidebarItemGroupRefusalError extends Error {
  constructor(
    readonly code: SidebarItemGroupRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'SidebarItemGroupRefusalError';
  }
}

function groupLimitReached(): SidebarItemGroupRefusalError {
  return new SidebarItemGroupRefusalError(
    'group_limit_reached',
    'Sidebar item group limit reached',
  );
}

function itemNotGroupable(): SidebarItemGroupRefusalError {
  return new SidebarItemGroupRefusalError(
    'item_not_groupable',
    'Sidebar item cannot be grouped',
  );
}
const updateSchema = groupTarget.extend({
  name: z.string().optional(),
  color: z.enum(SIDEBAR_ITEM_GROUP_COLORS).optional(),
  collapsed: z.boolean().optional(),
  labelHidden: z.boolean().optional(),
  keepWhenEmpty: z.boolean().optional(),
});
const anchors = { before: id.optional(), after: id.optional() };
const moveItemSchema = z
  .object({
    scope: scopeSchema,
    itemId: id,
    groupId: groupId.nullable(),
    ...anchors,
  })
  .strict()
  .refine((value) => !(value.before && value.after), 'Conflicting anchors');
const moveGroupSchema = groupTarget
  .extend(anchors)
  .refine((value) => !(value.before && value.after), 'Conflicting anchors');

interface RegistryState {
  items: readonly (WorktreeData | CoworkWorkEntryData)[];
  inventory: SidebarItemGroupInventory;
  units: string[][];
  groups: SidebarItemGroup[];
  order: string[];
  sortMode: 'manual' | 'last-updated';
  /** Branch-stack units with one more item unstacked from its base. */
  unstack?: (itemId: string) => string[][];
}

function orderedRows<T extends { id: string }>(
  rows: T[],
  order: readonly string[],
): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return order.map((itemId) => {
    const row = byId.get(itemId);
    if (!row) throw new Error('Sidebar order contains an unknown item');
    return row;
  });
}

async function resolveScope(scope: SidebarItemGroupScope): Promise<{
  workspaceId: string;
  workEntries: boolean;
  sortMode: 'manual' | 'last-updated';
}> {
  if (scope.appAdvisor === true)
    return {
      workspaceId: 'app-advisor',
      workEntries: true,
      sortMode: 'manual',
    };
  validateId(scope.workspaceLocalId, 'workspace id');
  assertWritableScope(scope.workspaceLocalId);
  const workspaceId = resolveCoworkWorkspaceId(scope.workspaceLocalId);
  assertWritableScope(workspaceId);
  const detailed = await readWorkspaceConfigDetailed(workspaceId);
  if (detailed.authority !== 'ok')
    throw new Error('Sidebar group project is unavailable');
  return {
    workspaceId,
    workEntries: detailed.config.type === 'cowork',
    sortMode:
      detailed.config.itemSortMode === 'last-updated'
        ? 'last-updated'
        : 'manual',
  };
}

async function transaction<T>(
  scope: SidebarItemGroupScope,
  mutate: boolean,
  operation: (state: RegistryState) => T | Promise<T>,
): Promise<T> {
  return serializeWorkspaceMutation(() =>
    registryTransaction(scope, mutate, operation),
  );
}

async function requireAppliedWorktreeInventory(
  workspaceId: string,
): Promise<void> {
  const store = getW5IdentityStore();
  // Only explicitly injected legacy test stores have no commit log.
  if (!store) return;
  if (!store.capture) throw new Error('W5 inventory capture is unavailable');
  const { capture } = await store.capture({
    files: [{ kind: 'worktrees', workspaceId }],
    discoverWorkspaces: false,
  });
  const unresolved = capture.log.files.find(
    ({ file, state }) =>
      file.kind === 'worktrees' &&
      file.workspaceId === workspaceId &&
      state !== 'applied',
  );
  // Installed rows cannot disprove membership held by a saved decision.
  if (unresolved)
    throw new W5CommitRefusedError(
      'unapplied-change',
      'An earlier change to the worktree list has not finished saving.',
      { commitId: unresolved.commitId },
    );
}

async function registryTransaction<T>(
  scope: SidebarItemGroupScope,
  mutate: boolean,
  operation: (state: RegistryState) => T | Promise<T>,
): Promise<T> {
  const resolved = await resolveScope(scope);
  let result: { value: T } | undefined;
  let pending:
    | { groups: SidebarItemGroup[]; inventory: SidebarItemGroupInventory }
    | undefined;
  const apply = async (
    items: readonly (WorktreeData | CoworkWorkEntryData)[],
    units: string[][],
    unstack?: RegistryState['unstack'],
  ): Promise<string[]> => {
    const inventory = sidebarGroupInventory(
      items,
      units.flatMap((unit) => unit.slice(1)),
    );
    if (!mutate)
      await reconcileSidebarItemGroups(resolved.workspaceId, inventory);
    const groups = await readSidebarItemGroups(resolved.workspaceId, inventory);
    const state: RegistryState = {
      items,
      inventory,
      units,
      groups,
      order: items.map((item) => item.id),
      sortMode: resolved.sortMode,
      ...(unstack ? { unstack } : {}),
    };
    // A newly empty header keeps its position among existing empty headers.
    state.groups = navOrderedGroups(state);
    const previousCounts = new Map(
      state.groups.map((group) => [group.id, group.memberIds.length]),
    );
    result = { value: await operation(state) };
    for (const group of state.groups) {
      const previousCount = previousCounts.get(group.id);
      if (previousCount !== undefined)
        group.collapsed = resolveSidebarItemGroupCollapsed(
          group,
          previousCount,
        );
    }
    // The operation may have unstacked its item, changing units and inventory.
    const written = normalizeSidebarItemGroups(state.groups, state.inventory);
    const order =
      mutate && state.sortMode === 'manual'
        ? normalizeGroupedOrder(state.order, written, {
            stackUnits: state.units,
          })
        : state.order;
    pending = {
      groups: anchorKeptSidebarItemGroups(written, order, {
        stackUnits: state.units,
        ineligibleItemIds: state.inventory.ineligibleItemIds,
      }),
      inventory: state.inventory,
    };
    return order;
  };
  const afterWrite = async (): Promise<void> => {
    if (mutate && pending)
      await writeSidebarItemGroups(
        resolved.workspaceId,
        pending.groups,
        pending.inventory,
      );
  };
  if (resolved.workEntries) {
    await updateWorkEntryRegistry(
      resolved.workspaceId,
      async (entries) => {
        const order = await apply(
          entries,
          entries.map((entry) => [entry.id]),
        );
        return mutate ? orderedRows(entries, order) : entries;
      },
      { afterWrite, groupMutation: mutate, requireAuthoritativeRead: true },
    );
  } else {
    await reorderWorktreeGroupMembership({
      source: 'sidebar_item_groups',
      workspaceId: resolved.workspaceId,
      decide: async (worktrees) => {
        await requireAppliedWorktreeInventory(resolved.workspaceId);
        const preferences = await readPreferencesFile();
        const ungroupItemIds = new Set<string>();
        const stackUnits = (): string[][] =>
          sidebarGroupStackUnits(
            worktrees.map((item) =>
              ungroupItemIds.has(item.id)
                ? { ...item, branchGroupingOverride: 'ungroup' as const }
                : item,
            ),
            preferences.groupChildBranchesWithBase,
          );
        const order = await apply(worktrees, stackUnits(), (itemId) => {
          ungroupItemIds.add(itemId);
          return stackUnits();
        });
        return {
          order,
          commitMembership: afterWrite,
          ungroupItemIds: Array.from(ungroupItemIds),
        };
      },
    });
  }
  if (!result) throw new Error('Sidebar group mutation did not complete');
  return result.value;
}

function requireGroup(
  state: RegistryState,
  targetId: string,
): SidebarItemGroup {
  const group = state.groups.find((candidate) => candidate.id === targetId);
  if (!group)
    throw new SidebarItemGroupRefusalError(
      'group_not_found',
      'Sidebar item group no longer exists',
    );
  return group;
}

/**
 * A branch-stack child joining a group is first unstacked from its base, as
 * "Unstack from base" does, and carries its own descendants with it.
 */
function requireItem(
  state: RegistryState,
  itemId: string,
  joinsGroup = false,
): string[] {
  if (
    joinsGroup &&
    state.unstack &&
    state.units.some((unit) => unit.indexOf(itemId) > 0)
  ) {
    state.units = state.unstack(itemId);
    state.inventory = sidebarGroupInventory(
      state.items,
      state.units.flatMap((unit) => unit.slice(1)),
    );
  }
  if (
    !state.inventory.liveItemIds.includes(itemId) ||
    state.inventory.ineligibleItemIds?.includes(itemId)
  )
    throw itemNotGroupable();
  return state.units.find((unit) => unit[0] === itemId) ?? [itemId];
}

/** Resolve a retained slot to the beginning of the block the UI displays. */
function emptySlotIndex(
  order: readonly string[],
  groups: readonly SidebarItemGroup[],
  units: readonly string[][],
  anchor?: string,
): number {
  if (anchor === undefined) return order.length;
  const root = units.find((unit) => unit.includes(anchor))?.[0] ?? anchor;
  const owner = groups.find((group) => group.memberIds.includes(root));
  const roots = new Set(owner?.memberIds ?? [root]);
  const block = new Set(
    units.filter((unit) => roots.has(unit[0] ?? '')).flat(),
  );
  const index = order.findIndex((id) => block.has(id) || roots.has(id));
  return index < 0 ? order.length : index;
}

/** Empty headers participate in a move without becoming registry rows. */
function orderWithEmptySlots(state: RegistryState): string[] {
  const slots = new Map<number, string[]>();
  for (const group of state.groups) {
    if (group.memberIds.length || !group.keepWhenEmpty) continue;
    const index = emptySlotIndex(
      state.order,
      state.groups,
      state.units,
      group.emptyAnchorId,
    );
    slots.set(index, [...(slots.get(index) ?? []), group.id]);
  }
  if (slots.size === 0) return state.order;
  return state.order
    .flatMap((id, index) => [...(slots.get(index) ?? []), id])
    .concat(slots.get(state.order.length) ?? []);
}

function applySlotOrder(state: RegistryState, order: string[]): void {
  const empty = state.groups.filter(
    (group) => group.keepWhenEmpty && group.memberIds.length === 0,
  );
  if (empty.length === 0) {
    state.order = order;
    return;
  }
  const live = new Set(state.inventory.liveItemIds);
  const ineligible = new Set(state.inventory.ineligibleItemIds);
  for (const group of empty) {
    const index = order.indexOf(group.id);
    if (index < 0) continue;
    const anchor = order
      .slice(index + 1)
      .find((id) => live.has(id) && !ineligible.has(id));
    delete group.emptyAnchorId;
    if (anchor !== undefined) group.emptyAnchorId = anchor;
  }
  empty.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  let emptyIndex = 0;
  state.groups = state.groups.map((group) =>
    group.keepWhenEmpty && group.memberIds.length === 0
      ? (empty[emptyIndex++] ?? group)
      : group,
  );
  state.order = order.filter((id) => live.has(id));
}

function moveBlock(
  state: RegistryState,
  moving: string[],
  before?: string,
  after?: string,
): void {
  if (!before && !after) return;
  const anchor = before ?? after;
  const group = state.groups.find((candidate) => candidate.id === anchor);
  const anchorIds = group
    ? state.units
        .filter((unit) => group.memberIds.includes(unit[0] ?? ''))
        .flat()
    : state.units.find((unit) => unit[0] === anchor);
  const targetIds = group && anchorIds?.length === 0 ? [group.id] : anchorIds;
  if (!targetIds?.length || targetIds.some((item) => moving.includes(item)))
    throw new Error('Invalid sidebar group move anchor');
  if (state.sortMode !== 'manual') return;
  const rest = orderWithEmptySlots(state).filter(
    (item) => !moving.includes(item),
  );
  const positions = targetIds.map((item) => rest.indexOf(item));
  const slot = before ? Math.min(...positions) : Math.max(...positions) + 1;
  rest.splice(slot, 0, ...moving);
  applySlotOrder(state, rest);
}

/** An empty group has no rows to move: its anchor is its slot. */
function moveEmptyGroup(
  state: RegistryState,
  group: SidebarItemGroup,
  before?: string,
  after?: string,
): void {
  moveBlock(state, [group.id], before, after);
}

/** The same group objects, sorted into left-nav order. */
function navOrderedGroups(
  state: Pick<RegistryState, 'groups' | 'order'>,
): SidebarItemGroup[] {
  const navOrder = orderedSidebarItemGroups(state.groups, state.order).map(
    (group) => group.id,
  );
  return [...state.groups].sort(
    (left, right) => navOrder.indexOf(left.id) - navOrder.indexOf(right.id),
  );
}

export const sidebarItemGroupsService = {
  describe: async (
    scope: SidebarItemGroupScope,
  ): Promise<Array<SidebarItemGroup & { order: number }>> =>
    transaction(scopeSchema.parse(scope), false, (state) =>
      orderedSidebarItemGroups(state.groups, state.order),
    ),
  listItems: async (
    input: unknown,
  ): Promise<{
    group: SidebarItemGroup;
    items: Array<{
      id: string;
      name: string;
      kind: 'worktree' | 'work-entry';
      groupId: string;
      createdAt: string;
    }>;
  }> => {
    const request = groupTarget.parse(input);
    return transaction(request.scope, false, (state) => {
      const group = requireGroup(state, request.groupId);
      const memberships = sidebarItemGroupIds(state.groups, state.units);
      return {
        group,
        items: state.items
          .filter((item) => memberships.get(item.id) === group.id)
          .map((item) => ({
            id: item.id,
            name:
              'branchName' in item
                ? item.branchName
                : (item.title ?? item.summary?.title ?? ''),
            kind: 'branchName' in item ? 'worktree' : 'work-entry',
            groupId: group.id,
            createdAt: item.createdAt,
          })),
      };
    });
  },
  /** Left-nav order, so pickers list groups where the sidebar shows them. */
  list: async (scope: SidebarItemGroupScope): Promise<SidebarItemGroup[]> =>
    transaction(scopeSchema.parse(scope), false, navOrderedGroups),
  create: async (input: unknown): Promise<SidebarItemGroup> => {
    const request = createSchema.parse(input);
    return transaction(request.scope, true, (state) => {
      requireItem(state, request.itemId, true);
      state.groups = normalizeSidebarItemGroups(
        state.groups.map((group) => ({
          ...group,
          memberIds: group.memberIds.filter((item) => item !== request.itemId),
        })),
        state.inventory,
      );
      if (state.groups.length >= SIDEBAR_ITEM_GROUP_LIMIT)
        throw groupLimitReached();
      const color = request.color ?? nextSidebarItemGroupColor(state.groups);
      const label = resolveSidebarItemGroupLabel({
        name: request.name,
        labelHidden: request.labelHidden,
        others: state.groups,
      });
      const group: SidebarItemGroup = {
        id: `grp-${randomUUID()}`,
        name: label.name,
        color,
        collapsed: false,
        ...(label.labelHidden ? { labelHidden: true } : {}),
        memberIds: [request.itemId],
      };
      state.groups.push(group);
      const normalized = normalizeSidebarItemGroups(
        [group],
        state.inventory,
      )[0];
      if (!normalized) throw itemNotGroupable();
      return normalized;
    });
  },
  update: async (input: unknown): Promise<void> => {
    const request = updateSchema.parse(input);
    await transaction(request.scope, true, (state) => {
      const group = requireGroup(state, request.groupId);
      if (
        request.name !== undefined ||
        request.color !== undefined ||
        request.labelHidden !== undefined
      ) {
        const color = request.color ?? group.color;
        const label = resolveSidebarItemGroupLabel({
          name: request.name,
          labelHidden: request.labelHidden,
          previous: group,
          others: state.groups.filter((candidate) => candidate.id !== group.id),
        });
        group.name = label.name;
        group.color = color;
        if (label.labelHidden) group.labelHidden = true;
        else delete group.labelHidden;
      }
      if (request.collapsed !== undefined) group.collapsed = request.collapsed;
      if (request.keepWhenEmpty === true) group.keepWhenEmpty = true;
      else if (request.keepWhenEmpty === false) delete group.keepWhenEmpty;
    });
  },
  assignItemToNamedGroup: async (
    input: unknown,
  ): Promise<{ group: SidebarItemGroup; created: boolean }> => {
    const request = assignNamedGroupSchema.parse(input);
    const name = normalizeSidebarItemGroupName(request.name);
    if (!name) throw new Error('Sidebar item group name is required');
    return transaction(request.scope, true, (state) => {
      const moving = requireItem(state, request.itemId, true);
      // Duplicate names resolve to the group the nav and pickers show first.
      let target = findSidebarItemGroupByName(navOrderedGroups(state), name);
      const created = !target;
      if (target) {
        const appendToTarget =
          state.sortMode === 'manual' &&
          !target.memberIds.includes(request.itemId);
        moveBlock(
          state,
          moving,
          undefined,
          appendToTarget ? target.id : undefined,
        );
        state.groups = state.groups.map((group) => ({
          ...group,
          memberIds: group.memberIds.filter((item) => item !== request.itemId),
        }));
        state.groups
          .find((group) => group.id === target?.id)
          ?.memberIds.push(request.itemId);
      } else {
        state.groups = normalizeSidebarItemGroups(
          state.groups.map((group) => ({
            ...group,
            memberIds: group.memberIds.filter(
              (item) => item !== request.itemId,
            ),
          })),
          state.inventory,
        );
        if (state.groups.length >= SIDEBAR_ITEM_GROUP_LIMIT)
          throw groupLimitReached();
        // Color applies only to a group created here; an existing group keeps its own.
        const color = request.color ?? pickSidebarItemGroupColor(state.groups);
        const label = resolveSidebarItemGroupLabel({
          name,
          others: state.groups,
        });
        target = {
          id: `grp-${randomUUID()}`,
          name: label.name,
          color,
          collapsed: false,
          ...(label.labelHidden ? { labelHidden: true } : {}),
          memberIds: [],
        };
        state.groups.push(target);
        state.groups
          .find((group) => group.id === target?.id)
          ?.memberIds.push(request.itemId);
      }
      state.groups = normalizeSidebarItemGroups(state.groups, state.inventory);
      if (state.sortMode === 'manual')
        state.order = normalizeGroupedOrder(state.order, state.groups, {
          stackUnits: state.units,
        });
      const assigned = state.groups.find((group) => group.id === target?.id);
      if (!assigned)
        throw new Error('Sidebar group assignment did not complete');
      return { group: assigned, created };
    });
  },
  ungroup: async (input: unknown): Promise<void> => {
    const request = groupTarget.parse(input);
    await transaction(request.scope, true, (state) => {
      requireGroup(state, request.groupId);
      state.groups = state.groups.filter(
        (group) => group.id !== request.groupId,
      );
    });
  },
  moveItem: async (input: unknown): Promise<void> => {
    const request = moveItemSchema.parse(input);
    await transaction(request.scope, true, (state) => {
      const moving = requireItem(
        state,
        request.itemId,
        request.groupId !== null,
      );
      const target =
        request.groupId === null
          ? undefined
          : requireGroup(state, request.groupId);
      // Membership-only menu moves join the existing block instead of making
      // an earlier incoming row the destination's new manual-order anchor.
      const appendToTarget =
        state.sortMode === 'manual' &&
        request.before === undefined &&
        request.after === undefined &&
        target !== undefined &&
        !target.memberIds.includes(request.itemId);
      // Validate anchors against the old blocks, before removing membership.
      moveBlock(
        state,
        moving,
        request.before,
        appendToTarget ? target.id : request.after,
      );
      state.groups = state.groups.map((group) => ({
        ...group,
        memberIds: group.memberIds.filter((item) => item !== request.itemId),
      }));
      if (target)
        state.groups
          .find((group) => group.id === target.id)
          ?.memberIds.push(request.itemId);
      state.groups = normalizeSidebarItemGroups(state.groups, state.inventory);
      if (state.sortMode === 'manual')
        state.order = normalizeGroupedOrder(state.order, state.groups, {
          stackUnits: state.units,
        });
    });
  },
  moveGroup: async (input: unknown): Promise<void> => {
    const request = moveGroupSchema.parse(input);
    await transaction(request.scope, true, (state) => {
      const group = requireGroup(state, request.groupId);
      const moving = state.units
        .filter((unit) => group.memberIds.includes(unit[0] ?? ''))
        .flat();
      if (moving.length === 0) {
        moveEmptyGroup(state, group, request.before, request.after);
        return;
      }
      moveBlock(state, moving, request.before, request.after);
      if (state.sortMode === 'manual')
        state.order = normalizeGroupedOrder(state.order, state.groups, {
          stackUnits: state.units,
        });
    });
  },
};

/** IDs left in relative order by a plain registry reorder (longest increasing subsequence). */
function stableRegistryIds(
  previous: readonly string[],
  next: readonly string[],
): Set<string> {
  const positions = new Map(previous.map((id, index) => [id, index]));
  const tails: number[] = [];
  const links = new Map<number, number>();
  for (let index = 0; index < next.length; index++) {
    const position = positions.get(next[index] ?? '');
    if (position === undefined) continue;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const tail = tails[mid];
      if (
        tail !== undefined &&
        (positions.get(next[tail] ?? '') ?? -1) < position
      )
        low = mid + 1;
      else high = mid;
    }
    links.set(index, tails[low - 1] ?? -1);
    tails[low] = index;
  }
  const stable = new Set<string>();
  for (
    let index = tails[tails.length - 1] ?? -1;
    index >= 0;
    index = links.get(index) ?? -1
  ) {
    const id = next[index];
    if (id !== undefined) stable.add(id);
  }
  return stable;
}

function retainSlotsThroughRegistryReorder(
  groups: SidebarItemGroup[],
  previous: readonly string[],
  next: readonly string[],
  inventory: SidebarItemGroupInventory,
  previousUnits: readonly string[][],
): void {
  if (
    !groups.some(
      (group) =>
        group.keepWhenEmpty &&
        group.memberIds.length === 0 &&
        group.emptyAnchorId !== undefined,
    )
  )
    return;
  const live = new Set(next);
  const comparable = previous.filter((id) => live.has(id));
  const old = new Set(previous);
  if (
    JSON.stringify(comparable) ===
    JSON.stringify(next.filter((id) => old.has(id)))
  )
    return;
  const stable = stableRegistryIds(previous, next);
  const ineligible = new Set(inventory.ineligibleItemIds);
  for (const group of groups) {
    if (
      !group.keepWhenEmpty ||
      group.memberIds.length ||
      group.emptyAnchorId === undefined
    )
      continue;
    const slot = emptySlotIndex(
      previous,
      groups,
      previousUnits,
      group.emptyAnchorId,
    );
    const preceding = previous
      .slice(0, slot)
      .reverse()
      .find((id) => stable.has(id) && !ineligible.has(id));
    const start = preceding === undefined ? 0 : next.indexOf(preceding) + 1;
    const anchor = next.slice(start).find((id) => !ineligible.has(id));
    delete group.emptyAnchorId;
    if (anchor !== undefined) group.emptyAnchorId = anchor;
  }
}

async function reconcileRegistry<T extends SidebarGroupRegistryItem>(
  workspaceId: string,
  rows: T[],
  units: string[][],
  options?: WorkEntryRegistryWriteOptions,
  previousUnits?: string[][],
  retainedItemIds: readonly string[] = [],
  requireAppliedInventory?: () => Promise<void>,
): Promise<SidebarGroupRegistryReconciliation<T>> {
  if (options?.groupMutation) return { rows };
  if (options?.sidebarItemGroupId) groupId.parse(options.sidebarItemGroupId);
  if (options?.sidebarItemGroupId && !options.newItemId)
    throw new Error('Created item ID is required for a sidebar group');
  const rowInventory = sidebarGroupInventory(
    rows,
    units.flatMap((unit) => unit.slice(1)),
  );
  // Rows the registry keeps but could not read stay live, so a write never
  // prunes their membership or deletes the group they leave empty.
  const inventory = {
    ...rowInventory,
    liveItemIds: [...rowInventory.liveItemIds, ...retainedItemIds],
  };
  const envelope = await readSidebarItemGroupsEnvelope(workspaceId);
  // Work Entry reconciliation runs before its canonical registry is replaced.
  if (previousUnits === undefined)
    previousUnits =
      envelope === undefined
        ? []
        : (await readWorkEntriesFileStrict(workspaceId)).entries.map(
            (entry) => [entry.id],
          );
  const previousOrder = previousUnits.flat();
  const parsed = parseSidebarItemGroupsFile(envelope, {
    liveItemIds: [...inventory.liveItemIds, ...previousOrder],
  });
  if (parsed.status === 'unsupported-version') {
    if (options?.sidebarItemGroupId)
      throw new SidebarItemGroupsVersionError(parsed.version);
    return { rows };
  }
  let groups = navOrderedGroups({
    groups: parsed.status === 'ok' ? parsed.value.groups : [],
    order: previousOrder,
  });
  const previousCounts = new Map(
    groups.map((group) => [group.id, group.memberIds.length]),
  );
  const live = new Set(inventory.liveItemIds);
  const ineligible = new Set(inventory.ineligibleItemIds);
  for (const group of groups) {
    if (group.emptyAnchorId === undefined || live.has(group.emptyAnchorId))
      continue;
    const previousIndex = previousOrder.indexOf(group.emptyAnchorId);
    delete group.emptyAnchorId;
    if (previousIndex < 0) continue;
    const anchor = previousOrder
      .slice(previousIndex + 1)
      .find((id) => live.has(id) && !ineligible.has(id));
    if (anchor !== undefined) group.emptyAnchorId = anchor;
  }
  for (const group of groups) {
    for (const previous of previousUnits) {
      if (!group.memberIds.includes(previous[0] ?? '')) continue;
      for (const item of previous.slice(1)) {
        if (
          units.some((unit) => unit[0] === item) &&
          !group.memberIds.includes(item)
        )
          group.memberIds.push(item);
      }
    }
  }
  retainSlotsThroughRegistryReorder(
    groups,
    previousOrder,
    rows.map((row) => row.id),
    inventory,
    previousUnits,
  );
  const creationItemId = options?.newItemId;
  const creationMembershipChanged =
    Boolean(options?.sidebarItemGroupId) ||
    (creationItemId !== undefined &&
      groups.some((group) => group.memberIds.includes(creationItemId)));
  if (options?.newItemId) {
    const group = groups.find(
      (candidate) => candidate.id === options.sidebarItemGroupId,
    );
    if (
      options.sidebarItemGroupId &&
      (!group || inventory.ineligibleItemIds?.includes(options.newItemId))
    )
      throw new Error('Creation sidebar item group is unavailable');
    // Root creation also reuses empty entries. Clear their old membership;
    // only an explicit group destination attaches the acknowledged row.
    for (const existing of groups)
      existing.memberIds = existing.memberIds.filter(
        (id) => id !== options.newItemId,
      );
    if (group) {
      if (group.memberIds.length === 0) {
        // Earlier empty headers sharing this displayed slot stay above the new member.
        const rowOrder = rows.map((row) => row.id);
        const slot = emptySlotIndex(
          rowOrder,
          groups,
          units,
          group.emptyAnchorId,
        );
        for (const preceding of groups) {
          if (preceding === group) break;
          if (
            preceding.keepWhenEmpty &&
            preceding.memberIds.length === 0 &&
            emptySlotIndex(rowOrder, groups, units, preceding.emptyAnchorId) ===
              slot
          )
            preceding.emptyAnchorId = options.newItemId;
        }
      }
      group.memberIds.push(options.newItemId);
      let first = rows.findIndex(
        (row) =>
          group.memberIds.includes(row.id) && row.id !== options.newItemId,
      );
      if (first < 0)
        first = emptySlotIndex(
          rows.map((row) => row.id),
          groups,
          units,
          group.emptyAnchorId,
        );
      if (first < 0) first = rows.length;
      const created = rows.find((row) => row.id === options.newItemId);
      if (!created) throw new Error('Created sidebar item is unavailable');
      const createdIndex = rows.indexOf(created);
      rows = rows.filter((row) => row.id !== created.id);
      rows.splice(
        Math.max(0, first - (createdIndex < first ? 1 : 0)),
        0,
        created,
      );
    }
  }
  groups = normalizeSidebarItemGroups(groups, inventory);
  for (const group of groups) {
    const previousCount = previousCounts.get(group.id);
    if (previousCount !== undefined)
      group.collapsed = resolveSidebarItemGroupCollapsed(group, previousCount);
  }
  const config = isBotProjectId(workspaceId)
    ? undefined
    : await readWorkspaceConfigDetailed(workspaceId);
  const manual = !(
    config?.authority === 'ok' && config.config.itemSortMode === 'last-updated'
  );
  const order = manual
    ? normalizeGroupedOrder(
        rows.map((row) => row.id),
        groups,
        { stackUnits: units },
      )
    : rows.map((row) => row.id);
  groups = anchorKeptSidebarItemGroups(groups, order, {
    stackUnits: units,
    ineligibleItemIds: inventory.ineligibleItemIds,
  });
  const changed =
    JSON.stringify(envelope) !== JSON.stringify({ version: 1, groups }) &&
    (envelope !== undefined || groups.length > 0);
  // Metadata-only registry writes need no sidecar completeness evidence.
  if (changed) await requireAppliedInventory?.();
  const persist = changed
    ? (): Promise<void> =>
        writeSidebarItemGroups(workspaceId, groups, inventory)
    : undefined;
  // Creation membership must precede first visibility. Lifecycle pruning can
  // wait until its registry succeeds, so a failed pin/archive loses nothing.
  const reconciliation: SidebarGroupRegistryReconciliation<T> =
    creationMembershipChanged
      ? {
          rows,
          beforeWrite: persist,
          rollback: changed
            ? (): Promise<void> =>
                restoreSidebarItemGroupsEnvelope(workspaceId, envelope)
            : undefined,
        }
      : { rows, afterWrite: persist };
  if (!manual) return reconciliation;
  return {
    ...reconciliation,
    rows: groups.length ? orderedRows(rows, order) : rows,
  };
}

/** Install before host writers run; observers never own registry persistence. */
export function initializeSidebarItemGroups(): void {
  setWorktreeRegistryReconciler(
    async (
      workspaceId,
      current,
      next,
      options?: WorktreeRegistryWriteOptions,
      retainedItemIds?: readonly string[],
    ): Promise<SidebarGroupRegistryReconciliation<WorktreeData>> => {
      const preferences = await readPreferencesFile();
      return reconcileRegistry(
        workspaceId,
        next,
        sidebarGroupStackUnits(next, preferences.groupChildBranchesWithBase),
        options,
        sidebarGroupStackUnits(current, preferences.groupChildBranchesWithBase),
        retainedItemIds,
        () => requireAppliedWorktreeInventory(workspaceId),
      );
    },
  );
  setWorkEntryRegistryReconciler(
    (
      workspaceId,
      entries,
      options,
    ): Promise<SidebarGroupRegistryReconciliation<CoworkWorkEntryData>> =>
      reconcileRegistry(
        workspaceId,
        entries,
        entries.map((entry) => [entry.id]),
        options,
      ),
  );
}

/** Worktree rows a snapshot already read; without them the Work Entry registry is read. */
export interface SidebarItemGroupProjectionRows {
  worktrees: readonly WorktreeData[];
  groupChildBranchesWithBase: boolean;
}

/**
 * Snapshot projection: no workspace mutation queue, registry lock or repair
 * write. Registry writers and the list IPC keep reconciling the sidecar. An
 * unsupported or unreadable sidecar must never hide its workspace.
 */
export async function projectSidebarItemGroups(
  scope: SidebarItemGroupScope,
  rows?: SidebarItemGroupProjectionRows,
): Promise<SidebarItemGroup[] | undefined> {
  try {
    const parsed: SidebarItemGroupScope = scopeSchema.parse(scope);
    let workspaceId = 'app-advisor';
    if (parsed.appAdvisor !== true) {
      assertWritableScope(parsed.workspaceLocalId);
      workspaceId = resolveCoworkWorkspaceId(parsed.workspaceLocalId);
      assertWritableScope(workspaceId);
    }
    const inventory = rows
      ? sidebarGroupInventory(
          rows.worktrees,
          sidebarGroupStackUnits(
            rows.worktrees,
            rows.groupChildBranchesWithBase,
          ).flatMap((unit) => unit.slice(1)),
        )
      : sidebarGroupInventory(
          (await readWorkEntriesFileStrict(workspaceId)).entries,
        );
    return await readSidebarItemGroups(workspaceId, inventory, {
      readOnly: true,
    });
  } catch {
    logMainProcessWarn('sidebar_item_groups_projection_unavailable');
    return undefined;
  }
}
