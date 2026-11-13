/**
 * Pure planning for a fork's capability package install (CAN-4655, plan §6).
 *
 * Every definition document, every reference between definitions and every
 * destination mapping is checked here, before the installer changes anything.
 * A package that fails these checks installs nothing. Individual definitions
 * that are valid but cannot target this fork (an automation for another kind
 * of project, or one whose pipeline the package does not carry) are skipped
 * with a reason instead, and the rest of the package installs.
 *
 * The module has no I/O: the caller supplies each definition document's
 * verified bytes.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  AGENT_MODEL_PREFIX,
  isValidSharedAgentModelId,
  parseAgentRouteModelId,
} from '@canopy/protocol/agents';
import {
  CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
  capabilityPackageBindingKey,
  capabilityPackageStepBindingKey,
  type PipelinePackageBinding,
  type PipelinePackageEnvironmentRequirement,
  type PipelinePackageManifestV1,
  type PipelinePackageResource,
} from '@canopy/protocol/pipelines';
import {
  isSharedContainerDefinitionKind,
  parseSharedContainerDefinitionDocument,
  SHARED_CONTAINER_DEFINITION_DOCUMENT_PATH,
  type SharedContainerAgentDefinitionDocument,
  type SharedContainerAutomationDefinitionDocument,
  type SharedContainerDefinitionDocument,
  type SharedContainerDefinitionKind,
  type SharedContainerHookDefinitionDocument,
  type SharedContainerPipelineDefinitionDocument,
  type SharedContainerType,
} from '@canopy/protocol/shared-containers';
import {
  buildPipelineCapabilityPackageSources,
  type PipelinePackageStepProviders,
} from '@canopy/desktop-shared/node';
import {
  extractInvocationTokens,
  isExplicitPathInvocationToken,
} from '@canopy/desktop-shared/lib/invocation-tokens';
import { assignStepIds } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import type { Pipeline, Step } from '@canopy/execution-engine/types/pipeline';

/** The package cannot be installed as a whole; nothing is changed. */
export class ForkCapabilityPackageInvalidError extends Error {
  constructor(readonly detail: string) {
    super(`Invalid shared-container capability package: ${detail}`);
    this.name = 'ForkCapabilityPackageInvalidError';
  }
}

export type ForkAutomationSkipReason =
  /** The action runs somewhere this kind of fork does not create. */
  | 'incompatible-target'
  /** The pipeline it runs is not one this package carries. */
  | 'pipeline-unavailable'
  /** It routes through an Agent this package does not carry. */
  | 'agent-unavailable'
  /** The packaged pipeline it runs was skipped; see {@link SkippedPipeline}. */
  | 'pipeline-skipped';

export type ForkPipelineSkipReason =
  /**
   * A child pipeline or action it runs names an Agent. Those files travel
   * verbatim in the pipeline's overlay, so their Agent ids could not be
   * rewritten to this machine's copies.
   */
  'child-agent-routing';

export interface PlannedAgent {
  resourceId: string;
  document: SharedContainerAgentDefinitionDocument;
  /** Standalone skills in this Agent's dependency closure. */
  skillResourceIds: string[];
}

export interface PlannedPipeline {
  resourceId: string;
  document: SharedContainerPipelineDefinitionDocument;
  /** Agent definitions the YAML routes through. */
  agentResourceIds: string[];
  /**
   * Child pipelines, actions and the standalone skills the definition uses
   * (plus their dependencies), kept in an overlay.
   */
  overlayResourceIds: string[];
  /**
   * The verified, parsed YAML of each packaged child pipeline, so the
   * installed pipeline's steps can be bound to the children they run and to
   * the children those run in turn.
   */
  overlayChildPipelines: Array<{ resourceId: string; pipeline: Pipeline }>;
}

export interface PlannedAutomation {
  resourceId: string;
  document: SharedContainerAutomationDefinitionDocument;
  /** SHA-256 of the canonical document: the subject content hash. */
  contentHash: string;
  pipelineResourceId?: string;
  agentResourceId?: string;
  skillResourceIds: string[];
}

export interface PlannedHook {
  resourceId: string;
  displayName: string;
  document: SharedContainerHookDefinitionDocument;
}

export interface SkippedPipeline {
  resourceId: string;
  displayName: string;
  reason: ForkPipelineSkipReason;
}

export interface SkippedAutomation {
  resourceId: string;
  displayName: string;
  reason: ForkAutomationSkipReason;
}

export interface ForkCapabilityInstallPlan {
  agents: PlannedAgent[];
  pipelines: PlannedPipeline[];
  skippedPipelines: SkippedPipeline[];
  automations: PlannedAutomation[];
  skippedAutomations: SkippedAutomation[];
  hooks: PlannedHook[];
  /** Standalone skills the container's own work used directly. */
  defaultSkillResourceIds: string[];
  /** Plugin members the skill materializer does not install. */
  pluginMemberLabels: string[];
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The resources the package binds to the container as a whole. */
export function subjectRootResourceIds(
  manifest: PipelinePackageManifestV1,
): string[] {
  const subject = manifest.bindings.find(
    (binding) =>
      capabilityPackageBindingKey(binding) ===
      CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
  );
  return subject
    ? [...subject.resourceIds].sort(compareCodeUnits)
    : manifest.resources.map((resource) => resource.id).sort(compareCodeUnits);
}

/** Every resource reachable from `ids` through dependency edges. */
function closureOf(
  ids: Iterable<string>,
  byId: ReadonlyMap<string, PipelinePackageResource>,
): Set<string> {
  const seen = new Set<string>();
  const pending = Array.from(ids);
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    const resource = byId.get(id);
    if (!resource) continue;
    seen.add(id);
    pending.push(...resource.dependencyResourceIds);
  }
  return seen;
}

/** The Agent a model id routes through, when it is a local Agent model. */
export function agentIdForModel(model: string | undefined): string | undefined {
  if (model === undefined || !model.startsWith(AGENT_MODEL_PREFIX))
    return undefined;
  const routed = parseAgentRouteModelId(model)?.agentId;
  if (routed) return routed;
  return isValidSharedAgentModelId(model) ? model : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace whole Agent model ids in `text`. An Agent id is `agent_model_` plus
 * lowercase words joined by underscores, so a match must not continue into
 * another identifier character on either side; `agent_model_review` never
 * rewrites part of `agent_model_review_2`.
 *
 * Every id is replaced in one pass over the original text. Local ids are
 * name-derived with `_2`, `_3` suffixes, so one source id's local copy can
 * equal another source id; a later replacement must never rewrite an earlier
 * one's output.
 */
export function rewriteAgentModelIds(
  text: string,
  agentIds: ReadonlyMap<string, string>,
): string {
  const sources = Array.from(agentIds.keys())
    .filter((source) => source.length > 0 && agentIds.get(source) !== source)
    // Longest first, so an alternation never settles on a shorter prefix.
    .sort(
      (left, right) =>
        right.length - left.length || compareCodeUnits(left, right),
    );
  if (sources.length === 0) return text;
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_])(?:${sources.map(escapeRegExp).join('|')})(?![A-Za-z0-9_])`,
    'g',
  );
  return text.replace(pattern, (match) => agentIds.get(match) ?? match);
}

const AGENT_MODEL_REFERENCE = new RegExp(
  `(?<![A-Za-z0-9_])${escapeRegExp(AGENT_MODEL_PREFIX)}[A-Za-z0-9]`,
);

/**
 * Whether pipeline or action text names any Agent model id. Deliberately
 * conservative: any `agent_model_` identifier counts, wherever it appears,
 * because text that travels verbatim can't have its ids rewritten.
 */
export function textReferencesAgentModel(text: string): boolean {
  return AGENT_MODEL_REFERENCE.test(text);
}

/** A bare skill invocation, `/name` or `$name`: never a plugin-namespaced one. */
const BARE_SKILL_INVOCATION = /^([/$])([A-Za-z0-9._-]+)$/;

/**
 * How each packaged standalone skill among `resourceIds` is invoked here: its
 * packaged `/name` or `$name` invocation, mapped to the same form of the local
 * name it was installed under. Plugin-namespaced invocations, and skills that
 * were not installed, are not mapped. An invocation two installed skills
 * would map differently is left out, so it is never guessed.
 */
export function skillInvocationRenames(
  resources: readonly PipelinePackageResource[],
  resourceIds: readonly string[],
  localNameByResource: ReadonlyMap<string, string>,
): Map<string, string> {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const renames = new Map<string, string>();
  const conflicting = new Set<string>();
  for (const id of resourceIds) {
    const resource = byId.get(id);
    const localName = localNameByResource.get(id);
    if (resource?.kind !== 'standalone_skill' || localName === undefined)
      continue;
    for (const key of resource.invocationKeys) {
      const sigil = BARE_SKILL_INVOCATION.exec(key)?.[1];
      if (sigil === undefined) continue;
      const local = `${sigil}${localName}`;
      const known = renames.get(key);
      if (known !== undefined && known !== local) conflicting.add(key);
      renames.set(key, local);
    }
  }
  for (const key of Array.from(conflicting)) renames.delete(key);
  return renames;
}

/**
 * Replace whole skill invocations in `text`, as the package analyzer reads
 * them (`extractInvocationTokens`): `/helper` in "Run /helper." or
 * "/helper: go", never inside `/helper-2`, `/helper.md`, `/helper:sub`,
 * `$helper_x`, a path such as `./helper` or `docs/helper/`, or a URL.
 *
 * Every invocation is replaced in one pass over the original text, so a
 * local name that equals another packaged name is never rewritten twice.
 */
export function rewriteSkillInvocations(
  text: string,
  renames: ReadonlyMap<string, string>,
): string {
  const pattern = skillInvocationPattern(renames);
  if (!pattern) return text;
  return text.replace(pattern, (match) => renames.get(match) ?? match);
}

/**
 * {@link rewriteSkillInvocations} for a prompt that carries configured
 * references. References are offset-addressed, so every reference after a
 * rename shifts by its length change. An invocation inside a reference span
 * is left alone: the reference carries its own identity.
 */
export function rewriteSkillInvocationsInPrompt<
  TReference extends { textStart: number; displayText: string },
>(
  prompt: string,
  references: readonly TReference[] | undefined,
  renames: ReadonlyMap<string, string>,
): { prompt: string; references?: TReference[] } {
  const pattern = skillInvocationPattern(renames);
  const spans = (references ?? []).map((reference) => ({
    start: reference.textStart,
    end: reference.textStart + reference.displayText.length,
  }));
  const edits: Array<{ index: number; from: string; to: string }> = [];
  if (pattern) {
    for (const match of Array.from(prompt.matchAll(pattern))) {
      const index = match.index ?? 0;
      const to = renames.get(match[0]);
      if (to === undefined || to === match[0]) continue;
      const end = index + match[0].length;
      if (spans.some((span) => index < span.end && end > span.start)) continue;
      edits.push({ index, from: match[0], to });
    }
  }
  let rewritten = '';
  let cursor = 0;
  for (const edit of edits) {
    rewritten += prompt.slice(cursor, edit.index) + edit.to;
    cursor = edit.index + edit.from.length;
  }
  rewritten += prompt.slice(cursor);
  if (references === undefined) return { prompt: rewritten };
  return {
    prompt: rewritten,
    references: references.map((reference) => {
      const shift = edits
        .filter((edit) => edit.index < reference.textStart)
        .reduce((sum, edit) => sum + edit.to.length - edit.from.length, 0);
      return { ...reference, textStart: reference.textStart + shift };
    }),
  };
}

/**
 * Whole skill invocations among `renames`, as the package analyzer reads
 * them, or undefined when nothing would change. Longest first, so an
 * alternation never settles on a shorter prefix.
 */
function skillInvocationPattern(
  renames: ReadonlyMap<string, string>,
): RegExp | undefined {
  const sources = Array.from(renames.keys())
    .filter(
      (source) =>
        BARE_SKILL_INVOCATION.test(source) && renames.get(source) !== source,
    )
    .sort(
      (left, right) =>
        right.length - left.length || compareCodeUnits(left, right),
    );
  if (sources.length === 0) return undefined;
  const alternation = (sigil: string): string =>
    sources
      .filter((source) => source.startsWith(sigil))
      .map(escapeRegExp)
      .join('|');
  const slash = alternation('/');
  const dollar = alternation('$');
  const starts = [
    // A `/` right after a path or assignment character is a path, not an
    // invocation.
    ...(slash ? [`(?<![A-Za-z0-9_\\-/=.~])(?:${slash})`] : []),
    ...(dollar ? [`(?<![A-Za-z0-9_-])(?:${dollar})`] : []),
  ];
  return new RegExp(
    `(?:${starts.join('|')})(?![A-Za-z0-9_\\-/]|\\.+[A-Za-z0-9_\\-/]|:[A-Za-z0-9._-])`,
    'g',
  );
}

function isYamlPath(filePath: string): boolean {
  return /\.ya?ml$/i.test(filePath);
}

/**
 * Whether a child pipeline or action among `resourceIds` names an Agent in
 * any of its YAML files. Each file is verified against the manifest first.
 */
async function overlayReferencesAgentModel(
  resourceIds: readonly string[],
  byId: ReadonlyMap<string, PipelinePackageResource>,
  readDocument: (sha256: string) => Promise<Uint8Array>,
): Promise<boolean> {
  for (const id of resourceIds) {
    const resource = byId.get(id);
    if (
      resource?.kind !== 'child_pipeline' &&
      resource?.kind !== 'pipeline_action'
    )
      continue;
    for (const tree of resource.trees) {
      for (const entry of tree.entries) {
        if (!isYamlPath(entry.path)) continue;
        const bytes = await readDocument(entry.sha256);
        if (
          bytes.byteLength !== entry.size ||
          sha256Hex(bytes) !== entry.sha256
        ) {
          throw new ForkCapabilityPackageInvalidError(
            `${resource.displayName} failed verification`,
          );
        }
        if (textReferencesAgentModel(new TextDecoder().decode(bytes)))
          return true;
      }
    }
  }
  return false;
}

/**
 * The file a packaged child pipeline's ref names inside its tree, matched the
 * way the run-time resolver loads it: the ref as written, then with `.yaml`
 * and `.yml` when it has no extension.
 */
function childPipelineEntry(
  resource: PipelinePackageResource,
): PipelinePackageResource['trees'][number]['entries'][number] | undefined {
  const candidates = new Set(
    resource.invocationKeys.flatMap((ref) => {
      const normalized = path.posix.normalize(ref.trim());
      return path.posix.extname(normalized)
        ? [normalized]
        : [normalized, `${normalized}.yaml`, `${normalized}.yml`];
    }),
  );
  for (const tree of resource.trees) {
    const entry = tree.entries.find((candidate) =>
      candidates.has(candidate.path),
    );
    if (entry) return entry;
  }
  return undefined;
}

/**
 * Each packaged child pipeline among `resourceIds`, verified and parsed. A
 * child whose YAML does not parse binds nothing beneath it; running it fails
 * the same way it would have for the publisher.
 */
async function readOverlayChildPipelines(
  resourceIds: readonly string[],
  byId: ReadonlyMap<string, PipelinePackageResource>,
  readDocument: (sha256: string) => Promise<Uint8Array>,
): Promise<Array<{ resourceId: string; pipeline: Pipeline }>> {
  const children: Array<{ resourceId: string; pipeline: Pipeline }> = [];
  for (const id of resourceIds) {
    const resource = byId.get(id);
    if (resource?.kind !== 'child_pipeline') continue;
    const entry = childPipelineEntry(resource);
    if (!entry) continue;
    const bytes = await readDocument(entry.sha256);
    if (bytes.byteLength !== entry.size || sha256Hex(bytes) !== entry.sha256) {
      throw new ForkCapabilityPackageInvalidError(
        `${resource.displayName} failed verification`,
      );
    }
    try {
      children.push({
        resourceId: id,
        pipeline: parsePipelineText(new TextDecoder().decode(bytes)),
      });
    } catch {
      continue;
    }
  }
  return children;
}

function definitionDocumentEntry(resource: PipelinePackageResource): {
  sha256: string;
  size: number;
} {
  const tree = resource.trees.length === 1 ? resource.trees[0] : undefined;
  const entry = tree && tree.entries.length === 1 ? tree.entries[0] : undefined;
  if (
    !entry ||
    entry.path !== SHARED_CONTAINER_DEFINITION_DOCUMENT_PATH ||
    entry.mode !== 'read'
  ) {
    throw new ForkCapabilityPackageInvalidError(
      `${resource.displayName} has no single read-only definition document`,
    );
  }
  return { sha256: entry.sha256, size: entry.size };
}

function requireKind(
  byId: ReadonlyMap<string, PipelinePackageResource>,
  owner: PipelinePackageResource,
  referenceId: string,
  kind: SharedContainerDefinitionKind,
): void {
  const target = byId.get(referenceId);
  if (
    !target ||
    target.kind !== kind ||
    !owner.dependencyResourceIds.includes(referenceId)
  ) {
    throw new ForkCapabilityPackageInvalidError(
      `${owner.displayName} references a ${kind} that is not one of its packaged dependencies`,
    );
  }
}

/**
 * Validate the whole package and decide what installs where.
 *
 * `readDocument` returns a definition resource's verified document bytes;
 * this function re-checks their hash and size against the manifest so it
 * never trusts the caller's transport.
 */
export async function planForkCapabilityInstall(
  manifest: PipelinePackageManifestV1,
  readDocument: (sha256: string) => Promise<Uint8Array>,
  context: { containerType: SharedContainerType },
): Promise<ForkCapabilityInstallPlan> {
  const byId = new Map(
    manifest.resources.map((resource) => [resource.id, resource]),
  );
  const resources = [...manifest.resources].sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  );
  const documents = new Map<
    string,
    { bytes: Uint8Array; document: SharedContainerDefinitionDocument }
  >();
  for (const resource of resources) {
    if (!isSharedContainerDefinitionKind(resource.kind)) continue;
    const entry = definitionDocumentEntry(resource);
    const bytes = await readDocument(entry.sha256);
    if (bytes.byteLength !== entry.size || sha256Hex(bytes) !== entry.sha256) {
      throw new ForkCapabilityPackageInvalidError(
        `${resource.displayName} failed verification`,
      );
    }
    const parsed = parseSharedContainerDefinitionDocument(bytes);
    if (!parsed.ok) {
      throw new ForkCapabilityPackageInvalidError(
        `${resource.displayName}: ${parsed.errors.join('; ')}`,
      );
    }
    const document = parsed.value;
    if (document.kind !== resource.kind) {
      throw new ForkCapabilityPackageInvalidError(
        `${resource.displayName} carries a ${document.kind} document`,
      );
    }
    for (const reference of document.references) {
      if (!resource.dependencyResourceIds.includes(reference)) {
        throw new ForkCapabilityPackageInvalidError(
          `${resource.displayName} references a resource that is not one of its packaged dependencies`,
        );
      }
    }
    documents.set(resource.id, { bytes, document });
  }

  const skillsIn = (resource: PipelinePackageResource): string[] =>
    Array.from(closureOf(resource.dependencyResourceIds, byId))
      .filter((id) => byId.get(id)?.kind === 'standalone_skill')
      .sort(compareCodeUnits);

  // Each pipeline's overlay, and whether anything in it routes through an
  // Agent, before any automation that runs the pipeline is planned.
  const overlays = new Map<
    string,
    { resourceIds: string[]; routesThroughAgent: boolean }
  >();
  for (const resource of resources) {
    if (documents.get(resource.id)?.document.kind !== 'pipeline_definition')
      continue;
    // The standalone skills the definition itself uses travel in the overlay
    // too, so each step that invokes one is bound to the packaged copy under
    // its packaged name. An Agent's skills are not among them: a step routed
    // through an Agent gets those through the local Agent's selections.
    const overlayRoots = [
      ...Array.from(closureOf(resource.dependencyResourceIds, byId)).filter(
        (id) => {
          const kind = byId.get(id)?.kind;
          return kind === 'child_pipeline' || kind === 'pipeline_action';
        },
      ),
      ...resource.dependencyResourceIds.filter(
        (id) => byId.get(id)?.kind === 'standalone_skill',
      ),
    ];
    const resourceIds = Array.from(closureOf(overlayRoots, byId))
      .filter((id) => {
        const kind = byId.get(id)?.kind;
        return kind !== undefined && !isSharedContainerDefinitionKind(kind);
      })
      .sort(compareCodeUnits);
    overlays.set(resource.id, {
      resourceIds,
      routesThroughAgent: await overlayReferencesAgentModel(
        resourceIds,
        byId,
        readDocument,
      ),
    });
  }

  const plan: ForkCapabilityInstallPlan = {
    agents: [],
    pipelines: [],
    skippedPipelines: [],
    automations: [],
    skippedAutomations: [],
    hooks: [],
    defaultSkillResourceIds: [],
    pluginMemberLabels: [],
  };
  const isCode = context.containerType === 'CODE_WORKTREE';

  for (const resource of resources) {
    const entry = documents.get(resource.id);
    if (!entry) continue;
    const document = entry.document;
    switch (document.kind) {
      case 'agent_definition':
        plan.agents.push({
          resourceId: resource.id,
          document,
          skillResourceIds: skillsIn(resource),
        });
        break;
      case 'pipeline_definition': {
        try {
          parsePipelineText(document.yaml);
        } catch (error) {
          throw new ForkCapabilityPackageInvalidError(
            `${resource.displayName}: ${
              error instanceof Error ? error.message : 'invalid pipeline YAML'
            }`,
          );
        }
        for (const reference of document.references)
          requireKind(byId, resource, reference, 'agent_definition');
        const overlay = overlays.get(resource.id);
        if (overlay?.routesThroughAgent) {
          plan.skippedPipelines.push({
            resourceId: resource.id,
            displayName: document.name,
            reason: 'child-agent-routing',
          });
          break;
        }
        const overlayResourceIds = overlay?.resourceIds ?? [];
        plan.pipelines.push({
          resourceId: resource.id,
          document,
          agentResourceIds: [...document.references].sort(compareCodeUnits),
          overlayResourceIds,
          overlayChildPipelines: await readOverlayChildPipelines(
            overlayResourceIds,
            byId,
            readDocument,
          ),
        });
        break;
      }
      case 'automation_definition': {
        const uses = document.uses ?? {};
        if (uses.pipeline !== undefined)
          requireKind(byId, resource, uses.pipeline, 'pipeline_definition');
        if (uses.agent !== undefined)
          requireKind(byId, resource, uses.agent, 'agent_definition');
        const skip =
          automationSkipReason(document, isCode) ??
          (uses.pipeline !== undefined &&
          overlays.get(uses.pipeline)?.routesThroughAgent === true
            ? 'pipeline-skipped'
            : undefined);
        if (skip) {
          plan.skippedAutomations.push({
            resourceId: resource.id,
            displayName: document.automation.name,
            reason: skip,
          });
          break;
        }
        plan.automations.push({
          resourceId: resource.id,
          document,
          contentHash: sha256Hex(entry.bytes),
          ...(uses.pipeline !== undefined
            ? { pipelineResourceId: uses.pipeline }
            : {}),
          ...(uses.agent !== undefined ? { agentResourceId: uses.agent } : {}),
          skillResourceIds: skillsIn(resource),
        });
        break;
      }
      case 'hook_definition':
        for (const action of document.actions) {
          if (action.type === 'chat' && action.agent !== undefined)
            requireKind(byId, resource, action.agent, 'agent_definition');
          if (
            action.type === 'pipeline' &&
            action.pipeline.source === 'packaged'
          )
            requireKind(
              byId,
              resource,
              action.pipeline.resourceId,
              'pipeline_definition',
            );
        }
        plan.hooks.push({
          resourceId: resource.id,
          displayName: resource.displayName,
          document,
        });
        break;
    }
  }

  const roots = subjectRootResourceIds(manifest);
  for (const id of roots) {
    const resource = byId.get(id);
    if (resource?.kind === 'standalone_skill')
      plan.defaultSkillResourceIds.push(id);
  }
  const labels = new Set<string>();
  for (const id of Array.from(closureOf(roots, byId))) {
    const resource = byId.get(id);
    if (
      resource?.kind === 'plugin_skill' ||
      resource?.kind === 'plugin_command' ||
      resource?.kind === 'plugin_agent'
    )
      labels.add(resource.displayName);
  }
  plan.pluginMemberLabels = Array.from(labels).sort(compareCodeUnits);
  return plan;
}

function automationSkipReason(
  document: SharedContainerAutomationDefinitionDocument,
  isCode: boolean,
): ForkAutomationSkipReason | undefined {
  const action = document.automation.action;
  switch (action.type) {
    case 'worktree_prompt':
      if (!isCode) return 'incompatible-target';
      break;
    case 'standalone_prompt':
      if (isCode) return 'incompatible-target';
      break;
    case 'worktree_pipeline':
      if (!isCode) return 'incompatible-target';
      if (action.pipeline.source === 'unresolved') {
        if (document.uses?.pipeline === undefined)
          return 'pipeline-unavailable';
      } else if (action.pipeline.source !== 'bundled') {
        // A curated, inline or shared pipeline has its own install review;
        // the container package does not stand in for it.
        return 'pipeline-unavailable';
      }
      break;
    case 'app_advisor_prompt':
      return 'incompatible-target';
  }
  if (action.type !== 'worktree_pipeline') {
    const model = action.modelConfig?.model;
    const agentId = agentIdForModel(model);
    if (
      (agentId !== undefined || model?.startsWith(AGENT_MODEL_PREFIX)) &&
      document.uses?.agent === undefined
    )
      return 'agent-unavailable';
  }
  return undefined;
}

/**
 * The packaged resource a step runs directly, matched the way the publisher
 * discovered it (`buildPortablePipelineResources`) and the run-time resolvers
 * find it: a project action by its `uses` ref, a child pipeline by its
 * `with.pipeline` ref.
 */
function packagedResourceForStep(
  step: Pick<Step, 'uses' | 'with'>,
  resources: readonly PipelinePackageResource[],
): PipelinePackageResource | undefined {
  const uses = step.uses;
  if (uses?.startsWith('project/'))
    return resources.find(
      (resource) =>
        resource.kind === 'pipeline_action' &&
        resource.invocationKeys.includes(uses),
    );
  if (uses !== 'builtin/run-pipeline') return undefined;
  const ref = step.with?.pipeline;
  const childRef = typeof ref === 'string' ? ref.trim() : '';
  if (!childRef) return undefined;
  return resources.find(
    (resource) =>
      resource.kind === 'child_pipeline' &&
      resource.invocationKeys.includes(childRef),
  );
}

function mergeEnvironmentRequirements(
  requirements: readonly PipelinePackageEnvironmentRequirement[],
): PipelinePackageEnvironmentRequirement[] {
  const merged = new Map<string, PipelinePackageEnvironmentRequirement>();
  for (const requirement of requirements) {
    const existing = merged.get(requirement.id);
    if (!existing) {
      merged.set(requirement.id, {
        ...requirement,
        affectedSteps: [...requirement.affectedSteps],
      });
      continue;
    }
    existing.required = existing.required || requirement.required;
    for (const step of requirement.affectedSteps) {
      if (
        !existing.affectedSteps.some(
          (known) => known.jobId === step.jobId && known.stepId === step.stepId,
        )
      )
        existing.affectedSteps.push({ ...step });
    }
  }
  return Array.from(merged.values()).sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  );
}

/** The provider each step of a pipeline runs under, as the publisher read it. */
export type ResolvePipelineStepProviders = (
  pipeline: Pipeline,
) => Record<string, PipelinePackageStepProviders>;

interface PackagedSkillUse {
  /** Packaged skills each step invokes or depends on, by step binding key. */
  byStep: Map<string, Set<string>>;
  /** Steps with a skill or plugin dependency no packaged skill matched. */
  unmatchedDependencySteps: Set<string>;
}

/** Whether `resource` is a skill packaged for `provider` and invoked as `invocation`. */
function packagedSkillAnswers(
  resource: PipelinePackageResource,
  provider: 'claude' | 'codex',
  invocation: string,
): boolean {
  return (
    resource.invocationKeys.includes(invocation) &&
    resource.trees.some((tree) => tree.provider === provider)
  );
}

/**
 * The packaged skills a pipeline's steps use, read the way the publisher's
 * analyzer read them (`buildPipelineCapabilityPackageSources`): invocation
 * tokens in each step's prompt text under that step's provider, and the
 * steps' declared skill and plugin dependencies.
 */
function packagedSkillUse(
  pipeline: Pipeline,
  providers: Record<string, PipelinePackageStepProviders>,
  skills: readonly PipelinePackageResource[],
): PackagedSkillUse {
  const sources = buildPipelineCapabilityPackageSources(pipeline, providers);
  const byStep = new Map<string, Set<string>>();
  const bind = (stepKey: string, id: string): void => {
    const ids = byStep.get(stepKey) ?? new Set<string>();
    ids.add(id);
    byStep.set(stepKey, ids);
  };
  for (const source of sources.promptSources) {
    if ('target' in source) continue;
    const stepKey = capabilityPackageStepBindingKey(
      source.jobId,
      source.stepId,
    );
    for (const token of extractInvocationTokens(source.text)) {
      if (isExplicitPathInvocationToken(token)) continue;
      // A `$` token is a Codex invocation whatever the step's provider.
      const provider = token.value.startsWith('$') ? 'codex' : source.provider;
      for (const skill of skills) {
        if (packagedSkillAnswers(skill, provider, token.value))
          bind(stepKey, skill.id);
      }
    }
  }
  const unmatchedDependencySteps = new Set<string>();
  for (const request of sources.requests) {
    // A dependency names its skill by selection key; the package keeps the
    // publisher's selection identity as the resource's installed item.
    const matched = skills.filter(
      (skill) =>
        skill.installedItemRef?.kind === 'skill' &&
        `skill:${skill.installedItemRef.sourceId}:${skill.installedItemRef.skillName}`.toLowerCase() ===
          request.key.toLowerCase() &&
        skill.trees.some((tree) => tree.provider === request.provider),
    );
    if (matched.length === 0) unmatchedDependencySteps.add(request.bindingKey);
    for (const skill of matched) bind(request.bindingKey, skill.id);
  }
  return { byStep, unmatchedDependencySteps };
}

/**
 * A package for one installed pipeline, derived from the verified container
 * package: the child pipelines, actions and standalone skills its definition
 * carries, with the same files and hashes, bound to the pipeline's own YAML.
 * `undefined` when the definition carries none.
 *
 * Resources are bound per step, as a shared pipeline package binds them:
 * the run-time overlay gives each step only its own binding. A step that
 * runs a packaged child pipeline or project action is bound to it, its
 * dependencies and, for a child pipeline, everything the child runs in turn,
 * because a child run inherits its parent step's overlay. A packaged child's
 * declared requirements are located at that parent step.
 *
 * A step is also bound to each packaged skill it invokes or depends on, and
 * that skill's dependencies; a step that runs a packaged child is bound to
 * the skills the child's steps use. The run-time overlay then supplies the
 * packaged skill under its packaged name, so the step runs it even when the
 * recipient's own skill of that name made the installed copy take a
 * suffixed name. A skill the definition carries that no prompt names comes
 * from a dependency whose catalog identity is not in the package, so it is
 * bound to every step with a dependency that matched no packaged skill.
 */
export function deriveInstalledPipelineManifest(
  manifest: PipelinePackageManifestV1,
  overlay: Pick<
    PlannedPipeline,
    'overlayResourceIds' | 'overlayChildPipelines'
  >,
  installed: { pipeline: Pipeline; contentHash: string },
  resolveStepProviders: ResolvePipelineStepProviders,
): PipelinePackageManifestV1 | undefined {
  if (overlay.overlayResourceIds.length === 0) return undefined;
  const included = new Set(overlay.overlayResourceIds);
  const resources = manifest.resources
    .filter((resource) => included.has(resource.id))
    .map(
      (resource): PipelinePackageResource => ({
        ...resource,
        dependencyResourceIds: resource.dependencyResourceIds.filter((id) =>
          included.has(id),
        ),
      }),
    )
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const childPipelines = new Map(
    overlay.overlayChildPipelines.map((child) => [
      child.resourceId,
      child.pipeline,
    ]),
  );

  const skills = resources.filter(
    (resource) => resource.kind === 'standalone_skill',
  );
  const skillUses = new Map<Pipeline, PackagedSkillUse>();
  const skillUseOf = (pipeline: Pipeline): PackagedSkillUse => {
    let use = skillUses.get(pipeline);
    if (!use) {
      use = packagedSkillUse(pipeline, resolveStepProviders(pipeline), skills);
      skillUses.set(pipeline, use);
    }
    return use;
  };
  const installedUse = skillUseOf(installed.pipeline);
  const namedRoots: string[] = [];
  for (const use of [
    installedUse,
    ...overlay.overlayChildPipelines.map((child) => skillUseOf(child.pipeline)),
  ]) {
    for (const ids of Array.from(use.byStep.values()))
      namedRoots.push(...Array.from(ids));
  }
  // A named skill's dependencies, and a child's or action's, are bound with it.
  const named = closureOf(
    [
      ...namedRoots,
      ...resources
        .filter((resource) => resource.kind !== 'standalone_skill')
        .map((resource) => resource.id),
    ],
    byId,
  );
  const unnamedSkillIds = skills
    .filter((skill) => !named.has(skill.id))
    .map((skill) => skill.id);
  /** Skills a step of `use` binds: all of them when `stepKey` is omitted. */
  const skillsUsed = (use: PackagedSkillUse, stepKey?: string): string[] => {
    const ids =
      stepKey === undefined
        ? Array.from(use.byStep.values()).flatMap((set) => Array.from(set))
        : Array.from(use.byStep.get(stepKey) ?? []);
    const unmatched =
      stepKey === undefined
        ? use.unmatchedDependencySteps.size > 0
        : use.unmatchedDependencySteps.has(stepKey);
    return unmatched ? [...ids, ...unnamedSkillIds] : ids;
  };

  const bindings: PipelinePackageBinding[] = [];
  const requirements: PipelinePackageEnvironmentRequirement[] = [];
  for (const [jobId, job] of Object.entries(installed.pipeline.jobs)) {
    for (const step of assignStepIds(job.steps, jobId)) {
      const target = packagedResourceForStep(step, resources);
      const pending = [
        ...(target ? [target.id] : []),
        ...skillsUsed(
          installedUse,
          capabilityPackageStepBindingKey(jobId, step.id),
        ),
      ];
      if (pending.length === 0) continue;
      const bound = new Set<string>();
      while (pending.length > 0) {
        const id = pending.pop();
        if (id === undefined || bound.has(id)) continue;
        const resource = byId.get(id);
        if (!resource) continue;
        bound.add(id);
        pending.push(...resource.dependencyResourceIds);
        const child = childPipelines.get(id);
        if (!child) continue;
        // A child run inherits this step's overlay, skills included.
        pending.push(...skillsUsed(skillUseOf(child)));
        for (const requirement of buildPipelineCapabilityPackageSources(
          child,
          {},
        ).environmentRequirements) {
          requirements.push({
            ...requirement,
            affectedSteps: [{ jobId, stepId: step.id }],
          });
        }
        for (const childJob of Object.values(child.jobs)) {
          for (const childStep of childJob.steps) {
            const nested = packagedResourceForStep(childStep, resources);
            if (nested) pending.push(nested.id);
          }
        }
      }
      bindings.push({
        jobId,
        stepId: step.id,
        resourceIds: Array.from(bound).sort(compareCodeUnits),
      });
    }
  }

  let totalFiles = 0;
  let totalBytes = 0;
  for (const resource of resources) {
    for (const tree of resource.trees) {
      for (const entry of tree.entries) {
        totalFiles += 1;
        totalBytes += entry.size;
      }
    }
  }
  return {
    version: 1,
    pipelineContentHash: installed.contentHash,
    resources,
    bindings,
    environmentRequirements: mergeEnvironmentRequirements(requirements),
    totalFiles,
    totalBytes,
  };
}
