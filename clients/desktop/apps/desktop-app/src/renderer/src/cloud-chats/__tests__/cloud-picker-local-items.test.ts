/**
 * What a desktop cloud chat's picker offers to add to the cloud account
 * (CAN-6176): this computer's skills and plugins the account lacks, or has
 * an older copy of. An item carries the local entry id and its name only,
 * so no path leaves the renderer; main reads the files the consent dialog
 * shows. A server copies from its own page, never here.
 */
import {
  CLOUD_CUSTOM_SKILL_SOURCE_ID,
  mcpServerEntryId,
  pluginEntryId,
  skillEntryId,
  type CatalogEntry,
  type CatalogSkillRow,
} from '@canopy/protocol/canopy-core';
import {
  localPickerItem,
  localUploadRows,
  selectionForCloudEntry,
  type LocalCatalog,
} from '../cloud-picker-local-items';

const AT = '2026-11-13T00:00:00.000Z';
const HASH = 'a'.repeat(64);
const SHARE_ID = '11111111-2222-4333-8444-555555555555';
const base = { description: '', revision: 0, createdAt: AT, updatedAt: AT };

const skillEntry = (
  ref: { sourceId: string; skillName: string },
  withRef = false,
): CatalogEntry => ({
  ...base,
  entryId: skillEntryId(ref),
  kind: 'skill',
  name: ref.skillName,
  source: 'user',
  content: {
    kind: 'skill',
    entrypoint: null,
    ...(withRef ? { selectionRef: ref } : {}),
  },
  availability: 'available',
});

const pluginEntry = (ref: {
  marketplaceId: string;
  pluginName: string;
}): CatalogEntry => ({
  ...base,
  entryId: pluginEntryId(ref),
  kind: 'plugin',
  name: ref.pluginName,
  source: 'plugin',
  content: {
    kind: 'plugin',
    manifest: {
      name: ref.pluginName,
      version: '1',
      capabilities: [],
      dependencies: [],
    },
    // Claude loads it, so a Claude chat can use the cloud copy.
    harnesses: {
      claude: { supported: true, enabled: true, installed: true, members: [] },
      codex: {
        supported: false,
        enabled: false,
        installed: false,
        members: [],
      },
      ollama: {
        supported: false,
        enabled: false,
        installed: false,
        members: [],
      },
      copilot: {
        supported: false,
        enabled: false,
        installed: false,
        members: [],
      },
      opencode: {
        supported: false,
        enabled: false,
        installed: false,
        members: [],
      },
    },
  },
  availability: 'available',
});

const serverEntry: CatalogEntry = {
  ...base,
  entryId: mcpServerEntryId({ serverId: 'files', configId: 'default' }),
  kind: 'mcp_server',
  name: 'files',
  source: 'user',
  content: {
    kind: 'mcp_server',
    transport: 'http',
    commandRef: null,
    url: null,
    authIntegrationId: null,
  },
  availability: 'available',
};

const skillRow = (
  skillName: string,
  share?: CatalogSkillRow['cloudShare'],
): CatalogSkillRow => ({
  entryId: skillEntryId({ sourceId: 'custom:app', skillName }),
  sourceId: 'custom:app',
  skillName,
  description: '',
  source: 'Custom',
  origin: 'custom',
  installedAt: '',
  updatedAt: '',
  updateAvailable: false,
  version: null,
  ...(share === undefined ? {} : { cloudShare: share }),
});

const NEW = { sourceId: 'custom:app', skillName: 'notes' };
/** Installed from GitHub: main's cloud-copy analyser takes custom skills only. */
const INSTALLED = { sourceId: 'github:acme/tools', skillName: 'lint' };
const EDITED = { sourceId: 'custom:app', skillName: 'edited' };
const SHARED = { sourceId: 'custom:app', skillName: 'shared' };
const CLOUD_COPY = {
  sourceId: CLOUD_CUSTOM_SKILL_SOURCE_ID,
  skillName: SHARE_ID,
};

const local: LocalCatalog = {
  entries: [
    skillEntry(NEW),
    skillEntry(EDITED),
    skillEntry(SHARED),
    skillEntry(INSTALLED),
    pluginEntry({ marketplaceId: 'local-tools', pluginName: 'tools' }),
    serverEntry,
  ],
  skills: [
    {
      ...skillRow('lint'),
      entryId: skillEntryId(INSTALLED),
      sourceId: INSTALLED.sourceId,
      origin: 'installed',
    },
    skillRow('notes'),
    // Linked, then edited here: the cloud has an older copy.
    skillRow('edited', {
      role: 'author',
      remoteId: SHARE_ID,
      linkedContentHash: HASH,
      localContentHash: 'b'.repeat(64),
    }),
    // Linked and unchanged: the cloud already has it.
    skillRow('shared', {
      role: 'author',
      remoteId: SHARE_ID,
      linkedContentHash: HASH,
      localContentHash: HASH,
    }),
  ],
};
const cloud = [skillEntry(CLOUD_COPY, true)];

describe('this computer’s items in a cloud chat’s picker (CAN-6176)', () => {
  it('offers a new custom skill and an edited one to update, never a plugin, a server or a skill it can’t copy', () => {
    const items = localUploadRows(local, cloud, 'claude').map(localPickerItem);
    expect(items).toEqual([
      {
        key: skillEntryId(NEW),
        name: 'notes',
        kind: 'skill',
        replacing: false,
      },
      {
        key: skillEntryId(EDITED),
        name: 'edited',
        kind: 'skill',
        replacing: true,
      },
    ]);
    // Only these four fields: an entry id and a name, no path or file.
    for (const item of items)
      expect(Object.keys(item).sort()).toEqual([
        'key',
        'kind',
        'name',
        'replacing',
      ]);
  });

  it('reads an unknown harness as Claude’s', () => {
    expect(localUploadRows(local, cloud, 'not-a-harness')).toEqual(
      localUploadRows(local, cloud, 'claude'),
    );
  });

  it('selects the cloud copy by its own selection ref, and nothing it can’t find', () => {
    expect(selectionForCloudEntry(cloud, skillEntryId(CLOUD_COPY))).toEqual({
      skillRefs: [CLOUD_COPY],
      pluginRefs: [],
    });
    expect(selectionForCloudEntry(cloud, 'skill:missing/x')).toBeNull();
    // An entry without a selection ref can't be selected.
    expect(
      selectionForCloudEntry(
        [skillEntry(CLOUD_COPY)],
        skillEntryId(CLOUD_COPY),
      ),
    ).toBeNull();
  });
});
