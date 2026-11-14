import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
import { useOpenCodeChatAvailable } from './useOpenCodeChatAvailable';
import { useCopilotChatAvailable } from './useCopilotChatAvailable';
import { useMemo } from 'react';
import type {
  AgentProviderType,
  AiCreditsScopeRequest,
} from '@canopy/desktop-shared/types';
import { useClaudeAuthStatus } from './useClaudeAuthStatus';
import { useCodexAuthStatus } from './useCodexAuthStatus';
import { useAiCreditsAvailability } from './useAiCreditsAvailability';
import { isAccountProxyReadyForHarness } from '@canopy/desktop-shared/lib/account-proxy';
import { useAccountProxyStatus } from '@/stores/accountProxyStore';

/**
 * Whether a provider's models can be selected in the model picker, and why.
 *
 * `selectable` is optimistic while `loading` so a native subscriber is never
 * flash-disabled by a slow auth probe. Per-model gating (native login unlocks
 * the whole group; AI Credits unlock only gateway-routable models) is derived
 * from `nativeAuth` / `creditsEligible` at the row level in `ModelPicker`.
 */
export interface ProviderModelAvailability {
  /** True when the group should be treated as usable (native, credits, or loading). */
  selectable: boolean;
  /**
   * True when the user has a native login/API key for this provider, or a
   * connected account proxy has a ready account for it: the proxy bills the
   * provider's own models, as main's lane resolver counts it (CAN-4020).
   */
  nativeAuth: boolean;
  /** True when AI Credits can pay for this provider's gateway models. */
  creditsEligible: boolean;
  /** True while the underlying auth/credits reads are still resolving. */
  loading: boolean;
  /**
   * The provider's own auth probe is still loading or failed, so a negative
   * `nativeAuth` is not a confirmed sign-out. Unlike `loading`, a credits
   * refresh never sets it (CAN-5349). Omitted means fall back to `loading`.
   */
  nativeAuthInconclusive?: boolean;
  /** True only while AI Credits eligibility is still resolving. */
  creditsLoading?: boolean;
  /**
   * The credits read failed or its cached answer is stale during refresh.
   * Selection stays optimistic; a picker cue treats this as unknown (CAN-5213).
   */
  creditsInconclusive?: boolean;
}

export type ProviderAvailability = Record<
  AgentProviderType,
  ProviderModelAvailability
>;

/**
 * `creditsScope` is the owner of the work the picker is for (CAN-3463): AI
 * Credits spill only onto that owner's organization pool, so a chat owned by an
 * unfunded org must not read as covered because another org is funded. Omitted
 * means the live navigation context.
 */
export function useProviderAvailability(
  creditsScope?: AiCreditsScopeRequest,
): ProviderAvailability {
  const antigravityEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarness.key),
  );
  const antigravityDiscovered = useModelCatalogStore(
    (state) => (state.snapshot?.antigravity?.length ?? 0) > 0,
  );
  const antigravity = antigravityEnabled && antigravityDiscovered;
  const opencode = useOpenCodeChatAvailable(true);
  const copilot = useCopilotChatAvailable(true);
  const claudeAuth = useClaudeAuthStatus();
  const codexAuth = useCodexAuthStatus();
  const credits = useAiCreditsAvailability(creditsScope);
  const accountProxy = useAccountProxyStatus();
  const claudeProxyReady = isAccountProxyReadyForHarness(
    accountProxy,
    'claude',
  );
  const codexProxyReady = isAccountProxyReadyForHarness(accountProxy, 'codex');

  return useMemo<ProviderAvailability>(() => {
    const creditsEligible = credits.eligible;

    const gated = (
      authenticated: boolean,
      authLoading: boolean,
      probeFailed: boolean,
    ): ProviderModelAvailability => {
      // A failed auth probe is inconclusive, not a confirmed logout. Keep
      // model rows optimistic; the billing resolver retains a native choice
      // while the next probe can settle.
      const nativeAuthInconclusive = authLoading || probeFailed;
      const loading = nativeAuthInconclusive || credits.loading;
      return {
        nativeAuth: authenticated,
        creditsEligible,
        loading,
        nativeAuthInconclusive,
        creditsLoading: credits.loading,
        creditsInconclusive: credits.inconclusive || credits.stale === true,
        selectable: authenticated || creditsEligible || loading,
      };
    };

    return {
      antigravity: {
        nativeAuth: antigravity,
        creditsEligible: false,
        loading: false,
        selectable: antigravity,
      },
      opencode: {
        nativeAuth: opencode,
        creditsEligible: false,
        loading: false,
        selectable: opencode,
      },
      copilot: {
        nativeAuth: copilot,
        creditsEligible: false,
        loading: false,
        selectable: copilot,
      },
      cursor: {
        nativeAuth: true,
        creditsEligible: false,
        loading: false,
        selectable: true,
      },
      claude: gated(
        claudeAuth?.authenticated === true ||
          claudeAuth?.userSuppliedCredential === true ||
          claudeProxyReady,
        claudeAuth === null,
        claudeAuth?.probeFailed === true,
      ),
      codex: gated(
        codexAuth?.authenticated === true ||
          codexAuth?.userSuppliedCredential === true ||
          codexProxyReady,
        codexAuth === null,
        codexAuth?.probeFailed === true,
      ),
      // Ollama runs locally and is never gated on native auth or credits.
      ollama: {
        nativeAuth: true,
        // Local provider — never credit-routed, so this is false by definition
        // rather than reflecting the user's cloud account state.
        creditsEligible: false,
        loading: false,
        creditsLoading: false,
        selectable: true,
      },
    };
  }, [
    antigravity,
    opencode,
    copilot,
    claudeAuth,
    codexAuth,
    claudeProxyReady,
    codexProxyReady,
    credits.eligible,
    credits.loading,
    credits.inconclusive,
    credits.stale,
  ]);
}
