import { randomUUID } from 'node:crypto';
import { access, cp, mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readCodexRolloutSeedItems } from '@canopy/execution-engine/node/codex-runtime';
import {
  IPC_CHANNELS,
  type ChatSessionImportedEvent,
  type ExternalProjectCandidate,
  type ExternalProjectImportItemResult,
  type ExternalProjectImportProgressEvent,
  type ExternalProjectImportRequest,
  type ExternalProjectImportResponse,
  type ExternalProjectProvider,
  type PersistedChatTab,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import { publishCodexReconstructionSeed } from '../codex/reconstruction-seed-store';
import { upsertPersistedChatTabs } from '../lib/chat-tab-dispatch-utils';
import {
  claudeProjectDirCandidates,
  getClaudeCodeProjectsDir,
} from '../lib/claude-project-paths';
import {
  createWorkEntry,
  listWorkEntryIds,
  removeWorkEntryRow,
} from '../lib/cowork-work-entries';
import { createExternalCoworkWorkspace } from '../lib/cowork-workspace-crud';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { sendToAllWindows } from '../lib/window-send';
import { assertFolderIsImportable } from '../lib/workspace-service';
import { createWorkspace } from '../lib/workspace-creation';
import {
  archiveSingleRepoWorktree,
  createSingleRepoWorktree,
} from '../lib/worktree-service';
import { cleanupPersistedWorktreeData } from '../lib/worktree-data-cleanup';
import { getWorktreeAttachmentsDir } from '../lib/paths';
import {
  TranscriptTooLargeError,
  projectClaudeTranscriptFile,
  projectCodexRolloutFile,
  type ProjectedTranscript,
  MAX_IMPORT_TRANSCRIPT_BYTES,
} from './chat-projection';
import { getCachedExternalProjectScan, type CachedScan } from './discovery';
import { projectOpenCodeSession } from './opencode-projection';
import type { StoreReadRunner } from './store-read-runner';
import { withStoreRunner } from './store-snapshot-read';
import { StoreTranscripts } from './store-transcripts';
import { projectT3Thread } from './t3code-projection';
import {
  readExternalProjectImportLedger,
  recordExternalProjectChatDestination,
  recordExternalProjectImport,
  recordExternalProjectSessionImports,
  findImportedSession,
  removeExternalProjectImport,
  type ExternalProjectImportedSession,
  type ExternalProjectSessionImport,
} from './ledger';
import type { DiscoveredSession } from './types';

/**
 * Import transaction for the bulk project import (CAN-2439) from Claude,
 * Codex, T3 Code, and OpenCode.
 *
 * Items are processed one at a time and each reports its own result, so an
 * unreadable folder or an oversized transcript never stops the batch. Per
 * item the steps are:
 *
 * 1. revalidate the root (still a directory, still not tracked);
 * 2. register the Canopy project: a git root becomes a single-repo project
 *    without writing `canopy.json`, an ordinary folder becomes an external
 *    Cowork project (the folder itself is the working directory, so files and
 *    artifacts are available to agents immediately);
 * 3. record the project in the ledger (for a new registration, or once chats
 *    actually land in an existing project), which is what makes repeat runs
 *    skip it instead of duplicating it;
 * 4. optionally project each new native session into a persisted chat tab.
 *    Cowork projects receive one Work Entry per import run; single-repo
 *    projects receive one worktree. Chats that can be continued carry the
 *    provider continuation artifact (Claude fork-on-next-send, Codex
 *    reconstruction seed); the rest are stored read-only. Every chat keeps
 *    the title its source gave it; the Work Entry is named from those chats
 *    rather than a repeated "Imported from …" label (CAN-3076).
 *
 * Provider stores are never modified. The only provider-side write is the
 * same one session transfer performs: copying a Claude transcript into the
 * destination worktree's project directory so the fork can resume there.
 */

const MAX_CHATS_PER_PROJECT = 200;
/**
 * Source bytes admitted into one chat scope per run. The per-transcript cap
 * and the chat cap bound each factor; this bounds their product, which is
 * what one `chats/{worktreeId}.json` and its first hydration must carry.
 * This is not a heap budget: the parsed records, the projected messages,
 * and the prepared tabs are held together, so peak main-process memory at
 * the ceiling is a small multiple of this figure.
 */
const MAX_IMPORT_SCOPE_BYTES = 128 * 1024 * 1024;
/**
 * Budget rounds one run makes (see {@link prepareChatImports}). Every round
 * copies each SQLite store its chats read from, so the refills that bytes
 * given back pay for are bounded rather than one per waiting chat.
 */
const MAX_IMPORT_BUDGET_ROUNDS = 4;
/** Per-project result messages kept verbatim; the rest fold into a count. */
const MAX_RESULT_MESSAGES = 5;
/**
 * Provider session ids reach a path join when a transcript is copied for the
 * destination cwd; anything outside this shape is imported read-only instead.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type ProgressEmitter = (
  event: Omit<ExternalProjectImportProgressEvent, 'scanId'>,
) => void;

interface DestinationWorkspace {
  id: string;
  type: 'single-repo' | 'multi-repo' | 'cowork';
  item: SidebarItem;
}

function providerName(provider: ExternalProjectProvider): string {
  switch (provider) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 't3code':
      return 'T3 Code';
    case 'opencode':
      return 'OpenCode';
    default: {
      const unknown: never = provider;
      return unknown;
    }
  }
}

/** Providers an imported tab can name: both an `AgentProviderType` and a `ModelHarness`. */
type ImportedTabProvider =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'copilot'
  | 'opencode';

/** T3 Code driver ids Canopy has a provider for; T3 calls its Claude driver `claudeAgent`. */
const T3_DRIVER_PROVIDERS = new Map<string, ImportedTabProvider>([
  ['claudeAgent', 'claude'],
  ['claude', 'claude'],
  ['codex', 'codex'],
  ['cursor', 'cursor'],
  ['copilot', 'copilot'],
  ['opencode', 'opencode'],
]);

/**
 * The provider an imported tab is labeled with: the agent whose record backs
 * it, else the agent T3 ran it on when Canopy has that provider. A T3 thread
 * run on an agent Canopy cannot name (Grok, Kiro, …) carries none rather than
 * a wrong one; it is read-only, so nothing ever runs on it.
 */
function tabProviderFor(
  session: DiscoveredSession,
): ImportedTabProvider | undefined {
  if (session.backing) return session.backing.provider;
  if (session.provider !== 't3code') return session.provider;
  return session.driver ? T3_DRIVER_PROVIDERS.get(session.driver) : undefined;
}

// The main process's default locale (Node/ICU, which can differ from the
// renderer's UI locale when the app is launched without LANG) rather than a
// fixed one: the rendered string becomes the chat's permanent title, so it
// should read the way the user's other dates do as far as this process can
// tell.
const FALLBACK_TITLE_DATE = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** Largest epoch offset `Date` can represent; `Number.isFinite` alone admits values `toISOString` rejects. */
const MAX_EPOCH_MS = 8.64e15;

function isDisplayableEpoch(ms: number | null): ms is number {
  return ms !== null && Number.isFinite(ms) && Math.abs(ms) <= MAX_EPOCH_MS;
}

/**
 * Title for a chat whose source carries none: its provider plus when it
 * started, so a batch of untitled imports never collapses into one repeated
 * label. Only real evidence dates it; without any, the session id is the
 * one distinct handle left.
 */
function fallbackChatTitle(
  session: DiscoveredSession,
  startedAtMs: number | null,
): string {
  const provider = providerName(session.provider);
  if (isDisplayableEpoch(startedAtMs)) {
    return `${provider} chat from ${FALLBACK_TITLE_DATE.format(startedAtMs)}`;
  }
  return `${provider} chat ${session.id.slice(0, 8)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

function toDestination(item: SidebarItem): DestinationWorkspace {
  return { id: item.id, type: item.type, item };
}

async function samePath(left: string, right: string): Promise<boolean> {
  try {
    return (await realpath(left)) === right;
  } catch {
    return false;
  }
}

/**
 * The destination a candidate already has, if any: the project the scan saw
 * it tracked by, the project an earlier run of this scan registered (the
 * ledger names it, which is what makes a same-run retry idempotent), or a
 * sidebar entry rooted at the same canonical path.
 */
async function findRegisteredDestination(
  candidate: ExternalProjectCandidate,
  resolvedRootPath: string,
): Promise<DestinationWorkspace | null> {
  const { items } = await readAllSidebarItems();
  const byId = (id: string | undefined): SidebarItem | undefined =>
    id ? items.find((item) => item.id === id) : undefined;
  const tracked = byId(candidate.trackedWorkspaceId);
  if (tracked) return toDestination(tracked);
  const ledger = await readExternalProjectImportLedger();
  const recorded = byId(ledger.imports[candidate.id]?.workspaceId);
  if (recorded) return toDestination(recorded);
  for (const item of items) {
    const itemPath =
      item.type === 'single-repo'
        ? item.repoPath
        : item.type === 'cowork'
          ? item.externalPath
          : item.sourceRepoPath;
    if (!itemPath) continue;
    if (
      itemPath === resolvedRootPath ||
      (await samePath(itemPath, resolvedRootPath))
    ) {
      return toDestination(item);
    }
  }
  return null;
}

async function registerDestination(
  candidate: ExternalProjectCandidate,
): Promise<DestinationWorkspace> {
  // The scan's path was canonical when it was taken; resolve it again now so
  // a folder swapped for a symlink since then is judged by where it points.
  const resolvedRootPath = await realpath(candidate.rootPath);
  const existing = await findRegisteredDestination(candidate, resolvedRootPath);
  if (existing) return existing;
  if (candidate.kind === 'git') {
    const { workspace } = await createWorkspace({
      source: 'external_projects_import',
      variant: {
        kind: 'repository-without-manifest',
        repoPath: resolvedRootPath,
        name: candidate.displayName,
      },
    });
    if (workspace.type !== 'single-repo') {
      throw new Error('Imported project was persisted with an unexpected type');
    }
    return { id: workspace.id, type: 'single-repo', item: workspace };
  }
  const { items } = await readAllSidebarItems();
  await assertFolderIsImportable(resolvedRootPath, items);
  const workspace = await createExternalCoworkWorkspace(
    resolvedRootPath,
    candidate.displayName,
  );
  return { id: workspace.id, type: 'cowork', item: workspace };
}

interface NativeTranscript {
  kind: DiscoveredSession['kind'];
  id: string;
  sourcePath: string;
}

async function installClaudeTranscriptForCwd(
  session: NativeTranscript,
  cwd: string,
): Promise<boolean> {
  if (!SAFE_SESSION_ID.test(session.id)) return false;
  const [projectDir] = await claudeProjectDirCandidates(cwd);
  if (!projectDir) return false;
  const destination = join(
    getClaudeCodeProjectsDir(),
    projectDir,
    `${session.id}.jsonl`,
  );
  if (destination === session.sourcePath) return true;
  try {
    await access(destination);
    return true;
  } catch {
    // Not yet present for this cwd; copy the source transcript below.
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(session.sourcePath, destination, {
    force: false,
    errorOnExist: true,
  });
  return true;
}

/** The agent record a session continues from: its own, or a T3 thread's backing. */
function nativeTranscriptOf(session: DiscoveredSession): NativeTranscript {
  return session.kind === 't3-thread' && session.backing
    ? session.backing
    : session;
}

async function buildContinuation(
  session: DiscoveredSession,
  cwd: string,
): Promise<Partial<PersistedChatTab>> {
  const native = nativeTranscriptOf(session);
  if (native.kind === 'claude-jsonl') {
    const installed = await installClaudeTranscriptForCwd(native, cwd);
    return installed
      ? { sdkSessionId: native.id, claudeForkSessionOnNextSend: true }
      : { readOnly: true };
  }
  // OpenCode sessions and T3's own text copies arrive as history only.
  if (native.kind !== 'codex-rollout') return { readOnly: true };
  const items = await readCodexRolloutSeedItems(native.sourcePath);
  if (items.length === 0) return { readOnly: true };
  const codexReconstructionSeedId = await publishCodexReconstructionSeed(items);
  return { codexReconstructionSeedId };
}

async function projectNative(
  native: NativeTranscript,
  context: ChatTabContext,
): Promise<ProjectedTranscript> {
  const { attachmentsDir, transcripts } = context;
  switch (native.kind) {
    case 'claude-jsonl':
      return projectClaudeTranscriptFile(native.sourcePath, { attachmentsDir });
    case 'codex-rollout':
      return projectCodexRolloutFile(native.sourcePath);
    case 'opencode-session':
      return projectOpenCodeSession(
        await transcripts.openCodeSession(native.sourcePath, native.id),
        { attachmentsDir },
      );
    case 't3-thread':
      throw new Error('A T3 Code thread has no native transcript of its own');
    default: {
      const unknown: never = native.kind;
      return unknown;
    }
  }
}

interface SessionProjection {
  projected: ProjectedTranscript;
  /** Size of the source that was projected, for the scope budget. */
  sourceBytes: number;
  /** Set when a T3 thread's native record failed and its T3 text was used instead. */
  demotedBecause?: string;
}

/** The native step of a projection: done, or T3's text still to read. */
type NativeAttempt =
  | { kind: 'projected'; projection: SessionProjection }
  | { kind: 't3-text'; demotedBecause?: string };

/**
 * Projects a session through its own or its backing agent's record. A T3
 * thread whose record is missing, oversized, empty, or fails to project is
 * left for T3's text instead, with the reason it was demoted.
 */
async function attemptNative(
  session: DiscoveredSession,
  context: ChatTabContext,
): Promise<NativeAttempt> {
  const sourceBytes = session.sizeBytes;
  if (session.kind === 'opencode-session') {
    const projected = await projectNative(
      { ...session, id: session.storeId ?? session.id },
      context,
    );
    return { kind: 'projected', projection: { projected, sourceBytes } };
  }
  if (session.kind !== 't3-thread') {
    const projected = await projectNative(session, context);
    return { kind: 'projected', projection: { projected, sourceBytes } };
  }
  const { backing } = session;
  if (!backing) return { kind: 't3-text' };
  if (backing.sizeBytes > MAX_IMPORT_TRANSCRIPT_BYTES) {
    // Never read: the per-chat cap applies to the native record too.
    return {
      kind: 't3-text',
      demotedBecause: new TranscriptTooLargeError(backing.sizeBytes).message,
    };
  }
  try {
    const projected = await projectNative(backing, context);
    if (projected.messages.length > 0) {
      return {
        kind: 'projected',
        projection: { projected, sourceBytes: backing.sizeBytes },
      };
    }
    return {
      kind: 't3-text',
      demotedBecause: `its ${providerName(backing.provider)} transcript has no messages`,
    };
  } catch (error) {
    return {
      kind: 't3-text',
      demotedBecause: errorMessage(error).replace(/\.$/, ''),
    };
  }
}

/** Projects a T3 thread from T3 Code's own text copy. */
async function projectT3Text(
  session: DiscoveredSession,
  context: ChatTabContext,
  demotedBecause: string | undefined,
): Promise<SessionProjection> {
  const sourceBytes = session.sizeBytes;
  // Planned by its native record, a backed thread meets the cap on its T3
  // text only here, once it falls back to it.
  if (sourceBytes > MAX_IMPORT_TRANSCRIPT_BYTES) {
    throw new TranscriptTooLargeError(sourceBytes);
  }
  const projected = await projectT3Thread(
    await context.transcripts.t3Thread(session),
    {
      attachmentsDir: context.attachmentsDir,
      t3AttachmentsDir: join(dirname(session.sourcePath), 'attachments'),
    },
  );
  return {
    projected,
    sourceBytes,
    ...(demotedBecause ? { demotedBecause } : {}),
  };
}

type ImportedChatRecord = ExternalProjectSessionImport;

/** Ledger record for one imported chat. */
export function chatImportRecord(
  session: DiscoveredSession,
  chatId: string,
  worktreeId: string,
): ImportedChatRecord {
  // Keyed by the store's own id: a T3 thread's `id` is its native id only
  // when the native record resolved in this scan. The native id stays an
  // alias in either tier, so a rescan from the Codex, Claude, or OpenCode
  // side sees it too.
  const sessionId = session.storeId ?? session.id;
  const aliasIds = Array.from(
    new Set([
      ...(session.backing ? [session.backing.id] : []),
      ...(session.aliasIds ?? []),
    ]),
  ).filter((id) => id !== sessionId);
  return {
    sessionId,
    chatId,
    worktreeId,
    ...(session.backing ? { backingProvider: session.backing.provider } : {}),
    ...(aliasIds.length > 0 ? { aliasIds } : {}),
    ...(session.archived !== undefined ? { archived: session.archived } : {}),
  };
}

export interface ChatImportOutcome {
  chatsImported: number;
  chatsReadOnly: number;
  chatsSkipped: number;
  /** Skips a retry could plausibly fix (transient read or save failures). */
  retryableSkips: number;
  messages: string[];
  /** Sessions that became persisted tabs, for the ledger. */
  imported: ImportedChatRecord[];
}

async function createChatDestination(
  workspace: DestinationWorkspace,
): Promise<{ worktreeId: string; cwd: string }> {
  if (workspace.type === 'cowork') {
    // No title: the entry is named from the chats it holds, the same way
    // every other Work Entry is, and a user rename still overrides that.
    // The explicit id makes it a fresh entry rather than adopting an empty
    // one the user already has open.
    const { entry } = await createWorkEntry(workspace.id, {
      id: randomUUID(),
    });
    return {
      worktreeId: entry.id,
      cwd: resolveWorktreeCwd(workspace.id, entry.id),
    };
  }
  if (workspace.item.type !== 'single-repo') {
    throw new Error('Chats can only be imported into Code or Cowork projects');
  }
  const response = await createSingleRepoWorktree({
    workspaceId: workspace.id,
    existingWorktreeIds: workspace.item.worktrees.map(
      (worktree) => worktree.id,
    ),
  });
  return {
    worktreeId: response.id,
    cwd: resolveWorktreeCwd(workspace.id, response.id),
  };
}

/**
 * Undo an empty chat destination. Nothing user-visible references it yet
 * (tabs are written last), so a batch whose sessions all failed must not
 * leave a mystery worktree or Work Entry behind.
 */
async function rollbackChatDestination(
  workspace: DestinationWorkspace,
  worktreeId: string,
): Promise<void> {
  try {
    if (workspace.type === 'cowork') {
      // Defer the browser lifecycle graph to this rollback-only path so normal
      // external-project imports do not eagerly load the browser service stack.
      const { withBrowserTaskOwnerRemoval } =
        await import('../browser/browser-profile-lifecycle');
      await withBrowserTaskOwnerRemoval(workspace.id, worktreeId, async () => {
        try {
          await cleanupPersistedWorktreeData(workspace.id, worktreeId);
        } finally {
          await removeWorkEntryRow(workspace.id, worktreeId);
        }
      });
      return;
    }
    await archiveSingleRepoWorktree({
      archiveTrigger: 'import',
      workspaceId: workspace.id,
      worktreeId,
      // This run created the branch and nothing landed on it.
      deleteBranch: true,
      retainAsArchivedContainer: false,
    });
  } catch {
    // Best effort: an orphaned empty destination is recoverable by hand and
    // must not turn a reported chat failure into an import failure.
  }
}

async function chatDestinationExists(
  workspace: DestinationWorkspace,
  worktreeId: string,
): Promise<boolean> {
  if (workspace.type === 'cowork') {
    const entries = await listWorkEntryIds(workspace.id).catch(
      (): string[] => [],
    );
    return entries.includes(worktreeId);
  }
  if (workspace.item.type !== 'single-repo') return false;
  return workspace.item.worktrees.some(
    (worktree) => worktree.id === worktreeId,
  );
}

/**
 * The worktree or Work Entry an earlier run of this import put the project's
 * chats in, when it still exists. The entry-level record is written as soon
 * as the destination exists, so it survives a failed session write; the
 * newest session record is the fallback for ledgers written before it.
 */
async function reusableChatDestination(
  workspace: DestinationWorkspace,
  recorded:
    | {
        chatWorktreeId?: string;
        sessions: Record<string, { worktreeId: string; importedAt?: string }>;
      }
    | undefined,
): Promise<string | null> {
  if (!recorded) return null;
  const candidates: string[] = [];
  if (recorded.chatWorktreeId) candidates.push(recorded.chatWorktreeId);
  let newest: { worktreeId: string; importedAt: string } | null = null;
  for (const record of Object.values(recorded.sessions)) {
    const importedAt = record.importedAt ?? '';
    if (!newest || importedAt > newest.importedAt) {
      newest = { worktreeId: record.worktreeId, importedAt };
    }
  }
  if (newest && !candidates.includes(newest.worktreeId)) {
    candidates.push(newest.worktreeId);
  }
  for (const worktreeId of candidates) {
    if (await chatDestinationExists(workspace, worktreeId)) return worktreeId;
  }
  return null;
}

function sortNewestFirst(
  sessions: readonly DiscoveredSession[],
): DiscoveredSession[] {
  return [...sessions].sort((a, b) => {
    const at = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
    const bt = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
    return bt - at;
  });
}

/**
 * Bytes the import expects to read for a session: a T3 thread's native record
 * when it has one within the per-chat cap (an oversized one is never read; the
 * thread falls back to its T3 text), else the session's own size.
 */
function plannedBytes(session: DiscoveredSession): number {
  const native = session.kind === 't3-thread' ? session.backing : undefined;
  return native && native.sizeBytes <= MAX_IMPORT_TRANSCRIPT_BYTES
    ? native.sizeBytes
    : session.sizeBytes;
}

export interface ChatImportPlan {
  /** Native sessions not yet imported. */
  pendingCount: number;
  /** Pending sessions past the per-project chat cap, left for the next run. */
  truncated: number;
  /** The first {@link MAX_CHATS_PER_PROJECT} pending sessions, newest first. */
  entries: Array<{
    session: DiscoveredSession;
    status: 'admitted' | 'too-large' | 'over-budget';
    plannedBytes: number;
  }>;
}

/**
 * Decides, before anything is read, which sessions this run imports: the
 * newest native sessions the ledger does not know yet, up to the chat cap,
 * each within the per-chat cap, together within the scope budget.
 */
export function planChatImports(
  sessions: readonly DiscoveredSession[],
  alreadyImported: Readonly<Record<string, ExternalProjectImportedSession>>,
): ChatImportPlan {
  const pending = sortNewestFirst(
    sessions.filter(
      (session) =>
        session.native && !findImportedSession(alreadyImported, session),
    ),
  );
  let admittedBytes = 0;
  const entries = pending
    .slice(0, MAX_CHATS_PER_PROJECT)
    .map((session): ChatImportPlan['entries'][number] => {
      const bytes = plannedBytes(session);
      if (bytes > MAX_IMPORT_TRANSCRIPT_BYTES)
        return { session, status: 'too-large', plannedBytes: bytes };
      if (admittedBytes + bytes > MAX_IMPORT_SCOPE_BYTES)
        return { session, status: 'over-budget', plannedBytes: bytes };
      admittedBytes += bytes;
      return { session, status: 'admitted', plannedBytes: bytes };
    });
  return {
    pendingCount: pending.length,
    truncated: Math.max(0, pending.length - MAX_CHATS_PER_PROJECT),
    entries,
  };
}

export interface ChatTabContext {
  cwd: string;
  attachmentsDir: string;
  transcripts: StoreTranscripts;
}

export interface PreparedChatTab {
  tab: PersistedChatTab;
  sourceBytes: number;
}

function recordProjectionFailure(
  session: DiscoveredSession,
  error: unknown,
  outcome: ChatImportOutcome,
): null {
  outcome.chatsSkipped += 1;
  // An oversized transcript stays oversized; a read error may not recur.
  if (!(error instanceof TranscriptTooLargeError)) outcome.retryableSkips += 1;
  outcome.messages.push(
    `Skipped "${session.title ?? session.id}": ${errorMessage(error)}.`,
  );
  return null;
}

/**
 * Prepares a batch of chats, results in input order. Native records are
 * projected first, so every T3 thread that needs T3 Code's text, unbacked or
 * demoted, is known before the T3 store is read and one copy of it serves
 * them all.
 */
export async function prepareChatTabs(
  sessions: readonly DiscoveredSession[],
  destination: ChatTabContext,
  outcome: ChatImportOutcome,
  onSettled: () => void = () => undefined,
): Promise<Array<PreparedChatTab | null>> {
  const results: Array<PreparedChatTab | null> = sessions.map(() => null);
  const fallbacks: Array<{ index: number; demotedBecause?: string }> = [];
  for (const [index, session] of sessions.entries()) {
    let attempt: NativeAttempt;
    try {
      attempt = await attemptNative(session, destination);
    } catch (error) {
      recordProjectionFailure(session, error, outcome);
      onSettled();
      continue;
    }
    if (attempt.kind === 't3-text') {
      fallbacks.push({ index, demotedBecause: attempt.demotedBecause });
      continue;
    }
    results[index] = await tabFromProjection(
      session,
      attempt.projection,
      destination,
      outcome,
    );
    onSettled();
  }
  destination.transcripts.demote(
    fallbacks
      .filter((entry) => entry.demotedBecause !== undefined)
      .map((entry) => sessions[entry.index]),
  );
  for (const { index, demotedBecause } of fallbacks) {
    const session = sessions[index];
    try {
      results[index] = await tabFromProjection(
        session,
        await projectT3Text(session, destination, demotedBecause),
        destination,
        outcome,
      );
    } catch (error) {
      recordProjectionFailure(session, error, outcome);
    }
    onSettled();
  }
  return results;
}

async function tabFromProjection(
  session: DiscoveredSession,
  projection: SessionProjection,
  destination: ChatTabContext,
  outcome: ChatImportOutcome,
): Promise<PreparedChatTab | null> {
  const { projected, demotedBecause, sourceBytes } = projection;
  outcome.messages.push(...projected.warnings);
  if (projected.messages.length === 0) {
    outcome.chatsSkipped += 1;
    outcome.messages.push(
      `Skipped "${session.title ?? session.id}": no messages to import.`,
    );
    return null;
  }
  let continuation: Partial<PersistedChatTab>;
  if (demotedBecause) {
    outcome.messages.push(
      `"${session.title ?? session.id}" was imported as history only: ${demotedBecause}.`,
    );
    continuation = { readOnly: true };
  } else {
    try {
      continuation = await buildContinuation(session, destination.cwd);
    } catch (error) {
      outcome.messages.push(
        `"${session.title ?? session.id}" was imported as read-only history: ${errorMessage(error)}.`,
      );
      continuation = { readOnly: true };
    }
  }
  const startedAtMs =
    projected.firstTimestamp ??
    (session.startedAt ? Date.parse(session.startedAt) : null);
  const createdAt = isDisplayableEpoch(startedAtMs)
    ? new Date(startedAtMs).toISOString()
    : new Date().toISOString();
  const tabProvider = tabProviderFor(session);
  const tab: PersistedChatTab = {
    id: randomUUID(),
    title:
      session.title ??
      projected.title ??
      fallbackChatTitle(session, startedAtMs),
    messages: projected.messages,
    createdAt,
    ...(tabProvider
      ? { providerType: tabProvider, executionHarness: tabProvider }
      : {}),
    ...continuation,
    // Only history names its source: a continuable chat is an ordinary chat
    // from here on, and a later read-only state (an archived worktree, for
    // one) must read as that state, not as an import.
    ...(continuation.readOnly ? { importedFrom: session.provider } : {}),
  };
  return { tab, sourceBytes };
}

/**
 * Projects the planned chats. Admitted chats are read and projected first;
 * a chat that fails or projects smaller than planned gives its bytes back,
 * and the chats the plan left over the budget are admitted in order against
 * what was actually projected, in further rounds until none fits or
 * {@link MAX_IMPORT_BUDGET_ROUNDS} rounds have run. Each round reads only its
 * own chats from a SQLite store. Returns the prepared tabs in plan order
 * (newest first).
 */
export async function prepareChatImports(args: {
  plan: ChatImportPlan;
  runner: StoreReadRunner;
  cwd: string;
  attachmentsDir: string;
  outcome: ChatImportOutcome;
  onProgress: (completed: number, total: number) => void;
}): Promise<Array<{ session: DiscoveredSession; tab: PersistedChatTab }>> {
  const { plan, outcome } = args;
  const entries = plan.entries;
  const total = entries.length;
  let completed = 0;
  const settle = (): void => {
    completed += 1;
    args.onProgress(completed, total);
  };
  args.onProgress(completed, total);
  let round: number[] = [];
  let waiting: number[] = [];
  for (const [index, { session, status, plannedBytes }] of entries.entries()) {
    if (status === 'admitted') round.push(index);
    else if (status === 'over-budget') waiting.push(index);
    else {
      // Never admissible, so never retryable; decided here so an oversized
      // session cannot be mistaken for a budget leftover.
      outcome.chatsSkipped += 1;
      outcome.messages.push(
        `Skipped "${session.title ?? session.id}": ${new TranscriptTooLargeError(plannedBytes).message}.`,
      );
      settle();
    }
  }
  const kept: Array<{
    index: number;
    session: DiscoveredSession;
    tab: PersistedChatTab;
  }> = [];
  let chargedBytes = 0;
  let overBudget = 0;
  let rounds = 0;
  // One reader for every round: a round reads only its own chats from a
  // SQLite store, in at most one more copy of each store, so the caps bound
  // what crosses the worker as well as what is projected.
  const transcripts = new StoreTranscripts(args.runner, []);
  const context: ChatTabContext = {
    cwd: args.cwd,
    attachmentsDir: args.attachmentsDir,
    transcripts,
  };
  while (round.length > 0) {
    const sessions = round.map((index) => entries[index].session);
    transcripts.admit(sessions);
    const results = await prepareChatTabs(sessions, context, outcome, settle);
    for (const [position, result] of results.entries()) {
      if (!result) continue;
      // Charged by what was actually projected: a T3 thread that fell back
      // to its T3 text costs that text, not the native record it was
      // planned for.
      if (chargedBytes + result.sourceBytes > MAX_IMPORT_SCOPE_BYTES) {
        overBudget += 1;
        continue;
      }
      chargedBytes += result.sourceBytes;
      kept.push({
        index: round[position],
        session: sessions[position],
        tab: result.tab,
      });
    }
    rounds += 1;
    // Each round copies the stores its chats read from once more, so a run
    // stops refilling the budget after MAX_IMPORT_BUDGET_ROUNDS; the chats
    // still waiting are left for the next run like any over-budget chat.
    if (rounds >= MAX_IMPORT_BUDGET_ROUNDS) break;
    let reservedBytes = chargedBytes;
    const next: number[] = [];
    const stillWaiting: number[] = [];
    for (const index of waiting) {
      const bytes = entries[index].plannedBytes;
      if (reservedBytes + bytes <= MAX_IMPORT_SCOPE_BYTES) {
        next.push(index);
        reservedBytes += bytes;
      } else stillWaiting.push(index);
    }
    round = next;
    waiting = stillWaiting;
  }
  if (waiting.length > 0) {
    completed += waiting.length;
    args.onProgress(completed, total);
  }
  overBudget += waiting.length;
  if (overBudget > 0) {
    // Left-out chats are not ledgered, so the next run picks them up with a
    // fresh budget.
    outcome.chatsSkipped += overBudget;
    outcome.retryableSkips += overBudget;
    outcome.messages.push(
      `${overBudget} ${overBudget === 1 ? 'chat was' : 'chats were'} left out to keep this import under ${Math.round(MAX_IMPORT_SCOPE_BYTES / (1024 * 1024))} MB. Import again to add ${overBudget === 1 ? 'it' : 'them'}.`,
    );
  }
  return kept
    .sort((left, right) => left.index - right.index)
    .map(({ session, tab }) => ({ session, tab }));
}

async function importChats(args: {
  candidate: ExternalProjectCandidate;
  workspace: DestinationWorkspace;
  sessions: DiscoveredSession[];
  runner: StoreReadRunner;
  onProgress: (completed: number, total: number) => void;
}): Promise<ChatImportOutcome> {
  const { candidate, workspace } = args;
  const outcome: ChatImportOutcome = {
    chatsImported: 0,
    chatsReadOnly: 0,
    chatsSkipped: 0,
    retryableSkips: 0,
    messages: [],
    imported: [],
  };
  const ledger = await readExternalProjectImportLedger();
  const ledgerEntry = ledger.imports[candidate.id];
  const plan = planChatImports(args.sessions, ledgerEntry?.sessions ?? {});
  if (plan.pendingCount === 0) return outcome;
  if (workspace.type === 'multi-repo') {
    outcome.chatsSkipped = plan.pendingCount;
    outcome.messages.push(
      'Chats cannot be imported into a multi-repo project yet.',
    );
    return outcome;
  }
  const { truncated } = plan;
  if (truncated > 0) {
    // Left-out chats are not ledgered, so the next run picks them up; count
    // them like the byte-budget leftovers so Retry is offered.
    outcome.chatsSkipped += truncated;
    outcome.retryableSkips += truncated;
    outcome.messages.push(
      `Only the ${MAX_CHATS_PER_PROJECT} most recent chats were imported. Import again to add the other ${truncated}.`,
    );
  }

  // A retry lands in the destination the earlier run created rather than
  // opening a second worktree or Work Entry for the same project.
  const priorWorktreeId = await reusableChatDestination(workspace, ledgerEntry);
  const reused = priorWorktreeId !== null;
  const destination = priorWorktreeId
    ? {
        worktreeId: priorWorktreeId,
        cwd: resolveWorktreeCwd(workspace.id, priorWorktreeId),
      }
    : await createChatDestination(workspace);
  if (!reused) {
    // Name the destination before any chat lands so a retry finds it even if
    // the per-session records below never get written.
    await recordExternalProjectChatDestination({
      candidateId: candidate.id,
      worktreeId: destination.worktreeId,
    }).catch(() => undefined);
  }
  const attachmentsDir = getWorktreeAttachmentsDir(
    workspace.id,
    destination.worktreeId,
  );
  const prepared = await prepareChatImports({
    plan,
    runner: args.runner,
    cwd: destination.cwd,
    attachmentsDir,
    outcome,
    onProgress: args.onProgress,
  });
  if (prepared.length === 0) {
    if (!reused)
      await rollbackChatDestination(workspace, destination.worktreeId);
    return outcome;
  }

  // One read and one write for the whole batch: per-tab upserts rewrite the
  // entire transcript-bearing file each time, which is quadratic in payload.
  try {
    await upsertPersistedChatTabs({
      projectId: workspace.id,
      worktreeId: destination.worktreeId,
      tabs: prepared.map(({ tab }) => tab),
      // A reused destination keeps whatever tab the user last had active.
      ...(reused ? {} : { activeTabId: prepared[0].tab.id }),
    });
  } catch (error) {
    outcome.chatsSkipped += prepared.length;
    outcome.retryableSkips += prepared.length;
    outcome.messages.push(`Chats could not be saved: ${errorMessage(error)}.`);
    if (!reused)
      await rollbackChatDestination(workspace, destination.worktreeId);
    return outcome;
  }
  for (const { session, tab } of prepared) {
    if (tab.readOnly) outcome.chatsReadOnly += 1;
    else outcome.chatsImported += 1;
    outcome.imported.push(
      chatImportRecord(session, tab.id, destination.worktreeId),
    );
    // A destination this run created has never been opened, so the renderer
    // hydrates it from the durable copy on first open and would discard a
    // per-tab event anyway; only an already-open scope needs the live insert,
    // which spares a fresh import up to 200 full-transcript IPC clones. Every
    // window may have that scope open, so the insert goes to all of them.
    if (reused) {
      const event: ChatSessionImportedEvent = {
        projectId: workspace.id,
        worktreeId: destination.worktreeId,
        chatId: tab.id,
        tab,
        activateTab: false,
      };
      sendToAllWindows(IPC_CHANNELS.chatSessionImported, event);
    }
  }

  // Keep the cycle-breaking state-service dependency local to final commit,
  // matching session transfer.
  const { getChatStateService } =
    await import('../services/chat-state-service');
  await getChatStateService()
    .flushScope(workspace.id, destination.worktreeId)
    .catch(() => undefined);

  // Deliberately no post-create setup: the setup script comes from
  // repository-controlled configuration, and a bulk import is accepted for
  // many repositories at once, so nothing a repository defines runs until
  // the user starts it from the worktree's script menu.
  return outcome;
}

/** Joins per-chat notes, keeping the first few verbatim and counting the rest. */
function formatResultMessage(messages: string[]): string | undefined {
  if (messages.length === 0) return undefined;
  if (messages.length <= MAX_RESULT_MESSAGES) return messages.join(' ');
  const hidden = messages.length - MAX_RESULT_MESSAGES;
  return `${messages.slice(0, MAX_RESULT_MESSAGES).join(' ')} And ${hidden} more.`;
}

async function importOne(args: {
  candidate: ExternalProjectCandidate;
  importChatsRequested: boolean;
  sessions: DiscoveredSession[];
  runner: StoreReadRunner;
  onChatProgress: (completed: number, total: number) => void;
}): Promise<ExternalProjectImportItemResult> {
  const { candidate } = args;
  const base = {
    candidateId: candidate.id,
    displayName: candidate.displayName,
    rootPath: candidate.rootPath,
    chatsImported: 0,
    chatsReadOnly: 0,
    chatsSkipped: 0,
  };
  if (candidate.status === 'unavailable') {
    return {
      ...base,
      status: 'skipped',
      message: candidate.statusReason ?? 'This folder is not available.',
      retryable: false,
    };
  }
  if (!(await isDirectory(candidate.rootPath))) {
    return {
      ...base,
      status: 'failed',
      message: 'Folder not found. Restore it, then try again.',
      retryable: true,
    };
  }

  let workspace: DestinationWorkspace;
  try {
    workspace = await registerDestination(candidate);
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      message: errorMessage(error),
      retryable: true,
    };
  }
  const alreadyPresent = candidate.status !== 'available';
  // The ledger is bookkeeping for the next scan; a write failure is reported
  // on the item, never allowed to fail a project that is already on disk.
  const ledgerNotes: string[] = [];
  const recordProject = async (): Promise<void> => {
    try {
      await recordExternalProjectImport({
        candidateId: candidate.id,
        workspaceId: workspace.id,
        rootPath: candidate.rootPath,
        providers: candidate.providers,
      });
    } catch (error) {
      ledgerNotes.push(
        `The import record could not be saved, so a later scan may offer this project again: ${errorMessage(error)}.`,
      );
    }
  };
  // A project this run registered is ledgered right away. A pre-existing
  // project is ledgered only once chats actually land in it, so a refused
  // import (multi-repo chats, oversized transcripts) never hides the
  // candidate as "already imported".
  if (!alreadyPresent) await recordProject();

  if (!args.importChatsRequested) {
    const message = formatResultMessage(
      alreadyPresent
        ? [
            candidate.statusReason ?? 'Already in your projects.',
            ...ledgerNotes,
          ]
        : ledgerNotes,
    );
    return {
      ...base,
      status: alreadyPresent ? 'skipped' : 'imported',
      workspaceId: workspace.id,
      workspaceType: workspace.type,
      ...(message ? { message } : {}),
      retryable: false,
    };
  }

  // An already-tracked project has no ledger entry yet, and the chat
  // destination is recorded on that entry. Create it provisionally so the
  // record can land, and drop it again below if no chat does, so a refused
  // import never hides the candidate as "already imported".
  let provisionalEntry = false;
  if (alreadyPresent && workspace.type !== 'multi-repo') {
    const known = (await readExternalProjectImportLedger()).imports[
      candidate.id
    ];
    if (!known) {
      await recordProject();
      provisionalEntry = true;
    }
  }
  const dropProvisionalEntry = async (): Promise<void> => {
    if (!provisionalEntry) return;
    await removeExternalProjectImport(candidate.id).catch(() => undefined);
  };
  let chats: ChatImportOutcome;
  try {
    chats = await importChats({
      candidate,
      workspace,
      sessions: args.sessions,
      runner: args.runner,
      onProgress: args.onChatProgress,
    });
  } catch (error) {
    await dropProvisionalEntry();
    return {
      ...base,
      status: alreadyPresent ? 'failed' : 'imported',
      workspaceId: workspace.id,
      workspaceType: workspace.type,
      message: `Project added, but its chats could not be imported: ${errorMessage(error)}`,
      retryable: true,
    };
  }
  const touched = chats.imported.length > 0;
  if (!touched) await dropProvisionalEntry();
  if (touched) {
    try {
      await recordExternalProjectSessionImports({
        candidateId: candidate.id,
        sessions: chats.imported,
      });
    } catch (error) {
      ledgerNotes.push(
        `The chat import record could not be saved, so a later run may import these chats again: ${errorMessage(error)}.`,
      );
    }
  }
  const message = formatResultMessage(
    chats.messages.length === 0 && alreadyPresent && !touched
      ? [candidate.statusReason ?? 'Already in your projects.', ...ledgerNotes]
      : [...chats.messages, ...ledgerNotes],
  );
  return {
    ...base,
    status: alreadyPresent && !touched ? 'skipped' : 'imported',
    workspaceId: workspace.id,
    workspaceType: workspace.type,
    chatsImported: chats.chatsImported,
    chatsReadOnly: chats.chatsReadOnly,
    chatsSkipped: chats.chatsSkipped,
    ...(message ? { message } : {}),
    // Only skips a second attempt could change; an oversized transcript, an
    // empty session, or a multi-repo refusal would just repeat.
    retryable: chats.retryableSkips > 0,
  };
}

/** In-flight `importOne` per candidate id, so same-candidate runs queue. */
const candidateRuns = new Map<
  string,
  Promise<ExternalProjectImportItemResult>
>();

export async function importExternalProjects(
  request: ExternalProjectImportRequest,
): Promise<ExternalProjectImportResponse> {
  const scan = getCachedExternalProjectScan(request.scanId);
  if (!scan) {
    throw new Error('This scan is no longer available. Scan again to import.');
  }
  const emit: ProgressEmitter = (event) => {
    const payload: ExternalProjectImportProgressEvent = {
      scanId: scan.scanId,
      ...event,
    };
    try {
      sendToAllWindows(IPC_CHANNELS.externalProjectsImportProgress, payload);
    } catch {
      // Progress is advisory; a window going away must not fail the batch.
    }
  };

  // One store reader for the whole request, started only if a T3 Code or
  // OpenCode chat needs its store.
  return withStoreRunner(undefined, (runner) =>
    importSelections(request, scan, emit, runner),
  );
}

async function importSelections(
  request: ExternalProjectImportRequest,
  scan: CachedScan,
  emit: ProgressEmitter,
  runner: StoreReadRunner,
): Promise<ExternalProjectImportResponse> {
  const results: ExternalProjectImportItemResult[] = [];
  const total = request.selections.length;
  for (let index = 0; index < request.selections.length; index += 1) {
    const selection = request.selections[index];
    const candidate = scan.candidates.find(
      (item) => item.id === selection.candidateId,
    );
    if (!candidate) {
      results.push({
        candidateId: selection.candidateId,
        displayName: selection.candidateId,
        rootPath: '',
        status: 'failed',
        chatsImported: 0,
        chatsReadOnly: 0,
        chatsSkipped: 0,
        message: 'This project is not part of the current scan. Scan again.',
        retryable: false,
      });
      continue;
    }
    emit({
      candidateId: candidate.id,
      displayName: candidate.displayName,
      phase: 'project',
      completedItems: index,
      totalItems: total,
    });
    let result: ExternalProjectImportItemResult;
    // Overlapping runs for one candidate (a double-trigger, a second surface)
    // would each decide and create a destination on the same stale view;
    // serialize them so the later one sees what the earlier one recorded.
    const previous = candidateRuns.get(candidate.id) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() =>
        importOne({
          candidate,
          importChatsRequested: selection.importChats,
          sessions: scan.sessionsByCandidate.get(candidate.id) ?? [],
          runner,
          onChatProgress: (completed, chatsTotal) =>
            emit({
              candidateId: candidate.id,
              displayName: candidate.displayName,
              phase: 'chats',
              completedItems: index,
              totalItems: total,
              chatsCompleted: completed,
              chatsTotal,
            }),
        }),
      );
    candidateRuns.set(candidate.id, run);
    try {
      result = await run;
    } catch (error) {
      // One project's unexpected failure is its own row, never the batch's.
      result = {
        candidateId: candidate.id,
        displayName: candidate.displayName,
        rootPath: candidate.rootPath,
        status: 'failed',
        chatsImported: 0,
        chatsReadOnly: 0,
        chatsSkipped: 0,
        message: errorMessage(error),
        retryable: true,
      };
    } finally {
      if (candidateRuns.get(candidate.id) === run) {
        candidateRuns.delete(candidate.id);
      }
    }
    results.push(result);
    emit({
      candidateId: candidate.id,
      displayName: candidate.displayName,
      phase: 'done',
      completedItems: index + 1,
      totalItems: total,
      result,
    });
  }
  return { results };
}
