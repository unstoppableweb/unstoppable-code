import { isScriptActionRelativePath } from '@canopy/protocol/script-actions';
import { TERMINAL_SHELL_UNAVAILABLE_PREFIX } from '@canopy/protocol/terminal';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import {
  SINGLE_REPO_USAGE_REPO_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import { resolveTerminalRelativeCwd } from '@canopy/desktop-shared/node/terminal-relative-cwd';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { waitForWorktreeGitSetup } from '../lib/worktree-git-setup';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  TERMINAL_USER_CLOSE_SIGNAL,
  type ManagedTerminalCommand,
  type RemoteControlEntityEnvelope,
  type RemoteControlTarget,
  type TerminalKillRequest,
  type TerminalResizeRequest,
  type TerminalRestoreRequest,
  type TerminalSession,
  type TerminalShellProfile,
  type TerminalShellProfileId,
  type TerminalSpawnRequest,
  type TerminalWriteRequest,
  type TerminalWriteDisposition,
} from '@canopy/desktop-shared/types';
import { worktreeScopedParentLocalId } from '@canopy/protocol/remote-control/shell';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { assertNotSplitLocked } from './split-lock-service';
import {
  isBlockedManagedEnvName,
  isRestorableExitSignal,
} from '@canopy/core-runtime/node/terminal';
import {
  desktopManagedTerminalEnvironmentFor,
  desktopTerminalEnvironmentFor,
  desktopTerminalShells,
  workerTerminal,
} from '../terminal/worker-terminal';
import type { DaemonTerminalRouteContext } from '../terminal/daemon-terminal-route';
import { terminalPersistenceStore } from '../terminal/persistence';
import { withWorkspaceTargetRuntimeStartReservation } from '../lib/workspace-target-exclusion';
import { getBundledClaudeBinaryPath } from '../pipelines/config-paths';
import { detectGitExecutable } from '../lib/git-executable';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import {
  isSharedContainerAccepted,
  isSharedContainerRunAllowed,
  withSharedContainerRunLifecycle,
} from '../shared-containers/acceptance-store';
import { getSharedContainerReader } from '../shared-containers/read/reader';
import {
  ensureSharedContainerRunCopy,
  getSharedContainerRunCopyState,
} from '../shared-containers/run/run-copy';
import { readSharedContainerRunEnvironment } from '../shared-containers/run-env-store';
import { recordDaemonRoute } from '../canopy-runtime/daemon-route-telemetry';
import { buildSharedContainerRunEnv } from '../lib/shared-container-run-env';

export const MAX_TERMINAL_WRITE_BYTES = 64 * 1024;
const MAX_TERMINAL_WRITE_RECEIPTS = 4096;
const terminalWriteReceipts = new Map<string, true>();

function rememberTerminalWriteReceipt(receiptKey: string): void {
  terminalWriteReceipts.set(receiptKey, true);
  while (terminalWriteReceipts.size > MAX_TERMINAL_WRITE_RECEIPTS) {
    const oldestKey = terminalWriteReceipts.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    terminalWriteReceipts.delete(oldestKey);
  }
}

export function rememberTerminalInitialPrompt(
  terminalId: string,
  idempotencyKey: string,
): void {
  validateTerminalId(terminalId);
  try {
    validateId(idempotencyKey, 'initialPromptIdempotencyKey');
  } catch (error) {
    throw new TerminalServiceError(
      'invalid_payload',
      error instanceof Error ? error.message : String(error),
    );
  }
  for (const suffix of ['clear-0', 'clear-1', 'clear-2', 'paste', 'submit']) {
    rememberTerminalWriteReceipt(`${terminalId}:${idempotencyKey}-${suffix}`);
  }
}

export class TerminalServiceError extends Error {
  public constructor(
    public readonly code: 'invalid_payload' | 'invalid_target' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'TerminalServiceError';
  }
}

function validateTerminalDimension(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TerminalServiceError(
      'invalid_payload',
      `Invalid ${label}: must be a positive integer`,
    );
  }
}

function validateTerminalId(terminalId: string): void {
  try {
    validateId(terminalId, 'terminalId');
  } catch (error) {
    throw new TerminalServiceError(
      'invalid_target',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function validateInitialCommand(initialCommand: unknown): void {
  if (initialCommand === undefined) return;
  if (
    typeof initialCommand !== 'string' ||
    initialCommand.trim().length === 0 ||
    Buffer.byteLength(initialCommand, 'utf8') > MAX_TERMINAL_WRITE_BYTES
  ) {
    throw new TerminalServiceError(
      'invalid_payload',
      'Invalid initial terminal command',
    );
  }
}

interface TerminalOperationScope {
  projectId?: string;
  worktreeId?: string;
}

function validateTerminalOperationScope(scope: TerminalOperationScope): void {
  try {
    if (scope.projectId) validateId(scope.projectId, 'projectId');
    if (scope.worktreeId) validateId(scope.worktreeId, 'worktreeId');
  } catch (error) {
    throw new TerminalServiceError(
      'invalid_target',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function assertTerminalAuthorized(
  terminalId: string,
  scope: TerminalOperationScope,
): void {
  const session = workerTerminal
    .list()
    .find((candidate) => candidate.id === terminalId);
  if (!session) {
    throw new TerminalServiceError(
      'not_found',
      `Terminal not found: ${terminalId}`,
    );
  }
  if (
    (scope.projectId && session.projectId !== scope.projectId) ||
    (scope.worktreeId && session.worktreeId !== scope.worktreeId)
  ) {
    throw new TerminalServiceError(
      'not_found',
      `Terminal not found: ${terminalId}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateTerminalProfileId(
  value: unknown,
): asserts value is TerminalShellProfileId | undefined {
  if (value === undefined) {
    return;
  }
  if (
    value === 'default' ||
    value === 'zsh' ||
    value === 'bash' ||
    value === 'cmd' ||
    value === 'powershell' ||
    value === 'git-bash'
  ) {
    return;
  }
  throw new TerminalServiceError(
    'invalid_payload',
    'Invalid terminal profile id',
  );
}

function normalizeComparablePath(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function validateManagedCommand(
  command: ManagedTerminalCommand,
  options: { allowPathPrepend?: boolean } = {},
): void {
  if (command.kind !== 'claude-code' && command.kind !== 'claude-worker') {
    throw new TerminalServiceError(
      'invalid_payload',
      'Invalid managed terminal command kind',
    );
  }
  if (
    typeof command.executable !== 'string' ||
    !path.isAbsolute(command.executable)
  ) {
    throw new TerminalServiceError(
      'invalid_payload',
      'Invalid managed terminal executable: must be an absolute path',
    );
  }
  const bundledClaudePath = getBundledClaudeBinaryPath();
  if (
    normalizeComparablePath(command.executable) !==
    normalizeComparablePath(bundledClaudePath)
  ) {
    throw new TerminalServiceError(
      'invalid_payload',
      'Invalid managed terminal executable: must use the bundled Claude binary',
    );
  }
  if (
    !Array.isArray(command.args) ||
    !command.args.every((arg) => typeof arg === 'string')
  ) {
    throw new TerminalServiceError(
      'invalid_payload',
      'Invalid managed terminal args: must be an array of strings',
    );
  }
  if (command.env !== undefined) {
    if (!isRecord(command.env)) {
      throw new TerminalServiceError(
        'invalid_payload',
        'Invalid managed terminal env: must be a string record',
      );
    }
    for (const [name, value] of Object.entries(command.env)) {
      if (typeof name !== 'string' || typeof value !== 'string') {
        throw new TerminalServiceError(
          'invalid_payload',
          'Invalid managed terminal env: must be a string record',
        );
      }
      if (isBlockedManagedEnvName(name)) {
        throw new TerminalServiceError(
          'invalid_payload',
          `Invalid managed terminal env: blocked key ${name}`,
        );
      }
    }
  }
  if (command.pathPrepend !== undefined) {
    if (!options.allowPathPrepend) {
      throw new TerminalServiceError(
        'invalid_payload',
        'Invalid managed terminal pathPrepend: only internal launches may set path overrides',
      );
    }
    if (
      !Array.isArray(command.pathPrepend) ||
      !command.pathPrepend.every(
        (entry) => typeof entry === 'string' && path.isAbsolute(entry),
      )
    ) {
      throw new TerminalServiceError(
        'invalid_payload',
        'Invalid managed terminal pathPrepend: entries must be absolute paths',
      );
    }
  }
  if (typeof command.title !== 'string' || command.title.trim().length === 0) {
    throw new TerminalServiceError(
      'invalid_payload',
      'Invalid managed terminal title',
    );
  }
}

function sessionMatchesTarget(
  session: TerminalSession,
  target?: RemoteControlTarget,
): boolean {
  if (!target) {
    return true;
  }
  if (
    target.workspaceLocalId &&
    target.workspaceLocalId !== session.projectId
  ) {
    return false;
  }
  if (target.worktreeLocalId && target.worktreeLocalId !== session.worktreeId) {
    return false;
  }
  if (target.terminalLocalId && target.terminalLocalId !== session.id) {
    return false;
  }
  return true;
}

export function spawnTerminal(request: TerminalSpawnRequest): TerminalSession {
  if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    throw new TerminalServiceError(
      'invalid_target',
      'Shared-container terminals require run consent.',
    );
  }
  return spawnTerminalWithEnvironment(request);
}

/** The checks every terminal a request opens passes, wherever it runs. */
function validateSpawnRequest(request: TerminalSpawnRequest): void {
  try {
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    validateOptionalRepoId(request.selectedRepoId, 'selectedRepoId');
  } catch (error) {
    throw new TerminalServiceError(
      'invalid_target',
      error instanceof Error ? error.message : String(error),
    );
  }
  assertNotSplitLocked(
    request.projectId,
    request.worktreeId,
    'opening a terminal',
  );
  validateTerminalDimension(request.cols, 'cols');
  validateTerminalDimension(request.rows, 'rows');
  validateTerminalProfileId(request.terminalProfileId);
  validateInitialCommand(request.initialCommand);
  if (
    request.managedCommand &&
    (request.terminalProfileId !== undefined ||
      request.initialCommand !== undefined)
  ) {
    throw new TerminalServiceError(
      'invalid_payload',
      'Managed terminal commands cannot set a shell profile or initial command',
    );
  }
}

function spawnTerminalWithEnvironment(
  request: TerminalSpawnRequest,
  environmentOverride?: NodeJS.ProcessEnv,
): TerminalSession {
  validateSpawnRequest(request);
  let relativeCwd: string | undefined;
  if (request.relativeCwd !== undefined && request.relativeCwd !== '') {
    try {
      relativeCwd = resolveTerminalRelativeCwd(
        resolveWorktreeCwd(
          request.projectId,
          request.worktreeId,
          request.selectedRepoId,
        ),
        request.relativeCwd,
      );
    } catch {
      throw new TerminalServiceError(
        'invalid_target',
        'Invalid relative terminal directory.',
      );
    }
  }
  if (request.managedCommand) {
    validateManagedCommand(request.managedCommand);
  }
  return workerTerminal.create({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    cols: request.cols,
    rows: request.rows,
    repoId: request.selectedRepoId,
    managedCommand: request.managedCommand,
    cwd: relativeCwd,
    ...(request.managedCommand
      ? {}
      : {
          profileId: request.terminalProfileId,
          initialCommand: request.initialCommand,
        }),
    environment: environmentOverride,
  });
}

async function authorizeRelativeTerminalTarget(
  request: TerminalSpawnRequest,
): Promise<void> {
  if (request.relativeCwd === undefined || request.relativeCwd === '') return;
  if (!isScriptActionRelativePath(request.relativeCwd))
    throw new TerminalServiceError(
      'invalid_target',
      'Invalid relative terminal directory.',
    );
  try {
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    validateOptionalRepoId(request.selectedRepoId, 'selectedRepoId');
    const { config, authority } = await readWorkspaceConfigDetailed(
      request.projectId,
    );
    if (authority !== 'ok' || config.type === 'cowork') throw new Error();
    const worktrees = await readWorkspaceWorktrees(request.projectId);
    if (!worktrees.some((worktree) => worktree.id === request.worktreeId))
      throw new Error();
    if (
      request.selectedRepoId &&
      request.selectedRepoId !== WORKSPACE_ROOT_REPO_ID
    ) {
      const valid =
        config.type === 'single-repo'
          ? request.selectedRepoId === SINGLE_REPO_USAGE_REPO_ID
          : config.repos.some((repo) => repo.id === request.selectedRepoId);
      if (!valid) throw new Error();
    }
  } catch {
    throw new TerminalServiceError(
      'invalid_target',
      'Terminal target does not belong to this workspace.',
    );
  }
}

/**
 * Opens a terminal for a user entry point (renderer IPC, Portal). On Linux x64
 * a Default shell may need the account lookup, so it is awaited off the main
 * thread first; shell selection remains synchronous and cache-only.
 */
export async function spawnTerminalAfterShellPrewarm(
  request: TerminalSpawnRequest,
  route?: DaemonTerminalRouteContext,
  canStart?: () => boolean,
): Promise<TerminalSession> {
  if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    return spawnTerminal(request);
  }
  validateSpawnRequest(request);
  // Creation returns its reservation before Git materializes the checkout.
  // Wait before resolving relative paths or selecting either execution host.
  // Do not claim the outcome: a subsequent chat send must still see failures.
  const setup = await waitForWorktreeGitSetup(
    request.projectId,
    request.worktreeId,
  );
  if (setup === 'failed' || setup === 'cancelled') {
    throw new TerminalServiceError(
      'invalid_target',
      `${TERMINAL_SHELL_UNAVAILABLE_PREFIX}Couldn't open terminal: worktree setup ${setup}.`,
    );
  }
  await authorizeRelativeTerminalTarget(request);
  const cwd = resolveWorktreeCwd(
    request.projectId,
    request.worktreeId,
    request.selectedRepoId,
  );
  const directory = await stat(cwd).catch((error: unknown) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      throw new TerminalServiceError(
        'invalid_target',
        // Terminal surfaces show safe startup diagnostics with this marker.
        `${TERMINAL_SHELL_UNAVAILABLE_PREFIX}Couldn't open terminal: working directory does not exist: ${cwd}`,
      );
    }
    throw error;
  });
  if (!directory.isDirectory()) {
    throw new TerminalServiceError(
      'invalid_target',
      `${TERMINAL_SHELL_UNAVAILABLE_PREFIX}Couldn't open terminal: working directory is not a directory: ${cwd}`,
    );
  }
  if (
    request.managedCommand === undefined &&
    (request.terminalProfileId === undefined ||
      request.terminalProfileId === 'default')
  ) {
    await workerTerminal.prewarmShell();
  }
  if (canStart?.() === false) {
    throw new TerminalServiceError(
      'invalid_target',
      'The terminal request is no longer active.',
    );
  }
  if (route?.localWindow) {
    const placed = await spawnDaemonTerminal(request, route);
    if (placed) return placed;
  } else {
    // The bridge, Portal and other non-local callers stay in process (CAN-5093).
    recordDaemonRoute('terminals', 'caller');
  }
  return spawnTerminal(request);
}

/**
 * An eligible local window terminal in the daemon's terminal host
 * (CAN-5088, CAN-5718), after the checks the
 * in-process engine runs; `null` keeps it in process. A daemon that can't be
 * reached opens it in process with the background service warning, and one
 * that cannot start its terminal host opens it in process too; any other
 * refusal from a reached daemon fails the request.
 */
async function spawnDaemonTerminal(
  request: TerminalSpawnRequest,
  route: DaemonTerminalRouteContext,
): Promise<TerminalSession | null> {
  // Renderer ids pass the shared validators before any routing or path work.
  validateSpawnRequest(request);
  const routing = await import('../terminal/daemon-terminal-route');
  const target = await routing.selectDaemonTerminalTarget(request, route);
  if (!target) return null;
  const shell = desktopTerminalShells.profile(request.terminalProfileId);
  try {
    // Held until the terminal is mirrored, so archiving waits for it.
    const session = await withWorkspaceTargetRuntimeStartReservation(
      request.projectId,
      request.worktreeId,
      () =>
        routing.getDaemonTerminals().create({
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          scope: target.scope,
          cwdRootId: target.cwdRootId,
          cwdRelativePath: '',
          cwd: target.rootPath,
          shell,
          environment: desktopTerminalEnvironmentFor(
            request.projectId,
            request.worktreeId,
          ),
          cols: request.cols,
          rows: request.rows,
          ...(request.terminalProfileId !== undefined && {
            profileId: request.terminalProfileId,
          }),
          ...(request.initialCommand !== undefined && {
            initialCommand: request.initialCommand,
          }),
        }),
    );
    routing.noteDaemonTerminalServed();
    return session;
  } catch (error) {
    if (routing.noteDaemonTerminalFallback(error)) return null;
    throw error;
  }
}

// The newest scrollback a recreated daemon terminal replays (its window's size).
const DAEMON_RESTORE_SCROLLBACK_MAX_CHARS = 1024 * 1024;

/**
 * Restarts an eligible persisted shell in the daemon, as the engine
 * restarts one in process; `null` leaves it to the
 * engine, which also refuses a terminal that is not restorable.
 */
async function restoreDaemonTerminal(
  request: TerminalRestoreRequest,
  route: DaemonTerminalRouteContext,
): Promise<TerminalSession | null> {
  const persisted = terminalPersistenceStore.getPersistedTerminalEntry(
    request.terminalId,
  );
  if (
    !persisted ||
    (persisted.session.kind ?? 'shell') !== 'shell' ||
    !isRestorableExitSignal(persisted.signal)
  ) {
    recordDaemonRoute('terminals', 'not_restorable');
    return null;
  }
  const { session } = persisted;
  const routing = await import('../terminal/daemon-terminal-route');
  const target = await routing.selectDaemonTerminalTarget(
    { projectId: session.projectId, worktreeId: session.worktreeId },
    route,
  );
  if (!target) return null;
  const scrollback = persisted.scrollbackLines.join('\n');
  const directory = routing.daemonRestoreDirectory(
    target.rootPath,
    session.cwd,
  );
  try {
    const restored = await withWorkspaceTargetRuntimeStartReservation(
      session.projectId,
      session.worktreeId,
      () =>
        routing.getDaemonTerminals().recreate({
          terminalId: request.terminalId,
          projectId: session.projectId,
          worktreeId: session.worktreeId,
          scope: target.scope,
          cwdRootId: target.cwdRootId,
          cwdRelativePath: directory.cwdRelativePath,
          cwd: directory.cwd,
          shell: desktopTerminalShells.persisted(session),
          environment: desktopTerminalEnvironmentFor(
            session.projectId,
            session.worktreeId,
          ),
          cols: request.cols,
          rows: request.rows,
          createdAt: Date.now(),
          scrollback:
            scrollback.length > DAEMON_RESTORE_SCROLLBACK_MAX_CHARS
              ? scrollback.slice(-DAEMON_RESTORE_SCROLLBACK_MAX_CHARS)
              : scrollback,
          ...(session.initialCommand !== undefined && {
            initialCommand: session.initialCommand,
          }),
        }),
    );
    routing.noteDaemonTerminalServed();
    return restored;
  } catch (error) {
    if (routing.noteDaemonTerminalFallback(error)) return null;
    throw error;
  }
}

export async function spawnTerminalForRenderer(
  request: TerminalSpawnRequest,
  route?: DaemonTerminalRouteContext,
): Promise<TerminalSession> {
  if (request.projectId !== SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    return spawnTerminalAfterShellPrewarm(request, route);
  }
  if (request.relativeCwd !== undefined && request.relativeCwd !== '') {
    throw new TerminalServiceError(
      'invalid_target',
      'Package terminal directories require a code workspace.',
    );
  }
  recordDaemonRoute('terminals', 'shared_container');
  return withSharedContainerRunLifecycle(
    request.worktreeId,
    async (): Promise<TerminalSession> => {
      if (
        process.platform !== 'darwin' ||
        !getFeatureFlagService().isEnabled(
          CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key,
        ) ||
        !(await isSharedContainerAccepted(request.worktreeId)) ||
        !(await isSharedContainerRunAllowed(request.worktreeId))
      ) {
        throw new TerminalServiceError(
          'invalid_target',
          'Shared-container terminals require run consent.',
        );
      }
      const reader = getSharedContainerReader();
      const state = await reader.store.get(request.worktreeId);
      if (state?.status !== 'available' && state?.status !== 'pinned') {
        throw new TerminalServiceError(
          'invalid_target',
          'Shared-container revision is not available.',
        );
      }
      const run = await reader.readRunConfig({
        containerId: request.worktreeId,
        revisionId: state.revisionId,
      });
      if (!run) {
        throw new TerminalServiceError(
          'invalid_target',
          'This share did not publish run configuration.',
        );
      }
      const runCopy = await getSharedContainerRunCopyState(request.worktreeId);
      if (
        runCopy.state === 'committed' &&
        runCopy.revisionId !== state.revisionId
      ) {
        throw new TerminalServiceError(
          'invalid_target',
          'Update the shared-container run copy before opening a terminal.',
        );
      }
      await ensureSharedContainerRunCopy(
        request.worktreeId,
        reader.store,
        state.revisionId,
      );
      const declared = new Set(run.requiredEnv);
      const values = (
        await readSharedContainerRunEnvironment(request.worktreeId)
      ).filter((entry) => declared.has(entry.key));
      return spawnTerminalWithEnvironment(
        request,
        buildSharedContainerRunEnv(
          request.worktreeId,
          Object.fromEntries(values.map((entry) => [entry.key, entry.value])),
        ),
      );
    },
  );
}

export async function restoreTerminalForRenderer(
  request: TerminalRestoreRequest,
  session: TerminalSession | undefined,
  route?: DaemonTerminalRouteContext,
): Promise<TerminalSession> {
  if (session?.projectId !== SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    // A live daemon terminal stays there; a persisted one goes where the
    // eligibility rules send the next terminal.
    const daemon = workerTerminal.daemonTerminals;
    if (daemon?.has(request.terminalId))
      return daemon.reattach(request.terminalId, request.cols, request.rows);
    if (!workerTerminal.get(request.terminalId)) {
      if (route?.localWindow) {
        const restored = await restoreDaemonTerminal(request, route);
        if (restored) return restored;
      } else recordDaemonRoute('terminals', 'caller');
    }
    return workerTerminal.restore({
      terminalId: request.terminalId,
      cols: request.cols,
      rows: request.rows,
    });
  }
  recordDaemonRoute('terminals', 'shared_container');
  return withSharedContainerRunLifecycle(
    session.worktreeId,
    async (): Promise<TerminalSession> => {
      if (
        process.platform !== 'darwin' ||
        !getFeatureFlagService().isEnabled(
          CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key,
        ) ||
        !(await isSharedContainerAccepted(session.worktreeId)) ||
        !(await isSharedContainerRunAllowed(session.worktreeId))
      ) {
        throw new TerminalServiceError(
          'invalid_target',
          'Shared-container terminals require run consent.',
        );
      }
      const reader = getSharedContainerReader();
      const state = await reader.store.get(session.worktreeId);
      if (state?.status !== 'available' && state?.status !== 'pinned') {
        throw new TerminalServiceError(
          'invalid_target',
          'Shared-container revision is not available.',
        );
      }
      const run = await reader.readRunConfig({
        containerId: session.worktreeId,
        revisionId: state.revisionId,
      });
      if (!run) {
        throw new TerminalServiceError(
          'invalid_target',
          'This share did not publish run configuration.',
        );
      }
      const runCopy = await getSharedContainerRunCopyState(session.worktreeId);
      if (
        runCopy.state === 'committed' &&
        runCopy.revisionId !== state.revisionId
      ) {
        throw new TerminalServiceError(
          'invalid_target',
          'Update the shared-container run copy before restoring this terminal.',
        );
      }
      await ensureSharedContainerRunCopy(
        session.worktreeId,
        reader.store,
        state.revisionId,
      );
      const declared = new Set(run.requiredEnv);
      const values = (
        await readSharedContainerRunEnvironment(session.worktreeId)
      ).filter((entry) => declared.has(entry.key));
      return workerTerminal.restore({
        terminalId: request.terminalId,
        cols: request.cols,
        rows: request.rows,
        environment: buildSharedContainerRunEnv(
          session.worktreeId,
          Object.fromEntries(values.map((entry) => [entry.key, entry.value])),
        ),
      });
    },
  );
}

export async function listTerminalProfiles(): Promise<TerminalShellProfile[]> {
  if (process.platform === 'win32') {
    await detectGitExecutable().catch(() => undefined);
  }
  await workerTerminal.prewarmShell();
  return workerTerminal.profiles();
}

function validateManagedSpawnRequest(
  request: TerminalSpawnRequest & { cwd?: string },
): void {
  if (!request.managedCommand) {
    throw new TerminalServiceError(
      'invalid_payload',
      'Managed terminal command is required',
    );
  }
  try {
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    validateOptionalRepoId(request.selectedRepoId, 'selectedRepoId');
  } catch (error) {
    throw new TerminalServiceError(
      'invalid_target',
      error instanceof Error ? error.message : String(error),
    );
  }
  assertNotSplitLocked(
    request.projectId,
    request.worktreeId,
    'opening a terminal',
  );
  validateTerminalDimension(request.cols, 'cols');
  validateTerminalDimension(request.rows, 'rows');
  validateManagedCommand(request.managedCommand, { allowPathPrepend: true });
}

export function spawnManagedTerminal(
  request: TerminalSpawnRequest & { cwd?: string },
): TerminalSession {
  validateManagedSpawnRequest(request);
  return workerTerminal.create({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    cols: request.cols,
    rows: request.rows,
    repoId: request.selectedRepoId,
    managedCommand: request.managedCommand,
    cwd:
      request.relativeCwd === undefined || request.relativeCwd === ''
        ? request.cwd
        : ((): string | undefined => {
            if (request.cwd !== undefined)
              throw new TerminalServiceError(
                'invalid_target',
                'Cannot combine relative and absolute terminal directories.',
              );
            try {
              return resolveTerminalRelativeCwd(
                resolveWorktreeCwd(
                  request.projectId,
                  request.worktreeId,
                  request.selectedRepoId,
                ),
                request.relativeCwd,
              );
            } catch {
              throw new TerminalServiceError(
                'invalid_target',
                'Invalid relative terminal directory.',
              );
            }
          })(),
  });
}

/** Who asked for a managed Claude terminal, for its placement (CAN-5097 D4). */
export interface ManagedTerminalPlacement {
  /** The launch came from the Remote Control bridge; it stays in process. */
  readonly fromRemoteBridge?: boolean;
}

function managedCommandOf(
  request: TerminalSpawnRequest & { cwd?: string },
): ManagedTerminalCommand {
  const command = request.managedCommand;
  if (!command)
    throw new TerminalServiceError(
      'invalid_payload',
      'Managed terminal command is required',
    );
  return command;
}

/**
 * Opens a managed Claude terminal in the daemon's terminal host when it is
 * eligible (CAN-5097), otherwise in process as `spawnManagedTerminal` does.
 * The same validation runs first either way.
 */
export async function spawnPlacedManagedTerminal(
  request: TerminalSpawnRequest & { cwd?: string },
  placement: ManagedTerminalPlacement = {},
): Promise<TerminalSession> {
  validateManagedSpawnRequest(request);
  const command = managedCommandOf(request);
  if (request.cwd === undefined) return spawnManagedTerminal(request);
  const routing = await import('../terminal/daemon-terminal-route');
  const target = await routing.selectDaemonManagedTerminalTarget({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    selectedRepoId: request.selectedRepoId,
    relativeCwd: request.relativeCwd,
    cwd: request.cwd,
    managedKind: command.kind,
    fromRemoteBridge: placement.fromRemoteBridge === true,
  });
  if (!target) return spawnManagedTerminal(request);
  await routing.sweepOrphanedDaemonManagedTerminals();
  try {
    const managed = await withWorkspaceTargetRuntimeStartReservation(
      request.projectId,
      request.worktreeId,
      () =>
        routing.getDaemonTerminals().create({
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          scope: target.scope,
          cwdRootId: target.cwdRootId,
          cwdRelativePath: '',
          cwd: target.rootPath,
          shell: {
            shell: command.executable,
            args: command.args,
            shellBasename: path.basename(command.executable),
          },
          environment: desktopManagedTerminalEnvironmentFor(
            request.projectId,
            request.worktreeId,
            command,
          ),
          cols: request.cols,
          rows: request.rows,
          managed: {
            kind: command.kind,
            title: command.title,
            ...(command.focusOnSpawn !== undefined && {
              focusOnSpawn: command.focusOnSpawn,
            }),
            ...(command.chatId !== undefined && { chatId: command.chatId }),
            ...(command.sessionKey !== undefined && {
              sessionKey: command.sessionKey,
            }),
          },
        }),
    );
    routing.noteDaemonTerminalServed();
    return managed;
  } catch (error) {
    if (routing.noteDaemonTerminalFallback(error))
      return spawnManagedTerminal(request);
    throw error;
  }
}

/** Read-only receipt probe so callers can skip pre-write policy on a replay. */
export function hasTerminalWriteReceipt(
  terminalId: string,
  idempotencyKey: string,
): boolean {
  return terminalWriteReceipts.has(`${terminalId}:${idempotencyKey}`);
}

export function writeTerminal(
  request: TerminalWriteRequest & TerminalOperationScope,
): TerminalWriteDisposition {
  validateTerminalId(request.terminalId);
  validateTerminalOperationScope(request);
  if (request.idempotencyKey) {
    try {
      validateId(request.idempotencyKey, 'idempotencyKey');
    } catch (error) {
      throw new TerminalServiceError(
        'invalid_payload',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (Buffer.byteLength(request.data, 'utf8') > MAX_TERMINAL_WRITE_BYTES) {
    throw new TerminalServiceError(
      'invalid_payload',
      'Terminal write exceeds maximum data size',
    );
  }
  assertTerminalAuthorized(request.terminalId, request);
  const receiptKey = request.idempotencyKey
    ? `${request.terminalId}:${request.idempotencyKey}`
    : undefined;
  if (receiptKey && terminalWriteReceipts.has(receiptKey)) {
    return 'already_written';
  }
  workerTerminal.write(request.terminalId, request.data);
  if (receiptKey) {
    rememberTerminalWriteReceipt(receiptKey);
  }
  return 'written';
}

export function resizeTerminal(
  request: TerminalResizeRequest & TerminalOperationScope,
): void {
  validateTerminalId(request.terminalId);
  validateTerminalOperationScope(request);
  validateTerminalDimension(request.cols, 'cols');
  validateTerminalDimension(request.rows, 'rows');
  assertTerminalAuthorized(request.terminalId, request);
  workerTerminal.resize(request.terminalId, request.cols, request.rows);
}

export function closeTerminal(
  request: TerminalKillRequest & TerminalOperationScope,
): void {
  validateTerminalId(request.terminalId);
  validateTerminalOperationScope(request);
  assertTerminalAuthorized(request.terminalId, request);
  workerTerminal.kill(request.terminalId, {
    signal: TERMINAL_USER_CLOSE_SIGNAL,
  });
}

export function terminalSessionToRemoteControlEntity(
  session: TerminalSession,
  options: {
    includeBuffer?: boolean;
    running?: boolean;
    exited?: boolean;
  } = {},
): RemoteControlEntityEnvelope {
  const buffer = options.includeBuffer
    ? workerTerminal.replayText(session.id)
    : null;
  return {
    entityType: 'terminal_session',
    localId: session.id,
    parentLocalId: worktreeScopedParentLocalId(
      session.projectId,
      session.worktreeId,
    ),
    payload: {
      id: session.id,
      terminalLocalId: session.id,
      workspaceLocalId: session.projectId,
      worktreeLocalId: session.worktreeId,
      cwd: session.cwd,
      title: session.shellBasename,
      running: options.running ?? true,
      exited: options.exited ?? false,
      ...(buffer !== null ? { buffer } : {}),
    },
  };
}

export function listTerminalRemoteControlEntities(
  target?: RemoteControlTarget,
): RemoteControlEntityEnvelope[] {
  return workerTerminal
    .list()
    .filter((session) => sessionMatchesTarget(session, target))
    .map((session) =>
      terminalSessionToRemoteControlEntity(session, {
        includeBuffer: target?.terminalLocalId === session.id,
      }),
    );
}
