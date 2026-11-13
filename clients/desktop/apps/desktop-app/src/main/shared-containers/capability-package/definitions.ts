/**
 * Portable definition builders for a shared container's capability package
 * (CAN-4655, plan §2 "Package contents").
 *
 * Each builder turns one local object — a user or project pipeline, an
 * automation, an Agent, or a workspace-owned hook — into a definition
 * resource draft for `analyzeCapabilityPackage`'s `definitionResources`:
 * canonical document bytes plus the prompt text, structured requests and
 * other definitions it needs. Builders reuse the existing share sanitizers
 * and protocol validators, so the documents carry exactly what the existing
 * share paths allow and never credentials, activation tokens, machine paths,
 * connection configuration or source-machine identifiers.
 *
 * A builder that cannot make its object portable returns no resource and a
 * reason instead of guessing at a substitute.
 */
import {
  LOCAL_ONLY_PIPELINE_TRIGGER_MESSAGE,
  pipelineDeclaresLocalOnlyTrigger,
} from '@canopy/pipeline-interop/portability';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  AGENT_MODEL_PREFIX,
  isValidSharedAgentModelId,
  parseAgentRouteModelId,
  type SharedAgentDocument,
} from '@canopy/protocol/agents';
import type { PipelinePackageEnvironmentRequirement } from '@canopy/protocol/pipelines';
import { CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY } from '@canopy/protocol/pipelines';
import { getShareablePluginRefKey } from '@canopy/protocol/plugins';
import type { ShareablePluginRef } from '@canopy/protocol/plugins';
import {
  HOOK_TRIGGER_DISPLAY_LABELS,
  isHookTriggerName,
} from '@canopy/protocol/hook-triggers';
import {
  encodeSharedContainerDefinitionDocument,
  validateSharedContainerDefinitionDocument,
  type SharedContainerAutomationDefinitionUses,
  type SharedContainerDefinitionDocument,
  type SharedContainerDefinitionKind,
  type SharedContainerDefinitionProvenance,
  type SharedContainerHookAction,
  type SharedContainerHookModelConfig,
  type SharedContainerHookPipelineRef,
  type SharedContainerHookTarget,
} from '@canopy/protocol/shared-containers';
import {
  buildPipelineCapabilityPackageSources,
  capabilityPackageDefinitionResourceId,
  type CapabilityPackageDefinitionPromptText,
  type CapabilityPackageDefinitionRequest,
  type CapabilityPackageDefinitionResourceInput,
  type CapabilityPackagePortableResourceInput,
} from '@canopy/desktop-shared/node';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import {
  buildSharedAutomationDocument,
  type BuildSharedAutomationDocumentOptions,
} from '@canopy/desktop-shared/lib/automation-sharing';
import { readCodexSpeedRecord } from '@canopy/execution-engine/lib/codex-speed';
import type {
  ChatTabPluginSelections,
  HookAction,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type { AgentModelDefinition } from '@canopy/execution-engine/types/agent-models';
import type { Pipeline } from '@canopy/execution-engine/types/pipeline';
import type { McpServerRef } from '@canopy/execution-engine/types/mcp-servers';
import {
  buildPortablePipelineResources,
  capabilityInventoryEntryIdsByKey,
  resolvePipelinePackageProviderByStep,
} from '../../pipelines/pipeline-package-service';
import { loadPipelinePackageInventorySources } from '../../plugins/invocable-inventory-service';
import { mapPluginSelectionsToPortable } from '../../plugins/workspace-template-authoring';
import { resolveEffectivePluginSelectionRefs } from '../../plugins/plugin-resolver';
import { mcpSelectionToEnvironmentRequirement } from '../../mcp/share-requirement';
import { sanitizeRemoteUrl } from '../../lib/plan-share-repos';
import { textReferencesAgentModel } from './install-plan';

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/**
 * Where a definition's content came from. `historical-snapshot` is what ran
 * in the container; `substituted-current` stands in for a snapshot that is no
 * longer available. Both are recorded in the document's provenance.
 */
export type SharedContainerDefinitionOrigin =
  | 'current'
  | 'historical-snapshot'
  | 'substituted-current';

export type SharedContainerDefinitionOmissionReason =
  /** The object's source kind is not a local definition this package carries. */
  | 'unsupported_source'
  /** The local definition does not parse. */
  | 'invalid_definition'
  /**
   * The pipeline declares `workflow`, which can't leave this machine yet
   * (CAN-5782).
   */
  | 'local_only_trigger'
  /** The portable document failed the existing sanitizer or validator. */
  | 'not_portable'
  /** The automation is bound to one execution on this machine. */
  | 'execution_bound'
  /** The automation does not target this kind of container. */
  | 'not_container_targeted'
  /** The automation runs a pipeline the container package cannot carry. */
  | 'pipeline_not_packaged'
  /** The hook's repository has no portable identity. */
  | 'repository_unidentified'
  /** The hook's trigger is not a supported hook trigger. */
  | 'unsupported_trigger'
  /** No portable hook action remains. */
  | 'no_actions'
  /**
   * A child pipeline or project action the pipeline runs names an Agent.
   * Those files travel verbatim, so their Agent ids could not be rewritten
   * to the recipient's copies.
   */
  | 'child_agent_routing';

/** A definition resource ready for the analyzer, minus its binding key. */
export interface SharedContainerDefinitionResourceDraft {
  kind: SharedContainerDefinitionKind;
  /** Deterministic manifest resource id, derived from kind and identity. */
  resourceId: string;
  displayName: string;
  identity: string;
  /** Canonical document bytes. */
  document: Uint8Array;
  promptTexts: CapabilityPackageDefinitionPromptText[];
  requestKeys: CapabilityPackageDefinitionRequest[];
  dependsOnIdentities: string[];
  /** Informational requirements; never credentials or connection config. */
  environmentRequirements: PipelinePackageEnvironmentRequirement[];
  /** Child pipelines and project actions the definition runs. */
  portableResources: Array<
    Omit<CapabilityPackagePortableResourceInput, 'bindingKey'>
  >;
  /** Inventory ids for structured request keys, merged into analyzer input. */
  capabilityInventoryEntryIdsByKey: Record<string, string[]>;
}

export type SharedContainerDefinitionBuildResult =
  | {
      resource: SharedContainerDefinitionResourceDraft;
      /** Fields that stayed behind, from the existing share sanitizers. */
      notices: string[];
    }
  | {
      resource: undefined;
      reason: SharedContainerDefinitionOmissionReason;
      detail?: string;
    };

export interface SharedContainerDefinitionBuilderDependencies {
  loadInventory: typeof loadPipelinePackageInventorySources;
  buildPortablePipelineResources: typeof buildPortablePipelineResources;
  capabilityInventoryEntryIdsByKey: typeof capabilityInventoryEntryIdsByKey;
  mapPluginSelectionsToPortable: (
    selections: ChatTabPluginSelections,
  ) => ReturnType<typeof mapPluginSelectionsToPortable>;
  resolveEffectivePluginSelectionRefs: (
    selections: ChatTabPluginSelections,
  ) => ReturnType<typeof resolveEffectivePluginSelectionRefs>;
  mcpSelectionToEnvironmentRequirement: (
    selection: McpServerRef,
  ) => Promise<PipelinePackageEnvironmentRequirement>;
}

const defaultDependencies: SharedContainerDefinitionBuilderDependencies = {
  loadInventory: loadPipelinePackageInventorySources,
  buildPortablePipelineResources,
  capabilityInventoryEntryIdsByKey,
  mapPluginSelectionsToPortable: (selections) =>
    mapPluginSelectionsToPortable(selections),
  resolveEffectivePluginSelectionRefs: (selections) =>
    resolveEffectivePluginSelectionRefs(selections),
  mcpSelectionToEnvironmentRequirement: (selection) =>
    mcpSelectionToEnvironmentRequirement(selection),
};

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

/** Identity of a local user or project pipeline definition. */
export function pipelineDefinitionIdentity(
  source: 'user' | 'project',
  pipelineId: string,
): string {
  return `pipeline:${source}:${pipelineId}`;
}

export function automationDefinitionIdentity(activityId: string): string {
  return `automation:${activityId}`;
}

/** Agent ids (`agent_model_*`) are already portable. */
export function agentDefinitionIdentity(agentId: string): string {
  return `agent:${agentId}`;
}

/** A hook is identified by its portable target and trigger, never a local repo id. */
export function hookDefinitionIdentity(
  target: SharedContainerHookTarget,
  triggerName: string,
): string {
  return target.kind === 'workspace-repo'
    ? `hook:workspace-repo:${target.repository.remoteUrl ?? ''}:${target.repository.layoutName}:${triggerName}`
    : `hook:${target.kind}:${triggerName}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROVIDERS = ['claude', 'codex'] as const;

function provenanceFor(
  origin: SharedContainerDefinitionOrigin | undefined,
): SharedContainerDefinitionProvenance | undefined {
  if (origin === 'historical-snapshot') return { historicalSnapshot: true };
  if (origin === 'substituted-current')
    return { substitutedCurrentDefinition: true };
  return undefined;
}

function finalizeDocument(
  document: SharedContainerDefinitionDocument,
):
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'not_portable'; detail: string } {
  const validated = validateSharedContainerDefinitionDocument(document);
  if (!validated.ok)
    return {
      ok: false,
      reason: 'not_portable',
      detail: validated.errors.join('; '),
    };
  return {
    ok: true,
    bytes: encodeSharedContainerDefinitionDocument(validated.value),
  };
}

/** The Agent a model id routes through, when it is a local Agent model. */
function agentIdForModel(model: unknown): string | undefined {
  if (typeof model !== 'string' || !model.startsWith(AGENT_MODEL_PREFIX))
    return undefined;
  const routed = parseAgentRouteModelId(model)?.agentId;
  if (routed) return routed;
  return isValidSharedAgentModelId(model) ? model : undefined;
}

function sortedUnique(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

function mergeRequests(
  requests: readonly CapabilityPackageDefinitionRequest[],
): CapabilityPackageDefinitionRequest[] {
  const merged = new Map<string, CapabilityPackageDefinitionRequest>();
  for (const request of requests) {
    const key = `${request.provider}\0${request.key}`;
    const existing = merged.get(key);
    const required = (existing?.required ?? false) || request.required;
    // Confirmed when any source confirms it.
    const unconfirmed =
      (existing ? existing.unconfirmed === true : true) &&
      request.unconfirmed === true;
    merged.set(key, {
      key: request.key,
      provider: request.provider,
      required,
      ...(unconfirmed ? { unconfirmed } : {}),
    });
  }
  return Array.from(merged.values()).sort((left, right) =>
    `${left.provider}\0${left.key}` < `${right.provider}\0${right.key}`
      ? -1
      : 1,
  );
}

function mergePromptTexts(
  texts: readonly CapabilityPackageDefinitionPromptText[],
): CapabilityPackageDefinitionPromptText[] {
  const merged = new Map<string, CapabilityPackageDefinitionPromptText>();
  for (const text of texts) {
    if (text.text.trim().length === 0) continue;
    const key = `${text.provider}\0${text.text}`;
    const existing = merged.get(key);
    const unconfirmed =
      (existing ? existing.unconfirmed === true : true) &&
      text.unconfirmed === true;
    merged.set(key, {
      provider: text.provider,
      text: text.text,
      ...(unconfirmed ? { unconfirmed } : {}),
    });
  }
  return Array.from(merged.values());
}

/**
 * Requirements describe what a recipient must set up. Definition resources
 * bind to the container as a whole, so step locations are dropped.
 */
function mergeRequirements(
  requirements: readonly PipelinePackageEnvironmentRequirement[],
): PipelinePackageEnvironmentRequirement[] {
  const merged = new Map<string, PipelinePackageEnvironmentRequirement>();
  for (const requirement of requirements) {
    const existing = merged.get(requirement.id);
    merged.set(requirement.id, {
      ...(existing ?? requirement),
      required: (existing?.required ?? false) || requirement.required,
      affectedSteps: [],
    });
  }
  return Array.from(merged.values()).sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

/**
 * Structured requests for local skill and plugin selections, resolved the
 * same way the existing automation and Agent package analyses resolve them:
 * every effective skill and plugin, required under both providers.
 */
async function selectionRequests(
  selections: ChatTabPluginSelections | undefined,
  deps: SharedContainerDefinitionBuilderDependencies,
): Promise<{
  requests: CapabilityPackageDefinitionRequest[];
  requirements: PipelinePackageEnvironmentRequirement[];
  warnings: string[];
}> {
  if (!selections) return { requests: [], requirements: [], warnings: [] };
  const effective = await deps.resolveEffectivePluginSelectionRefs(selections);
  const keys = sortedUnique([
    ...effective.skillRefs.map(
      (skill) => `skill:${skill.sourceId}:${skill.skillName}`,
    ),
    ...effective.pluginRefs.map(
      (plugin) => `plugin:${plugin.marketplaceId}:${plugin.pluginName}`,
    ),
  ]);
  const requirements = await Promise.all(
    effective.mcpServerRefs.map((server) =>
      deps.mcpSelectionToEnvironmentRequirement(server),
    ),
  );
  return {
    requests: keys.flatMap((key) =>
      PROVIDERS.map((provider) => ({ key, provider, required: true })),
    ),
    requirements,
    warnings: effective.warnings,
  };
}

function dedupePlugins(
  refs: readonly ShareablePluginRef[],
): ShareablePluginRef[] {
  const byKey = new Map<string, ShareablePluginRef>();
  for (const ref of refs) byKey.set(getShareablePluginRefKey(ref), ref);
  return Array.from(byKey.values());
}

function draft(
  input: Omit<SharedContainerDefinitionResourceDraft, 'resourceId'>,
): SharedContainerDefinitionResourceDraft {
  return {
    ...input,
    resourceId: capabilityPackageDefinitionResourceId(
      input.kind,
      input.identity,
    ),
    dependsOnIdentities: sortedUnique(input.dependsOnIdentities),
  };
}

/** Analyzer input for a draft, bound where the composer chooses. */
export function toCapabilityPackageDefinitionResourceInput(
  resource: SharedContainerDefinitionResourceDraft,
  bindingKey: string = CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
): CapabilityPackageDefinitionResourceInput {
  return {
    kind: resource.kind,
    displayName: resource.displayName,
    identity: resource.identity,
    document: resource.document,
    bindingKey,
    promptTexts: resource.promptTexts,
    requestKeys: resource.requestKeys,
    dependsOnIdentities: resource.dependsOnIdentities,
    portableResources: resource.portableResources,
  };
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

export interface PipelineDefinitionSource {
  pipeline: {
    id: string;
    source: string;
    name: string;
    description?: string;
  };
  /** Exact stored YAML, or the YAML of a historical execution snapshot. */
  rawYaml: string;
  origin?: SharedContainerDefinitionOrigin;
  /** Directory of the stored pipeline file, for relative child pipelines. */
  pipelineFileDir?: string;
  /** Checkout used to resolve project actions and child pipelines. */
  repoPath?: string;
}

function pipelineAgentIds(pipeline: Pipeline): string[] {
  const models: unknown[] = [];
  for (const job of Object.values(pipeline.jobs)) {
    for (const step of job.steps) models.push(step.with?.model);
  }
  for (const alias of pipeline.model_aliases ?? []) {
    if (alias.defaults && 'base' in alias.defaults)
      models.push(alias.defaults.base);
  }
  return sortedUnique(
    models.flatMap((model) => {
      const agentId = agentIdForModel(model);
      return agentId ? [agentId] : [];
    }),
  );
}

/** The file an action's steps are read from (see the executor's resolver). */
const ACTION_FILE_NAME = 'action.yml';

/**
 * The text that decides how a packaged child pipeline or project action
 * runs: the child pipeline file, or the action's `action.yml`. A file that
 * cannot be read is left to the analyzer, which reads the same source and
 * blocks on it.
 */
async function portableResourceRoutingText(
  resource: Omit<CapabilityPackagePortableResourceInput, 'bindingKey'>,
): Promise<string | undefined> {
  const filePath =
    resource.kind === 'child_pipeline'
      ? path.resolve(
          resource.descriptor.sourceRoot,
          resource.descriptor.memberPath,
        )
      : path.join(resource.descriptor.sourceRoot, ACTION_FILE_NAME);
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * A local user or project pipeline as a `pipeline_definition`. The YAML is the
 * same portable YAML the existing share path publishes, and its child
 * pipelines and project actions are surfaced through the existing portable
 * resource builder so they travel beside it.
 */
export async function buildPipelineDefinitionResource(
  source: PipelineDefinitionSource,
  deps: SharedContainerDefinitionBuilderDependencies = defaultDependencies,
): Promise<SharedContainerDefinitionBuildResult> {
  const pipelineSource = source.pipeline.source;
  if (pipelineSource !== 'user' && pipelineSource !== 'project')
    return { resource: undefined, reason: 'unsupported_source' };
  let pipeline: Pipeline;
  try {
    pipeline = parsePipelineText(source.rawYaml);
  } catch (error) {
    return {
      resource: undefined,
      reason: 'invalid_definition',
      detail: error instanceof Error ? error.message : undefined,
    };
  }
  if (pipelineDeclaresLocalOnlyTrigger(pipeline)) {
    return {
      resource: undefined,
      reason: 'local_only_trigger',
      detail: LOCAL_ONLY_PIPELINE_TRIGGER_MESSAGE,
    };
  }
  const agentIds = pipelineAgentIds(pipeline);
  const provenance = provenanceFor(source.origin);
  const description = source.pipeline.description?.trim();
  const finalized = finalizeDocument({
    version: 1,
    kind: 'pipeline_definition',
    references: agentIds.map((agentId) =>
      capabilityPackageDefinitionResourceId(
        'agent_definition',
        agentDefinitionIdentity(agentId),
      ),
    ),
    ...(provenance ? { provenance } : {}),
    name: source.pipeline.name,
    ...(description ? { description } : {}),
    yaml: source.rawYaml,
  });
  if (!finalized.ok) return { resource: undefined, ...finalized };

  const sources = buildPipelineCapabilityPackageSources(
    pipeline,
    resolvePipelinePackageProviderByStep(pipeline),
  );
  const { inventory } = await deps.loadInventory();
  const portable = await deps.buildPortablePipelineResources({
    pipeline,
    inventory,
    pipelineFileDir: source.pipelineFileDir,
    repoPath: source.repoPath,
  });
  // A child pipeline that declares `workflow` would travel as a
  // `child_pipeline` resource, which web never parses.
  if (
    portable.blockers.some(
      (blocker) => blocker.code === 'LOCAL_ONLY_PIPELINE_TRIGGER',
    )
  ) {
    return {
      resource: undefined,
      reason: 'local_only_trigger',
      detail: LOCAL_ONLY_PIPELINE_TRIGGER_MESSAGE,
    };
  }
  const rootInventoryIds = await deps.capabilityInventoryEntryIdsByKey(
    pipeline,
    inventory,
  );
  const portableResources = new Map<
    string,
    Omit<CapabilityPackagePortableResourceInput, 'bindingKey'>
  >();
  for (const resource of portable.resources) {
    portableResources.set(
      `${resource.kind}\0${resource.invocationKeys[0] ?? ''}`,
      {
        kind: resource.kind,
        displayName: resource.displayName,
        invocationKeys: Array.from(new Set(resource.invocationKeys)),
        descriptor: resource.descriptor,
      },
    );
  }
  // Only the top-level YAML's Agent ids are packaged and rewritten. One
  // named by a child pipeline or action (nested ones included) would reach
  // the recipient unchanged, so the pipeline is omitted instead.
  for (const resource of Array.from(portableResources.values())) {
    const text = await portableResourceRoutingText(resource);
    if (text !== undefined && textReferencesAgentModel(text))
      return {
        resource: undefined,
        reason: 'child_agent_routing',
        detail: resource.displayName,
      };
  }
  return {
    resource: draft({
      kind: 'pipeline_definition',
      displayName: source.pipeline.name,
      identity: pipelineDefinitionIdentity(pipelineSource, source.pipeline.id),
      document: finalized.bytes,
      promptTexts: mergePromptTexts(
        [...sources.promptSources, ...portable.promptSources].map((text) => ({
          provider: text.provider,
          text: text.text,
          ...(text.unconfirmed ? { unconfirmed: true } : {}),
        })),
      ),
      requestKeys: mergeRequests(
        [...sources.requests, ...portable.requests].map((request) => ({
          key: request.key,
          provider: request.provider,
          required: request.required,
          ...(request.unconfirmed ? { unconfirmed: true } : {}),
        })),
      ),
      dependsOnIdentities: agentIds.map(agentDefinitionIdentity),
      environmentRequirements: mergeRequirements([
        ...sources.environmentRequirements,
        ...portable.environmentRequirements,
      ]),
      portableResources: Array.from(portableResources.values()),
      capabilityInventoryEntryIdsByKey: {
        ...rootInventoryIds,
        ...portable.capabilityInventoryEntryIdsByKey,
      },
    }),
    notices: [],
  };
}

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

export interface AutomationDefinitionSource {
  activity: ScheduledActivity;
  /** The container the automation targets or ran into. */
  containerType: 'code' | 'cowork';
  /**
   * YAML of the pipeline a `worktree_pipeline` action runs, used only to
   * verify the action's target scopes. A user or project pipeline itself
   * travels as its own `pipeline_definition`.
   */
  pipelineYaml?: string;
  /** Curated catalog key for a curated pipeline action. */
  curatedPipelineKey?: string;
  origin?: SharedContainerDefinitionOrigin;
}

const CODE_CONTAINER_ACTIONS = new Set([
  'worktree_prompt',
  'worktree_pipeline',
  'worktree_session_prompt',
]);
const COWORK_CONTAINER_ACTIONS = new Set([
  'standalone_prompt',
  'worktree_session_prompt',
]);

/**
 * A local automation as an `automation_definition`. The existing share
 * sanitizer (`buildSharedAutomationDocument`) removes the workspace,
 * worktree, base-worktree, chat-project and chat bindings and every other
 * local field; the container document then retargets it to the fork
 * destination and names the packaged pipeline or Agent it runs.
 */
export async function buildAutomationDefinitionResource(
  source: AutomationDefinitionSource,
  deps: SharedContainerDefinitionBuilderDependencies = defaultDependencies,
): Promise<SharedContainerDefinitionBuildResult> {
  const { activity } = source;
  const action = activity.action;
  if (action.type === 'pipeline_execution_resume')
    return { resource: undefined, reason: 'execution_bound' };
  const supported =
    source.containerType === 'code'
      ? CODE_CONTAINER_ACTIONS
      : COWORK_CONTAINER_ACTIONS;
  if (!supported.has(action.type))
    return { resource: undefined, reason: 'not_container_targeted' };

  const options: BuildSharedAutomationDocumentOptions = {
    description: '',
    ...(action.type === 'worktree_session_prompt'
      ? {
          sessionTargetKind:
            source.containerType === 'cowork' ? 'cowork' : 'single-repo',
        }
      : {}),
  };
  let selections: ChatTabPluginSelections | undefined;
  let prompt: string | undefined;
  let agentId: string | undefined;
  let pipelineIdentity: string | undefined;
  if (action.type === 'worktree_pipeline') {
    if (source.pipelineYaml !== undefined) {
      try {
        options.pipelineResolution = {
          status: 'resolved',
          scopes: parsePipelineText(source.pipelineYaml).scope,
        };
      } catch (error) {
        options.pipelineResolution = {
          status: 'error',
          error:
            error instanceof Error
              ? error.message
              : 'Pipeline definition could not be read.',
        };
      }
    }
    if (action.sharedPipeline?.installPin)
      options.sharedPipelineInstallPin = action.sharedPipeline.installPin;
    if (source.curatedPipelineKey)
      options.curatedPipelineKey = source.curatedPipelineKey;
    if (
      action.pipelineSource === 'user' ||
      action.pipelineSource === 'project'
    ) {
      pipelineIdentity = pipelineDefinitionIdentity(
        action.pipelineSource,
        action.pipelineId,
      );
    }
  } else {
    selections = action.pluginSelections;
    prompt = action.prompt;
    agentId = agentIdForModel(action.model);
    if (selections) {
      const portable = await deps.mapPluginSelectionsToPortable(selections);
      options.resolvedPlugins = {
        plugins: portable.refs,
        dropped: portable.unresolved,
      };
    }
  }

  const built = buildSharedAutomationDocument(activity, options);
  if (!built.ok)
    return {
      resource: undefined,
      reason: built.reasons.includes('action_execution_bound')
        ? 'execution_bound'
        : 'not_portable',
      detail: [built.reasons.join(', '), built.detail]
        .filter(Boolean)
        .join(': '),
    };
  const sharedAction = built.document.action;
  const uses: SharedContainerAutomationDefinitionUses = {};
  if (
    sharedAction.type === 'worktree_pipeline' &&
    sharedAction.pipeline.source === 'unresolved'
  ) {
    if (!pipelineIdentity)
      return { resource: undefined, reason: 'pipeline_not_packaged' };
    uses.pipeline = capabilityPackageDefinitionResourceId(
      'pipeline_definition',
      pipelineIdentity,
    );
  } else {
    // The pipeline travels by a portable bundled, curated or shared reference.
    pipelineIdentity = undefined;
  }
  if (agentId)
    uses.agent = capabilityPackageDefinitionResourceId(
      'agent_definition',
      agentDefinitionIdentity(agentId),
    );
  const provenance = provenanceFor(source.origin);
  const finalized = finalizeDocument({
    version: 1,
    kind: 'automation_definition',
    references: sortedUnique(Object.values(uses)),
    ...(provenance ? { provenance } : {}),
    automation: built.document,
    target: { kind: 'source-container' },
    ...(Object.keys(uses).length > 0 ? { uses } : {}),
  });
  if (!finalized.ok) return { resource: undefined, ...finalized };

  const selected = await selectionRequests(selections, deps);
  return {
    resource: draft({
      kind: 'automation_definition',
      displayName: activity.name,
      identity: automationDefinitionIdentity(activity.id),
      document: finalized.bytes,
      promptTexts: mergePromptTexts(
        prompt ? [{ provider: 'claude', text: prompt }] : [],
      ),
      requestKeys: mergeRequests(selected.requests),
      dependsOnIdentities: [
        ...(pipelineIdentity ? [pipelineIdentity] : []),
        ...(agentId ? [agentDefinitionIdentity(agentId)] : []),
      ],
      environmentRequirements: mergeRequirements(selected.requirements),
      portableResources: [],
      capabilityInventoryEntryIdsByKey: {},
    }),
    notices: sortedUnique([...built.notices, ...selected.warnings]),
  };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface AgentDefinitionSource {
  agent: AgentModelDefinition;
  origin?: SharedContainerDefinitionOrigin;
}

/**
 * A local Agent as an `agent_definition`: the same validated
 * `SharedAgentDocument` the Agent share path builds, with selections reduced
 * to shareable references. Local skills and plugins travel as dependencies
 * through request keys; MCP authentication preferences stay behind.
 */
export async function buildAgentDefinitionResource(
  source: AgentDefinitionSource,
  deps: SharedContainerDefinitionBuilderDependencies = defaultDependencies,
): Promise<SharedContainerDefinitionBuildResult> {
  const { agent } = source;
  const portable = await deps.mapPluginSelectionsToPortable(
    agent.pluginSelections,
  );
  const sharedAgent: SharedAgentDocument = {
    version: 1,
    id: agent.id,
    name: agent.name,
    baseModel: agent.baseModel,
    instructions: agent.instructions,
    plugins: portable.refs,
  };
  const provenance = provenanceFor(source.origin);
  const finalized = finalizeDocument({
    version: 1,
    kind: 'agent_definition',
    references: [],
    ...(provenance ? { provenance } : {}),
    agent: sharedAgent,
  });
  if (!finalized.ok) return { resource: undefined, ...finalized };
  const selected = await selectionRequests(agent.pluginSelections, deps);
  return {
    resource: draft({
      kind: 'agent_definition',
      displayName: agent.name,
      identity: agentDefinitionIdentity(agent.id),
      document: finalized.bytes,
      promptTexts: mergePromptTexts([
        { provider: 'claude', text: agent.instructions },
      ]),
      requestKeys: mergeRequests(selected.requests),
      dependsOnIdentities: [],
      environmentRequirements: mergeRequirements(selected.requirements),
      portableResources: [],
      capabilityInventoryEntryIdsByKey: {},
    }),
    notices: sortedUnique([
      ...portable.unresolved,
      ...selected.warnings,
      ...((agent.pluginSelections.mcpHttpAuthPreferences?.length ?? 0) > 0
        ? ['mcp_auth_preferences_stripped']
        : []),
    ]),
  };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface HookDefinitionSource {
  hook: {
    triggerName: string;
    actions: HookAction[];
    target: 'project' | 'workspace-root' | 'workspace-repo';
  };
  /**
   * The hook repository's portable identity, required for a workspace-repo
   * hook: its remote URL (sanitized here) and its directory name within the
   * multi-repo layout. The local repository id never travels.
   */
  repository?: { remoteUrl: string | null; layoutName: string };
  origin?: SharedContainerDefinitionOrigin;
}

interface ConvertedHookAction {
  action: SharedContainerHookAction;
  agentId?: string;
  pipelineIdentity?: string;
  selections?: ChatTabPluginSelections;
  prompt?: string;
}

async function convertHookAction(
  action: HookAction,
  deps: SharedContainerDefinitionBuilderDependencies,
  notices: Set<string>,
): Promise<ConvertedHookAction | undefined> {
  if (action.type === 'command') {
    return {
      action: {
        type: 'command',
        command: action.command,
        ...(action.shell && (action.shell.windows || action.shell.mac)
          ? {
              shell: {
                ...(action.shell.windows
                  ? { windows: action.shell.windows }
                  : {}),
                ...(action.shell.mac ? { mac: action.shell.mac } : {}),
              },
            }
          : {}),
        ...(action.interactive === true ? { interactive: true } : {}),
      },
    };
  }
  if (action.type === 'chat') {
    // Machine-local overlay stubs are never executable on their own.
    if (
      action.localExecutionContextOverlay === true ||
      action.localPluginSelectionOverlay === true
    ) {
      notices.add('local_overlay_stripped');
      return undefined;
    }
    if (action.approvalMode !== undefined)
      notices.add('approval_mode_stripped');
    if (action.executionContext !== undefined)
      notices.add('execution_context_stripped');
    const agentId = agentIdForModel(action.model);
    const modelConfig: SharedContainerHookModelConfig = {};
    if (
      typeof action.model === 'string' &&
      action.model.length > 0 &&
      !agentId &&
      !action.model.startsWith(AGENT_MODEL_PREFIX)
    )
      modelConfig.model = action.model;
    const thinkingLevel = action.modelConfig?.thinkingLevel ?? action.thinking;
    if (thinkingLevel !== undefined) modelConfig.thinkingLevel = thinkingLevel;
    const speed = readCodexSpeedRecord(
      action.modelConfig,
      action.codexFastMode,
    );
    if (speed !== undefined) {
      modelConfig.speed = speed;
      modelConfig.fastMode = speed === 'fast';
    }
    const portable = action.pluginSelections
      ? await deps.mapPluginSelectionsToPortable(action.pluginSelections)
      : undefined;
    for (const label of portable?.unresolved ?? []) notices.add(label);
    return {
      action: {
        type: 'chat',
        prompt: action.prompt,
        ...(action.promptReferences
          ? { promptReferences: action.promptReferences }
          : {}),
        ...(action.planMode !== undefined ? { planMode: action.planMode } : {}),
        ...(Object.keys(modelConfig).length > 0 ? { modelConfig } : {}),
        ...(agentId
          ? {
              agent: capabilityPackageDefinitionResourceId(
                'agent_definition',
                agentDefinitionIdentity(agentId),
              ),
            }
          : {}),
        ...(action['if-command'] !== undefined
          ? { ifCommand: action['if-command'] }
          : {}),
        plugins: dedupePlugins([
          ...(action.plugins ?? []),
          ...(portable?.refs ?? []),
        ]),
        ...(action.allowChatConcurrency === true
          ? { allowChatConcurrency: true }
          : {}),
        ...(action.autoArchive === true ? { autoArchive: true } : {}),
      },
      ...(agentId ? { agentId } : {}),
      ...(action.pluginSelections
        ? { selections: action.pluginSelections }
        : {}),
      prompt: action.prompt,
    };
  }
  if (action.localExecutionContextOverlay === true) {
    notices.add('local_overlay_stripped');
    return undefined;
  }
  if (action.executionContext !== undefined)
    notices.add('execution_context_stripped');
  let pipeline: SharedContainerHookPipelineRef;
  let pipelineIdentity: string | undefined;
  switch (action.source) {
    case 'bundled':
    case 'curated':
      pipeline = { source: action.source, id: action.id };
      break;
    case 'project':
      pipeline = { source: 'project', path: action.id };
      break;
    case 'local':
      pipelineIdentity = pipelineDefinitionIdentity('user', action.id);
      pipeline = {
        source: 'packaged',
        resourceId: capabilityPackageDefinitionResourceId(
          'pipeline_definition',
          pipelineIdentity,
        ),
      };
      break;
  }
  // Input values are the source's local choices, as for automations.
  if (action.inputs && Object.keys(action.inputs).length > 0)
    notices.add('input_values_stripped');
  const speed = readCodexSpeedRecord(action.modelConfig, action.codexFastMode);
  return {
    action: {
      type: 'pipeline',
      pipeline,
      ...(speed !== undefined
        ? { modelConfig: { speed, fastMode: speed === 'fast' } }
        : {}),
      ...(action.allowPipelineConcurrency === true
        ? { allowPipelineConcurrency: true }
        : {}),
    },
    ...(pipelineIdentity ? { pipelineIdentity } : {}),
  };
}

/**
 * A workspace-owned hook as a `hook_definition`. Commands are the hook's
 * definition content and travel verbatim; approval modes, execution-context
 * bindings, local overlays, pipeline input values and MCP configuration stay
 * behind, and the target repository is named by a portable identity rather
 * than its local id.
 *
 * Kept for a future installer only: the package composer does not build hook
 * units, because no installer can guarantee a hook starts paused.
 */
export async function buildHookDefinitionResource(
  source: HookDefinitionSource,
  deps: SharedContainerDefinitionBuilderDependencies = defaultDependencies,
): Promise<SharedContainerDefinitionBuildResult> {
  const { triggerName } = source.hook;
  if (!isHookTriggerName(triggerName))
    return { resource: undefined, reason: 'unsupported_trigger' };
  let target: SharedContainerHookTarget;
  if (source.hook.target === 'workspace-repo') {
    const repository = source.repository;
    if (!repository || repository.layoutName.trim().length === 0)
      return { resource: undefined, reason: 'repository_unidentified' };
    target = {
      kind: 'workspace-repo',
      repository: {
        remoteUrl: sanitizeRemoteUrl(repository.remoteUrl),
        layoutName: repository.layoutName,
      },
    };
  } else {
    target = { kind: source.hook.target };
  }
  const notices = new Set<string>();
  const converted: ConvertedHookAction[] = [];
  for (const action of source.hook.actions) {
    const result = await convertHookAction(action, deps, notices);
    if (result) converted.push(result);
  }
  if (converted.length === 0)
    return { resource: undefined, reason: 'no_actions' };
  const agentIds = sortedUnique(
    converted.flatMap((item) => (item.agentId ? [item.agentId] : [])),
  );
  const pipelineIdentities = sortedUnique(
    converted.flatMap((item) =>
      item.pipelineIdentity ? [item.pipelineIdentity] : [],
    ),
  );
  const provenance = provenanceFor(source.origin);
  const finalized = finalizeDocument({
    version: 1,
    kind: 'hook_definition',
    references: sortedUnique([
      ...agentIds.map((agentId) =>
        capabilityPackageDefinitionResourceId(
          'agent_definition',
          agentDefinitionIdentity(agentId),
        ),
      ),
      ...pipelineIdentities.map((identity) =>
        capabilityPackageDefinitionResourceId('pipeline_definition', identity),
      ),
    ]),
    ...(provenance ? { provenance } : {}),
    triggerName,
    target,
    actions: converted.map((item) => item.action),
  });
  if (!finalized.ok) return { resource: undefined, ...finalized };
  const requests: CapabilityPackageDefinitionRequest[] = [];
  const requirements: PipelinePackageEnvironmentRequirement[] = [];
  for (const item of converted) {
    const selected = await selectionRequests(item.selections, deps);
    requests.push(...selected.requests);
    requirements.push(...selected.requirements);
    for (const warning of selected.warnings) notices.add(warning);
  }
  return {
    resource: draft({
      kind: 'hook_definition',
      displayName:
        target.kind === 'workspace-repo'
          ? `${HOOK_TRIGGER_DISPLAY_LABELS[triggerName]} (${target.repository.layoutName})`
          : HOOK_TRIGGER_DISPLAY_LABELS[triggerName],
      identity: hookDefinitionIdentity(target, triggerName),
      document: finalized.bytes,
      promptTexts: mergePromptTexts(
        converted.flatMap((item) =>
          item.prompt ? [{ provider: 'claude', text: item.prompt }] : [],
        ),
      ),
      requestKeys: mergeRequests(requests),
      dependsOnIdentities: [
        ...agentIds.map(agentDefinitionIdentity),
        ...pipelineIdentities,
      ],
      environmentRequirements: mergeRequirements(requirements),
      portableResources: [],
      capabilityInventoryEntryIdsByKey: {},
    }),
    notices: sortedUnique(notices),
  };
}
