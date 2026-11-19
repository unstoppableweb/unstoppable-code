import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isOrgTeamsLapsed } from '@canopy/desktop-shared/lib/org-billing-state-parsing';
import type { LedgerContainer } from '@canopy/protocol/canopy-core';
import { LEDGER_GLOBAL_CAPABILITY } from '@canopy/protocol/canopy-server';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  LedgerWriterSessionSchema,
  type LedgerWriterSession,
} from '@canopy/protocol/ledger-sync';
import {
  assertCanopyCloudCapability,
  resolveCanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import { getFeatureFlagService } from '../feature-flags';
import { isE2eBuild } from '../lib/e2e-gate';
import {
  readCanopyCloudAccountWithStatus,
  subscribeCanopyCloudAccountChanges,
  type CanopyCloudAccountEntry,
} from '../lib/canopy-cloud-account-store';
import { readInstallationGeneration } from '../lib/installation-generation';
import {
  getLedgerDatabasePath,
  getLedgerGuestRebindIntentsPath,
} from '../lib/paths';
import {
  readWorkspaceOwnership,
  type WorkspaceOwnershipRead,
} from '../lib/workspace-persistence';
import { getObservabilityService } from '../observability';
import type { AppDiagnosticRecord } from '../observability/service';
import { getInstallId } from '../lib/install-identity';
import {
  getTelemetrySyncService,
  type TelemetrySummariesSharing,
} from '../services/telemetry-sync-service';
import { notifyLedgerSyncChanged, onLedgerEntryChanged } from './change-events';
import {
  createLedgerGuestRebindJournal,
  createLedgerGuestRebinder,
  type LedgerGuestRebinder,
} from './guest-rebind-intents';
import { createLedgerLifecycleIntentFile } from './lifecycle-intents';
import type { LedgerSyncStatusSource } from './service';
import { getLedgerStoreClient } from './storage-client';
import { LedgerStorageHostError } from './storage-host';
import { createLedgerMirrorClient } from './sync-client';
import {
  ledgerSyncPolicyKey,
  type LedgerSyncAccount,
  type LedgerWorkspaceOwner,
} from './sync-policy';
import {
  LedgerSyncService,
  type LedgerSyncDiagnostic,
  type LedgerSyncTiming,
} from './sync-service';

/*
 * The desktop's Ledger sync (phase 13): the sync service over the storage
 * worker and the mirror, fed by the signed-in account, effective `summaries`
 * sharing (the telemetry service's resolution, LD02), workspace ownership and
 * this launch's writer session (E06). It runs while `canopy-ledger-enabled`
 * is on, and only ever reads the Ledger database once it exists.
 */

/** The same diagnostic reason at most this often, so a stuck state is one line. */
const DIAGNOSTIC_REPEAT_MS = 10 * 60_000;

/**
 * Quick timing for the E2E build's Ledger specs, which ask for it. Every
 * other build, and every other spec, keeps the production timing.
 */
function ledgerSyncTiming(): Partial<LedgerSyncTiming> {
  return isE2eBuild() && process.env.CANOPY_E2E_LEDGER_SYNC_FAST === '1'
    ? {
        startupDelayMs: 500,
        localChangeDelayMs: 200,
        policyChangeDelayMs: 100,
        retryInitialMs: 200,
        retryMaxMs: 1_000,
      }
    : {};
}

/** The signed-in account as sync reads it; null when there is none to sync to. */
export function toLedgerSyncAccount(
  entry: CanopyCloudAccountEntry | null,
  sharing: TelemetrySummariesSharing,
): LedgerSyncAccount | null {
  const id = entry?.account?.id.trim() ?? '';
  if (entry === null || id.length === 0 || entry.apiKey.trim().length === 0) {
    return null;
  }
  const organizationIds = new Set(
    (entry.organizations ?? []).map((organization) => organization.id),
  );
  return {
    id,
    organizationIds,
    lapsedOrganizationIds: new Set(
      Array.from(organizationIds).filter((organizationId) =>
        isOrgTeamsLapsed(entry.orgBillingStates, organizationId),
      ),
    ),
    summaries: sharing.visibility,
    summariesProhibited: sharing.prohibited,
  };
}

/**
 * Only authoritative ownership can distinguish an organization from Personal.
 * The canonical reader reports malformed owner bindings as `unreadable`.
 */
export function toLedgerWorkspaceOwner(
  read: WorkspaceOwnershipRead,
): LedgerWorkspaceOwner {
  if (read.authority !== 'ok') return { kind: 'unknown' };
  const owner = read.owner;
  return owner === undefined
    ? { kind: 'personal' }
    : {
        kind: 'organization',
        organizationId: owner.organizationId,
        projectId: owner.projectId,
      };
}

async function readLedgerSyncAccount(): Promise<LedgerSyncAccount | null> {
  const result = await readCanopyCloudAccountWithStatus();
  if (result.status !== 'ok') return null;
  return toLedgerSyncAccount(
    result.entry,
    getTelemetrySyncService().getSummariesSharing(),
  );
}

export async function readLedgerWorkspaceOwner(
  container: LedgerContainer,
): Promise<LedgerWorkspaceOwner> {
  // App Advisor entries belong to no workspace; a global (workflow) Ledger's
  // owner is its container's, never a workspace's.
  if (container.kind === 'advisor_entry' || container.kind === 'global') {
    return { kind: 'personal' };
  }
  try {
    return toLedgerWorkspaceOwner(
      await readWorkspaceOwnership(container.workspaceId),
    );
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * Whether the mirror advertises `ledger-global-v1`: what the account stored,
 * or the mirror's own answer, which `live` always asks for. Fails closed.
 */
async function ledgerMirrorSupportsGlobalScopes(options: {
  readonly live: boolean;
}): Promise<boolean> {
  try {
    if (options.live) {
      // Without the stored list, the check asks the mirror itself.
      const credentials = await resolveCanopyCloudCredentialContext();
      await assertCanopyCloudCapability(LEDGER_GLOBAL_CAPABILITY, {
        ...credentials,
        capabilities: [],
      });
    } else {
      await assertCanopyCloudCapability(LEDGER_GLOBAL_CAPABILITY);
    }
    return true;
  } catch {
    return false;
  }
}

let launchNonce: string | undefined;
let launchSession: Promise<LedgerWriterSession | null> | undefined;

async function buildWriterSession(): Promise<LedgerWriterSession | null> {
  try {
    const deviceId = await getInstallId();
    launchNonce ??= randomUUID();
    const parsed = LedgerWriterSessionSchema.safeParse({
      deviceId,
      installationGeneration: await readInstallationGeneration(deviceId),
      nonce: launchNonce,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * This launch's writer session (E06): the portal device, the installation's
 * generation and a nonce minted for the launch. Read once; a failed read is
 * tried again next time.
 */
function readLedgerWriterSession(): Promise<LedgerWriterSession | null> {
  launchSession ??= buildWriterSession().then(
    (session): LedgerWriterSession | null => {
      if (session === null) launchSession = undefined;
      return session;
    },
  );
  return launchSession;
}

let databaseFound = false;

/** Whether the Ledger database exists. Sync and the Feed never create it. */
export async function ledgerDatabaseExists(): Promise<boolean> {
  if (databaseFound) return true;
  try {
    databaseFound = (await stat(getLedgerDatabasePath())).isFile();
  } catch {
    return false;
  }
  return databaseFound;
}

function isLedgerFlagEnabled(): boolean {
  try {
    return getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key,
    );
  } catch {
    return false;
  }
}

/**
 * Records sync diagnostics as global `ledger_sync_failed` app diagnostics: a
 * code and a reason code or count, never ledger, entry or container IDs, or
 * entry text. The same reason is recorded at most every 10 minutes.
 */
export function createLedgerSyncDiagnosticRecorder(
  record: (event: AppDiagnosticRecord) => void,
  now: () => number = Date.now,
): (diagnostic: LedgerSyncDiagnostic) => void {
  const recordedAt = new Map<string, number>();
  return (diagnostic): void => {
    const reason = `${diagnostic.code}: ${diagnostic.detail}`;
    const at = now();
    const last = recordedAt.get(reason);
    if (last !== undefined && at - last < DIAGNOSTIC_REPEAT_MS) return;
    recordedAt.set(reason, at);
    record({
      version: 1,
      timestamp: new Date(at).toISOString(),
      kind: 'ledger_sync_failed',
      reason,
    });
  };
}

const recordLedgerSyncDiagnostic = createLedgerSyncDiagnosticRecorder(
  (event): void => {
    getObservabilityService().recordAppDiagnostic(event);
  },
);

let reprobeEnforcedSettings: () => void = (): void => undefined;

/**
 * What the host does when the mirror refuses summaries before this device's
 * policy said so: read the organizations' enforced settings again.
 */
export function setLedgerSyncProhibitionHandler(handler: () => void): void {
  reprobeEnforcedSettings = handler;
}

let service: LedgerSyncService | undefined;

/** The app's Ledger sync service. Creating it reads and sends nothing. */
export function getLedgerSyncService(): LedgerSyncService {
  service ??= new LedgerSyncService({
    store: getLedgerStoreClient,
    mirror: createLedgerMirrorClient(),
    isEnabled: isLedgerFlagEnabled,
    databaseExists: ledgerDatabaseExists,
    readAccount: readLedgerSyncAccount,
    readSession: readLedgerWriterSession,
    readWorkspaceOwner: readLedgerWorkspaceOwner,
    supportsGlobalScopes: ledgerMirrorSupportsGlobalScopes,
    onScopeSyncChanged: (container, ledgerId): void => {
      notifyLedgerSyncChanged({ kind: 'scope', container, ledgerId });
    },
    onProhibited: (): void => {
      reprobeEnforcedSettings();
    },
    recordDiagnostic: recordLedgerSyncDiagnostic,
    timing: ledgerSyncTiming(),
  });
  return service;
}

/** What a scope's revisions show beyond the store's facts, for the core service. */
export const desktopLedgerSyncStatus: LedgerSyncStatusSource = {
  hold: (scope) => getLedgerSyncService().holdFor(scope.accountId),
  audienceChangePending: (scope) =>
    getLedgerSyncService().isAudienceChangePending({
      ledgerId: scope.ledgerId,
      accountId: scope.accountId,
      container: scope.container,
    }),
};

let policyKey: string | undefined;

/**
 * After the account, its organizations or summary sharing may have changed:
 * when what may sync, or where, did change, every scope is looked at again
 * and every view re-reads its sync states.
 */
async function checkLedgerSyncPolicy(): Promise<void> {
  const key = ledgerSyncPolicyKey(
    await readLedgerSyncAccount().catch((): null => null),
  );
  if (key === policyKey) return;
  policyKey = key;
  getLedgerSyncService().requestSync('policy');
  notifyLedgerSyncChanged({ kind: 'all' });
}

let unsubscribers: Array<() => void> = [];
let enabled = false;

function subscribeTriggers(): void {
  if (unsubscribers.length > 0) return;
  unsubscribers = [
    onLedgerEntryChanged((): void => {
      getLedgerSyncService().requestSync('local_change');
    }),
    subscribeCanopyCloudAccountChanges((): void => {
      void checkLedgerSyncPolicy();
    }),
    getTelemetrySyncService().subscribeSummariesSharing((): void => {
      void checkLedgerSyncPolicy();
    }),
  ];
}

/**
 * Follows `canopy-ledger-enabled`: sync starts with a scheduled check when it
 * turns on, and stops, cancelling what is in flight, when it turns off.
 */
export function setLedgerSyncEnabled(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  if (next) {
    subscribeTriggers();
    getLedgerSyncService().start();
    notifyLedgerSyncChanged({ kind: 'all' });
    void getLedgerGuestRebinder().replay();
    return;
  }
  void service?.stop();
}

/**
 * Something other than an entry command added to a scope's outbox, such as an
 * archive or a restore: sync sends it soon, while sync is on.
 */
export function requestLedgerSync(): void {
  if (enabled) getLedgerSyncService().requestSync('local_change');
}

/** Stops sync before the Ledger's storage shuts down. Never rejects. */
export async function stopLedgerSync(): Promise<void> {
  enabled = false;
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  await service?.stop().catch((): undefined => undefined);
}

/**
 * Sends a retiring scope's outbox before its purge, waiting a bounded time
 * (LD10). Never rejects.
 */
export async function drainLedgerScopeBeforePurge(
  ledgerId: string,
): Promise<void> {
  await getLedgerSyncService().drainScope(ledgerId);
}

let guestRebinder: LedgerGuestRebinder | undefined;

function getLedgerGuestRebinder(): LedgerGuestRebinder {
  guestRebinder ??= createLedgerGuestRebinder({
    journal: createLedgerGuestRebindJournal(
      createLedgerLifecycleIntentFile(getLedgerGuestRebindIntentsPath()),
      {
        onJournalFailure: (detail): void => {
          recordLedgerSyncDiagnostic({ code: 'rebind_failed', detail });
        },
      },
    ),
    databaseExists: ledgerDatabaseExists,
    rebind: async ({ fromAccountId, toAccountId }): Promise<void> => {
      await getLedgerSyncService().rebindMergedGuest(
        fromAccountId,
        toAccountId,
      );
      notifyLedgerSyncChanged({ kind: 'accounts_rebound' });
    },
    onRebindError: (error): void => {
      recordLedgerSyncDiagnostic({
        code: 'rebind_failed',
        detail:
          error instanceof LedgerStorageHostError ? error.reason : 'UNEXPECTED',
      });
    },
    onJournalFailure: (detail): void => {
      recordLedgerSyncDiagnostic({ code: 'rebind_failed', detail });
    },
  });
  return guestRebinder;
}

/**
 * The server merged a guest account into the account signed in now: the
 * guest's scopes move to it and resume syncing (LD02). Call only after the
 * server confirmed the merge. Resolves once the rebind is recorded durably,
 * before it is applied, so a quit or an unavailable storage worker leaves it
 * for the next time sync starts. Never rejects.
 */
export function rebindLedgerGuestScopes(
  fromAccountId: string,
  toAccountId: string,
): Promise<void> {
  return getLedgerGuestRebinder().record(fromAccountId, toAccountId);
}
