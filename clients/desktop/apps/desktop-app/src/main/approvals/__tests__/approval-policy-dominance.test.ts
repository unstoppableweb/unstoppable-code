import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAntigravityHost } from '@canopy/desktop-shared/node/antigravity/cli-host';
import { openAntigravityRuntime } from '@canopy/desktop-shared/node/antigravity/runtime';
import type { CliAntigravityRollout } from '@canopy/desktop-shared/node/antigravity/cli-rollout';
import type { AcpClient } from '@canopy/desktop-shared/node/acp';

jest.mock('@canopy/desktop-shared/node/antigravity/runtime', () => ({
  openAntigravityRuntime: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/node/antigravity/cli-rollout', () => ({
  openCliAntigravityRollout: (): Promise<CliAntigravityRollout> =>
    Promise.resolve({
      isEnabled: (): boolean => true,
      close: (): Promise<void> => Promise.resolve(),
    }),
}));

import { evaluateApproval } from '@canopy/desktop-shared/lib/approval-engine';
import type {
  ApprovalCheck,
  ApprovalMode,
  ApprovalRule,
} from '@canopy/desktop-shared/types';
import { seedEmptyApprovalRuleSources } from '../../__tests__/helpers/approval-rule-sources';
import {
  inheritedDenyRules,
  isApprovalPolicyWithin,
  startedChatApprovalMode,
} from '../approval-policy-dominance';
import {
  effectiveApprovalPolicy,
  type EffectiveApprovalPolicy,
} from '../effective-approval-policy';

interface ChatApprovalPolicy {
  mode: ApprovalMode;
  sessionRules: readonly ApprovalRule[];
  root?: string;
}

const write = (path: string): ApprovalCheck => ({
  kind: 'file-write',
  path,
  resolvedPath: path,
});

function outcome(policy: ChatApprovalPolicy, path: string): string {
  return evaluateApproval(write(path), {
    mode: policy.mode,
    rules: { session: [...policy.sessionRules], project: [], global: [] },
    ...(policy.root ? { workspaceRoot: policy.root } : {}),
  }).outcome;
}

/** The effective policy of a chat in a workspace with no persisted rules. */
function effective(
  policy: ChatApprovalPolicy,
): Promise<EffectiveApprovalPolicy | undefined> {
  return effectiveApprovalPolicy({
    projectId: 'ws-dominance',
    worktreeId: 'wt-1',
    mode: policy.mode,
    sessionRules: policy.sessionRules,
    ...(policy.root ? { workspaceRoot: policy.root } : {}),
  });
}

async function within(
  target: ChatApprovalPolicy,
  bound: ChatApprovalPolicy,
): Promise<boolean> {
  const [t, b] = await Promise.all([effective(target), effective(bound)]);
  return isApprovalPolicyWithin(t, b);
}

beforeAll(async () => {
  await seedEmptyApprovalRuleSources(['ws-dominance']);
});

describe('approval policy dominance', () => {
  const callerA: ChatApprovalPolicy = {
    mode: 'auto',
    sessionRules: [],
    root: '/ws/worktrees/a',
  };
  const siblingB: ChatApprovalPolicy = {
    mode: 'auto',
    sessionRules: [],
    root: '/ws/worktrees/b',
  };

  it('refuses an Auto target whose worktree lies outside an Auto caller', async () => {
    // The target writes its own worktree without asking; the caller would ask.
    expect(outcome(callerA, '/ws/worktrees/b/src/index.ts')).toBe('prompt');
    expect(outcome(siblingB, '/ws/worktrees/b/src/index.ts')).toBe('allow');
    expect(await within(siblingB, callerA)).toBe(false);
  });

  it('accepts an Auto target in the caller worktree or below it', async () => {
    expect(
      await within({ ...siblingB, root: '/ws/worktrees/a' }, callerA),
    ).toBe(true);
    expect(
      await within(
        { ...siblingB, root: '/ws/worktrees/a/packages/app' },
        callerA,
      ),
    ).toBe(true);
    expect(
      await within({ ...siblingB, root: '/ws/worktrees/ab' }, callerA),
    ).toBe(false);
  });

  it('fails closed when either Auto root is unknown', async () => {
    expect(await within({ mode: 'auto', sessionRules: [] }, callerA)).toBe(
      false,
    );
    expect(await within(siblingB, { mode: 'auto', sessionRules: [] })).toBe(
      false,
    );
  });

  it('ignores roots when the target asks, or when the caller has Full Access', async () => {
    expect(await within({ ...siblingB, mode: 'ask' }, callerA)).toBe(true);
    expect(await within(siblingB, { ...callerA, mode: 'full-access' })).toBe(
      true,
    );
  });

  it.each([
    ['auto', 'full-access', 'auto'],
    ['full-access', 'ask', 'ask'],
    ['ask', 'auto', 'ask'],
  ] as const)(
    'starts a chat from a %s caller, where new chats default to %s, in %s mode',
    (caller, destination, expected) => {
      expect(startedChatApprovalMode(caller, destination)).toBe(expected);
    },
  );

  it("seeds a started chat with the caller's denies of every tier, absolute in its root, and no grants", async () => {
    const caller = await effective({
      mode: 'ask',
      root: '/ws/w1/repo-a',
      sessionRules: [
        {
          id: 'deny-src',
          behavior: 'deny',
          target: { kind: 'file-write', path: 'src/**' },
          createdAt: '2026-01-01T00:00:00.000Z',
          origin: 'prompt',
        },
        {
          id: 'allow-test',
          behavior: 'allow',
          target: { kind: 'command', pattern: 'npm test' },
          createdAt: '2026-01-01T00:00:00.000Z',
          origin: 'prompt',
        },
      ],
    });
    expect(caller).toBeDefined();
    const seeded = inheritedDenyRules(...(caller ? [caller, caller] : []));
    expect(seeded).toEqual([
      expect.objectContaining({
        id: 'deny-src',
        behavior: 'deny',
        target: { kind: 'file-write', path: '/ws/w1/repo-a/src/**' },
      }),
    ]);
    const child = { mode: 'ask' as const, sessionRules: seeded };
    expect(
      outcome(
        { ...child, root: '/ws/w2/repo-a' },
        '/ws/w1/repo-a/src/index.ts',
      ),
    ).toBe('deny');
    expect(
      await within(
        { ...child, root: '/ws/w2/repo-a' },
        {
          mode: 'ask',
          root: '/ws/w1/repo-a',
          sessionRules: seeded,
        },
      ),
    ).toBe(true);
  });

  describe('relative file-write rules', () => {
    const rule = (behavior: 'allow' | 'deny', path: string): ApprovalRule => ({
      id: `${behavior}-${path}`,
      behavior,
      target: { kind: 'file-write', path },
      createdAt: '2026-01-01T00:00:00.000Z',
      origin: 'prompt',
    });
    const askIn = (
      root: string | undefined,
      rules: readonly ApprovalRule[],
    ): ChatApprovalPolicy => ({
      mode: 'ask',
      sessionRules: rules,
      ...(root ? { root } : {}),
    });

    it('refuses two Ask chats in different repositories that hold the same relative grant', async () => {
      const grant = rule('allow', 'deploy/config.ts');
      const callerRepoA = askIn('/ws/w1/repo-a', [grant]);
      const targetRepoB = askIn('/ws/w1/repo-b', [grant]);
      // The engine resolves the grant against each chat's own root.
      expect(outcome(callerRepoA, '/ws/w1/repo-b/deploy/config.ts')).toBe(
        'prompt',
      );
      expect(outcome(targetRepoB, '/ws/w1/repo-b/deploy/config.ts')).toBe(
        'allow',
      );
      expect(await within(targetRepoB, callerRepoA)).toBe(false);
    });

    it('accepts the same relative grant when both chats share a root, or an absolute grant naming the same file', async () => {
      const callerRepoA = askIn('/ws/w1/repo-a', [
        rule('allow', 'deploy/config.ts'),
      ]);
      expect(
        await within(
          askIn('/ws/w1/repo-a', [rule('allow', './deploy/config.ts')]),
          callerRepoA,
        ),
      ).toBe(true);
      expect(
        await within(
          askIn('/ws/w1/repo-a', [
            rule('allow', '/ws/w1/repo-a/deploy/config.ts'),
          ]),
          callerRepoA,
        ),
      ).toBe(true);
    });

    it("accepts a target in another root whose grant names the caller's same file, absolutely", async () => {
      expect(
        await within(
          askIn('/ws/w1/repo-b', [
            rule('allow', '/ws/w1/repo-a/deploy/config.ts'),
          ]),
          askIn('/ws/w1/repo-a', [rule('allow', 'deploy/config.ts')]),
        ),
      ).toBe(true);
    });

    it("refuses when the caller's relative deny names another file in the target's root", async () => {
      const deny = rule('deny', 'deploy/config.ts');
      expect(
        await within(
          askIn('/ws/w1/repo-b', [deny]),
          askIn('/ws/w1/repo-a', [deny]),
        ),
      ).toBe(false);
    });

    it('fails closed when a chat holding a relative rule has no root', async () => {
      const grant = rule('allow', 'deploy/config.ts');
      expect(
        await within(askIn(undefined, [grant]), askIn(undefined, [grant])),
      ).toBe(false);
      const deny = rule('deny', 'deploy/config.ts');
      expect(
        await within(askIn('/ws/w1/repo-a', [deny]), askIn(undefined, [deny])),
      ).toBe(false);
    });
  });

  describe('grants that run in the chat root', () => {
    const grant = (target: ApprovalRule['target']): ApprovalRule => ({
      id: `allow-${JSON.stringify(target)}`,
      behavior: 'allow',
      target,
      createdAt: '2026-01-01T00:00:00.000Z',
      origin: 'prompt',
    });
    const npmTest = grant({ kind: 'command', pattern: 'npm test' });
    const askIn = (
      root: string | undefined,
      rules: readonly ApprovalRule[],
    ): ChatApprovalPolicy => ({
      mode: 'ask',
      sessionRules: rules,
      ...(root ? { root } : {}),
    });
    const commandOutcome = (policy: ChatApprovalPolicy): string =>
      evaluateApproval(
        {
          kind: 'command',
          command: 'npm test',
          ...(policy.root ? { cwd: policy.root } : {}),
        },
        {
          mode: policy.mode,
          rules: { session: [...policy.sessionRules], project: [], global: [] },
          ...(policy.root ? { workspaceRoot: policy.root } : {}),
        },
      ).outcome;

    it('refuses two Ask chats in repo-a and repo-b that both hold a npm test grant', async () => {
      const callerRepoA = askIn('/ws/w1/repo-a', [npmTest]);
      const targetRepoB = askIn('/ws/w1/repo-b', [npmTest]);
      // Each engine approves the text without asking, and each runs it in
      // its own root, so the target's grant runs where the caller has none.
      expect(commandOutcome(callerRepoA)).toBe('allow');
      expect(commandOutcome(targetRepoB)).toBe('allow');
      expect(commandOutcome(askIn('/ws/w1/repo-a', []))).toBe('prompt');
      expect(await within(targetRepoB, callerRepoA)).toBe(false);
    });

    it('accepts the same npm test grant only in the same root', async () => {
      const callerRepoA = askIn('/ws/w1/repo-a', [npmTest]);
      const sameRoot = askIn('/ws/w1/repo-a', [npmTest]);
      expect(commandOutcome(sameRoot)).toBe('allow');
      expect(await within(sameRoot, callerRepoA)).toBe(true);
      // A command runs in its chat's root, which a grant in another one,
      // even below it, does not reach the same way.
      expect(
        await within(
          askIn('/ws/w1/repo-a/packages/app', [npmTest]),
          callerRepoA,
        ),
      ).toBe(false);
      expect(await within(askIn('/ws/w1', [npmTest]), callerRepoA)).toBe(false);
    });

    it('accepts a network grant the caller holds, wherever the target runs', async () => {
      const held = grant({ kind: 'network', host: 'registry.npmjs.org' });
      expect(
        await within(
          askIn('/ws/w1/repo-b', [held]),
          askIn('/ws/w1/repo-a', [held]),
        ),
      ).toBe(true);
      expect(
        await within(
          askIn('/ws/w1/repo-b', [held]),
          askIn('/ws/w1/repo-a', [
            grant({ kind: 'network', host: '*.npmjs.org' }),
          ]),
        ),
      ).toBe(true);
      expect(
        await within(
          askIn('/ws/w1/repo-a', [held]),
          askIn('/ws/w1/repo-a', []),
        ),
      ).toBe(false);
    });

    it.each([
      ['an MCP', grant({ kind: 'mcp', server: 'github', tool: 'merge' })],
      ['a tool', grant({ kind: 'tool', toolName: 'WebFetch' })],
    ])(
      "refuses %s grant held by a target outside the caller's root",
      async (_kind, held) => {
        expect(
          await within(
            askIn('/ws/w1/repo-b', [held]),
            askIn('/ws/w1/repo-a', [held]),
          ),
        ).toBe(false);
        expect(
          await within(
            askIn('/ws/w1/repo-a', [held]),
            askIn('/ws/w1/repo-a', [held]),
          ),
        ).toBe(true);
      },
    );

    it('compares browser upload grants in every mode, in the root they upload from, and denies by origin and path', async () => {
      const staging = grant({
        kind: 'browser-upload',
        origin: 'https://canopy.ud-staging.com',
      });
      const reports = grant({
        kind: 'browser-upload',
        origin: 'https://canopy.ud-staging.com',
        path: 'reports/**',
      });
      const fullAccessIn = (
        root: string,
        rules: readonly ApprovalRule[],
      ): ChatApprovalPolicy => ({
        mode: 'full-access',
        sessionRules: rules,
        root,
      });
      // An upload rule once made every policy unknown, which refused every
      // message between Full Access chats.
      expect(
        await within(
          fullAccessIn('/ws/worktrees/b', [staging]),
          fullAccessIn('/ws/worktrees/a', [staging]),
        ),
      ).toBe(true);
      // No mode uploads without a rule, so Full Access does not cover a
      // target's upload grant.
      expect(
        await within(
          fullAccessIn('/ws/worktrees/b', [staging]),
          fullAccessIn('/ws/worktrees/a', []),
        ),
      ).toBe(false);
      expect(
        await within(
          askIn('/ws/worktrees/b', [reports]),
          fullAccessIn('/ws/worktrees/a', [staging]),
        ),
      ).toBe(true);
      // A grant uploads files from its own chat's worktree.
      expect(
        await within(
          askIn('/ws/w1/repo-a', [staging]),
          askIn('/ws/w1/repo-a', [staging]),
        ),
      ).toBe(true);
      expect(
        await within(
          askIn('/ws/w1/repo-a', [reports]),
          askIn('/ws/w1/repo-a', [staging]),
        ),
      ).toBe(true);
      expect(
        await within(
          askIn('/ws/w1/repo-b', [staging]),
          askIn('/ws/w1/repo-a', [staging]),
        ),
      ).toBe(false);
      expect(
        await within(
          askIn('/ws/w1/repo-a', [staging]),
          askIn('/ws/w1/repo-a', [reports]),
        ),
      ).toBe(false);
      expect(
        await within(
          askIn('/ws/w1/repo-a', [staging]),
          askIn('/ws/w1/repo-a', []),
        ),
      ).toBe(false);
      const deny = (rule: ApprovalRule): ApprovalRule => ({
        ...rule,
        id: `deny-${rule.id}`,
        behavior: 'deny',
      });
      // A path deny protects files of its own chat's worktree.
      expect(
        await within(
          fullAccessIn('/ws/worktrees/a', [deny(reports)]),
          fullAccessIn('/ws/worktrees/a', [deny(reports)]),
        ),
      ).toBe(true);
      expect(
        await within(
          fullAccessIn('/ws/worktrees/b', [deny(reports)]),
          fullAccessIn('/ws/worktrees/a', [deny(reports)]),
        ),
      ).toBe(false);
      expect(
        await within(
          fullAccessIn('/ws/worktrees/b', [deny(staging)]),
          fullAccessIn('/ws/worktrees/a', [deny(reports)]),
        ),
      ).toBe(true);
      expect(
        await within(
          fullAccessIn('/ws/worktrees/b', [deny(reports)]),
          fullAccessIn('/ws/worktrees/a', [deny(staging)]),
        ),
      ).toBe(false);
    });

    it('fails closed when a chat holding a grant has no root', async () => {
      expect(
        await within(
          askIn(undefined, [npmTest]),
          askIn('/ws/w1/repo-a', [npmTest]),
        ),
      ).toBe(false);
      expect(
        await within(
          askIn('/ws/w1/repo-a', [npmTest]),
          askIn(undefined, [npmTest]),
        ),
      ).toBe(false);
    });

    it("keeps a grant-free target outside the caller's root as before, and the caller's deny rules as they are", async () => {
      const deny: ApprovalRule = {
        ...npmTest,
        id: 'deny-npm-test',
        behavior: 'deny',
      };
      expect(
        await within(
          askIn('/ws/w1/repo-b', [deny]),
          askIn('/ws/w1/repo-a', [deny]),
        ),
      ).toBe(true);
      expect(
        await within(
          askIn('/ws/w1/repo-b', []),
          askIn('/ws/w1/repo-a', [deny]),
        ),
      ).toBe(false);
    });
  });
});

describe('standalone native workflow policy withdrawal', () => {
  it.each(['disconnect', 'unreadable'])(
    'the preferences watch withdraws a running host on %s',
    async (change) => {
      const root = await mkdtemp(join(tmpdir(), 'native-policy-withdrawal-'));
      const previous = process.env.CANOPY_DATA_DIR;
      process.env.CANOPY_DATA_DIR = root;
      const cwd = join(root, 'workspace');
      await mkdir(cwd);
      const preferences = join(root, 'preferences.json');
      await writeFile(
        preferences,
        JSON.stringify({
          version: 1,
          preferences: {
            globalApprovalRules: [],
            googleSubscriptionDisconnected: false,
          },
        }),
      );
      let finish: (() => void) | undefined;
      const withdrawn = new Promise<void>((resolve) => {
        finish = resolve;
      });
      jest.mocked(openAntigravityRuntime).mockImplementation((input) => {
        input.signal?.addEventListener('abort', () => finish?.(), {
          once: true,
        });
        return Promise.resolve({
          client: {} as AcpClient,
          close: (): Promise<void> => Promise.resolve(),
        });
      });
      const host = createCliAntigravityHost({
        cwd,
        environment: {},
        model: 'antigravity:gemini-test',
        permissionPreset: 'dangerous_all',
        prompt: 'fixture',
        totalTimeoutMs: 5000,
        executionsDir: join(root, 'runs'),
        executionId: 'policy',
        jobId: 'main',
        stepId: 'native',
        attempt: 1,
      });
      let timer: NodeJS.Timeout | undefined;
      try {
        await host.open({
          profile: join(root, 'profile'),
          signal: new AbortController().signal,
          onUpdate() {},
          onPermission: (): Promise<'deny'> => Promise.resolve('deny'),
        });
        await writeFile(
          preferences,
          change === 'unreadable'
            ? '{broken'
            : JSON.stringify({
                version: 1,
                preferences: { googleSubscriptionDisconnected: true },
              }),
        );
        await Promise.race([
          withdrawn,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    'Policy withdrawal did not reach the owned runtime',
                  ),
                ),
              5000,
            );
          }),
        ]);
        await expect(host.assertEnabled()).rejects.toThrow();
      } finally {
        clearTimeout(timer);
        await host.dispose?.();
        jest.mocked(openAntigravityRuntime).mockReset();
        if (previous === undefined) delete process.env.CANOPY_DATA_DIR;
        else process.env.CANOPY_DATA_DIR = previous;
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
