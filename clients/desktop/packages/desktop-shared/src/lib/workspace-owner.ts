import { normalizeWorkspaceOwner } from '@canopy/execution-engine/lib/workspace-owner';
import type { WorkspaceDetachedOwner } from '../types';

export * from '@canopy/execution-engine/lib/workspace-owner';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTimestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

/** Historical ownership is never an authorization or configuration source. */
export function normalizeWorkspaceDetachedOwner(
  value: unknown,
): WorkspaceDetachedOwner | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.reason !== 'organization-access-lost'
  )
    return undefined;
  const owner = normalizeWorkspaceOwner(value.owner);
  const detachedAt = readTimestamp(value.detachedAt);
  if (
    !owner ||
    !detachedAt ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      detachedAt,
    )
  )
    return undefined;
  // Date.parse accepts overflowing calendar dates such as February 30.
  const day = detachedAt.slice(0, 10);
  if (new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day)
    return undefined;
  return { version: 1, owner, reason: 'organization-access-lost', detachedAt };
}
