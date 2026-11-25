import { useMemo, useSyncExternalStore } from 'react';
import {
  resolveKnownModel,
  type ChatModel,
} from '@canopy/desktop-shared/types';
import type { ModelGatewayIndex } from '@canopy/desktop-shared/lib/org-model-gateway';
import {
  resolveChatModelChangeHarness,
  supportsChatHarnessChoice,
} from '@canopy/desktop-shared/lib/chat-model-selection';
import { parseOrgGatewayModelId } from '@canopy/execution-engine/lib/gateway-model-availability';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import {
  getRendererModelFactsVersion,
  getRendererModelGatewayIndex,
  isRendererModelPolicyHydrated,
  subscribeRendererModelFacts,
} from '@/stores/modelPolicyRuntime';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useLocalModelGateway } from '@/hooks/useLocalModelGateway';
import { findOrganizationName } from './organizationName';

export interface StrandedGatewayModel {
  readonly modelLabel: string;
  readonly reason: string;
}

/**
 * Why a chat on an AI gateway model can't send, when that model's gateway is
 * off or removed, or no longer lists it. `null` while the model still routes,
 * before the first account read, or when the gateway still lists the model:
 * a missing key on this computer is the key banner's job.
 */
export function strandedGatewayModel(
  model: ChatModel | undefined,
  index: ModelGatewayIndex,
  organizations: readonly { id: string; name: string }[] | undefined,
  /** This device's gateway id, which stays the user's own while it is off. */
  deviceOrganizationId?: string,
): StrandedGatewayModel | null {
  const parsed = parseOrgGatewayModelId(model);
  if (!model || !parsed || !isRendererModelPolicyHydrated()) return null;
  if (resolveKnownModel(model) !== undefined) return null;
  const organizationId = normalizeUuid(parsed.organizationId);
  const gateway = organizationId
    ? index.byOrganization.get(organizationId)
    : undefined;
  const personal =
    organizationId !== null &&
    (organizationId === normalizeUuid(index.personalOrganizationId) ||
      organizationId === normalizeUuid(deviceOrganizationId));
  // A degraded account read says nothing about the gateway.
  if (
    gateway?.unavailable === true ||
    (personal ? index.personalUnavailable === true : index.accountUnavailable)
  )
    return null;
  const listed =
    gateway?.models.some((entry) => entry.id === parsed.modelId) === true;
  if (listed) return null;
  const organizationName = personal
    ? undefined
    : (gateway?.organizationName ??
      findOrganizationName(organizations, parsed.organizationId) ??
      undefined);
  // The row is gone, so its own label is too; another gateway's row may
  // answer to the bare id, so it is not resolved.
  const modelLabel = parsed.modelId;
  const reason =
    gateway && gateway.models.length > 0
      ? personal
        ? 'Your AI gateway no longer lists this model.'
        : `${organizationName ?? 'Your organization'}'s AI gateway no longer lists this model.`
      : personal
        ? 'Your AI gateway is off or was removed.'
        : organizationName
          ? `${organizationName}'s AI gateway is off or was removed.`
          : 'The AI gateway for this model is off or was removed.';
  return { modelLabel, reason };
}

/**
 * The default a stranded chat can switch to: a model that still exists and
 * that the chat's own harness can run, as main's model change checks it.
 * `undefined` when there is none, so the notice offers no dead button.
 */
export function strandedSwitchTarget(
  tab: Parameters<typeof resolveChatModelChangeHarness>[0],
  defaultModel: ChatModel | undefined,
): ChatModel | undefined {
  if (
    !defaultModel ||
    defaultModel === tab?.model ||
    resolveKnownModel(defaultModel) === undefined
  )
    return undefined;
  const harness = resolveChatModelChangeHarness(tab, defaultModel);
  return harness && supportsChatHarnessChoice(defaultModel, harness)
    ? defaultModel
    : undefined;
}

/** {@link strandedGatewayModel} for the composer's model, kept current. */
export function useStrandedGatewayModel(
  model: ChatModel | undefined,
): StrandedGatewayModel | null {
  const modelFactsVersion = useSyncExternalStore(
    subscribeRendererModelFacts,
    getRendererModelFactsVersion,
    getRendererModelFactsVersion,
  );
  const snapshot = useModelCatalogStore((state) => state.snapshot);
  const gatewayIndex = useModelCatalogStore((state) => state.gatewayIndex);
  const organizations = useWorkspaceContextStore(
    (state) => state.state.organizations,
  );
  const deviceOrganizationId = useLocalModelGateway()?.organizationId;
  return useMemo(() => {
    void modelFactsVersion;
    void snapshot;
    void gatewayIndex;
    return strandedGatewayModel(
      model,
      getRendererModelGatewayIndex(),
      organizations,
      deviceOrganizationId,
    );
  }, [
    model,
    modelFactsVersion,
    snapshot,
    gatewayIndex,
    organizations,
    deviceOrganizationId,
  ]);
}
