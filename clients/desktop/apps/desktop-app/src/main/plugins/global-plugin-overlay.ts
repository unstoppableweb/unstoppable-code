import type {
  ChatTabPluginSelections,
  PluginSelectionTombstones,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import { hasAnySelections } from '@canopy/desktop-shared/types';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import {
  chatSurfaceUsesGlobalPluginDefaults,
  effectiveChatPluginSelections,
  normalizePluginSelectionTombstones,
  splitChosenChatPluginSelections,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import {
  DEFAULT_PREFERENCES,
  readPreferencesFile,
} from '../lib/preferences-store';
import { readProjectPluginDefaults } from '../lib/workspace-persistence';
import {
  normalizeAccountMcpSelections,
  normalizeAccountMcpTombstones,
} from '../mcp/account-catalog';
import { readPersistedChatPluginInheritance } from '../lib/chat-tabs-reader';
import { pluginDefaultsWorkspaceId } from './plugin-defaults-revision';
import type { ProjectPluginDefaults } from './project-plugin-defaults-cache';
import type { ConnectorScope } from '@canopy/desktop-shared/lib/connector-scope';
import {
  resolveCachedConnectorScope,
  resolveConnectorScope,
} from './connector-scope';
import { withOnlyAllowedOrganizationRefs } from '@canopy/desktop-shared/lib/organization-capabilities';
import { organizationLayerForWorkspace } from '../organization-capabilities/service';

export interface ChatPluginOverlayTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * Overlay opt-in for {@link resolveEffectiveChatPluginSelections}. `true`
 * reads the chat's persisted tombstones and layering stamp from its tab file;
 * an object supplies either of them instead (a not-yet-persisted update), and
 * whatever it leaves out is still read. `{ draft: true }` resolves a draft for
 * a chat that doesn't exist yet, seeded from its project's defaults (the Home
 * composer): it inherits like a new chat, and every default missing from the
 * draft is turned off, as it is for the chat created from that draft.
 * `false` / `undefined` skips the inherited layers entirely (helper surfaces,
 * pipeline steps, and every surface excluded by
 * `chatSurfaceUsesGlobalPluginDefaults`).
 */
export type ChatPluginOverlayOptions =
  | boolean
  | {
      /** Overrides the persisted chat tombstones (in-flight update). */
      chatTombstones?: PluginSelectionTombstones;
      /** Overrides the persisted stamp; see `chatInheritsProjectDefaults`. */
      inheritsProjectDefaults?: boolean;
      /**
       * Read and expose the chat's tombstones even when no default layer
       * applies. A harness that layers its own inherited plugins on top of
       * the selection (Cursor's Claude Code plugins) needs what the chat
       * turned off regardless of the defaults; every other caller keeps the
       * cheaper path that skips the read.
       */
      includeChatTombstones?: boolean;
      draft?: never;
    }
  | { draft: true }
  | undefined;

export interface EffectiveChatPluginContext {
  selections: ChatTabPluginSelections;
  /**
   * Preferences already read while computing the overlay. Callers pass this
   * into `resolvePlugins` so chat-facing resolution does not immediately
   * reread the same file.
   */
  preferences?: PreferencesData;
  /**
   * The chat's normalized tombstones, when the overlay was applied. A harness
   * that layers its own inherited plugins (Cursor's Claude Code plugins)
   * honors them without rereading the tab file.
   */
  chatTombstones?: PluginSelectionTombstones;
  /**
   * The chat's connector scope (CAN-6231), read when the global layer holds
   * connectors, the only layer the organization rules act on.
   */
  connectorScope?: ConnectorScope;
}

/**
 * Computes a chat's effective plugin selections under the inherited
 * default-plugin layers:
 * `local ∪ ((project defaults ∪ (global − project tombstones)) − chat
 * tombstones)`. The project layer is the `defaultPluginSelections` of the
 * chat's workspace (legacy cowork ids mapped), served from memory and
 * invalidated by every write of that workspace's config, so a defaults
 * change reaches existing chats on their next turn without rereading
 * `workspace.json` on every one. A chat written before that layer existed
 * inherits no project layer until it is normalized
 * (`chatInheritsProjectDefaults`). This is the single place the overlay's IO
 * happens — callers gate on `hasAnySelections(result)` and pass the result
 * straight into `resolvePlugins`, so preferences and the chat's tab metadata
 * are each read at most once per resolution.
 *
 * Reads are best-effort: a missing or corrupt file simply contributes no
 * layer or suppression at that level. When the overlay is not requested no
 * extra IO happens at all.
 */
export async function resolveEffectiveChatPluginContext(
  localSelections: ChatTabPluginSelections | undefined,
  target: ChatPluginOverlayTarget,
  overlay: ChatPluginOverlayOptions,
): Promise<EffectiveChatPluginContext> {
  const local = await normalizeAccountMcpSelections(
    normalizePluginSelections(localSelections),
  );
  if (!overlay) return { selections: local };
  // Preferences are best-effort for the overlay, matching the workspace and
  // chat tombstone reads below. A transient/corrupt preference read must not
  // prevent an otherwise-local chat from starting.
  const preferences = await readPreferencesFile().catch(
    () => DEFAULT_PREFERENCES,
  );
  const global = await normalizeAccountMcpSelections(
    normalizePluginSelections(preferences.globalPluginSelections),
  );
  const projectLayer = await readProjectPluginDefaults(
    pluginDefaultsWorkspaceId(target),
  ).catch(() => undefined);
  const projectDefaults = await normalizeAccountMcpSelections(
    normalizePluginSelections(projectLayer?.defaultPluginSelections),
  );
  // The organization's shared set for this workspace (CAN-6237), and the
  // organization refs a chat here may use (CAN-6240); none outside one.
  // One read of the workspace's owner serves both organization rules.
  const workspaceScope = chatSurfaceUsesGlobalPluginDefaults(target.projectId)
    ? await resolveCachedConnectorScope(target)
    : undefined;
  const organization = await organizationLayerForWorkspace(
    pluginDefaultsWorkspaceId(target),
    workspaceScope,
  ).catch(() => undefined);
  if (
    !hasAnySelections(global) &&
    !hasAnySelections(projectDefaults) &&
    organization === undefined
  ) {
    const allowedLocal = withOnlyAllowedOrganizationRefs(
      local,
      undefined,
    ).selections;
    // No layer to subtract from, so the tombstones are not needed here, except
    // by a harness that subtracts them from its own inherited plugins.
    const wantsTombstones =
      typeof overlay === 'object' &&
      overlay.draft !== true &&
      overlay.includeChatTombstones === true;
    if (!wantsTombstones) return { selections: allowedLocal, preferences };
    let supplied = overlay.chatTombstones;
    if (supplied === undefined) {
      try {
        supplied = (
          await readPersistedChatPluginInheritance(
            target.projectId,
            target.worktreeId,
            target.chatId,
          )
        ).tombstones;
      } catch {
        // Unreadable chat state suppresses nothing, as a chat without any.
      }
    }
    const tombstones = await normalizeAccountMcpTombstones(
      normalizePluginSelectionTombstones(supplied),
    );
    return {
      selections: allowedLocal,
      preferences,
      ...(tombstones ? { chatTombstones: tombstones } : {}),
    };
  }
  const supplied =
    typeof overlay !== 'object'
      ? {}
      : overlay.draft
        ? {
            chatTombstones: splitChosenChatPluginSelections({
              chosen: local,
              projectDefaults,
            }).tombstones,
            inheritsProjectDefaults: true,
          }
        : overlay;
  let chatTombstones = supplied.chatTombstones;
  let inheritsProjectDefaults = supplied.inheritsProjectDefaults;
  if (
    chatTombstones === undefined ||
    (inheritsProjectDefaults === undefined &&
      (hasAnySelections(projectDefaults) || organization !== undefined))
  ) {
    try {
      const persisted = await readPersistedChatPluginInheritance(
        target.projectId,
        target.worktreeId,
        target.chatId,
      );
      chatTombstones ??= persisted.tombstones;
      inheritsProjectDefaults ??= persisted.inheritsProjectDefaults;
    } catch {
      // Unreadable chat state suppresses nothing, as a chat without any.
    }
  }
  const normalizedChatTombstones = await normalizeAccountMcpTombstones(
    normalizePluginSelectionTombstones(chatTombstones),
  );
  const connectorScope =
    (global.mcpServerRefs?.length ?? 0) > 0
      ? (workspaceScope ?? (await resolveConnectorScope(target)))
      : undefined;
  return {
    selections: effectiveChatPluginSelections({
      local,
      projectDefaults:
        inheritsProjectDefaults === false ? undefined : projectDefaults,
      global,
      projectTombstones: await normalizeAccountMcpTombstones(
        projectLayer?.disabledGlobalPluginSelections,
      ),
      chatTombstones: normalizedChatTombstones,
      ...(connectorScope ? { connectorScope } : {}),
      // Inherited like the project defaults; a chat that opted out of them
      // gets an organization item only by its own pick.
      ...(organization && inheritsProjectDefaults !== false
        ? { organization: organization.layer }
        : {}),
      ...(organization
        ? { allowedOrganizationItems: organization.allowed }
        : {}),
    }),
    preferences,
    ...(normalizedChatTombstones
      ? { chatTombstones: normalizedChatTombstones }
      : {}),
    ...(connectorScope ? { connectorScope } : {}),
  };
}

/**
 * What an unattended send into an existing chat must authorize: `local` plus
 * the project defaults the chat inherits live, less the ones it turned off,
 * resolved like its session resolves them. The global layer is left out, as
 * on every other automation path. When the chat's own state can't be read,
 * nothing is taken as turned off, so every project default is authorized.
 */
export async function resolveBackgroundChatPluginSelections(
  local: ChatTabPluginSelections | undefined,
  target: ChatPluginOverlayTarget,
): Promise<ChatTabPluginSelections | undefined> {
  if (!chatSurfaceUsesGlobalPluginDefaults(target.projectId)) return local;
  let projectLayer: ProjectPluginDefaults | undefined;
  try {
    projectLayer = await readProjectPluginDefaults(
      pluginDefaultsWorkspaceId(target),
    );
  } catch {
    projectLayer = undefined;
  }
  const projectDefaults = normalizePluginSelections(
    projectLayer?.defaultPluginSelections,
  );
  // The organization's shared set and what organization refs a run here may
  // use (CAN-6237, CAN-6240), as a chat's turn resolves them.
  const organization = await organizationLayerForWorkspace(
    pluginDefaultsWorkspaceId(target),
    await resolveCachedConnectorScope(target),
  ).catch(() => undefined);
  if (!hasAnySelections(projectDefaults) && organization === undefined)
    return local
      ? withOnlyAllowedOrganizationRefs(local, undefined).selections
      : local;
  const inheritance = await readPersistedChatPluginInheritance(
    target.projectId,
    target.worktreeId,
    target.chatId,
  ).catch(() => undefined);
  const inherits = inheritance?.inheritsProjectDefaults !== false;
  return effectiveChatPluginSelections({
    local,
    projectDefaults: inherits ? projectDefaults : undefined,
    chatTombstones: normalizePluginSelectionTombstones(inheritance?.tombstones),
    ...(organization && inherits ? { organization: organization.layer } : {}),
    ...(organization ? { allowedOrganizationItems: organization.allowed } : {}),
  });
}

/**
 * Selection-only convenience wrapper for callers that do not continue into
 * `resolvePlugins` (primarily focused overlay tests).
 */
export async function resolveEffectiveChatPluginSelections(
  localSelections: ChatTabPluginSelections | undefined,
  target: ChatPluginOverlayTarget,
  overlay: ChatPluginOverlayOptions,
): Promise<ChatTabPluginSelections> {
  return (
    await resolveEffectiveChatPluginContext(localSelections, target, overlay)
  ).selections;
}
