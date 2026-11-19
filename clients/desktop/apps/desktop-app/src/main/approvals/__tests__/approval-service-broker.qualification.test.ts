import type { ApprovalRevalidation } from '@canopy/core-runtime/node/agent/approvals';
import {
  FAIL_CLOSED_MESSAGE,
  POLICY_DENIED_FALLBACK_MESSAGE,
} from '@canopy/protocol/approvals';
import type { ApprovalCheck } from '@canopy/desktop-shared/types';
import {
  createApprovalSession,
  type ApprovalSessionHandle,
} from '../approval-service';
import {
  requestApprovalDecision,
  type ApprovalBridgeResult,
} from '../prompt-bridge';
import type * as PromptBridge from '../prompt-bridge';

jest.mock('../prompt-bridge', (): unknown => {
  const actual: typeof PromptBridge = jest.requireActual('../prompt-bridge');
  return {
    ApprovalRequestEndedError: actual.ApprovalRequestEndedError,
    requestApprovalDecision: jest.fn(),
  };
});

jest.mock('../../lib/approvals-persistence', (): unknown => ({
  readWorkspaceApprovals: (): Promise<unknown> =>
    Promise.resolve({ version: 1, rules: [] }),
  readWorkspaceApprovalsResult: (): Promise<unknown> =>
    Promise.resolve({ file: { version: 1, rules: [] }, status: 'ok' }),
  addWorkspaceApprovalRule: jest.fn(() => Promise.resolve()),
  getWorkspaceApprovalsFilePath: (): string =>
    '/tmp/canopy-approval-broker-qualification/.approvals.json',
}));
jest.mock('../../lib/workspace-approvals-manifest', (): unknown => ({
  readWorkspaceApprovalsManifest: (): Promise<unknown> =>
    Promise.resolve({ rules: [] }),
}));

let mockPreferencesSave: Promise<void> = Promise.resolve();

jest.mock('../../lib/preferences-store', (): unknown => ({
  readPreferencesFile: (): Promise<unknown> =>
    Promise.resolve({ globalApprovalRules: [] }),
  readPreferencesFileDetailed: (): Promise<unknown> =>
    Promise.resolve({
      preferences: { globalApprovalRules: [] },
      authority: 'ok',
    }),
  peekPreferencesLoadError: (): null => null,
  updatePreferencesFile: jest.fn(() => mockPreferencesSave),
}));

jest.mock('../../observability', (): unknown => ({
  getObservabilityService: () => ({
    recordApprovalDecision: jest.fn(),
    recordSessionDiagnostic: jest.fn(),
    pauseChatTurn: jest.fn(),
    resumeChatTurn: jest.fn(),
  }),
}));

jest.mock('../../observability/ingest', (): unknown => ({
  getExecutionObservabilityIngest: () => ({
    pauseChatTurn: jest.fn(),
    resumeChatTurn: jest.fn(),
  }),
}));

jest.mock('../../services/attention-tracker', (): unknown => ({
  getAttentionTracker: () => ({ mark: jest.fn(), clear: jest.fn() }),
}));

jest.mock('../../lib/main-process-logging', (): unknown => ({
  logMainProcessWarn: jest.fn(),
  logMainProcessError: jest.fn(),
}));

import {
  recordAccountMcpServerAccount,
  forgetAccountMcpServerAccounts,
} from '../../mcp/account-mcp-server-accounts';

const mockRequestApprovalDecision = jest.mocked(requestApprovalDecision);
const CHECK: ApprovalCheck = { kind: 'tool', toolName: 'NotebookEdit' };
const DISPLAY = {
  title: 'Edit the notebook',
  details: { kind: 'tool', toolName: 'NotebookEdit' } as const,
};

let session: ApprovalSessionHandle | null = null;

function openSession(): ApprovalSessionHandle {
  session = createApprovalSession({
    sessionKey: 'session-1',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    provider: 'claude',
    workspaceRoot: '/tmp/canopy-approval-broker-qualification',
    mode: 'ask',
    sessionRules: [],
    getWindow: () => null,
    trackChatTurn: false,
  });
  return session;
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!condition()) throw new Error('condition never held');
}

function bridgeResolves(result: ApprovalBridgeResult): void {
  mockRequestApprovalDecision.mockImplementationOnce(() =>
    Promise.resolve(result),
  );
}

describe('approval session over the core broker', () => {
  afterEach(() => {
    session?.dispose();
    session = null;
    mockRequestApprovalDecision.mockReset();
    mockPreferencesSave = Promise.resolve();
  });

  it('a broker policy denial denies the check without a user-denied message', async () => {
    const handle = openSession();
    bridgeResolves({ kind: 'policy_denied' });
    await expect(handle.check(CHECK, DISPLAY)).resolves.toEqual({
      decision: 'deny',
      message: POLICY_DENIED_FALLBACK_MESSAGE,
    });

    bridgeResolves({ kind: 'revalidation_failed' });
    await expect(handle.check(CHECK, DISPLAY)).resolves.toEqual({
      decision: 'deny',
      message: FAIL_CLOSED_MESSAGE,
    });
  });

  it('a remembered allow resumes the tool only after its rule is saved', async () => {
    const handle = openSession();
    let finishSave: () => void = () => undefined;
    mockPreferencesSave = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    bridgeResolves({
      kind: 'decision',
      by: 'client',
      decision: {
        behavior: 'allow',
        scope: 'global',
        target: { kind: 'tool', toolName: 'NotebookEdit' },
      },
    });

    let outcome: unknown;
    const checked = handle.check(CHECK, DISPLAY).then((result) => {
      outcome = result;
      return result;
    });
    await until(() => mockRequestApprovalDecision.mock.calls.length === 1);
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(outcome).toBeUndefined();

    finishSave();
    await expect(checked).resolves.toMatchObject({ decision: 'allow' });
  });

  it('a cancelled or failed request resolves the check as denied', async () => {
    const { ApprovalRequestEndedError } =
      jest.requireActual<typeof PromptBridge>('../prompt-bridge');
    const handle = openSession();
    for (const reason of ['turn_cancelled', 'approval_no_client']) {
      mockRequestApprovalDecision.mockImplementationOnce(() =>
        Promise.reject(new ApprovalRequestEndedError(reason)),
      );
      await expect(handle.check(CHECK, DISPLAY)).resolves.toEqual({
        decision: 'deny',
        message: FAIL_CLOSED_MESSAGE,
      });
    }
  });

  it("the session's revalidation re-runs policy and fails after dispose", async () => {
    const handle = openSession();
    let revalidate: (() => Promise<ApprovalRevalidation>) | undefined;
    let release: (result: ApprovalBridgeResult) => void = () => undefined;
    mockRequestApprovalDecision.mockImplementationOnce((options) => {
      revalidate = options.revalidate;
      return new Promise<ApprovalBridgeResult>((resolve) => {
        release = resolve;
      });
    });

    const checked = handle.check(CHECK, DISPLAY);
    await until(() => revalidate !== undefined);
    if (!revalidate) throw new Error('the bridge was never called');

    await expect(revalidate()).resolves.toBe('prompt');
    handle.dispose();
    session = null;
    await expect(revalidate()).resolves.toBe('failed');

    release({ kind: 'revalidation_failed' });
    await expect(checked).resolves.toMatchObject({ decision: 'deny' });
  });

  it('names the account an MCP approval acts as, and still matches the raw server', async () => {
    forgetAccountMcpServerAccounts();
    recordAccountMcpServerAccount('appproxy-slack-globex--0123456789abcdef', {
      connector: 'Slack',
      account: 'globex',
    });
    const handle = openSession();
    const mcp = (
      server: string,
    ): {
      check: ApprovalCheck;
      display: {
        title: string;
        details: { kind: 'mcp'; server: string; tool: string };
        suggestedTarget: { kind: 'mcp'; server: string; tool: string };
      };
    } => ({
      check: { kind: 'mcp', server, tool: 'send_message' },
      display: {
        title: 'Use Slack',
        details: { kind: 'mcp', server, tool: 'send_message' },
        suggestedTarget: { kind: 'mcp', server, tool: 'send_message' },
      },
    });
    const several = mcp('appproxy-slack-globex--0123456789abcdef');
    bridgeResolves({ kind: 'policy_denied' });
    await handle.check(several.check, several.display);
    expect(mockRequestApprovalDecision.mock.calls[0]?.[0].event).toMatchObject({
      details: {
        kind: 'mcp',
        server: 'appproxy-slack-globex--0123456789abcdef',
        tool: 'send_message',
        connector: 'Slack',
        account: 'globex',
      },
      // A remembered rule still names the raw server.
      suggestedTarget: {
        kind: 'mcp',
        server: 'appproxy-slack-globex--0123456789abcdef',
        tool: 'send_message',
      },
    });
    // A server that is someone's only account reads as before.
    const only = mcp('appproxy-linear--fedcba9876543210');
    bridgeResolves({ kind: 'policy_denied' });
    await handle.check(only.check, only.display);
    expect(
      mockRequestApprovalDecision.mock.calls[1]?.[0].event.details,
    ).toEqual(only.display.details);
  });
});
