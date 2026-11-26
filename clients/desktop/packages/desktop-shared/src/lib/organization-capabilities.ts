// ---------------------------------------------------------------------------
// An organization's shared skills and plugins on this desktop (CAN-6236,
// CAN-6237, CAN-6240).
//
// Desktop main reads a workspace's shared set from the web core
// (`core.catalog.projectSetup.get`, or `.organizationDefaults.get` for an
// organization workspace with no project id), installs each item locally,
// and records what it installed here. These pure helpers turn that record
// into the organization layer a chat inherits, and decide which
// organization-owned refs a chat may still use. Framework-free, so main and
// the renderer agree.
//
// A project's shared connections (CAN-6246) ride the same layer as
// connector refs owned by the organization. Nothing is installed for them:
// the desktop's copy is for display and selection only, and the hosted
// proxy decides every call (CAN-6243).
// ---------------------------------------------------------------------------

import { z } from 'zod';
import {
  SelectionRefOwnerSchema,
  sameSelectionRefOwner,
  type SelectionRefOwner,
} from '@canopy/protocol/plugins';
import type { ChatTabPluginSelections } from '../types';

/** Organization skill copies live in a source of their own, never `custom:app`. */
export const ORGANIZATION_SKILL_SOURCE_PREFIX = 'org:';

export function organizationSkillSourceId(organizationId: string): string {
  return `${ORGANIZATION_SKILL_SOURCE_PREFIX}${organizationId}`;
}

export function isOrganizationSkillSourceId(sourceId: string): boolean {
  return sourceId.startsWith(ORGANIZATION_SKILL_SOURCE_PREFIX);
}

/** The organization whose skill source this is; undefined for any other source. */
export function organizationIdOfSkillSource(
  sourceId: string,
): string | undefined {
  if (!isOrganizationSkillSourceId(sourceId)) return undefined;
  const organizationId = sourceId.slice(
    ORGANIZATION_SKILL_SOURCE_PREFIX.length,
  );
  return organizationId.trim().length > 0 ? organizationId : undefined;
}

/**
 * A readable name for an organization skill copy, whose directory name is
 * the item's name as a slug plus a short id suffix (`code-review-1a2b3c4d`).
 */
export function organizationSkillDisplayName(skillName: string): string {
  const dash = skillName.lastIndexOf('-');
  return dash > 0 ? skillName.slice(0, dash) : skillName;
}

/** Which shared set a workspace reads. */
export interface OrganizationCapabilityScope {
  readonly organizationId: string;
  /** The organization project; null for an organization workspace without one. */
  readonly projectId: string | null;
}

export function organizationCapabilityScopeKey(
  scope: OrganizationCapabilityScope,
): string {
  return scope.projectId === null
    ? `organization:${scope.organizationId}`
    : `project:${scope.organizationId}:${scope.projectId}`;
}

/** One item of the shared set as installed here. */
export type InstalledOrganizationItem =
  | {
      /** `capabilitySetupItemKey` of the hosted item. */
      readonly key: string;
      readonly name: string;
      readonly source: 'organization' | 'project';
      readonly status: 'installed';
      readonly skillRef?: { sourceId: string; skillName: string };
      readonly pluginRef?: { marketplaceId: string; pluginName: string };
      /**
       * The local Agent copy (CAN-6237, phase 10a). `createdByOrganization`
       * is true only when the organization layer made the copy: a copy the
       * person had already imported is reused, never deleted.
       */
      readonly agentRef?: { agentId: string; createdByOrganization: boolean };
      /**
       * An organization pipeline (CAN-6237, phase 10b): nothing is copied;
       * the shared pipelines source lists and reads it by its hosted id.
       */
      readonly pipelineRef?: { remoteId: string };
      /** The installed skill's content hash, so an unchanged one is not rewritten. */
      readonly contentHash?: string;
    }
  | {
      readonly key: string;
      readonly name: string;
      readonly source: 'organization' | 'project';
      /** Could not be installed here (yet); never loaded. */
      readonly status: 'failed' | 'unsupported';
    };

/** One shared connection of a project, as this desktop last read it. */
export interface OrganizationSharedConnection {
  /** `capabilitySetupItemKey`-style key: `connector:<connection id>`. */
  readonly key: string;
  readonly connectionId: string;
  readonly name: string;
  readonly source: 'organization' | 'project';
  readonly serverKey: string;
  readonly configId: string;
  readonly identityKind: 'user' | 'bot';
  readonly status: 'pending' | 'connected' | 'needsSignIn' | 'disconnected';
}

export interface OrganizationCapabilitySnapshot {
  readonly scope: OrganizationCapabilityScope;
  /** The signed-in account that read it; never served to another. */
  readonly accountId: string;
  /** The project setup's revision; null for organization defaults only. */
  readonly setupRevision: number | null;
  readonly defaultsRevision: number;
  /** Epoch milliseconds of the read this snapshot came from. */
  readonly fetchedAt: number;
  readonly items: readonly InstalledOrganizationItem[];
  /**
   * The organization's default pipelines the project switched off (phase
   * 10b): left out of the project's workflow library and refused there.
   * Absent when there are none.
   */
  readonly switchedOffPipelines?: readonly string[];
  /**
   * The project's shared connections (CAN-6246). Absent when there are none,
   * and for an organization workspace with no project, where none apply.
   */
  readonly connections?: readonly OrganizationSharedConnection[];
}

/**
 * The organization layer a chat in the snapshot's workspace inherits: every
 * installed item as a selection ref owned by the organization.
 */
export function organizationLayerSelections(
  snapshot: OrganizationCapabilitySnapshot,
): ChatTabPluginSelections {
  const owner: SelectionRefOwner = {
    type: 'organization',
    organizationId: snapshot.scope.organizationId,
  };
  const skillRefs: ChatTabPluginSelections['skillRefs'] = [];
  const pluginRefs: ChatTabPluginSelections['pluginRefs'] = [];
  for (const item of snapshot.items) {
    if (item.status !== 'installed') continue;
    if (item.skillRef) skillRefs.push({ ...item.skillRef, owner });
    if (item.pluginRef) pluginRefs.push({ ...item.pluginRef, owner });
  }
  const mcpServerRefs = (snapshot.connections ?? []).map((connection) => ({
    serverId: connection.serverKey,
    configId: connection.configId,
    owner,
  }));
  return { collectionIds: [], skillRefs, pluginRefs, mcpServerRefs };
}

/** The key of a connector ref without its owner. */
export const organizationConnectorRefKey = (ref: {
  serverId: string;
  configId: string;
}): string => JSON.stringify([ref.serverId, ref.configId]);

const skillKey = (ref: { sourceId: string; skillName: string }): string =>
  JSON.stringify([ref.sourceId, ref.skillName]);
const pluginKey = (ref: {
  marketplaceId: string;
  pluginName: string;
}): string => JSON.stringify([ref.marketplaceId, ref.pluginName]);

/** A workspace's organization layer, with the organization it belongs to. */
export interface AllowedOrganizationItems {
  readonly organizationId: string;
  readonly selections: ChatTabPluginSelections;
}

/**
 * `selections` without the organization refs this workspace no longer allows
 * (CAN-6240): an organization-owned ref, or any ref to an organization skill
 * copy, stays only while `allowed` (the workspace's organization layer) holds
 * it, so a pick does not outlive a removal or a move to another project.
 * Personal refs always stay. `dropped` lists what was taken out.
 */
export function withOnlyAllowedOrganizationRefs(
  selections: ChatTabPluginSelections,
  allowed: AllowedOrganizationItems | undefined,
): { selections: ChatTabPluginSelections; dropped: ChatTabPluginSelections } {
  const allowedSkills = new Set(
    (allowed?.selections.skillRefs ?? []).map(skillKey),
  );
  const allowedPlugins = new Set(
    (allowed?.selections.pluginRefs ?? []).map(pluginKey),
  );
  const allowedConnectors = new Set(
    (allowed?.selections.mcpServerRefs ?? []).map(organizationConnectorRefKey),
  );
  const ownedByAllowed = (owner: SelectionRefOwner | undefined): boolean =>
    owner !== undefined &&
    allowed !== undefined &&
    owner.organizationId === allowed.organizationId;
  const keepSkill = (
    ref: ChatTabPluginSelections['skillRefs'][number],
  ): boolean =>
    ref.owner === undefined && !isOrganizationSkillSourceId(ref.sourceId)
      ? true
      : ownedByAllowed(ref.owner) && allowedSkills.has(skillKey(ref));
  const keepPlugin = (
    ref: ChatTabPluginSelections['pluginRefs'][number],
  ): boolean =>
    ref.owner === undefined
      ? true
      : ownedByAllowed(ref.owner) && allowedPlugins.has(pluginKey(ref));
  // A shared connection stays only while the workspace's project shares it
  // (CAN-6246); the proxy refuses it otherwise anyway (CAN-6243).
  const keepConnector = (
    ref: NonNullable<ChatTabPluginSelections['mcpServerRefs']>[number],
  ): boolean =>
    ref.owner === undefined
      ? true
      : ownedByAllowed(ref.owner) &&
        allowedConnectors.has(organizationConnectorRefKey(ref));
  const skillRefs = selections.skillRefs.filter(keepSkill);
  const pluginRefs = selections.pluginRefs.filter(keepPlugin);
  const mcpServerRefs = (selections.mcpServerRefs ?? []).filter(keepConnector);
  return {
    selections: {
      ...selections,
      skillRefs,
      pluginRefs,
      ...(selections.mcpServerRefs ? { mcpServerRefs } : {}),
    },
    dropped: {
      collectionIds: [],
      skillRefs: selections.skillRefs.filter((ref) => !keepSkill(ref)),
      pluginRefs: selections.pluginRefs.filter((ref) => !keepPlugin(ref)),
      mcpServerRefs: (selections.mcpServerRefs ?? []).filter(
        (ref) => !keepConnector(ref),
      ),
    },
  };
}

/** One shared item a chat in the workspace inherits, as the pickers name it. */
export interface OrganizationLayerItem {
  readonly name: string;
  readonly source: 'organization' | 'project';
  readonly ref:
    | {
        readonly kind: 'skill';
        readonly sourceId: string;
        readonly skillName: string;
      }
    | {
        readonly kind: 'plugin';
        readonly marketplaceId: string;
        readonly pluginName: string;
      }
    | {
        /** A shared connection of the project (CAN-6246). */
        readonly kind: 'connector';
        readonly serverId: string;
        readonly configId: string;
        readonly connectionId: string;
        readonly identityKind: 'user' | 'bot';
        readonly status:
          | 'pending'
          | 'connected'
          | 'needsSignIn'
          | 'disconnected';
      };
}

/** A workspace's organization layer as the renderer reads it (CAN-6237). */
export interface OrganizationLayerView {
  readonly organizationId: string;
  /** Every installed item as a ref owned by the organization. */
  readonly layer: ChatTabPluginSelections;
  readonly items: readonly OrganizationLayerItem[];
}

/** The installed items of a snapshot, with their names. */
export function organizationLayerItems(
  snapshot: OrganizationCapabilitySnapshot,
): OrganizationLayerItem[] {
  const items: OrganizationLayerItem[] = [];
  for (const item of snapshot.items) {
    if (item.status !== 'installed') continue;
    if (item.skillRef)
      items.push({
        name: item.name,
        source: item.source,
        ref: { kind: 'skill', ...item.skillRef },
      });
    if (item.pluginRef)
      items.push({
        name: item.name,
        source: item.source,
        ref: { kind: 'plugin', ...item.pluginRef },
      });
  }
  for (const connection of snapshot.connections ?? [])
    items.push({
      name: connection.name,
      source: connection.source,
      ref: {
        kind: 'connector',
        serverId: connection.serverKey,
        configId: connection.configId,
        connectionId: connection.connectionId,
        identityKind: connection.identityKind,
        status: connection.status,
      },
    });
  return items;
}

/** What a chat in the view's workspace may use of the organization's items. */
export function allowedOrganizationItemsOf(
  view: OrganizationLayerView,
): AllowedOrganizationItems {
  return { organizationId: view.organizationId, selections: view.layer };
}

const OrganizationLayerViewSchema = z.object({
  organizationId: z.string().min(1),
  layer: z.object({
    collectionIds: z.array(z.string()),
    skillRefs: z.array(
      z.object({
        sourceId: z.string(),
        skillName: z.string(),
        owner: SelectionRefOwnerSchema,
      }),
    ),
    pluginRefs: z.array(
      z.object({
        marketplaceId: z.string(),
        pluginName: z.string(),
        owner: SelectionRefOwnerSchema,
      }),
    ),
    mcpServerRefs: z
      .array(
        z.object({
          serverId: z.string(),
          configId: z.string(),
          owner: SelectionRefOwnerSchema,
        }),
      )
      .optional(),
  }),
  items: z.array(
    z.object({
      name: z.string(),
      source: z.enum(['organization', 'project']),
      ref: z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('skill'),
          sourceId: z.string(),
          skillName: z.string(),
        }),
        z.object({
          kind: z.literal('plugin'),
          marketplaceId: z.string(),
          pluginName: z.string(),
        }),
        z.object({
          kind: z.literal('connector'),
          serverId: z.string(),
          configId: z.string(),
          connectionId: z.string(),
          identityKind: z.enum(['user', 'bot']),
          status: z.enum([
            'pending',
            'connected',
            'needsSignIn',
            'disconnected',
          ]),
        }),
      ]),
    }),
  ),
});

/** A view read over IPC; null for none or a malformed one. */
export function parseOrganizationLayerView(
  value: unknown,
): OrganizationLayerView | null {
  const parsed = OrganizationLayerViewSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * `chosen` with each ref's owner put back. A picker keys its rows by an
 * item's identity, so a save rebuilds refs without their owner (CAN-6235).
 * A checked item keeps every ref it had in `previous` (what the picker
 * showed): the person's own pick and the organization's, when both were
 * there. An item new to the set takes the organization's owner when it is in
 * the organization's layer, and an organization skill copy always names its
 * organization. Anything else is the person's own.
 */
export function withSelectionOwnersRestored(
  chosen: ChatTabPluginSelections,
  context: {
    readonly previous?: ChatTabPluginSelections;
    readonly organization?: OrganizationLayerView;
  },
): ChatTabPluginSelections {
  type Owners = (SelectionRefOwner | undefined)[];
  const collect = <T extends { owner?: SelectionRefOwner }>(
    refs: readonly T[] | undefined,
    key: (ref: T) => string,
  ): Map<string, Owners> => {
    const owners = new Map<string, Owners>();
    for (const ref of refs ?? []) {
      const list = owners.get(key(ref)) ?? [];
      if (!list.some((owner) => sameSelectionRefOwner(owner, ref.owner)))
        list.push(ref.owner);
      owners.set(key(ref), list);
    }
    return owners;
  };
  const mcpKey = (ref: { serverId: string; configId: string }): string =>
    JSON.stringify([ref.serverId, ref.configId]);
  const previousSkills = collect(context.previous?.skillRefs, skillKey);
  const previousPlugins = collect(context.previous?.pluginRefs, pluginKey);
  const previousMcp = collect(context.previous?.mcpServerRefs, mcpKey);
  const organizationSkills = collect(
    context.organization?.layer.skillRefs,
    skillKey,
  );
  const organizationPlugins = collect(
    context.organization?.layer.pluginRefs,
    pluginKey,
  );
  const organizationConnectors = collect(
    context.organization?.layer.mcpServerRefs,
    mcpKey,
  );
  const expand = <T extends { owner?: SelectionRefOwner }>(
    ref: T,
    owners: Owners | undefined,
  ): T[] => {
    if (!owners?.length) return [ref];
    return owners.map((owner) => {
      const copy = { ...ref };
      delete copy.owner;
      return owner ? { ...copy, owner } : copy;
    });
  };
  return {
    ...chosen,
    skillRefs: chosen.skillRefs.flatMap((ref) => {
      const organizationId = organizationIdOfSkillSource(ref.sourceId);
      return expand(
        ref,
        previousSkills.get(skillKey(ref)) ??
          organizationSkills.get(skillKey(ref)) ??
          (organizationId === undefined
            ? undefined
            : [{ type: 'organization', organizationId }]),
      );
    }),
    pluginRefs: chosen.pluginRefs.flatMap((ref) =>
      expand(
        ref,
        previousPlugins.get(pluginKey(ref)) ??
          organizationPlugins.get(pluginKey(ref)),
      ),
    ),
    ...(chosen.mcpServerRefs
      ? {
          mcpServerRefs: chosen.mcpServerRefs.flatMap((ref) =>
            expand(
              ref,
              previousMcp.get(mcpKey(ref)) ??
                organizationConnectors.get(mcpKey(ref)),
            ),
          ),
        }
      : {}),
  };
}
