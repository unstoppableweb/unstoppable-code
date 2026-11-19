// Workflow status reasons feed the on-quota AI Credits latch (CAN-7256).
//
// A workflow model step that hits a native Claude/Codex usage limit pauses
// with a `provider_usage_limit` status reason, but nothing on that path set the
// account-wide quota latch that `on-quota` routing reads. Resume run then went
// back to the still-limited subscription and paused again. This module replays
// those reasons into `markProviderQuotaReached`, from the execution-event
// broadcaster (live runs, main- or daemon-hosted) and from the resume service
// (a Resume after an app restart cleared the in-memory latch).
//
// A wrong latch spends AI Credits, so every unclear case fails closed.

import type { PipelineStatusReason } from '@canopy/execution-engine/types/pipeline';
import type { NativeAccountProvider } from '@canopy/desktop-shared/types';
import { markProviderQuotaReached } from '../agents/ai-credits-quota-state';
import {
  getNativeAccountChangedAt,
  getNativeSubscriptionRestoredAt,
} from '../agents/native-account-change';

function nativeProvider(
  provider: PipelineStatusReason['provider'],
): NativeAccountProvider | null {
  if (provider === 'claude') return 'claude';
  if (provider === 'codex') return 'codex';
  return null;
}

function isAfterWatermark(
  detectedAt: number,
  watermark: number | undefined,
): boolean {
  return watermark === undefined || detectedAt > watermark;
}

/**
 * Set the native quota latch from a run's native usage-limit status reasons.
 *
 * Latches only a `provider_usage_limit` reason for a native Claude/Codex
 * account (never a pooled account-proxy connection, and never a reason stored
 * without `account_scope`), detected after the provider's last account change
 * and last successful allowance read, with a reset time still in the future.
 * A bare `http_429` with no reset time is not evidence of a plan limit.
 *
 * No I/O or IPC, and never throws: it runs ahead of the renderer publish.
 */
export function latchNativeQuotaFromPipelineReasons(
  reasons: readonly PipelineStatusReason[] | undefined,
  now: number = Date.now(),
): void {
  if (!reasons || reasons.length === 0) return;
  for (const reason of reasons) {
    if (reason.kind !== 'provider_usage_limit') continue;
    if (reason.account_scope !== 'native') continue;
    if (reason.account_proxy_connection_id !== undefined) continue;
    const provider = nativeProvider(reason.provider);
    if (provider === null) continue;
    if (reason.code === 'http_429' && reason.resets_at === undefined) continue;
    const detectedAt = Date.parse(reason.detected_at);
    if (!Number.isFinite(detectedAt)) continue;
    if (
      !isAfterWatermark(detectedAt, getNativeAccountChangedAt(provider)) ||
      !isAfterWatermark(detectedAt, getNativeSubscriptionRestoredAt(provider))
    ) {
      continue;
    }
    let resetsAt: number | undefined;
    if (reason.resets_at !== undefined) {
      resetsAt = Date.parse(reason.resets_at);
      if (!Number.isFinite(resetsAt) || resetsAt <= now) continue;
    }
    markProviderQuotaReached(provider, resetsAt, detectedAt);
  }
}

/**
 * Resume-service entry: replay the stored reasons a Resume answers. An empty
 * or absent `statusReasonIds` means the Resume answers every reason.
 */
export function latchNativeQuotaFromResumedReasons(
  reasons: readonly PipelineStatusReason[] | undefined,
  statusReasonIds: readonly string[] | undefined,
  now: number = Date.now(),
): void {
  if (!reasons || reasons.length === 0) return;
  if (!statusReasonIds || statusReasonIds.length === 0) {
    latchNativeQuotaFromPipelineReasons(reasons, now);
    return;
  }
  const ids = new Set(statusReasonIds);
  latchNativeQuotaFromPipelineReasons(
    reasons.filter((reason) => ids.has(reason.id)),
    now,
  );
}
