/**
 * Background format 4 promotion sweep (CAN-7178).
 *
 * A scope promotes to format 4 only while it is loaded, so a scope nobody
 * opens keeps its older format. The daemon host never writes format 3
 * (CAN-7085), so every scope has to reach format 4 before that hand-off.
 * This sweep finds scopes below format 4 and asks the repository to promote
 * them one at a time, only while the app is idle, through the same load path
 * and lease as any other open (`ChatStateV2Repository.sweepFormat4`). It adds
 * no writer and no storage format, and follows the format 4 stop switch.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
} from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { getDataDir } from '../lib/paths';
import {
  resolveChatArchivesFilePath,
  resolveChatJournalFilePath,
  resolveChatTabsFilePath,
} from '../lib/resolve-worktree';
import { fsyncDirectory } from '../lib/fsync-directory';
import { isErrnoException } from '../lib/type-guards';
import type { ChatScopeKey } from './chat-state-contracts';
import {
  chatFormat4FailureReason,
  recordChatFormat4Outcome,
  type ChatFormat4Outcome,
  type ChatFormat4PauseReason,
  type ChatFormat4Reason,
} from './chat-format4-telemetry';
import type { ChatStateV2Repository } from './chat-state-v2-repository';

/** What the repository did with one sweep admission. */
export type ChatFormat4SweepAttempt =
  | { readonly outcome: 'promoted' }
  | { readonly outcome: 'already_format4' }
  /** Loaded, loading, draining or leased by someone else: nothing was read. */
  | { readonly outcome: 'held' }
  /** The format 4 stop switch is off: the scope may have reached format 3. */
  | { readonly outcome: 'withheld' }
  | { readonly outcome: 'failed'; readonly reason: ChatFormat4Reason };

export interface ChatFormat4SweepTarget {
  /** Never waits behind another holder; promotes, then unloads at once. */
  sweepFormat4(scope: ChatScopeKey): Promise<ChatFormat4SweepAttempt>;
  /** The format 4 stop switch, asked before every scope. */
  promotionAllowed(): boolean;
}

export interface ChatFormat4SweepConditions {
  /** True while any chat turn is in flight in any scope. */
  turnInFlight(): boolean | Promise<boolean>;
  /** Milliseconds since the last user input, in the app or the system. */
  idleMs(): number;
  onBattery(): boolean;
  /** Free bytes on the volume holding `path`; undefined when unknown. */
  freeBytes(path: string): Promise<number | undefined>;
}

export interface ChatFormat4SweepClock {
  now(): number;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface ChatFormat4SweepOptions {
  readonly dataDir: string;
  readonly target: ChatFormat4SweepTarget;
  readonly conditions: ChatFormat4SweepConditions;
  readonly resolveStore: (scope: ChatScopeKey) => ChatStorageV2;
  readonly report?: (outcome: ChatFormat4Outcome) => void;
  readonly clock?: ChatFormat4SweepClock;
}

/** The sweep waits this long after start-up, clear of hydration and backfill. */
export const CHAT_FORMAT4_SWEEP_START_DELAY_MS = 120_000;
/** A scope starts only after this long without user input. */
export const CHAT_FORMAT4_SWEEP_IDLE_MS = 60_000;
/** How often an unmet idle condition is checked again. */
export const CHAT_FORMAT4_SWEEP_RECHECK_MS = 60_000;
/** The wait after a scope is at least this, and at least four times its time. */
export const CHAT_FORMAT4_SWEEP_MIN_GAP_MS = 5_000;
export const CHAT_FORMAT4_SWEEP_GAP_FACTOR = 4;
/** A scope's attempts per session, as the repository's own promotion retries. */
export const CHAT_FORMAT4_SWEEP_SESSION_ATTEMPTS = 5;
export const CHAT_FORMAT4_SWEEP_FIRST_RETRY_MS = 30_000;
/** A held scope is offered again after these, then every hour. */
export const CHAT_FORMAT4_SWEEP_HELD_RETRY_MS = [600_000, 3_600_000] as const;
/** Launches a scope sits out after each session it failed in (capped). */
export const CHAT_FORMAT4_SWEEP_LAUNCH_BACKOFF = [1, 2, 4] as const;
/** Free space a promotion needs beyond twice the scope's size. */
export const CHAT_FORMAT4_SWEEP_DISK_MARGIN_BYTES = 256 * 1024 * 1024;
/** How soon a pass with scopes left over runs again. */
export const CHAT_FORMAT4_SWEEP_PASS_INTERVAL_MS = 600_000;
/** The most recently used scopes go first; the rest go smallest first. */
export const CHAT_FORMAT4_SWEEP_RECENT_FIRST = 10;

export const CHAT_FORMAT4_SWEEP_STATE_FILE_NAME =
  'chat-format4-sweep-state.json';
export const CHAT_FORMAT4_SWEEP_DONE_FILE_NAME =
  'chat-format4-sweep-complete.json';

/** `unknown`: the manifest can't be read; the sweep offers it and backs off. */
export type ChatFormat4SweepFormat = 'v1' | 'v2' | 'v3' | 'v4' | 'unknown';

export interface ChatFormat4SweepCandidate {
  readonly scope: ChatScopeKey;
  /** A local, content-free key for the scope's backoff; never sent. */
  readonly key: string;
  readonly directory: string;
  readonly format: ChatFormat4SweepFormat;
  readonly bytes: number;
  readonly usedAt: number;
  /** Scopes the sweep leaves alone until their owners rule (CAN-7178). */
  readonly excluded: boolean;
}

export interface ChatFormat4SweepInventory {
  readonly candidates: readonly ChatFormat4SweepCandidate[];
  /** Stored scopes the inventory could not map back to a scope key. */
  readonly unmapped: number;
}

export interface ChatFormat4SweepPassResult {
  readonly status: 'complete' | 'remaining' | 'withheld' | 'stopped';
  readonly promoted: number;
  readonly remaining: number;
}

const PLAN_EXPLORE_NAMESPACE = 'plan-explore-chats';
const MANIFESTS = 'chat-storage-manifests';

/**
 * Viewer scopes never promote (`promotable()`), and code-review scopes wait
 * for their namespace's admission work (CAN-6848). Neither is opened by the
 * sweep, but a stored one below format 4 still keeps the sweep incomplete.
 */
function excludedScope(scope: ChatScopeKey): boolean {
  return (
    scope.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID ||
    scope.projectId === CODE_REVIEW_CHAT_PROJECT_ID
  );
}

export function chatFormat4SweepKey(directory: string): string {
  return createHash('sha256').update(directory).digest('hex').slice(0, 16);
}

/** Folders that exist but can't be listed; each one keeps the sweep incomplete. */
interface Unreadable {
  count: number;
}

async function listEntries(
  directory: string,
  unreadable: Unreadable,
  keep: (entry: Dirent) => boolean,
): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter(keep)
      .map((entry) => entry.name);
  } catch (error) {
    if (!missing(error)) unreadable.count += 1;
    return [];
  }
}

function listNames(
  directory: string,
  unreadable: Unreadable,
): Promise<string[]> {
  return listEntries(directory, unreadable, (entry) => entry.isFile());
}

function listDirectories(
  directory: string,
  unreadable: Unreadable,
): Promise<string[]> {
  return listEntries(directory, unreadable, (entry) => entry.isDirectory());
}

function jsonIds(names: readonly string[]): string[] {
  return names
    .filter((name) => name.endsWith('.json') && !name.endsWith('.tmp'))
    .map((name) => basename(name, '.json'));
}

/** Scope ids from legacy file names, `<id><suffix>` or its `.bak` backup. */
function legacyIds(names: readonly string[], suffix: string): string[] {
  const ids = new Set<string>();
  for (const name of names) {
    const file = name.endsWith('.bak') ? name.slice(0, -'.bak'.length) : name;
    if (file.endsWith(suffix) && file.length > suffix.length)
      ids.add(file.slice(0, -suffix.length));
  }
  return Array.from(ids).filter((id) => !NON_SCOPE_CHAT_FILES.has(id));
}

async function treeBytes(directory: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += await treeBytes(path);
    else if (entry.isFile())
      total += await stat(path).then(
        (info) => info.size,
        () => 0,
      );
  }
  return total;
}

async function latestMtime(paths: readonly string[]): Promise<number> {
  let latest = 0;
  for (const path of paths)
    latest = Math.max(
      latest,
      await stat(path).then(
        (info) => info.mtimeMs,
        () => 0,
      ),
    );
  return latest;
}

/** Every stored scope under one chat workspace root, by its own scope ids. */
/** Files in a `chats/` directory that are not chat scopes. */
const NON_SCOPE_CHAT_FILES: ReadonlySet<string> = new Set(['registry']);

async function scopeIdsUnder(
  root: string,
  unreadable: Unreadable,
): Promise<{
  ids: string[];
  manifests: string[];
}> {
  const tabs = legacyIds(
    await listNames(join(root, 'chats'), unreadable),
    '.json',
  );
  const manifests = jsonIds(await listNames(join(root, MANIFESTS), unreadable));
  const archives = legacyIds(
    await listNames(join(root, 'chat-archives'), unreadable),
    '.json',
  );
  const journals = legacyIds(
    await listNames(join(root, 'chat-journals'), unreadable),
    '.jsonl',
  );
  return {
    ids: Array.from(new Set([...tabs, ...archives, ...journals, ...manifests])),
    manifests,
  };
}

/**
 * The stored chat scopes below `dataDir`, with each one's format read from
 * its manifest alone (no lease, no load). A stored scope whose canonical
 * resolver doesn't land back on the same storage is counted as unmapped, so
 * the sweep never reports itself complete while one exists.
 */
export async function listChatFormat4SweepCandidates(
  dataDir: string,
  resolveStore: (scope: ChatScopeKey) => ChatStorageV2,
): Promise<ChatFormat4SweepInventory> {
  const candidates: ChatFormat4SweepCandidate[] = [];
  let unmapped = 0;
  const unreadable: Unreadable = { count: 0 };
  const seen = new Set<string>();

  const add = async (
    scope: ChatScopeKey,
    expectedRoot: string,
  ): Promise<void> => {
    let store: ChatStorageV2;
    try {
      store = resolveStore(scope);
    } catch {
      unmapped += 1;
      return;
    }
    const { workspaceRoot, legacyPaths = [] } = store.descriptor();
    if (workspaceRoot !== expectedRoot) {
      unmapped += 1;
      return;
    }
    if (seen.has(store.directory)) return;
    seen.add(store.directory);
    let format: ChatFormat4SweepFormat;
    try {
      format = await store.format();
    } catch {
      format = 'unknown';
    }
    if (format === 'v1' && !(await legacyScopeFiles(legacyPaths))) return;
    // A legacy scope with no tabs file left (only its tabs backup, archived
    // tabs or journal) is counted, so the sweep can't report itself complete
    // over it, but never offered: migration removes every legacy file once
    // version 2 validates, before format 4 exists, so these wait for a
    // follow-up that keeps them until format 4 verifies (SWAN, 17 Nov).
    const tabsMissing =
      format === 'v1' && !(await legacyTabsPresent(legacyPaths[0]));
    candidates.push({
      scope,
      key: chatFormat4SweepKey(store.directory),
      directory: store.directory,
      format,
      bytes:
        format === 'v4'
          ? 0
          : (await treeBytes(store.directory)) +
            (await legacyBytes(legacyPaths)),
      usedAt: await latestMtime([store.manifestPath, ...legacyPaths]),
      excluded: excludedScope(scope) || tabsMissing,
    });
  };

  for (const parent of [
    join(dataDir, 'workspaces'),
    join(dataDir, 'app-workspaces'),
  ])
    for (const projectId of await listDirectories(parent, unreadable)) {
      const root = join(parent, projectId);
      const { ids } = await scopeIdsUnder(root, unreadable);
      for (const id of ids) {
        if (id.startsWith(`${PLAN_EXPLORE_NAMESPACE}-`)) {
          unmapped += 1;
          continue;
        }
        await add({ projectId, worktreeId: id }, root);
      }
    }

  // A plan's tabs live in `plan-explore-chats/`, and its journal in the data
  // directory's own `chat-journals/`; its archives sit under the sentinel's
  // workspace, which the loop above counts as unmapped.
  const planIds = [
    ...legacyIds(
      await listNames(join(dataDir, PLAN_EXPLORE_NAMESPACE), unreadable),
      '.json',
    ),
    ...legacyIds(
      await listNames(join(dataDir, 'chat-journals'), unreadable),
      '.jsonl',
    ),
  ];
  const rootManifests = jsonIds(
    await listNames(join(dataDir, MANIFESTS), unreadable),
  );
  for (const name of rootManifests) {
    if (name.startsWith(`${PLAN_EXPLORE_NAMESPACE}-`))
      planIds.push(name.slice(PLAN_EXPLORE_NAMESPACE.length + 1));
    else unmapped += 1;
  }
  for (const planId of Array.from(new Set(planIds)))
    await add(
      { projectId: PLAN_EXPLORE_CHAT_PROJECT_ID, worktreeId: planId },
      dataDir,
    );

  return { candidates, unmapped: unmapped + unreadable.count };
}

/**
 * Whether a legacy tabs path holds a chat scope. A `.bak` snapshot, which
 * migration recovers from, or a primary file that can't be parsed both count,
 * so the sweep offers them and counts them until they promote, as do the
 * scope's archives or journal alone. Only a primary file that parses as
 * JSON but isn't a chats file, with nothing else beside it, is skipped.
 * A file the sweep can't read counts too: only a missing one doesn't.
 */
async function legacyScopeFiles(paths: readonly string[]): Promise<boolean> {
  const [path, ...others] = paths;
  if (path === undefined) return false;
  if (await present(`${path}.bak`)) return true;
  for (const other of others)
    if ((await present(other)) || (await present(`${other}.bak`))) return true;
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return !missing(error);
  }
  try {
    const raw: unknown = JSON.parse(text);
    return isRecord(raw) && Array.isArray(raw.tabs);
  } catch {
    return true;
  }
}

/** Whether the scope's own tabs file is there; its backup alone doesn't count. */
async function legacyTabsPresent(path: string | undefined): Promise<boolean> {
  return path !== undefined && present(path);
}

function missing(error: unknown): boolean {
  return (
    isErrnoException(error) &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

/** Whether a path may hold data: only a missing path doesn't. */
function present(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    (error: unknown) => !missing(error),
  );
}

/** The path itself, or its nearest ancestor that exists. */
async function nearestExisting(path: string): Promise<string> {
  let current = path;
  for (;;) {
    if (
      await stat(current).then(
        () => true,
        () => false,
      )
    )
      return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/** The legacy files' sizes, backups included: migration can recover from one. */
async function legacyBytes(paths: readonly string[]): Promise<number> {
  let total = 0;
  for (const path of paths.flatMap((file) => [file, `${file}.bak`]))
    total += await stat(path).then(
      (info) => info.size,
      () => 0,
    );
  return total;
}

/** The order scopes are offered in: recent first, then smallest first. */
export function orderChatFormat4SweepCandidates(
  candidates: readonly ChatFormat4SweepCandidate[],
): ChatFormat4SweepCandidate[] {
  const byRecency = [...candidates].sort(
    (a, b) => b.usedAt - a.usedAt || a.bytes - b.bytes,
  );
  const recent = byRecency.slice(0, CHAT_FORMAT4_SWEEP_RECENT_FIRST);
  const rest = byRecency
    .slice(CHAT_FORMAT4_SWEEP_RECENT_FIRST)
    .sort((a, b) => a.bytes - b.bytes || b.usedAt - a.usedAt);
  return [...recent, ...rest];
}

interface ScopeBackoff {
  /** Sessions this scope failed every attempt in, in a row. */
  failedSessions: number;
  /** The first launch it may be offered again. */
  retryAtLaunch: number;
}

interface SweepState {
  version: 1;
  launch: number;
  scopes: Record<string, ScopeBackoff>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSweepState(raw: unknown): SweepState {
  const empty: SweepState = { version: 1, launch: 0, scopes: {} };
  if (!isRecord(raw) || raw.version !== 1) return empty;
  const launch = raw.launch;
  if (typeof launch !== 'number' || !Number.isInteger(launch) || launch < 0)
    return empty;
  const scopes: Record<string, ScopeBackoff> = {};
  if (isRecord(raw.scopes))
    for (const [key, value] of Object.entries(raw.scopes)) {
      if (!/^[0-9a-f]{16}$/.test(key) || !isRecord(value)) continue;
      const { failedSessions, retryAtLaunch } = value;
      if (
        typeof failedSessions === 'number' &&
        Number.isInteger(failedSessions) &&
        failedSessions > 0 &&
        typeof retryAtLaunch === 'number' &&
        Number.isInteger(retryAtLaunch)
      )
        scopes[key] = { failedSessions, retryAtLaunch };
    }
  return { version: 1, launch, scopes };
}

/** Temp file, file sync, rename, directory sync. */
async function writeDurably(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'w');
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await fsyncDirectory(dirname(path));
}

export function chatFormat4SweepDonePath(dataDir: string): string {
  return join(dataDir, CHAT_FORMAT4_SWEEP_DONE_FILE_NAME);
}

export function chatFormat4SweepStatePath(dataDir: string): string {
  return join(dataDir, CHAT_FORMAT4_SWEEP_STATE_FILE_NAME);
}

export async function readChatFormat4SweepState(
  dataDir: string,
): Promise<SweepState> {
  try {
    return parseSweepState(
      JSON.parse(await readFile(chatFormat4SweepStatePath(dataDir), 'utf8')),
    );
  } catch {
    return { version: 1, launch: 0, scopes: {} };
  }
}

/** Whether the last full pass found every stored scope in format 4. */
export async function chatFormat4SweepComplete(
  dataDir: string,
): Promise<boolean> {
  return stat(chatFormat4SweepDonePath(dataDir)).then(
    () => true,
    () => false,
  );
}

const realClock: ChatFormat4SweepClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(done, ms);
      timer.unref?.();
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    }),
};

interface SessionScope {
  attempts: number;
  notBefore: number;
  held: number;
  reported: boolean;
}

export class ChatFormat4Sweep {
  private readonly clock: ChatFormat4SweepClock;
  private readonly controller = new AbortController();
  private readonly session = new Map<string, SessionScope>();
  private readonly pausesReported = new Set<ChatFormat4PauseReason>();
  private state: SweepState = { version: 1, launch: 0, scopes: {} };
  private running: Promise<void> | undefined;

  public constructor(private readonly options: ChatFormat4SweepOptions) {
    this.clock = options.clock ?? realClock;
  }

  /** Starts the sweep after its start-up delay; a second call does nothing. */
  public start(
    initialDelayMs: number = CHAT_FORMAT4_SWEEP_START_DELAY_MS,
  ): void {
    if (this.running || this.controller.signal.aborted) return;
    this.running = this.loop(initialDelayMs).catch(() => undefined);
  }

  /** Stops at the next scope; the scope in hand finishes first. */
  public async stop(): Promise<void> {
    this.controller.abort();
    await this.running;
  }

  private get stopped(): boolean {
    return this.controller.signal.aborted;
  }

  private async loop(initialDelayMs: number): Promise<void> {
    await this.clock.sleep(initialDelayMs, this.controller.signal);
    if (this.stopped) return;
    await this.beginLaunch();
    while (!this.stopped) {
      // A pass that throws, or finds the switch off, is tried again later;
      // only a complete pass or a stop ends the sweep.
      const result = await this.runPass().catch(() => undefined);
      if (result?.status === 'complete' || result?.status === 'stopped') return;
      await this.clock.sleep(
        result?.status === 'withheld'
          ? CHAT_FORMAT4_SWEEP_PASS_INTERVAL_MS
          : this.nextPassDelay(),
        this.controller.signal,
      );
    }
  }

  /** The pass interval, or sooner when a failed scope's retry is due first. */
  private nextPassDelay(): number {
    const now = this.clock.now();
    let delay: number = CHAT_FORMAT4_SWEEP_PASS_INTERVAL_MS;
    for (const entry of this.session.values())
      if (
        entry.attempts > 0 &&
        entry.attempts < CHAT_FORMAT4_SWEEP_SESSION_ATTEMPTS
      )
        delay = Math.min(delay, Math.max(0, entry.notBefore - now));
    return Math.max(delay, CHAT_FORMAT4_SWEEP_MIN_GAP_MS);
  }

  /** Counts this launch for the cross-launch backoff; once per app start. */
  public async beginLaunch(): Promise<void> {
    const { dataDir } = this.options;
    this.state = await readChatFormat4SweepState(dataDir);
    this.state.launch += 1;
    await this.saveState();
  }

  private async saveState(): Promise<void> {
    await writeDurably(
      chatFormat4SweepStatePath(this.options.dataDir),
      `${JSON.stringify(this.state)}\n`,
    ).catch(() => undefined);
  }

  private report(outcome: ChatFormat4Outcome): void {
    try {
      this.options.report?.(outcome);
    } catch {
      // Telemetry never changes the sweep.
    }
  }

  private pause(reason: ChatFormat4PauseReason): void {
    if (this.pausesReported.has(reason)) return;
    this.pausesReported.add(reason);
    this.report({ event: 'sweep_paused', reason });
  }

  /** Waits until the app is idle; false when the sweep stopped meanwhile. */
  private async waitForIdle(): Promise<boolean> {
    const { conditions } = this.options;
    while (!this.stopped) {
      if (conditions.onBattery()) this.pause('battery');
      else if (
        (await conditions.turnInFlight()) ||
        conditions.idleMs() < CHAT_FORMAT4_SWEEP_IDLE_MS
      )
        this.pause('activity');
      else return true;
      await this.clock.sleep(
        CHAT_FORMAT4_SWEEP_RECHECK_MS,
        this.controller.signal,
      );
    }
    return false;
  }

  private sessionScope(key: string): SessionScope {
    let entry = this.session.get(key);
    if (!entry) {
      entry = { attempts: 0, notBefore: 0, held: 0, reported: false };
      this.session.set(key, entry);
    }
    return entry;
  }

  /** Whether a scope may be offered now, this session and this launch. */
  private offerable(candidate: ChatFormat4SweepCandidate): boolean {
    const backoff = this.state.scopes[candidate.key];
    if (backoff && backoff.retryAtLaunch > this.state.launch) return false;
    const entry = this.session.get(candidate.key);
    if (!entry) return true;
    return (
      entry.attempts < CHAT_FORMAT4_SWEEP_SESSION_ATTEMPTS &&
      entry.notBefore <= this.clock.now()
    );
  }

  private async hasRoom(
    candidate: ChatFormat4SweepCandidate,
  ): Promise<boolean> {
    const free = await this.options.conditions.freeBytes(
      await nearestExisting(dirname(candidate.directory)),
    );
    // Unknown free space is not room: the sweep waits rather than guess.
    if (free === undefined) return false;
    return free >= candidate.bytes * 2 + CHAT_FORMAT4_SWEEP_DISK_MARGIN_BYTES;
  }

  private async recordFailure(
    candidate: ChatFormat4SweepCandidate,
    reason: ChatFormat4Reason,
  ): Promise<void> {
    const entry = this.sessionScope(candidate.key);
    entry.attempts += 1;
    entry.notBefore =
      this.clock.now() +
      CHAT_FORMAT4_SWEEP_FIRST_RETRY_MS * 2 ** (entry.attempts - 1);
    if (entry.attempts < CHAT_FORMAT4_SWEEP_SESSION_ATTEMPTS || entry.reported)
      return;
    entry.reported = true;
    const previous = this.state.scopes[candidate.key];
    const failedSessions = (previous?.failedSessions ?? 0) + 1;
    const wait =
      CHAT_FORMAT4_SWEEP_LAUNCH_BACKOFF[
        Math.min(failedSessions, CHAT_FORMAT4_SWEEP_LAUNCH_BACKOFF.length) - 1
      ] ?? 1;
    this.state.scopes[candidate.key] = {
      failedSessions,
      retryAtLaunch: this.state.launch + 1 + wait,
    };
    await this.saveState();
    this.report({ event: 'sweep_scope_backed_off', reason });
  }

  private async recordSuccess(key: string): Promise<void> {
    this.session.delete(key);
    if (!(key in this.state.scopes)) return;
    delete this.state.scopes[key];
    await this.saveState();
  }

  private async markComplete(complete: boolean): Promise<void> {
    const path = chatFormat4SweepDonePath(this.options.dataDir);
    if (complete)
      await writeDurably(path, `${JSON.stringify({ version: 1 })}\n`).catch(
        () => undefined,
      );
    else await rm(path, { force: true }).catch(() => undefined);
  }

  /**
   * One pass over every stored scope below format 4. The done marker is
   * written only when the pass finds none left, nothing unmapped and nothing
   * excluded below format 4; otherwise any old marker is removed.
   */
  public async runPass(): Promise<ChatFormat4SweepPassResult> {
    const { target, dataDir, resolveStore } = this.options;
    if (!target.promotionAllowed()) {
      this.pause('switch_off');
      return { status: 'withheld', promoted: 0, remaining: 0 };
    }
    const inventory = await listChatFormat4SweepCandidates(
      dataDir,
      resolveStore,
    );
    const below = inventory.candidates.filter((item) => item.format !== 'v4');
    const blocked = below.filter((item) => item.excluded).length;
    const pending = orderChatFormat4SweepCandidates(
      below.filter((item) => !item.excluded),
    );
    let promoted = 0;
    let left = pending.length;
    for (const candidate of pending) {
      if (this.stopped) break;
      if (!this.offerable(candidate)) continue;
      if (!(await this.waitForIdle())) break;
      if (!target.promotionAllowed()) {
        this.pause('switch_off');
        return { status: 'withheld', promoted, remaining: left + blocked };
      }
      if (!(await this.hasRoom(candidate))) {
        this.pause('disk');
        // A retry that can't run for room waits for the next regular pass.
        const entry = this.session.get(candidate.key);
        if (entry)
          entry.notBefore = Math.max(
            entry.notBefore,
            this.clock.now() + CHAT_FORMAT4_SWEEP_PASS_INTERVAL_MS,
          );
        continue;
      }
      const startedAt = this.clock.now();
      let attempt: ChatFormat4SweepAttempt;
      try {
        attempt = await target.sweepFormat4(candidate.scope);
      } catch {
        attempt = { outcome: 'failed', reason: 'other' };
      }
      const elapsed = Math.max(0, this.clock.now() - startedAt);
      switch (attempt.outcome) {
        case 'promoted':
        case 'already_format4':
          promoted += attempt.outcome === 'promoted' ? 1 : 0;
          left -= 1;
          await this.recordSuccess(candidate.key);
          break;
        case 'held': {
          const entry = this.sessionScope(candidate.key);
          entry.notBefore =
            this.clock.now() +
            (CHAT_FORMAT4_SWEEP_HELD_RETRY_MS[entry.held] ??
              CHAT_FORMAT4_SWEEP_HELD_RETRY_MS[
                CHAT_FORMAT4_SWEEP_HELD_RETRY_MS.length - 1
              ]);
          entry.held += 1;
          break;
        }
        case 'withheld':
          this.pause('switch_off');
          return { status: 'withheld', promoted, remaining: left + blocked };
        case 'failed':
          await this.recordFailure(candidate, attempt.reason);
          break;
      }
      if (attempt.outcome === 'held') continue;
      await this.clock.sleep(
        Math.max(
          CHAT_FORMAT4_SWEEP_MIN_GAP_MS,
          elapsed * CHAT_FORMAT4_SWEEP_GAP_FACTOR,
        ),
        this.controller.signal,
      );
    }
    if (this.stopped)
      return { status: 'stopped', promoted, remaining: left + blocked };
    // The marker trusts the disk, not the answers: read every manifest again.
    const after = await listChatFormat4SweepCandidates(dataDir, resolveStore);
    // A scope that left the inventory, or reached format 4, needs no retry.
    const stillBelow = new Set(
      after.candidates
        .filter((item) => item.format !== 'v4')
        .map((item) => item.key),
    );
    for (const key of this.session.keys())
      if (!stillBelow.has(key)) this.session.delete(key);
    const remaining =
      after.candidates.filter((item) => item.format !== 'v4').length +
      after.unmapped;
    await this.markComplete(remaining === 0);
    this.report({ event: 'sweep_pass_completed', remaining });
    return {
      status: remaining === 0 ? 'complete' : 'remaining',
      promoted,
      remaining,
    };
  }
}

/** Free bytes on `path`'s volume, or undefined where it can't be read. */
export async function chatFormat4FreeBytes(
  path: string,
): Promise<number | undefined> {
  try {
    const info = await statfs(path);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return undefined;
  }
}

/** The canonical store of a scope, as the repository resolves it. */
export function resolveChatFormat4SweepStore(
  scope: ChatScopeKey,
): ChatStorageV2 {
  return ChatStorageV2.fromLegacyPaths(
    {
      tabs: resolveChatTabsFilePath(scope.projectId, scope.worktreeId),
      archives: resolveChatArchivesFilePath(scope.projectId, scope.worktreeId),
      journal: resolveChatJournalFilePath(scope.projectId, scope.worktreeId),
    },
    { maxManifestVersion: 4 },
  );
}

/** The repository's sweep admission, with a failure's cause reduced to its code. */
export function repositoryChatFormat4SweepTarget(
  repository: Pick<ChatStateV2Repository, 'sweepFormat4'>,
  promotionAllowed: () => boolean,
): ChatFormat4SweepTarget {
  return {
    promotionAllowed,
    async sweepFormat4(scope): Promise<ChatFormat4SweepAttempt> {
      const attempt = await repository.sweepFormat4(scope);
      return attempt.outcome === 'failed'
        ? { outcome: 'failed', reason: rootFailureReason(attempt.cause) }
        : attempt;
    },
  };
}

/** A load error wraps what failed; report the first cause with a known class. */
function rootFailureReason(error: unknown): ChatFormat4Reason {
  let current = error;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    const reason = chatFormat4FailureReason(current);
    if (reason !== 'other') return reason;
    current =
      typeof current === 'object' && current !== null
        ? Reflect.get(current, 'cause')
        : undefined;
  }
  return 'other';
}

/**
 * Compiled off (CAN-7178 PR 1): the sweep ships dormant, with no user effect.
 * PR 1b turns it on; until then no scope is ever admitted, whatever the
 * format 4 switch says.
 */
export const CHAT_FORMAT4_SWEEP_COMPILED_ON = false;

/**
 * Starts the app's sweep for the repository the chat state service built,
 * when it is compiled on. The repository's drain ends it: a draining
 * repository admits nothing.
 */
export function startChatFormat4Sweep(
  repository: Pick<ChatStateV2Repository, 'sweepFormat4'>,
  promotionAllowed: () => boolean,
  compiledOn: boolean = CHAT_FORMAT4_SWEEP_COMPILED_ON,
): ChatFormat4Sweep | undefined {
  if (!compiledOn) return undefined;
  let power:
    | Pick<Electron.PowerMonitor, 'getSystemIdleTime' | 'isOnBatteryPower'>
    | undefined;
  void import('electron').then(
    ({ powerMonitor }) => {
      power = powerMonitor;
    },
    () => undefined,
  );
  const sweep = new ChatFormat4Sweep({
    dataDir: getDataDir(),
    target: repositoryChatFormat4SweepTarget(repository, promotionAllowed),
    resolveStore: resolveChatFormat4SweepStore,
    report: recordChatFormat4Outcome,
    conditions: {
      turnInFlight: async (): Promise<boolean> => {
        // Lazy: the session manager imports the chat state singleton.
        const { hasActiveChatTurns } =
          await import('../agents/session-manager');
        return hasActiveChatTurns();
      },
      // Unknown until Electron's power monitor loads: treated as busy.
      idleMs: (): number => (power ? power.getSystemIdleTime() * 1000 : 0),
      onBattery: (): boolean => power?.isOnBatteryPower() ?? false,
      freeBytes: chatFormat4FreeBytes,
    },
  });
  sweep.start();
  return sweep;
}
