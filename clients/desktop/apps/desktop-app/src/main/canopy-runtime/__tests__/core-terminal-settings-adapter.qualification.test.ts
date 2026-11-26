import type * as Crypto from 'node:crypto';
import { createCanopyDispatcher } from '@canopy/core-runtime';
import {
  CORE_TERMINAL_SETTINGS_QUERIES,
  CORE_TERMINAL_SETTINGS_INSTRUCTIONS,
} from '@canopy/protocol/canopy-core';
import {
  createPreferencesRepository,
  type PreferencesDocument,
  type PreferencesDocumentSlot,
  type PreferencesRepository,
} from '@canopy/core-runtime/node/preferences';
import type { TerminalSettingsStore } from '@canopy/core-runtime/node/terminal';
import type {
  CoreTerminalPreset,
  CoreTerminalSettingsUpdateParams,
} from '@canopy/protocol/canopy-core';
import {
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
  resolveKnownModel,
} from '@canopy/desktop-shared/types';
import { DESKTOP_PREFERENCES_CODEC } from '@canopy/desktop-shared/node/preferences/desktop-preferences-codec';
import type { DomainPreferencesData } from '@canopy/desktop-shared/node/preferences/client-local-preferences';
import { installPreferencesNormalizationEnvironment } from '@canopy/desktop-shared/node/preferences/normalization-environment';
import {
  createDesktopTerminalSettingsStore,
  createCoreTerminalSettingsAdapter,
  terminalPresetImageArtifactId,
  withStagedTerminalPresetImages,
} from '../core-terminal-settings-adapter';
import {
  TerminalPresetIconMissingError,
  TerminalSettingsUnavailableError,
} from '@canopy/core-runtime/node/terminal';

class MemoryDocument implements PreferencesDocument {
  readonly key = 'terminal-settings';
  readonly slots = new Map<PreferencesDocumentSlot, string>();
  readonly installs: {
    slot: PreferencesDocumentSlot | 'backup';
    content: string;
  }[] = [];
  readonly backups = new Map<string, string>();
  exists(slot: 'primary' | 'lastGood'): Promise<boolean> {
    return Promise.resolve(this.slots.has(slot));
  }
  ensureFolder(): Promise<void> {
    return Promise.resolve();
  }
  slotPath(slot: PreferencesDocumentSlot): string {
    return `${this.key}/${slot}`;
  }
  backupLocation(stamp: string): string {
    return `${this.key}/backup-${stamp}`;
  }
  installBackup(location: string, content: string): Promise<void> {
    this.installs.push({ slot: 'backup', content });
    this.backups.set(location, content);
    return Promise.resolve();
  }
  pruneBackups(): Promise<void> {
    while (this.backups.size > 5) {
      const oldest = this.backups.keys().next().value;
      if (oldest === undefined) break;
      this.backups.delete(oldest);
    }
    return Promise.resolve();
  }
  readText(slot: PreferencesDocumentSlot): Promise<string> {
    const value = this.slots.get(slot);
    if (value === undefined)
      return Promise.reject(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
    return Promise.resolve(value);
  }
  install(slot: PreferencesDocumentSlot, content: string): Promise<void> {
    this.installs.push({ slot, content });
    this.slots.set(slot, content);
    return Promise.resolve();
  }
}

function storedPresetIcon(doc: MemoryDocument): unknown {
  const primary: unknown = JSON.parse(doc.slots.get('primary') ?? '');
  if (
    typeof primary !== 'object' ||
    primary === null ||
    !('preferences' in primary)
  )
    throw new Error('Missing stored preferences.');
  const preferences = primary.preferences;
  if (
    typeof preferences !== 'object' ||
    preferences === null ||
    !('terminalPresets' in preferences) ||
    !Array.isArray(preferences.terminalPresets)
  )
    throw new Error('Missing stored presets.');
  const preset: unknown = preferences.terminalPresets[0];
  if (typeof preset !== 'object' || preset === null || !('icon' in preset))
    throw new Error('Missing stored icon.');
  return preset.icon;
}

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const PNG2 = 'data:image/png;base64,iVBORw0KGgoAAA==';
const preset: CoreTerminalPreset = {
  presetId: 'a',
  name: 'Build',
  profileId: 'default',
  command: 'make',
  enabled: true,
  icon: null,
};
const next = { disabledProfileIds: ['bash'] as const, presets: [preset] };
function fixture(): {
  doc: MemoryDocument;
  repo: PreferencesRepository<DomainPreferencesData>;
  store: TerminalSettingsStore;
} {
  const doc = new MemoryDocument();
  const repo = createPreferencesRepository({
    document: () => doc,
    codec: DESKTOP_PREFERENCES_CODEC,
    log: { error: jest.fn() },
  });
  const store = createDesktopTerminalSettingsStore({
    readAuthority: () => repo.readAuthority(),
    update: (u) => repo.update(u),
  });
  return { doc, repo, store };
}

describe('desktop terminal settings store (CAN-4148)', () => {
  beforeEach(() => {
    initClaudeModels([
      { id: 'opus[1m]', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
    ]);
    initCodexModels([{ id: 'gpt-6.1-sol', label: 'Codex default' }]);
    initOllamaModels([
      {
        id: 'ollama-qwen3-coder',
        rawModelId: 'qwen3-coder',
        label: 'qwen3-coder',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    installPreferencesNormalizationEnvironment({
      resolveAvailableModel: (model) =>
        typeof model === 'string' ? (resolveKnownModel(model) ?? null) : null,
      ollamaEnabled: () => false,
      shortcutPlatform: () => 'darwin',
    });
  });

  it('commits shells and presets through the preference queue and moves the revision once', async () => {
    const { doc, repo, store } = fixture();
    expect(await store.read()).toEqual({
      revision: 0,
      disabledProfileIds: [],
      presets: [],
    });
    await expect(store.replace(0, next)).resolves.toEqual({
      outcome: 'replaced',
      settings: { revision: 1, ...next },
    });
    const primary: unknown = JSON.parse(doc.slots.get('primary') ?? '');
    expect(primary).toMatchObject({
      preferences: {
        terminalSettingsRevision: 1,
        terminalPresets: [{ id: preset.presetId }],
      },
    });
    await repo.flush();
  });

  it('refuses a stale revision without writing', async () => {
    const { doc, repo, store } = fixture();
    await store.replace(0, next);
    await repo.flush();
    const installs = doc.installs.length;
    await expect(
      store.replace(0, { disabledProfileIds: [], presets: [] }),
    ).resolves.toEqual({
      outcome: 'conflict',
      settings: { revision: 1, ...next },
    });
    expect(doc.installs).toHaveLength(installs);
  });

  it('a concurrent generic save neither moves the revision nor loses the presets', async () => {
    const { repo, store } = fixture();
    await Promise.all([
      store.replace(0, next),
      repo.update(() => ({ fileAutoSave: true })),
    ]);
    await expect(repo.read('persisted')).resolves.toMatchObject({
      terminalSettingsRevision: 1,
      fileAutoSave: true,
      terminalPresets: [{ id: preset.presetId }],
    });
    await repo.flush();
  });

  it('keeps a stored image by artifact id, adds a staged image and refuses an unknown id', async () => {
    const { doc, repo, store } = fixture();
    await repo.update(() => ({
      terminalPresets: [
        {
          id: 'a',
          name: 'Build',
          terminalProfileId: 'default',
          command: 'make',
          enabled: true,
          icon: { kind: 'image', lightDataUrl: PNG },
        },
      ],
    }));
    const settings = await store.read();
    expect(settings.presets[0]?.icon).toEqual({
      kind: 'image',
      lightArtifactId: terminalPresetImageArtifactId(PNG),
      darkArtifactId: null,
    });
    const storedImage: CoreTerminalPreset = {
      ...preset,
      icon: {
        kind: 'image',
        lightArtifactId: terminalPresetImageArtifactId(PNG),
        darkArtifactId: null,
      },
    };
    await store.replace(settings.revision, {
      disabledProfileIds: [],
      presets: [storedImage],
    });
    expect(storedPresetIcon(doc)).toEqual({ kind: 'image', lightDataUrl: PNG });
    const revision = (await store.read()).revision;
    await withStagedTerminalPresetImages([PNG2], () =>
      store.replace(revision, {
        disabledProfileIds: [],
        presets: [
          {
            ...storedImage,
            icon: {
              kind: 'image',
              lightArtifactId: terminalPresetImageArtifactId(PNG),
              darkArtifactId: terminalPresetImageArtifactId(PNG2),
            },
          },
        ],
      }),
    );
    expect(storedPresetIcon(doc)).toEqual({
      kind: 'image',
      lightDataUrl: PNG,
      darkDataUrl: PNG2,
    });
    await repo.flush();
    const installs = doc.installs.length;
    await expect(
      store.replace((await store.read()).revision, {
        disabledProfileIds: [],
        presets: [
          {
            ...preset,
            icon: {
              kind: 'image',
              lightArtifactId: `terminal-preset-image:sha256:${'0'.repeat(64)}`,
              darkArtifactId: null,
            },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(TerminalPresetIconMissingError);
    expect(doc.installs).toHaveLength(installs);
  });

  it('never commits a settings update cancelled while waiting in the preference queue', async () => {
    const { repo } = fixture();
    let release = (): void => undefined;
    let began = (): void => undefined;
    let queued = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const blocker = repo.update(async () => {
      began();
      await gate;
      return { fileAutoSave: true };
    });
    await started;
    const store = createDesktopTerminalSettingsStore({
      readAuthority: () => repo.readAuthority(),
      update: (updater) => {
        const pending = repo.update(updater);
        queued();
        return pending;
      },
    });
    const dispatcher = createCanopyDispatcher({
      profile: 'core',
      definitions: {
        queries: CORE_TERMINAL_SETTINGS_QUERIES,
        instructions: CORE_TERMINAL_SETTINGS_INSTRUCTIONS,
        streams: {},
      },
      handlers: { ...createCoreTerminalSettingsAdapter(store), streams: {} },
    });
    const controller = new AbortController();
    try {
      const update = dispatcher.instruction(
        'core.terminal.settings.update',
        {
          scope: {},
          expectedRevision: 0,
          disabledProfileIds: ['bash'],
          presets: [preset],
          _meta: { idempotencyKey: 'cancel-queued' },
        },
        {
          caller: {
            principalId: 'user',
            clientInstanceId: 'client',
            authorityId: 'desktop',
            interfaceKind: 'test',
            grants: ['core.config.write'],
          },
          metadata: { idempotencyKey: 'cancel-queued' },
          signal: controller.signal,
        },
      );
      await waiting;
      controller.abort();
      await expect(update).rejects.toMatchObject({
        payload: { kind: 'cancelled' },
      });
      release();
      await blocker;
      await repo.flush();
      await expect(store.read()).resolves.toEqual({
        revision: 0,
        disabledProfileIds: [],
        presets: [],
      });
    } finally {
      release();
      await blocker;
      await repo.flush();
      await dispatcher.shutdown();
    }
  });

  it('retries a cancelled queued update with the same idempotency key instead of replaying a non-write', async () => {
    const { repo } = fixture();
    let release = (): void => undefined;
    let began = (): void => undefined;
    let queued = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const blocker = repo.update(async () => {
      began();
      await gate;
      return { fileAutoSave: true };
    });
    await started;
    const store = createDesktopTerminalSettingsStore({
      readAuthority: () => repo.readAuthority(),
      update: (updater) => {
        const pending = repo.update(updater);
        queued();
        return pending;
      },
    });
    const dispatcher = createCanopyDispatcher({
      profile: 'core',
      definitions: {
        queries: CORE_TERMINAL_SETTINGS_QUERIES,
        instructions: CORE_TERMINAL_SETTINGS_INSTRUCTIONS,
        streams: {},
      },
      handlers: { ...createCoreTerminalSettingsAdapter(store), streams: {} },
    });
    const controller = new AbortController();
    const params: CoreTerminalSettingsUpdateParams = {
      scope: {},
      expectedRevision: 0,
      disabledProfileIds: ['bash'],
      presets: [preset],
      _meta: { idempotencyKey: 'retry-cancelled' },
    };
    const caller = {
      principalId: 'user',
      clientInstanceId: 'client',
      authorityId: 'desktop',
      interfaceKind: 'test' as const,
      grants: ['core.config.write' as const],
    };
    try {
      const first = dispatcher.instruction(
        'core.terminal.settings.update',
        params,
        { caller, metadata: params._meta, signal: controller.signal },
      );
      await waiting;
      controller.abort();
      await expect(first).rejects.toMatchObject({
        payload: { kind: 'cancelled' },
      });
      release();
      await blocker;
      await repo.flush();
      await expect(store.read()).resolves.toEqual({
        revision: 0,
        disabledProfileIds: [],
        presets: [],
      });
      await expect(
        dispatcher.instruction('core.terminal.settings.update', params, {
          caller,
          metadata: params._meta,
        }),
      ).resolves.toEqual({
        revision: 1,
        disabledProfileIds: ['bash'],
        presets: [preset],
      });
      await expect(store.read()).resolves.toEqual({
        revision: 1,
        disabledProfileIds: ['bash'],
        presets: [preset],
      });
    } finally {
      release();
      await blocker;
      await repo.flush();
      await dispatcher.shutdown();
    }
  });

  it('keeps a joined same-key retry retryable when the original queued update is cancelled', async () => {
    const { repo } = fixture();
    let release = (): void => undefined;
    let began = (): void => undefined;
    let queued = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const blocker = repo.update(async () => {
      began();
      await gate;
      return { fileAutoSave: true };
    });
    await started;
    const store = createDesktopTerminalSettingsStore({
      readAuthority: () => repo.readAuthority(),
      update: (updater) => {
        const pending = repo.update(updater);
        queued();
        return pending;
      },
    });
    const dispatcher = createCanopyDispatcher({
      profile: 'core',
      definitions: {
        queries: CORE_TERMINAL_SETTINGS_QUERIES,
        instructions: CORE_TERMINAL_SETTINGS_INSTRUCTIONS,
        streams: {},
      },
      handlers: { ...createCoreTerminalSettingsAdapter(store), streams: {} },
    });
    const controller = new AbortController();
    const params: CoreTerminalSettingsUpdateParams = {
      scope: {},
      expectedRevision: 0,
      disabledProfileIds: ['bash'],
      presets: [preset],
      _meta: { idempotencyKey: 'retry-cancelled' },
    };
    const caller = {
      principalId: 'user',
      clientInstanceId: 'client',
      authorityId: 'desktop',
      interfaceKind: 'test' as const,
      grants: ['core.config.write' as const],
    };
    try {
      const first = dispatcher.instruction(
        'core.terminal.settings.update',
        params,
        { caller, metadata: params._meta, signal: controller.signal },
      );
      await waiting;
      controller.abort();
      await expect(first).rejects.toMatchObject({
        payload: { kind: 'cancelled' },
      });
      const joined = dispatcher.instruction(
        'core.terminal.settings.update',
        params,
        { caller, metadata: params._meta },
      );
      const joinedOutcome = joined.then(
        (settings) => ({ ok: true as const, settings }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      release();
      await blocker;
      await repo.flush();
      await expect(joinedOutcome).resolves.toMatchObject({
        ok: false,
        error: {
          payload: {
            kind: 'unavailable',
            retry: { kind: 'same_idempotency_key' },
          },
        },
      });
      await expect(store.read()).resolves.toEqual({
        revision: 0,
        disabledProfileIds: [],
        presets: [],
      });
      await expect(
        dispatcher.instruction('core.terminal.settings.update', params, {
          caller,
          metadata: params._meta,
        }),
      ).resolves.toEqual({
        revision: 1,
        disabledProfileIds: ['bash'],
        presets: [preset],
      });
      await expect(store.read()).resolves.toEqual({
        revision: 1,
        disabledProfileIds: ['bash'],
        presets: [preset],
      });
    } finally {
      release();
      await blocker;
      await repo.flush();
      await dispatcher.shutdown();
    }
  });

  it('resolves stored image artifacts with linear hashing during replacement', async () => {
    const { repo, store } = fixture();
    const count = 50;
    await repo.update(() => ({
      terminalPresets: Array.from({ length: count }, (_, index) => ({
        id: `preset-${index}`,
        name: `Preset ${index}`,
        terminalProfileId: 'default',
        command: 'make',
        enabled: true,
        icon: {
          kind: 'image',
          lightDataUrl: `data:image/png;base64,${Buffer.from(`light-${index}`).toString('base64')}`,
          darkDataUrl: `data:image/png;base64,${Buffer.from(`dark-${index}`).toString('base64')}`,
        },
      })),
    }));
    const settings = await store.read();
    const crypto = jest.requireActual<typeof Crypto>('node:crypto');
    const hash = jest.spyOn(crypto, 'createHash');
    try {
      await expect(store.replace(settings.revision, settings)).resolves.toEqual(
        { outcome: 'replaced', settings },
      );
      expect(hash.mock.calls.length).toBeLessThanOrEqual(4 * count * 2);
    } finally {
      hash.mockRestore();
      await repo.flush();
    }
  });

  it('reports an unreadable record as unavailable', async () => {
    const { repo } = fixture();
    const store = createDesktopTerminalSettingsStore({
      readAuthority: async () => ({
        preferences: await repo.read('persisted'),
        authority: 'unreadable',
      }),
      update: (u) => repo.update(u),
    });
    await expect(store.read()).rejects.toBeInstanceOf(
      TerminalSettingsUnavailableError,
    );
  });
});
