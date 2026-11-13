import { app, BrowserWindow } from 'electron';
import { z } from 'zod';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { normalizeModelGatewayBaseUrl } from '@canopy/protocol/canopy-server';
import {
  personalAiGatewayConfigSchema,
  type PersonalAiGatewayConfig,
} from '@canopy/protocol/model-gateway';
import type { SettingsErrorPayload } from '@canopy/protocol/settings';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import { getFeatureFlagService } from '../feature-flags';
import {
  readCanopyCloudAccountWithStatus,
  subscribeCanopyCloudAccountChanges,
  type CanopyCloudAccountEntry,
} from '../lib/canopy-cloud-account-store';
import type { AccountOrganizationSettingsService } from './account-organization-settings';
import {
  clearLocalModelGateway,
  readLocalModelGateway,
  recordLocalModelGatewayConflictNotice,
  subscribeLocalModelGatewayChanges,
} from '../lib/local-model-gateway-store';
import { adoptLocalModelGatewayCredential } from '../lib/model-gateway-credential-store';
import { sendToAllWindows, sendToWindow } from '../lib/window-send';
import { refreshLocalModelGatewayPolicy } from './org-enforced-settings';

/**
 * The device AI gateway's two background jobs:
 *
 * - Policy sync: re-applies the gateway policy whenever the device gateway
 *   changes, and once at startup, then tells windows to re-read it.
 * - Sign-in migration: once an account names a Personal organization, moves
 *   the device gateway into it when the account has none, or reports once
 *   per device-config revision that the account kept its own.
 */

/** Waits between retries; the last attempt gives up until the next change. */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000];

/** `no_window`: a notice is due but no window can show it yet. */
type ReconcileOutcome = 'done' | 'idle' | 'retry' | 'no_window';

class HostedGatewayError extends Error {
  constructor(readonly payload: SettingsErrorPayload) {
    super(payload.message ?? payload.code);
    this.name = 'HostedGatewayError';
  }
}

/** Failures worth another attempt: the flag, the session or the network. */
function retryable(payload: SettingsErrorPayload): boolean {
  return (
    payload.code === 'not_found' ||
    payload.code === 'offline' ||
    payload.code === 'expired' ||
    payload.code === 'uncertain' ||
    payload.serverCode === 'stale_scope'
  );
}

interface MigrationAccount {
  accountId: string;
  personalOrganizationId: string;
}

function migrationAccount(
  entry: Pick<
    CanopyCloudAccountEntry,
    'account' | 'personalOrganizationId' | 'authMode' | 'credentialSource'
  > | null,
): MigrationAccount | null {
  const accountId = entry?.account?.id.trim();
  const personalOrganizationId = normalizeUuid(entry?.personalOrganizationId);
  if (!entry || isGuestAccount(entry) || !accountId || !personalOrganizationId)
    return null;
  return { accountId, personalOrganizationId };
}

async function currentMigrationAccount(): Promise<MigrationAccount | null> {
  const read = await readCanopyCloudAccountWithStatus();
  return read.status === 'ok' ? migrationAccount(read.entry) : null;
}

/** Loaded lazily, as the agent action does, to keep this module's graph small. */
async function settingsService(): Promise<AccountOrganizationSettingsService> {
  return (
    await import('./account-organization-settings-host')
  ).getAccountOrganizationSettingsService();
}

async function readHostedGateway(
  account: MigrationAccount,
): Promise<PersonalAiGatewayConfig | null> {
  const service = await settingsService();
  const response = await service.read({
    accountId: account.accountId,
    operation: 'account.settings.ai-gateway.read',
    input: {},
  });
  if (!response.ok) throw new HostedGatewayError(response.error);
  return z
    .object({ gateway: personalAiGatewayConfigSchema.nullable() })
    .parse(response.result).gateway;
}

async function writeHostedGateway(
  account: MigrationAccount,
  local: PersonalAiGatewayConfig,
  expectedRevision: string,
): Promise<{ ok: true } | { ok: false; error: SettingsErrorPayload }> {
  const service = await settingsService();
  const response = await service.write({
    accountId: account.accountId,
    operation: 'account.settings.ai-gateway.update',
    input: {
      expectedOrganizationId: account.personalOrganizationId,
      expectedRevision,
      displayName: local.displayName,
      baseUrl: local.baseUrl,
      // Model IDs are kept, so chats that selected one keep it.
      models: local.models,
      enabled: local.enabled,
      onlyThisGateway: local.onlyThisGateway,
      promptCachePassthrough: local.promptCachePassthrough,
    },
  });
  return response.ok ? { ok: true } : { ok: false, error: response.error };
}

function sameAccount(a: MigrationAccount | null, b: MigrationAccount): boolean {
  return (
    a?.accountId === b.accountId &&
    a.personalOrganizationId === b.personalOrganizationId
  );
}

const failureOutcome = (payload: SettingsErrorPayload): ReconcileOutcome =>
  retryable(payload) ? 'retry' : 'done';

function gatewayFlagEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyAiGatewaySettingsEnabled.key,
  );
}

async function readHostedForMigration(
  account: MigrationAccount,
): Promise<
  { hosted: PersonalAiGatewayConfig | null } | { outcome: ReconcileOutcome }
> {
  try {
    return { hosted: await readHostedGateway(account) };
  } catch (error) {
    return {
      outcome:
        error instanceof HostedGatewayError
          ? failureOutcome(error.payload)
          : 'retry',
    };
  }
}

/**
 * The account keeps its own gateway; the device copy stays for signed-out
 * use. Report it once per account and device-config revision, and only when
 * a window can show it; with none open, the pass waits for one.
 */
async function reportConflict(
  account: MigrationAccount,
  local: PersonalAiGatewayConfig,
): Promise<ReconcileOutcome> {
  const window =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!window) return 'no_window';
  // One window shows the notice; every window mounts its listener.
  if (
    await recordLocalModelGatewayConflictNotice(
      account.accountId,
      local.revision,
    )
  )
    sendToWindow(window, IPC_CHANNELS.localModelGatewayMigrationConflict);
  return 'done';
}

/** The config is on the account: move the key, then clear the device copy. */
async function finishMove(
  account: MigrationAccount,
  local: PersonalAiGatewayConfig,
  baseUrl: string,
): Promise<ReconcileOutcome> {
  if (!sameAccount(await currentMigrationAccount(), account)) return 'idle';
  const adopted = await adoptLocalModelGatewayCredential({
    accountId: account.accountId,
    organizationId: account.personalOrganizationId,
    baseUrl,
  });
  if (adopted === 'unauthorized') return 'retry';
  // A device edit since this pass read it stays; the next pass decides it.
  await clearLocalModelGateway(local.revision);
  if (adopted === 'adopted')
    sendToAllWindows(
      IPC_CHANNELS.modelGatewayCredentialChanged,
      account.personalOrganizationId,
    );
  return 'done';
}

const modelIds = (config: PersonalAiGatewayConfig): string =>
  config.models
    .map((model) => model.id)
    .sort()
    .join('\n');

/**
 * Whether the hosted gateway holds the device settings, as an earlier pass of
 * this migration wrote them. The same endpoint alone is not enough: the
 * account may have set up its own gateway there.
 */
function holdsDeviceSettings(
  hosted: PersonalAiGatewayConfig,
  local: PersonalAiGatewayConfig,
): boolean {
  return (
    normalizeModelGatewayBaseUrl(hosted.baseUrl) ===
      normalizeModelGatewayBaseUrl(local.baseUrl) &&
    (hosted.displayName ?? null) === (local.displayName ?? null) &&
    hosted.enabled === local.enabled &&
    hosted.onlyThisGateway === local.onlyThisGateway &&
    hosted.promptCachePassthrough === local.promptCachePassthrough &&
    modelIds(hosted) === modelIds(local)
  );
}

/** One decision against the hosted gateway; `again` after a stale revision. */
async function reconcileOnce(
  account: MigrationAccount,
  local: PersonalAiGatewayConfig,
  baseUrl: string,
): Promise<ReconcileOutcome | 'again'> {
  const read = await readHostedForMigration(account);
  if ('outcome' in read) return read.outcome;
  if (!sameAccount(await currentMigrationAccount(), account)) return 'idle';
  const hosted = read.hosted;
  if (hosted?.baseUrl) {
    return holdsDeviceSettings(hosted, local)
      ? finishMove(account, local, baseUrl)
      : reportConflict(account, local);
  }
  const written = await writeHostedGateway(
    account,
    local,
    hosted?.revision ?? 'absent',
  );
  if (written.ok) return finishMove(account, local, baseUrl);
  // Someone saved a gateway meanwhile: decide again against it.
  return written.error.serverCode === 'stale_revision'
    ? 'again'
    : failureOutcome(written.error);
}

/**
 * One idempotent pass. Safe to repeat after any partial failure: a hosted
 * gateway holding the device settings means the config already moved, so only
 * the key and the device copy remain.
 */
async function reconcileLocalModelGateway(): Promise<ReconcileOutcome> {
  const local = await readLocalModelGateway();
  const baseUrl = local?.baseUrl;
  if (!local || !baseUrl) return 'idle';
  const account = await currentMigrationAccount();
  if (!account) return 'idle';
  // On sign-in flags reset to their unavailable default until LaunchDarkly
  // answers for the new context; wait rather than read it as off.
  if (!gatewayFlagEnabled()) return 'retry';
  const first = await reconcileOnce(account, local, baseUrl);
  if (first !== 'again') return first;
  const second = await reconcileOnce(account, local, baseUrl);
  return second === 'again' ? 'retry' : second;
}

/**
 * Re-apply the gateway policy whenever the device gateway changes, and once
 * now. Windows re-read the device gateway after the catalog updated.
 */
export function startLocalModelGatewayPolicySync(): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  const apply = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    await refreshLocalModelGatewayPolicy();
    sendToAllWindows(IPC_CHANNELS.localModelGatewayChanged);
    // An unreadable device store kept the previous policy; nothing else
    // re-applies it while signed out, so try again with backoff.
    const readable = await readLocalModelGateway().then(
      () => true,
      () => false,
    );
    if (readable || disposed) {
      attempt = 0;
      return;
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return;
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      void apply();
    }, delay);
    timer.unref?.();
  };
  const unsubscribe = subscribeLocalModelGatewayChanges(() => {
    attempt = 0;
    void apply();
  });
  void apply();
  return (): void => {
    disposed = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}

/** Run the sign-in migration on account changes and once at startup. */
export function startLocalModelGatewayMigration(): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let running = false;
  let rerun = false;
  /** Account and device revision a finished pass already settled. */
  let settled: string | null = null;
  /** Stops waiting for a window that can show a pending notice. */
  let stopWindowWait: (() => void) | null = null;

  /** Run again once a window has loaded, without spending retries. */
  const waitForWindow = (): void => {
    if (disposed || stopWindowWait) return;
    const onWindow = (_event: unknown, window: BrowserWindow): void => {
      stopWindowWait?.();
      stopWindowWait = null;
      window.webContents.once('did-finish-load', () => {
        armRun(0);
      });
    };
    app.on('browser-window-created', onWindow);
    stopWindowWait = (): void => {
      app.removeListener('browser-window-created', onWindow);
    };
  };

  const armRun = (delayMs: number): void => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delayMs);
    timer.unref?.();
  };

  const settledKey = async (): Promise<string | null> => {
    const [account, local] = await Promise.all([
      currentMigrationAccount(),
      readLocalModelGateway(),
    ]);
    return account && local?.baseUrl
      ? `${account.accountId}/${account.personalOrganizationId}/${local.revision}`
      : null;
  };

  const run = async (): Promise<void> => {
    if (disposed) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      const key = await settledKey();
      if (key === null || key === settled) return;
      const outcome = await reconcileLocalModelGateway().catch(
        (): ReconcileOutcome => 'retry',
      );
      if (outcome === 'retry') {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay !== undefined) {
          attempt += 1;
          armRun(delay);
        }
        return;
      }
      attempt = 0;
      if (outcome === 'no_window') waitForWindow();
      if (outcome === 'done') settled = key;
    } catch {
      // Best effort: the next account or device change tries again.
    } finally {
      running = false;
      if (rerun) {
        rerun = false;
        void run();
      }
    }
  };

  const restart = (): void => {
    attempt = 0;
    armRun(0);
  };
  const stopAccount = subscribeCanopyCloudAccountChanges(restart);
  const stopLocal = subscribeLocalModelGatewayChanges(restart);
  const stopFlags = getFeatureFlagService().onSnapshotChanged(() => {
    if (attempt > 0) armRun(0);
  });
  armRun(0);

  return (): void => {
    disposed = true;
    if (timer) clearTimeout(timer);
    stopWindowWait?.();
    stopWindowWait = null;
    stopAccount();
    stopLocal();
    stopFlags();
  };
}
