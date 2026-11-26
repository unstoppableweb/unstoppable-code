import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { getRawAntigravityModelId } from '@canopy/execution-engine/lib/antigravity-models';
import { isAntigravityHarnessEnabled } from './feature-flag';

export type AntigravityChildAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: string };

export const ANTIGRAVITY_DELEGATE_MODEL_REQUIRED =
  'Choose a Google subscription model.';

/**
 * The raw model a Google delegate may run: Google subscription (gemini-)
 * models only. Discovery, route capture and the runner share this rule.
 */
export function antigravityDelegateRawModel(
  runtimeModelId: string,
): string | undefined {
  const raw = getRawAntigravityModelId(runtimeModelId);
  return raw?.startsWith('gemini-') ? raw : undefined;
}

export type AntigravityNativeDiscoveryIsolation =
  | { readonly qualified: true }
  | { readonly qualified: false; readonly reason: string };

/**
 * Whether native workspace discovery and built-in subagents are bounded.
 * Every Antigravity session launches as a Canopy-defined custom agent that
 * inherits nothing from the repository and exposes only host-gated tools. The
 * qualification evidence is
 * docs/planning/2026-11-12-antigravity-parity/evidence/isolation-1.5.14.json
 * (written by scripts/antigravity/qualify-isolation.mjs): a child launched as
 * the delegate runner launches it sees no repository markers and reports the
 * bounded tool surface. Change this only with new qualification evidence.
 */
export function antigravityNativeDiscoveryIsolation(): AntigravityNativeDiscoveryIsolation {
  return { qualified: true };
}

/** Fail-closed admission for Antigravity as a managed child. */
export function antigravityChildAdmission(): AntigravityChildAdmission {
  if (!isAntigravityHarnessEnabled())
    return {
      admitted: false,
      reason: 'Antigravity is unavailable. Choose another model.',
    };
  if (hostOperatingSystem() !== 'darwin')
    return {
      admitted: false,
      reason:
        "Antigravity delegates aren't available on this platform yet. Choose another model.",
    };
  const isolation = antigravityNativeDiscoveryIsolation();
  if (!isolation.qualified)
    return { admitted: false, reason: isolation.reason };
  return { admitted: true };
}
