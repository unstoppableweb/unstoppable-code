/**
 * UI still waiting to be unified, from the standardization audit of develop
 * at 2f66024cd23 (2026-11-03), in priority order. The first round of families
 * (overlays, headings, disclosure, tables, tooltips, progress, avatars,
 * skeletons, search fields) all merged on 2026-11-02 and 2026-11-03 and are
 * pinned by their ratchets below. What is left has no shared component, or no
 * ratchet, yet. Update it as each family converges: drop the item and add a
 * sheet for its shared component in `componentsLabCatalog.tsx`.
 */

/** Where a family's unification stands today. */
export type PendingStatus = 'merging' | 'in-progress' | 'waiting';

/** A family with no legacy ratchet yet. */
export interface PendingUnification {
  readonly id: string;
  readonly status: PendingStatus;
  /** What the UI is, in product words. */
  readonly name: string;
  /** How much is left, in one short line. */
  readonly count: string;
  /** The shared components that exist today, with how many files use them. */
  readonly shared: readonly string[];
  /**
   * Where the copies live: repo-relative paths. A name after a colon is a
   * copy defined inside that file.
   */
  readonly copies: readonly string[];
  /** The planned shared component (and ratchet). */
  readonly planned: string;
  /** What decides it, or a caveat. */
  readonly note?: string;
}

/** A family whose ratchet exists, with what its baseline still allows. */
export interface RatchetBacklog {
  readonly family: string;
  readonly remaining: number;
  /** What the count is made of. */
  readonly breakdown: string;
  readonly baseline: string;
}

const DESKTOP = 'apps/desktop-app/src/renderer/src/components';
const UI_SHARED = 'packages/ui-shared/src/components';
const UI_APP = 'packages/ui-app/src';

export const PENDING_UNIFICATIONS: readonly PendingUnification[] = [
  {
    id: 'menus',
    status: 'in-progress',
    name: 'Menus, listboxes and pickers',
    count:
      '32 sites to change · 40 ratcheted occurrences in 27 files, see Menus below',
    shared: [
      'FloatingMenu (84 files)',
      'PickList (3 files)',
      'Popover (7 files)',
    ],
    copies: [
      `${UI_APP}/code/composer/PortalDirectoryPicker.tsx`,
      `${UI_APP}/sharing/InviteTeammateDialog.tsx`,
      `${DESKTOP}/shared/invite-teammate/LinkSharingSection.tsx`,
    ],
    planned:
      'PickList for the 8 search pickers and 2 palettes, shared parts for / and @, and the small menus onto FloatingMenu',
    note: 'Highest risk: the palettes and the composer typeaheads, which no golden reaches. The model picker keeps its search and rail as a recorded exception.',
  },
  {
    id: 'list-rows',
    status: 'waiting',
    name: 'List rows',
    count: 'about 229 local *Row components in 195 files',
    shared: ['ListRow (5 files)'],
    copies: [
      `${DESKTOP}/worktree/WorktreeItem.tsx`,
      `${DESKTOP}/worktree/OrgProjectPlaceholderRow.tsx`,
    ],
    planned:
      'ListRow with sizes, a link form, disabled and trailing actions, then a ratchet',
    note: 'ListRow only renders as a button today; that gap is why most local rows exist.',
  },
  {
    id: 'toggles',
    status: 'waiting',
    name: 'Switches, checkboxes and radios',
    count:
      '28 local *Toggle, *Switch or *Checkbox components · hand-made role="switch", "checkbox" or "radio" in about 15 files',
    shared: ['ToggleSwitch (70 files)', 'Checkbox', 'Radio'],
    copies: [
      `${UI_APP}/settings/billing/billing-toggle-panel.tsx`,
      `${UI_APP}/settings/digests/digest-share-controls.tsx`,
      `${UI_APP}/capability/McpServerReadDetail.tsx`,
      `${UI_APP}/feedback/FeedbackDialog.tsx`,
    ],
    planned:
      'ToggleSwitch with a public lg size and busy and disabled tests, then extend the fields ratchet to switch, checkbox and radio roles',
  },
  {
    id: 'slider',
    status: 'waiting',
    name: 'Sliders',
    count: 'two hand-made effort controls, no shared Slider',
    shared: [],
    copies: [
      `${UI_SHARED}/ThinkingLevelControl.tsx`,
      `${DESKTOP}/settings/ModelThinkingPreferenceRow.tsx`,
      `${DESKTOP}/chat/ThinkingLevelButton.tsx`,
    ],
    planned: 'A shared Slider with keyboard, disabled and value states',
  },
  {
    id: 'code-blocks',
    status: 'waiting',
    name: 'Code blocks',
    count: '<pre> in about 59 files',
    shared: ['MarkdownCodeBlock', 'AnsiOutput'],
    copies: [],
    planned: 'One exported CodeBlock for Markdown, ANSI and plain output',
  },
  {
    id: 'charts',
    status: 'waiting',
    name: 'Charts',
    count: 'two chart kits, desktop and ui-app',
    shared: [],
    copies: [
      `${DESKTOP}/pages/usage/chart-primitives.tsx`,
      `${UI_APP}/settings/organization/statistics/charts.tsx`,
    ],
    planned:
      'One chart kit, which also gives the last 4 progress bars their segments bar',
  },
];

export const RATCHET_BACKLOG: readonly RatchetBacklog[] = [
  {
    family: 'Spacing',
    remaining: 2558,
    breakdown: '739 space-between, 1819 margin',
    baseline: 'docs/design/legacy-spacing.baseline.json',
  },
  {
    family: 'Icons',
    remaining: 874,
    breakdown:
      '596 dimension props, 133 size classes, 43 off-scale, 102 local wrappers',
    baseline: 'docs/design/legacy-icons.baseline.json',
  },
  {
    family: 'Buttons',
    remaining: 635,
    breakdown: '619 raw buttons, 16 role="button", across 392 files',
    baseline: 'docs/design/legacy-buttons.baseline.json',
  },
  {
    family: 'Markers',
    remaining: 229,
    breakdown: '99 pills, 79 dots, 51 components',
    baseline: 'docs/design/legacy-markers.baseline.json',
  },
  {
    family: 'Feedback',
    remaining: 146,
    breakdown:
      '5 tinted boxes, 64 error texts, 68 role="alert", 9 empty recipes',
    baseline: 'docs/design/legacy-feedback.baseline.json',
  },
  {
    family: 'Loading',
    remaining: 50,
    breakdown:
      '10 LoadingPlaceholder, 16 loading-text strings, 24 raw pulse classes',
    baseline: 'docs/design/legacy-loading.baseline.json',
  },
  {
    family: 'Progress',
    remaining: 4,
    breakdown: '4 stacked chart bars waiting for a shared segments bar',
    baseline: 'docs/design/legacy-progress.baseline.json',
  },
  {
    family: 'Facts',
    remaining: 10,
    breakdown: '10 <dl> elements',
    baseline: 'docs/design/legacy-facts.baseline.json',
  },
  {
    family: 'Surfaces',
    remaining: 2962,
    breakdown:
      '1026 radius, 987 background, 876 edge, 73 shadow on raw elements, across 596 files',
    baseline: 'docs/design/legacy-surfaces.baseline.json',
  },
  {
    family: 'Tables',
    remaining: 2,
    breakdown: '1 raw <table> element, 1 hand-made role="grid"',
    baseline: 'docs/design/legacy-tables.baseline.json',
  },
  {
    family: 'Rows',
    remaining: 76,
    breakdown:
      '46 raw buttons, 4 links, 5 clickable divs, 21 hover wrappers, across 60 files',
    baseline: 'docs/design/legacy-rows.baseline.json',
  },
  {
    family: 'Avatars',
    remaining: 4,
    breakdown: '3 profile pictures, 1 local avatar, all on marketing pages',
    baseline: 'docs/design/legacy-avatars.baseline.json',
  },
  {
    family: 'Overlays',
    remaining: 9,
    breakdown: '1 backdrop, 3 body portals, 5 absolute menus',
    baseline: 'docs/design/legacy-overlays.baseline.json',
  },
  {
    family: 'Menus',
    remaining: 40,
    breakdown:
      '21 raw roles, 4 ListRow options, 6 bare surfaces, 9 hand-wired searches',
    baseline: 'docs/design/legacy-menus.baseline.json',
  },
  {
    family: 'Disclosures',
    remaining: 22,
    breakdown: '5 <details>, 13 chevron toggles, 4 local disclosure components',
    baseline: 'docs/design/legacy-disclosures.baseline.json',
  },
  {
    family: 'Headings',
    remaining: 33,
    breakdown: '33 raw <h1>…<h6>, across 27 files',
    baseline: 'docs/design/legacy-headings.baseline.json',
  },
  {
    family: 'Tooltips',
    remaining: 1,
    breakdown: '1 native title on a control',
    baseline: 'docs/design/legacy-tooltips.baseline.json',
  },
  {
    family: 'Fields',
    remaining: 0,
    breakdown: 'Done',
    baseline: 'docs/design/legacy-fields.baseline.json',
  },
];
