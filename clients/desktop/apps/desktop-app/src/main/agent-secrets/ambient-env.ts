import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApprovalMode } from '@canopy/desktop-shared/types';
import { EXECUTION_SECRET_BINDINGS_MAX } from '@canopy/protocol/canopy-core/worker';
import { getDesktopExecutionSecrets } from '../execution-secrets/owner';
import { writeFileAtomically } from '../lib/atomic-file';
import { isMissingFileError } from '../lib/fs-utils';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getAgentSecretAmbientEnvDir } from '../lib/paths';
import {
  chatSecretBindings,
  getChatSecretStore,
  type ChatSecretScope,
  type ChatSecretSummary,
} from './chat-secret-store';
import { isAgentSecretRequestsEnabled } from './feature-gate';

/*
 * Full-access ambient env (PLAN.md §7, CONTRACTS.md §5, unit U3): in Full
 * access, the secrets a chat holds are also environment variables for the
 * shell commands its agent runs itself, without RunWithSecrets.
 *
 * - Claude reads `CLAUDE_ENV_FILE` once per session and caches its text, then
 *   runs it before every Bash command. So a launch in Full access points it at
 *   a stub that holds no value and only sources an owner-only (0600) values
 *   file beside it. That file is rewritten whenever the chat's secrets change
 *   and deleted when the chat leaves Full access, so a revoked secret or a
 *   mode change takes effect from the next command. Values never go in
 *   Claude's own process environment: they couldn't be withdrawn from it, and
 *   its hooks and MCP servers would inherit them.
 * - Codex fixes a command's environment when its app-server process starts,
 *   so a Full-access launch puts the held values in that process's spawn
 *   environment. A secret given or replaced afterwards needs a restart
 *   (`restart`, the chat's **Restart to apply**); one revoked, or leaving Full
 *   access, restarts the session automatically once it is idle.
 * - Cursor, OpenCode and Copilot have no live environment: tools only.
 *
 * Values come only through single-use execution-secret grants, as the tools'
 * do. Directories and files live under app data, never in a checkout.
 */

/**
 * Names never set ambiently: they steer the shell, the loader or the agent's
 * own runtime, so setting them could break every command or hijack the
 * provider. RunWithSecrets can still pass them to one command.
 */
const RESERVED_AMBIENT_NAMES = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'PWD',
  'OLDPWD',
  'IFS',
  'ENV',
  'BASH_ENV',
  'PS4',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOMESHARE',
  'CLAUDE_ENV_FILE',
]);
/** Prefixes the agents' own runtimes read; never set ambiently. */
const RESERVED_AMBIENT_PREFIXES = [
  'CLAUDE_',
  'ANTHROPIC_',
  'CODEX_',
  'OPENAI_',
  'RUST_',
  'CANOPY_',
];

/**
 * Claude permission rules that keep every chat's file tools (Read, and the
 * Grep and Glob that Read rules cover; Edit, Write and NotebookEdit through
 * Edit) out of the ambient directory. `//` marks an absolute path.
 */
export function ambientSecretDenyRules(): string[] {
  const dir = getAgentSecretAmbientEnvDir().split('\\').join('/');
  const absolute = dir.startsWith('/') ? `/${dir}` : `//${dir}`;
  return [`Read(${absolute}/**)`, `Edit(${absolute}/**)`];
}

/** Whether a held name may become an ambient variable. */
export function isAmbientSecretName(name: string): boolean {
  return (
    !RESERVED_AMBIENT_NAMES.has(name) &&
    !RESERVED_AMBIENT_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * What the chat's own commands get, for the Secrets chip:
 * - `live`: held secrets are in its shell commands' environment now.
 * - `restart`: Codex started before the chat's current secrets; a restart
 *   applies them.
 * - `restart-pending`: a restart was asked for and happens once the chat is
 *   idle, or at its next message.
 * - `off`: the chat is not in Full access (or the feature is off), so its
 *   commands get secrets only through the tools.
 * - `none`: no provider launch to report on, or one without a live
 *   environment (tools only).
 */
export type AmbientSecretEnvStatus =
  | 'live'
  | 'restart'
  | 'restart-pending'
  | 'off'
  | 'none';

function chatKey(scope: ChatSecretScope): string {
  return [scope.projectId, scope.worktreeId, scope.chatId].join('\0');
}

function sameScope(a: ChatSecretScope, b: ChatSecretScope): boolean {
  return chatKey(a) === chatKey(b);
}

/** Single-quotes a string for a POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

/**
 * Reads the held values `names` through single-use grants of at most
 * `EXECUTION_SECRET_BINDINGS_MAX` names each, so a chat holding more still
 * gets every one. The caller checks the store's revision around the whole
 * read.
 */
async function readHeldValues(
  scope: ChatSecretScope,
  names: readonly string[],
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (
    let start = 0;
    start < names.length;
    start += EXECUTION_SECRET_BINDINGS_MAX
  )
    Object.assign(
      values,
      await readHeldValueBatch(
        scope,
        names.slice(start, start + EXECUTION_SECRET_BINDINGS_MAX),
      ),
    );
  return values;
}

/** Reads up to `EXECUTION_SECRET_BINDINGS_MAX` held values in one grant. */
async function readHeldValueBatch(
  scope: ChatSecretScope,
  names: readonly string[],
): Promise<Record<string, string>> {
  if (!names.length) return {};
  const bindings = chatSecretBindings(
    scope,
    Object.fromEntries(names.map((name) => [name, name])),
  );
  const audience = {
    operation: 'agent.secret.ambient',
    key: randomUUID(),
  } as const;
  const grants = getDesktopExecutionSecrets();
  const handle = grants.stage(audience, bindings);
  try {
    const redeemed = await grants.redeem(
      { audience, bindings },
      new AbortController().signal,
    );
    return { ...redeemed.env };
  } finally {
    handle.revoke();
  }
}

/** Tries before a read whose values keep changing gives up (fail closed). */
const AMBIENT_READ_ATTEMPTS = 3;

/** What a launch read: its values, and which held secrets they came from. */
interface AmbientRead {
  readonly values: Record<string, string>;
  /**
   * The eligible secrets the values came from, by name and serial (a value
   * given again is a new serial); null when nothing could be read
   * consistently.
   */
  readonly fingerprint: string | null;
}

/** The held secrets a launch may export, without reserved names. */
async function eligibleSecrets(
  scope: ChatSecretScope,
  options: { persistedOnly?: boolean },
): Promise<ChatSecretSummary[]> {
  return (await getChatSecretStore().describe(scope)).filter(
    (secret) =>
      isAmbientSecretName(secret.name) &&
      (options.persistedOnly !== true || secret.storage === 'encrypted'),
  );
}

function ambientFingerprint(secrets: readonly ChatSecretSummary[]): string {
  return JSON.stringify(secrets.map((secret) => [secret.name, secret.serial]));
}

/**
 * The held names a launch may export, and their values. `persistedOnly`
 * leaves out values kept in memory for this app session (no secure storage):
 * the person was told those never reach the disk, so they can't go in a
 * values file and stay tools-only for that launch.
 *
 * The listing and the grant read are two store steps. Every change to a
 * chat's values bumps its revision in the same queued step, and the read
 * runs on that queue after any change listed before it, so an unchanged
 * revision means the values read are the ones listed: a value replaced in
 * between (by one kept in memory only, say) is read again, never written.
 */
async function ambientValues(
  scope: ChatSecretScope,
  options: { persistedOnly?: boolean } = {},
): Promise<AmbientRead> {
  const store = getChatSecretStore();
  for (let attempt = 0; attempt < AMBIENT_READ_ATTEMPTS; attempt += 1) {
    const revision = store.valuesRevision(scope);
    const secrets = await eligibleSecrets(scope, options);
    const values = await readHeldValues(
      scope,
      secrets.map((secret) => secret.name),
    );
    if (store.valuesRevision(scope) !== revision) continue;
    return {
      // A shell variable can't hold a NUL; such a value stays tools-only.
      values: Object.fromEntries(
        Object.entries(values).filter(([, value]) => !value.includes('\0')),
      ),
      fingerprint: ambientFingerprint(secrets),
    };
  }
  return { values: {}, fingerprint: null };
}

function wanted(getApprovalMode: () => ApprovalMode): boolean {
  return getApprovalMode() === 'full-access' && isAgentSecretRequestsEnabled();
}

// Claude --------------------------------------------------------------------

interface ClaudeLaunch {
  readonly harness: 'claude';
  readonly scope: ChatSecretScope;
  readonly getApprovalMode: () => ApprovalMode;
  /** Whether the values file holds values now. */
  live: boolean;
  refresh: () => Promise<void>;
  /** Resolves once every queued rewrite of the values file has finished. */
  settled: () => Promise<void>;
  /** Whether no command can source `name` from the values file now. */
  withdrawn: (name: string) => Promise<boolean>;
  /** Deletes the values file now, ahead of any queued rewrite. */
  withdrawNow: () => Promise<void>;
}

interface CodexLaunch {
  readonly harness: 'codex';
  readonly scope: ChatSecretScope;
  readonly getApprovalMode: () => ApprovalMode;
  /**
   * Which held secrets its process started with (`AmbientRead.fingerprint`);
   * null when it got none.
   */
  readonly appliedFingerprint: string | null;
  /** The names its process environment holds. */
  readonly appliedNames: readonly string[];
  /**
   * Respawns the app-server once idle, keeping the thread. False when no
   * process is running yet to restart.
   */
  readonly restart: () => boolean;
  restartRequested: boolean;
}

type Launch = ClaudeLaunch | CodexLaunch;

/** The live launch per chat. A newer launch for a chat replaces the older. */
const launches = new Map<string, Launch>();
/** Launch directories a live Claude launch owns; the startup sweep keeps them. */
const ownedDirectories = new Set<string>();
const statusListeners = new Set<(scope: ChatSecretScope) => void>();

function notifyStatus(scope: ChatSecretScope): void {
  for (const listener of [...statusListeners]) {
    try {
      listener(scope);
    } catch {
      logMainProcessWarn('[agent-secrets] An ambient status listener failed');
    }
  }
}

/** Calls `listener` whenever a chat's ambient status may have changed. */
export function subscribeAmbientSecretEnvStatus(
  listener: (scope: ChatSecretScope) => void,
): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

export interface ClaudeAmbientSecretEnv {
  /** Launch environment additions: the stub path, never a value. */
  readonly env: Readonly<Record<string, string>>;
  /** The values file's path (tests and diagnostics; holds values). */
  readonly valuesPath: string;
  /** Rewrites or deletes the values file for the chat's mode and secrets. */
  refresh(): Promise<void>;
  /** Deletes the launch directory. Idempotent; never throws. */
  dispose(): Promise<void>;
}

/**
 * Opens a Claude launch's ambient env: `null` unless the launch is in Full
 * access with the feature on, and never on Windows, where Claude's shell
 * can't source the POSIX stub (tools only there). `inheritedEnvFile` is a
 * `CLAUDE_ENV_FILE` the launch environment already named; the stub sources it
 * first, so it keeps working.
 */
export async function openClaudeAmbientSecretEnv(input: {
  scope: ChatSecretScope;
  getApprovalMode: () => ApprovalMode;
  inheritedEnvFile?: string;
  platform?: NodeJS.Platform;
}): Promise<ClaudeAmbientSecretEnv | null> {
  if ((input.platform ?? hostPlatformOperatingSystem()) === 'win32')
    return null;
  if (!wanted(input.getApprovalMode)) return null;
  const scope: ChatSecretScope = {
    projectId: input.scope.projectId,
    worktreeId: input.scope.worktreeId,
    chatId: input.scope.chatId,
  };
  const base = getAgentSecretAmbientEnvDir();
  const dir = join(base, randomUUID());
  const stubPath = join(dir, 'claude-env.sh');
  const valuesPath = join(dir, 'values.sh');
  try {
    await mkdir(base, { recursive: true, mode: 0o700 });
    await mkdir(dir, { mode: 0o700 });
    ownedDirectories.add(dir);
    const inherited =
      input.inheritedEnvFile && input.inheritedEnvFile !== stubPath
        ? `if [ -r ${shellQuote(input.inheritedEnvFile)} ]; then . ${shellQuote(input.inheritedEnvFile)}; fi\n`
        : '';
    // Holds no value: Claude caches this text for the session, so the values
    // live in the file it sources, which changes as the chat's secrets do.
    await writeFileAtomically(
      stubPath,
      `# This chat's Full-access secrets, for its own commands. No values here.\n${inherited}if [ -r ${shellQuote(valuesPath)} ]; then . ${shellQuote(valuesPath)}; fi\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch {
    ownedDirectories.delete(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    logMainProcessWarn(
      "[agent-secrets] Couldn't prepare a chat's ambient secrets",
    );
    return null;
  }

  const launch: ClaudeLaunch = {
    harness: 'claude',
    scope,
    getApprovalMode: input.getApprovalMode,
    live: false,
    refresh: () => Promise.resolve(),
    settled: () => Promise.resolve(),
    withdrawn: () => Promise.resolve(true),
    withdrawNow: () => Promise.resolve(),
  };
  launches.set(chatKey(scope), launch);
  let disposed = false;
  let queue: Promise<void> = Promise.resolve();

  const write = async (): Promise<void> => {
    if (disposed) return;
    // Fence first: while the chat's values are re-read, its commands get
    // none, so a revoked or expired value is never sourced in between.
    await rm(valuesPath, { force: true }).catch(() => undefined);
    let values: Record<string, string> = {};
    if (wanted(launch.getApprovalMode)) {
      try {
        ({ values } = await ambientValues(scope, { persistedOnly: true }));
      } catch {
        // Fail closed: a value that can't be read leaves no file behind.
        values = {};
        logMainProcessWarn(
          "[agent-secrets] Couldn't read a chat's secrets for its commands",
        );
      }
    }
    if (disposed) return;
    // The chat may have left Full access while the values were read.
    if (!wanted(launch.getApprovalMode)) values = {};
    const entries = Object.entries(values).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    try {
      if (!entries.length) {
        await rm(valuesPath, { force: true });
      } else {
        await writeFileAtomically(
          valuesPath,
          `${entries.map(([name, value]) => `export ${name}=${shellQuote(value)}`).join('\n')}\n`,
          { encoding: 'utf8', mode: 0o600 },
        );
      }
    } catch {
      // A file that can't be rewritten mustn't keep stale values.
      await rm(valuesPath, { force: true }).catch(() => undefined);
      entries.length = 0;
      logMainProcessWarn(
        "[agent-secrets] Couldn't write a chat's secrets for its commands",
      );
    }
    if (disposed) {
      await rm(valuesPath, { force: true }).catch(() => undefined);
      return;
    }
    // Or while the file was written: leaving Full access withdraws the file
    // at once (withdrawNow), so a write already in flight takes it back.
    if (entries.length && !wanted(launch.getApprovalMode)) {
      await rm(valuesPath, { force: true }).catch(() => undefined);
      entries.length = 0;
    }
    const live = entries.length > 0;
    if (live !== launch.live || live) {
      launch.live = live;
      notifyStatus(scope);
    }
  };

  const refresh = (): Promise<void> => {
    const next = queue.then(write, write);
    queue = next.catch(() => undefined);
    return next;
  };

  launch.refresh = refresh;
  launch.settled = (): Promise<void> => queue;
  launch.withdrawNow = async (): Promise<void> => {
    await rm(valuesPath, { force: true }).catch(() => undefined);
    if (launch.live) {
      launch.live = false;
      notifyStatus(scope);
    }
  };
  launch.withdrawn = async (name: string): Promise<boolean> => {
    const exports = async (): Promise<boolean | null> => {
      try {
        const text = await readFile(valuesPath, 'utf8');
        return text
          .split('\n')
          .some((line) => line.startsWith(`export ${name}=`));
      } catch (error) {
        return isMissingFileError(error) ? false : null;
      }
    };
    const first = await exports();
    if (first === false) return true;
    await rm(valuesPath, { force: true }).catch(() => undefined);
    return (await exports()) === false;
  };
  const unsubscribe = getChatSecretStore().subscribe((changed, change) => {
    if (change === 'values' && sameScope(changed, scope)) void refresh();
  });

  await refresh();

  return {
    env: { CLAUDE_ENV_FILE: stubPath },
    valuesPath,
    refresh,
    dispose: async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      if (launches.get(chatKey(scope)) === launch) {
        launches.delete(chatKey(scope));
        notifyStatus(scope);
      }
      await queue.catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => {
        logMainProcessWarn(
          "[agent-secrets] Couldn't delete a chat's ambient secrets",
        );
      });
      ownedDirectories.delete(dir);
    },
  };
}

// Codex ---------------------------------------------------------------------

/** True when the launch's process holds a value the chat no longer may use. */
function codexHoldsWithdrawn(launch: CodexLaunch, held: Set<string>): boolean {
  if (!launch.appliedNames.length) return false;
  if (!wanted(launch.getApprovalMode)) return true;
  return launch.appliedNames.some((name) => !held.has(name));
}

function requestRestart(launch: CodexLaunch): void {
  if (launch.restartRequested) return;
  let requested = false;
  try {
    requested = launch.restart();
  } catch {
    logMainProcessWarn("[agent-secrets] Couldn't restart a chat's session");
  }
  // A launch whose process isn't installed yet stays unrequested; its
  // `attached` re-check asks again once it is.
  if (!requested) return;
  launch.restartRequested = true;
  notifyStatus(launch.scope);
}

/**
 * Re-checks a Codex launch after its chat's secrets or mode changed: a value
 * revoked, or leaving Full access, restarts it once idle; anything else only
 * updates the chip.
 */
async function recheckCodexLaunch(launch: CodexLaunch): Promise<void> {
  if (launches.get(chatKey(launch.scope)) !== launch) return;
  if (launch.appliedNames.length) {
    let held: Set<string>;
    try {
      held = new Set(await getChatSecretStore().listNames(launch.scope));
    } catch {
      held = new Set();
    }
    if (codexHoldsWithdrawn(launch, held)) {
      requestRestart(launch);
      return;
    }
  }
  notifyStatus(launch.scope);
}

let codexSubscription: (() => void) | null = null;

function ensureCodexSubscription(): void {
  codexSubscription ??= getChatSecretStore().subscribe((scope, change) => {
    if (change !== 'values') return;
    const launch = launches.get(chatKey(scope));
    if (launch?.harness === 'codex') void recheckCodexLaunch(launch);
  });
}

/** Reads of a Codex launch's values before it gives up and spawns without. */
const CODEX_READ_ATTEMPTS = 3;

export interface CodexAmbientSecretEnv {
  /** Spawn environment additions: held values in Full access, else empty. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Call once the process is installed: a revoke or a mode change while it
   * was being built couldn't restart it then, so it is checked again now.
   */
  attached(): void;
  /** Forgets the launch when its session ends. */
  dispose(): void;
}

/**
 * The spawn environment for one Codex app-server process: the chat's held
 * values in Full access with the feature on, otherwise nothing. Records what
 * the process got, so the chip can offer **Restart to apply** when the chat's
 * secrets change. `restart` respawns the process once the chat is idle (its
 * next client opens a new launch). A value that can't be read leaves the
 * launch without any (fail closed).
 */
export async function openCodexAmbientSecretEnv(input: {
  scope: ChatSecretScope;
  getApprovalMode: () => ApprovalMode;
  restart: () => boolean;
}): Promise<CodexAmbientSecretEnv> {
  ensureCodexSubscription();
  const scope: ChatSecretScope = {
    projectId: input.scope.projectId,
    worktreeId: input.scope.worktreeId,
    chatId: input.scope.chatId,
  };
  const store = getChatSecretStore();
  let env: Record<string, string> = {};
  let appliedFingerprint: string | null = null;
  // No launch is registered while the values are read, so a revoke or a
  // mode change then notifies nobody. Read until the mode and the chat's
  // values held still across one read; the launch is registered right after
  // the last check, with no await between, so every later change reaches it.
  // Values that keep changing, or can't be read, leave the process without
  // any (fail closed).
  for (let attempt = 0; attempt < CODEX_READ_ATTEMPTS; attempt += 1) {
    env = {};
    appliedFingerprint = null;
    if (!wanted(input.getApprovalMode)) break;
    const revision = store.valuesRevision(scope);
    let read: AmbientRead;
    try {
      read = await ambientValues(scope);
    } catch {
      logMainProcessWarn(
        "[agent-secrets] Couldn't read a chat's secrets for its commands",
      );
      break;
    }
    if (!wanted(input.getApprovalMode)) break;
    if (store.valuesRevision(scope) === revision) {
      env = read.values;
      appliedFingerprint = read.fingerprint;
      break;
    }
  }
  const launch: CodexLaunch = {
    harness: 'codex',
    scope,
    getApprovalMode: input.getApprovalMode,
    appliedFingerprint,
    appliedNames: Object.keys(env).sort(),
    restart: input.restart,
    restartRequested: false,
  };
  launches.set(chatKey(scope), launch);
  notifyStatus(scope);
  return {
    env,
    attached: (): void => {
      void recheckCodexLaunch(launch);
    },
    dispose: (): void => {
      if (launches.get(chatKey(scope)) !== launch) return;
      launches.delete(chatKey(scope));
      notifyStatus(scope);
    },
  };
}

/**
 * Re-applies a chat's ambient env after its approval mode changed: Claude
 * rewrites or deletes its values file, deleting it before this resolves
 * when the chat left Full access; Codex restarts once idle if its process
 * holds values the chat may no longer use. Never rejects.
 */
export async function ambientSecretModeChanged(
  scope: ChatSecretScope,
): Promise<void> {
  const launch = launches.get(chatKey(scope));
  if (!launch) return;
  if (launch.harness === 'claude') {
    // Leaving Full access takes the values away before the mode change
    // completes, not after a queued rewrite that may still be reading.
    if (!wanted(launch.getApprovalMode)) await launch.withdrawNow();
    void launch.refresh().catch(() => undefined);
    notifyStatus(scope);
  } else void recheckCodexLaunch(launch);
}

/**
 * Resolves once a chat's ambient files reflect its current secrets: a
 * revoke waits on this before it reports success.
 */
export async function settleAmbientSecretEnv(
  scope: ChatSecretScope,
  revokedName?: string,
): Promise<boolean> {
  const launch = launches.get(chatKey(scope));
  if (launch?.harness !== 'claude') return true;
  await launch.settled().catch(() => undefined);
  if (revokedName === undefined) return true;
  // Fail closed: confirm the file no longer exports the name, removing the
  // file once more if it does; a file that stays readable is reported.
  return launch.withdrawn(revokedName);
}

/**
 * The person's **Restart to apply**: restarts the chat's Codex session once
 * idle (or at its next message), keeping the thread, so its commands get the
 * chat's current secrets. Returns false when there is nothing to restart.
 */
export function restartForAmbientSecrets(scope: ChatSecretScope): boolean {
  const launch = launches.get(chatKey(scope));
  if (launch?.harness !== 'codex') return false;
  requestRestart(launch);
  return true;
}

/** The chat's ambient status for the Secrets chip. */
export async function ambientSecretEnvStatus(
  scope: ChatSecretScope,
): Promise<AmbientSecretEnvStatus> {
  const launch = launches.get(chatKey(scope));
  if (!launch) return 'none';
  if (launch.harness === 'claude') {
    // Live only while the values file holds values: session-only, reserved
    // or unreadable ones leave nothing in the agent's commands.
    if (!wanted(launch.getApprovalMode)) return 'off';
    return launch.live ? 'live' : 'off';
  }
  if (launch.restartRequested) return 'restart-pending';
  if (!wanted(launch.getApprovalMode)) return 'off';
  // Compared by the secrets it may set, so a reserved name, which is never
  // set, neither counts as live nor asks for a restart.
  const current = ambientFingerprint(await eligibleSecrets(scope, {}));
  if (
    !launch.appliedNames.length &&
    (current === ambientFingerprint([]) ||
      launch.appliedFingerprint === current)
  )
    return 'off';
  return launch.appliedFingerprint === current ? 'live' : 'restart';
}

/**
 * Deletes launch directories no live launch owns: ones a crash or a forced
 * quit left behind. Run at startup; never throws.
 */
export async function sweepStaleAmbientSecretEnv(): Promise<void> {
  const base = getAgentSecretAmbientEnvDir();
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .map((entry) => join(base, entry))
      .filter((dir) => !ownedDirectories.has(dir))
      .map((dir) =>
        rm(dir, { recursive: true, force: true }).catch(() => {
          logMainProcessWarn(
            "[agent-secrets] Couldn't delete stale ambient secrets",
          );
        }),
      ),
  );
}

/** Tests only: forget every launch and the Codex subscription. */
export function resetAmbientSecretEnvForTests(): void {
  if (process.env.NODE_ENV !== 'test')
    throw new Error('Only tests may reset ambient secrets.');
  launches.clear();
  ownedDirectories.clear();
  statusListeners.clear();
  codexSubscription?.();
  codexSubscription = null;
}
