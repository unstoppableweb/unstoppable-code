import { z } from 'zod';
import type { UnifiedEntryRef } from '../unified-entry';

export { normalizeInstalledAt, parseInstalledAt } from './installed-at';

const identity = z.string().min(1).max(2048);
export const InstalledItemStatusSchema = z.enum([
  'active',
  'available',
  'disabled',
]);
export type InstalledItemStatus = z.infer<typeof InstalledItemStatusSchema>;

/**
 * Why a marketplace plugin has no Uninstall. Hosts that can open the owning
 * marketplace offer that instead of this text.
 */
export const INSTALLED_ITEM_MARKETPLACE_OWNED_REASON =
  'This plugin uses its marketplace source. Remove it through the marketplace instead.';

export const InstalledItemRefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('plugin'),
      marketplaceId: identity,
      pluginName: identity,
    })
    .strict(),
  z
    .object({
      kind: z.literal('skill'),
      sourceId: identity,
      skillName: identity,
    })
    .strict(),
  z.object({ kind: z.literal('collection'), collectionId: identity }).strict(),
  z
    .object({
      kind: z.literal('mcp-config'),
      serverId: identity,
      configId: identity,
    })
    .strict(),
  z.object({ kind: z.literal('account-mcp'), connectionId: identity }).strict(),
]);
export type InstalledItemRef = z.infer<typeof InstalledItemRefSchema>;
export type DisableableInstalledItemRef = Exclude<
  InstalledItemRef,
  { kind: 'mcp-config' | 'account-mcp' }
>;

export const InstalledItemTargetSchema = z.union([
  InstalledItemRefSchema,
  z.object({ kind: z.literal('mcp-server'), serverId: identity }).strict(),
]);
export type InstalledItemTarget = z.infer<typeof InstalledItemTargetSchema>;
// A device configuration cannot authorize deletion of its sibling configurations.
export const InstalledItemUninstallTargetSchema = z.union([
  InstalledItemRefSchema.options[0],
  InstalledItemRefSchema.options[1],
  InstalledItemRefSchema.options[2],
  InstalledItemRefSchema.options[4],
  z.object({ kind: z.literal('mcp-server'), serverId: identity }).strict(),
]);
export type InstalledItemUninstallTarget = z.infer<
  typeof InstalledItemUninstallTargetSchema
>;

export function normalizeInstalledItemRef(
  ref: InstalledItemRef,
): InstalledItemRef {
  return ref.kind === 'plugin'
    ? { ...ref, pluginName: ref.pluginName.toLowerCase() }
    : ref;
}

/**
 * A selection ref spread into an installed-item ref may carry its selection
 * owner (CAN-6235). Which organization or person selected an item doesn't
 * change which installed item it is, so the key ignores it.
 */
function withoutSelectionOwner(ref: InstalledItemRef): InstalledItemRef {
  if (!('owner' in ref)) return ref;
  switch (ref.kind) {
    case 'plugin':
      return {
        kind: ref.kind,
        marketplaceId: ref.marketplaceId,
        pluginName: ref.pluginName,
      };
    case 'skill':
      return {
        kind: ref.kind,
        sourceId: ref.sourceId,
        skillName: ref.skillName,
      };
    case 'mcp-config':
      return { kind: ref.kind, serverId: ref.serverId, configId: ref.configId };
    case 'collection':
      return { kind: ref.kind, collectionId: ref.collectionId };
    case 'account-mcp':
      return { kind: ref.kind, connectionId: ref.connectionId };
  }
}

/** Versioned JSON encoding: separators and percent characters are ordinary data. */
export function installedItemKey(ref: InstalledItemRef): string {
  const value = normalizeInstalledItemRef(
    InstalledItemRefSchema.parse(withoutSelectionOwner(ref)),
  );
  switch (value.kind) {
    case 'plugin':
      return JSON.stringify([
        'v1',
        value.kind,
        value.marketplaceId,
        value.pluginName,
      ]);
    case 'skill':
      return JSON.stringify([
        'v1',
        value.kind,
        value.sourceId,
        value.skillName,
      ]);
    case 'collection':
      return JSON.stringify(['v1', value.kind, value.collectionId]);
    case 'mcp-config':
      return JSON.stringify(['v1', value.kind, value.serverId, value.configId]);
    case 'account-mcp':
      return JSON.stringify(['v1', value.kind, value.connectionId]);
  }
}

export function parseInstalledItemKey(key: string): InstalledItemRef | null {
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(key));
    if (!parsed.success || parsed.data[0] !== 'v1') return null;
    const parts = parsed.data;
    const [, kind, first, second] = parts;
    let candidate: unknown;
    switch (kind) {
      case 'plugin':
        candidate = { kind, marketplaceId: first, pluginName: second };
        break;
      case 'skill':
        candidate = { kind, sourceId: first, skillName: second };
        break;
      case 'collection':
        candidate = { kind, collectionId: first };
        break;
      case 'mcp-config':
        candidate = { kind, serverId: first, configId: second };
        break;
      case 'account-mcp':
        candidate = { kind, connectionId: first };
        break;
      default:
        return null;
    }
    const result = InstalledItemRefSchema.safeParse(candidate);
    return result.success && installedItemKey(result.data) === key
      ? result.data
      : null;
  } catch {
    return null;
  }
}

export function normalizeDisabledInstalledItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.flatMap((entry: unknown) => {
        const ref =
          typeof entry === 'string' ? parseInstalledItemKey(entry) : null;
        return ref && ref.kind !== 'mcp-config' && ref.kind !== 'account-mcp'
          ? [installedItemKey(ref)]
          : [];
      }),
    ),
  );
}

export function aggregateInstalledItemStatus(
  statuses: readonly InstalledItemStatus[],
): InstalledItemStatus | null {
  if (statuses.includes('active')) return 'active';
  if (statuses.includes('available')) return 'available';
  return statuses.length ? 'disabled' : null;
}

/** Resolve aliases only when the catalog identifies exactly one marketplace. */
export function canonicalInstalledItemRef(
  ref: InstalledItemRef,
  marketplaces: readonly {
    id: string;
    name?: string;
    providerStatus?: {
      claude?: { marketplaceName?: string };
      codex?: { marketplaceName?: string };
    };
  }[],
): InstalledItemRef {
  const normalized = normalizeInstalledItemRef(ref);
  if (normalized.kind !== 'plugin') return normalized;
  const exact = marketplaces.find(
    (entry) => entry.id === normalized.marketplaceId,
  );
  if (exact) return normalized;
  const matches = marketplaces.filter((entry) =>
    [
      entry.name,
      entry.providerStatus?.claude?.marketplaceName,
      entry.providerStatus?.codex?.marketplaceName,
    ].includes(normalized.marketplaceId),
  );
  return matches.length === 1
    ? { ...normalized, marketplaceId: matches[0].id }
    : normalized;
}

export interface InstalledItemSelections {
  collectionIds: string[];
  pluginRefs: Array<{ marketplaceId: string; pluginName: string }>;
  skillRefs: Array<{ sourceId: string; skillName: string }>;
  mcpServerRefs?: Array<{ serverId: string; configId: string }>;
}

export function excludeDisabledInstalledItems<
  T extends InstalledItemSelections,
>(selections: T, disabledKeys: readonly string[]): T {
  const disabled = new Set(disabledKeys);
  return {
    ...selections,
    collectionIds: selections.collectionIds.filter(
      (collectionId) =>
        !disabled.has(installedItemKey({ kind: 'collection', collectionId })),
    ),
    pluginRefs: selections.pluginRefs.filter(
      (ref) => !disabled.has(installedItemKey({ kind: 'plugin', ...ref })),
    ),
    skillRefs: selections.skillRefs.filter(
      (ref) => !disabled.has(installedItemKey({ kind: 'skill', ...ref })),
    ),
  };
}

export const InstalledItemNoticeSchema = z
  .object({
    code: z.enum([
      'provider_pending',
      'provider_unavailable',
      'session_recreation_required',
      'partial_removal',
    ]),
    provider: z.enum(['claude', 'codex']).optional(),
    message: z.string(),
    retryable: z.boolean(),
  })
  .strict();
export type InstalledItemNotice = z.infer<typeof InstalledItemNoticeSchema>;
export const InstalledItemSnapshotEntrySchema = z
  .object({
    target: InstalledItemTargetSchema,
    status: InstalledItemStatusSchema.nullable(),
    removable: z.boolean(),
    reason: z.string().optional(),
    uninstallDescription: z.string().optional(),
    uninstallTarget: InstalledItemUninstallTargetSchema.optional(),
    removalScope: z.enum(['item', 'device-server', 'account']).optional(),
    configurations: z.array(InstalledItemRefSchema).optional(),
    selectionRef: z
      .object({ serverId: identity, configId: identity })
      .strict()
      .optional(),
    notices: z.array(InstalledItemNoticeSchema),
  })
  .strict();
export const InstalledItemSnapshotSchema = z
  .object({ items: z.array(InstalledItemSnapshotEntrySchema) })
  .strict();
export type InstalledItemSnapshotEntry = z.infer<
  typeof InstalledItemSnapshotEntrySchema
>;
export type InstalledItemSnapshot = z.infer<typeof InstalledItemSnapshotSchema>;
export const SetInstalledItemStatusRequestSchema = z
  .object({
    target: InstalledItemTargetSchema,
    status: InstalledItemStatusSchema,
  })
  .strict();
export type SetInstalledItemStatusRequest = z.infer<
  typeof SetInstalledItemStatusRequestSchema
>;
export const UninstallInstalledItemRequestSchema = z
  .object({ target: InstalledItemUninstallTargetSchema })
  .strict();
export type UninstallInstalledItemRequest = z.infer<
  typeof UninstallInstalledItemRequestSchema
>;
export const InstalledItemMutationResultSchema = z
  .object({
    success: z.boolean(),
    requestedStatus: InstalledItemStatusSchema.optional(),
    snapshot: InstalledItemSnapshotSchema,
    removed: z.array(InstalledItemTargetSchema),
    errors: z.array(
      z
        .object({
          target: InstalledItemTargetSchema,
          code: z.string(),
          message: z.string(),
          retryable: z.boolean(),
          /**
           * The host removed this device MCP server before a later cleanup
           * step failed. Absent means the server's removal is unconfirmed.
           */
          serverRemoved: z.literal(true).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type InstalledItemMutationResult = z.infer<
  typeof InstalledItemMutationResultSchema
>;

/** Installed identities only. Catalog rows without an exact binding stay read-only. */
export function installedItemTargetForEntry(
  ref: UnifiedEntryRef,
  snapshot: InstalledItemSnapshot,
  bindings: readonly {
    entry: UnifiedEntryRef;
    target: InstalledItemTarget;
  }[] = [],
): { target: InstalledItemTarget } | { reason: string } {
  const bound = bindings.find(
    (binding) => JSON.stringify(binding.entry) === JSON.stringify(ref),
  );
  let target: InstalledItemTarget | undefined = bound?.target;
  if (!target)
    switch (ref.type) {
      case 'marketplace-plugin':
        target = {
          kind: 'plugin',
          marketplaceId: ref.marketplaceId,
          pluginName: ref.pluginName.toLowerCase(),
        };
        break;
      case 'skill':
        target = {
          kind: 'skill',
          sourceId: ref.sourceId,
          skillName: ref.skillName,
        };
        break;
      case 'local-collection':
        target = { kind: 'collection', collectionId: ref.collectionId };
        break;
      case 'local-mcp':
      case 'mcp-server': {
        const configId = ref.configId;
        const account = snapshot.items.filter(
          (item) =>
            item.target.kind === 'account-mcp' &&
            item.selectionRef?.serverId === ref.serverId &&
            (configId === undefined || item.selectionRef.configId === configId),
        );
        if (account.length === 1) target = account[0].target;
        else if (!account.length)
          target = configId
            ? { kind: 'mcp-config', serverId: ref.serverId, configId }
            : { kind: 'mcp-server', serverId: ref.serverId };
        break;
      }
    }
  const candidate = target;
  if (
    candidate &&
    snapshot.items.some((item) =>
      candidate.kind === 'mcp-server'
        ? item.target.kind === 'mcp-server' &&
          item.target.serverId === candidate.serverId
        : item.target.kind !== 'mcp-server' &&
          installedItemKey(item.target) === installedItemKey(candidate),
    )
  )
    return { target: candidate };
  return {
    reason:
      "This item can't be matched to one installed copy, so its status can't be shown here.",
  };
}

/** Count server aggregates, not their individual configurations or selections. */
export function summarizeInstalledMcpServers(snapshot: InstalledItemSnapshot): {
  installed: number;
  active: number;
} {
  const installed = new Set<string>();
  const active = new Set<string>();
  for (const item of snapshot.items) {
    const ref = item.target;
    let key: string;
    if (ref.kind === 'mcp-server') key = `device:${ref.serverId}`;
    else if (ref.kind === 'account-mcp')
      key = `account:${item.selectionRef?.serverId ?? ref.connectionId}`;
    else continue;
    installed.add(key);
    if (item.status === 'active') active.add(key);
  }
  return { installed: installed.size, active: active.size };
}

export function countActiveInstalledItems(snapshot: InstalledItemSnapshot): {
  plugins: number;
  skills: number;
  collections: number;
  mcpServers: number;
} {
  const plugins = new Set<string>();
  const skills = new Set<string>();
  const collections = new Set<string>();
  const mcpServers = new Set<string>();
  for (const item of snapshot.items) {
    if (item.status !== 'active') continue;
    const ref = item.target;
    if (ref.kind === 'plugin') plugins.add(installedItemKey(ref));
    else if (ref.kind === 'skill') skills.add(installedItemKey(ref));
    else if (ref.kind === 'collection') collections.add(ref.collectionId);
    else if (ref.kind === 'mcp-server')
      mcpServers.add(`device:${ref.serverId}`);
    else if (ref.kind === 'account-mcp')
      mcpServers.add(
        `account:${item.selectionRef?.serverId ?? ref.connectionId}`,
      );
  }
  return {
    plugins: plugins.size,
    skills: skills.size,
    collections: collections.size,
    mcpServers: mcpServers.size,
  };
}
