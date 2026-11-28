import { createCanopyDispatcher } from '@canopy/core-runtime';
import {
  CORE_TERMINAL_SETTINGS_QUERIES,
  CORE_TERMINAL_SETTINGS_INSTRUCTIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  createPreferencesRepository,
  type PreferencesDocument,
  type PreferencesDocumentSlot,
  type PreferencesRepository,
} from '@canopy/core-runtime/node/preferences';
import type { TerminalSettingsStore } from '@canopy/core-runtime/node/terminal';
import {
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
  resolveKnownModel,
  type TerminalPreset,
  type UpdateTerminalSettingsRequest,
} from '@canopy/desktop-shared/types';
import { DESKTOP_PREFERENCES_CODEC } from '@canopy/desktop-shared/node/preferences/desktop-preferences-codec';
import type { DomainPreferencesData } from '@canopy/desktop-shared/node/preferences/client-local-preferences';
import { installPreferencesNormalizationEnvironment } from '@canopy/desktop-shared/node/preferences/normalization-environment';
import { createCatalogPreferencesModelFacts } from '@canopy/desktop-shared/node/preferences/catalog-model-facts';
import {
  createDesktopTerminalSettingsStore,
  createCoreTerminalSettingsAdapter,
} from '../core-terminal-settings-adapter';
import {
  readTerminalSettingsThroughCore,
  updateTerminalSettingsThroughCore,
  type TerminalSettingsDispatcher,
} from '../terminal-settings-dispatch';
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

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const preset: TerminalPreset = {
  id: 'a',
  name: 'Build',
  terminalProfileId: 'default',
  command: 'make',
  enabled: true,
  icon: { kind: 'image', lightDataUrl: PNG },
};
const caller: CanopyCallerDescriptor = {
  principalId: 'user',
  clientInstanceId: 'client',
  authorityId: 'desktop',
  interfaceKind: 'test',
  grants: [],
};
function projection(): ReturnType<typeof fixture> & {
  dispatcher: TerminalSettingsDispatcher;
  request: UpdateTerminalSettingsRequest;
} {
  const value = fixture();
  const dispatcher = createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: CORE_TERMINAL_SETTINGS_QUERIES,
      instructions: CORE_TERMINAL_SETTINGS_INSTRUCTIONS,
      streams: {},
    },
    handlers: {
      ...createCoreTerminalSettingsAdapter(value.store),
      streams: {},
    },
  });
  const request: UpdateTerminalSettingsRequest = {
    expectedRevision: 0,
    disabledTerminalShellProfileIds: [],
    terminalPresets: [preset],
    idempotencyKey: 'save-image',
  };
  return { ...value, dispatcher, request };
}
describe('terminal:get-settings and terminal:update-settings projections (CAN-4148)', () => {
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
    installPreferencesNormalizationEnvironment(
      createCatalogPreferencesModelFacts({
        status: (model) =>
          resolveKnownModel(model) ? 'available' : 'unavailable',
        ollamaEnabled: () => false,
        shortcutPlatform: () => 'darwin',
      }),
    );
  });

  it('projects image icons as data URLs both ways', async () => {
    const { dispatcher, request, repo } = projection();
    await expect(
      updateTerminalSettingsThroughCore(dispatcher, caller, request),
    ).resolves.toEqual({
      ok: true,
      settings: {
        revision: 1,
        disabledTerminalShellProfileIds: [],
        terminalPresets: [preset],
      },
    });
    await expect(repo.read('persisted')).resolves.toMatchObject({
      terminalPresets: [preset],
    });
    await expect(
      readTerminalSettingsThroughCore(dispatcher, caller),
    ).resolves.toEqual({
      revision: 1,
      disabledTerminalShellProfileIds: [],
      terminalPresets: [preset],
    });
    await repo.flush();
  });
  it('returns the current settings on a stale revision', async () => {
    const { dispatcher, request, repo } = projection();
    await updateTerminalSettingsThroughCore(dispatcher, caller, request);
    await expect(
      updateTerminalSettingsThroughCore(dispatcher, caller, {
        ...request,
        terminalPresets: [],
        idempotencyKey: 'stale-save',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'conflict',
        settings: { revision: 1, terminalPresets: [preset] },
      },
    });
    await repo.flush();
  });
  it('refuses an unsupported image before dispatch', async () => {
    const { dispatcher, request, doc, repo } = projection();
    const installs = doc.installs.length;
    await expect(
      updateTerminalSettingsThroughCore(dispatcher, caller, {
        ...request,
        terminalPresets: [
          {
            ...preset,
            icon: {
              kind: 'image',
              lightDataUrl: 'data:text/plain;base64,AA==',
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(doc.installs).toHaveLength(installs);
    await repo.flush();
  });
});
