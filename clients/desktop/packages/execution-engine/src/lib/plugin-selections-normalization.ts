// ---------------------------------------------------------------------------
// Canonical normalization for {@link ChatTabPluginSelections}.
//
// Both the renderer and the main process consume this helper so the
// "Bundles → Collections" migration goes through a single code path. Every
// load site that touches persisted plugin selections must funnel through
// `normalizePluginSelections` so legacy `bundleIds` reliably becomes
// `collectionIds` on output.
//
// On persist:
//   - writes ONLY `collectionIds`
//   - drops the deprecated `bundleIds` field entirely
//
// On read:
//   - accepts either or both of `collectionIds` and `bundleIds`
//   - merges + de-duplicates them into the canonical `collectionIds`
//
// This module is intentionally framework-free: it is a pure data transform
// that runs on both Node and the browser without IO.
// ---------------------------------------------------------------------------

import {
  isTryItCapabilityArray,
  normalizeTryItCapabilities,
} from '@canopy/protocol/try-it';
import { BRAND } from '@canopy/brand/current';
import {
  readSelectionRefOwner,
  selectionRefOwnerKey,
  withSelectionRefOwner,
} from '@canopy/protocol/plugins';
import type { ChatTabPluginSelections } from '../execution-types';
import type {
  McpHttpAuthHandler,
  McpHttpAuthPreference,
} from '../types/mcp-servers';

export type ChatTabPluginSelectionsReadInput = Omit<
  ChatTabPluginSelections,
  'collectionIds'
> & { collectionIds?: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isRefArray(
  value: unknown,
  firstKey: string,
  secondKey: string,
): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry[firstKey] === 'string' &&
        entry[firstKey].trim().length > 0 &&
        typeof entry[secondKey] === 'string' &&
        entry[secondKey].trim().length > 0 &&
        readSelectionRefOwner(entry).ok,
    )
  );
}

function isSafeReferenceSegment(value: string): boolean {
  return (
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}

function normalizeSkillSourceId(sourceId: string): string | undefined {
  if (!sourceId) {
    return undefined;
  }
  if (
    sourceId === 'builtin' ||
    sourceId === 'builtin:app' ||
    sourceId === 'builtin/app' ||
    sourceId === `builtin:${BRAND.internalName}` ||
    sourceId === `builtin/${BRAND.internalName}`
  ) {
    return 'builtin:app';
  }
  return isSafeReferenceSegment(sourceId) ? sourceId : undefined;
}

function isSkillRefArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (
        !isRecord(entry) ||
        typeof entry.sourceId !== 'string' ||
        typeof entry.skillName !== 'string'
      ) {
        return false;
      }
      const sourceId = entry.sourceId.trim();
      const skillName = entry.skillName.trim();
      return (
        normalizeSkillSourceId(sourceId) !== undefined &&
        skillName.length > 0 &&
        isSafeReferenceSegment(skillName) &&
        readSelectionRefOwner(entry).ok
      );
    })
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    result.push(trimmed);
  }
  return result;
}

function normalizeSkillRefs(
  value: unknown,
): ChatTabPluginSelections['skillRefs'] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: ChatTabPluginSelections['skillRefs'] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const rawSourceId =
      typeof entry.sourceId === 'string' ? entry.sourceId.trim() : '';
    const sourceId = normalizeSkillSourceId(rawSourceId);
    const skillName =
      typeof entry.skillName === 'string' ? entry.skillName.trim() : '';
    const owner = readSelectionRefOwner(entry);
    if (
      sourceId === undefined ||
      !skillName ||
      !isSafeReferenceSegment(skillName) ||
      !owner.ok
    ) {
      continue;
    }
    const key = `${sourceId}\0${skillName}\0${selectionRefOwnerKey(owner.owner)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(withSelectionRefOwner({ sourceId, skillName }, owner.owner));
  }
  return result;
}

function normalizePluginRefs(
  value: unknown,
): ChatTabPluginSelections['pluginRefs'] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: ChatTabPluginSelections['pluginRefs'] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const marketplaceId =
      typeof entry.marketplaceId === 'string' ? entry.marketplaceId.trim() : '';
    const pluginName =
      typeof entry.pluginName === 'string' ? entry.pluginName.trim() : '';
    const owner = readSelectionRefOwner(entry);
    if (!marketplaceId || !pluginName || !owner.ok) continue;
    const key = `${marketplaceId}\0${pluginName}\0${selectionRefOwnerKey(owner.owner)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(
      withSelectionRefOwner({ marketplaceId, pluginName }, owner.owner),
    );
  }
  return result;
}

function normalizeMcpServerRefs(
  value: unknown,
): NonNullable<ChatTabPluginSelections['mcpServerRefs']> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: NonNullable<ChatTabPluginSelections['mcpServerRefs']> = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const serverId =
      typeof entry.serverId === 'string' ? entry.serverId.trim() : '';
    const configId =
      typeof entry.configId === 'string' ? entry.configId.trim() : '';
    const owner = readSelectionRefOwner(entry);
    if (
      !serverId ||
      !isSafeReferenceSegment(serverId) ||
      !configId ||
      !owner.ok
    ) {
      continue;
    }
    const key = `${serverId}\0${configId}\0${selectionRefOwnerKey(owner.owner)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(withSelectionRefOwner({ serverId, configId }, owner.owner));
  }
  return result;
}

function isMcpServerRefArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.serverId === 'string' &&
        entry.serverId.trim().length > 0 &&
        isSafeReferenceSegment(entry.serverId) &&
        typeof entry.configId === 'string' &&
        entry.configId.trim().length > 0 &&
        readSelectionRefOwner(entry).ok,
    )
  );
}

const VALID_HANDLERS: ReadonlySet<string> = new Set([
  'canopy',
  'provider',
  'account',
]);

function isMcpHttpAuthHandler(value: unknown): value is McpHttpAuthHandler {
  return typeof value === 'string' && VALID_HANDLERS.has(value);
}

function normalizeAuthPreferences(value: unknown): McpHttpAuthPreference[] {
  if (!Array.isArray(value)) return [];
  const result: McpHttpAuthPreference[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { target, handler } = entry;
    if (!isMcpHttpAuthHandler(handler)) continue;
    if (!isRecord(target)) continue;
    if (target.kind === 'standalone') {
      if (
        typeof target.serverId !== 'string' ||
        typeof target.configId !== 'string'
      ) {
        continue;
      }
      result.push({
        target: {
          kind: 'standalone',
          serverId: target.serverId,
          configId: target.configId,
        },
        handler,
      });
      continue;
    }
    if (target.kind === 'plugin') {
      if (
        typeof target.marketplaceId !== 'string' ||
        typeof target.pluginName !== 'string' ||
        typeof target.serverName !== 'string'
      ) {
        continue;
      }
      result.push({
        target: {
          kind: 'plugin',
          marketplaceId: target.marketplaceId,
          pluginName: target.pluginName,
          serverName: target.serverName,
        },
        handler,
      });
      continue;
    }
  }
  return result;
}

/**
 * Single source of truth for migrating persisted / inbound
 * {@link ChatTabPluginSelections} into the canonical Collections-first shape.
 *
 * Accepts arbitrary input (typically a parsed JSON blob or a strongly-typed
 * selections object) and returns a fresh selections object whose:
 *
 *   - `collectionIds` is the de-duplicated union of `input.collectionIds`
 *     and the legacy `input.bundleIds`. Order follows the input
 *     (`collectionIds` first, then any legacy ids not already present).
 *   - `bundleIds` is intentionally absent from the result. Persisters must
 *     write only the canonical output of this helper.
 *   - `skillRefs`, `pluginRefs`, `mcpServerRefs`, and
 *     `mcpHttpAuthPreferences` are each independently sanitized so corrupt
 *     entries are dropped without breaking the whole selections object.
 *
 * The result is deterministic for a given input; callers can rely on it for
 * stable hashes / equality checks.
 */
export function normalizePluginSelections(
  input: unknown,
): ChatTabPluginSelections {
  const source = isRecord(input) ? input : {};
  const collectionIds = arrayOfStrings(source.collectionIds);
  const legacyBundleIds = arrayOfStrings(source.bundleIds);
  const skillRefs = normalizeSkillRefs(source.skillRefs);
  const pluginRefs = normalizePluginRefs(source.pluginRefs);
  const mcpServerRefs =
    source.mcpServerRefs === undefined
      ? undefined
      : normalizeMcpServerRefs(source.mcpServerRefs);
  const mcpHttpAuthPreferences =
    source.mcpHttpAuthPreferences === undefined
      ? undefined
      : normalizeAuthPreferences(source.mcpHttpAuthPreferences);
  const merged = uniqueStrings([...collectionIds, ...legacyBundleIds]);
  const result: ChatTabPluginSelections = {
    collectionIds: merged,
    skillRefs,
    pluginRefs,
  };
  if (mcpServerRefs !== undefined) {
    result.mcpServerRefs = mcpServerRefs;
  }
  if (mcpHttpAuthPreferences !== undefined) {
    result.mcpHttpAuthPreferences = mcpHttpAuthPreferences;
  }
  if (
    isTryItCapabilityArray(source.unresolvedCapabilities) &&
    source.unresolvedCapabilities.length > 0
  ) {
    result.unresolvedCapabilities = normalizeTryItCapabilities(
      source.unresolvedCapabilities,
    );
  }
  return result;
}

/**
 * Strict structural guard for persisted or IPC-provided chat plugin
 * selections. Unlike {@link normalizePluginSelections}, this does not repair
 * malformed input; callers can use it at trust boundaries before normalizing.
 */
export function isChatTabPluginSelections(
  input: unknown,
): input is ChatTabPluginSelectionsReadInput {
  if (!isRecord(input)) return false;
  if (
    input.unresolvedCapabilities !== undefined &&
    !isTryItCapabilityArray(input.unresolvedCapabilities)
  )
    return false;
  if (input.collectionIds === undefined && input.bundleIds === undefined) {
    return false;
  }
  if (
    input.collectionIds !== undefined &&
    !isStringArray(input.collectionIds)
  ) {
    return false;
  }
  if (input.bundleIds !== undefined && !isStringArray(input.bundleIds)) {
    return false;
  }
  if (!isSkillRefArray(input.skillRefs)) return false;
  if (!isRefArray(input.pluginRefs, 'marketplaceId', 'pluginName'))
    return false;
  if (
    input.mcpServerRefs !== undefined &&
    !isMcpServerRefArray(input.mcpServerRefs)
  ) {
    return false;
  }
  if (input.mcpHttpAuthPreferences !== undefined) {
    if (!Array.isArray(input.mcpHttpAuthPreferences)) return false;
    const normalized = normalizeAuthPreferences(input.mcpHttpAuthPreferences);
    if (normalized.length !== input.mcpHttpAuthPreferences.length) return false;
  }
  return true;
}

/**
 * Convenience helper that returns an empty, canonical
 * {@link ChatTabPluginSelections} object. Use this anywhere that previously
 * spelled out `{ bundleIds: [], skillRefs: [], pluginRefs: [] }`.
 */
export function emptyPluginSelections(): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
  };
}

/** Count concrete selections after applying read-side legacy normalization. */
export function countPluginSelections(input: unknown): number {
  const selections = normalizePluginSelections(input);
  return (
    selections.collectionIds.length +
    selections.skillRefs.length +
    selections.pluginRefs.length +
    (selections.unresolvedCapabilities?.length ?? 0) +
    (selections.mcpServerRefs?.length ?? 0)
  );
}
