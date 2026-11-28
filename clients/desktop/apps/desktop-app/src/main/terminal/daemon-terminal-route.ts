import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { CanopyClientStreamFrame } from '@canopy/core-client';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import { readFilesystemScope } from '@canopy/core-runtime/node';
import {
  CORE_CLIENT_WINDOW_GRANTS,
  WORKER_TERMINAL_GRANTS,
  type CanopyCallerDescriptor,
  type CanopyWorkspaceScope,
  type WorkerTerminalAttachItem,
  type WorkerTerminalListResult,
  type WorkerTerminalRestoreParams,
} from '@canopy/protocol/canopy-core';
import { isSafePortableRelativePath } from '@canopy/protocol/safe-relative-path';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import type { TerminalKind, TerminalSession } from '@canopy/protocol/terminal';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  resolveWorktreeCwd,
  resolveWorktreeTargetIds,
} from '../lib/resolve-worktree';
import {
  daemonUnreachableReason,
  type ElectronDaemonSession,
} from '../canopy-runtime/electron-daemon-connection';
import {
  getElectronDaemonConnections,
  getElectronDaemonFilesContext,
  verifiedDaemonEndpoint,
} from '../canopy-runtime/electron-daemon-access';
import type { ElectronDaemonClient } from '../canopy-runtime/electron-daemon-host';
import { getDaemonScopeResolver } from '../canopy-runtime/daemon-scope-resolver';
import { getElectronDaemonHealth } from '../canopy-runtime/electron-daemon-health';
import { recordDaemonRoute } from '../canopy-runtime/daemon-route-telemetry';
import {
  RemoteTerminals,
  type RemoteTerminalFrame,
  type RemoteTerminalRecordAttribution,
  type RemoteTerminalRecreate,
  type RemoteTerminalTransport,
} from '@canopy/core-runtime/node/terminal';
import { terminalPersistenceStore } from './persistence';
import { TerminalRecordAdmissionDeferred } from './record-admission';
import {
  keepsTerminalRecords,
  noteTerminalRecordSession,
} from './record-client';
import { createTerminalWindowAdmission } from './window-admission';
import { createDesktopTerminalHost, workerTerminal } from './worker-terminal';

/**
 * Routing of renderer terminals to the daemon's terminal host (CAN-5088),
 * used by eligible local main and App Advisor windows. Only the renderer
 * terminal IPC handlers pass a route context, so Portal, script, Claude and
 * every other caller keep the in-process engine. The placement is decided
 * once, before any daemon contact, without a Labs or feature-flag gate.
 * Terminals already placed keep running where they are.
 */

/** Which hosts may place terminals in the daemon. Windows since CAN-5091. */
export const DAEMON_TERMINAL_PLATFORMS: Readonly<
  Record<PlatformOperatingSystem, boolean>
> = { darwin: true, linux: true, win32: true };

/** Set only by the renderer terminal IPC handlers, from the trusted event. */
export interface DaemonTerminalRouteContext {
  /**
   * The sender is one of this app's own windows, not the remote-control
   * bridge a paired controller drives.
   */
  readonly localWindow: boolean;
}

/** The parts of a renderer terminal request that decide its placement. */
export interface DaemonTerminalRouteRequest {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly selectedRepoId?: string;
  readonly managedCommand?: unknown;
  readonly relativeCwd?: string;
}

export interface DaemonTerminalRouteInput {
  readonly platform: PlatformOperatingSystem | null;
  readonly context: DaemonTerminalRouteContext | undefined;
  readonly request: DaemonTerminalRouteRequest;
  /** Main's record says the daemon cannot be reached right now. */
  readonly daemonLatched: boolean;
  readonly daemonTerminals: number;
}

/**
 * The daemon's terminal host serves at most 48 terminals; main keeps one
 * attachment to each, leaving the rest of the binding's streams to others.
 */
export const DAEMON_TERMINAL_LIMIT = 48;

/**
 * Whether a renderer terminal may be placed in the daemon, as code. `false`
 * keeps the in-process engine. Shared-container terminals keep their run
 * consent lifecycle in process, and managed or relative-directory terminals
 * are script actions (CAN-5087).
 */
export function isDaemonTerminalRouteEligible(
  input: DaemonTerminalRouteInput,
): boolean {
  return daemonTerminalRouteExclusion(input) === null;
}

/** Why a renderer terminal stays in process, or `null` when it may go to the daemon. */
export function daemonTerminalRouteExclusion(
  input: DaemonTerminalRouteInput,
):
  | 'platform'
  | 'caller'
  | 'shared_container'
  | 'managed'
  | 'relative_cwd'
  | 'latched'
  | 'capacity'
  | null {
  const { platform, context, request } = input;
  if (platform === null || !DAEMON_TERMINAL_PLATFORMS[platform])
    return 'platform';
  if (context?.localWindow !== true) return 'caller';
  if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID)
    return 'shared_container';
  if (request.managedCommand !== undefined) return 'managed';
  if (request.relativeCwd !== undefined && request.relativeCwd !== '')
    return 'relative_cwd';
  if (input.daemonLatched) return 'latched';
  if (input.daemonTerminals >= DAEMON_TERMINAL_LIMIT) return 'capacity';
  return null;
}

/** Where a selected terminal starts, in the daemon's terms. */
export interface DaemonTerminalTarget {
  readonly scope: CanopyWorkspaceScope;
  readonly cwdRootId: string;
  /** The worktree directory both sides resolve the root to. */
  readonly rootPath: string;
}

function hostPlatform(): PlatformOperatingSystem | null {
  try {
    return hostPlatformOperatingSystem();
  } catch {
    return null;
  }
}

async function canonical(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * The catalog root the daemon resolves to the directory the in-process
 * engine would start in, read from the same tracking records the daemon
 * reads. `null` when none matches: the terminal stays in process.
 */
async function resolveTarget(
  request: DaemonTerminalRouteRequest,
): Promise<DaemonTerminalTarget | null> {
  const ids = resolveWorktreeTargetIds(request.projectId, request.worktreeId);
  if (!ids) return null;
  const rootPath = resolveWorktreeCwd(
    request.projectId,
    request.worktreeId,
    request.selectedRepoId,
  );
  const wanted = await canonical(rootPath);
  if (wanted === null) return null;
  const scope = { workspaceId: ids.projectId, worktreeId: ids.worktreeId };
  try {
    const catalog = await readFilesystemScope(
      scope,
      await (
        await getDaemonScopeResolver()
      )(scope, 'roots'),
      'roots',
    );
    for (const root of catalog.roots) {
      if (root.kind === 'attachments') continue;
      if ((await canonical(root.absolutePath)) === wanted)
        return { scope, cwdRootId: root.id, rootPath };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The daemon placement for a renderer terminal, or `null` to keep it in
 * process. Reads only local state; the daemon is contacted afterwards.
 */
export async function selectDaemonTerminalTarget(
  request: DaemonTerminalRouteRequest,
  context: DaemonTerminalRouteContext | undefined,
): Promise<DaemonTerminalTarget | null> {
  const health = getElectronDaemonHealth();
  const exclusion = daemonTerminalRouteExclusion({
    platform: hostPlatform(),
    context,
    request,
    daemonLatched: health.isLatched(),
    daemonTerminals: workerTerminal.daemonTerminals?.count() ?? 0,
  });
  if (exclusion !== null) {
    recordDaemonRoute('terminals', exclusion);
    return null;
  }
  const target = await resolveTarget(request);
  if (!target) recordDaemonRoute('terminals', 'root');
  return target;
}

/** The managed kinds main places in the daemon terminal host (CAN-5097). */
export const DAEMON_MANAGED_TERMINAL_KINDS: ReadonlySet<TerminalKind> =
  new Set<TerminalKind>(['claude-code', 'claude-worker']);

export interface DaemonManagedTerminalRouteRequest {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly selectedRepoId?: string;
  readonly relativeCwd?: string;
  /** The directory the managed command starts in, as its trusted caller resolved it. */
  readonly cwd: string;
  readonly managedKind: TerminalKind;
  /** The launch came from the Remote Control bridge. */
  readonly fromRemoteBridge: boolean;
}

export interface DaemonManagedTerminalRouteInput {
  readonly platform: PlatformOperatingSystem | null;
  readonly request: DaemonManagedTerminalRouteRequest;
  readonly daemonLatched: boolean;
  readonly daemonTerminals: number;
}

/** Whether a managed Claude terminal may be placed in the daemon, as code (CAN-5097 D4). */
export function isDaemonManagedTerminalRouteEligible(
  input: DaemonManagedTerminalRouteInput,
): boolean {
  return daemonManagedTerminalRouteExclusion(input) === null;
}

/** Why a managed Claude terminal stays in process, or `null` when it may go to the daemon. */
export function daemonManagedTerminalRouteExclusion(
  input: DaemonManagedTerminalRouteInput,
):
  | 'platform'
  | 'managed_kind'
  | 'remote_bridge'
  | 'shared_container'
  | 'relative_cwd'
  | 'latched'
  | 'capacity'
  | null {
  const { platform, request } = input;
  if (platform === null || !DAEMON_TERMINAL_PLATFORMS[platform])
    return 'platform';
  if (!DAEMON_MANAGED_TERMINAL_KINDS.has(request.managedKind))
    return 'managed_kind';
  if (request.fromRemoteBridge) return 'remote_bridge';
  if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID)
    return 'shared_container';
  if (request.relativeCwd !== undefined && request.relativeCwd !== '')
    return 'relative_cwd';
  if (input.daemonLatched) return 'latched';
  if (input.daemonTerminals >= DAEMON_TERMINAL_LIMIT) return 'capacity';
  return null;
}

/** The daemon placement for a managed Claude terminal, or `null` to keep it in process. */
export async function selectDaemonManagedTerminalTarget(
  request: DaemonManagedTerminalRouteRequest,
): Promise<DaemonTerminalTarget | null> {
  const health = getElectronDaemonHealth();
  const exclusion = daemonManagedTerminalRouteExclusion({
    platform: hostPlatform(),
    request,
    daemonLatched: health.isLatched(),
    daemonTerminals: workerTerminal.daemonTerminals?.count() ?? 0,
  });
  if (exclusion !== null) {
    recordDaemonRoute('terminals', exclusion);
    return null;
  }
  const target = await resolveTarget({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    selectedRepoId: request.selectedRepoId,
  });
  if (!target) {
    recordDaemonRoute('terminals', 'root');
    return null;
  }
  const cwd = await canonical(request.cwd);
  if (cwd !== null && cwd === (await canonical(target.rootPath))) return target;
  recordDaemonRoute('terminals', 'cwd');
  return null;
}

/** A selected terminal started in the daemon (CAN-5093 field evidence). */
export function noteDaemonTerminalServed(): void {
  recordDaemonRoute('terminals', 'served');
}

const SWEEP_TIMEOUT_MS = 5_000;
const SWEEP_WARNING =
  'Could not sweep daemon Claude terminals; launching anyway.';
let sweep: Promise<void> | undefined;

async function sweepOnce(): Promise<void> {
  const session = await client();
  let cursor: string | null = null;
  do {
    const page: WorkerTerminalListResult = await session.query(
      'worker.terminal.list',
      {
        states: ['running'],
        pageSize: 500,
        ...(cursor ? { cursor } : {}),
      },
    );
    for (const item of page.items) {
      if (
        item.kind !== 'managed' ||
        workerTerminal.daemonTerminals?.has(item.terminalId)
      )
        continue;
      try {
        await session.instruction('worker.terminal.kill', {
          scope: item.scope,
          terminalId: item.terminalId,
        });
      } catch (error) {
        if (errorCode(error) !== 'worker.terminal.notFound') throw error;
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
}

/**
 * Kills managed daemon terminals this main process does not mirror: Claude
 * CLIs left by a main process that ended without quitting (CAN-5097 D9).
 * Runs once per process; never rejects.
 */
export function sweepOrphanedDaemonManagedTerminals(): Promise<void> {
  if (sweep) return sweep;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolveTimeout) => {
    timer = setTimeout(() => {
      logMainProcessWarn(SWEEP_WARNING, { reason: 'timeout' });
      resolveTimeout();
    }, SWEEP_TIMEOUT_MS);
  });
  const work = sweepOnce().catch((error: unknown) => {
    logMainProcessWarn(SWEEP_WARNING, {
      reason: error instanceof Error ? error.name : 'error',
    });
  });
  sweep = Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  return sweep;
}

/** Test seam: forget that the sweep ran. */
export function resetDaemonManagedTerminalSweepForTests(): void {
  sweep = undefined;
}

/**
 * A restored terminal's directory, as the engine picks it: its persisted
 * directory while that still exists inside the root, otherwise the root.
 */
export function daemonRestoreDirectory(
  root: string,
  persisted: string,
): { readonly cwdRelativePath: string; readonly cwd: string } {
  const path = isAbsolute(persisted)
    ? relative(root, persisted).split(sep).join('/')
    : '';
  return isSafePortableRelativePath(path) && existsSync(persisted)
    ? { cwdRelativePath: path, cwd: persisted }
    : { cwdRelativePath: '', cwd: root };
}

/**
 * Whether a daemon call failed because the daemon could not be reached, so
 * the terminal opens in process instead (shown as the background service
 * warning), or because a reached daemon could not start its terminal host
 * (an install without the host entry beside it). Any other refusal from a
 * reached daemon is not.
 */
export function noteDaemonTerminalFallback(error: unknown): boolean {
  // Custody was deferred before create/recreate dispatch, not a daemon failure.
  if (error instanceof TerminalRecordAdmissionDeferred) return true;
  const reason = daemonUnreachableReason(error);
  if (reason !== null) {
    getElectronDaemonHealth().noteFallback('terminals', reason);
    recordDaemonRoute('terminals', 'unreachable');
    return true;
  }
  // Only the worker's definitive refusal: an `unavailable` the client may
  // retry with its key has an unknown outcome, and the daemon may already
  // hold that terminal.
  const { kind, retry } = errorPayload(error);
  if (kind !== 'unavailable' || retry !== 'never') {
    // A reached daemon refused it; the caller propagates the refusal.
    recordDaemonRoute('terminals', 'refused');
    return false;
  }
  // The daemon itself is reachable, so its health and Files reads stay as
  // they are; only this terminal opens in process.
  logMainProcessWarn('Daemon terminal host unavailable; opening in process.');
  recordDaemonRoute('terminals', 'host_unavailable');
  return true;
}

function errorCode(error: unknown): unknown {
  const payload: unknown =
    typeof error === 'object' && error !== null
      ? Reflect.get(error, 'payload')
      : undefined;
  return typeof payload === 'object' && payload !== null
    ? Reflect.get(payload, 'code')
    : undefined;
}

function errorPayload(error: unknown): { kind: unknown; retry: unknown } {
  const field = (value: unknown, name: string): unknown =>
    typeof value === 'object' && value !== null
      ? Reflect.get(value, name)
      : undefined;
  const payload = field(error, 'payload');
  return {
    kind: field(payload, 'kind'),
    retry: field(field(payload, 'retry'), 'kind'),
  };
}

const owner = new AbortController();

/** Main's terminal session with the daemon, for the record client (CAN-7051). */
export function daemonTerminalSession(): Promise<ElectronDaemonClient> {
  return client();
}

/**
 * Main's own terminal session with the daemon, for every daemon terminal,
 * under the verified local authority the daemon serves. Windows are admitted
 * on its lease (CAN-8068).
 */
async function session(): Promise<ElectronDaemonSession<ElectronDaemonClient>> {
  getElectronDaemonHealth().setConsumerEnabled('terminals', true);
  const { authorityId } = await getElectronDaemonFilesContext();
  const caller: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'electron-main:terminals',
    authorityId,
    interfaceKind: 'desktop',
    grants: [
      WORKER_TERMINAL_GRANTS.read,
      WORKER_TERMINAL_GRANTS.write,
      CORE_CLIENT_WINDOW_GRANTS.issue,
    ],
  };
  const opened = await getElectronDaemonConnections().get(caller, owner.signal);
  noteTerminalRecordSession(opened.client);
  return opened;
}

async function client(): Promise<ElectronDaemonClient> {
  return (await session()).client;
}

/** Main's admission of its own windows to the daemon terminals it mirrors. */
export const terminalWindowAdmission = createTerminalWindowAdmission({
  session,
  latched: () => getElectronDaemonHealth().isLatched(),
  endpointOf: verifiedDaemonEndpoint,
  terminal: (terminalId) => {
    const daemon = workerTerminal.daemonTerminals;
    const terminal = daemon?.get(terminalId);
    const scope = daemon?.scopeOf(terminalId);
    return terminal && scope ? { scope, session: terminal } : null;
  },
  createId: randomUUID,
  log: (message, details): void => logMainProcessWarn(message, details),
});

/**
 * The history source a restore chose on one negotiated session (CAN-7279):
 * that session's record, or else main's legacy snapshot.
 */
export interface DaemonRestoreSession {
  readonly signal: AbortSignal | null;
  readonly records: boolean;
}

/** Never throws: an unreachable or latched daemon chooses the snapshot. */
export async function negotiateDaemonRestore(): Promise<DaemonRestoreSession> {
  // A latched daemon is not contacted: the restore would respawn it.
  if (getElectronDaemonHealth().isLatched())
    return { signal: null, records: false };
  try {
    const session = await client();
    return { signal: session.signal, records: keepsTerminalRecords(session) };
  } catch {
    return { signal: null, records: false };
  }
}

const restoreSessions = new Map<string, DaemonRestoreSession>();

/**
 * Recreates a persisted shell on the history source its caller prepared. A
 * session change that would serve the other source, or a record not drained
 * on the dispatching session, defers it before dispatch.
 */
export async function recreateDaemonTerminal(
  bound: DaemonRestoreSession,
  request: RemoteTerminalRecreate,
): Promise<TerminalSession> {
  // A concurrent caller joins the first one's restore, and so its binding.
  const own = !restoreSessions.has(request.terminalId);
  if (own) restoreSessions.set(request.terminalId, bound);
  try {
    return await getDaemonTerminals().recreate(request);
  } finally {
    if (own) restoreSessions.delete(request.terminalId);
  }
}

function admitRestore(
  params: WorkerTerminalRestoreParams,
  session: ElectronDaemonClient,
): void {
  const bound = restoreSessions.get(params.terminalId);
  if (!bound || params.restoreMode !== 'recreate_if_exited') return;
  const record = params.historyFrom === 'record';
  // The snapshot is main's own state, valid on any session.
  if (
    record !== bound.records ||
    (record && (session.signal !== bound.signal || session.signal.aborted))
  )
    throw new TerminalRecordAdmissionDeferred();
}

function frameOf(
  frame: CanopyClientStreamFrame<WorkerTerminalAttachItem, unknown>,
): RemoteTerminalFrame {
  return frame.kind === 'item'
    ? { kind: 'item', item: frame.item }
    : { kind: 'end', outcome: frame.outcome, error: frame.error };
}

const transport: RemoteTerminalTransport = {
  create: async (params) => {
    const session = await client();
    // Attribution awaited on an earlier session; a legacy successor rejects
    // the record fields, so the create opens in process instead.
    if (params.revision !== undefined && !keepsTerminalRecords(session))
      throw new TerminalRecordAdmissionDeferred();
    return session.instruction('worker.terminal.create', params);
  },
  restore: async (params) => {
    const session = await client();
    admitRestore(params, session);
    // A grant would otherwise survive a recreate under the same id (CAN-8039).
    // A live reattach keeps the process, so every window keeps its grant.
    if (params.restoreMode === 'recreate_if_exited')
      terminalWindowAdmission.revokeTerminal(params.terminalId);
    return session.instruction('worker.terminal.restore', params);
  },
  write: async (params) =>
    (await client()).instruction('worker.terminal.write', params),
  resize: async (params) =>
    (await client()).instruction('worker.terminal.resize', params),
  kill: async (params) => {
    terminalWindowAdmission.revokeTerminal(params.terminalId);
    return (await client()).instruction('worker.terminal.kill', params);
  },
  release: async (params) => {
    terminalWindowAdmission.revokeTerminal(params.terminalId);
    return (await client()).instruction('worker.terminal.release', params);
  },
  attach: async (params, onFrame) => {
    const session = await client();
    const handle = await session.openStream('worker.terminal.attach', params);
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      onFrame({ kind: 'end', outcome: 'error', error: null });
    };
    // A dropped connection ends the stream without an end frame.
    session.signal.addEventListener('abort', end, { once: true });
    const unsubscribe = handle.onFrame((frame) => {
      if (ended) return;
      if (frame.kind === 'end') {
        ended = true;
        session.signal.removeEventListener('abort', end);
      }
      onFrame(frameOf(frame));
    });
    return {
      close: () => {
        ended = true;
        session.signal.removeEventListener('abort', end);
        unsubscribe();
        handle.close();
      },
    };
  },
};

/** Daemon terminals, composed into the routed port on first placement. */
export function getDaemonTerminals(): RemoteTerminals {
  const existing = workerTerminal.daemonTerminals;
  if (existing) return existing;
  const host = createDesktopTerminalHost();
  const daemon = new RemoteTerminals({
    transport,
    persistence: terminalPersistenceStore,
    // A daemon that keeps the worktree record gets each terminal's
    // attribution, and main records none of its output (CAN-7051, q-28 (4)).
    recordAttribution: async ({
      projectId,
      worktreeId,
    }): Promise<RemoteTerminalRecordAttribution | null> => {
      try {
        if (!keepsTerminalRecords(await client())) return null;
      } catch {
        return null;
      }
      return {
        client: await terminalPersistenceStore.recordClientFor(
          projectId,
          worktreeId,
        ),
        persistence: terminalPersistenceStore.recordedTerminals,
      };
    },
    resources: host.resources,
    emit: (event): void => {
      // Includes main's own lost verdict; a window stream ending is never one.
      if (event.type === 'exit')
        terminalWindowAdmission.revokeTerminal(event.payload.terminalId);
      workerTerminal.emit(event);
    },
    log: (message, details): void => logMainProcessWarn(message, details),
    createIdempotencyKey: randomUUID,
  });
  workerTerminal.useDaemonTerminals(daemon);
  return daemon;
}
