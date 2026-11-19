import {
  sharedChatDocumentHasWorkflowForm,
  validateSharedAutomationDocument,
  type SharedAutomationDocument,
} from '@canopy/protocol/automations';
import type { SharedAgentDetail } from '@canopy/protocol/agents';
import { parseAgentDelegationSpawnRequest } from '@canopy/protocol/delegation';
import { ManagedDelegationModelsListResultSchema as DelegationModelDiscoverySchema } from '@canopy/protocol/canopy-core';
import type { DelegationModelChoice } from '@canopy/protocol/delegation/discovery';
import { emptyPluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import type { ScheduledActivity } from '../../types';
import { buildSharedAutomationDocument } from '../automation-sharing';
import { buildInstallAutomationRequest } from '../automation-install';
import {
  installedPackageWorkflowActivity,
  sharedAutomationActivity,
} from '../stored-automation-activity';
import {
  assertAutomationAgentReference,
  findInstalledAutomationAgent,
  resolveAutomationSharedAgent,
} from '../automation-agent';
import {
  chatAutomationToPipeline,
  ownedPipelineToChatAction,
} from '../chat-automation-conversion';
import { sharedWorkflowForm } from '../shared-chat-automation-conversion';
import { discoverDelegationModels } from '../../node/delegation/discovery';
import { validateAgentRoute } from '../../node/delegation/route';
import { routeFixture } from '../../node/delegation/__tests__/fixtures';

const hash = 'a'.repeat(64);
const timestamp = '2026-11-12T00:00:00.000Z';
const model = 'agent_model_reviewer@sonnet';
const reference = { remoteId: 'shared-agent', contentHash: hash };
const resolvedAgent = {
  ...reference,
  localAgentId: 'agent_model_reviewer',
  agentId: 'agent_model_shared',
};
const detail: SharedAgentDetail = {
  id: reference.remoteId,
  modelId: 'agent_model_shared',
  name: 'Reviewer',
  baseModel: 'sonnet',
  instructionsPreview: 'Review',
  contentHash: hash,
  shareScope: 'organization',
  owner: { type: 'organization', id: 'org', name: null },
  createdAt: timestamp,
  updatedAt: timestamp,
  createdBy: { id: 'author', name: null, email: null },
  canUpdate: false,
  canDelete: false,
  agent: {
    version: 1,
    id: 'agent_model_shared',
    name: 'Reviewer',
    baseModel: 'sonnet',
    instructions: 'Review',
    plugins: [],
  },
};

function activity(
  selectedModel: string | undefined = model,
): ScheduledActivity {
  return {
    version: 1,
    id: 'automation',
    name: 'Review',
    enabled: false,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: {
      type: 'app_advisor_prompt',
      prompt: 'Review the changes',
      ...(selectedModel ? { model: selectedModel } : {}),
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    failureCount: 0,
  };
}

describe('automations:shared:create and automations:shared:update portable wire contract', () => {
  it('publishes, validates and installs with the recipient collision-remapped ID and exact model', () => {
    const shared = buildSharedAutomationDocument(activity(), {
      description: '',
      resolvedAgent,
    });
    if (!shared.ok) throw new Error(JSON.stringify(shared));
    const validated = validateSharedAutomationDocument(shared.document);
    expect(validated.ok).toBe(true);
    expect(shared.document.action).toMatchObject({
      modelConfig: { model: 'agent_model_shared@sonnet', agent: reference },
    });
    const source = {
      id: 'automation-share',
      contentHash: hash,
      automation: shared.document,
    };
    expect(buildInstallAutomationRequest(source, {}, timestamp).ok).toBe(false);
    const installed = buildInstallAutomationRequest(
      source,
      { agent: { ...reference, localAgentId: 'agent_model_shared_2' } },
      timestamp,
    );
    if (!installed.ok) throw new Error(installed.error);
    expect(installed.request.action).toMatchObject({
      model: 'agent_model_shared_2@sonnet',
    });
    expect(installed.request.enabled).toBe(false);
    expect(
      buildInstallAutomationRequest(
        source,
        {
          agent: {
            ...reference,
            contentHash: 'b'.repeat(64),
            localAgentId: 'agent_model_shared_2',
          },
        },
        timestamp,
      ).ok,
    ).toBe(false);
  });

  it.each([model, 'agent_model_missing@sonnet'])(
    'refuses local-only and unresolved selection %s',
    (selected) => {
      expect(
        buildSharedAutomationDocument(activity(selected), { description: '' }),
      ).toMatchObject({ ok: false, reasons: ['local_agent_unavailable'] });
    },
  );

  it('asks for an explicit model rather than calling a bare shared Agent local-only', () => {
    expect(
      buildSharedAutomationDocument(activity('agent_model_reviewer'), {
        description: '',
        resolvedAgent,
      }),
    ).toMatchObject({ ok: false, reasons: ['agent_model_required'] });
  });

  it('keeps older documents without Agents unchanged', () => {
    for (const selected of ['sonnet', '']) {
      const shared = buildSharedAutomationDocument(activity(selected), {
        description: '',
      });
      if (!shared.ok) throw new Error(JSON.stringify(shared));
      const validated = validateSharedAutomationDocument(shared.document);
      expect(validated).toMatchObject({ ok: true, document: shared.document });
      const installed = buildInstallAutomationRequest(
        { id: 'share', contentHash: hash, automation: shared.document },
        {},
        timestamp,
      );
      expect(installed).toMatchObject({
        ok: true,
        request: { action: activity(selected).action },
      });
    }
  });

  it('rejects missing provenance and bare Agent IDs at the wire boundary', () => {
    const shared = buildSharedAutomationDocument(activity('sonnet'), {
      description: '',
    });
    if (!shared.ok) throw new Error(JSON.stringify(shared));
    for (const modelConfig of [
      { model },
      { model: 'agent_model_reviewer', agent: reference },
      { model: 'sonnet', agent: reference },
    ]) {
      expect(
        validateSharedAutomationDocument({
          ...shared.document,
          action: { ...shared.document.action, modelConfig },
        }).ok,
      ).toBe(false);
    }
  });

  it('reauthorizes hosted provenance and refuses a changed snapshot or private local source', async () => {
    const local = {
      id: 'agent_model_reviewer',
      name: 'Reviewer',
      baseModel: 'sonnet',
      instructions: 'Review',
      pluginSelections: emptyPluginSelections(),
      createdAt: timestamp,
      updatedAt: timestamp,
      remoteId: detail.id,
      remoteContentHash: hash,
    };
    expect(
      await resolveAutomationSharedAgent(model, {
        get: () => Promise.resolve(local),
        getShared: () => Promise.resolve(detail),
      }),
    ).toEqual(resolvedAgent);
    expect(
      await resolveAutomationSharedAgent(model, {
        get: () => Promise.resolve({ ...local, remoteId: undefined }),
        getShared: () => Promise.resolve(detail),
      }),
    ).toBeUndefined();
    await expect(
      resolveAutomationSharedAgent(model, {
        get: () => Promise.resolve(local),
        getShared: () =>
          Promise.resolve({ ...detail, contentHash: 'b'.repeat(64) }),
      }),
    ).rejects.toThrow();
    expect(() =>
      assertAutomationAgentReference('agent_model_shared@sonnet', reference, {
        ...detail,
        shareScope: 'private',
        owner: { type: 'user', id: 'author', name: null },
      }),
    ).toThrow();
    expect(() =>
      assertAutomationAgentReference(
        'agent_model_other@sonnet',
        reference,
        detail,
      ),
    ).toThrow();
  });

  it('requires the reviewed Agent to be installed first and refuses a changed local copy', async () => {
    const installed = {
      id: 'agent_model_shared_2',
      name: 'Reviewer',
      baseModel: 'sonnet',
      instructions: 'Review',
      pluginSelections: emptyPluginSelections(),
      createdAt: timestamp,
      updatedAt: timestamp,
      importedFromRemoteId: detail.id,
      remoteContentHash: hash,
      importedContentHash: 'local',
      contentHash: 'local',
    };
    await expect(
      findInstalledAutomationAgent(
        'agent_model_shared@sonnet',
        reference,
        detail,
        [],
      ),
    ).rejects.toThrow('Install or refresh Agent "Reviewer" from Agents first');
    await expect(
      findInstalledAutomationAgent(
        'agent_model_shared@sonnet',
        reference,
        detail,
        [installed],
      ),
    ).resolves.toEqual({ ...reference, localAgentId: installed.id });
    await expect(
      findInstalledAutomationAgent(
        'agent_model_shared@sonnet',
        reference,
        detail,
        [{ ...installed, contentHash: 'changed' }],
      ),
    ).rejects.toThrow('Install or refresh Agent "Reviewer" from Agents first');
  });

  it('round-trips an explicit Agent model through an owned pipeline alias', () => {
    const converted = chatAutomationToPipeline(activity());
    expect(converted.modelAliasPreferences?.chat_model).toEqual({
      mode: 'agent',
      agent_id: model,
    });
    expect(
      ownedPipelineToChatAction(
        converted.pipeline,
        converted.inputs,
        () => false,
        converted,
      ),
    ).toMatchObject({ model });
  });
});

describe('the server chat-form guard rule (CAN-6455)', () => {
  const chat = (
    action: SharedAutomationDocument['action'],
    extra: Partial<SharedAutomationDocument> = {},
  ): SharedAutomationDocument => ({
    version: 1,
    name: 'Review',
    description: '',
    trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action,
    hasRunCondition: false,
    ...extra,
  });
  const worktree = (
    extra: Partial<
      Extract<SharedAutomationDocument['action'], { type: 'worktree_prompt' }>
    > = {},
  ): SharedAutomationDocument['action'] => ({
    type: 'worktree_prompt',
    target: { kind: 'workspace' },
    prompt: '@README.md review the changes',
    plugins: [],
    ...extra,
  });
  const documents: [
    string,
    boolean,
    () => SharedAutomationDocument | Promise<SharedAutomationDocument>,
  ][] = [
    ['a worktree prompt', true, () => chat(worktree())],
    [
      'a Cowork prompt',
      true,
      () =>
        chat({
          type: 'standalone_prompt',
          target: { kind: 'cowork' },
          prompt: 'Review the changes',
          plugins: [],
        }),
    ],
    [
      'an App Advisor prompt',
      true,
      () =>
        chat({
          type: 'app_advisor_prompt',
          prompt: 'Review the changes',
          plugins: [],
        }),
    ],
    [
      'a run restriction its action implies',
      true,
      () =>
        chat(worktree(), {
          version: 3,
          targetRequirement: { contexts: ['worktree'] },
        }),
    ],
    [
      'a capability package',
      false,
      () =>
        chat(worktree(), {
          version: 5,
          capabilityPackage: {
            version: 1,
            digest: `pp:v1:${'a'.repeat(43)}`,
          },
        }),
    ],
    [
      'pipeline dependencies',
      false,
      () =>
        chat(
          worktree({
            pipelineDependencies: [
              {
                key: 'triage',
                pipeline: { source: 'bundled', pipelineId: 'triage' },
                promptSpans: [],
              },
            ],
          }),
          { version: 5 },
        ),
    ],
    [
      'a file reference',
      false,
      () =>
        chat(
          worktree({
            promptReferences: [
              {
                kind: 'file',
                textStart: 0,
                displayText: '@README.md',
                root: { kind: 'workspace' },
                relativePath: 'README.md',
              },
            ],
          }),
          { version: 2 },
        ),
    ],
    [
      'a branch suggestion',
      false,
      () => chat(worktree({ existingBranch: 'main' })),
    ],
    [
      'a shared Agent',
      false,
      () =>
        chat(
          worktree({
            modelConfig: {
              model: 'agent_model_shared@sonnet',
              agent: reference,
            },
          }),
        ),
    ],
    [
      'a workflow',
      false,
      async () => {
        const workflow = await sharedWorkflowForm(chat(worktree()));
        if (workflow === null) throw new Error('expected a workflow form');
        return workflow;
      },
    ],
  ];

  it.each(documents)(
    'rejects only a chat document a desktop shares as a workflow: %s',
    async (_label, hasWorkflowForm, build) => {
      const document = await build();
      expect(validateSharedAutomationDocument(document)).toMatchObject({
        ok: true,
      });
      expect(sharedChatDocumentHasWorkflowForm(document)).toBe(hasWorkflowForm);
      expect((await sharedWorkflowForm(document)) !== null).toBe(
        hasWorkflowForm,
      );
    },
  );
});

describe('delegation discovery wire projection', () => {
  const inspect = (id: string): Promise<DelegationModelChoice> =>
    Promise.resolve({
      modelId: id,
      label: id,
      harnessId: 'claude',
      runtimeKind: 'claude-sdk',
      supportedThinkingLevels: ['low'],
      capabilities: ['read'],
      availability: id === 'blocked' ? 'unavailable' : 'available',
      authState: 'ready',
    });
  it('lists Agents separately, preserves availability, and produces a valid spawn modelId', async () => {
    const discovered = await discoverDelegationModels({
      modelIds: ['sonnet', 'blocked'],
      agents: [{ agentId: 'agent_model_reviewer', label: 'Reviewer' }],
      preferredModelId: model,
      inspect,
      canRunAgent: () => Promise.resolve(true),
    });
    expect(discovered.models.map((choice) => choice.modelId)).toEqual([
      'sonnet',
      'blocked',
    ]);
    expect(discovered.agents?.[0].models).toEqual(['sonnet']);
    expect(discovered.models[1].availability).toBe('unavailable');
    expect(discovered.recommendedModelId).toBe(model);
    expect(DelegationModelDiscoverySchema.parse(discovered)).toEqual(
      discovered,
    );
    expect(
      parseAgentDelegationSpawnRequest({
        modelId: model,
        description: 'Review',
        prompt: 'Review',
      }),
    ).toMatchObject({ ok: true, value: { modelId: model } });
    expect(
      validateAgentRoute(model, 'low', routeFixture({ selectedModelId: model }))
        .ok,
    ).toBe(true);
    expect(
      validateAgentRoute(
        model,
        'ultra',
        routeFixture({ selectedModelId: model }),
      ).ok,
    ).toBe(false);
  });
  it('supports empty hosts and cancellation', async () => {
    expect(
      await discoverDelegationModels({ modelIds: [], agents: [], inspect }),
    ).toEqual({ models: [], agents: [], truncated: false });
    await expect(
      discoverDelegationModels({
        modelIds: ['sonnet'],
        signal: AbortSignal.abort(),
        inspect,
      }),
    ).rejects.toThrow('cancelled');
  });
  it('bounds large catalogs without dropping the preferred route base and deduplicates input', async () => {
    const ids = Array.from({ length: 97 }, (_, index) => `model-${index}`);
    const agent = { agentId: 'agent_model_reviewer', label: 'Reviewer' };
    const discovered = await discoverDelegationModels({
      modelIds: ids,
      agents: [agent, agent],
      preferredModelId: 'agent_model_reviewer@model-96',
      inspect,
      canRunAgent: () => Promise.resolve(true),
    });
    expect(discovered.models).toHaveLength(96);
    expect(discovered.agents).toHaveLength(1);
    expect(discovered.recommendedModelId).toBe('agent_model_reviewer@model-96');
    expect(discovered.truncated).toBe(true);
  });
});

it.each(['agent_model_reviewer', model])(
  'allows %s only when this Agent is explicitly packaged',
  (selected) => {
    const built = buildSharedAutomationDocument(activity(selected), {
      description: '',
      packagedAgentId: 'agent_model_reviewer',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(JSON.stringify(built));
    expect(built.notices).toContain('local_agent_model_stripped');
    expect(built.document.action).not.toHaveProperty('modelConfig.model');
    expect(
      buildSharedAutomationDocument(activity(selected), {
        description: '',
        packagedAgentId: 'agent_model_other',
      }).ok,
    ).toBe(false);
  },
);

it.each([model, 'agent_model_reviewer'])(
  'shares the validated converted chat projection for %s',
  (selected) => {
    const original = activity(selected);
    const converted = chatAutomationToPipeline(original);
    const projected = {
      ...original,
      ownedPipeline: {
        pipelineId: 'owned',
        chatEditable: true,
        storedAction: {
          type: 'worktree_pipeline' as const,
          workspaceId: 'workspace',
          pipelineId: 'owned',
          pipelineSource: 'user' as const,
          inputs: converted.inputs,
          modelAliasPreferences: converted.modelAliasPreferences,
        },
      },
    };
    expect(sharedAutomationActivity(projected).action).toEqual(original.action);
    const noAgent = buildSharedAutomationDocument(
      sharedAutomationActivity(projected),
      { description: '' },
    );
    expect(noAgent.ok).toBe(false);
    if (selected === model) {
      const shared = buildSharedAutomationDocument(
        sharedAutomationActivity(projected),
        { description: '', resolvedAgent },
      );
      if (!shared.ok) throw new Error(JSON.stringify(shared));
      expect(
        buildInstallAutomationRequest(
          { id: 'share', contentHash: hash, automation: shared.document },
          {
            agent: { ...reference, localAgentId: 'agent_model_collision_2' },
          },
          timestamp,
        ),
      ).toMatchObject({
        ok: true,
        request: { action: { model: 'agent_model_collision_2@sonnet' } },
      });
    }
  },
);

it.each([
  ['no Agent', ''],
  ['an Agent route', model],
])(
  'shares a packaged install with %s as its workflow only without an Agent route (CAN-6455)',
  (_label, selected) => {
    const original = activity(selected);
    const converted = chatAutomationToPipeline(original);
    const storedAction = {
      type: 'worktree_pipeline' as const,
      target: { kind: 'global' as const },
      pipelineId: 'owned',
      pipelineSource: 'user' as const,
      inputs: converted.inputs,
    };
    const installed = {
      ...original,
      installedFrom: {
        remoteId: 'share',
        contentHash: hash,
        installedAt: timestamp,
        capabilityPackage: {
          version: 1 as const,
          digest: `pp:v1:${'a'.repeat(43)}`,
        },
      },
      ownedPipeline: { pipelineId: 'owned', chatEditable: true, storedAction },
    };
    // Without the flag the share keeps the chat form; behind it, a packaged
    // install shares its workflow, but an Agent route always stays a chat.
    expect(sharedAutomationActivity(installed).action).toEqual(original.action);
    const workflow = installedPackageWorkflowActivity(installed);
    if (selected === '') expect(workflow?.action).toEqual(storedAction);
    else expect(workflow).toBeNull();
    expect(
      installedPackageWorkflowActivity({
        ...installed,
        ownedPipeline: { ...installed.ownedPipeline, chatEditable: false },
      }),
    ).toBeNull();
  },
);

it('rejects a hosted package swap with the same document hash unless a receipt proves equivalence', async () => {
  const local = {
    id: 'agent_model_reviewer',
    name: 'Reviewer',
    baseModel: 'sonnet',
    instructions: 'Review',
    pluginSelections: emptyPluginSelections(),
    createdAt: timestamp,
    updatedAt: timestamp,
    importedFromRemoteId: detail.id,
    remoteContentHash: hash,
    importedContentHash: 'local',
    contentHash: 'local',
  };
  const packaged: SharedAgentDetail = {
    ...detail,
    package: {
      version: 1,
      digest: `pp:v1:${'b'.repeat(43)}`,
      resources: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    },
  };
  await expect(
    resolveAutomationSharedAgent(model, {
      get: () => Promise.resolve(local),
      getShared: () => Promise.resolve(packaged),
    }),
  ).rejects.toThrow();
  await expect(
    findInstalledAutomationAgent(
      'agent_model_shared@sonnet',
      reference,
      packaged,
      [local],
    ),
  ).rejects.toThrow();
  await expect(
    findInstalledAutomationAgent(
      'agent_model_shared@sonnet',
      reference,
      packaged,
      [local],
      undefined,
      () => Promise.resolve(false),
    ),
  ).rejects.toThrow();
  await expect(
    findInstalledAutomationAgent(
      'agent_model_shared@sonnet',
      reference,
      packaged,
      [local],
      undefined,
      () => Promise.resolve(true),
    ),
  ).resolves.toMatchObject({ localAgentId: local.id });
});
