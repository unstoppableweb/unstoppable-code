import type {
  CoreHookSource,
  CoreScriptDefinition,
  CoreScriptSourceKind,
} from '@canopy/protocol/canopy-core';

// ---------------------------------------------------------------------------
// A project's scripts and hooks on the Shared setup panel (CAN-6239, phase
// 08): what this computer runs for the project, each with the layer that
// supplied it, read-only. They come from the checkout on one computer, so
// only a host with that checkout (desktop) supplies them; the hosted
// `portableConfig` copy runs nowhere and is never shown.
// ---------------------------------------------------------------------------

/** Where a script or hook a run would use comes from. */
export type ProjectLocalSource =
  /** The repository's project config file (`canopy.json` for the default brand). */
  | 'repository'
  /** The repository's `conductor.json`, a fallback for lifecycle scripts. */
  | 'conductor'
  /** The multi-repository project's own config file or stored manifest. */
  | 'project'
  /** This computer's override. */
  | 'this-computer';

/** One script or hook row. */
export interface ProjectLocalRow {
  readonly key: string;
  /** Stable and DOM-safe, for test ids. */
  readonly testKey: string;
  /** The script's or hook trigger's name as people read it. */
  readonly name: string;
  /** The repository it belongs to, or null for the project as a whole. */
  readonly repositoryKey: string | null;
  readonly source: ProjectLocalSource;
  /** False when a layer turned it off. */
  readonly on: boolean;
  /** The command, or what the hook runs, in a few words. */
  readonly detail: string | null;
  /**
   * The config file a `repository` or `project` source names, as this
   * computer reads it; null for the other sources.
   */
  readonly configFile: string | null;
}

/**
 * The config files a row's source can name: the repository's own, and the
 * project's (a multi-repository project's root; the repository's own in a
 * single-repository project).
 */
export interface ProjectLocalConfigFiles {
  readonly repository: string;
  readonly project: string;
}

/** Where a repository's config file opens to edit. */
export type ProjectLocalEditTarget =
  | { readonly kind: 'web'; readonly url: string }
  | { readonly kind: 'local' };

export interface ProjectLocalRepository {
  readonly key: string;
  readonly name: string;
  /**
   * The config file this repository uses: the first of the brand's
   * `storage.configFileNames` its checkout has, else the brand's primary
   * name.
   */
  readonly configFile: string;
  /** Null when there is nowhere to open it (no checkout and no known host). */
  readonly edit: ProjectLocalEditTarget | null;
}

export interface ProjectLocalSetup {
  readonly repositories: readonly ProjectLocalRepository[];
  readonly scripts: readonly ProjectLocalRow[];
  readonly hooks: readonly ProjectLocalRow[];
}

/**
 * The host's reads of a project's scripts and hooks. Only a host with the
 * project's checkout supplies one; without it the panel says to open the
 * desktop app.
 */
export interface ProjectLocalSetupPort {
  /** The scripts and hooks, or null when the project is not on this computer. */
  read(): Promise<ProjectLocalSetup | null>;
  /** Opens a repository's config file where it can be edited. */
  editInRepository(repository: ProjectLocalRepository): Promise<void>;
}

/** The sections that come from this computer's checkout, in panel order. */
export const PROJECT_LOCAL_SECTION_KINDS = ['script', 'hook'] as const;

export type ProjectLocalSectionKind =
  (typeof PROJECT_LOCAL_SECTION_KINDS)[number];

function sourceOfScript(kind: CoreScriptSourceKind): {
  readonly source: ProjectLocalSource;
  readonly on: boolean;
} | null {
  switch (kind) {
    case 'repo-canopy':
      return { source: 'repository', on: true };
    case 'repo-conductor':
    case 'workspace-conductor':
      return { source: 'conductor', on: true };
    case 'workspace-hook':
    case 'workspace-manifest':
      return { source: 'project', on: true };
    case 'workspace-manifest-disabled':
    case 'workspace-hook-disabled':
      return { source: 'project', on: false };
    case 'local-override':
      return { source: 'this-computer', on: true };
    case 'local-disabled':
      return { source: 'this-computer', on: false };
    case 'none':
      return null;
  }
}

function configFileOf(
  source: ProjectLocalSource,
  files: ProjectLocalConfigFiles,
): string | null {
  if (source === 'repository') return files.repository;
  if (source === 'project') return files.project;
  return null;
}

function testKeyOf(
  kind: ProjectLocalSectionKind,
  repositoryKey: string | null,
  name: string,
): string {
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '-');
  return `${kind}-${safe(repositoryKey ?? 'project')}-${safe(name)}`;
}

/**
 * Script rows from the effective definitions of one target
 * (`core.script.definition.list`), with the layer that supplied each.
 */
export function projectLocalScriptRows(
  definitions: readonly CoreScriptDefinition[],
  repositoryKey: string | null,
  files: ProjectLocalConfigFiles,
  label: (name: string) => string = (name) => name,
): ProjectLocalRow[] {
  return definitions.flatMap((definition): ProjectLocalRow[] => {
    const origin = sourceOfScript(definition.source);
    if (origin === null) return [];
    return [
      {
        key: `script:${repositoryKey ?? ''}:${definition.name}`,
        testKey: testKeyOf('script', repositoryKey, definition.name),
        name: label(definition.name),
        repositoryKey,
        source: origin.source,
        on: origin.on && definition.state === 'enabled',
        detail: definition.state === 'enabled' ? definition.command : null,
        configFile: configFileOf(origin.source, files),
      },
    ];
  });
}

function hookActionSummary(source: CoreHookSource): string | null {
  if (source.actions === null || source.actions.length === 0) return null;
  const parts = source.actions.map((action) => {
    const value = (field: string): string | null => {
      const read: unknown = action[field];
      return typeof read === 'string' && read.trim() !== ''
        ? read.trim()
        : null;
    };
    switch (action.type) {
      case 'command':
        return value('command') ?? 'Command';
      case 'chat':
        return 'Starts a chat';
      case 'pipeline':
        return 'Runs a workflow';
    }
  });
  return parts.join(', ');
}

/**
 * Hook rows from the resolved hook sources of one target
 * (`core.initiatedWork.source.list`), with the layer that supplied each.
 */
export function projectLocalHookRows(
  sources: readonly CoreHookSource[],
  repositoryKey: string | null,
  files: ProjectLocalConfigFiles,
  label: (triggerName: string) => string = (name) => name,
): ProjectLocalRow[] {
  return sources.flatMap((hook): ProjectLocalRow[] => {
    const origin = sourceOfScript(hook.origin);
    if (origin === null) return [];
    return [
      {
        key: `hook:${repositoryKey ?? ''}:${hook.triggerName}`,
        testKey: testKeyOf('hook', repositoryKey, hook.triggerName),
        name: label(hook.triggerName),
        repositoryKey,
        source: origin.source,
        on: origin.on && hook.actions !== null,
        detail: hookActionSummary(hook),
        configFile: configFileOf(origin.source, files),
      },
    ];
  });
}

// --- "Edit in repo" ---------------------------------------------------------

/** Hosts whose file pages we know how to link to. */
const KNOWN_HOSTS = ['github.com', 'gitlab.com'] as const;
type KnownHost = (typeof KNOWN_HOSTS)[number];

function knownHost(host: string): KnownHost | null {
  const lower = host.toLowerCase();
  return KNOWN_HOSTS.find((candidate) => candidate === lower) ?? null;
}

/** The host and repository path of a remote URL, from https or ssh forms. */
function remoteParts(
  remoteUrl: string,
): { readonly host: string; readonly path: string } | null {
  const value = remoteUrl.trim();
  // scp-like ssh, with or without its user (the worker reports remotes
  // without userinfo): git@github.com:owner/repo.git, github.com:owner/repo
  const scp =
    /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+):(?!\/)(.+)$/.exec(
      value,
    );
  if (scp?.[1] !== undefined && scp[2] !== undefined)
    return { host: scp[1], path: scp[2] };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!['https:', 'http:', 'ssh:', 'git+ssh:'].includes(url.protocol))
    return null;
  return { host: url.hostname, path: url.pathname };
}

/**
 * The web page of `file` in the repository `remoteUrl` names, on its default
 * branch, for GitHub and GitLab remotes; null for any other host. `HEAD`
 * names the default branch on both hosts, so the link opens where teammates
 * change the file, whatever branch this computer has checked out.
 */
export function repositoryFileUrl(
  remoteUrl: string,
  file: string,
): string | null {
  const parts = remoteParts(remoteUrl);
  if (parts === null) return null;
  const host = knownHost(parts.host);
  if (host === null) return null;
  const segments = parts.path
    .replace(/\.git\/?$/, '')
    .split('/')
    .filter((segment) => segment !== '');
  // GitHub names owner/repo; GitLab allows nested groups.
  if (host === 'github.com' ? segments.length !== 2 : segments.length < 2)
    return null;
  if (segments.some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment)))
    return null;
  const repository = segments.join('/');
  const encodedFile = file
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return host === 'github.com'
    ? `https://github.com/${repository}/blob/HEAD/${encodedFile}`
    : `https://gitlab.com/${repository}/-/blob/HEAD/${encodedFile}`;
}

/**
 * The config file a checkout uses, with the runtime's precedence
 * (`findExistingProjectConfigFile`): the first of `brandNames`, in brand
 * order, that `present` holds; else the brand's primary name, which is also
 * the answer when the checkout could not be read.
 */
export function activeProjectConfigFile(
  present: readonly string[],
  brandNames: readonly string[],
): string {
  const found = brandNames.find((name) => present.includes(name));
  const primary = brandNames[0];
  if (primary === undefined)
    throw new Error('The brand names no project config file');
  return found ?? primary;
}

/**
 * Where a repository's config file (`configFile`) opens: its page on a known
 * host, else this computer's checkout when there is one, else nowhere.
 */
export function projectLocalEditTarget(
  remoteUrl: string | null,
  hasCheckout: boolean,
  configFile: string,
): ProjectLocalEditTarget | null {
  const url =
    remoteUrl === null ? null : repositoryFileUrl(remoteUrl, configFile);
  if (url !== null) return { kind: 'web', url };
  return hasCheckout ? { kind: 'local' } : null;
}
