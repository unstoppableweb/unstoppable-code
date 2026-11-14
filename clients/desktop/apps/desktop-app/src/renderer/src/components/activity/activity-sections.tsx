/**
 * Single registration source for the activity sections.
 *
 * `ACTIVITY_SECTIONS` drives every surface that needs the section list:
 * - `ActivityPanel` (the whole-unit 'activity-section' panel) renders the
 *   sortable stack from it,
 * - the panel registry's 'activity-card' kind resolves `instance.sectionId`
 *   against it and renders one section as a full panel,
 * - `getActivitySectionTitle` in `@/lib/panels/registry` derives tab titles
 *   and add-menu labels from it.
 *
 * Each entry's `render` takes only the worktree binding
 * ({@link ActivitySectionRenderProps}); everything else the sections need is
 * read inside the module-private container components below (stores, the
 * dispatch-pipeline modal controller, the panel-host settings callback), so a
 * section renders identically inside the stacked ActivityPanel and as a
 * standalone activity-card panel.
 *
 * react-refresh/only-export-components fires because this module deliberately
 * exports the definitions array and lookup helper alongside private container
 * components — the registration source IS the export surface (same posture as
 * `@/lib/panels/registry`).
 */
/* eslint-disable react-refresh/only-export-components */
import { ChatPluginsSection } from './ChatPluginsSection';
import {
  CloudWorkspaceFilesSection,
  useCloudWorkspaceFilesHeaderChrome,
} from './CloudWorkspaceFilesSection';
import { lazy, Suspense, type JSX, useCallback } from 'react';
import {
  AttachmentIcon,
  CognitionIcon,
  EditBigIcon,
  ChangesIcon,
  GitPullRequestIcon,
  HookIcon,
  McpServerIcon,
  PluginsIcon,
  NoteIcon,
  PipelineIcon,
  PlansIcon,
  ProcessIcon,
  RocketLaunchIcon,
  SummaryIcon,
  TasksIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { CostIcon } from '@canopy/ui-shared/components/cost';
import {
  isActivitySectionVisibleForWorkspaceType,
  type ActivityWorkspaceType,
} from '@canopy/app-state';
import type {
  ActivitySectionId,
  ActivitySurface,
  BackgroundProcess,
  ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import {
  useSelectedMcpSignIn,
  type SelectedMcpSignInResult,
} from '@/components/mcp/useSelectedMcpSignIn';
import { useResolvedChatPluginSelections } from '@/hooks/useResolvedChatPluginSelections';
import {
  chatPluginEditingState,
  setChatAuthPreferencesFromEffective,
} from '@/lib/chatPluginEditing';
import { usePanelHostState } from '@/lib/panels/panel-host-context';
import { McpServersPanelCard } from '@/components/mcp/McpServersPanelCard';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore, useWorktreeChatRenderState } from '@/stores/chatStore';
import {
  AttachmentsSection,
  useAttachmentsHeaderChrome,
} from './AttachmentsSection';
import {
  BackgroundProcessesSection,
  useBackgroundProcessesHeaderChrome,
} from './BackgroundProcessesSection';
import {
  ChangedFilesHostSection,
  useChangedFilesSectionHostModel,
} from './ChangedFilesSection';
import { HooksSection, useHooksHeaderChrome } from './HooksSection';
import { MemorySection } from './MemorySection';
import { NotesSection, useNotesHeaderChrome } from './NotesSection';
import {
  PipelineRunsSection,
  usePipelineRunsHeaderChrome,
} from './PipelineRunsSection';
import { PlansSection, usePlansHeaderChrome } from './PlansSection';
import { PromptsSection, usePromptsHeaderChrome } from './PromptsSection';
import {
  PullRequestSection,
  usePullRequestHeaderChrome,
} from './PullRequestSection';
import { ScriptsSection, useScriptsHeaderChrome } from './ScriptsSection';
import { SummarySection, useSummaryHeaderChrome } from './SummarySection';
import { TodoSection, useTodoHeaderChrome } from './TodoSection';
import { useMcpServersHeaderChrome } from '@/components/mcp/McpServersPanelCard';
import { useDispatchPipelineModal } from './useDispatchPipelineModal';
import { CloudMcpServersSectionBody } from './CloudMcpServersSection';
import { useCloudMcpServersModel } from './cloud-mcp-servers-model';

/** Worktree binding threaded into every section render. */
export interface ActivitySectionRenderProps {
  projectId: string;
  worktreeId: string;
}

/** One registered activity section: id, display title, and render. */
export interface ActivitySectionDefinition {
  readonly id: ActivitySectionId;
  readonly title: string;
  readonly icon: JSX.Element;
  readonly render: (props: ActivitySectionRenderProps) => JSX.Element;
}

const EMPTY_PROCESSES: BackgroundProcess[] = [];

const LazyCostActivitySection = lazy(() =>
  import('./cost/CostActivitySection').then((module) => ({
    default: module.CostActivitySection,
  })),
);

export {
  useAttachmentsHeaderChrome,
  useCloudWorkspaceFilesHeaderChrome,
  useBackgroundProcessesHeaderChrome,
  useHooksHeaderChrome,
  useMcpServersHeaderChrome,
  usePipelineRunsHeaderChrome,
  usePlansHeaderChrome,
  usePullRequestHeaderChrome,
  useScriptsHeaderChrome,
  useSummaryHeaderChrome,
  useTodoHeaderChrome,
  useNotesHeaderChrome,
  usePromptsHeaderChrome,
};

// ---------------------------------------------------------------------------
// Container components (module-private): parameterize what the extracted
// ActivityPanel closures used to capture — store reads keyed by the worktree,
// the dispatch-pipeline modal controller, and the panel-host settings
// callback — so `render` needs only the worktree binding.
// ---------------------------------------------------------------------------

/**
 * Changed Files + the revert modal it opens. File clicks and the header
 * "Review" button route into the Code Review takeover
 * (`useCodeReviewStore.openCodeReview`), mounted globally in `App.tsx`; this
 * section no longer owns a diff-viewer modal of its own. The revert modal was
 * previously mounted at the ActivityPanel level; it belongs to this section
 * (nothing else opens it), so a standalone changed-files card gets it too.
 */
function ChangedFilesActivitySection({
  projectId,
  worktreeId,
}: ActivitySectionRenderProps): JSX.Element {
  const model = useChangedFilesSectionHostModel({ projectId, worktreeId });
  return <ChangedFilesHostSection model={model} />;
}

function BackgroundProcessesActivitySection({
  projectId,
  worktreeId,
}: ActivitySectionRenderProps): JSX.Element {
  const worktreeKey = `${projectId}/${worktreeId}`;
  const processes = useActivityStore(
    (state): BackgroundProcess[] =>
      state.bgProcesses[worktreeKey] ?? EMPTY_PROCESSES,
  );
  return (
    <BackgroundProcessesSection
      projectId={projectId}
      worktreeId={worktreeId}
      processes={processes}
    />
  );
}

/** Pipeline Runs owns its dispatch-pipeline modal controller. */
function PipelineRunsActivitySection(): JSX.Element {
  const { openDispatchPipelineModal, dispatchPipelineModal } =
    useDispatchPipelineModal();
  return (
    <>
      <PipelineRunsSection onDispatchPipeline={openDispatchPipelineModal} />
      {dispatchPipelineModal}
    </>
  );
}

/** Scripts reads the page-shell settings callback from PanelHostContext. */
function ScriptsActivitySection({
  projectId,
  worktreeId,
}: ActivitySectionRenderProps): JSX.Element {
  const { onOpenSettingsTab } = usePanelHostState();
  return (
    <ScriptsSection
      projectId={projectId}
      worktreeId={worktreeId}
      onOpenSettings={onOpenSettingsTab}
    />
  );
}

/** Hooks reads the page-shell settings callback from PanelHostContext. */
function HooksActivitySection({
  projectId,
  worktreeId,
}: ActivitySectionRenderProps): JSX.Element {
  const { onOpenSettingsTab } = usePanelHostState();
  return (
    <HooksSection
      projectId={projectId}
      worktreeId={worktreeId}
      onOpenSettings={onOpenSettingsTab}
    />
  );
}

/**
 * MCP Servers feeds the detection hook the active chat tab's resolved plugin
 * selections (see {@link useResolvedChatPluginSelections}): the effective set,
 * inherited defaults included, for chats that inherit them. A proxy toggle
 * writes back only the chat's own choices.
 */
const EMPTY_MCP_SELECTIONS = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
  mcpServerRefs: [],
};

export function useMcpServersActivityModel({
  projectId,
  worktreeId,
}: ActivitySectionRenderProps): SelectedMcpSignInResult {
  const chatId =
    useWorktreeChatRenderState(
      `${projectId}/${worktreeId}`,
      (state) => state?.activeTabId,
    ) ?? null;
  const mcpSelections = useResolvedChatPluginSelections(
    projectId,
    worktreeId,
    chatId,
  );
  const onSelectionsChange = useCallback(
    async (next: ChatTabPluginSelections): Promise<boolean> => {
      if (!chatId) return false;
      const active =
        useChatStore.getState().worktreeChats[`${projectId}/${worktreeId}`]
          ?.activeTabId;
      if (active !== chatId) return false;
      return setChatAuthPreferencesFromEffective(
        useChatStore.getState,
        { projectId, worktreeId, chatId },
        next,
      );
    },
    [projectId, worktreeId, chatId],
  );
  return useSelectedMcpSignIn({
    selections:
      mcpSelections ??
      (projectId && worktreeId && chatId ? EMPTY_MCP_SELECTIONS : null),
    ownerKey: `${projectId}/${worktreeId}/${chatId ?? ''}`,
    getSelections: (): ChatTabPluginSelections | null => {
      if (
        !chatId ||
        useChatStore.getState().worktreeChats[`${projectId}/${worktreeId}`]
          ?.activeTabId !== chatId
      )
        return null;
      try {
        return chatPluginEditingState(useChatStore.getState(), {
          projectId,
          worktreeId,
          chatId,
        }).effective;
      } catch {
        return null;
      }
    },
    canChangeRoute: (): boolean => {
      if (!chatId) return false;
      try {
        const { tab } = chatPluginEditingState(useChatStore.getState(), {
          projectId,
          worktreeId,
          chatId,
        });
        return !tab.readOnly && tab.status !== 'streaming';
      } catch {
        return false;
      }
    },
    onSelectionsChange,
  });
}

export type McpServersActivityModel = ReturnType<
  typeof useMcpServersActivityModel
>;

interface McpServersActivitySectionBodyProps {
  readonly model: McpServersActivityModel;
}

export function McpServersActivitySectionBody({
  model,
}: McpServersActivitySectionBodyProps): JSX.Element {
  return (
    <>
      {model.notice}
      <McpServersPanelCard
        servers={model.servers}
        warnings={model.warnings}
        loading={model.loading}
        error={model.notice === undefined ? model.error : null}
        connectingKey={model.connectingKey}
        proxyUpdatingKey={model.proxyUpdatingKey}
        onConnect={model.onConnect}
        getRowNavigation={model.getRowNavigation}
        getRowSettings={model.getRowSettings}
        renderRowExtra={model.renderRowExtra}
        rowExtraLayout="footer"
        onCancelSignIn={(): void => model.cancelConnect()}
        onRefresh={(): void => {
          void model.refresh();
        }}
        onSetCanopyProxyEnabled={(server, enabled): void => {
          void model.setCanopyProxyEnabled(server, enabled);
        }}
      />
      {model.dialogs}
    </>
  );
}

function LocalMcpServersActivitySection(
  props: ActivitySectionRenderProps,
): JSX.Element {
  const detectedMcp = useMcpServersActivityModel(props);
  return <McpServersActivitySectionBody model={detectedMcp} />;
}

/**
 * The MCP servers card on its own: a cloud task's from its web core catalog
 * (CAN-6608), never this computer's detection; a local scope's as before.
 */
function McpServersActivitySection(
  props: ActivitySectionRenderProps,
): JSX.Element {
  const cloudMcp = useCloudMcpServersModel(props);
  return cloudMcp.active ? (
    <CloudMcpServersSectionBody model={cloudMcp} />
  ) : (
    <LocalMcpServersActivitySection {...props} />
  );
}

// ---------------------------------------------------------------------------
// The registration source
// ---------------------------------------------------------------------------

/**
 * Every activity section, in default display order. Adding an entry here is
 * the ONE registration step: the stacked ActivityPanel, the 'activity-card'
 * panel kind, tab titles, and the add-panel menu all derive from this array.
 * Ids must stay in sync with `ActivitySectionId` /
 * `DEFAULT_ACTIVITY_SECTION_ORDER` (unit-enforced).
 */
export const ACTIVITY_SECTIONS: readonly ActivitySectionDefinition[] = [
  {
    id: 'summary',
    title: 'Summary',
    icon: <SummaryIcon />,
    render: (): JSX.Element => <SummarySection />,
  },
  {
    id: 'changed-files',
    title: 'Changed Files',
    icon: <ChangesIcon />,
    render: (props: ActivitySectionRenderProps): JSX.Element => (
      <ChangedFilesActivitySection {...props} />
    ),
  },
  {
    id: 'pull-request',
    title: 'Pull Request',
    icon: <GitPullRequestIcon />,
    render: (props: ActivitySectionRenderProps): JSX.Element => (
      <PullRequestSection
        projectId={props.projectId}
        worktreeId={props.worktreeId}
      />
    ),
  },
  {
    id: 'background-processes',
    title: 'Agent Background Processes',
    icon: <ProcessIcon />,
    render: (props: ActivitySectionRenderProps): JSX.Element => (
      <BackgroundProcessesActivitySection {...props} />
    ),
  },
  {
    id: 'mcp-servers',
    title: 'MCP Servers',
    icon: <McpServerIcon size="sm" />,
    render: (props: ActivitySectionRenderProps): JSX.Element => (
      <McpServersActivitySection {...props} />
    ),
  },
  {
    id: 'plans',
    title: 'Plans',
    icon: <PlansIcon />,
    render: (): JSX.Element => <PlansSection />,
  },
  {
    id: 'pipeline-runs',
    title: 'Workflow runs',
    icon: <PipelineIcon />,
    render: (): JSX.Element => <PipelineRunsActivitySection />,
  },
  {
    id: 'cost',
    title: 'Cost',
    icon: <CostIcon />,
    render: (props: ActivitySectionRenderProps): JSX.Element => (
      <Suspense fallback={null}>
        <LazyCostActivitySection {...props} />
      </Suspense>
    ),
  },
  {
    id: 'scripts',
    title: 'Scripts',
    icon: <RocketLaunchIcon size="sm" />,
    render: (props: ActivitySectionRenderProps): JSX.Element => (
      <ScriptsActivitySection {...props} />
    ),
  },
  {
    id: 'hooks',
    title: 'Hooks',
    icon: <HookIcon />,
    render: (props: ActivitySectionRenderProps): JSX.Element => (
      <HooksActivitySection {...props} />
    ),
  },
  {
    id: 'todo',
    title: 'Agent Tasks',
    icon: <TasksIcon />,
    render: (): JSX.Element => <TodoSection />,
  },
  {
    id: 'plugins',
    title: 'Plugins',
    icon: <PluginsIcon />,
    render: (props) => <ChatPluginsSection {...props} />,
  },
  {
    id: 'memory',
    title: 'Memory',
    icon: <CognitionIcon />,
    render: (props: ActivitySectionRenderProps): JSX.Element => (
      <MemorySection {...props} />
    ),
  },
  {
    id: 'notes',
    title: 'Notes',
    icon: <NoteIcon />,
    render: (props: ActivitySectionRenderProps): JSX.Element => (
      <NotesSection {...props} />
    ),
  },
  {
    id: 'prompts',
    title: 'Prompts',
    icon: <EditBigIcon />,
    render: (props: ActivitySectionRenderProps): JSX.Element => (
      <PromptsSection {...props} />
    ),
  },
  {
    id: 'attachments',
    title: 'Attachments',
    icon: <AttachmentIcon />,
    render: (props: ActivitySectionRenderProps): JSX.Element => (
      <AttachmentsSection {...props} />
    ),
  },
  {
    id: 'workspace-files',
    title: 'Workspace files',
    icon: <AttachmentIcon />,
    render: (props: ActivitySectionRenderProps): JSX.Element => (
      <CloudWorkspaceFilesSection {...props} />
    ),
  },
];

/** Resolves a (possibly open-string) section id to its definition. */
export function getActivitySectionDefinition(
  sectionId: string,
): ActivitySectionDefinition | undefined {
  return ACTIVITY_SECTIONS.find((section) => section.id === sectionId);
}

/**
 * Sections available on one UX surface (the Code worktree rail vs the Cowork
 * rail). Which sections need a repository behind them is NOT declared here:
 * this delegates to the shared `isActivitySectionVisibleForWorkspaceType`
 * definition the web portal reads too, so the two hosts cannot drift
 * (CAN-2337). The Cowork surface is exactly the repoless (`'cowork'`)
 * classification; every other section is available everywhere.
 */
export function getActivitySectionsForSurface(
  surface: ActivitySurface,
): readonly ActivitySectionDefinition[] {
  const workspaceType: ActivityWorkspaceType =
    surface === 'cowork' ? 'cowork' : 'single-repo';
  return ACTIVITY_SECTIONS.filter((section) =>
    isActivitySectionVisibleForWorkspaceType(section.id, workspaceType),
  );
}
