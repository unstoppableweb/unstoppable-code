import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  PlanExitRequestEvent,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import type { ChatState } from '../state';
import { createPlanSlice } from '../slices/plan';
import { recoverUntrackedPlanProposals } from '../plan-proposal-recovery';

let mockStore: StoreApi<ChatState>;
const mockIsScopeRevisionedLive = jest.fn((): boolean => false);

const mockPreparePlanFileSystemInstruction = jest.fn();
const mockCommand = jest.fn();
const mockLoadTrackedPlans = jest.fn();

jest.mock('../backend', () => ({
  chatBackendFor: (): unknown => ({
    chat: {
      preparePlanFileSystemInstruction: mockPreparePlanFileSystemInstruction,
      command: mockCommand,
    },
  }),
  localChatBackend: {},
  reportUnlessUnavailable: jest.fn(),
}));
jest.mock('../../activityStore', () => ({
  useActivityStore: {
    getState: (): unknown => ({ loadTrackedPlans: mockLoadTrackedPlans }),
  },
}));
jest.mock('../surface', () => ({
  canReceiveWorktreeChatActivity: (): boolean => true,
}));
jest.mock('../slices/revisioned', () => ({
  isScopeRevisionedLive: (): boolean => mockIsScopeRevisionedLive(),
}));
jest.mock('../store-ref', () => ({
  chatStoreApi: (): StoreApi<ChatState> => mockStore,
}));
jest.mock('../hydration', () => ({
  recordWorktreeChatTouch: jest.fn(),
  scheduleIdleChatUnload: jest.fn(),
  pendingEagerChatCreation: new Map(),
}));
jest.mock('../notifications', () => ({
  fireChatActivityNotification: jest.fn(),
  getVisibleWorktreeKey: (): string | null => null,
  showUnreadChatToast: jest.fn(),
}));
jest.mock('@/lib/cowork', () => ({
  isCoworkChatTarget: (): boolean => false,
}));
jest.mock('../../githubStore', () => ({
  useGitHubStore: { getState: (): unknown => ({ addToast: jest.fn() }) },
}));
jest.mock('../claudeTerminalPrompt', () => ({
  restartClaudeTerminalForSettingsChange: jest.fn(),
}));
jest.mock('@/lib/plans/reconcile-tracked-plans', () => ({
  reconcileExecutedPlan: jest.fn(),
  reconcileTrackedPlans: jest.fn(),
}));
jest.mock('../context', () => ({
  getActiveWorktreeChatContext: jest.fn(),
  updateCapturedChatTab: jest.fn(),
}));
jest.mock('../code-review-registry', () => ({
  recordCodeReviewOrigin: jest.fn(),
  setCodeReviewChatVisibility: jest.fn(),
}));

const KEY = 'p/w';
const CHAT_ID = 'chat-a';
const PLAN_TEXT = '- step one\n- step two';
const INSTRUCTION = { id: 'plan-file', text: 'Plan file: .canopy/plan.md' };

let plansCreate: jest.Mock;
let plansUpdate: jest.Mock;

function trackedPlan(id: string, revision = 1): TrackedPlanData {
  return { id, latestRevisionNumber: revision } as unknown as TrackedPlanData;
}

function fixture(
  tab: Record<string, unknown> | null = {},
): StoreApi<ChatState> {
  mockStore = createStore<ChatState>()((set, get, api) => ({
    ...({
      worktreeChats: {
        [KEY]: {
          tabs: tab
            ? [{ id: CHAT_ID, title: 'Plan', messages: [], ...tab }]
            : [],
          activeTabId: CHAT_ID,
        },
      },
      selectedWorktree: null,
      unreadWorktreeKeys: new Set<string>(),
      chatStateNotices: {},
    } as unknown as ChatState),
    ...createPlanSlice(set, get, api),
  }));
  return mockStore;
}

function proposal(
  source: PlanExitRequestEvent['source'],
  requestId = 'req-1',
): PlanExitRequestEvent {
  return {
    requestId,
    projectId: 'p',
    worktreeId: 'w',
    chatId: CHAT_ID,
    source,
    reviewMode: 'proposal',
    toolInput: { plan: PLAN_TEXT },
  };
}

function tabOf(store: StoreApi<ChatState>): Record<string, unknown> {
  return store
    .getState()
    .worktreeChats[
      KEY
    ].tabs.find((tab) => tab.id === CHAT_ID) as unknown as Record<
    string,
    unknown
  >;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsScopeRevisionedLive.mockReturnValue(false);
  plansCreate = jest.fn().mockResolvedValue(trackedPlan('plan-new'));
  plansUpdate = jest.fn().mockResolvedValue(trackedPlan('plan-old', 2));
  mockPreparePlanFileSystemInstruction.mockResolvedValue({
    instruction: INSTRUCTION,
  });
  mockCommand.mockResolvedValue({ outcome: 'applied' });
  (globalThis as unknown as { window: unknown }).window = {
    api: { activity: { plans: { create: plansCreate, update: plansUpdate } } },
  };
});

it('creates a tracked plan for an antigravity proposal', async () => {
  const store = fixture();
  store.getState().handlePlanExitRequest(proposal('antigravity'));
  await settle();

  expect(plansCreate).toHaveBeenCalledTimes(1);
  expect(plansCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      source: 'antigravity',
      content: PLAN_TEXT,
      reviewStatus: 'pending',
    }),
  );
  expect(plansUpdate).not.toHaveBeenCalled();
  expect(tabOf(store)).toEqual(
    expect.objectContaining({
      trackedPlanId: 'plan-new',
      trackedPlanSource: 'antigravity',
      trackedPlanReviewStatus: 'pending',
      hasOutstandingProposal: true,
      pendingSystemInstructions: [INSTRUCTION],
    }),
  );
});

it('updates the existing pending antigravity plan on a second proposal', async () => {
  const store = fixture({
    trackedPlanId: 'plan-old',
    trackedPlanSource: 'antigravity',
    trackedPlanReviewStatus: 'pending',
    latestRevisionNumber: 1,
  });
  store.getState().handlePlanExitRequest(proposal('antigravity', 'req-2'));
  await settle();

  expect(plansCreate).not.toHaveBeenCalled();
  expect(plansUpdate).toHaveBeenCalledTimes(1);
  expect(plansUpdate).toHaveBeenCalledWith(
    expect.objectContaining({
      planId: 'plan-old',
      source: 'antigravity',
      content: PLAN_TEXT,
      reviewStatus: 'pending',
    }),
  );
  expect(tabOf(store)).toEqual(
    expect.objectContaining({
      trackedPlanId: 'plan-old',
      trackedPlanSource: 'antigravity',
      latestRevisionNumber: 2,
    }),
  );
});

it('creates a fresh tracked plan after a dismissed antigravity plan', async () => {
  const store = fixture({
    trackedPlanId: 'plan-old',
    trackedPlanSource: 'antigravity',
    trackedPlanReviewStatus: 'dismissed',
    latestRevisionNumber: 1,
  });
  store.getState().handlePlanExitRequest(proposal('antigravity', 'req-3'));
  await settle();

  expect(plansUpdate).not.toHaveBeenCalled();
  expect(plansCreate).toHaveBeenCalledTimes(1);
  expect(plansCreate).toHaveBeenCalledWith(
    expect.objectContaining({ source: 'antigravity' }),
  );
  expect(tabOf(store)).toEqual(
    expect.objectContaining({
      trackedPlanId: 'plan-new',
      trackedPlanSource: 'antigravity',
      trackedPlanReviewStatus: 'pending',
    }),
  );
});

it('leaves cursor proposals untouched', async () => {
  const store = fixture();
  store.getState().handlePlanExitRequest(proposal('cursor'));
  await settle();

  expect(plansCreate).toHaveBeenCalledTimes(1);
  expect(plansCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      source: 'cursor',
      content: PLAN_TEXT,
      reviewStatus: 'pending',
    }),
  );
  expect(tabOf(store)).toEqual(
    expect.objectContaining({
      trackedPlanId: 'plan-new',
      trackedPlanSource: 'cursor',
      hasOutstandingProposal: true,
    }),
  );
});

it('recovers an antigravity proposal whose plan save failed', async () => {
  const store = fixture();
  plansCreate
    .mockRejectedValueOnce(new Error('disk full'))
    .mockResolvedValueOnce(trackedPlan('plan-new'));
  store.getState().handlePlanExitRequest(proposal('antigravity'));
  await settle();

  expect(plansCreate).toHaveBeenCalledTimes(1);
  expect(tabOf(store).trackedPlanId).toBeUndefined();
  expect(store.getState().chatStateNotices[KEY]).toEqual(
    expect.objectContaining({ kind: 'command_failed' }),
  );

  recoverUntrackedPlanProposals('p', 'w');
  await settle();

  expect(plansCreate).toHaveBeenCalledTimes(2);
  expect(plansCreate).toHaveBeenLastCalledWith(
    expect.objectContaining({
      proposalRequestId: 'req-1',
      source: 'antigravity',
      content: PLAN_TEXT,
      reviewStatus: 'pending',
    }),
  );
  expect(tabOf(store)).toEqual(
    expect.objectContaining({
      trackedPlanId: 'plan-new',
      trackedPlanSource: 'antigravity',
      trackedPlanReviewStatus: 'pending',
      hasOutstandingProposal: true,
      pendingSystemInstructions: [INSTRUCTION],
    }),
  );
});

it('recovers an antigravity proposal that arrived before the tab existed', async () => {
  mockIsScopeRevisionedLive.mockReturnValue(true);
  const store = fixture(null);
  store.getState().handlePlanExitRequest(proposal('antigravity'));
  await settle();
  expect(plansCreate).not.toHaveBeenCalled();

  // The canonical snapshot later installs the tab with its committed proposal.
  store.setState({
    worktreeChats: {
      [KEY]: {
        ...store.getState().worktreeChats[KEY],
        tabs: [
          {
            id: CHAT_ID,
            title: 'Plan',
            messages: [],
            pendingPlanExit: {
              plan: PLAN_TEXT,
              source: 'antigravity',
              reviewMode: 'proposal',
            },
            pendingPlanExitRequestId: 'req-1',
            trackedPlanSource: 'antigravity',
            trackedPlanReviewStatus: 'pending',
          },
        ],
      },
    },
  } as unknown as Partial<ChatState>);
  recoverUntrackedPlanProposals('p', 'w');
  await settle();

  expect(plansCreate).toHaveBeenCalledTimes(1);
  expect(plansCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      proposalRequestId: 'req-1',
      source: 'antigravity',
      content: PLAN_TEXT,
    }),
  );
  expect(tabOf(store)).toEqual(
    expect.objectContaining({
      trackedPlanId: 'plan-new',
      trackedPlanSource: 'antigravity',
      hasOutstandingProposal: true,
    }),
  );
});

it('creates a fresh tracked plan after a dismissed antigravity plan in a synced scope', async () => {
  // Main's commitPlanExit has already installed the proposal: it marks the
  // tab pending and unlinks the dismissed plan before the handler runs.
  mockIsScopeRevisionedLive.mockReturnValue(true);
  const store = fixture({
    pendingPlanExit: {
      plan: PLAN_TEXT,
      source: 'antigravity',
      reviewMode: 'proposal',
    },
    pendingPlanExitRequestId: 'req-4',
    trackedPlanSource: 'antigravity',
    trackedPlanReviewStatus: 'pending',
    hasOutstandingProposal: true,
  });
  store.getState().handlePlanExitRequest(proposal('antigravity', 'req-4'));
  await settle();

  expect(plansUpdate).not.toHaveBeenCalled();
  expect(plansCreate).toHaveBeenCalledTimes(1);
  expect(plansCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      proposalRequestId: 'req-4',
      source: 'antigravity',
      content: PLAN_TEXT,
    }),
  );
  expect(tabOf(store)).toEqual(
    expect.objectContaining({
      trackedPlanId: 'plan-new',
      trackedPlanSource: 'antigravity',
      trackedPlanReviewStatus: 'pending',
    }),
  );
});
