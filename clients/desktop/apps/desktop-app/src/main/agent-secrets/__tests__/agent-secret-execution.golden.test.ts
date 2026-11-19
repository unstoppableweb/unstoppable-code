import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WRITE_SECRETS_FILE_WARNING } from '@canopy/agent-actions';
import { isAgentDelegationTranscript } from '@canopy/protocol/delegation';
import { evaluateApproval } from '@canopy/desktop-shared/lib/approval-engine';
import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type ApprovalCheck,
  type FileContentResponse,
  type FilePreviewResponse,
} from '@canopy/desktop-shared/types';
import type * as ResolveWorktree from '../../lib/resolve-worktree';
import type * as ViewerRoot from '../../shared-containers/read/viewer-root';
import type * as SharedReader from '../../shared-containers/read/reader';

type Handler = (event: unknown, request: unknown) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));
jest.mock('electron', () => ({
  nativeImage: { createThumbnailFromPath: jest.fn() },
  shell: { openExternal: jest.fn(), showItemInFolder: jest.fn() },
}));
jest.mock('../../lib/file-browser-roots', () => ({
  getFileBrowserRoots: jest.fn(),
}));
jest.mock('../../lib/resolve-worktree', () => {
  const actual = jest.requireActual<typeof ResolveWorktree>(
    '../../lib/resolve-worktree',
  );
  return {
    ...actual,
    resolveWorktreeCwd: jest.fn(
      (...args: Parameters<typeof actual.resolveWorktreeCwd>) =>
        actual.resolveWorktreeCwd(...args),
    ),
  };
});
jest.mock('../../shared-containers/read/viewer-root', () => {
  const actual = jest.requireActual<typeof ViewerRoot>(
    '../../shared-containers/read/viewer-root',
  );
  return {
    ...actual,
    readSharedContainerViewerFile: jest.fn(
      actual.readSharedContainerViewerFile,
    ),
    resolveSharedContainerViewerReadRoots: jest.fn(
      actual.resolveSharedContainerViewerReadRoots,
    ),
  };
});
jest.mock('../../shared-containers/read/reader', () => {
  const actual = jest.requireActual<typeof SharedReader>(
    '../../shared-containers/read/reader',
  );
  return {
    ...actual,
    getSharedContainerReader: jest.fn(actual.getSharedContainerReader),
  };
});
jest.mock('../../lib/git-executable', () => ({
  getResolvedGitExecutableForSpawn: jest.fn(() => Promise.resolve('git')),
}));

jest.mock('../feature-gate', () => ({
  isAgentSecretRequestsEnabled: jest.fn(() => true),
  isRunWithSecretsSupported: jest.fn(() => true),
}));
jest.mock('../../approvals/approval-session-registry', () => ({
  requestChatApproval: jest.fn(),
}));
jest.mock('@canopy/execution-engine/pipelines/config-paths', () => ({
  ...jest.requireActual<object>(
    '@canopy/execution-engine/pipelines/config-paths',
  ),
  getEnhancedEnv: (): Record<string, string | undefined> => ({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  }),
}));

import { requestChatApproval } from '../../approvals/approval-session-registry';
import { executeCanopyInjectedTool } from '../../canopy-tools/core';
import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import { resetDesktopExecutionSecretsForTests } from '../../execution-secrets/owner';
import {
  CHAT_SECRET_TTL_MS,
  ChatSecretStore,
  setChatSecretStoreForTests,
  type ChatSecretScope,
} from '../chat-secret-store';
import { agentSecretUseTools } from '../secret-tool-runtime';
import { isRunWithSecretsSupported } from '../feature-gate';
import { stopRunningSecretCommands } from '../running-commands';
import { SecretValueRedactor } from '@canopy/protocol/agent-secrets';
import { MergedSecretRedactor } from '../merged-redactor';
import {
  SECRET_FILE_READ_REDIRECT,
  secretFileReadRedirect,
} from '../secret-files';
import {
  SECRET_VIEW_HIDDEN_NOTICE,
  SecretViewHiddenError,
  redactSecretView,
  secretSafeView,
  secretViewFileHoldsSecrets,
  SecretViewUnavailableError,
  type SecretView,
} from '../view-redaction';
import {
  resetWriteSecretsFileApprovalsForTests,
  secretsFileWriteQueue,
} from '../write-secrets-file';
import { ChatSecretStorageBackstop } from '../storage-redaction';
import { quoteDotenvValue, secretsFileText } from '../secrets-file-format';
import { writePrivateFileAtomically } from '../private-file';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';
import { registerFilePreviewHandlers } from '../../ipc/file-preview';
import { getFileBrowserRoots } from '../../lib/file-browser-roots';
import {
  readPortalFilePreview,
  savePortalFile,
} from '../../services/files-service';
import { readDiff } from '../../services/diff-service';
import {
  readSharedContainerViewerFile,
  resolveSharedContainerViewerReadRoots,
} from '../../shared-containers/read/viewer-root';
import {
  getSharedContainerReader,
  type SharedContainerReader,
} from '../../shared-containers/read/reader';
import { resolveWorktreeCwd } from '../../lib/resolve-worktree';
import { SECRET_STORE_DAMAGED_MESSAGE } from '../secret-tool-host';
import { McpHttpProxyService } from '../../mcp/http-proxy-service';
import { canopyRouteFixtures } from '../../mcp/__tests__/helpers/canopy-route-fixtures';
import {
  applyClaudeTranscriptEvent,
  applyCodexTranscriptEvent,
  createEmptyTranscriptReducerState,
  readChildToolLivenessStamp,
} from '@canopy/agent-transcript';
import { isTerminalRuntimeChatEvent } from '@canopy/agent-transcript/portal/runtime-chat-projection';
import { isCanopyAuthFailureEventData } from '@canopy/protocol/auth-recovery';
import {
  isAiCreditsNoBillingSourceEventData,
  isAiCreditsRoutingStatusEventData,
  isAiCreditsUsageLimitEventData,
  isNoBillingSourceErrorEventData,
  isSetAutoArchiveRequestedEventData,
} from '@canopy/desktop-shared/types';
import {
  getChatTurnAuditStatus,
  isCodexSubagentFollowupEvent,
  isCodexSubagentTerminalEvent,
  isPlanHandoffResult,
  isRootTerminalChatEventData,
  isTerminalChatEventData,
  isUserAbortResult,
  readCodexRootThreadId,
  readCodexRootTurnId,
} from '../../lib/chat-turn-audit';
import {
  DELEGATION_SNAPSHOT,
  DELEGATION_TRANSCRIPT,
  refusedCensus,
  refusedProjection,
  type Fields,
} from '../refused-projection';

/*
 * Agent secret requests on desktop (U2b-1, U2b-2): RunWithSecrets and
 * WriteSecretsFile hand a chat's secrets to a command's environment or stdin,
 * or to a 0600 file kept out of git, only after the chat's approval policy
 * allows it, and nothing they return carries a value the chat holds, held
 * before (CONTRACTS.md §4a) or wrote to a secrets file.
 */

const CANARY = 'canary-7f3e1b29-secret-value';
const SHORT_CANARY = 'cnr5x';
const OTHER_CANARY = 'canary-it\'s-a-"quoted"-value';
const REPLACED_CANARY = 'canary-replaced-0d41-old-value';
const scope: ChatSecretScope = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

let dir: string;
let root: string;
let store: ChatSecretStore;

function forms(canary: string): string[] {
  const bytes = Buffer.from(canary, 'utf8');
  return [
    canary,
    bytes.toString('base64'),
    bytes.toString('base64').replace(/=+$/, ''),
    bytes.toString('base64url'),
    bytes.toString('hex'),
    bytes.toString('hex').toUpperCase(),
    encodeURIComponent(canary),
  ];
}

function expectNoCanary(text: string): void {
  for (const canary of [CANARY, SHORT_CANARY, OTHER_CANARY, REPLACED_CANARY])
    for (const form of forms(canary)) expect(text).not.toContain(form);
}

/** Whether {@link secretSafeView} withholds `view`. */
async function viewWithheld(view: SecretView): Promise<boolean> {
  try {
    await secretSafeView(view);
    return false;
  } catch (error) {
    if (error instanceof SecretViewHiddenError) return true;
    throw error;
  }
}

/** Whether a whole text holds a recorded value, as a diff side would. */
function textHolds(text: string): Promise<boolean> {
  return viewWithheld({
    kind: 'diff',
    oldValue: text,
    newValue: '',
    truncated: false,
  });
}

/** A cut preview as Canopy shows it. */
async function cutView(text: string): Promise<string> {
  return (await secretSafeView({ kind: 'text', text, cut: true })).text;
}

/** A reversible stand-in for safe storage: no plaintext reaches the file. */
const xorEncryption = {
  available: (): boolean => true,
  encrypt: (text: string): Buffer =>
    Buffer.from(Buffer.from(text, 'utf8').map((byte): number => byte ^ 0x5a)),
  decrypt: (ciphertext: Buffer): string =>
    Buffer.from(ciphertext.map((byte): number => byte ^ 0x5a)).toString('utf8'),
};

function storeAt(
  name: string,
  options: {
    now?: () => number;
    encryption?: typeof xorEncryption;
  } = {},
): ChatSecretStore {
  return new ChatSecretStore({
    filePath: (): string => join(dir, name, 'chat-secrets.json'),
    auditFilePath: (): string => join(dir, name, 'audit.jsonl'),
    encryption: options.encryption ?? xorEncryption,
    ...(options.now ? { now: options.now } : {}),
  });
}

const stopTurn = jest.fn();

function runtime(
  chat: ChatSecretScope = scope,
  signal?: AbortSignal,
): CanopyInjectedToolRuntime {
  // Only the member this tool uses; the rest are never reached.
  const tools = agentSecretUseTools({
    scope: chat,
    root,
    agentName: 'Claude',
    stopTurn,
  });
  if (signal) {
    const run = tools.runWithSecrets;
    const write = tools.writeSecretsFile;
    tools.runWithSecrets = (input, options): ReturnType<typeof run> =>
      run(input, { ...options, signal });
    tools.writeSecretsFile = (input, options): ReturnType<typeof write> =>
      write(input, { ...options, signal });
  }
  const partial: Pick<
    CanopyInjectedToolRuntime,
    'runWithSecrets' | 'writeSecretsFile'
  > = tools;
  return partial as CanopyInjectedToolRuntime;
}

async function call(
  key: 'run_with_secrets' | 'write_secrets_file',
  args: unknown,
  chat: ChatSecretScope = scope,
  signal?: AbortSignal,
): Promise<{ text: string; isError?: boolean }> {
  return executeCanopyInjectedTool(key, args, runtime(chat, signal), {
    toolUseId: 'tool-1',
  });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

/** Whether `pid` is a zombie: dead, waiting for its parent to reap it. */
function zombie(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch {
    return false;
  }
}

/**
 * True once `pid` is gone, polling up to `ms`. A killed child is reaped late
 * under load, and a zombie has already ended, so it counts as gone.
 */
async function exited(pid: number, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (zombie(pid)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address: AddressInfo | string | null = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return typeof address === 'object' && address ? address.port : 0;
}

/** The command's stdout, from a RunWithSecrets result. */
function stdout(result: { text: string }): string {
  const parsed = JSON.parse(result.text) as { stdout: string };
  return parsed.stdout;
}

/** A Portal read of `relativePath` in `folder`, as the file root `repo`. */
async function readPortalFilePreviewOf(
  folder: string,
  relativePath: string,
): Promise<{ content: string }> {
  const fileRoot = {
    repoId: 'repo',
    repoName: 'repo',
    absolutePath: folder,
    rootKind: 'git-repo' as const,
    gitAware: true,
    excludedDescendantRoots: [],
  };
  jest.mocked(getFileBrowserRoots).mockResolvedValue({
    roots: [fileRoot],
    rootMap: new Map([['repo', fileRoot]]),
  });
  return readPortalFilePreview({
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    fileRootLocalId: 'repo',
    relativePath,
  });
}

beforeEach(async () => {
  jest.clearAllMocks();
  resetWriteSecretsFileApprovalsForTests();
  resetDesktopExecutionSecretsForTests();
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'agent-secret-use-'));
  root = join(dir, 'worktree');
  mkdirSync(root);
  git(root, 'init', '-q');
  store = storeAt('store');
  setChatSecretStoreForTests(store);
  await store.put(scope, {
    API_TOKEN: CANARY,
    PIN: SHORT_CANARY,
    QUOTED: OTHER_CANARY,
  });
  // The person is asked (Ask mode) and allows.
  jest.mocked(requestChatApproval).mockImplementation((...args) => {
    args[4].onAwaitingUser?.();
    return Promise.resolve({ decision: 'allow' });
  });
});

afterEach(() => {
  setChatSecretStoreForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('RunWithSecrets', () => {
  it('passes secrets only through the environment and stdin, and redacts every echo', async () => {
    const result = await call('run_with_secrets', {
      // The command names variables, never values. It prints them raw,
      // base64- and hex-encoded, and proves the stdin secret arrived.
      command:
        'printf "%s\\n" "$TOKEN" "$PIN_CODE"; printf %s "$TOKEN" | base64; printf %s "$TOKEN" | od -An -tx1 | tr -d " \\n"; echo; read -r line; printf "stdin:%s\\n" "$line"; printf "len:%s\\n" "${#TOKEN}" >&2',
      env: { TOKEN: 'API_TOKEN', PIN_CODE: 'PIN' },
      stdin: 'API_TOKEN',
    });
    expect(result.isError).toBeFalsy();
    const parsed: unknown = JSON.parse(result.text);
    expect(parsed).toMatchObject({ exitCode: 0 });
    expect(result.text).toContain('[secret:API_TOKEN]');
    expect(result.text).toContain('[secret:PIN]');
    expect(result.text).toContain('stdin:[secret:API_TOKEN]');
    expect(result.text).toContain(`len:${CANARY.length}`);
    expectNoCanary(result.text);
    const view = JSON.parse(result.text) as { redactions: number };
    expect(view.redactions).toBeGreaterThanOrEqual(4);

    // The approval names the command and the secrets, never a value.
    expect(requestChatApproval).toHaveBeenCalledTimes(1);
    const [first] = jest.mocked(requestChatApproval).mock.calls;
    if (!first) throw new Error('No approval was requested.');
    const [, , , check, display] = first;
    expect(check).toEqual({
      kind: 'agent-secret-use',
      tool: 'RunWithSecrets',
      secretNames: ['API_TOKEN', 'PIN'],
    });
    expect(display.details).toMatchObject({
      kind: 'agent-secret-use',
      secretNames: ['API_TOKEN', 'PIN'],
    });
    expectNoCanary(JSON.stringify([check, display]));

    // The audit records names, the tool and a digest of the command.
    const audit = readFileSync(join(dir, 'store', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"event":"used"');
    expect(audit).toContain('"tool":"RunWithSecrets"');
    expect(audit).toMatch(/"commandDigest":"[0-9a-f]{64}"/);
    expect(audit).not.toContain('printf');
    expectNoCanary(audit);
  });

  it('runs nothing and reports names the chat does not hold', async () => {
    const marker = join(root, 'ran');
    const result = await call('run_with_secrets', {
      command: `touch ${JSON.stringify(marker)}`,
      env: { TOKEN: 'API_TOKEN', DB: 'DATABASE_URL' },
    });
    expect(JSON.parse(result.text)).toEqual({
      exitCode: null,
      stdout: '',
      stderr: '',
      redactions: 0,
      missing: ['DATABASE_URL'],
    });
    expect(existsSync(marker)).toBe(false);
    expect(requestChatApproval).not.toHaveBeenCalled();
  });

  it('ends the turn when the person picks Deny and stop', async () => {
    jest
      .mocked(requestChatApproval)
      .mockResolvedValue({ decision: 'deny', stopTurn: true });
    const result = await call('run_with_secrets', {
      command: 'true',
      env: { TOKEN: 'API_TOKEN' },
    });
    expect(result.isError).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopTurn).toHaveBeenCalledTimes(1);
  });

  it('runs nothing when the person denies it', async () => {
    jest
      .mocked(requestChatApproval)
      .mockResolvedValue({ decision: 'deny', message: 'Not now' });
    const marker = join(root, 'ran');
    const result = await call('run_with_secrets', {
      command: `touch ${JSON.stringify(marker)}`,
      env: { TOKEN: 'API_TOKEN' },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('denied');
    expect(existsSync(marker)).toBe(false);
  });

  it('stops the whole process tree at the timeout', async () => {
    const pidFile = join(root, 'child.pid');
    const result = await call('run_with_secrets', {
      command: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`,
      env: { TOKEN: 'API_TOKEN' },
      timeoutMs: 1000,
    });
    const parsed = JSON.parse(result.text) as {
      exitCode: number | null;
      timedOut?: boolean;
    };
    expect(parsed.exitCode).toBeNull();
    expect(parsed.timedOut).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    // The grandchild got the group's signal too.
    await expect(exited(pid)).resolves.toBe(true);
  }, 15_000);

  it('ends what the shell left in the background when it exits', async () => {
    const pidFile = join(root, 'background.pid');
    const started = Date.now();
    const result = await call('run_with_secrets', {
      // The shell exits at once; its background child holds the pipes.
      command: `sleep 20 & echo $! > ${JSON.stringify(pidFile)}`,
      env: { TOKEN: 'API_TOKEN' },
      timeoutMs: 30_000,
    });
    expect(JSON.parse(result.text)).toMatchObject({ exitCode: 0 });
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    await expect(exited(pid)).resolves.toBe(true);
  }, 15_000);

  it('settles even when a process that left the group holds the output open', async () => {
    const pidFile = join(root, 'escaped.pid');
    // A detached child gets its own session (setsid) and keeps stdout.
    const escape = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(require('child_process').spawn('sleep', ['30'], { detached: true, stdio: 'inherit' }).pid))`,
    )}`;
    const started = Date.now();
    let escapedPid = 0;
    try {
      const result = await call('run_with_secrets', {
        command: `${escape}; sleep 30`,
        env: { TOKEN: 'API_TOKEN' },
        timeoutMs: 1_000,
      });
      escapedPid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(JSON.parse(result.text)).toMatchObject({ timedOut: true });
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      if (escapedPid > 0)
        try {
          process.kill(escapedPid, 'SIGKILL');
        } catch {
          // Already gone.
        }
    }
  }, 15_000);

  it('kills a child that ignores the stop signal, after the grace period', async () => {
    const pidFile = join(root, 'stubborn.pid');
    const result = await call('run_with_secrets', {
      command: `bash -c 'trap "" TERM; sleep 30' > /dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}; wait`,
      env: { TOKEN: 'API_TOKEN' },
      timeoutMs: 1000,
    });
    expect(JSON.parse(result.text)).toMatchObject({ timedOut: true });
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    // SIGKILL follows two seconds after the ignored SIGTERM.
    await expect(exited(pid, 8_000)).resolves.toBe(true);
  }, 20_000);

  it('runs nothing when the chat is stopped while the person decides', async () => {
    const marker = join(root, 'ran');
    jest.mocked(requestChatApproval).mockImplementation(() => {
      stopRunningSecretCommands(scope);
      return Promise.resolve({ decision: 'allow' });
    });
    const result = await call('run_with_secrets', {
      command: `touch ${JSON.stringify(marker)}`,
      env: { TOKEN: 'API_TOKEN' },
    });
    expect(result.isError).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("ends with the chat's Stop", async () => {
    const started = Date.now();
    const running = call('run_with_secrets', {
      command: 'sleep 30',
      env: { TOKEN: 'API_TOKEN' },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    stopRunningSecretCommands(scope);
    expect(JSON.parse((await running).text)).toMatchObject({ exitCode: null });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it('masks a value the chat came to hold while the command ran', async () => {
    const late = 'canary-late-value-9c1e';
    writeFileSync(join(root, 'late.txt'), `${late}\n`);
    const running = call('run_with_secrets', {
      command: 'sleep 1; cat late.txt',
      env: { TOKEN: 'API_TOKEN' },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await store.put(scope, { LATE: late });
    const result = await running;
    expect(stdout(result)).toBe('[secret:LATE]\n');
    expect(JSON.parse(result.text)).toMatchObject({ redactions: 1 });
  }, 15_000);

  it('matches a late value against the original output: one that extends a held value, or crosses the cut', async () => {
    const extended = `${CANARY}-extended-77`;
    const crossing = 'canary-crossing-cut-5d2f';
    writeFileSync(join(root, 'extended.txt'), `${extended}\n`);
    writeFileSync(join(root, 'crossing.txt'), crossing);
    const running = call('run_with_secrets', {
      // stdout: the extended value. stderr: a value placed across the cut
      // that keeps its first and last 15,000 characters.
      command:
        "sleep 1; cat extended.txt; { head -c 14990 /dev/zero | tr '\\0' x; cat crossing.txt; head -c 20000 /dev/zero | tr '\\0' y; } >&2",
      env: { TOKEN: 'API_TOKEN' },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await store.put(scope, { EXTENDED: extended, CROSSING: crossing });
    const result = await running;
    const parsed = JSON.parse(result.text) as {
      stdout: string;
      stderr: string;
      redactions: number;
    };
    expect(parsed.stdout).toBe('[secret:EXTENDED]\n');
    expect(parsed.stdout).not.toContain('-extended-77');
    // The value crossing the cut is replaced before the cut, so no piece
    // of it is kept either side.
    expect(parsed.redactions).toBe(2);
    for (const piece of [crossing.slice(0, 6), crossing.slice(-6)])
      expect(parsed.stderr).not.toContain(piece);
  }, 15_000);

  it("withholds all output when a value given meanwhile can't be read back", async () => {
    const late = 'canary-late-unreadable-41b';
    writeFileSync(join(root, 'late.txt'), `${late}\n`);
    const blind = storeAt('late-blind', {
      encryption: {
        ...xorEncryption,
        decrypt: (ciphertext): string => {
          const text = xorEncryption.decrypt(ciphertext);
          if (text === late) throw new Error('wrong key');
          return text;
        },
      },
    });
    setChatSecretStoreForTests(blind);
    await blind.put(scope, { API_TOKEN: CANARY });
    const running = call('run_with_secrets', {
      command: 'sleep 1; cat late.txt; cat late.txt >&2',
      env: { TOKEN: 'API_TOKEN' },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await blind.put(scope, { LATE: late });
    const result = await running;
    const parsed = JSON.parse(result.text) as {
      stdout: string;
      stderr: string;
    };
    expect(parsed.stdout).toContain('Output withheld');
    expect(parsed.stderr).toContain('Output withheld');
    expect(result.text).not.toContain(late);
  }, 15_000);

  it('withholds output too long to check again when the secrets changed', async () => {
    const running = call('run_with_secrets', {
      command: "sleep 1; head -c 1100000 /dev/zero | tr '\\0' z",
      env: { TOKEN: 'API_TOKEN' },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await store.put(scope, { LATE: 'canary-late-long-output' });
    expect(stdout(await running)).toContain('Output withheld');
  }, 15_000);

  it.each([
    ['RunWithSecrets', 'ran'],
    ['WriteSecretsFile', '.env.disconnect'],
  ] as const)(
    '%s does nothing when the agent disconnects while the person decides',
    async (tool, output) => {
      const service = new McpHttpProxyService();
      await service.ensureStarted(await freePort());
      try {
        const base = canopyRouteFixtures().find(
          (route) => route.sessionKey === 'k-native-sdk-full',
        );
        if (!base) throw new Error('No main-server route fixture.');
        const route = {
          ...base,
          sessionKey: 'k-secret-run',
          projectId: scope.projectId,
          worktreeId: scope.worktreeId,
          chatId: scope.chatId,
          providerType: 'claude' as const,
          secretRequests: true,
          cwd: root,
        };
        await service.registerCanopyWorktreeSessionRoute(route);
        let approvalSignal: AbortSignal | undefined;
        const asked = new Promise<void>((resolveAsked) => {
          jest.mocked(requestChatApproval).mockImplementation((...args) => {
            approvalSignal = args[4].signal;
            resolveAsked();
            // The person never answers; only the call's signal ends the wait.
            return new Promise((resolve) =>
              args[4].signal?.addEventListener(
                'abort',
                () => resolve({ decision: 'deny' }),
                { once: true },
              ),
            );
          });
        });
        const marker = join(root, output);
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: {
            name: tool,
            arguments:
              tool === 'RunWithSecrets'
                ? {
                    command: `touch ${JSON.stringify(marker)}`,
                    env: { TOKEN: 'API_TOKEN' },
                  }
                : {
                    path: output,
                    format: 'dotenv',
                    entries: { API_TOKEN: 'API_TOKEN' },
                  },
          },
        });
        const req = request(service.getCanopyWorktreeMcpUrl(route.sessionKey), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${route.authToken}`,
            'content-length': Buffer.byteLength(body),
          },
        });
        req.on('error', () => undefined);
        req.end(body);
        await asked;
        // The agent goes away while the card waits.
        req.destroy();
        await new Promise<void>((resolve) => {
          if (approvalSignal?.aborted) resolve();
          else
            approvalSignal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
        });
        expect(approvalSignal?.aborted).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(existsSync(marker)).toBe(false);
      } finally {
        await service.shutdown();
      }
    },
    15_000,
  );

  it('keeps cwd inside the worktree', async () => {
    mkdirSync(join(root, 'sub'));
    const outside = mkdtempSync(join(dir, 'outside-'));
    symlinkSync(outside, join(root, 'escape'));
    const inside = await call('run_with_secrets', {
      command: 'pwd',
      env: { TOKEN: 'API_TOKEN' },
      cwd: 'sub',
    });
    expect(JSON.parse(inside.text)).toMatchObject({
      stdout: `${join(realpathSync(root), 'sub')}\n`,
    });
    const escaped = await call('run_with_secrets', {
      command: 'pwd',
      env: { TOKEN: 'API_TOKEN' },
      cwd: 'escape',
    });
    expect(escaped.isError).toBe(true);
    expect(escaped.text).toContain('outside this worktree');
    const dotted = await call('run_with_secrets', {
      command: 'pwd',
      env: { TOKEN: 'API_TOKEN' },
      cwd: '../x',
    });
    expect(dotted.isError).toBe(true);
  });
});

describe('revoked and replaced values (CONTRACTS.md §4a)', () => {
  it('masks a replaced value an old file still holds, and never runs it', async () => {
    await store.put(scope, { API_TOKEN: REPLACED_CANARY });
    // An earlier command wrote the value the chat held then into a file.
    await call('run_with_secrets', {
      command: 'printf "API_TOKEN=%s\\n" "$TOKEN" > .env.old',
      env: { TOKEN: 'API_TOKEN' },
    });
    expect(readFileSync(join(root, '.env.old'), 'utf8')).toBe(
      `API_TOKEN=${REPLACED_CANARY}\n`,
    );
    // The person replaces it.
    await store.put(scope, { API_TOKEN: CANARY });
    const result = await call('run_with_secrets', {
      command:
        'cat .env.old; [ "$TOKEN" = "$(cut -d= -f2 .env.old)" ] && echo same || echo different',
      env: { TOKEN: 'API_TOKEN' },
    });
    // The command got the new value, and the old one comes back masked.
    expect(stdout(result)).toBe('API_TOKEN=[secret:API_TOKEN]\ndifferent\n');
    expectNoCanary(result.text);
  });

  it('masks a revoked value while the name runs nothing, across a restart', async () => {
    writeFileSync(join(root, 'pin.txt'), `pin ${SHORT_CANARY}\n`);
    expect(await store.remove(scope, ['PIN'])).toEqual(['PIN']);
    const missing = await call('run_with_secrets', {
      command: 'true',
      env: { CODE: 'PIN' },
    });
    expect(JSON.parse(missing.text)).toMatchObject({ missing: ['PIN'] });

    const echoed = await call('run_with_secrets', {
      command: 'cat pin.txt',
      env: { TOKEN: 'API_TOKEN' },
    });
    expect(stdout(echoed)).toBe('pin [secret:PIN]\n');

    // Kept encrypted on disk, and read back after a restart.
    expectNoCanary(
      readFileSync(join(dir, 'store', 'chat-secrets.json'), 'utf8'),
    );
    const restarted = storeAt('store');
    setChatSecretStoreForTests(restarted);
    const again = await call('run_with_secrets', {
      command: 'cat pin.txt',
      env: { TOKEN: 'API_TOKEN' },
    });
    expect(stdout(again)).toBe('pin [secret:PIN]\n');
    await expect(restarted.heldNames(scope, ['PIN'])).resolves.toEqual([]);
  });

  it('forgets them when the chat ends or their seven days run out', async () => {
    let now = 1_000_000;
    const timed = storeAt('timed', { now: () => now });
    await timed.put(scope, { API_TOKEN: REPLACED_CANARY });
    await timed.put(scope, { API_TOKEN: CANARY });
    await timed.ensureLoaded();
    expect(JSON.stringify(timed.redactionGroups(scope))).toContain(
      REPLACED_CANARY,
    );
    // Seven days after the old value was given, it goes.
    now += CHAT_SECRET_TTL_MS + 1;
    await timed.sweepExpired();
    expect(timed.redactionGroups(scope)).toEqual([]);

    await store.put(scope, { API_TOKEN: REPLACED_CANARY });
    await store.endChat(scope);
    expect(store.redactionGroups(scope)).toEqual([]);
    // Nothing is left to keep, so the file goes.
    expect(existsSync(join(dir, 'store', 'chat-secrets.json'))).toBe(false);
  });

  it("runs nothing while a value the chat holds or held can't be read back to hide it", async () => {
    // A restart where earlier values no longer decrypt, but a fresh
    // submission does.
    const blindStore = (name: string): ChatSecretStore =>
      storeAt(name, {
        encryption: {
          ...xorEncryption,
          decrypt: (ciphertext): string => {
            const text = xorEncryption.decrypt(ciphertext);
            if (text !== 'canary-fresh-value') throw new Error('wrong key');
            return text;
          },
        },
      });
    const marker = join(root, 'ran');
    const attempt = async (): Promise<{ text: string; isError?: boolean }> =>
      call('run_with_secrets', {
        command: `touch ${JSON.stringify(marker)}`,
        env: { TOKEN: 'OTHER' },
      });

    // Live values it can't read.
    const live = blindStore('store');
    setChatSecretStoreForTests(live);
    await live.put(scope, { OTHER: 'canary-fresh-value' });
    const refusedLive = await attempt();
    expect(refusedLive.isError).toBe(true);
    expect(refusedLive.text).toContain("can't be read back");

    // A revoked value it can't read, beside a readable live one.
    const before = storeAt('retired');
    await before.put(scope, { PIN: SHORT_CANARY });
    await before.remove(scope, ['PIN']);
    const retired = blindStore('retired');
    setChatSecretStoreForTests(retired);
    await retired.put(scope, { OTHER: 'canary-fresh-value' });
    const refusedRetired = await attempt();
    expect(refusedRetired.isError).toBe(true);
    expect(refusedRetired.text).toContain("can't be read back");
    expect(existsSync(marker)).toBe(false);
  });

  it('matches every value in one pass, so a live value never cuts an older one short', () => {
    const merged = new MergedSecretRedactor([
      { API_TOKEN: 'canary-abcd' },
      { API_TOKEN: 'canary-abcd-older-value' },
    ]);
    expect(merged.redact('x canary-abcd-older-value y')).toBe(
      'x [secret:API_TOKEN] y',
    );
  });
});

// WriteSecretsFile asks git through execFile (rev-parse, ls-files and
// check-ignore) whether the path is tracked or ignored before any value
// reaches it.
describe('WriteSecretsFile', () => {
  it('writes a 0600 dotenv file kept out of git, and asks once per path', async () => {
    writeFileSync(
      join(root, '.env.local'),
      'KEEP=1\nAPI_TOKEN=old\n# comment\n',
      'utf8',
    );
    const result = await call('write_secrets_file', {
      path: '.env.local',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN', SHORT_PIN: 'PIN', QUOTED: 'QUOTED' },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.text)).toEqual({
      path: '.env.local',
      written: ['API_TOKEN', 'SHORT_PIN', 'QUOTED'],
      gitExcluded: true,
      warning: WRITE_SECRETS_FILE_WARNING,
    });
    expectNoCanary(result.text);
    const file = join(root, '.env.local');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe(
      `KEEP=1\nAPI_TOKEN='${CANARY}'\n# comment\nSHORT_PIN='${SHORT_CANARY}'\nQUOTED=\`${OTHER_CANARY}\`\n`,
    );
    expect(
      readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'),
    ).toContain('/.env.local\n');
    expect(git(root, 'status', '--porcelain')).not.toContain('.env.local');

    // A second write of the same secrets to the same path does not ask
    // again or exclude twice.
    await call('write_secrets_file', {
      path: '.env.local',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN', SHORT_PIN: 'PIN', QUOTED: 'QUOTED' },
    });
    expect(requestChatApproval).toHaveBeenCalledTimes(1);
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('/.env.local').length - 1).toBe(1);
  });

  it('refuses git-tracked paths and paths outside the worktree', async () => {
    writeFileSync(join(root, 'config.json'), '{}\n', 'utf8');
    git(root, 'add', 'config.json');
    git(root, 'commit', '-qm', 'init');
    const tracked = await call('write_secrets_file', {
      path: 'config.json',
      format: 'json',
      entries: { token: 'API_TOKEN' },
    });
    expect(tracked.isError).toBe(true);
    expect(tracked.text).toContain('tracked by git');
    expect(readFileSync(join(root, 'config.json'), 'utf8')).toBe('{}\n');

    const outside = mkdtempSync(join(dir, 'outside-'));
    symlinkSync(outside, join(root, 'escape'));
    const escaped = await call('write_secrets_file', {
      path: 'escape/.env',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    expect(escaped.isError).toBe(true);
    expect(existsSync(join(outside, '.env'))).toBe(false);
  });

  it('reports a path git already ignores as not excluded, and writes json and raw exactly', async () => {
    writeFileSync(join(root, '.gitignore'), 'secrets/\n', 'utf8');
    writeFileSync(
      join(root, 'existing.json'),
      '{ "keep": true, "token": "old" }',
    );
    const json = await call('write_secrets_file', {
      path: 'secrets/creds.json',
      format: 'json',
      entries: { token: 'API_TOKEN', quoted: 'QUOTED' },
    });
    expect(JSON.parse(json.text)).toMatchObject({ gitExcluded: false });
    expect(
      JSON.parse(readFileSync(join(root, 'secrets', 'creds.json'), 'utf8')),
    ).toEqual({ token: CANARY, quoted: OTHER_CANARY });

    await call('write_secrets_file', {
      path: 'existing.json',
      format: 'json',
      entries: { token: 'API_TOKEN' },
    });
    expect(
      JSON.parse(readFileSync(join(root, 'existing.json'), 'utf8')),
    ).toEqual({ keep: true, token: CANARY });

    await call('write_secrets_file', {
      path: 'secrets/key.pem',
      format: 'raw',
      entries: { key: 'QUOTED' },
    });
    expect(readFileSync(join(root, 'secrets', 'key.pem'), 'utf8')).toBe(
      OTHER_CANARY,
    );
  });

  it('escapes dotenv values so a parser reads them back exactly', () => {
    expect(quoteDotenvValue('a b$c"d')).toBe(`'a b$c"d'`);
    expect(quoteDotenvValue("it's")).toBe("`it's`");
    expect(() => quoteDotenvValue("it's `both`")).toThrow();
    // A merge replaces a multi-line quoted value whole.
    expect(
      secretsFileText(
        'dotenv',
        [['KEY', 'new']],
        "A=1\nKEY='line one\nline two'\nB=2\n",
      ),
    ).toBe("A=1\nKEY='new'\nB=2\n");
    expect(secretsFileText('dotenv', [['KEY', 'new']], "A=1\nKEY='x'\n")).toBe(
      "A=1\nKEY='new'\n",
    );
  });

  it('keeps a secrets file redacted after its secrets change or go, whichever chat wrote it', async () => {
    const other: ChatSecretScope = { ...scope, chatId: 'chat-2' };
    const otherCanary = 'canary-second-chat-value';
    await store.put(other, { API_TOKEN: otherCanary });
    await call('write_secrets_file', {
      path: '.env.shared',
      format: 'dotenv',
      entries: { FIRST: 'API_TOKEN' },
    });
    await call(
      'write_secrets_file',
      {
        path: '.env.shared',
        format: 'dotenv',
        entries: { SECOND: 'API_TOKEN' },
      },
      other,
    );
    const file = join(root, '.env.shared');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain(CANARY);
    expect(text).toContain(otherCanary);
    // Rotated, then revoked: the file still holds the old values.
    await store.put(scope, { API_TOKEN: 'canary-rotated-new-value' });
    await store.remove(scope);
    await store.remove(other);
    const view = await redactSecretView(text);
    expect(view).not.toContain(CANARY);
    expect(view).not.toContain(otherCanary);
    await expect(secretFileReadRedirect(file, undefined)).resolves.toBe(
      SECRET_FILE_READ_REDIRECT,
    );
    // A new store reads the record back from disk.
    const reloaded = new ChatSecretStore({
      filePath: (): string => join(dir, 'store', 'chat-secrets.json'),
      auditFilePath: (): string => join(dir, 'store', 'audit.jsonl'),
      encryption: {
        available: (): boolean => true,
        encrypt: (value): Buffer =>
          Buffer.from(
            Buffer.from(value, 'utf8').map((byte): number => byte ^ 0x5a),
          ),
        decrypt: (ciphertext): string =>
          Buffer.from(ciphertext.map((byte): number => byte ^ 0x5a)).toString(
            'utf8',
          ),
      },
    });
    setChatSecretStoreForTests(reloaded);
    expect(await redactSecretView(text)).toBe(view);
    // The first chat's command output stays redacted too, though the second
    // chat wrote the file last and its secrets are gone.
    await reloaded.put(scope, { API_TOKEN: 'canary-after-revocation' });
    const echoed = await call('run_with_secrets', {
      command: 'cat .env.shared',
      env: { TOKEN: 'API_TOKEN' },
    });
    expectNoCanary(echoed.text);
    expectNoCanary(
      readFileSync(join(dir, 'store', 'chat-secrets.json'), 'utf8'),
    );
  });

  it('drops the start of a value a cut preview ends inside', async () => {
    const long = `canary-long-${'x'.repeat(3000)}`;
    await store.put(scope, { PEM: long });
    await call('write_secrets_file', {
      path: 'key.pem',
      format: 'raw',
      entries: { key: 'PEM' },
    });
    const preview = readFileSync(join(root, 'key.pem'), 'utf8').slice(0, 2048);
    // The cut ends inside the value: none of it is shown.
    expect(await cutView(preview)).toBe('');
    // A whole value before the cut is redacted, the cut one dropped.
    expect(await cutView(`key ${CANARY} and ${CANARY.slice(0, 10)}`)).toBe(
      'key [secret:API_TOKEN] and ',
    );
  });

  it('masks a cut piece of a longer value even when a shorter one it starts with is complete', async () => {
    await store.put(scope, {
      SHORT_KEY: 'canary-prefix',
      LONG_KEY: 'canary-prefix-and-a-longer-tail',
    });
    // Matched as read: the complete shorter value doesn't hide the cut
    // longer one, whose start is dropped.
    expect(await cutView('key canary-prefix-and-a-lo')).toBe('key ');
    expect(await cutView('a canary-prefix b canary-prefix-and')).toBe(
      'a [secret:SHORT_KEY] b ',
    );
  });

  it('redacts a multi-byte value a preview cut mid-character', async () => {
    await store.put(scope, { WIDE: 'canary-wide-ключ-значение' });
    const bytes = Buffer.from('x canary-wide-ключ', 'utf8');
    const cut = bytes.subarray(0, bytes.length - 1).toString('utf8');
    expect(cut.endsWith('\uFFFD')).toBe(true);
    expect(await cutView(cut)).toBe('x ');
  });

  it('keeps a secrets file marked across restarts without secure storage', async () => {
    const memoryOnly = new ChatSecretStore({
      filePath: (): string => join(dir, 'memory', 'chat-secrets.json'),
      auditFilePath: (): string => join(dir, 'memory', 'audit.jsonl'),
      encryption: {
        available: (): boolean => false,
        encrypt: (): Buffer => {
          throw new Error('unavailable');
        },
        decrypt: (): string => {
          throw new Error('unavailable');
        },
      },
    });
    setChatSecretStoreForTests(memoryOnly);
    await memoryOnly.put(scope, { API_TOKEN: CANARY });
    // Values that live only in this session aren't written to files.
    const refused = await call('write_secrets_file', {
      path: '.env.refused',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    expect(refused.isError).toBe(true);
    expect(existsSync(join(root, '.env.refused'))).toBe(false);
    // A file recorded while values were kept in memory only (secure storage
    // lost after the write, say) keeps its marker across a restart.
    const file = join(root, '.env.memory');
    writeFileSync(file, `API_TOKEN='${CANARY}'\n`);
    await memoryOnly.registerSecretFile(scope, realpathSync(file), [
      { name: 'API_TOKEN', value: CANARY },
    ]);
    expectNoCanary(
      readFileSync(join(dir, 'memory', 'chat-secrets.json'), 'utf8'),
    );
    // After a restart the values are gone, but the file is still known:
    // Read is refused and Canopy won't show what it can't redact.
    const restarted = new ChatSecretStore({
      filePath: (): string => join(dir, 'memory', 'chat-secrets.json'),
      auditFilePath: (): string => join(dir, 'memory', 'audit.jsonl'),
    });
    setChatSecretStoreForTests(restarted);
    await expect(secretFileReadRedirect(file, undefined)).resolves.toBe(
      SECRET_FILE_READ_REDIRECT,
    );
    await expect(
      redactSecretView(readFileSync(file, 'utf8')),
    ).rejects.toBeInstanceOf(SecretViewUnavailableError);
  });

  it('keeps every merged value redacted, and refuses past what it can keep', async () => {
    const file = join(root, '.env.many');
    for (let index = 0; index < 3; index += 1) {
      await store.put(scope, { API_TOKEN: `canary-merged-value-${index}` });
      await call('write_secrets_file', {
        path: '.env.many',
        format: 'dotenv',
        entries: { [`KEY_${index}`]: 'API_TOKEN' },
      });
    }
    const view = await redactSecretView(readFileSync(file, 'utf8'));
    expect(view).not.toContain('canary-merged-value-');
  });

  it('keeps the old values redacted when a replace fails, and never merges into an unreadable file', async () => {
    await call('write_secrets_file', {
      path: 'secrets/creds.env',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    const file = join(root, 'secrets', 'creds.env');
    const before = readFileSync(file, 'utf8');
    await store.put(scope, { API_TOKEN: 'canary-replacement-value' });
    chmodSync(join(root, 'secrets'), 0o500);
    try {
      const failed = await call('write_secrets_file', {
        path: 'secrets/creds.env',
        format: 'dotenv',
        entries: { API_TOKEN: 'API_TOKEN' },
        mode: 'replace',
      });
      expect(failed.isError).toBe(true);
    } finally {
      chmodSync(join(root, 'secrets'), 0o700);
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
    expectNoCanary(await redactSecretView(before));

    chmodSync(file, 0o000);
    try {
      const merge = await call('write_secrets_file', {
        path: 'secrets/creds.env',
        format: 'dotenv',
        entries: { OTHER_KEY: 'API_TOKEN' },
      });
      expect(merge.isError).toBe(true);
    } finally {
      chmodSync(file, 0o600);
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('asks again for other secrets, and never remembers a Full-access allow', async () => {
    await call('write_secrets_file', {
      path: '.env.asks',
      format: 'dotenv',
      entries: { A: 'API_TOKEN' },
    });
    await call('write_secrets_file', {
      path: '.env.asks',
      format: 'dotenv',
      entries: { B: 'PIN' },
    });
    expect(requestChatApproval).toHaveBeenCalledTimes(2);
    // Full access: allowed without asking, so nothing is remembered.
    jest.mocked(requestChatApproval).mockResolvedValue({ decision: 'allow' });
    for (const key of ['C', 'D'])
      await call('write_secrets_file', {
        path: '.env.full',
        format: 'dotenv',
        entries: { [key]: 'API_TOKEN' },
      });
    expect(requestChatApproval).toHaveBeenCalledTimes(4);
  });

  it('refuses a path git started tracking while the person decided', async () => {
    const file = join(root, 'late.env');
    jest.mocked(requestChatApproval).mockImplementation((...args) => {
      args[4].onAwaitingUser?.();
      writeFileSync(file, 'PUBLIC=1\n');
      git(root, 'add', 'late.env');
      return Promise.resolve({ decision: 'allow' });
    });
    const result = await call('write_secrets_file', {
      path: 'late.env',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    expect(result.isError).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('PUBLIC=1\n');
  });

  it("won't save a file holding a value, since its view is redacted", async () => {
    await call('write_secrets_file', {
      path: '.env.local',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    await expect(textHolds(`copied ${CANARY}`)).resolves.toBe(true);
    await expect(
      textHolds(readFileSync(join(root, '.env.local'), 'utf8')),
    ).resolves.toBe(true);
    await expect(textHolds('nothing secret')).resolves.toBe(false);
    // What a save checks: the file itself, read only when it is a regular
    // file small enough to read whole; a larger one can't be checked.
    await expect(
      secretViewFileHoldsSecrets(join(root, '.env.local')),
    ).resolves.toBe(true);
    writeFileSync(join(root, 'plain.txt'), 'nothing secret\n');
    await expect(
      secretViewFileHoldsSecrets(join(root, 'plain.txt')),
    ).resolves.toBe(false);
    await expect(secretViewFileHoldsSecrets(root)).resolves.toBe(false);
    writeFileSync(join(root, 'huge.txt'), 'x'.repeat(16 * 1024 * 1024 + 1));
    await expect(
      secretViewFileHoldsSecrets(join(root, 'huge.txt')),
    ).resolves.toBe(true);
  });

  it('serializes writes to case aliases of one file', async () => {
    // On a case-insensitive filesystem both name one file: they share a queue.
    const folder = realpathSync(root);
    expect(secretsFileWriteQueue(join(folder, 'config.json'))).toBe(
      secretsFileWriteQueue(join(folder, 'CONFIG.JSON')),
    );
    await Promise.all(
      ['config.json', 'CONFIG.JSON'].map((path, index) =>
        call('write_secrets_file', {
          path,
          format: 'json',
          entries: { [`K${index}`]: 'API_TOKEN' },
        }),
      ),
    );
    for (const name of readdirSync(folder).filter((entry) =>
      /^config\.json$/i.test(entry),
    )) {
      const written: unknown = JSON.parse(
        readFileSync(join(folder, name), 'utf8'),
      );
      expect(typeof written === 'object' && written !== null).toBe(true);
      expect(Object.keys(written ?? {})).not.toHaveLength(0);
    }
  });

  it('serializes concurrent merges to one file', async () => {
    await Promise.all(
      ['A', 'B', 'C'].map((key) =>
        call('write_secrets_file', {
          path: '.env.concurrent',
          format: 'dotenv',
          entries: { [key]: 'API_TOKEN' },
        }),
      ),
    );
    const text = readFileSync(join(root, '.env.concurrent'), 'utf8');
    for (const key of ['A', 'B', 'C']) expect(text).toContain(`${key}=`);
  });

  it('redacts every recorded value whatever holds it, across worktrees and in patches', async () => {
    // A value the chat holds but never wrote to a file, in a log a command
    // left, and one another chat holds.
    const other: ChatSecretScope = { ...scope, chatId: 'chat-2' };
    await store.put(other, { OTHER: 'canary-other-chat-in-worktree' });
    const log = `token ${CANARY} pin ${SHORT_CANARY} b64 ${Buffer.from(CANARY).toString('base64')}`;
    expectNoCanary(await redactSecretView(log));
    expect(await redactSecretView('x canary-other-chat-in-worktree')).toBe(
      'x [secret:OTHER]',
    );
    // A secrets file another work entry wrote, in a folder entries share
    // under different ids (Cowork), reads redacted in every entry's view.
    const sharedValue = 'canary-shared-folder-entry-a';
    await store.registerSecretFile(
      { ...scope, worktreeId: 'worktree-2', chatId: 'chat-9' },
      join(realpathSync(root), '.env.shared-folder'),
      [{ name: 'SHARED', value: sharedValue }],
    );
    expect(await redactSecretView(`x ${sharedValue}`)).toBe(
      'x [secret:SHARED]',
    );
    // A diff holding a value on either side, any cut diff (it can't be
    // checked whole), or an image preview holding one is withheld whole.
    for (const diff of [
      { oldValue: `A=${CANARY}`, newValue: 'A=1', truncated: false },
      { oldValue: 'A=1', newValue: `B=${CANARY}`, truncated: false },
      { oldValue: '', newValue: `x ${CANARY.slice(0, 9)}`, truncated: true },
      { oldValue: 'A=1', newValue: 'A=2', truncated: true },
      {
        oldValue: '',
        newValue: '',
        truncated: false,
        imagePreview: {
          newDataUrl: `data:image/png;base64,${Buffer.from(CANARY).toString('base64')}`,
        },
      },
    ])
      await expect(secretSafeView({ kind: 'diff', ...diff })).rejects.toThrow(
        SECRET_VIEW_HIDDEN_NOTICE,
      );
    await expect(
      secretSafeView({
        kind: 'diff',
        oldValue: 'A=1',
        newValue: 'A=2',
        truncated: false,
      }),
    ).resolves.toMatchObject({ kind: 'diff' });
    const harmless = join(root, 'harmless.txt');
    writeFileSync(harmless, 'nothing');
    // A store that can't be read refuses rather than shows.
    const broken = new ChatSecretStore({
      filePath: (): string => join(dir, 'store', 'chat-secrets.json'),
      auditFilePath: (): string => join(dir, 'store', 'audit.jsonl'),
      readFile: (): Promise<string> => Promise.reject(new Error('EIO')),
    });
    setChatSecretStoreForTests(broken);
    await expect(redactSecretView('x')).rejects.toBeInstanceOf(
      SecretViewUnavailableError,
    );
    // The Read redirect is a nudge only: unchecked, the Read goes ahead.
    await expect(
      secretFileReadRedirect(harmless, undefined),
    ).resolves.toBeNull();
  });

  it('never remembers an approval a mode change gave while the card was up', async () => {
    // The card shows, then switching to Full access releases it.
    jest.mocked(requestChatApproval).mockImplementation((...args) => {
      args[4].onAwaitingUser?.();
      return Promise.resolve({ decision: 'allow', grantedByModeChange: true });
    });
    for (const key of ['A', 'B'])
      await call('write_secrets_file', {
        path: '.env.mode',
        format: 'dotenv',
        entries: { [key]: 'API_TOKEN' },
      });
    expect(requestChatApproval).toHaveBeenCalledTimes(2);
  });

  it('refuses a binary view whose bytes hold a value, whatever file it is', async () => {
    await call('write_secrets_file', {
      path: 'key.bin',
      format: 'raw',
      entries: { key: 'API_TOKEN' },
    });
    const raw = readFileSync(join(root, 'key.bin'));
    const bytes = raw.toString('base64');
    await expect(viewWithheld({ kind: 'bytes', bytes: raw })).resolves.toBe(
      true,
    );
    await expect(
      viewWithheld({ kind: 'bytes', bytes: `data:image/png;base64,${bytes}` }),
    ).resolves.toBe(true);
    await expect(
      viewWithheld({
        kind: 'bytes',
        bytes: Buffer.from('harmless image bytes').toString('base64'),
      }),
    ).resolves.toBe(false);
  });

  it("refuses when git can't say whether the path is in a repository", async () => {
    writeFileSync(join(root, '.git', 'config'), '[core\nbroken = = =\n');
    const result = await call('write_secrets_file', {
      path: '.env.local',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('repository');
    expect(existsSync(join(root, '.env.local'))).toBe(false);
  });

  it('writes outside a repository when git says it is not one', async () => {
    rmSync(join(root, '.git'), { recursive: true, force: true });
    const result = await call('write_secrets_file', {
      path: '.env.local',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    expect(JSON.parse(result.text)).toMatchObject({ gitExcluded: false });
    expect(statSync(join(root, '.env.local')).mode & 0o777).toBe(0o600);
  });

  it('refuses when a folder on the way became a link while the person decided', async () => {
    mkdirSync(join(root, 'config'));
    const outside = mkdtempSync(join(dir, 'outside-'));
    jest.mocked(requestChatApproval).mockImplementation((...args) => {
      args[4].onAwaitingUser?.();
      rmSync(join(root, 'config'), { recursive: true, force: true });
      symlinkSync(outside, join(root, 'config'));
      return Promise.resolve({ decision: 'allow' });
    });
    const result = await call('write_secrets_file', {
      path: 'config/.env',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    expect(result.isError).toBe(true);
    expect(existsSync(join(outside, '.env'))).toBe(false);
  });

  it('keeps a secrets file recorded while it exists, whatever happens to its entry', async () => {
    await call('write_secrets_file', {
      path: '.env.kept',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    const file = join(root, '.env.kept');
    // Removing the work entry can leave its folder; the file still holds the
    // value, so its record stays until the file goes.
    await store.removeScope({
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
    });
    await expect(secretFileReadRedirect(file, undefined)).resolves.toBe(
      SECRET_FILE_READ_REDIRECT,
    );
    // A record whose write is still in flight survives the sweep.
    const pending = join(root, '.env.pending');
    store.beginSecretFileWrite(pending);
    await store.registerSecretFile(scope, pending, [
      { name: 'API_TOKEN', value: CANARY },
    ]);
    await store.sweepExpired();
    expect(store.isSecretFile(pending)).toBe(true);
    store.finishSecretFileWrite(pending);
    await store.sweepExpired();
    expect(store.isSecretFile(pending)).toBe(false);
    rmSync(file);
    await store.sweepExpired();
    expect(store.isSecretFile(file)).toBe(false);
  });

  it('redacts a secrets file another entry wrote in the folder commands run in', async () => {
    const shared = join(realpathSync(root), '.env.other-entry');
    const otherValue = 'canary-other-entry-value-2c';
    writeFileSync(shared, `KEY='${otherValue}'\n`);
    // A Cowork task of the same folder, under another work entry.
    await store.registerSecretFile(
      { ...scope, worktreeId: 'worktree-2', chatId: 'chat-9' },
      shared,
      [{ name: 'OTHER_KEY', value: otherValue }],
    );
    const result = await call('run_with_secrets', {
      command: 'cat .env.other-entry',
      env: { TOKEN: 'API_TOKEN' },
    });
    expect(result.text).not.toContain(otherValue);
    expect(result.text).toContain('[secret:OTHER_KEY]');
  });

  it('redacts the file in Portal reads and refuses a Portal save over it', async () => {
    await call('write_secrets_file', {
      path: '.env.local',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    const fileRoot = {
      repoId: 'repo',
      repoName: 'repo',
      absolutePath: root,
      rootKind: 'git-repo' as const,
      gitAware: true,
      excludedDescendantRoots: [],
    };
    jest.mocked(getFileBrowserRoots).mockResolvedValue({
      roots: [fileRoot],
      rootMap: new Map([['repo', fileRoot]]),
    });
    const target = {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      fileRootLocalId: 'repo',
      relativePath: '.env.local',
    };
    const preview = await readPortalFilePreview(target);
    expect(preview.content).toBe("API_TOKEN='[secret:API_TOKEN]'\n");
    await expect(
      savePortalFile({ ...target, content: preview.content }),
    ).rejects.toThrow('holds secrets');
    expect(readFileSync(join(root, '.env.local'), 'utf8')).toContain(CANARY);
  });

  it('refuses to save a redacted view back once its values are gone', async () => {
    writeFileSync(join(root, 'config.txt'), `KEY=${CANARY}\n`);
    const preview = await readPortalFilePreviewOf(root, 'config.txt');
    expect(preview.content).toBe('KEY=[secret:API_TOKEN]\n');
    // The values that redacted it go (the chat closed, the store is new).
    setChatSecretStoreForTests(storeAt('after'));
    const target = {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      fileRootLocalId: 'repo',
      relativePath: 'config.txt',
    };
    await expect(
      savePortalFile({ ...target, content: preview.content }),
    ).rejects.toThrow('holds secrets');
    expect(readFileSync(join(root, 'config.txt'), 'utf8')).toContain(CANARY);
    // A marker the file itself holds saves as any text does.
    writeFileSync(join(root, 'notes.txt'), 'see [secret:API_TOKEN]\n');
    await savePortalFile({
      ...target,
      relativePath: 'notes.txt',
      content: 'see [secret:API_TOKEN], edited\n',
    });
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toContain('edited');
  });

  it('withholds registered secrets files when the store itself is missing', async () => {
    await call('write_secrets_file', {
      path: '.env.kept',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    const file = join(realpathSync(root), '.env.kept');
    rmSync(join(dir, 'store', 'chat-secrets.json'));
    const missing = storeAt('store');
    setChatSecretStoreForTests(missing);
    await missing.ensureLoaded();
    expect(missing.isDamaged()).toBe(true);
    expect(missing.secretFileValuesLost(file)).toBe(true);
    await expect(readPortalFilePreviewOf(root, '.env.kept')).rejects.toThrow(
      SECRET_VIEW_HIDDEN_NOTICE,
    );
    // A store that never registered a file starts empty, not damaged.
    const fresh = storeAt('fresh');
    await fresh.ensureLoaded();
    expect(fresh.isDamaged()).toBe(false);
  });

  it('keeps a renamed or copied secrets file redacted, for seven days after it goes', async () => {
    let now = Date.now();
    const clocked = storeAt('clocked', { now: () => now });
    setChatSecretStoreForTests(clocked);
    await clocked.put(scope, { API_TOKEN: CANARY });
    await call('write_secrets_file', {
      path: '.env.local',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    // The chat's own values go, so only the file's record holds the value.
    await clocked.endChat(scope);
    const moved = join(root, 'config.txt');
    renameSync(join(root, '.env.local'), moved);
    copyFileSync(moved, join(root, 'backup.txt'));
    await clocked.sweepExpired();
    // Still recorded, encrypted, across a restart.
    expectNoCanary(
      readFileSync(join(dir, 'clocked', 'chat-secrets.json'), 'utf8'),
    );
    // The Files panel reads the renamed file redacted, through its IPC.
    registerFilePreviewHandlers(
      createDesktopRuntime({ shutdownTimeoutMs: 1_000 }),
      () => ({
        principalId: 'local',
        clientInstanceId: 'electron-web-contents:1',
        authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
        interfaceKind: 'desktop',
        grants: ['worker.filesystem.read'],
      }),
    );
    for (const name of ['config.txt', 'backup.txt']) {
      const response: unknown = await handlers.get(
        IPC_CHANNELS.fileReadContent,
      )?.({ sender: { id: 1 } }, { absolutePath: join(root, name) });
      expect((response as FileContentResponse).content).toBe(
        "API_TOKEN='[secret:API_TOKEN]'\n",
      );
    }
    // The Read nudge follows the path only: a renamed file isn't redirected.
    await expect(secretFileReadRedirect(moved, undefined)).resolves.toBeNull();
    now += CHAT_SECRET_TTL_MS + 1;
    await clocked.sweepExpired();
    expect(await redactSecretView(readFileSync(moved, 'utf8'))).toContain(
      CANARY,
    );
    // Nothing is left recorded, so the store's file is gone.
    expect(existsSync(join(dir, 'clocked', 'chat-secrets.json'))).toBe(false);
  });

  it('refuses document bytes of a secrets file', async () => {
    await call('write_secrets_file', {
      path: 'report.pdf',
      format: 'raw',
      entries: { key: 'API_TOKEN' },
    });
    const fileRoot = {
      repoId: 'repo',
      repoName: 'repo',
      absolutePath: root,
      rootKind: 'git-repo' as const,
      gitAware: true,
      excludedDescendantRoots: [],
    };
    jest.mocked(getFileBrowserRoots).mockResolvedValue({
      roots: [fileRoot],
      rootMap: new Map([['repo', fileRoot]]),
    });
    registerFilePreviewHandlers(
      createDesktopRuntime({ shutdownTimeoutMs: 1_000 }),
      () => ({
        principalId: 'local',
        clientInstanceId: 'electron-web-contents:1',
        authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
        interfaceKind: 'desktop',
        grants: ['worker.filesystem.read'],
      }),
    );
    await expect(
      Promise.resolve(
        handlers.get(IPC_CHANNELS.fileReadDocumentBytes)?.(
          { sender: { id: 1 } },
          {
            absolutePath: join(realpathSync(root), 'report.pdf'),
            workspaceTarget: {
              projectId: scope.projectId,
              worktreeId: scope.worktreeId,
            },
          },
        ),
      ),
    ).rejects.toBeInstanceOf(SecretViewUnavailableError);
  });

  it('keeps a record it cannot check, and treats a staging file as the secrets file', async () => {
    await call('write_secrets_file', {
      path: 'locked/.env',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    const folder = join(realpathSync(root), 'locked');
    const file = join(folder, '.env');
    // An access error says nothing about the file: its record stays.
    chmodSync(folder, 0o000);
    try {
      await store.sweepExpired();
    } finally {
      chmodSync(folder, 0o700);
    }
    expect(store.isSecretFile(file)).toBe(true);
    // A staging file a crashed write left holds the same values.
    const staging = join(
      folder,
      '..env.0d9b6c1e-3f2a-4b5c-8d7e-1a2b3c4d5e6f.tmp',
    );
    writeFileSync(staging, `API_TOKEN='${CANARY}'\n`, { mode: 0o600 });
    expect(store.isSecretFile(staging)).toBe(true);
    await expect(secretFileReadRedirect(staging, undefined)).resolves.toBe(
      SECRET_FILE_READ_REDIRECT,
    );
    // The sweep deletes it once it is old enough.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(staging, old, old);
    await store.sweepExpired();
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  it('replaces a multi-line double-quoted value holding an escaped quote whole', () => {
    expect(
      secretsFileText(
        'dotenv',
        [['A', 'new']],
        'A="first \\" line\nsecond line"\nB=2\n',
      ),
    ).toBe("A='new'\nB=2\n");
  });

  it('withholds a Portal patch whose file holds a value on either full side', async () => {
    jest.mocked(resolveWorktreeCwd).mockReturnValue(realpathSync(root));
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    writeFileSync(join(root, 'config.txt'), `line 1\nKEY=${CANARY}\nline 3\n`);
    writeFileSync(join(root, 'clean.txt'), 'one\n');
    git(root, 'add', 'config.txt', 'clean.txt');
    git(root, 'commit', '-qm', 'base');
    // Only line 3 changes, so the hunk alone would not show the value.
    writeFileSync(
      join(root, 'config.txt'),
      `line 1\nKEY=${CANARY}\nline 3 edited\n`,
    );
    writeFileSync(join(root, 'clean.txt'), 'two\n');
    const request = {
      workspaceId: scope.projectId,
      worktreeId: scope.worktreeId,
      source: 'uncommitted' as const,
    };
    await expect(readDiff({ ...request, path: 'config.txt' })).rejects.toThrow(
      SECRET_VIEW_HIDDEN_NOTICE,
    );
    await expect(readDiff(request)).rejects.toThrow(SECRET_VIEW_HIDDEN_NOTICE);
    const clean = await readDiff({ ...request, path: 'clean.txt' });
    expect(clean.patch).toContain('+two');
  });

  it("withholds a Portal patch when a full side can't be read whole, and keeps a value's trailing space", async () => {
    jest.mocked(resolveWorktreeCwd).mockReturnValue(realpathSync(root));
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    const spaced = 'canary-trailing-space-6b2 ';
    await store.put(scope, { SPACED: spaced });
    // Past the whole-side limit, so its value can't be checked; many short
    // lines, so the patch itself stays small.
    const rest = 'x\n'.repeat(8.5 * 1024 * 1024);
    writeFileSync(join(root, 'big.txt'), `KEY=${CANARY}\n${rest}`);
    // The value is the file's end, trailing space included.
    writeFileSync(join(root, 'spaced.txt'), `KEY=${spaced}`);
    git(root, 'add', 'big.txt', 'spaced.txt');
    git(root, 'commit', '-qm', 'base');
    // Only the value's line goes, so the patch shows it removed.
    writeFileSync(join(root, 'big.txt'), rest);
    writeFileSync(join(root, 'spaced.txt'), 'KEY=other\n');
    const request = {
      workspaceId: scope.projectId,
      worktreeId: scope.worktreeId,
      source: 'uncommitted' as const,
    };
    await expect(readDiff({ ...request, path: 'big.txt' })).rejects.toThrow(
      SECRET_VIEW_HIDDEN_NOTICE,
    );
    await expect(readDiff({ ...request, path: 'spaced.txt' })).rejects.toThrow(
      SECRET_VIEW_HIDDEN_NOTICE,
    );
  });

  it('redacts shared-folder Portal reads and withholds their diffs like local ones', async () => {
    const fileRoot = {
      repoId: 'repo',
      repoName: 'repo',
      absolutePath: '/shared-viewer/repo',
      rootKind: 'git-repo' as const,
      gitAware: true,
      excludedDescendantRoots: [],
    };
    jest.mocked(getFileBrowserRoots).mockResolvedValue({
      roots: [fileRoot],
      rootMap: new Map([['repo', fileRoot]]),
    });
    const text = `KEY=${CANARY}\n`;
    jest.mocked(readSharedContainerViewerFile).mockResolvedValue({
      bytes: Buffer.from(text),
      filename: 'config.txt',
      sizeBytes: Buffer.byteLength(text),
      modifiedAtMs: 1,
    });
    const preview = await readPortalFilePreview({
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'container-1',
      fileRootLocalId: 'repo',
      relativePath: 'config.txt',
    });
    expect(preview.content).toBe('KEY=[secret:API_TOKEN]\n');
    jest.mocked(resolveSharedContainerViewerReadRoots).mockResolvedValue([
      {
        repoId: 'repo',
        repoName: 'repo',
        absolutePath: '/shared-viewer/repo',
        revisionRoot: '/shared-viewer/revision',
        revisionId: 'revision-1',
      },
    ]);
    let oldValue = `KEY=${CANARY}`;
    const reader = {
      readOverlayDiff: () =>
        Promise.resolve({
          oldValue,
          newValue: 'KEY=2',
          truncated: false,
          binary: false,
        }),
    } as unknown as SharedContainerReader;
    jest.mocked(getSharedContainerReader).mockReturnValue(reader);
    const request = {
      workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'container-1',
      repoId: 'repo',
      path: 'config.txt',
      source: 'uncommitted' as const,
    };
    await expect(readDiff(request)).rejects.toThrow(SECRET_VIEW_HIDDEN_NOTICE);
    oldValue = 'KEY=1';
    expect((await readDiff(request)).patch).toContain('+KEY=2');
  });

  it('matches a value spanning lines as a patch shows it', async () => {
    await store.put(scope, { PEM: 'canary-pem-line-1\ncanary-pem-line-2' });
    const patch = (lines: string[]): SecretView => ({
      kind: 'patch',
      patch: [
        'diff --git a/key.pem b/key.pem',
        '--- a/key.pem',
        '+++ b/key.pem',
        ...lines,
      ].join('\n'),
    });
    // The whole value, one diff marker a line.
    await expect(
      viewWithheld(
        patch([
          '@@ -1,3 +1,1 @@',
          ' header',
          '-canary-pem-line-1',
          '-canary-pem-line-2',
          '+replaced',
        ]),
      ),
    ).resolves.toBe(true);
    // A hunk that shows only one of its lines.
    await expect(
      viewWithheld(
        patch(['@@ -3,2 +3,2 @@', ' canary-pem-line-2', '-a', '+b']),
      ),
    ).resolves.toBe(true);
    await expect(
      viewWithheld(patch(['@@ -1,1 +1,1 @@', '-a', '+b'])),
    ).resolves.toBe(false);
  });

  it('finds one line of a value spanning lines, and a CRLF copy, in every view kind', async () => {
    await store.put(scope, { PEM: 'canary-pem-line-1\ncanary-pem-line-2' });
    const samples = {
      'one line': ['canary-pem-line-2'],
      'a CRLF copy': ['canary-pem-line-1\r', 'canary-pem-line-2'],
    };
    for (const [label, lines] of Object.entries(samples)) {
      const sample = lines.join('\n');
      const text = `before\n${sample}\nafter\n`;
      // Text and previews redact it, whole or cut.
      const shown = (await secretSafeView({ kind: 'text', text, cut: false }))
        .text;
      expect([label, shown.includes('canary-pem-line')]).toEqual([
        label,
        false,
      ]);
      expect([
        label,
        (await cutView(text)).includes('canary-pem-line'),
      ]).toEqual([label, false]);
      // Bytes, both diff sides, a patch and a save withhold it.
      await expect(
        viewWithheld({ kind: 'bytes', bytes: Buffer.from(text, 'utf8') }),
      ).resolves.toBe(true);
      await expect(textHolds(text)).resolves.toBe(true);
      await expect(
        viewWithheld({
          kind: 'diff',
          oldValue: '',
          newValue: text,
          truncated: false,
        }),
      ).resolves.toBe(true);
      await expect(
        viewWithheld({
          kind: 'patch',
          patch: [
            'diff --git a/key.pem b/key.pem',
            '--- a/key.pem',
            '+++ b/key.pem',
            `@@ -1,1 +1,${String(lines.length + 1)} @@`,
            ' before',
            ...lines.map((line) => `+${line}`),
          ].join('\n'),
        }),
      ).resolves.toBe(true);
      writeFileSync(join(root, 'copied.pem'), text);
      await expect(
        secretViewFileHoldsSecrets(join(root, 'copied.pem')),
      ).resolves.toBe(true);
    }
    await expect(textHolds('before\ncanary-pem\nafter')).resolves.toBe(false);
  });

  it("fails closed when a damaged store's registrations or records can't be read", async () => {
    await call('write_secrets_file', {
      path: '.env.registered',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    const file = join(realpathSync(root), '.env.registered');
    const registrations = join(dir, 'store', 'secret-file-paths.json');
    const saved = readFileSync(registrations, 'utf8');
    writeFileSync(join(dir, 'store', 'chat-secrets.json'), '{ not json');
    const withheld = async (): Promise<string> => {
      try {
        await secretSafeView({
          kind: 'text',
          text: 'x',
          cut: false,
          paths: [file],
        });
        return 'shown';
      } catch (error) {
        if (error instanceof SecretViewHiddenError) return 'hidden';
        if (error instanceof SecretViewUnavailableError) return 'unavailable';
        throw error;
      }
    };
    // A registrations file that can't be parsed, or read, fails the load;
    // the file is never shown, and the failure isn't kept.
    for (const broken of ['{ not json', '{"version":1,"files":[{"path":1}]}']) {
      writeFileSync(registrations, broken);
      const damaged = storeAt('store');
      setChatSecretStoreForTests(damaged);
      await expect(damaged.ensureLoaded()).rejects.toThrow();
      await expect(withheld()).resolves.toBe('unavailable');
      writeFileSync(registrations, saved);
      await damaged.ensureLoaded();
      expect(damaged.secretFileValuesLost(file)).toBe(true);
      await expect(withheld()).resolves.toBe('hidden');
    }
    rmSync(registrations);
    mkdirSync(registrations);
    const unreadable = storeAt('store');
    setChatSecretStoreForTests(unreadable);
    await expect(unreadable.ensureLoaded()).rejects.toThrow();
    await expect(withheld()).resolves.toBe('unavailable');
    // A record the store can't read fails the load too, rather than lose
    // its value.
    rmSync(registrations, { recursive: true });
    writeFileSync(
      join(dir, 'store', 'chat-secrets.json'),
      JSON.stringify({
        version: 1,
        chats: [{ scope, secrets: { API_TOKEN: { ciphertext: 1 } } }],
      }),
    );
    const partial = storeAt('store');
    setChatSecretStoreForTests(partial);
    await expect(partial.ensureLoaded()).rejects.toThrow();
    await expect(withheld()).resolves.toBe('unavailable');
  });

  it('refuses a dotenv value holding a carriage return', () => {
    expect(() => quoteDotenvValue('canary\r\nvalue')).toThrow('json or raw');
  });

  it('fails closed when the store is damaged: tools refuse and lost files are withheld', async () => {
    await call('write_secrets_file', {
      path: '.env.damaged',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    const file = join(realpathSync(root), '.env.damaged');
    writeFileSync(join(dir, 'store', 'chat-secrets.json'), '{ not json');
    const damaged = storeAt('store');
    setChatSecretStoreForTests(damaged);
    await damaged.ensureLoaded();
    expect(damaged.isDamaged()).toBe(true);
    expect(damaged.secretFileValuesLost(file)).toBe(true);
    const run = await call('run_with_secrets', {
      command: 'true',
      env: { TOKEN: 'API_TOKEN' },
    });
    expect(run.isError).toBe(true);
    expect(run.text).toBe(SECRET_STORE_DAMAGED_MESSAGE);
    await expect(readPortalFilePreviewOf(root, '.env.damaged')).rejects.toThrow(
      SECRET_VIEW_HIDDEN_NOTICE,
    );
    // A scoped read that names the file by its root reads that file,
    // whatever `absolutePath` says.
    writeFileSync(join(root, 'harmless.txt'), 'nothing');
    registerFilePreviewHandlers(
      createDesktopRuntime({ shutdownTimeoutMs: 1_000 }),
      () => ({
        principalId: 'local',
        clientInstanceId: 'electron-web-contents:1',
        authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
        interfaceKind: 'desktop',
        grants: ['worker.filesystem.read'],
      }),
    );
    await expect(
      Promise.resolve(
        handlers.get(IPC_CHANNELS.fileReadContent)?.(
          { sender: { id: 1 } },
          {
            absolutePath: join(realpathSync(root), 'harmless.txt'),
            workspaceTarget: {
              projectId: scope.projectId,
              worktreeId: scope.worktreeId,
            },
            file: { fileRootId: 'repo', relativePath: '.env.damaged' },
          },
        ),
      ),
    ).rejects.toThrow(SECRET_VIEW_HIDDEN_NOTICE);
    // Providing secrets again lifts the refusal; the lost file stays hidden,
    // and no command runs where it is: its values can't be hidden.
    await damaged.put(scope, { API_TOKEN: 'canary-provided-again' });
    expect(damaged.isDamaged()).toBe(false);
    expect(damaged.secretFileValuesLost(file)).toBe(true);
    const again = await call('run_with_secrets', {
      command: 'true',
      env: { TOKEN: 'API_TOKEN' },
    });
    expect(again.isError).toBe(true);
    expect(again.text).toContain('values that were lost');
    // Registering a replace keeps the mark until the file is installed.
    await damaged.registerSecretFile(
      scope,
      file,
      [{ name: 'API_TOKEN', value: 'canary-provided-again' }],
      { replace: true },
    );
    expect(damaged.secretFileValuesLost(file)).toBe(true);
    await damaged.keepOnlySecretFileValues(file, [
      { name: 'API_TOKEN', value: 'canary-provided-again' },
    ]);
    expect(damaged.secretFileValuesLost(file)).toBe(false);
    const after = await call('run_with_secrets', {
      command: 'true',
      env: { TOKEN: 'API_TOKEN' },
    });
    expect(after.isError).toBeFalsy();
  });

  it('merges into a CRLF file without changing what it keeps', () => {
    expect(
      secretsFileText(
        'dotenv',
        [['B', 'new']],
        "A='line one\r\nline two'\r\nC=1\r\n",
      ),
    ).toBe("A='line one\r\nline two'\r\nC=1\r\nB='new'\r\n");
  });

  it('excludes the staging file from git even when git ignores the file already', async () => {
    writeFileSync(join(root, '.gitignore'), '.env\n');
    const result = await call('write_secrets_file', {
      path: '.env',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    expect(JSON.parse(result.text)).toMatchObject({ gitExcluded: false });
    // git check-ignore exits 0 for an ignored path, else execFileSync throws.
    git(
      root,
      'check-ignore',
      '-q',
      '--no-index',
      // The staging name the writer uses for .env.
      '..env.0d9b6c1e-3f2a-4b5c-8d7e-1a2b3c4d5e6f.tmp',
    );
    expect(
      readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'),
    ).not.toContain('/.env\n');
  });

  it('keeps the record while a staging file a crash left remains', async () => {
    const folder = realpathSync(root);
    const target = join(folder, '.env.crashed');
    await store.registerSecretFile(scope, target, [
      { name: 'API_TOKEN', value: CANARY },
    ]);
    const staging = join(
      folder,
      '..env.crashed.0d9b6c1e-3f2a-4b5c-8d7e-1a2b3c4d5e6f.tmp',
    );
    writeFileSync(staging, `API_TOKEN='${CANARY}'\n`, { mode: 0o600 });
    // The first write never renamed: the file is missing, its staging file
    // isn't old enough to delete, so the record stays.
    await store.sweepExpired();
    expect(store.isSecretFile(staging)).toBe(true);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(staging, old, old);
    await store.sweepExpired();
    expect(existsSync(staging)).toBe(false);
    await store.sweepExpired();
    expect(store.isSecretFile(target)).toBe(false);
  });

  it('writes nothing once the turn is stopped', async () => {
    const controller = new AbortController();
    jest.mocked(requestChatApproval).mockImplementation(() => {
      controller.abort();
      return Promise.resolve({ decision: 'allow' });
    });
    const result = await call(
      'write_secrets_file',
      { path: '.env.stopped', format: 'dotenv', entries: { A: 'API_TOKEN' } },
      scope,
      controller.signal,
    );
    expect(result.isError).toBe(true);
    expect(existsSync(join(root, '.env.stopped'))).toBe(false);
  });

  it('installs nothing when the turn stops while the file is being made private', async () => {
    const controller = new AbortController();
    controller.abort();
    const target = join(realpathSync(root), '.env.late-stop');
    await expect(
      writePrivateFileAtomically(target, `A='${CANARY}'\n`, controller.signal),
    ).rejects.toBeDefined();
    expect(existsSync(target)).toBe(false);
    expect(
      readdirSync(realpathSync(root)).some((name) => name.endsWith('.tmp')),
    ).toBe(false);
  });

  it('refuses a tracked file in a repository whose folder name ends with a space', async () => {
    root = join(dir, 'spaced repo ');
    mkdirSync(root);
    git(root, 'init', '-q');
    writeFileSync(join(root, 'app.env'), 'PUBLIC=1\n');
    git(root, 'add', 'app.env');
    const result = await call('write_secrets_file', {
      path: 'app.env',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    expect(result.isError).toBe(true);
    expect(readFileSync(join(root, 'app.env'), 'utf8')).toBe('PUBLIC=1\n');
  });

  it('refuses a case alias of a tracked file', async () => {
    writeFileSync(join(root, 'AGENTS.md'), '# tracked\n');
    git(root, 'add', 'AGENTS.md');
    const result = await call('write_secrets_file', {
      path: 'agents.md',
      format: 'raw',
      entries: { key: 'API_TOKEN' },
    });
    expect(result.isError).toBe(true);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('# tracked\n');
  });

  it('writes nothing when a secret became session-only while the person decided', async () => {
    jest.mocked(requestChatApproval).mockImplementation(async (...args) => {
      args[4].onAwaitingUser?.();
      await store.put(
        scope,
        { API_TOKEN: 'canary-raced-session-only' },
        { sessionOnly: true },
      );
      return { decision: 'allow' };
    });
    const result = await call('write_secrets_file', {
      path: '.env.raced',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    expect(result.isError).toBe(true);
    expect(existsSync(join(root, '.env.raced'))).toBe(false);
  });

  it('never writes a secret kept for this session only', async () => {
    await store.put(
      scope,
      { SESSION_KEY: 'canary-session-only-77' },
      { sessionOnly: true },
    );
    const result = await call('write_secrets_file', {
      path: '.env.session',
      format: 'dotenv',
      entries: { KEY: 'SESSION_KEY' },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('SESSION_KEY');
    expect(existsSync(join(root, '.env.session'))).toBe(false);
  });

  it('keeps the values a replace displaced redacted for seven days', async () => {
    let now = Date.now();
    const clocked = storeAt('replace-clock', { now: () => now });
    setChatSecretStoreForTests(clocked);
    await clocked.put(scope, { API_TOKEN: CANARY });
    await call('write_secrets_file', {
      path: '.env.rotate',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    // A copy of the old file, then a replace with a new value; the chat's
    // own values go too, so only the file's record holds the old one.
    copyFileSync(join(root, '.env.rotate'), join(root, 'old-copy.env'));
    await clocked.put(scope, { API_TOKEN: 'canary-rotated-value-88' });
    await call('write_secrets_file', {
      path: '.env.rotate',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
      mode: 'replace',
    });
    await clocked.endChat(scope);
    const copy = readFileSync(join(root, 'old-copy.env'), 'utf8');
    expect(await redactSecretView(copy)).toBe(
      "API_TOKEN='[secret:API_TOKEN]'\n",
    );
    now += CHAT_SECRET_TTL_MS + 1;
    await clocked.sweepExpired();
    expect(await redactSecretView(copy)).toContain(CANARY);
    expect(
      await redactSecretView(readFileSync(join(root, '.env.rotate'), 'utf8')),
    ).toBe("API_TOKEN='[secret:API_TOKEN]'\n");
  });

  it('redirects Read of the file and redacts Canopy reads of it', async () => {
    await call('write_secrets_file', {
      path: '.env.local',
      format: 'dotenv',
      entries: { API_TOKEN: 'API_TOKEN' },
    });
    const file = join(root, '.env.local');
    await expect(secretFileReadRedirect(file, undefined)).resolves.toBe(
      SECRET_FILE_READ_REDIRECT,
    );
    await expect(secretFileReadRedirect('.env.local', root)).resolves.toBe(
      SECRET_FILE_READ_REDIRECT,
    );
    await expect(
      secretFileReadRedirect(join(root, 'other'), undefined),
    ).resolves.toBeNull();
    const view = await redactSecretView(readFileSync(file, 'utf8'));
    expect(view).toBe("API_TOKEN='[secret:API_TOKEN]'\n");

    // The Files panel and previews read it redacted, through their IPC.
    registerFilePreviewHandlers(
      createDesktopRuntime({ shutdownTimeoutMs: 1_000 }),
      () => ({
        principalId: 'local',
        clientInstanceId: 'electron-web-contents:1',
        authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
        interfaceKind: 'desktop',
        grants: ['worker.filesystem.read'],
      }),
    );
    const event = { sender: { id: 1 } };
    const content: unknown = await handlers.get(IPC_CHANNELS.fileReadContent)?.(
      event,
      { absolutePath: file },
    );
    const preview: unknown = await handlers.get(IPC_CHANNELS.fileReadPreview)?.(
      event,
      { absolutePath: file },
    );
    // A secrets file with an image's name is refused, not shown as one.
    await call('write_secrets_file', {
      path: 'key.png',
      format: 'raw',
      entries: { key: 'API_TOKEN' },
    });
    await expect(
      Promise.resolve(
        handlers.get(IPC_CHANNELS.fileReadPreview)?.(event, {
          absolutePath: join(root, 'key.png'),
        }),
      ),
    ).rejects.toBeInstanceOf(SecretViewUnavailableError);
    for (const response of [content, preview]) {
      const text = (response as FileContentResponse | FilePreviewResponse)
        .content;
      expect(text).toBe("API_TOKEN='[secret:API_TOKEN]'\n");
    }
  });
});

describe('where it is offered', () => {
  it('runs nothing where a command could leave processes behind (Windows)', async () => {
    jest.mocked(isRunWithSecretsSupported).mockReturnValueOnce(false);
    const marker = join(root, 'ran');
    const result = await call('run_with_secrets', {
      command: `touch ${JSON.stringify(marker)}`,
      env: { TOKEN: 'API_TOKEN' },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('capability_unavailable');
    expect(existsSync(marker)).toBe(false);
    expect(requestChatApproval).not.toHaveBeenCalled();
  });
});

describe('approvals', () => {
  const check: ApprovalCheck = {
    kind: 'agent-secret-use',
    tool: 'RunWithSecrets',
    secretNames: ['API_TOKEN'],
  };
  const allowEverything = {
    session: [
      {
        id: 'rule-1',
        behavior: 'allow' as const,
        target: { kind: 'tool' as const, toolName: 'RunWithSecrets' },
        createdAt: '2026-11-16T00:00:00.000Z',
        origin: 'prompt' as const,
      },
    ],
    project: [],
    global: [],
  };

  it.each(['ask', 'auto'] as const)(
    'asks every time in %s mode, whatever rules are saved',
    (mode) => {
      expect(
        evaluateApproval(check, { mode, rules: allowEverything }).outcome,
      ).toBe('prompt');
    },
  );

  it('allows without a prompt in Full access', () => {
    expect(
      evaluateApproval(check, {
        mode: 'full-access',
        rules: { session: [], project: [], global: [] },
      }).outcome,
    ).toBe('allow');
  });
});

// The storage backstop redacts each provider event before its chat:event
// delivery and storage, in the session event router.
describe('storage backstop', () => {
  const delta = (
    text: string,
    index = 0,
    uuid = `u-${text.length}-${index}`,
  ): Record<string, unknown> => ({
    type: 'stream_event',
    uuid,
    session_id: 's-1',
    parent_tool_use_id: null,
    event: {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text },
    },
  });
  const deltaText = (event: unknown): string => {
    const record = event as {
      event?: { type?: string; delta?: { text?: string } };
    };
    return record.event?.type === 'content_block_delta'
      ? (record.event.delta?.text ?? '')
      : '';
  };
  const run = (
    backstop: ChatSecretStorageBackstop,
    events: unknown[],
  ): unknown[] =>
    events.flatMap((event) => {
      const result = backstop.apply(event);
      expect('refused' in result).toBe(false);
      return [...result.events];
    });

  it('holds back a value cut across Claude deltas and releases it redacted when the block ends', () => {
    const backstop = new ChatSecretStorageBackstop(scope, root);
    const text = `token=${CANARY} and pin ${SHORT_CANARY}.`;
    const pieces = [text.slice(0, 9), text.slice(9, 20), text.slice(20)];
    const out = run(backstop, [
      ...pieces.map((piece) => delta(piece)),
      {
        type: 'stream_event',
        uuid: 'stop',
        parent_tool_use_id: null,
        event: { type: 'content_block_stop', index: 0 },
      },
    ]);
    // No released piece holds any part of a value a later piece completes.
    for (const event of out) expectNoCanary(JSON.stringify(event));
    for (const event of out.slice(0, 3))
      expect(deltaText(event)).not.toContain('canary-7f3e');
    expect(out.map(deltaText).join('')).toBe(
      'token=[secret:API_TOKEN] and pin [secret:PIN].',
    );
    // The flush is a delta of its own, before the stop, with a fresh id.
    const flush = out[out.length - 2] as { uuid: string };
    expect(flush.uuid).not.toMatch(/^u-/);
    expect((out[out.length - 1] as { uuid: string }).uuid).toBe('stop');
  });

  it("releases a child stream's held text only when its own conversation's message ends", () => {
    const backstop = new ChatSecretStorageBackstop(scope, root);
    const sub = (text: string): Record<string, unknown> => ({
      ...delta(text, 0, `sub-${text.length}`),
      parent_tool_use_id: 'task-1',
    });
    const first = run(backstop, [sub(`log ${CANARY.slice(0, 14)}`)]);
    // The main conversation's whole message leaves the subagent's stream be.
    const main = run(backstop, [
      {
        type: 'assistant',
        parent_tool_use_id: null,
        canopy_turn_user_message_id: `turn-${SHORT_CANARY}-1`,
        message: { id: 'm-1', content: [{ type: 'text', text: 'hi' }] },
      },
    ]);
    expect(main).toHaveLength(1);
    // The turn-owner stamp routes the event; a value inside it stays.
    expect(
      (main[0] as { canopy_turn_user_message_id: string })
        .canopy_turn_user_message_id,
    ).toBe(`turn-${SHORT_CANARY}-1`);
    // Nor does the root turn's result: the child streams on after it.
    const ended = run(backstop, [
      { type: 'result', subtype: 'success', result: 'ok' },
    ]);
    expect(ended).toHaveLength(1);
    const rest = run(backstop, [
      sub(`${CANARY.slice(14)} end`),
      {
        type: 'stream_event',
        uuid: 'sub-stop',
        parent_tool_use_id: 'task-1',
        event: { type: 'message_stop' },
      },
    ]);
    expect([...first, ...rest].map(deltaText).join('')).toBe(
      'log [secret:API_TOKEN] end',
    );
    const plain = { type: 'system', subtype: 'init', note: 'nothing here' };
    expect(backstop.apply(plain).events[0]).toBe(plain);
  });

  it('keeps a stream across an informational event of its conversation', () => {
    const backstop = new ChatSecretStorageBackstop(scope, root);
    const out = run(backstop, [
      delta(`key ${CANARY.slice(0, 12)}`, 0, 'a'),
      {
        type: 'tool_progress',
        parent_tool_use_id: null,
        tool_use_id: 'tool-1',
        elapsed_time_seconds: 1,
      },
      delta(`${CANARY.slice(12)} end`, 0, 'b'),
      {
        type: 'stream_event',
        uuid: 'stop',
        parent_tool_use_id: null,
        event: { type: 'content_block_stop', index: 0 },
      },
    ]);
    expectNoCanary(JSON.stringify(out));
    expect(out.map(deltaText).join('')).toBe('key [secret:API_TOKEN] end');
  });

  it('keeps streams across a task notification result while the turn goes on', () => {
    const backstop = new ChatSecretStorageBackstop(scope, root);
    const sub = (text: string, uuid: string): Record<string, unknown> => ({
      ...delta(text, 0, uuid),
      parent_tool_use_id: 'task-1',
    });
    const out = run(backstop, [
      sub(`log ${CANARY.slice(0, 14)}`, 'a'),
      {
        type: 'result',
        subtype: 'success',
        result: 'task done',
        canopy_session_continues: true,
      },
      sub(`${CANARY.slice(14)} end`, 'b'),
      {
        type: 'stream_event',
        uuid: 'sub-stop',
        parent_tool_use_id: 'task-1',
        event: { type: 'content_block_stop', index: 0 },
      },
    ]);
    expectNoCanary(JSON.stringify(out));
    expect(out.map(deltaText).join('')).toBe('log [secret:API_TOKEN] end');
  });

  it("keeps a background child's stream open across the root turn's result", () => {
    const backstop = new ChatSecretStorageBackstop(scope, root);
    const sub = (text: string, uuid: string): Record<string, unknown> => ({
      ...delta(text, 0, uuid),
      parent_tool_use_id: 'task-2',
    });
    const out = run(backstop, [
      sub(`log ${CANARY.slice(0, 14)}`, 'a'),
      { type: 'result', subtype: 'success', result: 'done' },
      sub(`${CANARY.slice(14)} end`, 'b'),
      {
        type: 'stream_event',
        uuid: 'sub-stop',
        parent_tool_use_id: 'task-2',
        event: { type: 'content_block_stop', index: 0 },
      },
    ]);
    expectNoCanary(JSON.stringify(out));
    expect(out.map(deltaText).join('')).toBe('log [secret:API_TOKEN] end');
    // The root's own stream still ends at its result.
    const rootOut = run(backstop, [
      delta(`key ${CANARY.slice(0, 12)}`, 0, 'r'),
      { type: 'result', subtype: 'success', result: 'done' },
    ]);
    expectNoCanary(JSON.stringify(rootOut));
    expect(rootOut).toHaveLength(3);
  });

  it('holds a stream across message_start: only a stop or whole message ends it', () => {
    const backstop = new ChatSecretStorageBackstop(scope, root);
    const out = run(backstop, [
      delta(`key ${CANARY.slice(0, 12)}`, 0, 'a'),
      {
        type: 'stream_event',
        uuid: 'start',
        parent_tool_use_id: null,
        event: { type: 'message_start', message: { id: 'm-2' } },
      },
      delta(`${CANARY.slice(12)} end`, 0, 'b'),
      {
        type: 'stream_event',
        uuid: 'stop',
        parent_tool_use_id: null,
        event: { type: 'message_stop' },
      },
    ]);
    expectNoCanary(JSON.stringify(out));
    expect(out.map(deltaText).join('')).toBe('key [secret:API_TOKEN] end');
  });

  it('carries held text unredacted into the new values when they change mid-stream', async () => {
    const backstop = new ChatSecretStorageBackstop(scope, root);
    const older = 'canary-older-value-31';
    await store.put(scope, { OLDER: older });
    // The held text is the end of the older value, which a newer one
    // continues: matched by its old redaction, the newer one would leak.
    const held = run(backstop, [delta(`x ${older}`, 0, 'a')]);
    const newer = 'older-value-31-and-newer-tail';
    await store.put(scope, { NEWER: newer });
    const rest = run(backstop, [
      delta('-and-newer-tail end', 0, 'b'),
      {
        type: 'stream_event',
        uuid: 'stop',
        parent_tool_use_id: null,
        event: { type: 'content_block_stop', index: 0 },
      },
    ]);
    const shown = [...held, ...rest].map(deltaText).join('');
    expect(shown).not.toContain('newer-tail');
    expect(shown).not.toContain('older-value');
    expect(shown.startsWith('x [secret:')).toBe(true);
    expect(shown.endsWith(' end')).toBe(true);
  });

  it('keeps an overlapping open match bounded, and takes it back whole or as its placeholder', () => {
    const redactor = new SecretValueRedactor({ RUN: 'abab' });
    // A self-overlapping run keeps the match open across every push.
    let released = '';
    for (let index = 0; index < 2000; index++)
      released += redactor.push('ab'.repeat(64));
    expect(released).not.toContain('abab');
    // Past the limit the held text goes as the placeholder, never in part.
    expect(redactor.takeHeld()).toBe('[secret:RUN]');
    const short = new SecretValueRedactor({ RUN: 'abab' });
    short.push('x abababab');
    expect(short.takeHeld()).toContain('abab');
  });

  it('withholds the rest of a stream whose overflowed open match meets a value change', async () => {
    await store.put(scope, { RUN: 'abab' });
    const backstop = new ChatSecretStorageBackstop(scope, root);
    const before = run(backstop, [delta(`x ${'ab'.repeat(40_000)}`, 0, 'a')]);
    // A new value overlapping the run's end, given mid-stream.
    await store.put(scope, { NEW: 'abab-tail-unique-secret' });
    const after = run(backstop, [
      delta('-tail-unique-secret end', 0, 'b'),
      delta(' more', 0, 'c'),
      {
        type: 'stream_event',
        uuid: 'stop',
        parent_tool_use_id: null,
        event: { type: 'content_block_stop', index: 0 },
      },
    ]);
    const joined = [...before, ...after].map(deltaText).join('');
    expect(joined).not.toContain('tail-unique');
    expect(joined).not.toContain('abab');
    expect(joined).toBe('x [secret:RUN]');
  });

  it('keeps a redacted delegation within the protocol limits', () => {
    const backstop = new ChatSecretStorageBackstop(scope, root);
    // Just under the 200-character limit, a 5-character value in it: its
    // placeholder is longer than the value.
    const description = `${'d'.repeat(190)} ${SHORT_CANARY} x`;
    expect(description.length).toBeLessThanOrEqual(200);
    const delegation = {
      delegationId: 'del-2',
      runGeneration: 1,
      sequence: 1,
      createdAt: 1,
      parentHarnessId: 'claude',
      parentTurnId: 'turn-1',
      parentToolCallId: 'call-1',
      task: { description, prompt: 'go', executionMode: 'background' },
      snapshot: {
        delegationId: 'del-2',
        status: 'running',
        outputTruncated: false,
        requestedModelId: 'model-1',
      },
      transcript: [],
    };
    expect(isAgentDelegationTranscript(delegation)).toBe(true);
    const [event] = backstop.apply({
      type: 'canopy_delegation',
      delegation,
    }).events;
    const out = (event as { delegation: { task: { description: string } } })
      .delegation;
    expect(isAgentDelegationTranscript(out)).toBe(true);
    expect(JSON.stringify(out)).not.toContain(SHORT_CANARY);
    expect(out.task.description.length).toBeLessThanOrEqual(200);
    expect(out.task.description).not.toMatch(/\[secret:[A-Z_]*$/);
  });

  it("keeps a delegation's protocol numbers, and drops one that can't stay valid", async () => {
    await store.put(scope, { COUNT: '424242' });
    const delegation = {
      delegationId: 'del-3',
      runGeneration: 1,
      sequence: 424242,
      createdAt: 424242,
      parentHarnessId: 'claude',
      parentTurnId: 'turn-1',
      parentToolCallId: 'call-1',
      task: { description: 'count', prompt: 'go', executionMode: 'background' },
      snapshot: {
        delegationId: 'del-3',
        status: 'running',
        outputTruncated: false,
        requestedModelId: 'model-1',
        usage: { inputTokens: 424242 },
      },
      transcript: [
        {
          id: 'i-1',
          sequence: 424242,
          occurredAt: 424242,
          type: 'text',
          text: 'counted 424242',
        },
      ],
    };
    expect(isAgentDelegationTranscript(delegation)).toBe(true);
    const kept = new ChatSecretStorageBackstop(scope, root).apply({
      type: 'canopy_delegation',
      delegation,
    });
    expect(kept.refused).toBeUndefined();
    const out = (kept.events[0] as { delegation: typeof delegation })
      .delegation;
    expect(isAgentDelegationTranscript(out)).toBe(true);
    expect([
      out.sequence,
      out.createdAt,
      out.snapshot.usage.inputTokens,
      out.transcript[0]?.sequence,
      out.transcript[0]?.occurredAt,
    ]).toEqual([424242, 424242, 424242, 424242, 424242]);
    // Its text is redacted as any other.
    expect(out.transcript[0]?.text).toBe('counted [secret:COUNT]');
    // A value equal to an enum field the backstop doesn't know (a steer's
    // delivery) leaves the redacted snapshot invalid: it goes on as its
    // refused projection, redacted, never undefined.
    await store.put(scope, { WORD: 'steer' });
    const steered = {
      ...delegation,
      transcript: [{ ...delegation.transcript[0], delivery: 'steer' }],
    };
    expect(isAgentDelegationTranscript(steered)).toBe(true);
    const fallback = new ChatSecretStorageBackstop(scope, root).apply({
      type: 'canopy_delegation',
      delegation: steered,
    });
    expect(fallback.events).toHaveLength(1);
    expect(fallback.events[0]).toMatchObject({
      type: 'canopy_delegation',
      delegation: { delegationId: 'del-3', sequence: 424242, transcript: [] },
    });
    // One whose refused projection is invalid too is dropped, and recorded.
    const commanded = {
      ...delegation,
      snapshot: {
        ...delegation.snapshot,
        control: {
          operationId: 'op-1',
          operation: 'steer',
          status: 'completed',
        },
      },
    };
    expect(isAgentDelegationTranscript(commanded)).toBe(true);
    const dropped = new ChatSecretStorageBackstop(scope, root).apply({
      type: 'canopy_delegation',
      delegation: commanded,
    });
    expect(dropped.events).toEqual([]);
    expect(dropped.refused).toBe('delegation_unredactable');
  });

  it('redacts a value split across Codex plan deltas', () => {
    const backstop = new ChatSecretStorageBackstop(scope, root);
    let text = '';
    const pieces = [`plan ${CANARY.slice(0, 12)}`, CANARY.slice(12), ' end'];
    const out = run(
      backstop,
      pieces.map((delta) => {
        text += delta;
        return {
          type: 'codex',
          event: { type: 'item.plan.delta', item_id: 'plan-1', delta, text },
        };
      }),
    );
    for (const event of out) {
      expectNoCanary(JSON.stringify(event));
      expect(JSON.stringify(event)).not.toContain(CANARY.slice(0, 12));
    }
  });

  it("releases a Codex plan's held tail, redacted, when its turn ends without the completed item", () => {
    for (const end of ['turn.failed', 'turn.completed', 'turn.cancelled']) {
      const backstop = new ChatSecretStorageBackstop(scope, root);
      let text = '';
      const out = run(backstop, [
        ...[`plan ${CANARY.slice(0, 12)}`, `${CANARY.slice(12)} to`].map(
          (delta) => {
            text += delta;
            return {
              type: 'codex',
              event: {
                type: 'item.plan.delta',
                item_id: 'plan-1',
                thread_id: 't-1',
                delta,
                text,
              },
            };
          },
        ),
        { type: 'codex', event: { type: end, thread_id: 't-1' } },
      ]);
      expectNoCanary(JSON.stringify(out));
      const deltas = out.flatMap((event) => {
        const inner = (event as { event?: { type?: string; delta?: unknown } })
          .event;
        return inner?.type === 'item.plan.delta' &&
          typeof inner.delta === 'string'
          ? [inner.delta]
          : [];
      });
      expect([end, deltas.join('')]).toEqual([
        end,
        'plan [secret:API_TOKEN] to',
      ]);
      // The release comes before the turn's end.
      expect(out[out.length - 1]).toMatchObject({ event: { type: end } });
    }
  });

  it("keeps a root plan's stream open across a subagent thread's turn ending", () => {
    for (const end of ['turn.completed', 'turn.failed', 'turn.cancelled']) {
      const backstop = new ChatSecretStorageBackstop(scope, root);
      let text = '';
      const plan = (delta: string): Record<string, unknown> => {
        text += delta;
        return {
          type: 'codex',
          event: {
            type: 'item.plan.delta',
            item_id: 'plan-1',
            thread_id: 'thread-root',
            delta,
            text,
          },
        };
      };
      const out = run(backstop, [
        plan(`plan ${CANARY.slice(0, 12)}`),
        { type: 'codex', event: { type: end, thread_id: 'thread-child' } },
        plan(`${CANARY.slice(12)} end`),
        { type: 'codex', event: { type: end, thread_id: 'thread-root' } },
      ]);
      expectNoCanary(JSON.stringify(out));
      const deltas = out.flatMap((event) => {
        const inner = (event as { event?: { type?: string; delta?: unknown } })
          .event;
        return inner?.type === 'item.plan.delta' &&
          typeof inner.delta === 'string'
          ? [inner.delta]
          : [];
      });
      // Nothing released at the child's end: the root's two deltas and its
      // tail at the root's end.
      expect([end, deltas.join(''), deltas.length]).toEqual([
        end,
        'plan [secret:API_TOKEN] end',
        3,
      ]);
    }
  });

  it('withholds a stream refused mid-value until its boundary, after the values are readable again', () => {
    const backstop = new ChatSecretStorageBackstop(scope, root);
    const stop = (index: number): Record<string, unknown> => ({
      type: 'stream_event',
      uuid: `stop-${String(index)}`,
      parent_tool_use_id: null,
      event: { type: 'content_block_stop', index },
    });
    const out: unknown[] = [];
    const take = (event: unknown): void => {
      out.push(...backstop.apply(event).events);
    };
    take(delta(`key ${CANARY.slice(0, 12)}`, 0, 'a'));
    // The store can't be read for a while: block 0 is open, block 1 opens.
    setChatSecretStoreForTests(storeAt('unread'));
    take(delta('more', 0, 'b'));
    take(delta(`pin ${CANARY.slice(0, 10)}`, 1, 'c'));
    setChatSecretStoreForTests(store);
    take(delta(`${CANARY.slice(12)} end`, 0, 'd'));
    take(delta(`${CANARY.slice(10)} end`, 1, 'e'));
    take(stop(0));
    take(stop(1));
    // Both blocks end before anything of the value is released.
    const joined = out.map(deltaText).join('');
    expect(joined).not.toContain(CANARY.slice(12));
    expect(joined).not.toContain(CANARY.slice(10));
    expectNoCanary(JSON.stringify(out));
    // A block after the boundary streams as usual.
    const after = run(backstop, [delta(`new ${CANARY} ok`, 0, 'f'), stop(0)]);
    expect(after.map(deltaText).join('')).toBe('new [secret:API_TOKEN] ok');
  });

  it("releases a Codex item's held tail, redacted, when its thread's turn ends without the item", () => {
    for (const end of [
      { type: 'turn.failed', thread_id: 't-1' },
      { type: 'turn.completed', thread_id: 't-1', status: 'interrupted' },
    ]) {
      const backstop = new ChatSecretStorageBackstop(scope, root);
      const item = (output: string): Record<string, unknown> => ({
        type: 'codex',
        event: {
          type: 'item.updated',
          thread_id: 't-1',
          item: {
            id: 'cmd-1',
            type: 'command_execution',
            aggregated_output: output,
          },
        },
      });
      const out = run(backstop, [
        item('fatal: permission'),
        item(`fatal: permission denied for ${CANARY}`),
        // Another thread's turn ending leaves it open.
        { type: 'codex', event: { type: end.type, thread_id: 't-2' } },
        { type: 'codex', event: end },
      ]);
      expectNoCanary(JSON.stringify(out));
      const outputs = out.flatMap((event) => {
        const inner = (
          event as { event?: { item?: { aggregated_output?: unknown } } }
        ).event;
        return typeof inner?.item?.aggregated_output === 'string'
          ? [inner.item.aggregated_output]
          : [];
      });
      expect([end.type, outputs.at(-1)]).toEqual([
        end.type,
        'fatal: permission denied for [secret:API_TOKEN]',
      ]);
      expect(out.at(-1)).toMatchObject({ event: end });
    }
  });

  it('releases held text through the values recorded when its stream ends', async () => {
    const backstop = new ChatSecretStorageBackstop(scope, root);
    const late = 'canary-arrives-late';
    const held = run(backstop, [delta(`tail ${late.slice(0, 9)}`)]);
    // The value is recorded after its start was held back, before the stop.
    await store.put(scope, { ARRIVES: late });
    const rest = run(backstop, [
      delta(late.slice(9)),
      {
        type: 'stream_event',
        uuid: 'stop',
        parent_tool_use_id: null,
        event: { type: 'content_block_stop', index: 0 },
      },
    ]);
    expect([...held, ...rest].map(deltaText).join('')).toBe(
      'tail [secret:ARRIVES]',
    );
  });

  it('masks a value given while a stream was open', async () => {
    const backstop = new ChatSecretStorageBackstop(scope, root);
    const late = 'canary-late-value-9c2d1f';
    const before = run(backstop, [delta('start ', 0, 'a')]);
    await store.put(scope, { LATE: late });
    const after = run(backstop, [
      delta(`then ${late} end`, 0, 'b'),
      { type: 'result', subtype: 'success', result: `done ${late}` },
    ]);
    const all = [...before, ...after];
    expect(JSON.stringify(all)).not.toContain(late);
    expect(all.map(deltaText).join('')).toBe('start then [secret:LATE] end');
  });

  it('redacts Codex text in progress with its tail held back, and a completed item whole', () => {
    const backstop = new ChatSecretStorageBackstop(scope, root);
    const full = `output ${CANARY} done`;
    const update = (text: string, type = 'item.updated'): unknown => ({
      type: 'codex',
      event: {
        type,
        item: {
          id: 'item-1',
          type: 'command_execution',
          aggregated_output: text,
        },
      },
    });
    for (const length of [10, 20, 30, full.length]) {
      const [event] = run(backstop, [update(full.slice(0, length))]);
      expectNoCanary(JSON.stringify(event));
      expect(JSON.stringify(event)).not.toContain('canary-7f3e');
    }
    const [done] = run(backstop, [update(full, 'item.completed')]);
    expect(
      (done as { event: { item: { aggregated_output: string } } }).event.item
        .aggregated_output,
    ).toBe('output [secret:API_TOKEN] done');
  });

  it('redacts a value in a tool input field named like a protocol field', () => {
    const backstop = new ChatSecretStorageBackstop(scope, root);
    const [event] = run(backstop, [
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'msg-1',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-9',
              name: 'Bash',
              // A lower-case value, shaped like a protocol token.
              input: { status: CANARY, nested: { type: CANARY } },
            },
          ],
        },
      },
    ]);
    expectNoCanary(JSON.stringify(event));
    const message = (
      event as { type: string; message: { content: Array<{ type: string }> } }
    ).message;
    expect((event as { type: string }).type).toBe('assistant');
    expect(message.content[0]?.type).toBe('tool_use');
  });

  it("withholds every event while a recorded value can't be read back", async () => {
    const backstop = new ChatSecretStorageBackstop(scope, root);
    run(backstop, [delta(`held ${CANARY.slice(0, 12)}`)]);
    const failing = {
      ...xorEncryption,
      decrypt: (): string => {
        throw new Error('locked');
      },
    };
    const locked = storeAt('store', { encryption: failing });
    setChatSecretStoreForTests(locked);
    await locked.ensureLoaded();
    const result = backstop.apply(delta(`${CANARY.slice(12)} more`));
    // The event is dropped.
    expect(result.refused).toBe('values_unreadable');
    expect(result.events).toEqual([]);
    // The turn's result goes on without its text, so the turn still settles.
    const ended = backstop.apply({
      type: 'result',
      subtype: 'success',
      session_id: 's-1',
      result: `done ${CANARY}`,
      usage: { output_tokens: 12 },
      canopy_child_tool_liveness: {
        kind: 'known',
        liveParentToolUseIds: ['toolu_live_1'],
        hasUncorrelatedLiveTask: false,
      },
      permission_denials: [{ tool_input: { command: CANARY } }],
      future_field: CANARY,
    });
    expect(ended.refused).toBe('values_unreadable');
    // Kept to the result's allowlist: the live child tool ids that settle
    // background subagents stay, unknown fields (a new one too) go.
    expect(ended.events).toEqual([
      {
        type: 'result',
        subtype: 'success',
        session_id: 's-1',
        result: '',
        usage: { output_tokens: 12 },
        canopy_child_tool_liveness: {
          kind: 'known',
          liveParentToolUseIds: ['toolu_live_1'],
          hasUncorrelatedLiveTask: false,
        },
      },
    ]);
    // An event kind that settles nothing is dropped.
    expect(
      backstop.apply({ type: 'system', subtype: 'status', note: CANARY })
        .events,
    ).toEqual([]);
    // A session's start keeps its id, so a child's completion stays a
    // child's; a task notification's result stays nonterminal.
    expect(
      backstop.apply({
        type: 'system',
        subtype: 'init',
        session_id: 'thread-1',
        cwd: `/w/${CANARY}`,
      }).events,
    ).toEqual([{ type: 'system', subtype: 'init', session_id: 'thread-1' }]);
    expect(
      backstop.apply({
        type: 'result',
        subtype: 'success',
        result: `note ${CANARY}`,
        canopy_session_continues: true,
      }).events,
    ).toEqual([
      {
        type: 'result',
        subtype: 'success',
        result: '',
        canopy_session_continues: true,
      },
    ]);
    // A turn's fixed outcome and its terminal reason settle it as it ended.
    expect(
      backstop.apply({
        type: 'result',
        subtype: 'error_during_execution',
        result: 'Turn cancelled',
        terminal_reason: 'aborted_streaming',
      }).events,
    ).toEqual([
      {
        type: 'result',
        subtype: 'error_during_execution',
        result: 'Turn cancelled',
        terminal_reason: 'aborted_streaming',
      },
    ]);
    const codexEnd = backstop.apply({
      type: 'codex',
      event: { type: 'turn.failed', error: { message: `bad ${CANARY}` } },
    });
    expect(codexEnd.events).toEqual([
      { type: 'codex', event: { type: 'turn.failed', error: { message: '' } } },
    ]);
    const failed = backstop.apply({
      type: 'error',
      error: { message: `failed ${CANARY}` },
      session_id: 's-1',
    });
    expect(failed.events).toEqual([
      { type: 'error', error: { message: '' }, session_id: 's-1' },
    ]);
    // What the stream held is dropped, never released unredacted.
    setChatSecretStoreForTests(store);
    const after = backstop.apply({ type: 'result', result: 'ok' });
    expect(after.events).toHaveLength(1);
    expectNoCanary(JSON.stringify(after.events));
  });
});

describe('storage backstop scope', () => {
  it('refuses where a secrets file a damaged store lost is', async () => {
    await store.registerSecretFile(scope, join(realpathSync(root), '.env.x'), [
      { name: 'API_TOKEN', value: CANARY },
    ]);
    writeFileSync(join(dir, 'store', 'chat-secrets.json'), '{ not json');
    const damaged = storeAt('store');
    setChatSecretStoreForTests(damaged);
    await damaged.ensureLoaded();
    const result = new ChatSecretStorageBackstop(scope, root).apply({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'm-9', content: [{ type: 'text', text: 'hello' }] },
    });
    expect(result.refused).toBe('values_unreadable');
    expect(result.events).toEqual([]);
  });

  it("keeps delivering when only another worktree's value can't be read back, and redacts other chats' values", async () => {
    const otherChat: ChatSecretScope = {
      projectId: 'project-2',
      worktreeId: 'worktree-7',
      chatId: 'chat-7',
    };
    await store.put(otherChat, { ELSEWHERE: 'canary-elsewhere-value-41' });
    const backstop = new ChatSecretStorageBackstop(scope, root);
    const [event] = backstop.apply({
      type: 'result',
      result: 'saw canary-elsewhere-value-41',
    }).events;
    expect(JSON.stringify(event)).toContain('[secret:ELSEWHERE]');
    // A marker without a value (kept in memory only, lost on restart) in
    // another worktree: views refuse, but this chat's events still flow.
    await store.registerSecretFile(otherChat, join(dir, 'elsewhere.env'), [
      { name: 'GONE', value: 'canary-memory-only-41' },
    ]);
    const restarted = new ChatSecretStore({
      filePath: (): string => join(dir, 'store', 'chat-secrets.json'),
      auditFilePath: (): string => join(dir, 'store', 'audit.jsonl'),
      encryption: {
        ...xorEncryption,
        decrypt: (ciphertext: Buffer): string => {
          const text = xorEncryption.decrypt(ciphertext);
          if (text === 'canary-memory-only-41') throw new Error('lost');
          return text;
        },
      },
    });
    setChatSecretStoreForTests(restarted);
    await restarted.ensureLoaded();
    const result = new ChatSecretStorageBackstop(scope, root).apply({
      type: 'result',
      result: `held ${CANARY}`,
    });
    expect('refused' in result).toBe(false);
    expectNoCanary(JSON.stringify(result.events));
  });

  it('resolves its folder through links before matching the secrets files under it', async () => {
    const otherChat: ChatSecretScope = {
      projectId: 'project-2',
      worktreeId: 'worktree-8',
      chatId: 'chat-8',
    };
    // A Cowork task of the same folder records a file by its resolved path.
    await store.registerSecretFile(
      otherChat,
      join(realpathSync(root), '.env.shared'),
      [{ name: 'SHARED', value: 'canary-folder-only-51' }],
    );
    const restarted = new ChatSecretStore({
      filePath: (): string => join(dir, 'store', 'chat-secrets.json'),
      auditFilePath: (): string => join(dir, 'store', 'audit.jsonl'),
      encryption: {
        ...xorEncryption,
        decrypt: (ciphertext: Buffer): string => {
          const text = xorEncryption.decrypt(ciphertext);
          if (text === 'canary-folder-only-51') throw new Error('lost');
          return text;
        },
      },
    });
    setChatSecretStoreForTests(restarted);
    await restarted.ensureLoaded();
    // The session's folder, reached through a link.
    const link = join(dir, 'linked-worktree');
    symlinkSync(root, link);
    const backstop = await ChatSecretStorageBackstop.forSession(scope, link);
    const result = backstop.apply({ type: 'result', result: 'hello' });
    expect(result.refused).toBe('values_unreadable');
  });
});

describe('storage backstop shapes', () => {
  it('keeps routing id lists whole unless an id is wholly a value', () => {
    const backstop = new ChatSecretStorageBackstop(scope, root);
    // A live tool id that merely contains the PIN, in a list and alone.
    const id = `toolu_${SHORT_CANARY}abc`;
    const [ended] = backstop.apply({
      type: 'canopy_child_tools_ended',
      parent_tool_use_ids: [id, SHORT_CANARY],
    }).events;
    expect(ended).toMatchObject({
      parent_tool_use_ids: [id, '[secret:PIN]'],
    });
    const [result] = backstop.apply({
      type: 'result',
      parent_tool_use_id: id,
      canopy_child_tool_liveness: {
        kind: 'known',
        liveParentToolUseIds: [id],
        hasUncorrelatedLiveTask: false,
      },
    }).events;
    expect(result).toMatchObject({
      parent_tool_use_id: id,
      canopy_child_tool_liveness: { liveParentToolUseIds: [id] },
    });
  });

  it("redacts a value under a tool's structured result, and a protocol field that is wholly a value", async () => {
    await store.put(scope, { TOKENISH: 'canary-token-shaped-61' });
    const backstop = new ChatSecretStorageBackstop(scope, root);
    const value = 'canary-token-shaped-61';
    const out = backstop.apply({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't-1', content: 'ok' }],
      },
      tool_use_result: {
        status: value,
        session_id: value,
        stdout: `printed ${value}`,
      },
      toolUseResult: { kind: value },
    }).events;
    const result = backstop.apply({ type: 'result', subtype: value }).events;
    expect(JSON.stringify([...out, ...result])).not.toContain(value);
    // A protocol token that only contains a value's text stays as it is.
    expect(
      backstop.apply({ type: 'result', subtype: 'success' }).events[0],
    ).toMatchObject({ subtype: 'success' });
  });

  it("redacts a tool block's input and output in an assistant patch", () => {
    const backstop = new ChatSecretStorageBackstop(scope, root);
    const [event] = backstop.apply({
      type: 'canopy_assistant_patch',
      messageId: 'turn-1:t',
      revision: 1,
      patches: [
        {
          index: 1,
          block: {
            type: 'tool_use',
            id: 'call-1',
            name: 'Shell',
            input: { command: `echo ${CANARY}` },
            display: { input: CANARY },
          },
        },
        {
          index: 2,
          block: { type: 'tool_result', tool_use_id: 'call-1', output: CANARY },
        },
      ],
    }).events;
    expectNoCanary(JSON.stringify(event));
    expect(JSON.stringify(event)).toContain('[secret:API_TOKEN]');
  });

  it('keeps a pickup event routable when the values can not be read back', async () => {
    const failing = {
      ...xorEncryption,
      decrypt: (): string => {
        throw new Error('locked');
      },
    };
    const locked = storeAt('store', { encryption: failing });
    setChatSecretStoreForTests(locked);
    await locked.ensureLoaded();
    const pickup = {
      type: 'canopy_input_delivery',
      provider: 'claude',
      generation: 'gen-7f',
      attemptId: 'attempt-1',
      phase: 'picked-up',
      startsTurn: true,
      userMessageId: 'user-1',
    };
    const result = new ChatSecretStorageBackstop(scope, root).apply(pickup);
    expect(result.refused).toBe('values_unreadable');
    expect(result.events).toEqual([pickup]);
    // A field outside its kind's allowlist is stripped.
    expect(
      new ChatSecretStorageBackstop(scope, root).apply({
        ...pickup,
        note: CANARY,
      }).events,
    ).toEqual([pickup]);
  });
});

describe('storage backstop payloads', () => {
  it('redacts a value used as a property name in a tool payload', () => {
    const backstop = new ChatSecretStorageBackstop(scope, root);
    const [event] = backstop.apply({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'm-2',
        content: [
          {
            type: 'tool_use',
            id: 't-2',
            name: 'Write',
            input: { headers: { [CANARY]: 'x', [`k-${SHORT_CANARY}`]: 'y' } },
          },
        ],
      },
    }).events;
    expectNoCanary(JSON.stringify(event));
  });

  it('drops a subtree nested past the redaction depth', () => {
    let nested: unknown = { secret: CANARY };
    for (let depth = 0; depth < 80; depth++) nested = { next: nested };
    const [event] = new ChatSecretStorageBackstop(scope, root).apply({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'm-4',
        content: [{ type: 'tool_use', id: 't-4', name: 'X', input: nested }],
      },
    }).events;
    expectNoCanary(JSON.stringify(event));
  });

  it('redacts a value that is a number by its string form', async () => {
    await store.put(scope, { PIN_CODE: '73914' });
    const [event] = new ChatSecretStorageBackstop(scope, root).apply({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'm-3',
        content: [
          {
            type: 'tool_use',
            id: 't-3',
            name: 'Http',
            input: { code: 73914, codes: [1739140] },
          },
        ],
      },
      usage: { output_tokens: 1739140 },
    }).events;
    const text = JSON.stringify(event);
    // Outside a tool's payload, only a number that is wholly the value.
    expect(text).toContain('"usage":{"output_tokens":1739140}');
    expect(text).toContain('"code":"[secret:PIN_CODE]"');
    expect(text).toContain('"codes":["1[secret:PIN_CODE]0"]');
  });

  it("keeps a delegation snapshot settling, without its text, when values can't be read back", async () => {
    const failing = {
      ...xorEncryption,
      decrypt: (): string => {
        throw new Error('locked');
      },
    };
    const locked = storeAt('store', { encryption: failing });
    setChatSecretStoreForTests(locked);
    await locked.ensureLoaded();
    const delegation = {
      delegationId: 'del-1',
      runGeneration: 1,
      sequence: 3,
      createdAt: 1,
      parentHarnessId: 'claude',
      parentTurnId: 'turn-1',
      parentToolCallId: 'call-1',
      task: {
        description: `About ${CANARY}`,
        prompt: `Use ${CANARY}`,
        executionMode: 'background',
      },
      snapshot: {
        delegationId: 'del-1',
        status: 'completed',
        outputTruncated: false,
        requestedModelId: 'model-1',
        finalText: `Done ${CANARY}`,
        stoppedBy: { kind: 'agent', depth: 0, description: `Stop ${CANARY}` },
        error: { code: 'failed', message: `bad ${CANARY}`, retryable: false },
        control: {
          operationId: 'op-1',
          operation: 'steer',
          status: 'failed',
          error: `bad ${CANARY}`,
          applyFailure: {
            reason: 'parent_changed',
            issues: [{ path: 'a.txt', parentDiff: `-KEY=${CANARY}` }],
            guidance: 'Apply again.',
          },
        },
      },
      transcript: [
        { id: 'i-1', sequence: 1, occurredAt: 1, type: 'text', text: CANARY },
      ],
    };
    const result = new ChatSecretStorageBackstop(scope, root).apply({
      type: 'canopy_delegation',
      delegation,
      canopy_replay: true,
    });
    expect(result.refused).toBe('values_unreadable');
    expect(result.events).toHaveLength(1);
    expectNoCanary(JSON.stringify(result.events));
    expect(
      isAgentDelegationTranscript(
        (result.events[0] as { delegation: unknown }).delegation,
      ),
    ).toBe(true);
    expect(result.events[0]).toMatchObject({
      type: 'canopy_delegation',
      canopy_replay: true,
      delegation: {
        delegationId: 'del-1',
        snapshot: { status: 'completed' },
        transcript: [],
      },
    });
    // Any other event is dropped.
    expect(
      new ChatSecretStorageBackstop(scope, root).apply({
        type: 'canopy_delegation',
        title: `About ${CANARY}`,
      }).events,
    ).toEqual([]);
  });
});

/*
 * The refused projection's censuses against what consumers read: the
 * router's turn readers (chat-turn-audit), the transcript reducers, the
 * Portal's terminal check, child-tool liveness and the app events' own
 * validators run over recording events of every kept kind. Each field they
 * read must be one the kind's census keeps or strips with a reason, and
 * each decision they make must survive the projection. The census's
 * coverage of the app's canopy_* stamps and event types is
 * check:refused-event-census.
 */
describe('storage backstop refused census', () => {
  /** An event that records every field path read from it. */
  function recording(
    value: Record<string, unknown>,
    reads: Set<string>,
    prefix = '',
  ): Record<string, unknown> {
    const wrap = (item: unknown, path: string): unknown =>
      typeof item === 'object' && item !== null
        ? new Proxy(item, handler(path))
        : item;
    const handler = (path: string): ProxyHandler<object> => ({
      get(target, key, receiver) {
        const item: unknown = Reflect.get(target, key, receiver);
        if (typeof key !== 'string') return item;
        if (Array.isArray(target))
          return /^\d+$/.test(key) ? wrap(item, path) : item;
        if (!Object.hasOwn(target, key) && key in Object.prototype) return item;
        if (key === 'toJSON' || key === 'then') return item;
        reads.add(`${path}${key}`);
        return wrap(item, `${path}${key}.`);
      },
      has(target, key) {
        if (typeof key === 'string' && !Array.isArray(target))
          reads.add(`${path}${key}`);
        return Reflect.has(target, key);
      },
    });
    return new Proxy<Record<string, unknown>>(value, handler(prefix));
  }

  /** Whether `path` is a field `census` keeps or strips with a reason. */
  function classified(census: Fields, path: string): boolean {
    let fields: Fields = census;
    for (const key of path.split('.')) {
      if (!Object.hasOwn(fields, key)) return false;
      const rule = fields[key];
      if (typeof rule === 'string') return true;
      fields =
        'each' in rule && typeof rule.each === 'object' ? rule.each : rule;
    }
    return true;
  }

  /** A delegation event's census, as refusedDelegation keeps it. */
  function delegationClassified(path: string): boolean {
    const [top, field, inner] = path.split('.');
    if (top !== 'delegation')
      return classified(
        refusedCensus({ type: 'canopy_delegation' }) ?? {},
        path,
      );
    if (field === undefined) return true;
    if (!Object.hasOwn(DELEGATION_TRANSCRIPT, field)) return false;
    if (field !== 'snapshot' || inner === undefined) return true;
    return Object.hasOwn(DELEGATION_SNAPSHOT, inner);
  }

  function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  const ROOT_THREAD = 'thread-root';
  const ROOT_TURN = 'turn-root';
  let ids = 0;
  const reducerOptions = (): Parameters<
    typeof applyClaudeTranscriptEvent
  >[2] => ({
    now: 1,
    createMessageId: (): string => `m-${String((ids += 1))}`,
    childToolLiveness: { kind: 'unknown' },
    useNowAsTurnTimestamp: false,
  });

  /** What every consumer decides of an event: the projection must agree. */
  function decisions(data: Record<string, unknown>): unknown[] {
    // Only a Codex event's inner event is read here: the test itself reads
    // nothing a consumer doesn't.
    const event = data.type === 'codex' ? data.event : undefined;
    const reduced = isPlainRecord(event)
      ? applyCodexTranscriptEvent(
          createEmptyTranscriptReducerState(),
          event,
          reducerOptions(),
        )
      : applyClaudeTranscriptEvent(
          createEmptyTranscriptReducerState(),
          data,
          reducerOptions(),
        );
    return [
      getChatTurnAuditStatus(data),
      isTerminalChatEventData(data),
      isRootTerminalChatEventData(data, ROOT_THREAD, ROOT_TURN),
      readCodexRootThreadId(data),
      readCodexRootTurnId(data, ROOT_THREAD),
      isCodexSubagentTerminalEvent(data, ROOT_THREAD),
      isCodexSubagentFollowupEvent(data, ROOT_THREAD),
      isUserAbortResult(data),
      isPlanHandoffResult(data),
      isTerminalRuntimeChatEvent(data),
      readChildToolLivenessStamp(data),
      isCanopyAuthFailureEventData(data),
      isAiCreditsUsageLimitEventData(data),
      isAiCreditsNoBillingSourceEventData(data),
      isAiCreditsRoutingStatusEventData(data),
      isSetAutoArchiveRequestedEventData(data),
      isNoBillingSourceErrorEventData(data),
      reduced.status,
      reduced.usage?.contextWindow,
    ];
  }

  const text = `About ${CANARY}`;
  const routing = {
    uuid: 'u-1',
    session_id: 's-1',
    canopy_turn_user_message_id: 'msg-1',
    canopy_execution_turn_id: 'exec-1',
  };
  const authFailure = {
    dependencyClass: 'mcp',
    dependencyId: 'server-1',
    displayName: 'Linear',
    failureClass: 'expired',
    recovery: { kind: 'mcp_oauth', serverId: 'server-1', configId: 'cfg-1' },
    detail: text,
  };
  const FIXTURES: Record<string, Record<string, unknown>> = {
    'Claude result': {
      ...routing,
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      duration_ms: 10,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 2 },
      modelUsage: { 'model-1': { inputTokens: 1 } },
      total_cost_usd: 0.1,
      permission_denials: [
        { tool_name: 'Bash', tool_input: { command: text } },
      ],
      errors: [text],
      canopy_child_tool_liveness: {
        kind: 'known',
        liveParentToolUseIds: ['t-1'],
        hasUncorrelatedLiveTask: false,
      },
    },
    'aborted result': {
      ...routing,
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_streaming',
      result: text,
    },
    'cancelled result': {
      ...routing,
      type: 'result',
      subtype: 'cancelled',
      result: 'Turn cancelled',
    },
    'continuing result': {
      ...routing,
      type: 'result',
      subtype: 'success',
      result: text,
      canopy_session_continues: true,
    },
    'plan handoff result': {
      ...routing,
      type: 'result',
      subtype: 'success',
      result: text,
      canopy_plan_handoff: true,
    },
    'Codex failed result': {
      ...routing,
      type: 'result',
      subtype: 'codex_error',
      is_error: true,
      result: text,
      codexErrorInfo: 'usageLimitExceeded',
      canopy_model_access_failure: {
        kind: 'model_unsupported',
        model: 'gpt-x',
        modelLabel: 'GPT X',
      },
    },
    'error event': {
      ...routing,
      type: 'error',
      error: { type: 'api_error', message: text },
      canopy_display_error_code: 'claude_ai_credits_fallback',
    },
    'no billing source error': {
      ...routing,
      type: 'error',
      error_code: 'no_billing_source',
      error: text,
    },
    'session start': {
      ...routing,
      type: 'system',
      subtype: 'init',
      model: 'model-1',
      cwd: `/w/${CANARY}`,
      tools: ['Bash'],
    },
    'Codex thread started': {
      ...routing,
      type: 'codex',
      event: { type: 'thread.started', thread_id: ROOT_THREAD },
    },
    'Codex child thread started': {
      ...routing,
      type: 'codex',
      event: { type: 'thread.started', thread_id: 'thread-child' },
    },
    'Codex turn started': {
      ...routing,
      type: 'codex',
      event: {
        type: 'turn.started',
        thread_id: ROOT_THREAD,
        turn_id: ROOT_TURN,
      },
    },
    'Codex turn completed': {
      ...routing,
      type: 'codex',
      event: {
        type: 'turn.completed',
        thread_id: ROOT_THREAD,
        status: 'interrupted',
        usage: { input_tokens: 1 },
      },
    },
    'Codex child turn completed': {
      ...routing,
      type: 'codex',
      event: { type: 'turn.completed', thread_id: 'thread-child' },
    },
    'Codex turn failed': {
      ...routing,
      type: 'codex',
      event: {
        type: 'turn.failed',
        thread_id: ROOT_THREAD,
        error: { message: text },
      },
    },
    'Codex turn cancelled': {
      ...routing,
      type: 'codex',
      event: { type: 'turn.cancelled', thread_id: ROOT_THREAD },
    },
    'Codex error': {
      ...routing,
      type: 'codex',
      event: {
        type: 'error',
        thread_id: ROOT_THREAD,
        turn_id: 'turn-old',
        message: text,
      },
    },
    'input delivery': {
      type: 'canopy_input_delivery',
      provider: 'claude',
      generation: 'g-1',
      attemptId: 'a-1',
      phase: 'picked-up',
      startsTurn: true,
      userMessageId: 'msg-1',
    },
    'auth failure': {
      type: 'canopy_auth_failure',
      toolUseId: 't-1',
      failure: authFailure,
      failures: [authFailure],
    },
    'usage limit': {
      type: 'canopy_usage_limit_reached',
      provider: 'claude',
      resetsAt: 100,
    },
    'no billing source': {
      type: 'canopy_ai_credits_no_billing_source',
      provider: 'codex',
    },
    'credits routing': {
      type: 'canopy_ai_credits_routing',
      active: true,
      provider: 'claude',
    },
    'transient retry': {
      type: 'canopy_transient_retry_state',
      provider: 'claude',
      active: true,
      attempt: 1,
      maxAttempts: 3,
      nextRetryAt: 5,
      exhausted: false,
    },
    'auto archive': {
      type: 'canopy_set_auto_archive_requested',
      enabled: true,
    },
    'child tools ended': {
      type: 'canopy_child_tools_ended',
      parent_tool_use_ids: ['t-1'],
    },
    'turn usage': {
      type: 'canopy_turn_usage',
      provider: 'antigravity',
      usage: null,
    },
    delegation: {
      ...routing,
      type: 'canopy_delegation',
      canopy_replay: true,
      delegation: {
        delegationId: 'del-1',
        runGeneration: 1,
        sequence: 1,
        createdAt: 1,
        parentHarnessId: 'claude',
        parentTurnId: 'turn-1',
        parentToolCallId: 'call-1',
        task: { description: text, prompt: text, executionMode: 'background' },
        snapshot: {
          delegationId: 'del-1',
          status: 'completed',
          outputTruncated: false,
          requestedModelId: 'model-1',
          finalText: text,
        },
        transcript: [
          { id: 'i-1', sequence: 1, occurredAt: 1, type: 'text', text },
        ],
      },
    },
  };

  it('classifies every field the consumers read on each kept kind', () => {
    const unclassified: string[] = [];
    for (const [label, fixture] of Object.entries(FIXTURES)) {
      const census = refusedCensus(fixture);
      expect([label, census !== undefined]).toEqual([label, true]);
      const reads = new Set<string>();
      decisions(recording(fixture, reads));
      for (const path of reads)
        if (
          fixture.type === 'canopy_delegation'
            ? !delegationClassified(path)
            : !classified(census ?? {}, path)
        )
          unclassified.push(`${label}: ${path}`);
    }
    expect(unclassified).toEqual([]);
  });

  it('keeps every consumer decision, and no conversation text, through the projection', () => {
    for (const [label, fixture] of Object.entries(FIXTURES)) {
      const projected = refusedProjection(structuredClone(fixture));
      expect([label, typeof projected]).toEqual([label, 'object']);
      expect([
        label,
        decisions(isPlainRecord(projected) ? projected : {}),
      ]).toEqual([label, decisions(structuredClone(fixture))]);
      expectNoCanary(JSON.stringify(projected));
    }
  });
});
