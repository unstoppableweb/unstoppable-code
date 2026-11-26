import type {
  ApprovalDefaults,
  ApprovalRule,
} from '@canopy/desktop-shared/types';

const workspaceRuleRevisions = new Map<string, number>();
const workspaceRuleSavesInFlight = new Map<string, number>();
const workspaceRuleSaveGenerations = new Map<string, number>();
let globalRuleRevision = 0;
let globalRuleSaveGeneration = 0;
let approvalSettingsRevision = 0;

export function getWorkspaceApprovalRulesRevision(workspaceId: string): number {
  return workspaceRuleRevisions.get(workspaceId) ?? 0;
}

function advanceWorkspaceApprovalRulesSaveGeneration(
  workspaceId: string,
): void {
  workspaceRuleSaveGenerations.set(
    workspaceId,
    getWorkspaceApprovalRulesSaveGeneration(workspaceId) + 1,
  );
  advanceApprovalAuthorityRevision();
}

/**
 * Registers a workspace approvals save until it settles. Register it in the
 * step that starts it, so no cached rule tier is used once it has begun.
 */
export function trackWorkspaceApprovalRulesSave<T>(
  workspaceId: string,
  save: Promise<T>,
): Promise<T> {
  workspaceRuleSavesInFlight.set(
    workspaceId,
    (workspaceRuleSavesInFlight.get(workspaceId) ?? 0) + 1,
  );
  advanceWorkspaceApprovalRulesSaveGeneration(workspaceId);
  function release(): void {
    const remaining = (workspaceRuleSavesInFlight.get(workspaceId) ?? 1) - 1;
    if (remaining > 0) workspaceRuleSavesInFlight.set(workspaceId, remaining);
    else workspaceRuleSavesInFlight.delete(workspaceId);
    advanceWorkspaceApprovalRulesSaveGeneration(workspaceId);
  }
  save.then(release, release);
  return save;
}

/**
 * Changes when a workspace approvals save starts and when it settles, so a
 * decision reused by policy key is never carried into or across one.
 */
export function getWorkspaceApprovalRulesSaveGeneration(
  workspaceId: string,
): number {
  return workspaceRuleSaveGenerations.get(workspaceId) ?? 0;
}

/**
 * Whether a cached workspace rule tier may still authorize. Not while a save
 * is in flight: it may remove an allow, and reads wait for its outcome.
 */
export function isWorkspaceApprovalRulesSettled(workspaceId: string): boolean {
  return !workspaceRuleSavesInFlight.has(workspaceId);
}

/**
 * Whether saving `next` over `previous` may revoke a file-write grant: it
 * drops a file-write allow or adds a file-write deny. An unknown `previous`
 * may.
 */
export function narrowsFileWriteRules(
  previous: readonly ApprovalRule[] | undefined,
  next: readonly ApprovalRule[],
): boolean {
  if (previous === undefined) return true;
  const targets = (
    rules: readonly ApprovalRule[],
    behavior: ApprovalRule['behavior'],
  ): string[] =>
    rules
      .filter(
        (rule) =>
          rule.behavior === behavior && rule.target.kind === 'file-write',
      )
      .map((rule) => JSON.stringify(rule.target));
  const nextAllows = new Set(targets(next, 'allow'));
  const previousDenies = new Set(targets(previous, 'deny'));
  return (
    targets(previous, 'allow').some((target) => !nextAllows.has(target)) ||
    targets(next, 'deny').some((target) => !previousDenies.has(target))
  );
}

const workspaceFileWriteNarrowings = new Map<string, number>();

/**
 * Marks a workspace save that {@link narrowsFileWriteRules} until the
 * returned release runs. Mark it before the save installs the file.
 */
export function markWorkspaceFileWriteNarrowing(
  workspaceId: string,
): () => void {
  workspaceFileWriteNarrowings.set(
    workspaceId,
    (workspaceFileWriteNarrowings.get(workspaceId) ?? 0) + 1,
  );
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    const remaining = (workspaceFileWriteNarrowings.get(workspaceId) ?? 1) - 1;
    if (remaining > 0) workspaceFileWriteNarrowings.set(workspaceId, remaining);
    else workspaceFileWriteNarrowings.delete(workspaceId);
  };
}

export function markWorkspaceApprovalRulesChanged(workspaceId: string): void {
  workspaceRuleRevisions.set(
    workspaceId,
    getWorkspaceApprovalRulesRevision(workspaceId) + 1,
  );
  approvalSettingsRevision++;
  advanceApprovalAuthorityRevision();
}

export function getGlobalApprovalRulesRevision(): number {
  return globalRuleRevision;
}

export function markGlobalApprovalRulesChanged(): void {
  globalRuleRevision++;
  approvalSettingsRevision++;
  advanceApprovalAuthorityRevision();
}

/**
 * The preferences fields that main re-reads as approval authority. Not here:
 * App Advisor project agent access, which main applies in memory only after a
 * confirmed save, and capability opt-ins such as managed delegation, whose
 * children run under their parent chat's approval mode and rules.
 */
export interface PreferencesApprovalAuthority {
  globalApprovalRules: readonly ApprovalRule[];
  approvalDefaults: ApprovalDefaults;
}

/**
 * The approval authority last confirmed durable, while a later preferences
 * save has an unknown outcome. Process-local: after a restart the file on
 * disk is authoritative.
 */
let confirmedPreferencesAuthority: PreferencesApprovalAuthority | null = null;
let preferencesAuthorityRevision = 0;
let preferencesAuthoritySave: Promise<void> | null = null;
let preferencesAuthoritySaveNarrowsFileWrites = false;

function markPreferencesAuthorityChanged(): void {
  preferencesAuthorityRevision++;
  markGlobalApprovalRulesChanged();
}

/** A preferences save from `confirmed` has an unknown outcome. */
export function markPreferencesAuthorityUnconfirmed(
  confirmed: PreferencesApprovalAuthority,
): void {
  confirmedPreferencesAuthority ??= confirmed;
  markPreferencesAuthorityChanged();
}

/** A preferences save is confirmed, so the whole file on disk is. */
export function markPreferencesAuthorityConfirmed(): void {
  if (confirmedPreferencesAuthority === null) return;
  confirmedPreferencesAuthority = null;
  markPreferencesAuthorityChanged();
}

/**
 * Registers a save that changes approval authority; it must settle only after
 * its outcome is marked. Preferences saves are serialized, so one slot holds.
 */
export function trackPreferencesAuthoritySave<T>(
  save: Promise<T>,
  options: { narrowsFileWrites: boolean },
): Promise<T> {
  const settled: Promise<void> = save.then(release, release);
  function release(): void {
    if (preferencesAuthoritySave === settled) {
      preferencesAuthoritySave = null;
      preferencesAuthoritySaveNarrowsFileWrites = false;
    }
    globalRuleSaveGeneration++;
    advanceApprovalAuthorityRevision();
  }
  preferencesAuthoritySave = settled;
  preferencesAuthoritySaveNarrowsFileWrites = options.narrowsFileWrites;
  globalRuleSaveGeneration++;
  advanceApprovalAuthorityRevision();
  return save;
}

/** The global-tier counterpart of {@link isWorkspaceApprovalRulesSettled}. */
export function isGlobalApprovalRulesSettled(): boolean {
  return preferencesAuthoritySave === null;
}

/**
 * Whether a save that may revoke a file-write grant is in flight for the
 * workspace or the global tier. Rule reads wait for its outcome; a sandbox
 * that writes without asking has to stop meanwhile.
 */
export function isFileWriteNarrowingInFlight(workspaceId: string): boolean {
  return (
    workspaceFileWriteNarrowings.has(workspaceId) ||
    preferencesAuthoritySaveNarrowsFileWrites
  );
}

/** The global-tier counterpart of {@link getWorkspaceApprovalRulesSaveGeneration}. */
export function getGlobalApprovalRulesSaveGeneration(): number {
  return globalRuleSaveGeneration;
}

/**
 * Runs `read` outside any save that changes approval authority, and returns
 * the last confirmed authority when the file may hold an unconfirmed one.
 * Every approval decision that reads authority from preferences goes through
 * here and resolves no more permissively than that confirmed authority.
 */
export async function readPreferencesApprovalAuthority<T>(
  read: () => Promise<T>,
): Promise<{ value: T; confirmed: PreferencesApprovalAuthority | undefined }> {
  for (;;) {
    const saving = preferencesAuthoritySave;
    if (saving) {
      await saving;
      continue;
    }
    const revision = preferencesAuthorityRevision;
    const value = await read();
    if (
      preferencesAuthoritySave !== null ||
      preferencesAuthorityRevision !== revision
    ) {
      continue;
    }
    return { value, confirmed: confirmedPreferencesAuthority ?? undefined };
  }
}

/** A surface's persisted default approval mode is changing or changed. */
export function markApprovalDefaultsChanged(): void {
  approvalSettingsRevision++;
  approvalDefaultsRevision++;
  advanceApprovalAuthorityRevision();
}

let approvalDefaultsRevision = 0;

/** Changes only when a surface's persisted default approval mode changes. */
export function getApprovalDefaultsRevision(): number {
  return approvalDefaultsRevision;
}

/**
 * Changes whenever a workspace or global rule tier, a workspace's
 * approvals file, or a surface's default mode changes, so a synchronous
 * step can tell whether policies read before it are still current.
 */
export function getApprovalSettingsRevision(): number {
  return approvalSettingsRevision;
}

const chatApprovalStateRevisions = new Map<string, number>();

function chatApprovalStateKey(chat: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): string {
  return `${chat.projectId}\u0000${chat.worktreeId}\u0000${chat.chatId}`;
}

/** A chat's tab changed its approval mode, session grants, or repository. */
export function markChatApprovalStateChanged(chat: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): void {
  const key = chatApprovalStateKey(chat);
  chatApprovalStateRevisions.set(
    key,
    (chatApprovalStateRevisions.get(key) ?? 0) + 1,
  );
  advanceApprovalAuthorityRevision();
}

/**
 * Changes whenever a commit changes the chat's tab approval mode, session
 * grants, or selected repository, in the synchronous step that builds it.
 */
export function getChatApprovalStateRevision(chat: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): number {
  return chatApprovalStateRevisions.get(chatApprovalStateKey(chat)) ?? 0;
}

let approvalAuthorityRevision = 0;
let approvalAuthorityNotifyQueued = false;
const approvalAuthorityListeners = new Set<(revision: number) => void>();

/**
 * One monotonic revision for this authority's approval policy (ADR 22a rule
 * 2, CAN-4129). Every marker that changes rules, defaults, saves in flight,
 * a chat's approval state or a live approval mode advances it, so an approval
 * shown under an older revision can be recognised and refused.
 */
export function getApprovalAuthorityRevision(): number {
  return approvalAuthorityRevision;
}

/** Advances the revision; listeners run once in the next microtask with the newest value. */
export function advanceApprovalAuthorityRevision(): void {
  approvalAuthorityRevision++;
  if (approvalAuthorityNotifyQueued) return;
  approvalAuthorityNotifyQueued = true;
  queueMicrotask(() => {
    approvalAuthorityNotifyQueued = false;
    const revision = approvalAuthorityRevision;
    for (const listener of Array.from(approvalAuthorityListeners)) {
      try {
        listener(revision);
      } catch {
        // One listener must not stop the others; the broker reports its own errors.
      }
    }
  });
}

/** Observes revision advances; returns an unsubscribe. */
export function onApprovalAuthorityRevision(
  listener: (revision: number) => void,
): () => void {
  approvalAuthorityListeners.add(listener);
  return () => {
    approvalAuthorityListeners.delete(listener);
  };
}
