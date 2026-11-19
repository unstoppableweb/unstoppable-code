import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ApprovalMode } from '@canopy/desktop-shared/types';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { IPC_REMOTE_DISPOSITIONS } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import { cursorCanopyMcpServerNames } from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';

jest.mock('../feature-gate', () => ({
  ...jest.requireActual<Record<string, unknown>>('../feature-gate'),
  isAgentSecretRequestsEnabled: jest.fn(() => true),
}));

import { isAgentSecretRequestsEnabled } from '../feature-gate';
import {
  CHAT_SECRET_TTL_MS,
  ChatSecretStore,
  chatSecretBindings,
  setChatSecretStoreForTests,
  type ChatSecretScope,
} from '../chat-secret-store';
import { listChatSecrets, revokeChatSecret } from '../secrets-chip';
import { agentSecretUseTools } from '../secret-tool-runtime';
import {
  getDesktopExecutionSecrets,
  resetDesktopExecutionSecretsForTests,
} from '../../execution-secrets/owner';
import { IPC_PRIVATE_CHANNELS } from '../../ipc/channel-policy';
import { authorizeCursorMcpTool } from '../../cursor/tool-approval';
import { getCanopyRouteTools } from '../../mcp/canopy-route-tools';
import type { CanopyWorktreeSessionRoute } from '../../mcp/canopy-tool-router';
import type { ApprovalSessionHandle } from '../../approvals/approval-service';

/*
 * The Secrets chip and other providers (U3): the chip lists a chat's held
 * secrets by name, scope and last use, never a value, over private channels
 * kept off remote control; Revoke takes a value out of use and records a
 * metadata-only audit event; the store tells the chip when values change,
 * expire or are used, and a later RunWithSecrets naming a revoked one gets
 * `missing`; Cursor, OpenCode and Copilot chats get RequestSecrets on their UI
 * server and RunWithSecrets on their main server, past their execution-time
 * gate without a second card.
 */

const CANARY = 'canary-3b9d71c0-chip';
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

/** Hands values to a command the way the tools do: one single-use grant. */
async function readThroughGrant(
  env: Record<string, string>,
): Promise<Readonly<Record<string, string>>> {
  const bindings = chatSecretBindings(scope, env);
  const audience = {
    operation: 'worker.script.execute',
    key: randomUUID(),
  } as const;
  const grants = getDesktopExecutionSecrets();
  grants.stage(audience, bindings);
  return (
    await grants.redeem({ audience, bindings }, new AbortController().signal)
  ).env;
}

beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'agent-chip-'));
  mode = 'ask';
  clock = Date.now();
  store = new ChatSecretStore({
    filePath: (): string => join(dir, 'chat-secrets.json'),
    auditFilePath: (): string => join(dir, 'audit.jsonl'),
    encryption: fakeEncryption(),
    now: (): number => clock,
  });
  setChatSecretStoreForTests(store);
  resetDesktopExecutionSecretsForTests();
  jest.mocked(isAgentSecretRequestsEnabled).mockReturnValue(true);
});

afterEach(() => {
  setChatSecretStoreForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('Secrets chip', () => {
  it('lists names, scope and last use, never a value, and Revoke audits it', async () => {
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY, AWS_KEY_ID: TRICKY });
    // A grant read hands STRIPE_SECRET_KEY to a command: its last use.
    clock += 1000;
    await readThroughGrant({ STRIPE_SECRET_KEY: 'STRIPE_SECRET_KEY' });
    await store.put(scope, { AWS_KEY_ID: TRICKY });
    const listed = await listChatSecrets(scope);
    expect(listed.secrets.map((secret) => secret.name)).toEqual([
      'AWS_KEY_ID',
      'STRIPE_SECRET_KEY',
    ]);
    expect(listed.secrets.every((secret) => secret.scope === 'chat')).toBe(
      true,
    );
    expect(listed.secrets[0]?.lastUsedAt).toBeUndefined();
    expect(typeof listed.secrets[1]?.lastUsedAt).toBe('number');
    const wire = JSON.stringify(listed);
    expect(wire).not.toContain(CANARY);
    expect(wire).not.toContain(Buffer.from(CANARY).toString('base64'));

    expect(
      await revokeChatSecret({ ...scope, name: 'STRIPE_SECRET_KEY' }),
    ).toEqual({ ok: true });
    expect(await store.listNames(scope)).toEqual(['AWS_KEY_ID']);
    const audit = readFileSync(join(dir, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit.at(-1)).toMatchObject({
      event: 'revoked',
      names: ['STRIPE_SECRET_KEY'],
      reason: 'person',
    });
    expect(readFileSync(join(dir, 'audit.jsonl'), 'utf8')).not.toContain(
      CANARY,
    );
  });

  it('a later RunWithSecrets naming a revoked secret gets missing', async () => {
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY, AWS_KEY_ID: TRICKY });
    expect(
      await revokeChatSecret({ ...scope, name: 'STRIPE_SECRET_KEY' }),
    ).toEqual({ ok: true });
    const { runWithSecrets } = agentSecretUseTools({
      scope,
      root: dir,
      agentName: 'Cursor',
    });
    const result = await runWithSecrets(
      {
        command: 'printenv KEY',
        env: { KEY: 'STRIPE_SECRET_KEY', OTHER: 'AWS_KEY_ID' },
      },
      {},
    );
    expect(result).toMatchObject({
      exitCode: null,
      stdout: '',
      missing: ['STRIPE_SECRET_KEY'],
    });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it('shows nothing while the feature is off', async () => {
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    jest.mocked(isAgentSecretRequestsEnabled).mockReturnValue(false);
    expect((await listChatSecrets(scope)).secrets).toEqual([]);
  });

  it('keeps its channels local and private', () => {
    for (const key of [
      'agentSecretsList',
      'agentSecretsRevoke',
      'agentSecretsChanged',
    ] as const)
      expect(IPC_REMOTE_DISPOSITIONS[key]).toBe('blocked');
    for (const channel of [
      IPC_CHANNELS.agentSecretsList,
      IPC_CHANNELS.agentSecretsRevoke,
    ])
      expect(IPC_PRIVATE_CHANNELS.has(channel)).toBe(true);
  });
});

describe('changes the chip follows', () => {
  it('tells listeners when a value expires, once, and not again at the sweep', async () => {
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    const changes: string[] = [];
    const stop = store.subscribe((_changed, change) => {
      changes.push(change);
    });
    clock += CHAT_SECRET_TTL_MS + 1;
    store.noticeExpired();
    expect(changes).toEqual(['values']);
    expect((await listChatSecrets(scope)).secrets).toEqual([]);
    store.noticeExpired();
    await store.sweepExpired();
    expect(changes).toEqual(['values']);
    stop();
  });

  it('records a use only when a grant hands the value to a command', async () => {
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    const changes: string[] = [];
    const stop = store.subscribe((_changed, change) => {
      changes.push(change);
    });
    expect(
      (await listChatSecrets(scope)).secrets[0]?.lastUsedAt,
    ).toBeUndefined();
    const env = await readThroughGrant({ KEY: 'STRIPE_SECRET_KEY' });
    expect(env).toEqual({ KEY: CANARY });
    expect(changes).toEqual(['usage']);
    expect((await listChatSecrets(scope)).secrets[0]?.lastUsedAt).toBe(clock);
    stop();
  });
});

describe('Cursor, OpenCode and Copilot', () => {
  function route(
    providerType: 'cursor' | 'opencode' | 'copilot',
    secretRequests: boolean,
  ): CanopyWorktreeSessionRoute {
    return {
      sessionKey: `key-${providerType}`,
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      chatId: scope.chatId,
      sdkSessionId: 'sdk',
      authToken: 'token',
      createdAt: 0,
      hookHandler: () => undefined,
      providerType,
      toolSurface:
        providerType === 'cursor'
          ? 'cursor-acp'
          : providerType === 'opencode'
            ? 'opencode-acp'
            : 'copilot-sdk',
      ...(secretRequests
        ? { secretRequests: true, getApprovalMode: () => mode }
        : {}),
    };
  }

  it.each(['cursor', 'opencode', 'copilot'] as const)(
    'lists RequestSecrets on the %s UI server and RunWithSecrets on its main server only for a route that offers them',
    (providerType) => {
      const names = (offered: boolean): string[] =>
        getCanopyRouteTools(route(providerType, offered), true).map(
          (tool) => tool.name,
        );
      expect(names(true)).toContain('RequestSecrets');
      expect(names(false)).not.toContain('RequestSecrets');
      const main = (offered: boolean): string[] =>
        getCanopyRouteTools(route(providerType, offered), false).map(
          (tool) => tool.name,
        );
      expect(main(true)).not.toContain('RequestSecrets');
      // RunWithSecrets on the main server, not on Windows yet.
      if (process.platform !== 'win32')
        expect(main(true)).toContain('RunWithSecrets');
      expect(main(false)).not.toContain('RunWithSecrets');
      expect(names(true)).not.toContain('RunWithSecrets');
    },
  );

  it.each(['Cursor', 'OpenCode', 'Copilot'] as const)(
    "lets %s's execution-time gate pass RequestSecrets and RunWithSecrets without an extra approval card",
    async (providerLabel) => {
      const check = jest.fn();
      const approval = { check } as unknown as ApprovalSessionHandle;
      const names = cursorCanopyMcpServerNames();
      const signal = new AbortController().signal;
      const context = {
        approval,
        toolCallId: 'call-1',
        cwd: dir,
        providerLabel,
        signal,
      };
      await expect(
        authorizeCursorMcpTool(
          { server: names.ui, tool: 'RequestSecrets', args: {} },
          { ...context, planMode: true },
        ),
      ).resolves.toEqual({ decision: 'allow' });
      await expect(
        authorizeCursorMcpTool(
          { server: names.main, tool: 'RequestSecrets', args: {} },
          context,
        ),
      ).resolves.toMatchObject({ decision: 'deny' });
      // RunWithSecrets asks in its own card, which no saved rule answers.
      const run = {
        server: names.main,
        tool: 'RunWithSecrets',
        args: { command: 'npm test', env: { KEY: 'STRIPE_SECRET_KEY' } },
      };
      await expect(authorizeCursorMcpTool(run, context)).resolves.toEqual({
        decision: 'allow',
      });
      await expect(
        authorizeCursorMcpTool(run, { ...context, planMode: true }),
      ).resolves.toMatchObject({ decision: 'deny' });
      await expect(
        authorizeCursorMcpTool({ ...run, server: names.ui }, context),
      ).resolves.toMatchObject({ decision: 'deny' });
      expect(check).not.toHaveBeenCalled();
    },
  );
});
