import { getDesktopNodeRuntime } from '../lib/node-runtime';
import { TRUSTED_NODE_POSIX_SCRUB } from '../lib/trusted-node-environment';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { connectAcp, type AcpClient } from '@canopy/desktop-shared/node/acp';
import {
  CURSOR_APPROVAL_CHECK_PROJECT_ID,
  type CursorApprovalCheckResult,
} from '@canopy/desktop-shared/types';
import { createApprovalSession } from '../approvals/approval-service';
import { terminateProcessTree } from '@canopy/desktop-shared/node/cursor/process-tree';
import {
  verifyCursorRuntimeVersion,
  type CursorProviderProcess,
} from '@canopy/desktop-shared/node/cursor/runtime-process';
import { spawnProviderProcess } from '../agent-runs/provider-process-host';
import { encodeCursorProjectDir } from '@canopy/desktop-shared/node/cursor/project-dir';
import type { CursorLaunch } from './runtime-installer';
import type { SendableBrowserWindow } from '../lib/window-send';
import { logMainProcessInfo } from '../lib/main-process-logging';
import {
  createCursorCheckHook,
  CURSOR_CHECK_CONTENT,
  CURSOR_CHECK_HOOK_SCRIPT,
  type CursorCheckHook,
} from './approval-check-hook';

// This opt-in development check relies on this binary's inspected hook layout.
export { CURSOR_RUNTIME_VERSION as CURSOR_HOOK_CHECK_VERSION } from '@canopy/desktop-shared/node/cursor/runtime-metadata';
import { CURSOR_RUNTIME_VERSION as CURSOR_HOOK_CHECK_VERSION } from '@canopy/desktop-shared/node/cursor/runtime-metadata';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function cursorEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'SHELL',
    'LANG',
  ]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.NO_OPEN_BROWSER = '1';
  return env;
}

export function verifyCursorVersion(
  providerProcess: CursorProviderProcess,
  launch: CursorLaunch,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<void> {
  return verifyCursorRuntimeVersion(
    providerProcess,
    launch,
    env,
    signal,
    CURSOR_HOOK_CHECK_VERSION,
    undefined,
    (diagnostic) => logMainProcessInfo('Cursor version check', diagnostic),
  );
}

/** Runs the bounded check through the real app approval service and ACP client. */
export async function runCursorApprovalCheck(options: {
  binaryPath: string;
  signal: AbortSignal;
  getWindow: () => SendableBrowserWindow | null;
}): Promise<CursorApprovalCheckResult> {
  let client: AcpClient | undefined;
  let hook: CursorCheckHook | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let sessionId: string | undefined;
  let childClosed: Promise<void> | undefined;
  let childExited = false;
  let closing: Promise<void> | undefined;
  let filePath: string | undefined;
  let profile: string | undefined;
  let hookDir: string | undefined;
  let result: CursorApprovalCheckResult = {
    outcome: 'error',
    hookObserved: false,
    processExited: true,
  };
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 120_000);

  function signalGroup(signal: NodeJS.Signals): void {
    terminateProcessTree(child?.pid, signal);
  }

  function closeChild(): Promise<void> {
    closing ??= (async (): Promise<void> => {
      if (!child) return;
      signalGroup('SIGTERM');
      // Escalate even if the parent exits before one of its hook/MCP children.
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 1500));
      signalGroup('SIGKILL');
      await childClosed;
    })();
    return closing;
  }

  function onAbort(): void {
    // Revoke first. ACP's cancelled stop reason does not stop a late hook allow.
    hook?.revoke();
    if (client && sessionId) void client.cancel(sessionId).catch(() => {});
    client?.close();
    void closeChild();
  }
  const onExternalAbort = (): void => abort.abort();
  options.signal.addEventListener('abort', onExternalAbort, { once: true });
  abort.signal.addEventListener('abort', onAbort, { once: true });
  if (options.signal.aborted) abort.abort();

  try {
    if (!isAbsolute(options.binaryPath) || process.platform !== 'darwin') {
      throw new Error('Select an absolute Cursor executable path on macOS.');
    }
    const env = cursorEnvironment();
    // This opt-in check is macOS-only (guarded above), so the launcher is
    // always the single `cursor-agent` executable.
    await verifyCursorVersion(
      {
        spawner: spawnProviderProcess,
        owner: {
          kind: 'discovery',
          id: `cursor-approval-check:${randomUUID()}`,
        },
      },
      { command: options.binaryPath, prefix: [] },
      env,
      abort.signal,
    );
    abort.signal.throwIfAborted();
    // Keep only the latest run's result file for inspection; earlier runs
    // would otherwise accumulate under the OS temp root indefinitely.
    const parent = join(tmpdir(), 'cursor-approval-check');
    await rm(parent, { recursive: true, force: true });
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(parent, 'run-'));
    const workspace = join(root, 'project');
    profile = join(root, 'profile');
    hookDir = join(root, 'hook');
    await Promise.all([mkdir(workspace), mkdir(profile), mkdir(hookDir)]);
    filePath = join(workspace, 'result.txt');
    const id = randomUUID();
    const approval = createApprovalSession({
      sessionKey: `cursor-check:${id}`,
      projectId: CURSOR_APPROVAL_CHECK_PROJECT_ID,
      worktreeId: id,
      chatId: id,
      provider: 'cursor',
      workspaceRoot: workspace,
      mode: 'ask',
      trackChatTurn: false,
      promptTimeoutMs: 60_000,
      // The hook capability admits only this fixture's preparatory Read.
      sessionRules: [
        {
          id: randomUUID(),
          behavior: 'allow',
          target: { kind: 'tool', toolName: 'Read' },
          createdAt: new Date().toISOString(),
          origin: 'settings',
        },
      ],
      getWindow: options.getWindow,
    });
    try {
      hook = await createCursorCheckHook(approval, filePath);
    } catch (error) {
      approval.dispose();
      throw error;
    }
    abort.signal.throwIfAborted();
    const script = join(hookDir, 'approval-hook.cjs');
    const connection = join(hookDir, 'connection.json');
    await Promise.all([
      writeFile(script, CURSOR_CHECK_HOOK_SCRIPT, { mode: 0o600 }),
      writeFile(
        connection,
        JSON.stringify({ url: hook.url, token: hook.token }),
        { mode: 0o600 },
      ),
    ]);
    const configDir = join(
      profile,
      'projects',
      encodeCursorProjectDir(workspace),
      '.cursor',
    );
    await mkdir(configDir, { recursive: true });
    const command = `${TRUSTED_NODE_POSIX_SCRUB}\nexec ${[
      (await getDesktopNodeRuntime()).nodeProcess.command,
      '--disable-sigusr1',
      script,
      connection,
    ]
      .map(shellQuote)
      .join(' ')}`;
    await writeFile(
      join(configDir, 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: { preToolUse: [{ command, failClosed: true, timeout: 75 }] },
      }),
      { mode: 0o600 },
    );
    abort.signal.throwIfAborted();
    child = spawn(
      options.binaryPath,
      ['--disable-auto-update', '--trust', 'acp'],
      {
        cwd: workspace,
        env: { ...env, CURSOR_DATA_DIR: profile },
        // This opt-in check refuses to run outside macOS, so the POSIX
        // process-group teardown always applies here.
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    child.stderr.resume();
    childClosed = new Promise<void>((resolveClosed) => {
      child?.once('error', () => {
        abort.abort();
      });
      child?.once('close', () => {
        childExited = true;
        resolveClosed();
      });
    });
    client = await connectAcp({
      transport: {
        input: Readable.toWeb(child.stdout),
        output: Writable.toWeb(child.stdin),
        close: (): void => {
          hook?.revoke();
          void closeChild();
        },
      },
      clientInfo: { name: 'cursor-approval-check', version: '1' },
      resourceGeneration: 1,
      onUpdate: (): void => {},
      // This bounded check offers only native Read/Write. Other ACP tools are denied.
      onPermission: (): Promise<'deny'> => Promise.resolve('deny'),
      timeouts: {
        initializeMs: 15_000,
        requestMs: 30_000,
        promptMs: 90_000,
        permissionMs: 5000,
        cancelMs: 1000,
      },
    });
    abort.signal.throwIfAborted();
    if (
      client
        .getInitialization()
        .authMethods?.some((method) => method.id === 'cursor_login')
    ) {
      await client.authenticate({ methodId: 'cursor_login' }, abort.signal);
    }
    const session = await client.newSession({ cwd: workspace, mcpServers: [] });
    sessionId = session.sessionId;
    abort.signal.throwIfAborted();
    await client.prompt(
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: `This is a local approval check in a disposable project. Use only your built-in Write or edit tool to create result.txt containing exactly ${CURSOR_CHECK_CONTENT.trim()}. Do not use shell, MCP, or any other files. If denied or cancelled, stop immediately without retrying or alternatives.`,
          },
        ],
      },
      1,
      abort.signal,
    );
    result.outcome = 'denied';
  } catch (error) {
    result = {
      ...result,
      outcome: options.signal.aborted ? 'cancelled' : 'error',
      message:
        error instanceof Error && error.message.startsWith('Cursor CLI ')
          ? error.message
          : 'The Cursor check could not complete. Check the executable and CLI sign-in, then try again.',
    };
  } finally {
    clearTimeout(deadline);
    hook?.revoke();
    client?.close();
    await closeChild();
    await hook?.close();
    options.signal.removeEventListener('abort', onExternalAbort);
    abort.signal.removeEventListener('abort', onAbort);
    const content = filePath
      ? await readFile(filePath, 'utf8').catch(() => undefined)
      : undefined;
    result.filePath = filePath;
    result.hookObserved = hook?.sawWrite() ?? false;
    result.processExited = !child || childExited;
    if (options.signal.aborted && content === undefined) {
      result.outcome = 'cancelled';
      delete result.message;
    } else if (content !== undefined) {
      result.outcome =
        hook?.writeDecision() === 'allow' &&
        result.hookObserved &&
        content.trim() === CURSOR_CHECK_CONTENT.trim()
          ? 'allowed'
          : 'error';
      if (result.outcome === 'error')
        result.message = 'The check detected an unexpected file write.';
      else delete result.message;
    } else if (
      result.outcome === 'denied' &&
      hook?.writeDecision() !== 'deny'
    ) {
      result.outcome = 'error';
      result.message = 'Cursor did not complete the expected file operation.';
    } else if (!result.hookObserved && result.outcome !== 'cancelled') {
      result.outcome = 'error';
      result.message ??=
        'Cursor did not reach the required write approval hook.';
    }
    await Promise.all([
      profile ? rm(profile, { recursive: true, force: true }) : undefined,
      hookDir ? rm(hookDir, { recursive: true, force: true }) : undefined,
    ]);
  }
  return result;
}
