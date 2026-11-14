import { createContext, useContext } from 'react';
import { USD_COST_CURRENCY, type CostCurrency } from './cost-format';

/**
 * The units the cost views show amounts in (CAN-6180). A host that knows its
 * account's billing provides it; without a provider every amount is USD.
 */
export const CostCurrencyContext =
  createContext<CostCurrency>(USD_COST_CURRENCY);

export function useCostCurrency(): CostCurrency {
  return useContext(CostCurrencyContext);
}
