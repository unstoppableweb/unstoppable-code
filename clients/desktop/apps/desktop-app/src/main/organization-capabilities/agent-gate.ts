/**
 * The check that keeps an organization's Agent copies to the workspaces whose
 * organization set holds them (CAN-6237, phase 10a), as organization skills
 * are kept. The organization capabilities service registers it at startup;
 * this module has no imports, so Agent resolution can ask it from anywhere.
 */
type OrganizationAgentGate = (
  projectId: string,
  agentId: string,
) => Promise<boolean>;

let gate: OrganizationAgentGate | null = null;

export function setOrganizationAgentGate(
  next: OrganizationAgentGate | null,
): void {
  gate = next;
}

/**
 * Whether the Agent `agentId` may run in the chat workspace `projectId`.
 * Without a workspace (the Agents page, package analysis, automation
 * checks) there is no organization set to ask, so nothing is refused here.
 */
export function organizationAgentGateAllows(
  projectId: string | undefined,
  agentId: string,
): Promise<boolean> {
  if (projectId === undefined || gate === null) return Promise.resolve(true);
  return gate(projectId, agentId);
}
