import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createChildServices,
  hostPlatformOperatingSystem,
} from '@canopy/core-platform';
import { buildScriptShellCommand } from '@canopy/core-runtime/node/script/execution';
import {
  RUN_WITH_SECRETS_DEFAULT_TIMEOUT_MS,
  type RunWithSecretsInput,
  type RunWithSecretsResult,
} from '@canopy/agent-actions';
import { getEnhancedEnv } from '@canopy/execution-engine/pipelines/config-paths';
import { findExecutableOnPath } from '@canopy/execution-engine/node/lib/path-lookup';
import { buildCmdCommandLine } from '@canopy/execution-engine/node/lib/windows-process';
import { killChildProcessGroup } from '../lib/process-kill';
import { resolveWindowsGitBash } from '../lib/windows-git-bash';
import {
  ChatSecretValuesUnreadableError,
  getChatSecretStore,
  SecretFileValuesLostError,
  SecretFileValuesUnavailableError,
} from './chat-secret-store';
import { registerRunningSecretCommand } from './running-commands';
import {
  isAgentSecretRequestsEnabled,
  isRunWithSecretsSupported,
} from './feature-gate';
import {
  RedactedOutput,
  RUN_WITH_SECRETS_OUTPUT_WITHHELD_UNREADABLE,
} from './redacted-output';
import {
  AgentSecretToolError,
  approveSecretUse,
  missingSecretNames,
  redeemChatSecrets,
  resolveCommandDirectory,
  resolveToolRoot,
  type AgentSecretToolCallOptions,
  type AgentSecretToolHost,
} from './secret-tool-host';

/*
 * RunWithSecrets on desktop (CONTRACTS.md §2–§5). The command runs in the
 * person's login shell in the chat's worktree, with the named secrets only
 * in its environment (and optionally its stdin). The values come from one
 * single-use execution-secret grant. Both output streams pass through the
 * agent secret redactor, covering every value the chat holds, before any
 * text leaves this module, so the model, the transcript and logs only see
 * `[secret:NAME]`.
 */

/** How long a stopped command gets to exit before it is killed outright. */
const KILL_GRACE_MS = 2_000;

/**
 * How long after the kill a call waits for its output to close. A process
 * that left the group can hold the pipes open; past this the call settles
 * and lets go of them.
 */
const SETTLE_GRACE_MS = 1_000;

export class SecretToolUnavailableError extends Error {
  constructor() {
    super('Secret requests are unavailable in this session.');
    this.name = 'SecretToolUnavailableError';
  }
}

/** SHA-256 of a command, for the metadata-only audit log. */
export function commandDigest(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}

export async function runWithSecrets(
  host: AgentSecretToolHost,
  input: RunWithSecretsInput,
  options: AgentSecretToolCallOptions = {},
): Promise<RunWithSecretsResult> {
  if (!isAgentSecretRequestsEnabled() || !isRunWithSecretsSupported())
    throw new SecretToolUnavailableError();
  const store = getChatSecretStore();
  const names = [
    ...new Set([
      ...Object.values(input.env),
      ...(input.stdin ? [input.stdin] : []),
    ]),
  ].sort();
  const missing = await missingSecretNames(host.scope, names);
  if (missing.length)
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      redactions: 0,
      missing,
    };
  // The chat's Stop ends the call from here on, whatever signal its
  // provider passes: before approval, between the read and the spawn, and
  // while the command runs.
  const stopped = new AbortController();
  const unregister = registerRunningSecretCommand(host.scope, () =>
    stopped.abort(),
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, stopped.signal])
    : stopped.signal;
  try {
    const root = await resolveToolRoot(host.root);
    const cwd = await resolveCommandDirectory(root, input.cwd);
    await approveSecretUse(
      host,
      {
        kind: 'agent-secret-use',
        tool: 'RunWithSecrets',
        command: input.command,
        ...(input.cwd && input.cwd !== '.' ? { cwd: input.cwd } : {}),
        secretNames: names,
      },
      { ...options, signal },
    );
    if (!isAgentSecretRequestsEnabled()) throw new SecretToolUnavailableError();
    // Every value the chat holds or held before (revoked or replaced,
    // CONTRACTS.md §4a), and every value written to a secrets file in its
    // worktree, is redacted, not only the ones passed in: a command can reach
    // those through a file or an earlier command's output. A value that
    // can't be read back stops the call.
    let chatGroups: Array<Record<string, string>>;
    try {
      chatGroups = store.redactionGroups(host.scope, { strict: true, root });
    } catch (error) {
      if (error instanceof SecretFileValuesLostError)
        throw new AgentSecretToolError(
          "A secrets file in this worktree holds values that were lost, so they can't be hidden and no command runs with secrets here. Remove that file, or write it again with WriteSecretsFile mode replace.",
        );
      if (error instanceof SecretFileValuesUnavailableError)
        throw new AgentSecretToolError(
          "A secrets file in this worktree holds values that can't be read back to hide them, so no command runs with secrets here. Remove that file: seven days later its values are forgotten and commands run again.",
        );
      if (error instanceof ChatSecretValuesUnreadableError)
        throw new AgentSecretToolError(
          "A secret given in this worktree can't be read back to hide it, so no command runs with secrets here until it expires, seven days after it was given.",
        );
      throw error;
    }
    const values = await redeemChatSecrets(host.scope, names, signal);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(getEnhancedEnv()))
      if (value !== undefined) env[key] = value;
    for (const [variable, name] of Object.entries(input.env)) {
      const value = values.get(name);
      if (value === undefined)
        throw new AgentSecretToolError(
          "This chat's secrets couldn't be read. Ask for them again with RequestSecrets.",
        );
      env[variable] = value;
    }
    const stdinValue = input.stdin ? values.get(input.stdin) : undefined;
    await store.audit({
      event: 'used',
      scope: host.scope,
      names,
      tool: 'RunWithSecrets',
      commandDigest: commandDigest(input.command),
    });
    if (signal.aborted)
      throw new AgentSecretToolError('The call was stopped before it ran.');
    return await execute({
      command: input.command,
      cwd,
      env,
      ...(stdinValue !== undefined ? { stdin: stdinValue } : {}),
      timeoutMs: input.timeoutMs ?? RUN_WITH_SECRETS_DEFAULT_TIMEOUT_MS,
      redactionGroups: [Object.fromEntries(values), ...chatGroups],
      currentGroups: () =>
        store.redactionGroups(host.scope, { strict: true, root }),
      signal,
    });
  } finally {
    unregister();
  }
}

/**
 * The values in `current` that `initial` didn't have: ones the chat came to
 * hold while a command ran.
 */
function freshGroups(
  initial: ReadonlyArray<Readonly<Record<string, string>>>,
  current: ReadonlyArray<Readonly<Record<string, string>>>,
): Array<Record<string, string>> {
  const known = new Set(initial.flatMap((group) => Object.values(group)));
  return current
    .map((group) =>
      Object.fromEntries(
        Object.entries(group).filter(([, value]) => !known.has(value)),
      ),
    )
    .filter((group) => Object.keys(group).length > 0);
}

/** Runs one shell command; resolves once it and its output have ended. */
export function execute(request: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  redactionGroups: ReadonlyArray<Readonly<Record<string, string>>>;
  /**
   * The chat's values when the command ends. A value given while it ran,
   * which it can't have received but can echo from elsewhere, is redacted
   * from its output too. Throws when one can't be read back, and then no
   * output is returned.
   */
  currentGroups?: () => ReadonlyArray<Readonly<Record<string, string>>>;
  signal?: AbortSignal;
}): Promise<RunWithSecretsResult> {
  const shell = buildScriptShellCommand(
    {
      platform: () => hostPlatformOperatingSystem(),
      findExecutable: (name) => findExecutableOnPath(name),
      windowsGitBash: () => resolveWindowsGitBash(),
      cmdCommandLine: (scriptPath) => buildCmdCommandLine(scriptPath),
      loginShell: () => process.env.SHELL,
      comSpec: () => process.env.ComSpec,
    },
    request.command,
    undefined,
    { interactive: false },
  );
  const stdout = new RedactedOutput(request.redactionGroups);
  const stderr = new RedactedOutput(request.redactionGroups);
  return new Promise<RunWithSecretsResult>((resolve) => {
    let timedOut = false;
    let settled = false;
    const child = spawn(shell.command, shell.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // An owned child: on POSIX it leads its own process group, so a stop
      // reaches everything it started.
      ...createChildServices(hostPlatformOperatingSystem()).childProcessOptions(
        { lifetime: 'owned' },
      ),
    });
    let stopping = false;
    // Ends everything the command started: its own process group. The kill
    // follows even after the pipes close, since a child can ignore SIGTERM
    // and let go of them. It also runs when the command finishes, so nothing
    // it left in the background keeps the secrets in its environment. A
    // process that deliberately leaves the group (setsid, a daemon that
    // double-forks) keeps what it was given, as a command that writes the
    // value to a file does: the person approved giving the value to this
    // command, and this covers the background children it leaves behind,
    // not one that hides from it.
    let exited: {
      code: number | null;
      signal: NodeJS.Signals | null;
    } | null = null;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      killChildProcessGroup(child, 'SIGTERM');
      setTimeout(
        () => killChildProcessGroup(child, 'SIGKILL'),
        KILL_GRACE_MS,
      ).unref();
      // A process outside the group can hold the pipes open: settle anyway,
      // and let go of them.
      setTimeout(() => {
        if (settled) return;
        child.stdout.destroy();
        child.stderr.destroy();
        finish(exited?.code ?? null, exited?.signal ?? null);
      }, KILL_GRACE_MS + SETTLE_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, request.timeoutMs);
    const onAbort = (): void => stop();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) stop();
    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      error?: string,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      stop();
      shell.cleanup?.();
      const errorText = error ? `${error}\n` : '';
      let fresh: Array<Record<string, string>> = [];
      let unreadable = false;
      try {
        if (request.currentGroups)
          fresh = freshGroups(request.redactionGroups, request.currentGroups());
      } catch {
        unreadable = true;
      }
      const out = stdout.finish(fresh);
      const err = stderr.finish(fresh);
      resolve({
        exitCode: timedOut ? null : exitCode,
        ...(signal ? { signal } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        stdout: unreadable ? RUN_WITH_SECRETS_OUTPUT_WITHHELD_UNREADABLE : out,
        stderr: unreadable
          ? RUN_WITH_SECRETS_OUTPUT_WITHHELD_UNREADABLE
          : errorText + err,
        redactions: stdout.redactions + stderr.redactions,
      });
    };
    child.stdout.on('data', (chunk: Buffer) => stdout.write(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.write(chunk));
    child.on('error', () =>
      finish(null, null, "The command's shell couldn't start."),
    );
    // When the shell ends, so does everything it left in its group; the
    // output then closes.
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      stop();
    });
    child.on('close', (code, signal) => finish(code, signal));
    // A command that never reads stdin closes the pipe first.
    child.stdin.on('error', () => undefined);
    if (request.stdin !== undefined) child.stdin.end(request.stdin);
    else child.stdin.end();
  });
}
