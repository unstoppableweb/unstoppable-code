import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  CanopyOperationError,
  type PlatformOperatingSystem,
} from '@canopy/core-runtime';
import {
  GIT_BRANCH_TRACKING_CONFIG_PATTERN,
  GIT_EXACT_CATALOGUE_REF_ARGS,
  GitRepositoryWriteError,
  type GitChildEnvironment,
  type GitRepositoryWrite,
  type GitRepositoryWriteOutput,
  type GitRepositoryWritePort,
  type GitHubCredentialLeasePort,
} from '@canopy/core-runtime/node/git';
import {
  isHostAbsolute,
  nonInteractiveEnvironment,
  validateEnvironment,
  type GitReadEnvironment,
} from '../git-read/commands';
import { createChildServices } from '../supervision/child';
import { killProcessTree } from '../supervision/kill-tree';
import {
  NODE_SUPERVISION,
  type SupervisionOperations,
} from '../supervision/shared';

/** How one write-host command runs. */
export interface GitWritePlan {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: GitReadEnvironment;
  /** Only the single-branch fetch is bounded; effects never are. */
  readonly timeoutMs: number | undefined;
}

// desktop git.ts SHARED_CONTAINER_GIT_REMOTE_TIMEOUT_MS and runGit's maxBuffer.
const FETCH_TIMEOUT_MS = 10_000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

/**
 * The branch writes run only where their closure is audited: no Win32 hook,
 * fsmonitor or credential-helper closure has been shown for them (D10).
 */
const POSIX: ReadonlySet<PlatformOperatingSystem> = new Set([
  'darwin',
  'linux',
]);

const invalid = (): GitRepositoryWriteError =>
  new GitRepositoryWriteError('invalid_request');

/** A ref name or start point: never empty, an option, or NUL-bearing. */
function refValue(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.startsWith('-') ||
    value.includes('\0')
  )
    throw invalid();
  return value;
}

/** A full lowercase SHA-1 or SHA-256 object ID; never a revision expression. */
function objectId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
  )
    throw invalid();
  return value;
}

/**
 * The argv a {@link GitRepositoryWrite} runs, validated before any selection:
 * desktop's arguments, with Git's non-interactive switches added to the
 * supplied environment, as the read host adds them (D8). Every kind is POSIX
 * only (`unsupported_command` elsewhere).
 */
export function gitWriteCommandFor(
  os: PlatformOperatingSystem,
  write: unknown,
  environment: GitReadEnvironment,
): (executable: string) => GitWritePlan {
  const field = (key: string): unknown => Reflect.get(Object(write), key);
  const kind = field('kind');
  let args: readonly string[];
  let timeoutMs: number | undefined;
  switch (kind) {
    case 'head-sha':
      args = ['rev-parse', '--verify', 'HEAD'];
      break;
    case 'tracking-head-sha':
      args = [
        'rev-parse',
        '--verify',
        `refs/remotes/origin/${refValue(field('branch'))}`,
      ];
      break;
    case 'stage-all':
      args = ['add', '-A'];
      break;
    case 'commit-message': {
      const message = field('message');
      if (
        typeof message !== 'string' ||
        !message.trim() ||
        message.length > 100_000 ||
        message.includes('\0')
      )
        throw invalid();
      args = ['commit', '-m', message.trim()];
      break;
    }
    case 'push-head': {
      const key = field('key');
      if (typeof key !== 'string' || !key.trim() || key.includes('\0'))
        throw invalid();
      args = ['push', '-u', 'origin', 'HEAD'];
      break;
    }
    case 'status':
      args = ['status', '--porcelain', '--untracked-files=normal'];
      break;
    case 'local-branch':
      args = [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${refValue(field('branch'))}`,
      ];
      break;
    case 'remote-branch':
      args = [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/remotes/origin/${refValue(field('branch'))}`,
      ];
      break;
    case 'catalog-branch-tip':
      args = [
        'show-ref',
        '--verify',
        '--hash',
        `${field('remote') === true ? 'refs/remotes/origin/' : 'refs/heads/'}${refValue(field('branch'))}`,
      ];
      break;
    case 'branch-tracking-config':
      args = [
        'config',
        '--local',
        '--null',
        '--get-regexp',
        GIT_BRANCH_TRACKING_CONFIG_PATTERN,
      ];
      break;
    case 'fetch-origin-branch': {
      const branch = refValue(field('branch'));
      args = [
        'fetch',
        '--no-tags',
        'origin',
        `refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ];
      timeoutMs = FETCH_TIMEOUT_MS;
      break;
    }
    case 'check-branch-name':
      args = ['check-ref-format', '--branch', refValue(field('name'))];
      break;
    case 'local-branches-under':
      args = [
        'for-each-ref',
        '--format=%(refname)',
        `refs/heads/${refValue(field('name'))}/`,
      ];
      break;
    case 'current-branch':
      args = ['rev-parse', '--abbrev-ref', 'HEAD'];
      break;
    case 'symbolic-head':
      args = ['symbolic-ref', '--quiet', 'HEAD'];
      break;
    case 'checkout':
      args = ['switch', '--no-guess', '--', refValue(field('branch'))];
      break;
    case 'checkout-new-branch':
    case 'prepare-new-branch': {
      const startPoint = refValue(field('startPoint'));
      args = [
        ...(kind === 'checkout-new-branch'
          ? [
              ...(startPoint.startsWith('refs/')
                ? GIT_EXACT_CATALOGUE_REF_ARGS
                : []),
              'checkout',
              '-b',
            ]
          : [...GIT_EXACT_CATALOGUE_REF_ARGS, 'branch']),
        refValue(field('name')),
        startPoint,
        ...(kind === 'checkout-new-branch' && startPoint.startsWith('refs/')
          ? ['--']
          : []),
      ];
      break;
    }
    case 'rename-current-branch':
      args = ['branch', '-m', refValue(field('name'))];
      break;
    case 'delete-branch':
      args = ['branch', '-d', refValue(field('branch'))];
      break;
    case 'force-delete-branch':
      args = ['branch', '-D', refValue(field('branch'))];
      break;
    case 'delete-branch-ref':
      args = [
        'update-ref',
        '-d',
        `refs/heads/${refValue(field('branch'))}`,
        objectId(field('tip')),
      ];
      break;
    // CAN-5517: fetch and pull, unbounded like every effect (Q11).
    case 'fetch-origin': {
      const prune = field('prune');
      if (typeof prune !== 'boolean') throw invalid();
      args = prune ? ['fetch', '--prune', 'origin'] : ['fetch', 'origin'];
      break;
    }
    case 'pull-fast-forward':
      args = ['pull', '--ff-only', 'origin', refValue(field('branch'))];
      break;
    case 'pull-rebase':
      args = [
        'pull',
        '--rebase',
        '--autostash',
        'origin',
        refValue(field('branch')),
      ];
      break;
    case 'rebase-state-path': {
      const name = field('name');
      if (name !== 'rebase-merge' && name !== 'rebase-apply') throw invalid();
      args = ['rev-parse', '--git-path', name];
      break;
    }

    case 'worktree-add': {
      const path = field('path');
      const create = field('create');
      const startPoint = field('startPoint');
      if (
        typeof path !== 'string' ||
        !isHostAbsolute('linux', path) ||
        path.includes('\0') ||
        typeof create !== 'boolean'
      )
        throw invalid();
      args = [
        '-c',
        'core.hooksPath=/dev/null',
        ...(typeof startPoint === 'string' && startPoint.startsWith('refs/')
          ? GIT_EXACT_CATALOGUE_REF_ARGS
          : []),
        'worktree',
        'add',
        ...(create
          ? ['-b', refValue(field('branch')), path]
          : [path, refValue(field('branch'))]),
        ...(create && startPoint !== null ? [refValue(startPoint)] : []),
      ];
      break;
    }
    case 'worktree-remove': {
      const path = field('path');
      if (
        typeof path !== 'string' ||
        !isHostAbsolute('linux', path) ||
        path.includes('\0')
      )
        throw invalid();
      args = ['worktree', 'remove', '--force', path];
      break;
    }
    case 'worktree-prune':
      args = ['worktree', 'prune'];
      break;
    case 'merge-worktree-list':
      args = ['worktree', 'list', '--porcelain'];
      break;
    case 'merge-worktree-add':
    case 'merge-worktree-remove': {
      const path = field('path');
      if (typeof path !== 'string' || !isHostAbsolute('linux', path))
        throw invalid();
      args =
        kind === 'merge-worktree-add'
          ? ['worktree', 'add', path, refValue(field('branch'))]
          : ['worktree', 'remove', '--force', path];
      break;
    }
    case 'merge-local':
      args = ['merge', '--no-edit', refValue(field('branch'))];
      break;
    case 'merge-abort':
      args = ['merge', '--abort'];
      break;
    case 'merge-head':
      args = ['rev-parse', 'HEAD'];
      break;
    case 'stash-list':
      args = ['stash', 'list'];
      break;
    case 'porcelain-status':
      args = ['status', '--porcelain=v1'];
      break;
    default:
      throw invalid();
  }
  if (!POSIX.has(os)) throw new GitRepositoryWriteError('unsupported_command');
  const env = nonInteractiveEnvironment(environment);
  return (executable) => {
    if (typeof executable !== 'string' || !isHostAbsolute(os, executable))
      throw new GitRepositoryWriteError('git_unavailable');
    return Object.freeze({
      file: executable,
      args: Object.freeze([...args]),
      env,
      timeoutMs,
    });
  };
}

export interface GitWriteHostOptions {
  readonly os: PlatformOperatingSystem;
  /** Daemon-owned credential authority; no token is supplied by the peer. */
  readonly githubLeases?: GitHubCredentialLeasePort;
  /**
   * Daemon's own startup env after claim-marker removal. A request's own
   * forwarded environment replaces it for that command only (CAN-5496).
   */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /**
   * The absolute Git a command runs: the read host's selection, so a daemon
   * selects Git once. Aborted only when this host stops.
   */
  readonly selectExecutable: (signal: AbortSignal) => Promise<string>;
}

/** Private seams, reachable only by relative import (tests). */
export interface GitWriteHostSeams {
  readonly operations?: Partial<SupervisionOperations>;
  readonly fetchTimeoutMs?: number;
}

export interface GitWriteHost {
  /** The `worker.git` branch writes. Commands take no signal (Q11). */
  readonly port: GitRepositoryWritePort;
  /**
   * Refuses new commands and waits for started ones to end, killing none;
   * `cleanup_unconfirmed` if `signal` aborts first.
   */
  stop(
    this: void,
    signal: AbortSignal,
  ): Promise<{ readonly state: 'stopped' | 'cleanup_unconfirmed' }>;
}

/**
 * The startup snapshot, or a request's forwarded environment, copied without
 * undefined values; `null` when a child cannot hold it.
 */
function environmentOf(source: unknown): GitReadEnvironment | null {
  try {
    if (typeof source !== 'object' || source === null) return null;
    const copied: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source))
      if (value !== undefined) copied[key] = value;
    return validateEnvironment(copied);
  } catch {
    return null;
  }
}

function credentialRefusal(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'permission_denied',
    message: 'The Git credential lease was refused.',
    retry: { kind: 'never' },
  });
}

function hasForwardedCredential(environment: GitChildEnvironment): boolean {
  for (const [key, value] of Object.entries(environment)) {
    const name = key.toUpperCase();
    if (
      name === 'GH_TOKEN' ||
      name === 'GITHUB_TOKEN' ||
      name.includes('ASKPASS')
    )
      return true;
    if (
      name === 'GIT_CONFIG_PARAMETERS' ||
      name === 'GIT_CONFIG' ||
      name === 'GIT_CONFIG_GLOBAL' ||
      name === 'GIT_CONFIG_SYSTEM'
    )
      return true;
    if (
      /^GIT_CONFIG_KEY_\d+$/.test(name) &&
      value?.toLowerCase().startsWith('credential.')
    )
      return true;
  }
  return false;
}

/**
 * The daemon's Git write host for the `worker.git` branch writes: fixed POSIX
 * commands over the supplied environment, run to completion. A caller's abort
 * never reaches a child; only the bounded fetch is killed, at its timeout.
 */
export function createGitWriteHost(options: GitWriteHostOptions): GitWriteHost {
  return createGitWriteHostWith(options, {});
}

export function createGitWriteHostWith(
  options: GitWriteHostOptions,
  seams: GitWriteHostSeams,
): GitWriteHost {
  const { os } = options;
  const environment = environmentOf(options.environment);
  const childOptions = createChildServices(os).childProcessOptions({
    lifetime: 'owned',
  });
  const operations: SupervisionOperations = {
    ...NODE_SUPERVISION,
    ...seams.operations,
  };
  const stopping = new AbortController();
  let active = 0;
  const idleWaiters = new Set<() => void>();

  function begin(): () => void {
    active += 1;
    let ended = false;
    return (): void => {
      if (ended) return;
      ended = true;
      active -= 1;
      if (active === 0) idleWaiters.forEach((wake) => wake());
    };
  }

  function execute(
    plan: GitWritePlan,
    cwd: string,
  ): Promise<GitRepositoryWriteOutput> {
    return new Promise((resolve, reject) => {
      const end = begin();
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(plan.file, [...plan.args], {
          ...childOptions,
          cwd,
          env: plan.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        end();
        reject(new GitRepositoryWriteError('git_unavailable'));
        return;
      }
      const decoder = new StringDecoder('utf8');
      const chunks: string[] = [];
      let bytes = 0;
      // Output past the limit is dropped, never a reason to stop an effect.
      child.stdout?.on('data', (chunk: Buffer) => {
        if (bytes > MAX_STDOUT_BYTES) return;
        bytes += chunk.byteLength;
        if (bytes <= MAX_STDOUT_BYTES) chunks.push(decoder.write(chunk));
      });
      child.stdout?.on('error', () => undefined);
      child.stderr?.resume();
      child.stderr?.on('error', () => undefined);
      let timedOut = false;
      const timeoutMs =
        plan.timeoutMs === undefined
          ? undefined
          : (seams.fetchTimeoutMs ?? plan.timeoutMs);
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              const pid = child.pid;
              if (pid === undefined || child.exitCode !== null) return;
              timedOut = true;
              void killProcessTree(os, { pid, mode: 'force' }, operations)
                // The close event still settles the request.
                .catch(() => undefined);
            }, timeoutMs);
      child.once('error', () => {
        if (child.pid !== undefined) return;
        if (timer) clearTimeout(timer);
        end();
        reject(new GitRepositoryWriteError('git_unavailable'));
      });
      child.once('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        end();
        if (timedOut) {
          reject(new GitRepositoryWriteError('timeout'));
          return;
        }
        if (signal !== null || code === null) {
          reject(new GitRepositoryWriteError('exit_status'));
          return;
        }
        chunks.push(decoder.end());
        resolve({ exitCode: code, stdout: chunks.join('') });
      });
    });
  }

  async function run(
    write: GitRepositoryWrite,
    cwd: string,
    forwarded?: GitChildEnvironment,
  ): Promise<GitRepositoryWriteOutput> {
    if (stopping.signal.aborted) throw new GitRepositoryWriteError('stopped');
    // Validated per request and used for this command only; selection keeps
    // the snapshot (CAN-5496 D2).
    const commandEnvironment =
      forwarded === undefined ? environment : environmentOf(forwarded);
    if (
      commandEnvironment === null ||
      typeof cwd !== 'string' ||
      !isHostAbsolute(os, cwd)
    )
      throw invalid();
    const plan = gitWriteCommandFor(os, write, commandEnvironment);
    const end = begin();
    try {
      let executable: string;
      try {
        executable = await options.selectExecutable(stopping.signal);
      } catch {
        throw new GitRepositoryWriteError(
          stopping.signal.aborted ? 'stopped' : 'git_unavailable',
        );
      }
      if (stopping.signal.aborted) throw new GitRepositoryWriteError('stopped');
      if (write.kind !== 'push-head')
        return await execute(plan(executable), cwd);
      // K10: the recipient gets credentials only from the daemon authority.
      if (forwarded !== undefined && hasForwardedCredential(forwarded))
        throw credentialRefusal();
      const request = {
        purpose: 'git-push',
        audience: { operation: 'worker.git.push', key: write.key },
      } as const;
      const minted = await options.githubLeases?.mint({
        ...request,
        expiresAt: performance.now() + 30_000,
      });
      if (minted?.kind !== 'minted') throw credentialRefusal();
      try {
        const delivered = await minted.lease.deliver(request, (material) => {
          if (stopping.signal.aborted)
            return Promise.reject(new GitRepositoryWriteError('stopped'));
          const selected = plan(executable);
          // execute spawns synchronously, while serialized lease admission holds.
          return execute(
            {
              ...selected,
              env: {
                ...selected.env,
                GH_TOKEN: new TextDecoder().decode(material),
              },
            },
            cwd,
          );
        });
        if (delivered.kind !== 'delivered') throw credentialRefusal();
        return await delivered.value;
      } finally {
        minted.lease.revoke();
      }
    } finally {
      end();
    }
  }

  function stop(
    signal: AbortSignal,
  ): Promise<{ readonly state: 'stopped' | 'cleanup_unconfirmed' }> {
    stopping.abort(new GitRepositoryWriteError('stopped'));
    return new Promise((settle) => {
      if (active === 0) return settle({ state: 'stopped' });
      if (signal.aborted) return settle({ state: 'cleanup_unconfirmed' });
      const finish = (state: 'stopped' | 'cleanup_unconfirmed'): void => {
        idleWaiters.delete(wake);
        signal.removeEventListener('abort', abort);
        settle({ state });
      };
      const wake = (): void => finish('stopped');
      const abort = (): void => finish('cleanup_unconfirmed');
      idleWaiters.add(wake);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  return Object.freeze({ port: Object.freeze({ run }), stop });
}
