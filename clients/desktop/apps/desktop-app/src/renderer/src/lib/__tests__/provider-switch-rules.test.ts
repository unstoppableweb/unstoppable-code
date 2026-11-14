import {
  APP_ADVISOR_PROJECT_ID,
  type AgentProviderType,
  type ModelHarness,
} from '@canopy/desktop-shared/types';
import {
  canContinueOnOtherHarness,
  canSwitchChatProvider,
  type ContinuableTabLike,
} from '../chatProviderLock';
import {
  resolveModelRowGate,
  type ModelRowGateInput,
} from '../modelPickerRowGate';

function startedTab(
  providerType: AgentProviderType,
  extra: Partial<ContinuableTabLike> = {},
): ContinuableTabLike {
  return { messages: { length: 2 }, providerType, ...extra };
}

function row(
  provider: AgentProviderType,
  harness: ModelHarness,
  lockedProvider: AgentProviderType,
  lockedHarness: ModelHarness,
  lockedProviderBehavior: ModelRowGateInput['lockedProviderBehavior'],
): ModelRowGateInput {
  return {
    model: `${provider}-model`,
    provider,
    selectedHarness: harness,
    currentModel: `${lockedProvider}-model`,
    gatingEnabled: false,
    availability: undefined,
    billingValue: undefined,
    lockedProvider,
    lockedProviderBehavior,
    lockedProviderReason: undefined,
    lockedHarness,
    canStartNewChat: true,
    modelPolicy: new Set(),
    staleAgent: false,
  };
}

describe('switching a started chat to another provider (CAN-6445)', () => {
  it.each<[AgentProviderType, AgentProviderType]>([
    ['claude', 'codex'],
    ['codex', 'claude'],
    ['claude', 'cursor'],
    ['codex', 'copilot'],
    ['cursor', 'copilot'],
  ])('switches %s to %s in place', (from, to) => {
    expect(canSwitchChatProvider(startedTab(from), to, 'project')).toEqual({
      ok: true,
    });
  });

  it.each<[AgentProviderType, AgentProviderType]>([
    ['claude', 'ollama'],
    ['ollama', 'codex'],
    ['claude', 'opencode'],
    ['opencode', 'claude'],
  ])('never switches %s to %s in place', (from, to) => {
    expect(
      canSwitchChatProvider(startedTab(from), to, 'project'),
    ).toMatchObject({ ok: false, code: 'not-continuable' });
  });

  it('keeps the new-chat fork to Claude and Codex', () => {
    expect(
      canContinueOnOtherHarness(startedTab('claude'), 'codex', 'project'),
    ).toEqual({ ok: true });
    expect(
      canContinueOnOtherHarness(startedTab('claude'), 'cursor', 'project'),
    ).toMatchObject({ ok: false, code: 'not-continuable' });
  });

  it.each<[string, Partial<ContinuableTabLike>, string]>([
    ['a running turn', { status: 'streaming' }, 'busy'],
    ['queued messages', { queuedMessages: { length: 1 } }, 'queued'],
    ['an unanswered question', { hasUnansweredQuestion: true }, 'busy'],
    [
      'a pending plan',
      { pendingPlanExit: { requestId: 'plan' } },
      'pending-plan',
    ],
    ['a read-only chat', { readOnly: true }, 'read-only'],
  ])('waits for %s before switching', (_label, extra, code) => {
    expect(
      canSwitchChatProvider(startedTab('claude', extra), 'cursor', 'project'),
    ).toMatchObject({ ok: false, code });
  });

  it('never switches a terminal chat or App Advisor in place', () => {
    expect(
      canSwitchChatProvider(
        startedTab('claude', { interfaceMode: 'claude-code' }),
        'codex',
        'project',
      ),
    ).toMatchObject({ ok: false, code: 'not-continuable' });
    expect(
      canSwitchChatProvider(
        startedTab('claude'),
        'codex',
        APP_ADVISOR_PROJECT_ID,
      ),
    ).toMatchObject({ ok: false, code: 'not-continuable' });
  });

  it('offers a switchable row in a started chat from the composer', () => {
    expect(
      resolveModelRowGate(
        row('cursor', 'cursor', 'claude', 'claude', 'continue'),
      ),
    ).toEqual({ kind: 'available' });
    expect(
      resolveModelRowGate(
        row('codex', 'codex', 'claude', 'claude', 'continue'),
      ),
    ).toEqual({ kind: 'available' });
  });

  it('keeps other provider rows locked where nothing can switch', () => {
    expect(
      resolveModelRowGate(
        row('cursor', 'cursor', 'claude', 'claude', 'disabled'),
      ),
    ).toMatchObject({ kind: 'hard-disabled', cause: 'locked-provider' });
    expect(
      resolveModelRowGate(
        row('opencode', 'opencode', 'claude', 'claude', 'continue'),
      ).kind,
    ).not.toBe('available');
  });
});
