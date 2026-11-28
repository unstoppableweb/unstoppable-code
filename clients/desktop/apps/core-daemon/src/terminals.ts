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
import { TRUNCATION_MARKER_BYTES } from '@canopy/core-runtime/node/terminal';
import {
  createWorkerTerminalHandlers,
  TerminalHostSupervisor,
  type TerminalHostProcess,
} from '@canopy/core-runtime/node/terminal/host';
import {
  TerminalRecordAuthority,
  TerminalRecordRepository,
  terminalRecordDir,
  terminalRecordProjectDir,
  validateTerminalRecordOp,
  type TerminalRecordRegistration,
} from '@canopy/core-runtime/node/terminal/record';
import type {
  ExecutionHostBudget,
  OwnedExecutionHostPort,
} from '@canopy/core-platform/execution-host';
import {
  WORKER_TERMINAL_INSTRUCTION_DEFINITIONS,
  WORKER_TERMINAL_QUERY_DEFINITIONS,
  WORKER_TERMINAL_RECORD_INSTRUCTION_DEFINITIONS,
  WORKER_TERMINAL_RECORD_LIFECYCLE_INSTRUCTION_DEFINITIONS,
  WORKER_TERMINAL_RECORD_QUERY_DEFINITIONS,
  WORKER_TERMINAL_RECORD_WATERMARK_KEY_MAX_LENGTH,
  WORKER_TERMINAL_SCHEMA_REVISIONS,
  WORKER_TERMINAL_EVENTS_STREAM_DEFINITIONS,
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

/**
 * Every `worker.terminal.*` operation the daemon serves (CAN-5088), with
 * the worktree terminal record (CAN-7051) and the events stream (CAN-8038).
 */
export const DAEMON_TERMINAL_DEFINITIONS = {
  queries: {
    ...WORKER_TERMINAL_QUERY_DEFINITIONS,
    ...WORKER_TERMINAL_RECORD_QUERY_DEFINITIONS,
  },
  instructions: {
    ...WORKER_TERMINAL_INSTRUCTION_DEFINITIONS,
    ...WORKER_TERMINAL_SESSION_INSTRUCTION_DEFINITIONS,
    ...WORKER_TERMINAL_RECORD_LIFECYCLE_INSTRUCTION_DEFINITIONS,
    ...WORKER_TERMINAL_RECORD_INSTRUCTION_DEFINITIONS,
  },
  streams: {
    ...WORKER_TERMINAL_STREAM_DEFINITIONS,
    ...WORKER_TERMINAL_EVENTS_STREAM_DEFINITIONS,
  },
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
  /** The daemon's data root, which holds `terminal-records/` (CAN-7051). */
  readonly dataRoot: string;
  /** The host's directory flush after each record install. */
  readonly flushDirectorySync: (directory: string) => void;
  readonly log?: (message: string, details: Record<string, unknown>) => void;
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
  // The one writer of every worktree terminal record (CAN-7051): in this
  // module, never in the PTY host, which only reports.
  const authority = new TerminalRecordAuthority({
    repository: new TerminalRecordRepository({
      dataRoot: options.dataRoot,
      flushDirectorySync: options.flushDirectorySync,
      ...(options.log && { log: options.log }),
    }),
    ...(options.log && { log: options.log }),
  });
  const outputProgress = new Map<
    TerminalRecordRegistration,
    { nextOffset: number }
  >();
  let recordWritesFenced = false;
  let fenceExitFailed = false;
  // Even history reads can retry attribution and schedule installs. Only the
  // lifecycle's final flush and disposal may bypass this admission fence.
  const activeRecord = (): TerminalRecordAuthority | null =>
    recordWritesFenced ? null : authority;
  const unsubscribeReports = supervisor.onReport((report, registration) => {
    if (report.type !== 'output') return;
    const record = activeRecord();
    if (!record || registration === undefined) return;
    const progress = outputProgress.get(registration);
    if (!progress) return;
    const fromOffset = report.toOffset - report.data.byteLength;
    if (fromOffset !== progress.nextOffset)
      record.output(registration, TRUNCATION_MARKER_BYTES);
    progress.nextOffset = report.toOffset;
    record.output(registration, report.data);
  });
  const recordExit = (
    registration: TerminalRecordRegistration,
    exitCode: number | null,
    signal: string | null,
    confirmedOffset?: number,
  ): void => {
    const progress = outputProgress.get(registration);
    if (!progress) return;
    // Only the host's own PTY exit confirms its final offset; it reports every
    // byte before that exit. Any other end may have lost output.
    if (confirmedOffset === undefined || confirmedOffset > progress.nextOffset)
      authority.output(registration, TRUNCATION_MARKER_BYTES);
    outputProgress.delete(registration);
    authority.exited(registration, exitCode, signal);
  };
  const unsubscribeExit = supervisor.onEvent((event, registration) => {
    if (event.type !== 'exit') return;
    const record = activeRecord();
    if (!record || registration === undefined) return;
    recordExit(registration, event.exitCode, event.signal, event.outputOffset);
  });
  const fenceRecordWrites = (): void => {
    if (recordWritesFenced) return;
    recordWritesFenced = true;
    // No later host exit can reach the record after this admission fence.
    for (const {
      registration,
      exitCode,
      signal,
    } of supervisor.pendingRecordExits()) {
      if (!outputProgress.has(registration)) continue;
      try {
        recordExit(registration, exitCode, signal);
      } catch {
        // Finish fencing every lifetime; phase 6 reports the durability failure.
        fenceExitFailed = true;
      }
    }
    unsubscribeReports();
    unsubscribeExit();
    outputProgress.clear();
  };
  const validateTarget = (target: {
    projectId: string;
    worktreeId?: string;
  }): void => {
    if (target.worktreeId === undefined)
      terminalRecordProjectDir(options.dataRoot, target.projectId);
    else
      terminalRecordDir(options.dataRoot, target.projectId, target.worktreeId);
  };
  const terminalHandlers = createWorkerTerminalHandlers({
    supervisor,
    record: {
      attribute: (attribution): TerminalRecordRegistration | undefined =>
        activeRecord()?.attribute(attribution),
      restoreHistoryTail: (
        client,
        terminalId,
        maxChars,
      ): { scrollback: string; signal: string | null } | null =>
        activeRecord()?.restoreHistoryTail(client, terminalId, maxChars) ??
        null,
    },
    validateRecordTarget: validateTarget,
    onOutputStart: (_terminal, fromOffset, registration): void => {
      if (!activeRecord()) return;
      outputProgress.set(registration, { nextOffset: fromOffset });
    },
    ...(options.log && { log: options.log }),
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
  // Record failures are the caller's to retry: an `apply` outcome is then
  // unknown, and its producer keeps the batch.
  const recorded = <T>(run: () => T): Promise<T> => {
    try {
      return Promise.resolve(run());
    } catch (error) {
      if (error instanceof CanopyOperationError) return Promise.reject(error);
      options.log?.('Terminal record operation failed', {
        name: error instanceof Error ? error.name : 'error',
      });
      return Promise.reject(
        new CanopyOperationError({
          kind: 'unavailable',
          message: 'The terminal record is unavailable.',
          retry: { kind: 'same_request', delayMs: 1_000 },
        }),
      );
    }
  };
  const recordOperation = <T>(
    run: (record: TerminalRecordAuthority) => T,
  ): Promise<T> =>
    recorded(() => {
      const record = activeRecord();
      if (!record)
        throw new CanopyOperationError({
          kind: 'unavailable',
          message: 'The terminal record is unavailable.',
          retry: { kind: 'same_request', delayMs: 1_000 },
        });
      return run(record);
    });
  // Only deliberate, side-effect-free input checks are permanent failures.
  // Authority execution may already have published: retain same-request retry.
  const preflight = <T>(
    validate: () => void,
    run: (record: TerminalRecordAuthority) => T,
  ): Promise<T> => {
    try {
      validate();
    } catch {
      return Promise.reject(
        new CanopyOperationError({
          kind: 'invalid_argument',
          message:
            "Couldn't use this terminal record request. Check its IDs and layout keys.",
          retry: { kind: 'never' },
        }),
      );
    }
    return recordOperation(run);
  };
  return defineRuntimeModule({
    name: 'worker.terminal',
    plane: 'worker',
    services: [
      {
        name: 'worker.terminal.host',
        plane: 'worker',
        stop: {
          5: async (signal): Promise<void> => {
            // A phase timeout advances shutdown without awaiting this hook.
            // Fence synchronously on abort, before flush can release ownership.
            signal.addEventListener('abort', fenceRecordWrites, { once: true });
            if (signal.aborted) fenceRecordWrites();
            try {
              await supervisor.stop(signal);
            } finally {
              fenceRecordWrites();
              signal.removeEventListener('abort', fenceRecordWrites);
            }
            await options.hosts.shutdown();
            await options.shutdown?.();
          },
        },
      },
      {
        // Phase 5 drained the host or fenced reports at its deadline.
        // Install every accepted report, even when host drain was unconfirmed.
        name: 'worker.terminal.record',
        plane: 'worker',
        stop: {
          6: (): Promise<void> => {
            fenceRecordWrites();
            return recorded(() => {
              authority.finalFlushSync();
              if (fenceExitFailed)
                throw new Error('Terminal record shutdown exits failed.');
            });
          },
          // A failed final flush must not leave background publication retries.
          7: (): void => {
            fenceRecordWrites();
            authority.dispose();
          },
        },
      },
    ],
    definitions: DAEMON_TERMINAL_DEFINITIONS,
    handlers: {
      queries: {
        ...terminalHandlers.queries,
        'worker.terminal.record.history.read': (params) =>
          preflight(
            () => validateTarget(params.client),
            (record) => record.historyRead(params),
          ),
      },
      instructions: {
        ...terminalHandlers.instructions,
        'worker.terminal.record.open': (params) =>
          preflight(
            () => validateTarget(params.client),
            (record) => record.open(params.client),
          ),
        'worker.terminal.record.apply': (params) =>
          preflight(
            () => {
              validateTarget(params.client);
              const component = (value: string): string =>
                value.replace(/%/g, '%25').replace(/\//g, '%2F');
              const producer = `${component(params.producer.id)}/${component(params.producer.runId)}`;
              if (
                producer.length >
                WORKER_TERMINAL_RECORD_WATERMARK_KEY_MAX_LENGTH
              )
                throw new Error(
                  'The terminal producer watermark key is too long.',
                );
              for (const op of params.ops)
                validateTerminalRecordOp(op, params.client);
            },
            (record) => record.apply(params),
          ),
        'worker.terminal.record.shutdown': (params) =>
          recordOperation((record) => record.shutdown(params.signal)),
        'worker.terminal.record.retire': (params) =>
          preflight(
            () => {
              validateTarget(params);
              for (const worktreeId of params.worktreeIds ?? [])
                validateTarget({ projectId: params.projectId, worktreeId });
            },
            (record) => record.retire(params),
          ),
      },
      streams: terminalHandlers.streams,
    },
    schemaRevisions: WORKER_TERMINAL_SCHEMA_REVISIONS,
  });
}
