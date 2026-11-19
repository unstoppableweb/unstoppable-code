import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CloudProjectBindingSchema,
  CloudProjectEventCursorSchema,
  MemoryProjectIdSchema,
  PROJECT_IDENTITY_CAPABILITY,
  type CloudProjectBinding,
} from '@canopy/protocol/memory-sync';
import type {
  CloudProjectLinkOptions,
  CloudProjectLinkRequest,
  CloudProjectLinkResult,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import {
  detachedWorkCallback,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';
import {
  hasManifestRepos,
  readCanopyJson,
} from '@canopy/desktop-shared/node/lib/canopy-json';
import {
  getCanopyCloudCredentials,
  subscribeCanopyCloudAccountChanges,
} from '../lib/canopy-cloud-account-store';
import { getRemoteUrlStrict } from '../lib/git';
import { readInstallationGeneration } from '../lib/installation-generation';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { readPreferencesFile } from '../lib/preferences-store';
import { readWorkspaceIndexEntries } from '../lib/sidebar-items';
import {
  recordPersonalCatalogId,
  recordWorkspaceCloudBinding,
} from '../lib/workspace-ownership';
import { readWorkspaceConfigDetailed } from '../lib/workspace-persistence';
import { getInstallId } from '../lib/install-identity';
import {
  boundedLocalWorkspaceId,
  scrubProjectName,
} from '../services/personal-catalog-payload';
import {
  CloudProjectBindingEngine,
  type BindingAccount,
  type BindingMove,
  type BindingWorkspace,
} from './cloud-project-binding';
import {
  createCloudProjectClient,
  type CloudProjectClient,
} from './cloud-project-client';
import {
  cloudProjectFailure,
  cloudProjectTransport,
} from './cloud-project-transport';
import type { WorkspaceOwnershipRecordStatus } from '../lib/worktree-record-decisions';
import {
  describeLocalProject,
  type LocalRepositoryInput,
} from './local-project';

/*
 * Electron main's host for the cloud project binding (CAN-5190): the Cloud
 * client, the workspace reads (Git remotes and `canopy.json`), the
 * `cloudBinding` writer and the schedule. The binding runs a few seconds after
 * startup, every five minutes, and whenever the signed-in account changes.
 */

const RECONCILE_INTERVAL_MS = 5 * 60_000;
const STARTUP_DELAY_MS = 20_000;

/** Workspaces with fixed identities that never have a cloud project. */
const SYSTEM_WORKSPACE_IDS = new Set([
  'app-advisor',
  'standalone-chat',
  'plan-explore-chat',
  'code-review-chat',
  'pipeline-editor',
]);

export async function cloudProjectAccount(): Promise<BindingAccount> {
  let credentials: Awaited<ReturnType<typeof getCanopyCloudCredentials>>;
  try {
    credentials = await getCanopyCloudCredentials();
  } catch {
    return { ok: false, reason: 'signed-out' };
  }
  const accountId = credentials.account?.id;
  if (!accountId) return { ok: false, reason: 'signed-out' };
  if (!credentials.capabilities.includes(PROJECT_IDENTITY_CAPABILITY))
    return { ok: false, reason: 'not-supported' };
  return {
    ok: true,
    accountId,
    sharing: await isCloudProjectSharing(),
    credentials: { baseUrl: credentials.baseUrl, apiKey: credentials.apiKey },
  };
}

/**
 * Project identity shares what the Personal project list shares, so it
 * follows the same choice in Privacy settings, read again before each write.
 */
export async function isCloudProjectSharing(): Promise<boolean> {
  return (
    (await readPreferencesFile()).personalWorkspaceCatalogSync === 'private'
  );
}

/** Whether this account is still the signed-in one. */
export async function isCloudProjectAccountActive(
  accountId: string,
): Promise<boolean> {
  try {
    return (await getCanopyCloudCredentials()).account?.id === accountId;
  } catch {
    return false;
  }
}

function lastPathSegment(path: string | undefined): string | undefined {
  const segments = (path ?? '').split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1];
}

/** Null only when Git confirms there is no origin; a failed read throws. */
async function remoteOf(path: string | undefined): Promise<string | null> {
  if (!path) return null;
  return getRemoteUrlStrict(path);
}

const BindingMoveSchema = z.strictObject({
  projectId: MemoryProjectIdSchema,
  eventCursor: CloudProjectEventCursorSchema.optional(),
  failures: z.int().min(1).optional(),
  retryAt: z.iso.datetime().optional(),
});

/** A moved binding's stored state; a malformed one reads as no move. */
function storedMove(value: unknown): BindingMove | undefined {
  const parsed = BindingMoveSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { projectId, eventCursor, failures, retryAt } = parsed.data;
  return {
    projectId,
    ...(eventCursor === undefined ? {} : { eventCursor }),
    ...(failures === undefined ? {} : { failures }),
    ...(retryAt === undefined ? {} : { retryAt }),
  };
}

/**
 * A stored binding as the engine reads it. Only an organization binding
 * keeps a Personal one (`personal`, D20); a malformed one reads as none.
 */
function parsedBinding(
  stored: CloudProjectBinding,
): NonNullable<BindingWorkspace['binding']> {
  const { movedTo, personal, ...binding } = stored;
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;
  const eventCursor = text(binding.eventCursor);
  const detachedAt = text(binding.detachedAt);
  const name = text(binding.name);
  const move = storedMove(movedTo);
  const kept =
    binding.ownerType === 'organization'
      ? CloudProjectBindingSchema.safeParse(personal)
      : null;
  const restorable =
    kept?.success === true && kept.data.ownerType === 'user'
      ? parsedBinding(kept.data)
      : undefined;
  return {
    ...binding,
    ...(eventCursor === undefined ? {} : { eventCursor }),
    ...(detachedAt === undefined ? {} : { detachedAt }),
    ...(name === undefined ? {} : { name }),
    ...(move === undefined ? {} : { movedTo: move }),
    ...(restorable === undefined ? {} : { personal: restorable }),
  };
}

function storedBinding(
  config: WorkspaceConfigFile,
): BindingWorkspace['binding'] {
  const stored: CloudProjectBinding | undefined = config.cloudBinding;
  return stored === undefined ? undefined : parsedBinding(stored);
}

async function multiRepoInput(config: WorkspaceConfigFile): Promise<{
  root: LocalRepositoryInput | null;
  rootListsRepositories: boolean;
  repositories: LocalRepositoryInput[];
}> {
  const rootPath = config.sourceRepoPath;
  const canopyJson = rootPath ? await readCanopyJson(rootPath) : null;
  const root: LocalRepositoryInput | null = rootPath
    ? {
        remote: await remoteOf(rootPath),
        name: lastPathSegment(rootPath) ?? 'root',
        sourceKey: null,
        cloned: true,
      }
    : null;
  const localById = new Map(config.repos.map((repo) => [repo.id, repo]));
  if (hasManifestRepos(canopyJson)) {
    // `canopy.json` lists every repository of the project, cloned or not.
    return {
      root,
      rootListsRepositories: true,
      repositories: canopyJson.repos.map((repo) => ({
        remote: repo.url,
        name: repo.name,
        sourceKey: repo.id,
        cloned: localById.has(repo.id),
      })),
    };
  }
  const repositories: LocalRepositoryInput[] = [];
  for (const repo of config.repos)
    repositories.push({
      remote: await remoteOf(repo.repoPath),
      name: repo.name,
      sourceKey: null,
      cloned: true,
    });
  return { root, rootListsRepositories: false, repositories };
}

async function readWorkspace(
  workspaceId: string,
  name: string,
): Promise<BindingWorkspace | null> {
  const detail = await readWorkspaceConfigDetailed(workspaceId);
  if (detail.authority !== 'ok' || detail.ownerMalformed) return null;
  const config = detail.config;
  const base = {
    workspaceId,
    owner: config.owner,
    temporary: config.temporary === true,
    binding: storedBinding(config),
    suppressedSourceKeys: config.suppressedRepoIds ?? [],
  };
  if (config.type === 'cowork') return { ...base, local: null };
  const input =
    config.type === 'single-repo'
      ? {
          root: null,
          rootListsRepositories: false,
          repositories: [
            {
              remote: await remoteOf(config.repoPath),
              name: lastPathSegment(config.repoPath) ?? name,
              sourceKey: null,
              cloned: true,
            },
          ],
        }
      : await multiRepoInput(config);
  return {
    ...base,
    local: describeLocalProject({
      workspaceId,
      name: scrubProjectName(name),
      type: config.type,
      ...input,
    }),
  };
}

let client: CloudProjectClient | null = null;

/** The cloud project routes through the signed-in Cloud client. */
export function getCloudProjectClient(): CloudProjectClient {
  client ??= createCloudProjectClient(cloudProjectTransport);
  return client;
}

/** This device and installation, as claims name them. */
export async function cloudProjectDevice(): Promise<{
  deviceId: string;
  installationGeneration: number;
}> {
  const deviceId = await getInstallId();
  return {
    deviceId,
    installationGeneration: await readInstallationGeneration(deviceId),
  };
}

let engine: CloudProjectBindingEngine | null = null;

function getEngine(): CloudProjectBindingEngine {
  engine ??= new CloudProjectBindingEngine({
    client: getCloudProjectClient(),
    account: cloudProjectAccount,
    isActiveAccount: isCloudProjectAccountActive,
    isSharing: isCloudProjectSharing,
    device: cloudProjectDevice,
    workspaceIds: async (): Promise<string[]> =>
      (await readWorkspaceIndexEntries())
        .map((entry) => entry.id)
        .filter((id) => !SYSTEM_WORKSPACE_IDS.has(id)),
    readWorkspace: async (workspaceId): Promise<BindingWorkspace | null> => {
      const entry = (await readWorkspaceIndexEntries()).find(
        (candidate) => candidate.id === workspaceId,
      );
      return entry === undefined
        ? null
        : readWorkspace(workspaceId, entry.name);
    },
    creationKey: (workspaceId): Promise<string | undefined> =>
      recordPersonalCatalogId({
        workspaceId,
        source: 'cloud_project_binding',
        allowed: (): Promise<boolean> => Promise.resolve(true),
      }),
    writeBinding: (
      workspaceId,
      update,
    ): Promise<WorkspaceOwnershipRecordStatus> =>
      recordWorkspaceCloudBinding({
        workspaceId,
        source: 'cloud_project_binding',
        update,
      }),
    localWorkspaceId: boundedLocalWorkspaceId,
    failure: cloudProjectFailure,
    now: (): Date => new Date(),
    randomKey: randomUUID,
    warn: logMainProcessWarn,
  });
  return engine;
}

export function findCloudProjectLink(
  workspaceId: string,
): Promise<CloudProjectLinkOptions> {
  return getEngine().findLink(workspaceId);
}

export function linkCloudProject(
  request: CloudProjectLinkRequest,
): Promise<CloudProjectLinkResult> {
  return getEngine().link(request);
}

let timer: ReturnType<typeof setInterval> | null = null;
let startup: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;
let running: Promise<void> | null = null;

function reconcileAll(): Promise<void> {
  running ??= getEngine()
    .reconcileAll()
    .catch((): void => {})
    .finally((): void => {
      running = null;
    });
  return running;
}

export function startCloudProjectBinding(): void {
  if (timer) return;
  unsubscribe = subscribeCanopyCloudAccountChanges((): void => {
    trackDetachedWork(reconcileAll);
  });
  timer = setInterval(
    detachedWorkCallback(reconcileAll),
    RECONCILE_INTERVAL_MS,
  );
  timer.unref();
  startup = setTimeout(detachedWorkCallback(reconcileAll), STARTUP_DELAY_MS);
  startup.unref();
}

export function stopCloudProjectBinding(): void {
  if (timer) clearInterval(timer);
  if (startup) clearTimeout(startup);
  timer = null;
  startup = null;
  unsubscribe?.();
  unsubscribe = null;
}
