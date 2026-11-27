import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { hasHydratedGatewayCatalog } from '@canopy/desktop-shared/types';
import type {
  BillingReadinessFact,
  BillingReadinessFactState,
} from '@canopy/app-state/provider-choice';
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
  getDesktopBillingGateSnapshot,
  publishDesktopBillingReadiness,
  subscribeDesktopBillingGate,
  type DesktopBillingGateSnapshot,
} from '@/stores/billingReadinessRuntime';
import { personalGatewaySwitch } from '@/stores/chat/defaults';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
import { useCanopyCloudAccountState } from './useCanopyCloudAccountState';
import { useOrgModelGateways } from './useOrgModelGateway';
import { useOllamaReadiness } from './useOllamaReadiness';
import { useCursorChatAvailability } from './useCursorChatAvailable';
import { useCopilotChatAvailability } from './useCopilotChatAvailable';
import { useOpenCodeChatAvailability } from './useOpenCodeChatAvailable';

function triState(value: boolean | undefined): BillingReadinessFactState {
  if (value === undefined) return 'unknown';
  return value ? 'ready' : 'unavailable';
}

/**
 * Compute this window's billing readiness facts and publish them to
 * `billingReadinessRuntime`. Mount once per window that hosts a new-chat
 * surface, beside `useBillingLaneRuntimeSync` (which owns the Claude, Codex
 * and AI Credits tri-states read here). Mount points read the result with
 * {@link useDesktopBillingGate} and add no probes of their own.
 *
 * How each fact settles:
 * - Claude, Codex, AI Credits: the lane runtime tri-states (`undefined` is
 *   unknown). They already count an Environments credential and a ready
 *   account proxy. A failed credits read stays unknown, so no gate offline.
 * - Personal gateway: ready with a sendable model; unavailable once the
 *   gateway catalog has hydrated without one.
 * - Org gateway: unknown until the account read settles.
 * - Ollama: unknown until the first state answer; an error is unavailable.
 * - Cursor, Copilot, OpenCode: installed and on, no sign-in check; a harness
 *   flag that is off settles unavailable at once.
 * - Antigravity: the flag plus the model catalog snapshot; unknown until the
 *   snapshot loads.
 */
export function useDesktopBillingReadinessSync(): void {
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
  const { account } = useCanopyCloudAccountState();
  const orgGateways = useOrgModelGateways();
  const ollama = useOllamaReadiness();
  const cursor = useCursorChatAvailability(true);
  const copilot = useCopilotChatAvailability(true);
  const opencode = useOpenCodeChatAvailability(true);
  const antigravityEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarness.key),
  );
  const antigravitySnapshot = useModelCatalogStore((state) =>
    state.snapshot === null || state.snapshot === undefined
      ? undefined
      : (state.snapshot.antigravity?.length ?? 0) > 0,
  );
  // The latch scope: the signed-in account. Never sent anywhere.
  const scopeKey =
    account === null
      ? null
      : (account.personalOrganizationId ??
        (account.hasApiKey ? 'signed-in' : 'signed-out'));

  useEffect(() => {
    const availability = getRendererBillingLaneAvailability();
    const gateway = personalGatewaySwitch();
    const facts: BillingReadinessFact[] = [
      { id: 'claude', state: triState(availability.claudeNativeAuth) },
      { id: 'codex', state: triState(availability.codexNativeAuth) },
      { id: 'credits', state: triState(availability.creditsEligible) },
      {
        id: 'gateway',
        state:
          gateway.model !== undefined
            ? 'ready'
            : hasHydratedGatewayCatalog()
              ? 'unavailable'
              : 'unknown',
      },
      {
        id: 'org-gateway',
        state:
          orgGateways === undefined
            ? 'unknown'
            : orgGateways.length > 0
              ? 'ready'
              : 'unavailable',
      },
      { id: 'ollama', state: ollama },
      { id: 'cursor', state: triState(cursor) },
      { id: 'copilot', state: triState(copilot) },
      { id: 'opencode', state: triState(opencode) },
      {
        id: 'antigravity',
        state: antigravityEnabled
          ? triState(antigravitySnapshot)
          : 'unavailable',
      },
    ];
    publishDesktopBillingReadiness(facts, scopeKey);
  }, [
    laneFactsVersion,
    modelFactsVersion,
    orgGateways,
    ollama,
    cursor,
    copilot,
    opencode,
    antigravityEnabled,
    antigravitySnapshot,
    scopeKey,
  ]);
}

/**
 * This window's readiness and gate latch. `gate.shown` is true only after a
 * confirmed `none`, and stays true through `unknown` (a probe refresh mid
 * sign-in) until a source is ready.
 */
export function useDesktopBillingGate(): DesktopBillingGateSnapshot {
  const snapshot = useSyncExternalStore(
    subscribeDesktopBillingGate,
    getDesktopBillingGateSnapshot,
    getDesktopBillingGateSnapshot,
  );
  // Kill switch for the gate mounts only (on in every default state): off,
  // every surface keeps its composer. Readiness still flows, and the
  // composer fixes and main's send refusal are unaffected.
  const gateEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopBillingSetupGate.key),
  );
  return useMemo(
    (): DesktopBillingGateSnapshot =>
      gateEnabled || !snapshot.gate.shown
        ? snapshot
        : { ...snapshot, gate: { ...snapshot.gate, shown: false } },
    [gateEnabled, snapshot],
  );
}
