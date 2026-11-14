import { pluginDisplayAuthor, pluginDisplayName } from '@canopy/ui-shared';
import { chatTabLabel } from '@canopy/protocol';
import { describeAgentBaseModel } from '@canopy/protocol/agents';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  getModelDisplayName,
  type ChatSearchCatalogEntry,
  type ScheduledActivity,
  type AppAdvisorWatcherSummary,
  type SidebarItem,
  type WorktreeData,
  type WorktreeSummaryData,
} from '@canopy/desktop-shared/types';
import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';
import type { AgentModelDefinition } from '@canopy/execution-engine/types/agent-models';
import type { PluginInfo } from '@canopy/execution-engine/types/plugins';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { SettingsSection } from '@/components/settings/SettingsNav';
import { settingsRouteToPath } from '@canopy/protocol/settings';
import type { SettingsRoute } from '@canopy/protocol/settings';
import { openAccountOrganizationPage } from '@/lib/navigation/settings-destinations';
import type { ChatTab, WorktreeChatState } from '@/stores/chat/types';
import { isCoworkChatTarget } from '@/lib/cowork';
import { useNavigationStore } from '@/stores/navigationStore';
import { useChatStore, navigateToWorktreeChat } from '@/stores/chatStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { openArchivedContainerSurface } from '@/lib/archivedContainerNavigation';
import { openTrackedPlan } from '@/lib/plans/open-tracked-plan';
import { navigateToLiveChat } from '@/lib/navigation/live-chat-navigation';
import { workspaceColor } from '@canopy/ui-app';
import type { PaletteItem, PaletteProjectBadge } from './paletteItems';
import type { CommandExecutionResult, PaletteCommand } from './paletteCommands';

/**
 * Tier-0/tier-1 palette providers: pure builders that turn already-fetched
 * renderer store/hook snapshots into {@link PaletteItem}s. Builders never read
 * stores themselves (so they stay unit-testable); each item's `execute` closure
 * reads the latest store state at click time via `getState()`, matching the
 * existing command-palette pattern.
 */

const CLOSE: CommandExecutionResult = { closePalette: true };

export type WorktreeLabelResolver = (
  worktree: Pick<WorktreeData, 'id' | 'branchName' | 'label'>,
  project: Pick<SidebarItem, 'id' | 'type'>,
) => string;

const resolveStoredWorktreeLabel: WorktreeLabelResolver = (worktree) =>
  worktree.label?.trim() || worktree.branchName;

function firstLine(text: string, max = 80): string {
  const line = text.split('\n', 1)[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// --- Worktree / workspace label resolution -------------------------------

export interface WorktreeLabelIndex {
  /** `${projectId}/${worktreeId}` → resolved display names. */
  byKey: Map<
    string,
    { workspaceName: string; branchLabel: string; archived?: boolean }
  >;
  /** `projectId` → workspace name (covers cowork / advisor rows without a worktree). */
  byProject: Map<string, string>;
  /** `projectId` → the project's sidebar badge. */
  badges: Map<string, PaletteProjectBadge>;
}

/** A project's badge as the sidebar draws it. */
export function projectBadge(project: SidebarItem): PaletteProjectBadge {
  const temporary = project.type === 'multi-repo' && project.temporary === true;
  return {
    kind:
      project.type === 'multi-repo'
        ? 'multi-repo'
        : project.type === 'cowork'
          ? 'cowork'
          : 'single-repo',
    color: workspaceColor({
      localId: project.id,
      color: project.color,
      temporary,
    }),
    temporary,
    ...(project.type === 'single-repo' ? { repoPath: project.repoPath } : {}),
  };
}

/** Build the `${projectId}/${worktreeId}` → display-name index the chat rows join against. */
export function buildWorktreeLabelIndex(
  projects: readonly SidebarItem[],
  catalogEntries: readonly ChatSearchCatalogEntry[] = [],
  resolveWorktreeLabel: WorktreeLabelResolver = resolveStoredWorktreeLabel,
): WorktreeLabelIndex {
  const byKey = new Map<
    string,
    { workspaceName: string; branchLabel: string; archived?: boolean }
  >();
  const byProject = new Map<string, string>();
  const badges = new Map<string, PaletteProjectBadge>();
  for (const project of projects) {
    byProject.set(project.id, project.name);
    badges.set(project.id, projectBadge(project));
    if (project.type === 'cowork') {
      continue;
    }
    for (const worktree of project.worktrees) {
      byKey.set(`${project.id}/${worktree.id}`, {
        workspaceName: project.name,
        branchLabel: resolveWorktreeLabel(worktree, project),
      });
    }
  }
  for (const entry of catalogEntries) {
    if (entry.documentKind !== 'archived-container') continue;
    const workspaceName = byProject.get(entry.projectId) ?? entry.projectId;
    byKey.set(`${entry.projectId}/${entry.worktreeId}`, {
      workspaceName,
      branchLabel: entry.title,
      archived: true,
    });
  }
  return { byKey, byProject, badges };
}

function resolveChatSubtitle(
  index: WorktreeLabelIndex,
  projectId: string,
  worktreeId: string,
  fallback?: string | null,
): string | undefined {
  const info = index.byKey.get(`${projectId}/${worktreeId}`);
  if (info) {
    return `${info.workspaceName} • ${info.branchLabel}`;
  }
  return index.byProject.get(projectId) ?? fallback ?? undefined;
}

// --- Worktrees -----------------------------------------------------------

/** Worktree rows from `projectsStore.projects` (excludes cowork + hidden worktrees). */
export function buildWorktreeItems(
  projects: readonly SidebarItem[],
  summaries: Readonly<Record<string, WorktreeSummaryData>> = {},
  resolveWorktreeLabel: WorktreeLabelResolver = resolveStoredWorktreeLabel,
): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const project of projects) {
    if (project.type === 'cowork') {
      continue;
    }
    for (const worktree of project.worktrees) {
      if (worktree.hidden) {
        continue;
      }
      const projectId = project.id;
      const worktreeId = worktree.id;
      const label = resolveWorktreeLabel(worktree, project);
      const summary = summaries[`${projectId}/${worktreeId}`];
      const summaryDescription = summary?.description.trim();
      items.push({
        id: `worktree:${projectId}/${worktreeId}`,
        kind: 'worktree',
        navigation: { type: 'worktree', projectId, worktreeId },
        title: label,
        subtitle: summaryDescription
          ? `${project.name} • ${summaryDescription}`
          : project.name,
        project: projectBadge(project),
        ...(worktree.branchName && worktree.branchName !== label
          ? { context: worktree.branchName }
          : {}),
        // Generated summaries draw on chat and diff content.
        subtitleReplayBlocked: Boolean(summaryDescription),
        titleReplayMasked: true,
        subtitleReplayMasked: true,
        keywords: [
          project.name,
          // The worktree's name, shown under its title in the sidebar.
          worktreeId,
          worktree.branchName,
          worktree.label ?? '',
          summary?.title ?? '',
          summary?.description ?? '',
          ...(summary?.highlights ?? []),
          projectId,
        ],
        timestamp: Date.parse(worktree.createdAt) || undefined,
        worktreeStatus: worktree.status === 'done' ? 'done' : 'idle',
        execute: (): CommandExecutionResult => {
          useChatStore.getState().selectWorktree(projectId, worktreeId);
          useNavigationStore.getState().navigate('main');
          return CLOSE;
        },
      });
    }
  }
  return items;
}

/**
 * Retained state of a catalog entry owned by an archived container: a `null`
 * retention deadline means the container is locked ("Archived", kept until
 * deleted); a deadline means it is "Deleted" and the sweep will remove it.
 */
function catalogArchiveState(
  entry: ChatSearchCatalogEntry,
): 'archived' | 'deleted' | undefined {
  if (entry.source !== 'archived-container') return undefined;
  return entry.expiresAt === null || entry.expiresAt === undefined
    ? 'archived'
    : 'deleted';
}

/** Archived worktree / Work Entry rows from the tier-1 catalog. */
export function buildArchivedContainerItems(
  catalogEntries: readonly ChatSearchCatalogEntry[],
  index: WorktreeLabelIndex,
): PaletteItem[] {
  return catalogEntries.flatMap((entry) => {
    if (entry.documentKind !== 'archived-container') return [];
    const workspaceName =
      index.byProject.get(entry.projectId) ?? entry.projectId;
    return [
      {
        id: `archive:${entry.projectId}/${entry.worktreeId}`,
        kind: 'archive' as const,
        navigation: {
          type: 'archive' as const,
          projectId: entry.projectId,
          containerId: entry.worktreeId,
        },
        title: entry.title,
        subtitle: entry.description
          ? `${workspaceName} • ${entry.description}`
          : workspaceName,
        project: index.badges.get(entry.projectId),
        subtitleReplayBlocked: Boolean(entry.description),
        titleReplayMasked: true,
        subtitleReplayMasked: true,
        keywords: [
          workspaceName,
          entry.description ?? '',
          entry.projectId,
          entry.worktreeId,
        ],
        timestamp: entry.archivedAt ?? entry.updatedAt,
        archived: true,
        archiveState: catalogArchiveState(entry),
        execute: (): CommandExecutionResult => {
          openArchivedContainerSurface(entry.projectId, entry.worktreeId);
          return CLOSE;
        },
      },
    ];
  });
}

// --- Chats (tier 0 live + tier 1 catalog) --------------------------------

function chatDedupeKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return `${projectId}/${worktreeId}/${chatId}`;
}

function isModalOnlyChatProject(projectId: string): boolean {
  return (
    projectId === PLAN_EXPLORE_CHAT_PROJECT_ID ||
    projectId === CODE_REVIEW_CHAT_PROJECT_ID
  );
}

function buildLiveChatItem(
  projectId: string,
  worktreeId: string,
  tab: ChatTab,
  index: WorktreeLabelIndex,
): PaletteItem {
  const chatId = tab.id;
  const timestamp = tab.lastEventAt ?? (Date.parse(tab.createdAt) || undefined);
  return {
    id: `chat:${chatDedupeKey(projectId, worktreeId, chatId)}`,
    kind: 'chat',
    navigation: {
      type: 'chat',
      projectId,
      worktreeId,
      chatId,
      source: 'live',
    },
    title: chatTabLabel({ customTitle: tab.customTitle, title: tab.title }),
    subtitle: resolveChatSubtitle(
      index,
      projectId,
      worktreeId,
      tab.description,
    ),
    project: index.badges.get(projectId),
    context: index.byKey.get(`${projectId}/${worktreeId}`)?.branchLabel,
    titleReplayMasked: true,
    subtitleReplayMasked: true,
    keywords: [
      index.byKey.get(`${projectId}/${worktreeId}`)?.workspaceName ?? '',
      index.byKey.get(`${projectId}/${worktreeId}`)?.branchLabel ?? '',
      tab.description ?? '',
    ],
    timestamp,
    providerType: tab.providerType,
    archived: false,
    execute: async (): Promise<CommandExecutionResult> => {
      await navigateToWorktreeChat({
        projectId,
        worktreeId,
        chatId,
        openArchivedTranscript: false,
      });
      return CLOSE;
    },
  };
}

/**
 * Route a catalog/query chat entry to the right surface based on its `source`
 * and owning project: App Advisor window, the cowork standalone-chat surface,
 * or a worktree live/archive tab.
 */
/**
 * Open the plan's Plan panel in its owning worktree. The opener brings that
 * worktree on screen first (closing page-like viewers and waiting for its
 * chats to load) and reports a plan or worktree that is gone as a toast.
 */
function navigateToTrackedPlan(
  projectId: string,
  worktreeId: string,
  planId: string,
): void {
  void openTrackedPlan({ projectId, worktreeId, planId });
}

export async function navigateToChatCatalogEntry(
  entry: ChatSearchCatalogEntry,
): Promise<void> {
  if (entry.source === 'plan') {
    navigateToTrackedPlan(entry.projectId, entry.worktreeId, entry.chatId);
    return;
  }
  if (entry.source === 'archived-container') {
    // Chats retained inside an archived worktree/work-entry container. The
    // catalog's worktreeId slot carries the container id (the archive analog
    // of work entries occupying that slot). Must be checked BEFORE the
    // App-Advisor live-tab branch below — archived chats are not live tabs.
    // Routing per surface (code main page / cowork chat page / App Advisor
    // popout) lives in the shared helper so Cmd+K, the viewer, and the App
    // Advisor dispatcher behave identically.
    openArchivedContainerSurface(entry.projectId, entry.worktreeId, {
      chatId: entry.chatId,
    });
    return;
  }
  if (entry.projectId === APP_ADVISOR_PROJECT_ID) {
    // App Advisor chats are live tabs in its own BrowserWindow; opening the
    // window with the target `chatId` selects that exact chat's tab (the
    // App-Advisor analog of the worktree `switchTab`).
    useNavigationStore.getState().openAppAdvisor({ chatId: entry.chatId });
    return;
  }
  if (entry.source === 'cowork-archive') {
    // This action switches to the owning cowork workspace before selecting the
    // legacy archive, so cross-workspace search results cannot resolve against
    // whichever workspace happened to be active.
    await useStandaloneChatStore
      .getState()
      .openArchivedChatFromSidebar(entry.projectId, entry.chatId);
    useNavigationStore.getState().navigate('chat');
    return;
  }
  if (entry.source === 'live') {
    await navigateToLiveChat(entry);
    return;
  }
  await navigateToWorktreeChat({
    projectId: entry.projectId,
    worktreeId: entry.worktreeId,
    chatId: entry.chatId,
    openArchivedTranscript: entry.source === 'worktree-archive',
  });
}

/** Catalog sources that are chats (everything except tracked-plan docs). */
type ChatDocSource = Exclude<ChatSearchCatalogEntry['source'], 'plan'>;

function asChatDocSource(
  source: ChatSearchCatalogEntry['source'],
): ChatDocSource | null {
  return source === 'plan' ? null : source;
}

function buildCatalogChatItem(
  entry: ChatSearchCatalogEntry,
  source: ChatDocSource,
  index: WorktreeLabelIndex,
): PaletteItem {
  return {
    id: `chat:${chatDedupeKey(entry.projectId, entry.worktreeId, entry.chatId)}`,
    kind: 'chat',
    navigation: {
      type: 'chat',
      projectId: entry.projectId,
      worktreeId: entry.worktreeId,
      chatId: entry.chatId,
      source,
    },
    title: entry.title,
    titleReplayMasked: true,
    subtitleReplayMasked: true,
    subtitle: resolveChatSubtitle(
      index,
      entry.projectId,
      entry.worktreeId,
      entry.description,
    ),
    project: index.badges.get(entry.projectId),
    context: index.byKey.get(`${entry.projectId}/${entry.worktreeId}`)
      ?.branchLabel,
    keywords: [entry.description ?? '', entry.providerType ?? ''],
    timestamp: entry.updatedAt,
    providerType: entry.providerType,
    archived: entry.source !== 'live',
    archiveState: catalogArchiveState(entry),
    execute: async (): Promise<CommandExecutionResult> => {
      await navigateToChatCatalogEntry(entry);
      return CLOSE;
    },
  };
}

/**
 * Merge tier-0 live worktree chats with the tier-1 catalog, deduped by
 * `(projectId, worktreeId, chatId)` and preferring live store data. Cowork /
 * plan-explore / code-review synthetic worktree keys are excluded from tier 0
 * (they are not navigable via `navigateToWorktreeChat`); cowork chats arrive
 * additively through the catalog instead.
 */
export function buildChatItems(
  worktreeChats: Record<string, WorktreeChatState>,
  catalogEntries: readonly ChatSearchCatalogEntry[],
  index: WorktreeLabelIndex,
): PaletteItem[] {
  const byKey = new Map<string, PaletteItem>();

  for (const [scopeKey, state] of Object.entries(worktreeChats)) {
    const slash = scopeKey.indexOf('/');
    if (slash < 0) {
      continue;
    }
    const projectId = scopeKey.slice(0, slash);
    const worktreeId = scopeKey.slice(slash + 1);
    if (
      isCoworkChatTarget(projectId) ||
      isModalOnlyChatProject(projectId) ||
      (projectId === APP_ADVISOR_PROJECT_ID &&
        worktreeId === APP_ADVISOR_WORKTREE_ID)
    ) {
      continue;
    }
    for (const tab of state.tabs) {
      if (tab.kind === 'file') {
        continue;
      }
      const key = chatDedupeKey(projectId, worktreeId, tab.id);
      byKey.set(key, buildLiveChatItem(projectId, worktreeId, tab, index));
    }
  }

  for (const entry of catalogEntries) {
    if (isModalOnlyChatProject(entry.projectId)) {
      continue;
    }
    const documentKind =
      entry.documentKind ?? (entry.source === 'plan' ? 'plan' : 'chat');
    if (documentKind !== 'chat') continue;
    const source = asChatDocSource(entry.source);
    if (source === null) {
      continue; // tracked-plan docs surface through buildPlanItems
    }
    const key = chatDedupeKey(entry.projectId, entry.worktreeId, entry.chatId);
    if (byKey.has(key)) {
      continue; // prefer live store data
    }
    byKey.set(key, buildCatalogChatItem(entry, source, index));
  }

  return Array.from(byKey.values());
}

/**
 * Item ids already present as chat/plan/archive title rows, so tier-2 content
 * results can drop duplicates. Chat ids are `chat:<key>`, plan ids
 * `plan:<key>`, and archive ids `archive:<key>`.
 */
export function collectContentDedupeIds(
  items: readonly PaletteItem[],
): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (
      item.kind === 'chat' ||
      item.kind === 'plan' ||
      item.kind === 'archive'
    ) {
      ids.add(item.id);
    }
  }
  return ids;
}

// --- Tracked plans (tier 1 catalog) ---------------------------------------

/**
 * Tracked-plan title rows from the chat-search catalog.
 * Plans exist only for real workspace worktrees, so the label index always
 * applies; the review status renders as the row pill.
 */
export function buildPlanItems(
  catalogEntries: readonly ChatSearchCatalogEntry[],
  index: WorktreeLabelIndex,
): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const entry of catalogEntries) {
    const documentKind =
      entry.documentKind ?? (entry.source === 'plan' ? 'plan' : 'chat');
    if (documentKind !== 'plan') {
      continue;
    }
    const projectId = entry.projectId;
    const worktreeId = entry.worktreeId;
    const planId = entry.chatId;
    items.push({
      id: `plan:${chatDedupeKey(projectId, worktreeId, planId)}`,
      kind: 'plan',
      navigation: { type: 'plan', projectId, worktreeId, planId },
      title: entry.title,
      subtitle: resolveChatSubtitle(index, projectId, worktreeId),
      subtitleReplayMasked: true,
      keywords: [
        index.byKey.get(`${projectId}/${worktreeId}`)?.workspaceName ?? '',
        index.byKey.get(`${projectId}/${worktreeId}`)?.branchLabel ?? '',
      ],
      timestamp: entry.updatedAt,
      statusBadge: entry.reviewStatus ?? undefined,
      archived: entry.source === 'archived-container',
      archiveState: catalogArchiveState(entry),
      execute: (): CommandExecutionResult => {
        if (entry.source === 'archived-container') {
          openArchivedContainerSurface(projectId, worktreeId, {
            tab: 'plans',
            planId,
          });
        } else {
          navigateToTrackedPlan(projectId, worktreeId, planId);
        }
        return CLOSE;
      },
    });
  }
  return items;
}

// --- Pipelines -----------------------------------------------------------

export function buildPipelineItems(
  pipelines: readonly PipelineInfo[],
): PaletteItem[] {
  return pipelines.map((pipeline) => ({
    id: `pipeline:${pipeline.id}`,
    kind: 'pipeline',
    navigation: {
      type: 'pipeline',
      pipelineId: pipeline.id,
      filePath: pipeline.filePath,
    },
    title: pipeline.name,
    subtitle: pipeline.description || undefined,
    keywords: [pipeline.source, pipeline.id],
    timestamp: Date.parse(pipeline.updatedAt) || undefined,
    execute: (): CommandExecutionResult => {
      useNavigationStore.getState().openPipelineEdit({
        pipelineId: pipeline.id,
        filePath: pipeline.filePath,
      });
      return CLOSE;
    },
  }));
}

// --- Automations ---------------------------------------------------------

function describeSchedule(activity: ScheduledActivity): string {
  if (activity.schedule.kind === 'cron') {
    return `Scheduled • ${activity.schedule.expression}`;
  }
  return 'One-time automation';
}

export function buildAutomationItems(
  activities: readonly ScheduledActivity[],
): PaletteItem[] {
  return activities.map((activity) => ({
    id: `automation:${activity.id}`,
    kind: 'automation',
    navigation: { type: 'automation', activityId: activity.id },
    title: activity.name,
    subtitle: describeSchedule(activity),
    keywords: [activity.action.type, activity.enabled ? 'enabled' : 'disabled'],
    timestamp: Date.parse(activity.updatedAt) || undefined,
    statusBadge: activity.enabled ? undefined : 'OFF',
    execute: (): CommandExecutionResult => {
      useNavigationStore
        .getState()
        .openAutomationEdit({ activityId: activity.id });
      return CLOSE;
    },
  }));
}

// --- Watchers ------------------------------------------------------------

export function buildWatcherItems(
  watchers: readonly AppAdvisorWatcherSummary[],
): PaletteItem[] {
  return watchers.map((watcher) => ({
    id: `watcher:${watcher.id}`,
    kind: 'watcher',
    navigation: { type: 'watcher', watcherId: watcher.id },
    title: watcher.label,
    subtitle:
      watcher.followUpInstruction ||
      watcher.destination.chatTitle ||
      watcher.trigger,
    subtitleReplayBlocked: Boolean(watcher.followUpInstruction),
    keywords: [watcher.trigger, watcher.destination.chatTitle ?? ''],
    timestamp: Date.parse(watcher.firedAt ?? watcher.createdAt) || undefined,
    statusBadge: watcher.status === 'delivery_failed' ? 'FAILED' : undefined,
    execute: (): CommandExecutionResult => {
      // List-level fallback: the Workflows → Watchers surface has no
      // focus-a-specific-watcher-by-id deep link, so we land the user on the
      // watchers list rather than a single row. Upgrade to target-level once
      // that surface exposes a per-watcher focus hook.
      useNavigationStore.getState().navigate('watchers');
      return CLOSE;
    },
  }));
}

// --- Agents --------------------------------------------------------------

export function buildAgentItems(
  agents: readonly AgentModelDefinition[],
): PaletteItem[] {
  return agents.map((agent) => ({
    id: `agent:${agent.id}`,
    kind: 'agent',
    navigation: { type: 'agent', agentId: agent.id },
    title: agent.name,
    subtitle:
      firstLine(agent.instructions) ||
      describeAgentBaseModel(agent.baseModel, getModelDisplayName),
    subtitleReplayBlocked: Boolean(firstLine(agent.instructions)),
    keywords: [agent.baseModel],
    timestamp: Date.parse(agent.updatedAt) || undefined,
    execute: (): CommandExecutionResult => {
      useNavigationStore
        .getState()
        .openAgentReveal({ agentId: agent.id, mode: 'edit' });
      return CLOSE;
    },
  }));
}

// --- Plugins -------------------------------------------------------------

export function buildPluginItems(
  plugins: readonly PluginInfo[],
): PaletteItem[] {
  return plugins.map((plugin) => ({
    id: `plugin:${plugin.marketplaceId}:${plugin.name.toLowerCase()}`,
    kind: 'plugin',
    navigation: {
      type: 'plugin',
      marketplaceId: plugin.marketplaceId,
      pluginName: plugin.name,
    },
    title: pluginDisplayName(plugin),
    subtitle: plugin.description || undefined,
    keywords: [
      plugin.category ?? '',
      // The author the Plugins page credits, so a vendor search finds the
      // same listings in both places, plus the feed's own author: keywords
      // are matched, never shown, so crediting the vendor need not cost a
      // search for the publisher.
      pluginDisplayAuthor(plugin.marketplaceId, plugin) ?? '',
      plugin.author ?? '',
      plugin.marketplaceId,
    ],
    execute: (): CommandExecutionResult => {
      useNavigationStore.getState().openPluginsNavigation({
        kind: 'marketplace-source',
        target: 'detail',
        sourceId: plugin.marketplaceId,
        pluginKey: plugin.name,
      });
      return CLOSE;
    },
  }));
}

// --- Skills --------------------------------------------------------------

export function buildSkillItems(
  skills: readonly InstalledSkillInfo[],
): PaletteItem[] {
  return skills.map((skill) => {
    const sourceId = skill.sourceId;
    const skillName = skill.name;
    return {
      id: `skill:${sourceId}:${skillName}`,
      kind: 'skill',
      navigation: { type: 'skill', sourceId, skillName },
      title: skillName,
      subtitle: skill.description || undefined,
      keywords: [skill.source, skill.custom ? 'custom' : ''],
      timestamp: Date.parse(skill.updatedAt) || undefined,
      execute: (): CommandExecutionResult => {
        // Store-backed deep link: the pending payload survives the lazy
        // PluginsPage/SkillsTab mounts (a window CustomEvent fired here would
        // be dropped whenever those listeners are not attached yet).
        useNavigationStore.getState().openSkillViewer({ sourceId, skillName });
        return CLOSE;
      },
    };
  });
}

// --- Settings ------------------------------------------------------------

export interface SettingsSectionEntry {
  key: SettingsSection;
  label: string;
}

export function buildSettingItems(
  sections: readonly SettingsSectionEntry[],
): PaletteItem[] {
  return sections.map((section) => ({
    id: `setting:${section.key}`,
    kind: 'setting',
    navigation: { type: 'setting', section: section.key },
    title: section.label,
    subtitle: 'Settings',
    keywords: ['settings', section.key],
    execute: (): CommandExecutionResult => {
      useNavigationStore.getState().openSettings(section.key);
      return CLOSE;
    },
  }));
}

/** An account or organization page inside Settings. */
export interface AccountOrganizationPageEntry {
  route: SettingsRoute;
  label: string;
}

/**
 * The hosted account pages and the Organizations list, opened inside Settings
 * (or on the web where hosted settings are not openable). Ids carry the web
 * path under their own prefix, so they never collide with a local section.
 */
export function buildAccountOrganizationPageItems(
  entries: readonly AccountOrganizationPageEntry[],
): PaletteItem[] {
  return entries.map((entry) => {
    const path = settingsRouteToPath(entry.route);
    return {
      id: `setting-route:${path}`,
      kind: 'setting',
      navigation: { type: 'setting-route', path },
      title: entry.label,
      subtitle: 'Settings',
      keywords: ['settings', 'account', entry.label],
      execute: (): CommandExecutionResult => {
        openAccountOrganizationPage(entry.route);
        return CLOSE;
      },
    };
  });
}

// --- Commands ------------------------------------------------------------

/** Wrap the existing palette command catalog as palette items (commands sort last). */
export function buildCommandItems(
  commands: readonly PaletteCommand[],
): PaletteItem[] {
  return commands.map((command) => ({
    id: `command:${command.commandKey}`,
    kind: 'command',
    navigation: { type: 'command', commandKey: command.commandKey },
    title: command.title,
    subtitle: command.subtitle,
    titleReplayMasked: command.namesProject,
    subtitleReplayMasked: command.namesProject,
    keywords: [command.category, ...command.keywords],
    shortcut: command.shortcut,
    execute: command.execute,
  }));
}

// --- Tier-2 content results ---------------------------------------------

/**
 * Build the deferred "In content" rows from tier-2 FTS results, dropping any
 * whose document already appears as a title match (`existingTitleRowIds`). The
 * snippet becomes the subtitle and carries FTS highlight ranges.
 */
export function buildChatContentItems(
  results: readonly (ChatSearchCatalogEntry & {
    snippet: string;
    matchRanges: readonly { start: number; end: number }[];
  })[],
  index: WorktreeLabelIndex,
  existingTitleRowIds: ReadonlySet<string>,
): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const result of results) {
    if (isModalOnlyChatProject(result.projectId)) {
      continue;
    }
    const key = chatDedupeKey(
      result.projectId,
      result.worktreeId,
      result.chatId,
    );
    const documentKind =
      result.documentKind ?? (result.source === 'plan' ? 'plan' : 'chat');
    const titleRowId =
      documentKind === 'plan'
        ? `plan:${key}`
        : documentKind === 'archived-container'
          ? `archive:${result.projectId}/${result.worktreeId}`
          : `chat:${key}`;
    if (existingTitleRowIds.has(titleRowId)) {
      continue;
    }
    const workspaceLine = resolveChatSubtitle(
      index,
      result.projectId,
      result.worktreeId,
      result.description,
    );
    if (documentKind === 'archived-container') {
      items.push({
        id: `archive-content:${result.projectId}/${result.worktreeId}`,
        kind: 'chat-content',
        navigation: {
          type: 'chat-content',
          projectId: result.projectId,
          worktreeId: result.worktreeId,
          chatId: result.chatId,
          source: 'archived-container',
        },
        title: result.title,
        titleReplayMasked: true,
        subtitle: result.snippet,
        subtitleMatchRanges: result.matchRanges,
        timestamp: result.archivedAt ?? result.updatedAt,
        archived: true,
        archiveState: catalogArchiveState(result),
        execute: (): CommandExecutionResult => {
          openArchivedContainerSurface(result.projectId, result.worktreeId);
          return CLOSE;
        },
      });
      continue;
    }
    if (documentKind === 'plan') {
      const projectId = result.projectId;
      const worktreeId = result.worktreeId;
      const planId = result.chatId;
      items.push({
        id: `plan-content:${key}`,
        kind: 'plan',
        navigation: { type: 'plan', projectId, worktreeId, planId },
        title: result.title,
        subtitle: result.snippet,
        subtitleMatchRanges: result.matchRanges,
        keywords: workspaceLine ? [workspaceLine] : [],
        timestamp: result.updatedAt,
        statusBadge: result.reviewStatus ?? undefined,
        archived: result.source === 'archived-container',
        archiveState: catalogArchiveState(result),
        execute: (): CommandExecutionResult => {
          if (result.source === 'archived-container') {
            openArchivedContainerSurface(projectId, worktreeId, {
              tab: 'plans',
              planId,
            });
          } else {
            navigateToTrackedPlan(projectId, worktreeId, planId);
          }
          return CLOSE;
        },
      });
      continue;
    }
    const source = asChatDocSource(result.source);
    if (source === null) {
      continue;
    }
    items.push({
      id: `chat-content:${key}`,
      kind: 'chat-content',
      navigation: {
        type: 'chat-content',
        projectId: result.projectId,
        worktreeId: result.worktreeId,
        chatId: result.chatId,
        source,
      },
      title: result.title,
      titleReplayMasked: true,
      subtitle: result.snippet,
      subtitleMatchRanges: result.matchRanges,
      keywords: workspaceLine ? [workspaceLine] : [],
      timestamp: result.updatedAt,
      providerType: result.providerType,
      archived: result.source !== 'live',
      archiveState: catalogArchiveState(result),
      execute: async (): Promise<CommandExecutionResult> => {
        await navigateToChatCatalogEntry(result);
        return CLOSE;
      },
    });
  }
  return items;
}
