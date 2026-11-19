import {
  capabilitySetupItemKey,
  type CatalogProjectSetupItem,
} from '@canopy/protocol/canopy-core';
import type { ShareablePluginRef } from '@canopy/protocol/plugins';
import type { InstalledOrganizationItem } from '@canopy/desktop-shared/lib/organization-capabilities';
import { organizationSkillSourceId } from '@canopy/desktop-shared/lib/organization-capabilities';

/**
 * Installs the items of an organization's shared set on this computer
 * (CAN-6236). Skills are copied into the organization's own skill source
 * (`org:<organizationId>`), apart from the person's skills; plugins come in
 * through the shared marketplace import a person's own import uses. Agents
 * come in through the shared Agent import, which records them as the
 * organization's, so they show only in its workspaces (CAN-6237, phase 10a).
 * Pipelines are not installed in this release step.
 *
 * Only a skill's SKILL.md is copied: supporting files published as a
 * capability package are not yet installed for organization copies.
 */
export interface OrganizationInstallDeps {
  getSharedSkill(id: string): Promise<{
    readonly name: string;
    readonly rawSkill: string;
    readonly contentHash: string;
    readonly owner: { readonly type: string; readonly id?: string };
  }>;
  getSharedPluginRef(id: string): Promise<{
    readonly ref: ShareablePluginRef;
    readonly owner: { readonly type: string; readonly id?: string };
  }>;
  importMarketplacePlugin(
    ref: ShareablePluginRef,
  ): Promise<{ marketplaceId: string; pluginName: string } | null>;
  /**
   * Whether organization Agents install on this computer, and organization
   * pipelines apply to its projects (phase 10b): only while resources are
   * kept to the context that owns them (the organization projects flag), so
   * none shows in a Personal workspace.
   */
  agentsEnabled(): boolean;
  /**
   * Whether organization projects are known to be off (a settled verdict,
   * not a default while flags load): the Agent copies this layer made are
   * removed, so none is left usable outside the organization's workspaces.
   */
  agentsSettledOff(): boolean;
  /**
   * Imports a shared Agent through the person's shared Agent import, or
   * null when it is not owned by `organizationId`. `existedBefore` is true
   * when the copy it answers was already on this computer before the
   * import (the person's own import, or an earlier organization copy).
   * `organizationCopy` is the copy this layer made for the Agent before:
   * when the share changed and the person has not changed that copy, it is
   * updated in place (`updated`), keeping its id and name, so chats that
   * picked it keep working.
   */
  importOrganizationAgent(
    id: string,
    organizationId: string,
    organizationCopy?: string,
  ): Promise<{
    agentId: string;
    existedBefore: boolean;
    updated?: boolean;
  } | null>;
  /**
   * Removes an Agent copy the organization layer created, unless the
   * person changed it, which leaves it theirs. True when a copy was
   * removed; false when it is already gone or is the person's now. Throws
   * when the removal failed, so it is tried again.
   */
  removeOrganizationAgent(agentId: string): Promise<boolean>;
  /**
   * Tells the Agent registry and the windows that copies were added or
   * removed, as any Agent change does, so the pickers offer what is here.
   * A failure is not an install or removal failure: the copy stays recorded,
   * and the next change publishes again.
   */
  publishAgentChanges(): Promise<void>;
  writeSkill(
    sourceId: string,
    skillName: string,
    rawSkill: string,
  ): Promise<void>;
  listSkills(sourceId: string): Promise<string[]>;
  removeSkill(sourceId: string, skillName: string): Promise<void>;
  /** Whether the copy is still on disk, so a removed one is written again. */
  skillExists(sourceId: string, skillName: string): Promise<boolean>;
}

const SLUG_MAX = 48;

/** A stable, unique directory name for an organization's skill. */
export function organizationSkillName(name: string, id: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  const suffix = id
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 8)
    .toLowerCase();
  return `${slug || 'skill'}-${suffix || 'item'}`;
}

export function ownedByOrganization(
  owner: { readonly type: string; readonly id?: string },
  organizationId: string,
): boolean {
  return owner.type === 'organization' && owner.id === organizationId;
}

/**
 * Installs one item, reusing `previous` when its content is unchanged.
 * `createdAgents` are the Agent copies the organization layer made, as any
 * set on this computer recorded them or as still due for removal: a set that
 * reuses one of them marks it created too.
 */
export async function installOrganizationItem(
  deps: OrganizationInstallDeps,
  organizationId: string,
  entry: CatalogProjectSetupItem,
  previous: InstalledOrganizationItem | undefined,
  createdAgents: ReadonlySet<string> = new Set(),
  onAgentCreated: (agentId: string) => Promise<void> = () => Promise.resolve(),
): Promise<InstalledOrganizationItem> {
  const { item, source } = entry;
  const key = capabilitySetupItemKey(item.ref);
  const base = { key, name: item.name, source } as const;
  try {
    switch (item.ref.kind) {
      case 'skill': {
        const detail = await deps.getSharedSkill(item.ref.id);
        if (!ownedByOrganization(detail.owner, organizationId))
          return { ...base, status: 'failed' };
        const sourceId = organizationSkillSourceId(organizationId);
        const skillName = organizationSkillName(detail.name, item.ref.id);
        if (
          previous?.status !== 'installed' ||
          previous.contentHash !== detail.contentHash ||
          previous.skillRef?.skillName !== skillName ||
          !(await deps.skillExists(sourceId, skillName))
        )
          await deps.writeSkill(sourceId, skillName, detail.rawSkill);
        return {
          ...base,
          status: 'installed',
          skillRef: { sourceId, skillName },
          contentHash: detail.contentHash,
        };
      }
      case 'plugin': {
        const detail = await deps.getSharedPluginRef(item.ref.id);
        if (!ownedByOrganization(detail.owner, organizationId))
          return { ...base, status: 'failed' };
        return pluginInstalled(
          base,
          await deps.importMarketplacePlugin(detail.ref),
        );
      }
      case 'marketplacePlugin':
        return pluginInstalled(
          base,
          await deps.importMarketplacePlugin(item.ref.ref),
        );
      case 'agent':
        return await installOrganizationAgent(
          deps,
          organizationId,
          base,
          item.ref.id,
          previous,
          createdAgents,
          onAgentCreated,
        );
      case 'pipeline':
        return installOrganizationPipeline(deps, base, item.ref.id, previous);
    }
  } catch {
    // A transient read or import failure keeps the item as it was installed,
    // so one flaky call neither removes it nor prunes its copy.
    return previous?.status === 'installed'
      ? previous
      : { ...base, status: 'failed' };
  }
}

/**
 * An organization pipeline is recorded, not copied (CAN-6237, phase 10b):
 * the shared pipelines source already lists the organization's pipelines in
 * its workspaces and authorizes each read, so the set only says which ones
 * the project has. Gated as Agents are.
 */
function installOrganizationPipeline(
  deps: OrganizationInstallDeps,
  base: Pick<InstalledOrganizationItem, 'key' | 'name' | 'source'>,
  id: string,
  previous: InstalledOrganizationItem | undefined,
): InstalledOrganizationItem {
  if (!deps.agentsEnabled())
    return previous?.status === 'installed' && !deps.agentsSettledOff()
      ? previous
      : { ...base, status: 'unsupported' };
  return { ...base, status: 'installed', pipelineRef: { remoteId: id } };
}

async function installOrganizationAgent(
  deps: OrganizationInstallDeps,
  organizationId: string,
  base: Pick<InstalledOrganizationItem, 'key' | 'name' | 'source'>,
  id: string,
  previous: InstalledOrganizationItem | undefined,
  createdAgents: ReadonlySet<string>,
  onAgentCreated: (agentId: string) => Promise<void>,
): Promise<InstalledOrganizationItem> {
  if (!deps.agentsEnabled())
    // While the flag is not known yet, an installed copy stays as it is;
    // once it is known to be off, no Agent is installed.
    return previous?.status === 'installed' && !deps.agentsSettledOff()
      ? previous
      : { ...base, status: 'unsupported' };
  const organizationCopy =
    previous?.status === 'installed' &&
    previous.agentRef?.createdByOrganization === true
      ? previous.agentRef.agentId
      : undefined;
  const imported = await deps.importOrganizationAgent(
    id,
    organizationId,
    organizationCopy,
  );
  if (imported === null) return { ...base, status: 'failed' };
  // A new copy is recorded as the organization's before anything else can
  // fail, then published, so neither a failed publication nor a read whose
  // result is dropped keeps it from being removed later.
  if (!imported.existedBefore) await onAgentCreated(imported.agentId);
  if (!imported.existedBefore || imported.updated === true)
    await deps.publishAgentChanges().catch(() => undefined);
  // Made by this layer if it was not here before, or any set made it
  // earlier; a copy the person imported stays theirs.
  const createdByOrganization =
    !imported.existedBefore || createdAgents.has(imported.agentId);
  return {
    ...base,
    status: 'installed',
    agentRef: { agentId: imported.agentId, createdByOrganization },
  };
}

function pluginInstalled(
  base: Pick<InstalledOrganizationItem, 'key' | 'name' | 'source'>,
  ref: { marketplaceId: string; pluginName: string } | null,
): InstalledOrganizationItem {
  return ref
    ? {
        ...base,
        status: 'installed',
        pluginRef: {
          marketplaceId: ref.marketplaceId,
          pluginName: ref.pluginName,
        },
      }
    : { ...base, status: 'unsupported' };
}

/**
 * Removes the organization's skill copies no shared set on this computer
 * still uses. The person's own skills and installed plugins are left alone.
 */
export async function pruneOrganizationSkills(
  deps: Pick<OrganizationInstallDeps, 'listSkills' | 'removeSkill'>,
  organizationId: string,
  keep: ReadonlySet<string>,
): Promise<void> {
  const sourceId = organizationSkillSourceId(organizationId);
  for (const skillName of await deps.listSkills(sourceId)) {
    if (!keep.has(skillName)) await deps.removeSkill(sourceId, skillName);
  }
}

/** The Agent copies the organization layer created, across `snapshots`. */
export function organizationCreatedAgentIds(
  snapshots: Iterable<{ readonly items: readonly InstalledOrganizationItem[] }>,
): Set<string> {
  const ids = new Set<string>();
  for (const snapshot of snapshots)
    for (const item of snapshot.items)
      if (item.status === 'installed' && item.agentRef?.createdByOrganization)
        ids.add(item.agentRef.agentId);
  return ids;
}

/**
 * The Agent copies any installed item across `snapshots` holds, whoever
 * created them: a copy one of them holds is never removed.
 */
export function heldAgentIds(
  snapshots: Iterable<{ readonly items: readonly InstalledOrganizationItem[] }>,
): Set<string> {
  const ids = new Set<string>();
  for (const snapshot of snapshots)
    for (const item of snapshot.items)
      if (item.status === 'installed' && item.agentRef)
        ids.add(item.agentRef.agentId);
  return ids;
}
