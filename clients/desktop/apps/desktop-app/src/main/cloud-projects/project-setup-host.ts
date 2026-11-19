import { randomUUID } from 'node:crypto';
import {
  backgroundFailureCode,
  reportBackgroundFailure,
} from '../observability/background-failure-reporter';
import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { RepoFingerprint } from '@canopy/protocol/memory-sync';
import type {
  CloudProjectSetupCatalog,
  CloudProjectSetupOptions,
  CloudProjectSetupProgress,
  CloudProjectSetupRequest,
  CloudProjectSetupResult,
} from '@canopy/desktop-shared/types';
import { trackDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { subscribeCanopyCloudAccountChanges } from '../lib/canopy-cloud-account-store';
import { classifyGitHubAuthFailure } from '../lib/github-push-auth-failure';
import {
  cloneRepoWithProgress,
  getRemoteUrlStrict,
  initLocalRepo,
} from '../lib/git';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getProjectSetupsDir } from '../lib/paths';
import { isErrnoException } from '../lib/type-guards';
import { readPreferencesFile } from '../lib/preferences-store';
import { readWorkspaceIndexStoredDetailed } from '../lib/sidebar-items';
import { recordWorkspaceCloudBinding } from '../lib/workspace-ownership';
import { readWorkspaceConfigDetailed } from '../lib/workspace-persistence';
import {
  findOrCreateSingleRepoWorkspaceForRepo,
  holdAvailableWorkspaceId,
  registerWorkspaceIdentityHolder,
  WorkspaceIdentityInUseError,
  type WorkspaceIdentityHold,
} from '../lib/workspace-service';
import { createWorkspace } from '../lib/workspace-creation';
import { ORG_PROJECT_CLONE_TIMEOUT_MS } from '../lib/org-project-materialization-deps';
import {
  cloudProjectAccount,
  cloudProjectDevice,
  getCloudProjectClient,
  isCloudProjectAccountActive,
  isCloudProjectSharing,
} from './cloud-project-binding-host';
import { cloudProjectFailure } from './cloud-project-transport';
import {
  CloudProjectSetup,
  type ProjectBindingLookup,
  type WorkspaceRegistration,
} from './project-setup';
import {
  createContainedDirectory,
  isContainedDirectory,
} from './setup-containment';
import {
  parseProjectSetupJournal,
  type ProjectSetupJournal,
} from './project-setup-journal';
import type {
  WorkspaceCloudBindingSnapshot,
  WorkspaceOwnershipRecordStatus,
} from '../lib/worktree-record-decisions';

/*
 * Electron main's host for setting a cloud project up on this device
 * (CAN-5192): journals under `<data>/project-setups`, clones through the
 * shared Git helper (hooks off, no checkout filters, the user's own
 * credentials), workspaces through the W5 creation boundary, and the
 * `cloudBinding` writer. The launch sweep resumes or retires interrupted
 * setups and never clones.
 */

const listeners = new Set<(progress: CloudProjectSetupProgress) => void>();

export function subscribeCloudProjectSetupProgress(
  listener: (progress: CloudProjectSetupProgress) => void,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

type AfterSetupHook = (input: {
  workspaceId: string;
  projectId: string;
  accountId: string;
}) => Promise<void>;

/** CAN-5191 replaces this with the project memory pull. */
let afterSetupHook: AfterSetupHook = (): Promise<void> => Promise.resolve();

export function setCloudProjectAfterSetupHook(hook: AfterSetupHook): void {
  afterSetupHook = hook;
}

function isMissing(error: unknown): boolean {
  return (
    isErrnoException(error) &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

/** Whether the path is there; a disk that cannot answer rejects. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function readJournals(): Promise<{
  found: { name: string; value: unknown }[];
  unreadable: string[];
}> {
  const directory = getProjectSetupsDir();
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return { found: [], unreadable: [] };
    throw error;
  }
  const found: { name: string; value: unknown }[] = [];
  const unreadable: string[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    try {
      found.push({
        name,
        value: JSON.parse(await readFile(join(directory, name), 'utf8')),
      });
    } catch {
      // It authorizes nothing, and is kept and reported.
      unreadable.push(name);
    }
  }
  return { found, unreadable };
}

async function writeJournal(journal: ProjectSetupJournal): Promise<void> {
  const directory = getProjectSetupsDir();
  await mkdir(directory, { recursive: true });
  const target = join(directory, `${journal.journalId}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(journal), { mode: 0o600 });
  await rename(temporary, target);
}

function stderrOf(error: unknown): string {
  if (
    error instanceof Error &&
    'stderr' in error &&
    typeof error.stderr === 'string'
  )
    return error.stderr;
  return error instanceof Error ? error.message : '';
}

async function cloneUrl(fingerprint: RepoFingerprint): Promise<string> {
  const [host, ...path] = fingerprint.remoteKey.split('/');
  const repository = path.join('/');
  const e2eBase = __CANOPY_E2E__
    ? process.env.CANOPY_E2E_CLOUD_PROJECT_CLONE_BASE
    : undefined;
  if (e2eBase) return `${e2eBase.replace(/\/$/, '')}/${repository}.git`;
  const protocol = (await readPreferencesFile()).orgProjectCloneProtocol;
  return protocol === 'ssh'
    ? `git@${host}:${repository}.git`
    : `https://${host}/${repository}.git`;
}

/**
 * The workspace index's entries, or null when the index cannot prove which
 * workspaces it has (unreadable, or partly read).
 */
async function indexedWorkspaceIds(): Promise<string[] | null> {
  const index = await readWorkspaceIndexStoredDetailed();
  return index.authority === 'ok' || index.authority === 'absent'
    ? index.entries.map((entry) => entry.id)
    : null;
}

/**
 * `bound` once any manifest holds a live binding to the project. Otherwise
 * `unbound` only when the index and every manifest in it were read (a
 * missing manifest binds nothing), and `indeterminate` when any could not be.
 */
async function boundTo(
  projectId: string,
  accountId: string,
): Promise<ProjectBindingLookup> {
  const ids = await indexedWorkspaceIds();
  let proven = ids !== null;
  for (const id of ids ?? []) {
    const detail = await readWorkspaceConfigDetailed(id).catch(
      (): null => null,
    );
    if (detail === null || detail.authority === 'unreadable') {
      proven = false;
      continue;
    }
    if (detail.authority !== 'ok') continue;
    const binding = detail.config.cloudBinding;
    if (
      binding?.projectId === projectId &&
      binding.accountId === accountId &&
      binding.ownerType === 'user' &&
      typeof binding.detachedAt !== 'string'
    )
      return { status: 'bound', workspaceId: id };
  }
  return { status: proven ? 'unbound' : 'indeterminate' };
}

/**
 * The workspace IDs this device's setup journals hold, for the workspace ID
 * allocator: a setup keeps its reserved ID across launches until its journal
 * goes. A journal that cannot be read names no ID; one that is cannot be
 * listed holds none rather than stopping every project creation.
 */
async function journaledWorkspaceIds(): Promise<string[]> {
  try {
    return (await readJournals()).found.flatMap(({ value }) => {
      const journal = parseProjectSetupJournal(value);
      return journal === null ? [] : [journal.localWorkspaceId];
    });
  } catch (error) {
    logMainProcessWarn(
      '[cloud-project-setup] could not list setup journals for workspace IDs',
      error,
    );
    return [];
  }
}

/**
 * Registration under the reserved ID; an ID another workspace holds is
 * refused. It answers the workspace the registration used, which the
 * single-repository boundary may de-duplicate onto another ID.
 */
async function registerUnder(
  register: () => Promise<{ id: string }>,
): Promise<WorkspaceRegistration> {
  try {
    return { status: 'registered', workspaceId: (await register()).id };
  } catch (error) {
    if (error instanceof WorkspaceIdentityInUseError)
      return { status: 'identity-in-use' };
    throw error;
  }
}

let setup: CloudProjectSetup | null = null;

function getSetup(): CloudProjectSetup {
  if (setup) return setup;
  registerWorkspaceIdentityHolder(journaledWorkspaceIds);
  setup = new CloudProjectSetup({
    client: getCloudProjectClient(),
    account: cloudProjectAccount,
    isActiveAccount: isCloudProjectAccountActive,
    isSharing: isCloudProjectSharing,
    device: cloudProjectDevice,
    journals: {
      list: readJournals,
      write: writeJournal,
      remove: (journalId): Promise<void> =>
        rm(join(getProjectSetupsDir(), `${journalId}.json`), { force: true }),
    },
    fs: {
      exists,
      mkdir: async (path): Promise<void> => {
        await mkdir(join(path, '..'), { recursive: true });
        await mkdir(path);
      },
      rename,
      removeOwned: (path): Promise<void> =>
        rm(path, { recursive: true, force: true }),
      isGitCheckout: async (path): Promise<boolean> => {
        try {
          return (await lstat(join(path, '.git'))).isDirectory();
        } catch (error) {
          if (isMissing(error)) return false;
          throw error;
        }
      },
      excludeNested: async (rootPath): Promise<void> => {
        await mkdir(join(rootPath, '.git', 'info'), { recursive: true });
        await appendFile(
          join(rootPath, '.git', 'info', 'exclude'),
          '\n/repos/\n',
        );
      },
      createInside: createContainedDirectory,
      isInside: isContainedDirectory,
    },
    git: {
      clone: async (url, destination, options): Promise<void> => {
        await cloneRepoWithProgress(url, destination, {
          nonInteractive: true,
          timeoutMs: ORG_PROJECT_CLONE_TIMEOUT_MS,
          onProgress: options.onProgress,
        });
      },
      initRoot: (path, name): Promise<void> => initLocalRepo(path, name),
      remote: getRemoteUrlStrict,
    },
    cloneUrl,
    cloneFailure: (url, error): 'needs-credentials' | 'clone-failed' =>
      classifyGitHubAuthFailure(url, error) === 'github_not_authenticated' ||
      /could not read Username|Authentication failed|Permission denied|Repository not found|403|401/i.test(
        stderrOf(error),
      )
        ? 'needs-credentials'
        : 'clone-failed',
    workspaces: {
      reserveWorkspaceId: (name): Promise<WorkspaceIdentityHold> =>
        holdAvailableWorkspaceId(name.slice(0, 60)),
      boundTo,
      exists: async (workspaceId): Promise<boolean> => {
        const ids = await indexedWorkspaceIds();
        if (ids === null)
          throw new Error('The workspace index could not be read');
        return ids.includes(workspaceId);
      },
      binding: async (
        workspaceId,
      ): Promise<Pick<
        WorkspaceCloudBindingSnapshot,
        'owner' | 'cloudBinding'
      > | null> => {
        const detail = await readWorkspaceConfigDetailed(workspaceId);
        if (detail.authority === 'absent') return null;
        if (detail.authority !== 'ok')
          throw new Error('The workspace manifest could not be read');
        return {
          owner: detail.config.owner,
          cloudBinding: detail.config.cloudBinding,
        };
      },
      createSingle: (input): Promise<WorkspaceRegistration> =>
        registerUnder(async () => {
          const { workspace } = await findOrCreateSingleRepoWorkspaceForRepo(
            input.path,
            input.name,
            { localWorkspaceId: input.localWorkspaceId },
          );
          return workspace;
        }),
      createMulti: (input): Promise<WorkspaceRegistration> =>
        registerUnder(async () => {
          const { workspace } = await createWorkspace({
            source: 'cloud-project-setup',
            idempotencyKey: input.idempotencyKey,
            variant: {
              kind: 'cloud-project-multi-repo',
              path: input.path,
              localWorkspaceId: input.localWorkspaceId,
              name: input.name,
              repositories: input.repositories,
              suppressedRepoIds: input.suppressedRepoIds,
            },
          });
          return workspace;
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
    },
    defaultDestination: async (): Promise<string | null> =>
      (await readPreferencesFile()).orgProjectDefaultDestinationRoot ?? null,
    progress: (event): void => {
      for (const listener of listeners) listener(event);
    },
    afterSetup: (input): Promise<void> => afterSetupHook(input),
    failure: cloudProjectFailure,
    now: (): Date => new Date(),
    randomUUID,
  });
  return setup;
}

export function cloudProjectSetupCatalog(): Promise<CloudProjectSetupCatalog> {
  return getSetup().catalog();
}

export function cloudProjectSetupOptions(
  projectId: string,
): Promise<CloudProjectSetupOptions> {
  return getSetup().options(projectId);
}

export function startCloudProjectSetup(
  request: CloudProjectSetupRequest,
): Promise<CloudProjectSetupResult> {
  return getSetup().start(request);
}

let unsubscribe: (() => void) | null = null;

function sweep(): Promise<void> {
  return getSetup()
    .resumeAll()
    .then(
      ({ unreadable }): void => {
        if (unreadable.length > 0)
          logMainProcessWarn(
            '[cloud-project-setup] kept setup journals it cannot read',
            { journals: unreadable },
          );
      },
      (error: unknown): void => {
        logMainProcessWarn('[cloud-project-setup] setup sweep failed', error);
        reportBackgroundFailure(
          'cloud-project-setup.resume_failed',
          backgroundFailureCode(error),
        );
      },
    );
}

/**
 * The launch sweep, run again when the signed-in account changes so a setup
 * kept while signed out finishes; it never clones and never blocks startup.
 */
export function startCloudProjectSetupSweep(): void {
  if (unsubscribe) return;
  unsubscribe = subscribeCanopyCloudAccountChanges((): void => {
    trackDetachedWork(sweep);
  });
  trackDetachedWork(sweep);
}

export function stopCloudProjectSetupSweep(): void {
  unsubscribe?.();
  unsubscribe = null;
}
