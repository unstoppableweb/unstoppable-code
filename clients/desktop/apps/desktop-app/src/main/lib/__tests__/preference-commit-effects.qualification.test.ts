// Golden for the committed-change consumer of preferences (CAN-7975): the
// real store over a temporary data root, with the host modules beneath the
// native effect ports mocked, never the ports or the consumer. The cases for
// existing behavior were written and passing on the code before the consumer.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp', on: jest.fn() },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
  nativeTheme: { themeSource: 'system' },
  shell: { openPath: jest.fn() },
}));

let mockPreferencesFilePath = '';
jest.mock('../paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../paths'),
  getPreferencesFilePath: (): string => mockPreferencesFilePath,
  getClientPreferencesFilePath: (): string =>
    path.join(path.dirname(mockPreferencesFilePath), 'client-preferences.json'),
}));

jest.mock('../native-crash-policy', () => ({
  nativeCrashAnnotation: {
    suspendForOptOut: jest.fn(),
    resumeAfterOptIn: (): void => {
      mockEvents.push('crash-resume');
    },
  },
}));

jest.mock('../../remote-control/host/bridge-window', () => ({
  resolveRemoteBridgeSender: (): null => null,
}));

jest.mock('../../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

// One ordered record of every effect and broadcast.
const mockEvents: string[] = [];
const mockFailures = { copilotRevoke: false };

jest.mock('../preferences-broadcast', () => ({
  ...jest.requireActual<typeof PreferencesBroadcastModule>(
    '../preferences-broadcast',
  ),
  broadcastPreferencesSynced: (preferences: {
    globalFocusShortcut?: string;
  }): void => {
    mockEvents.push(`broadcast:${preferences.globalFocusShortcut ?? ''}`);
  },
  broadcastPreferencesChanged: (): void => {
    mockEvents.push('broadcast:changed');
  },
}));

jest.mock('../../installed-items/installed-item-events', () => ({
  notifyInstalledItemsChanged: (): void => {
    mockEvents.push('installed-items');
  },
}));

jest.mock('../ui-zoom', () => ({
  ...jest.requireActual<typeof UiZoomModule>('../ui-zoom'),
  applyUiZoomToAllWindows: (factor: number): void => {
    mockEvents.push(`zoom:${factor}`);
  },
}));

jest.mock('../../power/wake-lock-service', () => ({
  ...jest.requireActual<typeof WakeLockServiceModule>(
    '../../power/wake-lock-service',
  ),
  getWakeLockService: (): { setEnabled(enabled: boolean): void } => ({
    setEnabled: (enabled: boolean): void => {
      mockEvents.push(`keep-awake:${String(enabled)}`);
    },
  }),
}));

jest.mock('../../lifecycle/background-presence', () => ({
  ...jest.requireActual<typeof BackgroundPresenceModule>(
    '../../lifecycle/background-presence',
  ),
  setCloseToTrayPreference: (enabled: boolean): void => {
    mockEvents.push(`tray:${String(enabled)}`);
  },
  syncActivationTray: (): boolean => true,
}));

jest.mock('../../notifications/campaigns/scheduler', () => ({
  ...jest.requireActual<typeof SchedulerModule>(
    '../../notifications/campaigns/scheduler',
  ),
  requestActivationRecompute: (): void => {
    mockEvents.push('schedule');
  },
}));

jest.mock('../../agents/ai-credits-routing', () => ({
  ...jest.requireActual<typeof AiCreditsRoutingModule>(
    '../../agents/ai-credits-routing',
  ),
  setAiCreditsRoutingModeCache: (mode: string): void => {
    mockEvents.push(`ai-credits:${mode}`);
  },
}));

// The save-only effects (CAN-7982), each at the host module beneath it.
function mockRecorded<Module extends object>(
  actual: Module,
  overrides: Partial<Module>,
): Module {
  return { ...actual, ...overrides };
}
jest.mock('../../agents/delegation/service', () =>
  mockRecorded(
    jest.requireActual<typeof DelegationServiceModule>(
      '../../agents/delegation/service',
    ),
    {
      updateManagedDelegationPolicy: (mode: string): Promise<void> => {
        mockEvents.push(`delegation:${mode}`);
        return Promise.resolve();
      },
    },
  ),
);
jest.mock('../../agents/delegation/lifetime-status', () =>
  mockRecorded(
    jest.requireActual<typeof LifetimeStatusModule>(
      '../../agents/delegation/lifetime-status',
    ),
    {
      notifyManagedDelegationLifetimePreferencesChanged: (): void => {
        mockEvents.push('lifetime');
      },
    },
  ),
);
jest.mock('../../services/personal-catalog-sync-host', () =>
  mockRecorded(
    jest.requireActual<typeof PersonalCatalogModule>(
      '../../services/personal-catalog-sync-host',
    ),
    {
      personalCatalogPreferenceChanged: (): Promise<void> => {
        mockEvents.push('personal-catalog');
        return Promise.resolve();
      },
    },
  ),
);
// Loaded only by its effect; the real module graph needs an ESM transform.
jest.mock('../../copilot/connection', () => ({
  revokeCopilotRuntimes: (): Promise<void> => {
    mockEvents.push('copilot-revoke');
    return mockFailures.copilotRevoke
      ? Promise.reject(new Error('revoke failed'))
      : Promise.resolve();
  },
}));
jest.mock('../../ipc/account-proxy', () =>
  mockRecorded(
    jest.requireActual<typeof AccountProxyIpcModule>('../../ipc/account-proxy'),
    {
      notifyAccountProxyPreferencesChanged: (): void => {
        mockEvents.push('account-proxy');
      },
    },
  ),
);
jest.mock('../../opencode/connection', () =>
  mockRecorded(
    jest.requireActual<typeof OpenCodeConnectionModule>(
      '../../opencode/connection',
    ),
    {
      revokeOpenCodeRuntimes: (): Promise<void> => {
        mockEvents.push('opencode-revoke');
        return Promise.resolve();
      },
    },
  ),
);
// Loaded only by its effect; the real module graph needs an ESM transform.
jest.mock('../../cursor/models', () => ({
  invalidateCursorModels: (): Promise<void> => {
    mockEvents.push('cursor-invalidate');
    return Promise.resolve();
  },
}));
jest.mock('../../cursor/runtime-availability', () =>
  mockRecorded(
    jest.requireActual<typeof CursorAvailabilityModule>(
      '../../cursor/runtime-availability',
    ),
    {
      refreshCursorRuntimeAvailability: (): Promise<boolean> => {
        mockEvents.push('cursor-refresh');
        return Promise.resolve(true);
      },
    },
  ),
);
jest.mock('../../models/model-registry', () =>
  mockRecorded(
    jest.requireActual<typeof ModelRegistryModule>(
      '../../models/model-registry',
    ),
    {
      broadcastModelRegistryUpdated: (): void => {
        mockEvents.push('model-registry');
      },
    },
  ),
);
jest.mock('../../plugins/plugin-defaults-revision', () =>
  mockRecorded(
    jest.requireActual<typeof PluginDefaultsRevisionModule>(
      '../../plugins/plugin-defaults-revision',
    ),
    {
      bumpGlobalPluginDefaultsRevision: (): void => {
        mockEvents.push('plugin-defaults');
      },
    },
  ),
);
jest.mock('../../services/desktop-inventory-sync-signals', () =>
  mockRecorded(
    jest.requireActual<typeof InventorySignalsModule>(
      '../../services/desktop-inventory-sync-signals',
    ),
    {
      notifyDesktopInventoryChanged: (kinds: readonly string[]): void => {
        mockEvents.push(`inventory:${kinds.join(',')}`);
      },
    },
  ),
);
jest.mock('../desktop-telemetry', () =>
  mockRecorded(
    jest.requireActual<typeof DesktopTelemetryModule>('../desktop-telemetry'),
    {
      recordOnboardingProfileTelemetry: (options: {
        previous: { profileRole?: string };
        next: { profileRole?: string };
      }): void => {
        if (options.previous.profileRole !== options.next.profileRole)
          mockEvents.push(`onboarding-telemetry:${options.next.profileRole}`);
      },
    },
  ),
);
jest.mock('../../services/onboarding-profile-sync-service', () => {
  const actual = jest.requireActual<typeof OnboardingSyncModule>(
    '../../services/onboarding-profile-sync-service',
  );
  return mockRecorded(actual, {
    syncOnboardingProfilePreferences: (
      preferences: PreferencesData,
      changed?: Partial<PreferencesData>,
    ): Promise<void> => {
      const fields = Object.keys(
        actual.buildOnboardingProfilePatch(preferences, changed),
      );
      if (fields.includes('profileRole')) mockEvents.push('onboarding-sync');
      return Promise.resolve();
    },
  });
});
jest.mock('../code-graph-availability', () =>
  mockRecorded(
    jest.requireActual<typeof CodeGraphAvailabilityModule>(
      '../code-graph-availability',
    ),
    {
      reconcileCodeGraphAvailability: (): Promise<void> => {
        mockEvents.push('code-graph');
        return Promise.resolve();
      },
    },
  ),
);

interface ShortcutConfig {
  enabled: boolean;
  accelerator: string;
}
const mockShortcut: {
  refused: Set<string>;
  active: string | null;
  // Runs inside the next apply, as a newer choice landing during the re-sync.
  duringApply: (() => void) | null;
} = { refused: new Set(), active: null, duringApply: null };
jest.mock('../../lifecycle/global-focus-shortcut', () => ({
  ...jest.requireActual<typeof GlobalFocusShortcutModule>(
    '../../lifecycle/global-focus-shortcut',
  ),
  tryGetGlobalFocusShortcutService: (): {
    apply(config: ShortcutConfig): { ok: boolean };
    getActiveAccelerator(): string | null;
  } => ({
    apply: (config) => {
      mockEvents.push(`shortcut:${config.accelerator}`);
      const during = mockShortcut.duringApply;
      mockShortcut.duringApply = null;
      during?.();
      return { ok: !mockShortcut.refused.has(config.accelerator) };
    },
    getActiveAccelerator: () => mockShortcut.active,
  }),
}));

jest.mock('../../browser/default-browser-registration', () => ({
  ...jest.requireActual<typeof DefaultBrowserRegistrationModule>(
    '../../browser/default-browser-registration',
  ),
  getDefaultBrowserRegistrationService: (): {
    apply(request: { enabled: boolean }): Promise<unknown>;
  } => ({
    apply: (request) => {
      mockEvents.push(`browser:${String(request.enabled)}`);
      return Promise.resolve({ registered: request.enabled });
    },
  }),
}));

import { nativeTheme } from 'electron';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import type * as PathsModule from '../paths';
import type * as PreferencesBroadcastModule from '../preferences-broadcast';
import type * as UiZoomModule from '../ui-zoom';
import type * as WakeLockServiceModule from '../../power/wake-lock-service';
import type * as BackgroundPresenceModule from '../../lifecycle/background-presence';
import type * as SchedulerModule from '../../notifications/campaigns/scheduler';
import type * as GlobalFocusShortcutModule from '../../lifecycle/global-focus-shortcut';
import type * as DefaultBrowserRegistrationModule from '../../browser/default-browser-registration';
import type * as AiCreditsRoutingModule from '../../agents/ai-credits-routing';
import type * as PreferencesStoreModule from '../preferences-store';
import type * as OneWindowSwitchModule from '../one-window-switch';
import type * as DelegationServiceModule from '../../agents/delegation/service';
import type * as LifetimeStatusModule from '../../agents/delegation/lifetime-status';
import type * as PersonalCatalogModule from '../../services/personal-catalog-sync-host';
import type * as AccountProxyIpcModule from '../../ipc/account-proxy';
import type * as OpenCodeConnectionModule from '../../opencode/connection';
import type * as CursorAvailabilityModule from '../../cursor/runtime-availability';
import type * as ModelRegistryModule from '../../models/model-registry';
import type * as PluginDefaultsRevisionModule from '../../plugins/plugin-defaults-revision';
import type * as InventorySignalsModule from '../../services/desktop-inventory-sync-signals';
import type * as DesktopTelemetryModule from '../desktop-telemetry';
import type * as OnboardingSyncModule from '../../services/onboarding-profile-sync-service';
import type * as CodeGraphAvailabilityModule from '../code-graph-availability';
import * as store from '../preferences-store';
import { subscribeCommittedPreferences } from '../preferences-committed';
import { getUsageDataPolicy } from '../usage-data-policy';
import { getGlobalApprovalRulesRevision } from '../../approvals/rule-revisions';
import { getAppAdvisorProjectAgentAccessSnapshot } from '../app-advisor-project-agent-access';
import { resetCodeGraphAvailabilityForTests } from '../code-graph-availability';
import {
  registerPreferenceHandlers,
  savePreferencesPatch,
} from '../../ipc/preferences';

const SAVED_CHORD = 'CommandOrControl+Shift+Space';
const ACCEPTED_CHORD = 'CommandOrControl+Alt+F12';
const REFUSED_CHORD = 'CommandOrControl+Alt+F13';
const NEWER_CHORD = 'CommandOrControl+Alt+F14';
const DISABLED_ITEM = JSON.stringify(['v1', 'collection', 'example']);

const EFFECT_PREFIXES = [
  'published',
  'installed-items',
  'keep-awake:',
  'tray:',
  'schedule',
  'shortcut:',
  'browser:',
  'broadcast:',
  'zoom:',
  'ai-credits:',
];
function effects(): string[] {
  return mockEvents.filter((event) =>
    EFFECT_PREFIXES.some((prefix) => event.startsWith(prefix)),
  );
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

let dir = '';
let stopPublished: () => void = () => undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'preference-commit-effects-'));
  mockPreferencesFilePath = path.join(dir, 'preferences.json');
  mockShortcut.refused = new Set();
  mockShortcut.active = SAVED_CHORD;
  mockShortcut.duringApply = null;
  // Main's cached Code Graph choice follows each test's fresh file.
  resetCodeGraphAvailabilityForTests();
  registerPreferenceHandlers();
  await store.updatePreferencesFile(() => ({
    keepSystemAwakeWhileAgentsActive: true,
    closeToTray: true,
    globalFocusShortcutEnabled: true,
    globalFocusShortcut: SAVED_CHORD,
    useAsSystemDefaultBrowser: false,
    uiScale: 100,
    colorMode: 'system',
  }));
  await store.flushPreferencesWrites();
  await settle();
  stopPublished = subscribeCommittedPreferences(() => {
    mockEvents.push('published');
  });
  mockEvents.length = 0;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  stopPublished();
  await store.flushPreferencesWrites().catch(() => undefined);
  store.stopPreferencesGenerationStamp();
  jest.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('an own save applies its commit effects in order', () => {
  it('publishes in commit order, then the window hears of it, then the native effects follow', async () => {
    await savePreferencesPatch({
      keepSystemAwakeWhileAgentsActive: false,
      closeToTray: false,
      promotionalNotifications: (await store.readPreferencesFile())
        .promotionalNotifications,
      globalFocusShortcut: ACCEPTED_CHORD,
      useAsSystemDefaultBrowser: true,
    });
    await settle();
    expect(effects()).toEqual([
      'published',
      'browser:true',
      `broadcast:${ACCEPTED_CHORD}`,
      'keep-awake:false',
      'tray:false',
      'schedule',
      `shortcut:${ACCEPTED_CHORD}`,
    ]);
  });

  it('an internal writer settles the commit before publishing it', async () => {
    await store.updatePreferencesFile(() => ({
      disabledInstalledItems: [DISABLED_ITEM],
    }));
    await settle();
    expect(effects()).toEqual(['installed-items', 'published']);
  });

  it('a save that names a key keeps its effect even when the value is unchanged', async () => {
    await savePreferencesPatch({
      useAsSystemDefaultBrowser: false,
      globalFocusShortcut: SAVED_CHORD,
    });
    await settle();
    expect(effects()).toEqual([
      'published',
      'browser:false',
      `broadcast:${SAVED_CHORD}`,
      'keep-awake:true',
      'tray:true',
      `shortcut:${SAVED_CHORD}`,
    ]);
  });

  it('applies the stored usage-data choice once per commit', async () => {
    const setStored = jest.spyOn(getUsageDataPolicy(), 'setStored');
    await savePreferencesPatch({ fileAutoSave: true });
    expect(setStored).toHaveBeenCalledTimes(1);
    // A client-local save has no domain commit; the save still applies it.
    await savePreferencesPatch({ sidebarWidth: 300 });
    expect(setStored).toHaveBeenCalledTimes(2);
  });
});

describe('a foreign commit applies the same effects, gated on its changed keys', () => {
  async function foreignCommit(
    revision: number,
    patch: Partial<PreferencesData>,
  ): Promise<void> {
    const previous = await store.readPreferencesFile();
    await store.applyForeignPreferenceCommit({
      revision,
      previous,
      next: { ...previous, ...patch },
      changedKeys: new Set(Object.keys(patch)),
    });
    await settle();
  }

  it('re-syncs keep-awake, close-to-tray and the focus shortcut, and nothing it did not change', async () => {
    await foreignCommit(1, {
      keepSystemAwakeWhileAgentsActive: false,
      closeToTray: false,
      globalFocusShortcut: ACCEPTED_CHORD,
      disabledInstalledItems: [DISABLED_ITEM],
    });
    expect(effects()).toEqual([
      'installed-items',
      'published',
      `broadcast:${ACCEPTED_CHORD}`,
      'keep-awake:false',
      'tray:false',
      `shortcut:${ACCEPTED_CHORD}`,
    ]);

    mockEvents.length = 0;
    await foreignCommit(2, { fileAutoSave: true });
    // The file never saw the first commit: it was another client's.
    expect(effects()).toEqual(['published', `broadcast:${SAVED_CHORD}`]);
  });

  it('applies the commit consequences an own save applies around its write', async () => {
    const rulesRevision = getGlobalApprovalRulesRevision();
    const copilot: string[] = [];
    const stopCopilot = store.observeCopilotSelectionAuthority((change) => {
      copilot.push(change.kind);
    });
    await foreignCommit(3, {
      globalApprovalRules: [
        {
          id: 'foreign-rule',
          behavior: 'deny',
          target: { kind: 'network', host: 'example.com' },
          createdAt: '2026-11-26T00:00:00.000Z',
          origin: 'settings',
        },
      ],
      copilotVaultSelection: null,
      appAdvisorProjectAgentAccess: { mode: 'disabled', selectedOwners: [] },
      aiCreditsRoutingMode: 'on',
    });
    stopCopilot();
    expect(getGlobalApprovalRulesRevision()).toBeGreaterThan(rulesRevision);
    expect(copilot).toEqual(['changing']);
    expect(getAppAdvisorProjectAgentAccessSnapshot().mode).toBe('disabled');
    expect(effects()).toEqual([
      'published',
      `broadcast:${SAVED_CHORD}`,
      'ai-credits:on',
    ]);
  });

  it('applies each revision once', async () => {
    await foreignCommit(5, { keepSystemAwakeWhileAgentsActive: false });
    mockEvents.length = 0;
    await foreignCommit(5, { keepSystemAwakeWhileAgentsActive: false });
    await foreignCommit(4, { closeToTray: false });
    expect(effects()).toEqual([]);
  });

  it('never drives the client-local zoom or theme', async () => {
    nativeTheme.themeSource = 'system';
    await foreignCommit(9, { uiScale: 150, colorMode: 'dark' });
    expect(effects()).toEqual(['published', `broadcast:${SAVED_CHORD}`]);
    expect(nativeTheme.themeSource).toBe('system');
  });
});

describe('the corrective focus-shortcut write', () => {
  it('writes the working chord back when the stored one was refused', async () => {
    mockShortcut.refused = new Set([REFUSED_CHORD]);
    await savePreferencesPatch({ globalFocusShortcut: REFUSED_CHORD });
    await settle();
    expect((await store.readPreferencesFile()).globalFocusShortcut).toBe(
      SAVED_CHORD,
    );
    expect(
      effects().filter(
        (event) =>
          event.startsWith('shortcut:') || event.startsWith('broadcast:'),
      ),
    ).toEqual([
      `broadcast:${REFUSED_CHORD}`,
      `shortcut:${REFUSED_CHORD}`,
      `broadcast:${SAVED_CHORD}`,
      `shortcut:${SAVED_CHORD}`,
    ]);
  });

  it('never overwrites a newer choice that landed first', async () => {
    mockShortcut.refused = new Set([REFUSED_CHORD]);
    let newer: Promise<unknown> = Promise.resolve();
    mockShortcut.duringApply = (): void => {
      newer = store.updatePreferencesFile(() => ({
        globalFocusShortcut: NEWER_CHORD,
      }));
    };
    await savePreferencesPatch({ globalFocusShortcut: REFUSED_CHORD });
    await newer;
    await settle();
    expect((await store.readPreferencesFile()).globalFocusShortcut).toBe(
      NEWER_CHORD,
    );
    expect(effects()).not.toContain(`broadcast:${SAVED_CHORD}`);
    expect(effects()).not.toContain(`shortcut:${SAVED_CHORD}`);
  });

  it('a foreign commit corrects only while the refused chord is still stored', async () => {
    await store.updatePreferencesFile(() => ({
      globalFocusShortcut: NEWER_CHORD,
    }));
    mockShortcut.refused = new Set([REFUSED_CHORD]);
    mockEvents.length = 0;
    const previous = await store.readPreferencesFile();
    await store.applyForeignPreferenceCommit({
      revision: 20,
      previous,
      next: { ...previous, globalFocusShortcut: REFUSED_CHORD },
      changedKeys: new Set(['globalFocusShortcut']),
    });
    await settle();
    expect((await store.readPreferencesFile()).globalFocusShortcut).toBe(
      NEWER_CHORD,
    );
    expect(effects()).toEqual([
      'published',
      `broadcast:${REFUSED_CHORD}`,
      `shortcut:${REFUSED_CHORD}`,
    ]);
  });
});

describe('client-local commits', () => {
  it('a client-local-only commit fires no domain effects', async () => {
    const setStored = jest.spyOn(getUsageDataPolicy(), 'setStored');
    await store.updatePreferencesFile(() => ({ sidebarWidth: 300 }));
    await settle();
    expect(effects()).toEqual([]);
    expect(setStored).not.toHaveBeenCalled();
  });

  it('a client-local save applies its zoom and theme, and publishes nothing', async () => {
    nativeTheme.themeSource = 'system';
    await savePreferencesPatch({ uiScale: 150, colorMode: 'dark' });
    await settle();
    expect(effects()).toEqual(
      ['zoom:1.5', 'broadcast:', 'keep-awake:true', 'tray:true'].map((event) =>
        event === 'broadcast:' ? `broadcast:${SAVED_CHORD}` : event,
      ),
    );
    expect(nativeTheme.themeSource).toBe('dark');
  });
});

describe('a latched recovery', () => {
  it('turns the one-window switch off and tells the windows once, publishing nothing', async () => {
    // A damaged primary with no last-good to recover from.
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir);
    await writeFile(mockPreferencesFilePath, '{ damaged');
    let latched: typeof PreferencesStoreModule | undefined;
    let oneWindow: typeof OneWindowSwitchModule | undefined;
    await jest.isolateModulesAsync(async () => {
      latched = await import('../preferences-store');
      oneWindow = await import('../one-window-switch');
    });
    if (!latched || !oneWindow) throw new Error('the store did not load');
    oneWindow.applyOneWindowChoice(true, false);
    const switched: boolean[] = [];
    oneWindow.onOneWindowEnabledChanged((enabled) => switched.push(enabled));
    mockEvents.length = 0;

    await latched.readPreferencesFile();
    expect(latched.arePreferencesUnconfirmed()).toBe(true);
    expect(switched).toEqual([false]);
    expect(effects()).toEqual(['broadcast:changed']);
    await latched.flushPreferencesWrites();
    latched.stopPreferencesGenerationStamp();
  });
});

const SAVE_ONLY_PREFIXES = [
  'delegation:',
  'lifetime',
  'personal-catalog',
  'copilot-revoke',
  'account-proxy',
  'opencode-revoke',
  'cursor-',
  'model-registry',
  'plugin-defaults',
  'inventory:',
  'onboarding-',
  'code-graph',
  'crash-resume',
];
function saveOnlyEffects(): string[] {
  return mockEvents.filter((event) =>
    SAVE_ONLY_PREFIXES.some((prefix) => event.startsWith(prefix)),
  );
}

const PROVIDER_PATCH: Partial<PreferencesData> = {
  managedDelegationMode: 'proactive',
  managedDelegationLifetimeLimit: 5,
  personalWorkspaceCatalogSync: 'private',
  accountProxyRouteClaude: false,
  opencodeEnabled: true,
  cursorEnabled: true,
  profileRole: 'designer',
  codeGraph: {
    mode: 'disabled',
    selectedWorkspaceIds: [],
    generationTimeoutMinutes: 30,
  },
};
const PROVIDER_EFFECTS = [
  'delegation:proactive',
  'lifetime',
  'personal-catalog',
  'account-proxy',
  'opencode-revoke',
  'model-registry',
  'cursor-refresh',
  'model-registry',
  'onboarding-telemetry:designer',
  'onboarding-sync',
  'code-graph',
];
const PLUGIN_SELECTIONS: PreferencesData['globalPluginSelections'] = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [{ marketplaceId: 'acme', pluginName: 'example' }],
};

// The revision claim is process-wide: each commit here takes a newer one.
let lastForeignRevision = 100;
async function applyForeign(
  patch: Partial<PreferencesData>,
  revision = ++lastForeignRevision,
): Promise<void> {
  const previous = await store.readPreferencesFile();
  await store.applyForeignPreferenceCommit({
    revision,
    previous,
    next: { ...previous, ...patch },
    changedKeys: new Set(Object.keys(patch)),
  });
  await settle();
}

describe('the save-only effects (CAN-7982)', () => {
  it('an own save applies them, gated as before', async () => {
    await savePreferencesPatch(PROVIDER_PATCH);
    await settle();
    expect(saveOnlyEffects()).toEqual(PROVIDER_EFFECTS);

    mockEvents.length = 0;
    await savePreferencesPatch({ globalPluginSelections: PLUGIN_SELECTIONS });
    await savePreferencesPatch({ globalPluginSelections: PLUGIN_SELECTIONS });
    await savePreferencesPatch({ usageData: { errorReports: true } });
    await settle();
    // The unchanged selections fire nothing; an opt-in resumes crash reports.
    expect(saveOnlyEffects()).toEqual([
      'plugin-defaults',
      'inventory:installed_items',
      'crash-resume',
    ]);
  });

  it('a foreign commit applies them, gated on its changed keys', async () => {
    await applyForeign(PROVIDER_PATCH);
    expect(saveOnlyEffects()).toEqual(PROVIDER_EFFECTS);

    await savePreferencesPatch({ usageData: { errorReports: false } });
    await settle();
    mockEvents.length = 0;
    const previous = await store.readPreferencesFile();
    await applyForeign({
      copilotEnabled: true,
      cursorEnabled: false,
      globalPluginSelections: PLUGIN_SELECTIONS,
      usageData: { ...previous.usageData, errorReports: true },
    });
    expect(saveOnlyEffects()).toEqual([
      'crash-resume',
      'copilot-revoke',
      'model-registry',
      'cursor-invalidate',
      'cursor-refresh',
      'model-registry',
      'plugin-defaults',
      'inventory:installed_items',
    ]);
  });

  it('a foreign commit fires none of them for keys it did not change', async () => {
    await applyForeign({ fileAutoSave: true });
    expect(saveOnlyEffects()).toEqual([]);
  });

  it('applies each foreign revision once', async () => {
    await applyForeign({ opencodeEnabled: true });
    expect(saveOnlyEffects()).toEqual(['opencode-revoke', 'model-registry']);
    mockEvents.length = 0;
    await applyForeign({ opencodeEnabled: true }, lastForeignRevision);
    await applyForeign({ cursorEnabled: true }, lastForeignRevision - 1);
    expect(saveOnlyEffects()).toEqual([]);
    expect(effects()).toEqual([]);
  });

  it('a foreign commit reconciles Code Graph only when the effective choice changed', async () => {
    const codeGraph = {
      mode: 'enabled' as const,
      selectedWorkspaceIds: [],
      generationTimeoutMinutes: 45,
    };
    await applyForeign({ codeGraph });
    expect(saveOnlyEffects()).toEqual([]);
    await applyForeign({ codeGraph: { ...codeGraph, mode: 'disabled' } });
    expect(saveOnlyEffects()).toEqual(['code-graph']);
  });

  it('a foreign delegation mode change broadcasts once, after its policy settles', async () => {
    await applyForeign({ managedDelegationMode: 'off' });
    expect(
      mockEvents.filter(
        (event) =>
          event.startsWith('delegation:') || event.startsWith('broadcast:'),
      ),
    ).toEqual(['delegation:off', `broadcast:${SAVED_CHORD}`]);
  });

  it("a failed provider effect still applies the foreign commit's host effects", async () => {
    mockFailures.copilotRevoke = true;
    try {
      await applyForeign({
        copilotEnabled: true,
        keepSystemAwakeWhileAgentsActive: false,
      });
    } finally {
      mockFailures.copilotRevoke = false;
    }
    expect(effects()).toEqual([
      'published',
      `broadcast:${SAVED_CHORD}`,
      'keep-awake:false',
    ]);
  });

  it('a foreign commit applies the native effects of the internal writers of its keys', async () => {
    const previous = await store.readPreferencesFile();
    await applyForeign({
      osNotifications: { ...previous.osNotifications, enabled: true },
    });
    expect(effects()).toContain('schedule');
  });
});
