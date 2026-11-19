import {
  CanopyOperationError,
  defineRuntimeModule,
  type RuntimeModule,
} from '@canopy/core-runtime';
import {
  filesystemSnapshotFailure,
  isFilesystemSnapshotUnavailable,
  readFilesystemScope,
  type FilesystemScopeResolver,
} from '@canopy/core-runtime/node';
import {
  createWorkerTerminalHandlers,
  TerminalHostSupervisor,
  type TerminalHostProcess,
} from '@canopy/core-runtime/node/terminal/host';
import type {
  ExecutionHostBudget,
  OwnedExecutionHostPort,
} from '@canopy/core-platform/execution-host';
import {
  WORKER_TERMINAL_INSTRUCTION_DEFINITIONS,
  WORKER_TERMINAL_QUERY_DEFINITIONS,
  WORKER_TERMINAL_SESSION_INSTRUCTION_DEFINITIONS,
  WORKER_TERMINAL_STREAM_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import { DAEMON_TERMINAL_HOST_ENTRY } from '@canopy/core-platform/execution-host/daemon-payload';
import {
  accountExecutionHost,
  type DaemonExecutionAccounting,
} from './execution';

/**
 * The terminal host's limits. Terminal output lives in replay windows of at
 * most 1 MiB for at most 48 terminals, so these leave wide headroom; a host
 * past them is stopped and its terminals reported lost.
 */
export const DAEMON_TERMINAL_HOST_BUDGET: ExecutionHostBudget = {
  heapMb: 768,
  rssMb: 1536,
};

/** Every `worker.terminal.*` operation the daemon serves (CAN-5088). */
export const DAEMON_TERMINAL_DEFINITIONS = {
  queries: WORKER_TERMINAL_QUERY_DEFINITIONS,
  instructions: {
    ...WORKER_TERMINAL_INSTRUCTION_DEFINITIONS,
    ...WORKER_TERMINAL_SESSION_INSTRUCTION_DEFINITIONS,
  },
  streams: WORKER_TERMINAL_STREAM_DEFINITIONS,
};

export interface DaemonTerminalOptions {
  /** Launches budgeted execution hosts: the daemon relaunched in entry mode. */
  readonly hosts: OwnedExecutionHostPort;
  /** Stops what the hosts ran on, after they stopped. */
  readonly shutdown?: () => Promise<void>;
  /** Resolves the selected scope and its trusted owner on every request. */
  readonly resolveScope: FilesystemScopeResolver;
  /**
   * The daemon's execution accounting: the terminal host holds a `terminal`
   * lease and a registration of its process tree while it runs (CAN-5690).
   */
  readonly accounting?: DaemonExecutionAccounting;
  /** Observes each terminal host that ended under its terminals. */
  readonly onHostLost?: (report: {
    readonly code: number;
    readonly lost: number;
  }) => void;
}

function rootNotFound(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    code: 'worker.terminal.notFound',
    message: 'The terminal directory is not in this scope.',
    retry: { kind: 'never' },
  });
}

/**
 * `worker.terminal.*` over a supervised terminal host process (CAN-5088).
 * The host is this daemon relaunched in its execution host entry mode, in
 * its own owned process tree under {@link DAEMON_TERMINAL_HOST_BUDGET}; it
 * starts with the first terminal and again after it ends. The module's
 * service stops it in phase 5, killing every terminal first: terminals hold
 * no keep-alive obligation (D4), so they end with the daemon.
 */
export function createDaemonTerminalModule(
  options: DaemonTerminalOptions,
): RuntimeModule {
  const supervisor = new TerminalHostSupervisor({
    launch: (): TerminalHostProcess =>
      accountExecutionHost(
        options.accounting,
        options.hosts.launch({
          entry: DAEMON_TERMINAL_HOST_ENTRY,
          serviceName: 'Terminal host',
          budget: DAEMON_TERMINAL_HOST_BUDGET,
        }),
        {
          family: 'terminal',
          label: 'Terminal host',
          groupId: 'terminal',
          kind: 'terminal',
        },
      ),
    killProcessGroup: (pid): void => {
      // The PTY leads its own process group; its pid alone when that is gone.
      for (const target of [-pid, pid])
        try {
          process.kill(target, 'SIGKILL');
          return;
        } catch {
          // Already gone, or not ours to signal: try the next form.
        }
    },
    onHostExit: ({ code, lost, expected }): void => {
      if (!expected && lost.length > 0)
        options.onHostLost?.({ code, lost: lost.length });
    },
  });
  const handlers = createWorkerTerminalHandlers({
    supervisor,
    resolveRoot: async (scope, rootId) => {
      let root;
      try {
        const catalog = await readFilesystemScope(
          scope,
          await options.resolveScope(scope, 'roots'),
          'roots',
        );
        root = catalog.byId.get(rootId);
      } catch (error) {
        // A catalog the system refused to read is not a missing directory.
        if (isFilesystemSnapshotUnavailable(error))
          throw filesystemSnapshotFailure(error);
        throw rootNotFound();
      }
      if (!root || root.kind === 'attachments') throw rootNotFound();
      return root.absolutePath;
    },
  });
  return defineRuntimeModule({
    name: 'worker.terminal',
    plane: 'worker',
    services: [
      {
        name: 'worker.terminal.host',
        plane: 'worker',
        stop: {
          5: async (): Promise<void> => {
            await supervisor.stop();
            await options.hosts.shutdown();
            await options.shutdown?.();
          },
        },
      },
    ],
    definitions: DAEMON_TERMINAL_DEFINITIONS,
    handlers,
  });
}
