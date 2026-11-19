import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ApprovalMode } from '@canopy/desktop-shared/types';
import type * as AtomicFileModule from '../../lib/atomic-file';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { IPC_REMOTE_DISPOSITIONS } from '@canopy/desktop-shared/remote-control/channel-dispositions';

let ambientDir = '';
jest.mock('../feature-gate', () => ({
  isAgentSecretRequestsEnabled: jest.fn(() => true),
}));
// Every values-file write, with the approval mode it was made in.
const valuesWrites: Array<{ mode: ApprovalMode; content: string }> = [];
jest.mock('../../lib/atomic-file', () => {
  const actual = jest.requireActual<typeof AtomicFileModule>(
    '../../lib/atomic-file',
  );
  return {
    ...actual,
    writeFileAtomically: (
      ...args: Parameters<typeof actual.writeFileAtomically>
    ): ReturnType<typeof actual.writeFileAtomically> => {
      if (String(args[0]).startsWith(ambientDir))
        valuesWrites.push({ mode, content: String(args[1]) });
      return actual.writeFileAtomically(...args);
    },
  };
});
jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<object>('../../lib/paths'),
  getAgentSecretAmbientEnvDir: (): string => ambientDir,
}));

import { isAgentSecretRequestsEnabled } from '../feature-gate';
import {
  CHAT_SECRET_TTL_MS,
  ChatSecretStore,
  setChatSecretStoreForTests,
  type ChatSecretScope,
} from '../chat-secret-store';
import {
  ambientSecretEnvStatus,
  ambientSecretModeChanged,
  isAmbientSecretName,
  openClaudeAmbientSecretEnv,
  openCodexAmbientSecretEnv,
  resetAmbientSecretEnvForTests,
  restartForAmbientSecrets,
  sweepStaleAmbientSecretEnv,
} from '../ambient-env';
import {
  listChatSecrets,
  restartChatForSecrets,
  revokeChatSecret,
} from '../secrets-chip';
import {
  CODEX_CANOPY_READ_ONLY_PROFILE,
  CODEX_DANGER_FULL_ACCESS_PROFILE,
  codexCanopyPermissionProfiles,
  codexDefaultPermissionsFor,
  codexSandboxDeniedReadPathsFor,
  codexThreadSandboxFields,
  codexThreadSandboxKind,
  codexNeedsSandboxReopen,
  codexTurnSandbox,
} from '../../codex/approval-policy';
import {
  CODEX_CONFINED_WORKSPACE_PROFILE,
  agentSecretAmbientEnvDirUnder,
  codexSandboxDeniedReadPaths,
  confineCodexThreadSandbox,
} from '@canopy/execution-engine/node/codex-runtime/confined-sandbox';
import {
  configureCodexRuntimeHostHooks,
  getCodexRuntimeHostHooks,
} from '@canopy/execution-engine/node/codex-runtime';
import {
  acquireDaemonPipelineCodexRuntime,
  shutdownDaemonPipelineCodexRuntime,
} from '@canopy/execution-engine/node/pipelines/daemon-host/codex-runtime';
import { buildCodexDelegationPermissionProfiles } from '../../agents/delegation/codex-sandbox-profile';
import { ambientSecretDenyRules } from '../ambient-env';
import { getBundledCodexBinaryPath } from '@canopy/execution-engine/pipelines/config-paths';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { resetDesktopExecutionSecretsForTests } from '../../execution-secrets/owner';
import { IPC_PRIVATE_CHANNELS } from '../../ipc/channel-policy';

/*
 * Full-access ambient secrets, the Secrets chip and other providers (U3):
 * in Full access a chat's held secrets reach the shell commands its agent
 * runs itself, from owner-only files outside the worktree that follow every
 * change; revoking or leaving Full access takes them away from the next
 * command; Codex, whose environment is fixed at spawn, offers Restart to
 * apply; the chip lists names and metadata only.
 */

const CANARY = 'canary-3b9d71c0-ambient';
const TRICKY = `canary-q'uote $HOME \`id\` "dq" \\ end`;
const scope: ChatSecretScope = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

let dir: string;
let mode: ApprovalMode;
let clock: number;
let store: ChatSecretStore;

function fakeEncryption(): {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(ciphertext: Buffer): string;
} {
  return {
    available: (): boolean => true,
    encrypt: (text): Buffer =>
      Buffer.from(Buffer.from(text, 'utf8').map((byte) => byte ^ 0x5a)),
    decrypt: (ciphertext): string =>
      Buffer.from(ciphertext.map((byte) => byte ^ 0x5a)).toString('utf8'),
  };
}

/** What a POSIX shell sees after sourcing the stub, as Claude does per command. */
function commandSees(stubPath: string, name: string): string {
  return execFileSync(
    '/bin/sh',
    ['-c', `. "$1"; printf '%s' "\${${name}-<unset>}"`, 'sh', stubPath],
    { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } },
  );
}

/** Waits for queued store work (file writes included) until `done` holds. */
async function settle(done: () => boolean = () => false): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
}

beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'agent-ambient-'));
  ambientDir = join(dir, 'ambient');
  mode = 'full-access';
  clock = Date.now();
  store = new ChatSecretStore({
    filePath: (): string => join(dir, 'chat-secrets.json'),
    auditFilePath: (): string => join(dir, 'audit.jsonl'),
    encryption: fakeEncryption(),
    now: (): number => clock,
  });
  setChatSecretStoreForTests(store);
  resetDesktopExecutionSecretsForTests();
  resetAmbientSecretEnvForTests();
  jest.mocked(isAgentSecretRequestsEnabled).mockReturnValue(true);
});

afterEach(() => {
  setChatSecretStoreForTests(null);
  resetAmbientSecretEnvForTests();
  rmSync(dir, { recursive: true, force: true });
});

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('Claude Full-access env file', () => {
  it('gives commands the held secrets from an owner-only file outside the worktree, and follows every change', async () => {
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    const ambient = await openClaudeAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
    });
    expect(ambient).not.toBeNull();
    if (!ambient) return;
    const stub = ambient.env.CLAUDE_ENV_FILE;
    expect(stub?.startsWith(ambientDir)).toBe(true);
    if (!stub) return;
    // The cached stub holds no value; only the file it sources does.
    expect(readFileSync(stub, 'utf8')).not.toContain(CANARY);
    expect(statSync(ambient.valuesPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(stub, '..')).mode & 0o777).toBe(0o700);
    expect(commandSees(stub, 'STRIPE_SECRET_KEY')).toBe(CANARY);
    expect(await ambientSecretEnvStatus(scope)).toBe('live');

    // Added mid-session: the next command has it, quoting intact.
    await store.put(scope, { DB_PASSWORD: TRICKY });
    await ambient.refresh();
    expect(commandSees(stub, 'DB_PASSWORD')).toBe(TRICKY);

    // Revoked: gone from the next command.
    expect(
      (await revokeChatSecret({ ...scope, name: 'STRIPE_SECRET_KEY' })).ok,
    ).toBe(true);
    // Revoke reports success only once the file no longer holds it.
    expect(commandSees(stub, 'STRIPE_SECRET_KEY')).toBe('<unset>');
    expect(readFileSync(ambient.valuesPath, 'utf8')).not.toContain(CANARY);

    // Leaving Full access deletes the values file before the change
    // resolves; coming back restores it.
    mode = 'ask';
    await ambientSecretModeChanged(scope);
    expect(existsSync(ambient.valuesPath)).toBe(false);
    await ambient.refresh();
    expect(existsSync(ambient.valuesPath)).toBe(false);
    expect(commandSees(stub, 'DB_PASSWORD')).toBe('<unset>');
    expect(await ambientSecretEnvStatus(scope)).toBe('off');
    mode = 'full-access';
    await ambientSecretModeChanged(scope);
    await ambient.refresh();
    expect(commandSees(stub, 'DB_PASSWORD')).toBe(TRICKY);

    // The chat ends: the whole launch directory goes.
    await ambient.dispose();
    expect(existsSync(join(stub, '..'))).toBe(false);
    expect(await ambientSecretEnvStatus(scope)).toBe('none');
  });

  it('deletes the values file when the last secret goes, and keeps an inherited env file working', async () => {
    const inherited = join(dir, 'user-env.sh');
    execFileSync('/bin/sh', [
      '-c',
      `printf 'export FROM_USER=yes\\n' > "$1"`,
      'sh',
      inherited,
    ]);
    await store.put(scope, { API_TOKEN: CANARY });
    const ambient = await openClaudeAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
      inheritedEnvFile: inherited,
    });
    if (!ambient?.env.CLAUDE_ENV_FILE) throw new Error('no ambient env');
    const stub = ambient.env.CLAUDE_ENV_FILE;
    expect(commandSees(stub, 'FROM_USER')).toBe('yes');
    await store.remove(scope);
    await ambient.refresh();
    expect(existsSync(ambient.valuesPath)).toBe(false);
    expect(commandSees(stub, 'API_TOKEN')).toBe('<unset>');
    await ambient.dispose();
  });

  it('drops a value from the next command once its seven days run out', async () => {
    await store.put(scope, { API_TOKEN: CANARY });
    const ambient = await openClaudeAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
    });
    if (!ambient?.env.CLAUDE_ENV_FILE) throw new Error('no ambient env');
    const stub = ambient.env.CLAUDE_ENV_FILE;
    expect(commandSees(stub, 'API_TOKEN')).toBe(CANARY);
    clock += CHAT_SECRET_TTL_MS + 1;
    store.noticeExpired();
    await ambient.refresh();
    expect(commandSees(stub, 'API_TOKEN')).toBe('<unset>');
    expect(existsSync(ambient.valuesPath)).toBe(false);
    await ambient.dispose();
  });

  it('never writes a session-only value to disk; Codex still gets it in memory', async () => {
    const SESSION = 'canary-session-only-5a1c';
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    await store.put(scope, { SESSION_TOKEN: SESSION }, { sessionOnly: true });
    const ambient = await openClaudeAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
    });
    if (!ambient?.env.CLAUDE_ENV_FILE) throw new Error('no ambient env');
    const onDisk = readFileSync(ambient.valuesPath, 'utf8');
    expect(onDisk).toContain('export STRIPE_SECRET_KEY=');
    expect(onDisk).not.toContain('SESSION_TOKEN');
    expect(onDisk).not.toContain(SESSION);
    expect(commandSees(ambient.env.CLAUDE_ENV_FILE, 'SESSION_TOKEN')).toBe(
      '<unset>',
    );
    await ambient.dispose();
    const codex = await openCodexAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
      restart: jest.fn(() => true),
    });
    expect(codex.env.SESSION_TOKEN).toBe(SESSION);
    codex.dispose();
  });

  it('never writes a value replaced by a session-only one while it is read', async () => {
    const SESSION = 'canary-swapped-session-7e2d';
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    // The refresh lists the secrets, then reads them: replace the value
    // with one kept in memory only in between.
    const describe = store.describe.bind(store);
    jest.spyOn(store, 'describe').mockImplementationOnce(async (listed) => {
      const secrets = await describe(listed);
      await store.put(
        scope,
        { STRIPE_SECRET_KEY: SESSION },
        { sessionOnly: true },
      );
      return secrets;
    });
    const ambient = await openClaudeAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
    });
    if (!ambient?.env.CLAUDE_ENV_FILE) throw new Error('no ambient env');
    const read = (): string => {
      try {
        return readFileSync(ambient.valuesPath, 'utf8');
      } catch {
        return '';
      }
    };
    expect(read()).not.toContain(SESSION);
    await settle();
    expect(read()).not.toContain(SESSION);
    expect(commandSees(ambient.env.CLAUDE_ENV_FILE, 'STRIPE_SECRET_KEY')).toBe(
      '<unset>',
    );
    await ambient.dispose();
  });

  it('publishes nothing when the chat leaves Full access while a rewrite reads', async () => {
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    const ambient = await openClaudeAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
    });
    if (!ambient?.env.CLAUDE_ENV_FILE) throw new Error('no ambient env');
    expect(commandSees(ambient.env.CLAUDE_ENV_FILE, 'STRIPE_SECRET_KEY')).toBe(
      CANARY,
    );
    // A new value starts a rewrite; the person leaves Full access while it
    // waits on its grant read.
    const original = store.readForExecution.bind(store);
    let modeChange: Promise<void> | undefined;
    jest
      .spyOn(store, 'readForExecution')
      .mockImplementationOnce(async (record, refs) => {
        const values = await original(record, refs);
        mode = 'ask';
        modeChange = ambientSecretModeChanged(scope);
        await modeChange;
        return values;
      });
    valuesWrites.length = 0;
    await store.put(scope, { SENTRY_DSN: 'canary-dsn-midread' });
    await settle(() => modeChange !== undefined);
    await modeChange;
    await ambient.refresh();
    // Nothing was written once the chat had left Full access.
    expect(
      valuesWrites.filter((write) => write.mode !== 'full-access'),
    ).toEqual([]);
    expect(existsSync(ambient.valuesPath)).toBe(false);
    expect(commandSees(ambient.env.CLAUDE_ENV_FILE, 'STRIPE_SECRET_KEY')).toBe(
      '<unset>',
    );
    expect(await ambientSecretEnvStatus(scope)).toBe('off');
    await ambient.dispose();
  });

  it("reports a revoke that can't take the value out of the file", async () => {
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    const ambient = await openClaudeAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
    });
    if (!ambient) throw new Error('no ambient env');
    const launchDir = dirname(ambient.valuesPath);
    chmodSync(launchDir, 0o500);
    try {
      const revoked = await revokeChatSecret({
        ...scope,
        name: 'STRIPE_SECRET_KEY',
      });
      expect(revoked.ok).toBe(false);
      expect(revoked.error).toContain('Stop the chat');
      expect(revoked.error).not.toContain(CANARY);
      // Shown in a notice that isn't blocked from session replay.
      expect(revoked.error).not.toContain('STRIPE_SECRET_KEY');
    } finally {
      chmodSync(launchDir, 0o700);
    }
    await ambient.dispose();
  });

  it('empties the values file when the chat ends, even while its session lives on', async () => {
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    const ambient = await openClaudeAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
    });
    if (!ambient?.env.CLAUDE_ENV_FILE) throw new Error('no ambient env');
    const stub = ambient.env.CLAUDE_ENV_FILE;
    expect(commandSees(stub, 'STRIPE_SECRET_KEY')).toBe(CANARY);
    // Archive or close: the store deletes the chat's secrets.
    await store.endChat(scope);
    await settle(() => !existsSync(ambient.valuesPath));
    expect(existsSync(ambient.valuesPath)).toBe(false);
    expect(commandSees(stub, 'STRIPE_SECRET_KEY')).toBe('<unset>');
    await ambient.dispose();
  });

  it('says off, not live, when Full access has nothing it may set', async () => {
    await store.put(scope, { OPENAI_API_KEY: CANARY });
    await store.put(scope, { SESSION_TOKEN: TRICKY }, { sessionOnly: true });
    const ambient = await openClaudeAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
    });
    if (!ambient) throw new Error('no ambient env');
    expect(existsSync(ambient.valuesPath)).toBe(false);
    expect(await ambientSecretEnvStatus(scope)).toBe('off');
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    await ambient.refresh();
    expect(await ambientSecretEnvStatus(scope)).toBe('live');
    await ambient.dispose();
  });

  it('is off outside Full access, with the flag off, and on Windows', async () => {
    mode = 'ask';
    expect(
      await openClaudeAmbientSecretEnv({ scope, getApprovalMode: () => mode }),
    ).toBeNull();
    mode = 'full-access';
    expect(
      await openClaudeAmbientSecretEnv({
        scope,
        getApprovalMode: () => mode,
        platform: 'win32',
      }),
    ).toBeNull();
    jest.mocked(isAgentSecretRequestsEnabled).mockReturnValue(false);
    expect(
      await openClaudeAmbientSecretEnv({ scope, getApprovalMode: () => mode }),
    ).toBeNull();
  });

  it('never sets names that steer the shell or the agent runtime', async () => {
    for (const name of [
      'PATH',
      'HOME',
      'BASH_ENV',
      'LD_PRELOAD',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'CODEX_HOME',
      'CLAUDE_ENV_FILE',
    ])
      expect(isAmbientSecretName(name)).toBe(false);
    expect(isAmbientSecretName('STRIPE_SECRET_KEY')).toBe(true);
    await store.put(scope, { PATH: CANARY, SAFE_NAME: CANARY });
    const ambient = await openClaudeAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
    });
    if (!ambient) throw new Error('no ambient env');
    const values = readFileSync(ambient.valuesPath, 'utf8');
    expect(values).toContain('export SAFE_NAME=');
    expect(values).not.toContain('export PATH=');
    await ambient.dispose();
  });

  it('sweeps launch directories a crash left behind, never a live one', async () => {
    mkdirSync(join(ambientDir, 'stale-launch'), { recursive: true });
    const ambient = await openClaudeAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
    });
    if (!ambient?.env.CLAUDE_ENV_FILE) throw new Error('no ambient env');
    await sweepStaleAmbientSecretEnv();
    expect(readdirSync(ambientDir)).toEqual([
      join(ambient.env.CLAUDE_ENV_FILE, '..').slice(ambientDir.length + 1),
    ]);
    await ambient.dispose();
  });
});

describe('Codex Full-access spawn env and Restart to apply', () => {
  it('puts held secrets in the spawn env and offers a restart for later ones', async () => {
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    const restart = jest.fn(() => true);
    const launch = await openCodexAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
      restart,
    });
    expect(launch.env).toEqual({ STRIPE_SECRET_KEY: CANARY });
    expect(await ambientSecretEnvStatus(scope)).toBe('live');

    // Given mid-thread: the running process can't get it; Restart to apply.
    await store.put(scope, { SENTRY_DSN: 'canary-dsn-value' });
    expect(await ambientSecretEnvStatus(scope)).toBe('restart');
    expect((await listChatSecrets(scope)).ambient).toBe('restart');
    expect(restart).not.toHaveBeenCalled();

    expect(restartChatForSecrets(scope)).toEqual({ ok: true });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(await ambientSecretEnvStatus(scope)).toBe('restart-pending');

    // The respawned process gets both, and the prompt clears.
    launch.dispose();
    const next = await openCodexAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
      restart,
    });
    expect(Object.keys(next.env).sort()).toEqual([
      'SENTRY_DSN',
      'STRIPE_SECRET_KEY',
    ]);
    expect(await ambientSecretEnvStatus(scope)).toBe('live');
    next.dispose();
  });

  it('restarts on its own when a secret its process holds is revoked or Full access ends', async () => {
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    const restart = jest.fn(() => true);
    const launch = await openCodexAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
      restart,
    });
    await revokeChatSecret({ ...scope, name: 'STRIPE_SECRET_KEY' });
    await settle(() => restart.mock.calls.length > 0);
    expect(restart).toHaveBeenCalledTimes(1);
    launch.dispose();

    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    const second = jest.fn(() => true);
    const relaunch = await openCodexAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
      restart: second,
    });
    mode = 'ask';
    await ambientSecretModeChanged(scope);
    await settle(() => second.mock.calls.length > 0);
    expect(second).toHaveBeenCalledTimes(1);
    relaunch.dispose();
  });

  it('restarts on its own when the chat ends', async () => {
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    const restart = jest.fn(() => true);
    const launch = await openCodexAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
      restart,
    });
    expect(launch.env).toEqual({ STRIPE_SECRET_KEY: CANARY });
    await store.endChat(scope);
    await settle(() => restart.mock.calls.length > 0);
    expect(restart).toHaveBeenCalledTimes(1);
    launch.dispose();
  });

  it('restarts once installed when a revoke came while its client was being built', async () => {
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    let installed = false;
    const restart = jest.fn(() => installed);
    const launch = await openCodexAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
      restart,
    });
    await revokeChatSecret({ ...scope, name: 'STRIPE_SECRET_KEY' });
    await settle(() => restart.mock.calls.length > 0);
    expect(await ambientSecretEnvStatus(scope)).not.toBe('restart-pending');
    installed = true;
    launch.attached();
    await settle(() => restart.mock.calls.length > 1);
    expect(restart).toHaveBeenCalledTimes(2);
    expect(await ambientSecretEnvStatus(scope)).toBe('restart-pending');
    launch.dispose();
  });

  it('gives every held secret, past the 64 one grant may carry', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [
        `SECRET_${String(index).padStart(2, '0')}`,
        `canary-many-${index}`,
      ]),
    );
    for (const batch of [0, 1, 2, 3])
      await store.put(
        scope,
        Object.fromEntries(
          Object.entries(many).slice(batch * 20, batch * 20 + 20),
        ),
      );
    expect((await store.listNames(scope)).length).toBe(70);
    const launch = await openCodexAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
      restart: jest.fn(() => true),
    });
    expect(launch.env).toEqual(many);
    expect(await ambientSecretEnvStatus(scope)).toBe('live');
    launch.dispose();
  });

  it('says off, and asks for no restart, for reserved names it never sets', async () => {
    await store.put(scope, { OPENAI_API_KEY: 'canary-reserved-openai' });
    const restart = jest.fn(() => true);
    const launch = await openCodexAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
      restart,
    });
    expect(launch.env).toEqual({});
    expect(await ambientSecretEnvStatus(scope)).toBe('off');
    await store.put(scope, { ANTHROPIC_API_KEY: 'canary-reserved-anthropic' });
    expect(await ambientSecretEnvStatus(scope)).toBe('off');
    // A secret it may set does ask, and so does a new value for it.
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    expect(await ambientSecretEnvStatus(scope)).toBe('restart');
    launch.dispose();
    const next = await openCodexAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
      restart,
    });
    expect(next.env).toEqual({ STRIPE_SECRET_KEY: CANARY });
    expect(await ambientSecretEnvStatus(scope)).toBe('live');
    await store.put(scope, { STRIPE_SECRET_KEY: 'canary-rotated-value' });
    expect(await ambientSecretEnvStatus(scope)).toBe('restart');
    expect(restart).not.toHaveBeenCalled();
    next.dispose();
  });

  it('gives nothing outside Full access and has nothing to restart without a launch', async () => {
    mode = 'ask';
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    const launch = await openCodexAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
      restart: jest.fn(() => true),
    });
    expect(launch.env).toEqual({});
    expect(await ambientSecretEnvStatus(scope)).toBe('off');
    launch.dispose();
    expect(restartForAmbientSecrets(scope)).toBe(false);
    expect(restartChatForSecrets(scope).ok).toBe(false);
  });
});

describe('changes while a Codex launch reads its values', () => {
  function interruptFirstRead(action: () => Promise<unknown> | void): void {
    const original = store.readForExecution.bind(store);
    jest
      .spyOn(store, 'readForExecution')
      .mockImplementationOnce(async (record, refs) => {
        const values = await original(record, refs);
        await action();
        return values;
      });
  }

  it('never spawns with a value revoked during the read', async () => {
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    interruptFirstRead(() =>
      revokeChatSecret({ ...scope, name: 'STRIPE_SECRET_KEY' }),
    );
    const launch = await openCodexAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
      restart: jest.fn(() => true),
    });
    expect(launch.env).toEqual({});
    // Nothing held, so nothing to set.
    expect(await ambientSecretEnvStatus(scope)).toBe('off');
    launch.dispose();
  });

  it('never spawns with values once the chat left Full access during the read', async () => {
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    interruptFirstRead(() => {
      mode = 'ask';
    });
    const launch = await openCodexAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
      restart: jest.fn(() => true),
    });
    expect(launch.env).toEqual({});
    expect(await ambientSecretEnvStatus(scope)).toBe('off');
    launch.dispose();
  });

  it('takes a value given during the read', async () => {
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    interruptFirstRead(() => store.put(scope, { SENTRY_DSN: 'canary-dsn' }));
    const launch = await openCodexAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
      restart: jest.fn(() => true),
    });
    expect(Object.keys(launch.env).sort()).toEqual([
      'SENTRY_DSN',
      'STRIPE_SECRET_KEY',
    ]);
    expect(await ambientSecretEnvStatus(scope)).toBe('live');
    launch.dispose();
  });
});

describe('expiry', () => {
  it("takes an expired value out of Codex's process at once, not at the hourly sweep", async () => {
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    const restart = jest.fn(() => true);
    const launch = await openCodexAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
      restart,
    });
    expect(launch.env).toEqual({ STRIPE_SECRET_KEY: CANARY });
    clock += CHAT_SECRET_TTL_MS + 1;
    store.noticeExpired();
    await settle(() => restart.mock.calls.length > 0);
    expect(restart).toHaveBeenCalledTimes(1);
    launch.dispose();
    // The respawned process started after the expiry; the hourly sweep that
    // deletes the expired entry later changes nothing it can use.
    const next = await openCodexAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
      restart: jest.fn(() => true),
    });
    expect(next.env).toEqual({});
    await store.sweepExpired();
    // No restart prompt: the chat holds nothing it may set.
    expect(await ambientSecretEnvStatus(scope)).toBe('off');
    next.dispose();
  });
});

describe('Restart to apply channel', () => {
  it('keeps the restart channel local and private', () => {
    expect(IPC_REMOTE_DISPOSITIONS.agentSecretsRestart).toBe('blocked');
    expect(IPC_PRIVATE_CHANNELS.has(IPC_CHANNELS.agentSecretsRestart)).toBe(
      true,
    );
  });
});

/** A TOML inline value, for passing a profile to `codex sandbox -c`. */
function toml(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .map(([key, child]) => `${JSON.stringify(key)}=${toml(child)}`)
      .join(',')}}`;
  throw new Error('unsupported TOML value');
}

describePosix("other chats can't read a chat's ambient secrets", () => {
  it("a second chat's sandboxed Codex can't read chat A's values file", async () => {
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    const ambient = await openClaudeAmbientSecretEnv({
      scope,
      getApprovalMode: () => mode,
    });
    if (!ambient) throw new Error('no ambient env');
    expect(readFileSync(ambient.valuesPath, 'utf8')).toContain(CANARY);

    // Exactly what a sandboxed (Ask or Accept edits) Codex chat runs with:
    // the profile is selected when the thread opens, and its turns send no
    // override (Codex can't switch a thread to a profile per turn). A thread
    // opened in Full access, which the chat reopens on leaving it, gets the
    // legacy read-only policy meanwhile.
    expect(codexThreadSandboxFields('ask', 'linux')).toEqual({
      permissions: CODEX_CANOPY_READ_ONLY_PROFILE,
    });
    expect(codexThreadSandboxKind('ask', 'linux')).toBe('profile');
    expect(codexThreadSandboxKind('full-access', 'linux')).toBe('legacy');
    expect(codexThreadSandboxKind('ask', 'win32')).toBe('legacy');
    expect(codexTurnSandbox('ask', dir, 'profile', 'linux')).toEqual({
      fields: {},
      threadKind: 'profile',
    });
    expect(codexTurnSandbox('ask', dir, 'legacy', 'linux')).toEqual({
      fields: { sandboxPolicy: { type: 'readOnly', networkAccess: false } },
      threadKind: 'legacy',
    });
    // A profile thread whose reopen is deferred: a Full-access turn's
    // override sticks in Codex, so the next Ask turn sends read-only again.
    let threadKind = codexThreadSandboxKind('ask', 'linux');
    for (const [turnMode, expected] of [
      ['ask', {}],
      ['full-access', { sandboxPolicy: { type: 'dangerFullAccess' } }],
      ['ask', { sandboxPolicy: { type: 'readOnly', networkAccess: false } }],
    ] as const) {
      const turn = codexTurnSandbox(turnMode, dir, threadKind, 'linux');
      expect(turn.fields).toEqual(expected);
      threadKind = turn.threadKind;
    }
    // Which is why the chat reopens such a thread before a sandboxed turn,
    // even when the reopen leaving Full access asked for is still deferred:
    // the legacy policy has no read deny.
    expect(codexNeedsSandboxReopen(threadKind, 'ask', 'linux')).toBe(true);
    expect(codexNeedsSandboxReopen('profile', 'ask', 'linux')).toBe(false);
    expect(codexNeedsSandboxReopen('legacy', 'full-access', 'linux')).toBe(
      false,
    );
    expect(codexNeedsSandboxReopen(null, 'ask', 'linux')).toBe(false);
    expect(codexNeedsSandboxReopen('legacy', 'ask', 'win32')).toBe(false);
    expect(codexThreadSandboxFields('full-access', 'linux')).toEqual({
      sandbox: 'danger-full-access',
    });
    // Every thread config that defines the profiles names its own sandbox
    // as the default, so a rebuild that drops the typed selection (native
    // ChatGPT routing) keeps it. One that defines profiles without a default
    // fails every request on Codex 0.169 (CAN-7253).
    expect(codexDefaultPermissionsFor('ask', 'linux')).toBe(
      CODEX_CANOPY_READ_ONLY_PROFILE,
    );
    for (const platform of ['linux', 'darwin'] as const) {
      expect(codexCanopyPermissionProfiles(platform)).not.toBeNull();
      expect(codexDefaultPermissionsFor('full-access', platform)).toBe(
        CODEX_DANGER_FULL_ACCESS_PROFILE,
      );
    }
    // Windows defines no profiles, so it names no default.
    expect(codexCanopyPermissionProfiles('win32')).toBeNull();
    expect(codexDefaultPermissionsFor('full-access', 'win32')).toBeNull();
    expect(codexDefaultPermissionsFor('ask', 'win32')).toBeNull();

    const otherChat = mkdtempSync(join(dir, 'chat-b-'));
    const readable = join(otherChat, 'notes.txt');
    execFileSync('/bin/sh', ['-c', 'printf ok > "$1"', 'sh', readable]);
    const previous = process.env.CANOPY_ENV;
    process.env.CANOPY_ENV = 'development';
    let codex: string;
    try {
      codex = getBundledCodexBinaryPath();
    } finally {
      if (previous === undefined) delete process.env.CANOPY_ENV;
      else process.env.CANOPY_ENV = previous;
    }
    const codexHome = mkdtempSync(join(dir, 'codex-home-'));
    // The profiles exactly as a thread's config defines them.
    const profiles = codexCanopyPermissionProfiles('linux');
    if (!profiles) throw new Error('no profiles');
    const definitions = Object.entries(profiles).flatMap(([name, profile]) => [
      '-c',
      `permissions.${name}=${toml(profile)}`,
    ]);
    const run = (
      path: string,
      profileName: string = CODEX_CANOPY_READ_ONLY_PROFILE,
    ): { status: number; output: string } => {
      try {
        const output = execFileSync(
          codex,
          ['sandbox', '-P', profileName, ...definitions, '--', 'cat', path],
          {
            cwd: otherChat,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              PATH: process.env.PATH ?? '/usr/bin:/bin',
              HOME: process.env.HOME ?? otherChat,
              CODEX_HOME: codexHome,
            },
            timeout: 60_000,
          },
        );
        return { status: 0, output };
      } catch (error) {
        const failed = error as { status?: number; stdout?: string };
        return { status: failed.status ?? -1, output: failed.stdout ?? '' };
      }
    };
    // Control: the same sandbox reads an ordinary file.
    expect(run(readable)).toEqual({ status: 0, output: 'ok' });
    // The bundled Codex resolves the built-in profile a Full-access thread
    // names as its default beside these definitions (CAN-7253).
    expect(run(readable, CODEX_DANGER_FULL_ACCESS_PROFILE)).toEqual({
      status: 0,
      output: 'ok',
    });
    const denied = run(ambient.valuesPath);
    expect(denied.status).not.toBe(0);
    expect(denied.output).not.toContain(CANARY);
    // A helper or pipeline step in a workspace-write sandbox is confined too.
    expect(run(readable, CODEX_CONFINED_WORKSPACE_PROFILE)).toEqual({
      status: 0,
      output: 'ok',
    });
    const deniedToWorkspace = run(
      ambient.valuesPath,
      CODEX_CONFINED_WORKSPACE_PROFILE,
    );
    expect(deniedToWorkspace.status).not.toBe(0);
    expect(deniedToWorkspace.output).not.toContain(CANARY);
    await ambient.dispose();
  }, 120_000);

  it('confines helper and pipeline threads in a legacy read-only or workspace-write sandbox', () => {
    const denied = codexSandboxDeniedReadPathsFor('linux');
    // The current data root's ambient directory and the app root's.
    expect(denied).toEqual([
      ambientDir,
      agentSecretAmbientEnvDirUnder(getCanopyDataDir()),
    ]);
    expect(codexSandboxDeniedReadPathsFor('win32')).toEqual([]);
    for (const [sandbox, profileName] of [
      ['read-only', CODEX_CANOPY_READ_ONLY_PROFILE],
      ['workspace-write', CODEX_CONFINED_WORKSPACE_PROFILE],
    ] as const) {
      const confined = confineCodexThreadSandbox(
        { cwd: dir, sandbox, config: { model: 'm' } },
        denied,
      );
      expect(confined).toMatchObject({
        sandbox: null,
        permissions: profileName,
        config: { model: 'm', default_permissions: profileName },
      });
      expect(JSON.stringify(confined.config)).toContain(ambientDir);
    }
    // Full access, a thread's own profile, or a host that denies nothing.
    for (const params of [
      { cwd: dir, sandbox: 'danger-full-access' as const },
      { cwd: dir, permissions: 'own_profile' },
    ]) {
      expect(confineCodexThreadSandbox(params, denied)).toBe(params);
    }
    const unconfined = { cwd: dir, sandbox: 'read-only' as const };
    expect(confineCodexThreadSandbox(unconfined, [])).toBe(unconfined);
  });

  it("confines the background service's pipeline steps over the same data root", async () => {
    const dataRoot = mkdtempSync(join(dir, 'daemon-root-'));
    const before = getCodexRuntimeHostHooks();
    try {
      acquireDaemonPipelineCodexRuntime({
        dataRoot,
        mcpLauncher: { command: process.execPath, args: [] },
        onProcess: () => undefined,
      });
      const denied = codexSandboxDeniedReadPaths();
      expect(denied).toEqual(
        process.platform === 'win32'
          ? []
          : [agentSecretAmbientEnvDirUnder(dataRoot)],
      );
      // A pipeline step that asks for the legacy read-only sandbox gets the
      // confined profile instead.
      if (process.platform !== 'win32')
        expect(
          confineCodexThreadSandbox({ cwd: dir, sandbox: 'read-only' }),
        ).toMatchObject({ sandbox: null, permissions: 'canopy_read_only' });
    } finally {
      await shutdownDaemonPipelineCodexRuntime();
      configureCodexRuntimeHostHooks(before);
    }
  });

  it("denies the directory to delegated Codex and to every Claude chat's file tools", () => {
    const delegated = buildCodexDelegationPermissionProfiles({ cwd: dir });
    for (const profile of Object.values(delegated))
      expect(profile?.filesystem[ambientDir]).toBe('deny');
    expect(ambientSecretDenyRules()).toEqual([
      `Read(/${ambientDir}/**)`,
      `Edit(/${ambientDir}/**)`,
    ]);
  });
});
