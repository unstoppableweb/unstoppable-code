import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { app, powerMonitor } from 'electron';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import type { LocalMemoryScopeRequest } from '@canopy/desktop-shared/types';
import type { MemoryScopeRef } from '@canopy/protocol/memory-sync';
import {
  MEMORY_SYNC_ACCOUNT_HEADER,
  MEMORY_SYNC_CAPABILITY,
  MEMORY_SYNC_LIMITS,
  MEMORY_SYNC_PROTOCOL_HEADER,
  MEMORY_SYNC_PROTOCOL_VERSION,
  MEMORY_SYNC_REALTIME_EVENT_TYPE,
  MEMORY_SYNC_ROUTES,
  MemoryAccountIdSchema,
} from '@canopy/protocol/memory-sync';
import { resolveCanopyCloudCredentialContext } from '../../canopy-cloud/client';
import {
  peekCanopyCloudAccount,
  readCanopyCloudAccountWithStatus,
  subscribeCanopyCloudAccountChanges,
  type CanopyCloudAccountEntry,
} from '../../lib/canopy-cloud-account-store';
import { readInstallationGeneration } from '../../lib/installation-generation';
import { onWorkspaceMemoryBindingChanged } from '../../lib/workspace-memory-binding-events';
import {
  logMainProcessDebug,
  logMainProcessWarn,
} from '../../lib/main-process-logging';
import { getMemoryReplicasRootDir } from '../../lib/paths';
import { parseSseEvents } from '../../plans/plan-realtime-subscription';
import { readPortalStateStore } from '../../portal/portal-state-store';
import {
  broadcastLocalMemoryChanged,
  retargetLocalMemoryWatches,
} from '../local/change-events';
import { setLocalMemoryReplicaHooks } from '../local/replica-hooks';
import {
  deviceLocalMemoryScopeDir,
  localMemoryScopeDir,
  setLocalMemoryReplicaLocator,
} from '../local/scope-resolver';
import {
  MemorySyncEngine,
  type MemorySyncDevice,
  type MemorySyncEngineStatus,
  type MemorySyncMetric,
  type MemorySyncProblem,
} from './engine';
import { createMemoryReplicaHooks } from './note-hooks';
import type * as ProjectBindings from './project-bindings';
import {
  ProjectMemoryScopeDirectory,
  type ProjectMemoryScopeTarget,
} from './project-scopes';
import {
  MemoryReplicaRegistry,
  createMemoryReplicaLocator,
} from './replica-registry';
import {
  createMemorySyncTransport,
  type MemorySyncHttp,
  type MemorySyncHttpResponse,
} from './transport';

/*
 * The desktop host of the memory sync engine (design §8, D15): the Electron
 * side the engine itself never touches. It runs for the signed-in account
 * while that account carries `memory-sync-v1`, which Canopy Cloud mints
 * behind `canopy-memory-sync-enabled`, and is not a guest (guests never
 * sync, §8.1). It supplies the device identity (the Portal device, the
 * installation generation and a nonce per launch), the bearer key, the
 * `memory.scope` nudge stream and resume-from-sleep pulls, and installs the
 * replica locator and note hooks so the local store reads and writes the
 * account's replicas.
 */

const STREAM_RETRY_INITIAL_MS = 5_000;
const STREAM_RETRY_MAX_MS = 5 * 60_000;

/** The account memory sync runs for: signed in, not a guest, and offered sync. */
export function memorySyncAccountId(
  entry: CanopyCloudAccountEntry | null,
): string | null {
  if (entry === null || isGuestAccount(entry)) return null;
  if (!entry.capabilities.includes(MEMORY_SYNC_CAPABILITY)) return null;
  const parsed = MemoryAccountIdSchema.safeParse(entry.account?.id ?? '');
  return parsed.success ? parsed.data : null;
}

function devicePlatform(): MemorySyncDevice['platform'] {
  return hostOperatingSystem() ?? 'linux';
}

function deviceLabel(): string {
  const label = hostname().trim();
  return (label.length > 0 ? label : 'Desktop').slice(
    0,
    MEMORY_SYNC_LIMITS.deviceLabelMaxChars,
  );
}

const sessionNonce = randomUUID();

async function readDevice(): Promise<MemorySyncDevice> {
  const deviceId = (await readPortalStateStore()).clientDeviceId.toLowerCase();
  return {
    deviceId,
    installationGeneration: await readInstallationGeneration(deviceId),
    sessionNonce,
    label: deviceLabel(),
    platform: devicePlatform(),
    appVersion: app.getVersion(),
  };
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** The body as text, refusing one longer than `maxBytes`. */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('The memory sync response is too large');
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('The memory sync response is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Requests over the signed-in account's bearer key. */
const cloudHttp: MemorySyncHttp = async (request) => {
  const { baseUrl, apiKey } = await resolveCanopyCloudCredentialContext();
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal =
    request.signal === undefined
      ? timeout
      : AbortSignal.any([timeout, request.signal]);
  const response = await fetch(`${baseUrl}${request.path}`, {
    method: request.method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(request.body === undefined
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...request.headers,
    },
    ...(request.body === undefined ? {} : { body: request.body }),
    signal,
  });
  const text = await readCapped(response, request.maxResponseBytes);
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  const answer: MemorySyncHttpResponse = { status: response.status, body };
  const after = retryAfterMs(response);
  return after === undefined ? answer : { ...answer, retryAfterMs: after };
};

/**
 * The `memory.scope` nudge stream (design §9.4): every signal asks the engine
 * to pull. A 404, 401 or 403 ends it quietly; the engine's periodic pull
 * covers that. Never throws.
 */
export function openMemorySyncNudgeStream(
  accountId: string,
  onNudge: () => void,
): { stop: () => void } {
  const controller = new AbortController();
  let lastEventId: string | null = null;
  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        controller.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      timer.unref();
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
  const consume = async (body: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const { events, remainder } = parseSseEvents(buffer);
        buffer = remainder;
        for (const event of events) {
          if (event.id !== null) lastEventId = event.id;
          if (event.event === MEMORY_SYNC_REALTIME_EVENT_TYPE) onNudge();
        }
      }
    } finally {
      reader.releaseLock();
    }
  };
  const run = async (): Promise<void> => {
    let attempt = 0;
    while (!controller.signal.aborted) {
      try {
        const { baseUrl, apiKey } = await resolveCanopyCloudCredentialContext();
        const response = await fetch(
          `${baseUrl}${MEMORY_SYNC_ROUTES.stream()}`,
          {
            headers: {
              Accept: 'text/event-stream',
              Authorization: `Bearer ${apiKey}`,
              [MEMORY_SYNC_PROTOCOL_HEADER]: String(
                MEMORY_SYNC_PROTOCOL_VERSION,
              ),
              [MEMORY_SYNC_ACCOUNT_HEADER]: accountId,
              ...(lastEventId === null ? {} : { 'Last-Event-ID': lastEventId }),
            },
            signal: controller.signal,
          },
        );
        if ([401, 403, 404].includes(response.status)) return;
        if (response.ok && response.body !== null) {
          attempt = 0;
          // A fresh connection may have missed signals: pull once.
          onNudge();
          await consume(response.body);
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      await delay(
        Math.min(STREAM_RETRY_INITIAL_MS * 2 ** attempt, STREAM_RETRY_MAX_MS),
      );
      attempt += 1;
    }
  };
  void run();
  return {
    stop: (): void => {
      controller.abort();
    },
  };
}

/**
 * One content-free log line per measure (design §20): sync delay, merge
 * outcomes, desktop consolidation runs, first enables and replica problems.
 * Desktop sends no diagnostic operations anywhere, so these stay local.
 */
function emitMetric(context: Record<string, string | number>): void {
  logMainProcessDebug('Memory sync metric', context);
}

function recordMetric(metric: MemorySyncMetric): void {
  switch (metric.kind) {
    case 'delay':
      emitMetric({
        metric: 'sync_delay',
        delay_ms: Math.round(metric.delayMs),
      });
      return;
    case 'merge':
      emitMetric({
        metric: 'merge',
        outcome: metric.outcome,
        count: metric.count,
      });
      return;
    case 'consolidation':
      emitMetric({
        metric: 'consolidation_run',
        holder: 'desktop',
        status: metric.status,
        duration_ms: Math.round(metric.durationMs),
      });
      return;
    case 'first_enable':
      emitMetric({
        metric: 'first_enable',
        mode: metric.mode,
        outcome: metric.outcome,
      });
      return;
  }
}

function recordProblem(problem: MemorySyncProblem): void {
  logMainProcessWarn('Memory sync problem', {
    kind: problem.kind,
    code: problem.code,
  });
  emitMetric({ metric: 'replica_problem', kind: problem.kind });
}

const USER_SCOPE: LocalMemoryScopeRequest = { scope: 'user' };

function workspaceScope(workspaceId: string): LocalMemoryScopeRequest {
  return { scope: 'workspace', workspaceId };
}

/**
 * The workspaces whose memory may have moved to another folder: every
 * workspace bound to a project of the account the resolver uses.
 */
function boundWorkspaceIds(): string[] {
  const accountId = resolvableAccountId();
  if (accountId === null) return [];
  return projectDirectory
    .workspaceIds()
    .filter(
      (workspaceId) =>
        projectDirectory.projectFor(accountId, workspaceId) !== null,
    );
}

/**
 * A replica was registered or removed, so a scope may resolve to another
 * folder: open explorer watches follow it and renderers list it again.
 */
function onReplicasChanged(): void {
  retargetLocalMemoryWatches(localMemoryScopeDir);
  broadcastLocalMemoryChanged(USER_SCOPE);
  for (const workspaceId of boundWorkspaceIds()) {
    broadcastLocalMemoryChanged(workspaceScope(workspaceId));
  }
  notifyProjectMemoryChanged();
}

/** A workspace's binding or private memory changed: its folder may move. */
function onProjectBindingsChanged(
  workspaceIds: readonly string[],
  projectIds: readonly string[],
): void {
  engine?.projectEligibilityChanged(projectIds);
  retargetLocalMemoryWatches(localMemoryScopeDir);
  for (const workspaceId of workspaceIds) {
    broadcastLocalMemoryChanged(workspaceScope(workspaceId));
  }
  notifyProjectMemoryChanged();
}

const registry = new MemoryReplicaRegistry(onReplicasChanged);

// Loaded on demand: the workspace files' readers stay off this module's
// graph, which main loads early.
function projectBindings(): Promise<typeof ProjectBindings> {
  return import('./project-bindings');
}
const projectDirectory = new ProjectMemoryScopeDirectory(
  onProjectBindingsChanged,
);

/** Reads every workspace's binding again; rejects when the index is unreadable. */
async function refreshProjectBindings(): Promise<void> {
  const { readWorkspaceMemoryBindings } = await projectBindings();
  projectDirectory.replaceAll(await readWorkspaceMemoryBindings());
}

/**
 * A workspace's binding or private memory was written: the project it was
 * bound to stops sending at once, before its file is read again.
 */
function refreshWorkspaceBinding(workspaceId: string): void {
  const projectId = projectDirectory.boundProjectIdOf(workspaceId);
  if (projectId !== null) engine?.projectEligibilityChanged([projectId]);
  void projectBindings()
    .then(({ readWorkspaceMemoryBinding }) =>
      readWorkspaceMemoryBinding(workspaceId),
    )
    .then(
      (entry) => {
        projectDirectory.update(workspaceId, entry);
      },
      () => undefined,
    );
}
const changeListeners = new Set<() => void>();
let started = false;
let attached = false;
let engine: MemorySyncEngine | null = null;
let stream: { stop: () => void } | null = null;
let unsubscribers: Array<() => void> = [];
let reconciling: Promise<void> = Promise.resolve();

/**
 * The account whose replicas the resolver may use: the engine's, and only
 * while it is still the one signed in, so switching accounts stops reading
 * the old account's replicas at once.
 */
function resolvableAccountId(): string | null {
  const engineAccount = engine?.accountId ?? null;
  return engineAccount !== null &&
    memorySyncAccountId(peekCanopyCloudAccount()) === engineAccount
    ? engineAccount
    : null;
}

async function readEligibleAccountId(): Promise<string | null> {
  const result = await readCanopyCloudAccountWithStatus().catch(() => null);
  return result?.status === 'ok' ? memorySyncAccountId(result.entry) : null;
}

function notifyChange(): void {
  for (const listener of changeListeners) listener();
}

/**
 * Calls `listener` whenever memory sync's state may have changed: the
 * signed-in account, the engine and every pass. Returns the stop function.
 */
export function onMemorySyncChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return (): void => {
    changeListeners.delete(listener);
  };
}

/** The engine of the signed-in account, while it is still the one signed in. */
export function currentMemorySyncEngine(): MemorySyncEngine | null {
  return engine !== null && resolvableAccountId() === engine.accountId
    ? engine
    : null;
}

/**
 * Installs the replica locator and note hooks, so the local store reads and
 * writes the account's replicas while an engine runs.
 */
function attachReplicas(): void {
  attached = true;
  setLocalMemoryReplicaLocator(
    createMemoryReplicaLocator(registry, resolvableAccountId, (account, id) =>
      projectDirectory.projectFor(account, id),
    ),
  );
  setLocalMemoryReplicaHooks(createMemoryReplicaHooks(registry));
}

/**
 * Removes them, so every scope resolves to its device-local folder again, as
 * on a build without sync; replicas stay on disk.
 */
function detachReplicas(): void {
  if (!attached) return;
  attached = false;
  setLocalMemoryReplicaLocator(null);
  setLocalMemoryReplicaHooks(null);
}

async function stopEngine(): Promise<void> {
  stream?.stop();
  stream = null;
  detachReplicas();
  const current = engine;
  engine = null;
  if (current === null) return;
  registry.unregisterAccount(current.accountId);
  notifyProjectMemoryChanged();
  await current.stop();
}

let ambiguousProjectCount = 0;

/**
 * Two workspaces bound to one project keep both from syncing (fail closed);
 * says so once each time the number of such projects changes.
 */
function reportAmbiguousProjects(accountId: string): void {
  const count = projectDirectory.ambiguousProjects(accountId).length;
  if (count === ambiguousProjectCount) return;
  ambiguousProjectCount = count;
  if (count > 0) {
    recordProblem({ kind: 'project_scopes', code: 'ambiguous_binding' });
  }
}

/**
 * The local scope a cloud scope is this device's memory for: the user scope,
 * or the one workspace bound to the project for the account; null when no
 * workspace maps to it, which keeps the project from syncing.
 */
function localScopeFor(
  accountId: string,
  scope: MemoryScopeRef,
): LocalMemoryScopeRequest | null {
  if (scope.kind === 'user') return USER_SCOPE;
  const workspaceId = projectDirectory.workspaceFor(accountId, scope.projectId);
  return workspaceId === null ? null : workspaceScope(workspaceId);
}

/**
 * E2E-only: Electron flows start sync without the 15 second launch quiet
 * period and push without the debounce. Gated on the build-time
 * `__CANOPY_E2E__`, so production builds drop it (check:no-e2e-seams).
 */
function engineTiming(): {
  launchQuietMs: number;
  pushDebounceMs: number;
} | null {
  if (__CANOPY_E2E__) {
    return process.env.CANOPY_E2E_MEMORY_SYNC_IMMEDIATE === '1'
      ? { launchQuietMs: 0, pushDebounceMs: 50 }
      : null;
  }
  return null;
}

async function startEngine(accountId: string): Promise<void> {
  const device = await readDevice();
  const timing = engineTiming();
  attachReplicas();
  const next = new MemorySyncEngine({
    ...(timing === null ? {} : { timing }),
    accountId,
    replicasRoot: getMemoryReplicasRootDir(),
    transport: createMemorySyncTransport(accountId, cloudHttp),
    device,
    registry,
    projectScopes: async (): Promise<readonly ProjectMemoryScopeTarget[]> => {
      await refreshProjectBindings();
      reportAmbiguousProjects(accountId);
      return projectDirectory.targets(accountId);
    },
    projectScope: async (
      projectId: string,
    ): Promise<ProjectMemoryScopeTarget | null> => {
      const workspaceId = projectDirectory.workspaceFor(accountId, projectId);
      if (workspaceId === null) return null;
      const { readWorkspaceMemoryBinding } = await projectBindings();
      projectDirectory.update(
        workspaceId,
        await readWorkspaceMemoryBinding(workspaceId),
      );
      return (
        projectDirectory
          .targets(accountId)
          .find((target) => target.scope.projectId === projectId) ?? null
      );
    },
    accountEligible: (): boolean =>
      started && engine === next && resolvableAccountId() === accountId,
    deviceLocalDir: (scope): string | null => {
      const local = localScopeFor(accountId, scope);
      return local === null ? null : deviceLocalMemoryScopeDir(local);
    },
    onScopeChanged: (scope): void => {
      const local = localScopeFor(accountId, scope);
      if (local !== null) broadcastLocalMemoryChanged(local);
    },
    requestConsolidation: (scope, delayMs): void => {
      const local = localScopeFor(accountId, scope);
      if (local === null) return;
      // Loaded on demand: the scheduler's session imports stay off this
      // module's graph, and main has already loaded it by the time a run ends.
      void import('../local/consolidation-scheduler')
        .then((scheduler) =>
          scheduler.retryLocalMemoryConsolidation(
            local.scope === 'workspace'
              ? { workspaceId: local.workspaceId }
              : {},
            delayMs,
          ),
        )
        .catch((error: unknown) => {
          logMainProcessWarn('Memory consolidation could not be rearmed', {
            error: error instanceof Error ? error.name : 'unknown',
          });
        });
    },
    recordProblem,
    recordMetric,
    onStatusChanged: notifyChange,
    onProjectModesChanged: notifyProjectMemoryChanged,
  });
  engine = next;
  notifyProjectMemoryChanged();
  await next.loadReplicas();
  next.start();
  stream = openMemorySyncNudgeStream(accountId, () => {
    next.requestPull();
  });
}

async function reconcileNow(): Promise<void> {
  const desired = started ? await readEligibleAccountId() : null;
  if (desired !== null && desired === engine?.accountId) return;
  await stopEngine();
  if (desired !== null && started) {
    await startEngine(desired).catch((error: unknown) => {
      if (engine === null) detachReplicas();
      logMainProcessWarn('Memory sync could not start', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    });
  }
  notifyChange();
}

function reconcile(): Promise<void> {
  reconciling = reconciling.then(reconcileNow, reconcileNow);
  return reconciling;
}

function onResume(): void {
  engine?.requestPull();
}

/**
 * Follows the signed-in account from launch: the engine runs while it
 * carries `memory-sync-v1`. Losing the capability stops the engine and
 * removes the locator, so every scope resolves to its device-local folder
 * again; replicas stay on disk.
 */
export function startMemorySync(): void {
  if (started) return;
  started = true;
  powerMonitor.on('resume', onResume);
  unsubscribers = [
    subscribeCanopyCloudAccountChanges(() => {
      notifyChange();
      void reconcile();
    }),
    onWorkspaceMemoryBindingChanged(refreshWorkspaceBinding),
    (): void => {
      powerMonitor.removeListener('resume', onResume);
    },
  ];
  void reconcile();
}

/** Stops sync at quit. Never rejects. */
export async function stopMemorySync(): Promise<void> {
  started = false;
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  await reconcile().catch(() => undefined);
}

/**
 * A bound workspace's project memory, as the "keep memory on this device"
 * switch shows it (design §22). `mode` is the account's choice for the
 * project, which every device honors, or its default for projects; null
 * while this launch has not read the account's choices. `state` is what the
 * memory does on this device now. `changeable` is false while the
 * workspace's private memory decides (the organization may manage it), or
 * its binding was detached or its project moved.
 */
export interface WorkspaceProjectMemory {
  workspaceId: string;
  projectId: string;
  mode: 'sync' | 'device_only' | null;
  state: 'sync' | 'device_only' | 'stopped';
  reason: 'private_memory' | 'detached' | 'moved' | 'kept_on_device' | null;
  changeable: boolean;
}

export type WorkspaceProjectMemoryModeResult =
  | { ok: true; memory: WorkspaceProjectMemory }
  | {
      ok: false;
      reason:
        | 'off'
        | 'not_bound'
        | 'private_memory'
        | 'not_syncing'
        | 'sync_disabled'
        | 'failed';
    };

const projectMemoryListeners = new Set<() => void>();

function notifyProjectMemoryChanged(): void {
  for (const listener of projectMemoryListeners) listener();
  // A project's memory is part of memory sync's state, so whatever shows
  // that state hears about a binding, Private memory or mode change too.
  notifyChange();
}

/**
 * Runs `listener` whenever a {@link workspaceProjectMemory} answer may have
 * changed: a binding or private memory choice, the account's per-project
 * modes, the signed-in account or the engine. Returns the stop function.
 */
export function onWorkspaceProjectMemoryChange(
  listener: () => void,
): () => void {
  projectMemoryListeners.add(listener);
  return (): void => {
    projectMemoryListeners.delete(listener);
  };
}

function syncingEngine(): MemorySyncEngine | null {
  const accountId = resolvableAccountId();
  return started && engine !== null && accountId === engine.accountId
    ? engine
    : null;
}

/**
 * The project memory of a workspace bound to a cloud project of the
 * signed-in account; null while sync is off, signed out, or the workspace
 * maps to no project scope. Synchronous and free of I/O.
 */
export function workspaceProjectMemory(
  workspaceId: string,
): WorkspaceProjectMemory | null {
  const current = syncingEngine();
  if (current === null) return null;
  const target = projectDirectory
    .targets(current.accountId)
    .find((entry) => entry.workspaceId === workspaceId);
  if (target === undefined) return null;
  const mode = current.projectMode(target.scope.projectId);
  const keptHere = target.mode === 'sync' && mode === 'device_only';
  return {
    workspaceId,
    projectId: target.scope.projectId,
    mode,
    state: keptHere ? 'device_only' : target.mode,
    reason: keptHere ? 'kept_on_device' : target.reason,
    changeable: target.mode === 'sync',
  };
}

/**
 * Every workspace bound to a cloud project of the signed-in account, with
 * its project memory as {@link workspaceProjectMemory} answers it. Empty
 * while sync is off or signed out. Synchronous and free of I/O: the
 * bindings are the ones the last pass or binding event read.
 */
export function listWorkspaceProjectMemory(): WorkspaceProjectMemory[] {
  const current = syncingEngine();
  if (current === null) return [];
  return projectDirectory
    .targets(current.accountId)
    .flatMap(({ workspaceId }) => {
      const memory = workspaceProjectMemory(workspaceId);
      return memory === null ? [] : [memory];
    });
}

/**
 * The project scope a workspace is bound to, its binding read again, or
 * null when no single workspace of the signed-in account maps to one. The
 * caller addresses a project scope by its workspace, so the project a
 * control acts on is always the one the workspace names now.
 */
export async function freshWorkspaceProjectScope(
  workspaceId: string,
): Promise<MemoryScopeRef | null> {
  if (syncingEngine() === null) return null;
  const { readWorkspaceMemoryBinding } = await projectBindings();
  projectDirectory.update(
    workspaceId,
    await readWorkspaceMemoryBinding(workspaceId),
  );
  const current = syncingEngine();
  if (current === null) return null;
  return (
    projectDirectory
      .targets(current.accountId)
      .find((entry) => entry.workspaceId === workspaceId)?.scope ?? null
  );
}

/**
 * Sets "keep memory on this device" (`device_only`) or sync for the cloud
 * project a workspace is bound to, for the signed-in account on every
 * device. Reads the workspace's binding fresh first, and refuses while sync
 * is off, the workspace is bound to no project of the account, its private
 * memory decides, or its binding no longer syncs.
 */
export async function setWorkspaceProjectMemoryMode(
  workspaceId: string,
  mode: 'sync' | 'device_only',
): Promise<WorkspaceProjectMemoryModeResult> {
  if (syncingEngine() === null) return { ok: false, reason: 'off' };
  const { readWorkspaceMemoryBinding } = await projectBindings();
  projectDirectory.update(
    workspaceId,
    await readWorkspaceMemoryBinding(workspaceId),
  );
  const current = syncingEngine();
  if (current === null) return { ok: false, reason: 'off' };
  const target = projectDirectory
    .targets(current.accountId)
    .find((entry) => entry.workspaceId === workspaceId);
  if (target === undefined) return { ok: false, reason: 'not_bound' };
  if (target.reason === 'private_memory') {
    return { ok: false, reason: 'private_memory' };
  }
  if (target.mode !== 'sync') return { ok: false, reason: 'not_syncing' };
  const result = await current.setProjectMode(target.scope.projectId, mode);
  if (!result.ok) {
    return {
      ok: false,
      reason: result.failure.kind === 'paused' ? 'sync_disabled' : 'failed',
    };
  }
  const memory = workspaceProjectMemory(workspaceId);
  return memory === null ? { ok: false, reason: 'off' } : { ok: true, memory };
}

export const memorySyncHostTestExports = {
  /** Runs a pass of the current engine now, once account changes applied. */
  async syncNow(): Promise<MemorySyncEngineStatus | null> {
    await reconciling;
    return (await engine?.syncNow()) ?? null;
  },
};
