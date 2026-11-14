import { createHash } from 'node:crypto';
import {
  CatalogHostRefusedError,
  type CatalogPluginTarget,
  type CatalogPublication,
  type CatalogPublishOptions,
  type CatalogPublishPackage,
} from '@canopy/core-runtime/node/catalog';
import { pluginEntryId } from '@canopy/protocol/canopy-core';
import type { PipelinePackageManifestV1 } from '@canopy/protocol/pipelines';
import {
  CanopyCloudClientError,
  type CanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import type { DesktopPluginUpload } from '../canopy-cloud/plugin-marketplaces';
import type { CloudCopySubject } from '../pipelines/pipeline-package-service';
import {
  PackageAnalysisBlockedError,
  ShareOperationError,
} from '../sharing/share-operation-result';

/** What a local plugin publish calls; tests inject fakes. Defaults load lazily. */
export interface PublishPluginPackageDeps {
  /**
   * The selected files of a live analysis made for a cloud copy of `subject`
   * over the plugin as it is now; throws `dependency-review` for an expired,
   * blocked or stale one, or one made for anything else.
   */
  readPackage: (
    pkg: CatalogPublishPackage,
    subject: CloudCopySubject,
    /** The account the analysis must have been issued for. */
    accountId: string | undefined,
  ) => Promise<{
    manifest: PipelinePackageManifestV1;
    readBlob: (sha256: string) => Uint8Array;
  }>;
  /**
   * The signed-in account's credentials, resolved once per publish so every
   * request lands in the account the person consented under; throws
   * `missing-api-key` when signed out.
   */
  credentials: () => Promise<CanopyCloudCredentialContext>;
  missingBlobs: (
    hashes: readonly string[],
    context: CanopyCloudCredentialContext,
  ) => Promise<string[]>;
  upload: (
    upload: DesktopPluginUpload,
    context: CanopyCloudCredentialContext,
  ) => Promise<{
    marketplaceId: string;
    pluginKey: string;
    contentHash: string | null;
  }>;
}

const defaultDeps: PublishPluginPackageDeps = {
  readPackage: async (pkg, subject, accountId) =>
    (
      await import('../pipelines/pipeline-package-service')
    ).readAnalyzedCapabilityPackage({
      ...pkg,
      cloudCopyOf: subject,
      ...(accountId === undefined ? {} : { cloudCopyAccountId: accountId }),
    }),
  credentials: async () => {
    const { resolveCanopyCloudCredentialContext } =
      await import('../canopy-cloud/client');
    const context = await resolveCanopyCloudCredentialContext();
    if (!context.apiKey)
      throw new CanopyCloudClientError(
        'missing-api-key',
        'Sign in to add plugins to the cloud.',
      );
    return context;
  },
  missingBlobs: async (hashes, context) =>
    (
      await import('../canopy-cloud/plugin-marketplaces')
    ).missingDesktopPluginBlobs(hashes, context),
  upload: async (upload, context) =>
    (await import('../canopy-cloud/plugin-marketplaces')).uploadDesktopPlugin(
      upload,
      context,
    ),
};

/**
 * Hooks, MCP and LSP configs never leave the desktop. The analyzer already
 * reduces the manifest to its name, version, description and the component
 * paths it declares inside the plugin, and collects only skills, commands and
 * agents; this drops anything else of that kind
 * before upload, and the cloud drops it again whatever arrives.
 */
function isWithheldPluginPath(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  const name = segments[segments.length - 1] ?? '';
  return (
    segments.includes('hooks') ||
    name.endsWith('hooks.json') ||
    name === '.mcp.json' ||
    name === '.lsp.json'
  );
}

/**
 * The plugin's own files from the consented package, by path relative to the
 * plugin root: its Claude tree, which the cloud builds from. Another plugin's
 * or skill's resources in the package stay behind.
 */
function pluginFiles(
  manifest: PipelinePackageManifestV1,
  target: CatalogPluginTarget,
): Map<string, string> {
  const files = new Map<string, string>();
  for (const resource of manifest.resources) {
    const ref = resource.installedItemRef;
    if (
      ref?.kind !== 'plugin' ||
      ref.marketplaceId !== target.marketplaceId ||
      ref.pluginName !== target.pluginName
    )
      continue;
    for (const tree of resource.trees) {
      if (tree.provider !== 'claude' || tree.runtimeKind !== 'plugin_fragment')
        continue;
      for (const entry of tree.entries) {
        if (isWithheldPluginPath(entry.path)) continue;
        const known = files.get(entry.path);
        // One analysis reads each file once; two hashes for a path mean the
        // package is not one consistent read of the plugin.
        if (known !== undefined && known !== entry.sha256)
          throw new CatalogHostRefusedError('publish-package-stale');
        files.set(entry.path, entry.sha256);
      }
    }
  }
  return files;
}

const MANIFEST_PATH = '.claude-plugin/plugin.json';
const DEFAULT_ROOTS = {
  skills: 'skills',
  commands: 'commands',
  agents: 'agents',
} as const;
const COMPONENT_KEYS = ['skills', 'commands', 'agents'] as const;

const withinRoot = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);

/**
 * The manifest as the cloud builder should read it. The analyzer keeps the
 * plugin's own declared component paths, only those inside the plugin, so
 * nothing here adds a path the plugin didn't declare: a linked doc or a
 * named agent is uploaded as a supporting file, never declared. Two
 * adjustments match how the plugin runs on the desktop. A declaration
 * replaces the default root in the cloud but adds to it locally, so a
 * default root holding uploaded files is declared too. And a declared path
 * with no uploaded files (all withheld, say) is dropped, since the cloud
 * refuses an empty one. Returns null when the analysed manifest stands.
 */
function uploadedManifest(
  analysed: Uint8Array,
  uploaded: readonly string[],
): Uint8Array | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(analysed));
  } catch {
    // The analyzer writes this manifest itself; upload it as it is.
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return null;
  const manifest: Record<string, unknown> = { ...parsed };
  let changed = false;
  for (const key of COMPONENT_KEYS) {
    const declared = manifest[key];
    if (!Array.isArray(declared)) continue;
    const holding = declared.filter(
      (value): value is string =>
        typeof value === 'string' &&
        uploaded.some((path) => withinRoot(path, value.replace(/^\.\//, ''))),
    );
    const root = DEFAULT_ROOTS[key];
    if (
      !holding.includes(`./${root}`) &&
      uploaded.some((path) => withinRoot(path, root))
    )
      holding.push(`./${root}`);
    if (
      holding.length === declared.length &&
      holding.every((value, index) => value === declared[index])
    )
      continue;
    changed = true;
    if (holding.length === 0) delete manifest[key];
    else manifest[key] = holding;
  }
  return changed
    ? new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)
    : null;
}

const isNameTaken = (error: unknown): boolean =>
  error instanceof CanopyCloudClientError &&
  error.status === 409 &&
  error.serverCode === 'plugin_name_taken';

function cloudRefusal(error: unknown): CatalogHostRefusedError {
  if (error instanceof CatalogHostRefusedError) return error;
  return new CatalogHostRefusedError(
    error instanceof PackageAnalysisBlockedError
      ? 'publish-package-blocked'
      : error instanceof ShareOperationError &&
          error.kind === 'dependency-review'
        ? 'publish-package-stale'
        : isNameTaken(error)
          ? 'publish-name-taken'
          : error instanceof CanopyCloudClientError && error.status === 409
            ? 'publish-revision-moved'
            : error instanceof CanopyCloudClientError &&
                (error.status === 400 || error.status === 413)
              ? 'publish-source-unsupported'
              : 'publish-remote-unavailable',
    error,
  );
}

/**
 * Uploads a local or private-marketplace plugin as the account's private
 * cloud copy (CAN-6176 D13, PR 9b). Only the consented package's files of
 * this plugin travel, read from an analysis made for a cloud copy of this
 * plugin over the plugin as it is now, so an analysis made for sharing,
 * another item or anything else, or a plugin edited after the consent dialog,
 * answers `publish-package-stale` and nothing uploads. Content the account's
 * desktop marketplace already holds is sent by hash alone.
 */
export async function publishPluginPackageToCloud(
  target: CatalogPluginTarget,
  pkg: CatalogPublishPackage,
  /** The plugin's local marketplace; a same-named plugin from another is refused. */
  source: { id: string; label: string },
  deps: PublishPluginPackageDeps = defaultDeps,
  options: CatalogPublishOptions = {},
): Promise<CatalogPublication> {
  let read: Awaited<ReturnType<PublishPluginPackageDeps['readPackage']>>;
  try {
    // The analysis must be the consent dialog's own, for this account.
    read = await deps.readPackage(
      pkg,
      {
        kind: 'plugin',
        marketplaceId: target.marketplaceId,
        pluginName: target.pluginName,
      },
      options.expectedAccountId,
    );
  } catch (error) {
    throw cloudRefusal(error);
  }
  const files = pluginFiles(read.manifest, target);
  // An analysis of something else, or a plugin with nothing the cloud runs.
  if (files.size === 0)
    throw new CatalogHostRefusedError('publish-package-stale');
  const extra = new Map<string, Uint8Array>();
  const analysedManifest = files.get(MANIFEST_PATH);
  const declared =
    analysedManifest === undefined
      ? null
      : uploadedManifest(read.readBlob(analysedManifest), [...files.keys()]);
  if (declared !== null) {
    const sha256 = createHash('sha256').update(declared).digest('hex');
    extra.set(sha256, declared);
    files.set(MANIFEST_PATH, sha256);
  }
  const contentOf = (sha256: string): string =>
    Buffer.from(extra.get(sha256) ?? read.readBlob(sha256)).toString('base64');
  const request = (missing: ReadonlySet<string>): DesktopPluginUpload => ({
    pluginKey: target.pluginName,
    source,
    files: [...files].map(([path, sha256]) =>
      missing.has(sha256)
        ? { path, sha256, content: contentOf(sha256) }
        : { path, sha256 },
    ),
  });
  const hashes = [...new Set(files.values())];
  try {
    // Every request below uses this one context, so an account switch
    // mid-publish cannot split the upload across accounts.
    const context = await deps.credentials();
    if (
      options.expectedAccountId !== undefined &&
      context.account?.id !== options.expectedAccountId
    )
      throw new CatalogHostRefusedError('publish-account-mismatch');
    let uploaded: Awaited<ReturnType<PublishPluginPackageDeps['upload']>>;
    try {
      uploaded = await deps.upload(
        request(new Set(await deps.missingBlobs(hashes, context))),
        context,
      );
    } catch (error) {
      if (
        !(error instanceof CanopyCloudClientError && error.status === 409) ||
        isNameTaken(error)
      )
        throw error;
      // Content the marketplace held was collected in between: send it once.
      // A 409 with nothing missing is another change that landed first.
      const missing = await deps.missingBlobs(hashes, context);
      if (missing.length === 0) throw error;
      uploaded = await deps.upload(request(new Set(missing)), context);
    }
    return {
      publicationId: uploaded.marketplaceId,
      remoteEntryId: pluginEntryId({
        marketplaceId: `marketplace:${uploaded.marketplaceId}`,
        pluginName: uploaded.pluginKey,
      }),
      revision: uploaded.contentHash ?? uploaded.marketplaceId,
    };
  } catch (error) {
    throw cloudRefusal(error);
  }
}
