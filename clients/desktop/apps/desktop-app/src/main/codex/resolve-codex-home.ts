import { homedir } from 'node:os';
import { join } from 'node:path';
import { getObservedCanonicalCodexHome } from '@canopy/execution-engine/node/codex-runtime';
import { getCodexRuntimeService } from './runtime-service';

/**
 * Resolve the Codex state directory WITHOUT starting an app-server.
 *
 * `getCodexRuntimeService().getCanonicalState()` initializes the shared runtime
 * when no canonical state has been observed, which spawns a Codex app-server
 * and installs a permanent profile anchor. Callers that run on background or
 * startup paths must never do that, so this prefers the already-observed
 * canonical value and otherwise mirrors the auth-state fallback: `CODEX_HOME`,
 * then `HOME/.codex`, then the platform home directory.
 *
 * The fallback is deliberate rather than returning `null` on a cold process:
 * a caller that only reads or reclaims files still needs to do its job during
 * the (common) window before any app-server has started.
 */
export async function resolveCodexHomeWithoutSpawn(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  if (getObservedCanonicalCodexHome() !== null) {
    try {
      return (await getCodexRuntimeService().getCanonicalState()).codexHome;
    } catch {
      // A shutting-down runtime is equivalent to no available runtime here.
    }
  }
  return env.CODEX_HOME?.trim() || join(env.HOME ?? homedir(), '.codex');
}
