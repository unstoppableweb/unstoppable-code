/**
 * Golden: sharing a workflow carries the skills and plugins its chat uses on
 * the author's machine. The `automations:capability-package:analyze` handler
 * analyzes a stored workflow (a converted chat automation's owned pipeline)
 * through the real package service and analyzer; only the inventory, the
 * selection resolver, the preference store and data paths are this test's.
 *
 * A local skill the workflow's `chat_plugins` collection selects, and one its
 * send step's message invokes, must be packaged and bound to that send step,
 * because the send step is where the chat, and every skill in it, comes from.
 * An MCP server can't travel and is named as kept private.
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PipelinePackageAnalysisSummary,
  PipelinePluginCollectionPreference,
  Pipeline,
} from '@canopy/execution-engine/types/pipeline';
import type {
  InvocableInventoryCache,
  InvocableInventoryEntry,
} from '@canopy/execution-engine/types/invocable-inventory';
import type { PipelinePackageSourceDescriptor } from '@canopy/desktop-shared/node';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { EffectivePluginSelectionRefs } from '../../plugins/plugin-resolver';

let mockRoot = '';
let mockPreferences: Record<string, PipelinePluginCollectionPreference> = {};
let mockInventoryEntries: InvocableInventoryEntry[] = [];

jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<object>('../../lib/paths'),
  getDataDir: (): string => join(mockRoot, 'data'),
  getPipelinePackageDismissalStorePath: (): string =>
    join(mockRoot, 'data', 'package-dismissals.json'),
}));
jest.mock('../../plugins/invocable-inventory-service', () => ({
  loadPipelinePackageInventorySources: (): Promise<{
    inventory: InvocableInventoryCache;
    sources: Record<string, PipelinePackageSourceDescriptor>;
  }> =>
    Promise.resolve({
      inventory: {
        version: 6,
        builtAt: '2026-11-11T00:00:00.000Z',
        entries: mockInventoryEntries,
      },
      sources: Object.fromEntries(
        mockInventoryEntries.map((entry) => [
          entry.id,
          {
            sourceRoot: join(mockRoot, 'skills', entry.name),
            memberPath: '.',
            sourceVisibility: 'local',
            runtimeKind: 'standalone_skill',
            rootName: entry.name,
          },
        ]),
      ),
    }),
}));
jest.mock('../../plugins/plugin-resolver', () => ({
  ...jest.requireActual<object>('../../plugins/plugin-resolver'),
  resolveEffectivePluginSelectionRefs: (
    selections: ChatTabPluginSelections,
  ): Promise<EffectivePluginSelectionRefs> =>
    Promise.resolve({
      disabledRefs: [],
      skillRefs: selections.skillRefs,
      pluginRefs: selections.pluginRefs,
      mcpServerRefs: selections.mcpServerRefs ?? [],
      warnings: [],
    }),
}));
jest.mock(
  '@canopy/execution-engine/node/pipelines/plugin-collection-store',
  () => ({
    ...jest.requireActual<object>(
      '@canopy/execution-engine/node/pipelines/plugin-collection-store',
    ),
    loadPipelinePluginCollectionPreferences: (): Record<
      string,
      PipelinePluginCollectionPreference
    > => mockPreferences,
  }),
);

import { serializePipelineDocument } from '@canopy/desktop-shared/lib/automation-share/pipeline-document';
import { chatAutomationToPipeline } from '@canopy/desktop-shared/lib/chat-automation-conversion';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { analyzeAutomationCapabilityPackage } from '../pipeline-package-service';

const SKILL = 'inbox-triage';

function skillEntry(
  name: string,
  provider: InvocableInventoryEntry['provider'] = 'claude',
): InvocableInventoryEntry {
  return {
    id: `${provider}:skill:custom:app:${name}`,
    provider,
    kind: 'skill',
    name,
    displayName: name,
    description: `The ${name} skill`,
    insertText: `/${name}`,
    invocationKey: `/${name}`,
    enableRef: { kind: 'skill', sourceId: 'custom:app', skillName: name },
  };
}

function writeSkill(name: string): void {
  const dir = join(mockRoot, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: The ${name} skill\n---\nTriage the inbox.\n`,
  );
}

/** A chat automation as the bulk migration converts it. */
function convertedWorkflow(
  prompt: string,
  pluginSelections?: ChatTabPluginSelections,
): Pipeline {
  const activity: ScheduledActivity = {
    version: 1,
    id: 'automation-1',
    name: 'Morning inbox',
    enabled: true,
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
    failureCount: 0,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: {
      type: 'app_advisor_prompt',
      prompt,
      ...(pluginSelections ? { pluginSelections } : {}),
    },
  };
  return chatAutomationToPipeline(activity).pipeline;
}

function analyze(pipeline: Pipeline): Promise<PipelinePackageAnalysisSummary> {
  const pipelineContent = serializePipelineDocument(pipeline);
  return analyzeAutomationCapabilityPackage(
    {
      rawContent: JSON.stringify({ name: pipeline.name }),
      activityId: 'automation-1',
      selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      pipelineContent,
    },
    {
      actionPipeline: { source: 'user', pipelineId: 'owned-workflow' },
      homedir: join(mockRoot, 'home'),
    },
  );
}

/** Providers whose trees the package carries for the send step's resources. */
function sendStepProviders(summary: PipelinePackageAnalysisSummary): string[] {
  const binding = summary.manifest?.bindings.find(
    (candidate) =>
      'jobId' in candidate &&
      candidate.jobId === 'chat' &&
      candidate.stepId === 'send',
  );
  const ids = new Set(binding?.resourceIds ?? []);
  return Array.from(
    new Set(
      (summary.manifest?.resources ?? [])
        .filter((resource) => ids.has(resource.id))
        .flatMap((resource) => resource.trees.map((tree) => tree.provider)),
    ),
  ).sort();
}

/** Resource ids the package binds to the converted workflow's send step. */
function sendStepResources(summary: PipelinePackageAnalysisSummary): string[] {
  const binding = summary.manifest?.bindings.find(
    (candidate) =>
      'jobId' in candidate &&
      candidate.jobId === 'chat' &&
      candidate.stepId === 'send',
  );
  return (binding?.resourceIds ?? []).map(
    (id) =>
      summary.manifest?.resources.find((resource) => resource.id === id)
        ?.displayName ?? id,
  );
}

beforeEach(() => {
  mockRoot = fs.mkdtempSync(join(tmpdir(), 'share-workflow-plugins-'));
  mockPreferences = {};
  mockInventoryEntries = [skillEntry(SKILL)];
  writeSkill(SKILL);
});
afterEach(() => {
  fs.rmSync(mockRoot, { recursive: true, force: true });
});

describe('automations:capability-package:analyze for a shared workflow', () => {
  it('packages a local skill its chat_plugins collection selects, for the send step', async () => {
    const selections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'custom:app', skillName: SKILL }],
      pluginRefs: [],
    };
    mockPreferences = {
      chat_plugins: { disabledDefaultKeys: [], extraSelections: selections },
    };
    const summary = await analyze(
      convertedWorkflow('Summarize my inbox', selections),
    );
    expect(summary.blockers).toEqual([]);
    expect(sendStepResources(summary)).toContain(SKILL);
  });

  it('packages a local skill the send step’s message invokes', async () => {
    const summary = await analyze(
      convertedWorkflow(`Every morning run /${SKILL} on the inbox`),
    );
    expect(summary.blockers).toEqual([]);
    expect(sendStepResources(summary)).toContain(SKILL);
  });

  it('packages a Codex variant too when the send step leaves the model to the destination', async () => {
    // A send step with no model starts its chat on the destination's default,
    // which may be Codex.
    mockInventoryEntries = [skillEntry(SKILL), skillEntry(SKILL, 'codex')];
    const selections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'custom:app', skillName: SKILL }],
      pluginRefs: [],
    };
    mockPreferences = {
      chat_plugins: { disabledDefaultKeys: [], extraSelections: selections },
    };
    const summary = await analyze(
      convertedWorkflow('Summarize my inbox', selections),
    );
    expect(summary.blockers).toEqual([]);
    expect(sendStepProviders(summary)).toEqual(['claude', 'codex']);
  });

  it('names an MCP server the workflow keeps on this machine', async () => {
    const selections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'gmail', configId: 'gmail-config' }],
    };
    mockPreferences = {
      chat_plugins: { disabledDefaultKeys: [], extraSelections: selections },
    };
    const summary = await analyze(
      convertedWorkflow('Summarize my inbox', selections),
    );
    expect(summary.unpackageableSelectionLabels).toContain('gmail');
    expect(sendStepResources(summary)).toEqual([]);
  });
});
