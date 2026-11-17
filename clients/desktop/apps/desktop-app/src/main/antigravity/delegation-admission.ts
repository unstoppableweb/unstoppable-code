import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { getRawAntigravityModelId } from '@canopy/execution-engine/lib/antigravity-models';
import { isAntigravityHarnessEnabled } from './feature-flag';

export type AntigravityChildAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: string };

/**
 * Native Antigravity 1.5.1 discovers repository and profile customizations
 * from its working directory even with a private profile and default
 * customizations disabled (CAP-02). Repository hooks and MCP configuration
 * can run without a host approval. A child must not receive or run anything
 * it was not explicitly given, so children stay unavailable until a qualified
 * native discovery boundary and hostile-repository child tests exist. The
 * isolation lane owns that boundary; change this predicate only with its
 * qualification evidence.
 */
export const ANTIGRAVITY_CHILD_ISOLATION_UNQUALIFIED =
  'Antigravity delegates are unavailable until workspace skill discovery can be isolated for them. Choose another model.';

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
 * Whether native workspace discovery and built-in subagents are bounded. The
 * isolation lane owns this body and changes it only with hostile-repository
 * qualification evidence.
 */
export function antigravityNativeDiscoveryIsolation(): AntigravityNativeDiscoveryIsolation {
  return {
    qualified: false,
    reason:
      'Antigravity 1.5.1 loads repository rules, skills and workflows with no native off switch, and built-in subagent tools skip host approval (CAN-6714, CAN-6715).',
  };
}

export const ANTIGRAVITY_CHILD_PREREQUISITES_PENDING =
  'Antigravity delegates are unavailable until their remaining safety checks are qualified. Choose another model.';

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
  if (!antigravityNativeDiscoveryIsolation().qualified)
    return { admitted: false, reason: ANTIGRAVITY_CHILD_ISOLATION_UNQUALIFIED };
  // Isolation is necessary, not sufficient: the child write denial for
  // executable workspace configuration, the integrity gate and a hostile
  // child probe must also land (see the child runner notes).
  return { admitted: false, reason: ANTIGRAVITY_CHILD_PREREQUISITES_PENDING };
}
