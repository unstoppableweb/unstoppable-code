import * as providerConnectionEvents from '../../lib/provider-connection-events';
import * as ollamaPreferences from '../../ollama/preferences';
import * as platformCapabilities from '@canopy/desktop-shared/platform-capabilities';
import { getOllamaService } from '../../ollama/service';
// CAN-3686 hosted account read/probe and invalidation contract.
// Real encrypted account-store I/O; HTTP and unrelated enforcement are injected.
import {
  IPC_CHANNELS,
  type CanopyServerAccountInfo,
} from '@canopy/desktop-shared/types';
import { getRemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import { createAppError, AppErrorSchema } from '@canopy/protocol/app-errors';
import { registerIpcHandler } from '../../ipc/register';
import {
  refreshCanopyCloudEnforcedSettings,
  registerSettingsHandlers,
  reprobeAndApplyCanopyCloudEnforcedSettings,
} from '../../ipc/settings';

jest.mock('../../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../../lib/github-pat-env', () => ({
  initializeGitHubPatEnvRuntime: jest.fn(),
}));

import {
  beginCanopyCloudSessionProbe,
  resetCanopyCloudSessionCredential,
  subscribeCanopyCloudSessionStatus,
} from '../../canopy-cloud/session-status';
import {
  applyCanopyCloudSessionProbeResult,
  clearCanopyCloudAccount,
  loadCanopyCloudAccountPublicState,
  saveCanopyCloudAccount,
  saveCanopyCloudAccountIfUnchanged,
  type CanopyCloudAccountEntry,
} from '../../lib/canopy-cloud-account-store';

const entry: CanopyCloudAccountEntry = {
  apiKey: 'test-secret-must-stay-in-main',
  authMode: 'api_key',
  credentialSource: 'manual',
  capabilities: [],
  createdAt: '2026-11-06T00:00:00.000Z',
  updatedAt: '2026-11-06T00:00:00.000Z',
};

beforeEach(async () => {
  jest.mocked(registerIpcHandler).mockClear();
  registerSettingsHandlers({
    dispatcher: {
      query: (): Promise<never> =>
        Promise.reject(new Error('Unexpected dispatch')),
      instruction: (): Promise<never> =>
        Promise.reject(new Error('Unexpected dispatch')),
    },
    resolveCaller: () => {
      throw new Error('Unexpected caller');
    },
  });
  await clearCanopyCloudAccount();
  resetCanopyCloudSessionCredential();
});

function invokeSettings(channel: string, ...args: unknown[]): Promise<unknown> {
  const call = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(([name]) => name === channel);
  if (!call) throw new Error('Missing settings handler');
  return Promise.resolve(Reflect.apply(call[1], undefined, [{}, ...args]));
}

it('keeps session-status invalidation local to the credential-owning host', () => {
  expect(
    getRemoteChannelDisposition(
      IPC_CHANNELS.settingsCanopyCloudSessionStatusChanged,
    ),
  ).toBe('blocked');
});

it('publishes assertion and recovery without leaking the credential, preserving status across snapshot refreshes', async () => {
  const saved = await saveCanopyCloudAccount(entry);
  const states: unknown[] = [];
  const stop = subscribeCanopyCloudSessionStatus((...args) =>
    states.push(args),
  );
  await applyCanopyCloudSessionProbeResult(
    saved,
    beginCanopyCloudSessionProbe(),
    'rejected',
  );
  expect(await loadCanopyCloudAccountPublicState()).toMatchObject({
    sessionExpired: true,
  });
  await applyCanopyCloudSessionProbeResult(
    saved,
    beginCanopyCloudSessionProbe(),
    'rejected',
  );
  expect(states).toEqual([[]]);
  await saveCanopyCloudAccountIfUnchanged(saved, saved);
  expect(await loadCanopyCloudAccountPublicState()).toMatchObject({
    sessionExpired: true,
  });
  await applyCanopyCloudSessionProbeResult(
    saved,
    beginCanopyCloudSessionProbe(),
    'accepted',
  );
  expect(await loadCanopyCloudAccountPublicState()).not.toHaveProperty(
    'sessionExpired',
  );
  expect(states).toEqual([[], []]);
  expect(
    JSON.stringify(await loadCanopyCloudAccountPublicState()),
  ).not.toContain(entry.apiKey);
  stop();
});

it('ignores stale acceptance and rejection, same-key replacement and sign-out races', async () => {
  const saved = await saveCanopyCloudAccount(entry);
  const old = beginCanopyCloudSessionProbe();
  const newer = beginCanopyCloudSessionProbe();
  await applyCanopyCloudSessionProbeResult(saved, newer, 'rejected');
  await applyCanopyCloudSessionProbeResult(saved, old, 'accepted');
  expect(await loadCanopyCloudAccountPublicState()).toMatchObject({
    sessionExpired: true,
  });
  const late = beginCanopyCloudSessionProbe();
  await applyCanopyCloudSessionProbeResult(
    saved,
    beginCanopyCloudSessionProbe(),
    'accepted',
  );
  await applyCanopyCloudSessionProbeResult(saved, late, 'rejected');
  expect(await loadCanopyCloudAccountPublicState()).not.toHaveProperty(
    'sessionExpired',
  );
  const beforeReplace = beginCanopyCloudSessionProbe();
  await saveCanopyCloudAccount(entry);
  await applyCanopyCloudSessionProbeResult(saved, beforeReplace, 'rejected');
  expect(await loadCanopyCloudAccountPublicState()).not.toHaveProperty(
    'sessionExpired',
  );
  const beforeClear = beginCanopyCloudSessionProbe();
  await clearCanopyCloudAccount();
  await saveCanopyCloudAccount(entry);
  await applyCanopyCloudSessionProbeResult(saved, beforeClear, 'rejected');
  expect(await loadCanopyCloudAccountPublicState()).not.toHaveProperty(
    'sessionExpired',
  );
  expect(
    await saveCanopyCloudAccountIfUnchanged(
      saved,
      saved,
      undefined,
      beforeClear,
    ),
  ).toMatchObject({ status: 'superseded' });
});

it('never expires guests, missing credentials or a replaced identity', async () => {
  const saved = await saveCanopyCloudAccount(entry);
  const probe = beginCanopyCloudSessionProbe();
  const replacement = await saveCanopyCloudAccount({
    ...entry,
    apiKey: 'replacement',
  });
  await applyCanopyCloudSessionProbeResult(saved, probe, 'rejected');
  expect(await loadCanopyCloudAccountPublicState()).not.toHaveProperty(
    'sessionExpired',
  );
  await clearCanopyCloudAccount();
  const guest = await saveCanopyCloudAccount({
    ...replacement,
    authMode: 'guest',
    credentialSource: 'guest',
  });
  await applyCanopyCloudSessionProbeResult(
    guest,
    beginCanopyCloudSessionProbe(),
    'rejected',
  );
  expect(await loadCanopyCloudAccountPublicState()).not.toHaveProperty(
    'sessionExpired',
  );
  await clearCanopyCloudAccount();
  expect(await loadCanopyCloudAccountPublicState()).not.toHaveProperty(
    'sessionExpired',
  );
});

it('notifies only after replacement is readable and unsubscribes', async () => {
  const saved = await saveCanopyCloudAccount(entry);
  await applyCanopyCloudSessionProbeResult(
    saved,
    beginCanopyCloudSessionProbe(),
    'rejected',
  );
  const reads: Promise<unknown>[] = [];
  const stop = subscribeCanopyCloudSessionStatus(() =>
    reads.push(loadCanopyCloudAccountPublicState()),
  );
  await clearCanopyCloudAccount();
  expect(await Promise.all(reads)).toEqual([
    expect.objectContaining({ hasApiKey: false }),
  ]);
  stop();
  const fresh = await saveCanopyCloudAccount(entry);
  await applyCanopyCloudSessionProbeResult(
    fresh,
    beginCanopyCloudSessionProbe(),
    'rejected',
  );
  expect(reads).toHaveLength(1);
});

jest.mock('../../canopy-cloud/config', () => ({
  getCanopyCloudBaseUrl: (): string => 'https://cloud.example.test',
}));
jest.mock('../../services/org-enforced-settings', () => ({
  applyEnforcedSettings: jest.fn(),
}));
jest.mock('../../shared-containers/organization-snapshot-transition', () => ({
  organizationSnapshotTransition:
    (): ((persist: () => Promise<unknown>) => Promise<unknown>) =>
    (persist: () => Promise<unknown>): Promise<unknown> =>
      persist(),
}));

it('reprobes the stored account through the production settings service', async () => {
  await saveCanopyCloudAccount(entry);
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      (url): Promise<Response> =>
        Promise.resolve(
          isWellKnown(url)
            ? new Response(JSON.stringify({ capabilities: ['account-v1'] }))
            : new Response('Rejected', { status: 401 }),
        ),
    );
  try {
    await invokeSettings(
      IPC_CHANNELS.settingsRefreshCanopyCloudEnforcedSettings,
    );
    expect(
      await invokeSettings(IPC_CHANNELS.settingsLoadCanopyCloudAccount),
    ).toMatchObject({
      sessionExpired: true,
    });
  } finally {
    fetchMock.mockRestore();
  }
});

const capabilities = [
  'pipelines-crud-v1',
  'account-v1',
  'organizations-v1',
  'teams-v1',
];
const account: CanopyServerAccountInfo = {
  id: 'account-one',
  name: 'Test account',
  email: 'test@example.test',
  role: 'DEVELOPER',
};
function isWellKnown(url: Parameters<typeof fetch>[0]): boolean {
  return typeof url === 'string' && url.includes('/.well-known/');
}
function wellKnown(): Response {
  return Response.json({ capabilities });
}
function authenticated(): Response {
  return Response.json({ account, capabilities, organizations: [], teams: [] });
}

it('distinguishes a fresh Personal organization read from a cached fallback', async () => {
  const personalOrganizationId = '11111111-1111-4111-8111-111111111111';
  await saveCanopyCloudAccount({ ...entry, account, personalOrganizationId });
  let offline = true;
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation((url): Promise<Response> => {
      if (offline) return Promise.reject(new TypeError('Network unavailable'));
      if (isWellKnown(url)) return Promise.resolve(wellKnown());
      return Promise.resolve(
        Response.json({
          account,
          capabilities,
          personalOrganizationId,
          organizations: [],
          teams: [],
        }),
      );
    });
  try {
    const cached = await refreshCanopyCloudEnforcedSettings();
    expect(cached.personalOrganizationId).toBe(personalOrganizationId);
    expect(cached.accountProbeApplied).toBeUndefined();
    offline = false;
    expect(await refreshCanopyCloudEnforcedSettings()).toMatchObject({
      personalOrganizationId,
      accountProbeApplied: true,
    });
    expect(await loadCanopyCloudAccountPublicState()).not.toHaveProperty(
      'accountProbeApplied',
    );
  } finally {
    fetchMock.mockRestore();
  }
});

it.each([401, 403, 500])(
  'does not expire a session on well-known HTTP %i',
  async (status) => {
    await saveCanopyCloudAccount(entry);
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('Unavailable', { status }));
    try {
      await reprobeAndApplyCanopyCloudEnforcedSettings();
      expect(await loadCanopyCloudAccountPublicState()).not.toHaveProperty(
        'sessionExpired',
      );
    } finally {
      fetchMock.mockRestore();
    }
  },
);

it.each([403, 429, 500, 503])(
  'does not expire a session on account HTTP %i',
  async (status) => {
    await saveCanopyCloudAccount(entry);
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        (url): Promise<Response> =>
          Promise.resolve(
            isWellKnown(url)
              ? wellKnown()
              : new Response('Unavailable', { status }),
          ),
      );
    try {
      await reprobeAndApplyCanopyCloudEnforcedSettings();
      expect(await loadCanopyCloudAccountPublicState()).not.toHaveProperty(
        'sessionExpired',
      );
    } finally {
      fetchMock.mockRestore();
    }
  },
);

it.each([
  new TypeError('Network failed'),
  Object.assign(new Error('Timed out'), { name: 'AbortError' }),
])(
  'preserves known rejection through inconclusive network results: %s',
  async (error) => {
    const saved = await saveCanopyCloudAccount(entry);
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((url): Promise<Response> => {
        if (isWellKnown(url)) return Promise.resolve(wellKnown());
        return Promise.reject(error);
      });
    try {
      await reprobeAndApplyCanopyCloudEnforcedSettings();
      expect(await loadCanopyCloudAccountPublicState()).not.toHaveProperty(
        'sessionExpired',
      );
      await applyCanopyCloudSessionProbeResult(
        saved,
        beginCanopyCloudSessionProbe(),
        'rejected',
      );
      await reprobeAndApplyCanopyCloudEnforcedSettings();
      expect(await loadCanopyCloudAccountPublicState()).toMatchObject({
        sessionExpired: true,
      });
    } finally {
      fetchMock.mockRestore();
    }
  },
);

it('clears rejection on an authenticated reprobe without adding a polling timer', async () => {
  const saved = await saveCanopyCloudAccount(entry);
  await applyCanopyCloudSessionProbeResult(
    saved,
    beginCanopyCloudSessionProbe(),
    'rejected',
  );
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      (url): Promise<Response> =>
        Promise.resolve(isWellKnown(url) ? wellKnown() : authenticated()),
    );
  try {
    await reprobeAndApplyCanopyCloudEnforcedSettings();
    expect(await loadCanopyCloudAccountPublicState()).not.toHaveProperty(
      'sessionExpired',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    fetchMock.mockRestore();
  }
});

it('preserves rejection when an HTTP success has no authenticated account', async () => {
  const saved = await saveCanopyCloudAccount(entry);
  await applyCanopyCloudSessionProbeResult(
    saved,
    beginCanopyCloudSessionProbe(),
    'rejected',
  );
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      (url): Promise<Response> =>
        Promise.resolve(
          isWellKnown(url) ? wellKnown() : Response.json({ capabilities }),
        ),
    );
  try {
    await reprobeAndApplyCanopyCloudEnforcedSettings();
    expect(await loadCanopyCloudAccountPublicState()).toMatchObject({
      sessionExpired: true,
    });
  } finally {
    fetchMock.mockRestore();
  }
});

it.each([401, 200])(
  'discards a late account HTTP %i after clearing and saving the same key',
  async (status) => {
    await saveCanopyCloudAccount(entry);
    let finish!: (response: Response) => void;
    let reached!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((url): Promise<Response> => {
        if (isWellKnown(url)) return Promise.resolve(wellKnown());
        reached();
        return pending;
      });
    try {
      const refresh = reprobeAndApplyCanopyCloudEnforcedSettings();
      await started;
      const waiting = reprobeAndApplyCanopyCloudEnforcedSettings();
      await clearCanopyCloudAccount();
      await saveCanopyCloudAccount(entry);
      finish(
        status === 200 ? authenticated() : new Response('Rejected', { status }),
      );
      await Promise.all([refresh, waiting]);
      const state = await loadCanopyCloudAccountPublicState();
      expect(state).not.toHaveProperty('sessionExpired');
      expect(state).not.toHaveProperty('account');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  },
);

it('candidate-key validation and failed saves do not invalidate the stored session', async () => {
  await saveCanopyCloudAccount(entry);

  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      (url): Promise<Response> =>
        Promise.resolve(
          isWellKnown(url)
            ? wellKnown()
            : new Response('Rejected', { status: 401 }),
        ),
    );
  try {
    for (const channel of [
      IPC_CHANNELS.settingsValidateCanopyCloudApiKey,
      IPC_CHANNELS.settingsSaveCanopyCloudApiKey,
    ]) {
      const call = jest
        .mocked(registerIpcHandler)
        .mock.calls.find(([name]) => name === channel);
      expect(call).toBeDefined();
      if (!call) throw new Error('Missing handler');
      await Reflect.apply(call[1], undefined, [{}, { apiKey: 'candidate' }]);
      expect(await loadCanopyCloudAccountPublicState()).not.toHaveProperty(
        'sessionExpired',
      );
    }
  } finally {
    fetchMock.mockRestore();
  }
});

it.each(['runtime.claude', 'runtime.codex', 'runtime.ollama'])(
  'accepts the standing-condition wire errors for %s',
  (source) => {
    expect(
      AppErrorSchema.parse(
        createAppError('app.runtime_unreachable', { source }),
      ),
    ).toMatchObject({ kind: 'defect', source });
    expect(
      createAppError('external.runtime_unreachable', { source }),
    ).toMatchObject({ kind: 'external', recovery: 'fix_first' });
    expect(
      createAppError('external.sync_paused', { source: 'activity.sync' }),
    ).toMatchObject({ kind: 'external', recovery: 'wait' });
  },
);

// The standing banner's recovery caller uses the existing Ollama connection
// operation, but that passive check must never become a provider setup event.
it.each([false, true])(
  'ollama:test-connection connected=%s preserves the provider setup funnel',
  async (connected) => {
    const observed = jest
      .spyOn(providerConnectionEvents, 'observeProviderConnection')
      .mockImplementation(() => undefined);
    const failed = jest
      .spyOn(providerConnectionEvents, 'recordProviderConnectionFailure')
      .mockImplementation(() => undefined);
    const supported = jest
      .spyOn(platformCapabilities, 'isOllamaSupportedOnPlatform')
      .mockReturnValue(true);
    const preferences = jest
      .spyOn(ollamaPreferences, 'readOllamaPreferences')
      .mockResolvedValue({ port: 11434, mode: 'managed', executablePath: '' });
    const fetched = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(
          connected
            ? new Response(JSON.stringify({ version: '0.6.1' }))
            : new Response('', { status: 503 }),
        ),
      );
    const service = getOllamaService();
    try {
      const result = await service.testConnection(11434, {
        background: true,
      });
      expect(result).toMatchObject({
        ok: connected,
        host: '127.0.0.1',
        port: 11434,
      });
      expect(failed).not.toHaveBeenCalled();
      expect(observed).not.toHaveBeenCalled();
      // The explicit Settings test retains its existing attribution.
      expect((await service.testConnection(11434)).ok).toBe(connected);
      if (connected) expect(observed).toHaveBeenCalled();
      else expect(failed).toHaveBeenCalledWith('ollama', 'local', 'network');
    } finally {
      fetched.mockRestore();
      preferences.mockRestore();
      supported.mockRestore();
      failed.mockRestore();
      observed.mockRestore();
    }
  },
);
