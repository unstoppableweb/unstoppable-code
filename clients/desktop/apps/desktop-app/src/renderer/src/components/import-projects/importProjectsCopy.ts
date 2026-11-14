import {
  CHAT_LABEL,
  WORKTREE_LABEL,
  WORKTREE_UNIT_LABEL,
} from '@canopy/protocol';
import type {
  ExternalProjectCandidate,
  ExternalProjectProvider,
  ExternalProjectSessionSummary,
} from '@canopy/desktop-shared/types';

export const CODE_PROJECT_LABEL = `${WORKTREE_LABEL} project`;
export const COWORK_PROJECT_LABEL = `${CHAT_LABEL} project`;

/**
 * Shared by the import modal and Settings. A general reminder, not a report
 * on the folder's git state: uncommitted or unpushed work stays behind.
 */
export const CODE_CHAT_DESTINATION_NOTE = `Chats from ${CODE_PROJECT_LABEL}s open in a new ${WORKTREE_UNIT_LABEL.toLowerCase()}, so commit and push your work before you import.`;

/** Leads the import modal's choose phase. */
export const IMPORT_SAFETY_NOTE = `Your folders stay put and nothing changes until you say so. ${CODE_CHAT_DESTINATION_NOTE}`;

/** Each import source's product name, as the tool itself writes it. */
export const providerDisplayName: Record<ExternalProjectProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  t3code: 'T3 Code',
  opencode: 'OpenCode',
};

/**
 * Title of the notice on a chat imported as history. The source comes from a
 * persisted tab, so a name the table lacks falls back to a generic title.
 */
export function importedChatNoticeTitle(
  provider: ExternalProjectProvider,
): string {
  const name: string | undefined = providerDisplayName[provider];
  return name ? `Imported from ${name}` : 'Imported chat';
}

/** The order every list of import sources is written in. */
export const IMPORT_SOURCE_ORDER: readonly ExternalProjectProvider[] = [
  'claude',
  'codex',
  't3code',
  'opencode',
];

/** Stands in for the sources when none, or more than two, are named. */
export const OTHER_TOOLS_LABEL = 'other tools';

/** The given sources once each, in {@link IMPORT_SOURCE_ORDER}. */
export function orderedSources(
  providers: Iterable<ExternalProjectProvider>,
): ExternalProjectProvider[] {
  const present = new Set(providers);
  return IMPORT_SOURCE_ORDER.filter((provider) => present.has(provider));
}

/**
 * The sources a presence or scan record marks as found. A presence answer
 * from an older host carries no per-provider record, which names no source.
 */
export function detectedSources(
  detected: Readonly<Record<ExternalProjectProvider, boolean>> | undefined,
): ExternalProjectProvider[] {
  if (!detected) return [];
  return IMPORT_SOURCE_ORDER.filter((provider) => detected[provider]);
}

/**
 * The short name for where an import reads from: one or two tools by name
 * (`Claude and T3 Code`), otherwise `other tools`, and the surface lists the
 * names in its description line instead.
 */
export function importSourcesLabel(
  detected: Iterable<ExternalProjectProvider>,
): string {
  const names = orderedSources(detected).map(
    (provider) => providerDisplayName[provider],
  );
  return names.length === 0 || names.length > 2
    ? OTHER_TOOLS_LABEL
    : names.join(' and ');
}

/** Every source by name: `Claude`, `Claude and Codex`, `Claude, Codex, and T3 Code`. */
export function importSourcesList(
  providers: Iterable<ExternalProjectProvider>,
  conjunction: 'and' | 'or',
): string {
  const names = orderedSources(providers).map(
    (provider) => providerDisplayName[provider],
  );
  if (names.length <= 2) return names.join(` ${conjunction} `);
  const last = names.pop() ?? '';
  return `${names.join(', ')}, ${conjunction} ${last}`;
}

// `${label} projects` reads well for named tools only; the fallback label
// takes "from" (`projects from other tools`, not `other tools projects`).
function labelled(noun: string, label: string): string {
  return label === OTHER_TOOLS_LABEL
    ? `${noun} from ${OTHER_TOOLS_LABEL}`
    : `${label} ${noun}`;
}

/** `Claude projects`, or `projects from other tools`. */
export function sourceProjects(label: string): string {
  return labelled('projects', label);
}

/** `Claude data`, or `data from other tools`. */
export function sourceData(label: string): string {
  return labelled('data', label);
}

export function chatCountLabel(count: number): string {
  return count === 1 ? '1 chat' : `${count} chats`;
}

/** How many chat titles a row's `Show chats` list names before `N more`. */
const MAX_LISTED_CHAT_TITLES = 3;

// The results summary's count, the row note and the row's chat tag use one
// phrase, so the three agree.
export const HISTORY_ONLY = 'history only';

/** The `Show chats` tag: the same phrase in sentence case. */
export const HISTORY_ONLY_TAG =
  HISTORY_ONLY.charAt(0).toUpperCase() + HISTORY_ONLY.slice(1);

/**
 * The row's chats checkbox. A project imported before stays eligible while
 * it has chats Canopy has not imported, so the label counts those when they
 * are fewer than the total the meta line shows.
 */
export function importChatsLabel(candidate: ExternalProjectCandidate): string {
  const fresh = candidate.importableSessionCount;
  if (fresh >= candidate.sessionCount) return 'Import chats';
  return fresh === 1 ? 'Import 1 new chat' : `Import ${fresh} new chats`;
}

/** Explains the history-only tier wherever a row's note mentions it. */
export const HISTORY_ONLY_EXPLANATION =
  'History-only chats import as read-only messages';

/**
 * Whether a listed chat imports as read-only history: OpenCode sessions,
 * T3 Code's own text copies, and T3 Code threads run on OpenCode (which
 * carry the native tier but still cannot continue). Keyed on `continuable`,
 * not `tier`, so those last ones are counted too.
 */
function isHistoryOnly(session: ExternalProjectSessionSummary): boolean {
  return !session.continuable;
}

/** How a row's chats import. */
export interface ChatTierCounts {
  readonly archived: number;
  readonly historyOnly: number;
  readonly continuing: number;
}

/**
 * Counts a row's chats, or null when discovery listed only the newest of
 * them (it caps the list): counts of the listed ones would not add up to
 * the total the row shows, so the row keeps only the total.
 */
export function chatTierCounts(
  candidate: ExternalProjectCandidate,
): ChatTierCounts | null {
  if (candidate.sessions.length < candidate.sessionCount) return null;
  const historyOnly = candidate.sessions.filter(isHistoryOnly).length;
  return {
    archived: candidate.sessions.filter((session) => session.archived === true)
      .length,
    historyOnly,
    continuing: candidate.sessions.length - historyOnly,
  };
}

// Display only: shows the home folder as `~` on macOS, Linux, and Windows.
// The renderer has no home path of its own, so the standard home roots stand
// in for it.
const HOME_ROOT =
  /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/;

/** A row's folder with the home folder as `~`: `~/work/t3-review-app`. */
export function shortLocation(rootPath: string): string {
  return rootPath.replace(HOME_ROOT, '~');
}

/**
 * The row note on how its chats import, in one line:
 * `1 continues in place · 2 import as history only · 1 archived`, or
 * `All chats import as history only` when none can continue. Takes the
 * row's `chatTierCounts`; null when every chat continues and none is
 * archived, or when the counts are null because the list is capped.
 */
export function tierNote(counts: ChatTierCounts | null): string | null {
  if (!counts) return null;
  const parts: string[] = [];
  if (counts.historyOnly > 0 && counts.continuing === 0) {
    parts.push(`All chats import as ${HISTORY_ONLY}`);
  } else if (counts.historyOnly > 0) {
    parts.push(
      `${counts.continuing} ${counts.continuing === 1 ? 'continues' : 'continue'} in place`,
      `${counts.historyOnly} ${counts.historyOnly === 1 ? 'imports' : 'import'} as ${HISTORY_ONLY}`,
    );
  }
  if (counts.archived > 0) parts.push(`${counts.archived} archived`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** One chat in a row's `Show chats` list. */
export interface ListedChat {
  readonly title: string;
  readonly historyOnly: boolean;
}

/**
 * Newest chat titles for a row's `Show chats` list, so two folders with the
 * same or a generic name can be told apart by what was discussed in them
 * (CAN-3076), with how many chats the list leaves out. Null when no listed
 * chat has a title.
 */
export function listedChats(
  candidate: ExternalProjectCandidate,
): { readonly chats: ListedChat[]; readonly more: number } | null {
  const seen = new Set<string>();
  const chats: ListedChat[] = [];
  for (const session of candidate.sessions) {
    const title = session.title?.trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    chats.push({ title, historyOnly: isHistoryOnly(session) });
    if (chats.length === MAX_LISTED_CHAT_TITLES) break;
  }
  if (chats.length === 0) return null;
  return { chats, more: Math.max(0, candidate.sessionCount - chats.length) };
}
