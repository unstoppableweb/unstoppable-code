/**
 * CAN-7226: the skill share dialog commits a skill's capability package,
 * which carries its SKILL.md, before it creates or updates the shared skill.
 * The package check lets through text that only the stricter shared check
 * catches (a credential variable, a password in a URL), so the commit itself
 * checks the analyzed SKILL.md and refuses before any upload request. This
 * drives the real skills:package-analyze and skills:package-commit handlers
 * over the real skill store on the isolated test data root; only IPC
 * registration, Electron's window lookup, the cloud capability check and
 * HTTP are replaced.
 *
 * A cloud copy of a skill or plugin (CAN-6176) withholds a supporting file
 * that looks like it holds a secret, now by the shared check too, and refuses
 * a SKILL.md or plugin.json that does, since leaving either out would ship a
 * broken copy: the real analyzer, over real folders.
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { analyzeCapabilityPackage } from '@canopy/desktop-shared/node';
import type { InvocableInventoryEntry } from '@canopy/execution-engine/types/invocable-inventory';
import { COLLECTIONS_CHANNELS } from '@canopy/desktop-shared/constants/collection-channels';
import {
  CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
  PIPELINE_PACKAGE_MAX_FILE_BYTES,
  type PipelinePackageManifestV1,
  type PipelinePackageResource,
} from '@canopy/protocol/pipelines';
import { SKILLS_CHANNELS } from '@canopy/desktop-shared/constants/skill-channels';
import {
  findPackageFileCredentialRule,
  findSharedMemberFileCredentialRule,
  scanSharedSkillForSecrets,
  sharedSkillSecretRuleLabel,
} from '@canopy/protocol/skills';
import {
  encodeSharedContainerDefinitionDocument,
  validateSharedContainerDefinitionDocument,
} from '@canopy/protocol/shared-containers';
import { getRemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import type { HostBridge } from '../../remote-control/host/bridge-window';
import { RemoteHostSession } from '../../remote-control/host/host-session';
import { RemoteUploadStore } from '../../remote-control/host/uploads';
import { RpcPeer } from '../../remote-control/transport/rpc-peer';
import {
  REMOTE_METHODS,
  REMOTE_PROTOCOL_VERSION,
} from '../../remote-control/remote-protocol';
import { InMemoryRelayHub } from '../../remote-control/__tests__/in-memory-relay';
import {
  createTestDevice,
  openControlSession,
} from '../../remote-control/__tests__/session-pair';

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const mockIpcHandlers = new Map<string, IpcHandler>();
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: IpcHandler): void => {
    mockIpcHandlers.set(channel, handler);
  },
}));
jest.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: (): unknown[] => [],
    fromWebContents: (): null => null,
  },
}));
jest.mock('../../canopy-cloud/client', () => ({
  ...jest.requireActual<object>('../../canopy-cloud/client'),
  assertCanopyCloudCapability: (): Promise<void> => Promise.resolve(),
  resolveCanopyCloudCredentialContext: (): Promise<unknown> =>
    Promise.resolve({
      baseUrl: 'https://cloud.example.test',
      apiKey: 'key-1',
      account: { id: 'acct-1' },
    }),
}));

jest.setTimeout(60_000);

const requests: string[] = [];

const ENV_SKILL = `---\nname: deploy-env\ndescription: Deploys.\n---\nRun with NPM_TOKEN=npm_${'x'.repeat(8)} set.\n`;
const URL_SKILL =
  '---\nname: deploy-db\ndescription: Deploys.\n---\nConnect to postgres://admin:pw@db/app.\n';
const PLACEHOLDER_SKILL =
  '---\nname: deploy-placeholder\ndescription: Deploys.\n---\nSet api_key: ${{ secrets.API_KEY }}\n';
// A bare npm token trips the token rule alone (CAN-7475); npm's own
// variables do not.
const NPM_TOKEN = `np${'m'}_${'T'.repeat(36)}`;
const NPM_SKILL = `---\nname: deploy-npm\ndescription: Publishes.\n---\nPublish with ${NPM_TOKEN}.\n`;
const NPM_CONFIG_SKILL =
  '---\nname: deploy-npm-config\ndescription: Publishes.\n---\nSet npm_config_registry, run npm publish, then print npm_package_version.\n';
const KEEP_STEP_SKILL =
  '---\nname: keep-step\ndescription: Keeps notes.\n---\nRead notes.md.\n';
// A share over Remote Control (CAN-7476): a clean file named after a token
// sits beside it, and its body names a token-shaped invocation.
const RC_FILE_TOKEN = `gh${'p'}_${'R'.repeat(30)}`;
const RC_INVOCATION = `/sk-${'R'.repeat(24)}`;
const RC_SKILL = `---\nname: rc-notes\ndescription: Takes notes.\n---\nWhen done, run ${RC_INVOCATION}.\n`;
const SKILLS: Record<string, string> = {
  'rc-notes': RC_SKILL,
  'deploy-env': ENV_SKILL,
  'deploy-db': URL_SKILL,
  'deploy-placeholder': PLACEHOLDER_SKILL,
  'deploy-npm': NPM_SKILL,
  'deploy-npm-config': NPM_CONFIG_SKILL,
  'keep-step': KEEP_STEP_SKILL,
};

/**
 * Every analysis in this file runs through here: the analysis must never
 * change anything its caller passed in, since a confirmed retry reuses the
 * same input (CAN-7476).
 */
async function analyzeUnchanged(
  input: Parameters<typeof analyzeCapabilityPackage>[0],
): ReturnType<typeof analyzeCapabilityPackage> {
  const before = JSON.stringify(input);
  const analysis = await analyzeCapabilityPackage(input);
  expect(JSON.stringify(input)).toBe(before);
  return analysis;
}

function invoke(channel: string, body: object): Promise<unknown> {
  const handler = mockIpcHandlers.get(channel);
  if (handler === undefined) throw new Error(`no handler for ${channel}`);
  return handler({ sender: {} }, body);
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || !(key in value))
    throw new Error(`missing ${key}`);
  return (value as Record<string, unknown>)[key];
}

/**
 * A share's analysis reads the skill with the shared check (CAN-7476), so a
 * secret-holding SKILL.md already blocks there, with the message the commit
 * gives; the commit still refuses it.
 */
async function analyzeAndCommit(
  skillName: string,
  rawSkill: string,
  refusal?: string,
): Promise<unknown> {
  const summary = await invoke(SKILLS_CHANNELS.PACKAGE_ANALYZE, {
    sourceId: 'custom:app',
    skillName,
    rawSkill,
  });
  if (refusal === undefined) expect(field(summary, 'state')).toBe('ready');
  else
    expect(summary).toMatchObject({
      state: 'blocked',
      blockers: [{ code: 'SUSPECTED_SECRET', message: refusal }],
    });
  return invoke(SKILLS_CHANNELS.PACKAGE_COMMIT, {
    analysisId: field(summary, 'analysisId'),
  });
}

beforeAll(async () => {
  // Written before the first analysis, which loads the skill inventory.
  const { writeRawSkill } = await import('../skill-service');
  for (const [skillName, rawSkill] of Object.entries(SKILLS))
    writeRawSkill({ skillName, rawSkill });
  const { getSkillDir } = await import('../paths');
  writeFileSync(
    join(getSkillDir('custom:app', 'keep-step'), 'notes.md'),
    'Background.\n',
  );
  writeFileSync(
    join(getSkillDir('custom:app', 'rc-notes'), `${RC_FILE_TOKEN}.txt`),
    'Plain notes.\n',
  );
  jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation((input: RequestInfo | URL): Promise<Response> => {
      requests.push(String(input instanceof Request ? input.url : input));
      return Promise.resolve(new Response('{}', { status: 503 }));
    });
  const { registerSkillHandlers } = await import('../skill-handlers');
  registerSkillHandlers();
  const { registerCollectionHandlers } =
    await import('../../collections/collection-handlers');
  registerCollectionHandlers();
});
beforeEach(() => {
  requests.length = 0;
});

describe('committing a skill package refuses a secret-looking SKILL.md before any upload (CAN-7226)', () => {
  it.each([
    ['deploy-env', 'a credential variable', ENV_SKILL],
    ['deploy-db', 'a password in a URL', URL_SKILL],
  ])(
    '%s: SKILL.md holding %s blocks the share and sends no request',
    async (skillName, label, rawSkill) => {
      // The package check passes it; only the shared check catches it.
      expect(
        findPackageFileCredentialRule(new TextEncoder().encode(rawSkill)),
      ).toBeNull();
      expect(
        scanSharedSkillForSecrets({
          skillName,
          files: [{ path: 'SKILL.md', text: rawSkill }],
        }),
      ).not.toBeNull();

      const message = `The skill "${skillName}" looks like it contains a secret (${label} in SKILL.md). Remove it, or replace it with a placeholder such as \${{ secrets.NAME }}, then share again.`;
      const result = await analyzeAndCommit(skillName, rawSkill, message);
      // A blocked share analysis fails as a dependency review, carrying the
      // refusal (CAN-7476).
      expect(result).toMatchObject({
        ok: false,
        failure: { kind: 'dependency-review', stage: 'prepare', message },
      });
      expect(requests).toEqual([]);
    },
  );

  it('still commits the package of a SKILL.md that only names a placeholder', async () => {
    const result = await analyzeAndCommit(
      'deploy-placeholder',
      PLACEHOLDER_SKILL,
    );
    // Past the check the upload starts; this cloud refuses it.
    expect(requests.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ ok: false });
    expect(result).not.toMatchObject({ failure: { kind: 'unavailable' } });
  });
});

describe('committing a skill package refuses a SKILL.md holding a bare npm token before any upload (CAN-7475)', () => {
  it('blocks the share, naming the rule only, and sends no request', async () => {
    const message =
      'The skill "deploy-npm" looks like it contains a secret (an npm token in SKILL.md). Remove it, or replace it with a placeholder such as ${{ secrets.NAME }}, then share again.';
    const result = await analyzeAndCommit('deploy-npm', NPM_SKILL, message);
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: 'dependency-review', stage: 'prepare', message },
    });
    expect(requests).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(NPM_TOKEN);
  });

  it("still commits a SKILL.md that only uses npm and npm's own variables", async () => {
    const result = await analyzeAndCommit(
      'deploy-npm-config',
      NPM_CONFIG_SKILL,
    );
    // Past the check the upload starts; this cloud refuses it.
    expect(requests.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ ok: false });
    expect(result).not.toMatchObject({ failure: { kind: 'unavailable' } });
  });
});

describe('committing a collection package refuses a custom skill whose SKILL.md looks like it holds a secret (CAN-7226)', () => {
  async function analyzeAndCommitCollection(
    name: string,
    skillNames: readonly string[],
    refusal?: string,
  ): Promise<unknown> {
    const saved = await invoke(COLLECTIONS_CHANNELS.SAVE_COLLECTION, {
      name,
      description: `${name} kit`,
      skills: skillNames.map((skillName) => ({
        sourceId: 'custom:app',
        skillName,
      })),
      plugins: [],
      mcpServers: [],
    });
    const summary = await invoke(COLLECTIONS_CHANNELS.PACKAGE_ANALYZE, {
      collectionId: field(saved, 'id'),
      rawCollection: JSON.stringify({
        version: 1,
        name,
        description: `${name} kit`,
        items: [],
      }),
    });
    // A share's analysis already blocks a secret-holding skill (CAN-7476).
    if (refusal === undefined) expect(field(summary, 'state')).toBe('ready');
    else
      expect(summary).toMatchObject({
        state: 'blocked',
        blockers: [{ code: 'SUSPECTED_SECRET', message: refusal }],
      });
    return invoke(COLLECTIONS_CHANNELS.PACKAGE_COMMIT, {
      analysisId: field(summary, 'analysisId'),
    });
  }

  it('refuses a collection with one clean and one secret-holding custom skill, naming that skill, with no request', async () => {
    const message = `The skill "deploy-env" looks like it contains a secret (a credential variable in SKILL.md). Remove it, or replace it with a placeholder such as \${{ secrets.NAME }}, then share again.`;
    const result = await analyzeAndCommitCollection(
      'Deploy kit',
      ['deploy-placeholder', 'deploy-env'],
      message,
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: 'dependency-review', stage: 'prepare', message },
    });
    expect(JSON.stringify(result)).not.toContain(`npm_${'x'.repeat(8)}`);
    expect(requests).toEqual([]);
  });

  it.each([
    ['no custom skills', []],
    ['a custom skill that only names a placeholder', ['deploy-placeholder']],
  ])('still commits a collection with %s', async (_case, skillNames) => {
    const result = await analyzeAndCommitCollection(
      `Kit ${skillNames.length}`,
      skillNames,
    );
    // Past the check the upload starts; this cloud refuses it.
    expect(requests.length).toBeGreaterThan(0);
    expect(result).not.toMatchObject({ failure: { kind: 'unavailable' } });
  });
});

/**
 * Every desktop package upload, from any share or publish surface, ends in
 * commitCapabilityPackageUpload, which checks each custom skill's SKILL.md
 * before the prepare request. The table builds the package each surface
 * sends, with a custom skill beside that surface's own resource; the guard
 * below proves each surface's path reaches the function and that nothing
 * else starts an upload.
 */
describe('every package upload refuses a custom skill whose SKILL.md looks like it holds a secret (CAN-7226)', () => {
  const sha = (bytes: Uint8Array): string =>
    createHash('sha256').update(bytes).digest('hex');

  function skillResource(
    skillName: string,
    bytes: Uint8Array,
  ): PipelinePackageResource {
    return {
      id: `skill-${skillName}`,
      installedItemRef: { kind: 'skill', sourceId: 'custom:app', skillName },
      kind: 'standalone_skill',
      displayName: `/${skillName}`,
      sourceLabel: 'Custom',
      sourceVisibility: 'local',
      invocationKeys: [`/${skillName}`],
      dependencyResourceIds: [],
      trees: (['claude', 'codex'] as const).map((provider) => ({
        provider,
        runtimeKind: 'standalone_skill',
        rootName: skillName,
        entries: [
          {
            path: 'SKILL.md',
            sha256: sha(bytes),
            size: bytes.length,
            mode: 'read',
          },
        ],
      })),
    };
  }

  function definitionResource(
    kind: PipelinePackageResource['kind'],
    bytes: Uint8Array,
  ): PipelinePackageResource {
    return {
      id: `definition-${kind}`,
      kind,
      displayName: kind,
      sourceLabel: 'Custom',
      sourceVisibility: 'local',
      invocationKeys: [],
      dependencyResourceIds: [],
      trees: [
        {
          provider: 'claude',
          runtimeKind: 'plugin_fragment',
          rootName: kind,
          entries: [
            {
              path: 'definition.json',
              sha256: sha(bytes),
              size: bytes.length,
              mode: 'read',
            },
          ],
        },
      ],
    };
  }

  // The resources each surface's package carries beside its custom skills.
  const SURFACES: ReadonlyArray<
    readonly [string, readonly PipelinePackageResource['kind'][]]
  > = [
    ['skill', []],
    ['collection', []],
    ['agent', ['agent_definition']],
    ['chat project', []],
    ['pipeline', ['pipeline_definition']],
    ['automation', ['automation_definition']],
    ['shared container', ['hook_definition']],
  ];

  function packageFor(
    kinds: readonly PipelinePackageResource['kind'][],
    skills: ReadonlyArray<readonly [string, string]>,
  ): {
    manifest: PipelinePackageManifestV1;
    readBlob: (sha256: string) => Uint8Array;
  } {
    const blobs = new Map<string, Uint8Array>();
    const add = (text: string): Uint8Array => {
      const bytes = new TextEncoder().encode(text);
      blobs.set(sha(bytes), bytes);
      return bytes;
    };
    const resources = [
      ...kinds.map((kind) => definitionResource(kind, add('{}'))),
      ...skills.map(([name, text]) => skillResource(name, add(text))),
    ];
    return {
      manifest: {
        version: 1,
        pipelineContentHash: 'a'.repeat(64),
        resources,
        bindings: [],
        environmentRequirements: [],
        totalFiles: resources.length,
        totalBytes: [...blobs.values()].reduce((n, b) => n + b.length, 0),
      },
      readBlob: (digest) => {
        const bytes = blobs.get(digest);
        if (bytes === undefined) throw new Error('missing blob');
        return bytes;
      },
    };
  }

  async function upload(
    kinds: readonly PipelinePackageResource['kind'][],
    skills: ReadonlyArray<readonly [string, string]>,
  ): Promise<unknown> {
    const { commitCapabilityPackageUpload } =
      await import('../../pipelines/pipeline-package-service');
    const { manifest, readBlob } = packageFor(kinds, skills);
    return commitCapabilityPackageUpload(manifest, readBlob).then(
      () => undefined,
      (caught: unknown) => caught,
    );
  }

  it.each(SURFACES)(
    '%s: a dirty custom SKILL.md is refused with no request',
    async (_surface, kinds) => {
      const error = await upload(kinds, [
        ['deploy-placeholder', PLACEHOLDER_SKILL],
        ['deploy-env', ENV_SKILL],
      ]);
      expect(error).toMatchObject({
        name: 'SkillSecretDetectedError',
        kind: 'unavailable',
        stage: 'prepare',
        message: `The skill "deploy-env" looks like it contains a secret (a credential variable in SKILL.md). Remove it, or replace it with a placeholder such as \${{ secrets.NAME }}, then share again.`,
      });
      expect(requests).toEqual([]);
    },
  );

  it.each(SURFACES)(
    '%s: a carried skill whose name looks like a secret is refused without naming it',
    async (_surface, kinds) => {
      const secretName = `deploy gh${'p'}_${'N'.repeat(30)}`;
      const error = await upload(kinds, [
        [secretName, '---\nname: deploy\n---\nDeploy.\n'],
      ]);
      expect(error).toMatchObject({
        name: 'SkillSecretDetectedError',
        message:
          'A skill it uses has a name that looks like it contains a secret (a GitHub token). Rename that skill, then share again.',
      });
      expect(JSON.stringify(error)).not.toContain(secretName);
      expect(requests).toEqual([]);
    },
  );

  it.each(SURFACES)(
    '%s: a secret-looking name is checked even when its SKILL.md bytes match a clean skill',
    async (_surface, kinds) => {
      const secretName = `deploy gh${'p'}_${'D'.repeat(30)}`;
      const error = await upload(kinds, [
        ['deploy-placeholder', PLACEHOLDER_SKILL],
        [secretName, PLACEHOLDER_SKILL],
      ]);
      expect(error).toMatchObject({
        name: 'SkillSecretDetectedError',
        message:
          'A skill it uses has a name that looks like it contains a secret (a GitHub token). Rename that skill, then share again.',
      });
      expect(JSON.stringify(error)).not.toContain(secretName);
      expect(requests).toEqual([]);
    },
  );

  it('checks provider twins of one skill (same name, same bytes) once', async () => {
    const { commitCapabilityPackageUpload } =
      await import('../../pipelines/pipeline-package-service');
    const { manifest, readBlob } = packageFor(
      [],
      [['deploy-placeholder', PLACEHOLDER_SKILL]],
    );
    // The resource carries a claude and a codex tree with the same SKILL.md.
    expect(manifest.resources[0]?.trees).toHaveLength(2);
    const skillSha = manifest.resources[0]?.trees[0]?.entries[0]?.sha256;
    let scansBeforeRequest = 0;
    const counted = (digest: string): Uint8Array => {
      if (digest === skillSha && requests.length === 0) scansBeforeRequest += 1;
      return readBlob(digest);
    };
    await commitCapabilityPackageUpload(manifest, counted).then(
      () => undefined,
      () => undefined,
    );
    expect(scansBeforeRequest).toBe(1);
    // Past the check the upload starts.
    expect(requests.length).toBeGreaterThan(0);
  });

  it('checks both names when two skills in one package carry identical SKILL.md bytes', async () => {
    const { commitCapabilityPackageUpload } =
      await import('../../pipelines/pipeline-package-service');
    const secretName = `deploy gh${'p'}_${'F'.repeat(30)}`;
    const { manifest, readBlob } = packageFor(
      [],
      [
        ['deploy-placeholder', PLACEHOLDER_SKILL],
        [secretName, PLACEHOLDER_SKILL],
      ],
    );
    const skillSha = manifest.resources[0]?.trees[0]?.entries[0]?.sha256;
    // Same bytes in both resources, each with a claude and a codex tree.
    expect(manifest.resources[1]?.trees[0]?.entries[0]?.sha256).toBe(skillSha);
    let scansBeforeRequest = 0;
    const counted = (digest: string): Uint8Array => {
      if (digest === skillSha && requests.length === 0) scansBeforeRequest += 1;
      return readBlob(digest);
    };
    const error = await commitCapabilityPackageUpload(manifest, counted).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ name: 'SkillSecretDetectedError' });
    expect(JSON.stringify(error)).not.toContain(secretName);
    // One scan per name: the clean one, then the secret one; twins once each.
    expect(scansBeforeRequest).toBe(2);
    expect(requests).toEqual([]);
  });

  it('checks a carried skill name even without a SKILL.md entry', async () => {
    const { commitCapabilityPackageUpload } =
      await import('../../pipelines/pipeline-package-service');
    const secretName = `deploy gh${'p'}_${'E'.repeat(30)}`;
    const { manifest, readBlob } = packageFor([], [[secretName, 'unused']]);
    const nameOnly: PipelinePackageManifestV1 = {
      ...manifest,
      resources: manifest.resources.map((resource) => ({
        ...resource,
        trees: resource.trees.map((tree) => ({
          ...tree,
          entries: tree.entries.map((entry) => ({
            ...entry,
            path: 'notes.md',
          })),
        })),
      })),
    };
    const error = await commitCapabilityPackageUpload(nameOnly, readBlob).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ name: 'SkillSecretDetectedError' });
    expect(JSON.stringify(error)).not.toContain(secretName);
    expect(requests).toEqual([]);
  });

  it.each(SURFACES)(
    '%s: a placeholder-only custom SKILL.md still starts its upload',
    async (_surface, kinds) => {
      const error = await upload(kinds, [
        ['deploy-placeholder', PLACEHOLDER_SKILL],
      ]);
      expect(error).not.toMatchObject({ name: 'SkillSecretDetectedError' });
      expect(requests.length).toBeGreaterThan(0);
    },
  );

  it('guard: every surface reaches commitCapabilityPackageUpload, the one place that starts an upload', () => {
    const root = join(__dirname, '..', '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === '__tests__' || name === 'node_modules') continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(root);
    const callers = (pattern: RegExp): string[] =>
      files
        .filter((file) => pattern.test(readFileSync(file, 'utf8')))
        .map((file) => relative(root, file).split('\\').join('/'))
        .sort();
    // A new upload path must reach the checked function, not start its own.
    expect(callers(/(?<!function )\bpreparePipelinePackageUpload\(/)).toEqual([
      'pipelines/pipeline-package-service.ts',
    ]);
    expect(callers(/(?<!function )\bcommitCapabilityPackageUpload\(/)).toEqual([
      'pipelines/pipeline-package-service.ts',
      'shared-containers/capability-package/prepare.ts',
    ]);
    const service = readFileSync(
      join(root, 'pipelines', 'pipeline-package-service.ts'),
      'utf8',
    );
    const body = service.slice(
      service.indexOf('export async function commitCapabilityPackageUpload('),
    );
    // The check runs before the first request.
    expect(
      body.indexOf('await assertCustomSkillsHoldNoSecret('),
    ).toBeGreaterThan(0);
    expect(body.indexOf('await assertCustomSkillsHoldNoSecret(')).toBeLessThan(
      body.indexOf('preparePipelinePackageUpload('),
    );
  });
});

describe('a cloud copy withholds a supporting file and refuses a SKILL.md or plugin.json that looks like it holds a secret (CAN-7226)', () => {
  // Built at runtime so no secret-shaped literal is committed. Each trips
  // only the shared check: the package check lets it through.
  const NPM_SENTINEL = `npm_${'Q'.repeat(12)}`;
  const URL_SENTINEL = `pw${'Z'.repeat(12)}`;
  const SHARED_ONLY = [
    ['a credential variable', `Run with NPM_TOKEN=${NPM_SENTINEL} set.\n`],
    [
      'a password in a URL',
      `Connect to postgres://admin:${URL_SENTINEL}@db/app.\n`,
    ],
  ] as const;
  const CLEAN_SKILL = (name: string): string =>
    `---\nname: ${name}\ndescription: Helps.\n---\nFollow guide.md.\n`;
  const PLACEHOLDER_NOTE = 'Run with NPM_TOKEN=${{ secrets.NPM_TOKEN }} set.\n';

  type Analysis = Awaited<ReturnType<typeof analyzeCapabilityPackage>>;
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });
  function folder(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'cloud-copy-secret-'));
    roots.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }
  const NOT_IGNORED = {
    gitIgnored: (): Promise<{
      isIgnored: (absolutePath: string) => boolean;
      checked: true;
    }> => Promise.resolve({ isIgnored: () => false, checked: true }),
  };
  function analyseSkill(
    root: string,
    skillName: string,
    cloudCopy: boolean,
  ): Promise<Analysis> {
    return analyzeUnchanged({
      rawContent: readFileSync(join(root, skillName, 'SKILL.md'), 'utf8'),
      ...(cloudCopy ? { cloudCopy: NOT_IGNORED } : {}),
      invocableInventory: {
        version: 6,
        builtAt: '2026-11-11T00:00:00.000Z',
        entries: [
          {
            id: 'e1',
            provider: 'claude',
            kind: 'skill',
            name: skillName,
            displayName: skillName,
            description: '',
            insertText: `/${skillName}`,
            invocationKey: skillName,
            enableRef: { kind: 'skill', sourceId: 'custom:app', skillName },
          },
        ],
      },
      capabilityInventoryEntryIdsByKey: {
        [`skill:custom:app:${skillName}`]: ['e1'],
      },
      sourceByInventoryEntryId: {
        e1: {
          sourceRoot: root,
          memberPath: join(root, skillName),
          sourceVisibility: 'local',
          runtimeKind: 'standalone_skill',
          rootName: skillName,
        },
      },
      requests: [
        {
          key: `skill:custom:app:${skillName}`,
          provider: 'claude',
          required: true,
          bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
        },
      ],
    });
  }
  function analysePlugin(
    root: string,
    cloudCopy: boolean,
    skillName = 'notes',
    skillPath = `skills/${skillName}`,
  ): Promise<Analysis> {
    const enableRef = {
      kind: 'plugin',
      marketplaceId: 'local-tools',
      pluginName: 'notes',
    } as const;
    const members = [
      { kind: 'plugin_skill', name: skillName, path: skillPath },
      {
        kind: 'plugin_command',
        name: 'summarise',
        path: 'commands/summarise.md',
      },
    ] as const;
    return analyzeUnchanged({
      rawContent: 'plugin:local-tools:notes',
      ...(cloudCopy ? { cloudCopy: NOT_IGNORED } : {}),
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
  const packaged = (analysis: Analysis): string[] =>
    (analysis.summary.manifest?.resources ?? [])
      .flatMap((resource) =>
        resource.trees.flatMap((tree) =>
          tree.entries.map((entry) => `${tree.rootName}/${entry.path}`),
        ),
      )
      .sort();
  const withheld = (analysis: Analysis): string[] =>
    (analysis.summary.withheldMemberFiles ?? []).map(
      (file) => `${file.relativePath}:${file.reason}`,
    );
  const secretBlockers = (analysis: Analysis): unknown[] =>
    analysis.summary.blockers.filter(
      (blocker) => blocker.code === 'SUSPECTED_SECRET',
    );
  const expectNoSentinel = (analysis: Analysis): void => {
    const text = [
      JSON.stringify(analysis.summary),
      ...[...analysis.blobs.values()].map((bytes) =>
        Buffer.from(bytes).toString('utf8'),
      ),
    ].join('\n');
    expect(text).not.toContain(NPM_SENTINEL);
    expect(text).not.toContain(URL_SENTINEL);
  };
  const sharedOnly = (text: string): void => {
    expect(findPackageFileCredentialRule(new TextEncoder().encode(text))).toBe(
      null,
    );
    expect(
      scanSharedSkillForSecrets({
        skillName: 'helper',
        files: [{ path: 'notes.md', text }],
      }),
    ).not.toBeNull();
  };

  it.each(SHARED_ONLY)(
    'a skill copy withholds a supporting file holding %s and copies the rest, and a share blocks on it, naming the skill, file and rule',
    async (label, secret) => {
      sharedOnly(secret);
      const root = folder({
        'helper/SKILL.md': CLEAN_SKILL('helper'),
        'helper/guide.md': 'Steps.\n',
        'helper/notes.md': secret,
      });
      const copy = await analyseSkill(root, 'helper', true);
      expect(copy.summary.state).toBe('ready');
      expect(withheld(copy)).toEqual(['notes.md:suspected_secret']);
      expect(packaged(copy)).toContain('helper/guide.md');
      expect(packaged(copy)).not.toContain('helper/notes.md');
      expectNoSentinel(copy);
      // A share reads it with the shared check too and blocks rather than
      // leave it out (CAN-7476).
      const share = await analyseSkill(root, 'helper', false);
      expect(share.summary.state).toBe('blocked');
      expect(secretBlockers(share)).toEqual([
        {
          code: 'SUSPECTED_SECRET',
          message: `The skill "helper" looks like it contains a secret (${label} in notes.md). Remove it, or replace it with a placeholder such as \${{ secrets.NAME }}, then share again.`,
          occurrences: [],
          subject: 'notes.md',
          relativePath: 'notes.md',
        },
      ]);
      expect(withheld(share)).toEqual([]);
      expectNoSentinel(share);
    },
  );

  it.each(SHARED_ONLY)(
    'a skill copy refuses a SKILL.md holding %s, naming the skill, file and rule',
    async (label, secret) => {
      const root = folder({
        'helper/SKILL.md': `${CLEAN_SKILL('helper')}${secret}`,
      });
      const copy = await analyseSkill(root, 'helper', true);
      const message = `The skill "helper" looks like it contains a secret (${label} in SKILL.md). Remove it, or replace it with a placeholder such as \${{ secrets.NAME }}, then share again.`;
      expect(copy.summary.state).toBe('blocked');
      expect(secretBlockers(copy)).toEqual([
        expect.objectContaining({ message }),
      ]);
      expect(copy.secretRefusal).toBe(message);
      expect(withheld(copy)).toEqual([]);
      expectNoSentinel(copy);
    },
  );

  it('a skill copy never names a skill whose name looks like a secret', async () => {
    const name = `gh${'p'}_${'Q'.repeat(30)}`;
    const root = folder({ [`${name}/SKILL.md`]: CLEAN_SKILL('helper') });
    const copy = await analyseSkill(root, name, true);
    expect(copy.summary.state).toBe('blocked');
    expect(copy.secretRefusal).toBe(
      "This skill's name looks like it contains a secret (a GitHub token). Rename the skill, then share again.",
    );
    expect(JSON.stringify(copy.summary.blockers)).not.toContain(name);
  });

  it('a skill copy never shows a withheld file whose own name looks like a secret, in the summary, the withheld list or the consent facts', async () => {
    const token = `gh${'p'}_${'Q'.repeat(30)}`;
    const root = folder({
      'helper/SKILL.md': CLEAN_SKILL('helper'),
      'helper/guide.md': 'Steps.\n',
      [`helper/${token}.txt`]: SHARED_ONLY[0][1],
    });
    const copy = await analyseSkill(root, 'helper', true);
    expect(copy.summary.state).toBe('ready');
    expect(withheld(copy)).toEqual(['[redacted path]:suspected_secret']);
    expect(packaged(copy)).toContain('helper/guide.md');
    expect(JSON.stringify(copy.summary)).not.toContain(token);
    const { consentFactsOf } =
      await import('../../pipelines/pipeline-package-service');
    expect(JSON.stringify(consentFactsOf(copy.summary, []))).not.toContain(
      token,
    );
    expectNoSentinel(copy);
  });

  it('a skill copy still packages a supporting file that only names a placeholder', async () => {
    const root = folder({
      'helper/SKILL.md': CLEAN_SKILL('helper'),
      'helper/notes.md': PLACEHOLDER_NOTE,
    });
    const copy = await analyseSkill(root, 'helper', true);
    expect(copy.summary.state).toBe('ready');
    expect(withheld(copy)).toEqual([]);
    expect(packaged(copy)).toContain('helper/notes.md');
  });

  const PLUGIN = (files: Record<string, string> = {}): string =>
    folder({
      '.claude-plugin/plugin.json': `${JSON.stringify({ name: 'notes', description: 'Notes.' })}\n`,
      'skills/notes/SKILL.md': CLEAN_SKILL('notes'),
      'skills/notes/reference.md': 'Background.\n',
      'commands/summarise.md': 'Summarise the notes.\n',
      ...files,
    });

  it.each(SHARED_ONLY)(
    'a plugin copy withholds a supporting file holding %s and copies the rest',
    async (_label, secret) => {
      const copy = await analysePlugin(
        PLUGIN({ 'skills/notes/reference.md': secret }),
        true,
      );
      expect(copy.summary.state).toBe('ready');
      expect(withheld(copy)).toEqual([
        'skills/notes/reference.md:suspected_secret',
      ]);
      expect(packaged(copy)).toContain('notes/skills/notes/SKILL.md');
      expect(packaged(copy)).not.toContain('notes/skills/notes/reference.md');
      expectNoSentinel(copy);
    },
  );

  it("a plugin copy refuses a skill whose SKILL.md holds a password in a URL, naming the plugin's skill and file", async () => {
    const copy = await analysePlugin(
      PLUGIN({
        'skills/notes/SKILL.md': `${CLEAN_SKILL('notes')}${SHARED_ONLY[1][1]}`,
      }),
      true,
    );
    const message =
      'The skill "notes" looks like it contains a secret (a password in a URL in skills/notes/SKILL.md). Remove it, or replace it with a placeholder such as ${{ secrets.NAME }}, then share again.';
    expect(copy.summary.state).toBe('blocked');
    expect(secretBlockers(copy)).toEqual([
      expect.objectContaining({ message }),
    ]);
    expect(copy.secretRefusal).toBe(message);
    expect(withheld(copy)).toEqual([]);
    expectNoSentinel(copy);
  });

  it('a plugin copy refuses a plugin.json that looks like it holds a secret, naming the plugin and file', async () => {
    const copy = await analysePlugin(
      PLUGIN({
        '.claude-plugin/plugin.json': `${JSON.stringify({ name: 'notes', description: `Set NPM_TOKEN=${NPM_SENTINEL} first.` })}\n`,
      }),
      true,
    );
    const message =
      'The plugin "notes" looks like it contains a secret (a credential variable in .claude-plugin/plugin.json). Remove it, or replace it with a placeholder such as ${{ secrets.NAME }}, then share again.';
    expect(copy.summary.state).toBe('blocked');
    expect(secretBlockers(copy)).toEqual([
      expect.objectContaining({ message }),
    ]);
    expect(copy.secretRefusal).toBe(message);
    expect(withheld(copy)).toEqual([]);
    expectNoSentinel(copy);
  });

  it("a plugin copy never shows a skill folder whose name looks like a secret, in the message or the blocker's path", async () => {
    const token = `gh${'p'}_${'Q'.repeat(30)}`;
    const copy = await analysePlugin(
      PLUGIN({
        [`skills/${token}/SKILL.md`]: `${CLEAN_SKILL('notes')}${SHARED_ONLY[1][1]}`,
      }),
      true,
      token,
    );
    expect(copy.summary.state).toBe('blocked');
    expect(secretBlockers(copy)).toEqual([
      expect.objectContaining({
        subject: '[redacted path]',
        relativePath: '[redacted path]',
        message:
          'A skill it uses has a name that looks like it contains a secret (a GitHub token). Rename that skill, then share again.',
      }),
      // The skill's name also reaches the manifest, so the final check
      // redacts it there and blocks too (CAN-7476).
      expect.objectContaining({ subject: '[redacted name]' }),
    ]);
    expect(JSON.stringify(copy.summary)).not.toContain(token);
    expect(copy.secretRefusal).not.toContain(token);
  });

  it('a plugin copy refusing an authorization header in plugin.json asks to drop the value, not for a placeholder', async () => {
    const copy = await analysePlugin(
      PLUGIN({
        '.claude-plugin/plugin.json': `${JSON.stringify({ name: 'notes', description: 'Send Authorization: Bearer \${{ secrets.API_TOKEN }} with each call.' })}\n`,
      }),
      true,
    );
    expect(copy.secretRefusal).toBe(
      'The plugin "notes" looks like it contains a secret (an authorization header in .claude-plugin/plugin.json). Remove the header line, or say which header to send without writing its value, then share again.',
    );
  });

  it('a plugin copy leaves out a clean file whose own name looks like a secret, and its name goes nowhere', async () => {
    const token = `gh${'p'}_${'Q'.repeat(30)}`;
    const copy = await analysePlugin(
      PLUGIN({ [`skills/notes/${token}.txt`]: 'Plain notes.\n' }),
      true,
    );
    expect(copy.summary.state).toBe('ready');
    expect(withheld(copy)).toEqual(['[redacted path]:suspected_secret']);
    expect(packaged(copy)).toContain('notes/skills/notes/reference.md');
    expect(packaged(copy).some((file) => file.includes(token))).toBe(false);
    expect(JSON.stringify(copy.summary)).not.toContain(token);
    expect(JSON.stringify(copy.summary.manifest)).not.toContain(token);
    const { consentFactsOf } =
      await import('../../pipelines/pipeline-package-service');
    expect(JSON.stringify(consentFactsOf(copy.summary, []))).not.toContain(
      token,
    );
    // Its content never became a blob either.
    for (const bytes of copy.blobs.values())
      expect(Buffer.from(bytes).toString('utf8')).not.toBe('Plain notes.\n');
  });

  it('a plugin copy refuses a plugin.json whose credential is hidden behind JSON escapes, scanning the manifest it would upload', async () => {
    // Written by hand: `\/` decodes to `/`, so the uploaded manifest holds
    // the URL with its password.
    const copy = await analysePlugin(
      PLUGIN({
        '.claude-plugin/plugin.json': `{"name":"notes","description":"Store them at postgres:\\/\\/admin:${URL_SENTINEL}@db\\/app."}\n`,
      }),
      true,
    );
    expect(copy.summary.state).toBe('blocked');
    expect(copy.secretRefusal).toBe(
      'The plugin "notes" looks like it contains a secret (a password in a URL in .claude-plugin/plugin.json). Remove it, or replace it with a placeholder such as ${{ secrets.NAME }}, then share again.',
    );
    expectNoSentinel(copy);
  });

  it('a plugin copy refuses, and a share blocks, a plugin.json whose token is hidden behind a \\u escape, scanning the manifest it would upload', async () => {
    const token = `gh${'p'}_${'Q'.repeat(30)}`;
    // Written by hand: `p` decodes to `p`, so neither check sees a
    // token in the source text, but the uploaded manifest holds it.
    const source = `{"name":"notes","description":"Deploy with gh\\u0070_${'Q'.repeat(30)}."}\n`;
    expect(
      findPackageFileCredentialRule(new TextEncoder().encode(source)),
    ).toBe(null);
    expect(
      scanSharedSkillForSecrets({
        skillName: 'notes',
        files: [{ path: 'plugin.json', text: source }],
      }),
    ).toBeNull();
    const root = PLUGIN({ '.claude-plugin/plugin.json': source });
    const copy = await analysePlugin(root, true);
    expect(copy.summary.state).toBe('blocked');
    expect(copy.secretRefusal).toBe(
      'The plugin "notes" looks like it contains a secret (a GitHub token in .claude-plugin/plugin.json). Remove it, or replace it with a placeholder such as ${{ secrets.NAME }}, then share again.',
    );
    const share = await analysePlugin(root, false);
    expect(share.summary.state).toBe('blocked');
    expect(secretBlockers(share)).toEqual([
      expect.objectContaining({ relativePath: '.claude-plugin/plugin.json' }),
    ]);
    for (const analysis of [copy, share])
      for (const bytes of analysis.blobs.values())
        expect(Buffer.from(bytes).toString('utf8')).not.toContain(token);
  });

  it('a plugin copy withholds a supporting JSON file whose credential is hidden behind JSON escapes', async () => {
    const copy = await analysePlugin(
      PLUGIN({
        'skills/notes/config.json': `{"database":"postgres:\\/\\/admin:${URL_SENTINEL}@db\\/app"}\n`,
      }),
      true,
    );
    expect(withheld(copy)).toEqual([
      'skills/notes/config.json:suspected_secret',
    ]);
    expect(copy.summary.state).toBe('ready');
    expect(packaged(copy)).toContain('notes/skills/notes/reference.md');
    expect(packaged(copy)).not.toContain('notes/skills/notes/config.json');
    expectNoSentinel(copy);
  });

  const NUMERIC_SENTINEL = '7'.repeat(12);
  const expectNowhere = async (
    analysis: Analysis,
    needle: string,
  ): Promise<void> => {
    const { consentFactsOf } =
      await import('../../pipelines/pipeline-package-service');
    expect(JSON.stringify(analysis.summary)).not.toContain(needle);
    expect(JSON.stringify(consentFactsOf(analysis.summary, []))).not.toContain(
      needle,
    );
    for (const bytes of analysis.blobs.values())
      expect(Buffer.from(bytes).toString('utf8')).not.toContain(needle);
  };

  // Written by hand: each `\u00NN` decodes to a letter of the key, so the
  // source text has no credential key, and the decoded key and value say
  // nothing on their own.
  it.each([
    [
      'a unicode-escaped password key',
      `{"\\u0070assword":"${URL_SENTINEL}"}\n`,
      URL_SENTINEL,
    ],
    [
      'that key two levels down',
      `{"db":{"primary":{"\\u0070assword":"${URL_SENTINEL}"}}}\n`,
      URL_SENTINEL,
    ],
    [
      'a numeric password value',
      `{"\\u0070assword":${NUMERIC_SENTINEL}}\n`,
      NUMERIC_SENTINEL,
    ],
    [
      'a password key escaped only in part',
      `{"pa\\u0073sword":"${URL_SENTINEL}"}\n`,
      URL_SENTINEL,
    ],
  ])(
    'a plugin copy withholds a supporting JSON file holding %s',
    async (_label, source, needle) => {
      expect(
        findPackageFileCredentialRule(new TextEncoder().encode(source)),
      ).toBe(null);
      expect(
        scanSharedSkillForSecrets({
          skillName: 'notes',
          files: [{ path: 'config.json', text: source }],
        }),
      ).toBeNull();
      const copy = await analysePlugin(
        PLUGIN({ 'skills/notes/config.json': source }),
        true,
      );
      expect(withheld(copy)).toEqual([
        'skills/notes/config.json:suspected_secret',
      ]);
      expect(copy.summary.state).toBe('ready');
      expect(packaged(copy)).toContain('notes/skills/notes/reference.md');
      expect(packaged(copy)).not.toContain('notes/skills/notes/config.json');
      await expectNowhere(copy, needle);
    },
  );

  it('a plugin copy withholds a supporting JSON file too deeply nested to check, rather than failing', async () => {
    const depth = 20_000;
    const copy = await analysePlugin(
      PLUGIN({
        'skills/notes/config.json': `${'['.repeat(depth)}${']'.repeat(depth)}\n`,
      }),
      true,
    );
    expect(copy.summary.state).toBe('ready');
    expect(withheld(copy)).toEqual([
      'skills/notes/config.json:suspected_secret',
    ]);
    expect(packaged(copy)).toContain('notes/skills/notes/reference.md');
  });

  it('a plugin copy and a share refuse a plugin.json whose credential key hides behind an escape, and an escape in its description refuses a copy and blocks a share', async () => {
    const PLUGIN_REFUSAL =
      'The plugin "notes" looks like it contains a secret (a credential value in .claude-plugin/plugin.json). Remove it, or replace it with a placeholder such as ${{ secrets.NAME }}, then share again.';
    for (const source of [
      `{"name":"notes","description":"Notes.","\\u0070assword":"${URL_SENTINEL}"}\n`,
      `{"name":"notes","description":"Notes.","author":{"\\u0070assword":"${URL_SENTINEL}"}}\n`,
    ]) {
      const root = PLUGIN({ '.claude-plugin/plugin.json': source });
      const copy = await analysePlugin(root, true);
      expect(copy.summary.state).toBe('blocked');
      expect(copy.secretRefusal).toBe(PLUGIN_REFUSAL);
      await expectNowhere(copy, URL_SENTINEL);
      // A share reads the source with its escapes decoded too, so it refuses
      // the same plugin.json (CAN-7476).
      const share = await analysePlugin(root, false);
      expect(share.summary.state).toBe('blocked');
      expect(share.secretRefusal).toBe(PLUGIN_REFUSAL);
      await expectNowhere(share, URL_SENTINEL);
    }
    const describedRoot = PLUGIN({
      '.claude-plugin/plugin.json': `{"name":"notes","description":"\\u0070assword: ${URL_SENTINEL}"}\n`,
    });
    const share = await analysePlugin(describedRoot, false);
    expect(share.summary.state).toBe('blocked');
    expect(secretBlockers(share)).toEqual([
      expect.objectContaining({ relativePath: '.claude-plugin/plugin.json' }),
    ]);
    await expectNowhere(share, URL_SENTINEL);
    const described = await analysePlugin(describedRoot, true);
    expect(described.summary.state).toBe('blocked');
    expect(described.secretRefusal).toBe(PLUGIN_REFUSAL);
    await expectNowhere(described, URL_SENTINEL);
  });

  // Written by hand: YAML double-quoted strings decode `\u0070` to `p`, so
  // the uploaded SKILL.md reads as a password to any YAML reader.
  const ESCAPED_KEY_FRONTMATTER = (name: string, description: string): string =>
    `---\nname: ${name}\ndescription: ${description}\n"\\u0070assword": "${URL_SENTINEL}"\n---\n\nBody.\n`;
  it.each([
    ['its frontmatter key', ESCAPED_KEY_FRONTMATTER('notes', 'Notes.')],
    [
      'its frontmatter value',
      `---\nname: notes\ndescription: "\\u0070assword: ${URL_SENTINEL}"\n---\n\nBody.\n`,
    ],
    [
      'a JSON block in its body',
      `${CLEAN_SKILL('notes')}\n\`\`\`json\n{"\\u0070assword":"${URL_SENTINEL}"}\n\`\`\`\n`,
    ],
  ])(
    'a plugin copy refuses a skill whose SKILL.md hides a password key behind an escape in %s',
    async (_label, skill) => {
      expect(
        scanSharedSkillForSecrets({
          skillName: 'notes',
          files: [{ path: 'SKILL.md', text: skill }],
        }),
      ).toBeNull();
      const copy = await analysePlugin(
        PLUGIN({ 'skills/notes/SKILL.md': skill }),
        true,
      );
      expect(copy.summary.state).toBe('blocked');
      expect(copy.secretRefusal).toBe(
        'The skill "notes" looks like it contains a secret (a credential value in skills/notes/SKILL.md). Remove it, or replace it with a placeholder such as ${{ secrets.NAME }}, then share again.',
      );
      await expectNowhere(copy, URL_SENTINEL);
    },
  );

  it('a skill copy refuses a SKILL.md whose frontmatter hides a password key behind an escape', async () => {
    const root = folder({
      'helper/SKILL.md': ESCAPED_KEY_FRONTMATTER('helper', 'Helps.'),
      'helper/guide.md': 'Steps.\n',
    });
    const copy = await analyseSkill(root, 'helper', true);
    expect(copy.summary.state).toBe('blocked');
    expect(copy.secretRefusal).toBe(
      'The skill "helper" looks like it contains a secret (a credential value in SKILL.md). Remove it, or replace it with a placeholder such as ${{ secrets.NAME }}, then share again.',
    );
    await expectNowhere(copy, URL_SENTINEL);
  });

  it('a plugin copy withholds a supporting YAML file whose password key is hidden behind an escape', async () => {
    const source = `"\\u0070assword": "${URL_SENTINEL}"\n`;
    expect(
      scanSharedSkillForSecrets({
        skillName: 'notes',
        files: [{ path: 'config.yaml', text: source }],
      }),
    ).toBeNull();
    const copy = await analysePlugin(
      PLUGIN({ 'skills/notes/config.yaml': source }),
      true,
    );
    expect(copy.summary.state).toBe('ready');
    expect(withheld(copy)).toEqual([
      'skills/notes/config.yaml:suspected_secret',
    ]);
    expect(packaged(copy)).toContain('notes/skills/notes/reference.md');
    await expectNowhere(copy, URL_SENTINEL);
  });

  it('a plugin copy still copies a SKILL.md and a note holding a harmless escaped letter and an escaped slash', async () => {
    const text = `${CLEAN_SKILL('notes')}\nSee the caf\\u00e9 notes, the café menu and docs\\/guide.md.\n`;
    const copy = await analysePlugin(
      PLUGIN({
        'skills/notes/SKILL.md': text,
        'skills/notes/reference.md': text,
      }),
      true,
    );
    expect(copy.summary.state).toBe('ready');
    expect(withheld(copy)).toEqual([]);
    expect(packaged(copy)).toEqual(
      expect.arrayContaining([
        'notes/skills/notes/SKILL.md',
        'notes/skills/notes/reference.md',
      ]),
    );
  });

  it('a plugin copy refuses a skill whose SKILL.md sits under a folder whose name looks like a secret, and the name goes nowhere', async () => {
    const token = `gh${'p'}_${'Q'.repeat(30)}`;
    const copy = await analysePlugin(
      PLUGIN({
        [`${token}/skills/notes/SKILL.md`]: CLEAN_SKILL('notes'),
      }),
      true,
      'notes',
      `${token}/skills/notes`,
    );
    expect(copy.summary.state).toBe('blocked');
    expect(secretBlockers(copy)).toEqual([
      expect.objectContaining({
        subject: '[redacted path]',
        relativePath: '[redacted path]',
      }),
    ]);
    expect(copy.secretRefusal).toBeDefined();
    expect(copy.secretRefusal).not.toContain(token);
    expect(JSON.stringify(copy.summary)).not.toContain(token);
    expect(JSON.stringify(copy.summary.manifest)).not.toContain(token);
    const { consentFactsOf } =
      await import('../../pipelines/pipeline-package-service');
    expect(JSON.stringify(consentFactsOf(copy.summary, []))).not.toContain(
      token,
    );
  });

  describe('a share reads every member with the shared check, and blocks rather than leave a file out (CAN-7476)', () => {
    const TOKEN = `gh${'p'}_${'Q'.repeat(30)}`;
    const blockersOf = (
      analysis: Analysis,
    ): Array<{
      code: string;
      message: string;
      subject?: string;
      relativePath?: string;
    }> =>
      analysis.summary.blockers.map(
        ({ code, message, subject, relativePath }) => ({
          code,
          message,
          ...(subject === undefined ? {} : { subject }),
          ...(relativePath === undefined ? {} : { relativePath }),
        }),
      );
    const PLUGIN_FILE_REFUSAL = (rule: string, file: string): string =>
      `The plugin "notes" looks like it contains a secret (${rule} in ${file}). Remove it, or replace it with a placeholder such as \${{ secrets.NAME }}, then share again.`;

    it.each([
      [
        'plugin',
        (): Promise<Analysis> =>
          analysePlugin(
            PLUGIN({ [`skills/notes/${TOKEN}.txt`]: 'Plain notes.\n' }),
            false,
          ),
      ],
      [
        'skill',
        (): Promise<Analysis> =>
          analyseSkill(
            folder({
              'helper/SKILL.md': CLEAN_SKILL('helper'),
              'helper/guide.md': 'Steps.\n',
              [`helper/${TOKEN}.txt`]: 'Plain notes.\n',
            }),
            'helper',
            false,
          ),
      ],
    ])(
      'a %s share blocks on a clean file whose name looks like a secret, and the name goes nowhere',
      async (kind, analyse) => {
        const share = await analyse();
        expect(share.summary.state).toBe('blocked');
        expect(blockersOf(share)).toEqual([
          {
            code: 'SUSPECTED_SECRET',
            message: `A file in the ${kind} "${kind === 'plugin' ? 'notes' : 'helper'}" has a name that looks like it contains a secret (a GitHub token). Rename the file, then share again.`,
            subject: '[redacted path]',
            relativePath: '[redacted path]',
          },
        ]);
        expect(withheld(share)).toEqual([]);
        await expectNowhere(share, TOKEN);
      },
    );

    it.each([
      [
        'a unicode-escaped password key',
        `{"\\u0070assword":"${URL_SENTINEL}"}\n`,
        URL_SENTINEL,
      ],
      [
        'that key two levels down',
        `{"db":{"primary":{"\\u0070assword":"${URL_SENTINEL}"}}}\n`,
        URL_SENTINEL,
      ],
      [
        'a numeric password value',
        `{"\\u0070assword":${NUMERIC_SENTINEL}}\n`,
        NUMERIC_SENTINEL,
      ],
      [
        'a password key escaped only in part',
        `{"pa\\u0073sword":"${URL_SENTINEL}"}\n`,
        URL_SENTINEL,
      ],
    ])(
      'a share blocks on a supporting JSON file holding %s, naming the plugin, file and rule',
      async (_label, source, needle) => {
        const share = await analysePlugin(
          PLUGIN({ 'skills/notes/config.json': source }),
          false,
        );
        expect(share.summary.state).toBe('blocked');
        expect(blockersOf(share)).toEqual([
          {
            code: 'SUSPECTED_SECRET',
            message: PLUGIN_FILE_REFUSAL(
              'a credential value',
              'skills/notes/config.json',
            ),
            subject: 'skills/notes/config.json',
            relativePath: 'skills/notes/config.json',
          },
        ]);
        await expectNowhere(share, needle);
      },
    );

    it.each([
      ['its frontmatter key', ESCAPED_KEY_FRONTMATTER('notes', 'Notes.')],
      [
        'its frontmatter value',
        `---\nname: notes\ndescription: "\\u0070assword: ${URL_SENTINEL}"\n---\n\nBody.\n`,
      ],
      [
        'a JSON block in its body',
        `${CLEAN_SKILL('notes')}\n\`\`\`json\n{"\\u0070assword":"${URL_SENTINEL}"}\n\`\`\`\n`,
      ],
    ])(
      'a share refuses a skill whose SKILL.md hides a password key behind an escape in %s',
      async (_label, skill) => {
        const share = await analysePlugin(
          PLUGIN({ 'skills/notes/SKILL.md': skill }),
          false,
        );
        expect(share.summary.state).toBe('blocked');
        expect(share.secretRefusal).toBe(
          'The skill "notes" looks like it contains a secret (a credential value in skills/notes/SKILL.md). Remove it, or replace it with a placeholder such as ${{ secrets.NAME }}, then share again.',
        );
        await expectNowhere(share, URL_SENTINEL);
      },
    );

    it('a share blocks on a supporting YAML file whose password key is hidden behind an escape', async () => {
      const share = await analysePlugin(
        PLUGIN({
          'skills/notes/config.yaml': `"\\u0070assword": "${URL_SENTINEL}"\n`,
        }),
        false,
      );
      expect(blockersOf(share)).toEqual([
        {
          code: 'SUSPECTED_SECRET',
          message: PLUGIN_FILE_REFUSAL(
            'a credential value',
            'skills/notes/config.yaml',
          ),
          subject: 'skills/notes/config.yaml',
          relativePath: 'skills/notes/config.yaml',
        },
      ]);
      await expectNowhere(share, URL_SENTINEL);
    });

    it('a share blocks on a JSON file too deeply nested to check, saying so', async () => {
      const depth = 20_000;
      const share = await analysePlugin(
        PLUGIN({
          'skills/notes/config.json': `${'['.repeat(depth)}${']'.repeat(depth)}\n`,
        }),
        false,
      );
      expect(blockersOf(share)).toEqual([
        {
          code: 'SUSPECTED_SECRET',
          message:
            'The plugin "notes" has a file, skills/notes/config.json, that is nested too deeply to check for secrets. Simplify it, then share again.',
          subject: 'skills/notes/config.json',
          relativePath: 'skills/notes/config.json',
        },
      ]);
    });

    it('a share never shows a path that looks like a secret in any other member blocker', async () => {
      const share = await analysePlugin(
        PLUGIN({ [`skills/notes/${TOKEN}/.env`]: 'MODE=1\n' }),
        false,
      );
      expect(share.summary.state).toBe('blocked');
      expect(blockersOf(share)).toEqual([
        expect.objectContaining({
          code: 'EXPORT_DENIED_FILE',
          subject: '[redacted path]',
          relativePath: '[redacted path]',
        }),
      ]);
      await expectNowhere(share, TOKEN);
    });

    it.each([
      ['share', false],
      ['cloud copy', true],
    ])(
      'a %s blocks on a skill whose source label looks like a secret, and the label goes nowhere',
      async (_label, cloudCopy) => {
        const root = folder({
          'helper/SKILL.md': CLEAN_SKILL('helper'),
          'helper/guide.md': 'Steps.\n',
        });
        const analysis = await analyzeUnchanged({
          rawContent: readFileSync(join(root, 'helper', 'SKILL.md'), 'utf8'),
          ...(cloudCopy ? { cloudCopy: NOT_IGNORED } : {}),
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
                sourceLabel: TOKEN,
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
        expect(analysis.summary.state).toBe('blocked');
        expect(blockersOf(analysis)).toEqual([
          {
            code: 'SUSPECTED_SECRET',
            message:
              'A source label in this package looks like it contains a secret (a GitHub token). Rename it, then share again.',
            subject: '[redacted name]',
          },
        ]);
        expect(analysis.secretRefusal).toBe(
          'A source label in this package looks like it contains a secret (a GitHub token). Rename it, then share again.',
        );
        await expectNowhere(analysis, TOKEN);
      },
    );

    it('a share blocks on a skill whose installed source id looks like a secret', async () => {
      const root = folder({
        'helper/SKILL.md': CLEAN_SKILL('helper'),
        'helper/guide.md': 'Steps.\n',
      });
      const sourceId = `local:${TOKEN}`;
      const analysis = await analyzeUnchanged({
        rawContent: readFileSync(join(root, 'helper', 'SKILL.md'), 'utf8'),
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
              enableRef: { kind: 'skill', sourceId, skillName: 'helper' },
            },
          ],
        },
        capabilityInventoryEntryIdsByKey: {
          [`skill:${sourceId}:helper`]: ['e1'],
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
            key: `skill:${sourceId}:helper`,
            provider: 'claude',
            required: true,
            bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
          },
        ],
      });
      expect(analysis.summary.state).toBe('blocked');
      expect(blockersOf(analysis)).toEqual([
        {
          code: 'SUSPECTED_SECRET',
          message:
            'An installed item in this package looks like it contains a secret (a GitHub token). Rename it, then share again.',
          subject: '[redacted name]',
        },
      ]);
      await expectNowhere(analysis, TOKEN);
    });

    it('a share still packages a placeholder note and a clean plugin', async () => {
      const share = await analysePlugin(
        PLUGIN({ 'skills/notes/reference.md': PLACEHOLDER_NOTE }),
        false,
      );
      expect(share.summary.state).toBe('ready');
      expect(share.secretRefusal).toBeUndefined();
      expect(packaged(share)).toEqual(
        expect.arrayContaining([
          'notes/.claude-plugin/plugin.json',
          'notes/skills/notes/SKILL.md',
          'notes/skills/notes/reference.md',
        ]),
      );
    });
  });

  it('a clean plugin still copies every file', async () => {
    const copy = await analysePlugin(PLUGIN(), true);
    expect(copy.summary.state).toBe('ready');
    expect(withheld(copy)).toEqual([]);
    expect(copy.secretRefusal).toBeUndefined();
    expect(packaged(copy)).toEqual(
      expect.arrayContaining([
        'notes/.claude-plugin/plugin.json',
        'notes/commands/summarise.md',
        'notes/skills/notes/SKILL.md',
        'notes/skills/notes/reference.md',
      ]),
    );
  });
});

describe('keeping a cloud copy in step stops when a consented supporting file now looks like it holds a secret (CAN-7226)', () => {
  it('asks for consent again and commits nothing', async () => {
    const { analyzeSkillCapabilityPackage, packageAnalysisConsentFacts } =
      await import('../../pipelines/pipeline-package-service');
    const { readRawSkill } = await import('../skill-service');
    const { getSkillDir } = await import('../paths');
    const { keepCloudSkillsInStep } = await import('../publish-skill-to-cloud');
    const AT = '2026-11-20T00:00:00.000Z';
    const analyse = async (): Promise<string> =>
      (
        await analyzeSkillCapabilityPackage(
          {
            sourceId: 'custom:app',
            skillName: 'keep-step',
            rawSkill: await readRawSkill('custom:app/keep-step'),
            cloudCopy: true,
          },
          { persistDismissals: false },
        )
      ).analysisId;
    const consented = packageAnalysisConsentFacts(await analyse(), []);
    expect(consented?.ready).toBe(true);
    expect(consented?.files.some((file) => file.endsWith('/notes.md'))).toBe(
      true,
    );
    // The skill changes after consent, and its consented note now holds a
    // token the package check lets through.
    const token = `npm_${'Q'.repeat(12)}`;
    const dir = getSkillDir('custom:app', 'keep-step');
    writeFileSync(join(dir, 'SKILL.md'), `${KEEP_STEP_SKILL}Then summarise.\n`);
    writeFileSync(join(dir, 'notes.md'), `Run with NPM_TOKEN=${token} set.\n`);
    const commits: unknown[] = [];
    const outcome = await keepCloudSkillsInStep(
      ['remote-keep'],
      { timeoutMs: 30_000 },
      {
        loadSkills: () =>
          Promise.resolve([
            {
              name: 'keep-step',
              sourceId: 'custom:app',
              description: 'Keeps notes.',
              source: 'Custom',
              installedAt: AT,
              updatedAt: AT,
              updateAvailable: false,
              remote: {
                accountId: 'acct-1',
                remoteId: 'remote-keep',
                contentHash: 'b'.repeat(64),
                shareScope: 'private',
                sharedAt: AT,
              },
            },
          ]),
        readRawSkill,
        credentials: () =>
          Promise.resolve({
            accountId: 'acct-1',
            context: { baseUrl: 'https://cloud.example.test', apiKey: 'k' },
          }),
        analysisFacts: (analysisId, selected) =>
          Promise.resolve(packageAnalysisConsentFacts(analysisId, selected)),
        analyzeSkill: async (input) =>
          (
            await analyzeSkillCapabilityPackage(input, {
              persistDismissals: false,
            })
          ).analysisId,
        readConsent: () =>
          Promise.resolve({
            accountId: 'acct-1',
            remoteId: 'remote-keep',
            keepInStep: true,
            consentedAt: AT,
            selectedOptionalResourceIds: [],
            files: consented?.files ?? [],
            withheld: consented?.withheld ?? [],
            audience: 'private',
          }),
        linkedCopyAudience: () => Promise.resolve('private'),
        commitPackage: (pkg) => {
          commits.push(pkg);
          return Promise.resolve({
            capabilityPackage: { version: 1, digest: 'pp:v1:abc' },
            committedPackageUploadId: 'upload-1',
          });
        },
        updateSharedSkill: () => Promise.reject(new Error('not reached')),
        writeLink: () => Promise.resolve(),
        writeConsent: () => Promise.resolve(),
      },
    );
    expect(outcome.usedLastCopy).toEqual([
      { name: 'keep-step', reason: 'needs_consent' },
    ]);
    expect(commits).toEqual([]);
    expect(requests).toEqual([]);
  });
});

describe('an unresolved invocation that looks like a secret is never shown, dismissed or uploaded (CAN-7476)', () => {
  // `/sk-…` matches the API key rule; nothing resolves either token.
  const SECRET_TOKEN = `/sk-${'Q'.repeat(24)}`;
  function analyse(
    dismissedInvocations: Array<{ provider: 'claude'; token: string }>,
  ): ReturnType<typeof analyzeCapabilityPackage> {
    return analyzeUnchanged({
      rawContent: 'Prompt.',
      invocableInventory: {
        version: 6,
        builtAt: '2026-11-11T00:00:00.000Z',
        entries: [],
      },
      capabilityInventoryEntryIdsByKey: {},
      sourceByInventoryEntryId: {},
      requests: [],
      promptSources: [
        {
          provider: 'claude',
          target: 'subject',
          text: `Run ${SECRET_TOKEN}, then /missing-helper and /dismissed-helper.`,
        },
      ],
      dismissedInvocations,
    });
  }
  const invocationBlockers = (
    analysis: Awaited<ReturnType<typeof analyse>>,
  ): unknown[] =>
    analysis.summary.blockers.filter(
      (blocker) => blocker.code === 'UNRESOLVED_INVOCATION',
    );

  it('names the rule, never the token, offers no dismissal, ignores a stored one, and emits no note', async () => {
    const analysis = await analyse([
      { provider: 'claude', token: SECRET_TOKEN },
      { provider: 'claude', token: '/dismissed-helper' },
    ]);
    expect(invocationBlockers(analysis)).toEqual([
      expect.objectContaining({
        message:
          'A required invocation that looks like a secret (an API key) could not be resolved.',
        subject: '[redacted invocation]',
      }),
      expect.objectContaining({
        message: 'Required invocation /missing-helper could not be resolved.',
        subject: '/missing-helper',
        dismissal: { provider: 'claude', token: '/missing-helper' },
      }),
    ]);
    expect(invocationBlockers(analysis)[0]).not.toHaveProperty('dismissal');
    // An ordinary dismissal still works and still becomes a publisher note.
    expect(analysis.summary.dismissedInvocations).toEqual([
      { provider: 'claude', token: '/dismissed-helper' },
    ]);
    expect(
      (analysis.summary.manifest?.publisherNotes ?? []).map(
        (note) => note.label,
      ),
    ).toEqual(['/dismissed-helper']);
    expect(JSON.stringify(analysis.summary)).not.toContain(
      SECRET_TOKEN.slice(1),
    );
  });
});

describe('the Remote Control projection of a share analysis carries no secret-shaped path or token (CAN-7476)', () => {
  const PEER_VERSION = {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    appVersion: '2.0.0',
  };
  const noop = (): void => undefined;

  it('tunnels skills:package-analyze with the file name and the invocation token redacted', async () => {
    // The skill share dialog's analysis reaches a paired controller.
    expect(getRemoteChannelDisposition(SKILLS_CHANNELS.PACKAGE_ANALYZE)).toBe(
      'tunnel',
    );
    const hub = new InMemoryRelayHub();
    const controllerDevice = createTestDevice(hub, 'Controller');
    const hostDevice = createTestDevice(hub, 'Host');
    const { initiator, responder } = await openControlSession(
      controllerDevice,
      hostDevice,
    );
    const uploads = mkdtempSync(join(tmpdir(), 'rc-share-uploads-'));
    const host = new RemoteHostSession({
      session: responder,
      kind: 'desktop',
      attributedDeviceId: 'controller-device',
      createBridge: (): Promise<HostBridge> =>
        Promise.resolve({
          window: null,
          getChatInterest: (): undefined => undefined,
          invoke: (channel: string, args: unknown[]): Promise<unknown> => {
            const [request] = args;
            if (typeof request !== 'object' || request === null)
              throw new Error('expected a request');
            return invoke(channel, request);
          },
          post: noop,
          onPush: () => noop,
          onClosed: () => noop,
          destroy: noop,
        }),
      mainWindowPushes: { subscribe: (): (() => void) => noop },
      uploads: new RemoteUploadStore(uploads),
      readFile: (): Promise<never> =>
        Promise.reject(new Error('Unexpected file read')),
      disposition: getRemoteChannelDisposition,
      isAuthorized: (): boolean => true,
      version: PEER_VERSION,
      hello: (): { name: string; platform: 'darwin' } => ({
        name: 'Host',
        platform: 'darwin',
      }),
      onClose: noop,
    });
    const controller = new RpcPeer(initiator, {
      onRequest: (): Promise<never> =>
        Promise.reject(new Error('Unexpected host request')),
      onEvent: noop,
    });
    try {
      await controller.request(REMOTE_METHODS.hello, {
        version: PEER_VERSION,
      });
      const payload = await controller.request(REMOTE_METHODS.invoke, {
        channel: SKILLS_CHANNELS.PACKAGE_ANALYZE,
        args: [
          { sourceId: 'custom:app', skillName: 'rc-notes', rawSkill: RC_SKILL },
        ],
      });
      expect(payload).toMatchObject({ state: 'blocked' });
      const text = JSON.stringify(payload);
      expect(text).not.toContain(RC_FILE_TOKEN);
      expect(text).not.toContain(RC_INVOCATION.slice(1));
    } finally {
      controller.close('closed');
      host.rpc.close('closed');
      for (const device of [controllerDevice, hostDevice]) {
        device.manager.dispose();
        device.endpoint.stop();
      }
      rmSync(uploads, { recursive: true, force: true });
    }
  });
});

describe('a definition whose name looks like a secret blocks before it is read, and the name goes nowhere (CAN-7476)', () => {
  const TOKEN = `gh${'p'}_${'D'.repeat(30)}`;
  function document(): Uint8Array {
    const validated = validateSharedContainerDefinitionDocument({
      version: 1,
      kind: 'pipeline_definition',
      references: [],
      name: 'deploy',
      yaml: 'steps:\n  - run: deploy\n',
    });
    if (!validated.ok) throw new Error(validated.errors.join('; '));
    return encodeSharedContainerDefinitionDocument(validated.value);
  }
  type Definition = NonNullable<
    Parameters<typeof analyzeCapabilityPackage>[0]['definitionResources']
  >[number];
  const definition = (overrides: Partial<Definition> = {}): Definition => ({
    kind: 'pipeline_definition',
    displayName: TOKEN,
    identity: `pipeline:${TOKEN}`,
    document: document(),
    bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
    ...overrides,
  });
  function analyse(
    definitionResources: Definition[],
  ): ReturnType<typeof analyzeCapabilityPackage> {
    return analyzeUnchanged({
      rawContent: 'Definition.',
      invocableInventory: {
        version: 6,
        builtAt: '2026-11-11T00:00:00.000Z',
        entries: [],
      },
      capabilityInventoryEntryIdsByKey: {},
      sourceByInventoryEntryId: {},
      requests: [],
      definitionResources,
    });
  }
  const blockerText = (
    analysis: Awaited<ReturnType<typeof analyse>>,
  ): Array<{ code: string; message: string; subject?: string }> =>
    analysis.summary.blockers.map(({ code, message, subject }) => ({
      code,
      message,
      ...(subject === undefined ? {} : { subject }),
    }));

  const nameBlocker = (label: string): object => ({
    code: 'SUSPECTED_SECRET',
    message: `${label} has a name that looks like it contains a secret (a GitHub token). Rename it, then share again.`,
    subject: '[redacted name]',
  });

  it.each([
    ['display name', { displayName: TOKEN, identity: 'pipeline:deploy' }],
    ['identity', { displayName: 'deploy', identity: `pipeline:${TOKEN}` }],
  ])(
    'a valid definition whose %s looks like a secret blocks, and the name goes nowhere',
    async (_label, names) => {
      const analysis = await analyse([definition(names)]);
      expect(analysis.summary.state).toBe('blocked');
      expect(blockerText(analysis)).toEqual([nameBlocker('A pipeline')]);
      expect(JSON.stringify(analysis.summary)).not.toContain(TOKEN);
      expect(analysis.summary.manifest?.publisherNotes ?? []).toEqual([]);
    },
  );

  it('a duplicated, invalid or unresolvable definition with such a name blocks on its name alone', async () => {
    // Identical blockers are reported once.
    const twice = await analyse([definition(), definition()]);
    expect(blockerText(twice)).toEqual([nameBlocker('A pipeline')]);
    const invalid = await analyse([definition({ kind: 'agent_definition' })]);
    expect(blockerText(invalid)).toEqual([nameBlocker('An agent')]);
    const unresolved = await analyse([
      definition({
        requestKeys: [
          {
            provider: 'claude',
            key: 'skill:custom:app:missing',
            required: true,
          },
        ],
        promptTexts: [{ provider: 'claude', text: 'Run /missing-tool.' }],
      }),
    ]);
    expect(blockerText(unresolved)).toEqual([nameBlocker('A pipeline')]);
    for (const analysis of [twice, invalid, unresolved])
      expect(JSON.stringify(analysis.summary)).not.toContain(TOKEN);
  });

  it('a definition with an ordinary name still packages under that name', async () => {
    const analysis = await analyse([
      definition({ displayName: 'deploy', identity: 'pipeline:deploy' }),
    ]);
    expect(analysis.summary.state).toBe('ready');
    expect(
      (analysis.summary.manifest?.resources ?? []).map(
        (resource) => resource.displayName,
      ),
    ).toEqual(['deploy']);
  });
});

describe('a workflow share blocks on a pipeline, asset or child resource whose name or path looks like a secret (CAN-7476)', () => {
  const TOKEN = `gh${'p'}_${'W'.repeat(30)}`;
  const PIPELINE_YAML = 'name: deploy\njobs: {}\n';
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });
  function folder(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'workflow-secret-'));
    roots.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }
  type Input = Parameters<typeof analyzeCapabilityPackage>[0];
  function analyse(
    extra: Partial<Input>,
  ): ReturnType<typeof analyzeCapabilityPackage> {
    return analyzeUnchanged({
      rawContent: 'Workflow.',
      invocableInventory: {
        version: 6,
        builtAt: '2026-11-11T00:00:00.000Z',
        entries: [],
      },
      capabilityInventoryEntryIdsByKey: {},
      sourceByInventoryEntryId: {},
      requests: [],
      ...extra,
    });
  }
  const actionPipeline = (
    name = 'deploy',
  ): NonNullable<Input['automationPipelines']>[number] => ({
    pipelineKey: 'action',
    name,
    source: 'user',
    rawContent: PIPELINE_YAML,
    bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
  });
  // Name blockers share a subject, so one stands for every name field the
  // final check redacted and lists their kinds; a path blocker is always
  // about a file path.
  const gateBlocker = (isPath = false): unknown => {
    const message: unknown = isPath
      ? 'A file path in this package looks like it contains a secret (a GitHub token). Rename it, then share again.'
      : expect.stringMatching(
          /^(An? [a-z ]+ in this package looks like it contains a secret \(a GitHub token\)\. Rename it|Names in this package look like they contain a secret \([a-z ]+(, [a-z ]+)+; a GitHub token\)\. Rename them), then share again\.$/,
        );
    return expect.objectContaining({
      code: 'SUSPECTED_SECRET',
      message,
      subject: isPath ? '[redacted path]' : '[redacted name]',
    });
  };
  const expectNowhere = (
    analysis: Awaited<ReturnType<typeof analyse>>,
  ): void => {
    expect(JSON.stringify(analysis.summary)).not.toContain(TOKEN);
    for (const bytes of analysis.blobs.values())
      expect(Buffer.from(bytes).toString('utf8')).not.toContain(TOKEN);
  };

  it('blocks an automation pipeline whose name looks like a secret', async () => {
    const analysis = await analyse({
      automationPipelines: [actionPipeline(TOKEN)],
    });
    expect(analysis.summary.blockers).toContainEqual(gateBlocker());
    expectNowhere(analysis);
  });

  it('blocks an automation pipeline whose key looks like a secret', async () => {
    const analysis = await analyse({
      pipelineInventory: [
        {
          key: TOKEN,
          pipelineId: 'p1',
          name: 'deploy',
          source: 'user',
          path: '/pipelines/deploy.yml',
          hasInstalledPackage: false,
        },
      ],
      pipelineRequests: [{ pipelineId: 'p1', source: 'user' }],
      automationPipelines: [
        actionPipeline(),
        { ...actionPipeline(), pipelineKey: TOKEN },
      ],
    });
    expect(analysis.summary.blockers).toContainEqual(gateBlocker());
    expectNowhere(analysis);
  });

  it('blocks an asset whose id looks like a secret', async () => {
    const home = folder({ 'data/notes.txt': 'Notes.\n' });
    const analysis = await analyse({
      homedir: home,
      automationPipelines: [actionPipeline()],
      fileAssets: [
        {
          pipelineKey: 'action',
          assetId: TOKEN,
          sourcePath: join(home, 'data'),
          required: true,
          installMode: 'seed',
          localState: [],
        },
      ],
    });
    expect(analysis.summary.blockers).toContainEqual(gateBlocker());
    expectNowhere(analysis);
  });

  it('blocks a file in an asset whose name looks like a secret', async () => {
    const home = folder({
      'data/notes.txt': 'Notes.\n',
      [`data/${TOKEN}.txt`]: 'Plain notes.\n',
    });
    const analysis = await analyse({
      homedir: home,
      automationPipelines: [actionPipeline()],
      fileAssets: [
        {
          pipelineKey: 'action',
          assetId: 'data',
          sourcePath: join(home, 'data'),
          required: true,
          installMode: 'seed',
          localState: [],
        },
      ],
    });
    expect(analysis.summary.blockers).toContainEqual(gateBlocker(true));
    expectNowhere(analysis);
  });

  it('never shows an asset folder path that looks like a secret in its blocker', async () => {
    const home = folder({ 'other/notes.txt': 'Notes.\n' });
    const analysis = await analyse({
      homedir: home,
      automationPipelines: [actionPipeline()],
      fileAssets: [
        {
          pipelineKey: 'action',
          assetId: 'data',
          sourcePath: join(home, TOKEN, 'data'),
          required: true,
          installMode: 'seed',
          localState: [],
        },
      ],
    });
    expect(analysis.summary.blockers).toContainEqual(
      expect.objectContaining({
        code: 'MISSING_REQUIRED_ASSET',
        message:
          'Asset "data" in "deploy" has no folder at [redacted path]. Create it, or mark the asset as not required.',
      }),
    );
    expectNowhere(analysis);
  });

  const portable = (
    root: string,
    overrides: Partial<NonNullable<Input['portableResources']>[number]> = {},
  ): NonNullable<Input['portableResources']>[number] => ({
    kind: 'pipeline_action',
    displayName: 'build',
    invocationKeys: ['build'],
    bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
    descriptor: {
      sourceRoot: root,
      memberPath: 'actions/build',
      exportRoot: root,
      sourceVisibility: 'local',
      runtimeKind: 'plugin_fragment',
      rootName: 'pipelines-test',
    },
    ...overrides,
  });

  it('blocks a child pipeline whose name looks like a secret', async () => {
    const root = folder({ [`pipelines/${TOKEN}.yml`]: PIPELINE_YAML });
    const analysis = await analyse({
      portableResources: [
        portable(root, {
          kind: 'child_pipeline',
          displayName: `pipelines/${TOKEN}.yml`,
          invocationKeys: [`pipelines/${TOKEN}.yml`],
          descriptor: {
            sourceRoot: root,
            memberPath: `pipelines/${TOKEN}.yml`,
            exportRoot: root,
            sourceVisibility: 'local',
            runtimeKind: 'plugin_fragment',
            rootName: 'pipelines-test',
          },
        }),
      ],
    });
    expect(analysis.summary.blockers).toContainEqual(gateBlocker());
    expectNowhere(analysis);
  });

  it('carries the token nowhere in anything the analysis returns or uploads, however many fields hold it', async () => {
    const home = folder({
      'data/notes.txt': 'Notes.\n',
      [`more/${TOKEN}.txt`]: 'Plain notes.\n',
      'big/notes.txt': 'Notes.\n',
      [`pipelines/${TOKEN}.yml`]: PIPELINE_YAML,
      'actions/build/run.sh': 'echo build\n',
      [`actions/build/${TOKEN}.txt`]: 'Plain notes.\n',
    });
    const asset = (
      assetId: string,
      folderName: string,
    ): NonNullable<Input['fileAssets']>[number] => ({
      pipelineKey: 'action',
      assetId,
      sourcePath: join(home, folderName),
      required: true,
      installMode: 'seed',
      localState: [],
    });
    // Too big to package, and a required asset with no folder: both
    // blockers would name the file or the pipeline.
    writeFileSync(
      join(home, 'big', `${TOKEN}.bin`),
      Buffer.alloc(PIPELINE_PACKAGE_MAX_FILE_BYTES + 1),
    );
    const analysis = await analyse({
      homedir: home,
      automationPipelines: [actionPipeline(TOKEN)],
      fileAssets: [
        asset(TOKEN, 'data'),
        asset('more', 'more'),
        asset('big', 'big'),
        asset('gone', 'gone'),
      ],
      portableResources: [
        portable(home),
        portable(home, {
          kind: 'child_pipeline',
          displayName: `pipelines/${TOKEN}.yml`,
          invocationKeys: [`pipelines/${TOKEN}.yml`],
          descriptor: {
            sourceRoot: home,
            memberPath: `pipelines/${TOKEN}.yml`,
            exportRoot: home,
            sourceVisibility: 'local',
            runtimeKind: 'plugin_fragment',
            rootName: 'pipelines-test',
          },
        }),
      ],
    });
    expect(analysis.summary.state).toBe('blocked');
    // Everything that leaves the analysis: the summary main returns to the
    // dialog and Remote Control (manifest included), the blobs it uploads,
    // and the refusal a publish names.
    const returned = JSON.stringify({
      summary: analysis.summary,
      blobs: [...analysis.blobs.values()].map((bytes) =>
        Buffer.from(bytes).toString('utf8'),
      ),
      secretRefusal: analysis.secretRefusal ?? null,
    });
    expect(returned.split(TOKEN).length - 1).toBe(0);
  });

  it('never shows a pipeline name that looks like a secret in a missing asset folder blocker', async () => {
    const home = folder({ 'data/notes.txt': 'Notes.\n' });
    const analysis = await analyse({
      homedir: home,
      automationPipelines: [actionPipeline(TOKEN)],
      fileAssets: [
        {
          pipelineKey: 'action',
          assetId: 'gone',
          sourcePath: join(home, 'gone'),
          required: true,
          installMode: 'seed',
          localState: [],
        },
      ],
    });
    expect(analysis.summary.blockers).toContainEqual(
      expect.objectContaining({
        code: 'MISSING_REQUIRED_ASSET',
        message: expect.stringContaining(
          'Asset "gone" in "[redacted name]" has no folder at ',
        ) as unknown,
      }),
    );
    expect(analysis.summary.blockers).toContainEqual(gateBlocker());
    expectNowhere(analysis);
  });

  it('hides the details of a size-limit blocker whose file name looks like a secret, keeping its code', async () => {
    const home = folder({ 'data/notes.txt': 'Notes.\n' });
    writeFileSync(
      join(home, 'data', `${TOKEN}.bin`),
      Buffer.alloc(PIPELINE_PACKAGE_MAX_FILE_BYTES + 1),
    );
    const analysis = await analyse({
      homedir: home,
      automationPipelines: [actionPipeline()],
      fileAssets: [
        {
          pipelineKey: 'action',
          assetId: 'data',
          sourcePath: join(home, 'data'),
          required: true,
          installMode: 'seed',
          localState: [],
        },
      ],
    });
    expect(analysis.summary.blockers).toContainEqual(
      expect.objectContaining({
        code: 'PACKAGE_LIMIT_EXCEEDED',
        message:
          'Part of this package looks like it contains a secret (a GitHub token), so the details are hidden. Rename it, then share again.',
      }),
    );
    expectNowhere(analysis);
  });

  it('keeps a secret blocker through the confirmed retry, and leaves the input as it was', async () => {
    const input: Partial<Input> = {
      // Blocks only while unconfirmed, so the analysis retries without it.
      promptSources: [
        {
          provider: 'claude',
          target: 'subject',
          text: 'Run /missing-helper.',
          unconfirmed: true,
        },
      ],
      environmentRequirements: [
        {
          id: 'mcp:demo',
          kind: 'mcp',
          displayName: TOKEN,
          required: true,
          affectedSteps: [],
          setupHint: 'Connect it.',
        },
      ],
      dismissedReferences: [{ kind: 'child_pipeline_ref', token: TOKEN }],
    };
    const original = JSON.parse(JSON.stringify(input)) as Partial<Input>;
    const analysis = await analyse(input);
    expect(analysis.summary.state).toBe('blocked');
    expect(analysis.summary.blockers).toContainEqual(gateBlocker());
    expect(analysis.secretRefusal).toMatch(/a GitHub token/);
    expect(input.environmentRequirements).toEqual(
      original.environmentRequirements,
    );
    expect(input.dismissedReferences).toEqual(original.dismissedReferences);
    expectNowhere(analysis);
  });

  it.each([
    [
      'a requirement',
      {
        environmentRequirements: [
          {
            id: 'mcp:demo',
            kind: 'mcp' as const,
            displayName: 'demo',
            required: true,
            affectedSteps: [{ jobId: TOKEN, stepId: 'build' }],
            setupHint: 'Connect it.',
          },
        ],
      },
    ],
    [
      'a publisher note',
      {
        promptSources: [
          {
            provider: 'claude' as const,
            jobId: TOKEN,
            stepId: 'build',
            text: 'Run /dismissed-helper.',
          },
        ],
        dismissedInvocations: [
          { provider: 'claude' as const, token: '/dismissed-helper' },
        ],
      },
    ],
  ])(
    'blocks a step name that looks like a secret in the steps %s affects',
    async (_label, extra) => {
      const analysis = await analyse(extra);
      expect(analysis.summary.blockers).toContainEqual(
        expect.objectContaining({
          code: 'SUSPECTED_SECRET',
          message:
            'A step name in this package looks like it contains a secret (a GitHub token). Rename it, then share again.',
          subject: '[redacted name]',
        }),
      );
      expectNowhere(analysis);
    },
  );

  it("never writes a redaction into the caller's own blocker locations", async () => {
    const occurrence = { jobId: TOKEN, stepId: 'build' };
    const analysis = await analyse({
      hostBlockers: [
        {
          code: 'INVALID_PACKAGE',
          message: 'This step is not supported.',
          subject: 'build',
          occurrences: [occurrence],
        },
      ],
    });
    expect(analysis.summary.blockers).toContainEqual(
      expect.objectContaining({
        code: 'INVALID_PACKAGE',
        occurrences: [{ jobId: '[redacted name]', stepId: 'build' }],
      }),
    );
    expect(occurrence).toEqual({ jobId: TOKEN, stepId: 'build' });
    expectNowhere(analysis);
  });

  it('blocks a requirement whose name looks like a secret', async () => {
    const analysis = await analyse({
      environmentRequirements: [
        {
          id: 'mcp:demo',
          kind: 'mcp',
          displayName: TOKEN,
          required: true,
          affectedSteps: [],
          setupHint: 'Connect it.',
        },
      ],
    });
    expect(analysis.summary.blockers).toContainEqual(gateBlocker());
    expectNowhere(analysis);
  });

  it('names every kind of field it blocked on in one message, never a value', async () => {
    const home = folder({ 'data/notes.txt': 'Notes.\n' });
    const analysis = await analyse({
      homedir: home,
      automationPipelines: [actionPipeline(TOKEN)],
      fileAssets: [
        {
          pipelineKey: 'action',
          assetId: TOKEN,
          sourcePath: join(home, 'data'),
          required: true,
          installMode: 'seed',
          localState: [],
        },
      ],
    });
    const names = analysis.summary.blockers.filter(
      (blocker) => blocker.subject === '[redacted name]',
    );
    // The asset's resource takes its id, name and folder from the asset id;
    // its source label is the pipeline name, which it gets already redacted.
    expect(names.map((blocker) => blocker.message)).toEqual([
      'Names in this package look like they contain a secret (id, name, asset id, folder name, pipeline name; a GitHub token). Rename them, then share again.',
    ]);
    expect(analysis.secretRefusal).toBe(names[0]?.message);
    expectNowhere(analysis);
  });

  it('blocks a requirement whose id or setup hint holds a name that looks like a secret', async () => {
    const analysis = await analyse({
      environmentRequirements: [
        {
          id: `mcp:${TOKEN}`,
          kind: 'mcp',
          displayName: 'demo',
          required: true,
          affectedSteps: [],
          setupHint: `Connect ${TOKEN} first.`,
        },
      ],
    });
    expect(analysis.summary.blockers).toContainEqual(gateBlocker());
    expectNowhere(analysis);
  });

  it("never shows a step name that looks like a secret in a blocker's location, and blocks on it", async () => {
    const analysis = await analyse({
      promptSources: [
        {
          provider: 'claude',
          jobId: TOKEN,
          stepId: 'build',
          text: 'Run /missing-tool.',
        },
      ],
    });
    expect(analysis.summary.blockers).toContainEqual(
      expect.objectContaining({
        code: 'UNRESOLVED_INVOCATION',
        occurrences: [{ jobId: '[redacted name]', stepId: 'build' }],
      }),
    );
    expect(analysis.summary.blockers).toContainEqual(
      expect.objectContaining({
        code: 'SUSPECTED_SECRET',
        message:
          'A step name in this package looks like it contains a secret (a GitHub token). Rename it, then share again.',
        subject: '[redacted name]',
      }),
    );
    expectNowhere(analysis);
  });

  it('blocks an asset file left out under a folder whose name looks like a secret', async () => {
    const home = folder({
      'data/notes.txt': 'Notes.\n',
      [`data/${TOKEN}/.env`]: 'MODE=1\n',
    });
    const analysis = await analyse({
      homedir: home,
      automationPipelines: [actionPipeline()],
      fileAssets: [
        {
          pipelineKey: 'action',
          assetId: 'data',
          sourcePath: join(home, 'data'),
          required: true,
          installMode: 'seed',
          localState: [],
        },
      ],
    });
    expect(analysis.summary.blockers).toContainEqual(gateBlocker(true));
    expectNowhere(analysis);
  });

  it('lets ordinary names and paths that only mention a secret through', async () => {
    const sha = 'a3bb15e1dae739c959ee1526cbeb28003ce77463';
    const home = folder({
      'api-token-docs/notes.md': 'Notes.\n',
      'actions/build/run.sh': 'echo build\n',
      'actions/build/secrets-manager/README.md': 'How we manage them.\n',
      'actions/build/password-reset.yaml': 'steps: []\n',
      'actions/build/token-refresh/guide.md': 'Refresh it.\n',
      'actions/build/api-key-rotation.md': 'Rotate.\n',
      'actions/build/github-token-helper/run.md': 'Run.\n',
      'pipelines/password-reset-flow.yml': PIPELINE_YAML,
    });
    const analysis = await analyse({
      homedir: home,
      pipelineInventory: [
        {
          key: sha,
          pipelineId: 'p1',
          name: 'token-refresh',
          source: 'user',
          path: '/pipelines/token-refresh.yml',
          hasInstalledPackage: false,
        },
      ],
      pipelineRequests: [{ pipelineId: 'p1', source: 'user' }],
      automationPipelines: [
        actionPipeline('api-key-rotation'),
        { ...actionPipeline('token-refresh'), pipelineKey: sha },
      ],
      fileAssets: [
        {
          pipelineKey: 'action',
          assetId: 'api-token-docs',
          sourcePath: join(home, 'api-token-docs'),
          required: true,
          installMode: 'seed',
          localState: [],
        },
      ],
      portableResources: [
        portable(home),
        portable(home, {
          kind: 'child_pipeline',
          displayName: 'pipelines/password-reset-flow.yml',
          invocationKeys: ['pipelines/password-reset-flow.yml'],
          descriptor: {
            sourceRoot: home,
            memberPath: 'pipelines/password-reset-flow.yml',
            exportRoot: home,
            sourceVisibility: 'local',
            runtimeKind: 'plugin_fragment',
            rootName: 'github-token-helper',
          },
        }),
      ],
    });
    expect(
      analysis.summary.blockers.filter(
        (blocker) => blocker.code === 'SUSPECTED_SECRET',
      ),
    ).toEqual([]);
    expect(JSON.stringify(analysis.summary)).not.toContain('[redacted');
    expect(
      (analysis.summary.manifest?.resources ?? []).flatMap((resource) =>
        resource.trees.flatMap((tree) =>
          tree.entries.map((entry) => entry.path),
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        'actions/build/secrets-manager/README.md',
        'actions/build/password-reset.yaml',
        'actions/build/token-refresh/guide.md',
      ]),
    );
  });

  it('blocks a file in a pipeline action whose name looks like a secret, and packages a clean one', async () => {
    const root = folder({
      'actions/build/run.sh': 'echo build\n',
      [`actions/build/${TOKEN}.txt`]: 'Plain notes.\n',
    });
    const analysis = await analyse({ portableResources: [portable(root)] });
    expect(analysis.summary.blockers).toContainEqual(gateBlocker(true));
    expectNowhere(analysis);
    const clean = folder({ 'actions/build/run.sh': 'echo build\n' });
    const ready = await analyse({ portableResources: [portable(clean)] });
    expect(
      ready.summary.blockers.filter(
        (blocker) => blocker.code === 'SUSPECTED_SECRET',
      ),
    ).toEqual([]);
    expect(
      (ready.summary.manifest?.resources ?? []).map(
        (resource) => resource.displayName,
      ),
    ).toContain('build');
  });
});

describe('a workflow share reads asset, child pipeline, action and pipeline files with the shared member check (CAN-7492)', () => {
  const W = 'W'.repeat(30);
  // Each is caught by the shared member check and missed by the package rule.
  const FIXTURES = [
    [
      'a JSON-escaped token',
      'notes.json',
      `{"note":"see gh${'p'}\\u005f${W}"}\n`,
      'a GitHub token',
    ],
    [
      'a text-escaped token',
      'notes.md',
      `see gh${'p'}\\x5f${W} for access\n`,
      'a GitHub token',
    ],
    [
      'a password in a URL',
      'notes.md',
      'Connect to postgres://admin:hunter2pass@db.internal/app\n',
      'a password in a URL',
    ],
    [
      'JSON nested too deeply to check',
      'notes.json',
      `${'['.repeat(20_000)}${']'.repeat(20_000)}\n`,
      null,
    ],
  ] as const;
  const PLACEHOLDERS =
    'Run with NPM_TOKEN=${NPM_TOKEN} or ${{ secrets.NPM_TOKEN }} as <your token> against postgres://admin@db/app.\n';
  const PIPELINE_YAML = 'name: deploy\njobs: {}\n';
  const NOT_IGNORED = {
    gitIgnored: (): Promise<{
      isIgnored: (absolutePath: string) => boolean;
      checked: true;
    }> => Promise.resolve({ isIgnored: () => false, checked: true }),
  };
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });
  function folder(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'workflow-member-'));
    roots.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }
  type Input = Parameters<typeof analyzeCapabilityPackage>[0];
  function analyse(
    extra: Partial<Input>,
  ): ReturnType<typeof analyzeCapabilityPackage> {
    return analyzeUnchanged({
      rawContent: 'Workflow.',
      invocableInventory: {
        version: 6,
        builtAt: '2026-11-11T00:00:00.000Z',
        entries: [],
      },
      capabilityInventoryEntryIdsByKey: {},
      sourceByInventoryEntryId: {},
      requests: [],
      ...extra,
    });
  }
  const pipeline = (
    rawContent = PIPELINE_YAML,
  ): NonNullable<Input['automationPipelines']>[number] => ({
    pipelineKey: 'action',
    name: 'deploy',
    source: 'user',
    rawContent,
    bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
  });
  const asset = (home: string): NonNullable<Input['fileAssets']>[number] => ({
    pipelineKey: 'action',
    assetId: 'data',
    sourcePath: join(home, 'data'),
    required: true,
    installMode: 'seed',
    localState: [],
  });
  const action = (
    root: string,
  ): NonNullable<Input['portableResources']>[number] => ({
    kind: 'pipeline_action',
    displayName: 'build',
    invocationKeys: ['build'],
    bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
    descriptor: {
      sourceRoot: root,
      memberPath: 'actions/build',
      exportRoot: root,
      sourceVisibility: 'local',
      runtimeKind: 'plugin_fragment',
      rootName: 'pipelines-test',
    },
  });
  const childPipeline = (
    root: string,
  ): NonNullable<Input['portableResources']>[number] => ({
    kind: 'child_pipeline',
    displayName: 'pipelines/notes.yml',
    invocationKeys: ['pipelines/notes.yml'],
    bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
    descriptor: {
      sourceRoot: root,
      memberPath: 'pipelines/notes.yml',
      exportRoot: root,
      sourceVisibility: 'local',
      runtimeKind: 'plugin_fragment',
      rootName: 'pipelines-test',
    },
  });
  // The rule and the file, never the value.
  const secretMessage = (
    owner: string,
    file: string,
    label: string | null,
  ): string =>
    label === null
      ? `${owner} has a file, ${file}, that is nested too deeply to check for secrets. Simplify it, then share again.`
      : `${owner} looks like it contains a secret (${label} in ${file}). Remove it, or replace it with a placeholder such as \${{ secrets.NAME }}, then share again.`;
  const secretBlockers = (
    analysis: Awaited<ReturnType<typeof analyse>>,
  ): unknown[] =>
    analysis.summary.blockers.filter(
      (blocker) => blocker.code === 'SUSPECTED_SECRET',
    );
  const uploaded = (analysis: Awaited<ReturnType<typeof analyse>>): string =>
    [...analysis.blobs.values()]
      .map((bytes) => Buffer.from(bytes).toString('utf8'))
      .join('\n');

  it.each(FIXTURES)(
    'blocks a share whose asset file holds %s, naming the asset, its pipeline, the rule and the file',
    async (_label, file, text, rule) => {
      const home = folder({
        'data/readme.txt': 'Read me.\n',
        [`data/${file}`]: text,
      });
      const analysis = await analyse({
        homedir: home,
        automationPipelines: [pipeline()],
        fileAssets: [asset(home)],
      });
      expect(secretBlockers(analysis)).toEqual([
        expect.objectContaining({
          message: secretMessage('The asset "data" in "deploy"', file, rule),
          subject: file,
          relativePath: file,
        }),
      ]);
      expect(analysis.summary.withheldFiles ?? []).toEqual([]);
      expect(uploaded(analysis)).not.toContain(text);
    },
  );

  it.each(FIXTURES)(
    'withholds an asset file that holds %s from a cloud copy instead',
    async (_label, file, text) => {
      const home = folder({
        'data/readme.txt': 'Read me.\n',
        [`data/${file}`]: text,
      });
      const analysis = await analyse({
        cloudCopy: NOT_IGNORED,
        homedir: home,
        automationPipelines: [pipeline()],
        fileAssets: [asset(home)],
      });
      expect(secretBlockers(analysis)).toEqual([]);
      expect(analysis.summary.withheldFiles).toEqual([
        {
          pipelineKey: 'action',
          assetId: 'data',
          relativePath: file,
          reason: 'suspected_secret',
        },
      ]);
      expect(uploaded(analysis)).not.toContain(text);
      expect(uploaded(analysis)).toContain('Read me.');
    },
  );

  it.each(FIXTURES)(
    'blocks a pipeline action file that holds %s, in a share and a cloud copy alike',
    async (_label, file, text, rule) => {
      const root = folder({
        'actions/build/run.sh': 'echo build\n',
        [`actions/build/${file}`]: text,
      });
      for (const cloudCopy of [undefined, NOT_IGNORED]) {
        const analysis = await analyse({
          ...(cloudCopy === undefined ? {} : { cloudCopy }),
          portableResources: [action(root)],
        });
        expect(secretBlockers(analysis)).toEqual([
          expect.objectContaining({
            message: secretMessage(
              'The pipeline action "build"',
              `actions/build/${file}`,
              rule,
            ),
          }),
        ]);
        expect(uploaded(analysis)).not.toContain(text);
      }
    },
  );

  it.each(FIXTURES)(
    'blocks a child pipeline whose file holds %s, in a share and a cloud copy alike',
    async (_label, _file, text, rule) => {
      const root = folder({ 'pipelines/notes.yml': text });
      for (const cloudCopy of [undefined, NOT_IGNORED]) {
        const analysis = await analyse({
          ...(cloudCopy === undefined ? {} : { cloudCopy }),
          portableResources: [childPipeline(root)],
        });
        expect(secretBlockers(analysis)).toEqual([
          expect.objectContaining({
            message: secretMessage(
              'The child pipeline "pipelines/notes.yml"',
              'pipelines/notes.yml',
              rule,
            ),
          }),
        ]);
        expect(uploaded(analysis)).not.toContain(text);
      }
    },
  );

  it.each(FIXTURES)(
    'blocks an automation pipeline whose YAML holds %s',
    async (_label, _file, text, rule) => {
      // JSON this deep is caught as a whole file, so that pipeline is
      // nothing but the JSON; the others carry their text in a comment.
      const rawContent =
        rule === null ? text : `${PIPELINE_YAML}# ${text.trim()}\n`;
      const analysis = await analyse({
        automationPipelines: [pipeline(rawContent)],
      });
      expect(secretBlockers(analysis)).toEqual([
        expect.objectContaining({
          message: secretMessage(
            'The pipeline "deploy"',
            'pipeline.yaml',
            rule,
          ),
          subject: 'deploy',
          relativePath: 'pipeline.yaml',
        }),
      ]);
      expect(uploaded(analysis)).not.toContain(text.trim());
    },
  );

  it('never shows a file name that looks like a secret in the blocker for its content', async () => {
    const token = `gh${'p'}_${W}`;
    const root = folder({
      'actions/build/run.sh': 'echo build\n',
      [`actions/build/${token}.md`]: FIXTURES[2][2],
    });
    const analysis = await analyse({ portableResources: [action(root)] });
    expect(secretBlockers(analysis)).toContainEqual(
      expect.objectContaining({
        message: secretMessage(
          'The pipeline action "build"',
          '[redacted path]',
          'a password in a URL',
        ),
        subject: '[redacted path]',
      }),
    );
    expect(JSON.stringify(analysis.summary)).not.toContain(token);
  });

  // The YAML is read as it uploads, whitespace and all: a tab can carry a URL
  // credential, and a line break ends an empty assignment.
  const TAB_CREDENTIAL_YAML =
    'name: deploy\njobs:\n  build:\n    steps:\n      - run: curl -u\tadmin:hunter2pass https://example.com\n';
  const EMPTY_EXPORT_YAML =
    'name: deploy\njobs:\n  build:\n    steps:\n      - run: |\n          export NPM_TOKEN=\n          npm ci\n';

  it('blocks an automation pipeline whose run step separates a URL credential with a tab', async () => {
    const analysis = await analyse({
      automationPipelines: [pipeline(TAB_CREDENTIAL_YAML)],
    });
    expect(secretBlockers(analysis)).toEqual([
      expect.objectContaining({
        message: secretMessage(
          'The pipeline "deploy"',
          'pipeline.yaml',
          'a password in a URL',
        ),
      }),
    ]);
    expect(JSON.stringify(analysis.summary)).not.toContain('hunter2pass');
    expect(uploaded(analysis)).not.toContain('hunter2pass');
  });

  it('lets an empty credential export followed by another command through', async () => {
    const analysis = await analyse({
      automationPipelines: [pipeline(EMPTY_EXPORT_YAML)],
    });
    expect(secretBlockers(analysis)).toEqual([]);
    expect(uploaded(analysis)).toContain('export NPM_TOKEN=');
  });

  it.each([
    ['a tab-separated URL credential', TAB_CREDENTIAL_YAML],
    ['an empty export followed by another command', EMPTY_EXPORT_YAML],
  ])(
    "gives pipeline YAML holding %s the hosted check's verdict on the same bytes",
    async (_label, yaml) => {
      // The hosted check reads the uploaded blob with this rule (CAN-7492).
      const hosted = findSharedMemberFileCredentialRule(
        new TextEncoder().encode(yaml),
      );
      const analysis = await analyse({ automationPipelines: [pipeline(yaml)] });
      expect(secretBlockers(analysis)).toEqual(
        hosted === null
          ? []
          : [
              expect.objectContaining({
                message: secretMessage(
                  'The pipeline "deploy"',
                  'pipeline.yaml',
                  hosted === 'unreadable'
                    ? null
                    : sharedSkillSecretRuleLabel(hosted),
                ),
              }),
            ],
      );
    },
  );

  it('lets asset, action, child pipeline and pipeline files that only name placeholders through', async () => {
    const home = folder({
      'data/notes.md': PLACEHOLDERS,
      'actions/build/notes.md': PLACEHOLDERS,
      'pipelines/notes.yml': `${PIPELINE_YAML}# ${PLACEHOLDERS}`,
    });
    const analysis = await analyse({
      homedir: home,
      automationPipelines: [
        pipeline(`${PIPELINE_YAML}# ${PLACEHOLDERS.trim()}\n`),
      ],
      fileAssets: [asset(home)],
      portableResources: [action(home), childPipeline(home)],
    });
    expect(secretBlockers(analysis)).toEqual([]);
    expect(analysis.summary.withheldFiles ?? []).toEqual([]);
    expect(uploaded(analysis)).toContain(PLACEHOLDERS.trim());
  });
});

describe('a result the final check blocked can never be uploaded or committed (CAN-7476)', () => {
  // A name the package check lets through and only the shared check catches,
  // so the final check is the one thing that blocks this pipeline.
  const HINT = `Run with NPM_TOKEN=npm_${'g'.repeat(8)} set.`;
  const PIPELINE = [
    'name: deploy',
    'on: dispatch',
    'dependencies:',
    '  - id: tool',
    '    kind: local_runtime',
    '    runtime: node',
    '    required: true',
    '    install:',
    `      instructions: ${HINT}`,
    'jobs:',
    '  build:',
    '    steps:',
    '      - id: compile',
    '        run: echo build',
    '',
  ].join('\n');
  const REFUSAL =
    'A requirement name in this package looks like it contains a secret (a credential variable). Rename it, then share again.';

  it('refuses the commit and the shared workflow before any upload request', async () => {
    const { analyzePackageRequest, createPackagedSharedPipeline } =
      await import('../../pipelines/pipeline-package-service');
    const summary = await analyzePackageRequest(
      { rawPipeline: PIPELINE },
      { persistDismissals: false },
    );
    expect(summary).toMatchObject({
      state: 'blocked',
      blockers: [
        {
          code: 'SUSPECTED_SECRET',
          message: REFUSAL,
          subject: '[redacted name]',
        },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain(HINT);
    // The manifest's redacted ids no longer match each other, which is safe
    // only because nothing commits a blocked result.
    const commit = await invoke(SKILLS_CHANNELS.PACKAGE_COMMIT, {
      analysisId: summary.analysisId,
    });
    expect(commit).toMatchObject({
      ok: false,
      failure: {
        kind: 'dependency-review',
        stage: 'prepare',
        message: REFUSAL,
      },
    });
    const create = await createPackagedSharedPipeline({
      rawPipeline: PIPELINE,
      distributionMode: 'package',
      analysisId: summary.analysisId,
      selectedOptionalResourceIds: [],
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(create).toMatchObject({
      name: 'PackageAnalysisBlockedError',
      message: REFUSAL,
    });
    expect(requests).toEqual([]);
  });
});
