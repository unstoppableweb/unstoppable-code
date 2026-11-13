import {
  parseAgentRouteModelId,
  formatAgentRouteModelId,
  type SharedAgentDetail,
} from '@canopy/protocol/agents';
import type { SharedAutomationAgentReference } from '@canopy/protocol/automations';
import { countPluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import type { AgentModelDefinition } from '@canopy/execution-engine/types/agent-models';

type AutomationAgentMatch = (
  local: AgentModelDefinition,
  detail: SharedAgentDetail,
) => Promise<boolean>;

export interface ResolvedAutomationAgent extends SharedAutomationAgentReference {
  localAgentId: string;
  agentId: string;
}

/** A resolved Agent cannot travel as a hosted reference; packaging may carry it locally. */
export class AutomationAgentNotShareableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationAgentNotShareableError';
  }
}

export function assertAutomationAgentReference(
  model: string,
  reference: SharedAutomationAgentReference,
  detail: SharedAgentDetail,
): void {
  const route = parseAgentRouteModelId(model);
  if (
    !route ||
    route.agentId !== detail.agent.id ||
    reference.remoteId !== detail.id ||
    reference.contentHash !== detail.contentHash ||
    (detail.shareScope !== 'team' &&
      detail.shareScope !== 'organization' &&
      detail.owner.type !== 'organization')
  ) {
    throw new AutomationAgentNotShareableError(
      'The shared Agent is unavailable or has changed. Refresh it before sharing or installing this automation.',
    );
  }
}

/** Provenance is resolved by each host; local IDs never serve as portable identity. */
export async function resolveAutomationSharedAgent(
  model: string | undefined,
  port: {
    get(id: string): Promise<AgentModelDefinition | null>;
    getShared(id: string): Promise<SharedAgentDetail>;
    pluginsMatch?: AutomationAgentMatch;
    packageMatches?: AutomationAgentMatch;
  },
): Promise<ResolvedAutomationAgent | undefined> {
  const route = model ? parseAgentRouteModelId(model) : null;
  if (!route) return undefined;
  const local = await port.get(route.agentId);
  const remoteId = local?.importedFromRemoteId ?? local?.remoteId;
  if (!local || !remoteId) return undefined;
  const detail = await port.getShared(remoteId);
  const reference = { remoteId, contentHash: detail.contentHash };
  assertAutomationAgentReference(
    formatAgentRouteModelId(detail.agent.id, route.baseModel),
    reference,
    detail,
  );
  if (detail.package && !port.packageMatches) {
    throw new AutomationAgentNotShareableError(
      `Couldn't share this automation because packaged Agent "${detail.name}" can't be verified here. Choose an Agent without packaged resources.`,
    );
  }
  if (
    local.remoteContentHash !== detail.contentHash ||
    (local.importedContentHash !== undefined &&
      local.importedContentHash !== local.contentHash) ||
    local.instructions !== detail.agent.instructions ||
    local.baseModel !== detail.agent.baseModel ||
    !(await automationAgentContentMatches(
      local,
      detail,
      port.pluginsMatch,
      port.packageMatches,
    ))
  ) {
    throw new AutomationAgentNotShareableError(
      'The Agent has local changes or its shared snapshot could not be verified. Share or refresh the Agent from Agents before sharing this automation.',
    );
  }
  return { ...reference, localAgentId: local.id, agentId: detail.agent.id };
}

/** Local fingerprints detect edits, not hosted package swaps; packages need a receipt. */
async function automationAgentContentMatches(
  local: AgentModelDefinition,
  detail: SharedAgentDetail,
  pluginsMatch?: AutomationAgentMatch,
  packageMatches?: AutomationAgentMatch,
): Promise<boolean> {
  if ((local.pluginSelections.unresolvedCapabilities?.length ?? 0) > 0)
    return false;
  if (
    local.importedContentHash !== undefined &&
    (local.contentHash === undefined ||
      local.importedContentHash !== local.contentHash)
  )
    return false;
  if (detail.package)
    return packageMatches ? packageMatches(local, detail) : false;
  if (
    countPluginSelections(local.pluginSelections) === 0 &&
    (local.pluginSelections.mcpHttpAuthPreferences?.length ?? 0) === 0 &&
    detail.agent.plugins.length === 0
  )
    return true;
  return pluginsMatch ? pluginsMatch(local, detail) : false;
}

/** No imports or installs: consent for Agent dependencies belongs to the Agents flow. */
export async function findInstalledAutomationAgent(
  model: string,
  reference: SharedAutomationAgentReference,
  detail: SharedAgentDetail,
  installed: readonly AgentModelDefinition[],
  pluginsMatch?: AutomationAgentMatch,
  packageMatches?: AutomationAgentMatch,
): Promise<{ remoteId: string; contentHash: string; localAgentId: string }> {
  assertAutomationAgentReference(model, reference, detail);
  if (detail.package && !packageMatches) {
    throw new Error(
      `Couldn't install this automation because packaged Agent "${detail.name}" can't be verified here. Choose an Agent without packaged resources.`,
    );
  }
  for (const local of installed) {
    if (
      (local.importedFromRemoteId ?? local.remoteId) === reference.remoteId &&
      local.remoteContentHash === reference.contentHash &&
      local.instructions === detail.agent.instructions &&
      local.baseModel === detail.agent.baseModel &&
      (await automationAgentContentMatches(
        local,
        detail,
        pluginsMatch,
        packageMatches,
      ))
    )
      return { ...reference, localAgentId: local.id };
  }
  throw new Error(
    `Couldn't install this automation. Install or refresh Agent "${detail.name}" from Agents first, then try again.`,
  );
}
