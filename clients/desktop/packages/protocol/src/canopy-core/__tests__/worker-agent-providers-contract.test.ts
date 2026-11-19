import {
  WORKER_AGENT_PROVIDER_QUERY_DEFINITIONS,
  WorkerAgentProviderListParamsSchema,
  WorkerAgentProviderListResultSchema,
  type WorkerAgentModel,
  type WorkerAgentProviderListResult,
} from '../worker/agent-providers';
import { WorkerAgentUsageLimitsGetParamsSchema } from '../worker/agent-usage-limits';
import {
  UsageLimitsSnapshotSchema,
  type UsageLimitsSnapshot,
} from '../../provider-usage';

const checkedAt = '2026-11-05T12:00:00.000Z';

function usageSnapshot(): UsageLimitsSnapshot {
  return {
    schemaVersion: 1,
    snapshotAt: checkedAt,
    completeness: 'partial',
    sources: [
      { source: 'account_proxy', state: 'observed', observedAt: checkedAt },
    ],
    accounts: [
      {
        accountId: 'snapshot-account-1',
        provider: 'codex',
        source: 'account_proxy',
        authState: 'authenticated',
        status: 'cooling',
        inventoryObservedAt: checkedAt,
        usageObservedAt: checkedAt,
        usageSource: 'passive',
        usageState: 'reported',
        limits: [
          {
            id: 'review',
            label: 'Code review',
            scope: {
              model: { id: 'gpt', displayName: null },
              surface: 'review',
            },
            windows: [
              {
                kind: 'secondary',
                usedPercent: 120,
                remaining: 0,
                limit: 100,
                resetsAt: checkedAt,
                windowDurationMs: 604_800_000,
              },
            ],
          },
        ],
      },
    ],
  };
}

it('usage snapshots retain scoped over-limit observations but refuse raw and monetary fields', () => {
  const fixture = usageSnapshot();
  expect(UsageLimitsSnapshotSchema.parse(fixture)).toEqual(fixture);
  for (const leak of [
    (snapshot: UsageLimitsSnapshot): void => {
      Object.assign(snapshot, { raw: {} });
    },
    (snapshot: UsageLimitsSnapshot): void => {
      Object.assign(snapshot.accounts[0], { fileName: 'credential.json' });
    },
    (snapshot: UsageLimitsSnapshot): void => {
      Object.assign(snapshot.accounts[0]?.limits[0] ?? {}, {
        credits: { remaining: 1 },
      });
    },
    (snapshot: UsageLimitsSnapshot): void => {
      Object.assign(snapshot.accounts[0]?.limits[0]?.windows[0] ?? {}, {
        spend: 1,
      });
    },
    (snapshot: UsageLimitsSnapshot): void => {
      Object.assign(snapshot.sources[0], { statusMessage: 'raw error' });
    },
  ]) {
    const snapshot = usageSnapshot();
    leak(snapshot);
    expect(UsageLimitsSnapshotSchema.safeParse(snapshot).success).toBe(false);
  }
  for (const value of [Infinity, -Infinity, NaN]) {
    const snapshot = usageSnapshot();
    Object.assign(snapshot.accounts[0]?.limits[0]?.windows[0] ?? {}, {
      usedPercent: value,
    });
    expect(UsageLimitsSnapshotSchema.safeParse(snapshot).success).toBe(false);
  }
});

it('usage queries accept only worker selection, never refresh or caller-supplied grants', () => {
  expect(
    WorkerAgentUsageLimitsGetParamsSchema.safeParse({
      scope: { authorityId: 'local-desktop', targetId: 'in_process_worker' },
    }).success,
  ).toBe(true);
  for (const params of [
    { scope: {}, refresh: true },
    { scope: { workspaceId: 'workspace' } },
    { scope: {}, grants: ['worker.agent.usage.read'] },
  ])
    expect(
      WorkerAgentUsageLimitsGetParamsSchema.safeParse(params).success,
    ).toBe(false);
});

function model(
  modelId: string,
  overrides: Partial<WorkerAgentModel> = {},
): WorkerAgentModel {
  return {
    modelId,
    name: modelId,
    contextWindow: 200_000,
    outputLimit: null,
    billingSources: ['provider_account'],
    gatewayOrigin: null,
    thinkingLevels: ['low', 'high'],
    blockedByOrganization: false,
    ...overrides,
  };
}

function fullList(): WorkerAgentProviderListResult {
  return {
    authorityId: 'local-desktop',
    targetId: 'in_process_worker',
    probed: false,
    providers: [
      {
        providerId: 'claude',
        name: 'Claude',
        authState: 'ready',
        checkedAt,
        models: [model('claude-opus')],
        usageLimit: {
          authState: 'authenticated',
          lastUpdatedAt: checkedAt,
          error: null,
          windows: [
            {
              id: 'five-hour',
              label: '5 hours',
              usedPercent: 42,
              resetsAt: checkedAt,
              windowDurationMs: 18_000_000,
            },
          ],
          accountProxy: {
            accounts: [
              {
                status: 'active',
                usageSource: 'live',
                lastUpdatedAt: checkedAt,
                windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 10 }],
              },
            ],
          },
        },
      },
      {
        providerId: 'codex',
        name: 'Codex',
        authState: 'missing',
        checkedAt,
        models: [
          model('gpt-codex', {
            billingSources: ['provider_account', 'ai_credits'],
            gatewayOrigin: 'hosted',
          }),
        ],
        usageLimit: {
          authState: 'error',
          lastUpdatedAt: null,
          error: { kind: 'network', message: 'Usage is unavailable.' },
          windows: [],
          accountProxy: null,
        },
      },
      {
        providerId: 'ollama',
        name: 'Ollama',
        authState: 'ready',
        checkedAt,
        models: [
          model('llama3', {
            contextWindow: null,
            billingSources: ['local'],
            thinkingLevels: null,
          }),
        ],
        usageLimit: null,
      },
      {
        providerId: 'cursor',
        name: 'Cursor',
        authState: 'error',
        checkedAt,
        models: [],
        usageLimit: null,
      },
      {
        providerId: 'copilot',
        name: 'Copilot',
        authState: 'ready',
        checkedAt,
        models: [model('copilot-gpt')],
        usageLimit: null,
      },
      {
        providerId: 'opencode',
        name: 'OpenCode',
        authState: 'missing',
        checkedAt,
        models: [],
        usageLimit: null,
      },
    ],
  };
}

it('a full provider list round-trips and unknown result fields are refused', () => {
  const fixture = fullList();
  const parsed = WorkerAgentProviderListResultSchema.safeParse(fixture);
  expect(parsed.success).toBe(true);
  expect(parsed.data).toEqual(fixture);

  const leaks: ((list: WorkerAgentProviderListResult) => void)[] = [
    (list) => Object.assign(list.providers[0], { accountEmail: 'a@b.c' }),
    (list) =>
      Object.assign(list.providers[0].usageLimit ?? {}, {
        accountEmail: 'a@b.c',
      }),
    (list) =>
      Object.assign(
        list.providers[0].usageLimit?.accountProxy?.accounts[0] ?? {},
        { accountEmail: 'a@b.c' },
      ),
    (list) =>
      Object.assign(list.providers[0].models[0], { accountEmail: 'a@b.c' }),
  ];
  for (const leak of leaks) {
    const list = fullList();
    leak(list);
    expect(WorkerAgentProviderListResultSchema.safeParse(list).success).toBe(
      false,
    );
  }
});

it('params require probe and refuse unknown scope keys', () => {
  expect(
    WorkerAgentProviderListParamsSchema.safeParse({ scope: {} }).success,
  ).toBe(false);
  expect(
    WorkerAgentProviderListParamsSchema.safeParse({
      scope: { path: '/x' },
      probe: false,
    }).success,
  ).toBe(false);
  expect(
    WorkerAgentProviderListParamsSchema.safeParse({
      scope: { targetId: 'in_process_worker' },
      probe: true,
    }).success,
  ).toBe(true);
});

it('auth states and billing sources are closed', () => {
  const unknownAuth = fullList();
  Object.assign(unknownAuth.providers[0], { authState: 'unknown' });
  expect(
    WorkerAgentProviderListResultSchema.safeParse(unknownAuth).success,
  ).toBe(false);

  const orgGatewayBilling = fullList();
  Object.assign(orgGatewayBilling.providers[0].models[0], {
    billingSources: ['org_gateway'],
  });
  expect(
    WorkerAgentProviderListResultSchema.safeParse(orgGatewayBilling).success,
  ).toBe(false);
});

it("the definition matches the catalog page's contract", () => {
  expect(
    WORKER_AGENT_PROVIDER_QUERY_DEFINITIONS['worker.agent.provider.list'],
  ).toMatchObject({
    placement: 'target-selectable',
    idempotency: 'inherent',
    requiredGrants: ['worker.agent.read'],
    plane: 'worker',
  });
});
