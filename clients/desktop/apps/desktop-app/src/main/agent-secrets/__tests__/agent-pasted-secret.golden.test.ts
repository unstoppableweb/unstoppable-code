import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExecutionSecretGrants } from '@canopy/core-runtime/node/execution-secrets';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { IPC_REMOTE_DISPOSITIONS } from '@canopy/desktop-shared/remote-control/channel-dispositions';

jest.mock('../feature-gate', () => ({
  isAgentSecretRequestsEnabled: jest.fn(() => true),
  isRunWithSecretsSupported: jest.fn(() => true),
}));

import { isAgentSecretRequestsEnabled } from '../feature-gate';
import {
  ChatSecretStore,
  chatSecretBindings,
  setChatSecretStoreForTests,
  type ChatSecretScope,
} from '../chat-secret-store';
import { storePastedSecret } from '../pasted-secrets';
import { listChatSecrets } from '../secrets-chip';
import { desktopExecutionSecretReader } from '../../execution-secrets/reader';
import { IPC_PRIVATE_CHANNELS } from '../../ipc/channel-policy';

/*
 * The composer paste guard's store (agent secret requests U6b): "Send as
 * secret" keeps a pasted value as the chat's secret, encrypted like any
 * other, readable only through an execution-secret grant, never echoed, and
 * only over a private channel kept off remote control.
 */

const CANARY = 'sk_live_canary51Hq8RkLmZx2TfV';
const scope: ChatSecretScope = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

let dir: string;

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

function everything(): string {
  return readdirSync(dir)
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n');
}

let chats: ChatSecretStore;

beforeEach(() => {
  jest.clearAllMocks();
  dir = mkdtempSync(
    join(process.env.TMPDIR ?? tmpdir(), 'agent-pasted-secret-'),
  );
  jest.mocked(isAgentSecretRequestsEnabled).mockReturnValue(true);
  chats = new ChatSecretStore({
    filePath: (): string => join(dir, 'chat-secrets.json'),
    auditFilePath: (): string => join(dir, 'audit.jsonl'),
    encryption: fakeEncryption(),
  });
  setChatSecretStoreForTests(chats);
});

afterEach(() => {
  setChatSecretStoreForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('the paste guard store', () => {
  it('keeps a pasted value as a chat secret and never echoes it', async () => {
    const response = await storePastedSecret({
      ...scope,
      name: 'STRIPE_SECRET_KEY',
      value: CANARY,
    });
    expect(response).toEqual({ ok: true });
    expect(JSON.stringify(response)).not.toContain(CANARY);
    const grants = new ExecutionSecretGrants({
      reader: desktopExecutionSecretReader,
    });
    const bindings = chatSecretBindings(scope, { K: 'STRIPE_SECRET_KEY' });
    const audience = {
      operation: 'worker.script.execute' as const,
      key: 'run-1',
    };
    grants.stage(audience, bindings);
    expect(
      (
        await grants.redeem(
          { audience, bindings },
          new AbortController().signal,
        )
      ).env,
    ).toEqual({ K: CANARY });
    expect((await listChatSecrets(scope)).secrets).toEqual([
      expect.objectContaining({ name: 'STRIPE_SECRET_KEY', scope: 'chat' }),
    ]);
    const disk = everything();
    expect(disk).not.toContain(CANARY);
    expect(disk).not.toContain(Buffer.from(CANARY).toString('base64'));
  });

  it('refuses while agent secret requests are off, and refuses bad values', async () => {
    jest.mocked(isAgentSecretRequestsEnabled).mockReturnValue(false);
    expect(
      await storePastedSecret({ ...scope, name: 'X_KEY', value: CANARY }),
    ).toEqual({ ok: false, error: 'Agent secrets are turned off.' });
    jest.mocked(isAgentSecretRequestsEnabled).mockReturnValue(true);
    expect(
      await storePastedSecret({ ...scope, name: 'X_KEY', value: '   ' }),
    ).toEqual({ ok: false, error: "Couldn't keep the secret. Try again." });
    expect(await chats.listNames(scope)).toEqual([]);
  });

  it('keeps the channel private and away from remote control', () => {
    expect(IPC_CHANNELS.agentSecretsStorePasted).toBe(
      'agent-secrets:store-pasted',
    );
    expect(IPC_PRIVATE_CHANNELS.has(IPC_CHANNELS.agentSecretsStorePasted)).toBe(
      true,
    );
    expect(IPC_REMOTE_DISPOSITIONS.agentSecretsStorePasted).toBe('blocked');
  });
});
