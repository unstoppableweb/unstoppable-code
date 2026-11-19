import { gitRemoteEndpoint } from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

/**
 * Remote URLs leaving this computer for a remote-control controller
 * (CAN-7030). Every tunnelled result and push passes through the host
 * session, and the channels below carry a Git remote URL that can hold an
 * access token in its userinfo or name a path on this host. The controller
 * gets the network URL without userinfo, and nothing for a local remote.
 * Local windows never pass through here, so they keep the URL as Git printed
 * it. `check:remote-control-remote-urls` fails when a tunnelled channel adds
 * a URL-named field that is neither projected here nor exempted.
 */

type Projection = (value: unknown) => unknown;

interface ChannelProjection {
  /** The fields this channel projects, as the completeness check reads them. */
  readonly fields: readonly string[];
  readonly result?: Projection;
  /** Applied to the push's first argument; the rest pass unchanged. */
  readonly push?: Projection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A remote URL a controller may see: the network URL `worker.git.remote.get`
 * would answer, without userinfo, or `undefined` for a local remote (a path,
 * a `file:` URL, a remote helper) and for anything that isn't a string.
 */
export function controllerRemoteUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const endpoint = gitRemoteEndpoint(value.trim());
  return endpoint.kind === 'network' ? endpoint.url : undefined;
}

/** `record` with its optional `field` redacted, or dropped when not network. */
function withOptionalRemoteUrl(record: unknown, field: string): unknown {
  if (!isRecord(record) || !(field in record)) return record;
  const { [field]: raw, ...rest } = record;
  const url = controllerRemoteUrl(raw);
  return url === undefined ? rest : { ...rest, [field]: url };
}

function mapArray(value: unknown, project: Projection): unknown {
  return Array.isArray(value) ? value.map(project) : value;
}

function withField(
  record: unknown,
  field: string,
  project: Projection,
): unknown {
  if (!isRecord(record) || !(field in record)) return record;
  return { ...record, [field]: project(record[field]) };
}

const optionalRemoteUrl =
  (field: string): Projection =>
  (record) =>
    withOptionalRemoteUrl(record, field);

const repoRemoteUrls: Projection = (repos) =>
  mapArray(repos, optionalRemoteUrl('remoteUrl'));

/**
 * A clone job's source. A controller gets no source at all, not a redacted
 * one: an empty URL fails closed, since a clone or a retry refuses it before
 * any effect, and it can carry neither a token nor a host path.
 */
const cloneJobForController: Projection = (job) =>
  isRecord(job) && 'remoteUrl' in job ? { ...job, remoteUrl: '' } : job;

const cloneJobsForController: Projection = (jobs) =>
  mapArray(jobs, cloneJobForController);

const referenceRepoStatus: Projection = (status) =>
  withOptionalRemoteUrl(status, 'remoteUrl');

export const CONTROLLER_REMOTE_URL_PROJECTIONS: Readonly<
  Record<string, ChannelProjection>
> = Object.freeze({
  // Its handler already redacts for every caller but the local window; this
  // keeps the tunnel's answer redacted whichever caller main derived.
  [IPC_CHANNELS.repoGetRemoteUrl]: {
    fields: ['remoteUrl'],
    result: (value: unknown): unknown =>
      isRecord(value) && 'remoteUrl' in value
        ? { ...value, remoteUrl: controllerRemoteUrl(value.remoteUrl) ?? null }
        : value,
  },
  [IPC_CHANNELS.workspaceReferenceRepoStatusEvent]: {
    fields: ['remoteUrl'],
    push: (event: unknown): unknown =>
      withField(event, 'status', referenceRepoStatus),
  },
  [IPC_CHANNELS.workspaceReadSettingsData]: {
    fields: ['remoteUrl'],
    result: (data: unknown): unknown =>
      withField(data, 'referenceRepoStatus', referenceRepoStatus),
  },
  [IPC_CHANNELS.cloneJobsList]: {
    fields: ['remoteUrl'],
    result: cloneJobsForController,
  },
  [IPC_CHANNELS.cloneJobsChanged]: {
    fields: ['remoteUrl'],
    push: cloneJobsForController,
  },
  [IPC_CHANNELS.chatSessionCloudExportList]: {
    fields: ['remoteUrl'],
    result: (list: unknown): unknown =>
      withField(list, 'data', (data) =>
        mapArray(data, (summary) =>
          withField(summary, 'repos', repoRemoteUrls),
        ),
      ),
  },
  [IPC_CHANNELS.chatSessionImportInspect]: {
    fields: ['remoteUrl'],
    result: (inspection: unknown): unknown => {
      const manifest = withField(inspection, 'manifestSummary', (summary) =>
        withField(summary, 'repos', repoRemoteUrls),
      );
      const workspace = withField(manifest, 'workspaceSummary', (summary) =>
        withField(summary, 'repos', repoRemoteUrls),
      );
      return withField(workspace, 'missingRepos', repoRemoteUrls);
    },
  },
});

/** A tunnelled invoke's result as the controller may see it. */
export function projectControllerResult(
  channel: string,
  value: unknown,
): unknown {
  const project = CONTROLLER_REMOTE_URL_PROJECTIONS[channel]?.result;
  return project ? project(value) : value;
}

/** A push's arguments as the controller may see them; never the originals. */
export function projectControllerPush(
  channel: string,
  args: readonly unknown[],
): unknown[] {
  const project = CONTROLLER_REMOTE_URL_PROJECTIONS[channel]?.push;
  if (!project || args.length === 0) return [...args];
  const [first, ...rest] = args;
  return [project(first), ...rest];
}
