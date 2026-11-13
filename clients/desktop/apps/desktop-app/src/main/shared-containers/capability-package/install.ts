/**
 * Install a fork's capability package (CAN-4655, plan §6 "Fork installation
 * and its disclosure").
 *
 * Runs after `core.sharedContainer.fork` has committed through
 * `runW5BoundaryOperation`, never inside its composition or rollback: the
 * copy exists whatever happens here. Every failure becomes a sentence in the
 * fork response's existing `warnings`; nothing here changes or undoes the
 * fork.
 *
 * Consent is the disclosure the recipient confirmed. The renderer sends the
 * digest it showed for the frozen revision, and this module installs only
 * that digest for that revision, through the authenticated, revision-pinned
 * package routes. It never falls back to the latest revision.
 *
 * Order, after every document, reference and destination mapping has been
 * validated (`install-plan.ts`):
 *
 *  1. Skills through the shared materializer (`installSubjectCapabilityPackage`),
 *     which also caches the verified package and finally writes the
 *     `shared-container` install-ledger row. Steps 2–5 run inside its
 *     finalization, so a failure anywhere unwinds through one boundary.
 *  2. Local Agents, then user pipelines: deduplicated names, Agent ids
 *     rewritten to the local copies, an Agent's skill invocations rewritten
 *     to the local skill names, and a pipeline's child pipelines, actions
 *     and skills kept in a verified overlay derived from the container
 *     package and bound to the steps that use them.
 *  3. Automations, always turned off, retargeted at the fork, chat ids gone,
 *     pipelines and Agents remapped. One that cannot target this fork is
 *     skipped with a warning.
 *  4. Hooks are never installed (see {@link HOOKS_OMITTED_WARNING}).
 *  5. Directly used skills are merged into the destination's default
 *     selections through `core.workspace.plugins.update`, keeping every
 *     existing selection. Environment requirements stay informational.
 *
 * Each object is named in the attempt journal before it is created (a skill
 * folder as soon as the materializer reserves it), so a crash leaves enough to
 * finish (the ledger row exists) or compensate on the next attempt.
 * Compensation removes only what this attempt created and the user has not
 * changed since; a skill folder the materializer reused is never removed.
 *
 * Recovery of interrupted attempts runs as one shared pass per process. Each
 * journal it reconciles is claimed for the duration, an attempt for the same
 * fork waits for that claim within its own deadline, and recovery never
 * writes over a journal another attempt has since written.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PipelinePackageManifestV1 } from '@canopy/protocol/pipelines';
import type {
  SharedContainerForkRequest,
  SharedContainerForkResponse,
  SharedContainerRevisionPackage,
} from '@canopy/protocol/shared-containers';
import type { ShareablePluginRef } from '@canopy/protocol/plugins';
import type { SharedAutomationDocument } from '@canopy/protocol/automations';
import { computePipelinePackageDigestSync } from '@canopy/desktop-shared/node';
import { hashPipelinePackageYaml } from '@canopy/desktop-shared/node';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import { buildInstallAutomationRequest } from '@canopy/desktop-shared/lib/automation-install';
import type {
  AutomationAction,
  AutomationCreateRequest,
  AutomationMutationResponse,
  ChatTabPluginSelections,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type {
  AgentModelDefinition,
  SaveAgentModelRequest,
} from '@canopy/execution-engine/types/agent-models';
import type {
  CapabilityPackageInstallOwner,
  CapabilityPackageInstallRecordV1,
  Pipeline,
} from '@canopy/execution-engine/types/pipeline';
import type { PipelinePackageDownload } from '../../pipelines/canopy-server-client';
import type {
  InstallSubjectCapabilityPackageRequest,
  InstallSubjectCapabilityPackageResult,
} from '../../skills/skill-package-install';
import { CanopyCloudClientError } from '../../canopy-cloud/client';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import {
  deleteForkCapabilityInstallJournal,
  FORK_CAPABILITY_INSTALL_RESIDUAL_RETENTION_MS,
  forkCapabilityInstallJournalKey,
  forkCapabilityInstallResidualJournalKey,
  listForkCapabilityInstallJournals,
  readForkCapabilityInstallJournal,
  writeForkCapabilityInstallJournal,
  type ForkCapabilityInstallJournal,
  type ForkCapabilityInstallSkillFile,
  type ForkCapabilityInstallSkillSelection,
} from './install-journal';
import {
  agentIdForModel,
  deriveInstalledPipelineManifest,
  ForkCapabilityPackageInvalidError,
  planForkCapabilityInstall,
  rewriteAgentModelIds,
  rewriteSkillInvocations,
  rewriteSkillInvocationsInPrompt,
  skillInvocationRenames,
  type ForkAutomationSkipReason,
  type ForkCapabilityInstallPlan,
  type PlannedAutomation,
} from './install-plan';

// ---------------------------------------------------------------------------
// Warnings: plain sentences appended to the fork response's `warnings`.
// ---------------------------------------------------------------------------

export const UNDISCLOSED_PACKAGE_WARNING =
  "Capabilities from this share weren't installed because they weren't shown when you made the copy.";
export const CHANGED_PACKAGE_WARNING =
  "Capabilities from this share weren't installed because the share changed after you reviewed it.";
export const UNAVAILABLE_PACKAGE_WARNING =
  "Capabilities from this share weren't installed because the shared version is no longer available.";
export const INVALID_PACKAGE_WARNING =
  "Capabilities from this share weren't installed because they couldn't be verified.";
export const TIMED_OUT_PACKAGE_WARNING =
  "Capabilities from this share weren't installed because installing them took too long.";
/**
 * The copy itself is already made when the install is cancelled, so the
 * recipient still needs to know its capabilities are missing.
 */
export const CANCELLED_PACKAGE_WARNING =
  "Capabilities from this share weren't installed because installing them was cancelled.";
export const FAILED_PACKAGE_WARNING =
  "Capabilities from this share couldn't be installed. Nothing from them was kept.";
/**
 * Hook pause state is per worktree (`core.worktree.hooks.setPaused`), a new
 * worktree starts with nothing paused, and hook configuration and pause state
 * are separate writes. No existing store can make an imported hook paused in
 * every current and future worktree before it becomes visible, so hooks are
 * omitted rather than added active.
 */
export const HOOKS_OMITTED_WARNING =
  "Hooks from this share weren't added because they can't start paused in every worktree yet.";

export function residualWarning(residual: readonly string[]): string {
  return `Some items from a failed capability install are still here: ${residual.join(', ')}.`;
}

function automationSkippedWarning(name: string, reason: string): string {
  const because =
    reason === 'incompatible-target'
      ? "it runs somewhere this copy doesn't include"
      : reason === 'pipeline-unavailable'
        ? "the share doesn't include the pipeline it runs"
        : reason === 'agent-unavailable'
          ? "the share doesn't include the Agent it uses"
          : reason === 'pipeline-skipped'
            ? "the pipeline it runs wasn't added"
            : reason;
  return `Automation "${name}" wasn't added because ${because}.`;
}

/**
 * The run-condition command never travels with a share; the document only
 * says one existed. The automation installs turned off, so name the gap before
 * the recipient turns it on and it runs on every tick.
 */
function runConditionOmittedWarning(name: string): string {
  return `Automation "${name}" had a run condition that didn't come with the copy. Add one before you turn it on.`;
}

function pipelineSkippedWarning(name: string): string {
  return `Pipeline "${name}" wasn't added because a pipeline or action it runs uses an Agent that copies can't include yet.`;
}

function pluginMembersWarning(labels: readonly string[]): string {
  return `Plugin items from this share weren't installed: ${labels.join(', ')}.`;
}

function unmatchedRefsWarning(refs: readonly string[]): string {
  return `Some skills and plugins this share uses aren't on this device: ${refs.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface PinnedPackageRequest {
  containerId: string;
  revisionId: string;
  organizationId: string | undefined;
  digest: string;
}

export interface ForkCapabilityInstallDependencies {
  /** Wall-clock budget for the whole attempt, download included. */
  timeoutMs: number;
  now(): Date;
  randomId(): string;
  log(message: string, detail?: unknown): void;
  /** Package metadata the local replica holds for exactly this revision. */
  readReplicaPackage(
    containerId: string,
    revisionId: string,
  ): Promise<SharedContainerRevisionPackage | undefined>;
  getPackage(
    request: PinnedPackageRequest,
    signal: AbortSignal,
  ): Promise<PipelinePackageDownload>;
  getBlob(
    request: PinnedPackageRequest,
    sha256: string,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
  installSubjectPackage(
    request: InstallSubjectCapabilityPackageRequest,
  ): Promise<InstallSubjectCapabilityPackageResult>;
  findLedgerInstall(
    owner: CapabilityPackageInstallOwner,
  ): Promise<CapabilityPackageInstallRecordV1 | null>;
  resolvePortablePlugins(refs: readonly ShareablePluginRef[]): Promise<{
    selections: ChatTabPluginSelections;
    unmatched: string[];
  }>;
  listAgents(): Promise<AgentModelDefinition[]>;
  createAgent(request: SaveAgentModelRequest): Promise<AgentModelDefinition>;
  /** Removes the Agent only while its content still matches `contentHash`. */
  removeAgent(id: string, contentHash: string): Promise<void>;
  listPipelineNames(): Promise<string[]>;
  /** Scopes of a bundled pipeline, or undefined when it is not available. */
  readBundledPipelineScopes(pipelineId: string): Promise<unknown>;
  createPipeline(input: {
    localPipelineId: string;
    name: string;
    description?: string;
    rawPipeline: string;
    overlay?: {
      digest: string;
      manifest: PipelinePackageManifestV1;
      sourcePackageDigest: string;
    };
  }): Promise<{ localPipelineId: string; contentHash: string }>;
  removePipeline(
    localPipelineId: string,
    expectedContentHash: string,
  ): Promise<'removed' | 'kept' | 'missing'>;
  listAutomations(): Promise<ScheduledActivity[]>;
  createAutomation(
    request: AutomationCreateRequest,
  ): Promise<AutomationMutationResponse>;
  deleteAutomation(id: string): Promise<AutomationMutationResponse>;
  /** Repository ids and current default skill selections of the destination. */
  readDestination(projectId: string): Promise<{
    repoIds: string[];
    defaultSkills: ForkCapabilityInstallSkillSelection[];
  }>;
  /** Add skills to the destination's defaults, keeping every existing one. */
  addDefaultSkills(
    workspaceId: string,
    skills: readonly ForkCapabilityInstallSkillSelection[],
  ): Promise<void>;
  /** Remove exactly these skills from the destination's current defaults. */
  removeDefaultSkills(
    workspaceId: string,
    skills: readonly ForkCapabilityInstallSkillSelection[],
  ): Promise<void>;
  /**
   * Removes a skill folder only while it holds nothing but these packaged
   * files; `kept` when anything in it differs.
   */
  removeSkillFolder(
    localName: string,
    files: readonly ForkCapabilityInstallSkillFile[],
  ): Promise<'removed' | 'kept' | 'missing'>;
  readJournal(key: string): Promise<ForkCapabilityInstallJournal | null>;
  writeJournal(journal: ForkCapabilityInstallJournal): Promise<void>;
  deleteJournal(key: string): Promise<void>;
  listJournals(): Promise<ForkCapabilityInstallJournal[]>;
}

/** Large enough for a full 32 MiB package on a slow link; never unbounded. */
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_NAME_SUFFIX = 100;

const defaultDependencies: ForkCapabilityInstallDependencies = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  now: () => new Date(),
  randomId: () => randomUUID(),
  log: (message, detail) => logMainProcessWarn(message, detail),
  readReplicaPackage: async (containerId, revisionId) => {
    const { getSharedContainerReader } = await import('../read/reader');
    const state = await getSharedContainerReader().store.get(containerId);
    if (
      !state ||
      (state.status !== 'available' && state.status !== 'pinned') ||
      state.revisionId !== revisionId
    )
      return undefined;
    return state.package;
  },
  getPackage: (request, signal) =>
    pinnedRead(signal, async () => {
      const { getSharedContainerRevisionPackage } =
        await import('../canopy-server-client');
      return getSharedContainerRevisionPackage(
        request.containerId,
        request.revisionId,
        request.organizationId,
        request.digest,
        signal,
      );
    }),
  getBlob: (request, sha256, signal) =>
    pinnedRead(signal, async () => {
      const { getSharedContainerRevisionPackageBlob } =
        await import('../canopy-server-client');
      return getSharedContainerRevisionPackageBlob(
        request.containerId,
        request.revisionId,
        request.organizationId,
        request.digest,
        sha256,
        signal,
      );
    }),
  installSubjectPackage: async (request) => {
    const { installSubjectCapabilityPackage } =
      await import('../../skills/skill-package-install');
    return installSubjectCapabilityPackage(request);
  },
  findLedgerInstall: async (owner) => {
    const [
      { findCapabilityPackageInstallByOwner },
      { getPipelinePackageInstallStorePath },
    ] = await Promise.all([
      import('../../pipelines/pipeline-package-install-store'),
      import('../../lib/paths'),
    ]);
    return findCapabilityPackageInstallByOwner(
      getPipelinePackageInstallStorePath(),
      owner,
    );
  },
  resolvePortablePlugins: async (refs) => {
    const selections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
    };
    if (refs.length === 0) return { selections, unmatched: [] };
    const [
      { loadShareablePluginCatalog, resolveShareablePluginRefs },
      { getShareablePluginRefKey },
    ] = await Promise.all([
      import('../../plugins/shareable-plugin-resolution'),
      import('@canopy/protocol/plugins'),
    ]);
    const matches = resolveShareablePluginRefs(
      refs,
      await loadShareablePluginCatalog(),
    );
    const unmatched: string[] = [];
    for (const match of matches) {
      if (match.matchState === 'unmatched') {
        unmatched.push(getShareablePluginRefKey(match.ref));
      } else if (match.selection.kind === 'skill') {
        selections.skillRefs.push({
          sourceId: match.selection.sourceId,
          skillName: match.selection.skillName,
        });
      } else {
        selections.pluginRefs.push({
          marketplaceId: match.selection.marketplaceId,
          pluginName: match.selection.pluginName,
        });
      }
    }
    return { selections, unmatched };
  },
  listAgents: async () => {
    const { listAgentModels } = await import('../../agents/agent-model-store');
    return listAgentModels();
  },
  createAgent: async (request) => {
    const { saveAgentModel } = await import('../../agents/agent-model-store');
    return saveAgentModel(request);
  },
  removeAgent: async (id, contentHash) => {
    const { deleteAgentModel } = await import('../../agents/agent-model-store');
    await deleteAgentModel(id, undefined, contentHash);
  },
  listPipelineNames: async () => {
    const { listPipelines } = await import('../../pipelines/pipeline-service');
    const listed = listPipelines();
    return listed.success && listed.data
      ? listed.data.map((pipeline) => pipeline.name)
      : [];
  },
  readBundledPipelineScopes: async (pipelineId) => {
    const { getPipeline } = await import('../../pipelines/pipeline-service');
    const pipeline = getPipeline(pipelineId);
    return pipeline.success && pipeline.data
      ? pipeline.data.content.scope
      : undefined;
  },
  createPipeline: async (input) => {
    const { createContainerInstalledPipeline } =
      await import('../../pipelines/pipeline-package-service');
    return createContainerInstalledPipeline(input);
  },
  removePipeline: async (localPipelineId, expectedContentHash) => {
    const { removeContainerInstalledPipeline } =
      await import('../../pipelines/pipeline-package-service');
    return removeContainerInstalledPipeline(
      localPipelineId,
      expectedContentHash,
    );
  },
  listAutomations: async () => {
    const { getAutomationsService } = await import('../../automations/service');
    return (await getAutomationsService().list()).activities;
  },
  // A person's create, as the edit form saves it: while the chat automation
  // pipelines experiment is on, a chat automation converts to a pipeline it
  // owns, and one that can't keeps its native save (CAN-5479).
  createAutomation: async (request) => {
    const { createAutomationFromForm } =
      await import('../../automations/chat-automation-save');
    return createAutomationFromForm(request);
  },
  deleteAutomation: async (id) => {
    const { getAutomationsService } = await import('../../automations/service');
    return getAutomationsService().delete({ id });
  },
  readDestination: async (projectId) => {
    const [{ readWorkspaceConfig }, { normalizeDefaultPluginSelections }] =
      await Promise.all([
        import('../../lib/workspace-persistence'),
        import('../../lib/workspace-plugin-defaults'),
      ]);
    const config = await readWorkspaceConfig(projectId);
    return {
      repoIds: config.repos.map((repo) => repo.id),
      defaultSkills: normalizeDefaultPluginSelections(
        config.defaultPluginSelections,
      ).skillRefs.map((ref) => ({
        sourceId: ref.sourceId,
        skillName: ref.skillName,
      })),
    };
  },
  addDefaultSkills: async (workspaceId, skills) => {
    const { updateWorkspacePlugins } =
      await import('../../lib/workspace-plugin-defaults');
    await updateWorkspacePlugins({
      workspaceId,
      change: {
        kind: 'selectRecommended',
        selections: skills.map((skill) => ({
          kind: 'skill',
          sourceId: skill.sourceId,
          skillName: skill.skillName,
        })),
        optOutKeys: [],
        clearOptOutKeys: [],
      },
      source: 'shared_container_fork',
    });
  },
  removeDefaultSkills: async (workspaceId, skills) => {
    // Applied to the manifest read inside the workspace's write queue, like
    // the add, so a defaults change committed meanwhile is never erased.
    const { updateWorkspacePlugins, WorkspacePluginsRefusedError } =
      await import('../../lib/workspace-plugin-defaults');
    try {
      await updateWorkspacePlugins({
        workspaceId,
        change: {
          kind: 'removeSelections',
          selections: skills.map((skill) => ({
            kind: 'skill',
            sourceId: skill.sourceId,
            skillName: skill.skillName,
          })),
        },
        source: 'shared_container_fork',
      });
    } catch (error) {
      // A project that is gone took its defaults with it.
      if (
        error instanceof WorkspacePluginsRefusedError &&
        error.reason === 'not-found'
      )
        return;
      throw error;
    }
  },
  removeSkillFolder: async (localName, files) => {
    const { removeMaterializedSkillFolder } =
      await import('../../skills/skill-package-install');
    return removeMaterializedSkillFolder(localName, files);
  },
  readJournal: readForkCapabilityInstallJournal,
  writeJournal: writeForkCapabilityInstallJournal,
  deleteJournal: deleteForkCapabilityInstallJournal,
  listJournals: listForkCapabilityInstallJournals,
};

/**
 * The pinned package routes report transport and HTTP failures as
 * `CanopyCloudClientError` and stop with the signal's reason. Anything else
 * they throw comes from their own checks of a response they did receive
 * (manifest shape, digest, blob hash or size), so it is this package that
 * can't be verified.
 */
async function pinnedRead<T>(
  signal: AbortSignal,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof CanopyCloudClientError || signal.aborted) throw error;
    throw new ForkCapabilityPackageInvalidError(
      error instanceof Error ? error.message : 'unreadable package response',
    );
  }
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/**
 * The install-ledger owner of a fork's package. A code fork's definitions
 * belong to its worktree. A Cowork fork's belong to the Cowork chat project
 * (the workspace its automations target), not to the Work Entry the copy
 * happens to open in. The source container and revision complete the key so
 * two packages installed into one Cowork project stay separate rows.
 */
export function forkCapabilityInstallOwner(
  response: Pick<
    SharedContainerForkResponse,
    'containerType' | 'projectId' | 'worktreeId'
  >,
  containerId: string,
  revisionId: string,
): { kind: 'shared-container'; localId: string } {
  const destination =
    response.containerType === 'CODE_WORKTREE'
      ? `worktree:${response.projectId}/${response.worktreeId}`
      : `cowork:${response.projectId}`;
  return {
    kind: 'shared-container',
    localId: `${destination}:${containerId}:${revisionId}`,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface InstallForkCapabilityPackageInput {
  request: SharedContainerForkRequest;
  response: SharedContainerForkResponse;
  /** Caller cancellation; the attempt also stops at its own deadline. */
  signal?: AbortSignal;
}

/**
 * One attempt running in this process, shared by every caller installing the
 * same fork. Its own controller stops it at its deadline, or once every
 * caller that could still cancel it has cancelled; one caller's cancellation
 * never stops the work another caller is still waiting for.
 */
interface SharedAttempt {
  controller: AbortController;
  /** Callers still waiting that have not cancelled. */
  live: number;
  outcome: Promise<string[]>;
}

/** Attempts running in this process, by journal key. */
const inFlight = new Map<string, SharedAttempt>();
/**
 * Interrupted journals being reconciled, by key, resolving to what their
 * compensation left behind. A claim outlives an attempt that stopped waiting
 * for it, so a later attempt for the same fork waits for it too.
 */
const recovering = new Map<string, Promise<string[]>>();
/** The one recovery pass running for a set of dependencies. */
const recoveryPasses = new WeakMap<
  ForkCapabilityInstallDependencies,
  Promise<void>
>();

/**
 * Installs the disclosed package for a committed fork and returns the
 * warnings to append. Never throws and never alters the fork.
 */
export async function installForkCapabilityPackage(
  input: InstallForkCapabilityPackageInput,
  deps: ForkCapabilityInstallDependencies = defaultDependencies,
): Promise<string[]> {
  try {
    return await installDisclosedPackage(input, deps);
  } catch (error) {
    deps.log('[shared-container-capabilities] install failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [FAILED_PACKAGE_WARNING];
  }
}

async function installDisclosedPackage(
  input: InstallForkCapabilityPackageInput,
  deps: ForkCapabilityInstallDependencies,
): Promise<string[]> {
  const { request, response } = input;
  const digest = request.expectedPackageDigest;
  let replicaPackage: SharedContainerRevisionPackage | undefined;
  try {
    replicaPackage = await deps.readReplicaPackage(
      request.containerId,
      request.revisionId,
    );
  } catch {
    replicaPackage = undefined;
  }
  if (digest === undefined) {
    // Legacy and package-free revisions install nothing. A revision that does
    // carry a package was not disclosed, so it is not consented to either.
    return replicaPackage ? [UNDISCLOSED_PACKAGE_WARNING] : [];
  }
  if (replicaPackage && replicaPackage.digest !== digest) {
    return [CHANGED_PACKAGE_WARNING];
  }
  const owner = forkCapabilityInstallOwner(
    response,
    request.containerId,
    request.revisionId,
  );
  const key = forkCapabilityInstallJournalKey(owner.localId, digest);
  for (;;) {
    const running = inFlight.get(key);
    if (!running) break;
    if (!running.controller.signal.aborted)
      return running.outcome.finally(joinAttempt(running, input.signal));
    // Every earlier caller cancelled (or it timed out). Its outcome is not
    // this caller's: let it unwind, then start afresh.
    await running.outcome;
  }
  // Claimed before any other callback can run, so a recovery pass that has
  // not reached this key yet skips it and leaves it to this attempt.
  const attempt: SharedAttempt = {
    controller: new AbortController(),
    live: 0,
    outcome: Promise.resolve([]),
  };
  inFlight.set(key, attempt);
  // Joined before the work starts, so a caller that already cancelled stops
  // it before anything runs.
  const detach = joinAttempt(attempt, input.signal);
  attempt.outcome = runAttempt(
    input,
    deps,
    owner,
    key,
    digest,
    attempt.controller,
  ).finally(() => {
    if (inFlight.get(key) === attempt) inFlight.delete(key);
  });
  return attempt.outcome.finally(detach);
}

/**
 * Join a shared attempt and return the function that leaves it. A caller
 * without a signal keeps it running; one whose signal aborts stops counting,
 * and the attempt is cancelled only when no caller that could cancel it is
 * left. A cancelled caller still receives the outcome: when another caller
 * kept the work going, that outcome is what actually happened to this fork.
 */
function joinAttempt(
  attempt: SharedAttempt,
  signal: AbortSignal | undefined,
): () => void {
  const cancelIfAbandoned = (): void => {
    if (attempt.live === 0)
      attempt.controller.abort(new InstallCancelledError());
  };
  if (signal?.aborted) {
    cancelIfAbandoned();
    return () => undefined;
  }
  attempt.live += 1;
  if (!signal) return () => undefined;
  const onAbort = (): void => {
    attempt.live -= 1;
    cancelIfAbandoned();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/** The attempt reached its own deadline. */
class InstallTimeoutError extends Error {
  constructor() {
    super('Capability package install timed out');
    this.name = 'InstallTimeoutError';
  }
}

/** The caller cancelled the attempt. */
class InstallCancelledError extends Error {
  constructor() {
    super('Capability package install was cancelled');
    this.name = 'InstallCancelledError';
  }
}

/** Why `signal` stopped; the attempt only ever aborts with these. */
function stopReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof InstallTimeoutError ||
    reason instanceof InstallCancelledError
    ? reason
    : new InstallCancelledError();
}

/**
 * Wait for `work`, but no longer than `signal` allows. The work itself keeps
 * running; whatever it claimed stays claimed until it settles.
 */
function untilStopped<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(stopReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(stopReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function ledgerNamesPackage(
  ledger: CapabilityPackageInstallRecordV1 | null,
  digest: string,
): boolean {
  return (
    ledger !== null &&
    ledger.distributionMode !== 'definition_only' &&
    ledger.packageDigest === digest
  );
}

async function runAttempt(
  input: InstallForkCapabilityPackageInput,
  deps: ForkCapabilityInstallDependencies,
  owner: { kind: 'shared-container'; localId: string },
  key: string,
  digest: string,
  /** Shared by this attempt's callers; see {@link joinAttempt}. */
  controller: AbortController,
): Promise<string[]> {
  const { request, response } = input;
  // The deadline covers everything this attempt waits for, recovery included.
  const timer = setTimeout(
    () => controller.abort(new InstallTimeoutError()),
    deps.timeoutMs,
  );
  timer.unref?.();
  const signal = controller.signal;
  const throwIfStopped = (): void => {
    if (signal.aborted) throw stopReason(signal);
  };
  const withResidual = (
    warnings: string[],
    residual: readonly string[],
  ): string[] =>
    residual.length > 0 ? [...warnings, residualWarning(residual)] : warnings;

  const pinned: PinnedPackageRequest = {
    containerId: request.containerId,
    revisionId: request.revisionId,
    organizationId: request.organizationId,
    digest,
  };
  const blobs = new Map<string, Promise<Uint8Array>>();
  const fetchBlob = (sha256: string): Promise<Uint8Array> => {
    throwIfStopped();
    let pending = blobs.get(sha256);
    if (!pending) {
      // Verified here, whatever the transport checked, so a mismatch is
      // always reported as this package failing verification.
      pending = deps.getBlob(pinned, sha256, signal).then((bytes) => {
        if (sha256Hex(bytes) !== sha256)
          throw new ForkCapabilityPackageInvalidError(
            `blob ${sha256} failed verification`,
          );
        return bytes;
      });
      blobs.set(sha256, pending);
      // A failed read must be retried by the next caller, not replayed.
      void pending.catch(() => blobs.delete(sha256));
    }
    return pending;
  };

  /** What an earlier attempt for this fork left behind. */
  const earlierResidual: string[] = [];
  let journal: ForkCapabilityInstallJournal | undefined;
  /** Set once the materializer's rollback has compensated the definitions. */
  let definitionsResidual: string[] | undefined;
  try {
    throwIfStopped();
    // Interrupted attempts first. The shared pass skips this key (claimed
    // above); this fork's own earlier attempt is reconciled just after.
    await untilStopped(recoverForkCapabilityInstalls(deps), signal);
    earlierResidual.push(
      ...(await untilStopped(recoverOwnJournal(deps, key), signal)),
    );
    if (ledgerNamesPackage(await deps.findLedgerInstall(owner), digest)) {
      // A retry of an install that already finished: nothing is duplicated.
      return withResidual([], earlierResidual);
    }

    const download = await deps.getPackage(pinned, signal);
    if (
      download.digest !== digest ||
      computePipelinePackageDigestSync(download.manifest) !== digest
    ) {
      throw new ForkCapabilityPackageInvalidError('digest mismatch');
    }
    const plan = await planForkCapabilityInstall(download.manifest, fetchBlob, {
      containerType: response.containerType,
    });
    const destination = await deps.readDestination(response.projectId);
    throwIfStopped();

    // This attempt's journal reuses the key. An earlier attempt's record of
    // what it left behind moves aside first, keeping its retention, and is
    // named here once.
    for (const item of await keepResidualJournal(deps, key)) {
      if (!earlierResidual.includes(item)) earlierResidual.push(item);
    }
    throwIfStopped();

    const startedAt = deps.now().toISOString();
    journal = {
      version: 1,
      key,
      attemptId: randomUUID(),
      ownerLocalId: owner.localId,
      containerId: request.containerId,
      revisionId: request.revisionId,
      packageDigest: digest,
      destination: {
        projectId: response.projectId,
        worktreeId: response.worktreeId,
        containerType: response.containerType,
      },
      status: 'installing',
      startedAt,
      updatedAt: startedAt,
      skills: [],
      agents: [],
      pipelines: [],
      automations: [],
      environmentRequirements: download.manifest.environmentRequirements.map(
        (requirement) => ({ id: requirement.id, kind: requirement.kind }),
      ),
    };
    await deps.writeJournal(journal);
    const live = journal;
    const warnings: string[] = [];

    await deps.installSubjectPackage({
      owner,
      originExternalId: request.containerId,
      packageRef: { version: 1, digest },
      download,
      fetchBlob,
      onSkillFolderReserved: async (folder) => {
        throwIfStopped();
        live.skills.push({
          resourceId: folder.resourceId,
          localName: folder.localName,
          created: folder.created,
          files: folder.files.map((file) => ({
            path: file.path,
            sha256: file.sha256,
          })),
        });
        await touchJournal(deps, live);
      },
      finalizeInstall: async (installed) => {
        await installDefinitions({
          deps,
          journal: live,
          plan,
          manifest: download.manifest,
          digest,
          installed,
          response,
          containerId: request.containerId,
          destination,
          warnings,
          throwIfStopped,
        });
        throwIfStopped();
        return undefined;
      },
      // Skill folders are the materializer's to remove in this boundary; it
      // removes them alongside this rollback.
      rollbackFinalization: async () => {
        definitionsResidual = await compensateDefinitions(deps, live);
      },
    });
    await finalizeJournal(deps, live, 'completed', false);
    if (plan.hooks.length > 0) warnings.push(HOOKS_OMITTED_WARNING);
    if (plan.pluginMemberLabels.length > 0)
      warnings.push(pluginMembersWarning(plan.pluginMemberLabels));
    return withResidual(warnings, earlierResidual);
  } catch (error) {
    deps.log('[shared-container-capabilities] package not installed', {
      containerId: request.containerId,
      revisionId: request.revisionId,
      error: error instanceof Error ? error.message : String(error),
    });
    const warnings = [warningForFailure(error, signal)];
    const residual = [...earlierResidual];
    if (journal && journal.status === 'installing') {
      // The materializer has finished its own rollback by now, so any skill
      // folder still here is one it could not remove.
      const left = [
        ...(definitionsResidual ??
          (await compensateDefinitions(deps, journal))),
        ...(await compensateSkills(deps, journal)),
      ];
      await finishCompensation(deps, journal, left, false);
      residual.push(...left);
    }
    return withResidual(warnings, residual);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Move a `rollback-incomplete` journal at `key` to its own residual key, so
 * the attempt about to reuse `key` never erases what it names. The copy keeps
 * its status and `updatedAt`, so recovery prunes it on the original schedule.
 * Returns the residual it names; nothing when there is no such journal.
 */
async function keepResidualJournal(
  deps: ForkCapabilityInstallDependencies,
  key: string,
): Promise<string[]> {
  const existing = await deps.readJournal(key);
  if (!existing || existing.status !== 'rollback-incomplete') return [];
  await deps.writeJournal({
    ...existing,
    key: forkCapabilityInstallResidualJournalKey(existing),
  });
  return existing.residual ?? [];
}

/**
 * Map a failure to its warning by type, never by message text: an invalid
 * package, this attempt's own deadline, the caller's cancellation, or a
 * refused pinned read. Anything else is a plain failure.
 */
function warningForFailure(error: unknown, signal: AbortSignal): string {
  if (error instanceof ForkCapabilityPackageInvalidError)
    return INVALID_PACKAGE_WARNING;
  const stopped =
    error instanceof InstallTimeoutError ||
    error instanceof InstallCancelledError
      ? error
      : signal.aborted
        ? stopReason(signal)
        : undefined;
  if (stopped instanceof InstallTimeoutError) return TIMED_OUT_PACKAGE_WARNING;
  if (stopped instanceof InstallCancelledError)
    return CANCELLED_PACKAGE_WARNING;
  if (error instanceof CanopyCloudClientError) {
    // Revoked, retired, unknown or no-longer-matching revisions: never fall
    // back to the latest revision or a public route.
    if (
      error.status === 403 ||
      error.status === 404 ||
      error.status === 409 ||
      error.status === 410
    )
      return UNAVAILABLE_PACKAGE_WARNING;
    if (error.status === 426) return INVALID_PACKAGE_WARNING;
  }
  return FAILED_PACKAGE_WARNING;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

interface InstallDefinitionsInput {
  deps: ForkCapabilityInstallDependencies;
  journal: ForkCapabilityInstallJournal;
  plan: ForkCapabilityInstallPlan;
  manifest: PipelinePackageManifestV1;
  digest: string;
  installed: InstallSubjectCapabilityPackageResult;
  response: SharedContainerForkResponse;
  containerId: string;
  destination: Awaited<
    ReturnType<ForkCapabilityInstallDependencies['readDestination']>
  >;
  warnings: string[];
  throwIfStopped: () => void;
}

function mergeSelections(
  base: ChatTabPluginSelections,
  skills: readonly ForkCapabilityInstallSkillSelection[],
): ChatTabPluginSelections {
  const skillRefs = [...base.skillRefs];
  for (const skill of skills) {
    if (
      !skillRefs.some(
        (ref) =>
          ref.sourceId === skill.sourceId && ref.skillName === skill.skillName,
      )
    )
      skillRefs.push({ sourceId: skill.sourceId, skillName: skill.skillName });
  }
  return { ...base, skillRefs };
}

function uniqueName(
  base: string,
  taken: ReadonlySet<string>,
  attempt: number,
): string {
  for (let suffix = attempt; suffix < MAX_NAME_SUFFIX; suffix += 1) {
    const candidate = suffix <= 1 ? base : `${base} (${suffix})`;
    if (!taken.has(candidate.trim().toLowerCase())) return candidate;
  }
  throw new Error(`Could not name "${base}" without replacing local work`);
}

async function installDefinitions(
  input: InstallDefinitionsInput,
): Promise<void> {
  const { deps, journal, plan, response, throwIfStopped } = input;
  const localSkillByResource = new Map(
    input.installed.installedSkills.map((skill) => [
      skill.resourceId,
      skill.localName,
    ]),
  );
  // Folders were journaled as the materializer reserved them. One it did not
  // report is named without `created`, so compensation never removes it.
  let skillsAdded = false;
  for (const skill of input.installed.installedSkills) {
    if (journal.skills.some((entry) => entry.resourceId === skill.resourceId))
      continue;
    journal.skills.push({
      resourceId: skill.resourceId,
      localName: skill.localName,
    });
    skillsAdded = true;
  }
  if (skillsAdded) await touchJournal(deps, journal);
  // Provider twins of one skill share a local folder, so names are unique'd.
  const skillsFor = (
    resourceIds: readonly string[],
  ): ForkCapabilityInstallSkillSelection[] =>
    Array.from(
      new Set(
        resourceIds.flatMap((id) => {
          const localName = localSkillByResource.get(id);
          return localName ? [localName] : [];
        }),
      ),
    )
      .sort()
      .map((skillName) => ({ sourceId: 'custom:app', skillName }));
  const unmatchedRefs = new Set<string>();

  // Agents ---------------------------------------------------------------
  const localAgentByResource = new Map<string, string>();
  if (plan.agents.length > 0) {
    const takenAgentNames = new Set(
      (await deps.listAgents()).map((agent) => agent.name.trim().toLowerCase()),
    );
    for (const planned of plan.agents) {
      throwIfStopped();
      const portable = await deps.resolvePortablePlugins(
        planned.document.agent.plugins,
      );
      for (const ref of portable.unmatched) unmatchedRefs.add(ref);
      const pluginSelections = mergeSelections(
        portable.selections,
        skillsFor(planned.skillResourceIds),
      );
      // An Agent has no per-step overlay: its instructions invoke the skill
      // by the local name its selections carry, never the packaged one a
      // recipient's own skill may hold.
      const instructions = rewriteSkillInvocations(
        planned.document.agent.instructions,
        skillInvocationRenames(
          input.manifest.resources,
          planned.skillResourceIds,
          localSkillByResource,
        ),
      );
      let created: AgentModelDefinition | undefined;
      for (let attempt = 1; !created; attempt += 1) {
        const name = uniqueName(
          planned.document.agent.name,
          takenAgentNames,
          attempt,
        );
        const entry: ForkCapabilityInstallJournal['agents'][number] = {
          resourceId: planned.resourceId,
          name,
        };
        journal.agents = [
          ...journal.agents.filter(
            (agent) => agent.resourceId !== planned.resourceId,
          ),
          entry,
        ];
        await touchJournal(deps, journal);
        try {
          created = await deps.createAgent({
            name,
            baseModel: planned.document.agent.baseModel,
            instructions,
            pluginSelections,
          });
        } catch (error) {
          // A name hidden from this context's list still collides; try the
          // next suffix rather than replacing anything.
          if (
            error instanceof Error &&
            /already exists/i.test(error.message) &&
            attempt < MAX_NAME_SUFFIX
          ) {
            takenAgentNames.add(name.trim().toLowerCase());
            continue;
          }
          throw error;
        }
        entry.localId = created.id;
        if (created.contentHash !== undefined)
          entry.contentHash = created.contentHash;
        await touchJournal(deps, journal);
        takenAgentNames.add(created.name.trim().toLowerCase());
      }
      localAgentByResource.set(planned.resourceId, created.id);
    }
  }

  // Pipelines ------------------------------------------------------------
  for (const skipped of plan.skippedPipelines)
    input.warnings.push(pipelineSkippedWarning(skipped.displayName));
  const localPipelineByResource = new Map<
    string,
    { id: string; rawPipeline: string }
  >();
  if (plan.pipelines.length > 0) {
    const takenPipelineNames = new Set(
      (await deps.listPipelineNames()).map((name) => name.trim().toLowerCase()),
    );
    // Each step's provider, read as the publisher's analyzer read it, decides
    // which packaged skills its prompt invokes.
    const { resolvePipelinePackageProviderByStep } =
      await import('../../pipelines/pipeline-package-service');
    for (const planned of plan.pipelines) {
      throwIfStopped();
      const agentIds = new Map<string, string>();
      for (const resourceId of planned.agentResourceIds) {
        const agent = plan.agents.find(
          (item) => item.resourceId === resourceId,
        );
        const localId = localAgentByResource.get(resourceId);
        if (!agent || !localId)
          throw new ForkCapabilityPackageInvalidError(
            `${planned.document.name} uses an Agent the package does not install`,
          );
        agentIds.set(agent.document.agent.id, localId);
      }
      const rawPipeline = rewriteAgentModelIds(planned.document.yaml, agentIds);
      // A rewrite must leave valid YAML; anything else is not this package.
      let installedPipeline: Pipeline;
      try {
        installedPipeline = parsePipelineText(rawPipeline);
      } catch (error) {
        throw new ForkCapabilityPackageInvalidError(
          `${planned.document.name}: ${
            error instanceof Error ? error.message : 'invalid pipeline YAML'
          }`,
        );
      }
      const contentHash = hashPipelinePackageYaml(rawPipeline);
      // Bound per step to the YAML that is actually stored and run.
      const overlayManifest = deriveInstalledPipelineManifest(
        input.manifest,
        planned,
        { pipeline: installedPipeline, contentHash },
        resolvePipelinePackageProviderByStep,
      );
      const name = uniqueName(planned.document.name, takenPipelineNames, 1);
      const localPipelineId = deps.randomId();
      journal.pipelines.push({
        resourceId: planned.resourceId,
        localId: localPipelineId,
        contentHash,
        name,
      });
      await touchJournal(deps, journal);
      await deps.createPipeline({
        localPipelineId,
        name,
        ...(planned.document.description !== undefined
          ? { description: planned.document.description }
          : {}),
        rawPipeline,
        ...(overlayManifest
          ? {
              overlay: {
                digest: computePipelinePackageDigestSync(overlayManifest),
                manifest: overlayManifest,
                sourcePackageDigest: input.digest,
              },
            }
          : {}),
      });
      takenPipelineNames.add(name.trim().toLowerCase());
      localPipelineByResource.set(planned.resourceId, {
        id: localPipelineId,
        rawPipeline,
      });
    }
  }

  // Automations ----------------------------------------------------------
  for (const skipped of plan.skippedAutomations) {
    input.warnings.push(
      automationSkippedWarning(skipped.displayName, skipped.reason),
    );
  }
  for (const planned of plan.automations) {
    throwIfStopped();
    const built = await buildAutomationRequest({
      deps,
      planned,
      plan,
      response,
      containerId: input.containerId,
      destination: input.destination,
      localAgentByResource,
      localPipelineByResource,
      skillsFor,
      skillRenamesFor: (ids) =>
        skillInvocationRenames(
          input.manifest.resources,
          ids,
          localSkillByResource,
        ),
      unmatchedRefs,
    });
    if (!built.ok) {
      deps.log('[shared-container-capabilities] automation skipped', {
        resourceId: planned.resourceId,
        reason: built.error,
      });
      input.warnings.push(
        automationSkippedWarning(
          planned.document.automation.name,
          isSkipReason(built.error) ? built.error : MAPPING_FAILED_REASON,
        ),
      );
      continue;
    }
    const entry: ForkCapabilityInstallJournal['automations'][number] = {
      resourceId: planned.resourceId,
      name: built.request.name,
    };
    journal.automations.push(entry);
    await touchJournal(deps, journal);
    const created = await deps.createAutomation(built.request);
    if (!created.ok || !created.activity) {
      journal.automations = journal.automations.filter(
        (automation) => automation !== entry,
      );
      await touchJournal(deps, journal);
      deps.log('[shared-container-capabilities] automation not saved', {
        resourceId: planned.resourceId,
        reason: created.ok ? 'no activity returned' : created.error,
      });
      input.warnings.push(
        automationSkippedWarning(
          planned.document.automation.name,
          MAPPING_FAILED_REASON,
        ),
      );
      continue;
    }
    entry.localId = created.activity.id;
    entry.createdAt = created.activity.createdAt;
    entry.updatedAt = created.activity.updatedAt;
    await touchJournal(deps, journal);
    if (planned.document.automation.hasRunCondition)
      input.warnings.push(
        runConditionOmittedWarning(planned.document.automation.name),
      );
  }

  // Default selections ---------------------------------------------------
  const existingDefaults = new Set(
    input.destination.defaultSkills.map(
      (skill) => `${skill.sourceId}\0${skill.skillName}`,
    ),
  );
  const added = skillsFor(plan.defaultSkillResourceIds).filter(
    (skill) => !existingDefaults.has(`${skill.sourceId}\0${skill.skillName}`),
  );
  if (added.length > 0) {
    throwIfStopped();
    journal.selections = { workspaceId: response.projectId, added };
    await touchJournal(deps, journal);
    await deps.addDefaultSkills(response.projectId, added);
  }
  if (unmatchedRefs.size > 0)
    input.warnings.push(unmatchedRefsWarning(Array.from(unmatchedRefs).sort()));
}

const MAPPING_FAILED_REASON = "it couldn't be set up for this copy";

function isSkipReason(value: string): value is ForkAutomationSkipReason {
  return (
    value === 'incompatible-target' ||
    value === 'pipeline-unavailable' ||
    value === 'agent-unavailable' ||
    value === 'pipeline-skipped'
  );
}

/**
 * A prompt automation has no per-step overlay, so its prompt must invoke the
 * local copy of each packaged skill its selections carry.
 */
function withLocalSkillInvocations(
  automation: SharedAutomationDocument,
  renames: ReadonlyMap<string, string>,
): SharedAutomationDocument {
  const action = automation.action;
  if (renames.size === 0 || action.type === 'worktree_pipeline')
    return automation;
  if (!('prompt' in action)) return automation;
  const rewritten = rewriteSkillInvocationsInPrompt(
    action.prompt,
    action.promptReferences,
    renames,
  );
  return {
    ...automation,
    action: {
      ...action,
      prompt: rewritten.prompt,
      ...(rewritten.references
        ? { promptReferences: rewritten.references }
        : {}),
    },
  };
}

async function buildAutomationRequest(input: {
  deps: ForkCapabilityInstallDependencies;
  planned: PlannedAutomation;
  plan: ForkCapabilityInstallPlan;
  response: SharedContainerForkResponse;
  containerId: string;
  destination: InstallDefinitionsInput['destination'];
  localAgentByResource: ReadonlyMap<string, string>;
  localPipelineByResource: ReadonlyMap<
    string,
    { id: string; rawPipeline: string }
  >;
  skillsFor: (ids: readonly string[]) => ForkCapabilityInstallSkillSelection[];
  skillRenamesFor: (ids: readonly string[]) => ReadonlyMap<string, string>;
  unmatchedRefs: Set<string>;
}): Promise<
  { ok: true; request: AutomationCreateRequest } | { ok: false; error: string }
> {
  const { planned, response } = input;
  const document = planned.document;
  const automation = withLocalSkillInvocations(
    document.automation,
    input.skillRenamesFor(planned.skillResourceIds),
  );
  const action = automation.action;
  const isCode = response.containerType === 'CODE_WORKTREE';

  let pluginSelections: ChatTabPluginSelections | undefined;
  if (action.type !== 'worktree_pipeline') {
    const portable = await input.deps.resolvePortablePlugins(action.plugins);
    for (const ref of portable.unmatched) input.unmatchedRefs.add(ref);
    pluginSelections = mergeSelections(
      portable.selections,
      input.skillsFor(planned.skillResourceIds),
    );
    if (
      pluginSelections.skillRefs.length === 0 &&
      pluginSelections.pluginRefs.length === 0
    )
      pluginSelections = undefined;
  }

  let pipelineId: string | undefined;
  let pipelineResolution: { status: 'resolved'; scopes: unknown } | undefined;
  if (action.type === 'worktree_pipeline') {
    if (action.pipeline.source === 'unresolved') {
      const local = planned.pipelineResourceId
        ? input.localPipelineByResource.get(planned.pipelineResourceId)
        : undefined;
      if (!local) return { ok: false, error: 'pipeline-unavailable' };
      pipelineId = local.id;
      pipelineResolution = {
        status: 'resolved',
        scopes: parsePipelineText(local.rawPipeline).scope,
      };
    } else if (action.pipeline.source === 'bundled') {
      const scopes = await input.deps.readBundledPipelineScopes(
        action.pipeline.pipelineId,
      );
      if (scopes === undefined)
        return { ok: false, error: 'pipeline-unavailable' };
      pipelineResolution = { status: 'resolved', scopes };
    } else {
      return { ok: false, error: 'pipeline-unavailable' };
    }
  }

  const built = buildInstallAutomationRequest(
    {
      id: input.containerId,
      contentHash: planned.contentHash,
      automation,
    },
    {
      targetKind: isCode ? 'single-repo' : 'cowork',
      ...(pipelineResolution ? { pipelineResolution } : {}),
      ...(isCode
        ? {
            workspaceId: response.projectId,
            repoIds: input.destination.repoIds,
          }
        : { coworkWorkspaceId: response.projectId }),
      ...(pipelineId !== undefined
        ? { pipelineId, pipelineSource: 'user' as const }
        : {}),
      ...(pluginSelections ? { pluginSelections } : {}),
    },
    input.deps.now().toISOString(),
  );
  if (!built.ok) return { ok: false, error: built.error };

  const retargeted = retargetAction(built.request.action, response);
  if (!retargeted) return { ok: false, error: 'incompatible-target' };
  // The portable document strips a local Agent model; `uses.agent` names
  // the packaged Agent instead, so the copy routes through its local Agent.
  let actionWithModel: AutomationAction = retargeted;
  if (retargeted.type !== 'worktree_pipeline') {
    const modelAgentId = agentIdForModel(retargeted.model);
    const agentResourceId = planned.agentResourceId;
    if (agentResourceId !== undefined) {
      const agent = input.plan.agents.find(
        (item) => item.resourceId === agentResourceId,
      );
      const localId = input.localAgentByResource.get(agentResourceId);
      if (
        !agent ||
        !localId ||
        (modelAgentId !== undefined && modelAgentId !== agent.document.agent.id)
      )
        return { ok: false, error: 'agent-unavailable' };
      actionWithModel = { ...retargeted, model: localId };
    } else if (modelAgentId !== undefined) {
      // Never keep a source-machine Agent id or guess a local one.
      return { ok: false, error: 'agent-unavailable' };
    }
  }

  // Provenance is recorded in the shared-container ledger row and attempt
  // journal, not `installedFrom`: that field names a shared-automation remote
  // whose subscription, update badge and host authorization would all look
  // the container id up as an automation share.
  const request: AutomationCreateRequest = {
    name: built.request.name,
    schedule: built.request.schedule,
    action: actionWithModel,
    enabled: false,
    ...(built.request.targetRequirement
      ? { targetRequirement: built.request.targetRequirement }
      : {}),
  };
  return { ok: true, request };
}

/**
 * Point a mapped action at the fork. Every source-machine binding was stripped
 * from the portable document; these are the fork's own ids.
 */
type ForkAutomationAction = Extract<
  AutomationAction,
  { type: 'worktree_prompt' | 'worktree_pipeline' | 'standalone_prompt' }
>;

function retargetAction(
  action: AutomationAction,
  response: SharedContainerForkResponse,
): ForkAutomationAction | undefined {
  switch (action.type) {
    case 'worktree_prompt':
      return {
        ...action,
        workspaceId: response.projectId,
        existingWorktreeId: response.worktreeId,
      };
    case 'worktree_pipeline':
      return {
        ...action,
        workspaceId: response.projectId,
        baseWorktreeId: response.worktreeId,
      };
    case 'standalone_prompt':
      return { ...action, chatProjectId: response.projectId };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Journal bookkeeping, compensation and recovery
// ---------------------------------------------------------------------------

async function touchJournal(
  deps: ForkCapabilityInstallDependencies,
  journal: ForkCapabilityInstallJournal,
): Promise<void> {
  journal.updatedAt = deps.now().toISOString();
  await deps.writeJournal(journal);
}

/**
 * Record a final status, then drop the journal unless it still names residual
 * items. With `guard`, nothing is written unless the journal on disk is still
 * this attempt's: recovery never writes over a newer attempt for the same key.
 * Never throws; a journal that could not be finished is reconciled again by
 * the next recovery.
 */
async function finalizeJournal(
  deps: ForkCapabilityInstallDependencies,
  journal: ForkCapabilityInstallJournal,
  status: ForkCapabilityInstallJournal['status'],
  guard: boolean,
): Promise<void> {
  journal.status = status;
  try {
    if (guard) {
      const current = await deps.readJournal(journal.key);
      if (!current || current.attemptId !== journal.attemptId) {
        deps.log('[shared-container-capabilities] journal moved on', {
          key: journal.key,
        });
        return;
      }
    }
    await touchJournal(deps, journal);
    if (status !== 'rollback-incomplete') await deps.deleteJournal(journal.key);
  } catch (error) {
    // The ledger row (or the absence of created objects) remains the truth;
    // the next recovery reconciles or prunes a stale journal.
    deps.log('[shared-container-capabilities] journal update failed', {
      key: journal.key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Whether nobody changed the automation since this attempt saved it:
 * `savedAt` is the `updatedAt` its create returned, which a conversion to an
 * owned workflow moves past `createdAt`.
 */
function unchangedSinceCreate(
  activity: ScheduledActivity,
  savedAt: string = activity.createdAt,
): boolean {
  return !activity.enabled && activity.updatedAt === savedAt;
}

/** Run one compensation step; a refusal or failure names `label` as residual. */
async function tryCompensation(
  deps: ForkCapabilityInstallDependencies,
  journal: ForkCapabilityInstallJournal,
  residual: string[],
  label: string,
  action: () => Promise<boolean>,
): Promise<void> {
  try {
    if (!(await action())) residual.push(label);
  } catch (error) {
    residual.push(label);
    deps.log('[shared-container-capabilities] compensation failed', {
      key: journal.key,
      item: label,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Undo this attempt's definitions and selections, newest first, keeping
 * anything the user changed since. Never throws; returns what stayed.
 */
async function compensateDefinitions(
  deps: ForkCapabilityInstallDependencies,
  journal: ForkCapabilityInstallJournal,
): Promise<string[]> {
  const residual: string[] = [];
  const attempt = (
    label: string,
    action: () => Promise<boolean>,
  ): Promise<void> => tryCompensation(deps, journal, residual, label, action);

  const selections = journal.selections;
  if (selections && selections.added.length > 0) {
    await attempt('default skills', async () => {
      await deps.removeDefaultSkills(selections.workspaceId, selections.added);
      return true;
    });
  }

  let activities: ScheduledActivity[] | undefined;
  if (journal.automations.length > 0) {
    try {
      activities = await deps.listAutomations();
    } catch (error) {
      // Without the list nothing can be told apart from the user's own, and
      // an automation this attempt made may still be here: name every one.
      deps.log('[shared-container-capabilities] compensation failed', {
        key: journal.key,
        item: 'automations',
        error: error instanceof Error ? error.message : String(error),
      });
      for (const entry of [...journal.automations].reverse())
        residual.push(`automation "${entry.name}"`);
    }
  }
  if (activities) {
    const listed = activities;
    const claimed = new Set<string>();
    for (const entry of [...journal.automations].reverse()) {
      await attempt(`automation "${entry.name}"`, async () => {
        const activity =
          entry.localId !== undefined
            ? listed.find((candidate) => candidate.id === entry.localId)
            : // Created but not yet journaled: only an untouched automation of
              // this name created during this attempt can be ours.
              listed.find(
                (candidate) =>
                  !claimed.has(candidate.id) &&
                  candidate.name === entry.name &&
                  candidate.createdAt >= journal.startedAt &&
                  unchangedSinceCreate(candidate),
              );
        if (!activity) return true;
        claimed.add(activity.id);
        if (!unchangedSinceCreate(activity, entry.updatedAt)) return false;
        const removed = await deps.deleteAutomation(activity.id);
        return removed.ok;
      });
    }
  }

  for (const entry of [...journal.pipelines].reverse()) {
    await attempt(`pipeline "${entry.name}"`, async () => {
      const outcome = await deps.removePipeline(
        entry.localId,
        entry.contentHash,
      );
      return outcome !== 'kept';
    });
  }

  if (journal.agents.length > 0) {
    for (const entry of [...journal.agents].reverse()) {
      await attempt(`Agent "${entry.name}"`, async () => {
        const agents = await deps.listAgents();
        const agent =
          entry.localId !== undefined
            ? agents.find((candidate) => candidate.id === entry.localId)
            : agents.find(
                (candidate) =>
                  candidate.name === entry.name &&
                  candidate.createdAt >= journal.startedAt &&
                  candidate.updatedAt === candidate.createdAt,
              );
        if (!agent) return true;
        const contentHash = entry.contentHash ?? agent.contentHash;
        if (contentHash === undefined) return false;
        await deps.removeAgent(agent.id, contentHash);
        const remaining = await deps.listAgents();
        return !remaining.some((candidate) => candidate.id === agent.id);
      });
    }
  }
  return residual;
}

/**
 * Remove skill folders this attempt created, newest first, while they hold
 * only the packaged files written into them. A folder the materializer reused
 * was already the user's and is left alone. Never throws; returns what stayed.
 */
async function compensateSkills(
  deps: ForkCapabilityInstallDependencies,
  journal: ForkCapabilityInstallJournal,
): Promise<string[]> {
  // Provider twins share one folder: the first creates it, the next reuses
  // it and adds its own files, so the folder's content is their union.
  const folders = new Map<
    string,
    { created: boolean; files: ForkCapabilityInstallSkillFile[] }
  >();
  for (const skill of journal.skills) {
    const folder = folders.get(skill.localName) ?? {
      created: false,
      files: [],
    };
    if (skill.created === true) folder.created = true;
    folder.files.push(...(skill.files ?? []));
    folders.set(skill.localName, folder);
  }
  const residual: string[] = [];
  for (const [localName, folder] of Array.from(folders.entries()).reverse()) {
    if (!folder.created) continue;
    await tryCompensation(
      deps,
      journal,
      residual,
      `skill "${localName}"`,
      async () =>
        (await deps.removeSkillFolder(localName, folder.files)) !== 'kept',
    );
  }
  return residual;
}

async function finishCompensation(
  deps: ForkCapabilityInstallDependencies,
  journal: ForkCapabilityInstallJournal,
  residual: string[],
  guard: boolean,
): Promise<void> {
  journal.residual = residual;
  await finalizeJournal(
    deps,
    journal,
    residual.length > 0 ? 'rollback-incomplete' : 'rolled-back',
    guard,
  );
}

/**
 * Undo an interrupted attempt: definitions and selections, then the skill
 * folders they used. Whatever stays behind is recorded in `journal.residual`
 * and returned. The journal is finished only while it is still this attempt's.
 */
export async function compensate(
  deps: ForkCapabilityInstallDependencies,
  journal: ForkCapabilityInstallJournal,
): Promise<string[]> {
  const residual = [
    ...(await compensateDefinitions(deps, journal)),
    ...(await compensateSkills(deps, journal)),
  ];
  await finishCompensation(deps, journal, residual, true);
  return residual;
}

/**
 * Finish or compensate one interrupted journal, claiming its key until done.
 * An attempt whose ledger row names its package finished everything but the
 * journal update; any other is compensated.
 */
function recoverJournal(
  deps: ForkCapabilityInstallDependencies,
  listed: ForkCapabilityInstallJournal,
): Promise<string[]> {
  const claimed = recovering.get(listed.key);
  if (claimed) return claimed;
  const run = reconcileJournal(deps, listed).finally(() => {
    if (recovering.get(listed.key) === run) recovering.delete(listed.key);
  });
  recovering.set(listed.key, run);
  return run;
}

async function reconcileJournal(
  deps: ForkCapabilityInstallDependencies,
  listed: ForkCapabilityInstallJournal,
): Promise<string[]> {
  try {
    // The listing may be stale: act only on the same, still-open attempt.
    const journal = await deps.readJournal(listed.key);
    if (
      !journal ||
      journal.status !== 'installing' ||
      journal.attemptId !== listed.attemptId
    )
      return [];
    const ledger = await deps.findLedgerInstall({
      kind: 'shared-container',
      localId: journal.ownerLocalId,
    });
    if (ledgerNamesPackage(ledger, journal.packageDigest)) {
      await finalizeJournal(deps, journal, 'completed', true);
      return [];
    }
    const residual = await compensate(deps, journal);
    if (residual.length > 0) {
      deps.log('[shared-container-capabilities] recovery left items', {
        key: journal.key,
        residual,
      });
    }
    return residual;
  } catch (error) {
    deps.log('[shared-container-capabilities] recovery failed', {
      key: listed.key,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * This fork's own interrupted attempt, if any. Its key is held by the calling
 * attempt, so no recovery pass claims it meanwhile; one already reconciling it
 * (or an earlier attempt's abandoned reconciliation) is waited for instead.
 */
async function recoverOwnJournal(
  deps: ForkCapabilityInstallDependencies,
  key: string,
): Promise<string[]> {
  const claimed = recovering.get(key);
  if (claimed) return claimed;
  const existing = await deps.readJournal(key);
  if (!existing || existing.status !== 'installing') return [];
  return recoverJournal(deps, existing);
}

/** A final journal no recovery needs, or a residual one past its retention. */
function isPrunable(
  journal: ForkCapabilityInstallJournal,
  now: number,
): boolean {
  if (journal.status === 'completed' || journal.status === 'rolled-back')
    return true;
  if (journal.status !== 'rollback-incomplete') return false;
  const updatedAt = Date.parse(journal.updatedAt);
  return !(updatedAt > now - FORK_CAPABILITY_INSTALL_RESIDUAL_RETENTION_MS);
}

async function pruneJournal(
  deps: ForkCapabilityInstallDependencies,
  listed: ForkCapabilityInstallJournal,
): Promise<void> {
  try {
    const current = await deps.readJournal(listed.key);
    if (
      !current ||
      current.attemptId !== listed.attemptId ||
      current.status !== listed.status ||
      current.updatedAt !== listed.updatedAt
    )
      return;
    await deps.deleteJournal(listed.key);
  } catch (error) {
    deps.log('[shared-container-capabilities] journal prune failed', {
      key: listed.key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runRecoveryPass(
  deps: ForkCapabilityInstallDependencies,
): Promise<void> {
  let journals: ForkCapabilityInstallJournal[];
  try {
    journals = await deps.listJournals();
  } catch {
    return;
  }
  const now = deps.now().getTime();
  for (const journal of journals) {
    // Checked as each journal comes up: an attempt that started since the
    // listing owns its key.
    if (inFlight.has(journal.key) || recovering.has(journal.key)) continue;
    if (journal.status === 'installing') await recoverJournal(deps, journal);
    else if (isPrunable(journal, now)) await pruneJournal(deps, journal);
  }
}

/**
 * Finish or compensate attempts a crash interrupted, and prune journals that
 * are no longer needed. Callers share one pass: startup and every attempt
 * join the pass already running instead of starting a second. Attempts
 * running in this process are left to themselves. Never rejects.
 */
export function recoverForkCapabilityInstalls(
  deps: ForkCapabilityInstallDependencies = defaultDependencies,
): Promise<void> {
  const running = recoveryPasses.get(deps);
  if (running) return running;
  const pass = runRecoveryPass(deps).finally(() => {
    recoveryPasses.delete(deps);
  });
  recoveryPasses.set(deps, pass);
  return pass;
}

/** Test seam: the default dependencies, for partial overrides. */
export function defaultForkCapabilityInstallDependencies(): ForkCapabilityInstallDependencies {
  return { ...defaultDependencies };
}
