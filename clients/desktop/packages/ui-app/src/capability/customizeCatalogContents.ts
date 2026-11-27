import { marketplaceTitleCase } from '@canopy/ui-shared';
import type {
  PluginContentsRow,
  PluginDetailFacetSlot,
} from '@canopy/ui-shared/components';
import {
  parsePluginManifestPreviewMcpServer,
  type PluginDetails,
  type PluginManifestPreview,
  type PluginManifestPreviewMcpServer,
} from '@canopy/protocol/plugins';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib/unified-plugin-entry';

function memberKey(type: string, name: string): string {
  // Names stay exact: `Build.md` and `build.md` are two members.
  return `${type.toLowerCase()}:${name}`;
}

/**
 * A skill, command, agent, app or hook row's key: a tagged tuple, so a member's
 * name never spells the key of a file's row. A later version's file that an
 * earlier version lists under another name keeps its own row, tagged with
 * that version.
 */
function rowKey(
  type: string,
  ...member:
    | readonly ['file', string]
    | readonly ['file', string, PluginDetailFacetSlot['kind']]
    | readonly ['unfiled', PluginDetailFacetSlot['kind'] | null, number]
    | readonly ['name', string]
    | readonly [
        'hook',
        event: string,
        matcher: string,
        hookType: string,
        command: string,
        async: boolean,
      ]
): string {
  return `${type.toLowerCase()}:${JSON.stringify(member)}`;
}

/** A humanized title can label a raw skill only if the match is unique. */
function skillTitle(name: string): string {
  return marketplaceTitleCase(name).toLowerCase();
}

/** One version's scan of the listing, and the version its files belong to. */
interface CatalogScan {
  readonly details: PluginDetails;
  readonly facet?: PluginDetailFacetSlot;
}

/**
 * The scans in the order their rows are listed: a plugin's versions in the
 * order the caller gives them (Claude's first), each that has details.
 */
function catalogScans(
  scanned: PluginDetails | readonly PluginDetailFacetSlot[] | null | undefined,
): readonly CatalogScan[] {
  if (!scanned) return [];
  if ('skills' in scanned) return [{ details: scanned }];
  return scanned.flatMap((facet) =>
    facet.facet.details ? [{ details: facet.facet.details, facet }] : [],
  );
}

/**
 * Contents before Add: first the marketplace scan, one row per file it read,
 * then the listing (or an installed copy), then the repository preview.
 * Each of the plugin's versions (Claude's, Codex's) was scanned on its own:
 * a member two versions list under the same name and file is one row, which
 * opens from the first version's files; any other file is its own row,
 * opening from the version that lists it. Name-only evidence (a listing's
 * skill titles, the preview's names and descriptions) fills a scanned row
 * only when exactly one file of that kind has the name; otherwise each file
 * keeps its own row. Kinds nothing names are left to the listing's counts.
 * Plugin-wide compatibility is not evidence that any particular member
 * loads, so it is not shown on these rows. Every name here was read from the
 * publisher's files or listing, so every row's name is private in session
 * replay.
 */
export function customizeCatalogContents(
  entry: UnifiedPluginEntry,
  /** A light preview's names, read from the repository's listing. */
  preview?: PluginManifestPreview,
  /**
   * The members the marketplace's scan read from the listing's own files,
   * with their descriptions and MCP endpoints: a plugin listed by path. Pass
   * the plugin's versions to keep which version each file belongs to.
   */
  scanned?: PluginDetails | readonly PluginDetailFacetSlot[] | null,
): PluginContentsRow[] {
  const scans = catalogScans(scanned);
  const sources = [
    entry,
    // Installed, or installed and waiting on a sign-in.
    ...(entry.marketplaceListings ?? []).filter(
      (listing) =>
        listing.state === 'installed' || listing.state === 'needs-auth',
    ),
  ];
  const rows = new Map<string, PluginContentsRow>();
  // The exact member name behind each skill, command, agent or app row; a
  // listing's title may relabel the row, never change what it matches.
  const exactNames = new Map<string, string>();
  // The scan's rows by kind and exact name: two files may share a name.
  const scannedByName = new Map<string, string[]>();
  // The version whose scan listed each scanned row first.
  const rowVersion = new Map<string, PluginDetailFacetSlot['kind'] | null>();
  // The first fileless row of each kind and exact name.
  const unfiledByName = new Map<string, string>();
  const addScanned = (
    scan: CatalogScan,
    type: string,
    componentType: 'skill' | 'command' | 'agent' | 'app',
    members: readonly { name: string; description: string; file: string }[],
  ): void => {
    const version = scan.facet?.kind ?? null;
    members.forEach((member, index) => {
      const byName = memberKey(type, member.name);
      const sameName = scannedByName.get(byName);
      let key: string;
      if (member.file) {
        // A member is its file; an earlier version's same file under the
        // same name is this member.
        const shared = rowKey(type, 'file', member.file);
        const listed = exactNames.get(shared);
        key =
          version !== null &&
          listed !== undefined &&
          listed !== member.name &&
          rowVersion.get(shared) !== version
            ? rowKey(type, 'file', member.file, version)
            : shared;
      } else {
        // One the scan gave no file keeps its place, and is an earlier
        // version's fileless member of the same name.
        const earlier = unfiledByName.get(byName);
        key =
          earlier !== undefined && rowVersion.get(earlier) !== version
            ? earlier
            : rowKey(type, 'unfiled', version, index);
        if (earlier === undefined) unfiledByName.set(byName, key);
      }
      if (rows.has(key)) return;
      const text = member.description.trim();
      rows.set(key, {
        key,
        type,
        name: member.name,
        replayBlockName: true,
        ...(text ? { description: text } : {}),
        ...(member.file
          ? {
              component: {
                componentType,
                file: member.file,
                ...(scan.facet ? { facet: scan.facet } : {}),
              },
            }
          : {}),
      });
      exactNames.set(key, member.name);
      rowVersion.set(key, version);
      // Appended in place: a publisher's list may repeat a name many times.
      if (sameName) sameName.push(key);
      else scannedByName.set(byName, [key]);
    });
  };
  for (const scan of scans) {
    const { details } = scan;
    addScanned(
      scan,
      'Skill',
      'skill',
      details.skills.map((skill) => ({
        ...skill,
        file: skill.path ? `${skill.path}/SKILL.md` : 'SKILL.md',
      })),
    );
    addScanned(
      scan,
      'Command',
      'command',
      details.commands.map((command) => ({
        ...command,
        file: command.filePath,
      })),
    );
    addScanned(
      scan,
      'Agent',
      'agent',
      details.agents.map((agent) => ({ ...agent, file: agent.filePath })),
    );
    // An app's Markdown opens like the other members.
    addScanned(
      scan,
      'App',
      'app',
      (details.apps ?? []).map((app) => ({ ...app, file: app.filePath })),
    );
  }
  /**
   * A member known only by name. It joins the one scanned file with that
   * exact name; when several files share it, they already have their rows.
   * `label` is a listing's humanized title for the row.
   */
  const addNamed = (type: string, name: string, label = name): void => {
    const byName = memberKey(type, name);
    const matches = scannedByName.get(byName) ?? [];
    if (matches.length > 1) return;
    const key = matches[0] ?? rowKey(type, 'name', name);
    const row = rows.get(key);
    if (!row) {
      rows.set(key, { key, type, name: label, replayBlockName: true });
      exactNames.set(key, name);
    } else if (row.name === name && label !== name) {
      // The first title a listing gives a member labels it.
      rows.set(key, { ...row, name: label });
    }
  };
  const rawSkills = new Set([
    ...scans.flatMap(({ details }) => details.skills.map(({ name }) => name)),
    ...(preview?.skills ?? []),
  ]);
  const skillByTitle = new Map<string, string | null>();
  for (const name of rawSkills) {
    const title = skillTitle(name);
    skillByTitle.set(title, skillByTitle.has(title) ? null : name);
  }
  for (const source of sources) {
    // Names read from plugin files, including names humanized for the listing,
    // are replay-blocked.
    for (const name of source.bundledSkillNames ?? []) {
      const title = skillTitle(name);
      const raw = skillByTitle.get(title);
      // An ambiguous title is redundant; show the distinct raw rows.
      if (raw === null) continue;
      if (raw !== undefined) {
        addNamed('Skill', raw, name);
        continue;
      }
      const key = `skill-title:${title}`;
      if (!rows.has(key))
        rows.set(key, { key, type: 'Skill', name, replayBlockName: true });
    }
    // A listing's server names may come from the plugin's own config, so
    // every copy's names are private, not only another copy's.
    for (const server of source.bundledServers ?? []) {
      const key = `mcp:${server.key}`;
      if (!rows.has(key))
        rows.set(key, {
          key,
          type: 'MCP server',
          name: server.name,
          replayBlockName: true,
        });
    }
  }
  // A preview that only says hooks exist gets one generic row; a scan that
  // lists them gets a row per hook, as the installed list shows them.
  let scannedHooks = false;
  for (const { details } of scans) {
    // Two versions that list a hook identically share its row; hooks that
    // differ only in `async` are two.
    for (const hook of details.hooks) {
      scannedHooks = true;
      const key = rowKey(
        'Hook',
        'hook',
        hook.event,
        hook.matcher ?? '',
        hook.hookType,
        hook.command ?? '',
        hook.async === true,
      );
      if (!rows.has(key))
        rows.set(key, {
          key,
          type: 'Hook',
          name: hook.event,
          description: [
            hook.matcher,
            hook.hookType,
            hook.async === true ? 'async' : undefined,
          ]
            .filter(Boolean)
            .join(' · '),
          replayBlockName: true,
        });
    }
    // Mods and LSP servers have no file to open; each row is one definition,
    // as the installed list keys them, with what it runs on the second line.
    for (const mod of details.mods ?? []) {
      const key = `mod:${JSON.stringify([mod.hooksFile, mod.module])}`;
      if (!rows.has(key))
        rows.set(key, {
          key,
          type: 'Mod',
          name: mod.module,
          description: mod.hooksFile,
          replayBlockName: true,
        });
    }
    for (const server of details.lspServers) {
      const commandLine = [server.command, ...(server.args ?? [])].join(' ');
      const key = `lsp:${JSON.stringify([server.name, server.command, server.args ?? []])}`;
      if (!rows.has(key))
        rows.set(key, {
          key,
          type: 'LSP server',
          name: server.name,
          description: [commandLine, server.languages?.join(', ')]
            .filter(Boolean)
            .join(' · '),
          replayBlockName: true,
        });
    }
  }
  if (preview) {
    for (const name of preview.skills) addNamed('Skill', name);
    for (const name of preview.commands) addNamed('Command', name);
    for (const name of preview.agents) addNamed('Agent', name);
    for (const name of preview.apps ?? []) addNamed('App', name);
    // A root app config names its apps only once added; one generic row.
    if (preview.rootApp)
      rows.set('app:config', {
        key: 'app:config',
        type: 'App',
        name: 'Apps',
        description: '.app.json',
      });
    if (preview.hooks && !scannedHooks)
      rows.set('hook:Hooks', {
        key: 'hook:Hooks',
        type: 'Hook',
        name: 'Hooks',
        replayBlockName: true,
      });
    // A preview names Mods and LSP servers only; a scan's row for the same
    // name says more, so the preview adds only names no scan lists.
    const scannedMods = new Set(
      scans.flatMap(({ details }) =>
        (details.mods ?? []).map(({ module }) => module),
      ),
    );
    const scannedLsp = new Set(
      scans.flatMap(({ details }) =>
        details.lspServers.map(({ name }) => name),
      ),
    );
    for (const name of preview.mods ?? [])
      if (!scannedMods.has(name))
        rows.set(`mod:name:${name}`, {
          key: `mod:name:${name}`,
          type: 'Mod',
          name,
          replayBlockName: true,
        });
    for (const name of preview.lspServers ?? [])
      if (!scannedLsp.has(name))
        rows.set(`lsp:name:${name}`, {
          key: `lsp:name:${name}`,
          type: 'LSP server',
          name,
          replayBlockName: true,
        });
  }
  mergeCatalogMcpRows(rows, scans, preview);
  return [...rows.values()].map((row) => {
    if (row.description) return row;
    // A preview description is keyed by exact name: it describes a row only
    // when no other file of that kind has the name.
    const name = exactNames.get(row.key);
    if (name === undefined) return row;
    const byName = memberKey(row.type, name);
    if ((scannedByName.get(byName)?.length ?? 1) > 1) return row;
    const text = preview?.descriptions?.[byName];
    return text ? { ...row, description: text } : row;
  });
}

function mergeCatalogMcpRows(
  rows: Map<string, PluginContentsRow>,
  scans: readonly CatalogScan[],
  preview: PluginManifestPreview | undefined,
): void {
  const names = new Set([
    ...scans.flatMap(({ details }) =>
      details.mcpServers.map((server) => server.name),
    ),
    ...(preview?.mcpServerNames ?? []),
  ]);
  // Within a source the last definition of a name wins, as the runtime
  // merges a plugin's MCP config files; the first version's scan that names
  // a server wins over a later version's, and any scan over the preview. A
  // definition too long to show leaves its row without one.
  const lastByName = (
    servers: readonly { readonly name: string }[],
  ): Map<string, PluginManifestPreviewMcpServer | null> => {
    const byName = new Map<string, PluginManifestPreviewMcpServer | null>();
    for (const server of servers)
      byName.set(server.name, parsePluginManifestPreviewMcpServer(server));
    return byName;
  };
  const fromScans = scans.map(({ details }) => lastByName(details.mcpServers));
  const fromPreview = lastByName(preview?.mcpServerEndpoints ?? []);
  const endpoints = new Map<string, PluginManifestPreviewMcpServer>();
  for (const name of names) {
    const fromScan = fromScans.find((byName) => byName.has(name));
    const endpoint = fromScan ? fromScan.get(name) : fromPreview.get(name);
    if (endpoint) endpoints.set(name, endpoint);
  }
  const byLowercase = new Map<string, string | null>();
  for (const name of names) {
    const lower = name.toLowerCase();
    byLowercase.set(lower, byLowercase.has(lower) ? null : name);
  }
  const mcpRows = [...rows.values()].filter((row) => row.type === 'MCP server');
  const remaining = new Set(names);
  const fill = (row: PluginContentsRow, name: string): void => {
    remaining.delete(name);
    const endpoint = endpoints.get(name);
    if (endpoint) rows.set(row.key, { ...row, endpoint });
  };
  const keyName = (row: PluginContentsRow): string =>
    row.key.slice('mcp:'.length);
  // Reserve exact configuration keys before trying display-name aliases.
  // An ambiguous case fold must not merge distinct configured servers.
  for (const row of mcpRows) {
    const name = keyName(row);
    if (names.has(name)) fill(row, name);
  }
  for (const row of mcpRows) {
    const key = keyName(row);
    if (names.has(key)) continue;
    const name =
      byLowercase.get(key.toLowerCase()) ??
      (names.has(row.name)
        ? row.name
        : byLowercase.get(row.name.toLowerCase()));
    if (name && remaining.has(name)) fill(row, name);
  }
  for (const name of remaining) {
    const key = `mcp:${name}`;
    const endpoint = endpoints.get(name);
    rows.set(key, {
      key,
      type: 'MCP server',
      name,
      replayBlockName: true,
      ...(endpoint ? { endpoint } : {}),
    });
  }
  if (preview?.mcpServers && names.size === 0 && mcpRows.length === 0)
    rows.set('mcp:summary', {
      key: 'mcp:summary',
      type: 'MCP server',
      name: 'MCP servers',
    });
}
