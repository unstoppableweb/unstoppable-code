// ---------------------------------------------------------------------------
// Materialize a shared skill's capability package into local skill folders.
//
// A pipeline or automation package stays in the package cache and is overlaid
// at run time, because it belongs to a run rather than to the user's library.
// A shared skill is the opposite: the recipient wants the skill itself, with
// its supporting files, sitting in their Skills tab where they can read it,
// edit it, and share it onward. So the package is verified into the cache for
// integrity and blob reuse, and its skill trees are then copied out into real
// local skills.
//
// Two rules are load-bearing:
//
//   - Never overwrite. A name already taken gets a deduplicated one and the
//     caller is told which. An install silently replacing local work is the
//     worst outcome available here. The one case that reuses an existing
//     folder — a re-import whose SKILL.md is byte-identical — writes only the
//     entries that folder does not already have, because "the same skill" does
//     not imply "every supporting file beside it is ours to replace".
//   - Never write outside the destination. Manifest paths are validated as
//     portable relative paths before they travel, and re-checked here against
//     the resolved destination, because this is the step that turns a manifest
//     string into a real filesystem write.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { runSkillMutation } from './skill-mutations';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
  capabilityPackageBindingKey,
  isSafeCapabilityPackagePath,
  type PipelinePackageManifestV1,
  type PipelinePackageRef,
  type PipelinePackageResource,
} from '@canopy/protocol/pipelines';
import { installPipelinePackageAtomically } from '@canopy/desktop-shared/node';
import {
  getPipelinePackageInstallStorePath,
  getPipelinePackagesDir,
} from '../lib/paths';
import { upsertCapabilityPackageInstall } from '../pipelines/pipeline-package-install-store';
import {
  getPublicSkillPackage,
  getPublicSkillPackageBlob,
  getSkillPackage,
  getSkillPackageBlob,
} from '../pipelines/canopy-server-client';
import type {
  InstallSkillCapabilityPackageRequest,
  InstallSkillCapabilityPackageResult,
  SharedSkillDetail,
} from '@canopy/desktop-shared/types/skills';
import type { CapabilityPackageInstallOwner } from '@canopy/execution-engine/types/pipeline';
import type { PipelinePackageDownload } from '../pipelines/canopy-server-client';
import { getSkillDir, getSourceDir } from './paths';
import { getSharedSkill } from './canopy-server-client';
import {
  assertStoredSkillContext,
  recordSharedSkillInstall,
  getSharedSkillInstallIds,
} from './skill-install-context';
import {
  assertSkillContextSnapshot,
  skillContextSnapshot,
  skillResourceContextEnabled,
} from './resource-lanes';

/** The only source id a shared-skill install ever writes to. */
const CUSTOM_SKILL_SOURCE_ID = 'custom:app';

/**
 * A local skill folder name must be a single portable path segment. Rejecting
 * anything else here keeps renderer-supplied values from reaching a bare
 * `path.join` and escaping the skills root.
 */
function assertSafeSkillFolderName(value: string, field: string): void {
  if (
    value.length === 0 ||
    value.length > 255 ||
    value.includes('/') ||
    value.includes('\\') ||
    value === '.' ||
    value === '..' ||
    !isSafeCapabilityPackagePath(value)
  ) {
    throw new Error(`Invalid ${field}`);
  }
}
/**
 * A folder this install creates or updates. Dot-prefixed names are reserved
 * for the skills folder's own staging; existing folders are still removable.
 */
function assertNewSkillFolderName(value: string, field: string): void {
  assertSafeSkillFolderName(value, field);
  if (value.startsWith('.')) throw new Error(`Invalid ${field}`);
}
const MAX_SUFFIX_ATTEMPTS = 100;
/** One worst-case bounded cloud read (about 110 s) plus a margin. */
export const MATERIALIZATION_CHECK_BUDGET_MS = 120_000;
/** The serialized checks ran out of time; nothing was written. */
export class MaterializationCheckTimeoutError extends Error {}

export interface InstallSubjectCapabilityPackageRequest {
  owner: CapabilityPackageInstallOwner;
  originExternalId?: string;
  packageRef: PipelinePackageRef;
  download: PipelinePackageDownload;
  fetchBlob(sha256: string): Promise<Uint8Array>;
  localContentHash?: string;
  /**
   * Persist subject changes that depend on the final installed skill names.
   * This runs inside the same rollback boundary as file copies and provenance.
   */
  finalizeInstall?(
    result: InstallSubjectCapabilityPackageResult,
  ): Promise<string | undefined>;
  /** Restore the subject if this install fails before provenance is durable. */
  rollbackFinalization?(): Promise<void>;
  /**
   * Told about each standalone skill folder once it is reserved and before
   * anything is written into it, so a caller can journal it ahead of a crash.
   * A rejection fails the install, which then rolls back as usual. The
   * primary skill of a skill import is not reported: its folder is the
   * import's own.
   */
  onSkillFolderReserved?(folder: ReservedSkillFolder): Promise<void>;
  /**
   * Runs the local materialization (reserve, copy, finalize, ledger and its
   * rollback) after the package blobs are fetched. Collections pass the skill
   * mutation lock; a caller that already holds it leaves this unset.
   */
  serializeMaterialization?: <T>(run: () => Promise<T>) => Promise<T>;
  /**
   * Re-checks the caller's authorization inside the serialized phase, before
   * any folder is made, within MATERIALIZATION_CHECK_BUDGET_MS. `expired`
   * reports that budget running out, so the check starts no cloud read after it.
   */
  checkBeforeMaterialization?(expired: () => boolean): Promise<void>;
  /** Skill imports already write their primary SKILL.md from the shared definition. */
  primarySkill?: {
    localName: string;
    rootName: string;
  };
  /**
   * Workspace-context provenance for a skill install. Every folder the install
   * binds is checked against the captured context, and a scoped share records
   * an install receipt for it.
   */
  skillContext?: {
    snapshot: string;
    detail?: SharedSkillDetail;
    reusableIds?: Set<string>;
  };
}

/** A local skill folder an install is about to write a packaged tree into. */
export interface ReservedSkillFolder {
  resourceId: string;
  localName: string;
  /**
   * True when this install made the folder. False when it reused a folder
   * that already held a byte-identical SKILL.md, which stays the user's.
   */
  created: boolean;
  /** The packaged files written into it (only missing ones when reused). */
  files: Array<{ path: string; sha256: string }>;
}

export interface InstallSubjectCapabilityPackageResult {
  supportingFileCount: number;
  /**
   * `resourceId` is the manifest resource each local skill came from, so a
   * caller that maps packaged definitions onto local names never has to
   * guess between two resources that share a root name.
   */
  installedSkills: Array<{
    name: string;
    localName: string;
    resourceId: string;
  }>;
  uninstalledResourceLabels: string[];
  keptLocalFiles: string[];
}

export async function installSkillCapabilityPackage(
  request: InstallSkillCapabilityPackageRequest,
): Promise<InstallSkillCapabilityPackageResult> {
  return runSkillMutation(() => installSkillCapabilityPackageUnlocked(request));
}

async function installSkillCapabilityPackageUnlocked(
  request: InstallSkillCapabilityPackageRequest,
): Promise<InstallSkillCapabilityPackageResult> {
  // These arrive from the renderer and reach `getSkillDir()`'s bare
  // `path.join`. The packaged `tree.rootName` is already constrained by the
  // manifest validator, but these two are not, so they are checked here.
  assertNewSkillFolderName(request.skillName, 'skillName');
  // A lookup key in the package, not a local folder.
  assertSafeSkillFolderName(request.primaryRootName, 'primaryRootName');
  const contextEnabled = skillResourceContextEnabled();
  const snapshot = contextEnabled ? await skillContextSnapshot() : undefined;
  // A public share ID is not an owned skill ID. Its public package response
  // verifies the portable source; only scoped installs carry an owner receipt.
  const detail =
    contextEnabled && !request.publicShare
      ? await getSharedSkill(request.remoteId)
      : undefined;
  const reusableIds = detail
    ? await getSharedSkillInstallIds(detail.id)
    : undefined;
  const download = request.publicShare
    ? await getPublicSkillPackage(request.remoteId, request.packageRef.digest)
    : await getSkillPackage(request.remoteId, request.packageRef.digest);
  if (download.digest !== request.packageRef.digest) {
    throw new Error(
      'The skill capability package changed. Refresh and review it before installing.',
    );
  }
  const installed = await installSubjectCapabilityPackage({
    owner: { kind: 'skill', localId: request.skillName },
    originExternalId: request.remoteId,
    packageRef: request.packageRef,
    download,
    fetchBlob: (sha256) =>
      request.publicShare
        ? getPublicSkillPackageBlob(
            request.remoteId,
            request.packageRef.digest,
            sha256,
          )
        : getSkillPackageBlob(
            request.remoteId,
            request.packageRef.digest,
            sha256,
          ),
    primarySkill: {
      localName: request.skillName,
      rootName: request.primaryRootName,
    },
    ...(snapshot !== undefined
      ? {
          skillContext: {
            snapshot,
            ...(detail ? { detail } : {}),
            ...(reusableIds ? { reusableIds } : {}),
          },
        }
      : {}),
  });
  return {
    supportingFilesComplete: installed.keptLocalFiles.length === 0,
    supportingFileCount: installed.supportingFileCount,
    installedDependencies: installed.installedSkills.map((skill) => ({
      name: skill.name,
      localName: skill.localName,
    })),
    uninstalledResourceLabels: installed.uninstalledResourceLabels,
    keptLocalFiles: installed.keptLocalFiles,
  };
}

/**
 * Materialize every standalone skill in a subject-bound package. The caller
 * supplies the authenticated/public transport so Agents, Collections and
 * Blueprints all share the same verified, no-overwrite, rollback-safe install
 * implementation.
 */
export async function installSubjectCapabilityPackage(
  request: InstallSubjectCapabilityPackageRequest,
): Promise<InstallSubjectCapabilityPackageResult> {
  let primarySkill = request.primarySkill;
  const download = request.download;
  const snapshot = request.skillContext?.snapshot;
  const detail = request.skillContext?.detail;
  const reusableIds = request.skillContext?.reusableIds;
  const receiptRollbacks: (() => Promise<void>)[] = [];
  let bound: PipelinePackageResource[] = [];
  const result: InstallSubjectCapabilityPackageResult = {
    supportingFileCount: 0,
    installedSkills: [],
    uninstalledResourceLabels: [],
    keptLocalFiles: [],
  };

  let primaryResourceIds = new Set<string>();

  // Everything this call creates, so a failure anywhere in the loop can be
  // undone as a whole. Rolling back only the dependency being copied left
  // earlier dependencies in the Skills tab and supporting files beside the
  // imported skill, while the ledger — written only on success — said nothing
  // was installed. Only what THIS install created is ever removed: a folder or
  // file the recipient already had is never touched.
  const undo: InstallUndo = {
    createdFolders: [],
    createdSubfolders: [],
    writtenFiles: [],
  };
  let cachedPackagePath = '';
  try {
    primarySkill = request.primarySkill;
    if (primarySkill) {
      assertNewSkillFolderName(primarySkill.localName, 'skillName');
      assertSafeSkillFolderName(primarySkill.rootName, 'primaryRootName');
    }
    if (download.digest !== request.packageRef.digest) {
      throw new Error(
        'The capability package changed. Refresh and review it before installing.',
      );
    }
    bound = subjectResources(download.manifest);
    primaryResourceIds = primarySkill
      ? findPrimaryResourceIds(
          bound,
          download.manifest.pipelineContentHash,
          primarySkill.rootName,
        )
      : new Set<string>();
    if (primarySkill) {
      // The primary is selected by the raw import boundary. Do not let a direct
      // package request attach its origin to an unrelated existing local folder.
      const primaryId = `${CUSTOM_SKILL_SOURCE_ID}/${primarySkill.localName}`;
      if (reusableIds && !reusableIds.has(primaryId)) {
        let exists = false;
        try {
          await fs.lstat(
            getSkillDir(CUSTOM_SKILL_SOURCE_ID, primarySkill.localName),
          );
          exists = true;
        } catch (error) {
          if (!isErrnoCode(error, 'ENOENT')) throw error;
        }
        if (exists)
          throw new Error('Resource install origin cannot be replaced');
      }
      await bindSkillOrigin(primarySkill.localName, undefined, 'primary');
    }
    cachedPackagePath = await installPipelinePackageAtomically({
      packagesRoot: getPipelinePackagesDir(),
      digest: download.digest,
      manifest: download.manifest,
      fetchBlob: (sha256) => request.fetchBlob(sha256),
    });
  } catch (error) {
    return rollBack(error);
  }
  const serialize =
    request.serializeMaterialization ??
    (<T>(run: () => Promise<T>): Promise<T> => run());
  // The rollback runs inside, so a failed install has undone its folders
  // before the next skill writer starts.
  await serialize(async () => {
    try {
      await copyBoundResources();
      if (snapshot !== undefined) await assertSkillContextSnapshot(snapshot);
      const localContentHash = request.finalizeInstall
        ? await request.finalizeInstall(result)
        : request.localContentHash;
      await upsertCapabilityPackageInstall(
        getPipelinePackageInstallStorePath(),
        {
          owner: request.owner,
          ...(request.originExternalId
            ? { originExternalId: request.originExternalId }
            : {}),
          ...(localContentHash ? { localContentHash } : {}),
          pipelineContentHash: download.manifest.pipelineContentHash,
          packageDigest: download.digest,
          installedAt: new Date().toISOString(),
          ...(request.owner.kind === 'skill'
            ? { supportingFilesComplete: result.keptLocalFiles.length === 0 }
            : {}),
        },
      );
    } catch (error) {
      await rollBack(error);
    }
  });
  return result;

  async function rollBack(error: unknown): Promise<never> {
    const rollbackResults = await Promise.allSettled([
      ...(request.rollbackFinalization
        ? [Promise.resolve().then(() => request.rollbackFinalization?.())]
        : []),
      rollBackInstall(undo),
      rollBackReceipts(),
    ]);
    const rollbackErrors: unknown[] = [];
    for (const result of rollbackResults) {
      if (result.status === 'rejected') rollbackErrors.push(result.reason);
    }
    if (rollbackErrors.length > 0) {
      const message = error instanceof Error ? error.message : 'Install failed';
      const rollbackMessage = rollbackErrors
        .map((rollbackError) =>
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError),
        )
        .join('; ');
      throw new Error(
        `${message}; rollback was incomplete: ${rollbackMessage}`,
      );
    }
    throw error;
  }

  async function bindSkillOrigin(
    name: string,
    localContentHash?: string,
    role: 'primary' | 'dependency' = 'dependency',
  ): Promise<void> {
    if (snapshot === undefined) return;
    await assertStoredSkillContext(`${CUSTOM_SKILL_SOURCE_ID}/${name}`);
    await recordSkillOrigin(name, localContentHash, role);
  }

  /** The local part of bindSkillOrigin, after its context check passed. */
  async function recordSkillOrigin(
    name: string,
    localContentHash?: string,
    role: 'primary' | 'dependency' = 'dependency',
  ): Promise<void> {
    if (snapshot === undefined) return;
    const localId = `${CUSTOM_SKILL_SOURCE_ID}/${name}`;
    if (detail) {
      // Dependency aliases carry their own SKILL.md baseline, never the
      // primary shared skill's hash.
      const rollback = await recordSharedSkillInstall(
        detail,
        localId,
        localContentHash,
        undefined,
        role,
      );
      if (rollback) receiptRollbacks.push(rollback);
      reusableIds?.add(localId);
    }
    await assertSkillContextSnapshot(snapshot);
  }

  async function rollBackReceipts(): Promise<void> {
    // Each receipt extends the same origin; unwind in reverse to retain aliases
    // that existed before this package attempt, including earlier imports.
    for (const rollback of receiptRollbacks.reverse()) await rollback();
  }

  /**
   * Pass 1 of a serialized install: picks every folder name and runs every
   * check that can reach the cloud, writing nothing, so an install that runs
   * out of time gives up before its first write. Keyed by resource id.
   */
  async function planBoundResources(
    expired = (): boolean => false,
  ): Promise<Map<string, { name: string; reused: boolean }>> {
    const plans = new Map<string, { name: string; reused: boolean }>();
    const planned: PlannedSkillNames = new Map();
    for (const resource of bound) {
      if (resource.kind !== 'standalone_skill') continue;
      const tree = preferredTree(resource);
      if (!tree) continue;
      if (primarySkill && primaryResourceIds.has(resource.id)) continue;
      const skillMd = tree.entries.find((entry) => entry.path === 'SKILL.md');
      const folder = await planSkillName(
        tree.rootName,
        skillMd,
        reusableIds,
        planned,
      );
      planned.set(folder.name.toLowerCase(), {
        name: folder.name,
        sha256: skillMd?.sha256,
      });
      if (snapshot !== undefined) {
        // A timed-out install starts no further lookup.
        if (expired()) break;
        await assertStoredSkillContext(
          `${CUSTOM_SKILL_SOURCE_ID}/${folder.name}`,
          undefined,
          expired,
        );
      }
      plans.set(resource.id, folder);
    }
    // Last, right before the first write, so it also covers the lookups.
    if (!expired()) await request.checkBeforeMaterialization?.(expired);
    return plans;
  }

  async function copyBoundResources(): Promise<void> {
    // A serialized install plans every name and runs its cloud checks first
    // (pass 1), so this loop only writes; other callers reserve and check one
    // resource at a time.
    const plans = request.serializeMaterialization
      ? await withinCheckBudget(planBoundResources)
      : undefined;
    for (const resource of bound) {
      if (resource.kind !== 'standalone_skill') {
        result.uninstalledResourceLabels.push(resource.displayName);
        continue;
      }
      const tree = preferredTree(resource);
      if (!tree) continue;
      if (primarySkill && primaryResourceIds.has(resource.id)) {
        // The import already wrote SKILL.md from the share's raw bytes, which
        // are the hashed source of truth. Copying it again from the package
        // would be redundant and, if the two ever disagreed, would silently
        // replace the content the content hash covers.
        //
        // `skipExisting` is unconditional here. On a fresh import the folder
        // holds only that SKILL.md, so it costs nothing; on a re-import, or for
        // a recipient who first took the definition-only version, the folder is
        // theirs and may hold files they wrote or edited.
        const primary = await copyTreeInto(
          cachedPackagePath,
          resource.id,
          tree,
          getSkillDir(CUSTOM_SKILL_SOURCE_ID, primarySkill.localName),
          {
            skipSkillMd: true,
            skipExisting: true,
            writtenFiles: undo.writtenFiles,
            createdSubfolders: undo.createdSubfolders,
          },
        );
        result.supportingFileCount += primary.copied;
        result.keptLocalFiles.push(
          ...primary.kept.map(
            (entryPath) => `${primarySkill.localName}/${entryPath}`,
          ),
        );
        continue;
      }
      const plan = plans?.get(resource.id);
      const plannedDir = plan && getSkillDir(CUSTOM_SKILL_SOURCE_ID, plan.name);
      if (plan && plannedDir && !plan.reused)
        await reserveSkillFolder(plannedDir, plan.name);
      // A writer without the lock may have changed a folder planned for reuse
      // during pass 1; refuse like a taken name so a retry plans again.
      if (
        plan?.reused &&
        plannedDir &&
        !undo.createdFolders.includes(plannedDir) &&
        !(await skillMdMatches(
          plannedDir,
          tree.entries.find((entry) => entry.path === 'SKILL.md'),
        ))
      )
        throw folderTakenError(plan.name);
      const reserved =
        plan ??
        (await reserveSkillName(
          tree.rootName,
          tree.entries.find((entry) => entry.path === 'SKILL.md'),
          reusableIds,
        ));
      const destination = getSkillDir(CUSTOM_SKILL_SOURCE_ID, reserved.name);
      // A folder this install created is removed whole on failure; a reused one
      // is the recipient's, so only the files written into it are.
      if (!reserved.reused) undo.createdFolders.push(destination);
      await request.onSkillFolderReserved?.({
        resourceId: resource.id,
        localName: reserved.name,
        created: !reserved.reused,
        files: tree.entries.map((entry) => ({
          path: entry.path,
          sha256: entry.sha256,
        })),
      });
      // Pass 1 already ran a planned name's context check.
      await (plan ? recordSkillOrigin : bindSkillOrigin)(
        reserved.name,
        tree.entries.find((entry) => entry.path === 'SKILL.md')?.sha256,
      );
      const dependency = await copyTreeInto(
        cachedPackagePath,
        resource.id,
        tree,
        destination,
        {
          skipSkillMd: false,
          // A reused folder already belongs to the recipient. Writing only the
          // entries it does not have keeps this file's "never overwrite" rule
          // intact — a byte-identical SKILL.md proves the skill is the same one,
          // not that every supporting file beside it is the package's to replace.
          skipExisting: reserved.reused,
          ...(reserved.reused
            ? {
                writtenFiles: undo.writtenFiles,
                createdSubfolders: undo.createdSubfolders,
              }
            : {}),
        },
      );
      result.keptLocalFiles.push(
        ...dependency.kept.map((entryPath) => `${reserved.name}/${entryPath}`),
      );
      result.installedSkills.push({
        name: tree.rootName,
        localName: reserved.name,
        resourceId: resource.id,
      });
    }
  }
}

/**
 * The resources that ARE the shared skill, as opposed to ones it invokes.
 *
 * Plural because the analysis emits one resource per provider for the shared
 * skill itself (a Claude tree and a Codex tree). Picking a single "primary"
 * left its twin to be installed as a dependency of itself — a duplicate skill
 * whenever the recipient's folder name differed from the publisher's. Each
 * twin's supporting files are copied beside the imported skill instead, so a
 * file only one provider's tree carries still lands; identical files are
 * no-ops under `skipExisting`.
 *
 * Matched by content, not name: a tree's `rootName` is the publisher's LOCAL
 * folder name, which is suffixed whenever they had imported the skill
 * themselves (`helper-2`), while the recipient's copy is named from the
 * frontmatter (`helper`). A skill's package is bound to its content hash, a
 * bare sha256 over the same SKILL.md bytes every one of these trees records.
 *
 * The name is kept only as a fallback for a package whose content hash no
 * tree matches.
 */
function findPrimaryResourceIds(
  resources: readonly PipelinePackageResource[],
  contentHash: string,
  primaryRootName: string,
): Set<string> {
  const skills = resources.filter(
    (resource) => resource.kind === 'standalone_skill',
  );
  const byContent = skills.filter((resource) =>
    resource.trees.some((tree) =>
      tree.entries.some(
        (entry) => entry.path === 'SKILL.md' && entry.sha256 === contentHash,
      ),
    ),
  );
  if (byContent.length > 0) {
    return new Set(byContent.map((resource) => resource.id));
  }
  const byName = skills.find(
    (resource) => preferredTree(resource)?.rootName === primaryRootName,
  );
  return new Set(byName ? [byName.id] : []);
}

/**
 * Resources the share bound to itself, plus their dependency closure.
 *
 * A skill package binds to the subject rather than to a step, so this is the
 * whole of what the publisher agreed to send.
 */
function subjectResources(
  manifest: PipelinePackageManifestV1,
): PipelinePackageResource[] {
  const byId = new Map(
    manifest.resources.map((resource) => [resource.id, resource]),
  );
  const rootIds =
    manifest.bindings.find(
      (binding) =>
        capabilityPackageBindingKey(binding) ===
        CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
    )?.resourceIds ?? [];
  const seen = new Set<string>();
  const pending = [...rootIds];
  const resolved: PipelinePackageResource[] = [];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const resource = byId.get(id);
    if (!resource) continue;
    resolved.push(resource);
    pending.push(...resource.dependencyResourceIds);
  }
  return resolved;
}

/**
 * A resource can carry one tree per provider. A local custom skill is a single
 * folder, so pick Claude's when present and otherwise the first available —
 * the two providers' standalone-skill trees are the same SKILL.md folder.
 */
function preferredTree(
  resource: PipelinePackageResource,
): PipelinePackageResource['trees'][number] | undefined {
  return (
    resource.trees.find((tree) => tree.provider === 'claude') ??
    resource.trees[0]
  );
}

async function copyTreeInto(
  cachedPackagePath: string,
  resourceId: string,
  tree: PipelinePackageResource['trees'][number],
  destinationDir: string,
  options: {
    skipSkillMd: boolean;
    skipExisting?: boolean;
    /**
     * Receives each file written into a folder that already existed, as it is
     * written, so a failure later in the same tree can still be undone.
     */
    writtenFiles?: string[];
    /**
     * Receives the topmost directory each write had to create inside a folder
     * that already existed. Everything under it is this install's, so it can be
     * removed whole on failure instead of leaving empty folders behind.
     */
    createdSubfolders?: string[];
  },
): Promise<{ copied: number; kept: string[] }> {
  const resolvedDestination = path.resolve(destinationDir);
  const treeRoot = path.join(
    cachedPackagePath,
    'materialized',
    resourceId,
    tree.provider,
    tree.rootName,
  );
  let copied = 0;
  const kept: string[] = [];
  for (const entry of tree.entries) {
    if (options.skipSkillMd && entry.path === 'SKILL.md') continue;
    // Re-validated here rather than trusted from the manifest: this is the
    // step that turns a manifest string into a real write. The result is held
    // as a plain boolean so the guard does not narrow the already-`string`
    // path to `never` in the failure branch, where it still has to be named.
    const entryPath = entry.path;
    const pathIsSafe: boolean = isSafeCapabilityPackagePath(entryPath);
    if (!pathIsSafe) {
      throw new Error(`Skill package contains an unsafe path: ${entryPath}`);
    }
    const target = path.resolve(resolvedDestination, ...entryPath.split('/'));
    if (
      target !== resolvedDestination &&
      !target.startsWith(`${resolvedDestination}${path.sep}`)
    ) {
      throw new Error(`Skill package path escapes its folder: ${entryPath}`);
    }
    const bytes = await fs.readFile(
      path.join(treeRoot, ...entryPath.split('/')),
    );
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error(`Skill package file failed verification: ${entryPath}`);
    }
    const createdDirectory = await fs.mkdir(path.dirname(target), {
      recursive: true,
    });
    if (createdDirectory !== undefined) {
      options.createdSubfolders?.push(createdDirectory);
    }
    const mode = entry.mode === 'execute' ? 0o700 : 0o600;
    if (options.skipExisting) {
      try {
        // `wx` fails with EEXIST rather than truncating, so the "is it already
        // there?" question and the write are one atomic operation. A stat-then-
        // write would leave a window in which the file appears and gets clobbered.
        await fs.writeFile(target, bytes, { flag: 'wx', mode });
        options.writtenFiles?.push(target);
      } catch (error) {
        if (!isErrnoCode(error, 'EEXIST')) throw error;
        // Written moments ago by this same install — the shared skill's other
        // provider tree carries the same path. That is not the recipient's
        // file, so it is neither kept nor reported.
        if (options.writtenFiles?.includes(target)) continue;
        // Theirs is kept either way. It is only worth telling them about when
        // it differs: an identical file on a re-import is not a conflict.
        const existing = await fs.readFile(target);
        if (!existing.equals(bytes)) kept.push(entryPath);
        continue;
      }
    } else {
      await fs.writeFile(target, bytes, { mode });
    }
    copied += 1;
  }
  return { copied, kept };
}

interface InstallUndo {
  /** Dependency folders this install created; removed whole on failure. */
  createdFolders: string[];
  /** Directories this install created inside folders that already existed. */
  createdSubfolders: string[];
  /** Files this install added to folders that already existed. */
  writtenFiles: string[];
}

/**
 * Remove what a failed install created, and nothing else. Best-effort: the
 * original error is what the caller needs to see, so a cleanup failure is not
 * allowed to replace it.
 */
async function rollBackInstall(undo: InstallUndo): Promise<void> {
  await Promise.allSettled([
    ...undo.writtenFiles.map((file) => fs.rm(file, { force: true })),
    ...[...undo.createdSubfolders, ...undo.createdFolders].map((folder) =>
      fs.rm(folder, { recursive: true, force: true }),
    ),
  ]);
}

/**
 * Remove a custom skill folder an earlier install created, but only while it
 * still holds nothing except packaged files with their packaged bytes. A
 * partly written folder qualifies; a folder with any edited, added or
 * non-regular entry is kept. Used to compensate an install interrupted before
 * its provenance was recorded, when the in-process rollback never ran.
 *
 * Known window, accepted: an edit landing between the check and the removal
 * is lost. Compensation runs on a folder the user has had no reason to open:
 * its install never finished.
 */
export async function removeMaterializedSkillFolder(
  localName: string,
  files: readonly { path: string; sha256: string }[],
): Promise<'removed' | 'kept' | 'missing'> {
  assertSafeSkillFolderName(localName, 'skillName');
  const folder = getSkillDir(CUSTOM_SKILL_SOURCE_ID, localName);
  const expected = new Map<string, Set<string>>();
  for (const file of files) {
    const hashes = expected.get(file.path) ?? new Set<string>();
    hashes.add(file.sha256);
    expected.set(file.path, hashes);
  }
  let isDirectory: boolean;
  try {
    isDirectory = (await fs.lstat(folder)).isDirectory();
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return 'missing';
    throw error;
  }
  if (!isDirectory) return 'kept';
  if (!(await holdsOnlyPackagedFiles(folder, '', expected))) return 'kept';
  await fs.rm(folder, { recursive: true, force: true });
  return 'removed';
}

async function holdsOnlyPackagedFiles(
  directory: string,
  prefix: string,
  expected: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<boolean> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!(await holdsOnlyPackagedFiles(absolute, relative, expected)))
        return false;
      continue;
    }
    // Links and special files are never something an install wrote.
    if (!entry.isFile()) return false;
    const hashes = expected.get(relative);
    if (!hashes) return false;
    const digest = createHash('sha256')
      .update(await fs.readFile(absolute))
      .digest('hex');
    if (!hashes.has(digest)) return false;
  }
  return true;
}

/** Narrow an unknown thrown value to a Node errno with the given code. */
function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

/**
 * Claim an unused local skill folder, walking the same numeric-suffix scheme
 * the raw-write import uses. Never returns a name that already exists.
 *
 * Known race, accepted: the folder is claimed by an empty `mkdir` before its
 * SKILL.md is written, so a second install of the same dependency running at
 * that instant cannot see the first one's SKILL.md yet and takes a suffixed
 * name instead of reusing it. The result is a duplicate skill, never an
 * overwrite, and concurrent installs of one dependency are rare enough that
 * serializing them is not worth the complexity.
 */
async function reserveSkillName(
  baseName: string,
  expectedSkillMd: { sha256: string } | undefined,
  reusableIds?: ReadonlySet<string>,
): Promise<{ name: string; reused: boolean }> {
  assertNewSkillFolderName(baseName, 'rootName');
  // The source directory has to exist before a non-recursive mkdir can
  // distinguish "this name is taken" (EEXIST) from "nothing is here yet"
  // (ENOENT). Installing a dependency skill must not depend on some earlier
  // write having created it.
  await fs.mkdir(getSourceDir(CUSTOM_SKILL_SOURCE_ID), { recursive: true });
  for (let attempt = 0; attempt < MAX_SUFFIX_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? baseName : `${baseName}-${attempt + 1}`;
    const directory = getSkillDir(CUSTOM_SKILL_SOURCE_ID, candidate);
    try {
      // Non-recursive on purpose: `recursive: true` succeeds on an existing
      // directory, which would hand back a name that is already in use and
      // let the copy overwrite the recipient's own skill.
      await fs.mkdir(directory, { recursive: false });
      return { name: candidate, reused: false };
    } catch (error) {
      if (isErrnoCode(error, 'EEXIST')) {
        // Taken — but possibly by a previous install of this very share.
        // Without this, re-importing (a double-clicked Import, a re-installed
        // Collection, a Collection naming the same skill twice) would pile up
        // `helper-2`, `helper-3`, … forever. Scoped imports also require the
        // same receipt: identical personal content must remain unbound.
        // The caller is told it was reused, because writing the full tree into
        // a folder the recipient already owns would overwrite their files.
        if (
          (!reusableIds ||
            reusableIds.has(`${CUSTOM_SKILL_SOURCE_ID}/${candidate}`)) &&
          (await skillMdMatches(directory, expectedSkillMd))
        ) {
          return { name: candidate, reused: true };
        }
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    `Could not install packaged skill "${baseName}": exhausted ${MAX_SUFFIX_ATTEMPTS} name-suffix attempts.`,
  );
}

/**
 * Picks an unused local skill folder name without creating it, walking the
 * same numeric-suffix scheme the raw-write import uses. A name already taken
 * holding a byte-identical SKILL.md (a re-import, or a Collection naming the
 * same skill twice) is reused instead, and scoped imports also require the
 * same receipt: identical personal content must remain unbound. `planned`
 * holds the names this install already picked, keyed case-folded since the
 * folders don't exist yet and the volume may ignore case; one of them is
 * reused for the same spelling and SKILL.md alone, as this install creates it.
 */
async function planSkillName(
  baseName: string,
  expectedSkillMd: { sha256: string } | undefined,
  reusableIds: ReadonlySet<string> | undefined,
  planned: PlannedSkillNames,
): Promise<{ name: string; reused: boolean }> {
  assertNewSkillFolderName(baseName, 'rootName');
  for (let attempt = 0; attempt < MAX_SUFFIX_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? baseName : `${baseName}-${attempt + 1}`;
    const directory = getSkillDir(CUSTOM_SKILL_SOURCE_ID, candidate);
    const reusable =
      !reusableIds || reusableIds.has(`${CUSTOM_SKILL_SOURCE_ID}/${candidate}`);
    const ours = planned.get(candidate.toLowerCase());
    if (ours) {
      // A case-only variant is another root: it gets its own folder.
      if (
        ours.name === candidate &&
        expectedSkillMd &&
        expectedSkillMd.sha256 === ours.sha256
      )
        return { name: candidate, reused: true };
      continue;
    }
    const exists = await fs.lstat(directory).then(
      () => true,
      (error: unknown) => {
        if (isErrnoCode(error, 'ENOENT')) return false;
        throw error;
      },
    );
    if (!exists) return { name: candidate, reused: false };
    if (reusable && (await skillMdMatches(directory, expectedSkillMd)))
      return { name: candidate, reused: true };
  }
  throw new Error(
    `Could not install packaged skill "${baseName}": exhausted ${MAX_SUFFIX_ATTEMPTS} name-suffix attempts.`,
  );
}

type PlannedSkillNames = Map<string, { name: string; sha256?: string }>;

/**
 * Creates a folder planSkillName picked. Non-recursive on purpose: a name
 * another writer took since is refused, never written into.
 */
async function reserveSkillFolder(
  directory: string,
  name: string,
): Promise<void> {
  await fs.mkdir(getSourceDir(CUSTOM_SKILL_SOURCE_ID), { recursive: true });
  try {
    await fs.mkdir(directory, { recursive: false });
  } catch (error) {
    if (!isErrnoCode(error, 'EEXIST')) throw error;
    throw folderTakenError(name);
  }
}

function folderTakenError(name: string): Error {
  return new Error(
    `Couldn't reserve the folder name "${name}": another skill change took it. Try again.`,
  );
}

/** Runs pass 1 within MATERIALIZATION_CHECK_BUDGET_MS. */
async function withinCheckBudget<T>(
  work: (expired: () => boolean) => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(
        new MaterializationCheckTimeoutError(
          "Couldn't re-check the package in time. Try again.",
        ),
      );
    }, MATERIALIZATION_CHECK_BUDGET_MS);
  });
  try {
    return await Promise.race([work(() => timedOut), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function skillMdMatches(
  directory: string,
  expected: { sha256: string } | undefined,
): Promise<boolean> {
  if (!expected) return false;
  try {
    const bytes = await fs.readFile(path.join(directory, 'SKILL.md'));
    return createHash('sha256').update(bytes).digest('hex') === expected.sha256;
  } catch {
    return false;
  }
}
