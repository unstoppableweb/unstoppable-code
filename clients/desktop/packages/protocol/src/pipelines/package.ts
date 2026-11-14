import {
  CAPABILITY_FILE_SHA256_PATTERN,
  base64UrlEncode,
  isPortableCapabilityPathSegment,
  isSafeCapabilityRelativePath,
} from '../capability-files';
import {
  InstalledItemRefSchema,
  type InstalledItemRef,
} from '../installed-items';

export const PIPELINE_PACKAGE_VERSION = 1 as const;
/**
 * Lowest desktop build that can read every field this repo can publish.
 *
 * The wire format stays at {@link PIPELINE_PACKAGE_VERSION} 1 forever — the
 * manifest validator rejects any other value, so a bump would strand every
 * package already uploaded. Additive fields are negotiated through this
 * separate client version instead: a publisher's manifest declares the oldest
 * client that understands it (`requiredCapabilityPackageClientVersion`), and
 * an older desktop is served the projection it does understand.
 *
 * 1 — resources, step bindings, environment requirements.
 * 2 — publisher notes.
 * 3 — whole-share (subject) bindings.
 * 4 — packaged project actions and child pipelines.
 * 5 — portable pipeline, automation, Agent and hook definition resources;
 *     original installed-item refs for enforcing Disabled on pinned resources.
 * 6 — automation pipelines and pipeline file assets.
 */
export const PIPELINE_PACKAGE_CLIENT_VERSION = 6 as const;
export const PIPELINE_PACKAGE_VERSION_HEADER = 'X-Pipeline-Package-Version';

export const PIPELINE_PACKAGE_MAX_FILES = 1_024;
export const PIPELINE_PACKAGE_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const PIPELINE_PACKAGE_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const PIPELINE_PACKAGE_MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

export type PipelineDistributionMode = 'package' | 'definition_only';

export interface PipelineShareInstallPin {
  pipelineContentHash: string;
  distributionMode: PipelineDistributionMode;
  packageDigest?: string;
}

export interface PipelinePackageFileEntry {
  path: string;
  sha256: string;
  size: number;
  mode: 'read' | 'execute';
}

export interface PipelinePackageTree {
  provider: 'claude' | 'codex';
  /**
   * `automation_pipeline` trees carry one `pipeline.yaml` entry and belong only
   * to `automation_pipeline` resources; `pipeline_asset` trees belong only to
   * `file_asset` resources.
   */
  runtimeKind:
    | 'plugin_fragment'
    | 'standalone_skill'
    | 'automation_pipeline'
    | 'pipeline_asset';
  rootName: string;
  entries: PipelinePackageFileEntry[];
}

/** Definition documents are provider-neutral payloads in one existing read tree. */
export const CAPABILITY_PACKAGE_DEFINITION_KINDS = [
  'pipeline_definition',
  'automation_definition',
  'agent_definition',
  'hook_definition',
] as const;

export interface PipelinePackageResource {
  /** Original selection identity, retained so pinning cannot bypass Disabled. */
  installedItemRef?: Extract<InstalledItemRef, { kind: 'plugin' | 'skill' }>;
  id: string;
  kind:
    | 'standalone_skill'
    | 'plugin_skill'
    | 'plugin_command'
    | 'plugin_agent'
    | 'pipeline_action'
    | 'child_pipeline'
    | 'automation_pipeline'
    | 'file_asset'
    | 'pipeline_definition'
    | 'automation_definition'
    | 'agent_definition'
    | 'hook_definition';
  displayName: string;
  sourceLabel: string;
  sourceVisibility: 'builtin' | 'public' | 'private' | 'local';
  invocationKeys: string[];
  dependencyResourceIds: string[];
  trees: PipelinePackageTree[];
  /**
   * Portable key of the pipeline this resource is or belongs to. Required on
   * `automation_pipeline` (unique per manifest) and `file_asset` (names an
   * `automation_pipeline` resource in the same manifest); absent otherwise.
   */
  pipelineKey?: string;
  /** Hash of the packaged pipeline YAML. Required on `automation_pipeline`. */
  pipelineContentHash?: string;
  /** Asset id declared by the pipeline. Required on `file_asset`. */
  assetId?: string;
  /** How install writes the asset. Required on `file_asset`. */
  installMode?: PipelineAssetInstallMode;
  /** Whether the pipeline needs the asset to run. Required on `file_asset`. */
  required?: boolean;
}

export type PipelineAssetInstallMode = 'seed' | 'replace';

export interface PipelinePackageStepBinding {
  jobId: string;
  stepId: string;
  resourceIds: string[];
}

/**
 * Binds resources to the share as a whole.
 *
 * Pipelines bind per step because a step is the unit that runs. Every other
 * shareable subject — a skill, an Agent, a Collection, a Blueprint — has no
 * steps, so it binds once to itself rather than inventing a synthetic step to
 * hang resources from.
 */
export interface PipelinePackageSubjectBinding {
  target: 'subject';
  resourceIds: string[];
}

export type PipelinePackageBinding =
  | PipelinePackageStepBinding
  | PipelinePackageSubjectBinding;

export function isPipelinePackageSubjectBinding(
  binding: PipelinePackageBinding,
): binding is PipelinePackageSubjectBinding {
  // `in` narrows without a cast, which the repo's strict rules require.
  return 'target' in binding && binding.target === 'subject';
}

/**
 * The files in a resource that run as programs, each listed once. A resource
 * carries one tree per provider with the same relative paths, so a path is
 * deduplicated across trees. Share and install surfaces name these on their
 * own line rather than folding them into a file count, because whether to
 * accept code that runs is the recipient's call.
 */
export function listCapabilityPackageExecutablePaths(
  resource: Pick<PipelinePackageResource, 'trees'>,
): string[] {
  const paths = new Set<string>();
  for (const tree of resource.trees) {
    for (const entry of tree.entries) {
      if (entry.mode === 'execute') paths.add(entry.path);
    }
  }
  return Array.from(paths).sort();
}

type ProviderTwinCandidate = Pick<
  PipelinePackageResource,
  'kind' | 'sourceLabel' | 'sourceVisibility' | 'trees'
>;

function resourceProviders(resource: ProviderTwinCandidate): Set<string> {
  return new Set(resource.trees.map((tree) => tree.provider));
}

function providerTwinKey(resource: ProviderTwinCandidate): string | null {
  if (
    resource.kind !== 'standalone_skill' ||
    resource.trees.length === 0 ||
    resource.trees.some((tree) => tree.runtimeKind !== 'standalone_skill')
  ) {
    return null;
  }
  const roots = Array.from(
    new Set(resource.trees.map((tree) => tree.rootName)),
  ).sort(compareStrings);
  return [
    resource.kind,
    resource.sourceVisibility,
    resource.sourceLabel,
    ...roots,
  ].join('\0');
}

/**
 * Group the resources a reader should show as one item.
 *
 * The analyzer keys resources by provider, so a skill packaged for both Claude
 * and Codex arrives as two resources over the same folder, differing only in
 * provider and invocation name (the Codex one is often generated, like
 * `$builtin-app-plugin:<name>`). Listing both tells a publisher or recipient
 * that the skill travels twice. Two standalone skills are twins when they
 * share a kind, source, and root folder name and come from different
 * providers. Each group lists its Claude resource first, so its invocation
 * name is the one shown; groups keep the order of their first member.
 *
 * Display only: the manifest, its bindings, and its digest are unchanged.
 */
export function groupCapabilityPackageProviderTwins<
  T extends ProviderTwinCandidate,
>(resources: readonly T[]): T[][] {
  const groups: T[][] = [];
  const openGroups = new Map<string, T[][]>();
  for (const resource of resources) {
    const key = providerTwinKey(resource);
    const providers = resourceProviders(resource);
    const candidates = key === null ? [] : (openGroups.get(key) ?? []);
    const group = candidates.find((members) =>
      members.every((member) =>
        Array.from(resourceProviders(member)).every(
          (provider) => !providers.has(provider),
        ),
      ),
    );
    if (group) {
      group.push(resource);
      continue;
    }
    const created = [resource];
    groups.push(created);
    if (key !== null) openGroups.set(key, [...candidates, created]);
  }
  return groups.map((group) =>
    [...group].sort(
      (left, right) =>
        Number(!resourceProviders(left).has('claude')) -
        Number(!resourceProviders(right).has('claude')),
    ),
  );
}

/**
 * Files and bytes across `resources`, counting a file once when several
 * provider copies carry the same path with the same content. This is the
 * number a person means by "how many files arrive"; the manifest's own
 * totals count every copy, which the format needs and a reader does not.
 */
export function countCapabilityPackageDistinctFiles(
  resources: ReadonlyArray<Pick<PipelinePackageResource, 'trees'>>,
): { files: number; bytes: number } {
  const seen = new Map<string, number>();
  for (const resource of resources) {
    for (const tree of resource.trees) {
      for (const entry of tree.entries) {
        seen.set(
          `${tree.rootName}\0${entry.path}\0${entry.sha256}`,
          entry.size,
        );
      }
    }
  }
  // `Array.from`, not `for…of`: the web typecheck targets an ES level that
  // cannot iterate a Map directly.
  const bytes = Array.from(seen.values()).reduce(
    (total, size) => total + size,
    0,
  );
  return { files: seen.size, bytes };
}

/**
 * Key a binding by what it binds to.
 *
 * A step binding's job id is required to be non-empty, so no step key can
 * begin with NUL and the subject key can never collide with one.
 */
export const PIPELINE_PACKAGE_SUBJECT_BINDING_KEY = '\0subject';

export function pipelinePackageBindingKey(
  binding: PipelinePackageBinding,
): string {
  return isPipelinePackageSubjectBinding(binding)
    ? PIPELINE_PACKAGE_SUBJECT_BINDING_KEY
    : `${binding.jobId}\0${binding.stepId}`;
}

export function pipelinePackageStepBindingKey(
  jobId: string,
  stepId: string,
): string {
  return `${jobId}\0${stepId}`;
}

/** Inverse of {@link pipelinePackageBindingKey}, for key-grouped rebuilds. */
export function pipelinePackageBindingFromKey(
  key: string,
  resourceIds: string[],
): PipelinePackageBinding {
  if (key === PIPELINE_PACKAGE_SUBJECT_BINDING_KEY)
    return { target: 'subject', resourceIds };
  const [jobId, stepId] = key.split('\0');
  if (
    jobId === undefined ||
    jobId === '' ||
    stepId === undefined ||
    stepId === ''
  )
    throw new Error('Invalid capability package binding key');
  return { jobId, stepId, resourceIds };
}

export interface PipelinePackageEnvironmentRequirement {
  id: string;
  kind: 'connector' | 'mcp' | 'model' | 'command' | 'runtime';
  displayName: string;
  required: boolean;
  affectedSteps: Array<{ jobId: string; stepId: string }>;
  setupHint: string;
}

export interface PipelinePackagePublisherNote {
  id: string;
  kind: 'not_a_command';
  label: string;
  affectedSteps: Array<{ jobId: string; stepId: string }>;
}

export interface PipelinePackageManifestV1 {
  version: 1;
  pipelineContentHash: string;
  resources: PipelinePackageResource[];
  bindings: PipelinePackageBinding[];
  environmentRequirements: PipelinePackageEnvironmentRequirement[];
  publisherNotes?: PipelinePackagePublisherNote[];
  totalFiles: number;
  totalBytes: number;
}

export interface PipelinePackageRef {
  version: 1;
  digest: string;
}

export interface PipelinePackageSummary {
  digest: string;
  version: 1;
  resources: Array<{
    id: string;
    displayName: string;
    kind: PipelinePackageResource['kind'];
    sourceLabel: string;
    fileCount: number;
    totalBytes: number;
    affectedSteps: Array<{ jobId: string; stepId: string }>;
    /**
     * Files that run as programs, from
     * {@link listCapabilityPackageExecutablePaths}. Absent when there are none,
     * and on a summary from a server that predates the field.
     */
    executableFiles?: string[];
  }>;
  environmentRequirements: PipelinePackageEnvironmentRequirement[];
  publisherNotes?: PipelinePackagePublisherNote[];
  totalFiles: number;
  totalBytes: number;
}

export type PipelinePackageValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

const PACKAGE_DIGEST_PATTERN = /^pp:v1:[A-Za-z0-9_-]{43}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
/** Pipeline YAML `assets[].id`: lower-case, starts with a letter, 32 max. */
const PIPELINE_ASSET_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** The single entry of an `automation_pipeline` tree. */
export const AUTOMATION_PIPELINE_TREE_ENTRY_PATH = 'pipeline.yaml';

/**
 * Portable key shape shared by package resource ids, `automation_pipeline`
 * pipeline keys and shared automation `pipelineDependencies[].key`.
 */
export function isPipelinePackageIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    IDENTIFIER_PATTERN.test(value) &&
    isPortablePipelinePackageSegment(value)
  );
}

export function isPipelineContentHash(value: unknown): value is string {
  return (
    typeof value === 'string' && CAPABILITY_FILE_SHA256_PATTERN.test(value)
  );
}

export function isPipelinePackageDigest(value: unknown): value is string {
  return typeof value === 'string' && PACKAGE_DIGEST_PATTERN.test(value);
}

export function isSafePipelinePackagePath(value: unknown): value is string {
  return isSafeCapabilityRelativePath(value, {
    maxPathLength: 1_024,
    maxSegmentLength: 255,
  });
}

function isPortablePipelinePackageSegment(value: unknown): value is string {
  return isPortableCapabilityPathSegment(value, { maxLength: 255 });
}

export function detectPipelinePackageNativeExecutable(
  bytes: Uint8Array,
): 'ELF' | 'PE' | 'Mach-O' | null {
  if (
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  ) {
    return 'ELF';
  }
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return 'PE';
  const magic = Array.from(bytes.subarray(0, 4), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  return [
    'feedface',
    'feedfacf',
    'cefaedfe',
    'cffaedfe',
    'cafebabe',
    'bebafeca',
    'cafebabf',
    'bfbafeca',
  ].includes(magic)
    ? 'Mach-O'
    : null;
}

/** Executable package entries must be strict UTF-8 scripts with a shebang. */
export function isPipelinePackageExecutableScript(bytes: Uint8Array): boolean {
  if (detectPipelinePackageNativeExecutable(bytes) !== null) return false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.startsWith('#!') && !text.includes('\0');
  } catch {
    return false;
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Reserving the NUL prefix for the subject binding keeps the relative order of
 * every step binding byte-for-byte identical to the pre-subject canonical
 * form, which is what stops an already-published package's digest from moving.
 */
const bindingSortKey = pipelinePackageBindingKey;

/**
 * The server re-hashes a stored manifest after a Postgres `jsonb` round trip,
 * which reorders object keys (shortest first), so the ref is rebuilt in the
 * order clients have always produced rather than copied as received. This only
 * orders keys; unlike `canonicalInstalledItemRef` in `installed-items` it must
 * not normalize values. A field added to an `InstalledItemRefSchema` variant
 * has to be added here too, and reordering these keys moves the digest of
 * every published package.
 */
function installedItemRefInDigestOrder(
  ref: NonNullable<PipelinePackageResource['installedItemRef']>,
): NonNullable<PipelinePackageResource['installedItemRef']> {
  return ref.kind === 'plugin'
    ? {
        kind: ref.kind,
        marketplaceId: ref.marketplaceId,
        pluginName: ref.pluginName,
      }
    : { kind: ref.kind, sourceId: ref.sourceId, skillName: ref.skillName };
}

function canonicalManifestObject(
  manifest: PipelinePackageManifestV1,
): PipelinePackageManifestV1 {
  return {
    version: PIPELINE_PACKAGE_VERSION,
    pipelineContentHash: manifest.pipelineContentHash,
    resources: manifest.resources
      .map((resource) => ({
        id: resource.id,
        ...(resource.installedItemRef
          ? {
              installedItemRef: installedItemRefInDigestOrder(
                resource.installedItemRef,
              ),
            }
          : {}),
        kind: resource.kind,
        displayName: resource.displayName,
        sourceLabel: resource.sourceLabel,
        sourceVisibility: resource.sourceVisibility,
        invocationKeys: [...resource.invocationKeys].sort(compareStrings),
        dependencyResourceIds: [...resource.dependencyResourceIds].sort(
          compareStrings,
        ),
        trees: resource.trees
          .map((tree) => ({
            provider: tree.provider,
            runtimeKind: tree.runtimeKind,
            rootName: tree.rootName,
            entries: tree.entries
              .map((entry) => ({
                path: entry.path,
                sha256: entry.sha256,
                size: entry.size,
                mode: entry.mode,
              }))
              .sort((left, right) => compareStrings(left.path, right.path)),
          }))
          .sort((left, right) =>
            compareStrings(
              `${left.provider}\0${left.rootName}\0${left.runtimeKind}`,
              `${right.provider}\0${right.rootName}\0${right.runtimeKind}`,
            ),
          ),
        // Version 6 fields, emitted only when present so every earlier
        // manifest keeps its canonical form and digest.
        ...(resource.pipelineKey !== undefined
          ? { pipelineKey: resource.pipelineKey }
          : {}),
        ...(resource.pipelineContentHash !== undefined
          ? { pipelineContentHash: resource.pipelineContentHash }
          : {}),
        ...(resource.assetId !== undefined
          ? { assetId: resource.assetId }
          : {}),
        ...(resource.installMode !== undefined
          ? { installMode: resource.installMode }
          : {}),
        ...(resource.required !== undefined
          ? { required: resource.required }
          : {}),
      }))
      .sort((left, right) => compareStrings(left.id, right.id)),
    bindings: manifest.bindings
      .map(
        (binding): PipelinePackageBinding =>
          isPipelinePackageSubjectBinding(binding)
            ? {
                target: 'subject',
                resourceIds: [...binding.resourceIds].sort(compareStrings),
              }
            : {
                jobId: binding.jobId,
                stepId: binding.stepId,
                resourceIds: [...binding.resourceIds].sort(compareStrings),
              },
      )
      .sort((left, right) =>
        compareStrings(bindingSortKey(left), bindingSortKey(right)),
      ),
    environmentRequirements: manifest.environmentRequirements
      .map((requirement) => ({
        id: requirement.id,
        kind: requirement.kind,
        displayName: requirement.displayName,
        required: requirement.required,
        affectedSteps: requirement.affectedSteps
          .map((step) => ({ jobId: step.jobId, stepId: step.stepId }))
          .sort((left, right) =>
            compareStrings(
              `${left.jobId}\0${left.stepId}`,
              `${right.jobId}\0${right.stepId}`,
            ),
          ),
        setupHint: requirement.setupHint,
      }))
      .sort((left, right) => compareStrings(left.id, right.id)),
    ...(manifest.publisherNotes
      ? {
          publisherNotes: manifest.publisherNotes
            .map((note) => ({
              id: note.id,
              kind: note.kind,
              label: note.label,
              affectedSteps: note.affectedSteps
                .map((step) => ({ jobId: step.jobId, stepId: step.stepId }))
                .sort((left, right) =>
                  compareStrings(
                    `${left.jobId}\0${left.stepId}`,
                    `${right.jobId}\0${right.stepId}`,
                  ),
                ),
            }))
            .sort((left, right) => compareStrings(left.id, right.id)),
        }
      : {}),
    totalFiles: manifest.totalFiles,
    totalBytes: manifest.totalBytes,
  };
}

export function canonicalizePipelinePackageManifest(
  manifest: PipelinePackageManifestV1,
): string {
  return JSON.stringify(canonicalManifestObject(manifest));
}

export async function computePipelinePackageDigest(
  manifest: PipelinePackageManifestV1,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonicalizePipelinePackageManifest(manifest),
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `pp:v1:${base64UrlEncode(new Uint8Array(digest))}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

export function validatePipelinePackageManifest(
  value: unknown,
): PipelinePackageValidationResult {
  const errors: string[] = [];
  if (!isRecord(value))
    return { ok: false, errors: ['Manifest must be an object'] };
  if (
    !hasOnlyKeys(value, [
      'version',
      'pipelineContentHash',
      'resources',
      'bindings',
      'environmentRequirements',
      'publisherNotes',
      'totalFiles',
      'totalBytes',
    ])
  ) {
    errors.push('Manifest contains unknown fields');
  }
  if (value.version !== PIPELINE_PACKAGE_VERSION)
    errors.push('Unsupported package version');
  if (!isPipelineContentHash(value.pipelineContentHash))
    errors.push('Invalid pipeline content hash');
  if (!Array.isArray(value.resources))
    errors.push('Resources must be an array');
  if (!Array.isArray(value.bindings)) errors.push('Bindings must be an array');
  if (!Array.isArray(value.environmentRequirements))
    errors.push('Environment requirements must be an array');
  if (
    value.publisherNotes !== undefined &&
    !Array.isArray(value.publisherNotes)
  )
    errors.push('Publisher notes must be an array');
  if (!Number.isSafeInteger(value.totalFiles) || Number(value.totalFiles) < 0)
    errors.push('Invalid total file count');
  if (!Number.isSafeInteger(value.totalBytes) || Number(value.totalBytes) < 0)
    errors.push('Invalid total byte count');
  if (errors.length > 0) return { ok: false, errors };

  const manifest = value as unknown as PipelinePackageManifestV1;
  const resourceIds = new Set<string>();
  const automationPipelineKeys = new Set<string>();
  const fileAssetPipelineKeys: Array<{ label: string; pipelineKey: string }> =
    [];
  let actualFiles = 0;
  let actualBytes = 0;

  for (
    let resourceIndex = 0;
    resourceIndex < manifest.resources.length;
    resourceIndex += 1
  ) {
    const resource = manifest.resources[resourceIndex];
    const label = `resources[${resourceIndex}]`;
    if (!isRecord(resource)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (
      !hasOnlyKeys(resource, [
        'id',
        'installedItemRef',
        'kind',
        'displayName',
        'sourceLabel',
        'sourceVisibility',
        'invocationKeys',
        'dependencyResourceIds',
        'trees',
        'pipelineKey',
        'pipelineContentHash',
        'assetId',
        'installMode',
        'required',
      ])
    )
      errors.push(`${label} contains unknown fields`);
    if (resource.installedItemRef !== undefined) {
      const ref = InstalledItemRefSchema.safeParse(resource.installedItemRef);
      if (
        !ref.success ||
        (ref.data.kind !== 'plugin' && ref.data.kind !== 'skill')
      )
        errors.push(`${label}.installedItemRef is invalid`);
    }
    if (
      !isNonEmptyString(resource.id) ||
      !IDENTIFIER_PATTERN.test(resource.id) ||
      !isPortablePipelinePackageSegment(resource.id)
    )
      errors.push(`${label}.id is invalid`);
    else if (resourceIds.has(resource.id))
      errors.push(`Duplicate resource id: ${resource.id}`);
    else resourceIds.add(resource.id);
    if (
      ![
        'standalone_skill',
        'plugin_skill',
        'plugin_command',
        'plugin_agent',
        'pipeline_action',
        'child_pipeline',
        'automation_pipeline',
        'file_asset',
        ...CAPABILITY_PACKAGE_DEFINITION_KINDS,
      ].includes(String(resource.kind))
    )
      errors.push(`${label}.kind is invalid`);
    const isAutomationPipeline = resource.kind === 'automation_pipeline';
    const isFileAsset = resource.kind === 'file_asset';
    if (isAutomationPipeline || isFileAsset) {
      if (!isPipelinePackageIdentifier(resource.pipelineKey))
        errors.push(`${label}.pipelineKey is invalid`);
    } else if (resource.pipelineKey !== undefined)
      errors.push(`${label}.pipelineKey is only allowed on pipeline resources`);
    if (isAutomationPipeline) {
      if (!isPipelineContentHash(resource.pipelineContentHash))
        errors.push(`${label}.pipelineContentHash is invalid`);
      else if (
        typeof resource.pipelineKey === 'string' &&
        automationPipelineKeys.has(resource.pipelineKey)
      )
        errors.push(`Duplicate pipeline key: ${resource.pipelineKey}`);
      if (typeof resource.pipelineKey === 'string')
        automationPipelineKeys.add(resource.pipelineKey);
    } else if (resource.pipelineContentHash !== undefined)
      errors.push(
        `${label}.pipelineContentHash is only allowed on automation pipelines`,
      );
    if (isFileAsset) {
      if (
        typeof resource.assetId !== 'string' ||
        !PIPELINE_ASSET_ID_PATTERN.test(resource.assetId)
      )
        errors.push(`${label}.assetId is invalid`);
      if (resource.installMode !== 'seed' && resource.installMode !== 'replace')
        errors.push(`${label}.installMode is invalid`);
      if (typeof resource.required !== 'boolean')
        errors.push(`${label}.required is invalid`);
      if (typeof resource.pipelineKey === 'string')
        fileAssetPipelineKeys.push({
          label,
          pipelineKey: resource.pipelineKey,
        });
    } else {
      if (resource.assetId !== undefined)
        errors.push(`${label}.assetId is only allowed on file assets`);
      if (resource.installMode !== undefined)
        errors.push(`${label}.installMode is only allowed on file assets`);
      if (resource.required !== undefined)
        errors.push(`${label}.required is only allowed on file assets`);
    }
    if (!isNonEmptyString(resource.displayName))
      errors.push(`${label}.displayName is required`);
    if (!isNonEmptyString(resource.sourceLabel))
      errors.push(`${label}.sourceLabel is required`);
    if (
      !['builtin', 'public', 'private', 'local'].includes(
        String(resource.sourceVisibility),
      )
    )
      errors.push(`${label}.sourceVisibility is invalid`);
    if (
      !Array.isArray(resource.invocationKeys) ||
      !resource.invocationKeys.every(isNonEmptyString)
    )
      errors.push(`${label}.invocationKeys is invalid`);
    if (
      !Array.isArray(resource.dependencyResourceIds) ||
      !resource.dependencyResourceIds.every(isNonEmptyString)
    )
      errors.push(`${label}.dependencyResourceIds is invalid`);
    if (!Array.isArray(resource.trees)) {
      errors.push(`${label}.trees must be an array`);
      continue;
    }

    if (isAutomationPipeline && resource.trees.length !== 1)
      errors.push(`${label} must carry exactly one pipeline tree`);
    if (isFileAsset && resource.trees.length > 1)
      errors.push(`${label} must carry at most one asset tree`);
    const definitionTree = resource.trees[0];
    if (
      CAPABILITY_PACKAGE_DEFINITION_KINDS.some(
        (kind) => kind === resource.kind,
      ) &&
      (resource.trees.length !== 1 ||
        !isRecord(definitionTree) ||
        !Array.isArray(definitionTree.entries) ||
        definitionTree.entries.length !== 1 ||
        !isRecord(definitionTree.entries[0]) ||
        definitionTree.entries[0].mode !== 'read')
    ) {
      errors.push(`${label} must contain one read-only definition document`);
    }

    const treeKeys = new Set<string>();
    for (let treeIndex = 0; treeIndex < resource.trees.length; treeIndex += 1) {
      const tree = resource.trees[treeIndex];
      const treeLabel = `${label}.trees[${treeIndex}]`;
      if (!isRecord(tree)) {
        errors.push(`${treeLabel} must be an object`);
        continue;
      }
      if (
        !hasOnlyKeys(tree, ['provider', 'runtimeKind', 'rootName', 'entries'])
      )
        errors.push(`${treeLabel} contains unknown fields`);
      if (!['claude', 'codex'].includes(String(tree.provider)))
        errors.push(`${treeLabel}.provider is invalid`);
      if (
        ![
          'plugin_fragment',
          'standalone_skill',
          'automation_pipeline',
          'pipeline_asset',
        ].includes(String(tree.runtimeKind))
      )
        errors.push(`${treeLabel}.runtimeKind is invalid`);
      // Pipeline YAML and asset trees belong only to their own resource kind,
      // and those kinds carry nothing else.
      if (
        isAutomationPipeline !== (tree.runtimeKind === 'automation_pipeline') ||
        isFileAsset !== (tree.runtimeKind === 'pipeline_asset')
      )
        errors.push(`${treeLabel}.runtimeKind does not match ${label}.kind`);
      if (
        isAutomationPipeline &&
        typeof resource.pipelineKey === 'string' &&
        tree.rootName !== resource.pipelineKey
      )
        errors.push(`${treeLabel}.rootName must equal ${label}.pipelineKey`);
      if (
        isFileAsset &&
        typeof resource.assetId === 'string' &&
        tree.rootName !== resource.assetId
      )
        errors.push(`${treeLabel}.rootName must equal ${label}.assetId`);
      if (
        isAutomationPipeline &&
        (!Array.isArray(tree.entries) ||
          tree.entries.length !== 1 ||
          !isRecord(tree.entries[0]) ||
          tree.entries[0].path !== AUTOMATION_PIPELINE_TREE_ENTRY_PATH)
      )
        errors.push(
          `${treeLabel} must carry exactly one ${AUTOMATION_PIPELINE_TREE_ENTRY_PATH} entry`,
        );
      if (
        !isNonEmptyString(tree.rootName) ||
        !IDENTIFIER_PATTERN.test(tree.rootName) ||
        !isPortablePipelinePackageSegment(tree.rootName)
      )
        errors.push(`${treeLabel}.rootName is invalid`);
      const treeKey = `${String(tree.provider)}\0${String(tree.rootName)}\0${String(tree.runtimeKind)}`;
      if (treeKeys.has(treeKey))
        errors.push(`${treeLabel} duplicates another tree`);
      treeKeys.add(treeKey);
      if (!Array.isArray(tree.entries)) {
        errors.push(`${treeLabel}.entries must be an array`);
        continue;
      }
      const paths = new Set<string>();
      const foldedPaths = new Set<string>();
      for (
        let entryIndex = 0;
        entryIndex < tree.entries.length;
        entryIndex += 1
      ) {
        const entry = tree.entries[entryIndex];
        const entryLabel = `${treeLabel}.entries[${entryIndex}]`;
        if (!isRecord(entry)) {
          errors.push(`${entryLabel} must be an object`);
          continue;
        }
        if (!hasOnlyKeys(entry, ['path', 'sha256', 'size', 'mode']))
          errors.push(`${entryLabel} contains unknown fields`);
        if (!isSafePipelinePackagePath(entry.path))
          errors.push(`${entryLabel}.path is unsafe`);
        else {
          const folded = entry.path.toLocaleLowerCase('en-US');
          if (paths.has(entry.path))
            errors.push(`${entryLabel}.path is duplicated`);
          else if (foldedPaths.has(folded))
            errors.push(`${entryLabel}.path collides by case`);
          paths.add(entry.path);
          foldedPaths.add(folded);
        }
        if (!isPipelineContentHash(entry.sha256))
          errors.push(`${entryLabel}.sha256 is invalid`);
        if (!Number.isSafeInteger(entry.size) || Number(entry.size) < 0)
          errors.push(`${entryLabel}.size is invalid`);
        else {
          actualFiles += 1;
          actualBytes += Number(entry.size);
          if (Number(entry.size) > PIPELINE_PACKAGE_MAX_FILE_BYTES)
            errors.push(`${entryLabel}.size exceeds the per-file limit`);
        }
        if (entry.mode !== 'read' && entry.mode !== 'execute')
          errors.push(`${entryLabel}.mode is invalid`);
      }
    }
  }

  for (const { label, pipelineKey } of fileAssetPipelineKeys) {
    if (!automationPipelineKeys.has(pipelineKey))
      errors.push(
        `${label}.pipelineKey names no automation pipeline: ${pipelineKey}`,
      );
  }

  for (const resource of manifest.resources) {
    if (!isRecord(resource) || !Array.isArray(resource.dependencyResourceIds))
      continue;
    for (const dependencyId of resource.dependencyResourceIds) {
      if (typeof dependencyId === 'string' && !resourceIds.has(dependencyId))
        errors.push(`Unknown dependency resource id: ${dependencyId}`);
    }
  }

  const bindingKeys = new Set<string>();
  for (
    let bindingIndex = 0;
    bindingIndex < manifest.bindings.length;
    bindingIndex += 1
  ) {
    const binding = manifest.bindings[bindingIndex];
    const label = `bindings[${bindingIndex}]`;
    if (!isRecord(binding)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    // The presence of `target` selects the whole-share shape, so a binding
    // carrying both a target and a step identity is rejected as malformed
    // rather than silently read as one of the two.
    const isSubject = Object.prototype.hasOwnProperty.call(binding, 'target');
    let key: string;
    if (isSubject) {
      if (!hasOnlyKeys(binding, ['target', 'resourceIds']))
        errors.push(`${label} contains unknown fields`);
      if (binding.target !== 'subject')
        errors.push(`${label}.target is invalid`);
      key = PIPELINE_PACKAGE_SUBJECT_BINDING_KEY;
    } else {
      if (!hasOnlyKeys(binding, ['jobId', 'stepId', 'resourceIds']))
        errors.push(`${label} contains unknown fields`);
      if (!isNonEmptyString(binding.jobId) || !isNonEmptyString(binding.stepId))
        errors.push(`${label} has an invalid step identity`);
      key = `${String(binding.jobId)}\0${String(binding.stepId)}`;
    }
    if (bindingKeys.has(key))
      errors.push(`${label} duplicates another binding`);
    bindingKeys.add(key);
    if (
      !Array.isArray(binding.resourceIds) ||
      !binding.resourceIds.every(isNonEmptyString)
    ) {
      errors.push(`${label}.resourceIds is invalid`);
      continue;
    }
    for (const resourceId of binding.resourceIds) {
      if (!resourceIds.has(resourceId))
        errors.push(`Unknown bound resource id: ${resourceId}`);
    }
  }

  const requirementIds = new Set<string>();
  for (
    let requirementIndex = 0;
    requirementIndex < manifest.environmentRequirements.length;
    requirementIndex += 1
  ) {
    const requirement = manifest.environmentRequirements[requirementIndex];
    const label = `environmentRequirements[${requirementIndex}]`;
    if (!isRecord(requirement)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (
      !hasOnlyKeys(requirement, [
        'id',
        'kind',
        'displayName',
        'required',
        'affectedSteps',
        'setupHint',
      ])
    )
      errors.push(`${label} contains unknown fields`);
    if (
      !isNonEmptyString(requirement.id) ||
      !IDENTIFIER_PATTERN.test(requirement.id)
    )
      errors.push(`${label}.id is invalid`);
    else if (requirementIds.has(requirement.id))
      errors.push(`Duplicate requirement id: ${requirement.id}`);
    else requirementIds.add(requirement.id);
    if (
      !['connector', 'mcp', 'model', 'command', 'runtime'].includes(
        String(requirement.kind),
      )
    )
      errors.push(`${label}.kind is invalid`);
    if (!isNonEmptyString(requirement.displayName))
      errors.push(`${label}.displayName is required`);
    if (typeof requirement.required !== 'boolean')
      errors.push(`${label}.required is invalid`);
    if (!isNonEmptyString(requirement.setupHint))
      errors.push(`${label}.setupHint is required`);
    if (
      !Array.isArray(requirement.affectedSteps) ||
      !requirement.affectedSteps.every(
        (step) =>
          isRecord(step) &&
          hasOnlyKeys(step, ['jobId', 'stepId']) &&
          isNonEmptyString(step.jobId) &&
          isNonEmptyString(step.stepId),
      )
    )
      errors.push(`${label}.affectedSteps is invalid`);
  }

  if ((manifest.publisherNotes?.length ?? 0) > 50)
    errors.push('Publisher notes exceed the limit');
  const publisherNoteIds = new Set<string>();
  for (
    let noteIndex = 0;
    noteIndex < (manifest.publisherNotes?.length ?? 0);
    noteIndex += 1
  ) {
    const note = manifest.publisherNotes?.[noteIndex];
    const label = `publisherNotes[${noteIndex}]`;
    if (!isRecord(note)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (!hasOnlyKeys(note, ['id', 'kind', 'label', 'affectedSteps']))
      errors.push(`${label} contains unknown fields`);
    if (!isNonEmptyString(note.id) || !IDENTIFIER_PATTERN.test(note.id))
      errors.push(`${label}.id is invalid`);
    else if (publisherNoteIds.has(note.id))
      errors.push(`Duplicate publisher note id: ${note.id}`);
    else publisherNoteIds.add(note.id);
    if (note.kind !== 'not_a_command') errors.push(`${label}.kind is invalid`);
    if (
      !isNonEmptyString(note.label) ||
      note.label.length > 128 ||
      note.label.includes('\\') ||
      note.label.slice(1).includes('/') ||
      !/^[/$][A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)*$/.test(note.label)
    ) {
      errors.push(`${label}.label is invalid`);
    }
    if (
      !Array.isArray(note.affectedSteps) ||
      !note.affectedSteps.every(
        (step) =>
          isRecord(step) &&
          hasOnlyKeys(step, ['jobId', 'stepId']) &&
          isNonEmptyString(step.jobId) &&
          isNonEmptyString(step.stepId),
      )
    ) {
      errors.push(`${label}.affectedSteps is invalid`);
    }
  }

  if (actualFiles > PIPELINE_PACKAGE_MAX_FILES)
    errors.push('Package exceeds the file-count limit');
  if (actualBytes > PIPELINE_PACKAGE_MAX_TOTAL_BYTES)
    errors.push('Package exceeds the total-byte limit');
  if (manifest.totalFiles !== actualFiles)
    errors.push('Manifest totalFiles does not match entries');
  if (manifest.totalBytes !== actualBytes)
    errors.push('Manifest totalBytes does not match entries');

  if (errors.length === 0) {
    const canonicalBytes = new TextEncoder().encode(
      canonicalizePipelinePackageManifest(manifest),
    ).byteLength;
    if (canonicalBytes > PIPELINE_PACKAGE_MAX_MANIFEST_BYTES)
      errors.push('Canonical manifest exceeds the size limit');
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Oldest desktop build that can read this manifest without losing a field.
 *
 * Derived from the manifest's content rather than declared by the publisher,
 * so a share only demands a newer client when it actually uses a newer field.
 * Accepts `unknown` because the server derives this from a stored payload it
 * has not re-parsed into the manifest type.
 */
export function requiredPipelinePackageClientVersion(
  value: unknown,
): 1 | 2 | 3 | 4 | 5 | typeof PIPELINE_PACKAGE_CLIENT_VERSION {
  if (!isRecord(value)) return 1;
  const resources = value.resources;
  if (
    Array.isArray(resources) &&
    resources.some(
      (resource) =>
        isRecord(resource) &&
        (resource.kind === 'automation_pipeline' ||
          resource.kind === 'file_asset'),
    )
  )
    return 6;
  if (
    Array.isArray(resources) &&
    resources.some(
      (resource) =>
        isRecord(resource) && resource.installedItemRef !== undefined,
    )
  )
    return 5;
  if (
    Array.isArray(resources) &&
    resources.some(
      (resource) =>
        isRecord(resource) &&
        CAPABILITY_PACKAGE_DEFINITION_KINDS.some(
          (kind) => kind === resource.kind,
        ),
    )
  ) {
    return 5;
  }
  if (
    Array.isArray(resources) &&
    resources.some(
      (resource) =>
        isRecord(resource) &&
        (resource.kind === 'pipeline_action' ||
          resource.kind === 'child_pipeline'),
    )
  ) {
    return 4;
  }
  const bindings = value.bindings;
  if (
    Array.isArray(bindings) &&
    bindings.some(
      (binding) =>
        isRecord(binding) &&
        Object.prototype.hasOwnProperty.call(binding, 'target'),
    )
  ) {
    return 3;
  }
  return Object.prototype.hasOwnProperty.call(value, 'publisherNotes') ? 2 : 1;
}

/*
 * Neutral aliases.
 *
 * The package stopped being pipeline-shaped once skills, Agents, Collections,
 * and Blueprints started using it. The module path and the `Pipeline*` names
 * stay exported so the pipeline slice needs no churn, but new callers should
 * reach for the `Capability*` names.
 */
export const CAPABILITY_PACKAGE_VERSION = PIPELINE_PACKAGE_VERSION;
export const CAPABILITY_PACKAGE_CLIENT_VERSION =
  PIPELINE_PACKAGE_CLIENT_VERSION;
export const CAPABILITY_PACKAGE_VERSION_HEADER =
  PIPELINE_PACKAGE_VERSION_HEADER;
export const CAPABILITY_PACKAGE_MAX_FILES = PIPELINE_PACKAGE_MAX_FILES;
export const CAPABILITY_PACKAGE_MAX_FILE_BYTES =
  PIPELINE_PACKAGE_MAX_FILE_BYTES;
export const CAPABILITY_PACKAGE_MAX_TOTAL_BYTES =
  PIPELINE_PACKAGE_MAX_TOTAL_BYTES;
export const CAPABILITY_PACKAGE_MAX_MANIFEST_BYTES =
  PIPELINE_PACKAGE_MAX_MANIFEST_BYTES;

export type CapabilityDistributionMode = PipelineDistributionMode;
export type CapabilityShareInstallPin = PipelineShareInstallPin;
export type CapabilityPackageFileEntry = PipelinePackageFileEntry;
export type CapabilityPackageTree = PipelinePackageTree;
export type CapabilityPackageResource = PipelinePackageResource;
export type CapabilityPackageStepBinding = PipelinePackageStepBinding;
export type CapabilityPackageSubjectBinding = PipelinePackageSubjectBinding;
export type CapabilityPackageBinding = PipelinePackageBinding;
export type CapabilityPackageEnvironmentRequirement =
  PipelinePackageEnvironmentRequirement;
export type CapabilityPackagePublisherNote = PipelinePackagePublisherNote;
export type CapabilityPackageManifestV1 = PipelinePackageManifestV1;
export type CapabilityPackageRef = PipelinePackageRef;
export type CapabilityPackageSummary = PipelinePackageSummary;
export type CapabilityPackageValidationResult = PipelinePackageValidationResult;

export function isCapabilityPackageManifest(
  value: unknown,
): value is CapabilityPackageManifestV1 {
  return validateCapabilityPackageManifest(value).ok;
}

export const isCapabilityPackageSubjectBinding =
  isPipelinePackageSubjectBinding;
export const CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY =
  PIPELINE_PACKAGE_SUBJECT_BINDING_KEY;
export const capabilityPackageBindingKey = pipelinePackageBindingKey;
export const capabilityPackageStepBindingKey = pipelinePackageStepBindingKey;
export const capabilityPackageBindingFromKey = pipelinePackageBindingFromKey;
export const isCapabilityContentHash = isPipelineContentHash;
export const isCapabilityPackageDigest = isPipelinePackageDigest;
export const isSafeCapabilityPackagePath = isSafePipelinePackagePath;
export const detectCapabilityPackageNativeExecutable =
  detectPipelinePackageNativeExecutable;
export const isCapabilityPackageExecutableScript =
  isPipelinePackageExecutableScript;
export const canonicalizeCapabilityPackageManifest =
  canonicalizePipelinePackageManifest;
export const computeCapabilityPackageDigest = computePipelinePackageDigest;
export const validateCapabilityPackageManifest =
  validatePipelinePackageManifest;
export const requiredCapabilityPackageClientVersion =
  requiredPipelinePackageClientVersion;

// ---------------------------------------------------------------------------
// Publisher-side analysis summary (moved from desktop-shared so the shared
// share dialog can render the dependency review in every host).
// ---------------------------------------------------------------------------

/**
 * The two states the analyzer can actually produce. `analyzing`/`error` are
 * renderer-local concerns (request in flight, request failed), and
 * staleness/expiry are post-hoc main-side facts surfaced as submit-time
 * errors rather than as an analysis state.
 */
export type PipelinePackageAnalysisState = 'ready' | 'blocked';

export type PipelinePackageBlockerCode =
  | 'SOURCE_PATH_ESCAPE'
  | 'SYMLINK_BLOCKED'
  | 'SUSPECTED_SECRET'
  | 'EXPORT_DENIED_FILE'
  | 'NATIVE_EXECUTABLE_BLOCKED'
  | 'OPAQUE_EXECUTABLE_BLOCKED'
  | 'MISSING_DEPENDENCY_SOURCE'
  | 'UNRESOLVED_INVOCATION'
  | 'AMBIGUOUS_INVOCATION'
  | 'PACKAGE_LIMIT_EXCEEDED'
  | 'INVALID_PACKAGE'
  /** A child `with.pipeline` ref depends on inputs, steps or runtime env. Dismissable. */
  | 'UNRESOLVED_CHILD_PIPELINE_REF'
  /**
   * A shared or packaged pipeline (the root, a child or an automation's)
   * declares `workflow`, which can't leave this machine yet (CAN-5782).
   */
  | 'LOCAL_ONLY_PIPELINE_TRIGGER'
  /** A prompt names more than one pipeline. Dismissable. */
  | 'AMBIGUOUS_PIPELINE_REFERENCE'
  /** A dependency pipeline has its own installed package (its children are not on disk). */
  | 'DEPENDENCY_HAS_INSTALLED_PACKAGE'
  /** Two packaged pipelines produce the same portable key. */
  | 'DUPLICATE_PIPELINE_KEY'
  /** A plain pipeline share whose pipeline declares `assets`. */
  | 'ASSETS_REQUIRE_AUTOMATION_SHARE'
  /** A packaged child pipeline declares its own `assets`. */
  | 'ASSETS_ON_PACKAGED_CHILD'
  /** File assets cannot go to a Public audience. */
  | 'ASSETS_NOT_ALLOWED_FOR_PUBLIC'
  /** An asset path and a `local_state` entry overlap. */
  | 'ASSET_OVERLAPS_LOCAL_STATE'
  /** An asset path resolves outside the home directory. */
  | 'ASSET_PATH_OUTSIDE_HOME'
  /** A `required` asset path does not exist. */
  | 'MISSING_REQUIRED_ASSET';

/**
 * Which package cap a `PACKAGE_LIMIT_EXCEEDED` blocker hit. The blocker's
 * subject is the file to leave out: the oversized file, the file that went
 * past the count, or the largest file when the total is too big.
 */
export type PipelinePackageLimit = 'file_size' | 'file_count' | 'total_size';

export interface PipelinePackageInvocationDismissal {
  provider: 'claude' | 'codex';
  token: string;
}

/**
 * Dismissal of a non-invocation reference blocker. `pipeline_reference`
 * tokens are the pipeline name a prompt matched; `child_pipeline_ref` tokens
 * are the raw `with.pipeline` string.
 */
export interface PipelinePackageReferenceDismissal {
  kind: 'pipeline_reference' | 'child_pipeline_ref';
  token: string;
}

/** Why a file under a declared asset, or a cloud copy's member, was left out. */
export type PipelinePackageWithheldReason =
  | 'denied_name'
  | 'git_directory'
  | 'symlink'
  | 'suspected_secret'
  | 'missing_optional_asset'
  /** Ignored by the folder's git repository; cloud copies only (CAN-6176). */
  | 'git_ignored';

export interface PipelinePackageWithheldFile {
  pipelineKey: string;
  assetId: string;
  /** Relative to the asset root; empty for a missing optional asset. */
  relativePath: string;
  reason: PipelinePackageWithheldReason;
}

/**
 * A skill's or plugin's file left out of its cloud copy (CAN-6176). Cloud
 * copies withhold what a share would block on, so the rest still goes; the
 * consent dialog lists each one with its reason, never as a choice.
 */
export interface CapabilityPackageWithheldMemberFile {
  /** The skill or plugin the file belongs to. */
  rootName: string;
  /** Relative to that skill's or plugin's folder. */
  relativePath: string;
  reason: Exclude<PipelinePackageWithheldReason, 'missing_optional_asset'>;
}

/** UTF-16 code-unit span of a pipeline UUID in the canonical prompt. */
export interface PipelinePackagePromptSpan {
  textStart: number;
  text: string;
}

/** A pipeline the automation analysis packaged as `automation_pipeline`. */
export interface PipelinePackagePackagedPipeline {
  key: string;
  resourceId: string;
  name: string;
  pipelineContentHash: string;
  source: 'user' | 'project';
  /** True for the `worktree_pipeline` action's own pipeline (key `action`). */
  isActionPipeline: boolean;
  /** Optional (name-matched) pipelines ship only when selected. */
  optional: boolean;
  promptSpans: PipelinePackagePromptSpan[];
}

export interface PipelinePackageAnalysisBlocker {
  code: PipelinePackageBlockerCode;
  subject?: string;
  origin?: 'direct' | 'transitive';
  message: string;
  relativePath?: string;
  /** Set only on `PACKAGE_LIMIT_EXCEEDED`. */
  limit?: PipelinePackageLimit;
  jobId?: string;
  stepId?: string;
  occurrences: Array<{ jobId: string; stepId: string }>;
  dismissal?: PipelinePackageInvocationDismissal;
  referenceDismissal?: PipelinePackageReferenceDismissal;
}

export interface PipelinePackageAnalysisSummary {
  analysisId: string;
  state: PipelinePackageAnalysisState;
  pipelineContentHash: string;
  manifest?: PipelinePackageManifestV1;
  package?: Omit<PipelinePackageSummary, 'digest'>;
  blockers: PipelinePackageAnalysisBlocker[];
  dismissedInvocations?: PipelinePackageInvocationDismissal[];
  dismissedReferences?: PipelinePackageReferenceDismissal[];
  /** Pipelines packaged for an automation share, in key order. */
  packagedPipelines?: PipelinePackagePackagedPipeline[];
  /** Asset files left out of the package, with reasons. */
  withheldFiles?: PipelinePackageWithheldFile[];
  /** A cloud copy's skill or plugin files left out, with reasons (CAN-6176). */
  withheldMemberFiles?: CapabilityPackageWithheldMemberFile[];
  /**
   * Whether a cloud copy could ask git which files are ignored. `unavailable`
   * when git can't run or the folder isn't in a repository: the copy still
   * works, without that check. Absent for shares.
   */
  gitIgnoreCheck?: 'checked' | 'unavailable';
  /** Selected capabilities that analysis cannot include in the package. */
  unpackageableSelectionLabels?: string[];
  repoLocalScope?: { entryCount: number; scannedDirectoryCount: number };
  expiresAt: string;
}

export interface PipelinePackageProgressEvent {
  /**
   * The first three literals are retained for older renderers; current
   * producers emit the file-oriented stages. Consumers must fall back to a
   * generic caption for strings they do not recognize.
   */
  stage:
    | 'Preparing package…'
    | 'Uploading dependencies…'
    | 'Publishing pipeline…'
    | 'Preparing files…'
    | 'Uploading files…'
    | 'Finishing upload…'
    | 'Retrying upload…';
  completed?: number;
  total?: number;
}
