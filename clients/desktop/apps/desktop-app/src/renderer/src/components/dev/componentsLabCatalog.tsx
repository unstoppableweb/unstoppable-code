import type { JSX } from 'react';
import { AvatarsSpecimen } from './componentsLabAvatars';
import { ButtonsSpecimen, ListRowSpecimen } from './componentsLabButtons';
import { ChipSection, ContextSection } from './MarkersLabPage';
import {
  FailureSpecimen,
  NoticeSpecimen,
  ToastSpecimen,
} from './componentsLabFeedback';
import { IconScaleSpecimen } from './componentsLabIcons';
import {
  DialogsSpecimen,
  FieldsSpecimen,
  MarkersSpecimen,
} from './componentsLabGroups';
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
import { CHAT_MARKERS_LAB_ENTRIES } from './componentsLabChatMarkers';
import { CHAT_QUEUE_LAB_ENTRIES } from './componentsLabChatQueue';
import { CHAT_SUBAGENTS_LAB_ENTRIES } from './componentsLabChatSubagents';
import { CHAT_TURN_LAB_ENTRIES } from './componentsLabChatTurn';
import { AgentSentSpecimen } from './componentsLabAgentSent';
import { DisclosuresSpecimen } from './componentsLabDisclosures';
import { HeadingsSpecimen } from './componentsLabHeadings';
import { LoadingSpecimen } from './componentsLabLoading';
import { SurfacesSpecimen } from './componentsLabSurfaces';
import { SidebarPartsSpecimen } from './componentsLabSidebar';
import { StatusPartsSpecimen } from './componentsLabStatus';
import { UsagePartsSpecimen } from './componentsLabUsage';
import { ChatLookSpecimen, PlanChipSpecimen } from './componentsLabChatLook';
import { SharedASpecimen } from './componentsLabSharedA';
import { SharedBSpecimen } from './componentsLabSharedB';
import { SharedCSpecimen } from './componentsLabSharedC';
import { CustomizePartsSpecimen } from './componentsLabCustomize';
import { CuratedWorkflowsSpecimen } from './componentsLabCurated';
import { CreditsNoticesSpecimen } from './componentsLabCredits';
import { W5RecoverySpecimen } from './componentsLabW5Recovery';
import { SettingsAndAgentsSpecimen } from './componentsLabSettings';
import { TablesSpecimen } from './componentsLabTables';
import { DetailHeaderSpecimen } from './componentsLabDetail';
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
import {
  ButtonStage,
  ChipStage,
  FieldsStage,
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
  {
    id: 'button',
    name: 'Button',
    group: 'Unified',
    note: 'Every action is a capsule Button; links inside a sentence use variant="link". The stage shows hover, press, busy and done.',
    source: 'packages/ui-shared/src/components/Button.tsx',
    prs: [7044, 7062, 7066, 7067, 7068, 7070, 7071, 7076, 7198],
    Stage: ButtonStage,
    View: ButtonsSpecimen,
  },
  {
    id: 'list-row',
    name: 'ListRow',
    group: 'Unified',
    note: 'One full-width row for every list, in three forms (press, link, static) and three sizes (28, 32, 40), with quiet trailing text and actions beside the press.',
    source: 'packages/ui-shared/src/components/ListRow.tsx',
    prs: [7076],
    Stage: ListRowStage,
    View: ListRowSpecimen,
  },
  {
    id: 'markers',
    name: 'Markers',
    group: 'Unified',
    note: 'Badge (regular and compact), Count, Dot (including connection dots) and StatusGlyph: every status and count uses these.',
    source:
      'packages/ui-shared/src/components/{Badge,Count,Dot,StatusGlyph}.tsx',
    prs: [7209],
    Stage: MarkersStage,
    View: MarkersSpecimen,
  },
  {
    id: 'chip',
    name: 'Chip',
    group: 'Unified',
    note: 'A removable or clickable token; every look is forced so hover and press show side by side.',
    source: 'packages/ui-shared/src/components/Chip.tsx',
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
    name: 'TabBar',
    group: 'Unified',
    note: 'One tab list for page, dialog and panel tabs: default or compact density, an optional count, a destructive tone and a vertical rail.',
    source: 'packages/ui-shared/src/components/TabBar.tsx',
    prs: [7213],
    Stage: TabBarStage,
    View: TabBarSpecimen,
  },
  {
    id: 'segmented-control',
    name: 'SegmentedControl',
    group: 'Unified',
    note: 'The one segmented picker for Settings and popovers: a bg-depth track with a sliding secondary surface, rounded or capsule.',
    source: 'packages/ui-shared/src/components/SegmentedControl.tsx',
    prs: [],
    Stage: SegmentedControlStage,
    View: SegmentedControlSpecimen,
  },
  {
    id: 'fields',
    name: 'Form fields',
    group: 'Unified',
    note: 'TextInput, TextArea, Select, SettingsSelect, SearchField, InlineTextInput, form fields, Checkbox, Radio, ChoiceList and ToggleSwitch, with every state.',
    source:
      'packages/ui-shared/src/components/{Field,FormField,InlineTextInput,Choice}.tsx',
    prs: [7214, 7219, 7220, 7221, 7222, 7223, 7224, 7255, 7257],
    Stage: FieldsStage,
    View: FieldsSpecimen,
  },
  {
    id: 'icon-scale',
    name: 'Icon scale',
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
    source: 'packages/ui-shared/src/components/InlineMention.tsx',
    prs: [7116],
    Stage: ReferenceChipsStage,
    View: ReferenceChipsSpecimen,
  },
  {
    id: 'notice',
    name: 'Notice',
    group: 'Unified',
    note: 'A state to know about while working: four intents that tint only the icon, trailing or below actions with the primary last, and the composer, settings and toast shapes.',
    source: 'packages/ui-shared/src/components/Notice.tsx',
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
    source: 'packages/ui-shared/src/components/StatusBlocks.tsx',
    prs: [7218, 7225, 7226, 7227, 7228, 7229, 7234, 7081],
    Stage: FailureStage,
    View: FailureSpecimen,
  },
  {
    id: 'loading',
    name: 'Loading',
    group: 'Unified',
    note: 'Nothing for 200ms, then a skeleton in the content’s own layout, then one slow note after 8s; spinners only inside the busy control.',
    source:
      'packages/ui-shared/src/components/{Skeleton,LoadingButton,BusyLabel,DelayedLoadingPlaceholder}.tsx',
    prs: [7081],
    Stage: LoadingStage,
    View: LoadingSpecimen,
  },
  {
    id: 'progress',
    name: 'Progress',
    group: 'Unified',
    note: 'ProgressBar (6px, label and value above it), ProgressRing (16px) inside a small control, and ProgressSteps as 12px status glyphs; tones, never colors.',
    source: 'packages/ui-shared/src/components/Progress.tsx',
    prs: [7358, 7364, 7365],
    View: ProgressSpecimen,
  },
  {
    id: 'facts',
    name: 'Fact lists',
    group: 'Unified',
    note: 'FactList for a panel’s facts and stat tiles, ValueRows for figures, Settings rows for a detail page’s facts.',
    source:
      'packages/ui-shared/src/components/{FactList,settings/ValueRows,settings/SettingsRows}.tsx',
    prs: [7216, 7258],
    Stage: FactsStage,
    View: FactsSpecimen,
  },
  {
    id: 'dialogs',
    name: 'Dialogs',
    group: 'Unified',
    note: 'DialogModal with the 24px inset, the confirm variant and dialog tabs; ConfirmDialog for a question before an action (Cancel is secondary).',
    source: 'packages/ui-shared/src/components/{DialogModal,ConfirmDialog}.tsx',
    prs: [7215],
    Stage: DialogStage,
    View: DialogsSpecimen,
  },
  {
    id: 'customize-parts',
    name: 'Customize page parts',
    group: 'Unified',
    note: 'The Customize breadcrumb trail, Installed availability, MCP health and inline action states, and a row menu with its disabled and destructive items.',
    source:
      'packages/ui-shared/src/components/{CustomizeBreadcrumbs,CustomizeInstalledUnavailable,CustomizeRowMenu,McpRowHealth}.tsx',
    prs: [],
    View: CustomizePartsSpecimen,
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
    id: 'credits-notices',
    name: 'Credits recovery notice',
    group: 'Unified',
    note: 'The out-of-credits notice in its purchase and contact-an-admin arms, with one or several detail lines.',
    source: 'packages/ui-shared/src/components/CreditsRecoveryNotice.tsx',
    prs: [],
    View: CreditsNoticesSpecimen,
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
    note: 'Workspace recovery in every lifecycle and refusal state, with host and target capability gates, busy actions and bounded diagnostic entries.',
    source: 'packages/ui-shared/src/components/W5RecoveryNotice.tsx',
    prs: [7548],
    View: W5RecoverySpecimen,
  },
  {
    id: 'headings',
    name: 'Headings',
    group: 'Unified',
    note: 'Every heading is a Heading with a role and an outline level; a tone gives a heading status ink.',
    source: 'packages/ui-shared/src/components/Heading.tsx',
    prs: [],
    View: HeadingsSpecimen,
  },
  {
    id: 'spacing',
    name: 'Spacing',
    group: 'Unified',
    note: 'Sibling spacing comes from eight named roles on Stack and Inline, never a raw gap or margin.',
    source: 'packages/ui-shared/src/components/Stack.tsx',
    prs: [7215],
    View: SpacingSpecimen,
  },
  {
    id: 'surfaces',
    name: 'Surface and Divider',
    group: 'Unified',
    note: 'Every box is a Surface named by what it is (outline, group, card, raised, inset), with padding roles and a selected state; a light boundary is a Divider. Raw elements stay plain layout.',
    source: 'packages/ui-shared/src/components/Surface.tsx',
    prs: [],
    View: SurfacesSpecimen,
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
    name: 'Tooltip and CopyButton',
    group: 'Unified',
    note: 'One tooltip (with an optional shortcut) and one copy control that confirms in place.',
    source: 'packages/ui-shared/src/components/{Tooltip,CopyButton}.tsx',
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
    name: 'DataTable',
    group: 'Unified',
    note: 'Every data table is the framed card: a 32px header band, 36px rows split by a hairline, numbers right-aligned; rows fill on hover only when they open something.',
    source: 'packages/ui-shared/src/components/DataTable.tsx',
    prs: [],
    View: TablesSpecimen,
  },
  {
    id: 'avatars',
    name: 'Avatars',
    group: 'Unified',
    note: 'DisplayAvatar: a circle for people and a rounded square for groups, grey initials or a photo with a hairline edge, an actor glyph in the same shell; five steps from 16 to 40px.',
    source: 'packages/ui-shared/src/components/DisplayAvatar.tsx',
    prs: [7359, 7363, 7367],
    View: AvatarsSpecimen,
  },
  ...GAP_ROOT_3C_LAB_ENTRIES,
  ...GAP_ROOT_3A_LAB_ENTRIES,
  ...GAP_ROOT_3D_LAB_ENTRIES,
  ...GAP_ROOT_3B_LAB_ENTRIES,
  ...CHAT_MARKERS_LAB_ENTRIES,
  ...CHAT_QUEUE_LAB_ENTRIES,
  ...CHAT_TURN_LAB_ENTRIES,
  ...CHAT_SUBAGENTS_LAB_ENTRIES,
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
      'packages/ui-shared/src/components/{Disclosure,SidebarSectionToggle,SidebarToggleRow}.tsx',
    prs: [],
    View: DisclosuresSpecimen,
  },
  {
    id: 'sidebar-parts',
    name: 'Sidebar and settings parts',
    group: 'Unified',
    note: 'The sidebar nav marker, style picker, batch-removal notice, cleanup-failure notice and dialog, and the settings save line, each in every state.',
    source:
      'packages/ui-shared/src/components/{SidebarNavMarker,SidebarStylePicker,SidebarBatchRemovalNotice,SidebarBatchRemovalDialog,SettingsSaveStatus}.tsx',
    prs: [],
    View: SidebarPartsSpecimen,
  },
  {
    id: 'status-parts',
    name: 'Notices, status and presentation parts',
    group: 'Unified',
    note: 'The skill update and stuck-agent notices, starting-point chip, chat summary, status label, store badges, slash-command primitives and the spinner and streaming presentation providers, each in every state.',
    source:
      'packages/ui-shared/src/components/{SkillUpdateNotice,StuckAgentNotice,StartingPointChip,StartChatSummary,StatusLabel,StoreBadgeLink,SlashCommandPrimitives,spinner-style,streaming-text,StandardPresentationProvider}.tsx',
    prs: [],
    View: StatusPartsSpecimen,
  },
  {
    id: 'usage-parts',
    name: 'Usage, wake and workflow parts',
    group: 'Unified',
    note: 'The usage meter and popover actions, usage-limit and wake notices, wake turn boundary, workflow last-run text, uninstall confirmation, update marker and the tooltip provider, each in every state.',
    source:
      'packages/ui-shared/src/components/{usage-indicator-meter,UsageIndicatorActions,UsageLimitNotice,UsageResetIcon,WakeParkedNotice,WakeTurnBoundary,WorkflowLastRunText,UninstallConfirmDialog,UpdateMarker,tooltip-handoff}.tsx',
    prs: [],
    View: UsagePartsSpecimen,
  },
  {
    id: 'feature-parts-a',
    name: 'Feature parts, set 1',
    group: 'Unified',
    note: 'Shared feature components from ui-shared (set 1) in each state: default, busy, disabled, empty, error and long text.',
    source: 'packages/ui-shared/src/components/',
    prs: [],
    View: SharedASpecimen,
  },
  {
    id: 'feature-parts-b',
    name: 'Feature parts, set 2',
    group: 'Unified',
    note: 'Shared feature components from ui-shared (set 2) in each state: default, busy, disabled, empty, error and long text.',
    source: 'packages/ui-shared/src/components/',
    prs: [],
    View: SharedBSpecimen,
  },
  {
    id: 'feature-parts-c',
    name: 'Feature parts, set 3',
    group: 'Unified',
    note: 'Shared feature components from ui-shared (set 3) in each state: default, busy, disabled, empty, error and long text.',
    source: 'packages/ui-shared/src/components/',
    prs: [],
    View: SharedCSpecimen,
  },
  {
    id: 'chat-look',
    name: 'Chat look',
    group: 'Unified',
    note: 'The chat look, chat detail, app name and step tense providers with the transcript parts that read them, side by side, and a live readout of each hook.',
    source: 'packages/ui-shared/src/components/chat-look.tsx',
    prs: [],
    View: ChatLookSpecimen,
  },
  {
    id: 'composer-plan-chip',
    name: 'Composer plan chip',
    group: 'Unified',
    note: 'The Plan chip beside + (dismissible and toggle) and the Question chip, in a composer-sized box: on, off, read only, compact, disabled and long label.',
    source: 'packages/ui-shared/src/components/composer-plan-chip.tsx',
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
