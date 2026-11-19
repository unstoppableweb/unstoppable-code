import type { ComponentsLabEntry } from './componentsLabCatalog';
import { PrHoverCardsSpecimen } from './componentsLabPrHoverCards';

/**
 * Specimen sheet that closes the component-completeness gap for
 * pr-hover-cards (list root-3): a provider and a hook, shown through the
 * hover card that reads them.
 */
export const GAP_ROOT_3D_LAB_ENTRIES: readonly ComponentsLabEntry[] = [
  {
    id: 'pr-hover-cards',
    name: 'Pull request hover cards',
    group: 'Unified',
    note: 'The pull request cards presentation setting: a provider and a hook, shown through the GitHub hover card that reads it, with no provider, on, off and nested.',
    source: 'packages/ui-shared/src/components/pr-hover-cards.tsx',
    prs: [],
    View: PrHoverCardsSpecimen,
  },
];
