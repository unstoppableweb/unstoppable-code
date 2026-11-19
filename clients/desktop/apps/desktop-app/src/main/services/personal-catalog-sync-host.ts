import { z } from 'zod';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { writeFileAtomically } from '../lib/atomic-file';
import { broadcastPreferencesSynced } from '../lib/preferences-broadcast';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import {
  getCanopyCloudCredentials,
  subscribeCanopyCloudAccountChanges,
} from '../lib/canopy-cloud-account-store';
import {
  projectPreferencesForRuntime,
  readPreferencesFile,
  readPreferencesFileDetailed,
  updatePreferencesFile,
} from '../lib/preferences-store';
import { getDataDir } from '../lib/paths';
import { readAllSidebarItems } from '../lib/sidebar-items';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceConfig,
} from '../lib/workspace-persistence';
import { recordPersonalCatalogId } from '../lib/workspace-ownership';
import {
  readInstallationGeneration,
  bumpInstallationGeneration,
} from '../lib/installation-generation';
import { getInstallId } from '../lib/install-identity';
import { getRemoteUrlStrict } from '../lib/git';
import { requestCanopyCloudJson } from '../canopy-cloud/client';
import {
  PersonalCatalogSyncService,
  markPersonalCatalogRestore,
} from './personal-catalog-sync-service';
import {
  buildPersonalCatalogPayload,
  type PersonalCatalogPayload,
} from './personal-catalog-payload';
import {
  detachedWorkCallback,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';

const ROUTE = '/projects/personal/registrations';
let service: PersonalCatalogSyncService | null = null;
let owner: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;
let running: Promise<void> | null = null;
let refreshPending = false;
let epoch = 0;
let preferenceChanges: Promise<void> = Promise.resolve();
function enabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
  );
}
function outboxFile(accountId: string): string {
  return join(
    root(),
    `${createHash('sha256').update(accountId).digest('hex')}.json`,
  );
}
function root(): string {
  return join(getDataDir(), 'personal-catalog-outbox');
}

async function readCatalogGeneration(
  credentials: Awaited<ReturnType<typeof getCanopyCloudCredentials>>,
  signal?: AbortSignal,
): Promise<{
  catalogGeneration: number;
  revisions: Record<string, number>;
  minimumInstallationGeneration?: number;
}> {
  const response = await requestCanopyCloudJson<unknown>(ROUTE, {
    signal,
    credentialContext: credentials,
  });
  return z
    .object({
      catalogGeneration: z.number().int().nonnegative(),
      minimumInstallationGeneration: z.number().int().nonnegative().optional(),
      revisions: z.record(z.string().uuid(), z.number().int().nonnegative()),
    })
    .parse(response);
}
/** Accountless only when enrollment began signed out; otherwise bound to the enrolling account. */
const pendingRestoreSchema = z
  .object({
    version: z.literal(1),
    pending: z.literal(true),
    accountId: z.string().min(1).optional(),
  })
  .strict();
function pendingRestoreFile(): string {
  return join(root(), 'restore-pending.json');
}
async function bindPendingRestore(
  credentials: Awaited<ReturnType<typeof getCanopyCloudCredentials>>,
  token: number,
): Promise<void> {
  if (token !== epoch) return;
  const accountId = credentials.account?.id;
  if (!accountId || !credentials.capabilities.includes('org-projects-v1'))
    return;
  let marker: z.infer<typeof pendingRestoreSchema> | null = null;
  try {
    const parsed = pendingRestoreSchema.safeParse(
      JSON.parse(await readFile(pendingRestoreFile(), 'utf8')),
    );
    if (parsed.success) marker = parsed.data;
  } catch {
    return;
  }
  if (!marker || token !== epoch) return;
  if (marker.accountId !== undefined && marker.accountId !== accountId) {
    // Another account's enrollment intent never authorizes restoring this one.
    await rm(pendingRestoreFile(), { force: true });
    return;
  }
  try {
    const generation = await readCatalogGeneration(credentials);
    if (token !== epoch) return;
    await markPersonalCatalogRestore(
      outboxFile(accountId),
      accountId,
      generation.catalogGeneration,
    );
  } finally {
    if (token === epoch) await rm(pendingRestoreFile(), { force: true });
  }
}

async function sync(): Promise<void> {
  const token = epoch;
  const detail = await readPreferencesFileDetailed();
  if (token !== epoch || detail.authority === 'unreadable') return;
  if (detail.preferences.personalWorkspaceCatalogSync !== 'private') {
    service?.dispose();
    service = null;
    owner = null;
    await rm(root(), { recursive: true, force: true });
    return;
  }
  if (!enabled()) {
    service?.dispose();
    service = null;
    owner = null;
    return;
  }
  const credentials = await getCanopyCloudCredentials();
  const accountId = credentials.account?.id;
  if (!accountId || !credentials.capabilities.includes('org-projects-v1'))
    return;
  if (token !== epoch) return;
  await bindPendingRestore(credentials, token);
  if (token !== epoch) return;
  if (owner !== accountId) {
    service?.dispose();
    service = null;
    owner = accountId;
  }
  if (!service) {
    service = new PersonalCatalogSyncService({
      file: outboxFile(accountId),
      accountId,
      allowed: async (): Promise<boolean> =>
        token === epoch &&
        owner === accountId &&
        enabled() &&
        (await readPreferencesFile()).personalWorkspaceCatalogSync ===
          'private' &&
        (await getCanopyCloudCredentials()).account?.id === accountId,
      send: (body, signal): Promise<unknown> =>
        requestCanopyCloudJson(ROUTE, {
          method: 'PUT',
          body: JSON.stringify(body),
          signal,
          credentialContext: credentials,
        }),
      generation: (signal): ReturnType<typeof readCatalogGeneration> =>
        readCatalogGeneration(credentials, signal),
      bumpInstallation: bumpInstallationGeneration,
      notice: (message): void => {
        trackDetachedWork(() =>
          updatePreferencesFile(() => ({
            personalCatalogNotice: message,
          }))
            .then((next): void => {
              broadcastPreferencesSynced(next, projectPreferencesForRuntime);
            })
            .catch((): void => {}),
        );
      },
    });
  }
  const current = service;
  const deviceId = await getInstallId();
  const installationGeneration = await readInstallationGeneration(deviceId);
  const { items } = await readAllSidebarItems();
  const payloads: PersonalCatalogPayload[] = [];
  const enrollmentActive = async (): Promise<boolean> => {
    if (token !== epoch || !enabled()) return false;
    const preferences = await readPreferencesFile();
    return (
      token === epoch &&
      enabled() &&
      preferences.personalWorkspaceCatalogSync === 'private'
    );
  };
  let eligibleWorkspaces = 0;
  for (const item of items) {
    if (eligibleWorkspaces >= 1000) break;
    if (token !== epoch) return;
    const detail = await readWorkspaceConfigDetailed(item.id);
    if (
      detail.authority !== 'ok' ||
      detail.ownerMalformed ||
      detail.config.owner ||
      detail.config.temporary ||
      [
        'app-advisor',
        'standalone-chat',
        'plan-explore-chat',
        'code-review-chat',
        'pipeline-editor',
      ].includes(item.id)
    )
      continue;
    eligibleWorkspaces += 1;
    let config = detail.config;
    if (!config.personalCatalogId) {
      if (!(await enrollmentActive())) return;
      if (
        !(await recordPersonalCatalogId({
          workspaceId: item.id,
          source: 'personal_catalog_sync',
          allowed: enrollmentActive,
        }))
      ) {
        if (!(await enrollmentActive())) return;
        continue;
      }
      config = await readWorkspaceConfig(item.id);
    }
    if (!config.personalCatalogId) continue;
    const paths =
      config.type === 'cowork'
        ? []
        : config.type === 'single-repo'
          ? [config.repoPath]
          : config.repos.map((repo) => repo.repoPath);
    const remotes: string[] = [];
    for (const path of paths) {
      if (path) {
        const remote = await getRemoteUrlStrict(path).catch(() => null);
        if (remote) remotes.push(remote);
      }
    }
    const payload = buildPersonalCatalogPayload({
      personalCatalogId: config.personalCatalogId,
      name: item.name,
      type: config.type,
      remotes,
      deviceId,
      installationGeneration,
      localWorkspaceId: item.id,
    });
    if (payload) payloads.push(payload);
  }
  if (token !== epoch) return;
  await current.enqueue(payloads);
  await current.flush();
}
/** Resolves once this sync and any refresh requested while it ran settle. */
export function refreshPersonalCatalogSync(): Promise<void> {
  if (running) {
    refreshPending = true;
    return running;
  }
  refreshPending = false;
  const run = sync()
    .catch((): void => {})
    .then((): Promise<void> | undefined => {
      running = null;
      return refreshPending ? refreshPersonalCatalogSync() : undefined;
    });
  running = run;
  return run;
}
export async function personalCatalogPreferenceChanged(): Promise<void> {
  const token = ++epoch;
  const old = service;
  service = null;
  owner = null;
  old?.dispose();
  // Serialize local mutations only: a later toggle fences this work immediately
  // and never waits for the preceding toggle's remote generation request.
  const local = preferenceChanges.then(async (): Promise<void> => {
    if (token !== epoch) return;
    await old?.disable();
    if (token !== epoch) return;
    await rm(root(), { recursive: true, force: true });
    if (token !== epoch || !enabled()) return;
    const preferences = await readPreferencesFile();
    if (
      token !== epoch ||
      !enabled() ||
      preferences.personalWorkspaceCatalogSync !== 'private'
    )
      return;
    const enrollingAccountId = (await getCanopyCloudCredentials()).account?.id;
    if (token !== epoch) return;
    await mkdir(root(), { recursive: true });
    if (token !== epoch) return;
    await writeFileAtomically(
      pendingRestoreFile(),
      JSON.stringify(
        pendingRestoreSchema.parse({
          version: 1,
          pending: true,
          ...(enrollingAccountId ? { accountId: enrollingAccountId } : {}),
        }),
      ),
      { mode: 0o600 },
    );
  });
  preferenceChanges = local.catch((): void => {});
  await local;
  if (token !== epoch) return;
  if (
    enabled() &&
    (await readPreferencesFile()).personalWorkspaceCatalogSync === 'private'
  ) {
    if (token !== epoch) return;
    await bindPendingRestore(await getCanopyCloudCredentials(), token);
  }
  if (token === epoch) trackDetachedWork(refreshPersonalCatalogSync);
}
export function startPersonalCatalogSync(): void {
  if (timer) return;
  unsubscribe = subscribeCanopyCloudAccountChanges((): void => {
    epoch += 1;
    service?.dispose();
    service = null;
    owner = null;
    trackDetachedWork(refreshPersonalCatalogSync);
  });
  timer = setInterval(detachedWorkCallback(refreshPersonalCatalogSync), 60_000);
  timer.unref();
  trackDetachedWork(refreshPersonalCatalogSync);
}
export function stopPersonalCatalogSync(): void {
  refreshPending = false;
  epoch += 1;
  service?.dispose();
  service = null;
  if (timer) clearInterval(timer);
  timer = null;
  unsubscribe?.();
  unsubscribe = null;
}

export const personalCatalogSyncHostTestExports: {
  sync: () => Promise<void>;
} = { sync };
