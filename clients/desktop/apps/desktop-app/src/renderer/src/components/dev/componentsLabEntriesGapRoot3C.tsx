import type { ComponentsLabEntry } from './componentsLabCatalog';
import {
  ProviderRowLabelSpecimen,
  RemoteControlPromoSpecimen,
  ResizeRailSpecimen,
  ServerMarkdownSpecimen,
} from './componentsLabProviderRows';

const SRC = 'packages/ui-shared/src/components';

/**
 * Specimen sheets that close the component-completeness gap (list root-3,
 * batch 3): each shows a shared component in every state it has.
 */
export const GAP_ROOT_3C_LAB_ENTRIES: readonly ComponentsLabEntry[] = [
  {
    id: 'provider-row-label',
    name: 'Provider row label',
    group: 'Unified',
    note: 'A provider’s mark, name and status dot as a Settings row label; the dot has six tones, from connected to a hollow ring for signed out.',
    source: `${SRC}/ProviderRowLabel.tsx`,
    prs: [],
    View: ProviderRowLabelSpecimen,
  },
  {
    id: 'remote-control-mobile-app-promo',
    name: 'Remote Control app offer',
    group: 'Unified',
    note: 'The Remote Control download offer both hosts share: store badges as links on web, as buttons on desktop; nothing when hidden or with no links.',
    source: `${SRC}/RemoteControlMobileAppPromo.tsx`,
    prs: [],
    View: RemoteControlPromoSpecimen,
  },
  {
    id: 'resize-rail-indicator',
    name: 'Resize handle line',
    group: 'Unified',
    note: 'The visible line inside every resize handle: a quiet hairline at rest, the accent on hover and while dragging, vertical or horizontal.',
    source: `${SRC}/ResizeRailIndicator.tsx`,
    prs: [],
    View: ResizeRailSpecimen,
  },
  {
    id: 'server-markdown',
    name: 'Server markdown',
    group: 'Unified',
    note: 'Markdown rendered on the server, so function-valued options need no client boundary; shown with headings, lists, code and a table.',
    source: `${SRC}/ServerMarkdown.tsx`,
    prs: [],
    View: ServerMarkdownSpecimen,
  },
];
