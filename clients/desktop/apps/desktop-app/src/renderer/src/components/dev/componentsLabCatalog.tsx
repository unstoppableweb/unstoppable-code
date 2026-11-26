import type { JSX } from 'react';
import { AvatarsSpecimen } from './componentsLabAvatars';
import { ChartsSpecimen } from './componentsLabCharts';
import { ButtonsSpecimen, ListRowSpecimen } from './componentsLabButtons';
import { ChipSection, ContextSection } from './MarkersLabPage';
import {
  FailureSpecimen,
  NoticeSpecimen,
  ToastSpecimen,
} from './componentsLabFeedback';
import { IconScaleSpecimen } from './componentsLabIcons';
import { DialogsSpecimen, MarkersSpecimen } from './componentsLabGroups';
import {
  FactsSpecimen,
  ReferenceChipsSpecimen,
  SpacingSpecimen,
  TooltipSpecimen,
} from './componentsLabLayout';
import { GAP_ROOT_3C_LAB_ENTRIES } from './componentsLabEntriesGapRoot3C';
import { GAP_ROOT_3A_LAB_ENTRIES } from './componentsLabEntriesGapRoot3A';
import { GAP_ROOT_3D_LAB_ENTRIES } from './componentsLabEntriesGapRoot3D';
import { GAP_ROOT_3B_LAB_ENTRIES } from './componentsLabEntriesGapRoot3B';
import { AGENT_ACTIVITY_LAB_ENTRIES } from './componentsLabAgentActivity';
import { CHAT_MARKERS_LAB_ENTRIES } from './componentsLabChatMarkers';
import { CHAT_QUEUE_LAB_ENTRIES } from './componentsLabChatQueue';
import { DATA_CHOICES_LAB_ENTRIES } from './componentsLabDataChoices';
import { CHAT_SUBAGENTS_LAB_ENTRIES } from './componentsLabChatSubagents';
import { CHAT_TURN_LAB_ENTRIES } from './componentsLabChatTurn';
import { AgentSentSpecimen } from './componentsLabAgentSent';
import { ComposerActionsSpecimen } from './componentsLabComposerActions';
import { AgentAliasModelSpecimen } from './componentsLabAgentAliasModel';
import { ModelSelectionSpecimen } from './componentsLabModelSelection';
import { DisclosuresSpecimen } from './componentsLabDisclosures';
import { HeadingsSpecimen } from './componentsLabHeadings';
import { LoadingSpecimen } from './componentsLabLoading';
import { KeyCapsSpecimen } from './componentsLabKeyCaps';
import { FOUNDATION_LAB_ENTRIES } from './componentsLabFoundations';
import { FORMS_LAB_ENTRIES } from './componentsLabForms';
import { REGROUPED_LAB_ENTRIES } from './componentsLabRegrouped';
import { ColorSwatchesSpecimen } from './componentsLabColorSwatches';
import { SurfacesSpecimen } from './componentsLabSurfaces';
import { OverlayOptionsSpecimen } from './componentsLabOverlayOptions';
import { SidebarPartsSpecimen } from './componentsLabSidebar';
import { ChatLookSpecimen, PlanChipSpecimen } from './componentsLabChatLook';
import {
  CustomizePartsSpecimen,
  CustomizeTileBenchmarkSpecimen,
} from './componentsLabCustomize';
import { CuratedWorkflowsSpecimen } from './componentsLabCurated';
import { WorkflowDesignerSpecimen } from './componentsLabWorkflowDesigner';
import { CreditsNoticesSpecimen } from './componentsLabCredits';
import { SyncedInventoryPausedSpecimen } from './componentsLabSyncedInventory';
import { ProviderRowsSpecimen } from './componentsLabProviderRows';
import { ProviderKeyRowSpecimen } from './componentsLabProviderKeyRow';
import { TurnNoticesSpecimen } from './componentsLabTurnNotices';
import { CopyMcpServerSpecimen } from './componentsLabCopyMcpServer';
import { McpRemovalSpecimen } from './componentsLabMcpRemoval';
import {
  CloudReachBackPromptSpecimen,
  CloudReachBackSpecimen,
} from './componentsLabCloudReachBack';
import { W5RecoverySpecimen } from './componentsLabW5Recovery';
import { BackgroundServiceSpecimen } from './componentsLabBackgroundService';
import {
  ArchiveRecoveryListSpecimen,
  WorktreeRecoverySpecimen,
  ProjectDeletionRecoverySpecimen,
} from './componentsLabArchiveRecovery';
import {
  CloudCopyGitUncheckedSpecimen,
  CloudCopyInstalledSkillSpecimen,
  CloudCopyPluginSpecimen,
} from './componentsLabCloudCopy';
import {
  GoogleSubscriptionSpecimen,
  SettingsAndAgentsSpecimen,
} from './componentsLabSettings';
import { TablesSpecimen } from './componentsLabTables';
import { DetailHeaderSpecimen } from './componentsLabDetail';
import { CustomizeDetailPagesSpecimen } from './componentsLabCustomizeDetail';
import { FilesAndDiffsSpecimen } from './componentsLabFilesAndDiffs';
import { DrawerAndEntriesSpecimen } from './componentsLabDrawerAndEntries';
import { PendingSpecimen } from './componentsLabPending';
import { InstalledStatusSpecimen } from './componentsLabInstalledStatus';
import { ReferenceAndInstructionsSpecimen } from './componentsLabReferenceAndInstructions';
import { HomeAndResumeSpecimen } from './componentsLabHomeAndResume';
import { KeysAndMarkdownSpecimen } from './componentsLabKeysAndMarkdown';
import { ProvidersSpecimen } from './componentsLabProviders';
import { ProgressSpecimen } from './componentsLabProgress';
import { SegmentedControlSpecimen, TabBarSpecimen } from './componentsLabTabs';
import { SliderSpecimen } from './componentsLabSlider';
import { InlineCodeSpecimen } from './componentsLabInlineCode';
import {
  ButtonStage,
  ChipStage,
  ListRowStage,
  MarkersStage,
  SegmentedControlStage,
  TabBarStage,
} from './componentsLabStagesControls';
import {
  DialogStage,
  FactsStage,
  FailureStage,
  LoadingStage,
  NoticeStage,
  ReferenceChipsStage,
  ToastStage,
  TooltipStage,
} from './componentsLabStagesFeedback';

export const COMPONENTS_LAB_GROUPS = ['Unified', 'Not unified yet'] as const;
export type ComponentsLabGroup = (typeof COMPONENTS_LAB_GROUPS)[number];

export interface ComponentsLabEntry {
  readonly id: string;
  readonly name: string;
  readonly group: ComponentsLabGroup;
  /** One sentence: what it is for and the rule it carries. */
  readonly note: string;
  /** Where the shared component lives. */
  readonly source: string;
  /**
   * The exported components the sheet documents, when a source file's name
   * is not one of them (`Field.tsx` exports `TextInput`). They lead the
   * sheet's import line and are searched as names.
   */
  readonly components?: readonly string[];
  /** The pull requests that unified it. */
  readonly prs: readonly number[];
  /**
   * A stageshow stage: the component in a believable Canopy window with a
   * short cursor story, above the exhaustive specimen sheet.
   */
  readonly Stage?: () => JSX.Element;
  readonly View: () => JSX.Element;
}

export const COMPONENTS_LAB_ENTRIES: readonly ComponentsLabEntry[] = [
  ...FOUNDATION_LAB_ENTRIES,
  {
    id: 'button',
    name: 'Button',
    group: 'Unified',
    note: 'Every action is a capsule Button in one of five looks: primary, secondary, ghost, ghost-destructive and destructive. Links inside a sentence use variant="link". The stage shows hover, press, busy and done.',
    source: 'packages/ui-shared/src/primitives/Button.tsx',
    prs: [7044, 7062, 7066, 7067, 7068, 7070, 7071, 7076, 7198],
    Stage: ButtonStage,
    View: ButtonsSpecimen,
  },
  {
    id: 'list-row',
    name: 'List rows',
    group: 'Unified',
    note: 'One full-width row for every list, in three forms (press, link, static) and three sizes (28, 32, 40), with quiet trailing text and actions beside the press.',
    source: 'packages/ui-shared/src/primitives/ListRow.tsx',
    prs: [7076],
    Stage: ListRowStage,
    View: ListRowSpecimen,
  },
  {
    id: 'markers',
    name: 'Badge, count, dot and status glyph',
    group: 'Unified',
    note: 'Badge (regular and compact), Count, Dot (including connection dots) and StatusGlyph: every status and count uses these.',
    source: 'packages/ui-shared/src/primitives/{Badge,StatusGlyph}.tsx',
    prs: [7209],
    Stage: MarkersStage,
    View: MarkersSpecimen,
  },
  {
    id: 'chip',
    name: 'Chip',
    group: 'Unified',
    note: 'A removable or clickable token; every look is forced so hover and press show side by side.',
    source: 'packages/ui-shared/src/primitives/Chip.tsx',
    prs: [7209],
    Stage: ChipStage,
    View: ChipSection,
  },
  {
    id: 'markers-in-context',
    name: 'Markers in context',
    group: 'Unified',
    note: 'The markers placed in the rows and headers they ship in.',
    source:
      'apps/desktop-app/src/renderer/src/components/dev/MarkersLabPage.tsx',
    prs: [7209],
    View: ContextSection,
  },
  {
    id: 'tab-bar',
    name: 'Tabs',
    group: 'Unified',
    note: 'One tab list for page, dialog and panel tabs: default or compact density, an optional count, a destructive tone and a vertical rail.',
    source: 'packages/ui-shared/src/primitives/TabBar.tsx',
    prs: [7213],
    Stage: TabBarStage,
    View: TabBarSpecimen,
  },
  {
    id: 'segmented-control',
    name: 'Segmented control',
    group: 'Unified',
    note: 'The one segmented picker for Settings and popovers: a capsule bg-depth track with a sliding capsule surface.',
    source: 'packages/ui-shared/src/primitives/SegmentedControl.tsx',
    prs: [],
    Stage: SegmentedControlStage,
    View: SegmentedControlSpecimen,
  },
  {
    id: 'slider',
    name: 'Slider',
    group: 'Unified',
    note: 'A stepped slider for a few ordered stops: drag or click to pick, arrow keys to step, Home and End for the ends. The composer effort panel uses it.',
    source: 'packages/ui-shared/src/primitives/Slider.tsx',
    prs: [],
    View: SliderSpecimen,
  },
  {
    id: 'inline-code',
    name: 'InlineCode',
    group: 'Unified',
    note: 'A branch name or path inside a sentence: secondary fill, compact padding and mono type at the size and line height of the text around it.',
    source: 'packages/ui-shared/src/primitives/InlineCode.tsx',
    prs: [],
    View: InlineCodeSpecimen,
  },
  ...FORMS_LAB_ENTRIES,
  {
    id: 'agent-alias-model',
    name: 'Agent alias model fields',
    group: 'Unified',
    note: "An Agent alias inherits its agent's model or chooses a concrete model, with separate Agent and Model errors and a clear action.",
    source: 'packages/ui-shared/src/components/AgentAliasModelFields.tsx',
    prs: [],
    View: AgentAliasModelSpecimen,
  },
  {
    id: 'model-selection-notice',
    name: 'Model selection notice',
    group: 'Unified',
    note: 'A desktop refusal and an unconfirmed model change remain distinct, with short, long and empty explanations.',
    source: 'packages/ui-shared/src/components/ModelSelectionNotice.tsx',
    prs: [],
    View: ModelSelectionSpecimen,
  },
  {
    id: 'icon-scale',
    name: 'Icons',
    group: 'Unified',
    note: 'Six named steps on every AppIcons icon; an icon with no size is sm. Never a number, width/height or a size class.',
    source: 'packages/ui-shared/src/icons/icon-size.ts',
    prs: [7236],
    View: IconScaleSpecimen,
  },
  {
    id: 'reference-chips',
    name: 'Reference chips',
    group: 'Unified',
    note: 'ID-only references in chat: an accent chip when it opens something, grey for code and paths; sized in em so it follows the copy.',
    source: 'packages/ui-shared/src/primitives/InlineMention.tsx',
    prs: [7116],
    Stage: ReferenceChipsStage,
    View: ReferenceChipsSpecimen,
  },
  {
    id: 'notice',
    name: 'Notice',
    group: 'Unified',
    note: 'A state to know about while working: four intents that tint only the icon, trailing or below actions with the primary last, and the composer, settings and toast shapes.',
    source: 'packages/ui-shared/src/primitives/Notice.tsx',
    prs: [7218, 7225, 7226, 7227, 7228, 7229, 7234],
    Stage: NoticeStage,
    View: NoticeSpecimen,
  },
  {
    id: 'toast',
    name: 'Toasts',
    group: 'Unified',
    note: 'An outcome to see once: a Notice in the toast shape inside the shared ToastStack, three at most.',
    source: 'packages/ui-shared/src/components/ToastStack.tsx',
    prs: [7218],
    Stage: ToastStage,
    View: ToastSpecimen,
  },
  {
    id: 'failures',
    name: 'Errors and empty states',
    group: 'Unified',
    note: 'ErrorBanner for a failure inside a surface, ErrorState when the whole panel failed, EmptyState and EmptyStateRow when there is nothing yet.',
    source: 'packages/ui-shared/src/primitives/StatusBlocks.tsx',
    prs: [7218, 7225, 7226, 7227, 7228, 7229, 7234, 7081],
    Stage: FailureStage,
    View: FailureSpecimen,
  },
  {
    id: 'loading',
    name: 'Skeletons and spinners',
    group: 'Unified',
    note: 'Nothing for 200ms, then a skeleton in the content’s own layout, then one slow note after 8s; spinners only inside the busy control.',
    source:
      'packages/ui-shared/src/primitives/{Skeleton,Button,busy-layers,BusyLabel}.tsx, packages/ui-shared/src/components/DelayedLoadingPlaceholder.tsx',
    prs: [7081],
    Stage: LoadingStage,
    View: LoadingSpecimen,
  },
  {
    id: 'color-swatches',
    name: 'Color swatches',
    group: 'Unified',
    note: 'ColorSwatchPicker: one row of fixed palette swatches as a radio group, each named by the color it renders in, never a free-form color.',
    source: 'packages/ui-shared/src/components/ColorSwatchPicker.tsx',
    prs: [],
    View: ColorSwatchesSpecimen,
  },
  {
    id: 'progress',
    name: 'Progress',
    group: 'Unified',
    note: 'ProgressBar (6px, label and value above it), ProgressRing (16px) inside a small control, and ProgressSteps as 12px status glyphs; tones, never colors. SegmentsBar is the stacked share beside them: chart colors, for data, not for work in progress.',
    source: 'packages/ui-shared/src/primitives/Progress.tsx',
    prs: [7358, 7364, 7365],
    View: ProgressSpecimen,
  },
  {
    id: 'charts',
    name: 'Charts',
    group: 'Unified',
    note: 'One chart kit for desktop and web: the range and granularity controls, four charts, and the tooltip and empty box every chart shares.',
    source:
      'packages/ui-app/src/charts/{charts,chart-controls}.tsx, packages/ui-shared/src/components/ChartParts.tsx',
    prs: [],
    View: ChartsSpecimen,
  },
  {
    id: 'facts',
    name: 'Fact lists',
    group: 'Unified',
    note: 'FactList for a panel’s facts and stat tiles, ValueRows for figures, Settings rows for a detail page’s facts.',
    source:
      'packages/ui-shared/src/primitives/FactList.tsx, packages/ui-shared/src/components/{settings/ValueRows,settings/SettingsRows}.tsx',
    prs: [7216, 7258],
    Stage: FactsStage,
    View: FactsSpecimen,
  },
  {
    id: 'dialogs',
    name: 'Dialogs',
    group: 'Unified',
    note: 'A small card over the app: a 16px title, content 24px from every side, actions at the bottom right. A confirmation asks one question before an action.',
    source: 'packages/ui-shared/src/primitives/{DialogModal,ConfirmDialog}.tsx',
    prs: [7215],
    Stage: DialogStage,
    View: DialogsSpecimen,
  },
  {
    id: 'customize-parts',
    name: 'Customize page parts',
    group: 'Unified',
    note: 'The Customize breadcrumb trail, Installed availability, MCP health and inline action states, a row menu with its disabled and destructive items, and the new-harness catch-up offer in each state.',
    source:
      'packages/ui-shared/src/components/{CustomizeBreadcrumbs,CustomizeInstalledUnavailable,CustomizeRowMenu,HarnessCatchUpNotice,McpRowHealth}.tsx',
    prs: [],
    View: CustomizePartsSpecimen,
  },
  {
    id: 'customize-tile-benchmark',
    name: 'Customize tile benchmark',
    group: 'Unified',
    note: 'Every New Customize tile case on one layout: MCP connected, couldn’t connect, sign in needed and disabled; plugin; curated plugin; skill; skill inside a plugin; workflow; collection; ChatGPT app with and without a stand-in; update available; shared with me; and not installed. Also the curated plugin logos.',
    source:
      'packages/ui-shared/src/components/{CustomizeInstalledRow,CustomizeRowSplitButton,CustomizeWorksWithChips}.tsx',
    prs: [],
    View: CustomizeTileBenchmarkSpecimen,
  },
  {
    id: 'customize-detail-pages',
    name: 'Customize detail pages',
    group: 'Unified',
    note: 'New Customize’s one detail layout: logo, title and type, the tile’s publisher, actions on the title row, a three-line description, facts in the fixed order (Status, Health, Marketplace, Website, Other versions, Updated, Version, then the entity’s rows) with errors on their row, Works with and Contents. Also the plugin page before it is added.',
    source:
      'packages/ui-shared/src/components/CapabilityDetailLayout.tsx, packages/ui-app/src/capability/PluginCatalogDetail.tsx',
    prs: [],
    View: CustomizeDetailPagesSpecimen,
  },
  {
    id: 'curated-workflows',
    name: 'Curated workflows',
    group: 'Unified',
    note: 'The curated catalog failure and saved-copy notices, and the preview dialog a Browse row opens in each of its states.',
    source:
      'packages/ui-shared/src/components/{CuratedCatalogNotice,CuratedPipelinePreviewDialog}.tsx',
    prs: [],
    View: CuratedWorkflowsSpecimen,
  },
  {
    id: 'workflow-designer',
    name: 'Workflow designer',
    group: 'Unified',
    note: 'The Designer view of a workflow: numbered step cards with task names, Run at the same time groups, and read-only groups with Edit in YAML for shapes it cannot show, such as the jobs a router’s routes gate. Selection opens the host’s details panel.',
    source: 'packages/ui-app/src/workflows/designer/WorkflowDesigner.tsx',
    prs: [],
    View: WorkflowDesignerSpecimen,
  },
  {
    id: 'credits-notices',
    name: 'Credits recovery notice',
    group: 'Unified',
    note: 'The out-of-credits notice in its purchase and contact-an-admin arms, with one or several detail lines.',
    source: 'packages/ui-shared/src/components/CreditsRecoveryNotice.tsx',
    prs: [],
    View: CreditsNoticesSpecimen,
  },
  {
    id: 'synced-inventory-paused-notice',
    name: 'Synced inventory paused notice',
    group: 'Unified',
    note: 'The web notice for synced lists from a computer that paused syncing, with a named computer, no name, and a long name that wraps.',
    source: 'packages/ui-shared/src/components/SyncedInventoryPausedNotice.tsx',
    prs: [10129],
    View: SyncedInventoryPausedSpecimen,
  },
  {
    id: 'provider-choice-rows',
    name: 'Provider choice rows',
    group: 'Unified',
    note: "The Switch provider dialog's rows in each recovery state, resolved through the shared decision, with the notice button each state yields.",
    source: 'packages/ui-app/src/providers/ProviderChoiceList.tsx',
    prs: [9519],
    View: ProviderRowsSpecimen,
  },
  {
    id: 'provider-key-row',
    name: 'Provider key row',
    group: 'Unified',
    note: "One provider's own API key on the web Model providers page: loading, no key, connected with and without a model count or key hint, and rejected. Connect opens the masked editor. Desktop doesn't mount it.",
    source: 'packages/ui-app/src/providers/ProviderKeyRow.tsx',
    prs: [10390],
    View: ProviderKeyRowSpecimen,
  },
  {
    id: 'cloud-turn-notices',
    name: 'Cloud chat turn notices',
    group: 'Unified',
    note: "A host's note under a turn: a desktop cloud chat turn that used a skill's last published copy. Rendered from fixtures; no desktop page shows it yet (CAN-6605).",
    source: 'packages/ui-app/src/code/TurnNotices.tsx',
    prs: [8672],
    View: TurnNoticesSpecimen,
  },
  {
    id: 'cloud-copy-mcp-server',
    name: 'Add an MCP server to the cloud account',
    group: 'Unified',
    note: "The MCP server page's Add to cloud beside Move to cloud, and its consent dialog: every saved secret is an unticked box naming it, never its value, and Add stays disabled until one is ticked. Rendered from fixtures.",
    source: 'packages/ui-app/src/capability/CopyMcpServerDialog.tsx',
    prs: [],
    View: CopyMcpServerSpecimen,
  },
  {
    id: 'mcp-removal-repair',
    name: 'Device MCP removal repair',
    group: 'Unified',
    note: 'Interactive device-only repair fixtures: discovery, validation, confirmation, busy, unavailable, errors, saved uninstall and every removal outcome. No live backend calls.',
    source: 'packages/ui-app/src/capability/McpRemovalRepair.tsx',
    prs: [],
    View: McpRemovalSpecimen,
  },
  {
    id: 'cloud-reach-back',
    name: 'Cloud chats on a desktop MCP server',
    group: 'Unified',
    note: "The MCP server page's Cloud chats row, shown only where the cloudReachBack capability is on: off, and on with the tools chosen and recent calls. Allow… opens the opt-in. Rendered from fixtures.",
    source: 'packages/ui-app/src/capability/CloudReachBackSection.tsx',
    prs: [],
    View: CloudReachBackSpecimen,
  },
  {
    id: 'cloud-reach-back-prompt',
    name: 'Cloud chat tool prompt',
    group: 'Unified',
    note: 'The prompt before a cloud chat runs a tool on this computer: the chat approval card with Allow once and Deny only. Rendered from a fixture.',
    source: 'packages/ui-app/src/capability/ReachBackApprovalDialog.tsx',
    prs: [],
    View: CloudReachBackPromptSpecimen,
  },
  {
    id: 'agent-sent',
    name: 'Agent-sent messages and lifetime limit',
    group: 'Unified',
    note: 'The title row above a message another agent sent, as a block or inline, and the helper lifetime limit notice in each state.',
    source:
      'packages/ui-shared/src/components/chat/{AgentSentTitle,subagents/panel/LifetimeLimitNoticeDisplay}.tsx',
    prs: [],
    View: AgentSentSpecimen,
  },
  {
    id: 'w5-recovery-notice',
    name: 'Workspace recovery notice',
    group: 'Unified',
    note: 'Workspace recovery in every lifecycle and refusal state, with host and target capability gates, live archive review alone or beside cold recovery, busy actions and bounded diagnostic entries.',
    source: 'packages/ui-shared/src/components/W5RecoveryNotice.tsx',
    prs: [7548],
    View: W5RecoverySpecimen,
  },
  {
    id: 'background-service-notice',
    name: 'Background service notice',
    group: 'Unified',
    note: 'The background service failure above the blocked-changes banner, as desktop and Portal render it: Try again idle, busy and failed, Restart app after a degraded startup handoff (busy and refused), endpoint repair on this or the paired computer, Portal with Copy diagnostics only, and long text.',
    source: 'packages/ui-shared/src/components/BackgroundServiceNotice.tsx',
    prs: [9872],
    View: BackgroundServiceSpecimen,
  },
  {
    id: 'archive-recovery-list',
    name: 'Archive recovery list',
    group: 'Unified',
    note: 'Fixture-only live archive list: empty, checking, error, row-less entries, long names, retained material, interrupted resolution and deletion confirmation.',
    source: 'packages/ui-app/src/worktree-discard/WorktreeRecoveryPanel.tsx',
    prs: [9361],
    View: ArchiveRecoveryListSpecimen,
  },
  {
    id: 'worktree-recovery-dialog',
    name: 'Worktree recovery dialog',
    group: 'Unified',
    note: 'Keep worktree, Release and Finish offers, busy actions and their individual confirmed, refused, interrupted and unconfirmed results. Callbacks only change fixtures.',
    source: 'packages/ui-app/src/worktree-discard/WorktreeRecoveryDialog.tsx',
    prs: [9361],
    View: WorktreeRecoverySpecimen,
  },
  {
    id: 'project-deletion-recovery',
    name: 'Discard pending recovery before project deletion',
    group: 'Unified',
    note: 'The explicit project-deletion confirmation for pending recovery: default, busy, error and long project name, with fixture-only callbacks.',
    source:
      'packages/ui-shared/src/components/ProjectDeletionDiscardDialog.tsx',
    prs: [9361],
    View: ProjectDeletionRecoverySpecimen,
  },
  {
    id: 'cloud-copy-plugin',
    name: 'Add a skill or plugin to the cloud account',
    group: 'Unified',
    note: "The consent dialog before a desktop skill or plugin goes to the cloud account: the files that go, and the secret-looking, git-ignored and linked files that don't, each with its reason and never as a choice. Rendered from fixtures.",
    source: 'packages/ui-app/src/capability/CloudCopyConsentDialog.tsx',
    prs: [],
    View: CloudCopyPluginSpecimen,
  },
  {
    id: 'cloud-copy-git-unchecked',
    name: 'Cloud copy when Git could not check the folder',
    group: 'Unified',
    note: "The same consent dialog for a skill whose folder Git couldn't check: it says so, and the other files left out still show.",
    source: 'packages/ui-app/src/capability/CloudCopyConsentDialog.tsx',
    prs: [],
    View: CloudCopyGitUncheckedSpecimen,
  },
  {
    id: 'cloud-copy-installed-skill',
    name: 'Add an installed skill to the cloud account',
    group: 'Unified',
    note: "The same consent dialog for a skill installed from GitHub, a URL or a local folder (CAN-6943): its cloud copy is never kept up to date, so there's no choice to; any later change asks again.",
    source: 'packages/ui-app/src/capability/CloudCopyConsentDialog.tsx',
    prs: [],
    View: CloudCopyInstalledSkillSpecimen,
  },
  {
    id: 'headings',
    name: 'Headings',
    group: 'Unified',
    note: 'Every heading is a Heading with a role and an outline level; a tone gives a heading status ink.',
    source: 'packages/ui-shared/src/primitives/Heading.tsx',
    prs: [],
    View: HeadingsSpecimen,
  },
  {
    id: 'spacing',
    name: 'Spacing',
    group: 'Unified',
    note: 'Sibling spacing comes from eight named roles on Stack and Inline, never a raw gap or margin.',
    source: 'packages/ui-shared/src/primitives/Stack.tsx',
    prs: [7215],
    View: SpacingSpecimen,
  },
  {
    id: 'surfaces',
    name: 'Surfaces and dividers',
    group: 'Unified',
    note: 'Every box is a Surface named by what it is (outline, group, card, raised, inset), with padding roles and a selected state; a light boundary is a Divider. Raw elements stay plain layout.',
    source: 'packages/ui-shared/src/primitives/Surface.tsx',
    prs: [],
    View: SurfacesSpecimen,
  },
  {
    id: 'selection-pill',
    name: 'Selection pill',
    group: 'Unified',
    note: 'The actions on a text selection in the file editor and the terminal: compact buttons with tooltips, Copy that shows Copied, placed in a pane or over the window.',
    source: 'packages/ui-shared/src/components/SelectionActionPill.tsx',
    prs: [],
    View: OverlayOptionsSpecimen,
  },
  {
    id: 'detail-header',
    name: 'Detail header',
    group: 'Unified',
    note: 'A detail page header (title, description, meta, actions, one notice) and the ⋯ More menu that leads its actions.',
    source:
      'packages/ui-shared/src/components/{DetailHeader,DetailMoreMenu}.tsx',
    prs: [],
    View: DetailHeaderSpecimen,
  },
  {
    id: 'files-and-diffs',
    name: 'Diff counts and file rows',
    group: 'Unified',
    note: 'DiffLineCounts, GroupedDiffStats, the root-group tree row in both presentations and the working-directory picker option.',
    source:
      'packages/ui-shared/src/components/{DiffLineCounts,GroupedDiffStats,FileRootGroupRow,DirectoryPickerOptionRow}.tsx',
    prs: [],
    View: FilesAndDiffsSpecimen,
  },
  {
    id: 'drawer-and-entries',
    name: 'Drawer actions and entry metadata',
    group: 'Unified',
    note: 'The drawer footer action and watcher control, and the source label and surface icon on Customize entries.',
    source:
      'packages/ui-shared/src/components/{DrawerInspectorAction,DrawerWatcherControl,EntrySourceLabel,EntrySurfaceIcon}.tsx',
    prs: [],
    View: DrawerAndEntriesSpecimen,
  },
  {
    id: 'tooltip-copy',
    name: 'Tooltip and copy button',
    group: 'Unified',
    note: 'One tooltip (with an optional shortcut) and one copy control that confirms in place.',
    source: 'packages/ui-shared/src/primitives/{Tooltip,CopyButton}.tsx',
    prs: [7082],
    Stage: TooltipStage,
    View: TooltipSpecimen,
  },
  {
    id: 'installed-status',
    name: 'Installed item status',
    group: 'Unified',
    note: 'The Active / Available / Disabled picker and its icon, the card control, the detail Status row with configurations and notices, and the Customize status filter.',
    source:
      'packages/ui-shared/src/components/{InstalledItemStatusPicker,InstalledItemStatusRow,InstalledStatusFilterDropdown}.tsx',
    prs: [],
    View: InstalledStatusSpecimen,
  },
  {
    id: 'reference-and-instructions',
    name: 'Reference cards, ready lines and instructions',
    group: 'Unified',
    note: 'ReferenceHoverCard with its footer facts, ReadyStatusLine, and the InstructionsEditor shared by desktop cowork projects and web workspaces.',
    source:
      'packages/ui-shared/src/components/{ReferenceHoverCard,ReadyStatusLine,InstructionsEditor}.tsx',
    prs: [],
    View: ReferenceAndInstructionsSpecimen,
  },
  {
    id: 'home-and-resume',
    name: 'Home sections, resume rows and guest gate',
    group: 'Unified',
    note: 'HomeSection (hide and restore), the interrupted-session row in its selection and queue layouts, and the guest model gate in each state.',
    source:
      'packages/ui-shared/src/components/{HomeSection,InterruptedSessionRow,GuestModelGateContent}.tsx',
    prs: [],
    View: HomeAndResumeSpecimen,
  },
  {
    id: 'key-caps',
    name: 'Key caps',
    group: 'Unified',
    note: 'A keyboard hint is one filled cap per key. On its own line a cap is a capsule; at the end of a field, a tooltip or an option row it nests, with the same inset on three sides and the control’s corner less that inset.',
    source:
      'packages/ui-shared/src/primitives/Kbd.tsx, packages/ui-shared/src/primitives/KbdChip.tsx',
    prs: [],
    View: KeyCapsSpecimen,
  },
  {
    id: 'keys-and-markdown',
    name: 'Shortcut chip and transcript markdown',
    group: 'Unified',
    note: 'A Button’s KbdChip on each look, transcript links that navigate or stay inert, and the scrolling table frame.',
    source: 'packages/ui-shared/src/components/{KbdChip,markdown-render}.tsx',
    prs: [],
    View: KeysAndMarkdownSpecimen,
  },
  {
    id: 'providers',
    name: 'Context providers',
    group: 'Unified',
    note: 'The icon style, the server-seeded layout tier and the Mermaid export services, each with a live readout and the component that reads it.',
    source:
      'packages/ui-shared/src/components/{icon-style,LayoutTierProvider,markdown-mermaid-export-context}.tsx',
    prs: [],
    View: ProvidersSpecimen,
  },
  {
    id: 'data-table',
    name: 'Tables',
    group: 'Unified',
    note: 'Every data table is the framed card: a 32px header band, 36px rows split by a hairline, numbers right-aligned; rows fill on hover only when they open something.',
    source: 'packages/ui-shared/src/primitives/DataTable.tsx',
    prs: [],
    View: TablesSpecimen,
  },
  {
    id: 'avatars',
    name: 'Avatars',
    group: 'Unified',
    note: 'DisplayAvatar: a circle for people and a rounded square for groups, grey initials or a photo with a hairline edge, an actor glyph in the same shell; five steps from 16 to 40px.',
    source: 'packages/ui-shared/src/primitives/DisplayAvatar.tsx',
    prs: [7359, 7363, 7367],
    View: AvatarsSpecimen,
  },
  ...GAP_ROOT_3C_LAB_ENTRIES,
  ...GAP_ROOT_3A_LAB_ENTRIES,
  ...GAP_ROOT_3D_LAB_ENTRIES,
  ...GAP_ROOT_3B_LAB_ENTRIES,
  ...REGROUPED_LAB_ENTRIES,
  ...CHAT_MARKERS_LAB_ENTRIES,
  ...CHAT_QUEUE_LAB_ENTRIES,
  ...DATA_CHOICES_LAB_ENTRIES,
  ...CHAT_TURN_LAB_ENTRIES,
  ...AGENT_ACTIVITY_LAB_ENTRIES,
  ...CHAT_SUBAGENTS_LAB_ENTRIES,
  {
    id: 'google-subscription',
    name: 'Google subscription',
    group: 'Unified',
    note: 'Connection, refresh and error states for personal Google subscriptions.',
    source:
      'packages/ui-shared/src/components/settings/GoogleSubscriptionRow.tsx',
    prs: [8527],
    View: GoogleSubscriptionSpecimen,
  },
  {
    id: 'settings-diff-agents',
    name: 'Settings pages, diff source and agent access',
    group: 'Unified',
    note: 'SettingsBackButton, SettingsButtonRow (open and select), SettingsSaveBar, DiffSourceSelector and AgentAccessEditor, each in every state it has.',
    source:
      'packages/ui-shared/src/components/{settings/SettingsBackButton,settings/SettingsButtonRow,settings/SettingsSaveBar,diff/DiffSourceSelector,external-agents/AgentAccessEditor}.tsx',
    prs: [],
    View: SettingsAndAgentsSpecimen,
  },
  {
    id: 'disclosures',
    name: 'Disclosures',
    group: 'Unified',
    note: 'Disclosure, and the parts for a body that lives apart from its toggle: sidebar section headers and list rows, tree toggles, the Usage rows and the settings list button, each in every state.',
    source:
      'packages/ui-shared/src/primitives/Disclosure.tsx, packages/ui-shared/src/components/{SidebarSectionToggle,SidebarToggleRow}.tsx',
    prs: [],
    View: DisclosuresSpecimen,
  },
  {
    id: 'sidebar-parts',
    name: 'Sidebar parts',
    group: 'Unified',
    note: 'The sidebar nav marker, style picker, batch-removal notice, cleanup-failure notice and dialog, and the settings save line, each in every state.',
    source:
      'packages/ui-shared/src/components/{SidebarNavMarker,SidebarStylePicker,SidebarBatchRemovalNotice,SidebarBatchRemovalDialog,SettingsSaveStatus}.tsx',
    prs: [],
    View: SidebarPartsSpecimen,
  },
  {
    id: 'chat-look',
    name: 'Look, detail and tense providers',
    group: 'Unified',
    note: 'The chat detail, app name and step tense providers with the transcript parts that read them, and a live readout of each hook.',
    source: 'packages/ui-shared/src/components/chat-look.tsx',
    prs: [],
    View: ChatLookSpecimen,
  },
  {
    id: 'composer-actions',
    name: 'Composer actions',
    group: 'Unified',
    note: 'The trailing composer action sends, stops, or runs a terminal command. The terminal label shows the run location or the last error.',
    source:
      'packages/ui-shared/src/components/{ComposerSendButton,TerminalComposerMode}.tsx',
    prs: [],
    View: ComposerActionsSpecimen,
  },
  {
    id: 'composer-plan-chip',
    name: 'Composer plan chip',
    group: 'Unified',
    note: 'The Plan chip beside + (dismissible and toggle), the Workflow chip and the Question chip, in a composer-sized box: on, off, read only, compact, disabled and long label.',
    source:
      'packages/ui-shared/src/components/{composer-plan-chip,composer-workflow-chip}.tsx',
    prs: [],
    View: PlanChipSpecimen,
  },
  {
    id: 'not-unified',
    name: 'Waiting to be unified',
    group: 'Not unified yet',
    note: 'UI that still has more than one hand-made copy, with where the copies live and the shared component each one becomes.',
    source:
      'apps/desktop-app/src/renderer/src/components/dev/componentsLabPendingData.ts',
    prs: [],
    View: PendingSpecimen,
  },
];
