/**
 * Which of the workspace cases in the connectors spec (FR-2.3) a chat or run
 * is in, for connector selection (CAN-6231):
 *
 * | Workspace                            | Scope           |
 * | ------------------------------------ | --------------- |
 * | Org project with a project id        | `org-project`   |
 * | Org-owned workspace, no project id   | `org-workspace` |
 * | Personal workspace linked to an org  | `personal`      |
 * | Personal workspace                   | `personal`      |
 *
 * On desktop a chat's `projectId` is usually the local workspace id; the
 * organization project is the owner binding's `projectId`, a tracked
 * workspace external id, carried here as `orgProjectId`.
 */
export type ConnectorScope =
  | {
      readonly kind: 'org-project';
      readonly organizationId: string;
      readonly orgProjectId: string;
    }
  | {
      readonly kind: 'org-workspace';
      /** Absent when the owner could not be read at all. */
      readonly organizationId?: string;
    }
  | { readonly kind: 'personal' };

/** A workspace's persisted ownership, as `readWorkspaceOwnership` reads it. */
export type ConnectorScopeOwnership =
  | {
      readonly authority: 'ok';
      readonly owner?: {
        readonly type: 'organization';
        readonly organizationId: string;
        readonly projectId?: string;
      };
    }
  | { readonly authority: 'absent' | 'unreadable' };

/** Personal: no workspace, or one with no organization owner. */
export const PERSONAL_CONNECTOR_SCOPE: ConnectorScope = { kind: 'personal' };

/**
 * The connector scope of a workspace from its persisted ownership. A Personal
 * workspace linked to an organization has no owner binding, so it is
 * Personal, as the spec says. An owner that cannot be read is the
 * organization case it cannot rule out, with no project: the stricter rules
 * apply and no project-level ones, never Personal's. A missing workspace is
 * work outside any workspace, so Personal.
 */
export function connectorScopeForOwnership(
  read: ConnectorScopeOwnership,
): ConnectorScope {
  if (read.authority !== 'ok')
    return read.authority === 'absent'
      ? PERSONAL_CONNECTOR_SCOPE
      : { kind: 'org-workspace' };
  const owner = read.owner;
  if (owner?.type !== 'organization') return PERSONAL_CONNECTOR_SCOPE;
  return owner.projectId
    ? {
        kind: 'org-project',
        organizationId: owner.organizationId,
        orgProjectId: owner.projectId,
      }
    : { kind: 'org-workspace', organizationId: owner.organizationId };
}
