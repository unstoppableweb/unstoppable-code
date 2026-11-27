import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { safeReadJsonAsync } from '../lib/fs-utils';
import { isPathInside } from '../lib/path-safety';
export { projectClaudePluginForLaunch } from '@canopy/execution-engine/node/plugins/claude-mod-projection';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (normalized.length === 0 || normalized === '.' || normalized === '..') {
    return 'plugin';
  }
  return normalized;
}

async function removePath(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true });
}

/**
 * Remove `targetPath` from the projected copy rooted at `copyRoot` (a real
 * path) only when the folder holding it really is inside that copy. A link
 * the copy kept to a folder of the installed plugin would otherwise let the
 * removal reach the installed files. `rm` removes a link itself, never what
 * it points to, so the target may be a link.
 */
async function removeInsideCopy(
  copyRoot: string,
  targetPath: string,
): Promise<void> {
  let parent: string;
  try {
    parent = await fs.realpath(path.dirname(targetPath));
  } catch {
    return;
  }
  if (parent !== copyRoot && !isPathInside(copyRoot, parent)) return;
  await removePath(targetPath);
}

async function removeReferencedMcpFiles(
  sourcePluginPath: string,
  projectedPluginPath: string,
  copyRoot: string,
  rawManifest: Record<string, unknown>,
): Promise<void> {
  const manifestValue = rawManifest.mcpServers;
  const relativePaths =
    typeof manifestValue === 'string'
      ? [manifestValue]
      : Array.isArray(manifestValue)
        ? manifestValue.filter((entry): entry is string => {
            return typeof entry === 'string';
          })
        : [];

  for (const relativePath of relativePaths) {
    const sourcePath = path.resolve(sourcePluginPath, relativePath);
    if (!isPathInside(sourcePluginPath, sourcePath)) {
      continue;
    }

    const projectedPath = path.resolve(projectedPluginPath, relativePath);
    if (isPathInside(projectedPluginPath, projectedPath)) {
      await removeInsideCopy(copyRoot, projectedPath);
    }
  }

  await removeInsideCopy(copyRoot, path.join(projectedPluginPath, '.mcp.json'));
}

async function writeProjectedManifest(
  projectedPluginPath: string,
  rawManifest: Record<string, unknown>,
): Promise<void> {
  const withoutMcpServers: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawManifest)) {
    if (key !== 'mcpServers') {
      withoutMcpServers[key] = value;
    }
  }
  const manifestDir = path.join(projectedPluginPath, '.claude-plugin');
  // A `.claude-plugin` link the copy kept would send the write to the
  // installed plugin's manifest; the copy gets a folder of its own instead.
  const existing = await fs
    .lstat(manifestDir)
    .catch((): undefined => undefined);
  if (existing?.isSymbolicLink() === true) await removePath(manifestDir);
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(
    path.join(manifestDir, 'plugin.json'),
    JSON.stringify(withoutMcpServers, null, 2),
    'utf8',
  );
}

export async function projectClaudePluginWithoutMcpServers(options: {
  sourcePluginPath: string;
  marketplaceId: string;
  pluginName: string;
  projectionRootDir: string;
  warnings: string[];
}): Promise<string> {
  const projectedPluginPath = path.join(
    options.projectionRootDir,
    safeSegment(options.marketplaceId),
    safeSegment(options.pluginName),
  );
  if (!isPathInside(options.projectionRootDir, projectedPluginPath)) {
    options.warnings.push(
      `Projected path escaped "${options.projectionRootDir}"; using original plugin path.`,
    );
    return options.sourcePluginPath;
  }
  const manifestPath = path.join(
    options.sourcePluginPath,
    '.claude-plugin',
    'plugin.json',
  );
  const rawManifest =
    await safeReadJsonAsync<Record<string, unknown>>(manifestPath);

  // Copy from the real folder: an install path that is itself a link would
  // otherwise be copied as that link, and every change below would land in
  // the installed plugin.
  let sourceRoot: string;
  try {
    sourceRoot = await fs.realpath(options.sourcePluginPath);
  } catch {
    options.warnings.push(
      `Plugin "${options.marketplaceId}/${options.pluginName}" folder can't be read; using original plugin path.`,
    );
    return options.sourcePluginPath;
  }
  await removePath(projectedPluginPath);
  await fs.mkdir(path.dirname(projectedPluginPath), { recursive: true });
  await fs.cp(sourceRoot, projectedPluginPath, {
    recursive: true,
    force: true,
    dereference: false,
  });
  const copied = await fs
    .lstat(projectedPluginPath)
    .catch((): undefined => undefined);
  if (copied === undefined || !copied.isDirectory()) {
    // Never change anything that isn't a folder of the copy's own.
    await removePath(projectedPluginPath);
    options.warnings.push(
      `Plugin "${options.marketplaceId}/${options.pluginName}" couldn't be copied for this launch; using original plugin path.`,
    );
    return options.sourcePluginPath;
  }
  const copyRoot = await fs.realpath(projectedPluginPath);

  // With no manifest, Claude still reads the root `.mcp.json`, so the copy
  // drops it: the resolver owns these servers, and loading the plugin's own
  // file beside them would run a server it bound to an account, or left
  // out, under the plugin's own sign-in.
  if (!rawManifest || !isRecord(rawManifest)) {
    await removeInsideCopy(
      copyRoot,
      path.join(projectedPluginPath, '.mcp.json'),
    );
    return projectedPluginPath;
  }

  await removeReferencedMcpFiles(
    options.sourcePluginPath,
    projectedPluginPath,
    copyRoot,
    rawManifest,
  );
  await writeProjectedManifest(projectedPluginPath, rawManifest);
  return projectedPluginPath;
}
