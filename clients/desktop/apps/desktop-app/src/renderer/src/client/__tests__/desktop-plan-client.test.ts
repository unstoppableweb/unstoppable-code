import {
  createTrackedPlan,
  deleteTrackedPlan,
  getTrackedPlan,
  importTrackedPlan,
  listDetectedPlans,
  listTrackedPlans,
  scanDetectedPlans,
  updateDetectedPlan,
  updateTrackedPlan,
} from '../desktop-plan-client';
import type {
  DetectedPlanEntry,
  DetectedPlansUpdatedEvent,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { useActivityStore } from '../../stores/activityStore';
import { subscribeDetectedPlans } from '../../hooks/useDetectedPlansSubscription';

jest.mock('@canopy/desktop-instrumentation/client', () => ({
  reportClientAppError: jest.fn(),
}));

const SCOPE = { projectId: 'proj', worktreeId: 'wt' };
const PLAN: TrackedPlanData = {
  id: 'plan-1',
  ...SCOPE,
  source: 'claude',
  title: 'Plan',
  content: '# Plan',
  reviewStatus: 'pending',
  createdAt: '2026-11-23T00:00:00.000Z',
  updatedAt: '2026-11-23T00:00:00.000Z',
  latestRevisionNumber: 1,
  revisions: [
    {
      revisionNumber: 1,
      content: '# Plan',
      source: 'claude',
      reviewStatus: 'pending',
      createdAt: '2026-11-23T00:00:00.000Z',
    },
  ],
  linkedExecutionIds: [],
};
// A portable record the desktop's reader guard refuses: its share state is
// not a tracked share.
const UNTRACKED = { ...PLAN, id: 'plan-2', share: { serverId: 1 } };
const DETECTED = {
  id: 'det-1',
  sourceRepoId: '__workspace_root__',
  sourceFilePath: 'plan.md',
  status: 'detected',
  bannerSeen: false,
  detectedInChatId: 'chat-1',
  detectedAt: '2026-11-23T00:00:00.000Z',
};

interface Channels {
  list: jest.Mock;
  listWithSkipped: jest.Mock;
  get: jest.Mock;
  detectedList: jest.Mock;
  detectedScan: jest.Mock;
  detectedUpdate: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  import: jest.Mock;
}

function stubWindow(mode: 'local' | 'remote', invoke: jest.Mock): Channels {
  const channels: Channels = {
    list: jest.fn(() => Promise.resolve([PLAN])),
    listWithSkipped: jest.fn(() => Promise.resolve({ plans: [PLAN] })),
    get: jest.fn(() => Promise.resolve(PLAN)),
    detectedList: jest.fn(() => Promise.resolve([DETECTED])),
    detectedScan: jest.fn(() =>
      Promise.resolve({ entries: [DETECTED], newlyDetected: [DETECTED] }),
    ),
    detectedUpdate: jest.fn(() => Promise.resolve([DETECTED])),
    create: jest.fn(() => Promise.resolve(PLAN)),
    update: jest.fn(() => Promise.resolve(PLAN)),
    delete: jest.fn(() => Promise.resolve()),
    import: jest.fn(() =>
      Promise.resolve({ plan: PLAN, trackedPlanFilePath: '/host/plans.json' }),
    ),
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      canopyCore: { invoke },
      api: {
        remoteControl: { getContext: () => ({ mode }) },
        activity: {
          plans: {
            list: channels.list,
            listWithSkipped: channels.listWithSkipped,
            get: channels.get,
            create: channels.create,
            update: channels.update,
            delete: channels.delete,
            import: channels.import,
          },
          detectedPlans: {
            list: channels.detectedList,
            scan: channels.detectedScan,
            update: channels.detectedUpdate,
          },
        },
      },
    },
  });
  return channels;
}

function relayAnswering(
  value: (method: string) => unknown,
): jest.Mock<Promise<unknown>, [{ method: string }]> {
  return jest.fn((request: { method: string }) =>
    Promise.resolve({ ok: true, value: value(request.method) }),
  );
}

function untouched(channels: Channels): void {
  for (const channel of Object.values(channels))
    expect(channel).not.toHaveBeenCalled();
}

describe('desktop plan reads (CAN-4165 PR 7a)', () => {
  it("reads the main window's plans through core.plan on the relay, and leaves out a record that is not a tracked plan", async () => {
    const invoke = relayAnswering((method) =>
      method === 'core.plan.list'
        ? { plans: [PLAN, UNTRACKED], skipped: 1 }
        : method === 'core.plan.get'
          ? { plan: PLAN }
          : { detected: [DETECTED] },
    );
    const channels = stubWindow('local', invoke);

    await expect(listTrackedPlans({ ...SCOPE })).resolves.toEqual({
      plans: [PLAN],
      skipped: 2,
    });
    await expect(
      getTrackedPlan({ ...SCOPE, planId: 'plan-1' }),
    ).resolves.toEqual(PLAN);
    await expect(listDetectedPlans({ ...SCOPE })).resolves.toEqual([DETECTED]);

    expect(invoke.mock.calls.map(([request]) => request)).toEqual([
      { kind: 'request', method: 'core.plan.list', params: { scope: SCOPE } },
      {
        kind: 'request',
        method: 'core.plan.get',
        params: { scope: SCOPE, planId: 'plan-1' },
      },
      {
        kind: 'request',
        method: 'core.plan.detected.list',
        params: { scope: SCOPE },
      },
    ]);
    untouched(channels);
  });

  it('answers a missing plan, and one that is not a tracked plan, as null', async () => {
    const answers = [{ plan: null }, { plan: UNTRACKED }];
    const invoke = relayAnswering(() => answers.shift());
    stubWindow('local', invoke);

    await expect(
      getTrackedPlan({ ...SCOPE, planId: 'gone' }),
    ).resolves.toBeNull();
    await expect(
      getTrackedPlan({ ...SCOPE, planId: 'plan-2' }),
    ).resolves.toBeNull();
  });

  it("rejects with the refusal's own message, and on a reply it cannot read", async () => {
    const replies: unknown[] = [
      {
        ok: false,
        error: {
          kind: 'failed_precondition',
          code: 'core.plan.unsupportedScope',
          message: 'This scope does not have tracked plans.',
          retry: { kind: 'never' },
        },
      },
      { ok: true, value: { plans: 'not a list' } },
    ];
    const invoke = jest.fn(() => Promise.resolve(replies.shift()));
    const channels = stubWindow('local', invoke);

    await expect(listTrackedPlans({ ...SCOPE })).rejects.toThrow(
      'This scope does not have tracked plans.',
    );
    await expect(listTrackedPlans({ ...SCOPE })).rejects.toThrow();
    untouched(channels);
  });

  describe('a reply the relay refuses for its size', () => {
    // The relay's reply cap or the in-memory binding's frame cap.
    const sizeRefusal = (resource: 'reply' | 'relay.frame'): jest.Mock =>
      jest.fn(() =>
        Promise.resolve({
          ok: false,
          error: {
            kind: 'resource_exhausted',
            message: 'The relay reply exceeded the cap.',
            retry: { kind: 'after_refresh', resource },
          },
        }),
      );

    it('reads the plan list over its channel', async () => {
      const channels = stubWindow('local', sizeRefusal('reply'));
      await expect(listTrackedPlans({ ...SCOPE })).resolves.toEqual({
        plans: [PLAN],
      });
      expect(channels.listWithSkipped).toHaveBeenCalledWith(SCOPE);
    });

    it('reads the plan over its channel', async () => {
      const channels = stubWindow('local', sizeRefusal('relay.frame'));
      await expect(
        getTrackedPlan({ ...SCOPE, planId: 'plan-1' }),
      ).resolves.toEqual(PLAN);
      expect(channels.get).toHaveBeenCalledWith({ ...SCOPE, planId: 'plan-1' });
    });

    it('reads the detected list over its channel', async () => {
      const channels = stubWindow('local', sizeRefusal('reply'));
      await expect(listDetectedPlans({ ...SCOPE })).resolves.toEqual([
        DETECTED,
      ]);
      expect(channels.detectedList).toHaveBeenCalledWith(SCOPE);
    });

    it('but a busy relay still fails with its own message and no fallback', async () => {
      const invoke = jest.fn(() =>
        Promise.resolve({
          ok: false,
          error: {
            kind: 'resource_exhausted',
            message: 'Too many concurrent relay calls.',
            retry: { kind: 'after_refresh', resource: 'relay' },
          },
        }),
      );
      const channels = stubWindow('local', invoke);
      await expect(listTrackedPlans({ ...SCOPE })).rejects.toThrow(
        'Too many concurrent relay calls.',
      );
      // The first read and its three busy re-sends.
      expect(invoke).toHaveBeenCalledTimes(4);
      untouched(channels);
    });
  });

  it('keeps the channels in a remote window, where the relay is blocked', async () => {
    const invoke = jest.fn();
    const channels = stubWindow('remote', invoke);

    await expect(listTrackedPlans({ ...SCOPE })).resolves.toEqual({
      plans: [PLAN],
    });
    await expect(
      getTrackedPlan({ ...SCOPE, planId: 'plan-1' }),
    ).resolves.toEqual(PLAN);
    await expect(listDetectedPlans({ ...SCOPE })).resolves.toEqual([DETECTED]);

    expect(channels.listWithSkipped).toHaveBeenCalledWith(SCOPE);
    expect(channels.get).toHaveBeenCalledWith({ ...SCOPE, planId: 'plan-1' });
    expect(channels.detectedList).toHaveBeenCalledWith(SCOPE);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('falls back to the plain list in a remote window whose host refuses the newer read', async () => {
    const channels = stubWindow('remote', jest.fn());
    channels.listWithSkipped.mockRejectedValueOnce(
      new Error('unknown channel'),
    );

    await expect(listTrackedPlans({ ...SCOPE })).resolves.toEqual({
      plans: [PLAN],
    });
    expect(channels.list).toHaveBeenCalledWith(SCOPE);
  });
});

describe('desktop plan writes (CAN-4165 PR 7b)', () => {
  const keyOf = (request: unknown): unknown =>
    (request as { params: { _meta: { idempotencyKey: string } } }).params._meta
      .idempotencyKey;

  it("writes the main window's plans through core.plan on the relay, each action under its own key", async () => {
    const invoke = relayAnswering((method) =>
      method === 'core.plan.delete' ? { deleted: true } : { plan: PLAN },
    );
    const channels = stubWindow('local', invoke);

    await expect(
      createTrackedPlan({
        ...SCOPE,
        id: 'plan-1',
        source: 'claude',
        content: '# Plan',
        reviewStatus: 'pending',
        chatId: 'chat-1',
      }),
    ).resolves.toEqual(PLAN);
    await expect(
      updateTrackedPlan({ ...SCOPE, planId: 'plan-1', hidden: true }),
    ).resolves.toEqual(PLAN);
    await expect(
      deleteTrackedPlan({ ...SCOPE, planId: 'plan-1' }),
    ).resolves.toBeUndefined();
    await expect(
      importTrackedPlan({
        ...SCOPE,
        filePath: 'docs/plan.md',
        repoId: '__workspace_root__',
      }),
    ).resolves.toEqual(PLAN);

    const requests = invoke.mock.calls.map(([request]) => request);
    expect(requests).toMatchObject([
      {
        kind: 'request',
        method: 'core.plan.create',
        params: {
          scope: SCOPE,
          planId: 'plan-1',
          source: 'claude',
          content: '# Plan',
          reviewStatus: 'pending',
          chatId: 'chat-1',
        },
      },
      {
        kind: 'request',
        method: 'core.plan.update',
        params: { scope: SCOPE, planId: 'plan-1', hidden: true },
      },
      {
        kind: 'request',
        method: 'core.plan.delete',
        params: { scope: SCOPE, planId: 'plan-1' },
      },
      {
        kind: 'request',
        method: 'core.plan.import',
        params: {
          scope: SCOPE,
          repoId: '__workspace_root__',
          path: 'docs/plan.md',
        },
      },
    ]);
    const keys = requests.map(keyOf);
    expect(keys.every((key) => typeof key === 'string' && key !== '')).toBe(
      true,
    );
    expect(new Set(keys).size).toBe(4);
    untouched(channels);
  });

  it('sends no undefined value at any depth, which the relay cannot carry', async () => {
    const undefinedPaths = (value: unknown, path = ''): string[] =>
      value === undefined
        ? [path]
        : typeof value === 'object' && value !== null
          ? Object.entries(value).flatMap(([key, entry]) =>
              undefinedPaths(entry, `${path}.${key}`),
            )
          : [];
    const invoke = relayAnswering(() => ({ plan: PLAN }));
    stubWindow('local', invoke);

    await createTrackedPlan({ ...SCOPE, source: 'claude', content: '# Plan' });
    await updateTrackedPlan({
      ...SCOPE,
      planId: 'plan-1',
      hidden: true,
      approvedAt: null,
    });
    await importTrackedPlan({ ...SCOPE, filePath: 'plan.md', repoId: 'repo' });

    expect(
      invoke.mock.calls.flatMap(([request]) => undefinedPaths(request)),
    ).toEqual([]);
    // A null clears a review timestamp, so it is sent as it is.
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({
      params: { approvedAt: null },
    });
  });

  it('re-sends a write whose reply was lost once, under the same key', async () => {
    const replies: unknown[] = [
      {
        ok: false,
        error: {
          kind: 'unavailable',
          message: 'The relay is unavailable.',
          retry: { kind: 'same_idempotency_key' },
        },
      },
      { ok: true, value: { plan: PLAN } },
    ];
    const invoke = jest.fn<Promise<unknown>, [unknown]>(() =>
      Promise.resolve(replies.shift()),
    );
    stubWindow('local', invoke);

    await expect(
      updateTrackedPlan({ ...SCOPE, planId: 'plan-1', content: '# Two' }),
    ).resolves.toEqual(PLAN);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(keyOf(invoke.mock.calls[1]?.[0])).toBe(
      keyOf(invoke.mock.calls[0]?.[0]),
    );
  });

  it('rejects a refusal with its own message, once, and never re-writes over the channel', async () => {
    const readOnly = jest.fn(() =>
      Promise.resolve({
        ok: false,
        error: {
          kind: 'permission_denied',
          code: 'core.plan.readOnlyScope',
          message: 'Shared-container recipient workspaces are read-only',
          retry: { kind: 'never' },
        },
      }),
    );
    const channels = stubWindow('local', readOnly);
    await expect(
      createTrackedPlan({ ...SCOPE, source: 'claude', content: '# Plan' }),
    ).rejects.toThrow('Shared-container recipient workspaces are read-only');
    expect(readOnly).toHaveBeenCalledTimes(1);
    untouched(channels);
  });

  describe('a write whose reply the relay refuses for its size', () => {
    // A keyed write's reply over the relay's reply cap or the binding's frame
    // cap is refused after the write committed, under its key. The committed
    // plan is as large, so the relay refuses its read-back for size too, and
    // the read falls back to the channel.
    const SIZE_REFUSAL = {
      ok: false,
      error: {
        kind: 'resource_exhausted',
        message: 'The relay reply exceeded the cap.',
        retry: { kind: 'same_idempotency_key' },
      },
    };
    const READ_REFUSAL = {
      ok: false,
      error: {
        kind: 'resource_exhausted',
        message: 'The relay reply exceeded the cap.',
        retry: { kind: 'after_refresh', resource: 'reply' },
      },
    };
    const BIG: TrackedPlanData = { ...PLAN, content: '# Big' };
    const proposal = (
      id: string,
      proposalRequestId: string,
    ): TrackedPlanData => ({
      ...BIG,
      id,
      revisions: BIG.revisions.map((revision) => ({
        ...revision,
        proposalRequestId,
      })),
    });
    interface Sent {
      method: string;
      params: { planId?: unknown };
    }
    const oversized = (): jest.Mock<Promise<unknown>, [Sent]> =>
      jest.fn((request: Sent) =>
        Promise.resolve(
          request.method === 'core.plan.get' ||
            request.method === 'core.plan.list'
            ? READ_REFUSAL
            : SIZE_REFUSAL,
        ),
      );
    const methods = (invoke: jest.Mock<Promise<unknown>, [Sent]>): string[] =>
      invoke.mock.calls.map(([request]) => request.method);
    /** A window whose channels read the committed plans. */
    const committed = (
      invoke: jest.Mock<Promise<unknown>, [Sent]>,
      plans: TrackedPlanData[],
    ): Channels => {
      const channels = stubWindow('local', invoke);
      channels.get.mockImplementation((request: { planId: string }) =>
        Promise.resolve(
          plans.find((plan) => plan.id === request.planId) ?? null,
        ),
      );
      channels.listWithSkipped.mockResolvedValue({ plans });
      return channels;
    };
    const noChannelWrite = (channels: Channels): void => {
      for (const write of [
        channels.create,
        channels.update,
        channels.delete,
        channels.import,
      ])
        expect(write).not.toHaveBeenCalled();
    };

    it('reads an updated plan back over the channel, without re-sending the write', async () => {
      const invoke = oversized();
      const channels = committed(invoke, [BIG]);
      await expect(
        updateTrackedPlan({ ...SCOPE, planId: 'plan-1', content: '# Big' }),
      ).resolves.toEqual(BIG);
      expect(methods(invoke)).toEqual(['core.plan.update', 'core.plan.get']);
      expect(channels.get).toHaveBeenCalledWith({ ...SCOPE, planId: 'plan-1' });
      noChannelWrite(channels);
    });

    it('reads a plan created under its id back over the channel', async () => {
      const invoke = oversized();
      const channels = committed(invoke, [BIG]);
      await expect(
        createTrackedPlan({
          ...SCOPE,
          id: 'plan-1',
          source: 'claude',
          content: '# Big',
        }),
      ).resolves.toEqual(BIG);
      expect(methods(invoke)).toEqual(['core.plan.create', 'core.plan.get']);
      expect(channels.get).toHaveBeenCalledWith({ ...SCOPE, planId: 'plan-1' });
      noChannelWrite(channels);
    });

    it('gives a create without an id its own, so it reads that plan back', async () => {
      const invoke = oversized();
      const channels = stubWindow('local', invoke);
      channels.get.mockImplementation((request: { planId: string }) =>
        Promise.resolve({ ...BIG, id: request.planId }),
      );
      const created = await createTrackedPlan({
        ...SCOPE,
        source: 'claude',
        content: '# Big',
      });
      expect(methods(invoke)).toEqual(['core.plan.create', 'core.plan.get']);
      const planId = invoke.mock.calls[0]?.[0].params.planId;
      expect(typeof planId).toBe('string');
      expect(created).toEqual({ ...BIG, id: planId });
      expect(channels.get).toHaveBeenCalledWith({ ...SCOPE, planId });
      noChannelWrite(channels);
    });

    it('reads a proposal re-save back by its proposal request, which may name a stored plan under another id', async () => {
      const stored = proposal('stored-plan', 'req-9');
      const invoke = oversized();
      const channels = committed(invoke, [PLAN, stored]);
      await expect(
        createTrackedPlan({
          ...SCOPE,
          source: 'codex',
          content: '# Big',
          proposalRequestId: 'req-9',
        }),
      ).resolves.toEqual(stored);
      expect(methods(invoke)).toEqual([
        'core.plan.create',
        'core.plan.get',
        'core.plan.list',
      ]);
      expect(channels.listWithSkipped).toHaveBeenCalledWith(SCOPE);
      noChannelWrite(channels);
    });

    it('finds a Cursor proposal create, which keeps no id, by its proposal request', async () => {
      // A Cursor proposal without an id merges into its chat's pending plan.
      const stored = proposal('pending-plan', 'req-1');
      const invoke = oversized();
      const channels = committed(invoke, [PLAN, stored]);
      await expect(
        createTrackedPlan({
          ...SCOPE,
          source: 'cursor',
          content: '# Big',
          proposalRequestId: 'req-1',
          chatId: 'chat-1',
        }),
      ).resolves.toEqual(stored);
      expect(methods(invoke)).toEqual(['core.plan.create', 'core.plan.list']);
      expect(invoke.mock.calls[0]?.[0].params.planId).toBeUndefined();
      expect(channels.listWithSkipped).toHaveBeenCalledWith(SCOPE);
      noChannelWrite(channels);
    });

    it("still fails an import, which it can't read back, with the relay's refusal as the cause", async () => {
      const invoke = oversized();
      const channels = committed(invoke, [BIG]);
      await expect(
        importTrackedPlan({ ...SCOPE, filePath: 'plan.md', repoId: 'repo' }),
      ).rejects.toMatchObject({
        message: 'The relay reply exceeded the cap.',
        cause: {
          kind: 'resource_exhausted',
          retry: { kind: 'same_idempotency_key' },
        },
      });
      expect(methods(invoke)).toEqual(['core.plan.import']);
      untouched(channels);
    });
  });

  describe('a write the relay turns away as busy, before dispatching it', () => {
    const BUSY = {
      ok: false,
      error: {
        kind: 'resource_exhausted',
        message: 'Too many concurrent relay calls.',
        retry: { kind: 'after_refresh', resource: 'relay' },
      },
    };

    it('lands a 33rd write once a call slot frees, under the same key', async () => {
      // The relay's 32-call cap, with every slot held until the 33rd is turned away.
      let inFlight = 0;
      let holding = true;
      const held: (() => void)[] = [];
      const answer = { ok: true, value: { plan: PLAN } };
      const invoke = jest.fn<Promise<unknown>, [unknown]>(() => {
        if (inFlight >= 32) {
          holding = false;
          queueMicrotask(() => held.splice(0).forEach((release) => release()));
          return Promise.resolve(BUSY);
        }
        if (!holding) return Promise.resolve(answer);
        inFlight += 1;
        return new Promise((resolve) =>
          held.push(() => {
            inFlight -= 1;
            resolve(answer);
          }),
        );
      });
      stubWindow('local', invoke);
      const writes = Array.from({ length: 33 }, (_, index) =>
        updateTrackedPlan({ ...SCOPE, planId: `plan-${index}`, hidden: true }),
      );
      await expect(Promise.all(writes)).resolves.toHaveLength(33);
      expect(invoke).toHaveBeenCalledTimes(34);
      const turnedAway = invoke.mock.calls[32]?.[0];
      expect(keyOf(invoke.mock.calls[33]?.[0])).toBe(keyOf(turnedAway));
    });

    it("backs a size-refused write's read-back off a busy relay, without re-sending the write", async () => {
      const big = { ...PLAN, content: '# Big' };
      const replies: unknown[] = [
        {
          ok: false,
          error: {
            kind: 'resource_exhausted',
            message: 'The relay reply exceeded the cap.',
            retry: { kind: 'same_idempotency_key' },
          },
        },
        BUSY,
        BUSY,
        { ok: true, value: { plan: big } },
      ];
      const invoke = jest.fn<Promise<unknown>, [{ method: string }]>(() =>
        Promise.resolve(replies.shift()),
      );
      const channels = stubWindow('local', invoke);
      await expect(
        updateTrackedPlan({ ...SCOPE, planId: 'plan-1', content: '# Big' }),
      ).resolves.toEqual(big);
      expect(invoke.mock.calls.map(([request]) => request.method)).toEqual([
        'core.plan.update',
        'core.plan.get',
        'core.plan.get',
        'core.plan.get',
      ]);
      untouched(channels);
    });

    it('stops after three re-sends', async () => {
      const invoke = jest.fn(() => Promise.resolve(BUSY));
      stubWindow('local', invoke);
      await expect(
        deleteTrackedPlan({ ...SCOPE, planId: 'plan-1' }),
      ).rejects.toThrow('Too many concurrent relay calls.');
      expect(invoke).toHaveBeenCalledTimes(4);
    });

    it("backs a lost reply's same-key replay off a busy relay too, within the same bound", async () => {
      const LOST = {
        ok: false,
        error: {
          kind: 'unavailable',
          message: 'The relay is unavailable.',
          retry: { kind: 'same_idempotency_key' },
        },
      };
      const replies: unknown[] = [
        LOST,
        BUSY,
        BUSY,
        { ok: true, value: { plan: PLAN } },
      ];
      const lands = jest.fn<Promise<unknown>, [unknown]>(() =>
        Promise.resolve(replies.shift()),
      );
      stubWindow('local', lands);
      await expect(
        updateTrackedPlan({ ...SCOPE, planId: 'plan-1', hidden: true }),
      ).resolves.toEqual(PLAN);
      expect(lands).toHaveBeenCalledTimes(4);
      expect(
        new Set(lands.mock.calls.map(([request]) => keyOf(request))).size,
      ).toBe(1);

      let sends = 0;
      const staysBusy = jest.fn<Promise<unknown>, [unknown]>(() => {
        sends += 1;
        return Promise.resolve(sends === 1 ? LOST : BUSY);
      });
      stubWindow('local', staysBusy);
      await expect(
        updateTrackedPlan({ ...SCOPE, planId: 'plan-1', hidden: true }),
      ).rejects.toThrow('Too many concurrent relay calls.');
      // The first send, the one replay, and its three re-sends.
      expect(staysBusy).toHaveBeenCalledTimes(5);
    });

    it('never re-sends a write that was dispatched and failed, or refused for another reason', async () => {
      for (const error of [
        {
          kind: 'internal',
          message: 'The write failed.',
          retry: { kind: 'never' },
        },
        {
          kind: 'resource_exhausted',
          message: 'The value exceeds the relay frame cap.',
          retry: { kind: 'after_refresh', resource: 'relay.frame' },
        },
      ]) {
        const invoke = jest.fn(() => Promise.resolve({ ok: false, error }));
        stubWindow('local', invoke);
        await expect(
          updateTrackedPlan({ ...SCOPE, planId: 'plan-1', hidden: true }),
        ).rejects.toThrow(error.message);
        expect(invoke).toHaveBeenCalledTimes(1);
      }
    });
  });

  it('answers an update of a missing plan as null, and rejects a written record that is not a tracked plan', async () => {
    const answers = [{ plan: null }, { plan: UNTRACKED }];
    stubWindow(
      'local',
      relayAnswering(() => answers.shift()),
    );
    await expect(
      updateTrackedPlan({ ...SCOPE, planId: 'gone', hidden: true }),
    ).resolves.toBeNull();
    await expect(
      createTrackedPlan({ ...SCOPE, source: 'claude', content: '# Plan' }),
    ).rejects.toThrow('The stored plan could not be read.');
  });

  it("refuses an import path plan-import refuses with its own message, before the relay, and doesn't normalise one", async () => {
    const invoke = jest.fn();
    stubWindow('local', invoke);
    const refused = (filePath: string, repoId?: string): Promise<unknown> =>
      importTrackedPlan({
        ...SCOPE,
        filePath,
        ...(repoId === undefined ? {} : { repoId }),
      });

    await expect(refused('plan.md')).rejects.toThrow(
      'Plan import requires repoId; use WORKSPACE_ROOT_REPO_ID for the worktree root.',
    );
    await expect(refused('/abs/plan.md', 'repo')).rejects.toThrow(
      'Plan import paths must be relative to the worktree.',
    );
    await expect(refused('docs\\plan.md', 'repo')).rejects.toThrow(
      "Plan import paths can't contain a backslash.",
    );
    await expect(refused('../plan.md', 'repo')).rejects.toThrow(
      'Plan import path must stay inside the worktree.',
    );
    await expect(refused('./plan.md', 'repo')).rejects.toThrow(
      'Plan import paths must be plain relative paths inside the worktree.',
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps the channels in a remote window, and for an import the person browses for', async () => {
    const remote = jest.fn();
    const channels = stubWindow('remote', remote);
    await createTrackedPlan({ ...SCOPE, source: 'claude', content: '# Plan' });
    await updateTrackedPlan({ ...SCOPE, planId: 'plan-1', hidden: true });
    await deleteTrackedPlan({ ...SCOPE, planId: 'plan-1' });
    await expect(
      importTrackedPlan({ ...SCOPE, filePath: 'plan.md', repoId: 'repo' }),
    ).resolves.toEqual(PLAN);
    expect(channels.create).toHaveBeenCalledWith({
      ...SCOPE,
      source: 'claude',
      content: '# Plan',
    });
    expect(channels.update).toHaveBeenCalledWith({
      ...SCOPE,
      planId: 'plan-1',
      hidden: true,
    });
    expect(channels.delete).toHaveBeenCalledWith({
      ...SCOPE,
      planId: 'plan-1',
    });
    expect(channels.import).toHaveBeenCalledWith({
      ...SCOPE,
      filePath: 'plan.md',
      repoId: 'repo',
    });
    expect(remote).not.toHaveBeenCalled();

    const local = jest.fn();
    const browse = stubWindow('local', local);
    await expect(importTrackedPlan({ ...SCOPE })).resolves.toEqual(PLAN);
    expect(browse.import).toHaveBeenCalledWith({ ...SCOPE });
    expect(local).not.toHaveBeenCalled();
  });
});

describe('desktop detected-plan writes (CAN-4165 PR 7c)', () => {
  const keyOf = (request: unknown): unknown =>
    (request as { params: { _meta: { idempotencyKey: string } } }).params._meta
      .idempotencyKey;
  const DISMISSED = { ...DETECTED, status: 'dismissed' };
  const SIZE_REFUSAL = {
    ok: false,
    error: {
      kind: 'resource_exhausted',
      message: 'The relay reply exceeded the cap.',
      retry: { kind: 'same_idempotency_key' },
    },
  };

  it("writes the main window's detected plans through core.plan.detected on the relay, each action under its own key", async () => {
    const invoke = relayAnswering((method) =>
      method === 'core.plan.detected.scan'
        ? { detected: [DETECTED], newlyDetected: [DETECTED] }
        : { detected: [DISMISSED] },
    );
    const channels = stubWindow('local', invoke);

    await expect(
      scanDetectedPlans({
        ...SCOPE,
        chatId: 'chat-1',
        // The channel drops a path no rule can match rather than refusing the scan.
        candidatePaths: ['plan.md', '', 'x'.repeat(4_097)],
      }),
    ).resolves.toEqual({ entries: [DETECTED], newlyDetected: [DETECTED] });
    await expect(
      updateDetectedPlan({ ...SCOPE, entryId: 'det-1', status: 'dismissed' }),
    ).resolves.toEqual([DISMISSED]);

    const requests = invoke.mock.calls.map(([request]) => request);
    const anyKey: unknown = expect.any(String);
    // Strict, so an undefined-valued key fails it.
    expect(requests).toStrictEqual([
      {
        kind: 'request',
        method: 'core.plan.detected.scan',
        params: {
          scope: SCOPE,
          chatId: 'chat-1',
          candidatePaths: ['plan.md'],
          _meta: { idempotencyKey: anyKey },
        },
      },
      {
        kind: 'request',
        method: 'core.plan.detected.update',
        // No undefined bannerSeen or importedPlanId: the relay can't carry one.
        params: {
          scope: SCOPE,
          entryId: 'det-1',
          status: 'dismissed',
          _meta: { idempotencyKey: anyKey },
        },
      },
    ]);
    expect(new Set(requests.map(keyOf)).size).toBe(2);
    untouched(channels);
  });

  it('re-sends a detected write whose reply was lost once, under the same key', async () => {
    const replies: unknown[] = [
      {
        ok: false,
        error: {
          kind: 'unavailable',
          message: 'The relay is unavailable.',
          retry: { kind: 'same_idempotency_key' },
        },
      },
      { ok: true, value: { detected: [DETECTED], newlyDetected: [] } },
    ];
    const invoke = jest.fn<Promise<unknown>, [unknown]>(() =>
      Promise.resolve(replies.shift()),
    );
    stubWindow('local', invoke);
    await expect(
      scanDetectedPlans({
        ...SCOPE,
        chatId: 'chat-1',
        candidatePaths: ['plan.md'],
      }),
    ).resolves.toEqual({ entries: [DETECTED], newlyDetected: [] });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(keyOf(invoke.mock.calls[1]?.[0])).toBe(
      keyOf(invoke.mock.calls[0]?.[0]),
    );
  });

  it('rejects a refusal with its own message, once, and never re-writes over the channel', async () => {
    const readOnly = jest.fn(() =>
      Promise.resolve({
        ok: false,
        error: {
          kind: 'permission_denied',
          code: 'core.plan.readOnlyScope',
          message: 'Shared-container recipient workspaces are read-only',
          retry: { kind: 'never' },
        },
      }),
    );
    const channels = stubWindow('local', readOnly);
    await expect(
      updateDetectedPlan({ ...SCOPE, entryId: 'det-1', bannerSeen: true }),
    ).rejects.toThrow('Shared-container recipient workspaces are read-only');
    expect(readOnly).toHaveBeenCalledTimes(1);
    untouched(channels);
  });

  it('re-sends a detected update the relay turns away busy for about 7.6 s, then fails (known limit)', async () => {
    // A dismissal waits in this window for admission, so a reload while it
    // waits drops it.
    const busy = jest.fn(() =>
      Promise.resolve({
        ok: false,
        error: {
          kind: 'resource_exhausted',
          message: 'Too many concurrent relay calls.',
          retry: { kind: 'after_refresh', resource: 'relay' },
        },
      }),
    );
    stubWindow('local', busy);
    jest.useFakeTimers();
    try {
      const failed = expect(
        updateDetectedPlan({ ...SCOPE, entryId: 'det-1', bannerSeen: true }),
      ).rejects.toThrow('Too many concurrent relay calls.');
      await jest.advanceTimersByTimeAsync(7_600);
      await failed;
    } finally {
      jest.useRealTimers();
    }
    expect(busy).toHaveBeenCalledTimes(7);
  });

  it('reads the list back, without re-sending the write, when the relay refuses its reply for size', async () => {
    // The committed list is as large, so its relay read is refused for size
    // too and falls back to the channel.
    const invoke = jest.fn<Promise<unknown>, [{ method: string }]>((request) =>
      Promise.resolve(
        request.method === 'core.plan.detected.list'
          ? {
              ok: false,
              error: {
                kind: 'resource_exhausted',
                message: 'The relay reply exceeded the cap.',
                retry: { kind: 'after_refresh', resource: 'reply' },
              },
            }
          : SIZE_REFUSAL,
      ),
    );
    const channels = stubWindow('local', invoke);
    channels.detectedList.mockResolvedValue([DISMISSED]);

    await expect(
      updateDetectedPlan({ ...SCOPE, entryId: 'det-1', status: 'dismissed' }),
    ).resolves.toEqual([DISMISSED]);
    // Its additions are in the list; no caller reads newlyDetected.
    await expect(
      scanDetectedPlans({
        ...SCOPE,
        chatId: 'chat-1',
        candidatePaths: ['plan.md'],
      }),
    ).resolves.toEqual({ entries: [DISMISSED], newlyDetected: [] });
    expect(invoke.mock.calls.map(([request]) => request.method)).toEqual([
      'core.plan.detected.update',
      'core.plan.detected.list',
      'core.plan.detected.scan',
      'core.plan.detected.list',
    ]);
    expect(channels.detectedScan).not.toHaveBeenCalled();
    expect(channels.detectedUpdate).not.toHaveBeenCalled();
  });

  it("reads a size-refused write's list back over the channel when the relay read fails", async () => {
    const invoke = jest.fn<Promise<unknown>, [{ method: string }]>((request) =>
      request.method === 'core.plan.detected.list'
        ? Promise.reject(new Error('relay gone'))
        : Promise.resolve(SIZE_REFUSAL),
    );
    const channels = stubWindow('local', invoke);
    channels.detectedList.mockResolvedValue([DISMISSED]);
    await expect(
      updateDetectedPlan({ ...SCOPE, entryId: 'det-1', status: 'dismissed' }),
    ).resolves.toEqual([DISMISSED]);
    await expect(
      scanDetectedPlans({
        ...SCOPE,
        chatId: 'chat-1',
        candidatePaths: ['plan.md'],
      }),
    ).resolves.toEqual({ entries: [DISMISSED], newlyDetected: [] });
    expect(channels.detectedUpdate).not.toHaveBeenCalled();
    expect(channels.detectedScan).not.toHaveBeenCalled();
  });

  it('scans over the channel when the relay refuses the request for its size, before dispatch, but never updates there', async () => {
    // A schema-valid scan of 1,551 long paths, about 1.14 MB encoded, over
    // the relay's 1 MiB request cap: refused before anything ran.
    const REQUEST_REFUSAL = {
      ok: false,
      error: {
        kind: 'resource_exhausted',
        message: 'The relay request exceeded the cap.',
        retry: { kind: 'after_refresh', resource: 'request' },
      },
    };
    const invoke = jest.fn(() => Promise.resolve(REQUEST_REFUSAL));
    const channels = stubWindow('local', invoke);
    const candidatePaths = Array.from(
      { length: 1_551 },
      (_, index) => `docs/${'p'.repeat(720)}-${index}.md`,
    );
    expect(
      new TextEncoder().encode(JSON.stringify(candidatePaths)).length,
    ).toBeGreaterThan(1024 * 1024);
    const scan = { ...SCOPE, chatId: 'chat-1', candidatePaths };
    await expect(scanDetectedPlans(scan)).resolves.toEqual({
      entries: [DETECTED],
      newlyDetected: [DETECTED],
    });
    expect(channels.detectedScan).toHaveBeenCalledWith(scan);
    expect(invoke).toHaveBeenCalledTimes(1);

    await expect(
      updateDetectedPlan({ ...SCOPE, entryId: 'det-1', bannerSeen: true }),
    ).rejects.toThrow('The relay request exceeded the cap.');
    expect(channels.detectedUpdate).not.toHaveBeenCalled();
  });

  it('answers a cowork scan with nothing, before the relay, as the channel did', async () => {
    const invoke = jest.fn();
    const channels = stubWindow('local', invoke);
    await expect(
      scanDetectedPlans({
        projectId: 'standalone-chat',
        worktreeId: 'wt',
        chatId: 'chat-1',
        candidatePaths: ['plan.md'],
      }),
    ).resolves.toEqual({ entries: [], newlyDetected: [] });
    expect(invoke).not.toHaveBeenCalled();
    untouched(channels);
  });

  it('keeps the channels in a remote window', async () => {
    const remote = jest.fn();
    const channels = stubWindow('remote', remote);
    const scan = { ...SCOPE, chatId: 'chat-1', candidatePaths: ['plan.md'] };
    await scanDetectedPlans(scan);
    await updateDetectedPlan({ ...SCOPE, entryId: 'det-1', bannerSeen: true });
    expect(channels.detectedScan).toHaveBeenCalledWith(scan);
    expect(channels.detectedUpdate).toHaveBeenCalledWith({
      ...SCOPE,
      entryId: 'det-1',
      bannerSeen: true,
    });
    expect(remote).not.toHaveBeenCalled();
  });
});

describe("the activity store's detected-plan writes (CAN-4165 PR 7c)", () => {
  const scope = { projectId: 'proj', worktreeId: 'detected-store' };
  const cached = (): unknown =>
    useActivityStore.getState().detectedPlans['proj/detected-store'];
  const OWN = [{ ...DETECTED, status: 'dismissed' as const }];
  const OTHER = [
    { ...DETECTED, status: 'dismissed' as const, bannerSeen: true },
  ];

  const update = (): Promise<void> =>
    useActivityStore
      .getState()
      .updateDetectedPlan(scope.projectId, scope.worktreeId, 'det-1', {
        status: 'dismissed',
      });
  /** A window whose relay runs `during` while each call is in flight. */
  const relay = (
    answers: Record<string, unknown>,
    during: (method: string) => void = () => undefined,
  ): jest.Mock<Promise<unknown>, [{ method: string }]> => {
    const invoke = jest.fn((request: { method: string }) => {
      during(request.method);
      return Promise.resolve({ ok: true, value: answers[request.method] });
    });
    stubWindow('local', invoke);
    return invoke;
  };
  const push = (entries: DetectedPlanEntry[]): void =>
    useActivityStore
      .getState()
      .setDetectedPlans(scope.projectId, scope.worktreeId, entries);

  it("applies pushes only: a write's own answer never replaces the list", async () => {
    // Every writer's push arrives in commit order (the plan lifecycle golden
    // pins it), so the last push carries the saved list; an answer may be
    // older than a push that landed before it.
    push([]);
    relay({ 'core.plan.detected.update': { detected: OWN } }, () =>
      push(OTHER),
    );
    await update();
    expect(cached()).toEqual(OTHER);
    push(OWN);
    expect(cached()).toEqual(OWN);
  });

  it('answers what a scan added and leaves the list to its push', async () => {
    // An empty push stores [] under the worktree, so no answer refills it.
    push([]);
    expect(
      'proj/detected-store' in useActivityStore.getState().detectedPlans,
    ).toBe(true);
    relay({
      'core.plan.detected.scan': {
        detected: [DETECTED],
        newlyDetected: [DETECTED],
      },
    });
    await expect(
      useActivityStore
        .getState()
        .scanDetectedPlans(scope.projectId, scope.worktreeId, 'chat-1', [
          'plan.md',
        ]),
    ).resolves.toEqual([DETECTED]);
    expect(cached()).toEqual([]);
  });

  it("fills a worktree's list from a scan's answer while it has none, as a restored chat's scan does, then takes pushes only", async () => {
    // A restored chat's scan stores nothing new, so no push comes; its answer
    // is the only list the banner gets until the Activity panel loads one.
    const unseen = { projectId: 'proj', worktreeId: 'detected-unseen' };
    const listed = (): unknown =>
      useActivityStore.getState().detectedPlans['proj/detected-unseen'];
    relay({
      'core.plan.detected.scan': { detected: [DETECTED], newlyDetected: [] },
      'core.plan.detected.update': { detected: OWN },
    });
    await useActivityStore
      .getState()
      .scanDetectedPlans(unseen.projectId, unseen.worktreeId, 'chat-1', [
        'plan.md',
      ]);
    expect(listed()).toEqual([DETECTED]);
    await useActivityStore
      .getState()
      .updateDetectedPlan(unseen.projectId, unseen.worktreeId, 'det-1', {
        status: 'dismissed',
      });
    expect(listed()).toEqual([DETECTED]);
  });

  it("never refills a worktree's list that cleanupWorktree dropped while a write was in flight", async () => {
    push(OTHER);
    relay({ 'core.plan.detected.update': { detected: OWN } }, () =>
      useActivityStore
        .getState()
        .cleanupWorktree(scope.projectId, scope.worktreeId),
    );
    await update();
    expect(
      'proj/detected-store' in useActivityStore.getState().detectedPlans,
    ).toBe(false);
  });

  it("leaves the list stale until the next load when a write's publish failed (known limit)", async () => {
    // The publisher logs a send it could not make, and no push arrives.
    const STALE = [{ ...DETECTED, status: 'detected' as const }];
    push(STALE);
    relay({
      'core.plan.detected.update': { detected: OWN },
      'core.plan.detected.list': { detected: OWN },
    });
    await update();
    expect(cached()).toEqual(STALE);
    await useActivityStore
      .getState()
      .loadDetectedPlans(scope.projectId, scope.worktreeId);
    expect(cached()).toEqual(OWN);
  });

  it('sends a 40-plan dismissal at click time and re-sends the ones the relay turns away busy until admitted', async () => {
    // The relay admits 32 calls at once; the banner dismisses every pending
    // plan together.
    const BUSY = {
      ok: false,
      error: {
        kind: 'resource_exhausted',
        message: 'Too many concurrent relay calls.',
        retry: { kind: 'after_refresh', resource: 'relay' },
      },
    };
    let inFlight = 0;
    const admitted: string[] = [];
    const invoke = jest.fn(
      (request: { method: string; params?: { entryId?: string } }) => {
        if (inFlight >= 32) return Promise.resolve(BUSY);
        inFlight += 1;
        admitted.push(request.params?.entryId ?? '');
        return new Promise((resolve) =>
          setTimeout(() => {
            inFlight -= 1;
            resolve({ ok: true, value: { detected: OWN } });
          }, 0),
        );
      },
    );
    stubWindow('local', invoke);
    const ids = Array.from({ length: 40 }, (_, index) => `det-${index}`);
    const dismissals = ids.map((id) =>
      useActivityStore
        .getState()
        .updateDetectedPlan(scope.projectId, scope.worktreeId, id, {
          bannerSeen: true,
        }),
    );
    // Every dismissal reaches the relay before any answer, as the channel's did.
    expect(invoke).toHaveBeenCalledTimes(40);
    await Promise.all(dismissals);
    expect([...admitted].sort()).toEqual([...ids].sort());
  });
});

describe('the detected-plans push subscription (CAN-4165 PR 7c)', () => {
  it('feeds pushes to the store with no Activity panel mounted, and stops when unsubscribed', () => {
    stubWindow('local', jest.fn());
    let listener: ((event: DetectedPlansUpdatedEvent) => void) | undefined;
    const unsubscribe = jest.fn((): void => {
      listener = undefined;
    });
    Object.assign(window.api.activity, {
      onDetectedPlansUpdated: (
        callback: (event: DetectedPlansUpdatedEvent) => void,
      ): (() => void) => {
        listener = callback;
        return unsubscribe;
      },
    });
    const entries = [{ ...DETECTED, status: 'detected' as const }];
    const stop = subscribeDetectedPlans();
    listener?.({ projectId: 'proj', worktreeId: 'pushed', entries });
    expect(useActivityStore.getState().detectedPlans['proj/pushed']).toEqual(
      entries,
    );
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(listener).toBeUndefined();
  });
});

describe("the activity store's plan upserts (CAN-4165 PR 7b)", () => {
  it('never lets an older answer replace a newer cached plan, and takes one as new as the cache', () => {
    const store = useActivityStore.getState();
    const scope = { projectId: 'proj', worktreeId: 'upserts' };
    const at = (second: number): string => `2026-11-23T00:00:0${second}.000Z`;
    const plan = (content: string, second: number): TrackedPlanData => ({
      ...PLAN,
      ...scope,
      content,
      updatedAt: at(second),
    });
    const cached = (): unknown =>
      useActivityStore.getState().trackedPlans['proj/upserts']?.[0];

    store.upsertTrackedPlan(plan('# Newer', 2));
    // A same-key replay of an earlier create, after a newer update landed.
    store.upsertTrackedPlan(plan('# Older', 1));
    expect(cached()).toEqual(plan('# Newer', 2));
    store.upsertTrackedPlan(plan('# Same time', 2));
    expect(cached()).toEqual(plan('# Same time', 2));
  });

  it("keeps a share-sync push's share over a write answer as old as it, and still takes an equal-time push whole", () => {
    const scope = { projectId: 'proj', worktreeId: 'share-sync' };
    const share = (
      syncStatus: 'syncing' | 'synced',
    ): TrackedPlanData['share'] => ({
      serverId: 'server-1',
      remoteId: 'remote-1',
      shareScope: 'private',
      syncStatus,
    });
    const approved = {
      ...PLAN,
      ...scope,
      reviewStatus: 'approved' as const,
      updatedAt: '2026-11-23T00:00:05.000Z',
    };
    const cached = (): unknown =>
      useActivityStore.getState().trackedPlans['proj/share-sync']?.[0];

    // Share sync finished after the approval and kept its updatedAt.
    useActivityStore
      .getState()
      .upsertTrackedPlan({ ...approved, share: share('synced') });
    // The approval's own answer, replayed or late, still carries the older share.
    useActivityStore
      .getState()
      .commitTrackedPlanUpdate({ ...approved, share: share('syncing') });
    expect(cached()).toEqual({ ...approved, share: share('synced') });

    useActivityStore
      .getState()
      .upsertTrackedPlan({ ...approved, share: share('syncing') });
    expect(cached()).toEqual({ ...approved, share: share('syncing') });
  });

  it("keeps a diagram push's diagrams over a write answer as old as it", () => {
    const scope = { projectId: 'proj', worktreeId: 'diagrams' };
    const sequence = (
      status: 'generating' | 'ready',
    ): NonNullable<TrackedPlanData['diagrams']> => ({
      sequence: { data: null, derivedFromRevision: 1, status },
    });
    const approved = {
      ...PLAN,
      ...scope,
      reviewStatus: 'approved' as const,
      updatedAt: '2026-11-23T00:00:05.000Z',
    };
    // A diagram save after the approval keeps its updatedAt.
    useActivityStore
      .getState()
      .upsertTrackedPlan({ ...approved, diagrams: sequence('ready') });
    useActivityStore.getState().commitTrackedPlanUpdate({
      ...approved,
      diagrams: sequence('generating'),
    });
    expect(
      useActivityStore.getState().trackedPlans['proj/diagrams']?.[0],
    ).toEqual({ ...approved, diagrams: sequence('ready') });
  });
});

describe("the activity store's hide toggle (CAN-4165 PR 7b)", () => {
  const AT = (second: number): string => `2026-11-23T00:00:0${second}.000Z`;
  const cached = (): unknown =>
    useActivityStore
      .getState()
      .trackedPlans['proj/wt']?.find((plan) => plan.id === PLAN.id);

  it("applies only an equal-time hide answer's hidden field, so a share-sync update landed meanwhile stays", async () => {
    const share = (
      syncStatus: 'syncing' | 'synced',
    ): TrackedPlanData['share'] => ({
      serverId: 'server-1',
      remoteId: 'remote-1',
      shareScope: 'private',
      syncStatus,
    });
    // A share-sync write keeps updatedAt, so the hide answer carries the same time.
    const synced = {
      ...PLAN,
      id: 'shared-plan',
      share: share('synced'),
      updatedAt: AT(5),
    };
    stubWindow(
      'local',
      relayAnswering(() => ({
        plan: { ...synced, share: share('syncing'), hidden: true },
      })),
    );
    useActivityStore.getState().upsertTrackedPlan(synced);

    await useActivityStore.getState().togglePlanHidden(synced);
    expect(
      useActivityStore
        .getState()
        .trackedPlans['proj/wt']?.find((plan) => plan.id === 'shared-plan'),
    ).toEqual({ ...synced, hidden: true });
  });

  it('keeps a newer cached plan over an older replayed answer, and takes an answer as new as the cache', async () => {
    const newer = { ...PLAN, hidden: false, updatedAt: AT(2) };
    const answers = [
      // A same-key replay of an earlier hide, after a newer unhide landed.
      { plan: { ...PLAN, hidden: true, updatedAt: AT(1) } },
      { plan: { ...PLAN, hidden: true, updatedAt: AT(2) } },
    ];
    stubWindow(
      'local',
      relayAnswering(() => answers.shift()),
    );
    useActivityStore.getState().upsertTrackedPlan(newer);

    await useActivityStore.getState().togglePlanHidden(newer);
    expect(cached()).toEqual(newer);
    await useActivityStore.getState().togglePlanHidden(newer);
    expect(cached()).toEqual({ ...newer, hidden: true });
  });
});
