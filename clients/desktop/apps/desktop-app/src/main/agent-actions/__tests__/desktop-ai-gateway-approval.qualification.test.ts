import type { AgentActionCall, AiGatewayAction } from '@canopy/agent-actions';
import type { ApprovalRequestEvent } from '@canopy/desktop-shared/types';
import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import { resetDesktopApprovalBrokerForTests } from '../../approvals/approval-broker';
import { resolveApproval } from '../../approvals/pending-approvals';
import { advanceApprovalAuthorityRevision } from '../../approvals/rule-revisions';
import {
  resetDesktopChatWaitsForTest,
  setDesktopChatWaitPresence,
} from '../../chat-waits/desktop-chat-waits';
import { executeDesktopAiGateway } from '../desktop-ai-gateway';

const PERSONAL_ORG = '11111111-1111-4111-8111-111111111111';
const mockWrite = jest.fn(() => Promise.resolve({ ok: true }));

jest.mock('../../feature-flags', (): unknown => ({
  getFeatureFlagService: (): object => ({ isEnabled: (): boolean => true }),
}));
jest.mock('../../lib/canopy-cloud-account-store', (): unknown => ({
  readCanopyCloudAccountWithStatus: (): Promise<unknown> =>
    Promise.resolve({
      status: 'ok',
      entry: {
        account: { id: 'account-1' },
        personalOrganizationId: '11111111-1111-4111-8111-111111111111',
      },
    }),
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
}));
jest.mock('../../canopy-cloud/settings-session', (): unknown => ({
  acquireSettingsBridgeSession: (): Promise<unknown> =>
    Promise.resolve({ ensureReady: (): Promise<void> => Promise.resolve() }),
}));
jest.mock('../../canopy-cloud/settings-client', (): unknown => ({
  executeSettingsOperation: (): Promise<unknown> =>
    Promise.resolve({ gateway: null }),
}));
jest.mock('../../services/ai-gateway-settings', (): unknown => ({
  authorizeDesktopGatewayScope: (): Promise<void> => Promise.resolve(),
  connectDesktopGateway: jest.fn(),
}));
jest.mock('../../services/account-organization-settings-host', (): unknown => ({
  getAccountOrganizationSettingsService: (): object => ({ write: mockWrite }),
}));
jest.mock('../../observability/ingest', (): unknown => ({
  getExecutionObservabilityIngest: (): object => ({
    pauseChatTurn: jest.fn(),
    resumeChatTurn: jest.fn(),
  }),
}));
jest.mock('../../services/attention-tracker', (): unknown => ({
  getAttentionTracker: (): object => ({ mark: jest.fn(), clear: jest.fn() }),
}));
jest.mock('../../lib/main-process-logging', (): unknown => ({
  logMainProcessWarn: jest.fn(),
  logMainProcessError: jest.fn(),
}));

const SCOPE = {
  workspaceId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};
const IDENTITY = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};
const ACTION: AiGatewayAction = {
  type: 'settings.ai_gateway.update',
  scope: { kind: 'personal', expectedOrganizationId: PERSONAL_ORG },
  expectedRevision: 'absent',
  patch: { enabled: false },
};

const send = jest.fn<void, [string, ...unknown[]]>();
const settingsWindow = {
  isDestroyed: (): boolean => false,
  webContents: {
    id: 7,
    isDestroyed: (): boolean => false,
    isCrashed: (): boolean => false,
    send,
    mainFrame: { detached: false, isDestroyed: (): boolean => false },
  },
};
const call = {
  scope: SCOPE,
  host: { settingsWindow: () => settingsWindow },
} as unknown as AgentActionCall<CanopyInjectedToolRuntime>;
const responder = { id: 'webcontents:7', owners: [settingsWindow.webContents] };

function cards(): ApprovalRequestEvent[] {
  return send.mock.calls
    .filter(([channel]) => channel === 'approval:request')
    .map(([, payload]) => payload as ApprovalRequestEvent);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!condition()) throw new Error('condition never held');
}

beforeEach(() => {
  send.mockClear();
  mockWrite.mockClear();
  resetDesktopChatWaitsForTest();
});

afterEach(() => {
  resetDesktopApprovalBrokerForTests();
  setDesktopChatWaitPresence(null);
});

describe('AI gateway save prompt through the approval broker', () => {
  it('fails at once with no eligible client and saves nothing', async () => {
    setDesktopChatWaitPresence({
      getMainWindow: () => null,
      remoteControllerAttached: () => false,
    });

    await expect(executeDesktopAiGateway(ACTION, call)).rejects.toThrow(
      'approval_no_client',
    );
    expect(cards()).toEqual([]);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('refuses an allow from an older revision and saves only on a current one', async () => {
    setDesktopChatWaitPresence({
      getMainWindow: () => settingsWindow,
      remoteControllerAttached: () => false,
    });
    const saved = executeDesktopAiGateway(ACTION, call);
    await until(() => cards().length === 1);
    const [first] = cards();
    if (!first) throw new Error('no card');
    expect(first.details).toMatchObject({
      toolName: 'settings.ai_gateway.update',
    });

    advanceApprovalAuthorityRevision();
    await flush();
    expect(
      resolveApproval(
        first.requestId,
        { behavior: 'allow', scope: 'once' },
        responder,
        IDENTITY,
        first.policyRevision,
      ),
    ).toBe(false);
    expect(mockWrite).not.toHaveBeenCalled();

    const latest = cards().at(-1);
    expect(latest?.requestId).toBe(first.requestId);
    expect(
      resolveApproval(
        first.requestId,
        { behavior: 'allow', scope: 'once' },
        responder,
        IDENTITY,
        latest?.policyRevision,
      ),
    ).toBe(true);
    await expect(saved).resolves.toEqual({
      status: 'updated',
      organizationId: PERSONAL_ORG,
    });
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });
});
