import { z } from 'zod';

// ---------------------------------------------------------------------------
// Whose item a saved selection ref points at (CAN-6235).
//
// A skill, plugin or MCP server ref names its item by two fields, such as
// `{ serverId: 'slack', configId: 'default' }`. While each person only sees
// their own selections that is enough. Once a project's setup is shared, the
// same two fields would load a different item for each reader, so a ref to an
// organization's item also names the organization.
//
// A ref with no owner is the person's own: every selection saved before this
// field existed, and every ref a person picks from their own items. Owners are
// part of a ref's identity, so a personal and an organization ref of one item
// sit side by side, and removing one leaves the other.
// ---------------------------------------------------------------------------

export interface OrganizationSelectionRefOwner {
  type: 'organization';
  organizationId: string;
}

export type SelectionRefOwner = OrganizationSelectionRefOwner;

const ORGANIZATION_ID_MAX_LENGTH = 256;

export const SelectionRefOwnerSchema = z.strictObject({
  type: z.literal('organization'),
  organizationId: z.string().min(1).max(ORGANIZATION_ID_MAX_LENGTH),
});

/**
 * Reads the `owner` field of a persisted or received ref.
 *
 * - `{ ok: true, owner: undefined }`: no owner field, the person's own item.
 * - `{ ok: true, owner }`: an organization's item.
 * - `{ ok: false }`: an owner field that is present but malformed. Callers
 *   drop the ref: reading it as the person's own could point a ref meant for
 *   an organization's item at a personal one.
 */
export function readSelectionRefOwner(
  entry: Readonly<Record<string, unknown>>,
): { ok: true; owner: SelectionRefOwner | undefined } | { ok: false } {
  if (entry.owner === undefined) {
    return { ok: true, owner: undefined };
  }
  const parsed = SelectionRefOwnerSchema.safeParse(entry.owner);
  if (!parsed.success) return { ok: false };
  const organizationId = parsed.data.organizationId.trim();
  if (!organizationId) return { ok: false };
  return { ok: true, owner: { type: 'organization', organizationId } };
}

/** The owner part of a ref's identity key; empty for the person's own. */
export function selectionRefOwnerKey(
  owner: SelectionRefOwner | undefined,
): string {
  return owner ? `organization:${owner.organizationId}` : '';
}

/** Whether two refs' owners are the same owner (both absent counts). */
export function sameSelectionRefOwner(
  a: SelectionRefOwner | undefined,
  b: SelectionRefOwner | undefined,
): boolean {
  return selectionRefOwnerKey(a) === selectionRefOwnerKey(b);
}

/**
 * Adds `owner` to a rebuilt ref only when there is one, so refs without an
 * owner keep their exact persisted shape.
 */
export function withSelectionRefOwner<Ref extends object>(
  ref: Ref,
  owner: SelectionRefOwner | undefined,
): Ref & { owner?: SelectionRefOwner } {
  return owner ? { ...ref, owner } : ref;
}
