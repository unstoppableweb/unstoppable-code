import type { DelegationCapabilityKind } from '@canopy/protocol/delegation';
import type { CapabilityItemRef } from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import {
  buildDeferredToolsCatalog,
  encodeDeferredCatalogRef,
  encodeMcpRef,
  encodePluginRef,
  encodeSkillRef,
  type DeferredCatalogItemStatus,
} from '../../deferred-tools/catalog';

/** Deferred-catalog identity string of a capability ref. */
export function delegationCapabilityIdentity(ref: CapabilityItemRef): string {
  if (ref.kind === 'skill') return encodeSkillRef(ref.sourceId, ref.skillName);
  if (ref.kind === 'plugin')
    return encodePluginRef(ref.marketplaceId, ref.pluginName);
  return encodeMcpRef(ref.serverId, ref.configId);
}

/**
 * Delegation capability ID: the deferred-tools catalog ref of the item
 * (`deferred:v1:<base64url sha256>`), so one ID works for List Delegates,
 * spawn `capabilities`, and Search/Load Deferred Tools.
 */
export function delegationCapabilityIdForIdentity(identityRef: string): string {
  return encodeDeferredCatalogRef(identityRef);
}

export function delegationCapabilityIdForRef(ref: CapabilityItemRef): string {
  return delegationCapabilityIdForIdentity(delegationCapabilityIdentity(ref));
}

/**
 * Case-insensitive plugin identity, matching how selections resolve plugins.
 * Use it to compare refs; use the ID for public identity.
 */
export function delegationCapabilityRefKey(ref: CapabilityItemRef): string {
  if (ref.kind === 'skill') return `skill\0${ref.sourceId}\0${ref.skillName}`;
  if (ref.kind === 'plugin')
    return `plugin\0${ref.marketplaceId}\0${ref.pluginName.toLowerCase()}`;
  return `mcp\0${ref.serverId}\0${ref.configId}`;
}

export interface DelegationCapabilityCatalogItem {
  readonly id: string;
  readonly kind: DelegationCapabilityKind;
  readonly name: string;
  readonly description: string;
  readonly ref: CapabilityItemRef;
  /** Deferred catalog status for the child's harness. */
  readonly status: DeferredCatalogItemStatus;
  /** Safe display copy explaining an unsupported or disabled status. */
  readonly reason?: string;
}

export interface DelegationCapabilityCatalog {
  readonly items: readonly DelegationCapabilityCatalogItem[];
  readonly byId: ReadonlyMap<string, DelegationCapabilityCatalogItem>;
}

/**
 * The installed skills, provider-compatible plugins and enabled MCP servers
 * of the deferred-tools catalog, keyed by delegation capability ID.
 */
export async function loadDelegationCapabilityCatalog(
  harness:
    | 'claude'
    | 'codex'
    | 'cursor'
    | 'copilot'
    | 'antigravity'
    | 'opencode',
): Promise<DelegationCapabilityCatalog> {
  const catalog = await buildDeferredToolsCatalog({
    provider:
      harness === 'antigravity' ||
      harness === 'cursor' ||
      harness === 'copilot' ||
      harness === 'opencode'
        ? 'claude'
        : harness,
  });
  const items: DelegationCapabilityCatalogItem[] = [];
  for (const item of catalog.items) {
    const additions = catalog.additionsFor([item]);
    const skill = additions.skillRefs[0];
    const plugin = additions.pluginRefs[0];
    const mcp = additions.mcpServerRefs[0];
    const ref: CapabilityItemRef | undefined =
      item.kind === 'skill' && skill
        ? { kind: 'skill', ...skill }
        : item.kind === 'plugin' && plugin
          ? { kind: 'plugin', ...plugin }
          : item.kind === 'mcp' && mcp
            ? { kind: 'mcp', ...mcp }
            : undefined;
    if (!ref) continue;
    items.push(
      Object.freeze({
        id: item.ref,
        kind: item.kind,
        name: item.name,
        description: item.description,
        ref: Object.freeze(ref),
        status: item.status,
        ...(item.reason &&
        (item.status === 'unsupported' || item.status === 'disabled')
          ? { reason: item.reason }
          : {}),
      }),
    );
  }
  return Object.freeze({
    items: Object.freeze(items),
    byId: new Map(items.map((item) => [item.id, item])),
  });
}
