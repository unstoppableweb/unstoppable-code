import type { ComponentsLabEntry } from './componentsLabCatalog';
import {
  MarketplaceLabelsSpecimen,
  McpServerCardRowSpecimen,
  McpStatusSpecimen,
} from './componentsLabMarketplace';
import {
  CodeBlockSpecimen,
  ModelUnlockPendingSpecimen,
  OnboardingTipSpecimen,
  OpenCodeAccountSpecimen,
  PageColumnSpecimen,
  ComposerSuggestionMenuSpecimen,
  PickListResultsSpecimen,
  PickListSpecimen,
  PipelineDispatchedTimeSpecimen,
} from './componentsLabPanels';

const SRC = 'packages/ui-shared/src/components';

/**
 * Specimen sheets that close the component-completeness gap (list root-3):
 * each shows a shared component in every state it has. Registered in the
 * catalog with one spread.
 */
export const GAP_ROOT_3A_LAB_ENTRIES: readonly ComponentsLabEntry[] = [
  {
    id: 'marketplace-type-label',
    name: 'MarketplaceTypeLabel',
    group: 'Unified',
    note: 'A quiet icon-and-text label for a Customize resource kind, and the Curated source label with its attributed mark.',
    source: `${SRC}/MarketplaceTypeLabel.tsx`,
    prs: [],
    View: MarketplaceLabelsSpecimen,
  },
  {
    id: 'mcp-connection-status-badge',
    name: 'McpConnectionStatusBadge',
    group: 'Unified',
    note: 'Cached connection health for an MCP server: four statuses, with the Agent provider suffix when the provider manages it.',
    source: `${SRC}/McpConnectionStatusBadge.tsx`,
    prs: [],
    View: McpStatusSpecimen,
  },
  {
    id: 'mcp-server-card-row',
    name: 'McpServerCardRow',
    group: 'Unified',
    note: 'One MCP server row for the desktop and web panels: a text, button or link name, metadata, status, details and actions.',
    source: `${SRC}/McpServerCardRow.tsx`,
    prs: [],
    View: McpServerCardRowSpecimen,
  },
  {
    id: 'code-block',
    name: 'CodeBlock',
    group: 'Unified',
    note: 'The one code block for Markdown, ANSI and plain output. Plain blocks pick a variant by role, ANSI keeps colors and follows the tail, and Markdown adds a copy button that reveals on hover or focus.',
    source: `${SRC}/CodeBlock.tsx`,
    prs: [],
    View: CodeBlockSpecimen,
  },
  {
    id: 'model-unlock-pending-notice',
    name: 'ModelUnlockPendingNotice',
    group: 'Unified',
    note: 'The composer cue while an advanced-model purchase finishes in the browser: waiting, then timed out with a dismiss.',
    source: `${SRC}/ModelUnlockPendingNotice.tsx`,
    prs: [],
    View: ModelUnlockPendingSpecimen,
  },
  {
    id: 'onboarding-tip',
    name: 'OnboardingTip',
    group: 'Unified',
    note: 'The one onboarding tip: a title, one sentence, a Got it capsule and an always-visible close; inline, in the composer drawer or as a composer notice.',
    source: `${SRC}/OnboardingTip.tsx`,
    prs: [],
    View: OnboardingTipSpecimen,
  },
  {
    id: 'opencode-account-card',
    name: 'OpenCodeAccountCard',
    group: 'Unified',
    note: 'OpenCode provider accounts as a usage group: a row per account with its sign-in method, plus the empty and unavailable states.',
    source: `${SRC}/OpenCodeAccountCard.tsx`,
    prs: [],
    View: OpenCodeAccountSpecimen,
  },
  {
    id: 'page-column',
    name: 'PageColumn',
    group: 'Unified',
    note: 'The shared page column: centered, a content or wide maximum width, one gutter and the page gap between sections.',
    source: `${SRC}/PageColumn.tsx`,
    prs: [],
    View: PageColumnSpecimen,
  },
  {
    id: 'pick-list',
    name: 'PickList',
    group: 'Unified',
    note: 'The one search-and-pick list: combobox semantics, arrow keys over picker rows, and the empty and loading states.',
    source: `${SRC}/PickList.tsx`,
    prs: [],
    View: PickListSpecimen,
  },
  {
    id: 'pick-list-results',
    name: 'PickListResults',
    group: 'Unified',
    note: 'The results of a PickList for a host that owns its input, a palette or a composer: usePickListKeys drives it, and it brings the sections, tabs, disabled rows and row-end controls.',
    source: `${SRC}/PickList.tsx`,
    prs: [],
    View: PickListResultsSpecimen,
  },
  {
    id: 'composer-suggestion-menu',
    name: 'ComposerSuggestionMenu',
    group: 'Unified',
    note: 'A list that suggests as the user types: above the composer at its width, in the 20px corners, and it never takes focus.',
    source: `${SRC}/ComposerSuggestionMenu.tsx`,
    prs: [],
    View: ComposerSuggestionMenuSpecimen,
  },
  {
    id: 'pipeline-dispatched-time',
    name: 'PipelineDispatchedTime',
    group: 'Unified',
    note: 'Dispatched 2h ago, with the exact local time on hover; renders nothing until the run’s start is known.',
    source: `${SRC}/PipelineDispatchedTime.tsx`,
    prs: [],
    View: PipelineDispatchedTimeSpecimen,
  },
];
