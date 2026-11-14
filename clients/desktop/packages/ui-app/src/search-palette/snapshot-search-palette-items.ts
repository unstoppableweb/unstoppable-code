import type { PortalSessionShellState } from '@canopy/protocol/portal';
import type { SidebarChatSearchResult } from '../code/shell/sidebar-chat-search-model';
import { workspaceColor, workspaceKind } from '../code/shell/sidebar-model';
import { toRecencyMs } from '../code/shell/sidebar/sidebar-ordering';
import {
  isTreeLayout,
  sidebarRowLabel,
  type SidebarWorkspace,
  type SnapshotWorktree,
} from '../code/shell/worktree-status';
import type {
  SearchPaletteItem,
  SearchPaletteProjectBadge,
} from './search-palette-items';

type SnapshotStandaloneChat = Pick<
  PortalSessionShellState['standaloneChats'][number],
  'localId' | 'lastMessageAt' | 'createdAt'
>;

/** Where a snapshot result opens: a chat, as the sidebar search opens it, or a worktree. */
export type SnapshotSearchPaletteTarget =
  | { readonly type: 'chat'; readonly result: SidebarChatSearchResult }
  | {
      readonly type: 'worktree';
      readonly workspaceLocalId: string;
      readonly worktreeLocalId: string;
    };

export interface SnapshotSearchPaletteItem extends SearchPaletteItem {
  readonly target: SnapshotSearchPaletteTarget;
}

export interface SnapshotSearchPaletteInput {
  readonly workspaces: readonly SidebarWorkspace[];
  readonly worktrees: readonly SnapshotWorktree[];
  readonly standaloneChats: readonly SnapshotStandaloneChat[];
  /**
   * The chats the sidebar search lists, from
   * `buildSidebarChatSearchCandidates`, already scoped to the context.
   */
  readonly chats: readonly SidebarChatSearchResult[];
}

function projectBadge(workspace: SidebarWorkspace): SearchPaletteProjectBadge {
  return {
    kind: workspaceKind(workspace),
    color: workspaceColor(workspace),
    temporary: workspace.temporary === true,
    ...(workspace.avatarUrl ? { avatarUrl: workspace.avatarUrl } : {}),
  };
}

function worktreeKey(
  workspaceLocalId: string,
  worktreeLocalId: string,
): string {
  return `${workspaceLocalId}\u001f${worktreeLocalId}`;
}

function worktreeRecency(
  worktree: SnapshotWorktree | undefined,
): number | undefined {
  return (
    toRecencyMs(worktree?.lastActivityAt) ?? toRecencyMs(worktree?.createdAt)
  );
}

interface SnapshotIndex {
  readonly workspaceById: ReadonlyMap<string, SidebarWorkspace>;
  readonly worktreeByKey: ReadonlyMap<string, SnapshotWorktree>;
  readonly standaloneById: ReadonlyMap<string, SnapshotStandaloneChat>;
}

function chatItem(
  chat: SidebarChatSearchResult,
  index: SnapshotIndex,
): SnapshotSearchPaletteItem {
  const workspace =
    chat.workspaceLocalId === undefined
      ? undefined
      : index.workspaceById.get(chat.workspaceLocalId);
  const shared = {
    kind: 'chat' as const,
    title: chat.title,
    titleReplayMasked: true,
    ...(workspace ? { project: projectBadge(workspace) } : {}),
    target: { type: 'chat' as const, result: chat },
  };
  if (chat.kind === 'worktree-chat') {
    const timestamp = worktreeRecency(
      index.worktreeByKey.get(
        worktreeKey(chat.workspaceLocalId, chat.worktreeLocalId),
      ),
    );
    return {
      ...shared,
      id: `chat:${chat.workspaceLocalId}/${chat.worktreeLocalId}/${chat.chatId}`,
      context: chat.worktreeName,
      keywords: [chat.workspaceName, chat.worktreeName],
      ...(timestamp === undefined ? {} : { timestamp }),
    };
  }
  const standalone = index.standaloneById.get(chat.chatId);
  const timestamp =
    toRecencyMs(standalone?.lastMessageAt) ??
    toRecencyMs(standalone?.createdAt);
  return {
    ...shared,
    id: `chat:${chat.chatId}`,
    keywords: [chat.workspaceName],
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

function worktreeItem(
  workspace: SidebarWorkspace,
  worktree: SnapshotWorktree,
): SnapshotSearchPaletteItem {
  const title = sidebarRowLabel(workspace, worktree);
  const timestamp = worktreeRecency(worktree);
  return {
    id: `worktree:${workspace.localId}/${worktree.localId}`,
    kind: 'worktree',
    title,
    project: projectBadge(workspace),
    // A task-named worktree ends with its branch; a branch name is not repeated.
    ...(workspace.type !== 'cowork' && worktree.branch !== title
      ? { context: worktree.branch }
      : {}),
    keywords: [
      workspace.name,
      // The worktree's name, shown under its title in the sidebar.
      worktree.localId,
      worktree.branch,
      worktree.label ?? '',
    ],
    titleReplayMasked: true,
    ...(timestamp === undefined ? {} : { timestamp }),
    target: {
      type: 'worktree',
      workspaceLocalId: workspace.localId,
      worktreeLocalId: worktree.localId,
    },
  };
}

/**
 * Catalog-only placeholders and flat (Cowork) projects have no worktree
 * rows; hidden worktrees stay out, as on desktop.
 */
function listsWorktree(
  workspace: SidebarWorkspace | undefined,
  worktree: SnapshotWorktree,
): workspace is SidebarWorkspace {
  return (
    workspace !== undefined &&
    workspace.placeholder === undefined &&
    isTreeLayout(workspace) &&
    worktree.hidden !== true
  );
}

/**
 * The palette's chats and worktrees from a sidebar snapshot, for a host that
 * has no richer index (the Portal). Rows match the desktop palette's: chats
 * and worktrees lead with their project's badge, a chat ends with its
 * worktree, and a worktree whose title is a task name ends with its branch.
 * A chat's recency is its worktree's last activity, or a Cowork chat's last
 * message.
 */
export function buildSnapshotSearchPaletteItems({
  workspaces,
  worktrees,
  standaloneChats,
  chats,
}: SnapshotSearchPaletteInput): SnapshotSearchPaletteItem[] {
  const index: SnapshotIndex = {
    workspaceById: new Map(
      workspaces.map((workspace) => [workspace.localId, workspace]),
    ),
    worktreeByKey: new Map(
      worktrees.map((worktree) => [
        worktreeKey(worktree.workspaceLocalId, worktree.localId),
        worktree,
      ]),
    ),
    standaloneById: new Map(
      standaloneChats.map((chat) => [chat.localId, chat]),
    ),
  };
  const items = chats.map((chat) => chatItem(chat, index));
  for (const worktree of worktrees) {
    const workspace = index.workspaceById.get(worktree.workspaceLocalId);
    if (listsWorktree(workspace, worktree)) {
      items.push(worktreeItem(workspace, worktree));
    }
  }
  return items;
}
