/**
 * Uploading a local or private-marketplace plugin to the account's private
 * cloud marketplace (CAN-6176 D13, PR 9b): only the consented package's files
 * of this plugin travel, without hooks, MCP or LSP configs; a package
 * analysed over other content, or not for a cloud copy of this plugin,
 * uploads nothing; content the cloud already
 * holds for this desktop goes by hash alone; and every request uses the one
 * account context the publish resolved.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CatalogHostRefusedError,
  type CatalogPluginTarget,
} from '@canopy/core-runtime/node/catalog';
import { analyzeCapabilityPackage } from '@canopy/desktop-shared/node';
import type { InvocableInventoryEntry } from '@canopy/execution-engine/types/invocable-inventory';
import {
  CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
  type PipelinePackageManifestV1,
  type PipelinePackageResource,
} from '@canopy/protocol/pipelines';
import { CanopyCloudClientError } from '../../canopy-cloud/client';
import type { DesktopPluginUpload } from '../../canopy-cloud/plugin-marketplaces';
import { gitIgnoredPredicate } from '../../pipelines/cloud-copy-git-ignored';
import {
  PackageAnalysisBlockedError,
  ShareOperationError,
} from '../../sharing/share-operation-result';
import {
  publishPluginPackageToCloud,
  type PublishPluginPackageDeps,
} from '../publish-plugin-to-cloud';
import {
  cloudCopySubjectMatches,
  readAnalyzedCapabilityPackage,
  type CloudCopySubject,
} from '../../pipelines/pipeline-package-service';

const TARGET: CatalogPluginTarget = {
  entryId: 'plugin:local-tools/notes',
  marketplaceId: 'local-tools',
  pluginName: 'notes',
  install: 'managed',
};
const PKG = { analysisId: 'analysis-1', selectedOptionalResourceIds: [] };
const SOURCE = { id: 'local-tools', label: 'Local tools' };
const CONTEXT = { baseUrl: 'https://cloud.example', apiKey: 'key-1' };

const blobs = new Map<string, Uint8Array>();
const entry = (
  path: string,
  text: string,
): PipelinePackageResource['trees'][number]['entries'][number] => {
  const bytes = new TextEncoder().encode(text);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  blobs.set(sha256, bytes);
  return { path, sha256, size: bytes.byteLength, mode: 'read' };
};
const sha = (text: string): string =>
  createHash('sha256').update(new TextEncoder().encode(text)).digest('hex');

const MANIFEST_JSON = '{\n  "name": "notes"\n}\n';
const SKILL = '---\nname: notes\n---\nWrite it down.\n';
/** Git's answer for a folder whose own repository it could read. */
const checkedBy = (
  isIgnored: (absolutePath: string) => boolean,
): { isIgnored: (absolutePath: string) => boolean; checked: true } => ({
  isIgnored,
  checked: true,
});
const COMMAND = 'Summarise the notes.\n';

const resource = (
  id: string,
  pluginName: string,
  trees: PipelinePackageResource['trees'],
): PipelinePackageResource => ({
  id,
  installedItemRef: {
    kind: 'plugin',
    marketplaceId: 'local-tools',
    pluginName,
  },
  kind: 'plugin_skill',
  displayName: id,
  sourceLabel: pluginName,
  sourceVisibility: 'local',
  invocationKeys: [],
  dependencyResourceIds: [],
  trees,
});

/** A package analysed over the `notes` plugin, with a sibling plugin's skill. */
function analysedPackage(): PipelinePackageManifestV1 {
  const tree = (
    provider: 'claude' | 'codex',
    entries: PipelinePackageResource['trees'][number]['entries'],
  ): PipelinePackageResource['trees'][number] => ({
    provider,
    runtimeKind: 'plugin_fragment',
    rootName: 'notes',
    entries,
  });
  return {
    resources: [
      resource('skill', 'notes', [
        tree('claude', [
          entry('.claude-plugin/plugin.json', MANIFEST_JSON),
          entry('skills/notes/SKILL.md', SKILL),
          // Never collected by the analyzer today; dropped here regardless.
          entry('hooks/hooks.json', '{"hooks":{}}'),
          entry('.mcp.json', '{"mcpServers":{"x":{"command":"rm"}}}'),
          entry('.lsp.json', '{}'),
        ]),
        tree('codex', [entry('.codex-plugin/plugin.json', MANIFEST_JSON)]),
      ]),
      resource('command', 'notes', [
        tree('claude', [
          entry('.claude-plugin/plugin.json', MANIFEST_JSON),
          entry('commands/summarise.md', COMMAND),
        ]),
      ]),
      resource('other', 'other-plugin', [
        tree('claude', [entry('skills/other/SKILL.md', 'Other.\n')]),
      ]),
    ],
  } as unknown as PipelinePackageManifestV1;
}

interface Recorded {
  contexts: unknown[];
  asked: string[][];
  uploads: DesktopPluginUpload[];
}

function fakes(
  overrides: Partial<PublishPluginPackageDeps> = {},
  missing: string[][] = [[]],
): { deps: PublishPluginPackageDeps; recorded: Recorded } {
  const recorded: Recorded = { contexts: [], asked: [], uploads: [] };
  const deps: PublishPluginPackageDeps = {
    readPackage: () =>
      Promise.resolve({
        manifest: analysedPackage(),
        readBlob: (hash) => {
          const bytes = blobs.get(hash);
          if (bytes === undefined) throw new Error('missing blob');
          return bytes;
        },
      }),
    credentials: () => Promise.resolve(CONTEXT),
    missingBlobs: (hashes, context) => {
      recorded.contexts.push(context);
      recorded.asked.push([...hashes].sort());
      return Promise.resolve(missing.shift() ?? []);
    },
    upload: (upload, context) => {
      recorded.contexts.push(context);
      recorded.uploads.push(upload);
      return Promise.resolve({
        marketplaceId: 'market-1',
        pluginKey: upload.pluginKey,
        contentHash: 'h'.repeat(64),
      });
    },
    ...overrides,
  };
  return { deps, recorded };
}

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  const error: unknown = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof CatalogHostRefusedError)) throw error;
  return error.refusal;
};

const standaloneSkill = (
  id: string,
  name: string,
): InvocableInventoryEntry => ({
  id,
  provider: 'claude',
  kind: 'skill',
  name,
  displayName: name,
  description: '',
  insertText: `/${name}`,
  invocationKey: `/${name}`,
  enableRef: { kind: 'skill', sourceId: 'custom:app', skillName: name },
});

const skillFolder = (root: string, name: string) =>
  ({
    sourceRoot: root,
    memberPath: join(root, name),
    sourceVisibility: 'local',
    runtimeKind: 'standalone_skill',
    rootName: name,
  }) as const;

/** Writes a plugin folder from relative paths to text. */
function writePlugin(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'publish-plugin-declared-'));
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), text);
  }
  return root;
}

/**
 * A real analysis of the `notes` plugin at `root` with the given members:
 * the one analyzer sharing and the cloud copy both use.
 */
function analysePlugin(
  root: string,
  members: ReadonlyArray<{
    kind: 'plugin_skill' | 'plugin_command';
    name: string;
    path: string;
  }>,
): ReturnType<typeof analyzeCapabilityPackage> {
  const enableRef = {
    kind: 'plugin',
    marketplaceId: 'local-tools',
    pluginName: 'notes',
  } as const;
  return analyzeCapabilityPackage({
    rawContent: '',
    invocableInventory: {
      version: 6,
      builtAt: '2026-11-11T00:00:00.000Z',
      entries: members.map(
        (member, index): InvocableInventoryEntry => ({
          id: `e${index}`,
          provider: 'claude',
          kind: member.kind,
          name: member.name,
          displayName: member.name,
          description: '',
          insertText: `/notes:${member.name}`,
          invocationKey: `notes:${member.name}`,
          enableRef,
        }),
      ),
    },
    capabilityInventoryEntryIdsByKey: {
      'plugin:local-tools:notes': members.map((_, index) => `e${index}`),
    },
    sourceByInventoryEntryId: Object.fromEntries(
      members.map((member, index) => [
        `e${index}`,
        {
          sourceRoot: root,
          memberPath: join(root, member.path),
          sourceVisibility: 'local',
          runtimeKind: 'plugin_fragment',
          rootName: 'notes',
        } as const,
      ]),
    ),
    requests: [
      {
        key: 'plugin:local-tools:notes',
        provider: 'claude',
        required: true,
        bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
      },
    ],
  });
}

/** Publishes a ready analysis and returns what was uploaded, decoded. */
async function publishAnalysis(
  analysis: Awaited<ReturnType<typeof analyzeCapabilityPackage>>,
): Promise<{ paths: string[]; manifest: unknown }> {
  const manifest = analysis.summary.manifest;
  if (analysis.summary.state !== 'ready' || manifest === undefined)
    throw new Error('the analysis is not ready');
  const { deps, recorded } = fakes({
    readPackage: () =>
      Promise.resolve({
        manifest,
        readBlob: (hash) => {
          const bytes = analysis.blobs.get(hash);
          if (bytes === undefined) throw new Error('missing blob');
          return bytes;
        },
      }),
    missingBlobs: (hashes): Promise<string[]> => Promise.resolve([...hashes]),
  });
  await publishPluginPackageToCloud(TARGET, PKG, SOURCE, deps);
  const files = recorded.uploads[0]?.files ?? [];
  const sent = files.find((file) => file.path === '.claude-plugin/plugin.json');
  return {
    paths: files.map((file) => file.path).sort(),
    manifest: JSON.parse(
      Buffer.from(sent?.content ?? '', 'base64').toString('utf8'),
    ) as unknown,
  };
}

describe('uploading a local plugin to the private cloud marketplace (CAN-6176 D13)', () => {
  it("uploads only this plugin's consented files, never hooks, MCP or LSP configs, and sends held content by hash", async () => {
    const { deps, recorded } = fakes({}, [[sha(SKILL)]]);
    const published = await publishPluginPackageToCloud(
      TARGET,
      PKG,
      SOURCE,
      deps,
    );
    expect(published).toEqual({
      publicationId: 'market-1',
      remoteEntryId: 'plugin:marketplace:market-1/notes',
      revision: 'h'.repeat(64),
    });
    expect(recorded.uploads).toHaveLength(1);
    const [upload] = recorded.uploads;
    expect(upload?.pluginKey).toBe('notes');
    // The local marketplace goes with it, so a same-named plugin from
    // another one is refused rather than replaced.
    expect(upload?.source).toEqual(SOURCE);
    expect(upload?.files.map((file) => file.path).sort()).toEqual([
      '.claude-plugin/plugin.json',
      'commands/summarise.md',
      'skills/notes/SKILL.md',
    ]);
    // Only what the cloud lacks for this desktop carries content.
    const withContent = upload?.files.filter(
      (file) => file.content !== undefined,
    );
    expect(withContent?.map((file) => file.path)).toEqual([
      'skills/notes/SKILL.md',
    ]);
    expect(
      Buffer.from(withContent?.[0]?.content ?? '', 'base64').toString('utf8'),
    ).toBe(SKILL);
    expect(recorded.asked[0]).toEqual(
      [sha(MANIFEST_JSON), sha(SKILL), sha(COMMAND)].sort(),
    );
    expect(recorded.contexts.every((context) => context === CONTEXT)).toBe(
      true,
    );
  });

  it('uploads nothing when the package is stale or was analysed over something else', async () => {
    const stale = fakes({
      readPackage: () =>
        Promise.reject(
          new ShareOperationError(
            'dependency-review',
            'Dependency files changed since analysis.',
            'prepare',
          ),
        ),
    });
    await expect(
      refusal(publishPluginPackageToCloud(TARGET, PKG, SOURCE, stale.deps)),
    ).resolves.toBe('publish-package-stale');
    expect(stale.recorded.asked).toEqual([]);

    const elsewhere = fakes();
    await expect(
      refusal(
        publishPluginPackageToCloud(
          { ...TARGET, pluginName: 'unrelated' },
          PKG,
          SOURCE,
          elsewhere.deps,
        ),
      ),
    ).resolves.toBe('publish-package-stale');
    expect(elsewhere.recorded.asked).toEqual([]);
    expect(elsewhere.recorded.uploads).toEqual([]);
  });

  it('uploads nothing when the desktop is signed in to another account than the person chose', async () => {
    const signedIn = { ...CONTEXT, account: { id: 'acct-1' } };
    const stale = fakes({
      credentials: () => Promise.resolve(signedIn as typeof CONTEXT),
    });
    await expect(
      refusal(
        publishPluginPackageToCloud(TARGET, PKG, SOURCE, stale.deps, {
          expectedAccountId: 'acct-2',
        }),
      ),
    ).resolves.toBe('publish-account-mismatch');
    expect(stale.recorded.asked).toEqual([]);
    expect(stale.recorded.uploads).toEqual([]);

    const same = fakes({
      credentials: () => Promise.resolve(signedIn as typeof CONTEXT),
    });
    await publishPluginPackageToCloud(TARGET, PKG, SOURCE, same.deps, {
      expectedAccountId: 'acct-1',
    });
    expect(same.recorded.uploads).toHaveLength(1);
  });

  it('reads only an analysis made for a cloud copy of exactly this plugin', async () => {
    // The publish asks for its own target, whatever analysis id it was given.
    const asked: CloudCopySubject[] = [];
    const accounts: (string | undefined)[] = [];
    const { deps } = fakes({
      credentials: () =>
        Promise.resolve({
          ...CONTEXT,
          account: { id: 'acct-1' },
        } as typeof CONTEXT),
    });
    const reading = deps.readPackage;
    await publishPluginPackageToCloud(
      TARGET,
      PKG,
      SOURCE,
      {
        ...deps,
        readPackage: (pkg, subject, accountId) => {
          asked.push(subject);
          accounts.push(accountId);
          return reading(pkg, subject, accountId);
        },
      },
      { expectedAccountId: 'acct-1' },
    );
    // And for the account the person chose, which the analysis must be for.
    expect(accounts).toEqual(['acct-1']);
    expect(asked).toEqual([
      {
        kind: 'plugin',
        marketplaceId: TARGET.marketplaceId,
        pluginName: TARGET.pluginName,
      },
    ]);

    // An analysis made for sharing, a reference review or another item
    // (none of which records a cloud copy subject), or for another plugin,
    // doesn't match; only one made for this plugin does.
    const wanted: CloudCopySubject = {
      kind: 'plugin',
      marketplaceId: TARGET.marketplaceId,
      pluginName: TARGET.pluginName,
    };
    expect(cloudCopySubjectMatches(undefined, wanted)).toBe(false);
    expect(
      cloudCopySubjectMatches({ ...wanted, pluginName: 'other' }, wanted),
    ).toBe(false);
    expect(
      cloudCopySubjectMatches(
        { ...wanted, marketplaceId: 'elsewhere' },
        wanted,
      ),
    ).toBe(false);
    expect(cloudCopySubjectMatches({ ...wanted }, wanted)).toBe(true);

    // And the real reader refuses an unknown analysis before anything else.
    await expect(
      readAnalyzedCapabilityPackage({
        analysisId: 'not-a-cloud-copy',
        selectedOptionalResourceIds: [],
        cloudCopyOf: wanted,
      }),
    ).rejects.toMatchObject({ kind: 'dependency-review' });
  });

  it('resends content collected in between once, and reports a change that landed first', async () => {
    const conflict = (): CanopyCloudClientError =>
      new CanopyCloudClientError('http-error', 'Conflict', 409);
    let attempts = 0;
    const collected = fakes(
      {
        upload: (upload) => {
          attempts += 1;
          if (attempts === 1) return Promise.reject(conflict());
          return Promise.resolve({
            marketplaceId: 'market-1',
            pluginKey: upload.pluginKey,
            contentHash: 'h'.repeat(64),
          });
        },
      },
      [[], [sha(COMMAND)]],
    );
    await publishPluginPackageToCloud(TARGET, PKG, SOURCE, collected.deps);
    expect(attempts).toBe(2);

    // A same-named plugin from another local marketplace is never retried
    // or replaced; the cloud's message names that marketplace.
    const taken = fakes(
      {
        upload: () =>
          Promise.reject(
            new CanopyCloudClientError(
              'http-error',
              'A plugin named notes from Team tools is already in your cloud marketplace. Remove it first or rename this one.',
              409,
              'plugin_name_taken',
            ),
          ),
      },
      [[], [sha(SKILL)]],
    );
    await expect(
      refusal(publishPluginPackageToCloud(TARGET, PKG, SOURCE, taken.deps)),
    ).resolves.toBe('publish-name-taken');
    expect(taken.recorded.asked).toHaveLength(1);

    const landed = fakes({ upload: () => Promise.reject(conflict()) }, [
      [],
      [],
    ]);
    await expect(
      refusal(publishPluginPackageToCloud(TARGET, PKG, SOURCE, landed.deps)),
    ).resolves.toBe('publish-revision-moved');
  });

  it("takes a real analysis of the plugin's folder: its manifest without hooks or MCP servers, and none of their files", async () => {
    const root = mkdtempSync(join(tmpdir(), 'publish-plugin-'));
    try {
      const write = (relative: string, text: string): void => {
        mkdirSync(dirname(join(root, relative)), { recursive: true });
        writeFileSync(join(root, relative), text);
      };
      write(
        '.claude-plugin/plugin.json',
        JSON.stringify({
          name: 'notes',
          version: '1.0.0',
          hooks: './hooks/hooks.json',
          mcpServers: { x: { command: 'rm' } },
        }),
      );
      write('skills/notes/SKILL.md', SKILL);
      write('skills/notes/reference.md', 'Reference.\n');
      write('commands/summarise.md', COMMAND);
      write('hooks/hooks.json', '{"hooks":{}}');
      write('.mcp.json', '{"mcpServers":{"x":{"command":"rm"}}}');
      const enableRef = {
        kind: 'plugin',
        marketplaceId: 'local-tools',
        pluginName: 'notes',
      } as const;
      const member = (
        id: string,
        kind: 'plugin_skill' | 'plugin_command',
        name: string,
      ): InvocableInventoryEntry => ({
        id,
        provider: 'claude',
        kind,
        name,
        displayName: name,
        description: '',
        insertText: `/notes:${name}`,
        invocationKey: `notes:${name}`,
        enableRef,
      });
      const source = (memberPath: string) =>
        ({
          sourceRoot: root,
          memberPath: join(root, memberPath),
          sourceVisibility: 'local',
          runtimeKind: 'plugin_fragment',
          rootName: 'notes',
        }) as const;
      const analysis = await analyzeCapabilityPackage({
        rawContent: '',
        invocableInventory: {
          version: 6,
          builtAt: '2026-11-11T00:00:00.000Z',
          entries: [
            member('e1', 'plugin_skill', 'notes'),
            member('e2', 'plugin_command', 'summarise'),
          ],
        },
        capabilityInventoryEntryIdsByKey: {
          'plugin:local-tools:notes': ['e1', 'e2'],
        },
        sourceByInventoryEntryId: {
          e1: source('skills/notes'),
          e2: source('commands/summarise.md'),
        },
        requests: [
          {
            key: 'plugin:local-tools:notes',
            provider: 'claude',
            required: true,
            bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
          },
        ],
      });
      const manifest = analysis.summary.manifest;
      if (analysis.summary.state !== 'ready' || manifest === undefined)
        throw new Error('the analysis is not ready');
      const { deps, recorded } = fakes(
        {
          readPackage: () =>
            Promise.resolve({
              manifest,
              readBlob: (hash) => {
                const bytes = analysis.blobs.get(hash);
                if (bytes === undefined) throw new Error('missing blob');
                return bytes;
              },
            }),
          // Nothing is held yet, so every file carries its content.
          missingBlobs: (hashes): Promise<string[]> =>
            Promise.resolve([...hashes]),
        },
        [[]],
      );
      await publishPluginPackageToCloud(TARGET, PKG, SOURCE, deps);
      const files = recorded.uploads[0]?.files ?? [];
      expect(files.map((file) => file.path).sort()).toEqual([
        '.claude-plugin/plugin.json',
        'commands/summarise.md',
        'skills/notes/SKILL.md',
        'skills/notes/reference.md',
      ]);
      const sentManifest: unknown = JSON.parse(
        Buffer.from(
          files.find((file) => file.path === '.claude-plugin/plugin.json')
            ?.content ?? '',
          'base64',
        ).toString('utf8'),
      );
      expect(sentManifest).toEqual({ name: 'notes', version: '1.0.0' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('declares custom component roots again, from the consented files only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'publish-plugin-roots-'));
    try {
      const write = (relative: string, text: string): void => {
        mkdirSync(dirname(join(root, relative)), { recursive: true });
        writeFileSync(join(root, relative), text);
      };
      write(
        '.claude-plugin/plugin.json',
        JSON.stringify({
          name: 'notes',
          commands: ['./custom-commands/run.md', './commands'],
          skills: './my-skills',
        }),
      );
      write('custom-commands/run.md', COMMAND);
      write('commands/summarise.md', COMMAND);
      write('my-skills/notes/SKILL.md', SKILL);
      const enableRef = {
        kind: 'plugin',
        marketplaceId: 'local-tools',
        pluginName: 'notes',
      } as const;
      const member = (
        id: string,
        kind: 'plugin_skill' | 'plugin_command',
        name: string,
      ): InvocableInventoryEntry => ({
        id,
        provider: 'claude',
        kind,
        name,
        displayName: name,
        description: '',
        insertText: `/notes:${name}`,
        invocationKey: `notes:${name}`,
        enableRef,
      });
      const source = (memberPath: string) =>
        ({
          sourceRoot: root,
          memberPath: join(root, memberPath),
          sourceVisibility: 'local',
          runtimeKind: 'plugin_fragment',
          rootName: 'notes',
        }) as const;
      const analysis = await analyzeCapabilityPackage({
        rawContent: '',
        invocableInventory: {
          version: 6,
          builtAt: '2026-11-11T00:00:00.000Z',
          entries: [
            member('e1', 'plugin_skill', 'notes'),
            member('e2', 'plugin_command', 'run'),
            member('e3', 'plugin_command', 'summarise'),
          ],
        },
        capabilityInventoryEntryIdsByKey: {
          'plugin:local-tools:notes': ['e1', 'e2', 'e3'],
        },
        sourceByInventoryEntryId: {
          e1: source('my-skills/notes'),
          e2: source('custom-commands/run.md'),
          e3: source('commands/summarise.md'),
        },
        requests: [
          {
            key: 'plugin:local-tools:notes',
            provider: 'claude',
            required: true,
            bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
          },
        ],
      });
      const manifest = analysis.summary.manifest;
      if (analysis.summary.state !== 'ready' || manifest === undefined)
        throw new Error('the analysis is not ready');
      const { deps, recorded } = fakes({
        readPackage: () =>
          Promise.resolve({
            manifest,
            readBlob: (hash) => {
              const bytes = analysis.blobs.get(hash);
              if (bytes === undefined) throw new Error('missing blob');
              return bytes;
            },
          }),
        missingBlobs: (hashes): Promise<string[]> =>
          Promise.resolve([...hashes]),
      });
      await publishPluginPackageToCloud(TARGET, PKG, SOURCE, deps);
      const files = recorded.uploads[0]?.files ?? [];
      const sent = files.find(
        (file) => file.path === '.claude-plugin/plugin.json',
      );
      const sentManifest: unknown = JSON.parse(
        Buffer.from(sent?.content ?? '', 'base64').toString('utf8'),
      );
      // The plugin's own declarations, as it declared them.
      expect(sentManifest).toEqual({
        name: 'notes',
        commands: ['./custom-commands/run.md', './commands'],
        skills: ['./my-skills'],
      });
      expect(sent?.sha256).toBe(
        createHash('sha256')
          .update(Buffer.from(sent?.content ?? '', 'base64'))
          .digest('hex'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uploads a linked doc and a named agent as supporting files, never declaring either as a command', async () => {
    const root = writePlugin({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'notes' }),
      'commands/run.md':
        '---\nagent: helper\n---\nRun it. See [the guide](../docs/guide.md).\n',
      'docs/guide.md': '---\ntitle: Guide\n---\nHow to run it.\n',
      'agents/helper.md': '---\nname: helper\n---\nHelps.\n',
    });
    try {
      const sent = await publishAnalysis(
        await analysePlugin(root, [
          { kind: 'plugin_command', name: 'run', path: 'commands/run.md' },
        ]),
      );
      expect(sent.paths).toEqual([
        '.claude-plugin/plugin.json',
        'agents/helper.md',
        'commands/run.md',
        'docs/guide.md',
      ]);
      // No declarations: the cloud reads its default roots, as the desktop does.
      expect(sent.manifest).toEqual({ name: 'notes' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("declares a custom command folder whole, so the command's helper script is inside it", async () => {
    const root = writePlugin({
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'notes',
        commands: './custom',
      }),
      'custom/run.md': 'Run [the helper](helper.sh).\n',
      'custom/helper.sh': 'echo helped\n',
    });
    try {
      const sent = await publishAnalysis(
        await analysePlugin(root, [
          { kind: 'plugin_command', name: 'run', path: 'custom/run.md' },
        ]),
      );
      expect(sent.paths).toEqual([
        '.claude-plugin/plugin.json',
        'custom/helper.sh',
        'custom/run.md',
      ]);
      // The cloud builder keeps files inside a declared root, so the helper
      // is built with the command (see desktop-plugin-upload.test.ts).
      expect(sent.manifest).toEqual({ name: 'notes', commands: ['./custom'] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a plugin whose plugin.json declares a component path outside it, and uploads nothing', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'publish-plugin-outside-'));
    writeFileSync(join(outside, 'secret.md'), 'Outside the plugin.\n');
    try {
      for (const declared of [
        '../outside',
        './commands/../../outside',
        outside,
        './linked',
        '.',
      ]) {
        const root = writePlugin({
          '.claude-plugin/plugin.json': JSON.stringify({
            name: 'notes',
            commands: ['./commands', declared],
          }),
          'commands/run.md': 'Run it.\n',
        });
        try {
          symlinkSync(outside, join(root, 'linked'));
          const analysis = await analysePlugin(root, [
            { kind: 'plugin_command', name: 'run', path: 'commands/run.md' },
          ]);
          expect(analysis.summary.state).not.toBe('ready');
          expect(analysis.summary.blockers).toContainEqual(
            expect.objectContaining({
              code: 'SOURCE_PATH_ESCAPE',
              relativePath: '.claude-plugin/plugin.json',
              message: `The plugin's plugin.json declares commands at ${JSON.stringify(declared)}, which is not inside the plugin.`,
            }),
          );
          for (const bytes of analysis.blobs.values())
            expect(Buffer.from(bytes).toString('utf8')).not.toContain(
              'Outside the plugin.',
            );
          await expect(publishAnalysis(analysis)).rejects.toThrow(
            'the analysis is not ready',
          );
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("gives a shared plugin's manifest its declared component paths and nothing else", async () => {
    const root = writePlugin({
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'notes',
        version: '2.0.0',
        description: 'Notes.',
        author: { name: 'Someone' },
        commands: ['./custom/', 'custom', './missing'],
        agents: './agents',
        hooks: './hooks/hooks.json',
        mcpServers: { x: { command: 'rm' } },
        lspServers: { y: { command: 'rm' } },
        outputStyles: './styles',
      }),
      'custom/run.md': 'Run it.\n',
      'agents/helper.md': '---\nname: helper\n---\nHelps.\n',
      'hooks/hooks.json': '{"hooks":{}}',
    });
    try {
      // Sharing installs this analysed manifest on another desktop.
      const analysis = await analysePlugin(root, [
        { kind: 'plugin_command', name: 'run', path: 'custom/run.md' },
      ]);
      expect(analysis.summary.state).toBe('ready');
      const entry = analysis.summary.manifest?.resources
        .flatMap((resource) => resource.trees)
        .flatMap((tree) => tree.entries)
        .find((file) => file.path === '.claude-plugin/plugin.json');
      const bytes = analysis.blobs.get(entry?.sha256 ?? '');
      expect(
        JSON.parse(Buffer.from(bytes ?? []).toString('utf8')) as unknown,
      ).toEqual({
        name: 'notes',
        version: '2.0.0',
        description: 'Notes.',
        commands: ['./custom'],
        agents: ['./agents'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Real git, run from the folder it is asked about, with no shell. */
function realGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      resolve(
        execFileSync('git', [...args], {
          cwd,
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: 'C' },
        }),
      );
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** A cloud copy analysis of the `notes` plugin's skill at `root`. */
function analyseNotes(
  root: string,
  gitIgnored: () => Promise<{
    isIgnored: (absolutePath: string) => boolean;
    checked: boolean;
  } | null>,
): ReturnType<typeof analyzeCapabilityPackage> {
  return analyzeCapabilityPackage({
    rawContent: '',
    cloudCopy: { gitIgnored },
    invocableInventory: {
      version: 6,
      builtAt: '2026-11-11T00:00:00.000Z',
      entries: [
        {
          id: 'e1',
          provider: 'claude',
          kind: 'plugin_skill',
          name: 'notes',
          displayName: 'notes',
          description: '',
          insertText: '/notes:notes',
          invocationKey: 'notes:notes',
          enableRef: {
            kind: 'plugin',
            marketplaceId: 'local-tools',
            pluginName: 'notes',
          },
        },
      ],
    },
    capabilityInventoryEntryIdsByKey: { 'plugin:local-tools:notes': ['e1'] },
    sourceByInventoryEntryId: {
      e1: {
        sourceRoot: root,
        memberPath: join(root, 'skills/notes'),
        sourceVisibility: 'local',
        runtimeKind: 'plugin_fragment',
        rootName: 'notes',
      },
    },
    requests: [
      {
        key: 'plugin:local-tools:notes',
        provider: 'claude',
        required: true,
        bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
      },
    ],
  });
}

describe("a local plugin's cloud copy withholds what a share would block on (CAN-6176 9c)", () => {
  it('lists a secret-named file, a symlink and a git-ignored file with their reasons, never uploads them, and still uploads the rest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'publish-plugin-withhold-'));
    try {
      const write = (relative: string, text: string): void => {
        mkdirSync(dirname(join(root, relative)), { recursive: true });
        writeFileSync(join(root, relative), text);
      };
      write('.claude-plugin/plugin.json', JSON.stringify({ name: 'notes' }));
      write('skills/notes/SKILL.md', SKILL);
      write('skills/notes/reference.md', 'Reference.\n');
      write('skills/notes/.env', 'TOKEN=abc\n');
      write('skills/notes/drafts.local.md', 'Private drafts.\n');
      symlinkSync('/etc/hosts', join(root, 'skills/notes/hosts'));
      const member: InvocableInventoryEntry = {
        id: 'e1',
        provider: 'claude',
        kind: 'plugin_skill',
        name: 'notes',
        displayName: 'notes',
        description: '',
        insertText: '/notes:notes',
        invocationKey: 'notes:notes',
        enableRef: {
          kind: 'plugin',
          marketplaceId: 'local-tools',
          pluginName: 'notes',
        },
      };
      const analyse = (
        cloudCopy?: Parameters<typeof analyzeCapabilityPackage>[0]['cloudCopy'],
      ): ReturnType<typeof analyzeCapabilityPackage> =>
        analyzeCapabilityPackage({
          rawContent: '',
          ...(cloudCopy === undefined ? {} : { cloudCopy }),
          invocableInventory: {
            version: 6,
            builtAt: '2026-11-11T00:00:00.000Z',
            entries: [member],
          },
          capabilityInventoryEntryIdsByKey: {
            'plugin:local-tools:notes': ['e1'],
          },
          sourceByInventoryEntryId: {
            e1: {
              sourceRoot: root,
              memberPath: join(root, 'skills/notes'),
              sourceVisibility: 'local',
              runtimeKind: 'plugin_fragment',
              rootName: 'notes',
            },
          },
          requests: [
            {
              key: 'plugin:local-tools:notes',
              provider: 'claude',
              required: true,
              bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
            },
          ],
        });

      // A share blocks on these files, as before.
      expect((await analyse()).summary.state).toBe('blocked');

      const analysis = await analyse({
        gitIgnored: () =>
          Promise.resolve(
            checkedBy((absolutePath: string) =>
              absolutePath.endsWith('drafts.local.md'),
            ),
          ),
      });
      expect(analysis.summary.state).toBe('ready');
      expect(analysis.summary.gitIgnoreCheck).toBe('checked');
      expect(analysis.summary.withheldMemberFiles).toEqual([
        {
          rootName: 'notes',
          relativePath: 'skills/notes/.env',
          reason: 'denied_name',
        },
        {
          rootName: 'notes',
          relativePath: 'skills/notes/drafts.local.md',
          reason: 'git_ignored',
        },
        {
          rootName: 'notes',
          relativePath: 'skills/notes/hosts',
          reason: 'symlink',
        },
      ]);
      const manifest = analysis.summary.manifest;
      if (manifest === undefined) throw new Error('no manifest');
      const { deps, recorded } = fakes({
        readPackage: () =>
          Promise.resolve({
            manifest,
            readBlob: (hash) => {
              const bytes = analysis.blobs.get(hash);
              if (bytes === undefined) throw new Error('missing blob');
              return bytes;
            },
          }),
        missingBlobs: (hashes): Promise<string[]> =>
          Promise.resolve([...hashes]),
      });
      await publishPluginPackageToCloud(TARGET, PKG, SOURCE, deps);
      expect(
        (recorded.uploads[0]?.files ?? []).map((file) => file.path).sort(),
      ).toEqual([
        '.claude-plugin/plugin.json',
        'skills/notes/SKILL.md',
        'skills/notes/reference.md',
      ]);

      // When git can't say, the copy still goes and the analysis says so.
      const unchecked = await analyse({
        gitIgnored: () => Promise.resolve(null),
      });
      expect(unchecked.summary.gitIgnoreCheck).toBe('unavailable');
      expect(
        unchecked.summary.withheldMemberFiles?.map((file) => file.reason),
      ).toEqual(['denied_name', 'symlink']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never withholds a skill's own SKILL.md: a secret or git-ignored one still blocks the skill's copy", async () => {
    const root = mkdtempSync(join(tmpdir(), 'publish-skill-entry-'));
    try {
      mkdirSync(join(root, 'helper'), { recursive: true });
      const analyse = (
        skill: string,
        isIgnored: ((absolutePath: string) => boolean) | null,
      ): ReturnType<typeof analyzeCapabilityPackage> => {
        writeFileSync(join(root, 'helper', 'SKILL.md'), skill);
        return analyzeCapabilityPackage({
          rawContent: skill,
          cloudCopy: {
            gitIgnored: () =>
              Promise.resolve(isIgnored === null ? null : checkedBy(isIgnored)),
          },
          invocableInventory: {
            version: 6,
            builtAt: '2026-11-11T00:00:00.000Z',
            entries: [
              {
                id: 'e1',
                provider: 'claude',
                kind: 'skill',
                name: 'helper',
                displayName: 'helper',
                description: '',
                insertText: '/helper',
                invocationKey: 'helper',
                enableRef: {
                  kind: 'skill',
                  sourceId: 'custom:app',
                  skillName: 'helper',
                },
              },
            ],
          },
          capabilityInventoryEntryIdsByKey: {
            'skill:custom:app:helper': ['e1'],
          },
          sourceByInventoryEntryId: {
            e1: {
              sourceRoot: root,
              memberPath: join(root, 'helper'),
              sourceVisibility: 'local',
              runtimeKind: 'standalone_skill',
              rootName: 'helper',
            },
          },
          requests: [
            {
              key: 'skill:custom:app:helper',
              provider: 'claude',
              required: true,
              bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
            },
          ],
        });
      };
      // A skill publish sends its SKILL.md as the skill itself, so leaving
      // it out of the package would not keep a secret here.
      // The key's header is built here so this source never holds one: the
      // public export refuses any file that does.
      const keyLabel = ['RSA', 'PRIVATE', 'KEY'].join(' ');
      const secret = await analyse(
        `${SKILL}\n-----BEGIN ${keyLabel}-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MaWxS0o\n-----END ${keyLabel}-----\n`,
        null,
      );
      expect(secret.summary.state).toBe('blocked');
      expect(secret.summary.withheldMemberFiles ?? []).toEqual([]);
      const ignored = await analyse(SKILL, (absolutePath) =>
        absolutePath.endsWith('SKILL.md'),
      );
      expect(ignored.summary.state).toBe('blocked');
      expect(ignored.summary.withheldMemberFiles ?? []).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks on a secret in a skill's lowercase skill.md, which a case-insensitive disk loads as its SKILL.md", async () => {
    const root = mkdtempSync(join(tmpdir(), 'publish-skill-lowercase-'));
    try {
      mkdirSync(join(root, 'helper'), { recursive: true });
      // Built here so this source never holds a key header.
      const keyLabel = ['RSA', 'PRIVATE', 'KEY'].join(' ');
      const skill = `${SKILL}\n-----BEGIN ${keyLabel}-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MaWxS0o\n-----END ${keyLabel}-----\n`;
      writeFileSync(join(root, 'helper', 'skill.md'), skill);
      const analysis = await analyzeCapabilityPackage({
        rawContent: skill,
        cloudCopy: { gitIgnored: () => Promise.resolve(null) },
        invocableInventory: {
          version: 6,
          builtAt: '2026-11-11T00:00:00.000Z',
          entries: [standaloneSkill('e1', 'helper')],
        },
        capabilityInventoryEntryIdsByKey: { 'skill:custom:app:helper': ['e1'] },
        sourceByInventoryEntryId: { e1: skillFolder(root, 'helper') },
        requests: [
          {
            key: 'skill:custom:app:helper',
            provider: 'claude',
            required: true,
            bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
          },
        ],
      });
      // The publish sends that file as the skill itself, so it can't be
      // withheld: the copy blocks, whatever the file's casing.
      expect(analysis.summary.state).toBe('blocked');
      expect(analysis.summary.withheldMemberFiles ?? []).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks git-ignored files in each skill a skill invokes from that skill's own folder", async () => {
    const root = mkdtempSync(join(tmpdir(), 'publish-skill-dependency-'));
    try {
      mkdirSync(join(root, 'helper'), { recursive: true });
      mkdirSync(join(root, 'notes'), { recursive: true });
      const skill =
        '---\nname: helper\ndescription: Helps\n---\nUse /notes first.\n';
      writeFileSync(join(root, 'helper', 'SKILL.md'), skill);
      writeFileSync(
        join(root, 'notes', 'SKILL.md'),
        '---\nname: notes\ndescription: Notes\n---\nTake notes.\n',
      );
      const PRIVATE_NOTES = 'private-dependency-notes-4417';
      writeFileSync(join(root, 'notes', 'notes.local.md'), PRIVATE_NOTES);
      const asked: string[] = [];
      const analyse = (
        notesCheck: 'ignored' | 'unavailable',
      ): ReturnType<typeof analyzeCapabilityPackage> =>
        analyzeCapabilityPackage({
          rawContent: skill,
          cloudCopy: {
            gitIgnored: (descriptor) => {
              asked.push(descriptor.rootName);
              if (descriptor.rootName !== 'notes')
                return Promise.resolve(checkedBy(() => false));
              return Promise.resolve(
                notesCheck === 'unavailable'
                  ? null
                  : checkedBy(
                      (absolutePath: string): boolean =>
                        absolutePath === join(root, 'notes', 'notes.local.md'),
                    ),
              );
            },
          },
          invocableInventory: {
            version: 6,
            builtAt: '2026-11-11T00:00:00.000Z',
            entries: [
              standaloneSkill('e1', 'helper'),
              standaloneSkill('e2', 'notes'),
            ],
          },
          capabilityInventoryEntryIdsByKey: {
            'skill:custom:app:helper': ['e1'],
          },
          sourceByInventoryEntryId: {
            e1: skillFolder(root, 'helper'),
            e2: skillFolder(root, 'notes'),
          },
          requests: (['claude'] as const).map((provider) => ({
            key: 'skill:custom:app:helper',
            provider,
            required: true,
            bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
          })),
        });
      const analysis = await analyse('ignored');
      expect(asked).toContain('notes');
      expect(analysis.summary.gitIgnoreCheck).toBe('checked');
      expect(analysis.summary.withheldMemberFiles).toEqual([
        {
          rootName: 'notes',
          relativePath: 'notes.local.md',
          reason: 'git_ignored',
        },
      ]);
      // Nothing of it is packaged.
      for (const bytes of analysis.blobs.values())
        expect(Buffer.from(bytes).toString('utf8')).not.toContain(
          PRIVATE_NOTES,
        );
      // A dependency git can't check is reported, not passed off as checked.
      expect((await analyse('unavailable')).summary.gitIgnoreCheck).toBe(
        'unavailable',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("withholds a plugin's git-ignored command file, which a plugin upload would otherwise send", async () => {
    const root = mkdtempSync(join(tmpdir(), 'publish-plugin-command-'));
    try {
      mkdirSync(join(root, '.claude-plugin'), { recursive: true });
      mkdirSync(join(root, 'commands'), { recursive: true });
      writeFileSync(
        join(root, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'notes' }),
      );
      writeFileSync(join(root, 'commands', 'private.md'), COMMAND);
      writeFileSync(join(root, 'commands', 'summarise.md'), COMMAND);
      const member = (id: string, name: string): InvocableInventoryEntry => ({
        id,
        provider: 'claude',
        kind: 'plugin_command',
        name,
        displayName: name,
        description: '',
        insertText: `/notes:${name}`,
        invocationKey: `notes:${name}`,
        enableRef: {
          kind: 'plugin',
          marketplaceId: 'local-tools',
          pluginName: 'notes',
        },
      });
      const source = (file: string) =>
        ({
          sourceRoot: root,
          memberPath: join(root, 'commands', file),
          sourceVisibility: 'local',
          runtimeKind: 'plugin_fragment',
          rootName: 'notes',
        }) as const;
      const analysis = await analyzeCapabilityPackage({
        rawContent: '',
        cloudCopy: {
          gitIgnored: () =>
            Promise.resolve(
              checkedBy((absolutePath: string) =>
                absolutePath.endsWith('private.md'),
              ),
            ),
        },
        invocableInventory: {
          version: 6,
          builtAt: '2026-11-11T00:00:00.000Z',
          entries: [member('e1', 'private'), member('e2', 'summarise')],
        },
        capabilityInventoryEntryIdsByKey: {
          'plugin:local-tools:notes': ['e1', 'e2'],
        },
        sourceByInventoryEntryId: {
          e1: source('private.md'),
          e2: source('summarise.md'),
        },
        requests: [
          {
            key: 'plugin:local-tools:notes',
            provider: 'claude',
            required: true,
            bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
          },
        ],
      });
      expect(analysis.summary.state).toBe('ready');
      expect(analysis.summary.withheldMemberFiles).toEqual([
        {
          rootName: 'notes',
          relativePath: 'commands/private.md',
          reason: 'git_ignored',
        },
      ]);
      const paths = (analysis.summary.manifest?.resources ?? []).flatMap(
        (resource) =>
          resource.trees.flatMap((tree) =>
            tree.entries.map((entry) => entry.path),
          ),
      );
      expect(paths).toContain('commands/summarise.md');
      expect(paths).not.toContain('commands/private.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('withholds a git-ignored plugin.json unread, so nothing of it leaves', async () => {
    const root = mkdtempSync(join(tmpdir(), 'publish-plugin-manifest-'));
    try {
      mkdirSync(join(root, '.claude-plugin'), { recursive: true });
      mkdirSync(join(root, 'commands'), { recursive: true });
      writeFileSync(
        join(root, '.claude-plugin', 'plugin.json'),
        JSON.stringify({
          name: 'notes',
          description: 'Internal roadmap helper for the acquisition',
        }),
      );
      writeFileSync(join(root, 'commands', 'summarise.md'), COMMAND);
      const analysis = await analyzeCapabilityPackage({
        rawContent: '',
        cloudCopy: {
          gitIgnored: () =>
            Promise.resolve(
              checkedBy((absolutePath: string) =>
                absolutePath.endsWith('plugin.json'),
              ),
            ),
        },
        invocableInventory: {
          version: 6,
          builtAt: '2026-11-11T00:00:00.000Z',
          entries: [
            {
              id: 'e1',
              provider: 'claude',
              kind: 'plugin_command',
              name: 'summarise',
              displayName: 'summarise',
              description: '',
              insertText: '/notes:summarise',
              invocationKey: 'notes:summarise',
              enableRef: {
                kind: 'plugin',
                marketplaceId: 'local-tools',
                pluginName: 'notes',
              },
            },
          ],
        },
        capabilityInventoryEntryIdsByKey: {
          'plugin:local-tools:notes': ['e1'],
        },
        sourceByInventoryEntryId: {
          e1: {
            sourceRoot: root,
            memberPath: join(root, 'commands', 'summarise.md'),
            sourceVisibility: 'local',
            runtimeKind: 'plugin_fragment',
            rootName: 'notes',
          },
        },
        requests: [
          {
            key: 'plugin:local-tools:notes',
            provider: 'claude',
            required: true,
            bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
          },
        ],
      });
      expect(analysis.summary.state).toBe('ready');
      expect(analysis.summary.withheldMemberFiles).toEqual([
        {
          rootName: 'notes',
          relativePath: '.claude-plugin/plugin.json',
          reason: 'git_ignored',
        },
      ]);
      // Not its name, not its description, not its bytes.
      expect(JSON.stringify(analysis.summary)).not.toContain('acquisition');
      const blobs = [...analysis.blobs.values()].map((bytes) =>
        Buffer.from(bytes).toString('utf8'),
      );
      expect(blobs.some((text) => text.includes('acquisition'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('withholds a plugin.json that looks like it holds a secret from a cloud copy, and still blocks a share on it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'publish-plugin-manifest-secret-'));
    try {
      mkdirSync(join(root, '.claude-plugin'), { recursive: true });
      mkdirSync(join(root, 'commands'), { recursive: true });
      // Built here so this source never holds a key header.
      const keyLabel = ['RSA', 'PRIVATE', 'KEY'].join(' ');
      writeFileSync(
        join(root, '.claude-plugin', 'plugin.json'),
        JSON.stringify({
          name: 'notes',
          description: `-----BEGIN ${keyLabel}-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MaWxS0o\n-----END ${keyLabel}-----`,
        }),
      );
      writeFileSync(join(root, 'commands', 'summarise.md'), COMMAND);
      const analyse = (
        cloudCopy: Parameters<typeof analyzeCapabilityPackage>[0]['cloudCopy'],
      ): ReturnType<typeof analyzeCapabilityPackage> =>
        analyzeCapabilityPackage({
          rawContent: '',
          ...(cloudCopy === undefined ? {} : { cloudCopy }),
          invocableInventory: {
            version: 6,
            builtAt: '2026-11-11T00:00:00.000Z',
            entries: [
              {
                id: 'e1',
                provider: 'claude',
                kind: 'plugin_command',
                name: 'summarise',
                displayName: 'summarise',
                description: '',
                insertText: '/notes:summarise',
                invocationKey: 'notes:summarise',
                enableRef: {
                  kind: 'plugin',
                  marketplaceId: 'local-tools',
                  pluginName: 'notes',
                },
              },
            ],
          },
          capabilityInventoryEntryIdsByKey: {
            'plugin:local-tools:notes': ['e1'],
          },
          sourceByInventoryEntryId: {
            e1: {
              sourceRoot: root,
              memberPath: join(root, 'commands', 'summarise.md'),
              sourceVisibility: 'local',
              runtimeKind: 'plugin_fragment',
              rootName: 'notes',
            },
          },
          requests: [
            {
              key: 'plugin:local-tools:notes',
              provider: 'claude',
              required: true,
              bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
            },
          ],
        });
      const copy = await analyse({ gitIgnored: () => Promise.resolve(null) });
      expect(copy.summary.state).toBe('ready');
      expect(copy.summary.withheldMemberFiles).toEqual([
        {
          rootName: 'notes',
          relativePath: '.claude-plugin/plugin.json',
          reason: 'suspected_secret',
        },
      ]);
      for (const bytes of copy.blobs.values())
        expect(Buffer.from(bytes).toString('utf8')).not.toContain(
          'MIIEowIBAAK',
        );

      // A share of the same plugin still blocks on it.
      const share = await analyse(undefined);
      expect(share.summary.state).toBe('blocked');
      expect(share.summary.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'SUSPECTED_SECRET' }),
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("asks git for the folder's ignored files, and reports when it can't", async () => {
    const root = join(tmpdir(), 'plugin-root');
    const calls: string[][] = [];
    const ignored = await gitIgnoredPredicate(root, (_cwd, args) => {
      calls.push([...args]);
      return args[0] === 'check-ignore'
        ? Promise.reject(new Error('not ignored'))
        : Promise.resolve('drafts.local.md\0build/\0');
    });
    expect(ignored.isIgnored(join(root, 'drafts.local.md'))).toBe(true);
    expect(ignored.isIgnored(join(root, 'build', 'out', 'x.js'))).toBe(true);
    expect(ignored.isIgnored(join(root, 'skills', 'SKILL.md'))).toBe(false);
    expect(calls[1]?.slice(0, 4)).toEqual([
      'ls-files',
      '-z',
      '--others',
      '--ignored',
    ]);

    expect(ignored.checked).toBe(true);
    // Not a repository, or no git: no answer, so the copy says it went
    // unchecked.
    const none = await gitIgnoredPredicate(root, () =>
      Promise.reject(new Error('no git')),
    );
    expect(none.checked).toBe(false);
    expect(none.isIgnored(join(root, 'skills', 'SKILL.md'))).toBe(false);
    // A folder git ignores as a whole: nothing under it counts as ignored.
    const whole = await gitIgnoredPredicate(root, () => Promise.resolve(''));
    expect(whole.checked).toBe(true);
    expect(whole.isIgnored(join(root, 'skills', 'SKILL.md'))).toBe(false);
  });

  it("withholds a file a nested checkout's own .gitignore excludes, and none of its bytes leave", async () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-nested-repo-'));
    const PRIVATE = 'private-nested-notes-7731';
    try {
      const write = (relative: string, text: string): void => {
        mkdirSync(dirname(join(root, relative)), { recursive: true });
        writeFileSync(join(root, relative), text);
      };
      execFileSync('git', ['init', '-q'], { cwd: root });
      write('.claude-plugin/plugin.json', JSON.stringify({ name: 'notes' }));
      write('skills/notes/SKILL.md', SKILL);
      // A checkout nested in the plugin, ignoring a file of its own.
      const nested = join(root, 'skills', 'notes', 'vendor');
      mkdirSync(nested, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: nested });
      write('skills/notes/vendor/.gitignore', 'private-notes.md\n');
      write('skills/notes/vendor/private-notes.md', PRIVATE);
      write('skills/notes/vendor/guide.md', 'Vendor guide.\n');
      const member: InvocableInventoryEntry = {
        id: 'e1',
        provider: 'claude',
        kind: 'plugin_skill',
        name: 'notes',
        displayName: 'notes',
        description: '',
        insertText: '/notes:notes',
        invocationKey: 'notes:notes',
        enableRef: {
          kind: 'plugin',
          marketplaceId: 'local-tools',
          pluginName: 'notes',
        },
      };
      const analysis = await analyzeCapabilityPackage({
        rawContent: '',
        cloudCopy: { gitIgnored: () => gitIgnoredPredicate(root, realGit) },
        invocableInventory: {
          version: 6,
          builtAt: '2026-11-11T00:00:00.000Z',
          entries: [member],
        },
        capabilityInventoryEntryIdsByKey: {
          'plugin:local-tools:notes': ['e1'],
        },
        sourceByInventoryEntryId: {
          e1: {
            sourceRoot: root,
            memberPath: join(root, 'skills/notes'),
            sourceVisibility: 'local',
            runtimeKind: 'plugin_fragment',
            rootName: 'notes',
          },
        },
        requests: [
          {
            key: 'plugin:local-tools:notes',
            provider: 'claude',
            required: true,
            bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
          },
        ],
      });
      expect(analysis.summary.state).toBe('ready');
      expect(analysis.summary.withheldMemberFiles).toContainEqual({
        rootName: 'notes',
        relativePath: 'skills/notes/vendor/private-notes.md',
        reason: 'git_ignored',
      });
      // Not one byte of it is in the package or the upload.
      for (const bytes of analysis.blobs.values())
        expect(Buffer.from(bytes).toString('utf8')).not.toContain(PRIVATE);
      const manifest = analysis.summary.manifest;
      if (manifest === undefined) throw new Error('no manifest');
      const { deps, recorded } = fakes({
        readPackage: () =>
          Promise.resolve({
            manifest,
            readBlob: (hash) => {
              const bytes = analysis.blobs.get(hash);
              if (bytes === undefined) throw new Error('missing blob');
              return bytes;
            },
          }),
        missingBlobs: (hashes): Promise<string[]> =>
          Promise.resolve([...hashes]),
      });
      await publishPluginPackageToCloud(TARGET, PKG, SOURCE, deps);
      const sent = recorded.uploads[0]?.files ?? [];
      expect(sent.map((file) => file.path)).toContain(
        'skills/notes/vendor/guide.md',
      );
      expect(sent.map((file) => file.path)).not.toContain(
        'skills/notes/vendor/private-notes.md',
      );
      for (const file of sent)
        expect(
          Buffer.from(file.content ?? '', 'base64').toString('utf8'),
        ).not.toContain(PRIVATE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("withholds a nested repository whole when git can't answer for it: no git, or a .git file whose gitdir is gone", async () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-nested-unreadable-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      // A worktree or submodule pointer whose repository isn't there.
      const pointer = join(root, 'skills', 'pointer');
      mkdirSync(pointer, { recursive: true });
      writeFileSync(join(pointer, '.git'), 'gitdir: ../../.git/modules/gone\n');
      writeFileSync(join(pointer, 'notes.md'), 'unchecked');
      writeFileSync(join(root, 'skills', 'README.md'), 'outer');
      const ignored = await gitIgnoredPredicate(root, realGit);
      expect(ignored.isIgnored(join(pointer, 'notes.md'))).toBe(true);
      expect(ignored.isIgnored(join(root, 'skills', 'README.md'))).toBe(false);

      // No git at all: the nested repository still counts as ignored whole.
      const noGit = await gitIgnoredPredicate(root, () =>
        Promise.reject(new Error('spawn git ENOENT')),
      );
      expect(noGit.isIgnored(join(pointer, 'notes.md'))).toBe(true);
      // But git never answered for the plugin's own repository, so the copy
      // says the check was unavailable rather than done.
      expect(noGit.checked).toBe(false);
      expect(ignored.checked).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says the check was unavailable when git can't answer for the plugin's own repository, though a nested one is still withheld", async () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-outer-unanswered-'));
    try {
      mkdirSync(join(root, '.claude-plugin'), { recursive: true });
      writeFileSync(
        join(root, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'notes' }),
      );
      const pointer = join(root, 'skills', 'notes', 'vendor');
      mkdirSync(pointer, { recursive: true });
      writeFileSync(join(root, 'skills', 'notes', 'SKILL.md'), SKILL);
      writeFileSync(join(pointer, '.git'), 'gitdir: ../../../.git/gone\n');
      writeFileSync(join(pointer, 'notes.md'), 'unchecked-vendor-notes');
      const analysis = await analyseNotes(root, () =>
        gitIgnoredPredicate(root, () =>
          Promise.reject(new Error('spawn git ENOENT')),
        ),
      );
      expect(analysis.summary.state).toBe('ready');
      expect(analysis.summary.gitIgnoreCheck).toBe('unavailable');
      expect(analysis.summary.withheldMemberFiles).toContainEqual({
        rootName: 'notes',
        relativePath: 'skills/notes/vendor',
        reason: 'git_ignored',
      });
      for (const bytes of analysis.blobs.values())
        expect(Buffer.from(bytes).toString('utf8')).not.toContain(
          'unchecked-vendor-notes',
        );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("asks a nested checkout for its own ignores even when the plugin's folder is ignored whole by the repository around it", async () => {
    const outer = mkdtempSync(join(tmpdir(), 'plugin-ignored-root-'));
    const PRIVATE = 'private-under-ignored-root-5512';
    try {
      execFileSync('git', ['init', '-q'], { cwd: outer });
      writeFileSync(join(outer, '.gitignore'), 'plugin/\n');
      const root = join(outer, 'plugin');
      const vendor = join(root, 'skills', 'notes', 'vendor');
      mkdirSync(join(root, '.claude-plugin'), { recursive: true });
      mkdirSync(vendor, { recursive: true });
      writeFileSync(
        join(root, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'notes' }),
      );
      writeFileSync(join(root, 'skills', 'notes', 'SKILL.md'), SKILL);
      execFileSync('git', ['init', '-q'], { cwd: vendor });
      writeFileSync(join(vendor, '.gitignore'), 'private-notes.md\n');
      writeFileSync(join(vendor, 'private-notes.md'), PRIVATE);
      writeFileSync(join(vendor, 'guide.md'), 'Vendor guide.\n');
      const analysis = await analyseNotes(root, () =>
        gitIgnoredPredicate(root, realGit),
      );
      expect(analysis.summary.state).toBe('ready');
      expect(analysis.summary.gitIgnoreCheck).toBe('checked');
      expect(analysis.summary.withheldMemberFiles).toContainEqual({
        rootName: 'notes',
        relativePath: 'skills/notes/vendor/private-notes.md',
        reason: 'git_ignored',
      });
      for (const bytes of analysis.blobs.values())
        expect(Buffer.from(bytes).toString('utf8')).not.toContain(PRIVATE);
      const packaged = (analysis.summary.manifest?.resources ?? [])
        .flatMap((resource) => resource.trees)
        .flatMap((tree) => tree.entries)
        .map((entry) => entry.path);
      // The plugin's own files still go: the outer repository's ignore of
      // the whole folder is not a file-by-file answer.
      expect(packaged).toContain('skills/notes/vendor/guide.md');
      expect(packaged).toContain('skills/notes/SKILL.md');
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it("never runs a command a scanned repository's own config names, such as core.fsmonitor", async () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-fsmonitor-'));
    const marker = join(root, 'fsmonitor-ran');
    try {
      const plant = (dir: string): void => {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        writeFileSync(join(dir, '.gitignore'), 'ignored.md\n');
        writeFileSync(join(dir, 'ignored.md'), 'ignored');
        writeFileSync(join(dir, 'tracked.md'), 'tracked');
        execFileSync('git', ['add', 'tracked.md', '.gitignore'], { cwd: dir });
        // Last, so setting up the repository doesn't run it.
        execFileSync(
          'git',
          ['config', 'core.fsmonitor', `touch '${marker}'; false`],
          { cwd: dir },
        );
      };
      // The plugin's own repository and one nested in it both carry it.
      plant(root);
      const nested = join(root, 'skills', 'notes', 'vendor');
      mkdirSync(nested, { recursive: true });
      plant(nested);
      expect(existsSync(marker)).toBe(false);
      // The default runner: the one a real cloud copy uses.
      const answer = await gitIgnoredPredicate(root);
      expect(answer.checked).toBe(true);
      expect(answer.isIgnored(join(root, 'ignored.md'))).toBe(true);
      expect(answer.isIgnored(join(nested, 'ignored.md'))).toBe(true);
      expect(answer.isIgnored(join(root, 'tracked.md'))).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never runs a filter, ssh command, pager or askpass a scanned repository's config names", async () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-config-commands-'));
    const marker = (name: string): string => join(root, `ran-${name}`);
    const commands = {
      'filter.planted.process': 'process',
      'filter.planted.clean': 'clean',
      'filter.planted.smudge': 'smudge',
      'core.sshCommand': 'ssh',
      'core.pager': 'pager',
      'core.askPass': 'askpass',
    } as const;
    try {
      const plant = (dir: string): void => {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        writeFileSync(join(dir, '.gitattributes'), '* filter=planted\n');
        writeFileSync(join(dir, '.gitignore'), 'ignored.md\n');
        writeFileSync(join(dir, 'ignored.md'), 'ignored');
        writeFileSync(join(dir, 'tracked.md'), 'tracked');
        execFileSync('git', ['add', 'tracked.md', '.gitignore'], { cwd: dir });
        // Last, so setting up the repository doesn't run them.
        for (const [key, name] of Object.entries(commands))
          execFileSync(
            'git',
            ['config', key, `touch '${marker(name)}'; false`],
            { cwd: dir },
          );
      };
      plant(root);
      const nested = join(root, 'skills', 'notes', 'vendor');
      mkdirSync(nested, { recursive: true });
      plant(nested);
      const answer = await gitIgnoredPredicate(root);
      expect(answer.checked).toBe(true);
      expect(answer.isIgnored(join(root, 'ignored.md'))).toBe(true);
      expect(answer.isIgnored(join(nested, 'ignored.md'))).toBe(true);
      expect(answer.isIgnored(join(root, 'tracked.md'))).toBe(false);
      for (const name of Object.values(commands))
        expect(existsSync(marker(name))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('withholds an ignored file reached through another spelling of the plugin root', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'plugin-root-case-'));
    const root = join(parent, 'notes-plugin');
    // The same folder, its name in another case: one folder on a
    // case-insensitive disk (macOS and Windows by default).
    const alias = join(parent, 'NOTES-PLUGIN');
    try {
      mkdirSync(join(root, 'skills', 'notes'), { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: root });
      writeFileSync(join(root, '.gitignore'), 'secret.local.md\n');
      writeFileSync(join(root, 'skills', 'notes', 'secret.local.md'), 'x');
      writeFileSync(join(root, 'skills', 'notes', 'SKILL.md'), SKILL);
      const answer = await gitIgnoredPredicate(root, realGit);
      expect(
        answer.isIgnored(join(root, 'skills', 'notes', 'secret.local.md')),
      ).toBe(true);
      if (existsSync(alias)) {
        expect(
          answer.isIgnored(join(alias, 'skills', 'notes', 'secret.local.md')),
        ).toBe(true);
        expect(
          answer.isIgnored(join(alias, 'skills', 'notes', 'SKILL.md')),
        ).toBe(false);
      }
      // And through a link to the root.
      symlinkSync(root, join(parent, 'linked'));
      expect(
        answer.isIgnored(
          join(parent, 'linked', 'skills', 'notes', 'secret.local.md'),
        ),
      ).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('matches an ignored file by identity, so another name for it is ignored too', async () => {
    // A case-insensitive disk opens `ZZ-PRIVATE.md` as the ignored
    // `zz-private.md`; a hard link is another name for one file on any disk.
    const root = mkdtempSync(join(tmpdir(), 'plugin-ignored-identity-'));
    try {
      mkdirSync(join(root, 'skills', 'notes'), { recursive: true });
      const PRIVATE = 'private-notes-identity-4417';
      writeFileSync(join(root, 'skills', 'notes', 'zz-private.md'), PRIVATE);
      linkSync(
        join(root, 'skills', 'notes', 'zz-private.md'),
        join(root, 'skills', 'notes', 'other-name.md'),
      );
      writeFileSync(
        join(root, 'skills', 'notes', 'SKILL.md'),
        '---\nname: notes\ndescription: Notes\n---\nTake notes.\n',
      );
      const ignored = await gitIgnoredPredicate(root, (_cwd, args) =>
        args[0] === 'check-ignore'
          ? Promise.reject(new Error('not ignored'))
          : Promise.resolve('skills/notes/zz-private.md\0'),
      );
      expect(
        ignored.isIgnored(join(root, 'skills', 'notes', 'zz-private.md')),
      ).toBe(true);
      expect(
        ignored.isIgnored(join(root, 'skills', 'notes', 'other-name.md')),
      ).toBe(true);
      expect(ignored.isIgnored(join(root, 'skills', 'notes', 'SKILL.md'))).toBe(
        false,
      );

      const analysis = await analyzeCapabilityPackage({
        rawContent: '',
        cloudCopy: { gitIgnored: () => Promise.resolve(ignored) },
        invocableInventory: {
          version: 6,
          builtAt: '2026-11-11T00:00:00.000Z',
          entries: [
            {
              id: 'e1',
              provider: 'claude',
              kind: 'plugin_skill',
              name: 'notes',
              displayName: 'notes',
              description: '',
              insertText: '/notes:notes',
              invocationKey: 'notes:notes',
              enableRef: {
                kind: 'plugin',
                marketplaceId: 'local-tools',
                pluginName: 'notes',
              },
            },
          ],
        },
        capabilityInventoryEntryIdsByKey: {
          'plugin:local-tools:notes': ['e1'],
        },
        sourceByInventoryEntryId: {
          e1: {
            sourceRoot: root,
            memberPath: join(root, 'skills', 'notes'),
            sourceVisibility: 'local',
            runtimeKind: 'plugin_fragment',
            rootName: 'notes',
            syntheticManifestName: 'notes',
          },
        },
        requests: [
          {
            key: 'plugin:local-tools:notes',
            provider: 'claude',
            required: true,
            bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
          },
        ],
      });
      expect(analysis.summary.withheldMemberFiles).toEqual(
        expect.arrayContaining([
          {
            rootName: 'notes',
            relativePath: 'skills/notes/other-name.md',
            reason: 'git_ignored',
          },
          {
            rootName: 'notes',
            relativePath: 'skills/notes/zz-private.md',
            reason: 'git_ignored',
          },
        ]),
      );
      for (const bytes of analysis.blobs.values())
        expect(Buffer.from(bytes).toString('utf8')).not.toContain(PRIVATE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a blocked analysis with its own reason, uploading nothing', async () => {
    const { deps, recorded } = fakes({
      readPackage: () => Promise.reject(new PackageAnalysisBlockedError()),
    });
    await expect(
      refusal(publishPluginPackageToCloud(TARGET, PKG, SOURCE, deps)),
    ).resolves.toBe('publish-package-blocked');
    expect(recorded.asked).toEqual([]);
  });
});
