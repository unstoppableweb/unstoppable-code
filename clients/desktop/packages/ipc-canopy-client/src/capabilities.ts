/**
 * Effective capabilities for a remote controller: what the client reports,
 * narrowed by what the controlled host supports and by what this controller
 * is authorized to do. Each limit can only lower a capability, never raise
 * one: a boolean stays `true` only when no limit sets it `false`, and an
 * ordered level (`fileSystemAccess`, `pipelines`, removal modes and similar)
 * takes the lowest level any limit allows. A limit that omits a field leaves
 * it alone.
 */
import type {
  CanopyCapabilities,
  FileSystemAccessLevel,
  PipelineCapability,
  SettingsScope,
  WorkspaceCreationCapability,
  WorkspaceSettingsCapability,
  WorktreeRemovalCapability,
} from '@canopy/app-core';
import {
  REMOTE_COMMAND_CHANNELS,
  REMOTE_EVENT_CHANNELS,
  REMOTE_MEMBER_CHANNELS,
  REMOTE_QUERY_CHANNELS,
  remoteOperationChannelUse,
  type RemoteCapabilityRequirement,
  type RemoteOperationChannels,
} from '@canopy/protocol/remote-control/channels';

/** A ceiling on capabilities; omitted fields do not limit. */
export type CapabilityLimit = Partial<CanopyCapabilities>;

type BooleanCapability = {
  [K in keyof CanopyCapabilities]-?: NonNullable<
    CanopyCapabilities[K]
  > extends boolean
    ? K
    : never;
}[keyof CanopyCapabilities];

/** Least capable first. */
const FILE_ACCESS_ORDER: readonly FileSystemAccessLevel[] = [
  'none',
  'read',
  'read-write',
];
const PIPELINE_ORDER: readonly PipelineCapability[] = [
  'read-only',
  'crud-only',
  'execute',
];
const SETTINGS_ORDER: readonly SettingsScope[] = ['api-keys-only', 'full'];
const WORKSPACE_CREATION_ORDER: readonly WorkspaceCreationCapability[] = [
  false,
  'remote-clone',
  'full',
];
const WORKSPACE_SETTINGS_ORDER: readonly WorkspaceSettingsCapability[] = [
  false,
  'full',
];
const REMOVAL_ORDER: readonly WorktreeRemovalCapability[] = [
  false,
  'archive',
  'delete',
];

function lowest<T>(order: readonly T[], base: T, limit: T | undefined): T {
  if (limit === undefined) return base;
  return order.indexOf(limit) < order.indexOf(base) ? limit : base;
}

function lowestOptional<T>(
  order: readonly T[],
  base: T | undefined,
  limit: T | undefined,
): T | undefined {
  if (base === undefined) return undefined;
  return lowest(order, base, limit);
}

function denyBoolean(
  capabilities: CanopyCapabilities,
  key: BooleanCapability,
): CanopyCapabilities {
  return { ...capabilities, [key]: false };
}

function intersectOne(
  base: CanopyCapabilities,
  limit: CapabilityLimit,
): CanopyCapabilities {
  let result: CanopyCapabilities = {
    ...base,
    fileSystemAccess: lowest(
      FILE_ACCESS_ORDER,
      base.fileSystemAccess,
      limit.fileSystemAccess,
    ),
    pipelines: lowest(PIPELINE_ORDER, base.pipelines, limit.pipelines),
    settingsScope: lowest(
      SETTINGS_ORDER,
      base.settingsScope,
      limit.settingsScope,
    ),
    workspaceCreation: lowestOptional(
      WORKSPACE_CREATION_ORDER,
      base.workspaceCreation,
      limit.workspaceCreation,
    ),
    workspaceSettings: lowestOptional(
      WORKSPACE_SETTINGS_ORDER,
      base.workspaceSettings,
      limit.workspaceSettings,
    ),
    workspaceRemoval: lowestOptional(
      REMOVAL_ORDER,
      base.workspaceRemoval,
      limit.workspaceRemoval,
    ),
    worktreeRemoval: lowestOptional(
      REMOVAL_ORDER,
      base.worktreeRemoval,
      limit.worktreeRemoval,
    ),
    ...(base.chatWorkflows !== undefined
      ? {
          chatWorkflows: {
            ...base.chatWorkflows,
            ...Object.fromEntries(
              Object.entries(limit.chatWorkflows ?? {}).filter(
                ([, value]) => value === false,
              ),
            ),
          },
        }
      : {}),
  };
  for (const [key, value] of Object.entries(limit)) {
    if (value === false && isBooleanCapability(base, key)) {
      result = denyBoolean(result, key);
    }
  }
  return result;
}

function isBooleanCapability(
  base: CanopyCapabilities,
  key: string,
): key is BooleanCapability {
  const value: unknown = Reflect.get(base, key);
  return value === undefined || typeof value === 'boolean';
}

/**
 * `base` narrowed by every limit (host-supported features, controller
 * authorization). Pure; `base` is not modified.
 */
export function intersectCanopyCapabilities(
  base: CanopyCapabilities,
  ...limits: readonly CapabilityLimit[]
): CanopyCapabilities {
  return limits.reduce<CanopyCapabilities>(intersectOne, base);
}

function boolRequirements(
  requirements: readonly RemoteCapabilityRequirement[] | undefined,
): string[] {
  return (requirements ?? []).flatMap((requirement) =>
    typeof requirement === 'string' ? [requirement] : [],
  );
}

/**
 * Whether an operation can reach an authorized channel. A branch with its own
 * gate counts only when the operation has no other channel: that gate is
 * judged by the branch alone, so a gated branch never keeps the operation's
 * own gate on (the transcripts member's block reads, CAN-7432).
 */
function usable(
  entry: RemoteOperationChannels,
  authorized: ReadonlySet<string>,
): boolean {
  const own = remoteOperationChannelUse({
    ...entry,
    branches: (entry.branches ?? []).filter(
      (branch) => boolRequirements(branch.requires).length === 0,
    ),
  });
  const ownNeeded = [...own.invoke, ...own.listen];
  const use = remoteOperationChannelUse(entry);
  const needed =
    ownNeeded.length > 0 ? ownNeeded : [...use.invoke, ...use.listen];
  return (
    needed.length === 0 || needed.some((channel) => authorized.has(channel))
  );
}

/**
 * A capability limit from a controller's channel allowlist: a boolean
 * capability that gates operations is denied when none of the operations it
 * gates can reach an authorized channel. Combine with
 * {@link intersectCanopyCapabilities}; the allowlist itself still decides
 * each call.
 */
export function capabilityLimitForChannels(
  authorized: ReadonlySet<string>,
): CapabilityLimit {
  const gated = new Map<string, boolean>();
  const entries: RemoteOperationChannels[] = [
    ...Object.values(REMOTE_QUERY_CHANNELS),
    ...Object.values(REMOTE_COMMAND_CHANNELS),
    ...Object.values(REMOTE_EVENT_CHANNELS),
    ...Object.values(REMOTE_MEMBER_CHANNELS),
  ];
  const gate = (
    requires: readonly RemoteCapabilityRequirement[] | undefined,
    reachable: boolean,
  ): void => {
    for (const key of boolRequirements(requires)) {
      gated.set(key, (gated.get(key) ?? false) || reachable);
    }
  };
  for (const entry of entries) {
    gate(entry.requires, usable(entry, authorized));
    // A branch's own gate is reachable through the branch's channels alone
    // (`delegationBlockReads` on the transcripts member, CAN-7432). A branch
    // with no channel is answered locally and says nothing about reach, so
    // it is left to the gate's other operations.
    for (const branch of entry.branches ?? []) {
      if (branch.requires === undefined) continue;
      const needed = [...(branch.invoke ?? []), ...(branch.listen ?? [])];
      if (needed.length === 0) continue;
      gate(
        branch.requires,
        needed.some((channel) => authorized.has(channel)),
      );
    }
  }
  const limit: Record<string, boolean> = {};
  for (const [key, reachable] of gated) {
    if (!reachable) limit[key] = false;
  }
  return limitFromRecord(limit);
}

function limitFromRecord(denied: Record<string, boolean>): CapabilityLimit {
  let limit: CapabilityLimit = {};
  for (const key of Object.keys(denied)) {
    limit = denyLimit(limit, key);
  }
  return limit;
}

const BOOLEAN_PROBE: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'none',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'read-only',
  routing: 'url',
  overviewNotifications: false,
};

function denyLimit(limit: CapabilityLimit, key: string): CapabilityLimit {
  return isBooleanCapability(BOOLEAN_PROBE, key)
    ? { ...limit, [key]: false }
    : limit;
}
