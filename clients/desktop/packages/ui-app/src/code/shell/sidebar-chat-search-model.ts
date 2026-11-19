import type { RemoteControlWorkspaceLayout } from '@canopy/protocol/remote-control/shell';
import { chatTabLabel } from '@canopy/protocol';
import { compareWorkspaces } from './workspace-sections-model';
import { sidebarRowLabel, workspaceLayout } from './worktree-status';

/**
 * Pure model behind the Remote Control sidebar chat search (CAN-1990).
 *
 * The sidebar tree shows workspaces → worktrees (Code) and cowork chats;
 * individual worktree chat tabs are not sidebar rows, so search flattens the
 * full chat inventory — worktree chat summaries plus standalone/cowork chats —
 * into result candidates that retain their owning-workspace context. Matching
 * is deliberately title-only: the ticket scopes search to chat discovery, not
 * transcript content.
 */

/** Minimal workspace shape needed to label and order search results. */
export interface SidebarChatSearchWorkspace {
  readonly localId?: string;
  readonly name: string;
  readonly order?: number;
  readonly type?: 'single-repo' | 'multi-repo' | 'cowork';
  /** Placement axis — decides whether this workspace owns standalone chats. */
  readonly layout?: RemoteControlWorkspaceLayout;
}

/** Minimal worktree shape needed to label worktree-chat results. */
export interface SidebarChatSearchWorktree {
  readonly localId: string;
  readonly workspaceLocalId?: string;
  readonly branch: string;
  readonly label?: string;
}

/** Minimal standalone/cowork chat shape consumed from the sidebar snapshot. */
export interface SidebarChatSearchStandaloneChat {
  readonly localId: string;
  readonly projectLocalId?: string;
  readonly title: string;
  readonly customTitle?: string;
  readonly description?: string;
  readonly archived?: boolean;
}

/**
 * Worktree chat summary input. `order`/`createdAt` mirror the desktop
 * chat-tab ordering keys so results list tabs in tab-bar order.
 */
export interface SidebarChatSearchWorktreeChat {
  readonly chatId: string;
  readonly title: string;
  readonly workspaceLocalId?: string;
  readonly worktreeLocalId?: string;
  readonly order?: number;
  readonly createdAt?: string;
}

export type SidebarChatSearchResult =
  | {
      readonly kind: 'worktree-chat';
      readonly workspaceLocalId: string;
      readonly workspaceName: string;
      readonly worktreeLocalId: string;
      readonly worktreeName: string;
      readonly chatId: string;
      readonly title: string;
    }
  | {
      readonly kind: 'standalone-chat';
      readonly workspaceLocalId?: string;
      readonly workspaceName: string;
      readonly chatId: string;
      readonly title: string;
    };

export interface SidebarChatSearchInventory {
  readonly workspaces: readonly SidebarChatSearchWorkspace[];
  readonly worktrees: readonly SidebarChatSearchWorktree[];
  readonly standaloneChats: readonly SidebarChatSearchStandaloneChat[];
  readonly worktreeChats: readonly SidebarChatSearchWorktreeChat[];
}

/**
 * Desktop chat-tab ordering: explicit `order` first (tabs carrying an order
 * sort before ones without, keeping optimistic placeholders last), then
 * `createdAt`, then `chatId`. Mirrors the web shell's
 * `selectWorktreeChatSummaries` comparator.
 */
function compareWorktreeChats(
  a: SidebarChatSearchWorktreeChat,
  b: SidebarChatSearchWorktreeChat,
): number {
  const aHas = typeof a.order === 'number';
  const bHas = typeof b.order === 'number';
  if (aHas && bHas && a.order !== b.order) {
    return (a.order ?? 0) - (b.order ?? 0);
  }
  if (aHas !== bHas) {
    return aHas ? -1 : 1;
  }
  const byCreated = (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  return byCreated !== 0 ? byCreated : a.chatId.localeCompare(b.chatId);
}

/**
 * Flatten the sidebar inventory into search candidates in sidebar order:
 * workspaces by their persisted order, worktrees in snapshot order within
 * each workspace, chats in tab-bar order within each worktree. Cowork
 * workspaces contribute their non-archived standalone chats; chats without a
 * `projectLocalId` fall to the primary (first-ordered) cowork workspace. When
 * no cowork workspace exists, the legacy `Default` folder takes EVERY active
 * standalone chat (project-bound or not) — matching
 * `StandaloneChatsSidebarSection`'s grouping.
 */
export function buildSidebarChatSearchCandidates(
  inventory: SidebarChatSearchInventory,
): SidebarChatSearchResult[] {
  const orderedWorkspaces = inventory.workspaces.slice().sort((first, second) =>
    compareWorkspaces(
      { localId: first.localId ?? '', name: first.name, order: first.order },
      {
        localId: second.localId ?? '',
        name: second.name,
        order: second.order,
      },
    ),
  );
  // Ownership of unparented standalone chats belongs to the first FLAT
  // workspace. A cloud workspace classifies as `cowork` but keeps its chats in
  // `worktrees`, so it must never win this election and absorb desktop's
  // unparented chats (REG-2819).
  const primaryCoworkId = orderedWorkspaces.find(
    (workspace) => workspaceLayout(workspace) === 'flat',
  )?.localId;
  const activeStandaloneChats = inventory.standaloneChats.filter(
    (chat) => chat.archived !== true,
  );
  const chatsByWorktree = new Map<string, SidebarChatSearchWorktreeChat[]>();
  for (const chat of inventory.worktreeChats) {
    if (chat.workspaceLocalId === undefined) continue;
    if (chat.worktreeLocalId === undefined) continue;
    const key = `${chat.workspaceLocalId}:${chat.worktreeLocalId}`;
    const group = chatsByWorktree.get(key);
    if (group === undefined) {
      chatsByWorktree.set(key, [chat]);
    } else {
      group.push(chat);
    }
  }

  const results: SidebarChatSearchResult[] = [];
  for (const workspace of orderedWorkspaces) {
    if (workspace.localId === undefined) continue;
    if (workspaceLayout(workspace) === 'flat') {
      for (const chat of activeStandaloneChats) {
        const owned =
          chat.projectLocalId === workspace.localId ||
          (chat.projectLocalId === undefined &&
            workspace.localId === primaryCoworkId);
        if (!owned) continue;
        results.push({
          kind: 'standalone-chat',
          workspaceLocalId: workspace.localId,
          workspaceName: workspace.name,
          chatId: chat.localId,
          title: chatTabLabel(chat),
        });
      }
      continue;
    }
    for (const worktree of inventory.worktrees) {
      if (worktree.workspaceLocalId !== workspace.localId) continue;
      const chats = (
        chatsByWorktree.get(`${workspace.localId}:${worktree.localId}`) ?? []
      ).sort(compareWorktreeChats);
      for (const chat of chats) {
        results.push({
          kind: 'worktree-chat',
          workspaceLocalId: workspace.localId,
          workspaceName: workspace.name,
          worktreeLocalId: worktree.localId,
          worktreeName: sidebarRowLabel(workspace, worktree),
          chatId: chat.chatId,
          title: chat.title,
        });
      }
    }
  }

  if (primaryCoworkId === undefined) {
    // The flat Default section shows EVERY active standalone chat when no
    // cowork workspace exists — including project-bound ones whose workspace
    // is absent from the snapshot — so search must too.
    for (const chat of activeStandaloneChats) {
      results.push({
        kind: 'standalone-chat',
        workspaceLocalId: undefined,
        workspaceName: 'Default',
        chatId: chat.localId,
        title: chat.title,
      });
    }
  }

  return results;
}

/**
 * Case-insensitive title filter. A blank (or whitespace-only) query returns
 * no results — hosts treat that as "search inactive" and show the grouped
 * tree instead.
 */
export function filterSidebarChatSearchResults(
  candidates: readonly SidebarChatSearchResult[],
  query: string,
): SidebarChatSearchResult[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [];
  return candidates.filter((candidate) =>
    candidate.title.toLowerCase().includes(normalized),
  );
}
