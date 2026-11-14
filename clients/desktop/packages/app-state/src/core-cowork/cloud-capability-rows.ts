import {
  CLOUD_CUSTOM_SKILL_SOURCE_ID,
  skillEntryId,
  type CatalogEntry,
  type CatalogHarnessId,
  type CatalogSkillRow,
} from '@canopy/protocol/canopy-core';

/**
 * What a capability can do in a cloud chat (CAN-6176). Only `ready` rows can
 * be selected; the others name the step that would make them selectable, or
 * why nothing can.
 */
export type CloudCapabilityState =
  | { readonly kind: 'ready'; readonly cloudEntryId: string }
  | {
      readonly kind: 'needs_upload';
      readonly reason: 'not_uploaded' | 'changed';
      readonly action: 'publish_skill' | 'publish_plugin' | 'copy_mcp_server';
      /** The cloud copy a `changed` row would replace; null when there is none. */
      readonly cloudEntryId: string | null;
    }
  | { readonly kind: 'needs_sign_in'; readonly cloudEntryId: string }
  | {
      readonly kind: 'desktop_only';
      readonly online: boolean;
      readonly cloudEntryId: string | null;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: CloudCapabilityUnavailableReason;
    };

export type CloudCapabilityUnavailableReason =
  | 'desktop_builtin'
  | 'local_project'
  | 'cloud_unavailable'
  /** A plugin the chat's harness does not support, or has turned off. */
  | 'harness_unsupported';

export interface CloudCapabilityRow {
  /** What the row shows: an MCP configuration reads `server / config`, as search does. */
  readonly name: string;
  /** The desktop core's entry; null for a capability only the cloud has. */
  readonly localEntry: CatalogEntry | null;
  /** The web core's entry it maps to; null when the cloud has none. */
  readonly cloudEntry: CatalogEntry | null;
  readonly state: CloudCapabilityState;
}

/** A desktop capability the cloud account lacks, and what adds it. */
export type CloudCapabilityNeedsUpload = Extract<
  CloudCapabilityState,
  { readonly kind: 'needs_upload' }
>;

/** A row the cloud chat picker can offer to copy to the cloud (CAN-6176 R5d). */
export type CloudCapabilityUploadRow = CloudCapabilityRow & {
  readonly localEntry: CatalogEntry;
  readonly state: CloudCapabilityNeedsUpload;
};

/** Whether a row needs its desktop capability copied to the cloud first. */
export function needsCloudUpload(
  row: CloudCapabilityRow,
): row is CloudCapabilityUploadRow {
  return row.localEntry !== null && row.state.kind === 'needs_upload';
}

export interface CloudCapabilityRowsInput {
  /** `core.catalog.snapshot.get` on the desktop core; empty on a host without one. */
  readonly local: readonly CatalogEntry[];
  /** `core.catalog.skill.list` on the desktop core, for each skill's cloud link. */
  readonly localSkills: readonly CatalogSkillRow[];
  /** `core.catalog.snapshot.get` on the web core for the cloud chat's workspace. */
  readonly cloud: readonly CatalogEntry[];
  /** The cloud chat's harness; a plugin is usable only where it loads (CAN-6034). */
  readonly harness: CatalogHarnessId;
}

const CAPABILITY_KINDS: ReadonlySet<CatalogEntry['kind']> = new Set([
  'skill',
  'plugin',
  'mcp_server',
]);

function fromCloud(entry: CatalogEntry): CloudCapabilityState {
  if (entry.availability === 'available')
    return { kind: 'ready', cloudEntryId: entry.entryId };
  if (entry.availability === 'auth_required')
    return { kind: 'needs_sign_in', cloudEntryId: entry.entryId };
  if (
    entry.content.kind === 'mcp_server' &&
    entry.content.connectionState === 'desktop_only'
  )
    return { kind: 'desktop_only', online: false, cloudEntryId: entry.entryId };
  return { kind: 'unavailable', reason: 'cloud_unavailable' };
}

/** A plugin entry without that harness's facts is not usable there. */
function pluginLoads(entry: CatalogEntry, harness: CatalogHarnessId): boolean {
  if (entry.content.kind !== 'plugin') return true;
  const facts = entry.content.harnesses?.[harness];
  return facts !== undefined && facts.supported && facts.enabled;
}

/**
 * A skill entry carries no reference to the plugin that brings it, so it
 * belongs to the one plugin in the same snapshot that lists it as a skill
 * member. No owner, or more than one, is not usable.
 */
function pluginSkillLoads(
  skill: CatalogEntry,
  entries: readonly CatalogEntry[],
  harness: CatalogHarnessId,
): boolean {
  const owners = entries.filter(
    (entry) =>
      entry.content.kind === 'plugin' &&
      Object.values(entry.content.harnesses ?? {}).some((facts) =>
        facts.members.some(
          (member) => member.kind === 'skill' && member.name === skill.name,
        ),
      ),
  );
  return owners.length === 1 && pluginLoads(owners[0], harness);
}

/** Whether the chat's harness can load the entry, judged within its own snapshot. */
function loadsIn(
  entry: CatalogEntry,
  entries: readonly CatalogEntry[],
  harness: CatalogHarnessId,
): boolean {
  return entry.kind === 'skill' && entry.source === 'plugin'
    ? pluginSkillLoads(entry, entries, harness)
    : pluginLoads(entry, harness);
}

const HARNESS_UNSUPPORTED: CloudCapabilityState = {
  kind: 'unavailable',
  reason: 'harness_unsupported',
};

function fromCloudFor(
  entry: CatalogEntry,
  cloud: readonly CatalogEntry[],
  harness: CatalogHarnessId,
): CloudCapabilityState {
  return loadsIn(entry, cloud, harness)
    ? fromCloud(entry)
    : HARNESS_UNSUPPORTED;
}

/** Both snapshots and the chat's harness, as every row reads them. */
interface RowScope {
  readonly local: readonly CatalogEntry[];
  readonly cloud: readonly CatalogEntry[];
  readonly cloudById: ReadonlyMap<string, CatalogEntry>;
  readonly harness: CatalogHarnessId;
}

function skillState(
  entry: CatalogEntry,
  skill: CatalogSkillRow | undefined,
  scope: RowScope,
): { state: CloudCapabilityState; cloudEntry: CatalogEntry | null } {
  const { cloud, cloudById } = scope;
  if (entry.source === 'workspace')
    return {
      state: { kind: 'unavailable', reason: 'local_project' },
      cloudEntry: null,
    };
  if (skill?.origin === 'builtin' || entry.source === 'bundled') {
    const twin = cloud.find(
      (candidate) =>
        candidate.kind === 'skill' &&
        (candidate.source === 'bundled' || candidate.source === 'remote') &&
        candidate.name === entry.name,
    );
    return twin === undefined
      ? {
          state: { kind: 'unavailable', reason: 'desktop_builtin' },
          cloudEntry: null,
        }
      : { state: fromCloud(twin), cloudEntry: twin };
  }
  if (entry.source === 'plugin') return pluginState(entry, scope);
  const share = skill?.cloudShare;
  const linked =
    share === undefined
      ? undefined
      : cloudById.get(
          skillEntryId({
            sourceId: CLOUD_CUSTOM_SKILL_SOURCE_ID,
            skillName: share.remoteId,
          }),
        );
  if (share === undefined || linked === undefined)
    return {
      state: {
        kind: 'needs_upload',
        reason: 'not_uploaded',
        action: 'publish_skill',
        cloudEntryId: null,
      },
      cloudEntry: null,
    };
  const inStep =
    share.localContentHash !== null &&
    share.localContentHash === share.linkedContentHash;
  return {
    state: inStep
      ? fromCloud(linked)
      : {
          kind: 'needs_upload',
          reason: 'changed',
          action: 'publish_skill',
          cloudEntryId: linked.entryId,
        },
    cloudEntry: linked,
  };
}

/** A plugin, or a skill a plugin brings: both reach the cloud as the plugin. */
function pluginState(
  entry: CatalogEntry,
  scope: RowScope,
): { state: CloudCapabilityState; cloudEntry: CatalogEntry | null } {
  const twin = scope.cloudById.get(entry.entryId);
  if (twin !== undefined)
    return {
      state: fromCloudFor(twin, scope.cloud, scope.harness),
      cloudEntry: twin,
    };
  return {
    state: loadsIn(entry, scope.local, scope.harness)
      ? {
          kind: 'needs_upload',
          reason: 'not_uploaded',
          action: 'publish_plugin',
          cloudEntryId: null,
        }
      : HARNESS_UNSUPPORTED,
    cloudEntry: null,
  };
}

function mcpServerState(
  entry: CatalogEntry,
  cloudById: ReadonlyMap<string, CatalogEntry>,
  cloud: readonly CatalogEntry[],
): { state: CloudCapabilityState; cloudEntry: CatalogEntry | null } {
  const content = entry.content.kind === 'mcp_server' ? entry.content : null;
  const connectionId = content?.authIntegrationId ?? null;
  const twin =
    cloudById.get(entry.entryId) ??
    (connectionId === null
      ? undefined
      : cloud.find(
          (candidate) =>
            candidate.content.kind === 'mcp_server' &&
            candidate.content.authIntegrationId === connectionId,
        ));
  if (twin !== undefined) return { state: fromCloud(twin), cloudEntry: twin };
  if (
    content?.transport === 'stdio' ||
    content?.connectionState === 'desktop_only'
  )
    return {
      state: { kind: 'desktop_only', online: false, cloudEntryId: null },
      cloudEntry: null,
    };
  return {
    state: {
      kind: 'needs_upload',
      reason: 'not_uploaded',
      action: 'copy_mcp_server',
      cloudEntryId: null,
    },
    cloudEntry: null,
  };
}

function displayName(entry: CatalogEntry): string {
  const configName =
    entry.content.kind === 'mcp_server' ? entry.content.configName : undefined;
  return configName && configName !== entry.name
    ? `${entry.name} / ${configName}`
    : entry.name;
}

/**
 * One row per skill, plugin and MCP server a cloud chat can show: each desktop
 * entry beside the cloud entry it maps to, then the cloud entries no desktop
 * entry claimed. Pure; the caller reads both cores and decides whether to read
 * the desktop one at all (`cloudCapabilityLinks`).
 */
export function cloudCapabilityRows(
  input: CloudCapabilityRowsInput,
): CloudCapabilityRow[] {
  const cloud = input.cloud.filter((entry) => CAPABILITY_KINDS.has(entry.kind));
  const cloudById = new Map(cloud.map((entry) => [entry.entryId, entry]));
  const skills = new Map(
    input.localSkills.map((skill) => [skill.entryId, skill]),
  );
  const scope: RowScope = {
    local: input.local,
    cloud,
    cloudById,
    harness: input.harness,
  };
  const claimed = new Set<string>();
  const rows: CloudCapabilityRow[] = [];
  for (const entry of input.local) {
    if (!CAPABILITY_KINDS.has(entry.kind)) continue;
    const mapped =
      entry.kind === 'skill'
        ? skillState(entry, skills.get(entry.entryId), scope)
        : entry.kind === 'mcp_server'
          ? mcpServerState(entry, cloudById, cloud)
          : pluginState(entry, scope);
    if (mapped.cloudEntry !== null) claimed.add(mapped.cloudEntry.entryId);
    rows.push({
      name: displayName(entry),
      localEntry: entry,
      cloudEntry: mapped.cloudEntry,
      state: mapped.state,
    });
  }
  for (const entry of cloud) {
    if (claimed.has(entry.entryId)) continue;
    rows.push({
      name: displayName(entry),
      localEntry: null,
      cloudEntry: entry,
      state: fromCloudFor(entry, cloud, input.harness),
    });
  }
  return rows;
}
