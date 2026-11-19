import type { ComponentsLabEntry } from './componentsLabCatalog';
import {
  PlanOpenActionSpecimen,
  PlanStatusSpecimen,
  ProviderAccountUsageSpecimen,
} from './componentsLabPlans';

const SRC = 'packages/ui-shared/src/components';

/**
 * Specimen sheets that close the component-completeness gap (list root-3,
 * batch 2): each shows a shared component in every state it has.
 */
export const GAP_ROOT_3B_LAB_ENTRIES: readonly ComponentsLabEntry[] = [
  {
    id: 'plan-open-implementation-action',
    name: 'Open implementation action',
    group: 'Unified',
    note: 'Open, which replaces Execute while a plan’s selected attempt runs and after it succeeds: a chat or a run, regular or icon-only.',
    source: `${SRC}/PlanOpenImplementationAction.tsx`,
    prs: [],
    View: PlanOpenActionSpecimen,
  },
  {
    id: 'plan-status',
    name: 'Plan status',
    group: 'Unified',
    note: 'PlanReviewStatusBadge, PlanStatusNote and PlanProvenance: a plan’s review or implementation state, the outcome beside it and where an imported plan came from.',
    source: `${SRC}/{PlanReviewStatusBadge,PlanProvenance}.tsx`,
    prs: [],
    View: PlanStatusSpecimen,
  },
  {
    id: 'provider-account-usage',
    name: 'Provider account usage',
    group: 'Unified',
    note: 'One multi-account proxy account with its usage: a row per limit window, the account, freshness and any failed read; plus the Settings-row form.',
    source: `${SRC}/ProviderAccountUsage.tsx`,
    prs: [],
    View: ProviderAccountUsageSpecimen,
  },
];
