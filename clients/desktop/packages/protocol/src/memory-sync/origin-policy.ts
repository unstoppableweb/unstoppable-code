import type { MemoryScopeKind } from './records';

/**
 * The organizations that keep a scope's notes off the cloud (design §10.4,
 * D17). Only a user scope's notes follow their origin's policy: a project
 * scope belongs to its organization already.
 */
export interface MemoryOriginPolicy {
  readonly scopeKind: MemoryScopeKind;
  readonly blockedOriginOrganizationIds: ReadonlySet<string>;
}

/**
 * Whether a note saved in `originOrganizationId` must stay off the cloud:
 * not sent, and not read by any consolidation or merge whose result the
 * cloud keeps. Cloud consolidation, a device's leased consolidation and a
 * first enable's merge all select their notes with this rule, so a note the
 * sweep has not withheld yet is left out the same way everywhere.
 */
export function isMemoryNoteOriginBlocked(
  policy: MemoryOriginPolicy,
  originOrganizationId: string | null,
): boolean {
  return (
    policy.scopeKind === 'user' &&
    originOrganizationId !== null &&
    policy.blockedOriginOrganizationIds.has(originOrganizationId)
  );
}
