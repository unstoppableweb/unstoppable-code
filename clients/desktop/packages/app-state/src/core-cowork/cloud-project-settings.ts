import {
  CORE_WORKSPACE_GET_SCHEMA_REVISION,
  CORE_WORKSPACE_INSTRUCTIONS_UPDATE_SCHEMA_REVISION,
  CORE_WORKSPACE_SANDBOX_QUERY_DEFINITIONS,
  CoreWorkspacePluginSelectionsSchema,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';
import {
  isCapabilityUnavailable,
  type CapabilityUnavailable,
} from '@canopy/protocol/capability-bundle';
import type { RemoteControlChatTabPluginSelections } from '@canopy/protocol/remote-control/shell';
import {
  CoreCoworkRequestError,
  type CanopyCoreRelayLikeReply,
  type CoreCoworkInvoker,
} from './invoker';

/**
 * A cloud project's settings as its settings dialog edits them on desktop
 * (CAN-7053): its instructions, default plugins, egress hosts and host
 * settings, read from the web core's `core.workspace.get` revision 2
 * `cloudSettings`, as the web reads them.
 */
export interface CloudProjectSettings {
  /** Whether the project's sandbox forwards its declared ports. */
  readonly hostModeEnabled: boolean;
  /** The ports the project declares, as stored. */
  readonly hostPorts: readonly number[];
  /** The hostnames the project's sandbox may reach, as stored. */
  readonly egressAllowedHosts: readonly string[];
  /** The project's instructions; empty when it has none. */
  readonly instructions: string;
  /** The project's default plugins, or null when it has none. */
  readonly defaultPluginSelections: RemoteControlChatTabPluginSelections | null;
  /** The defaults' revision, which guards the next defaults save. */
  readonly defaultPluginSelectionsRevision: number | undefined;
  /** Default plugins the project's chats can't use, with their status. */
  readonly unavailable: readonly CapabilityUnavailable[];
  /**
   * The project's revision as this read saw it, which guards a save of its
   * name, colour, egress hosts or host settings (CAN-7053).
   */
  readonly revision: number | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function unwrap(reply: CanopyCoreRelayLikeReply): unknown {
  if (!reply.ok) throw new CoreCoworkRequestError(reply.error);
  return reply.value;
}

const listOf = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const unreadable = (message: string): CoreCoworkRequestError =>
  new CoreCoworkRequestError({
    kind: 'internal',
    message,
    retry: { kind: 'never' },
  });

/**
 * Stored defaults as the shared picker reads them, checked against the
 * schema the defaults save is held to. A record without a list reads as
 * that list empty, and the deprecated `bundleIds` fold into
 * `collectionIds`. Defaults this can't read are an error, never null: null
 * would read as no defaults, and saving that clears them.
 */
function pluginSelectionsOf(
  value: unknown,
): RemoteControlChatTabPluginSelections | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value))
    throw unreadable("This project's default plugins can't be read here.");
  const { bundleIds, ...rest } = value;
  const parsed = CoreWorkspacePluginSelectionsSchema.safeParse({
    ...rest,
    collectionIds: [...listOf(value.collectionIds), ...listOf(bundleIds)],
    skillRefs: listOf(value.skillRefs),
    pluginRefs: listOf(value.pluginRefs),
  });
  if (!parsed.success)
    throw unreadable("This project's default plugins can't be read here.");
  return parsed.data;
}

/** Reads a cloud project's instructions and default plugins. */
export async function readCloudProjectSettings(
  invoker: CoreCoworkInvoker,
  workspaceId: string,
): Promise<CloudProjectSettings> {
  const got = unwrap(
    await invoker.request('core.workspace.get', {
      workspaceId,
      revision: CORE_WORKSPACE_GET_SCHEMA_REVISION,
    }),
  );
  const settings = isRecord(got) ? got.cloudSettings : undefined;
  if (!isRecord(settings))
    throw unreadable("The web core didn't answer this project's settings.");
  const revision = settings.defaultPluginSelectionsRevision;
  return {
    hostModeEnabled: settings.hostModeEnabled === true,
    hostPorts: listOf(settings.hostPorts).filter(
      (port): port is number => typeof port === 'number',
    ),
    egressAllowedHosts: listOf(settings.egressAllowedHosts).filter(
      (host): host is string => typeof host === 'string',
    ),
    instructions:
      typeof settings.defaultAgentInstructions === 'string'
        ? settings.defaultAgentInstructions
        : '',
    defaultPluginSelections: pluginSelectionsOf(
      settings.defaultPluginSelections,
    ),
    defaultPluginSelectionsRevision:
      typeof revision === 'number' ? revision : undefined,
    unavailable: listOf(settings.defaultPluginSelectionsUnavailable).filter(
      isCapabilityUnavailable,
    ),
    revision:
      isRecord(got) && typeof got.revision === 'number'
        ? got.revision
        : undefined,
  };
}

const warningsOf = (value: unknown): string[] =>
  isRecord(value) && Array.isArray(value.warnings)
    ? value.warnings.filter(
        (warning): warning is string => typeof warning === 'string',
      )
    : [];

const isInvalidArgument = (error: CanopyErrorPayload): boolean =>
  error.kind === 'invalid_argument';

/**
 * Saves a project's instructions over `core.workspace.instructions.update`,
 * a whole overwrite, answering the save's warnings. Revision 2 answers them;
 * a web core that rejects the revision gets the revision 1 save, which
 * answers none.
 */
export async function saveCloudProjectInstructions(
  invoker: CoreCoworkInvoker,
  workspaceId: string,
  content: string,
): Promise<readonly string[]> {
  const reply = await invoker.request('core.workspace.instructions.update', {
    workspaceId,
    content,
    revision: CORE_WORKSPACE_INSTRUCTIONS_UPDATE_SCHEMA_REVISION,
  });
  if (reply.ok || !isInvalidArgument(reply.error))
    return warningsOf(unwrap(reply));
  return warningsOf(
    unwrap(
      await invoker.request('core.workspace.instructions.update', {
        workspaceId,
        content,
      }),
    ),
  );
}

/**
 * Sets a project's default plugins over `core.workspace.plugins.update`
 * (`setDefaults`), guarded by the revision the dialog read, as the web's
 * save is. Null clears them. Answers the save's warnings.
 */
export async function saveCloudProjectDefaultPlugins(
  invoker: CoreCoworkInvoker,
  workspaceId: string,
  defaultPluginSelections: RemoteControlChatTabPluginSelections | null,
  expectedRevision: number | undefined,
): Promise<readonly string[]> {
  const idempotencyKey = globalThis.crypto.randomUUID();
  return warningsOf(
    unwrap(
      await invoker.request('core.workspace.plugins.update', {
        workspaceId,
        change: {
          kind: 'setDefaults',
          defaultPluginSelections,
          ...(expectedRevision === undefined
            ? {}
            : { expectedDefaultPluginSelectionsRevision: expectedRevision }),
        },
        _meta: { idempotencyKey },
      }),
    ),
  );
}

const SANDBOX_ROUTES =
  CORE_WORKSPACE_SANDBOX_QUERY_DEFINITIONS['core.workspace.sandboxRoutes.get'];

/** A cloud project's sandbox, as its Host tab shows it. */
export interface CloudProjectSandboxRoutes {
  readonly hostModeEnabled: boolean;
  /** The ports the sandbox has declared, the Host tab's edit baseline. */
  readonly declaredPorts: readonly number[];
  readonly routes: readonly { readonly port: number; readonly url: string }[];
  /** When the current sandbox session's URLs stop working. */
  readonly expiresAtMs: number | null;
  /** Why the state may be empty: the sandbox couldn't be asked. */
  readonly warnings: readonly string[];
}

/**
 * A cloud project's live sandbox routes over
 * `core.workspace.sandboxRoutes.get`, as the web's Host tab reads them. The
 * forwarded URLs are public but unguessable, so a caller keeps them in
 * memory for the tab only: never stored, logged or reported.
 */
export async function readCloudProjectSandboxRoutes(
  invoker: CoreCoworkInvoker,
  workspaceId: string,
): Promise<CloudProjectSandboxRoutes> {
  const answer = SANDBOX_ROUTES.result.parse(
    unwrap(
      await invoker.request('core.workspace.sandboxRoutes.get', {
        workspaceId,
      }),
    ),
  );
  return {
    hostModeEnabled: answer.hostModeEnabled,
    declaredPorts: answer.declaredPorts,
    routes: answer.routes,
    expiresAtMs:
      answer.expiresAt === null ? null : Date.parse(answer.expiresAt),
    warnings: answer.warnings ?? [],
  };
}
