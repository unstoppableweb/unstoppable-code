/**
 * Applies an organization project's pipeline set to the shared pipelines
 * source (CAN-6237, phase 10b): the organization's default pipelines the
 * project switched off are left out of its workflow library and refused
 * there. The organization capabilities service registers the lookup at
 * startup; this module has no imports, so the source can ask it.
 */
type OrganizationPipelineLookup = (
  projectId: string,
) => Promise<{ readonly switchedOff: ReadonlySet<string> } | undefined>;

let lookup: OrganizationPipelineLookup | null = null;

export function setOrganizationPipelineLookup(
  next: OrganizationPipelineLookup | null,
): void {
  lookup = next;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The hosted ids of the organization pipelines `projectId`'s project
 * switched off; none without a workspace, outside an organization
 * workspace, or while organization projects are off.
 */
export async function organizationPipelinesSwitchedOff(
  projectId: string | undefined,
): Promise<ReadonlySet<string>> {
  if (projectId === undefined || lookup === null) return NONE;
  return (await lookup(projectId))?.switchedOff ?? NONE;
}

/**
 * The refusal of a switched-off organization pipeline. It is a resource
 * context denial (`isPipelineContextDenial`), so the shared source answers it
 * as `core.pipeline.contextMismatch` and runs report it as any other.
 */
export const ORGANIZATION_PIPELINE_SWITCHED_OFF =
  'Workflow unavailable (switched-off-in-project)';

/**
 * The one admission check for a shared pipeline in the workspace
 * `projectId`: every read for a run and every run start asks it before the
 * definition is cached or executed. Throws when the project switched the
 * organization's default off; nothing is refused without a workspace.
 */
export async function assertOrganizationPipelineAllowed(
  projectId: string | undefined,
  remoteId: string,
): Promise<void> {
  if ((await organizationPipelinesSwitchedOff(projectId)).has(remoteId))
    throw new Error(ORGANIZATION_PIPELINE_SWITCHED_OFF);
}
