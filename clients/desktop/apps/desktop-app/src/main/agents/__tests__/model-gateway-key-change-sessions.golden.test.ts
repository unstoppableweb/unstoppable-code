// Golden (CAN-7640): after this computer's key for an AI gateway changes, the
// open chats routed through that gateway get a fresh session at their next
// turn, and every other chat keeps its session: a native chat, and a chat on
// another organization's gateway. Real sessions come from getOrCreateSession
// over a seeded gateway catalog; only the provider process is stubbed. The
// change enters through the removed-gateway key clear, which also tells
// windows to re-read the key (model-gateway:credential-changed).
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { AgentSession, AgentSessionOptions } from '../types';
import {
  buildSessionKey,
  destroyAllSessions,
  getOrCreateSession,
  registerSession,
} from '../session-manager';
import { runInAgentWorker } from '../../agent-runs/agent-worker-context';
import { windowAgentInterfacePort } from '../agent-interface-port';
import {
  loadModelsFromPackageJson,
  updateOrgGatewayModelCatalog,
} from '../../lib/model-config';
import { sendToAllWindows } from '../../lib/window-send';
import { clearModelGatewayCredentialForRemovedGateway } from '../../ipc/settings';

const destroyed: string[] = [];

jest.mock('../../lib/window-send', () => ({
  ...jest.requireActual<Record<string, unknown>>('../../lib/window-send'),
  sendToWindow: jest.fn(),
  sendToAllWindows: jest.fn(),
}));
jest.mock('../../lib/model-gateway-credential-store', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../lib/model-gateway-credential-store',
  ),
  clearModelGatewayCredential: jest.fn(() => Promise.resolve('cleared')),
}));
jest.mock('../../lib/model-gateway-state', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../lib/model-gateway-state',
  ),
  refreshPersonalGatewayKey: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../claude-session', () => ({
  ClaudeCodeProvider: class {
    createSession = (opts: AgentSessionOptions): Partial<AgentSession> => {
      const session: Partial<AgentSession> = {
        isDisposed: (): boolean => false,
        destroy: (): Promise<void> => {
          destroyed.push(opts.chatId);
          return Promise.resolve();
        },
        setApprovalMode: (): Promise<void> => Promise.resolve(),
      };
      registerSession(
        buildSessionKey(opts.projectId, opts.worktreeId, opts.chatId),
        session as AgentSession,
        new AbortController(),
        'claude',
        opts.model,
        opts.assistantMode,
      );
      return session;
    };
  },
}));

const TEAM = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';

function gatewayModel(id: string): {
  id: string;
  gatewayId: string;
  label: string;
  harness: 'claude';
  contextWindow: number;
  supportedThinkingLevels: [];
  toolSchemaProfile: 'standard';
} {
  return {
    id,
    gatewayId: `vendor/${id}`,
    label: id,
    harness: 'claude',
    contextWindow: 200_000,
    supportedThinkingLevels: [],
    toolSchemaProfile: 'standard',
  };
}

async function openChat(chatId: string, model: string): Promise<void> {
  const options: AgentSessionOptions = {
    cwd: '/tmp/canopy-gateway-key-change',
    projectId: 'ws',
    worktreeId: 'wt',
    chatId,
    model,
    planMode: false,
    providerType: 'claude',
    executionHarness: 'claude',
  };
  await runInAgentWorker({ kind: 'turn', runId: `run-${chatId}` }, () =>
    getOrCreateSession(
      options,
      () => undefined,
      windowAgentInterfacePort(() => null),
    ),
  );
}

beforeAll(() => {
  loadModelsFromPackageJson();
  updateOrgGatewayModelCatalog([
    {
      organizationId: TEAM,
      organizationName: 'Team',
      baseUrl: 'https://team-gateway.example/api',
      models: [gatewayModel('team-claude')],
      promptCachePassthrough: true,
    },
    {
      organizationId: OTHER,
      organizationName: 'Other',
      baseUrl: 'https://other-gateway.example/api',
      models: [gatewayModel('other-claude')],
      promptCachePassthrough: true,
    },
  ]);
});

afterEach(async () => {
  await destroyAllSessions();
  destroyed.length = 0;
});

describe('AI gateway key change', () => {
  it('retires only the chats on that gateway and tells windows to re-read the key', async () => {
    await openChat('gateway-chat', 'team-claude');
    await openChat('native-chat', 'sonnet');
    await openChat('other-gateway-chat', 'other-claude');
    expect(destroyed).toEqual([]);

    await expect(
      clearModelGatewayCredentialForRemovedGateway(TEAM, 'account-one'),
    ).resolves.toBe(true);

    expect(destroyed).toEqual(['gateway-chat']);
    expect(jest.mocked(sendToAllWindows)).toHaveBeenCalledWith(
      IPC_CHANNELS.modelGatewayCredentialChanged,
      TEAM,
    );
  });
});
