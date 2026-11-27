import type { JSX, ReactNode } from 'react';
import type { ComponentsLabEntry } from './componentsLabCatalog';
import {
  AccessSheet,
  ActiveItemsSheet,
  AgentStateSheet,
  AiCreditsSheet,
  AppearanceSheet,
  ArchivedChatsListSheet,
  ArchivedChatsSheet,
  OrchestratorPluginsSheet,
  PipelineTargetSheet,
} from './componentsLabSharedA';
import { MenusSheet } from './componentsLabMenus';
import {
  BackgroundWorkCapSheet,
  BillingHistorySheet,
  BubbleCopySheet,
  CatchingUpSheet,
  ChatDetailSheet,
  ChecklistSheet,
  ClaudeFallbackSheet,
  MessageContextMenuSheet,
  OverflowMenuSheet,
} from './componentsLabSharedB';
import {
  CodexAccountModelNoticeSheet,
  ComposerAccessPickerSheet,
  ComposerDrawerSheet,
  ComposerIconButtonSheet,
  ComposerPlusMenuPresentationSheet,
  ComposerTipArbiterSheet,
  ComposerTraySheet,
  CopyDetailsButtonSheet,
  CopyFeedbackSheet,
  CreditLedgerTableSheet,
} from './componentsLabSharedC';
import {
  SkillUpdateSection,
  SlashCommandSection,
  SmoothStreamingSection,
  StandardPresentationSection,
  StartChatSummarySection,
  StartingPointSection,
  StatusLabelSection,
  StoreBadgeSection,
  StuckAgentSection,
  WorkflowSourceSection,
} from './componentsLabStatus';
import {
  TooltipHandoffSection,
  UninstallSection,
  UpdateMarkerSection,
  UsageActionsSection,
  UsageLimitSection,
  UsageMeterSection,
  WakeSection,
  WorkflowSection,
} from './componentsLabUsage';

const SRC = 'packages/ui-shared/src/components';
const PRIMITIVES_SRC = 'packages/ui-shared/src/primitives';

/** The column every specimen sheet stacks its panels in. */
function Panels({ children }: { readonly children: ReactNode }): JSX.Element {
  return <div className="flex flex-col gap-6">{children}</div>;
}

function MenusSpecimen(): JSX.Element {
  return <MenusSheet />;
}

function CopyFeedbackSpecimen(): JSX.Element {
  return (
    <Panels>
      <CopyFeedbackSheet />
      <CopyDetailsButtonSheet />
    </Panels>
  );
}

function TooltipHandoffSpecimen(): JSX.Element {
  return <TooltipHandoffSection />;
}

function AgentStateSpecimen(): JSX.Element {
  return (
    <Panels>
      <AgentStateSheet />
      <StatusLabelSection />
    </Panels>
  );
}

function ChatPresentationSpecimen(): JSX.Element {
  return (
    <Panels>
      <ChatDetailSheet />
      <SmoothStreamingSection />
      <StandardPresentationSection />
    </Panels>
  );
}

function ChatBackgroundNoticesSpecimen(): JSX.Element {
  return (
    <Panels>
      <StuckAgentSection />
      <BackgroundWorkCapSheet />
      <CatchingUpSheet />
      <WakeSection />
    </Panels>
  );
}

function ChatMessageMenusSpecimen(): JSX.Element {
  return (
    <Panels>
      <BubbleCopySheet />
      <MessageContextMenuSheet />
    </Panels>
  );
}

function ComposerPartsSpecimen(): JSX.Element {
  return (
    <Panels>
      <ComposerAccessPickerSheet />
      <ComposerPlusMenuPresentationSheet />
      <OverflowMenuSheet />
      <ComposerIconButtonSheet />
      <ComposerDrawerSheet />
      <ComposerTraySheet />
      <ComposerTipArbiterSheet />
      <StartingPointSection />
      <SlashCommandSection />
    </Panels>
  );
}

function HomePartsSpecimen(): JSX.Element {
  return (
    <Panels>
      <ChecklistSheet />
      <ArchivedChatsSheet />
      <ArchivedChatsListSheet />
      <StartChatSummarySection />
      <StoreBadgeSection />
    </Panels>
  );
}

function SettingsControlsSpecimen(): JSX.Element {
  return (
    <Panels>
      <AppearanceSheet />
      <AccessSheet />
    </Panels>
  );
}

function CustomizeStatusSpecimen(): JSX.Element {
  return (
    <Panels>
      <ActiveItemsSheet />
      <OrchestratorPluginsSheet />
      <SkillUpdateSection />
      <UninstallSection />
      <UpdateMarkerSection />
    </Panels>
  );
}

function UsageSpecimen(): JSX.Element {
  return (
    <Panels>
      <UsageMeterSection />
      <UsageActionsSection />
      <UsageLimitSection />
    </Panels>
  );
}

function BillingSpecimen(): JSX.Element {
  return (
    <Panels>
      <AiCreditsSheet />
      <ClaudeFallbackSheet />
      <BillingHistorySheet />
      <CreditLedgerTableSheet />
    </Panels>
  );
}

function CodexAccountNoticeSpecimen(): JSX.Element {
  return <CodexAccountModelNoticeSheet />;
}

function WorkflowPartsSpecimen(): JSX.Element {
  return (
    <Panels>
      <WorkflowSourceSection />
      <WorkflowSection />
      <PipelineTargetSheet />
    </Panels>
  );
}

/**
 * The shared feature components that used to sit in alphabetical sets
 * ("Feature parts, set 1" to 3, and the status and usage sets), regrouped by
 * the part of the product they belong to. Each specimen is unchanged; only
 * the sheet it appears on moved. `componentsLabPages.ts` keeps the old sheet
 * ids opening the page their first specimen moved to.
 */
export const REGROUPED_LAB_ENTRIES: readonly ComponentsLabEntry[] = [
  {
    id: 'menus',
    name: 'Menus',
    group: 'Unified',
    note: 'The row every right-click and … menu shares: a leading icon, groups split by a separator, submenus beside their row, and removal rows in their own group at the bottom.',
    source: `${PRIMITIVES_SRC}/ActionMenuItems.tsx, ${PRIMITIVES_SRC}/MenuItem.tsx, ${SRC}/SpaceNotificationMenu.tsx`,
    prs: [],
    View: MenusSpecimen,
  },
  {
    id: 'copy-feedback',
    name: 'Copy feedback',
    group: 'Unified',
    note: 'A copy control that confirms in place and announces Copied, and the button that copies a failure’s raw details without showing them.',
    source: `${SRC}/{copy-feedback,CopyDetailsButton}.tsx`,
    prs: [],
    View: CopyFeedbackSpecimen,
  },
  {
    id: 'tooltip-handoff',
    name: 'Tooltip handoff',
    group: 'Unified',
    note: 'Whether tooltips may stack: with a single-tooltip provider, the tooltip or card that opens closes the one already open.',
    source: `${SRC}/tooltip-handoff.tsx`,
    prs: [],
    View: TooltipHandoffSpecimen,
  },
  {
    id: 'agent-state',
    name: 'Agent state and status labels',
    group: 'Unified',
    note: 'What an agent is doing, as a row or tab shows it (a turn running, or only background work), and a row’s status in its state’s ink.',
    source: `${SRC}/AgentStateGlyph.tsx, ${PRIMITIVES_SRC}/StatusLabel.tsx`,
    prs: [],
    View: AgentStateSpecimen,
  },
  {
    id: 'chat-presentation',
    name: 'Chat detail and presentation',
    group: 'Unified',
    note: 'The chat detail control, smooth streaming, and the standard presentation desktop and web chats share.',
    source: `${SRC}/{ChatDetailControl,streaming-text,StandardPresentationProvider}.tsx`,
    prs: [],
    View: ChatPresentationSpecimen,
  },
  {
    id: 'chat-background-notices',
    name: 'Background work notices',
    group: 'Unified',
    note: 'The stuck-agent, background work cap and catching-up notices, and the wake notices around a parked turn.',
    source: `${SRC}/{StuckAgentNotice,BackgroundWorkCapNotice,CatchingUpNotice,WakeParkedNotice,WakeTurnBoundary}.tsx`,
    prs: [],
    View: ChatBackgroundNoticesSpecimen,
  },
  {
    id: 'chat-message-menus',
    name: 'Message copy badge and menu',
    group: 'Unified',
    note: 'The copy badge on a message bubble and the message’s context menu.',
    source: `${SRC}/{BubbleCopyBadge,ChatMessageContextMenu}.tsx`,
    prs: [],
    View: ChatMessageMenusSpecimen,
  },
  {
    id: 'composer-parts',
    name: 'Composer menus, drawer and tray',
    group: 'Unified',
    note: 'The access picker, plus and overflow menus, icon button, drawer, tray and tip arbiter around the composer, with the starting-point chip and slash command rows.',
    source: `${SRC}/{ComposerAccessPicker,ComposerPlusMenuPresentation,ChatComposerOverflowMenu,ComposerIconButton,ComposerDrawer,ComposerTray,composer-tip-arbiter,StartingPointChip,SlashCommandPrimitives}.tsx`,
    prs: [],
    View: ComposerPartsSpecimen,
  },
  {
    id: 'home-parts',
    name: 'Checklist, archived chats and chat summary',
    group: 'Unified',
    note: 'The checklist row’s action and dismiss controls, the archived chats card and its list, the start-chat summary and the store badges.',
    source: `${SRC}/{ChecklistControls,ArchivedChatsCard,ArchivedChatsList,StartChatSummary,StoreBadgeLink}.tsx`,
    components: ['ArchivedChatsList'],
    prs: [],
    View: HomePartsSpecimen,
  },
  {
    id: 'settings-controls',
    name: 'Appearance and agent access',
    group: 'Unified',
    note: 'The appearance select and the project agent access control.',
    source: `${SRC}/{AppearanceSelect,AppAdvisorProjectAgentAccessControl}.tsx`,
    prs: [],
    View: SettingsControlsSpecimen,
  },
  {
    id: 'customize-status',
    name: 'Active items, plugins and updates',
    group: 'Unified',
    note: 'The Settings summary of what loads into every new chat, the plugin selection, skill update notices, the uninstall confirmation and the update marker.',
    source: `${SRC}/{ActiveItemsSummary,SkillUpdateNotice,UninstallConfirmDialog,UpdateMarker}.tsx`,
    prs: [],
    View: CustomizeStatusSpecimen,
  },
  {
    id: 'usage',
    name: 'Usage meter and limits',
    group: 'Unified',
    note: 'The usage meter (accent, warning from 70%, destructive from 90%), its popover actions and the usage-limit notice.',
    source: `${SRC}/{usage-indicator-meter,UsageIndicatorActions,UsageLimitNotice}.tsx`,
    prs: [],
    View: UsageSpecimen,
  },
  {
    id: 'billing',
    name: 'Credits and billing tables',
    group: 'Unified',
    note: 'The credits check feedback and stop line, the credits fallback notice, and the billing history and credit ledger tables.',
    source: `${SRC}/{AiCreditsCheckFeedback,AiCreditsStopLine,ClaudeAiCreditsFallbackErrorNotice,BillingHistoryTable,CreditLedgerTable}.tsx`,
    prs: [],
    View: BillingSpecimen,
  },
  {
    id: 'codex-account-notice',
    name: 'Codex account model notice',
    group: 'Unified',
    note: 'The notice for a turn the signed-in ChatGPT account was refused because it cannot use the model, shown in place of the raw error.',
    source: `${SRC}/CodexAccountModelNotice.tsx`,
    prs: [],
    View: CodexAccountNoticeSpecimen,
  },
  {
    id: 'workflow-parts',
    name: 'Workflow source, last run and target',
    group: 'Unified',
    note: 'A workflow’s source label, its last-run text, and the target fields of an automation.',
    source: `${SRC}/{EntrySourceLabel,WorkflowLastRunText,AutomationPipelineTargetFields}.tsx`,
    prs: [],
    View: WorkflowPartsSpecimen,
  },
];
