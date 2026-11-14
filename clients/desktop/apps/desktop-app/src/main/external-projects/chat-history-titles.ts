import type { ExternalProjectCandidate } from '@canopy/desktop-shared/types';
import { isPathInside } from '../lib/path-safety';
import type {
  ChatHistoryChatInput,
  ChatHistoryProfileInput,
  ChatHistoryProjectInput,
} from '../memory/local/chat-history-profile';
import { preferredSession } from './normalize';
import type { DiscoveredRoot, DiscoveredSession } from './types';

/**
 * One native session per id, chosen as the normalizer chooses a candidate's
 * row: a T3 Code thread and the Codex, Claude, or OpenCode session it is
 * backed by share an id and are one conversation, named by T3.
 */
function distinctNativeSessions(
  roots: readonly DiscoveredRoot[],
): DiscoveredSession[] {
  const byId = new Map<string, DiscoveredSession>();
  for (const root of roots) {
    for (const session of root.sessions) {
      if (!session.native) continue;
      const existing = byId.get(session.id);
      if (!existing) {
        byId.set(session.id, session);
        continue;
      }
      const kept = preferredSession(existing, session);
      const other = kept === existing ? session : existing;
      byId.set(session.id, { ...kept, title: kept.title ?? other.title });
    }
  }
  return Array.from(byId.values());
}

function projectsWithHistory(
  candidates: readonly ExternalProjectCandidate[],
  sessionsByCandidate: ReadonlyMap<string, readonly DiscoveredSession[]>,
  privateRoots: readonly string[],
): {
  projects: ChatHistoryProjectInput[];
  projectBySession: Map<string, string>;
} {
  const projects: ChatHistoryProjectInput[] = [];
  const projectBySession = new Map<string, string>();
  for (const candidate of candidates) {
    const candidatePaths = [
      candidate.rootPath,
      ...candidate.linkedWorktreePaths,
      ...(sessionsByCandidate.get(candidate.id) ?? []).map(
        (session) => session.cwd,
      ),
    ];
    if (
      privateRoots.some((root) =>
        candidatePaths.some(
          (candidatePath) =>
            isPathInside(root, candidatePath) ||
            isPathInside(candidatePath, root),
        ),
      )
    )
      continue;
    // A folder picked by hand carries no provider history, and one whose
    // only sessions were SDK-driven has no chats of the user's own.
    // `sessionCount` counts native chats, including those of a folder that
    // no longer exists (which the scan keeps no sessions for).
    if (candidate.providers.length === 0 || candidate.sessionCount === 0) {
      continue;
    }
    projects.push({
      name: candidate.displayName,
      chatCount: candidate.sessionCount,
    });
    for (const session of sessionsByCandidate.get(candidate.id) ?? []) {
      if (!projectBySession.has(session.id)) {
        projectBySession.set(session.id, candidate.displayName);
      }
    }
  }
  return { projects, projectBySession };
}

/**
 * What a scan says about the person who ran it (CAN-3079): the titles of
 * every native chat the adapters found, including chats in folders that are
 * not importable projects such as the home directory, and the names of the
 * projects with provider evidence. Chats the app ran itself (under its data
 * directories) and SDK-driven sessions are left out.
 */
export function collectChatHistoryProfileInput(options: {
  roots: readonly DiscoveredRoot[];
  candidates: readonly ExternalProjectCandidate[];
  sessionsByCandidate: ReadonlyMap<string, readonly DiscoveredSession[]>;
  excludedRoots: readonly string[];
  privateRoots?: readonly string[];
}): ChatHistoryProfileInput {
  const { projects, projectBySession } = projectsWithHistory(
    options.candidates,
    options.sessionsByCandidate,
    options.privateRoots ?? [],
  );
  const chats: ChatHistoryChatInput[] = [];
  for (const session of distinctNativeSessions(options.roots)) {
    if (!session.title) continue;
    // Platform-aware containment: Windows paths compare case-insensitively.
    if (options.excludedRoots.some((root) => isPathInside(root, session.cwd))) {
      continue;
    }
    if (
      options.privateRoots?.some(
        (root) =>
          isPathInside(root, session.cwd) || isPathInside(session.cwd, root),
      )
    )
      continue;
    const project = projectBySession.get(session.id);
    chats.push({
      title: session.title,
      ...(project ? { project } : {}),
      lastActivityAt: session.lastActivityAt ?? session.startedAt,
    });
  }
  return { projects, chats };
}
