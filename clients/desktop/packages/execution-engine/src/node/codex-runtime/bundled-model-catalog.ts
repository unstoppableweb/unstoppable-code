import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getBundledCodexBinaryPath,
  getEnhancedEnv,
} from '@canopy/execution-engine/pipelines/config-paths';

const execFileAsync = promisify(execFile);
const CATALOG_TIMEOUT_MS = 10_000;
const CATALOG_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

async function loadCodexModelCatalog(
  args: readonly string[],
  signal: AbortSignal,
): Promise<unknown> {
  const { stdout } = await execFileAsync(
    getBundledCodexBinaryPath(),
    ['debug', 'models', ...args],
    {
      encoding: 'utf8',
      // The same environment as the app-server, so the same Codex home.
      env: getEnhancedEnv({
        includeCanopySecrets: false,
        environment: false,
      }),
      timeout: CATALOG_TIMEOUT_MS,
      maxBuffer: CATALOG_MAX_BUFFER_BYTES,
      signal,
    },
  );
  const parsed: unknown = JSON.parse(stdout);
  return parsed;
}

/**
 * Read the pinned binary's bundled model catalog under runtime-service
 * lifecycle ownership. Callers receive parsed data and validate the shape they
 * need without gaining access to a raw Codex subprocess.
 */
export function loadBundledCodexModelCatalog(
  signal: AbortSignal,
): Promise<unknown> {
  return loadCodexModelCatalog(['--bundled'], signal);
}

/**
 * Read the catalog Codex uses for this sign-in: the account's cached remote
 * catalog (refreshed by Codex when stale), else the bundled one. It is the
 * only catalog source with each model's context window bounds; `model/list`
 * omits them.
 */
export function loadAccountCodexModelCatalog(
  signal: AbortSignal,
): Promise<unknown> {
  return loadCodexModelCatalog([], signal);
}
