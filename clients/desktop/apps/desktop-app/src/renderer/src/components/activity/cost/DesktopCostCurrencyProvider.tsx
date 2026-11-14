import { useMemo, type JSX, type ReactNode } from 'react';
import { AI_CREDIT_USD_PER_CREDIT } from '@canopy/protocol/settings/billing-plan-catalog';
import {
  CostCurrencyContext,
  type CostCurrency,
} from '@canopy/ui-shared/components/cost';
import { useAiCreditsOnlyBilling } from '@/hooks/useAiCreditsOnlyBilling';

/**
 * The units this desktop's cost views show amounts in (CAN-6180): AI Credits
 * work in credits with USD alongside, and every amount in credits, never
 * USD, for an account that bills every turn to AI Credits (CAN-5028).
 */
export function DesktopCostCurrencyProvider({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const creditsOnly = useAiCreditsOnlyBilling();
  const currency = useMemo<CostCurrency>(
    () => ({
      kind: 'credits',
      usdPerCredit: AI_CREDIT_USD_PER_CREDIT,
      creditsOnly,
    }),
    [creditsOnly],
  );
  return (
    <CostCurrencyContext.Provider value={currency}>
      {children}
    </CostCurrencyContext.Provider>
  );
}
