/**
 * Claude Mod admission controls. A Mod is a plugin's `modules` hooks code;
 * while the desktop's admission flag is on, a Mod loads in a Claude chat only
 * after the person allows it at the plugin's current content. The desktop
 * keeps the allowed Mods and the "turn off every Mod" switch in its
 * preferences, and web Remote Control reads and changes them on the
 * directly controlled computer (CAN-7436), so both surfaces agree.
 */

import type { ClaudeModSurfaceCommandArgs } from '../extension-ui';

/** How a plugin's Mod stands for the next Claude chat that starts. */
export type ClaudeModPluginStatus =
  /** Allowed at the plugin's current content. */
  | 'allowed'
  /** Allowed before, but the content has changed since; it does not load. */
  | 'changed'
  /** The plugin has a Mod that is not allowed. */
  | 'not-allowed'
  /** The plugin is not installed, has no Mod, or could not be read. */
  | 'unavailable';

export interface ClaudeModPluginState {
  /** The Claude plugin id, `<plugin>@<marketplace>`. */
  readonly pluginId: string;
  readonly status: ClaudeModPluginStatus;
  /**
   * The plugin's current content digest. An `allow` update must name it, so
   * the person allows the content they looked at. Absent when unavailable.
   */
  readonly contentDigest?: string;
  /** The plugin's catalog entry, when it has a details page. */
  readonly details?: ClaudeModPluginDetailsTarget;
}

/** A catalog plugin's details page: its marketplace and catalog name. */
export interface ClaudeModPluginDetailsTarget {
  readonly marketplaceId: string;
  readonly pluginName: string;
}

/**
 * The chat a request comes from. The desktop resolves it to the folder that
 * chat launches in, so a project skills-folder plugin is found; a browser
 * never sends a path.
 */
export interface ClaudeModsChatContext {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  /**
   * The chat's selected repository in a multi-repository worktree. The
   * desktop accepts only a repository of that worktree; without it, the
   * worktree folder is used.
   */
  readonly repoId?: string;
}

export interface ClaudeModsState {
  /** The desktop's Mod admission flag. While it is off, hosts show no controls. */
  readonly enabled: boolean;
  /** The "turn off every Mod" switch: while on, no Mod loads. */
  readonly modsDisabled: boolean;
  /** Preferences could not be read: no Mod loads and changes are refused. */
  readonly authorityUnreadable: boolean;
  /** The plugin named by `ClaudeModsGetArgs.pluginId` or by the update. */
  readonly plugin?: ClaudeModPluginState;
}

export interface ClaudeModsGetArgs {
  readonly pluginId?: string;
  readonly context?: ClaudeModsChatContext;
}

export type ClaudeModsUpdate =
  | {
      readonly action: 'allow';
      readonly pluginId: string;
      readonly contentDigest: string;
      readonly context?: ClaudeModsChatContext;
    }
  | {
      readonly action: 'disallow';
      readonly pluginId: string;
      readonly context?: ClaudeModsChatContext;
    }
  | { readonly action: 'set-mods-disabled'; readonly modsDisabled: boolean };

export type ClaudeModsUpdateErrorCode =
  | 'flag-off'
  | 'invalid-input'
  | 'plugin-not-found'
  | 'plugin-ambiguous'
  | 'not-a-mod'
  | 'plugin-unreadable'
  | 'digest-changed'
  | 'authority-unreadable'
  | 'save-failed'
  | 'save-outcome-unknown';

export type ClaudeModsUpdateResult =
  | { readonly ok: true; readonly state: ClaudeModsState }
  | { readonly ok: false; readonly code: ClaudeModsUpdateErrorCode };

// A catalog marketplace id may contain `/` (`builtin/app`, `curated/cloud`).
const PLUGIN_ID_PATTERN = /^[^@\s/\\]{1,200}@[^@\s\\]{1,200}$/;
const CONTENT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CONTEXT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const DETAILS_PART_PATTERN = /^[^\s\\]{1,200}$/;
const PLUGIN_STATUSES = [
  'allowed',
  'changed',
  'not-allowed',
  'unavailable',
] as const satisfies readonly ClaudeModPluginStatus[];
const UPDATE_ERROR_CODES = [
  'flag-off',
  'invalid-input',
  'plugin-not-found',
  'plugin-ambiguous',
  'not-a-mod',
  'plugin-unreadable',
  'digest-changed',
  'authority-unreadable',
  'save-failed',
  'save-outcome-unknown',
] as const satisfies readonly ClaudeModsUpdateErrorCode[];

function isPluginStatus(value: unknown): value is ClaudeModPluginStatus {
  return PLUGIN_STATUSES.some((status) => status === value);
}

function isUpdateErrorCode(value: unknown): value is ClaudeModsUpdateErrorCode {
  return UPDATE_ERROR_CODES.some((code) => code === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isClaudeModsPluginId(value: unknown): value is string {
  return typeof value === 'string' && PLUGIN_ID_PATTERN.test(value);
}

export function isClaudeModsContentDigest(value: unknown): value is string {
  return typeof value === 'string' && CONTENT_DIGEST_PATTERN.test(value);
}

/** The Claude plugin id a catalog plugin loads under. */
export function claudeModPluginId(
  pluginName: string,
  marketplaceId: string,
): string {
  return `${pluginName}@${marketplaceId}`;
}

function isContextId(value: unknown): value is string {
  return typeof value === 'string' && CONTEXT_ID_PATTERN.test(value);
}

/** The chat context, `undefined` when absent, or null when malformed. */
function parseChatContext(
  value: unknown,
): ClaudeModsChatContext | undefined | null {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !isContextId(value.projectId) ||
    !isContextId(value.worktreeId) ||
    !isContextId(value.chatId)
  ) {
    return null;
  }
  if (value.repoId !== undefined && !isContextId(value.repoId)) return null;
  return {
    projectId: value.projectId,
    worktreeId: value.worktreeId,
    chatId: value.chatId,
    ...(value.repoId !== undefined ? { repoId: value.repoId } : {}),
  };
}

function parseDetailsTarget(
  value: unknown,
): ClaudeModPluginDetailsTarget | undefined {
  if (
    !isRecord(value) ||
    typeof value.marketplaceId !== 'string' ||
    typeof value.pluginName !== 'string' ||
    !DETAILS_PART_PATTERN.test(value.marketplaceId) ||
    !DETAILS_PART_PATTERN.test(value.pluginName)
  ) {
    return undefined;
  }
  return { marketplaceId: value.marketplaceId, pluginName: value.pluginName };
}

function parsePluginState(value: unknown): ClaudeModPluginState | null {
  if (!isRecord(value) || !isClaudeModsPluginId(value.pluginId)) return null;
  if (!isPluginStatus(value.status)) return null;
  const details = parseDetailsTarget(value.details);
  return {
    pluginId: value.pluginId,
    status: value.status,
    ...(isClaudeModsContentDigest(value.contentDigest)
      ? { contentDigest: value.contentDigest }
      : {}),
    ...(details ? { details } : {}),
  };
}

/** Parses a state received over a transport, or null when it is malformed. */
export function parseClaudeModsState(value: unknown): ClaudeModsState | null {
  if (
    !isRecord(value) ||
    typeof value.enabled !== 'boolean' ||
    typeof value.modsDisabled !== 'boolean' ||
    typeof value.authorityUnreadable !== 'boolean'
  ) {
    return null;
  }
  const plugin =
    value.plugin === undefined ? undefined : parsePluginState(value.plugin);
  if (plugin === null) return null;
  return {
    enabled: value.enabled,
    modsDisabled: value.modsDisabled,
    authorityUnreadable: value.authorityUnreadable,
    ...(plugin ? { plugin } : {}),
  };
}

/** Parses get arguments, or null when they are malformed. */
export function parseClaudeModsGetArgs(
  value: unknown,
): ClaudeModsGetArgs | null {
  if (!isRecord(value)) return null;
  const context = parseChatContext(value.context);
  if (context === null) return null;
  if (value.pluginId === undefined) return context ? { context } : {};
  return isClaudeModsPluginId(value.pluginId)
    ? { pluginId: value.pluginId, ...(context ? { context } : {}) }
    : null;
}

/** Parses an update request, or null when it is malformed. */
export function parseClaudeModsUpdate(value: unknown): ClaudeModsUpdate | null {
  if (!isRecord(value)) return null;
  const context = parseChatContext(value.context);
  if (context === null) return null;
  if (
    value.action === 'allow' &&
    isClaudeModsPluginId(value.pluginId) &&
    isClaudeModsContentDigest(value.contentDigest)
  ) {
    return {
      action: 'allow',
      pluginId: value.pluginId,
      contentDigest: value.contentDigest,
      ...(context ? { context } : {}),
    };
  }
  if (value.action === 'disallow' && isClaudeModsPluginId(value.pluginId)) {
    return {
      action: 'disallow',
      pluginId: value.pluginId,
      ...(context ? { context } : {}),
    };
  }
  if (
    value.action === 'set-mods-disabled' &&
    typeof value.modsDisabled === 'boolean'
  ) {
    return { action: 'set-mods-disabled', modsDisabled: value.modsDisabled };
  }
  return null;
}

/** Parses an update result received over a transport, or null when malformed. */
export function parseClaudeModsUpdateResult(
  value: unknown,
): ClaudeModsUpdateResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === true) {
    const state = parseClaudeModsState(value.state);
    return state ? { ok: true, state } : null;
  }
  if (value.ok === false && isUpdateErrorCode(value.code)) {
    return { ok: false, code: value.code };
  }
  return null;
}

/**
 * The shared client operations. A host that does not serve them leaves
 * `CanopyCapabilities.claudeModAdmission` unset and rejects both; shared UI
 * then shows no Mod controls.
 */
export interface ClaudeModsQueryMap {
  'claudeMods.get': {
    args: ClaudeModsGetArgs;
    result: ClaudeModsState;
  };
}

export interface ClaudeModsCommandMap {
  'claudeMods.update': {
    args: ClaudeModsUpdate;
    result: ClaudeModsUpdateResult;
  };
  /**
   * What the person did on a chat's Mod surface. A host without
   * `CanopyCapabilities.claudeModSurface` rejects it; one whose session is
   * not drawing the surface ignores it.
   */
  'claudeMods.surfaceCommand': {
    args: ClaudeModSurfaceCommandArgs;
    result: void;
  };
}
