import { validateSharedAutomationDocument } from '@canopy/protocol/automations';
import type { SharedAgentDetail } from '@canopy/protocol/agents';
import { parseAgentDelegationSpawnRequest } from '@canopy/protocol/delegation';
import { ManagedDelegationModelsListResultSchema as DelegationModelDiscoverySchema } from '@canopy/protocol/canopy-core';
import type { DelegationModelChoice } from '@canopy/protocol/delegation/discovery';
import { emptyPluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import type { ScheduledActivity } from '../../types';
import { buildSharedAutomationDocument } from '../automation-sharing';
import { buildInstallAutomationRequest } from '../automation-install';
import { sharedAutomationActivity } from '../stored-automation-activity';
import {
  assertAutomationAgentReference,
  findInstalledAutomationAgent,
  resolveAutomationSharedAgent,
} from '../automation-agent';
import {
  chatAutomationToPipeline,
  ownedPipelineToChatAction,
} from '../chat-automation-conversion';
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
