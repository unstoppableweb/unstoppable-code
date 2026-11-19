import { useCallback, useEffect, useState } from 'react';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { AiCreditsScopeRequest } from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  MODEL_PICKER_AUTO_REASONS,
  modelLibraryRowLock,
} from '@canopy/ui-shared';
import {
  useGetAiCreditsAction,
  useUnlockModelsAction,
} from '@/lib/openBillingPage';
import { resolveModelLibraryLock } from '@/lib/modelLibraryAccess';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useAiCreditsAvailability } from './useAiCreditsAvailability';
import { useIsGuestCredential } from './useIsGuestCredential';
import { useWorkModelLibraryAccess } from './useModelLibraryAccess';

/**
 * Server capability advertising that the paired Canopy Cloud backend can
 * actually resolve a routing decision. Rollout state and client/server skew
 * stay explicit: an older server simply never mints it, and Auto hides.
 */
const MODEL_ROUTING_CAPABILITY = 'model-routing-v1';

/**
 * Whether the account's cloud backend advertises `model-routing-v1`.
 *
 * `null` while the first account read is in flight, so callers can hold the
 * Auto row back rather than flashing it and then withdrawing it.
 */
function useModelRoutingCapability(): boolean | null {
  const [supported, setSupported] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    const loadAccount = window.api?.loadCanopyCloudAccount;
    if (typeof loadAccount !== 'function') {
      setSupported(false);
      return (): void => {
        mounted = false;
      };
    }
    const refresh = (): void => {
      void loadAccount()
        .then((account) => {
          if (!mounted) return;
          setSupported(
            account?.capabilities.includes(MODEL_ROUTING_CAPABILITY) === true,
          );
        })
        .catch(() => {
          // A failed read is not evidence the server lacks the capability, but
          // Auto must fail closed: routing that cannot reach the resolver would
          // fall back on every turn while charging nothing and explaining less.
          if (mounted) setSupported((previous) => previous ?? false);
        });
    };
    refresh();
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, refresh);
    return (): void => {
      mounted = false;
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, refresh);
    };
  }, []);

  return supported;
}

export interface AutoModelRoutingAvailability {
  /**
   * Whether the Auto row may be rendered at all. False hides Auto outright
   * (flag off/unavailable, or a server without `model-routing-v1`) — a hidden
   * row rather than a disabled one, because neither state is the user's to fix.
   */
  readonly offered: boolean;
  /**
   * Populated when Auto is offered but not currently selectable. Full pickers
   * show this as the row's reason; compact ones hide the row.
   */
  readonly unavailableReason?: string;
  /** Opens the fix for {@link unavailableReason} when the user can resolve it. */
  readonly unavailableAction?: () => void;
}

/**
 * Host-resolvable half of Auto's availability: the rollout flag, the server
 * capability, and the AI Credits funding chain Jev itself bills against.
 *
 * The candidate-count rule (`Needs two or more models`) is
 * deliberately NOT here — only the picker knows which rows survive its own
 * harness, lane, policy, and thinking-level gates.
 */
export function useAutoModelRoutingAvailability(
  /** Owner of the work Auto would bill (CAN-3463); omitted = navigation. */
  creditsScope?: AiCreditsScopeRequest,
): AutoModelRoutingAvailability {
  const flagEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedAutoModelRouting.key),
  );
  const capability = useModelRoutingCapability();
  const credits = useAiCreditsAvailability(creditsScope);
  const getAiCredits = useGetAiCreditsAction(creditsScope);
  const isGuest = useIsGuestCredential();
  const libraryAccess = useWorkModelLibraryAccess(creditsScope);
  const unlockModels = useUnlockModelsAction(creditsScope);
  const unlockAuto = useCallback((): void => {
    // Auto has no single model to apply afterwards: once access is unlocked
    // the row is simply selectable again.
    void unlockModels({ source: 'desktop' });
  }, [unlockModels]);

  if (!flagEnabled || capability !== true) return { offered: false };
  // Auto may route to any model in the library, so it needs unlocked access
  // (CAN-4028). Checked ahead of the funding chain: a non-payer's leftover
  // credits can make that chain look healthy, and the row would then be
  // offered for a router the server refuses. The same shared lock the model rows use.
  const lock = modelLibraryRowLock(
    resolveModelLibraryLock(isGuest, libraryAccess),
  );
  if (lock !== undefined) {
    return {
      offered: true,
      unavailableReason: lock.hint,
      unavailableAction: unlockAuto,
    };
  }
  if (credits.loading) {
    return {
      offered: true,
      unavailableReason: MODEL_PICKER_AUTO_REASONS.creditsLoading,
    };
  }
  // An inconclusive read is not an observed "no credits", but Jev cannot be
  // dispatched without a settled eligible funding chain either. Offer the row
  // with the actionable reason rather than a dead end the user cannot read.
  if (!credits.eligible) {
    return {
      offered: true,
      unavailableReason: MODEL_PICKER_AUTO_REASONS.noCredits,
      // The same sign-in gate and billing hand-off every credits CTA uses.
      unavailableAction: getAiCredits,
    };
  }
  return { offered: true };
}
