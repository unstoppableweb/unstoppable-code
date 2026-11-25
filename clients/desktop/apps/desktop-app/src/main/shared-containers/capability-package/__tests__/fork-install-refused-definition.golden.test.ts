import { createHash } from 'node:crypto';
import type {
  PipelinePackageManifestV1,
  PipelinePackageResource,
} from '@canopy/protocol/pipelines';
import {
  encodeSharedContainerDefinitionDocument,
  parseSharedContainerDefinitionDocument,
  parseSharedContainerDefinitionDocumentApartFromCredentials,
  SHARED_CONTAINER_DEFINITION_DOCUMENT_PATH,
  type SharedContainerDefinitionDocument,
} from '@canopy/protocol/shared-containers';
import type {
  SharedContainerForkRequest,
  SharedContainerForkResponse,
} from '@canopy/protocol/shared-containers';
import { computePipelinePackageDigestSync } from '@canopy/desktop-shared/node';
import type { ForkCapabilityInstallJournal } from '../install-journal';
import {
  ForkCapabilityPackageInvalidError,
  planForkCapabilityInstall,
  type ForkCapabilityInstallPlan,
} from '../install-plan';
import {
  installForkCapabilityPackage,
  INVALID_PACKAGE_WARNING,
  type ForkCapabilityInstallDependencies,
} from '../install';

// Token-shaped values are built at run time so none is committed as a literal.
const TOKEN = `gh${'p'}_${'B'.repeat(30)}`;
const CLEAN = 'Summarize the open pull requests.';
const PIPELINE_YAML = `name: Digest
on: dispatch
jobs:
  work:
    steps:
      - id: gather
        run: echo gather
`;

interface Definition {
  id: string;
  displayName: string;
  dependencyResourceIds?: string[];
  /** Canonical document bytes, with `secret` swapped in for {@link CLEAN}. */
  document: SharedContainerDefinitionDocument;
  secret?: string;
  /** Rewrites the canonical text after the secret goes in. */
  rewrite?: (text: string) => string;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Canonical bytes; a secret replaces the clean text after encoding. */
function bytesFor(definition: Definition): Uint8Array {
  const clean = new TextDecoder().decode(
    encodeSharedContainerDefinitionDocument(definition.document),
  );
  const text =
    definition.secret === undefined
      ? clean
      : clean.replace(CLEAN, `${CLEAN} token ${definition.secret}`);
  if (definition.secret !== undefined) expect(clean).toContain(CLEAN);
  const rewritten = definition.rewrite ? definition.rewrite(text) : text;
  if (definition.rewrite) expect(rewritten).not.toBe(text);
  return new TextEncoder().encode(rewritten);
}

function shareOf(definitions: readonly Definition[]): {
  manifest: PipelinePackageManifestV1;
  readDocument: (hash: string) => Promise<Uint8Array>;
} {
  const blobs = new Map<string, Uint8Array>();
  const resources: PipelinePackageResource[] = definitions.map((definition) => {
    const bytes = bytesFor(definition);
    const hash = sha256(bytes);
    blobs.set(hash, bytes);
    return {
      id: definition.id,
      kind: definition.document.kind,
      displayName: definition.displayName,
      sourceLabel: definition.displayName,
      sourceVisibility: 'local',
      invocationKeys: [],
      dependencyResourceIds: definition.dependencyResourceIds ?? [],
      trees: [
        {
          provider: 'claude',
          runtimeKind: 'standalone_skill',
          rootName: definition.id,
          entries: [
            {
              path: SHARED_CONTAINER_DEFINITION_DOCUMENT_PATH,
              sha256: hash,
              size: bytes.byteLength,
              mode: 'read',
            },
          ],
        },
      ],
    };
  });
  return {
    manifest: {
      version: 1,
      pipelineContentHash: 'a'.repeat(64),
      resources,
      bindings: [],
      environmentRequirements: [],
      totalFiles: resources.length,
      totalBytes: 0,
    },
    readDocument: (hash) => {
      const bytes = blobs.get(hash);
      if (!bytes) throw new Error(`no blob ${hash}`);
      return Promise.resolve(bytes);
    },
  };
}

const agent = (id: string, name: string, secret?: string): Definition => ({
  id,
  displayName: name,
  secret,
  document: {
    version: 1,
    kind: 'agent_definition',
    references: [],
    agent: {
      version: 1,
      id: `agent_model_${id.replace(/-/g, '_')}`,
      name,
      baseModel: 'default',
      instructions: CLEAN,
      plugins: [],
    },
  },
});

const pipeline = (
  id: string,
  name: string,
  agents: readonly string[] = [],
  secret?: string,
  yaml = PIPELINE_YAML,
): Definition => ({
  id,
  displayName: name,
  secret,
  dependencyResourceIds: [...agents],
  document: {
    version: 1,
    kind: 'pipeline_definition',
    references: [...agents].sort(),
    name,
    description: CLEAN,
    yaml,
  },
});

const automation = (
  id: string,
  name: string,
  uses: string,
  secret?: string,
): Definition => ({
  id,
  displayName: name,
  secret,
  dependencyResourceIds: [uses],
  document: {
    version: 1,
    kind: 'automation_definition',
    references: [uses],
    target: { kind: 'source-container' },
    uses: { pipeline: uses },
    automation: {
      version: 6,
      name,
      description: CLEAN,
      trigger: { kind: 'cron', expression: '0 9 * * 1', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'new_worktree' },
        pipeline: { source: 'unresolved' },
        inputKeys: [],
      },
      hasRunCondition: false,
    },
  },
});

const plan = (
  definitions: readonly Definition[],
): Promise<ForkCapabilityInstallPlan> => {
  const { manifest, readDocument } = shareOf(definitions);
  return planForkCapabilityInstall(manifest, readDocument, {
    containerType: 'CODE_WORKTREE',
  });
};

describe('Shared container install skips a definition that fails its credential check (CAN-7585)', () => {
  it('plans the rest of a share when one definition holds a credential', async () => {
    const result = await plan([
      agent('agent-writer', 'Writer'),
      pipeline('pipeline-digest', 'Digest'),
      pipeline('pipeline-leaky', 'Leaky report', [], TOKEN),
      automation('automation-weekly', 'Weekly digest', 'pipeline-digest'),
    ]);
    expect(result.agents.map((item) => item.resourceId)).toEqual([
      'agent-writer',
    ]);
    expect(result.pipelines.map((item) => item.resourceId)).toEqual([
      'pipeline-digest',
    ]);
    expect(result.automations.map((item) => item.resourceId)).toEqual([
      'automation-weekly',
    ]);
    expect(result.refusedDefinitions).toEqual([
      {
        resourceId: 'pipeline-leaky',
        kind: 'pipeline_definition',
        displayName: 'Leaky report',
        reason: 'credential',
        field: 'description',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('refuses what depends on a refused definition, naming the path', async () => {
    const result = await plan([
      agent('agent-writer', 'Writer', TOKEN),
      pipeline('pipeline-digest', 'Digest', ['agent-writer']),
      automation('automation-weekly', 'Weekly digest', 'pipeline-digest'),
      pipeline('pipeline-other', 'Other'),
      automation('automation-other', 'Other run', 'pipeline-other'),
    ]);
    expect(result.agents).toEqual([]);
    expect(result.pipelines.map((item) => item.resourceId)).toEqual([
      'pipeline-other',
    ]);
    expect(result.automations.map((item) => item.resourceId)).toEqual([
      'automation-other',
    ]);
    expect(result.refusedDefinitions).toEqual([
      {
        resourceId: 'agent-writer',
        kind: 'agent_definition',
        displayName: 'Writer',
        reason: 'credential',
        field: 'agent.instructions',
      },
      {
        resourceId: 'automation-weekly',
        kind: 'automation_definition',
        displayName: 'Weekly digest',
        reason: 'depends-on-refused',
        path: [
          { kind: 'pipeline_definition', displayName: 'Digest' },
          { kind: 'agent_definition', displayName: 'Writer' },
        ],
      },
      {
        resourceId: 'pipeline-digest',
        kind: 'pipeline_definition',
        displayName: 'Digest',
        reason: 'depends-on-refused',
        path: [{ kind: 'agent_definition', displayName: 'Writer' }],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("never shows a refused definition's name when the name itself looks like a secret", async () => {
    const result = await plan([
      pipeline('pipeline-digest', 'Digest'),
      // The manifest's display name carries the token; the document's own
      // name is clean.
      {
        ...pipeline('pipeline-leaky', 'Leaky report', [], TOKEN),
        displayName: `Report ${TOKEN}`,
      },
    ]);
    expect(result.refusedDefinitions).toEqual([
      {
        resourceId: 'pipeline-leaky',
        kind: 'pipeline_definition',
        displayName: null,
        reason: 'credential',
        field: 'description',
      },
    ]);
    expect(JSON.stringify(result.refusedDefinitions)).not.toContain(TOKEN);
  });

  // A name that is code naming a token, proven on its own line by a call on a
  // dotted callee, is shown; a quoted literal after `const` still reads as a
  // credential (CAN-7614).
  const CODE_NAME =
    'const packageScriptToken = packageManagerCommandPattern.test(command)';
  const LITERAL_NAME = `const DB_PASSWORD = "${'L'.repeat(8)}"`;

  it('names a refused definition whose name is code, and still hides a name holding a literal (CAN-7614)', async () => {
    const result = await plan([
      pipeline('pipeline-digest', 'Digest'),
      {
        ...pipeline('pipeline-code-name', 'Code name', [], TOKEN),
        displayName: CODE_NAME,
      },
      {
        ...pipeline('pipeline-literal-name', 'Literal name', [], TOKEN),
        displayName: LITERAL_NAME,
      },
    ]);
    expect(result.refusedDefinitions).toEqual([
      {
        resourceId: 'pipeline-code-name',
        kind: 'pipeline_definition',
        displayName: CODE_NAME,
        reason: 'credential',
        field: 'description',
      },
      {
        resourceId: 'pipeline-literal-name',
        kind: 'pipeline_definition',
        displayName: null,
        reason: 'credential',
        field: 'description',
      },
    ]);
  });

  it('names a refused definition in a package refusal when its name is code, and still hides a name holding a literal (CAN-7614)', async () => {
    const refusalFor = async (displayName: string): Promise<unknown> => {
      const { manifest, readDocument } = shareOf([
        pipeline('pipeline-digest', 'Digest'),
        { ...agent('agent-leaky', 'Leaky helper', TOKEN), displayName },
      ]);
      manifest.resources[1].kind = 'pipeline_definition';
      return planForkCapabilityInstall(manifest, readDocument, {
        containerType: 'CODE_WORKTREE',
      }).then(
        () => null,
        (error: unknown) => error,
      );
    };
    const code = await refusalFor(CODE_NAME);
    expect(code).toBeInstanceOf(ForkCapabilityPackageInvalidError);
    expect(code).toHaveProperty(
      'message',
      `Invalid shared-container capability package: ${CODE_NAME} carries a agent_definition document`,
    );
    const literal = await refusalFor(LITERAL_NAME);
    expect(literal).toHaveProperty(
      'message',
      'Invalid shared-container capability package: A definition from this share carries a agent_definition document',
    );
  });

  it('installs the rest of a share and names the refused definition, never its value', async () => {
    const { manifest, readDocument } = shareOf([
      agent('agent-writer', 'Writer'),
      agent('agent-leaky', 'Leaky helper', TOKEN),
    ]);
    const digest = computePipelinePackageDigestSync(manifest);
    const journals = new Map<string, ForkCapabilityInstallJournal>();
    const createdAgents: string[] = [];
    const logs: string[] = [];
    const unexpected = (): Promise<never> =>
      Promise.reject(new Error('not used by an Agent-only share'));
    const deps: ForkCapabilityInstallDependencies = {
      timeoutMs: 60_000,
      now: () => new Date('2026-11-22T00:00:00.000Z'),
      randomId: () => 'random-1',
      log: (message, detail) => {
        logs.push(JSON.stringify([message, detail]));
      },
      readReplicaPackage: () => Promise.resolve(undefined),
      getPackage: () => Promise.resolve({ digest, manifest }),
      getBlob: (_request, hash) => readDocument(hash),
      installSubjectPackage: async (request) => {
        const result = {
          supportingFileCount: 0,
          installedSkills: [],
          uninstalledResourceLabels: [],
          keptLocalFiles: [],
        };
        await request.finalizeInstall?.(result);
        return result;
      },
      findLedgerInstall: () => Promise.resolve(null),
      resolvePortablePlugins: () =>
        Promise.resolve({
          selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
          unmatched: [],
        }),
      listAgents: () => Promise.resolve([]),
      createAgent: (request) => {
        createdAgents.push(request.name);
        return Promise.resolve({
          ...request,
          id: `local-${createdAgents.length}`,
          createdAt: '2026-11-22T00:00:00.000Z',
          updatedAt: '2026-11-22T00:00:00.000Z',
        });
      },
      removeAgent: unexpected,
      listPipelineNames: () => Promise.resolve([]),
      readBundledPipelineScopes: unexpected,
      createPipeline: unexpected,
      removePipeline: unexpected,
      listAutomations: () => Promise.resolve([]),
      createAutomation: unexpected,
      deleteAutomation: unexpected,
      readDestination: () =>
        Promise.resolve({ repoIds: [], defaultSkills: [] }),
      addDefaultSkills: () => Promise.resolve(),
      removeDefaultSkills: () => Promise.resolve(),
      removeSkillFolder: unexpected,
      readJournal: (key) => Promise.resolve(journals.get(key) ?? null),
      writeJournal: (journal) => {
        journals.set(journal.key, journal);
        return Promise.resolve();
      },
      deleteJournal: (key) => {
        journals.delete(key);
        return Promise.resolve();
      },
      listJournals: () => Promise.resolve([...journals.values()]),
    };
    const request: SharedContainerForkRequest = {
      containerId: 'container-1',
      revisionId: 'revision-1',
      sourceOwnerDisplayName: 'Sam',
      destination: { kind: 'existing-workspace', workspaceId: 'project-1' },
      expectedPackageDigest: digest,
    };
    const response: SharedContainerForkResponse = {
      containerType: 'CODE_WORKTREE',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      warnings: [],
      provenance: {
        sourceContainerId: 'container-1',
        sourceRevisionId: 'revision-1',
        sourceOwnerDisplayName: 'Sam',
        forkedAt: '2026-11-22T00:00:00.000Z',
      },
    };

    const warnings = await installForkCapabilityPackage(
      { request, response },
      deps,
    );

    expect(createdAgents).toEqual(['Writer']);
    expect(warnings).not.toContain(INVALID_PACKAGE_WARNING);
    expect(warnings).toEqual([
      'Agent "Leaky helper" wasn\'t added because its agent.instructions may contain a credential. Ask the person who shared it to remove the credential and share again.',
    ]);
    expect(JSON.stringify(warnings)).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  it('plans an all-clean share in full', async () => {
    const result = await plan([
      agent('agent-writer', 'Writer'),
      pipeline('pipeline-digest', 'Digest', ['agent-writer']),
      automation('automation-weekly', 'Weekly digest', 'pipeline-digest'),
    ]);
    expect(result.agents.map((item) => item.resourceId)).toEqual([
      'agent-writer',
    ]);
    expect(result.pipelines.map((item) => item.resourceId)).toEqual([
      'pipeline-digest',
    ]);
    expect(result.automations.map((item) => item.resourceId)).toEqual([
      'automation-weekly',
    ]);
    expect(result.refusedDefinitions ?? []).toEqual([]);
  });

  it('still refuses the whole package for anything but a credential', async () => {
    const { manifest, readDocument } = shareOf([
      pipeline('pipeline-digest', 'Digest'),
      pipeline('pipeline-odd', 'Odd'),
    ]);
    const odd = manifest.resources[1];
    const entry = odd.trees[0].entries[0];
    const canonical = await readDocument(entry.sha256);
    // The same content with a space before its closing brace: not canonical.
    const text = new TextDecoder().decode(canonical);
    const bytes = new TextEncoder().encode(`${text.slice(0, -1)} }`);
    entry.sha256 = sha256(bytes);
    entry.size = bytes.byteLength;
    await expect(
      planForkCapabilityInstall(
        manifest,
        (hash) =>
          hash === entry.sha256 ? Promise.resolve(bytes) : readDocument(hash),
        { containerType: 'CODE_WORKTREE' },
      ),
    ).rejects.toBeInstanceOf(ForkCapabilityPackageInvalidError);
    // A credential beside a machine path is not a credential-only fault.
    await expect(
      plan([
        pipeline('pipeline-mixed', 'Mixed', [], `${TOKEN} /Users/sam/notes.md`),
      ]),
    ).rejects.toBeInstanceOf(ForkCapabilityPackageInvalidError);
  });

  describe('a refusal never hides a fault that refuses the whole package', () => {
    const planWith = (
      manifest: PipelinePackageManifestV1,
      readDocument: (hash: string) => Promise<Uint8Array>,
    ): Promise<ForkCapabilityInstallPlan> =>
      planForkCapabilityInstall(manifest, readDocument, {
        containerType: 'CODE_WORKTREE',
      });

    it('refuses the package when a credential-bearing document is not canonical', async () => {
      const { manifest, readDocument } = shareOf([
        pipeline('pipeline-digest', 'Digest'),
        pipeline('pipeline-leaky', 'Leaky report', [], TOKEN),
      ]);
      const entry = manifest.resources[1].trees[0].entries[0];
      const text = new TextDecoder().decode(await readDocument(entry.sha256));
      const bytes = new TextEncoder().encode(`${text.slice(0, -1)} }`);
      entry.sha256 = sha256(bytes);
      entry.size = bytes.byteLength;
      await expect(
        planWith(manifest, (hash) =>
          hash === entry.sha256 ? Promise.resolve(bytes) : readDocument(hash),
        ),
      ).rejects.toThrow(
        /^Invalid shared-container capability package: Leaky report: Definition document is not canonical$/,
      );
    });

    it("refuses the package when a credential-bearing document's kind differs from its manifest entry", async () => {
      const { manifest, readDocument } = shareOf([
        pipeline('pipeline-digest', 'Digest'),
        agent('agent-leaky', 'Leaky helper', TOKEN),
      ]);
      manifest.resources[1].kind = 'pipeline_definition';
      await expect(planWith(manifest, readDocument)).rejects.toThrow(
        /^Invalid shared-container capability package: Leaky helper carries a agent_definition document$/,
      );
    });

    it('refuses the package when a credential-bearing document references a resource outside its dependencies', async () => {
      const leaky = pipeline('pipeline-leaky', 'Leaky report', [], TOKEN);
      const { manifest, readDocument } = shareOf([
        pipeline('pipeline-digest', 'Digest'),
        {
          ...leaky,
          document: { ...leaky.document, references: ['agent-ghost'] },
        },
      ]);
      await expect(planWith(manifest, readDocument)).rejects.toThrow(
        /Leaky report references a resource that is not one of its packaged dependencies/,
      );
    });

    it('refuses the package when a dependent of a refused definition has invalid pipeline YAML', async () => {
      const { manifest, readDocument } = shareOf([
        agent('agent-writer', 'Writer', TOKEN),
        pipeline(
          'pipeline-digest',
          'Digest',
          ['agent-writer'],
          undefined,
          'jobs: [',
        ),
      ]);
      await expect(planWith(manifest, readDocument)).rejects.toThrow(
        /^Invalid shared-container capability package: Digest: /,
      );
    });

    it("refuses the package when a dependent pipeline's overlay child pipeline fails verification", async () => {
      const digest = pipeline('pipeline-digest', 'Digest', ['agent-writer']);
      const { manifest, readDocument } = shareOf([
        agent('agent-writer', 'Writer', TOKEN),
        { ...digest, dependencyResourceIds: ['agent-writer', 'child-step'] },
      ]);
      const child = new TextEncoder().encode(PIPELINE_YAML);
      const childHash = sha256(child);
      manifest.resources.push({
        id: 'child-step',
        kind: 'child_pipeline',
        displayName: 'Step',
        sourceLabel: 'Step',
        sourceVisibility: 'local',
        invocationKeys: ['pipelines/step.yaml'],
        dependencyResourceIds: [],
        trees: [
          {
            provider: 'claude',
            runtimeKind: 'standalone_skill',
            rootName: 'child-step',
            entries: [
              {
                path: 'pipelines/step.yaml',
                sha256: childHash,
                // The stored bytes are one byte shorter than the manifest says.
                size: child.byteLength + 1,
                mode: 'read',
              },
            ],
          },
        ],
      });
      await expect(
        planWith(manifest, (hash) =>
          hash === childHash ? Promise.resolve(child) : readDocument(hash),
        ),
      ).rejects.toThrow(/Step failed verification/);
    });

    it("refuses the package when a credential-bearing pipeline's YAML is invalid, without quoting it", async () => {
      const { manifest, readDocument } = shareOf([
        pipeline('pipeline-digest', 'Digest'),
        {
          id: 'pipeline-leaky',
          displayName: 'Leaky report',
          secret: TOKEN,
          document: {
            version: 1,
            kind: 'pipeline_definition',
            references: [],
            name: 'Leaky report',
            // The credential lands inside this unclosed list.
            yaml: `jobs: [ ${CLEAN}`,
          },
        },
      ]);
      await expect(planWith(manifest, readDocument)).rejects.toThrow(
        /^Invalid shared-container capability package: Leaky report: invalid pipeline YAML$/,
      );
    });

    it("refuses the package when a credential-bearing automation's uses names the wrong kind", async () => {
      const { manifest, readDocument } = shareOf([
        agent('agent-writer', 'Writer'),
        automation('automation-leaky', 'Leaky run', 'agent-writer', TOKEN),
      ]);
      await expect(planWith(manifest, readDocument)).rejects.toThrow(
        /^Invalid shared-container capability package: Leaky run references a pipeline_definition that is not one of its packaged dependencies$/,
      );
    });

    it('never puts a secret-shaped name in a new refusal of the whole package', async () => {
      const { manifest, readDocument } = shareOf([
        pipeline('pipeline-digest', 'Digest'),
        {
          ...pipeline('pipeline-leaky', 'Leaky report', [], TOKEN),
          displayName: `Report ${TOKEN}`,
        },
      ]);
      const entry = manifest.resources[1].trees[0].entries[0];
      const text = new TextDecoder().decode(await readDocument(entry.sha256));
      const bytes = new TextEncoder().encode(`${text.slice(0, -1)} }`);
      entry.sha256 = sha256(bytes);
      entry.size = bytes.byteLength;
      await expect(
        planWith(manifest, (hash) =>
          hash === entry.sha256 ? Promise.resolve(bytes) : readDocument(hash),
        ),
      ).rejects.toThrow(
        /^Invalid shared-container capability package: A definition from this share: Definition document is not canonical$/,
      );
    });

    it('refuses the package when a credential-bearing document lists its references out of order', async () => {
      const { manifest, readDocument } = shareOf([
        agent('agent-a', 'Alpha'),
        agent('agent-b', 'Beta'),
        {
          ...pipeline(
            'pipeline-leaky',
            'Leaky report',
            ['agent-a', 'agent-b'],
            TOKEN,
          ),
          rewrite: (text): string =>
            text.replace(
              '"references":["agent-a","agent-b"]',
              '"references":["agent-b","agent-a"]',
            ),
        },
      ]);
      await expect(planWith(manifest, readDocument)).rejects.toThrow(
        /^Invalid shared-container capability package: Leaky report: Definition document is not canonical$/,
      );
    });

    it.each([
      ['out of order', '["b","a"]'],
      ['repeated', '["a","a"]'],
    ])(
      'refuses the package when a credential-bearing automation lists its input keys %s',
      async (_case, inputKeys) => {
        const { manifest, readDocument } = shareOf([
          pipeline('pipeline-digest', 'Digest'),
          {
            ...automation(
              'automation-leaky',
              'Leaky run',
              'pipeline-digest',
              TOKEN,
            ),
            rewrite: (text): string =>
              text.replace('"inputKeys":[]', `"inputKeys":${inputKeys}`),
          },
        ]);
        await expect(planWith(manifest, readDocument)).rejects.toThrow(
          /^Invalid shared-container capability package: Leaky run: Definition document is not canonical$/,
        );
      },
    );

    it("refuses the package when a credential-bearing pipeline's own overlay child pipeline fails verification", async () => {
      const { manifest, readDocument } = shareOf([
        pipeline('pipeline-digest', 'Digest'),
        {
          ...pipeline('pipeline-leaky', 'Leaky report', [], TOKEN),
          dependencyResourceIds: ['child-step'],
        },
      ]);
      const child = new TextEncoder().encode(PIPELINE_YAML);
      const childHash = sha256(child);
      manifest.resources.push({
        id: 'child-step',
        kind: 'child_pipeline',
        displayName: 'Step',
        sourceLabel: 'Step',
        sourceVisibility: 'local',
        invocationKeys: ['pipelines/step.yaml'],
        dependencyResourceIds: [],
        trees: [
          {
            provider: 'claude',
            runtimeKind: 'standalone_skill',
            rootName: 'child-step',
            entries: [
              {
                path: 'pipelines/step.yaml',
                sha256: childHash,
                // The stored bytes are one byte shorter than the manifest says.
                size: child.byteLength + 1,
                mode: 'read',
              },
            ],
          },
        ],
      });
      await expect(
        planWith(manifest, (hash) =>
          hash === childHash ? Promise.resolve(child) : readDocument(hash),
        ),
      ).rejects.toThrow(/Step failed verification/);
    });
  });

  it('keeps the default parse of a stored definition as it was', () => {
    const bytes = bytesFor(
      pipeline('pipeline-leaky', 'Leaky report', [], TOKEN),
    );
    expect(parseSharedContainerDefinitionDocument(bytes)).toEqual({
      ok: false,
      errors: [
        'pipeline_definition.description may contain a credential. Replace it with a placeholder such as ${{ secrets.NAME }}.',
      ],
    });
  });

  it('sets credential findings apart only when asked, with every other check applied', () => {
    const bytes = bytesFor(
      pipeline('pipeline-leaky', 'Leaky report', [], TOKEN),
    );
    const apart =
      parseSharedContainerDefinitionDocumentApartFromCredentials(bytes);
    expect(apart.credentialFindings).toEqual([
      'pipeline_definition.description may contain a credential. Replace it with a placeholder such as ${{ secrets.NAME }}.',
    ]);
    expect(apart.result.ok).toBe(true);
    const clean = bytesFor(pipeline('pipeline-digest', 'Digest'));
    expect(
      parseSharedContainerDefinitionDocumentApartFromCredentials(clean),
    ).toEqual({
      result: parseSharedContainerDefinitionDocument(clean),
      credentialFindings: [],
    });
  });
});

describe('Install errors keep secret-shaped names, keys and values out of the log (CAN-7615)', () => {
  const UNNAMED = 'A definition from this share';
  const FIELD_WITHHELD = 'a field holds text that looks like a credential';
  type LogEntry = readonly [string, unknown];

  const forkRequest = (digest: string): SharedContainerForkRequest => ({
    containerId: 'container-1',
    revisionId: 'revision-1',
    sourceOwnerDisplayName: 'Sam',
    destination: { kind: 'existing-workspace', workspaceId: 'project-1' },
    expectedPackageDigest: digest,
  });
  const forkResponse: SharedContainerForkResponse = {
    containerType: 'CODE_WORKTREE',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    warnings: [],
    provenance: {
      sourceContainerId: 'container-1',
      sourceRevisionId: 'revision-1',
      sourceOwnerDisplayName: 'Sam',
      forkedAt: '2026-11-22T00:00:00.000Z',
    },
  };

  /** Installs a share with in-memory dependencies, capturing every log call. */
  const install = async (
    manifest: PipelinePackageManifestV1,
    readDocument: (hash: string) => Promise<Uint8Array>,
    overrides: Partial<ForkCapabilityInstallDependencies> = {},
    tweak?: (deps: ForkCapabilityInstallDependencies) => void,
  ): Promise<{ warnings: string[]; logs: LogEntry[] }> => {
    const digest = computePipelinePackageDigestSync(manifest);
    const journals = new Map<string, ForkCapabilityInstallJournal>();
    const logs: LogEntry[] = [];
    const unexpected = (): Promise<never> =>
      Promise.reject(new Error('not used by this share'));
    const deps: ForkCapabilityInstallDependencies = {
      timeoutMs: 60_000,
      now: () => new Date('2026-11-22T00:00:00.000Z'),
      randomId: () => 'random-1',
      log: (message, detail) => {
        logs.push([message, detail]);
      },
      readReplicaPackage: () => Promise.resolve(undefined),
      getPackage: () => Promise.resolve({ digest, manifest }),
      getBlob: (_request, hash) => readDocument(hash),
      installSubjectPackage: async (request) => {
        const result = {
          supportingFileCount: 0,
          installedSkills: [],
          uninstalledResourceLabels: [],
          keptLocalFiles: [],
        };
        await request.finalizeInstall?.(result);
        return result;
      },
      findLedgerInstall: () => Promise.resolve(null),
      resolvePortablePlugins: () =>
        Promise.resolve({
          selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
          unmatched: [],
        }),
      listAgents: () => Promise.resolve([]),
      createAgent: unexpected,
      removeAgent: unexpected,
      listPipelineNames: () => Promise.resolve([]),
      readBundledPipelineScopes: unexpected,
      createPipeline: unexpected,
      removePipeline: unexpected,
      listAutomations: () => Promise.resolve([]),
      createAutomation: unexpected,
      deleteAutomation: unexpected,
      readDestination: () =>
        Promise.resolve({ repoIds: [], defaultSkills: [] }),
      addDefaultSkills: () => Promise.resolve(),
      removeDefaultSkills: () => Promise.resolve(),
      removeSkillFolder: unexpected,
      readJournal: (key) => Promise.resolve(journals.get(key) ?? null),
      writeJournal: (journal) => {
        journals.set(journal.key, journal);
        return Promise.resolve();
      },
      deleteJournal: (key) => {
        journals.delete(key);
        return Promise.resolve();
      },
      listJournals: () => Promise.resolve([...journals.values()]),
      ...overrides,
    };
    tweak?.(deps);
    const warnings = await installForkCapabilityPackage(
      { request: forkRequest(digest), response: forkResponse },
      deps,
    );
    return { warnings, logs };
  };

  /** The one failure log at `site`, after checking nothing logged holds the token. */
  const failureLog = (
    logs: readonly LogEntry[],
    site: string,
  ): Record<string, unknown> => {
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
    const entries = logs.filter(([message]) => message.endsWith(site));
    expect(entries).toHaveLength(1);
    const [, detail] = entries[0];
    if (typeof detail !== 'object' || detail === null)
      throw new Error(`no detail on ${site}`);
    // A string or number per key: never an error object, a stack or a cause.
    for (const value of Object.values(detail))
      expect(['string', 'number']).toContain(typeof value);
    return { ...detail };
  };

  const notInstalled = (logs: readonly LogEntry[]): Record<string, unknown> =>
    failureLog(logs, ' package not installed');

  it('names a definition whose manifest name looks like a secret neutrally when it fails verification', async () => {
    const { manifest, readDocument } = shareOf([
      { ...agent('agent-writer', 'Writer'), displayName: TOKEN },
    ]);
    manifest.resources[0].trees[0].entries[0].size += 1;
    const { warnings, logs } = await install(manifest, readDocument);
    expect(warnings).toEqual([INVALID_PACKAGE_WARNING]);
    const detail = notInstalled(logs);
    expect(detail.error).toContain(`${UNNAMED} failed verification`);
    expect(detail.errorType).toBe('ForkCapabilityPackageInvalidError');
    expect(detail.definitionKind).toBe('agent_definition');
  });

  it('names an installable definition neutrally when its reference has the wrong kind', async () => {
    const { manifest, readDocument } = shareOf([
      pipeline('pipeline-other', 'Other'),
      {
        ...pipeline('pipeline-digest', 'Digest', ['pipeline-other']),
        displayName: TOKEN,
      },
    ]);
    const { warnings, logs } = await install(manifest, readDocument);
    expect(warnings).toEqual([INVALID_PACKAGE_WARNING]);
    expect(notInstalled(logs).error).toContain(
      `${UNNAMED} references a agent_definition`,
    );
  });

  it('names an installable pipeline neutrally when its YAML is invalid', async () => {
    const { manifest, readDocument } = shareOf([
      {
        ...pipeline('pipeline-digest', 'Digest', [], undefined, 'name: [open'),
        displayName: TOKEN,
      },
    ]);
    const { warnings, logs } = await install(manifest, readDocument);
    expect(warnings).toEqual([INVALID_PACKAGE_WARNING]);
    expect(notInstalled(logs).error).toContain(`${UNNAMED}: `);
  });

  it('withholds an unknown field whose key looks like a secret', async () => {
    const { manifest, readDocument } = shareOf([
      {
        ...agent('agent-writer', 'Writer'),
        rewrite: (text): string =>
          text.replace(
            '"kind":"agent_definition"',
            `"${TOKEN}":1,"kind":"agent_definition"`,
          ),
      },
    ]);
    const { warnings, logs } = await install(manifest, readDocument);
    expect(warnings).toEqual([INVALID_PACKAGE_WARNING]);
    expect(notInstalled(logs).error).toContain(`Writer: ${FIELD_WITHHELD}`);
  });

  it("withholds an automation document's unexpected field whose key looks like a secret", async () => {
    const { manifest, readDocument } = shareOf([
      pipeline('pipeline-digest', 'Digest'),
      {
        ...automation('automation-weekly', 'Weekly digest', 'pipeline-digest'),
        rewrite: (text): string =>
          text.replace(
            '"hasRunCondition":false',
            `"${TOKEN}":1,"hasRunCondition":false`,
          ),
      },
    ]);
    const { warnings, logs } = await install(manifest, readDocument);
    expect(warnings).toEqual([INVALID_PACKAGE_WARNING]);
    expect(notInstalled(logs).error).toContain(
      `Weekly digest: ${FIELD_WITHHELD}`,
    );
  });

  it('withholds a validator error that quotes the credential a refused definition holds', async () => {
    const { manifest, readDocument } = shareOf([
      pipeline('pipeline-digest', 'Digest'),
      {
        ...automation('automation-weekly', 'Weekly digest', 'pipeline-digest'),
        rewrite: (text): string =>
          text.replace('"0 9 * * 1"', `"${TOKEN} 9 * * 1"`),
      },
    ]);
    const { warnings, logs } = await install(manifest, readDocument);
    expect(warnings).toEqual([INVALID_PACKAGE_WARNING]);
    expect(notInstalled(logs).error).toContain(FIELD_WITHHELD);
  });

  it('withholds the whole message of any error that carries a secret into the log, whatever its type', async () => {
    const { manifest, readDocument } = shareOf([
      agent('agent-writer', 'Writer'),
    ]);
    const { logs } = await install(manifest, readDocument, {
      installSubjectPackage: () =>
        Promise.reject(
          new Error(
            `Pipeline "${TOKEN}" failed; rollback was incomplete: folder busy`,
          ),
        ),
    });
    const detail = notInstalled(logs);
    expect(detail.error).toBe(
      'Capability install error withheld because it looks like it holds a credential',
    );
    expect(detail.errorType).toBe('Error');
  });

  it('withholds a secret in an error that escapes the attempt, on the outer log too', async () => {
    const { manifest, readDocument } = shareOf([
      agent('agent-writer', 'Writer'),
    ]);
    const { warnings, logs } = await install(
      manifest,
      readDocument,
      {},
      (deps) => {
        // Read before the attempt's own try, so the throw escapes to the outer log.
        Object.defineProperty(deps, 'timeoutMs', {
          get: (): number => {
            throw new Error(`Unexpected setting ${TOKEN}`);
          },
        });
      },
    );
    expect(JSON.stringify(warnings)).not.toContain(TOKEN);
    const detail = failureLog(logs, ' install failed');
    expect(detail.error).toBe(
      'Capability install error withheld because it looks like it holds a credential',
    );
    expect(detail.errorType).toBe('Error');
  });

  it('keeps ordinary names and errors in the log as they are (green before and after)', async () => {
    const { manifest, readDocument } = shareOf([
      agent('agent-writer', 'Writer'),
    ]);
    manifest.resources[0].trees[0].entries[0].size += 1;
    const { warnings, logs } = await install(manifest, readDocument);
    expect(warnings).toEqual([INVALID_PACKAGE_WARNING]);
    const entries = logs.filter(([message]) =>
      message.endsWith(' package not installed'),
    );
    expect(JSON.stringify(entries)).toContain('Writer failed verification');
  });
});
