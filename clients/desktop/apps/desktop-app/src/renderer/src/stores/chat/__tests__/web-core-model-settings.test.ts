/** @jest-environment jsdom */
/**
 * CAN-6175 R5: a cloud chat's model is a web core model definition the
 * desktop model registry does not know, so its thinking levels come from its
 * web core catalog. The chat store cycles the level through the levels the
 * catalog lists, and through none before the catalog is read; the web core
 * refuses a send with a level outside them, so the store must never choose
 * one. A catalog read from a connection that went offline never replaces a
 * newer one.
 */
import type { CoreCoworkInvoker } from '@canopy/app-state/core-cowork';
import type { CatalogEntry } from '@canopy/protocol/canopy-core';
import type { ThinkingLevel } from '@canopy/protocol/thinking';
import { useChatStore } from '@/stores/chatStore';
import { createEmptyTab } from '../tab-utils';
import { useWebCoreFastModeStore } from '../web-core/fast-mode';
import { closeWebCoreChatBackend } from '../web-core';
import {
  clearWebCoreModelCatalog,
  loadWebCoreModelCatalog,
  useWebCoreModelCatalogStore,
  webCoreModelLabel,
} from '../web-core/model-catalog';

const PROJECT = 'web-core:ws-1';
const WORKTREE = 'web-core:task-1';
const CHAT = 'web-core:chat-1';
const TARGET = { projectId: PROJECT, worktreeId: WORKTREE, chatId: CHAT };
const LEVELS: ThinkingLevel[] = ['low', 'medium', 'high'];

/** Local preload stubs: every call resolves, every subscription is inert. */
function inertApi(): unknown {
  const call = (): Promise<undefined> => Promise.resolve(undefined);
  const handler: ProxyHandler<typeof call> = {
    get: (_target, property) => {
      if (property === 'then') return undefined;
      if (typeof property === 'string' && property.startsWith('on'))
        return () => (): void => undefined;
      return new Proxy(call, handler);
    },
    apply: call,
  };
  return new Proxy(call, handler);
}

const relayRequests: string[] = [];
/** What each `core.chat.update` asked the web core to do. */
const updates: unknown[] = [];
/** Set to make the web core refuse a model change. */
let refuseUpdates = false;
/** Replies for the next model changes, in order, each held until released. */
const scriptedUpdates: { refused: boolean; held: Promise<void> }[] = [];

function seed(thinkingLevel: ThinkingLevel, model = 'cloud-model'): void {
  useChatStore.setState({
    worktreeChats: {
      [`${PROJECT}/${WORKTREE}`]: {
        tabs: [
          {
            ...createEmptyTab(),
            id: CHAT,
            model,
            providerType: 'claude',
            thinkingLevel,
          },
        ],
        activeTabId: CHAT,
      },
    },
  } as never);
}

const shownLevel = (): ThinkingLevel | undefined =>
  useChatStore
    .getState()
    .worktreeChats[
      `${PROJECT}/${WORKTREE}`
    ]?.tabs.find((tab) => tab.id === CHAT)?.thinkingLevel;

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(() => {
  Object.assign(window, {
    api: inertApi(),
    canopyCore: {
      invoke: (request: {
        method: string;
        params: Record<string, unknown>;
      }): Promise<unknown> => {
        relayRequests.push(request.method);
        if (request.method !== 'core.chat.update')
          return Promise.resolve({ ok: true, value: {} });
        updates.push(request.params.action);
        const scripted = scriptedUpdates.shift();
        const refused = scripted?.refused ?? refuseUpdates;
        return (scripted?.held ?? Promise.resolve()).then(() => ({
          ok: true,
          value: {
            commandId: request.params.commandId,
            revision: 1,
            outcome: refused ? 'rejected' : 'applied',
          },
        }));
      },
    },
  });
});

beforeEach(() => {
  relayRequests.length = 0;
  updates.length = 0;
  refuseUpdates = false;
  scriptedUpdates.length = 0;
  useWebCoreModelCatalogStore.setState({ byProject: {} });
  // These cases seed the store directly, so the web core backend has read
  // no tab: each starts it afresh, as a reconnect does.
  closeWebCoreChatBackend();
});

const AT = '2026-11-11T00:00:00.000Z';

function modelEntry(id: string): CatalogEntry {
  return {
    entryId: `model:${id}`,
    kind: 'model',
    name: id,
    description: '',
    source: 'remote',
    content: {
      kind: 'model',
      providerId: 'claude',
      modelName: id,
      contextWindow: 200_000,
      capabilities: [],
    },
    availability: 'available',
    revision: 0,
    createdAt: AT,
    updatedAt: AT,
  };
}

/** An invoker whose one catalog read answers when the test says so. */
function heldCatalog(id: string): {
  invoker: CoreCoworkInvoker;
  answer: () => void;
} {
  let answer = (): void => undefined;
  const reply = new Promise<void>((resolve) => {
    answer = resolve;
  });
  return {
    answer,
    invoker: {
      request: () =>
        reply.then(() => ({
          ok: true,
          value: { revision: 1, entries: [modelEntry(id)], generatedAt: AT },
        })),
      openStream: () => Promise.reject(new Error('unused')),
    },
  };
}

const cloudModel = {
  id: 'cloud-model',
  label: 'Cloud model',
  provider: 'codex',
  kind: 'model',
  available: true,
} as const;

const shownModel = (): string | undefined =>
  useChatStore
    .getState()
    .worktreeChats[
      `${PROJECT}/${WORKTREE}`
    ]?.tabs.find((tab) => tab.id === CHAT)?.model;

describe('the model of a web core chat (CAN-6175 R5)', () => {
  it('names the model at once: its id before the catalog is read, its label after', () => {
    const state = useWebCoreModelCatalogStore.getState();
    expect(webCoreModelLabel(state, PROJECT, 'cloud-model')).toBe(
      'cloud-model',
    );
    useWebCoreModelCatalogStore.setState({
      byProject: { [PROJECT]: new Map([['cloud-model', cloudModel]]) },
    });
    expect(
      webCoreModelLabel(
        useWebCoreModelCatalogStore.getState(),
        PROJECT,
        'cloud-model',
      ),
    ).toBe('Cloud model');
  });

  it('sets a catalog model through the web core, and refuses one the catalog does not list', async () => {
    useWebCoreModelCatalogStore.setState({
      byProject: { [PROJECT]: new Map([['cloud-model', cloudModel]]) },
    });
    seed('medium', 'other-model');
    await expect(
      useChatStore.getState().setModelAndWait('cloud-model', TARGET),
    ).resolves.toBe(true);
    expect(updates).toEqual([
      {
        type: 'chat.set_model',
        tabId: 'chat-1',
        model: 'cloud-model',
        providerType: 'codex',
      },
    ]);
    expect(shownModel()).toBe('cloud-model');

    // An id the catalog does not list never reaches the web core.
    await expect(
      useChatStore.getState().setModelAndWait('desktop-only-model', TARGET),
    ).resolves.toBe(false);
    expect(updates).toHaveLength(1);
    expect(shownModel()).toBe('cloud-model');
  });

  const threeModels = (): void =>
    useWebCoreModelCatalogStore.setState({
      byProject: {
        [PROJECT]: new Map([
          ['cloud-model', cloudModel],
          ['second-model', { ...cloudModel, id: 'second-model' }],
          ['third-model', { ...cloudModel, id: 'third-model' }],
        ]),
      },
    });

  const held = (refused: boolean): (() => void) => {
    let release = (): void => undefined;
    scriptedUpdates.push({
      refused,
      held: new Promise((resolve) => {
        release = resolve;
      }),
    });
    return () => release();
  };

  it('sends overlapping picks one at a time and skips a pick replaced before it was sent', async () => {
    threeModels();
    seed('medium', 'other-model');
    const releaseFirst = held(false);
    const first = useChatStore
      .getState()
      .setModelAndWait('cloud-model', TARGET);
    await settle();
    const second = useChatStore
      .getState()
      .setModelAndWait('second-model', TARGET);
    const third = useChatStore
      .getState()
      .setModelAndWait('third-model', TARGET);
    await settle();
    // Nothing else is sent while the first change is in flight.
    expect(updates).toHaveLength(1);
    releaseFirst();
    await Promise.all([first, second, third]);
    // The second pick was replaced before it was sent: only the newest follows.
    expect(
      updates.map((update) =>
        typeof update === 'object' && update !== null && 'model' in update
          ? update.model
          : undefined,
      ),
    ).toEqual(['cloud-model', 'third-model']);
    expect(shownModel()).toBe('third-model');
  });

  it('rolls a refused newest pick back to the model the web core last confirmed', async () => {
    threeModels();
    seed('medium', 'other-model');
    const releaseFirst = held(false);
    scriptedUpdates.push({ refused: true, held: Promise.resolve() });
    const first = useChatStore
      .getState()
      .setModelAndWait('second-model', TARGET);
    await settle();
    const second = useChatStore
      .getState()
      .setModelAndWait('third-model', TARGET);
    releaseFirst();
    await Promise.all([first, second]);
    // The first pick was accepted, the newest refused: the tab shows what the
    // web core now runs, not the model it started on.
    expect(updates).toHaveLength(2);
    expect(shownModel()).toBe('second-model');
    // A later refused pick rolls back to it too: nothing stale is left behind.
    refuseUpdates = true;
    await expect(
      useChatStore.getState().setModelAndWait('cloud-model', TARGET),
    ).resolves.toBe(false);
    expect(shownModel()).toBe('second-model');
  });

  it('settles a refused pick when a later request for the tab named a model the catalog does not list (CAN-6345)', async () => {
    threeModels();
    seed('medium', 'other-model');
    const refuse = held(true);
    const refused = useChatStore
      .getState()
      .setModelAndWait('second-model', TARGET);
    await settle();
    // Returns before picking: nothing reaches the web core for it.
    await expect(
      useChatStore.getState().setModelAndWait('desktop-only-model', TARGET),
    ).resolves.toBe(false);
    refuse();
    await expect(refused).resolves.toBe(false);
    expect(updates).toHaveLength(1);
    expect(shownModel()).toBe('other-model');
  });

  it('puts the model back when the web core refuses the change', async () => {
    useWebCoreModelCatalogStore.setState({
      byProject: { [PROJECT]: new Map([['cloud-model', cloudModel]]) },
    });
    seed('medium', 'other-model');
    refuseUpdates = true;
    await expect(
      useChatStore.getState().setModelAndWait('cloud-model', TARGET),
    ).resolves.toBe(false);
    expect(updates).toHaveLength(1);
    expect(shownModel()).toBe('other-model');
  });
});

describe('the web core model catalog (CAN-6175 R5)', () => {
  it('keeps the newer catalog when a read from an offline connection answers late', async () => {
    const old = heldCatalog('old-model');
    const stale = loadWebCoreModelCatalog(PROJECT, () => old.invoker);
    clearWebCoreModelCatalog();
    const fresh = heldCatalog('new-model');
    const current = loadWebCoreModelCatalog(PROJECT, () => fresh.invoker);
    fresh.answer();
    await current;
    old.answer();
    await stale;
    expect([
      ...(useWebCoreModelCatalogStore.getState().byProject[PROJECT]?.keys() ??
        []),
    ]).toEqual(['new-model']);
  });
});

describe('fast mode in a web core chat (CAN-6322)', () => {
  const catalogRunsFast = (fast: boolean): void =>
    useWebCoreModelCatalogStore.setState({
      byProject: {
        [PROJECT]: new Map([
          ['cloud-model', { ...cloudModel, supportsFastMode: fast }],
        ]),
      },
    });

  it("turns a cloud chat's fast mode on and off as the window's choice", async () => {
    catalogRunsFast(true);
    seed('medium');
    useChatStore.getState().toggleFastMode(TARGET);
    await settle();
    expect(useWebCoreFastModeStore.getState().byChat[CHAT]).toBe(true);
    useChatStore.getState().toggleFastMode(TARGET);
    await settle();
    expect(useWebCoreFastModeStore.getState().byChat[CHAT]).toBe(false);
    // It rides the next send: choosing it asks the web core nothing.
    expect(relayRequests).toEqual([]);
  });

  it("leaves fast mode alone for a model its catalog doesn't run fast", async () => {
    catalogRunsFast(false);
    seed('medium');
    useWebCoreFastModeStore.setState({ byChat: {} });
    useChatStore.getState().toggleFastMode(TARGET);
    await settle();
    expect(useWebCoreFastModeStore.getState().byChat[CHAT]).toBeUndefined();
  });
});

describe('thinking level in a web core chat (CAN-6175 R5)', () => {
  it("cycles through the model's catalog levels and never past them", async () => {
    useWebCoreModelCatalogStore.setState({
      byProject: {
        [PROJECT]: new Map([
          [
            'cloud-model',
            {
              id: 'cloud-model',
              label: 'Cloud model',
              provider: 'claude',
              kind: 'model',
              available: true,
              supportedThinkingLevels: [...LEVELS, 'ultra'],
            },
          ],
        ]),
      },
    });
    seed('medium');
    const seen = new Set<ThinkingLevel | undefined>();
    for (let step = 0; step < 6; step += 1) {
      useChatStore.getState().cycleThinkingLevel(TARGET);
      await settle();
      seen.add(shownLevel());
    }
    // Every level the catalog lists comes round; Ultra, which the web core
    // refuses, never does.
    expect([...seen].sort()).toEqual([...LEVELS].sort());
    // The level rides the next send: choosing it asks the web core nothing.
    expect(relayRequests).toEqual([]);
  });

  it('keeps the level while the catalog is unread', async () => {
    seed('high');
    useChatStore.getState().cycleThinkingLevel(TARGET);
    await settle();
    expect(shownLevel()).toBe('high');
  });
});
