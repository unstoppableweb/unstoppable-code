/**
 * CAN-4707 (Phase 2 leg U) on the in-app host: the authentication grant and
 * resume claim files, the fresh account check before a sign-in Resume, and
 * recovery when the app stops between a durable claim, the send and the
 * cleanup. Grants, claims and the registry are the real files on a scratch
 * data root; only the provider account probe and the chat send are stubbed.
 * A crash image freezes one process at a named step and relaunches with fresh
 * modules over the same root. Storage mechanics stay with R0-F5 (CAN-7176).
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  AgentProviderAuthStatus,
  ChatTabsFile,
  PersistedChatMessage,
  PersistedChatTab,
  UsageLimitedChatEntry,
} from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import type * as CodexLoginModule from '../../auth/codex-login';
import type * as ResumeModule from '../../ipc/usage-limited-chats';
import type * as RegistryModule from '../usage-limited-chats-registry';
import type * as PathsModule from '../paths';

interface SentResume {
  userMessageId: string;
  text: string;
}

const mockChat: { tab: PersistedChatTab | undefined; sent: SentResume[] } = {
  tab: undefined,
  sent: [],
};

// A frozen step never returns once `skip` earlier calls have passed;
// `reached` reports that the process got there.
interface MockFreeze {
  hold?: Promise<never>;
  skip?: number;
  reached?: () => void;
}

function frozenCall(step: MockFreeze): Promise<never> | undefined {
  if (!step.hold) return undefined;
  if (step.skip) {
    step.skip -= 1;
    return undefined;
  }
  step.reached?.();
  return step.hold;
}

const mockAccount: { status: AgentProviderAuthStatus } & MockFreeze = {
  status: signedIn('alice@example.com'),
};
const mockCleanup: MockFreeze = {};

/** Overrides a few exports and reads every other one lazily, for import cycles. */
function mockPartially(
  path: string,
  overrides: Record<string, unknown>,
): object {
  return new Proxy(overrides, {
    get: (target, property): unknown =>
      typeof property === 'string' && property in target
        ? target[property]
        : jest.requireActual<Record<string | symbol, unknown>>(path)[property],
    has: (target, property): boolean =>
      property in target ||
      property in jest.requireActual<Record<string | symbol, unknown>>(path),
  });
}

function signedIn(accountEmail: string): AgentProviderAuthStatus {
  return {
    authenticated: true,
    accountLabel: accountEmail,
    accountEmail,
    accountKind: 'subscription',
    detail: null,
    error: null,
  };
}

const signedOut: AgentProviderAuthStatus = {
  authenticated: false,
  accountLabel: null,
  detail: null,
  error: null,
};

// The account probe and its credential fingerprint read provider-native
// files; the fingerprint here is the account itself.
jest.mock('../../auth/provider-auth-state', () =>
  mockPartially('../../auth/provider-auth-state', {
    checkCodexAuthStatus: (): Promise<AgentProviderAuthStatus> =>
      frozenCall(mockAccount) ?? Promise.resolve(mockAccount.status),
    fingerprintCodexRecoveryIdentity: (
      status: AgentProviderAuthStatus,
    ): string | null =>
      status.authenticated && status.accountEmail
        ? `credential:${status.accountEmail}`
        : null,
  }),
);

jest.mock('../../services/attention-tracker', () => ({
  getAttentionTracker: (): { mark: () => void; clear: () => void } => ({
    mark: (): void => undefined,
    clear: (): void => undefined,
  }),
}));

jest.mock('../chat-tabs-reader', () =>
  mockPartially('../chat-tabs-reader', {
    readChatTabsFile: (): Promise<ChatTabsFile> =>
      Promise.resolve({
        version: 1,
        tabs: mockChat.tab ? [mockChat.tab] : [],
        activeTabId: mockChat.tab?.id ?? '',
      }),
  }),
);

// Diagnostics only; its background writes would race the scratch root's removal.
jest.mock('../../observability/ingest', () =>
  mockPartially('../../observability/ingest', {
    getExecutionObservabilityIngest: (): object =>
      new Proxy({}, { get: (): (() => void) => (): void => undefined }),
  }),
);

jest.mock('../chat-usage-limit-cleanup', () => ({
  capturePersistedUsageLimitBannerSnapshot: (): object => ({}),
  clearPersistedUsageLimitBanner: (): Promise<void> => Promise.resolve(),
}));

jest.mock('../../services/chat-service', () =>
  mockPartially('../../services/chat-service', {
    buildExistingTabDispatchOptions: (): Promise<object> => Promise.resolve({}),
    sendWorktreeChatMessage: (request: {
      chatId: string;
      text: string;
      userMessageId: string;
      autoResume?: PersistedChatMessage['autoResume'];
    }): Promise<{ ok: true; chatId: string }> => {
      const tab = mockChat.tab;
      if (!tab) throw new Error('No chat to send to.');
      mockChat.sent.push({
        userMessageId: request.userMessageId,
        text: request.text,
      });
      mockChat.tab = {
        ...tab,
        messages: [
          ...tab.messages,
          {
            id: request.userMessageId,
            role: 'user',
            timestamp: Date.now(),
            userMessageSource: 'auto_resume',
            ...(request.autoResume ? { autoResume: request.autoResume } : {}),
            blocks: [{ type: 'text', text: request.text }],
          },
        ],
        lastAcceptedUserMessageId: request.userMessageId,
      };
      return Promise.resolve({ ok: true, chatId: request.chatId });
    },
  }),
);

jest.mock('../usage-limited-chats-registry', () => {
  const actual = jest.requireActual<typeof RegistryModule>(
    '../usage-limited-chats-registry',
  );
  return {
    ...actual,
    clearAuthenticationInterruptedChat: (
      ...args: Parameters<typeof actual.clearAuthenticationInterruptedChat>
    ): Promise<void> =>
      frozenCall(mockCleanup) ??
      actual.clearAuthenticationInterruptedChat(...args),
  };
});

jest.setTimeout(60_000);

const scope = { projectId: 'project', worktreeId: 'worktree' };
const target = { ...scope, chatId: 'chat-1' };
const attemptId = 'attempt-1';
const ALICE = 'credential:alice@example.com';
let root: string;
const previousDataDir = process.env.CANOPY_DATA_DIR;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'authentication-resume-recovery-'));
  process.env.CANOPY_DATA_DIR = root;
  resetResolvedCanopyDataDirForTests();
  mockChat.sent = [];
  mockAccount.status = signedIn('alice@example.com');
  for (const step of [mockAccount, mockCleanup]) {
    delete step.hold;
    delete step.skip;
    delete step.reached;
  }
  mockChat.tab = {
    id: 'chat-1',
    title: 'Running chat',
    providerType: 'codex',
    lastAcceptedUserMessageId: 'user-1',
    interruptedTurns: { 'user-1': {} },
    messages: [
      {
        id: 'user-1',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Question' }],
      },
    ],
  } as unknown as PersistedChatTab;
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  resetResolvedCanopyDataDirForTests();
  await rm(root, { recursive: true, force: true });
});

interface App {
  registry: typeof RegistryModule;
  login: typeof CodexLoginModule;
  resume: typeof ResumeModule;
  paths: typeof PathsModule;
}

/** One app process with its own registry, login and resume module state. */
async function inProcess<T>(run: (app: App) => Promise<T>): Promise<T> {
  let outcome: { value: T } | undefined;
  await jest.isolateModulesAsync(async () => {
    outcome = {
      value: await run({
        registry: await import('../usage-limited-chats-registry'),
        login: await import('../../auth/codex-login'),
        resume: await import('../../ipc/usage-limited-chats'),
        paths: await import('../paths'),
      }),
    };
  });
  if (!outcome) throw new Error('The app process returned no result.');
  return outcome.value;
}

/** Freezes the call after `skip` calls at `step`; resolves once a process reaches it. */
function freeze(
  step: MockFreeze,
  skip = 0,
): {
  reached: Promise<void>;
  release: () => void;
} {
  let release: () => void = (): void => undefined;
  step.hold = new Promise<never>((_resolve, reject) => {
    release = (): void => reject(new Error('The frozen process ended.'));
  });
  step.hold.catch(() => undefined);
  step.skip = skip;
  const reached = new Promise<void>((resolve) => {
    step.reached = resolve;
  });
  return {
    reached,
    release: (): void => {
      delete step.hold;
      delete step.skip;
      delete step.reached;
      release();
    },
  };
}

function signInPause(detectedAt = 1_000): UsageLimitedChatEntry {
  return {
    ...target,
    provider: 'codex',
    detectedAt,
    resumeReason: 'provider_sign_in',
    authenticationAttemptId: attemptId,
    interruptedUserMessageId: 'user-1',
    workspaceName: '',
    chatTitle: '',
  };
}

function signInResume(
  app: App,
): ReturnType<typeof ResumeModule.handleResumeUsageLimitedSessions> {
  return app.resume.handleResumeUsageLimitedSessions(
    {
      targets: [{ kind: 'chat', ...target }],
      authenticationAttemptId: attemptId,
    },
    () => null,
  );
}

async function dataRootFiles(): Promise<string[]> {
  return (await readdir(root, { recursive: true })).map((name) =>
    basename(name),
  );
}

describe('CAN-4707 U3 grant and claim files', () => {
  it('CAN-4707 U3: a grant and a resume claim survive a relaunch, a second claim for the same key is refused, and a cleared claim can be claimed again', async () => {
    await inProcess(async ({ registry }) => {
      await registry.recordCodexAuthenticationGrant(attemptId, ALICE);
      expect(await registry.claimCodexAuthenticationResume('claim-1')).toBe(
        true,
      );
      expect(await registry.claimCodexAuthenticationResume('claim-1')).toBe(
        false,
      );
    });

    await inProcess(async ({ registry }) => {
      expect(await registry.hasCodexAuthenticationGrant(attemptId, ALICE)).toBe(
        true,
      );
      expect(await registry.claimCodexAuthenticationResume('claim-1')).toBe(
        false,
      );
      await registry.clearCodexAuthenticationResumeClaim('claim-1');
      expect(await registry.claimCodexAuthenticationResume('claim-1')).toBe(
        true,
      );
    });
  });

  it('CAN-4707 U3: a grant recorded again for its attempt replaces the fingerprint, and the files keep the newest 32 grants and 128 claims', async () => {
    await inProcess(async ({ registry }) => {
      await registry.recordCodexAuthenticationGrant(
        attemptId,
        'credential:old',
      );
      await registry.recordCodexAuthenticationGrant(attemptId, ALICE);
      expect(
        await registry.hasCodexAuthenticationGrant(attemptId, 'credential:old'),
      ).toBe(false);
      expect(await registry.hasCodexAuthenticationGrant(attemptId, ALICE)).toBe(
        true,
      );

      for (let index = 0; index < 33; index += 1)
        await registry.recordCodexAuthenticationGrant(
          `attempt-${index}`,
          ALICE,
        );
      for (let index = 0; index < 129; index += 1)
        await registry.claimCodexAuthenticationResume(`claim-${index}`);
    });

    await inProcess(async ({ registry }) => {
      expect(
        await registry.hasCodexAuthenticationGrant('attempt-0', ALICE),
      ).toBe(false);
      expect(
        await registry.hasCodexAuthenticationGrant('attempt-32', ALICE),
      ).toBe(true);
      expect(await registry.claimCodexAuthenticationResume('claim-128')).toBe(
        false,
      );
      expect(await registry.claimCodexAuthenticationResume('claim-0')).toBe(
        true,
      );
    });
  });
});

describe('CAN-4707 U4 and U5 account check, cancellation and revocation', () => {
  it('CAN-4707 U4: Resume is allowed only for the account the grant recorded, checked fresh at resume time and after a relaunch', async () => {
    await inProcess(async ({ registry, login }) => {
      await registry.recordCodexAuthenticationGrant(attemptId, ALICE);
      await expect(
        login.codexLoginManager.assertResumeAllowed(attemptId),
      ).resolves.toBeUndefined();

      mockAccount.status = signedIn('bob@example.com');
      await expect(
        login.codexLoginManager.assertResumeAllowed(attemptId),
      ).rejects.toThrow(
        'Verify the same Codex account before resuming this work.',
      );

      mockAccount.status = signedOut;
      await expect(
        login.codexLoginManager.assertResumeAllowed(attemptId),
      ).rejects.toThrow(
        'Verify Codex authentication before resuming this work.',
      );
    });

    await inProcess(async ({ login }) => {
      mockAccount.status = signedIn('alice@example.com');
      await expect(
        login.codexLoginManager.assertResumeAllowed(attemptId),
      ).resolves.toBeUndefined();
      await expect(
        login.codexLoginManager.assertResumeAllowed('attempt-2'),
      ).rejects.toThrow(
        'Verify the same Codex account before resuming this work.',
      );
    });
  });

  it('CAN-4707 U5: a revoke issued while its grant is still being written leaves no grant, before and after a relaunch, and Resume is refused', async () => {
    await inProcess(async ({ registry, login }) => {
      const writing = registry.recordCodexAuthenticationGrant(attemptId, ALICE);
      const revoking = registry.revokeCodexAuthenticationGrant(attemptId);
      await Promise.all([writing, revoking]);
      expect(await registry.hasCodexAuthenticationGrant(attemptId, ALICE)).toBe(
        false,
      );
      await expect(
        login.codexLoginManager.assertResumeAllowed(attemptId),
      ).rejects.toThrow(
        'Verify the same Codex account before resuming this work.',
      );
    });

    await inProcess(async ({ registry }) => {
      expect(await registry.hasCodexAuthenticationGrant(attemptId, ALICE)).toBe(
        false,
      );
    });
  });

  it('CAN-4707 U5: a sign-in Resume for a revoked grant sends nothing and keeps the interruption for the person', async () => {
    await inProcess(async (app) => {
      await app.registry.recordInterruptedChats([signInPause()]);
      await app.registry.recordCodexAuthenticationGrant(attemptId, ALICE);
      await app.registry.revokeCodexAuthenticationGrant(attemptId);
      const response = await signInResume(app);
      expect(response.resumedCount).toBe(0);
      expect(response.failedTargets).toHaveLength(1);
      expect(mockChat.sent).toEqual([]);
      expect(await app.registry.readUsageLimitedChats(true)).toEqual([
        signInPause(),
      ]);
    });
  });
});

describe('CAN-4707 U6 recovery between the claim, the send and the cleanup', () => {
  it('CAN-4707 U6: an app that stopped after its durable claim and before the send resumes once on relaunch, and the stopped process never sends', async () => {
    // The account is checked before the claim and again after it.
    const frozen = freeze(mockAccount, 1);
    const stopped = await inProcess(async (app) => {
      await app.registry.recordInterruptedChats([signInPause()]);
      await app.registry.recordCodexAuthenticationGrant(attemptId, ALICE);
      const pending = signInResume(app);
      await frozen.reached;
      return { pending };
    });
    expect(mockChat.sent).toEqual([]);
    delete mockAccount.hold;

    await inProcess(async (app) => {
      const response = await signInResume(app);
      expect(response).toMatchObject({ resumedCount: 1, failedTargets: [] });
      expect(mockChat.sent).toHaveLength(1);
      expect(await app.registry.readUsageLimitedChats(true)).toEqual([]);
    });

    frozen.release();
    await stopped.pending.catch(() => undefined);
    expect(mockChat.sent).toHaveLength(1);
  });

  it('CAN-4707 U6: an app that stopped after the send and before its cleanup reconciles on relaunch without sending again and clears the interruption', async () => {
    const frozen = freeze(mockCleanup);
    const stopped = await inProcess(async (app) => {
      await app.registry.recordInterruptedChats([signInPause()]);
      await app.registry.recordCodexAuthenticationGrant(attemptId, ALICE);
      const pending = signInResume(app);
      await frozen.reached;
      return { pending };
    });
    expect(mockChat.sent).toHaveLength(1);
    delete mockCleanup.hold;

    await inProcess(async (app) => {
      const response = await signInResume(app);
      expect(response).toMatchObject({ resumedCount: 0, failedTargets: [] });
      expect(mockChat.sent).toHaveLength(1);
      expect(await app.registry.readUsageLimitedChats(true)).toEqual([]);
    });

    frozen.release();
    await stopped.pending.catch(() => undefined);
    expect(mockChat.sent).toHaveLength(1);
  });
});

describe('CAN-4707 U8 no provider-native credential migration', () => {
  it('CAN-4707 U8: authentication recovery writes only the interruption registry and its grant and claim files under the data root', async () => {
    await inProcess(async (app) => {
      await app.registry.recordInterruptedChats([signInPause()]);
      await app.registry.recordCodexAuthenticationGrant(attemptId, ALICE);
      await app.registry.claimCodexAuthenticationResume('claim-1');
      await signInResume(app);
      await app.registry.revokeCodexAuthenticationGrant(attemptId);
      const registryFile = basename(app.paths.getUsageLimitedChatsFilePath());
      expect(new Set(await dataRootFiles())).toEqual(
        new Set([
          registryFile,
          `${registryFile}.authentication-grants.json`,
          `${registryFile}.authentication-resume-claims.json`,
        ]),
      );
    });
  });
});
