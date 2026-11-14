import type { PortalEntityEnvelope } from '@canopy/desktop-shared/types';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { isRecord } from '@canopy/desktop-shared/portal/persisted-chat-projection';
import { peekPortalProviderAvailability } from '../auth/provider-auth-state';
import { buildProjectedModelCatalog } from './model-catalog-projection';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import { peekCanopyCloudAccount } from '../lib/canopy-cloud-account-store';

const MODEL_ROUTING_CAPABILITY = 'model-routing-v1';

/** Truthful paired-desktop support projected to Remote Control clients. */
export function isDesktopModelRoutingSupported(): boolean {
  return (
    getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopySharedAutoModelRouting.key,
    ) &&
    peekCanopyCloudAccount()?.capabilities.includes(
      MODEL_ROUTING_CAPABILITY,
    ) === true
  );
}

/**
 * Add the model/provider controls required by the selected worktree UI. A
 * worktree New Task dispatches into a worktree chat, so it carries the Cursor
 * rows and the runtime-connected key like the chat summaries do.
 */
export function projectNewTaskControls(
  entities: PortalEntityEnvelope[],
  worktreeLocalId: string,
  owner: WorkOwner | undefined,
  /** See `resolveCatalogAgentDefaultModel`. */
  agentDefaultModel: string | undefined,
): PortalEntityEnvelope[] {
  const availableModels = buildProjectedModelCatalog(undefined, {
    cursor: true,
    antigravity: true,
    owner,
    copilot: true,
    opencode: true,
    agentDefaultModel,
  });
  const providerAvailability = peekPortalProviderAvailability();
  const modelRoutingSupported = isDesktopModelRoutingSupported();
  return entities.map((entity) =>
    entity.entityType === 'worktree' && entity.localId === worktreeLocalId
      ? {
          ...entity,
          payload: {
            ...(isRecord(entity.payload) ? entity.payload : {}),
            availableModels,
            providerAvailability,
            ...(modelRoutingSupported ? { modelRoutingSupported: true } : {}),
          },
        }
      : entity,
  );
}
