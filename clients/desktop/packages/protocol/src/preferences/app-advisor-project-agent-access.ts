import type { WorkspaceContextOrganization } from '../workspace-context';
import type {
  AppAdvisorProjectAgentAccess,
  ProjectOwnerContext,
} from './types';

/** Default when the preference is absent or invalid: every owner is allowed. */
export const DEFAULT_APP_ADVISOR_PROJECT_AGENT_ACCESS: AppAdvisorProjectAgentAccess =
  Object.freeze({ mode: 'enabled', selectedOwners: [] });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOwner(value: unknown): ProjectOwnerContext | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'personal') return { kind: 'personal' };
  if (
    value.kind === 'organization' &&
    typeof value.organizationId === 'string' &&
    value.organizationId.trim().length > 0
  ) {
    return {
      kind: 'organization',
      organizationId: value.organizationId.trim(),
    };
  }
  return null;
}

function ownerKey(owner: ProjectOwnerContext): string {
  return owner.kind === 'personal'
    ? 'personal'
    : `organization:${owner.organizationId}`;
}

/**
 * Normalize a stored or submitted access preference. Missing or invalid input
 * yields the Enabled default; invalid and duplicate owners are dropped.
 */
export function normalizeAppAdvisorProjectAgentAccess(
  value: unknown,
): AppAdvisorProjectAgentAccess {
  if (!isRecord(value)) {
    return { ...DEFAULT_APP_ADVISOR_PROJECT_AGENT_ACCESS, selectedOwners: [] };
  }
  const mode =
    value.mode === 'disabled' || value.mode === 'selected-owners'
      ? value.mode
      : value.mode === 'enabled'
        ? 'enabled'
        : null;
  if (mode === null) {
    return { ...DEFAULT_APP_ADVISOR_PROJECT_AGENT_ACCESS, selectedOwners: [] };
  }
  const seen = new Set<string>();
  const selectedOwners: ProjectOwnerContext[] = [];
  for (const candidate of Array.isArray(value.selectedOwners)
    ? value.selectedOwners
    : []) {
    const owner = normalizeOwner(candidate);
    if (!owner) continue;
    const key = ownerKey(owner);
    if (seen.has(key)) continue;
    seen.add(key);
    selectedOwners.push(owner);
  }
  return { mode, selectedOwners };
}

/**
 * Whether the saved setting allows code and cowork agents of a project with
 * this saved owner to use App Advisor tools and App Advisor prompt
 * automations. Selected organizations match by exact ID; callers also require
 * that the signed-in account is still a member of a selected organization.
 */
export function isProjectOwnerAllowedAppAdvisorAccess(
  access: AppAdvisorProjectAgentAccess,
  owner: ProjectOwnerContext,
): boolean {
  if (access.mode === 'enabled') return true;
  if (access.mode === 'disabled') return false;
  const key = ownerKey(owner);
  return access.selectedOwners.some((selected) => ownerKey(selected) === key);
}

/** One owner choice shown by the project-agent access setting. */
export interface AppAdvisorProjectAgentAccessOwnerOption {
  readonly owner: ProjectOwnerContext;
  readonly label: string;
}

interface OrganizationOptionCandidate {
  readonly organization: WorkspaceContextOrganization;
  readonly label: string;
}

function compareOrganizationOptions(
  left: OrganizationOptionCandidate,
  right: OrganizationOptionCandidate,
): number {
  const nameComparison = left.label.localeCompare(right.label, undefined, {
    sensitivity: 'base',
  });
  if (nameComparison !== 0) return nameComparison;

  const idComparison = left.organization.id.localeCompare(
    right.organization.id,
  );
  if (idComparison !== 0) return idComparison;

  if (left.label < right.label) return -1;
  if (left.label > right.label) return 1;
  return 0;
}

/**
 * Build the stable owner choices for the project-agent access setting:
 * Personal first, then the account's organizations by name. Desktop Settings
 * and the Portal's App Advisor settings both render this list.
 */
export function buildAppAdvisorProjectAgentAccessOwnerOptions(
  organizations: readonly WorkspaceContextOrganization[],
): AppAdvisorProjectAgentAccessOwnerOption[] {
  const candidates: OrganizationOptionCandidate[] = organizations
    .filter((organization) => organization.id.trim().length > 0)
    .map((organization) => ({
      organization,
      label:
        organization.name.trim().length > 0
          ? organization.name
          : 'Organization',
    }))
    .sort(compareOrganizationOptions);

  const options: AppAdvisorProjectAgentAccessOwnerOption[] = [
    { owner: { kind: 'personal' }, label: 'Personal' },
  ];
  const seenOrganizationIds = new Set<string>();

  for (const { organization, label } of candidates) {
    if (seenOrganizationIds.has(organization.id)) continue;
    seenOrganizationIds.add(organization.id);
    options.push({
      owner: { kind: 'organization', organizationId: organization.id },
      label,
    });
  }

  return options;
}
