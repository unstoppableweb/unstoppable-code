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
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { COLLECTIONS_CHANNELS } from '@canopy/desktop-shared/constants/collection-channels';
import type {
  PipelinePackageManifestV1,
  PipelinePackageResource,
} from '@canopy/protocol/pipelines';
import { SKILLS_CHANNELS } from '@canopy/desktop-shared/constants/skill-channels';
import {
  findPackageFileCredentialRule,
  scanSharedSkillForSecrets,
} from '@canopy/protocol/skills';

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
const SKILLS: Record<string, string> = {
  'deploy-env': ENV_SKILL,
  'deploy-db': URL_SKILL,
  'deploy-placeholder': PLACEHOLDER_SKILL,
};

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

async function analyzeAndCommit(
  skillName: string,
  rawSkill: string,
): Promise<unknown> {
  const summary = await invoke(SKILLS_CHANNELS.PACKAGE_ANALYZE, {
    sourceId: 'custom:app',
    skillName,
    rawSkill,
  });
  expect(field(summary, 'state')).toBe('ready');
  return invoke(SKILLS_CHANNELS.PACKAGE_COMMIT, {
    analysisId: field(summary, 'analysisId'),
  });
}

beforeAll(async () => {
  // Written before the first analysis, which loads the skill inventory.
  const { writeRawSkill } = await import('../skill-service');
  for (const [skillName, rawSkill] of Object.entries(SKILLS))
    writeRawSkill({ skillName, rawSkill });
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
    '%s: SKILL.md holding %s fails as unavailable and sends no request',
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

      const result = await analyzeAndCommit(skillName, rawSkill);
      expect(result).toMatchObject({
        ok: false,
        failure: {
          kind: 'unavailable',
          stage: 'prepare',
          message: `The skill "${skillName}" looks like it contains a secret (${label} in SKILL.md). Remove it, or replace it with a placeholder such as \${{ secrets.NAME }}, then share again.`,
        },
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

describe('committing a collection package refuses a custom skill whose SKILL.md looks like it holds a secret (CAN-7226)', () => {
  async function analyzeAndCommitCollection(
    name: string,
    skillNames: readonly string[],
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
    expect(field(summary, 'state')).toBe('ready');
    return invoke(COLLECTIONS_CHANNELS.PACKAGE_COMMIT, {
      analysisId: field(summary, 'analysisId'),
    });
  }

  it('refuses a collection with one clean and one secret-holding custom skill, naming that skill, with no request', async () => {
    const result = await analyzeAndCommitCollection('Deploy kit', [
      'deploy-placeholder',
      'deploy-env',
    ]);
    expect(result).toMatchObject({
      ok: false,
      failure: {
        kind: 'unavailable',
        stage: 'prepare',
        message: `The skill "deploy-env" looks like it contains a secret (a credential variable in SKILL.md). Remove it, or replace it with a placeholder such as \${{ secrets.NAME }}, then share again.`,
      },
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
