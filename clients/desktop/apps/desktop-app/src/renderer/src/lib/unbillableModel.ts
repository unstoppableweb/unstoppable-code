import { useMemo, useSyncExternalStore } from 'react';
import {
  getModelDisplayName,
  getProviderForModel,
  type ChatModel,
} from '@canopy/desktop-shared/types';
import {
  personalGatewayEquivalentModel,
  type BillingLaneAvailability,
} from '@canopy/desktop-shared/lib/default-model-lane';
import { isGatewayOnlyModel } from '@canopy/execution-engine/lib/gateway-model-availability';
import { MODEL_PICKER_ROW_CUE_COPY } from '@canopy/ui-shared';
import {
  getRendererBillingLaneAvailability,
  getRendererBillingLaneFactsVersion,
  subscribeRendererBillingLaneFacts,
} from '@/stores/billingLaneRuntime';
import {
  getRendererModelFactsVersion,
  subscribeRendererModelFacts,
} from '@/stores/modelPolicyRuntime';
import {
  firstPersonalGatewayDefaultModel,
  personalGatewaySendableModels,
} from '@/stores/chat/defaults';
import { getProviderLabel } from './providerLabels';

/**
 * The built-in harness `model` needs when this account can't bill it at all:
 * its Claude or Codex sign-in is confirmed missing and AI Credits are
 * confirmed unavailable (CAN-6444), or unknown while both sign-ins are
 * confirmed missing (the Personal gateway's stand-in rule,
 * `personalGatewayStandsIn`). `undefined` when it can bill, isn't a built-in
 * model, or the facts can't tell, so nothing is refused or flagged on a guess.
 */
export function unbillableBuiltInProvider(
  model: ChatModel,
  lanes: BillingLaneAvailability,
): 'claude' | 'codex' | undefined {
  if (isGatewayOnlyModel(model) || lanes.creditsEligible === true) {
    return undefined;
  }
  if (
    lanes.creditsEligible === undefined &&
    (lanes.claudeNativeAuth !== false || lanes.codexNativeAuth !== false)
  ) {
    return undefined;
  }
  const provider = getProviderForModel(model);
  if (provider === 'claude' && lanes.claudeNativeAuth === false)
    return 'claude';
  if (provider === 'codex' && lanes.codexNativeAuth === false) return 'codex';
  return undefined;
}

export interface UnbillableModelSwitch {
  readonly modelLabel: string;
  readonly reason: string;
  readonly switchModel: ChatModel;
}

/**
 * When the composer's model can't run for this account and the user's own AI
 * gateway has one that can, what to tell them and what to switch to. The
 * switch target is the gateway's route for the same model when it has one,
 * otherwise the model a new chat would default to.
 */
export function useUnbillableModelSwitch(
  model: ChatModel | undefined,
): UnbillableModelSwitch | null {
  const laneFactsVersion = useSyncExternalStore(
    subscribeRendererBillingLaneFacts,
    getRendererBillingLaneFactsVersion,
    getRendererBillingLaneFactsVersion,
  );
  const modelFactsVersion = useSyncExternalStore(
    subscribeRendererModelFacts,
    getRendererModelFactsVersion,
    getRendererModelFactsVersion,
  );
  return useMemo(() => {
    void laneFactsVersion;
    void modelFactsVersion;
    if (!model) return null;
    const provider = unbillableBuiltInProvider(
      model,
      getRendererBillingLaneAvailability(),
    );
    if (!provider) return null;
    const switchModel =
      personalGatewayEquivalentModel(model, {
        models: personalGatewaySendableModels(),
      }) ?? firstPersonalGatewayDefaultModel();
    if (!switchModel) return null;
    return {
      modelLabel: getModelDisplayName(model),
      reason: MODEL_PICKER_ROW_CUE_COPY.needsBillingSourceHint(
        getProviderLabel(provider),
      ),
      switchModel,
    };
  }, [laneFactsVersion, modelFactsVersion, model]);
}
