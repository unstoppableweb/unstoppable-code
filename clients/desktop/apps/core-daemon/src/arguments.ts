import type { CanopyRuntimeMode } from '@canopy/protocol';

export interface CanopyDaemonArguments {
  readonly dataRoot: string;
  readonly runtimeMode: CanopyRuntimeMode;
  readonly migrationChannel?: boolean;
  /** Private one-use pre-serving maintenance invocation, never an activation switch. */
  readonly w5Recovery?: string;
  /**
   * A W5 qualification's `--w5-host v1`; no product launcher passes it yet.
   * Every build honors it except on Windows (CAN-5529).
   */
  readonly w5Host?: true;
  /**
   * A qualification's `--split-worker v1` (CAN-5073): the worker plane runs
   * in a supervised `--profile worker` child. No product launcher passes it;
   * POSIX only until CAN-5091.
   */
  readonly splitWorker?: true;
}

export interface ParsedCanopyDaemonArguments extends CanopyDaemonArguments {
  /** A Windows qualifier's `--closure-receipt v1`; no product launcher passes it. */
  readonly closureReceipt?: boolean;
  /** A qualifier's `--git-receipt v1`, on any OS; no product launcher passes it. */
  readonly gitReceipt?: boolean;
  /**
   * `--profile worker`: this process is a split daemon's supervised worker,
   * started by its core with a private stdin handoff, never by a launcher.
   */
  readonly profile?: 'worker';
}

export class CanopyDaemonUsageError extends Error {}

const RUNTIME_MODES: readonly string[] = ['prod', 'rc', 'dev'];
const FLAGS: readonly string[] = [
  '--data-root',
  '--runtime-mode',
  '--closure-receipt',
  '--git-receipt',
  '--w5-host',
  '--w5-recovery',
  '--split-worker',
  '--profile',
];
const FLAG_NAME = /^--[a-z][a-z-]{0,31}$/;

function isRuntimeMode(value: string): value is CanopyRuntimeMode {
  return RUNTIME_MODES.includes(value);
}

/** A qualifier receipt flag: absent, or exactly `v1`. */
function requestsReceipt(
  values: ReadonlyMap<string, string>,
  name: string,
): boolean {
  const value = values.get(name);
  if (value !== undefined && value !== 'v1')
    throw new CanopyDaemonUsageError(`${name} must be v1.`);
  return value !== undefined;
}

/**
 * Accepts exactly the launcher's switches (`--data-root <path> --runtime-mode
 * <mode>`), each once. The daemon never infers a root or mode; publication
 * verifies the root is absolute and canonical. A qualification harness may
 * add `--closure-receipt v1`, `--git-receipt v1`, `--w5-host v1` and
 * `--split-worker v1`, and a split core starts its worker with `--profile
 * worker`; the usage text leaves them out.
 */
export function parseCanopyDaemonArguments(
  argv: readonly string[],
): ParsedCanopyDaemonArguments {
  const values = new Map<string, string>();
  let migrationChannel = false;
  for (let index = 0; index < argv.length; ) {
    if (argv[index] === '--migration-channel') {
      if (migrationChannel)
        throw new CanopyDaemonUsageError(
          '--migration-channel may appear only once.',
        );
      migrationChannel = true;
      index += 1;
      continue;
    }
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || !FLAGS.includes(name))
      throw new CanopyDaemonUsageError(
        // Echo only flag-shaped tokens; a stray path or value stays off stderr.
        FLAG_NAME.test(name ?? '')
          ? `Unknown argument: ${name}`
          : 'Unknown argument.',
      );
    if (values.has(name))
      throw new CanopyDaemonUsageError(`${name} may appear only once.`);
    if (value === undefined || value === '' || value.startsWith('--'))
      throw new CanopyDaemonUsageError(`${name} requires a value.`);
    values.set(name, value);
    index += 2;
  }
  const dataRoot = values.get('--data-root');
  const runtimeMode = values.get('--runtime-mode');
  if (dataRoot === undefined)
    throw new CanopyDaemonUsageError('--data-root is required.');
  if (runtimeMode === undefined || !isRuntimeMode(runtimeMode))
    throw new CanopyDaemonUsageError(
      '--runtime-mode must be prod, rc, or dev.',
    );
  const closureReceipt = requestsReceipt(values, '--closure-receipt');
  const gitReceipt = requestsReceipt(values, '--git-receipt');
  const w5Host = requestsReceipt(values, '--w5-host');
  const splitWorker = requestsReceipt(values, '--split-worker');
  const profile = values.get('--profile');
  const w5Recovery = values.get('--w5-recovery');
  if (w5Recovery !== undefined && !/^[a-f0-9]{24}$/.test(w5Recovery))
    throw new CanopyDaemonUsageError(
      '--w5-recovery requires a private invocation id.',
    );
  if (
    w5Recovery &&
    (migrationChannel ||
      closureReceipt ||
      gitReceipt ||
      w5Host ||
      splitWorker ||
      profile)
  )
    throw new CanopyDaemonUsageError(
      '--w5-recovery cannot combine with other modes.',
    );
  if (profile !== undefined && profile !== 'worker')
    throw new CanopyDaemonUsageError('--profile must be worker.');
  const qualified =
    migrationChannel || closureReceipt || gitReceipt || w5Host || splitWorker;
  if (profile !== undefined && qualified)
    throw new CanopyDaemonUsageError('--profile worker takes no other flags.');
  if (splitWorker && (w5Host || gitReceipt))
    throw new CanopyDaemonUsageError(
      '--split-worker cannot combine with --w5-host or --git-receipt.',
    );
  return {
    dataRoot,
    runtimeMode,
    ...(migrationChannel && { migrationChannel: true }),
    ...(w5Recovery && { w5Recovery }),
    ...(closureReceipt && { closureReceipt }),
    ...(gitReceipt && { gitReceipt }),
    ...(w5Host && { w5Host: true }),
    ...(splitWorker && { splitWorker: true }),
    ...(profile !== undefined && { profile }),
  };
}
