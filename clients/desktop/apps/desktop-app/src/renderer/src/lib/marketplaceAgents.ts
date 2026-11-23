import { describeAgentBaseModel } from '@canopy/protocol/agents';
import { CURATED_PLUGIN_MARKETPLACE_ID } from '@canopy/protocol/plugins';
import type { UnifiedLocalAgentInput } from '@canopy/protocol/unified-entry';
import {
  getAgentModelAvailability,
  getModelDisplayName,
} from '@canopy/desktop-shared/types';
import type { DesktopPublisherSkill } from '@canopy/desktop-shared/types/skills';
import { visibleEntryId } from '@/lib/unifiedPluginEntries';
import type { AgentModelDefinition } from '@canopy/execution-engine/types/agent-models';
import type { AgentDefinitionSummaryPlugin } from '@canopy/ui-shared/components';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib/unified-plugin-entry';

/** Capabilities an agent selects: collections, skills, plugins and servers. */
export function agentPluginCount(agent: AgentModelDefinition): number {
  const selections = agent.pluginSelections;
  return (
    selections.collectionIds.length +
    selections.skillRefs.length +
    selections.pluginRefs.length +
    (selections.mcpServerRefs?.length ?? 0)
  );
}

/** The base model as the model pickers name it. */
export function agentBaseModelLabel(agent: AgentModelDefinition): string {
  return describeAgentBaseModel(agent.baseModel, getModelDisplayName);
}

/** Readable labels for the capabilities an agent selects. */
export function agentPluginLabels(
  agent: AgentModelDefinition,
): AgentDefinitionSummaryPlugin[] {
  const selections = agent.pluginSelections;
  return [
    ...selections.collectionIds.map((id) => ({
      key: `collection:${id}`,
      label: `Collection: ${id}`,
    })),
    ...selections.skillRefs.map((ref) => ({
      key: `skill:${ref.sourceId}:${ref.skillName}`,
      label: `Skill: ${ref.skillName}`,
    })),
    ...selections.pluginRefs.map((ref) => ({
      key: `plugin:${ref.marketplaceId}:${ref.pluginName}`,
      label: `Plugin: ${ref.pluginName}`,
    })),
    ...(selections.mcpServerRefs ?? []).map((ref) => ({
      key: `mcp:${ref.serverId}:${ref.configId}`,
      label: `MCP server: ${ref.serverId}`,
    })),
  ];
}

/**
 * The shared agent this local agent is a copy of, if any: the share it was
 * published as, or the share it was installed from.
 */
function sharedRemoteId(agent: AgentModelDefinition): string | undefined {
  return agent.remoteId ?? agent.importedFromRemoteId;
}

/** Instructions summarize an agent; the base model stands in when empty. */
function agentDescription(agent: AgentModelDefinition): string {
  const firstLine = agent.instructions
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  return firstLine ?? agentBaseModelLabel(agent);
}

/** Map local definitions onto the portable Marketplace inventory input. */
export function marketplaceLocalAgentInputs(
  agents: readonly AgentModelDefinition[],
): UnifiedLocalAgentInput[] {
  return agents.map((agent) => {
    const remoteId = sharedRemoteId(agent);
    return {
      id: agent.id,
      name: agent.name,
      description: agentDescription(agent),
      baseModelLabel: agentBaseModelLabel(agent),
      pluginCount: agentPluginCount(agent),
      updatedAt: agent.updatedAt,
      available: getAgentModelAvailability(agent.id).available,
      ...(remoteId ? { sharedRemoteId: remoteId } : {}),
    };
  });
}

/**
 * The Customize tiles of what an agent selects, from the list's entries, and
 * the selections that no tile stands for. Each one opens its own page. An
 * installed publisher skill has no tile of its own (the list folds its copy
 * into the publisher's entry), so its selection resolves to that entry.
 */
export function agentSelectionEntries(
  agent: AgentModelDefinition,
  entries: readonly UnifiedPluginEntry[],
  publisherSkills: readonly DesktopPublisherSkill[] = [],
): { entries: UnifiedPluginEntry[]; unresolved: string[] } {
  const selections = agent.pluginSelections;
  const found: UnifiedPluginEntry[] = [];
  const unresolved: string[] = [];
  const add = (
    label: string,
    match: (entry: UnifiedPluginEntry) => boolean,
  ): void => {
    // A skill or plugin can be listed more than once; the first is enough.
    const entry = entries.find(match);
    if (!entry) unresolved.push(label);
    else if (!found.includes(entry)) found.push(entry);
  };
  for (const ref of selections.skillRefs) {
    const localId = `skill:${ref.sourceId}:${ref.skillName}`;
    const visibleId = visibleEntryId(localId, publisherSkills);
    add(ref.skillName, (entry) => {
      if (visibleId !== localId) return entry.id === visibleId;
      const entryRef = entry.ref;
      return (
        entryRef.type === 'skill' &&
        entryRef.sourceId === ref.sourceId &&
        entryRef.skillName === ref.skillName
      );
    });
  }
  for (const ref of selections.pluginRefs) {
    add(ref.pluginName, (entry) => {
      const entryRef = entry.ref;
      if (
        entryRef.type === 'marketplace-plugin' &&
        entryRef.marketplaceId === ref.marketplaceId &&
        entryRef.pluginName === ref.pluginName
      )
        return true;
      // A curated plugin is a card of its own under its catalog key, or is
      // folded into the integration card of the one server it needs.
      if (ref.marketplaceId !== CURATED_PLUGIN_MARKETPLACE_ID) return false;
      return (
        (entryRef.type === 'curated-plugin' &&
          entryRef.key === ref.pluginName) ||
        entry.integration?.plugin?.key === ref.pluginName
      );
    });
  }
  for (const ref of selections.mcpServerRefs ?? []) {
    add(ref.serverId, (entry) => {
      const entryRef = entry.ref;
      if (
        (entryRef.type === 'mcp-server' || entryRef.type === 'local-mcp') &&
        entryRef.serverId === ref.serverId &&
        (entryRef.configId === undefined || entryRef.configId === ref.configId)
      )
        return true;
      // A curated integration card stands for its server whatever the
      // configuration: the picker saves each enabled configuration by its own
      // id but the card lists only the first, so a saved secondary one
      // resolves to the card of its server.
      return (
        entry.integration?.connections.some(
          (connection) => connection.serverId === ref.serverId,
        ) ?? false
      );
    });
  }
  for (const id of selections.collectionIds) {
    add(id, (entry) => {
      const entryRef = entry.ref;
      return (
        entryRef.type === 'local-collection' && entryRef.collectionId === id
      );
    });
  }
  return { entries: found, unresolved };
}
