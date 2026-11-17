import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { getModelSource } from '@canopy/desktop-shared/types';
import { checkModelGatewayRoute } from './model-gateway-state';
import { isModelBlockedByStoredPolicy } from './model-policy-state';
import {
  ModelGatewayRefusedError,
  type ModelGatewayRefusalStage,
} from './model-gateway-refusal';

/**
 * Whether AI Credits routing decides this turn's gateway route, so this check
 * must leave it alone: a Claude or Codex turn on a routed model. Local Ollama
 * runs on either harness without that routing (CAN-6701, the pipelines lane's
 * finding on #9310), so it is judged here like any other native-only route.
 */
function routedByAiCredits(
  modelId: string | undefined,
  providerType: string | undefined,
): boolean {
  return (
    (providerType === 'claude' || providerType === 'codex') &&
    (modelId === undefined || getModelSource(modelId) !== 'ollama')
  );
}

/**
 * Refuse a turn whose model an enforced organization gateway excludes, with
 * the typed {@link ModelGatewayRefusedError} for `stage`.
 *
 * `before-save` (the send funnels) judges only a concrete model and resolves
 * the owner lazily, so a Claude or Codex send pays nothing. `session` (the
 * per-turn session gate) keeps the gate's fail-closed reading: a turn with no
 * model is still judged, so unreadable gateway settings refuse it.
 */
export async function assertTurnModelGatewayRoute(
  modelId: string | undefined,
  providerType: string | undefined,
  owner: WorkOwner | undefined | (() => Promise<WorkOwner | undefined>),
  stage: ModelGatewayRefusalStage,
  options: {
    /**
     * For a funnel with no policy check of its own before saving: leave a
     * policy-blocked model to the session gate, so its policy refusal and
     * copy stay exactly as they were.
     */
    deferToPolicy?: boolean;
  } = {},
): Promise<void> {
  if (stage === 'before-save' && !modelId) return;
  if (routedByAiCredits(modelId, providerType)) return;
  const resolved = typeof owner === 'function' ? await owner() : owner;
  if (
    options.deferToPolicy === true &&
    (await isModelBlockedByStoredPolicy(modelId, resolved))
  )
    return;
  const check = await checkModelGatewayRoute(modelId, resolved);
  if (!check.ok) throw new ModelGatewayRefusedError(check.message, stage);
}
