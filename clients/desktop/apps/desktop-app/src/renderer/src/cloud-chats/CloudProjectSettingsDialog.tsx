import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';
import {
  CoreCoworkRequestError,
  readCloudProjectPluginCatalog,
  readCloudProjectSandboxRoutes,
  readCloudProjectSettings,
  saveCloudProjectDefaultPlugins,
  saveCloudProjectInstructions,
  type CloudProjectSandboxRoutes,
  type CloudProjectSettings,
  type CoreCoworkInvoker,
  type CoreCoworkProjectPatch,
  type CoreCoworkProjectSaved,
} from '@canopy/app-state/core-cowork';
import {
  parseEgressAllowedHosts,
  parseHostPortsInput,
} from '@canopy/protocol/canopy-core/core';
import type {
  PortalChatTabPluginSelections,
  PortalPluginCatalog,
} from '@canopy/protocol/portal';
import {
  DialogModal,
  ErrorBanner,
  WorkspaceSettingsDialog,
  WorkspaceSettingsFailure,
  type WorkspaceSettingsDangerCopy,
  type WorkspaceSettingsValues,
} from '@canopy/ui-shared';
import { ACTIVE_PLUGINS_SELECTION_COPY } from '@canopy/ui-shared/lib';
import {
  CloudProjectHostTab,
  CloudProjectNetworkTab,
  CloudProjectPluginsTab,
  countPortalPluginSelections,
  PortalPluginsPicker,
  type CloudProjectHostRoutes,
} from '@canopy/ui-app';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { webCoreLocalId } from '@/lib/chat-authority';
import { createRelayCoreCoworkInvoker } from './relay-invoker';
import { CLOUD_PROJECT_DANGER_COPY } from './cloud-sidebar-capabilities';
import type { CloudCoworkSidebarModel } from './useCloudCoworkSidebar';

const EMPTY_SELECTIONS: PortalChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
};

const LOAD_FAILED = "Couldn't load project settings.";
const SAVE_FAILED = "Couldn't save the project. Try again.";
const OFFLINE = "Couldn't save the project: the cloud is unavailable.";
const OFFLINE_DETAILS = 'Your changes are kept. Save again once it reconnects.';
const CHANGED_ELSEWHERE =
  "These settings changed somewhere else, so this Save wasn't sent.";
const CHANGED_ELSEWHERE_DETAILS =
  'The Network and Host tabs now show what is stored. Check them and save again.';
const RELOAD_FAILED =
  "These settings changed somewhere else and couldn't be reloaded, so this Save wasn't sent.";
const RELOAD_FAILED_DETAILS =
  'Save again to retry the reload. Nothing is sent until the Network and Host tabs show what is stored.';
const SYNC_DETAILS =
  "Your changes were saved. Save again to retry what the cloud couldn't apply.";

/**
 * What a dialog's Save stores: none, or the defaults with no picks, is null.
 * Capabilities still waiting to install or sign in are picks too.
 */
function storedSelections(
  selections: PortalChatTabPluginSelections,
): PortalChatTabPluginSelections | null {
  return countPortalPluginSelections(selections) > 0 ||
    (selections.unresolvedCapabilities?.length ?? 0) > 0
    ? selections
    : null;
}

const sameSelections = (
  left: PortalChatTabPluginSelections | null,
  right: PortalChatTabPluginSelections | null,
): boolean => JSON.stringify(left) === JSON.stringify(right);

const samePorts = (
  left: readonly number[],
  right: readonly number[],
): boolean =>
  left.length === right.length &&
  left.every((port, index) => port === right[index]);

/** The egress field's lines and commas as the hosts a save sends. */
const typedHosts = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((host) => host.trim())
    .filter(Boolean);

/** Whether the web core refused a save because the project moved on. */
const isRevisionConflict = (error: unknown): boolean =>
  error instanceof CoreCoworkRequestError && error.payload.kind === 'conflict';

/** The Host tab's routes state, from the last read. */
function hostRoutesOf(
  read: CloudProjectSandboxRoutes | null,
  failed: boolean,
): CloudProjectHostRoutes {
  if (failed || (read !== null && read.warnings.length > 0))
    return { state: 'unavailable' };
  if (read === null) return { state: 'checking' };
  return {
    state: 'ready',
    routes: read.routes,
    expiresAtMs: read.expiresAtMs,
  };
}

/** The text of a web core refusal, for the dialog's details line. */
function detailsOf(error: unknown): string | undefined {
  if (error instanceof CoreCoworkRequestError) return error.payload.message;
  return error instanceof Error ? error.message : undefined;
}

export interface CloudProjectSettingsDialogProps {
  /** The project's sidebar id (`web-core:` scoped). */
  readonly projectId: string;
  readonly name: string;
  readonly color: string | undefined;
  readonly initialTab?: string;
  readonly dangerCopy: WorkspaceSettingsDangerCopy;
  /**
   * Saves the project's name, colour and sandbox settings in one update,
   * guarded by the revision this dialog read; answers its warnings and the
   * revision it left.
   */
  readonly onUpdateProject: (
    patch: CoreCoworkProjectPatch,
    options: { readonly expectedRevision?: number },
  ) => Promise<CoreCoworkProjectSaved>;
  /** Moves the project to the trash; absent when it can't be removed. */
  readonly onDelete?: () => Promise<void>;
  readonly onClose: () => void;
  /**
   * False while the cloud connection is down: the dialog stays open with its
   * draft, and Save says why it can't send rather than discarding it.
   */
  readonly available?: boolean;
  /** The web core invoker; the renderer relay unless a test gives one. */
  readonly invoker?: CoreCoworkInvoker;
}

/**
 * A cloud project's settings on desktop (CAN-7053), as the web's
 * CloudWorkspaceSettingsDialog offers them over the web core: General (name
 * and colour), Instructions, Network (the hosts its sandbox may reach),
 * Plugins (the defaults its chats start with), Host (forwarded ports and
 * their live URLs) and Danger. It is the shared settings dialog with the
 * shared tabs and plugins picker. Description, default model and retention
 * come with a later change.
 *
 * Save runs the web's order: default plugins, then the project fields (name,
 * colour, egress hosts, host mode and ports) in one update guarded by the
 * listed revision, then instructions. A save refused because the project
 * changed elsewhere reloads the stored Network and Host settings before a
 * retry, so it never overwrites that change. Each step is sent only when its fields changed, and a
 * refusal stops the steps after it. What landed becomes the new baseline,
 * so retrying never resends it. A step the web core answered with warnings
 * isn't settled: the next Save sends it again, changed or not, until it
 * lands without them.
 */
export function CloudProjectSettingsDialog({
  projectId,
  name,
  color,
  initialTab,
  dangerCopy,
  onUpdateProject,
  onDelete,
  onClose,
  available = true,
  invoker: givenInvoker,
}: CloudProjectSettingsDialogProps): JSX.Element {
  const workspaceId = webCoreLocalId(projectId) ?? projectId;
  const invoker = useMemo((): CoreCoworkInvoker | null => {
    if (givenInvoker !== undefined) return givenInvoker;
    if (typeof window === 'undefined' || !window.canopyCore) return null;
    return createRelayCoreCoworkInvoker(window.canopyCore);
  }, [givenInvoker]);
  const [settings, setSettings] = useState<CloudProjectSettings | null>(null);
  const [catalog, setCatalog] = useState<PortalPluginCatalog | null>(null);
  const [pluginSelections, setPluginSelections] =
    useState<PortalChatTabPluginSelections>(EMPTY_SELECTIONS);
  const [loadError, setLoadError] = useState<{
    readonly message: string;
    readonly details?: string;
  } | null>(null);
  // Name and colour as the web core last stored them, for the next Save's
  // diff: a refreshed listing moves it, so a Save back to the old value is
  // still sent.
  const metadata = useRef({ name, color });
  // Steps whose last save came back with warnings, resent by the next Save.
  const unsynced = useRef({
    plugins: false,
    project: false,
    instructions: false,
  });
  const egressHostsId = useId();
  const hostPortsId = useId();
  const [egressHostsText, setEgressHostsText] = useState('');
  const [hostModeEnabled, setHostModeEnabled] = useState(false);
  // The ports field and its edit baseline come only from the stored
  // settings, never from the sandbox's routes: a sandbox that hasn't caught
  // up still declares older ports, and a Save from them would put those back.
  const [hostPortsText, setHostPortsText] = useState('');
  // Set while a save was refused as stale and the stored settings haven't
  // been reloaded since: no draft is sent until a reload succeeds.
  const needsReload = useRef(false);
  // The project revision of this dialog's own read, never the listing's: a
  // listing refreshed after an edit elsewhere would let a stale draft land.
  const projectRevision = useRef<number | undefined>(undefined);
  // The forwarded URLs live only here, for the Host tab: never stored,
  // logged or reported.
  const [sandboxRoutes, setSandboxRoutes] =
    useState<CloudProjectSandboxRoutes | null>(null);
  const [sandboxRoutesFailed, setSandboxRoutesFailed] = useState(false);
  const [sandboxRoutesReads, setSandboxRoutesReads] = useState(0);
  useEffect(() => {
    metadata.current = { name, color };
  }, [name, color]);

  useEffect(() => {
    let current = true;
    if (invoker === null) {
      setLoadError({ message: LOAD_FAILED });
      return undefined;
    }
    void readCloudProjectSettings(invoker, workspaceId).then(
      async (read): Promise<void> => {
        // The picker's options; a failed catalog leaves the defaults
        // readable, as the web's settings do.
        const options = await readCloudProjectPluginCatalog(
          invoker,
          workspaceId,
          read.defaultPluginSelections,
        ).catch((error: unknown): null => {
          reportClientAppError(error);
          return null;
        });
        if (!current) return;
        projectRevision.current = read.revision;
        setSettings(read);
        setCatalog(options);
        setPluginSelections(read.defaultPluginSelections ?? EMPTY_SELECTIONS);
        setEgressHostsText(read.egressAllowedHosts.join('\n'));
        setHostModeEnabled(read.hostModeEnabled);
        setHostPortsText(read.hostPorts.join(', '));
      },
      (error: unknown): void => {
        if (current)
          setLoadError({ message: LOAD_FAILED, details: detailsOf(error) });
      },
    );
    return (): void => {
      current = false;
    };
  }, [invoker, workspaceId]);

  const settingsLoaded = settings !== null;
  useEffect(() => {
    if (!settingsLoaded || invoker === null) return undefined;
    let current = true;
    void readCloudProjectSandboxRoutes(invoker, workspaceId).then(
      (read): void => {
        if (!current) return;
        setSandboxRoutes(read);
        setSandboxRoutesFailed(false);
      },
      // The tab says the sandbox couldn't be checked; the answer itself is
      // never reported, since it can carry the forwarded URLs.
      (): void => {
        if (current) setSandboxRoutesFailed(true);
      },
    );
    return (): void => {
      current = false;
    };
  }, [invoker, workspaceId, settingsLoaded, sandboxRoutesReads]);

  if (settings === null || invoker === null) {
    return (
      <DialogModal
        onClose={onClose}
        title="Project settings"
        maxWidth="2xl"
        dataTestId="cloud-project-settings-dialog"
      >
        {loadError ? (
          <ErrorBanner
            errorSource="cloud-project-settings-dialog-load"
            className=""
            error={loadError.message}
            details={loadError.details}
          />
        ) : (
          <div className="text-s fg-secondary" role="status">
            Loading project settings…
          </div>
        )}
      </DialogModal>
    );
  }

  const refreshPluginDefaults = async (): Promise<void> => {
    try {
      const read = await readCloudProjectSettings(invoker, workspaceId);
      setSettings((stored) =>
        stored === null
          ? stored
          : {
              ...stored,
              defaultPluginSelections: read.defaultPluginSelections,
              defaultPluginSelectionsRevision:
                read.defaultPluginSelectionsRevision,
              unavailable: read.unavailable,
            },
      );
    } catch (error) {
      // The next Save is refused again and retries this read.
      reportClientAppError(error);
    }
  };

  const hostPortsParse = parseHostPortsInput(hostPortsText);
  const hostPortsError =
    hostModeEnabled && !hostPortsParse.ok ? hostPortsParse.error : null;

  /** The project fields Save would send, as the web's buildPatch reads them. */
  const projectPatch = (
    values: WorkspaceSettingsValues,
    retrySync: boolean,
  ): CoreCoworkProjectPatch => {
    const egress = parseEgressAllowedHosts(typedHosts(egressHostsText));
    if (!egress.ok) throw new WorkspaceSettingsFailure(egress.error);
    const patch: {
      name?: string;
      color?: string;
      hostModeEnabled?: boolean;
      hostPorts?: number[];
      egressAllowedHosts?: string[];
    } = {};
    if (values.name !== metadata.current.name) patch.name = values.name;
    if (values.color !== undefined && values.color !== metadata.current.color)
      patch.color = values.color;
    // Hosts compare as stored: lower-cased and deduplicated.
    if (
      JSON.stringify(egress.hosts) !==
      JSON.stringify(settings.egressAllowedHosts)
    )
      patch.egressAllowedHosts = egress.hosts;
    if (hostModeEnabled !== settings.hostModeEnabled || retrySync)
      patch.hostModeEnabled = hostModeEnabled;
    // The ports are editable, and so saved, only while host mode is on;
    // turning it off keeps the stored list for when it's back on.
    if (hostModeEnabled) {
      if (!hostPortsParse.ok)
        throw new WorkspaceSettingsFailure(hostPortsParse.error);
      if (
        retrySync ||
        !settings.hostModeEnabled ||
        !samePorts(hostPortsParse.ports, settings.hostPorts)
      )
        patch.hostPorts = hostPortsParse.ports;
    }
    return patch;
  };

  /**
   * Shows what the web core stores, after a save it refused as stale.
   * Answers whether it did; until it does, Save sends nothing.
   */
  const reloadSandboxSettings = async (): Promise<boolean> => {
    try {
      const read = await readCloudProjectSettings(invoker, workspaceId);
      projectRevision.current = read.revision;
      setSettings((stored) =>
        stored === null
          ? stored
          : {
              ...stored,
              hostModeEnabled: read.hostModeEnabled,
              hostPorts: read.hostPorts,
              egressAllowedHosts: read.egressAllowedHosts,
            },
      );
      setEgressHostsText(read.egressAllowedHosts.join('\n'));
      setHostModeEnabled(read.hostModeEnabled);
      setHostPortsText(read.hostPorts.join(', '));
      setSandboxRoutes(null);
      setSandboxRoutesFailed(false);
      setSandboxRoutesReads((count) => count + 1);
      needsReload.current = false;
      return true;
    } catch (error) {
      needsReload.current = true;
      reportClientAppError(error);
      return false;
    }
  };

  /** The Save failure after a stale refusal, by whether the reload landed. */
  const staleFailure = (reloaded: boolean): WorkspaceSettingsFailure =>
    reloaded
      ? new WorkspaceSettingsFailure(
          CHANGED_ELSEWHERE,
          CHANGED_ELSEWHERE_DETAILS,
        )
      : new WorkspaceSettingsFailure(RELOAD_FAILED, RELOAD_FAILED_DETAILS);

  const save = async (values: WorkspaceSettingsValues): Promise<void> => {
    if (!available)
      throw new WorkspaceSettingsFailure(OFFLINE, OFFLINE_DETAILS);
    // A draft from before a stale refusal is never sent: reload first, and
    // let the user check what is stored.
    if (needsReload.current) throw staleFailure(await reloadSandboxSettings());
    const warnings: string[] = [];
    // A value the web core would refuse fails before anything is sent.
    const patch = projectPatch(values, unsynced.current.project);
    // A refused step is the dialog's failure, with the web core's words.
    const step = async <T,>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        throw new WorkspaceSettingsFailure(SAVE_FAILED, detailsOf(error));
      }
    };
    const selections = storedSelections(pluginSelections);
    if (
      unsynced.current.plugins ||
      !sameSelections(selections, settings.defaultPluginSelections)
    ) {
      try {
        const answered = await saveCloudProjectDefaultPlugins(
          invoker,
          workspaceId,
          selections,
          settings.defaultPluginSelectionsRevision,
        );
        unsynced.current.plugins = answered.length > 0;
        warnings.push(...answered);
      } catch (error) {
        // A stale revision would fail every retry: re-read the stored
        // defaults and their revision, keeping the draft, so the next Save
        // names the current one.
        await refreshPluginDefaults();
        throw new WorkspaceSettingsFailure(SAVE_FAILED, detailsOf(error));
      }
      // The new defaults' revision is unknown until the next read, so the
      // next save of them goes unchecked, as the web's does.
      setSettings((stored) =>
        stored === null
          ? stored
          : {
              ...stored,
              defaultPluginSelections: selections,
              defaultPluginSelectionsRevision: undefined,
            },
      );
    }
    if (Object.keys(patch).length > 0) {
      const sentRevision = projectRevision.current;
      let saved: CoreCoworkProjectSaved;
      try {
        saved = await onUpdateProject(
          patch,
          projectRevision.current === undefined
            ? {}
            : { expectedRevision: projectRevision.current },
        );
      } catch (error) {
        if (!isRevisionConflict(error))
          throw new WorkspaceSettingsFailure(SAVE_FAILED, detailsOf(error));
        throw staleFailure(await reloadSandboxSettings());
      }
      const answered = saved.warnings;
      unsynced.current.project = answered.length > 0;
      warnings.push(...answered);
      if (patch.name !== undefined || patch.color !== undefined)
        metadata.current = {
          name: patch.name ?? metadata.current.name,
          color: patch.color ?? metadata.current.color,
        };
      setSettings((stored) =>
        stored === null
          ? stored
          : {
              ...stored,
              ...(patch.hostModeEnabled === undefined
                ? {}
                : { hostModeEnabled: patch.hostModeEnabled }),
              ...(patch.hostPorts === undefined
                ? {}
                : { hostPorts: patch.hostPorts }),
              ...(patch.egressAllowedHosts === undefined
                ? {}
                : { egressAllowedHosts: patch.egressAllowedHosts }),
            },
      );
      if (
        patch.hostModeEnabled !== undefined ||
        patch.hostPorts !== undefined
      ) {
        setSandboxRoutes(null);
        setSandboxRoutesFailed(false);
        setSandboxRoutesReads((count) => count + 1);
      }
      // Every project save moves the revision by one. The web core answers
      // it from a read after the write, so any other value means another
      // save landed in between, over settings this dialog hasn't seen: take
      // the stored settings and their revision together instead, so a
      // resend never pairs this dialog's values with a newer revision.
      if (sentRevision !== undefined && saved.revision === sentRevision + 1)
        projectRevision.current = saved.revision;
      else await reloadSandboxSettings();
    }
    if (
      unsynced.current.instructions ||
      values.content !== settings.instructions
    ) {
      const answered = await step(() =>
        saveCloudProjectInstructions(invoker, workspaceId, values.content),
      );
      unsynced.current.instructions = answered.length > 0;
      warnings.push(...answered);
      setSettings((stored) =>
        stored === null ? stored : { ...stored, instructions: values.content },
      );
    }
    // The save landed; a warning still says what the web core couldn't do,
    // and the next Save retries it.
    if (warnings.length > 0)
      throw new WorkspaceSettingsFailure(
        [...new Set(warnings)].join(' '),
        SYNC_DETAILS,
      );
  };

  return (
    <WorkspaceSettingsDialog
      workspaceName={
        // The project's name is user-authored: replay masks it.
        <span className={POSTHOG_REPLAY_MASK_CLASS}>{name}</span>
      }
      initialValues={{
        name,
        ...(color === undefined ? {} : { color }),
        content: settings.instructions,
        scripts: {},
      }}
      {...(initialTab === undefined ? {} : { initialTab })}
      tabs={['details', 'claude-md', 'danger']}
      tabLabels={{ 'claude-md': 'Instructions' }}
      claudeMdCopy={{
        title: 'Instructions',
        description:
          'Extra instructions for agents in this project. Applies to new chats in this project.',
        placeholder: 'Add instructions for agents in this project',
      }}
      dangerCopy={dangerCopy}
      extraTabs={[
        {
          id: 'network',
          label: 'Network',
          content: (
            <CloudProjectNetworkTab
              fieldId={egressHostsId}
              value={egressHostsText}
              onChange={setEgressHostsText}
            />
          ),
        },
        {
          id: 'plugins',
          label: 'Plugins',
          content: (
            <CloudProjectPluginsTab>
              {/* As a desktop cloud chat's picker: the legacy catalog lists
                  account servers as rows, which cloud scope would hide. */}
              <PortalPluginsPicker
                catalog={catalog}
                selections={pluginSelections}
                brandDisplayName="your cloud account"
                onChange={setPluginSelections}
                selectionCopy={ACTIVE_PLUGINS_SELECTION_COPY}
                unavailable={settings.unavailable}
                notice="Applies to all chats in this project, starting with their next message."
              />
            </CloudProjectPluginsTab>
          ),
        },
        {
          id: 'host',
          label: 'Host',
          content: (
            <CloudProjectHostTab
              hostModeEnabled={hostModeEnabled}
              onHostModeChange={setHostModeEnabled}
              portsFieldId={hostPortsId}
              portsText={hostPortsText}
              onPortsTextChange={setHostPortsText}
              portsError={hostPortsError}
              routesVisible={settings.hostModeEnabled}
              routes={hostRoutesOf(sandboxRoutes, sandboxRoutesFailed)}
              onRefreshRoutes={() => {
                setSandboxRoutes(null);
                setSandboxRoutesFailed(false);
                setSandboxRoutesReads((count) => count + 1);
              }}
            />
          ),
        },
      ]}
      {...(onDelete === undefined ? {} : { onDelete })}
      onSave={save}
      onClose={onClose}
      testIds={{
        dialog: 'cloud-project-settings-dialog',
        nameInput: 'cloud-project-settings-name',
        claudeMdTextarea: 'cloud-project-settings-instructions',
        save: 'cloud-project-settings-save',
        error: 'cloud-project-settings-error',
      }}
    />
  );
}

/** The cloud project whose settings are open, and the tab they opened on. */
export interface CloudProjectSettingsTarget {
  readonly projectId: string;
  readonly initialTab?: string;
}

export interface CloudProjectSettingsHostProps {
  readonly target: CloudProjectSettingsTarget;
  readonly sidebar: CloudCoworkSidebarModel;
  readonly onClose: () => void;
  /** The web core invoker; the renderer relay unless a test gives one. */
  readonly invoker?: CoreCoworkInvoker;
}

const OFFLINE_REFUSAL = 'The cloud is unavailable.';

/**
 * Keeps an open cloud project's settings mounted for as long as they're open.
 * A dropped cloud connection, or a listing that briefly lacks the project,
 * keeps the dialog and its unsaved draft, showing the project as last
 * listed; Save says the cloud is unavailable until it's back.
 */
export function CloudProjectSettingsHost({
  target,
  sidebar,
  onClose,
  invoker,
}: CloudProjectSettingsHostProps): JSX.Element | null {
  const online = sidebar.status === 'online' ? sidebar : null;
  const listed = online?.rows.workspaces.find(
    (workspace) => workspace.localId === target.projectId,
  );
  const [known, setKnown] = useState<{
    readonly name: string;
    readonly color: string | undefined;
  } | null>(
    listed === undefined ? null : { name: listed.name, color: listed.color },
  );
  // The project as last listed, updated while it renders.
  if (
    listed !== undefined &&
    (known?.name !== listed.name || known.color !== listed.color)
  )
    setKnown({ name: listed.name, color: listed.color });
  const project =
    listed === undefined ? known : { name: listed.name, color: listed.color };
  if (project === null) return null;
  return (
    <CloudProjectSettingsDialog
      projectId={target.projectId}
      name={project.name}
      color={project.color}
      {...(target.initialTab === undefined
        ? {}
        : { initialTab: target.initialTab })}
      dangerCopy={CLOUD_PROJECT_DANGER_COPY}
      available={online !== null}
      onUpdateProject={(patch, options) =>
        online === null
          ? Promise.reject(new Error(OFFLINE_REFUSAL))
          : online.updateProject(target.projectId, patch, options)
      }
      onDelete={async (): Promise<void> => {
        if (online === null) throw new Error(OFFLINE_REFUSAL);
        await online.deleteProject(target.projectId);
        onClose();
      }}
      onClose={onClose}
      {...(invoker === undefined ? {} : { invoker })}
    />
  );
}
