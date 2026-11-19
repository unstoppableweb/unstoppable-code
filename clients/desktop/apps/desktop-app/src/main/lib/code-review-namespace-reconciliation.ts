import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  assertAdmittedWriter,
  STORAGE_OWNERSHIP,
} from '@canopy/core-runtime/storage';
import { admittedStorageRowForPath } from '@canopy/execution-engine/node/lib/admitted-storage-paths';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';
import { CODE_REVIEW_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  getAppManagedChatWorkspaceDir,
  getCodeReviewChatsDir,
  getDataDir,
  getLegacyCodeReviewChatsDir,
  getWorkspaceDir,
  w5RecordReadPaths,
} from './paths';
import {
  isChatStorageV2Manifest,
  parseChatStorageManifest,
} from './chat-delta-journal/format';
import { writeFileAtomically } from './atomic-file';
import { APP_WORKSPACES_MIGRATION_KEY } from './app-managed-workspaces';
import { logMainProcessWarn } from './main-process-logging';
import { hasMigrationRun, markMigrationRun } from './migrations';
import { isErrnoException, isRecord } from './type-guards';

const MODULE = 'main/lib/code-review-namespace-reconciliation';
interface CapturedFile {
  source: string;
  digest: string;
  replacement?: Buffer;
}
type Image = Map<string, CapturedFile>;
const digest = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex');
const contents = (file: CapturedFile): Promise<Buffer> =>
  file.replacement ? Promise.resolve(file.replacement) : readFile(file.source);
function sameImage(a: Image, b: Image): boolean {
  return (
    a.size === b.size &&
    Array.from(a).every(([path, file]) => b.get(path)?.digest === file.digest)
  );
}

async function inspect(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink())
      throw new Error(`Linked Code Review candidate: ${path}`);
    return info;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function indexedSentinel(): Promise<boolean> {
  const path = w5RecordReadPaths.index();
  if (!(await inspect(path))) return false;
  const index: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (
    !isRecord(index) ||
    index.version !== 1 ||
    !Array.isArray(index.workspaces) ||
    !index.workspaces.every(
      (row: unknown) =>
        isRecord(row) &&
        typeof row.id === 'string' &&
        row.id.length > 0 &&
        // W5 cannot establish absence from a partially readable index.
        (row.type === 'single-repo' ||
          row.type === 'multi-repo' ||
          row.type === 'cowork') &&
        (typeof row.name === 'string' ||
          (row.type === 'cowork' && row.name === undefined)) &&
        typeof row.color === 'string',
    )
  )
    throw new Error('Unknown Code Review workspace classification.');
  return index.workspaces.some(
    (row: unknown) => isRecord(row) && row.id === CODE_REVIEW_CHAT_PROJECT_ID,
  );
}

async function snapshot(
  root: string,
  prefix = '',
  image: Image = new Map(),
  publication?: { targets: Image; temporaries: Set<string> },
): Promise<Image> {
  const info = await inspect(join(root, prefix));
  if (!info) {
    if (prefix)
      throw new Error('Code Review candidate disappeared during inspection.');
    return image;
  }
  if (info.isDirectory()) {
    for (const name of (await readdir(join(root, prefix))).sort())
      await snapshot(root, posix.join(prefix, name), image, publication);
  } else if (info.isFile()) {
    if (publication && isPublicationTemporary(prefix, publication.targets)) {
      publication.temporaries.add(prefix);
      return image;
    }
    const data = await readFile(join(root, prefix));
    if (prefix.startsWith('chat-storage-manifests/')) {
      const value: unknown = JSON.parse(data.toString('utf8'));
      const manifest = isChatStorageV2Manifest(value)
        ? value
        : parseChatStorageManifest(value);
      if (prefix !== `chat-storage-manifests/${manifest.scopeId}.json`)
        throw new Error(`Mismatched Code Review chat authority: ${prefix}`);
    }
    image.set(prefix, { source: join(root, prefix), digest: digest(data) });
  } else
    throw new Error(`Unsupported Code Review candidate: ${join(root, prefix)}`);
  return image;
}

function isPublicationTemporary(path: string, targets: Image): boolean {
  // Atomic siblings are non-authoritative only for a frozen publication target.
  const match =
    /^(.*\/)?\.([^/]+)\.[1-9]\d*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.exec(
      path,
    );
  return (
    match !== null &&
    !targets.has(path) &&
    targets.has(`${match[1] ?? ''}${match[2]}`)
  );
}

function registry(
  data: Buffer,
): Record<string, unknown> & { targets: Record<string, unknown> } {
  const value: unknown = JSON.parse(data.toString('utf8'));
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isRecord(value.targets) ||
    !Object.values(value.targets).every(
      (row) =>
        isRecord(row) &&
        typeof row.projectId === 'string' &&
        typeof row.worktreeId === 'string' &&
        (row.incarnation === undefined ||
          (typeof row.incarnation === 'string' &&
            row.incarnation.length > 0)) &&
        (row.state === undefined ||
          row.state === 'active' ||
          row.state === 'retiring'),
    )
  )
    throw new Error('Unreadable Code Review namespace registry.');
  return { ...value, targets: value.targets };
}

function mergeFields(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of Object.keys(a))
    if (
      Object.prototype.hasOwnProperty.call(b, key) &&
      !isDeepStrictEqual(a[key], b[key])
    )
      throw new Error(`Conflicting Code Review namespace field: ${key}`);
  return { ...a, ...b };
}

function mergeRegistry(a: Buffer, b: Buffer): Buffer {
  const { targets: first, ...firstFields } = registry(a);
  const { targets: second, ...secondFields } = registry(b);
  const merged = {
    ...mergeFields(firstFields, secondFields),
    targets: mergeFields(first, second),
  };
  return isDeepStrictEqual(registry(a), merged)
    ? a
    : Buffer.from(JSON.stringify(merged, null, 2));
}

const SCOPE_FILE =
  /^(?:chats|chat-archives|chat-journals|summaries|chat-storage-manifests)\/([^/]+)\.(?:json|jsonl)(?:\.bak)?$/;
const SCOPE_DIRECTORY_FAMILIES = [
  'chat-storage-v2',
  'worktree-data',
  'attachments',
];
const CHAT_FAMILIES = [
  'chats',
  'chat-archives',
  'chat-journals',
  'chat-storage-v2',
  'chat-storage-manifests',
  'worktree-data',
  'attachments',
  'summaries',
];

const REGISTRY = 'chats/registry.json';

/** The chat scope whose authority family holds `path`, if any. */
function scopeOfPath(path: string): string | undefined {
  if (path === REGISTRY) return undefined;
  return (SCOPE_FILE.exec(path) ??
    /^(?:chat-storage-v2|worktree-data|attachments)\/([^/]+)\//.exec(
      path,
    ))?.[1];
}

function authorities(image: Image): Map<string, Image> {
  const scopes = new Map<string, Image>();
  for (const [path, data] of image) {
    const scope = scopeOfPath(path);
    if (scope === undefined) continue;
    const files = scopes.get(scope) ?? new Map<string, CapturedFile>();
    files.set(path, data);
    scopes.set(scope, files);
  }
  return scopes;
}

async function mergeImages(images: Image[]): Promise<Image> {
  const merged: Image = new Map();
  const scopes = new Map<string, Image>();
  for (const image of images) {
    // Shared scope ownership does not establish equality of its chat authority.
    for (const [scope, files] of authorities(image)) {
      const prior = scopes.get(scope);
      if (prior && !sameImage(prior, files))
        throw new Error(`Conflicting Code Review chat authority: ${scope}`);
      scopes.set(scope, files);
    }
    for (const [path, data] of image) {
      if (path === 'chats/registry.json') registry(await contents(data));
      const prior = merged.get(path);
      if (!prior || prior.digest === data.digest) merged.set(path, data);
      else if (path === 'chats/registry.json') {
        const replacement = mergeRegistry(
          await contents(prior),
          await contents(data),
        );
        merged.set(path, {
          source: prior.source,
          digest: digest(replacement),
          replacement,
        });
      } else throw new Error(`Conflicting Code Review namespace file: ${path}`);
    }
  }
  // Refuse file/directory collisions before any publication.
  for (const path of merged.keys()) {
    let parent = posix.dirname(path);
    while (parent !== '.') {
      if (merged.has(parent))
        throw new Error(`Conflicting Code Review directory: ${parent}`);
      parent = posix.dirname(parent);
    }
  }
  return merged;
}

/** With `overwrite` false an existing file is kept and fails with EEXIST. */
async function publishImage(
  destination: string,
  image: Image,
  overwrite = true,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const [path, data] of image) {
    const bytes = await contents(data);
    if (digest(bytes) !== data.digest)
      throw new Error('Code Review candidate changed before publication.');
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await writeRegistryOrChatFile(join(destination, path), bytes, overwrite);
  }
}

function writeRegistryOrChatFile(
  path: string,
  bytes: Buffer,
  overwrite: boolean,
): Promise<void> {
  return writeFileAtomically(path, bytes, {
    ...(overwrite ? {} : { overwrite: false }),
    admittedWriter: {
      namespace:
        admittedStorageRowForPath(path, getDataDir()) ??
        'code_review_chats_dir',
      writer: 'electron_main',
      module: MODULE,
    },
  });
}

async function indexedChatImage(root: string): Promise<Image> {
  await inspect(root);
  const image: Image = new Map();
  // Indexed roots may contain real checkouts; inspect chat authority only.
  for (const family of CHAT_FAMILIES)
    if (await inspect(join(root, family))) await snapshot(root, family, image);
  return image;
}

/** A whole chat scope, or one path outside every scope, the sources add. */
interface Contribution {
  scope?: string;
  /** The planned files: a scope's whole authority family. */
  files: Image;
}

/**
 * What the transaction adds over the frozen preimage. A merged scope is either
 * identical in the preimage or absent from it, so a contributed scope is new.
 */
function contributions(merged: Image, before: Image): Contribution[] {
  const scopes = authorities(merged);
  const units = new Map<string, Contribution>();
  for (const [path, file] of merged) {
    if (path === REGISTRY || before.get(path)?.digest === file.digest) continue;
    const scope = scopeOfPath(path);
    const unit = scope === undefined ? `path:${path}` : `scope:${scope}`;
    if (!units.has(unit))
      units.set(
        unit,
        scope === undefined
          ? { files: new Map([[path, file]]) }
          : { scope, files: scopes.get(scope) ?? new Map() },
      );
  }
  return Array.from(units)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, unit]) => unit);
}

const unitName = (unit: Contribution): string =>
  unit.scope ?? Array.from(unit.files.keys()).join(', ');

/**
 * A checkpointed store missing any one of these fails to load, writing nothing.
 * A journaled store mid-checkpoint reads staged copies in their place.
 */
const INDEX_GATES = [
  'archive-index.json',
  'live-index.json',
  'metadata-journal.jsonl',
  'recovery-index.json',
];
/** A journaled store without its selected journal fails before any write. */
const JOURNAL_GATES = ['delta-journal-v2.log', 'delta-journal.log'];

/**
 * Keeps a partial scope unloadable, so no cold load promotes or checkpoints it
 * before replay completes it. The manifest lands first: without one a cold
 * load treats the store as V1 and replaces it with a fresh scope. The gates
 * land last, the journal after the indexes.
 */
function publicationOrder(unit: Contribution): string[] {
  const scope = unit.scope ?? '';
  const store = (gates: string[], path: string): boolean =>
    gates.some((gate) => path === posix.join('chat-storage-v2', scope, gate));
  const rank = (path: string): number =>
    path === `chat-storage-manifests/${scope}.json`
      ? 0
      : store(JOURNAL_GATES, path)
        ? 3
        : store(INDEX_GATES, path)
          ? 2
          : 1;
  return Array.from(unit.files.keys()).sort(
    (a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0),
  );
}

/**
 * Rule 2 of forward-only recovery: adds a unit's absent files only while its
 * live files are a subset of the plan, never replacing or removing one.
 * Resolves false when the destination already diverged ("touched"); throws on
 * a fault, after which a later launch resumes the unit.
 */
async function installUnit(
  destination: string,
  unit: Contribution,
  live: ScopeUnits,
): Promise<boolean> {
  const found: Image = new Map();
  const present =
    unit.scope === undefined
      ? Array.from(unit.files.keys())
      : Array.from(live.get(unit.scope) ?? []);
  try {
    for (const path of present) {
      const kind = await entryKind(join(destination, path));
      if (kind === 'other') return false;
      if (kind !== 'absent') await snapshot(destination, path, found);
    }
  } catch (error) {
    // A link, an unreadable manifest or a vanishing file is live divergence.
    if (isErrnoException(error)) throw error;
    return false;
  }
  for (const [path, file] of found)
    if (unit.files.get(path)?.digest !== file.digest) return false;
  for (const path of publicationOrder(unit)) {
    const file = unit.files.get(path);
    if (!file || found.has(path)) continue;
    try {
      await publishImage(destination, new Map([[path, file]]), false);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'EEXIST') return false;
      throw error;
    }
  }
  return true;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Planned registry fields and rows the live registry lacks. */
function missingRegistryKeys(
  live: ReturnType<typeof registry>,
  planned: ReturnType<typeof registry>,
): { fields: [string, unknown][]; targets: [string, unknown][] } {
  return {
    fields: Object.entries(planned).filter(
      ([field]) => field !== 'targets' && !hasOwn(live, field),
    ),
    targets: Object.entries(planned.targets).filter(
      ([scopeKey]) => !hasOwn(live.targets, scopeKey),
    ),
  };
}

/**
 * Under the registry mutation hold. An absent or untouched registry takes the
 * union; a later lifecycle change keeps every live row and gains only the
 * missing ones. Resolves false for a registry no reader accepts.
 */
async function installRegistry(
  destination: string,
  planned: CapturedFile,
  preimage: CapturedFile | undefined,
): Promise<boolean> {
  const path = join(destination, REGISTRY);
  const kind = await entryKind(path);
  if (kind === 'directory' || kind === 'other') return false;
  const data = kind === 'file' ? await readFile(path) : undefined;
  if (data && digest(data) === planned.digest) return true;
  if (!data || digest(data) === preimage?.digest) {
    await publishImage(destination, new Map([[REGISTRY, planned]]));
    return true;
  }
  let live: ReturnType<typeof registry>;
  try {
    live = registry(data);
  } catch {
    return false;
  }
  const missing = missingRegistryKeys(live, registry(await contents(planned)));
  if (missing.fields.length === 0 && missing.targets.length === 0) return true;
  const define = (target: object, [key, value]: [string, unknown]): void => {
    // An own `__proto__` row must stay data, never a prototype change.
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  };
  const targets: Record<string, unknown> = { ...live.targets };
  for (const row of missing.targets) define(targets, row);
  const next: Record<string, unknown> = { ...live, targets };
  for (const field of missing.fields) define(next, field);
  await writeRegistryOrChatFile(
    path,
    Buffer.from(JSON.stringify(next, null, 2)),
    true,
  );
  return true;
}

/** Contributed units whose live bytes no longer match the plan. */
async function divergedUnits(
  destination: string,
  units: Contribution[],
  planned: CapturedFile | undefined,
): Promise<string[]> {
  const diverged: string[] = [];
  for (const unit of units)
    for (const [path, file] of unit.files) {
      const target = join(destination, path);
      if (
        (await entryKind(target)) !== 'file' ||
        digest(await readFile(target)) !== file.digest
      ) {
        diverged.push(unitName(unit));
        break;
      }
    }
  if (planned) {
    const target = join(destination, REGISTRY);
    let complete = false;
    try {
      const missing = missingRegistryKeys(
        registry(await readFile(target)),
        registry(await contents(planned)),
      );
      complete = missing.fields.length === 0 && missing.targets.length === 0;
    } catch {
      // Absent or unreadable: not the planned registry.
    }
    if (!complete) diverged.push(REGISTRY);
  }
  return diverged;
}

/**
 * Forward completion of a pending transaction. Each unit is attempted even
 * after another faults or diverges, so untouched scopes still land.
 */
async function publishForward(
  destination: string,
  units: Contribution[],
  planned: CapturedFile | undefined,
  preimage: CapturedFile | undefined,
): Promise<{ touched: string[]; fault?: Error }> {
  const live = await listScopeUnits(destination, '');
  const touched: string[] = [];
  let fault: Error | undefined;
  const attempt = async (
    name: string,
    run: () => Promise<boolean>,
  ): Promise<void> => {
    try {
      if (!(await run())) touched.push(name);
    } catch (error) {
      fault ??= error instanceof Error ? error : new Error(String(error));
    }
  };
  for (const unit of units)
    await attempt(unitName(unit), () => installUnit(destination, unit, live));
  if (planned)
    await attempt(REGISTRY, () =>
      installRegistry(destination, planned, preimage),
    );
  if (fault) return { touched, fault };
  if (touched.length > 0) return { touched };
  return { touched: await divergedUnits(destination, units, planned) };
}

/**
 * Atomic siblings of planned targets that an earlier process left. Lists only
 * the planned targets' directories, refusing a linked one, so unrelated live
 * content never stops replay. This process's own siblings are live writes.
 */
async function publicationTemporaries(
  root: string,
  targets: Image,
): Promise<string[]> {
  const directories = new Set<string>();
  for (const path of targets.keys())
    for (let parent = path; parent !== '.'; ) {
      parent = posix.dirname(parent);
      directories.add(parent);
    }
  const found: string[] = [];
  for (const directory of Array.from(directories).sort()) {
    if (!(await inspect(join(root, directory)))?.isDirectory()) continue;
    for (const name of (await readdir(join(root, directory))).sort()) {
      const path = posix.join(directory, name);
      if (
        isPublicationTemporary(path, targets) &&
        !path.endsWith(`.${process.pid}.${path.slice(-40, -4)}.tmp`) &&
        (await inspect(join(root, path)))?.isFile()
      )
        found.push(path);
    }
  }
  return found;
}

/** Runs inside the selected root; never selects roots or writes W5 images. */
export async function reconcileCodeReviewNamespaces(): Promise<void> {
  for (const namespace of [
    'code_review_registry',
    'code_review_chats_dir',
    'code_review_chats_legacy',
  ] as const)
    assertAdmittedWriter(namespace, 'electron_main', MODULE, STORAGE_OWNERSHIP);
  const root = getDataDir();
  for (const path of [
    'workspaces',
    'app-workspaces',
    '.code-review-namespace-custody',
  ])
    await inspect(join(root, path));
  const indexed = await indexedSentinel();
  const app = getAppManagedChatWorkspaceDir(CODE_REVIEW_CHAT_PROJECT_ID);
  const workspace = getWorkspaceDir(CODE_REVIEW_CHAT_PROJECT_ID);
  const legacy = getLegacyCodeReviewChatsDir();
  const destination = indexed ? workspace : app;
  if (getCodeReviewChatsDir() !== join(destination, 'chats'))
    throw new Error(
      'Code Review routing is not initialized from the workspace index.',
    );
  const sources = indexed ? [legacy, app] : [legacy, workspace];
  const custody = join(root, '.code-review-namespace-custody');
  const pending = join(custody, 'pending');
  const recovering = await inspect(pending);
  if (indexed && recovering)
    throw new Error('Code Review routing changed during reconciliation.');
  const frozen = ['before', 'source-0', 'source-1'];
  if (recovering) {
    const names = await readdir(pending);
    if (
      !recovering.isDirectory() ||
      frozen.some((name) => !names.includes(name)) ||
      names.some(
        (name) =>
          ![
            ...frozen,
            'retired-0',
            'retired-1',
            'publication-temporaries',
          ].includes(name),
      )
    )
      throw new Error('Unknown Code Review reconciliation evidence.');
    for (const name of frozen)
      if (!(await inspect(join(pending, name)))?.isDirectory())
        throw new Error('Incomplete Code Review reconciliation evidence.');
    if (
      names.includes('publication-temporaries') &&
      !(await inspect(join(pending, 'publication-temporaries')))?.isDirectory()
    )
      throw new Error('Invalid Code Review publication temporary custody.');
  }
  if (
    !recovering &&
    !(await settleAll(sources.map(inspect))).some(Boolean) &&
    (!(await inspect(custody)) ||
      !(await readdir(custody)).some((name) => name.startsWith('preparing-')))
  ) {
    // With nothing to reconcile, qualification is structural, not a chat scan.
    const current = await inspect(destination);
    if (current && !current.isDirectory())
      throw new Error(`Unsupported Code Review candidate: ${destination}`);
    return;
  }
  // A replay's frozen preimage may hold debris; a fresh image must not.
  if (!recovering) await purgeAdoptionStaging(app);
  const images = recovering
    ? await settleAll(frozen.map((name) => snapshot(join(pending, name))))
    : await settleAll([
        indexed ? indexedChatImage(destination) : snapshot(destination),
        ...sources.map((source) => snapshot(source)),
      ]);
  if (indexed && images.slice(1).some((image) => image.size > 0))
    throw new Error(
      'Indexed Code Review sentinel requires explicit namespace resolution.',
    );
  const originalSources = images.slice(1);
  const legacyImage: Image = new Map();
  for (const [path, data] of images[1])
    legacyImage.set(posix.join('chats', path), data);
  images[1] = legacyImage;
  const merged = await mergeImages(images);
  if (recovering) {
    // Retained debris must not redirect replay writes through linked directories.
    const unexpected = await snapshot(
      join(pending, 'publication-temporaries'),
      '',
      new Map(),
      { targets: merged, temporaries: new Set() },
    );
    if (unexpected.size > 0)
      throw new Error('Unknown Code Review publication temporary custody.');
  }
  for (const path of merged.keys()) {
    const namespace = admittedStorageRowForPath(join(destination, path), root);
    if (
      namespace !== undefined &&
      namespace !== 'code_review_registry' &&
      (images[0].get(path)?.digest !== merged.get(path)?.digest ||
        originalSources.some((image) => image.has(path)))
    )
      throw new Error(
        `Code Review reconciliation retains another authority: ${namespace}`,
      );
  }
  if (indexed) return; // Never relocate or republish an indexed real workspace.
  // Nothing to add: the sources are absent or empty.
  if (!recovering && originalSources.every((image) => image.size === 0)) return;
  // Freeze preimages before publishing anything into the live namespace. A
  // directory rename publishes the intent; abandoned preparation is evidence.
  if (!recovering) {
    const preparation = join(custody, `preparing-${randomUUID()}`);
    for (const [i, image] of [images[0], ...originalSources].entries())
      await publishImage(join(preparation, frozen[i]), image);
    await rename(preparation, pending);
  }
  for (const [i, source] of sources.entries()) {
    const live = await inspect(source);
    const retained = join(pending, `retired-${i}`);
    if (live && (await inspect(retained)))
      throw new Error('Code Review source reappeared after retirement.');
    const current = await snapshot(live ? source : retained);
    if (!sameImage(current, originalSources[i]))
      throw new Error('Code Review source changed during reconciliation.');
  }
  // Forward-only: progress comes from custody and the sources, never from the
  // live destination, which Code Review keeps writing under q-34.
  const units = contributions(merged, images[0]);
  const planned = merged.get(REGISTRY);
  const registryPlan =
    planned && images[0].get(REGISTRY)?.digest !== planned.digest
      ? planned
      : undefined;
  const retired = (
    await settleAll(
      sources.map((_, i) => inspect(join(pending, `retired-${i}`))),
    )
  ).some(Boolean);
  if (retired) {
    // Retirement follows verified publication; later writes are live authority,
    // so this comparison only warns, even when it cannot read them.
    const changed = await divergedUnits(app, units, registryPlan).then(
      (diverged) => diverged.length,
      () => 'unreadable',
    );
    if (changed !== 0)
      logMainProcessWarn(
        '[code-review] namespace changed after verified publication; finishing retirement',
        { units: changed },
      );
  } else {
    // Publication writes only contributed files and the registry.
    const written: Image = new Map(units.flatMap((unit) => [...unit.files]));
    if (registryPlan) written.set(REGISTRY, registryPlan);
    if (recovering)
      for (const path of await publicationTemporaries(destination, written)) {
        const retained = join(pending, 'publication-temporaries', path);
        if (await inspect(retained))
          throw new Error(
            'Conflicting Code Review publication temporary custody.',
          );
        await mkdir(dirname(retained), { recursive: true });
        await rename(join(destination, path), retained);
      }
    const { touched, fault } = await publishForward(
      app,
      units,
      registryPlan,
      images[0].get(REGISTRY),
    );
    // `pending` stays, so a later launch resumes the faulted units.
    if (fault !== undefined) throw fault;
    if (touched.length > 0) {
      // Touched units keep their live bytes and their sources; the abandoned
      // custody keeps every frozen byte. A fresh run reports the conflict.
      await rename(pending, join(custody, `abandoned-${randomUUID()}`));
      if (recovering) return reconcileCodeReviewNamespaces();
      throw new Error(
        `Code Review destination changed during reconciliation: ${touched.join(', ')}`,
      );
    }
  }
  // Retain predecessor bytes only after complete, verified publication.
  for (const [i, source] of sources.entries()) {
    if (!(await inspect(source))) continue;
    if (!sameImage(await snapshot(source), originalSources[i]))
      throw new Error('Code Review source changed before retirement.');
    await rename(source, join(pending, `retired-${i}`));
  }
  await rename(pending, join(custody, `completed-${randomUUID()}`));
}

const CODE_REVIEW_CHATS_MIGRATION_KEY = 'code_review_chats_app_workspace';

/** The scope of a whole per-scope file or directory, if `path` is one. */
function scopeUnit(path: string): string | undefined {
  if (path === 'chats/registry.json') return undefined;
  const [family, name, ...rest] = path.split('/');
  if (rest.length === 0 && SCOPE_DIRECTORY_FAMILIES.includes(family))
    return name;
  return SCOPE_FILE.exec(path)?.[1];
}

async function entryKind(
  path: string,
): Promise<'absent' | 'directory' | 'file' | 'other'> {
  try {
    const info = await lstat(path);
    if (info.isDirectory()) return 'directory';
    return info.isFile() ? 'file' : 'other';
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return 'absent';
    throw error;
  }
}

/** Registries and manifests the live readers would reject stay where they are. */
async function readable(path: string, relative: string): Promise<boolean> {
  try {
    const data = await readFile(path);
    if (relative === 'chats/registry.json') return Boolean(registry(data));
    const value: unknown = JSON.parse(data.toString('utf8'));
    const manifest = isChatStorageV2Manifest(value)
      ? value
      : parseChatStorageManifest(value);
    return relative === `chat-storage-manifests/${manifest.scopeId}.json`;
  } catch {
    return false;
  }
}

const ADOPTION_STAGING =
  /^\.code-review-adoption-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Removes crash debris from `moveAbsent`. A staged copy is always redundant,
 * because its source goes only after the copy lands. Best effort: leftover
 * debris is only a leak.
 */
async function purgeAdoptionStaging(app: string): Promise<void> {
  try {
    if ((await entryKind(app)) !== 'directory') return;
    for (const name of await readdir(app))
      if (ADOPTION_STAGING.test(name))
        await rm(join(app, name), { recursive: true, force: true });
  } catch {
    // The next launch retries the purge.
  }
}

/**
 * Base's EXDEV-safe move without overwrite. A cross-device copy is staged at
 * the destination root, never inside a family that readers enumerate, and
 * published only while `to` is still absent; the source goes only after that.
 */
async function moveAbsent(
  from: string,
  to: string,
  destination: string,
): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
    return;
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'EXDEV') throw error;
  }
  const staging = join(destination, `.code-review-adoption-${randomUUID()}`);
  try {
    await cp(from, staging, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    if ((await entryKind(to)) !== 'absent')
      throw new Error(`Code Review adoption target appeared: ${to}`);
    await rename(staging, to);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  await rm(from, { recursive: true, force: true });
}

interface Adoption {
  adopted: number;
  /** Entries a fault or a split scope left in the source; a later launch retries them. */
  failed: number;
}

/** Each scope's per-scope entries, as target paths under the destination. */
type ScopeUnits = Map<string, Set<string>>;

async function listScopeUnits(
  root: string,
  prefix: string,
): Promise<ScopeUnits> {
  const units: ScopeUnits = new Map();
  for (const family of CHAT_FAMILIES) {
    const directory =
      prefix === '' ? join(root, family) : family === prefix ? root : undefined;
    if (directory === undefined || (await entryKind(directory)) !== 'directory')
      continue;
    for (const name of await readdir(directory)) {
      const target = posix.join(family, name);
      const scope = scopeUnit(target);
      if (scope !== undefined)
        units.set(scope, (units.get(scope) ?? new Set<string>()).add(target));
    }
  }
  return units;
}

/**
 * Per predecessor, each scope the fallback started moving and the entries it
 * planned to move. The plan tells a scope this fallback split apart from one
 * a cold load created at the same id.
 */
async function readAdoptionJournal(path: string): Promise<ScopeUnits> {
  const plans: ScopeUnits = new Map();
  if ((await entryKind(path)) === 'absent') return plans;
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.scopes))
    throw new Error('Unreadable Code Review adoption journal.');
  for (const [scope, targets] of Object.entries(value.scopes)) {
    if (
      !Array.isArray(targets) ||
      !targets.every(
        (target) => typeof target === 'string' && scopeUnit(target) === scope,
      )
    )
      throw new Error('Unreadable Code Review adoption journal.');
    plans.set(
      scope,
      new Set(targets.filter((target) => typeof target === 'string')),
    );
  }
  return plans;
}

async function writeAdoptionJournal(
  path: string,
  plans: ScopeUnits,
): Promise<void> {
  if (plans.size === 0) {
    await rm(path, { force: true });
    await rmdir(dirname(path)).catch(() => undefined);
    return;
  }
  const scopes = Object.fromEntries(
    Array.from(plans.keys())
      .sort()
      .map((scope) => [scope, Array.from(plans.get(scope) ?? []).sort()]),
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomically(path, JSON.stringify({ version: 1, scopes }), {
    admittedWriter: {
      namespace:
        admittedStorageRowForPath(path, getDataDir()) ??
        'code_review_chats_legacy',
      writer: 'electron_main',
      module: MODULE,
    },
  });
}

/**
 * A planned entry has left the source, so this fallback split the scope.
 * Derived from the journal and the source, never from the destination.
 */
function isSplit(
  scope: string,
  plans: ScopeUnits,
  source: ScopeUnits,
): boolean {
  const left = source.get(scope);
  return Array.from(plans.get(scope) ?? []).some(
    (target) => left?.has(target) !== true,
  );
}

/**
 * Base's missing-entry move, narrowed to whole scopes the destination lacks.
 * Never overwrites; divergent, unreadable and linked entries stay in the source.
 * A faulting entry is counted and skipped so it cannot strand its siblings.
 * A scope's plan is journaled before its first entry moves. A later launch
 * finishes a split scope only while every destination entry of it is planned;
 * it counts each leftover it cannot move, so the caller's marker waits for it.
 * A V2 store never moves ahead of its manifest.
 */
async function adoptMissing(
  source: string,
  destination: string,
  prefix: string,
  journalPath: string,
): Promise<Adoption> {
  const result: Adoption = { adopted: 0, failed: 0 };
  if ((await entryKind(source)) !== 'directory') {
    // Nothing is left to finish.
    await writeAdoptionJournal(journalPath, new Map()).catch(() => undefined);
    return result;
  }
  // Throws when unreadable: without the plans no split scope can be told apart.
  const plans = await readAdoptionJournal(journalPath);
  if (
    !['absent', 'directory'].includes(
      await entryKind(join(destination, prefix)),
    )
  ) {
    result.failed += plans.size;
    return result;
  }
  const sourceUnits = await listScopeUnits(source, prefix);
  const destinationUnits = await listScopeUnits(destination, '');
  // A cold load can create the rest of a split scope; then it stays put.
  const finishing = new Set(
    Array.from(plans.keys()).filter(
      (scope) =>
        isSplit(scope, plans, sourceUnits) &&
        Array.from(destinationUnits.get(scope) ?? []).every(
          (target) => plans.get(scope)?.has(target) === true,
        ),
    ),
  );
  const rejected = new Set<string>();
  for (const [scope, targets] of sourceUnits)
    for (const target of targets) {
      const path = join(
        source,
        prefix ? target.slice(prefix.length + 1) : target,
      );
      if (
        (await entryKind(path)) === 'other' ||
        (!prefix &&
          target.startsWith('chat-storage-manifests/') &&
          !(await readable(path, target)))
      )
        rejected.add(scope);
    }
  const record = async (scope: string): Promise<void> => {
    const planned = plans.get(scope) ?? new Set<string>();
    const targets = Array.from(sourceUnits.get(scope) ?? []);
    if (targets.every((target) => planned.has(target))) return;
    const plan = new Set([...planned, ...targets]);
    await writeAdoptionJournal(journalPath, new Map(plans).set(scope, plan));
    plans.set(scope, plan);
  };
  const faulted = new Set<string>();
  const move = async (
    relative: string,
    entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean },
  ): Promise<void> => {
    const from = join(source, relative, entry.name);
    const target = posix.join(prefix, relative, entry.name);
    const to = join(destination, target);
    const existing = await entryKind(to);
    const scope = scopeUnit(target);
    if (entry.isSymbolicLink() || existing === 'other') return;
    if (entry.isDirectory() && scope === undefined && existing !== 'file') {
      // Family roots hold scopes; other directories move whole when absent.
      if (existing === 'directory' || CHAT_FAMILIES.includes(target))
        return visit(posix.join(relative, entry.name));
    } else if (
      existing !== 'absent' ||
      (scope !== undefined &&
        ((destinationUnits.has(scope) && !finishing.has(scope)) ||
          rejected.has(scope))) ||
      (target === 'chats/registry.json' && !(await readable(from, target)))
    )
      return;
    if (
      scope !== undefined &&
      target === posix.join('chat-storage-v2', scope)
    ) {
      const manifest = `chat-storage-manifests/${scope}.json`;
      // Without its manifest a cold load treats the store as V1 and removes it.
      if (
        faulted.has(manifest) ||
        (await entryKind(join(source, manifest))) !== 'absent'
      )
        throw new Error('Code Review V2 store waits for its manifest.');
    }
    if (scope !== undefined) await record(scope);
    await moveAbsent(from, to, destination);
    result.adopted += 1;
  };
  const visit = async (relative: string): Promise<void> => {
    const entries = await readdir(join(source, relative), {
      withFileTypes: true,
    });
    // Sorted, so a scope's manifest moves before its V2 store.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries)
      await move(relative, entry).catch(() => {
        result.failed += 1;
        faulted.add(posix.join(prefix, relative, entry.name));
      });
    // Empty directories are not chat authority; base removed them too.
    await rmdir(join(source, relative)).catch(() => undefined);
  };
  await visit('');
  const remaining = await listScopeUnits(source, prefix);
  const split: ScopeUnits = new Map();
  for (const [scope, plan] of plans) {
    const left = remaining.get(scope);
    if (!left || !isSplit(scope, plans, remaining)) continue;
    split.set(scope, plan);
    // Even a leftover that can never move, e.g. one a user write displaced.
    for (const target of left) if (!faulted.has(target)) result.failed += 1;
  }
  // A stale journal is safe: finishing needs a planned entry gone from the source.
  await writeAdoptionJournal(journalPath, split).catch(() => undefined);
  return result;
}

export interface PredecessorAdoption extends Adoption {
  /** `workspaces/code-review-chat` still needs base's `app_workspaces` move. */
  workspaceTreePending: boolean;
}

async function adoptAll(
  source: string,
  destination: string,
  prefix: string,
  journalPath: string,
): Promise<Adoption> {
  try {
    return await adoptMissing(source, destination, prefix, journalPath);
  } catch {
    return { adopted: 0, failed: 1 };
  }
}

/**
 * q-34 fallback after a failed startup qualification: moves predecessor chats
 * where base's one-shot app-managed migrations would have, with no preimage
 * custody and no merge. Skipped while custody is pending, so replay keeps its frozen
 * sources. As in base, a move with failed entries leaves its marker unset so
 * the next launch retries it. Revisit when CAN-4710 owns whole-root migration.
 */
export async function adoptUnqualifiedCodeReviewPredecessors(): Promise<PredecessorAdoption> {
  for (const namespace of [
    'code_review_registry',
    'code_review_chats_dir',
    'code_review_chats_legacy',
  ] as const)
    assertAdmittedWriter(namespace, 'electron_main', MODULE, STORAGE_OWNERSHIP);
  const result = { adopted: 0, failed: 0, workspaceTreePending: false };
  const custody = join(getDataDir(), '.code-review-namespace-custody');
  const treePending = !(await hasMigrationRun(APP_WORKSPACES_MIGRATION_KEY));
  // Replay owns its frozen sources; a later launch retries once it settles.
  if ((await entryKind(join(custody, 'pending'))) !== 'absent')
    return { ...result, workspaceTreePending: treePending };
  // Qualification can fail before its own purge, e.g. on a linked `workspaces/`.
  await purgeAdoptionStaging(
    getAppManagedChatWorkspaceDir(CODE_REVIEW_CHAT_PROJECT_ID),
  );
  // Base skipped the tree move for an indexed id, too.
  if (await indexedSentinel()) return result;
  const destination = dirname(getCodeReviewChatsDir());
  // Unlike base, never mixes review history into an indexed real workspace;
  // routing that disagrees with the index has no safe destination either.
  if (
    destination !== getAppManagedChatWorkspaceDir(CODE_REVIEW_CHAT_PROJECT_ID)
  )
    return { ...result, workspaceTreePending: treePending };
  const add = (adoption: Adoption): Adoption => {
    result.adopted += adoption.adopted;
    result.failed += adoption.failed;
    return adoption;
  };
  if (treePending)
    result.workspaceTreePending =
      add(
        await adoptAll(
          getWorkspaceDir(CODE_REVIEW_CHAT_PROJECT_ID),
          destination,
          '',
          join(custody, 'adopting-workspace-tree.json'),
        ),
      ).failed > 0;
  if (
    !(await hasMigrationRun(CODE_REVIEW_CHATS_MIGRATION_KEY)) &&
    add(
      await adoptAll(
        getLegacyCodeReviewChatsDir(),
        destination,
        'chats',
        join(custody, 'adopting-legacy-chats.json'),
      ),
    ).failed === 0
  )
    await markMigrationRun(CODE_REVIEW_CHATS_MIGRATION_KEY);
  return result;
}
