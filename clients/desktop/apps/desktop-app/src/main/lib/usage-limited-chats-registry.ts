import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  STANDALONE_CHAT_PROJECT_ID,
  type AgentProviderType,
  type ChatActiveSessions,
  type UsageLimitedChatEntry,
  type ResumeQueueEntry,
  type UsageLimitedChatGroup,
  type UsageLimitedChatItem,
  type UsageLimitedChatsFile,
  type UsageLimitedChatTarget,
} from '@canopy/desktop-shared/types';
import { getAttentionTracker } from '../services/attention-tracker';
import { getUsageLimitedChatsFilePath } from './paths';
import { isRecord } from './type-guards';
import { writeFileAtomically } from './atomic-file';

function sameTarget(
  a: UsageLimitedChatTarget,
  b: UsageLimitedChatTarget,
): boolean {
  return (
    a.projectId === b.projectId &&
    a.worktreeId === b.worktreeId &&
    a.chatId === b.chatId
  );
}

/**
 * Human-readable reset time for the `usage_limit` push body.
 *
 * The server composes the notification from the category and drops this text in
 * verbatim (`<branch> · resets <time>`), so whatever is sent here is what the
 * user reads on their phone. An ISO timestamp is a machine value, not copy, and
 * `new Date(NaN).toISOString()` throws outright — which would surface as a
 * rejected `recordUsageLimitedChat` on a path whose only job is to record a
 * limit. Mirrors the renderer's `formatUsageLimitTimeLabel`; that helper lives
 * under `renderer/src/lib/` and main must not import it.
 */
function formatUsageLimitResetDetail(resetsAt: number): string | undefined {
  // `0` is "no reset time" from the producing stores, not the epoch.
  if (resetsAt === 0) {
    return undefined;
  }
  const when = new Date(resetsAt);
  if (!Number.isFinite(when.getTime())) {
    return undefined;
  }
  const sameDay = when.toDateString() === new Date().toDateString();
  const label = sameDay
    ? when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : when.toLocaleString([], {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      });
  return `resets ${label}`;
}

function targetKey(target: UsageLimitedChatTarget): string {
  return `${target.projectId}/${target.worktreeId}/${target.chatId}`;
}

function displayWorkspaceId(entry: UsageLimitedChatEntry): string {
  return entry.projectId === STANDALONE_CHAT_PROJECT_ID
    ? entry.worktreeId
    : entry.projectId;
}

function displayWorkspaceType(
  entry: UsageLimitedChatEntry,
): UsageLimitedChatGroup['workspaceType'] {
  return entry.projectId === STANDALONE_CHAT_PROJECT_ID
    ? 'cowork'
    : (entry.workspaceType ?? 'single-repo');
}

function normalizeEntry(value: unknown): UsageLimitedChatEntry | null {
  if (!isRecord(value)) return null;
  const { projectId, worktreeId, chatId, provider } = value;
  if (
    typeof projectId !== 'string' ||
    typeof worktreeId !== 'string' ||
    typeof chatId !== 'string' ||
    (provider !== 'claude' &&
      provider !== 'codex' &&
      provider !== 'ollama' &&
      provider !== 'cursor')
  ) {
    return null;
  }
  const workspaceType =
    value.workspaceType === 'single-repo' ||
    value.workspaceType === 'multi-repo' ||
    value.workspaceType === 'cowork'
      ? value.workspaceType
      : undefined;
  const resumeReason =
    value.resumeReason === 'provider_sign_in'
      ? 'provider_sign_in'
      : value.resumeReason === 'app_shutdown'
        ? 'app_shutdown'
        : value.resumeReason === 'authentication'
          ? 'authentication'
          : 'usage_limit';
  return {
    projectId,
    worktreeId,
    chatId,
    provider,
    ...(typeof value.interruptedUserMessageId === 'string' &&
    value.interruptedUserMessageId
      ? { interruptedUserMessageId: value.interruptedUserMessageId }
      : {}),
    detectedAt: typeof value.detectedAt === 'number' ? value.detectedAt : 0,
    ...(typeof value.resetsAt === 'number' ? { resetsAt: value.resetsAt } : {}),
    resumeReason,
    ...(value.accountProxyAutoResumeSuppressed === true
      ? { accountProxyAutoResumeSuppressed: true }
      : {}),
    ...(typeof value.accountProxyConnectionId === 'string' &&
    value.accountProxyConnectionId
      ? { accountProxyConnectionId: value.accountProxyConnectionId }
      : {}),
    ...(typeof value.authenticationAttemptId === 'string'
      ? { authenticationAttemptId: value.authenticationAttemptId }
      : {}),
    workspaceName:
      typeof value.workspaceName === 'string' ? value.workspaceName : '',
    chatTitle: typeof value.chatTitle === 'string' ? value.chatTitle : '',
    ...(workspaceType ? { workspaceType } : {}),
  };
}

export async function readUsageLimitedChats(
  strict = false,
): Promise<UsageLimitedChatEntry[]> {
  try {
    const raw = await readFile(getUsageLimitedChatsFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .map(normalizeEntry)
      .filter((e): e is UsageLimitedChatEntry => e !== null);
  } catch (error) {
    if (
      strict &&
      !(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
    )
      throw error;
    return [];
  }
}

// Serialize writes so concurrent detection/clear calls do not clobber the file.
// Callers (recordUsageLimitedChat/clearUsageLimitedChat) are invoked
// fire-and-forget (`void ...`) from session code, so the promise returned here
// must never reject — a failed write is logged and swallowed instead of
// poisoning the chain, so subsequent writes keep running.
let writeChain: Promise<void> = Promise.resolve();
function enqueueWrite(
  mutate: (entries: UsageLimitedChatEntry[]) => UsageLimitedChatEntry[],
  strict = false,
): Promise<void> {
  const attempt = async (): Promise<void> => {
    const current = await readUsageLimitedChats(strict);
    const next: UsageLimitedChatsFile = {
      version: 1,
      entries: mutate(current),
    };
    const filePath = getUsageLimitedChatsFilePath();
    await mkdir(dirname(filePath), { recursive: true });
    if (strict) {
      await writeFileAtomically(filePath, JSON.stringify(next, null, 2), {
        encoding: 'utf8',
      });
    } else {
      await writeFile(filePath, JSON.stringify(next, null, 2), 'utf8');
    }
  };
  // Run `attempt` regardless of whether the prior write succeeded or failed,
  // then catch so `writeChain` (and the promise returned to the caller) is
  // always a resolved promise.
  const pending = writeChain.then(attempt, attempt);
  const next = pending.catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('Failed to persist usage-limited chats registry:', error);
  });
  writeChain = next;
  return strict ? pending : next;
}

export async function recordUsageLimitedChat(
  entry: UsageLimitedChatEntry,
): Promise<void> {
  await enqueueWrite((entries) => [
    ...entries.filter((e) => !sameTarget(e, entry)),
    entry,
  ]);
  // A usage limit is the purest form of "you are the blocker": the agent cannot
  // make progress until a human switches accounts or waits out the reset.
  // `app_shutdown` is excluded — that is the app stopping, not the user being
  // asked for anything, and `recordInterruptedChats` is its own path anyway.
  if (entry.resumeReason === 'app_shutdown') {
    return;
  }
  const resetDetail =
    entry.resetsAt !== undefined
      ? formatUsageLimitResetDetail(entry.resetsAt)
      : undefined;
  getAttentionTracker().mark({
    projectId: entry.projectId,
    worktreeId: entry.worktreeId,
    chatId: entry.chatId,
    state: 'blocked',
    sourceId: 'usage-limit',
    reason:
      entry.resumeReason === 'authentication' ? 'auth_required' : 'usage_limit',
    ...(resetDetail !== undefined ? { detail: resetDetail } : {}),
  });
}

/**
 * A record of an interrupted chat. `turnStartedAt`, when known, is when the
 * interrupted turn started. It is never stored.
 */
export type InterruptedChatRecord = UsageLimitedChatEntry & {
  turnStartedAt?: number;
};

function storedEntry(record: InterruptedChatRecord): UsageLimitedChatEntry {
  const entry = { ...record };
  delete entry.turnStartedAt;
  return entry;
}

/**
 * A later shutdown record for a stored shutdown entry's chat that knows a
 * turn other than the entry's own.
 */
function laterShutdownTurn(
  existing: UsageLimitedChatEntry,
  incoming: InterruptedChatRecord[],
): InterruptedChatRecord | undefined {
  if (existing.resumeReason !== 'app_shutdown') return undefined;
  return incoming.find(
    (entry) =>
      entry.resumeReason === 'app_shutdown' &&
      entry.interruptedUserMessageId &&
      entry.interruptedUserMessageId !== existing.interruptedUserMessageId &&
      sameTarget(existing, entry),
  );
}

function startedAfter(
  record: InterruptedChatRecord,
  detectedAt: number,
): boolean {
  return (
    record.turnStartedAt !== undefined && record.turnStartedAt > detectedAt
  );
}

/**
 * Shutdown must await durable recovery writes; preserve existing usage/auth
 * reasons. A later shutdown record whose turn is known to have started after
 * a stored shutdown entry belongs to a later interruption: the entry gives way
 * to it, even when the entry has its own turn. Otherwise a stored shutdown
 * entry without its turn takes the record's turn, and one with a turn keeps
 * it. Other reasons never take another record's turn: it could belong to a
 * later interruption.
 */
export async function recordInterruptedChats(
  entries: InterruptedChatRecord[],
): Promise<void> {
  const uniqueEntries = Array.from(
    new Map(entries.map((entry) => [targetKey(entry), entry])).values(),
  );
  await enqueueWrite((current) => {
    const kept: UsageLimitedChatEntry[] = [];
    const superseded = new Set<UsageLimitedChatEntry>();
    for (const existing of current) {
      if (
        uniqueEntries.some(
          (entry) =>
            entry.resumeReason === 'provider_sign_in' &&
            sameTarget(existing, entry),
        )
      )
        continue;
      const turn = laterShutdownTurn(existing, uniqueEntries);
      if (!turn) kept.push(existing);
      else if (startedAfter(turn, existing.detectedAt))
        superseded.add(existing);
      else if (existing.interruptedUserMessageId) kept.push(existing);
      else
        kept.push({
          ...existing,
          interruptedUserMessageId: turn.interruptedUserMessageId,
        });
    }
    return [
      ...kept,
      ...uniqueEntries
        .filter(
          (entry) =>
            entry.resumeReason === 'provider_sign_in' ||
            !current.some(
              (existing) =>
                !superseded.has(existing) && sameTarget(existing, entry),
            ),
        )
        .map(storedEntry),
    ];
  }, true);
}

/** Dismissing queue history must not revive an explicitly stopped auto-resume. */
export async function suppressDismissedAccountProxyRecovery(
  attempts: ResumeQueueEntry[],
): Promise<void> {
  const dismissed = new Set(
    attempts
      .filter(
        (entry) =>
          entry.accountProxyConnectionId &&
          entry.target.kind === 'chat' &&
          (entry.status === 'stopped' ||
            entry.status === 'failed' ||
            entry.status === 'skipped'),
      )
      .map((entry) =>
        entry.target.kind === 'chat'
          ? `${targetKey(entry.target)}:${entry.interruptionId}`
          : '',
      ),
  );
  if (!dismissed.size) return;
  await enqueueWrite(
    (entries) =>
      entries.map((entry) =>
        dismissed.has(`${targetKey(entry)}:${entry.detectedAt}`)
          ? { ...entry, accountProxyAutoResumeSuppressed: true }
          : entry,
      ),
    true,
  );
}

export interface ClearUsageLimitedChatOptions {
  /**
   * Epoch ms captured before the send/resume that this clear completes. Only an
   * entry detected strictly before that instant is removed.
   *
   * Resuming clears the registry entry *after* dispatching the resume prompt,
   * so a turn that immediately re-hits the usage limit records a NEW entry
   * before the clear runs. Without this guard that clear deletes the fresh
   * record, and the chat vanishes from "Resume interrupted sessions" with no
   * way back to it. Omit the option for callers that are not finishing a
   * dispatch (an already-accepted turn has no in-flight record to protect).
   */
  readonly onlyIfDetectedBefore?: number;
  /** Remove only this exact interruption, preserving a newer replacement. */
  readonly onlyIfDetectedAt?: number;
}

export async function clearAuthenticationInterruptedChat(
  target: UsageLimitedChatTarget,
  attemptId: string,
): Promise<void> {
  await enqueueWrite(
    (entries) =>
      entries.filter(
        (entry) =>
          !sameTarget(entry, target) ||
          entry.authenticationAttemptId !== attemptId,
      ),
    true,
  );
}

export async function clearUsageLimitedChat(
  target: UsageLimitedChatTarget,
  options?: ClearUsageLimitedChatOptions,
): Promise<void> {
  const cutoff = options?.onlyIfDetectedBefore;
  const exact = options?.onlyIfDetectedAt;
  let preservedNewerRecord = false;
  await enqueueWrite((entries) =>
    entries.filter((e) => {
      if (!sameTarget(e, target)) return true;
      if (exact !== undefined) {
        const keep = e.detectedAt !== exact;
        if (keep) preservedNewerRecord = true;
        return keep;
      }
      // Keep a record the dispatched turn itself produced. `>=` rather than
      // `>` because `Date.now()` has millisecond resolution: a record written
      // in the same millisecond we started the dispatch is ambiguous, and
      // keeping a resumable chat is the safe side of that ambiguity.
      const keep = cutoff !== undefined && e.detectedAt >= cutoff;
      if (keep) preservedNewerRecord = true;
      return keep;
    }),
  );
  // A preserved record means the chat is usage-limited again right now, so its
  // attention marker belongs to that new block, not to the one we just
  // finished resuming — dropping it here would leave a blocked chat unbadged.
  if (preservedNewerRecord) return;
  getAttentionTracker().clear(
    target.projectId,
    target.worktreeId,
    target.chatId,
    'usage-limit',
  );
}

interface CodexAuthenticationGrant {
  attemptId: string;
  authFingerprint: string;
  verifiedAt: number;
}

const MAX_CODEX_AUTHENTICATION_GRANTS = 32;
let authenticationGrantWriteChain: Promise<void> = Promise.resolve();

function authenticationGrantsPath(): string {
  return `${getUsageLimitedChatsFilePath()}.authentication-grants.json`;
}

async function readCodexAuthenticationGrants(): Promise<
  CodexAuthenticationGrant[]
> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(authenticationGrantsPath(), 'utf8'),
    );
    if (!isRecord(parsed) || !Array.isArray(parsed.grants)) return [];
    return parsed.grants.filter(
      (grant): grant is CodexAuthenticationGrant =>
        isRecord(grant) &&
        typeof grant.attemptId === 'string' &&
        typeof grant.authFingerprint === 'string' &&
        typeof grant.verifiedAt === 'number',
    );
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return [];
    throw error;
  }
}

export async function recordCodexAuthenticationGrant(
  attemptId: string,
  authFingerprint: string,
): Promise<void> {
  const writeGrant = async (): Promise<void> => {
    const current = await readCodexAuthenticationGrants();
    const grants = [
      ...current.filter((grant) => grant.attemptId !== attemptId),
      { attemptId, authFingerprint, verifiedAt: Date.now() },
    ].slice(-MAX_CODEX_AUTHENTICATION_GRANTS);
    const filePath = authenticationGrantsPath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFileAtomically(
      filePath,
      JSON.stringify({ version: 1, grants }, null, 2),
      { encoding: 'utf8' },
    );
  };
  const pending = authenticationGrantWriteChain.then(writeGrant, writeGrant);
  authenticationGrantWriteChain = pending.catch(() => undefined);
  await pending;
}

/** Serialized after any in-flight grant write so cancellation cannot leave it behind. */
export async function revokeCodexAuthenticationGrant(
  attemptId: string,
): Promise<void> {
  const revoke = async (): Promise<void> => {
    const current = await readCodexAuthenticationGrants();
    const grants = current.filter((grant) => grant.attemptId !== attemptId);
    if (grants.length === current.length) return;
    const filePath = authenticationGrantsPath();
    await writeFileAtomically(
      filePath,
      JSON.stringify({ version: 1, grants }, null, 2),
      { encoding: 'utf8' },
    );
  };
  const pending = authenticationGrantWriteChain.then(revoke, revoke);
  authenticationGrantWriteChain = pending.catch(() => undefined);
  await pending;
}

export async function hasCodexAuthenticationGrant(
  attemptId: string,
  authFingerprint: string,
): Promise<boolean> {
  await authenticationGrantWriteChain;
  return (await readCodexAuthenticationGrants()).some(
    (grant) =>
      grant.attemptId === attemptId &&
      grant.authFingerprint === authFingerprint,
  );
}

interface CodexAuthenticationResumeClaim {
  key: string;
  claimedAt: number;
}

const MAX_CODEX_AUTHENTICATION_RESUME_CLAIMS = 128;
let authenticationResumeClaimWriteChain: Promise<void> = Promise.resolve();

function authenticationResumeClaimsPath(): string {
  return `${getUsageLimitedChatsFilePath()}.authentication-resume-claims.json`;
}

async function readCodexAuthenticationResumeClaims(): Promise<
  CodexAuthenticationResumeClaim[]
> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(authenticationResumeClaimsPath(), 'utf8'),
    );
    if (!isRecord(parsed) || !Array.isArray(parsed.claims)) return [];
    return parsed.claims.filter(
      (claim): claim is CodexAuthenticationResumeClaim =>
        isRecord(claim) &&
        typeof claim.key === 'string' &&
        typeof claim.claimedAt === 'number',
    );
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return [];
    throw error;
  }
}

export async function claimCodexAuthenticationResume(
  key: string,
): Promise<boolean> {
  let claimed = false;
  const writeClaim = async (): Promise<void> => {
    const current = await readCodexAuthenticationResumeClaims();
    if (current.some((claim) => claim.key === key)) return;
    claimed = true;
    const claims = [...current, { key, claimedAt: Date.now() }].slice(
      -MAX_CODEX_AUTHENTICATION_RESUME_CLAIMS,
    );
    const filePath = authenticationResumeClaimsPath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFileAtomically(
      filePath,
      JSON.stringify({ version: 1, claims }, null, 2),
      { encoding: 'utf8' },
    );
  };
  const pending = authenticationResumeClaimWriteChain.then(
    writeClaim,
    writeClaim,
  );
  authenticationResumeClaimWriteChain = pending.catch(() => undefined);
  await pending;
  return claimed;
}

export async function clearCodexAuthenticationResumeClaim(
  key: string,
): Promise<void> {
  const clearClaim = async (): Promise<void> => {
    const current = await readCodexAuthenticationResumeClaims();
    const claims = current.filter((claim) => claim.key !== key);
    if (claims.length === current.length) return;
    const filePath = authenticationResumeClaimsPath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFileAtomically(
      filePath,
      JSON.stringify({ version: 1, claims }, null, 2),
      { encoding: 'utf8' },
    );
  };
  const pending = authenticationResumeClaimWriteChain.then(
    clearClaim,
    clearClaim,
  );
  authenticationResumeClaimWriteChain = pending.catch(() => undefined);
  await pending;
}

export function buildUsageLimitedChatGroups(
  entries: UsageLimitedChatEntry[],
  provider: AgentProviderType,
  activeSessions: ChatActiveSessions,
  isRealWorkspaceTarget: (target: UsageLimitedChatTarget) => boolean,
): UsageLimitedChatGroup[] {
  const activeTurnTargets = new Set(
    (activeSessions.sessions ?? [])
      .filter((s) => s.turnActive)
      .map((s) =>
        targetKey({
          projectId: s.projectId,
          worktreeId: s.worktreeId,
          chatId: s.chatId,
        }),
      ),
  );
  const groups = new Map<string, UsageLimitedChatGroup>();
  for (const entry of entries) {
    if (entry.provider !== provider) continue;
    if (!isRealWorkspaceTarget(entry)) continue;
    if (activeTurnTargets.has(targetKey(entry))) continue;
    const item: UsageLimitedChatItem = {
      projectId: entry.projectId,
      worktreeId: entry.worktreeId,
      chatId: entry.chatId,
      provider: entry.provider,
      ...(entry.accountProxyConnectionId
        ? { accountProxyConnectionId: entry.accountProxyConnectionId }
        : {}),
      chatTitle: entry.chatTitle,
      detectedAt: entry.detectedAt,
      // Real branch/worktree name is resolved by the list IPC handler; default
      // to the id so the field is always populated.
      worktreeName: entry.worktreeId,
      ...(typeof entry.resetsAt === 'number'
        ? { resetsAt: entry.resetsAt }
        : {}),
      authenticationAttemptId: entry.authenticationAttemptId,
      resumeReason: entry.resumeReason ?? 'usage_limit',
    };
    const workspaceId = displayWorkspaceId(entry);
    const existing = groups.get(workspaceId);
    if (existing) {
      existing.chats.push(item);
    } else {
      groups.set(workspaceId, {
        workspaceId,
        workspaceName: entry.workspaceName,
        // Recorded kind (falls back to single-repo only for legacy entries
        // predating the field); the list IPC prefers the live index type.
        workspaceType: displayWorkspaceType(entry),
        chats: [item],
      });
    }
  }
  for (const group of Array.from(groups.values())) {
    group.chats.sort((a, b) => a.detectedAt - b.detectedAt);
  }
  return Array.from(groups.values()).sort((a, b) =>
    a.workspaceName.localeCompare(b.workspaceName),
  );
}
