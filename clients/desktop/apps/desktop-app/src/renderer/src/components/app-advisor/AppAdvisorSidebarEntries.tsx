/**
 * The Orchestrator's chats under its row in the main sidebar, like a
 * project's chats under the project row. Rows are the shared
 * `WorkEntryRow`; status comes from the read-only chat mirrors this window
 * keeps for the row's spinner and unread marker. Choosing a row opens the
 * Orchestrator page docked in this window on that chat; its own page (the
 * single writer for its chats) selects it.
 *
 * Only chats with a message are listed: the Orchestrator page keeps one
 * empty draft entry for its new-chat state (reused, never duplicated), which
 * is not a chat yet. Pin, rename, archive and delete stay in the
 * Orchestrator's separate window for now (see
 * docs/planning/2026-11-09-orchestrator-normal-chat-layout).
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  APP_ADVISOR_PROJECT_ID,
  type CoworkWorkEntryMeta,
} from '@canopy/desktop-shared/types';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { WorkEntryRow } from '@canopy/ui-shared/components';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { useChatSidebarStore } from '@/stores/chatSidebarStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';

/**
 * How often the list refreshes while the Orchestrator page shows here, as
 * the Orchestrator's own nav does. Otherwise it refreshes when its chats'
 * status changes.
 */
const DOCKED_REFRESH_MS = 1500;

const ENTRY_KEY_PREFIX = `${APP_ADVISOR_PROJECT_ID}/`;

/** A chat: it has a message, or the person changed it (renamed, pinned). */
function isListedEntry(entry: CoworkWorkEntryMeta): boolean {
  return entry.lastMessageAt !== undefined || entry.hasUserChanges === true;
}

/** Pinned entries first, each group in registry order. */
function orderEntries(
  entries: readonly CoworkWorkEntryMeta[],
): CoworkWorkEntryMeta[] {
  return [
    ...entries.filter((entry) => entry.pinned === true),
    ...entries.filter((entry) => entry.pinned !== true),
  ];
}

/** The Orchestrator's active Work Entry, as its page last reported it. */
export function useAppAdvisorActiveEntryId(): string | null {
  return useCurrentUiStateStore((s) => {
    const slice = s.slices['appAdvisor.window'];
    if (typeof slice !== 'object' || slice === null || Array.isArray(slice)) {
      return null;
    }
    const id = slice.activeWorkEntryId;
    return typeof id === 'string' ? id : null;
  });
}

/**
 * The Orchestrator's listed chats, kept current: polled while its page
 * shows here, and refreshed whenever its chats' tabs or status change.
 */
export function useAppAdvisorSidebarEntries(
  enabled: boolean,
  docked: boolean,
): readonly CoworkWorkEntryMeta[] {
  const [entries, setEntries] = useState<CoworkWorkEntryMeta[]>([]);
  // Changes when an Orchestrator chat is added, starts or stops, or turns
  // unread: the moments its list can change while its page is elsewhere.
  const chatsSignature = useChatSidebarStore((s) =>
    Object.keys(s.worktrees)
      .filter((key) => key.startsWith(ENTRY_KEY_PREFIX))
      .sort()
      .map(
        (key) =>
          `${key}:${(s.worktrees[key]?.tabs ?? [])
            .map((tab) => `${tab.status}${tab.unread === true ? '!' : ''}`)
            .join(',')}`,
      )
      .join('|'),
  );

  useEffect(() => {
    // Only the Orchestrator page experiment lists them.
    if (!enabled) {
      setEntries([]);
      return undefined;
    }
    let cancelled = false;
    const load = (): void => {
      void window.api.workEntries
        .list({ projectId: APP_ADVISOR_PROJECT_ID })
        .then((response): void => {
          if (!cancelled) {
            setEntries(orderEntries(response.entries.filter(isListedEntry)));
          }
        })
        .catch((error: unknown) => {
          reportClientAppError(error);
        });
    };
    load();
    const timer = docked
      ? window.setInterval(load, DOCKED_REFRESH_MS)
      : undefined;
    return (): void => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [enabled, docked, chatsSignature]);

  return entries;
}

function useEntryStatus(entryId: string): {
  working: boolean;
  unread: boolean;
} {
  const working = useChatSidebarStore(
    (s) =>
      s.worktrees[`${ENTRY_KEY_PREFIX}${entryId}`]?.tabs.some(
        (tab) => tab.status === 'streaming',
      ) === true,
  );
  const unread = useChatSidebarStore(
    (s) =>
      s.worktrees[`${ENTRY_KEY_PREFIX}${entryId}`]?.tabs.some(
        (tab) => tab.unread === true,
      ) === true,
  );
  return { working, unread };
}

function AppAdvisorSidebarEntryRow({
  entry,
  selected,
}: {
  entry: CoworkWorkEntryMeta;
  selected: boolean;
}): JSX.Element {
  const { working, unread } = useEntryStatus(entry.id);
  return (
    <WorkEntryRow
      title={entry.title}
      testId={`sidebar-app-advisor-entry-${entry.id}`}
      entryId={entry.id}
      status={entry.status === 'done' ? 'done' : 'active'}
      selected={selected}
      working={working}
      hasUnread={!selected && unread}
      pinnedToTop={entry.pinned === true}
      onOpen={(): void =>
        useAppAdvisorStore.getState().openDocked({ workEntryId: entry.id })
      }
    />
  );
}

export function AppAdvisorSidebarEntries({
  entries,
  docked,
}: {
  entries: readonly CoworkWorkEntryMeta[];
  /** The Orchestrator page shows in this window: its chat is selected. */
  docked: boolean;
}): JSX.Element | null {
  const activeWorkEntryId = useAppAdvisorActiveEntryId();
  const selectedId = useMemo(
    () => (docked ? activeWorkEntryId : null),
    [docked, activeWorkEntryId],
  );
  if (entries.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-px"
      data-testid="sidebar-app-advisor-entries"
    >
      {entries.map((entry) => (
        <AppAdvisorSidebarEntryRow
          key={entry.id}
          entry={entry}
          selected={entry.id === selectedId}
        />
      ))}
    </div>
  );
}
