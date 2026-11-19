import { basename, dirname, relative, resolve, sep } from 'node:path';
import type {
  STORAGE_OWNERSHIP,
  StorageOwnershipRow,
  StorageWriterPrincipal,
} from '@canopy/core-runtime/storage';
import {
  registeredCanopyDataRootResolver,
  registeredCanopySecureRootResolver,
} from './canopy-data-root-registration';

type OwnershipRow = (typeof STORAGE_OWNERSHIP)[number];

/** The storage rows whose `admittedWriters` the shared writer enforces. */
export type AdmittedStorageNamespace = Extract<
  OwnershipRow,
  { readonly admittedWriters: readonly string[] }
>['id'];

/** A write by an admitted module, abbreviated as in the manifest. */
export interface AdmittedWriterTarget {
  readonly namespace: AdmittedStorageNamespace;
  readonly writer: StorageWriterPrincipal;
  readonly module: string;
  /**
   * The rows that decide the write in place of the compiled ones (CAN-5092).
   * Whoever passes them decides the write, so only trusted composition may:
   * tests now, the daemon at the flip. check:daemon-writer-boundary refuses
   * any other production source that sets them, and the writer refuses them
   * for any namespace but pipeline_definitions.
   */
  readonly ownership?: readonly StorageOwnershipRow[];
}

/** The one namespace whose writes may carry their own ownership rows. */
export const OWNERSHIP_OVERRIDE_NAMESPACE = 'pipeline_definitions';

// Mirrors the rows' patterns in storage-ownership.yaml; a test compares them.
const DATA_ROOT_FILES: ReadonlyMap<string, AdmittedStorageNamespace> = new Map([
  ['app-advisor-watchers.json', 'app_advisor_watchers'],
  ['app-advisor-watchers-canonical.json', 'app_advisor_watchers_canonical'],
  ['preferences.json', 'preferences'],
  ['preferences.json.usage-data-denied.json', 'preferences'],
  ['preferences.last-good.json', 'preferences'],
  ['preferences.generation.json', 'preferences'],
  ['migrations.json', 'startup_migrations'],
  ['migrations.last-good.json', 'startup_migrations'],
  ['pipeline-plugin-preferences.json', 'pipeline_plugin_preferences'],
  ['pipeline-local-metadata.json', 'pipeline_local_metadata'],
  ['plugins-cache.json', 'plugins_cache'],
  ['plugin-cache-index.json', 'plugin_cache_index'],
]);

function isPluginCachePath(target: string, dataRoot: string | null): boolean {
  const parts = (
    dataRoot === null ? fold(target) : relative(fold(dataRoot), fold(target))
  ).split(sep);
  const index = dataRoot === null ? parts.indexOf('plugin-cache') : 0;
  return (
    index >= 0 &&
    parts[index] === 'plugin-cache' &&
    parts[index + 1] !== 'codex-compatibility'
  );
}
const PREFERENCES_BACKUP = /^preferences\.backup-.+\.json$/;
const MIGRATIONS_DAMAGED = /^migrations\.damaged-.+\.json$/;
const PIPELINE_PREFERENCES_DAMAGED =
  /^pipeline-plugin-preferences\.json\.damaged-.+$/;
const PIPELINE_DEFINITION_FILE =
  /^(?:index\.json|index\.json\.damaged-\d+|[a-z0-9_-]+\.yaml)$/;
const PROJECT_SHARE_LINKS_FILE = '.project-share-links.json';
const VAULT_DATABASE_FILE = /^vault\.sqlite(?:-wal|-shm)?$/;
const GITHUB_CREDENTIAL_FENCE_FILE = 'github-pat-fence.json';
const NATIVE_ARTIFACT_FILES = new Set([
  'owner.json',
  'core-secret-protection.node',
]);
const APPROVALS_FILE = 'approvals.json';
const APPROVALS_ROOTS = ['workspaces', 'app-workspaces'];
const TERMINAL_RECORD_FILE =
  /^(terminal-state|terminal-presentation)\.json(?:\.damaged-[^/]+)?$/;

function mcpRow(
  target: string,
  dataRoot: string | null,
): AdmittedStorageNamespace | undefined {
  const parts = (
    dataRoot === null ? fold(target) : relative(fold(dataRoot), fold(target))
  ).split(sep);
  if (
    parts.some(
      (part, index) =>
        (dataRoot === null || index === 0) &&
        part === 'mcp-servers' &&
        parts[index + 1] === 'removal-evidence',
    )
  )
    return 'mcp_removal_evidence';
  if (dataRoot !== null && parts.length !== 2) return undefined;
  if (parts[parts.length - 2] !== 'mcp-servers') return undefined;
  const name = parts[parts.length - 1] ?? '';
  if (name === 'index.json') return 'mcp_servers_index';
  if (
    name.startsWith('server-') &&
    name.endsWith('.json') &&
    name.length > 'server-.json'.length
  )
    return 'mcp_server_configs';
  return undefined;
}

function codeReviewRow(
  target: string,
  dataRoot: string | null,
): AdmittedStorageNamespace | undefined {
  const normalized = fold(target).replace(/\\/g, '/');
  const root =
    dataRoot === null
      ? null
      : fold(dataRoot).replace(/\\/g, '/').replace(/\/$/, '');
  if (root !== null && !normalized.startsWith(`${root}/`)) return undefined;
  const tail = root === null ? normalized : normalized.slice(root.length);
  if (
    root === null
      ? /\/(?:code-review-chats|\.code-review-namespace-custody)(?:\/.*)?$/.test(
          tail,
        )
      : /^\/(?:code-review-chats|\.code-review-namespace-custody)(?:\/.*)?$/.test(
          tail,
        )
  )
    return 'code_review_chats_legacy';
  const prefix = root === null ? '(?:^|/)' : '^/';
  if (
    new RegExp(
      `${prefix}(?:app-workspaces|workspaces)/code-review-chat/chats/registry\\.json$`,
    ).test(tail)
  )
    return 'code_review_registry';
  if (
    new RegExp(
      `${prefix}(?:app-workspaces|workspaces)/code-review-chat/chats$`,
    ).test(tail)
  )
    return 'code_review_chats_dir';
  if (
    new RegExp(
      `${prefix}(?:app-workspaces|workspaces)/[^/]+/worktree-data/[^/]+/code-review\\.json$`,
    ).test(tail)
  )
    return 'code_review_state';
  return undefined;
}

// macOS and Windows data roots are case-insensitive.
const fold = (path: string): string => resolve(path).toLowerCase();

function isNativeArtifactPath(
  target: string,
  dataRoot: string | null,
): boolean {
  const parent = dirname(target);
  const root =
    dataRoot === null ? null : fold(resolve(dataRoot, 'native-artifacts'));
  const isRoot = (candidate: string): boolean =>
    root === null
      ? basename(candidate).toLowerCase() === 'native-artifacts'
      : fold(candidate) === root;
  return (
    isRoot(target) ||
    isRoot(parent) ||
    (NATIVE_ARTIFACT_FILES.has(basename(target).toLowerCase()) &&
      isRoot(dirname(parent)))
  );
}

function dataRootFile(name: string): AdmittedStorageNamespace | undefined {
  return (
    DATA_ROOT_FILES.get(name) ??
    (PREFERENCES_BACKUP.test(name)
      ? 'preferences'
      : MIGRATIONS_DAMAGED.test(name)
        ? 'startup_migrations'
        : PIPELINE_PREFERENCES_DAMAGED.test(name)
          ? 'pipeline_plugin_preferences'
          : undefined)
  );
}

/** Whether `targetPath` has a curated row's file name; no data root needed. */
export function isAdmittedStorageCandidate(targetPath: string): boolean {
  const target = resolve(targetPath);
  const name = basename(target).toLowerCase();
  return (
    mcpRow(target, null) !== undefined ||
    codeReviewRow(target, null) !== undefined ||
    dataRootFile(name) !== undefined ||
    isPluginCachePath(target, null) ||
    name === APPROVALS_FILE ||
    TERMINAL_RECORD_FILE.test(name) ||
    name === GITHUB_CREDENTIAL_FENCE_FILE ||
    isNativeArtifactPath(target, null) ||
    name === 'vault' ||
    (basename(dirname(target)).toLowerCase() === 'vault' &&
      VAULT_DATABASE_FILE.test(name)) ||
    name === 'pipelines' ||
    (basename(dirname(target)).toLowerCase() === 'pipelines' &&
      (PIPELINE_DEFINITION_FILE.test(name) ||
        name === PROJECT_SHARE_LINKS_FILE))
  );
}

/**
 * The curated row `targetPath` belongs to under the data or secure root.
 * A `null` root matches the rows' shapes under any folder. A path that
 * reaches the row through a symbolic link is not seen.
 */
export function admittedStorageRowForPath(
  targetPath: string,
  dataRoot: string | null,
  secureDataRoot?: string | null,
): AdmittedStorageNamespace | undefined {
  const target = resolve(targetPath);
  const name = basename(target).toLowerCase();
  const parent = fold(dirname(target));
  const mcp = mcpRow(target, dataRoot);
  if (mcp !== undefined) return mcp;
  const review = codeReviewRow(target, dataRoot);
  if (review !== undefined) return review;
  if (isPluginCachePath(target, dataRoot)) return 'plugin_cache';
  const secureRoot =
    secureDataRoot === undefined && dataRoot === null ? null : secureDataRoot;
  if (isNativeArtifactPath(target, dataRoot))
    return 'daemon_native_artifact_snapshots';
  if (
    secureRoot !== undefined &&
    name === GITHUB_CREDENTIAL_FENCE_FILE &&
    (secureRoot === null || parent === fold(secureRoot))
  )
    return 'daemon_github_credential_fence';
  if (
    secureRoot !== undefined &&
    ((name === 'vault' &&
      (secureRoot === null || parent === fold(secureRoot))) ||
      (VAULT_DATABASE_FILE.test(name) &&
        (secureRoot === null
          ? basename(parent) === 'vault'
          : parent === fold(resolve(secureRoot, 'vault')))))
  )
    return 'daemon_vault_store';
  if (
    (name === 'pipelines' &&
      (dataRoot === null || parent === fold(dataRoot))) ||
    (PIPELINE_DEFINITION_FILE.test(name) &&
      (dataRoot === null
        ? basename(parent) === 'pipelines'
        : parent === fold(resolve(dataRoot, 'pipelines'))))
  )
    return 'pipeline_definitions';
  if (
    name === PROJECT_SHARE_LINKS_FILE &&
    (dataRoot === null
      ? basename(parent) === 'pipelines'
      : parent === fold(resolve(dataRoot, 'pipelines')))
  )
    return 'pipeline_project_share_links';
  const rootFile = dataRootFile(name);
  if (rootFile !== undefined)
    return dataRoot === null || parent === fold(dataRoot)
      ? rootFile
      : undefined;
  const terminalFile = TERMINAL_RECORD_FILE.exec(name);
  if (terminalFile) {
    const worktreeData = dirname(parent);
    const workspace = dirname(worktreeData);
    const containers = dirname(workspace);
    const matches =
      basename(worktreeData) === 'worktree-data' &&
      (dataRoot === null
        ? APPROVALS_ROOTS.includes(basename(containers))
        : APPROVALS_ROOTS.some(
            (folder) => containers === fold(resolve(dataRoot, folder)),
          ));
    return matches
      ? terminalFile[1] === 'terminal-state'
        ? 'terminal_state'
        : 'terminal_presentation'
      : undefined;
  }
  if (name !== APPROVALS_FILE) return undefined;
  const container = dirname(parent);
  const matches =
    dataRoot === null
      ? APPROVALS_ROOTS.includes(basename(container))
      : APPROVALS_ROOTS.some(
          (folder) => container === fold(resolve(dataRoot, folder)),
        );
  return matches ? 'workspace_approvals' : undefined;
}

// Loaded on the first candidate write: many suites mock canopy-paths with
// factories that cannot run while atomic-file loads.
interface StorageRoots {
  readonly dataRoot: () => string;
  readonly secureRoot?: () => string;
}
let dataRootResolver: Promise<StorageRoots> | undefined;

function isModuleNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ERR_MODULE_NOT_FOUND'
  );
}

async function loadDataRootResolver(): Promise<StorageRoots> {
  try {
    const paths = await import('../../canopy-paths');
    return {
      dataRoot: paths.getCanopyDataDir,
      secureRoot: paths.getCanopySecureDataDir,
    };
  } catch (error) {
    const registered = registeredCanopyDataRootResolver();
    if (registered === undefined || !isModuleNotFound(error)) throw error;
    return {
      dataRoot: registered,
      secureRoot: registeredCanopySecureRootResolver(),
    };
  }
}

/** {@link admittedStorageRowForPath} under the resolved Canopy storage roots. */
export async function admittedStorageRowForWrite(
  targetPath: string,
): Promise<AdmittedStorageNamespace | undefined> {
  if (!isAdmittedStorageCandidate(targetPath)) return undefined;
  const loading = (dataRootResolver ??= loadDataRootResolver());
  let roots: StorageRoots;
  try {
    roots = await loading;
  } catch (error) {
    // Refuses this write; a later one retries once canopy-paths registers.
    if (dataRootResolver === loading) dataRootResolver = undefined;
    throw error;
  }
  return admittedStorageRowForPath(
    targetPath,
    roots.dataRoot(),
    roots.secureRoot?.(),
  );
}
