import type { AgentDelegationResult } from '@canopy/protocol/delegation';
import type {
  ChatTabPluginSelections,
  ModelHarness,
  ThinkingLevel,
} from '@canopy/desktop-shared/types';
import {
  EMPTY_AGENT_CAPABILITIES,
  capabilityOverlayFromAgentProjection,
  isEmptyCapabilityOverlayInput,
  type AgentArtifactStore,
  type CapabilityOverlayInput,
  type MaterializedAgentProjection,
  type MaterializedCapabilityOverlay,
} from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import type { ResolvedAgentRouteSnapshot } from '@canopy/desktop-shared/node/delegation';
import type { AuthoritativeConfiguredModel } from '../lib/model-config';
import type { ResolvedAgentModelRuntime } from './agent-model-runtime';
import { resolveAgentModelRuntime } from './agent-model-runtime';
import { isAgentModel } from '@canopy/desktop-shared/types';
import { delegationAgentCapabilityError } from './delegation/agent-capability-error';
import { delegationCapabilityAssignmentError } from './delegation/capability-grant';
import {
  retainAgentRoute,
  validateAgentRoute,
} from '@canopy/desktop-shared/node/delegation';

export interface DelegationModelRuntimeHost {
  readonly artifacts: AgentArtifactStore;
  captureRoute(
    this: void,
    runtime: ResolvedAgentModelRuntime,
  ): Promise<AgentDelegationResult<ResolvedAgentRouteSnapshot>>;
  lookupModel(
    this: void,
    modelId: string,
  ): AuthoritativeConfiguredModel | undefined;
  authorize(
    this: void,
    route: ResolvedAgentRouteSnapshot,
  ): Promise<AgentDelegationResult<void>>;
  /**
   * Materializes the child's capability layers: the configured Agent's own
   * selections (`agentSelections`, undefined for a plain model) plus any
   * host-owned layers. Throws `DelegationAgentCapabilityError` when a layer
   * that must fail the spawn cannot be used. Undefined means no overlay.
   */
  materializeCapabilities(
    this: void,
    input: {
      readonly agentSelections: ChatTabPluginSelections | undefined;
      readonly harness: ModelHarness;
    },
  ): Promise<CapabilityOverlayInput | undefined>;
}

export interface PreparedDelegationModel {
  readonly route: ResolvedAgentRouteSnapshot;
  /** Configured Agent identity and system prompt. */
  readonly projection?: MaterializedAgentProjection;
  /** Verified capabilities the child runs with, from either overlay kind. */
  readonly capabilities?: MaterializedCapabilityOverlay;
}

/** Host-only composition. Never accept route, artifact, or auth fields from a tool. */
export async function resolveDelegationModel(
  modelId: string,
  thinkingLevel: ThinkingLevel | undefined,
  host: DelegationModelRuntimeHost,
  /** Parent workspace; an inheriting Agent runs on its default. */
  parentProjectId?: string,
): Promise<AgentDelegationResult<PreparedDelegationModel>> {
  try {
    // Copy before invoking asynchronous host services. Their inputs never retain
    // references into the editable Agent definition or current picker registry.
    const runtime = structuredClone(
      await resolveAgentModelRuntime({
        model: modelId,
        inheritDefaultFrom: { projectId: parentProjectId },
      }),
    );
    const captured = await host.captureRoute(runtime);
    if (!captured.ok) return captured;
    if (
      captured.value.runtimeModelId !== runtime.runtimeModel ||
      captured.value.harnessId !== runtime.executionHarness ||
      captured.value.providerType !== runtime.providerType ||
      captured.value.agentOverlay !== undefined ||
      captured.value.capabilityOverlay !== undefined
    )
      return unavailable();
    const validation = validateAgentRoute(
      modelId,
      thinkingLevel,
      captured.value,
    );
    if (!validation.ok) return validation;
    let route = retainAgentRoute({
      ...captured.value,
      requestedThinkingLevel: thinkingLevel,
      effectiveThinkingLevel:
        thinkingLevel ?? captured.value.effectiveThinkingLevel,
    });
    const capabilities = await host.materializeCapabilities({
      agentSelections: runtime.agent ? runtime.pluginSelections : undefined,
      harness: runtime.executionHarness,
    });
    if (runtime.agent) {
      const definition = runtime.agent;
      // The Agent artifact carries identity and instructions only; its
      // capabilities live in the capability overlay below.
      const overlay = await host.artifacts.retain({
        agentDefinitionId: definition.id,
        agentDefinitionRevision: definition.updatedAt,
        agentDefinitionHash: definition.contentHash ?? '',
        systemPromptAppend: runtime.systemPromptAppend ?? '',
        pluginFiles: {},
        toolNames: ['read', 'search'],
        capabilities: EMPTY_AGENT_CAPABILITIES,
      });
      route = retainAgentRoute({ ...route, agentOverlay: overlay });
    }
    if (capabilities && !isEmptyCapabilityOverlayInput(capabilities)) {
      const overlay =
        await host.artifacts.retainCapabilityOverlay(capabilities);
      route = retainAgentRoute({ ...route, capabilityOverlay: overlay });
    }
    // Launch consumes the bytes read back from the retained artifacts, exactly
    // like resume, rather than a second projection of live plugin directories.
    return await resumeDelegationModel(route, host);
  } catch (error) {
    const capability =
      delegationAgentCapabilityError(error) ??
      delegationCapabilityAssignmentError(error);
    if (capability) return capabilityUnavailable(capability.publicMessage);
    return unavailable();
  }
}

export async function resumeDelegationModel(
  captured: ResolvedAgentRouteSnapshot,
  host: DelegationModelRuntimeHost,
): Promise<AgentDelegationResult<PreparedDelegationModel>> {
  try {
    const route = retainAgentRoute(captured);
    const model = host.lookupModel(route.runtimeModelId);
    if (!model?.enabled || model.id !== route.runtimeModelId)
      return unavailable();
    const validation = validateAgentRoute(
      route.selectedModelId,
      route.requestedThinkingLevel,
      route,
    );
    if (!validation.ok) return validation;
    if (
      (route.requestedThinkingLevel !== undefined &&
        route.requestedThinkingLevel !== route.effectiveThinkingLevel) ||
      (route.effectiveThinkingLevel !== undefined &&
        !route.supportedThinkingLevels.includes(route.effectiveThinkingLevel))
    )
      return unavailable();
    // Agent identity is checked only against the Agent overlay; a plain-model
    // route may carry a capability overlay.
    if (
      isAgentModel(route.selectedModelId) !== Boolean(route.agentOverlay) ||
      (route.agentOverlay &&
        route.agentOverlay.agentDefinitionId !== route.selectedModelId)
    )
      return unavailable();
    const projection = route.agentOverlay
      ? await host.artifacts.load(route.agentOverlay)
      : undefined;
    // Routes written before capability overlays keep their capabilities in
    // the Agent artifact; they map to an overlay with provenance `agent`.
    const capabilities = route.capabilityOverlay
      ? await host.artifacts.loadCapabilityOverlay(route.capabilityOverlay)
      : projection
        ? capabilityOverlayFromAgentProjection(projection)
        : undefined;
    // Current account, policy, runtime compatibility, and tool authority are
    // checked against this exact route. Picker visibility/assignment is ignored.
    const authority = await host.authorize(route);
    if (!authority.ok) return authority;
    return {
      ok: true,
      value: Object.freeze({
        route,
        ...(projection ? { projection } : {}),
        ...(capabilities ? { capabilities } : {}),
      }),
    };
  } catch {
    return unavailable();
  }
}

function unavailable(): AgentDelegationResult<never> {
  return {
    ok: false,
    error: {
      code: 'route_unavailable',
      message: 'The retained delegation model or projection is unavailable.',
      retryable: false,
    },
  };
}

function capabilityUnavailable(message: string): AgentDelegationResult<never> {
  return {
    ok: false,
    error: { code: 'capability_unavailable', message, retryable: false },
  };
}
