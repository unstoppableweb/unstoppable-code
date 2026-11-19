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

const pluginEntry = (
  ref: {
    marketplaceId: string;
    pluginName: string;
  },
  cloudCopy?: {
    readonly uploadedFromThisDesktop?: {
      sourcePluginKey: string;
      sourceMarketplaceId: string;
    };
  },
): CatalogEntry => ({
  ...base,
  entryId: pluginEntryId(ref),
  kind: 'plugin',
  name: ref.pluginName,
  source: cloudCopy === undefined ? 'plugin' : 'remote',
  content: {
    kind: 'plugin',
    selectionRef: ref,
    ...(cloudCopy?.uploadedFromThisDesktop === undefined
      ? {}
      : { uploadedFromThisDesktop: cloudCopy.uploadedFromThisDesktop }),
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
/**
 * Installed from GitHub: offered only with CAN-6943's flag on, which main
 * enforces again.
 */
const INSTALLED = { sourceId: 'github:acme:tools', skillName: 'lint' };
const EDITED = { sourceId: 'custom:app', skillName: 'edited' };
const SHARED = { sourceId: 'custom:app', skillName: 'shared' };
const CLOUD_COPY = {
  sourceId: CLOUD_CUSTOM_SKILL_SOURCE_ID,
  skillName: SHARE_ID,
};

const local: LocalCatalog = {
  bundledMarketplaceIds: new Set(),
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
    // A web core that predates the uploads mark (CAN-6725) can't say which
    // plugins this desktop copied, so none is offered.
    const items = localUploadRows(local, cloud, 'claude', false, false).map(
      localPickerItem,
    );
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
    expect(localUploadRows(local, cloud, 'not-a-harness', true, false)).toEqual(
      localUploadRows(local, cloud, 'claude', true, false),
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

describe('this computer’s plugins, by what this desktop uploaded (CAN-6725)', () => {
  const LOCAL = 'local-tools';
  const OTHER_LOCAL = 'team-tools';
  /** This desktop's cloud marketplace, and another desktop's. */
  const MINE = 'marketplace:mine';
  const THEIRS = 'marketplace:theirs';
  const plugins: LocalCatalog = {
    entries: [
      pluginEntry({ marketplaceId: LOCAL, pluginName: 'copied' }),
      pluginEntry({ marketplaceId: LOCAL, pluginName: 'fresh' }),
      pluginEntry({ marketplaceId: 'builtin-tools', pluginName: 'builtin' }),
      pluginEntry({ marketplaceId: 'curated-tools', pluginName: 'curated' }),
      pluginEntry({ marketplaceId: LOCAL, pluginName: 'elsewhere' }),
      pluginEntry({ marketplaceId: OTHER_LOCAL, pluginName: 'copied' }),
      // A skill a plugin brings is copied as its plugin, never on its own.
      {
        ...skillEntry({ sourceId: LOCAL, skillName: 'review' }),
        source: 'plugin',
      },
    ],
    skills: [],
    bundledMarketplaceIds: new Set(['builtin-tools', 'curated-tools']),
  };
  const uploaded = [
    // This desktop's copy of `copied` from its `local-tools`.
    pluginEntry(
      { marketplaceId: MINE, pluginName: 'copied' },
      {
        uploadedFromThisDesktop: {
          sourcePluginKey: 'copied',
          sourceMarketplaceId: LOCAL,
        },
      },
    ),
    // Another desktop's plugin of the same name as this one's `elsewhere`.
    pluginEntry({ marketplaceId: THEIRS, pluginName: 'elsewhere' }, {}),
  ];
  const offered = (thisDesktopUploads: boolean): string[] =>
    localUploadRows(plugins, uploaded, 'claude', thisDesktopUploads, false).map(
      (row) => row.localEntry.entryId,
    );

  it('offers a plugin this desktop never copied, and not one it did', () => {
    expect(offered(true)).toContain(
      pluginEntryId({ marketplaceId: LOCAL, pluginName: 'fresh' }),
    );
    expect(offered(true)).not.toContain(
      pluginEntryId({ marketplaceId: LOCAL, pluginName: 'copied' }),
    );
    const fresh = localUploadRows(
      plugins,
      uploaded,
      'claude',
      true,
      false,
    ).find((row) => row.name === 'fresh');
    expect(fresh && localPickerItem(fresh)).toEqual({
      key: pluginEntryId({ marketplaceId: LOCAL, pluginName: 'fresh' }),
      name: 'fresh',
      kind: 'plugin',
      replacing: false,
    });
  });

  it('never offers a built-in or curated plugin, which the cloud has already', () => {
    expect(offered(true)).not.toContain(
      pluginEntryId({ marketplaceId: 'builtin-tools', pluginName: 'builtin' }),
    );
    expect(offered(true)).not.toContain(
      pluginEntryId({ marketplaceId: 'curated-tools', pluginName: 'curated' }),
    );
  });

  it('offers a plugin another desktop uploaded under the same name, since this one never did', () => {
    expect(offered(true)).toContain(
      pluginEntryId({ marketplaceId: LOCAL, pluginName: 'elsewhere' }),
    );
  });

  it('offers a same-named plugin from another of this computer’s marketplaces, whose add the cloud refuses with the reason', () => {
    expect(offered(true)).toContain(
      pluginEntryId({ marketplaceId: OTHER_LOCAL, pluginName: 'copied' }),
    );
  });

  it('offers exactly those, and no plugin at all when the cloud doesn’t mark this desktop’s uploads', () => {
    expect(offered(true).sort()).toEqual(
      [
        pluginEntryId({ marketplaceId: LOCAL, pluginName: 'fresh' }),
        pluginEntryId({ marketplaceId: LOCAL, pluginName: 'elsewhere' }),
        pluginEntryId({ marketplaceId: OTHER_LOCAL, pluginName: 'copied' }),
      ].sort(),
    );
    expect(offered(false)).toEqual([]);
  });
});

describe("skills installed from GitHub, a URL or a local folder, behind CAN-6943's flag", () => {
  const GITHUB = { sourceId: 'github:acme:tools', skillName: 'lint' };
  const URL_SKILL = {
    sourceId: 'url:https:__example.com_skills',
    skillName: 'fetch',
  };
  const LOCAL_FOLDER = {
    sourceId: 'local:_Users_me_skills',
    skillName: 'draft',
  };
  const CHANGED = { sourceId: 'github:acme:tools', skillName: 'changed' };
  const IN_STEP = { sourceId: 'github:acme:tools', skillName: 'steady' };
  const BUILT_IN = { sourceId: 'builtin:app', skillName: 'bundled' };
  const OTHER_SOURCE = { sourceId: 'marketplace:acme', skillName: 'other' };
  const installedRow = (
    ref: { sourceId: string; skillName: string },
    share?: CatalogSkillRow['cloudShare'],
    origin: CatalogSkillRow['origin'] = 'installed',
  ): CatalogSkillRow => ({
    ...skillRow(ref.skillName, share),
    entryId: skillEntryId(ref),
    sourceId: ref.sourceId,
    origin,
  });
  const installed: LocalCatalog = {
    bundledMarketplaceIds: new Set(),
    entries: [
      skillEntry(GITHUB),
      skillEntry(URL_SKILL),
      skillEntry(LOCAL_FOLDER),
      skillEntry(CHANGED),
      skillEntry(IN_STEP),
      { ...skillEntry(BUILT_IN), source: 'bundled' },
      skillEntry(OTHER_SOURCE),
      // A skill a plugin brings is copied as its plugin, never on its own.
      {
        ...skillEntry({ sourceId: 'local-tools', skillName: 'review' }),
        source: 'plugin',
      },
    ],
    skills: [
      installedRow(GITHUB),
      installedRow(URL_SKILL),
      installedRow(LOCAL_FOLDER),
      // Its source updated it since its copy: "Update in cloud".
      installedRow(CHANGED, {
        role: 'author',
        remoteId: SHARE_ID,
        linkedContentHash: HASH,
        localContentHash: 'b'.repeat(64),
      }),
      installedRow(IN_STEP, {
        role: 'author',
        remoteId: SHARE_ID,
        linkedContentHash: HASH,
        localContentHash: HASH,
      }),
      installedRow(BUILT_IN, undefined, 'builtin'),
      installedRow(OTHER_SOURCE),
    ],
  };
  const offered = (installedSkills: boolean): unknown[] =>
    localUploadRows(installed, cloud, 'claude', true, installedSkills).map(
      localPickerItem,
    );

  it('offers none of them while the flag is off', () => {
    expect(offered(false)).toEqual([]);
  });

  it("offers each new one to add and a changed one to update, never one in step, a built-in, a plugin's or another source's", () => {
    expect(offered(true)).toEqual([
      {
        key: skillEntryId(GITHUB),
        name: 'lint',
        kind: 'skill',
        replacing: false,
      },
      {
        key: skillEntryId(URL_SKILL),
        name: 'fetch',
        kind: 'skill',
        replacing: false,
      },
      {
        key: skillEntryId(LOCAL_FOLDER),
        name: 'draft',
        kind: 'skill',
        replacing: false,
      },
      {
        key: skillEntryId(CHANGED),
        name: 'changed',
        kind: 'skill',
        replacing: true,
      },
    ]);
  });
});
