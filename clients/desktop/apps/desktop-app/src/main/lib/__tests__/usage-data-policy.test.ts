import {
  IPC_CHANNELS,
  type UsageDataPolicySnapshot,
} from '@canopy/desktop-shared/types';
import { IPC_REMOTE_DISPOSITIONS } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import {
  __resetUsageDataPolicyForTests,
  createUsageDataPolicy,
  defaultUsageDataPreferences,
  getEffectiveUsageDataPolicy,
  getUsageDataPolicy,
  usageDataConsentStateOf,
  type UsageDataConsentState,
  type UsageDataProhibitionState,
} from '../usage-data-policy';
import {
  attachUsageDataPolicyToWorkspaceContext,
  initializeStartupUsageDataPolicy,
  installPostHogMainLifecycle,
  USAGE_DATA_PREFERENCES_RETRY_MS,
  installUsageDataPolicyFeatureFlagRefresh,
} from '../usage-data-policy-host';
import { loadStoredUsageDataProhibitionByOrganization } from '../telemetry-enforcement-state';
import {
  arePreferencesUnconfirmed,
  readPreferencesFile,
} from '../preferences-store';
import type { WorkspaceContextService } from '../workspace-context-service';

jest.mock('../preferences-store', () => ({
  arePreferencesUnconfirmed: jest.fn(),
  readPreferencesFile: jest.fn(),
}));
jest.mock('../telemetry-enforcement-state', () => ({
  loadStoredUsageDataProhibitionByOrganization: jest.fn(),
  recordTelemetryEnforcementReadFailure: jest.fn(),
}));

const ACME = '11111111-1111-4111-8111-111111111111';
const ACCEPTED: UsageDataConsentState = {
  accepted: true,
  analyticsDeclinedAtOnboarding: false,
};
const ALL_OFF = {
  productAnalytics: false,
  sessionReplay: false,
  errorReports: false,
  activeUseSignal: false,
  featureFlagIdentity: false,
  skillSafetyCheck: false,
};
const OTHER = '22222222-2222-4222-8222-222222222222';

function acmeProhibits(): UsageDataProhibitionState {
  return new Map([
    [
      ACME,
      {
        organizationName: 'Acme',
        prohibited: {
          productAnalytics: true,
          sessionReplay: false,
          errorReports: false,
          activeUseSignal: true,
          featureFlagIdentity: true,
        },
      },
    ],
  ]);
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  __resetUsageDataPolicyForTests();
  jest.mocked(readPreferencesFile).mockReset();
  jest.mocked(arePreferencesUnconfirmed).mockReset();
  jest.mocked(loadStoredUsageDataProhibitionByOrganization).mockReset();
});

describe('usage-data policy resolution', () => {
  it('fails closed on an unreadable account, even in Personal, until a probe succeeds', () => {
    const policy = createUsageDataPolicy({
      consent: ACCEPTED,
      prohibitions: 'unreadable',
      settleTimeoutMs: 50,
    });
    policy.setWorkspaceContext({ kind: 'personal' });
    expect(policy.getEffectiveUsageDataPolicy()).toEqual({
      productAnalytics: false,
      sessionReplay: false,
      errorReports: false,
      activeUseSignal: false,
      featureFlagIdentity: false,
      skillSafetyCheck: true,
    });
    expect(
      policy.getUsageDataPolicySnapshot().prohibitedBy.errorReports,
    ).toEqual({ organizationName: null });
    // An empty successful probe replaces the unreadable state.
    expect(policy.setProhibitionsByOrganization(new Map())).toBe(true);
    expect(policy.getEffectiveUsageDataPolicy()).toEqual(
      defaultUsageDataPreferences(),
    );
  });

  it('is conservative before the context is known, then resolves by context', () => {
    const policy = createUsageDataPolicy({
      consent: ACCEPTED,
      prohibitions: acmeProhibits(),
    });
    expect(policy.getEffectiveUsageDataPolicy().productAnalytics).toBe(false);
    expect(policy.getEffectiveUsageDataPolicy().errorReports).toBe(true);

    policy.setWorkspaceContext({ kind: 'personal' });
    expect(policy.getEffectiveUsageDataPolicy()).toEqual(
      defaultUsageDataPreferences(),
    );

    policy.setWorkspaceContext({
      kind: 'organization',
      organizationId: ACME.toUpperCase(),
    });
    expect(policy.getEffectiveUsageDataPolicy().activeUseSignal).toBe(false);
    expect(
      policy.getUsageDataPolicySnapshot().prohibitedBy.featureFlagIdentity,
    ).toEqual({ organizationName: 'Acme' });

    // An organization absent from the map prohibits nothing.
    policy.setWorkspaceContext({ kind: 'organization', organizationId: OTHER });
    expect(policy.getEffectiveUsageDataPolicy()).toEqual(
      defaultUsageDataPreferences(),
    );
  });

  it('keeps the stored choice and notifies only on change', () => {
    const policy = createUsageDataPolicy({
      consent: ACCEPTED,
      prohibitions: acmeProhibits(),
    });
    policy.setWorkspaceContext({ kind: 'organization', organizationId: ACME });
    const listener = jest.fn();
    policy.subscribe(listener);

    policy.setPreferences({
      ...defaultUsageDataPreferences(),
      productAnalytics: false,
    });
    expect(listener).not.toHaveBeenCalled();
    expect(
      policy.getUsageDataPolicySnapshot().preferences.productAnalytics,
    ).toBe(false);

    // Sign-out clears prohibitions and restores the member's own choices.
    policy.setProhibitionsByOrganization(new Map());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(policy.getEffectiveUsageDataPolicy().activeUseSignal).toBe(true);
    expect(policy.getEffectiveUsageDataPolicy().productAnalytics).toBe(false);
  });

  it('observes Error reports opt-out and re-enable while organization policy is unreadable', () => {
    const policy = createUsageDataPolicy({
      consent: ACCEPTED,
      prohibitions: 'unreadable',
    });
    policy.setWorkspaceContext({ kind: 'personal' });
    const effectivePolicyListener = jest.fn();
    const crashPolicyListener = jest.fn<void, [UsageDataPolicySnapshot]>();
    policy.subscribe(effectivePolicyListener);
    policy.subscribe(crashPolicyListener, {
      includeErrorReportsPreference: true,
    });

    const defaults = defaultUsageDataPreferences();
    policy.setPreferences({ ...defaults, errorReports: false });
    policy.setPreferences(defaults);

    expect(
      crashPolicyListener.mock.calls.map(([snapshot]) => [
        snapshot.preferences.errorReports,
        snapshot.effective.errorReports,
      ]),
    ).toEqual([
      [false, false],
      [true, false],
    ]);
    expect(effectivePolicyListener).not.toHaveBeenCalled();

    expect(policy.setProhibitionsByOrganization(new Map())).toBe(true);
    expect(crashPolicyListener).toHaveBeenCalledTimes(3);
    expect(effectivePolicyListener).toHaveBeenCalledTimes(1);
    expect(policy.getEffectiveUsageDataPolicy().errorReports).toBe(true);
  });

  it('narrows a per-turn report by the organization that owns the work', () => {
    const policy = createUsageDataPolicy({
      consent: ACCEPTED,
      prohibitions: acmeProhibits(),
    });
    policy.setWorkspaceContext({ kind: 'personal' });
    expect(policy.getEffectiveUsageDataPolicy().activeUseSignal).toBe(true);
    expect(policy.allowsForOrganization('activeUseSignal', undefined)).toBe(
      true,
    );
    expect(
      policy.allowsForOrganization('activeUseSignal', ACME.toUpperCase()),
    ).toBe(false);
    expect(policy.allowsForOrganization('errorReports', ACME)).toBe(true);
    expect(
      createUsageDataPolicy({
        consent: ACCEPTED,
        prohibitions: 'unreadable',
      }).allowsForOrganization('activeUseSignal', undefined),
    ).toBe(false);
  });

  it('turns every flow off while legal consent is pending, with no attribution', () => {
    const policy = createUsageDataPolicy({ prohibitions: new Map() });
    policy.setWorkspaceContext({ kind: 'personal' });
    expect(policy.getEffectiveUsageDataPolicy()).toEqual(ALL_OFF);
    const snapshot = policy.getUsageDataPolicySnapshot();
    expect(snapshot.consentPending).toBe(true);
    expect(snapshot.prohibitedBy).toEqual({});
    // The stored (pre-checked) choices are kept as is.
    expect(snapshot.preferences).toEqual(defaultUsageDataPreferences());
    expect(policy.isConsentPending()).toBe(true);
    // The journal deny path keeps consent pending.
    policy.setPreferences(defaultUsageDataPreferences());
    expect(policy.isConsentPending()).toBe(true);
    // The default singleton fails closed too.
    expect(getEffectiveUsageDataPolicy()).toEqual(ALL_OFF);
  });

  it('applies consent and choices in one recompute', () => {
    const policy = createUsageDataPolicy({ prohibitions: new Map() });
    policy.setWorkspaceContext({ kind: 'personal' });
    const seen: boolean[] = [];
    policy.subscribe((snapshot) => {
      seen.push(snapshot.effective.productAnalytics);
    });
    policy.setStored(
      { ...defaultUsageDataPreferences(), productAnalytics: false },
      ACCEPTED,
    );
    // Accepting with Usage analytics off never shows it on, even briefly.
    expect(seen).toEqual([false]);
    expect(policy.getEffectiveUsageDataPolicy()).toEqual({
      ...defaultUsageDataPreferences(),
      productAnalytics: false,
    });
    expect(policy.getUsageDataPolicySnapshot().consentPending).toBeUndefined();
  });

  it('notifies on accept even when every switch stays off', () => {
    const policy = createUsageDataPolicy({
      preferences: ALL_OFF,
      prohibitions: new Map(),
    });
    const listener = jest.fn();
    policy.subscribe(listener);
    policy.setStored(ALL_OFF, ACCEPTED);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(policy.isConsentPending()).toBe(false);
  });

  it('returns to pending when consent is lost mid-session', () => {
    const policy = createUsageDataPolicy({
      consent: ACCEPTED,
      prohibitions: new Map(),
    });
    policy.setWorkspaceContext({ kind: 'personal' });
    const listener = jest.fn();
    policy.subscribe(listener);
    policy.setStored(defaultUsageDataPreferences(), {
      accepted: false,
      analyticsDeclinedAtOnboarding: false,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(policy.getEffectiveUsageDataPolicy()).toEqual(ALL_OFF);
    expect(policy.isConsentPending()).toBe(true);
  });

  it('keeps the unreadable-preferences snapshot unchanged while consent is pending', () => {
    const pending = createUsageDataPolicy({
      preferences: 'unreadable',
      prohibitions: new Map(),
    });
    const accepted = createUsageDataPolicy({
      preferences: 'unreadable',
      consent: ACCEPTED,
      prohibitions: new Map(),
    });
    expect(pending.getUsageDataPolicySnapshot()).toEqual(
      accepted.getUsageDataPolicySnapshot(),
    );
    expect(pending.getEffectiveUsageDataPolicy().skillSafetyCheck).toBe(true);
    expect(pending.isConsentPending()).toBe(false);
  });

  it('reports and notifies a change of the onboarding decline', () => {
    const preferences = {
      ...defaultUsageDataPreferences(),
      productAnalytics: false,
    };
    const policy = createUsageDataPolicy({
      preferences,
      consent: ACCEPTED,
      prohibitions: new Map(),
    });
    const listener = jest.fn();
    policy.subscribe(listener);
    policy.setStored(preferences, {
      accepted: true,
      analyticsDeclinedAtOnboarding: true,
    });
    expect(policy.wasAnalyticsDeclinedAtOnboarding()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('derives consent from the committed preferences', () => {
    expect(
      usageDataConsentStateOf({
        legalConsentAcceptedAt: '  ',
        usageAnalyticsDeclinedAtOnboarding: false,
      }),
    ).toEqual({ accepted: false, analyticsDeclinedAtOnboarding: false });
    expect(
      usageDataConsentStateOf({
        legalConsentAcceptedAt: '2026-11-24T00:00:00.000Z',
        usageAnalyticsDeclinedAtOnboarding: true,
      }),
    ).toEqual({ accepted: true, analyticsDeclinedAtOnboarding: true });
  });

  it('settles on a context, on context failure, or on timeout', async () => {
    await createUsageDataPolicy({ settleTimeoutMs: 5 }).whenSettled();
    const failed = createUsageDataPolicy({ settleTimeoutMs: 60_000 });
    failed.settleWithoutContext();
    await failed.whenSettled();
  });
});

describe('usage-data policy host wiring', () => {
  it('initializeStartupUsageDataPolicy fails closed when the account is unreadable', async () => {
    jest.mocked(readPreferencesFile).mockResolvedValue({
      usageData: { ...defaultUsageDataPreferences(), skillSafetyCheck: false },
      legalConsentAcceptedAt: '2026-11-01T00:00:00.000Z',
    } as Awaited<ReturnType<typeof readPreferencesFile>>);
    jest
      .mocked(loadStoredUsageDataProhibitionByOrganization)
      .mockRejectedValue(new Error('Secure account storage is unavailable.'));
    await initializeStartupUsageDataPolicy();
    expect(getUsageDataPolicy().getEffectiveUsageDataPolicy()).toMatchObject({
      productAnalytics: false,
      errorReports: false,
      skillSafetyCheck: false,
    });
  });

  it('initializeStartupUsageDataPolicy keeps prohibitable flows off while preferences recovery is latched', async () => {
    // A latched failed recovery resolves with defaults or a possibly stale
    // last-good rather than rejecting.
    jest.mocked(readPreferencesFile).mockResolvedValue({
      usageData: defaultUsageDataPreferences(),
      legalConsentAcceptedAt: '2026-11-01T00:00:00.000Z',
    } as Awaited<ReturnType<typeof readPreferencesFile>>);
    jest.mocked(arePreferencesUnconfirmed).mockReturnValue(true);
    jest
      .mocked(loadStoredUsageDataProhibitionByOrganization)
      .mockResolvedValue(new Map() as never);
    await initializeStartupUsageDataPolicy();
    const policy = getUsageDataPolicy();
    expect(policy.getEffectiveUsageDataPolicy()).toEqual({
      productAnalytics: false,
      sessionReplay: false,
      errorReports: false,
      activeUseSignal: false,
      featureFlagIdentity: false,
      skillSafetyCheck: true,
    });
    // Attributed, so Settings shows the rows locked off rather than on.
    expect(
      policy.getUsageDataPolicySnapshot().prohibitedBy.errorReports,
    ).toEqual({ organizationName: null, preferencesUnreadable: true });
    // Unreadable is never reported as consent pending.
    expect(policy.isConsentPending()).toBe(false);
    expect(policy.getUsageDataPolicySnapshot().consentPending).toBeUndefined();
    // A committed save of real preferences ends the fail-closed state.
    policy.setStored(defaultUsageDataPreferences(), ACCEPTED);
    expect(policy.getEffectiveUsageDataPolicy()).toEqual(
      defaultUsageDataPreferences(),
    );
  });

  it('initializeStartupUsageDataPolicy keeps a fresh profile consent-pending', async () => {
    jest.mocked(readPreferencesFile).mockResolvedValue({
      usageData: defaultUsageDataPreferences(),
      usageAnalyticsDeclinedAtOnboarding: false,
    } as Awaited<ReturnType<typeof readPreferencesFile>>);
    jest
      .mocked(loadStoredUsageDataProhibitionByOrganization)
      .mockResolvedValue(new Map() as never);
    await initializeStartupUsageDataPolicy();
    expect(getUsageDataPolicy().isConsentPending()).toBe(true);
    expect(getEffectiveUsageDataPolicy()).toEqual(ALL_OFF);
  });

  it('initializeStartupUsageDataPolicy retries a rejected preferences read once', async () => {
    jest.useFakeTimers();
    try {
      jest
        .mocked(readPreferencesFile)
        .mockRejectedValueOnce(new Error('EBUSY: resource busy'))
        .mockResolvedValue({
          usageData: {
            ...defaultUsageDataPreferences(),
            productAnalytics: false,
          },
          legalConsentAcceptedAt: '2026-11-01T00:00:00.000Z',
        } as Awaited<ReturnType<typeof readPreferencesFile>>);
      jest
        .mocked(loadStoredUsageDataProhibitionByOrganization)
        .mockResolvedValue(new Map() as never);
      await initializeStartupUsageDataPolicy();
      expect(getEffectiveUsageDataPolicy().errorReports).toBe(false);

      await jest.advanceTimersByTimeAsync(USAGE_DATA_PREFERENCES_RETRY_MS);
      expect(getEffectiveUsageDataPolicy()).toEqual({
        ...defaultUsageDataPreferences(),
        productAnalytics: false,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('attachUsageDataPolicyToWorkspaceContext resolves by the selected context and its switches', async () => {
    jest.mocked(readPreferencesFile).mockResolvedValue({
      usageData: defaultUsageDataPreferences(),
      legalConsentAcceptedAt: '2026-11-01T00:00:00.000Z',
    } as Awaited<ReturnType<typeof readPreferencesFile>>);
    jest
      .mocked(loadStoredUsageDataProhibitionByOrganization)
      .mockResolvedValue(acmeProhibits() as never);
    await initializeStartupUsageDataPolicy();
    let emit: Parameters<WorkspaceContextService['subscribe']>[0] = () =>
      undefined;
    attachUsageDataPolicyToWorkspaceContext({
      initialize: () => Promise.resolve(),
      getState: () => ({
        context: { kind: 'organization', organizationId: ACME },
        revision: 1,
        organizations: [],
      }),
      subscribe: (listener): (() => void) => {
        emit = listener;
        return (): void => undefined;
      },
    });
    await getUsageDataPolicy().whenSettled();
    expect(
      getUsageDataPolicy().getEffectiveUsageDataPolicy().productAnalytics,
    ).toBe(false);
    emit({
      context: { kind: 'personal' },
      revision: 2,
      organizations: [],
      reason: 'switch',
    });
    expect(
      getUsageDataPolicy().getEffectiveUsageDataPolicy().productAnalytics,
    ).toBe(true);
  });

  it('installPostHogMainLifecycle starts only while a PostHog flow is on and suspends when both turn off', async () => {
    const policy = createUsageDataPolicy({
      consent: ACCEPTED,
      prohibitions: new Map(),
    });
    policy.setPreferences({
      ...defaultUsageDataPreferences(),
      productAnalytics: false,
      errorReports: false,
    });
    const start = jest.fn();
    const suspend = jest.fn(() => Promise.resolve());
    installPostHogMainLifecycle(policy, suspend, start);
    policy.setWorkspaceContext({ kind: 'personal' });
    await flush();
    expect(start).not.toHaveBeenCalled();

    policy.setPreferences({
      ...defaultUsageDataPreferences(),
      productAnalytics: false,
    });
    policy.setPreferences(defaultUsageDataPreferences());
    expect(start).toHaveBeenCalledTimes(1);

    policy.setPreferences({
      ...defaultUsageDataPreferences(),
      productAnalytics: false,
      errorReports: false,
    });
    expect(suspend).toHaveBeenCalledTimes(1);
  });

  it('installUsageDataPolicyFeatureFlagRefresh re-identifies only when the identity choice flips', () => {
    __resetUsageDataPolicyForTests({ consent: ACCEPTED });
    const policy = getUsageDataPolicy();
    let built = true;
    const refresh = jest.fn(() => {
      built = policy.getEffectiveUsageDataPolicy().featureFlagIdentity;
      return Promise.resolve();
    });
    installUsageDataPolicyFeatureFlagRefresh(refresh, () => built);
    policy.setPreferences({
      ...defaultUsageDataPreferences(),
      skillSafetyCheck: false,
    });
    expect(refresh).not.toHaveBeenCalled();
    policy.setPreferences({
      ...defaultUsageDataPreferences(),
      featureFlagIdentity: false,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps IPC_CHANNELS.observabilityGetUsageDataPolicy and its broadcast local to this computer', () => {
    expect(IPC_CHANNELS.observabilityGetUsageDataPolicy).toBe(
      'observability:get-usage-data-policy',
    );
    expect(IPC_REMOTE_DISPOSITIONS.observabilityGetUsageDataPolicy).toBe(
      'local',
    );
    expect(IPC_REMOTE_DISPOSITIONS.observabilityUsageDataPolicyChanged).toBe(
      'local',
    );
  });
});
