import {
  COMPONENTS_LAB_ENTRIES,
  type ComponentsLabEntry,
} from './componentsLabCatalog';

/**
 * The lab's pages: what the sidebar lists. A page is one catalog entry, or
 * several that belong to the same part of the product, shown one under the
 * other. The catalog still owns each specimen sheet and whether it is
 * unified; this file only says which page a sheet is on and where the page
 * sits. A unified entry no page names lands on a page of its own under
 * `Product`, so a new sheet needs no change here.
 */
export const COMPONENTS_LAB_SECTIONS = [
  'Foundations',
  'Controls',
  'Forms',
  'Status and feedback',
  'Chat',
  'Product',
  'Not unified yet',
] as const;
export type ComponentsLabSection = (typeof COMPONENTS_LAB_SECTIONS)[number];

export interface ComponentsLabPage {
  readonly id: string;
  readonly name: string;
  readonly section: ComponentsLabSection;
  /** One sentence over a page that holds several entries. */
  readonly note?: string;
  readonly entries: readonly ComponentsLabEntry[];
}

/** A page of one entry (its id), or a named page of several. */
type PageSpec =
  | string
  | {
      readonly id: string;
      readonly name: string;
      readonly note: string;
      readonly entries: readonly string[];
    };

const PAGE_SPECS: Readonly<
  Record<Exclude<ComponentsLabSection, 'Not unified yet'>, readonly PageSpec[]>
> = {
  Foundations: [
    'colors',
    'text',
    'headings',
    'radius',
    'shadows',
    'spacing',
    'surfaces',
    'icon-scale',
    'page-column',
  ],
  Controls: [
    'button',
    'list-row',
    'chip',
    'selection-pill',
    'tab-bar',
    'key-caps',
    'menus',
    {
      id: 'pick-list',
      name: 'Pick lists',
      note: 'The one search-and-pick list, and its results for a host that owns the input.',
      entries: ['pick-list', 'pick-list-results'],
    },
    'disclosures',
    {
      id: 'tooltip-copy',
      name: 'Tooltips and copy',
      note: 'The tooltip, the copy control and how both confirm and hand over.',
      entries: ['tooltip-copy', 'copy-feedback', 'tooltip-handoff'],
    },
    'dialogs',
    'data-table',
    'charts',
    'avatars',
    'facts',
    'detail-header',
    'reference-chips',
    'resize-rail-indicator',
  ],
  Forms: [
    'text-input',
    'text-area',
    'select',
    'date-field',
    'search-field',
    'inline-text-input',
    'checkbox-radio',
    'toggle-switch',
    'slider',
    'segmented-control',
    'color-swatches',
    'form-field',
    'toolbar-chips',
  ],
  'Status and feedback': [
    {
      id: 'markers',
      name: 'Markers',
      note: 'Badges, counts, dots and status glyphs, the rows and headers they ship in, and agent state.',
      entries: ['markers', 'markers-in-context', 'agent-state'],
    },
    'notice',
    'toast',
    'failures',
    'loading',
    'progress',
  ],
  Chat: [
    {
      id: 'chat-look',
      name: 'Chat look',
      note: 'The providers that set how a transcript reads, with the parts that follow them.',
      entries: ['chat-look', 'chat-presentation'],
    },
    {
      id: 'chat-notices',
      name: 'Markers and notices',
      note: 'What the app itself says in a transcript: who sent a message, why a turn resumed, and what is waiting.',
      entries: [
        'chat-agent-sent-marker',
        'agent-sent',
        'chat-auto-resume-marker',
        'chat-safety-denied-notice',
        'chat-app-note',
        'chat-fork-context-notice',
        'chat-delegated-agent-capabilities',
        'chat-background-notices',
        'chat-transcript-event',
      ],
    },
    {
      id: 'chat-messages',
      name: 'Messages',
      note: 'A message’s own controls: copy, edit and its context menu.',
      entries: [
        'chat-copy-action',
        'chat-message-edit-card',
        'chat-message-edit-entry',
        'chat-unsaved-message-edits',
        'chat-user-bubble-cancelled-note',
        'chat-message-menus',
      ],
    },
    {
      id: 'chat-markdown',
      name: 'Markdown',
      note: 'How transcript markdown renders: links, images, tables and code.',
      entries: [
        'keys-and-markdown',
        'inline-code',
        'code-block',
        'server-markdown',
      ],
    },
    {
      id: 'composer',
      name: 'Composer',
      note: 'The controls in and around the composer.',
      entries: [
        'composer-actions',
        'composer-plan-chip',
        'composer-suggestion-menu',
        'chat-composer-icon-button',
        'model-unlock-pending-notice',
        'composer-parts',
      ],
    },
    {
      id: 'chat-queue',
      name: 'Queue',
      note: 'Queued messages: the row, its actions and why it is waiting.',
      entries: [
        'chat-queued-message-row',
        'chat-queued-message-actions',
        'chat-queued-message-reason',
        'chat-queued-message-settings-held-warning',
        'chat-steering-request-title',
      ],
    },
    {
      id: 'chat-steps',
      name: 'Steps and tools',
      note: 'The rows that show what an agent is doing, and the words and icons behind them.',
      entries: [
        'chat-step-row',
        'chat-step-words',
        'chat-tool-display',
        'chat-live-tool-activity',
        'chat-status-announcer',
        'chat-task-stop-button',
      ],
    },
    {
      id: 'chat-approvals',
      name: 'Approvals',
      note: 'Asking before a tool runs: the card, the dock, and what an approval shows.',
      entries: [
        'chat-tool-approval-card',
        'chat-tool-approval-dock',
        'chat-tool-approval-wait',
        'chat-approval-file-change',
        'chat-approval-content-modal',
      ],
    },
    {
      id: 'chat-turns',
      name: 'Turns',
      note: 'The header, outcome, menu and files of one turn.',
      entries: [
        'chat-turn-work-header',
        'chat-turn-resume-notice',
        'chat-turn-outcome-tooltip',
        'chat-turn-more-menu',
        'chat-turn-file-chip',
        'chat-turn-files-summary',
        'agent-activity',
      ],
    },
    {
      id: 'chat-subagents',
      name: 'Subagents',
      note: 'The subagent list, its marks, and the details of a subagent’s chat.',
      entries: [
        'chat-subagents-list',
        'chat-subagent-marks',
        'chat-subagent-lineage',
        'chat-subagent-workflow',
        'chat-subagent-worktree',
        'chat-subagent-setup',
        'chat-subagent-banner',
        'chat-subagent-transcript',
      ],
    },
    {
      id: 'plans',
      name: 'Plans',
      note: 'A plan’s status and the actions on it.',
      entries: [
        'plan-status',
        'plan-open-implementation-action',
        'chat-plan-copy-action',
      ],
    },
  ],
  Product: [
    {
      id: 'home',
      name: 'Home and onboarding',
      note: 'Home sections and rows, the onboarding tip and the offers a new user sees.',
      entries: [
        'home-and-resume',
        'onboarding-tip',
        'remote-control-mobile-app-promo',
        'home-parts',
      ],
    },
    'sidebar-parts',
    {
      id: 'settings',
      name: 'Settings',
      note: 'The parts Settings pages are built from.',
      entries: [
        'settings-diff-agents',
        'agent-alias-model',
        'settings-controls',
      ],
    },
    {
      id: 'customize',
      name: 'Customize',
      note: 'Installed items, their status, MCP servers and curated workflows.',
      entries: [
        'customize-parts',
        'customize-detail-pages',
        'customize-tile-benchmark',
        'installed-status',
        'customize-status',
        'drawer-and-entries',
        'marketplace-type-label',
        'mcp-connection-status-badge',
        'mcp-server-card-row',
        'curated-workflows',
      ],
    },
    {
      id: 'providers-and-models',
      name: 'Providers and models',
      note: 'Provider rows, accounts and their usage.',
      entries: [
        'provider-row-label',
        'provider-choice-rows',
        'provider-account-usage',
        'opencode-account-card',
        'antigravity-account-card',
        'google-subscription',
        'codex-account-notice',
        'model-selection-notice',
      ],
    },
    {
      id: 'usage-and-billing',
      name: 'Usage and billing',
      note: 'The usage meter and limits, credits notices and the billing tables.',
      entries: ['usage', 'credits-notices', 'billing'],
    },
    {
      id: 'workflows',
      name: 'Workflows',
      note: 'A workflow’s source, timing and target.',
      entries: ['workflow-parts', 'pipeline-dispatched-time'],
    },
    {
      id: 'files-and-pull-requests',
      name: 'Files and pull requests',
      note: 'Diff counts and file rows, pull request hover cards and reference cards.',
      entries: [
        'files-and-diffs',
        'pr-hover-cards',
        'reference-and-instructions',
      ],
    },
    {
      id: 'cloud-chats',
      name: 'Cloud chats',
      note: 'What a cloud chat says about its turn, and how it reaches or copies what lives on a desktop.',
      entries: [
        'cloud-turn-notices',
        'cloud-reach-back',
        'cloud-reach-back-prompt',
        'cloud-copy-mcp-server',
        'cloud-copy-plugin',
        'cloud-copy-git-unchecked',
        'mcp-removal-repair',
      ],
    },
    {
      id: 'recovery',
      name: 'Recovery',
      note: 'What the app shows when a workspace, an archive or a background service needs repair.',
      entries: [
        'w5-recovery-notice',
        'background-service-notice',
        'archive-recovery-list',
        'worktree-recovery-dialog',
        'project-deletion-recovery',
      ],
    },
    'providers',
  ],
};

/**
 * Sheet ids that no longer exist, each opening the page its first specimen
 * moved to, so an old `?component=` link still lands somewhere useful.
 */
const RETIRED_IDS: Readonly<Record<string, string>> = {
  // The one Form fields sheet became the Forms section.
  fields: 'text-input',
  'feature-parts-a': 'menus',
  'feature-parts-b': 'chat-background-notices',
  'feature-parts-c': 'codex-account-notice',
  'status-parts': 'customize-status',
  'usage-parts': 'usage',
  // Every spinner is the ring now; the Loading page shows it.
  'spinner-style': 'loading',
};

const ENTRY_BY_ID: ReadonlyMap<string, ComponentsLabEntry> = new Map(
  COMPONENTS_LAB_ENTRIES.map((entry) => [entry.id, entry]),
);

type TakeEntry = (id: string) => readonly ComponentsLabEntry[];

/** The page a spec names: none when the catalog no longer has its entries. */
function pageFromSpec(
  spec: PageSpec,
  section: ComponentsLabSection,
  take: TakeEntry,
): readonly ComponentsLabPage[] {
  if (typeof spec === 'string') {
    return take(spec).map((entry) => ({
      id: entry.id,
      name: entry.name,
      section,
      entries: [entry],
    }));
  }
  const entries = spec.entries.flatMap(take);
  if (entries.length === 0) return [];
  return [{ id: spec.id, name: spec.name, section, note: spec.note, entries }];
}

function buildPages(): readonly ComponentsLabPage[] {
  const placed = new Set<string>();
  // An entry appears on one page only: the first that names it.
  const take: TakeEntry = (id) => {
    const entry = ENTRY_BY_ID.get(id);
    if (!entry || placed.has(id)) return [];
    placed.add(id);
    return [entry];
  };
  const named = COMPONENTS_LAB_SECTIONS.flatMap((section) =>
    section === 'Not unified yet'
      ? []
      : PAGE_SPECS[section].flatMap((spec) =>
          pageFromSpec(spec, section, take),
        ),
  );
  const unnamed = COMPONENTS_LAB_ENTRIES.filter(
    (entry) => !placed.has(entry.id),
  ).map(
    (entry): ComponentsLabPage => ({
      id: entry.id,
      name: entry.name,
      section: entry.group === 'Unified' ? 'Product' : 'Not unified yet',
      entries: [entry],
    }),
  );
  const pages = [...named, ...unnamed];
  return COMPONENTS_LAB_SECTIONS.flatMap((section) =>
    pages.filter((page) => page.section === section),
  );
}

export const COMPONENTS_LAB_PAGES: readonly ComponentsLabPage[] = buildPages();

export interface ComponentsLabTarget {
  readonly page: ComponentsLabPage;
  /** The entry to scroll to, when the link named one inside the page. */
  readonly entryId?: string;
}

/** The page a `?component=` id opens: a page, an entry, or a retired sheet. */
export function resolveComponentsLabTarget(
  id: string | null,
): ComponentsLabTarget | undefined {
  if (!id) return undefined;
  const page = COMPONENTS_LAB_PAGES.find((candidate) => candidate.id === id);
  if (page) return { page };
  const entryId = RETIRED_IDS[id] ?? id;
  const owner = COMPONENTS_LAB_PAGES.find((candidate) =>
    candidate.entries.some((entry) => entry.id === entryId),
  );
  if (!owner) return undefined;
  return owner.entries.length > 1 ? { page: owner, entryId } : { page: owner };
}
