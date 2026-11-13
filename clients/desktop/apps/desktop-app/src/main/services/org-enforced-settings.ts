// ---------------------------------------------------------------------------
// Org-enforced settings applier.
//
// Generic registry keyed by policy kind. Each org-enforced policy contributes
// one applier that, given the current cloud-account state, reconciles local
// machine state to satisfy the enforcement and reports whether it changed
// anything. Adding a future enforced-policy kind means adding one applier here
// (plus its protocol union member, server mapper, and lock UI) — the transport,
// invite, and re-probe plumbing stays untouched.
//
// Telemetry policy is runtime state keyed by organization. It is never written
// into the member's saved preferences; the one-time migration below only
// removes values pinned by older versions.
// ---------------------------------------------------------------------------

import { BrowserWindow } from 'electron';
import type { OrgEnforcedPolicyKind } from '@canopy/protocol/canopy-server';
import {
  IPC_CHANNELS,
  type CanopyCloudAccountPublicState,
} from '@canopy/desktop-shared/types';
import {
  resolveTelemetryEnforcementByOrganization,
  resolveUsageDataProhibitionByOrganization,
} from '@canopy/desktop-shared/lib/telemetry-enforcement';
import { sendToWindow } from '../lib/window-send';
import { getTelemetrySyncService } from './telemetry-sync-service';
import { migrateOrgPinnedTelemetrySharing } from '../lib/telemetry-pin-migration';
import { setCurrentModelPolicyAccount } from '../lib/model-policy-state';
import { setCurrentModelGatewayAccount } from '../lib/model-gateway-state';
import { broadcastModelRegistryUpdated } from '../models/model-registry';
import { getUsageDataPolicy } from '../lib/usage-data-policy';

interface OrgEnforcedPolicyApplier {
  kind: OrgEnforcedPolicyKind;
  /** Reconcile local state to the enforcement. Returns true if it changed anything. */
  apply(account: CanopyCloudAccountPublicState | null): Promise<boolean>;
}

const telemetrySyncApplier: OrgEnforcedPolicyApplier = {
  kind: 'telemetry-sync',
  async apply(account): Promise<boolean> {
    const changed =
      getTelemetrySyncService().setTelemetryEnforcementByOrganization(
        resolveTelemetryEnforcementByOrganization(account),
      );
    try {
      const migrated = await migrateOrgPinnedTelemetrySharing(account);
      return migrated || changed;
    } catch (error) {
      // Migration cleanup must never prevent current policy from taking effect.
      // eslint-disable-next-line no-console
      console.warn(
        '[org-enforced-settings] telemetry pin migration failed:',
        error,
      );
      return changed;
    }
  },
};

const modelPolicyApplier: OrgEnforcedPolicyApplier = {
  kind: 'model-policy',
  apply(account): Promise<boolean> {
    return Promise.resolve(setCurrentModelPolicyAccount(account));
  },
};

const modelGatewayApplier: OrgEnforcedPolicyApplier = {
  kind: 'model-gateway',
  async apply(account): Promise<boolean> {
    const result = setCurrentModelGatewayAccount(account);
    if (result.changed || result.catalogChanged)
      broadcastModelRegistryUpdated();
    if (result.changed) {
      // The org's models are merged into MAIN's model registry only. The
      // `preferencesChanged` broadcast below makes the renderer re-read the
      // model POLICY and re-apply its LAST snapshot — it never re-fetches the
      // registry — so without this push the org's rows (and the
      // `origin: 'org-gateway'` routes the picker groups and the composer
      // banner key on) never reach the renderer in a running session.
      // A provider process captures its endpoint and Claude bearer token when
      // the session is created. Retire sessions created under the old policy;
      // preserve in-flight work, but force recreation at the next turn.
      const { invalidateSessionsForOrganizations } =
        await import('../agents/session-manager');
      await invalidateSessionsForOrganizations(
        result.changedOrganizationIds === 'all'
          ? 'all-org-owned'
          : result.changedOrganizationIds,
        'model-gateway-policy-changed',
        {
          activeTurnPolicy: 'preserve',
          personalOrganizationIds: result.personalOrganizationIds,
        },
      );
    }
    return result.changed;
  },
};

// Runtime state only: an organization's usage-data prohibitions narrow the
// effective policy for its context and never rewrite the member's preference.
// Every successful probe replaces a fail-closed `'unreadable'` state, and a
// signed-out account resolves to an empty map. A probe whose policy snapshot
// is unavailable is not a successful check: it fails closed, as startup does
// (`loadStoredUsageDataProhibitionByOrganization`).
const usageDataApplier: OrgEnforcedPolicyApplier = {
  kind: 'usage-data',
  apply(account): Promise<boolean> {
    return Promise.resolve(
      getUsageDataPolicy().setProhibitionsByOrganization(
        account?.telemetryEnforcementUnavailable === true
          ? 'unreadable'
          : resolveUsageDataProhibitionByOrganization(account),
      ),
    );
  },
};

const APPLIERS: readonly OrgEnforcedPolicyApplier[] = [
  telemetrySyncApplier,
  modelPolicyApplier,
  modelGatewayApplier,
  usageDataApplier,
];

/**
 * Run every registered applier against the current account. If any reported a
 * change, broadcast `preferencesChanged` so open Settings re-render the locked
 * and forced values. Returns true if anything changed.
 */
export async function applyEnforcedSettings(
  account: CanopyCloudAccountPublicState | null,
): Promise<boolean> {
  let anyChanged = false;
  for (const applier of APPLIERS) {
    try {
      const changed = await applier.apply(account);
      anyChanged = anyChanged || changed;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[org-enforced-settings] applier "${applier.kind}" failed:`,
        error,
      );
    }
  }

  if (anyChanged) {
    for (const window of BrowserWindow.getAllWindows()) {
      sendToWindow(window, IPC_CHANNELS.preferencesChanged);
    }
  }
  return anyChanged;
}

/**
 * Periodic re-probe cadence for refreshing org-enforced settings.
 *
 * This sets the **enforcement propagation window**: a model an admin blocks in
 * org settings can stay usable on an already-running desktop client for up to
 * this long, since `isModelBlockedByStoredPolicy` reads the cloud-account cache
 * that this loop refreshes. That is a deliberate trade (a tighter loop means a
 * network round trip per member per interval), but for a control framed as a
 * compliance boundary the window is a stated guarantee rather than an
 * implementation detail — keep it documented alongside the feature's residual
 * risks, and treat shortening it as a product decision rather than a tuning knob.
 *
 * Server-side enforcement (the AI-Credits gateway proxy) has no such lag: it
 * re-reads the policy per request, so the window only applies to members on
 * personal provider auth.
 */
const REPROBE_INTERVAL_MS = 20 * 60_000;

let reprobeTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic org-enforced-settings sync: applies once immediately
 * (re-enforcing even if prefs were edited offline) then re-probes on an unref'd
 * interval. The injected `reprobe` callback self-gates to a signed-in account,
 * so the loop safely no-ops when signed out — no connect/disconnect plumbing
 * needed. Idempotent: a second call does not stack timers.
 */
export function startOrgEnforcedSettingsSync(
  reprobe: () => Promise<void>,
): void {
  const run = (): void => {
    void reprobe().catch((error: unknown): void => {
      // eslint-disable-next-line no-console
      console.warn('[org-enforced-settings] re-probe failed:', error);
    });
  };

  // Guard before the immediate run so a repeat call is a true no-op: it neither
  // stacks timers nor fires an extra probe.
  if (reprobeTimer) {
    return;
  }

  run();

  reprobeTimer = setInterval(run, REPROBE_INTERVAL_MS);
  reprobeTimer.unref?.();
}

/** Stop the periodic sync. Called from app shutdown. */
export function stopOrgEnforcedSettingsSync(): void {
  if (reprobeTimer) {
    clearInterval(reprobeTimer);
    reprobeTimer = null;
  }
}
