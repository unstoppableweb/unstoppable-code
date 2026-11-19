import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  hashPipelinePackageYaml,
  leasePipelinePackage,
} from '@canopy/desktop-shared/node';
import { AUTOMATION_PIPELINE_LOCAL_CHANGES_MESSAGE } from '@canopy/desktop-shared/lib/automation-install';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import type {
  AutomationCapabilityPackageRequest,
  AutomationExistingPipelineInstall,
  InstallAutomationPipelinesRequest,
  InstallAutomationPipelinesResponse,
  PreviewAutomationPipelinesRequest,
  PreviewAutomationPipelinesResponse,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type {
  Pipeline,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { PipelineDefinitionInstall } from '@canopy/core-runtime/node/pipeline';
import { SHARED_AUTOMATION_ACTION_PIPELINE_KEY } from '@canopy/protocol/automations';
import {
  AUTOMATION_PIPELINE_TREE_ENTRY_PATH,
  buildPackagedPipelineId,
  parsePackagedPipelineId,
  type PipelinePackageManifestV1,
  type PipelinePackageResource,
} from '@canopy/protocol/pipelines';
import {
  getPipelinePackageInstallStorePath,
  getPipelinePackagesDir,
} from '../lib/paths';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { validateId } from '../lib/validation';
import { assertStoredPipelineContext } from './pipeline-install-context';
import {
  beginPipelineInstallIntent,
  isPipelineDefinitionClaimed,
  type PipelineInstallIntent,
} from './pipeline-install-intents';
import {
  installPipelineAssets,
  previewPipelineAssetChanges,
} from './pipeline-asset-install';
import { upsertPipelinePackageInstall } from './pipeline-package-install-store';
import {
  cacheAutomationCapabilityPackage,
  downloadAutomationCapabilityPackage,
  findReusableUnlinkedPipeline,
  listPackageInstalls,
  recordInstalledPipelineMetadata,
} from './pipeline-package-service';
import * as localPipelineService from './pipeline-service';

/**
 * Stage A of an automation install: materialize the package's
 * `automation_pipeline` resources as local user pipelines before the
 * automation exists, link each to the package with a pipeline-owner install
 * record, and install the files each declares. Each pipeline installs
 * through `core.pipeline.definition.import` of its `package-pipeline:`
 * remote, which reads it from the verified package
 * ({@link readPackagedPipelineRemote}); Stage A decides where each one goes
 * and names the local pipeline it updates. Electron-main compatibility path
 * for `core.initiatedWork`; no daemon route serves packages yet.
 *
 * Outcomes, per packaged pipeline key:
 * - `kept`: the recorded local pipeline (`existingPipelines`) already has
 *   this exact YAML; nothing is rewritten.
 * - `reused`: an existing local pipeline is used. Either the recorded one,
 *   rewritten in place with the new YAML because the share changed it
 *   upstream (an update; its local copy still matched what was installed),
 *   or one already linked to this package and hash (a retried Stage A), or,
 *   for a dependency, an unlinked local pipeline with identical YAML. The
 *   automation's own action pipeline never reuses an unlinked one: the
 *   automation owns it and deletes it with itself (CAN-7285).
 * - `created`: a new user pipeline was saved. Project pipelines install as
 *   user pipelines with the same name.
 *
 * Every recorded pipeline and every blob is checked before anything is
 * written, so a refusal (a locally edited pipeline, a blob that doesn't
 * match its hash) leaves no pipeline, record or file behind. Each pipeline's
 * files are installed before its install record, and every write is noted in
 * the install's intent record first (CAN-5633): a failure, or an exit that
 * startup recovery finds, removes the pipelines it created and restores the
 * ones it rewrote or linked, with their records and the supporting files it
 * overwrote or added (CAN-5677). A retry is idempotent.
 *
 * {@link previewAutomationPipelines} runs the same checks and decisions for
 * the update review and writes nothing but the package cache.
 *
 * `existingPipelines` entries whose key the package no longer lists are
 * ignored here: the dependency keeps its local pipeline, and Stage B unlinks
 * it from the previous package once the automation moves to the new one.
 */

interface PackagedPipelineResource {
  key: string;
  pipelineContentHash: string;
  displayName: string;
  sha256: string;
  assets: PipelinePackageResource[];
}

interface PackagedPipelineDocument extends PackagedPipelineResource {
  rawPipeline: string;
  pipeline: Pipeline;
}

/** Host facts for Stage A that never come from the renderer's request. */
export interface AutomationPipelineInstallOptions {
  /**
   * Local pipelines installed automations already record. Stage A never
   * takes one over for another key or another copy of the share: each
   * installed copy keeps its own pipelines, so updating or removing one copy
   * never changes another's.
   */
  recordedPipelineIds?: ReadonlySet<string>;
}

/** The local pipelines installed automations record, by `installedFrom`. */
export function pipelinesRecordedByAutomations(
  activities: readonly ScheduledActivity[],
): Set<string> {
  const recorded = new Set<string>();
  for (const activity of activities) {
    const installedFrom = activity.installedFrom;
    if (!installedFrom) continue;
    if (installedFrom.bundledPipelineLocalId !== undefined) {
      recorded.add(installedFrom.bundledPipelineLocalId);
    }
    for (const dependency of installedFrom.pipelineDependencies ?? []) {
      recorded.add(dependency.localPipelineId);
    }
  }
  return recorded;
}

type PipelineInstallPlan =
  | { outcome: 'kept'; localPipelineId: string }
  | { outcome: 'reused'; localPipelineId: string; rewrite: boolean }
  | { outcome: 'created' };

function invalidPackage(detail: string): Error {
  return new Error(
    `The automation package is invalid (${detail}). Ask the author to share it again.`,
  );
}

/** The package's pipelines and the files each declares, validated. */
function packagedPipelineResources(
  manifest: PipelinePackageManifestV1,
): PackagedPipelineResource[] {
  const pipelines = new Map<string, PackagedPipelineResource>();
  for (const resource of manifest.resources) {
    if (resource.kind !== 'automation_pipeline') continue;
    const key = resource.pipelineKey;
    const pipelineContentHash = resource.pipelineContentHash;
    const [tree] = resource.trees;
    const [entry] = tree?.entries ?? [];
    if (
      key === undefined ||
      pipelineContentHash === undefined ||
      resource.trees.length !== 1 ||
      tree?.entries.length !== 1 ||
      entry?.path !== AUTOMATION_PIPELINE_TREE_ENTRY_PATH ||
      pipelines.has(key)
    ) {
      throw invalidPackage(`pipeline ${resource.id}`);
    }
    // The blob must be the pipeline the share document pins.
    if (entry.sha256 !== pipelineContentHash) {
      throw invalidPackage(`"${resource.displayName}" doesn't match its hash`);
    }
    pipelines.set(key, {
      key,
      pipelineContentHash,
      displayName: resource.displayName,
      sha256: entry.sha256,
      assets: [],
    });
  }
  for (const resource of manifest.resources) {
    if (resource.kind !== 'file_asset') continue;
    const owner =
      resource.pipelineKey === undefined
        ? undefined
        : pipelines.get(resource.pipelineKey);
    if (!owner) throw invalidPackage(`file ${resource.id}`);
    owner.assets.push(resource);
  }
  return Array.from(pipelines.values());
}

/** The local pipeline's current YAML hash, or undefined when it is gone. */
function currentPipelineHash(localPipelineId: string): string | undefined {
  const raw = localPipelineService.getPipelineText(localPipelineId);
  return raw.success && raw.data !== undefined
    ? hashPipelinePackageYaml(raw.data)
    : undefined;
}

async function readPackagedPipeline(
  packagePath: string,
  resource: PackagedPipelineResource,
): Promise<PackagedPipelineDocument> {
  const bytes = await readFile(
    path.join(packagePath, 'blobs', resource.sha256),
  );
  let rawPipeline: string;
  try {
    rawPipeline = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidPackage(`"${resource.displayName}" isn't text`);
  }
  // The local store compares string hashes, so check the decoded text too.
  if (hashPipelinePackageYaml(rawPipeline) !== resource.pipelineContentHash) {
    throw invalidPackage(`"${resource.displayName}" doesn't match its hash`);
  }
  let pipeline: Pipeline;
  try {
    pipeline = parsePipelineText(rawPipeline);
  } catch {
    throw invalidPackage(`"${resource.displayName}" isn't a valid pipeline`);
  }
  return { ...resource, rawPipeline, pipeline };
}

interface PlannedAutomationPipelines {
  packageDigest: string;
  packagePath: string;
  documents: PackagedPipelineDocument[];
  plans: PipelineInstallPlan[];
}

/**
 * Everything Stage A checks and decides before it writes: the package is the
 * reviewed one, no recorded pipeline was edited locally, every blob matches
 * its hash, and where each pipeline goes. Writes only the package cache.
 */
async function planAutomationPipelines(
  request: AutomationCapabilityPackageRequest & {
    existingPipelines?: AutomationExistingPipelineInstall[];
  },
  options: AutomationPipelineInstallOptions,
): Promise<PlannedAutomationPipelines> {
  const download = await downloadAutomationCapabilityPackage(request);
  const resources = packagedPipelineResources(download.manifest);
  const resourceByKey = new Map(
    resources.map((resource) => [resource.key, resource]),
  );
  const recordedByKey = new Map<
    string,
    { localPipelineId: string; expectedContentHash: string }
  >();
  for (const existing of request.existingPipelines ?? []) {
    validateId(existing.localPipelineId, 'pipeline id');
    if (!resourceByKey.has(existing.key)) continue;
    recordedByKey.set(existing.key, existing);
  }
  // A recorded pipeline edited since it was installed refuses the whole
  // install, before anything is written. One that already has the new YAML
  // is not an edit.
  for (const [key, recorded] of Array.from(recordedByKey)) {
    const current = currentPipelineHash(recorded.localPipelineId);
    if (
      current !== undefined &&
      current !== recorded.expectedContentHash &&
      current !== resourceByKey.get(key)?.pipelineContentHash
    ) {
      throw new Error(AUTOMATION_PIPELINE_LOCAL_CHANGES_MESSAGE);
    }
  }
  const packagePath = await cacheAutomationCapabilityPackage(download);
  const documents: PackagedPipelineDocument[] = [];
  for (const resource of resources) {
    documents.push(await readPackagedPipeline(packagePath, resource));
  }

  // Decide where each pipeline goes, still without writing.
  const installs = await listPackageInstalls();
  const assigned = new Set<string>();
  const plans: PipelineInstallPlan[] = [];
  for (const document of documents) {
    const plan = await planPipelineInstall(
      document,
      recordedByKey.get(document.key),
      installs,
      download.digest,
      assigned,
      options.recordedPipelineIds ?? new Set(),
    );
    if (plan.outcome !== 'created') assigned.add(plan.localPipelineId);
    plans.push(plan);
  }
  return { packageDigest: download.digest, packagePath, documents, plans };
}

/**
 * The update review's dry run of Stage A: the same checks and decisions,
 * plus each pipeline's shared YAML and what install would do to the files of
 * a pipeline already on this computer. Saves no pipeline, record or file.
 */
export async function previewAutomationPipelines(
  request: PreviewAutomationPipelinesRequest,
  options: AutomationPipelineInstallOptions = {},
): Promise<PreviewAutomationPipelinesResponse> {
  const { documents, plans } = await planAutomationPipelines(request, options);
  const pipelines: PreviewAutomationPipelinesResponse['pipelines'] = [];
  for (let index = 0; index < documents.length; index += 1) {
    const document = documents[index];
    const plan = plans[index];
    if (!document || !plan) continue;
    const localPipelineId =
      plan.outcome === 'created' ? undefined : plan.localPipelineId;
    pipelines.push({
      key: document.key,
      ...(localPipelineId !== undefined ? { localPipelineId } : {}),
      pipelineContentHash: document.pipelineContentHash,
      outcome: plan.outcome,
      rewrites: plan.outcome === 'reused' && plan.rewrite,
      rawPipeline: document.rawPipeline,
      assetChanges:
        localPipelineId !== undefined && document.assets.length > 0
          ? await previewPipelineAssetChanges({
              localPipelineId,
              resources: document.assets,
            })
          : [],
    });
  }
  return { pipelines };
}

export async function installAutomationPipelines(
  request: InstallAutomationPipelinesRequest,
  options: AutomationPipelineInstallOptions = {},
): Promise<InstallAutomationPipelinesResponse> {
  const intent = await beginPipelineInstallIntent('automation');
  // Held until every install record names the package, so another install's
  // rollback cannot remove it in between.
  const lease = leasePipelinePackage(
    getPipelinePackagesDir(),
    request.packageRef.digest,
  );
  try {
    const response = await installPlannedAutomationPipelines(
      intent,
      await planAutomationPipelines(request, options),
    );
    await intent.finish();
    return response;
  } catch (error) {
    await intent.rollBack().catch((rollbackError: unknown) => {
      logMainProcessWarn(
        '[automation-install] Could not roll back an automation install',
        rollbackError,
      );
    });
    throw error;
  } finally {
    lease.release();
  }
}

/** The Stage A install a packaged pipeline's remote installs into. */
interface AutomationPipelineInstallSession {
  readonly intent: PipelineInstallIntent;
  readonly packageDigest: string;
  readonly packagePath: string;
  readonly resources: ReadonlyMap<string, PackagedPipelineResource>;
  /** The keys Stage A planned to rewrite in place; others are only linked. */
  readonly rewrites: ReadonlySet<string>;
}

const automationPipelineInstalls =
  new AsyncLocalStorage<AutomationPipelineInstallSession>();

async function installPlannedAutomationPipelines(
  intent: PipelineInstallIntent,
  { packageDigest, packagePath, documents, plans }: PlannedAutomationPipelines,
): Promise<InstallAutomationPipelinesResponse> {
  const { importRemotePipeline } =
    await import('../canopy-runtime/pipeline-definition-dispatch');
  const session: AutomationPipelineInstallSession = {
    intent,
    packageDigest,
    packagePath,
    resources: new Map(documents.map((document) => [document.key, document])),
    rewrites: new Set(
      documents
        .filter((_document, index) => {
          const plan = plans[index];
          return plan?.outcome === 'reused' && plan.rewrite;
        })
        .map((document) => document.key),
    ),
  };
  return automationPipelineInstalls.run(session, async () => {
    const pipelines: InstallAutomationPipelinesResponse['pipelines'] = [];
    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index];
      const plan = plans[index];
      if (!document || !plan) continue;
      let installed: PipelineInfo;
      try {
        installed = await importRemotePipeline({
          remoteDefinitionId: buildPackagedPipelineId({
            packageDigest,
            pipelineKey: document.key,
          }),
          expectedRemoteVersion: document.pipelineContentHash,
          // Prompts name a project pipeline by the name the author saw.
          nameOverride: document.displayName || document.pipeline.name,
          ...(plan.outcome === 'created'
            ? {}
            : { definitionId: plan.localPipelineId }),
        });
      } catch (error) {
        throw error instanceof CanopyOperationError
          ? new Error(error.payload.message)
          : error;
      }
      pipelines.push({
        key: document.key,
        localPipelineId: installed.id,
        pipelineContentHash: document.pipelineContentHash,
        outcome: plan.outcome,
      });
    }
    return { pipelines };
  });
}

/** A packaged pipeline as the desktop's remote reader hands it to core. */
export interface PackagedPipelineRemote {
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly rawPipeline: string;
  readonly remoteVersion: string;
  install(write: PipelineDefinitionInstall): Promise<PipelineInfo>;
}

/**
 * A pipeline the capability package of a running Stage A install carries,
 * read from the verified package cache, as a remote core installs from.
 * Its version is the pipeline's content hash. The install creates the
 * local pipeline under the id core chose, or updates the one Stage A named
 * (keeping the recipient's name, description and icon, or only linking it
 * when it already has this YAML), then installs its files and its install
 * record, noting each write in the install's intent record first.
 */
export async function readPackagedPipelineRemote(
  remoteDefinitionId: string,
): Promise<PackagedPipelineRemote | null> {
  const ref = parsePackagedPipelineId(remoteDefinitionId);
  if (!ref) return null;
  const session = automationPipelineInstalls.getStore();
  if (!session || session.packageDigest !== ref.packageDigest)
    throw new Error('A packaged workflow installs with its automation.');
  const resource = session.resources.get(ref.pipelineKey);
  if (!resource) return null;
  const document = await readPackagedPipeline(session.packagePath, resource);
  const { intent } = session;
  return {
    name: document.displayName || document.pipeline.name,
    description: document.pipeline.description ?? '',
    icon: document.pipeline.icon ?? '',
    rawPipeline: document.rawPipeline,
    remoteVersion: document.pipelineContentHash,
    install: async (write) => {
      const localPipelineId = await materializePipeline(
        document,
        write,
        session.rewrites.has(document.key),
        intent,
      );
      if (
        currentPipelineHash(localPipelineId) !== document.pipelineContentHash
      ) {
        throw new Error(
          `"${document.displayName}" could not be saved exactly as shared. Try installing again.`,
        );
      }
      // Files first: a recorded pipeline always has every file it declares.
      if (document.assets.length > 0) {
        await installPipelineAssets({
          localPipelineId,
          packagePath: session.packagePath,
          resources: document.assets,
          beforeWrite: (plan) => intent.noteAssetFiles(localPipelineId, plan),
        });
      }
      const record = {
        localPipelineId,
        pipelineContentHash: document.pipelineContentHash,
        distributionMode: 'package' as const,
        packageDigest: session.packageDigest,
        installedAt: new Date().toISOString(),
      };
      await intent.noteInstallRecord(localPipelineId, record);
      await upsertPipelinePackageInstall(
        getPipelinePackageInstallStorePath(),
        record,
      );
      const stored = localPipelineService.getPipeline(localPipelineId);
      if (!stored.success || !stored.data)
        throw new Error(
          stored.error ?? `"${document.displayName}" could not be read`,
        );
      return stored.data.info;
    },
  };
}

async function canUsePipeline(localPipelineId: string): Promise<boolean> {
  try {
    await assertStoredPipelineContext(localPipelineId);
    return true;
  } catch {
    return false;
  }
}

async function planPipelineInstall(
  document: PackagedPipelineDocument,
  recorded: { localPipelineId: string } | undefined,
  installs: Awaited<ReturnType<typeof listPackageInstalls>>,
  packageDigest: string,
  assigned: ReadonlySet<string>,
  recordedByAutomations: ReadonlySet<string>,
): Promise<PipelineInstallPlan> {
  if (recorded && !assigned.has(recorded.localPipelineId)) {
    const current = currentPipelineHash(recorded.localPipelineId);
    if (current !== undefined) {
      // The recorded pipeline belongs to this automation's earlier install;
      // it must still be usable in the current context.
      await assertStoredPipelineContext(recorded.localPipelineId);
      return current === document.pipelineContentHash
        ? { outcome: 'kept', localPipelineId: recorded.localPipelineId }
        : {
            outcome: 'reused',
            localPipelineId: recorded.localPipelineId,
            rewrite: true,
          };
    }
  }
  // Past this point a pipeline is reused only when no installed automation
  // records it: another copy's pipeline stays that copy's.
  const taken = new Set(assigned);
  recordedByAutomations.forEach((localPipelineId) => {
    taken.add(localPipelineId);
  });
  // A pipeline an earlier attempt linked to this package and hash; never
  // one an install still running created, which its rollback would remove.
  for (const install of installs) {
    if (
      install.distributionMode === 'definition_only' ||
      install.packageDigest !== packageDigest ||
      install.pipelineContentHash !== document.pipelineContentHash ||
      taken.has(install.localPipelineId) ||
      isPipelineDefinitionClaimed(install.localPipelineId) ||
      currentPipelineHash(install.localPipelineId) !==
        document.pipelineContentHash ||
      !(await canUsePipeline(install.localPipelineId))
    )
      continue;
    return {
      outcome: 'reused',
      localPipelineId: install.localPipelineId,
      rewrite: false,
    };
  }
  // CAN-7285: the automation owns the pipeline its action runs and deletes
  // it with itself, so that one is never a local pipeline the person
  // already had; only a dependency reuses one.
  if (document.key === SHARED_AUTOMATION_ACTION_PIPELINE_KEY)
    return { outcome: 'created' };
  const unlinked = await findReusableUnlinkedPipeline(
    document.pipelineContentHash,
    taken,
  );
  if (unlinked && (await canUsePipeline(unlinked))) {
    return { outcome: 'reused', localPipelineId: unlinked, rewrite: false };
  }
  return { outcome: 'created' };
}

async function materializePipeline(
  document: PackagedPipelineDocument,
  write: PipelineDefinitionInstall,
  rewrite: boolean,
  intent: PipelineInstallIntent,
): Promise<string> {
  const localPipelineId = write.definitionId;
  if (write.replaces) {
    // Kept, or reused as it is: only linked, so an edit made since Stage A
    // planned fails the exact-bytes check instead of being overwritten.
    if (!rewrite) {
      await intent.noteDefinition({
        definitionId: localPipelineId,
        change: 'linked',
        contentHash: document.pipelineContentHash,
      });
      return localPipelineId;
    }
    // Rewrite in place, keeping the recipient's name, description and icon.
    const existing = localPipelineService.getPipeline(localPipelineId);
    if (!existing.success || !existing.data) {
      throw new Error(
        existing.error ?? `"${document.displayName}" could not be read`,
      );
    }
    await intent.noteDefinition({
      definitionId: localPipelineId,
      change: 'replaced',
      contentHash: document.pipelineContentHash,
    });
    const saved = localPipelineService.savePipeline({
      id: localPipelineId,
      name: existing.data.info.name,
      description: existing.data.info.description,
      icon: existing.data.info.icon,
      content: write.pipeline,
      rawContent: write.text,
    });
    if (!saved.success) {
      throw new Error(
        saved.error ?? `"${document.displayName}" could not be updated`,
      );
    }
    await recordInstalledPipelineMetadata(localPipelineId, false, true);
    return localPipelineId;
  }
  await intent.noteDefinition({
    definitionId: localPipelineId,
    change: 'created',
    contentHash: document.pipelineContentHash,
    assets: true,
  });
  const saved = localPipelineService.savePipeline(
    {
      name: write.name,
      description: write.description,
      icon: write.icon,
      content: write.pipeline,
      rawContent: write.text,
    },
    { id: localPipelineId },
  );
  if (!saved.success || !saved.data) {
    throw new Error(
      saved.error ?? `"${document.displayName}" could not be saved`,
    );
  }
  await recordInstalledPipelineMetadata(saved.data.id, true, true);
  return saved.data.id;
}
