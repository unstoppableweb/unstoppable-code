import {
  CLOUD_CUSTOM_SKILL_SOURCE_ID,
  mcpServerEntryId,
  pluginEntryId,
  skillEntryId,
  type CatalogEntry,
  type CatalogHarnessId,
  type CatalogPluginHarness,
  type CatalogPluginHarnesses,
  type CatalogSkillCloudShare,
  type CatalogSkillRow,
} from '@canopy/protocol/canopy-core';
import {
  cloudCapabilityRows,
  type CloudCapabilityState,
} from '../cloud-capability-rows';

const AT = '2026-11-10T00:00:00.000Z';
const HASH = 'a'.repeat(64);
const EDITED = 'b'.repeat(64);
const SHARE_ID = '11111111-2222-4333-8444-555555555555';
const CLOUD_SKILL_ID = skillEntryId({
  sourceId: CLOUD_CUSTOM_SKILL_SOURCE_ID,
  skillName: SHARE_ID,
});

const base = {
  description: '',
  revision: 0,
  createdAt: AT,
  updatedAt: AT,
} as const;

function skill(
  entryId: string,
  name: string,
  source: CatalogEntry['source'],
  availability: CatalogEntry['availability'] = 'available',
): CatalogEntry {
  return {
    ...base,
    entryId,
    kind: 'skill',
    name,
    source,
    content: { kind: 'skill', entrypoint: null },
    availability,
  };
}

const harness = (
  supported: boolean,
  enabled = supported,
): CatalogPluginHarness => ({
  supported,
  enabled,
  installed: supported,
  members: [],
});

/** Claude and Codex both load the plugin unless a test says otherwise. */
function harnesses(
  overrides: Partial<Record<CatalogHarnessId, CatalogPluginHarness>> = {},
): CatalogPluginHarnesses {
  return {
    claude: harness(true),
    codex: harness(true),
    ollama: harness(false),
    copilot: harness(false),
    opencode: harness(false),
    ...overrides,
  };
}

function plugin(
  entryId: string,
  perHarness: CatalogPluginHarnesses | null = harnesses(),
): CatalogEntry {
  return {
    ...base,
    entryId,
    kind: 'plugin',
    name: 'p',
    source: 'plugin',
    content: {
      kind: 'plugin',
      manifest: { name: 'p', version: '1', capabilities: [], dependencies: [] },
      ...(perHarness === null ? {} : { harnesses: perHarness }),
    },
    availability: 'available',
  };
}

function mcp(
  entryId: string,
  transport: 'stdio' | 'http',
  options: {
    connectionId?: string;
    availability?: CatalogEntry['availability'];
    connectionState?: 'desktop_only';
    name?: string;
    configName?: string;
  } = {},
): CatalogEntry {
  return {
    ...base,
    entryId,
    kind: 'mcp_server',
    name: options.name ?? entryId,
    source: 'user',
    content: {
      kind: 'mcp_server',
      transport,
      commandRef: null,
      url: null,
      authIntegrationId: options.connectionId ?? null,
      ...(options.connectionState === undefined
        ? {}
        : { connectionState: options.connectionState }),
      ...(options.configName === undefined
        ? {}
        : { configName: options.configName }),
    },
    availability: options.availability ?? 'available',
  };
}

function row(
  entryId: string,
  origin: CatalogSkillRow['origin'],
  cloudShare?: CatalogSkillCloudShare,
): CatalogSkillRow {
  return {
    entryId,
    sourceId: 'custom:app',
    skillName: 'helper',
    description: '',
    source: 'Custom',
    origin,
    installedAt: '',
    updatedAt: '',
    updateAvailable: false,
    version: null,
    ...(cloudShare === undefined ? {} : { cloudShare }),
  };
}

const share = (
  overrides: Partial<CatalogSkillCloudShare> = {},
): CatalogSkillCloudShare => ({
  role: 'author',
  remoteId: SHARE_ID,
  linkedContentHash: HASH,
  localContentHash: HASH,
  ...overrides,
});

const LOCAL_SKILL_ID = skillEntryId({
  sourceId: 'custom:app',
  skillName: 'helper',
});
const localSkill = skill(LOCAL_SKILL_ID, 'helper', 'user');
const cloudSkill = skill(CLOUD_SKILL_ID, 'helper', 'user');

const stateOf = (
  localSkills: CatalogSkillRow[],
  cloud: CatalogEntry[] = [cloudSkill],
): CloudCapabilityState | undefined =>
  cloudCapabilityRows({
    local: [localSkill],
    localSkills,
    cloud,
    harness: 'claude',
  })[0]?.state;

describe('cloud capability rows (CAN-6176)', () => {
  it('a skill without a cloud link needs an upload, never ready, even when a cloud skill shares its name', () => {
    for (const localSkills of [[row(LOCAL_SKILL_ID, 'custom')], []]) {
      expect(stateOf(localSkills)).toEqual({
        kind: 'needs_upload',
        reason: 'not_uploaded',
        action: 'publish_skill',
        cloudEntryId: null,
      });
    }
  });

  it('a linked skill is ready only while its SKILL.md matches the cloud copy', () => {
    expect(stateOf([row(LOCAL_SKILL_ID, 'custom', share())])).toEqual({
      kind: 'ready',
      cloudEntryId: CLOUD_SKILL_ID,
    });
    for (const changed of [
      share({ localContentHash: EDITED }),
      share({ localContentHash: null }),
      share({ linkedContentHash: null }),
    ]) {
      expect(stateOf([row(LOCAL_SKILL_ID, 'custom', changed)])).toEqual({
        kind: 'needs_upload',
        reason: 'changed',
        action: 'publish_skill',
        cloudEntryId: CLOUD_SKILL_ID,
      });
    }
  });

  it('a link to a cloud skill the account can no longer see needs an upload', () => {
    expect(stateOf([row(LOCAL_SKILL_ID, 'custom', share())], [])).toEqual({
      kind: 'needs_upload',
      reason: 'not_uploaded',
      action: 'publish_skill',
      cloudEntryId: null,
    });
  });

  it('a linked skill takes the cloud copy’s sign-in and availability state', () => {
    expect(
      stateOf(
        [row(LOCAL_SKILL_ID, 'custom', share({ role: 'recipient' }))],
        [skill(CLOUD_SKILL_ID, 'helper', 'user', 'disabled')],
      ),
    ).toEqual({ kind: 'unavailable', reason: 'cloud_unavailable' });
  });

  it('project skills stay local and built-ins map only to a cloud skill of the same name', () => {
    const project = skill('skill:workspace/p', 'p', 'workspace');
    const builtin = skill('skill:builtin:app/b', 'b', 'bundled');
    const orphan = skill('skill:builtin:app/o', 'o', 'bundled');
    const twin = skill('skill:cloud-curated/b', 'b', 'remote');
    const rows = cloudCapabilityRows({
      local: [project, builtin, orphan],
      localSkills: [],
      cloud: [twin],
      harness: 'claude',
    });
    expect(rows.map((entry) => entry.state)).toEqual([
      { kind: 'unavailable', reason: 'local_project' },
      { kind: 'ready', cloudEntryId: twin.entryId },
      { kind: 'unavailable', reason: 'desktop_builtin' },
    ]);
  });

  it('MCP servers map by entry or connection; stdio stays on the desktop and HTTP needs a copy', () => {
    const account = mcp(
      mcpServerEntryId({ serverId: 'linear', configId: 'default' }),
      'http',
      { connectionId: 'conn-1' },
    );
    const cloudAccount = mcp(
      mcpServerEntryId({ serverId: 'linear', configId: 'account' }),
      'http',
      { connectionId: 'conn-1', availability: 'auth_required' },
    );
    const stdio = mcp(
      mcpServerEntryId({ serverId: 'fs', configId: 'default' }),
      'stdio',
    );
    const remote = mcp(
      mcpServerEntryId({ serverId: 'docs', configId: 'default' }),
      'http',
    );
    const loopback = mcp(
      mcpServerEntryId({ serverId: 'figma', configId: 'default' }),
      'http',
      { connectionState: 'desktop_only' },
    );
    const rows = cloudCapabilityRows({
      local: [account, stdio, remote, loopback],
      localSkills: [],
      cloud: [cloudAccount],
      harness: 'claude',
    });
    expect(rows.map((entry) => entry.state)).toEqual([
      { kind: 'needs_sign_in', cloudEntryId: cloudAccount.entryId },
      { kind: 'desktop_only', online: false, cloudEntryId: null },
      {
        kind: 'needs_upload',
        reason: 'not_uploaded',
        action: 'copy_mcp_server',
        cloudEntryId: null,
      },
      { kind: 'desktop_only', online: false, cloudEntryId: null },
    ]);
  });

  it('plugins map by entry id, and cloud-only capabilities follow the desktop ones', () => {
    const shared = plugin(
      pluginEntryId({ marketplaceId: 'curated', pluginName: 'p' }),
    );
    const local = plugin(
      pluginEntryId({ marketplaceId: 'local', pluginName: 'q' }),
    );
    const cloudOnly = skill('skill:cloud-curated/c', 'c', 'remote');
    const model: CatalogEntry = {
      ...base,
      entryId: 'model:m',
      kind: 'model',
      name: 'm',
      source: 'remote',
      content: {
        kind: 'model',
        providerId: 'claude',
        modelName: 'm',
        contextWindow: null,
        capabilities: [],
      },
      availability: 'available',
    };
    const rows = cloudCapabilityRows({
      local: [shared, local, model],
      localSkills: [],
      cloud: [shared, cloudOnly, model],
      harness: 'claude',
    });
    expect(
      rows.map((entry) => [
        entry.localEntry?.entryId ?? null,
        entry.cloudEntry?.entryId ?? null,
        entry.state.kind,
      ]),
    ).toEqual([
      [shared.entryId, shared.entryId, 'ready'],
      [local.entryId, null, 'needs_upload'],
      [null, cloudOnly.entryId, 'ready'],
    ]);
  });

  it('a plugin is usable only where the chat’s harness supports and enables it; a missing entry fails closed', () => {
    const id = (name: string): string =>
      pluginEntryId({ marketplaceId: 'curated', pluginName: name });
    const codexOnly = harnesses({ claude: harness(false) });
    const turnedOff = harnesses({ claude: harness(true, false) });
    const unsupported = {
      kind: 'unavailable',
      reason: 'harness_unsupported',
    } as const;
    const statesFor = (chatHarness: CatalogHarnessId): CloudCapabilityState[] =>
      cloudCapabilityRows({
        local: [
          plugin(id('both')),
          plugin(id('codex'), codexOnly),
          plugin(id('off'), turnedOff),
          plugin(id('unknown'), null),
          plugin(id('local-codex'), codexOnly),
          plugin(id('local-both')),
        ],
        localSkills: [],
        cloud: [
          plugin(id('both')),
          plugin(id('codex'), codexOnly),
          plugin(id('off'), turnedOff),
          plugin(id('unknown'), null),
          plugin(id('cloud-codex'), codexOnly),
        ],
        harness: chatHarness,
      }).map((entry) => entry.state);
    const needsUpload = {
      kind: 'needs_upload',
      reason: 'not_uploaded',
      action: 'publish_plugin',
      cloudEntryId: null,
    } as const;
    expect(statesFor('claude')).toEqual([
      { kind: 'ready', cloudEntryId: id('both') },
      unsupported,
      unsupported,
      unsupported,
      unsupported,
      needsUpload,
      unsupported,
    ]);
    expect(statesFor('codex')).toEqual([
      { kind: 'ready', cloudEntryId: id('both') },
      { kind: 'ready', cloudEntryId: id('codex') },
      { kind: 'ready', cloudEntryId: id('off') },
      unsupported,
      needsUpload,
      needsUpload,
      { kind: 'ready', cloudEntryId: id('cloud-codex') },
    ]);
  });

  it('names an MCP row server / config, as search does, when the config has its own name', () => {
    const server = (configId: string, configName?: string): CatalogEntry =>
      mcp(mcpServerEntryId({ serverId: 'linear', configId }), 'http', {
        name: 'Linear',
        ...(configName === undefined ? {} : { configName }),
      });
    const rows = cloudCapabilityRows({
      local: [server('work', 'Work'), server('default', 'Linear')],
      localSkills: [],
      cloud: [server('account')],
      harness: 'claude',
    });
    expect(rows.map((entry) => entry.name)).toEqual([
      'Linear / Work',
      'Linear',
      'Linear',
    ]);
  });

  it('a skill a plugin brings takes its plugin’s harness verdict, and fails closed when no single plugin owns it', () => {
    const member = (name: string) =>
      ({ kind: 'skill', name, description: '' }) as const;
    const withSkill = (
      pluginName: string,
      skillName: string,
      claude: boolean,
    ): CatalogEntry =>
      plugin(
        pluginEntryId({ marketplaceId: 'curated', pluginName }),
        harnesses({
          claude: { ...harness(claude), members: [member(skillName)] },
          codex: { ...harness(true), members: [member(skillName)] },
        }),
      );
    const pluginSkill = (name: string): CatalogEntry =>
      skill(`skill:plugin-${name}/${name}`, name, 'plugin');
    const plugins = [
      withSkill('a', 'shared', true),
      withSkill('b', 'codex-only', false),
      withSkill('c', 'twice', true),
      withSkill('d', 'twice', true),
    ];
    const skills = ['shared', 'codex-only', 'twice', 'orphan'].map(pluginSkill);
    const statesFor = (chatHarness: CatalogHarnessId): CloudCapabilityState[] =>
      cloudCapabilityRows({
        local: [...skills, pluginSkill('local-only')],
        localSkills: [],
        cloud: [...plugins, ...skills, pluginSkill('cloud-only')],
        harness: chatHarness,
      })
        .filter(
          (entry) => (entry.localEntry ?? entry.cloudEntry)?.kind === 'skill',
        )
        .map((entry) => entry.state);
    const unsupported = {
      kind: 'unavailable',
      reason: 'harness_unsupported',
    } as const;
    expect(statesFor('claude')).toEqual([
      { kind: 'ready', cloudEntryId: pluginSkill('shared').entryId },
      unsupported,
      unsupported,
      unsupported,
      unsupported,
      unsupported,
    ]);
    expect(statesFor('codex')[1]).toEqual({
      kind: 'ready',
      cloudEntryId: pluginSkill('codex-only').entryId,
    });
  });
});
