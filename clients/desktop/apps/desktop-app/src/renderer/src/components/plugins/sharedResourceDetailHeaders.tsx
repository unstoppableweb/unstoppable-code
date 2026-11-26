import type { SharedAgentSummary } from '@canopy/execution-engine/types/agent-models';
import type { SharedPluginSummary } from '@canopy/protocol/plugins';
import type { SharedSkillSummary } from '@canopy/protocol/skills';
import type { WorkspaceTemplateShareSummary } from '@canopy/protocol/workspace-templates';
import { getModelDisplayName } from '@canopy/desktop-shared/types';
import { describeAgentBaseModel } from '@canopy/protocol/agents';
import type { MarketplaceDetailPageHeader } from '@canopy/ui-app/capability';
import {
  sharedResourceProvenance,
  sharedResourceProvenanceMeta,
  sharedWorkspaceTemplateProvenance,
  type SharedResourceProvenanceMetaOptions,
} from '@canopy/ui-app/sharing';

/**
 * The page-shell item headers (CAN-4266) for the kinds a recipient reaches
 * only through a share: what each is, who shared it, the organization that
 * owns it and with whom. The bodies are in `SharedResourceMarketplaceDetail`.
 * A host whose Shared by you card lists the audiences passes
 * `audienceListedBelow` so the header does not repeat them (CAN-5224).
 */

/** A shared agent's header: its model, author, organization and audience. */
export function sharedAgentDetailHeader(
  agent: SharedAgentSummary,
  personalOrganizationId: string | null,
  options?: SharedResourceProvenanceMetaOptions,
): MarketplaceDetailPageHeader {
  return {
    description: `Model preset using ${describeAgentBaseModel(agent.baseModel, getModelDisplayName)}`,
    meta: sharedResourceProvenanceMeta(
      sharedResourceProvenance(
        agent,
        agent.createdBy.name,
        personalOrganizationId,
      ),
      'shared-agent-detail-audience',
      options,
    ),
  };
}

/** A shared project template's header: its description, author, organization, audience. */
export function sharedBlueprintDetailHeader(
  blueprint: WorkspaceTemplateShareSummary,
  personalOrganizationId: string | null,
): MarketplaceDetailPageHeader {
  return {
    ...(blueprint.description ? { description: blueprint.description } : {}),
    meta: sharedResourceProvenanceMeta(
      sharedWorkspaceTemplateProvenance(blueprint, personalOrganizationId),
      'shared-blueprint-detail-audience',
    ),
  };
}

/** A shared plugin's header: its description, author, organization and audience. */
export function sharedPluginDetailHeader(
  plugin: SharedPluginSummary,
  personalOrganizationId: string | null,
  options?: SharedResourceProvenanceMetaOptions,
): MarketplaceDetailPageHeader {
  return {
    ...(plugin.description ? { description: plugin.description } : {}),
    meta: sharedResourceProvenanceMeta(
      sharedResourceProvenance(
        plugin,
        plugin.createdBy.name,
        personalOrganizationId,
      ),
      'shared-plugin-detail-audience',
      options,
    ),
  };
}

/**
 * A shared skill's header: its description, then author, organization and
 * audience. The skill page appends its own installed and public-link facts.
 */
export function sharedSkillDetailHeader(
  skill: SharedSkillSummary,
  personalOrganizationId: string | null,
  options?: SharedResourceProvenanceMetaOptions,
): MarketplaceDetailPageHeader {
  return {
    description: skill.description,
    meta: sharedResourceProvenanceMeta(
      sharedResourceProvenance(
        skill,
        skill.createdBy.name,
        personalOrganizationId,
      ),
      'shared-skill-detail-audience',
      options,
    ),
  };
}
