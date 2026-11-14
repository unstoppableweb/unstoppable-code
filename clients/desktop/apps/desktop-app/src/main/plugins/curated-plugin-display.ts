import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CuratedPluginEntry } from '@canopy/protocol/plugin-catalog';
import type { PluginInfo, PluginProvider } from '@canopy/protocol/plugins';

export const CURATED_DISPLAY_FILE = 'canopy-display.json';

interface DisplayRecord {
  schemaVersion: 1;
  key: string;
  contentHash: string;
  displayName: string;
  shortDescription: string;
  publisher: string;
  publisherUrl: string;
  category: string;
  logoUrl: string;
}

/** Travels with the materialized revision, including provider copies. */
export function curatedPluginDisplay(entry: CuratedPluginEntry): DisplayRecord {
  return {
    schemaVersion: 1,
    key: entry.key,
    contentHash: entry.contentHash,
    displayName: entry.name,
    shortDescription: entry.shortDescription,
    publisher: entry.authorName ?? '',
    publisherUrl: entry.authorUrl ?? '',
    category: entry.categories[0] ?? '',
    logoUrl: entry.logoUrl ?? '',
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(file: string): Promise<unknown> {
  try {
    const text = await readFile(file, 'utf8');
    return text.length <= 64 * 1024 ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function readDisplay(
  root: string,
  provider: PluginProvider,
  key: string,
): Promise<DisplayRecord | null> {
  const value = await readJson(
    join(root, `.${provider}-plugin`, CURATED_DISPLAY_FILE),
  );
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.key !== key ||
    typeof value.contentHash !== 'string' ||
    !value.contentHash ||
    typeof value.displayName !== 'string' ||
    typeof value.shortDescription !== 'string' ||
    typeof value.publisher !== 'string' ||
    typeof value.publisherUrl !== 'string' ||
    typeof value.category !== 'string' ||
    typeof value.logoUrl !== 'string'
  )
    return null;
  if (value.logoUrl) {
    try {
      const url = new URL(value.logoUrl);
      if (url.protocol !== 'https:' || url.username || url.password)
        return null;
    } catch {
      return null;
    }
  }
  return {
    schemaVersion: 1,
    key,
    contentHash: value.contentHash,
    displayName: value.displayName,
    shortDescription: value.shortDescription,
    publisher: value.publisher,
    publisherUrl: value.publisherUrl,
    category: value.category,
    logoUrl: value.logoUrl,
  };
}

/** No catalog or sync-lock reads: display belongs to exactly this copy. */
export async function withCuratedPluginDisplay(
  plugin: PluginInfo,
): Promise<PluginInfo> {
  const statuses = plugin.globalInstallStatus;
  const providers: PluginProvider[] = ['claude', 'codex'];
  const known =
    statuses &&
    providers.every((provider) => {
      const status = statuses[provider];
      return status !== undefined && !status.error;
    });
  const installed = providers.filter(
    (provider) => statuses?.[provider]?.installed,
  );
  const first = installed[0];
  const materializedRoot =
    plugin.facets.claude?.installLocation ||
    plugin.facets.codex?.installLocation ||
    plugin.sourcePath;
  const root = first ? statuses?.[first]?.installPath : materializedRoot;
  let fallback = { ...plugin, logoUrl: undefined };
  if (first) {
    fallback = {
      ...fallback,
      displayName: plugin.name,
      description: '',
      author: '',
      category: '',
      version: '',
      homepage: '',
    };
  }
  if (first && root) {
    const manifest = await readJson(
      join(root, `.${first}-plugin`, 'plugin.json'),
    );
    if (record(manifest)) {
      fallback = {
        ...fallback,
        description:
          typeof manifest.description === 'string' ? manifest.description : '',
        version: typeof manifest.version === 'string' ? manifest.version : '',
        author:
          typeof manifest.author === 'string'
            ? manifest.author
            : record(manifest.author) &&
                typeof manifest.author.name === 'string'
              ? manifest.author.name
              : '',
        homepage:
          typeof manifest.homepage === 'string' ? manifest.homepage : '',
        category: '',
        displayName:
          record(manifest.interface) &&
          typeof manifest.interface.displayName === 'string'
            ? manifest.interface.displayName
            : plugin.name,
      };
    }
  }
  if (!known || !root) return fallback;
  const copies = installed.length
    ? installed
    : (['claude', 'codex'] satisfies PluginProvider[]);
  const records = await Promise.all(
    copies.map(async (provider) => {
      const location = installed.length
        ? statuses?.[provider]?.installPath
        : root;
      return location ? readDisplay(location, provider, plugin.name) : null;
    }),
  );
  const display = records[0];
  if (installed.includes('codex')) {
    const staged = await readDisplay(materializedRoot, 'codex', plugin.name);
    if (
      !staged ||
      records[installed.indexOf('codex')]?.contentHash !== staged.contentHash
    )
      return fallback;
  }
  if (
    !display ||
    records.some(
      (other) => !other || JSON.stringify(other) !== JSON.stringify(display),
    )
  )
    return fallback;
  return {
    ...fallback,
    displayName: display.displayName,
    description: display.shortDescription,
    author: display.publisher,
    category: display.category,
    logoUrl: display.logoUrl || undefined,
  };
}

/** Refresh only when a valid staged revision differs from the executed copy. */
export async function curatedCodexRefreshHash(
  stagedRoot: string,
  installedRoot: string,
  key: string,
): Promise<string | null> {
  const staged = await readDisplay(stagedRoot, 'codex', key);
  if (!staged) return null;
  const installed = await readDisplay(installedRoot, 'codex', key);
  return installed?.contentHash === staged.contentHash
    ? null
    : staged.contentHash;
}
