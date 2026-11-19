import { isSea } from 'node:sea';
import { dirname, join, resolve } from 'node:path';
import type { PlatformExecutionProcessServices } from '@canopy/core-runtime';
import {
  createOwnedProcessHostPort,
  type OwnedExecutionHostPort,
  type ExecutionHostShellCommand,
  type ExecutionHostShellEntries,
} from '@canopy/core-platform/execution-host';
import {
  DAEMON_BUNDLED_PIPELINES_DIRECTORY,
  DAEMON_EXECUTION_HOST_ENTRIES,
} from '@canopy/core-platform/execution-host/daemon-payload';

/** The daemon's staged host entries; a source checkout uses the host build's. */
export function daemonExecutionHostEntries(): ExecutionHostShellEntries {
  return {
    directory: isSea()
      ? join(dirname(process.execPath), 'execution-hosts')
      : resolve(
          dirname(process.argv[1] ?? ''),
          '../../..',
          'dist/core-daemon/execution-hosts',
        ),
    names: DAEMON_EXECUTION_HOST_ENTRIES,
  };
}

/** The code-graph runtime `build:core-daemon` stages beside the executable. */
export function daemonCodeGraphResourcesDir(): string {
  return isSea()
    ? join(dirname(process.execPath), 'resources', 'code-graph')
    : resolve(
        dirname(process.argv[1] ?? ''),
        '../../..',
        'dist/core-daemon/resources/code-graph',
      );
}

/**
 * Relaunches this daemon executable in its execution host entry mode: the
 * single executable takes the shell arguments directly, and a source run
 * repeats its loader options and entry script.
 */
export function daemonExecutionHostShell(): ExecutionHostShellCommand {
  return isSea()
    ? { executable: process.execPath, args: [] }
    : {
        executable: process.execPath,
        args: [...process.execArgv, process.argv[1] ?? ''],
      };
}

/**
 * The pipeline host's Codex MCP launcher (CAN-5095 D18): the command that
 * relaunches this daemon, which serves the launcher mode first (CAN-4117 D4).
 */
export function daemonCodexMcpLauncher(shell?: ExecutionHostShellCommand): {
  readonly command: string;
  readonly args: readonly string[];
} {
  const { executable, args } = shell ?? daemonExecutionHostShell();
  return { command: executable, args };
}

export interface DaemonExecutionHostPortOptions {
  readonly services: PlatformExecutionProcessServices;
  /** Working directory for hosts, fully qualified. */
  readonly cwd: string;
  readonly environment: () => Readonly<Record<string, string | undefined>>;
  readonly diagnostics?: (
    stream: 'stdout' | 'stderr',
    bytes: Uint8Array,
  ) => void;
  /** Relaunches this daemon by default; a test supplies its own shell runner. */
  readonly shell?: ExecutionHostShellCommand;
}

/**
 * The daemon's execution host port: each host is this executable relaunched
 * in its entry mode, in its own owned process tree, under the budget its
 * launch names. Launches without a budget are refused. The composition calls
 * its `shutdown` before stopping the services, so hosts close their writers.
 */
export function createDaemonExecutionHostPort(
  options: DaemonExecutionHostPortOptions,
): OwnedExecutionHostPort {
  return createOwnedProcessHostPort({
    services: options.services,
    shell: options.shell ?? daemonExecutionHostShell(),
    cwd: options.cwd,
    environment: options.environment,
    ...(options.diagnostics && { diagnostics: options.diagnostics }),
  });
}

/**
 * The bundled pipeline definitions `build:core-daemon` stages beside the
 * executable (CAN-5092); a source run reads the host build's copy.
 */
export function daemonBundledPipelinesDir(): string {
  return isSea()
    ? join(dirname(process.execPath), ...DAEMON_BUNDLED_PIPELINES_DIRECTORY)
    : resolve(
        dirname(process.argv[1] ?? ''),
        '../../..',
        'dist/core-daemon',
        ...DAEMON_BUNDLED_PIPELINES_DIRECTORY,
      );
}
