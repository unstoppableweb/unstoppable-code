import type { WorktreeActionRuntime } from './worktree-actions';
import { z } from 'zod';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import type {
  CapabilityItemKind,
  CapabilityReferenceArtifactReceiptV1,
} from '@canopy/protocol/agent-artifacts';
import { normalizeCapabilityHttpsUrl } from '@canopy/protocol/agent-artifacts';
import {
  buildCapabilityReferenceArtifactReceipt,
  mergeLatestAgentArtifacts,
} from '@canopy/desktop-shared/lib/agent-artifacts';

export const SHOW_CAPABILITIES_DESCRIPTION =
  'Show capability recommendation tiles in this chat when recommending skills, pipelines, automations, agents, plugins, MCP servers or collections. Supply a source-qualified id (such as local:<id> or shared:<id>) or an unambiguous name. For installed skills use builtin:app/canopy-pipeline-writing (also accepted: builtin:app:canopy-pipeline-writing); for plugin skills use superpowers:writing-plans or the full plugin:<marketplaceId>/<pluginName>:<skillName> ID. IDs are case-sensitive, never fall back to names, and fail on misses or observed collisions; partial inventories cannot prove global uniqueness of short locators, so prefer full IDs for disambiguation. Names are case-insensitive, with exact matches before prefixes and installed entries preferred within that pool; same-tier duplicates are ambiguous. Installed exact names require a complete installed tier; available exact names and all prefixes require both tiers complete. HTTPS URLs are labelled External and are not fetched or verified. Returns partial success and unresolved items when relevant inventories are incomplete.';
export const capabilityItemKinds = [
  'skill',
  'pipeline',
  'automation',
  'agent',
  'plugin',
  'mcp-server',
  'collection',
] as const;
const itemSchema = z
  .object({
    kind: z.enum(capabilityItemKinds),
    id: z.string().trim().min(1).max(512).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    url: z.string().trim().min(1).max(512).optional(),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
export const showCapabilitiesSchema = z
  .object({ items: z.array(itemSchema).min(1).max(8) })
  .strict();
export const showCapabilitiesJsonSchema = z.toJSONSchema(
  showCapabilitiesSchema,
) as unknown as JsonValue;
export type CapabilityTier = 'installed' | 'available';
export type CapabilityCandidate = Omit<
  CapabilityReferenceArtifactReceiptV1,
  | 'version'
  | 'kind'
  | 'operation'
  | 'dedupeKey'
  | 'aliases'
  | 'createdAt'
  | 'relation'
  | 'reason'
> & {
  /** Exact source-qualified locator advertised to the agent. */
  id: string;
  /** Lookup-only spellings; never receipt aliases or deduplication identities. */
  locators?: string[];
};
export interface CapabilityInventory {
  items: CapabilityCandidate[];
  /** An inaccessible or bounded source means absence cannot prove not-found. */
  unavailable?: boolean;
  /** Explicit tier completeness overrides the legacy coarse flag, including []. */
  partialTiers?: ReadonlyArray<CapabilityTier>;
}
export type CapabilityInventoryReader = (
  kind: CapabilityItemKind,
) => Promise<CapabilityInventory>;

export async function resolveCapabilities(
  rawArgs: unknown,
  readInventory: CapabilityInventoryReader,
): Promise<{
  text: string;
  isError: boolean;
}> {
  const parsed = showCapabilitiesSchema.safeParse(rawArgs);
  if (!parsed.success)
    return {
      isError: true,
      text: JSON.stringify({
        ok: false,
        error: {
          code: 'validation_failed',
          message: 'Provide 1–8 capability items with bounded locators.',
        },
      }),
    };
  const inventories = new Map<
    CapabilityItemKind,
    Promise<CapabilityInventory>
  >();
  const inventory = (
    kind: CapabilityItemKind,
  ): Promise<CapabilityInventory> => {
    let pending = inventories.get(kind);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => readInventory(kind))
        .then(
          (source): CapabilityInventory => ({
            ...source,
            partialTiers:
              source.partialTiers ??
              (source.unavailable ? ['installed', 'available'] : []),
          }),
        )
        .catch(() => ({
          items: [],
          unavailable: true,
          partialTiers: ['installed', 'available'] as const,
        }));
      inventories.set(kind, pending);
    }
    return pending;
  };
  const resolved = await Promise.all(
    parsed.data.items.map(async (item, index) => {
      const unresolved = (
        reason:
          | 'ambiguous'
          | 'not_found'
          | 'unavailable_source'
          | 'invalid_locator',
      ): {
        unresolved: { index: number; kind: CapabilityItemKind; reason: string };
      } => ({ unresolved: { index, kind: item.kind, reason } });
      if ((item.id && item.url) || (!item.id && !item.url && !item.name))
        return unresolved('invalid_locator');
      if (item.url) {
        const url = normalizeCapabilityHttpsUrl(item.url);
        if (!url) return unresolved('invalid_locator');
        return {
          receipt: buildCapabilityReferenceArtifactReceipt({
            operation: 'show_capabilities',
            itemKind: item.kind,
            source: 'external',
            sourceId: url,
            name: item.name ?? new URL(url).hostname,
            sourceLabel: 'External',
            state: 'unknown',
            relation: 'recommended',
            reason: item.reason,
            navigationTarget: { kind: 'external_url', url },
          }),
        };
      }
      const source = await inventory(item.kind);
      const entries = source.items
        .filter((entry) => entry.itemKind === item.kind)
        .slice(0, 2000);
      const partialTiers = source.partialTiers ?? [];
      const partial = partialTiers.length > 0;
      let exact = true;
      let matches: CapabilityCandidate[];
      if (item.id)
        matches = entries.filter(
          (entry) =>
            entry.id === item.id ||
            entry.sourceId === item.id ||
            entry.locators?.includes(item.id ?? ''),
        );
      else {
        const query = (item.name ?? '').toLocaleLowerCase('en-US');
        matches = entries.filter(
          (entry) =>
            entry.name.toLocaleLowerCase('en-US') === query ||
            entry.locators?.some(
              (locator) => locator.toLocaleLowerCase('en-US') === query,
            ),
        );
        if (!matches.length) {
          exact = false;
          matches = entries.filter((entry) =>
            entry.name.toLocaleLowerCase('en-US').startsWith(query),
          );
        }
        const installed = matches.filter(
          (entry) => entry.state === 'installed',
        );
        if (installed.length) matches = installed;
      }
      if (matches.length > 1) return unresolved('ambiguous');
      const match = matches[0];
      if (!match)
        return unresolved(partial ? 'unavailable_source' : 'not_found');
      if (
        !item.id &&
        (exact && match.state === 'installed'
          ? partialTiers.includes('installed')
          : partial)
      )
        return unresolved('unavailable_source');
      try {
        return {
          receipt: buildCapabilityReferenceArtifactReceipt({
            ...match,
            operation: 'show_capabilities',
            relation: 'recommended',
            reason: item.reason,
          }),
        };
      } catch {
        // A stale or malformed source row must not discard other recommendations.
        return unresolved('unavailable_source');
      }
    }),
  );
  const receipts = resolved.flatMap((entry) =>
    'receipt' in entry ? [entry.receipt] : [],
  );
  return {
    isError: false,
    text: JSON.stringify({
      ok: true,
      result: {
        agentArtifacts: mergeLatestAgentArtifacts([], receipts),
        unresolved: resolved.flatMap((entry) =>
          'unresolved' in entry ? [entry.unresolved] : [],
        ),
      },
    }),
  };
}

export async function executeShowCapabilities(
  rawArgs: unknown,
  scope?: WorktreeActionRuntime,
): Promise<{ text: string; isError: boolean }> {
  const { readCapabilityInventory } = await import('./capability-inventory');
  return resolveCapabilities(rawArgs, (kind) =>
    readCapabilityInventory(kind, scope),
  );
}
